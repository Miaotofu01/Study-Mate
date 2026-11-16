/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 —— 记忆模块：两份 `MEMORY.yaml` 的分节与投影

   一句话：给它两份记忆文件的**文本**（读不到就传 `null`），它给出 ①可注入的画像三节投影、
   ②`积累` 条目的键与内容、③节名完整性与空骨架的判定。不碰盘、不发请求、不认识工作区——
   「这两份文件在哪」按「文件归属」由调用方去找（`MEMORY_FILE` 与它同一份词表）。

   为什么要有这一层：共享记忆与科目记忆是**两种可见性**，不是两份内容。学生画像三节
   （`我是谁` / `教学偏好` / `学习习惯`）可以进上下文；`积累`（角色攒下的干活笔记）与整份
   科目记忆**永不进入任何上下文**。这条边界不能靠提示词约定——三处取内容的消费路径（答疑开张
   注入、工作区摘要工具、图片库载荷）各自读盘，各写一遍「取哪几节」就会漂。所以分节与白名单
   只在这里定义一次，调用方只拿投影文本。第四处会点到「记忆」这个名字的消费点是监听域
   （`lib/watch/domains.ts`）：它只按文件名认这份文件、一个字节的内容都不带（它回答「哪一片
   变了」，不是「取哪几节」），所以那里没有投影可用，也不该有。

   为什么投影是**原文照搬**而不是重新序列化：投影要能一眼对回学生自己写的那几行（他在文件里
   改了措辞，注入的就是他改的措辞）。所以这里只切段、不构造值，跟 `resources.ts` 的
   分节器同一套读法（`##` 换成一级键）。

   **旧格式（2.0.x 之前）的兼容是同一份词表的第二条读法**：改名前的共享记忆是
   `.learning/MEMORY.md`，`## 我是谁` 这样的 Markdown 分节 + 自由 bullet。ADR-0014 原决定
   「读侧不认旧名」，但审计发现 2.0.x 用户盘上只有旧格式时画像三节与「积累」会静默全丢
   （内容形状同时变了，光改名读不出来）。所以这里补一条**只读兜底**与一次性迁移的纯函数：
   `migrateLegacyMemory` 把旧分节机械地转成新 YAML（行序、键 + 一句话结构保留；转不了的
   原样带过去并给 warning），`readMemoryWithLegacy` 让消费点在新文件缺席时读旧文件。
   迁移是过渡，不是第二个格式：读侧只认「新名优先、旧名兜底」，`migrate` 把旧文件搬到
   `.bak` 之后兜底分支自然不再命中；写侧永远只写 `MEMORY.yaml`。

   为什么「节」= 顶格的 `键:`：记忆是一份 YAML，节名就是一级键（`lib/yaml.ts` 的读法）。
   代码块、缩进的子键、行内注释都不算节。**第一个节名之前的引言不算节**——那是这份文件的
   定位说明（模板里的注释），既不是画像也不是积累。

   为什么「一条」= 有内容的那一行：空列表 `[]`、空映射 `{}`、`null` 都是「这一条还没有内容」
   （模板骨架就长这样），不算条目。一条 = 中文键 + 内容，键下面缩进更深的行（列表项、块标量）
   算这条的内容。这样「空骨架」有判定：文件在盘上、四个节名齐全、一条内容都没有。

   已知的取舍：**不认块标量里的顶格行**（`|` 内容里出现一列 0 的 `键:` 会被当成新的一节）。
   记忆是一行一条的短文本，真写出那种结构时该改的是记忆本身；为它写一个 YAML 块标量状态机
   不值得（`yamlpos.ts` 也刻意在没把握的结构上退让）。
   ───────────────────────────────────────────────────────────────────────── */

/** 记忆的两种归属：共享记忆（工作区根的 `.learning/` 下）与科目记忆（科目目录下）。 */
export type MemoryKind = 'shared' | 'subject';

/** 两份记忆都叫这个名字（位置不同，路径见「文件归属」）。 */
export const MEMORY_FILE = 'MEMORY.yaml';

/** 画像三节：**只有这三节**能被注入；顺序即投影顺序（文件里怎么排都不改变它）。 */
export const PROFILE_SECTIONS = ['我是谁', '教学偏好', '学习习惯'] as const;

