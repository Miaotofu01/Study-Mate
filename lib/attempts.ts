/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 半数据层 —— 作答数据的读取与写入

   `attempts/<NNNN>-<节点id>.json` 与课件**一一对应**（目标态规格 §5.3 + ADR-0007）：
   学生在课件里作答留下的记录（作答历史、错因、上次结果）写在这里，**绝不写回 `.quiz.json`**
   ——题库是模型写的课件内容文件，锚点与正文逐字对应，两边共写同一个文件随时会撞车。

   写入沿用 `reference/` 那两件已经验证过的武器（ADR-0007 点名，判据在 `lib/core/fence.ts`）：
     · **幂等**：同一个 `operationId` 重放只回放上次的回执，不写第二遍；
     · **版本号**：`expectedVersion` 对不上就拒绝并**重读**当前内容，绝不覆盖别人的改动。
   并发来自两侧：学生答题（阅读端）与模型重出题（出题角色）。

   状态只服务「当场回顾」：页面上就地显示「上次你选了 B」。**不做**汇总视图、不排期、
   不算复习队列——那三件事在目标态里已经删了，别顺手加回来。
   ───────────────────────────────────────────────────────────────────────── */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { IdempotencyLedger, checkOperationId, fingerprintOf, OPERATION_ID_MAX } from './core/fence.ts';

/* ── 形状 ──────────────────────────────────────────────────────────────── */

/** 一次作答。字段口径见 `schemas/attempts.schema.json`（中文键名与界面词表一致）。 */
export interface AttemptEntry {
  /** 这次作答的时刻（ISO 8601） */
  时: string;
  /** 客观题选了第几项（从 0 起）；主观题与自评是 null */
  选: number | null;
  /** 这次算不算对：客观题页内判，主观题取学生自评的第一档 */
  对: boolean;
  /** 主观题的自评档（答对了 / 答了一半 / 没答上） */
  自评?: string;
  /** 错因：学生自己写的，或客观题判错时记下的一句 */
  错因?: string;
}

/** 一道题的作答记录。 */
export interface QuestionAttempts {
  /** 题 id（与 `题` 的键相同）：`<锚点文本>#<题号>` */
  id: string;
  作答历史: AttemptEntry[];
  /** 最近一次作答，与 `作答历史` 的最后一项同源（界面就地显示时不必解整条历史） */
  上次结果: AttemptEntry;
}

/** 一份作答数据文件的内容。 */
export interface AttemptsData {
  /** 节点 id */
  节点: string;
  /** 对应的课件文件名（`<NNNN>-<节点id>.md`） */
  课件: string;
  /** 最近一次写入的 operationId（内存台账重启即失，落盘供对账） */
  幂等键?: string;
  /** 最近一次写入的时刻 */
  最后写入: string;
  /** 题 id → 这道题的作答记录 */
  题: Record<string, QuestionAttempts>;
}

/** 读一份作答数据：没有文件返回 null（**不是**空对象——「没作答过」与「读不到」要分得开）。 */
export interface AttemptsRead {
  data: AttemptsData;
  /** 当前版本号；写回时把它当 `expectedVersion` 带上来 */
  version: string;
  /** 文件的绝对路径 */
  file: string;
}

/** 拒绝写入：HTTP 语义由调用方（`bin/dsh-plugin.ts` 一类）映射成状态码。 */
export interface AttemptsRefusal {
  ok: false;
  status: number;
  error: string;
  message: string;
  /** 冲突时顺手带回去的当前作答数据与版本号：界面不必再跑一趟 */
  attempts?: AttemptsData;
  version?: string;
}

/** 写入成功：`attempts`/`version` 是写完之后重读的那一份（下一个 `expectedVersion`）。 */
export interface AttemptsSuccess {
  ok: true;
  attempts: AttemptsData;
  version: string;
}

export type AttemptsWriteResult = AttemptsSuccess | AttemptsRefusal;

/* ── 常量 ──────────────────────────────────────────────────────────────── */

/** 节点 id 的写法与 `curriculum.schema.json` 的 `nodes[].id` 逐字一致；不合法就不拼路径。 */
const NODE_ID_RE = /^[a-z0-9]+([.-][a-z0-9]+)*$/;

