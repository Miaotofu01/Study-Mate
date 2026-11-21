// 无界笔记 · 源码优先的行内即时编辑器：纯解析/装饰助手（Node 里可直接测，不碰 DOM）
//
// 文档模型是**原始 Markdown 字符串**，不是 ProseMirror 富文本树。这里只做两件事：
//   1. 从 Markdown 语法树里取出「哪些位置是格式、哪些字符是它的分隔符」；
//   2. 按当前选区决定每个分隔符**显形为灰色源码**还是**藏起来**。
//
// 藏起来靠装饰类 + CSS（display:none），分隔符始终是 CodeMirror 文档里的真实字符，
// 既不是替换 widget，也不是假的文本节点。因此删除一个 `*` 就是删除文档里的一个字符，
// 撤销、IME、行尾解析都走 CodeMirror 原本那条路。
//
// 语法来源固定为 `markdownLanguage.parser`：它自带 GFM（表格、删除线），
// 不再额外注册 `@lezer/markdown` 包。代码块/行内代码是独立节点，所以代码里的
// `**` 与转义过的 `\*` 不会被当成强调——这里不靠正则猜。

import { markdownLanguage } from '@codemirror/lang-markdown';

/** 与源码编辑器同一个上限：128 Ki 字符。超了整笔拒绝，不截断。 */
export const MAX_MARKDOWN_LENGTH = 128 * 1024;
export const OVERSIZE_MESSAGE = '正文最多 128 Ki 字符；这次修改未写入，原稿已保留。';

/* ── 行尾：canonical 字符串保留原始换行，编辑器内部只认 \n ───────────────── */

/**
 * 把 canonical 文本切成「行 + 每两行之间的真实换行串」。
 * `a\r\nb\nc` → { lines: ['a','b','c'], eols: ['\r\n','\n'] }。
 */
export function splitLinesWithEol(text) {
  const source = String(text ?? '');
  const lines = [];
  const eols = [];
  const re = /\r\n|\r|\n/g;
  let last = 0;
  let match;
  while ((match = re.exec(source))) {
    lines.push(source.slice(last, match.index));
    eols.push(match[0]);
    last = match.index + match[0].length;
  }
  lines.push(source.slice(last));
  return { lines, eols };
}

/** 文档里最常见的换行；新插入的换行沿用它。空文档默认 `\n`。 */
export function dominantEol(text) {
  const source = String(text ?? '');
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = source.indexOf('\n'); index >= 0; index = source.indexOf('\n', index + 1)) {
    if (index > 0 && source[index - 1] === '\r') crlf += 1;
    else lf += 1;
  }
  for (let index = source.indexOf('\r'); index >= 0; index = source.indexOf('\r', index + 1)) {
    if (source[index + 1] !== '\n') cr += 1;
  }
  if (crlf >= lf && crlf >= cr && crlf > 0) return '\r\n';
  if (cr > lf) return '\r';
  return '\n';
}

/** 编辑器内部文档：所有换行都变成单个 `\n`（CodeMirror 的文本模型）。 */
export function normalizeLineEndings(text) {
  return String(text ?? '').replace(/\r\n|\r/g, '\n');
}

/** 把用户插入的文本里的换行统一成文档的换行风格。 */
export function canonicalizeInsert(insert, eol = '\n') {
  return String(insert ?? '').replace(/\r\n|\r|\n/g, eol);
}

/**
 * 编辑器偏移 → canonical 偏移的映射。返回值第 i 项是规范化文本第 i 个字符
 * 在 canonical 里的起点；最后一项是 canonical 末尾。
 */
export function canonicalOffsetMap(canonical) {
  const source = String(canonical ?? '');
  const normalizedLength = normalizeLineEndings(source).length;
  const map = new Array(normalizedLength + 1);
  let canon = 0;
  for (let index = 0; index < normalizedLength; index += 1) {
    map[index] = canon;
    if (source[canon] === '\r' && source[canon + 1] === '\n') canon += 2;
    else canon += 1;
  }
  map[normalizedLength] = source.length;
  return map;
}

