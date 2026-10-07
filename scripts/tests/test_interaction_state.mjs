/* Codex 侧交互断点（`openai/studymate/scripts/interaction_state.mjs`）
   ────────────────────────────────────────────────────────────────────────
   这条套件是 原 Python 套件 `test_interaction_state`（交互断点脚本的验收面）
   的**行为移植**：那个脚本是 Codex / ChatGPT Work 侧唯一一件「脚本才做得到」的事——
   用 revision 栅栏提交，冲突就失败而不是覆盖另一个会话。Python 退场，这件事不能跟着退，
   所以脚本搬成 Node，断言一并搬过来。

   钉住五类：隔离（工作区必须显式、初始化过、不在插件缓存里）、连续性（存了能再读回来）、
   原子冲突（过期 revision / 已存在的锁 / 两个进程抢同一版）、回答消费（空回答不算、
   迟到与重复的 id 都不能推进）、以及「坏了或版本不认识的状态一个字都不改」。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  FIELDS, StateError, answer_state, initial_state, load_json, read_state, update_state, workspace_path,
} from '../../openai/studymate/scripts/interaction_state.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../openai/studymate/scripts/interaction_state.mjs');

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-interaction-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, "学习 [1] O'Brien # notes");
  const learning = path.join(workspace, '.learning');
  fs.mkdirSync(learning, { recursive: true });
  const file = path.join(learning, 'interaction.json');
  const input = (data, name = 'next.json') => {
    const target = path.join(base, name);
    fs.writeFileSync(target, JSON.stringify(data), 'utf8');
    return target;
  };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--workspace', workspace, ...args],
    { encoding: 'utf8', timeout: 15_000 });
  return { base, workspace, learning, file, input, run };
}

function business(changes = {}) {
  const data = {};
  for (const key of FIELDS) data[key] = initial_state()[key];
  Object.assign(data, { intent: '学习线性代数', answers: { weekly_hours: 4 }, next_action: '询问学习目标' }, changes);
  return data;
}

function pending(changes = {}) {
  return Object.assign({
    id: 'goal-1', kind: 'preference', topic: 'learning_goal',
    question: '偏好概念还是应用？',
    options: [{ id: 'theory', label: '概念' }, { id: 'applied', label: '应用' }],
    resume_phase: 'plan',
  }, changes);
}

/** 断言「一个字都没动」：状态文件逐字节不变、锁没了、临时文件没留下。 */
function assertUnchanged(f, original) {
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.equal(fs.existsSync(path.join(f.learning, '.interaction.lock')), false);
  assert.deepEqual(fs.readdirSync(f.learning).filter(name => name.startsWith('.interaction-') && name.endsWith('.tmp')), []);
}

test('首次读不写盘：工作区必须显式、必须初始化过', (t) => {
  const f = fixture(t);
  assert.equal(workspace_path(f.workspace), fs.realpathSync(f.workspace));
  const result = f.run('read');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), initial_state());
  assert.deepEqual(fs.readdirSync(f.learning), []);

  const empty = path.join(f.base, 'uninitialized');
  fs.mkdirSync(empty);
  const failed = spawnSync(process.execPath,
    [SCRIPT, '--workspace', empty, 'update', '--input', f.input(business()), '--expected-revision', '0'],
    { encoding: 'utf8' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /existing \.learning/);
  assert.deepEqual(fs.readdirSync(empty), []);
  const missing = spawnSync(process.execPath, [SCRIPT, 'read'], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.throws(() => workspace_path('relative-directory'), /absolute/);
});

