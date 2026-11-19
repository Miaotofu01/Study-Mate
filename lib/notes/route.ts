/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 半路由 —— 无界笔记持久化（#268）· `GET/POST /api/studymate/notes`

   这条路由是笔记数据域（`lib/notes/store.ts`）面向阅读端的**唯一**入口。注册约定与
   `lib/attempts-route.ts` 逐字相同：**收外层 ctx、自己 `inject(['connection'])`**，
   `connection` 就绪才注册、缺了就不挂（headless / 更老的宿主），注册走
   `connectionCtx.effect`（有主的副作用，卸载时各自拆各自的）。

   失败恒为 `lib/route-envelope.ts` 的唯一信封（`{ok:false,error:{code,message},...}`）；
   状态码由 `store.ts` 的回执给出，路由层**不做第二套判断**——两处判断迟早不一致。
   需要新错误码（如 `notes-unavailable`）登记进 `ROUTE_ERROR_CODES` 词表后才可使用，
   这里不自造另一套错误体系。

   请求体上限 6 MiB（真实 UTF-8 字节数，不信 Content-Length——宿主 buffered 默认 300MiB，
   不代表我们就该放松）。
   ───────────────────────────────────────────────────────────────────────── */

import { routeError, errorBody } from '../route-envelope.ts';
import {
  MAX_REQUEST_BYTES,
  isValidNotesHome,
  readNotesStore,
  upgradeNotesStore,
  writeNotesResource,
  writeNotesLayout,
} from './store.ts';

/** 路由路径：阅读端必须与它逐字一致。 */
export const NOTES_PATH = '/api/studymate/notes';

/** connection 的精确路由表（形状由宿主决定，这里只描述用得到的成员）。 */
interface FetchRegistry {
  register(route: {
    path: string;
    methods: string[];
    requestBody: 'buffered';
    fetch: (request: Request) => Promise<Response> | Response;
  }): unknown;
}

/** `ctx.inject(['connection'], …)` 给的那层上下文；缺成员就不挂。 */
interface ConnectionContext {
  connection?: { fetch?: FetchRegistry };
  effect?: (fn: () => unknown, description?: string) => unknown;
}

/** 外层 ctx：只用到 `inject`（没有它的宿主里整条路由不挂，插件其余部分照常）。 */
interface RouteContext {
  inject?: (names: string[], handler: (ctx: ConnectionContext) => unknown) => unknown;
  get?: (name: string) => { name?: string; home?: string } | undefined;
}

function resolveHome(ctx: RouteContext | null | undefined): string | null {
  const profile = ctx?.get?.('profileContext');
  const home = profile?.home;
  // 必须是**绝对路径**：相对路径/空白会让数据域落到进程 cwd 底下，
  // 换个工作目录就是另一份「笔记」，而且会在工作区里留下垃圾目录。
  return isValidNotesHome(home) ? home : null;
}

/** 可信根取不到时给的话：学生照这句话就能自救。 */
const NO_HOME = '没找到 DSH 数据根（profileContext.home）：无法定位笔记数据域。';

/**
 * 把笔记数据域路由挂到插件上。与 `registerAttemptRoutes` 同一种姿势：收**外层 ctx**、
 * 自己 `inject(['connection'])`，`connection` 就绪才注册、缺了就不挂。
 */
