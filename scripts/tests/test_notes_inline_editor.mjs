/* 无界笔记 · 源码优先的行内即时编辑器（`client/notes/markdown-inline.js`）· 纯函数，Node 里跑
   ────────────────────────────────────────────────────────────────────────────────
   钉四件事：
     · 只有「被光标/选区碰到」的格式区间才显形分隔符；其余分隔符藏起来，正文保持粗体/斜体/链接；
     · 分隔符是真实文档字符（这里只算位置，真正的文档由 CodeMirror 持有），不是替换 widget；
     · 代码、行内代码与转义字面量里的星号不会被当成强调；
     · canonical 字符串保留原始换行：没碰的字节一个不改，CRLF/混合换行都能逐字节往返。

   跑法：`node --test scripts/tests/test_notes_inline_editor.mjs`
   依赖：`@codemirror/lang-markdown` 的 `markdownLanguage.parser`（已登记的构建期依赖）。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { markdownLanguage } from '@codemirror/lang-markdown';

import {
  LIST_BULLET_EM,
  LIST_INDENT_EM,
  MAX_MARKDOWN_LENGTH,
  SPAN_CLASS,
  applyRawSourceChanges,
  applySourceChanges,
  canonicalOffsetMap,
  canonicalizeInsert,
  codeExclusionRanges,
  collectDecorationRanges,
  collectInlineSpans,
  collectMathSpans,
  dominantEol,
  editorChangesForRaw,
  editorOffsetForRaw,
  fenceLanguage,
  formatDelimiters,
  listLineBodyStart,
  listMarkerLayout,
  normalizeLineEndings,
  parseGfmTable,
  parseImageSyntax,
  parseInlineMarkdown,
  rawOffsetForEditor,
  rawOffsetMap,
  safeExternalHref,
  selectionTouchesSpan,
  splitLinesWithEol,
} from '../../client/notes/markdown-inline.js';

const SOURCE = new URL('../../client/notes/', import.meta.url);
const readSource = (name) => readFileSync(new URL(name, SOURCE), 'utf8');
const parse = (text) => markdownLanguage.parser.parse(text);
const spansOf = (text) => collectInlineSpans(parse(text), text);
const marksOf = (text, ranges = []) => collectDecorationRanges(parse(text), ranges, text).marks;
const delimiterMarks = (text, ranges = []) => marksOf(text, ranges).filter((mark) => mark.spanKind);
const byKind = (spans, kind) => spans.filter((span) => span.kind === kind);

/* ── 1. 行内格式：区间与分隔符 ─────────────────────────────────────────────── */

test('strong / emphasis / strike：正文与分隔符位置正确', () => {
  const text = 'a **bold** b *ital* c ~~gone~~ d';
  const spans = spansOf(text);
  const strong = byKind(spans, 'strong');
  const emphasis = byKind(spans, 'emphasis');
  const strike = byKind(spans, 'strike');
  assert.equal(strong.length, 1);
  assert.equal(emphasis.length, 1);
  assert.equal(strike.length, 1);

  assert.equal(strike[0].content.from, text.indexOf('gone'));
  assert.equal(strike[0].content.to, text.indexOf('gone') + 'gone'.length);
  assert.deepEqual(strike[0].delimiters, [
    { from: text.indexOf('~~'), to: text.indexOf('~~') + 2 },
    { from: text.indexOf('gone') + 4, to: text.indexOf('gone') + 6 },
  ]);
  assert.equal(emphasis[0].content.from, text.indexOf('ital'));
  assert.equal(emphasis[0].content.to, text.indexOf('ital') + 4);
  assert.equal(strong[0].content.from, text.indexOf('bold'));
});

test('嵌套格式：外层强调与内层强调各算各的', () => {
  const text = '**bold *ital* bold**';
  const spans = spansOf(text);
  const strong = byKind(spans, 'strong')[0];
  const emphasis = byKind(spans, 'emphasis')[0];
  assert.equal(strong.from, 0);
  assert.equal(strong.to, text.length);
  assert.equal(emphasis.content.from, text.indexOf('ital'));
  // 外层的两个 ** 各 2 字，内层的两个 * 各 1 字，互不吞并。
  assert.deepEqual(strong.delimiters, [{ from: 0, to: 2 }, { from: text.length - 2, to: text.length }]);
  assert.deepEqual(emphasis.delimiters, [
    { from: text.indexOf('*ital*'), to: text.indexOf('*ital*') + 1 },
    { from: text.indexOf('*ital*') + 5, to: text.indexOf('*ital*') + 6 },
  ]);
});

test('行内代码：分隔符是反引号，里面的星号不产生强调', () => {
  const text = 'use `**not strong**` here';
  const spans = spansOf(text);
  assert.equal(byKind(spans, 'strong').length, 0);
  const code = byKind(spans, 'inline-code')[0];
  assert.equal(code.content.from, text.indexOf('**not'));
  assert.equal(code.content.to, text.indexOf('` here'));
  assert.deepEqual(code.delimiters, [
    { from: text.indexOf('`'), to: text.indexOf('`') + 1 },
    { from: text.lastIndexOf('`'), to: text.lastIndexOf('`') + 1 },
  ]);
});

