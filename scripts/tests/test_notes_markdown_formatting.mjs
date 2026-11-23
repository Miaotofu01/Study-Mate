/* 无界笔记 · Markdown 原始文本格式化（`client/notes/markdown-formatting.js`）· 纯函数，Node 里跑
   ────────────────────────────────────────────────────────────────────────────────
   这一套钉的是「最小改动」契约：changes 指原文坐标、排序且互不重叠；空白、CRLF/LF/CR
   混排、转义与代码字面量不被顺手规范化；没把握时返回 null 而不是硬改。

   跑法：`node --test scripts/tests/test_notes_markdown_formatting.mjs`
*/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeFormatState,
  formatMarkdown,
  normalizeHttpHref,
} from '../../client/notes/markdown-formatting.js';

function applyChanges(text, changes) {
  return [...changes]
    .sort((a, b) => b.from - a.from || b.to - a.to)
    .reduce((value, change) => value.slice(0, change.from) + change.insert + value.slice(change.to), text);
}

function format(text, from, to, command, value) {
  return formatMarkdown({ text, from, to }, command, value);
}

/** 统一的契约检查：changes 合法、应用后等于预期、selection 落在新文档内。 */
function assertFormat(text, from, to, command, value, expected, selection) {
  const result = format(text, from, to, command, value);
  assert.ok(result, `${command} 应返回结果`);
  let previousTo = 0;
  for (const change of result.changes) {
    assert.ok(Number.isInteger(change.from) && Number.isInteger(change.to), '坐标必须是整数');
    assert.ok(change.from >= previousTo, 'changes 必须排序且不重叠');
    assert.ok(change.to >= change.from && change.to <= text.length, '坐标必须落在原文内');
    assert.equal(typeof change.insert, 'string');
    previousTo = change.to;
  }
  assert.equal(applyChanges(text, result.changes), expected);
  const delta = result.changes.reduce((sum, change) => sum + change.insert.length - (change.to - change.from), 0);
  const max = text.length + delta;
  assert.ok(result.selection.anchor >= 0 && result.selection.anchor <= max, 'anchor 必须在结果内');
  assert.ok(result.selection.head >= 0 && result.selection.head <= max, 'head 必须在结果内');
  if (selection) assert.deepEqual(result.selection, selection);
  return result;
}

test('标题：切换层级只改井号，保留引用/列表前缀与原换行', () => {
  assertFormat('> - ## 标题', 0, 5, 'heading', 3, '> - ### 标题', { anchor: 0, head: 7 });
  assertFormat('# a\r\n## b\nplain', 0, 15, 'heading', 2, '## a\r\n## b\n## plain');
});

test('标题：0 回到正文会同时去掉收尾井号，无标题时返回 null', () => {
  assertFormat('## 标题 ##', 0, 2, 'heading', 0, '标题');
  assertFormat('## 标题', 0, 0, 'heading', 0, '标题', { anchor: 0, head: 0 });
  assert.equal(format('## 标题', 0, 0, 'heading', 2), null, '同层级切换应为 null');
});

test('标题：空行与文末可以插入标记；围栏代码内返回 null', () => {
  assertFormat('', 0, 0, 'heading', 2, '## ', { anchor: 3, head: 3 });
  assertFormat('a\n', 2, 2, 'heading', 1, 'a\n# ', { anchor: 4, head: 4 });
  assert.equal(format('```\n## x\n```', 5, 5, 'heading', 2), null);
});

test('粗体：选区包裹、选区整体/内部解包、折叠光标解包', () => {
  assertFormat('hello', 0, 5, 'bold', undefined, '**hello**', { anchor: 2, head: 7 });
  assertFormat('**hello**', 2, 7, 'bold', undefined, 'hello', { anchor: 0, head: 5 });
  assertFormat('**hello**', 0, 9, 'bold', undefined, 'hello', { anchor: 0, head: 5 });
  assertFormat('**hello**', 4, 4, 'bold', undefined, 'hello', { anchor: 2, head: 2 });
});

test('粗体：空选区只插入一对标记，不猜单词，不插入正文', () => {
  assertFormat('ab', 1, 1, 'bold', undefined, 'a****b', { anchor: 3, head: 3 });
  assertFormat('x', 1, 1, 'bold', undefined, 'x****', { anchor: 3, head: 3 });
});

test('斜体/删除线：嵌套里只移除目标标记', () => {
  assertFormat('**bold *it* bold**', 8, 8, 'italic', undefined, '**bold it bold**', { anchor: 7, head: 7 });
  assertFormat('~~gone~~', 2, 6, 'strike', undefined, 'gone', { anchor: 0, head: 4 });
  assertFormat('~~gone~~', 0, 8, 'strike', undefined, 'gone', { anchor: 0, head: 4 });
});