test('存了能再读回来：pending 完整保留，进度文件一个字没动', (t) => {
  const f = fixture(t);
  const subject = path.join(f.learning, 'subjects', 'linear-algebra');
  fs.mkdirSync(subject, { recursive: true });
  const progress = path.join(subject, 'progress.yaml');
  fs.writeFileSync(progress, 'mastery: 0\n', 'utf8');
  const question = pending({ kind: 'learning_check', resume_phase: 'learn' });
  const data = business({ active_subject: 'linear-algebra', phase: 'practice', node_id: 'vector.space', pending: question });
  assert.equal(f.run('update', '--input', f.input(data), '--expected-revision', '0').status, 0);
  const reopened = JSON.parse(f.run('read').stdout);
  assert.equal(reopened.revision, 1);
  assert.deepEqual(reopened.pending, question);
  assert.equal(reopened.node_id, 'vector.space');
  const next = {};
  for (const key of FIELDS) next[key] = reopened[key];
  Object.assign(next, { answers: { weekly_hours: 4, student_reply: '我的推导如下' }, pending: null, phase: 'review' });
  const saved = f.run('update', '--input', f.input(next), '--expected-revision', '1');
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(JSON.parse(saved.stdout).revision, 2);
  assert.equal(JSON.parse(saved.stdout).pending, null);
  assert.equal(fs.readFileSync(progress, 'utf8'), 'mastery: 0\n');
});

test('改了主意可以整体替换 pending，也可以清空并暂停', (t) => {
  const f = fixture(t);
  update_state(f.workspace, business({ pending: pending() }), 0);
  const replacement = business({
    intent: '改学概率论',
    pending: pending({ id: 'probability-goal', question: '学习概率论的目标是什么？', options: [] }),
  });
  assert.equal(update_state(f.workspace, replacement, 1).pending.id, 'probability-goal');
  const paused = update_state(f.workspace, business({ intent: '先暂停', phase: 'paused', pending: null }), 2);
  assert.equal(paused.pending, null);
  assert.equal(paused.intent, '先暂停');
});

test('answer 记下原始 JSON 值并回到 resume_phase', (t) => {
  const f = fixture(t);
  update_state(f.workspace, business({ pending: pending() }), 0);
  const reply = { selected: ['applied'], comment: '  我想用中文学习，先做应用！  ' };
  const result = f.run('answer', '--question-id', 'goal-1', '--input', f.input(reply), '--expected-revision', '1');
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(result.stdout);
  assert.equal(saved.revision, 2);
  assert.equal(saved.phase, 'plan');
  assert.equal(saved.pending, null);
  assert.deepEqual(saved.answers['goal-1'], { topic: 'learning_goal', value: reply });
  assert.equal(saved.answers.weekly_hours, 4);
  assert.equal(saved.next_action, '根据已收到的 learning_goal 回答继续 plan');
  assert.notEqual(saved.next_action, '询问学习目标');
  assert.deepEqual(read_state(f.workspace), saved);
});

test('迟到、重复、已消费的 question id 都不能推进', (t) => {
  const f = fixture(t);
  update_state(f.workspace, business({ pending: pending() }), 0);
  update_state(f.workspace, business({ pending: pending({ id: 'new-goal' }) }), 1);
  let original = fs.readFileSync(f.file);
  assert.throws(() => answer_state(f.workspace, 'goal-1', '迟到的旧答案', 2), /question conflict/);
  assertUnchanged(f, original);
  answer_state(f.workspace, 'new-goal', '应用', 2);
  original = fs.readFileSync(f.file);
  assert.throws(() => answer_state(f.workspace, 'new-goal', '应用', 3), /no pending question/);
  assertUnchanged(f, original);
  const data = {};
  for (const key of FIELDS) data[key] = read_state(f.workspace)[key];
  data.pending = pending({ id: 'new-goal' });
  update_state(f.workspace, data, 3);
  original = fs.readFileSync(f.file);
  assert.throws(() => answer_state(f.workspace, 'new-goal', '重复答案', 4), /already answered/);
  assertUnchanged(f, original);
});

test('过期 revision 与已存在的锁都当场失败，不改状态', (t) => {
  const f = fixture(t);
  update_state(f.workspace, business({ pending: pending() }), 0);
  const original = fs.readFileSync(f.file);
  const stale = f.run('answer', '--question-id', 'goal-1', '--input', f.input('应用'), '--expected-revision', '0');
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /revision conflict/);
  assertUnchanged(f, original);

  const lock = path.join(f.learning, '.interaction.lock');
  fs.writeFileSync(lock, 'another process\n', 'utf8');
  const started = Date.now();
  const locked = f.run('update', '--input', f.input(business()), '--expected-revision', '1');
  assert.notEqual(locked.status, 0);
  assert.match(locked.stderr, /update locked/);
  assert.ok(Date.now() - started < 5000, '不等待锁：应当立刻失败');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another process\n');
  assert.deepEqual(fs.readFileSync(f.file), original);
});

