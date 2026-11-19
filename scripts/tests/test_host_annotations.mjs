/* 特征化测试：Host 半数据层 · lib/annotations.ts（课件页标注，ADR-0021）
   ────────────────────────────────────────────────────────────────────────
   钉住这些事（与总任务 ② 的验收项逐条对应）：
     1. **落盘形状**：`annotations/<NNNN>-<节点id>.json`，顶层 节点/课件/幂等键/最后写入/标，
        标注 id → 一条标注；版本号**不在文件里**（读写两侧按内容算）；
     2. **幂等**：同一个 operationId 重放只回原回执、不写第二遍（文件字节不变）；
        同一个 operationId 换内容 → 409 `operation-id-conflict`；
     3. **版本栅栏**：旧 expectedVersion → 409 `version-conflict`，回执带回当前标注与版本号；
     4. **全量替换语义**：整份数组进、Record 落盘；创建/编辑/删除都靠一次写入，空数组=清空但文件仍写出；
     5. **路径越界与坏请求**：subject 带 `/` `\` `..`、node 不匹配 NODE_ID_RE、无课件一律拒绝且不写盘；
     6. **读侧容错**：文件不在 readAnnotations 给 null、annotationsVersion 给非空基线；
        坏 JSON 读侧 null 但版本号非空（坏文件不会被静默当成「没有文件」直接盖掉）；
     7. **payload**：`node.annotations` = {present, version, items}，items 按 id 排序；
     8. **监听域**：`annotations/` 里的文件与目录本身都判 `['annotations']`；
     9. **schema 对账**：真落盘文件过 `lib/core/schema.ts` 的校验器零问题，坏形状逐条报。

   工作区在 fs.mkdtemp 造的临时目录里现造现弃（ADR-0009：仓库里不存样例数据）。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { annotationsVersion, readAnnotations, writeAnnotations } from '../../lib/annotations.ts';
import { readLibrary } from '../../lib/library.ts';
import { validateAgainstSchema } from '../../lib/core/schema.ts';
import { WATCH_DOMAINS, domainsOfPath } from '../../lib/watch/domains.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 与 lib/annotations.ts 的 versionOfText 同一口径：内容（按落盘序列化）的 sha256 前 16 位。 */
function versionOf(data) {
  return createHash('sha256').update(`${JSON.stringify(data, null, 2)}\n`).digest('hex').slice(0, 16);
}

/* ── 临时科目：跑完即弃 ───────────────────────────────────────────────── */

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
});

const SUBJECT = 'demo';
const NODE = 'net.layers';

/** 一份最小科目：一个节点、一份课件（标注与课件一一对应，编号从课件文件名取）。 */
function makeSubject() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-annotations-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  const subjectDir = path.join(workspace, '.learning', 'subjects', SUBJECT);
  fs.mkdirSync(path.join(subjectDir, 'lessons'), { recursive: true });
  fs.writeFileSync(path.join(subjectDir, 'subject.yaml'), 'slug: demo\nname: 标注\n');
  fs.writeFileSync(path.join(subjectDir, 'curriculum.yaml'), 'nodes:\n  - id: net.layers\n    title: 分层\n');
  fs.writeFileSync(path.join(subjectDir, 'progress.yaml'), 'updated_at: "2026-09-24"\nnodes: {}\nproject:\n  current: ""\n');
  fs.writeFileSync(path.join(subjectDir, 'lessons', '0001-net.layers.md'), '# 分层\n\n网络分四层。\n\n每层各管一段。\n');
  return { root, workspace, subjectDir, annotationsDir: path.join(subjectDir, 'annotations') };
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

/** 一条最普通的标注：第 3 行的段落块里 [2, 6) 这一段。 */
function annotation(overrides = {}) {
  return {
    id: 'a-1',
    note: '这里要回看',
    ranges: [{ line: 3, kind: 'para', hash: 'h-1', start: 2, end: 6 }],
    created: '2026-11-10T09:00:00.000Z',
    modified: '2026-11-10T09:00:00.000Z',
    ...overrides,
  };
}

