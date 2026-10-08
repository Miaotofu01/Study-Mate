/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 —— 「资源清单」的分节

   一句话：给一份 `RESOURCES.md` 的正文，把它按 `##` 切成小节，报出每节的标题行、
   行号范围与**条目数**，并给出**指纹的输入文本**。不碰盘、不发请求、不算哈希
   （哈希要 `node:crypto`，那是调用方的事）。

   为什么要有这一层：交接门禁与核验工具都要**按节**说话——门禁报「每节几条、指纹是什么」，
   核验工具报「这份指纹核过没有」。两边必须对同一段文本算同一个指纹，否则「改了一节、
   只有那一节要重核」就不成立；所以分节与指纹输入只在这里定义一次。

   为什么「条目」= 顶格的 `-` 列表项：模板里每条资源就是一个顶格列表项，它下面缩进的
   「一行说明」或嵌套列表是那一条的展开，不是新的一条。代码块里的 `-` 不算（那是示例文本）。

   为什么 `digest` 含标题行：小节标题是这一节的一部分——把「易变内容的官方核对来源」改名
   与改一条链接一样，都该让指纹变。`digest` 只做两件归一化：行尾统一成 `\n`、去掉末尾空行，
   这样「文件末尾多一个空行」不会白白作废一次核验。
   ───────────────────────────────────────────────────────────────────────── */

/** 一个小节。行号 1 起，与校验器的 `line` 口径一致。 */
export interface ResourceSection {
  /** `## ` 之后的标题正文（去掉两端空白）。 */
  heading: string;
  /** 标题行（含）的 1 起行号。 */
  from: number;
  /** 下一节标题之前的最后一行（含）的 1 起行号；本节是最后一节时就是文件末行。 */
  to: number;
  /** 顶格列表项条数（代码块与缩进列表不算）。 */
  entries: number;
  /** 指纹的输入文本：标题行 + 正文，行尾统一 `\n`、去掉末尾空行。 */
  digest: string;
}

/** `## 标题`：正好两个 `#`，后面必须有空白——`###` 子标题不算小节。 */
const HEADING_RE = /^#{2}[ \t]+(.*\S)[ \t]*$/;
/** 顶格列表项：`-`／`*`／`+` 后面一个空白，再至少一个非空白字符。 */
const ITEM_RE = /^[-*+][ \t]+\S/;
/** 代码块围栏（``` 或 ~~~）。 */
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/** 与校验器同一套断行口径（`\r\n` / `\r` / `\n` 都算断行）。 */
function splitLines(markdown: string): string[] {
  return markdown.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
}

/**
 * 逐行标出「这一行在代码块里（含围栏行本身）」。
 *
 * 围栏要**同种才配对**：``` 块里出现的一行 `~~~` 是正文，不该把后面的 `## 标题`
 * 也一起吞掉。落单的围栏一直吃到文件末尾——与 Markdown 的容错读法一致。
 */
function fenceFlags(lines: readonly string[]): boolean[] {
  const inside: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const marker = FENCE_RE.exec(line);
    if (marker === null) {
      inside.push(open !== null);
      continue;
    }
    const ticks = marker[1] ?? '';
    if (open === null) {
      open = ticks;
      inside.push(true);
    } else if (line.trimStart().startsWith(open)) {
      open = null;
      inside.push(true);
    } else {
      inside.push(true);
    }
  }
  return inside;
}

/**
 * 按 `##` 小节切开一份「资源清单」。**第一处 `##` 之前的引言不算小节**——那是这份文件
 * 的定位说明（模板里的 `>` 引用块），不是资源或缺口。
 */
export function resourceSections(markdown: string): ResourceSection[] {
  const lines = splitLines(markdown);
  const fenced = fenceFlags(lines);

  const heads: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (fenced[index]) continue;
    if (HEADING_RE.test(lines[index] ?? '')) heads.push(index);
  }

  const out: ResourceSection[] = [];
  heads.forEach((head, position) => {
    const next = heads[position + 1];
    const end = next === undefined ? lines.length - 1 : next - 1;
    let entries = 0;
    for (let index = head + 1; index <= end; index += 1) {
      if (fenced[index]) continue;
      if (ITEM_RE.test(lines[index] ?? '')) entries += 1;
    }
    const body = lines.slice(head, end + 1);
    while (body.length > 0 && (body[body.length - 1] ?? '').trim() === '') body.pop();
    out.push({
      heading: (HEADING_RE.exec(lines[head] ?? '')?.[1] ?? '').trim(),
      from: head + 1,
      to: end + 1,
      entries,
      digest: body.join('\n'),
    });
  });
  return out;
}

/* ── 条目：每条来源服务哪几个节点 ───────────────────────────────────────── */

/** 一条来源条目。行号 1 起，与校验器的 `line` 口径一致。 */
export interface ResourceEntry {
  /** 这一条所在行的 1 起行号。 */
  line: number;
  /** 所属小节标题。 */
  heading: string;
  /** 这一条声明的服务节点（去重、按出现序）；没写就是空数组。 */
  nodes: string[];
}

/** 条目行末的「服务」标记：`… · 服务 node.a、node.b`（`·` 也认 `・` 与 `|`）。 */
const SERVE_RE = /[·・|]\s*服务[：:]?\s*(.+?)\s*$/;

/** 标记里的节点列表：`、`／`，`／`,`／空白 都算分隔。 */
function servedNodes(line: string): string[] {
  const marker = SERVE_RE.exec(line);
  if (marker === null) return [];
  const out: string[] = [];
  for (const token of (marker[1] ?? '').split(/[、，,\s]+/)) {
    if (token === '' || out.includes(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * 摘出清单里的条目（顶格列表项）与它声明的服务节点。
 *
 * 只做「哪一行、属于哪一节、服务哪些节点」——**节点是否真在大纲里、id 形状对不对**都是
 * 校验器的判断（这里不认大纲，也不悄悄丢掉认不出的 token）。`## Gaps` 里的条目也是条目，
 * 由调用方按标题筛；**第一处 `##` 之前的引言里就算有列表项也不算条目**（那里是这份文件的
 * 定位说明，不是资源）。
 */
export function resourceEntries(markdown: string): ResourceEntry[] {
  const lines = splitLines(markdown);
  const fenced = fenceFlags(lines);
  const out: ResourceEntry[] = [];
  for (const section of resourceSections(markdown)) {
    for (let index = section.from; index < section.to; index += 1) {
      if (fenced[index]) continue;
      const line = lines[index] ?? '';
      if (!ITEM_RE.test(line)) continue;
      out.push({
        line: index + 1,
        heading: section.heading,
        nodes: servedNodes(line),
      });
    }
  }
  return out;
}

/**
 * 这一节算不算「来源条目」。
 *
 * 清单是**给学生的延伸阅读 + 易变内容的官方核对来源**两部分，所以社区与缺口不算来源：
 * 社区不是知识来源，缺口记的是「没有来源」这件事本身。别的小节一律算来源（新增一节
 * 就会被算进覆盖率，不会悄悄漏掉）。
 */
export function isSourceSection(heading: string): boolean {
  return !/^(wisdom|gaps)\b/i.test(heading.trim()) && !/社区|缺口/.test(heading);
}

