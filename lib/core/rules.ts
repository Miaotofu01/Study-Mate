/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 —— 规则层

   黑盒门禁管的是「文件长得对不对」；这一层管的是**判定规则**本身：四层深度怎么算、
   题型能不能服务那一层、进度三档怎么走。这些东西今天散在技能提示词的自然语言里
   （`layered-practice` 的「四层」「四种题型」、`record-keeping` 的置位规则），
   模型每次都要重新读一遍、还可能读漏一条。搬成纯函数之后：**同一条规则只有一份**，
   而且能逐条断言。

   三条硬性质（也是 `decisions.md` §2 的由来）：
     1. **不依赖文件系统**——入口是值，出口是值，没有 `node:*`；
     2. **不读钟、不读随机数**——同样输入永远同样输出（判断进度要「延迟重测」这类
        时间判据时，时间由调用方算好、作为证据名传进来）；
     3. **不知道模型是谁**——「模型输出不能直接改进度状态」（规格 §7.5）在这里落地成：
        `advance` 只认证据，不认「谁说会了」。

   词表的口径以 `docs/设计/目标态规格.md` 为准：
     §7.1 四层（读懂 / 改对 / 查错 / 造出）、§7.2 四种题型、§7.3 判分三轨、
     §7.5 证据资格、§5.2 进度三档与旧六档映射。
   ───────────────────────────────────────────────────────────────────────── */

/* ══════════════════════════════════════════════════════════════════════
   一、四层：读懂 / 改对 / 查错 / 造出（规格 §7.1）
   ══════════════════════════════════════════════════════════════════════ */

export const LAYERS = ['读懂', '改对', '查错', '造出'] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * 一条判据的**证据字段**。字段名就是要看的那个事实，值是「这条事实成不成立」。
 * 不用枚举字符串当值：调用方给的是原始证据（学生说了什么、跑出来什么），
 * 「算不算说清了因果」这一步在这里定，别把判断推给调用方。
 */
export type EvidenceField =
  | 'explainsCause'        // 读懂：说清因果，不只给结论
  | 'statesPreconditions'  // 读懂：说清前提
  | 'predictedBeforeRun'   // 改对：先写预测，再跑起来验证
  | 'predictionMatches'    // 改对：预测与实测一致
  | 'explainedDifference'  // 改对：能解释预测与实测的差异
  | 'rootCause'            // 查错：说出根因
  | 'fix'                  // 查错：给出修复
  | 'prevention'           // 查错：给出预防
  | 'deliverableRuns'      // 造出：交付物能跑通
  | 'explainsTradeoffs';   // 造出：能解释取舍

export type LayerEvidence = Partial<Record<EvidenceField, boolean>>;

export interface Criterion {
  field: EvidenceField;
  label: string;
}

export interface LayerRule {
  layer: Layer;
  /** 规格 §7.1「通过标准」一列的原文，报告与页面直接引用它，不再抄第二份。 */
  display: string;
  /** 必须**全部**成立。 */
  allOf: readonly Criterion[];
  /** 至少一条成立；`allOf` 全中之后再看它。 */
  anyOf?: readonly Criterion[];
}

export const LAYER_RULES: Readonly<Record<Layer, LayerRule>> = {
  读懂: {
    layer: '读懂',
    display: '说清因果与前提',
    allOf: [
      { field: 'explainsCause', label: '说清因果，不只给结论' },
      { field: 'statesPreconditions', label: '说清前提' },
    ],
  },
  改对: {
    layer: '改对',
    display: '预测与实测一致，或能解释差异',
    allOf: [{ field: 'predictedBeforeRun', label: '先写下预测，再跑起来验证' }],
    anyOf: [
      { field: 'predictionMatches', label: '预测与实测一致' },
      { field: 'explainedDifference', label: '能解释预测与实测的差异' },
    ],
  },
  查错: {
    layer: '查错',
    display: '说出根因 + 修复 + 预防',
    allOf: [
      { field: 'rootCause', label: '说出根因' },
      { field: 'fix', label: '给出修复' },
      { field: 'prevention', label: '给出预防' },
    ],
  },
  造出: {
    layer: '造出',
    display: '交付物能跑通 + 能解释取舍',
    allOf: [
      { field: 'deliverableRuns', label: '交付物能跑通' },
      { field: 'explainsTradeoffs', label: '能解释取舍' },
    ],
  },
};

