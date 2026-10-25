/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 诊断与健康检查

   这一层的目标不是“修复安装”，而是把安装链上的事实变成**可读、可复现、可转交**的
   一份报告：Node / DSH / profile / 配置 / 工作区 / 预设声明 / 模型 / lab 运行时。

   两个入口共用同一份判据：
     · `studymate doctor`（CLI，见 bin/studymate.mjs）——人读 + `--json`；
     · `GET /api/studymate/health`（DSH 插件运行期）——阅读端横幅与支持排障。
   报告里不输出 token / API key / 完整 prompt；`warn` 不阻塞，`fail` 才让 `ok=false`。

   注意：这里只能确认“文件上有什么”和“启动时插件记录了什么”。预设是否真的被宿主
   接受，只有运行中的宿主知道；无法确定时写 `unknown`，不猜。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { probeModel } from './core/model.ts';
import type { ModelCapability, ServiceReader } from './core/model.ts';
import { readConfigObject } from './workspace.ts';
import { routeError } from './route-envelope.ts';
import { atLeast } from './preset.ts';

export const HEALTH_PATH = '/api/studymate/health';
export const HEALTH_LABEL = 'studymate: 健康检查路由';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'unknown';
export type PresetState = 'declared' | 'bundle' | 'missing' | 'unknown';
export type ConfigParseState = 'ok' | 'missing' | 'invalid';

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
  detail?: string;
}

export interface WorkspaceFacts {
  path: string;
  configured: boolean;
  exists: boolean;
  ready: boolean;
  writable: boolean;
  subjectsDir: boolean;
}

export interface ConfigFacts {
  file: string;
  present: boolean;
  parse: ConfigParseState;
  message: string;
}

export interface PresetFacts {
  profile: string;
  profileDir: string;
  patch: string;
  package: boolean;
  learning: PresetState;
  qa: PresetState;
}

export interface LabFacts {
  node: boolean;
  sh: boolean;
}

export interface RuntimeFacts {
  startup: 'ok' | 'failed';
  stage: string;
  error: string;
  updated_at: string;
}

export interface DoctorReport {
  ok: boolean;
  version: string;
  generated_at: string;
  environment: {
    node: string;
    dsh: string;
  };
  workspace: WorkspaceFacts;
  config: ConfigFacts;
  presets: PresetFacts;
  model: ModelCapability | null;
  lab: LabFacts;
  runtime: RuntimeFacts;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  dshHome?: string;
  workspace?: string;
  profile?: string;
  checkDsh?: boolean;
  ctx?: ServiceReader | null;
  now?: () => Date;
}

export interface DoctorCliOptions {
  json?: boolean;
  workspace?: string;
  profile?: string;
}

let runtimeFacts: RuntimeFacts = {
  startup: 'ok',
  stage: '',
  error: '',
  updated_at: '',
};

/** 插件启动失败时由 bin/dsh-plugin.ts 调用；不抛、不覆盖原始错误。 */
export function recordStartupFailure(stage: string, error: unknown): void {
  runtimeFacts = {
    startup: 'failed',
    stage,
    error: error instanceof Error ? error.message : String(error),
    updated_at: new Date().toISOString(),
  };
}

/** 测试用：每个用例从“启动正常”开始。 */
export function resetRuntimeHealthForTests(): void {
  runtimeFacts = { startup: 'ok', stage: '', error: '', updated_at: '' };
}

