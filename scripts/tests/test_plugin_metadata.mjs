/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 插件页元信息（图标 / locale 标题简介 / 详情文档）

   插件页上的四样东西都有**不出声的失败形态**，所以逐条钉成断言：

     · `package.json.icon` —— 宿主只认包内相对路径、SVG/PNG/JPEG/WebP、原始 ≤ 256 KiB；
       写错只记一条 `meta.error`，页面退回默认画布（用户看不出「没生效」）；
     · `locale/en.json` —— 宿主读标题/简介的字典从 **en** 起步（`dsh-app-boot` 的
       `readPluginMeta` → `dictionariesOf(englishPath)`）；只加 `zh.json` 时中文标题不会生效，
       插件列表里显示的是包名 `@yunmiao/studymate`；
     · `locale/<语言>.json` 的 `meta.detail`（**可选**）—— 有就校验路径与目标文档；没有时宿主回退包
       README（DSH Desktop 按显示语言选 `README.zh.md` / `README.en.md`，再回退 `README.md`）。
       本仓库两份都**不写**，与 dsh-win-pwsh7 同一条；
     · `locale/` 没随包发出去 —— 宿主静默退回 README / 包名，本地看一切正常，装完「改完像没改」。

   判据照宿主实现写：`@deepseek-ai/dsh-package-manifest` 的 `icon` 字段、
   `dsh-app-boot` 的 `readPluginMeta` / `iconOf`、`dsh-plugin-detail` 的 `detailPath` 与
   `readPackageDocument`。反证与正对照都要有，别把判据写成恒真。
   ───────────────────────────────────────────────────────────────────────── */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const LOCALE_DIR = path.join(ROOT, 'locale');
const IMAGE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);
const ICON_TYPES = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp']);
const MAX_ICON_BYTES = 256 * 1024;
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

/** `locale/` 下每一份语言声明，按文件名排序（`en.json` → `en`）。 */
function localeFiles() {
  if (!fs.existsSync(LOCALE_DIR)) return [];
  return fs.readdirSync(LOCALE_DIR).filter(name => name.endsWith('.json')).sort();
}

function readLocale(name) {
  return JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, name), 'utf8'));
}

/** 宿主对 `meta.detail` 的判据：一条不合格就返回那句原因，合格返回 null。 */
export function detailPathProblem(value) {
  if (typeof value !== 'string' || value.trim() === '') return '必须是非空字符串';
  if (value.includes('\\')) return '不能用反斜杠';
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)) return '不能是 URL';
  if (value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return '不能有空段 / . / ..';
  if (!/\.(?:md|markdown)$/iu.test(value)) return '必须以 .md 或 .markdown 结尾';
  if (!fs.existsSync(path.join(ROOT, value))) return `指向的文件不在包里：${value}`;
  return null;
}

/** 宿主对 `package.json.icon` 的路径判据（不查文件内容，便于反证）。 */
export function iconPathProblem(value) {
  if (typeof value !== 'string' || value.trim() === '') return '必须是非空字符串';
  if (value.includes('\\')) return '不能用反斜杠';
  if (path.isAbsolute(value) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)) return '必须是相对路径';
  if (!ICON_TYPES.has(path.extname(value).toLowerCase())) return '必须是 SVG / PNG / JPEG / WebP';
  const resolved = path.resolve(ROOT, value);
  const realRoot = fs.realpathSync(ROOT);
  const relative = path.relative(realRoot, fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '出了包根';
  if (!fs.existsSync(resolved)) return `文件不在包里：${value}`;
  if (!fs.statSync(resolved).isFile()) return '必须是普通文件';
  if (fs.statSync(resolved).size > MAX_ICON_BYTES) return '超过 256 KiB';
  return null;
}

/** 一个仓库内相对路径是否会被 `package.json` 的 `files` 打进 tarball。 */
function ships(relative) {
  const patternToRegExp = pattern => new RegExp(`^${pattern
    .split('**').map(part => part.split('*').map(chunk => chunk.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*')).join('.*')}$`, 'u');
  return MANIFEST.files.some(pattern => patternToRegExp(pattern).test(relative));
}

/* ── 图标 ─────────────────────────────────────────────────────────────── */

test('图标：package.json.icon 过宿主的路径/类型/大小判据，且真的随包发出去', () => {
  const problem = iconPathProblem(MANIFEST.icon);
  assert.equal(problem, null, `package.json.icon 不合宿主判据：${problem}`);
  assert.equal(ships(MANIFEST.icon), true,
    `files 没有覆盖 ${MANIFEST.icon}：发出去的包里没有图标，插件列表静默退回默认画布`);
  // 反证：宿主会拒的形状这里也必须拒，别把判据写成恒真。
  for (const bad of ['/abs/icon.png', '../icon.png', 'https://example.com/icon.png',
    'docs\\icon.png', 'docs/images/icon.gif', 'docs/images/icon.txt', '']) {
    assert.notEqual(iconPathProblem(bad), null, `这条判据放过了宿主会拒的形状：${JSON.stringify(bad)}`);
  }
  // 正对照：盘上真有的那一份必须放行，否则上面那几条只是在拒绝一切。
  assert.ok(iconPathProblem('docs/images/logo.png') === null);
});

