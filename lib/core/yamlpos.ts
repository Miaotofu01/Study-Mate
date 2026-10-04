/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 —— 「带位置的 YAML 读取」

   校验器要报的是 `文件:行`，而 `lib/yaml.mjs` 的 `parseYaml` 只给值、不给位置。三条约束
   决定了这里另起一层，而不是去改 `lib/yaml.mjs`：

     1. `lib/yaml.mjs` 正在被 #65 改名成 `lib/yaml.ts`，改它是撞车；
     2. `decisions.md` §2 规定 `lib/core/**` **不 import `lib/core/**` 之外的任何东西**，
        所以这一层连 `parseYaml` 都用不上；
     3. 想要的不是「再解析一遍值」，只是**结构 → 行号**的索引。值仍由调用方用
        `lib/yaml.ts` 解析好传进来，两边各管一段。

   这一层刻意**不抛异常、也不构造值**：它沿着与 `lib/yaml.mjs` 同一套块结构规则走一遍，
   把「映射键」「列表项」「单行流式集合的元素」记进一张 `路径 → 行:列` 的表；遇到自己没有
   把握的结构（跨行流式集合、`- - ` 嵌套列表、非常规缩进）就**不记**，让调用方回退到最近的
   祖先位置——位置会粗一点，但永远不会指到别的行上去。

   对齐由测试保证：`test_validators_curriculum.mjs` 拿 `lib/yaml.{ts,mjs}` 真解析一遍，
   再把值树里的每一条路径拿来问这一层「你在第几行」，对不上就红。
   ───────────────────────────────────────────────────────────────────────── */

export type Path = readonly (string | number)[];

export interface Position {
  line: number;
  column: number;
}

export interface PositionHit extends Position {
  /** 是不是这个路径**自己**的位置；false 表示回退到了最近的祖先。 */
  exact: boolean;
}

export interface YamlPositionIndex {
  /** 查一个路径的位置。查不到就回退到最近的祖先；连祖先都没有则给 `{line: 1, exact: false}`。 */
  at(path: Path): PositionHit;
  /** 建了多少个位置条目（诊断用，测试会断言它随嵌套增长）。 */
  readonly size: number;
}

/* ── 行扫描：规则与 lib/yaml.mjs 的 indexLines 逐条对齐 ─────────────────── */

interface SrcLine {
  indent: number;
  content: string;
  line: number;
}

const PY_WS = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');
const PY_LSTRIP_RE = new RegExp(`^[${PY_WS}]+`);
const PY_RSTRIP_RE = new RegExp(`[${PY_WS}]+$`);

function pyStrip(text: string): string {
  return text.replace(PY_STRIP_RE, '');
}

function isSequenceEntry(content: string): boolean {
  return content === '-' || content.startsWith('- ') || content.startsWith('-\t');
}

/**
 * 找「映射用的冒号」：流式深度 0、不在引号里、后面跟空白或行尾。
 * `url: https://x` 里的 `https:` 后面是 `/`，所以不算键冒号——这条判据抄自
 * `lib/yaml.mjs` 的 `findKeyColon`，改一个字 `title: 关于 a: b` 就会解析成两种结构。
 */
function findKeyColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
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

/** 去掉行尾注释（`#` 只有在行首或前面是空白时才是注释）。与 `lib/yaml.mjs` 同一判据。 */
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
    else if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) return text.slice(0, i);
  }
  return text;
}

function scanLines(text: string): SrcLine[] {
  const rawLines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out: SrcLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    let indent = 0;
    while (indent < raw.length && raw[indent] === ' ') indent++;
    // Tab 缩进在 lib/yaml.mjs 里是硬错误；真出现时文本根本解析不出来，这里不猜它的结构。
    if (indent < raw.length && raw[indent] === '\t') continue;
    const content = raw.slice(indent);
    if (content === '' || content[0] === '#') continue;
    if (indent === 0 && (content === '---' || content.startsWith('--- ') || content === '...')) continue;
    if (indent === 0 && content[0] === '%') continue;
    out.push({ indent, content, line: i + 1 });
  }
  return out;
}

/* ── 键文本：把 YAML 写法还原成解析后那个键 ─────────────────────────────── */

const ESCAPES: Record<string, string> = {
  0: '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r',
  e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\',
  N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
};

const BOOL_WORDS = new Map<string, string>([
  ['yes', 'true'], ['true', 'true'], ['on', 'true'],
  ['no', 'false'], ['false', 'false'], ['off', 'false'],
]);
const INT_RE = /^[-+]?[0-9][0-9_]*$/;
const FLOAT_RE = /^[-+]?(?:[0-9][0-9_]*\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9_]+(?:[eE][-+][0-9]+)?)$/;

