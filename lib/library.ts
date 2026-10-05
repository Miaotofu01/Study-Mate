/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 半数据层 —— 学习工作区 → 阅读端要的那一份 JSON

   方向是 **agent → 文件 → 页面**：Host 半读真工作区，把整个库抽成一份自足的快照。
   自足是要点：课件的 Markdown 正文**内联**进 payload（lesson_md），题库整段内联（pool），
   页面拿到这一份 JSON 就该能画出全部内容，不需要再回主机取第二次。

   这份实现脱胎于阅读端版式原型里那个一次性构建脚本（`prototype/reading-client/`，
   那个目录已在 #75 里删除），语义逐条对齐它：
   三档状态映射、按前置依赖分层、锚点四态对账、术语表 / Mission / 学习记录 / lab 的解析口径、
   「继续学」的挑选顺序、零节点科目跳过。刻意不同的地方只有四处，
   都写在各自位置的注释里：
     1. 课件正文内联（lesson_md），不再让前端去 fetch lessons/<slug>/<file>.md；
     2. 顶层多出 workspace 与 memory_md（Host 半要知道自己在读哪个库、共享记忆是什么）；
     3. 顶层不再有 source / note —— 那是原型构建脚本自己的元信息（相对路径、
        「由构建脚本抽出」），放进插件 payload 会误导人；
     4. 一个可用科目都没有时给**空清单**，不抛错（#90）：那是「工作区在、课还没建」，
        不是读盘失败，页面照实说「还没有科目」比显示错误卡对。理由在同名注释处。

   缺失的可选文件一律给空值，不抛错；但 YAML 里出现本解析器不支持的构造时**必须**抛错，
   那是真错，不是缺失。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, pyStrip } from './yaml.ts';
// reference/ 的清单与版本号放在 lib/reference.ts：写入端要用同一套规则算版本号（并发栅栏），
// 两边各写一份就会出现「明明没人动过却报冲突」。这里只把结果挂进 payload。
import { listReference } from './reference.ts';
import type { ReferenceEntry } from './reference.ts';
// 锚点的**解析**与**对账**只有一份实现，在纯函数域 lib/core/**（issue #66 收编）：
// 这里曾经自带一份行锚定正则 + 四态对账，与 Python 侧并存、没有测试，还带着三个洞
// （exact 撞键静默覆盖 / orphans 没有消费方 / 不认围栏）。别再往这里抄第二份。
import { parseAnchors, reconcileAnchors } from './core/anchors.ts';
import type { AnchorMatch } from './core/anchors.ts';
import { cmpCodePoints } from './core/format.ts';
// 题型与字段的判据在纯函数域（词表只有一份：lib/core/rules.ts 的 QUESTION_KINDS）。
// 未知题型要带**题库文件与行号**报出来——行号来自扫 JSON 原文，不是文本搜索。
import { checkPoolKinds } from './core/questions.ts';
import type { PoolKindIssue } from './core/questions.ts';
// 三档词表与旧六档映射的唯一实现在纯函数域（issue #67）。这里曾经自带一份硬编码映射，
// 与 validate.ts 那份并存——改一次词表要动两处，漂了也没有测试拦得住。别再抄第二份。
import { toTier } from './core/rules.ts';
// 误解记录只有 misconceptions.yaml 一个落点（目标态规格 §5.4）；旧字段的归一是纯函数。
import { normalizeMisconceptions, misconceptionIssues as misconceptionIssuesOf } from './core/misconceptions.ts';
import type { Misconception } from './core/misconceptions.ts';
// 作答数据（attempts/<NNNN>-<节点id>.json）与课件一一对应，绝不写回题库（ADR-0007）
import { readAttempts, attemptsVersion } from './attempts.ts';

/* ── 形状 ──────────────────────────────────────────────────────────────────
   这一份 JSON 是与阅读端（lib/client.js）之间的契约：字段名、层级、空值口径都按它走。
   值域来自学习文件的地方标 unknown/any —— 那些地方本来就有运行期检查兜着，把检查
   改成类型收窄会连带改掉表达式，而这次迁移要求运行期逐字不变。 */

