/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 数据层 —— 「学习模式」预设的注册（迁移前的 Python 安装助手的替代）

   为什么要有它：安装器（`bin/studymate.mjs` 的 `installPayload`）与 DSH 原生加载
   （`bin/dsh-plugin.ts`）都要做同一件事——把 `preset/learning/` 注册成 DSH 的一个预设。
   这件事以前由迁移前的 Python 安装助手 干，安装器把它的 stdout 当**跨语言契约**读：

       { patchPath, patchChanged, mode }            ← 加 `config` 当 mode === 'bundle'

   现在 Python 退场了，这个形状一字不改地由这里产出（`installPreset` 的返回值），
   安装器直接读对象，不再有子进程与 JSON.parse。

   #104 起这里注册的是**两条**预设：默认的「学习模式」与同一份发行里的「答疑模式」
   （`extraPresets`，`preset/qa/`）。两条在**同一次**调用里产出——托管块的 BEGIN/END 只有
   一套，分两次调用会让后一次把前一次那块剥掉。学习那一侧的返回值字段与托管块逐字不变，
   答疑那条另给 `qaConfig`（additive）。

   **三件事，一件都不能少**：

     · 按 dsh 版本改写预设里的 workflow 行（0.1.6 起 `ptc`，之前是 `worker-thread`），
       写进 `--preset-target`；
     · 在 profile 的 `cordis.patch.yml` 里维护一段**带标记的托管块**（BEGIN/END），
       用户的其它配置一字不动——所以只在文本上拼接，不重新序列化整份 YAML；
     · 把该拦的情况**在写盘之前**全拦下（手动声明、符号链接、越界 profile 名……），
       失败时一个字节都不落盘。

   `mode` 的三种取值对应三条安装路：
     · `bundle`      —— 由 DSH 插件在启动时注册（原生安装），不写独立声明，返回值里多带 `config`；
     · `declarative` —— 0.1.7-alpha.1+：把预设定声明成 `@deepseek-ai/dsh-agent-preset` 的一条 insert；
     · `legacy`      —— 更老的宿主：只改 workflow 行，预设靠旧的预设目录加载。

   补丁文件的解析用的是 `lib/yaml.ts` 的解析器（开了 `tags`；块标量也一并打开，用户手写的
   补丁里可能有）。**插入位置**由本文件自己的行扫描定：解析器是行式的、不带 mark，
   而这里要的是「插在原文哪个下标」与「顶层是不是流式列表」两个事实。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseYaml } from './yaml.ts';

const BEGIN = '# BEGIN STUDYMATE LEARNING PRESET';
const END = '# END STUDYMATE LEARNING PRESET';
const PLUGIN = '@deepseek-ai/dsh-agent-preset';
const BUNDLE = '@yunmiao/studymate';
const BUNDLE_ENTRY_ID = 'studymate';

/** 主预设的 id：学习模式。托管块与冲突检查按它 + `extraPresets` 的 id 一起认「我们的预设」。 */
const DEFAULT_PRESET_ID = 'learning';

/** 声明式入口的行 id。一条预设一行，名字里带预设 id——托管块里因此有两行（学习 + 答疑）。 */
export function presetEntryId(presetId: string): string {
  return `studymate-${presetId}-preset`;
}

/**
 * 声明式入口的停用条件，在**导入那一行之前**求值：更老的 DSH 解析不到
 * `@deepseek-ai/dsh-agent-preset`，而只看 profileContext 分辨不出来（0.1.6-alpha.2 就有它了）。
 */
const DECLARATIVE_DISABLED = {
  __jsExpr: "(() => { try { return !ctx.get('pluginPackages')?.packageOf("
    + "'@deepseek-ai/dsh-agent-preset', ctx.baseUrl); } catch { return true; } })()",
};

/** 一条预设的来源：id（进 `config.id`、托管行与冲突检查）+ 目录（`agent.cordis.yml` + `preset.yml`）。 */
export interface PresetSource {
  id: string;
  dir: string;
}

