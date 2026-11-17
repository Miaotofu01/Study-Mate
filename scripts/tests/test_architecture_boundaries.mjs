/* 架构边界与依赖无环断言（#69）。
   ────────────────────────────────────────────────────────────────────────
   把「谁能 import 谁」变成一条会失败的测试：**扫真实源码**解析 `import` / `export … from` /
   动态 `import()` 的说明符，得到真实 import 图，再拿下面那张域规则表去判。这里**没有手写的模块
   清单**——手写清单正是「新模块因为忘了登记而逃过」的成因，所以模块、边、环全部从源码算出来。

   三条规则（`decisions.md` §2「目录即域」是规范）：
     1. 域 = `lib/` 下的一级目录；直接躺在 `lib/` 里的文件属于域 `lib`；`lib/client.js` 单列为
        `client`（浏览器侧那个单文件，不是 Host 数据层）；`bin/` 单列为 `bin`；`client/` 下的源码
        单列为 `client`（`client/notes/**` → `notes-client`；其它 `client/<目录>/**` 是**未登记的
        新域，默认拒绝**——浏览器侧的组件别想靠新建一个目录绕过登记）。
        **不在 `DOMAIN_RULES` 里的一级目录就是新域，默认拒绝**——这是「新增模块逃不过」的机制。
     2. `lib/core/**` 是纯函数域：不 import 任何 `node:*`，也不 import `lib/core/**` 之外的东西；
        `notes-client` 是浏览器域：不 import 任何 `node:*`、不碰 `lib/**` / `bin/**`，外部包只许用
        `FRONTEND_PACKAGES` 里**逐个登记过**的那几个（构建期依赖，构建时内联进 `dist/client.js`，
        宿主运行时不多一个依赖）。
     3. 域图与模块图都**无环**。

   图之外还有两条同类断言：CommonJS `require(...)` 不在扫描范围内（`lib/client.js` 里那个
   `require` 是浏览器模块加载器的**形参**，不是依赖声明），所以反过来钉一条「`require(` 只许出现
   在 `client` 域」；动态 `import()` 的说明符**定不死就报错而不是放过**（`await import(变量)`
   能把任何模块拉进来，而静态图看不见它）。

   JSX 怎么进图：`.jsx` / `.tsx` 不是 JS，`source_mask` 的引号状态机遇到 `</div>` 这类收尾标签
   会把 `"` 当成字符串开头，后面整段的区间就错位了。所以扫描前先用 esbuild（本包已装的
   devDependency）按 jsx loader 转成不裁剪、不压缩的 JS，再交给同一个扫描器——文件一个不跳过。
   代价：**报错里的列号指向转译后的代码**（行号大体还对着原文，拿来定位够用）。

   想亲手复核这张网还张着（改了规则表或扫描器之后特别值得跑一遍）：
     · 越界：往 `lib/core/format.ts` 顶上临时加一行 `import fs from 'node:fs';` → 本套件必须红；
     · 成环：往 `lib/core/anchors.ts` 顶上临时加一行 `import { readLibrary } from '../library.ts';`
       （core 反向依赖 lib，域图成环）→ 本套件必须红；
     · 浏览器域越界：往 `client/notes/App.jsx` 顶上临时加一行 `import fs from 'node:fs';` → 本套件必须红。
   三条都验完记得删掉——它们是反证，不是代码。 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { transformSync } from 'esbuild';

import { maskSource, insideLiteral } from './fixtures/source_mask.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/* ── 域规则表：**唯一**的越权判据，默认拒绝 ──────────────────────────────────
   `allow`   = 这个域允许 import 的**其它**域（同域恒允许，不写）。
   `builtin` = 允许 import `node:*`；`package` = 允许 import 裸包名（外部 npm 依赖）。

   为什么 `package` 一律 false：本包是**零运行时依赖**（`lib/yaml.ts` 自写 YAML 子集就是为了让
   Host 半装得进任何宿主，不进 npm 依赖）。真要引依赖，就得来改这张表——那正是「不经登记跨不过
   去」想要的效果。

   `tasks` / `watch` / `export` 是施工口径（`briefs-wave2.md`）点名的后续落点（#73 后台任务、
   #74 文件监听），按口径先登记；它们的目录还没落地，所以「扫到的域数」会小于这张表的条目数。
   **除此之外的新域一律拒绝**：报错信息会告诉你去哪登记，而不是随便加个目录就能过。 */