function packageVersion(): string {
  try {
    const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const value = JSON.parse(raw) as { version?: unknown };
    return typeof value.version === 'string' && value.version.trim() ? value.version.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (/^~[/\\]/.test(value)) return path.resolve(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function defaultDshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function isWritable(directory: string): boolean {
  try {
    fs.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function configFacts(file: string): {
  present: boolean;
  value: Record<string, unknown> | null;
  parse: ConfigParseState;
  message: string;
} {
  if (!isFile(file)) {
    return { present: false, value: null, parse: 'missing', message: '没有找到配置文件' };
  }
  const value = readConfigObject(file);
  if (value) return { present: true, value, parse: 'ok', message: '配置可读' };
  return {
    present: true,
    value: null,
    parse: 'invalid',
    message: '配置存在，但 YAML / JSON 都读不出来；检查语法，或重新跑安装器',
  };
}

function pickProfile(value: Record<string, unknown> | null, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const modes = value?.installModes;
  if (modes && typeof modes === 'object' && !Array.isArray(modes)) {
    const keys = Object.keys(modes);
    if (keys.length === 1) return keys[0];
  }
  return 'web';
}

function presetFacts(dshHome: string, profile: string): PresetFacts {
  const profileDir = path.join(dshHome, 'profiles', profile);
  const patch = path.join(profileDir, 'cordis.patch.yml');
  const patchText = readText(patch);
  const packageFile = path.join(profileDir, 'node_modules', '@yunmiao', 'studymate', 'package.json');
  const packagePresent = isFile(packageFile);
  const declaredLearning = patchText.includes('# BEGIN STUDYMATE LEARNING PRESET')
    || patchText.includes('studymate-learning-preset');
  const declaredQa = patchText.includes('studymate-qa-preset');
  const learning: PresetState = declaredLearning ? 'declared' : packagePresent ? 'bundle' : 'missing';
  const qa: PresetState = declaredQa ? 'declared' : packagePresent ? 'bundle' : 'missing';
  return { profile, profileDir, patch, package: packagePresent, learning, qa };
}

function workspaceFacts(workspace: string): WorkspaceFacts {
  const configured = workspace !== '';
  const exists = configured && isDirectory(workspace);
  const learning = exists && isDirectory(path.join(workspace, '.learning'));
  const subjectsDir = exists && isDirectory(path.join(workspace, '.learning', 'subjects'));
  return {
    path: workspace,
    configured,
    exists,
    ready: exists && learning,
    writable: exists && isWritable(workspace),
    subjectsDir,
  };
}

let labCache: { at: number; value: LabFacts } | null = null;

function labFacts(): LabFacts {
  const now = Date.now();
  if (labCache && now - labCache.at < 60_000) return labCache.value;
  const node = spawnSync(process.execPath, ['--version'], {
    encoding: 'utf8', timeout: 2_000, windowsHide: true,
  }).status === 0;
  // Windows 通常没有 sh；这不是错误，报告里给一条 warn 即可。
  const sh = spawnSync('sh', ['-c', 'exit 0'], {
    encoding: 'utf8', timeout: 1_000, windowsHide: true,
  }).status === 0;
  const value = { node, sh };
  labCache = { at: now, value };
  return value;
}

function dshVersion(): { version: string; error: string } {
  // Windows 上 dsh 通常是 .cmd：spawn 不能直接执行批处理，而 `shell: true` 会触发
  // Node 对“参数未转义”的弃用警告。这里只执行一条固定命令，用 ComSpec 显式调用。
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'dsh --version'], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true,
    })
    : spawnSync('dsh', ['--version'], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true,
    });
  if (result.error) return { version: '', error: result.error.message };
  if (result.status !== 0) {
    // Windows 的 cmd.exe 错误文本是系统代码页，UTF-8 解码后会变乱码；只报“不可运行”，
    // 具体路径与版本交给用户在自己的终端里复核。
    return {
      version: '',
      error: process.platform === 'win32'
        ? `dsh 不在 PATH 或不可执行（退出码 ${String(result.status)}）`
        : (result.stderr?.trim() || `dsh 退出码 ${String(result.status)}`),
    };
  }
  const version = (result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || '';
  if (!version) return { version: '', error: 'dsh 没有返回版本号' };
  return { version, error: '' };
}

function nodeVersionOk(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return Number.isFinite(major) && Number.isFinite(minor)
    && (major >= 24 || (major === 22 && minor >= 19));
}

function check(
  checks: DoctorCheck[], id: string, status: DoctorStatus, message: string, detail?: string,
): void {
  checks.push({ id, status, message, ...(detail === undefined ? {} : { detail }) });
}

/**
 * 生成诊断报告。所有外部命令都带超时；文件缺失、配置损坏、DSH 不在 PATH 都只是报告项，
 * 不抛异常。`checkDsh:false` 供运行中的 `/health` 使用——不能在每次页面轮询时起 dsh 进程。
 */
export function collectDoctorReport(options: DoctorOptions = {}): DoctorReport {
  const now = options.now ?? (() => new Date());
  const generated_at = now().toISOString();
  const version = packageVersion();
  const dshHome = expandHome(options.dshHome || defaultDshHome());
  const configFile = path.join(dshHome, 'studymate-config.yaml');
  const config = configFacts(configFile);
  const configuredWorkspace = typeof config.value?.workspace === 'string' ? config.value.workspace : '';
  const workspace = workspaceFacts(options.workspace
    ? expandHome(options.workspace)
    : configuredWorkspace ? expandHome(configuredWorkspace) : '');
  const profile = pickProfile(config.value, options.profile);
  const presets = presetFacts(dshHome, profile);
  const lab = labFacts();
  const checks: DoctorCheck[] = [];

  if (nodeVersionOk(process.versions.node)) {
    check(checks, 'node', 'ok', `Node ${process.versions.node}`);
  } else {
    check(checks, 'node', 'fail', `Node ${process.versions.node} 低于要求（需要 ^22.19.0 或 >=24）`);
  }

  let dsh = '';
  if (options.checkDsh !== false) {
    const probed = dshVersion();
    dsh = probed.version;
    if (probed.error) {
      check(checks, 'dsh', 'warn', `找不到可运行的 dsh：${probed.error}`);
    } else if (/^v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(dsh)) {
      try {
        if (!atLeast(dsh, '0.1.7-alpha.1')) {
          check(checks, 'dsh', 'warn', `dsh ${dsh} 低于原生插件建议版本 0.1.7-alpha.1`);
        } else {
          check(checks, 'dsh', 'ok', `dsh ${dsh}`);
        }
      } catch {
        check(checks, 'dsh', 'warn', `dsh 版本无法比较：${dsh}`);
      }
    } else {
      check(checks, 'dsh', 'warn', `dsh 返回了无法识别的版本：${dsh}`);
    }
  }

  if (config.parse === 'ok') {
    check(checks, 'config', 'ok', config.message, configFile);
  } else {
    check(checks, 'config', 'fail', config.message, configFile);
  }

  if (!workspace.configured) {
    check(checks, 'workspace', 'fail', '配置里没有 workspace，先跑一次安装器', workspace.path || undefined);
  } else if (!workspace.exists) {
    check(checks, 'workspace', 'fail', `学习工作区不存在：${workspace.path}`, workspace.path);
  } else if (!workspace.writable) {
    check(checks, 'workspace', 'fail', `学习工作区不可写：${workspace.path}`, workspace.path);
  } else if (!workspace.ready) {
    check(checks, 'workspace', 'warn', `工作区存在，但还没有 .learning/：${workspace.path}`, workspace.path);
  } else if (!workspace.subjectsDir) {
    check(checks, 'workspace', 'warn', `工作区还没有 .learning/subjects/：先建一门科目`, workspace.path);
  } else {
    check(checks, 'workspace', 'ok', `工作区可读可写：${workspace.path}`, workspace.path);
  }

  if (!isDirectory(presets.profileDir)) {
    check(checks, 'preset', 'fail', `profile 目录不存在：${presets.profileDir}`, presets.profileDir);
  } else if (presets.learning === 'missing') {
    check(checks, 'preset', 'fail', `没有找到学习模式预设或插件包：${presets.profile}`, presets.profileDir);
  } else if (presets.qa === 'missing') {
    check(checks, 'preset', 'warn',
      `学习模式已找到，但答疑模式未声明（旧版安装可能本来就没有）：${presets.profile}`, presets.profileDir);
  } else {
    check(checks, 'preset', 'ok', `预设声明：learning=${presets.learning}，qa=${presets.qa}`, presets.profileDir);
  }

  if (runtimeFacts.startup === 'failed') {
    check(checks, 'runtime', 'fail', `上次插件启动失败（${runtimeFacts.stage}）：${runtimeFacts.error}`,
      runtimeFacts.updated_at);
  } else {
    check(checks, 'runtime', 'ok', '插件启动记录正常');
  }

  if (!lab.node) {
    check(checks, 'lab', 'fail', '找不到可运行的 node（lab 与导出都需要它）');
  } else if (!lab.sh) {
    check(checks, 'lab', 'warn', '没有找到 sh；旧版 check.sh lab 在 Windows 上可能跑不了，新 lab 会使用 node runner');
  } else {
    check(checks, 'lab', 'ok', 'node 与 sh 都可用');
  }

  let model: ModelCapability | null = null;
  if (options.ctx) {
    model = probeModel(options.ctx);
    if (model.available) {
      check(checks, 'model', 'ok', `模型服务可用${model.providers?.length ? `（${model.providers.join('、')}）` : ''}`);
    } else {
      check(checks, 'model', 'warn', `模型能力不可用：${model.reason ?? '未知原因'}`);
    }
  }

  return {
    ok: !checks.some((item) => item.status === 'fail'),
    version,
    generated_at,
    environment: { node: process.versions.node, dsh },
    workspace,
    config: { file: configFile, present: config.present, parse: config.parse, message: config.message },
    presets,
    model,
    lab,
    runtime: { ...runtimeFacts },
    checks,
  };
}

export function parseDoctorArgs(args: readonly string[]): DoctorCliOptions {
  const options: DoctorCliOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--json') {
      options.json = true;
      continue;
    }
    if (!['--workspace', '--profile'].includes(flag)) {
      throw new Error(`不支持的参数：${args.join(' ')}\n用法：studymate doctor [--json] [--workspace <目录>] [--profile <名称>]`);
    }
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} 需要一个值`);
    }
    i += 1;
    if (flag === '--workspace') options.workspace = value;
    else options.profile = value;
  }
  return options;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `StudyMate doctor ${report.version}`,
    `工作区：${report.workspace.path || '（未配置）'}`,
    `配置：${report.config.file}`,
    `profile：${report.presets.profile}`,
    '',
    ...report.checks.map((item) => `[${item.status.toUpperCase()}] ${item.message}`),
    '',
    report.ok ? '结论：没有阻断项。' : '结论：存在阻断项，按上面 FAIL 项处理后重试。',
  ];
  return lines.join('\n');
}

/** CLI 入口：返回进程退出码，不直接 process.exit，便于测试。 */
export function doctorCommand(args: readonly string[] = []): number {
  let options: DoctorCliOptions;
  try {
    options = parseDoctorArgs(args);
  } catch (error) {
    console.error(`StudyMate：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const report = collectDoctorReport({
    workspace: options.workspace,
    profile: options.profile,
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatDoctorReport(report));
  return report.ok ? 0 : 1;
}

/* ── 运行期健康路由 ───────────────────────────────────────────────────── */

interface HealthConnectionContext {
  connection?: {
    fetch?: {
      register?: (route: {
        path: string;
        methods: string[];
        requestBody: 'buffered';
        fetch: () => Promise<Response> | Response;
      }) => unknown;
    };
  };
  effect?: (fn: () => unknown, description?: string) => unknown;
}

export interface HealthPluginContext extends ServiceReader {
  get?: (name: string) => unknown;
  inject?: (names: string[], handler: (ctx: HealthConnectionContext) => void) => unknown;
}

function profileFrom(ctx: HealthPluginContext): { name: string; home: string } {
  try {
    const value = ctx.get?.('profileContext');
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return {
        name: typeof record.name === 'string' ? record.name : '',
        home: typeof record.home === 'string' ? record.home : '',
      };
    }
  } catch {
    // 取不到 profile 也要能返回报告
  }
  return { name: '', home: '' };
}

/**
 * 注册 `GET /api/studymate/health`。与其余路由同一约定：外层 ctx 自己 inject connection，
 * 缺服务就不挂。报告失败只回统一错误信封，不把插件搬崩。
 */
export function registerHealthRoute(ctx: HealthPluginContext | null | undefined): void {
  if (!ctx || typeof ctx.inject !== 'function') return;
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection;
    const register = connection?.fetch?.register;
    if (typeof register !== 'function' || typeof connectionCtx.effect !== 'function') return;
    connectionCtx.effect(() => register({
      path: HEALTH_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const profile = profileFrom(ctx);
          return Response.json(collectDoctorReport({
            dshHome: profile.home || undefined,
            profile: profile.name || undefined,
            ctx,
            checkDsh: false,
          }));
        } catch (error) {
          return routeError(500, 'internal', `健康检查失败：${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }), HEALTH_LABEL);
  });
}