function satisfied(rule: LayerRule, evidence: LayerEvidence): boolean {
  if (!rule.allOf.every((criterion) => evidence[criterion.field] === true)) return false;
  if (rule.anyOf && !rule.anyOf.some((criterion) => evidence[criterion.field] === true)) return false;
  return true;
}

/** 还缺哪几条（中文，可直接展示给学生看「差一步怎么过」）。 */
export function missingCriteria(evidence: LayerEvidence, layer: Layer): string[] {
  const rule = LAYER_RULES[layer];
  const missing = rule.allOf.filter((criterion) => evidence[criterion.field] !== true).map((criterion) => criterion.label);
  if (rule.anyOf && !rule.anyOf.some((criterion) => evidence[criterion.field] === true)) {
    missing.push(rule.anyOf.map((criterion) => criterion.label).join(' 或 '));
  }
  return missing;
}

export interface LayerJudgement {
  /** 证据**完全满足**的最高一层；一层都够不上时是 `null`（够不上就是够不上，不猜）。 */
  layer: Layer | null;
  /** 所有被满足的层。 */
  met: readonly Layer[];
  /** 再往上一层还缺哪几条——`layer` 为 null 时给的是「读懂」缺什么。 */
  missing: readonly string[];
}

/**
 * 四层判定。
 *
 * **没有「课型上限」参数**：规格 §7.1 明确取消了「课型限层级」，深度由节点的 `objective`
 * 决定。课型在目标态只决定产不产 lab 材料，拿它压层级是旧规则的残留，别加回来。
 */
export function judgeLayer(evidence: LayerEvidence): LayerJudgement {
  const met = LAYERS.filter((layer) => satisfied(LAYER_RULES[layer], evidence));
  const layer = met.length > 0 ? met[met.length - 1] : null;
  const nextIndex = layer === null ? 0 : LAYERS.indexOf(layer) + 1;
  const next = LAYERS[nextIndex];
  return { layer, met, missing: next === undefined ? [] : missingCriteria(evidence, next) };
}

/** 证据够不够到**指定**的层（评估时拿节点的目标层级来问）。 */
export function meetsLayer(evidence: LayerEvidence, target: Layer): { ok: boolean; missing: readonly string[] } {
  const ok = satisfied(LAYER_RULES[target], evidence);
  return { ok, missing: ok ? [] : missingCriteria(evidence, target) };
}

/* ══════════════════════════════════════════════════════════════════════
   二、题型与深度的匹配（规格 §7.2 / §7.3）
   ══════════════════════════════════════════════════════════════════════ */

/*
 * 口径提醒：目标态 §7.2 的题型是**客观题 / 预测+验证 / 开放题 / 交付物**，并且
 * 「评估题取消」。现行技能 `layered-practice` 用的还是旧词（选择题 / 开放题 / 实操题 /
 * 评估题），那份该由 #80/#81 一类 ticket 收编——这里只实现目标态口径，不做两套。
 */

