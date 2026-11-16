/* StudyMate 原生工具 · **工作区摘要**（`lib/tools/{context,vault}.ts`）
   ────────────────────────────────────────────────────────────────────────
   三件事：

   1. `studymate_workspace_context` 的返回是**结构化摘要**（工作区路径、今天、科目清单含
      当前节点与三档状态、最近学习记录、可用能力）——总控开场那一次调用拿到的就是这个，
      不是 exit code、不是一堆要自己拼的文件。
   2. 逐域投影**真的**把别的域摘掉了：`subjects` 的切片里没有题库、没有课件正文。
      否则「声明了 subjects」的工具顺着节点就能读到 pool，guard 就成了摆设。
   3. **摘要文本**（`output.render`，模型真正读到的那段）要与 `description` / 技能口径一致：
      带共享记忆的画像三节、`积累` 一个字都不带、超预算截断并注明、没有记忆时不留空段。
      返回值过 schema 只是契约的一半——只验返回值会漏掉「模型什么也看不到」。

   工作区在临时目录里现造现弃（ADR-0009）。 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAccess } from '../../lib/host/access.ts';
import { createWorkspaceVault } from '../../lib/host/vault.ts';
import { MEMORY_RENDER_BUDGET } from '../../lib/tools/context.ts';
import { assertOutput, execute, fakeContext, loadTools, useHome, writeSubject } from './fixtures/tools.mjs';

const tools = await loadTools();

function withTools(t, options = {}) {
  const home = useHome(t);
  const { dir, lessonsDir } = writeSubject(home.workspace, 'demo', options);
  const ctx = fakeContext(options.llm === undefined ? {} : { llm: options.llm });
  tools.registerContextTools(ctx.ctx);
  return { ...home, dir, lessonsDir, ctx };
}

/** 摘要**文本**：`output.render` 的产物才是模型看到的东西（返回值过 schema 只是另一半）。 */
function renderSummary(ctx, value) {
  const definition = ctx.definitions.get('studymate_workspace_context');
  return definition.output.render({}, value).map((block) => block.text).join('\n');
}

/* ── 一、结构化摘要 ───────────────────────────────────────────────────── */

/** 一份像样的共享记忆（#190）：画像三节里有内容的那两节 + 一条 `积累`。
    `fish 脾气` 在三节里一次都不出现——否定断言不会因为共用词而假阳性。 */
const MEMORY_YAML = [
  '我是谁:',
  '  现有技能: [终端]',
  '',
  '教学偏好:',
  '  有效的讲法: []',
  '',
  '学习习惯:',
  '  常见卡点: 喜欢动手试。',
  '',
  '积累:',
  '  fish 脾气: 这台机器上 fish 不吃双横线。',
  '',
].join('\n');

/** `memory.markdown` 的期望值**手写**：画像三节里**有内容**的那两节，按白名单顺序原样接起来。 */
const MEMORY_PROJECTION = [
  '我是谁:',
  '  现有技能: [终端]',
  '',
  '学习习惯:',
  '  常见卡点: 喜欢动手试。',
].join('\n');

test('开场一次调用拿到：工作区路径、今天、科目现状（当前节点 + 三档）、记录与能力', async (t) => {
  const f = withTools(t);
  fs.writeFileSync(path.join(f.workspace, '.learning', 'MEMORY.yaml'), MEMORY_YAML);
  fs.writeFileSync(path.join(f.dir, 'learning-records', '2026-05-06-变量.md'),
    '# 变量这一课\n\n- 日期：2026-05-06\n\n学会了。\n');

  const value = await execute(f.ctx, 'studymate_workspace_context', {});
  await assertOutput(assert, f.ctx.definitions.get('studymate_workspace_context'), value);

  assert.equal(value.workspace.path, f.workspace);
  assert.equal(value.workspace.ready, true);
  assert.match(value.workspace.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof value.workspace.timeZone, 'string');
  assert.ok(value.workspace.timeZone.length > 0);

  assert.equal(value.subjects.length, 1);
  const subject = value.subjects[0];
  assert.equal(subject.slug, 'demo');
  assert.equal(subject.name, '演示科目');
  assert.deepEqual(subject.nodes.map((node) => node.id), ['var', 'fn']);
  assert.deepEqual(subject.nodes.map((node) => node.number), ['0001', '0002']);
  assert.deepEqual(subject.nodes.map((node) => node.lesson), ['0001-var.md', '0002-fn.md']);
  // 「继续学」的挑选顺序与 lib/library.ts 同口径：学习中的第一个 → 第一个未开始的 → 最后一个
  assert.equal(subject.current.id, 'var', '两个节点都未开始时，当前节点是第一个未开始的');
  assert.deepEqual(subject.tierCounts, { 未开始: 2, 学习中: 0, 已学完: 0 });
  assert.equal(subject.recentRecords.length, 1);
  assert.equal(subject.recentRecords[0].title, '变量这一课');
  assert.match(subject.recentRecords[0].markdown, /学会了/);

  assert.equal(value.memory.present, true);
  // #190：`markdown` 是**画像三节**的投影，不是整份文件——总控开场那一次调用拿到的就是它
  assert.equal(value.memory.markdown, MEMORY_PROJECTION);
  for (const fragment of ['积累', 'fish 脾气', '不吃双横线']) {
    assert.equal(value.memory.markdown.includes(fragment), false,
      `摘要里出现了「${fragment}」：${value.memory.markdown}`);
  }
  // #189：回报的路径要以新名结尾，不是只「读到了内容」——总控照着这个路径去读盘
  assert.match(value.memory.file, /[\\/]\.learning[\\/]MEMORY\.yaml$/);
  assert.equal(value.capabilities.model.available, false);
  assert.deepEqual(value.notes, []);
});

