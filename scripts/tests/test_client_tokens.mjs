/* token 纪律：解析 token 块 → 算相对亮度 → 断言每个文本 token 在每个表面上都达 WCAG AA，
   亮暗两套都测（目标态规格 §4.2、§10.3，对齐 F8）。
   ────────────────────────────────────────────────────────────────────────────────
   为什么写成测试：设计系统的约束写在注释里就会腐坏。这条会失败的测试是唯一能拦住
   「顺手把 --smb-text-4 换回 label-caption」的东西——那样亮色下只有 2.1:1，11px 的字
   基本读不出来。

   两边数据都不手抄：
     · 我们的 token 块：从 lib/client.js 的内联 CSS 里解析（scripts/tests/fixtures/client-css.mjs）；
     · 宿主的取值：scripts/tests/fixtures/host-theme-tokens.json（宿主主题的 token 快照，
       `_source` 里记着包名、版本与出处）。设了 STUDYMATE_DSH_PACKAGE 时会就地重新解析
       宿主主题与快照核对，对不上就红——这样快照不会悄悄过期。
*/
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { extractCss, parseTokenBlock, parseHostTheme, scanColorUsages, resolve, over, contrast } from './fixtures/client-css.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const CSS = extractCss(fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8'));
const TOKENS = parseTokenBlock(CSS);
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'host-theme-tokens.json'), 'utf8'));
const PALETTES = { light: new Map(Object.entries(SNAPSHOT.light)), dark: new Map(Object.entries(SNAPSHOT.dark)) };

/** WCAG AA 的正文门槛。下面会断言这些 token 都用在「正常字号」上，所以是 4.5 而不是 3.0。 */
const AA_NORMAL = 4.5;

/** 当文字用的 token（从 CSS 的 `color:` 里扫出来，再逐个归类）。 */
const TEXT_TOKENS = [
  '--smb-text',            // 主文字
  '--smb-text-2',          // 次级
  '--smb-text-3',          // 三级
  '--smb-text-4',          // 四级（最小号）
  '--smb-text-done',       // 语义色的文字档（饱和档达不到 AA，见 token 块的注释）
  '--smb-text-learning',
  '--smb-text-info',
  '--smb-text-link',
  '--smb-brand',           // 既是品牌色也是主文字色，当文字用
  '--dsw-alias-label-primary-inverted',   // 反色文字：只压在品牌填充上，单独一条断言
];

/** 当表面用的 token（CSS 里做 background 的那些）。 */
const SURFACE_TOKENS = ['--smb-bg', '--smb-panel', '--smb-raise', '--smb-fill'];

/** 把 token 名解成具体颜色；解不出来就抛，别让 null 混进对比度算式。 */
function color(name, mode) {
  const palette = PALETTES[mode];
  const spec = TOKENS.get(name);
  if (spec) {
    const value = spec.alias ? resolve(`var(${spec.alias})`, palette) : null;
    const fallback = value || (spec.fallback ? resolve(spec.fallback, palette) : null);
    if (!fallback) throw new Error(`${mode}：${name} 解不出颜色（alias=${spec.alias}）`);
    return fallback;
  }
  const direct = resolve(`var(${name})`, palette);
  if (!direct) throw new Error(`${mode}：宿主 token ${name} 不在快照里`);
  return direct;
}

/** 一个模式下的所有「表面实例」：四个表面，各自再叠一层 hover 底色。 */
function surfaces(mode) {
  const out = [];
  for (const name of SURFACE_TOKENS) {
    const base = color(name, mode);
    out.push({ name, bg: base });
    out.push({ name: name + '+hover', bg: over(color('--smb-hover', mode), base) });
  }
  return out;
}

/* ── 快照与源码的一致性 ─────────────────────────────────────────────────── */

test('token 块解析得出来：四个文本档 + 一张填充档都在', () => {
  for (const name of ['--smb-text', '--smb-text-2', '--smb-text-3', '--smb-text-4', '--smb-motion']) {
    assert.ok(TOKENS.has(name), `token 块里没有 ${name}`);
  }
  assert.ok(SNAPSHOT._source && SNAPSHOT._source.version, '宿主快照缺 _source（出处要能追溯）');
});

test('宿主快照的 token 数量与形状（亮暗两套都在）', () => {
  assert.equal(Object.keys(SNAPSHOT.light).length, Object.keys(SNAPSHOT.dark).length);
  assert.ok(Object.keys(SNAPSHOT.light).length > 100, '宿主 --dsw-* 定义点应该上百个');
  for (const name of ['--dsw-alias-bg-base', '--dsw-alias-label-primary', '--dsw-static-neutral-bluish-00']) {
    assert.ok(SNAPSHOT.light[name], `快照亮色缺 ${name}`);
    assert.ok(SNAPSHOT.dark[name], `快照暗色缺 ${name}`);
  }
});