/** 一次最普通的写入请求：整份标注数组（全量替换语义）。 */
function request(workspace, overrides = {}) {
  return {
    workspace,
    subject: SUBJECT,
    node: NODE,
    annotations: [annotation()],
    expectedVersion: annotationsVersion({ workspace, subject: SUBJECT, node: NODE }),
    operationId: op('write'),
    now: '2026-09-24T13:05:00.000Z',
    ...overrides,
  };
}

function readAt(workspace) {
  return readAnnotations({ workspace, subject: SUBJECT, node: NODE });
}

/* ── 落一份标注 ───────────────────────────────────────────────────────── */

test('落一份标注：回执、落盘形状与版本号', () => {
  const { workspace, annotationsDir } = makeSubject();
  const before = annotationsVersion({ workspace, subject: SUBJECT, node: NODE });
  assert.match(before, /^[0-9a-f]{16}$/, '还没标注也要有基线版本号，不能是空串');

  const result = writeAnnotations(request(workspace, {
    annotations: [annotation({ note: '  前后有空白  ' })],
  }));
  assert.equal(result.ok, true);
  assert.match(result.version, /^[0-9a-f]{16}$/);
  assert.notEqual(result.version, before, '版本号必须换一个：它就是下一次写入的栅栏');
  assert.equal(result.annotations['节点'], NODE);
  assert.equal(result.annotations['课件'], '0001-net.layers.md');
  assert.equal(result.annotations['最后写入'], '2026-09-24T13:05:00.000Z');
  assert.equal(typeof result.annotations['幂等键'], 'string');
  // note 只 trim 首尾空白，正文不改写
  assert.equal(result.annotations['标']['a-1'].note, '前后有空白');
  assert.deepEqual(result.annotations['标']['a-1'].ranges,
    [{ line: 3, kind: 'para', hash: 'h-1', start: 2, end: 6 }]);

  const file = path.join(annotationsDir, '0001-net.layers.json');
  const text = fs.readFileSync(file, 'utf8');
  const onDisk = JSON.parse(text);
  assert.deepEqual(onDisk, result.annotations, '回执就是盘上那一份，不是另拼的一个对象');
  assert.ok(text.endsWith('\n'), '末尾要有换行（与 attempts / 题库的落盘风格一致）');
  assert.equal(text, `${JSON.stringify(onDisk, null, 2)}\n`, '写盘缩进 2，与 attempts 一致');
  // 版本号**不在文件里**：它是读写两侧各自按内容算出来的（写进去就成了两个永远不相等的值）
  assert.equal(Object.hasOwn(onDisk, '版本'), false);
  assert.equal(result.version, versionOf(onDisk), '回执里的版本号必须等于按落盘内容算出来的那个');
  // 读回来的版本号与回执一致；路径落在 annotations/ 下
  const read = readAt(workspace);
  assert.equal(read.version, result.version);
  assert.deepEqual(read.data, result.annotations);
  assert.equal(read.file, file);
});

