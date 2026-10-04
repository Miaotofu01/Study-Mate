/* 解析层核心 · 锚点与题库的逐字对账（lib/core/anchors.ts）

   这是 issue #66 验收里最要紧的一层：四态语义（resolved / stale / ambiguous / missing）
   与「多匹配绝不静默取第一个」。今天 `lib/library.mjs` 那份实现带着三个洞，这里逐条钉住：

     1. **exact 撞键**：题库同时有 `" x"` 与 `"x"` 时必须判 `ambiguous`，
        而且**两种 JSON 键序给同一结论**（旧实现是 Map 后写覆盖先写，看键序）；
     2. **orphans 是一等结论**：题库里多出来的键要报出来（旧实现塞进 payload 没人用）；
     3. 归一化的 candidates 与 ambiguous 的 keys 都按**码位**排序（与旧 JS 输出可比）。

   数据全部现造，不读仓库里任何文件。 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  declaredFromBlocks, normalizeAnchor, poolKeyLines, reconcileAnchors,
} from '../../lib/core/anchors.ts';
import { cmpCodePoints, pyStrip } from '../../lib/core/format.ts';

const POOL_LINE_OF = () => 1;

function reconcile(declared, pool, lineOf = POOL_LINE_OF) {
  return reconcileAnchors(declared, pool, { poolFile: 'a.quiz.json', poolLineOf: lineOf });
}

function anchorsOf(...texts) {
  return texts.map((text, index) => ({ text, level: '理解', line: 10 + index }));
}

/* ── 四态 ──────────────────────────────────────────────────────────────── */

test('resolved：题库里有逐字相等的键', () => {
  const result = reconcile(anchorsOf('精确命中'), { 精确命中: [{ q: 'x' }] });
  assert.deepEqual(result.anchors, [{
    text: '精确命中', level: '理解', line: 10, resolution: 'resolved',
    keys: ['精确命中'], candidates: [{ key: '精确命中', line: 1, count: 1 }],
  }]);
  assert.deepEqual(result.orphans, []);
});

test('stale：只差空白、且归一化后恰好一个候选', () => {
  const result = reconcile(anchorsOf('只差  空白'), { '只差 空白': [{ q: 'x' }] });
  assert.equal(result.anchors[0].resolution, 'stale');
  assert.deepEqual(result.anchors[0].keys, ['只差 空白']);
  // stale 的 keys 与 text **只差空白**（可断言）
  assert.equal(normalizeAnchor(result.anchors[0].keys[0]), normalizeAnchor('只差  空白'));
});

test('ambiguous：归一化后有多个候选，全部报出来、按码位排序', () => {
  const result = reconcile(anchorsOf('多  匹配'), { '多 匹配': [{ q: 'a' }], 多匹配: [{ q: 'b' }] });
  assert.equal(result.anchors[0].resolution, 'ambiguous');
  assert.deepEqual(result.anchors[0].keys, ['多 匹配', '多匹配']);
  assert.equal(result.anchors[0].candidates.length, 2);
});

test('missing：题库里根本没有这个键', () => {
  const result = reconcile(anchorsOf('查无此锚'), { 别的键: [{ q: 'x' }] });
  assert.deepEqual(result.anchors[0], {
    text: '查无此锚', level: '理解', line: 10, resolution: 'missing', keys: [], candidates: [],
  });
});

test('逐字命中优先于归一化：条文相同就是 resolved，即使归一化后会有歧义', () => {
  const result = reconcile(anchorsOf('多匹配'), { 多匹配: [{ q: 'a' }], '多 匹配': [{ q: 'b' }] });
  assert.equal(result.anchors[0].resolution, 'resolved');
  assert.deepEqual(result.anchors[0].keys, ['多匹配']);
  // 另一个键没人认领 → orphan
  assert.deepEqual(result.orphanKeys, ['多 匹配']);
});

