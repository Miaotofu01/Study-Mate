/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 实验域 —— 判分三轨的**第三轨**（issue #77）

   §7.3 的第三轨是「实操题：Host 半代跑学生本地的测试命令，真实输出进作答数据」。这个文件
   就是那一轨的全部入口。四件事，一件比一件重要：

     1. **命令从题目里来**。取值顺序写死在这里：读题库 → 定位那道题 → 题目必须显式写
        `kind: 交付物` → 命令只能从它的 `证据` 字段来。模型与学生**不能**各自现编一条命令：
        参数表里根本没有那个位置。这是本票最重要的一条边界——不然「学生本机代跑」就成了
        「模型在你机器上执行任意命令」。
     2. **跑之前先把边界判完**（`sandbox.ts`）：cwd 与可写路径都在 lab 目录里，参数里的
        绝对路径都不出工作区。判不过就**拒**，并说清为什么。
     3. **跑起来走任务模型**（#73）：长命令有进度、可查、可取消，取消回执说清保留什么。
        实测跑得快的时候，这一次调用里就把事实带回来了，不必让学生再等一轮。
     4. **落进作答数据**（#71 的 `attempts/<NNNN>-<节点id>.json`）：退出码、时长、stdout/stderr
        **原样**写进去（含失败与报错原文）。`对` 是 false、不是判定——通过与否不在这里产生，
        学生的自评由**学生自己**在页面上选（`studymate` 的作答入口），这里只如实记事实。

   「三轨里没有任何一轨叫 agent」在这个文件里的落点：返回值、落盘、渲染文本里都没有
   `通过` / `passed` / `成功` 这类结论字段；`退出码` 是数字，`结局` 只说这次是怎么结束的
   （跑完 / 超时 / 取消）。测试套件按这一点做断言（`test_lab_runner.mjs`）。
   ───────────────────────────────────────────────────────────────────────── */

import { parseCommand, looksLikePath } from './contract.ts';
import { resolveArgumentPath, resolveCwd, resolveWritable } from './sandbox.ts';
import { runCommand, TIMEOUT_MS } from './runner.ts';
import type { RunFacts } from './runner.ts';
import { runLedger } from './ledger.ts';
import { writeAttempts, attemptsVersion } from '../attempts.ts';
import { taskService, defineTaskKind, actorOf } from '../tasks/index.ts';
import type {
  JsonValue, TaskJob, TaskOutcome, TaskService, TaskToolContext, TaskToolRegistry,
} from '../tasks/index.ts';
import { QUESTION_KIND_SHAPES } from '../core/rules.ts';

/* ── 事实的形状（工具输出、台账、作答数据三处共用一份）───────────────────── */

/** 作答数据里那一段的键：`跑`。一个字的键与既有的中文键（`时`/`选`/`对`）同一风格。 */
export const RUN_KEY = '跑';

export interface LabRunFacts extends RunFacts {}

/* ── 从题库里取出那道题的声明 ──────────────────────────────────────────── */

export interface DeliverableQuestion {
  anchor: string;
  index: number;
  id: string;
  item: Record<string, unknown>;
  command: string;
}

export interface StatementProblem {
  code: 'questions-invalid' | 'not-found' | 'not-deliverable' | 'missing-command';
  message: string;
}

/** 题 id = `<锚点文本>#<题号>`（与阅读端、作答数据的口径逐字一致）。 */
export function splitQuestionId(id: unknown): { anchor: string; index: number } | null {
  if (typeof id !== 'string') return null;
  const cut = id.lastIndexOf('#');
  if (cut <= 0) return null;
  const anchor = id.slice(0, cut);
  const digits = id.slice(cut + 1);
  // 题号只认**十进制非负整数**（`Number()` 会把 `1.5`、`+1`、`1e3` 都收下，这里不收）
  if (!/^\d+$/.test(digits)) return null;
  return { anchor, index: Number(digits) };
}

/**
 * `pool` 域读法回来的东西：`{ value, error, … }`（`lib/host/vault.ts` 的读法，结构化对齐、
 * 不 import）。`readFileView` 给的那几个字段（file / present / text / bytes）在运行期也在，
 * 这里只声明用得到的两个。
 */
export interface PoolRead {
  value?: unknown;
  error?: unknown;
}

