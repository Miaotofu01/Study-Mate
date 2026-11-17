/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 半数据层 —— 课件页标注的读取与写入

   `annotations/<NNNN>-<节点id>.json` 与课件**一一对应**（ADR-0021）：学生在课件页
   划选正文留下的高亮与注释（一条 = 若干段划选 + 一句注释）写在这里，**绝不写回
   `.md` / `.quiz.json`**——课件是模型写的、下次重写会整段覆盖；题库的锚点对账也依赖
   逐字内容（ADR-0007 的同一份理由，对课件正文一样成立）。

   这是 ADR-0004 的又一处破例，但破法是**新增而非改动**：科目目录下多一个新的
   `annotations/` 子目录、包里多一份 `schemas/annotations.schema.json`；已有文件名、
   已有目录结构、已有 schema 一律不动，旧工作区没有 `annotations/` 照样能开（读侧
   按需存在，第一次标注才创建目录），零迁移。ADR-0010 那边也不是第三条写入路径：
   标注与 `attempts/` 是**同一族**——同为学生对内容的反应、同为派生记录（删掉不损失
   任何学习内容）、同为模型直接可读的普通 JSON，所以它落在 ADR-0010 已经批准的
   「阅读端只能碰 `reference/` 与作答数据」那一侧。

   写入沿用 `reference/` 与 `attempts/` 那两件已经验证过的武器（ADR-0007 点名，判据在
   `lib/core/fence.ts`）：
     · **幂等**：同一个 `operationId` 重放只回放上次的回执，不写第二遍；
     · **版本号**：`expectedVersion` 对不上就拒绝并**重读**当前内容，绝不覆盖别人的改动。
   **台账实例独立**（`LEDGER` 是这一份模块自己的）：三个数据域的指纹算法与回执类型都
   不同，共用一个 Map 会互相挤掉（`LEDGER_MAX` 是共享的），幂等会在最需要它时失效。

   **块切分只由客户端说了算**（ADR-0021 的 Consequences 第一条）：一条标注定位的是
   「行号 + 块类型 + 块文本指纹 + 块内码位区间」，而 `parseBlocks` 住在阅读端、
   与 `lib/core/format.ts` 是两份独立实现（客户端更宽松）。所以这一层**不解析课件**：
   写入时不重新切块、读回时也不重新切块，只做字节存储 + 版本栅栏。代价是 Host 无法
   校验 range 指向的块是否真实存在——那是客户端渲染时按 resolved / stale / ambiguous /
   missing 四态对账的职责，不是写入前的判据。**别顺手在这里加一个「校验块还在不在」的
   分支**：那等于把第二份块切分实现搬进数据层，双解析器的漂移就会渗进盘上的数据。

   **全量替换语义**：`annotations` 入参是一整份标注数组，落盘转成「标注 id → 一条标注」
   的对象（键 = id，与 `attempts` 的「题 id → 作答」同一形状）。创建、编辑、删除都由一次
   写入表达——删除是「这次数组里没有它」，清空是空数组（**文件仍写出**：`标: {}`，让
   「学生删光了」与「从来没标过」在盘上分得开，版本栅栏也照旧）。

   **派生记录**（ADR-0021 与 ADR-0007 同一口径）：删掉标注不损失任何学习内容；一份写坏的
   标注文件不该让整份 payload 崩掉、更不该拦住学生看课件——读侧坏了不抛，当「没有标注」。
   ───────────────────────────────────────────────────────────────────────── */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { IdempotencyLedger, checkOperationId, fingerprintOf, OPERATION_ID_MAX } from './core/fence.ts';
import { errorBody } from './route-envelope.ts';
import type { RouteErrorEnvelope } from './route-envelope.ts';

/* ── 形状 ──────────────────────────────────────────────────────────────── */

/**
 * 一段划选：某个块里的字符区间。
 *
 * 字段口径见 `schemas/annotations.schema.json`。`line` / `kind` / `hash` / `start` / `end`
 * 全部由客户端算好后交上来——尤其是 `hash`（块文本指纹）：Host **不重算**它，只原样存。
 */
