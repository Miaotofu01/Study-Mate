/* 验收：#71 拿一份 v0.2 真实工作区跑一遍
   ────────────────────────────────────────────────────────────────────────
   「真实 v0.2」= 含旧六档状态与 `mastery` 的 `progress.yaml`、`assessments/`、`sessions/`、
   误解记录的双落点（`progress.yaml` 与 `misconceptions.yaml` 各一份）。

   这条套件把验收标准的四条走一遍：
     读得进 → 映射正确 → 写回（新词表 / 新落点）→ 旧文件不损坏 → 退役目录仍可读且不再多文件。

   夹具是**内联现造**的（跑完即弃），不依赖 `examples/.learning/`——那份是手工一次性验收
   （见交付报告），#83 会删掉它。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { readLibrary } from '../../lib/library.ts';
import { readAttempts, writeAttempts } from '../../lib/attempts.ts';
import { validateProgress } from '../../lib/core/validate.ts';
import { parseYaml } from '../../lib/yaml.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROGRESS_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'progress.schema.json'), 'utf8'));

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
});

/* ── 一份 v0.2 形状的工作区 ───────────────────────────────────────────── */

/** 旧六档逐条：id → 旧状态（映射的期望值抄自目标态规格 §5.2，不是从实现里算出来的）。 */
const LEGACY_NODES = [
  { id: 'net.layers', legacy: '能独立应用', tier: '已学完', mastery: 0.85 },
  { id: 'net.link', legacy: '初步理解', tier: '学习中', mastery: 0.5 },
  { id: 'net.ip', legacy: '需要复习', tier: '已学完', mastery: 0.35 },
  { id: 'net.tcp', legacy: '未开始', tier: '未开始', mastery: 0 },
  { id: 'net.experiment', legacy: '已通过项目验证', tier: '已学完', mastery: 0.95 },
];

const PROGRESS_YAML = [
  '# 学习进度：运行期状态只写在这里（curriculum.yaml 的 status/mastery 是建课时的初始快照）。',
  'updated_at: "2026-09-24"',
  'nodes:',
  ...LEGACY_NODES.flatMap(({ id, legacy, mastery }) => [
    `  ${id}:`,
    `    status: ${legacy}`,
    `    mastery: ${mastery}`,
    `    notes: 旧工作区留下的备注（${id}）`,
  ]),
  // 双落点的旧副本：迁移后不再被读，但必须读得进、不报错
  'misconceptions:',
  '  - topic: 子网掩码的算法',
  '    question: /26 的掩码为什么网络地址是 .64？',
  '    misunderstanding: 把掩码当成按点切字符串',
  '    answer_summary: 掩码是按位与',
  '    importance: high',
  'project:',
  '  current: 用抓包解释一次自己的网页请求',
  '',
].join('\n');

const MISCONCEPTIONS_YAML = [
  '# 误解库：只追加。每条与 progress.yaml 的 misconceptions 对得上（topic 逐字一致）。',
  '- date: "2026-09-24"',
  '  node: net.ip',
  '  topic: 子网掩码的算法',
  '  question: /26 的掩码为什么网络地址是 .64？',
  '  misunderstanding: 把掩码当成按点切字符串',
  '  answer_summary: 掩码是按位与',
  '  follow_up: 在 lab 里用 network_of 各跑一遍',
  '  importance: high',
  '',
].join('\n');