export interface InstallPresetOptions {
  /** 预设目录（`agent.cordis.yml` + `preset.yml`）。改写**就地**写回这一份——
      安装器随后把整个目录原子替换到位，所以这里不认识「最终落点」。 */
  presetDir: string;
  /** 这条预设的 id；省略就是 `learning`（学习模式）。旧的调用一字不用改。 */
  presetId?: string;
  /**
   * 与主预设**同一次**注册的其余预设（答疑模式）：共用一段 BEGIN/END 托管块，各占一行 insert。
   *
   * 为什么必须同一次调用：托管块的标记只有一套，分两次调用时后一次会把前一次那块一起剥掉
   * （`withoutManaged` 按标记整块删），结果只剩一条预设。
   */
  extraPresets?: readonly PresetSource[];
  dshHome: string;
  profile?: string;
  mode?: 'standalone' | 'native';
  /** dsh 版本；`bundle` 时用不到，其余情况省略就去跑一次 `dsh --version`。 */
  dshVersion?: string;
  /** 暂存里的补丁文件。给了就不动 profile 里那一份（安装器先暂存、最后原子替换）。 */
  patchOutput?: string;
  /** 由 DSH 插件注册预设，不写独立声明（原生安装）。 */
  bundle?: boolean;
}

export interface PresetRegistration {
  /** 真正写出去的补丁路径；没变就是 null。 */
  patchPath: string | null;
  patchChanged: boolean;
  mode: 'bundle' | 'declarative' | 'legacy';
  /** 只有 `mode === 'bundle'` 有：交给 `ctx.agentPresets.register` 的预设配置。 */
  config?: unknown;
  /** 只有 `mode === 'bundle'` 且给了 `extraPresets` 才有：第一条附加预设（答疑模式）的配置。 */
  qaConfig?: unknown;
}

/* ── 版本比较（对齐迁移前的 Python 安装助手的 at_least） ───────────────────────
   规则：先比三段数字；都相同时**正式版大于预发布版**；再逐个比预发布段，
   数字段小于文字段（0.1.7-alpha.2 < 0.1.7-alpha.10 靠这一条）。 */

interface ParsedVersion {
  release: number[];
  isRelease: boolean;
  parts: Array<[number, number | string]>;
}

function parseVersion(value: string): ParsedVersion {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(value);
  if (!match) throw new Error(`无法识别 dsh 版本：${value}`);
  const prerelease = match[4];
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    isRelease: !prerelease,
    parts: prerelease
      ? prerelease.split('.').map(part => (/^\d+$/.test(part) ? [0, Number(part)] : [1, part]))
      : [],
  };
}

export function atLeast(version: string, minimum: string): boolean {
  const left = parseVersion(version);
  const right = parseVersion(minimum);
  for (let i = 0; i < 3; i++) {
    if (left.release[i] !== right.release[i]) return left.release[i] > right.release[i];
  }
  if (left.isRelease !== right.isRelease) return left.isRelease;
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i++) {
    const a = left.parts[i];
    const b = right.parts[i];
    if (a === undefined) return false; // 短的预发布段更小
    if (b === undefined) return true;
    if (a[0] !== b[0]) return a[0] > b[0]; // 数字段 < 文字段
    if (a[1] !== b[1]) return a[1] > b[1];
  }
  return true;
}

/** 当前的 dsh 版本；没有 dsh 返回 null，跑不起来则报错（不猜）。 */
export function installedVersion(run = defaultRun): string | null {
  const result = run('dsh', ['--version']);
  if (result.error) return null;
  if (result.status !== 0) {
    // cmd.exe 把「找不到 npm shim」报成非零退出，而不是 ENOENT。
    if (process.platform === 'win32' && !which('dsh')) return null;
    throw new Error('dsh --version 运行失败，请修复 dsh 或显式传入 --dsh-version');
  }
  return (result.stdout ?? '').trim();
}

interface RunResult { status: number | null; stdout?: string; stderr?: string; error?: Error }

function defaultRun(command: string, args: string[]): RunResult {
  return spawnSync(command, args, {
    encoding: 'utf8', timeout: 15000, windowsHide: true, shell: process.platform === 'win32',
  });
}

