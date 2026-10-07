#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { adaptSkill } from './skill-compat.mjs';
import { buildOpenAiPlugin } from './openai-plugin.mjs';
import { buildAntigravityPlugin } from './antigravity-plugin.mjs';
import { listDocMarkdown } from './docs-payload.mjs';
import { readConfigObject } from '../lib/workspace.ts';
import { installPreset } from '../lib/preset.ts';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
const help = `StudyMate ${metadata.version}

在 DSH 中安装或更新 StudyMate：npx -y @yunmiao/studymate@latest install
Codex / ChatGPT Work：下载并导入最新插件 ZIP：
https://github.com/Miaotofu01/Study-Mate/releases/latest/download/studymate-openai.zip

用法：studymate [install] [--workspace <目录>] [--profile <名称>] [--mode standalone|native] [--dsh <dsh 路径>]
      studymate export [--workspace <目录>] [--out <目录>] [--subject <slug>] [--json] [--quiet]
      studymate build-plugin [--output <目录>]（开发者构建）
      studymate build-antigravity [--output <目录>] [--install]（Antigravity 插件构建）
      studymate --help | --version

将学习模式和引擎安装到 DSH_HOME（默认 ~/.dsh）。
工作区优先使用 --workspace、LEARN_WORKSPACE、已有配置，首次默认为 ~/StudyMate。
安装器先找 PATH 里的 dsh，找不到就用 DeepSeek Harness 桌面端自带的 dsh；
桌面端（或 --dsh 指向桌面端自带的 dsh）默认注册到它的 desktop profile，
其余情况优先沿用上次安装的 profile，首次默认 web；都可用 --profile 覆盖。
桌面端装在非默认目录时，用 --dsh "<安装目录>/resources/runtime/cli/bin/dsh.cmd" 指定。
默认由安装器管理；已添加 DSH 原生插件时，可用 --mode native 显式切换。
需要 Node.js ^22.19.0 或 >=24、dsh >=0.1.5-rc.2。
安装器不会安装或升级 dsh，也不会重启正在运行的会话。

更新使用相同的 install 命令，沿用已有学习工作区。
export 把学习工作区导成能离线打开的自包含页面：Antigravity / Codex 侧课完默认导一份，
DSH 侧按需（学生说“导出一份能离线看的”才跑）。落点默认 <工作区>/export/，不需要 DSH；
它要一份 React（npm i -g react react-dom，或设 STUDYMATE_REACT_DIR 指过去）。
build-plugin 供开发者导出 Codex / ChatGPT Work 技能插件目录及 ZIP（默认 ./dist）。
导出只需要 Node.js，不需要 DSH，也不会更改客户端配置。`;

function run(command, args, extra = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 15000, windowsHide: true, ...extra });
}

// DeepSeek Harness Desktop ships its own dsh at <resources>/runtime/cli/bin, and
// rejects its reserved profile from any other launcher. Its Electron guest takes
// seconds to answer `--version` where the Node CLI takes milliseconds, so give it
// a wide window instead of timing out on a busy machine.
function runDesktop(command, args, extra = {}) {
  return run(command, args, { timeout: 60000, ...extra });
}

const DESKTOP_LAUNCHER = /\/runtime\/cli\/bin\/dsh(?:\.(?:cmd|bat|ps1|exe|sh))?$/i;

/** Whether a launcher path is the command shim a Desktop installation publishes. */
export function isDesktopLauncher(file) {
  return typeof file === 'string' && DESKTOP_LAUNCHER.test(file.replaceAll('\\', '/'));
}

/**
 * Resources directories an installed Desktop application can occupy, nearest first.
 * Every platform keeps its command shim at <resources>/runtime/cli/bin, so finding
 * the directory is enough to use that installation regardless of where it lives.
 */
