/* 进度校验与科目校验（lib/core/validate.ts 的 validateProgress / validateSubject）的逐条断言。
   ────────────────────────────────────────────────────────────────────────
   这两类的验收口径是「schema 与**取值**」。schema 管形状，这一层补三件 schema 表达不了的：

     - 旧六档词表读到就映射，但要说出来（否则「写回时状态会变」没人知道为什么）；
     - 空串：`name: ""` 是合法 JSON，却是个没有名字的科目；
     - 跨文档引用：progress 里的节点 id 在大纲里存不存在。

   夹具是内联 YAML 文本，行号写死——这一层报的行号必须与文本对得上。 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { validateProgress, validateSubject } from '../../lib/core/validate.ts';
import { parseYaml } from '../../lib/yaml.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROGRESS_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'progress.schema.json'), 'utf8'));
const SUBJECT_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'subject.schema.json'), 'utf8'));

const fixture = (text) => parseYaml(text, { file: '内存夹具' });
const messages = (report) => report.problems.map((problem) => problem.message);
const find = (report, needle) => report.problems.find((problem) => problem.message.includes(needle));

/* ── 一、进度：旧六档读到就映射，但要说出来 ───────────────────────────── */

const LEGACY_PROGRESS = [
  'updated_at: "2026-09-24T21:05:00+08:00"',   // 1
  'nodes:',                                    // 2
  '  a.one:',                                  // 3
  '    status: 未开始',                         // 4
  '    mastery: 0',                            // 5
  '  a.two:',                                  // 6
  '    status: 学习中',                         // 7
  '    mastery: 0.2',                          // 8
  '  b.one:',                                  // 9
  '    status: 初步理解',                       // 10
  '    mastery: 0.5',                          // 11
  '  b.two:',                                  // 12
  '    status: 能独立应用',                     // 13
  '    mastery: 0.8',                          // 14
  '  b.three:',                                // 15
  '    status: 需要复习',                       // 16
  '    mastery: 0.6',                          // 17
  '  b.four:',                                 // 18
  '    status: 已通过项目验证',                  // 19
  '    mastery: 0.9',                          // 20
  'misconceptions: []',                        // 21
  'project:',                                  // 22
  '  current: "项目一"',                        // 23
  '',
].join('\n');

test('旧六档里会变的那四档逐条报出来，不变的两档不报', () => {
  const report = validateProgress({
    file: 'demo/progress.yaml',
    text: LEGACY_PROGRESS,
    value: fixture(LEGACY_PROGRESS),
    schema: PROGRESS_SCHEMA,
  });
  const hints = report.problems.filter((problem) => problem.message.includes('旧六档词表'));
  assert.deepEqual(
    hints.map((problem) => `${problem.line}:${problem.message.match(/「(.*?)」属旧六档/)[1]}`),
    ['10:初步理解', '13:能独立应用', '16:需要复习', '19:已通过项目验证'],
  );
  for (const hint of hints) {
    assert.equal(hint.blocking, false, '迁移提示不该阻断');
    assert.match(hint.message, /写回时映射为「(学习中|已学完)」/);
    assert.equal(hint.file, 'demo/progress.yaml');
  }
  // 未开始 / 学习中 映射到自身，不用提示
  assert.equal(hints.some((hint) => hint.message.includes('「未开始」属旧六档')), false);
  assert.equal(hints.some((hint) => hint.message.includes('「学习中」属旧六档')), false);
  assert.equal(report.blocking, false, JSON.stringify(messages(report)));
});

test('进度：引用完整性——进度里出现大纲没有的节点要拦住，缺席的只提示', () => {
  const text = LEGACY_PROGRESS;
  const report = validateProgress({
    file: 'progress.yaml',
    text,
    value: fixture(text),
    schema: PROGRESS_SCHEMA,
    knownNodeIds: ['a.one', 'a.two', 'b.one', 'b.two', 'b.three', 'c.missing'],
  });
  const stray = report.problems.filter((problem) => problem.message.includes('大纲没有的节点'));
  assert.equal(stray.length, 1);
  assert.match(stray[0].message, /大纲没有的节点 b\.four/);
  assert.equal(stray[0].line, 18, '行号指向那个多余的节点键');
  assert.equal(stray[0].blocking, true);

  const absent = find(report, '大纲里有、进度里没有的节点');
  assert.equal(absent.blocking, false);
  assert.match(absent.message, /c\.missing/);
});

test('进度：不给 knownNodeIds 就不做引用检查（单文件也能校验）', () => {
  const report = validateProgress({
    file: 'progress.yaml',
    text: LEGACY_PROGRESS,
    value: fixture(LEGACY_PROGRESS),
    schema: PROGRESS_SCHEMA,
  });
  assert.equal(report.problems.some((problem) => problem.message.includes('大纲没有的节点')), false);
  assert.equal(report.problems.some((problem) => problem.message.includes('大纲里有')), false);
});

