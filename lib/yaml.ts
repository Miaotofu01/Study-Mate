/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 半数据层 —— 最小 YAML 子集解析器

   为什么自己写而不是引依赖：Host 半是零运行时依赖的插件，装不进 npm 包；而且这些学习
   文件用的 YAML 窄得可怜，实测（PyYAML 的 token 扫描，21 个真文件）只有这些构造：

     ScalarToken 6407（plain 3404 / double 2999 / single 4）、KeyToken 2948、
     ValueToken 2948、BlockEntryToken 1517、BlockMappingStart 587、
     BlockSequenceStart 444、FlowSequenceStart 28、FlowMappingStart 2。
     块标量 |、> 与锚点 &、别名 *、标签 !、多文档 --- 一个都没有；
     6407 个标量里跨行的 0 个；行尾注释 0 处（87 处全是整行注释）。

   所以这里只实现这个子集，别的构造一律**当场报错**并指出文件、行号与原文。宁可炸，
   也不要静默解析错——解析错的后果是学生界面上出现错的课件内容，比报错难查得多。

   标量的类型判定刻意对齐 PyYAML 的 SafeLoader 隐式解析器（含 yes/no/on/off 这种
   YAML 1.1 的布尔写法），因为验收标准是与 yaml.safe_load 深度相等。注意这带来一个
   已知后果：写 `title: no` 会得到布尔 false，跟 PyYAML 一样。这不是 bug，是对齐。
   ───────────────────────────────────────────────────────────────────────── */

/* ── 可选构造（默认全关，只有 cordis 补丁/预设文件打开） ─────────────────────
   学习文件的实测里没有标签与块标量，所以默认**见到就报错**是这套解析器的安全属性：
   解析错的后果比报错难查得多。但安装器要读的两份文件是 DSH 自己的配置
   （`~/.dsh/profiles/<profile>/cordis.patch.yml` 与 `preset/learning/agent.cordis.yml`），
   它们合法地用了 `!!js` 标签与 `>-` / `|` 块标量——PyYAML 侧靠两个自定义 Loader 支持它们。

   所以这里把这两类构造做成**显式开启**的能力，而不是放宽默认：不开就跟以前一字不差地报错，
   开了才解析（调用方是 lib/preset.ts，见那里对两种标签语义的说明）。

   `tags` 的两种语义对应 PyYAML 侧的两个 Loader：
     · `'scalar'`     —— `!!js <原文>` 直接取原文（PatchLoader：profile 补丁文件用）；
     · `'expression'` —— `!!js <原文>` 读成 `{__jsExpr: 原文}`，即 DSH 自己加载未求值 !!js 节点
                         时的原生 JSON 表示（PresetLoader：预设文件用，它的结果要内联进补丁）。 */
export type YamlTags = 'scalar' | 'expression';

export interface YamlParseOptions {
  /** 出错信息里要写的文件名（调用方从盘上读，只有它知道）。 */
  file?: string;
  /** 允许 `!!js` 标签并指定它的读法；省略＝见到标签报错。 */
  tags?: YamlTags;
  /** 允许 `|` / `>` 块标量；省略＝见到块标量报错。 */
  blockScalars?: boolean;
  /** 允许**一对**文档标记（开头的 `---`、结尾的 `...`）；省略＝见到就报错（一个文件只解析一个文档）。 */
  documentMarkers?: boolean;
}

/** 当前这一次 parseYaml 的选项。解析是同步的、不重入，所以模块级一份就够。 */
let active: YamlParseOptions = {};
function tagsMode(): YamlTags | undefined { return active.tags; }
function blockScalarsEnabled(): boolean { return active.blockScalars === true; }

/** 这一次解析的**原始行**（含空行与整行注释，行尾的 \r 已归一）。块标量要按原文取，
    而下面的行索引刻意丢掉了空行与注释行，所以这里单独留一份。 */
let sourceLines: string[] = [];