const DOMAIN_RULES = {
  core:   { allow: [], builtin: false, package: false },  // 纯函数域：一个外部依赖都不许
  lib:    { allow: ['core'], builtin: true, package: false },  // Host 数据层
  // host 是「工具能碰哪些学习数据」那一层的落点（域词表、越权 guard、域数据读法）：它读 lib
  // 的数据层与 core 的纯函数，自己**不**认识工具域与实验域——反过来 tools → host、lab → host
  // 才是那两条边。放在 lib/ 下的二级目录而不是直接摊在 lib/ 里，是因为它要能被两个域同时
  // import 而不制造反向边；目录名 `host` 指的是「Host 数据层的守卫」，不是宿主适配层。
  host:   { allow: ['core', 'lib'], builtin: true, package: false },
  // tools 是**组合根**：#68 的注册点 `registerStudyMate` 要逐个调用各子系统自己目录里的
  // registerXxx，所以它必须 import 每个子系统（tools → tasks、tools → watch、tools → lab、
  // tools → export）。方向**只有**这一条——子系统一律不许 import tools（任务域就是把
  // `registerStudyTool` 当参数接过去的，正是为了不出现反向边，见 lib/tasks/tools.ts 文件头）。
  // 往后每落地一个注册进注册点的子系统，这里加一个域名，别改成通配。
  tools:  { allow: ['core', 'lib', 'host', 'tasks', 'watch', 'lab', 'export', 'reach'], builtin: true, package: false },  // 原生工具（#68）+ 任务（#73）+ 监听（#74）+ 实验（#77）+ 导出（#82）+ 核验（#125）
  tasks:  { allow: ['core', 'lib'], builtin: true, package: false },  // 任务模型（#73）
  // 实验域（#77）：判分三轨的第三轨。要 core（题型与必备字段）、lib（作答数据的落点）、
  // tasks（长命令走任务模型、可查可取消）。`node:child_process` 是它存在的理由，而它
  // **不** import tools：guard 与 vault 在 `host` 域里（#77 搬过去的），所以 Web 路由那条
  // 入口不需要借道工具域。
  lab:    { allow: ['core', 'lib', 'host', 'tasks'], builtin: true, package: false },
  // 问答域（#79）：阅读端问答面板那条 HTTP 路由。只依赖纯函数域与 Host 数据层——
  // 它**不** import 工具域（能力探测的本体在 `lib/core/model.ts`，见那里的文件头），
  // 所以这里没有 tools 这条边；反过来说，往这个域里加 `tools` 就是加了一条反向边。
  ask:    { allow: ['core', 'lib'], builtin: true, package: false },
  watch:  { allow: ['core', 'lib'], builtin: true, package: false },  // 文件监听（#74）：只读工作区 + 一条 SSE 路由
  // 导出（#82）：读 `lib`（library / reference / assets）与 `core`，登记任务类型要 `tasks`。
  // **不许 import tools**（预登记的初值里有它）：工具域 import 导出域去注册 `studymate_export`，
  // 反向再来一条就是域图成环——这条环由下面的环检测拦下，所以这里直接不写。
  export: { allow: ['core', 'lib', 'tasks'], builtin: true, package: false },
  // 核验域（#125）：核「资源清单」里的链接能不能打开。要 core（纯函数：`cmpCodePoints`）、
  // lib（`workspace.ts` 的 DSH_HOME）与 host（工具 body 的 `DomainAccess` 类型）。它是唯一
  // 会发网络请求的域（`node:net` / `node:tls`）——`builtin: true` 就是为它这条边的。
  // **不 import tools**：`registerStudyTool` 由注册点注入，与实验域同一个姿势。
  reach:  { allow: ['core', 'lib', 'host'], builtin: true, package: false },
  // 独立笔记数据域（#268）：只碰 Host 数据层与纯函数，不从学习工具/agent 域借写入权限。
  notes:  { allow: ['core', 'lib'], builtin: true, package: false },
  // 唯一的宿主 peer 例外：`@deepseek-ai/schemastery` 是宿主提供的可选 peer（`Config` schema），
  // 不随包发（package.json 的 peerDependenciesMeta 标 optional，tarball 里没有 node_modules）。
  // 白名单只给 bin 这一条边，别处仍然零外部包。
  bin:    { allow: ['core', 'lib', 'tools', 'tasks', 'lab', 'watch', 'export', 'ask', 'notes'], builtin: true, package: false, packages: ['@deepseek-ai/schemastery'] },
  // 旧阅读端单文件（`lib/client.js`）：只与模块加载器打交道，谁也不 import，`require` 在那里是加载器形参。
  client: { allow: [], builtin: false, package: false },
  // `client/` 的浏览器域（ADR-0015）：组件源码，由 `build:client` 打进正式包的 `dist/client.js`。
  // 它是**扫描图里的普通一员**，不是扫描之外的例外：不碰 `node:*`、不碰 `lib/**` 与 `bin/**`
  // （Host 半的代码进不了浏览器产物），外部包只许 `FRONTEND_PACKAGES` 里登记过的那几个。
  // `package: true` 只说「允许用外部包」；具体是哪些包由 `FRONTEND_PACKAGES` 逐个点名——
  // 不写进去的（esbuild、vite、node 这些构建工具）一律拒。
  'notes-client': { allow: [], builtin: false, package: true },
  // katex 域（#91）：**随包发的第三方 dist**（`lib/katex/**`：KaTeX 的 min.js / min.css /
  // woff2 字体 / LICENSE、README），不是我们的源码——它没有 import、没有导出，唯一的读者是
  // `lib/math.ts`（按路径读字节：投送给阅读端与搬进导出产物都走它）。
  // 为什么也登记成域：`lib/` 下的一级目录就是域，**新增目录一律要在这张表里登记**；给第三方
  // 字节开一个「反正扫不到东西所以不用登记」的例外，正是这条规矩最容易被绕开的口子。
  // `allow: []` 是真话：dist 谁也不 import，我们的源码也不许 import 它（那不是模块）。
  katex:  { allow: [], builtin: false, package: false },
};

/* 浏览器域（`client/`）允许 import 的外部包：**逐个点名**，不做前缀通配。
   全是同构前端库（React、CodeMirror、Markdown 渲染链、KaTeX、图标），由根 `package.json` 的
   devDependency 提供，`build:client` 时内联进 `dist/client.js`——宿主运行时因此不多一个依赖。
   新增一个前端依赖＝在这里加一条＋在 `package.json` 里加版本，两处都要。 */
const FRONTEND_PACKAGES = new Set([
  'react', 'react-dom',
  '@xyflow/react',
  '@codemirror/state', '@codemirror/view', '@codemirror/commands', '@codemirror/language',
  '@codemirror/lang-css', '@codemirror/lang-html', '@codemirror/lang-javascript',
  '@codemirror/lang-json', '@codemirror/lang-markdown', '@codemirror/lang-python',
  '@lezer/highlight',
  'katex',
  'lucide-react',
  'react-markdown',
  'rehype-highlight', 'rehype-katex',
  'remark-gfm', 'remark-math',
]);

/** 裸包名 → 包名：`react-dom/client` → `react-dom`，`@xyflow/react/dist/style.css` → `@xyflow/react`。 */
function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/* `lib/client.js` 的域是 `client` 而不是 `lib`：那是浏览器里跑的单文件，跟 Host 数据层
   （`lib/*.ts`）没有共同依赖面。`client/` 下直接躺着的文件归同一个 `client` 域（见 `domainOf`）。 */
const CLIENT_MODULE = 'lib/client.js';
/** 浏览器域的加载器外壳：转译后既没有函数也没有 import，只把 Cordis 模块形状交出去。
    它只豁免**「没有外置依赖就算被跳过」那条启发式**（见 `checkArchitecture`）；它自己的
    import 照样进图、照样按浏览器域的规则判——豁免的是「怎么判断漏扫」，不是「漏扫本身」。 */
const CLIENT_ENTRY = 'client/notes/host/client-entry.jsx';

// 扫描根：随包发货的 Node 源码 + 浏览器组件源码。`scripts/**` 是开发期工具与测试，不算域——它们
// 本来就能读任意文件、import 任意东西，拉进来只会让这张表变成噪音；真有人从 `lib/` 反向 import
// 它们，会以「落到扫描根之外」被拦下。
const SCAN_ROOTS = ['lib', 'bin', 'client'];
const MODULE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.tsx'];
/** 交给扫描器前要先过 esbuild 的 jsx/tsx loader（引号状态机认不了 JSX 的收尾标签，见文件头）。
    两边都要在：只有 `.jsx` 的话 `.tsx` 的 loader 分支是死代码，而且 `.tsx` 会绕过转译、
    以明文的收尾标签直接喂给状态机。 */
const JSX_EXTENSIONS = ['.jsx', '.tsx'];

/** 模块的域。扫到没登记的域由 `checkArchitecture` 判为**未知域**（默认拒绝），这里不兜底。 */
function domainOf(relativePath) {
  if (relativePath === CLIENT_MODULE) return 'client';
  const parts = relativePath.split('/');
  if (parts[0] === 'lib') return parts.length === 2 ? 'lib' : parts[1];
  // `client/notes/**` → `notes-client`；`client/<别的目录>/**` → 那个目录名（没登记，默认拒绝）；
  // 直接躺在 `client/` 里的文件属于 `client`（和 `lib/` 的「直接躺着的属于 `lib`」同一个口径）。
  if (parts[0] === 'client') return parts.length === 2 ? 'client' : `${parts[1]}-client`;
  return parts[0];
}

const RELATIVE_SPECIFIER = /^\.{1,2}\//;

/** 解析一整个文件的依赖。返回 `{ specifiers, dynamic }`（字段同 `importsOf`）。 */
function scanImportsFrom(relativePath, source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8')) {
  return importsOf(source);
}