test('图标：不超过宿主 256 KiB 的上限（原图能过，派生图更轻）', () => {
  assert.ok(fs.statSync(path.join(ROOT, MANIFEST.icon)).size <= MAX_ICON_BYTES);
});

/* ── locale：标题 / 简介 / 详情文档 ───────────────────────────────────── */

test('locale：en + zh 都在，且宿主要从 en.json 起字典（只加 zh 时中文标题不生效）', () => {
  const files = localeFiles();
  assert.deepEqual(files, ['en.json', 'zh.json'],
    `locale/ 下应当恰好是中英两份语言声明，实际：${files.join('、') || '空'}——宿主会把目录里每个 .json 都当成语言文件`);
  for (const name of files) {
    const language = name.slice(0, -5);
    assert.match(language, LANGUAGE_ID, `locale/${name} 的文件名不是合法语言 id`);
    const { meta } = readLocale(name);
    assert.equal(typeof meta?.title, 'string', `locale/${name} 缺 meta.title`);
    assert.ok(meta.title.trim() !== '', `locale/${name} 的 meta.title 是空串`);
    assert.equal(typeof meta?.description, 'string', `locale/${name} 缺 meta.description`);
    assert.ok(meta.description.trim() !== '', `locale/${name} 的 meta.description 是空串`);
  }
});

test('locale：meta.detail 是可选项——中英都不写，正文交给宿主的 README 规则', () => {
  // 与 dsh-win-pwsh7 同一条：DSH Desktop 的 dsh-plugin-detail 在没有 meta.detail 时按显示语言选
  // README（zh 先找 README.zh.md 等，其余先找 README.en.md，再回退 README.md）。本仓库正好有
  // README.md（中文）与 README.en.md（英文），所以标题/简介之外什么都不用声明。
  assert.equal(readLocale('zh.json').meta?.detail, undefined, 'zh.json 不该写 meta.detail：中文正文由 README.md 提供');
  assert.equal(readLocale('en.json').meta?.detail, undefined, 'en.json 不该写 meta.detail：英文正文由 README.en.md 提供');
  const problems = [];
  for (const name of localeFiles()) {
    const { meta } = readLocale(name);
    if (meta?.detail === undefined) continue;
    const problem = detailPathProblem(meta.detail);
    if (problem !== null) problems.push(`locale/${name}：meta.detail ${problem}`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('locale：locale 文件、详情文档、图标与导出都随包发出去', () => {
  assert.equal(ships('locale/en.json'), true,
    'package.json 的 files 里没有覆盖 locale/*.json：装完的副本里没有它，标题退回包名、详情退回 README');
  assert.equal(ships('locale/zh.json'), true);
  assert.equal(MANIFEST.exports['./locale/*.json'], './locale/*.json',
    'exports 里没有 ./locale/*.json：宿主走模块解析器读 meta.title，不暴露就退回包名');
  for (const name of localeFiles()) {
    const { meta } = readLocale(name);
    if (meta?.detail === undefined) continue;
    assert.equal(ships(meta.detail), true,
      `files 里没有覆盖 ${meta.detail}：发布出去的包里没有这份文档，详情页静默退回 README`);
  }
});

test('详情页：文档里的图片都画得出来——相对文档、在包根之内、类型白名单、随包发', () => {
  for (const name of localeFiles()) {
    const { meta } = readLocale(name);
    if (meta?.detail === undefined) continue;
    const docFile = path.join(ROOT, meta.detail);
    const text = fs.readFileSync(docFile, 'utf8');
    const directory = path.dirname(docFile);
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
      const target = match[1].split('#')[0].split('?')[0];
      assert.equal(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target), false,
        `${meta.detail} 里的图用了外链：${target}——详情页按包内文件投送，外链不受这条链路管`);
      const resolved = path.resolve(directory, target);
      const relative = path.relative(ROOT, resolved).split(path.sep).join('/');
      assert.equal(relative.startsWith('..'), false, `${meta.detail} 里的图跑出了包根：${target}`);
      assert.equal(fs.existsSync(resolved), true, `${meta.detail} 里的图不在盘上：${target}`);
      assert.equal(IMAGE_TYPES.has(path.extname(resolved).toLowerCase()), true,
        `${meta.detail} 里的图类型不在宿主白名单里：${target}`);
      assert.equal(ships(relative), true, `${meta.detail} 里的图不随包发出去：${relative}`);
    }
  }
});

test('详情页：反证——宿主会拒的形状这里也必须拒，且正对照放行', () => {
  for (const bad of ['/abs/明细.md', '../外面.md', 'docs//空段.md', 'docs\\反斜杠.md', 'https://example.com/x.md',
    'docs/不是markdown.txt', 'docs/使用/不存在.md', '']) {
    assert.notEqual(detailPathProblem(bad), null, `这条判据放过了宿主会拒的形状：${JSON.stringify(bad)}`);
  }
  for (const name of localeFiles()) {
    const { meta } = readLocale(name);
    if (meta?.detail === undefined) continue;
    assert.equal(detailPathProblem(meta.detail), null);
  }
  // 中文故意没有 detail：宿主会回退 README.md（维护者的选择），这条不是漏写。
  assert.equal(readLocale('zh.json').meta.detail, undefined);
});