export const QUESTION_KINDS = ['客观题', '预测验证', '开放题', '交付物'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export type GradingTrack = '阅读端即时判' | '学生自评' | 'Host 半代跑';

export interface QuestionRule {
  kind: QuestionKind;
  /** 规格 §7.2「判分」一列的原文。 */
  display: string;
  /** 服务哪一层。**空数组意味着这种题型一层都判不了**，那就该报出来。 */
  layers: readonly Layer[];
  /** 规格 §7.3 判分三轨里它走哪一轨。三轨都不叫 agent。 */
  grading: GradingTrack;
}

export const QUESTION_RULES: Readonly<Record<QuestionKind, QuestionRule>> = {
  客观题: { kind: '客观题', display: '页内自动判', layers: ['读懂'], grading: '阅读端即时判' },
  预测验证: { kind: '预测验证', display: '先写下预测，再跑起来对照', layers: ['改对', '查错'], grading: 'Host 半代跑' },
  开放题: { kind: '开放题', display: '展开参考答案与判分要点，学生自评', layers: ['读懂', '查错'], grading: '学生自评' },
  交付物: { kind: '交付物', display: '可运行证据（测试 / 断言 / 期望输出）', layers: ['造出'], grading: 'Host 半代跑' },
};

export function layersForQuestion(kind: QuestionKind): readonly Layer[] {
  return QUESTION_RULES[kind].layers;
}

/** 反查：服务某一层的题型有哪些。 */
export function questionsForLayer(layer: Layer): QuestionKind[] {
  return QUESTION_KINDS.filter((kind) => QUESTION_RULES[kind].layers.includes(layer));
}

export function servesLayer(kind: QuestionKind, layer: Layer): boolean {
  return QUESTION_RULES[kind].layers.includes(layer);
}

export interface PracticeItem {
  kind: QuestionKind;
  /** 这道题的目标层级；不给就只查题型自身的完整性，不查匹配。 */
  layer?: Layer;
  /** 开放题：有没有参考答案与判分要点（缺一不可，学生据此自评）。 */
  hasReferenceAnswer?: boolean;
  /** 交付物：有没有可运行证据（测试 / 断言 / 期望输出）。 */
  hasRunnableEvidence?: boolean;
}

export interface QuestionMixProblem {
  index: number;
  kind: QuestionKind;
  layer?: Layer;
  message: string;
}

/** 逐题查「题型 ↔ 深度」的匹配与题型自带的硬要求。 */
export function checkQuestionMix(items: readonly PracticeItem[]): QuestionMixProblem[] {
  const problems: QuestionMixProblem[] = [];
  items.forEach((item, index) => {
    const rule = QUESTION_RULES[item.kind];
    const label = `第 ${index + 1} 题`;
    if (item.layer !== undefined && !rule.layers.includes(item.layer)) {
      problems.push({
        index,
        kind: item.kind,
        layer: item.layer,
        message: `${label}：题型「${item.kind}」不服务「${item.layer}」层（它服务：${rule.layers.join('、')}）`,
      });
    }
    if (item.kind === '开放题' && item.hasReferenceAnswer === false) {
      problems.push({
        index,
        kind: item.kind,
        message: `${label}：开放题必须同时给参考答案与判分要点——学生据此自评，缺一不可`,
      });
    }
    if (item.kind === '交付物' && item.hasRunnableEvidence === false) {
      problems.push({
        index,
        kind: item.kind,
        message: `${label}：交付物题必须带可运行证据（测试 / 断言 / 期望输出），否则「造出」这一层判不了`,
      });
    }
  });
  return problems;
}

/* ══════════════════════════════════════════════════════════════════════
   三、进度：三档推进 + 旧六档映射（规格 §5.2）
   ══════════════════════════════════════════════════════════════════════ */

export const TIERS = ['未开始', '学习中', '已学完'] as const;
export type Tier = (typeof TIERS)[number];

/** 旧词表，顺序即 `progress.schema.json` 今天 enum 的顺序。 */
export const LEGACY_TIERS = ['未开始', '学习中', '初步理解', '能独立应用', '需要复习', '已通过项目验证'] as const;
export type LegacyTier = (typeof LEGACY_TIERS)[number];

/**
 * 旧六档 → 三档（规格 §5.2 的映射表明文）。用 `Map` 不用普通对象：
 * 状态值来自文件，写成 `"constructor"` 之类会撞上 `Object.prototype`，静默取到一个函数。
 */
export const LEGACY_TIER_MAP: ReadonlyMap<string, Tier> = new Map<string, Tier>([
  ['未开始', '未开始'],
  ['学习中', '学习中'],
  ['初步理解', '学习中'],
  ['能独立应用', '已学完'],
  ['需要复习', '已学完'],
  ['已通过项目验证', '已学完'],
]);

/**
 * 任意读到的东西 → 三档。**读到不认识的词一律退回「未开始」**：
 * 猜错的代价是「没学过」被显示成「学完了」，那比显示成没开始坏得多。
 */
export function toTier(raw: unknown): Tier {
  if (typeof raw !== 'string') return '未开始';
  if ((TIERS as readonly string[]).includes(raw)) return raw as Tier;
  return LEGACY_TIER_MAP.get(raw) ?? '未开始';
}

export function isTier(raw: unknown): raw is Tier {
  return typeof raw === 'string' && (TIERS as readonly string[]).includes(raw);
}

/* ── 证据资格（规格 §7.5）────────────────────────────────────────────── */

/** 可信度**从高到低**（规格 §7.5 的排序原文）。只有这几种能推动状态。 */
export const EVIDENCE_BY_TRUST = ['运行结果', '学生自写的测试', '解释能力', '口头确认'] as const;
/** 明确**不算**独立通过证据的东西（规格 §7.5 的排除清单原文）。 */
export const NON_INDEPENDENT_EVIDENCE = ['自评', '同日重试', '关键词标签', '仅浏览过'] as const;

export type IndependentEvidence = (typeof EVIDENCE_BY_TRUST)[number];
export type NonIndependentEvidence = (typeof NON_INDEPENDENT_EVIDENCE)[number];
export type EvidenceKind = IndependentEvidence | NonIndependentEvidence;

export function isIndependentEvidence(kind: unknown): boolean {
  return typeof kind === 'string' && (EVIDENCE_BY_TRUST as readonly string[]).includes(kind);
}

/** 可信度序号：0 最高；非独立证据一律 -1（它根本不参与排序）。 */
export function evidenceRank(kind: unknown): number {
  if (typeof kind !== 'string') return -1;
  return (EVIDENCE_BY_TRUST as readonly string[]).indexOf(kind);
}

/* ── 推进 ─────────────────────────────────────────────────────────────── */

export type ProgressEvent =
  | { readonly kind: '开始学习' }
  | { readonly kind: '证据通过'; readonly evidence: EvidenceKind }
  | { readonly kind: '要求复习' };

export interface AdvanceResult {
  from: Tier;
  to: Tier;
  changed: boolean;
  reason: string;
}

/**
 * 三档推进。**事件里没有「谁说的」这个位置**：没有 `role`、没有 `model` 参数，
 * 所以「模型输出不能直接改进度状态」（规格 §7.5）不是一条要靠自觉的纪律，
 * 而是这个函数签名里根本表达不出来的东西。
 *
 * - `开始学习`：未开始 → 学习中。已经学过就不动。
 * - `证据通过`：**只有独立证据**能把状态推到「已学完」；自评、同日重试、关键词标签、
 *   仅浏览过一律不动，并说明为什么。「延迟重测」是时间判据，由调用方判断后选择是否
 *   发这个事件——这一层不读钟。
 * - `要求复习`：已学完 → 学习中（这是**回退**，刻意留的：状态是事实，不是奖杯）。
 */
export function advance(raw: unknown, event: ProgressEvent): AdvanceResult {
  const from = toTier(raw);
  const step = (to: Tier, reason: string): AdvanceResult => ({ from, to, changed: to !== from, reason });
  switch (event.kind) {
    case '开始学习':
      if (from === '未开始') return step('学习中', '开始学习：未开始 → 学习中');
      return step(from, `已经在「${from}」，不因再次打开而改动`);
    case '证据通过': {
      if (!isIndependentEvidence(event.evidence)) {
        return step(from, `「${String(event.evidence)}」不算独立通过证据（规格 §7.5 的排除清单），状态不动`);
      }
      if (from === '已学完') return step(from, '已经是「已学完」，不重复置位');
      return step('已学完', `独立证据「${event.evidence}」通过：${from} → 已学完`);
    }
    case '要求复习':
      if (from === '已学完') return step('学习中', '要求复习：已学完 → 学习中');
      if (from === '学习中') return step(from, '已经在「学习中」');
      return step(from, '没学过就谈不上复习：未开始不动');
    default:
      // 事件名不认识（老版本写下的调用方、或有人手搓了一个对象）：状态一律不动。
      // 「宁可不动」是因为猜错的代价不对称——猜成学会了，进度就再也回不来了。
      return step(from, `不认识的推进事件 ${JSON.stringify((event as { kind?: unknown }).kind)}：状态不动（宁可不动，也不要猜）`);
  }
}

/* ── 分母口径（规格 §7.5）─────────────────────────────────────────────── */

export interface CoverageVerdict {
  passed: boolean;
  total: number;
  covered: number;
  missing: readonly string[];
  reason: string;
}

/**
 * 验收的分母口径：**全部必需核心点**，而且**范围为空时绝不显示「通过」**。
 * 「没有要求 = 都满足」是验收里最容易混进来的一种假通过。
 */
export function checkCoverage(requiredPoints: readonly string[], coveredPoints: readonly string[]): CoverageVerdict {
  if (requiredPoints.length === 0) {
    return {
      passed: false,
      total: 0,
      covered: 0,
      missing: [],
      reason: '必需核心点为空：范围为空时绝不显示「通过」（规格 §7.5）',
    };
  }
  const covered = new Set(coveredPoints);
  const missing = requiredPoints.filter((point) => !covered.has(point));
  return {
    passed: missing.length === 0,
    total: requiredPoints.length,
    covered: requiredPoints.length - missing.length,
    missing,
    reason: missing.length === 0
      ? `${requiredPoints.length} / ${requiredPoints.length} 个必需核心点有证据`
      : `还缺 ${missing.length} / ${requiredPoints.length} 个必需核心点：${missing.slice(0, 6).join('、')}${missing.length > 6 ? '…' : ''}`,
  };
}
