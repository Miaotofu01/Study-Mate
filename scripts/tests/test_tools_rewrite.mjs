/* StudyMate 原生工具 · **两个改写工具**（`lib/tools/rewrite.ts`）
   ────────────────────────────────────────────────────────────────────────
   行为口径来自现行的两个脚本（`scripts/renumber_lessons.py` / `apply_empty_reasons.py`，
   #83 才删）——这里逐条钉住它们「会拦什么、会写哪里、写出来长什么样」，外加 #68 自己的
   一条：**写盘必须过 guard**（声明之外的字段写不了）。

   工作区在临时目录里现造现弃；写盘的用例都断言「没成事时一个字都没动」。 */
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
  tools.registerRewriteTools(ctx.ctx);
  return { ...home, subject, ctx };
}

async function call(ctx, name, args) {
  const definition = ctx.definitions.get(name);
  const value = await execute(ctx, name, args);
  await assertOutput(assert, definition, value);
  return value;
}

function listing(dir) {
  return fs.readdirSync(dir).sort();
}

/* ── 一、studymate_renumber_lessons ───────────────────────────────────── */

test('位次按大纲的 nodes 顺序算：dry-run 只报计划，一个字都不动盘', async (t) => {
  const f = withTools(t, { secondLesson: false });
  // 第二课的名字故意写成 0009（大纲里是第 2 位）
  fs.renameSync(path.join(f.subject.lessonsDir, '0001-var.md'), path.join(f.subject.lessonsDir, '0009-var.md'));
  fs.renameSync(path.join(f.subject.lessonsDir, '0001-var.quiz.json'),
    path.join(f.subject.lessonsDir, '0009-var.quiz.json'));
  const before = listing(f.subject.lessonsDir);

  const value = await call(f.ctx, 'studymate_renumber_lessons', { subject: 'demo', dryRun: true });
  assert.equal(value.ok, true);
  assert.deepEqual(value.renames.map((item) => [item.from, item.to, item.applied]), [
    ['0009-var.md', '0001-var.md', false],
    ['0009-var.quiz.json', '0001-var.quiz.json', false],
  ]);
  assert.deepEqual(value.changedNodes, ['var']);
  assert.deepEqual(listing(f.subject.lessonsDir), before, 'dry-run 不许动盘');
});

test('真跑：同一个节点的三件（md / quiz.json）一起落到同一个序号', async (t) => {
  const f = withTools(t, { secondLesson: false });
  fs.renameSync(path.join(f.subject.lessonsDir, '0001-var.md'), path.join(f.subject.lessonsDir, '0007-var.md'));
  fs.renameSync(path.join(f.subject.lessonsDir, '0001-var.quiz.json'),
    path.join(f.subject.lessonsDir, '0007-var.quiz.json'));
  const value = await call(f.ctx, 'studymate_renumber_lessons', { subject: 'demo' });
  assert.equal(value.ok, true);
  assert.deepEqual(listing(f.subject.lessonsDir), ['0001-var.md', '0001-var.quiz.json']);
  assert.ok(value.renames.every((item) => item.applied));
  assert.match(value.summary, /改了 1 个节点的 2 个文件/);
});

test('两课的名字对调过也能一起改回来（同一批里既有 var 也有 fn）', async (t) => {
  const f = withTools(t, { secondLesson: false });
  // 大纲顺序是 var(1) → fn(2)，把两课的文件名对调
  fs.renameSync(path.join(f.subject.lessonsDir, '0001-var.md'), path.join(f.subject.lessonsDir, '0002-var.md'));
  fs.writeFileSync(path.join(f.subject.lessonsDir, '0001-fn.md'), '---\ntitle: 函数\ngoal: 一句话。\n---\n\n正文。\n');
  const value = await call(f.ctx, 'studymate_renumber_lessons', { subject: 'demo' });
  assert.equal(value.ok, true, JSON.stringify(value.problems));
  assert.deepEqual(listing(f.subject.lessonsDir), ['0001-var.md', '0001-var.quiz.json', '0002-fn.md']);
  assert.deepEqual(value.changedNodes, ['var', 'fn'], '受影响的节点按大纲位次排');
});

