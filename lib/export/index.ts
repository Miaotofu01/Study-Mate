/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 导出域 —— 目录出口

   这个域只做一件事：把学习工作区**渲染成能离线打开的自包含页面**（目标态规格 §8）。
   它**不是**第二个渲染器——搬的是阅读端本体（`lib/client.js` 逐字）加一个最小宿主，
   理由写在 `page.ts` 的文件头。

   谁来调：
     · DSH 侧：`lib/tools/export.ts` 的 `studymate_export` 起一个「导出」任务（#73 的模型），
       只在学生说「导出一份能离线看的」时才跑——**不主动导出**；
     · 无头侧（Antigravity / Codex）：`bin/studymate.mjs export` → `exportCommand()`，
       课完默认导一份（没有参数也能跑）。

   域图**只能有一条边进来**：工具域 → 导出域（工具注册点上那一行）。导出域不 import 工具域
   ——那会成环（架构边界测试会拦），所以落盘口由导出域自己带容器判据（`run.ts` 的 `writeUnder`），
   工具的 `writes` 声明是同一份产物布局的对外说法。
   ───────────────────────────────────────────────────────────────────────── */

export {
  OUT_DIR_NAME, ENTRY_FILE, DATA_FILE, HOST_FILE, BOOT_FILE, CLIENT_FILE, MANIFEST_FILE,
  ASSETS_DIR, VENDOR_DIR, ASSET_ENDPOINT, LIBRARY_ENDPOINT, REFERENCE_ENDPOINT,
  ATTEMPTS_ENDPOINT, EVENTS_ENDPOINT,
  assetProductPath, splitVendor, vendorFile,
} from './page.ts';
export type { VendorKey } from './page.ts';

export { planExport, clientSourceFile, textProducts, MANIFEST_FORMAT, ExportPlanError } from './plan.ts';
export type { ExportManifest, ExportPlan, ExportProduct, ManifestSubject, ProductRole } from './plan.ts';

export { runExport, resolveOutDir, writeUnder, ExportCancelledError } from './run.ts';
export type { ExportOutcome, RunExportOptions } from './run.ts';

export { resolveReact, reactCandidates, ReactMissingError } from './react.ts';
export type { ReactSources } from './react.ts';

export { checkExport, scanLeaks, readExportDir, LEAK_RULES } from './guard.ts';
export type { GuardFile, GuardReport, LeakViolation } from './guard.ts';

export { registerExportKind, defineExportKind, parseExportInput, EXPORT_KIND, EXPORT_PREFIX, ExportInputError } from './task.ts';
export type { ExportTaskInput, ExportTaskResult } from './task.ts';

export { exportCommand, locateWorkspace, WorkspaceMissingError } from './cli.ts';
export type { ExportCliOptions } from './cli.ts';