export function registerNotesRoute(ctx: RouteContext | null | undefined): void {
  if (!ctx || typeof ctx.inject !== 'function') return;
  const home = resolveHome(ctx);
  if (!home) {
    console.warn('StudyMate：笔记数据域路由没挂上（profileContext.home 缺失或不是绝对路径）。');
    return;
  }
  ctx.inject(['connection'], (connectionCtx: ConnectionContext) => {
    const connection = connectionCtx?.connection;
    if (!connection?.fetch?.register || typeof connectionCtx.effect !== 'function') return;
    try {
      connectionCtx.effect(() => connection.fetch!.register({
        path: NOTES_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: (request: Request) => handleNotes(request, home),
      }), 'studymate: 无界笔记数据域路由');
    } catch (error) {
      console.warn(`StudyMate：无界笔记数据域路由没挂上。${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

async function readBodyBytes(request: Request): Promise<{ ok: true; bytes: Buffer } | { ok: false; response: Response }> {
  const arrayBuffer = await request.arrayBuffer().catch(() => null);
  if (arrayBuffer === null) {
    return { ok: false, response: routeError(400, 'body-invalid', '请求体读取失败。') };
  }
  const bytes = Buffer.from(arrayBuffer);
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    return {
      ok: false,
      response: routeError(413, 'body-invalid', `请求体超过 ${Math.floor(MAX_REQUEST_BYTES / (1024 * 1024))} MiB 上限。`),
    };
  }
  return { ok: true, bytes };
}

/**
 * 一次请求：
 *   GET  → `{ok:true, schemaVersion:1|2, requiresUpgrade, storeId, resources, resourceVersions, layout, layoutVersion}`
 *   POST → `{operation:'resource'|'layout', …, expectedVersion}` 或 `{operation:'upgrade'}`
 *
 * 失败状态码直接取数据层回执里的 `status`（400/409/413/503/500），信封用 route-envelope 的
 * `errorBody`/`routeError`。
 */
export async function handleNotes(request: Request, home: string): Promise<Response> {
  try {
    // 入口再挡一道：直接调本函数时也必须拒绝非绝对路径的可信根。
    if (!isValidNotesHome(home)) {
      return routeError(400, 'path-invalid', '数据根必须是绝对路径，不能是相对路径或空白——否则笔记会落到当前工作目录下。');
    }
    if (request.method === 'GET') {
      // 只有显式 `?onCorrupt=skip` 才允许逐资源降级；缺省/非法值交给数据层判定。
      const onCorrupt = new URL(request.url).searchParams.get('onCorrupt') ?? undefined;
      const result = readNotesStore({ home, onCorrupt });
      if (!result.ok) {
        return Response.json(errorBody(result.code, result.message, result.extra ?? {}), { status: result.status });
      }
      return Response.json({
        ok: true,
        schemaVersion: result.value.schemaVersion,
        requiresUpgrade: result.value.requiresUpgrade,
        storeId: result.value.storeId,
        resources: result.value.resources,
        resourceVersions: result.value.resourceVersions,
        layout: result.value.layout,
        layoutVersion: result.value.layoutVersion,
        ...(result.value.corrupt ? { corrupt: result.value.corrupt } : {}),
      }, { status: 200 });
    }
    if (request.method !== 'POST') {
      return routeError(405, 'method-not-allowed', '笔记数据域只收 GET / POST');
    }
    const bodyRead = await readBodyBytes(request);
    if (!bodyRead.ok) return bodyRead.response;
    let body: unknown;
    try {
      body = JSON.parse(bodyRead.bytes.toString('utf8'));
    } catch {
      return routeError(400, 'body-invalid', '请求体要是合法 JSON。');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return routeError(400, 'body-invalid', '请求体要是 JSON 对象。');
    }
    const record = body as Record<string, unknown>;
    const operation = record.operation;
    if (operation === 'resource') {
      const result = writeNotesResource({
        home,
        resource: record.resource,
        expectedVersion: record.expectedVersion as string | null | undefined,
      });
      if (!result.ok) {
        return Response.json(errorBody(result.code, result.message, result.extra ?? {}), { status: result.status });
      }
      return Response.json({ ok: true, resource: result.value.resource, version: result.value.version }, { status: 200 });
    }
    if (operation === 'layout') {
      const result = writeNotesLayout({
        home,
        layout: record.layout,
        expectedVersion: record.expectedVersion as string | null | undefined,
      });
      if (!result.ok) {
        return Response.json(errorBody(result.code, result.message, result.extra ?? {}), { status: result.status });
      }
      return Response.json({ ok: true, layout: result.value.layout, version: result.value.version }, { status: 200 });
    }
    if (operation === 'upgrade') {
      const result = upgradeNotesStore({ home });
      if (!result.ok) {
        return Response.json(errorBody(result.code, result.message, result.extra ?? {}), { status: result.status });
      }
      return Response.json({
        ok: true,
        schemaVersion: result.value.schemaVersion,
        requiresUpgrade: result.value.requiresUpgrade,
        backup: result.value.backup,
        backupId: result.value.backupId,
      }, { status: 200 });
    }
    return routeError(400, 'body-invalid', 'operation 只支持 resource / layout / upgrade。');
  } catch (error) {
    console.warn('StudyMate：笔记路由发生未预期错误。', error);
    return routeError(500, 'internal', '笔记请求未能完成，请保留本地草稿并稍后重试。');
  }
}

export { NO_HOME };
