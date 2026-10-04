/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 core —— 锚点与题库的逐字对账（四态）

   正文里 `::: quiz <层级> 锚点：<文本>` 的「锚点文本」与题库 `.quiz.json` 的键是
   两个文件之间的唯一接头（docs/规范/课件内容格式.md 第 4 节）。这份文件替掉的是
   `lib/library.mjs:191-247` 那份手写的解析 + 对账——同一份契约原来有两个实现
   （Python 一份、JS 一份），JS 那份没有测试，还带着三个洞：

     1. `library.mjs:213` 的 exact 路径用 `Map` 装「strip 过的键 → 原键」，
        **后写的覆盖先写的**：题库同时有 `" x"` 与 `"x"` 时，`锚点：x` 指向哪个
        取决于 JSON 里的键序。这里改成**列表**：≥2 个候选一律判 `ambiguous`，
        **绝不静默取第一个（也绝不取最后一个）**——issue #66 的红线。
     2. JS 侧的锚点解析**不认围栏**：`ANCHOR_RE` 是行锚定正则，围栏里的
        `::: quiz 理解 锚点：x` 会被当成真锚点。这里由 `lib/core/format.ts` 的块级
        解析产出声明（它会翻转围栏态），围栏里的 `:::` 只是代码原文。
     3. `orphan_keys` 今天**没有任何消费方**（`lib/client.js` 全文没有 `orphan`），
        Python 侧却报错退 1。这里把 `orphans` 作为**一等结论**返回（带键的行号与题数），
        并保留 `orphan_keys`（码位序的键名数组）供旧 payload 继续用。

   还有 6 处静默差异，逐条按 content-format.md §3.4 的清单定了口径：
     半角 `:`（认，与 Python 一致）、层级为空（报错，不静默丢）、层级含空格（整段当层级）、
     锚点为空（报错）、重复锚点（报错）、缩进的 `:::`（`lib/core/format.ts` 报「块级内容顶格写」）。

   本域不许 import 任何 `node:*`，也不许 import `lib/core/**` 之外的东西。
   ───────────────────────────────────────────────────────────────────────── */

import {
  FormatProblems, cmpCodePoints, parseBlocks, pyIsSpace, pyStrip,
  type LessonCtx,
} from './format.ts';

/** 四态。`stale` / `ambiguous` / `missing` 定义见 content-format.md §3.5。 */
export type AnchorResolution = 'resolved' | 'stale' | 'ambiguous' | 'missing';

/** 正文里的一条锚点声明（来自 `::: quiz` 块）。 */
export interface DeclaredAnchor {
  /** 锚点文本（已过 Python 的 strip） */
  text: string;
  /** `::: quiz` 的层级，原样 */
  level: string;
  /** 正文行号（1 起） */
  line: number;
}

/** 对账结论里的一条：四态之一 + 认领到的题库键。 */
export interface AnchorMatch {
  text: string;
  level: string;
  line: number;
  resolution: AnchorResolution;
  /** resolved/stale：长度 1；ambiguous：≥2（码位序）；missing：空 */
  keys: string[];
  /** 供界面展示的候选（另外带上行号与题数）；missing 时长度为 0 */
  candidates: { key: string; line: number; count: number }[];
}

/** 题库里没有任何题目位置引用的键。 */
export interface OrphanKey {
  key: string;
  /** 题库文件里的行号（1 起） */
  line: number;
  /** 这个键下有几道题 */
  count: number;
}

export interface AnchorReconciliation {
  anchors: AnchorMatch[];
  /** 题库里没人认领的键，按码位排序 */
  orphans: OrphanKey[];
  /** 与 `orphans` 同源，只是键名数组（旧 payload 的 `orphan_keys`） */
  orphanKeys: string[];
}

/**
 * 只取 front matter 之后的正文起点（0 起的行下标）；首行不是 `---` 就是 0。
 *
 * `parseFrontMatter` 会为「没写 front matter」报一条错——那是**内容检查**该报的。
 * 只想从一段正文里捞锚点时（阅读端读工作区里的任意 `.md`），不该因为缺 front matter
 * 把整篇的锚点一起丢掉：Python 侧的 `parse_blocks(path, lines, body_start, len(lines), …)`
 * 在同一个输入上照样能扫出锚点。所以这里给一个**不报错**的切分。
 */