test('#190 摘要：记忆里没有画像内容（只有 `积累`）时 `markdown` 是空串，`present` 照实为 true', async (t) => {
  const f = withTools(t);
  fs.writeFileSync(path.join(f.workspace, '.learning', 'MEMORY.yaml'),
    ['积累:', '  fish 脾气: 这台机器上 fish 不吃双横线。', ''].join('\n'));

  const value = await execute(f.ctx, 'studymate_workspace_context', {});
  await assertOutput(assert, f.ctx.definitions.get('studymate_workspace_context'), value);
  assert.equal(value.memory.present, true, '文件在盘上，`present` 就该是 true');
  assert.equal(value.memory.markdown, '', '`积累` 不是可注入的内容，投影是空的');
  assert.match(value.memory.file, /[\\/]\.learning[\\/]MEMORY\.yaml$/);
});

/** 旧格式（2.0.x 前，`##` 分节 + bullet）的共享记忆：2.0.4 审计后读侧补了兜底。
    内容与 `MEMORY_YAML` 的画像节同一份，转成新格式后投影应当一致。 */
const LEGACY_MEMORY_MD = [
  '## 我是谁',
  '- 现有技能：终端',
  '',
  '## 学习习惯',
  '- 常见卡点：喜欢动手试。',
  '',
  '## 积累',
  '- fish 脾气：这台机器上 fish 不吃双横线。',
  '',
].join('\n');

/** 旧格式兜底后的投影（与新格式里那两节的内容一致）。 */
const LEGACY_MEMORY_PROJECTION = [
  '我是谁:',
  '  现有技能: 终端',
  '',
  '学习习惯:',
  '  常见卡点: 喜欢动手试。',
].join('\n');

test('2.0.4 迁移期 摘要：只有旧名那份文件时照读画像三节，并在 notes 里给出迁移提示', async (t) => {
  const f = withTools(t);
  fs.writeFileSync(path.join(f.workspace, '.learning', 'MEMORY.md'), LEGACY_MEMORY_MD);

  const value = await execute(f.ctx, 'studymate_workspace_context', {});
  await assertOutput(assert, f.ctx.definitions.get('studymate_workspace_context'), value);

  assert.equal(value.memory.present, true, '旧文件在盘上，`present` 照实为 true');
  assert.equal(value.memory.markdown, LEGACY_MEMORY_PROJECTION, '旧格式的画像三节要按同一份投影给出');
  assert.match(value.memory.file, /[\\/]\.learning[\\/]MEMORY\.md$/, '回报实际读到的旧文件路径');
  for (const fragment of ['积累', 'fish 脾气', '不吃双横线']) {
    assert.equal(value.memory.markdown.includes(fragment), false,
      `摘要里出现了「${fragment}」：${value.memory.markdown}`);
  }
  // 总控开场唯一能看到「请迁移」的地方：notes 里要有旧格式提示 + 迁移命令
  const note = value.notes.find((one) => one.includes('旧格式'));
  assert.ok(note, `notes 里缺迁移提示：${JSON.stringify(value.notes)}`);
  assert.match(note, /migrate/);
});

