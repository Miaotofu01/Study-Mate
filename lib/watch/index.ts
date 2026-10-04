/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 监听域（#74）—— 对外只有两个入口

     registerWatch(ctx)         学习工作区的**文件监听**（谁变了 → 通知总线）
     registerWatchChannel(ctx)  **变更推送**通道（通知总线 → 打开的页面，SSE）

   为什么是两条注册线而不是一条：它们要挂的服务不一样。监听要 `fs`（拿不到就用 Node
   `fs.watch`），推送要 `connection`（拿不到就退 `webServer`）。宿主里这两个服务就绪的
   时机与位置不同，硬捏成一条会让「缺 connection 的组合连监听都不做」。
   两条**各自**都能把整套拉起来（`ensureWatching` 幂等：一个进程里只有一份监听），
   所以任何一条线被别的改动挪掉，功能也不会静默消失。

   注册点（#68 留的清单）：
     · `lib/tools/index.ts` 的 `registerStudyMate(ctx)` 里一行 `registerWatch(ctx)`；
     · `bin/dsh-plugin.ts` 的 `ctx.inject(['connection'], …)` 清单里一行 `registerWatchChannel(...)`。

   一切都**不许往外抛**：监听/推送起不来只写一行警告，插件其余部分照常（验收第 4 条）。
   ───────────────────────────────────────────────────────────────────────── */

import path from 'node:path';

import { resolveWorkspace } from '../workspace.ts';
import { mergeDomains } from './domains.ts';
import type { WatchDomain } from './domains.ts';
import { publishChange, setWatchBackend } from './notice.ts';
import {
  capabilityObserver, isFsWatchService, nodeObserver, startTreeWatch,
} from './tree.ts';
import type { ObserveDirectory, TreeWatch } from './tree.ts';
import {
  createChannel, EVENTS_PATH, FALLBACK_EVENTS_PATH, registerStreamRoute, registerWebRoute,
} from './channel.ts';
import type { ConnectionLike } from './channel.ts';

export { WATCH_DOMAINS, domainsOfPath, mergeDomains } from './domains.ts';
export type { WatchDomain } from './domains.ts';
export { publishChange, subscribeNotices, sseFrame, sseGreeting, watchBackend, resetNoticeBusForTests } from './notice.ts';
export type { ChangeNotice } from './notice.ts';
export {
  collectDirectories, capabilityObserver, nodeObserver, startTreeWatch,
  WATCH_DEBOUNCE_MS, WATCH_MAX_DEPTH, WATCH_MAX_DIRECTORIES,
} from './tree.ts';
export type { ObserveDirectory, TreeWatch } from './tree.ts';
export { EVENTS_PATH, FALLBACK_EVENTS_PATH } from './channel.ts';
export type { PushChannel, SseClient } from './channel.ts';

/**
 * 注册这两条线时用得着的宿主面。**全部可选**：headless / 更老的宿主 / 单测传进来的
 * 是一个残缺的 ctx，下面每一步都在运行期自己判一次（与 bin/dsh-plugin.ts 同一姿势）。
 */
export interface WatchContext {
  get?: (name: string) => unknown;
  inject?: (names: string[], handler: (ctx: WatchContext) => void) => unknown;
  effect?: (fn: () => unknown, description?: string) => unknown;
}

export interface ChannelOptions {
  /** 强制走某条推送路（真 DSH 探针要分别验两条；生产由服务可用性决定）。 */
  route?: 'connection' | 'webServer';
  /** 覆盖路由路径（探针用；生产用默认值）。 */
  path?: string;
}

/* ── 警告：每个理由只说一次 ─────────────────────────────────────────────
   监听回调和每个 HTTP 连接都可能是高频路径；同一句话刷屏等于没有日志。 */

const warned = new Set<string>();

function warn(message: string): void {
  if (warned.has(message)) return;
  if (warned.size >= 32) warned.clear();
  warned.add(message);
  console.warn(`StudyMate：${message}`);
}

