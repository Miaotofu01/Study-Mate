/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 半数据层 —— reference/ 目录的清单、版本号、读取与写入

   `reference/` 是**人机共写**的目录（ADR-0010）：资料收集角色把本地教材、速查页转进来，
   学生也可以从阅读端直接放自己手上的讲义。两边同放一处，所以：

     · 来源标记：带 `source: learner` front matter 的 Markdown 算学生放的，其余一律算
       agent 收的——日后要能分清哪份是模型产物、哪份是人放的；
     · 并发保护：客户端写之前先报它看到的版本号（payload 里的 reference_version），
       对不上就 409 拒绝并重读当前清单，绝不覆盖别人的改动（目标态规格 §4.3）；
     · 幂等：同一个 operationId 重放只回放上次的响应，不写第二遍（双击与超时重试）。

   清单、版本号、读取、写入四件事必须共用同一套「什么算一条资料」的规则——版本号是写入
   时的栅栏，清单与它不同源就会出现「明明没人动过却报冲突」。所以规则都收在本模块里，
   `lib/library.ts` 只负责把清单与版本号挂进 payload（它 import 本模块；反过来会成环）。
   ───────────────────────────────────────────────────────────────────────── */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isWithin, isWithinReal, realPathOf } from './paths.ts';
import { errorBody } from './route-envelope.ts';
import type { RouteErrorEnvelope } from './route-envelope.ts';

// 复用仓库里那份对齐 PyYAML 的隐式类型解析器：判断一个标题裸着写会不会被读成非字符串
import { resolvePlainScalar } from './yaml.ts';
// 幂等与版本号这两件武器的**判据**住在纯函数域（ADR-0007/0010 共用一套，见 lib/core/fence.ts）。
// 台账实例仍是本模块自己的：reference/ 的指纹是「科目+标题+正文」，attempts/ 的是「节点+一次作答」，
// 共用一个 Map 会让两份台账互相挤掉（上限是共享的），幂等反而在最需要它的时候失效。
import { IdempotencyLedger, checkOperationId, fingerprintOf, OPERATION_ID_MAX } from './core/fence.ts';
// 清单排序的判据同理住在纯函数域：`sorted()` 按码位、JS 的 `<` 按 UTF-16 码元，增补平面字符会分叉。
// `lib/library.ts` 走的也是这一份，同一份清单在两处排出来的顺序必须逐字相同。
import { cmpCodePoints } from './core/format.ts';
import type { Stats } from 'node:fs';

/* ── 常量 ──────────────────────────────────────────────────────────────── */

/** 目录名跳过：__pycache__ 是本仓库 Python 侧的产物，混进清单只会让人误以为是一份资料。 */
const SKIP_DIRS = new Set(['__pycache__']);

/** 能当文本读出来的扩展名；PDF 之类二进制在 payload 里列出，但读不到正文。 */
const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.text', '.json', '.yaml', '.yml', '.csv', '.tsv', '.html', '.htm']);

/** 按来源标记解析 front matter 的扩展名（只有 Markdown 会带 front matter）。 */
const MARKDOWN_EXTS = new Set(['.md', '.markdown']);

/** 标题上限：一个标题不该是一段话，界面上也放不下；超了让人自己拆短。 */
const TITLE_MAX = 120;

/** 文件名主干上限：给 -2/-3 与 .md 留余量，也离文件系统的名字上限远一点。 */
const NAME_MAX = 60;

/** 标题被清成一个空名字时的兜底：宁可用一个呆名字，也不要写不出文件。 */
const FALLBACK_STEM = '参考资料';

/** 同名文件最多试到 -999：到这一步不是碰撞，是有人在灌垃圾。 */
const COLLISION_MAX = 999;

/** 清单里的一条参考资料。形状就是 payload 里那一个对象，别在这里另起一套叫法。 */
export interface ReferenceEntry {
  path: string;
  name: string;
  title: string;
  ext: string;
  bytes: number;
  source: 'learner' | 'agent';
  added_at: string;
}

/** 拒绝写入：HTTP 语义由 bin/dsh-plugin.ts 映射成状态码。reference/version 是冲突时顺手带回去的当前清单。
 *  形状就是阅读端路由的唯一错误信封（`lib/route-envelope.ts`）：`error` 是 `{ code, message }`。 */
