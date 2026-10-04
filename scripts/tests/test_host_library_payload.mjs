/* 特征化测试：Host 半数据层 · lib/library.mjs 读一份工作区得到什么 payload
   ────────────────────────────────────────────────────────────────────────
   测试对象是**行为**（输入 → 输出/抛错），不是实现：断言只碰 readLibrary() 的返回值，
   不碰文件扩展名、私有函数名或模块内部结构。后续把 .mjs 改写成 TypeScript 源时，
   这个套件应当原样通过。
   数据在 fs.mkdtemp 造的临时目录里现造现弃，仓库里不存样例数据。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { readLibrary, buildLibrary } from '../../lib/library.ts';

/* ── 临时工作区：跑完即弃 ─────────────────────────────────────────────── */

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-host-library-'));
  TEMPS.push(dir);
  return dir;
}

/** tree 的键是相对路径；值是字符串就原样写，否则当 JSON 写。 */
function writeTree(base, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const file = path.join(base, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

/** 把一份「科目目录内的相对路径 → 内容」铺到 .learning/subjects/<dirName>/ 下。 */
function subjectTree(dirName, files) {
  const out = {};
  for (const [rel, content] of Object.entries(files)) out[`.learning/subjects/${dirName}/${rel}`] = content;
  return out;
}

/** 一份能读成 payload 的最小科目：两个节点、一份带锚点的课件与题库。 */
function minimalSubject() {
  return {
    'subject.yaml': [
      'slug: demo',
      'name: 演示科目',
      'goal: 把最小科目读成一份 payload',
      'status: 学习中',
      'created_at: "2026-01-02T03:04:05+08:00"',
      '',
    ].join('\n'),
    'curriculum.yaml': [
      'nodes:',
      '  - id: 变量',
      '    title: 变量',
      '    kind: 概念',
      '    objective: 说清变量是什么',
      '    concepts: [绑定, 作用域]',
      '    pitfalls: [把赋值当成相等]',
      '    realworld: 记账时给每一笔起名字',
      '    practice: 给三个量起名',
      '    resources: [《入门》第 1 章]',
      '    status: 未开始',
      '  - id: 函数',
      '    title: 函数',
      '    kind: 概念',
      '    prerequisites: [变量]',
      'edges:',
      '  - from: 变量',
      '    to: 函数',
      '    reason: 先有绑定再谈调用',
      '',
    ].join('\n'),
    'progress.yaml': [
      'updated_at: "2026-05-06T07:08:09+08:00"',
      'project:',
      '  current: 演示项目',
      'misconceptions:',
      '  - 把赋值当成相等',
      'nodes:',
      '  变量:',
      '    status: 学习中',
      '    notes: 记住了绑定',
      '',
    ].join('\n'),
    'MISSION.md': ['# 演示使命', '', '## Why', '', '因为要演示。', '', '## 成功标准', '', '- 读出 payload', ''].join('\n'),
    'GLOSSARY.md': ['## 基础', '', '**绑定**: 名字指向值', '_Avoid_: 赋值', ''].join('\n'),
    'RESOURCES.md': '# 资源\n\n- 《入门》\n',
    'misconceptions.yaml': '[]\n',
    'learning-records/2026-05-06-第一次.md': ['# 第一次', '', '- 日期：2026-05-06', '', '读了变量。', ''].join('\n'),
    'lessons/1-变量.md': ['# 变量', '', '::: quiz 理解 锚点：精确命中', ':::', ''].join('\n'),
    'lessons/1-变量.quiz.json': { 精确命中: [{ q: '变量是什么', answer: '名字指向值', criteria: '说对即可' }] },
    'lessons/2-函数.md': '# 函数\n',
  };
}

function makeWorkspace(tree = {}, { memory = '# 共享记忆\n' } = {}) {
  const root = tmpRoot();
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(path.join(workspace, '.learning'), { recursive: true });
  if (memory !== null) writeTree(path.join(workspace, '.learning'), { 'MEMORY.md': memory });
  writeTree(workspace, tree);
  return { root, workspace };
}

function oneSubjectWorkspace() {
  return makeWorkspace(subjectTree('demo', minimalSubject()));
}

/* ── 顶层形状 ─────────────────────────────────────────────────────────── */

test('readLibrary 的顶层就那五个键，含义各自钉住', () => {
  const { workspace } = oneSubjectWorkspace();
  const payload = readLibrary({ workspace });

  assert.deepEqual(Object.keys(payload).sort(),
    ['generated_at', 'memory_md', 'subjects', 'today', 'workspace']);
  // workspace 是解析后的绝对路径：调用方靠它知道自己在读哪个库
  assert.equal(payload.workspace, workspace);
  // generated_at 是 ISO 时间戳（只钉形状，不钉具体时刻）
  assert.match(payload.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // memory_md 是 .learning/MEMORY.md 的正文，没有就是空串
  assert.equal(payload.memory_md, '# 共享记忆\n');
  // today 取各科目 updated_at 的字典序最大者的前 10 位
  assert.equal(payload.today, '2026-05-06');
  assert.equal(payload.subjects.length, 1);
});

test('buildLibrary 与 readLibrary 是同一份实现，相对 workspace 按 root 解析', () => {
  const { root, workspace } = oneSubjectWorkspace();
  const relative = path.relative(root, workspace);
  assert.equal(buildLibrary({ workspace: relative, root }).workspace, workspace);
  // 两次调用的 generated_at 必然不同（毫秒级时间戳），其余部分逐字相同
  const { generated_at: first, ...fromBuild } = buildLibrary({ workspace: relative, root });
  const { generated_at: second, ...fromRead } = readLibrary({ workspace: relative, root });
  assert.match(first, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(second, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(fromBuild, fromRead);
});

test('没有学科目、或没有 workspace 时抛错，而不是给一份空 payload', () => {
  const empty = makeWorkspace({});
  fs.mkdirSync(path.join(empty.workspace, '.learning', 'subjects'), { recursive: true });
  assert.throws(() => readLibrary({ workspace: empty.workspace }), /没有可用科目/);
  assert.throws(() => readLibrary({}), /需要 workspace/);
  assert.throws(() => readLibrary({ workspace: path.join(empty.workspace, '不存在') }), /找不到学习工作区/);
});

/* ── 科目与节点形状 ───────────────────────────────────────────────────── */

test('科目与节点的键名是页面依赖的契约，逐个钉住', () => {
  const { workspace } = oneSubjectWorkspace();
  const [subject] = readLibrary({ workspace }).subjects;

  assert.deepEqual(Object.keys(subject).sort(), [
    'continue_node', 'created_at', 'edges', 'glossary', 'goal', 'levels',
    'misconception_library', 'misconceptions', 'mission', 'name', 'nodes', 'order', 'project',
    'records', 'reference', 'reference_version', 'resources_md', 'slug', 'stats', 'status',
    'updated_at',
  ]);

  const [node] = subject.nodes;
  assert.deepEqual(Object.keys(node).sort(), [
    'anchors', 'concepts', 'id', 'kind', 'lab', 'lesson', 'lesson_md', 'level', 'notes',
    'number', 'objective', 'orphan_keys', 'orphans', 'pitfalls', 'pool', 'practice',
    'prerequisites', 'problem', 'raw_status', 'realworld', 'resources', 'tier', 'title',
  ]);
});

test('课件正文整段内联进 payload，页面不必再回主机取第二次', () => {
  const { workspace } = oneSubjectWorkspace();
  const [subject] = readLibrary({ workspace }).subjects;
  const [变量, 函数] = subject.nodes;

  assert.equal(变量.lesson_md, '# 变量\n\n::: quiz 理解 锚点：精确命中\n:::\n');
  assert.equal(函数.lesson_md, '# 函数\n');
  // lesson 是 <slug>/<文件名>，正文里的相对图片靠它拼基准路径
  assert.equal(变量.lesson, 'demo/1-变量.md');
  assert.equal(变量.number, '1');
  // 题库整段内联，键就是锚点文本
  assert.deepEqual(Object.keys(变量.pool), ['精确命中']);
  // 找不到课件的节点给空值，不抛错
  assert.equal(函数.number, '2');
});

test('零节点的科目直接跳过：建课先建目录，不该出现在阅读端', () => {
  const tree = {
    ...subjectTree('demo', minimalSubject()),
    ...subjectTree('空壳', { 'subject.yaml': 'slug: 空壳\nname: 空壳\n' }),
  };
  const { workspace } = makeWorkspace(tree);
  const payload = readLibrary({ workspace });
  assert.deepEqual(payload.subjects.map((subject) => subject.slug), ['demo']);
});

test('科目档案类附件按各自口径解析', () => {
  const { workspace } = oneSubjectWorkspace();
  const [subject] = readLibrary({ workspace }).subjects;

  assert.deepEqual(subject.mission, {
    title: '演示使命',
    sections: { Why: ['因为要演示。'], 成功标准: ['读出 payload'] },
  });
  assert.deepEqual(subject.glossary,
    [{ title: '基础', terms: [{ term: '绑定', def: '名字指向值', avoid: '赋值' }] }]);
  assert.deepEqual(subject.records.map((record) => ({ file: record.file, title: record.title, date: record.date })),
    [{ file: '2026-05-06-第一次.md', title: '第一次', date: '2026-05-06' }]);
  assert.equal(subject.resources_md, '# 资源\n\n- 《入门》\n');
  assert.deepEqual(subject.misconceptions, ['把赋值当成相等']);
  // progress.yaml 与 misconceptions.yaml 是双落点，两份都留在 payload 里
  assert.deepEqual(subject.misconception_library, []);
  assert.deepEqual(subject.edges, [{ from: '变量', to: '函数', reason: '先有绑定再谈调用' }]);
  assert.deepEqual(subject.order, { 变量: 0, 函数: 1 });
  // 依赖分层：变量是根（0 层），函数在它后面（1 层），levels 是总层数
  assert.deepEqual(subject.nodes.map((node) => node.level), [0, 1]);
  assert.equal(subject.levels, 2);
});

/* ── 旧六档 → 新三档 ──────────────────────────────────────────────────── */

/** 每个节点一个旧词表状态；期望值抄自目标态规格 §5.2，不是从实现里算出来的。 */
const TIER_CASES = [
  { id: '甲', legacy: '未开始', tier: '未开始' },
  { id: '乙', legacy: '学习中', tier: '学习中' },
  { id: '丙', legacy: '初步理解', tier: '学习中' },
  { id: '丁', legacy: '能独立应用', tier: '已学完' },
  { id: '戊', legacy: '需要复习', tier: '已学完' },
  { id: '己', legacy: '已通过项目验证', tier: '已学完' },
];

function tierWorkspace() {
  const nodes = TIER_CASES.map(({ id, legacy }) => `  - id: ${id}\n    title: ${id}\n    status: ${legacy}\n`);
  nodes.push('  - id: 庚\n    title: 庚\n    status: 没见过的词\n');
  nodes.push('  - id: 辛\n    title: 辛\n');
  return makeWorkspace(subjectTree('demo', {
    'subject.yaml': 'slug: demo\nname: 档位\n',
    'curriculum.yaml': `nodes:\n${nodes.join('')}`,
    // 甲 在大纲里是「未开始」，进度里改成「初步理解」：progress 覆盖大纲
    'progress.yaml': 'nodes:\n  甲:\n    status: 初步理解\n',
  }));
}

test('旧六档逐条映射到三档，两个来源的优先级也钉住', () => {
  const { workspace } = tierWorkspace();
  const [subject] = readLibrary({ workspace }).subjects;
  const byId = new Map(subject.nodes.map((node) => [node.id, node]));

  for (const { id, legacy, tier } of TIER_CASES) {
    if (id === '甲') continue; // 甲 被 progress 覆盖，单独断言
    assert.equal(byId.get(id).tier, tier, `${id}（${legacy}）应当映射成 ${tier}`);
    assert.equal(byId.get(id).raw_status, legacy, `${id} 的原始状态要原样留在 raw_status 里`);
  }
  assert.equal(byId.get('甲').raw_status, '初步理解');
  assert.equal(byId.get('甲').tier, '学习中', 'progress.yaml 压过大纲里的初始快照');
  // 不认识的词退回「未开始」，绝不静默当成学会了
  assert.equal(byId.get('庚').tier, '未开始');
  assert.equal(byId.get('庚').raw_status, '没见过的词');
  // 两个来源都没写状态时，按未开始算
  assert.equal(byId.get('辛').tier, '未开始');
  assert.equal(byId.get('辛').raw_status, '未开始');
});

test('stats 只数三档，continue_node 按「学习中 → 未开始 → 最后一个」挑', () => {
  const { workspace } = tierWorkspace();
  const [subject] = readLibrary({ workspace }).subjects;

  assert.deepEqual(subject.stats, { 未开始: 2, 学习中: 3, 已学完: 3 });
  assert.deepEqual(Object.keys(subject.stats), ['未开始', '学习中', '已学完']);
  // 甲 是第一个「学习中」
  assert.equal(subject.continue_node, '甲');
});

test('没有学习中的节点就挑第一个未开始；全学完则回到最后一个', () => {
  const allNew = makeWorkspace(subjectTree('demo', {
    'subject.yaml': 'slug: demo\nname: 全新\n',
    'curriculum.yaml': ['nodes:', '  - id: 甲', '    title: 甲', '  - id: 乙', '    title: 乙', ''].join('\n'),
  }));
  assert.equal(readLibrary({ workspace: allNew.workspace }).subjects[0].continue_node, '甲');

  const allDone = makeWorkspace(subjectTree('demo', {
    'subject.yaml': 'slug: demo\nname: 学完\n',
    'curriculum.yaml': [
      'nodes:',
      '  - id: 甲',
      '    title: 甲',
      '    status: 能独立应用',
      '  - id: 乙',
      '    title: 乙',
      '    status: 已通过项目验证',
      '',
    ].join('\n'),
  }));
  const [subject] = readLibrary({ workspace: allDone.workspace }).subjects;
  assert.deepEqual(subject.stats, { 未开始: 0, 学习中: 0, 已学完: 2 });
  assert.equal(subject.continue_node, '乙');
});

/* ── 锚点四态 ─────────────────────────────────────────────────────────── */

const ANCHOR_MD = [
  '# 锚点',
  '',
  '::: quiz 理解 锚点：精确命中',
  ':::',
  '',
  '::: quiz 改造 锚点：只差  空白',
  ':::',
  '',
  '::: quiz 排错 锚点：多  匹配',
  ':::',
  '',
  '::: quiz 应用 锚点：查无此锚',
  ':::',
  '',
  '::: quiz 理解 锚点：多匹配',
  ':::',
  '',
  '::: quiz 理解 锚点：两边空白',
  ':::',
  '',
].join('\n');

const ANCHOR_POOL = {
  '精确命中': [{ q: '精确', answer: 'a', criteria: 'c' }],
  '只差 空白': [{ q: '只差', answer: 'a', criteria: 'c' }],
  '多 匹配': [{ q: '多', answer: 'a', criteria: 'c' }],
  多匹配: [{ q: '多2', answer: 'a', criteria: 'c' }],
  ' 两边空白 ': [{ q: '空白', answer: 'a', criteria: 'c' }],
  没人声明: [{ q: '孤儿', answer: 'a', criteria: 'c' }],
};

function anchorWorkspace() {
  return makeWorkspace(subjectTree('demo', {
    'subject.yaml': 'slug: demo\nname: 锚点\n',
    'curriculum.yaml': 'nodes:\n  - id: 变量\n    title: 变量\n',
    'lessons/1-变量.md': ANCHOR_MD,
    'lessons/1-变量.quiz.json': ANCHOR_POOL,
  }));
}

test('锚点四态各有结论，多匹配绝不静默取第一个', () => {
  const { workspace } = anchorWorkspace();
  const [subject] = readLibrary({ workspace }).subjects;
  const anchors = subject.nodes[0].anchors;

  // 键在题库里的行号由 lib/core/anchors.ts 按 **JSON 的真实位置**算；这里的题库是
  // 手写常量，没有原文可查，所以行号统一兜底成 1。逐字相等的那几条用 candidates 带上
  // 候选键的行号与题数——读端想显示「题库：<键>（N 题）」就有得显示。
  assert.deepEqual(anchors, [
    // 逐字命中题库键 → resolved
    { text: '精确命中', level: '理解', line: 3, resolution: 'resolved', keys: ['精确命中'],
      candidates: [{ key: '精确命中', line: 1, count: 1 }] },
    // 只差空白、且题库里只有一个候选 → stale（题库改过词，正文还没跟上）
    { text: '只差  空白', level: '改造', line: 6, resolution: 'stale', keys: ['只差 空白'],
      candidates: [{ key: '只差 空白', line: 1, count: 1 }] },
    // 归一化后有两个候选 → ambiguous，两个都报出来，让界面去问人
    { text: '多  匹配', level: '排错', line: 9, resolution: 'ambiguous', keys: ['多 匹配', '多匹配'],
      candidates: [{ key: '多 匹配', line: 1, count: 1 }, { key: '多匹配', line: 1, count: 1 }] },
    // 题库里根本没有 → missing
    { text: '查无此锚', level: '应用', line: 12, resolution: 'missing', keys: [], candidates: [] },
    // 逐字命中优先于归一化：条文相同就是 resolved，即使归一化后会有歧义
    { text: '多匹配', level: '理解', line: 15, resolution: 'resolved', keys: ['多匹配'],
      candidates: [{ key: '多匹配', line: 1, count: 1 }] },
    // 题库键首尾的空白不算差异（两边都过 Python 的 strip）
    { text: '两边空白', level: '理解', line: 18, resolution: 'resolved', keys: [' 两边空白 '],
      candidates: [{ key: ' 两边空白 ', line: 1, count: 1 }] },
  ]);

  const ambiguous = anchors.find((anchor) => anchor.resolution === 'ambiguous');
  assert.equal(ambiguous.keys.length, 2, 'ambiguous 要把所有候选都报出来，不能只留第一个');
});

test('正文里没声明的题库键进 orphan_keys，顺序按码位', () => {
  const { workspace } = anchorWorkspace();
  const [subject] = readLibrary({ workspace }).subjects;
  assert.deepEqual(subject.nodes[0].orphan_keys, ['没人声明']);
  // orphans 与它同源，另带题数——这是收编前**没有任何消费方**的那份结论
  assert.deepEqual(subject.nodes[0].orphans, [{ key: '没人声明', line: 1, count: 1 }]);
});

/* ── 坏数据当场抛错 ───────────────────────────────────────────────────── */

test('大纲与题库的坏数据当场抛错，不静默降级成空值', () => {
  const badNodes = makeWorkspace(subjectTree('demo', {
    'subject.yaml': 'slug: demo\nname: 坏大纲\n',
    'curriculum.yaml': 'nodes: 不是列表\n',
  }));
  assert.throws(() => readLibrary({ workspace: badNodes.workspace }), /nodes 不是列表/);

  const badPool = makeWorkspace(subjectTree('demo', {
    'subject.yaml': 'slug: demo\nname: 坏题库\n',
    'curriculum.yaml': 'nodes:\n  - id: 变量\n    title: 变量\n',
    'lessons/1-变量.md': '# 变量\n',
    'lessons/1-变量.quiz.json': '{ 这不是 JSON',
  }));
  assert.throws(() => readLibrary({ workspace: badPool.workspace }), /题库不是合法 JSON/);

  const badEdge = makeWorkspace(subjectTree('demo', {
    'subject.yaml': 'slug: demo\nname: 坏边\n',
    'curriculum.yaml': [
      'nodes:',
      '  - id: 变量',
      '    title: 变量',
      'edges:',
      '  - from: 变量',
      '',
    ].join('\n'),
  }));
  assert.throws(() => readLibrary({ workspace: badEdge.workspace }), /缺少 from\/to/);
});

test('缺失的可选文件一律给空值，不让整份 payload 崩掉', () => {
  const { workspace } = makeWorkspace(subjectTree('demo', {
    'subject.yaml': 'slug: demo\nname: 只有大纲\n',
    'curriculum.yaml': 'nodes:\n  - id: 变量\n    title: 变量\n',
  }));
  const [subject] = readLibrary({ workspace }).subjects;

  assert.equal(subject.name, '只有大纲');
  assert.equal(subject.created_at, '');
  assert.equal(subject.updated_at, '');
  assert.equal(subject.project, '');
  assert.deepEqual(subject.mission, { title: '', sections: {} });
  assert.deepEqual(subject.glossary, []);
  assert.equal(subject.resources_md, '');
  assert.deepEqual(subject.reference, []);
  assert.match(subject.reference_version, /^[0-9a-f]{16}$/, '空目录也要有版本号，不能是空串');
  assert.deepEqual(subject.records, []);
  assert.equal(subject.nodes[0].lesson_md, '');
  assert.equal(subject.nodes[0].lesson, '');
  assert.equal(subject.nodes[0].number, '');
  assert.equal(subject.nodes[0].lab, null);
  assert.deepEqual(subject.nodes[0].anchors, []);
  assert.deepEqual(subject.nodes[0].orphan_keys, []);
  assert.deepEqual(subject.nodes[0].pool, {});
});