test('2.0.4 迁移期 摘要：旧文件没有 `##` 分节时明说读不出来，不说内容不丢', async (t) => {
  const f = withTools(t);
  fs.writeFileSync(path.join(f.workspace, '.learning', 'MEMORY.md'), '只有一段散文，没有 `##` 分节。\n');

  const value = await execute(f.ctx, 'studymate_workspace_context', {});
  await assertOutput(assert, f.ctx.definitions.get('studymate_workspace_context'), value);

  assert.equal(value.memory.present, true, '旧文件在盘上，`present` 照实为 true');
  assert.equal(value.memory.markdown, '', '读不出来：注入是空串');
  const note = value.notes.find((one) => one.includes('旧格式'));
  assert.ok(note, `notes 里缺旧格式提示：${JSON.stringify(value.notes)}`);
  assert.match(note, /读不出来/, '要说明读不出来，别让学生以为已经在上下文里');
  assert.equal(note.includes('内容不丢'), false, '这种盘面下「内容不丢」是错的');
});

/** #191 科目记忆：只对这门课成立的做法与事实（科目目录下那份）。用词在共享记忆里一次都不
    出现——否定断言不会因为共用词而假阳性。 */
const SUBJECT_MEMORY_YAML = [
  '# 科目记忆 —— 只对这门课成立的做法与事实。',
  '#',
  '积累:',
  '  演示环境: 这门课的 lab 要在 /tmp/lab-probe 下跑。',
  '',
].join('\n');

test('#191 摘要：科目记忆一个字都不进摘要（盘上那份带内容的科目记忆是活的）', async (t) => {
  const f = withTools(t, { subjectMemory: SUBJECT_MEMORY_YAML });
  fs.writeFileSync(path.join(f.workspace, '.learning', 'MEMORY.yaml'), MEMORY_YAML);
  // 正面：盘上真有一份**带内容**的科目记忆——不然这条否定断言只是「文件不存在」
  assert.match(fs.readFileSync(path.join(f.dir, 'MEMORY.yaml'), 'utf8'), /lab-probe/,
    '夹具要真的把科目记忆写进科目目录');

  const value = await execute(f.ctx, 'studymate_workspace_context', {});
  await assertOutput(assert, f.ctx.definitions.get('studymate_workspace_context'), value);

  // 摘要的**每一个字段**都不许带上科目记忆：`memory.markdown` 是共享记忆画像三节的投影，
  // 科目现状那一份也不该把科目记忆读进上下文
  const dump = JSON.stringify(value);
  for (const fragment of ['科目记忆', '演示环境', '/tmp/lab-probe']) {
    assert.equal(dump.includes(fragment), false, `摘要里出现了科目记忆的「${fragment}」：${dump}`);
  }
  assert.equal(value.memory.markdown, MEMORY_PROJECTION, '共享记忆的画像三节照旧');
});

/* ── 一之二、摘要文本（`output.render`）：模型读到的才是摘要 ─────────────── */

test('摘要文本：共享记忆的画像三节进 render，`积累` 一个字都不进', async (t) => {
  const f = withTools(t);
  fs.writeFileSync(path.join(f.workspace, '.learning', 'MEMORY.yaml'), MEMORY_YAML);

  const value = await execute(f.ctx, 'studymate_workspace_context', {});
  const text = renderSummary(f.ctx, value);

  // 正面对照：盘上那份记忆真的带画像内容，也真的带一条 `积累`——下面的否定断言不会空转
  const onDisk = fs.readFileSync(path.join(f.workspace, '.learning', 'MEMORY.yaml'), 'utf8');
  assert.match(onDisk, /现有技能: \[终端\]/, '夹具里那一节画像要真的存在');
  assert.match(onDisk, /fish 脾气/, '夹具里那一条 `积累` 要真的存在');

  // 有内容的两节 + 条目原文都进文本（空骨架的「教学偏好」不占一行：投影只带有内容的节）
  for (const fragment of ['共享记忆的画像三节：', '我是谁:', '现有技能: [终端]',
    '学习习惯:', '常见卡点: 喜欢动手试。']) {
    assert.ok(text.includes(fragment), `摘要文本里没有「${fragment}」：\n${text}`);
  }
  assert.equal(text.includes('教学偏好'), false, '空骨架的节不该出现在投影/摘要里');

  // #190：`积累` 永不进上下文——键、内容、来源词一个都不许出现
  for (const fragment of ['积累', 'fish 脾气', '不吃双横线']) {
    assert.equal(text.includes(fragment), false, `摘要文本里出现了「${fragment}」：\n${text}`);
  }
  // 没有空段：实体行之间最多只有「画像前那一行空行」
  assert.equal(text.includes('\n\n\n'), false, `不许出现连续空行：\n${text}`);
  assert.ok(text.startsWith('工作区：'));
  assert.equal(text.endsWith('\n'), false);
});

