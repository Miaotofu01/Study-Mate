/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 实验域 —— 目录出口（判分三轨的第三轨，issue #77）

   注册点（`lib/tools/index.ts` 的 `registerStudyMate`）只加一行：

     registerLabTools(ctx, { registerStudyTool });

   一行做三件事：登记任务类型「实验代跑」（长命令走 #73 的任务模型，可查状态、可取消）、
   注册一个原生工具 `studymate_lab_run`、给台账挂一个收尾副作用。

   域内的分工：

     · `contract.ts` —— 命令的文法（从题目的 `证据` 字段来，空白切词、绝不开 shell）
     · `sandbox.ts`  —— 边界（cwd / 可写范围 / 参数里的路径都在 lab 目录与工作区之内）
     · `runner.ts`  —— 唯一 `spawn` 的地方（不开 shell、有超时、有输出上限、只回事实）
     · `ledger.ts`  —— 跑过的事实（内存 + 落盘，供状态查询与作答数据回填）
     · `tools.ts`   —— 取值顺序、拒绝、起任务、写作答数据

   实验域**不 import 工具域**：`registerStudyTool` 由注册点当参数递进来，所以域图上只有
   「工具域 → 实验域」一条边（见 `lib/tasks/index.ts` 文件头的同一口径）。
   ───────────────────────────────────────────────────────────────────────── */

export { registerLabTools, LAB_TOOL_NAMES, LAB_RUN_OUTPUT_SCHEMA, LAB_RUN_PARAMETERS, labRunTool, readDeliverable, splitQuestionId, poolOf, runLabJob, ensureLabTaskKind, resetLabTaskKind, LAB_TASK_KIND, LAB_TASK_PREFIX, RUN_KEY, DEFAULT_INLINE_WAIT_MS, MAX_INLINE_WAIT_MS, inlineWaitMs } from './tools.ts';
export { parseCommand } from './contract.ts';
export { isWithin, resolveArgumentPath, resolveCwd, resolveWritable } from './sandbox.ts';
export { runCommand, resolveProgram, TIMEOUT_MS, OUTPUT_LIMIT } from './runner.ts';
export { createRunLedger, runLedger, resetRunLedger, labRunsDir } from './ledger.ts';
export type { RunFacts } from './runner.ts';
export type { RunEntry, RunLedger } from './ledger.ts';
export type { LabRunOutcome, LabToolSpec, DeliverableQuestion, StatementProblem } from './tools.ts';
export type { CommandVerdict } from './contract.ts';
export type { PathVerdict } from './sandbox.ts';
