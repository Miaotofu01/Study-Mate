/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 问答域 —— 阅读端面板的那一条路由（#79）

   `POST /api/studymate/ask`：面板独立调模型回答，**不经过总控**（目标态规格 §7.4）。

   一次请求做四件事，顺序固定：

     1. 读工作区 → 找到正在读的那一课（正文原文）与共享记忆 `MEMORY.md`；
     2. 组装请求体（`lib/core/ask.ts`：只有当前课件 + 选中文本 + 共享记忆，不背会话）；
     3. 调一次模型（`ctx.llm.stream`），把流拼成一段文本；
     4. **追加一条误解记录**（`lib/misconceptions.ts`），回答本身**不落任何盘**。

   为什么不走工具（`studymate_*`）而走一条 HTTP 路由：工具是**总控**的调用面（模型的
   function calling）。面板是浏览器里的阅读端，它要的是「就地问一句」，中间隔一层总控就等于
   把会话背上了——那正是这条 ticket 要拆掉的东西。路由挂在 `/api/studymate/…` 之下，
   自动获得宿主那一层的 Host/Origin 检查与浏览器会话认证（`dsh-plugin-api.md` §6.3）。

   面板**不触发任何写学习内容的路径**：这条路由的写动作只有一处——追加误解记录，
   那是「学习状态」不是「学习内容」；课件的写入路径（`lessons/`、`reference/`）一个都不碰
   （ADR-0010 的例外只有学生自己加参考资料，那条路在 `/api/studymate/reference`，与本路由无关）。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

import { buildAskContext, assembleAnswer, topicFromQuestion, AskContextError } from '../core/ask.ts';
import type { AskRequestBody } from '../core/ask.ts';
import { probeModel } from '../core/model.ts';
import { cmpCodePoints } from '../core/format.ts';
import { errorBody, routeError } from '../route-envelope.ts';
import { resolveWorkspace } from '../workspace.ts';
import { writeMisconception, ASK_SOURCE } from '../misconceptions.ts';

/** 与 `bin/dsh-plugin.ts` 里三条路由同一个命名空间（`/api/studymate/…`）。 */
export const ASK_PATH = '/api/studymate/ask';

/** 一次模型调用的超时兜底：适配器必须尊重 `signal`（§9.2），超了就中止，别让面板一直转圈。 */
const ANSWER_TIMEOUT_MS = 60_000;

/* ── 形状 ──────────────────────────────────────────────────────────────── */

/** 模型流里我们真正读的那两种块（`StreamChunk` 的其余成员原样忽略）。 */
interface StreamChunkLike {
  type?: string;
  text?: unknown;
  reason?: unknown;
}

/** 面板拿到的回执。`available:false` = 确定没有可用模型；`ok:false` = 有模型但这次没答成。 */
export interface AskView {
  /** 模型能力探测的结论（与工具那条路的 `{available, reason}` 同一个形状） */
  available: boolean;
  /** 这次问答成不成（`available:false` 时恒 false） */
  ok: boolean;
  /** 用的是哪个模型（答成了才有） */
  model?: { provider: string; model: string };
  /** 回答正文（不落盘） */
  answer?: string;
  /** 刚落的那条误解记录（字段与 misconceptions.schema.json 逐个相等） */
  misconception?: { topic: string; source: string; evidence: string; status: string; at: string };
  /** 写盘结果：写成了、回放了、还是没写成（没写成也不影响回答已经拿到）。
   *  没写成时那一格也是唯一信封（`{ ok:false, error:{ code, message } }`，见 lib/route-envelope.ts）。 */
  write?: { ok: boolean; version?: string; replayed?: boolean; error?: { code: string; message: string } };
  /** 失败时的可读原因与机器码 */
  error?: { code: string; message: string; version?: string };
  /** 不可用时的原因（与工具域同一份文案） */
  reason?: string;
}

/** 路由依赖。全部可注入：测试里换成假工作区、假 llm，**不花额度**。 */
export interface AskDeps {
  /** 工作区目录（含 `.learning/`） */
  workspace: string;
  /** `ctx.get('llm')` 拿到的模型服务（可能没有） */
  llm?: unknown;
  /** 宿主默认模型选择（`agentDefaultModel.currentSelection()`） */
  defaultSelection?: { provider?: unknown; model?: unknown } | null;
  /** 读一课：给科目 slug 与节点 id，返回课件原文与文件名 */
  readLesson?: (input: { workspace: string; subject: string; node: string }) => LessonLookup | null;
  /** 读共享记忆（`.learning/MEMORY.md`） */
  readMemory?: (workspace: string) => string;
  /** 调一次模型，返回它输出的整段文本。**唯一会花钱的那一步**，所以单独一个依赖。 */
  stream?: (body: AskRequestBody) => Promise<string>;
  /** 追加一条误解记录 */
  write?: typeof writeMisconception;
  /** 现造时间（测试注入；不注入就是此刻） */
  now?: Date;
}

