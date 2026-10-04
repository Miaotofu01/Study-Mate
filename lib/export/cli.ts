/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 导出域 —— 无头宿主的命令行入口（`studymate export`）

   为什么要有它：Antigravity / Codex·ChatGPT Work 里没有阅读端，学生的阅读体验**全靠导出**
   （ADR-0003 / 目标态规格 §2.3）。那两条路径上跑的是 Node，所以导出要有一个**没有参数也能跑**
   的命令：工作区按 `--workspace` → `$LEARN_WORKSPACE` → `~/.dsh/studymate-config.yaml` 的顺序
   定位（与安装器写的是同一份配置），落点默认 `<工作区>/export/`。

   **默认导出**就体现在「没有参数也能跑」这一条上：无头侧课完跑一次 `studymate export` 即可，
   再来一课再跑一次（覆盖同名文件，幂等）。DSH 侧**不主动导出**——那边由学生说「导出一份能
   离线看的」才跑（工具 `studymate_export`）。

   取消：Ctrl-C 打进一个 abort 信号，导出按「一个文件」的粒度停下并**如实报出保留了哪些**；
   半成品目录没有入口 `index.html`，一眼能认出（见 run.ts）。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

import { resolveWorkspace } from '../workspace.ts';
import { OUT_DIR_NAME } from './page.ts';
import { runExport, ExportCancelledError } from './run.ts';
import type { ExportOutcome } from './run.ts';

export interface ExportCliIo {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface ExportCliOptions {
  workspace?: string;
  out?: string;
  subjects?: string[];
  /** 只吐一行机器可读的 JSON（技能与自动化用）。 */
  json?: boolean;
  /** 不打印逐文件进度（技能日志里只要结论时用）。 */
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** 外部取消信号（bin 里由 SIGINT 触发）；给了就不自己装 SIGINT。 */
  signal?: AbortSignal;
}

export class WorkspaceMissingError extends Error {
  readonly code = 'EXPORT_NO_WORKSPACE';
  /** 按顺序找过哪些地方（诊断用）。 */
  readonly tried: readonly string[];
  constructor(tried: readonly string[]) {
    super('[EXPORT_NO_WORKSPACE] 没找到学习工作区。按这个顺序找过：'
      + `${tried.join(' → ')}。用 --workspace <目录> 指一个，`
      + '或设 LEARN_WORKSPACE，或先跑一次安装（配置写在 ~/.dsh/studymate-config.yaml）。');
    this.name = 'WorkspaceMissingError';
    this.tried = tried;
  }
}

/** 一个目录像不像学习工作区：`<dir>/.learning/subjects/` 是目录。 */
function looksLikeWorkspace(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, '.learning', 'subjects')).isDirectory();
  } catch {
    return false;
  }
}

/** 工作区定位（见文件头）。找不到就抛一句能照着做的话。 */
export function locateWorkspace(options: { workspace?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const tried: string[] = [];
  const explicit = options.workspace ?? env.LEARN_WORKSPACE;
  if (explicit) {
    tried.push(`指定的工作区（${explicit}）`);
    const resolved = path.resolve(cwd, explicit);
    if (!looksLikeWorkspace(resolved)) {
      throw new Error(`[EXPORT_NO_WORKSPACE] ${resolved} 不像学习工作区（里面没有 .learning/subjects/）。`);
    }
    return resolved;
  }
  tried.push('$DSH_HOME/studymate-config.yaml 的 workspace');
  const configured = resolveWorkspace();
  if (configured && looksLikeWorkspace(configured)) return configured;
  tried.push(`当前目录（${cwd}）`);
  if (looksLikeWorkspace(cwd)) return cwd;
  throw new WorkspaceMissingError(tried);
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 跑一次导出并打印结果。返回进程退出码（0 成功 / 1 失败 / 130 被取消），
 * 由 `bin/studymate.mjs` 直接交给 `process.exitCode`。
 */
export async function exportCommand(options: ExportCliOptions = {}, io: ExportCliIo = {}): Promise<number> {
  const write = io.stdout ?? ((line: string): void => { console.log(line); });
  const warn = io.stderr ?? ((line: string): void => { console.error(line); });
  const json = options.json === true;
  const quiet = options.quiet === true || json;

  let workspace: string;
  try {
    workspace = locateWorkspace(options);
  } catch (error) {
    warn(`StudyMate：${(error as Error).message}`);
    return 1;
  }
  const out = options.out ? path.resolve(options.out) : path.join(workspace, OUT_DIR_NAME);

  // 进度节流：配图可能上百张，逐张打会把技能日志刷爆；阶段行照打，配图每 10 张报一次。
  let assetsSeen = 0;
  const progress = (line: string): void => {
    if (quiet) return;
    if (line.startsWith('拷贝配图')) {
      assetsSeen += 1;
      const match = /\/(\d+)$/.exec(line);
      const total = match ? Number(match[1]) : 0;
      if (assetsSeen % 10 !== 0 && assetsSeen !== total) return;
    }
    warn(`  ${line}`);
  };

  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const onInterrupt = (): void => {
    warn('StudyMate：收到中断，正在停（已完成的文件会保留，报出来的清单就是留下的东西）…');
    controller.abort('命令行收到中断（Ctrl-C）');
  };
  if (!options.signal) process.on('SIGINT', onInterrupt);

  try {
    const outcome: ExportOutcome = await runExport({
      workspace,
      out,
      ...options.subjects === undefined || options.subjects.length === 0 ? {} : { subjects: options.subjects },
      signal,
      progress,
    });
    if (json) {
      write(JSON.stringify({
        ok: true,
        out: outcome.out,
        entry: path.join(outcome.out, 'index.html'),
        files: outcome.files,
        count: outcome.files.length,
        bytes: outcome.bytes,
        subjects: outcome.subjects,
        react: outcome.react,
        summary: outcome.summary,
      }));
    } else {
      write(`StudyMate 导出完成：${outcome.out}`);
      write(`  ${outcome.summary}`);
      write(`  合计 ${fmtBytes(outcome.bytes)}`);
      write(`  入口：${path.join(outcome.out, 'index.html')}（双击打开，或者在浏览器里用 file:// 打开）`);
    }
    return 0;
  } catch (error) {
    if (error instanceof ExportCancelledError) {
      warn(`StudyMate：${error.message}`);
      return 130;
    }
    if (error instanceof Error && (error as { code?: string }).code === 'EXPORT_REACT_MISSING') {
      warn(`StudyMate：${error.message}`);
      return 1;
    }
    warn(`StudyMate：导出失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (!options.signal) process.off('SIGINT', onInterrupt);
  }
}

export { fmtBytes };
