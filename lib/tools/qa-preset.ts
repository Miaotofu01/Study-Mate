/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— 「答疑模式」预设的那条工具面行（#104）

   它做两件事，合起来才是「只答疑」的配置层保证（不是提示词层的祈祷）：

     1. **只读工具注册进本作用域**：`studymate_lesson_read`（`./lesson-read.ts`）——
        给节点 id 拿回那一课正文与这一节点的题。作用域自己注册的工具**不受 restrict 影响**
        （`dsh-tools/lib/index.js:2959-2985` 的 `view(scope)`：`own` 那层无条件可见）。
     2. **把 profile 根注册的原生工具从这条预设的工具面上抹掉**：
        `ctx.tools.restrict({ deny: [...] })`。

   为什么非 `deny` 不可（`/tmp/studymate-explore/host.md` Q5 的结论，源码在
   `dsh-tools/lib/index.js:2895-2910` 与设计注释 `:2944-2955`）：restriction 过滤的是
   **这个 scope 继承来的层**——全局层 + 链上每个祖先层。预设行注册的工具落在预设层，
   对 agent 而言预设层是**祖先**，所以 `allow: []` 或者 `allow: [只读工具名]` 会把预设自己
   那层的 `skill` 与 `studymate_lesson_read` 一起剪掉（而且 `allow` 里写预设自己那层的名字
   会被校验判成 unknown 直接抛）。`deny` 只点名全局层的名字，只读工具与 `skill` 都不受影响。

   为什么 deny 的是「全部 14 个」而不是只有八个：`registerStudyMate` 在 profile 根注册的
   八个学习工具之外还有五个 `studymate_task_*` 与一个 `studymate_lab_run`（三份名字表各自的
   出处见下）。它们同样是 profile 根的工具，留下的活等于一个能写作答台账、能代跑命令的后门——
   「工具面上只有只读的取课件工具」是 #104 的验收，所以按三份名字表全量收窄。

   名字表从各自目录 import（`lib/tools/index.ts` 的 `STUDY_TOOL_NAMES`、`../tasks/index.ts`
   的 `TASK_TOOL_NAMES`、`../lab/index.ts` 的 `LAB_TOOL_NAMES`）——不在这里手抄第二份。

   失败面：`restrict` 只认「此刻已挂在 scope 链上的名字」，某个名字不在册（那个子系统注册失败、
   或旧宿主）会**整条抛**。那时先退到八个学习工具再试一次，仍不行就如实警告——不静默、
   也不改成 `allow`（那会把只读工具剪掉）。
   ───────────────────────────────────────────────────────────────────────── */

import { registerStudyTool } from './define.ts';
import { lessonReadTool } from './lesson-read.ts';
import { STUDY_TOOL_NAMES } from './index.ts';
import { TASK_TOOL_NAMES } from '../tasks/index.ts';
import { LAB_TOOL_NAMES } from '../lab/index.ts';
import type { ServiceReader } from './capability.ts';

/** 预设行插件在 agent 作用域里跑（`agentPresets.mount(agentCtx, id)`），所以 tools 服务在。 */
export const inject = ['tools'];

/** `ctx.inject(['tools'], …)` 给的那层上下文：这条行只用得到这两个成员。 */
export interface QaPresetContext extends ServiceReader {
  tools?: {
    register?: (definition: unknown) => unknown;
    restrict?: (filter: { allow?: readonly string[]; deny?: readonly string[] }) => unknown;
  };
  effect?: (fn: () => unknown, description?: string) => unknown;
}

/** 答疑会话的工具面上不许出现的名字：StudyMate 在 profile 根注册的全部原生工具。 */
export const QA_DENIED_TOOL_NAMES: readonly string[] = [
  ...STUDY_TOOL_NAMES,
  ...TASK_TOOL_NAMES,
  ...LAB_TOOL_NAMES,
];

export function apply(ctx: QaPresetContext): void {
  // 1) 只读工具进**本作用域**：自己的那层不受下面那条 restriction 影响
  registerStudyTool(ctx, lessonReadTool());

  // 2) 抹掉 profile 根那一批。
  // 调法上别把它摘出来存成变量：宿主的服务访问是一层 Proxy（`cordis` 的 `createTraceable`），
  // `restrict` 用 `this.ctx` 决定 restriction 落在**哪一层的 scope** 上，而那个 `.ctx`
  // 正是「谁访问了这个服务」——写成 `ctx.tools.restrict(...)` 才把这条行的作用域带进去
  // （`createShadowMethod` 对「函数被摘出来再调」也补了一层 shadow，但那条路多一个前提，
  // 没必要踩）。这也是这条行必须住在一个**预设行**里的原因。
  if (typeof ctx.tools?.restrict !== 'function') {
    console.warn('StudyMate 答疑模式：这条宿主没有 ctx.tools.restrict，原生工具的收窄没做上——'
      + '答疑照常，只是模型还看得见总控那批工具。');
    return;
  }
  try {
    ctx.tools.restrict({ deny: [...QA_DENIED_TOOL_NAMES] });
  } catch (error) {
    try {
      ctx.tools.restrict({ deny: [...STUDY_TOOL_NAMES] });
      console.warn('StudyMate 答疑模式：任务与实验那批原生工具没在注册名册里，只收掉了八个学习工具。'
        + `${error instanceof Error ? error.message : String(error)}`);
    } catch (retryError) {
      console.warn('StudyMate 答疑模式：原生工具的收窄没做上（restrict 报错），'
        + `模型还看得见总控那批工具。${retryError instanceof Error ? retryError.message : String(retryError)}`);
    }
  }
}