test('两个进程不能提交同一个 revision', async (t) => {
  const f = fixture(t);
  // **真并行**：两边都拿着 revision 0。至少一个必须失败——要么撞上锁，要么撞上 revision。
  const files = ['first', 'second'].map(intent => f.input(business({ intent }), `${intent}.json`));
  const launched = files.map(file => new Promise((resolve) => {
    const child = spawn(process.execPath,
      [SCRIPT, '--workspace', f.workspace, 'update', '--input', file, '--expected-revision', '0'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  }));
  const results = await Promise.all(launched);
  assert.equal(results.filter(result => result.code === 0).length, 1,
    JSON.stringify(results.map(result => result.stderr)));
  assert.match(results.find(result => result.code !== 0).stderr, /revision conflict|update locked/);
  const state = read_state(f.workspace);
  assert.equal(state.revision, 1);
  assert.ok(['first', 'second'].includes(state.intent));
  assert.equal(fs.existsSync(path.join(f.learning, '.interaction.lock')), false);
});

test('暂停必须清空 pending，迟到的选择也不再被接受', (t) => {
  const f = fixture(t);
  update_state(f.workspace, business({ pending: pending() }), 0);
  let original = fs.readFileSync(f.file);
  assert.throws(() => update_state(f.workspace, business({ phase: 'paused', pending: pending() }), 1),
    /paused state must clear pending/);
  assertUnchanged(f, original);
  update_state(f.workspace, business({ phase: 'paused', pending: null, next_action: '等待学生恢复' }), 1);
  original = fs.readFileSync(f.file);
  assert.throws(() => answer_state(f.workspace, 'goal-1', '迟到的选择', 2), /no pending question/);
  assertUnchanged(f, original);
});

test('空回答不能消费 pending；显式的 false 与 0 算回答', (t) => {
  const f = fixture(t);
  update_state(f.workspace, business({ pending: pending() }), 0);
  const original = fs.readFileSync(f.file);
  for (const reply of [null, '', ' \n\t ', [], {}, ['', null], { reply: '' }]) {
    const result = f.run('answer', '--question-id', 'goal-1', '--input', f.input(reply), '--expected-revision', '1');
    assert.notEqual(result.status, 0, JSON.stringify(reply));
    assert.match(result.stderr, /empty answer/);
    assertUnchanged(f, original);
  }
  const f2 = fixture(t);
  const replies = [false, 0, ['应用'], '先暂停'];
  replies.forEach((reply, index) => {
    const revision = index * 2;
    const questionId = `question-${index}`;
    update_state(f2.workspace, business({ pending: pending({ id: questionId }) }), revision);
    const saved = answer_state(f2.workspace, questionId, reply, revision + 1);
    assert.deepEqual(saved.answers[questionId].value, reply);
    assert.equal(saved.pending, null);
  });
});

test('坏了或不认识的状态不许被覆盖', (t) => {
  const f = fixture(t);
  for (const contents of ['{broken', '[]', '{"schema_version": 2}', '{"schema_version": true}',
    JSON.stringify({ ...initial_state(), revision: -1 }), '{"schema_version":1,"schema_version":2}']) {
    fs.writeFileSync(f.file, contents, 'utf8');
    const original = fs.readFileSync(f.file);
    const result = f.run('update', '--input', f.input(business()), '--expected-revision', '0');
    assert.notEqual(result.status, 0, contents);
    assertUnchanged(f, original);
  }
});

test('业务字段与 pending 的形状逐条校验（不合格时盘上不留东西）', (t) => {
  const f = fixture(t);
  const invalid = [];
  const missing = business();
  delete missing.answers;
  invalid.push(missing);
  for (const changes of [
    { schema_version: 1 }, { revision: 0 }, { phase: 'mastered' }, { phase: [] },
    { answers: [] }, { node_id: 12 }, { active_subject: '../outside' },
    { active_subject: 'nested/subject' }, { active_subject: 'C:\\outside' },
    { pending: pending({ kind: 'mastery' }) }, { pending: pending({ resume_phase: 'unknown' }) },
    { pending: pending({ options: [{ id: 'x', label: 'A' }, { id: 'x', label: 'B' }] }) },
    { pending: pending({ extra: 'unsupported' }) },
  ]) invalid.push(business(changes));
  for (const data of invalid) {
    assert.throws(() => update_state(f.workspace, data, 0), StateError, JSON.stringify(data));
  }
  assert.deepEqual(fs.readdirSync(f.learning), []);
  const malformed = path.join(f.base, 'non-json.json');
  fs.writeFileSync(malformed, '{"answers": NaN}', 'utf8');
  assert.throws(() => load_json(malformed));
});

test('原子替换失败时保留原状态', (t) => {
  const f = fixture(t);
  update_state(f.workspace, business(), 0);
  const original = fs.readFileSync(f.file);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated replace failure'); };
  try {
    assert.throws(() => update_state(f.workspace, business({ intent: 'new request' }), 1), /replace failure/);
  } finally {
    fs.renameSync = rename;
  }
  assertUnchanged(f, original);
});

test('提交成功但锁清不掉：如实报成功并留一条提醒', (t) => {
  const f = fixture(t);
  update_state(f.workspace, business({ pending: pending() }), 0);
  const lock = path.join(f.learning, '.interaction.lock');
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (target, ...rest) => {
    if (target === lock) throw new Error('lock cleanup temporarily unavailable');
    return unlink(target, ...rest);
  };
  let saved;
  try {
    saved = answer_state(f.workspace, 'goal-1', '应用', 1);
  } finally {
    fs.unlinkSync = unlink;
  }
  assert.equal(saved.revision, 2);
  assert.equal(saved.pending, null);
  assert.equal(read_state(f.workspace).answers['goal-1'].value, '应用');
  assert.ok(fs.existsSync(lock), '锁还在，提醒学生/维护者手动看一眼');
  assert.throws(() => update_state(f.workspace, business(), 2), /update locked/);
  fs.rmSync(lock, { force: true });
});

test('状态文件与科目目录的符号链接一律拒绝', { skip: process.platform === 'win32' && '符号链接在 Windows 上要开发者模式' }, (t) => {
  const f = fixture(t);
  const outside = path.join(f.base, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify(initial_state()), 'utf8');
  fs.symlinkSync(outside, f.file);
  const original = fs.readFileSync(outside);
  assert.throws(() => update_state(f.workspace, business(), 0), /symlink/);
  assert.deepEqual(fs.readFileSync(outside), original);
  fs.rmSync(f.file);
  const outsideSubject = path.join(f.base, 'outside-subject');
  fs.mkdirSync(outsideSubject);
  const subjects = path.join(f.learning, 'subjects');
  fs.mkdirSync(subjects);
  fs.symlinkSync(outsideSubject, path.join(subjects, 'linked'), 'dir');
  assert.throws(() => update_state(f.workspace, business({ active_subject: 'linked' }), 0), /symlink/);
  assert.equal(fs.existsSync(f.file), false);
});

test('插件缓存、插件根与额外的 forbid-root 都不能当工作区', (t) => {
  const f = fixture(t);
  for (const relative of ['.codex/plugins/cache/studymate/workspace', '.agents/plugins/cache/studymate/workspace']) {
    const workspace = path.join(f.base, ...relative.split('/'));
    fs.mkdirSync(path.join(workspace, '.learning'), { recursive: true });
    assert.throws(() => workspace_path(workspace), /plugin cache/);
  }
  const plugin = path.join(f.base, 'local-plugin');
  fs.mkdirSync(path.join(plugin, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), '{}', 'utf8');
  fs.mkdirSync(path.join(plugin, 'workspace', '.learning'), { recursive: true });
  assert.throws(() => workspace_path(path.join(plugin, 'workspace')), /plugin root/);
  assert.throws(() => workspace_path(f.workspace, [f.base]), /forbidden root/);
});