test('全量替换：第二份数组就是全部标注（旧的没被带进来，删光=空数组仍写出文件）', () => {
  const { workspace, annotationsDir } = makeSubject();
  const first = writeAnnotations(request(workspace, {
    annotations: [
      annotation({ id: 'a-1' }),
      annotation({ id: 'b-2', note: '第二条' }),
    ],
  }));
  assert.equal(first.ok, true);
  assert.deepEqual(Object.keys(first.annotations['标']), ['a-1', 'b-2'], '落盘按 id 升序');

  // 只留 b-2：a-1 就此消失——全量替换语义，删除靠「这次数组里没有它」表达
  const second = writeAnnotations(request(workspace, {
    annotations: [annotation({ id: 'b-2', note: '改过的第二条', modified: '2026-09-24T13:06:00.000Z' })],
    expectedVersion: first.version,
    operationId: op('replace'),
  }));
  assert.equal(second.ok, true);
  assert.deepEqual(Object.keys(second.annotations['标']), ['b-2']);
  assert.equal(second.annotations['标']['b-2'].note, '改过的第二条');
  assert.equal(JSON.parse(fs.readFileSync(path.join(annotationsDir, '0001-net.layers.json'), 'utf8'))['标']['a-1'], undefined);

  // 空数组 = 清空，但文件**仍写出**：「学生删光了」与「从来没标过」在盘上要分得开
  const cleared = writeAnnotations(request(workspace, {
    annotations: [],
    expectedVersion: second.version,
    operationId: op('clear'),
  }));
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.annotations['标'], {});
  assert.equal(fs.existsSync(path.join(annotationsDir, '0001-net.layers.json')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(annotationsDir, '0001-net.layers.json'), 'utf8'))['标'], {});

  // payload 里是「有文件、零条标注」：present=true 与 items=[] 同时成立
  const node = readLibrary({ workspace }).subjects[0].nodes[0];
  assert.equal(node.annotations.present, true);
  assert.deepEqual(node.annotations.items, []);
  assert.equal(node.annotations.version, cleared.version);
});

/* ── 1. 幂等与冲突 ────────────────────────────────────────────────────── */

test('同一个 operationId 重放只回原回执，不产生第二遍写入（文件字节不变、回执相等）', () => {
  const { workspace, annotationsDir } = makeSubject();
  // 同一次提交原样再发一遍：连 expectedVersion 都还是旧的那个
  const submission = request(workspace, { operationId: op('replay') });
  const first = writeAnnotations(submission);
  assert.equal(first.ok, true);

  const file = path.join(annotationsDir, '0001-net.layers.json');
  const bytesAfterFirst = fs.readFileSync(file);
  const filesAfterFirst = countFiles(annotationsDir);

  const replay = writeAnnotations(submission);
  assert.deepEqual(replay, first, '重放要原样回放上次的回执');
  assert.deepEqual(fs.readFileSync(file), bytesAfterFirst, '重放后文件**字节不变**');
  assert.equal(countFiles(annotationsDir), filesAfterFirst, '重放不许再写一个文件');

  // 去掉首尾空白后是同一个 id：双击时多一个空格也算同一次提交
  const padded = writeAnnotations({ ...submission, operationId: `  ${submission.operationId}  ` });
  assert.deepEqual(padded, first);
  assert.deepEqual(fs.readFileSync(file), bytesAfterFirst);
});

test('重放先于版本校验：第一次写成功后版本已经变了，重试仍要回放而不是报冲突', () => {
  const { workspace } = makeSubject();
  const submission = request(workspace, { operationId: op('replay-stale-version') });
  const first = writeAnnotations(submission);
  assert.equal(first.ok, true);
  // 重试带回来的是**写之前**那个版本号（已经过期）
  const replay = writeAnnotations({ ...submission, expectedVersion: '0000000000000000' });
  assert.equal(replay.ok, true, '重试不该被误判成版本冲突');
  assert.deepEqual(replay, first);
});