export interface ReferenceRefusal extends RouteErrorEnvelope {
  status: number;
  reference?: ReferenceEntry[];
  version?: string;
}

/** 写入成功：entry 是刚落的那一份，reference/version 是写完之后重读的清单（下一个 expectedVersion）。 */
export interface ReferenceSuccess {
  ok: true;
  entry: ReferenceEntry;
  reference: ReferenceEntry[];
  version: string;
}

export type WriteResult = ReferenceSuccess | ReferenceRefusal;

/** 一次遍历里走到的文件：相对 reference/ 的路径 + stat（版本号与条目都从它俩算）。 */
interface WalkedFile {
  rel: string;
  stat: Stats;
}

/**
 * 幂等台账：operationId → { fingerprint, response }。**只在内存里**，
 * 只防同一个宿主进程内的双击与重试；宿主重启后台账就没了——所以
 * operationId 也写进了文件的 front matter，留给以后做持久幂等（或人工对账）用。
 */
const LEDGER = new IdempotencyLedger<WriteResult>();

/* ── 路径 ──────────────────────────────────────────────────────────────── */

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** 目录里的名字要不要跳过：隐藏文件与 __pycache__ 都不是资料。 */
function isSkippedName(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name);
}

/** 科目目录的绝对路径。subject 里出现分隔符或 `..` 直接判不合法（与 `lib/assets.ts` 一致）。 */
function subjectDirOf(workspace: unknown, subject: unknown): string | null {
  if (typeof workspace !== 'string' || !workspace) return null;
  if (typeof subject !== 'string' || !subject || subject.includes('/') || subject.includes('\\') || subject.includes('..')) return null;
  return path.resolve(workspace, '.learning', 'subjects', subject);
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

function readTextIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/* ── front matter ──────────────────────────────────────────────────────── */

/* 只认 `---` 包起来的 `key: value` 行——与迁移前的 Python 渲染器的 parse_front_matter
   同一个口径。**特意不走 parseYaml**：课件那份 front matter 就是这么读的（见
   docs/规范/课件内容格式.md §1），两处口径要一致，而且这几行不需要完整的 YAML。 */

const DOUBLE_QUOTED_RE = /^"(?:[^"\\]|\\.)*"$/;

/* 控制字符的转义写法（YAML 双引号标量里合法的那些）。没列进来的走 \uXXXX。 */
const ESCAPES = new Map([
  ['\u0000', '\\0'], ['\u0007', '\\a'], ['\b', '\\b'], ['\t', '\\t'], ['\n', '\\n'],
  ['\v', '\\v'], ['\f', '\\f'], ['\r', '\\r'], ['\u001b', '\\e'],
]);

const UNESCAPES = new Map([
  ['0', '\u0000'], ['a', '\u0007'], ['b', '\b'], ['t', '\t'], ['n', '\n'], ['v', '\v'],
  ['f', '\f'], ['r', '\r'], ['e', '\u001b'], ['"', '"'], ['\\', '\\'], ['/', '/'],
  ['N', '\u0085'], ['_', '\u00a0'], ['L', '\u2028'], ['P', '\u2029'],
]);

/** 与 quoteScalar 对偶：只有长得像合法双引号标量的才还原（`"a" and "b"` 这种裸标量不动）。 */
function decodeScalar(value: string): string {
  if (!DOUBLE_QUOTED_RE.test(value)) return value;
  // \U 可以写出超越 Unicode 范围的码点，fromCodePoint 会抛——一份人写的奇怪 front matter
  // 不该把整份 payload 带崩，认不出来就原样留着
  const codePoint = (hex: string): string | null => {
    const code = parseInt(hex, 16);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : null;
  };
  return value.slice(1, -1).replace(
    /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|(.))/g,
    (whole: string, hex2: string | undefined, hex4: string | undefined, hex8: string | undefined, simple: string) => {
      if (hex2 !== undefined) return codePoint(hex2) ?? whole;
      if (hex4 !== undefined) return codePoint(hex4) ?? whole;
      if (hex8 !== undefined) return codePoint(hex8) ?? whole;
      // `!`：has 为真时 get 一定拿得到；Map 的类型签名看不出这层关系，运行期一字未改
      return UNESCAPES.has(simple) ? UNESCAPES.get(simple)! : whole;
    },
  );
}

