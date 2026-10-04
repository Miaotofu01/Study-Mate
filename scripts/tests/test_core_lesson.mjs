/* 解析层核心 · 一课的整体编排（lib/core/lesson.ts）

   钉的是「内容文件 + 题库 → 错误与提示」这一层的每条规则，以及两个方向的题库报错：
   正方向（锚点没题 / 只差空白 / 多匹配）与反方向（题库里多出来的键）。
   issue #66 验收的四条「故意造坏」都在这里：未知指令、锚点缺失、题库多余键、front matter 多字段。

   数据全部现造，不落盘；题库用对象字面量给（**不**读文件——读文件是调用方的事）。 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FormatProblems } from '../../lib/core/format.ts';
import {
  formatErrorLine, parseLesson, poolJsonError, renderBody, reportPoolShape, reportUnusedPool,
} from '../../lib/core/lesson.ts';

/* ── 夹具 ──────────────────────────────────────────────────────────────── */

// front matter 占 1-4 行，正文从第 5 行起——断言里的行号全都按这个算，
// 所以这里**不要**再加空行（加了整个套件的行号会一起漂）。
const FRONT = ['---', 'title: 测试课', 'goal: 一句话。', '---', ''];

function source(bodyLines, front = FRONT) {
  return [...front, ...bodyLines, ''].join('\n');
}

const QUIZ_BLOCK = ['::: quiz 理解 锚点：有的锚点', ':::', ''];

function codes(result) {
  return result.errors.map((item) => item.code);
}

function lineOf(result, code) {
  const item = result.errors.find((error) => error.code === code);
  return item ? item.line : null;
}

function run(bodyLines, options = {}, front = FRONT) {
  return parseLesson(source(bodyLines, front), 'a.md', options);
}

const POOL = { 有的锚点: [{ q: '题' }] };

/* ── 验收 1：六课那样的干净输入零错误 ─────────────────────────────────── */