export interface AnnotationRange {
  /** 块所在的行号（1 起，指课件正文的行） */
  line: number;
  /** 客户端块类型词表里的词（para / heading / quote / list / code / table / math / figure / callout / practice / resources / related / unknown 等） */
  kind: string;
  /** 块文本指纹（客户端按块内容算；课件重写后拿它判这块变没变） */
  hash: string;
  /** 块内字符区间的起点（码位偏移，0 起，含） */
  start: number;
  /** 块内字符区间的终点（码位偏移，不含；必须 >= start） */
  end: number;
}

/** 一条标注：学生划选的若干段 + 一句注释。一条标注**可以跨块**（`ranges` 多项）。 */
export interface Annotation {
  /** 标注 id（与 `标` 的键相同，便于整条记录独立搬运） */
  id: string;
  /** 学生写的标注正文（纯文本；允许空串——先划一段、回头补字是常态） */
  note: string;
  /** 覆盖的块与块内区间，至少一项 */
  ranges: AnnotationRange[];
  /** 创建时刻（ISO 8601，客户端给，Host 原样存） */
  created: string;
  /** 最近一次修改的时刻（ISO 8601） */
  modified: string;
}

/** 一份标注数据文件的内容。 */
export interface AnnotationsData {
  /** 节点 id */
  节点: string;
  /** 对应的课件文件名（`<NNNN>-<节点id>.md`） */
  课件: string;
  /** 最近一次写入的 operationId（内存台账重启即失，落盘供对账） */
  幂等键?: string;
  /** 最近一次写入的时刻（ISO 8601） */
  最后写入: string;
  /** 标注 id → 这条标注（全量替换语义：这份对象就是当前全部标注） */
  标: Record<string, Annotation>;
}

/** 读一份标注数据：没有文件返回 null（**不是**空对象——「没标过」与「读不到」要分得开）。 */
export interface AnnotationsRead {
  data: AnnotationsData;
  /** 当前版本号；写回时把它当 `expectedVersion` 带上来 */
  version: string;
  /** 文件的绝对路径 */
  file: string;
}

/** 拒绝写入：HTTP 语义由调用方（`lib/annotations-route.ts`）映射成状态码。
 *  形状就是阅读端路由的唯一错误信封（`lib/route-envelope.ts`）：`error` 是
 *  `{ code, message }` 而不是一个字符串——客户端既要按码分支、也要取那句话给人看。 */
export interface AnnotationsRefusal extends RouteErrorEnvelope {
  status: number;
  /** 冲突时顺手带回去的当前标注与版本号：界面不必再跑一趟 */
  annotations?: AnnotationsData;
  version?: string;
}

/** 写入成功：`annotations`/`version` 是写完之后重读的那一份（下一个 `expectedVersion`）。 */
export interface AnnotationsSuccess {
  ok: true;
  annotations: AnnotationsData;
  version: string;
}

export type AnnotationsWriteResult = AnnotationsSuccess | AnnotationsRefusal;

/* ── 常量 ──────────────────────────────────────────────────────────────── */

/** 节点 id 的写法与 `curriculum.schema.json` 的 `nodes[].id` 逐字一致；不合法就不拼路径。 */
const NODE_ID_RE = /^[a-z0-9]+([.-][a-z0-9]+)*$/;

/** 一份课件最多带多少条标注：课件规模决定的，这里只挡「有人拿它当数据库灌」。 */
const ANNOTATIONS_MAX = 500;

/** 一条标注最多跨多少段：跨块是常态，但一段划选拆成几百段没有意义，只会让文件无界增长。 */
const RANGES_MAX = 20;

/** 一条注释的字符上限（码位数）：标注是随手写的一句，不是笔记域——超了让客户端先收一收。 */
const NOTE_MAX = 20000;

/** 落盘缩进：与 `.quiz.json` / `attempts/` 一致（indent=2 手写风格，diff 才好读）。 */
const JSON_INDENT = 2;

