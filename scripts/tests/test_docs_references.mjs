/* 文档悬空引用检查：README 与 `docs/**` 里的相对链接、行内代码里的仓库路径，**以及随包发货的
   源码注释里的仓库路径**，指向不存在的文件就报出来。
   ────────────────────────────────────────────────────────────────────────
   为什么要有这一条：#83 拆掉了 Python 引擎、`templates/assets/`、三个页面模板与 `examples/`，
   而文档与注释是最后一批会「留在原地指着已删文件」的东西。人眼扫一遍不够——几百个链接与路径
   引用里漏一个，学生照着文档做就会撞上一个不存在的文件。判据全在盘上：链接的目标、代码里的
   路径都按真实文件系统验。

   为什么注释也要扫：同一次拆除把 `lib/*.mjs` 改名成了 `.ts`，而源码注释里到处是
   「与 `lib/library.mjs` 同一判据」这种句子——只扫 Markdown 的话，同一类缺陷在 `lib/` 里
   整片漏网。注释比文档更贴代码，也更容易被顺手改回去，所以它同样要有一条会失败的检查。

   三类引用分别扫：
     · **Markdown 链接**：`[文字](目标)`。外部地址（http/https/mailto）、页内锚点（`#…`）、
       以及 `docs/agents/**` 之外的绝对 URL 一律跳过；相对目标按「相对本文档」与「相对仓库根」
       两种写法各试一次——两种都是本仓库在用的写法。
     · **Markdown 行内代码里的路径**：`` `lib/tools/index.ts` `` 这种。
     · **源码注释里的路径**：`lib/**`、`bin/**` 里 `` `lib/library.ts` `` 这种。**只认注释**：
       代码与字符串里的同形文字不是引用（正则、模板、UI 文案里都可能出现），所以先用
       `fixtures/source_mask.mjs` 那份共用的状态机把注释区间取出来，再只看区间里的反引号。

   两类路径都只认「看起来是仓库里的路径」的那些：带 `/` 或已知后缀、不含占位符与通配符、
   不是 `~/`、`/`、`<root>/` 这类工作区或宿主路径。判不出来的（表格里的 `NNNN-<节点id>.md`、
   `.learning/subjects/` 之类）跳过，宁可少报也不误报——误报会逼着人往检查里加例外，
   例外一多这条检查就废了。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { maskSource, insideComment } from './fixtures/source_mask.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/* 显式例外：**历史文档**。这三份写的是重构前的系统（那时的脚本、模板与示例），
   按设计就"指不到"今天的文件——它们已经在开头写明自己是历史、不要据此实现。
   例外写在这里而不是让检查放宽：放宽会把真正该修的悬空引用一起放过去。 */
const HISTORICAL = new Set([
  'docs/设计/设计方案.md',
  'docs/设计/重构评估.md',
  'docs/设计/VitePress工作区.md',
]);

/** 检查范围：面向使用者的入口文档与全部 `docs/**`（历史文档除外，见上）。 */
function documents() {
  const found = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md'];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const relative = path.relative(ROOT, full).split(path.sep).join('/');
      if (!HISTORICAL.has(relative)) found.push(relative);
    }
  };
  walk(path.join(ROOT, 'docs'));
  return found.sort();
}

/** 目标存在吗：文件或目录都算；两种相对写法（本文档所在目录、仓库根）各试一次。 */
function resolves(docFile, target) {
  const clean = target.split('#')[0].split('?')[0].replace(/:\d+(?:-\d+)?$/, '');
  if (clean === '') return true; // 纯锚点
  const candidates = [
    path.resolve(path.dirname(path.join(ROOT, docFile)), clean),
    path.resolve(ROOT, clean),
  ];
  if (path.isAbsolute(clean)) candidates.unshift(clean); // 绝对路径也当一条候选
  return candidates.some(candidate => fs.existsSync(candidate));
}

/** 不算仓库内引用的目标：外链、协议、锚点、以及明确写的是工作区/宿主里的路径。 */
function isExternal(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)
    || target.startsWith('<')          // <root>/… 这类占位路径
    || target.startsWith('~')
    || target.startsWith('$')
    || target.startsWith('mailto:');
}

/** 围栏块里的内容是示例（目录树、命令样例），不当作对仓库文件的引用。 */
function withoutFences(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '');
}

