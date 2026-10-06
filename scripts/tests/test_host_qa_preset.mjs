/* 验收 #104 · 「答疑模式」预设与只读取课件工具（`preset/qa/**`、`lib/tools/{qa-preset,lesson-read}.ts`）
   ────────────────────────────────────────────────────────────────────────
   这条套件走 #102 Testing Decisions 的第二条缝：**宿主半 + 假 ctx**（`test_skill_visibility.mjs`、
   `test_preset_install.mjs`、`test_host_ask_session.mjs` 的先例）。真宿主的 `agentPresets.mount`
   与 `tools.restrict` 认不认这条配置，只有在真 DSH 里才证得了——那一条**不进默认门禁**
   （spec 的 Testing Decisions 已接受这个口径）；这里钉的是我们能钉的那一半：

     · 预设的形状：id/名/order 与「学习模式」并列且互不相同；插件行**只有四行**，工具面最小；
       技能目录只指包内真实存在的 `preset/skills/local-qa`；
     · 工具面行真的调了 `restrict({ deny: profile 根注册的全部原生工具 })`（假 ctx 抓调用），
       而且只读工具注册进了**本作用域**（作用域自己那层不受 restriction 影响）；
     · 只读工具的外部行为：正常节点给得出正文与这一节点的题；不存在的节点、越界的 id 给「没有」；
       跑一遍工作区文件清单逐字不变（`writes` 空）；
     · 占位符：`preset/qa/agent.cordis.yml` 少了 `__STUDYMATE_SKILLS__` 时安装必须抛。

   数据现造现弃（ADR-0009）：夹具在 `fixtures/tools.mjs`（临时 HOME + 最小科目），跑完即删。 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { parseYaml } from '../../lib/yaml.ts';
import { useHome, writeSubject } from './fixtures/tools.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const QA_PRESET_FILE = path.join(ROOT, 'preset', 'qa', 'agent.cordis.yml');
const QA_METADATA_FILE = path.join(ROOT, 'preset', 'qa', 'preset.yml');
const LEARNING_PRESET_FILE = path.join(ROOT, 'preset', 'learning', 'agent.cordis.yml');

const { STUDY_TOOL_NAMES } = await import(pathToFileURL(
  path.join(ROOT, 'lib', 'tools', 'index.ts')).href);
const { LESSON_READ_TOOL_NAME } = await import(pathToFileURL(
  path.join(ROOT, 'lib', 'tools', 'lesson-read.ts')).href);
const tasks = await import(pathToFileURL(path.join(ROOT, 'lib', 'tasks', 'index.ts')).href);
const lab = await import(pathToFileURL(path.join(ROOT, 'lib', 'lab', 'index.ts')).href);

/** profile 根（`bin/dsh-plugin.ts` 的 `ctx.inject(['tools'], …)`）注册的全部 StudyMate 工具。 */
const PROFILE_ROOT_TOOL_NAMES = [
  ...STUDY_TOOL_NAMES, ...tasks.TASK_TOOL_NAMES, ...lab.LAB_TOOL_NAMES,
];

function pluginsOf(file) {
  const rows = parseYaml(fs.readFileSync(file, 'utf8'),
    { file, tags: 'expression', blockScalars: true });
  assert.ok(Array.isArray(rows), `${file} 必须是插件列表`);
  return rows;
}

function metadataOf(file) {
  return parseYaml(fs.readFileSync(file, 'utf8'), { file, blockScalars: true });
}

/* ── 假 ctx：收注册、抓 restrict 调用 ─────────────────────────────────── */

/** 一条 falsy 的「宿主服务」ctx：这条行只用得到 tools / effect / get。 */
function fakeQaContext({ failFirstRestrict = false } = {}) {
  const definitions = new Map();
  const restrictCalls = [];
  const warnings = [];
  const ctx = {
    tools: {
      register: (definition) => {
        definitions.set(definition.name, definition);
        return () => definitions.delete(definition.name);
      },
      restrict: (filter) => {
        restrictCalls.push(filter);
        if (failFirstRestrict && restrictCalls.length === 1) {
          throw new Error('tools.restrict() names unknown global tool "studymate_lab_run"');
        }
        return () => {};
      },
    },
    effect: (fn) => fn(),
    get: () => undefined,
  };
  return { ctx, definitions, restrictCalls, warnings };
}

