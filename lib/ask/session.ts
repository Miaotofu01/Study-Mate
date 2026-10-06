/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 问答域 —— 「建一条答疑会话」的那条路由（#105）

   `POST /api/studymate/qa/session`：面板要一段真会话，而**客户端建不出来**——浏览器的
   `ISessions.create` 只序列化 `{workspaceId, cwd, sessionId}`，`agentPreset` 被**静默丢掉**
   （宿主请求类型与线上 schema 都收这个字段，只有客户端包装层丢）。所以会话只能由宿主半按
   「答疑模式」预设（`preset/qa/**`，id 是 `qa`）建，客户端只 `retain` 它并渲染它。

   一次请求做五件事，顺序照宿主的 `createWebhookSession`（`@deepseek-ai/dsh-webhook` 里唯一
   一份完整的程序化建会话范例）：

     1. 探模型：`probeModel` 说没有可用模型就**不建会话**、如实返回 `{available:false, reason}`；
     2. `agentPresets.resolve('qa')` → `acquireScope(preset.id)`（把预设 revision 钉到创建窗口
        结束，用完就还——照 webhook 的 `using`/`__addDisposableResource`）；
     3. `agents.create({ sessionId, meta:{cwd, agentPreset:'qa'}, setup: mount })`——`meta` 的
        字段名就是 `agentPreset`，`setup` 里 `mount` 必须先跑（scope 后续注册都依赖它）；
     4. 标题写成「答疑 · 科目 · 节点」：走 `ctx.sessionTitle.rename(agent.session, title)`；
        这个服务**可能没挂**（宿主自己的报错文案是「renaming is unavailable: this deployment
        mounts no session-title service」）——缺了就如实降级（`renamed:false`），不抛、也不假装改过；
     5. 注入一条共享记忆：`agents.get(sessionId).inject(message)`，空就不注入。语义是「追加到
        next-step 桶、不唤醒 driver」，**可能错过已经领走本批的那次 pre-step**——已知竞态，接受
        （spec #102 Further Notes 第 4 条）。

   两处刻意的写法，别顺手改回去：

     · **不 dispose `AgentHandle`。** `agents.create` 返回的是 `{agent, dispose}`，而 `dispose()`
       会把刚建好的会话拆掉（webhook 也把它留给 ctx 生命周期）。健康的做法是「建完就撒手」：
       agent 归宿主 ctx 所有，会话由此活得比这次请求久。
     · **不 import 宿主的任何包**（`createUserMessage` 也不行）：本仓库的 Host 半是**零依赖**
       插件（`bin/dsh-plugin.ts` 的文件头写明）。共享记忆那条消息照 `createUserMessage` 的形状
       自己造（`{id, role:'user', content, source}`）——宿主那边它做的就是「补一个随机身份 +
       深冻」，运行期只认这几个字段（`@deepseek-ai/dsh-llm` 的 `createMessage`）。

   错误一律走 `lib/route-envelope.ts` 的**唯一信封**；`available:false` 是协商结果，与工具域
   的 `{available:false, reason}` 同一个形状。
   ───────────────────────────────────────────────────────────────────────── */

import { randomUUID } from 'node:crypto';

import { probeModel } from '../core/model.ts';
import { errorBody, routeError } from '../route-envelope.ts';
import { resolveWorkspace } from '../workspace.ts';
import { readMemoryFromWorkspace } from './memory.ts';

/** 与 `bin/dsh-plugin.ts` 那几条路由同一个命名空间（`/api/studymate/…`）。 */
export const QA_SESSION_PATH = '/api/studymate/qa/session';

/** 答疑模式预设的 id（`preset/qa/preset.yml` 那条；安装器写进 profile 的也是它）。 */
export const QA_AGENT_PRESET = 'qa';

/** 标题的固定前缀与分隔符：「答疑 · 科目 · 节点」。 */
export const ASK_SESSION_PREFIX = '答疑';
export const ASK_SESSION_SEP = ' · ';

/* ── 标题：拼法与识别（#105 的测试缝 1）───────────────────────────────────
   「标题即识别」是 spec #102 定死的机制：新建时写成这个前缀，「上一段会话」与侧边栏里
   一眼分得出都靠它，不再另存一份 id 清单。拼法与识别必须**只有一份**——宿主半拼出来的
   标题，客户端要用同一份判据去认。 */

