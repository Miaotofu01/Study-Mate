/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工作区目录树监听（#74）

   两件事，分开做：

   1. **一个目录的观察原语**（`ObserveDirectory`）。两条实现：
      · `capabilityObserver` —— 宿主的 `ctx.fs.watch(target, changed, signal)`
        （`dsh-plugin-api.md` §7.1；dsh-fs-local 底下是 chokidar，跨平台、宿主自己维护）；
      · `nodeObserver` —— Node 自带 `fs.watch`（§7.4 的退路：平台差异多，必须容错）。
      两条都只报「这个目录的直接子项有变化」，**不给文件名**，这正是宿主契约的样子。

   2. **目录集合**：学习工作区的树是四层深
      （`<工作区>/.learning/subjects/<科目>/{lessons,attempts,lab,…}`），
      而原语的粒度是「直接子项」（`dsh-fs-local` 用 chokidar 时写死 `depth: 0`）。
      所以这里**自己维护一个目录集合**：每次变更之后重扫一遍工作区，
      给新出现的目录补一个观察者、把没了的摘掉。
      ——新建科目、新建 lessons/ 这种「外层新建」就是靠这一步被看见的（验收第 3 条）。

   容错是硬要求（验收第 4 条）：单个目录观察不起来、某次读盘失败、观察者报 error，
   都只记一句问题、不影响别的目录，也不许把异常扔回 fs 的事件回调。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

/** 关掉一个目录观察者。 */
export type CloseDirectory = () => Promise<void> | void;

/**
 * 观察一个目录的**直接子项**。初始化失败就抛（调用方会退到别的后端或跳过这个目录）。
 * `changed(error?)`：宿主/Node 的回调形状，error 只表示「观察本身出了问题」，不是文件名。
 */
export type ObserveDirectory = (directory: string, changed: (error?: Error) => void) => Promise<CloseDirectory>;