/** 角色攒下的干活笔记：一条 = 中文键 + 内容，**永不进上下文**。 */
export const ACCUMULATION_SECTION = '积累';

/** 每类记忆按规范该有的节（顺序即规范顺序）。 */
export const MEMORY_SECTIONS: Record<MemoryKind, readonly string[]> = {
  shared: [...PROFILE_SECTIONS, ACCUMULATION_SECTION],
  subject: [ACCUMULATION_SECTION],
};

/** 记忆里的一条：中文键 + 内容。列表项没有键，键就是空串。 */
export interface MemoryEntry {
  /** 键（`积累` 里那一行冒号前的词）；列表项之类没有键的条目是空串。 */
  key: string;
  /** 内容原文（键下面缩进更深的行按原样接起来；空的一律不算条目）。 */
  content: string;
  /** 键（或列表项）那一行的 1 起行号，与校验器的 `line` 口径一致。 */
  line: number;
}

/** 一节：标题行、行号范围、条目、以及这一节的原文。 */
export interface MemorySectionView {
  /** 一级键的键名（去掉两端空白与包裹的引号）。 */
  heading: string;
  /** 标题行的 1 起行号。 */
  from: number;
  /** 下一节标题之前的最后一行（含）的 1 起行号；本节是最后一节时就是文件末行。
   *  这是**文件里的事实**（下一节从哪一行开始），与「哪几行算这一节的内容」不是一回事——
   *  正文的边界见 `text`。 */
  to: number;
  /** 这一节里有内容的条目（空列表、空映射都不算）。 */
  entries: MemoryEntry[];
  /** 这一节的原文：标题行 + 正文，止于最后一个非空非注释行（下一节标题上方的注释块属于
   *  下一节，见下面 `text` 那一步的注释）。投影就是从这儿取的。 */
  text: string;
}

/** 一份记忆文件的判读结果。 */
export interface MemoryFileView {
  /** 文件在盘上（这次调用真的拿到了文本）。 */
  present: boolean;
  /** 文件里出现的节，按文件顺序。 */
  sections: MemorySectionView[];
  /** 规范里有、这份文件里没有的节名（按规范顺序）。 */
  missing: string[];
  /** 文件里有、规范里没有的节名（按文件顺序）——节名完整性两个方向都要判。 */
  unknown: string[];
  /** 一条内容都没有——`present:true` 时就是「空骨架」（模板预置的那种），`present:false` 也是 true。 */
  empty: boolean;
  /** 可注入的画像三节投影；科目记忆与 `积累` 永远是空串。 */
  injectable: string;
  /** 这一份文件里的 `积累` 条目。 */
  accumulations: MemoryEntry[];
}

/** 一条带出处的 `积累` 条目。 */
export interface AccumulationEntry extends MemoryEntry {
  /** 这一条来自哪份记忆。 */
  from: MemoryKind;
}

/** 两份记忆的判读结果。 */
export interface MemoryReport {
  shared: MemoryFileView;
  subject: MemoryFileView;
  /** 共享记忆的画像三节投影（= `shared.injectable`）。`积累` 与科目记忆一个字都不在里面。 */
  injectable: string;
  /** 两份记忆的全部 `积累` 条目：共享在前、科目在后，各自按文件顺序。 */
  accumulations: AccumulationEntry[];
  /** 两份都一条内容都没有。 */
  empty: boolean;
}

/** 两份记忆的文本；读不到就传 `null`／`undefined`（那是「没有这份记忆」，不是错误）。 */
export interface MemoryTexts {
  shared?: string | null;
  subject?: string | null;
}

/* ── 行扫描 ─────────────────────────────────────────────────────────────── */

/** 与校验器同一套断行口径（`\r\n` / `\r` / `\n` 都算断行）。 */
function splitLines(text: string): string[] {
  return text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
}

