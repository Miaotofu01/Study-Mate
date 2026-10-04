/* 架构边界与依赖无环断言（#69）。
   ────────────────────────────────────────────────────────────────────────
   把「谁能 import 谁」变成一条会失败的测试：**扫真实源码**解析 `import` / `export … from` /
   动态 `import()` 的说明符，得到真实 import 图，再拿下面那张域规则表去判。这里**没有手写的模块
   清单**——手写清单正是「新模块因为忘了登记而逃过」的成因，所以模块、边、环全部从源码算出来。

   三条规则（`decisions.md` §2「目录即域」是规范）：
     1. 域 = `lib/` 下的一级目录；直接躺在 `lib/` 里的文件属于域 `lib`；`lib/client.js` 单列为
        `client`（浏览器侧那个单文件，不是 Host 数据层）；`bin/` 单列为 `bin`。
        **不在 `DOMAIN_RULES` 里的一级目录就是新域，默认拒绝**——这是「新增模块逃不过」的机制。
     2. `lib/core/**` 是纯函数域：不 import 任何 `node:*`，也不 import `lib/core/**` 之外的东西。
     3. 域图与模块图都**无环**。

   图之外还有两条同类断言：CommonJS `require(...)` 不在扫描范围内（`lib/client.js` 里那个
   `require` 是浏览器模块加载器的**形参**，不是依赖声明），所以反过来钉一条「`require(` 只许出现
   在 `client` 域」；动态 `import()` 的说明符**定不死就报错而不是放过**（`await import(变量)`
   能把任何模块拉进来，而静态图看不见它）。

   想亲手复核这张网还张着（改了规则表或扫描器之后特别值得跑一遍）：
     · 越界：往 `lib/core/format.ts` 顶上临时加一行 `import fs from 'node:fs';` → 本套件必须红；
     · 成环：往 `lib/core/anchors.ts` 顶上临时加一行 `import { readLibrary } from '../library.ts';`
       （core 反向依赖 lib，域图成环）→ 本套件必须红。
   两条都验完记得删掉——它们是反证，不是代码。 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

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
  // tools 是**组合根**：#68 的注册点 `registerStudyMate` 要逐个调用各子系统自己目录里的
  // registerXxx，所以它必须 import 每个子系统（tools → tasks、tools → watch、tools → lab）。
  // 方向**只有**这一条——子系统一律不许 import tools（任务域就是把 `registerStudyTool` 当
  // 参数接过去的，正是为了不出现反向边，见 lib/tasks/tools.ts 文件头）。往后每落地一个注册进
  // 注册点的子系统（#82 的导出），这里加一个域名，别改成通配。
  tools:  { allow: ['core', 'lib', 'tasks', 'watch', 'lab'], builtin: true, package: false },  // 原生工具（#68）+ 任务（#73）+ 监听（#74）+ 实验（#77）
  tasks:  { allow: ['core', 'lib'], builtin: true, package: false },  // 任务模型（#73）
  // 实验域（#77）：判分三轨的第三轨。要 rules（题型与必备字段）、attempts（作答数据的落点）、
  // tasks（长命令走任务模型、可查可取消）。`node:child_process` 是它存在的理由。
  lab:    { allow: ['core', 'lib', 'tasks'], builtin: true, package: false },
  // 问答域（#79）：阅读端问答面板那条 HTTP 路由。只依赖纯函数域与 Host 数据层——
  // 它**不** import 工具域（能力探测的本体在 `lib/core/model.ts`，见那里的文件头），
  // 所以这里没有 tools 这条边；反过来说，往这个域里加 `tools` 就是加了一条反向边。
  ask:    { allow: ['core', 'lib'], builtin: true, package: false },
  watch:  { allow: ['core', 'lib'], builtin: true, package: false },  // 文件监听（#74）：只读工作区 + 一条 SSE 路由
  export: { allow: ['core', 'lib', 'tools', 'tasks'], builtin: true, package: false },  // 预留
  bin:    { allow: ['core', 'lib', 'tools', 'tasks', 'lab', 'watch', 'export', 'ask'], builtin: true, package: false },
  client: { allow: [], builtin: false, package: false },  // 浏览器侧单文件：只与模块加载器打交道
};

/* `lib/client.js` 的域是 `client` 而不是 `lib`：那是浏览器里跑的单文件，跟 Host 数据层
   （`lib/*.ts`）没有共同依赖面。 */