/** 宿主 `ctx.fs` 里我们用到的最小面（形状由 `dsh-fs` 定，这里按用到的成员收窄）。 */
export interface FsWatchService {
  resolve(target: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  watch(target: unknown, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>;
}

export function isFsWatchService(value: unknown): value is FsWatchService {
  const service = value as Partial<FsWatchService> | null | undefined;
  return Boolean(service) && typeof service?.resolve === 'function' && typeof service?.watch === 'function';
}

/** 宿主 fs 能力后端。目标先 `resolve` 成 FsTarget——宿主契约要求，别自己拼路径塞进去。 */
export function capabilityObserver(service: FsWatchService): ObserveDirectory {
  return async (directory, changed) => {
    const controller = new AbortController();
    const target = await service.resolve(directory);
    const close = await service.watch(target, (error) => changed(error), controller.signal);
    return async () => { controller.abort(); await close(); };
  };
}

/** Node `fs.watch` 后端。 */
export function nodeObserver(): ObserveDirectory {
  return async (directory, changed) => {
    // persistent:false 是**刻意**的：观察句柄不再吊住事件循环。监听是给已打开的页面用的，
    // 不是进程的存活理由——宿主该退出时就该退出，不必等我们；被支起来跑一会儿的宿主
    // （单测、一次性脚本）也不会因为多了一个 watcher 而永远结束不了。
    const watcher = fs.watch(directory, { persistent: false }, () => changed());
    // 没有 error 监听的 FSWatcher 会把 error 事件升成未捕获异常 → 拖垮宿主。
    // 这里是「一次观察失败不许让插件失效」的第一道闸。
    watcher.on('error', (error) => changed(error instanceof Error ? error : new Error(String(error))));
    return () => watcher.close();
  };
}

/** 扫盘上限：层级与目录数都封顶，工作区再乱也不会挂出成百上千个 watcher。 */
export const WATCH_MAX_DEPTH = 4;
export const WATCH_MAX_DIRECTORIES = 64;
/** 去抖窗口：一次保存可能来好几条事件（rename + change，编辑器还会「临时文件 + rename」）。 */
export const WATCH_DEBOUNCE_MS = 150;

/** 扫盘时跳过的大目录（学习工作区里不该有，真有了也不该被监听到）。 */
const SKIPPED = new Set(['node_modules', '.git']);

/**
 * 这个目录还在不在。Windows 上「已删路径仍被回调」是常态，所以观察回调里每次都要问一句：
 * 读不动（ENOENT / EPERM）就当作没了，宁可摘掉观察者——`sync()` 会在下一次变更时补回来。
 */
function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 工作区**内容**指纹：每个条目的「相对目录 + 条目集 + 类型 + mtime + 文件大小（不含 atime）」拼成一份。
 * 只有内容真的变了（条目集变化、mtime 前进、文件大小变化）指纹才会变——访问时间（atime）与
 * 属性变化不进来。为什么要它：Windows 的 libuv `fs.watch` 订阅了
 * `FILE_NOTIFY_CHANGE_LAST_ACCESS | ATTRIBUTES`，**我们自己读盘**（`readLibrary`
 * 枚举科目目录、sync() 重扫目录集合）也会触发事件——监听器把「自己读」当成「别人改」，
 * 推一条通知出去，页面静默重取，重取又是一次读……新工作区上这是必现的一条幽灵通知。
 * 指纹不变的批次一律不发布：噪音在引擎层被吸收，通知与重取只认真的内容变化。
 * 代价（顺带说明，不是漏洞）：改内容又原样保 mtime 且文件大小也巧合不变的写法（备份/同步工具）
 * 会被漏报，直到下一次正常写入；这是相对「每次读盘都推一轮」明确更划算的取舍。
 */
function contentFingerprint(root: string, maxDepth: number, limit: number): string | null {
  const directories = collectDirectories(root, maxDepth, limit);
  if (directories === null) return null;
  directories.sort();
  const parts: string[] = [];
  for (const directory of directories) {
    parts.push(path.relative(root, directory) || '.');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      let mtimeMs = -1;
      let size = -1;
      try {
        const stat = fs.statSync(path.join(directory, entry.name), { throwIfNoEntry: false });
        if (stat) {
          mtimeMs = stat.mtimeMs;
          size = entry.isDirectory() ? 0 : stat.size;
        }
      } catch { /* 条目在扫的瞬间没了：记 -1，下一条事件会带来真实状态 */ }
      parts.push(`${entry.name}${entry.isDirectory() ? '/' : ''}:${mtimeMs}:${size}`);
    }
  }
  return parts.join('\u0000');
}

/**
 * 收集要观察的目录（含 root 自己）。
 * 读不动某一层就跳过那一层——**不抛异常**：读盘失败不该让监听整体失效。
 * 返回 `null` 表示连 root 都读不了（调用方保留现有集合，别把观察者全摘了）。
 */
export function collectDirectories(root: string, maxDepth = WATCH_MAX_DEPTH, limit = WATCH_MAX_DIRECTORIES): string[] | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (found.length >= limit) return;
    found.push(directory);
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      if (!entry.isDirectory()) continue;
      // 符号链接的目录不跟：跟随会走出工作区，也会绕开上限
      if (entry.isSymbolicLink()) continue;
      if (SKIPPED.has(entry.name)) continue;
      walk(path.join(directory, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

export interface TreeWatchOptions {
  workspace: string;
  observe: ObserveDirectory;
  /** 后端名字（`fs-service` / `node-fs`）：只用于诊断与报告。 */
  backend: string;
  /** 去抖之后回调一次：这一批里有哪些**目录**变了（绝对路径）。 */
  onChanged: (directories: string[]) => void;
  /** 出问题时的单行说明（不该抛；由调用方决定往哪写）。 */
  onProblem?: (message: string) => void;
  debounceMs?: number;
  maxDepth?: number;
  maxDirectories?: number;
}

export interface TreeWatch {
  backend: string;
  /** 当前挂着的目录（测试与报告用）。 */
  directories(): string[];
  close(): Promise<void>;
}

/**
 * 起一份目录树监听。返回时集合已经建好（第一波改动不会漏）。
 */
export async function startTreeWatch(options: TreeWatchOptions): Promise<TreeWatch> {
  const { workspace, observe, backend, onChanged, onProblem } = options;
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  const maxDepth = options.maxDepth ?? WATCH_MAX_DEPTH;
  const limit = options.maxDirectories ?? WATCH_MAX_DIRECTORIES;

  const watched = new Map<string, CloseDirectory>();
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let syncing = false;
  let resync = false;
  // 内容指纹基线：**在建观察者之前**取——取晚了的话，「起监听的这段窗口里的真写入」会被
  // 当成基线的一部分而漏报。读不动工作区时保持 null：null 的语义是「不知道 → 照常发布」。
  let fingerprint = contentFingerprint(workspace, maxDepth, limit);

  const problem = (message: string): void => { onProblem?.(message); };

  const add = async (directory: string): Promise<void> => {
    // 目录被删 / 被改名之后，Windows 后端（`ReadDirectoryChangesW`）会对着已经消失的路径
    // 反复回调——实测每秒上万次、单核打满、进程再也退不出去（Linux 的 inotify 只发一次
    // `IN_DELETE_SELF`，所以这条只在 Windows 上炸）。所以每次回调先看一眼目录还在不在，
    // 不在就**当场摘掉观察者**：不能让一条空转的句柄把宿主的事件循环拴住。
    let closer: CloseDirectory | null = null;
    let dropped = false;
    const drop = (): void => {
      if (dropped) return;
      dropped = true;
      const close = closer;
      closer = null;
      if (!close) return;
      if (watched.get(directory) === close) watched.delete(directory);
      void close();
    };
    const onEvent = (error?: Error): void => {
      if (error) problem(`监听 ${directory} 时报错：${error.message}`);
      if (closed || !isDirectory(directory)) { drop(); return; }
      touch(directory);
    };
    try {
      const close = await observe(directory, onEvent);
      if (closed || dropped) { await close(); return; }
      closer = close;
      watched.set(directory, close);
    } catch (error) {
      // 单个目录观察不起来（权限、已被删、后端不支持）→ 只记一句，不影响别的目录
      problem(`监听不了 ${directory}：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const sync = async (): Promise<void> => {
    if (closed) return;
    if (syncing) { resync = true; return; }
    syncing = true;
    try {
      do {
        resync = false;
        const desired = collectDirectories(workspace, maxDepth, limit);
        if (desired === null) {
          // 读不到工作区（刚被删/还没建好）：保留现有观察者，等下一次变更再试
          problem(`扫不了 ${workspace}，这一轮不调整监听目录`);
          break;
        }
        const wanted = new Set(desired);
        // 新目录**并行**挂：串行等 6 个 chokidar ready 会把「观察者就绪」往后拖，
        // 而这段窗口里的改动是不补发的（ignoreInitial）。窗口越短越好。
        await Promise.all(desired.filter((directory) => !watched.has(directory))
          .map((directory) => add(directory)));
        for (const [directory, close] of [...watched]) {
          if (wanted.has(directory)) continue;
          watched.delete(directory);
          try { await close(); } catch { /* 关不掉就算了，不能因此中断同步 */ }
        }
      } while (resync && !closed);
    } finally {
      syncing = false;
    }
  };

  function flush(): void {
    timer = null;
    const directories = [...pending];
    pending.clear();
    if (closed || directories.length === 0) return;
    // 内容指纹没动 = 这一批只是读回声/属性噪音（我们自己或系统读盘），不发布也不重扫。
    // 读不动工作区（null）时照旧发布：删除/权限这类真变化宁可推出去。
    const current = contentFingerprint(workspace, maxDepth, limit);
    if (current === null) {
      problem('扫不了工作区，这一批事件按原样发布');
    } else if (current === fingerprint) {
      return;
    } else {
      fingerprint = current;
    }
    // 先通知（页面尽快更新），再补目录集合（新建的目录要挂上观察者，下一条才看得见）
    try { onChanged(directories); } catch (error) {
      problem(`变更回调抛了：${error instanceof Error ? error.message : String(error)}`);
    }
    void sync();
  }

  function touch(directory: string): void {
    if (closed) return;
    pending.add(directory);
    if (timer) return;
    timer = setTimeout(flush, debounceMs);
    // 不吊住事件循环：宿主退出时不必等这个窗口
    if (typeof timer.unref === 'function') timer.unref();
  }

  await sync();

  return {
    backend,
    directories: () => [...watched.keys()].sort(),
    async close() {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      pending.clear();
      const closers = [...watched.values()];
      watched.clear();
      await Promise.all(closers.map(async (close) => {
        try { await close(); } catch { /* 拆卸阶段的失败不值得再吵 */ }
      }));
    },
  };
}