export function bodyStartOf(lines: string[]): number {
  if (lines.length === 0 || pyStrip(lines[0]).replace(/^\ufeff/, '') !== '---') return 0;
  for (let index = 1; index < lines.length; index++) {
    if (pyStrip(lines[index]) === '---') return index + 1;
  }
  return 0;
}

export interface ReconcileOptions {
  /** 题库文件在报错里显示的名字 */
  poolFile: string;
  /** 题库键 → 它在题库文件里的行号（1 起）；没给就报 1 */
  poolLineOf?: (key: string) => number;
  /** 题目数不对时（值不是数组）的兜底：0 */
}

/** 一条声明锚点的正文行号；声明本身来自 `parseBlocks` 产出的 `quiz` 块。 */
export function declaredFromBlocks(
  blocks: readonly { kind?: string; name?: string; level?: string; anchor?: string; line?: number }[],
): DeclaredAnchor[] {
  const out: DeclaredAnchor[] = [];
  const walk = (list: readonly { kind?: string; name?: string }[]): void => {
    for (const block of list) {
      if (block.kind === 'directive' && block.name === 'quiz') {
        const quiz = block as { level?: string; anchor?: string; line?: number };
        out.push({ text: quiz.anchor ?? '', level: quiz.level ?? '', line: quiz.line ?? 1 });
      }
      const items = (block as { items?: { children?: { kind?: string } | null }[] }).items;
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item.children) walk([item.children]);
        }
      }
      const body = (block as { body?: { kind?: string }[] }).body;
      if (Array.isArray(body)) walk(body);
    }
  };
  walk(blocks);
  return out;
}

/**
 * 锚点 ↔ 题库键对账。
 *
 * 判定顺序（对每条声明，一次遍历）：
 *   1. `text = pyStrip(锚点文本)`（只去首尾 Python 空白类字符）；
 *   2. **精确候选** = 题库里 `pyStrip(key) === text` 的**全部**键：
 *      恰好 1 个 → `resolved`；**≥2 个 → `ambiguous`**；0 个 → 下一步；
 *   3. **归一化候选** = 题库里抹掉全部空白后相等的全部键：
 *      ≥2 个 → `ambiguous`；恰好 1 个 → `stale`；0 个 → `missing`；
 *   4. `ambiguous` 的 `keys` 按**码位**排序（与 JS 原来的 `cmpCodePoints` 输出可比）；
 *   5. `orphans` = 题库里没被任何锚点认领的键，同样按码位排序。
 *
 * 返回的四态**不是**「能不能渲染」的结论：`missing` 与 `orphans` 都是错误，
 * 但**仍要出现在返回值里**（界面要显示四态，检查器要报错）——即「收集 + 返回结构」
 * 并行，不用抛异常。有没有 `empty_reason:` 由调用方（`lib/core/lesson.ts`）决定。
 */
export function reconcileAnchors(
  declared: readonly DeclaredAnchor[],
  pool: Record<string, unknown>,
  options: ReconcileOptions,
): AnchorReconciliation {
  const poolKeys = Object.keys(pool);
  const lineOf = options.poolLineOf ?? (() => 1);
  const countOf = (key: string): number => {
    const value = pool[key];
    return Array.isArray(value) ? value.length : 0;
  };

  // 精确候选：**列表**，不是 Map——Map 会让「`" x"` 与 `"x"` 同时存在」静默变成后写覆盖先写
  const exactKeys = poolKeys.filter((key) => pyStrip(key) !== '');
  const normalized = new Map<string, string[]>();
  for (const key of poolKeys) {
    const norm = normalizeAnchor(key);
    const bucket = normalized.get(norm);
    if (bucket) bucket.push(key);
    else normalized.set(norm, [key]);
  }

  const anchors: AnchorMatch[] = [];
  const used = new Set<string>();
  for (const item of declared) {
    const text = pyStrip(item.text);
    const entry: AnchorMatch = {
      text, level: item.level, line: item.line,
      resolution: 'missing', keys: [], candidates: [],
    };
    // 精确：pyStrip(key) 与 text 逐字相等。锚点文本为空时不可能有候选
    // （题库空键 `""` 在 Python 侧也取不到——`::: quiz 锚点：` 本来就报错）。
    const exact = text === '' ? [] : exactKeys.filter((key) => pyStrip(key) === text);
    if (exact.length === 1) {
      entry.resolution = 'resolved';
      entry.keys = [...exact];
    } else if (exact.length > 1) {
      // ⚠️ 与旧 JS 的关键差别：撞键不再静默覆盖，两个都报出来让人去改题库
      entry.resolution = 'ambiguous';
      entry.keys = [...exact].sort(cmpCodePoints);
    } else {
      const candidates = normalized.get(normalizeAnchor(text)) ?? [];
      if (candidates.length > 1) {
        entry.resolution = 'ambiguous';
        entry.keys = [...candidates].sort(cmpCodePoints);
      } else if (candidates.length === 1) {
        entry.resolution = 'stale';
        entry.keys = [...candidates];
      }
    }
    entry.candidates = entry.keys.map((key) => ({
      key, line: lineOf(key), count: countOf(key),
    }));
    for (const key of entry.keys) used.add(key);
    anchors.push(entry);
  }

  const orphans: OrphanKey[] = poolKeys
    .filter((key) => !used.has(key))
    .sort(cmpCodePoints)
    .map((key) => ({ key, line: lineOf(key), count: countOf(key) }));

  return { anchors, orphans, orphanKeys: orphans.map((item) => item.key) };
}