export function desktopResourceDirs({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const dirs = [];
  const add = (value) => { if (value && !dirs.includes(value)) dirs.push(value); };
  const scan = (parent, names, suffix) => {
    if (!parent) return;
    for (const name of names) add(path.join(parent, name, suffix));
    let entries;
    try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && /harness|deepseek/i.test(entry.name)) add(path.join(parent, entry.name, suffix));
    }
  };
  if (platform === 'win32') {
    for (const parent of [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
      env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]) {
      scan(parent, ['DeepSeek Harness'], 'resources');
    }
  } else if (platform === 'darwin') {
    for (const parent of ['/Applications', path.join(home, 'Applications')]) {
      scan(parent, ['DeepSeek Harness.app', 'DeepSeek Harness'], path.join('Contents', 'Resources'));
    }
  } else {
    for (const parent of ['/opt', '/usr/local/lib', '/usr/lib']) {
      scan(parent, ['DeepSeek Harness', 'deepseek-harness'], 'resources');
    }
  }
  return dirs;
}

/** Run one `dsh --version` probe; an unrunnable or silent launcher yields no version. */
function dshVersion(command, { platform, env, execute = runDesktop }) {
  // npm and Desktop both publish dsh.cmd on Windows; `/s` keeps the launcher's own
  // quotes intact so an installation path containing spaces still runs. No user input.
  const quoted = `""${command}" --version"`;
  const result = platform === 'win32'
    ? execute(env.ComSpec || process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', quoted], { windowsVerbatimArguments: true })
    : execute(command, ['--version']);
  if (result.error || result.status !== 0) return undefined;
  // A wrapper can echo commands before invoking dsh. Match a whole version line
  // so version-like directory names in those commands cannot select a preset.
  return result.stdout?.split(/\r?\n/).map(line => line.trim())
    .findLast(line => /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(line));
}

/** Where a bare command resolves to, so a Desktop shim on PATH is recognized as one. */
function resolveOnPath(command, { platform, env = process.env, execute = run } = {}) {
  const result = platform === 'win32'
    ? execute(env.ComSpec || process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"where ${command}"`], { windowsVerbatimArguments: true })
    : execute('sh', ['-c', `command -v ${command}`]);
  if (result.error || result.status !== 0) return undefined;
  return result.stdout?.split(/\r?\n/).map(line => line.trim()).find(Boolean);
}

/**
 * Find a runnable dsh: the explicit launcher, the one on PATH, or a Desktop installation.
 * @returns the launcher, its version, whether it belongs to Desktop, and everything checked.
 */
export function findDsh({ platform = process.platform, env = process.env, home = os.homedir(), execute, explicit } = {}) {
  const shim = platform === 'win32' ? 'dsh.cmd' : 'dsh';
  const candidates = [];
  const consider = (command, desktop) => {
    if (command && !candidates.some(candidate => candidate.command === command)) candidates.push({ command, desktop });
  };
  if (explicit) consider(/[/\\]/.test(explicit) ? absolute(explicit) : explicit, isDesktopLauncher(explicit));
  consider('dsh', false);
  for (const resources of desktopResourceDirs({ platform, env, home })) {
    consider(path.join(resources, 'runtime', 'cli', 'bin', shim), true);
  }
  let outdated;
  for (const candidate of candidates) {
    const version = dshVersion(candidate.command, { platform, env, execute });
    if (!version) continue;
    const resolved = candidate.command === 'dsh'
      ? resolveOnPath('dsh', { platform, env, execute }) || candidate.command : candidate.command;
    const found = { command: resolved, version, desktop: candidate.desktop || isDesktopLauncher(resolved) };
    // A launcher too old for this preset is not a usable answer: a Desktop
    // installation further down the list can still serve, and when none can, the
    // first one that answered carries the version the caller must report.
    if (supportsDsh(version)) return found;
    outdated ??= found;
  }
  if (outdated) return outdated;
  return { command: undefined, version: undefined, desktop: false,
    checked: candidates.map(candidate => candidate.command),
    // A launcher that is installed but never answers is a different problem from a
    // missing one, so the caller can tell "install dsh" from "it would not start".
    silent: candidates.filter(candidate => fs.existsSync(candidate.command))
      .map(candidate => candidate.command) };
}

export function supportsDsh(value) {
  const version = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/);
  if (!version) return false;
  const minimum = [0, 1, 5];
  for (let i = 0; i < minimum.length; i++) {
    const number = Number(version[i + 1]);
    if (number !== minimum[i]) return number > minimum[i];
  }
  if (!version[4]) return true;
  const identifiers = version[4].split('.');
  const baseline = ['rc', '2'];
  for (let i = 0; i < Math.max(identifiers.length, baseline.length); i++) {
    const current = identifiers[i], required = baseline[i];
    if (current === required) continue;
    if (current === undefined) return false;
    if (required === undefined) return true;
    const numeric = /^\d+$/.test(current), otherNumeric = /^\d+$/.test(required);
    if (numeric && otherNumeric) return Number(current) > Number(required);
    if (numeric !== otherNumeric) return !numeric;
    return current > required;
  }
  return true;
}

function checkDependencies({ explicit } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major >= 24 || (major === 22 && minor >= 19))) {
    throw new Error('需要 Node.js ^22.19.0 或 >=24，请先升级 Node.js。');
  }
  const dsh = findDsh({ explicit });
  if (!dsh.version) {
    const present = dsh.silent.length
      ? `\n以下 dsh 已经安装但没能运行（桌面端首次启动较慢，也可能被安全软件拦下）：\n${dsh.silent.map(file => `  ${file}`).join('\n')}\n` : '';
    throw new Error('找不到可运行的 dsh。二选一后重试：\n' +
      '1. 桌面端：确认 DeepSeek Harness 能正常启动（安装器会自动使用它自带的 dsh）；' +
      '装在非默认目录时用 --dsh "<安装目录>/resources/runtime/cli/bin/dsh.cmd" 指定。\n' +
      '2. 官方 CLI：npm install -g @deepseek-ai/dsh@latest\n' + present +
      `已检查：${[...new Set(['PATH 中的 dsh', ...dsh.checked])].join('、')}`);
  }
  if (!supportsDsh(dsh.version)) {
    throw new Error(`dsh ${dsh.version} 不支持此学习预设，需要 >=0.1.5-rc.2。` + (dsh.desktop
      ? '请升级 DeepSeek Harness 桌面端。'
      : '请运行 npm install -g @deepseek-ai/dsh@latest。'));
  }
  return { version: dsh.version, desktop: dsh.desktop };
}

function absolute(value) {
  if (value === '~') return os.homedir();
  if (/^~[/\\]/.test(value)) return path.resolve(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function realDestination(directory) {
  if (fs.existsSync(directory)) return fs.realpathSync(directory);
  const parent = path.dirname(directory);
  if (parent === directory) throw new Error(`目录所在的磁盘或共享位置不可用：${directory}`);
  return path.join(realDestination(parent), path.basename(directory));
}

/**
 * 读安装配置。与阅读端同一个读取器（`lib/workspace.ts` 的 `readConfigObject`）：
 * 它认两种真实形态——安装器写的「注释 + JSON」，以及手改过的块映射。
 *
 * 配置存在却读不出来时报错而不是当空配置：安装器接下来要**改**这个文件，
 * 猜着改会把学生的其它配置键弄丢。
 */
export function readConfig(file) {
  const config = readConfigObject(file);
  if (config) {
    const workspace = config.workspace;
    if (workspace !== undefined && workspace !== null && typeof workspace !== 'string') {
      throw new Error('配置里的 workspace 必须是路径字符串，请修正后重试。');
    }
    return config;
  }
  if (fs.existsSync(file)) throw new Error(`无法读取 ${file}，请修正配置后重试。`);
  return {};
}

// 造出 standalone 安装留在 <dshHome>/studymate/engine 的那份引擎载荷。
// 原生插件加载**不**走这里：插件自己就是引擎（见 payloadDirectory）。
function copyPayload(destination) {
  // 技能源与预设源都在 `preset/` 下（技能是 `preset/skills`）。**别挪回 `.dsh/skills`**：
  // 宿主默认会扫「项目根/.dsh/skills」，技能摆在那里等于任何工作目录落在本仓库/本包里的
  // 会话都看得见（#87）。拷贝保持同一个相对位置，装出来的副本因此也不在默认扫描面上。
  for (const relative of ['preset/skills', 'preset/learning', 'preset/qa', 'templates', 'schemas']) {
    fs.cpSync(path.join(source, relative), path.join(destination, relative), {
      recursive: true,
      filter: (file) => !['__pycache__', '.DS_Store'].includes(path.basename(file)),
    });
  }
  // docs/ 按用途分子目录，必须按原相对路径铺开——技能里的 <root>/docs/<子目录>/<名>.md 指针依赖它
  for (const relative of listDocMarkdown(source)) {
    const target = path.join(destination, 'docs', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, 'docs', relative), target);
  }
  for (const file of ['package.json', 'LICENSE']) {
    fs.copyFileSync(path.join(source, file), path.join(destination, file));
  }
}

/**
 * Which directory acts as the engine (`config.root`) for an install.
 *
 * 原生插件加载（native）下，已安装的包自身就是引擎：它就在
 * `~/.dsh/profiles/<profile>/node_modules/@yunmiao/studymate`，package.json 的 `files`
 * 已经带了 `templates/`、`schemas/`、`docs/`、`preset/skills`，所以再拷一份源码树到
 * `~/.dsh/studymate/engine/` 只是**同一份包的第二份副本**——两份会各自过期。
 *
 * standalone 的那份载荷是**只读材料**：技能、预设、schema、文档与工作区数据骨架
 * （`templates/` 下的 MEMORY/MISSION/GLOSSARY/RESOURCES/subject.yaml）。**没有可执行文件**：
 * 引擎已经是插件包本身，老宿主那条路只需要这些文件（Python 引擎已随 #83 退役）。
 *
 * `--mode native` 的**交接安装**（native 且 mode==='native'）走 standalone 的 <root>：
 * 那条路只改注册与归属，不落任何载荷，换成包目录反而会让 DSH 重启前的旧技能副本指错地方。
 */
function payloadDirectory({ native, mode, engine }) {
  return native && mode !== 'native' ? source : engine;
}

/**
 * Which profile an install without --profile serves: the Desktop harness we
 * resolved, then the profile the last install used, then the CLI default.
 */
export function defaultProfile({ desktop, installModes }) {
  if (desktop) return 'desktop';
  const recorded = Object.keys(installModes);
  return recorded.length === 1 ? recorded[0] : 'web';
}

// Shared by the CLI and the DSH bundle. Native loading already runs inside DSH;
// it must not launch a second, possibly different dsh executable from PATH.
export function installPayload({ workspaceArg, profile, version, desktop = false,
  dshHome = absolute(process.env.DSH_HOME || path.join(os.homedir(), '.dsh')), native = false, mode = 'standalone' }) {
  if (!['standalone', 'native'].includes(mode) || native && mode !== 'standalone') {
    throw new Error('--mode 必须是 standalone 或 native；原生启动不执行安装方式切换。');
  }
  dshHome = absolute(dshHome);
  const configFile = path.join(dshHome, 'studymate-config.yaml');
  const config = readConfig(configFile);
  const installModes = config.installModes ?? {};
  if (typeof installModes !== 'object' || Array.isArray(installModes)) {
    throw new Error('配置中的 installModes 必须是按 profile 记录安装方式的对象。');
  }
  profile ??= defaultProfile({ desktop, installModes });
  // The Desktop launcher lowercases its reserved profile, so match it on disk.
  if (profile.toLowerCase() === 'desktop') profile = 'desktop';
  if (!profile || /[/\\\0]/.test(profile) || ['.', '..', 'node_modules'].includes(profile)) {
    throw new Error('--profile 必须是单个 DSH 配置名称，不能使用路径或保留名称。');
  }
  // Desktop refuses to manage a profile it has not initialized yet.
  if (profile === 'desktop' && !fs.existsSync(path.join(dshHome, 'profiles', 'desktop', 'package.json'))) {
    throw new Error('桌面端配置尚未初始化：请先启动一次 DeepSeek Harness 桌面端，再重新运行安装命令。');
  }
  const workspace = absolute(workspaceArg || process.env.LEARN_WORKSPACE || config.workspace || path.join(os.homedir(), 'StudyMate'));
  const engine = path.join(dshHome, 'studymate', 'engine');
  // 原生加载下这块盘一个字都不写；变量保留是给下面的符号链接与包含关系检查用。
  const payload = payloadDirectory({ native, mode, engine });
  const preset = path.join(dshHome, '.agent-presets', 'learning');
  const installedMode = installModes[profile];
  if (native && (installedMode === 'standalone' ||
      installedMode !== 'native' && fs.existsSync(preset))) {
    throw new Error('学习模式仍由安装器管理；如需切换，请运行 ' +
      `npx -y @yunmiao/studymate@latest install --mode native --profile ${profile} 后重启 DSH。`);
  }
  const managedDirectories = native ? [engine] : [engine, preset];
  for (const parent of managedDirectories.map(directory => path.dirname(directory))) {
    if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`安装目录是符号链接，为避免改动其指向的项目，请先将它改为独立目录：${parent}`);
    }
  }
  for (const managed of managedDirectories) {
    if (fs.lstatSync(managed, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`安装目标是符号链接，请先将它移至其他位置：${managed}`);
    }
    if (contained(realDestination(managed), fs.realpathSync(source))) {
      throw new Error(`安装器源码位于将被替换的目录内，请将源码移到其他位置或从 npx 运行：${managed}`);
    }
    if (contained(realDestination(managed), realDestination(workspace))) {
      throw new Error(`学习工作区不能放在安装器管理的目录内：${managed}`);
    }
  }
  // Build everything before changing the active preset or configuration.
  // 原生加载不写 <dshHome>/studymate/：连空目录也不建——一个空壳 engine/ 只会让"引擎在哪"变成猜谜。
  // 只保证 dshHome 本身在（下面 mkdtemp 要往它里面开暂存目录）。
  fs.mkdirSync(dshHome, { recursive: true });
  if (!native) fs.mkdirSync(path.dirname(engine), { recursive: true });
  if (!native) fs.mkdirSync(path.dirname(preset), { recursive: true });
  const staging = fs.mkdtempSync(path.join(dshHome, '.studymate-install-'));
  const replacements = [];
  let preserveStaging = false;
  let registration;
  try {
    const stagedEngine = path.join(staging, 'engine');
    // 只有要落盘的安装才造引擎载荷；原生加载直接用已安装的包，省掉一次整包拷贝
    // （那段拷贝除了写进 staging 再被 finally 删掉，什么也没做）。
    if (!native) copyPayload(stagedEngine);
    // 技能改写只改写 staging 里的副本——**原生加载也不写包目录**：安装好的包是随包发的只读
    // 材料，`link:` 安装下它更是学生自己的检出，一次启动就往里写会污染工作树。
    // 原生加载的技能因此是包里那一份（`customSkillDirs` 指向它，见 payloadDirectory 的说明）。
    const stagedSkills = path.join(stagedEngine, 'preset', 'skills');
    if (!native) {
      for (const entry of fs.readdirSync(stagedSkills, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(stagedSkills, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        const skill = fs.readFileSync(skillFile, 'utf8');
        fs.writeFileSync(skillFile, adaptSkill(skill, {
          platform: process.platform, configFile, tempDirectory: os.tmpdir(),
        }));
      }
    }
    // 两条预设各把自己的技能目录占位符换成**引擎侧的绝对路径**（同一份 `preset/skills`；
    // 答疑那条在它后面接 `/local-qa`，见 `preset/qa/agent.cordis.yml`）。少占位符就抛——
    // 那说明这份安装包不完整，猜不出路径时不能往下走。**学习那一条的检查放在最前**：它要
    // 先于答疑那条的拷贝发生（老包/坏包可能没有 `preset/qa/`，先报「缺占位符」更准确）。
    const skillsPath = path.join(payload, 'preset', 'skills').split(path.sep).join('/').replaceAll("'", "''");
    const stagePreset = (relative, destination, label) => {
      // A filter avoids Node 22.19's native Windows copy crash on Unicode paths.
      // https://github.com/nodejs/node/issues/59636
      fs.cpSync(path.join(native ? source : stagedEngine, 'preset', relative), destination,
        { recursive: true, filter: () => true });
      const file = path.join(destination, 'agent.cordis.yml');
      const text = fs.readFileSync(file, 'utf8');
      if (!text.includes('__STUDYMATE_SKILLS__')) {
        throw new Error(`预设缺少 __STUDYMATE_SKILLS__，安装包不完整（${label}）。`);
      }
      fs.writeFileSync(file, text.replaceAll('__STUDYMATE_SKILLS__', skillsPath));
    };
    const stagedPreset = path.join(staging, 'learning');
    stagePreset('learning', stagedPreset, '学习模式');
    const stagedQaPreset = path.join(staging, 'qa');
    stagePreset('qa', stagedQaPreset, '答疑模式');

    // 注册预设：`lib/preset.ts`（迁移前的 Python 安装助手的 TS 替代，形状逐字段一致）。
    // 两条预设**一次**产出：托管块的 BEGIN/END 只有一套，分两次调用后一次会把前一次剥掉。
    // 它自己保证「失败时一个字节都不落盘」——所以这里不需要再回滚它那部分。
    const stagedPatch = path.join(staging, 'cordis.patch.yml');
    registration = installPreset({
      presetDir: stagedPreset, extraPresets: [{ id: 'qa', dir: stagedQaPreset }],
      dshHome, profile, patchOutput: stagedPatch,
      ...(native ? { bundle: true } : { dshVersion: version, mode }),
    });

    fs.mkdirSync(path.join(workspace, '.learning', 'subjects'), { recursive: true });
    const realWorkspace = fs.realpathSync(workspace);
    for (const managed of managedDirectories) {
      // 父目录可能还不存在（原生加载一个字节都不写），realDestination 会逐级往上解析到已存在的祖先
      const realManaged = realDestination(managed);
      if (contained(realManaged, realWorkspace)) throw new Error(`学习工作区不能指向安装器管理的目录：${managed}`);
    }
    config.workspace = realWorkspace;
    // <root> 指向**这次的 payload**：standalone 是 ~/.dsh/studymate/engine 的副本，
    // 原生插件加载是已安装的包自身（见 payloadDirectory）。
    config.root = payload;
    config.installModes = { ...installModes, [profile]: native || mode === 'native' ? 'native' : 'standalone' };
    const stagedConfig = path.join(staging, 'config.yaml');
    // JSON objects are also valid YAML; retain unrelated user configuration keys.
    fs.writeFileSync(stagedConfig, `# StudyMate 学习工作区与引擎项目定位\n${JSON.stringify(config, null, 2)}\n`);

    const targets = [[stagedConfig, configFile]];
    // 只有 standalone 安装落载荷：引擎目录 + 独立预设。
    // · 原生插件加载（native）：引擎就是已安装的包，预设由插件在启动时注册；
    // · 显式交接安装（mode==='native'）：只改注册与归属，载荷留给选定的原生包在下次启动时自己初始化，
    //   免得被一次 npx 降级覆盖。
    if (mode !== 'native' && !native) {
      targets.unshift([stagedEngine, engine]);
      targets.push([stagedPreset, preset]);
    }
    if (registration.patchChanged) {
      const profilePatch = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml');
      if (fs.lstatSync(profilePatch, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error(`预设配置是符号链接，请先将它改为独立文件：${profilePatch}`);
      }
      fs.mkdirSync(path.dirname(profilePatch), { recursive: true });
      targets.push([stagedPatch, profilePatch]);
    }
    for (const [staged, target] of targets) {
      const backup = path.join(staging, `backup-${replacements.length}`);
      const existed = fs.existsSync(target);
      if (existed) fs.renameSync(target, backup);
      const change = { target, backup, existed, installed: false };
      replacements.push(change);
      fs.renameSync(staged, target);
      change.installed = true;
    }
  } catch (error) {
    try {
      for (const change of replacements.reverse()) {
        if (change.installed) fs.rmSync(change.target, { recursive: true, force: true });
        if (change.existed) fs.renameSync(change.backup, change.target);
      }
    } catch (rollbackError) {
      preserveStaging = true;
      throw new Error(`${error.message}\n自动恢复失败：${rollbackError.message}；原文件保留在 ${staging}`);
    }
    throw error;
  } finally {
    if (!preserveStaging) fs.rmSync(staging, { recursive: true, force: true });
  }
  // `engine` 报的是**这次的引擎实际落在哪**（原生加载 = 包自身），调用方照这个值提示用户
  return { registration, engine: payload, preset, configFile, workspace: config.workspace, profile };
}

function install(workspaceArg, profile, mode, dshArg) {
  const { version, desktop } = checkDependencies({ explicit: dshArg });
  const { registration, engine, preset, configFile, workspace, profile: target } =
    installPayload({ workspaceArg, profile, version, desktop, mode });
  const registered = registration.mode === 'bundle' ? `\n学习模式由 DSH 插件管理：${target}`
    : registration.mode === 'declarative' ? `\n已注册到 DSH profile：${target}` : '';
  const next = desktop
    ? '请在 DeepSeek Harness 桌面端新建会话并选择“学习模式”；桌面端正在运行时请完全退出后重新打开，改动在重启后生效。'
    : '请在 dsh 中新建会话并选择“学习模式”；已运行的 dsh 如未显示该模式，请重启。';
  console.log(`StudyMate ${metadata.version} 安装完成。\n引擎：${engine}\n学习预设：${preset}${registered}\n学习工作区：${workspace}\n配置：${configFile}\n${next}\n启动会话时把工作目录设为 ${workspace}，并把会话权限选成 workspace-write 或 danger-full-access：学习数据都写在那个目录里，会话目录不在它里面时，每次落盘都会要求你授权。`);
}

/**
 * `studymate export` 的参数。刻意只有这几个：无头侧要的是「**没有参数也能跑**」（课完跑一次
 * 就导一份），参数一多，技能里就会开始写死路径——那正是目标态要清掉的东西。
 * 具体怎么导在 `lib/export/cli.ts`（这里只解析）。
 */
export function parseExportArgs(args) {
  const usage = '用法：studymate export [--workspace <目录>] [--out <目录>] [--subject <slug>] [--json] [--quiet]';
  const options = { subjects: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') { options.json = true; continue; }
    if (flag === '--quiet') { options.quiet = true; continue; }
    const value = args[i + 1];
    if (!['--workspace', '--out', '--subject'].includes(flag) || !value || value.startsWith('--')) {
      throw new Error(`不支持的参数：${args.join(' ')}\n${usage}`);
    }
    i += 1;
    if (flag === '--workspace') options.workspace = value;
    else if (flag === '--out') options.out = value;
    else options.subjects.push(value);
  }
  return options;
}

export async function main(args = process.argv.slice(2)) {
  try {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) console.log(help);
    else if (args.length === 1 && ['--version', '-v'].includes(args[0])) console.log(metadata.version);
    else if (args[0] === 'export') {
      const options = parseExportArgs(args.slice(1));
      // 动态 import：其余子命令（安装 / 构建）不该被导出域那套东西拖进来，
      // 也保证「没装 React 的机器上跑 install」不会因为解析 React 而失败。
      const { exportCommand } = await import('../lib/export/cli.ts');
      process.exitCode = await exportCommand(options);
    }
    else if (args[0] === 'build-plugin') {
      if (args.length !== 1 && !(args.length === 3 && args[1] === '--output' && args[2] && !args[2].startsWith('--'))) {
        throw new Error(`用法：studymate build-plugin [--output <目录>]`);
      }
      const result = buildOpenAiPlugin({ output: args[2] });
      console.log(`StudyMate ${result.version} OpenAI 插件已构建。\n插件目录：${result.plugin}\n插件 ZIP：${result.archive}\n安装方法见插件目录中的 README.md。`);
    }
    else if (args[0] === 'build-antigravity') {
      let output;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--output' && args[i + 1] && !args[i + 1].startsWith('--')) {
          output = args[++i];
        } else if (args[i] === '--install') {
          output = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'studymate');
        } else {
          throw new Error('用法：studymate build-antigravity [--output <目录>] [--install]');
        }
      }
      const result = buildAntigravityPlugin({ output });
      console.log(`StudyMate ${result.version} Antigravity 插件已构建。\n插件目录：${result.plugin}\n插件 ZIP：${result.archive}`);
    }
    else {
      if (args[0] === 'install') args.shift();
      let workspace, profile, mode = 'standalone', dsh;
      const seen = new Set();
      const options = ['--workspace', '--profile', '--mode', '--dsh'];
      for (let i = 0; i < args.length; i += 2) {
        const option = args[i], value = args[i + 1];
        if (!options.includes(option) || !value || value.startsWith('--') || seen.has(option)) {
          throw new Error(`不支持的参数：${args.join(' ')}\n${help}`);
        }
        seen.add(option);
        if (option === '--workspace') workspace = value;
        else if (option === '--profile') profile = value;
        else if (option === '--dsh') dsh = value;
        else mode = value;
      }
      install(workspace, profile, mode, dsh);
    }
  } catch (error) {
    console.error(`StudyMate：${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) &&
    fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