/** PyYAML 把日期当 date 对象、`=`/`<<` 走特殊标签，这些本子集都不支持，见到就报错。 */
export class YamlParseError extends Error {
  // declare：只声明类型，运行期不留字段定义（Node 的类型擦除会把 `declare x: T` 整条抹掉）。
  // 写成裸的 `file: string;` 会留下一个初值 undefined 的类字段，构造函数再赋值——结果虽然一样，
  // 但那是实打实的运行期代码，没必要。
  declare file: string;
  declare line: number;
  declare column: number;
  declare text: string;

  constructor(file: string, line: number, column: number, text: string | null, message: string) {
    super(`${file}:${line}:${column}: ${message}${text == null ? '' : `\n    ${text}`}`);
    this.name = 'YamlParseError';
    this.file = file;
    this.line = line;
    this.column = column;
    this.text = text == null ? '' : text;
  }
}

/* ── Python 的空白集合 ──────────────────────────────────────────────────────
   Python 的 str.strip() 与正则 \s 认的空白，比 JS 的 trim()/\s 多 \x1c-\x1f、\x85，
   少 \ufeff。锚点归一化、去空白这些地方要跟 Python 逐字一致，所以显式写出这个集合，
   不用 JS 的 \s。 */
const PY_WS = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');

/** 等价于 Python 的 str.strip()。 */
export function pyStrip(text: string): string {
  return String(text).replace(PY_STRIP_RE, '');
}

/** 报错要用的位置：1 起的行号与原文。indexLines 还没建出整行时也够用（它只读这两个字段）。 */
interface SourcePosition {
  line: number;
  raw: string;
}

/** 源码里的一行：缩进、去掉缩进后的正文，外加报错要用的位置信息。 */
interface SourceLine extends SourcePosition {
  indent: number;
  content: string;
}

function fail(file: string, line: SourcePosition, column: number, text: string | null, message: string): never {
  throw new YamlParseError(file, line.line, column, text == null ? line.raw : text, message);
}

/* ── 隐式类型解析（对齐 PyYAML SafeLoader） ─────────────────────────────── */

const BOOL_TRUE = new Set(['yes', 'true', 'on']);
const BOOL_FALSE = new Set(['no', 'false', 'off']);

// 逐个抄自 PyYAML resolver，含 _ 分隔与六十进制这两种冷门写法：
// 判错一个字符，`mastery: 0.85` 就会变成字符串混进统计里。
const INT_RE = /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;
const FLOAT_RE = /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9_]+(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
// 未加引号的日期在 PyYAML 里是 datetime.date。本解析器不建 date 对象，按字符串返回
// （str(date) 与原文逐字相同，下游 String() 的结果一致）；只是类型与 PyYAML 不同，
// 真出现这种写法时交叉校验会看见差异，不会静默错。
const TIMESTAMP_RE = /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/;

/** 把 plain 标量转成 Python 侧等价的 JS 值。 */
export function resolvePlainScalar(raw: string): string | number | boolean | null {
  if (raw === '' || raw === '~' || raw === 'null' || raw === 'Null' || raw === 'NULL') return null;
  const lower = raw.toLowerCase();
  if (BOOL_TRUE.has(lower)) return true;
  if (BOOL_FALSE.has(lower)) return false;
  if (INT_RE.test(raw)) return constructInt(raw);
  if (FLOAT_RE.test(raw)) return constructFloat(raw);
  if (TIMESTAMP_RE.test(raw)) return raw;
  return raw;
}

function constructInt(raw: string): number {
  let value = raw.replace(/_/g, '');
  let sign = 1;
  if (value[0] === '-') sign = -1;
  if (value[0] === '-' || value[0] === '+') value = value.slice(1);
  if (value === '0') return 0;
  if (value.startsWith('0b')) return sign * parseInt(value.slice(2), 2);
  if (value.startsWith('0x')) return sign * parseInt(value.slice(2), 16);
  if (value[0] === '0') return sign * parseInt(value, 8);
  if (value.includes(':')) {
    let acc = 0;
    let base = 1;
    for (const part of value.split(':').reverse()) {
      acc += Number(part) * base;
      base *= 60;
    }
    return sign * acc;
  }
  return sign * Number(value);
}

function constructFloat(raw: string): number {
  let value = raw.replace(/_/g, '').toLowerCase();
  let sign = 1;
  if (value[0] === '-') sign = -1;
  if (value[0] === '-' || value[0] === '+') value = value.slice(1);
  if (value === '.inf') return sign * Infinity;
  if (value === '.nan') return NaN;
  if (value.includes(':')) {
    let acc = 0;
    let base = 1;
    for (const part of value.split(':').reverse()) {
      acc += Number(part) * base;
      base *= 60;
    }
    return sign * acc;
  }
  return sign * Number(value);
}

/* ── 行索引 ────────────────────────────────────────────────────────────── */

function isSeqEntry(content: string): boolean {
  return content === '-' || content.startsWith('- ') || content.startsWith('-\t');
}

/** 普通赋值遇到 __proto__ 会去改原型而不是加键；键来自文件，不能给它这种权力。 */
function setKey(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  else obj[key] = value;
}

/** 去掉行尾注释。`#` 只有在行首、前面是空白、或紧跟流式指示符（`[` `{` `,`）时才是注释
    ——`[# 注释\n]` 是合法的空流式列表，PyYAML 也这么认。 */
function stripComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '#' && (i === 0 || ' \t[{,'.includes(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

/**
 * 找 `key:` 里那个冒号。只在引号外、流式括号外、且后面是空白或行尾的冒号才算，
 * 所以 `url: https://a`（冒号后面是 `/`）和 `title: [a, b]` 都不会认错。
 * 找不到返回 -1，表示这一行不是映射项。
 */
function findKeyColon(text: string): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) return -1;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ':' && depth === 0 && (i + 1 === text.length || text[i + 1] === ' ' || text[i + 1] === '\t')) return i;
  }
  return -1;
}

