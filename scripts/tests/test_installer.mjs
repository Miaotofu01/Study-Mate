import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { supportsDsh, findDsh, isDesktopLauncher, desktopResourceDirs, defaultProfile } from '../../bin/studymate.mjs';
import { adaptSkill } from '../../bin/skill-compat.mjs';
import { parseYaml } from '../../lib/yaml.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'bin/studymate.mjs');
const launcher = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';

/** Write a runnable dsh at a Desktop-shaped location and return its path. */
function desktopLauncher(directory, version) {
  const shim = path.join(directory, 'resources', 'runtime', 'cli', 'bin', launcher);
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, process.platform === 'win32' ? `@echo ${version}\r\n` : `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
    { mode: 0o755 });
  return shim;
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "家 O'Brien #1");
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh') };
  delete env.LEARN_WORKSPACE;
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = bin + path.delimiter + (env[pathKey] || '');
  const preset = path.join(env.DSH_HOME, '.agent-presets', 'learning', 'agent.cordis.yml');
  const patch = path.join(env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml');
  const config = path.join(env.DSH_HOME, 'studymate-config.yaml');
  function version(value) {
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'),
      process.platform === 'win32' ? `@echo ${value}\r\n` : `#!/bin/sh\nprintf '%s\\n' '${value}'\n`, { mode: 0o755 });
  }
  // Stands in for a machine with no dsh on PATH: the shim resolves but never answers.
  function breakDsh() {
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'),
      process.platform === 'win32' ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  function install(...args) {
    return spawnSync(process.execPath, [cli, 'install', ...args], { cwd: dir, env, encoding: 'utf8', timeout: 30000 });
  }
  // 读配置与补丁用**本仓库自己的解析器**（与安装器同一份，所以读到的东西不会两边不一样）。
  function yaml(file) {
    return parseYaml(fs.readFileSync(file, 'utf8'),
      { file, tags: 'scalar', blockScalars: true, documentMarkers: true });
  }
  version('0.1.7-alpha.1');
  return { dir, home, env, preset, patch, config, version, breakDsh, install, yaml };
}

test('minimum DSH prerelease is compared correctly', () => {
  for (const version of ['0.1.5-rc.2', '0.1.5-rc.10', '0.1.5', '0.1.6-alpha.1', '0.1.7-alpha.1']) assert.ok(supportsDsh(version), version);
  for (const version of ['0.1.4', '0.1.5-alpha.9', '0.1.5-rc.1', 'bad']) assert.equal(supportsDsh(version), false, version);
});

