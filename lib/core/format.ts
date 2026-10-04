/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 core —— 课件内容格式的**判定**（issue #66）

   这份文件是 `docs/规范/课件内容格式.md` 在 JS 侧的唯一实现。它替掉的是
  迁移前的 Python 渲染器里 `parse_*` 一族 + `Renderer.inline` 那份判定，
   以及迁移前的 Python 内容格式解析器（围栏与语言标签）。两边是**同一份契约的两个实现**，
   所以这里的每条判定都逐字对着 Python 抄，包括它那些看起来多余的兜底。

   ## 这一域的两条硬规矩（decisions.md §2「目录即域」）

   1. **不 import 任何 `node:*`**，也不 import `lib/core/**` 之外的东西——所以这份
      解析器不知道文件系统、不知道进程、不知道工作区长什么样；
   2. **不抛异常表达「内容有问题」**：格式错误**收集**进 `errors` 数组（题库 JSON 语法错
      也一样，今天 JS 那边 `throw` 是反例），只有「调用方传了非法参数」才是编程错误。

   读文件是调用方的事：`file`（报错里显示的名字）与 `poolFile` 都由调用方注入。

   ## 编号两处对不上，按实现来（issue #66 施工要点）

   - **`:::` 指令是 9 个，不是 8 个**：`practice quiz figure svg tip warn note
     resources related`（迁移前的 Python 渲染器:74）。ticket 与 `docs/设计/实施路线.md:41`
     都写「8 个」——那是计数错。这里按实现，`DIRECTIVES` 是唯一名单。
   - **文档 L178-179 与实现冲突**：文档说 `花了 $5 和 $10` 按字面量处理、不报错，
     实现（迁移前的 Python 渲染器:917-920）**报错**。这里按实现（更严、更确定），
     文档已在本次一并改掉——两处现在一致了。

   ## 输出的形状

   `renderInline` 与 `renderBlock` 产出的是**HTML 片段**，不是 token 流。理由：
   `docs/设计/实施路线.md` 的次序硬约束要求「解析结果与 Python 版一致」，而 Python 侧
   没有中间表示——它的 `parse_*` 只攒 block dict，判定发生在 `Renderer.inline` 里。
   要证明两边一致，最硬的证据就是**产出的 HTML 逐字相同**（六课复核就是这么做的）。
   想拿块树就取 `parseBlocks()` 的返回值，那是纯数据、可以直接 JSON 化。
   ───────────────────────────────────────────────────────────────────────── */

/* ── Python 的字符串语义（背面：JS 的 trim()/\s 与 Python 不重合） ─────────────

   Python 的 `str.strip()` 与 `re` 的 `\s` 认的空白比 JS 多 `\x1c-\x1f`（文件/组分隔符）
   与 `\x85`（NEL），少 `\ufeff`（BOM）。锚点归一化、去空白这些地方差一个字符就是
   「stale 变成 resolved」这种静默结论差别，所以显式写出这个集合，**不要**改用 JS 的 `\s`。
   同一个集合在 `lib/yaml.mjs` 里也有一份（那边为 PyYAML 对齐服务）；core 域不许 import
   `lib/**`，所以这里必须自带一份——两份都是「Python 空白集」这一件事的镜像。 */

const PY_WS = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');
const PY_NORM_RE = new RegExp(`[${PY_WS}]+`, 'g');
const PY_WS_TEST_RE = new RegExp(`^[${PY_WS}]$`);

/** Python 的 `str.isspace()`：非空且每个字符都是空白。 */
export function pyIsSpace(text: string): boolean {
  if (text === '') return false;
  for (const char of text) {
    if (!PY_WS_TEST_RE.test(char)) return false;
  }
  return true;
}

/** Python 的 `str.strip()`。 */
export function pyStrip(text: string): string {
  return String(text).replace(PY_STRIP_RE, '');
}

/** Python 的 `str.rstrip()`（表格单元格里的行尾空白用得到）。 */
export function pyRstrip(text: string): string {
  return String(text).replace(new RegExp(`[${PY_WS}]+$`), '');
}

/** Python 的 `sorted()` 按**码位**比较；JS 的 `<` 按 UTF-16 码元，增补平面字符会分叉。 */
export function cmpCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const x = left[i].codePointAt(0) as number;
    const y = right[i].codePointAt(0) as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

/* ── HTML 转义（口径来自 pagetpl.esc） ─────────────────────────────────────

   Python 的 `html.escape(s, quote=False)` 转 `& < >` **和 `'`**（`&#x27;`），只留 `"`；
   `quote=True` 再多转 `"`（`&quot;`）。单引号两种模式都转——这一点很容易抄错，
   而 `data-quiz` 的属性值恰恰是**单引号包裹**的，转错就是属性被截断。 */

/** 文本节点：只转 `& < >`（对齐 `pagetpl.esc` → `html.escape(quote=False)`）。
 *
 *  **单引号**在 Python 的 `html.escape(quote=False)` 里**不转**——只有属性值那条路
 *  （`quote=True`）才转 `&#x27;`。抄错这一处，代码块里的 `'->'` 就会多出实体。 */
export function escText(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 属性值：再多转 `"` 与 `'`（对齐 `html.escape(..., quote=True)`）。 */
export function escAttr(value: unknown): string {
  return escText(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** `data-quiz` 的值：单引号包裹，所以 `& < > '` 写实体，`"` 留给 JSON 自己。 */
export function escapeQuizAttr(payload: string): string {
  return payload
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');
}

/** 把 HTML 注释换成**等长空格**：只用于按位置判断，下标与原文本一一对应。 */
export function maskComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (match) => ' '.repeat(match.length));
}

/* ── 词汇表 ─────────────────────────────────────────────────────────────── */

/** `:::` 指令名：**9 个**（迁移前的 Python 渲染器:74；ticket 与实施路线写的「8 个」是计数错）。 */
export const DIRECTIVES = [
  'practice', 'quiz', 'figure', 'svg', 'tip', 'warn', 'note', 'resources', 'related',
] as const;

/** 块里还能写普通块的指令（其余指令的块内是字段或原文，不是 Markdown）。 */
export const CONTAINER_DIRECTIVES = ['practice', 'tip', 'warn', 'note'] as const;

/** tip/warn/note 三个卡片的 class。 */
export const CARD_CLASS: Readonly<Record<string, string>> = {
  tip: 'lesson-tip', warn: 'lesson-warn', note: 'lesson-note',
};

/** 会着色的语言标签（13 个）；必须与 `templates/assets/learn-theme.js` 的 `var LANGS` 键逐个相等。 */
export const COLORED_LANGS = [
  'cpp', 'sh', 'bash', 'shell', 'term', 'html', 'js', 'javascript',
  'ts', 'typescript', 'json', 'python', 'py',
] as const;

/** 接受但明确不上色的语言标签（14 个）。 */
export const PLAIN_LANGS = [
  'text', 'plain', 'markdown', 'md', 'http', 'yaml', 'yml', 'toml',
  'sql', 'ini', 'diff', 'mermaid', 'powershell', 'java',
] as const;

/** front matter 只有这两个字段，写别的报错。 */
export const FRONT_KEYS = ['title', 'goal'] as const;

/** 节点标题建议 ≤16 字，超了只打一行提示（不影响退出码）。 */
export const TITLE_SOFT_LIMIT = 16;

/**
 * 「什么算 HTML 标签」的唯一名单（小写）：**完整**标准 HTML 元素表 + SVG 元素名。
 *
 * 三份逐字一致，由 `scripts/tests/test_core_lesson.mjs` 断言：这里的集合 =
 *迁移前的 Python 渲染器（`HTML_TAG_NAMES`） = `docs/规范/课件内容格式.md` §2 的名单。
 * 改名单时三处同步。
 *
 * **加名字有硬边界**：两个形状正则捕获的名字都是 `[a-zA-Z][a-zA-Z0-9]*`，**不含连字符**，
 * 所以 `<syo-editor>` 这类自定义元素加多少名字都匹配不上——它只能做成 `:::` 指令。
 * 同理这里收的是**元素名**：MathML 内层元素名（`<mrow>`、`<mi>`）不在里面，写进正文当普通文字放行。
 */
export const HTML_TAG_NAMES: ReadonlySet<string> = new Set(`
    a abbr acronym address animate animatemotion animatetransform applet area article aside audio b
    base basefont bdi bdo bgsound big blink blockquote body br button canvas caption center circle
    cite clippath code col colgroup content data datalist dd defs del desc details dfn dialog dir
    div dl dt ellipse em embed feblend fecolormatrix fecomponenttransfer fecomposite
    feconvolvematrix fediffuselighting fedisplacementmap fedistantlight fedropshadow feflood fefunca
    fefuncb fefuncg fefuncr fegaussianblur feimage femerge femergenode femorphology fencedframe
    feoffset fepointlight fespecularlighting fespotlight fetile feturbulence fieldset figcaption
    figure filter font footer foreignobject form frame frameset g geolocation h1 h2 h3 h4 h5 h6 head
    header hgroup hr html i iframe image img input ins isindex kbd keygen label legend li line
    lineargradient link listing main map mark marker marquee mask math menu menuitem meta metadata
    meter mpath multicol nav nextid nobr noembed noframes noscript object ol optgroup option output
    p param path pattern picture plaintext polygon polyline pre progress q radialgradient rb rect rp
    rt rtc ruby s samp script search section select selectedcontent set shadow slot small source
    spacer span stop strike strong style sub summary sup svg switch symbol table tbody td template
    text textarea textpath tfoot th thead time title tr track tspan tt u ul use var video view wbr
    xmp
`.split(/\s+/).filter(Boolean));

/* ── 形状正则（逐字对着 Python 抄） ───────────────────────────────────────── */

const FENCE = '```';

export const UL_RE = /^- (\S.*)$/;
export const ORDERED_RE = /^\d+\. (\S.*)$/;
export const DIRECTIVE_RE = /^:::\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*(.*)$/;
export const FIELD_RE = /^([a-z_]+):\s*(.*)$/;
export const LINK_ITEM_RE = /^-\s*\[([^\]]+)\]\(([^)\s]+)\)\s*(?:\|\s*(.*))?$/;
export const PLAIN_ITEM_RE = /^-\s*([^|]+?)\s*(?:\|\s*(.*))?$/;
export const LINK_RE = /\[([^\]]*)\]\(([^)\s]*)\)/;
export const HEADING_RE = /^(#{1,6})\s*(.*)$/;
export const HTML_TAG_RE = /^<\/?([a-zA-Z][a-zA-Z0-9]*)\b/;
export const TAG_SHAPE_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)(?=[\s/>])(\s[^<>]*)?\/?>/;
export const ASCII_WORD_RE = /^[0-9A-Za-z]$/;
export const SEPARATOR_CELL_RE = /^:?-{3,}:?$/;
export const CAPTION_NUMBER_RE = /^图\s*\d+\s*·\s*/;
/** 段内换行要不要补空格：两侧都是中日韩文字与全角标点就直接相接（中文不用空格分词）。 */
const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
/** 图片源不接受外链（与 `lessonfile.SCHEME_RE` 同一形状）。 */
export const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** `::: svg` 的收尾判定用的两条（按行拼接后匹配）。 */
const SVG_OPEN_RE = /<svg(?=[\s/>])/;
const SVG_CLOSE_RE = /<\/svg\s*>/;
const SVG_SELF_CLOSE_RE = /<svg(?=[\s/>])[^<>]*\/>/;

