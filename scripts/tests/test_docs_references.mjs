/* 文档悬空引用检查：README 与 `docs/**` 里的相对链接、行内代码里的仓库路径，指向不存在的
   文件就报出来。
   ────────────────────────────────────────────────────────────────────────
   为什么要有这一条：#83 拆掉了 Python 引擎、`templates/assets/`、三个页面模板与 `examples/`，
   而文档是最后一批会「留在原地指着已删文件」的东西。人眼扫一遍不够——几百个链接与路径引用里
   漏一个，学生照着文档做就会撞上一个不存在的文件。判据全在盘上：链接的目标、代码里的路径都
   按真实文件系统验。

   两类引用分别扫：
     · **Markdown 链接**：`[文字](目标)`。外部地址（http/https/mailto）、页内锚点（`#…`）、
       以及 `docs/agents/**` 之外的绝对 URL 一律跳过；相对目标按「相对本文档」与「相对仓库根」
       两种写法各试一次——两种都是本仓库在用的写法。
     · **行内代码里的路径**：`` `lib/tools/index.ts` `` 这种。只认「看起来是仓库里的路径」的
       那些：带 `/` 或已知后缀、不含占位符与通配符、不是 `~/`、`/`、`<root>/` 这类工作区或
       宿主路径。判不出来的（表格里的 `NNNN-<节点id>.md`、`.learning/subjects/` 之类）跳过，
       宁可少报也不误报——误报会逼着人往检查里加例外，例外一多这条检查就废了。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
  const clean = target.split('#')[0].split('?')[0];
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
      const candidate = match[1].trim();
      if (!looksLikeRepoPath(candidate)) continue;
      const target = candidate.replace(/[，。；：、）)]+$/, '');
      if (!resolves(docFile, target)) broken.push(`${docFile} → ${target}`);
    }
  }
  assert.deepEqual(broken, [], `文档里提到了不存在的仓库路径：\n${broken.join('\n')}`);
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
