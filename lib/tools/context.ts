/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— `studymate_workspace_context`

   替掉「总控开场自己读一堆文件」：一次调用拿到**结构化摘要**——工作区路径、时区与今天、
   科目清单（含当前节点与状态）、最近学习记录、共享记忆的画像三节、可用能力。

   摘要的**返回结构**（`OUTPUT_SCHEMA`）是宿主契约，一个字不动（ADR-0014）；模型真正读到的
   是 `output.render` 拼出来的文本，所以画像三节也必须出现在那段文本里——否则 `description`
   与技能口径承诺的东西模型看不到。文本里只带画像三节（`execute` 用
   `readMemory(...).injectable` 投影，`积累` 已被排除），并按 `MEMORY_RENDER_BUDGET` 个字符
   截断、注明「已截断」。

   读域：workspace / memory / subjects / curriculum / progress / records。
   它们互相之间不越界：`subjects` 的切片里没有题库、没有课件正文（见 `vault.ts` 的逐域投影），
   真去读 pool 会当场抛 DomainViolationError。

   没工作区时**不抛**：开场问「学什么」之前工作区可能还没建，这时要给一个能读的摘要
   （`ready:false` + 一句怎么办），而不是一个异常。
   ───────────────────────────────────────────────────────────────────────── */

import { probeModel } from './capability.ts';
import { legacyMemoryNotice, legacyUnreadableNotice } from '../memory-file.ts';
import { readMemory } from '../core/memory.ts';
import type { ServiceReader } from './capability.ts';
import type { StudyToolSpec } from './define.ts';
import type { WorkspaceFacts } from '../host/vault.ts';

/** 每个科目最多回几条学习记录：开场要的是「最近学到哪」，不是整本档案。 */
export const RECENT_RECORD_LIMIT = 5;

const TEXT = { type: 'string' } as const;
const INTEGER = { type: 'integer' } as const;

const WORKSPACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'configFile', 'ready', 'today', 'timeZone', 'subjectsDir'],
  properties: {
    path: TEXT, configFile: TEXT, subjectsDir: TEXT, today: TEXT, timeZone: TEXT,
    ready: { type: 'boolean' },
  },
};

const NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'kind', 'number', 'tier', 'lesson'],
  properties: {
    id: TEXT, title: TEXT, kind: TEXT, number: TEXT, tier: TEXT, lesson: TEXT,
  },
};

const RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'title', 'date', 'markdown'],
  properties: { file: TEXT, title: TEXT, date: TEXT, markdown: TEXT },
};

const SUBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'name', 'goal', 'status', 'updated_at', 'project', 'levels',
    'tierCounts', 'current', 'nodes', 'recentRecords'],
  properties: {
    slug: TEXT, name: TEXT, goal: TEXT, status: TEXT, updated_at: TEXT, project: TEXT,
    levels: INTEGER,
    tierCounts: {
      type: 'object',
      additionalProperties: false,
      required: ['未开始', '学习中', '已学完'],
      properties: { 未开始: INTEGER, 学习中: INTEGER, 已学完: INTEGER },
    },
    // 没有节点时给 null：空对象会被读成「有一个没名字的节点」
    current: { oneOf: [NODE_SCHEMA, { type: 'null' }] },
    nodes: { type: 'array', items: NODE_SCHEMA },
    recentRecords: { type: 'array', items: RECORD_SCHEMA },
  },
};

const MEMORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'present', 'markdown'],
  properties: { file: TEXT, present: { type: 'boolean' }, markdown: TEXT },
};

const MODEL_CAPABILITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['available'],
  properties: {
    available: { type: 'boolean' },
    reason: TEXT,
    providers: { type: 'array', items: TEXT },
  },
};

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workspace', 'subjects', 'memory', 'capabilities', 'notes'],
  properties: {
    workspace: WORKSPACE_SCHEMA,
    subjects: { type: 'array', items: SUBJECT_SCHEMA },
    memory: MEMORY_SCHEMA,
    capabilities: {
      type: 'object',
      additionalProperties: false,
      required: ['model'],
      properties: { model: MODEL_CAPABILITY_SCHEMA },
    },
    notes: { type: 'array', items: TEXT },
  },
};