/** 一次写入里最多带多少道题：题数是课件规模决定的，这里只挡「有人拿它当数据库灌」。 */
const QUESTIONS_MAX = 200;

/** 一道题最多记多少条历史：回顾只用得上最近几条，留太多等于让文件无界增长。 */
const HISTORY_MAX = 50;

/** 落盘缩进：与 `.quiz.json` 一致（题库是 indent=2 手写风格，作答数据跟着走，diff 才好读）。 */
const JSON_INDENT = 2;

/**
 * 幂等台账：`operationId` → { fingerprint, response }。**只在内存里**，只防同一个宿主进程内的
 * 双击与重试。与 `reference.ts` 各持一份实例：两份台账的指纹算法不同，共用一个 Map 会互相挤掉。
 */
const LEDGER = new IdempotencyLedger<AttemptsWriteResult>();

/* ── 路径 ──────────────────────────────────────────────────────────────── */

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function readTextIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 科目目录的绝对路径。subject 里出现分隔符或 `..` 直接判不合法（与 lib/reference.ts 一致）。 */
function subjectDirOf(workspace: unknown, subject: unknown): string | null {
  if (typeof workspace !== 'string' || !workspace) return null;
  if (typeof subject !== 'string' || !subject || subject.includes('/') || subject.includes('\\') || subject.includes('..')) return null;
  return path.resolve(workspace, '.learning', 'subjects', subject);
}

/**
 * 节点 id 合不合法。合法才拼得出文件名——`../` 之类的写法在这里就被挡下，
 * 不靠「拼完再检查有没有越界」兜底（那种写法漏一次就是写到科目外面）。
 */
function isValidNodeId(node: unknown): node is string {
  return typeof node === 'string' && NODE_ID_RE.test(node);
}

/**
 * 课件的编号前缀（`<NNNN>`，四位数字）。课件文件名是 `<NNNN>-<节点id>.md`，作答数据与它
 * **同名不同后缀**，所以编号只能从课件文件名上取——节点 id 里没有编号，凭空造一个就会错位。
 */
function lessonNumberOf(lessonsDir: string, nodeId: string): string | null {
  let entries;
  try {
    entries = fs.readdirSync(lessonsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name.slice(0, -3).endsWith('-' + nodeId))
    .map((entry) => entry.name)
    .sort();
  const first = names[0];
  if (first === undefined) return null;
  const match = /^(\d{4})/.exec(first);
  return match ? match[1] : null;
}

/** 作答数据文件名：`<NNNN>-<节点id>.json`。 */
function attemptsFileName(number: string, nodeId: string): string {
  return `${number}-${nodeId}.json`;
}

/**
 * 文件内容的版本号（16 位 hex）；文件不在返回空串。
 *
 * **只哈希内容**，不掺 mtime：作答数据是我们自己写的，内容自证最准；`reference/` 那份
 * 掺了 mtime（它的条目是别人放进目录的，只能从盘上量），而 mtime 会因为备份、同步、
 * `touch` 而抖——抖一次就是一次假冲突。
 *
 * 版本号**不写进文件**（写进去就成了「文件里那份」与「读它算出来的那份」两个值，
 * 而它们永远不可能相等：哈希自己包含自己）。它是读写两侧各自算出来的外部量。
 */
function versionOfText(text: string | null): string {
  if (text === null) return '';
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** 文件还没落盘时的空基线：同一份文件名永远算出同一个版本号，第一次写入才带得上 `expectedVersion`。 */
function emptyVersion(file: string): string {
  return createHash('sha256').update(`${path.basename(file)}\u0000`).digest('hex').slice(0, 16);
}

/* ── 读取 ──────────────────────────────────────────────────────────────── */

/** 一份读进来的对象 → `AttemptsData`；形状不对（顶层不是对象）返回 null。 */
function toAttemptsData(value: unknown, nodeId: string, lessonName: string): AttemptsData | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const questions = typeof raw['题'] === 'object' && raw['题'] !== null && !Array.isArray(raw['题'])
    ? raw['题'] as Record<string, unknown>
    : {};
  const out: Record<string, QuestionAttempts> = {};
  for (const [id, entry] of Object.entries(questions)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const history = Array.isArray(item['作答历史'])
      ? item['作答历史'].filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null)
      : [];
    out[id] = {
      id: typeof item.id === 'string' ? item.id : id,
      作答历史: history.map(normalizeEntry),
      上次结果: normalizeEntry(
        typeof item['上次结果'] === 'object' && item['上次结果'] !== null
          ? item['上次结果'] as Record<string, unknown>
          : (history[history.length - 1] ?? {}),
      ),
    };
  }
  return {
    节点: typeof raw['节点'] === 'string' ? raw['节点'] : nodeId,
    课件: typeof raw['课件'] === 'string' ? raw['课件'] : lessonName,
    幂等键: typeof raw['幂等键'] === 'string' ? raw['幂等键'] : undefined,
    最后写入: typeof raw['最后写入'] === 'string' ? raw['最后写入'] : '',
    题: out,
  };
}

