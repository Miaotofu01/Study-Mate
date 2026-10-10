/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— 「学习模式」预设的那条工具面行（#138）

   它只做一件事：把全部原生工具注册进**本预设作用域**。

   为什么要这一行：工具的注册面原来在插件所在的 profile 根上，同一个 profile 里任何会话
   （含宿主内置的 `standard` 预设）都看得见它们——`docs/规范/工程约束.md` §二 把这条记成
   #87 的已知偏离。宿主没有「按预设注册工具」的接口，能收窄的只有预设自己那条插件行：它跑在
   agent 作用域里（`agentPresets.mount(agentCtx, id)`），在这里注册的工具就只属于这条预设的会话。

   与 `qa-preset.ts` 的分工：那一条是答疑面（只读的取课件工具），这一条是学习面。两条都住
   预设作用域，谁也不继承对方的东西。

   **宿主层的东西不在这里**：导出的任务类型、任务域那条阅读端路由、实验域的任务类型与台账、
   文件监听都由 `bin/dsh-plugin.ts` 在 profile 根挂（`registerStudyMateHost`）——它们跟着预设
   走会随卸载消失，或者被每条预设重复注册。
   ───────────────────────────────────────────────────────────────────────── */

import { registerStudyMateTools } from './index.ts';
import type { StudyPluginContext } from './index.ts';

/** 预设行插件在 agent 作用域里跑（`agentPresets.mount(agentCtx, id)`），所以 tools 服务在。 */
export const inject = ['tools'];

export function apply(ctx: StudyPluginContext): void {
  registerStudyMateTools(ctx);
}
