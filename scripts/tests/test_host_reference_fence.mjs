/* 特征化测试：Host 半数据层 · lib/reference.ts 的写入栅栏
   ────────────────────────────────────────────────────────────────────────
   钉住三件事：operationId 幂等重放只回放原回执、expectedVersion 对不上就拒绝、
   校验顺序与拒绝码。断言只看 writeReference 的返回值与 reference/ 里的文件数，
   不看内部台账结构——后续把 .mjs 改写成 TypeScript 时这个套件应当原样通过。
   数据在 fs.mkdtemp 造的临时目录里现造现弃。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { listReference, readReference, referenceVersion, writeReference } from '../../lib/reference.ts';
import { readLibrary } from '../../lib/library.ts';

/* ── 临时科目：跑完即弃 ───────────────────────────────────────────────── */

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
});

const SUBJECT = 'demo';

function makeSubject() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-host-reference-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  const subjectDir = path.join(workspace, '.learning', 'subjects', SUBJECT);
  fs.mkdirSync(subjectDir, { recursive: true });
  fs.writeFileSync(path.join(subjectDir, 'subject.yaml'), 'slug: demo\nname: 资料\n');
  fs.writeFileSync(path.join(subjectDir, 'curriculum.yaml'), 'nodes:\n  - id: 变量\n    title: 变量\n');
  return { root, workspace, subjectDir, referenceDir: path.join(subjectDir, 'reference') };
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

/* ── 落一份资料 ───────────────────────────────────────────────────────── */

test('落一份学生资料：回执、落盘内容与来源标记', () => {
  const { workspace, subjectDir, referenceDir } = makeSubject();
  const before = referenceVersion({ workspace, subject: SUBJECT });

  const result = writeReference({
    workspace,
    subject: SUBJECT,
    title: '我的讲义',
    markdown: '正文第一行\n',
    expectedVersion: before,
    operationId: op('first'),
    now: '2026-05-06T07:08:09.000Z',
  });

  assert.equal(result.ok, true);
  const { bytes, ...entry } = result.entry;
  assert.deepEqual(entry, {
    path: '我的讲义.md',
    name: '我的讲义.md',
    title: '我的讲义',
    ext: '.md',
    source: 'learner',
    added_at: '2026-05-06T07:08:09.000Z',
  });
  // 字节数从盘上量，不从模块的返回值里抄
  assert.equal(bytes, fs.statSync(path.join(referenceDir, '我的讲义.md')).size);
  // 版本号必须换了一个：它就是下一次写入的栅栏
  assert.notEqual(result.version, before);
  assert.match(result.version, /^[0-9a-f]{16}$/);
  assert.deepEqual(result.reference, [result.entry]);

  const text = fs.readFileSync(path.join(referenceDir, '我的讲义.md'), 'utf8');
  assert.ok(text.startsWith('---\n'));
  assert.equal(text.split('\n').filter((line) => line === 'source: learner').length, 1);
  assert.ok(text.endsWith('正文第一行\n'), '正文原样落盘，末尾补一个换行');
});

test('payload 里的 reference / reference_version 与写入端同源', () => {
  const { workspace } = makeSubject();
  writeReference({
    workspace,
    subject: SUBJECT,
    title: '甲',
    markdown: '甲正文\n',
    expectedVersion: referenceVersion({ workspace, subject: SUBJECT }),
    operationId: op('same-source'),
    now: 0,
  });

  const [subject] = readLibrary({ workspace }).subjects;
  const listed = listReference({ subjectDir: path.join(workspace, '.learning', 'subjects', SUBJECT) });
  assert.deepEqual(subject.reference, listed.entries);
  assert.equal(subject.reference_version, listed.version);
  assert.equal(subject.reference_version, referenceVersion({ workspace, subject: SUBJECT }));
});

