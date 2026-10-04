/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 任务域 —— 任务服务（状态活着时在内存，durable 的同步落盘）

   一次 `createTaskService()` 就是一份台账。生产者在**注册时**登记自己的跑法
   （`defineTaskKind`：导出、资料格式转换、索引重建各一种），调用方拿到句柄去做四件事：
   查状态（从不阻塞）、等（有上限）、取消（回执说清保留什么）、销毁（先回执后删文件）。

   四条硬要求的落点，改之前先读这里：

     · **状态查询从不阻塞**：`status()` 是纯内存读 + 一次投影，没有 await。
     · **等待有上限**：`wait()` 的 `timeoutMs` 有上下界，超时返回 `next`（下一步该干嘛），
       不是吊着、也不是静默返回一个空值。
     · **取消先回执**：`cancel()` 同步返回回执（`kept` = 已完成的产物，一定会保留），
       然后才把取消信号发给产出方。排队中的任务当场落到「已取消」，运行中的落到「取消中」。
     · **销毁先回执、后删文件**：`destroy()` 把回执算好、同步返回，文件删除排在
       `setImmediate` 里（`flushDeletions()` 能把它们跑完）。所以「回执到手」这件事不取决于
       删文件成功与否——删不掉会记进 `problems()`，回执早就给出去了。

   并发的形状：`maxConcurrent`（默认 2）是**排队**这个状态存在的理由——第三个任务起的时候
   前两个还占着位置，它就真的在排队，不是装样子。`start()` 同步返回句柄（与宿主 `ctx.jobs`
   的 `start` 同一契约：starter 同步返回 hooks），调度在同一个调用里往前推一格。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';

import { assertTransition, isTerminal } from './state.ts';
import {
  UNOWNED, TaskAccessError, TaskNotFoundError, TaskWaitAbortedError,
  assertJson, handleOf, toBoardView, toView,
} from './record.ts';
import type {
  ArtifactState, JsonValue, TaskBoardEntry, TaskHandle, TaskRecord, TaskView,
} from './record.ts';
import { createTaskStore, wasInterrupted } from './store.ts';
import type { TaskStore } from './store.ts';

/** 单次等待的默认上限。几十秒这个量级：够等一份课件导完，又短到「工具调用不会挂住会话」。 */
export const DEFAULT_WAIT_MS = 30_000;

/** 单次等待的硬上限。再长就不是「等」而是「挂着」了——那条路是循环调 wait，不是一次大超时。 */
export const MAX_WAIT_MS = 300_000;

/** 同时跑几个。多出来的**排队**（这也是六态里「排队」唯一的来源）。 */
export const DEFAULT_MAX_CONCURRENT = 2;

/** 进度写盘的节流间隔：状态转移与终态**不**节流，只有高频的进度更新走这个。 */
const PROGRESS_FLUSH_MS = 250;

export type ArtifactStateName = ArtifactState;

/** 产出方拿到的任务面。 */
export interface TaskJob {
  readonly id: string;
  readonly attempt: number;
  /** 协作式取消：请求取消时它被 abort，`reason` 是取消理由。产出方按它收尾。 */
  readonly signal: AbortSignal;
  /** 写一行进度（可选带步数，阅读端据此画进度条）。 */
  progress(line: string, steps?: { done?: number; total?: number }): void;
  /** 登记一件产物。默认「进行中」——取消/失败时它不会被算进「保留」。 */
  artifact(path: string, state?: ArtifactStateName): void;
}

/** 产出方跑完给的东西。`result` 给了就必须是 JSON 对象（工具的返回值要过输出契约）。 */
export interface TaskOutcome {
  detail?: string;
  result?: JsonValue;
}

export interface TaskKindSpec {
  /** 中文类型名，例如 `导出`。 */
  kind: string;
  /** id 前缀（ASCII），例如 `export` → `export-1`。 */
  prefix: string;
  run(job: TaskJob, input: JsonValue | undefined): Promise<TaskOutcome | void>;
}

export type TaskKind = TaskKindSpec;

const PREFIX_PATTERN = /^[a-z][a-z0-9-]*$/;