/**
 * 把 CodeMirror 坐标下的一组 changes 应用到 canonical 字符串上。
 * 未触碰的字符（包括每一处 CRLF/CR/LF）逐字节保留；新插入的换行取 eol。
 * changes 必须按 from 升序、互不重叠，否则抛 RangeError。
 *
 * @param {string} canonical 上一版原始 Markdown
 * @param {ReadonlyArray<{from:number,to:number,insert:string}>} changes 编辑器坐标
 * @param {string} [eol] 新换行风格，默认取文档里最常见的那种
 * @returns {string}
 */
export function applySourceChanges(canonical, changes, eol = dominantEol(canonical)) {
  const source = String(canonical ?? '');
  const map = canonicalOffsetMap(source);
  const normalizedLength = map.length - 1;
  const list = Array.from(changes || []);
  let cursor = 0;
  let result = '';
  for (const change of list) {
    const from = Number(change?.from);
    const to = Number(change?.to);
    const insert = change?.insert;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > normalizedLength) {
      throw new RangeError('change 超出文档范围');
    }
    if (from < cursor) throw new RangeError('change 必须升序且互不重叠');
    result += source.slice(map[cursor], map[from]);
    result += canonicalizeInsert(insert, eol);
    cursor = to;
  }
  result += source.slice(map[cursor]);
  return result;
}

