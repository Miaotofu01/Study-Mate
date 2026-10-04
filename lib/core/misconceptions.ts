/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 —— 误解记录的字段定型（目标态规格 §5.4）

   误解记录今天有**两个落点**：`progress.yaml` 的 `misconceptions` 与 `misconceptions.yaml`。
   双落点是为了让进度文件自包含；进度已精简为三档，重复存储只会带来不同步。目标态只保留
   `misconceptions.yaml`，字段定型为：

     topic（卡在哪）/ source（从哪来）/ evidence（证据）/ status（处置到哪）/ at（时间）

   这一层管的是**归一**：旧文件（`date` / `node` / `question` / `misunderstanding` /
   `answer_summary` / `follow_up` / `importance`）必须照旧读得进——学习档案是学生的积累，
   换字段名不该让任何一条记录读不出来。归一的结果与 `schemas/misconceptions.schema.json`
   逐字对应；`issues()` 把「这条是旧写法、哪几个字段被搬走了」说清楚，别让迁移静默发生。

   纯函数域：出入都是值，不碰文件系统（`decisions.md` §2）。
   ───────────────────────────────────────────────────────────────────────── */

/** 从哪来。三个值就是目标态 §5.4 点名的三个入口。 */
export const MISCONCEPTION_SOURCES = ['问答面板', '讲解反馈', '实验课验收'] as const;
export type MisconceptionSource = (typeof MISCONCEPTION_SOURCES)[number];

/** 处置到哪一步。默认「未处理」——新记录不写状态时按没处理算，宁可催一次也别漏一条。 */
export const MISCONCEPTION_STATUSES = ['未处理', '已补练', '已消解'] as const;
export type MisconceptionStatus = (typeof MISCONCEPTION_STATUSES)[number];

/** 归一之后的一条误解记录（与 schema 的字段逐个相等）。 */
export interface Misconception {
  /** 卡在哪 */
  topic: string;
  /** 从哪来 */
  source: string;
  /** 证据：提问原文、作答引用或验收结论 */
  evidence: string;
  /** 处置到哪一步 */
  status: string;
  /** 时间 */
  at: string;
  /** 旧字段原样留着（node / importance / follow_up / answer_summary）：界面还要显示，别在归一里丢掉 */
  legacy?: Record<string, unknown>;
}

/** 旧字段 → 新字段的搬运表。顺序即 `issues()` 的报出顺序。 */
const LEGACY_MOVES: ReadonlyMap<string, string> = new Map([
  ['date', 'at'],
  ['question', 'evidence'],
  ['misunderstanding', 'evidence'],
  ['answer_summary', 'evidence'],
]);

/** 旧记录里出现过、且归一之后**不再是一等字段**的键（留着是为了不丢信息，不是为了继续写）。 */
const LEGACY_KEYS = ['date', 'node', 'question', 'misunderstanding', 'answer_summary', 'follow_up', 'importance'];

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 一条（可能来自旧文件的）记录 → 定型后的 `Misconception`。
 *
 * `topic` 是唯一必填项：它决定这条记录在界面上叫什么。连它都没有（一条完全空的记录）
 * 返回 `null`——**不猜**：给一条没有名字的记录编一个 topic，等于在学生的档案里写假数据。
 */
export function normalizeMisconception(raw: unknown): Misconception | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const topic = text(item.topic);
  if (topic === '') return null;

  // evidence 是必填的：旧文件里它可能落在三个不同的字段上（提问原文 / 误解描述 / 当时怎么解的），
  // 按「提问原文 → 误解描述 → 当时怎么解的」的顺序取第一个非空值——三个都在时提问原文信息最多。
  const evidence = text(item.evidence)
    || text(item.question)
    || text(item.misunderstanding)
    || text(item.answer_summary);

  const legacy: Record<string, unknown> = {};
  for (const key of LEGACY_KEYS) {
    if (Object.hasOwn(item, key)) legacy[key] = item[key];
  }

  return {
    topic,
    // source 是新的必填项，旧记录里没有：给「讲解反馈」——旧记录全是讲解/答疑过程中留下的，
    // 这个值最接近事实；写 `问答面板` 会把当时总控在对话里解的那些也算成面板提问。
    source: text(item.source) || '讲解反馈',
    evidence,
    status: text(item.status) || '未处理',
    at: text(item.at) || text(item.date),
    ...(Object.keys(legacy).length > 0 ? { legacy } : {}),
  };
}

/** 一份 `misconceptions.yaml`（数组）→ 定型后的记录；不是数组或读不出内容时给空数组。 */
export function normalizeMisconceptions(raw: unknown): Misconception[] {
  if (!Array.isArray(raw)) return [];
  const out: Misconception[] = [];
  for (const item of raw) {
    const one = normalizeMisconception(item);
    if (one !== null) out.push(one);
  }
  return out;
}

/**
 * 一条记录里「旧写法」的提示（可展示，不阻断）。
 *
 * 为什么要有：字段搬运只发生在读的时候，学生与维护者看到的却是结果——不说一声，
 * 下一次写盘时旧字段静默消失，没人知道为什么。
 */
export function misconceptionIssues(raw: unknown, index = 0): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const item = raw as Record<string, unknown>;
  const issues: string[] = [];
  const moved = [...LEGACY_MOVES]
    .filter(([key]) => Object.hasOwn(item, key) && text(item[key]) !== '')
    .map(([key, to]) => `${key} → ${to}`);
  if (moved.length > 0) {
    issues.push(`第 ${index + 1} 条误解记录是旧写法（${moved.join('、')}）：读得进，写回时按新字段收敛`);
  }
  if (!text(item.source)) issues.push(`第 ${index + 1} 条误解记录缺 source（从哪来），按「讲解反馈」算`);
  if (!text(item.status)) issues.push(`第 ${index + 1} 条误解记录缺 status（处置到哪），按「未处理」算`);
  if (!text(item.at) && !text(item.date)) issues.push(`第 ${index + 1} 条误解记录缺 at（时间），界面上的日期会空着`);
  return issues;
}
