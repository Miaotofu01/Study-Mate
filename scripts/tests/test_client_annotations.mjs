/* 阅读端标注（③）· 锚点内核 + 行号
   ────────────────────────────────────────────────────────────────────────────
   `lib/client.js` 零构建、原样发货，没有 module 导出。所以这里分两路取它的内部件：
     · **行号与解析**：`scripts/tests/fixtures/client_harness.mjs` 用 TEST_HOOK 拿真解析结果；
     · **纯函数内核**：按源码里的 STUDY_ANNOTATE_KERNEL_START/END 标记把那段原文切出来，
       在只给 ECMAScript 内建对象的 `vm` 沙箱里求值——顺手证明这一段真的不碰 DOM / 存储 /
       时钟（沙箱里没有 window、document、localStorage、Date，碰一个就 ReferenceError）。

   测的是行为：给定块与标注 → 四态是什么、偏移夹到哪、拼出来的引用长什么样。
   断言不碰私有变量名。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { clientInternals, viewText, findByProp } from './fixtures/client_harness.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLIENT = path.join(ROOT, 'lib', 'client.js');

const START = '/* -- STUDY_ANNOTATE_KERNEL_START -- */';
const END = '/* -- STUDY_ANNOTATE_KERNEL_END -- */';

/** 切出内核原文。标记被删掉就当场报错——不能让这条套件悄悄变成测空气。 */
function kernelSource() {
  const source = fs.readFileSync(CLIENT, 'utf8');
  const from = source.indexOf(START);
  const to = source.indexOf(END);
  assert.ok(from >= 0, `lib/client.js 里找不到 ${START}`);
  assert.ok(to > from, `lib/client.js 里找不到 ${END}`);
  return source.slice(from + START.length, to);
}

/** 只给内建对象的沙箱：DOM、存储、时钟一律没有。 */
function loadKernel() {
  const context = vm.createContext(Object.create(null));
  const globals = { isFinite, Math, Number, String, Array, Object, JSON };
  for (const [name, value] of Object.entries(globals)) context[name] = value;
  return vm.runInContext(
    kernelSource() + '\n;({ INLINE, inlinePlainText, blockPlainText, blockHash, annotationRangeOf,'
    + ' flattenBlocks, resolveRange, resolveAnnotation, reassignRange, annotationQuoteFor,'
    + ' excerptOfRange, offsetInText, ANNOTATION_STATE_RANK });',
    context,
    { filename: 'lib/client.js#annotate-kernel' },
  );
}

const K = loadKernel();
const {
  inlinePlainText, blockPlainText, blockHash, annotationRangeOf, flattenBlocks,
  resolveRange, resolveAnnotation, reassignRange, annotationQuoteFor, excerptOfRange, offsetInText,
} = K;

const client = clientInternals();

/** 内核跑在另一个 realm：数组/对象原型不同名，跨边界断言前先摊平成这边的普通值。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/* ═══ 一、parseBlocks 行号：每块都指回原文那一行（含嵌套指令的 baseLine） ═══ */

/* 正文行（不含 frontmatter）。行号从 1 开始、相对正文——与 parseLesson 的口径一致。 */
const BODY = [
  '# 极限与连续',
  '',
  '这一节讲极限的定义，以及 $\\lim_{x\\to a} f(x)$ 与连续的关系。',
  '',
  '$$',
  '\\lim_{x \\to a} f(x) = L',
  '$$',
  '',
  '| 概念 | 记号 | 说明 |',
  '| --- | --- | --- |',
  '| 极限 | $\\lim$ | 描述趋近 |',
  '',
  '::: note 注意',
  '这里的 `f(a)` 要有定义。',
  ':::',
  '',
  '::: practice 动手做 | 算一算',
  '先算 $\\lim_{x\\to 1}(x+1)$。',
  ':::',
  '',
  '```term',
  '$ node -v',
  'v24.0.0',
  '```',
  '',
  '::: quiz 练习 锚点：极限的定义',
  ':::',
  '',
  '> 极限是「越来越接近」的严格说法。',
  '',
  '- 左极限',
  '- 右极限',
];