/**
 * 幂等台账：`operationId` → { fingerprint, response }。**只在内存里**，只防同一个宿主进程内的
 * 双击与重试。与 `reference.ts` / `attempts.ts` 各持一份实例（见文件头：指纹与回执类型都不同）。
 */
const LEDGER = new IdempotencyLedger<AnnotationsWriteResult>();

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

/** 科目目录的绝对路径。subject 里出现分隔符或 `..` 直接判不合法（与 lib/attempts.ts 一致）。 */
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
 * 课件的编号前缀（`<NNNN>`，四位数字）。课件文件名是 `<NNNN>-<节点id>.md`，标注与它
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

/** 标注数据文件名：`<NNNN>-<节点id>.json`（与课件同名不同后缀，`.md` 换成 `.json`）。 */
function annotationsFileName(number: string, nodeId: string): string {
  return `${number}-${nodeId}.json`;
}

/**
 * 文件内容的版本号（16 位 hex）；文件不在返回空串。
 *
 * **只哈希内容**，不掺 mtime：标注数据是我们自己写的，内容自证最准；mtime 会因为备份、
 * 同步、`touch` 而抖——抖一次就是一次假冲突。
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

/**
 * 读盘的一条 range → `AnnotationRange`；认不出的返回 null（读侧宁可少显示一段，
 * 也不要给界面一个错的偏移——那会把标注贴到别的字上）。
 */
function normalizeRange(value: unknown): AnnotationRange | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const line = raw.line;
  const start = raw.start;
  const end = raw.end;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null;
  if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) return null;
  if (typeof end !== 'number' || !Number.isInteger(end) || end < 0 || end < start) return null;
  if (typeof raw.kind !== 'string' || typeof raw.hash !== 'string') return null;
  return { line, kind: raw.kind, hash: raw.hash, start, end };
}

/** 读盘的一条标注 → `Annotation`；不是对象返回 null。字段缺失一律退回安全默认。 */
function normalizeAnnotation(key: string, value: unknown): Annotation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const ranges = Array.isArray(raw.ranges)
    ? raw.ranges.map(normalizeRange).filter((range): range is AnnotationRange => range !== null)
    : [];
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : key,
    note: typeof raw.note === 'string' ? raw.note : '',
    ranges,
    created: typeof raw.created === 'string' ? raw.created : '',
    modified: typeof raw.modified === 'string' ? raw.modified : '',
  };
}

/**
 * 一份读进来的对象 → `AnnotationsData`；顶层不是对象返回 null（形状不对）。
 *
 * 内层学 `attempts` 的读侧：字段缺了给安全默认、认不出的 range 丢掉，不因为一条坏记录
 * 就让整份文件「读不到」——标注是派生记录，少显示一条比整份消失好。
 */
function toAnnotationsData(value: unknown, nodeId: string, lessonName: string): AnnotationsData | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const marks = typeof raw['标'] === 'object' && raw['标'] !== null && !Array.isArray(raw['标'])
    ? raw['标'] as Record<string, unknown>
    : {};
  const 标: Record<string, Annotation> = {};
  for (const [id, entry] of Object.entries(marks)) {
    const one = normalizeAnnotation(id, entry);
    if (one !== null) 标[one.id] = one;
  }
  const data: AnnotationsData = {
    节点: typeof raw['节点'] === 'string' ? raw['节点'] : nodeId,
    课件: typeof raw['课件'] === 'string' ? raw['课件'] : lessonName,
    最后写入: typeof raw['最后写入'] === 'string' ? raw['最后写入'] : '',
    标,
  };
  if (typeof raw['幂等键'] === 'string') data.幂等键 = raw['幂等键'];
  return data;
}

/** 一次读盘：文本 + 解析后的数据 + 版本号。三个出口共用，栅栏才不会自己抖。 */
function loadAnnotations(subjectDir: string, node: string, number: string, lessonName: string):
  { text: string | null; data: AnnotationsData | null; version: string; file: string } {
  const file = path.join(subjectDir, 'annotations', annotationsFileName(number, node));
  const text = readTextIfPresent(file);
  if (text === null) return { text: null, data: null, version: emptyVersion(file), file };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON 坏了：当成「读不到」，但版本号仍按原文算——写侧据此能拒绝覆盖一份坏文件
    return { text, data: null, version: versionOfText(text), file };
  }
  return { text, data: toAnnotationsData(parsed, node, lessonName), version: versionOfText(text), file };
}

