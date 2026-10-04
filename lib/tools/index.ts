/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— 唯一的注册点

   `bin/dsh-plugin.ts` 里**只调这一个函数**：`registerStudyMate(ctx)`。各子系统各导出自己的
   `registerXxx(ctx)`，往下面的清单里加一行就是加一个子系统——注册顺序、effect 归属、
   能力探测、域 guard 全在这条路径上，不用每个子系统自己记一遍。

   #69 / #70 / #73 / #74 会各往这里加一行（架构边界测试、数据模型、界面、导出正式落地）：
     1. 在自己的目录里（`lib/<域>/`）导出 `registerXxx(ctx)`；
     2. 把 `import` 与那一行加进下面的清单；
     3. **不要**改 `bin/dsh-plugin.ts`。那个文件里的 `ctx.inject(['tools'], …)` 已经
        把「没有 tools 的组合」处理干净了（缺服务就不注册，插件其余部分照常 apply）。

   为什么每个 registerXxx 自己开 `ctx.effect`（而不是在这里统一包一层）：注册是**有主的**
   副作用（`dsh-plugin-api.md` §2.10），子系统卸载时各自拆自己的；包一层会让「谁注册的」
   与「谁拆的」分家。
   ───────────────────────────────────────────────────────────────────────── */

import { registerStudyTool } from './define.ts';
import { registerTaskTools } from '../tasks/index.ts';
import { registerExportKind } from '../export/index.ts';

// 转出去给「往注册点加一行」的子系统与测试用：造工具、域词表、越权错误。
// （`registerStudyTool` 自己也在下面被用到，所以这里是 import + export 两件事。）
export { createAccess, DomainViolationError, matchesPattern } from './access.ts';
export { defineStudyTool, registerStudyTool, UNAVAILABLE_SCHEMA } from './define.ts';
export { DOMAINS } from './domains.ts';
export { probeModel } from './capability.ts';
export type { Domain } from './domains.ts';
export type { DomainAccess, Declaration } from './access.ts';
export type { StudyToolSpec, StudyRun, StudyDeclaration } from './define.ts';
export type { ModelCapability, Requirement, ServiceReader } from './capability.ts';
import type { ServiceReader } from './capability.ts';
import { workspaceContextTool } from './context.ts';
import {
  validateCurriculumTool, validateHandoffTool, validateLessonTool, validatePoolTool,
} from './validate.ts';
import { applyEmptyReasonsTool, renumberLessonsTool } from './rewrite.ts';
import { exportTool } from './export.ts';
import { registerWatch } from '../watch/index.ts';
import { registerLabTools } from '../lab/index.ts';

/** `ctx.inject(['tools'], …)` 给的那层上下文：只用得到这几个成员。 */
export interface StudyPluginContext extends ServiceReader {
  tools?: { register?: (definition: unknown) => unknown };
  effect?: (fn: () => unknown, description?: string) => unknown;
}

/* ── 各子系统的注册函数 ────────────────────────────────────────────────── */

/** 工作区摘要（总控开场那一次调用）。 */
export function registerContextTools(ctx: StudyPluginContext): void {
  registerStudyTool(ctx, workspaceContextTool(ctx));
}

/** 四个校验器：数据层、内容层、图片库、交接门禁。 */
export function registerValidatorTools(ctx: StudyPluginContext): void {
  registerStudyTool(ctx, validateCurriculumTool());
  registerStudyTool(ctx, validateLessonTool());
  registerStudyTool(ctx, validatePoolTool());
  registerStudyTool(ctx, validateHandoffTool());
}

/** 两个改写工具：位次重排、无题理由。 */
export function registerRewriteTools(ctx: StudyPluginContext): void {
  registerStudyTool(ctx, renumberLessonsTool());
  registerStudyTool(ctx, applyEmptyReasonsTool());
}

/** 导出：一个原生工具 + 一种任务类型（「导出」，#82 落地）。 */
export function registerExportTools(ctx: StudyPluginContext): void {
  // 任务类型在**插件加载时**就登记：重开 DSH 之后 resume 要靠它按名字找回跑法
  // （`lib/export/task.ts` 的文件头写了这条为什么不能偷懒到第一次导出时再登记）。
  if (typeof ctx.effect === 'function') ctx.effect(() => registerExportKind(), 'studymate: 导出任务类型（卸载时注销）');
  else registerExportKind();
  registerStudyTool(ctx, exportTool());
}

/* ── 八个工具的名字（注册表与测试共用一份，别在两处各写一遍） ─────────────
   名字的**形态**是刻意的：用下划线不用点号（`decisions.md` §3）。工具名会原样进模型 API 的
   `tools[].name`，而 OpenAI 兼容接口（含 DeepSeek）只接受 `^[a-zA-Z0-9_-]+$`；DSH 自己不校验，
   所以点号会在**真实会话**里炸、不在门禁里炸。目标态规格 §3.1 写的 `studymate.workspace.context`
   是待落地的提案名，按 §3 改成了 `studymate_workspace_context`——这是一处**记在案的偏差**。 */

export const STUDY_TOOL_NAMES = [
  'studymate_workspace_context',
  'studymate_validate_curriculum',
  'studymate_validate_lesson',
  'studymate_validate_pool',
  'studymate_validate_handoff',
  'studymate_renumber_lessons',
  'studymate_apply_empty_reasons',
  'studymate_export',
] as const;

/**
 * 把一个 StudyMate 插件的全部原生工具注册到当前上下文。
 *
 * 调用方（`bin/dsh-plugin.ts`）只在 **tools 服务就绪**时调它；这里再判一次是为了让
 * 「直接调 registerStudyMate 的测试」也拿到同一句可读的报错，而不是 TypeError。
 */
export function registerStudyMate(ctx: StudyPluginContext): void {
  if (typeof ctx.tools?.register !== 'function') {
    throw new Error('当前宿主没有 ctx.tools：StudyMate 的原生工具注册不了'
      + '（需要带 tools 服务的 0.1.7-alpha.1+ 组合）');
  }
  // ↓↓↓ #69 / #70 / #73 / #74 往这里各加一行（各子系统在自己的目录里导出 registerXxx） ↓↓↓
  registerContextTools(ctx);
  registerValidatorTools(ctx);
  registerRewriteTools(ctx);
  registerExportTools(ctx);
  // #73 任务模型：五个 studymate_task_* 工具 + 阅读端进度路由（GET /api/studymate/tasks）。
  // 任务域不 import 工具域，所以把「造工具」这件事当参数递进去——域图上只有 tools → tasks
  // 一条边。别的子系统照这个姿势加：自己的目录里导出 registerXxx(ctx)。
  registerTaskTools(ctx, { registerStudyTool });
  // #74 文件监听：学习工作区一变就往通知总线上发一条（推给打开的页面由 bin/dsh-plugin.ts
  // 那一行挂的 SSE 路由负责；没有页面在听时，监听本身也不做别的事）。
  registerWatch(ctx);
  // #77 判分三轨的第三轨：studymate_lab_run 把交付物题里声明的命令在 lab 目录里代跑一遍，
  // 真实输出原样进作答数据（长命令走上面那套任务模型）。同一个姿势：注册点注入造工具能力。
  registerLabTools(ctx, { registerStudyTool });
  // ↑↑↑ 加完为止：不要动 bin/dsh-plugin.ts，也不要在这里写具体工具 ↑↑↑
}