/** 只给 `documentMarkers` 用：把开头那一个 `---` 与结尾那一个 `...` 抹成空行。
    中间再来一个就是真的多文档，那时照旧报错——多文档必须失败，不能只读第一份。 */
function withoutDocumentMarkers(text: string): string {
  const lines = text.split('\n');
  const empty = (line: string) => line.trim() === '' || line.trimStart().startsWith('#');
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (empty(lines[i])) continue;
    first = i;
    break;
  }
  if (first >= 0 && /^---(?:\s|$)/.test(lines[first])) lines[first] = '';
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (empty(lines[i])) continue;
    last = i;
    break;
  }
  if (last >= 0 && last !== first && /^\.\.\.(?:\s|$)/.test(lines[last])) lines[last] = '';
  return lines.join('\n');
}

function indexLines(text: string, file: string): SourceLine[] {
  // 实测 21 个真文件全是 \n 结尾；这里顺手归一 CRLF，免得 \r 混进标量尾巴。
  // 开头的 BOM 按 YAML 的规矩跳过（PyYAML 也认）——两份 cordis 配置都可能带 BOM。
  const normalized = String(text).replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  const source = active.documentMarkers ? withoutDocumentMarkers(normalized) : normalized;
  const rawLines = source.split('\n');
  const lines: SourceLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    let indent = 0;
    while (indent < raw.length && raw[indent] === ' ') indent++;
    if (indent < raw.length && raw[indent] === '\t') {
      fail(file, { line: i + 1, raw }, indent + 1, raw, '缩进里出现了制表符：YAML 不允许用 Tab 缩进');
    }
    const content = raw.slice(indent);
    if (content === '' || content[0] === '#') continue; // 空行与整行注释
    // `---` 只有在第 0 列才是文档分隔符；缩进后的 `---` 是普通标量。
    if (indent === 0 && (content === '---' || content.startsWith('--- ') || content === '...')) {
      fail(file, { line: i + 1, raw }, 1, raw, '不支持多文档分隔符 --- / ...：一个文件只解析一个文档');
    }
    if (indent === 0 && content[0] === '%') {
      fail(file, { line: i + 1, raw }, 1, raw, '不支持 YAML 指令 %');
    }
    lines.push({ indent, content, raw, line: i + 1 });
  }
  return lines;
}

/* ── 标量 ──────────────────────────────────────────────────────────────── */