const MARKDOWN = ['---', 'title: 极限与连续', '---', ...BODY].join('\n');
const lesson = client.parseLesson(MARKDOWN);

/** 断言某块的行号指回正文里以 `head` 开头的那一行。 */
function assertLineAt(block, head, where) {
  assert.ok(Number.isInteger(block.line) && block.line >= 1 && block.line <= BODY.length,
    `${where}：行号不合法（${block.line}）`);
  assert.equal(BODY[block.line - 1].slice(0, head.length), head,
    `${where}：行号 ${block.line} 指到的是「${BODY[block.line - 1]}」`);
}

test('普通块的行号：标题 / 段落 / 公式 / 表格 / 围栏 / 引用 / 列表都指回起始行', () => {
  const top = lesson.blocks;
  assertLineAt(top.find((b) => b.type === 'heading'), '# 极限与连续', '标题');
  assertLineAt(top.find((b) => b.type === 'para'), '这一节讲极限的定义', '段落');
  assertLineAt(top.find((b) => b.type === 'math'), '$$', '块级公式');
  assertLineAt(top.find((b) => b.type === 'table'), '| 概念 |', '表格');
  assertLineAt(top.find((b) => b.type === 'code'), '```term', '围栏');
  assertLineAt(top.find((b) => b.type === 'quote'), '> 极限是', '引用');
  assertLineAt(top.find((b) => b.type === 'list'), '- 左极限', '列表');
  assertLineAt(top.find((b) => b.type === 'quiz'), '::: quiz', 'quiz 标记');
});

test('嵌套指令的行号：note / practice 的 body 按 baseLine 递归成绝对行号', () => {
  const note = lesson.blocks.find((b) => b.type === 'callout' && b.tone === 'note');
  assert.ok(note && note.blocks.length, '::: note 没解析出内层块');
  assertLineAt(note, '::: note', 'note 自身');
  assertLineAt(note.blocks[0], '这里的 `f(a)`', 'note 内层段落');

  const practice = lesson.blocks.find((b) => b.type === 'practice');
  assert.ok(practice && practice.blocks.length, '::: practice 没解析出内层块');
  assertLineAt(practice, '::: practice', 'practice 自身');
  assertLineAt(practice.blocks[0], '先算 $\\lim', 'practice 内层段落');
});

test('摊平后的叶子块行号单调递增（嵌套块落在容器的位置，不串到后面）', () => {
  const flat = flattenBlocks(lesson.blocks);
  assert.ok(flat.length >= 8, '叶子块太少，解析口径可能变了');
  let last = 0;
  for (const block of flat) {
    assert.ok(block.line > last, `${block.type}@${block.line} 没有严格递增（上一块 ${last}）`);
    last = block.line;
  }
});

test('parseBlocks 接受 baseLine：嵌套递归的偏移算得对，同一输入两次解析逐字相同', () => {
  const blocks = client.parseBlocks(['# 甲', '', '第一段'], 10);
  assert.deepEqual(blocks.map((b) => b.line), [11, 13]);
  const nested = client.makeDirective('note', '', ['内层一条'], 20);
  assert.equal(nested.type, 'callout');
  assert.equal(nested.blocks[0].line, 21, 'makeDirective 的 bodyBaseLine 没传给递归');
  // 重渲稳定性：同一份内容解析两次，块（含 line）逐字一致
  assert.deepEqual(client.parseLesson(MARKDOWN).blocks, lesson.blocks);
});

/* ═══ 二、块纯文本与哈希：口径与 inlineNodes 一致、哈希稳定 ═══ */

test('行内标记按渲染口径去掉：粗体 / 行内代码 / 公式取 TeX / 链接取文字', () => {
  assert.equal(inlinePlainText('前 **粗** 中 `码` 后'), '前 粗 中 码 后');
  assert.equal(inlinePlainText('看 $x^2$ 与 [链接](https://example.com) 结束'), '看 x^2 与 链接 结束');
  // 转义美元号与不配对的写法原样留下（与 inlineNodes 同一条判据）
  assert.equal(inlinePlainText('价格 $5 不是公式'), '价格 $5 不是公式');
});

