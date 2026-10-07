/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 导出域 —— 落盘（计划 → 文件），带进度、取消与产物登记

   调用方有两条，落盘口是同一个：
     · DSH 侧：`studymate_export` 起一个任务，任务服务把 `job.progress` / `job.artifact` /
       `job.signal` 接进来（#73 的任务模型：可查状态、可取消）；
     · 无头侧：CLI 直接调，进度打到 stderr，Ctrl-C 把 abort 信号打进来。

   **取消说清保留了什么**（目标态规格 §3.2）：每个产物落盘之前先登记成「进行中」、落成之后
   立刻改成「已完成」。取消时抛 `ExportCancelledError`，消息里报「已完成 N 个、保留在 <out>」，
   任务服务的取消回执据此把「已完成的产物一律保留」讲清楚。半成品不删——**导出从不删文件**：
   删错东西的代价比留下一个能看懂的半成品大得多，而入口 `index.html` 排在最后写，
   所以半成品目录一眼就能认出来（没有入口）。

   `out` 的判据：不许落在 `.learning/` 里（那是学习数据），也不许就是工作区根
   （规格 §5.1 已经退役「工作区根 index.html」那种摆法：产物与学习数据搅在一起）。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

import { isWithin } from '../paths.ts';
import { OUT_DIR_NAME } from './page.ts';
import { planExport } from './plan.ts';
import type { ExportManifest, ExportPlan, ManifestSubject } from './plan.ts';
import { resolveReact } from './react.ts';
import type { ReactSources } from './react.ts';

export interface ProgressSteps {
  done?: number;
  total?: number;
}

export interface RunExportOptions {
  workspace: string;
  /** 落点；默认 `<工作区>/export/`。 */
  out?: string;
  /** 只要这几门科目（slug）；省略 = 全部。 */
  subjects?: readonly string[];
  clientFile?: string;
  /** 第三方 React 的来源；省略就现解析（见 react.ts 的候选顺序）。 */
  react?: ReactSources;
  signal?: AbortSignal;
  progress?: (line: string, steps?: ProgressSteps) => void;
  /** 每个产物两次：先「进行中」，落成后「已完成」。任务域的句柄据此算「保留了什么」。 */
  onArtifact?: (path: string, state: '进行中' | '已完成') => void;
  /** 覆盖落盘（测试与特殊宿主用）；默认写到 `out` 之下（带容器判据）。 */
  writeFile?: (relPath: string, data: string | Buffer) => void;
  now?: () => Date;
}

export interface ExportOutcome {
  /** 导出目录的绝对路径。 */
  out: string;
  /** 产物相对路径（按落盘顺序；入口 index.html 与清单不在最前）。 */
  files: string[];
  subjects: ManifestSubject[];
  summary: string;
  bytes: number;
  react: { version: string; source: string };
  manifest: ExportManifest;
}

/** 取消：产出方按信号收尾时抛它。任务服务把这次落成「已取消」并原样带上这句话。 */
export class ExportCancelledError extends Error {
  readonly code = 'EXPORT_CANCELLED';
  readonly kept: readonly string[];
  constructor(kept: readonly string[], out: string, reason: unknown) {
    super(`[EXPORT_CANCELLED] 导出被取消（${String(reason || '调用方要求取消')}）：`
      + `已落成的 ${kept.length} 个产物保留在 ${out}（导出从不回滚也不删文件）；`
      + '入口 index.html 排在最后写，所以这个目录现在多半还没有入口——看到没有 index.html 就是半成品。'
      + '重跑一次会覆盖同名文件，得到一份完整导出。');
    this.name = 'ExportCancelledError';
    this.kept = kept;
  }
}

/** `out` 的判据（见文件头）。返回规范化后的绝对路径。 */
export function resolveOutDir(workspace: string, out?: string): string {
  const resolved = path.resolve(out ?? path.join(workspace, OUT_DIR_NAME));
  const learning = path.join(workspace, '.learning');
  if (isWithin(learning, resolved)) {
    throw new Error(`[EXPORT_OUT] 导出落点不能放进 .learning/ 里（那是学习数据）：${resolved}。`
      + `默认落点是 ${path.join(workspace, OUT_DIR_NAME)}，要换地方用 --out 指到工作区之外或工作区根之下。`);
  }
  if (resolved === path.resolve(workspace)) {
    throw new Error('[EXPORT_OUT] 导出落点不能就是工作区根：产物与学习数据会搅在一起'
      + `（规格 §5.1 已经退役「工作区根 index.html」那种摆法）。默认落点是 ${path.join(workspace, OUT_DIR_NAME)}。`);
  }
  return resolved;
}

/** 默认落盘口：只许写在 `out` 之下。路径判据是**这里**做的——它比工具的域声明更靠得住。 */
export function writeUnder(out: string, relPath: string, data: string | Buffer): string {
  const full = path.resolve(out, relPath);
  if (!isWithin(out, full) || full === out) {
    throw new Error(`[EXPORT_ESCAPE] 产物路径跑到导出目录外面了：${relPath}（导出目录 ${out}）`);
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  return full;
}

function progressLine(product: { path: string; role: string }, index: number, total: number): string {
  if (product.role === 'asset') return `拷贝配图 ${index + 1}/${total}`;
  if (product.role === 'vendor') return `搬第三方构建 ${product.path}`;
  if (product.path === 'index.html') return '写入口 index.html';
  if (product.role === 'manifest') return '写产物清单 export.json';
  return `写 ${product.path}`;
}

/**
 * 跑一次导出。**同步读盘 + 逐文件落盘**（工作区是纯文本、体量小，目标态规格 §12
 * 「按需扫描足够」），所以这里没有并发写，取消的粒度就是「一个文件」。
 */
export async function runExport(options: RunExportOptions): Promise<ExportOutcome> {
  const now = options.now ?? ((): Date => new Date());
  const workspace = path.resolve(options.workspace);
  const out = resolveOutDir(workspace, options.out);
  const write = options.writeFile ?? ((relPath: string, data: string | Buffer): void => {
    writeUnder(out, relPath, data);
  });

  options.progress?.('读工作区与阅读端本体');
  const react = options.react ?? resolveReact();
  const plan: ExportPlan = planExport({
    workspace,
    ...options.subjects === undefined ? {} : { subjects: options.subjects },
    ...options.clientFile === undefined ? {} : { clientFile: options.clientFile },
    react,
    now,
  });

  // 落点清单先全登记成「进行中」：取消回执于是能分清「已完成的」与「还没轮到 / 半成品」。
  const absolute = (relPath: string): string => path.join(out, relPath);
  for (const product of plan.products) options.onArtifact?.(absolute(product.path), '进行中');

  const files: string[] = [];
  const total = plan.products.length;
  for (const [index, product] of plan.products.entries()) {
    if (options.signal?.aborted) {
      throw new ExportCancelledError(files, out, options.signal.reason);
    }
    options.progress?.(progressLine(product, index, total), { done: index, total });
    const data = product.text === undefined
      ? fs.readFileSync(product.from as string)
      : product.text;
    write(product.path, data);
    files.push(product.path);
    options.onArtifact?.(absolute(product.path), '已完成');
  }

  const bytes = plan.products.reduce((sum, product) => sum + product.bytes, 0);
  return {
    out,
    files,
    subjects: plan.manifest.subjects,
    summary: plan.summary,
    bytes,
    react: { version: react.version, source: react.source },
    manifest: plan.manifest,
  };
}
