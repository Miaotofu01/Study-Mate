/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 半数据层 —— 学习工作区 → 阅读端要的那一份 JSON

   方向是 **agent → 文件 → 页面**：Host 半读真工作区，把整个库抽成一份自足的快照。
   自足是要点：课件的 Markdown 正文**内联**进 payload（lesson_md），题库整段内联（pool），
   页面拿到这一份 JSON 就该能画出全部内容，不需要再回主机取第二次。

   这份实现是 prototype/reading-client/tools/build-data.py 的 JS 版，语义逐条对齐它：
   三档状态映射、按前置依赖分层、锚点四态对账、术语表 / Mission / 学习记录 / lab 的解析口径、
   「继续学」的挑选顺序、零节点科目跳过、无可读科目时报错。刻意不同的地方只有三处，
   都写在各自位置的注释里：
     1. 课件正文内联（lesson_md），不再让前端去 fetch lessons/<slug>/<file>.md；
     2. 顶层多出 workspace 与 memory_md（Host 半要知道自己在读哪个库、共享记忆是什么）；
     3. 顶层不再有 source / note —— 那是原型构建脚本自己的元信息（相对路径、"
        由 tools/build-data.py 抽出"），放进插件 payload 会误导人。

   缺失的可选文件一律给空值，不抛错；但 YAML 里出现本解析器不支持的构造时**必须**抛错，
   那是真错，不是缺失。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, pyStrip } from './yaml.mjs';
// reference/ 的清单与版本号放在 lib/reference.mjs：写入端要用同一套规则算版本号（并发栅栏），
// 两边各写一份就会出现「明明没人动过却报冲突」。这里只把结果挂进 payload。
import { listReference } from './reference.mjs';

/* ── 三档词表（目标态规格 §5.2）─────────────────────────────────────────────
   旧词表读到就映射，写回一律用新词表。用 Map 不用普通对象：状态值来自文件，
   若恰好是 "constructor" 之类会撞上 Object.prototype，静默取到一个函数。 */
const TIER_MAP = new Map([
  ['未开始', '未开始'],
  ['学习中', '学习中'],
  ['初步理解', '学习中'],
  ['能独立应用', '已学完'],
  ['需要复习', '已学完'],
  ['已通过项目验证', '已学完'],
]);
const TIERS = ['未开始', '学习中', '已学完'];

/** 旧词表 → 三档。读到不认识的词退回「未开始」，绝不静默当成学会了。 */
function tint(raw) {
  return TIER_MAP.get(raw || '') || '未开始';
}

/* ── 与 Python 对齐的小工具 ────────────────────────────────────────────── */

// 同一份字符集也出现在 yaml.mjs 里（Python 的 \s / str.strip() 认的空白）。
// JS 的 \s 多一个 \ufeff、少 \x1c-\x1f，锚点归一化必须逐字对齐 Python，所以显式写出来。
const PY_WS = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
// 量词只能挂在字符类上，所以单独留一份带方括号的写法（写成 `${PY_WS}*` 会退化成字面序列）
const PY_WS_CLASS = `[${PY_WS}]`;
const PY_RSTRIP_RE = new RegExp(`[${PY_WS}]+$`);
const PY_NORM_RE = new RegExp(`[${PY_WS}]+`, 'g');
const PY_LINE_BREAK_RE = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

function pyRstrip(text) {
  return String(text).replace(PY_RSTRIP_RE, '');
}

/** 等价于 Python 的 str.splitlines()（含它认的那一串少见换行符，且不留结尾空串）。 */
function pySplitLines(text) {
  if (text === '') return [];
  const parts = String(text).split(PY_LINE_BREAK_RE);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** 等价于 Python 的 str()：日志与时间戳字段在参考实现里都过了 str()。 */
function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  return String(value);
}

/** Python 的 dict.get(k, default)：键存在但值是 null 时不套用默认值。 */
function pick(object, key, fallback) {
  return object && Object.hasOwn(object, key) ? object[key] : fallback;
}

