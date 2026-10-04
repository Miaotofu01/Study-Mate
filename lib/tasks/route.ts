/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 任务域 —— 阅读端要的那条路由（画进度条用）

   `GET /api/studymate/tasks` → `{ at, tasks: [TaskBoardEntry…] }`

   为什么走 `connection.fetch.register`（与 `bin/dsh-plugin.ts` 里那三条同一条路）：
   注册在 `/api` 之下的精确路由**自动**获得宿主那一层的 Host/Origin 检查与浏览器会话认证
   （`dsh-plugin-api.md` §6.3），不用自己写鉴权。

   为什么用 `ctx.inject(['connection'], …)` 而不是顶层 `inject: ['connection']`：与
   `bin/dsh-plugin.ts` 顶部的口径逐字相同——没有 connection 的组合（headless / tui）里不该
   整个插件都不 apply；缺服务就不挂路由。`ctx.inject` 不存在时也不炸。

   这条路由是**只读**的，而且返回的投影**没有 owner**（`toBoardView` 摘掉了）：进度条不需要
   知道任务是谁起的，摘掉就不存在「从板子上抄一个 owner 去伪造句柄」这条缝。取消 / 销毁这类
   会改状态的动作一律不做成 HTTP 路由——它们要调用方的身份，只有工具那条路有。
   ───────────────────────────────────────────────────────────────────────── */

import { toBoardView } from './record.ts';
import type { TaskService } from './service.ts';
import type { TaskToolContext } from './tools.ts';

/** 与 `bin/dsh-plugin.ts` 里三条路由同一个命名空间（`/api/studymate/…`）。 */
export const TASKS_PATH = '/api/studymate/tasks';

export interface TaskBoard {
  at: string;
  tasks: ReturnType<typeof toBoardView>[];
}

/** 阅读端拿到的那份数据（抽出来是为了让它能被单测直接断言）。 */
export function taskBoard(service: TaskService, at: Date = new Date()): TaskBoard {
  return { at: at.toISOString(), tasks: service.board() };
}

export function registerTaskRoute(ctx: TaskToolContext, service: TaskService): void {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['connection'], (connectionCtx) => {
    const connection: any = Reflect.get(connectionCtx, 'connection');
    if (!connection?.fetch?.register || typeof connectionCtx.effect !== 'function') return;
    connectionCtx.effect(() => connection.fetch.register({
      path: TASKS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (): Promise<Response> => Response.json(taskBoard(service)),
    }), 'studymate: 任务进度路由');
  });
}