/** 只接受绝对 http(s) 链接；编辑态不跟随任何链接，这个判断留给宿主/预览用。 */
export function safeExternalHref(value) {
  const text = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

/* ── 原始字符串坐标 ⇄ 编辑器坐标 ─────────────────────────────────────────────
   对外的 API（read().from/to、edit 的 changes/selection、onSelectionChange）全部用
   **canonical 原始字符串坐标**：父组件把 read().text 当普通字符串做 indexOf/slice。
   CodeMirror 内部把 CRLF/CR 折成单个 \n，两个坐标空间靠下面两张表来回投影。
   CRLF 中间那个「\n 之后、\r 之前」的位置在编辑器里不存在，统一落到换行起点。 */

/** 原始偏移 → 编辑器偏移。 */
export function editorOffsetForRaw(canonical, rawOffset) {
  const source = String(canonical ?? '');
  const offset = Math.max(0, Math.min(source.length, Math.trunc(Number(rawOffset) || 0)));
  const map = rawOffsetMap(source);
  return map[offset];
}

/** 编辑器偏移 → 原始偏移。 */
export function rawOffsetForEditor(canonical, editorOffset) {
  const source = String(canonical ?? '');
  const map = canonicalOffsetMap(source);
  const offset = Math.max(0, Math.min(map.length - 1, Math.trunc(Number(editorOffset) || 0)));
  return map[offset];
}

/**
 * 原始坐标 → 编辑器坐标的反向表。第 i 项是 canonical 第 i 个字符在编辑器里的位置；
 * CRLF 的 `\r` 与 `\n` 之间映射到换行起点。
 */
export function rawOffsetMap(canonical) {
  const source = String(canonical ?? '');
  const editorToRaw = canonicalOffsetMap(source);
  const map = new Array(source.length + 1);
  for (let editor = 0; editor < editorToRaw.length; editor += 1) {
    const raw = editorToRaw[editor];
    map[raw] = editor;
    const nextRaw = editor + 1 < editorToRaw.length ? editorToRaw[editor + 1] : source.length;
    for (let interior = raw + 1; interior < nextRaw; interior += 1) map[interior] = editor;
  }
  map[source.length] = editorToRaw.length - 1;
  return map;
}

/**
 * 直接在 canonical 字符串上应用父组件的原始坐标改动：插入的字节原样保留
 * （父组件插 `\r\n` 就得到 `\r\n`）。changes 必须升序、互不重叠。
 */
export function applyRawSourceChanges(canonical, changes) {
  const source = String(canonical ?? '');
  const list = Array.from(changes || []);
  let cursor = 0;
  let result = '';
  for (const change of list) {
    const from = Number(change?.from);
    const to = Number(change?.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > source.length) {
      throw new RangeError('change 超出原始字符串范围');
    }
    if (from < cursor) throw new RangeError('change 必须升序且互不重叠');
    result += source.slice(cursor, from);
    result += String(change?.insert ?? '');
    cursor = to;
  }
  result += source.slice(cursor);
  return result;
}

/** 原始坐标改动 → CodeMirror 坐标改动（CRLF 折成 \n，供 dispatch 使用）。 */
export function editorChangesForRaw(canonical, changes) {
  const map = rawOffsetMap(canonical);
  return Array.from(changes || []).map((change) => ({
    from: map[change.from],
    to: map[change.to],
    insert: normalizeLineEndings(change.insert),
  }));
}

/* ── 语法树 → 行内格式区间 ───────────────────────────────────────────────── */

const FORMAT_KINDS = Object.freeze({
  StrongEmphasis: 'strong',
  Emphasis: 'emphasis',
  Strikethrough: 'strike',
  InlineCode: 'inline-code',
  Link: 'link',
  Image: 'image',
  ListItem: 'list',
  Blockquote: 'quote',
  FencedCode: 'fenced-code',
  Table: 'table',
});

const HEADING_RE = /^(?:ATXHeading[1-6]|SetextHeading[1-2])$/;

/* ── 列表项的渲染元数据（休息态用真的项目符号/编号，不靠正则在装饰层猜） ──────
   列表项的 `kind` 仍是 `list`，分隔符仍是真实的 ListMark（+ 后续空格）；这里额外
   给出休息态渲染要用的层级、序号与行首替换起点。活动态照旧只露出 `md-syntax`。

   - 序号按 CommonMark 语义：同一 OrderdList 从首个 `3.` 这样的起始号开始递增，
     源文件里后面写错的号码不参与显示；
   - 层级只数包住它的 BulletList / OrderedList，引用里的列表从 1 起；
   - 行首替换起点跳过 `> ` 引用前缀：引用标记的显隐仍归 quote span 管。 */

const LIST_NODE_NAMES = ['BulletList', 'OrderedList'];
const TASK_NODE_NAME = 'TaskMarker';

/** 休息态列表缩进的一级宽度（em）与项目符号位宽（em）。 */
export const LIST_INDENT_EM = 1.5;
export const LIST_BULLET_EM = 1.4;

/** 偏移所在行的行首（不含换行）。 */
function lineStartBefore(source, offset) {
  const index = source.lastIndexOf('\n', Math.max(0, offset - 1));
  return index < 0 ? 0 : index + 1;
}

/**
 * 列表项行首替换的起点：跳过引用前缀（`> ` 可有多层），把缩进留给列表 widget。
 * `  > - item` 返回 `-` 的位置；`  - item` 返回行首；`> - item` 返回 `-`。
 */
function listPrefixStart(source, lineFrom, markFrom) {
  const text = String(source ?? '');
  let cursor = Math.max(0, lineFrom);
  while (cursor < markFrom) {
    let next = cursor;
    while (next < markFrom && (text[next] === ' ' || text[next] === '\t')) next += 1;
    if (next < markFrom && text[next] === '>') {
      cursor = next + 1;
      if (cursor < markFrom && text[cursor] === ' ') cursor += 1;
      continue;
    }
    break;
  }
  return cursor;
}

/**
 * 续行正文的起点：跳过行首空白与引用前缀（`> `/`>   ` 可有多层）。
 * 惰性续行（`lazy line`）返回 0；`  lazy` 返回 2；`>   cont` 返回 4。
 * 只按字符形状判断，不读语法树：调用方已经用 ListItem 节点范围锁定「这行属于该项」。
 */
export function listLineBodyStart(lineText) {
  const text = String(lineText ?? '');
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] === ' ' || text[cursor] === '\t') {
      cursor += 1;
      continue;
    }
    if (text[cursor] === '>') {
      cursor += 1;
      if (text[cursor] === ' ') cursor += 1;
      continue;
    }
    break;
  }
  return cursor;
}

/** 列表项是否以 GFM 任务标记开头；不把嵌套列表里的任务算到外层。 */
function itemStartsWithTask(node) {
  const stack = [];
  for (let child = node.firstChild; child; child = child.nextSibling) stack.push(child);
  while (stack.length) {
    const current = stack.pop();
    if (current.name === TASK_NODE_NAME) return true;
    if (LIST_NODE_NAMES.includes(current.name)) continue;
    for (let child = current.firstChild; child; child = child.nextSibling) stack.push(child);
  }
  return false;
}