test('题库键首尾的空白不算差异（两边都过 Python 的 strip）', () => {
  const result = reconcile(anchorsOf('两边空白'), { ' 两边空白 ': [{ q: 'x' }] });
  assert.equal(result.anchors[0].resolution, 'resolved');
  assert.deepEqual(result.anchors[0].keys, [' 两边空白 ']);
  // resolved 时 keys 长度 1 且与 text **逐字相等**（可断言）
  assert.equal(pyStrip(result.anchors[0].keys[0]), result.anchors[0].text);
});

/* ── 红线：多匹配绝不静默取第一个 ─────────────────────────────────────── */

test('exact 撞键判 ambiguous——**绝不**静默取第一个，两种 JSON 键序同一结论', () => {
  // 键序 A：`" x"` 在前
  const forward = reconcile(anchorsOf('x'), { ' x': [{ q: 'a' }], x: [{ q: 'b' }] });
  // 键序 B：`"x"` 在前
  const backward = reconcile(anchorsOf('x'), { x: [{ q: 'b' }], ' x': [{ q: 'a' }] });

  assert.equal(forward.anchors[0].resolution, 'ambiguous');
  assert.equal(backward.anchors[0].resolution, 'ambiguous');
  assert.deepEqual(forward.anchors[0].keys, [' x', 'x']);   // 码位序：空格(0x20) < x
  assert.deepEqual(forward.anchors[0].keys, backward.anchors[0].keys);
  assert.deepEqual(forward.orphanKeys, []);
  assert.deepEqual(backward.orphanKeys, []);

  // 旧实现（Map 后写覆盖先写）会给出**不同**的结论——这条断言就是那个洞的墓碑
  assert.notDeepEqual(forward.anchors[0].keys, ['x']);
  assert.notDeepEqual(backward.anchors[0].keys, [' x']);
  assert.equal(forward.anchors[0].candidates.length, 2);
});

test('exact 撞键的三个以上候选也全报，且仍是同一结论', () => {
  const result = reconcile(anchorsOf('x'), { x: [{}], ' x': [{}], 'x ': [{}] });
  assert.equal(result.anchors[0].resolution, 'ambiguous');
  assert.deepEqual(result.anchors[0].keys, [' x', 'x', 'x ']);
});

test('空锚点文本走归一化路径（`::: quiz 锚点：` 本身在解析层就报错，到不了这里）', () => {
  // 只有精确候选会跳过空文本；归一化候选是一视同仁的，所以空文本会与空键撞成 stale。
  // 这条路径在真实内容里进不来（`buildQuiz` 的 `(.+)$` 要求锚点至少 1 字符），
  // 断言它只是为了把口径写下来，免得以后有人「顺手」给空文本开个后门。
  const result = reconcile([{ text: '', level: '理解', line: 10 }], { '': [{}] });
  assert.equal(result.anchors[0].resolution, 'stale');
  assert.deepEqual(result.orphanKeys, []);
});

/* ── orphans ───────────────────────────────────────────────────────────── */

test('orphans：题库里没人认领的键，带键、行号与题数，按码位排序', () => {
  const result = reconcile(anchorsOf('有的锚点'), { 有的锚点: [{}, {}], 甲: [{}], 乙: [{}] });
  assert.deepEqual(result.orphanKeys, ['乙', '甲']);
  assert.deepEqual(result.orphans, [
    { key: '乙', line: 1, count: 1 },
    { key: '甲', line: 1, count: 1 },
  ]);
  // 行号走注入的 poolLineOf
  const withLines = reconcile(anchorsOf('有的锚点'), { 有的锚点: [{}], 加一行: [{}] },
    (key) => (key === '加一行' ? 7 : 2));
  assert.equal(withLines.orphans[0].line, 7);
  assert.equal(withLines.anchors[0].candidates[0].line, 2);
});

test('一个题目位置都没有时，题库里每个键都是 orphan', () => {
  const result = reconcile([], { 甲: [{}], 乙: [{}, {}] });
  assert.deepEqual(result.anchors, []);
  assert.deepEqual(result.orphanKeys, ['乙', '甲']);
  assert.deepEqual(result.orphans.map((item) => item.count), [2, 1]);
});

