/* 课件页阅读位置三级恢复（#76）· 纯数学那一半
   ────────────────────────────────────────────────────────────────────────
   阅读端（`lib/client.js`）零构建、原样发货，所以它的纯函数没有 module 导出可用。
   这里按源码里的两个标记把**位置内核那一段原文**切出来，在只给 ECMAScript 内建对象的
   `vm` 沙箱里求值——顺手也就证明了这一段真的不碰 DOM、不碰存储、不读时钟：
   沙箱里没有 window / document / localStorage / Date，碰一个就 ReferenceError。

   测的是行为（给定已量好的候选与存下来的位置 → 选哪一级、滚到哪），不是实现：
   断言不碰私有变量名，只碰三个内核函数的返回值。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLIENT = path.join(ROOT, 'lib', 'client.js');

const START = '/* -- STUDY_POSITION_KERNEL_START -- */';
const END = '/* -- STUDY_POSITION_KERNEL_END -- */';

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
  // Object.create(null) 的上下文里连全局对象都没有，逐个补上这一段需要的内建
  const globals = { isFinite, Math, Number, String, Array, Object, JSON };
  for (const [name, value] of Object.entries(globals)) context[name] = value;
  return vm.runInContext(
    kernelSource() + '\n;({ topmostSectionIndex, resolveReadingTargets, readingPositionOf, readingPositionSettled, POSITION_TIERS });',
    context,
    { filename: 'lib/client.js#reading-position-kernel' },
  );
}

const { topmostSectionIndex, resolveReadingTargets, readingPositionOf, readingPositionSettled, POSITION_TIERS } = loadKernel();

/**
 * 内核跑在另一个 realm 里，它造的数组/对象原型与这边不同名（`deepStrictEqual` 会因此判不等）。
 * 断言只关心值，所以跨边界时先摊平成这一边的普通值。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 一节：`top`/`bottom` 都在滚动区坐标系里（与内核的契约一致）。 */
const sec = (index, id, top, bottom) => ({ index, id, top, bottom });

const SECTIONS = [
  sec(0, 'sec-0', 0, 600),
  sec(1, 'sec-1', 600, 1200),
  sec(2, 'sec-2', 1200, 2000),
];

/* ── 当前读到哪一节 ───────────────────────────────────────────────────── */

test('读到哪一节：可见线落在哪一节就算哪一节', () => {
  assert.equal(topmostSectionIndex(SECTIONS, 0, 700), 0);
  assert.equal(topmostSectionIndex(SECTIONS, 620, 700), 1);
  assert.equal(topmostSectionIndex(SECTIONS, 1250, 700), 2);
});

test('读到哪一节：还没滚到第一节时取第一个露头的，空候选给 -1', () => {
  // 正文顶上有一段页头，第一小节从 300 开始：此时可见线上方没有小节，仍应算第 0 节
  const padded = [sec(0, 'sec-0', 300, 900), sec(1, 'sec-1', 900, 1500)];
  assert.equal(topmostSectionIndex(padded, 0, 700), 0);
  assert.equal(topmostSectionIndex([], 0, 700), -1);
  assert.equal(topmostSectionIndex(null, 0, 700), -1);
});

test('读到哪一节：短小节不抢，只有短小节时仍取它', () => {
  // sec-1 只有 100px，撑不起一屏的一半：滚到它内部时仍算第 0 节
  const shorty = [sec(0, 'sec-0', 0, 600), sec(1, 'sec-1', 600, 700), sec(2, 'sec-2', 700, 1400)];
  assert.equal(topmostSectionIndex(shorty, 620, 700), 0);
  assert.equal(topmostSectionIndex(shorty, 760, 700), 2);
  // 全是短小节时兜底取最靠上的那一个，不返回 -1
  const allShort = [sec(0, 'sec-0', 0, 100), sec(1, 'sec-1', 100, 200)];
  assert.equal(topmostSectionIndex(allShort, 0, 700), 0);
  assert.equal(topmostSectionIndex(allShort, 150, 700), 1);
});

