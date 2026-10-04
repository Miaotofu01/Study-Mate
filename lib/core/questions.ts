/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 —— 题库里每道题的题型与字段（带真实行号）

   题库（`.quiz.json`）是模型写的课件内容文件，键是锚点文本、值是一组题。这一层把
   「每道题的题型对不对、字段够不够」查出来，并给出**题库文件里的真实行号**——行号来自
   `lib/core/jsonpos.ts` 扫原文（不是文本搜索：题面里恰好等于字段名的文字会把搜索带偏）。

   题型词表与字段要求在 `lib/core/rules.ts`（`QUESTION_KINDS` / `QUESTION_KIND_SHAPES`），
   这里只负责「在哪一题、哪一行、出了什么事」。`lib/core/lesson.ts`（解析一课）与
   `lib/library.ts`（读整个工作区）都调它——同一份判据只有一份实现。

   纯函数域：题库对象由调用方读盘并解析好传进来，这一层不碰文件系统。
   ───────────────────────────────────────────────────────────────────────── */

import { QUESTION_KINDS, questionKindProblem } from './rules.ts';
import type { QuestionKindProblem } from './rules.ts';
import { indexJson } from './jsonpos.ts';

/** 一条题型问题：`file` / `line` 指向题库文件里的那道题。 */
export interface PoolKindIssue {
  /** 题库文件名（调用方注入；没给就是空串） */
  file: string;
  /** 题库文件里的行号（1 起）；原文没给时退化成 1——**退化成 1 而不是猜** */
  line: number;
  /** 锚点文本（题库的键） */
  anchor: string;
  /** 这道题在锚点下是第几道（从 0 起） */
  index: number;
  /** `unknown-kind` / `ambiguous` / `missing-field`，与 `questionKindProblem` 同一套 */
  code: QuestionKindProblem['code'];
  message: string;
}

export interface PoolKindReportOptions {
  /** 题库文件在报错里显示的名字 */
  poolFile?: string;
  /** 题库 JSON 的**原文**：给了才按真实位置给行号（不给就全报第 1 行） */
  poolRaw?: string;
}

/**
 * 逐题查题库里的题型与字段。
 *
 * 判定口径（与 `questionKindProblem` 同一份）：
 *   · 显式写了 `kind` 且不在词表里 → `unknown-kind`（**未知题型报错**）；
 *   · 显式写了 `kind` 但字段是另一种题型的 → `ambiguous`；
 *   · 显式写了 `kind` 却缺该题型的必备字段 → `missing-field`；
 *   · 没写 `kind`：只查「两组旧字段同时出现」——旧题库照旧读得进。
 *
 * 值不是数组的键（形状坏）不在这里报：`lib/core/lesson.ts` 的 `pool-shape` 已经报过，
 * 重复报同一件事只会让人以为有两个问题。
 */
export function checkPoolKinds(
  pool: Record<string, unknown>,
  options: PoolKindReportOptions = {},
): PoolKindIssue[] {
  const file = options.poolFile ?? '';
  const positions = typeof options.poolRaw === 'string' && options.poolRaw !== ''
    ? indexJson(options.poolRaw)
    : null;
  const issues: PoolKindIssue[] = [];
  for (const anchor of Object.keys(pool)) {
    const questions = pool[anchor];
    if (!Array.isArray(questions)) continue;
    questions.forEach((item, index) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return;
      const problem = questionKindProblem(item as Record<string, unknown>, QUESTION_KINDS);
      if (problem === null) return;
      // 行号取**那道题的对象位置**（`{"q": …}` 的 `{` 所在行）；找不到就退到锚点键的位置
      const hit = positions === null
        ? { line: 1 }
        : positions.at([anchor, index]);
      issues.push({
        file,
        line: hit.line,
        anchor,
        index,
        code: problem.code,
        message: problem.message,
      });
    });
  }
  return issues;
}