/* ── 围栏（口径来自迁移前的 Python 内容格式解析器，三个脚本共用的唯一判定） ─────────── */

/** 这一行是围栏标记就回信息串（``` 之后那段，可能为空串），不是回 null。 */
export function fenceMarker(line: string): string | null {
  const stripped = String(line).trim();
  if (!stripped.startsWith(FENCE)) return null;
  return stripped.slice(FENCE.length).trim();
}

/** 这一行会不会翻转围栏态（开与关都算）。 */
export function isFenceLine(line: string): boolean {
  return fenceMarker(line) !== null;
}

/** 语言标签认不认；空串算认（不写标签就让前端按内容猜）。 */
export function isKnownLang(lang: string): boolean {
  if (!lang) return true;
  return (COLORED_LANGS as readonly string[]).includes(lang)
    || (PLAIN_LANGS as readonly string[]).includes(lang);
}

/* ── 错误 ───────────────────────────────────────────────────────────────── */

export const ERROR_CODES = [
  'front-matter-missing', 'front-matter-unterminated', 'front-matter-unknown-field',
  'front-matter-empty-value', 'front-matter-missing-field', 'front-matter-bad-line',
  'title-mismatch',
  'heading-level', 'heading-empty', 'indented-block',
  'fence-unterminated', 'fence-unknown-lang',
  'table-separator-missing', 'table-cell-count', 'table-separator-cell',
  'list-indent', 'unknown-block', 'html-block', 'html-inline', 'html-comment',
  'math-unterminated', 'math-block-unterminated',
  'unknown-directive', 'directive-unterminated', 'directive-nested', 'stray-colons',
  'practice-args', 'quiz-args', 'quiz-level', 'quiz-body',
  'figure-missing-alt', 'figure-body', 'figure-src',
  'svg-args', 'svg-body', 'svg-no-open', 'svg-no-close',
  'links-item', 'links-empty', 'stray-empty-reason',
  'anchor-missing', 'anchor-duplicate', 'anchor-ambiguous', 'anchor-stale',
  'pool-orphan', 'pool-shape', 'pool-json', 'pool-missing', 'pool-unused',
  // 题库里每道题的题型结论（词表与字段要求在 lib/core/rules.ts）；行号指向那道题在 JSON 里的位置
  'pool-unknown-kind', 'pool-ambiguous', 'pool-missing-field',
] as const;
export type FormatErrorCode = (typeof ERROR_CODES)[number];

/** 一条问题：`file:line <message>`，line 从 1 起（对齐 `render_lesson.Problems.add`）。 */
export interface FormatError {
  /** 调用方注入的文件名/相对路径；解析层不解析它 */
  file: string;
  /** 1 起；整体性问题（例如题库缺文件）用 1 */
  line: number;
  message: string;
  code: FormatErrorCode;
}

/** 软提示：`提示: …` 那一类，**不影响**「有没有错」。 */
export interface FormatNote {
  file: string;
  line: number;
  message: string;
}

/** 报错与提示两个收集器；同一条只留一次（对齐 `Problems` 的去重）。 */
export class FormatProblems {
  readonly errors: FormatError[] = [];
  readonly notes: FormatNote[] = [];
  readonly #seen = new Set<string>();

