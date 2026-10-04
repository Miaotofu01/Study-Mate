/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 core —— 一课的顶层解析（内容文件 + 题库对账）

   这一层做**编排**：吃一段内容文件的字符串（+ 调用方已经读好的题库对象），
   吐出块树、四态对账、错误与提示。它不读任何文件——`file` / `poolFile` 都是调用方
   注入的名字，连图片文件是否存在都走 `checkFigureSrc` 钩子（解析层不碰文件系统）。

   与 Python 的对齐点（迁移前的 Python 渲染器的 main 那段）：
     · front matter 的两个字段 + `title` 与大纲逐字一致（`check_title_match`）；
     · 同名锚点被两个题目位置引用 → 报错（`check_duplicate_anchors`）；
     · 有 `::: quiz` 但题库文件不在 → 报错（`load_quiz`）；
     · 一个题目位置都没有、题库文件却在 → 报错（`main` 那段 `needs_quiz`）；
     · 题库里多出来的键 → 报错（`load_quiz` 的反方向对账）；
     · 题库值必须是**非空数组**、顶层必须是对象（`load_quiz` 的形状校验）；
     · 锚点没题又没 `empty_reason:` → 报错；有 `empty_reason:` → 一行提示、不算错。

   「题库 JSON 语法错」也**不抛异常**：调用方把 `JSON.parse` 的报错交给
   `poolJsonError()` 转成一条普通错误（今天 `lib/library.mjs:415` 的 `throw` 是反例）。
   ───────────────────────────────────────────────────────────────────────── */

import {
  FormatProblems, checkInlineHtml, figureSrcProblem, makeCtx, parseBlocks, parseFrontMatter,
  renderBlocks, renderInline,
  type Block, type FormatError, type FormatNote, type FrontMatter, type LessonCtx, type QuizBlock,
} from './format.ts';
import {
  declaredFromBlocks, poolKeyLines, reconcileAnchors,
  type AnchorReconciliation, type DeclaredAnchor,
} from './anchors.ts';
import { checkPoolKinds } from './questions.ts';

export type {
  Block, FormatError, FormatErrorCode, FormatNote, FrontMatter, QuizBlock,
} from './format.ts';
export type { AnchorMatch, AnchorReconciliation, AnchorResolution, DeclaredAnchor } from './anchors.ts';

export interface ParseLessonOptions {
  /** 题库内容（调用方已 `JSON.parse` 的对象）。给了才做对账；`{}` 是「题库是空对象」。 */
  pool?: Record<string, unknown> | null;
  /** 题库文件在报错里显示的名字 */
  poolFile?: string;
  /** 调用方查过：题库文件在盘上存在吗（决定「有 ::: quiz 却没有题库」这条错报不报） */
  poolPresent?: boolean;
  /** 题库 JSON 的**原文**：给了就按 JSON 的真实位置给键报行号（不给就全报第 1 行） */
  poolRaw?: string;
  /** 大纲里该节点的 title：给了才做「逐字一致」检查 */
  outlineTitle?: string;
  /** 节点 id：只用来把 title 不一致那条错说清楚 */
  nodeId?: string;
  /**
   * `::: figure` 的文件存在性钩子：源路径是本地相对路径时调用，返回**完整的错误信息**
   * （如 `图片文件不存在：x.png（解析到 /abs/x.png）——从科目图片库 assets/img/pool/ 挑一张，或先采图`）
   * 或 null（文件在）。
   */
  checkFigureSrc?: (src: string) => string | null;
}

export interface LessonParseResult {
  frontMatter: FrontMatter | null;
  /** 正文起始行**下标**（0 起，与 Python 的 `parse_front_matter` 第二项同义） */
  bodyStart: number;
  blocks: Block[];
  /** 收集到的错误（不抛异常）；`file` 与 `line` 都在里面 */
  errors: FormatError[];
  /** 软提示，不影响「有没有错」 */
  notes: FormatNote[];
  /** 对账结果：即使有错也照常返回（界面要显示四态）；没给题库时为 null */
  reconciliation: AnchorReconciliation | null;
  /** 渲染器/壳要用的派生信息 */
  flags: {
    /** 正文里出现了数学式（决定壳里注不注入 KaTeX） */
    hasMath: boolean;
    /** 内容里有 `::: quiz` 题目位置（决定「该不该有题库文件」） */
    needsQuiz: boolean;
    /** 正文声明的锚点文本（按出现顺序；重复的会出现两次） */
    referencedAnchors: string[];
  };
}

