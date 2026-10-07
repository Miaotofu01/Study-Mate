/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 实验域 —— 阅读端要的那条路由（学生按「跑一次」）

   `POST /api/studymate/lab-run` → `{ 状态, 说明, 命令来源, 任务, 跑, 作答数据, 拒 }`

   为什么要有这条路：判分三轨的第三轨是**学生**按下去的（规格 §7.3「Host 半代跑学生本地的
   测试命令」）。模型那边有原生工具 `studymate_lab_run`，但学生手上没有工具调用——阅读端
   只能走 `/api` 下的精确路由（与 `GET /api/studymate/library`、`POST /api/studymate/attempts`
   同一条路，**自动**获得宿主那一层的 Host/Origin 检查与浏览器会话认证，见
   `dsh-plugin-api.md` §6.3，不用自己写鉴权）。

   三件刻意的事，别顺手改回去：

     · **计划与执行与原生工具共用一份实现**：这条路只做「解请求体 → 造 access → 调
       `planLabRun` / `startLabRun`」。命令从哪来、文法怎么读、边界怎么判，一个字都不在这里
       ——两边各写一遍的话，早晚有一边忘了判某一条边界，而那正是这张票要防的事。
     · **access 用同一份声明自己造**（`LAB_READS` / `LAB_WRITES`）：`createWorkspaceVault()`
       是域数据的唯一读法，`createAccess` 是「越权即抛」的唯一执行点。这条路由碰的数据与工具
       完全一样，所以声明也一样；不一样的地方是**没有会话身份**——actor 取「本机」，
       与宿主 `ctx.jobs` 的无主任务同一口径（任务板子上谁都看得见）。
     · **等待有上限**：HTTP 请求不该挂住浏览器。这里等 `ROUTE_WAIT_MS`，没结束就把任务句柄
       交回去，页面改问 `GET /api/studymate/tasks`（那条只读路由本来就在画进度条）。
       取消也一样走工具那条路（`studymate_task_cancel`）——**起活可以由学生按，停活要有身份**，
       这条路由不提供取消，改状态的动作一律不做成 HTTP 路由（与任务域同一条口径）。
   ───────────────────────────────────────────────────────────────────────── */

// 域 guard 与工作区 vault 住在 `lib` 域（Host 数据层）：实验域不许 import 工具域
// （域图上 tools → lab 是注册点那条边，反过去就成环），所以这两样从实现处直接取。
import { routeError } from '../route-envelope.ts';
import { createWorkspaceVault } from '../host/vault.ts';
import { createAccess } from '../host/access.ts';
import {
  LAB_READS, LAB_WRITES, planLabRun, startLabRun,
} from './tools.ts';
import type { LabRunOutcome } from './tools.ts';
import { taskService, UNOWNED } from '../tasks/index.ts';

/** 路由路径：前端 `lib/client.js` 的 `LAB_ENDPOINT` 必须与它逐字一致。 */
export const LAB_RUN_PATH = '/api/studymate/lab-run';

/**
 * 这一次请求最多等多久（毫秒）。比原生工具那个 `inlineWaitMs()`（25 秒）短得多：HTTP 请求
 * 挂着的时候**页面什么都做不了**，而工具调用挂着的只是一个模型轮次。跑得久不是问题——
 * 页面改问任务路由，进度条本来就在那儿。
 */
export const ROUTE_WAIT_MS = 8_000;

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

/** 请求体的形状；多一个字段都不认（`assertJson` 那套「不猜」的口径）。 */
const BODY_KEYS = ['subject', 'node', 'question', 'cwd', 'writable', 'predicted', 'selfAssessment'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function badRequest(error: string, message: string): Response {
  // 信封只有一份（`lib/route-envelope.ts`）：`{ ok:false, error:{ code, message } }`
  return routeError(400, error, message);
}

/**
 * 跑一次（或把句柄交回去）。抽成函数是为了让套件能直接断言它，不必起一个 HTTP 服务。
 */
export async function runRouteRequest(body: unknown): Promise<Response> {
  if (!isPlainObject(body)) {
    return badRequest('body-invalid', '请求体要是 JSON 对象：{ subject, node, question, cwd?, writable?, predicted?, selfAssessment? }');
  }
  for (const key of Object.keys(body)) {
    if (!BODY_KEYS.includes(key)) return badRequest('body-invalid', `请求体里有多出来的字段「${key}」`);
  }
  for (const key of ['subject', 'node', 'question']) {
    const value = body[key];
    if (typeof value !== 'string' || value.trim() === '') {
      return badRequest('body-invalid', `缺少 ${key}：它是「跑哪一道交付物题」的三个坐标之一`);
    }
  }
  if (body.cwd !== undefined && typeof body.cwd !== 'string') {
    return badRequest('body-invalid', 'cwd 要是字符串（相对实验目录的一个路径）');
  }
  if (body.writable !== undefined
    && (!Array.isArray(body.writable) || body.writable.some((one) => typeof one !== 'string'))) {
    return badRequest('body-invalid', 'writable 要是字符串数组（相对实验目录的一组路径）');
  }
  for (const key of ['predicted', 'selfAssessment']) {
    if (body[key] !== undefined && typeof body[key] !== 'string') {
      return badRequest('body-invalid', `${key} 要是字符串`);
    }
  }

  // 与原生工具同一份声明、同一套读法：越权即抛的执行点只有 `createAccess` 一个
  const access = createAccess(
    { tool: 'studymate_lab_run(route)', declaration: { reads: LAB_READS as never[], writes: LAB_WRITES as never } },
    createWorkspaceVault().load,
  );
  const outcome = planLabRun(access, {
    subject: body.subject as string,
    node: body.node as string,
    question: body.question as string,
    ...body.cwd === undefined ? {} : { cwd: body.cwd as string },
    ...body.writable === undefined ? {} : { writable: body.writable as string[] },
    ...body.predicted === undefined ? {} : { predicted: body.predicted as string },
    ...body.selfAssessment === undefined ? {} : { selfAssessment: body.selfAssessment as string },
  });
  // 拒也是**结果**（200，带一句能照着改的话）：它不是服务器出错，是这次不许跑
  if ('拒' in outcome) return Response.json(outcome);

  const result: LabRunOutcome = await startLabRun(taskService(), outcome, {
    actor: UNOWNED,
    waitMs: ROUTE_WAIT_MS,
  });
  return Response.json(result);
}

/**
 * 把这条路由挂到插件上。
 *
 * 与 `registerAskSessionRoute` / `registerAttemptRoutes` / `registerTaskRoute` 同一种姿势：收**外层
 * ctx**、自己 `inject(['connection'])`，`connection` 就绪才注册、缺了就不挂（headless / 更老
 * 的宿主）——挂不上就是「学生点不了跑一次」这一个功能不可用，插件其余部分照常。
 */
export function registerLabRoute(ctx: RouteContext | null | undefined): void {
  if (!ctx || typeof ctx.inject !== 'function') return;
  ctx.inject(['connection'], (connectionCtx: ConnectionContext) => {
    const connection = connectionCtx?.connection;
    if (!connection?.fetch?.register || typeof connectionCtx.effect !== 'function') return;
    try {
      connectionCtx.effect(() => connection.fetch!.register({
        path: LAB_RUN_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request): Promise<Response> => {
          const body = await request.json().catch(() => null);
          return runRouteRequest(body);
        },
      }), 'studymate: 实验代跑路由');
    } catch {
      // 同一个 path 注册第二次会抛（`bin/dsh-plugin.ts` 里那几条同源的判词）：挂不上就是挂不上
    }
  });
}