const ESCAPES: Record<string, string> = {
  0: '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r',
  e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\',
  N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
};

function readQuoted(text: string, start: number, line: SourceLine, file: string): { value: string; next: number } {
  const quote = text[start];
  let i = start + 1;
  let out = '';
  for (;;) {
    if (i >= text.length) {
      // 跨行引号标量要按 YAML 的折行规则拼接；实测 6407 个标量里一个都没有，
      // 与其猜，不如报错让人看见。
      fail(file, line, start + 1, line.raw, `引号没有闭合（本解析器不支持跨行的引号标量）`);
    }
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return { value: out, next: i + 1 };
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') return { value: out, next: i + 1 };
    if (ch === '\\') {
      // 显式写成 string | undefined：越界时 text[i + 1] 就是 undefined，下面的分支靠它兜住
      const esc: string | undefined = text[i + 1];
      if (esc === undefined) fail(file, line, i + 1, line.raw, '双引号标量以反斜杠结尾');
      if (Object.prototype.hasOwnProperty.call(ESCAPES, esc)) {
        out += ESCAPES[esc];
        i += 2;
        continue;
      }
      if (esc === 'x' || esc === 'u' || esc === 'U') {
        const width = esc === 'x' ? 2 : esc === 'u' ? 4 : 8;
        const hex = text.slice(i + 2, i + 2 + width);
        if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) {
          fail(file, line, i + 1, line.raw, `转义 \\${esc} 后面需要 ${width} 位十六进制`);
        }
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 2 + width;
        continue;
      }
      if (esc === '\n') {
        // YAML 的续行转义：\ 加换行等于把这个标量接下去。本解析器按行处理，走不到这里。
        i += 2;
        continue;
      }
      fail(file, line, i + 1, line.raw, `不认识的转义 \\${esc}`);
    }
    out += ch;
    i++;
  }
}

/** 拒绝所有「看起来像别的东西」的节点开头，附上人话解释。 */
function assertNodeStart(text: string, line: SourceLine, column: number, file: string): void {
  const ch = text[0];
  if (ch === '|' || ch === '>') fail(file, line, column, line.raw, `不支持块标量 "${ch}"：本解析器只支持到行尾的标量`);
  if (ch === '&') fail(file, line, column, line.raw, '不支持锚点 &');
  if (ch === '*') fail(file, line, column, line.raw, '不支持别名 *');
  if (ch === '!') fail(file, line, column, line.raw, '不支持标签 !');
  if (ch === '?' && (text.length === 1 || text[1] === ' ' || text[1] === '\t')) {
    fail(file, line, column, line.raw, '不支持显式键 "? "');
  }
}

/* ── 可选构造：`!!js` 标签与 `|` / `>` 块标量（见文件头 YamlParseOptions） ───── */

/** 只认 js 标签；`!!js` / `!js` / `!<tag:yaml.org,2002:js>` 三种写法等价。 */
const JS_TAG_RE = /^!!js(?=\s|$)|^!js(?=\s|$)|^!<tag:yaml\.org,2002:js>(?=\s|$)/;
/** 块标量头：`|` / `>` 加可选的缩进指示与 chomping（两种顺序都合法）。 */
const BLOCK_SCALAR_RE = /^[|>](?:[+-]?\d?|\d?[+-]?)$/;

/**
 * 拆掉开头的 `!!js` 标签。没开 tags 或没有标签时返回 null——那时文本会走
 * `assertNodeStart`，仍旧报「不支持标签 !」。
 */
function splitTag(text: string): { rest: string; width: number } | null {
  if (!tagsMode()) return null;
  const match = JS_TAG_RE.exec(text);
  if (!match) return null;
  return { rest: pyStrip(text.slice(match[0].length)), width: match[0].length };
}

/** 标签节点读到的**字符串**值：`scalar` 取原文，`expression` 包成 DSH 的 `{__jsExpr}`。 */
function applyTag(raw: string): unknown {
  return tagsMode() === 'expression' ? { __jsExpr: raw } : raw;
}

