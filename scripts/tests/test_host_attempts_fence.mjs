/* 特征化测试：Host 半数据层 · lib/attempts.ts 的作答数据与写入栅栏
   ────────────────────────────────────────────────────────────────────────
   钉住四件事（验收标准逐条对应）：
     1. **重放 operationId**：返回原回执、不产生第二条记录（两次写入后文件字节不变、回执相等）；
     2. **并发写**：版本号对不上时拒绝并重读，不丢数据（拒绝形状 + 重读后是对方写的那份）；
     3. **v0.2 真实工作区**：读得进、映射正确、写回后旧文件不损坏、退役目录仍可读且不再多文件；
     4. **题库逐字纯净**：作答绝不写回 `.quiz.json`。

   数据在 fs.mkdtemp 造的临时目录里现造现弃；`examples/.learning/` 那一次是**手工一次性验收**
   （见交付报告），套件不依赖它（#83 会删掉 examples）。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { attemptsVersion, readAttempts, writeAttempts } from '../../lib/attempts.ts';

/** 与 lib/attempts.ts 的 versionOfText 同一口径：内容（不含换行之外的加工）的 sha256 前 16 位。 */
function versionOf(data) {
  return createHash('sha256').update(`${JSON.stringify(data, null, 2)}\n`).digest('hex').slice(0, 16);
}
import { readLibrary } from '../../lib/library.ts';

/* ── 临时科目：跑完即弃 ───────────────────────────────────────────────── */

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
});

const SUBJECT = 'demo';

/** 一份最小科目：一个节点、一份带锚点的课件与题库。 */
function makeSubject() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-attempts-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  const subjectDir = path.join(workspace, '.learning', 'subjects', SUBJECT);
  fs.mkdirSync(path.join(subjectDir, 'lessons'), { recursive: true });
  fs.writeFileSync(path.join(subjectDir, 'subject.yaml'), 'slug: demo\nname: 作答\n');
  fs.writeFileSync(path.join(subjectDir, 'curriculum.yaml'), 'nodes:\n  - id: net.layers\n    title: 分层\n');
  fs.writeFileSync(path.join(subjectDir, 'progress.yaml'), 'updated_at: "2026-09-24"\nnodes:\n  net.layers:\n    status: 学习中\nproject:\n  current: ""\n');
  fs.writeFileSync(path.join(subjectDir, 'lessons', '0001-net.layers.md'),
    '# 分层\n\n::: quiz 理解 锚点：每层各管一段\n:::\n');
  fs.writeFileSync(path.join(subjectDir, 'lessons', '0001-net.layers.quiz.json'), JSON.stringify({
    '每层各管一段': [
      { q: '哪一层解析域名？', opts: ['应用层', '传输层', '网络层', '链路层'], ans: 0, why: 'DNS 在应用层。' },
      { q: '举一个跨层的例子。', answer: '隧道：内层 IP 包被塞进外层载荷。', criteria: '同时涉及两层以上。' },
    ],
  }, null, 2) + '\n');
  return { root, workspace, subjectDir, attemptsDir: path.join(subjectDir, 'attempts') };
}

/** 唯一的 operationId：模块级台账只在内存里，测试之间不能撞 id。 */
let seq = 0;
function op(name) {
  seq += 1;
  return `${name}-${process.pid}-${seq}`;
}