/**
 * 读一个节点的标注。文件不在、科目/节点不合法、JSON 坏了、形状不对——一律返回 `null`。
 *
 * **坏了也不抛**：标注是**派生记录**（ADR-0021 与 ADR-0007 同一口径），一份写坏的标注
 * 文件不该让整份 payload 崩掉、更不该拦住学生看课件。读不到就当没标注过。
 */
export function readAnnotations({ workspace, subject, node }:
  { workspace?: unknown; subject?: unknown; node?: unknown } = {}): AnnotationsRead | null {
  const subjectDir = subjectDirOf(workspace, subject);
  if (subjectDir === null || !isValidNodeId(node)) return null;
  const number = lessonNumberOf(path.join(subjectDir, 'lessons'), node);
  if (number === null) return null;
  const loaded = loadAnnotations(subjectDir, node, number, `${number}-${node}.md`);
  if (loaded.data === null) return null;
  return { data: loaded.data, version: loaded.version, file: loaded.file };
}

/** 现有标注的版本号；文件不在时给**空清单的基线**（不能给空串：第一次标注没法带期望版本）。 */
export function annotationsVersion({ workspace, subject, node }:
  { workspace?: unknown; subject?: unknown; node?: unknown } = {}): string {
  const subjectDir = subjectDirOf(workspace, subject);
  if (subjectDir === null || !isValidNodeId(node)) return '';
  const number = lessonNumberOf(path.join(subjectDir, 'lessons'), node);
  if (number === null) return '';
  return loadAnnotations(subjectDir, node, number, `${number}-${node}.md`).version;
}

/* ── 写入 ──────────────────────────────────────────────────────────────── */

function refusal(status: number, error: string, message: string): AnnotationsRefusal {
  return { status, ...errorBody(error, message) };
}