test('目标名被占着（目录 / 断链符号链接）→ 阻断，一个文件都不动', async (t) => {
  const f = withTools(t, { secondLesson: false });
  fs.renameSync(path.join(f.subject.lessonsDir, '0001-var.md'), path.join(f.subject.lessonsDir, '0009-var.md'));
  // 占位的是**目录**：既不是本次要改走的文件，也不是「同一个节点的另一份」（那条是 duplicates）
  fs.mkdirSync(path.join(f.subject.lessonsDir, '0001-var.md'));

  const value = await call(f.ctx, 'studymate_renumber_lessons', { subject: 'demo' });
  assert.equal(value.ok, false);
  assert.match(value.problems[0].message, /目标名已存在/);
  assert.ok(fs.statSync(path.join(f.subject.lessonsDir, '0001-var.md')).isDirectory(), '占位的东西还在');
  assert.ok(fs.existsSync(path.join(f.subject.lessonsDir, '0009-var.md')), '原名还在');
});

test('一个节点同后缀两份 → 阻断（分不清该改哪份）', async (t) => {
  const f = withTools(t, { secondLesson: false });
  fs.writeFileSync(path.join(f.subject.lessonsDir, '0009-var.md'), '另一份\n');
  const value = await call(f.ctx, 'studymate_renumber_lessons', { subject: 'demo' });
  assert.equal(value.ok, false);
  assert.equal(value.duplicates.length, 1);
  assert.match(value.problems[0].message, /有 2 份/);
});

test('认不出的命名只列进「未处理」，不影响成事', async (t) => {
  const f = withTools(t, { secondLesson: false });
  fs.writeFileSync(path.join(f.subject.lessonsDir, 'notes.md'), '随手记\n');
  fs.writeFileSync(path.join(f.subject.lessonsDir, '12-var.md'), '序号不是四位\n');
  fs.writeFileSync(path.join(f.subject.lessonsDir, '0003-ghost.md'), '节点不在大纲里\n');
  fs.mkdirSync(path.join(f.subject.lessonsDir, 'subdir'));

  const value = await call(f.ctx, 'studymate_renumber_lessons', { subject: 'demo', dryRun: true });
  assert.equal(value.ok, true);
  const reasons = Object.fromEntries(value.untouched.map((item) => [item.file, item.reason]));
  assert.match(reasons['notes.md'], /没有「4 位序号-」前缀/);
  assert.match(reasons['12-var.md'], /不是 4 位补零/);
  assert.match(reasons['0003-ghost.md'], /不在 curriculum.yaml 的 nodes/);
  assert.match(reasons.subdir, /是目录/);
  assert.match(value.summary, /4 个文件没被接管/);
});

test('大纲读不出来 → 阻断，不猜位次', async (t) => {
  const f = withTools(t);
  fs.writeFileSync(path.join(f.subject.dir, 'curriculum.yaml'), 'nodes: [\n');
  const value = await call(f.ctx, 'studymate_renumber_lessons', { subject: 'demo' });
  assert.equal(value.ok, false);
  assert.match(value.summary, /大纲读不出来/);
});

test('找不到科目目录 → 阻断，并列出试过的路径', async (t) => {
  const f = withTools(t);
  const value = await call(f.ctx, 'studymate_renumber_lessons', { subject: 'nope' });
  assert.equal(value.ok, false);
  assert.match(value.problems[0].message, /找不到科目目录/);
  assert.ok(value.problems[0].message.includes('nope'));
});

/* ── 二、studymate_apply_empty_reasons ────────────────────────────────── */

const LESSON_WITH_TWO_QUIZ = [
  '---',
  'title: 函数',
  'goal: 一句话。',
  '---',
  '',
  '## 一节',
  '',
  '::: quiz 理解 锚点：什么是函数',
  ':::',
  '',
  '::: quiz 理解 锚点：函数的参数',
  ':::',
  '',
].join('\n');