const CLIENT_MODULE = 'lib/client.js';

// 扫描根：随包发货的 Node 源码。`scripts/**` 是开发期工具与测试，不算域——它们本来就能读任意
// 文件、import 任意东西，拉进来只会让这张表变成噪音；真有人从 `lib/` 反向 import 它们，
// 会以「落到扫描根之外」被拦下。
const SCAN_ROOTS = ['lib', 'bin'];
const MODULE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** 模块的域。扫到没登记的域由 `checkArchitecture` 判为**未知域**（默认拒绝），这里不兜底。 */
function domainOf(relativePath) {
  if (relativePath === CLIENT_MODULE) return 'client';
  const parts = relativePath.split('/');
  if (parts[0] === 'lib') return parts.length === 2 ? 'lib' : parts[1];
  return parts[0];
}

function toRelative(absolutePath) {
  return path.relative(ROOT, absolutePath).split(path.sep).join('/');
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

/* ── 源码扫描：注释与正则抹掉、字符串原样留（说明符在里面），并记下字符串区间 ──
   为什么要区间：注释、字符串、模板里都可能出现 `import … from 'x'` 字样（本仓库的文档与提示语
   里就不少）。抹掉注释与正则、把落在字符串内容里的匹配丢掉，才不会把「文档里的示例」当依赖。

   三个真踩过的坑（不是理论洁癖，都是这个仓库里真实存在的写法）：
     · 模板里套模板：``value => `'${value}'` `` 嵌在另一个模板的 `${}` 里（`bin/openai-skill-compat.mjs`）。
       所以模板要按 `${}` 进出、记深度，不能见反引号就收尾。
     · 带引号的正则：`.replace(/"/g, '&quot;')`（`lib/core/format.ts`）。把正则当普通代码扫的话，
       里面的引号会把状态机带偏。所以按前导字符判正则，判到就整段抹成空格。
     · 引号在字符串内容里：靠「区间」而不是「引号计数」来判，才不会把内容里的引号当边界。 */
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
  'instanceof', 'do', 'else', 'yield', 'await']);
// 正则前面允许出现的「非值」字符：`= /re/`、`( /re/`、`, /re/`…；标识符、`)`、`]` 后面是除法。
const REGEX_LEADERS = '([{,;=:!&|?+-*%^~<>';

function maskSource(source) {
  let out = '';
  const literals = [];
  const stack = [{ kind: 'code' }];
  const top = () => stack[stack.length - 1];
  /** `/` 是正则还是除号：看已产出代码里最后一个有意义的字符/词。 */
  const regexAllowed = () => {
    const head = out.replace(/\s+$/, '');
    if (!head) return true;
    if (REGEX_LEADERS.includes(head[head.length - 1])) return true;
    const word = /[A-Za-z_$][\w$]*$/.exec(head);
    return word !== null && REGEX_KEYWORDS.has(word[0]);
  };
  let i = 0;
  while (i < source.length) {
    const frame = top();
    const char = source[i];
    const next = source[i + 1];
    if (frame.kind === 'code') {
      if (char === '/' && next === '/') { stack.push({ kind: 'line' }); out += '  '; i += 2; continue; }
      if (char === '/' && next === '*') { stack.push({ kind: 'block' }); out += '  '; i += 2; continue; }
      if (char === '/' && regexAllowed()) {
        // 正则字面量：转义与 `[…]` 字符组里的 `/` 不算收尾；撞到换行说明判错了，退回普通字符
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < source.length) {
          const inner = source[j];
          if (inner === '\\') { j += 2; continue; }
          if (inner === '\n') break;
          if (inner === '[') inClass = true;
          else if (inner === ']') inClass = false;
          else if (inner === '/' && !inClass) { closed = true; break; }
          j += 1;
        }
        if (closed) {
          let end = j + 1;
          while (end < source.length && /[a-z]/.test(source[end])) end += 1;
          out += ' '.repeat(end - i);
          i = end;
          continue;
        }
      }
      if (char === '`') { stack.push({ kind: 'template', start: i }); out += char; i += 1; continue; }
      if (char === '"' || char === "'") { stack.push({ kind: 'quote', quote: char, start: i }); out += char; i += 1; continue; }
      if (frame.hole) {
        if (char === '{') frame.depth += 1;
        else if (char === '}') {
          if (frame.depth === 0) {
            stack.pop();
            top().start = i + 1;  // 洞之后那段模板文本从 `}` 的下一格开始
            out += char; i += 1; continue;
          }
          frame.depth -= 1;
        }
      }
      out += char; i += 1; continue;
    }
    if (frame.kind === 'line') {
      out += char === '\n' ? '\n' : ' ';
      i += 1;
      if (char === '\n') stack.pop();
      continue;
    }
    if (frame.kind === 'block') {
      if (char === '*' && next === '/') { stack.pop(); out += '  '; i += 2; continue; }
      out += char === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (frame.kind === 'quote') {
      if (char === '\\') { out += char + (next ?? ''); i += 2; continue; }
      out += char; i += 1;
      if (char === frame.quote) { literals.push([frame.start, i]); stack.pop(); }
      continue;
    }
    // 模板：`${` 之前的文本是一段字面量内容，洞里的代码照常扫（所以区间不含洞）
    if (char === '\\') { out += char + (next ?? ''); i += 2; continue; }
    if (char === '`') { out += char; i += 1; literals.push([frame.start, i]); stack.pop(); continue; }
    if (char === '$' && next === '{') {
      // 洞紧跟洞时（`…${a}${b}…`）这里会是一段空内容，别记空区间
      if (frame.start < i) literals.push([frame.start, i]);
      stack.push({ kind: 'code', hole: true, depth: 0 });
      out += '${'; i += 2; continue;
    }
    out += char; i += 1;
  }
  return { code: out, literals };
}