test('代码栅栏 / 表格里的星号与竖线不会被当成行内格式', () => {
  const text = [
    '```js',
    'const bad = "**not bold**";',
    '```',
    '',
    '| a | **b** |',
    '| - | ----- |',
    '| 1 | 2 |',
    '',
    'after **real**',
  ].join('\n');
  const spans = spansOf(text);
  // 表格单元里的 `**b**` 是 GFM 行内格式（表格本身允许行内标记），栅栏里的不是。
  assert.equal(byKind(spans, 'strong').length, 2, '表格单元一个 + 栅栏外一个，栅栏里没有');
  assert.equal(byKind(spans, 'strong').some((span) => span.from > text.indexOf('```') && span.to < text.indexOf('```', 3)), false);
  assert.equal(byKind(spans, 'strong')[1].content.from, text.lastIndexOf('real'));
  assert.equal(byKind(spans, 'fenced-code').length, 1);
  assert.equal(byKind(spans, 'table').length, 1);
});

test('转义字面量 \\* 不产生强调，也不产生可藏的分隔符', () => {
  const text = '\\*not emphasis\\* and **real**';
  const spans = spansOf(text);
  assert.equal(byKind(spans, 'emphasis').length, 0);
  const strong = byKind(spans, 'strong')[0];
  assert.equal(strong.content.from, text.indexOf('real'));
  const delimiters = formatDelimiters(text);
  assert.equal(delimiters.some((range) => range.from === 0), false);
});

test('链接：正文是链接文字，方括号/圆括号/URL 都是分隔符', () => {
  const text = 'see [docs](https://example.com/a) now';
  const link = byKind(spansOf(text), 'link')[0];
  assert.equal(link.content.from, text.indexOf('docs'));
  assert.equal(link.content.to, text.indexOf('docs') + 4);
  assert.equal(link.delimiters.length, 5, '四个 LinkMark + URL');
  assert.equal(link.delimiters[0].from, text.indexOf('['));
  assert.equal(link.delimiters[1].from, text.indexOf(']'));
  assert.equal(link.delimiters[1].to, text.indexOf('('));
});

test('标题 / 列表 / 引用：前缀连同后面的一个空格一起算分隔符', () => {
  const text = '# Head\n\n- item\n\n> quote';
  const heading = byKind(spansOf(text), 'heading')[0];
  const list = byKind(spansOf(text), 'list')[0];
  const quote = byKind(spansOf(text), 'quote')[0];
  assert.deepEqual(heading.delimiters, [{ from: 0, to: 2 }]);
  assert.equal(heading.content.from, 2);
  assert.equal(list.delimiters[0].to, text.indexOf('item'));
  assert.equal(quote.delimiters[0].to, text.indexOf('quote'));
  assert.equal(quote.block, true, '引用要参与块级行装饰，不能只隐藏 > 分隔符');
});

test('HTML / 未知语法保持普通文本，不产生格式区间', () => {
  const text = '<img src=x onerror=alert(1)> <script>alert(2)</script>';
  const spans = spansOf(text);
  assert.equal(spans.length, 0);
});

/* ── 2. 显形规则：只有被碰到的区间才亮分隔符 ───────────────────────────────── */

test('光标在第一段 bold 里：只显形它的两个 **，第二个 strong 仍是藏着的', () => {
  const text = 'plain **bold** plain **other**';
  const firstOpen = text.indexOf('**');
  const firstClose = text.indexOf('**', firstOpen + 2);
  const cursor = text.indexOf('bold') + 2;
  const marks = delimiterMarks(text, [{ from: cursor, to: cursor }]);
  assert.equal(marks.length, 4);
  const active = marks.filter((mark) => mark.active);
  const hidden = marks.filter((mark) => !mark.active);
  assert.equal(active.length, 2);
  assert.equal(hidden.length, 2);
  assert.ok(active.every((mark) => mark.from < secondBold(text)), '第一段的分隔符显形');
  assert.ok(hidden.every((mark) => mark.from >= secondBold(text)), '第二段的分隔符藏起来');
  assert.deepEqual(active.map((mark) => [mark.from, mark.to]), [
    [firstOpen, firstOpen + 2],
    [firstClose, firstClose + 2],
  ]);
  assert.ok(active.every((mark) => mark.classes === 'md-syntax'));
  assert.ok(hidden.every((mark) => mark.classes === 'md-syntax md-syntax-hidden'));
});

function secondBold(text) {
  return text.indexOf('**', text.indexOf('bold') + 6);
}

test('光标停在区间左/右边界时显形，离开边界外侧不显形', () => {
  const text = 'a **bold** b';
  const spanFrom = text.indexOf('**');
  const spanTo = text.indexOf('**', spanFrom + 2) + 2;
  assert.equal(delimiterMarks(text, [{ from: spanFrom - 1, to: spanFrom - 1 }]).filter((mark) => mark.active).length, 0);
  assert.equal(delimiterMarks(text, [{ from: spanFrom, to: spanFrom }]).filter((mark) => mark.active).length, 2);
  assert.equal(delimiterMarks(text, [{ from: spanTo, to: spanTo }]).filter((mark) => mark.active).length, 2);
  assert.equal(delimiterMarks(text, [{ from: spanTo + 1, to: spanTo + 1 }]).filter((mark) => mark.active).length, 0);
  assert.equal(delimiterMarks('**bold**', [{ from: 2, to: 2 }]).filter((mark) => mark.active).length, 2);
});

test('非空选区与区间相交就显形；整段选中时所有分隔符显形', () => {
  const text = 'plain **bold** plain **other**';
  const partial = delimiterMarks(text, [{ from: text.indexOf('**other**') + 2, to: text.indexOf('**other**') + 4 }]);
  assert.equal(partial.filter((mark) => mark.active).length, 2);
  const all = delimiterMarks(text, [{ from: 0, to: text.length }]);
  assert.equal(all.filter((mark) => mark.active).length, 4);
  assert.equal(all.filter((mark) => mark.active).every((mark) => mark.classes === 'md-syntax'), true);
});