/** 读 `---` 包起来的 front matter；没有就返回 null（不是空 Map：调用方要能区分）。 */
function parseFrontMatter(markdown: string): Map<string, string> | null {
  if (typeof markdown !== 'string' || markdown === '') return null;
  const lines = markdown.split(/\r\n|\n|\r/);
  if (lines[0].replace(/^\ufeff/, '').trim() !== '---') return null;
  let end = -1;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() === '---') { end = index; break; }
  }
  if (end === -1) return null;
  const fields = new Map();
  for (let index = 1; index < end; index++) {
    const raw = lines[index];
    if (raw.trim() === '') continue;
    const at = raw.indexOf(':');
    if (at === -1) continue;
    const key = raw.slice(0, at).trim();
    if (key !== '') fields.set(key, decodeScalar(raw.slice(at + 1).trim()));
  }
  return fields;
}

/**
 * 无条件写成双引号标量（按 YAML 的转义规则）。机器生成的字段用它：时间戳裸着写在
 * YAML 里会被读成 datetime，不再是字符串——本仓库 subject.yaml / progress.yaml 里的
 * 日期也是引号写法。
 */
function quotedScalar(text: string): string {
  // 先转义反斜杠与引号（一遍走完，不会把刚写下的转义再转一次），再写控制字符的转义序列
  const escaped = String(text)
    .replace(/[\\"]/g, (ch) => `\\${ch}`)
    .replace(/[\u0000-\u001f\u007f]/g, (ch) => ESCAPES.get(ch) ?? `\\u${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`);
  return `"${escaped}"`;
}

/**
 * 写进 front matter 的标量。普通标题原样写（与 ADR/文档里的例子一致）；凡是可能被 YAML
 * 读成别的东西、或能把 front matter 破相／注入键的（首尾空白、指示符开头、引号、反斜杠、
 * 控制字符、`no` 这类会被读成布尔的词），改成双引号标量并按 YAML 的转义写——标题里带 `"`
 * 或换行也只会写进值里，不会多出一行 `source: learner` 冒充标记。
 */
function quoteScalar(text: string): string {
  const value = String(text);
  const plainUnsafe = value === ''
    || value !== value.trim()
    || /^[-?:,[\]{}#&*!|>'"%@`]/.test(value)
    || /: |\s#|:$/.test(value)
    || /["\\]/.test(value)
    || /[\u0000-\u001f\u007f]/.test(value)
    // YAML 的隐式类型解析会把这些读成 null/布尔/数字，不再是字符串（复用仓库里那份对齐
    // PyYAML 的解析器，别自己再写一遍词表）
    || resolvePlainScalar(value) !== value
    // 日期是个例外：上面那份解析器对时间戳**故意**按字符串返回（它不建 date 对象），
    // 但 PyYAML 会给出 datetime——标题写成 2026-10-04 时得自己兜住
    || /^\d{4}-\d{1,2}-\d{1,2}/.test(value);
  return plainUnsafe ? quotedScalar(value) : value;
}

/* 标题 → 文件名主干：去掉路径分隔符（含 Windows 的盘符/ADS 冒号）与控制字符、去掉开头
   与结尾的点（开头是点会变成隐藏文件，我的清单口子正好会跳过它，等于写了个看不见的文件；
   结尾的点在 Windows 上会被文件系统抹掉），空白折叠成一个空格，按**码位**截到 NAME_MAX。
   CJK 原样保留：中文标题是常态，不该为它另起一套规则。 */
function fileNameStem(title: string): string {
  const flat = [...String(title)]
    .filter((ch) => !/[\u0000-\u001f\u007f]/.test(ch) && !'/\\:'.includes(ch))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/gu, '');
  const stem = [...flat].slice(0, NAME_MAX).join('').replace(/[.\s]+$/gu, '');
  return stem === '' ? FALLBACK_STEM : stem;
}

/* ── 清单与版本号 ──────────────────────────────────────────────────────── */

/** 扩展名去掉之后的名字（`README` 没有扩展名，别把它截成空串）。 */
function stemOf(name: string): string {
  const ext = path.extname(name);
  return ext === '' ? name : name.slice(0, -ext.length);
}

/**
 * 一棵 reference/ 下的全部文件，按相对路径的**码位**序（版本号与 payload 都用这个顺序）。
 * 目录不存在返回空数组；断链、读不动的条目跳过——缺一个文件不该让整份 payload 崩掉。
 * realBoundary 是**科目目录**已解过符号链接的真实路径：解出来跑到科目外面的条目一律不收，
 * 否则清单会列出一份读不到（或不该读）的资料，版本号也会跟着一起抖。
 */
function walkReference(root: string, realBoundary: string | null, prefix = '', out: WalkedFile[] = [], depth = 0): WalkedFile[] {
  if (depth > 32) return out; // 目录树深得离谱时主动截断，不做无限递归
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => cmpCodePoints(a.name, b.name))) {
    if (isSkippedName(entry.name)) continue;
    const full = path.join(root, entry.name);
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    let stat;
    try {
      stat = fs.statSync(full); // 跟随符号链接，与 `lib/library.ts` 的 collectFileNames 一致
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // 指向目录的符号链接**不进**：跟着走会成环（同一个文件被列 32 遍、payload 无谓膨胀），
      // 也可能指到 reference/ 外面去。
      if (!entry.isSymbolicLink()) walkReference(full, realBoundary, rel, out, depth + 1);
    } else if (stat.isFile()) {
      // 指向文件的链接跟随，但解出来必须还在科目目录里（目标态规格 §4.3：路径越界一律拒绝）
      if (isWithinReal(realBoundary, full)) out.push({ rel, stat });
    }
  }
  return out;
}

/** 一条文件 → payload 条目。 */
function entryFor(dir: string, rel: string, stat: Stats): ReferenceEntry {
  const name = path.posix.basename(rel);
  const ext = path.posix.extname(name);
  // 只有带 `source: learner` front matter 的 Markdown 算学生放的；其余（PDF、速查页、
  // 转过来的教材）都是资料收集角色收的，标题退回文件名（没有别的名字可用）
  const front = MARKDOWN_EXTS.has(ext.toLowerCase()) ? parseFrontMatter(readTextIfPresent(path.join(dir, rel)) ?? '') : null;
  const learner = front !== null && front.get('source') === 'learner';
  return {
    path: rel,
    name,
    title: learner && front.get('title') ? front.get('title')! : stemOf(name),
    ext,
    bytes: stat.size,
    source: learner ? 'learner' : 'agent',
    added_at: learner ? front.get('added_at') || '' : '',
  };
}

/**
 * 条目清单（path + size + mtime）算出来的稳定字符串：写入时的并发栅栏。
 * 空目录也有版本号（空清单的哈希）：**不能**给空串——那样第一次写入就没法带期望版本。
 */
function versionOf(files: WalkedFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file.rel}\u0000${file.stat.size}\u0000${Math.round(file.stat.mtimeMs)}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}