/** 只给测试用：让「每个理由只说一次」在用例之间复位。 */
export function resetWatchWarningsForTests(): void {
  warned.clear();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 从 ctx 上取一个服务：先 `ctx.get`，再反射读（bin/dsh-plugin.ts 用的就是反射读）。 */
function readService(ctx: WatchContext, name: string): unknown {
  if (typeof ctx.get === 'function') {
    const found = ctx.get(name);
    if (found !== undefined && found !== null) return found;
  }
  return Reflect.get(ctx as object, name);
}

/* ── 监听 ───────────────────────────────────────────────────────────────── */

let watching: { stop: () => Promise<void> } | null = null;

/** 读工作区配置：读不出来（没配置、文件坏了）就不是错误，只是「没得监听」。 */
function safeWorkspace(): string {
  try {
    return resolveWorkspace();
  } catch (error) {
    warn(`读不了学习工作区配置：${messageOf(error)}`);
    return '';
  }
}

/**
 * 挑一个目录观察后端：宿主 fs 能力优先，起不来（或压根没有）退 Node `fs.watch`。
 * 「起不来」是真的试着开一次再关掉——只看着接口在不在，会把「装了但用不了」
 * 误判成可用（这时整棵树一个目录都观察不上，页面永远收不到推送）。
 */
async function chooseObserver(ctx: WatchContext, workspace: string): Promise<{ observe: ObserveDirectory; backend: string }> {
  const service = readService(ctx, 'fs');
  if (isFsWatchService(service)) {
    const observe = capabilityObserver(service);
    try {
      const close = await observe(workspace, () => { /* 试挂：马上关掉，只为知道能不能用 */ });
      await close();
      return { observe, backend: 'fs-service' };
    } catch (error) {
      warn(`宿主 ctx.fs.watch 用不了（${messageOf(error)}），退回 Node fs.watch`);
    }
  } else {
    warn('当前组合没有 ctx.fs（或没有 watch），用 Node fs.watch 监听学习工作区');
  }
  return { observe: nodeObserver(), backend: 'node-fs' };
}

function startWatching(ctx: WatchContext): () => Promise<void> {
  let stopped = false;
  let stop: (() => Promise<void>) | null = null;

  const begin = (observe: ObserveDirectory, backend: string, workspace: string): void => {
    void startTreeWatch({
      workspace,
      observe,
      backend,
      onChanged: (directories) => {
        // 宿主 fs.watch 只给「哪个目录变了」，Node fs.watch 的 filename 可能是 null，
        // 所以域按**目录**算；两者都走同一个映射（domains.ts 对目录也成立）。
        const domains: WatchDomain[] = mergeDomains(directories.map((directory) => path.relative(workspace, directory) || '.'));
        publishChange(domains);
      },
      onProblem: (text) => warn(text),
    }).then((handle: TreeWatch) => {
      // 起监听是异步的（扫盘 + 逐个挂观察者）。如果还没挂好人就被要求停（效应被拆、
      // HMR 重载），这里必须**真的把它关掉**：否则会留下一个「已经不算数、却还在推」的
      // 幽灵 watcher——页面上看着正常，可后端标签永远停在「未起」。
      if (stopped) { void handle.close(); return; }
      stop = () => handle.close();
      setWatchBackend(handle.backend);
      if (handle.directories().length === 0) {
        warn(`一个目录都没监听上（工作区：${workspace}）：文件变了不会推送`);
      }
    }).catch((error: unknown) => {
      setWatchBackend('起不来');
      warn(`起不了文件监听：${messageOf(error)}`);
    });
  };

  // 拿到「能用哪个观察后端」的那一层 ctx：可能是注册时的 ctx，也可能是 fs 服务晚到之后
  // 由 inject 回调给的那一层。挑后端的逻辑只写一遍（含「试挂失败就退 Node」那一步）。
  const run = async (services: WatchContext): Promise<void> => {
    const workspace = safeWorkspace();
    if (!workspace) {
      warn('没配置学习工作区（~/.dsh/studymate-config.yaml 里没有 workspace），文件监听没起');
      return;
    }
    const { observe, backend } = await chooseObserver(services, workspace);
    // 后端一选定就记名：挂观察者是异步的（扫盘 + 逐个 ready），而 SSE 建连是随时可能发生的，
    // 早不早这一步决定了「建连问候里说的后端」是不是真的。
    setWatchBackend(backend);
    if (stopped) return;
    begin(observe, backend, workspace);
  };
  const start = (): void => {
    void run(ctx).catch((error: unknown) => warn(`起不了文件监听：${messageOf(error)}`));
  };

  const service = readService(ctx, 'fs');
  if (isFsWatchService(service) || typeof ctx.inject !== 'function') {
    start();
  } else {
    // fs 服务比插件晚就绪是可能的：等它出现再挑后端（缺了就一直不 fire，那就什么都不起）
    try {
      ctx.inject(['fs'], (fsCtx) => {
        const late = readService(fsCtx, 'fs');
        void run({ get: (name) => (name === 'fs' ? late : undefined) })
          .catch((error: unknown) => warn(`起不了文件监听：${messageOf(error)}`));
      });
    } catch (error) {
      warn(`等 fs 服务时出错（${messageOf(error)}），直接用 Node fs.watch`);
      start();
    }
  }

  return async () => {
    stopped = true;
    if (stop) await stop();
  };
}

/** 幂等：两条注册线谁先来谁起，后来的只记账——一个进程里只有一份监听。 */
function ensureWatching(ctx: WatchContext): void {
  if (watching) return;
  watching = { stop: startWatching(ctx) };
}

function stopWatching(): void {
  const current = watching;
  watching = null;
  if (current) void current.stop().catch(() => { /* 拆卸阶段的失败不值得再吵 */ });
}

/**
 * 注册文件监听。放在 `lib/tools/index.ts` 的 `registerStudyMate(ctx)` 清单里。
 * 不抛异常：坏掉的监听不该把原生工具一起带走。
 */
export function registerWatch(ctx: WatchContext): void {
  const start = (): void => { ensureWatching(ctx); };
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => { start(); return () => stopWatching(); }, 'studymate: 学习工作区文件监听');
    } else {
      // 没有 effect 的宿主（单测、更老的组合）：照常起，只是卸载时拆不掉
      start();
    }
  } catch (error) {
    warn(`注册文件监听失败：${messageOf(error)}`);
  }
}

