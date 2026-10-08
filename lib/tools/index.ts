/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— 唯一的注册点

   **两个入口，按层分**（#138）：

     · `registerStudyMateHost(ctx)`   —— **宿主层**，`bin/dsh-plugin.ts` 在 profile 根调它：
       导出的任务类型、任务域那条阅读端路由与销毁回执、实验域的任务类型与台账收尾、文件监听。
       这些是进程级的东西，跟着预设走会随卸载消失或被重复注册。
     · `registerStudyMateTools(ctx)`  —— **agent 层**，由「学习模式」预设那条插件行
       （`lib/tools/learning-preset.ts`）在**预设作用域**里调它：九个学习工具 + 五个任务工具
       + 一个实验工具。落在预设作用域里，别的预设看不见（#87 那条已知偏离的工具面部分）。

   `registerStudyMate(ctx)` 保留成「两层都挂」的兼容入口，既有测试与旧调用点不用改。

   各子系统各导出自己的 `registerXxx(ctx)`，往下面的清单里加一行就是加一个子系统——注册顺序、
   effect 归属、能力探测、域 guard 全在这条路径上，不用每个子系统自己记一遍。

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
import { registerTaskHost, registerTaskToolSpecs } from '../tasks/index.ts';
import { registerExportKind } from '../export/index.ts';

// 转出去给「往注册点加一行」的子系统与测试用：造工具、域词表、越权错误。
// （`registerStudyTool` 自己也在下面被用到，所以这里是 import + export 两件事。）
export { createAccess, DomainViolationError, matchesPattern } from '../host/access.ts';
export { defineStudyTool, registerStudyTool, UNAVAILABLE_SCHEMA } from './define.ts';
export { DOMAINS } from '../host/domains.ts';
export { probeModel } from './capability.ts';
export type { Domain } from '../host/domains.ts';
export type { DomainAccess, Declaration } from '../host/access.ts';
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
import { registerLabHost, registerLabToolSpecs } from '../lab/index.ts';
import { registerReachTools } from '../reach/index.ts';
import { LESSON_READ_TOOL_NAME } from './lesson-read.ts';

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
/** 导出的**宿主层**：任务类型「导出」的登记（#82）。 */
export function registerExportKindEntry(ctx: StudyPluginContext): void {
  // 任务类型在**插件加载时**就登记：重开 DSH 之后 resume 要靠它按名字找回跑法
  // （`lib/export/task.ts` 的文件头写了这条为什么不能偷懒到第一次导出时再登记）。
  // 它必须住在 profile 根：任务类型是进程级的，注册进预设作用域会在预设卸载时跟着注销。
  if (typeof ctx.effect === 'function') ctx.effect(() => registerExportKind(), 'studymate: 导出任务类型（卸载时注销）');
  else registerExportKind();
}

/** 导出工具（agent 层）：注册进**当前作用域**。 */
export function registerExportTool(ctx: StudyPluginContext): void {
  registerStudyTool(ctx, exportTool());
}

/** 兼容入口：宿主层 + 工具一次挂完。 */
export function registerExportTools(ctx: StudyPluginContext): void {
  registerExportKindEntry(ctx);
  registerExportTool(ctx);
}

/* ── 九个工具的名字（注册表与测试共用一份，别在两处各写一遍） ─────────────
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
  // #125：核验「资源清单」里的链接。它排在最后，注册清单里也跟着排在 `registerExportTools`
  // 之后（顺序是断言的一部分：`test_tools_guard.mjs` 按这张表逐位对注册结果）。
  'studymate_verify_sources',
] as const;

/* ── 答疑面那一个只读工具的名字表（#104）────────────────────────────────────
   与上面的学习面**并列、不混**：`studymate_lesson_read`（`./lesson-read.ts`）由答疑预设那条
   插件行（`./qa-preset.ts`）注册进它**自己的作用域**，不在 `registerStudyMate` 的注册面上，
   所以学习会话的工具面里没有它（`STUDY_TOOL_NAMES` 仍是九条）。

   为什么要单独一张表：技能正文里反引号点名的 `studymate_*` 必须能在代码里找到出处
   （`scripts/tests/test_skill_contracts.mjs` 守这条），而那个判据认的是**两张表的并集**——
   `local-qa` 那条链上的工具属于这一张。别为了省一张表把它塞进上面那九条。 */