/** 清单与版本号共用一次遍历：两者必然同源，否则会出现「没人动过却报冲突」。
    realBoundary 是科目目录已解过符号链接的真实路径，越界的条目在遍历里就被丢掉。 */
function listReferenceDir(dir: string, realBoundary: string | null): { entries: ReferenceEntry[]; version: string } {
  const files = walkReference(dir, realBoundary);
  return { entries: files.map((file) => entryFor(dir, file.rel, file.stat)), version: versionOf(files) };
}

/** 一次性拿到清单与版本号（同一次遍历，两者必然同源）。传的是**科目目录**，不是 reference/。 */
export function listReference({ subjectDir }: { subjectDir?: unknown }): { entries: ReferenceEntry[]; version: string } {
  const hasSubject = typeof subjectDir === 'string' && subjectDir !== '';
  const root = hasSubject ? path.join(subjectDir, 'reference') : '';
  return listReferenceDir(root, hasSubject ? realPathOf(subjectDir) : '');
}

/** 现有条目的版本号：以条目清单（路径 + 大小 + mtime）算出来的稳定字符串。 */
export function referenceVersion({ workspace, subject }: { workspace?: unknown; subject?: unknown } = {}): string {
  const dir = subjectDirOf(workspace, subject);
  if (dir === null) return '';
  return listReferenceDir(path.join(dir, 'reference'), realPathOf(dir)).version;
}