  add(file: string, line: number, message: string, code: FormatErrorCode): void {
    const where = Number.isFinite(line) ? Math.max(Math.trunc(line), 1) : 1;
    const key = `${file}\n${where}\n${message}`;
    if (this.#seen.has(key)) return; // 同一处在不同层级被查到时不重复报
    this.#seen.add(key);
    this.errors.push({ file, line: where, message, code });
  }

  note(file: string, line: number, message: string): void {
    this.notes.push({ file, line, message });
  }

  /** 有问题时按 Python 的格式逐条打印（调用方决定打到哪）。 */
  report(): string[] {
    return this.errors.map((item) => `${item.file}:${item.line} ${item.message}`);
  }
}

/** 渲染期上下文：文件、报错/提示入口、以及页内图注编号（`figure` 与 `svg` 共用一条序列）。 */
export interface LessonCtx {
  file: string;
  problems: FormatProblems;
  /** 这一页有没有数学式（决定壳里注不注入 KaTeX） */
  math: { value: boolean };
  /** 页内图注编号计数器 */
  figureNo: { value: number };
  /** `::: quiz` 取题用的题库（调用方读好的对象）；没有就渲染不出题目 */
  pool?: Record<string, unknown[]> | null;
  /** 题库文件在报错里显示的名字 */
  poolName?: string;
  /** 图片库索引 `{文件名: {url, license}}`：给 `::: figure` 的图注补来源 */
  poolSource?: (src: string) => string;
}

export function makeCtx(file: string): LessonCtx {
  return { file, problems: new FormatProblems(), math: { value: false }, figureNo: { value: 0 } };
}

/* ── 块树（纯数据，可直接 JSON 化） ─────────────────────────────────────── */

export interface ListItem<D = BlockDatum> {
  text: string;
  /** 子列表是**一个**块（与 Python 的 `item['children']` 同构），不是块列表 */
  children: Block<D> | null;
  line: number;
}

/** 除列表外的叶子块数据：列表要靠 `items` 递归回 `Block`，所以拆出来单独命名。 */
export type BlockDatum =
  | { kind: 'h2' | 'h3'; text: string; line: number }
  | { kind: 'p'; text: string; line: number }
  | { kind: 'code'; lang: string; text: string; line: number }
  | { kind: 'table'; header: string[]; rows: string[][]; line: number }
  | PracticeBlock | QuizBlock | FigureBlock | SvgBlock | CardBlock | LinksBlock;

export type Block<D = BlockDatum> =
  | D
  | { kind: 'ul' | 'ol'; items: ListItem<D>[]; line: number };

export interface PracticeBlock {
  kind: 'directive'; name: 'practice';
  level: string; title: string; body: Block[]; line: number;
}

export interface QuizBlock {
  kind: 'directive'; name: 'quiz';
  level: string; anchor: string; empty_reason: string | null; line: number;
}

export interface FigureBlock {
  kind: 'directive'; name: 'figure';
  src: string; alt: string; caption: string; line: number;
  alt_line: number; caption_line: number;
}

export interface SvgBlock {
  kind: 'directive'; name: 'svg';
  alt: string; caption: string; raw: string; line: number;
  alt_line: number; caption_line: number;
}

export interface CardBlock {
  kind: 'directive'; name: 'tip' | 'warn' | 'note';
  title: string; body: Block[]; line: number;
}

export interface LinkItem { title: string; href: string; meta: string; line: number }

export interface LinksBlock {
  kind: 'directive'; name: 'resources' | 'related';
  items: LinkItem[]; line: number;
}

export interface FrontMatter {
  title: string; goal: string;
  titleLine: number; goalLine: number;
}

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

/** `text[index]` 是反引号时返回配对的收尾下标；落单（或内容为空）返回 null。
 *
 *  **code span 的唯一判定**：`renderInline()` 与行内 HTML 检查都走它。落单的反引号是普通
 *  字符、不开启 code 区——这条规则只写一份，免得两处漂移（曾经用「反引号奇偶」判定，
 *  于是段落里一个落单的反引号就把后面的 `<b>` 全遮住了）。 */
export function codeSpanEnd(text: string, start: number): number | null {
  const close = text.indexOf('`', start + 1);
  return close > start + 1 ? close : null;
}

/** `text[index]` 是 `$` 时返回配对收尾 `$` 的下标；不成立返回 null。
 *
 *  判据（避开散文里的美元号）：开 `$` 后面紧跟非空白、收 `$` 前面也是非空白、中间非空
 *  且不跨行。**注意**：`花了 $5 和 $10` 因此**报错**（文档原来写「按字面量处理」，
 *  那是文档错——已按实现改文档）。 */
export function mathClose(text: string, index: number): number | null {
  if (index + 1 >= text.length) return null;
  if (pyIsSpace(text[index + 1])) return null;
  const close = text.indexOf('$', index + 1);
  if (close <= index + 1) return null;
  if (pyIsSpace(text[close - 1]) || text[close - 1] === '\\') return null;
  if (text.slice(index + 1, close).includes('\n')) return null;
  return close;
}

/** 行首是**真 HTML 标签**时返回标签名，否则 null（与行内检查同查 `HTML_TAG_NAMES`）。 */
export function htmlBlockTag(stripped: string): string | null {
  const tag = HTML_TAG_RE.exec(stripped);
  if (tag && HTML_TAG_NAMES.has(tag[1].toLowerCase())) return tag[1];
  return null;
}

/** `text[index] == '<'`；是**真标签**就返回标签原文，否则 null。两条判据缺一不可。 */
export function tagShapeAt(text: string, index: number): string | null {
  if (index > 0 && ASCII_WORD_RE.test(text[index - 1])) return null;
  const match = TAG_SHAPE_RE.exec(text.slice(index));
  if (!match || match.index !== 0) return null;
  if (!HTML_TAG_NAMES.has(match[1].toLowerCase())) return null;
  return match[0];
}

/** 这一行会不会开启一个新的块（段落遇到它就结束）。 */
export function isBlockStart(stripped: string): boolean {
  return stripped.startsWith('#') || stripped.startsWith(':::') || stripped.startsWith('|')
    || stripped.startsWith('>') || stripped.startsWith('* ') || stripped.startsWith('+ ')
    || stripped.startsWith('---')
    || isFenceLine(stripped)
    || UL_RE.test(stripped) || ORDERED_RE.test(stripped)
    || htmlBlockTag(stripped) !== null || stripped.startsWith('<!--');
}

/** 段内换行：两侧都是中文就直接相接，否则按一个空格接（英文单词之间要空格）。 */
export function joinParagraph(parts: string[]): string {
  let text = parts[0];
  for (const part of parts.slice(1)) {
    const gap = CJK_RE.test(text[text.length - 1]) && CJK_RE.test(part[0]) ? '' : ' ';
    text += gap + part;
  }
  return text;
}

/** 管道表一行 → 单元格（`\|` 是转义的字面竖线）。 */
export function splitCells(row: string): string[] {
  let text = row.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let buf = '';
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === '\\' && index + 1 < text.length && text[index + 1] === '|') {
      buf += '|';
      index += 2;
      continue;
    }
    if (char === '|') {
      cells.push(buf.trim());
      buf = '';
      index += 1;
      continue;
    }
    buf += char;
    index += 1;
  }
  cells.push(buf.trim());
  return cells;
}

/** 图片源去掉 query/fragment 并做百分号解码（对齐 Python 的 `unquote(src.split('#')[0]…)`）。
 *
 *  `decodeURIComponent` 遇到坏转义会抛，Python 的 `unquote` 是原样留下——所以自己解。 */
export function decodeImageSrc(src: string): string {
  const bare = src.split('#', 1)[0].split('?', 1)[0];
  return bare.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
    const bytes: number[] = [];
    for (let index = 0; index < match.length; index += 3) {
      bytes.push(Number.parseInt(match.slice(index + 1, index + 3), 16));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    } catch {
      return match; // 坏转义：Python 的 unquote 也是原样留下，不抛
    }
  });
}

/* ── front matter ───────────────────────────────────────────────────────── */

export interface FrontMatterResult {
  front: FrontMatter | null;
  /** 正文起始行下标（0 起） */
  bodyStart: number;
}

/**
 * 读 front matter（`---` 起止，title/goal 必填）。
 *
 * 行号口径照抄 Python：字段问题报**字段行**，缺字段报**结束行**（迁移前的 Python 渲染器:254），
 * 首行不是 `---` 或有 `---` 没收尾都报在第 1 行。
 */
export function parseFrontMatter(lines: string[], ctx: LessonCtx): FrontMatterResult {
  const { file, problems } = ctx;
  const first = lines.length > 0 ? pyStrip(lines[0]).replace(/^\ufeff/, '') : '';
  if (first !== '---') {
    problems.add(file, 1, '内容文件要以 front matter 开头（第一行 ---，里面写 title 与 goal）',
      'front-matter-missing');
    return { front: null, bodyStart: 0 };
  }
  let end: number | null = null;
  for (let index = 1; index < lines.length; index++) {
    if (pyStrip(lines[index]) === '---') { end = index; break; }
  }
  if (end === null) {
    problems.add(file, 1, 'front matter 没有结束的 --- 行', 'front-matter-unterminated');
    return { front: null, bodyStart: 0 };
  }
  const fields: Record<string, string> = {};
  const fieldLines: Record<string, number> = {};
  for (let index = 1; index < end; index++) {
    const raw = lines[index];
    if (!pyStrip(raw)) continue;
    if (!raw.includes(':')) {
      problems.add(file, index + 1,
        `front matter 的字段写成 key: value（认不出：${pyStrip(raw)}）`, 'front-matter-bad-line');
      continue;
    }
    const colon = raw.indexOf(':');
    const key = pyStrip(raw.slice(0, colon));
    const value = pyStrip(raw.slice(colon + 1));
    if (!(FRONT_KEYS as readonly string[]).includes(key)) {
      problems.add(file, index + 1,
        `front matter 不认识的字段 ${key}（只有 title 与 goal）`, 'front-matter-unknown-field');
      continue;
    }
    if (!value) {
      problems.add(file, index + 1, `front matter 的 ${key} 不能为空`, 'front-matter-empty-value');
      continue;
    }
    fields[key] = value;
    fieldLines[key] = index + 1;
  }
  for (const key of FRONT_KEYS) {
    if (!(key in fields)) {
      problems.add(file, end + 1, `front matter 缺 ${key}`, 'front-matter-missing-field');
    }
  }
  if ('title' in fields && fields.title.length > TITLE_SOFT_LIMIT) {
    problems.note(file, fieldLines.title,
      `${file}:${fieldLines.title} 标题 ${fields.title.length} 字 > ${TITLE_SOFT_LIMIT}`
      + '（页头与 <title> 都用它，长了会换行）');
  }
  return {
    front: {
      title: fields.title ?? '',
      goal: fields.goal ?? '',
      titleLine: fieldLines.title ?? 1,
      goalLine: fieldLines.goal ?? 1,
    },
    bodyStart: end + 1,
  };
}

