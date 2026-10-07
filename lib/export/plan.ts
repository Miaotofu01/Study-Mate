/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 导出域 —— 把工作区算成一份**产物清单**（读盘，但不写盘）

   分两步是刻意的：「算什么」与「怎么写」分开，于是产物清单可以先被看、被断言、被守卫扫，
   再落地。写完之后的 `export.json` 是同一份清单（加上哈希），对得上才对。

   数据来源只有两处，**都不新写解析器**：
     · 整份阅读端快照 = `readLibrary()` —— 与 DSH 的 `GET /api/studymate/library` 同一份
       （阅读端要什么形状，导出就要什么形状，这是「同一份渲染代码」的前提）；
     · 参考资料正文 = `readReference()` —— 阅读端点开资料时读的那一条路由，同一份读法。

   配图是**原样拷贝**：内容文件里写的是相对 `lessons/` 的路径（`../assets/img/pool/x.png`），
   落点就是 `<科目>/assets/**`。整棵 `assets/` 都搬，不按正文里出现过的路径挑——正文里没引用
   不等于学生不需要（图片库索引 `assets/img/pool.md` 自己就列着一堆，而且导出后没法再补）。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { readLibrary } from '../library.ts';
import { readReference } from '../reference.ts';
import { cmpCodePoints } from '../core/format.ts';
import { KATEX_VERSION, LICENSE_FILE, MATH_FONT_DIR, MATH_JS, katexDistDir, mathAssets } from '../math.ts';
import type { ReactSources } from './react.ts';
import { ASSETS_DIR } from './page.ts';
import type { VendorKey } from './page.ts';
import {
  BOOT_FILE, CLIENT_FILE, DATA_FILE, HOST_FILE, MANIFEST_FILE, MATH_ASSET_DIR, MATH_VENDOR_FILE,
  VENDOR_FILES, VENDOR_MODULES, assetProductPath, bootScript, dataScript, hostScript, indexHtml,
  pageTitle, scriptFiles, vendorFile,
} from './page.ts';

/** 产物清单的格式号：形状变了就加一（读清单的人按它判自己认不认得）。 */
export const MANIFEST_FORMAT = 1;

/**
 * 产物角色：泄漏守卫按角色决定扫什么。
 *
 * `client` 单独一档是刻意的：`studymate-client.js` 是 `lib/client.js` 的**逐字拷贝**，
 * 而那个文件里有 `factory(require)` 这个形参（宿主的模块加载器契约），
 * 按「页面代码不许出现 require 调用」去扫它必然是假阳性。它的判据因此不是模式而是**哈希**
 * ——产物里那一份必须与仓库里那一份逐字节相同（`guard.ts` 的 `checkExport`）。
 */
export type ProductRole = 'page' | 'client' | 'vendor' | 'data' | 'manifest' | 'asset';

export interface ExportProduct {
  /** 导出目录内的相对路径（POSIX 分隔符）。 */
  path: string;
  role: ProductRole;
  /** 文本产物（page / vendor / data / manifest）。 */
  text?: string;
  /** asset：盘上的来源文件。 */
  from?: string;
  bytes: number;
}

export interface ManifestSubject {
  slug: string;
  name: string;
  nodes: number;
  assets: number;
}

export interface ExportManifest {
  format: number;
  generated_at: string;
  subjects: ManifestSubject[];
  /** 搬的是哪一份 React（**没有机器路径**：`source` 是命中的候选名，如 `$STUDYMATE_REACT_DIR`）。 */
  react: { version: string; source: string; files: Partial<Record<VendorKey, string>> };
  /** 阅读端本体的哈希：证明产物里那份 client.js 是哪一份，没被改写。 */
  client: { file: string; sha256: string; bytes: number };
  /** 第三方构建：包装壳里的内容哈希（守卫按它核对，篡改就红）。 */
  third_party: { path: string; module: string; upstream: string; version: string; sha256: string }[];
  files: { path: string; role: ProductRole; bytes: number }[];
}

export interface ExportPlan {
  products: ExportProduct[];
  manifest: ExportManifest;
  /** 一句话说清这次导了什么（工具与 CLI 都拿它当摘要）。 */
  summary: string;
}

export interface PlanExportOptions {
  workspace: string;
  /** 只要这几门科目（slug）；省略 = 全部。给了不存在的 slug 直接抛。 */
  subjects?: readonly string[];
  /** 阅读端本体的位置；默认 `lib/client.js`（本模块旁边的 ../client.js）。 */
  clientFile?: string;
  react: ReactSources;
  now?: () => Date;
}

export class ExportPlanError extends Error {
  readonly code = 'EXPORT_PLAN';
  constructor(message: string) {
    super(message);
    this.name = 'ExportPlanError';
  }
}