/** Python 的 sorted() 按码位比较；JS 的 < 按 UTF-16 码元比较，遇到增补平面字符会分叉。 */
function cmpCodePoints(a, b) {
  const left = [...a];
  const right = [...b];
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const x = left[i].codePointAt(0);
    const y = right[i].codePointAt(0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

/* ── 读盘 ──────────────────────────────────────────────────────────────── */

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** 读文本；不存在或读不动都返回 null，交给调用方给默认值。缺文件不该让整份 payload 崩掉。 */
function readTextIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 目录下一层的名字，排序用码位比较（与 Python 的 sorted() 一致）。 */
function listNames(dir, { filesOnly = true, suffix = '' } = {}) {
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

function readYaml(file) {
  const text = readTextIfPresent(file);
  if (text === null) return {}; // 与参考实现一致：文件不存在 → {}，不崩
  return parseYaml(text, { file }) || {};
}

function readYamlList(file) {
  if (!isFile(file)) return [];
  return parseYaml(readTextIfPresent(file), { file }) || [];
}

/** 收集一棵目录下所有文件的名字（只要 basename，与参考实现的 rglob + p.name 一致）。 */
function collectFileNames(root, depth = 0) {
  if (depth > 32) return []; // 符号链接成环时 Python 的 rglob 会一直绕；这里主动截断
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
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
function findLesson(lessonsDir, nodeId) {
  for (const name of listNames(lessonsDir, { suffix: '.md' })) {
    if (name.slice(0, -3).endsWith('-' + nodeId)) return name;
  }
  return null;
}

function lessonNumber(fileName) {
  if (!fileName) return '';
  const match = /^(\d+)/.exec(fileName.slice(0, -3));
  return match ? match[1] : '';
}

// `::: quiz <层级> 锚点：<文本>`：层级是四层题型名，正文其余块由浏览器侧渲染，这里只认声明。
const ANCHOR_RE = new RegExp(
  `^:::${PY_WS_CLASS}*quiz${PY_WS_CLASS}+([^${PY_WS}]+)${PY_WS_CLASS}+锚点：(.*?)${PY_WS_CLASS}*$`,
  'gm',
);

function lessonAnchors(markdown) {
  ANCHOR_RE.lastIndex = 0; // 带 g 的正则是有状态的，上一次的 lastIndex 会漏掉开头的锚点
  return [...markdown.matchAll(ANCHOR_RE)].map((match) => ({ level: match[1], text: match[2] }));
}

/** 归一化只抹掉空白与全角空格——用来区分「逐字一致」与「只差空白」。 */
function normalizeAnchor(text) {
  return String(text).replace(PY_NORM_RE, '');
}

/**
 * 锚点 ↔ 题库键对账，四态：resolved / stale / ambiguous / missing（目标态规格 §4.4）。
 * 多匹配绝不静默取第一个：ambiguous 原样报出来，让界面去问人。
 */
function resolveAnchors(declared, pool) {
  const poolKeys = Object.keys(pool);
  const exact = new Map();
  for (const key of poolKeys) exact.set(pyStrip(key), key); // 后写的覆盖先写的，同 Python 的字典推导

  const byNormalized = new Map();
  for (const key of poolKeys) {
    const normalized = normalizeAnchor(key);
    if (!byNormalized.has(normalized)) byNormalized.set(normalized, []);
    byNormalized.get(normalized).push(key);
  }

  const anchors = [];
  const used = new Set();
  for (const item of declared) {
    const text = pyStrip(item.text);
    const entry = { text, level: item.level, resolution: 'missing', keys: [] };
    if (exact.has(text)) {
      entry.resolution = 'resolved';
      entry.keys = [exact.get(text)];
    } else {
      const candidates = byNormalized.get(normalizeAnchor(text)) || [];
      if (candidates.length > 1) {
        entry.resolution = 'ambiguous';
        entry.keys = [...candidates].sort(cmpCodePoints);
      } else if (candidates.length === 1) {
        entry.resolution = 'stale';
        entry.keys = [candidates[0]];
      }
    }
    for (const key of entry.keys) used.add(key);
    anchors.push(entry);
  }

  // 题库里有、正文里没声明的锚点：正文与题库脱钩的另一半，界面也要能看见
  const orphanKeys = poolKeys.filter((key) => !used.has(key)).sort(cmpCodePoints);
  return { anchors, orphanKeys };
}

/* ── 附件类文件的解析 ──────────────────────────────────────────────────── */

/** GLOSSARY.md 按 `## 分组` + `**词**: 释义` + `_Avoid_: ...` 三段式。 */
function parseGlossary(markdown) {
  const groups = [];
  let current = null;
  let term = null;
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
function parseMission(markdown) {
  const sections = new Map();
  let title = null;
  const push = (key, value) => {
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key).push(value);
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

function readRecords(recordsDir) {
  const out = [];
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
function readLab(labDir, number) {
  if (!number || !isDirectory(labDir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(labDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const match = entries
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
function levelsOf(nodes) {
  const byId = new Map();
  for (const node of nodes) byId.set(node.id, node); // 同 id 后者覆盖，同 Python 的字典推导
  const memo = new Map();

  const depth = (nodeId, seen) => {
    if (memo.has(nodeId)) return memo.get(nodeId);
    if (seen.has(nodeId)) return 0;
    const node = byId.get(nodeId);
    if (!node) return 0;
    const prerequisites = (node.prerequisites || []).filter((id) => byId.has(id));
    let value = 0;
    if (prerequisites.length > 0) {
      const next = new Set(seen);
      next.add(nodeId);
      value = 1 + Math.max(...prerequisites.map((id) => depth(id, next)));
    }
    memo.set(nodeId, value);
    return value;
  };

  const levels = {};
  for (const node of nodes) levels[node.id] = depth(node.id, new Set());
  return levels;
}

/* ── 科目 ──────────────────────────────────────────────────────────────── */

function buildSubject(subjectDir, dirName) {
  const subject = readYaml(path.join(subjectDir, 'subject.yaml'));
  const curriculum = readYaml(path.join(subjectDir, 'curriculum.yaml'));
  const progress = readYaml(path.join(subjectDir, 'progress.yaml'));
  const slug = subject.slug || dirName;

  const nodesIn = curriculum.nodes || [];
  if (!Array.isArray(nodesIn)) {
    throw new Error(`curriculum.yaml 的 nodes 不是列表：${path.join(subjectDir, 'curriculum.yaml')}`);
  }
  const edgesIn = curriculum.edges || [];
  const progressNodes = pick(progress, 'nodes', null) || {};
  const levels = levelsOf(nodesIn);
  const lessonsDir = path.join(subjectDir, 'lessons');

  const nodes = [];
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
    if (poolFile !== null && isFile(poolFile)) {
      const raw = readTextIfPresent(poolFile);
      try {
        pool = JSON.parse(raw) || {};
      } catch (error) {
        throw new Error(`题库不是合法 JSON：${poolFile}\n    ${error.message}`);
      }
    }
    const { anchors, orphanKeys } = resolveAnchors(lessonAnchors(lessonMarkdown), pool);

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
      lab: readLab(path.join(subjectDir, 'lab'), number),
    });
  }

  const stats = {};
  for (const tier of TIERS) stats[tier] = nodes.filter((node) => node.tier === tier).length;

  // 「继续学」的候选：先找学习中的，没有就找第一个未开始的，全学完则回到最后一个节点
  const current = nodes.find((node) => node.tier === '学习中')
    || nodes.find((node) => node.tier === '未开始')
    || (nodes.length > 0 ? nodes[nodes.length - 1] : null);

  const order = {};
  nodes.forEach((node, index) => { order[node.id] = index; });

  // 参考资料：与资料收集角色同放 reference/ 的本地教材、速查页与学生自加的讲义（ADR-0010）。
  // 清单与版本号必须同源，所以一起从 lib/reference.mjs 取；目录不存在时给空清单 + 空清单的
  // 版本号（**不能给空串**：空串会让「第一次往空目录里写」没法带期望版本）。
  const { entries: reference, version: reference_version } = listReference({ subjectDir });

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
    misconceptions: pick(progress, 'misconceptions', null) || [],
    // misconceptions.yaml 是与 progress.yaml 双落点的追加日志，两份都留着给界面核对
    misconception_library: readYamlList(path.join(subjectDir, 'misconceptions.yaml')),
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
export function buildLibrary(options = {}) {
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

  // 建课时会先建目录再填内容，所以零节点的科目直接跳过，不出现在阅读端
  const subjects = [];
  for (const name of subjectDirs) {
    const subject = buildSubject(path.join(subjectsDir, name), name);
    if (subject.nodes.length > 0) subjects.push(subject);
  }
  if (subjects.length === 0) {
    throw new Error(`学习工作区里没有可用科目：${subjectsDir} 下 ${subjectDirs.length} 个目录都没有节点`);
  }

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
export function readLibrary(options = {}) {
  return buildLibrary(options);
}

export default buildLibrary;