function which(command: string): string | undefined {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'sh',
    process.platform === 'win32' ? [command] : ['-c', `command -v ${command}`],
    { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout?.split(/\r?\n/).map(line => line.trim()).find(Boolean);
}

/* ── 文本小工具 ────────────────────────────────────────────────────────── */

function read(file: string): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

/** 去掉托管块。标记不完整或重复时报错——那种文件不能猜着改。 */
export function withoutManaged(text: string): string {
  if (!text.includes(BEGIN) && !text.includes(END)) return text;
  const pattern = new RegExp(`^${BEGIN}\\r?\\n[\\s\\S]*?^${END}(?:\\r?\\n|$)`, 'gm');
  const matches = text.match(pattern) ?? [];
  const stripped = text.replace(pattern, '');
  if (matches.length !== 1 || stripped.includes(BEGIN) || stripped.includes(END)) {
    throw new Error('StudyMate 注册标记不完整或重复，请先检查 cordis.patch.yml');
  }
  return stripped;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ── 补丁文件：解析结果 + 插入位置 ────────────────────────────────────────
   解析器给「内容」，这里给「插在哪」。补丁是**用户文件**，所以插入一律走文本拼接，
   绝不重新序列化：注释、`!!js` 表达式、单引号写法、CRLF 都得原样留着。 */

interface PatchDocument {
  /** 顶层值：数组，或 null（空文档 / 只有注释）。 */
  data: unknown;
  /** 顶层是不是块式列表（`- row`）；流式（`[row]`）插入时要自己补逗号。 */
  block: boolean;
  /** 插到清理后文本的哪个下标。 */
  insertAt: number;
  /** 流式列表：托管行前面还得补一个逗号吗（空列表、或末项后面已经有逗号时不用）。 */
  commaNeeded: boolean;
  /** 文档里一个内容节点都没有（只有空行/注释/文档标记）。 */
  empty: boolean;
}

/** 行首位置表：`{ start, text }`，`\r\n` 也按行切开（偏移取自原文）。 */
function rawLines(text: string): Array<{ start: number; text: string }> {
  const lines: Array<{ start: number; text: string }> = [];
  let index = 0;
  for (const piece of text.split('\n')) {
    const line = piece.endsWith('\r') ? piece.slice(0, -1) : piece;
    lines.push({ start: index, text: line });
    index += piece.length + 1;
  }
  return lines;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function isCommentLine(line: string): boolean {
  return line.trimStart().startsWith('#');
}

/** 去掉一段文本里的注释（引号内的 `#` 不算）。 */
function stripComments(text: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inDouble) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i++; } else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      out += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") { out += "'"; i++; } else inSingle = false;
      }
      continue;
    }
    if (ch === '"') { inDouble = true; out += ch; continue; }
    if (ch === "'") { inSingle = true; out += ch; continue; }
    if (ch === '#' && (i === 0 || ' \t[{,'.includes(text[i - 1]))) {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/** 顶层流式列表的闭合 `]` 在哪（引号与注释里的括号不算）。 */
function flowEnd(text: string, open: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '#' && (i === 0 || ' \t[{,'.includes(text[i - 1]))) {
      while (i < text.length && text[i] !== '\n') i++;
    }
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const DOC_START = /^---(?:\s|$)/;
const DOC_END = /^\.\.\.(?:\s|$)/;

/**
 * 把清理后的补丁文本切成「内容行」，顺便记下文档标记与内容边界。
 *
 * 文档标记（首行 `---`、末行 `...`）在 YAML 里只是分隔符，PyYAML 侧由 load 处理；
 * 这里按行跳过，但**偏移仍然取自原文**，所以插入位置不会错位。
 */
function scanDocument(text: string): PatchDocument & { contentLines: Array<{ start: number; end: number; content: string }> } {
  const lines = rawLines(text);
  const contentLines: Array<{ start: number; end: number; content: string }> = [];
  for (const line of lines) {
    if (isBlank(line.text) || isCommentLine(line.text)) continue;
    if (DOC_START.test(line.text) || DOC_END.test(line.text)) continue;
    contentLines.push({ start: line.start, end: line.start + line.text.length, content: line.text });
  }
  const empty = contentLines.length === 0;
  const trimmed = contentLines.map(line => line.content.trimStart());
  // 顶层是流式列表时，托管行必须插进 `]` **之前**，且看末项后面有没有逗号。
  // `{...}` 不在这里处理：那是个映射，交给 YAML 解析报「顶层必须是列表」，消息更准。
  const flow = !empty && trimmed[0].startsWith('[');
  if (flow) {
    const open = text.indexOf('[', contentLines[0].start);
    const close = open < 0 ? -1 : flowEnd(text, open);
    if (close < 0) throw new Error('补丁文件的流式列表没有闭合，不会覆盖原配置');
    const inner = stripComments(text.slice(open + 1, close));
    const body = inner.trim();
    return {
      data: null, block: false, insertAt: close,
      commaNeeded: body !== '' && !inner.trimEnd().endsWith(','), empty: false, contentLines,
    };
  }
  // 块式（或空文档）：插在最后一个内容行**连同它的换行之后**。
  // 这正是 PyYAML 给块集合的 end_mark（BlockEndToken 落在下一行行首），也是幂等的前提：
  // 「去掉托管块」的正是那段文本，去掉之后一字不差地回到插入前。
  let blockInsertAt: number;
  if (empty) {
    blockInsertAt = text.length;
  } else {
    const end = contentLines[contentLines.length - 1].end;
    blockInsertAt = text.startsWith('\r\n', end) ? end + 2 : text.startsWith('\n', end) ? end + 1 : end;
  }
  return { data: null, block: true, insertAt: blockInsertAt, commaNeeded: false, empty, contentLines };
}

/**
 * 把文档标记（首行 `---`、末行 `...`）抹成空行再交给解析器。
 *
 * 学习文件那边 `---` / `...` 一律报错（一个文件只解析一个文档），但补丁文件是 DSH 的配置，
 * 带标记是合法的。只抹**开头这一个**与**末尾这一个**：中间再来一个就是真的多文档，那时
 * 解析器会照旧报错——多文档必须失败，不能只读第一份。
 */
const PATCH_PARSE_OPTIONS = { tags: 'scalar', blockScalars: true, documentMarkers: true } as const;

/** 解析并校验一份补丁文件；返回解析出的内容与插入位置。 */
function parsePatch(text: string, file: string): PatchDocument {
  const document = scanDocument(text);
  const data = parseYaml(text, { file, ...PATCH_PARSE_OPTIONS });
  if (data === null) {
    // 只有空行/注释/文档标记时整份文档没有节点；有内容还解出 null，说明顶层是个 `null` 标量。
    if (!document.empty) throw new Error(`${file} 顶层必须是 YAML 列表`);
    return { ...document, data: null };
  }
  if (!Array.isArray(data)) throw new Error(`${file} 顶层必须是 YAML 列表`);
  validateRows(data, file);
  return { ...document, data };
}

function validateRows(entries: unknown, file: string): void {
  if (!Array.isArray(entries)) throw new Error(`${file} 的配置行必须是 YAML 列表`);
  for (const row of entries) {
    if (!isPlainObject(row)) throw new Error(`${file} 的配置行必须是 YAML 对象`);
    if ('insert' in row) validateRows(row.insert, file);
    if (row.group === true && Array.isArray(row.config)) validateRows(row.config, file);
  }
}

/** 展开所有配置行：一条行的 insert 与 group 的 config 也算（插件自己的配置不是补丁行）。 */
function* rows(data: unknown): Generator<Record<string, unknown>> {
  if (!Array.isArray(data)) return;
  for (const row of data) {
    if (!isPlainObject(row)) continue;
    yield row;
    if (Array.isArray(row.insert)) yield* rows(row.insert);
    if (row.group === true && Array.isArray(row.config)) yield* rows(row.config);
  }
}

function nameOf(row: Record<string, unknown>): unknown {
  return 'name' in row ? row.name : null;
}

/** 手动声明的 StudyMate 预设（我们的任意一条预设 id）：它比我们更权威，见到就停手。 */
function declaredPresetRows(data: unknown, ids: readonly string[]): Array<{ id: string; row: Record<string, unknown> }> {
  const found: Array<{ id: string; row: Record<string, unknown> }> = [];
  for (const row of rows(data)) {
    const name = nameOf(row);
    if (!(name === null || name === '' || name === PLUGIN)) continue;
    if (!isPlainObject(row.config)) continue;
    const id = row.config.id;
    if (typeof id === 'string' && ids.includes(id)) found.push({ id, row });
  }
  return found;
}

/* ── 与用户已有配置的冲突检查 ──────────────────────────────────────────── */

function checkNativeOverrides(data: unknown, file: string, options: {
  standalone: boolean; selected: boolean; globalPatch: boolean; entryIds: ReadonlySet<string>;
}): void {
  for (const row of rows(data)) {
    let introduced: unknown[] = Array.isArray(row.insert) ? [...row.insert] : [];
    if (row.group === true && Array.isArray(row.config)) introduced = [...introduced, ...row.config];
    if ([...rows(introduced)].some(item => nameOf(item) === BUNDLE || item.id === BUNDLE_ENTRY_ID)) {
      throw new Error(`${file} 有手动插入的 StudyMate 入口；请先处理该声明，未修改配置`);
    }
    if (typeof row.id === 'string' && options.entryIds.has(row.id)) {
      throw new Error(`${file} 的 ${row.id} 已被手动配置使用；未修改配置`);
    }
    if (row.id !== BUNDLE_ENTRY_ID) continue;
    const name = nameOf(row);
    if (!(name === null || name === '' || name === BUNDLE)) {
      throw new Error(`${file} 的 studymate id 已被其他插件使用；未修改配置`);
    }
    if (row.group) throw new Error(`${file} 的 studymate 入口被设为 group，无法安全切换；未修改配置`);
    const disabled = 'disabled' in row ? row.disabled : false;
    if (!options.standalone && disabled !== false) {
      throw new Error(`${file} 有手动停用 StudyMate 的配置；请先处理该配置，未修改配置`);
    }
    if (options.standalone && options.selected && options.globalPatch
        && 'disabled' in row && disabled !== true) {
      throw new Error(`${file} 的全局配置会重新启用 StudyMate 原生入口；未修改配置`);
    }
  }
}

/** profile 的 package.json 有没有把本包装进 `dsh.profile.bundles`（装了依赖 ≠ 启用了它）。 */
function bundleSelected(profileDir: string): boolean {
  const manifest = path.join(profileDir, 'package.json');
  if (!fs.existsSync(manifest)) return false;
  let data: unknown;
  try {
    data = JSON.parse(read(manifest));
  } catch (error) {
    throw new Error(`无法解析 ${manifest}，未修改配置：${error instanceof Error ? error.message : String(error)}`);
  }
  // `dsh` 与 `profile` 缺失按空对象算（配置文件里没这一段很正常）；**存在但不是对象**要报错：
  // 那时我们看不懂这份清单，猜着往下走会误判「没选中 bundle」。
  let node = data;
  for (const key of ['dsh', 'profile']) {
    if (!isPlainObject(node)) throw new Error(`无法解析 ${manifest}，未修改配置`);
    node = key in node ? node[key] : {};
  }
  if (!isPlainObject(node)) throw new Error(`无法解析 ${manifest}，未修改配置`);
  const bundles = 'bundles' in node ? node.bundles : [];
  if (!Array.isArray(bundles) || bundles.some(item => typeof item !== 'string')) {
    throw new Error(`${manifest} 的 dsh.profile.bundles 必须是包名列表；未修改配置`);
  }
  return bundles.includes(BUNDLE);
}

/* ── 托管块 ────────────────────────────────────────────────────────────── */

/**
 * 把托管行拼进补丁文本。
 *
 * 流式列表（`[{...}]`）必须插在闭合的 `]` **之前**并补一个逗号——直接往文件末尾追加
 * 会得到「流式列表后面跟着块式列表」的非法 YAML。不到位的话宁可报错，不猜。
 */
function insertManaged(text: string, document: PatchDocument, entries: unknown[]): string {
  const encoded = entries.map(row => JSON.stringify(row));
  if (!document.block) {
    const closing = document.insertAt;
    const prefix = text.slice(0, closing);
    const separator = prefix.endsWith('\n') ? '' : '\n';
    const payload = encoded.join(',\n');
    const block = `${separator}${BEGIN}\n${document.commaNeeded ? ',' : ''}${payload}\n${END}\n`;
    return prefix + block + text.slice(closing);
  }
  const position = document.insertAt;
  const prefix = text.slice(0, position);
  const payload = encoded.map(row => `- ${row}\n`).join('');
  const block = `${BEGIN}\n${payload}${END}\n`;
  return prefix + (prefix === '' || prefix.endsWith('\n') ? '' : '\n') + block + text.slice(position);
}

/** 原子替换：同目录临时文件 → 改权限 → rename。符号链接一律不覆盖。 */
function atomicWrite(file: string, text: string): void {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error(`为避免改动其他目录，不覆盖符号链接：${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.studymate-${process.pid.toString(36)}-${Date.now().toString(36)}`);
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8' });
    if (stat) fs.chmodSync(temporary, stat.mode);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/* ── 入口 ──────────────────────────────────────────────────────────────── */

/**
 * 注册 StudyMate 的预设；形状与迁移前的 Python 安装助手的 stdout 一字不差。
 *
 * 默认只注册「学习模式」（`presetId` 省略 = `learning`）；给了 `extraPresets` 就在**同一次**
 * 调用里把「答疑模式」也注册上——两条预设共用一段 BEGIN/END 托管块，各占一行 insert。
 *
 * 失败一律抛 `Error`，且**在写盘之前**——调用方（安装器）把消息原样报给用户，
 * 不需要从 stderr 里捞。
 */
export function installPreset(options: InstallPresetOptions): PresetRegistration {
  const native = options.bundle === true; // 「由插件注册」，不写独立声明
  const handoff = options.mode === 'native'; // 显式切到原生安装
  if (native && handoff) throw new Error('--bundle 不可与 --mode native 同时使用');
  const version = native ? null : options.dshVersion ?? installedVersion();
  const modern = native || (version !== null && atLeast(version, '0.1.7-alpha.1'));
  if (handoff && !modern) throw new Error('切换原生安装需要 DSH 0.1.7-alpha.1+；旧版请使用默认 install');
  const workflow = native || (version !== null && atLeast(version, '0.1.6-alpha.1'))
    ? 'ptc' : 'worker-thread';

  const home = path.resolve(options.dshHome.replace(/^~(?=$|[/\\])/, os.homedir()));
  let profile = options.profile ?? 'web';
  // 桌面端启动器把自己的保留档位写成小写；跟着它走，写出来的目录才和它启动的那个一致。
  if (profile.toLowerCase() === 'desktop') profile = 'desktop';
  if (!profile || /[/\\\0]/.test(profile) || ['.', '..', 'node_modules'].includes(profile)) {
    throw new Error('--profile 必须是单个配置名称，不能包含路径分隔符，也不能使用 node_modules');
  }

  // 主预设 + 附加预设（答疑模式）。顺序就是托管块里 insert 行的顺序，也是 `config`/`qaConfig` 的顺序。
  const presets: PresetSource[] = [
    { id: options.presetId ?? DEFAULT_PRESET_ID, dir: options.presetDir },
    ...(options.extraPresets ?? []),
  ];
  for (const preset of presets) {
    if (typeof preset.id !== 'string' || preset.id.trim() === '') {
      throw new Error('预设 id 不能为空；未修改配置');
    }
  }
  if (new Set(presets.map(preset => preset.id)).size !== presets.length) {
    throw new Error('预设 id 不能重复；未修改配置');
  }
  const presetIds = presets.map(preset => preset.id);
  const entryIds = new Set(presets.map(preset => presetEntryId(preset.id)));

  // 每条预设的 workflow 行都按 dsh 版本就地在**它自己那份** agent.cordis.yml 上改写。
  const staged = presets.map(preset => {
    const file = path.join(preset.dir, 'agent.cordis.yml');
    const agent = fs.readFileSync(file, 'utf8').replace(
      /(@deepseek-ai\/dsh-workflow-|\bid: workflow-)(?:worker-thread|ptc)\b/g,
      (_match, prefix: string) => prefix + workflow);
    return { ...preset, file, agent };
  });

  const patch = path.join(home, 'profiles', profile, 'cordis.patch.yml');
  const selected = bundleSelected(path.dirname(patch));
  if (handoff && !selected) {
    // 桌面端的保留档位只由它自带的启动器管。
    const launcher = profile === 'desktop' ? '桌面端自带的 dsh' : 'dsh';
    throw new Error(`请先运行 ${launcher} plugin --profile ${profile} add @yunmiao/studymate，再切换原生安装`);
  }
  const bundle = native || handoff;

  const original = read(patch);
  const clean = withoutManaged(original);
  const document = parsePatch(clean, patch);
  const homePatch = path.join(home, 'cordis.patch.yml');
  const homeData = parsePatch(read(homePatch), homePatch).data;
  const declaredHome = declaredPresetRows(homeData, presetIds);
  if (declaredHome.length) {
    throw new Error(`${homePatch} 已声明 ${declaredHome[0].id} 预设，请先处理该全局声明；未修改配置`);
  }
  const declaredLocal = declaredPresetRows(document.data, presetIds);
  if (declaredLocal.length) {
    throw new Error(`${patch} 已手动声明 ${declaredLocal[0].id} 预设，请先处理该声明；未修改配置`);
  }
  if (native && original.includes(BEGIN)) {
    throw new Error('学习模式仍由 npx 管理；如需切换，请运行 '
      + `npx -y @yunmiao/studymate@latest install --mode native --profile ${profile} 后重启 DSH`);
  }
  for (const [entries, location, globalPatch] of [
    [document.data, patch, false], [homeData, homePatch, true]] as const) {
    checkNativeOverrides(entries, location, { standalone: !bundle, selected, globalPatch, entryIds });
  }

  let updated = native ? original : clean;
  const configs: unknown[] = [];
  const managed: unknown[] = [];
  const [mainPreset] = presets;
  if (modern) {
    for (const preset of staged) {
      const metadataFile = path.join(preset.dir, 'preset.yml');
      const metadata = parseYaml(read(metadataFile), { file: metadataFile });
      if (metadata !== null && !isPlainObject(metadata)) {
        throw new Error(`${preset.id} 预设元数据必须是对象；未修改配置`);
      }
      const source = (metadata ?? {}) as Record<string, unknown>;
      const config: Record<string, unknown> = Object.fromEntries(['name', 'description', 'order']
        .filter(key => key in source).map(key => [key, source[key]]));
      const plugins = parseYaml(preset.agent, { file: preset.file, tags: 'expression', blockScalars: true });
      if (!Array.isArray(plugins)) throw new Error(`${preset.id} 预设必须是插件列表；未修改配置`);
      // #138：StudyMate 的原生工具住在**主预设（学习模式）的作用域**里，不在 profile 根上——
      // 那样别的预设（含宿主内置的 standard）看不见它们。这条行**只在原生安装时加**：
      // 声明式安装（standalone）下本包不在 profile 里，模块解析不到，而 `dsh-agent-presets`
      // 把「有一行起不来」判成**整条预设 broken**，连学习模式都会挂不上。
      if (bundle && preset.id === mainPreset.id) {
        plugins.push({ id: 'studymate-tools', name: `${BUNDLE}/learning-preset` });
      }
      config.id = preset.id;
      config.plugins = plugins;
      configs.push(config);
      if (!bundle) {
        managed.push({ insert: [{ id: presetEntryId(preset.id), name: PLUGIN, disabled: DECLARATIVE_DISABLED, config }] });
      }
    }
  }
  if (selected && !bundle) managed.push({ id: BUNDLE_ENTRY_ID, name: BUNDLE, disabled: true });
  if (managed.length) updated = insertManaged(clean, document, managed);
  else if (!native && updated !== original && document.empty) {
    // 只有注释的文档在 YAML 里是 null，DSH 拒绝加载；补一个空列表。
    updated += (updated === '' || updated.endsWith('\n') ? '' : '\n') + '[]\n';
  }
  // 拼出来的东西必须自己先能解析——写坏了比不写更糟。
  parsePatch(updated, patch);

  const changed = !native && updated !== original;
  const output = options.patchOutput ?? patch;
  const symlink = staged.some(preset => fs.lstatSync(preset.file, { throwIfNoEntry: false })?.isSymbolicLink())
    || (changed && fs.lstatSync(output, { throwIfNoEntry: false })?.isSymbolicLink());
  if (symlink) throw new Error('预设或配置文件是符号链接；未修改配置');
  for (const preset of staged) atomicWrite(preset.file, preset.agent);
  if (changed) atomicWrite(output, updated);

  const result: PresetRegistration = {
    patchPath: changed ? output : null,
    patchChanged: changed,
    mode: bundle ? 'bundle' : modern ? 'declarative' : 'legacy',
  };
  if (bundle) {
    result.config = configs[0];
    if (configs.length > 1) result.qaConfig = configs[1];
  }
  return result;
}