test('读到哪一节：可见线给坏值时按顶端算，不返回 NaN 下标', () => {
  assert.equal(topmostSectionIndex(SECTIONS, NaN, 700), 0);
  assert.equal(topmostSectionIndex(SECTIONS, 0, 0), 0);
});

/* ── 三级降级：选哪一级 ───────────────────────────────────────────────── */

test('三级次序就是 section → offset → progress', () => {
  assert.deepEqual(plain(POSITION_TIERS), ['section', 'offset', 'progress']);
});

test('一级：小节还在，按段内偏移落回同一处（正文改过也没关系）', () => {
  const at = resolveReadingTargets({ sectionId: 'sec-2', offset: 120, scrollTop: 1320, progress: 0.66 }, SECTIONS, 1600);
  assert.equal(at.tier, 'section');
  assert.equal(at.section, 2);
  assert.equal(at.top, 1320);
});

test('一级：小节被挪到别处时跟着走，不是回到原来那个像素', () => {
  // 正文在前面插了一节，sec-2 从 1200 挪到 1800；同一段落内偏移 120 应当落在 1920
  const moved = [sec(0, 'sec-0', 0, 800), sec(1, 'sec-1', 800, 1800), sec(2, 'sec-2', 1800, 2600)];
  const at = resolveReadingTargets({ sectionId: 'sec-2', offset: 120, scrollTop: 1320, progress: 0.66 }, moved, 2200);
  assert.equal(at.tier, 'section');
  assert.equal(at.top, 1920);
});

test('二级：小节没了就退到存下来的 scrollTop，不回到顶部', () => {
  const at = resolveReadingTargets({ sectionId: 'sec-gone', offset: 120, scrollTop: 1320, progress: 0.66 }, SECTIONS, 1600);
  assert.equal(at.tier, 'offset');
  assert.equal(at.section, -1);
  assert.equal(at.top, 1320);
});

test('三级：连 scrollTop 都没有（或太离谱被夹掉）才退到比例', () => {
  const only = resolveReadingTargets({ sectionId: 'sec-gone', offset: 120, progress: 0.5 }, SECTIONS, 1600);
  assert.equal(only.tier, 'progress');
  assert.equal(only.top, 800);

  // scrollTop 为 0 不算「存过位置」：那是回到顶部的意思，不该拦着比例那一级
  const zero = resolveReadingTargets({ sectionId: 'sec-gone', offset: 0, scrollTop: 0, progress: 0.25 }, SECTIONS, 1600);
  assert.equal(zero.tier, 'progress');
  assert.equal(zero.top, 400);
});

test('三级都退无可退：没有存过位置就回顶部，且 tier 是空串', () => {
  assert.deepEqual(plain(resolveReadingTargets(null, SECTIONS, 1600)), { tier: '', top: 0, section: -1 });
  assert.deepEqual(plain(resolveReadingTargets({}, SECTIONS, 1600)), { tier: '', top: 0, section: -1 });
  // 标题那一段没有 data-section，正文里一个候选都量不到时只能回顶部
  const none = resolveReadingTargets({ sectionId: 'sec-2', offset: 10 }, [], 1600);
  assert.equal(none.tier, '');
  assert.equal(none.top, 0);
});

test('段内偏移不会溢出到下一节：小节自己缩短时夹在本节末尾', () => {
  const shrunk = [sec(0, 'sec-0', 0, 600), sec(1, 'sec-1', 600, 900)];
  const at = resolveReadingTargets({ sectionId: 'sec-1', offset: 500 }, shrunk, 2000);
  assert.equal(at.tier, 'section');
  assert.equal(at.top, 900);            // 600 + min(500, 300)
});

