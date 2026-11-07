/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 半路由 —— 插件页的状态卡

   `GET /api/studymate/status` 是插件管理页那张「学习工作区」卡的唯一数据源。
   它与阅读端的 `GET /api/studymate/library` 刻意分开：

     · library 是给**已经在读课件**的页面用的，工作区不在时返回 500，载荷里带每门课的
       节点、课件、题库与作答；插件页每打开一次就要读一次，不该为了几行计数把整份
       library 搬过来（`exp-shape-not-content`）。
     · 这条路由**永远 200**：没配置、没建科目、一门坏数据、读盘失败都是状态，页面按
       `configured / initialized / ok` 自己画空态与错误态。正文只回事实与计数，
       中文句子不进接口（客户端按 locale 字典翻译）。

   注册约定与 `registerAttemptRoutes` / `registerLabRoute` 逐字相同：收外层 ctx、自己
   `inject(['connection'])`，connection 就绪才注册、缺了就不挂；注册走 `connectionCtx.effect`，
   插件卸载时各自拆各自的。
   ───────────────────────────────────────────────────────────────────────── */

import { buildStatus, failedStatus } from './status.ts';

/** 路由路径：客户端 `lib/client.js` 的 `STATUS_ENDPOINT` 必须与它逐字一致。 */
export const STATUS_PATH = '/api/studymate/status';

/** connection 的精确路由表（形状由宿主决定，这里只描述用得到的成员）。 */
interface FetchRegistry {
  register(route: {
    path: string;
    methods: string[];
    requestBody: 'buffered';
    fetch: (request: Request) => Promise<Response> | Response;
  }): unknown;
}

/** `ctx.inject(['connection'], …)` 给的那层上下文；缺成员就不挂（headless / 更老的宿主）。 */
interface ConnectionContext {
  connection?: { fetch?: FetchRegistry };
  effect?: (fn: () => unknown, description?: string) => unknown;
}

/** 外层 ctx：只用到 `inject`（没有它的宿主里整条路由不挂，插件其余部分照常）。 */
interface RouteContext {
  inject?: (names: string[], handler: (ctx: ConnectionContext) => unknown) => unknown;
}

/**
 * 把插件页状态端点挂到插件上。
 *
 * @param ctx - 插件外层上下文。
 * @param options.profile - 当前 profile 名（查 `installModes` 用）；缺省时 `mode: 'unknown'`。
 * @param options.watch - 监听状态读取；由 bin 域注入，lib 域不直接 import watch。
 */
export function registerStatusRoute(
  ctx: RouteContext | null | undefined,
  options: { profile?: string; watch?: () => { watching: boolean; backend: string } | Promise<{ watching: boolean; backend: string }> } = {},
): void {
  if (!ctx || typeof ctx.inject !== 'function') return;
  ctx.inject(['connection'], (connectionCtx: ConnectionContext) => {
    const connection = connectionCtx?.connection;
    if (!connection?.fetch?.register || typeof connectionCtx.effect !== 'function') return;
    try {
      connectionCtx.effect(() => connection.fetch!.register({
        path: STATUS_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          let watch;
          try {
            watch = typeof options.watch === 'function' ? await options.watch() : options.watch;
          } catch {
            // 监听状态读失败只影响这一格：状态卡其余事实照常。
            watch = undefined;
          }
          try {
            return Response.json(buildStatus({ profile: options.profile, watch }));
          } catch (error) {
            // 读盘抛了也不把页面打成 500：状态卡要能说「读不到」，而不是让整页报错。
            console.warn(`StudyMate：插件页状态读取失败。${error instanceof Error ? error.message : String(error)}`);
            return Response.json(failedStatus('internal'));
          }
        },
      }), 'studymate: 插件页状态路由');
    } catch (error) {
      console.warn(`StudyMate：插件页状态路由没挂上。${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
