/* 从 `lib/client.js` 里那串内联 CSS 里读 token、算颜色与对比度。
   ────────────────────────────────────────────────────────────────────────────────
   为什么单开一个模块：对比度测试（scripts/tests/test_client_tokens.mjs）与浏览器 QA
   （scripts/tests/browser/reading_test.mjs）都要这份 CSS 与这张 token 表。
   把 CSS 手抄一份到测试里，两份立刻就会漂移——所以两边都从源码里解析。

   放在 fixtures/ 里是有意的：`scripts/release/checks.mjs` 的套件覆盖断言只 walk
   `scripts/tests/` 下的文件、遇到 `fixtures` 目录就跳过（checks.mjs 的 walk），
   所以这里是「共用支持模块」的落点，不是套件。

   宿主那边的取值不在运行时读（CI 上没有 DSH），而是 `host-theme-alias.json` 这份快照：
   它由 `scripts/tests/fixtures/host-theme-alias.json` 的 `_source` 字段记着出处，
   用 `npm run test:dsh` 那套环境变量可以就地重新推导核对（见 test_client_tokens.mjs）。
*/
import fs from 'node:fs';

/** 插件内联 CSS 的原文。`const CSS = \`…\`;` 那一串，CSS 体内没有反引号与 `${`。 */
export function extractCss(source) {
  const match = /const CSS = `([\s\S]*?)`;\n/.exec(source);
  if (!match) throw new Error('lib/client.js 里找不到 `const CSS = \\`…\\`;` —— 解析口径要跟着改');
  return match[1];
}

/** `--a: b; --c: d;` → Map。注释先去掉（值里不会有 `/*`）。 */
export function parseDeclarations(block) {
  const out = new Map();
  const clean = block.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const part of clean.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (!name.startsWith('--')) continue;
    out.set(name, part.slice(at + 1).trim());
  }
  return out;
}

/** `.smb-root { … }` 那一块里的 `--smb-*`：名字 → `{ alias, fallback }`。 */
export function parseTokenBlock(css) {
  const match = /\.smb-root\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!match) throw new Error('CSS 里找不到 .smb-root { … } 的 token 块');
  const out = new Map();
  for (const [name, value] of parseDeclarations(match[1])) {
    if (!name.startsWith('--smb-')) continue;
    const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(value);
    out.set(name, ref ? { alias: ref[1], fallback: ref[2] ? ref[2].trim() : null } : { alias: null, fallback: value });
  }
  return out;
}

/**
 * 宿主主题串（`dsh-client-ui-theme` 的 `design_platform_css_default`）→ 亮/暗两张表。
 * 只有 `body{…}` 与 `body[data-ds-dark-theme]{…}` 两块，后面的同选择器块按顺序覆盖前面的。
 */
export function parseHostTheme(source) {
  // 主题那串是文件里最长的字符串字面量，按「最长」取，比锚变量名更抗重命名
  let css = '';
  for (const match of source.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    if (match[1].length > css.length) css = match[1];
  }
  if (!css) throw new Error('宿主主题里找不到 CSS 字符串');
  css = css.replace(/\\"/g, '"').replace(/\\n/g, '\n');
  const tables = { light: new Map(), dark: new Map() };
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim();
    const table = selector.includes('data-ds-dark-theme') ? tables.dark : (selector === 'body' ? tables.light : null);
    if (!table) continue;
    for (const [name, value] of parseDeclarations(rule[2])) table.set(name, value);
  }
  return tables;
}

/* ── 颜色 ──────────────────────────────────────────────────────────────── */