/** 术语表里的一条词。 */
interface GlossaryTerm {
  term: string;
  def: string;
  avoid: string;
}

/** 术语表的一个 `## 分组`。 */
interface GlossaryGroup {
  title: string;
  terms: GlossaryTerm[];
}

/** MISSION.md 解析出来的小节：`title` 是一级标题，`sections` 是「小节名 → 行数组」。 */
interface Mission {
  title: string;
  sections: Record<string, string[]>;
}

/** 一条学习记录。 */
interface LearningRecord {
  file: string;
  title: string;
  date: string;
  markdown: string;
}

/** 一个 lab 任务。 */
interface Lab {
  dir: string;
  files: string[];
  readme: string;
}

/** 大纲里的一个节点，加上从文件里算出来的东西。 */
interface SubjectNode {
  id: string;
  title: string;
  kind: string;
  objective: string;
  problem: string;
  concepts: unknown[];
  pitfalls: unknown[];
  realworld: string;
  practice: string;
  resources: unknown[];
  prerequisites: unknown[];
  level: number;
  tier: string;
  raw_status: string;
  notes: string;
  number: string;
  lesson_md: string;
  lesson: string;
  pool: Record<string, any>;
  anchors: AnchorMatch[];
  orphan_keys: string[];
  /** 与 orphan_keys 同源，另带键在题库文件里的行号与题数（旧实现没有任何消费方） */
  orphans: { key: string; line: number; count: number }[];
  /** 题库里每道题的题型结论（未知题型 / 字段不全），带题库文件与行号 */
  question_kinds: PoolKindIssue[];
  /** 这个节点的作答数据（attempts/<NNNN>-<节点id>.json）；没作答过就是空 */
  attempts: AttemptsView;
  lab: Lab | null;
}

/** 阅读端要的作答数据：**只服务当场回顾**（「上次你选了 B」），不做汇总视图、不排期。 */
interface AttemptsView {
  /** 文件在不在——界面据此区分「没作答过」与「读不到」 */
  present: boolean;
  /** 写回时把它当 expectedVersion 带上来 */
  version: string;
  /** 题 id（<锚点文本>#<题号>）→ 这道题的作答记录 */
  questions: Record<string, unknown>;
}

/** 大纲里的一条边。 */
interface SubjectEdge {
  from: unknown;
  to: unknown;
  reason: unknown;
}

/** 一份科目的 payload。 */
interface SubjectPayload {
  slug: string;
  name: string;
  goal: string;
  status: string;
  created_at: string;
  updated_at: string;
  project: string;
  mission: Mission;
  glossary: GlossaryGroup[];
  resources_md: string;
  reference: ReferenceEntry[];
  reference_version: string;
  /**
   * 误解记录（单一落点：misconceptions.yaml）。旧文件里 progress.yaml 也有一份——
   * 那份**不再读**：双落点只会带来不同步（目标态规格 §5.4）。旧文件仍在盘上、仍读得进，
   * 只是不再进 payload。
   */
  misconceptions: Misconception[];
  misconception_library: Misconception[];
  /** 旧写法的迁移提示（可展示，不阻断）：读得进，写回时按新字段收敛 */
  misconception_issues: string[];
  records: LearningRecord[];
  nodes: SubjectNode[];
  edges: SubjectEdge[];
  levels: number;
  stats: Record<string, number>;
  continue_node: string;
  order: Record<string, number>;
}

/** 阅读端拿到的整份快照。 */
interface LibraryPayload {
  workspace: string;
  generated_at: string;
  today: string;
  memory_md: string;
  subjects: SubjectPayload[];
}

/* ── 三档词表（目标态规格 §5.2）─────────────────────────────────────────────
   词表与旧六档映射的**唯一实现**在 `lib/core/rules.ts`（issue #67 收编，`validate.ts` 也用它）。
   这里只做一次类型收窄：`toTier` 吃 unknown、吐 `Tier`，读到不认识的词退回「未开始」。 */
function tint(raw: unknown): string {
  return toTier(raw);
}

/** stats 与「继续学」按这三档数；顺序即界面上的显示顺序。 */
const TIERS = ['未开始', '学习中', '已学完'];