/**
 * 从题库里取「那道交付物题声明了什么」。**纯函数**：题库由调用方读好递进来。
 *
 * 三条拒绝各有各的话：找不到题、题型不是交付物、交付物题没写命令。第三种在题库校验层
 * 已经会报（`QUESTION_KIND_SHAPES` 的必填字段），但校验层读的是内容文件、这里是运行期，
 * 两边都要能独立说清——运行期不能假设「内容一定已经校验过」。
 */
export function readDeliverable(pool: Record<string, unknown> | null, question: string): DeliverableQuestion | StatementProblem {
  const parsed = splitQuestionId(question);
  if (parsed === null) {
    return {
      code: 'questions-invalid',
      message: `题 id「${String(question)}」读不出锚点与题号：写法是「<锚点文本>#<题号>」，例如「悬垂 else 的归属#2」`,
    };
  }
  if (pool === null) {
    return { code: 'questions-invalid', message: '读不到这个节点的题库（lessons/<NNNN>-<节点id>.quiz.json）：没有题库就没有题目，也就没有命令' };
  }
  const list = pool[parsed.anchor];
  if (!Array.isArray(list)) {
    return { code: 'not-found', message: `题库里没有锚点「${parsed.anchor}」——题库与正文的锚点要逐字对应` };
  }
  const item = list[parsed.index];
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return {
      code: 'not-found',
      message: `锚点「${parsed.anchor}」下没有第 ${parsed.index + 1} 道题（那个锚点下有 ${list.length} 道）`,
    };
  }
  const record = item as Record<string, unknown>;
  if (record['kind'] !== '交付物') {
    const shape = QUESTION_KIND_SHAPES['交付物'];
    return {
      code: 'not-deliverable',
      message: `这道题的类型是「${String(record['kind'] ?? '（没写）')}」，不是「交付物」——`
        + `只有交付物题有可运行证据（必备字段：${shape.required.join('、')}）。`
        + '客观题在页内判、开放题由学生自评，都不需要跑命令',
    };
  }
  const command = record['证据'];
  if (typeof command !== 'string' || command.trim() === '') {
    return {
      code: 'missing-command',
      message: '这道交付物题的「证据」是空的：没有可运行的命令，这一轨就跑不起来。'
        + '让出题那一侧把测试命令写进「证据」字段（ADR-0007：命令是课件内容，不是运行时现编的）',
    };
  }
  return { anchor: parsed.anchor, index: parsed.index, id: question, item: record, command: command.trim() };
}

/**
 * 题库读法返回的东西里，那份 pool。
 *
 * 认两种形状：读法给回来的 `{ value, error }`（`pool` 域的正常出口），以及**已经摊平**的
 * 题库对象本身（测试与别的调用方直接递一份对象进来时）。`error` 在时给 null——让
 * `readDeliverable` 那句「读不到题库」去说，这里不编第二句。
 */
export function poolOf(read: unknown): Record<string, unknown> | null {
  if (typeof read !== 'object' || read === null || Array.isArray(read)) return null;
  const record = read as Record<string, unknown>;
  if (record['error']) return null;
  const pool = 'value' in record ? record['value'] : record;
  return typeof pool === 'object' && pool !== null && !Array.isArray(pool) ? pool as Record<string, unknown> : null;
}

/* ── 任务类型：一次代跑 ────────────────────────────────────────────────── */

export const LAB_TASK_KIND = '实验代跑';
export const LAB_TASK_PREFIX = 'lab';

/** 交给任务跑的入参（JSON 值域，会落进任务记录）。 */
interface LabJobInput {
  workspace: string;
  runDir: string;
  command: string;
  argv: string[];
  cwd: string;
  writable: { 声明: string; 路径: string }[];
  subject: string;
  node: string;
  question: string;
  commandFrom: string;
  /** 学生先写给自己的预测（预测验证题用；可选，写进作答数据）。 */
  预测?: string;
  /** 学生的自评档（可选，**学生给的**，不是模型判的）。 */
  自评?: string;
}

function isLabJobInput(value: unknown): value is LabJobInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.workspace === 'string' && typeof record.runDir === 'string'
    && typeof record.command === 'string' && Array.isArray(record.argv)
    && typeof record.cwd === 'string' && typeof record.subject === 'string'
    && typeof record.node === 'string' && typeof record.question === 'string';
}

