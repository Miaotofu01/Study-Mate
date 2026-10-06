/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 半路由 —— 公式排版的离线资源

   阅读端要排版公式时（页面确实出现 `$…$` / `$$…$$` 才加载）来这三样：
   `/api/studymate/math/katex.min.js`、`…/katex.min.css`、`…/fonts/*.woff2`。字节是随包发的
   KaTeX dist（`lib/katex/**`，清单与边界判据在 `lib/math.ts`，不在这里）。

   四个刻意的写法，别顺手改回去：
     · **精确路由，一条文件一条**：`connection.fetch.register` 是按 path 建表的精确路由，
       没法用一条前缀覆盖一个目录。逐条注册——引擎 + 样式表 + 每个字体各一条（清单与条数
       都从 `lib/math.ts` 的 `mathAssets()` 现算，这里不写死）——比另开一条 `webServer`
       前缀路由好：`/api` 是一条**前缀**路由，宿主按「最长前缀获胜」派发；再挂一条更长的
       `/api/studymate/math` 前缀会**盖过 `/api`**，连同它那条 Host/Origin 围栏与 cookie
       认证一起绕过去（勘察 §3.5）。挂在 `/api` 之内则照常走那道门。
     · **Content-Type 自己给精确值**（`lib/math.ts` 的 TYPES）：别复用
       `lib/assets.ts` 的 `contentTypeOf()`——它只认图片，`.js/.css/.woff2` 会兜成
       `application/octet-stream`。现在没有 `nosniff` 所以还能跑，但那是埋雷。
     · **`cache-control: no-store`**：与配图路由同一口径。这些文件随包发、版本由包决定，
       不在这里做缓存协商；`rev` 那套是宿主给 `/plugins` 的，不是我们的。
     · **注册走 `connectionCtx.effect`**：注册是**有主的**副作用，插件卸载时各自拆各自的。
       注册约定与 `registerAttemptRoutes` / `registerAskSessionRoute` 逐字相同：收外层 ctx、
       自己 `inject(['connection'])`（见 `lib/attempts-route.ts` 的说明）。
   ───────────────────────────────────────────────────────────────────────── */

import { mathAssets, mathAssetFile, mathAssetPath } from './math.ts';

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

/** 一条资源的应答体：一次读盘 + 精确 MIME。磁盘上没有它（包坏了 / 被删了）就 404。 */
function handleMathAsset(rel: string, contentType: string): () => Promise<Response> {
  return async () => {
    const file = mathAssetFile(rel);
    if (!file) return new Response('not found', { status: 404 });
    const { readFile } = await import('node:fs/promises');
    return new Response(await readFile(file), {
      headers: { 'content-type': contentType, 'cache-control': 'no-store' },
    });
  };
}

/**
 * 把公式资源路由挂到插件上。
 *
 * 与 `registerAttemptRoutes` / `registerAskSessionRoute` 同一种姿势：收**外层 ctx**、自己
 * `inject(['connection'])`，connection 就绪才注册、缺了就不挂；挂不上就是公式退化成 TeX
 * 原文（降级可读，不白屏），插件其余部分照常。
 */
export function registerMathRoute(ctx: RouteContext | null | undefined): void {
  if (!ctx || typeof ctx.inject !== 'function') return;
  ctx.inject(['connection'], (connectionCtx: ConnectionContext) => {
    const connection = connectionCtx?.connection;
    if (!connection?.fetch?.register || typeof connectionCtx.effect !== 'function') return;
    const assets = mathAssets();
    if (assets.length === 0) {
      // 包坏了（`lib/katex/**` 被删或被清空）。不抛：整个插件不该因为一份静态资源加载不上
      // 而挂掉——阅读端那边会照旧降级成可读的 TeX 原文，并给一句能照着排查的错。
      console.warn('StudyMate：包里的 KaTeX dist 不在（lib/katex/），公式只能显示 TeX 原文。');
      return;
    }
    for (const asset of assets) {
      try {
        connectionCtx.effect(() => connection.fetch!.register({
          path: mathAssetPath(asset.rel),
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: handleMathAsset(asset.rel, asset.contentType),
        }), `studymate: 公式资源 ${asset.rel}`);
      } catch (error) {
        // 宿主已经卸载（effect 落在停用的 fiber 上）/ 同一个 path 注册了两遍
        console.warn(`StudyMate：公式资源路由没挂上（${asset.rel}）。${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
}