test('同一个 operationId 换内容：409 拒绝，并带回当前标注与版本号', () => {
  const { workspace, annotationsDir } = makeSubject();
  const operationId = op('op-conflict');
  const first = writeAnnotations(request(workspace, { operationId }));
  assert.equal(first.ok, true);
  const filesAfterFirst = countFiles(annotationsDir);

  const conflict = writeAnnotations(request(workspace, {
    operationId,
    annotations: [annotation({ note: '换了内容的同一次提交' })],
    expectedVersion: first.version,
  }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.error.code, 'operation-id-conflict');
  assert.equal(conflict.version, first.version);
  assert.deepEqual(conflict.annotations, first.annotations);
  assert.equal(countFiles(annotationsDir), filesAfterFirst, '这次不写盘');
});

test('旧 expectedVersion：409 拒绝并重读，不写盘；按带回的版本重来能成功', () => {
  const { workspace, annotationsDir } = makeSubject();
  // 甲先写：乙手上那个版本号从这一刻起就旧了
  const 甲 = writeAnnotations(request(workspace, {
    annotations: [annotation({ id: 'a-1', note: '甲写的' })],
    operationId: op('fence-jia'),
  }));
  assert.equal(甲.ok, true);
  const file = path.join(annotationsDir, '0001-net.layers.json');
  const bytes = fs.readFileSync(file);

  const 乙 = writeAnnotations(request(workspace, {
    annotations: [annotation({ id: 'b-2', note: '乙写的' })],
    expectedVersion: '0000000000000000',   // 乙手里那份过期快照
    operationId: op('fence-stale'),
  }));
  assert.equal(乙.ok, false);
  assert.equal(乙.status, 409);
  assert.equal(乙.error.code, 'version-conflict');
  // 拒绝时不引入文件锁，而是把当前标注与版本号一起带回去（ADR-0007 的「拒绝并重读」）
  assert.equal(乙.version, 甲.version);
  assert.deepEqual(乙.annotations, 甲.annotations, '带回去的就是甲写的那份，乙的数据没丢也没覆盖');
  assert.deepEqual(fs.readFileSync(file), bytes, '被拒绝的那次不写盘');

  // 乙按新版本重来：这次成功；全量替换语义下盘上就是乙这一份
  const retried = writeAnnotations(request(workspace, {
    annotations: [annotation({ id: 'b-2', note: '乙写的' })],
    expectedVersion: 乙.version,
    operationId: op('fence-retry'),
  }));
  assert.equal(retried.ok, true);
  assert.deepEqual(Object.keys(retried.annotations['标']), ['b-2']);
  assert.equal(retried.annotations['标']['b-2'].note, '乙写的');
});

/* ── 请求体校验的顺序与判词 ───────────────────────────────────────────── */

test('坏请求先过一遍：operationId 缺失/超长、annotations 不是数组、没带 expectedVersion', () => {
  const { workspace, annotationsDir } = makeSubject();
  const base = request(workspace);

  for (const operationId of [undefined, '', '   ', 'x'.repeat(201)]) {
    const result = writeAnnotations({ ...base, operationId });
    assert.equal(result.status, 400, JSON.stringify(operationId));
    assert.equal(result.error.code, 'operation-id-invalid');
  }
  for (const annotations of [undefined, null, {}, 'x']) {
    const result = writeAnnotations({ ...base, annotations, operationId: op('annotations') });
    assert.equal(result.status, 400, JSON.stringify(annotations));
    assert.equal(result.error.code, 'annotations-invalid');
  }
  for (const expectedVersion of [undefined, null, '', '   ']) {
    const result = writeAnnotations({ ...base, expectedVersion, operationId: op('no-version') });
    assert.equal(result.status, 400);
    assert.equal(result.error.code, 'expected-version-required');
    assert.match(result.error.message, /payload/, '拒绝理由要说清去哪儿拿版本号');
  }
  assert.equal(countFiles(annotationsDir), 0, '坏请求一律不写盘');

  // 坏请求不该占用一个 id：同一个 id 之后用来写正式内容仍然成功
  const good = writeAnnotations({ ...base, operationId: 'x'.repeat(200) });
  assert.equal(good.ok, true, '200 个字符是上限之内');
});

test('标注形状逐条拦：id / note / ranges / 区间字段 —— 一律 400 annotations-invalid 且不写盘', () => {
  const { workspace, annotationsDir } = makeSubject();
  const base = request(workspace);
  const range = (overrides = {}) => ({ line: 3, kind: 'para', hash: 'h-1', start: 2, end: 6, ...overrides });
  const cases = [
    ['条目不是对象', [null]],
    ['id 是空串', [annotation({ id: '   ' })]],
    ['id 重复', [annotation({ id: 'same' }), annotation({ id: ' same ' })]],
    ['note 不是字符串', [annotation({ note: 42 })]],
    ['note 太长', [annotation({ note: 'x'.repeat(20001) })]],
    ['ranges 不是数组', [annotation({ ranges: 'x' })]],
    ['ranges 是空的', [annotation({ ranges: [] })]],
    ['ranges 太多', [annotation({ ranges: Array.from({ length: 21 }, () => range()) })]],
    ['range 不是对象', [annotation({ ranges: [null] })]],
    ['line 不是 >=1 的整数', [annotation({ ranges: [range({ line: 0 })] })]],
    ['kind 是空串', [annotation({ ranges: [range({ kind: '  ' })] })]],
    ['hash 是空串', [annotation({ ranges: [range({ hash: '' })] })]],
    ['start 是负数', [annotation({ ranges: [range({ start: -1 })] })]],
    ['end 小于 start', [annotation({ ranges: [range({ start: 6, end: 2 })] })]],
    ['created 不是字符串', [annotation({ created: 1 })]],
    ['modified 不是字符串', [annotation({ modified: null })]],
  ];
  for (const [label, annotations] of cases) {
    const result = writeAnnotations({ ...base, annotations, operationId: op('shape') });
    assert.equal(result.status, 400, label);
    assert.equal(result.error.code, 'annotations-invalid', label);
    assert.equal(typeof result.error.message, 'string', label);
    assert.notEqual(result.error.message, '', `${label}：拒绝必须带一句能给学生看的话`);
  }

  // 数量上限：一条课件最多 500 条
  const many = Array.from({ length: 501 }, (_, index) => annotation({ id: `a-${index}` }));
  const tooMany = writeAnnotations({ ...base, annotations: many, operationId: op('many') });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.error.code, 'annotations-invalid');
  assert.match(tooMany.error.message, /最多写 500 条/);
  assert.equal(countFiles(annotationsDir), 0, '形状不对的一律不写盘');
});