test('按锚点打进 empty_reason：落在块内、收尾 ::: 之前，缩进跟着块走', async (t) => {
  const f = withTools(t, { secondLesson: false });
  const file = path.join(f.subject.lessonsDir, '0002-fn.md');
  fs.writeFileSync(file, LESSON_WITH_TWO_QUIZ);

  const value = await call(f.ctx, 'studymate_apply_empty_reasons', {
    subject: 'demo',
    node: 'fn',
    reasons: [{ anchor: '函数的参数', reason: '这一轮不出题' }],
  });
  assert.equal(value.ok, true, JSON.stringify(value.problems));
  assert.equal(value.file, file);
  assert.deepEqual(value.inserted.map((item) => [item.anchor, item.line]), [['函数的参数', 12]]);

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[11], 'empty_reason: 这一轮不出题');
  assert.equal(lines[12], ':::', '插在收尾 ::: 之前');
  assert.equal(lines[8], ':::', '另一块没被动');
});

test('缩进与行尾逐字保持（CRLF 文件里插进去的那行也是 CRLF）', async (t) => {
  const f = withTools(t, { secondLesson: false });
  const file = path.join(f.subject.lessonsDir, '0002-fn.md');
  fs.writeFileSync(file, LESSON_WITH_TWO_QUIZ.replace(/\n/g, '\r\n'));
  const value = await call(f.ctx, 'studymate_apply_empty_reasons', {
    subject: 'demo', node: 'fn', reasons: [{ anchor: '什么是函数', reason: '先不考' }],
  });
  assert.equal(value.ok, true, JSON.stringify(value.problems));
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.includes('empty_reason: 先不考\r\n'), '插入行的行尾要是 CRLF');
  assert.equal(raw.split('\r\n').length, LESSON_WITH_TWO_QUIZ.split('\n').length + 1);
});