function countFiles(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/** 一次最普通的作答请求：客观题选第 0 项（对）。 */
function request(workspace, overrides = {}) {
  return {
    workspace,
    subject: SUBJECT,
    node: 'net.layers',
    questions: { '每层各管一段#0': { 选: 0, 对: true } },
    expectedVersion: attemptsVersion({ workspace, subject: SUBJECT, node: 'net.layers' }),
    operationId: op('write'),
    now: '2026-09-24T13:05:00.000Z',
    ...overrides,
  };
}

/* ── 落一份作答 ───────────────────────────────────────────────────────── */

test('落一份作答：回执、落盘形状与版本号', () => {
  const { workspace, attemptsDir } = makeSubject();
  const before = attemptsVersion({ workspace, subject: SUBJECT, node: 'net.layers' });
  assert.match(before, /^[0-9a-f]{16}$/, '还没作答也要有基线版本号，不能是空串');

  const result = writeAttempts(request(workspace));
  assert.equal(result.ok, true);
  assert.match(result.version, /^[0-9a-f]{16}$/);
  assert.notEqual(result.version, before, '版本号必须换一个：它就是下一次写入的栅栏');
  assert.equal(result.attempts['节点'], 'net.layers');
  assert.equal(result.attempts['课件'], '0001-net.layers.md');
  assert.equal(result.attempts['最后写入'], '2026-09-24T13:05:00.000Z');

  const file = path.join(attemptsDir, '0001-net.layers.json');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, result.attempts, '回执就是盘上那一份，不是另拼的一个对象');
  // 版本号**不在文件里**：它是读写两侧各自按内容算出来的（写进去就成了两个永远不相等的值）
  assert.equal(Object.hasOwn(onDisk, '版本'), false);
  assert.equal(result.version, versionOf(onDisk), '回执里的版本号必须等于按落盘内容算出来的那个');
  assert.deepEqual(onDisk['题']['每层各管一段#0'], {
    id: '每层各管一段#0',
    作答历史: [{ 时: '2026-09-24T13:05:00.000Z', 选: 0, 对: true }],
    上次结果: { 时: '2026-09-24T13:05:00.000Z', 选: 0, 对: true },
  });
  // 读回来的版本号与回执一致
  const read = readAttempts({ workspace, subject: SUBJECT, node: 'net.layers' });
  assert.equal(read.version, result.version);
  assert.deepEqual(read.data, result.attempts);
});

test('再答一次是**追加**历史，上次结果换成新的那条', () => {
  const { workspace } = makeSubject();
  const first = writeAttempts(request(workspace));
  assert.equal(first.ok, true);

  const second = writeAttempts(request(workspace, {
    questions: { '每层各管一段#0': { 选: 2, 对: false, 错因: '把 DNS 当成网络层的事' } },
    expectedVersion: first.version,
    operationId: op('second'),
  }));
  assert.equal(second.ok, true);
  const one = second.attempts['题']['每层各管一段#0'];
  assert.equal(one['作答历史'].length, 2, '两次作答 = 两条历史');
  assert.deepEqual(one['作答历史'][1], {
    时: '2026-09-24T13:05:00.000Z', 选: 2, 对: false, 错因: '把 DNS 当成网络层的事',
  });
  assert.equal(one['上次结果']['选'], 2, '上次结果 = 最近一次');
  assert.equal(one['上次结果']['错因'], '把 DNS 当成网络层的事');
});

/* ── 1. 重放 operationId ──────────────────────────────────────────────── */

test('同一个 operationId 重放只回原回执，不产生第二条记录（文件字节不变、回执相等）', () => {
  const { workspace, attemptsDir } = makeSubject();
  // 同一次提交原样再发一遍：连 expectedVersion 都还是旧的那个
  const submission = request(workspace, { operationId: op('replay') });
  const first = writeAttempts(submission);
  assert.equal(first.ok, true);

  const file = path.join(attemptsDir, '0001-net.layers.json');
  const bytesAfterFirst = fs.readFileSync(file);
  const filesAfterFirst = countFiles(attemptsDir);

  const replay = writeAttempts(submission);
  assert.deepEqual(replay, first, '重放要原样回放上次的回执');
  assert.deepEqual(fs.readFileSync(file), bytesAfterFirst, '重放后文件**字节不变**');
  assert.equal(countFiles(attemptsDir), filesAfterFirst, '重放不许再写一个文件');
  assert.equal(fs.existsSync(path.join(attemptsDir, '0001-net.layers-2.json')), false);

  // 去掉首尾空白后是同一个 id：双击时多一个空格也算同一次提交
  const padded = writeAttempts({ ...submission, operationId: `  ${submission.operationId}  ` });
  assert.deepEqual(padded, first);
  assert.deepEqual(fs.readFileSync(file), bytesAfterFirst);
});