/* ── 推送 ───────────────────────────────────────────────────────────────── */

function openChannel(ctx: WatchContext, options: ChannelOptions): () => void {
  const channel = createChannel();
  let closed = false;
  const closeChannel = (): void => { if (closed) return; closed = true; channel.closeAll(); };

  // 推送线也能单独把监听拉起来（两条线各自可用，见文件头）
  try { ensureWatching(ctx); } catch (error) { warn(`起监听失败：${messageOf(error)}`); }

  const connection = readService(ctx, 'connection') as ConnectionLike | undefined;
  const canStream = Boolean(connection?.fetch?.register);
  if (options.route !== 'webServer' && canStream) {
    try {
      const dispose = registerStreamRoute(connection as ConnectionLike, channel, options.path ?? EVENTS_PATH);
      return () => {
        closeChannel();
        void Promise.resolve(dispose()).catch(() => { /* 路由拆卸失败不值得再吵 */ });
      };
    } catch (error) {
      warn(`/api 事件路由挂不上（${messageOf(error)}），退回 webServer 精确路由`);
    }
  }

  const webServer = readService(ctx, 'webServer') as {
    register?: (route: { kind: 'exact'; path: string; handler: (req: never, res: never) => void }) => () => void;
  } | undefined;
  if (webServer && typeof webServer.register === 'function') {
    if (!connection) {
      warn('推送通道走 webServer 退路：这条路由不在 /api 围栏里，宿主没给 connection，认证判不了（只在 loopback 上用）');
    }
    const dispose = registerWebRoute(
      webServer as Parameters<typeof registerWebRoute>[0], channel, connection,
      options.path ?? FALLBACK_EVENTS_PATH,
    );
    return () => { closeChannel(); dispose(); };
  }

  closeChannel();
  warn('既没有 connection 也没有 webServer：变更推送通道没挂上（文件监听本身照常）');
  return () => { /* 什么都没挂上，没什么可拆 */ };
}

/**
 * 注册变更推送通道。放在 `bin/dsh-plugin.ts` 的 `ctx.inject(['connection'], …)` 清单里
 * （那一行是 `connectionCtx.effect(() => registerWatchChannel(connectionCtx), '…')` 的形状）。
 * 返回 disposer：路由与所有已连上的页面一起收掉。
 */
export function registerWatchChannel(ctx: WatchContext, options: ChannelOptions = {}): () => void {
  const open = (): (() => void) => openChannel(ctx, options);
  try {
    if (typeof ctx.effect === 'function') return ctx.effect(open, 'studymate: 变更推送通道（SSE）') as () => void;
    return open();
  } catch (error) {
    warn(`注册变更推送通道失败：${messageOf(error)}`);
    return () => { /* 没挂上 */ };
  }
}

/** 只给测试用：把「监听已起」的进程级状态复位。 */
export function resetWatchRegistryForTests(): void {
  watching = null;
  warned.clear();
}