test('进度：不在任何一版词表里的状态要说清后果（会被保守当成未开始）', () => {
  const text = [
    'updated_at: "2026-09-24T21:05:00+08:00"',
    'nodes:',
    '  a:',
    '    status: 学会了',
    '    mastery: 0.5',
    'misconceptions: []',
    'project:',
    '  current: ""',
  ].join('\n');
  const report = validateProgress({ file: 'progress.yaml', text, value: fixture(text), schema: PROGRESS_SCHEMA });
  const unknown = find(report, '不在任何一版词表里');
  assert.equal(unknown.line, 4);
  assert.equal(unknown.blocking, false);
  // schema 的 enum 也要报一次，而且算阻断
  assert.ok(find(report, '不在允许值'));
  assert.equal(report.blocking, true);
});

test('进度：schema 违规逐条带行号（format / enum / 缺字段）', () => {
  const text = [
    'updated_at: "2026-09-24"',   // 1  ← 不是 date-time
    'nodes:',                     // 2
    '  a:',                       // 3
    '    status: 学会了',          // 4  ← 不在任何一版词表里
    'project:',                   // 5
    '  current: ""',              // 6
    'edges: []',                  // 7  ← 进度里没有这个键（额外键不拦，只说明它没用）
  ].join('\n');
  const report = validateProgress({ file: 'progress.yaml', text, value: fixture(text), schema: PROGRESS_SCHEMA });
  assert.equal(find(report, 'date-time').line, 1);
  assert.equal(find(report, '不在允许值').line, 4);
  assert.equal(report.blocking, true);
  assert.match(report.summary, /^progress\.yaml：阻断——/);
});

test('进度：缺 project 是阻断，行号回退到根那一行', () => {
  const text = [
    'updated_at: "2026-09-24T21:05:00+08:00"',   // 1
    'nodes:',                                    // 2
    '  a:',                                      // 3
    '    status: 学习中',                         // 4
    '',
  ].join('\n');
  const report = validateProgress({ file: 'progress.yaml', text, value: fixture(text), schema: PROGRESS_SCHEMA });
  assert.equal(find(report, '缺少必填字段 project').line, 1, '缺字段回退到根那一行');
  assert.equal(report.blocking, true);
});

/* ── 一之二、三档词表与旧字段的迁移提示（#71）────────────────────────── */

test('进度：旧六档读得进（schema 的 enum 就地展开），野词照样被 schema 拦下', () => {
  // 六个旧词逐条：schema 一份都不报「不在允许值」，只有域层那条「写回时映射为」的提示
  const report = validateProgress({
    file: 'progress.yaml',
    text: LEGACY_PROGRESS,
    value: fixture(LEGACY_PROGRESS),
    schema: PROGRESS_SCHEMA,
  });
  assert.equal(report.problems.some((problem) => problem.message.includes('不在允许值')), false,
    JSON.stringify(messages(report)));
  assert.equal(report.blocking, false, JSON.stringify(messages(report)));

  // 野词（连旧词表都不是）：schema 报「不在允许值」且阻断，域层补一句「会被当成未开始」
  const wild = [
    'updated_at: "2026-09-24T21:05:00+08:00"',
    'nodes:',
    '  a:',
    '    status: 学会了',
    'project:',
    '  current: ""',
  ].join('\n');
  const wildReport = validateProgress({ file: 'progress.yaml', text: wild, value: fixture(wild), schema: PROGRESS_SCHEMA });
  assert.equal(find(wildReport, '不在允许值').blocking, true);
  assert.equal(find(wildReport, '不在任何一版词表里').blocking, false);
});

test('进度：mastery 与 misconceptions 读得进，但各给一条迁移提示（不阻断）', () => {
  const text = [
    'updated_at: "2026-09-24T21:05:00+08:00"',   // 1
    'nodes:',                                    // 2
    '  a:',                                      // 3
    '    status: 能独立应用',                     // 4  ← 旧六档，映射成「已学完」
    '    mastery: 0.8',                          // 5  ← 掌握度字段已取消
    'misconceptions:',                           // 6  ← 双落点的旧副本
    '  - topic: 旧副本',                          // 7
    'project:',                                  // 8
    '  current: ""',                             // 9
  ].join('\n');
  const report = validateProgress({ file: 'progress.yaml', text, value: fixture(text), schema: PROGRESS_SCHEMA });

  const mastery = find(report, '掌握度字段已取消');
  assert.equal(mastery.line, 5);
  assert.equal(mastery.blocking, false);
  const legacyMis = find(report, '旧的双落点');
  assert.equal(legacyMis.line, 6);
  assert.equal(legacyMis.blocking, false);
  // 三档里没有「能独立应用」：schema 不报错，但域层要说清写回时会变成什么
  assert.equal(find(report, '属旧六档词表').line, 4);
  assert.equal(report.blocking, false, JSON.stringify(messages(report)));
  // 旧字段留着不写回去，所以这份文件整体仍是放行
  assert.match(report.summary, /放行/);
});

