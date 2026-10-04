/* 性能预算（目标态规格 §10.3「写成**相对工作区规模的比例**，不写绝对秒数」）——唯一的实现。
   ────────────────────────────────────────────────────────────────────────
   规格里这一行原来全仓零实现，而它是**唯一**能拦住「工作区一大就慢成什么样」的门禁。

   为什么**不**用挂钟：本会话已经修过一条时间抖动造成的假红——秒数在共享 CI 机器上取决于
   邻居、磁盘缓存与调度，同一个提交跑两次能差一倍，于是要么阈值松到拦不住东西，要么三天两
   头假红。所以这里数的是**工作量**：`readLibrary()` 真的碰了多少次文件系统
   （`readFileSync` / `readdirSync` / `statSync` / `lstatSync` / `realpathSync` / `existsSync`）。
   这个数字是确定性的：同一份工作区，跑多少次都一样。

   判据是**比例**，不是数字本身：现造 N 与 4N 两份额课件的工作区，断言
   `work(4N) / work(N) ∈ [3, 6]`。

     · 线性实现 ≈ 4（每多一个节点就多读它那一课 + 它的题库 + 几次 stat）；
     · 平方实现 ≈ 16（每个节点都把整个科目重读一遍——这是这类代码最常见的退化）；
     · 常数实现 ≈ 1（说明这条路上多了缓存，或者测试量错了东西）。

   阈值为什么是 [3, 6] 而不是「跑出来多少就写多少」：下界 3 允许固定开销（工作区、共享记忆、
   科目档案这些与节点数无关的读）把比例压低——实测 N=16→64 是 3.75，而 N=4→16 只有 3.20
   （固定开销占比更大）。上界 6 离平方的 16 还差一倍多，所以「多花一点点」不会假红，而真退化
   一定红。**这两个数是按「线性与平方之间要有一条能站住的线」定的，不是照着某次实测凑的。**

   数据现造、跑完即弃（ADR-0009）；不读仓库里任何文件、不碰真实工作区。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { readLibrary } from '../../lib/library.ts';

/* ── 数工作量 ─────────────────────────────────────────────────────────── */

const FS_CALLS = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'realpathSync', 'existsSync'];

/**
 * 跑一次 `work`，数它碰了几次文件系统。
 *
 * 为什么能这样数：`lib/**` 一律 `import fs from 'node:fs'`（默认导入拿到的就是那个 CJS
 * 导出对象），所以在这里换掉它的成员，被数的那段代码看到的也是换过的那个——不需要给引擎
 * 注入计数器（那会为了测试改生产代码的形状）。
 */
function countFsWork(work) {
  const counters = Object.fromEntries(FS_CALLS.map((name) => [name, 0]));
  const originals = {};
  for (const name of FS_CALLS) {
    originals[name] = fs[name];
    fs[name] = (...args) => { counters[name] += 1; return originals[name](...args); };
  }
  try {
    work();
  } finally {
    for (const name of FS_CALLS) fs[name] = originals[name];
  }
  return FS_CALLS.reduce((sum, name) => sum + counters[name], 0);
}

/* ── 现造一份 N 课的工作区 ────────────────────────────────────────────── */

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
});

function makeWorkspace(nodeCount) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-perf-'));
  TEMPS.push(root);
  const subject = path.join(root, '工作区', '.learning', 'subjects', 'demo');
  fs.mkdirSync(path.join(subject, 'lessons'), { recursive: true });
  fs.writeFileSync(path.join(subject, 'subject.yaml'), 'slug: demo\nname: 演示\n');
  fs.writeFileSync(path.join(subject, 'progress.yaml'),
    'updated_at: "2026-09-24"\nnodes: {}\nproject:\n  current: ""\n');
  const curriculum = ['nodes:'];
  for (let i = 0; i < nodeCount; i += 1) {
    curriculum.push(
      `  - id: n${i}`,
      `    title: 节点 ${i}`,
      '    kind: 概念',
      '    objective: 说得清它是什么',
      '    practice: 以讲为主',
    );
  }
  fs.writeFileSync(path.join(subject, 'curriculum.yaml'), `${curriculum.join('\n')}\n`);
  for (let i = 0; i < nodeCount; i += 1) {
    const name = `${String(i + 1).padStart(4, '0')}-n${i}`;
    fs.writeFileSync(path.join(subject, 'lessons', `${name}.md`), `# 节点 ${i}\n\n正文。\n`);
    fs.writeFileSync(path.join(subject, 'lessons', `${name}.quiz.json`), '{}\n');
  }
  return path.join(root, '工作区');
}

/** 一份工作区跑一次 `readLibrary()`，回它碰了几次文件系统。 */
function workOf(nodeCount) {
  const workspace = makeWorkspace(nodeCount);
  const payload = readLibrary({ workspace });
  assert.equal(payload.subjects[0].nodes.length, nodeCount, '现造的工作区没被完整读出来，量到的不作数');
  return countFsWork(() => readLibrary({ workspace }));
}

/* ── 判据 ─────────────────────────────────────────────────────────────── */

const LINEAR_BAND = [3, 6];

const inBand = (ratio) => ratio >= LINEAR_BAND[0] && ratio <= LINEAR_BAND[1];

test('读一份工作区的工作量随规模**线性**增长（4 倍规模 ≈ 4 倍工作量，不是 16 倍）', () => {
  const base = 16;
  const small = workOf(base);
  const large = workOf(base * 4);
  const ratio = large / small;

  assert.ok(small >= 20, `基准规模只量到 ${small} 次文件系统调用，太小了，比例不可信`);
  assert.ok(inBand(ratio),
    `工作量比例 ${ratio.toFixed(2)}（${small} → ${large}）落在 [${LINEAR_BAND}] 之外：`
    + '线性实现约 4、平方实现约 16、常数实现约 1。'
    + '真退化了就修那条路；如果是有意加了缓存，那要先改这条判据与规格 §10.3 的口径。');

  // 报出实测数字：门禁的输出要能让人一眼看出「现在离红线多远」
  console.log(`性能预算：${base} 课 ${small} 次 fs 调用 → ${base * 4} 课 ${large} 次，比例 ${ratio.toFixed(2)}（线性 ≈ 4，允许 [${LINEAR_BAND}]）`);
});

test('换一个规模再量一次：比例仍然在线性带里（不是某一个 N 撞上的）', () => {
  const base = 8;
  const ratio = workOf(base * 4) / workOf(base);
  assert.ok(inBand(ratio), `${base} → ${base * 4} 的比例是 ${ratio.toFixed(2)}，同样该落在线性带里`);
});

test('判据不空转：平方增长与常数增长都必须被这条带子拦下', () => {
  const growth = (cost, base) => cost(base * 4) / cost(base);
  assert.equal(inBand(growth((n) => 13 + 9 * n, 16)), true, '线性模型应当在带内');
  assert.equal(inBand(growth((n) => 13 + n * n, 16)), false, '平方模型必须被拦下');
  assert.equal(inBand(growth(() => 1000, 16)), false, '常数模型也要报出来（多半是量错了东西）');
});