function isBlockScalarHeader(text: string): boolean {
  return blockScalarsEnabled() && BLOCK_SCALAR_RE.test(text);
}

/**
 * 读一个块标量。行号取自 header 那一行，往后按**原始行**走——空行属于块内容，
 * 而上面那份行索引刻意不留空行。
 *
 * 折行规则按 YAML 的常见情形实现：`|` 原样保留换行；`>` 把非空行之间的单个换行折成空格，
 * 空行折成一个换行（更深的缩进行原样保留）。chomping：`-` 去掉结尾换行、默认留一个、`+` 全留。
 */
function readBlockScalar(header: SourceLine, headerText: string, parentIndent: number): { value: string; next: number } {
  const indicator = headerText[1] ?? '';
  const chomp = headerText.includes('-') ? 'strip' : headerText.includes('+') ? 'keep' : 'clip';
  const explicit = /\d/.exec(headerText);
  const start = header.line; // 1 起：下一行的下标就是它
  const pieces: Array<{ indent: number; content: string }> = [];
  let index = start;
  let blockIndent: number | undefined = explicit ? parentIndent + Number(explicit[0]) : undefined;
  for (; index < sourceLines.length; index++) {
    const raw = sourceLines[index];
    if (raw.trim() === '') {
      pieces.push({ indent: -1, content: '' });
      continue;
    }
    let indent = 0;
    while (indent < raw.length && raw[indent] === ' ') indent++;
    if (blockIndent === undefined) {
      if (indent <= parentIndent) break; // 块是空的：下一行不属于它
      blockIndent = indent;
    }
    if (indent < blockIndent) break;
    pieces.push({ indent, content: raw.slice(blockIndent) });
  }
  // 结尾的空行不算内容（YAML 的 chomping 只按最后一个非空行判断）
  while (pieces.length && pieces[pieces.length - 1].indent === -1) pieces.pop();
  let text: string;
  if (indicator === '|') {
    text = pieces.map(piece => piece.content).join('\n');
  } else {
    let folded = '';
    let previousBlank = false;
    for (const piece of pieces) {
      if (piece.indent === -1) { folded += '\n'; previousBlank = true; continue; }
      if (folded !== '' && !previousBlank) folded += ' ';
      folded += piece.content;
      previousBlank = false;
    }
    text = folded;
  }
  if (text !== '') {
    if (chomp === 'clip') text = `${text.replace(/\n+$/, '')}\n`;
    else if (chomp === 'strip') text = text.replace(/\n+$/, '');
  }
  return { value: text, next: index };
}