/* ── 块级解析 ───────────────────────────────────────────────────────────── */

/**
 * 把 `[start, end)` 行解析成块列表；认不出的语法带行号报错，不猜。
 *
 * 返回的第一项是块列表，第二项是**下一个未消费的行下标**——只有测试与嵌套指令用得到，
 * 顶层调用给 `end = lines.length`。
 */
export function parseBlocks(
  lines: string[], start: number, end: number, ctx: LessonCtx,
): { blocks: Block[]; next: number } {
  const { file, problems } = ctx;
  const blocks: Block[] = [];
  let index = start;
  while (index < end) {
    const raw = lines[index];
    const stripped = raw.trim();
    const lineNo = index + 1;
    if (!stripped) { index += 1; continue; }
    if (raw[0] === ' ' || raw[0] === '\t') {  // 缩进只属于列表嵌套
      problems.add(file, lineNo, '块级内容顶格写（只有列表嵌套才缩进 2 空格）', 'indented-block');
      index += 1;
      continue;
    }

    const heading = HEADING_RE.exec(stripped);
    if (heading) {
      const level = heading[1].length;
      if (level < 2) {
        // 一级标题没有对应组件；重点是把「行首 # 就是标题」这件事说清楚——
        // 竞赛正文里 `#include <cstdio>`、`#define N 100` 出现在行首太常见了
        problems.add(file, lineNo,
          `这一行被当成一级标题（${stripped.slice(0, 24)}…）：内容格式只有 ## 与 ###。`
          + '如果这是代码（#include / #define 这类），请放进 ``` 围栏；'
          + '要分节就写 ## 标题', 'heading-level');
      } else if (level > 3) {
        problems.add(file, lineNo, '标题只支持 ## 与 ###（四级及以下没有组件）', 'heading-level');
      } else if (!heading[2].trim()) {
        problems.add(file, lineNo, `${'#'.repeat(level)} 后面要写标题文字`, 'heading-empty');
      } else {
        blocks.push({ kind: level === 2 ? 'h2' : 'h3', text: heading[2].trim(), line: lineNo });
      }
      index += 1;
      continue;
    }

    if (isFenceLine(stripped)) {
      const { block, next } = parseFence(lines, index, end, ctx);
      index = next;
      if (block) blocks.push(block);
      continue;
    }

    if (stripped.startsWith(':::')) {
      const { block, next } = parseDirective(lines, index, end, ctx);
      index = next;
      if (block) blocks.push(block);
      continue;
    }

    if (UL_RE.test(stripped) || ORDERED_RE.test(stripped)) {
      const { block, next } = parseList(lines, index, end, ctx);
      blocks.push(block);
      index = next;
      continue;
    }

    if (stripped.startsWith('|')) {
      const { block, next } = parseTable(lines, index, end, ctx);
      index = next;
      if (block) blocks.push(block);
      continue;
    }

    // 注意：这里的 `---` 是**正文里**的分隔线（Python 的 `stripped in ('---','***','___')`）。
    // front matter 的首尾 `---` 由 `parseFrontMatter` 消费掉，不会走到这儿。
    if (stripped === '---' || stripped === '***' || stripped === '___') {
      problems.add(file, lineNo, '内容格式没有分隔线：要分节就写 ## 标题', 'unknown-block');
      index += 1;
      continue;
    }

    if (stripped.startsWith('>') || stripped.startsWith('* ') || stripped.startsWith('+ ')) {
      problems.add(file, lineNo, '认不出的块语法：无序列表写 `- 项`，引用块本格式不支持', 'unknown-block');
      index += 1;
      continue;
    }

    const tag = htmlBlockTag(stripped);
    if (tag) {
      problems.add(file, lineNo, `内容文件不写 HTML（读到 <${tag}>）：`
        + '用内容格式的块与行内语法，HTML 由渲染器产出', 'html-block');
      index += 1;
      continue;
    }
    if (stripped.startsWith('<!--')) {
      problems.add(file, lineNo, '内容文件不写 HTML 注释：要留话就给出题角色或写进正文', 'html-comment');
      index += 1;
      continue;
    }

    // 段落：吃到空行或下一个块的开始
    const paragraph = [stripped];
    index += 1;
    while (index < end) {
      const follow = lines[index];
      if (!follow.trim() || isBlockStart(follow.trim()) || follow[0] === ' ' || follow[0] === '\t') {
        break;
      }
      paragraph.push(follow.trim());
      index += 1;
    }
    blocks.push({ kind: 'p', text: joinParagraph(paragraph), line: lineNo });
  }
  return { blocks, next: index };
}

/** ``` 围栏 → 代码块（块内原文逐字保留，收尾按 strip() 判）。 */
export function parseFence(
  lines: string[], index: number, end: number, ctx: LessonCtx,
): { block: Block | null; next: number } {
  const { file, problems } = ctx;
  const language = fenceMarker(lines[index]) ?? '';
  if (!isKnownLang(language)) {
    problems.add(file, index + 1,
      `不认识的语言标签 \`${language}\`——会着色的写 `
      + `${COLORED_LANGS.join(' / ')}；不上色写 text`
      + `（${PLAIN_LANGS.slice(1).join(' / ')} 也认），`
      + '或者干脆不写语言标签（前端按内容猜）', 'fence-unknown-lang');
  }
  const body: string[] = [];
  let cursor = index + 1;
  while (cursor < end && !isFenceLine(lines[cursor])) {
    body.push(lines[cursor]);
    cursor += 1;
  }
  if (cursor >= end) {
    problems.add(file, index + 1, '代码围栏没有闭合（块尾补一行 ```）', 'fence-unterminated');
    return { block: null, next: end };
  }
  return {
    block: { kind: 'code', lang: language, text: body.join('\n'), line: index + 1 },
    next: cursor + 1,
  };
}

/** 列表 → 一层 items；缩进 2 格的行是上一层最后一项的子列表。 */
export function parseList(
  lines: string[], index: number, end: number, ctx: LessonCtx, indent = 0,
): { block: Block; next: number } {
  const { file, problems } = ctx;
  const ordered = ORDERED_RE.test(lines[index].trim());
  const marker = ordered ? ORDERED_RE : UL_RE;
  const items: ListItem[] = [];
  const lineNo = index + 1;
  while (index < end) {
    const raw = lines[index];
    const stripped = raw.trim();
    if (!stripped) break;
    const lead = raw.length - raw.replace(/^ +/, '').length;
    if (lead < indent) break;
    if (lead > indent) {
      problems.add(file, index + 1, `列表嵌套只缩进 2 空格（这一行缩进了 ${lead} 格）`, 'list-indent');
      index += 1;
      continue;
    }
    const match = marker.exec(stripped);
    if (!match) break;
    const item: ListItem = { text: match[1], children: null, line: index + 1 };
    index += 1;
    if (index < end) {
      const follow = lines[index];
      const followLead = follow.length - follow.replace(/^ +/, '').length;
      if (follow.trim() && followLead === indent + 2
          && (UL_RE.test(follow.trim()) || ORDERED_RE.test(follow.trim()))) {
        const child = parseList(lines, index, end, ctx, indent + 2);
        item.children = child.block as unknown as Block;   // 与 Python 的 block dict 同构
        index = child.next;
      }
    }
    items.push(item);
  }
  return { block: { kind: ordered ? 'ol' : 'ul', items, line: lineNo }, next: index };
}

