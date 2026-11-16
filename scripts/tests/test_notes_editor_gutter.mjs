/* 无界笔记 · 编辑器的行号栏（`client/notes/editor-gutter.js`）· 纯函数，Node 里跑，不碰 DOM
   ────────────────────────────────────────────────────────────────────────────────
   这一套是原型 `prototypes/unbounded-notes/test_editor_gutter.mjs` 的行为移植。原型那份用一段
   自己写的小 runner（`test(name, fn)` + 手工计数），这里换成 `node:test` + `node:assert/strict`：
   17 条断言逐条保留，一条都没放宽；只改了源路径（`client/notes/`）与断言消息的措辞。

   钉的是四件事：
     · 行号位数只按**这一屏**最大真实行号算，夹在 2–4 位（不是整篇文档的位数）；
     · 点行号选整行（含行尾换行）、拖行号选连续整行，正反向一致，拖到两端不越界；
     · 测量阶段只写展示属性、不派发状态事务（否则 CodeMirror 会在更新期抛错），
       相同位数不重复复测，销毁后的编辑器不再写属性；
     · 接线与公开 API：`MarkdownEditor` 装的是 `editorGutter()` 而不是裸 `lineNumbers()`，
       行号栏只用公开配置点，不碰 CodeMirror 私有字段。

   依赖：`@codemirror/state` 的 `Text`（给行号数学喂一份真文档模型）。它是无界笔记的运行依赖，
   会随 `client/notes/` 的依赖一起装进根 `devDependencies`；不需要浏览器。
   跑法：`node --test scripts/tests/test_notes_editor_gutter.mjs`（在 `npm test` 的默认门禁里）。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Text } from '@codemirror/state';

import {
  GUTTER_DIGITS_ATTR,
  GUTTER_MEASURE,
  dragScrollSpeed,
  gutterDigitsForBlocks,
  gutterDigitsForLine,
  lineNumbersAtBlock,
  lineRangeSelection,
  maxVisibleLineNumber,
  visibleBlocks,
  wholeLineRange,
} from '../../client/notes/editor-gutter.js';

const SOURCE = new URL('../../client/notes/', import.meta.url);
const readSource = (name) => readFileSync(new URL(name, SOURCE), 'utf8');

const doc7 = () => Text.of(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
const selectedText = (doc, selection) => doc.sliceString(selection.main.from, selection.main.to);
/** 带几何的可见块：第 n 行占 [top, bottom)，每行 17px。 */
const blocksFor = (doc, count, height = 17) => Array.from({ length: count }, (_, index) => {
  const line = doc.line(index + 1);
  return { from: line.from, to: line.to, top: index * height, bottom: (index + 1) * height };
});

/* ── 位数：2–4 ───────────────────────────────────────────────────────────── */

test('位数夹在 2–4、随真实行号变化', () => {
  const cases = [[1, 2], [9, 2], [10, 2], [99, 2], [100, 3], [999, 3], [1000, 4], [12345, 4], [0, 2], [-5, 2], [NaN, 2], ['250', 3]];
  for (const [line, digits] of cases) assert.equal(gutterDigitsForLine(line), digits, '第 ' + line + ' 行');
});

/* ── 位数只看本屏 ────────────────────────────────────────────────────────── */

test('顶部长文仍是 2 位：预渲染块按可视范围筛掉', () => {
  const doc = Text.of(Array.from({ length: 5000 }, (_, index) => 'l' + index));
  const blocks = blocksFor(doc, 300);
  assert.equal(visibleBlocks(blocks, 0, 400).length, 24, '400px 高只留 24 行');
  assert.equal(gutterDigitsForBlocks(doc, visibleBlocks(blocks, 0, 400)), 2);
  assert.equal(maxVisibleLineNumber(doc, visibleBlocks(blocks, 0, 400)), 24);
});