test('desktop installations are recognized on every platform', () => {
  assert.equal(isDesktopLauncher(path.join('C:\\', 'Program Files', 'DeepSeek Harness',
    'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')), true);
  assert.equal(isDesktopLauncher('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'), true);
  assert.equal(isDesktopLauncher(path.join('C:\\', 'Users', 'me', 'AppData', 'Roaming', 'npm', 'dsh.cmd')), false);
  assert.equal(isDesktopLauncher('/usr/local/bin/dsh'), false);

  const win = desktopResourceDirs({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\local', ProgramFiles: 'C:\\pf' }, home: 'C:\\me' });
  assert.ok(win.includes(path.join('C:\\local', 'Programs', 'DeepSeek Harness', 'resources')), String(win));
  assert.ok(win.includes(path.join('C:\\pf', 'DeepSeek Harness', 'resources')), String(win));
  const mac = desktopResourceDirs({ platform: 'darwin', env: {}, home: '/Users/me' });
  assert.ok(mac.includes(path.join('/Users/me', 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources')), String(mac));
});

test('a runnable dsh is taken from the explicit path, PATH, then the Desktop installation', () => {
  const env = { LOCALAPPDATA: 'C:\\local', ComSpec: 'cmd.exe' };
  const shim = path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  // Answer only the launchers named here, the way a real machine would.
  const answering = (answers) => (command, args) => {
    const line = [command, ...args].join(' ');
    for (const [needle, stdout] of answers) if (line.includes(needle)) return { status: 0, stdout };
    return { status: 1, stdout: '' };
  };

  // No dsh on PATH: the Desktop launcher is the only one that answers.
  let found = findDsh({ platform: 'win32', env, home: 'C:\\me',
    execute: answering([[shim, '0.2.0-rc.2\n']]) });
  assert.deepEqual({ command: found.command, version: found.version, desktop: found.desktop },
    { command: shim, version: '0.2.0-rc.2', desktop: true });

  // A Desktop shim earlier on PATH stays Desktop, which decides the profile below.
  const npmShim = path.join('C:\\local', 'Roaming', 'npm', 'dsh.cmd');
  found = findDsh({ platform: 'win32', env, home: 'C:\\me', execute: answering([
    ['"where dsh"', `${shim}\r\n`], ['""dsh" --version"', '0.2.0-rc.2\n']]) });
  assert.deepEqual({ command: found.command, desktop: found.desktop }, { command: shim, desktop: true });

  // The official CLI keeps its own identity and wins over a Desktop installation.
  found = findDsh({ platform: 'win32', env, home: 'C:\\me', execute: answering([
    ['"where dsh"', `${npmShim}\r\n`], ['""dsh" --version"', '0.1.7-alpha.1\n'], [shim, '0.2.0-rc.2\n']]) });
  assert.deepEqual({ command: found.command, version: found.version, desktop: found.desktop },
    { command: npmShim, version: '0.1.7-alpha.1', desktop: false });

  // An outdated dsh on PATH cannot serve this preset, so a usable Desktop launcher still wins.
  found = findDsh({ platform: 'win32', env, home: 'C:\\me', execute: answering([
    ['"where dsh"', `${npmShim}\r\n`], ['""dsh" --version"', '0.1.4\n'], [shim, '0.2.0-rc.2\n']]) });
  assert.deepEqual({ command: found.command, version: found.version, desktop: found.desktop },
    { command: shim, version: '0.2.0-rc.2', desktop: true });
  // With nothing usable the outdated launcher is reported, not silently replaced by web.
  found = findDsh({ platform: 'win32', env, home: 'C:\\me', execute: answering([
    ['"where dsh"', `${npmShim}\r\n`], ['""dsh" --version"', '0.1.4\n']]) });
  assert.deepEqual({ version: found.version, desktop: found.desktop }, { version: '0.1.4', desktop: false });

  // An explicit launcher is tried first, and a failed probe is reported, not guessed.
  found = findDsh({ platform: 'win32', env, home: 'C:\\me', explicit: shim,
    execute: answering([[shim, '0.2.0-rc.2\n']]) });
  assert.deepEqual({ command: found.command, desktop: found.desktop }, { command: path.resolve(shim), desktop: true });

  // Batch wrappers may echo setup commands before @echo off; still honor the
  // explicit Desktop version instead of falling back to an older CLI on PATH.
  const echoedCommands = 'C:\\plugins\\0.9.0>REM plugin setup\r\nC:\\plugins\\0.9.0>set NODE_OPTIONS=--require C:\\plugins\\0.9.0\\hook.js\r\n';
  found = findDsh({ platform: 'win32', env, home: 'C:\\me', explicit: shim,
    execute: answering([[shim, `${echoedCommands}0.2.0-rc.2\r\n`],
      ['""dsh" --version"', '0.1.5-rc.3\n'], ['"where dsh"', `${npmShim}\r\n`]]) });
  assert.deepEqual({ command: found.command, version: found.version, desktop: found.desktop },
    { command: path.resolve(shim), version: '0.2.0-rc.2', desktop: true });

  // The final complete version line is the launcher's answer, even if its wrapper
  // printed another version or emits a trailing notice.
  found = findDsh({ platform: 'win32', env, home: 'C:\\me', explicit: shim,
    execute: answering([[shim, '0.1.4\r\n  v0.2.0-rc.2+desktop.1  \r\nlauncher finished\r\n']]) });
  assert.equal(found.version, 'v0.2.0-rc.2+desktop.1');

  // Command echoes containing version-like paths are not a version response.
  found = findDsh({ platform: 'win32', env, home: 'C:\\me', explicit: shim,
    execute: answering([[shim, echoedCommands]]) });
  assert.equal(found.version, undefined);
  found = findDsh({ platform: 'win32', env, home: 'C:\\me', execute: answering([]) });
  assert.equal(found.version, undefined);
  assert.equal(found.checked[0], 'dsh');
});

test('the profile is Desktop, then the profile the last install recorded, then web', () => {
  assert.equal(defaultProfile({ desktop: true, installModes: { web: 'standalone' } }), 'desktop');
  assert.equal(defaultProfile({ desktop: false, installModes: { desktop: 'standalone' } }), 'desktop');
  assert.equal(defaultProfile({ desktop: false, installModes: { web: 'native', desktop: 'standalone' } }), 'web');
  assert.equal(defaultProfile({ desktop: false, installModes: {} }), 'web');
});

test('a Desktop launcher registers the learning mode in the reserved desktop profile', t => {
  const f = fixture(t);
  const shim = desktopLauncher(path.join(f.dir, 'DeepSeek Harness'), '0.2.0-rc.2');
  const profile = path.join(f.env.DSH_HOME, 'profiles', 'desktop');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop' }));
  const result = f.install('--dsh', shim, '--workspace', path.join(f.dir, 'workspace'));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.yaml(path.join(profile, 'cordis.patch.yml'))[0].insert[0].config.id, 'learning');
  assert.equal(fs.existsSync(f.patch), false, '不该写到 web profile');
  assert.equal(f.yaml(f.config).installModes.desktop, 'standalone');
  // 桌面端不认 `dsh web`：收尾提示要指向桌面端自己的重启方式。
  assert.match(result.stdout, /DeepSeek Harness 桌面端新建会话/);
});

test('the reserved desktop profile must be initialized by the application first', t => {
  const f = fixture(t);
  const shim = desktopLauncher(path.join(f.dir, 'DeepSeek Harness'), '0.2.0-rc.2');
  const failed = f.install('--dsh', shim, '--workspace', path.join(f.dir, 'workspace'));
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /先启动一次 DeepSeek Harness 桌面端/);
  assert.equal(fs.existsSync(f.config), false);
  assert.equal(fs.existsSync(path.join(f.env.DSH_HOME, 'studymate')), false);
});

test('a Desktop installation is found when no dsh is on PATH', { skip: process.platform !== 'win32' && '桌面端候选目录只按 Windows 的安装位置扫描' }, t => {
  const f = fixture(t);
  const local = path.join(f.dir, 'local');
  desktopLauncher(path.join(local, 'Programs', 'DeepSeek Harness'), '0.2.0-rc.2');
  const profile = path.join(f.env.DSH_HOME, 'profiles', 'desktop');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop' }));
  // Keep the system PATH (node must stay reachable) but let dsh fail, and point the
  // Windows installation roots at the fixture so no real Desktop installation decides this.
  f.breakDsh();
  const env = { ...f.env, LOCALAPPDATA: local,
    ProgramFiles: path.join(f.dir, 'pf'), ProgramW6432: path.join(f.dir, 'pf64'), 'ProgramFiles(x86)': path.join(f.dir, 'pf86') };
  const result = spawnSync(process.execPath, [cli, 'install', '--workspace', path.join(f.dir, 'workspace')],
    { cwd: f.dir, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.yaml(path.join(profile, 'cordis.patch.yml'))[0].insert[0].config.id, 'learning');
  assert.equal(fs.existsSync(f.patch), false, '桌面端的 dsh 被找到时不该退回 web profile');
});

test('installed skill copies get the write-boundary conventions in machine terms', () => {
  const sample = ['临时目录：`/tmp/studymate-scratch/<slug>`',
    '角色产出走 `<subject_path>/.stage/practice-evaluator-<节点id>/deliver/`',
    '原样合并 `/tmp/practice-evaluator-<节点id>/deliver/.` 到科目目录'].join('\n');
  const adapted = adaptSkill(sample, {
    platform: 'win32',
    configFile: 'C:\\Users\\me\\.dsh\\studymate-config.yaml', tempDirectory: 'C:/Temp',
  });
  assert.ok(!adapted.includes('`/tmp`'), '临时目录应换成本机实值');
  assert.match(adapted, /C:\/Temp\/studymate-scratch\/<slug>/);
  assert.match(adapted, /先写科目自己的 `<subject_path>\/\.stage\//);
});

test('技能副本的本机命令约定不再提 Python 与引擎脚本（#83 退役）', () => {
  // 引擎脚本随 #83 退役，`adaptSkill` 里的 python 规整也一并删掉：本机命令约定现在只讲
  // 环境变量、路径引用与临时目录。这条守着它不会回来——样例里刻意不写脚本扩展名，
  // 仓库里不再出现那两个字样。
  const adapted = adaptSkill('临时目录：`/tmp/studymate-scratch/<slug>`', {
    platform: 'linux', configFile: '/home/me/studymate-config.yaml', tempDirectory: '/tmp',
  });
  assert.doesNotMatch(adapted, /python/i, '命令约定里不该再提 Python');
  assert.ok(adapted.includes('本机命令约定（安装器生成）'));
});

test('install, reinstall and downgrade preserve workspace and unrelated profile configuration', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.patch), { recursive: true });
  const original = '# my other plugin\n- id: user-plugin\n  disabled: true\n';
  fs.writeFileSync(f.patch, original);
  const workspace = path.join(f.dir, '学习 [1]');
  let result = f.install('--workspace', workspace);
  assert.equal(result.status, 0, result.stderr);
  let patch = fs.readFileSync(f.patch, 'utf8');
  assert.ok(patch.startsWith(original));
  const row = f.yaml(f.patch).find(row => row.insert)?.insert[0];
  assert.equal(row.name, '@deepseek-ai/dsh-agent-preset');
  assert.equal(row.config.id, 'learning');
  const plugins = [];
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (value.id) plugins.push(value);
    for (const child of Object.values(value)) collect(child);
  }
  collect(row.config.plugins);
  assert.equal(plugins.find(plugin => plugin.id === 'workflow-ptc').name, '@deepseek-ai/dsh-workflow-ptc');
  assert.deepEqual(plugins.find(plugin => plugin.id === 'skill-filesystem').config.customSkillDirs,
    [path.join(f.env.DSH_HOME, 'studymate', 'engine', 'preset', 'skills').split(path.sep).join('/')]);
  assert.match(fs.readFileSync(f.preset, 'utf8'), /@deepseek-ai\/dsh-workflow-ptc/);
  // 安装完必须说清"会话开在哪"：会话目录不在工作区里时，StudyMate 每一步落盘都要授权。
  assert.match(result.stdout, /启动会话时把工作目录设为/);
  // 装出来的技能副本是本机口径：产物交接的 `.stage/` 约定保留，`/tmp` 写成这台机器的
  // 临时目录（Linux 上两者常常都是 /tmp，所以真正钉住改写的是上面那条注入临时目录的断言）；
  // **工作区暂存模式已删**（ADR-0008），副本里不该再有会话目录下的暂存根。
  const skillCopy = fs.readFileSync(path.join(f.env.DSH_HOME, 'studymate', 'engine',
    'preset', 'skills', 'learning-system', 'SKILL.md'), 'utf8');
  assert.match(skillCopy, /<subject_path>\/\.stage\//);
  assert.ok(!skillCopy.includes('.studymate-stage'), '暂存模式已删：副本里不该再有工作区暂存根');
  const config = f.yaml(f.config);
  config.custom = 'keep';
  fs.writeFileSync(f.config, JSON.stringify(config));
  const notes = path.join(workspace, '.learning', 'subjects', 'notes.md');
  fs.writeFileSync(notes, 'my learning notes');
  result = f.install();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.patch, 'utf8'), patch);
  assert.equal(f.yaml(f.config).workspace, fs.realpathSync(workspace));
  assert.equal(f.yaml(f.config).custom, 'keep');
  assert.equal(fs.readFileSync(notes, 'utf8'), 'my learning notes');
  for (const [version, workflow] of [['0.1.6-alpha.1', 'ptc'], ['0.1.5-rc.2', 'worker-thread']]) {
    f.version(version);
    result = f.install();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(f.patch, 'utf8').trim(), original.trim());
    assert.ok(fs.readFileSync(f.preset, 'utf8').includes(`@deepseek-ai/dsh-workflow-${workflow}`));
  }
});

test('workspace paths expand home and resolve relative to the invocation directory', t => {
  const f = fixture(t);
  for (const [workspace, expected] of [
    ['~/学习笔记', path.join(f.home, '学习笔记')],
    ["relative [1] O'Brien # notes", path.join(f.dir, "relative [1] O'Brien # notes")],
  ]) {
    const result = f.install('--workspace', workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.yaml(f.config).workspace, fs.realpathSync(expected));
    assert.equal(f.install().status, 0);
    assert.equal(f.yaml(f.config).workspace, fs.realpathSync(expected));
  }
});

test('invalid profile patch fails before replacing a working install', t => {
  const f = fixture(t);
  const result = f.install('--workspace', path.join(f.dir, 'workspace'));
  assert.equal(result.status, 0, result.stderr);
  const before = fs.readFileSync(f.preset, 'utf8');
  const config = fs.readFileSync(f.config, 'utf8');
  fs.writeFileSync(f.patch, 'not: [valid');
  const failed = f.install();
  assert.notEqual(failed.status, 0);
  assert.equal(fs.readFileSync(f.preset, 'utf8'), before);
  assert.equal(fs.readFileSync(f.config, 'utf8'), config);
  assert.equal(fs.readFileSync(f.patch, 'utf8'), 'not: [valid');
  assert.equal(fs.readdirSync(f.env.DSH_HOME).some(name => name.startsWith('.studymate-install-')), false);
});

test('profile option registers only the selected profile and rejects traversal', t => {
  const f = fixture(t);
  assert.notEqual(f.install('--profile', '../outside').status, 0);
  assert.equal(fs.existsSync(f.config), false);
  const result = f.install('--profile', 'headless', '--workspace', path.join(f.dir, 'workspace'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(f.patch), false);
  assert.equal(f.yaml(path.join(f.env.DSH_HOME, 'profiles', 'headless', 'cordis.patch.yml'))[0].insert[0].config.id, 'learning');
});

test('default install manages learning and disables only the selected StudyMate bundle', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.patch), { recursive: true });
  const original = '# unrelated plugin\n- id: keep\n  disabled: false\n';
  const manifest = path.join(path.dirname(f.patch), 'package.json');
  const manifestText = JSON.stringify({ dependencies: { '@yunmiao/studymate': '0.1.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@yunmiao/studymate'] } } });
  fs.writeFileSync(manifest, manifestText);
  for (const version of ['0.1.7-alpha.1', '0.1.5-rc.2']) {
    f.version(version);
    fs.writeFileSync(f.patch, original);
    const result = f.install('--workspace', path.join(f.dir, 'workspace'));
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const rows = f.yaml(f.patch);
    assert.deepEqual(rows[0], { id: 'keep', disabled: false });
    const guard = rows.find(row => row.id === 'studymate');
    assert.deepEqual(guard, { id: 'studymate', name: '@yunmiao/studymate', disabled: true });
    const declarations = rows.flatMap(row => row.insert || []).filter(row => row.config?.id === 'learning');
    assert.equal(declarations.length, version === '0.1.7-alpha.1' ? 1 : 0);
    assert.equal(fs.readFileSync(manifest, 'utf8'), manifestText);
    assert.ok(fs.existsSync(f.preset));
    assert.equal(f.yaml(f.config).installModes.web, 'standalone');
    const before = fs.readFileSync(f.patch, 'utf8');
    assert.equal(f.install().status, 0);
    assert.equal(fs.readFileSync(f.patch, 'utf8'), before);
  }
});

test('explicit native switch records ownership and removes registration without replacing payload or user files', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.patch), { recursive: true });
  const original = '# my other plugin\n- id: unrelated\n  disabled: true\n';
  fs.writeFileSync(f.patch, original);
  const manifest = path.join(path.dirname(f.patch), 'package.json');
  const manifestText = JSON.stringify({ dependencies: { '@yunmiao/studymate': '0.1.3' },
    dsh: { profile: { bundles: ['@yunmiao/studymate'] } } });
  fs.writeFileSync(manifest, manifestText);
  const lockfile = path.join(path.dirname(f.patch), 'pnpm-lock.yaml');
  fs.writeFileSync(lockfile, '# existing package manager lock\n');
  const installed = f.install('--workspace', path.join(f.dir, 'workspace'));
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(fs.readFileSync(f.patch, 'utf8'), /BEGIN STUDYMATE/);
  const engineSentinel = path.join(f.env.DSH_HOME, 'studymate', 'engine', 'keep.txt');
  fs.writeFileSync(engineSentinel, 'existing engine');
  const learningData = path.join(f.yaml(f.config).workspace, '.learning', 'subjects', 'keep.txt');
  fs.writeFileSync(learningData, 'my notes');
  const originalConfig = { ...f.yaml(f.config), custom: 'keep',
    installModes: { ...f.yaml(f.config).installModes, headless: 'standalone' } };
  fs.writeFileSync(f.config, JSON.stringify(originalConfig));
  const untouched = [f.preset, manifest, lockfile, engineSentinel, learningData];
  const before = untouched.map(file => fs.readFileSync(file));
  const switched = f.install('--mode', 'native');
  assert.equal(switched.status, 0, switched.stderr + switched.stdout);
  assert.equal(fs.readFileSync(f.patch, 'utf8'), original);
  untouched.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index], file));
  assert.deepEqual(f.yaml(f.config), { ...originalConfig,
    installModes: { ...originalConfig.installModes, web: 'native' } });
  assert.equal(f.install('--mode', 'native').status, 0);
  assert.equal(fs.readFileSync(f.patch, 'utf8'), original);
});

test('native switch refuses unsupported hosts, missing bundles and invalid modes without changing installation', t => {
  const f = fixture(t);
  const installed = f.install('--workspace', path.join(f.dir, 'workspace'));
  assert.equal(installed.status, 0, installed.stderr);
  const paths = [f.patch, f.config, f.preset];
  const before = paths.map(file => fs.readFileSync(file));
  const checkUnchanged = () => paths.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index], file));
  assert.notEqual(f.install('--mode', 'native').status, 0);
  checkUnchanged();
  const manifest = path.join(path.dirname(f.patch), 'package.json');
  fs.writeFileSync(manifest, JSON.stringify({ dsh: { profile: { bundles: ['@yunmiao/studymate'] } } }));
  f.version('0.1.6-alpha.2');
  const unsupported = f.install('--mode', 'native');
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /0\.1\.7-alpha\.1/);
  checkUnchanged();
  f.version('0.1.7-alpha.1');
  assert.notEqual(f.install('--mode', 'unexpected').status, 0);
  checkUnchanged();
});
