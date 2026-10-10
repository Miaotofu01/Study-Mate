/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 任务域 —— 目录出口（#68 留的注册点往这里伸手）

   注册点（`lib/tools/index.ts` 的 `registerStudyMate`）只加一行：

     registerTaskTools(ctx, { registerStudyTool });

   一行两件事：注册五个 `studymate_task_*` 原生工具 + `GET /api/studymate/tasks`
   （阅读端画进度条）。**任务域不 import 工具域**——`registerStudyTool` 是注册点注入进来的，
   这样域图上只有「工具域 → 任务域」一条边，不会成环（见 tools.ts 文件头）。

   进程里只有**一份**台账（`taskService()`）：工具、路由、产出方（#82 的导出）必须看同一份，
   否则会出现「起了任务但查不到」。产出方这样接：

     import { taskService, defineTaskKind } from '../tasks/index.ts';
     taskService().registerKind(defineTaskKind({ kind: '导出', prefix: 'export', run }));
     const handle = taskService().start(agentId, { kind: '导出', label: '导出 demo', durable: true });
   ───────────────────────────────────────────────────────────────────────── */

import { createTaskService } from './service.ts';
import type { TaskService } from './service.ts';
import { registerTaskRoute } from './route.ts';
import { taskToolSpecs } from './tools.ts';
import type { TaskToolContext, TaskToolRegistry } from './tools.ts';

export { createTaskService, defineTaskKind, DEFAULT_MAX_CONCURRENT, DEFAULT_WAIT_MS, MAX_WAIT_MS } from './service.ts';
export { TASK_STATUSES, TERMINAL_STATUSES, LIVE_STATUSES, isTerminal, isTaskStatus, canTransition } from './state.ts';
export { UNOWNED, TaskAccessError, TaskNotFoundError, TaskWaitAbortedError, toView, toBoardView } from './record.ts';
export { taskBoard, TASKS_PATH, registerTaskRoute } from './route.ts';
export { actorOf, taskToolSpecs, TASK_VIEW_SCHEMA } from './tools.ts';
export { taskFile, tasksDir } from './store.ts';
export type { TaskKind, TaskKindSpec, TaskJob, TaskOutcome, TaskService, WaitResult, CancelReceipt, DestroyReceipt, TeardownReceipt } from './service.ts';
export type { TaskStatus } from './state.ts';
export type { TaskBoardEntry, TaskHandle, TaskReceipt, TaskRecord, TaskView, JsonValue } from './record.ts';
export type { TaskToolContext, TaskToolRegistry, TaskToolSpec, TaskRunLike } from './tools.ts';

/** 五个工具的名字（注册表与测试共用一份，别在两处各写一遍）。 */
export const TASK_TOOL_NAMES = [
  'studymate_task_status',
  'studymate_task_wait',
  'studymate_task_cancel',
  'studymate_task_destroy',
  'studymate_task_resume',
] as const;

let singleton: TaskService | undefined;

/**
 * 进程里唯一的那一份台账。**惰性创建**：注册点调一次就够，谁先来谁建。
 * 目录按 `DSH_HOME` 现算（`store.ts`），所以测试把 HOME 指到临时目录时不会串。
 */
export function taskService(): TaskService {
  if (!singleton) singleton = createTaskService();
  return singleton;
}

/** 丢掉单例（测试用；换 `DSH_HOME` 之后要重新读盘就得先丢）。 */
export function resetTaskService(): void {
  singleton = undefined;
}

/**
 * 五个工具注册进**当前作用域**（agent 层）。注册面收进预设时用这一支：工具落在预设作用域，
 * profile 根上不留它们（见 `lib/tools/index.ts` 的两层分工）。
 *
 * 为什么要 registry 这个参数：`registerStudyTool` 在工具域里，任务域不能 import 它
 * （域图成环，见 tools.ts 文件头）。注册点把它当参数递进来，任务域就只依赖 `node:*` 与
 * `lib/core` 这一侧的规矩不被破。
 */
export function registerTaskToolSpecs(ctx: TaskToolContext, registry: TaskToolRegistry): void {
  const service = taskService();
  for (const spec of taskToolSpecs(service)) registry.registerStudyTool(ctx, spec);
}

/**
 * 任务域的**宿主层**：一条阅读端路由（`GET /api/studymate/tasks`）与一条卸载时的销毁回执。
 *
 * 它必须住在 profile 根：路由是给阅读端画的进度条，注册进预设作用域会在每条预设挂载时
 * 重复注册（同一个 path 第二次注册直接抛），而且预设卸载时路由会跟着没。
 */
export function registerTaskHost(ctx: TaskToolContext): void {
  const service = taskService();
  registerTaskRoute(ctx, service);
  // 卸载时给一次「销毁回执」：请求取消活任务、把 durable 记录刷到盘上；落盘记录与已完成产物
  // 一律**不删**（重开 DSH 要接得上）。回执走不了任何人的手里，所以它同时记进 problems()。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      service.dispose();
    }, 'studymate: 任务服务（销毁回执）');
  }
}

/** 兼容入口：工具 + 宿主层一次挂完（既有测试与旧调用点用）。 */
export function registerTaskTools(ctx: TaskToolContext, registry: TaskToolRegistry): void {
  registerTaskToolSpecs(ctx, registry);
  registerTaskHost(ctx);
}