/** 任务类型**只登记一次**（`taskService()` 是单例，重复登记会互相顶掉）。 */
let labKindRegistered = false;

export function ensureLabTaskKind(): void {
  if (labKindRegistered) return;
  labKindRegistered = true;
  taskService().registerKind(defineTaskKind({
    kind: LAB_TASK_KIND,
    prefix: LAB_TASK_PREFIX,
    run: runLabJob,
  }));
}

/** 测试用：丢掉「登记过了」这个标记。 */
export function resetLabTaskKind(): void {
  labKindRegistered = false;
}

/**
 * 产出方：跑那条命令，把事实记进台账，再把事实写进作答数据。
 *
 * 取消与超时都在 `runCommand` 里收口（先 SIGTERM 再 SIGKILL），所以这里拿到的永远是**已经
 * 结束**的事实——包括「被杀在半路」的那种：那样也有退出码/信号与半个输出，照样如实落盘。
 * 写盘失败**不让任务失败**：命令确实跑过了，这个事实不能因为一次写不进去就消失。
 */
export async function runLabJob(job: TaskJob, input: unknown): Promise<TaskOutcome> {
  if (!isLabJobInput(input)) throw new Error('[LAB_BAD_INPUT] 这次代跑的入参形状不对（命令、cwd、argv 都要在）');
  const ledger = runLedger();
  const facts = await runCommand({
    command: input.command,
    argv: input.argv,
    cwd: input.cwd,
    writable: input.writable,
    workspace: input.workspace,
    signal: job.signal,
    onProgress: (line) => job.progress(line),
  });

  // 先记账再写作答数据：写盘失败时事实仍在台账里，status 能把它捞出来
  const entry = {
    taskId: job.id,
    subject: input.subject,
    node: input.node,
    question: input.question,
    commandFrom: input.commandFrom,
    facts,
    written: false,
    writeNote: '',
    at: new Date().toISOString(),
  };
  ledger.put(entry);

  // 作答数据的版本号**现读**：这次跑的这段时间里，学生可能刚在页面上作答过（那是常态），
  // 拿调用时的旧版本号会白白撞一次 409。
  const version = attemptsVersion({ workspace: input.workspace, subject: input.subject, node: input.node });
  const written = writeAttempts({
    workspace: input.workspace,
    subject: input.subject,
    node: input.node,
    questions: {
      [input.question]: {
        // `对` 一律 false：这一轨只产生事实，通过与否不由任何人在这里判（学生的自评另走一路）
        选: null,
        对: false,
        ...input.自评 === undefined ? {} : { 自评: input.自评 },
        ...input.预测 === undefined ? {} : { 预测: input.预测 },
        [RUN_KEY]: facts,
      },
    },
    expectedVersion: version,
    // 幂等键由任务 id + attempt 定死：同一个任务的同一轮重放只回放上次回执，不写第二条历史
    operationId: `lab-${job.id}-${job.attempt}`,
  });
  entry.written = written.ok;
  entry.writeNote = written.ok
    ? ''
    : `没能写进作答数据（${written.error}）：${written.message}`;
  ledger.put(entry);

  job.progress(`跑完了：退出码 ${facts.退出码 === null ? '（无，被信号杀掉）' : facts.退出码}｜${facts.毫秒} 毫秒`
    + `${entry.written ? '｜已写进作答数据' : '｜作答数据没写进去'}`);

  return {
    detail: entry.writeNote === ''
      ? `退出码 ${facts.退出码 === null ? `无（信号 ${facts.信号}）` : facts.退出码}，用时 ${facts.毫秒} 毫秒`
      : entry.writeNote,
    // 一次 `stringify` 把事实收敛成 JSON 值域：任务域的 `result` 只收 JSON（它的记录要落盘），
    // 而 `RunFacts` 这个 interface 缺一个索引签名、结构上对不上。**不是**在加工数据——
    // 解析回来的那一份逐字等于事实本身（这一条有测试盯着：作答数据里的 stdout 是原始字节）。
    result: { 跑: JSON.parse(JSON.stringify(facts)) as JsonValue, 已写作答数据: entry.written },
  };
}