/** 一课的位置：正文 + 文件名。文件名是误解记录里「位置」那一半。 */
export interface LessonLookup {
  markdown: string;
  /** `lessons/` 下的文件名，例如 `0003-net.ip.md` */
  file: string;
  /** 相对工作区的路径，例如 `demo/0003-net.ip.md`（与 payload 里 `node.lesson` 同一写法） */
  rel: string;
}

export interface AskRequestInput {
  subject?: unknown;
  node?: unknown;
  /** 选中的那一段 */
  selection?: unknown;
  /** 学生问的那句话 */
  question?: unknown;
  /** 幂等键（面板每次提问现造一个） */
  operationId?: unknown;
  /** 期望的误解记录版本号；给了就校一次（可选） */
  expectedVersion?: unknown;
  /** 覆盖默认模型（一般不用：宿主默认模型就是总控用的那个） */
  provider?: unknown;
  model?: unknown;
}

/* ── 默认依赖（真宿主里的那一套）────────────────────────────────────────── */

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** 课件文件名是 `<序号>-<节点id>.md`，节点 id 里带点，按后缀匹配最稳（与 lib/library.ts 同一判据）。 */
function findLesson(lessonsDir: string, nodeId: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(lessonsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort(cmpCodePoints);
  } catch {
    return null;
  }
  for (const name of names) {
    if (name.slice(0, -3).endsWith('-' + nodeId)) return name;
  }
  return null;
}

/** 真宿主里的读课件：科目目录 → `lessons/` → 后缀匹配。 */
export function readLessonFromWorkspace({ workspace, subject, node }: { workspace: string; subject: string; node: string }): LessonLookup | null {
  if (!subject || subject.includes('/') || subject.includes('\\') || subject.includes('..')) return null;
  const subjectDir = path.resolve(workspace, '.learning', 'subjects', subject);
  if (!isDirectory(subjectDir)) return null;
  const file = findLesson(path.join(subjectDir, 'lessons'), node);
  if (file === null) return null;
  let markdown: string;
  try {
    markdown = fs.readFileSync(path.join(subjectDir, 'lessons', file), 'utf8');
  } catch {
    return null;
  }
  return { markdown, file, rel: `${subject}/${file}` };
}

/** 真宿主里的共享记忆：`.learning/MEMORY.md`；读不到就是空（不是错误）。 */
export function readMemoryFromWorkspace(workspace: string): string {
  try {
    return fs.readFileSync(path.resolve(workspace, '.learning', 'MEMORY.md'), 'utf8');
  } catch {
    return '';
  }
}

/** 从 `ctx.llm.stream(...)` 的块流里拼出整段文本。**唯一会花钱的那一步。** */
export async function collectStream(chunks: AsyncIterable<StreamChunkLike>): Promise<string> {
  let text = '';
  for await (const chunk of chunks) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
  }
  return text;
}

/** 真宿主里的模型调用：`ctx.llm.stream(GenerateOptions)` → 文本。 */
function defaultStream(llm: any): (body: AskRequestBody) => Promise<string> {
  return async (body) => {
    if (typeof llm?.stream !== 'function') throw new Error('ctx.llm 上没有 stream()：这个组合的模型服务是残的');
    return collectStream(llm.stream(body));
  };
}

/** 默认模型选择：宿主 `agentDefaultModel` → 请求体覆盖 → 第一个 provider 的第一个模型。 */
export async function resolveSelection(
  llm: any, preferred: { provider?: unknown; model?: unknown } | null | undefined,
): Promise<{ provider: string; model: string; reason?: string }> {
  const pick = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const preferredProvider = pick(preferred?.provider);
  const preferredModel = pick(preferred?.model);
  if (preferredProvider && preferredModel) return { provider: preferredProvider, model: preferredModel };

  let providers: any[] = [];
  try {
    providers = Array.isArray(llm?.listProviders?.()) ? llm.listProviders() : [];
  } catch {
    providers = [];
  }
  const first = providers[0];
  const firstId = pick(first && typeof first === 'object' ? first.id : first);
  // listModels 空**不等于**不能调（核心路由仍接受未列出的 id），所以这里只把它当「有没有一个
  // 更具体的 id 可用」，拿不到就退回 provider 自己宣告的第一个路由名。
  if (firstId && typeof llm?.listModels === 'function') {
    try {
      const models = await llm.listModels(firstId);
      const firstModel = Array.isArray(models) ? models[0] : null;
      const modelId = pick(firstModel && typeof firstModel === 'object' ? firstModel.id : firstModel);
      if (modelId) return { provider: firstId, model: modelId };
    } catch {
      // 列不出来就往下走：给一句能照着排查的话，别静默用一个猜的 id
    }
  }
  return {
    provider: firstId,
    model: '',
    reason: firstId
      ? `宿主没给出默认模型，provider「${firstId}」也没宣告任何模型——`
        + '在 DSH 的设置里选一次默认模型，或在 studymate-config.yaml 里写 provider / model'
      : '宿主里一个模型 provider 都没注册',
  };
}