/** 同一个文件、两种源：`.jsx` 是**转译后**再扫（见文件头），其余原样。反证用例靠它直接喂一段合成的 JSX 源码。 */
function scanSpecifiers(relativePath, source) {
  if (!JSX_EXTENSIONS.includes(path.extname(relativePath))) return importsOf(source);
  return importsOf(transformJsx(relativePath, source));
}

/** JSX → 平 JS：不裁剪、不压缩（行号大体对得上），只把标签语法与自动导入去掉。 */
function transformJsx(relativePath, source) {
  return transformSync(source, {
    loader: path.extname(relativePath) === '.tsx' ? 'tsx' : 'jsx',
    format: 'esm',
    jsx: 'automatic',
    minifyWhitespace: false,
    minifySyntax: false,
    minifyIdentifiers: false,
    sourcefile: relativePath,
  }).code;
}

function toRelative(absolutePath) {
  return path.relative(ROOT, absolutePath).split(path.sep).join('/');
}

/** 转译后还剩什么可扫：`function`（有函数要跟着走）或 `import`（有依赖）。两者都没有的模块
    ——纯加载器外壳就是这种——没物证也说明不了「漏扫」。 */
function hasScanTarget(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const code = JSX_EXTENSIONS.includes(path.extname(relativePath)) ? transformJsx(relativePath, source) : source;
  return /\bimport\b/.test(code) || /\bfunction\b/.test(code);
}

function walkSources(absoluteDir, found = []) {
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) { walkSources(full, found); continue; }
    if (MODULE_EXTENSIONS.includes(path.extname(entry.name))) found.push(toRelative(full));
  }
  return found;
}

const MODULE_FILES = new Set(SCAN_ROOTS.flatMap(root => walkSources(path.join(ROOT, root))));

const existsRelative = (relativePath) => fs.existsSync(path.join(ROOT, relativePath));
const isDirectory = (relativePath) => {
  try { return fs.statSync(path.join(ROOT, relativePath)).isDirectory(); } catch { return false; }
};
/** `directory` 里是不是装着扫描根（`''`（仓库根）与 `lib` 都装）：装了就说明「目录定死」不能
 *  证明目标不是源码——那种动态 import 一律算违规。 */
const containsScanRoot = (directory) => SCAN_ROOTS.some(root => {
  const relative = path.posix.relative(directory, root);
  return relative === '' || !relative.startsWith('..');
});

/* ── 源码扫描（注释与正则抹掉、字符串原样留、并记下区间）住在 ──
   `scripts/tests/fixtures/source_mask.mjs`：`test_docs_references.mjs` 也要用同一个判据
   反查注释里的路径引用，两份扫描器会在真实写法上分叉。文件头写了为什么。 */

const STATIC_IMPORT = /\bimport\s+(?:[^'";]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
const RE_EXPORT = /\bexport\s+[^'";]*?\bfrom\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*([^)]*)\)/g;
const CONST_LITERAL = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(`[^`]*`|'[^']*'|"[^"]*")\s*[;,]/g;
const REQUIRE_CALL = /\brequire\s*\(/;


/** 模板字面量里能定死的部分：洞落在最后一段（`../../schemas/${name}`）时目录是定死的。
 *  返回 `{ directory: 'schemas/', resolved: false }`；洞落在目录上就返回 null（定不死）。 */
function templatePrefix(raw) {
  const prefix = raw.split('${')[0];
  if (prefix === raw) return { fixed: raw };
  if (prefix.includes('/') && prefix.endsWith('/')) return { directory: prefix };
  return null;
}

/** 这个动态 import 的实参长什么样：报错信息要能让人直接改对。 */
function describeExpression(expression) {
  const trimmed = expression.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

/**
 * 解析一个文件的依赖说明符。返回 `{ specifiers, dynamic }`：
 *   · `specifiers`：能定死的说明符（字面量；或同一文件里 `const x = <字面量>` 间接来的；或
 *     「目录定死、只有文件名是变量」的模板——用结尾的 `*` 标出来）；
 *   · `dynamic`：定不死的动态 import（说明符由变量拼出来），由调用方判成违规。
 */
function importsOf(source) {
  const { code, literals } = maskSource(source);
  const specifiers = [];
  const dynamic = [];
  const constants = new Map();
  for (const match of code.matchAll(CONST_LITERAL)) {
    if (!constants.has(match[1])) constants.set(match[1], new Set());
    constants.get(match[1]).add(match[2].slice(1, -1));
  }
  for (const pattern of [STATIC_IMPORT, RE_EXPORT]) {
    for (const match of code.matchAll(pattern)) {
      if (!insideLiteral(literals, match.index)) specifiers.push(match[1]);
    }
  }
  const accept = (raw) => {
    const fixed = templatePrefix(raw);
    if (fixed?.fixed !== undefined) { specifiers.push(fixed.fixed); return; }
    if (fixed) { specifiers.push(`${fixed.directory}*`); return; }
    dynamic.push(describeExpression(raw));
  };
  for (const match of code.matchAll(DYNAMIC_IMPORT)) {
    if (insideLiteral(literals, match.index)) continue;
    // 丢掉 `import(spec, { with: … })` 的选项尾巴（options 里可能有 `)`，所以先截再剥）
    const argument = match[1].trim().replace(/,\s*\{[\s\S]*$/, '').trim();
    const literal = argument.match(/^['"]([^'"]+)['"]$/);
    if (literal) { specifiers.push(literal[1]); continue; }
    const template = argument.match(/^`([^`]*)`$/);
    if (template) { accept(template[1]); continue; }
    const identifier = argument.match(/^([A-Za-z_$][\w$]*)$/);
    const known = identifier ? constants.get(identifier[1]) : undefined;
    // 同名常量有多份（可能是不同的值）就定不死：宁可报错，也别挑一个碰运气
    if (known?.size === 1) { accept([...known][0]); continue; }
    dynamic.push(describeExpression(argument));
  }
  return { specifiers, dynamic };
}

/**
 * 相对说明符 → 项目内的落点。四种结局：
 *   · `module`     落在扫描根里的源码模块（图的边）；
 *   · `data`       扫描根里或根外的**非源码**文件（`.json` 这类数据）；
 *   · `directory`  目录定死、文件名算出来的动态 import；
 *   · `escape`     扫描根之外的**源码**（`scripts/foo.mjs` 这种）；
 *   · `unresolved` 盘上找不到。
 */
function resolveRelative(fromFile, specifier) {
  const fromDirectory = path.posix.dirname(fromFile);
  // 带扩展名的说明符（`./App.jsx`、`./theme-v3.css`）先按原样找：`./a.jsx` 与 `./a.jsx.jsx` 是两回事，
  // 不加这一步，浏览器域的裸扩展名会被错拼成 `.jsx.jsx` 而落到 unresolved。
  if (path.posix.extname(specifier)) {
    const exact = path.posix.normalize(path.posix.join(fromDirectory, specifier));
    if (MODULE_FILES.has(exact)) return { kind: 'module', target: exact };
    if (existsRelative(exact) && !isDirectory(exact)) {
      return MODULE_EXTENSIONS.includes(path.posix.extname(exact))
        ? { kind: 'escape', target: exact }
        : { kind: 'data', target: exact };
    }
  }
  if (specifier.endsWith('*')) {
    const directory = path.posix.normalize(path.posix.join(fromDirectory, specifier.slice(0, -1)));
    if (!isDirectory(directory) || containsScanRoot(directory)) return { kind: 'unresolved' };
    return { kind: 'directory', target: directory };
  }
  const base = path.posix.normalize(path.posix.join(fromDirectory, specifier));
  if (MODULE_FILES.has(base)) return { kind: 'module', target: base };
  for (const candidate of [base, ...MODULE_EXTENSIONS.map(extension => base + extension)]) {
    if (!existsRelative(candidate)) continue;
    if (MODULE_EXTENSIONS.includes(path.extname(candidate))) return { kind: 'escape', target: candidate };
    return { kind: 'data', target: candidate };
  }
  if (existsRelative(base) && !isDirectory(base)) return { kind: 'data', target: base };
  return { kind: 'unresolved', target: base };
}

function buildGraph() {
  const modules = [...MODULE_FILES].sort();
  const edges = [];
  const externals = [];
  const dataLoads = [];
  const opaque = [];
  const requires = [];
  for (const file of modules) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const { specifiers, dynamic } = scanSpecifiers(file, source);
    const domain = domainOf(file);
    for (const specifier of specifiers) {
      if (specifier.startsWith('node:')) { externals.push({ from: file, domain, specifier, kind: 'builtin' }); continue; }
      if (!RELATIVE_SPECIFIER.test(specifier)) { externals.push({ from: file, domain, specifier, kind: 'package' }); continue; }
      const resolved = resolveRelative(file, specifier);
      if (resolved.kind === 'module') { edges.push({ from: file, to: resolved.target, specifier }); continue; }
      dataLoads.push({ from: file, domain, specifier, ...resolved });
    }
    for (const expression of dynamic) opaque.push({ from: file, domain, expression });
    if (REQUIRE_CALL.test(source)) requires.push(file);
  }
  return { modules, edges, externals, dataLoads, opaque, requires };
}