/**
 * 解析一课。
 *
 * @param source 内容文件的**全文**（含 front matter 与结尾换行）
 * @param file   报错里显示的名字（调用方注入；解析层不解析它）
 */
export function parseLesson(
  source: string, file: string, options: ParseLessonOptions = {},
): LessonParseResult {
  const problems = new FormatProblems();
  const ctx: LessonCtx = { file, problems, math: { value: false }, figureNo: { value: 0 } };
  // Python 的 `raw.split('\n')`：末尾换行会多出一个空串元素，这里逐字对齐
  const lines = source.split('\n');

  const { front, bodyStart } = parseFrontMatter(lines, ctx);
  checkTitleMatch(front, options, ctx);
  const { blocks } = parseBlocks(lines, bodyStart, lines.length, ctx);

  const quizzes = collectQuizzes(blocks);
  checkDuplicateAnchors(quizzes, ctx);
  // 形状（外链 / 绝对路径）**总是**查；文件存在性只有调用方给了钩子才查——
  // 解析层不碰文件系统，但「外链不是本地相对路径」是纯语法的判定，不该漏。
  checkFigureSources(blocks, options.checkFigureSrc ?? null, ctx);

  // 两个方向的「题库在不在」都要报，但**报哪一条**取决于盘上有没有题库文件与有没有
  // 题目位置——这与 Python main 那段的 `needs_quiz` / `os.path.isfile` 组合逐字一致：
  //   有 quiz 有题库 → 正常对账（含 orphans）；
  //   有 quiz 没题库 → 「找不到题库文件」+ 逐条锚点没题（**不报 orphans**，Python 也不报）；
  //   没 quiz 有题库 → 「一个题目位置都没有，题库文件却还在」（Python 在这一支**不报**
  //                    orphans，所以这里也走同一条口径，别让它多出 N 条重复的错）；
  //   没 quiz 没题库 → 什么都不报（`kind: 实验` 的说明页就是这样）。
  const poolOnDisk = options.poolPresent !== false && options.pool != null;
  checkPoolPresence(quizzes.length > 0, options, ctx);
  const reconciliation = reconcile(quizzes, options, ctx, poolOnDisk);
  if (reconciliation && quizzes.length === 0) reportUnusedPool(options.poolFile ?? '题库', problems);

  // 正文的 title 也是散文：真标签照拦（Python 在渲染前单独查一遍）
  if (front && front.title) {
    checkInlineHtml(front.title, front.titleLine, 'front matter 的 title', ctx);
  }

  return {
    frontMatter: front,
    bodyStart,
    blocks,
    errors: problems.errors,
    notes: problems.notes,
    reconciliation,
    flags: {
      hasMath: ctx.math.value,
      needsQuiz: quizzes.length > 0,
      referencedAnchors: quizzes.map((quiz) => quiz.anchor),
    },
  };
}

/** 块树里所有 `::: quiz`，按出现顺序（含容器指令块内的，虽然指令不能嵌套）。 */
function collectQuizzes(blocks: Block[]): QuizBlock[] {
  const quizzes: QuizBlock[] = [];
  walkBlocks(blocks, (block) => {
    if (block.kind === 'directive' && (block as QuizBlock).name === 'quiz') {
      quizzes.push(block as QuizBlock);
    }
  });
  return quizzes;
}

function walkBlocks(blocks: Block[], visit: (block: Block) => void): void {
  for (const block of blocks) {
    visit(block);
    const items = (block as { items?: { children?: Block | null }[] }).items;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item.children) walkBlocks([item.children], visit);
      }
    }
    const body = (block as { body?: Block[] }).body;
    if (Array.isArray(body)) walkBlocks(body, visit);
  }
}

