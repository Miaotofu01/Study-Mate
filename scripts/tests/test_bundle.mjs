import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { parseYaml } from '../../lib/yaml.ts';
import { validatePack } from '../release/release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const plugin = pathToFileURL(path.join(root, 'bin/dsh-plugin.ts')).href;
// 原生加载下引擎就是**已安装的包自身**——package.json 与 package.json 里 files 带的
// scripts/、templates/、schemas/、docs/、preset/skills 都在这个目录里。
const packageSkills = path.join(root, 'preset', 'skills').split(path.sep).join('/');

/**
 * 把宿主提供的 schemastery 连同它的依赖放进目标 node_modules。
 *
 * 插件入口是静态 `import z from '@deepseek-ai/schemastery'`（与 dsh-win-pwsh7 同一条：
 * 宿主的模块解析只在加载期生效，运行期 dynamic import 拿不到）。这两个边界夹具里没有
 * 宿主，所以按宿主的形状补出来；真实 profile 里这些包在宿主那一层。
 */
function provideHostSchema(target) {
  for (const name of ['@deepseek-ai/schemastery', '@deepseek-ai/cosmokit', '@standard-schema/spec']) {
    const from = path.join(root, 'node_modules', ...name.split('/'));
    const to = path.join(target, 'node_modules', ...name.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-bundle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "家 O'Brien #1");
  const dshHome = path.join(home, '.dsh');
  const workspace = path.join(home, '学习资料');
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: dshHome, LEARN_WORKSPACE: workspace };
  const patch = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
  const config = path.join(dshHome, 'studymate-config.yaml');
  const run = (code, overrides = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000,
  });
  function boot(overrides = {}, scenario = 'normal', url = plugin) {
    return run(`import { apply } from ${JSON.stringify(url)};
      const scenario = ${JSON.stringify(scenario)};
      const state = {registered: 0, disposed: 0, warnings: [], configs: []};
      console.warn = message => {state.warnings.push(String(message));};
      const effects = [];
      const ctx = {
        get: () => ({name: 'web', home: process.env.DSH_HOME}),
        agentPresets: {register: async config => {
          state.configs.push(config);
          // #104 起这里注册两条（学习 + 答疑）：state.config 仍是**学习模式**那一条，
          // 答疑那条在 state.configs 里（既有断言因此一个字都不用改）。
          state.config = state.configs.find(item => item.id === 'learning') ?? config;
          state.registered++;
          if (scenario === 'duplicate') throw new Error('Duplicate agent preset: learning');
          return async () => { state.disposed++; };
        }},
        effect: async fn => {effects.push(await fn());},
      };
      try {await apply(ctx); for (const dispose of effects) await dispose();}
      catch (error) {state.error = error.message; process.exitCode = 1;}
      console.log(JSON.stringify(state));`, overrides);
  }
  function yaml(file) {
    return parseYaml(fs.readFileSync(file, 'utf8'),
      { file, tags: 'scalar', blockScalars: true, documentMarkers: true });
  }
  // 原生加载下引擎 = 已安装的包自身，所以这份夹具里没有 <dshHome>/studymate/engine
  return { dir, env, dshHome, workspace, patch, config, run, boot, yaml };
}

function snapshot(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory()
      ? [[entry.name, 'directory'], ...snapshot(file).map(([name, hash]) => [path.join(entry.name, name), hash])]
      : [[entry.name, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]];
  });
}

