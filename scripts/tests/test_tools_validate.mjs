/* StudyMate 原生工具 · **四个校验器**（`lib/tools/validate.ts`）
   ────────────────────────────────────────────────────────────────────────
   验收面是「逐条问题（文件 + 行号 + 是否阻断）+ 一句明确结论」，不是 exit code。
   所以每条造坏都断言三件事：结论是阻断、**具体那一条**在列表里、行号指向真位置。

   四个工具替掉的四份现行口径：`check_curriculum.py`（外加 progress/subject 两份数据文件）、
   `check_lesson.py` 的**内容部分**（DOM 检查随静态渲染退役）、`check_pool.py`（行为移植）、
   `check_handoff.py`。夹具在 `fixtures/tools.mjs`，工作区现造现弃。 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { assertOutput, execute, fakeContext, loadTools, useHome, writeSubject } from './fixtures/tools.mjs';

const tools = await loadTools();

function withTools(t, options = {}) {
  const home = useHome(t);
  const subject = writeSubject(home.workspace, 'demo', options);
  const ctx = fakeContext();
  tools.registerValidatorTools(ctx.ctx);
  return { ...home, subject, ctx };
}

function messages(report) {
  return report.problems.map((problem) => `${problem.file}:${problem.line} ${problem.message}`);
}

function find(report, needle) {
  return report.problems.find((problem) => problem.message.includes(needle));
}

async function call(ctx, name, args) {
  const definition = ctx.definitions.get(name);
  const value = await execute(ctx, name, args);
  await assertOutput(assert, definition, value);
  return value;
}

/* ── 一、studymate_validate_curriculum：数据层三份文件 ─────────────────── */

test('科目目录一次校验三份数据文件；干净的夹具放行', async (t) => {
  const f = withTools(t);
  const value = await call(f.ctx, 'studymate_validate_curriculum', { paths: ['demo'] });
  assert.equal(value.blocking, false, messages(value.reports[0]));
  assert.deepEqual(value.reports.map((report) => report.kind), ['curriculum', 'progress', 'subject']);
  assert.match(value.summary, /放行/);
});

test('大纲造坏：id 重复、引用不存在的节点、依赖倒挂、环 —— 逐条带行号且阻断', async (t) => {
  const home = useHome(t);
  writeSubject(home.workspace, 'demo', {
    curriculum: [
      'nodes:',
      '  - id: var',
      '    title: 变量',
      '    kind: 概念',
      '    status: 未开始',
      '    objective: 懂变量',
      '    prerequisites: [fn]',      // 5：依赖排在后面的节点（倒挂）
      '  - id: var',                   // 7：id 重复
      '    title: 又一个变量',
      '    kind: 概念',
      '    status: 未开始',
      '    objective: 懂变量',
      '    prerequisites: [nope]',     // 12：引用不存在的节点
      '  - id: fn',
      '    title: 函数',
      '    kind: 概念',
      '    status: 未开始',
      '    objective: 懂函数',
      '    prerequisites: [var]',
      'edges: []',
      '',
    ].join('\n'),
  });
  const ctx = fakeContext();
  tools.registerValidatorTools(ctx.ctx);
  const value = await call(ctx, 'studymate_validate_curriculum', { paths: ['demo/curriculum.yaml'] });
  assert.equal(value.blocking, true);
  const report = value.reports[0];
  assert.equal(report.kind, 'curriculum');
  assert.equal(report.blockingCount > 0, true);
  const lines = report.problems.map((problem) => problem.line);
  assert.ok(lines.some((line) => line >= 5 && line <= 20), `行号要落在真位置：${lines.join(',')}`);
  assert.ok(find(report, 'var'), messages(report).join('\n'));
  assert.ok(report.problems.every((problem) => typeof problem.file === 'string' && problem.file !== ''));
  assert.ok(report.problems.some((problem) => problem.blocking));
  assert.match(report.summary, /阻断/);
});

test('YAML 解不开 → 一条带行号的阻断问题（不抛异常）', async (t) => {
  const home = useHome(t);
  const subject = writeSubject(home.workspace, 'demo');
  fs.writeFileSync(path.join(subject.dir, 'curriculum.yaml'), 'nodes: [\n  - id: var\n');
  const ctx = fakeContext();
  tools.registerValidatorTools(ctx.ctx);
  const value = await call(ctx, 'studymate_validate_curriculum', { paths: ['demo'] });
  assert.equal(value.blocking, true);
  const report = value.reports.find((entry) => entry.kind === 'curriculum');
  assert.ok(find(report, 'YAML 解不开'), messages(report).join('\n'));
});