export const QA_TOOL_NAMES = [LESSON_READ_TOOL_NAME] as const;

/**
 * **agent 层**：把一个 StudyMate 插件的全部原生工具注册到**当前作用域**。
 *
 * 九个学习工具 + 五个 `studymate_task_*` + 一个 `studymate_lab_run`。这条路径由「学习模式」
 * 预设那条插件行（`lib/tools/learning-preset.ts`）调用，所以它们落在**预设作用域**里——
 * 别的预设（含宿主内置的 standard）看不见它们（#138；#87 那条已知偏离的工具面部分就此收口）。
 *
 * 这里再判一次 `ctx.tools` 是为了让「直接调它的测试」也拿到同一句可读的报错，而不是 TypeError。
 */
export function registerStudyMateTools(ctx: StudyPluginContext): void {
  if (typeof ctx.tools?.register !== 'function') {
    throw new Error('当前宿主没有 ctx.tools：StudyMate 的原生工具注册不了'
      + '（需要带 tools 服务的 0.1.7-alpha.1+ 组合）');
  }
  // ↓↓↓ #69 / #70 / #73 / #74 往这里各加一行（各子系统在自己的目录里导出 registerXxx） ↓↓↓
  registerContextTools(ctx);
  registerValidatorTools(ctx);
  registerRewriteTools(ctx);
  registerExportTool(ctx);
  // #125 核验域：studymate_verify_sources 把「资源清单」里的链接探一遍（并发取、先定路由表、
  // 结果留缓存，再核只补增量）。同一个姿势：注册点把造工具能力递进去，核验域不 import 工具域。
  registerReachTools(ctx, { registerStudyTool });
  // #73 任务模型：五个 studymate_task_* 工具（阅读端那条进度路由是宿主层，见下面）。
  // 任务域不 import 工具域，所以把「造工具」这件事当参数递进去——域图上只有 tools → tasks
  // 一条边。别的子系统照这个姿势加：自己的目录里导出 registerXxx(ctx)。
  registerTaskToolSpecs(ctx, { registerStudyTool });
  // #77 判分三轨的第三轨：studymate_lab_run 把交付物题里声明的命令在 lab 目录里代跑一遍，
  // 真实输出原样进作答数据（长命令走上面那套任务模型）。同一个姿势：注册点注入造工具能力。
  registerLabToolSpecs(ctx, { registerStudyTool });
  // ↑↑↑ 加完为止：不要动 bin/dsh-plugin.ts，也不要在这里写具体工具 ↑↑↑
}

/**
 * **宿主层**：注册进插件所在的 **profile 根**——这些不是「某个会话的工具面」，是进程级的东西。
 *
 * 四件：导出的任务类型、任务域那条阅读端路由与销毁回执、实验域的任务类型与台账收尾、
 * 文件监听（工作区一变就往通知总线上发一条；推给打开的页面由 `bin/dsh-plugin.ts` 那条 SSE
 * 路由负责）。它们要是跟着预设走，会随预设卸载而消失，或者被每条预设重复注册。
 */
export function registerStudyMateHost(ctx: StudyPluginContext): void {
  registerExportKindEntry(ctx);
  registerTaskHost(ctx);
  registerWatch(ctx);
  registerLabHost(ctx);
}

/**
 * 兼容入口：宿主层 + agent 层一次挂完（既有测试与旧调用点用）。
 *
 * 注册顺序是断言的一部分（`test_tools_guard.mjs` 按名字表逐位对注册结果）：宿主层不注册任何
 * 工具，所以工具顺序仍是「九个学习工具 → 五个任务工具 → 一个实验工具」。
 */
export function registerStudyMate(ctx: StudyPluginContext): void {
  registerStudyMateHost(ctx);
  registerStudyMateTools(ctx);
}