/* ── 读取 ──────────────────────────────────────────────────────────────── */

/**
 * 读取一份参考资料的文本内容（只给 .md/.txt 之类的文本；二进制返回 null）。
 * 越界、不存在、不是文本、或者落在清单会跳过的目录里（隐藏目录、__pycache__）都返回 null。
 */
export function readReference({ workspace, subject, relPath }: { workspace?: unknown; subject?: unknown; relPath?: unknown } = {}): { text: string; entry: ReferenceEntry } | null {
  const subjectDir = subjectDirOf(workspace, subject);
  if (subjectDir === null || typeof relPath !== 'string' || relPath === '') return null;
  const dir = path.join(subjectDir, 'reference');
  const full = path.resolve(dir, relPath);
  if (!isWithin(dir, full)) return null;
  // 文本判据挡不住符号链接：解掉链接后还得落在**科目目录**里（科目目录自己可以是链接）
  if (!isWithinReal(realPathOf(subjectDir), full)) return null;
  const relative = toPosix(path.relative(dir, full));
  if (relative.split('/').some((segment) => segment === '' || isSkippedName(segment))) return null;
  if (!TEXT_EXTS.has(path.extname(full).toLowerCase())) return null;
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const text = readTextIfPresent(full);
  // 扩展名说是文本、内容其实是二进制：不当文本给出去，让界面按「打不开」处理
  if (text === null || text.includes('\u0000')) return null;
  return { text, entry: entryFor(dir, relative, stat) };
}

/* ── 写入 ──────────────────────────────────────────────────────────────── */

function refusal(status: number, error: string, message: string): ReferenceRefusal {
  return { status, ...errorBody(error, message) };
}