/** 登记一种任务类型。写错了在**注册时**就抛，不留到起任务才发现。 */
export function defineTaskKind(spec: TaskKindSpec): TaskKind {
  if (typeof spec?.kind !== 'string' || spec.kind.trim() === '') {
    throw new Error('[TASK_BAD_KIND] 任务类型要有个非空的名字（例如「导出」）');
  }
  if (spec.kind.includes('\n')) throw new Error(`[TASK_BAD_KIND] 任务类型「${spec.kind}」的名字里有换行`);
  if (typeof spec.prefix !== 'string' || !PREFIX_PATTERN.test(spec.prefix)) {
    throw new Error(`[TASK_BAD_KIND] 任务类型「${spec.kind}」的前缀要是 ASCII 小写（${PREFIX_PATTERN}），`
      + `实际是 ${JSON.stringify(spec.prefix)}——它要当文件名与 URL 参数`);
  }
  if (typeof spec.run !== 'function') {
    throw new Error(`[TASK_BAD_KIND] 任务类型「${spec.kind}」没有 run：没人知道它该怎么跑`);
  }
  return spec;
}

export interface StartOptions {
  /** 已登记的任务类型名。 */
  kind: string;
  /** 一行给人看的话：这次在干什么。 */
  label: string;
  /** 产出方要的入参（resume 时会拿同一份重跑）。 */
  input?: JsonValue;
  /** 关键任务（导出这类）打 true：落盘，重开 DSH 接得上。 */
  durable?: boolean;
  /** 开跑前就登记好的产物路径（一般是产出方先算出来的落点清单）。 */
  artifacts?: readonly string[];
}

export interface WaitResult {
  settled: boolean;
  timedOut: boolean;
  waitedMs: number;
  task: TaskView;
  /** 没结束时的**下一步**提示（超时也走这句）。结束了就是空串。 */
  next: string;
}

export interface CancelReceipt {
  id: string;
  /** 取消请求之后任务的实际状态：排队中的直接是「已取消」，运行中的是「取消中」。 */
  status: TaskRecord['status'];
  /** true = 这次真的发出了取消请求；false = 已经结束，取消来晚了。 */
  requested: boolean;
  /** 一定会保留的产物（已完成的那些）。 */
  kept: string[];
  /** 半成品：产出方按取消信号收尾，任务记录把它们标成「部分」。 */
  discarded: string[];
  note: string;
}

export interface DestroyReceipt {
  id: string;
  status: TaskRecord['status'];
  /** 固定一句「先回执，后删文件」，让调用方知道删除是排在回执后面的。 */
  order: string;
  /** 会被删掉的记录文件（回执给出的这一刻**还在**）。 */
  recordFiles: string[];
  artifactsKept: string[];
  artifactsDeleted: string[];
  note: string;
}

export interface TeardownReceipt {
  /** 卸载时被请求取消的活任务。 */
  cancelled: string[];
  /** 它们的已完成产物（一律保留）。 */
  kept: string[];
  note: string;
}

