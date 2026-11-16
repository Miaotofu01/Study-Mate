/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 导出域 —— 泄漏守卫（对齐调研结论 F11 / 目标态规格 §8）

   一句话：**导出产物里一旦出现只有 Node 才有的东西，构建就失败。** 离线页面在
   `file://` 下由浏览器执行，那里没有 `require` / `process` / `Buffer` / `node:*`；产物里出现
   它们，说明导出器把自己的运行环境漏进了学生的页面（F11 的原话：服务端专用依赖泄漏进浏览器包）。

   扫描面是**分角色的**，因为「代码」与「数据」的判据不同。角色按**任意深度**的同名产物判：
   导出目录里可以再套一份完整导出（一门科目单独导过一次，落在 `<科目>/` 里），那仍是同一套
   `index.html` / `vendor/**` / `data.js` / `studymate-client.js` / `export.json`。只看根目录会让
   子目录里这些产物落到 `page` 全规则扫，把客户端 bundle 与第三方构建里的 CommonJS 模块加载 / `process.`
   报成泄漏（真实多科目导出树里一次 17 条，全是这一类误报）。

     page（index.html / host.js / boot.js；根与科目子目录里的都算）
         全规则扫。这几个文件是浏览器要执行的，出现 Node 专用东西一定是漏了。
     client（根目录的，或同目录带 export.json 的那一份）
         **不按模式扫**：它是仓库里 `lib/client.js` 的逐字拷贝，`factory(require)` 是宿主模块
         加载器的契约（理由的完整版见 `plan.ts` 的 `ProductRole`）。根目录那一份按哈希核对。
     data（根目录的，或同目录带 export.json 的那一份）
         只扫**载荷之前那一段**（`window.__STUDYMATE_EXPORT__ = ` 之前的注释与赋值）。
         载荷是 JSON，里面出现的 require 调用是课件正文（讲 Node 的那一课、代码块里的示例），
         拿它判失败是假阳性——它的角色是数据，只会被 JSON.parse，不会被执行。
     manifest（export.json，任意深度）
         只查「机器路径」这一条：它是给人看的清单，不参与执行。科目子目录里那份只当清单扫描，
         不引入哈希核对——哈希只对根导出那份清单做，子目录导出可能是别的版本导出来的。
     vendor（任意深度 vendor/*.js）
         **不按规则扫内容**，按哈希核对：壳里那一段必须是上游构建的逐字节拷贝
         （`splitVendor` 切出内容 → sha256 → 与 `export.json` 的 `third_party[].sha256` 比）。
         CommonJS 构建自己就写着 module.exports / 向模块表要 scheduler / 读 NODE_ENV
         ——那是它的**内容**，包装壳（`window.__smDefine(…)` 两行）才是我们写的代码。
         壳被改过就切不出内容，篡改立刻暴露。
     asset（assets/** 下的一切，以及 pdf / 图片 / 字体 / 压缩包这类二进制扩展名）
         二进制，不扫。

   **同名不等于就是产物**：子目录里的 `client` / `data` 只在该目录自己有 `export.json`（也就是
   一份完整导出）时按产物判；否则留在 `page`。学生往导出目录里随手放的 `lessons/data.js`、
   `vendor/README.txt` 于是仍按页面扫——按名字硬判会反过来造出新的误报：data 角色缺载荷标记
   报 `data-payload`、vendor 角色切不出包装壳报 `vendor-wrapper`。`vendor` 也只认 `.js`：
   README / LICENSE 这类本来就不套包装壳。

   为什么二进制扩展名按 asset 算：PDF（多科目导出目录里常见的样张、学生自己放的材料）、图片、
   字体、压缩包都不是导出器写的文本产物，是原样拷贝的资料；读成 utf8 只会得到乱码，拿规则去扫
   原文只会假阳性（真实样本里那份 PDF 带着一条 `file:///` 机器路径——那是文档里本来就有的链接，
   不是导出器漏出来的，被当文本扫才报成了 machine-path）。守卫管的是导出器自己写出来的文本产物。

   另有一条**机器路径**规则：导出这台机器的绝对路径（工作区、落点）不许进产物。产物是能拷走、
   能分享的东西，里面写死 `/home/…` 只会让它在别人机器上露馅。

   **扫的是原文，注释也算**：所以导出器自己的注释里别写出那些字面写法（host.js 里有一处注释就是
   为此改过措辞；连「require 加左括号」这种字面量也一并避开——#69 的架构边界套件按原文扫它，
   只许出现在 lib/client.js）。宁可偶尔假阳性，也不要为了「注释不算数」去写一个剥注释的状态机
   ——那玩意儿一旦剥错，漏掉的是真泄漏。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { ASSETS_DIR, CLIENT_FILE, DATA_FILE, MANIFEST_FILE, VENDOR_DIR, splitVendor } from './page.ts';
import type { ProductRole } from './plan.ts';
import type { ExportManifest } from './plan.ts';
import { MANIFEST_FORMAT } from './plan.ts';

export interface LeakRule {
  id: string;
  /** 规则在找什么（错误消息里照读）。 */
  what: string;
  pattern: RegExp;
  /** 哪些角色适用（`data` 只扫载荷之前那段，见文件头）。 */
  roles: readonly ProductRole[];
}