test('滚到中间变 3 位、滚到四位数变 4 位', () => {
  const doc = Text.of(Array.from({ length: 5000 }, (_, index) => 'l' + index));
  const blocks = blocksFor(doc, 1500);
  assert.equal(gutterDigitsForBlocks(doc, visibleBlocks(blocks, 1700, 2300)), 3);
  assert.equal(gutterDigitsForBlocks(doc, visibleBlocks(blocks, 17000, 17600)), 4);
});

test('没有几何信息时退回原样；空列表 / 空文档不炸', () => {
  assert.equal(visibleBlocks([{ from: 0, to: 1 }], NaN, NaN).length, 1);
  assert.equal(visibleBlocks(null, 0, 100).length, 0);
  assert.equal(maxVisibleLineNumber(doc7(), []), 1);
  assert.equal(gutterDigitsForBlocks(Text.of(['']), [{ from: 999, to: 999 }]), 2);
});

test('多行块按末行算行号', () => {
  const doc = doc7();
  assert.equal(maxVisibleLineNumber(doc, [{ from: 0, to: doc.line(4).to }]), 4);
});

/* ── 整行范围 ────────────────────────────────────────────────────────────── */

test('整行范围含换行；末行没有换行', () => {
  const doc = Text.of(['ab', 'cd', 'ef']);
  assert.deepEqual(wholeLineRange(doc, 1), { from: 0, to: 3 });
  assert.deepEqual(wholeLineRange(doc, 2), { from: 3, to: 6 });
  assert.deepEqual(wholeLineRange(doc, 3), { from: 6, to: 8 });
  assert.equal(doc.sliceString(0, 3), 'ab\n');
});

test('单击行号：一个整行范围、含换行', () => {
  const doc = Text.of(['aa', 'bb', 'cc']);
  const selection = lineRangeSelection(doc, 2, 2);
  assert.equal(selection.ranges.length, 1);
  assert.equal(selectedText(doc, selection), 'bb\n');
});

test('正向拖动 1→3：连续三整行，anchor 在上、head 在下', () => {
  const doc = doc7();
  const selection = lineRangeSelection(doc, 1, 3);
  assert.equal(selection.ranges.length, 1);
  assert.equal(selectedText(doc, selection), 'a\nb\nc\n');
  assert.deepEqual([selection.main.anchor, selection.main.head], [0, 6]);
});

test('反向拖动 3→1：同样的三整行，anchor 在下、head 在上', () => {
  const doc = doc7();
  const selection = lineRangeSelection(doc, 3, 1);
  assert.equal(selectedText(doc, selection), 'a\nb\nc\n');
  assert.deepEqual([selection.main.anchor, selection.main.head], [6, 0]);
});

test('拖过文档两端都不越界：末行不补换行', () => {
  const doc = Text.of(['a', 'b', 'c']);
  assert.equal(lineRangeSelection(doc, 1, 999).main.to, doc.length);
  const up = lineRangeSelection(doc, 3, -5);
  assert.equal(selectedText(doc, up), 'a\nb\nc');
  assert.equal(up.main.head, 0);
});

test('空文档也能产生合法选区', () => {
  const doc = Text.of(['']);
  const selection = lineRangeSelection(doc, 1, 1);
  assert.equal(selection.ranges.length, 1);
  assert.equal(selection.main.from, 0);
  assert.equal(selection.main.to, 0);
});

/* ── 可见块 → 行号 ───────────────────────────────────────────────────────── */

test('多行块取首末行号；行内 widget 只取首行', () => {
  const doc = Text.of(['a', 'b', 'c', 'd']);
  assert.deepEqual(lineNumbersAtBlock(doc, { from: 2, to: 5, height: 40 }), { start: 2, end: 3 });
  assert.deepEqual(lineNumbersAtBlock(doc, { from: 0, to: 0, height: 20 }), { start: 1, end: 1 });
  assert.deepEqual(lineNumbersAtBlock(doc, { from: 3, to: 3, height: 0, widget: true }), { start: 2, end: 2 });
});