test('强调：转义星号与行内代码/fence 里的星号不当作实际标记', () => {
  const escaped = format('\\*hi\\*', 2, 2, 'italic');
  assert.ok(escaped);
  assert.equal(applyChanges('\\*hi\\*', escaped.changes), '\\***hi\\*');
  assert.equal(format('`a *b* c`', 4, 4, 'italic'), null);
  assert.equal(format('```\n**x**\n```', 6, 6, 'bold'), null);
});

test('强调：选区落在标记内部时安全解包，不拆坏半边标记', () => {
  assertFormat('**hello**', 1, 3, 'bold', undefined, 'hello');
});

test('行内代码：反引号内容自动加长围栏，带标记选区可解包', () => {
  assertFormat('a`b', 0, 3, 'inline-code', undefined, '``a`b``', { anchor: 2, head: 5 });
  assertFormat('`a b`', 1, 4, 'inline-code', undefined, 'a b', { anchor: 0, head: 3 });
  assertFormat('`a b`', 2, 2, 'inline-code', undefined, 'a b', { anchor: 1, head: 1 });
});

test('链接：选区内插入、空选区插入，原文标签保持不变', () => {
  assertFormat('docs', 0, 4, 'link', { href: 'https://example.com/a' }, '[docs](https://example.com/a)', { anchor: 1, head: 5 });
  assertFormat('', 0, 0, 'link', { href: 'https://example.com/a' }, '[](https://example.com/a)', { anchor: 1, head: 1 });
});

test('链接：只接受明确的 http(s) 地址', () => {
  assert.equal(normalizeHttpHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeHttpHref('http://example.com'), 'http://example.com/');
  for (const href of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'ftp://example.com', '', ' https://a b']) {
    assert.equal(normalizeHttpHref(href), null, href);
    assert.equal(format('docs', 0, 4, 'link', { href }), null, href);
  }
});

test('链接：编辑既有链接保留文字与标题，折叠光标也在既有链接内生效', () => {
  assertFormat(
    '[x](https://o.com "标题")',
    1,
    2,
    'link',
    { href: 'https://n.com/a' },
    '[x](https://n.com/a "标题")',
    { anchor: 1, head: 2 },
  );
  assertFormat(
    '[x](https://o.com)',
    1,
    2,
    'link',
    { href: 'https://n.com/a', text: 'y' },
    '[y](https://n.com/a)',
    { anchor: 1, head: 2 },
  );
  assertFormat('[x](https://o.com)', 2, 2, 'link', { href: 'https://n.com/a' }, '[x](https://n.com/a)', { anchor: 2, head: 2 });
  assert.equal(format('[x](https://o.com)', 1, 2, 'link', { href: 'https://o.com' }), null, '等价链接不应重写');
});

test('链接：括号地址使用尖括号，破坏链接的文字返回 null', () => {
  assertFormat('a', 0, 1, 'link', { href: 'https://example.com/a(b)' }, '[a](<https://example.com/a(b)>)');
  assert.equal(format('a', 0, 1, 'link', { href: 'https://example.com/a', text: 'a]b' }), null);
});

test('列表：多行加前缀、保留缩进/引用与 CRLF，编号按行递增', () => {
  assertFormat('a\r\nb\nc\rd', 0, 8, 'bullet-list', undefined, '- a\r\n- b\n- c\r- d');
  assertFormat('  a\n> b', 0, 7, 'bullet-list', undefined, '  - a\n> - b');
  assertFormat('a\nb', 0, 3, 'ordered-list', undefined, '1. a\n2. b');
});

test('列表：目标类型已成立时可整体移除；代码围栏内返回 null', () => {
  assertFormat('- a\r\n- b', 0, 8, 'bullet-list', undefined, 'a\r\nb', { anchor: 0, head: 4 });
  assertFormat('1. a\n2. b', 0, 9, 'ordered-list', undefined, 'a\nb');
  assert.equal(format('```\na\n```', 4, 5, 'bullet-list'), null);
  assert.equal(format('```\na\n```', 4, 5, 'ordered-list'), null);
});

test('引用：多行增删、空行保留引用、列表前缀留在引用内', () => {
  assertFormat('- a\nb', 0, 5, 'quote', undefined, '> - a\n> b');
  assertFormat('a\n\nb', 0, 4, 'quote', undefined, '> a\n>\n> b');
  assertFormat('> - a\n> b', 0, 9, 'quote', undefined, '- a\nb', { anchor: 0, head: 5 });
  assert.equal(format('```\na\n```', 4, 5, 'quote'), null);
});

test('代码块：按整行包裹并沿用局部换行；内容含反引号时加长围栏', () => {
  assertFormat(
    'a\r\nb\r\nc',
    3,
    4,
    'code-block',
    undefined,
    'a\r\n```\r\nb\r\n```\r\nc',
    { anchor: 8, head: 9 },
  );
  assertFormat(
    'a\nx ``` y\nb',
    2,
    10,
    'code-block',
    undefined,
    'a\n````\nx ``` y\n````\nb',
  );
});