/* ── 工具 ──────────────────────────────────────────────────────────────── */

/**
 * 这一次工具调用最多等多久。实测跑得快时这一次就把事实带回来，跑得久就交回句柄
 * （`studymate_task_status` / `_wait` / `_cancel` 接手）。
 *
 * 25 秒这个量级：常见的单元测试跑得完，又短到「工具调用不会挂住会话」。
 */
export const DEFAULT_INLINE_WAIT_MS = 25_000;

/** 单次等待的硬上限（与任务域同一个口径：再长就不是「等」而是「挂着」了）。 */
export const MAX_INLINE_WAIT_MS = 300_000;

/**
 * 生效的等待上限。**只给测试开一个缝**（`STUDYMATE_LAB_INLINE_WAIT_MS`）：长命令那条用例
 * 要验的是「超时之后把句柄交回来」，真等 25 秒会让门禁慢得没人愿意跑。生产路径不设它，
 * 就取 `DEFAULT_INLINE_WAIT_MS`；写了非法值也退回默认——**不猜**。
 */
export function inlineWaitMs(): number {
  const raw = process.env.STUDYMATE_LAB_INLINE_WAIT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_INLINE_WAIT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_INLINE_WAIT_MS) return DEFAULT_INLINE_WAIT_MS;
  return value;
}

const TEXT = { type: 'string' } as const;
const INTEGER = { type: 'integer' } as const;
const NULLABLE_TEXT = { type: ['string', 'null'] } as const;

/** 跑的事实（`runner.ts` 的 `RunFacts`）的 JSON Schema。 */
export const RUN_FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['命令', 'argv', '程序', 'cwd', '可写', '退出码', '信号', '结局', '毫秒',
    'stdout', 'stderr', '字节', '截断', '起不来'],
  properties: {
    命令: TEXT,
    argv: { type: 'array', items: TEXT },
    程序: TEXT,
    cwd: TEXT,
    可写: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['声明', '路径'],
        properties: { 声明: TEXT, 路径: TEXT },
      },
    },
    退出码: { type: ['integer', 'null'] },
    信号: TEXT,
    结局: { type: 'string', enum: ['跑完', '超时', '取消', '起不来'] },
    毫秒: INTEGER,
    stdout: TEXT,
    stderr: TEXT,
    字节: {
      type: 'object', additionalProperties: false, required: ['stdout', 'stderr'],
      properties: { stdout: INTEGER, stderr: INTEGER },
    },
    截断: {
      type: 'object', additionalProperties: false, required: ['stdout', 'stderr'],
      properties: { stdout: { type: 'boolean' }, stderr: { type: 'boolean' } },
    },
    起不来: TEXT,
  },
} as const;

const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['id', 'status', 'kind', 'label'],
  properties: { id: TEXT, status: TEXT, kind: TEXT, label: TEXT },
} as const;

/** 「不是跑，是拒」的那一支。拒也是**结果**，说清为什么、下一步照着做什么。 */
const REFUSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['为什么', '下一步'],
  properties: { 为什么: TEXT, 下一步: TEXT, 边界: TEXT },
} as const;

export const LAB_RUN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['状态', '说明', '任务'],
  properties: {
    状态: { type: 'string', enum: ['跑完了', '还在跑', '拒了'] },
    说明: TEXT,
    命令来源: TEXT,
    任务: { oneOf: [TASK_VIEW_SCHEMA, { type: 'null' }] },
    跑: { oneOf: [RUN_FACTS_SCHEMA, { type: 'null' }] },
    作答数据: TEXT,
    拒: { oneOf: [REFUSAL_SCHEMA, { type: 'null' }] },
  },
} as const;

export const LAB_RUN_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'node', 'question'],
  properties: {
    subject: { type: 'string', description: '科目 slug（subjects/<slug>/ 的那一段）。' },
    node: { type: 'string', description: '节点 id（curriculum.yaml 的 nodes[].id）。' },
    question: { type: 'string', description: '题 id：<锚点文本>#<题号>。命令从这道交付物题的「证据」字段来。' },
    cwd: { type: 'string', description: '命令的落脚点，相对这个节点的 lab 实验目录（默认 .）。' },
    writable: {
      type: 'array', items: TEXT,
      description: '声明这次运行会写的路径，相对实验目录；没声明的写在边界之外一律不算数。',
    },
    predicted: { type: 'string', description: '学生先写下的预测（预测+验证题型用），与真实输出一起落进作答数据。' },
    selfAssessment: {
      type: 'string', enum: ['答对了', '答了一半', '没答上'],
      description: '学生自己的自评档——只有学生能选，模型不许替他填。',
    },
  },
} as const;