test('嵌套：光标只在内层时，外层分隔符显形、内层也显形；只在外层时空隙内层保持藏', () => {
  const text = '**bold *ital* bold**';
  const innerStart = text.indexOf('*ital*');
  const inInner = delimiterMarks(text, [{ from: innerStart + 2, to: innerStart + 2 }]);
  assert.equal(inInner.filter((mark) => mark.active).length, 4, '外层 2 + 内层 2');

  // 光标在外层正文、但离内层还有一段距离：外层显形，内层藏。
  const inOuter = delimiterMarks(text, [{ from: 4, to: 4 }]);
  assert.equal(inOuter.filter((mark) => mark.active).length, 2);
  assert.equal(inOuter.filter((mark) => !mark.active).length, 2);
});

test('正文语义类：strong/emphasis/strike/code/link 各有自己的 md-* 类', () => {
  const text = '**b** *i* ~~s~~ `c` [l](https://a.b) ![alt](x.png)';
  const marks = marksOf(text);
  const classes = new Set(marks.map((mark) => mark.classes));
  for (const value of Object.values(SPAN_CLASS)) {
    if (value === SPAN_CLASS.heading || value === SPAN_CLASS.list || value === SPAN_CLASS.quote) continue;
    assert.ok(classes.has(value), '缺少 ' + value);
  }
});

test('selectionTouchesSpan：空光标含左右边界、非空选区按相交', () => {
  const span = { from: 5, to: 11 };
  assert.equal(selectionTouchesSpan(span, [{ from: 4, to: 4 }]), false);
  assert.equal(selectionTouchesSpan(span, [{ from: 5, to: 5 }]), true, '左边界要显形，DOM 光标才和原始坐标一致');
  assert.equal(selectionTouchesSpan(span, [{ from: 6, to: 6 }]), true);
  assert.equal(selectionTouchesSpan(span, [{ from: 11, to: 11 }]), true, '右边界也要显形，退格删的是真实字符');
  assert.equal(selectionTouchesSpan(span, [{ from: 10, to: 11 }]), true);
  assert.equal(selectionTouchesSpan(span, [{ from: 11, to: 12 }]), false);
  assert.equal(selectionTouchesSpan(span, [{ from: 0, to: 5 }]), false);
});

/* ── 3. canonical 换行：没碰的字节一个不改 ─────────────────────────────────── */

test('splitLinesWithEol / dominantEol：CRLF、LF、CR、混合', () => {
  assert.deepEqual(splitLinesWithEol('a\r\nb\nc\rd'), { lines: ['a', 'b', 'c', 'd'], eols: ['\r\n', '\n', '\r'] });
  assert.equal(dominantEol('a\r\nb\r\nc'), '\r\n');
  assert.equal(dominantEol('a\nb\nc'), '\n');
  assert.equal(dominantEol('a\rb\rc'), '\r');
  assert.equal(dominantEol('a\r\nb\nc\nd'), '\n', 'LF 更多时新换行用 LF');
  assert.equal(dominantEol(''), '\n');
});