function skipFlowSpace(text: string, i: number): number {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

/**
 * 流式集合里的一项。plain 标量在「映射用的冒号」处停下（冒号后面是空白、逗号或闭合符），
 * 所以 `{k: v}` 的键读成 `k`，而 `[https://a]`、`[1:30]` 里的冒号留在标量里。
 * 是不是映射由调用方看 next 指向的字符决定——同一段代码同时服务 `[...]` 与 `{...}`。
 */
function parseFlowValue(text: string, i: number, line: SourceLine, file: string, asText = false): { value: unknown; next: number } {
  i = skipFlowSpace(text, i);
  const tag = splitTag(text.slice(i));
  if (tag) {
    // 标签下的值只支持标量：集合加标签在 cordis 配置里没有出现过，宁可不支持也不猜。
    const inner = parseFlowValue(text, i + tag.width, line, file, true);
    if (inner.value !== null && typeof inner.value === 'object') {
      fail(file, line, i + 1, line.raw, '不支持给集合加 !!js 标签');
    }
    return { value: applyTag(String(inner.value)), next: inner.next };
  }
  const ch = text[i];
  if (ch === undefined) fail(file, line, i + 1, line.raw, '流式集合没有闭合');
  if (ch === '[' || ch === '{') return parseFlowCollection(text, i, line, file);
  if (ch === '"' || ch === "'") return readQuoted(text, i, line, file);
  let j = i;
  while (j < text.length && text[j] !== ',' && text[j] !== ']' && text[j] !== '}') {
    if (text[j] === ':' && (j + 1 >= text.length || ' \t,]}\n'.includes(text[j + 1]))) break;
    j++;
  }
  const raw = pyStrip(text.slice(i, j));
  if (raw === '') fail(file, line, i + 1, line.raw, '流式集合里有空项');
  assertNodeStart(raw, line, i + 1, file);
  return { value: asText ? raw : resolvePlainScalar(raw), next: j };
}

function parseFlowCollection(text: string, start: number, line: SourceLine, file: string): { value: unknown; next: number } {
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  const isSeq = open === '[';
  const seq: unknown[] = [];
  const map: Record<string, unknown> = {};
  const put = (key: unknown, value: unknown) => {
    setKey(map, typeof key === 'string' ? key : String(key), value);
  };
  let i = skipFlowSpace(text, start + 1);
  if (text[i] === close) return { value: isSeq ? seq : map, next: i + 1 };
  for (;;) {
    i = skipFlowSpace(text, i);
    if (text[i] === undefined) fail(file, line, start + 1, line.raw, `流式集合缺少闭合的 "${close}"`);
    if (text[i] === close) {
      i++;
      break;
    }
    const item = parseFlowValue(text, i, line, file);
    i = skipFlowSpace(text, item.next);
    if (text[i] === ':') {
      // `{k: v}` 的键值对，或 `[k: v]` 这种单项映射（YAML 允许，PyYAML 解析成 [{k: v}]）。
      const val = parseFlowValue(text, skipFlowSpace(text, i + 1), line, file);
      if (isSeq) {
        const pair: Record<string, unknown> = {};
        setKey(pair, typeof item.value === 'string' ? item.value : String(item.value), val.value);
        seq.push(pair);
      } else {
        put(item.value, val.value);
      }
      i = skipFlowSpace(text, val.next);
    } else if (isSeq) {
      seq.push(item.value);
    } else {
      put(item.value, null); // `{a}`：键在、值为 null，与 PyYAML 一致
    }
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text[i] === close) {
      i++;
      break;
    }
    if (text[i] === undefined) fail(file, line, start + 1, line.raw, `流式集合缺少闭合的 "${close}"`);
    fail(file, line, i + 1, line.raw, `流式集合里出现了意外的 "${text[i]}"`);
  }
  return { value: isSeq ? seq : map, next: i };
}

/** 解析一个值：流式集合、引号标量，或到行尾为止的 plain 标量。`asText` 保留 plain 原文
    （标签下的标量取字符串，不做隐式类型判定——PyYAML 的 construct_scalar 就是这个口径）。 */
function parseInlineValue(text: string, line: SourceLine, column: number, file: string, asText = false): unknown {
  const tag = splitTag(text);
  if (tag) {
    if (tag.rest === '') fail(file, line, column, line.raw, '!!js 标签后面没有值');
    const inner = parseInlineValue(tag.rest, line, column + (text.length - tag.rest.length), file, true);
    if (inner !== null && typeof inner === 'object') fail(file, line, column, line.raw, '不支持给集合加 !!js 标签');
    return applyTag(String(inner));
  }
  const ch = text[0];
  if (ch === '[' || ch === '{') {
    const flow = parseFlowCollection(text, 0, line, file);
    const rest = pyStrip(stripComment(text.slice(flow.next)));
    if (rest !== '') fail(file, line, flow.next + 1, line.raw, `流式集合后面还有多余内容：${rest}`);
    return flow.value;
  }
  if (ch === '"' || ch === "'") {
    const quoted = readQuoted(text, 0, line, file);
    const rest = pyStrip(stripComment(text.slice(quoted.next)));
    if (rest !== '') fail(file, line, quoted.next + 1, line.raw, `引号标量后面还有多余内容：${rest}`);
    return quoted.value;
  }
  assertNodeStart(text, line, column, file);
  if (findKeyColon(text) >= 0) {
    // 块上下文里 plain 标量含 ": " 是非法 YAML（PyYAML 直接报错）。静默当字面量会把
    // 作者想要的嵌套结构吞掉，所以这里也报错。
    fail(file, line, column, line.raw, `plain 标量里出现 ": "，YAML 不允许（要么加引号，要么它就是键）：${text}`);
  }
  return asText ? text : resolvePlainScalar(text);
}