test('blockPlainText：逐块类型给渲染后可读文本（列表 / 表格首尾相接）', () => {
  const list = lesson.blocks.find((b) => b.type === 'list');
  assert.equal(blockPlainText(list), '左极限右极限');
  const table = lesson.blocks.find((b) => b.type === 'table');
  assert.equal(blockPlainText(table), '概念记号说明极限\\lim描述趋近');
  const code = lesson.blocks.find((b) => b.type === 'code');
  assert.equal(blockPlainText(code), '$ node -vv24.0.0', '代码原文去掉换行拼接');
  const math = lesson.blocks.find((b) => b.type === 'math');
  assert.equal(blockPlainText(math), '\\lim_{x \\to a} f(x) = L', '块级公式取 TeX');
  const note = lesson.blocks.find((b) => b.type === 'callout');
  assert.equal(blockPlainText(note), '', 'callout 不是叶子块，纯文本为空');
  assert.equal(blockPlainText(null), '');
  assert.equal(blockPlainText({ type: 'para', text: null }), '');
});

test('blockHash：稳定、区分内容、8 位十六进制，不改入参', () => {
  assert.match(blockHash('同一段'), /^[0-9a-f]{8}$/);
  assert.equal(blockHash('同一段'), blockHash('同一段'));
  assert.notEqual(blockHash('同一段'), blockHash('同一段。'));
  assert.equal(blockHash(''), blockHash(null));
  assert.notEqual(blockHash('a'), blockHash('b'));
  // 中文按码位参与：换一个字必须换哈希
  assert.notEqual(blockHash('极限'), blockHash('极限值'));
});

test('annotationRangeOf：块 → {line, kind, hash, text}，哈希与纯文本对得上', () => {
  const para = lesson.blocks.find((b) => b.type === 'para');
  const range = annotationRangeOf(para);
  assert.equal(range.line, para.line);
  assert.equal(range.kind, 'para');
  assert.equal(range.text, blockPlainText(para));
  assert.equal(range.hash, blockHash(range.text));
});

/* ═══ 三、四态判定：resolved / stale / ambiguous / missing ═══ */

/** 用真块造一条覆盖整块的标段。 */
function fullRangeOf(block, start, end) {
  const range = annotationRangeOf(block);
  return { line: range.line, kind: range.kind, hash: range.hash, start: start == null ? 0 : start, end: end == null ? range.text.length : end };
}

const para = lesson.blocks.find((b) => b.type === 'para');

test('resolved：行号、kind、hash 都对，偏移原样可用', () => {
  const info = resolveAnnotation({ ranges: [fullRangeOf(para, 1, 3)] }, lesson.blocks);
  assert.equal(info.state, 'resolved');
  assert.equal(info.ranges.length, 1);
  assert.equal(info.ranges[0].state, 'resolved');
  assert.equal(info.ranges[0].blockIndex, lesson.blocks.indexOf(para));
  assert.deepEqual({ start: info.ranges[0].start, end: info.ranges[0].end }, { start: 1, end: 3 });
});

test('stale：行号与 kind 对得上、hash 不同（这一段原文被改过）', () => {
  const changed = client.parseLesson(MARKDOWN.replace('这一节讲极限的定义', '这一节讲极限的严格定义'));
  const info = resolveAnnotation({ ranges: [fullRangeOf(para)] }, changed.blocks);
  assert.equal(info.state, 'stale');
  assert.equal(info.ranges[0].state, 'stale');
  assert.equal(info.ranges[0].blockIndex, changed.blocks.findIndex((b) => b.type === 'para'));
});

test('重定位：行号对不上但 hash 在正文里唯一 → resolved（模型挪了段落）', () => {
  const range = Object.assign(fullRangeOf(para), { line: 9999, start: 0, end: 4 });
  const info = resolveAnnotation({ ranges: [range] }, lesson.blocks);
  assert.equal(info.state, 'resolved');
  assert.equal(info.ranges[0].blockIndex, lesson.blocks.indexOf(para));
});