test('进度校验接上同一科目的节点 id（引用完整性）；缺文件也逐条报', async (t) => {
  const home = useHome(t);
  const subject = writeSubject(home.workspace, 'demo');
  fs.writeFileSync(path.join(subject.dir, 'progress.yaml'), [
    'updated_at: 2026-05-06T10:00:00+08:00',
    'nodes:',
    '  var:',
    '    status: 未开始',
    '    mastery: 0',
    '  ghost:',
    '    status: 未开始',
    '    mastery: 0',
    'misconceptions: []',
    'project:',
    '  current: var',
    '',
  ].join('\n'));
  const ctx = fakeContext();
  tools.registerValidatorTools(ctx.ctx);
  const value = await call(ctx, 'studymate_validate_curriculum', { paths: ['demo'] });
  const progress = value.reports.find((entry) => entry.kind === 'progress');
  assert.ok(find(progress, 'ghost'), messages(progress).join('\n'));
  assert.equal(progress.blocking, true);

  const missing = await call(ctx, 'studymate_validate_curriculum',
    { paths: ['demo/does-not-exist.yaml'] });
  assert.equal(missing.blocking, true);
  assert.match(missing.reports[0].summary, /阻断/);
});

/* ── 二、studymate_validate_lesson：内容格式 + 锚点四态 + 图片 ─────────── */

test('干净的课件放行，并给出锚点四态（resolved）', async (t) => {
  const f = withTools(t);
  const value = await call(f.ctx, 'studymate_validate_lesson', { paths: ['demo/lessons/0001-var.md'] });
  const report = value.reports[0];
  assert.equal(value.blocking, false, messages(report).join('\n'));
  assert.equal(report.poolPresent, true);
  assert.deepEqual(report.anchors.map((anchor) => anchor.resolution), ['resolved']);
  assert.deepEqual(report.orphans, []);
  assert.deepEqual(report.node, { id: 'var', title: '变量', number: '0001' });
});

test('造坏：锚点没题、题库多余键、title 与大纲不一致、图片不存在 —— 逐条带行号', async (t) => {
  const home = useHome(t);
  const subject = writeSubject(home.workspace, 'demo', {
    lesson: [
      '---',
      'title: 变量（与大纲不一致）',     // 2：title 与 curriculum 不一致
      'goal: 一句话。',
      '---',
      '',
      '::: figure ../assets/img/pool/missing-变量-赋值-wiki-01.png',   // 6：图片不存在
      ':::',
      '',
      '::: quiz 理解 锚点：没有题的锚点',   // 9：题库里没有这个键
      ':::',
      '',
      '::: quiz 理解 锚点：什么是变量',     // 12：题库里有题（对账通过）
      ':::',
      '',
    ].join('\n'),
    pool: JSON.stringify({
      什么是变量: [{ q: '题面' }],
      没人引用的锚点: [{ q: '孤儿题' }],
    }, null, 2),
  });
  void subject;
  const ctx = fakeContext();
  tools.registerValidatorTools(ctx.ctx);
  const value = await call(ctx, 'studymate_validate_lesson', { paths: ['demo'] });
  const report = value.reports[0];
  assert.equal(value.blocking, true);
  const all = messages(report).join('\n');
  assert.ok(find(report, '图片文件不存在'), all);
  assert.equal(find(report, '图片文件不存在').line, 6);
  assert.ok(find(report, '没有题'), all);
  assert.equal(find(report, '没有题').line, 9);
  assert.ok(find(report, 'title'), all);
  assert.equal(find(report, 'title').line, 2);
  assert.ok(find(report, '没人引用的锚点'), all);
  assert.deepEqual(report.orphans.map((orphan) => orphan.key), ['没人引用的锚点']);
  assert.deepEqual(report.anchors.map((anchor) => anchor.resolution), ['missing', 'resolved']);
});

