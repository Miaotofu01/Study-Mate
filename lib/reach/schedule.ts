/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 核验域 —— 一次核验的排班（并发、同站礼貌、路由表、墙上预算）

   这个文件只做编排，**不发一个字节**：真正探一个 URL 的那件事由调用方当 `probe` 递进来
   （`transport.ts` 的 `requestOnce` 是生产路径那一份）。于是「并发上限、同站串行、路由只在
   第一次连接层失败时换一次、预算到点就不许再起新的」这四件事可以在假 probe 上逐条钉死，
   不需要网络。

   四条排班规矩，每条都有它的由来：

     · **全局并发上限**（工具给 8）：同时挂在连接上的请求数有上限，不然一次核 118 条会把
       本机与对端一起拖住。
     · **同站串行**（工具给 1）：同一个 hostname 同时只发一条。这不是性能取舍，是礼貌——
       对一个站连发上百条并发请求，轻则被限速、重则被封，而「核验」本来就该慢一点、稳一点。
       某个站忙只挡住它自己的下一条，**不挡整个队列**：后面的站该并发照并发。
     · **路由表只换一次**：连接层失败（DNS 解析不了、连接被拒、证书过不了……）才说明
       「这条路走不通」；一条 URL 失败就先原样试另一条路（直连 ↔ 代理），试通了就把表换掉、
       剩下的队列照新表走。只在**第一次**连接层失败时换，避免 118 条各换一次、来回横跳。
       HTTP 层面的失败（4xx／5xx）**不算**——那是站点自己的答复，换条路也一样。
     · **墙上预算**：到点就不许再起新的（`now() >= deadline`），已经飞出去的等它自己结束
       （每条另有单条超时）。没轮到的原样报成 `pending`，下一次调用接着做——缓存让第二遍
       只补增量。

   为什么 `pending` 是「从没起过的」而不是「没轮到的 + 没探完的」：一条起了但被预算截断的
   请求不该被算成「已完成」，可它已经发出去了、结果也拿得到；这里如实报「它起过」，
   真正的「还没轮到你」只有从没起过的那批。诚实比好看重要。
   ───────────────────────────────────────────────────────────────────────── */

import type { RequestResult, RouteName } from './transport.ts';

/** 排队等核验的一条：`host` 是排班用的同站键（生产路径给 URL 的 hostname）。 */
export interface ProbeTarget {
  readonly url: string;
  readonly host: string;
}

/** 一条探完的结果：结果本身 + 走的是哪条路（缓存要连路由一起记）。 */
export interface ProbeOutcome {
  readonly url: string;
  readonly result: RequestResult;
  readonly route: RouteName;
}

export interface ScheduleResult {
  readonly outcomes: ProbeOutcome[];
  /** 这一轮实际用的路由表（可能在中途换过一次）。 */
  readonly route: RouteName;
  /** 从没起过的那些 URL，按传入顺序。 */
  readonly pending: string[];
}

/** 一次探一个 URL 的能力。**注入**：生产路径是 `requestOnce`，测试里是假货。 */
export type ProbeFn = (url: string, route: RouteName) => Promise<RequestResult>;

export interface RunProbeOptions {
  /** 起始路由表。`未探` 按 `直连` 处理（`未探` 只属于「一条都没得探」的报告）。 */
  readonly route: RouteName;
  /** 有没有可用的代理。没有代理时「换一条路」根本无处可换。 */
  readonly hasProxy: boolean;
  /** 同时最多几条在飞（工具给 8）。 */
  readonly concurrency: number;
  /** 同一个 hostname 同时最多几条（工具给 1）。 */
  readonly perHost: number;
  /** 绝对毫秒时间戳：到点之后不再起新的。 */
  readonly deadline: number;
  readonly now: () => number;
  readonly signal?: AbortSignal | undefined;
  readonly probe: ProbeFn;
}

/** 在飞的一条：`host` 是它占着的同站名额，`done` 在它彻底结束时 resolve。 */
interface Slot {
  readonly host: string;
  done: Promise<void>;
}