test('native loading initializes portable skills and owns the preset lifetime without a dsh subprocess', t => {
  const f = fixture(t);
  // 启动不许往包目录里写：装好的包是随包发的只读材料（link: 安装下更是学生自己的检出）。
  // 判据是启动前后给 `preset/skills` 取指纹，**不是**往包里塞一个哨兵文件：`test:installer`
  // 把本文件与 `test_installer.mjs` 并发跑，那个用例的 copyPayload 正在 cpSync 这棵树（先
  // readdir 再逐个 lstat），哨兵被我们删掉的瞬间会让它撞 ENOENT（#216）。指纹覆盖新增 /
  // 改写 / 删除三种写，比单个哨兵更强，也不碰别的套件正在读的共享目录。
  const skills = path.join(root, 'preset', 'skills');
  const skillsBefore = snapshot(skills);
  const result = f.boot();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const state = JSON.parse(result.stdout);
  // #104：两条预设各注册一次（学习模式 + 答疑模式），各有自己的 disposer。
  assert.equal(state.registered, 2);
  assert.equal(state.disposed, 2);
  assert.deepEqual(state.warnings, []);
  assert.equal(state.config.id, 'learning');
  assert.deepEqual(state.config.plugins.find(row => row.id === 'tool-bash').disabled,
    { __jsExpr: "process.platform === 'win32'" });
  assert.deepEqual(state.config.plugins.find(row => row.id === 'skill-filesystem').config.customSkillDirs,
    [packageSkills]);
  // 第二条是答疑模式：名字/顺序与学习并列，技能目录只指包内的 local-qa，工具面是四行最小面。
  const qa = state.configs.find(item => item.id === 'qa');
  assert.ok(qa, '答疑模式必须与学习模式一起注册');
  assert.equal(qa.name, '答疑模式');
  assert.notEqual(qa.order, state.config.order);
  assert.deepEqual(qa.plugins.find(row => row.id === 'skill-filesystem').config.customSkillDirs,
    [`${packageSkills}/local-qa`]);
  assert.ok(qa.plugins.some(row => row.id === 'studymate-qa-tools'
    && row.name === '@yunmiao/studymate/qa-preset'));
  // 原生加载的引擎 = 已安装的包自身：<root> 是包目录，技能随包发布，摆在包里的 preset/skills
  // （不是 `.dsh/skills`——那是宿主默认项目根扫描会命中的位置，见 test_skill_visibility.mjs）
  assert.ok(fs.statSync(path.join(root, 'preset/skills/learning-system/SKILL.md')).isFile());
  assert.equal(fs.existsSync(f.patch), false);
  assert.equal(fs.existsSync(path.join(f.dshHome, '.agent-presets')), false);
  // ~/.dsh/studymate/ 里不再有源码树副本——连空壳目录都不留
  assert.equal(fs.existsSync(path.join(f.dshHome, 'studymate')), false);
  assert.equal(f.yaml(f.config).root, root);
  assert.equal(f.yaml(f.config).workspace, fs.realpathSync(f.workspace));
  const data = path.join(f.workspace, '.learning', 'subjects', 'keep.txt');
  fs.writeFileSync(data, 'my learning data');
  const config = { ...f.yaml(f.config), custom: 'keep' };
  fs.writeFileSync(f.config, JSON.stringify(config));
  const again = f.boot({ LEARN_WORKSPACE: '' });
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.equal(f.yaml(f.config).custom, 'keep');
  assert.equal(fs.readFileSync(data, 'utf8'), 'my learning data');
  assert.deepEqual(snapshot(skills), skillsBefore, '原生加载不许往包目录里写');
  assert.equal(fs.existsSync(path.join(f.dshHome, 'studymate')), false);
});

test('native startup leaves installer-managed registration and payload unchanged', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.patch), { recursive: true });
  fs.writeFileSync(f.patch, '# unrelated plugin\n- id: keep\n  disabled: true\n');
  const cliUrl = pathToFileURL(path.join(root, 'bin/studymate.mjs')).href;
  const installed = f.run(`import {installPayload} from ${JSON.stringify(cliUrl)};
    installPayload({version:'0.1.7-alpha.1'});`);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(fs.readFileSync(f.patch, 'utf8'), /BEGIN STUDYMATE/);
  const data = path.join(f.workspace, '.learning', 'subjects', 'keep.txt');
  fs.writeFileSync(data, 'my learning data');
  const before = snapshot(f.dshHome);
  const attempted = f.boot();
  assert.equal(attempted.status, 0, attempted.stdout + attempted.stderr);
  const state = JSON.parse(attempted.stdout);
  assert.equal(state.registered, 0);
  assert.match(state.warnings.join('\n'), /--mode native/);
  assert.deepEqual(snapshot(f.dshHome), before);
  assert.equal(fs.readFileSync(data, 'utf8'), 'my learning data');
});

test('standalone installation in another profile preserves native Web ownership', t => {
  const f = fixture(t);
  const initial = f.boot();
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);
  assert.equal(JSON.parse(initial.stdout).registered, 2);
  assert.deepEqual(f.yaml(f.config).installModes, { web: 'native' });
  const cliUrl = pathToFileURL(path.join(root, 'bin/studymate.mjs')).href;
  const installed = f.run(`import {installPayload} from ${JSON.stringify(cliUrl)};
    installPayload({version:'0.1.7-alpha.1', profile:'headless'});`);
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual(f.yaml(f.config).installModes, { web: 'native', headless: 'standalone' });
  const headlessPatch = path.join(f.dshHome, 'profiles', 'headless', 'cordis.patch.yml');
  const preset = path.join(f.dshHome, '.agent-presets', 'learning', 'agent.cordis.yml');
  const originalPatch = fs.readFileSync(headlessPatch);
  const originalPreset = fs.readFileSync(preset);
  const restarted = f.boot();
  assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr);
  const state = JSON.parse(restarted.stdout);
  assert.equal(state.registered, 2);
  assert.deepEqual(state.warnings, []);
  assert.deepEqual(f.yaml(f.config).installModes, { web: 'native', headless: 'standalone' });
  assert.deepEqual(fs.readFileSync(headlessPatch), originalPatch);
  assert.deepEqual(fs.readFileSync(preset), originalPreset);
});