interface SubjectFact {
  slug: string;
  name: string;
  goal: string;
  status: string;
  updated_at: string;
  project: string;
  levels: number;
  continue_node: string;
  [key: string]: unknown;
}

interface CurriculumFact {
  slug: string;
  nodes: Record<string, any>[];
}

interface ProgressFact {
  slug: string;
  updated_at: string;
  project: string;
  nodes: Record<string, any>[];
}

interface RecordFact {
  file: string;
  title: string;
  date: string;
  markdown: string;
}

function tierCounts(nodes: Record<string, any>[]): Record<string, number> {
  const counts = { 未开始: 0, 学习中: 0, 已学完: 0 } as Record<string, number>;
  for (const node of nodes) {
    const tier = typeof node.tier === 'string' ? node.tier : '未开始';
    counts[tier] = (counts[tier] ?? 0) + 1;
  }
  return counts;
}

function nodeLine(node: Record<string, any>, tier: string): Record<string, unknown> {
  return {
    id: String(node.id ?? ''),
    title: String(node.title ?? ''),
    kind: String(node.kind ?? ''),
    number: String(node.number ?? ''),
    tier,
    lesson: node.lesson === undefined ? lessonFile(node) : String(node.lesson ?? ''),
  };
}

/** 课件文件名：`<4 位序号>-<节点id>.md`，与 `lessonfile` 同一口径（位次来自大纲）。 */
function lessonFile(node: Record<string, any>): string {
  const number = String(node.number ?? '');
  return number === '' ? '' : `${number}-${String(node.id ?? '')}.md`;
}

function recentRecords(records: RecordFact[]): RecordFact[] {
  // 倒着取：`readLibrary` 按文件名码位排，最新的一课在最后
  return records.slice(-RECENT_RECORD_LIMIT).map((record) => ({
    file: record.file, title: record.title, date: record.date, markdown: record.markdown,
  }));
}

/**
 * 把三门域拼成一份摘要：`subjects` 给科目档案、`curriculum` 给节点与位次、
 * `progress` 给三档状态。**不**从 `subjects` 切片里取 fold 好的节点——那份是给阅读端的
 * 整份快照，这里按域现拼，读域与用到的数据才对得上。
 */
function summarize(input: {
  subjects: SubjectFact[];
  curriculum: Map<string, CurriculumFact>;
  progress: Map<string, ProgressFact>;
  records: Map<string, RecordFact[]>;
  wanted: string;
}): Record<string, unknown>[] {
  return input.subjects
    .filter((subject) => input.wanted === '' || subject.slug === input.wanted)
    .map((subject) => {
      const curriculum = input.curriculum.get(subject.slug);
      const progress = input.progress.get(subject.slug);
      const tiers = new Map<string, string>();
      for (const node of progress?.nodes ?? []) {
        tiers.set(String(node.id ?? ''), typeof node.tier === 'string' ? node.tier : '未开始');
      }
      const nodes = (curriculum?.nodes ?? []) as Record<string, any>[];
      const lines = nodes.map((node) => nodeLine(
        node, tiers.get(String(node.id ?? '')) ?? '未开始',
      ));
      const currentId = subject.continue_node;
      const current = lines.find((line) => line.id === currentId) ?? null;
      return {
        slug: subject.slug,
        name: subject.name,
        goal: subject.goal,
        status: subject.status,
        updated_at: String(progress?.updated_at ?? subject.updated_at ?? ''),
        project: String(progress?.project ?? subject.project ?? ''),
        levels: subject.levels,
        tierCounts: tierCounts(lines),
        current,
        nodes: lines,
        recentRecords: recentRecords(input.records.get(subject.slug) ?? []),
      };
    });
}

/* ── 摘要文本：共享记忆那一段 ──────────────────────────────────────────── */