function limitOf(value: number, fallback: number): number {
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

/**
 * 按上面四条规矩把 `targets` 探一遍。**不抛**：每个 `probe` 自己的失败已经是一种结果
 * （`RequestResult` 里 `transport: true` + 一句 `note`），这里唯一可能冒出来的异常是
 * `probe` 忘了守「永远 resolve」的约定——那种情况下把这个 URL 记成连接层失败，
 * 别让一条坏 probe 把整轮核验带崩。
 */
export async function runProbes(
  targets: readonly ProbeTarget[],
  options: RunProbeOptions,
): Promise<ScheduleResult> {
  const concurrency = limitOf(options.concurrency, 1);
  const perHost = limitOf(options.perHost, 1);
  const { deadline, now, probe } = options;
  const hasProxy = options.hasProxy;
  // `未探` 只是报告里的说法，排班表里没有它：按直连起步。
  let table: RouteName = options.route === '代理' ? '代理' : '直连';
  let adapted = false;

  const started = new Array<boolean>(targets.length).fill(false);
  const records: { index: number; outcome: ProbeOutcome }[] = [];
  const slots = new Set<Slot>();
  const busy = new Map<string, number>();

  const probeSafely = async (url: string, route: RouteName): Promise<RequestResult> => {
    try {
      return await probe(url, route);
    } catch (error) {
      // 见文件头：probe 违约也不许把整轮带崩，按连接层失败如实记。
      return {
        ok: false,
        status: 0,
        statusText: '',
        contentType: '',
        note: `探测时抛了异常：${error instanceof Error ? error.message : String(error)}`,
        transport: true,
      };
    }
  };

  const launch = (index: number): void => {
    const target = targets[index];
    if (target === undefined) return;
    started[index] = true;
    busy.set(target.host, (busy.get(target.host) ?? 0) + 1);
    // 先放一个已 resolve 的占位再覆盖：`slots.add` 与 `slot.done = …` 谁先谁后都不会
    // 读到还没赋值的那个 promise（这就是要一个 slot 对象、而不是直接往 Set 里塞 promise 的原因）。
    const slot: Slot = { host: target.host, done: Promise.resolve() };
    slots.add(slot);
    const usedRoute: RouteName = table;
    slot.done = (async () => {
      let result = await probeSafely(target.url, usedRoute);
      let route = usedRoute;
      if (result.transport && hasProxy && !adapted) {
        // 第一条连接层失败就把表换过去试一次；换过去通了才算数，不通就照旧。
        adapted = true;
        const other: RouteName = usedRoute === '直连' ? '代理' : '直连';
        const retry = await probeSafely(target.url, other);
        if (retry.ok) {
          table = other;
          result = retry;
          route = other;
        }
      }
      records.push({ index, outcome: { url: target.url, result, route } });
    })().finally(() => {
      busy.set(target.host, (busy.get(target.host) ?? 1) - 1);
      slots.delete(slot);
    }).catch(() => {
      // 见文件头「永远 resolve」：slot 的 promise 只用于 `Promise.race`，它 reject 会把整轮
      // 排班带崩。probe 已经自己在 probeSafely 里兜住了，这条是最后一道防线。
    });
  };

  /** 下一条起得来的：跳过那些「自己的站正忙」的，后面的站该起照起。 */
  const nextStartable = (): number => {
    for (let index = 0; index < targets.length; index += 1) {
      if (started[index]) continue;
      const target = targets[index];
      if (target === undefined) continue;
      if ((busy.get(target.host) ?? 0) >= perHost) continue;
      return index;
    }
    return -1;
  };

  const pending = (): string[] => targets
    .filter((_target, index) => !started[index])
    .map((target) => target.url);

  for (;;) {
    while (slots.size < concurrency) {
      // 两种「到点」：墙上预算用完，或调用方取消了。都不再起新的；飞出去的由各自的
      // probe 自己看着 signal 收尾，这里等它结束。
      if (now() >= deadline || options.signal?.aborted === true) break;
      const index = nextStartable();
      if (index < 0) break;
      launch(index);
    }
    if (slots.size === 0) break;
    await Promise.race([...slots].map((slot) => slot.done));
  }

  records.sort((a, b) => a.index - b.index);
  return { outcomes: records.map((record) => record.outcome), route: table, pending: pending() };
}