/** 列表项嵌套层级（1 起）：只数包含它的列表节点。 */
function listItemDepth(node) {
  let depth = 0;
  for (let current = node.parent; current; current = current.parent) {
    if (LIST_NODE_NAMES.includes(current.name)) depth += 1;
  }
  return Math.max(1, depth);
}

/**
 * 列表标记的渲染版面：缩进、编号/符号位、正文起点（三者都以 em 计）。
 * 编辑器里的行样式与 widget 共用这一份，免得两处各算一套。
 */
export function listMarkerLayout(span) {
  const depth = Math.max(1, Math.trunc(Number(span?.depth) || 1));
  const indentEm = (depth - 1) * LIST_INDENT_EM;
  const ordered = Boolean(span?.ordered);
  const rawNumber = Number(span?.number);
  const number = Number.isFinite(rawNumber) ? Math.max(0, Math.trunc(rawNumber)) : 1;
  const suffix = span?.suffix === ')' ? ')' : '.';
  const label = ordered ? `${number}${suffix}` : '•';
  // 数字位宽按字符数估算，三位数以上的编号不会压到正文。
  const markEm = ordered ? Math.max(1.6, label.length * 0.62 + 0.45) : LIST_BULLET_EM;
  return { ordered, label, indentEm, markEm, padEm: indentEm + markEm };
}

/**
 * 列表标记后面的一段空白（CommonMark 允许 1–4 个空格；制表符也算）。
 * 只用于 list 分隔符，让 `-   item` 的正文起点与 widget 宽度一致。
 */
function expandListSpace(range, source) {
  let end = range.to;
  while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end += 1;
  return end > range.from ? { from: range.from, to: end } : { ...range };
}

/** 每种格式正文的语义类名；浏览器断言就认这些。 */
export const SPAN_CLASS = Object.freeze({
  strong: 'md-strong',
  emphasis: 'md-emphasis',
  strike: 'md-strike',
  'inline-code': 'md-inline-code',
  link: 'md-link',
  image: 'md-image',
  heading: 'md-heading',
  list: 'md-list',
  quote: 'md-quote',
});

/** 分隔符节点名。只取直接子节点，避免把嵌套格式的分隔符算到外层。 */
const DELIMITER_NAMES = Object.freeze({
  strong: ['EmphasisMark'],
  emphasis: ['EmphasisMark'],
  strike: ['StrikethroughMark'],
  'inline-code': ['CodeMark'],
  link: ['LinkMark', 'URL'],
  image: ['LinkMark', 'URL'],
  heading: ['HeaderMark'],
  list: ['ListMark'],
  quote: ['QuoteMark'],
  'fenced-code': ['CodeMark'],
  table: [],
});

function directChildren(node, names) {
  const ranges = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (names.includes(child.name)) ranges.push({ from: child.from, to: child.to });
  }
  return ranges;
}

/**
 * 取出整篇文档里的格式区间。
 *
 * @param {import('@lezer/common').Tree} tree `markdownLanguage.parser.parse(text)`
 * @param {string} [text] 同一份文本，用来把列表/引用的分隔符连同后面的一个空格一起藏起来
 * @returns {Array<{kind:string, from:number, to:number, content:{from:number,to:number}|null,
 *   delimiters:Array<{from:number,to:number}>, block:boolean}>}
 */