test('ambiguous：同样原文出现多处，绝不静默取第一个', () => {
  const doubled = client.parseLesson(MARKDOWN + '\n\n同一段话。\n\n同一段话。\n');
  const target = doubled.blocks.find((b) => b.text === '同一段话。');
  const range = Object.assign(annotationRangeOf(target), { line: 9999, start: 0, end: 2 });
  const info = resolveAnnotation({ ranges: [range] }, doubled.blocks);
  assert.equal(info.state, 'ambiguous');
  assert.equal(info.ranges[0].blockIndex, -1);
});

test('missing：原文已经不在这一课里', () => {
  const gone = { line: 9999, kind: 'para', hash: 'deadbeef', start: 0, end: 4 };
  const info = resolveAnnotation({ ranges: [gone] }, lesson.blocks);
  assert.equal(info.state, 'missing');
  assert.equal(info.ranges[0].state, 'missing');
});

test('行号对上了但 kind 不同：不判 stale，按 hash 搜（搜不到 → missing）', () => {
  const heading = lesson.blocks.find((b) => b.type === 'heading');
  const range = { line: heading.line, kind: 'para', hash: blockHash('另一段'), start: 0, end: 2 };
  const info = resolveAnnotation({ ranges: [range] }, lesson.blocks);
  assert.equal(info.state, 'missing');
});

test('多段标注的整体状态取最坏：missing > ambiguous > stale > resolved', () => {
  const ok = fullRangeOf(para);
  // stale 的判据是「行号与 kind 都对得上、hash 不同」：拿真行号 + 假 hash
  const staleRange = { line: para.line, kind: 'para', hash: 'aaaaaaaa', start: 0, end: 1 };
  const missingRange = { line: 8888, kind: 'quote', hash: 'bbbbbbbb', start: 0, end: 1 };
  assert.equal(resolveAnnotation({ ranges: [ok] }, lesson.blocks).state, 'resolved');
  const stale = resolveAnnotation({ ranges: [ok, staleRange] }, lesson.blocks);
  assert.equal(stale.state, 'stale', 'stale 不该被 resolved 拉低');
  const mixed = resolveAnnotation({ ranges: [ok, staleRange, missingRange] }, lesson.blocks);
  assert.equal(mixed.state, 'missing', 'missing 是四态里最坏的那一档');
  assert.equal(mixed.ranges.length, 3);
});

test('无效输入不抛：空 blocks / 坏 ranges / null 都给明确结果', () => {
  assert.deepEqual(plain(resolveAnnotation(null, [])), { state: 'missing', ranges: [] });
  assert.deepEqual(plain(resolveAnnotation({}, lesson.blocks)), { state: 'missing', ranges: [] });
  assert.deepEqual(plain(resolveAnnotation({ ranges: '不是数组' }, lesson.blocks)), { state: 'missing', ranges: [] });
  const weird = resolveAnnotation({ ranges: [null, { line: 'x', kind: null, hash: null, start: 'a', end: {} }] }, lesson.blocks);
  assert.equal(weird.state, 'missing');
  assert.equal(resolveAnnotation({ ranges: [fullRangeOf(para)] }, null).state, 'missing');
  // 偏移越界：夹到块文本长度里，不返回 NaN
  const clamped = resolveAnnotation({ ranges: [Object.assign(fullRangeOf(para), { start: -5, end: 9999 })] }, lesson.blocks);
  assert.equal(clamped.state, 'resolved');
  assert.equal(clamped.ranges[0].start, 0);
  assert.equal(clamped.ranges[0].end, blockPlainText(para).length);
});

/* ═══ 四、reassignRange：失效标注「重新指定到当前段落」 ═══ */

test('reassignRange：优先当前行的块，偏移夹到新块长度里', () => {
  const quoteBlock = lesson.blocks.find((b) => b.type === 'quote');
  const next = reassignRange({ line: quoteBlock.line, kind: 'para', hash: 'x', start: 3, end: 9999 }, lesson.blocks);
  assert.equal(next.line, quoteBlock.line);
  assert.equal(next.kind, 'quote');
  assert.equal(next.hash, blockHash(blockPlainText(quoteBlock)));
  assert.equal(next.start, 3);
  assert.equal(next.end, blockPlainText(quoteBlock).length);
});