/* ── 与 Python 对齐的小工具 ────────────────────────────────────────────── */

// 同一份字符集也出现在 yaml.ts 里（Python 的 \s / str.strip() 认的空白）。
// JS 的 \s 多一个 \ufeff、少 \x1c-\x1f，行尾处理必须逐字对齐 Python，所以显式写出来。
const PY_WS = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_RSTRIP_RE = new RegExp(`[${PY_WS}]+$`);
const PY_LINE_BREAK_RE = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

function pyRstrip(text: string): string {
  return String(text).replace(PY_RSTRIP_RE, '');
}

/** 等价于 Python 的 str.splitlines()（含它认的那一串少见换行符，且不留结尾空串）。 */
function pySplitLines(text: string): string[] {
  if (text === '') return [];
  const parts = String(text).split(PY_LINE_BREAK_RE);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** 等价于 Python 的 str()：日志与时间戳字段在参考实现里都过了 str()。 */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  return String(value);
}

/** Python 的 dict.get(k, default)：键存在但值是 null 时不套用默认值。 */
function pick(object: Record<string, any> | null | undefined, key: string, fallback: unknown): any {
  return object && Object.hasOwn(object, key) ? object[key] : fallback;
}

/* ── 读盘 ──────────────────────────────────────────────────────────────── */

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** 读文本；不存在或读不动都返回 null，交给调用方给默认值。缺文件不该让整份 payload 崩掉。 */
function readTextIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 目录下一层的名字，排序用码位比较（与 Python 的 sorted() 一致）。 */
function listNames(dir: string, { filesOnly = true, suffix = '' }: { filesOnly?: boolean; suffix?: string } = {}): string[] {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => (!filesOnly || entry.isFile()) && entry.name.endsWith(suffix))
    .map((entry) => entry.name)
    .sort(cmpCodePoints);
}

function readYaml(file: string): Record<string, any> {
  const text = readTextIfPresent(file);
  if (text === null) return {}; // 与参考实现一致：文件不存在 → {}，不崩
  // 解析器给的是 unknown：文件里的形状本来就没有静态契约，逐字段的检查活在各调用点
  return (parseYaml(text, { file }) || {}) as Record<string, any>;
}

function readYamlList(file: string): any[] {
  if (!isFile(file)) return [];
  // isFile 已经证明读得到；解析器只接受字符串，这里按它的契约收窄
  return (parseYaml(readTextIfPresent(file) as string, { file }) || []) as any[];
}

/** 收集一棵目录下所有文件的名字（只要 basename，与参考实现的 rglob + p.name 一致）。 */
function collectFileNames(root: string, depth = 0): string[] {
  if (depth > 32) return []; // 符号链接成环时 Python 的 rglob 会一直绕；这里主动截断
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    let stat;
    try {
      stat = fs.statSync(full); // 跟随符号链接，与 Python 的 Path.is_file() 一致
    } catch {
      continue; // 断链：Python 那边 is_file() 也是 False
    }
    if (stat.isDirectory()) names.push(...collectFileNames(full, depth + 1));
    else if (stat.isFile()) names.push(entry.name);
  }
  return names;
}

/* ── 课件与锚点 ────────────────────────────────────────────────────────── */

/**
 * 课件文件名是 <序号>-<节点id>.md，节点 id 里带点，按后缀匹配最稳。
 * 同前缀有多个时取排序后第一个，与参考实现一致。
 */
function findLesson(lessonsDir: string, nodeId: string): string | null {
  for (const name of listNames(lessonsDir, { suffix: '.md' })) {
    if (name.slice(0, -3).endsWith('-' + nodeId)) return name;
  }
  return null;
}

function lessonNumber(fileName: string | null): string {
  if (!fileName) return '';
  const match = /^(\d+)/.exec(fileName.slice(0, -3));
  return match ? match[1] : '';
}

/* 锚点的解析与对账**不在这里**——去 lib/core/anchors.ts（只有一份实现）。 */

/* ── 附件类文件的解析 ──────────────────────────────────────────────────── */

