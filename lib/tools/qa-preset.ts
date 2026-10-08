/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— 「答疑模式」预设的那条工具面行（#104）

   它做一件事：把只读的取课件工具 `studymate_lesson_read`（`./lesson-read.ts`）注册进**本预设
   作用域**——给节点 id 拿回那一课正文与这一节点的题。

   这条会话的工具面为什么干净（#104 的验收「工具面上只有只读的取课件工具」）：

     · `preset/qa/agent.cordis.yml` 只列四行——persona、技能目录（只含 `local-qa`）、技能加载器、
       这一行。bash / 文件读写 / 子 agent / web / todo 那些**根本没列**，删行才是配置层的保证；
     · StudyMate 的原生工具自 #138 起注册在**「学习模式」预设作用域**里
       （`./learning-preset.ts`），不在 profile 根上——答疑会话继承不到它们。

   所以这里**不再需要** `ctx.tools.restrict({ deny })`：#104 当年那份 15 个名字的 deny 名单，
   就是用来抹掉 profile 根上那一批的补丁；那批搬进预设之后，补丁可以拆了（名单与它的出处见
   `docs/规范/工程约束.md` §二 的沿革）。
   ───────────────────────────────────────────────────────────────────────── */

import { registerStudyTool } from './define.ts';
import { lessonReadTool } from './lesson-read.ts';
import type { ServiceReader } from './capability.ts';

/** 预设行插件在 agent 作用域里跑（`agentPresets.mount(agentCtx, id)`），所以 tools 服务在。 */
export const inject = ['tools'];

/** `ctx.inject(['tools'], …)` 给的那层上下文：这条行只用得到这两个成员。 */
export interface QaPresetContext extends ServiceReader {
  tools?: { register?: (definition: unknown) => unknown };
  effect?: (fn: () => unknown, description?: string) => unknown;
}

export function apply(ctx: QaPresetContext): void {
  registerStudyTool(ctx, lessonReadTool());
}