const STATIC_IMPORT = /\bimport\s+(?:[^'";]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
const RE_EXPORT = /\bexport\s+[^'";]*?\bfrom\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*([^)]*)\)/g;
const CONST_LITERAL = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(`[^`]*`|'[^']*'|"[^"]*")\s*[;,]/g;
const REQUIRE_CALL = /\brequire\s*\(/;

const insideLiteral = (literals, index) => literals.some(([from, to]) => index >= from && index < to);

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
    const { specifiers, dynamic } = importsOf(source);
    const domain = domainOf(file);
    for (const specifier of specifiers) {
      if (specifier.startsWith('node:')) { externals.push({ from: file, domain, specifier, kind: 'builtin' }); continue; }
      if (!specifier.startsWith('.')) { externals.push({ from: file, domain, specifier, kind: 'package' }); continue; }
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

/** 数据落点的域：只在扫描根里才有域（`lib/core/data.json` → `core`）。 */
function dataDomain(target) {
  if (!/^(lib|bin)\//.test(target ?? '')) return null;
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

  const forbiddenBuiltin = graph.externals.filter(use => use.kind === 'builtin' && !DOMAIN_RULES[use.domain]?.builtin);
  if (forbiddenBuiltin.length) {
    violations.push(`这些域不许 import node:*：${few(forbiddenBuiltin.map(use => `${use.from} → ${use.specifier}`))}`);
  }
  const forbiddenPackage = graph.externals.filter(use => use.kind === 'package' && !DOMAIN_RULES[use.domain]?.package);
  if (forbiddenPackage.length) {
    violations.push(`这些域不许 import 外部包（本包零运行时依赖）：${few(forbiddenPackage.map(use => `${use.from} → ${use.specifier}`))}`);
  }

  const escaped = graph.dataLoads.filter(load => load.kind === 'escape' || load.kind === 'unresolved');
  if (escaped.length) {
    violations.push(`相对 import 落到扫描根（lib/、bin/）之外的源码上或解析不到：${few(escaped.map(load => `${load.from} → ${load.specifier}`))}`);
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
  for (const domain of ['core', 'lib', 'tools', 'bin', 'client']) {
    assert.ok(domains.has(domain), `域 ${domain} 一个模块都没扫到：扫描器瞎了，还是它真的不见了？`);
  }
  const pairs = new Set(GRAPH.edges.map(edge => `${domainOf(edge.from)} → ${domainOf(edge.to)}`));
  for (const pair of ['core → core', 'lib → core', 'tools → core', 'tools → lib', 'bin → lib', 'bin → tools']) {
    assert.ok(pairs.has(pair), `跨域边 ${pair} 没扫到：要么真的没了，要么扫描器漏了说明符`);
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
    const { code, literals } = maskSource(source);
    assert.equal(code.length, source.length, `${module}：抹注释后长度变了，位置就对不上了`);
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
  return { modules, edges, externals: [], dataLoads: [], requires: [], opaque: [], ...extra };
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