/**
 * 把「键的 YAML 写法」还原成「解析后的键字符串」。
 * PyYAML 会把 `no:` / `1:` 解析成布尔/数字键，`lib/yaml.mjs` 跟着 `String()` 一下，
 * 所以这里也得跟。还原不出来就退回原文本——退回的后果只是索引里少一条，不是指错行。
 */
function decodeKey(raw: string): string {
  const text = pyStrip(raw);
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(.)/g, (whole, escape: string) => {
      if (escape === 'x' || escape === 'u' || escape === 'U') return whole;
      return ESCAPES[escape] ?? whole;
    });
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  const lower = text.toLowerCase();
  if (BOOL_WORDS.has(lower)) return BOOL_WORDS.get(lower) as string;
  if (INT_RE.test(text)) return String(Number(text.replace(/_/g, '')));
  if (FLOAT_RE.test(text)) return String(Number(text.replace(/_/g, '')));
  return text;
}

/* ── 单行流式集合：`[a, b]` / `{k: v}` ─────────────────────────────────── */

/** 从 `start` 处的 `[`/`{` 找到配对的闭合符下标；没闭合返回 -1。 */
function flowEnd(text: string, start: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 在流式集合内部按顶层逗号切段，返回每段（去掉首尾空白后）在原文里的起点。 */
function splitFlowItems(inner: string): { text: string; offset: number }[] {
  const items: { text: string; offset: number }[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  const push = (from: number, to: number) => {
    const raw = inner.slice(from, to);
    const trimmed = pyStrip(raw);
    if (trimmed === '') return;
    items.push({ text: trimmed, offset: from + raw.indexOf(trimmed[0]) });
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inSingle) {
      if (ch === "'") {
        if (inner[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, inner.length);
  return items;
}

/* ── 扫描器 ───────────────────────────────────────────────────────────── */

function pathKey(path: Path): string {
  // 用前缀区分两种段，免得键 "0" 与下标 0 撞在一起。
  let out = '';
  for (const segment of path) out += typeof segment === 'number' ? `#${segment}/` : `$${segment}/`;
  return out;
}

class Scanner {
  private readonly lines: SrcLine[];
  private readonly positions = new Map<string, Position>();
  private cursor = 0;

  constructor(lines: SrcLine[]) {
    this.lines = lines;
  }

  get size(): number {
    return this.positions.size;
  }

  /** 先记的赢：重复键在 `lib/yaml.mjs` 里是后者生效，位置取第一个只影响提示的行号，不影响判定。 */
  private record(path: Path, line: number, contentColumn: number): void {
    const key = pathKey(path);
    if (this.positions.has(key)) return;
    this.positions.set(key, { line, column: contentColumn + 1 });
  }

  private peek(): SrcLine | undefined {
    return this.lines[this.cursor];
  }

  run(): Map<string, Position> {
    const first = this.peek();
    if (first) {
      this.record([], first.line, first.indent);
      this.parseBlock(first.indent, []);
    }
    return this.positions;
  }

  private parseBlock(indent: number, base: Path): void {
    const line = this.peek();
    if (!line) return;
    // 缩进比预期深：它自成一档，按它自己的缩进解析（与 lib/yaml.mjs 的 parseChild 同义）。
    const effective = line.indent >= indent ? line.indent : indent;
    if (isSequenceEntry(line.content)) this.parseSequence(effective, base);
    else this.parseMapping(effective, base);
  }

  private parseSequence(indent: number, base: Path): void {
    let index = 0;
    while (this.cursor < this.lines.length) {
      const line = this.lines[this.cursor];
      if (line.indent !== indent || !isSequenceEntry(line.content)) break;
      const itemPath = [...base, index];
      this.record(itemPath, line.line, line.indent);
      let rest = line.content.slice(1);
      let column = line.indent + 1;
      while (rest[0] === ' ' || rest[0] === '\t') {
        rest = rest.slice(1);
        column++;
      }
      const value = pyStrip(stripComment(rest));
      this.cursor++;
      if (value === '') {
        this.descend(itemPath, indent);
        index++;
        continue;
      }
      if (isSequenceEntry(rest)) {
        // `- - a` 这种嵌套列表：内层第一项就在本行，后续项的缩进与内层首项同列。
        // 本子集不做索引——回退到祖先位置，不猜。
        index++;
        continue;
      }
      const colon = findKeyColon(rest);
      if (colon >= 0) {
        // `- key: value`：本行的键属于这个项的映射，续行按 column 对齐（lib/yaml.mjs 也是
        // 把这一行就地改写成「从 column 列起的块」再解析）。
        const key = decodeKey(rest.slice(0, colon));
        const childPath = [...itemPath, key];
        this.record(childPath, line.line, column);
        this.parseInlineValue(rest.slice(colon + 1), line, column + colon + 1, childPath);
        const next = this.peek();
        if (next && next.indent > indent) this.parseBlock(next.indent, itemPath);
      } else if (rest[0] === '[' || rest[0] === '{') {
        this.recordFlow(rest, line, column, itemPath);
      }
      index++;
    }
  }

  private parseMapping(indent: number, base: Path): void {
    while (this.cursor < this.lines.length) {
      const line = this.lines[this.cursor];
      if (line.indent !== indent) break;
      if (isSequenceEntry(line.content)) break;
      const colon = findKeyColon(line.content);
      if (colon < 0) break;
      const key = decodeKey(line.content.slice(0, colon));
      const childPath = [...base, key];
      this.record(childPath, line.line, line.indent);
      this.cursor++;
      this.parseInlineValue(line.content.slice(colon + 1), line, line.indent + colon + 1, childPath);
    }
  }

  /** 记录了 `key:` 之后，看冒号右边是什么：标量 / 流式集合 / 换行后的子块。 */
  private parseInlineValue(rawRest: string, line: SrcLine, valueColumn: number, path: Path): void {
    const rest = pyStrip(stripComment(rawRest));
    if (rest === '') {
      this.descend(path, line.indent);
      return;
    }
    if (rest[0] === '[' || rest[0] === '{') this.recordFlow(rest, line, valueColumn + rawRest.indexOf(rest[0]), path);
  }

  /** 空值后面跟的子块：缩进更深，或与父键同列但以 `- ` 开头（`pitfalls:` 换行接列表的常见写法）。 */
  private descend(path: Path, parentIndent: number): void {
    const next = this.peek();
    if (!next) return;
    if (next.indent > parentIndent) this.parseBlock(next.indent, path);
    else if (next.indent === parentIndent && isSequenceEntry(next.content)) this.parseSequence(next.indent, path);
  }

  /** 单行流式集合：给每个元素记一个位置。跨行的只记集合自己（调用方回退到键那一行）。 */
  private recordFlow(text: string, line: SrcLine, contentColumn: number, path: Path): void {
    const end = flowEnd(text, 0);
    if (end < 0) return;
    const inner = text.slice(1, end);
    const items = splitFlowItems(inner);
    if (items.length === 0) return;
    const isMap = text[0] === '{';
    items.forEach((item, index) => {
      // `item.text` 已去掉两端空白，`item.offset` 是它在 `inner` 里的起点；
      // `inner[k]` 落在第 `contentColumn + 2 + k` 列（contentColumn + 1 是集合的起始括号）。
      if (isMap) {
        const colon = findKeyColon(item.text);
        if (colon < 0) return;
        const childPath = [...path, decodeKey(item.text.slice(0, colon))];
        this.record(childPath, line.line, contentColumn + 1 + item.offset);
        const rawAfter = item.text.slice(colon + 1);
        const after = pyStrip(rawAfter);
        if (after[0] === '[' || after[0] === '{') {
          // 值自己的起点要把冒号后的空白算进去，否则嵌套集合的元素列号会整体偏左。
          const leading = rawAfter.length - rawAfter.replace(PY_LSTRIP_RE, '').length;
          this.recordFlow(after, line, contentColumn + 1 + item.offset + colon + 1 + leading, childPath);
        }
      } else {
        const childPath = [...path, index];
        this.record(childPath, line.line, contentColumn + 1 + item.offset);
        // 元素自己也是流式集合（`[[1, 2], [3, 4]]`）：再往里一层。跨行的照样放弃。
        if (item.text[0] === '[' || item.text[0] === '{') {
          this.recordFlow(item.text, line, contentColumn + 1 + item.offset, childPath);
        }
      }
    });
  }
}

/* ── 入口 ─────────────────────────────────────────────────────────────── */

export function indexYaml(text: string): YamlPositionIndex {
  const positions = new Scanner(scanLines(String(text))).run();
  return {
    get size(): number {
      return positions.size;
    },
    at(path: Path): PositionHit {
      for (let depth = path.length; depth >= 0; depth--) {
        const hit = positions.get(pathKey(path.slice(0, depth)));
        if (hit) return { line: hit.line, column: hit.column, exact: depth === path.length };
      }
      // 连根都没有（空文档）：第 1 行是唯一诚实的答案。
      return { line: 1, column: 1, exact: false };
    },
  };
}

/** 只给「值两端空白」这类检查用的小工具：调用方拿它判断 trim 是否改变了文本。 */
export function hasOuterWhitespace(text: string): boolean {
  return PY_RSTRIP_RE.test(text) || PY_LSTRIP_RE.test(text);
}
