/* 技能与工具的**可见边界**：什么时候别的预设看不见 StudyMate 的东西。
   ────────────────────────────────────────────────────────────────────────
   为什么单有一条：#84 的第三、四条用户故事要求这条边界由学习模式决定，不许依赖
   「会话的工作目录恰好不在本仓库里」。此前全仓只有**入方向**断言（学习会话别背别人
   的技能：`test_bundle.mjs` / `test_installer.mjs` / `test_dsh_runtime.mjs` 都只断
   `customSkillDirs` 指向哪），出方向一条都没有——这正是泄漏能活到今天的原因。

   泄漏机制（读宿主包得来，不是推断）：宿主内置的 standard 预设自带一行没有 config 的
   `skill-filesystem`，默认 `includeDefaultRoots: true`，于是**任何**会话都会按
   「从工作目录向上第一个含 `.git` 的祖先」找项目根，再扫 `<项目根>/.dsh/skills` 与
   `<项目根>/.agents/skills`（`@deepseek-ai/dsh-skill-filesystem@0.2.0-rc.2`
   `lib/index.js` 的 `roots()` 与 `findProjectRoot()`；宿主升级后行号会漂，规则本身很稳）。
   所以**出方向**的判据只有一条：这两个位置里没有 StudyMate 的技能。

   三部分：
     一、出方向——工作目录在本仓库里时，宿主默认的那两条项目根扫描路径上什么都没有；
     二、入方向——学习预设显式声明技能目录，且那份声明落在包内（宿主默认不扫的位置）；
   三、工具与面板——**工具**的注册面自 #138 起在「学习模式」预设作用域里（预设载荷自己那条
          `@yunmiao/studymate/learning-preset` 行），profile 根上一个都不留，所以别的预设的
          会话看不见它们；**面板与 slot** 仍由 `package.json` 的 `dsh.client` 在**包级**声明
          （宿主没有「按预设注册面板」的接口）——那一半偏离留着，结论与去向写在
          `docs/规范/工程约束.md` §二「技能与工具的可见边界」。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { parseYaml } from '../../lib/yaml.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PRESET = path.join(ROOT, 'preset', 'learning', 'agent.cordis.yml');
// 技能的唯一源：与预设源同一棵树（`preset/`）下，但**不在**宿主默认会扫的位置。
const SKILLS = path.join(ROOT, 'preset', 'skills');
// 宿主默认项目根扫描的两条路径，相对项目根（`findProjectRoot` 找到的那个含 `.git` 的祖先）。
const SCANNED_FROM_PROJECT_ROOT = ['.dsh/skills', '.agents/skills'];

/** 宿主的 `findProjectRoot()`：向上找第一个含 `.git` 的祖先，都没有就是原 cwd。 */
function projectRootOf(cwd) {
  let current = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

/** 技能源目录里的技能名（每个顶层目录一份 SKILL.md）。 */
function skillNames(directory = SKILLS) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

test('工作目录在本仓库里时，宿主默认的项目根扫描扫不到任何 StudyMate 技能', () => {
  // 「cwd 在仓库里」不是假设：门禁（checks.mjs）与 npm test 都从仓库根跑，
  // 套件也照 cwd 走一遍宿主那条规则，而不是假定自己在哪。
  const projectRoot = projectRootOf(process.cwd());
  assert.equal(fs.realpathSync(projectRoot), fs.realpathSync(ROOT),
    '这条套件的判据要在「工作目录落在本仓库里」的前提下成立');
  for (const relative of SCANNED_FROM_PROJECT_ROOT) {
    const scanned = path.join(projectRoot, relative);
    assert.equal(fs.existsSync(scanned), false,
      `${relative} 是宿主默认会扫的位置，技能不许住在这里（当前工作目录 ${process.cwd()}）`);
  }
  // 再说一遍「扫的是目录，不是名字」：那两条路径各自下面的技能名一个都不许在。
  // 只看那两条路径本身（不笼统断言 `.dsh` 不存在）——构建产物落在 `.dsh/` 下不构成泄漏，
  // 宿主扫的是 `<项目根>/.dsh/skills` 这一个位置。
  for (const relative of SCANNED_FROM_PROJECT_ROOT) {
    for (const name of skillNames()) {
      assert.equal(fs.existsSync(path.join(projectRoot, relative, name)), false);
    }
  }
});

test('两条预设各自显式声明技能目录，且每条只声明一处', () => {
  // #104 起有两条预设、两份声明：学习模式是全部 12 份，答疑模式**只**含 local-qa。
  // 「只声明一处」这条判据一条都没放宽——每份预设里仍然只有一个 skill-filesystem 行，
  // 多一处就是两个会漂的真相。
  const expectations = [
    ['学习模式', path.join(ROOT, 'preset', 'learning', 'agent.cordis.yml'), ['__STUDYMATE_SKILLS__']],
    ['答疑模式', path.join(ROOT, 'preset', 'qa', 'agent.cordis.yml'), ['__STUDYMATE_SKILLS__/local-qa']],
  ];
  for (const [label, file, customSkillDirs] of expectations) {
    const plugins = parseYaml(fs.readFileSync(file, 'utf8'),
      { file, tags: 'expression', blockScalars: true });
    assert.ok(Array.isArray(plugins), `${label}必须是插件列表`);
    const declaring = plugins.filter(row => row && typeof row === 'object'
      && row.config && typeof row.config === 'object'
      && (row.config.customSkillDirs !== undefined || row.config.includeDefaultRoots !== undefined));
    assert.equal(declaring.length, 1, `${label}：技能目录只能有一个声明点`);
    const row = declaring[0];
    assert.equal(row.id, 'skill-filesystem');
    assert.equal(row.config.includeDefaultRoots, false,
      `${label}不扫全局目录：那半本来是对的，别退回默认值`);
    assert.deepEqual(row.config.customSkillDirs, customSkillDirs,
      `${label}的技能目录由安装器写入绝对路径；占位符丢了就该在安装时抛（bin/studymate.mjs）`);
  }
});

test('预设声明的技能目录在包内真实存在，装完之后技能照旧可加载', () => {
  // 包内的技能源：原生加载下 <root> 就是包自身，所以安装器写进预设的绝对路径
  // 必须正好指向这里（standalone 那份是同一个相对位置在 engine 副本里，见 test_installer）。
  assert.equal(fs.existsSync(path.join(ROOT, 'preset', 'skills', 'learning-system', 'SKILL.md')), true);
  const names = skillNames();
  assert.equal(names.length, 12, `技能源里应恰好 12 份技能，实际 ${names.length} 份`);
  for (const name of names) {
    assert.ok(fs.statSync(path.join(SKILLS, name, 'SKILL.md')).isFile(), `${name} 缺 SKILL.md`);
  }
  // 声明的那个目录不能落在宿主默认会扫的位置上——换名字可以，换回扫描面不行。
  const declared = path.relative(ROOT, SKILLS).split(path.sep).join('/');
  assert.equal(SCANNED_FROM_PROJECT_ROOT.includes(declared), false);
  // 答疑预设声明的根指向 `preset/skills/local-qa`：**恰好一个**技能（宿主只扫一层，
  // `SKILL.md` 走「散装 .md」分支），而且它必须真在包里。
  const qaRoot = path.join(SKILLS, 'local-qa');
  assert.equal(fs.existsSync(path.join(qaRoot, 'SKILL.md')), true, '答疑模式的技能目录必须真在包里');
  assert.deepEqual(fs.readdirSync(qaRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(qaRoot, entry.name, 'SKILL.md')))
    .map(entry => entry.name), [], '那个根下不该再嵌一层技能目录：它给出的是它自己那一个技能');
  const qaDeclared = path.relative(ROOT, qaRoot).split(path.sep).join('/');
  assert.equal(SCANNED_FROM_PROJECT_ROOT.includes(qaDeclared), false);
});