function makeV02() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-v02-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  const subjectDir = path.join(workspace, '.learning', 'subjects', 'computer-networks');
  const write = (rel, text) => {
    const file = path.join(subjectDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  };

  write('subject.yaml', [
    'name: 计算机网络',
    'slug: computer-networks',
    'goal: 从零弄清一次网页请求在网线里经过了什么。',
    'created_at: "2026-09-20"',
    'status: 进行中',
    '',
  ].join('\n'));
  write('curriculum.yaml', [
    'nodes:',
    ...LEGACY_NODES.map(({ id, legacy, mastery }) => [
      `  - id: ${id}`,
      `    title: ${id}`,
      '    kind: 概念',
      '    objective: 说清这一层在干什么',
      '    prerequisites: []',
      `    status: ${legacy}`,
      `    mastery: ${mastery}`,
      '',
    ].join('\n')),
    'edges: []',
    '',
  ].join('\n'));
  write('progress.yaml', PROGRESS_YAML);
  write('misconceptions.yaml', MISCONCEPTIONS_YAML);
  write('MISSION.md', '# 使命\n\n## Why\n\n因为要解释清楚。\n');
  write('GLOSSARY.md', '## 基础\n\n**封装**: 每层加自己的首部\n_Avoid_: 打包\n');
  write('learning-records/0001-net.layers.md', '# 分层\n\n- 日期：2026-09-21\n\n读了分层。\n');
  // 退役目录：旧文件保留可读，但新流程不再往里写
  write('assessments/0001-net.layers.md', '---\nnode: net.layers\ndate: "2026-09-23"\n---\n旧评估记录\n');
  write('sessions/2026-09-24.md', '- 日期：2026-09-24\n\n旧会话摘要\n');
  // 课件与题库：旧题库不写 kind（旧词表的两种写法）
  write('lessons/0001-net.layers.md', '# 分层\n\n::: quiz 理解 锚点：每层各管一段\n:::\n');
  write('lessons/0001-net.layers.quiz.json', JSON.stringify({
    '每层各管一段': [
      { q: '哪一层解析域名？', opts: ['应用层', '传输层', '网络层', '链路层'], ans: 0, why: 'DNS 在应用层。' },
      { q: '举一个跨层的例子。', answer: '隧道：内层 IP 包被塞进外层载荷。', criteria: '同时涉及两层以上。' },
    ],
  }, null, 2) + '\n');
  write('lessons/0003-net.ip.md', '# IP\n\n::: quiz 理解 锚点：掩码的位运算\n:::\n');
  write('lessons/0003-net.ip.quiz.json', JSON.stringify({
    掩码的位运算: [{ q: '192.168.1.100/26 的网络地址是？', opts: ['.0', '.64', '.100', '.192'], ans: 1, why: '按位与。' }],
  }, null, 2) + '\n');

  return { root, workspace, subjectDir };
}