test('自动续滚速度有上限、向上为负', () => {
  assert.ok(dragScrollSpeed(-50) < 0, '鼠标在编辑区上沿上方 → 向上滚');
  assert.ok(dragScrollSpeed(50) > 0, '鼠标在编辑区下沿下方 → 向下滚');
  assert.ok(Math.abs(dragScrollSpeed(-1000)) <= 50);
  assert.ok(Math.abs(dragScrollSpeed(1000)) <= 50);
});

/* ── 测量期禁止嵌套派发 ──────────────────────────────────────────────────── */

test('测量写阶段只修改展示属性并复测几何，不派发状态事务', () => {
  const attributes = new Map();
  let measures = 0;
  const view = {
    destroyed: false,
    dom: { getAttribute: (key) => attributes.get(key), setAttribute: (key, value) => attributes.set(key, value) },
    requestMeasure() { measures++; },
    dispatch() { throw new Error('Calls to EditorView.update are not allowed while an update is in progress'); },
  };
  assert.doesNotThrow(() => GUTTER_MEASURE.write(3, view));
  assert.equal(attributes.get(GUTTER_DIGITS_ATTR), '3');
  assert.equal(measures, 1);
  GUTTER_MEASURE.write(2, view);
  assert.equal(attributes.get(GUTTER_DIGITS_ATTR), '2');
  assert.equal(measures, 2);
});

test('相同位数不循环重测，销毁后的编辑器不写属性', () => {
  const attributes = new Map([[GUTTER_DIGITS_ATTR, '4']]);
  let measures = 0;
  const view = {
    destroyed: false,
    dom: { getAttribute: (key) => attributes.get(key), setAttribute: (key, value) => attributes.set(key, value) },
    requestMeasure() { measures++; },
  };
  GUTTER_MEASURE.write(4, view);
  assert.equal(measures, 0);
  view.destroyed = true;
  GUTTER_MEASURE.write(2, view);
  assert.equal(attributes.get(GUTTER_DIGITS_ATTR), '4');
  assert.equal(measures, 0);
});

/* ── MarkdownEditor 的接线 ───────────────────────────────────────────────── */

test('MarkdownEditor 用 editorGutter 取代裸 lineNumbers，既有护栏都在', () => {
  const source = readSource('MarkdownEditor.jsx');
  assert.match(source, /editorGutter\(\)/);
  assert.doesNotMatch(source, /\blineNumbers\(\)/, '不该再直接装原生行号栏');
  assert.match(source, /MAX_MARKDOWN_LENGTH = 128 \* 1024/);
  assert.match(source, /history\(\)/);
  assert.match(source, /themeSlot\.current\.of\(appearance\(theme\)\)/);
  assert.match(source, /themeSlot\.current\.reconfigure\(appearance\(theme\)\)/);
  assert.match(source, /var\(--editor, var\(--surface\)\)/);
  assert.match(source, /var\(--code-gutter\)/);
  assert.match(source, /markdown\(\{ codeLanguages \}\)/);
});

test('行号栏扩展只用公开 API，没有旧名字 / 更新期嵌套 dispatch', () => {
  const source = readSource('editor-gutter.js');
  for (const forbidden of ['EditorView.layout', 'startMouseSelection', 'lineNumberMarkers', 'digitsMeasure', 'updateState', 'formatNumber']) {
    assert.ok(!source.includes(forbidden), '不该出现 ' + forbidden);
  }
  assert.match(source, /domEventHandlers:\s*\{\s*mousedown/);
  assert.match(source, /addEventListener\('scroll'/);
  assert.doesNotMatch(source, /view\.observer/, '不应依赖 CodeMirror 私有观察器');
  assert.match(source, /view\.requestMeasure\(GUTTER_MEASURE\)/);
  assert.match(source, /export const gutterTheme/);
});