test('normalizeLineEndings / canonicalizeInsert / canonicalOffsetMap', () => {
  assert.equal(normalizeLineEndings('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.equal(canonicalizeInsert('a\nb\r\nc\rd', '\r\n'), 'a\r\nb\r\nc\r\nd');
  assert.deepEqual(canonicalOffsetMap('ab\ncd'), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(canonicalOffsetMap('a\r\nb'), [0, 1, 3, 4]);
});

test('原始坐标 ⇄ 编辑器坐标：CRLF 的换行中间位置落到换行起点', () => {
  const source = 'a\r\nb\r\nc';
  assert.deepEqual(rawOffsetMap(source), [0, 1, 1, 2, 3, 3, 4, 5]);
  assert.deepEqual(canonicalOffsetMap(source), [0, 1, 3, 4, 6, 7]);
  assert.equal(editorOffsetForRaw(source, 2), 1, 'CRLF 中间没有独立位置');
  assert.equal(editorOffsetForRaw(source, 7), 5, '原始末尾映射到编辑器末尾');
  assert.equal(rawOffsetForEditor(source, 1), 1);
  assert.equal(rawOffsetForEditor(source, 2), 3, '编辑器第 2 个位置在 b 上，原始偏移是 3');
  assert.equal(rawOffsetForEditor(source, 4), 6);
  assert.equal(editorOffsetForRaw('a\nb\nc', 3), 3);
});

test('applyRawSourceChanges：父组件用原始坐标包 ** 时逐字节保真', () => {
  const source = '前\r\nb\r\n后';
  const from = source.indexOf('b');
  const to = from + 1;
  const next = applyRawSourceChanges(source, [
    { from, to, insert: `**${source.slice(from, to)}**` },
  ]);
  assert.equal(next, '前\r\n**b**\r\n后');
  assert.ok(next.includes('\r\n'));
  assert.equal(next.replace(/\r\n/g, '').includes('\n'), false);
  const cm = editorChangesForRaw(source, [{ from, to, insert: `**b**` }]);
  assert.deepEqual(cm, [{ from: 2, to: 3, insert: '**b**' }], '编辑器坐标里 ** 包住 b 的正文');
  assert.equal(editorOffsetForRaw(next, from + 2), 4, 'selection 用编辑之后的原始坐标投影');
});

test('applyRawSourceChanges：插入的原始换行原样保留，不按 dominant EOL 改写', () => {
  assert.equal(applyRawSourceChanges('a\r\nb', [{ from: 1, to: 1, insert: '\n' }]), 'a\n\r\nb');
  assert.equal(applyRawSourceChanges('a\r\nb', [{ from: 1, to: 3, insert: '\n' }]), 'a\nb');
  assert.equal(applyRawSourceChanges('a\r\nb', [{ from: 1, to: 3, insert: '\r\n' }]), 'a\r\nb');
  assert.deepEqual(editorChangesForRaw('a\r\nb', [{ from: 1, to: 3, insert: '\r\n' }]), [{ from: 1, to: 2, insert: '\n' }]);
});

test('applyRawSourceChanges：越界、重叠、非整数整笔拒绝', () => {
  assert.throws(() => applyRawSourceChanges('abc', [{ from: 4, to: 4, insert: 'x' }]), RangeError);
  assert.throws(() => applyRawSourceChanges('abc', [{ from: 2, to: 1, insert: '' }]), RangeError);
  assert.throws(() => applyRawSourceChanges('abc', [{ from: 0.5, to: 1, insert: '' }]), RangeError);
  assert.throws(() => applyRawSourceChanges('abc', [
    { from: 1, to: 2, insert: '' },
    { from: 1, to: 2, insert: '' },
  ]), RangeError);
});


test('applySourceChanges：无改动返回逐字节相同（含 CRLF/混合）', () => {
  for (const text of ['', 'a', 'a\r\nb\r\n', 'a\r\nb\nc\r', 'no trailing newline']) {
    assert.equal(applySourceChanges(text, []), text);
  }
});

test('applySourceChanges：改一行不动其它行的 CRLF', () => {
  const text = 'one\r\ntwo\r\nthree\r\n';
  assert.equal(applySourceChanges(text, [{ from: 4, to: 7, insert: 'TWO' }]), 'one\r\nTWO\r\nthree\r\n');
  assert.equal(applySourceChanges(text, [{ from: 8, to: 13, insert: '3' }]), 'one\r\ntwo\r\n3\r\n');
});

test('applySourceChanges：删换行 / 插换行（新换行沿用文档风格）', () => {
  assert.equal(applySourceChanges('a\r\nb', [{ from: 1, to: 2, insert: '' }]), 'ab');
  assert.equal(applySourceChanges('a\r\nb', [{ from: 1, to: 1, insert: '\n' }]), 'a\r\n\r\nb');
  assert.equal(applySourceChanges('a\nb', [{ from: 1, to: 1, insert: '\r\n' }]), 'a\n\nb');
});

test('applySourceChanges：混合换行里只改被碰的那一处', () => {
  const text = 'a\r\nb\nc\r';
  assert.equal(applySourceChanges(text, [{ from: 4, to: 5, insert: 'X' }]), 'a\r\nb\nX\r');
  assert.equal(applySourceChanges(text, [{ from: 0, to: 0, insert: 'z' }]), 'za\r\nb\nc\r');
});

test('applySourceChanges：多处改动一次应用，偏移不互相污染', () => {
  const text = 'ab\ncd';
  const next = applySourceChanges(text, [
    { from: 0, to: 0, insert: 'X' },
    { from: 4, to: 4, insert: 'Y' },
  ]);
  assert.equal(next, 'Xab\ncYd');
});

test('applySourceChanges：空文档可以写入，也可以保持为空', () => {
  assert.equal(applySourceChanges('', [{ from: 0, to: 0, insert: 'hello' }]), 'hello');
  assert.equal(applySourceChanges('', []), '');
});

test('applySourceChanges：越界与重叠整笔拒绝，不产生半截文本', () => {
  assert.throws(() => applySourceChanges('abc', [{ from: 0, to: 4, insert: '' }]), RangeError);
  assert.throws(() => applySourceChanges('abc', [{ from: -1, to: 1, insert: '' }]), RangeError);
  assert.throws(() => applySourceChanges('abc', [{ from: 2, to: 2, insert: 'x' }, { from: 1, to: 1, insert: 'y' }]), RangeError);
});

test('上限与安全链接：128 Ki 常量、只放行绝对 http(s)', () => {
  assert.equal(MAX_MARKDOWN_LENGTH, 128 * 1024);
  assert.equal(safeExternalHref('https://example.com/x'), 'https://example.com/x');
  assert.equal(safeExternalHref('http://example.com/'), 'http://example.com/');
  assert.equal(safeExternalHref('javascript:alert(1)'), null);
  assert.equal(safeExternalHref('data:text/html,x'), null);
  assert.equal(safeExternalHref('/relative'), null);
  assert.equal(safeExternalHref(''), null);
});

/* ── 4. 非活动块渲染的数据：公式、GFM 表格、本地图片占位 ───────────────────── */

test('公式扫描：单行 $...$ 与整行 $$...$$；代码/转义/货币不算', () => {
  const inline = collectMathSpans('a $x^2$ b');
  assert.equal(inline.length, 1);
  assert.deepEqual({ from: inline[0].from, to: inline[0].to, content: inline[0].content, display: inline[0].display }, { from: 2, to: 7, content: 'x^2', display: false });

  const display = collectMathSpans('$$a+b$$');
  assert.equal(display.length, 1);
  assert.equal(display[0].display, true);
  assert.equal(display[0].content, 'a+b');

  assert.deepEqual(collectMathSpans('\\$5 and \\$6'), [], '转义美元不是公式');
  assert.deepEqual(collectMathSpans('$5 and $6'), [], '货币的结束符前有空格，不认');
  const block = collectMathSpans('$$\na+b\n$$');
  assert.equal(block.length, 1, '独占整行的多行 $$ 是 display 公式');
  assert.deepEqual(
    { from: block[0].from, to: block[0].to, content: block[0].content, display: block[0].display, block: block[0].block, contentFrom: block[0].contentFrom, contentTo: block[0].contentTo },
    { from: 0, to: 9, content: 'a+b', display: true, block: true, contentFrom: 3, contentTo: 7 },
  );
  assert.deepEqual(collectMathSpans('$$\n\n$$'), [], '空公式不替换');
  const fenced = '```\n$$\na+b\n$$\n```';
  assert.deepEqual(collectMathSpans(fenced, codeExclusionRanges(parse(fenced))), [], '围栏代码里的 $$ 不算公式');
  assert.equal(collectMathSpans('a $x$ and $y$').length, 2);

  const code = '`$x$` and $y$';
  const math = collectMathSpans(code, codeExclusionRanges(parse(code)));
  assert.equal(math.length, 1);
  assert.equal(math[0].content, 'y', '行内代码里的 $ 不算公式');
});

test('GFM 任务标记：真实 [x]/[ ] 区间，休息态可换成勾选框', () => {
  const text = '- [x] done\n- [ ] todo';
  const tasks = byKind(spansOf(text), 'task');
  assert.equal(tasks.length, 2);
  assert.equal(text.slice(tasks[0].from, tasks[0].to), '[x]');
  assert.equal(text.slice(tasks[1].from, tasks[1].to), '[ ]');
  assert.equal(tasks[0].block, false);
  assert.equal(tasks[0].content, null);
});

test('表格单元格行内格式：bold/italic/code 变成安全数据树，未知语法保持原文', () => {
  const nodes = parseInlineMarkdown('**b** *i* `c` [link](https://example.com)');
  const types = nodes.map((node) => node.type);
  assert.ok(types.includes('strong'));
  assert.ok(types.includes('emphasis'));
  assert.ok(types.includes('inline-code'));
  const strong = nodes.find((node) => node.type === 'strong');
  assert.equal(strong.children.map((child) => child.text).join(''), 'b');
  const emphasis = nodes.find((node) => node.type === 'emphasis');
  assert.equal(emphasis.children.map((child) => child.text).join(''), 'i');
  const code = nodes.find((node) => node.type === 'inline-code');
  assert.equal(code.children.map((child) => child.text).join(''), 'c');
  const raw = nodes.filter((node) => node.type === 'text').map((node) => node.text).join('');
  assert.ok(raw.includes('[link](https://example.com)'), '未知链接保持源码，不执行');
  assert.deepEqual(parseInlineMarkdown(''), []);
  assert.equal(parseInlineMarkdown('**x** *y*').length, 3);
});

test('GFM 表格解析：表头、行、对齐、转义竖线；不是表格返回 null', () => {
  const text = '| Name | Score |\n| :--- | ---: |\n| A | 92 |\n| B \\| C | 7 |';
  const table = parseGfmTable(text, 0, text.length);
  assert.deepEqual(table.headers, ['Name', 'Score']);
  assert.deepEqual(table.rows, [['A', '92'], ['B | C', '7']]);
  assert.deepEqual(table.aligns, ['left', 'right']);
  assert.equal(text.slice(table.cellRanges.headers[0].from, table.cellRanges.headers[0].to), 'Name');
  assert.equal(text.slice(table.cellRanges.rows[0][1].from, table.cellRanges.rows[0][1].to), '92');
  assert.equal(text.slice(table.cellRanges.rows[1][0].from, table.cellRanges.rows[1][0].to), 'B \\| C');
  assert.equal(parseGfmTable('| a | b |\n| c | d |', 0, 21), null);
});

test('图片语法：占位只取 alt/URL，URL 原样保留', () => {
  const text = 'before ![示意图](https://example.com/a.png) after';
  const span = byKind(spansOf(text), 'image')[0];
  const info = parseImageSyntax(text, span.from, span.to);
  assert.deepEqual(info, { alt: '示意图', url: 'https://example.com/a.png' });
  assert.ok(span.delimiters.length >= 5, '![、]、(: 与 URL 都是可显形的灰色分隔符');
  assert.equal(text.slice(span.content.from, span.content.to), '示意图');
});

/* ── 5. 接线：组件实际用这些助手，且不把 Markdown 交给 innerHTML ───────────── */

test('MarkdownInlineEditor 接线：用 markdownLanguage.parser、有 md-syntax/语义类、无 innerHTML', () => {
  const component = readSource('MarkdownInlineEditor.jsx');
  const parser = readSource('markdown-inline.js');
  assert.match(parser, /markdownLanguage\.parser/);
  assert.match(component, /collectDecorationRanges/);
  assert.match(component, /markdown\(\{ base: markdownLanguage, codeLanguages \}\)/, 'GFM 表格/删除线需要 markdownLanguage base');
  assert.doesNotMatch(component, /dangerouslySetInnerHTML/, '不允许把 Markdown 塞进 innerHTML');
  assert.match(component, /onApi/);
  assert.match(component, /readSnapshot/);
  assert.match(component, /rawProjectionFor\(canonical\)/, 'read().from 必须是原始坐标');
  assert.match(component, /applyRawSourceChanges/, 'api.edit 必须按原始坐标改字符串');
  assert.match(component, /editorChangesForRaw/, '原始坐标改动再投影回编辑器');
  assert.match(component, /rawProjectionFor\(next\)/, 'selection 按编辑之后的原始坐标投影');
  assert.match(component, /new TableWidget/, '表格用安全 DOM 表格 widget');
  assert.match(component, /new MathWidget/, '公式用 KaTeX widget');
  assert.match(component, /new ImageWidget/, '图片用本地占位 widget');
  assert.match(component, /new TaskWidget/, 'GFM 任务用只读勾选框 widget');
  assert.match(component, /appendInlineMarkdown/, '表格单元格走安全 DOM 行内渲染');
  assert.match(component, /parseInlineMarkdown/, '表格单元格复用受限行内解析');
  assert.match(component, /md-task-widget/);
  assert.match(component, /span\.block/, '多行公式走整块 replace');
  assert.match(component, /contentFrom/, '点公式回到内容开头而不是 $$ 标记');
  assert.match(component, /katex\.render/);
  assert.match(component, /trust: false/);
  assert.match(component, /maxExpand: 500/);
  assert.match(component, /maxSize: 15/);
  assert.doesNotMatch(component, /<img/i, '占位不创建 img，避免任何远端请求');
  assert.doesNotMatch(component, /\.src\s*=/, '占位不设置 src');
  assert.match(component, /classHighlighter/, '代码高亮用类名，颜色归主题 CSS');
  assert.match(component, /syntaxHighlighting\(classHighlighter\)/);
  assert.doesNotMatch(component, /defaultHighlightStyle/, '固定生成色在深色下过不了 AA');

  const css = readSource('inline-editor.css');
  assert.match(css, /\.markdown-inline-editor/);
  assert.match(css, /\.md-syntax/);
  assert.match(css, /\.markdown-inline-editor \.tok-keyword/);
  assert.match(css, /\.markdown-inline-editor \.md-task-widget/);
  assert.match(css, /\.markdown-inline-editor \.md-table code/);
  assert.match(css, /--md-tok-keyword: #8a2f6b/);
  assert.match(css, /--md-tok-keyword: #ef9ac2/);
  assert.doesNotMatch(css, /(^|\n)\s*(body|html|\*)\s*\{/, '模块样式不写全局选择器');
});

test('代码高亮调色板：亮暗关键词对各自底色 >= 4.5:1', () => {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
    const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const contrast = (a, b) => {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  for (const color of ['#8a2f6b', '#2f6f43', '#1f5d8a', '#8a4a12', '#6b5a12', '#5d6b65']) {
    assert.ok(contrast(color, '#ffffff') >= 4.5, `${color} 对白底不足 AA`);
  }
  for (const color of ['#ef9ac2', '#95d5a4', '#91c8ff', '#f3b17e', '#e4ca82', '#9eaaa3']) {
    assert.ok(contrast(color, '#1e2423') >= 4.5, `${color} 对暗底不足 AA`);
  }
});

test('测试样例与线上样例一致：plain **bold** plain **other**', () => {
  const text = 'plain **bold** plain **other**';
  const spans = spansOf(text);
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map((span) => span.content), [
    { from: 8, to: 12 },
    { from: 23, to: 28 },
  ]);
});

/* ── #312 A2/A3/A5：标题层级、围栏语言角标与面背景的纯函数/静态契约 ────────── */

test('A2 标题层级：span 携带 level，正文类追加 md-heading-N', () => {
  const text = '# 一\n\n## 二\n\n###### 六\n\n正文';
  const headings = byKind(spansOf(text), 'heading');
  assert.deepEqual(headings.map((span) => span.level), [1, 2, 6]);
  const classes = marksOf(text).map((mark) => mark.classes);
  assert.ok(classes.includes('md-heading md-heading-1'), JSON.stringify(classes));
  assert.ok(classes.includes('md-heading md-heading-2'), JSON.stringify(classes));
  assert.ok(classes.includes('md-heading md-heading-6'), JSON.stringify(classes));
  assert.ok(!classes.some((value) => value.includes('md-heading-0')), JSON.stringify(classes));
});

test('A3 围栏语言：fenceLanguage 取信息串首 token，无信息串为空', () => {
  assert.equal(fenceLanguage('```js'), 'js');
  assert.equal(fenceLanguage('```python title=x'), 'python');
  assert.equal(fenceLanguage('~~~ts'), 'ts');
  assert.equal(fenceLanguage('```'), '');
  assert.equal(fenceLanguage('``````'), '');
  assert.equal(fenceLanguage('  ```C#'), 'C#');
  assert.equal(fenceLanguage('正文 ``` 不是围栏'), '');
});

test('A3 编辑态接线：CodeLangWidget 用 fenceLanguage 顶替开围栏行，CSS 有角标样式', () => {
  const component = readSource('MarkdownInlineEditor.jsx');
  assert.match(component, /new CodeLangWidget/);
  assert.match(component, /fenceLanguage\(/, '语言名必须来自与测试共用的一份判据');
  assert.match(component, /setAttribute\('role', 'button'\)/, 'chip 行为上是按钮，必须有 button 语义');
  assert.match(component, /chip\.tabIndex = -1;/, '不进编辑器 Tab 序（Tab 留给 indentWithTab 缩进）');
  assert.match(component, /event\.detail === 0/, '读屏激活的 detail=0 click 必须生效');
  assert.match(component, /event\.key === 'Enter' \|\| event\.key === ' '/, 'Enter/Space 键盘可操作');
  const css = readSource('inline-editor.css');
  assert.match(css, /\.markdown-inline-editor \.md-code-lang/);
});

test('A1/A5 CSS 静态契约：下拉 color-scheme、编辑面比宿主面深一档', () => {
  const toolbar = readSource('markdown-toolbar.css');
  assert.match(toolbar, /color-scheme: light/);
  assert.match(toolbar, /\[data-theme="dark"\] \.md-format-toolbar__select \{[\s\S]*?color-scheme: dark/, '暗色必须切到 dark 弹层');
  assert.match(toolbar, /\.md-format-toolbar__select \{[\s\S]*?background: var\(--mt-surface\);/, '收起态必须有明确实底色');
  assert.match(toolbar, /\.md-format-toolbar__select option \{[\s\S]*?background: var\(--mt-surface\);[\s\S]*?color: var\(--mt-text\);/, 'option 弹层必须实底且钉文字色');

  const noteEditor = readSource('note-editor.css');
  assert.match(noteEditor, /--ne-surface: color-mix\(in srgb, var\(--smb-bg/);
  assert.match(noteEditor, /\.note-editor\[data-theme="dark"\] \{[\s\S]*?--ne-surface: #([\da-f]{2})\1\1;/i, '暗色笔记正文底色必须为中性灰');
  // A5：编辑与只读渲染两态都盖加深面——background 直接落在 .note-editor 上，无 :not(.is-readonly) 豁免。
  assert.match(noteEditor, /background: var\(--ne-surface\);/);
  assert.doesNotMatch(noteEditor, /\.note-editor:not\(\.is-readonly\)/, '只读渲染面不再豁免');
  // 正文编辑器本体保持透明：面由 .note-editor 承担。
  assert.match(noteEditor, /\.note-editor \.markdown-inline-editor[\s\S]*?background: transparent;/);

  const inline = readSource('inline-editor.css');
  assert.match(inline, /--md-editor-surface: var\(--ne-surface, var\(--surface, #fff\)\);/);
  // 注：live-editor.css/MarkdownLiveEditor 是死代码，#303（f7135f6）会删除它们；
  // A1/A5 的有效落点只在 note-editor.css 与 inline-editor.css，这里刻意不耦合 live-editor.css。
});

/* ── #312 列表：渲染态符号/编号、嵌套缩进、续行悬挂与源码模式切换 ─────────── */

test('列表版面：无序用 •，有序按列表起始号递增，编号位数决定位宽', () => {
  const text = '3. third\n4. fourth\n\n- bullet\n\n10. tenth\n11. eleventh';
  const lists = byKind(spansOf(text), 'list');
  assert.deepEqual(lists.map((span) => span.ordered), [true, true, false, true, true]);
  // 有序编号从列表自己的起始号开始，不是恒从 1 起；无序项没有编号。
  assert.deepEqual(lists.map((span) => span.number), [3, 4, null, 10, 11]);
  const layouts = lists.map(listMarkerLayout);
  assert.deepEqual(layouts.map((layout) => layout.label), ['3.', '4.', '•', '10.', '11.']);
  assert.equal(layouts[0].indentEm, 0, '顶层列表不再额外缩进');
  assert.equal(layouts[0].padEm, layouts[0].markEm, '顶层正文起点就是编号位宽');
  assert.equal(layouts[2].markEm, LIST_BULLET_EM, '无序项的符号位宽固定');
  assert.ok(layouts[3].markEm > layouts[0].markEm, '两位数编号比一位数占更宽，不压正文');
  assert.equal(layouts[3].label, '10.');

  // `2)` 也是合法有序标记：渲染沿用文档里的收尾符，不擅自改成 `.`。
  const paren = byKind(spansOf('2) two\n3) three'), 'list');
  assert.deepEqual(paren.map((span) => listMarkerLayout(span).label), ['2)', '3)']);
});

test('列表版面：嵌套按层级累加缩进，深度进 span', () => {
  const text = '- a\n  - b\n    - c';
  const lists = byKind(spansOf(text), 'list');
  assert.deepEqual(lists.map((span) => span.depth), [1, 2, 3]);
  const layouts = lists.map(listMarkerLayout);
  assert.deepEqual(layouts.map((layout) => layout.indentEm), [0, LIST_INDENT_EM, LIST_INDENT_EM * 2]);
  assert.ok(layouts[0].padEm < layouts[1].padEm && layouts[1].padEm < layouts[2].padEm);
});

test('列表标记起点：跳过引用前缀与行首缩进，标记后 1–4 个空格整体并入', () => {
  const quoted = '> - item';
  const quotedList = byKind(spansOf(quoted), 'list')[0];
  assert.equal(quotedList.indentFrom, quoted.indexOf('-'), '引用条由引用装饰负责，标记从 - 开始');
  assert.equal(quotedList.delimiters[0].to, quoted.indexOf('item'));
  assert.ok(!quoted.slice(quotedList.indentFrom, quotedList.delimiters[0].to).includes('>'));

  const prefixed = '  >   - item';
  const prefixedList = byKind(spansOf(prefixed), 'list')[0];
  assert.ok(!prefixed.slice(prefixedList.indentFrom, prefixedList.delimiters[0].to).includes('>'),
    '多层引用前缀都不能被列表 widget 吞掉');
  assert.equal(prefixedList.delimiters[0].to, prefixed.indexOf('item'));

  const wide = '-   item';
  const wideList = byKind(spansOf(wide), 'list')[0];
  assert.equal(wideList.delimiters[0].to, wide.indexOf('item'), '标记后多个空格也必须算进分隔符');
  assert.equal(wideList.indentFrom, 0);
});

test('任务项不重复出现标记：task 标记在 span 上，嵌套任务不算到外层项', () => {
  const text = '- [ ] todo\n  - [x] inner\n- plain';
  const lists = byKind(spansOf(text), 'list');
  assert.deepEqual(lists.map((span) => span.task), [true, true, false]);
  assert.equal(lists[2].ordered, false);
  assert.equal(lists[2].number, null);
});

test('列表续行正文起点：惰性续行是 0，缩进续行跳过空白，引用里的续行跳过前缀', () => {
  assert.equal(listLineBodyStart('lazy line'), 0, '惰性续行没有缩进，正文从行首开始');
  assert.equal(listLineBodyStart('  second para'), 2);
  assert.equal(listLineBodyStart('\tsecond'), 1);
  assert.equal(listLineBodyStart('>   cont'), 4, '引用+列表的续行，行首是 > 不是空格');
  assert.equal(listLineBodyStart('> >  deep'), 5, '多层引用前缀整体跳过');
  assert.equal(listLineBodyStart('   '), 3, '纯空白行跳过整行空白（调用方会按空行丢掉）');
  assert.equal(listLineBodyStart(''), 0);
});

test('列表渲染接线：休息态 widget 占位、续行占位与悬挂缩进同源，触及项还原源码', () => {
  const component = readSource('MarkdownInlineEditor.jsx');
  assert.match(component, /new ListMarkWidget\(layout, /);
  assert.match(component, /new ListSpacerWidget\(padCss, /);
  // 触及项不换标记；续行只在「未被触及的列表项」下占位，且按语法树 ListItem 范围取行。
  assert.match(component, /span\.kind !== 'list' \|\| selectionTouchesSpan\(span, ranges\)/);
  assert.match(component, /const rendered = !selectionTouchesSpan\(span, ranges\);/);
  assert.match(component, /listLineBodyStart\(line\.text\)/);
  // 首行与续行读同一个 CSS 变量：宽度同源，不依赖字体量出来的宽度。
  assert.match(component, /--md-list-pad:\$\{padCss\};text-indent:calc\(-1 \* \$\{padCss\}\);/);
  assert.match(component, /const TASK_LIST_PAD = 'var\(--md-task-slot\)';/);
  assert.match(component, /return span\.task \? TASK_LIST_PAD : `\$\{listMarkerLayout\(span\)\.padEm\}em`;/);
  // 空行、代码/表格/块公式行都不加占位；惰性续行没有可换的字符，只挂行内边距。
  assert.match(component, /if \(!line\.text\.trim\(\)\) continue;/);
  assert.match(component, /if \(bodyStart === 0\) \{/);
  assert.match(component, /if \(!entry\.style\) entry\.style = listLazyLineStyle\(padCss\);/);
  assert.match(component, /if \(overlapsReplaced\(from, to\) \|\| replacedAt\(from\)\) continue;/);
  // 任务标记连同其后那一个空格一起换：一个槽位一个 widget，续行才能同列。
  assert.match(component, /const end = text\[span\.to\] === ' ' \? span\.to \+ 1 : span\.to;/);

  const css = readSource('inline-editor.css');
  assert.match(css, /\.markdown-inline-editor \.md-list-marker \{/);
  assert.match(css, /\.markdown-inline-editor \.md-list-mark--ordered \{/);
  assert.match(css, /\.markdown-inline-editor \.md-list-spacer \{/);
  assert.match(css, /\.markdown-inline-editor \.md-line-list \{\n  padding-left: var\(--md-list-pad, 0px\);/);
  assert.match(css, /\.markdown-inline-editor \.md-line-list\.md-line-quote \{\n  padding-left: calc\(10px \+ var\(--md-list-pad, 0px\)\);/,
    '引用里的列表叠加两段缩进，不覆盖引用自己的 10px');
  assert.match(css, /--md-task-slot: calc\(1\.15em \+ 5px\);/);
  assert.match(css, /\.markdown-inline-editor \.md-task-widget \{[^}]*width: var\(--md-task-slot, 1\.15em\);/s);
});

test('源码模式：Compartment 只重配装饰与行号，同 view 不重建、不写正文', () => {
  const component = readSource('MarkdownInlineEditor.jsx');
  assert.match(component, /sourceMode = false/, '源码模式是独立 prop，默认关闭');
  assert.match(component, /const decorationsSlot = useRef\(new Compartment\(\)\)/);
  assert.match(component, /const gutterSlot = useRef\(new Compartment\(\)\)/);
  assert.match(component, /decorationsSlot\.current\.reconfigure\(decorationsFor\(sourceMode\)\)/);
  assert.match(component, /gutterSlot\.current\.reconfigure\(gutterFor\(sourceMode, theme === 'dark'\)\)/);
  assert.match(component, /editorGutter\(\), gutterTheme\(dark\)/, '源码模式挂上带行号的阅读型 gutter');
  assert.match(component, /data-source-mode=\{sourceMode \? 'true' : 'false'\}/);
  assert.equal((component.match(/new EditorView\(/g) || []).length, 1, '切模式绝不重建 EditorView');
  const switchEffect = component.slice(
    component.indexOf('// 只重配这两组扩展'),
    component.indexOf('}, [sourceMode, theme]);'),
  );
  assert.ok(switchEffect.length > 0, '必须存在只随 sourceMode/theme 变化的重配 effect');
  assert.doesNotMatch(switchEffect, /onChange|setError/, '切模式不能写正文、不能借机报错');
  const css = readSource('inline-editor.css');
  assert.match(css, /\[data-source-mode="true"\] \.cm-gutters \{/);
  assert.match(css, /\[data-source-mode="true"\] \.cm-lineNumbers \.cm-gutterElement \{/);
});