/** 一次代跑的**结论形状**（不含结论）：给工具与测试共用。 */
export interface LabRunOutcome {
  状态: '跑完了' | '还在跑' | '拒了';
  说明: string;
  命令来源: string;
  任务: unknown;
  跑: RunFacts | null;
  作答数据: string;
  拒: { 为什么: string; 下一步: string; 边界?: string } | null;
}

function refused(why: string, next: string, boundary?: string): LabRunOutcome {
  return {
    状态: '拒了', 说明: '这次没有跑任何命令。', 命令来源: '', 任务: null, 跑: null, 作答数据: '',
    拒: { 为什么: why, 下一步: next, ...boundary === undefined ? {} : { 边界: boundary } },
  };
}

/**
 * 这次代跑要碰的东西都定好了之后，才轮到任务域起活。
 *
 * 为什么「定」与「跑」分开：边界判不过就不能起任务——起一个注定被拒的任务只会让板子上
 * 多一条噪音记录，还会让「可取消」这句话变得可疑。
 */
export interface LabPlan {
  workspace: string;
  subject: string;
  node: string;
  question: string;
  commandFrom: string;
  command: string;
  argv: string[];
  cwd: string;
  runDir: string;
  writable: { 声明: string; 路径: string }[];
  predicted?: string;
  selfAssessment?: string;
}

const FACT_LINE = (facts: RunFacts, where: string): string => [
  `命令：${facts.命令}`,
  `程序：${facts.程序 === '' ? '（没解析到，它多半不在 PATH 上）' : facts.程序}`,
  `落脚点：${facts.cwd}${where === '' ? '' : `（${where}）`}`,
  `结局：${facts.结局}｜退出码：${facts.退出码 === null ? '无（被信号杀掉）' : String(facts.退出码)}`
    + `${facts.信号 === '' ? '' : `｜信号：${facts.信号}`}｜用时 ${facts.毫秒} 毫秒`,
  `可写：${facts.可写.length === 0 ? '（这次没声明任何可写路径）' : facts.可写.map((one) => one.声明).join('、')}`,
  ...facts.起不来 === '' ? [] : [`起不来：${facts.起不来}`],
  `标准输出（${facts.字节.stdout} 字节${facts.截断.stdout ? '，截断' : ''}）：`,
  facts.stdout === '' ? '（空）' : facts.stdout,
  `标准错误（${facts.字节.stderr} 字节${facts.截断.stderr ? '，截断' : ''}）：`,
  facts.stderr === '' ? '（空）' : facts.stderr,
  '以上是这次运行的原始记录（含非零退出码与报错原文）。通过与否不在这一层——'
    + '你自己看输出，自评由你在页面上选。',
].join('\n');

const NEXT_HINT = '要看/要等/要取消它：studymate_task_status、studymate_task_wait、studymate_task_cancel（id 就是上面那个）。';

export function renderLabRun(value: LabRunOutcome): { type: 'text'; text: string }[] {
  if (value.状态 === '拒了' && value.拒 !== null) {
    return [{
      type: 'text',
      text: `没跑：${value.拒.为什么}\n下一步：${value.拒.下一步}`
        + `${value.拒.边界 === undefined ? '' : `\n边界：${value.拒.边界}`}`,
    }];
  }
  if (value.跑 !== null) {
    return [{
      type: 'text',
      text: `${FACT_LINE(value.跑, '')}\n${value.作答数据 === '' ? '' : `作答数据：${value.作答数据}\n`}${value.说明}`,
    }];
  }
  const task = value.任务 as { id?: string; status?: string; progress?: { line?: string } } | null;
  return [{
    type: 'text',
    text: `还在跑：${task?.id ?? ''}（${task?.status ?? ''}）`
      + `${task?.progress?.line === undefined ? '' : `｜${task.progress.line}`}\n${value.说明}\n${NEXT_HINT}`,
  }];
}