test('进度：空 nodes 是提示，不阻断', () => {
  const text = [
    'updated_at: "2026-09-24T21:05:00+08:00"',
    'nodes: {}',
    'misconceptions: []',
    'project:',
    '  current: ""',
  ].join('\n');
  const report = validateProgress({ file: 'progress.yaml', text, value: fixture(text), schema: PROGRESS_SCHEMA });
  assert.equal(report.blocking, false, JSON.stringify(messages(report)));
  assert.equal(find(report, 'nodes 是空的').blocking, false);
});

test('进度：两端空白只是提示，但它引起的格式错误照样阻断', () => {
  const text = [
    'updated_at: " 2026-09-24T21:05:00+08:00 "',
    'nodes: {}',
    'misconceptions: []',
    'project:',
    '  current: ""',
  ].join('\n');
  const report = validateProgress({ file: 'progress.yaml', text, value: fixture(text), schema: PROGRESS_SCHEMA });
  const hint = find(report, 'updated_at 两端有空白');
  assert.equal(hint.blocking, false);
  const blocking = report.problems.filter((problem) => problem.blocking);
  assert.equal(blocking.length, 1, JSON.stringify(messages(report)));
  assert.match(blocking[0].message, /不是 RFC 3339 形状的 date-time/);
});

test('进度：顶层不是 mapping 时报一条，不抛异常', () => {
  for (const value of [null, 'x', 42]) {
    const report = validateProgress({ file: 'progress.yaml', value, schema: PROGRESS_SCHEMA });
    assert.equal(report.blocking, true);
    assert.ok(report.problems.some((problem) => problem.message.includes('顶层不是 mapping')));
  }
});

/* ── 二、科目：schema 表达不了的取值 ──────────────────────────────────── */

test('科目：空 name / goal 阻断，slug 模式与 status 词表按 schema 报', () => {
  const text = [
    'name: ""',                    // 1
    'slug: Linear_Algebra',        // 2
    'goal: "   "',                 // 3
    'created_at: "2026-09-18"',    // 4
    'status: 在学',                 // 5
    '',
  ].join('\n');
  const report = validateSubject({
    file: 'subjects/linear-algebra/subject.yaml',
    text,
    value: fixture(text),
    schema: SUBJECT_SCHEMA,
  });
  assert.equal(find(report, 'name 是空串').line, 1);
  assert.equal(find(report, 'name 是空串').blocking, true);
  assert.equal(find(report, 'goal 是空串').line, 3);
  assert.equal(find(report, '不匹配要求的格式').line, 2);
  assert.equal(find(report, '不在允许值').line, 5);
  assert.equal(report.blocking, true);
});

test('科目：created_at 必须是真实存在的日期（正则拦不住 02-30）', () => {
  const text = ['name: 线性代数', 'slug: linear-algebra', 'goal: g', 'created_at: "2026-02-30"', 'status: 进行中'].join('\n');
  const report = validateSubject({ file: 'subject.yaml', text, value: fixture(text), schema: SUBJECT_SCHEMA });
  const problem = find(report, '不是真实存在的日期');
  assert.equal(problem.line, 4);
  assert.equal(problem.blocking, true);
});

test('科目：slug 与目录名不一致只是提示（目录名是权威）', () => {
  const text = ['name: 线性代数', 'slug: linear-algebra', 'goal: g', 'created_at: "2026-09-18"', 'status: 进行中'].join('\n');
  const report = validateSubject({
    file: 'subjects/linear_algebra/subject.yaml',
    text,
    value: fixture(text),
    schema: SUBJECT_SCHEMA,
    expectedSlug: 'linear_algebra',
  });
  const problem = find(report, '不一致');
  assert.equal(problem.line, 2);
  assert.equal(problem.blocking, false);
  assert.equal(report.blocking, false, JSON.stringify(messages(report)));
});

test('科目：值两端空白会被报出来（搜索去重与目录名比较都会被它坑）', () => {
  const text = [
    'name: " 线性代数 "',
    'slug: linear-algebra',
    'goal: "目标 "',
    'created_at: "2026-09-18"',
    'status: 进行中',
  ].join('\n');
  const report = validateSubject({ file: 'subject.yaml', text, value: fixture(text), schema: SUBJECT_SCHEMA });
  assert.deepEqual(
    report.problems.map((problem) => `${problem.line}:${problem.message.split(' 两端有空白')[0]}`),
    ['1:name', '3:goal'],
  );
  for (const problem of report.problems) assert.equal(problem.blocking, false);
});

test('科目：一份干净的档案零问题', () => {
  const text = [
    'name: 线性代数',
    'slug: linear-algebra',
    'goal: "把公式里的向量与矩阵读成具体的东西"',
    'created_at: "2026-09-18"',
    'status: 进行中',
  ].join('\n');
  const report = validateSubject({
    file: 'subjects/linear-algebra/subject.yaml',
    text,
    value: fixture(text),
    schema: SUBJECT_SCHEMA,
    expectedSlug: 'linear-algebra',
  });
  assert.deepEqual(report.problems, []);
  assert.match(report.summary, /放行——没有问题/);
});