/* ── title 与大纲逐字一致 ───────────────────────────────────────────────── */

function checkTitleMatch(
  front: FrontMatter | null, options: ParseLessonOptions, ctx: LessonCtx,
): void {
  if (!front || !front.title || options.outlineTitle == null) return;
  if (front.title !== options.outlineTitle) {
    const node = options.nodeId ?? '';
    ctx.problems.add(ctx.file, front.titleLine,
      `front matter 的 title「${front.title}」与 curriculum.yaml 里节点 ${node} 的 `
      + `title「${options.outlineTitle}」不一致——两处必须逐字一致（改这里或改大纲，`
      + '见 docs/规范/课件内容格式.md 第 1 节）', 'title-mismatch');
  }
}

/* ── 重复锚点 ───────────────────────────────────────────────────────────── */

function checkDuplicateAnchors(quizzes: QuizBlock[], ctx: LessonCtx): void {
  const firstLine = new Map<string, number>();
  for (const quiz of quizzes) {
    const seen = firstLine.get(quiz.anchor);
    if (seen !== undefined) {
      ctx.problems.add(ctx.file, quiz.line,
        `锚点「${quiz.anchor}」重复：第 ${seen} 行已经用过同一个锚点——`
        + '同一批题会被渲染两遍（一个锚点只留一个题目位置）', 'anchor-duplicate');
    } else {
      firstLine.set(quiz.anchor, quiz.line);
    }
  }
}

/* ── `::: figure` 的路径形状（形状在解析层判，存在性走钩子） ───────────── */

function checkFigureSources(
  blocks: Block[], exists: ((src: string) => string | null) | null, ctx: LessonCtx,
): void {
  walkBlocks(blocks, (block) => {
    if (block.kind !== 'directive' || (block as { name: string }).name !== 'figure') return;
    const figure = block as { src: string; line: number };
    const shape = figureSrcProblem(figure.src);
    if (!shape) return;
    if (!shape.needsExistsCheck) {
      ctx.problems.add(ctx.file, figure.line, shape.message, 'figure-src');
      return;
    }
    if (!exists) return;
    const message = exists(figure.src);
    if (message) ctx.problems.add(ctx.file, figure.line, message, 'figure-src');
  });
}

/* ── 对账 + 两个方向的报错 ─────────────────────────────────────────────── */