/** 管道表：第二行必须是分隔行（格子数与表头一致、每格都是 `---` 形状）；各行列数也要一致。 */
export function parseTable(
  lines: string[], index: number, end: number, ctx: LessonCtx,
): { block: Block | null; next: number } {
  const { file, problems } = ctx;
  const rows: string[] = [];
  let cursor = index;
  while (cursor < end && lines[cursor].trim().startsWith('|')) {
    rows.push(lines[cursor]);
    cursor += 1;
  }
  const lineNo = index + 1;
  if (rows.length < 2) {
    problems.add(file, lineNo, '表格第二行必须是分隔行（| --- | --- |），第一行是表头',
      'table-separator-missing');
    return { block: null, next: cursor };
  }
  const header = splitCells(rows[0]);
  const separator = splitCells(rows[1]);
  if (separator.length !== header.length) {
    problems.add(file, lineNo + 1,
      `表格分隔行有 ${separator.length} 格，表头是 ${header.length} 格——`
      + '两行的格子数必须一样（如 `| --- | --- |`）', 'table-cell-count');
    return { block: null, next: cursor };
  }
  const bad = separator.filter((cell) => !SEPARATOR_CELL_RE.test(cell));
  if (bad.length > 0) {
    const shown = bad.map((cell) => (cell === '' ? '空的一格' : pyRepr(cell))).join('、');
    problems.add(file, lineNo + 1,
      `表格分隔行的每一格都要写成 ---（现在是 ${shown}）——`
      + '这一行只标明哪几列，不写内容', 'table-separator-cell');
    return { block: null, next: cursor };
  }
  const body: string[][] = [];
  for (let offset = 2; offset < rows.length; offset++) {
    const cells = splitCells(rows[offset]);
    if (cells.length !== header.length) {
      problems.add(file, lineNo + offset,
        `表格这一行有 ${cells.length} 格，表头是 ${header.length} 格`
        + '（单元格里的竖线写成 \\|）', 'table-cell-count');
      continue;
    }
    body.push(cells);
  }
  return { block: { kind: 'table', header, rows: body, line: lineNo }, next: cursor };
}