/** 一段标题里的组成部分：去掉首尾空白、把内部换行折成空格（标题是单行文本）。 */
function titlePart(value: unknown): string {
  return (typeof value === 'string' ? value : '').trim().replace(/\s+/g, ' ');
}

/** 「答疑 · 科目 · 节点」；缺哪一节就少写哪一节，**不留空的分隔符**。 */
export function titleForAskSession(subject?: unknown, node?: unknown): string {
  return [ASK_SESSION_PREFIX, titlePart(subject), titlePart(node)].filter(Boolean).join(ASK_SESSION_SEP);
}

/**
 * 这条标题是不是我们建的答疑会话。
 *
 * 只认「答疑」+ 可选的一节或多节；**不是**「以答疑开头就算」——`答疑解惑` 这种别的标题、
 * 或者项目名恰好以「答疑」开头的 `displayTitle`（那是客户端的判据，用 `title` 避开）都不算。
 */
export function isAskSessionTitle(title?: unknown): boolean {
  if (typeof title !== 'string') return false;
  const text = title.trim();
  if (text === ASK_SESSION_PREFIX) return true;
  const head = ASK_SESSION_PREFIX + ASK_SESSION_SEP;
  return text.startsWith(head) && text.length > head.length;
}

/* ── 形状 ──────────────────────────────────────────────────────────────── */

/** 我们用到的预设注册表（宿主半零依赖，按**用到的成员**描述形状，全部可选）。 */
export interface AskPresetRegistry {
  resolve?: (id?: string) => Promise<{ id?: string } | undefined>;
  acquireScope?: (id?: string) => Promise<unknown>;
  mount?: (ctx: unknown, id?: string) => Promise<unknown>;
}

/** `agents.create` 的回执与 `agents.get` 的面：只用到这几个成员。 */
export interface AskAgentHandle {
  agent?: { session?: unknown; inject?: (message: unknown) => void } | undefined;
}

export interface AskAgents {
  create?: (options: unknown) => Promise<AskAgentHandle | undefined>;
  get?: (id: string) => { session?: unknown; inject?: (message: unknown) => void } | undefined;
}

/** 改名服务：`ctx.sessionTitle.rename(session, title)`（宿主半没有 `ISession.rename`）。 */
export interface AskSessionTitle {
  rename?: (session: unknown, title: string) => unknown;
}

/** 路由依赖。全部可注入：套件里换成假工作区、假预设表、假 agents，**不建真会话**。 */
export interface AskSessionDeps {
  /** 工作区目录（会话的 `meta.cwd`） */
  workspace: string;
  /** `ctx.agentPresets`（插件根 ctx 上的服务） */
  agentPresets?: AskPresetRegistry | null;
  /** `ctx.agents` */
  agents?: AskAgents | null;
  /** `ctx.sessionTitle`（可能没挂——缺了就如实降级） */
  sessionTitle?: AskSessionTitle | null;
  /** `ctx.llm` 拿到的模型服务（可能没有） */
  llm?: unknown;
  /** 读共享记忆（`.learning/MEMORY.md`） */
  readMemory?: (workspace: string) => string;
  /** 现造会话 id（测试注入；不注入就是 `studymate-qa-<uuid>`） */
  createId?: () => string;
}

/** 回执。`available:false` = 确定没有可用模型；`ok:false` = 有模型但这次没建起来。 */
export interface AskSessionView {
  /** 模型能力探测的结论（与工具域、`/ask` 那条路由同一个形状） */
  available: boolean;
  /** 这条会话建起来没有（`available:false` 时恒 false） */
  ok: boolean;
  /** 会话 id（客户端拿它 `retain`） */
  sessionId?: string;
  /** 标题该长什么样（「答疑 · 科目 · 节点」） */
  title?: string;
  /** 标题**真的写上了**没有：宿主可能没挂 sessionTitle 服务（那是如实降级，不是失败） */
  renamed?: boolean;
  /** 共享记忆真的注入了一条没有（空记忆不注入） */
  memoryInjected?: boolean;
  /** 失败时的可读原因与机器码（走唯一信封） */
  error?: { code: string; message: string };
  /** 不可用时的原因（与工具域同一份文案） */
  reason?: string;
}

/** 请求体：`{ subject, node }` 只用来拼标题（缺就少写一节）。 */
export interface AskSessionInput {
  subject?: unknown;
  node?: unknown;
}

/* ── 零件 ──────────────────────────────────────────────────────────────── */