/**
 * 摘要文本里最多带多少**字符（码点）**的画像三节。
 *
 * 口径是「码点」不是 UTF-16 单元（`[...text].length`）：一个 emoji 算一个字符；与宿主那条
 * 工具结果裁剪阈值的尺子一致（`preset/learning/agent.cordis.yml` 的 `thresholdChars: 8192`，
 * 人读版见 `preset/skills/learning-system/references/tools.md` 讲核验工具「返回值刻意短」
 * 的那一节）。2048 只占四分之一，摘要加上工作区与科目行也不会撞上宿主的静默裁剪。
 */
export const MEMORY_RENDER_BUDGET = 2048;

/** 渲染时从 `memory` 那一格（`MEMORY_SCHEMA`）读的键；`present` 不参与排版（见下面注释）。 */
interface MemorySummary {
  file?: unknown;
  markdown?: unknown;
}

/**
 * 共享记忆在摘要文本里的那几行：**没有可注入的画像内容就一段都不出现**。
 *
 * 「没有」有三种：没有这份文件、文件里只有 `积累`、空骨架——`execute` 交给这里的
 * `markdown` 是 `readMemory(...).injectable` 投影，这三种情况都是空串。此处不再看
 * `present`：新工作区没有共享记忆是常态，不占一行；要判文件在不在，看结构化返回值的
 * `memory.present`（渲染文本只负责「模型要读什么」）。
 *
 * 超预算就按码点截到 [`MEMORY_RENDER_BUDGET`]，下一行注明「已截断」并给完整原文路径：
 * 截断是提示（要细节按路径去读），不是错误；摘要是压缩视图，不是记忆本体。
 *
 * 为什么这里不再自己分一次节：哪几节能进上下文只在 `lib/core/memory.ts` 定义一次
 * （`PROFILE_SECTIONS` / `injectable`），`积累` 与科目记忆一个字都到不了这里——渲染只做
 * 排版与预算，复制一份白名单就会漂。
 */
function renderMemory(memory: MemorySummary | undefined): string[] {
  const markdown = typeof memory?.markdown === 'string' ? memory.markdown : '';
  if (markdown === '') return [];
  const chars = [...markdown];
  const heading = '共享记忆的画像三节：';
  if (chars.length <= MEMORY_RENDER_BUDGET) return ['', heading, markdown];
  const file = typeof memory?.file === 'string' && memory.file !== '' ? memory.file : '';
  return [
    '',
    heading,
    chars.slice(0, MEMORY_RENDER_BUDGET).join(''),
    `（画像三节超过 ${MEMORY_RENDER_BUDGET} 字符，已截断`
      + `${file === '' ? '' : `；完整原文见 ${file}`}）`,
  ];
}

