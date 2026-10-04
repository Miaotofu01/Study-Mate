/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— 两个**改写**工具

   它们替掉技能里的两条 bash：

     · `studymate_renumber_lessons`    ←迁移前的 Python 位次重排脚本
     · `studymate_apply_empty_reasons` ←迁移前的 Python 无题理由回填脚本

   **行为照搬那两个脚本**（它们是这两个动作唯一的现行口径，#83 才删），只去掉一件事：
   `--render`。页面不再预生成（目标态 §5.1：`lessons/*.html` 退役），所以「改完名再重渲染」
   这一步整个不存在了。

   写盘**必须**过 `access.write(domain, path, fn)`：钩子在 guard 之内，声明里没写的字段
   回调根本不会执行（issue #68 验收第 3 条）。两个工具的声明都是最小集合：
   重排只动 `lessons/` 里的**文件名**，空题理由只动内容文件里的 **empty_reason 字段**。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

import { isFenceLine } from '../core/format.ts';
import { joinPath, pathFactsOf, subjectDirOf } from './paths.ts';
import type { DomainAccess } from './access.ts';
import type { StudyProblem } from '../core/validate.ts';
import type { StudyToolSpec } from './define.ts';
import type { YamlView } from './vault.ts';

const TEXT = { type: 'string' } as const;
const INTEGER = { type: 'integer' } as const;

const PROBLEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'line', 'message', 'blocking'],
  properties: { file: TEXT, line: INTEGER, message: TEXT, blocking: { type: 'boolean' } },
};

const LESSONS = 'lessons';
const NUM_WIDTH = 4;
/** 三件套的后缀（长的在前：`.quiz.json` 是双扩展名）。`html` 是退役产物，旧工作区里还在，
 * 序号照样跟着大纲走——#83 删脚本时一并决定它的去留。 */
const LESSON_EXTS = ['.quiz.json', '.md', '.html'];
const EXT_ORDER: Record<string, number> = { md: 0, 'quiz.json': 1, html: 2 };
const NAME_RE = /^(\d+)-(.+)$/;

function blocking(file: string, line: number, message: string): StudyProblem {
  return { file, line, message, blocking: true };
}

/** `0008-cpp.array.quiz.json` → `{num:'0008', node:'cpp.array', ext:'quiz.json'}`；认不出回 null。 */
function splitLessonName(name: string): { num: string; node: string; ext: string } | null {
  let head: string | null = null;
  let ext = '';
  for (const candidate of LESSON_EXTS) {
    if (name.endsWith(candidate) && name.length > candidate.length) {
      head = name.slice(0, -candidate.length);
      ext = candidate.slice(1);
      break;
    }
  }
  if (head === null) return null;
  const match = NAME_RE.exec(head);
  if (match === null) return null;
  return { num: match[1], node: match[2], ext };
}

/** 认不出的命名给一句原因（它只是没被接管，不是错误）。 */
function unknownReason(name: string): string {
  const head = /^(\d+)-/.exec(name);
  if (head === null) return `没有「${NUM_WIDTH} 位序号-」前缀`;
  if (head[1].length !== NUM_WIDTH) return `序号 ${head[1]} 不是 ${NUM_WIDTH} 位补零`;
  return '认不出的命名（后缀要正好是 md / quiz.json / html）';
}

/** 大纲的 `nodes:` 顺序 → {节点 id: 1 起位次}；读不了或节点不在里面都回报给调用方。 */
function lessonOrder(
  access: DomainAccess, subjectDir: string,
): { order: Map<string, number>; problems: StudyProblem[] } {
  const file = joinPath(subjectDir, 'curriculum.yaml');
  const view = access.read<YamlView>('curriculum', file);
  if (!view.present) {
    return { order: new Map(), problems: [blocking(file, 1, '找不到 curriculum.yaml：位次就是 `nodes:` 的顺序')] };
  }
  if (view.error) {
    return { order: new Map(), problems: [blocking(file, view.error.line, `大纲读不出来：${view.error.message}`)] };
  }
  const nodes = (view.value as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) {
    return { order: new Map(), problems: [blocking(file, 1, 'curriculum.yaml 里没有 nodes: 列表')] };
  }
  const order = new Map<string, number>();
  nodes.forEach((node, index) => {
    const record = (node ?? {}) as Record<string, unknown>;
    if (typeof record.id === 'string' && !order.has(record.id)) order.set(record.id, index + 1);
  });
  return { order, problems: [] };
}