export interface TaskService {
  readonly dir: string;
  registerKind(kind: TaskKind | TaskKindSpec): () => void;
  kinds(): string[];
  start(actor: string, options: StartOptions): TaskHandle;
  list(actor: string): TaskView[];
  board(): TaskBoardEntry[];
  status(actor: string, ref: string | TaskHandle): TaskView;
  wait(actor: string, ref: string | TaskHandle, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<WaitResult>;
  cancel(actor: string, ref: string | TaskHandle, reason?: string): CancelReceipt;
  destroy(actor: string, ref: string | TaskHandle, options?: { deleteArtifacts?: boolean }): DestroyReceipt;
  resume(actor: string, ref: string | TaskHandle): TaskView;
  /** 把排着的进度写盘跑完（状态转移与终态本来就是同步写的）。 */
  flush(): void;
  /** 把 destroy 排下的删文件跑完。回执早就给过了。 */
  flushDeletions(): Promise<void>;
  /** 读盘与删除遇到的问题（坏记录、删不掉的文件）。 */
  problems(): string[];
  /** 服务要拆了：请求取消活任务，给出回执（文件一律不动——落盘记录要留给下一次启动）。 */
  dispose(): TeardownReceipt;
}

export interface TaskServiceOptions {
  /** 台账目录；省略就是 `<DSH_HOME>/studymate/tasks/`。 */
  dir?: string;
  home?: string;
  maxConcurrent?: number;
  /** 注入时钟（测试用；默认 `new Date()`）。 */
  now?: () => Date;
}

export function createTaskService(options: TaskServiceOptions = {}): TaskService {
  const store: TaskStore = createTaskStore({
    ...options.dir === undefined ? {} : { dir: options.dir },
    ...options.home === undefined ? {} : { home: options.home },
  });
  const now = options.now ?? ((): Date => new Date());
  const iso = (): string => now().toISOString();
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;

  const records = new Map<string, TaskRecord>();
  const kinds = new Map<string, TaskKind>();
  const runs = new Map<string, { controller: AbortController }>();
  const waiters = new Map<string, Set<() => void>>();
  const flushTimers = new Map<string, NodeJS.Timeout>();
  const dirty = new Set<string>();
  /** 已经发出去过的序号：销毁之后也不复用（否则排着的删除会删到新任务头上）。 */
  const spent = new Map<string, number>();
  const problems: string[] = [];
  const deletions: Promise<void>[] = [];

  /* ── 落盘：状态转移与终态同步写，高频进度节流 ─────────────────────────── */

  function clearFlushTimer(id: string): void {
    const timer = flushTimers.get(id);
    if (timer) clearTimeout(timer);
    flushTimers.delete(id);
  }

  function write(record: TaskRecord): void {
    clearFlushTimer(record.id);
    dirty.delete(record.id);
    if (!record.durable) return;
    try {
      store.save(record);
    } catch (error) {
      problems.push(`任务 ${record.id} 写不进台账（${store.dir}）：${(error as Error).message}`);
    }
  }

  function touch(record: TaskRecord, immediate: boolean): void {
    record.updatedAt = iso();
    if (!record.durable) return;
    if (immediate) {
      write(record);
      return;
    }
    dirty.add(record.id);
    if (flushTimers.has(record.id)) return;
    const timer = setTimeout(() => {
      flushTimers.delete(record.id);
      if (dirty.delete(record.id)) write(record);
    }, PROGRESS_FLUSH_MS);
    timer.unref?.();
    flushTimers.set(record.id, timer);
  }

  function notify(id: string): void {
    const set = waiters.get(id);
    if (!set) return;
    waiters.delete(id);
    for (const wake of [...set]) wake();
  }

  function addWaiter(id: string, wake: () => void): () => void {
    let set = waiters.get(id);
    if (!set) {
      set = new Set();
      waiters.set(id, set);
    }
    set.add(wake);
    return () => set.delete(wake);
  }

  /* ── 句柄与越权 ──────────────────────────────────────────────────────── */

  function resolve(actor: string, ref: string | TaskHandle): TaskRecord {
    let id: string;
    if (typeof ref === 'string') {
      id = ref;
    } else if (ref && typeof ref === 'object' && typeof ref.id === 'string') {
      id = ref.id;
      // 句柄只对发出去的那个 owner 有效：别人拿着它来，连记录都不查，先拒。
      // 例外是「本机」的无主句柄——无主任务本来就是给所有调用方的（与宿主 ctx.jobs 同一口径）。
      if (typeof ref.owner !== 'string' || (ref.owner !== actor && ref.owner !== UNOWNED)) {
        throw new TaskAccessError({
          id, actor, why: '这个句柄是发给别人的',
          owner: typeof ref.owner === 'string' ? ref.owner : '（句柄上没有 owner）',
        });
      }
    } else {
      throw new Error('[TASK_BAD_INPUT] 任务引用要是 id 字符串或者 { id, owner } 句柄');
    }
    const record = records.get(id);
    if (!record) throw new TaskNotFoundError(id, [...records.keys()]);
    if (record.owner !== actor && record.owner !== UNOWNED) {
      throw new TaskAccessError({ id, actor, owner: record.owner, why: '它属于另一个调用方' });
    }
    return record;
  }

  const newestFirst = (left: TaskRecord, right: TaskRecord): number => (left.createdAt < right.createdAt ? 1
    : left.createdAt > right.createdAt ? -1 : left.id < right.id ? 1 : -1);

  const visible = (actor: string): TaskRecord[] => [...records.values()]
    .filter((record) => record.owner === actor || record.owner === UNOWNED)
    .sort(newestFirst);

  function nextOrdinal(prefix: string): number {
    let max = spent.get(prefix) ?? 0;
    for (const record of records.values()) {
      if (record.prefix !== prefix) continue;
      const match = /-(\d+)$/.exec(record.id);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return max + 1;
  }

  /* ── 调度 ────────────────────────────────────────────────────────────── */

  function settle(record: TaskRecord, status: '完成' | '失败' | '已取消', detail: string | null, result: JsonValue | null): void {
    // 终态 first-wins：它已经结束了就别再动它
    if (isTerminal(record.status)) return;
    assertTransition(record.id, record.status, status);
    record.status = status;
    record.settledAt = iso();
    record.detail = detail;
    record.result = result;
    touch(record, true);
    notify(record.id);
  }

  function launch(record: TaskRecord): void {
    const kind = kinds.get(record.kind);
    if (!kind) {
      // 登记被撤了（比如插件正在卸载）：不假装能跑，如实落一条失败
      record.status = '运行';
      settle(record, '失败', `任务类型「${record.kind}」现在没登记，没人知道它该怎么跑`, null);
      return;
    }
    record.status = '运行';
    touch(record, true);
    const controller = new AbortController();
    runs.set(record.id, { controller });
    const job: TaskJob = {
      id: record.id,
      attempt: record.attempt,
      signal: controller.signal,
      progress(line, steps) {
        if (typeof line !== 'string' || line.trim() === '') {
          throw new Error('[TASK_BAD_INPUT] 进度行不能是空的');
        }
        const { done, total } = steps ?? {};
        record.progress = {
          line,
          ...done === undefined ? {} : { done },
          ...total === undefined ? {} : { total },
        };
        touch(record, false);
      },
      artifact(path, state = '进行中') {
        if (typeof path !== 'string' || path.trim() === '') {
          throw new Error('[TASK_BAD_INPUT] 产物路径不能是空的');
        }
        const existing = record.artifacts.find((artifact) => artifact.path === path);
        if (existing) existing.state = state;
        else record.artifacts.push({ path, state });
        touch(record, false);
      },
    };

    void (async (): Promise<void> => {
      try {
        const outcome = await kind.run(job, record.input === null ? undefined : record.input);
        const result = outcome?.result ?? null;
        if (result !== null && (typeof result !== 'object' || Array.isArray(result))) {
          throw new Error(`产出方返回的 result 不是对象（实际是 ${Array.isArray(result) ? '数组' : typeof result}）：`
            + '任务结果的契约是 JSON 对象');
        }
        if (result !== null) assertJson(result, '任务结果');
        if (record.cancelReason !== null) {
          // 取消信号发出后它还是跑完了：产物已经写好，报「已取消」是撒谎
          settle(record, '完成', `取消请求（${record.cancelReason}）发出后它还是跑完了，产物保留`, result);
        } else {
          settle(record, '完成', outcome?.detail ?? null, result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (record.cancelReason !== null) {
          settle(record, '已取消', `已按取消请求停下（${record.cancelReason}）；产出方收尾时报：${message}`, null);
        } else {
          settle(record, '失败', message, null);
        }
      } finally {
        runs.delete(record.id);
        pump();
      }
    })();
  }

  function pump(): void {
    let slots = maxConcurrent
      - [...records.values()].filter((record) => record.status === '运行' || record.status === '取消中').length;
    if (slots <= 0) return;
    for (const record of records.values()) {
      if (slots <= 0) break;
      if (record.status !== '排队') continue;
      slots -= 1;
      launch(record);
    }
  }

  function queueDeletion(work: () => void): void {
    deletions.push(new Promise<void>((resolve) => {
      setImmediate(() => {
        try {
          work();
        } catch (error) {
          problems.push(`删文件失败：${(error as Error).message}`);
        }
        resolve();
      });
    }));
  }

  function rmArtifact(path: string): void {
    if (!fs.existsSync(path)) return;
    // 只删普通文件：产物是文件；递归删除要格外小心，不是文件就报出来让人自己看
    if (!fs.statSync(path).isFile()) throw new Error('产物不是普通文件，不敢删');
    fs.rmSync(path, { force: true });
  }

  function nextStep(record: TaskRecord): string {
    const progress = record.progress ? `（进度：${record.progress.line}）` : '';
    if (record.status === '排队') {
      return `任务 ${record.id} 还在排队${progress}：并发位被前面的任务占着。`
        + '下一步：再调一次 studymate_task_wait 接着等、用 studymate_task_status 不阻塞地看、'
        + '或者 studymate_task_cancel 把它撤下来（还没开跑，不会有半成品）。';
    }
    if (record.status === '取消中') {
      return `任务 ${record.id} 正在收尾（取消已经请求过）${progress}。`
        + '下一步：再 wait 一次；已完成的产物会保留，收尾完可以用 studymate_task_destroy 清掉记录。';
    }
    return `任务 ${record.id} 还在跑${progress}。下一步：再调一次 studymate_task_wait（单次等待有上限，`
      + '超时就会返回这句话）、用 studymate_task_status 不阻塞地看进度、或者先去干别的——'
      + '它不会因为你没盯着就停；要停它就 studymate_task_cancel（已完成的产物会保留）。';
  }

  /* ── 读回来：重启打断的活任务如实记成失败，并留下 resume 的路 ─────────── */

  const loaded = store.load();
  problems.push(...loaded.problems);
  for (const record of loaded.records) {
    if (wasInterrupted(record.status)) {
      const was = record.status;
      record.status = '失败';
      record.interrupted = true;
      record.settledAt = iso();
      record.updatedAt = record.settledAt;
      record.detail = `DSH 重启时它还在「${was}」：这一轮的执行没了（进度与产物留在盘上）。`
        + '要接着做就 resume（按原来的类型重跑一遍），要收尾就 destroy。';
      write(record);
    }
    records.set(record.id, record);
    const match = /-(\d+)$/.exec(record.id);
    if (match) spent.set(record.prefix, Math.max(spent.get(record.prefix) ?? 0, Number(match[1])));
  }

  return {
    dir: store.dir,

    registerKind(kind) {
      const defined = defineTaskKind(kind);
      kinds.set(defined.kind, defined);
      return () => {
        if (kinds.get(defined.kind) === defined) kinds.delete(defined.kind);
      };
    },

    kinds: () => [...kinds.keys()],

    start(actor, options) {
      if (typeof actor !== 'string' || actor.trim() === '') {
        throw new Error('[TASK_BAD_INPUT] 起任务要一个非空的 owner 标签（谁起的活）');
      }
      const kind = kinds.get(options?.kind ?? '');
      if (!kind) {
        const known = [...kinds.keys()];
        throw new Error(`[TASK_BAD_KIND] 没有登记的任务类型「${String(options?.kind)}」：`
          + `${known.length === 0 ? '现在一个类型都没登记' : `登记过的是 ${known.join('、')}`}。`
          + '任务只能由产出方起（导出这类工具在注册时登记自己的跑法）——'
          + 'studymate_task_* 那几个工具是查/等/取消/销毁/接上，不是起活。');
      }
      if (typeof options.label !== 'string' || options.label.trim() === '') {
        throw new Error('[TASK_BAD_INPUT] 任务要有一行 label（这次在干什么），模型与人都靠它认任务');
      }
      if (options.input !== undefined) assertJson(options.input, '任务入参');
      const ordinal = nextOrdinal(kind.prefix);
      spent.set(kind.prefix, ordinal);
      const record: TaskRecord = {
        version: 1,
        id: `${kind.prefix}-${ordinal}`,
        kind: kind.kind,
        prefix: kind.prefix,
        label: options.label,
        owner: actor,
        durable: options.durable === true,
        status: '排队',
        attempt: 1,
        progress: null,
        artifacts: (options.artifacts ?? []).map((path) => ({ path, state: '进行中' as const })),
        input: options.input ?? null,
        createdAt: iso(),
        updatedAt: iso(),
        settledAt: null,
        detail: null,
        result: null,
        interrupted: false,
        cancelReason: null,
      };
      records.set(record.id, record);
      write(record);
      pump();
      return handleOf(record);
    },

    list: (actor) => visible(actor).map(toView),

    board: () => [...records.values()].sort(newestFirst).map(toBoardView),

    status: (actor, ref) => toView(resolve(actor, ref)),

    async wait(actor, ref, waitOptions = {}) {
      const record = resolve(actor, ref);
      const timeoutMs = waitOptions.timeoutMs ?? DEFAULT_WAIT_MS;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS) {
        throw new Error(`[TASK_BAD_INPUT] timeoutMs 要 1..${MAX_WAIT_MS} 之间的整数（收到 ${String(waitOptions.timeoutMs)}）：`
          + '等待有上限是刻意的——超时会返回下一步提示，不会被一次调用挂住');
      }
      const started = Date.now();
      const outcome = (timedOut: boolean): WaitResult => {
        const settled = isTerminal(record.status);
        return {
          settled,
          timedOut,
          waitedMs: Date.now() - started,
          task: toView(record),
          next: settled ? '' : nextStep(record),
        };
      };
      if (isTerminal(record.status)) return outcome(false);
      const signal = waitOptions.signal;
      if (signal?.aborted) throw new TaskWaitAbortedError(record.id, '调用方在等之前就已经中止了');
      await new Promise<void>((done, fail) => {
        let finished = false;
        let off: () => void = () => {};
        let timer: NodeJS.Timeout | undefined;
        const cleanup = (): void => {
          if (timer) clearTimeout(timer);
          off();
          signal?.removeEventListener('abort', onAbort);
        };
        const finish = (): void => {
          if (finished) return;
          finished = true;
          cleanup();
          done();
        };
        const onAbort = (): void => {
          if (finished) return;
          finished = true;
          cleanup();
          fail(new TaskWaitAbortedError(record.id, String(signal?.reason ?? '调用方中止了这次等待')));
        };
        timer = setTimeout(finish, timeoutMs);
        timer.unref?.();
        off = addWaiter(record.id, finish);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      return outcome(!isTerminal(record.status));
    },

    cancel(actor, ref, reason) {
      const record = resolve(actor, ref);
      const kept = record.artifacts.filter((artifact) => artifact.state === '已完成').map((artifact) => artifact.path);
      const discarded = record.artifacts.filter((artifact) => artifact.state === '进行中').map((artifact) => artifact.path);
      const keptNote = kept.length === 0
        ? '这次还没有已完成的产物，所以没有东西要保留'
        : `已完成的产物一律保留（不回滚、不删）：${kept.join('、')}`;
      if (isTerminal(record.status)) {
        return {
          id: record.id, status: record.status, requested: false, kept, discarded,
          note: `取消来晚了：任务已经「${record.status}」。${keptNote}。`
            + (record.status === '完成' ? '' : '要清掉记录与文件就用 destroy（先回执、后删文件）。'),
        };
      }
      if (record.status === '取消中') {
        return {
          id: record.id, status: record.status, requested: true, kept, discarded,
          note: `取消已经请求过了，还在等产出方收尾。${keptNote}。`
            + '想知道什么时候停稳就 studymate_task_wait；收尾完了用 destroy 清记录。',
        };
      }
      record.cancelReason = typeof reason === 'string' && reason.trim() !== '' ? reason : '调用方要求取消';
      if (record.status === '排队') {
        // 还没开跑：直接落终态，没有「取消中」那一段
        record.status = '已取消';
        record.settledAt = iso();
        record.detail = '排队时被取消：一行活都没开始跑';
        touch(record, true);
        notify(record.id);
        return {
          id: record.id, status: record.status, requested: true, kept, discarded,
          note: `它还在排队，已经当场取消——没有半成品，也没有产物。${keptNote}。`,
        };
      }
      record.status = '取消中';
      touch(record, true);
      runs.get(record.id)?.controller.abort(record.cancelReason);
      return {
        id: record.id, status: record.status, requested: true, kept, discarded,
        note: `取消请求（${record.cancelReason}）已经发出，等产出方收尾。${keptNote}；`
          + `${discarded.length === 0 ? '没有半成品' : `半成品（${discarded.join('、')}）由产出方按取消信号收尾，记录里它们不算「已完成」`}。`
          + '想知道什么时候停稳就 studymate_task_wait。',
      };
    },

    destroy(actor, ref, destroyOptions = {}) {
      const record = resolve(actor, ref);
      if (!isTerminal(record.status)) {
        throw new Error(`[TASK_NOT_SETTLED] 任务 ${record.id} 还在「${record.status}」，不能销毁：`
          + '先 studymate_task_cancel 让它停下来（或者 studymate_task_wait 等它结束），再 destroy。'
          + '销毁是删记录与文件，活着的任务没有「删掉就没事了」这回事。');
      }
      const deleteArtifacts = destroyOptions.deleteArtifacts === true;
      const artifacts = record.artifacts.map((artifact) => artifact.path);
      const receipt: DestroyReceipt = {
        id: record.id,
        status: record.status,
        order: '先回执，后删文件',
        recordFiles: [store.fileOf(record.id)],
        artifactsKept: deleteArtifacts ? [] : artifacts,
        artifactsDeleted: deleteArtifacts ? artifacts : [],
        note: `${record.kind}「${record.label}」的终态是「${record.status}」。`
          + (deleteArtifacts
            ? `销毁会连产物一起删（${artifacts.length} 件）。`
            : `产物一律保留（${artifacts.length} 件）——要连产物一起删就明确说 deleteArtifacts。`)
          + '这份回执是在删文件**之前**算出来的：删除排在回执后面，删不掉会记进问题的清单，不影响这张回执。',
      };
      // 从可见集里摘掉（回执里已经写清要删什么），文件删除排到本次调用返回之后
      records.delete(record.id);
      notify(record.id);
      queueDeletion(() => {
        store.remove(record.id);
        if (!deleteArtifacts) return;
        for (const artifact of artifacts) {
          try {
            rmArtifact(artifact);
          } catch (error) {
            problems.push(`产物删不掉：${artifact}（${(error as Error).message}）`);
          }
        }
      });
      return receipt;
    },

    resume(actor, ref) {
      const record = resolve(actor, ref);
      if (!record.interrupted) {
        throw new Error(`[TASK_NOT_INTERRUPTED] 任务 ${record.id} 不是被 DSH 重启打断的（现在是「${record.status}」），`
          + '接不上：resume 只认「重启时还在跑」那种——它原来那一轮的执行已经没了。'
          + '要重跑就重新起一个任务（那是产出方的事）。');
      }
      if (!kinds.has(record.kind)) {
        throw new Error(`[TASK_BAD_KIND] 任务 ${record.id} 的类型「${record.kind}」现在没登记，接不上：`
          + '跑法要在产出方注册时才存在。可以 studymate_task_destroy 收尾（回执会说清产物留不留）。');
      }
      record.interrupted = false;
      record.attempt += 1;
      record.progress = null;
      record.detail = null;
      record.result = null;
      record.cancelReason = null;
      record.settledAt = null;
      assertTransition(record.id, record.status, '排队'); // 失败 → 排队：唯一一条从终态回来的路
      record.status = '排队';
      touch(record, true);
      pump();
      return toView(record);
    },

    flush() {
      for (const id of [...dirty]) {
        const record = records.get(id);
        if (record) write(record);
        else dirty.delete(id);
      }
    },

    async flushDeletions() {
      await Promise.all(deletions.splice(0, deletions.length));
    },

    problems: () => [...problems],

    dispose() {
      const cancelled: string[] = [];
      const kept: string[] = [];
      for (const record of records.values()) {
        for (const artifact of record.artifacts) {
          if (artifact.state === '已完成') kept.push(artifact.path);
        }
        if (isTerminal(record.status)) continue;
        cancelled.push(record.id);
        record.cancelReason = record.cancelReason ?? '插件卸载（服务销毁）';
        runs.get(record.id)?.controller.abort(record.cancelReason);
      }
      // 落盘的最后一次机会：durable 的活任务在盘上留下痕迹，重开时按「被打断」接上
      for (const record of records.values()) if (record.durable) write(record);
      const receipt: TeardownReceipt = {
        cancelled,
        kept,
        note: cancelled.length === 0
          ? '销毁时没有还在跑的任务；落盘的记录与已完成产物都留着，重开 DSH 还在。'
          : `销毁时请求取消了 ${cancelled.length} 个活任务（${cancelled.join('、')}）：`
            + '它们的已完成产物一律保留，落盘的记录留在台账里，重开 DSH 后能查、能接上或收尾。',
      };
      // 卸载路径上没人接这个返回值（effect 的 disposer 不传参），所以回执同时记进 problems()：
      // 排查「上次关掉的时候它在干什么」只有这一条线索。
      problems.push(`销毁回执：${receipt.note}`);
      return receipt;
    },
  };
}