test('题库坏 JSON / 顶层不是对象 —— 各报一条，不当成崩溃', async (t) => {
  const home = useHome(t);
  const subject = writeSubject(home.workspace, 'demo', { pool: '{ "什么是变量": [ ' });
  const ctx = fakeContext();
  tools.registerValidatorTools(ctx.ctx);
  let value = await call(ctx, 'studymate_validate_lesson', { paths: ['demo/lessons/0001-var.md'] });
  assert.ok(find(value.reports[0], '题库不是合法 JSON'), messages(value.reports[0]).join('\n'));

  fs.writeFileSync(path.join(subject.lessonsDir, '0001-var.quiz.json'), '[]\n');
  value = await call(ctx, 'studymate_validate_lesson', { paths: ['demo/lessons/0001-var.md'] });
  assert.ok(find(value.reports[0], '最外层是对象'), messages(value.reports[0]).join('\n'));
});

test('科目目录一次校验目录下每一课；文件不存在报一条阻断', async (t) => {
  const f = withTools(t);
  const value = await call(f.ctx, 'studymate_validate_lesson', { paths: ['demo/lessons'] });
  assert.equal(value.reports.length, 2, '两课都查');
  const missing = await call(f.ctx, 'studymate_validate_lesson', { paths: ['demo/lessons/0009-nope.md'] });
  assert.equal(missing.blocking, true);
  assert.match(missing.reports[0].problems[0].message, /不存在/);
});

/* ── 三、studymate_validate_pool：图片库索引（check_pool.py 的行为移植） ── */

function writePoolIndex(subject, text, files = {}) {
  const dir = path.join(subject.dir, 'assets', 'img', 'pool');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(subject.dir, 'assets', 'img', 'pool.md'), text);
  for (const [name, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 0x61));
  }
  return dir;
}

const POOL_HEADER = '| 文件 | 主题标签 | 一句话说明 | 来源 URL | 许可 | 尺寸 | 抓取日期 |\n|---|---|---|---|---|---|---|';

test('图片库干净放行；空图片库（只有表头）也算合格', async (t) => {
  const f = withTools(t);
  writePoolIndex(f.subject, `${POOL_HEADER}\n| demo-变量-赋值-wiki-01.png | 变量 | 赋值 | https://example.com | CC0 | 100×100 | 2026-05-01 |\n`,
    { 'demo-变量-赋值-wiki-01.png': 1024 });
  let value = await call(f.ctx, 'studymate_validate_pool', { paths: ['demo'] });
  assert.equal(value.blocking, false, messages(value.reports[0]).join('\n'));
  assert.equal(value.reports[0].rows, 1);

  writePoolIndex(f.subject, `${POOL_HEADER}\n`, {});
  value = await call(f.ctx, 'studymate_validate_pool', { paths: ['demo'] });
  assert.equal(value.blocking, false, messages(value.reports[0]).join('\n'));
  assert.equal(value.reports[0].rows, 0);
});

test('索引缺失 / 索引写错地方 / 缺列 / 表头不一致 —— 逐条报且阻断', async (t) => {
  const f = withTools(t);
  let value = await call(f.ctx, 'studymate_validate_pool', { paths: ['demo'] });
  assert.equal(value.blocking, true);
  assert.ok(find(value.reports[0], '索引不存在'), messages(value.reports[0]).join('\n'));

  // 索引写错地方：pool.md 落在图片库目录里
  const dir = writePoolIndex(f.subject, `${POOL_HEADER}\n`, {});
  fs.rmSync(path.join(f.subject.dir, 'assets', 'img', 'pool.md'));
  fs.writeFileSync(path.join(dir, 'pool.md'), `${POOL_HEADER}\n`);
  value = await call(f.ctx, 'studymate_validate_pool', { paths: ['demo'] });
  assert.ok(find(value.reports[0], '索引写错了地方'), messages(value.reports[0]).join('\n'));
  fs.rmSync(path.join(dir, 'pool.md'));

  writePoolIndex(f.subject, '| 文件 | 主题标签 |\n|---|---|\n');
  value = await call(f.ctx, 'studymate_validate_pool', { paths: ['demo'] });
  assert.ok(find(value.reports[0], '索引缺列'), messages(value.reports[0]).join('\n'));

  writePoolIndex(f.subject, '| 主题标签 | 文件 | 一句话说明 | 来源 URL | 许可 | 尺寸 | 抓取日期 |\n|---|---|---|---|---|---|---|\n');
  value = await call(f.ctx, 'studymate_validate_pool', { paths: ['demo'] });
  assert.ok(find(value.reports[0], '表头与固定表头不一致'), messages(value.reports[0]).join('\n'));
});

