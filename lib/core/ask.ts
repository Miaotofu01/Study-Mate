/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 —— 问答面板的上下文组装（目标态规格 §7.4）

   规格那句话是这条链路的**契约**，不是描述：

     「上下文只带：当前课件、选中文本、共享记忆。不背整个会话。」

   所以组装这一步单独成模块、**出入都是值**（不碰文件系统、不碰 ctx），面板那条路由只是把
   三样原料读出来交给它。好处是「请求体里到底带了什么」可以被一条测试钉死——发出去的每一样
   东西都必须来自这里，别在路由里顺手 `messages.push(...)` 补一句（那就等于偷偷把会话背上了）。

   请求体的形状刻意是**固定**的：

     { provider, model, system, messages, temperature, maxTokens }

   三样上下文**只**出现在 `messages[0].content[0].text` 里，逐段带小标题：

     共享记忆 / 当前课件 / 选中文本 / 我的问题

   为什么 `system` 不算第四样：它是**角色与答复格式**（同一段字符串对每个请求都一样），不含
   任何学生数据。它进 `GenerateOptions.system` 而不是 `messages[0]`——`dsh-plugin-api.md`
   §9.2 写明 `system` 是「one-shot callers 的系统提示位」，适配器把它映射到 provider 的
   system slot；塞进 messages 反而会让适配器把它当成对话历史的一部分。

   为什么没有 `sessionId`：那是 `dsh-agent-loop` 给会话请求盖的路由戳（§9.2）。面板是**一次
   性**调用，不属于任何会话——不盖这个戳，也就没有「回答进了会话记录」这条缝。
   ───────────────────────────────────────────────────────────────────────── */

/** 请求体里的角色说明：**每个请求都一样**，不含学生数据（所以它不是「第四样上下文」）。 */
export const ASK_SYSTEM_PROMPT = [
  '你是学习阅读端的就地答疑助手。学生正在读一份课件，划出了其中一段，问了一个问题。',
  '',
  '怎么答：',
  '1. 先给答案，再给一句为什么；控制在 200 字内。',
  '2. 只讲这一段相关的知识，别把整块知识重讲一遍；问题超出片段范围就直说「这值得单独讲」。',
  '3. 学生贴的是代码或报错就给最小修复片段；是概念就给一句话例子。',
  '4. 不要出题、不要布置作业、不要盘问、不要要求学生确认什么。',
  '5. 课件里没写的，不要编；不确定就说不确定。',
  '',
  '输出格式（务必照做）：',
  '【回答】你的答案',
  '【摘要】一句话说清这次问的是哪个知识点、你给了什么答案（给下一轮开场读，30 字内）',
].join('\n');

/** 共享记忆上限（字符）。**按规模的比例写**，不写「多少秒」：一份 MEMORY.md 正常在千字级。 */
export const MEMORY_LIMIT = 6000;

/** 当前课件上限（字符）。一份课件正常在一两千字；超长的按尾部截断，并在正文里标出来。 */
export const LESSON_LIMIT = 12000;

/** 摘要上限（字符）。`【摘要】` 缺失时用它兜一个：宁可截断，也不要写一整段进误解记录。 */
export const SUMMARY_LIMIT = 60;

/** 组装请求体时缺了必填原料。路由把它映射成 400——**不猜**、也不用空串糊过去。 */
export class AskContextError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'AskContextError';
    this.field = field;
  }
}

/** 三样原料（加路由信息）。`provider` / `model` 不属于上下文，是路由选择。 */
export interface AskContextInput {
  /** 当前课件正文（Markdown 原文） */
  lesson?: unknown;
  /** 选中的那一段（学生在正文里划出来的） */
  selection?: unknown;
  /** 共享记忆（工作区 `.learning/MEMORY.md` 原文） */
  memory?: unknown;
  /** 学生问的那句话 */
  question?: unknown;
  /** 用哪个 provider 路由 */
  provider?: unknown;
  /** 用哪个模型 id */
  model?: unknown;
}