test('空目录也有版本号：第一次写入能带上它，之后版本就变了', () => {
  const { workspace } = makeSubject();
  const empty = referenceVersion({ workspace, subject: SUBJECT });
  assert.match(empty, /^[0-9a-f]{16}$/, '空清单的版本号不能是空串');

  const written = writeReference({
    workspace, subject: SUBJECT, title: '甲', markdown: '甲\n',
    expectedVersion: empty, operationId: op('empty-first'), now: 0,
  });
  assert.equal(written.ok, true);
  assert.notEqual(written.version, empty);
});

test('标题里的引号与换行折成一行，不会插出一行假的来源标记', () => {
  const { workspace, referenceDir } = makeSubject();
  const title = '坏"\nsource: agent';
  const result = writeReference({
    workspace, subject: SUBJECT, title, markdown: '正文\n',
    expectedVersion: referenceVersion({ workspace, subject: SUBJECT }),
    operationId: op('injection'), now: 0,
  });

  assert.equal(result.ok, true);
  // 换行与制表符折成一个空格；标题整体还是那一个值
  assert.equal(result.entry.title, '坏" source: agent');
  assert.equal(result.entry.source, 'learner');
  const text = fs.readFileSync(path.join(referenceDir, result.entry.path), 'utf8');
  assert.equal(text.split('\n').filter((line) => line.startsWith('source:')).length, 1,
    '标题里的换行不许再插出一行 source:');
});

/* ── operationId 幂等 ─────────────────────────────────────────────────── */

test('同一个 operationId 重放只回原回执，不落第二条记录', () => {
  const { workspace, referenceDir } = makeSubject();
  const request = {
    workspace, subject: SUBJECT, title: '讲义', markdown: '正文\n',
    expectedVersion: referenceVersion({ workspace, subject: SUBJECT }),
    operationId: op('replay'), now: 0,
  };
  const first = writeReference(request);
  assert.equal(first.ok, true);
  const filesAfterFirst = countFiles(referenceDir);

  // 双击／超时重试：连 expectedVersion 都还是旧的那个
  const replay = writeReference(request);
  assert.deepEqual(replay, first, '重放要原样回放上次的回执');
  assert.equal(countFiles(referenceDir), filesAfterFirst, '重放不许再写一个文件');
  // 断言的是 reference/ 里的落盘文件名，不是临时目录名：撞名换用 -2/-3 后缀
  // （见 lib/reference.ts 的 continue），所以逐项看 basename 有没有多出带 -2 的副本。
  // 原写法用 referenceDir.includes('-2') 顺手检查了整条路径，而 mkdtemp 的随机后缀
  // 以 '2' 开头时那条路径自己就带 '-2'，于是这条断言按临时目录名碰运气地假红。
  assert.deepEqual(
    fs.readdirSync(referenceDir).map((name) => path.basename(name)).filter((name) => name.includes('-2')),
    [],
    '重放不许落一个带 -2 后缀的副本文件',
  );
  assert.equal(fs.existsSync(path.join(referenceDir, '讲义-2.md')), false);

  // 去掉首尾空白后是同一个 id：双击时多一个空格也算同一次提交
  const padded = writeReference({ ...request, operationId: `  ${request.operationId}  ` });
  assert.deepEqual(padded, first);
  assert.equal(countFiles(referenceDir), filesAfterFirst);
});

test('重放先于版本校验：第一次写成功后版本已经变了，重试仍要回放而不是报冲突', () => {
  const { workspace } = makeSubject();
  const request = {
    workspace, subject: SUBJECT, title: '讲义', markdown: '正文\n',
    expectedVersion: referenceVersion({ workspace, subject: SUBJECT }),
    operationId: op('replay-stale-version'), now: 0,
  };
  const first = writeReference(request);
  assert.equal(first.ok, true);

  const replay = writeReference(request);
  assert.equal(replay.ok, true, '重试不该被误判成版本冲突');
  assert.deepEqual(replay, first);
});