/* ══════════════════════════════════════════════════════════════════════════
   一、studymate_renumber_lessons
   ══════════════════════════════════════════════════════════════════════════ */

interface Rename {
  node: string;
  ext: string;
  from: string;
  to: string;
}

function planRenames(
  access: DomainAccess, lessonsDir: string, order: Map<string, number>,
): { renames: Rename[]; duplicates: { node: string; ext: string; files: string[] }[];
  untouched: { file: string; reason: string }[] } {
  const found = new Map<string, { name: string; num: string }[]>();
  const untouched: { file: string; reason: string }[] = [];
  for (const name of pathFactsOf(access, lessonsDir).entries) {
    const facts = pathFactsOf(access, joinPath(lessonsDir, name));
    if (facts.kind === 'dir') {
      untouched.push({ file: name, reason: '是目录，不是课件文件' });
      continue;
    }
    if (facts.kind !== 'file') continue;      // 断链的符号链接之类：既不认、也不动
    const parsed = splitLessonName(name);
    if (parsed === null) {
      untouched.push({ file: name, reason: unknownReason(name) });
      continue;
    }
    if (parsed.num.length !== NUM_WIDTH) {
      untouched.push({ file: name, reason: `序号 ${parsed.num} 不是 ${NUM_WIDTH} 位补零` });
      continue;
    }
    if (!order.has(parsed.node)) {
      untouched.push({ file: name, reason: `节点 id「${parsed.node}」不在 curriculum.yaml 的 nodes: 里` });
      continue;
    }
    const key = `${parsed.node}\u0000${parsed.ext}`;
    const bucket = found.get(key) ?? [];
    bucket.push({ name, num: parsed.num });
    found.set(key, bucket);
  }

  const renames: Rename[] = [];
  const duplicates: { node: string; ext: string; files: string[] }[] = [];
  const sorted = [...found.entries()].sort((a, b) => {
    const [nodeA, extA] = a[0].split('\u0000');
    const [nodeB, extB] = b[0].split('\u0000');
    return (order.get(nodeA)! - order.get(nodeB)!)
      || (EXT_ORDER[extA] - EXT_ORDER[extB]);
  });
  for (const [key, items] of sorted) {
    const [node, ext] = key.split('\u0000');
    if (items.length > 1) {
      duplicates.push({ node, ext, files: items.map((item) => item.name) });
      continue;
    }
    const want = String(order.get(node)).padStart(NUM_WIDTH, '0');
    if (items[0].num === want) continue;      // 序号已经对：跳过
    renames.push({
      node, ext, from: items[0].name, to: `${want}-${node}.${ext}`,
    });
  }
  return { renames, duplicates, untouched };
}

/**
 * 按计划改名。**没有**临时名那一步——这是相对迁移前的 Python 位次重排脚本的一处刻意简化：
 *
 * 目标名 `<位次>-<节点id>.<后缀>` 里带着节点 id，所以「谁想改成它」只可能是同一个节点。
 * 于是目标名要么空着（直接改），要么被**同一个节点**的另一份占着（那是 duplicates，前面
 * 已经阻断），要么被目录 / 断链符号链接占着（前面按 `lexists` 阻断）。三种情况都不需要
 * 「先挪到临时名再挪回来」，改名永远不可能是环。Python 里那段 staged 代码在它的命名口径下
 * 同样走不到（同一条推理），留着只会让人以为它被测过。
 *
 * 出错时尽力把已经改的改回去：先规划后执行已经挡住了绝大部分错，这里是兜底。
 */
function applyRenames(access: DomainAccess, lessonsDir: string, renames: Rename[]): string | null {
  const pathOf = (name: string): string => joinPath(lessonsDir, name);
  const done: [string, string][] = [];
  try {
    for (const item of renames) {
      // 每一次真实的文件系统动作都过 guard：声明里没有 `lessons/*` 就在这里抛
      access.write('lessons', `${LESSONS}/${item.to}`, () => {
        fs.renameSync(pathOf(item.from), pathOf(item.to));
      });
      done.push([item.to, item.from]);
    }
  } catch (error) {
    for (const [current, original] of [...done].reverse()) {
      try {
        fs.renameSync(pathOf(current), pathOf(original));
      } catch {
        // 回滚也失败就只能如实说：调用方按报告里的问题核对
      }
    }
    return (error as Error).message;
  }
  return null;
}