/** Python 的 `repr()` 只在这两条错误信息里用得到：单引号包裹，内部单引号反斜杠转义。 */
function pyRepr(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/* ── `:::` 指令 ─────────────────────────────────────────────────────────── */

/** `::: <名字> [参数]` … `:::` —— 认不出的名字/写法都带行号报错。 */
export function parseDirective(
  lines: string[], index: number, end: number, ctx: LessonCtx,
): { block: Block | null; next: number } {
  const { file, problems } = ctx;
  const stripped = lines[index].trim();
  const lineNo = index + 1;
  if (stripped === ':::') {
    problems.add(file, lineNo, '多出来的 :::（没有对应的指令开始）', 'stray-colons');
    return { block: null, next: index + 1 };
  }
  const match = DIRECTIVE_RE.exec(stripped);
  if (!match) {
    problems.add(file, lineNo, '指令写法是 ::: <名字> [参数]（这一行认不出）', 'unknown-directive');
    return { block: null, next: index + 1 };
  }
  const name = match[1];
  const args = match[2].trim();
  const known = (DIRECTIVES as readonly string[]).includes(name);
  if (!known) {
    problems.add(file, lineNo,
      `未知指令 ::: ${name}（可用：${DIRECTIVES.join('、')}）`, 'unknown-directive');
  }

  let cursor = index + 1;
  let nested = false;
  let inFence = false;  // 围栏里的 ::: 是代码文本，不是指令边界（JS 侧原来缺这一条）
  while (cursor < end) {
    const text = lines[cursor].trim();
    if (isFenceLine(text)) {
      inFence = !inFence;
      cursor += 1;
      continue;
    }
    if (!inFence) {
      if (text === ':::') break;
      if (!nested && DIRECTIVE_RE.test(text)) {
        problems.add(file, cursor + 1,
          `指令块不能嵌套（::: ${name} 里又开了一个指令）——把一个块拆成两个平级的块`,
          'directive-nested');
        nested = true;
      }
    }
    cursor += 1;
  }
  let bodyEnd: number;
  let nextIndex: number;
  if (cursor >= end) {
    problems.add(file, lineNo, `指令 ::: ${name} 没有闭合（块尾补一行 :::）`, 'directive-unterminated');
    bodyEnd = end;
    nextIndex = end;
  } else {
    bodyEnd = cursor;
    nextIndex = cursor + 1;
  }
  if (!known) return { block: null, next: nextIndex };

  if (name !== 'quiz') rejectStrayEmptyReason(name, lines, index + 1, bodyEnd, ctx);

  if ((CONTAINER_DIRECTIVES as readonly string[]).includes(name)) {
    const { blocks: body } = parseBlocks(lines, index + 1, bodyEnd, ctx);
    if (name === 'practice') {
      return { block: buildPractice(args, body, lineNo, ctx), next: nextIndex };
    }
    return {
      block: { kind: 'directive', name: name as CardBlock['name'], title: args, body, line: lineNo },
      next: nextIndex,
    };
  }

  if (name === 'quiz') {
    return { block: buildQuiz(args, lines, index + 1, bodyEnd, lineNo, ctx), next: nextIndex };
  }
  if (name === 'figure') {
    return { block: buildFigure(args, lines, index + 1, bodyEnd, lineNo, ctx), next: nextIndex };
  }
  if (name === 'svg') {
    return { block: buildSvg(args, lines, index + 1, bodyEnd, lineNo, ctx), next: nextIndex };
  }
  return { block: buildLinks(name, lines, index + 1, bodyEnd, lineNo, ctx), next: nextIndex };
}

/** `empty_reason:` 只属于 `::: quiz` 的无题锚点；别的指令块里写了就按错拦下。
 *
 *  `::: practice`／`::: tip` 这类容器的块内是普通块，这一行会被当段落渲染成
 *  `<p>empty_reason: …</p>` 印给学生，退出码还是 0——等于把内部记号静默送出厂。
 *  围栏里的同名字符串是代码原文，不算。 */
export function rejectStrayEmptyReason(
  name: string, lines: string[], start: number, end: number, ctx: LessonCtx,
): void {
  const { file, problems } = ctx;
  let inFence = false;
  for (let offset = start; offset < end; offset++) {
    const text = lines[offset].trim();
    if (isFenceLine(text)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const field = FIELD_RE.exec(text);
    if (field && field[1] === 'empty_reason') {
      problems.add(file, offset + 1,
        'empty_reason: 只能出现在 ::: quiz 的块里（它给无题锚点用，'
        + `::: ${name} 没有锚点）——删掉这一行；要留题目位置就写 `
        + '::: quiz <层级> 锚点：<锚点文本>', 'stray-empty-reason');
    }
  }
}

/** `::: practice <层级> | <标题>` → .lesson-practice + __head 里两个 span。 */
export function buildPractice(
  args: string, body: Block[], lineNo: number, ctx: LessonCtx,
): PracticeBlock | null {
  const { file, problems } = ctx;
  if (args.split('|').length - 1 !== 1) {
    problems.add(file, lineNo, '写法是 ::: practice <层级> | <标题>（中间一个竖线）', 'practice-args');
    return null;
  }
  const [level, title] = args.split('|').map((part) => part.trim());
  if (!level || !title) {
    problems.add(file, lineNo,
      'practice 的层级与标题都要写（如 ::: practice 练习 | 第 1 步 · 跑三遍）', 'practice-args');
    return null;
  }
  return { kind: 'directive', name: 'practice', level, title, body, line: lineNo };
}

/** `::: quiz <层级> 锚点：<文本>` + 可选 `empty_reason: <理由>`。
 *
 *  全角 `：` 与半角 `:` 都认（Python `锚点[：:]`）；锚点文本**至少 1 字符**，
 *  层级非空。JS 侧原来只认全角、层级含空格就静默丢——那条路现在堵死了。 */
export function buildQuiz(
  args: string, lines: string[], start: number, end: number, lineNo: number, ctx: LessonCtx,
): QuizBlock | null {
  const { file, problems } = ctx;
  const match = /^(.*?)锚点[：:]\s*(.+)$/s.exec(args);
  if (!match) {
    problems.add(file, lineNo, '写法是 ::: quiz <层级> 锚点：<锚点文本>（锚点要和题库的键逐字一致）',
      'quiz-args');
    return null;
  }
  const level = pyStrip(match[1]);
  const anchor = pyStrip(match[2]);
  if (!level) {
    problems.add(file, lineNo, 'quiz 要写层级（理解/改造/排错/应用，见 layered-practice）', 'quiz-level');
    return null;
  }
  let emptyReason: string | null = null;
  for (let offset = start; offset < end; offset++) {
    const text = lines[offset].trim();
    if (!text) continue;
    const field = FIELD_RE.exec(text);
    if (!field || field[1] !== 'empty_reason' || !field[2].trim()) {
      problems.add(file, offset + 1,
        '::: quiz 的块里只写 empty_reason: <理由>（题目按锚点从 .quiz.json 取）', 'quiz-body');
      continue;
    }
    emptyReason = pyStrip(field[2]);
  }
  return {
    kind: 'directive', name: 'quiz', level, anchor,
    empty_reason: emptyReason, line: lineNo,
  };
}

/** `::: figure <相对路径>` + `alt:` + 可选 `caption:`。
 *
 *  路径的存在性由调用方查（解析层不碰文件系统），解析层只管形状与字段。 */
export function buildFigure(
  args: string, lines: string[], start: number, end: number, lineNo: number, ctx: LessonCtx,
): FigureBlock | null {
  const { file, problems } = ctx;
  if (!args) {
    problems.add(file, lineNo, '写法是 ::: figure <相对路径>（图从科目图片库 assets/img/pool/ 挑）',
      'figure-body');
    return null;
  }
  const fields: Record<string, string> = {};
  const fieldLines: Record<string, number> = {};
  for (let offset = start; offset < end; offset++) {
    const text = lines[offset].trim();
    if (!text) continue;
    const field = FIELD_RE.exec(text);
    if (!field || (field[1] !== 'alt' && field[1] !== 'caption')) {
      problems.add(file, offset + 1, '::: figure 的块里只写 alt: 与 caption: 两行', 'figure-body');
      continue;
    }
    fields[field[1]] = pyStrip(field[2]);   // 写两遍后者覆盖前者（Python 也是静默）
    fieldLines[field[1]] = offset + 1;
  }
  if (!fields.alt) {
    problems.add(file, lineNo, '::: figure 缺 alt:（裂图时读屏软件与学生都只剩空白）',
      'figure-missing-alt');
  }
  return {
    kind: 'directive', name: 'figure', src: args,
    alt: fields.alt ?? '', caption: fields.caption ?? '', line: lineNo,
    alt_line: fieldLines.alt ?? lineNo, caption_line: fieldLines.caption ?? lineNo,
  };
}

/** `::: svg` + 可选 `alt:`/`caption:` + 块内 SVG 原样透传。 */
export function buildSvg(
  args: string, lines: string[], start: number, end: number, lineNo: number, ctx: LessonCtx,
): SvgBlock {
  const { file, problems } = ctx;
  if (args) {
    problems.add(file, lineNo, '::: svg 不带参数：说明写在块里的 alt: / caption: 两行', 'svg-args');
  }
  const fields: Record<string, string> = {};
  const fieldLines: Record<string, number> = {};
  const raw: string[] = [];
  for (let offset = start; offset < end; offset++) {
    const rawLine = lines[offset];
    const text = rawLine.trim();
    if (raw.length === 0) {
      if (!text) continue;
      const field = FIELD_RE.exec(text);
      if (field && (field[1] === 'alt' || field[1] === 'caption')) {
        fields[field[1]] = pyStrip(field[2]);
        fieldLines[field[1]] = offset + 1;
        continue;
      }
      if (!text.startsWith('<')) {
        problems.add(file, offset + 1,
          '::: svg 的块里先写 alt:/caption:，接着是 <svg>…</svg> 原文（这一行都不是）', 'svg-body');
        continue;
      }
    }
    raw.push(rawLine);
  }
  // 按**行**拼（保留换行）：拼成一行的话，`</sv` + `g>` 这种拆成两行的收尾也会被当成
  // 合法收尾放行，而页面结构照样断。多行开标签、多行自闭合 `<svg …\n/>` 保留换行也照样过。
  const inlineSvg = raw.join('\n');
  const masked = maskComments(inlineSvg);          // 注释里写的 </svg> 不算收尾
  if (!SVG_OPEN_RE.test(masked)) {
    problems.add(file, lineNo, '::: svg 块里没有 <svg>…</svg> 原文（内联图直接贴进来）', 'svg-no-open');
  } else if (!SVG_CLOSE_RE.test(masked) && !SVG_SELF_CLOSE_RE.test(masked)) {
    problems.add(file, lineNo, '::: svg 块里的 <svg> 没有 </svg> 收尾（原样透传前先补全，'
      + '否则页面结构会从这里断掉；自闭合的 <svg/> 也算收尾）', 'svg-no-close');
  }
  return {
    kind: 'directive', name: 'svg', alt: fields.alt ?? '', caption: fields.caption ?? '',
    raw: raw.join('\n'), line: lineNo,
    alt_line: fieldLines.alt ?? lineNo, caption_line: fieldLines.caption ?? lineNo,
  };
}

/** `::: resources`（`- [标题](url) | 说明`，链接可省）与 `::: related`（`- [标题](href)`）。
 *
 *  没有链接的条目（例如一本书、一份本地文档）写成 `- 标题 | 说明`：语料 0004 的
 *  「Competitive Programming 4（Halim 等，第 4 版）」就是这样一条。 */
export function buildLinks(
  name: string, lines: string[], start: number, end: number, lineNo: number, ctx: LessonCtx,
): LinksBlock {
  const { file, problems } = ctx;
  const items: LinkItem[] = [];
  for (let offset = start; offset < end; offset++) {
    const text = lines[offset].trim();
    if (!text) continue;
    const match = LINK_ITEM_RE.exec(text);
    let title: string;
    let href: string;
    let meta: string;
    if (match) {
      title = match[1];
      href = match[2];
      meta = pyStrip(match[3] ?? '');
      if (meta && name !== 'resources') {
        problems.add(file, offset + 1, '::: related 的条目只写 `- [标题](链接)`'
          + '（说明是 resources 才有的）', 'links-item');
        continue;
      }
    } else {
      const plain = PLAIN_ITEM_RE.exec(text);
      if (!plain || name !== 'resources') {
        problems.add(file, offset + 1, `::: ${name} 的条目写成 \`- [标题](链接)\``
          + (name === 'resources' ? '；纯文字条目（书、本地文档）写成 `- 标题 | 说明`' : ''),
        'links-item');
        continue;
      }
      title = pyStrip(plain[1]);
      href = '';
      meta = pyStrip(plain[2] ?? '');
    }
    if (!title) {
      problems.add(file, offset + 1, `::: ${name} 的条目缺标题`, 'links-item');
      continue;
    }
    items.push({ title, href, meta, line: offset + 1 });
  }
  if (items.length === 0) {
    problems.add(file, lineNo, `::: ${name} 块里没有条目（写 \`- [标题](链接)\`）`, 'links-empty');
  }
  return { kind: 'directive', name: name as LinksBlock['name'], items, line: lineNo };
}

/* ── 行内检查与渲染 ─────────────────────────────────────────────────────── */

/** 行内文本里出现**真标签**或 HTML 注释就报错（code span 里除外：那是要原样显示的代码）。
 *
 *  判据与 `renderInline()` 共用 `codeSpanEnd()`（落单的反引号不是 code 区，遮不住后面的标签）。
 *  一段文字只报第一处（带总数），不刷屏。 */
export function checkInlineHtml(text: string, line: number, where: string, ctx: LessonCtx): void {
  const { file, problems } = ctx;
  let index = 0;
  const hits: string[] = [];
  let comment: number | null = null;
  while (index < text.length) {
    const char = text[index];
    if (char === '`') {
      const close = codeSpanEnd(text, index);
      index = close !== null ? close + 1 : index + 1;
      continue;
    }
    if (char === '<') {
      if (text.startsWith('<!--', index) && comment === null) {
        comment = index;
      } else {
        const tag = tagShapeAt(text, index);
        if (tag) hits.push(tag);
      }
    }
    index += 1;
  }
  if (comment !== null) {
    problems.add(file, line,
      `内容文件不写 HTML 注释（${where}，第 ${comment + 1} 个字符处读到 <!--）——`
      + '那是手写时代留「题目位置」的写法，'
      + '现在题目位置写 `::: quiz <层级> 锚点：…`，说明写进正文', 'html-comment');
  }
  if (hits.length > 0) {
    const more = hits.length > 1 ? `（这一段还有 ${hits.length - 1} 处）` : '';
    problems.add(file, line,
      `不写 HTML（${where}）：读到 ${pyRepr(hits[0])}${more}——内容文件写的是教学内容、`
      + '不是标记：粗体写 `**…**`。要在页面里展示 HTML 本身，'
      + `把那段放进 \`\`\` 围栏（短片段也可以用反引号，如 \`\` \`${hits[0]}\` \`\`）`,
    'html-inline');
  }
}

/** 行内语法：`` `code` ``、`**粗**`、`*斜*`、`[文字](href)`、`^x^`、`~x~`、`$TeX$`、`$$TeX$$`；其余按文字转义。
 *
 *  落单的标记（没有配对的 `*`、`^`、`~`）当普通字符——竞赛正文里 `10 ~ 20`、`a ^ b`
 *  这类写法很常见，不能因为落单就报错。代码 span 里的 `*`/`**` 是字面量，但 `^x^`/`~x~`
 *  仍然解析（语料 0002 有 3 处把 `<sup>` 写在 `<code>` 里面，整条算式当代码）。 */
export function renderInline(text: string, line: number, ctx: LessonCtx, checkHtml = true): string {
  if (checkHtml) checkInlineHtml(text, line, '正文', ctx);   // 只在最外层查一次

  const out: string[] = [];
  let index = 0;
  const length = text.length;
  while (index < length) {
    const char = text[index];
    if (char === '`') {
      const close = codeSpanEnd(text, index);       // 与行内 HTML 检查共用同一判定
      if (close !== null) {
        out.push(`<code>${renderCodeSpan(text.slice(index + 1, close))}</code>`);
        index = close + 1;
        continue;
      }
    } else if (text.startsWith('**', index)) {
      const close = text.indexOf('**', index + 2);
      if (close > index + 2) {
        out.push(`<b>${renderInline(text.slice(index + 2, close), line, ctx, false)}</b>`);
        index = close + 2;
        continue;
      }
    } else if (char === '*') {
      const close = text.indexOf('*', index + 1);
      if (close > index + 1 && !pyIsSpace(text[index + 1]) && !pyIsSpace(text[close - 1])) {
        out.push(`<em>${renderInline(text.slice(index + 1, close), line, ctx, false)}</em>`);
        index = close + 1;
        continue;
      }
    } else if (char === '^' || char === '~') {
      const close = text.indexOf(char, index + 1);
      const inner = close > index + 1 ? text.slice(index + 1, close) : '';
      if (inner && !inner.includes(char) && ![...inner].some(pyIsSpace)) {
        // 判据是 Python 的 `re.search(r'\s', inner)`：实测与 `str.isspace()` 同一集合
        // （都认 \x1c-\x1f 与 \x85，都不认 \ufeff），所以统一走 pyIsSpace。
        const tag = char === '^' ? 'sup' : 'sub';
        out.push(`<${tag}>${renderInline(inner, line, ctx, false)}</${tag}>`);
        index = close + 1;
        continue;
      }
    } else if (char === '\\' && index + 1 < length && text[index + 1] === '$') {
      out.push('$');                                 // `\$`：正文里的字面美元号
      index += 2;
      continue;
    } else if (char === '$' && text.startsWith('$$', index)) {
      const close = text.indexOf('$$', index + 2);   // 段落中间的 `$$…$$`：包成块级占位（span 合法）
      if (close > index + 2) {
        const tex = text.slice(index + 2, close);
        ctx.math.value = true;
        out.push(`<span class="math-block">${escText(tex)}</span>`);
        index = close + 2;
        continue;
      }
      ctx.problems.add(ctx.file, line, '块级公式 `$$…$$` 没有收尾——补上收尾的 `$$`',
        'math-block-unterminated');
      out.push('$$');
      index += 2;
      continue;
    } else if (char === '$') {
      const close = mathClose(text, index);
      if (close !== null) {
        const tex = text.slice(index + 1, close);
        ctx.math.value = true;
        out.push(`<span class="math-inline">${escText(tex)}</span>`);
        index = close + 1;
        continue;
      }
      // 触发条件与 Python 逐字一致：`$` 后面紧跟**非空白且非行尾**才报——
      // `花了 $5 和 $10` 因此报错（文档原来写「按字面量处理」，已按实现改掉）。
      const next = text.slice(index + 1, index + 2);
      if (next !== '' && !pyIsSpace(next)) {
        ctx.problems.add(ctx.file, line,
          '行内公式 `$…$` 没有收尾——补上收尾的 `$`；正文里真要写美元号就写成 `\\$`',
          'math-unterminated');
      }
      out.push('$');
      index += 1;
      continue;
    } else if (char === '[') {
      const link = LINK_RE.exec(text.slice(index));
      if (link && link.index === 0) {
        const href = escAttr(link[2]);
        out.push(`<a href="${href}">${renderInline(link[1], line, ctx, false)}</a>`);
        index += link[0].length;
        continue;
      }
    }
    out.push(escText(char));
    index += 1;
  }
  return out.join('');
}

/** code span 的内文：转义，但 `^x^`/`~x~` 仍解析成上/下标（其余标记是字面量）。 */
export function renderCodeSpan(text: string): string {
  const out: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '^' || char === '~') {
      const close = text.indexOf(char, index + 1);
      const inner = close > index + 1 ? text.slice(index + 1, close) : '';
      if (inner && !inner.includes(char) && ![...inner].some(pyIsSpace)) {
        const tag = char === '^' ? 'sup' : 'sub';
        out.push(`<${tag}>${renderCodeSpan(inner)}</${tag}>`);
        index = close + 1;
        continue;
      }
    }
    out.push(escText(char));
    index += 1;
  }
  return out.join('');
}