async function loadQaRow() {
  return import(pathToFileURL(path.join(ROOT, 'lib', 'tools', 'qa-preset.ts')).href);
}

async function mountQa(options) {
  const row = await loadQaRow();
  const fake = fakeQaContext(options);
  const previousWarn = console.warn;
  console.warn = (message) => { fake.warnings.push(String(message)); };
  try {
    row.apply(fake.ctx);
  } finally {
    console.warn = previousWarn;
  }
  return { row, ...fake };
}

/* ── 一、预设形状 ─────────────────────────────────────────────────────── */

test('答疑模式与学习模式并列：id/名/order 各自独立，插件行只有最小面那四行', () => {
  const rows = pluginsOf(QA_PRESET_FILE);
  assert.deepEqual(rows.map(row => row.id),
    ['persona', 'skill-filesystem', 'tool-skill', 'studymate-qa-tools'],
    '答疑预设只有这四行——它的 plugins 行就是它的工具面（PresetDefinition 没有 tools 字段）');
  // 逐条点名「一个都不在」：bash / 文件读写 / 搜索 / jobs / 子 agent / workflow / web / plan / todo。
  const forbiddenIds = ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs',
    'delegation', 'tool-subagent', 'tool-subagent-control', 'tool-subagent-list-agents',
    'workflow-ptc', 'tool-workflow', 'tool-ralph', 'planning', 'plan-mode', 'tool-todo',
    'tool-web', 'tool-goal', 'command-goal', 'tool-ask-user', 'present', 'compaction'];
  for (const id of forbiddenIds) {
    assert.ok(!rows.some(row => row.id === id), `答疑预设里不该有 ${id}`);
  }
  // 名字模式再兜一遍：换一个 id 也不许把这类能力带进来。
  for (const row of rows) {
    assert.doesNotMatch(String(row.name),
      /bash|pwsh|tool-fs|subagent|workflow|tool-web|tool-jobs|plan-mode|tool-todo|ralph|compaction|present/,
      `${row.id} 不是答疑会话该有的能力行`);
  }

  const persona = rows.find(row => row.id === 'persona');
  assert.equal(persona.name, '@deepseek-ai/dsh-persona');
  assert.equal(persona.config.suffix, 'Your working directory is {{cwd}}.');
  assert.ok(persona.config.prefix.includes('就地答疑'), 'persona 要写明它是阅读端的就地答疑');
  assert.ok(persona.config.prefix.includes('__STUDYMATE_SKILLS__/local-qa'),
    'persona 要写明按这一份规范答');

  const skills = rows.find(row => row.id === 'skill-filesystem');
  assert.equal(skills.config.includeDefaultRoots, false);
  assert.deepEqual(skills.config.customSkillDirs, ['__STUDYMATE_SKILLS__/local-qa'],
    '技能目录只含 local-qa 一个：指到 preset/skills 会给出全部 12 个');
  const qaRoot = path.join(ROOT, 'preset', 'skills', 'local-qa');
  assert.equal(fs.existsSync(path.join(qaRoot, 'SKILL.md')), true,
    '声明的那个目录必须真在包里（宿主只扫一层：根下那个 .md 就是一份技能）');

  // 与学习模式并列：metadata 各自独立
  const learning = metadataOf(path.join(ROOT, 'preset', 'learning', 'preset.yml'));
  const qa = metadataOf(QA_METADATA_FILE);
  assert.equal(typeof qa.name, 'string');
  assert.notEqual(qa.name, learning.name);
  assert.equal(qa.order, 20);
  assert.notEqual(qa.order, learning.order);

  // 那条工具面行必须解析得到：包导出 ./qa-preset → 这个文件
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./qa-preset'], './lib/tools/qa-preset.ts');
  assert.ok(manifest.files.includes('preset/qa/**'), '发出去的包里必须带 preset/qa/**');
  assert.ok(rows.some(row => row.id === 'studymate-qa-tools'
    && row.name === '@yunmiao/studymate/qa-preset'));
});