test('科目、节点与课件都要对得上：subject-invalid / node-invalid / lesson-missing', () => {
  const { workspace, annotationsDir } = makeSubject();
  const base = request(workspace);

  for (const subject of [undefined, '', '演示/科目', '演示\\科目', '..', '查无此科目']) {
    const result = writeAnnotations({ ...base, subject, operationId: op('subject') });
    assert.equal(result.status, 400, JSON.stringify(subject));
    assert.equal(result.error.code, 'subject-invalid');
  }
  // 节点 id 的写法与 curriculum.schema.json 的 nodes[].id 一致：大写、斜杠、.. 都不行
  for (const node of [undefined, '', 'Net.Layers', '../net.layers', 'net/layers', 'net layers']) {
    const result = writeAnnotations({ ...base, node, operationId: op('node') });
    assert.equal(result.status, 400, JSON.stringify(node));
    assert.equal(result.error.code, 'node-invalid');
  }
  // 节点合法但课件不在：标注与课件一一对应，不先造一份空档案
  const missing = writeAnnotations({ ...base, node: 'net.tcp', operationId: op('lesson') });
  assert.equal(missing.status, 400);
  assert.equal(missing.error.code, 'lesson-missing');
  assert.equal(countFiles(annotationsDir), 0);
});

/* ── 读侧：缺失、坏文件、路径越界 ─────────────────────────────────────── */

test('没有标注文件时读得进：readAnnotations 给 null，版本号仍是可用基线', () => {
  const { workspace } = makeSubject();
  assert.equal(readAt(workspace), null);
  assert.match(annotationsVersion({ workspace, subject: SUBJECT, node: NODE }), /^[0-9a-f]{16}$/);
  // 科目/节点不合法时给空串（调用方据此判「读不到」）
  assert.equal(annotationsVersion({ workspace, subject: '../越界', node: NODE }), '');
  assert.equal(annotationsVersion({ workspace, subject: SUBJECT, node: '不存在' }), '');
  assert.equal(readAnnotations({ workspace, subject: SUBJECT, node: '不存在' }), null);
  assert.equal(readAnnotations({ workspace, subject: SUBJECT, node: '../net.layers' }), null);
  assert.equal(readAnnotations({ workspace, subject: '演示/科目', node: NODE }), null);
});