/** 失败的那一格：走唯一信封（`lib/route-envelope.ts`），`available` 是同级字段。 */
function errorView(code: string, message: string): AskSessionView {
  return { available: true, ...errorBody(code, message) } as AskSessionView;
}

/** 没有可用模型：`available:false` 是协商结果（与 `/ask` 那条路由同一口径）。 */
function unavailableView(reason: string): AskSessionView {
  return { available: false, reason, ...errorBody('model-unavailable', reason) } as AskSessionView;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 造一条 UserMessage（`inject` 要的是完整消息，不是字符串）。
 *
 * 宿主那边 `createUserMessage({content, source})` 做的就是「补一个 `randomUUID` 身份 +
 * deepFreeze」；我们零依赖造不出那个函数，就照形状自己造。`source` 用 `{kind:'user'}`
 * （宿主自己的常客，最省事），不另造一个只有我们认识的 kind。
 */
function memoryMessage(text: string): unknown {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

/** 还租来的预设 revision：`acquireScope` 的返回值是 `AsyncDisposable`（可能带 `dispose`）。 */
async function releaseScope(scope: unknown): Promise<void> {
  if (!scope || typeof scope !== 'object') return;
  const disposable = scope as { [Symbol.asyncDispose]?: () => Promise<unknown>; dispose?: () => Promise<unknown> };
  const asyncDispose = disposable[Symbol.asyncDispose];
  const dispose = disposable.dispose;
  try {
    if (typeof asyncDispose === 'function') await asyncDispose.call(disposable);
    else if (typeof dispose === 'function') await dispose.call(disposable);
  } catch {
    // 还不上就算了：租约由宿主回收，不该因为它把已经建好的会话结果吞掉
  }
}

/* ── 主流程 ────────────────────────────────────────────────────────────── */

/**
 * 建一条答疑会话。返回**普通对象**（不是 `Response`）：套件能把整份回执逐字段断言。
 *
 * 没有可用模型时**一条会话都不建**——不假装会答（面板那边显示 reason）。
 */
export async function openAskSession(deps: AskSessionDeps, input: AskSessionInput = {}): Promise<AskSessionView> {
  const title = titleForAskSession(input.subject, input.node);

  // 1. 能力探测（与工具域、`/ask` 同一份判据，见 lib/core/model.ts）
  const capability = probeModel({ get: (name: string) => (name === 'llm' ? deps.llm : undefined) });
  if (!capability.available) return unavailableView(capability.reason ?? '模型能力不可用');

  // 2. 预设：没有注册表 / 没有「答疑模式」就建不出来（这不是「没有模型」，是配置缺了）
  const presets = deps.agentPresets;
  if (!presets || typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') {
    return errorView('preset-unavailable',
      '这个宿主没把预设注册表交给插件（ctx.agentPresets 不在）：答疑会话按「答疑模式」预设跑，没有它就建不出来');
  }
  let presetId = QA_AGENT_PRESET;
  try {
    const preset = await presets.resolve(QA_AGENT_PRESET);
    if (preset && typeof preset.id === 'string' && preset.id.trim()) presetId = preset.id.trim();
  } catch (error) {
    return errorView('preset-unavailable',
      `读不到「答疑模式」预设（${QA_AGENT_PRESET}）：${messageOf(error)}。先跑一次 npx @yunmiao/studymate install，再重启 DSH`);
  }

  const agents = deps.agents;
  if (!agents || typeof agents.create !== 'function') {
    return errorView('session-create-failed',
      '这个宿主没把会话服务交给插件（ctx.agents 不在）：建不出答疑会话');
  }
  // 绑一下：上面的检查把 mount 收窄了，而它要穿过 await 在 setup 闭包里被调
  const mountPreset = presets.mount.bind(presets);

  let scope: unknown = null;
  try {
    if (typeof presets.acquireScope === 'function') scope = await presets.acquireScope(presetId);
  } catch {
    // 租不到 revision 不是致命：创建窗口里预设照样解析得动（webhook 也只是「冷读」用）
    scope = null;
  }

  const sessionId = deps.createId ? deps.createId() : `studymate-qa-${randomUUID()}`;
  let handle: AskAgentHandle | undefined;
  try {
    handle = await agents.create({
      sessionId,
      // meta.agentPreset 是 durable session metadata（落盘）：侧边栏/设置页据此认这条会话按哪条预设跑
      meta: { cwd: deps.workspace, agentPreset: presetId },
      // setup 里 mount 必须**先于**别的 scoped 注册（restrict 的合法名字集依赖已挂上的层，见 #104）
      setup: async (agentCtx: unknown) => { await mountPreset(agentCtx, presetId); },
    });
  } catch (error) {
    return errorView('session-create-failed', `建答疑会话失败：${messageOf(error)}`);
  } finally {
    // 预设 revision 用完就还。**注意这里没有 `handle.dispose()`**——那是拆掉刚建好的会话；
    // handle 归宿主 ctx 的生命周期管（文件头「两处刻意的写法」）。
    await releaseScope(scope);
  }

  const live = handle?.agent ?? agents.get?.(sessionId);

  // 4. 标题：宿主的 sessionTitle 服务可能没挂 → 如实降级（没有标题就没有前缀识别，但会话是好的）
  const titleService = deps.sessionTitle;
  let renamed = false;
  const session = live?.session;
  if (session && titleService && typeof titleService.rename === 'function') {
    try {
      titleService.rename(session, title);
      renamed = true;
    } catch {
      renamed = false;
    }
  }

  // 5. 共享记忆：会话开张注入一条，之后不再重复（这条路由一条会话只跑一次）。空就不注入。
  const memory = (deps.readMemory ?? readMemoryFromWorkspace)(deps.workspace).trim();
  let memoryInjected = false;
  if (memory !== '' && live && typeof live.inject === 'function') {
    live.inject(memoryMessage(memory));
    memoryInjected = true;
  }

  return { available: true, ok: true, sessionId, title, renamed, memoryInjected };
}

/* ── 路由注册 ──────────────────────────────────────────────────────────── */

/** `ctx.inject(['connection'], …)` 给的那层上下文：与 `lib/ask/route.ts` 同一形状。 */
export interface AskSessionRouteContext {
  agentPresets?: unknown;
  connection?: { fetch?: { register?: (route: unknown) => unknown } };
  effect?: (fn: () => unknown, description?: string) => unknown;
  get?: (name: string) => unknown;
  inject?: (names: string[], handler: (ctx: unknown) => void) => unknown;
}

/**
 * 把「建答疑会话」挂到插件上。与 `/ask` 那条同一个姿势：`connection` 就绪才注册，缺了就不挂。
 * 由 `lib/ask/route.ts` 的 `registerAskRoute(ctx)` 一起注册（`bin/dsh-plugin.ts` 那一行不动）。
 */
export function registerAskSessionRoute(ctx: AskSessionRouteContext): void {
  if (typeof ctx.inject !== 'function') return;
  // agentPresets 在插件根 ctx 上（`bin/dsh-plugin.ts` 的 `export const inject = ['agentPresets']`）；
  // 闭包进来，别指望 connection 那层也反射得到。
  const rootPresets = ctx.agentPresets ?? ctx.get?.('agentPresets');
  ctx.inject(['connection'], (connectionCtx: unknown) => {
    const child = connectionCtx as {
      connection?: { fetch?: { register?: (route: unknown) => unknown } };
      effect?: (fn: () => unknown, description?: string) => unknown;
      get?: (name: string) => unknown;
    };
    const connection = child?.connection;
    if (!connection?.fetch?.register || typeof child.effect !== 'function') return;
    child.effect(() => connection.fetch!.register!({
      path: QA_SESSION_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
          return routeError(400, 'body-invalid', '请求体要是 JSON 对象：{ subject, node }（只用来拼标题）', { available: true });
        }
        const workspace = resolveWorkspace();
        if (!workspace) {
          return routeError(500, 'workspace-missing', '没找到学习工作区：~/.dsh/studymate-config.yaml 里没有 workspace。先跑一次 npx @yunmiao/studymate install。', { available: true });
        }
        try {
          const view = await openAskSession({
            workspace,
            agentPresets: (rootPresets ?? child.get?.('agentPresets')) as AskPresetRegistry | undefined,
            agents: child.get?.('agents') as AskAgents | undefined,
            // 可能没挂：拿不到就是如实降级（见 openAskSession 第 4 步）
            sessionTitle: child.get?.('sessionTitle') as AskSessionTitle | undefined,
            llm: child.get?.('llm'),
          }, body as AskSessionInput);
          // 面板按状态码区分「没模型」与「建不出来」
          const status = view.ok ? 200
            : view.available === false ? 503
              : 500;
          return Response.json(view, { status });
        } catch (error) {
          return routeError(500, 'session-create-failed', messageOf(error), { available: true });
        }
      },
    }), 'studymate: 建答疑会话路由');
  });
}