function reconcile(
  quizzes: QuizBlock[], options: ParseLessonOptions, ctx: LessonCtx, poolOnDisk: boolean,
): AnchorReconciliation | null {
  const poolFile = options.poolFile ?? '题库';
  const lineOf = options.poolRaw ? poolKeyLines(options.poolRaw) : null;
  const keyLine = (key: string): number => lineOf?.get(key) ?? 1;
  const declared: DeclaredAnchor[] = quizzes.map((quiz) => ({
    text: quiz.anchor, level: quiz.level, line: quiz.line,
  }));

  // 题库没读进来（文件不在 / JSON 坏了）时，Python 的 `self.quiz` 是 None：
  // 每条锚点照样报「没有题」，只是没有形状抱怨、也没有 orphans。
  if (!poolOnDisk) {
    for (const quiz of quizzes) {
      if (quiz.empty_reason) {
        ctx.problems.note(ctx.file, quiz.line,
          `${ctx.file}:${quiz.line} 锚点「${quiz.anchor}」没有题：${quiz.empty_reason}`);
        continue;
      }
      ctx.problems.add(ctx.file, quiz.line,
        `锚点「${quiz.anchor}」在 ${poolFile} 里没有题——`
        + '要么让出题角色补题，要么写一行 `empty_reason: <理由>`', 'anchor-missing');
    }
    return null;
  }

  const pool = options.pool as Record<string, unknown>;
  const fixtureOnly = quizzes.length === 0;   // 反方向只留一条「题库文件没人用」，不逐键刷屏
  // 题型与字段：未知题型要带**题库文件与行号**报出来（行号取那道题在 JSON 原文里的位置）。
  // 放在形状检查之前：形状坏（值不是数组）的键不在这里报，由下面那条 `pool-shape` 说。
  for (const issue of checkPoolKinds(pool, { poolFile, poolRaw: options.poolRaw })) {
    ctx.problems.add(issue.file, issue.line, issue.message, `pool-${issue.code}`);
  }
  // 形状：顶层必须是对象、每个值必须是**非空数组**（Python `load_quiz` 的两条）。
  // 形状坏了**不影响**后面的对账——Python 的 `load_quiz` 收了这条错照样 `return data`，
  // 于是渲染器拿 `.get(anchor)` 得到非 list、再报一次「没有题」。两条都要出。
  if (!fixtureOnly) {
    for (const key of Object.keys(pool)) {
      const value = pool[key];
      if (!Array.isArray(value) || value.length === 0) {
        ctx.problems.add(poolFile, keyLine(key),
          `锚点「${key}」的值应是非空的题目数组`, 'pool-shape');
      }
    }
  }

  const result = reconcileAnchors(declared, pool, { poolFile, poolLineOf: keyLine });

  // 正方向：正文声明了、题库里没有题 → 要么补题，要么写 empty_reason（只在提示里出现）。
  // 逐条按**声明顺序**对上 `result.anchors`（`reconcileAnchors` 保持顺序），不要用行号
  // 反查——`buildQuiz` 给 `empty_reason` 的行号与锚点块的行号是同一个，但 `anchor.text`
  // 是 strip 过的，反查会错位。
  for (let i = 0; i < quizzes.length; i++) {
    const quiz = quizzes[i];
    const anchor = result.anchors[i];
    if (!anchor) continue;
    const questions = Object.prototype.hasOwnProperty.call(pool, anchor.text)
      ? pool[anchor.text] : null;
    const hasQuestions = Array.isArray(questions) && questions.length > 0;
    if (hasQuestions) {
      // 有题 → 渲染器会出 data-quiz；这时写了 empty_reason 就是错
      if (quiz.empty_reason) {
        ctx.problems.add(ctx.file, anchor.line,
          `锚点「${anchor.text}」在题库里有 ${anchor.candidates[0]?.count ?? 0} 道题，`
          + 'empty_reason 是给无题锚点用的（删掉它）', 'anchor-missing');
      }
      continue;
    }
    // 没题（含「值不是非空数组」这种形状坏，以及「锚点文本只差空白」的 resolved 残影）
    if (quiz.empty_reason) {
      // `提示:` 通道（不影响退出码、也不算错）——与迁移前的 Python 渲染器:1067-1069 对齐
      ctx.problems.note(ctx.file, anchor.line,
        `${ctx.file}:${anchor.line} 锚点「${anchor.text}」没有题：${quiz.empty_reason}`);
      continue;
    }
    if (anchor.resolution === 'ambiguous') {
      ctx.problems.add(ctx.file, anchor.line,
        `锚点「${anchor.text}」在题库里对应 ${anchor.keys.length} 个键`
        + `（${anchor.keys.map((key) => `「${key}」`).join('、')}）——`
        + '多匹配绝不静默取一个：把正文的锚点写成其中一个键，或把题库里的重复键并掉',
      'anchor-ambiguous');
      continue;
    }
    if (anchor.resolution === 'stale') {
      ctx.problems.add(ctx.file, anchor.line,
        `锚点「${anchor.text}」与题库键「${anchor.keys[0]}」只差空白——`
        + '锚点要和题库的键逐字一致（改正文或改题库）', 'anchor-stale');
      continue;
    }
    ctx.problems.add(ctx.file, anchor.line,
      `锚点「${anchor.text}」在 ${poolFile} 里没有题——`
      + '要么让出题角色补题，要么写一行 `empty_reason: <理由>`', 'anchor-missing');
  }

  // 反方向：题库里多出来的键（没有任何题目位置引用它）——**一等结论**，不许静默。
  // 一个题目位置都没有时改报 `reportUnusedPool`（那一句已经把整份题库说清楚了）。
  if (fixtureOnly) return result;
  for (const orphan of result.orphans) {
    ctx.problems.add(poolFile, orphan.line,
      `题库里的锚点「${orphan.key}」没有任何 ::: quiz 题目位置引用它——`
      + '这些题不会出现在页面上（删掉这个键，或让讲解角色在正文里补题目位置）',
    'pool-orphan');
  }
  return result;
}