/** 规则表：唯一一份判据，加一条就自动对所有页面产物生效。 */
export const LEAK_RULES: readonly LeakRule[] = [
  {
    id: 'node-specifier',
    what: 'Node 内置模块（node:…）',
    // 要求**带引号的说明符**：CSS 类名 `.smb-node:hover` 这种写法会误伤（踩过）
    pattern: /['"]node:[a-z][\w./-]*['"]/,
    roles: ['page', 'data'],
  },
  {
    id: 'cjs-require',
    what: 'CommonJS 的 require 调用（浏览器页面里没有它）',
    pattern: /\brequire\s*\(/,
    roles: ['page', 'data'],
  },
  {
    id: 'node-process',
    what: 'Node 的 process 对象',
    pattern: /\bprocess\s*\./,
    roles: ['page', 'data'],
  },
  {
    id: 'node-buffer',
    what: 'Node 的 Buffer',
    pattern: /\bBuffer\s*[.(]/,
    roles: ['page', 'data'],
  },
  {
    id: 'node-module-exports',
    what: 'CommonJS 的 module.exports',
    pattern: /\bmodule\s*\.\s*exports\b/,
    roles: ['page', 'data'],
  },
  {
    id: 'node-dirname',
    what: '__dirname / __filename',
    pattern: /\b__(?:dirname|filename)\b/,
    roles: ['page', 'data'],
  },
  {
    id: 'esm-in-file-url',
    what: 'ES 模块语法（file:// 下按 CORS 加载不了，页面会白屏）',
    pattern: /(?:<script[^>]*\stype\s*=\s*["']module["'])|(?:^\s*(?:import|export)\s)/m,
    roles: ['page', 'data'],
  },
];

export interface LeakViolation {
  path: string;
  rule: string;
  what: string;
  line: number;
  excerpt: string;
}

export interface GuardFile {
  path: string;
  role: ProductRole;
  /** 文本产物；asset 没有。 */
  text?: string;
}

/** `data.js` 里载荷从哪开始：这之前是导出器写的那几行，属于「代码」。 */
const DATA_PAYLOAD_MARK = 'window.__STUDYMATE_EXPORT__ = ';

/** 一条规则在一个区域里第一个命中。 */
function firstHit(text: string, rule: LeakRule): { line: number; excerpt: string } | null {
  const match = rule.pattern.exec(text);
  if (!match) return null;
  const at = match.index;
  const line = text.slice(0, at).split('\n').length;
  const start = text.lastIndexOf('\n', at) + 1;
  const end = text.indexOf('\n', at);
  return { line, excerpt: text.slice(start, end < 0 ? text.length : end).trim().slice(0, 200) };
}

/**
 * 扫一组产物。
 *
 * @param files 产物（`asset` 会被跳过）
 * @param options.machinePaths 导出这台机器上不许出现在产物里的绝对路径（工作区、落点）
 */
export function scanLeaks(
  files: readonly GuardFile[],
  options: { machinePaths?: readonly string[] } = {},
): LeakViolation[] {
  const violations: LeakViolation[] = [];
  const machinePaths = (options.machinePaths ?? []).filter((value) => typeof value === 'string' && value.length > 1);
  for (const file of files) {
    if (typeof file.text !== 'string') continue;
    const text = file.text;

    if (file.role === 'client') {
      // 逐字拷贝的那一份不按模式扫（它的 `factory(require)` 是宿主契约，扫了必然假阳性）：
      // 判据是哈希，见 checkExport。
      continue;
    }
    if (file.role === 'vendor') {
      // 第三方内容按哈希核对（checkThirdParty），这里只确认「形状」没变：
      // 切不出包装就说明壳被改过，那正是「注入」最容易发生的地方。
      if (splitVendor(text) === null) {
        violations.push({
          path: file.path, rule: 'vendor-wrapper', what: 'vendor 包装壳不是导出器写的那两行',
          line: 1, excerpt: text.slice(0, 120),
        });
      }
    } else {
      for (const rule of LEAK_RULES) {
        if (!rule.roles.includes(file.role)) continue;
        if (file.role === 'data') {
          // 只扫载荷之前那段（见文件头：JSON 里的 require 调用是课件正文）
          const mark = text.indexOf(DATA_PAYLOAD_MARK);
          if (mark < 0) {
            violations.push({
              path: file.path, rule: 'data-payload', what: `${DATA_PAYLOAD_MARK} 不见了（data.js 被改过）`,
              line: 1, excerpt: text.slice(0, 120),
            });
            break;
          }
          const hit = firstHit(text.slice(0, mark), rule);
          if (hit) violations.push({ path: file.path, rule: rule.id, what: rule.what, ...hit });
          continue;
        }
        const hit = firstHit(text, rule);
        if (hit) violations.push({ path: file.path, rule: rule.id, what: rule.what, ...hit });
      }
    }

    for (const machinePath of machinePaths) {
      const at = text.indexOf(machinePath);
      if (at < 0) continue;
      violations.push({
        path: file.path, rule: 'machine-path',
        what: `导出这台机器的绝对路径（${machinePath}）`,
        line: text.slice(0, at).split('\n').length,
        excerpt: text.slice(Math.max(0, at - 40), at + machinePath.length + 40).replace(/\n/g, ' '),
      });
    }
  }
  return violations;
}

export interface GuardReport {
  checked: number;
  violations: LeakViolation[];
  /** 坏掉的产物（清单里没有、哈希对不上、vendor 被改）。 */
  manifestProblems: string[];
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 把产物与它的清单对齐着查：清单说有什么就得有什么，第三方内容与阅读端本体的哈希必须一致。
 * 哈希这一条是「没有第二个渲染器」这个承诺的机器证据——产物里那份 client.js 就是仓库里那一份。
 */
export function checkExport(
  files: readonly GuardFile[],
  manifest: ExportManifest | null,
  options: { machinePaths?: readonly string[] } = {},
): GuardReport {
  const violations = [...scanLeaks(files, options)];
  const manifestProblems: string[] = [];
  const byPath = new Map(files.map((file) => [file.path, file]));

  if (!manifest) {
    manifestProblems.push(`产物里没有 ${MANIFEST_FILE}（或者它读不成 JSON）：没有清单就核不了哈希`);
  } else {
    if (manifest.format !== MANIFEST_FORMAT) {
      manifestProblems.push(`${MANIFEST_FILE} 的 format 是 ${String(manifest.format)}，`
        + `这一版导出器认的是 ${MANIFEST_FORMAT}`);
    }
    for (const entry of manifest.files) {
      const file = byPath.get(entry.path);
      if (!file) {
        manifestProblems.push(`清单里有 ${entry.path}，产物里没有`);
        continue;
      }
      if (typeof file.text === 'string' && Buffer.byteLength(file.text) !== entry.bytes) {
        manifestProblems.push(`${entry.path} 的字节数与清单对不上（清单 ${entry.bytes}）`);
      }
    }
    for (const entry of manifest.third_party) {
      const file = byPath.get(entry.path);
      const parts = file && typeof file.text === 'string' ? splitVendor(file.text) : null;
      if (!parts) {
        manifestProblems.push(`第三方构建 ${entry.path} 切不出包装壳`);
        continue;
      }
      if (parts.moduleName !== entry.module) {
        manifestProblems.push(`${entry.path} 登记的是模块 ${entry.module}，壳里写的是 ${parts.moduleName}`);
      }
      if (sha256(parts.body) !== entry.sha256) {
        manifestProblems.push(`${entry.path} 的内容哈希与清单对不上：壳里那段已经不是上游构建的逐字节拷贝了`);
      }
    }
    const client = byPath.get('studymate-client.js');
    if (!client || typeof client.text !== 'string') {
      manifestProblems.push('产物里没有 studymate-client.js（阅读端本体）');
    } else if (sha256(client.text) !== manifest.client.sha256) {
      manifestProblems.push('studymate-client.js 与清单里的哈希对不上：搬的不是仓库里那一份 lib/client.js');
    }
  }
  return { checked: files.filter((file) => typeof file.text === 'string').length, violations, manifestProblems };
}

/**
 * 读不成 UTF-8 文本的扩展名：按 asset 跳过（理由见文件头「为什么二进制扩展名按 asset 算」）。
 * 只收「肯定不是文本」的那些；`.svg` / `.css` / `.md` 这类文本不在此列——它们要是产物，
 * 照角色扫才有意义。
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // 文档（样张、学生自己放的材料）
  '.pdf',
  // 图片
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.tif', '.tiff',
  // 字体
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // 压缩包与音视频、wasm
  '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar',
  '.mp3', '.mp4', '.webm', '.wav', '.ogg', '.wasm',
]);

/** `rel` 的目录部分里有没有一段正好叫 `name`（角色只看路径段，不看它在第几层）。 */
function hasDirSegment(rel: string, name: string): boolean {
  const segments = rel.split('/');
  segments.pop(); // 去掉文件名那一段
  return segments.includes(name);
}

/** 一条相对路径所在目录（导出根自己算空串）。 */
function dirOf(rel: string): string {
  const cut = rel.lastIndexOf('/');
  return cut === -1 ? '' : rel.slice(0, cut);
}

/**
 * 产物角色：按**同名的产物**判，但 `client` / `data` 认到子目录时必须先证明那儿是一份导出。
 *
 * 导出目录里可以再套一份完整导出（多科目导出树：`<科目>/index.html`、`<科目>/vendor/…`、
 * `<科目>/export.json` 与根目录是同一套产物）。这些同名产物要按各自角色判，否则子目录里的
 * client / vendor / data 会落到 `page` 全规则扫，把必然假阳性的 CommonJS 模块加载 / `process.` /
 * `module.exports` 报成泄漏。
 *
 * 但「同名」不等于「就是产物」：学生往导出目录里随手放一份 `lessons/data.js` 或
 * `vendor/README.txt`，按名字硬判会把它们当成产物——data 角色缺载荷标记就报 `data-payload`、
 * vendor 角色切不出包装壳就报 `vendor-wrapper`，误报只是换了个方向。所以：
 *   · 根目录的 `studymate-client.js` / `data.js` 无条件按产物判（根就是一份导出）；
 *   · 子目录里的，必须**同目录有 `export.json`**（完整导出的清单）才按产物判，否则留在 `page`；
 *   · `vendor` 只认 `.js`（第三方构建是 JS；README / LICENSE 这类不套包装壳核对）；
 *   · `export.json` 任意深度都按 `manifest` 判（清单本身只过「机器路径」一条，判错也不伤）。
 */
function roleOf(rel: string, exportRoots: ReadonlySet<string>): ProductRole {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  // 二进制先判：读成 utf8 只会得到乱码，扫出来的东西没有意义（PDF 见文件头）。
  if (BINARY_EXTENSIONS.has(path.posix.extname(base).toLowerCase())) return 'asset';
  if (hasDirSegment(rel, ASSETS_DIR)) return 'asset';
  if (base === MANIFEST_FILE) return 'manifest';
  if (hasDirSegment(rel, VENDOR_DIR) && path.posix.extname(base).toLowerCase() === '.js') return 'vendor';
  if (base === CLIENT_FILE || base === DATA_FILE) {
    const dir = dirOf(rel);
    if (dir === '' || exportRoots.has(dir)) return base === CLIENT_FILE ? 'client' : 'data';
  }
  return 'page';
}

function listFiles(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

/** 从盘上读一份导出目录（守卫的构建期入口用它，测试也用它）。 */
export function readExportDir(dir: string): { files: GuardFile[]; manifest: ExportManifest | null } {
  const files: GuardFile[] = [];
  const rels = listFiles(dir);
  // 哪些目录是一份完整导出（自己带 export.json）：只有这些目录里的同名产物才按产物角色判。
  const exportRoots = new Set(
    rels.filter((rel) => rel.slice(rel.lastIndexOf('/') + 1) === MANIFEST_FILE).map(dirOf),
  );
  for (const rel of rels) {
    const role = roleOf(rel, exportRoots);
    const full = path.join(dir, rel);
    files.push(role === 'asset' ? { path: rel, role } : { path: rel, role, text: fs.readFileSync(full, 'utf8') });
  }
  const manifestFile = path.join(dir, MANIFEST_FILE);
  let manifest: ExportManifest | null = null;
  if (fs.existsSync(manifestFile)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as ExportManifest;
    } catch {
      manifest = null;
    }
  }
  return { files, manifest };
}