test('CSS 里引到的每个 --dsw-alias-* 宿主都真的有定义', () => {
  // 「引一个不存在的 token」是最隐蔽的一种坏：var() 会安静地退到兜底值，
  // 亮色下常常看不出来，暗色下就成了「没填色」。--dsw-alias-fill-tertiary 就踩过这个坑。
  const referenced = new Set();
  for (const match of CSS.matchAll(/var\(\s*(--dsw-[\w-]+)/g)) referenced.add(match[1]);
  const missing = [];
  for (const name of referenced) {
    for (const mode of ['light', 'dark']) {
      if (!PALETTES[mode].has(name)) missing.push(`${name}（${mode}）`);
    }
  }
  assert.deepEqual(missing, [], `CSS 引了宿主没有定义的 token：\n  ${missing.join('\n  ')}`);
  assert.ok(referenced.size >= 20, `引到的宿主 token 只有 ${referenced.size} 个，扫漏了？`);
});

test('宿主快照没有过期（设了 STUDYMATE_DSH_PACKAGE 时才核对）', (t) => {
  const pkgRoot = process.env.STUDYMATE_DSH_PACKAGE;
  if (!pkgRoot) return t.skip('未指定 STUDYMATE_DSH_PACKAGE：跳过与真实宿主的核对');
  const themeFile = path.join(pkgRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js');
  if (!fs.existsSync(themeFile)) return t.skip(`没找到宿主主题文件：${themeFile}`);
  const live = parseHostTheme(fs.readFileSync(themeFile, 'utf8'));
  const drift = [];
  for (const mode of ['light', 'dark']) {
    for (const [name, value] of live[mode]) {
      if (SNAPSHOT[mode][name] !== value) drift.push(`${mode} ${name}: 快照 ${SNAPSHOT[mode][name]} ≠ 宿主 ${value}`);
    }
  }
  assert.deepEqual(drift, [], `宿主 token 变了，重新生成 scripts/tests/fixtures/host-theme-tokens.json：\n  ${drift.join('\n  ')}`);
});

/* ── 主断言：文本 token × 表面 ──────────────────────────────────────────── */

test('每个文本 token 在每个表面上都达 WCAG AA，亮暗两套都测', () => {
  const failures = [];
  const summary = [];
  for (const mode of ['light', 'dark']) {
    for (const token of TEXT_TOKENS) {
      if (token.startsWith('--dsw-')) continue;   // 反色文字单独一条
      const fg = color(token, mode);
      let worst = { ratio: Infinity, surface: '' };
      for (const { name: surface, bg } of surfaces(mode)) {
        const ratio = contrast(over(fg, bg), bg);
        if (ratio < worst.ratio) worst = { ratio, surface };
        if (ratio < AA_NORMAL) {
          failures.push(`${mode}：${token} 压在 ${surface} 上只有 ${ratio.toFixed(2)}:1（要 ≥ ${AA_NORMAL}:1）`);
        }
      }
      summary.push(`${mode} ${token} 最低 ${worst.ratio.toFixed(2)}:1 @${worst.surface}`);
    }
  }
  assert.deepEqual(failures, [], `对比度不达 AA：\n  ${failures.join('\n  ')}\n全部最低值：\n  ${summary.join('\n  ')}`);
});

test('反色文字压在品牌填充上达 AA（两套主题）', () => {
  for (const mode of ['light', 'dark']) {
    const fill = color('--smb-brand', mode);
    const text = color('--dsw-alias-label-primary-inverted', mode);
    const ratio = contrast(over(text, fill), fill);
    assert.ok(ratio >= AA_NORMAL,
      `${mode}：--dsw-alias-label-primary-inverted 压在 --smb-brand 填充上只有 ${ratio.toFixed(2)}:1`);
  }
});

test('这些文本档都用在「正常字号」上，所以门槛是 4.5 而不是 3.0', () => {
  // WCAG 的「大号文字」是 ≥24px（或 ≥18.66px 粗体），那一档才够用 3.0:1。
  // 这条把「我们按 4.5 要求」的前提钉住：真有 ≥24px 的用法，就得回头重新论证门槛。
  // 字号从 #89 起走 --smb-fs-* token（原来写的是字面 px），所以这里也要解 token——
  // 不解的话这条会静默变空转，那比红更糟。
  const big = [];
  for (const match of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = match[2];
    if (!/color\s*:\s*var\(--smb-(text|brand)/.test(body)) continue;
    const literal = /font-size\s*:\s*([\d.]+)px/.exec(body);
    const token = /font-size\s*:\s*var\((--smb-fs-[\w-]+)\)/.exec(body);
    const weight = /font-weight\s*:\s*([\d.]+)/.exec(body);
    let px = literal ? Number(literal[1]) : null;
    if (px === null && token) {
      const spec = TOKENS.get(token[1]);
      const value = spec && /^([\d.]+)px$/.exec(String(spec.fallback));
      if (!value) { big.push(`${match[1].trim().slice(0, 60)} → ${token[1]} 解不出 px`); continue; }
      px = Number(value[1]);
    }
    if (px === null) continue;
    const bold = weight ? Number(weight[1]) >= 700 : false;
    if (px >= 24 || (bold && px >= 18.66)) big.push(`${match[1].trim().slice(0, 60)} → ${px}px`);
  }
  assert.deepEqual(big, [], `这些地方用文本 token 排大号字，AA 门槛本可降到 3.0（要么改这条断言，要么改字号）：\n  ${big.join('\n  ')}`);
});

test('CSS 里当文字用的 token 全部在契约表里（不许有漏网的）', () => {
  const used = new Set();
  for (const { token, value, selector } of scanColorUsages(CSS)) {
    if (!token) {
      // `inherit` / 具体色值：inherit 跟着父级走（父级就是 --smb-text），具体色值不允许
      assert.ok(value === 'inherit' || /^var\(/.test(value),
        `${selector} 的 color 是写死的值：${value}——颜色只许引 token`);
      continue;
    }
    used.add(token);
  }
  const known = new Set([...TEXT_TOKENS, '--smb-hover', '--smb-line', '--smb-line-strong', '--dsw-alias-label-primary-inverted']);
  // 上面那几个已知的「虽然不是文字档，但出现在简写或特例里」的名字不该出现；真出现了就说明漏归类
  const unclassified = [...used].filter((name) => !TEXT_TOKENS.includes(name));
  assert.deepEqual(unclassified, [],
    `这些 token 当文字用，却不在 TEXT_TOKENS 里（漏一个就等于放它一条生路）：\n  ${unclassified.join('\n  ')}`);
  assert.ok(known.size > 0);
});