test('同一个 operationId 换内容：409 拒绝，并带回当前清单与版本号', () => {
  const { workspace, referenceDir } = makeSubject();
  const operationId = op('op-conflict');
  const first = writeReference({
    workspace, subject: SUBJECT, title: '讲义', markdown: '第一版\n',
    expectedVersion: referenceVersion({ workspace, subject: SUBJECT }),
    operationId, now: 0,
  });
  assert.equal(first.ok, true);
  const filesAfterFirst = countFiles(referenceDir);

  const conflict = writeReference({
    workspace, subject: SUBJECT, title: '讲义', markdown: '第二版\n',
    expectedVersion: first.version, operationId, now: 0,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.error.code, 'operation-id-conflict');
  // 冲突时一并给回当前清单与版本号，界面不必再跑一趟
  assert.deepEqual(conflict.reference, first.reference);
  assert.equal(conflict.version, first.version);
  assert.equal(countFiles(referenceDir), filesAfterFirst, '这次不写盘');
});

test('没有 operationId、或者它长得离谱：400 拒绝，且不占用一个 id', () => {
  const { workspace, referenceDir } = makeSubject();
  const base = {
    workspace, subject: SUBJECT, title: '讲义', markdown: '正文\n',
    expectedVersion: referenceVersion({ workspace, subject: SUBJECT }), now: 0,
  };

  for (const operationId of [undefined, '', '   ', 'x'.repeat(201)]) {
    const result = writeReference({ ...base, operationId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error.code, 'operation-id-invalid');
  }
  assert.equal(countFiles(referenceDir), 0, '坏请求不写盘');

  // 坏请求不该占用一个 id：同一个 id 之后用来写正式内容仍然成功
  const good = writeReference({ ...base, operationId: 'x'.repeat(200) });
  assert.equal(good.ok, true, '200 个字符是上限之内');
});

/* ── expectedVersion 栅栏 ─────────────────────────────────────────────── */

test('expectedVersion 对不上就拒绝，并重读当前清单带回去', () => {
  const { workspace, referenceDir } = makeSubject();
  // 甲先写：乙手上那个版本号从这一刻起就旧了
  const 甲 = writeReference({
    workspace, subject: SUBJECT, title: '甲的资料', markdown: '甲\n',
    expectedVersion: referenceVersion({ workspace, subject: SUBJECT }),
    operationId: op('fence-jia'), now: 0,
  });
  assert.equal(甲.ok, true);

  const 乙 = writeReference({
    workspace, subject: SUBJECT, title: '乙的资料', markdown: '乙\n',
    expectedVersion: '0000000000000000', // 乙手里那份过期快照
    operationId: op('fence-stale'), now: 0,
  });
  assert.equal(乙.ok, false);
  assert.equal(乙.status, 409);
  assert.equal(乙.error.code, 'version-conflict');
  // 拒绝时不引入文件锁，而是把当前清单与版本号一起带回去（对齐 ADR-0010 的「拒绝并重读」）
  assert.deepEqual(乙.reference, 甲.reference);
  assert.equal(乙.version, 甲.version);
  assert.deepEqual(乙.reference.map((entry) => entry.path), ['甲的资料.md']);
  assert.equal(countFiles(referenceDir), 1, '被拒绝的那次不写盘');

  // 乙按新清单重来：这次成功
  const retried = writeReference({
    workspace, subject: SUBJECT, title: '乙的资料', markdown: '乙\n',
    expectedVersion: 乙.version, operationId: op('fence-retry'), now: 0,
  });
  assert.equal(retried.ok, true);
  assert.deepEqual(retried.reference.map((entry) => entry.path).sort(), ['乙的资料.md', '甲的资料.md']);
});

test('没带 expectedVersion：400 拒绝，宁可不给写也不让过期提交静默盖掉别人的', () => {
  const { workspace, referenceDir } = makeSubject();
  const base = {
    workspace, subject: SUBJECT, title: '讲义', markdown: '正文\n',
    operationId: op('no-version'), now: 0,
  };
  for (const expectedVersion of [undefined, null, '', '   ']) {
    const result = writeReference({ ...base, expectedVersion });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error.code, 'expected-version-required');
  }
  assert.equal(countFiles(referenceDir), 0);
});

/* ── 请求体校验的顺序与判词 ───────────────────────────────────────────── */

test('科目名不合法或科目不存在：400 subject-invalid', () => {
  const { workspace } = makeSubject();
  const base = {
    workspace, title: '讲义', markdown: '正文\n',
    expectedVersion: referenceVersion({ workspace, subject: SUBJECT }),
    operationId: op('subject'), now: 0,
  };
  for (const subject of [undefined, '', '演示/科目', '演示\\科目', '..', '../demo', '/etc']) {
    const result = writeReference({ ...base, subject });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error.code, 'subject-invalid');
  }
  const missing = writeReference({ ...base, subject: '查无此科目' });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 400);
  assert.equal(missing.error.code, 'subject-invalid');
  assert.match(missing.error.message, /科目不存在/);
});