/** 阅读端本体（`lib/client.js`）：与 `package.json` 的 `exports["./client"]` 同一个文件。 */
export function clientSourceFile(): string {
  return fileURLToPath(new URL('../client.js', import.meta.url));
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

function walkFiles(dir: string, prefix = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => cmpCodePoints(a.name, b.name))) {
    // 与安装器的拷贝同一条口径：缓存目录与系统垃圾文件不搬（它们不是内容）
    if (entry.name === '__pycache__' || entry.name.startsWith('.')) continue;
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walkFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

/**
 * 算一份导出计划。
 *
 * @throws ExportPlanError 工作区读不出来、科目挑不出来、阅读端本体不在。
 */
export function planExport(options: PlanExportOptions): ExportPlan {
  const now = options.now ?? ((): Date => new Date());
  const workspace = path.resolve(options.workspace);
  const clientFile = options.clientFile ?? clientSourceFile();
  if (!fs.existsSync(clientFile)) {
    throw new ExportPlanError(`${clientFile} 不在：导出的页面就是阅读端本体，缺了它没有可搬的渲染代码`);
  }
  const clientText = fs.readFileSync(clientFile, 'utf8');

  // 整份快照与 DSH 里那份逐字段相同——只有 `workspace` 一项被抹掉（见下）。
  const library = readLibrary({ workspace }) as {
    workspace?: unknown;
    subjects?: { slug?: unknown; name?: unknown; nodes?: unknown; reference?: unknown }[];
  };
  const allSubjects = Array.isArray(library.subjects) ? library.subjects : [];
  const wanted = options.subjects === undefined || options.subjects.length === 0 ? null : new Set(options.subjects);
  const chosen = wanted === null ? allSubjects : allSubjects.filter((subject) => wanted.has(String(subject.slug)));
  if (chosen.length === 0) {
    // 两条来路各说各的话，别共用同一个模板：`--subject` 点名了挑不出来的科目（要的是…有的是…），
    // 与「工作区在、一个科目都没建」——#90 把后者从抛错改成空清单（lib/library.ts）之后，这条
    // 以前到不了的路第一次可达；照旧模板印出来会是「要的是 ，有的是 （一门都没有）」，两个空位。
    const known = allSubjects.map((subject) => String(subject.slug)).join('、');
    throw new ExportPlanError(wanted === null
      ? '工作区里一个科目都没有：还没建过科目，没有可以导的东西'
      : `工作区里没有要导的科目：要的是 ${[...wanted].join('、')}，`
        + `有的是 ${known || '（一门都没有）'}`);
  }
  // 快照里的工作区路径是**导出这台机器**的绝对路径：离线产物要能拷走、能分享，
  // 所以抹成一个标记（阅读端只在「读不到数据」那张错误卡上显示过它）。
  library.workspace = '（离线导出副本）';
  library.subjects = chosen;

  const reference: Record<string, Record<string, string>> = {};
  const subjects: ManifestSubject[] = [];
  const products: ExportProduct[] = [];

  for (const subject of chosen) {
    const slug = String(subject.slug);
    const name = String(subject.name ?? slug);
    const nodeList = Array.isArray(subject.nodes) ? subject.nodes : [];
    const entries = Array.isArray(subject.reference) ? subject.reference as { path?: unknown }[] : [];
    const texts: Record<string, string> = {};
    for (const entry of entries) {
      const rel = typeof entry.path === 'string' ? entry.path : '';
      if (rel === '') continue;
      const found = readReference({ workspace, subject: slug, relPath: rel });
      if (found) texts[rel] = found.text;
    }
    if (Object.keys(texts).length > 0) reference[slug] = texts;

    const subjectDir = path.join(workspace, '.learning', 'subjects', slug);
    const assetsRoot = path.join(subjectDir, ASSETS_DIR);
    const assetFiles = walkFiles(assetsRoot);
    for (const rel of assetFiles) {
      const from = path.join(assetsRoot, rel);
      products.push({
        // `assets/` 这一段保留：阅读端给取图路由的 path 就是「相对科目目录」的写法
        path: assetProductPath(slug, `${ASSETS_DIR}/${rel}`),
        role: 'asset',
        from,
        bytes: fs.statSync(from).size,
      });
    }
    subjects.push({ slug, name, nodes: nodeList.length, assets: assetFiles.length });
  }

  /* 第三方构建：先登记包装，再算出哈希进清单（守卫按同一份哈希核对「壳里是不是原样那一段」）。 */
  const thirdParty: ExportManifest['third_party'] = [];
  const reactFiles = {} as Record<VendorKey, string>;
  for (const [key, moduleName] of Object.entries(VENDOR_MODULES) as [VendorKey, string][]) {
    const upstream = options.react[key];
    const body = fs.readFileSync(upstream, 'utf8');
    const file = VENDOR_FILES[key];
    reactFiles[key] = file;
    const text = vendorFile(moduleName, body);
    products.push({ path: file, role: 'vendor', text, bytes: Buffer.byteLength(text) });
    thirdParty.push({
      path: file,
      module: moduleName,
      // 包内相对路径（不含机器路径）：`react/cjs/react.production.js` 这种
      upstream: upstream.split(`${path.sep}node_modules${path.sep}`).pop()!.split(path.sep).join('/'),
      version: options.react.version,
      sha256: sha256(body),
    });
  }

  products.push({ path: CLIENT_FILE, role: 'client', text: clientText, bytes: Buffer.byteLength(clientText) });

  /* 公式（#91）：随包发的 KaTeX dist 也搬进产物——离线页面要能自己排版，不联网、不引 CDN。
     两处落点的判据不同（见 page.ts 的 MATH_VENDOR_FILE）：引擎走 vendor 包装壳 + 哈希，
     样式表与字体落 assets/。字体与 CSS 的相对位置不能改：CSS 里的 `url(fonts/…)` 相对样式表
     自己的 URL 解析。 */
  const mathEngineFile = path.join(katexDistDir(), MATH_JS);
  const mathEngineBody = fs.readFileSync(mathEngineFile, 'utf8');
  const mathEngineText = vendorFile('katex', mathEngineBody);
  products.push({ path: MATH_VENDOR_FILE, role: 'vendor', text: mathEngineText, bytes: Buffer.byteLength(mathEngineText) });
  thirdParty.push({
    path: MATH_VENDOR_FILE,
    module: 'katex',
    upstream: `lib/katex/${MATH_JS}`,
    version: KATEX_VERSION,
    sha256: sha256(mathEngineBody),
  });
  for (const asset of mathAssets()) {
    products.push({
      path: `${MATH_ASSET_DIR}/${asset.rel}`,
      // asset：**二进制/原样拷贝**那一档（守卫不扫内容、也不按 utf8 比字节）。CSS 也是这么走的。
      role: 'asset',
      from: asset.file,
      bytes: asset.bytes,
    });
  }
  /* 许可证随副本分发：产物就是 KaTeX 的一份副本，而这里**是两份不同的许可**——
     代码与 CSS 是 MIT，字体是 SIL OFL 1.1（带保留字体名）。两份都要带，别合成一份。 */
  for (const rel of [LICENSE_FILE, `${MATH_FONT_DIR}/${LICENSE_FILE}`]) {
    const licenseFile = path.join(katexDistDir(), rel);
    if (!fs.existsSync(licenseFile)) continue;
    products.push({
      path: `${MATH_ASSET_DIR}/${rel}`, role: 'asset', from: licenseFile, bytes: fs.statSync(licenseFile).size,
    });
  }

  const generatedAt = now().toISOString();
  const dataText = dataScript({
    library,
    reference,
    meta: {
      generatedAt,
      subjects: subjects.map((subject) => subject.slug),
      react: options.react.version,
      client: sha256(clientText).slice(0, 12),
    },
  });
  products.push({ path: DATA_FILE, role: 'data', text: dataText, bytes: Buffer.byteLength(dataText) });

  const host = hostScript();
  products.push({ path: HOST_FILE, role: 'page', text: host, bytes: Buffer.byteLength(host) });

  const title = pageTitle(subjects.map((subject) => subject.name));
  const boot = bootScript();
  products.push({ path: BOOT_FILE, role: 'page', text: boot, bytes: Buffer.byteLength(boot) });

  // 入口**最后**写（run.ts 按这个顺序落盘）：中途失败/取消的导出目录里没有 index.html，
  // 于是「这份导出是半成品」一眼可见，而不是一个看起来能用、点开缺内容的目录。
  const entry = indexHtml({
    title,
    note: `StudyMate 离线导出 · ${subjects.map((subject) => subject.name).join('、')} · ${generatedAt.slice(0, 10)}`,
    scripts: scriptFiles(reactFiles),
  });
  products.push({ path: 'index.html', role: 'page', text: entry, bytes: Buffer.byteLength(entry) });

  const manifest: ExportManifest = {
    format: MANIFEST_FORMAT,
    generated_at: generatedAt,
    subjects,
    react: { version: options.react.version, source: options.react.source, files: reactFiles },
    client: { file: 'lib/client.js', sha256: sha256(clientText), bytes: Buffer.byteLength(clientText) },
    third_party: thirdParty,
    files: products.map((product) => ({ path: product.path, role: product.role, bytes: product.bytes })),
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  products.push({ path: MANIFEST_FILE, role: 'manifest', text: manifestText, bytes: Buffer.byteLength(manifestText) });

  const nodes = subjects.reduce((total, subject) => total + subject.nodes, 0);
  const assets = subjects.reduce((total, subject) => total + subject.assets, 0);
  const summary = `导出 ${subjects.length} 门科目 / ${nodes} 个节点 / ${assets} 张配图，`
    + `共 ${products.length} 个文件（阅读端本体 ${Math.round(Buffer.byteLength(clientText) / 1024)}KB，`
    + `React ${options.react.version} 来自 ${options.react.source}，KaTeX ${KATEX_VERSION} 随包）`;

  return { products, manifest, summary };
}

/** 供调用方复用：产物里那些「拿得出来的清单」（不含二进制）。 */
export function textProducts(plan: ExportPlan): { path: string; role: ProductRole; text: string }[] {
  return plan.products
    .filter((product) => typeof product.text === 'string')
    .map((product) => ({ path: product.path, role: product.role, text: product.text as string }));
}