test('预设里少了技能目录占位符就装不上（搬家没把这条守卫绕过去）', async t => {
  // 把「包」缩成 bin/ + package.json + 一份被动过手脚的预设：`installPayload` 的 source
  // 由脚本自身位置推出来，所以拷出去就能喂给它一份缺占位符的预设——不动仓库里的真件。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-placeholder-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const packageDir = path.join(base, '包');
  fs.cpSync(path.join(ROOT, 'bin'), path.join(packageDir, 'bin'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'lib'), path.join(packageDir, 'lib'),
    process.platform === 'win32' ? 'junction' : 'dir');
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(packageDir, 'package.json'));
  const presetDir = path.join(packageDir, 'preset', 'learning');
  fs.mkdirSync(presetDir, { recursive: true });
  const agent = fs.readFileSync(PRESET, 'utf8');
  assert.ok(agent.includes('__STUDYMATE_SKILLS__'), '预设里得有这个占位符，安装器才有得换');
  fs.writeFileSync(path.join(presetDir, 'agent.cordis.yml'), agent.replaceAll('__STUDYMATE_SKILLS__', 'preset/skills'));
  const { installPayload } = await import(pathToFileURL(path.join(packageDir, 'bin', 'studymate.mjs')).href);
  assert.throws(() => installPayload({
    native: true, profile: 'web', dshHome: path.join(base, 'home', '.dsh'),
    workspaceArg: path.join(base, 'home', '学习资料'),
  }), /__STUDYMATE_SKILLS__/);
});