test('写坏的标注文件不当场炸：读侧 null、版本号按原文算，坏文件不被静默覆盖', () => {
  const { workspace, annotationsDir } = makeSubject();
  fs.mkdirSync(annotationsDir, { recursive: true });
  const file = path.join(annotationsDir, '0001-net.layers.json');
  fs.writeFileSync(file, '{ 这不是 JSON');
  assert.equal(readAt(workspace), null);
  // 整份 payload 照常读得出来，只是这个节点报「没有标注」
  const node = readLibrary({ workspace }).subjects[0].nodes[0];
  assert.equal(node.annotations.present, false);
  assert.deepEqual(node.annotations.items, []);
  // 版本号按原文算：写侧据此能拒绝覆盖一份坏文件（而不是当成「没有文件」直接盖掉）
  const version = annotationsVersion({ workspace, subject: SUBJECT, node: NODE });
  assert.match(version, /^[0-9a-f]{16}$/);
  const refused = writeAnnotations(request(workspace, { expectedVersion: '0000000000000000' }));
  assert.equal(refused.status, 409);
  assert.equal(refused.error.code, 'version-conflict');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ 这不是 JSON', '坏文件没被覆盖');

  // 拿着按原文算出来的版本号来写 = 明确表示「我知道它是坏的，我修」：这次允许覆盖
  const repaired = writeAnnotations(request(workspace, { expectedVersion: version, operationId: op('repair') }));
  assert.equal(repaired.ok, true);
  assert.deepEqual(readAt(workspace).data, repaired.annotations);
});

test('形状不对（顶层不是对象）也当读不到：坏文件不抛、不崩载荷', () => {
  const { workspace, annotationsDir } = makeSubject();
  fs.mkdirSync(annotationsDir, { recursive: true });
  fs.writeFileSync(path.join(annotationsDir, '0001-net.layers.json'), '[1, 2, 3]\n');
  assert.equal(readAt(workspace), null);
  assert.match(annotationsVersion({ workspace, subject: SUBJECT, node: NODE }), /^[0-9a-f]{16}$/);
  assert.equal(readLibrary({ workspace }).subjects.length, 1);
});

/* ── payload：node.annotations ────────────────────────────────────────── */

test('payload 里带标注与版本号：present / version / items（items 按 id 升序）', () => {
  const { workspace } = makeSubject();

  // 没标过：present=false，但版本号仍是可用的基线（第一次标注要带上它）
  const before = readLibrary({ workspace }).subjects[0].nodes[0];
  assert.equal(before.annotations.present, false);
  assert.match(before.annotations.version, /^[0-9a-f]{16}$/);
  assert.deepEqual(before.annotations.items, []);

  // 写两条（数组顺序故意 b、a 颠倒）：payload 按 id 升序给出去
  const written = writeAnnotations(request(workspace, {
    annotations: [
      annotation({ id: 'b-2', note: '第二条' }),
      annotation({ id: 'a-1', note: '第一条' }),
    ],
    operationId: op('payload'),
  }));
  assert.equal(written.ok, true);

  const after = readLibrary({ workspace }).subjects[0].nodes[0];
  assert.equal(after.annotations.present, true);
  assert.equal(after.annotations.version, written.version);
  assert.deepEqual(after.annotations.items.map((one) => one.id), ['a-1', 'b-2']);
  assert.deepEqual(after.annotations.items, Object.values(written.annotations['标']).sort((a, b) => (a.id < b.id ? -1 : 1)));
  assert.deepEqual(after.annotations.items[0], annotation({ id: 'a-1', note: '第一条' }));
});

/* ── 监听域：annotations 自成一域 ─────────────────────────────────────── */