test('重放先于版本校验：第一次写成功后版本已经变了，重试仍要回放而不是报冲突', () => {
  const { workspace } = makeSubject();
  const submission = request(workspace, { operationId: op('replay-stale-version') });
  const first = writeAttempts(submission);
  assert.equal(first.ok, true);
  // 重试带回来的是**写之前**那个版本号（已经过期）
  const replay = writeAttempts({ ...submission, expectedVersion: '0000000000000000' });
  assert.equal(replay.ok, true, '重试不该被误判成版本冲突');
  assert.deepEqual(replay, first);
});

test('同一个 operationId 换内容：409 拒绝，并带回当前作答与版本号', () => {
  const { workspace, attemptsDir } = makeSubject();
  const operationId = op('op-conflict');
  const first = writeAttempts(request(workspace, { operationId }));
  assert.equal(first.ok, true);
  const filesAfterFirst = countFiles(attemptsDir);

  const conflict = writeAttempts(request(workspace, {
    operationId,
    questions: { '每层各管一段#0': { 选: 1, 对: false } },
    expectedVersion: first.version,
  }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.error.code, 'operation-id-conflict');
  assert.equal(conflict.version, first.version);
  assert.deepEqual(conflict.attempts, first.attempts);
  assert.equal(countFiles(attemptsDir), filesAfterFirst, '这次不写盘');
});

/* ── 2. 并发写：版本号对不上就拒绝并重读 ──────────────────────────────── */

test('版本号对不上：409 拒绝并重读，不丢数据（重读后仍是对方写的那份）', () => {
  const { workspace, attemptsDir } = makeSubject();
  // 甲先写：乙手上那个版本号从这一刻起就旧了
  const 甲 = writeAttempts(request(workspace, {
    questions: { '每层各管一段#0': { 选: 0, 对: true } },
    operationId: op('fence-jia'),
  }));
  assert.equal(甲.ok, true);

  const 乙 = writeAttempts(request(workspace, {
    questions: { '每层各管一段#0': { 选: 3, 对: false } },
    expectedVersion: '0000000000000000',   // 乙手里那份过期快照
    operationId: op('fence-stale'),
  }));
  assert.equal(乙.ok, false);
  assert.equal(乙.status, 409);
  assert.equal(乙.error.code, 'version-conflict');
  // 拒绝时不引入文件锁，而是把当前作答与版本号一起带回去（ADR-0007 的「拒绝并重读」）
  assert.equal(乙.version, 甲.version);
  assert.deepEqual(乙.attempts, 甲.attempts, '带回去的就是对方写的那份，乙的数据没丢也没覆盖');
  assert.equal(countFiles(attemptsDir), 1, '被拒绝的那次不写盘');
  assert.equal(JSON.parse(fs.readFileSync(path.join(attemptsDir, '0001-net.layers.json'), 'utf8'))['题']['每层各管一段#0']['上次结果']['选'], 0);

  // 乙按新版本重来：这次成功，两条历史都在
  const retried = writeAttempts(request(workspace, {
    questions: { '每层各管一段#0': { 选: 3, 对: false } },
    expectedVersion: 乙.version,
    operationId: op('fence-retry'),
  }));
  assert.equal(retried.ok, true);
  assert.equal(retried.attempts['题']['每层各管一段#0']['作答历史'].length, 2, '甲那条没丢');
});

/* ── 请求体校验的顺序与判词 ───────────────────────────────────────────── */

test('坏请求先过一遍：operationId 缺失/超长、questions 为空、没带 expectedVersion', () => {
  const { workspace, attemptsDir } = makeSubject();
  const base = request(workspace);

  for (const operationId of [undefined, '', '   ', 'x'.repeat(201)]) {
    const result = writeAttempts({ ...base, operationId });
    assert.equal(result.status, 400, JSON.stringify(operationId));
    assert.equal(result.error.code, 'operation-id-invalid');
  }
  for (const questions of [undefined, null, [], 'x', {}]) {
    const result = writeAttempts({ ...base, questions, operationId: op('questions') });
    assert.equal(result.status, 400, JSON.stringify(questions));
    assert.equal(result.error.code, 'questions-invalid');
  }
  for (const expectedVersion of [undefined, null, '', '   ']) {
    const result = writeAttempts({ ...base, expectedVersion, operationId: op('no-version') });
    assert.equal(result.status, 400);
    assert.equal(result.error.code, 'expected-version-required');
  }
  assert.equal(countFiles(attemptsDir), 0, '坏请求一律不写盘');

  // 坏请求不该占用一个 id：同一个 id 之后用来写正式内容仍然成功
  const good = writeAttempts({ ...base, operationId: 'x'.repeat(200) });
  assert.equal(good.ok, true, '200 个字符是上限之内');
});

test('科目、节点与课件都要对得上：subject-invalid / node-invalid / lesson-missing', () => {
  const { workspace, attemptsDir } = makeSubject();
  const base = request(workspace);

  for (const subject of [undefined, '', '演示/科目', '..', '查无此科目']) {
    const result = writeAttempts({ ...base, subject, operationId: op('subject') });
    assert.equal(result.status, 400, JSON.stringify(subject));
    assert.equal(result.error.code, 'subject-invalid');
  }
  // 节点 id 的写法与 curriculum.schema.json 的 nodes[].id 一致：大写、斜杠、.. 都不行
  for (const node of [undefined, '', 'Net.Layers', '../net.layers', 'net/layers', 'net layers']) {
    const result = writeAttempts({ ...base, node, operationId: op('node') });
    assert.equal(result.status, 400, JSON.stringify(node));
    assert.equal(result.error.code, 'node-invalid');
  }
  // 节点合法但课件不在：作答数据与课件一一对应，不先造一份空档案
  const missing = writeAttempts({ ...base, node: 'net.tcp', operationId: op('lesson') });
  assert.equal(missing.status, 400);
  assert.equal(missing.error.code, 'lesson-missing');
  assert.equal(countFiles(attemptsDir), 0);
});

/* ── 3. 题库逐字纯净 ──────────────────────────────────────────────────── */

test('作答绝不写回题库：.quiz.json 逐字不变', () => {
  const { workspace, subjectDir } = makeSubject();
  const poolFile = path.join(subjectDir, 'lessons', '0001-net.layers.quiz.json');
  const before = fs.readFileSync(poolFile);
  const lessonFile = path.join(subjectDir, 'lessons', '0001-net.layers.md');
  const lessonBefore = fs.readFileSync(lessonFile);

  const first = writeAttempts(request(workspace));
  assert.equal(first.ok, true);
  const second = writeAttempts(request(workspace, {
    questions: { '每层各管一段#1': { 选: null, 对: true, 自评: '答对了' } },
    expectedVersion: first.version,
    operationId: op('open'),
  }));
  assert.equal(second.ok, true);

  assert.deepEqual(fs.readFileSync(poolFile), before, '题库必须逐字不变（ADR-0007）');
  assert.deepEqual(fs.readFileSync(lessonFile), lessonBefore, '课件正文也不动');
  assert.equal(second.attempts['题']['每层各管一段#1']['上次结果']['自评'], '答对了');
});

/* ── 4. payload 里读得到，退役目录不再多文件 ──────────────────────────── */

test('payload 里带作答数据与版本号：界面据此就地显示「上次你选了 B」', () => {
  const { workspace } = makeSubject();
  const written = writeAttempts(request(workspace));
  assert.equal(written.ok, true);

  const [subject] = readLibrary({ workspace }).subjects;
  const node = subject.nodes[0];
  assert.equal(node.attempts.present, true);
  assert.equal(node.attempts.version, written.version);
  assert.deepEqual(node.attempts.questions, written.attempts['题']);

  // 没作答过的节点：present=false，但版本号仍是可用的基线（第一次作答要带上它）
  const other = readLibrary({ workspace }).subjects[0];
  assert.equal(other.nodes.length, 1);
});

test('退役目录：跑完一遍流程后 assessments/ 与 sessions/ 没多文件（旧文件仍可读）', () => {
  const { workspace, subjectDir } = makeSubject();
  // 旧工作区里本来就有的评估记录与会话摘要：保留可读，不许被删、也不许多出新的
  fs.mkdirSync(path.join(subjectDir, 'assessments'), { recursive: true });
  fs.mkdirSync(path.join(subjectDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(subjectDir, 'assessments', '0001-net.layers.md'), '---\nnode: net.layers\n---\n旧评估\n');
  fs.writeFileSync(path.join(subjectDir, 'sessions', '2026-09-24.md'), '旧会话摘要\n');

  const snapshot = () => ({
    assessments: fs.readdirSync(path.join(subjectDir, 'assessments')).sort(),
    sessions: fs.readdirSync(path.join(subjectDir, 'sessions')).sort(),
  });
  const before = snapshot();

  // 跑一遍「读 → 写 → 再读」的完整流程
  const library = readLibrary({ workspace });
  assert.equal(library.subjects.length, 1);
  const written = writeAttempts(request(workspace));
  assert.equal(written.ok, true);
  readLibrary({ workspace });
  readAttempts({ workspace, subject: SUBJECT, node: 'net.layers' });

  assert.deepEqual(snapshot(), before, '退役目录不再产生新文件，旧文件也一个都不少');
  assert.equal(fs.readFileSync(path.join(subjectDir, 'assessments', '0001-net.layers.md'), 'utf8').includes('旧评估'), true);
  assert.equal(fs.readFileSync(path.join(subjectDir, 'sessions', '2026-09-24.md'), 'utf8').includes('旧会话摘要'), true);
});

test('没有课件、没有作答数据时读得进：readAttempts 给 null，版本号仍是可用基线', () => {
  const { workspace } = makeSubject();
  assert.equal(readAttempts({ workspace, subject: SUBJECT, node: 'net.layers' }), null);
  assert.match(attemptsVersion({ workspace, subject: SUBJECT, node: 'net.layers' }), /^[0-9a-f]{16}$/);
  // 科目/节点不合法时给空串（调用方据此判「读不到」）
  assert.equal(attemptsVersion({ workspace, subject: '../越界', node: 'net.layers' }), '');
  assert.equal(attemptsVersion({ workspace, subject: SUBJECT, node: '不存在' }), '');
  assert.equal(readAttempts({ workspace, subject: SUBJECT, node: '不存在' }), null);
});

test('写坏的作答文件不当场炸：读不到就当没作答过（派生记录，ADR-0007）', () => {
  const { workspace, attemptsDir } = makeSubject();
  fs.mkdirSync(attemptsDir, { recursive: true });
  fs.writeFileSync(path.join(attemptsDir, '0001-net.layers.json'), '{ 这不是 JSON');
  assert.equal(readAttempts({ workspace, subject: SUBJECT, node: 'net.layers' }), null);
  // 整份 payload 照常读得出来
  assert.equal(readLibrary({ workspace }).subjects.length, 1);
  // 版本号按原文算：写侧据此能拒绝覆盖一份坏文件（而不是当成「没有文件」直接盖掉）
  const version = attemptsVersion({ workspace, subject: SUBJECT, node: 'net.layers' });
  assert.match(version, /^[0-9a-f]{16}$/);
  const refused = writeAttempts(request(workspace, { expectedVersion: '0000000000000000' }));
  assert.equal(refused.status, 409);
  assert.equal(refused.error.code, 'version-conflict');
  assert.equal(fs.readFileSync(path.join(attemptsDir, '0001-net.layers.json'), 'utf8'), '{ 这不是 JSON', '坏文件没被覆盖');
});

test('题 id 不能是空串；一次最多 200 道题', () => {
  const { workspace } = makeSubject();
  const base = request(workspace);
  const emptyId = writeAttempts({ ...base, questions: { '   ': { 选: 0, 对: true } }, operationId: op('empty-id') });
  assert.equal(emptyId.status, 400);
  assert.equal(emptyId.error.code, 'questions-invalid');

  const many = {};
  for (let i = 0; i < 201; i++) many[`锚点#${i}`] = { 选: 0, 对: true };
  const tooMany = writeAttempts({ ...base, questions: many, operationId: op('many') });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.error.code, 'questions-invalid');
  assert.match(tooMany.error.message, /最多写 200 道题/);
});