test('代码块：空文档插入空围栏；已有围栏可解包', () => {
  assertFormat('', 0, 0, 'code-block', undefined, '```\n\n```', { anchor: 4, head: 4 });
  assertFormat('a\n\nb', 2, 2, 'code-block', undefined, 'a\n```\n\n```\nb', { anchor: 6, head: 6 });
  assertFormat('```\nx\n```', 5, 5, 'code-block', undefined, 'x\n');
  assertFormat('abc', 1, 2, 'code-block', undefined, '```\nabc\n```');
});

test('代码块：选区一半在围栏内时返回 null，不猜边界', () => {
  assert.equal(format('```\nx\n```\na', 7, 11, 'code-block'), null);
});

test('表格：在行首插入骨架，光标落在第一个表头格', () => {
  assertFormat('', 0, 0, 'table', undefined, '|  |  |\n| --- | --- |\n|  |  |', { anchor: 2, head: 2 });
  assertFormat('abc', 1, 1, 'table', undefined, '|  |  |\n| --- | --- |\n|  |  |\nabc', { anchor: 2, head: 2 });
});

test('换行与未触碰字节：只改目标区间，CRLF/LF/CR 原样保留', () => {
  assertFormat('# One\r\nbody\nline\rtail', 7, 11, 'bold', undefined, '# One\r\n**body**\nline\rtail');
  assertFormat('## A\r\n## B', 0, 7, 'heading', 3, '### A\r\n### B');
});

test('边界：文末折叠光标、空文档与非法坐标', () => {
  assertFormat('x', 1, 1, 'link', { href: 'https://example.com/a' }, 'x[](https://example.com/a)', { anchor: 2, head: 2 });
  assert.equal(format('abc', 0, 5, 'bold'), null);
  assert.equal(format('abc', -1, 0, 'bold'), null);
  assert.equal(format('abc', 1, 0, 'bold'), null);
  assert.equal(format('abc', 0.5, 1, 'bold'), null);
  assert.equal(format('abc', 0, 1, 'nope'), null);
});

test('activeFormatState：标题、列表、引用、强调、行内代码与链接', () => {
  const heading = activeFormatState('> - ## x', 5, 5);
  assert.equal(heading.heading, 2);
  assert.equal(heading.quote, true);
  assert.equal(heading.bulletList, true);

  assert.equal(activeFormatState('**bold**', 3, 3).bold, true);
  assert.equal(activeFormatState('*it*', 2, 2).italic, true);
  assert.equal(activeFormatState('~~x~~', 3, 3).strike, true);
  assert.equal(activeFormatState('`x`', 2, 2).inlineCode, true);

  const link = activeFormatState('[x](https://example.com/a)', 2, 2);
  assert.equal(link.link, true);
  assert.equal(link.linkHref, 'https://example.com/a');
  assert.equal(link.linkText, 'x');

  assert.equal(activeFormatState('1. x', 3, 3).orderedList, true);
  assert.equal(activeFormatState('```\n# x\n```', 5, 5).heading, 0);
});

/* ── #312 A4：光标在粗体内部再点粗体必须解包而不是嵌套 ───────────────────── */

test('A4 粗体 toggle：折叠光标在粗体正文内再点粗体，解包且不产生嵌套', () => {
  const text = 'plain **加粗段** tail';
  const inner = text.indexOf('加粗段') + 1;
  const result = assertFormat(text, inner, inner, 'bold', undefined, 'plain 加粗段 tail');
  const applied = applyChanges(text, result.changes);
  assert.ok(!applied.includes('****'), `解包后不允许残留嵌套星号：${JSON.stringify(applied)}`);
  assert.ok(!applied.includes('**'), `解包后不应还有成对星号：${JSON.stringify(applied)}`);
});

test('A4 粗体 toggle：光标停在星号分隔符内部也在粗体 span 里，解包', () => {
  assertFormat('**加粗**', 2, 2, 'bold', undefined, '加粗');
  assertFormat('**加粗**', 5, 5, 'bold', undefined, '加粗');
});

test('A4 粗体 toggle：光标在内层斜体里点粗体，只解包外层粗体', () => {
  const text = '**外部 *内部* 尾**';
  const inner = text.indexOf('内部') + 1;
  assertFormat(text, inner, inner, 'bold', undefined, '外部 *内部* 尾');
});

test('A4 粗体 toggle：引用里的粗体正文同样解包', () => {
  assertFormat('> **引号粗体**', 5, 5, 'bold', undefined, '> 引号粗体');
});

test('A4 边界契约：光标在粗体边界之外时 active=false，点击插入紧邻新对（不是解包）', () => {
  assert.equal(activeFormatState('**b**', 0, 0).bold, false);
  assert.equal(activeFormatState('**b**', 5, 5).bold, false);
  const before = format('**b**', 0, 0, 'bold');
  assert.ok(before, '边界外点击仍应返回结果');
  assert.equal(applyChanges('**b**', before.changes), '******b**');
  const after = format('**b**', 5, 5, 'bold');
  assert.ok(after);
  assert.equal(applyChanges('**b**', after.changes), '**b******');
});