/** 域图：只由**跨域**边构成（同域边不构成域之间的依赖）。 */
function domainGraph(edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    const from = domainOf(edge.from);
    const to = domainOf(edge.to);
    if (from === to) continue;
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from).add(to);
  }
  return adjacency;
}

/** 环检测：Tarjan 强连通分量，返回所有大小 > 1 的分量。 */
function cyclicComponents(nodes, adjacencyOf) {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let counter = 0;
  const visit = (node) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacencyOf(node)) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = [];
      let popped;
      do {
        popped = stack.pop();
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== node);
      if (component.length > 1) components.push(component);
    }
  };
  for (const node of nodes) if (!index.has(node)) visit(node);
  return components;
}

const MAX_EXAMPLES = 5;
const few = (items) => (items.length > MAX_EXAMPLES
  ? `${items.slice(0, MAX_EXAMPLES).join('、')} 等 ${items.length} 处`
  : items.join('、'));

/** 数据落点的域：只在扫描根里才有域（`lib/core/data.json` → `core`）；裸扩展名（`.css` 这类）没有域。 */
function dataDomain(target) {
  if (!/^(lib|bin|client)\//.test(target ?? '') || !path.posix.extname(target)) return null;
  return domainOf(target);
}

/**
 * 判一张 import 图。返回违规描述（空数组 = 过）。抽成纯函数是为了能拿**合成图**验这张网本身还
 * 张着（见文件末尾的反证用例）：只对着真实图断言的话，扫描器或判据哪天退化成恒真也照样绿。
 */
function checkArchitecture(graph) {
  const violations = [];
  for (const module of graph.modules) {
    const domain = domainOf(module);
    if (!Object.hasOwn(DOMAIN_RULES, domain)) {
      violations.push(`未知域 ${domain}（${module}）：新增的一级目录要在 DOMAIN_RULES 里登记允许依赖，默认拒绝`);
    }
  }
  const known = new Set(graph.modules);

  const nonEmpty = (items, tell) => { if (!items.length) violations.push(tell); };
  // 扫描器空转是最危险的退化：这些计数掉到 0 时，下面每一条判据都会「全部通过」。所以先把图里的
  // 已知域与已知边钉住——扫描器瞎了，这里先红，而不是让越权悄悄溜过去。
  // （手搭的合成图只看「越权有没有被抓到」，不跑这一组；它们由真实图那几条用例管。）
  if (!graph.synthetic) {
    nonEmpty(graph.modules.filter(module => domainOf(module) === 'core'), '扫描器空转：core 域一个模块都没扫到');
    nonEmpty(graph.modules.filter(module => domainOf(module) === 'notes-client'), '扫描器空转：notes-client 域一个模块都没扫到（client/ 没进图？）');
    nonEmpty(graph.edges, '扫描器空转：一条内部 import 边都没扫到');
    const pairs = new Set(graph.edges.map(edge => `${domainOf(edge.from)} → ${domainOf(edge.to)}`));
    for (const pair of ['core → core', 'lib → core', 'notes-client → notes-client']) {
      if (!pairs.has(pair)) violations.push(`扫描器空转：跨文件边 ${pair} 没扫到（要么真的没了，要么扫描器漏了说明符）`);
    }
  }

  const illegal = [];
  for (const edge of graph.edges) {
    if (!known.has(edge.to)) {
      violations.push(`边指向不存在于图里的文件：${edge.from} → ${edge.to}（扫描器或解析逻辑有问题）`);
      continue;
    }
    const from = domainOf(edge.from);
    const to = domainOf(edge.to);
    if (to === from) continue;
    if (!DOMAIN_RULES[from]?.allow.includes(to)) illegal.push(`${edge.from} → ${edge.to}`);
  }
  if (illegal.length) violations.push(`越界的跨域 import（允许的域见 DOMAIN_RULES）：${few(illegal)}`);

  // 纯函数域单独报一条：`allow: []` 已经能挡住，但这条的措辞直接对应「目录即域」的说法
  const impure = graph.edges
    .filter(edge => domainOf(edge.from) === 'core' && !edge.to.startsWith('lib/core/'))
    .map(edge => `${edge.from} → ${edge.to}`);
  if (impure.length) violations.push(`lib/core/** 是纯函数域，只能 import lib/core/** 里的模块：${few(impure)}`);

  // 浏览器域单独报一条：它进得了同一份 bundle，但 Host 半的代码进不了浏览器。
  const toHostCode = graph.edges
    .filter(edge => domainOf(edge.from) === 'notes-client' && /^(lib|bin)\//.test(edge.to))
    .map(edge => `${edge.from} → ${edge.to}`);
  if (toHostCode.length) violations.push(`浏览器域（notes-client）不许 import lib/** 或 bin/** 里的 Host 代码：${few(toHostCode)}`);

  const forbiddenBuiltin = graph.externals.filter(use => use.kind === 'builtin' && !DOMAIN_RULES[use.domain]?.builtin);
  if (forbiddenBuiltin.length) {
    violations.push(`这些域不许 import node:*：${few(forbiddenBuiltin.map(use => `${use.from} → ${use.specifier}`))}`);
  }
  const forbiddenPackage = graph.externals.filter(use => use.kind === 'package'
    && !DOMAIN_RULES[use.domain]?.package
    && !(DOMAIN_RULES[use.domain]?.packages ?? []).includes(use.specifier));
  if (forbiddenPackage.length) {
    violations.push(`这些域不许 import 外部包（本包零自带运行时依赖；宿主 peer 白名单见 DOMAIN_RULES.packages）：${few(forbiddenPackage.map(use => `${use.from} → ${use.specifier}`))}`);
  }
  // 允许用外部包的域，也只在**逐个点名**的清单里放行：构建工具（esbuild / vite / node 自带名）不在清单里。
  const unregisteredPackage = graph.externals
    .filter(use => use.kind === 'package' && use.domain === 'notes-client' && !FRONTEND_PACKAGES.has(packageName(use.specifier)))
    .map(use => `${use.from} → ${use.specifier}`);
  if (unregisteredPackage.length) {
    violations.push(`浏览器域只许用登记过的前端包（见 FRONTEND_PACKAGES；构建工具 esbuild / vite / node 不在其中）：${few(unregisteredPackage)}`);
  }

  // JSX/TSX 走 esbuild 才进得了图；扫描器若把它整类跳过，JSX 里的越权就没人管。所以每个 JSX 模块
  // 只要转译后**还有东西可扫**（有 import，或有函数要跟着走），就必须在 `graph` 里留下扫描的物证，
  // 否则算扫描器漏扫。
  // `client/notes/host/client-entry.jsx` 是唯一豁免：它是纯加载器外壳，转译后既没有函数也没有
  // import，**什么都没得扫**，拿它当「漏扫嫌疑」只会产生噪音。这个豁免**只作用于本条启发式**——
  // 它的 import 一条也没被跳过：只要它哪天写了 import，那些 import 照常进图、照常按浏览器域判
  // （反证见「client-entry 的豁免只管跳过判据」）。 */
  const scanned = new Set([...graph.externals.map(use => use.from), ...graph.edges.map(edge => edge.from)]);
  const suspicious = graph.synthetic
    ? []
    : graph.modules.filter(module => JSX_EXTENSIONS.includes(path.extname(module))
      && module !== CLIENT_ENTRY
      && !scanned.has(module)
      && hasScanTarget(module));
  if (suspicious.length) {
    violations.push(`JSX 模块没有进扫描（esbuild 转译漏了？不许整类跳过）：${few(suspicious)}`);
  }

  const escaped = graph.dataLoads.filter(load => load.kind === 'escape' || load.kind === 'unresolved');
  if (escaped.length) {
    violations.push(`相对 import 落到扫描根（lib/、bin/、client/）之外的源码上或解析不到：${few(escaped.map(load => `${load.from} → ${load.specifier}`))}`);
  }
  const crossData = graph.dataLoads
    .filter(load => load.kind === 'data')
    .map(load => ({ ...load, targetDomain: dataDomain(load.target) }))
    .filter(load => load.targetDomain && load.targetDomain !== load.domain && !DOMAIN_RULES[load.domain]?.allow.includes(load.targetDomain))
    .map(load => `${load.from} → ${load.target}`);
  if (crossData.length) violations.push(`跨域读了别的域的数据文件：${few(crossData)}`);

  /* 定不死的动态 import 一律算违规：`await import(变量)` 能把任何模块拉进来，而静态图看不见它。
     出路有三条——写成字面量说明符；让那个常量在同一文件里由字面量初始化（扫描器认这一层）；
     或者「目录定死、只有文件名是变量」的模板（扫描器能验出目录不在扫描根里，见 resolveRelative）。 */
  if (graph.opaque.length) {
    violations.push(`动态 import 的说明符定不死（改成字面量，或让常量由字面量初始化）：${few(graph.opaque.map(use => `${use.from} → ${use.expression}`))}`);
  }

  const strayRequire = graph.requires.filter(file => domainOf(file) !== 'client');
  if (strayRequire.length) {
    violations.push(`require(...) 不在这张图的扫描范围里，只许出现在 lib/client.js（那里的 require 是加载器形参）：${few(strayRequire)}`);
  }

  for (const component of cyclicComponents(graph.modules, node => graph.edges.filter(edge => edge.from === node).map(edge => edge.to))) {
    violations.push(`模块级依赖成环：${component.sort().join(' → ')}`);
  }
  const adjacency = domainGraph(graph.edges);
  for (const component of cyclicComponents([...adjacency.keys()], node => [...(adjacency.get(node) ?? [])])) {
    violations.push(`域依赖成环：${component.sort().join(' → ')}`);
  }
  return violations;
}

const GRAPH = buildGraph();

test('架构边界：真实 import 图无违规', () => {
  const domains = [...new Set(GRAPH.modules.map(domainOf))].sort();
  const crossDomain = GRAPH.edges.filter(edge => domainOf(edge.from) !== domainOf(edge.to));
  const builtins = GRAPH.externals.filter(use => use.kind === 'builtin').length;
  const packages = GRAPH.externals.filter(use => use.kind === 'package').length;
  const computedNames = GRAPH.dataLoads.filter(load => load.kind === 'directory');
  console.log(`架构边界：${GRAPH.modules.length} 个模块 / 扫到 ${domains.length} 个域（${domains.join('、')}）`
    + ` / 规则表登记 ${Object.keys(DOMAIN_RULES).length} 个域 / ${GRAPH.edges.length} 条内部边（跨域 ${crossDomain.length} 条）`
    + ` / node:* ${builtins} 处 / 外部包 ${packages} 个 / 目录定死文件名算出来的动态 import ${computedNames.length} 条`
    + `（${computedNames.map(load => `${load.from} → ${load.specifier}`).join('、') || '无'}）`);
  assert.deepEqual(checkArchitecture(GRAPH), []);
});

test('扫描不是空转：已知的域与跨域边都在图里', () => {
  const domains = new Set(GRAPH.modules.map(domainOf));
  for (const domain of ['core', 'lib', 'host', 'tools', 'bin', 'client', 'notes-client']) {
    assert.ok(domains.has(domain), `域 ${domain} 一个模块都没扫到：扫描器瞎了，还是它真的不见了？`);
  }
  const pairs = new Set(GRAPH.edges.map(edge => `${domainOf(edge.from)} → ${domainOf(edge.to)}`));
  for (const pair of ['core → core', 'lib → core', 'host → lib', 'tools → core', 'tools → host', 'bin → lib', 'bin → tools', 'notes-client → notes-client']) {
    assert.ok(pairs.has(pair), `跨域边 ${pair} 没扫到：要么真的没了，要么扫描器漏了说明符`);
  }
  // 浏览器域的两种源码都要真的进图：`.jsx` 与 `.js` 各至少一个，否则「JSX 被整类跳过」在这条上看不出来
  for (const extension of ['.jsx', '.js']) {
    assert.ok(GRAPH.modules.some(module => module.startsWith('client/notes/') && module.endsWith(extension)),
      `client/notes 下一个 ${extension} 模块都没扫到：扫描器的扩展名清单漏了它`);
  }
  // 低水位线：只用来证明文件遍历没瞎，不是精确清单（精确清单就是扫描结果本身）
  assert.ok(GRAPH.modules.length >= 20, `只扫到 ${GRAPH.modules.length} 个模块，太少了`);
});

test('纯函数域：lib/core/** 不 import 任何 node:*，也不 import 域外东西', () => {
  const coreModules = GRAPH.modules.filter(module => domainOf(module) === 'core');
  assert.ok(coreModules.length > 0);
  for (const module of coreModules) {
    const outside = GRAPH.edges.filter(edge => edge.from === module && !edge.to.startsWith('lib/core/'));
    assert.deepEqual(outside, [], `${module} import 了 lib/core/** 之外的东西`);
    assert.deepEqual(GRAPH.externals.filter(use => use.from === module), [], `${module} import 了外部依赖`);
  }
});

test('扫描器认得出三种语法，且不把字符串/注释里的示例当依赖', () => {
  const source = [
    "import a from './a.ts';",
    "export type { B } from './b.ts';",
    'const specifier = `../../schemas/${name}`;',
    'const loaded = await import(specifier, { with: { type: "json" } });',
    "import('./c.ts');",
    "// import d from './d.ts';",
    "const doc = \"import e from './e.ts'\";",
  ].join('\n');
  const { specifiers, dynamic } = importsOf(source);
  assert.deepEqual(specifiers.sort(), ['../../schemas/*', './a.ts', './b.ts', './c.ts']);
  assert.deepEqual(dynamic, []);
});

test('扫描器认得出模板套模板与带引号的正则（两个真实踩过的坑）', () => {
  // `bin/openai-skill-compat.mjs` 里就长这样：外层模板的洞里又有一个模板
  const nested = "const escaped = `${script.replace(/<[^>]+>/g, value => `'${value}'`)}`;\nimport x from './x.ts';";
  assert.deepEqual(importsOf(nested).specifiers, ['./x.ts']);
  // `lib/core/format.ts` 里就长这样：正则里带引号
  const quoted = "const q = text.replace(/\"/g, '&quot;');\nimport y from './y.ts';";
  assert.deepEqual(importsOf(quoted).specifiers, ['./y.ts']);
  // 除号不能被当成正则起点（`a / b / c` 后面还得能扫出 import）
  assert.deepEqual(importsOf('const r = a / b / c;\nimport z from "./z.ts";').specifiers, ['./z.ts']);
});

test('扫描器不接定不死的动态 import（那是静态图上的洞）', () => {
  const { dynamic } = importsOf("const target = process.env.X;\nawait import(target);");
  assert.equal(dynamic.length, 1);
  const graph = synthetic(['lib/core/a.ts'], [], {
    opaque: [{ from: 'lib/core/a.ts', domain: 'core', expression: 'target' }],
  });
  assert.match(checkArchitecture(graph).join('\n'), /动态 import 的说明符定不死/);
});

test('扫描器在每个真实文件上都给出有序、不重叠的字符串区间', () => {
  for (const module of GRAPH.modules) {
    const source = fs.readFileSync(path.join(ROOT, module), 'utf8');
    // JSX 先转译再扫（与 buildGraph 同一个入口），否则这里的「区间」与图里的「区间」不是同一份东西
    const scanned = JSX_EXTENSIONS.includes(path.extname(module)) ? transformJsx(module, source) : source;
    const { code, literals } = maskSource(scanned);
    assert.equal(code.length, scanned.length, `${module}：抹注释后长度变了，位置就对不上了`);
    assert.ok(literals.length > 0, `${module} 一个字符串都没扫到，状态机可疑`);
    let previous = -1;
    for (const [from, to] of literals) {
      assert.ok(from >= previous && from < to, `${module}:${from} 的字符串区间重叠或乱序`);
      previous = to;
    }
    /* 把区间整段挖空后不该再剩引号：剩下的每一对引号都该被某个区间解释掉。状态机漏了（模板里套
       模板、正则里的引号…）这里就会冒出来——比逐条比对更早、更直接地暴露问题。 */
    const outside = [...code];
    for (const [from, to] of literals) for (let index = from; index < to; index += 1) outside[index] = ' ';
    assert.doesNotMatch(outside.join(''), /['"`]/, `${module}：还有引号落在字符串区间之外，状态机漏了`);
  }
});

/* ── 反证：拿合成图验这张网本身 ──────────────────────────────────────────────
   只断言「真实图无违规」的话，扫描器或判据哪天退化成恒真也照样绿。下面五条用手搭的图把每条规则
   反向钉住：图里**故意**放违规，判据必须抓出来。 */
function synthetic(modules, edges, extra = {}) {
  return { modules, edges, externals: [], dataLoads: [], requires: [], opaque: [], synthetic: true, ...extra };
}

test('反证：越界的跨域 import 会被抓出来', () => {
  const graph = synthetic(
    ['lib/core/a.ts', 'lib/tools/b.ts'],
    [{ from: 'lib/core/a.ts', to: 'lib/tools/b.ts', specifier: '../tools/b.ts' }],
  );
  const violations = checkArchitecture(graph).join('\n');
  assert.match(violations, /越界的跨域 import/);
  assert.match(violations, /lib\/core\/a\.ts → lib\/tools\/b\.ts/);
});

test('反证：未知的一级目录（新域）默认拒绝', () => {
  assert.match(checkArchitecture(synthetic(['lib/未登记的域/a.ts'], [])).join('\n'), /未知域 未登记的域/);
});

test('反证：域图成环会被抓出来', () => {
  const graph = synthetic(
    ['lib/core/a.ts', 'lib/b.ts'],
    [
      { from: 'lib/core/a.ts', to: 'lib/b.ts', specifier: '../b.ts' },
      { from: 'lib/b.ts', to: 'lib/core/a.ts', specifier: './core/a.ts' },
    ],
  );
  assert.match(checkArchitecture(graph).join('\n'), /域依赖成环/);
});

test('反证：模块级成环会被抓出来', () => {
  const graph = synthetic(
    ['lib/core/a.ts', 'lib/core/b.ts'],
    [
      { from: 'lib/core/a.ts', to: 'lib/core/b.ts', specifier: './b.ts' },
      { from: 'lib/core/b.ts', to: 'lib/core/a.ts', specifier: './a.ts' },
    ],
  );
  assert.match(checkArchitecture(graph).join('\n'), /模块级依赖成环/);
});

test('外部包白名单：只有登记过的宿主 peer 能过，其他包仍然拒绝', () => {
  const allowed = synthetic(['bin/a.ts'], [], {
    externals: [{ from: 'bin/a.ts', domain: 'bin', specifier: '@deepseek-ai/schemastery', kind: 'package' }],
  });
  assert.deepEqual(checkArchitecture(allowed), []);
  const denied = synthetic(['bin/a.ts'], [], {
    externals: [{ from: 'bin/a.ts', domain: 'bin', specifier: 'lodash', kind: 'package' }],
  });
  assert.match(checkArchitecture(denied).join('\n'), /不许 import 外部包/);
});

test('反证：node:*、外部包、扫描根之外的源码、散落的 require 都会被拦下', () => {
  const graph = synthetic(['lib/core/a.ts'], [], {
    externals: [
      { from: 'lib/core/a.ts', domain: 'core', specifier: 'node:fs', kind: 'builtin' },
      { from: 'lib/core/a.ts', domain: 'core', specifier: 'lodash', kind: 'package' },
    ],
    dataLoads: [
      { from: 'lib/core/a.ts', domain: 'core', specifier: '../../../scripts/x.mjs', kind: 'escape', target: 'scripts/x.mjs' },
      { from: 'lib/core/a.ts', domain: 'core', specifier: './nowhere.ts', kind: 'unresolved', target: 'lib/core/nowhere.ts' },
    ],
    requires: ['lib/core/a.ts'],
  });
  const violations = checkArchitecture(graph).join('\n');
  assert.match(violations, /不许 import node:\*/);
  assert.match(violations, /不许 import 外部包/);
  assert.match(violations, /落到扫描根/);
  assert.match(violations, /require\(\.\.\.\) 不在这张图的扫描范围里/);
});

test('反证：跨域读别人的数据文件也会被拦下', () => {
  const graph = synthetic(['lib/core/a.ts'], [], {
    dataLoads: [{ from: 'lib/core/a.ts', domain: 'core', specifier: '../tools/挂件.json', kind: 'data', target: 'lib/tools/挂件.json' }],
  });
  assert.match(checkArchitecture(graph).join('\n'), /跨域读了别的域的数据文件/);
});

/* ── 浏览器域（client/）的反证 ────────────────────────────────────────────────
   浏览器域刚进图，最怕的是「登记了但没真的管」：下面把每一种越权各钉一条，包括**扫描器层面**的
   ——用一段真的 JSX 源码走完整的 `scanSpecifiers` + `buildGraph` 路径，证明确实转译了、确实抓到了。 */
const BROWSER_MODULE = 'client/notes/App.jsx';

/** 把一段合成源码当成 `client/notes/**` 里的文件，跑「解析说明符 → 建图 → 判据」整条路。 */
function graphOfSource(relativePath, source) {
  const { specifiers, dynamic } = scanSpecifiers(relativePath, source);
  const domain = domainOf(relativePath);
  const graph = synthetic([relativePath], [], { opaque: dynamic.map(expression => ({ from: relativePath, domain, expression })) });
  const root = relativePath.split('/')[0];
  for (const specifier of specifiers) {
    if (specifier.startsWith('node:')) { graph.externals.push({ from: relativePath, domain, specifier, kind: 'builtin' }); continue; }
    if (!RELATIVE_SPECIFIER.test(specifier)) { graph.externals.push({ from: relativePath, domain, specifier, kind: 'package' }); continue; }
    const resolved = resolveRelative(relativePath, specifier);
    if (resolved.kind === 'module') graph.edges.push({ from: relativePath, to: resolved.target, specifier });
    else graph.dataLoads.push({ from: relativePath, domain, specifier, ...resolved });
  }
  assert.ok(root === 'client', '这个反证只喂 client/ 下的文件');
  return graph;
}

test('反证：未登记的 client 子域默认拒绝，已登记的 notes-client 放行', () => {
  const unknown = checkArchitecture(synthetic(['client/未登记的域/a.jsx'], [])).join('\n');
  assert.match(unknown, /未知域 未登记的域-client/);
  assert.deepEqual(checkArchitecture(synthetic(['client/notes/a.jsx'], [])), []);
  // 直接躺在 `client/` 里的文件归 `client` 域（已登记的旧阅读端那一格），不另开新域
  assert.equal(domainOf('client/x.js'), 'client');
  assert.equal(domainOf('client/notes/host/bridge.jsx'), 'notes-client');
});

test('反证：浏览器域 import lib/** 或 bin/** 的 Host 代码会被拦下', () => {
  const violations = checkArchitecture(graphOfSource(BROWSER_MODULE, "import { readLibrary } from '../../lib/library.ts';")).join('\n');
  assert.match(violations, /浏览器域（notes-client）不许 import lib\/\*\* 或 bin\/\*\*/);
  // 同一条边也会以「越界 import」出现：allow 里没有 lib，所以不管 Host 模块在不在图里都挡得住
  const crossDomain = synthetic(
    ['client/notes/App.jsx', 'lib/library.ts'],
    [{ from: 'client/notes/App.jsx', to: 'lib/library.ts', specifier: '../../lib/library.ts' }],
  );
  const full = checkArchitecture(crossDomain).join('\n');
  assert.match(full, /越界的跨域 import/);
  assert.match(full, /client\/notes\/App\.jsx → lib\/library\.ts/);
});

test('反证：浏览器域 import node:* 会被拦下（就在 JSX 源码里）', () => {
  const source = [
    "import fs from 'node:fs';",
    'export const View = () => (<div className="a">hello</div>);',
  ].join('\n');
  const violations = checkArchitecture(graphOfSource(BROWSER_MODULE, source)).join('\n');
  assert.match(violations, /这些域不许 import node:\*/);
  assert.match(violations, /client\/notes\/App\.jsx → node:fs/);
});

test('反证：浏览器域 import 构建工具（esbuild）会被拦下，登记过的 React 与 CodeMirror 放行', () => {
  const rejected = checkArchitecture(graphOfSource(BROWSER_MODULE, "import { transformSync } from 'esbuild';")).join('\n');
  assert.match(rejected, /浏览器域只许用登记过的前端包/);
  const allowed = graphOfSource(BROWSER_MODULE, [
    "import React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { EditorView } from '@codemirror/view';",
    "import '@xyflow/react/dist/style.css';",
    'export const View = () => (<div className="a">{React.version}</div>);',
  ].join('\n'));
  assert.deepEqual(checkArchitecture(allowed), []);
});

test('JSX 必须真的进图：转译后 JSX 里的 import 一个不漏，且没有被整类跳过', () => {
  /* 这段的来源是一句真 JSX：`source_mask` 的引号状态机过不了收尾标签，不转译就可能把后面的
     import 整段当字符串吞掉。这里同时钉两件事：不转译就读不出 JSX 属性里的引号，转译后两条
     import 都在，其中 `node:*` 那条被拦下。 */
  const source = [
    'const Title = ({ text }) => (<h2 title="don\'t">it\'s {text}</h2>);',
    "import fs from 'node:fs';",
    "import React from 'react';",
    'export default () => (<section><Title text="a & b" /></section>);',
  ].join('\n');
  assert.deepEqual(importsOf(source).specifiers, [], '不转译时状态机把收尾标签之后的 import 吞掉了——这正是 esbuild 存在的原因');
  // 自动运行时会补一条 `react/jsx-runtime`：`FRONTEND_PACKAGES` 按包名登记，所以它算在 `react` 名下
  assert.deepEqual(scanSpecifiers(BROWSER_MODULE, source).specifiers.sort(), ['node:fs', 'react', 'react/jsx-runtime']);
  assert.ok(FRONTEND_PACKAGES.has(packageName('react/jsx-runtime')));
  const violations = checkArchitecture(graphOfSource(BROWSER_MODULE, source)).join('\n');
  assert.match(violations, /不许 import node:\*/);
  assert.doesNotMatch(violations, /不许 import 外部包/, 'React 是登记过的前端包，不该被拦');

  // 真的文件：`.jsx` 与 `.js` 都进了图，而且 JSX 文件的外置依赖与相对 import 真的被扫出来
  assert.ok(GRAPH.modules.includes('client/notes/App.jsx'), 'client/notes/App.jsx 没进图');
  assert.ok(GRAPH.modules.includes('client/notes/imports.js'), 'client/notes/imports.js 没进图');
  const appExternals = GRAPH.externals.filter(use => use.from === 'client/notes/App.jsx').map(use => use.specifier);
  for (const specifier of ['react', '@xyflow/react', 'lucide-react']) {
    assert.ok(appExternals.includes(specifier), `client/notes/App.jsx 的 ${specifier} 没扫到：JSX 被跳过了？`);
  }
  assert.ok(GRAPH.edges.some(edge => edge.from === 'client/notes/App.jsx' && edge.to === 'client/notes/CanvasNodes.jsx'),
    'client/notes/App.jsx → CanvasNodes.jsx 没扫到：JSX 的相对 import 丢了');
});

test('反证：.tsx 里的 TS 类型 + JSX 不会被状态机吞掉，后置的 node:fs import 照样抓得到', () => {
  /* TS 类型标注（泛型、`as const`、`JSX.Element`）+ JSX + **写在末尾**的 import ——三样叠在一起，
     正是「只登记 .jsx 不登记 .tsx」会漏掉的那种文件。`import type` 那行的引号与类型标注会打乱
     `maskSource` 的引号状态机，末尾那条 `node:fs` 可能被当成字符串的一部分；而且 `.tsx` 不过
     loader 的话，`<Chip>` 与泛型箭头函数 `(item: T)` 都会让状态机更没把握。 */
  const TSX_MODULE = 'client/notes/Strict.tsx';
  const source = [
    "import type { ReactNode } from 'react';",
    "import React from 'react';",
    'type Props = { label: string; children?: ReactNode };',
    "const DEFAULTS = { size: 'md', wide: false } as const;",
    'function Chip({ label, children }: Props) {',
    '  return (<span title="don\'t break">{label}: {children ?? null}</span>);',
    '}',
    'export const pick = <T,>(items: T[], index: number): T => items[index];',
    'export const small = (): JSX.Element => (<Chip label="a & b">x</Chip>);',
    "import fs from 'node:fs';",
    'export const probe = () => fs.existsSync(DEFAULTS.size);',
  ].join('\n');
  assert.deepEqual(scanSpecifiers(TSX_MODULE, source).specifiers.filter(s => s === 'node:fs'), ['node:fs']);
  // `.tsx` 真的按 tsx loader 转译：类型标注与泛型被消掉，JSX 落成运行时代码
  const code = transformJsx(TSX_MODULE, source);
  assert.doesNotMatch(code, /ReactNode|\btype Props\b|JSX\.Element|as const/, 'tsx loader 没生效（TS 语法还在）');
  assert.match(code, /react\/jsx-runtime/);
  assert.doesNotMatch(code, /<Chip/, 'JSX 没被转译（.tsx 走了 jsx loader 以外的东西）');
  // 真的走完整条路：建图 → 判据 → 浏览器域必须拦下
  const violations = checkArchitecture(graphOfSource(TSX_MODULE, source)).join('\n');
  assert.match(violations, /不许 import node:\*/);
  assert.match(violations, /client\/notes\/Strict\.tsx → node:fs/);

  // 当前没有 TSX 文件也必须登记两层入口；未来增加合法 TSX 不应让这条回归失败。
  assert.ok(MODULE_EXTENSIONS.includes('.tsx'), 'TSX 文件未纳入文件扫描入口');
  assert.ok(JSX_EXTENSIONS.includes('.tsx'), 'TSX 未经过转译扫描入口');
});

test('client-entry 的豁免只管跳过判据：它自己的 node import 照样进图、照样被拦', () => {
  /* 入口外壳转译后既没有函数也没有 import，所以它不被「没有物证就算跳过」那条启发式当嫌疑对象。
     但豁免**不许**延伸到它的 import：把一条 `node:fs` 塞进去，扫描器读得到、判据照样拦。 */
  const shell = [
    "import fs from 'node:fs';",
    'export const name = "studymate-client";',
    'export const apply = () => {};',
  ].join('\n');
  // 合成图：externals 里那条就是 `graphOfSource` 从源码里扫出来的（不是手搭的假边）
  const graph = graphOfSource(CLIENT_ENTRY, shell);
  assert.deepEqual(graph.externals.map(use => `${use.from} → ${use.specifier} (${use.kind})`),
    [`${CLIENT_ENTRY} → node:fs (builtin)`], '入口外壳里的 import 没进图：豁免越界了');
  const violations = checkArchitecture(graph).join('\n');
  assert.match(violations, /不许 import node:\*/);
  assert.match(violations, new RegExp(`${CLIENT_ENTRY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} → node:fs`));

  // 豁免覆盖的只有「没物证」那一条：外壳保持干净时它不触发「JSX 模块没有进扫描」，
  // 而同一张图里**另一个**没有物证的 JSX 文件照样会被点名。
  const cleanShell = graphOfSource(CLIENT_ENTRY, 'export const name = "studymate-client";\nexport const apply = () => {};');
  assert.doesNotMatch(checkArchitecture(cleanShell).join('\n'), /JSX 模块没有进扫描/);
  // 真文件就是那个干净的外壳：它在图里、没有任何外置依赖（所以豁免是必要的，不是掩盖问题）
  assert.ok(GRAPH.modules.includes(CLIENT_ENTRY), `${CLIENT_ENTRY} 没进图`);
  assert.deepEqual(GRAPH.externals.filter(use => use.from === CLIENT_ENTRY), []);
});

test('域规则表自洽：键是域、allow 指向已登记的域、每个域都表了态', () => {
  for (const [domain, rule] of Object.entries(DOMAIN_RULES)) {
    assert.match(domain, /^[a-z][\w-]*$/, `域名 ${domain} 不像域`);
    for (const allowed of rule.allow) {
      assert.ok(Object.hasOwn(DOMAIN_RULES, allowed), `${domain} 允许依赖未登记的域 ${allowed}`);
    }
    assert.equal(typeof rule.builtin, 'boolean', `${domain} 没表态能不能用 node:*`);
    assert.equal(typeof rule.package, 'boolean', `${domain} 没表态能不能用外部包`);
    assert.ok(!rule.allow.includes(domain), `${domain} 的 allow 里不必写自己（同域恒允许）`);
  }
  assert.deepEqual(DOMAIN_RULES.core.allow, [], '纯函数域不许有跨域依赖');
});