/** 行内代码里的路径：只认那些「看着就是仓库里的文件」的。 */
function looksLikeRepoPath(text) {
  if (text === '' || text.includes(' ') || text.includes('\t')) return false;
  if (/[<>{}*…]/.test(text)) return false;          // 占位符与通配符
  if (/^[A-Za-z]:[\\/]/.test(text)) return false;   // Windows 绝对路径
  if (text.startsWith('/') || text.startsWith('~')) return false;
  if (text.startsWith('.learning/') || text.startsWith('workspace/')) return false;
  if (text.startsWith('dist/') || text.startsWith('.preview/') || text.startsWith('.stage/')) return false;
  // 必须有「像个路径」的样子：
  //   · 带斜杠的，首段要是仓库里真实存在的一级目录（`lib/…`、`docs/…`）；
  //   · 不带斜杠的，**必须在仓库根真实存在**——`curriculum.yaml`、`SKILL.md` 这类是工作区里
  //     的文件名，不是仓库里的路径；不这样收口，检查会被一堆普通文件名淹掉。
  if (!text.includes('/')) return fs.existsSync(path.join(ROOT, text));
  const head = text.split('/')[0].replace(/^\.\//, '');
  if (head === '' || head === '.' || head === '..') return false;
  return fs.existsSync(path.join(ROOT, head)) || head === 'docs' || head === 'scripts' || head === 'lib';
}

/** 行内代码里的候选：去掉句读尾巴，再判它像不像仓库路径。判不出就返回 null。 */
function repoPathCandidate(raw) {
  const candidate = raw.trim().replace(/[，。；：、）)]+$/, '');
  return looksLikeRepoPath(candidate) ? candidate : null;
}

/* ── 源码注释里的路径引用 ────────────────────────────────────────────────
   扫描根与架构边界测试同源（`lib/`、`bin/`）：随包发货的 Node 源码。`lib/client.js` 也在里面
   ——它是零构建原样发货的阅读端本体，注释同样会指着已改名的文件。 */
const SOURCE_ROOTS = ['lib', 'bin'];
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

function sourceFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!SOURCE_EXTENSIONS.includes(path.extname(entry.name))) continue;
      found.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  };
  for (const root of SOURCE_ROOTS) walk(path.join(ROOT, root));
  return found.sort();
}

/** 一份源码里注释提到的仓库路径：`{ file, target }`（重复的只留一条）。 */
function commentPathReferences(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const { comments } = maskSource(text);
  const found = [];
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    if (!insideComment(comments, match.index)) continue;  // 代码与字符串里的同形文字不算引用
    const candidate = repoPathCandidate(match[1]);
    if (candidate === null) continue;
    found.push({ file, target: candidate });
  }
  return found;
}

test('README 与 docs/** 里的相对链接都指得到真实文件', () => {
  const broken = [];
  for (const docFile of documents()) {
    const text = withoutFences(fs.readFileSync(path.join(ROOT, docFile), 'utf8'));
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1];
      if (isExternal(target)) continue;
      // 只认「像路径」的目标：`[文字](链接)`、`[文字](url)` 是写法示例，不是引用。
      if (!target.includes('/') && !target.includes('.')) continue;
      if (!resolves(docFile, target)) broken.push(`${docFile} → ${target}`);
    }
  }
  assert.deepEqual(broken, [], `文档里的相对链接指向不存在的文件：\n${broken.join('\n')}`);
});

test('README 与 docs/** 行内代码里的仓库路径都真实存在', () => {
  const broken = [];
  for (const docFile of documents()) {
    const text = fs.readFileSync(path.join(ROOT, docFile), 'utf8');
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      const candidate = repoPathCandidate(match[1]);
      if (candidate === null) continue;
      if (!resolves(docFile, candidate)) broken.push(`${docFile} → ${candidate}`);
    }
  }
  assert.deepEqual(broken, [], `文档里提到了不存在的仓库路径：\n${broken.join('\n')}`);
});

test('lib/**、bin/** 注释里的仓库路径都真实存在', () => {
  const broken = [];
  for (const file of sourceFiles()) {
    for (const { target } of commentPathReferences(file)) {
      if (!resolves(file, target)) broken.push(`${file} → ${target}`);
    }
  }
  assert.deepEqual(broken, [], `源码注释里提到了不存在的仓库路径（改名或删文件之后留在原地的那种）：\n${broken.join('\n')}`);
});

test('检查自身不空转：范围里确实有文档，且真的抓到过引用', () => {
  const files = documents();
  assert.ok(files.includes('README.md'));
  assert.ok(files.filter(name => name.startsWith('docs/使用/')).length >= 3, 'docs/使用/ 下的文档要在范围里');
  let links = 0;
  for (const docFile of files) {
    links += [...fs.readFileSync(path.join(ROOT, docFile), 'utf8').matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
      .filter(match => !isExternal(match[1])).length;
  }
  assert.ok(links > 20, `只扫到 ${links} 条相对链接，检查可能已经失效`);
});

test('检查自身不空转：源码注释里的路径引用真的被扫到了', () => {
  const files = sourceFiles();
  assert.ok(files.includes('lib/client.js'), '阅读端本体要在扫描范围里');
  assert.ok(files.length >= 60, `只扫到 ${files.length} 份源码，范围可疑`);
  const references = files.flatMap(commentPathReferences);
  assert.ok(references.length >= 30, `注释里只扫到 ${references.length} 条仓库路径引用，判据可能已经失效`);
  // 反证：同一段文字放在**代码**里就不该被当成引用（区间判据不是恒真）
  const inCode = 'const 说明 = `lib/不存在的文件.ts`;\n';
  const { comments } = maskSource(inCode);
  assert.deepEqual(comments, [], '纯代码里不该有注释区间');
});