/** 题库文件在不在盘上：决定「有 `::: quiz` 却没有题库」这条错报不报。 */
function checkPoolPresence(
  needsQuiz: boolean, options: ParseLessonOptions, ctx: LessonCtx,
): void {
  if (needsQuiz && options.pool == null && options.poolPresent === false) {
    ctx.problems.add(options.poolFile ?? '题库', 1,
      '内容里有 ::: quiz，但找不到题库文件（出题角色产出 .quiz.json）', 'pool-missing');
  }
}

/**
 * 题库 JSON 的语法错 → 一条普通错误（**不抛异常**）。
 *
 * 行号取 `JSON.parse` 报错里的位置换算回行号——与 Python 用 `exc.lineno` 同一口径。
 */
export function poolJsonError(
  raw: string, error: unknown, poolFile: string, problems: FormatProblems,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const position = /position (\d+)/.exec(message);
  let line = 1;
  if (position) line = raw.slice(0, Number(position[1])).split('\n').length;
  problems.add(poolFile, Math.max(line, 1), `题库不是合法 JSON：${message}`, 'pool-json');
}

/** 「没有题目位置却留着题库文件」：出题角色的整份交付没人用（题目全丢）。 */
export function reportUnusedPool(poolFile: string, problems: FormatProblems): void {
  problems.add(poolFile, 1,
    '内容文件里没有任何 ::: quiz 题目位置，但题库文件还在——这些题一道也不会'
    + '出现在页面上（删掉题库文件，或在正文里补上题目位置）', 'pool-unused');
}

/** 题库顶层不是对象（Python `load_quiz` 也报这一条）。 */
export function reportPoolShape(poolFile: string, problems: FormatProblems): void {
  problems.add(poolFile, 1, '题库结构应为 {"锚点文本": [题, …]}（最外层是对象）', 'pool-shape');
}

/** 一条错误的可打印形式：`<文件>:<行> <问题>`（对齐 Python 的输出契约）。 */
export function formatErrorLine(error: FormatError): string {
  return `${error.file}:${error.line} ${error.message}`;
}

/**
 * 正文渲染：块树 → HTML 片段，并把渲染期的问题（行内 HTML、`::: figure` 的 alt: 等）
 * 写进同一个收集器。
 *
 * 为什么单独一个函数而不是让 `parseLesson` 顺手渲染：`parseLesson` 是**纯解析**，
 * 渲染会带来副作用（图注编号、`hasMath`）与重复检查——两者的验收面也不一样
 * （解析比对块结构与四态，渲染比对 HTML 逐字）。要与 Python 的
 * `renderer.render(blocks)` 逐字比对时调这个。
 */
export interface RenderBodyOptions {
  /** `::: quiz` 取题用的题库（调用方读好的对象） */
  pool?: Record<string, unknown[]> | null;
  /** 题库文件在报错里显示的名字 */
  poolName?: string;
  /** 图片库索引查来源：`:: figure` 的图注补「（来源：…，许可：…）」 */
  poolSource?: (src: string) => string;
}

export function renderBody(
  result: Pick<LessonParseResult, 'blocks' | 'frontMatter'>, file: string,
  options: RenderBodyOptions = {},
): { html: string; goalHtml: string; errors: FormatError[]; notes: FormatNote[]; hasMath: boolean } {
  const ctx = makeCtx(file);
  ctx.pool = options.pool ?? null;
  ctx.poolName = options.poolName;
  ctx.poolSource = options.poolSource;
  const html = renderBlocks(result.blocks, ctx);
  const goalHtml = result.frontMatter
    ? renderInline(result.frontMatter.goal, result.frontMatter.goalLine, ctx)
    : '';
  return { html, goalHtml, errors: ctx.problems.errors, notes: ctx.problems.notes, hasMath: ctx.math.value };
}