export function collectInlineSpans(tree, text = '') {
  const source = String(text ?? '');
  const spans = [];
  if (!tree || typeof tree.iterate !== 'function') return spans;

  // 每个有序列表的起始号与已数到的项数；tree.iterate 按文档顺序进入，
  // 所以同一父列表的 ListItem 依次自增，嵌套列表按自己的父节点单独计数。
  const orderedGroups = new Map();

  const pushSpan = (kind, node, delimiters, content, block, extra) => {
    spans.push({
      kind,
      from: node.from,
      to: node.to,
      content,
      delimiters: delimiters.filter((range) => range.to > range.from),
      block: Boolean(block),
      ...(extra || {}),
    });
  };

  tree.iterate({
    enter(ref) {
      const node = ref.node;
      if (HEADING_RE.test(node.name)) {
        const marks = directChildren(node, DELIMITER_NAMES.heading);
        const lastMark = marks[marks.length - 1];
        const prefix = lastMark ? expandSpace(lastMark, source) : null;
        const delimiters = prefix ? [prefix] : [];
        const from = prefix ? prefix.to : (lastMark ? lastMark.to : node.from);
        // ATXHeading1..6 / SetextHeading1..2：层级进 span，编辑器按层级上字号梯度。
        const level = Number((/(?:ATXHeading|SetextHeading)([1-6])$/.exec(node.name) || [])[1] || 0);
        pushSpan('heading', node, delimiters, { from, to: node.to }, true, level ? { level } : undefined);
        return;
      }
      const kind = FORMAT_KINDS[node.name];
      if (!kind) {
        // GFM 任务项：`[x]` / `[ ]` 本身是真实字符。休息态由组件换成只读勾选框，
        // 选区进来后照常留在文档里，显示为灰色 `[x]`，可逐字删除/修改。
        if (node.name === 'TaskMarker') {
          pushSpan('task', node, [{ from: node.from, to: node.to }], null, false);
        }
        return;
      }
      const rawDelimiters = directChildren(node, DELIMITER_NAMES[kind] || []);

      if (kind === 'fenced-code') {
        // 围栏行只在对内激活时显形；休息态由组件用空替换收起来，代码正文始终等宽高亮。
        pushSpan(kind, node, rawDelimiters, null, true);
        return;
      }
      if (kind === 'table') {
        pushSpan(kind, node, [], null, true);
        return;
      }
      if (kind === 'image') {
        // 图片一律停在本地占位：URL 只做 title/数据属性，永不请求远端。
        const textStart = rawDelimiters[0]?.to ?? node.from;
        const textEnd = rawDelimiters[1]?.from ?? node.to;
        pushSpan(kind, node, rawDelimiters, { from: textStart, to: Math.max(textStart, textEnd) }, false);
        return;
      }
      if (kind === 'link') {
        // `[`、`]`、`(`、`)` 与 URL 都是可显形的分隔符；正文是链接文字。
        const delimiters = rawDelimiters;
        const textEnd = rawDelimiters.length >= 2 ? rawDelimiters[1].from : node.to;
        const textStart = rawDelimiters.length >= 1 ? rawDelimiters[0].to : node.from;
        pushSpan(kind, node, delimiters, { from: textStart, to: Math.max(textStart, textEnd) }, false);
        return;
      }
      if (kind === 'list' || kind === 'quote') {
        const mark = rawDelimiters[0];
        const delimiters = mark
          ? [kind === 'list' ? expandListSpace(mark, source) : expandSpace(mark, source)]
          : [];
        const from = delimiters.length ? delimiters[0].to : node.from;
        // 引用需要给整段的每一行挂边线；其源码标记的显隐仍由选区控制。
        if (kind === 'quote') {
          pushSpan(kind, node, delimiters, { from, to: node.to }, true);
          return;
        }
        const parent = node.parent;
        const ordered = Boolean(parent && parent.name === 'OrderedList');
        let number = null;
        if (ordered) {
          const key = parent.from;
          let group = orderedGroups.get(key);
          if (!group) {
            const head = /^(\d{1,9})[.)]/.exec(source.slice(parent.from, parent.from + 16));
            group = { start: head ? Number(head[1]) : 1, used: 0 };
            orderedGroups.set(key, group);
          }
          number = group.start + group.used;
          group.used += 1;
        }
        const markFrom = mark ? mark.from : node.from;
        // `1)` 与 `1.` 都是合法有序标记；休息态沿用文档里真实的那个收尾符，不擅自改写。
        const orderedSuffix = mark && source[mark.to - 1] === ')' ? ')' : '.';
        pushSpan('list', node, delimiters, { from, to: node.to }, false, {
          ordered,
          number,
          suffix: ordered ? orderedSuffix : '',
          depth: listItemDepth(node),
          indentFrom: listPrefixStart(source, lineStartBefore(source, markFrom), markFrom),
          task: itemStartsWithTask(node),
        });
        return;
      }
      // strong / emphasis / strike / inline-code：正文夹在首尾分隔符之间。
      const content = rawDelimiters.length >= 2
        ? { from: rawDelimiters[0].to, to: rawDelimiters[rawDelimiters.length - 1].from }
        : { from: node.from, to: node.to };
      pushSpan(kind, node, rawDelimiters, content, false);
    },
  });
  return spans;
}

