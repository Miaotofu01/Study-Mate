/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— `studymate_lesson_read`（只读，答疑会话专用）

   答疑会话手上唯一的能力工具：给一个节点 id，拿回**那一课的正文**与**这一节点的题**。
   `writes` 留空是刻意的——跑一遍一个字节都不落盘（#104 的验收：「调用前后工作区文件清单
   逐字不变」）；不存在的节点、带路径分隔符或 `..` 的 id，一律回一条结构化的「没有」，不抛。

   数据入口只有 `run.access`（`lib/host/access.ts` 的越权即抛），读法在 `lib/host/vault.ts`：
   `lessons` 与 `pool` 的**整体视图**各自是「科目 × 节点」的一行，带 slug 与节点 id——工具只拿
   节点 id，要跨科目找，所以用整体视图而不是自己拼路径（拼路径等于在工具里再抄一份工作区布局，
   而且 `node.lesson` 的 `<slug>/<文件名>` 也不是能直接喂给 `resolveTarget` 的路径）。
   vault 的 `readLibrary` 在一次调用里只读一遍盘（两个域共用同一份缓存）。

   **它不进 `lib/tools/index.ts` 的 `registerStudyMate`**：那九个原生工具的面一字不动
   （`STUDY_TOOL_NAMES` 仍是九条）。这个工具由答疑预设那条插件行
   （`lib/tools/qa-preset.ts`）注册进它自己的作用域——见那里的文件头。
   ───────────────────────────────────────────────────────────────────────── */

import type { StudyToolSpec } from './define.ts';

export const LESSON_READ_TOOL_NAME = 'studymate_lesson_read';

const TEXT = { type: 'string' } as const;

/** `vault.ts` 的 `lessons` 域整体视图里的一行（逐域投影，只挑这里要的字段）。
    `file` 是 `<slug>/<文件名>`（vault 用的是 library 的 `node.lesson`），所以下面要切一刀。 */
interface LessonRow {
  slug: string;
  node: string;
  file: string;
  markdown: string;
}

/** `vault.ts` 的 `pool` 域整体视图里的一行。`pool` 是题库 JSON 的解析结果。 */
interface PoolRow {
  slug: string;
  node: string;
  pool: unknown;
}

/** 题库的形状是「锚点文本 → 题目数组」（`schemas/question.schema.json` 描述数组里的一项）。 */
function questionGroups(pool: unknown): { anchor: string; questions: unknown[] }[] {
  if (!pool || typeof pool !== 'object' || Array.isArray(pool)) return [];
  return Object.entries(pool as Record<string, unknown>)
    .map(([anchor, questions]) => ({
      anchor,
      questions: Array.isArray(questions) ? questions : [],
    }));
}

const QUESTION_GROUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['anchor', 'questions'],
  properties: {
    anchor: TEXT,
    // 题目字段的形状归 `schemas/question.schema.json`（#104 只转述，不在这里收口第二份）
    questions: { type: 'array', items: { type: 'object' } },
  },
};

const FOUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'node', 'subject', 'file', 'markdown', 'questions', 'alsoIn'],
  properties: {
    // `type` 不能省：宿主那条子集里「有 const/enum/properties… 但既没有 type 也没有
    // oneOf」是硬违规（`…const requires type or oneOf`），整条预设都会注册不上。
    found: { type: 'boolean', const: true },
    node: TEXT,
    subject: TEXT,
    /** `lessons/` 下的文件名；空串=这一课还没有正文文件。 */
    file: TEXT,
    markdown: TEXT,
    questions: { type: 'array', items: QUESTION_GROUP_SCHEMA },
    /** 别的科目里也有同一个节点 id 时列在这里（节点 id 只在科目内唯一）。 */
    alsoIn: { type: 'array', items: TEXT },
  },
};

const MISSING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'node', 'reason'],
  properties: {
    found: { type: 'boolean', const: false },
    node: TEXT,
    reason: TEXT,
  },
};

function missing(node: string, reason: string): { found: false; node: string; reason: string } {
  return { found: false, node, reason };
}

/** 节点 id 的合法性：它要能当文件名后缀用，所以路径分隔符与 `..` 一律当「没有这个节点」。 */
function looksLikeNodeId(node: string): boolean {
  return node !== '' && !node.includes('/') && !node.includes('\\') && !node.includes('..');
}

export function lessonReadTool(): StudyToolSpec {
  return {
    name: LESSON_READ_TOOL_NAME,
    description: '按节点 id 取那一课的正文与这一节点的题；只读，找不到就给「没有」。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['node'],
      properties: {
        node: { type: 'string', description: '大纲里的节点 id，例如 net.ip。' },
      },
    },
    reads: ['lessons', 'pool'],
    output: {
      schema: { oneOf: [FOUND_SCHEMA, MISSING_SCHEMA] },
      render: (_args, value: any) => {
        if (!value || value.found !== true) {
          return [{ type: 'text', text: `没有：${value?.reason ?? '读不到这一课'}（节点 ${value?.node ?? '（空）'}）` }];
        }
        const head = `课件 ${value.file || '（还没有正文文件）'}`
          + `（科目 ${value.subject} · 节点 ${value.node}）`
          + `${value.alsoIn.length > 0 ? `；同样的节点 id 也在：${value.alsoIn.join('、')}` : ''}`;
        const questions = value.questions.length === 0
          ? ['这一节点还没有题。']
          : ['## 这一节点的题', ...value.questions.flatMap((group: any) => [
            `锚点：${group.anchor}`,
            JSON.stringify(group.questions, null, 2),
          ])];
        return [{
          type: 'text',
          text: [head, '', value.markdown || '（这一课还没有正文）', '', ...questions].join('\n'),
        }];
      },
    },
    execute: async (args: { node?: unknown }, run) => {
      const node = typeof args?.node === 'string' ? args.node.trim() : '';
      if (node === '') return missing(node, '要给出大纲里的节点 id，例如 net.ip。');
      if (!looksLikeNodeId(node)) {
        return missing(node, `「${node}」不像一个节点 id（带了路径分隔符或 ..）——没有这个节点。`);
      }
      let lessons: LessonRow[];
      let pools: PoolRow[];
      try {
        // 读了域拿不到东西（没工作区、盘上读不了）也给「没有」，不把一个异常丢回会话
        lessons = run.access.read<LessonRow[]>('lessons');
        pools = run.access.read<PoolRow[]>('pool');
      } catch (error) {
        return missing(node, `读不到课件：${error instanceof Error ? error.message : String(error)}`);
      }
      const hits = lessons.filter((row) => row.node === node).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      if (hits.length === 0) return missing(node, `没有任何科目有这个节点：${node}。`);
      const lesson = hits[0];
      if (!lesson.file) {
        return missing(node, `节点 ${node} 在科目 ${lesson.slug} 的大纲里，但它的正文文件还没有落盘。`);
      }
      const pool = pools.find((row) => row.slug === lesson.slug && row.node === node);
      return {
        found: true,
        node,
        subject: lesson.slug,
        // vault 给的是 `<slug>/<文件名>`；对外用 `lessons/` 下的文件名（与 readLessonFromWorkspace 同一写法）
        file: lesson.file.startsWith(`${lesson.slug}/`)
          ? lesson.file.slice(lesson.slug.length + 1)
          : lesson.file,
        markdown: lesson.markdown,
        questions: questionGroups(pool?.pool),
        alsoIn: hits.slice(1).map((row) => row.slug),
      };
    },
  };
}