test('学习模式那一侧的插件行没被这次改动碰到（两条预设各自独立）', () => {
  const learning = pluginsOf(LEARNING_PRESET_FILE).map(row => row.id);
  assert.ok(learning.includes('tool-bash') && learning.includes('delegation'),
    '学习模式照旧带着它的完整面');
  assert.ok(!learning.includes('studymate-qa-tools'), '学习模式不挂答疑那条工具面行');
  const qa = pluginsOf(QA_PRESET_FILE).map(row => row.id);
  assert.ok(!qa.includes('agent-instructions'), '答疑模式不留 agent-instructions（最小面）');
});

/* ── 二、工具面：deny 掉 profile 根的原生工具 + 只读工具进本作用域 ──────── */

test('答疑预设的工具面行把 profile 根的原生工具全部 deny 掉，并把只读工具注册进本作用域', async () => {
  const { definitions, restrictCalls, warnings } = await mountQa();
  assert.deepEqual(warnings, [], '正常路径不该有警告');
  assert.equal(restrictCalls.length, 1, '只调一次 restrict');
  const filter = restrictCalls[0];
  assert.ok(Array.isArray(filter.deny), '必须用 deny：allow 会把预设自己那层的只读工具与 skill 一起剪掉');
  assert.equal(filter.allow, undefined, '不许用 allow（host.md Q5：预设层的工具会被一起过滤）');
  for (const name of STUDY_TOOL_NAMES) {
    assert.ok(filter.deny.includes(name), `${name} 必须被 deny 掉`);
  }
  assert.deepEqual([...filter.deny].sort(), [...PROFILE_ROOT_TOOL_NAMES].sort(),
    'profile 根注册的 StudyMate 工具一个都不留（八个学习工具 + 任务 + 实验）');

  // 只读工具落在本作用域：它不受上面那条 restriction 影响，必须注册成功
  assert.deepEqual([...definitions.keys()], [LESSON_READ_TOOL_NAME]);
  const definition = definitions.get(LESSON_READ_TOOL_NAME);
  assert.deepEqual(definition.declaration.writes, {}, '只读：一个写域都不声明');
  assert.deepEqual([...definition.declaration.reads], ['lessons', 'pool']);
  assert.equal(definition.parameters.required.includes('node'), true);

  // 它**不**进那八个原生工具的面（registerStudyMate 的清单一字不动）
  assert.equal(STUDY_TOOL_NAMES.length, 8);
  assert.ok(!STUDY_TOOL_NAMES.includes(LESSON_READ_TOOL_NAME));
});

test('原生工具没在注册名册里时退到八个学习工具再试一次，并给出可读警告', async () => {
  const { restrictCalls, warnings } = await mountQa({ failFirstRestrict: true });
  assert.equal(restrictCalls.length, 2, '第一遍失败后要退到八个学习工具再试');
  assert.deepEqual([...restrictCalls[1].deny].sort(), [...STUDY_TOOL_NAMES].sort());
  assert.equal(warnings.length, 1, '退化要如实说，不静默');
  assert.match(warnings[0], /答疑模式/);
});

/* ── 三、只读工具的外部行为（现造现弃的工作区）────────────────────────── */

/** 工作区文件清单（相对路径 + 字节 sha256），逐字比对「跑一遍不写盘」用。 */
function snapshotTree(dir, prefix = '') {
  const entries = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) entries.push(...snapshotTree(full, relative));
    else entries.push([relative, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
  }
  return entries;
}

async function callLessonRead(spec, args) {
  const definition = spec.definitions.get(LESSON_READ_TOOL_NAME);
  return definition.execute(args, { signal: new AbortController().signal });
}