/* ── 块渲染 ─────────────────────────────────────────────────────────────── */

/** 给图注编号：剥掉作者可能手写的旧号，按**页内出现顺序**重编。
 *
 *  编号是可推导的信息（这一页第几张图），手写必然漂移。只给**有说明文字**的图编号：
 *  没 caption 的图没有可见标签，不该占号。返回空串＝这张图不编号。 */
export function numberedCaption(caption: string, ctx: LessonCtx): string {
  const text = pyStrip(caption.trim().replace(CAPTION_NUMBER_RE, ''));
  if (!text) return '';
  ctx.figureNo.value += 1;
  return `图 ${ctx.figureNo.value} · ${text}`;
}

const BLOCK_MATH_RE = /^\$\$(.+)\$\$$/s;

/** 把块列表渲染成 HTML 片段（缩进两格一层，与 Python 的 `Renderer.render` 同形）。 */
export function renderBlocks(blocks: Block[], ctx: LessonCtx, indent = '  '): string {
  return blocks.map((block) => renderBlock(block, ctx, indent)).filter(Boolean).join('\n\n');
}

/** 单个块 → HTML 片段。认不出的 kind 是**渲染器的 bug**，报错而不是安静丢内容。 */
export function renderBlock(block: Block, ctx: LessonCtx, indent: string): string {
  const kind = block.kind;
  if (kind === 'h2' || kind === 'h3') {
    const node = block as { text: string; line: number };
    return `${indent}<${kind}>${renderInline(node.text, node.line, ctx)}</${kind}>`;
  }
  if (kind === 'p') {
    const node = block as { text: string; line: number };
    const math = BLOCK_MATH_RE.exec(node.text.trim());
    if (math) {
      ctx.math.value = true;
      return `${indent}<div class="math-block">${escText(pyStrip(math[1]))}</div>`;
    }
    return `${indent}<p>${renderInline(node.text, node.line, ctx)}</p>`;
  }
  if (kind === 'code') {
    const node = block as { lang: string; text: string };
    const attr = node.lang ? ` data-lang="${escAttr(node.lang)}"` : '';
    return `${indent}<pre${attr}><code>${escText(node.text)}</code></pre>`;
  }
  if (kind === 'ul' || kind === 'ol') {
    return renderList(block as { kind: 'ul' | 'ol'; items: ListItem[] }, ctx, indent);
  }
  if (kind === 'table') {
    const node = block as { header: string[]; rows: string[][]; line: number };
    const head = node.header.map((cell) => `<th>${renderInline(cell, node.line, ctx)}</th>`).join('');
    const lines = [`${indent}<table>`, `${indent}  <thead>`, `${indent}    <tr>${head}</tr>`,
      `${indent}  </thead>`, `${indent}  <tbody>`];
    for (const row of node.rows) {
      const cells = row.map((cell) => `<td>${renderInline(cell, node.line, ctx)}</td>`).join('');
      lines.push(`${indent}    <tr>${cells}</tr>`);
    }
    lines.push(`${indent}  </tbody>`, `${indent}</table>`);
    return lines.join('\n');
  }
  if (kind === 'directive') {
    return renderDirective(block as { name: string; line: number }, ctx, indent);
  }
  // 兜底：认不出的块**报错**而不是安静地丢——静默丢内容正是这次改造要消灭的东西
  ctx.problems.add(ctx.file, (block as { line?: number }).line ?? 1,
    `渲染器不认识这种块（kind=${pyRepr(String(kind))}）——这是渲染器的 bug，`
    + '请把这一条连同内容文件报到引擎维护者', 'unknown-block');
  return '';
}