function parseKey(raw: string, line: SourceLine, column: number, file: string): string {
  if (raw === '') fail(file, line, column, line.raw, '键是空的');
  if (raw === '<<' || raw === '=') fail(file, line, column, line.raw, `不支持 YAML 合并键 / 特殊键 "${raw}"`);
  if (raw[0] === '"' || raw[0] === "'") {
    const quoted = readQuoted(raw, 0, line, file);
    const rest = pyStrip(stripComment(raw.slice(quoted.next)));
    if (rest !== '') fail(file, line, column, line.raw, `键的引号后面还有内容：${rest}`);
    return quoted.value;
  }
  assertNodeStart(raw, line, column, file);
  // PyYAML 会把 `true:` / `1:` 这样的键解析成布尔/整数键，JSON 序列化后仍是 "true" / "1"。
  // 直接用解析后的值做属性名，JS 的强制转换结果与 Python 的 json.dumps 一致。
  const value = resolvePlainScalar(raw);
  return typeof value === 'string' ? value : String(value);
}

/* ── 块结构 ────────────────────────────────────────────────────────────── */

/** 从 `lines` 的 from 起，找第一个行号不小于 lineNo 的下标（块标量跳行用）。 */
function firstLineAtOrAfter(lines: SourceLine[], from: number, lineNo: number): number {
  let i = from;
  while (i < lines.length && lines[i].line < lineNo) i++;
  return i;
}

function parseMapping(lines: SourceLine[], start: number, indent: number, file: string): [Record<string, unknown>, number] {
  const obj: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      fail(file, line, line.indent + 1, line.raw,
        `缩进比同级多了 ${line.indent - indent} 个空格：同级键必须对齐（多行 plain 标量也不支持）`);
    }
    if (isSeqEntry(line.content)) break; // 交回上层；在映射里出现通常是上一行漏了 key
    if (line.content[0] === '&' || line.content[0] === '*' || line.content[0] === '!') {
      assertNodeStart(line.content, line, line.indent + 1, file);
    }
    const colon = findKeyColon(line.content);
    if (colon < 0) {
      fail(file, line, line.indent + 1, line.raw,
        '这一行既不是 key: value 也不是 "- " 列表项（本解析器不支持多行 plain 标量）');
    }
    const key = parseKey(pyStrip(line.content.slice(0, colon)), line, line.indent + 1, file);
    const rest = pyStrip(stripComment(line.content.slice(colon + 1)));
    if (isBlockScalarHeader(rest)) {
      const block = readBlockScalar(line, rest, indent);
      setKey(obj, key, block.value);
      i = firstLineAtOrAfter(lines, i + 1, block.next);
    } else if (rest === '') {
      const child = parseChild(lines, i + 1, indent, file);
      setKey(obj, key, child.value);
      i = child.next;
    } else {
      setKey(obj, key, parseInlineValue(rest, line, line.indent + colon + 2, file));
      i++;
    }
  }
  return [obj, i];
}

function parseSequence(lines: SourceLine[], start: number, indent: number, file: string): [unknown[], number] {
  const arr: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      fail(file, line, line.indent + 1, line.raw, `列表项的缩进比同级多了 ${line.indent - indent} 个空格：同级项必须对齐`);
    }
    if (!isSeqEntry(line.content)) break;
    let rest = line.content.slice(1);
    let column = indent + 1;
    while (rest[0] === ' ' || rest[0] === '\t') {
      rest = rest.slice(1);
      column++;
    }
    const value = pyStrip(stripComment(rest));
    if (isBlockScalarHeader(value)) {
      const block = readBlockScalar(line, value, indent);
      arr.push(block.value);
      i = firstLineAtOrAfter(lines, i + 1, block.next);
      continue;
    }
    if (value === '') {
      const child = parseChild(lines, i + 1, indent, file);
      arr.push(child.value);
      i = child.next;
      continue;
    }
    // `- key: v` 这一段本身就是个块，把它就地改写成「从 column 列开始的块」，再交给
    // 通用解析器递归。这样紧凑写法与展开写法走同一条路径，不用维护两套代码。
    line.indent = column;
    line.content = rest;
    if (isSeqEntry(rest)) {
      const inner = parseSequence(lines, i, column, file);
      arr.push(inner[0]);
      i = inner[1];
    } else if (findKeyColon(rest) >= 0) {
      const inner = parseMapping(lines, i, column, file);
      arr.push(inner[0]);
      i = inner[1];
    } else {
      arr.push(parseInlineValue(value, line, column + 1, file));
      i++;
    }
  }
  return [arr, i];
}