test('目标一律夹进可滚范围：不会滚到不存在的像素上', () => {
  const past = resolveReadingTargets({ sectionId: 'sec-2', offset: 900, scrollTop: 5000 }, SECTIONS, 1600);
  assert.equal(past.top, 1600);
  assert.equal(past.tier, 'section');
  const beyond = resolveReadingTargets({ sectionId: 'x', scrollTop: 5000 }, SECTIONS, 1600);
  assert.equal(beyond.tier, 'offset');
  assert.equal(beyond.top, 1600);
  const negative = resolveReadingTargets({ sectionId: 'x', scrollTop: -40 }, SECTIONS, 1600);
  assert.equal(negative.top, 0);
  // 还量不到可滚高度（首帧）时一切目标都被夹到 0，但 tier 仍说清是哪一级兜的
  assert.equal(resolveReadingTargets({ sectionId: 'sec-1', offset: 30 }, SECTIONS, 0).top, 0);
  assert.equal(resolveReadingTargets({ sectionId: 'sec-1', offset: 30 }, SECTIONS, 0).tier, 'section');
});

test('坏几何不静默取第一个：这一级的 top 不是数就退下一级', () => {
  const broken = [sec(0, 'sec-0', NaN, NaN), sec(1, 'sec-1', 600, 1200)];
  const at = resolveReadingTargets({ sectionId: 'sec-0', offset: 10, scrollTop: 700 }, broken, 1600);
  assert.equal(at.tier, 'offset');
  assert.equal(at.top, 700);
});

/* ── 捕获：量到的几何 → 存下来的三元组 ────────────────────────────────── */

test('捕获：三元组按当前读到的节算出段内偏移与整篇比例', () => {
  const at = readingPositionOf(SECTIONS, 1300, 1600);
  assert.deepEqual(plain(at), { sectionId: 'sec-2', offset: 100, scrollTop: 1300, progress: 1300 / 1600 });
});

test('捕获：段内偏移永远落在本节里，比例永远在 0..1', () => {
  const at = readingPositionOf(SECTIONS, 3600, 1600);       // 越界的 scrollTop（滚动区刚变矮的那些帧）
  assert.equal(at.sectionId, 'sec-2');
  assert.equal(at.offset, 800);                              // 夹在 sec-2 的长度里
  assert.equal(at.progress, 1);
  const top = readingPositionOf(SECTIONS, 0, 1600);
  assert.deepEqual(plain(top), { sectionId: 'sec-0', offset: 0, scrollTop: 0, progress: 0 });
  // 量不到可滚高度时比例记 0，不记 NaN——NaN 会一路混进 JSON
  assert.equal(readingPositionOf(SECTIONS, 100, 0).progress, 0);
});

test('捕获：坏输入不产生 NaN', () => {
  const at = readingPositionOf(SECTIONS, NaN, NaN);
  assert.equal(at.scrollTop, 0);
  assert.equal(at.progress, 0);
  assert.equal(typeof at.offset, 'number');
  assert.ok(Number.isFinite(at.offset));
});

test('存下来的位置按 id 认小节，不按下标：插入一节不会让所有位置串位', () => {
  const saved = readingPositionOf(SECTIONS, 1300, 1600);
  const inserted = [sec(0, 'sec-new', 0, 500), ...SECTIONS.map((s, i) => sec(i + 1, s.id, s.top + 500, s.bottom + 500))];
  const at = resolveReadingTargets(saved, inserted, 2100);
  assert.equal(at.section, 3);            // 同一节（sec-2）在新的候选里排第 3
  assert.equal(at.top, 1800);             // 1200 + 500 的节首 + 原来的段内偏移 100
});

/* ── 什么时候可以下结论「恢复完了」 ───────────────────────────────────── */

test('恢复是否到位：落在目标附近就算到；还差得远且滚得动就再试', () => {
  assert.equal(readingPositionSettled(1000, 1000, 1600), true);
  assert.equal(readingPositionSettled(1000, 980, 1600), true);      // 容差之内
  assert.equal(readingPositionSettled(1000, 300, 1600), false);     // 没到位，应重试
  // 布局还在长：像素目标当下滚不到（clamp 在底部）——先接受，等长起来再重算
  assert.equal(readingPositionSettled(1000, 200, 200), true);
  // 这一篇远比存下来的目标长（正文加长了），而位置还卡在半路：继续重试
  assert.equal(readingPositionSettled(1000, 300, 3000), false);
});