/** 一级键：顶格、`键:`、冒号后是空白或行尾。`###`／缩进的子键／注释都不是节。 */
const HEADING_RE = /^([^\s#:][^:]*?)[ \t]*:(?:[ \t](.*))?$/;
/** 键行（任意缩进）。`url: https://x` 这种冒号后跟非空白的写法不算键——与 `lib/yaml.ts` 同口径。 */
const KEY_RE = /^([ \t]*)([^\s#][^:]*?)[ \t]*:(?:[ \t](.*))?$/;
/** 列表项（任意缩进）。 */
const ITEM_RE = /^([ \t]*)[-*+][ \t]+(.*\S)[ \t]*$/;
/** 空值：`[]`／`{}`／`null`／`~`／空引号——「这一条还没有内容」，不是一条。 */
const EMPTY_VALUE_RE = /^(?:\[\s*\]|\{\s*\}|null|~|''|""|Null|NULL)$/;
/** 块标量的引子（`|`、`|-`、`>2` 之类）：内容在下面那几行里。 */
const BLOCK_VALUE_RE = /^[|>][+-]?[0-9]*$/;
/** 行首缩进。 */
const INDENT_RE = /^[ \t]*/;

/** 去掉键两端可能包着的引号（YAML 允许 `"我是谁":` 与 `'我是谁':`）。 */
const QUOTED_RE = /^(['"])(.*)\1$/s;

function unquote(text: string): string {
  const trimmed = text.trim();
  const quoted = QUOTED_RE.exec(trimmed);
  return quoted === null ? trimmed : (quoted[2] ?? '').trim();
}

/** 缩进宽度（制表符按一列算——记忆是手写的短文本，不做制表符展开）。 */
function indentOf(line: string): number {
  return (INDENT_RE.exec(line)?.[0] ?? '').length;
}

/** 注释行与空行都不是内容。 */
function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/** 一块（键下面缩进更深的行）摊平成内容：去掉列表项前缀与两端空白，按行接起来。 */
function blockContent(lines: readonly string[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    if (isBlankOrComment(line)) continue;
    const item = ITEM_RE.exec(line);
    parts.push((item ? (item[2] ?? '') : line).trim());
  }
  return parts.join('\n');
}

/** 一个键下面缩进更深的行（块值）：从 `index` 往下收到缩进回到 `level` 为止。 */
function blockBelow(lines: readonly string[], index: number, to: number, level: number): string[] {
  const block: string[] = [];
  for (let next = index + 1; next < to; next += 1) {
    const following = lines[next] ?? '';
    if (isBlankOrComment(following)) continue;
    if (indentOf(following) <= level) break;
    block.push(following);
  }
  return block;
}

/** 一个节里、处于 `level` 那一层的条目：键行与列表项都算。 */
function entriesOf(lines: readonly string[], from: number, to: number): { entries: MemoryEntry[]; level: number | null } {
  let level: number | null = null;
  for (let index = from; index < to; index += 1) {
    const line = lines[index] ?? '';
    if (isBlankOrComment(line)) continue;
    level = indentOf(line);
    break;
  }
  if (level === null) return { entries: [], level };

  const entries: MemoryEntry[] = [];
  for (let index = from; index < to; index += 1) {
    const line = lines[index] ?? '';
    if (isBlankOrComment(line) || indentOf(line) !== level) continue;
    const item = ITEM_RE.exec(line);
    const key = item === null ? KEY_RE.exec(line) : null;

    // 这一条的内容：内联值；内联是空的（或块标量引子）就往下收它缩进更深的行
    let content = '';
    let name = '';
    if (item !== null) {
      content = (item[2] ?? '').trim();
    } else if (key !== null) {
      name = unquote(key[2] ?? '');
      const inline = (key[3] ?? '').trim();
      if (inline !== '' && !EMPTY_VALUE_RE.test(inline) && !BLOCK_VALUE_RE.test(inline)) {
        content = inline;
      } else {
        content = blockContent(blockBelow(lines, index, to, level));
      }
    } else {
      // 没写键、也不是列表项的整行散文：也算这一节的一条（宽容读法——学生手写的句子
      // 不该被静默丢掉，投影本来就是原文照搬）。空骨架的判定不受影响：散文也是内容。
      content = line.trim();
    }
    if (content === '') continue; // 空列表／空映射：这一条还没有内容
    entries.push({ key: name, content, line: index + 1 });
  }
  return { entries, level };
}

/** 投影用的一节正文：整行注释不是内容（`isBlankOrComment`，与 `entriesOf` / `blockContent`
 *  同一套判据），空行只是排版。节体里**任何位置**的注释都不进注入——注释是写给人看的说明书，
 *  不是学生画像；学生的每一行照旧原样留着（他改了措辞，注入的就是他改的措辞）。 */
function projectedBody(text: string): string {
  return splitLines(text).filter((line) => !isBlankOrComment(line)).join('\n');
}

/* ── 一份文件 → 一份判读 ────────────────────────────────────────────────── */

/**
 * 判读一份记忆文件的文本。`text` 是 `null`／`undefined` 就是「这份文件不存在」——
 * 判读结果照样给全（`missing` 是规范里的全部节名），不抛错、不造默认内容。
 */
export function readMemoryFile(kind: MemoryKind, text?: string | null): MemoryFileView {
  const canonical = MEMORY_SECTIONS[kind];
  const present = typeof text === 'string';
  const lines = present ? splitLines(text as string) : [];

  const heads: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (HEADING_RE.test(lines[index] ?? '')) heads.push(index);
  }

  const sections: MemorySectionView[] = [];
  heads.forEach((head, position) => {
    const next = heads[position + 1];
    const end = next === undefined ? lines.length - 1 : next - 1;
    const body = lines.slice(head, end + 1);
    // 节体止于最后一个非空非注释行：**下一节标题上方的注释块是下一节的说明书**——模板里
    // 「积累」上方那三行就落在「学习习惯」的 `to` 范围里，收进这一节的正文就会跟着进注入。
    // 标题行既不空也不是注释，所以这里一定收得住。
    while (body.length > 1 && isBlankOrComment(body[body.length - 1] ?? '')) body.pop();
    const { entries } = entriesOf(lines, head + 1, end + 1);
    sections.push({
      heading: unquote((HEADING_RE.exec(lines[head] ?? '')?.[1] ?? '').trim()),
      from: head + 1,
      to: end + 1,
      entries,
      text: body.join('\n'),
    });
  });

  const found = new Set(sections.map((section) => section.heading));
  const empty = sections.every((section) => section.entries.length === 0);
  const injectable = MEMORY_SECTIONS[kind]
    .filter((heading) => (PROFILE_SECTIONS as readonly string[]).includes(heading))
    .map((heading) => sections.find((section) => section.heading === heading))
    .filter((section): section is MemorySectionView => section !== undefined && section.entries.length > 0)
    .map((section) => projectedBody(section.text))
    .join('\n\n');

  const accumulation = sections.filter((section) => section.heading === ACCUMULATION_SECTION);
  return {
    present,
    sections,
    missing: canonical.filter((heading) => !found.has(heading)),
    unknown: sections.map((section) => section.heading)
      .filter((heading) => !canonical.includes(heading)),
    empty,
    injectable,
    accumulations: accumulation.flatMap((section) => section.entries),
  };
}

/** 判读两份记忆。调用方按「文件归属」找到路径、把文本读进来（读不到就传 `null`）。 */
export function readMemory(texts: MemoryTexts = {}): MemoryReport {
  const shared = readMemoryFile('shared', texts.shared);
  const subject = readMemoryFile('subject', texts.subject);
  return {
    shared,
    subject,
    injectable: shared.injectable,
    accumulations: [
      ...shared.accumulations.map((entry) => ({ ...entry, from: 'shared' as const })),
      ...subject.accumulations.map((entry) => ({ ...entry, from: 'subject' as const })),
    ],
    empty: shared.empty && subject.empty,
  };
}

/* ── 旧格式（2.0.x 前）→ 新格式：读侧兜底与一次性迁移共用 ───────────────── */

/** 改名前的共享记忆文件名。**只**在读侧兜底与一次性迁移里出现；写侧永远只写 `MEMORY_FILE`。 */
export const LEGACY_MEMORY_FILE = 'MEMORY.md';

/** 改名前的第四节（只装本机事实）；#190 起被 `积累` 取代，迁移时并进 `积累`。 */
export const LEGACY_ACCUMULATION_HEADING = '跨科目观察';

/** 旧格式的节标题：`## 我是谁`（`#` 的数量写死 2，改名前的文件就是这么排的）。 */
const LEGACY_HEADING_RE = /^##[ \t]+(.*\S)[ \t]*$/;
/** 旧格式的列表项：`- 内容`（缩进任意）。 */
const LEGACY_ITEM_RE = /^([ \t]*)[-*+][ \t]+(.*\S)[ \t]*$/;
/** 旧格式一条的「键 + 一句话」：优先中文冒号；ASCII 冒号只认后面带空白的写法（别把 URL 拆了）。 */
const LEGACY_KEY_CN_RE = /^([^：]{1,40}?)[：][ \t]*(.*)$/;
const LEGACY_KEY_ASCII_RE = /^([^:]{1,40}?):(?:[ \t]+(.*))?$/;

/** 旧文件里的一节。 */
interface LegacySection {
  heading: string;
  /** 这一节里的条目（保持行序）：键 + 内容行；没有键的条目（纯 bullet/散文）键是空串。 */
  entries: LegacyEntry[];
}

interface LegacyEntry {
  key: string;
  content: string[];
}

/** 旧格式分节的解析：只做「哪一节、这一节有哪几条」，不判可见性、也不抛错。 */
function parseLegacySections(text: string): LegacySection[] {
  const lines = splitLines(text);
  const sections: LegacySection[] = [];
  let current: LegacySection | null = null;
  let entry: LegacyEntry | null = null;

  for (const raw of lines) {
    const heading = LEGACY_HEADING_RE.exec(raw);
    if (heading !== null) {
      current = { heading: unquote((heading[1] ?? '').trim()), entries: [] };
      sections.push(current);
      entry = null;
      continue;
    }
    // 第一个节名之前是这份文件的定位说明（标题与引言），不算节、也不迁移
    if (current === null) continue;
    if (raw.trim() === '') continue;

    const item = LEGACY_ITEM_RE.exec(raw);
    if (item !== null) {
      const indent = (item[1] ?? '').replace(/\t/g, '    ').length;
      const text = (item[2] ?? '').trim();
      if (indent === 0) {
        const { key, content } = splitLegacyKey(text);
        entry = { key, content: content === '' ? [] : [content] };
        current.entries.push(entry);
      } else if (entry !== null) {
        // 缩进的子 bullet 属于上一条（`各领域当前水平` 下面那几行）
        entry.content.push(text);
      } else {
        entry = { key: '', content: [text] };
        current.entries.push(entry);
      }
      continue;
    }

    // 非列表行：缩进的是上一条的续行，顶格的按一条无键内容收（内容不丢，迁移时降级成列表项）
    const trimmed = raw.trim();
    if ((raw.match(/^[ \t]*/)?.[0] ?? '').replace(/\t/g, '    ').length > 0 && entry !== null) {
      entry.content.push(trimmed);
    } else {
      entry = { key: '', content: [trimmed] };
      current.entries.push(entry);
    }
  }

  // 键后面一条内容都没有：按本模块的判读口径本来就是「这一条还没有内容」，不算丢失
  for (const section of sections) {
    section.entries = section.entries.filter((one) => one.content.length > 0);
  }
  return sections;
}

/** `- 键：内容` → 键与内容；拆不出「短键」的整行当无键内容（原文照搬，不猜）。 */
function splitLegacyKey(text: string): { key: string; content: string } {
  const chinese = LEGACY_KEY_CN_RE.exec(text);
  if (chinese !== null) return { key: (chinese[1] ?? '').trim(), content: (chinese[2] ?? '').trim() };
  const ascii = LEGACY_KEY_ASCII_RE.exec(text);
  if (ascii !== null) return { key: (ascii[1] ?? '').trim(), content: (ascii[2] ?? '').trim() };
  return { key: '', content: text.trim() };
}

/** 一个标量写成 YAML 的 plain 形式安全吗（不安全就加双引号；写法与 `templates/` 的注释同一条规矩）。 */
function plainSafe(value: string): boolean {
  if (value === '') return false;
  if (value.trim() !== value) return false;
  if (/[\n\r\t]/.test(value)) return false;
  // 行内出现 `: ` / ` #` 会改变结构（YAML 两个最容易踩的直觉坑）
  if (/: | #/.test(value)) return false;
  return !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value);
}

/** 标量：plain 安全就原样写，否则用双引号（JSON 的转义是 YAML 双引号可接受的子集）。 */
function yamlScalar(value: string): string {
  return plainSafe(value) ? value : JSON.stringify(value);
}

/** 旧节名要当 YAML 一级键：ASCII 冒号会被本模块的 HEADING_RE 当成键值分界，换成中文冒号并说明。 */
function yamlHeading(heading: string, warnings: string[]): string {
  if (!heading.includes(':')) return plainSafe(heading) ? heading : JSON.stringify(heading);
  const replaced = heading.replace(/:[ \t]*/g, '：').trim();
  warnings.push(`旧节「${heading}」的标题里有 ASCII 冒号，已改用中文冒号保留为「${replaced}」：内容没有丢，节名请人工确认。`);
  return plainSafe(replaced) ? replaced : JSON.stringify(replaced);
}

/** 一条目写成「键 + 一句话」；多条内容行写成键下的列表（行序保留）。 */
function emitEntry(lines: string[], entry: LegacyEntry): void {
  if (entry.key === '') {
    // 没键的条目：每一行一个列表项（原文照搬，不硬造键）
    for (const line of entry.content) lines.push(`  - ${yamlScalar(line)}`);
    return;
  }
  if (entry.content.length === 1) {
    lines.push(`  ${yamlScalar(entry.key)}: ${yamlScalar(entry.content[0] ?? '')}`);
    return;
  }
  lines.push(`  ${yamlScalar(entry.key)}:`);
  for (const line of entry.content) lines.push(`    - ${yamlScalar(line)}`);
}

/**
 * 一节里的条目不能直接写进 YAML 映射的两个原因：没有键的条目会让映射与列表混在同一层
 * （不是合法 YAML），重名键会互相覆盖（同名键只有最后一个生效）。这里统一补键/加序号，
 * 并把改了什么写进 warning——内容一个字节都不动。
 */
function prepareEntries(entries: LegacyEntry[], label: string, warnings: string[]): LegacyEntry[] {
  const out: LegacyEntry[] = [];
  const seen = new Map<string, number>();
  let unnamed = 0;
  let duplicates = 0;
  for (const entry of entries) {
    let key = entry.key;
    if (key === '') {
      unnamed += 1;
      key = unnamed === 1 ? '未命名条目' : `未命名条目（${unnamed}）`;
    }
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count > 0) {
      duplicates += 1;
      key = `${key}（${count + 1}）`;
    }
    out.push({ key, content: entry.content });
  }
  if (unnamed > 0) {
    warnings.push(`「${label}」里有 ${unnamed} 条没有键的条目：已按「未命名条目 N」保留（内容原样；`
      + '要按索引读请人工补键）。');
  }
  if (duplicates > 0) {
    warnings.push(`「${label}」里有 ${duplicates} 个重名键：已加序号区分（YAML 同名键会互相覆盖，`
      + '请人工合并或补键）。');
  }
  return out;
}

/** 空骨架：四节（科目记忆只有一节）都在、都没有内容——迁移后文件仍是这个模块认得的形状。 */
function emptyMemoryYaml(kind: MemoryKind): string {
  return `${MEMORY_SECTIONS[kind].map((heading) => `${heading}: {}`).join('\n')}\n`;
}

/** 旧格式迁移的产物：YAML 文本 + 需要人看一眼的地方 + 能不能自动迁移。 */
export interface LegacyMemoryConversion {
  /** 迁移后的 YAML（`migratable: false` 时是空串）。 */
  yaml: string;
  /** 迁移时不能机械转换、或做了并节的提示。**有 warning 也照常迁移**，只是让人复核。 */
  warnings: string[];
  /** 旧文件里有没有可识别的 `##` 分节。没有节、正文又不是空的 → false（不迁移，免得静默丢内容）。 */
  migratable: boolean;
  /** 迁移出来的节名（规范节在前、原样保留的旧节在后）。 */
  sections: string[];
}

/**
 * 把旧格式（`##` 分节 + bullet）的共享记忆机械地转成新 YAML。
 *
 * 转换规则（都为了「不静默丢」）：每节保留行序；`- 键：一句话` 变成 YAML 的「键: 值」，
 * 键下缩进的子行变成键下的列表；没有键的 bullet/散文原样降级成列表项；`跨科目观察` 并进
 * `积累`（#190 起后者取代前者）并给 warning；规范之外的旧节**原样保留为同名节**（不在注入
 * 白名单里，内容仍可 grep）并给 warning。
 */
export function migrateLegacyMemory(kind: MemoryKind, text: string): LegacyMemoryConversion {
  const parsed = parseLegacySections(text);
  const canonical = MEMORY_SECTIONS[kind];
  if (parsed.length === 0) {
    if (text.trim() === '') {
      return {
        yaml: emptyMemoryYaml(kind),
        warnings: ['旧文件是空的：已按新格式的空骨架迁移（四节都在、都没有内容）。'],
        migratable: true,
        sections: [...canonical],
      };
    }
    return {
      yaml: '',
      warnings: ['旧文件里没有可识别的 `## 分节`：无法机械迁移，内容没有动（原文件保持原样）。请人工整理成新格式后再迁移。'],
      migratable: false,
      sections: [],
    };
  }

  const warnings: string[] = [];
  const buckets = new Map<string, LegacyEntry[]>();
  const unknown: LegacySection[] = [];
  for (const section of parsed) {
    let heading = section.heading;
    if (kind === 'shared' && heading === LEGACY_ACCUMULATION_HEADING) {
      heading = ACCUMULATION_SECTION;
      warnings.push(`旧节「${LEGACY_ACCUMULATION_HEADING}」已并入「${ACCUMULATION_SECTION}」：`
        + '#190 起它被「积累」取代，条目键与行序原样保留，请人工复核（旧日期/短句成了键）。');
    }
    if (canonical.includes(heading)) {
      buckets.set(heading, [...(buckets.get(heading) ?? []), ...section.entries]);
    } else {
      unknown.push(section);
    }
  }

  const lines: string[] = [];
  const emitted: string[] = [];
  for (const heading of canonical) {
    const entries = prepareEntries(buckets.get(heading) ?? [], heading, warnings);
    if (entries.length === 0) {
      lines.push(`${heading}: {}`);
    } else {
      lines.push(`${heading}:`);
      for (const entry of entries) emitEntry(lines, entry);
    }
    emitted.push(heading);
  }

  const used = new Map<string, number>();
  for (const section of unknown) {
    let heading = yamlHeading(section.heading, warnings);
    const seen = used.get(heading) ?? 0;
    used.set(heading, seen + 1);
    if (seen > 0) {
      // YAML 里同名键只有最后一个生效：给后出现的几份加序号，不静默互相覆盖
      const original = heading;
      heading = `${original}（${seen + 1}）`;
      warnings.push(`旧节「${original}」出现了 ${seen + 1} 次：已把后出现的几份保留为「${heading}」，`
        + '请人工合成一节。');
    }
    warnings.push(`旧节「${section.heading}」不在四节规范内：已原样保留为同名节（不进任何上下文），`
      + '需要长期保留请人工并进画像三节或「积累」。');
    const entries = prepareEntries(section.entries, section.heading, warnings);
    if (entries.length === 0) {
      lines.push(`${heading}: {}`);
    } else {
      lines.push(`${heading}:`);
      for (const entry of entries) emitEntry(lines, entry);
    }
    emitted.push(heading);
  }

  return { yaml: `${lines.join('\n')}\n`, warnings, migratable: true, sections: emitted };
}

/** 读侧兼容判读：新文件优先；只有旧文件时读旧格式并给「这是旧格式」的提示。 */
export interface MemoryCompatRead {
  view: MemoryFileView;
  /** 交给下游的 YAML 文本：新文件原文，或旧文件转换后的 YAML；两份都没有是 `null`。 */
  text: string | null;
  /** 真读到的是旧格式 `MEMORY.md`（尚未迁移）。 */
  legacy: boolean;
  /** 旧格式转换的提示（并节/原样保留/无法迁移）。 */
  warnings: string[];
}

/** 新名优先、旧名兜底的判读入口。写侧不存在「回退」：只写新文件。 */
export function readMemoryWithLegacy(
  kind: MemoryKind,
  texts: { current?: string | null; legacy?: string | null } = {},
): MemoryCompatRead {
  if (typeof texts.current === 'string') {
    return { view: readMemoryFile(kind, texts.current), text: texts.current, legacy: false, warnings: [] };
  }
  if (typeof texts.legacy === 'string') {
    const conversion = migrateLegacyMemory(kind, texts.legacy);
    if (!conversion.migratable) {
      return { view: readMemoryFile(kind, null), text: null, legacy: true, warnings: conversion.warnings };
    }
    return {
      view: readMemoryFile(kind, conversion.yaml),
      text: conversion.yaml,
      legacy: true,
      warnings: conversion.warnings,
    };
  }
  return { view: readMemoryFile(kind, null), text: null, legacy: false, warnings: [] };
}