test('标题与正文的判词：空标题、超长标题、空正文各自 400', () => {
  const { workspace } = makeSubject();
  const version = referenceVersion({ workspace, subject: SUBJECT });
  const base = { workspace, subject: SUBJECT, expectedVersion: version, now: 0 };

  const cases = [
    [{ title: undefined, markdown: '正文' }, 'title-invalid'],
    [{ title: '   ', markdown: '正文' }, 'title-invalid'],
    [{ title: '标'.repeat(121), markdown: '正文' }, 'title-invalid'],
    [{ title: '  标  '.repeat(80), markdown: '正文' }, 'title-invalid'], // 折行后仍超长：159 字
    [{ title: '标题', markdown: undefined }, 'markdown-invalid'],
    [{ title: '标题', markdown: ' \n\t ' }, 'markdown-invalid'],
    [{ title: '标题', markdown: 42 }, 'markdown-invalid'],
  ];
  for (const [fields, error] of cases) {
    const result = writeReference({ ...base, ...fields, operationId: op('body') });
    assert.equal(result.ok, false, `${JSON.stringify(fields)} 应当被拒绝`);
    assert.equal(result.status, 400);
    assert.equal(result.error.code, error);
  }
  // 120 字正好是上限之内
  const atLimit = writeReference({ ...base, title: '标'.repeat(120), markdown: '正文', operationId: op('limit') });
  assert.equal(atLimit.ok, true);
});

test('坏请求先于科目校验：没 operationId 时连科目都不用看', () => {
  const { workspace } = makeSubject();
  const result = writeReference({
    workspace, subject: '../越界', title: '讲义', markdown: '正文\n',
    expectedVersion: 'whatever', operationId: '',
  });
  assert.equal(result.error.code, 'operation-id-invalid', '请求体先过一遍，坏请求不该占用一个 operationId');
});

/* ── 同名换号 ─────────────────────────────────────────────────────────── */

test('同名标题不覆盖：第二份落到 -2，顺序稳定', () => {
  const { workspace, referenceDir } = makeSubject();
  for (const body of ['第一版\n', '第二版\n']) {
    const result = writeReference({
      workspace, subject: SUBJECT, title: '同名讲义', markdown: body,
      expectedVersion: referenceVersion({ workspace, subject: SUBJECT }),
      operationId: op('collision'), now: 0,
    });
    assert.equal(result.ok, true);
  }
  assert.deepEqual(fs.readdirSync(referenceDir).sort(), ['同名讲义-2.md', '同名讲义.md']);
  assert.equal(readReference({ workspace, subject: SUBJECT, relPath: '同名讲义.md' }).text.includes('第一版'), true);
  assert.equal(readReference({ workspace, subject: SUBJECT, relPath: '同名讲义-2.md' }).text.includes('第二版'), true);
});

test('标题清成一个空名字时用兜底文件名，不让写入失败', () => {
  const { workspace } = makeSubject();
  const result = writeReference({
    workspace, subject: SUBJECT, title: '...', markdown: '正文\n',
    expectedVersion: referenceVersion({ workspace, subject: SUBJECT }),
    operationId: op('fallback-stem'), now: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.entry.path, '参考资料.md');
  // 标题仍然是学生写的那个，只是文件名换了兜底
  assert.equal(result.entry.title, '...');
});