export function renumberLessonsTool(): StudyToolSpec {
  return {
    name: 'studymate_renumber_lessons',
    description: '按大纲的 nodes 顺序重排 lessons/ 里课件文件名的四位位次，回报受影响的节点。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['subject'],
      properties: {
        subject: { type: 'string', description: '科目目录，或科目 slug。' },
        dryRun: { type: 'boolean', description: '只算不改，回报将要改的名。' },
      },
    },
    reads: ['workspace', 'curriculum', 'lessons'],
    writes: { lessons: [`${LESSONS}/*`] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'dryRun', 'ok', 'renames', 'changedNodes', 'duplicates',
          'untouched', 'summary', 'problems'],
        properties: {
          subject: TEXT,
          dryRun: { type: 'boolean' },
          ok: { type: 'boolean' },
          renames: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['node', 'ext', 'from', 'to', 'applied'],
              properties: {
                node: TEXT, ext: TEXT, from: TEXT, to: TEXT, applied: { type: 'boolean' },
              },
            },
          },
          changedNodes: { type: 'array', items: TEXT },
          duplicates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['node', 'ext', 'files'],
              properties: { node: TEXT, ext: TEXT, files: { type: 'array', items: TEXT } },
            },
          },
          untouched: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'reason'],
              properties: { file: TEXT, reason: TEXT },
            },
          },
          summary: TEXT,
          problems: { type: 'array', items: PROBLEM_SCHEMA },
        },
      },
      render: (_args, value: any) => [{
        type: 'text',
        text: [
          value.summary,
          ...value.renames.map((item: any) => `${item.from} → ${item.to}`),
          ...value.untouched.map((item: any) => `未处理 ${item.file} —— ${item.reason}`),
          ...value.problems.map((problem: any) => `${problem.file}:${problem.line} ${problem.message}`),
        ].join('\n'),
      }],
    },
    execute: async (args: { subject: string; dryRun?: boolean }, run) => {
      const dryRun = args.dryRun === true;
      const located = subjectDirOf(run.access, args.subject);
      const empty = {
        subject: args.subject, dryRun, ok: false, renames: [], changedNodes: [],
        duplicates: [], untouched: [], problems: [] as StudyProblem[],
      };
      if (located.dir === null) {
        return {
          ...empty,
          summary: '阻断：找不到科目目录',
          problems: [blocking(args.subject, 1,
            `找不到科目目录（试过 ${located.tried.join('、')}）——给绝对路径、相对工作区的路径，或科目 slug`)],
        };
      }
      const subjectDir = located.dir;
      const lessonsDir = joinPath(subjectDir, LESSONS);
      if (pathFactsOf(run.access, lessonsDir).kind !== 'dir') {
        return {
          ...empty, subject: subjectDir,
          summary: '阻断：找不到课件目录',
          problems: [blocking(lessonsDir, 1, `找不到课件目录（科目目录 ${subjectDir} 里应有 ${LESSONS}/）`)],
        };
      }

      const { order, problems } = lessonOrder(run.access, subjectDir);
      if (problems.length > 0) return { ...empty, subject: subjectDir, summary: '阻断：大纲读不出来', problems };

      const plan = planRenames(run.access, lessonsDir, order);
      for (const duplicate of plan.duplicates) {
        problems.push(blocking(joinPath(lessonsDir, duplicate.files[0]), 1,
          `节点 ${duplicate.node} 的 .${duplicate.ext} 有 ${duplicate.files.length} 份`
          + `（${duplicate.files.join('、')}）——一个节点一件，分不清该改哪份（先删掉多余的那份再重跑）`));
      }
      const sources = new Set(plan.renames.map((item) => joinPath(lessonsDir, item.from)));
      for (const item of plan.renames) {
        const target = joinPath(lessonsDir, item.to);
        // `lexists`：断链的符号链接也挡着目标名，与 Python 的 `os.path.lexists` 同口径
        if (pathFactsOf(run.access, target).lexists && !sources.has(target)) {
          problems.push(blocking(target, 1,
            `目标名已存在，且它不是本次要改走的文件——先处理它再重跑（\`${item.from}\` 要改成它）`));
        }
      }

      const changedNodes = [...new Set(plan.renames.map((item) => item.node))]
        .sort((a, b) => order.get(a)! - order.get(b)!);

      if (problems.length > 0) {
        return {
          ...empty, subject: subjectDir, renames: [], changedNodes: [],
          duplicates: plan.duplicates, untouched: plan.untouched,
          summary: `阻断：${problems.length} 条问题，一个文件都没动`, problems,
        };
      }

      let failure: string | null = null;
      if (!dryRun && plan.renames.length > 0) {
        failure = applyRenames(run.access, lessonsDir, plan.renames);
      }
      if (failure !== null) {
        return {
          ...empty, subject: subjectDir, changedNodes: [], duplicates: plan.duplicates,
          untouched: plan.untouched, summary: '阻断：改名中途出错（已尽力改回去）',
          problems: [blocking(lessonsDir, 1, `改名中途出错：${failure}——已经改的已尽力改回去，`
            + '请按上面的清单核对后重跑')],
        };
      }

      const applied = !dryRun && plan.renames.length > 0;
      return {
        subject: subjectDir,
        dryRun,
        ok: true,
        renames: plan.renames.map((item) => ({ ...item, applied })),
        changedNodes,
        duplicates: plan.duplicates,
        untouched: plan.untouched,
        summary: `改了 ${changedNodes.length} 个节点的 ${plan.renames.length} 个文件`
          + `${dryRun ? '（dry-run，一个字都没动盘）' : ''}`
          + `${plan.untouched.length > 0 ? `；${plan.untouched.length} 个文件没被接管` : ''}`,
        problems: [],
      };
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   二、studymate_apply_empty_reasons
   ══════════════════════════════════════════════════════════════════════════ */

const EMPTY_REASON = 'empty_reason';
const FIELD_RE = /^([a-z_]+):\s*(.*)$/;
const DIRECTIVE_RE = /^:::\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*(.*)$/;
const ANCHOR_RE = /^(.*?)锚点[：:]\s*(.+)$/;

interface QuizBlock {
  line: number;              // 1 起
  anchor: string | null;
  indent: string;
  close: number | null;      // 收尾 `:::` 的下标（0 起）
}

function splitEol(part: string): { content: string; eol: string } {
  return part.endsWith('\r') ? { content: part.slice(0, -1), eol: '\r' } : { content: part, eol: '' };
}

function findClose(parts: string[], start: number): number | null {
  let inFence = false;
  for (let index = start + 1; index < parts.length; index += 1) {
    const stripped = splitEol(parts[index]).content.trim();
    if (isFenceLine(stripped)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && stripped === ':::') return index;
  }
  return null;
}

/** 内容文件里的 `::: quiz` 题目位置。围栏（```）里的 `:::` 是代码原文，不算题目位置。 */
function quizBlocks(parts: string[]): QuizBlock[] {
  const blocks: QuizBlock[] = [];
  let inFence = false;
  for (let index = 0; index < parts.length; index += 1) {
    const content = splitEol(parts[index]).content;
    const stripped = content.trim();
    if (isFenceLine(stripped)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = DIRECTIVE_RE.exec(stripped);
    if (match === null || match[1] !== 'quiz') continue;
    const anchor = ANCHOR_RE.exec(match[2].trim());
    blocks.push({
      line: index + 1,
      anchor: anchor === null ? null : anchor[2].trim(),
      indent: content.slice(0, content.length - content.trimStart().length),
      close: findClose(parts, index),
    });
  }
  return blocks;
}

function existingEmptyReason(parts: string[], block: QuizBlock): number | null {
  for (let index = block.line; index < (block.close ?? parts.length); index += 1) {
    const field = FIELD_RE.exec(splitEol(parts[index]).content.trim());
    if (field !== null && field[1] === EMPTY_REASON) return index + 1;
  }
  return null;
}

export function applyEmptyReasonsTool(): StudyToolSpec {
  return {
    name: 'studymate_apply_empty_reasons',
    description: '把出题角色给的无题理由按锚点打进课件内容文件的 empty_reason 字段，回报打进的位置。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'node', 'reasons'],
      properties: {
        subject: { type: 'string', description: '科目目录，或科目 slug。' },
        node: { type: 'string', description: '节点 id（内容文件名按它的位次算）。' },
        reasons: {
          type: 'array',
          description: '每项一个锚点与它的理由；锚点与正文逐字匹配。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['anchor', 'reason'],
            properties: { anchor: TEXT, reason: TEXT },
          },
        },
        dryRun: { type: 'boolean', description: '只算不改，回报将插入的行与位置。' },
      },
    },
    reads: ['workspace', 'curriculum', 'lessons'],
    writes: { lessons: [`${LESSONS}/*#${EMPTY_REASON}`] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'node', 'file', 'dryRun', 'ok', 'inserted', 'summary', 'problems'],
        properties: {
          subject: TEXT,
          node: TEXT,
          file: TEXT,
          dryRun: { type: 'boolean' },
          ok: { type: 'boolean' },
          inserted: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['anchor', 'reason', 'line'],
              properties: { anchor: TEXT, reason: TEXT, line: INTEGER },
            },
          },
          summary: TEXT,
          problems: { type: 'array', items: PROBLEM_SCHEMA },
        },
      },
      render: (_args, value: any) => [{
        type: 'text',
        text: [
          value.summary,
          ...value.inserted.map((item: any) =>
            `插入了 ${EMPTY_REASON}: ${item.anchor} → ${value.file}:${item.line}`),
          ...value.problems.map((problem: any) => `${problem.file}:${problem.line} ${problem.message}`),
        ].join('\n'),
      }],
    },
    execute: async (args: {
      subject: string; node: string; reasons: { anchor: string; reason: string }[]; dryRun?: boolean;
    }, run) => {
      const dryRun = args.dryRun === true;
      const empty = {
        subject: args.subject, node: args.node, file: '', dryRun, ok: false,
        inserted: [], summary: '', problems: [] as StudyProblem[],
      };
      const located = subjectDirOf(run.access, args.subject);
      if (located.dir === null) {
        return { ...empty, summary: '阻断：找不到科目目录', problems: [blocking(args.subject, 1,
          `找不到科目目录（试过 ${located.tried.join('、')}）——给绝对路径、相对工作区的路径，或科目 slug`)] };
      }
      const subjectDir = located.dir;
      const { order, problems } = lessonOrder(run.access, subjectDir);
      const index = order.get(args.node);
      if (problems.length === 0 && index === undefined) {
        problems.push(blocking(joinPath(subjectDir, 'curriculum.yaml'), 1,
          `节点 ${args.node} 不在 curriculum.yaml 的 nodes: 里——内容文件名与序号都按它算`
          + '（核对节点 id 是否写对）'));
      }
      if (problems.length > 0) return { ...empty, subject: subjectDir, summary: '阻断：大纲读不出来', problems };

      const mdFile = joinPath(joinPath(subjectDir, LESSONS),
        `${String(index).padStart(NUM_WIDTH, '0')}-${args.node}.md`);
      const view = run.access.read<{ file: string; present: boolean; text: string }>('lessons', mdFile);
      if (!view.present) {
        return { ...empty, subject: subjectDir, file: mdFile, summary: '阻断：找不到内容文件',
          problems: [blocking(mdFile, 1, `找不到内容文件（节点 ${args.node} 在大纲里的位次是 `
            + `${String(index).padStart(NUM_WIDTH, '0')}）——先让讲解角色产出这一课的 .md`)] };
      }

      const parts = view.text.split('\n');       // 行号口径与渲染器一致：只按 \n 切
      const byAnchor = new Map<string, QuizBlock[]>();
      for (const block of quizBlocks(parts)) {
        if (block.anchor === null) continue;
        byAnchor.set(block.anchor, [...(byAnchor.get(block.anchor) ?? []), block]);
      }

      interface Insert { anchor: string; reason: string; at: number; indent: string; line?: number }
      const seen = new Map<string, number>();
      const inserts: Insert[] = [];
      args.reasons.forEach((row, position) => {
        const anchor = String(row.anchor ?? '').trim();
        const reason = String(row.reason ?? '').trim();
        const at = position + 1;
        if (anchor === '') {
          problems.push(blocking(mdFile, 1, `第 ${at} 项的锚点文本是空的`));
          return;
        }
        if (reason === '') {
          problems.push(blocking(mdFile, 1, `锚点「${anchor}」的理由为空（每项要写理由）`));
          return;
        }
        if (reason.startsWith(EMPTY_REASON)) {
          problems.push(blocking(mdFile, 1,
            `锚点「${anchor}」的理由里不要再写 \`${EMPTY_REASON}:\` 前缀——插进内容文件时会自动加`));
          return;
        }
        if (/[\r\n]/.test(reason)) {
          problems.push(blocking(mdFile, 1, `锚点「${anchor}」的理由里有换行——一行一个理由`));
          return;
        }
        if (seen.has(anchor)) {
          problems.push(blocking(mdFile, 1, `锚点「${anchor}」在参数里出现两次`
            + `（第 ${seen.get(anchor)} 项、第 ${at} 项）——一个锚点只留一项`));
          return;
        }
        seen.set(anchor, at);

        const found = byAnchor.get(anchor) ?? [];
        if (found.length === 0) {
          problems.push(blocking(mdFile, 1,
            `锚点「${anchor}」在内容文件里没有对应的 ::: quiz 题目位置`
            + `（锚点在两个文件之间逐字匹配）：${mdFile}`));
          return;
        }
        if (found.length > 1) {
          problems.push(blocking(mdFile, found[1].line,
            `锚点「${anchor}」被 ${found.length} 个 ::: quiz 题目位置引用（第 `
            + `${found.map((block) => block.line).join('、')} 行）——一个锚点只留一个题目位置`));
          return;
        }
        const block = found[0];
        if (block.close === null) {
          problems.push(blocking(mdFile, block.line,
            `锚点「${anchor}」的 ::: quiz 块没有收尾 :::——先补上收尾行`));
          return;
        }
        const existing = existingEmptyReason(parts, block);
        if (existing !== null) {
          problems.push(blocking(mdFile, existing,
            `锚点「${anchor}」的块里已经有 ${EMPTY_REASON}: 了——不用再插（要改就手改那一行）`));
          return;
        }
        inserts.push({ anchor, reason, at: block.close, indent: block.indent });
      });

      if (problems.length > 0) {
        return { ...empty, subject: subjectDir, file: mdFile,
          summary: `阻断：${problems.length} 条问题，一个文件都没改`, problems };
      }

      inserts.sort((a, b) => a.at - b.at);
      inserts.forEach((item, offset) => { item.line = item.at + 1 + offset; });

      if (inserts.length > 0 && !dryRun) {
        const written: string[] = [...parts];
        for (const item of [...inserts].reverse()) {
          // 最后一行 ::: 可能没有换行；此时沿用前一行的 CRLF/LF，避免插入 LF
          const eolAt = item.at < written.length - 1 ? item.at : item.at - 1;
          const { eol } = splitEol(written[eolAt]);
          written.splice(item.at, 0, `${item.indent}${EMPTY_REASON}: ${item.reason}${eol}`);
        }
        const failure = run.access.write('lessons', `${LESSONS}/${path.basename(mdFile)}#${EMPTY_REASON}`, () => {
          // 先在同目录完整写好，再原子替换；写入失败不能截断原课件
          let temporary: string | null = null;
          try {
            // 临时文件必须与原文件同目录：`rename` 跨文件系统会 EXDEV，原子替换就不成立了
            temporary = path.join(path.dirname(mdFile),
              `.empty-reasons-${process.pid}-${Date.now()}`);
            fs.writeFileSync(temporary, Buffer.from(written.join('\n'), 'utf8'));
            fs.chmodSync(temporary, fs.statSync(mdFile).mode);
            fs.renameSync(temporary, mdFile);
            return null;
          } catch (error) {
            return (error as Error).message;
          } finally {
            if (temporary !== null && fs.existsSync(temporary)) {
              try {
                fs.unlinkSync(temporary);
              } catch {
                // 临时文件清理失败不影响内容：如实留给下一次
              }
            }
          }
        });
        if (failure !== null) {
          return { ...empty, subject: subjectDir, file: mdFile, summary: '阻断：写盘失败',
            problems: [blocking(mdFile, 1, `写盘失败：${failure}`)] };
        }
      }

      return {
        subject: subjectDir,
        node: args.node,
        file: mdFile,
        dryRun,
        ok: true,
        inserted: inserts.map((item) => ({
          anchor: item.anchor, reason: item.reason, line: item.line ?? 0,
        })),
        summary: `打进 ${inserts.length} 处 empty_reason`
          + `${dryRun ? '（dry-run，一个字都没改）' : ''}`,
        problems: [],
      };
    },
  };
}