test('逐行五条：文件缺失、命名不合规、三列空、日期坏、超体积', async (t) => {
  const f = withTools(t);
  writePoolIndex(f.subject, [
    POOL_HEADER,
    '| demo-变量-赋值-wiki-01.png | 变量 | 有 | https://example.com | CC0 | 1×1 | 2026-05-01 |',
    '| 不存在的文件.png | 变量 | 缺 | https://example.com | CC0 | 1×1 | 2026-05-01 |',
    '| 有空格 的名字.png | 变量 | 命名 | https://example.com | CC0 | 1×1 | 2026-05-01 |',
    '| demo-变量-赋值-wiki-02.png | 变量 | 空列 |  |  |  |  |',
    '| demo-变量-赋值-wiki-03.png | 变量 | 日期 | https://example.com | CC0 | 1×1 | 2026-02-30 |',
    '| demo-变量-赋值-wiki-04.png | 变量 | 大 | https://example.com | CC0 | 1×1 | 2026-05-01 |',
    '',
  ].join('\n'), {
    'demo-变量-赋值-wiki-01.png': 1024,
    'demo-变量-赋值-wiki-02.png': 1024,
    'demo-变量-赋值-wiki-03.png': 1024,
    'demo-变量-赋值-wiki-04.png': 500 * 1024 + 1,
  });
  const value = await call(f.ctx, 'studymate_validate_pool', { paths: ['demo'] });
  const report = value.reports[0];
  assert.equal(value.blocking, true);
  assert.equal(report.rows, 6);
  const all = messages(report).join('\n');
  assert.ok(find(report, '文件缺失'), all);
  assert.equal(find(report, '文件缺失').line, 4);
  assert.ok(find(report, '文件名不合规'), all);
  assert.ok(find(report, '`来源 URL` 为空'), all);
  assert.ok(find(report, '`许可` 为空'), all);
  assert.ok(find(report, '`抓取日期` 为空'), all);
  assert.ok(find(report, '有效的 YYYY-MM-DD'), all);
  assert.ok(find(report, '超体积'), all);
  assert.equal(find(report, '超体积').line, 8);
  assert.ok(report.problems.every((problem) => problem.file.endsWith('pool.md')));
});

/* ── 四、studymate_validate_handoff：明确的放行 / 阻断结论 ─────────────── */

function makeStage(root, { manifest, files = {} }) {
  fs.mkdirSync(path.join(root, 'deliver'), { recursive: true });
  fs.writeFileSync(path.join(root, 'handoff.json'), manifest);
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, 'deliver', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

function manifestOf(overrides = {}) {
  return JSON.stringify({
    schema_version: 1,
    role: 'curriculum-designer',
    subject: 'demo',
    node_id: null,
    status: 'succeeded',
    outputs: [{ path: 'curriculum.yaml', kind: 'file' }],
    checks: [{ name: 'check_curriculum.py', status: 'passed' }],
    gaps: [],
    ...overrides,
  }, null, 2);
}

test('交接门禁：边界合法 → 明确放行', async (t) => {
  const home = useHome(t);
  const stage = makeStage(path.join(home.workspace, '.stage', 'curriculum-designer-demo'),
    { manifest: manifestOf(), files: { 'curriculum.yaml': 'nodes: []\n' } });
  const ctx = fakeContext();
  tools.registerValidatorTools(ctx.ctx);
  const value = await call(ctx, 'studymate_validate_handoff',
    { stage, role: 'curriculum-designer' });
  assert.equal(value.verdict, 'pass');
  assert.equal(value.blocking, false);
  assert.match(value.summary, /放行/);
  assert.equal(value.outputs, 1);
});

test('交接门禁：角色错配 / 未声明产物 → 明确阻断，且说清不搬不删', async (t) => {
  const home = useHome(t);
  const stage = makeStage(path.join(home.workspace, '.stage', 'curriculum-designer-demo'), {
    manifest: manifestOf({ role: 'lesson-coach' }),
    files: { 'curriculum.yaml': 'nodes: []\n', '顺手文件.md': '多出来的' },
  });
  const ctx = fakeContext();
  tools.registerValidatorTools(ctx.ctx);
  const value = await call(ctx, 'studymate_validate_handoff',
    { stage, role: 'curriculum-designer' });
  assert.equal(value.verdict, 'block');
  assert.equal(value.blocking, true);
  const all = messages(value).join('\n');
  assert.match(all, /角色错配/);
  assert.match(all, /未声明产物/);
  assert.match(value.summary, /阻断/);
  assert.match(value.summary, /不复制、不删 stage/);
});