/** 历史里的一条：认不出的值一律退回安全默认（宁可少显示一条，也不要给界面一个错的值）。 */
function normalizeEntry(value: Record<string, unknown>): AttemptEntry {
  const chosen = value['选'];
  const entry: AttemptEntry = {
    时: typeof value['时'] === 'string' ? value['时'] : '',
    选: typeof chosen === 'number' && Number.isInteger(chosen) ? chosen : null,
    对: value['对'] === true,
  };
  if (typeof value['自评'] === 'string') entry.自评 = value['自评'];
  if (typeof value['错因'] === 'string') entry.错因 = value['错因'];
  return entry;
}

/** 一次读盘：文本 + 解析后的数据 + 版本号。三个出口共用，栅栏才不会自己抖。 */
function loadAttempts(subjectDir: string, node: string, number: string, lessonName: string):
  { text: string | null; data: AttemptsData | null; version: string; file: string } {
  const file = path.join(subjectDir, 'attempts', attemptsFileName(number, node));
  const text = readTextIfPresent(file);
  if (text === null) return { text: null, data: null, version: emptyVersion(file), file };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON 坏了：当成「读不到」，但版本号仍按原文算——写侧据此能拒绝覆盖一份坏文件
    return { text, data: null, version: versionOfText(text), file };
  }
  return { text, data: toAttemptsData(parsed, node, lessonName), version: versionOfText(text), file };
}

/**
 * 读一个节点的作答数据。文件不在、科目/节点不合法、JSON 坏了、形状不对——一律返回 `null`。
 *
 * **坏了也不抛**：作答数据是**派生记录**（ADR-0007 明说删掉不影响任何学习内容），一份写坏的
 * 作答文件不该让整份 payload 崩掉、更不该拦住学生看课件。读不到就当没作答过。
 */
export function readAttempts({ workspace, subject, node }:
  { workspace?: unknown; subject?: unknown; node?: unknown } = {}): AttemptsRead | null {
  const subjectDir = subjectDirOf(workspace, subject);
  if (subjectDir === null || !isValidNodeId(node)) return null;
  const number = lessonNumberOf(path.join(subjectDir, 'lessons'), node);
  if (number === null) return null;
  const loaded = loadAttempts(subjectDir, node, number, `${number}-${node}.md`);
  if (loaded.data === null) return null;
  return { data: loaded.data, version: loaded.version, file: loaded.file };
}

/** 现有作答数据的版本号；文件不在时给**空清单的基线**（不能给空串：第一次作答没法带期望版本）。 */
export function attemptsVersion({ workspace, subject, node }:
  { workspace?: unknown; subject?: unknown; node?: unknown } = {}): string {
  const subjectDir = subjectDirOf(workspace, subject);
  if (subjectDir === null || !isValidNodeId(node)) return '';
  const number = lessonNumberOf(path.join(subjectDir, 'lessons'), node);
  if (number === null) return '';
  return loadAttempts(subjectDir, node, number, `${number}-${node}.md`).version;
}

/* ── 写入 ──────────────────────────────────────────────────────────────── */

function refusal(status: number, error: string, message: string): AttemptsRefusal {
  return { ok: false, status, error, message };
}