/** now 可注入（测试用）：Date / 毫秒数 / 可解析的字符串都行，读不出来的退回当前时间。 */
function toIso(now: unknown): string {
  if (now === undefined || now === null) return new Date().toISOString();
  const date = new Date(now as string | number | Date);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/**
 * 写入一份**学生自己添加**的参考资料。返回
 * `{ ok:true, entry, reference, version }` 或 `{ ok:false, status, error, message, reference?, version? }`。
 *
 * 400 的三种口子分别是：科目名不合法/科目不存在、标题与正文不合法、**没带 expectedVersion**。
 * 版本号是必填的：宁可让老的客户端写不进来（它会读到一次 400，重新读库再写），也不要
 * 让一次过期的提交静默盖掉别人刚放进去的资料。
 */
export function writeReference({ workspace, subject, title, markdown, expectedVersion, operationId, now }:
  { workspace?: unknown; subject?: unknown; title?: unknown; markdown?: unknown;
    expectedVersion?: unknown; operationId?: unknown; now?: unknown } = {}): WriteResult {
  // 先把请求体过一遍再碰台账：坏请求不该占用一个 operationId
  const verdict = checkOperationId(operationId);
  if (!verdict.ok) {
    return refusal(400, 'operation-id-invalid', `缺少或过长的 operationId（上限 ${OPERATION_ID_MAX} 字符）：没有它没法区分重复提交与新提交`);
  }
  const opId = verdict.id;
  const subjectDir = subjectDirOf(workspace, subject);
  if (subjectDir === null) {
    return refusal(400, 'subject-invalid', '科目名不合法：不能为空，也不能带 / 、\\ 或 ..');
  }
  if (!isDirectory(subjectDir)) {
    return refusal(400, 'subject-invalid', `科目不存在：${String(subject)}`);
  }
  // 标题先折成一行：换行、制表符、全角空格都当空白处理——标题是一行字，不是一段文本。
  // 这样后面写 front matter 时也不可能被值里的换行插出一行新键。
  const cleanTitle = typeof title === 'string' ? title.replace(/\s+/gu, ' ').trim() : '';
  if (cleanTitle === '') {
    return refusal(400, 'title-invalid', '标题不能为空');
  }
  if ([...cleanTitle].length > TITLE_MAX) {
    return refusal(400, 'title-invalid', `标题太长（上限 ${TITLE_MAX} 字）`);
  }
  if (typeof markdown !== 'string' || markdown.replace(/\s+/gu, '') === '') {
    return refusal(400, 'markdown-invalid', '正文不能为空');
  }
  const version = expectedVersion === undefined || expectedVersion === null ? '' : String(expectedVersion).trim();
  if (version === '') {
    return refusal(400, 'expected-version-required', '缺少 expectedVersion：先读一次库拿到 reference_version 再写（没有它挡不住覆盖别人的改动）');
  }

  const dir = path.join(subjectDir, 'reference');
  // 边界给的是科目目录：reference/ 自己挂成符号链接指向别处时，下面每一次读写都要被挡下
  const realSubject = realPathOf(subjectDir);
  const fingerprint = fingerprintOf([`${subject}`, cleanTitle, createHash('sha256').update(markdown).digest('hex')]);

  // 幂等回放放在版本校验**之前**：第一次写成功之后版本号已经变了，重试带回来的
  // expectedVersion 必然是旧的，先校版本就会把一次正常的重试误判成冲突。
  const lookup = LEDGER.lookup(opId, fingerprint);
  if (lookup.kind === 'replay') return lookup.response;
  if (lookup.kind === 'conflict') {
    const current = listReferenceDir(dir, realSubject);
    return {
      ...refusal(409, 'operation-id-conflict', '同一个 operationId 又提交了不同的内容：换个 operationId 再写（这次不写盘）'),
      reference: current.entries,
      version: current.version,
    };
  }

  const current = listReferenceDir(dir, realSubject);
  if (version !== current.version) {
    // 冲突时拒绝写入并**重读**：把当前清单与版本号一起带回去，界面不必再跑一趟
    return {
      ...refusal(409, 'version-conflict', '参考资料已经变了：版本号对不上，这次不写（请按新清单重来）'),
      reference: current.entries,
      version: current.version,
    };
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return refusal(500, 'write-failed', `建不了 reference/ 目录：${error instanceof Error ? error.message : String(error)}`);
  }

  const body = markdown.replace(/^\ufeff/, '');
  const content = [
    '---',
    `title: ${quoteScalar(cleanTitle)}`,
    'source: learner',
    `added_at: ${quotedScalar(toIso(now))}`,
    `operation_id: ${quoteScalar(opId)}`,
    '---',
    '',
    body.endsWith('\n') ? body : `${body}\n`,
  ].join('\n');

  const stem = fileNameStem(cleanTitle);
  let full = null;
  for (let index = 1; index <= COLLISION_MAX; index++) {
    const candidate = path.join(dir, `${stem}${index === 1 ? '' : `-${index}`}.md`);
    // 名字是拼出来的，理论上越不了界；写盘前再证一次，与取址那边同一个判据
    if (!isWithin(dir, candidate)) return refusal(400, 'path-invalid', '算出来的文件名跑到 reference/ 外面了：标题里带了路径分隔符？');
    // 文本判据挡不住符号链接：reference/ 指向科目外面时，这一笔必须写不进去
    if (!isWithinReal(realSubject, candidate)) {
      return refusal(400, 'path-invalid', '算出来的文件名落到科目目录外面了：reference/ 是不是指向别处的符号链接？');
    }
    try {
      fs.writeFileSync(candidate, content, { flag: 'wx' }); // wx：绝不覆盖已有文件，也不覆盖同名目录
      full = candidate;
      break;
    } catch (error) {
      // catch 拿到的是 unknown；这里只读 errno 的 code（类型断言，运行期一字未改）
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'EISDIR') continue; // 撞名就换 -2、-3……
      return refusal(500, 'write-failed', `写不了 ${path.basename(candidate)}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (full === null) {
    return refusal(409, 'name-conflict', `同名文件太多（试到 -${COLLISION_MAX}）：换个标题再写`);
  }

  const next = listReferenceDir(dir, realSubject);
  const rel = toPosix(path.relative(dir, full));
  const entry = next.entries.find((item) => item.path === rel);
  if (entry === undefined) {
    return refusal(500, 'write-verification-failed', `写完之后读不到刚落的文件：${rel}`);
  }
  const response: WriteResult = { ok: true, entry, reference: next.entries, version: next.version };
  LEDGER.remember(opId, fingerprint, response);
  return response;
}
