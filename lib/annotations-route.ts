/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 半路由 —— 课件页标注的写入端点

   `POST /api/studymate/annotations` 是阅读端落盘标注的**唯一**入口（ADR-0015：标注与
   `attempts/` 同族，落在 ADR-0010 已批准的「阅读端只能碰 reference/ 与作答数据」那一侧）。
   阅读端划选正文 → 这里 → `lib/annotations.ts` 写 `annotations/<NNNN>-<节点id>.json`；
   **课件正文与题库一个字节都不碰**（ADR-0015 / ADR-0007）。

   为什么单独成文件、只导出 `registerAnnotationRoutes(ctx)` 加一个 handler：与
   `lib/attempts-route.ts` 同一种拆法——`bin/dsh-plugin.ts` 是全插件共享的入口，那里只留
   **一行**注册（旁边一句注释），从 `inject(['connection'])` 到路径、方法、请求体形状、
   状态码映射全在这份文件里。

   五个刻意的写法，别顺手改回去：
     · `lib/annotations.ts` 与 `lib/workspace.ts` 用**动态 import**：`bin/dsh-plugin.ts` 会被
       scripts/tests/test_bundle.mjs 单独拷进一个临时目录跑（那里没有 `lib/`），顶层静态
       import 会让那条用例在解析期就崩。
     · **只开 POST，不另开 GET**：读走 payload（`GET /api/studymate/library` 的
       `node.annotations`，`lib/library.ts` 已经把它挂上去了）。再开一条读路径就是第二份真相。
     · 冲突（409 `version-conflict`）与幂等重放都只是把 `writeAnnotations` 的回执**原样**递
       出去——栅栏在数据层，这里不做第二套判断（两处判断迟早不一致）。阅读端拿 409 里带回来
       的 `annotations` + `version` 就地重读，不必再跑一趟。
     · 路由注册也走 `connectionCtx.effect`：注册是**有主的**副作用，插件卸载时各自拆各自的
       （与 bin/dsh-plugin.ts 里另外那几条路由同一口径）。
     · 注册约定与 `registerAttemptRoutes` / `registerAskSessionRoute` / `registerTaskRoute`
       逐字相同：**收外层 ctx、自己 `inject(['connection'])`**。同一个插件里「挂一条路由」
       不该有两套写法。
   ───────────────────────────────────────────────────────────────────────── */

import { routeError } from './route-envelope.ts';

/** 路由路径：阅读端 `lib/client.js` 的标注端点必须与它逐字一致。 */
export const ANNOTATIONS_PATH = '/api/studymate/annotations';

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

/** 没找到工作区时给的话与 library / attempts 路由同一句：学生照这句话就能自救。 */
const NO_WORKSPACE = '没找到学习工作区：~/.dsh/studymate-config.yaml 里没有 workspace。先跑一次 npx @yunmiao/studymate install。';

/**
 * 把标注写入端点挂到插件上。
 *
 * 与 `registerAttemptRoutes` 同一种姿势：收**外层 ctx**、自己 `inject(['connection'])`，
 * `connection` 就绪才注册、缺了就不挂（headless / 更老的宿主），挂不上就是这一个功能不可用，
 * 插件其余部分照常。注册是**有主的**副作用，所以走 `connectionCtx.effect`，卸载时各自拆各自的。
 */
export function registerAnnotationRoutes(ctx: RouteContext | null | undefined): void {
  if (!ctx || typeof ctx.inject !== 'function') return;
  ctx.inject(['connection'], (connectionCtx: ConnectionContext) => {
    const connection = connectionCtx?.connection;
    if (!connection?.fetch?.register || typeof connectionCtx.effect !== 'function') return;
    try {
      connectionCtx.effect(() => connection.fetch!.register({
        path: ANNOTATIONS_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handleAnnotations,
      }), 'studymate: 课件标注路由');
    } catch (error) {
      // 宿主已经卸载（effect 落在停用的 fiber 上）/ 同一个 path 注册了两遍：都是「这一个功能
      // 不可用」，不该让调用处（bin/dsh-plugin.ts 的一行注册）冒一个没人接的 promise 拒绝出来。
      console.warn(`StudyMate：课件标注路由没挂上。${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/**
 * 一次标注写入。请求体：
 *   `{ subject, node, annotations, operationId, expectedVersion }`
 *     · `annotations`：**当前的整份标注数组**（全量替换：创建、编辑、删除都靠它；空数组 = 清空），
 *       每项 `{ id, note, ranges: [{line, kind, hash, start, end}], created, modified }`；
 *     · `operationId`：幂等键——重放只回放上次的回执，不写第二遍（双击、超时重试）；
 *     · `expectedVersion`：阅读端读 payload 时看到的标注版本号，对不上就 409 拒绝并重读。
 *
 * 返回就是 `writeAnnotations` 的回执，HTTP 状态码取回执里的 `status`（成功恒 200）；
 * 失败那一侧的信封是 `lib/route-envelope.ts` 那一份（`{ ok: false, error: { code, message } }`，
 * 契约的人读版在 `docs/规范/工程约束.md` §三）：
 *   200 `{ ok: true, annotations, version }`
 *   409 `{ ok: false, error: { code: 'version-conflict' | 'operation-id-conflict', message }, annotations?, version }`
 *   400 `{ ok: false, error: { code: 'operation-id-invalid' | 'subject-invalid' | 'node-invalid' |
 *             'lesson-missing' | 'annotations-invalid' | 'expected-version-required', message } }`
 */
export async function handleAnnotations(request: Request): Promise<Response> {
  try {
    if (request.method !== 'POST') {
      return routeError(405, 'method-not-allowed', '标注写入只收 POST');
    }
    const { resolveWorkspace } = await import('./workspace.ts');
    const workspace = resolveWorkspace();
    if (!workspace) {
      return routeError(500, 'no-workspace', NO_WORKSPACE);
    }
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return routeError(400, 'body-invalid',
        '请求体要是 JSON 对象：{ subject, node, annotations, operationId, expectedVersion }');
    }
    const { writeAnnotations } = await import('./annotations.ts');
    const result = writeAnnotations({
      workspace,
      subject: body.subject,
      node: body.node,
      annotations: body.annotations,
      expectedVersion: body.expectedVersion,
      operationId: body.operationId,
    });
    return Response.json(result, { status: result.ok ? 200 : result.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return routeError(500, 'internal', message);
  }
}