export function workspaceContextTool(ctx: ServiceReader): StudyToolSpec {
  return {
    name: 'studymate_workspace_context',
    description: '读学习工作区，回报路径、今天、科目现状（当前节点与三档进度）、最近学习记录、共享记忆的画像三节与可用能力。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subject: { type: 'string', description: '只看这个科目的 slug；省略就是全部科目。' },
      },
    },
    reads: ['workspace', 'memory', 'subjects', 'curriculum', 'progress', 'records'],
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value: any) => {
        const lines = value.subjects.map((subject: any) => {
          const current = subject.current === null
            ? '没有节点'
            : `当前节点 ${subject.current.number} ${subject.current.title}（${subject.current.tier}）`;
          return `- ${subject.name}（${subject.slug}）：${subject.nodes.length} 个节点，`
            + `${current}；记录 ${subject.recentRecords.length} 条`;
        });
        const model = value.capabilities.model.available
          ? `模型可用（${(value.capabilities.model.providers || []).join('、')}）`
          : `模型不可用：${value.capabilities.model.reason}`;
        return [{
          type: 'text',
          text: [
            `工作区：${value.workspace.path || '（还没配置）'}；今天 ${value.workspace.today}`
              + `（${value.workspace.timeZone}）；${model}`,
            ...(lines.length > 0 ? lines : ['（还没有科目）']),
            ...value.notes,
            // 共享记忆放最后：前面的行是「现在在哪」，画像是「这个人怎么学」；没有就一段都不加
            ...renderMemory(value.memory),
          ].join('\n'),
        }];
      },
    },
    execute: async (args: { subject?: string }, run) => {
      const facts = run.access.read<WorkspaceFacts>('workspace');
      const capabilities = { model: probeModel(ctx) };
      if (!facts.ready) {
        return {
          workspace: facts,
          subjects: [],
          memory: { file: '', present: false, markdown: '' },
          capabilities,
          notes: [facts.path === ''
            ? `还没配置学习工作区：${facts.configFile} 里没有 workspace——先跑一次 npx @yunmiao/studymate install。`
            : `工作区 ${facts.path} 里还没有 .learning/subjects/——还没有科目，先建一个。`],
        };
      }

      const notes: string[] = [];
      let subjects: SubjectFact[] = [];
      const curriculum = new Map<string, CurriculumFact>();
      const progress = new Map<string, ProgressFact>();
      const records = new Map<string, RecordFact[]>();
      try {
        subjects = run.access.read<SubjectFact[]>('subjects');
        for (const entry of run.access.read<CurriculumFact[]>('curriculum')) {
          curriculum.set(entry.slug, entry);
        }
        for (const entry of run.access.read<ProgressFact[]>('progress')) {
          progress.set(entry.slug, entry);
        }
        for (const entry of run.access.read<{ slug: string; records: RecordFact[] }[]>('records')) {
          records.set(entry.slug, entry.records);
        }
      } catch (error) {
        // 科目清单读不出来（坏 YAML 之类）就照实说，不崩
        notes.push(`科目清单读不出来：${(error as Error).message}`);
      }
      /* 读得出来、但一个可用科目都没有（`subjects/` 下只有建课建到一半的目录）：
         这也是「还没有科目」，要照实说一句并给出下一步——只留一行「（还没有科目）」
         学生不知道是没建还是没读出来。`lib/library.ts` 对这种工作区给的是**空清单**
         而不是抛错（#90），所以这句话只能在这里补。 */
      if (subjects.length === 0 && notes.length === 0) {
        notes.push(`工作区 ${facts.path} 里还没有可用科目（建课建到一半、大纲里一个节点都没有的目录不算）——先建一个。`);
      }

      const raw = run.access.read<{
        file: string; present: boolean; markdown: string; legacy?: boolean; unreadable?: boolean;
      }>('memory');
      /* #190：`markdown` 只放**画像三节**的投影——`积累` 是角色攒下的干活笔记，永不进上下文。
         形状（`file` / `present` / `markdown` 三个键）一个字都没动：它是插件与总控之间的字段
         契约，改的是值，不是契约（ADR-0014「宿主契约不动」）。`present` 照实报「文件在不在」，
         所以「只有 `积累`」的文件是 `present: true` + 空 `markdown`。
         旧格式兜底命中时（工作区只有改名前的共享记忆）就在 notes 里直接说一句、给出迁移命令：
         这是总控开场唯一能看到的一行，比只写进宿主日志有用。 */
      const memory = {
        file: raw.file,
        present: raw.present,
        markdown: readMemory({ shared: raw.markdown }).injectable,
      };
      if (raw.legacy === true) {
        // 读不出来（旧文件没有 `##` 分节、转换不出任何一节）与「读到了但请迁移」是两件事：
        // 前者 `markdown` 是空串、注入不进去，提示语不许再说「内容不丢」。
        notes.push(raw.unreadable === true ? legacyUnreadableNotice(raw.file) : legacyMemoryNotice(raw.file));
      }
      const wanted = typeof args.subject === 'string' ? args.subject.trim() : '';
      const selected = summarize({ subjects, curriculum, progress, records, wanted });
      if (wanted !== '' && selected.length === 0) {
        notes.push(`没有 slug 为「${wanted}」的科目；现有的是 `
          + `${subjects.map((subject) => subject.slug).join('、') || '（一个都没有）'}。`);
      }
      return { workspace: facts, subjects: selected, memory, capabilities, notes };
    },
  };
}
