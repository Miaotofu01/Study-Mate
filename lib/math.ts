/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 公式排版的离线资源（Host 数据层）

   这里是**随包发的 KaTeX dist**（`lib/katex/**`）的唯一一份清单与取址判据。三处读它，
   谁都不许自己拼第二份路径：

     · `lib/math-route.ts` —— Host 半把字节投送给阅读端（`/api/studymate/math/…`）；
     · `lib/export/plan.ts` —— 导出时把同一批字节搬进产物（JS 走 vendor 包装壳、CSS/字体落
       `assets/katex/`）；
     · `scripts/tests/test_host_math_route.mjs` —— 拿盘上的 dist 与 `lib/katex/README.md`
       说的形状对账（CSS 里的 `url(fonts/…)` ↔ 盘上的 `fonts/*.woff2` 双向对账）。

   为什么在包里（而不是像 React 那样从机器解析）：`docs/规范/课件内容格式.md` §3 写的是
   「排版由**阅读端自带的离线 KaTeX** 在浏览器里完成，不联网、无 CDN」——「自带」就是这个
   意思。从机器解析的后果是「一台只装了 StudyMate 的机器上公式全退化成 TeX 原文」，与规格
   直接冲突（#91 的勘察与决定记在 ticket 里）。

   为什么读盘口要自己带边界判据：这条口子把包里的文件递给浏览器，`rel` 是从 URL 里来的。
   判据不做第二份——用 `lib/paths.ts` 那一对（文本判据 + 解掉符号链接之后的真实路径判据）。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isWithin, isWithinReal, realPathOf } from './paths.ts';

/** 阅读端拼资源地址用的前缀。`lib/client.js` 的 `MATH_ENDPOINT` 必须与它逐字一致。 */
export const MATH_ENDPOINT = '/api/studymate/math';

/** 排版引擎与它的样式表（dist 里的两个固定名字）。 */
export const MATH_JS = 'katex.min.js';
export const MATH_CSS = 'katex.min.css';

/** 字体目录：CSS 里的 `url(fonts/…)` 相对**样式表自己的 URL** 解析，所以这个相对位置是契约。 */
export const MATH_FONT_DIR = 'fonts';

/**
 * 随包发的 KaTeX 版本。`katex.min.js` 自己也报这个版本（`katex.version`），套件拿两边对账
 * ——改 dist 忘了改这里会红，而不是悄悄发一份对不上的东西出去。
 */
export const KATEX_VERSION = '0.18.7';

/** 只投送这三种：引擎、样式表、字体。其余（LICENSE / README）给人看，不投送。 */
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** 往导出产物里一起走的那一份许可证（MIT 要求随副本分发）。 */
export const LICENSE_FILE = 'LICENSE';

export interface MathAsset {
  /** 相对 dist 目录的 POSIX 路径，例如 `fonts/KaTeX_Main-Regular.woff2`。 */
  rel: string;
  /** 盘上的绝对路径。 */
  file: string;
  bytes: number;
  /** 精确 MIME。**别复用 `lib/assets.ts` 的 `contentTypeOf()`**：它只认图片，
      `.js/.css/.woff2` 会被它兜成 `application/octet-stream`（现在侥幸能跑，一旦哪天上
      `X-Content-Type-Options: nosniff` 就断，属于埋雷）。 */
  contentType: string;
}

/** dist 目录的绝对路径（`lib/` 旁边那一份，不依赖进程的工作目录）。 */
export function katexDistDir(): string {
  return fileURLToPath(new URL('./katex/', import.meta.url));
}

/**
 * 把 dist 里的相对路径解成一个可读的绝对路径；越界、不存在、不是文件、不是那三类可投送的
 * 文件都返回 null。
 *
 * 每次请求现解一遍（与配图路由同一条口径：不落盘索引、不加缓存）。
 */
export function mathAssetFile(rel: unknown, dir = katexDistDir()): string | null {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || rel.includes('\0')) return null;
  if (!Object.hasOwn(TYPES, path.extname(rel).toLowerCase())) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, rel);
  if (!isWithin(root, full)) return null;
  // 文本判据挡不住符号链接：解掉链接后还得落在 dist 里，否则这就是一条读包内任意文件的口子
  if (!isWithinReal(realPathOf(root), full)) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return full;
}

