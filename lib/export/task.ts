/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 导出域 —— 任务类型「导出」（接 #73 的任务模型）

   为什么导出必须走任务模型（目标态规格 §3.2）：一次导出要读整份工作区、搬几百 KB 到几 MB 的
   第三方构建与配图，这是**插件自己执行的后台工作**——学生该看得见进度、能取消、重开 DSH 还
   接得上。所以它登记成一种任务类型（`导出` / 前缀 `export`），而不是一个同步函数调用。

   落盘（`durable: true`）由**起任务的那一方**打（工具侧），这里只提供跑法：任务服务按类型名
   找回 `run`，所以「重开 DSH 之后还能 resume」的前提是**插件加载时就把这个类型登记好**——
   登记落在 `registerExportKind()`，由工具域在注册点调用（不是第一次导出时才登记）。

   入参是纯 JSON（`{workspace, subjects?, out?}`）：resume 要按同一份重跑，函数进不了入参。
   落盘口因此不由入参携带——导出域自己在 `runExport` 里写（容器判据在 `run.ts` 的
   `writeUnder`），工具的 `writes: { export: [...] }` 声明是同一份产物布局的对外声明。
   ───────────────────────────────────────────────────────────────────────── */

import { defineTaskKind, taskService } from '../tasks/index.ts';
import type { JsonValue, TaskJob, TaskKindSpec } from '../tasks/index.ts';

import { runExport } from './run.ts';
import type { ExportOutcome } from './run.ts';

/** 任务类型名（给人看的中文）与 id 前缀（`export-1`）。 */
export const EXPORT_KIND = '导出';
export const EXPORT_PREFIX = 'export';

/** 起任务时带进任务记录的入参（纯 JSON；resume 会拿同一份重跑）。 */
export interface ExportTaskInput {
  workspace: string;
  /** 只要这几门科目（slug）；省略 = 全部。 */
  subjects?: string[];
  /** 落点；省略 = `<工作区>/export/`。 */
  out?: string;
}

export class ExportInputError extends Error {
  readonly code = 'EXPORT_BAD_INPUT';
  constructor(message: string) {
    super(`[EXPORT_BAD_INPUT] ${message}`);
    this.name = 'ExportInputError';
  }
}

/** 从任务记录里读回来的入参：坏形状当场说清，别让产出方跑一半才发现。 */
export function parseExportInput(input: unknown): ExportTaskInput {
  if (!input || typeof input !== 'object') {
    throw new ExportInputError('导出任务要一个 { workspace, subjects?, out? } 的对象入参');
  }
  const record = input as Record<string, unknown>;
  const workspace = record.workspace;
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new ExportInputError('导出任务缺 workspace：导出要知道读哪个学习工作区');
  }
  const subjects = Array.isArray(record.subjects)
    ? record.subjects.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    : undefined;
  const out = typeof record.out === 'string' && record.out.trim() !== '' ? record.out : undefined;
  return {
    workspace,
    ...subjects === undefined || subjects.length === 0 ? {} : { subjects },
    ...out === undefined ? {} : { out },
  };
}

/** 任务结果（进任务记录，工具与阅读端都读得到）。 */
export interface ExportTaskResult {
  out: string;
  files: string[];
  count: number;
  bytes: number;
  subjects: { slug: string; name: string; nodes: number; assets: number }[];
  react: { version: string; source: string };
}

/** 跑法本身：任务句柄的进度 / 产物 / 取消信号原样接进 `runExport`。 */
export function defineExportKind(): TaskKindSpec {
  return defineTaskKind({
    kind: EXPORT_KIND,
    prefix: EXPORT_PREFIX,
    run: async (job: TaskJob, input: unknown) => {
      const task = parseExportInput(input);
      const outcome: ExportOutcome = await runExport({
        workspace: task.workspace,
        ...task.subjects === undefined ? {} : { subjects: task.subjects },
        ...task.out === undefined ? {} : { out: task.out },
        signal: job.signal,
        progress: (line, steps) => job.progress(line, steps),
        // 句柄只认字符串路径：产物用绝对路径登记，取消回执里那一串学生能直接照着找
        onArtifact: (path, state) => job.artifact(path, state),
      });
      const result: ExportTaskResult = {
        out: outcome.out,
        files: outcome.files,
        count: outcome.files.length,
        bytes: outcome.bytes,
        subjects: outcome.subjects,
        react: outcome.react,
      };
      return { detail: outcome.summary, result: result as unknown as JsonValue };
    },
  });
}

/**
 * 登记「导出」这一种任务类型。返回注销句柄（插件卸载时用）。
 *
 * 重复登记会被任务服务的 `kinds` 覆盖成同一份（同一个 run），所以它是幂等的。
 */
export function registerExportKind(): () => void {
  return taskService().registerKind(defineExportKind());
}