test('干净输入：零错误、零提示，块与锚点都拿得到', () => {
  const result = run(['## 一节', '', '正文一段。', '', ...QUIZ_BLOCK], {
    pool: POOL, poolFile: 'a.quiz.json', poolPresent: true,
    poolRaw: '{\n  "有的锚点": [\n    { "q": "题" }\n  ]\n}\n',
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.notes, []);
  assert.equal(result.bodyStart, 4);   // 结束的 --- 在第 4 行，正文从下标 4 起
  assert.deepEqual(result.flags.referencedAnchors, ['有的锚点']);
  assert.equal(result.flags.needsQuiz, true);
  assert.equal(result.reconciliation.anchors[0].resolution, 'resolved');
  assert.deepEqual(result.reconciliation.orphans, []);
});

/* ── 验收 2：故意造坏，每条都带文件与行号 ─────────────────────────────── */

test('未知指令带文件与行号', () => {
  const result = run(['::: fancy 标题', ':::']);
  assert.deepEqual(codes(result), ['unknown-directive']);
  assert.equal(result.errors[0].file, 'a.md');
  assert.equal(result.errors[0].line, 6);           // front matter 占 1-5 行（末尾留一个空行）
  assert.match(formatErrorLine(result.errors[0]), /^a\.md:6 未知指令 ::: fancy/);
});

test('锚点缺失带文件与行号', () => {
  const result = run([...QUIZ_BLOCK.slice(0, 2).map((line) => line.replace('有的锚点', '写错的锚点')),
    ''], { pool: POOL, poolFile: 'a.quiz.json', poolPresent: true });
  assert.ok(codes(result).includes('anchor-missing'));
  assert.equal(lineOf(result, 'anchor-missing'), 6);
  assert.equal(result.errors.find((item) => item.code === 'anchor-missing').file, 'a.md');
  assert.match(result.errors.find((item) => item.code === 'anchor-missing').message,
    /锚点「写错的锚点」在 a\.quiz\.json 里没有题/);
});

test('题库多余键带**题库文件**与键的真实行号', () => {
  const poolRaw = `{
  "有的锚点": [
    { "q": "题" }
  ],
  "没人声明": [
    { "q": "题2" }
  ]
}
`;
  const result = run([...QUIZ_BLOCK], {
    pool: { 有的锚点: [{ q: '题' }], 没人声明: [{ q: '题2' }] },
    poolFile: 'a.quiz.json', poolPresent: true, poolRaw,
  });
  const orphan = result.errors.find((item) => item.code === 'pool-orphan');
  assert.ok(orphan, '题库里多出来的键必须报出来');
  assert.equal(orphan.file, 'a.quiz.json');
  assert.equal(orphan.line, 5);          // 键在 JSON 里的真实位置（不是文本搜索给的行）
  assert.match(orphan.message, /题库里的锚点「没人声明」没有任何 ::: quiz 题目位置引用它/);
  // 同时它也是**一等结论**：返回值里带着键、行号与题数
  assert.deepEqual(result.reconciliation.orphans, [{ key: '没人声明', line: 5, count: 1 }]);
  assert.deepEqual(result.reconciliation.orphanKeys, ['没人声明']);
});

test('front matter 多字段带文件与行号', () => {
  const result = run(['## 一节'], {}, ['---', 'title: 测试课', 'goal: 一句话。', 'kind: 概念', '---', '']);
  assert.deepEqual(codes(result), ['front-matter-unknown-field']);
  assert.equal(result.errors[0].line, 4);
  assert.equal(result.errors[0].file, 'a.md');
});

/* ── 四态在编排层的反应 ───────────────────────────────────────────────── */

test('missing 且没有 empty_reason → 错误；有 empty_reason → 只提示、不算错', () => {
  const bad = run(['::: quiz 理解 锚点：没有的锚点', ':::'], { pool: POOL, poolFile: 'a.quiz.json', poolPresent: true });
  assert.equal(lineOf(bad, 'anchor-missing'), 6);
  assert.equal(bad.notes.length, 0);

  const excused = run(['::: quiz 应用 锚点：分档数组版', 'empty_reason: 该锚点要验的东西在 lab 里，本轮不出题', ':::'],
    { pool: POOL, poolFile: 'a.quiz.json', poolPresent: true });
  assert.deepEqual(codes(excused), ['pool-orphan']);   // 只剩题库那边多出来的键
  assert.equal(excused.notes.length, 1);
  assert.match(excused.notes[0].message, /锚点「分档数组版」没有题：该锚点要验的东西在 lab 里/);
});

test('stale：只差空白 → 报错并指出两个名字', () => {
  const result = run(['::: quiz 改造 锚点：只差  空白', ':::'],
    { pool: { '只差 空白': [{ q: '题' }] }, poolFile: 'a.quiz.json', poolPresent: true });
  const stale = result.errors.find((item) => item.code === 'anchor-stale');
  assert.equal(stale.line, 6);
  assert.match(stale.message, /锚点「只差 {2}空白」与题库键「只差 空白」只差空白/);
  assert.equal(result.reconciliation.anchors[0].resolution, 'stale');
});

test('ambiguous：多匹配绝不静默取一个，两个候选都写进错误', () => {
  const result = run(['::: quiz 排错 锚点：多  匹配', ':::'],
    { pool: { '多 匹配': [{ q: 'a' }], 多匹配: [{ q: 'b' }] }, poolFile: 'a.quiz.json', poolPresent: true });
  const ambiguous = result.errors.find((item) => item.code === 'anchor-ambiguous');
  assert.equal(ambiguous.line, 6);
  assert.match(ambiguous.message, /对应 2 个键（「多 匹配」、「多匹配」）/);
  assert.deepEqual(result.reconciliation.anchors[0].keys, ['多 匹配', '多匹配']);
});

test('ambiguous：两个候选只差空白时也必须报出来（旧实现看 JSON 键序静默取一个）', () => {
  // 用 `' x'` 与 `'x '` 当候选：它们 strip 之后是 `x` 与 `x`，**精确**那一步就撞上了。
  // 旧实现的 `exact` 是 Map，后写的覆盖先写的——于是 `锚点：x` 指向哪个**看键序**。
  const forward = run(['::: quiz 理解 锚点：x', ':::'],
    { pool: { ' x': [{}], 'x ': [{}] }, poolFile: 'a.quiz.json', poolPresent: true });
  const backward = run(['::: quiz 理解 锚点：x', ':::'],
    { pool: { 'x ': [{}], ' x': [{}] }, poolFile: 'a.quiz.json', poolPresent: true });
  assert.equal(forward.errors.find((item) => item.code === 'anchor-ambiguous').line, 6);
  assert.equal(backward.errors.find((item) => item.code === 'anchor-ambiguous').line, 6);
  assert.deepEqual(forward.reconciliation.anchors[0].keys,
    backward.reconciliation.anchors[0].keys);
});

test('锚点有题却写了 empty_reason → 报错', () => {
  const result = run(['::: quiz 理解 锚点：有的锚点', 'empty_reason: 不该写', ':::'],
    { pool: POOL, poolFile: 'a.quiz.json', poolPresent: true });
  assert.equal(lineOf(result, 'anchor-missing'), 6);
  assert.match(result.errors[0].message, /在题库里有 1 道题，empty_reason 是给无题锚点用的（删掉它）/);
});

/* ── 重复锚点 ─────────────────────────────────────────────────────────── */

test('同一个锚点被两个题目位置引用 → 报错并指出第一次的行号', () => {
  const result = run(['::: quiz 理解 锚点：有的锚点', ':::', '',
    '::: quiz 改造 锚点：有的锚点', ':::'],
  { pool: POOL, poolFile: 'a.quiz.json', poolPresent: true });
  const duplicate = result.errors.find((item) => item.code === 'anchor-duplicate');
  assert.equal(duplicate.line, 9);
  assert.match(duplicate.message, /锚点「有的锚点」重复：第 6 行已经用过同一个锚点/);
});

/* ── 题库的两个方向 ───────────────────────────────────────────────────── */

test('有 ::: quiz 但题库文件不在 → 报错，并且逐条锚点也报没题', () => {
  const result = run([...QUIZ_BLOCK], { pool: null, poolPresent: false, poolFile: 'a.quiz.json' });
  assert.deepEqual(codes(result).sort(), ['anchor-missing', 'pool-missing']);
  const missing = result.errors.find((item) => item.code === 'pool-missing');
  assert.equal(missing.file, 'a.quiz.json');
  assert.equal(missing.line, 1);
  assert.equal(result.reconciliation, null);
});

test('一个题目位置都没有、题库文件却在 → 报错（整份交付没人用）', () => {
  const result = run(['## 一节', '', '正文。'], { pool: POOL, poolFile: 'a.quiz.json', poolPresent: true });
  const unused = result.errors.find((item) => item.code === 'pool-unused');
  assert.equal(unused.file, 'a.quiz.json');
  assert.equal(unused.line, 1);
  assert.match(unused.message, /内容文件里没有任何 ::: quiz 题目位置，但题库文件还在/);
  // 这一支**不**逐键刷 orphans（Python 也不报），但结论照样在返回值里
  assert.equal(result.errors.filter((item) => item.code === 'pool-orphan').length, 0);
  assert.deepEqual(result.reconciliation.orphanKeys, ['有的锚点']);
});

test('没有题目位置也没有题库 → 什么都不报（kind: 实验 的说明页）', () => {
  const result = run(['## 一节', '', '正文。'], { pool: null, poolPresent: false, poolFile: 'a.quiz.json' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.flags.needsQuiz, false);
  assert.equal(result.reconciliation, null);
});

test('题库形状坏（值不是非空数组）→ 报形状错，同时锚点照样报没题', () => {
  const result = run([...QUIZ_BLOCK], {
    pool: { 有的锚点: { q: '不是数组' } }, poolFile: 'a.quiz.json', poolPresent: true,
    poolRaw: '{\n  "有的锚点": {\n    "q": "不是数组"\n  }\n}\n',
  });
  assert.deepEqual(codes(result).sort(), ['anchor-missing', 'pool-shape']);
  assert.equal(lineOf(result, 'pool-shape'), 2);
  assert.match(result.errors.find((item) => item.code === 'pool-shape').message,
    /锚点「有的锚点」的值应是非空的题目数组/);

  const emptyArray = run([...QUIZ_BLOCK], {
    pool: { 有的锚点: [] }, poolFile: 'a.quiz.json', poolPresent: true,
  });
  assert.ok(codes(emptyArray).includes('pool-shape'));
  assert.ok(codes(emptyArray).includes('anchor-missing'));
});

test('题库 JSON 语法错转成一条普通错误（**不抛异常**）', () => {
  const problems = new FormatProblems();
  const raw = '{\n  "有的锚点": [\n    {oops\n  ]\n}\n';
  let caught = null;
  try { JSON.parse(raw); } catch (error) { caught = error; }
  assert.ok(caught, '这份 JSON 应该是坏的');
  poolJsonError(raw, caught, 'a.quiz.json', problems);
  assert.equal(problems.errors.length, 1);
  assert.equal(problems.errors[0].code, 'pool-json');
  assert.equal(problems.errors[0].file, 'a.quiz.json');
  assert.equal(problems.errors[0].line, 3);
  assert.match(problems.errors[0].message, /题库不是合法 JSON：/);
});

test('两个「题库整体」出口：顶层不是对象、题库文件没人用', () => {
  const problems = new FormatProblems();
  reportPoolShape('a.quiz.json', problems);
  reportUnusedPool('a.quiz.json', problems);
  assert.deepEqual(problems.errors.map((item) => item.code), ['pool-shape', 'pool-unused']);
  assert.equal(problems.errors[0].message, '题库结构应为 {"锚点文本": [题, …]}（最外层是对象）');
});

/* ── title 与大纲逐字一致（调用方的规则，解析层只接受参数） ───────────── */

test('title 与大纲不一致 → 报错带两个名字与 title 行号；一致就不报', () => {
  const mismatch = run(['## 一节'], { outlineTitle: '大纲里的标题', nodeId: 'demo.one' });
  assert.deepEqual(codes(mismatch), ['title-mismatch']);
  assert.equal(mismatch.errors[0].line, 2);
  assert.match(mismatch.errors[0].message,
    /front matter 的 title「测试课」与 curriculum\.yaml 里节点 demo\.one 的 title「大纲里的标题」不一致/);

  const match = run(['## 一节'], { outlineTitle: '测试课', nodeId: 'demo.one' });
  assert.deepEqual(codes(match), []);
});

/* ── `::: figure` 的存在性钩子 ────────────────────────────────────────── */

test('checkFigureSrc 钩子：返回什么就原样报什么，行号指到 ::: figure', () => {
  const notFound = run(['::: figure ../assets/img/pool/没有的图.png', 'alt: x', ':::'], {
    checkFigureSrc: (src) => `图片文件不存在：${src}（解析到 /sub/lessons/assets/img/pool/没有的图.png）`
      + '——从科目图片库 assets/img/pool/ 挑一张，或先采图',
  });
  assert.deepEqual(codes(notFound), ['figure-src']);
  assert.equal(notFound.errors[0].line, 6);

  const found = run(['::: figure a.png', 'alt: x', ':::'], { checkFigureSrc: () => null });
  assert.deepEqual(codes(found), []);
});

/* ── 渲染层与解析层一致 ───────────────────────────────────────────────── */

test('renderBody：出 data-quiz（JSON indent=2、属性值转义），并把渲染期错误并进来', () => {
  const result = run([...QUIZ_BLOCK], { pool: POOL, poolFile: 'a.quiz.json', poolPresent: true });
  const rendered = renderBody(result, 'a.md', { pool: POOL, poolName: 'a.quiz.json' });
  assert.equal(rendered.errors.length, 0);
  assert.match(rendered.html, /<div class="quiz" data-quiz='\[\n  \{\n    "q": "题"\n  \}\n\]'><\/div>/);
  assert.equal(rendered.goalHtml, '一句话。');

  // 行内 HTML 的错误在渲染期出（与 Python 同构）
  const tagged = run(['## 一节', '', '这段手写了 <b>粗</b> 标签。']);
  assert.deepEqual(codes(tagged), []);
  const taggedRender = renderBody(tagged, 'a.md');
  assert.deepEqual(taggedRender.errors.map((item) => item.code), ['html-inline']);
  assert.equal(taggedRender.errors[0].line, 8);   // 正文第 6 行是 ## 一节，第 7 行空，第 8 行才是段落
});

test('renderBody：有题却写了 empty_reason 时渲染层也报（与解析层同一条口径）', () => {
  const result = run(['::: quiz 理解 锚点：有的锚点', 'empty_reason: 不该写', ':::'],
    { pool: POOL, poolFile: 'a.quiz.json', poolPresent: true });
  const rendered = renderBody(result, 'a.md', { pool: POOL, poolName: 'a.quiz.json' });
  assert.ok(rendered.errors.some((item) => item.code === 'anchor-missing'));
  assert.match(rendered.html, /data-quiz=/);   // 有题照样渲染出来
});

test('renderBody：hasMath 只有渲染才看出来（行内公式与题库里的公式）', () => {
  const inline = run(['## 一节', '', '解 $Ax = b$ 就是……']);
  assert.equal(inline.flags.hasMath, false);          // 解析阶段还没渲染
  assert.equal(renderBody(inline, 'a.md').hasMath, true);

  const noMath = run(['## 一节', '', '一句普通的话。']);
  assert.equal(renderBody(noMath, 'a.md').hasMath, false);
});

test('renderBody：图注编号按页内顺序、图片库来源自动补', () => {
  const result = run([
    '::: svg', 'alt: 一', 'caption: 收拢', '<svg viewBox="0 0 4 2"/>', ':::', '',
    '::: figure a.png', 'alt: 二', 'caption: 数组在内存里挨着放', ':::', '',
    '::: figure b.png', 'alt: 三', ':::', '',
  ]);
  const rendered = renderBody(result, 'a.md', {
    poolSource: (src) => (src === 'a.png' ? '（来源：https://x.example/src，许可：CC0）' : ''),
  });
  // `::: figure` 与 `::: svg` 共用一条编号序列；没 caption 的图不编号
  assert.match(rendered.html, /<figcaption>图 1 · 收拢<\/figcaption>/);
  assert.match(rendered.html, /<figcaption>图 2 · 数组在内存里挨着放（来源：https:\/\/x\.example\/src，许可：CC0）<\/figcaption>/);
  assert.equal((rendered.html.match(/图 \d/g) || []).length, 2);

  // 作者自己写了来源就不重复补
  const withSource = run(['::: figure a.png', 'alt: x', 'caption: 描述（来源：自己写的）', ':::']);
  assert.match(renderBody(withSource, 'a.md', { poolSource: () => '（来源：不该出现，许可：X）' }).html,
    /图 1 · 描述（来源：自己写的）<\/figcaption>/);
});

/* ── 零宿主依赖 ───────────────────────────────────────────────────────── */

test('解析层不碰文件系统：option 里没有任何路径读盘，题库是对象不是路径', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  for (const name of ['anchors.ts', 'format.ts', 'lesson.ts']) {
    const text = readFileSync(fileURLToPath(new URL(`../../lib/core/${name}`, import.meta.url)), 'utf8');
    assert.ok(!/readFileSync|writeFileSync|existsSync|process\.cwd/.test(text), `${name} 碰了文件系统`);
  }
});