test('监听域：annotations/ 里的文件与目录本身都判成 annotations 域', () => {
  assert.ok(WATCH_DOMAINS.includes('annotations'), 'WATCH_DOMAINS 里要有 annotations（阅读端与真 DSH 探针按它断言）');
  // 文件（宿主按目录粒度给也行，两种都要认）
  assert.deepEqual(domainsOfPath('.learning/subjects/demo/annotations/0001-net.layers.json'), ['annotations']);
  // 目录本身变了：与 attempts / lessons 同一口径
  assert.deepEqual(domainsOfPath('.learning/subjects/demo/annotations'), ['annotations']);
  // Windows 上 fs.watch 给的是反斜杠
  assert.deepEqual(domainsOfPath('.learning\\subjects\\demo\\annotations\\0001-net.layers.json'), ['annotations']);
  // 不能借走 attempts 的名分（两者是各自独立的一片）
  assert.deepEqual(domainsOfPath('.learning/subjects/demo/attempts/0001-net.layers.json'), ['attempts']);
});

/* ── schema 对账 ──────────────────────────────────────────────────────── */

test('schema 与落盘形状对账：真文件过校验器零问题，坏形状逐条报', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas/annotations.schema.json'), 'utf8'));
  assert.equal(schema.title, 'Annotations');
  assert.deepEqual(schema.required, ['节点', '课件', '最后写入', '标']);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['幂等键', '最后写入', '标', '节点', '课件'].sort());
  const mark = schema.properties['标'].additionalProperties;
  assert.deepEqual(mark.required, ['id', 'note', 'ranges', 'created', 'modified']);
  const range = mark.properties.ranges.items;
  assert.deepEqual(range.required, ['line', 'kind', 'hash', 'start', 'end']);
  assert.equal(range.additionalProperties, false);
  assert.equal(range.properties.line.minimum, 1);
  assert.equal(range.properties.start.minimum, 0);
  assert.equal(range.properties.end.minimum, 0);

  const { workspace, annotationsDir } = makeSubject();
  const written = writeAnnotations(request(workspace, { operationId: op('schema') }));
  assert.equal(written.ok, true);

  // 真实落盘文件：零问题
  const onDisk = JSON.parse(fs.readFileSync(path.join(annotationsDir, '0001-net.layers.json'), 'utf8'));
  assert.deepEqual(validateAgainstSchema(onDisk, schema), []);

  // 缺顶层必填字段
  const missing = { 节点: NODE, 课件: '0001-net.layers.md' };
  assert.ok(validateAgainstSchema(missing, schema).some((problem) => problem.keyword === 'required'));

  // 区间字段越界 + range 额外字段：逐条报出来（不是静默放行）
  const badRange = {
    节点: NODE,
    课件: '0001-net.layers.md',
    最后写入: '2026-09-24T13:05:00.000Z',
    标: {
      'a-1': {
        id: 'a-1', note: '', created: 'x', modified: 'x',
        ranges: [{ line: 0, kind: 'para', hash: 'h-1', start: 0, end: 1, extra: true }],
      },
    },
  };
  const problems = validateAgainstSchema(badRange, schema);
  assert.ok(problems.some((problem) => problem.keyword === 'minimum'), 'line 0 要被 minimum 拦下');
  assert.ok(problems.some((problem) => problem.keyword === 'additionalProperties'), 'range 的额外字段要被拦下');
});

/* ── 不碰课件正文 ─────────────────────────────────────────────────────── */

test('标注绝不写回课件：.md 逐字不变，只落在 annotations/ 一个文件里', () => {
  const { workspace, subjectDir, annotationsDir } = makeSubject();
  const lesson = path.join(subjectDir, 'lessons', '0001-net.layers.md');
  const before = fs.readFileSync(lesson);

  const first = writeAnnotations(request(workspace));
  assert.equal(first.ok, true);
  const second = writeAnnotations(request(workspace, {
    annotations: [],
    expectedVersion: first.version,
    operationId: op('clear'),
  }));
  assert.equal(second.ok, true);

  assert.deepEqual(fs.readFileSync(lesson), before, '课件正文必须逐字不变（ADR-0021 / ADR-0007）');
  assert.deepEqual(fs.readdirSync(path.join(subjectDir, 'lessons')), ['0001-net.layers.md']);
  assert.deepEqual(fs.readdirSync(annotationsDir), ['0001-net.layers.json'], '标注只落在 annotations/ 一个文件里');
});