/** 归一化只抹掉空白与全角空格——用来区分「逐字一致」与「只差空白」。 */
export function normalizeAnchor(text: string): string {
  let out = '';
  for (const char of String(text)) {
    if (!pyIsSpace(char)) out += char;
  }
  return out;
}

/**
 * 从题库 JSON 的**原文**里取每个键的行号。
 *
 * 为什么不用 Python 那边的 `line_of(text, needle)`：那是**文本搜索**，实测会把题面里
 * 恰好等于键名的文字当成键的位置（报第 4 行，键其实在第 7 行）。这里扫 JSON 原文，
 * 只在**对象键的位置**（`{` 或 `,` 之后、字符串、再冒号）记行号，所以给的是真行号。
 *
 * 键在 JSON 里可能出现多次（字符串值里也有同名文本），同一个键取**第一次作为键**的位置；
 * 找不到的键回 1（与 Python 的兜底一致）。
 */
export function poolKeyLines(raw: string): Map<string, number> {
  const lines = new Map<string, number>();
  let line = 1;
  let index = 0;
  let inString = false;
  let escaped = false;
  let afterOpen = true;          // `{` 或 `,` 之后（允许空白），可能是键
  let stringStart = -1;
  let stringLine = 1;
  let expectColon = false;       // 刚读完一个字符串，且它在键的位置上
  while (index < raw.length) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        if (expectColon) {
          const key = decodeJsonString(raw.slice(stringStart, index + 1));
          if (key !== null && !lines.has(key)) lines.set(key, stringLine);
        }
      }
      if (char === '\n') line += 1;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      stringStart = index;
      stringLine = line;
      expectColon = afterOpen;
      index += 1;
      continue;
    }
    if (char === '\n') line += 1;
    if (char === '{' || char === ',') { afterOpen = true; expectColon = false; index += 1; continue; }
    if (char === ':' || char === '[') { afterOpen = false; expectColon = false; index += 1; continue; }
    if (!/\s/.test(char)) { afterOpen = false; expectColon = false; }
    index += 1;
  }
  return lines;
}

/** JSON 字符串字面量（含引号）→ 解码后的值；解不出回 null。 */
function decodeJsonString(literal: string): string | null {
  try {
    const value = JSON.parse(literal);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * 从一段内容文件的**正文**里捞出 `::: quiz` 声明。
 *
 * 与 `parseLesson` 的差异只有两点，都是给「读工作区里的任意 `.md`」这个用途准备的：
 *
 * 1. **缺 front matter 不算错**（`bodyStartOf`），整篇照扫——否则一份没写 front matter
 *    的课件会在阅读端静默丢掉全部锚点；
 * 2. 只回声明，不回错误（格式对不对是内容检查的事，阅读端只负责显示四态）。
 *
 * 块级解析走 `lib/core/format.ts` 的 `parseBlocks`，所以**围栏里的 `:::` 不是锚点**
 * ——旧实现的行锚定正则不认围栏，围栏里写一句 `::: quiz 理解 锚点：x` 就会凭空多出一个锚点。
 */
export function parseAnchors(markdown: string): DeclaredAnchor[] {
  const lines = String(markdown).split('\n');
  const ctx: LessonCtx = {
    file: '',
    problems: new FormatProblems(),
    math: { value: false },
    figureNo: { value: 0 },
  };
  const { blocks } = parseBlocks(lines, bodyStartOf(lines), lines.length, ctx);
  return declaredFromBlocks(blocks as unknown as { kind?: string }[]);
}