test('工具的注册面在「学习模式」预设里，profile 根上一个都不留（#138）', async () => {
  // 这条以前钉的是相反的现状：`registerStudyMate` 那九个学习工具落在**插件所在的 profile 根**
  // ctx 上，同一个 profile 里任何会话（含宿主内置的 standard）都看得见它们（#87 的已知偏离）。
  // #138 把工具的注册面收进了预设载荷自己那条插件行（`@yunmiao/studymate/learning-preset`），
  // 所以判据翻面：**profile 根上不再碰 tools 服务**，而那批名字由预设作用域里那条行注册。
  // 面板/slot 仍在包级声明（宿主没有「按预设注册面板」的接口）——那一半偏离留着。
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-visibility-'));
  const previous = { HOME: process.env.HOME, DSH_HOME: process.env.DSH_HOME, LEARN_WORKSPACE: process.env.LEARN_WORKSPACE };
  Object.assign(process.env, {
    HOME: temporary,
    DSH_HOME: path.join(temporary, '.dsh'),
    LEARN_WORKSPACE: path.join(temporary, '学习资料'),
  });
  const injected = [];
  const toolNames = [];
  const presets = [];
  const scopedNames = [];
  const { STUDY_TOOL_NAMES } = await import(pathToFileURL(path.join(ROOT, 'lib', 'tools', 'index.ts')).href);
  const tasks = await import(pathToFileURL(path.join(ROOT, 'lib', 'tasks', 'index.ts')).href);
  const lab = await import(pathToFileURL(path.join(ROOT, 'lib', 'lab', 'index.ts')).href);
  try {
    const { apply } = await import(pathToFileURL(path.join(ROOT, 'bin', 'dsh-plugin.ts')).href);
    await apply({
      // 插件拿到的是**插件所在 profile 的根 ctx**（`profileContext` 就是它的凭据）。
      get: () => ({ name: 'web', home: process.env.DSH_HOME }),
      agentPresets: { register: async config => { presets.push(config); return () => {}; } },
      effect: async fn => { await fn(); },
      inject: (names, handler) => {
        injected.push(names.join(','));
        if (names.includes('tools')) {
          handler({ tools: { register: definition => { toolNames.push(definition.name); return () => {}; } } });
        }
      },
    });

    // 那条插件行在**自己的作用域**里注册——这里直接拿它的 apply 跑一遍假 ctx。
    const { apply: applyPresetTools } = await import(
      pathToFileURL(path.join(ROOT, 'lib', 'tools', 'learning-preset.ts')).href);
    applyPresetTools({
      tools: { register: definition => { scopedNames.push(definition.name); return () => {}; } },
      effect: fn => fn(),
    });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  // ① profile 根上不再注册任何 StudyMate 工具——污染就出在这一步
  assert.ok(!injected.includes('tools'), '插件在 profile 根上不该再碰 tools 服务');
  assert.deepEqual(toolNames, [], 'profile 根 ctx 上不该注册任何 StudyMate 工具');

  // ② 预设载荷里有那条插件行：它才是注册面
  const learning = presets.find(config => config.id === 'learning');
  assert.ok(learning, '学习模式预设要注册得上');
  const toolRows = (learning.plugins ?? [])
    .filter(row => row.name === '@yunmiao/studymate/learning-preset')
    .map(row => row.id);
  assert.deepEqual(toolRows, ['studymate-tools'], '学习模式预设要挂上那条工具面行');

  // ③ 那条行在**它自己的作用域**里注册全部 15 个：九个学习工具 → 五个任务工具 → 一个实验工具
  assert.deepEqual(scopedNames, [
    ...STUDY_TOOL_NAMES, ...tasks.TASK_TOOL_NAMES, ...lab.LAB_TOOL_NAMES,
  ]);

  // ④ 面板/slot 仍是包级声明（与预设无关）：每个加载了这个包的 profile 都会挂上它
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.dsh?.client?.platform, 'web',
    '客户端面板是包级声明：宿主没有按预设注册面板的接口，这一半偏离留着');
});