test('只读工具：正常节点给得出正文与这一节点的题，且跑一遍工作区文件清单逐字不变', async (t) => {
  const { workspace } = useHome(t, { withWorkspace: true });
  writeSubject(workspace, 'demo');
  const spec = await mountQa();
  const before = snapshotTree(workspace);
  const value = await callLessonRead(spec, { node: 'var' });
  assert.equal(value.found, true, JSON.stringify(value));
  assert.equal(value.subject, 'demo');
  assert.equal(value.file, '0001-var.md');
  assert.match(value.markdown, /正文一段/);
  assert.deepEqual(value.questions.map(group => group.anchor), ['什么是变量']);
  assert.deepEqual(value.questions[0].questions, [{ q: '题面' }]);
  assert.deepEqual(value.alsoIn, []);
  assert.deepEqual(snapshotTree(workspace), before, '只读工具跑一遍不许动工作区里任何一个字节');

  // 节点在别的科目里也有时如实列出来（节点 id 只在科目内唯一）
  writeSubject(workspace, 'other', {
    nodes: [{ id: 'var', title: '变量（另一门课）' }],
    secondLesson: false,
  });
  const beforeSecond = snapshotTree(workspace);
  const ambiguous = await callLessonRead(spec, { node: 'var' });
  assert.equal(ambiguous.found, true);
  assert.equal(ambiguous.subject, 'demo', '同一 id 取字典序在前的科目，顺序稳定');
  assert.deepEqual(ambiguous.alsoIn, ['other']);
  assert.deepEqual(snapshotTree(workspace), beforeSecond);
});

test('只读工具：不存在的节点、越界的 id、没有正文的节点都给「没有」', async (t) => {
  const { workspace } = useHome(t, { withWorkspace: true });
  writeSubject(workspace, 'demo', { pool: null, secondLesson: false });
  const spec = await mountQa();
  const before = snapshotTree(workspace);
  for (const node of ['nope', '../subject', 'a/b', '..', '']) {
    const value = await callLessonRead(spec, { node });
    assert.equal(value.found, false, `${JSON.stringify(node)} 应给「没有」：${JSON.stringify(value)}`);
    assert.equal(typeof value.reason, 'string');
    assert.ok(value.reason.length > 0, '「没有」也要给一句能读的理由');
  }
  // 节点在大纲里、但正文文件还没落盘：同样是「拿不到正文」
  const { workspace: empty } = useHome(t, { withWorkspace: true });
  writeSubject(empty, 'demo', { secondLesson: true });
  fs.rmSync(path.join(empty, '.learning', 'subjects', 'demo', 'lessons', '0002-fn.md'));
  const missingFile = await callLessonRead(spec, { node: 'fn' });
  assert.equal(missingFile.found, false);
  assert.match(missingFile.reason, /fn/);
  assert.deepEqual(snapshotTree(workspace), before);
});

test('只读工具：没有工作区也给「没有」，不抛', async (t) => {
  useHome(t, { withWorkspace: false });
  const spec = await mountQa();
  const value = await callLessonRead(spec, { node: 'var' });
  assert.equal(value.found, false);
  assert.match(value.reason, /工作区|读不到/);
});

/* ── 四、占位符：答疑预设少了它就装不上 ────────────────────────────────── */

test('preset/qa/agent.cordis.yml 带 __STUDYMATE_SKILLS__；缺了安装必须抛', async (t) => {
  const qaText = fs.readFileSync(QA_PRESET_FILE, 'utf8');
  assert.ok(qaText.includes('__STUDYMATE_SKILLS__'), '占位符由安装器换成引擎侧绝对路径');
  // 把「包」缩成 bin/ + package.json + 两份预设，其中答疑那份被动过手脚——不动仓库里的真件。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-qa-placeholder-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const packageDir = path.join(base, '包');
  fs.cpSync(path.join(ROOT, 'bin'), path.join(packageDir, 'bin'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'lib'), path.join(packageDir, 'lib'),
    process.platform === 'win32' ? 'junction' : 'dir');
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(packageDir, 'package.json'));
  fs.cpSync(path.join(ROOT, 'preset', 'learning'), path.join(packageDir, 'preset', 'learning'),
    { recursive: true });
  fs.cpSync(path.join(ROOT, 'preset', 'qa'), path.join(packageDir, 'preset', 'qa'),
    { recursive: true });
  const agentFile = path.join(packageDir, 'preset', 'qa', 'agent.cordis.yml');
  fs.writeFileSync(agentFile, fs.readFileSync(agentFile, 'utf8')
    .replaceAll('__STUDYMATE_SKILLS__', 'preset/skills'));
  const { installPayload } = await import(pathToFileURL(
    path.join(packageDir, 'bin', 'studymate.mjs')).href);
  assert.throws(() => installPayload({
    native: true, profile: 'web', dshHome: path.join(base, 'home', '.dsh'),
    workspaceArg: path.join(base, 'home', '学习资料'),
  }), /__STUDYMATE_SKILLS__/);
});