test('reassignRange：行号没了就取同 kind 最近的那一块', () => {
  // 摊平后最近的 para 是 practice 内层那一段（line 18），不是正文第一段（line 3）
  const flatParas = flattenBlocks(lesson.blocks).filter((block) => block.type === 'para');
  const nearest = flatParas.slice().sort((a, b) => Math.abs(a.line - 9999) - Math.abs(b.line - 9999))[0];
  const next = reassignRange({ line: 9999, kind: 'para', hash: 'x', start: 0, end: 2 }, lesson.blocks);
  assert.equal(next.kind, 'para');
  assert.equal(next.line, nearest.line);
  assert.equal(next.hash, blockHash(blockPlainText(nearest)));
  // 没有同 kind 的块可指 → null（调用处据此禁用按钮）
  assert.equal(reassignRange({ line: 9999, kind: '不存在的类型', hash: 'x', start: 0, end: 2 }, lesson.blocks), null);
  assert.equal(reassignRange({ line: 1, kind: '不存在的类型', hash: 'x', start: 0, end: 1 }, lesson.blocks).kind, 'heading',
    '当前行真有块时优先用它，哪怕 kind 不同');
});

/* ═══ 五、划选换算：offsetInText ═══ */

test('offsetInText：片内偏移折成块内偏移，越界夹住、不抛', () => {
  const pieces = ['第一段', '第二段', 'x^2'];
  assert.equal(offsetInText(pieces, 0, 0), 0);
  assert.equal(offsetInText(pieces, 1, 2), 5);
  assert.equal(offsetInText(pieces, 2, 3), 9);
  assert.equal(offsetInText(pieces, 3, 0), 9, '落在片数上（选区贴到块末）等于总长');
  assert.equal(offsetInText(pieces, 99, 9), 9);
  assert.equal(offsetInText(pieces, -3, -3), 0);
  assert.equal(offsetInText(null, 0, 0), 0);
});

/* ═══ 六、载荷 / 回执形状与写队列（③ 的围栏） ═══ */

test('annotationsFromPayload：有字段按 {present,version,items} 读；老 payload 给空态', () => {
  const rich = client.annotationsFromPayload({
    annotations: {
      present: true, version: 'v1',
      items: [{ id: 'a1', note: '注释', ranges: [{ line: 3, kind: 'para', hash: 'abc', start: 1, end: 3 }], created: 'c', modified: 'm' }],
    },
  });
  assert.equal(rich.present, true);
  assert.equal(rich.version, 'v1');
  assert.equal(rich.items.length, 1);
  assert.equal(rich.items[0].note, '注释');
  assert.deepEqual(rich.items[0].ranges[0], { line: 3, kind: 'para', hash: 'abc', start: 1, end: 3 });
  assert.deepEqual(client.annotationsFromPayload({}).present, false);
  assert.deepEqual(client.annotationsFromPayload(null), { present: false, version: '', items: [] });
});

test('annotationsFromReceipt：回执的「标」是落盘 Record（id → 标注）→ 读回数组，version 原样', () => {
  const receipt = client.annotationsFromReceipt('n1', {
    ok: true,
    version: '0123456789abcdef',
    annotations: {
      节点: 'n1', 课件: 'lessons/x.md', 幂等键: 'op-1', 最后写入: 't',
      标: { a1: { id: 'a1', note: 'x', ranges: [] }, a2: { id: 'a2', note: 'y', ranges: [] } },
    },
  });
  assert.equal(receipt.version, '0123456789abcdef');
  assert.deepEqual(receipt.items.map((one) => one.id), ['a1', 'a2'], 'Record → 数组，顺序稳定');
  assert.equal(receipt.present, true);
  // 也接受数组形状（测试夹具 / 更早的回执）——两种都归一成数组
  const fromArray = client.annotationsFromReceipt('n1', { ok: true, version: 'v2', annotations: { 标: [{ id: 'a1', note: 'x', ranges: [] }] } });
  assert.deepEqual(fromArray.items.map((one) => one.id), ['a1']);
  // 清空过：present:true + 空 Record
  const cleared = client.annotationsFromReceipt('n1', { ok: true, version: 'v3', annotations: { 标: {} } });
  assert.equal(cleared.present, true);
  assert.deepEqual(cleared.items, []);
  // 没有这一格（老回执）：present:false + 空数组
  const empty = client.annotationsFromReceipt('n1', { ok: true, version: 'v3' });
  assert.equal(empty.present, false);
  assert.deepEqual(empty.items, []);
});