/** GLOSSARY.md 按 `## 分组` + `**词**: 释义` + `_Avoid_: ...` 三段式。 */
function parseGlossary(markdown: string): GlossaryGroup[] {
  const groups: GlossaryGroup[] = [];
  let current: GlossaryGroup | null = null;
  let term: GlossaryTerm | null = null;
  for (const raw of pySplitLines(markdown)) {
    const line = pyRstrip(raw);
    if (line.startsWith('## ')) {
      current = { title: pyStrip(line.slice(3)), terms: [] };
      groups.push(current);
      term = null;
    } else if (line.startsWith('**') && line.includes('**:') && current !== null) {
      // 词条头的 `**` 与结尾的 `**:` 之间是词名，后面跟的才是释义
      const split = line.slice(2).indexOf('**:');
      term = {
        term: pyStrip(line.slice(2, 2 + split)),
        def: pyStrip(line.slice(2 + split + 3)),
        avoid: '',
      };
      current.terms.push(term);
    } else if (line.startsWith('_Avoid_:') && term !== null) {
      term.avoid = pyStrip(line.slice(8));
    } else if (line !== '' && term !== null && term.avoid === '') {
      // _Avoid_ 之前的续行都算释义（释义折行的情况）
      term.def = pyStrip(term.def + ' ' + pyStrip(line));
    }
  }
  return groups;
}

/** MISSION.md 是 `## 小节` + 列表；Why 那节是散文，成功标准那节是列表，两种都收。 */
function parseMission(markdown: string): Mission {
  const sections = new Map<string, string[]>();
  let title: string | null = null;
  const push = (key: string, value: string) => {
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key)!.push(value);
  };
  for (const raw of pySplitLines(markdown)) {
    const line = pyRstrip(raw);
    if (line.startsWith('# ')) {
      push('_title', pyStrip(line.slice(2)));
    } else if (line.startsWith('## ')) {
      title = pyStrip(line.slice(3));
      if (!sections.has(title)) sections.set(title, []);
    } else if (title && pyStrip(line).startsWith('- ')) {
      push(title, pyStrip(pyStrip(line).slice(2)));
    } else if (title && pyStrip(line) !== '') {
      push(title, pyStrip(line));
    }
  }
  return {
    title: (sections.get('_title') || [''])[0],
    sections: Object.fromEntries([...sections].filter(([key]) => key !== '_title')),
  };
}

function readRecords(recordsDir: string): LearningRecord[] {
  const out: LearningRecord[] = [];
  for (const name of listNames(recordsDir, { suffix: '.md' })) {
    const markdown = readTextIfPresent(path.join(recordsDir, name)) ?? '';
    const lines = pySplitLines(markdown);
    const heading = lines.find((line) => line.startsWith('# '));
    // 找不到一级标题就用文件名兜底，别让一条学习记录在界面上没有名字
    const title = heading === undefined ? name.replace(/\.[^.]*$/, '') : pyStrip(heading.slice(2));
    const dateLine = lines.find((line) => line.startsWith('- 日期：'));
    const date = dateLine === undefined ? '' : pyStrip(dateLine.slice(dateLine.indexOf('：') + 1));
    out.push({ file: name, title, date, markdown });
  }
  return out;
}

/**
 * lab 目录按 <序号>-<短名> 命名，序号与课件位次对齐（lab/0003-ip-subnet → 第 3 课）。
 * README 取的是 lab/ 自己那份（不是每次实验目录里的），与参考实现一致。
 */
function readLab(labDir: string, number: string): Lab | null {
  if (!number || !isDirectory(labDir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(labDir, { withFileTypes: true });
  } catch {
    return null;
  }
  // 显式写成 string | undefined：空数组时下标 0 取不到东西，下面的分支靠它兜住
  const match: string | undefined = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(number + '-') && entry.name !== 'solutions')
    .map((entry) => entry.name)
    .sort(cmpCodePoints)[0];
  if (match === undefined) return null;
  return {
    dir: match,
    files: collectFileNames(path.join(labDir, match)).sort(cmpCodePoints),
    readme: readTextIfPresent(path.join(labDir, 'README.md')) ?? '',
  };
}

/* ── 分层 ──────────────────────────────────────────────────────────────── */