function expandSpace(range, source) {
  return source[range.to] === ' ' ? { from: range.from, to: range.to + 1 } : { ...range };
}

/**
 * 围栏行信息串里的语言名（首 token，去掉尾部反引号）；没有信息串就返回空串。
 * 编辑器休息态的语言角标与测试共用这一份判据。
 */
export function fenceLanguage(lineText) {
  const match = /^\s*(`{3,}|~{3,})\s*(.*?)\s*$/.exec(String(lineText ?? ''));
  const info = match ? match[2] : '';
  if (!info) return '';
  return info.split(/\s+/)[0].replace(/`+$/, '');
}

/**
 * 选区是否「碰」到这个格式区间。
 * 空光标把左右端点都算进来：光标停在开分隔符之前（可编辑左边界）或收分隔符之后时，
 * 分隔符必须显形，否则 DOM 光标会落到隐藏文本的另一侧，敲字就插错位置。
 * 非空选区按区间相交算。
 */
export function selectionTouchesSpan(span, ranges) {
  if (!span || !Array.isArray(ranges)) return false;
  return ranges.some((range) => {
    const from = Number(range?.from);
    const to = Number(range?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    if (from === to) return span.from <= from && from <= span.to;
    return from < span.to && to > span.from;
  });
}

/**
 * 把格式区间翻成装饰描述：正文上语义类，分隔符上 `md-syntax`，
 * 没被选区碰到的分隔符再加 `md-syntax-hidden`（CSS 里 display:none）。
 * 聊天里那段 `plain **bold** plain **other**` 就是靠这里做到只显形被碰到的那一对。
 *
 * @param {import('@lezer/common').Tree} tree
 * @param {ReadonlyArray<{from:number,to:number}>} ranges 当前选区（可多条）
 * @param {string} [text]
 */
export function collectDecorationRanges(tree, ranges = [], text = '') {
  const spans = collectInlineSpans(tree, text);
  const marks = [];
  for (const span of spans) {
    const active = selectionTouchesSpan(span, ranges);
    const contentClass = SPAN_CLASS[span.kind];
    if (span.content && contentClass) {
      // 标题带层级：正文类之外追加 md-heading-N，字号梯度由模块 CSS 负责。
      const classes = span.level ? `${contentClass} md-heading-${span.level}` : contentClass;
      marks.push({ from: span.content.from, to: span.content.to, classes });
    }
    for (const delimiter of span.delimiters) {
      marks.push({
        from: delimiter.from,
        to: delimiter.to,
        classes: active ? 'md-syntax' : 'md-syntax md-syntax-hidden',
        active,
        spanKind: span.kind,
      });
    }
  }
  return { spans, marks };
}

/** 语法树里不能当数学/格式解析的区间：行内代码、围栏代码、缩进代码。 */
export function codeExclusionRanges(tree) {
  const ranges = [];
  if (!tree || typeof tree.iterate !== 'function') return ranges;
  tree.iterate({
    enter(node) {
      if (node.name === 'InlineCode' || node.name === 'FencedCode' || node.name === 'CodeBlock') {
        ranges.push({ from: node.from, to: node.to });
        return false;
      }
      return undefined;
    },
  });
  return ranges;
}

function intersectsRange(from, to, ranges) {
  return ranges.some((range) => from < range.to && to > range.from);
}

/**
 * 单行 `$...$` / `$$...$$`，以及独占整行的多行 `$$\n...\n$$`。
 * 多行公式只在「开、闭两行都只有 $$」时成立；内容区可以跨行，其余源码保持原样。
 * 代码区间里的 `$` 与转义 `\$` 不算公式。
 */
export function collectMathSpans(text, excludedRanges = []) {
  const source = String(text ?? '');
  const { lines, eols } = splitLinesWithEol(source);
  const lineStarts = [];
  let start = 0;
  for (let index = 0; index < lines.length; index += 1) {
    lineStarts.push(start);
    start += lines[index].length + (eols[index]?.length ?? 0);
  }

  const spans = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const lineFrom = lineStarts[index];

    // 多行 display 公式：开行/闭行都恰好是 `$$`（允许缩进和行尾空白）。
    if (line.trim() === '$$' && !intersectsRange(lineFrom, lineFrom + line.length, excludedRanges)) {
      let closeIndex = -1;
      for (let probe = index + 1; probe < lines.length; probe += 1) {
        if (lines[probe].trim() === '$$') {
          closeIndex = probe;
          break;
        }
      }
      if (closeIndex !== -1) {
        const closeFrom = lineStarts[closeIndex];
        const to = closeFrom + lines[closeIndex].length;
        const contentFrom = lineFrom + line.length + (eols[index]?.length ?? 0);
        const contentTo = closeFrom;
        const content = source.slice(contentFrom, contentTo).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
        if (content.trim() && !intersectsRange(lineFrom, to, excludedRanges)) {
          spans.push({ from: lineFrom, to, content, display: true, block: true, contentFrom, contentTo });
          index = closeIndex + 1;
          continue;
        }
      }
    }

    let cursor = 0;
    while (cursor < line.length) {
      if (line[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (line[cursor] !== '$') {
        cursor += 1;
        continue;
      }
      if (line[cursor + 1] === '$') {
        const close = line.indexOf('$$', cursor + 2);
        if (close === -1) {
          cursor += 2;
          continue;
        }
        const content = line.slice(cursor + 2, close);
        if (content.trim() && !intersectsRange(lineFrom + cursor, lineFrom + close + 2, excludedRanges)) {
          const display = line.slice(0, cursor).trim() === '' && line.slice(close + 2).trim() === '';
          spans.push({
            from: lineFrom + cursor,
            to: lineFrom + close + 2,
            content,
            display,
            block: false,
            contentFrom: lineFrom + cursor + 2,
            contentTo: lineFrom + close,
          });
        }
        cursor = close + 2;
        continue;
      }
      const next = line[cursor + 1];
      if (next === undefined || /\s/.test(next)) {
        cursor += 1;
        continue;
      }
      let close = cursor + 2;
      let found = false;
      while (close < line.length) {
        if (line[close] === '\\') {
          close += 2;
          continue;
        }
        if (line[close] === '$' && !/\s/.test(line[close - 1])) {
          const content = line.slice(cursor + 1, close);
          if (content.trim() && !intersectsRange(lineFrom + cursor, lineFrom + close + 1, excludedRanges)) {
            spans.push({
              from: lineFrom + cursor,
              to: lineFrom + close + 1,
              content,
              display: false,
              block: false,
              contentFrom: lineFrom + cursor + 1,
              contentTo: lineFrom + close,
            });
            cursor = close + 1;
            found = true;
            break;
          }
        }
        close += 1;
      }
      if (!found) cursor += 1;
    }
    index += 1;
  }
  return spans;
}

/**
 * 表格单元格里的常见行内格式：strong / emphasis / inline-code。
 * 返回纯数据树，DOM 侧只创建元素和文本节点，绝不走 innerHTML；
 * 链接、图片、删除线、HTML 等一律保留源码文本。
 *
 * @param {string} text
 * @returns {Array<{type:'text'|'strong'|'emphasis'|'inline-code', text?:string, children?:Array}>}
 */
export function parseInlineMarkdown(text) {
  const source = String(text ?? '');
  if (!source) return [];
  let parser;
  try {
    parser = markdownLanguage.parser;
    const top = parser.parseInline(source, 0);
    if (!Array.isArray(top) || !top.length) return [{ type: 'text', text: source }];
    const nameOf = (node) => parser.nodeSet.types[node.type]?.name || '';

    const walk = (nodes, from, to) => {
      const out = [];
      let cursor = from;
      for (const node of nodes) {
        if (node.to <= from) continue;
        if (node.from >= to) break;
        const nodeFrom = Math.max(from, node.from);
        const nodeTo = Math.min(to, node.to);
        if (nodeFrom > cursor) out.push({ type: 'text', text: source.slice(cursor, nodeFrom) });
        const name = nameOf(node);
        const children = node.children || [];
        if (name === 'StrongEmphasis' || name === 'Emphasis') {
          const firstMark = children[0] && /Mark$/.test(nameOf(children[0])) ? children[0] : null;
          const lastMark = children[children.length - 1] && /Mark$/.test(nameOf(children[children.length - 1]))
            ? children[children.length - 1]
            : null;
          const innerFrom = firstMark ? firstMark.to : nodeFrom;
          const innerTo = lastMark ? lastMark.from : nodeTo;
          out.push({
            type: name === 'StrongEmphasis' ? 'strong' : 'emphasis',
            children: walk(children, innerFrom, innerTo),
          });
        } else if (name === 'InlineCode') {
          const firstMark = children[0];
          const lastMark = children[children.length - 1];
          const innerFrom = firstMark ? firstMark.to : nodeFrom;
          const innerTo = lastMark ? lastMark.from : nodeTo;
          out.push({ type: 'inline-code', children: [{ type: 'text', text: source.slice(innerFrom, innerTo) }] });
        } else {
          // 未知语法保持源码文本，安全且不丢内容。
          out.push({ type: 'text', text: source.slice(nodeFrom, nodeTo) });
        }
        cursor = Math.max(cursor, nodeTo);
      }
      if (cursor < to) out.push({ type: 'text', text: source.slice(cursor, to) });
      return out;
    };

    return walk(top, 0, source.length);
  } catch {
    return [{ type: 'text', text: source }];
  }
}

function splitTableCells(line, lineFrom = 0) {
  let start = 0;
  let end = line.length;
  while (start < end && /\s/.test(line[start])) start += 1;
  while (end > start && /\s/.test(line[end - 1])) end -= 1;
  if (line[start] === '|') start += 1;
  if (end > start && line[end - 1] === '|') end -= 1;

  const cells = [];
  let cellStart = start;
  for (let index = start; index <= end; index += 1) {
    if (index < end && line[index] === '\\' && line[index + 1] === '|') {
      index += 1;
      continue;
    }
    if (index !== end && line[index] !== '|') continue;
    let from = cellStart;
    let to = index;
    while (from < to && /\s/.test(line[from])) from += 1;
    while (to > from && /\s/.test(line[to - 1])) to -= 1;
    cells.push({
      text: line.slice(from, to).replace(/\\\|/g, '|'),
      from: lineFrom + from,
      to: lineFrom + to,
    });
    cellStart = index + 1;
  }
  return cells;
}

/**
 * 把 GFM 表格源码解析成可安全建 DOM 的纯数据；不是表格就返回 null。
 * 对齐只认 `:---` / `---:` / `:---:`，单元格内容永远当文本/受限行内格式，不当 HTML。
 * `cellRanges` 记录每个单元格内容在文档里的起点，供点击时把光标放回真正点中的格子。
 */
export function parseGfmTable(source, from, to) {
  const raw = String(source ?? '').slice(from, to);
  const { lines, eols } = splitLinesWithEol(raw);
  const entries = [];
  let local = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== '') {
      entries.push({ line, from: from + local });
    }
    local += line.length + (eols[index]?.length ?? 0);
  }
  if (entries.length < 2) return null;
  const rows = entries.map((entry) => splitTableCells(entry.line, entry.from));
  if (!rows[1].length || !rows[1].every((cell) => /^:?-{1,}:?$/.test(cell.text))) return null;
  const aligns = rows[1].map((cell) => {
    const left = cell.text.startsWith(':');
    const right = cell.text.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
  return {
    headers: rows[0].map((cell) => cell.text),
    rows: rows.slice(2).map((row) => row.map((cell) => cell.text)),
    aligns,
    cellRanges: {
      headers: rows[0].map((cell) => ({ from: cell.from, to: cell.to })),
      rows: rows.slice(2).map((row) => row.map((cell) => ({ from: cell.from, to: cell.to }))),
    },
  };
}

/** 图片占位只需要 alt 与 URL；不在这里做网络或 DOM 决定。 */
export function parseImageSyntax(text, from, to) {
  const raw = String(text ?? '').slice(from, to);
  const match = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)$/.exec(raw);
  return match ? { alt: match[1], url: match[2] } : { alt: '', url: '' };
}

/** 一段 Markdown 里所有「会不会被藏起来」的分隔符——测试与审查用。 */
export function formatDelimiters(markdown) {
  const text = String(markdown ?? '');
  return collectInlineSpans(markdownLanguage.parser.parse(text), text)
    .flatMap((span) => span.delimiters.map((delimiter) => ({ ...delimiter, kind: span.kind })));
}