/* ── 工具定义 ──────────────────────────────────────────────────────────── */

/** 工具域 `define.ts` 的 `StudyToolSpec` 里我们用到的部分（结构化对齐，不 import：域图不成环）。
 *
 *  **它是手抄的，所以有一条测试钉着**（`test_lab_runner.mjs` 的「结构对齐」）：两份接口的
 *  顶层键与可选性逐条对账，`labRunTool()` 真造出来的对象也拿来数键。别只改一边——
 *  `registerLabTools` 里那句 `as unknown as` 会把类型不符一起咽下去，靠 tsc 拦不住。 */
export interface LabToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: any, value: any) => { type: 'text'; text: string }[];
  };
  reads: readonly string[];
  writes: Readonly<Record<string, readonly string[]>>;
  execute: (args: any, run: any) => Promise<unknown>;
}

/**
 * 这个工具的**域声明**。工具域造工具时用它，Web 路由自己造 `access` 时也用它——
 * 两条入口读同一批域、写同一个字段，声明表只有一份（`test_lab_runner.mjs` 按它断言）。
 */
export const LAB_READS: readonly string[] = ['pool', 'lab', 'attempts', 'workspace'];
export const LAB_WRITES: Readonly<Record<string, readonly string[]>> = { attempts: ['**'] };

/**
 * 造那个工具。`service` 由注册点那一份单例传进来——工具、路由、产出的任务必须看同一份台账。
 *
 * 形状与 `planLabRun` 一样是刻意的：**命令从题目里来、边界先判完、跑走任务模型、事实进作答
 * 数据**，这四步在工具与 Web 路由两条入口上共用一个实现（`startLabRun` / `settledRunOutcome`）。
 * 两边各写一遍的话，早晚会有一边忘了判某一条边界——那正是这张票要防的事。
 */
export function labRunTool(service: TaskService): LabToolSpec {
  return {
    name: 'studymate_lab_run',
    description: '把一道交付物题里声明的测试命令在 lab 目录里代跑一遍，真实输出原样记进作答数据。',
    parameters: LAB_RUN_PARAMETERS,
    reads: LAB_READS,
    writes: LAB_WRITES,
    output: {
      schema: LAB_RUN_OUTPUT_SCHEMA,
      render: (_args, value: LabRunOutcome) => renderLabRun(value),
    },
    execute: async (args: LabRunArgs, run: {
      access: LabAccess;
      signal?: AbortSignal; agent?: string;
    }): Promise<LabRunOutcome> => {
      const plan = planLabRun(run.access, args);
      if ('拒' in plan) return plan;
      return startLabRun(service, plan, {
        actor: actorOf(run),
        waitMs: inlineWaitMs(),
        ...run.signal === undefined ? {} : { signal: run.signal },
      });
    },
  };
}

/* ── 计划与执行：工具与 Web 路由共用（见 labRunTool 的注释）──────────────── */

/**
 * 「读得来域数据」的最小面：`access.read(domain, target?, options?)`。
 * 工具域 `DomainAccess` 与路由自己造的那一个都满足它（结构化对齐，**不 import 工具域**：
 * 域图上只有「工具域 → 实验域」一条边，见 `lib/lab/index.ts` 的文件头）。
 *
 * `domain` 用 `any` 而不是 `string`：工具域那边是 `Domain` 联合类型，`string` 收窄不了它
 * （反过来也不行），两边用一个共同的宽类型对齐是这里唯一的办法。**运行期一道校验都不少**
 * ——域名的合法性由 `createAccess` 判，写错一个字母当场抛（`lib/host/access.ts`）。
 */
export interface LabAccess {
  read: (domain: any, target?: string, options?: unknown) => unknown;
}

export interface LabRunArgs {
  subject: string;
  node: string;
  question: string;
  cwd?: string;
  writable?: readonly string[];
  predicted?: string;
  selfAssessment?: string;
}