test('同一个键被两条声明认领时不会重复进 orphans', () => {
  const result = reconcile(anchorsOf('重复锚点', '重复锚点'), { 重复锚点: [{}] });
  assert.equal(result.anchors.length, 2);
  assert.deepEqual(result.orphanKeys, []);
});

/* ── 码位序（不是 UTF-16 码元序） ─────────────────────────────────────── */

test('排序按 Python 的码位，不是 JS 的 UTF-16 码元', () => {
  const astral = '\u{1F600}';                 // 增补平面：JS 的 < 会把它排在 \uFFFF 之后
  const result = reconcile(anchorsOf('x'), { [astral]: [{}], '\uFFFF': [{}] });
  assert.deepEqual(result.orphanKeys, ['\uFFFF', astral]);
  assert.ok(cmpCodePoints('\uFFFF', astral) < 0);
  assert.ok(!('\uFFFF' < astral));            // 证明这条断言真的在防 JS 的默认比较
});

/* ── Python 空白集 ────────────────────────────────────────────────────── */

test('归一化抹的是 Python 的空白集：多 \\x1c-\\x1f 与 \\x85，少 \\ufeff', () => {
  assert.equal(normalizeAnchor('a\x1cb'), 'ab');
  assert.equal(normalizeAnchor('a\x85b'), 'ab');
  assert.equal(normalizeAnchor('a\u3000b'), 'ab');
  assert.equal(normalizeAnchor('a\ufeffb'), 'a\ufeffb');   // BOM 不是 Python 空白
  assert.equal(normalizeAnchor('a\u200bb'), 'a\u200bb');   // 零宽空格也不是
  // 所以「带 BOM 的锚点」在 stale 判定里**不**会与不带 BOM 的题库键相撞
  const result = reconcile(anchorsOf('a\ufeffb'), { ab: [{}] });
  assert.equal(result.anchors[0].resolution, 'missing');
});

/* ── 声明从块树里取 ───────────────────────────────────────────────────── */

test('declaredFromBlocks：只收 ::: quiz，按出现顺序', () => {
  const blocks = [
    { kind: 'h2', text: '一节', line: 6 },
    { kind: 'directive', name: 'quiz', level: '理解', anchor: '甲', empty_reason: null, line: 8 },
    { kind: 'directive', name: 'tip', title: '', body: [], line: 10 },
    { kind: 'directive', name: 'quiz', level: '应用', anchor: '乙', empty_reason: null, line: 12 },
  ];
  assert.deepEqual(declaredFromBlocks(blocks), [
    { text: '甲', level: '理解', line: 8 },
    { text: '乙', level: '应用', line: 12 },
  ]);
});

/* ── 题库键的真实行号（不用文本搜索） ─────────────────────────────────── */

test('poolKeyLines：按 JSON 的真实位置给键行号，题面里出现同名字符串不算', () => {
  const raw = [
    '{',
    '  "真键": [',
    '    {',
    '      "q": "题面里恰好写了 真键 两个字",',
    '      "why": "解释里也写了 真键"',
    '    }',
    '  ],',
    '  "另一个": []',
    '}',
    '',
  ].join('\n');
  const lines = poolKeyLines(raw);
  assert.equal(lines.get('真键'), 2);      // 旧实现（文本搜索）会报第 4 行——题面那一行
  assert.equal(lines.get('另一个'), 8);

  // 值里嵌了对象时不能把内层键当外层键（这里两个都记，但各在自己的位置）
  const nested = poolKeyLines('{\n  "外层": [\n    { "q": "x" }\n  ]\n}\n');
  assert.equal(nested.get('外层'), 2);
  assert.equal(nested.get('q'), 3);
  assert.equal(nested.size, 2);

  // 转义与多行字符串：行号要跟着真实换行走
  const escaped = poolKeyLines('{\n  "带\\"引号": [\n    "第一行\\n第二行"\n  ],\n  "尾": []\n}\n');
  assert.equal(escaped.get('带"引号'), 2);
  assert.equal(escaped.get('尾'), 5);
});