/**
 * 按前置依赖分层：层号 = 到根的最长路径，路线图按它排。
 * 大纲里意外成环时按 0 切断（visited 里出现过就不再往下），不能无限递归。
 */
function levelsOf(nodes: any[]): Record<string, number> {
  const byId = new Map<string, any>();
  for (const node of nodes) byId.set(node.id, node); // 同 id 后者覆盖，同 Python 的字典推导
  const memo = new Map<string, number>();

  const depth = (nodeId: string, seen: Set<string>): number => {
    if (memo.has(nodeId)) return memo.get(nodeId)!;
    if (seen.has(nodeId)) return 0;
    const node = byId.get(nodeId);
    if (!node) return 0;
    const prerequisites = (node.prerequisites || []).filter((id: string) => byId.has(id));
    let value = 0;
    if (prerequisites.length > 0) {
      const next = new Set(seen);
      next.add(nodeId);
      value = 1 + Math.max(...prerequisites.map((id: string) => depth(id, next)));
    }
    memo.set(nodeId, value);
    return value;
  };

  const levels: Record<string, number> = {};
  for (const node of nodes) levels[node.id] = depth(node.id, new Set());
  return levels;
}

/* ── 科目 ──────────────────────────────────────────────────────────────── */

function buildSubject(subjectDir: string, dirName: string, workspace: string): SubjectPayload {
  const subject = readYaml(path.join(subjectDir, 'subject.yaml'));
  const curriculum = readYaml(path.join(subjectDir, 'curriculum.yaml'));
  const progress = readYaml(path.join(subjectDir, 'progress.yaml'));
  const slug = subject.slug || dirName;

  const nodesIn: any[] = curriculum.nodes || [];
  if (!Array.isArray(nodesIn)) {
    throw new Error(`curriculum.yaml 的 nodes 不是列表：${path.join(subjectDir, 'curriculum.yaml')}`);
  }
  const edgesIn: any[] = curriculum.edges || [];
  const progressNodes = pick(progress, 'nodes', null) || {};
  const levels = levelsOf(nodesIn);
  const lessonsDir = path.join(subjectDir, 'lessons');

  const nodes: SubjectNode[] = [];
  for (const node of nodesIn) {
    const nodeId = node.id;
    const lessonFile = findLesson(lessonsDir, String(nodeId));
    const number = lessonNumber(lessonFile);
    const lessonMarkdown = lessonFile === null
      ? ''
      : readTextIfPresent(path.join(lessonsDir, lessonFile)) ?? '';

    // 题库路径是把课件的 .md 换成 .quiz.json（不是追加），与参考实现的 with_suffix 一致
    const poolFile = lessonFile === null
      ? null
      : path.join(lessonsDir, lessonFile.replace(/\.md$/, '.quiz.json'));
    let pool = {};
    let poolRaw = '';
    if (poolFile !== null && isFile(poolFile)) {
      const raw = readTextIfPresent(poolFile);
      poolRaw = raw ?? '';
      try {
        // isFile 已经证明读得到，只是类型系统看不见（与 readYamlList 同一个口径）
        pool = JSON.parse(raw as string) || {};
      } catch (error) {
        throw new Error(`题库不是合法 JSON：${poolFile}\n    ${(error as Error).message}`);
      }
    }
    // 四态由 lib/core/anchors.ts 判定（多匹配绝不静默取第一个）；orphans 是一等结论，
    // 除了旧的 orphan_keys 还多留一个带行号与题数的 orphans，阅读端想显示就有得显示。
    const { anchors, orphanKeys, orphans } = reconcileAnchors(parseAnchors(lessonMarkdown), pool, {
      poolFile: poolFile === null ? '' : path.basename(poolFile),
    });
    // 题型与字段：未知题型要带**题库文件与行号**报出来（旧题库不写 kind，按字段推断，照旧读得进）
    const questionKinds = checkPoolKinds(pool, {
      poolFile: poolFile === null ? '' : path.basename(poolFile),
      poolRaw,
    });
    // 作答数据：与课件一一对应，只服务当场回顾；读不到就当没作答过（派生记录，坏了不抛）
    const attempt = lessonFile === null
      ? null
      : readAttempts({ workspace, subject: slug, node: nodeId });

    const run = (Object.hasOwn(progressNodes, nodeId) ? progressNodes[nodeId] : null) || {};
    // progress 只记有变化的节点，没写的按大纲里的初始快照算
    const rawStatus = run.status || node.status || '未开始';

    nodes.push({
      id: nodeId,
      title: pick(node, 'title', nodeId),
      kind: pick(node, 'kind', '概念'),
      objective: pick(node, 'objective', ''),
      problem: pick(node, 'problem', ''),
      concepts: node.concepts || [],
      pitfalls: node.pitfalls || [],
      realworld: pick(node, 'realworld', ''),
      practice: pick(node, 'practice', ''),
      resources: node.resources || [],
      prerequisites: node.prerequisites || [],
      level: Object.hasOwn(levels, nodeId) ? levels[nodeId] : 0,
      tier: tint(rawStatus),
      raw_status: rawStatus,
      notes: pick(run, 'notes', ''),
      number,
      // 课件正文整段内联：页面拿到 payload 就该能直接渲染，不必再回主机取一次
      lesson_md: lessonMarkdown,
      // 文件名也留着：正文里的相对图片是按 lessons/ 解析的，页面要靠它拼基准路径
      lesson: lessonFile === null ? '' : `${slug}/${lessonFile}`,
      pool,
      anchors,
      orphan_keys: orphanKeys,
      orphans,
      question_kinds: questionKinds,
      attempts: {
        present: attempt !== null,
        version: attempt === null
          ? attemptsVersion({ workspace, subject: slug, node: nodeId })
          : attempt.version,
        questions: attempt === null ? {} : attempt.data.题,
      },
      lab: readLab(path.join(subjectDir, 'lab'), number),
    });
  }

  const stats: Record<string, number> = {};
  for (const tier of TIERS) stats[tier] = nodes.filter((node) => node.tier === tier).length;

  // 「继续学」的候选：先找学习中的，没有就找第一个未开始的，全学完则回到最后一个节点
  const current: SubjectNode | null = nodes.find((node) => node.tier === '学习中')
    || nodes.find((node) => node.tier === '未开始')
    || (nodes.length > 0 ? nodes[nodes.length - 1] : null);

  const order: Record<string, number> = {};
  nodes.forEach((node, index) => { order[node.id] = index; });

  // 参考资料：与资料收集角色同放 reference/ 的本地教材、速查页与学生自加的讲义（ADR-0010）。
  // 清单与版本号必须同源，所以一起从 lib/reference.ts 取；目录不存在时给空清单 + 空清单的
  // 版本号（**不能给空串**：空串会让「第一次往空目录里写」没法带期望版本）。
  const { entries: reference, version: reference_version } = listReference({ subjectDir });

  // 误解记录：**只有一个落点**（misconceptions.yaml，目标态规格 §5.4）。progress.yaml 里那份
  // 旧副本不再读——双落点只会带来不同步。旧文件仍在盘上、仍读得进（不报错），只是不进 payload。
  const misconceptionRaw = readYamlList(path.join(subjectDir, 'misconceptions.yaml'));
  const misconceptions = normalizeMisconceptions(misconceptionRaw);
  const misconceptionIssues: string[] = [];
  misconceptionRaw.forEach((item, index) => {
    misconceptionIssues.push(...misconceptionIssuesOf(item, index));
  });

  return {
    slug,
    name: pick(subject, 'name', slug),
    goal: pick(subject, 'goal', ''),
    status: pick(subject, 'status', ''),
    created_at: pyStr(pick(subject, 'created_at', '')),
    updated_at: pyStr(pick(progress, 'updated_at', '')),
    project: (pick(progress, 'project', null) || {}).current || '',
    mission: parseMission(readTextIfPresent(path.join(subjectDir, 'MISSION.md')) ?? ''),
    glossary: parseGlossary(readTextIfPresent(path.join(subjectDir, 'GLOSSARY.md')) ?? ''),
    resources_md: readTextIfPresent(path.join(subjectDir, 'RESOURCES.md')) ?? '',
    reference,
    reference_version,
    misconceptions,
    // 与 misconceptions 同源：两份字段名都留着，阅读端从哪一份读都拿得到同一个结果
    misconception_library: misconceptions,
    misconception_issues: misconceptionIssues,
    records: readRecords(path.join(subjectDir, 'learning-records')),
    nodes,
    edges: edgesIn.map((edge) => {
      if (!edge || typeof edge !== 'object' || !Object.hasOwn(edge, 'from') || !Object.hasOwn(edge, 'to')) {
        throw new Error(`curriculum.yaml 的 edges 里有缺少 from/to 的项：${JSON.stringify(edge)}`);
      }
      return { from: edge.from, to: edge.to, reason: pick(edge, 'reason', '') };
    }),
    levels: nodes.length === 0 ? 0 : Math.max(...Object.values(levels), 0) + 1,
    stats,
    continue_node: current === null ? '' : current.id,
    order,
  };
}