test('native startup does not take over an old legacy installer without an ownership marker', t => {
  const f = fixture(t);
  const cliUrl = pathToFileURL(path.join(root, 'bin/studymate.mjs')).href;
  const installed = f.run(`import {installPayload} from ${JSON.stringify(cliUrl)};
    installPayload({version:'0.1.5-rc.2'});`);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(fs.existsSync(f.patch), false);
  const oldConfig = f.yaml(f.config);
  delete oldConfig.installModes;
  fs.writeFileSync(f.config, JSON.stringify(oldConfig));
  assert.ok(fs.existsSync(path.join(f.dshHome, '.agent-presets', 'learning', 'agent.cordis.yml')));
  const before = snapshot(f.dshHome);
  const result = f.boot();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.registered, 0);
  assert.match(state.warnings.join('\n'), /--mode native/);
  assert.deepEqual(snapshot(f.dshHome), before);
});

test('native startup warns about manual learning declarations without replacing data', t => {
  const f = fixture(t);
  assert.equal(f.boot().status, 0);
  fs.mkdirSync(path.dirname(f.patch), { recursive: true });
  const manual = '- insert:\n  - id: custom-learning\n    name: "@deepseek-ai/dsh-agent-preset"\n    config: {id: learning, plugins: []}\n';
  fs.writeFileSync(f.patch, manual);
  const before = snapshot(f.dshHome);
  const failed = f.boot();
  assert.equal(failed.status, 0, failed.stdout + failed.stderr);
  const state = JSON.parse(failed.stdout);
  assert.equal(state.registered, 0);
  assert.match(state.warnings.join('\n'), /learning/);
  assert.deepEqual(snapshot(f.dshHome), before);
});

test('registry failures are reported without stopping the host or deleting learning data', t => {
  const f = fixture(t);
  assert.equal(f.boot().status, 0);
  const data = path.join(f.workspace, '.learning', 'subjects', 'keep.txt');
  fs.writeFileSync(data, 'my learning data');
  const result = f.boot({}, 'duplicate');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.registered, 1);
  assert.equal(state.disposed, 0);
  assert.match(state.warnings.join('\n'), /Duplicate agent preset: learning/);
  assert.equal(fs.readFileSync(data, 'utf8'), 'my learning data');
});

test('public entry re-exports the plugin contract (inject / apply / Config)', async () => {
  // 宿主读的是 package.json exports["."] 那个 `.mjs`，不是 `bin/dsh-plugin.ts`：
  // Config 只写在 TS 里、入口忘了转出去，schema 就永远读不到（Config provider 报 absent）。
  const entry = await import(pathToFileURL(path.join(root, 'bin', 'dsh-plugin.mjs')).href);
  assert.deepEqual(entry.inject, ['agentPresets']);
  assert.equal(typeof entry.apply, 'function');
  assert.equal(typeof entry.Config, 'function', '入口没有转出 Config：插件页的配置表单不会出现');
});

test('an install-boundary failure is reported without stopping the host or creating installation files', t => {
  const f = fixture(t);
  const copied = path.join(f.dir, 'dsh-plugin.ts');
  fs.copyFileSync(path.join(root, 'bin/dsh-plugin.ts'), copied);
  // schemastery 由宿主提供（`dsh-win-pwsh7` 同一条静态 import）：这里把宿主那份放进临时
  // 目录，模拟「宿主在，但插件边界缺 lib/」；var 的 installPayload 桩照旧制造边界失败。
  provideHostSchema(f.dir);
  // 把插件入口单独拷到一个没有 lib/ 的目录里：顶层静态 import 会让这条用例在解析期就崩，
  // 这里的桩模拟的是**安装器边界失败**（老宿主 / 缺依赖），插件该只警告、不建安装文件。
  fs.writeFileSync(path.join(f.dir, 'studymate.mjs'),
    'export function installPayload() { throw new Error("安装器边界失败：宿主不支持原生加载"); }');
  const result = f.boot({}, 'normal', pathToFileURL(copied).href);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.registered, 0);
  assert.match(state.warnings.join('\n'), /安装器边界失败/);
  assert.equal(fs.existsSync(f.dshHome), false);
});

test('an old host skips unsupported native loading without blocking startup', async () => {
  const { apply } = await import(plugin);
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    await apply({});
    await apply({ get: () => ({ name: 'web', home: '/unused' }) });
  } finally {
    console.warn = previousWarn;
  }
  assert.equal(warnings.length, 2);
  for (const warning of warnings) {
    assert.match(warning, /0\.1\.7-alpha\.1/);
    assert.match(warning, /npx -y @yunmiao\/studymate@latest install/);
  }
});