/* ── 主流程 ────────────────────────────────────────────────────────────── */

/** 失败的那一格：走唯一信封（`lib/route-envelope.ts`），`available` 是同级字段。 */
function errorView(code: string, message: string, extra: { version?: string } = {}): AskView {
  return { available: true, ...errorBody(code, message, extra) } as AskView;
}

/** 没有可用模型：`available:false` 是**协商结果**，与工具域的 `{available:false, reason}` 同一形状。 */
function unavailableView(reason: string): AskView {
  return { available: false, reason, ...errorBody('model-unavailable', reason) } as AskView;
}

/**
 * 处理一次面板提问。
 *
 * 返回**普通对象**（不是 `Response`）：这样套件能把整份回执逐字段断言，路由那一层只做
 * `Response.json`。`available:false` 与 `ok:false` 是两个不同的失败面，别混成一个：
 *   · `available:false` —— 探测就说没有可用模型（确定，不花钱）；
 *   · `available:true, ok:false` —— 有模型，但这次没答成（超时、provider 报错、回了空话）。
 */
export async function askPanel(deps: AskDeps, input: AskRequestInput = {}): Promise<AskView> {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const question = text(input.question);
  if (question === '') {
    return errorView('question-required', '还没写问题：输入框里那句就是提问原文，误解记录也要用它');
  }
  const subject = text(input.subject);
  const node = text(input.node);
  const readLesson = deps.readLesson ?? readLessonFromWorkspace;
  const lesson = subject && node ? readLesson({ workspace: deps.workspace, subject, node }) : null;
  if (lesson === null) {
    return errorView('lesson-not-found', `读不到这一课的正文（科目 ${subject || '（空）'} · 节点 ${node || '（空）'}）：面板要带上正在读的这一课才答得准`);
  }

  // 能力探测（与工具域同一份判据，见 lib/core/model.ts）
  const capability = probeModel({ get: (name: string) => (name === 'llm' ? deps.llm : undefined) });
  if (!capability.available) {
    // 如实说明，不假装会答：这一条**不写误解记录**——没有回答就没有「回答摘要」，
    // 写一条空壳进学生的档案比不写更糟（报告里记了这处判断）。
    return unavailableView(capability.reason ?? '模型能力不可用');
  }

  const selection = deps.defaultSelection ?? null;
  const chosen = await resolveSelection(deps.llm, {
    provider: input.provider ?? selection?.provider,
    model: input.model ?? selection?.model,
  });
  if (!chosen.provider || !chosen.model) {
    return unavailableView(chosen.reason ?? '没有选定模型');
  }

  let body: AskRequestBody;
  try {
    body = buildAskContext({
      lesson: stripFrontMatter(lesson.markdown),
      selection: input.selection,
      memory: (deps.readMemory ?? readMemoryFromWorkspace)(deps.workspace),
      question,
      provider: chosen.provider,
      model: chosen.model,
    });
  } catch (error) {
    if (error instanceof AskContextError) return errorView(error.field + '-invalid', error.message);
    throw error;
  }

  let raw: string;
  try {
    const stream = deps.stream ?? defaultStream(deps.llm);
    raw = await stream(body);
  } catch (error) {
    return errorView('model-error', `模型没答上来：${error instanceof Error ? error.message : String(error)}`);
  }

  const assembled = assembleAnswer(raw);
  if (assembled.body === '') {
    return { available: true, ok: false, model: { provider: chosen.provider, model: chosen.model }, error: { code: 'model-empty', message: '模型这次一个字的正文都没给（流结束了但内容为空）' } };
  }

  // 回答无痕：**不写会话、不写文件**。要落盘的只有这一条误解记录。
  const summary = assembled.summary || assembled.body;
  const where = lesson.rel || lesson.file;
  const evidence = [
    `提问原文：${question}`,
    `回答摘要：${summary}`,
    `位置：${where}`,
  ].join('\n');
  const write = (deps.write ?? writeMisconception)({
    workspace: deps.workspace,
    subject,
    record: {
      topic: topicFromQuestion(question),
      source: ASK_SOURCE,
      evidence,
      status: '未处理',
      at: undefined,
    },
    expectedVersion: input.expectedVersion,
    operationId: input.operationId,
    now: deps.now,
  });

  const view: AskView = {
    available: true,
    ok: true,
    model: { provider: chosen.provider, model: chosen.model },
    answer: assembled.body,
  };
  if (write.ok) {
    view.misconception = {
      topic: write.entry.topic,
      source: write.entry.source,
      evidence: write.entry.evidence,
      status: write.entry.status,
      at: write.entry.at,
    };
    view.write = { ok: true, version: write.version, replayed: write.replayed };
  } else {
    // 回答已经拿到了，写盘失败不该把它一起吞掉：两件事分开报
    // 写盘失败那半段也走同一份信封（`{ ok:false, error:{ code, message } }`）：面板按码分支、
    // 取那句话给人看，与顶层失败同一个解析路
    view.write = { ok: false, error: write.error, version: write.version };
  }
  return view;
}