/**
 * 要投送的那些文件（引擎、样式表、字体），路径排序稳定。
 *
 * dist 不在时返回空数组而不是抛：这是一种「包坏了」的状态，路由那一侧警告一句、阅读端照旧
 * 降级成 TeX 原文——比让整个插件加载不上好。
 */
export function mathAssets(dir = katexDistDir()): MathAsset[] {
  const found: string[] = [];
  const walk = (absolute: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) { walk(path.join(absolute, entry.name), rel); continue; }
      if (entry.isFile() && Object.hasOwn(TYPES, path.extname(entry.name).toLowerCase())) found.push(rel);
    }
  };
  walk(path.resolve(dir), '');
  const assets: MathAsset[] = [];
  for (const rel of found) {
    const file = mathAssetFile(rel, dir);
    if (!file) continue;
    assets.push({ rel, file, bytes: fs.statSync(file).size, contentType: TYPES[path.extname(rel).toLowerCase()] });
  }
  return assets;
}

/** 投送地址：`/api/studymate/math/<dist 内相对路径>`（精确路由，注册时逐条给）。 */
export function mathAssetPath(rel: string): string {
  return `${MATH_ENDPOINT}/${rel}`;
}

/* ── 「这段文本里有数学式吗」：导出按需携带资源的判据（#96） ──────────────────
   两个问题要分开答，因为阅读端对这两类文本的处理本来就不同：

     · **正文**（Markdown）：代码围栏与行内代码里的 `$` 不是公式（`lib/core/format.ts`
       的解析器与 `lib/client.js` 的 `parseBlocks` 都不当公式），先把代码剔掉再找；
     · **纯文本字段**（题库的题面／选项／解析／参考答案／判分要点，以及 `objective` /
       `goal` 这种会被 `inlineNodes` 过一遍的字段）：没有代码语义，整串找。

   两条正则与阅读端同一形状（`lib/client.js` 的 `INLINE` / `MATH_ONLY`：`$…$` 行内、
   `$$…$$` 块级），正文那条还刻意放宽了换行（见下）。**宁可多带不可少带**：这里比阅读端
   只多不少（比如粗体里的 `$…$` 阅读端不排版、这里算数），分叉时的方向只能是「带了但没用上」
   ——反过来「该带没带」会让页面降级成 TeX 原文，那是禁止的方向。 */

const MATH_EXPRESSION = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$/;

/**
 * 正文用的那一条：行内式**允许跨行**。
 *
 * 为什么与纯文本字段不同：阅读端把段落的多行拼成一行之后再切行内标记（`lib/client.js` 的
 * `parseBlocks` 里 `para.join(' ')`，格式规范也要求公式本身不跨行）。所以 `$x +` 换行 `y$`
 * 这种写法在页面里**是会排版**的；如果这里按「不许换行」判，导出就会少带引擎、页面降级成
 * TeX 原文——那正是本票禁止的失败方向。放宽的代价是「两个美元号各在一段」也会算成有数学式，
 * 属于允许的「带了没用上」。
 */
const MATH_EXPRESSION_PROSE = /\$\$[\s\S]+?\$\$|\$[^$]+\$/;

/**
 * 纯文本字段里有没有数学式（题库那种）。
 * 判据与 `lib/client.js` 的 `MATH_ONLY` 同一个：`$…$` 行内、`$$…$$` 块级。
 */
export function hasMathExpression(text: unknown): boolean {
  return typeof text === 'string' && MATH_EXPRESSION.test(text);
}

/**
 * 正文（Markdown）里有没有数学式：剔掉代码围栏与行内代码之后再判。
 *
 * 剔代码的口径照 `lib/client.js` 的 `parseBlocks`：` ``` `（可带语言）开、` ``` ` 收；
 * 行内代码是 `` `…` ``。**有意的偏差**：没收尾的围栏在阅读端会一路吃到结尾，这里
 * 只把认得出配对的那几段剔掉（剩下照扫）——宁可多认几个 `$`，也不能反过来漏掉。
 */
export function hasMathInProse(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const kept: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^```\w*\s*$/.test(line)) { fenced = !fenced; kept.push(''); continue; }
    kept.push(fenced ? '' : line);
  }
  return MATH_EXPRESSION_PROSE.test(kept.join('\n').replace(/`[^`\n]*`/g, ' '));
}