/** now 可注入（测试用）：Date / 毫秒数 / 可解析的字符串都行，读不出来的退回当前时间。 */
function toIso(now: unknown): string {
  if (now === undefined || now === null) return new Date().toISOString();
  const date = new Date(now as string | number | Date);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/** 入参校验的结论：要么是一份归一化后的标注数组，要么是一句拒绝理由（给人看的）。 */
type AnnotationsVerdict = { ok: true; value: Annotation[] } | { ok: false; message: string };

/**
 * `annotations` 入参 → 归一化后的标注数组（按 id 排序，指纹与落盘都靠这个顺序稳定）。
 *
 * 这里**只判形状与边界**，不判内容对不对：range 指向的块还在不在归客户端（见文件头），
 * `note` 写成什么由学生说了算。拒绝的理由都点名第几条 / 哪个 id，界面原样带得出去。
 */
function verifyAnnotations(raw: unknown): AnnotationsVerdict {
  if (!Array.isArray(raw)) {
    return { ok: false, message: 'annotations 必须是标注数组：整份全量替换，[] 表示清空' };
  }
  if (raw.length > ANNOTATIONS_MAX) {
    return { ok: false, message: `一次最多写 ${ANNOTATIONS_MAX} 条标注，实际 ${raw.length} 条` };
  }
  const seen = new Set<string>();
  const value: Annotation[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, message: `第 ${index + 1} 条标注必须是对象` };
    }
    const one = item as Record<string, unknown>;
    const id = typeof one.id === 'string' ? one.id.trim() : '';
    if (id === '') return { ok: false, message: `第 ${index + 1} 条标注的 id 不能是空串` };
    if (seen.has(id)) return { ok: false, message: `标注 id 重复：${id}（同一份数据里每条标注的 id 必须唯一）` };
    seen.add(id);

    if (typeof one.note !== 'string') return { ok: false, message: `标注 ${id} 的 note 必须是字符串` };
    // note 允许空（先划一段、回头补字），只 trim 首尾空白；长度按码点数（与 schema 口径一致）
    const note = one.note.trim();
    const noteLength = [...note].length;
    if (noteLength > NOTE_MAX) {
      return { ok: false, message: `标注 ${id} 的 note 太长：${noteLength} 个字符（上限 ${NOTE_MAX}）` };
    }

    if (!Array.isArray(one.ranges)) {
      return { ok: false, message: `标注 ${id} 的 ranges 必须是数组（没划到东西就没有标注）` };
    }
    if (one.ranges.length === 0) return { ok: false, message: `标注 ${id} 的 ranges 是空的：至少要有 1 段` };
    if (one.ranges.length > RANGES_MAX) {
      return { ok: false, message: `标注 ${id} 的 ranges 最多 ${RANGES_MAX} 段，实际 ${one.ranges.length} 段` };
    }
    const ranges: AnnotationRange[] = [];
    for (const [rangeIndex, rawRange] of one.ranges.entries()) {
      const where = `标注 ${id} 的第 ${rangeIndex + 1} 段`;
      if (typeof rawRange !== 'object' || rawRange === null || Array.isArray(rawRange)) {
        return { ok: false, message: `${where}必须是对象` };
      }
      const range = rawRange as Record<string, unknown>;
      const line = range.line;
      if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
        return { ok: false, message: `${where}的 line 必须是 >= 1 的整数（课件正文的行号，1 起）` };
      }
      const kind = typeof range.kind === 'string' ? range.kind.trim() : '';
      if (kind === '') return { ok: false, message: `${where}的 kind 必须是非空字符串（客户端块类型词表）` };
      const hash = typeof range.hash === 'string' ? range.hash.trim() : '';
      if (hash === '') return { ok: false, message: `${where}的 hash 必须是非空字符串（块文本指纹）` };
      const start = range.start;
      if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) {
        return { ok: false, message: `${where}的 start 必须是 >= 0 的整数（块内码位偏移）` };
      }
      const end = range.end;
      if (typeof end !== 'number' || !Number.isInteger(end) || end < 0) {
        return { ok: false, message: `${where}的 end 必须是 >= 0 的整数（块内码位偏移）` };
      }
      if (end < start) return { ok: false, message: `${where}的 end 不能小于 start（${end} < ${start}）` };
      ranges.push({ line, kind, hash, start, end });
    }

    if (typeof one.created !== 'string') return { ok: false, message: `标注 ${id} 的 created 必须是字符串（ISO 8601）` };
    if (typeof one.modified !== 'string') return { ok: false, message: `标注 ${id} 的 modified 必须是字符串（ISO 8601）` };
    // 只收这五个字段：带进来的额外键不落盘（盘上的形状只有 schema 那一份）
    value.push({ id, note, ranges, created: one.created, modified: one.modified });
  }
  value.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ok: true, value };
}

/**
 * 写一份标注（**整份全量替换**），落进 `annotations/<NNNN>-<节点id>.json`。
 *
 * 返回 `{ok:true, annotations, version}` 或 `{ok:false, status, error, message, annotations?, version?}`。
 * 拒绝码：`operation-id-invalid` / `subject-invalid` / `node-invalid` / `lesson-missing` /
 * `annotations-invalid` / `expected-version-required` / `operation-id-conflict` /
 * `version-conflict` / `write-failed`。
 *
 * `annotations` 是**当前的整份标注**：创建、编辑、删除都靠一次写入表达（删除 = 数组里没有它；
 * 空数组 = 清空，但文件仍写出）。**没有幂等键的写入一律拒绝**——没有它就分不清双击与新提交。
 */