const NAMED = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
};

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` / 关键字 → `{r,g,b,a}`。 */
export function parseColor(text) {
  const value = String(text).trim().toLowerCase();
  if (Object.hasOwn(NAMED, value)) return { ...NAMED[value] };
  const hex = /^#([0-9a-f]{3,8})$/.exec(value);
  if (hex) {
    const digits = hex[1];
    const wide = digits.length > 4;
    const step = wide ? 2 : 1;
    const read = (i) => parseInt(digits.slice(i * step, i * step + step), wide ? 16 : 16) * (wide ? 1 : 17);
    const channels = [read(0), read(1), read(2)];
    const alpha = digits.length === 4 || digits.length === 8 ? read(3) / 255 : 1;
    return { r: channels[0], g: channels[1], b: channels[2], a: alpha };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value);
  if (fn) {
    const parts = fn[1].split(/[,/]/).map((p) => p.trim());
    const channel = (p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    return {
      r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]),
      a: parts[3] === undefined ? 1 : (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])),
    };
  }
  return null;
}

/** 顶层逗号切分（`color-mix(in srgb, a 70%, b)` 与 `rgb(1,2,3)` 都能切对）。 */
function splitTop(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  out.push(text.slice(start).trim());
  return out;
}

const round = (n) => Math.max(0, Math.min(255, Math.round(n)));

/** sRGB 直混（与 CSS `color-mix(in srgb, …)` 一致）：按 alpha 预乘，避免半透明分量被当不透明。 */
function mixSrgb(a, b, weightA) {
  const wb = 1 - weightA;
  const alpha = a.a * weightA + b.a * wb;
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (x, y) => (x * weightA * a.a + y * wb * b.a) / alpha;
  return { r: round(ch(a.r, b.r)), g: round(ch(a.g, b.g)), b: round(ch(a.b, b.b)), a: alpha };
}

/**
 * 把一段 CSS 颜色值在给定调色板里解算成 `{r,g,b,a}`；解不出来返回 null。
 * 支持：`var(--x)`（含兜底值、链式）、十六进制、`rgb()/rgba()`、`color-mix(in srgb, …)`、关键字。
 */
export function resolve(value, palette, depth = 0) {
  if (depth > 12) return null;
  const text = String(value).trim();

  const varMatch = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(text);
  if (varMatch) {
    const named = palette instanceof Map ? palette.get(varMatch[1]) : palette[varMatch[1]];
    if (named !== undefined) return resolve(named, palette, depth + 1);
    if (varMatch[2] !== undefined) return resolve(varMatch[2], palette, depth + 1);
    return null;
  }

  if (/^color-mix\(/i.test(text)) {
    const body = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'));
    const parts = splitTop(body);
    if (parts.length < 3 || !/^in\s+srgb$/i.test(parts[0])) return null;
    const weight = (part) => {
      const at = /\s+([\d.]+)%$/.exec(part);
      return at ? { value: part.slice(0, at.index).trim(), weight: parseFloat(at[1]) / 100 } : { value: part.trim(), weight: null };
    };
    const a = weight(parts[1]);
    const b = weight(parts[2]);
    const ca = resolve(a.value, palette, depth + 1);
    const cb = resolve(b.value, palette, depth + 1);
    if (!ca || !cb) return null;
    let wa = a.weight;
    let wb = b.weight;
    if (wa === null && wb === null) return null;
    if (wa === null) wa = 1 - wb;
    if (wb === null) wb = 1 - wa;
    if (wa + wb === 0) return null;
    return mixSrgb(ca, cb, wa / (wa + wb));
  }

  return parseColor(text);
}

/** 半透明的 fg 压在 bg 上之后的实际颜色。 */
export function over(fg, bg) {
  if (!fg) return bg;
  if (fg.a >= 1) return fg;
  return {
    r: round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1,
  };
}

/** WCAG 相对亮度（sRGB → 线性 → 0.2126R + 0.7152G + 0.0722B）。 */
export function luminance(color) {
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 对比度（1–21）。两个颜色都当不透明用；要合成请先自己 `over`。 */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** 读宿主的主题源码（只有显式指路时才用得到，见 test_client_tokens.mjs 的漂移核对）。 */
export function readHostThemeFile(file) {
  return parseHostTheme(fs.readFileSync(file, 'utf8'));
}

/**
 * 扫 CSS 里所有 `color: …` 声明 → `[{ selector, value, token }]`。
 * 用途：对比度测试要**从源码**得出「哪些 token 当文字用」，而不是靠人记一张表——
 * 漏一个就等于放它一条生路。`@media` 里的规则会被并进外层选择器文本，够用。
 */
export function scanColorUsages(css) {
  const out = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim().replace(/\s+/g, ' ');
    const body = rule[2].replace(/\/\*[\s\S]*?\*\//g, '');
    for (const decl of body.split(';')) {
      const at = decl.indexOf(':');
      if (at < 0 || decl.slice(0, at).trim() !== 'color') continue;
      const value = decl.slice(at + 1).trim();
      const ref = /var\(\s*(--[\w-]+)/.exec(value);
      out.push({ selector, value, token: ref ? ref[1] : null });
    }
  }
  return out;
}
