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
     三、工具与面板——**现状**是它们不在预设作用域内，标准预设的会话里也看得见。
         这是与 #84 用户故事 36 的**已知偏离**，宿主没有「按预设注册工具」的接口
         （`ctx.tools.restrict()` 要求 agent 作用域，插件拿到的是 profile 根 ctx），
         所以这条套件钉住的是事实而不是理想；结论与去向写在
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

test('学习预设显式声明技能目录，且只声明这一个', () => {
  const plugins = parseYaml(fs.readFileSync(PRESET, 'utf8'),
    { file: PRESET, tags: 'expression', blockScalars: true });
  assert.ok(Array.isArray(plugins), '学习预设必须是插件列表');
  const declaring = plugins.filter(row => row && typeof row === 'object'
    && row.config && typeof row.config === 'object'
    && (row.config.customSkillDirs !== undefined || row.config.includeDefaultRoots !== undefined));
  assert.equal(declaring.length, 1, '技能目录只能有一个声明点：多一处就会有两份会漂的真相');
  const row = declaring[0];
  assert.equal(row.id, 'skill-filesystem');
  assert.equal(row.config.includeDefaultRoots, false,
    '学习会话不扫全局目录：那半本来是对的，别退回默认值');
  assert.deepEqual(row.config.customSkillDirs, ['__STUDYMATE_SKILLS__'],
    '技能目录由安装器写入绝对路径；占位符丢了就该在安装时抛（bin/studymate.mjs）');
});

test('预设声明的技能目录在包内，装完之后技能照旧可加载', () => {
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

test('工具与面板的注册面在预设之外（现状：标准预设的会话里也看得见）', async () => {
  // 这一段是**特征化**测试：它钉住的是宿主当前给得起的形状，不是理想形状。
  // 哪天宿主给了「按预设注册工具/面板」的接口，这条会红——那时改它，并同步规范里的偏离记录。
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
  try {
    const { apply } = await import(pathToFileURL(path.join(ROOT, 'bin', 'dsh-plugin.ts')).href);
    await apply({
      // 插件拿到的是**插件所在 profile 的根 ctx**（`profileContext` 就是它的凭据）。
      get: () => ({ name: 'web', home: process.env.DSH_HOME }),
      agentPresets: { register: async config => { presets.push(config); return () => {}; } },
      effect: async fn => { await fn(); },
      inject: (names, handler) => {
        injected.push(names.join(','));
        // `ctx.inject(['tools'], …)` 的回调参数 = 同一个 profile 根作用域上的 tools 服务。
        // 它不是 agent 作用域：宿主的 `ctx.tools.restrict()` 在这种 ctx 上直接抛
        // （`@deepseek-ai/dsh-tools` 的 `restrict()`：requires a scoped context (agent.ctx)）。
        if (names.includes('tools')) {
          handler({ tools: { register: definition => { toolNames.push(definition.name); return () => {}; } } });
        }
      },
    });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  assert.ok(injected.includes('tools'), '工具注册走的是插件自己的注入面，不经过预设');
  // 注册面 = profile 根 ctx，判据是「八个学习工具按名字都查得到」——名字表以
  // lib/tools/index.ts 为唯一出处，这里不抄第二份。
  const { STUDY_TOOL_NAMES } = await import(pathToFileURL(path.join(ROOT, 'lib', 'tools', 'index.ts')).href);
  for (const name of STUDY_TOOL_NAMES) {
    assert.ok(toolNames.includes(name), `${name} 必须注册在 profile 根 ctx 上`);
  }
  // 预设载荷里只有插件行：没有任何一行把工具或面板绑到学习模式上。
  const payload = JSON.stringify(presets);
  assert.ok(!payload.includes('studymate_'), '预设载荷里不该出现原生工具名');
  // 面板/slot 在打包元数据里全局声明（package.json 的 dsh.client），与预设无关。
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.dsh?.client?.platform, 'web',
    '客户端面板是包级声明：每个加载了这个包的 profile 都会挂上它');
});
