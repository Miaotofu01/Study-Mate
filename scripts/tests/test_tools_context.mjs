/* StudyMate 原生工具 · **工作区摘要**（`lib/tools/{context,vault}.ts`）
   ────────────────────────────────────────────────────────────────────────
   两件事：

   1. `studymate_workspace_context` 的返回是**结构化摘要**（工作区路径、今天、科目清单含
      当前节点与三档状态、最近学习记录、可用能力）——总控开场那一次调用拿到的就是这个，
      不是 exit code、不是一堆要自己拼的文件。
   2. 逐域投影**真的**把别的域摘掉了：`subjects` 的切片里没有题库、没有课件正文。
      否则「声明了 subjects」的工具顺着节点就能读到 pool，guard 就成了摆设。

   工作区在临时目录里现造现弃（ADR-0009）。 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAccess } from '../../lib/tools/access.ts';
import { createWorkspaceVault } from '../../lib/tools/vault.ts';
import { assertOutput, execute, fakeContext, loadTools, useHome, writeSubject } from './fixtures/tools.mjs';

const tools = await loadTools();

function withTools(t, options = {}) {
  const home = useHome(t);
  const { dir, lessonsDir } = writeSubject(home.workspace, 'demo', options);
  const ctx = fakeContext(options.llm === undefined ? {} : { llm: options.llm });
  tools.registerContextTools(ctx.ctx);
  return { ...home, dir, lessonsDir, ctx };
}

/* ── 一、结构化摘要 ───────────────────────────────────────────────────── */

test('开场一次调用拿到：工作区路径、今天、科目现状（当前节点 + 三档）、记录与能力', async (t) => {
  const f = withTools(t);
  fs.writeFileSync(path.join(f.workspace, '.learning', 'MEMORY.md'), '# 画像\n\n喜欢动手。\n');
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
  assert.match(value.memory.markdown, /喜欢动手/);
  assert.equal(value.capabilities.model.available, false);
  assert.deepEqual(value.notes, []);
});

test('三档状态来自 progress.yaml，旧词表读到就映射（不静默当学会）', async (t) => {
  const home = useHome(t);
  writeSubject(home.workspace, 'demo', {
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