/**
 * 课件正文去掉 YAML front matter 再发给模型：`title` / `goal` 那几行是给人看的元信息，
 * 正文的锚点与小节才是模型要读的东西。
 *
 * 为什么不用 `lib/core/lesson.ts` 的解析器：那个解析器会**顺手校验**（缺字段、外链形状…），
 * 而这里只是「把开头那段切掉」——为了切几行去跑一遍带报错收集的全量解析，只会让面板在
 * 一份元信息写得不太规范的课件上答不了。切法是内容格式规范里写死的那一种：首行 `---`，
 * 之后第一行单独的 `---` 收尾；找不到收尾就整段原样发出去。
 */
export function stripFrontMatter(markdown: string): string {
  const source = String(markdown ?? '');
  const lines = source.split(/\r?\n/);
  if (lines.length === 0 || lines[0].replace(/^\ufeff/, '').trim() !== '---') return source;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() === '---') return lines.slice(index + 1).join('\n');
  }
  return source;
}

/* ── 路由注册 ──────────────────────────────────────────────────────────── */

/** `ctx.inject(['connection'], …)` 给的那层上下文：只用到这几个成员。 */
export interface AskRouteContext {
  connection?: { fetch?: { register?: (route: unknown) => unknown } };
  effect?: (fn: () => unknown, description?: string) => unknown;
  get?: (name: string) => unknown;
  inject?: (names: string[], handler: (ctx: unknown) => void) => unknown;
}

/** 超时兜底：`stream()` 卡住时别让面板一直转圈（适配器必须尊重 `signal`，§9.2）。 */
function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return run(controller.signal).finally(() => clearTimeout(timer));
}

/**
 * 把问答路由挂到插件上。
 *
 * 与 `bin/dsh-plugin.ts` 里三条路由同一种姿势：`connection` 就绪才注册，缺了就不挂；
 * 每次请求**现读**工作区与共享记忆（学习文件是纯文本、体量小，目标态 §12「按需扫描足够」）。
 */
export function registerAskRoute(ctx: AskRouteContext): void {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['connection'], (connectionCtx: any) => {
    const connection = connectionCtx?.connection;
    if (!connection?.fetch?.register || typeof connectionCtx.effect !== 'function') return;
    connectionCtx.effect(() => connection.fetch.register({
      path: ASK_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
          return routeError(400, 'body-invalid', '请求体要是 JSON 对象：{ subject, node, selection, question, operationId }', { available: true });
        }
        const workspace = resolveWorkspace();
        if (!workspace) {
          return routeError(500, 'workspace-missing', '没找到学习工作区：~/.dsh/studymate-config.yaml 里没有 workspace。先跑一次 npx @yunmiao/studymate install。', { available: true });
        }
        const llm = connectionCtx.get?.('llm');
        // 宿主默认模型就是总控用的那个（dsh-agent-default-model）；拿不到就退回 provider 自己
        // 宣告的第一个（resolveSelection 里），再拿不到就如实说「选不出模型」。
        let defaultSelection: { provider?: unknown; model?: unknown } | null = null;
        try {
          const service: any = connectionCtx.get?.('agentDefaultModel');
          if (service && typeof service.currentSelection === 'function') defaultSelection = service.currentSelection();
        } catch {
          defaultSelection = null;
        }
        try {
          const view = await askPanel({
            workspace,
            llm,
            defaultSelection,
            stream: async (askBody) => {
              if (typeof (llm as any)?.stream !== 'function') throw new Error('ctx.llm 上没有 stream()：这个组合的模型服务是残的');
              return withTimeout((signal) => collectStream((llm as any).stream({ ...askBody, signal })), ANSWER_TIMEOUT_MS);
            },
          }, body as AskRequestInput);
          // 面板要靠状态码区分「没模型」「写不进去」「答成了」
          const status = view.ok ? 200
            : view.available === false ? 503
              : (view.error?.code === 'question-required' || view.error?.code === 'lesson-not-found' || view.error?.code.endsWith('-invalid')) ? 400
                : 502;
          return Response.json(view, { status });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return routeError(500, 'ask-failed', message, { available: true });
        }
      },
    }), 'studymate: 问答面板路由');
  });
}