export function writeAnnotations({ workspace, subject, node, annotations, expectedVersion, operationId, now }:
  { workspace?: unknown; subject?: unknown; node?: unknown; annotations?: unknown;
    expectedVersion?: unknown; operationId?: unknown; now?: unknown } = {}): AnnotationsWriteResult {
  // 先把请求体过一遍再碰台账：坏请求不该占用一个 operationId（与 writeAttempts 同一顺序）
  const verdict = checkOperationId(operationId);
  if (!verdict.ok) {
    return refusal(400, 'operation-id-invalid',
      `缺少或过长的 operationId（上限 ${OPERATION_ID_MAX} 字符）：没有它没法区分重复提交与新标注`);
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
    // 标注与课件一一对应：课件不在就说明这个节点还没有可标注的东西，别先造一份空档案
    return refusal(400, 'lesson-missing', `找不到节点 ${node} 的课件（lessons/<NNNN>-${node}.md）：标注与课件一一对应`);
  }
  const checked = verifyAnnotations(annotations);
  if (!checked.ok) {
    return refusal(400, 'annotations-invalid', checked.message);
  }
  const version = expectedVersion === undefined || expectedVersion === null ? '' : String(expectedVersion).trim();
  if (version === '') {
    return refusal(400, 'expected-version-required',
      '缺少 expectedVersion：先读一次 payload 拿到该课件的标注版本号再写（没有它挡不住覆盖别人刚写的标注）');
  }

  const dir = path.join(subjectDir, 'annotations');
  const lessonName = `${number}-${node}.md`;
  const at = toIso(now);
  // 指纹带上整条标注的五个字段：同一条标注改了 note 或 ranges 必须是**另一次写入**，
  // 否则同一个 operationId 重放会把一次真实修改当成「重复提交」丢掉。
  const fingerprint = fingerprintOf([
    String(subject), node, lessonName,
    ...checked.value.map((one) => [one.id, one.note, JSON.stringify(one.ranges), one.created, one.modified].join('\u0001')),
  ]);

  // 幂等回放放在版本校验**之前**：第一次写成功之后版本号已经变了，重试带回来的
  // expectedVersion 必然是旧的，先校版本就会把一次正常的重试误判成冲突。
  const lookup = LEDGER.lookup(opId, fingerprint);
  if (lookup.kind === 'replay') return lookup.response;
  if (lookup.kind === 'conflict') {
    return conflict('operation-id-conflict',
      '同一个 operationId 又提交了不同的标注：换个 operationId 再写（这次不写盘）',
      subjectDir, node, number, lessonName);
  }

  const current = loadAnnotations(subjectDir, node, number, lessonName);
  if (version !== current.version) {
    // 冲突时拒绝写入并**重读**：把当前标注与版本号一起带回去，界面不必再跑一趟
    return conflict('version-conflict',
      '标注数据已经变了：版本号对不上，这次不写（请按当前内容重来）',
      subjectDir, node, number, lessonName);
  }

  const 标: Record<string, Annotation> = {};
  for (const one of checked.value) 标[one.id] = one;
  const next: AnnotationsData = {
    节点: node,
    课件: lessonName,
    幂等键: opId,
    最后写入: at,
    标,
  };

  const body = `${JSON.stringify(next, null, JSON_INDENT)}\n`;

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return refusal(500, 'write-failed', `建不了 annotations/ 目录：${error instanceof Error ? error.message : String(error)}`);
  }
  const file = path.join(dir, annotationsFileName(number, node));
  try {
    fs.writeFileSync(file, body, 'utf8');
  } catch (error) {
    return refusal(500, 'write-failed', `写不了 ${path.basename(file)}：${error instanceof Error ? error.message : String(error)}`);
  }

  const response: AnnotationsWriteResult = {
    ok: true,
    annotations: next,
    version: versionOfText(body),
  };
  LEDGER.remember(opId, fingerprint, response);
  return response;
}

/** 拒绝并**重读**：把当前标注与版本号一起带回去（ADR-0021 沿用 ADR-0007 的「拒绝并重读」，不引入文件锁）。 */
function conflict(error: string, message: string, subjectDir: string, node: string, number: string, lessonName: string): AnnotationsRefusal {
  const current = loadAnnotations(subjectDir, node, number, lessonName);
  const base: AnnotationsRefusal = refusal(409, error, message);
  base.version = current.version;
  if (current.data !== null) base.annotations = current.data;
  return base;
}