/** 请求体：`GenerateOptions` 的子集（只写我们真的填的字段）。 */
export interface AskRequestBody {
  provider: string;
  model: string;
  system: string;
  messages: { role: 'user'; content: { type: 'text'; text: string }[] }[];
  temperature: number;
  maxTokens: number;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 按**码位**截断（不是 UTF-16 码元）：中文与 emoji 都不会被截成半个字。 */
function clamp(value: string, limit: number): string {
  const chars = [...value];
  if (chars.length <= limit) return value;
  return chars.slice(0, limit).join('');
}

/**
 * 组装发给模型的那一次请求。
 *
 * 缺 `lesson` / `question` 直接抛 `AskContextError`——两样都缺的请求没有意义，静默发一次
 * 空上下文的调用既花钱又给不出对的答案。`selection` 与 `memory` 可以缺：没划中段落时面板
 * 本来就允许直接打字提问，共享记忆在工作区里也可能还是空的。
 */
export function buildAskContext(input: AskContextInput = {}): AskRequestBody {
  const lesson = text(input.lesson);
  if (lesson === '') {
    throw new AskContextError('lesson', '当前课件是空的：面板要带上正在读的这一课才答得准');
  }
  const question = text(input.question);
  if (question === '') {
    throw new AskContextError('question', '还没写问题：输入框里那句就是提问原文，误解记录也要用它');
  }
  const provider = text(input.provider);
  if (provider === '') {
    throw new AskContextError('provider', '没有可用的模型 provider：宿主里一个 adapter 都没注册');
  }
  const model = text(input.model);
  if (model === '') {
    throw new AskContextError('model', '没有选定模型：宿主没给出默认模型，也没在配置里指定');
  }

  const selection = text(input.selection);
  const memory = text(input.memory);
  // 超限**截断并标注**，不静默丢：一份超长记忆被整段丢掉，模型会答得比实际更差，而没人知道为什么
  const memoryPart = memory === ''
    ? ''
    : clamp(memory, MEMORY_LIMIT) + (memory.length > MEMORY_LIMIT ? '\n（共享记忆太长，只带了开头一段）' : '');
  const lessonPart = clamp(lesson, LESSON_LIMIT)
    + (lesson.length > LESSON_LIMIT ? '\n（课件太长，只带了开头一段）' : '');

  const sections = [
    memoryPart === '' ? '' : `【共享记忆】\n${memoryPart}`,
    `【当前课件】\n${lessonPart}`,
    selection === '' ? '' : `【选中文本】\n${selection}`,
    `【我的问题】\n${question}`,
  ].filter((part) => part !== '');

  return {
    provider,
    model,
    system: ASK_SYSTEM_PROMPT,
    // 一条 user 消息，四段小标题：这就是「只带三样上下文」的全部载体。
    // **不要**在这里补第二组 messages（那会把上一次问答带上，等于背了会话）。
    messages: [{ role: 'user', content: [{ type: 'text', text: sections.join('\n\n') }] }],
    temperature: 0.2,
    maxTokens: 800,
  };
}

/** 只取请求体里那一条 user 消息的文本（测试与排障用：请求体「带了什么」看这一句就够）。 */
export function askContextText(body: AskRequestBody): string {
  const message = body.messages[0];
  if (!message || !Array.isArray(message.content)) return '';
  return message.content.map((block) => (block && block.type === 'text' ? block.text : '')).join('');
}

/* ── 模型答复 → 回答正文 + 摘要 ──────────────────────────────────────────── */

const ANSWER_MARK = '【回答】';
const SUMMARY_MARK = '【摘要】';

/**
 * 把模型的整段输出拆成「回答正文」与「一句话摘要」。
 *
 * 摘要为什么要模型给：规格要求误解记录里带「回答摘要」——那是给下一轮开场读的，由答的人
 * 自己总结比事后从正文里截前 60 字准得多。模型没照格式来时**不假装**：退回把正文压成
 * 一句（`summarizeAnswer`），界面上照常能显示，只是摘要质量差一点。
 */
export function assembleAnswer(raw: unknown): { body: string; summary: string } {
  const full = typeof raw === 'string' ? raw.trim() : '';
  if (full === '') return { body: '', summary: '' };

  const summaryAt = full.indexOf(SUMMARY_MARK);
  const answerAt = full.indexOf(ANSWER_MARK);
  if (answerAt < 0 && summaryAt < 0) {
    // 完全没按格式：整段就是答案，摘要压一句
    return { body: full, summary: summarizeAnswer(full) };
  }
  const bodyEnd = summaryAt >= 0 ? summaryAt : full.length;
  const bodyStart = answerAt >= 0 ? answerAt + ANSWER_MARK.length : 0;
  const body = full.slice(bodyStart, bodyEnd).trim();
  const summary = summaryAt >= 0
    ? clamp(full.slice(summaryAt + SUMMARY_MARK.length).trim().replace(/\s+/gu, ' '), SUMMARY_LIMIT)
    : '';
  // 【摘要】给了但【回答】没给（模型答歪了）：别把摘要当答案，两样都退回正文
  if (body === '') return { body: full, summary: summary || summarizeAnswer(full) };
  return { body, summary: summary || summarizeAnswer(body) };
}

/** 把一段正文压成一句话：去掉 Markdown 记号、折成一行、按码位截断。 */
export function summarizeAnswer(value: unknown): string {
  const flat = String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return clamp(flat, SUMMARY_LIMIT);
}

/**
 * 误解记录的 `topic`：卡在哪。
 *
 * **不**问模型要：模型给的 topic 每次措辞都不一样，而 `topic` 要能跟课件的小节标题对上
 * （目标态规格 §5.4）。所以从学生自己那句提问里取第一个句子——提问原文本身就是最好的定位，
 * 且完全确定（同一次提问永远得到同一个 topic）。
 */
export function topicFromQuestion(value: unknown, limit = 40): string {
  const flat = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (flat === '') return '';
  const cut = flat.split(/[。！？?!；;\n]/)[0].trim() || flat;
  return clamp(cut, limit);
}