function renderList(
  block: { kind: 'ul' | 'ol'; items: ListItem[] }, ctx: LessonCtx, indent: string,
): string {
  const lines = [`${indent}<${block.kind}>`];
  for (const item of block.items) {
    const text = renderInline(item.text, item.line, ctx);
    if (item.children) {
      lines.push(`${indent}  <li>${text}`);
      lines.push(renderBlock(item.children, ctx, `${indent}    `));
      lines.push(`${indent}  </li>`);
    } else {
      lines.push(`${indent}  <li>${text}</li>`);
    }
  }
  lines.push(`${indent}</${block.kind}>`);
  return lines.join('\n');
}

/** 指令块 → HTML。认不出的指令同样是渲染器的 bug，报错不做静默空输出。 */
export function renderDirective(
  block: { name: string; line: number }, ctx: LessonCtx, indent: string,
): string {
  const name = block.name;
  const line = block.line;
  if (name === 'practice') {
    const node = block as PracticeBlock;
    const lines = [`${indent}<div class="lesson-practice">`,
      `${indent}  <div class="lesson-practice__head">`,
      `${indent}    <span class="lesson-practice__level">${renderInline(node.level, node.line, ctx)}</span>`,
      `${indent}    <span class="lesson-practice__title">${renderInline(node.title, node.line, ctx)}</span>`,
      `${indent}  </div>`];
    const inner = renderBlocks(node.body, ctx, `${indent}    `);
    if (inner) lines.push('', inner);
    lines.push(`${indent}</div>`);
    return lines.join('\n');
  }
  if (name in CARD_CLASS) {
    const node = block as CardBlock;
    const lines = [`${indent}<div class="${CARD_CLASS[name]}">`];
    if (node.title) lines.push(`${indent}  <b>${renderInline(node.title, line, ctx)}</b>`);
    const inner = renderBlocks(node.body, ctx, `${indent}  `);
    if (inner) lines.push(inner);
    lines.push(`${indent}</div>`);
    return lines.join('\n');
  }
  if (name === 'quiz') return renderQuiz(block as QuizBlock, ctx, indent);
  if (name === 'figure') return renderFigure(block as FigureBlock, ctx, indent);
  if (name === 'svg') return renderSvg(block as SvgBlock, ctx, indent);
  if (name === 'resources' || name === 'related') {
    const node = block as LinksBlock;
    if (name === 'related') {
      const lines = [`${indent}<div class="lesson-related">`];
      for (const item of node.items) {
        lines.push(`${indent}  <a href="${escAttr(item.href)}">`
          + `${renderInline(item.title, item.line, ctx)}</a>`);
      }
      lines.push(`${indent}</div>`);
      return lines.join('\n');
    }
    const lines = [`${indent}<ul class="lesson-resources">`];
    for (const item of node.items) {
      const meta = item.meta
        ? `<span class="lesson-resources__meta">${renderInline(item.meta, item.line, ctx)}</span>` : '';
      const head = item.href
        ? `<a href="${escAttr(item.href)}">${renderInline(item.title, item.line, ctx)}</a>`
        : renderInline(item.title, item.line, ctx);
      lines.push(`${indent}  <li>${head}${meta}</li>`);
    }
    lines.push(`${indent}</ul>`);
    return lines.join('\n');
  }
  ctx.problems.add(ctx.file, line,
    `渲染器不认识这个指令（name=${pyRepr(String(name))}）——这是渲染器的 bug，`
    + '请把这一条连同内容文件报到引擎维护者', 'unknown-directive');
  return '';
}

/**
 * 按锚点从题库取题；锚点没题时必须 `empty_reason`，否则报错（绝不静默出一个空块）。
 *
 * 这里**不**重复报「锚点没题」——那条由 `lib/core/lesson.ts` 的对账报（它同时管提示
 * 通道与重复锚点）。渲染层只管：有题就出 `data-quiz`、有题却写了 `empty_reason:` 就报。
 */
export function renderQuiz(block: QuizBlock, ctx: LessonCtx, indent: string): string {
  const pool = ctx.pool;
  const questions = pool != null && Object.prototype.hasOwnProperty.call(pool, block.anchor)
    ? pool[block.anchor] : null;
  if (Array.isArray(questions) && questions.length > 0) {
    if (block.empty_reason) {
      ctx.problems.add(ctx.file, block.line,
        `锚点「${block.anchor}」在题库里有 ${questions.length} 道题，`
        + 'empty_reason 是给无题锚点用的（删掉它）', 'anchor-missing');
    }
    const payload = JSON.stringify(questions, null, 2);
    return `${indent}<div class="quiz" data-quiz='${escapeQuizAttr(payload)}'></div>`;
  }
  if (block.empty_reason) return '';   // 按理由跳过（`提示:` 那条在对账里出）
  return '';
}

/** 图注：先按页内顺序编号，再补图片库的来源/许可。 */
export function figureCaption(block: FigureBlock, ctx: LessonCtx): string {
  let caption = numberedCaption(block.caption, ctx);
  if (!caption.includes('来源：')) caption += ctx.poolSource ? ctx.poolSource(block.src) : '';
  return caption;
}

/** `::: figure` 的 HTML。**不做文件存在性检查**（那是调用方的 `checkFigureSrc`）。 */
export function renderFigure(block: FigureBlock, ctx: LessonCtx, indent: string): string {
  const alt = block.alt;
  checkInlineHtml(alt, block.alt_line ?? block.line, '::: figure 的 alt:', ctx);
  const caption = figureCaption(block, ctx);
  const lines = [`${indent}<figure class="lesson-figure">`,
    `${indent}  <img src="${escAttr(block.src)}" alt="${escAttr(alt)}">`];
  if (caption) {
    lines.push(`${indent}  <figcaption>`
      + `${renderInline(caption, block.caption_line ?? block.line, ctx)}</figcaption>`);
  }
  lines.push(`${indent}</figure>`);
  return lines.join('\n');
}

/** `::: svg` 的 HTML（块内 SVG 原样透传，不转义、不改写）。 */
export function renderSvg(block: SvgBlock, ctx: LessonCtx, indent: string): string {
  let attr = '';
  if (block.alt) {
    checkInlineHtml(block.alt, block.alt_line ?? block.line, '::: svg 的 alt:', ctx);
    attr = ` role="img" aria-label="${escAttr(block.alt)}"`;
  }
  const lines = [`${indent}<figure class="lesson-figure lesson-figure--inline"${attr}>`, block.raw];
  // 与 `::: figure` **共用一条编号序列**（页内出现顺序），但 `::: svg` 不补图片库来源
  const caption = numberedCaption(block.caption, ctx);
  if (caption) {
    lines.push(`${indent}  <figcaption>`
      + `${renderInline(caption, block.caption_line ?? block.line, ctx)}</figcaption>`);
  }
  lines.push(`${indent}</figure>`);
  return lines.join('\n');
}

/* ── 图片路径的形状检查（存在性由调用方） ───────────────────────────────── */

/**
 * `::: figure` 的源路径检查：只接受**本地相对路径**。
 *
 *  Python 还会查文件是否存在（`os.path.isfile`）——那件事解析层做不了（不碰文件系统），
 *  所以拆成两半：这里判形状，`options.checkFigureSrc` 钩子由调用方提供存在性判定，
 *  返回的字符串会**原样接在**同一条错误信息后面（调用方补「解析到 <绝对路径>」那段）。
 */
export function figureSrcProblem(src: string): { message: string; needsExistsCheck: boolean } | null {
  if (SCHEME_RE.test(src) || decodeImageSrc(src).startsWith('/')) {
    return {
      message: `::: figure 只接受本地相对路径（现在是 ${src}）——图从科目图片库 assets/img/pool/ 挑`,
      needsExistsCheck: false,
    };
  }
  return { needsExistsCheck: true, message: '' };
}