export function planLabRun(access: LabAccess, args: LabRunArgs): LabPlan | LabRunOutcome {
  // ── 1. 命令的来源：题库里那道交付物题的「证据」字段 ──────────────────
  // 读盘会抛（科目不存在、没工作区、域没声明……）：**转成一句能照着改的拒绝**，
  // 别让一句栈里的 `Error` 直接穿到调用方那里——那读起来像插件坏了，而其实是「你这个
  // 参数指向的东西不在」。域 guard 的 DomainViolationError 走同一条路（它带前缀，
  // 一眼能认出来）。
  let read: DeliverableQuestion | StatementProblem;
  try {
    read = readDeliverable(
      poolOf(access.read('pool', args.subject, { node: args.node })),
      args.question,
    );
  } catch (error) {
    return refused(
      `读不到科目「${args.subject}」节点 ${args.node} 的题库：${error instanceof Error ? error.message : String(error)}`,
      '先确认这个科目与节点真的在 .learning/subjects/ 下（科目 slug 就是那个目录名），'
      + '再让出题那一侧把这道交付物题补齐。',
    );
  }
  if ('code' in read) return refused(read.message, '换一道交付物题，或者让出题那一侧把这条题补齐。');
  const commandFrom = `题目「${read.id}」的「证据」字段`;

  // ── 2. 命令的文法 ───────────────────────────────────────────────────
  const parsed = parseCommand(read.command);
  if (!parsed.ok) {
    return refused(`题目里那条命令读不下来：${parsed.reason}`, '把命令改成「程序 + 参数」的裸词形态，'
      + '复杂的部分写成 lab 目录里的脚本文件。', `命令原文：${read.command}`);
  }

  // ── 3. 边界：lab 目录、cwd、可写范围、参数里的路径 ───────────────────
  const labRead = access.read('lab', args.subject, { node: args.node }) as
    { node: string; runDir: string | null } | null;
  if (labRead === null || labRead.runDir === null) {
    return refused(
      `节点 ${args.node} 没有对应的 lab 实验目录（lab/<NNNN>-<短名>/ 里的编号与课件位次对齐）。`,
      '没有实验目录就没有可以跑命令的地方——这一课多半是概念课，本来就产不出交付物。',
    );
  }
  const workspace = (access.read('workspace') as { path: string }).path;
  const runDir = labRead.runDir;

  const cwdVerdict = resolveCwd(runDir, args.cwd ?? '.');
  if (!cwdVerdict.ok) {
    return refused(cwdVerdict.reason, '把 cwd 写成实验目录里的一个相对路径（`.` 就是实验目录本身）。',
      `允许的范围：${cwdVerdict.within ?? runDir}`);
  }

  const writable: { 声明: string; 路径: string }[] = [];
  for (const given of args.writable ?? []) {
    const verdict = resolveWritable(runDir, given);
    if (!verdict.ok) {
      return refused(verdict.reason, '把可写路径写成实验目录里的相对路径（例如 result.txt / build/）。',
        `允许的范围：${verdict.within ?? runDir}`);
    }
    writable.push({ 声明: given, 路径: verdict.resolved });
  }

  for (const token of parsed.argv.slice(1)) {
    if (!looksLikePath(token)) continue;
    const verdict = resolveArgumentPath(workspace, cwdVerdict.resolved, token);
    if (!verdict.ok) {
      return refused(verdict.reason, '参数里只写实验目录内的相对路径；要引用工作区里的东西，'
        + '也把路径写在工作区之内。', `允许的范围：${verdict.within ?? workspace}`);
    }
  }

  return {
    workspace,
    subject: args.subject,
    node: args.node,
    question: args.question,
    commandFrom,
    command: read.command,
    argv: parsed.argv,
    cwd: cwdVerdict.resolved,
    runDir,
    writable,
    ...args.predicted === undefined ? {} : { predicted: args.predicted },
    ...args.selfAssessment === undefined ? {} : { selfAssessment: args.selfAssessment },
  };
}

/**
 * 起任务 + 等一等 + 把事实带回来。**工具与路由共用这一个**（命令已经由 `planLabRun` 定死）。
 *
 * `waitMs` 由调用方给：原生工具用 `inlineWaitMs()`（模型的一次调用可以等久一点），
 * Web 路由用更短的（HTTP 请求不该挂住浏览器）。超时两边都是同一句话：句柄交回去，
 * `studymate_task_status` / `_wait` / `_cancel` 或 `GET /api/studymate/tasks` 接手。
 */