test('写队列：串行发、幂等键可重放、409 自动按新版本重来一次', async () => {
  const calls = [];
  const applied = [];
  const refused = [];
  const writer = client.createAnnotationWriter({
    send(payload) {
      calls.push(payload);
      if (calls.length === 1) {
        return Promise.resolve({ status: 409, body: { ok: false, error: { code: 'version-conflict', message: '别处改过' }, version: 'v2', annotations: { 标: [] } } });
      }
      return Promise.resolve({ status: 200, body: { ok: true, version: 'v3', annotations: { 标: payload.annotations } } });
    },
    onApplied(job, body) { applied.push({ job, body }); },
    onRefused(job, body, retrying) { refused.push({ retrying, body }); },
  });
  writer.push({ lineKey: 's/n', subject: 's', node: 'n', items: [{ id: 'a', note: '' }], expectedVersion: 'v1', operationId: 'op-1' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 2, '409 之后要自动重来一次');
  assert.equal(calls[0].expectedVersion, 'v1');
  assert.equal(calls[1].expectedVersion, 'v2', '重来那一次要带 409 回执里的新版本号');
  assert.equal(calls[0].operationId, calls[1].operationId, '幂等键沿用同一个（Host 重放据此不写第二遍）');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].retrying, true);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].body.version, 'v3');
});

test('写队列的版本围栏：过期读数不采纳，在飞时不采纳', () => {
  const writer = client.createAnnotationWriter({ send: () => Promise.resolve({ status: 0, body: {} }), onApplied() {}, onRefused() {} });
  const key = 's/n';
  assert.equal(writer.acceptPayload(key, { present: true, version: 'v1', items: [] }), true);
  assert.equal(writer.acceptPayload(key, { present: true, version: 'v1', items: [] }), true);
  writer.push({ lineKey: key, subject: 's', node: 'n', items: [], expectedVersion: 'v1', operationId: 'op' });
  assert.equal(writer.acceptPayload(key, { present: true, version: 'v2', items: [] }), false, '有写在飞时不采纳 payload');
});

/* ═══ 七、④ 多选标注拼一条引用 chip ═══ */

test('annotationQuoteFor：每段「标注 N（第 L 段）：摘录」+「注释：…」，空注释与空摘录省略', () => {
  const quote = annotationQuoteFor([
    { id: 'a', note: '这里要注意左右极限', ranges: [fullRangeOf(para, 0, 4)] },
    { id: 'b', note: '', ranges: [fullRangeOf(lesson.blocks.find((b) => b.type === 'quote'), 0, 2)] },
  ], { path: 'lessons/0001-limit.md', blocks: lesson.blocks });
  assert.equal(quote.text, [
    '标注 1（第 3 段）：这一节讲',
    '注释：这里要注意左右极限',
    '标注 2（第 29 段）：极限',
  ].join('\n'));
  assert.deepEqual(plain(quote.anchor), { lesson: 'lessons/0001-limit.md', section: '', sectionTitle: '' });

  // 原文已变（hash 对不上）→ 摘录省略，注释照留
  const stale = { id: 'c', note: '旧注释', ranges: [{ line: para.line, kind: 'para', hash: 'deadbeef', start: 0, end: 4 }] };
  assert.equal(annotationQuoteFor([stale], { path: 'x.md', blocks: lesson.blocks }).text, '标注 1（第 3 段）\n注释：旧注释');
});

test('annotationQuoteFor：空选择给空文本（空引用不产 chip）', () => {
  const empty = annotationQuoteFor([], { path: 'x.md', blocks: lesson.blocks });
  assert.equal(empty.text, '');
  assert.equal(client.referenceInsertFor(empty), null, '空引用喂给 chip 机制必须得 null');
  assert.equal(annotationQuoteFor(null, { blocks: lesson.blocks }).text, '');
  assert.equal(annotationQuoteFor([{ id: 'x', note: '', ranges: [] }], { path: 'x.md', blocks: lesson.blocks }).text, '标注 1');
});