test('摘要文本：文件在、但画像一条都没有（只有 `积累`）时，记忆一段都不出现', async (t) => {
  const f = withTools(t);
  fs.writeFileSync(path.join(f.workspace, '.learning', 'MEMORY.yaml'),
    ['积累:', '  fish 脾气: 这台机器上 fish 不吃双横线。', ''].join('\n'));

  const value = await execute(f.ctx, 'studymate_workspace_context', {});
  assert.equal(value.memory.present, true, '文件在盘上，`present` 就该是 true');
  const text = renderSummary(f.ctx, value);
  assert.equal(text.includes('共享记忆'), false, `画像为空时不该留标题：\n${text}`);
  assert.equal(text.includes('fish 脾气'), false);
  assert.equal(text.includes('\n\n'), false, `画像为空时不该留空行：\n${text}`);
  assert.equal(text.endsWith('\n'), false);
});

test('摘要文本：画像超预算就截断，注明「已截断」并给完整路径；返回值本身不截', async (t) => {
  // 预算是「模型这次看到多少」，不是可以随手放宽的排版参数：放宽会让整份摘要更容易撞上
  // 宿主那条 8192 字符的静默裁剪（references/tools.md）。改数字之前先量清楚。
  assert.equal(MEMORY_RENDER_BUDGET, 2048);
  const f = withTools(t);
  const long = `学习习惯:\n  常见卡点: ${'长'.repeat(MEMORY_RENDER_BUDGET + 500)}`;
  fs.writeFileSync(path.join(f.workspace, '.learning', 'MEMORY.yaml'), long);

  const value = await execute(f.ctx, 'studymate_workspace_context', {});
  await assertOutput(assert, f.ctx.definitions.get('studymate_workspace_context'), value);
  // 宿主契约照旧：截断只发生在给模型看的文本里，结构化返回值里的 markdown 是完整投影
  assert.ok([...value.memory.markdown].length > MEMORY_RENDER_BUDGET,
    '结构化返回值里的 markdown 不该被截断');

  const text = renderSummary(f.ctx, value);
  assert.ok(text.includes('已截断'), `超预算必须注明「已截断」：\n${text.slice(-300)}`);
  assert.ok(text.includes('完整原文见'), '截断时要给出完整原文的路径提示');
  assert.ok(text.includes(value.memory.file), '提示里要是那份记忆文件的路径');

  const heading = '共享记忆的画像三节：';
  const headingAt = text.indexOf(heading);
  assert.ok(headingAt >= 0, '超预算时标题照旧出现');
  const noteAt = text.indexOf('（画像三节超过', headingAt);
  assert.ok(noteAt > headingAt, '截断说明要在画像正文之后');
  const body = text.slice(headingAt + heading.length + 1, noteAt).replace(/\n$/, '');
  assert.ok([...body].length > 0, '截断后正文不该是空的');
  assert.ok([...body].length <= MEMORY_RENDER_BUDGET,
    `画像正文超过预算 ${MEMORY_RENDER_BUDGET} 字符：${[...body].length}`);
});

test('没有共享记忆时摘要文本照常出、不留空段（新工作区常态）', async (t) => {
  const f = withTools(t);
  const value = await execute(f.ctx, 'studymate_workspace_context', {});
  assert.equal(value.memory.present, false);
  const text = renderSummary(f.ctx, value);
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
  assert.equal(text.includes('共享记忆'), false, '没有记忆就不出现这一节');
  assert.equal(text.includes('\n\n'), false, `没有记忆时不该多出空行：\n${text}`);
  assert.equal(text.split('\n').some((line) => line.trim() === ''), false, '文本里没有空行');
});