test('packed npm package loads CLI and both plugins inside node_modules', t => {
  const f = fixture(t);
  const consumer = path.join(f.dir, "npm 用户 O'Brien #1");
  const packs = path.join(f.dir, 'packs');
  fs.mkdirSync(consumer, { recursive: true });
  fs.mkdirSync(packs);
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const env = { ...f.env, NODE_OPTIONS: '', npm_config_cache: path.join(f.dir, 'npm-cache') };
  const npmCli = process.env.npm_execpath || (process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : null);
  const npm = (args, cwd) => spawnSync(npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...args] : args,
    { cwd, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  const passed = result => {
    assert.equal(result.status, 0, String(result.error || '') + result.stderr + result.stdout);
    return result;
  };
  const packed = passed(npm(['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', packs], root));
  // 这份就是发布件：Release 的发放白名单（validatePack）必须认它。#155 之前门禁里没人问过
  // 这一句——README.en.md 不在 files 里、npm 却一定会打进去，于是门禁全绿、发布卡死。
  validatePack(JSON.parse(packed.stdout)[0]);
  const archive = path.join(packs, JSON.parse(packed.stdout)[0].filename);
  passed(npm(['install', archive, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer));
  const installed = path.join(consumer, 'node_modules', '@yunmiao', 'studymate');
  // 同样的道理：schemastery 由宿主提供，消费者目录里补一份（真实 profile 里它在宿主那一层）。
  provideHostSchema(consumer);
  // 必须是 npm 解出来的真实 node_modules 路径；源码检出与 npm link 都复现不了这次故障。
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), false);
  const version = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version;
  const run = (args) => passed(spawnSync(process.execPath, args,
    { cwd: consumer, env, encoding: 'utf8', timeout: 30000, windowsHide: true }));

  // 每条公开入口都在全新的 Node 进程里启动，不能借前一条入口已经注册的加载钩子过关。
  assert.equal(run([path.join(installed, 'bin', 'studymate.mjs'), '--version']).stdout.trim(), version);
  const foreign = path.join(consumer, 'node_modules', 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'package.json'), JSON.stringify({ type: 'module', exports: './index.ts' }));
  fs.writeFileSync(path.join(foreign, 'index.ts'), 'export const marker: number = 1;\n');
  run(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { inject, apply, Config } from '@yunmiao/studymate';
    assert.deepEqual(inject, ['agentPresets']);
    assert.equal(typeof Config, 'function', '打包件的入口没有转出 Config');
    const configs = [], effects = [], warnings = [];
    console.warn = message => warnings.push(String(message));
    let disposed = 0;
    await apply({
      get: () => ({ name: 'web', home: process.env.DSH_HOME }),
      agentPresets: { register: config => {
        configs.push(config);
        return () => { disposed++; };
      } },
      effect: async fn => { effects.push(await fn()); },
    });
    assert.deepEqual(configs.map(config => config.id), ['learning', 'qa']);
    assert.deepEqual(warnings, []);
    for (const dispose of effects) await dispose();
    assert.equal(disposed, 2);
    await assert.rejects(import('foreign'), { code: 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING' });
  `]);
  assert.equal(f.yaml(f.config).root, installed);
  run(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { inject, apply } from '@yunmiao/studymate/qa-preset';
    assert.deepEqual(inject, ['tools']);
    const definitions = [], restrictions = [];
    apply({
      tools: {
        register: definition => { definitions.push(definition); return () => {}; },
        restrict: filter => { restrictions.push(filter); },
      },
      effect: fn => fn(),
    });
    assert.deepEqual(definitions.map(definition => definition.name), ['studymate_lesson_read']);
    assert.deepEqual(definitions[0].declaration.writes, {});
    // #138：原生工具搬进「学习模式」预设作用域之后，答疑这条不再需要 deny 那一半
    assert.deepEqual(restrictions, []);

    // #138：学习模式那条插件行把全部原生工具注册进**预设作用域**
    const learning = await import('@yunmiao/studymate/learning-preset');
    assert.deepEqual(learning.inject, ['tools']);
    const learningDefinitions = [];
    learning.apply({
      tools: { register: definition => { learningDefinitions.push(definition); return () => {}; } },
      effect: fn => fn(),
    });
    const learningNames = learningDefinitions.map(definition => definition.name);
    assert.equal(learningNames.length, 15);
    for (const name of ['studymate_workspace_context', 'studymate_verify_sources',
      'studymate_task_cancel', 'studymate_lab_run']) {
      assert.ok(learningNames.includes(name), name + ' 要由学习预设那条插件行注册');
    }
    // 答疑那条自己一个都不注册（工具面只有只读的取课件工具）
    assert.deepEqual(learningNames.filter(name => definitions.some(item => item.name === name)), []);
  `]);
});