/** now 可注入（测试用）：Date / 毫秒数 / 可解析的字符串都行，读不出来的退回当前时间。 */
function toIso(now: unknown): string {
  if (now === undefined || now === null) return new Date().toISOString();
  const date = new Date(now as string | number | Date);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/** 一次作答的入参：`选`/`自评`/`错因` 由调用方按题型给，这里只做形状收敛。 */
export interface AttemptInput {
  选?: unknown;
  对?: unknown;
  自评?: unknown;
  错因?: unknown;
}

/** 入参 → 一条历史记录。认不出的值按「没选、不对」收——**不猜**（猜成「对了」最坏）。 */
function toEntry(raw: AttemptInput, at: string): AttemptEntry {
  const chosen = raw.选;
  const entry: AttemptEntry = {
    时: at,
    选: typeof chosen === 'number' && Number.isInteger(chosen) && chosen >= 0 ? chosen : null,
    对: raw.对 === true,
  };
  if (typeof raw.自评 === 'string' && raw.自评.trim() !== '') entry.自评 = raw.自评.trim();
  if (typeof raw.错因 === 'string' && raw.错因.trim() !== '') entry.错因 = raw.错因.trim();
  return entry;
}

/**
 * 追加一次作答（或一次批量作答），落进 `attempts/<NNNN>-<节点id>.json`。
 *
 * 返回 `{ok:true, attempts, version}` 或 `{ok:false, status, error, message, attempts?, version?}`。
 * 拒绝码与 `writeReference` 同一套：`operation-id-invalid` / `subject-invalid` / `node-invalid` /
 * `lesson-missing` / `questions-invalid` / `expected-version-required` / `operation-id-conflict` /
 * `version-conflict` / `write-failed`。
 *
 * `questions` 是「题 id → 这次作答」的映射（题 id = `<锚点文本>#<题号>`）。同一次调用里
 * 每一道题各追加一条历史；**没有幂等键的写入一律拒绝**——没有它就分不清双击与新作答。
 */
export function writeAttempts({ workspace, subject, node, questions, expectedVersion, operationId, now }:
  { workspace?: unknown; subject?: unknown; node?: unknown; questions?: unknown;
    expectedVersion?: unknown; operationId?: unknown; now?: unknown } = {}): AttemptsWriteResult {
  // 先把请求体过一遍再碰台账：坏请求不该占用一个 operationId（与 writeReference 同一顺序）
  const verdict = checkOperationId(operationId);
  if (!verdict.ok) {
    return refusal(400, 'operation-id-invalid',
      `缺少或过长的 operationId（上限 ${OPERATION_ID_MAX} 字符）：没有它没法区分重复提交与新作答`);
  }
  const opId = verdict.id;

  const subjectDir = subjectDirOf(workspace, subject);
  if (subjectDir === null) {
    return refusal(400, 'subject-invalid', '科目名不合法：不能为空，也不能带 / 、\\ 或 ..');
  }
  if (!isDirectory(subjectDir)) {
    return refusal(400, 'subject-invalid', `科目不存在：${String(subject)}`);
  }
  if (!isValidNodeId(node)) {
    return refusal(400, 'node-invalid',
      `节点 id 不合法：${JSON.stringify(node)}（要匹配 curriculum.yaml 的 nodes[].id：小写字母数字，用 . 或 - 分段）`);
  }
  const number = lessonNumberOf(path.join(subjectDir, 'lessons'), node);
  if (number === null) {
    // 作答数据与课件一一对应：课件不在就说明这个节点还没有可作答的东西，别先造一份空档案
    return refusal(400, 'lesson-missing', `找不到节点 ${node} 的课件（lessons/<NNNN>-${node}.md）：作答数据与课件一一对应`);
  }
  if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) {
    return refusal(400, 'questions-invalid', 'questions 必须是「题 id → 这次作答」的对象');
  }
  const items = Object.entries(questions as Record<string, AttemptInput>);
  if (items.length === 0) {
    return refusal(400, 'questions-invalid', 'questions 是空的：没有作答内容就没有要写的东西');
  }
  if (items.length > QUESTIONS_MAX) {
    return refusal(400, 'questions-invalid', `一次最多写 ${QUESTIONS_MAX} 道题，实际 ${items.length} 道`);
  }
  for (const [id, item] of items) {
    if (typeof id !== 'string' || id.trim() === '') {
      return refusal(400, 'questions-invalid', '题 id 不能是空串（写法：<锚点文本>#<题号>）');
    }
    if (typeof item !== 'object' || item === null) {
      return refusal(400, 'questions-invalid', `题 ${id} 的作答必须是对象`);
    }
  }
  const version = expectedVersion === undefined || expectedVersion === null ? '' : String(expectedVersion).trim();
  if (version === '') {
    return refusal(400, 'expected-version-required',
      '缺少 expectedVersion：先读一次 payload 拿到该节点的作答版本号再写（没有它挡不住覆盖别人的作答）');
  }

  const dir = path.join(subjectDir, 'attempts');
  const lessonName = `${number}-${node}.md`;
  const at = toIso(now);
  const normalized = items
    .map(([id, item]) => [id.trim(), toEntry(item, at)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const fingerprint = fingerprintOf([
    String(subject), node, lessonName,
    ...normalized.map(([id, entry]) => `${id}\u0001${entry.选 ?? ''}\u0001${entry.对}\u0001${entry.自评 ?? ''}\u0001${entry.错因 ?? ''}`),
  ]);

  // 幂等回放放在版本校验**之前**：第一次写成功之后版本号已经变了，重试带回来的
  // expectedVersion 必然是旧的，先校版本就会把一次正常的重试误判成冲突。
  const lookup = LEDGER.lookup(opId, fingerprint);
  if (lookup.kind === 'replay') return lookup.response;
  if (lookup.kind === 'conflict') {
    return conflict('operation-id-conflict',
      '同一个 operationId 又提交了不同的作答：换个 operationId 再写（这次不写盘）',
      subjectDir, node, number, lessonName);
  }

  const current = loadAttempts(subjectDir, node, number, lessonName);
  if (version !== current.version) {
    // 冲突时拒绝写入并**重读**：把当前作答与版本号一起带回去，界面不必再跑一趟
    return conflict('version-conflict',
      '作答数据已经变了：版本号对不上，这次不写（请按当前内容重来）',
      subjectDir, node, number, lessonName);
  }

  const next: AttemptsData = current.data ?? {
    节点: node, 课件: lessonName, 最后写入: '', 题: {},
  };
  for (const [id, entry] of normalized) {
    const existing = next.题[id];
    const history = existing ? [...existing.作答历史] : [];
    history.push(entry);
    // 历史留最近 HISTORY_MAX 条：回顾只用得上最近几条，无界增长只会让文件越来越难读
    next.题[id] = {
      id,
      作答历史: history.slice(-HISTORY_MAX),
      上次结果: entry,
    };
  }
  next.节点 = node;
  next.课件 = lessonName;
  next.最后写入 = at;
  next.幂等键 = opId;

  const body = `${JSON.stringify(next, null, JSON_INDENT)}\n`;

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return refusal(500, 'write-failed', `建不了 attempts/ 目录：${error instanceof Error ? error.message : String(error)}`);
  }
  const file = path.join(dir, attemptsFileName(number, node));
  try {
    fs.writeFileSync(file, body, 'utf8');
  } catch (error) {
    return refusal(500, 'write-failed', `写不了 ${path.basename(file)}：${error instanceof Error ? error.message : String(error)}`);
  }

  const response: AttemptsWriteResult = {
    ok: true,
    attempts: next,
    version: versionOfText(body),
  };
  LEDGER.remember(opId, fingerprint, response);
  return response;
}

/** 拒绝并**重读**：把当前作答与版本号一起带回去（ADR-0007 的「拒绝并重读」，不引入文件锁）。 */
function conflict(error: string, message: string, subjectDir: string, node: string, number: string, lessonName: string): AttemptsRefusal {
  const current = loadAttempts(subjectDir, node, number, lessonName);
  const base = refusal(409, error, message);
  base.version = current.version;
  if (current.data !== null) base.attempts = current.data;
  return base;
}