/** 整棵科目目录的「相对路径 → 字节」快照：用来断言「旧文件不损坏」。 */
function snapshot(dir) {
  const out = new Map();
  const walk = (current, prefix = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else out.set(rel, fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

function diffSnapshot(before, after) {
  const changed = [];
  for (const [rel, bytes] of before) {
    const now = after.get(rel);
    if (now === undefined) changed.push(`少 ${rel}`);
    else if (!now.equals(bytes)) changed.push(`改了 ${rel}`);
  }
  for (const rel of after.keys()) if (!before.has(rel)) changed.push(`多 ${rel}`);
  return changed;
}

/* ── 一、读得进 + 映射正确 ────────────────────────────────────────────── */

test('v0.2 工作区读得进：旧六档逐条映射到三档，旧题库照旧对得上锚点', () => {
  const { workspace } = makeV02();
  const payload = readLibrary({ workspace });
  assert.equal(payload.subjects.length, 1);
  const [subject] = payload.subjects;
  assert.equal(subject.slug, 'computer-networks');

  const byId = new Map(subject.nodes.map((node) => [node.id, node]));
  for (const { id, legacy, tier } of LEGACY_NODES) {
    assert.equal(byId.get(id).raw_status, legacy, `${id} 的原始状态要原样留在 raw_status 里`);
    assert.equal(byId.get(id).tier, tier, `${id}（${legacy}）应当映射成 ${tier}`);
  }
  // 三档的计数：旧六档收敛成三档之后才是这三行
  assert.deepEqual(subject.stats, { 未开始: 1, 学习中: 1, 已学完: 3 });
  assert.deepEqual(Object.keys(subject.stats), ['未开始', '学习中', '已学完']);
  // 「继续学」按三档挑：第一个「学习中」
  assert.equal(subject.continue_node, 'net.link');

  // 旧题库（不写 kind）零题型问题，锚点四态照旧
  assert.deepEqual(byId.get('net.layers').question_kinds, []);
  assert.equal(byId.get('net.layers').anchors[0].resolution, 'resolved');
  assert.deepEqual(byId.get('net.layers').orphan_keys, []);

  // 没作答过的节点：present=false，但版本号已经是可用基线
  assert.equal(byId.get('net.layers').attempts.present, false);
  assert.match(byId.get('net.layers').attempts.version, /^[0-9a-f]{16}$/);
});

test('误解记录只有一个落点：payload 读 misconceptions.yaml，progress.yaml 那份不再进 payload', () => {
  const { workspace } = makeV02();
  const [subject] = readLibrary({ workspace }).subjects;

  assert.equal(subject.misconceptions.length, 1, 'progress.yaml 里那份旧副本不再进 payload（规格 §5.4）');
  const one = subject.misconceptions[0];
  assert.equal(one.topic, '子网掩码的算法');
  assert.equal(one.evidence, '/26 的掩码为什么网络地址是 .64？', 'question → evidence');
  assert.equal(one.at, '2026-09-24', 'date → at');
  assert.equal(one.source, '讲解反馈', '旧记录没有来源，按讲解反馈算');
  assert.equal(one.status, '未处理', '旧记录没有处置状态，按未处理算');
  assert.deepEqual(subject.misconception_library, subject.misconceptions, '两个字段名同源');
  // 旧字段的搬运要说出来（可展示，不阻断）
  assert.equal(subject.misconception_issues.some((line) => line.includes('date → at')), true);

  // progress.yaml 里那份仍读得进：校验器给的是**迁移提示**，不是「读不了」
  const report = validateProgress({
    file: 'progress.yaml', text: PROGRESS_YAML, value: parseYaml(PROGRESS_YAML), schema: PROGRESS_SCHEMA,
  });
  const hints = report.problems.filter((problem) => problem.message.includes('旧的双落点')
    || problem.message.includes('掌握度字段已取消')
    || problem.message.includes('属旧六档词表'));
  assert.ok(hints.length >= 3, JSON.stringify(report.problems.map((p) => p.message)));
  for (const hint of hints) assert.equal(hint.blocking, false, hint.message);
  // 这份夹具唯一阻断的是 updated_at 只有日期（旧工作区里的真实写法）——不是本轮改的那几件事
  const blocking = report.problems.filter((problem) => problem.blocking);
  assert.deepEqual(blocking.map((problem) => problem.message.match(/^[^（]+/)[0]),
    ['不是 RFC 3339 形状的 date-time'], JSON.stringify(report.problems.map((p) => p.message)));
});

/* ── 二、写回：新落点、新词表、旧文件不损坏 ───────────────────────────── */

test('写回走新落点（attempts/）与新词表；旧文件一个字节都没动', () => {
  const { workspace, subjectDir } = makeV02();
  const before = snapshot(subjectDir);

  // 读一次库（界面拿版本号）→ 写一次作答（Host 半落盘）
  const [subject] = readLibrary({ workspace }).subjects;
  const node = subject.nodes.find((one) => one.id === 'net.ip');
  const written = writeAttempts({
    workspace,
    subject: 'computer-networks',
    node: 'net.ip',
    questions: { '掩码的位运算#0': { 选: 1, 对: true } },
    expectedVersion: node.attempts.version,
    operationId: 'v02-acceptance-1',
    now: '2026-09-24T13:05:00.000Z',
  });
  assert.equal(written.ok, true, JSON.stringify(written));

  const after = snapshot(subjectDir);
  const changed = diffSnapshot(before, after);
  assert.deepEqual(changed, ['多 attempts/0003-net.ip.json'],
    '旧文件一个字节都不许动；写回只新增一份作答数据（旧文件下次写盘时自然收敛）');

  // 新文件与课件一一对应：编号取课件文件名，节点 id 一致
  assert.equal(fs.existsSync(path.join(subjectDir, 'attempts', '0003-net.ip.json')), true);
  const read = readAttempts({ workspace, subject: 'computer-networks', node: 'net.ip' });
  assert.equal(read.version, written.version);
  assert.deepEqual(read.data['题']['掩码的位运算#0']['上次结果'], {
    时: '2026-09-24T13:05:00.000Z', 选: 1, 对: true,
  });

  // 题库逐字纯净（ADR-0007）：作答绝不写回 .quiz.json
  assert.equal(before.get('lessons/0003-net.ip.quiz.json').equals(after.get('lessons/0003-net.ip.quiz.json')), true);
});

/* ── 三、退役目录仍可读，且不再产生新文件 ─────────────────────────────── */

test('assessments/ 与 sessions/ 旧文件仍可读，跑完流程后没多文件', () => {
  const { workspace, subjectDir } = makeV02();
  const snapshotOf = () => ({
    assessments: fs.readdirSync(path.join(subjectDir, 'assessments')).sort(),
    sessions: fs.readdirSync(path.join(subjectDir, 'sessions')).sort(),
  });
  const before = snapshotOf();
  assert.deepEqual(before, { assessments: ['0001-net.layers.md'], sessions: ['2026-09-24.md'] });

  // 跑一遍完整流程：读库 → 写作答 → 再读库 → 再写一次
  const [subject] = readLibrary({ workspace }).subjects;
  const first = writeAttempts({
    workspace, subject: 'computer-networks', node: 'net.layers',
    questions: { '每层各管一段#0': { 选: 0, 对: true } },
    expectedVersion: subject.nodes[0].attempts.version,
    operationId: 'v02-retired-1',
  });
  assert.equal(first.ok, true);
  readLibrary({ workspace });
  const second = writeAttempts({
    workspace, subject: 'computer-networks', node: 'net.layers',
    questions: { '每层各管一段#1': { 选: null, 对: true, 自评: '答对了' } },
    expectedVersion: first.version,
    operationId: 'v02-retired-2',
  });
  assert.equal(second.ok, true);
  readLibrary({ workspace });

  assert.deepEqual(snapshotOf(), before, '退役目录不再产生新文件');
  // 旧文件仍可读（内容逐字没变）
  assert.equal(fs.readFileSync(path.join(subjectDir, 'assessments', '0001-net.layers.md'), 'utf8').includes('旧评估记录'), true);
  assert.equal(fs.readFileSync(path.join(subjectDir, 'sessions', '2026-09-24.md'), 'utf8').includes('旧会话摘要'), true);
});

/* ── 四、重放与并发（在 v0.2 工作区上再走一遍）────────────────────────── */

test('v0.2 工作区上：重放同一 operationId 字节不变；版本对不上拒绝并重读', () => {
  const { workspace, subjectDir } = makeV02();
  const [subject] = readLibrary({ workspace }).subjects;
  const submission = {
    workspace, subject: 'computer-networks', node: 'net.layers',
    questions: { '每层各管一段#0': { 选: 0, 对: true } },
    expectedVersion: subject.nodes[0].attempts.version,
    operationId: 'v02-replay',
    now: '2026-09-24T13:05:00.000Z',
  };
  const first = writeAttempts(submission);
  assert.equal(first.ok, true);
  const file = path.join(subjectDir, 'attempts', '0001-net.layers.json');
  const bytes = fs.readFileSync(file);

  const replay = writeAttempts(submission);
  assert.deepEqual(replay, first);
  assert.deepEqual(fs.readFileSync(file), bytes, '重放后文件字节不变');

  // 另一个 operationId + 过期版本：拒绝并重读
  const stale = writeAttempts({ ...submission, operationId: 'v02-stale', expectedVersion: '0000000000000000' });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);
  assert.equal(stale.error, 'version-conflict');
  assert.deepEqual(stale.attempts, first.attempts, '拒绝时把当前那份带回去，数据不丢');
  assert.deepEqual(fs.readFileSync(file), bytes, '被拒绝的那次不写盘');
});