test('dry-run 只报将插入的位置，一个字都不改', async (t) => {
  const f = withTools(t, { secondLesson: false });
  const file = path.join(f.subject.lessonsDir, '0002-fn.md');
  fs.writeFileSync(file, LESSON_WITH_TWO_QUIZ);
  const before = fs.readFileSync(file, 'utf8');
  const value = await call(f.ctx, 'studymate_apply_empty_reasons', {
    subject: 'demo', node: 'fn', reasons: [{ anchor: '什么是函数', reason: '先不考' }], dryRun: true,
  });
  assert.equal(value.ok, true);
  assert.equal(value.dryRun, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.match(value.summary, /dry-run/);
});

test('拦下这些：锚点找不到 / 同一锚点两个题目位置 / 块里已有 empty_reason / 参数重复', async (t) => {
  const f = withTools(t, { secondLesson: false });
  const file = path.join(f.subject.lessonsDir, '0002-fn.md');
  fs.writeFileSync(file, LESSON_WITH_TWO_QUIZ);
  const before = fs.readFileSync(file, 'utf8');

  let value = await call(f.ctx, 'studymate_apply_empty_reasons', {
    subject: 'demo', node: 'fn', reasons: [{ anchor: '没有这个锚点', reason: 'x' }],
  });
  assert.equal(value.ok, false);
  assert.match(value.problems[0].message, /没有对应的 ::: quiz 题目位置/);

  value = await call(f.ctx, 'studymate_apply_empty_reasons', {
    subject: 'demo', node: 'fn',
    reasons: [{ anchor: '什么是函数', reason: 'a' }, { anchor: '什么是函数', reason: 'b' }],
  });
  assert.equal(value.ok, false);
  assert.match(value.problems[0].message, /出现两次/);

  for (const [reason, pattern] of [['', /理由为空/], ['empty_reason: 已经带了前缀', /不要再写/],
    ['两行\n理由', /有换行/]]) {
    value = await call(f.ctx, 'studymate_apply_empty_reasons', {
      subject: 'demo', node: 'fn', reasons: [{ anchor: '什么是函数', reason }],
    });
    assert.equal(value.ok, false, `理由「${reason}」应该被拦`);
    assert.match(value.problems[0].message, pattern);
  }

  assert.equal(fs.readFileSync(file, 'utf8'), before, '拦下时一个字都不许改');

  // 同一个锚点被两个 ::: quiz 块引用：分不清该往哪个块插
  fs.writeFileSync(file, LESSON_WITH_TWO_QUIZ.replace('锚点：函数的参数', '锚点：什么是函数'));
  value = await call(f.ctx, 'studymate_apply_empty_reasons', {
    subject: 'demo', node: 'fn', reasons: [{ anchor: '什么是函数', reason: 'x' }],
  });
  assert.equal(value.ok, false);
  assert.match(value.problems[0].message, /被 2 个 ::: quiz 题目位置引用/);

  // 已经打过 empty_reason 的块：再打一次要拦
  fs.writeFileSync(file, LESSON_WITH_TWO_QUIZ.replace('::: quiz 理解 锚点：什么是函数\n:::',
    '::: quiz 理解 锚点：什么是函数\nempty_reason: 之前打过\n:::'));
  value = await call(f.ctx, 'studymate_apply_empty_reasons', {
    subject: 'demo', node: 'fn', reasons: [{ anchor: '什么是函数', reason: '再来一次' }],
  });
  assert.equal(value.ok, false);
  assert.match(value.problems[0].message, /已经有 empty_reason/);
});

test('围栏里的 ::: quiz 是代码原文，不算题目位置；块没收尾要拦', async (t) => {
  const f = withTools(t, { secondLesson: false });
  const file = path.join(f.subject.lessonsDir, '0002-fn.md');
  fs.writeFileSync(file, [
    '---', 'title: 函数', 'goal: 一句话。', '---', '',
    '```', '::: quiz 理解 锚点：示例里的锚点', ':::', '```', '',
  ].join('\n'));
  let value = await call(f.ctx, 'studymate_apply_empty_reasons', {
    subject: 'demo', node: 'fn', reasons: [{ anchor: '示例里的锚点', reason: 'x' }],
  });
  assert.equal(value.ok, false);
  assert.match(value.problems[0].message, /没有对应的 ::: quiz 题目位置/);

  fs.writeFileSync(file, [
    '---', 'title: 函数', 'goal: 一句话。', '---', '',
    '::: quiz 理解 锚点：没有收尾的块', '',
  ].join('\n'));
  value = await call(f.ctx, 'studymate_apply_empty_reasons', {
    subject: 'demo', node: 'fn', reasons: [{ anchor: '没有收尾的块', reason: 'x' }],
  });
  assert.equal(value.ok, false);
  assert.match(value.problems[0].message, /没有收尾 :::/);
});

test('节点不在大纲里 / 内容文件还没产出 → 阻断并说清位次', async (t) => {
  const f = withTools(t, { secondLesson: false });
  let value = await call(f.ctx, 'studymate_apply_empty_reasons', {
    subject: 'demo', node: 'ghost', reasons: [{ anchor: 'x', reason: 'y' }],
  });
  assert.equal(value.ok, false);
  assert.match(value.problems[0].message, /不在 curriculum.yaml 的 nodes/);

  value = await call(f.ctx, 'studymate_apply_empty_reasons', {
    subject: 'demo', node: 'fn', reasons: [{ anchor: 'x', reason: 'y' }],
  });
  assert.equal(value.ok, false);
  assert.match(value.problems[0].message, /找不到内容文件/);
  assert.match(value.problems[0].message, /0002/);
});

/* ── 三、studymate_export 占位 ────────────────────────────────────────── */

test('导出是占位：明确说「还没实现 + 什么时候会有」，不假装成功', async (t) => {
  const f = withTools(t);
  const ctx = fakeContext();
  tools.registerExportTools(ctx.ctx);
  const value = await call(ctx, 'studymate_export', {});
  assert.equal(value.implemented, false);
  assert.equal(value.plannedIn, '#82');
  assert.deepEqual(value.files, []);
  assert.match(value.reason, /#82/);
  assert.equal(fs.existsSync(path.join(f.workspace, 'export')), false, '占位不产出任何文件');
});