test('annotationQuoteFor：多选顺序稳定——同样输入两次逐字相同，换顺序文本跟着换', () => {
  const first = { id: 'a', note: '甲', ranges: [fullRangeOf(para, 0, 2)] };
  const second = { id: 'b', note: '乙', ranges: [fullRangeOf(para, 2, 4)] };
  const one = annotationQuoteFor([first, second], { path: 'x.md', blocks: lesson.blocks });
  const two = annotationQuoteFor([first, second], { path: 'x.md', blocks: lesson.blocks });
  const reversed = annotationQuoteFor([second, first], { path: 'x.md', blocks: lesson.blocks });
  assert.equal(one.text, two.text);
  assert.notEqual(one.text, reversed.text);
  assert.ok(one.text.startsWith('标注 1（第 3 段）：'), '第一条在前');
});

test('④ 拼出来的 quote 走现成的 chip 机制：编解码逐字往返、来源锚点带这一课', () => {
  const quote = annotationQuoteFor(
    [{ id: 'a', note: '注意这里', ranges: [fullRangeOf(para, 0, 4)] }],
    { path: 'lessons/0001-limit.md', blocks: lesson.blocks },
  );
  const insert = client.referenceInsertFor(quote);
  assert.ok(insert && insert.ref && insert.label, '非空引用要能进草稿');
  const decoded = client.decodeQuoteRef(insert.ref);
  assert.equal(decoded.text, quote.text, '原文 + 注释逐字往返');
  assert.equal(decoded.anchor.lesson, 'lessons/0001-limit.md');
  // 提交那一刻进消息的那段文字：原文 + 来源锚点（#106 的既有口径，不改）
  const serialized = client.quoteForModel(insert.ref);
  assert.ok(serialized.startsWith('【引用】'), serialized.slice(0, 20));
  assert.ok(serialized.indexOf('标注 1（第 3 段）：这一节讲') >= 0);
});

test('④ 列表：checkbox 多选 +「带着 N 条标注提问」入口（没选时禁用）', () => {
  const items = [
    { id: 'a', note: '第一条', ranges: [fullRangeOf(para, 0, 2)] },
    { id: 'b', note: '第二条', ranges: [fullRangeOf(para, 2, 4)] },
  ];
  const noop = () => {};
  const props = {
    annotations: { items }, lesson, open: true, selected: new Set(), error: '',
    onToggleOpen: noop, onToggleSelect: noop, onJump: noop, onReassign: noop, onEdit: noop, onAsk: noop,
  };
  // 没选中：按钮禁用，文字是「带着 0 条标注提问」
  const emptyTree = client.AnnotationPanel(Object.assign({}, props));
  const disabled = findByProp(emptyTree, 'data-proto', 'annotations-ask')[0];
  assert.ok(disabled, '列表里要有「带着 N 条标注提问」按钮');
  assert.equal(disabled.props.disabled, true);
  assert.ok(viewText(emptyTree).includes('带着 0 条标注提问'));

  // 选中一条：按钮可用、数字跟着变；checkbox 的 onChange 把 id 交给调用方
  const picked = [];
  const tree = client.AnnotationPanel(Object.assign({}, props, {
    selected: new Set(['a']),
    onToggleSelect: (id) => picked.push(id),
  }));
  const enabled = findByProp(tree, 'data-proto', 'annotations-ask')[0];
  assert.equal(enabled.props.disabled, false);
  assert.ok(viewText(tree).includes('带着 1 条标注提问'));
  const checkboxes = findByProp(tree, 'data-proto', 'annotation-pick');
  assert.equal(checkboxes.length, 2, '每条标注一个 checkbox');
  checkboxes[1].props.onChange();
  assert.deepEqual(picked, ['b']);
  // 点提问按钮走的是现成 quote 机制（onAsk），不在面板里拼字符串
  let asked = 0;
  const askTree = client.AnnotationPanel(Object.assign({}, props, { selected: new Set(['a']), onAsk: () => { asked += 1; } }));
  findByProp(askTree, 'data-proto', 'annotations-ask')[0].props.onClick();
  assert.equal(asked, 1);
});