export async function startLabRun(service: TaskService, plan: LabPlan, options: {
  actor: string;
  signal?: AbortSignal;
  waitMs: number;
}): Promise<LabRunOutcome> {
  // 任务类型在这里登记（不是在各入口）：起活是**唯一**的瓶颈口，两条入口（原生工具与 Web
  // 路由）都从这儿过。分开登记的结果是「有一条入口忘了登记」，而那条入口的表现是
  // `[TASK_BAD_KIND] 没有登记的任务类型`——一条只有真跑起来才看得见的错。
  ensureLabTaskKind();
  const input: LabJobInput = {
    workspace: plan.workspace, runDir: plan.runDir, command: plan.command, argv: plan.argv,
    cwd: plan.cwd, writable: plan.writable, subject: plan.subject, node: plan.node,
    question: plan.question, commandFrom: plan.commandFrom,
    ...plan.predicted === undefined ? {} : { 预测: plan.predicted },
    ...plan.selfAssessment === undefined ? {} : { 自评: plan.selfAssessment },
  };
  const handle = service.start(options.actor, {
    kind: LAB_TASK_KIND,
    label: `代跑交付物题：${plan.subject}/${plan.node}｜${plan.command}`,
    input: input as unknown as JsonValue,
    durable: false,
  });
  const waited = await service.wait(options.actor, handle, {
    timeoutMs: options.waitMs,
    ...options.signal === undefined ? {} : { signal: options.signal },
  });
  if (!waited.settled) {
    return {
      状态: '还在跑',
      说明: `命令最长跑 ${Math.round(TIMEOUT_MS / 1000)} 秒；这一次等了 `
        + `${Math.round(waited.waitedMs / 1000)} 秒还没结束。${waited.next}`,
      命令来源: plan.commandFrom,
      任务: waited.task,
      跑: null,
      作答数据: '',
      拒: null,
    };
  }
  return settledRunOutcome(service, options.actor, handle.id, plan);
}

/** 任务收尾之后把事实（或「没有事实」那句拒绝）凑出来；工具与路由共用。 */
export function settledRunOutcome(service: TaskService, actor: string, taskId: string, plan: LabPlan): LabRunOutcome {
  const status = service.status(actor, taskId);
  const entry = runLedger().get(taskId);
  if (entry === null || entry.facts === null) {
    return refused(
      `任务 ${taskId} 结束了（${status.status}）但没有留下跑的事实：${status.detail ?? '没有细节'}。`,
      '这多半是命令起不来（程序名不在 PATH 上）：把命令里的程序换成 lab 目录里那份脚本、'
      + '或者工作区里虚拟环境里的解释器，再跑一次。',
    );
  }
  return {
    状态: '跑完了',
    说明: entry.written
      ? `真实输出已经原样写进作答数据（attempts/ 里那道题的「${RUN_KEY}」）。`
      : `事实拿到了，但作答数据没写进去：${entry.writeNote}`,
    命令来源: plan.commandFrom,
    任务: status,
    跑: entry.facts,
    作答数据: entry.written
      ? `attempts/｜题 ${plan.question}｜字段「${RUN_KEY}」`
      : '',
    拒: null,
  };
}

/* ── 注册 ──────────────────────────────────────────────────────────────── */

export const LAB_TOOL_NAMES = ['studymate_lab_run'] as const;

/**
 * 把一个实验域挂到插件上。注册点（`lib/tools/index.ts`）只加一行：
 *
 *     registerLabTools(ctx, { registerStudyTool });
 *
 * 与任务域同一个姿势：`registerStudyTool` 是注册点注入进来的，实验域**不 import 工具域**
 * ——域图上只有「工具域 → 实验域」一条边，不会成环（架构边界测试按域查环、默认拒绝）。
 */
export function registerLabTools(ctx: TaskToolContext, registry: TaskToolRegistry): void {
  ensureLabTaskKind();
  registry.registerStudyTool(ctx, labRunTool(taskService()) as unknown as Parameters<TaskToolRegistry['registerStudyTool']>[1]);
  // 卸载时把台账收尾（事实已经落盘，这一步是给「卸载也要有收尾」一个明确的落点）
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      runLedger().flush();
    }, 'studymate: 实验代跑台账（收尾落盘）');
  }
}