/** 一个键的值块：下一行更深就往下走；同级出现列表项也算（YAML 允许列表与键同缩进）。 */
function parseChild(lines: SourceLine[], i: number, parentIndent: number, file: string): { value: unknown; next: number } {
  if (i >= lines.length) return { value: null, next: i };
  const line = lines[i];
  if (line.indent > parentIndent) {
    if (isSeqEntry(line.content)) {
      const [value, next] = parseSequence(lines, i, line.indent, file);
      return { value, next };
    }
    const [value, next] = parseMapping(lines, i, line.indent, file);
    return { value, next };
  }
  if (line.indent === parentIndent && isSeqEntry(line.content)) {
    const [value, next] = parseSequence(lines, i, line.indent, file);
    return { value, next };
  }
  return { value: null, next: i };
}

/* ── 入口 ──────────────────────────────────────────────────────────────── */

/**
 * 解析这一小撮学习文件用的 YAML 子集。
 *
 * @param {string} text 文件全文
 * @param {YamlParseOptions} [options] 出错信息里要写的文件名；以及两份 cordis 配置才需要的
 *        `tags` / `blockScalars`（默认关闭，见文件头那段说明）
 * @returns {unknown} 映射、序列或标量；空文档返回 null
 */
export function parseYaml(text: string, options: YamlParseOptions = {}): unknown {
  if (typeof text !== 'string') throw new TypeError('parseYaml 只接受字符串');
  const file = options.file || '<yaml>';
  // 解析是同步的、不重入：选项与原始行放模块级一份，下面所有递归函数都读它。
  // 用 try/finally 复位，免得一次带选项的解析把默认行为永久放宽。
  const previous = active;
  active = options;
  try {
    // 与 indexLines 同一份归一，块标量按行号取原文时才不会错位
    sourceLines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const lines = indexLines(text, file);
    if (lines.length === 0) return null;

    const first = lines[0];
    if (!isSeqEntry(first.content) && findKeyColon(first.content) < 0) {
      // 整个文档就是一个流式集合或标量，例如 misconceptions.yaml 里的裸 `[]`。
      const head = pyStrip(stripComment(first.content));
      if (head.startsWith('[') || head.startsWith('{')) {
        // 流式集合可以跨行（`[# 注释\n]\n`）。行尾注释先按行去掉，剩下的并成一行再解析——
        // 这样「注释里有个 ]」不会把闭合判错。
        let joined = head;
        for (let k = 1; k < lines.length; k++) joined += ` ${pyStrip(stripComment(lines[k].content))}`;
        return parseInlineValue(joined, first, first.indent + 1, file);
      }
      if (lines.length > 1) {
        const second = lines[1];
        fail(file, second, second.indent + 1, second.raw,
          '第一行既不是 key: value 也不是 "- " 列表项，本解析器不支持多行 plain 标量（YAML 会把续行折进同一个标量）');
      }
      return parseInlineValue(head, first, first.indent + 1, file);
    }

    let value;
    let next;
    if (isSeqEntry(first.content)) [value, next] = parseSequence(lines, 0, first.indent, file);
    else [value, next] = parseMapping(lines, 0, first.indent, file);

    if (next < lines.length) {
      const line = lines[next];
      fail(file, line, line.indent + 1, line.raw, '多出来的内容：这一行的缩进与上一块对不上');
    }
    return value;
  } finally {
    active = previous;
    sourceLines = [];
  }
}

export default parseYaml;