/* ── 入口 ──────────────────────────────────────────────────────────────── */

/**
 * 读一个学习工作区，产出阅读端要的整份 JSON。
 *
 * @param {{workspace: string, root?: string}} options
 *   workspace：工作区目录（其中含 .learning/），相对路径按 root（默认进程 cwd）解析；
 *   root：项目根，只用来解析相对路径。
 * @returns {object} 可直接 JSON.stringify 的 payload
 */
export function buildLibrary(options: { workspace?: string; root?: string } = {}): LibraryPayload {
  const { workspace: workspaceOption } = options;
  if (typeof workspaceOption !== 'string' || workspaceOption === '') {
    throw new Error('buildLibrary 需要 workspace：学习工作区目录的路径（其中应含 .learning/subjects/）');
  }
  const base = options.root ? path.resolve(options.root) : process.cwd();
  const workspace = path.resolve(base, workspaceOption);
  const learningDir = path.join(workspace, '.learning');
  const subjectsDir = path.join(learningDir, 'subjects');

  if (!isDirectory(subjectsDir)) {
    throw new Error(`找不到学习工作区：${subjectsDir} 不是目录（workspace=${workspace}）`);
  }

  const subjectDirs = fs.readdirSync(subjectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(cmpCodePoints);

  // 建课时会先建目录再填内容，所以零节点的科目直接跳过，不出现在阅读端。
  const subjects: SubjectPayload[] = [];
  for (const name of subjectDirs) {
    const subject = buildSubject(path.join(subjectsDir, name), name, workspace);
    if (subject.nodes.length > 0) subjects.push(subject);
  }
  /* 一个可用科目都没有时给一份**空清单**，不抛错：这是「工作区在、课还没建」，
     不是读盘失败。原来这里抛错，页面于是只能显示「读不到学习工作区」那张错误卡——
     把「还没有科目」说成了「读不出来」，而阅读端本来就有一条 `subjects.length === 0`
     的空态分支（`lib/client.js` 的主页壳）能照实说这句话；原生工具那一侧同一条判据
     也早就写着「有目录但没有可用科目（建课建到一半）也算『还没有科目』，照实说而不是崩」
     （`lib/tools/context.ts` 现在把这句话自己说出来了）。真正该报「读不到工作区」的只剩
     上面那条：`.learning/subjects/` 这个目录根本不在。 */

  // 注意：这里与参考实现一样取**字典序**最大再截前 10 位，不是按时间先后比大小。
  // 两种写法在 updated_at 混用「只有日期」与「带时区时间戳」时结果不同，见交付说明。
  const updated = subjects.map((subject) => subject.updated_at).filter(Boolean).sort(cmpCodePoints);

  return {
    workspace,
    generated_at: new Date().toISOString(),
    today: updated.length === 0 ? '' : updated[updated.length - 1].slice(0, 10),
    memory_md: readTextIfPresent(path.join(learningDir, 'MEMORY.md')) ?? '',
    subjects,
  };
}

/** 读盘并构建。与 buildLibrary 同一实现，只是名字更贴合调用点的读法。 */
export function readLibrary(options: { workspace?: string; root?: string } = {}): LibraryPayload {
  return buildLibrary(options);
}

export default buildLibrary;