test('三档状态来自 progress.yaml；旧词表读到就映射（不静默当学会）', async (t) => {
  const home = useHome(t);
  writeSubject(home.workspace, 'demo', {
    // 旧六档的取值（#71 之后新写的只该是三档，但旧工作区读得进、要按 §5.2 映射）
    progress: [
      'updated_at: 2026-05-06T10:00:00+08:00',
      'nodes:',
      '  var:',
      '    status: 能独立应用',
      '    mastery: 0.9',
      '  fn:',
      '    status: 初步理解',
      '    mastery: 0.4',
      'misconceptions: []',
      'project:',
      '  current: fn',
      '',
    ].join('\n'),
  });
  const ctx = fakeContext();
  tools.registerContextTools(ctx.ctx);
  const value = await execute(ctx, 'studymate_workspace_context', {});
  const subject = value.subjects[0];
  assert.deepEqual(subject.nodes.map((node) => node.tier), ['已学完', '学习中']);
  assert.deepEqual(subject.tierCounts, { 未开始: 0, 学习中: 1, 已学完: 1 });
  assert.equal(subject.current.id, 'fn', '有学习中的节点时，当前节点就是它');
  assert.equal(subject.current.tier, '学习中');
});

test('subject 参数只留一个科目；给了不存在的 slug 会说清现有的是哪些', async (t) => {
  const f = withTools(t);
  const one = await execute(f.ctx, 'studymate_workspace_context', { subject: 'demo' });
  assert.equal(one.subjects.length, 1);

  const missing = await execute(f.ctx, 'studymate_workspace_context', { subject: 'nope' });
  assert.equal(missing.subjects.length, 0);
  assert.ok(missing.notes.some((note) => /demo/.test(note)), '提示里要列出真实存在的科目');
});

test('还没有科目时也返回结构化摘要（不抛）', async (t) => {
  const home = useHome(t);
  fs.mkdirSync(path.join(home.workspace, '.learning', 'subjects'), { recursive: true });
  const ctx = fakeContext();
  tools.registerContextTools(ctx.ctx);
  const value = await execute(ctx, 'studymate_workspace_context', {});
  assert.equal(value.workspace.ready, true);
  assert.deepEqual(value.subjects, []);
  assert.equal(value.memory.present, false);
  assert.ok(value.notes.some((note) => /科目/.test(note)));
  await assertOutput(assert, ctx.definitions.get('studymate_workspace_context'), value);
});

/* ── 二、逐域投影：声明之外的域拿不到数据 ─────────────────────────────── */

test('subjects 切片里没有题库、没有课件正文（顺着节点也读不到别的域）', async (t) => {
  const f = withTools(t, {
    pool: JSON.stringify({ 什么是变量: [{ q: '题库里的题面不该出现在 subjects 里' }] }, null, 2),
  });
  const vault = createWorkspaceVault();
  const subjectsOnly = createAccess(
    { tool: 'unit', declaration: { reads: ['subjects'] } }, vault.load,
  );
  const dump = JSON.stringify(subjectsOnly.read('subjects'));
  assert.match(dump, /演示科目/, '科目档案本身要在');
  assert.ok(!dump.includes('题库里的题面'), '题库不能顺着 subjects 漏出来');
  assert.ok(!dump.includes('正文一段'), '课件正文属于 lessons 域，不能漏出来');
  assert.ok(!dump.includes('anchor'), '锚点对账结果属于 lessons 域');
  assert.throws(() => subjectsOnly.read('pool'), /DOMAIN_VIOLATION/);

  // 反向对照：声明了 pool 的工具拿得到
  const withPool = createAccess({ tool: 'unit', declaration: { reads: ['pool'] } }, vault.load);
  assert.match(JSON.stringify(withPool.read('pool')), /题库里的题面/);
});

test('curriculum 切片不再投影 edges，slug / nodes / order 照旧（#153）', async (t) => {
  withTools(t);
  const vault = createWorkspaceVault();
  const access = createAccess({ tool: 'unit', declaration: { reads: ['curriculum'] } }, vault.load);
  const entries = access.read('curriculum');
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.slug, 'demo');
  assert.equal(entry.nodes.length, 2);
  assert.deepEqual(entry.order, { var: 0, fn: 1 });
  assert.ok(!Object.prototype.hasOwnProperty.call(entry, 'edges'),
    'curriculum 视图不再投影 edges；前置关系读 nodes[].prerequisites');
});

test('handoff 域要指定 stage；export 域没有读法', async (t) => {
  useHome(t);
  const vault = createWorkspaceVault();
  const access = createAccess(
    { tool: 'unit', declaration: { reads: ['handoff', 'workspace'] } }, vault.load,
  );
  assert.throws(() => access.read('handoff'), /要指定 stage/);
  const missing = access.read('handoff', '/nonexistent/stage');
  assert.equal(missing.present, false);
  assert.deepEqual(missing.entries, []);
});
