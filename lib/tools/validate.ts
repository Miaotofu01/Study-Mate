/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— 四个**校验**工具

   它们替掉技能里那四条 那四条 Python 引擎命令，回报的是**逐条问题**
   （文件 + 行号 + 是否阻断）与一句明确结论，不是 exit code。校验逻辑一行都不在这里重写：

     · `studymate_validate_curriculum` → `lib/core/validate.ts` 的 validateCurriculum /
       validateProgress / validateSubject（按文件名分派；也可以直接给科目目录，一次校验三份）。
       给科目目录（或 `RESOURCES.md` 本身）时另判**「资源清单」对大纲节点的覆盖率**：每个节点
       至少一处来源、条数不超过节点数 × 2（#130，判据全在提示上，不阻断）
     · `studymate_validate_lesson`     → `lib/core/lesson.ts` 的 parseLesson（内容格式 +
       锚点四态对账 + 图片存在性；DOM 结构检查随静态渲染一起退役）
     · `studymate_validate_pool`       →迁移前的 Python 图片库校验器的**行为移植**（图片库索引
       与图片目录逐行对账）。为什么是移植而不是复用：那一层在 Python 里，`lib/core/**` 里
       没有对应的纯函数实现，而 #68 之后技能不再调 Python。
     · `studymate_validate_handoff`    → `lib/core/validate.ts` 的 validateHandoff（盘上快照
       由 `vault.ts` 走一遍 fs，与测试里那个 walker 同一形状）。它另走一条**旁路**：若
       `deliver/` 里有 `RESOURCES.md`，就按节给出条目数、域名分布与内容指纹（核验台账
       回答「这一份核过没有」）——总控看摘要就不必把清单读进上下文

   包内 `schemas/*.json` 是**插件自己的契约**（每个工作区都一样、随包发货），不走域 guard：
   guard 管的是学习数据。这一句是刻意的，别把 schema 也塞进数据域——它由
   `packagedSchema()` 按相对说明符动态 import，不经过 `vault.ts`。
   ───────────────────────────────────────────────────────────────────────── */

import path from 'node:path';

import {
  validateCurriculum, validateHandoff, validateProgress, validateResources, validateSubject,
} from '../core/validate.ts';
import type { HandoffSection, StudyProblem, ValidationReport } from '../core/validate.ts';
import { decodeImageSrc, FormatProblems, cmpCodePoints } from '../core/format.ts';
import { parseLesson, poolJsonError, reportPoolShape } from '../core/lesson.ts';
import { isSourceSection } from '../core/resources.ts';
import { fingerprintSections, sectionLine } from '../reach/sections.ts';
import { loadVerified } from '../reach/cache.ts';
import { joinPath, lessonFilesUnder, pathFactsOf, resolveGiven } from './paths.ts';
import type { StudyToolSpec } from './define.ts';
import type { DomainAccess } from '../host/access.ts';
import type { AssetsView, StageView, YamlView } from '../host/vault.ts';

/* ── 公用：包内 schema、问题形状、结论 ──────────────────────────────────── */

const TEXT = { type: 'string' } as const;
const INTEGER = { type: 'integer' } as const;

const PROBLEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'line', 'message', 'blocking'],
  properties: {
    file: TEXT, line: INTEGER, message: TEXT,
    column: INTEGER,
    blocking: { type: 'boolean' },
  },
};

const REPORT_KEYS = {
  file: TEXT,
  summary: TEXT,
  blocking: { type: 'boolean' },
  blockingCount: INTEGER,
  problems: { type: 'array', items: PROBLEM_SCHEMA },
};

const schemaCache = new Map<string, unknown>();

/**
 * 读包内的一份 schema（`schemas/` 随包发货）。
 *
 * 为什么用**相对说明符的动态 import**，而不是 `import.meta.url` 拼绝对路径：本包没有
 * `"type": "module"`，tsc 按 nodenext 把 `.ts` 当 CJS 看，`import.meta` 直接报 TS1470；
 * 而相对说明符由 Node 按**这个文件自己的 URL** 解析，不需要知道包根在哪。
 * 说明符拼成变量，是为了别让 tsc 去静态解析 JSON（`resolveJsonModule` 没开）。
 */
async function packagedSchema(name: string): Promise<unknown> {
  const cached = schemaCache.get(name);
  if (cached !== undefined) return cached;
  const specifier = `../../schemas/${name}`;
  const loaded = await import(specifier, { with: { type: 'json' } }) as { default: unknown };
  schemaCache.set(name, loaded.default);
  return loaded.default;
}

function blockingProblem(file: string, line: number, message: string): StudyProblem {
  return { file, line, message, blocking: true };
}

function noteProblem(file: string, line: number, message: string): StudyProblem {
  return { file, line, message, blocking: false };
}

/** 解析不出来的 YAML：一条带行号的阻断问题，**不抛**——校验器要的是逐条问题。 */
function yamlProblems(view: YamlView): StudyProblem[] {
  if (!view.present) {
    return [blockingProblem(view.file, 1, '文件不存在（校验器要的是盘上真实存在的那一份）')];
  }
  if (view.error) {
    return [blockingProblem(view.file, view.error.line, `YAML 解不开：${view.error.message}`)];
  }
  return [];
}

function conclusion(problems: StudyProblem[]): {
  blocking: boolean; blockingCount: number; summary: string;
} {
  const blockingCount = problems.filter((problem) => problem.blocking).length;
  return {
    blocking: blockingCount > 0,
    blockingCount,
    summary: blockingCount > 0
      ? `阻断——${blockingCount} 条阻断问题（共 ${problems.length} 条）`
      : (problems.length > 0 ? `放行——${problems.length} 条提示` : '放行——没有问题'),
  };
}

function reportOf(file: string, kind: string, problems: StudyProblem[]): Record<string, unknown> {
  return { file, kind, problems, ...conclusion(problems) };
}

function totals(reports: { blockingCount: number }[]): {
  blocking: boolean; blockingCount: number; summary: string;
} {
  const blockingCount = reports.reduce((sum, report) => sum + report.blockingCount, 0);
  return {
    blocking: blockingCount > 0,
    blockingCount,
    summary: blockingCount > 0
      ? `阻断：${reports.length} 份文件里有 ${blockingCount} 条阻断问题`
      : `放行：${reports.length} 份文件都没有阻断问题`,
  };
}

/* ── 参数里的路径展开：走 `workspace` 域，工具自己不碰 fs（见 `paths.ts`） ── */

/* ══════════════════════════════════════════════════════════════════════════
   一、studymate_validate_curriculum —— 数据层（大纲 / 进度 / 科目档案）
   ══════════════════════════════════════════════════════════════════════════ */

const DATA_FILES = [
  { name: 'curriculum.yaml', kind: 'curriculum' },
  { name: 'progress.yaml', kind: 'progress' },
  { name: 'subject.yaml', kind: 'subject' },
];

const RESOURCES_FILE = 'RESOURCES.md';

function kindOfFile(file: string): string | null {
  const base = path.basename(file);
  if (base === RESOURCES_FILE) return 'resources';
  const found = DATA_FILES.find((entry) => entry.name === base);
  return found === undefined ? null : found.kind;
}

/** 大纲里的节点 id（进度校验的引用完整性要用同一科目的另一半）。 */
function nodeIdsOf(curriculum: unknown): string[] {
  const nodes = (curriculum as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node) => (node && typeof node === 'object' ? (node as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string');
}

/**
 * 「资源清单」的覆盖率报告（#130）：读清单拿条目、读大纲拿节点 id。
 *
 * 返回 `null` = **没什么可判**：清单不在（它由「资料收集」在建课早期产出，工作区里可能
 * 还没有）、大纲不在或读不出节点（那三份数据文件那边已经各自报过问题了）。这时候不编一份
 * 空报告——「没得判」与「判过没问题」是两件事。
 *
 * 报告里另带一份 `hosts`（**站点分布，只报不卡**）：来自核验域的分节摘取，聚合的是
 * 「来源条目」那几节——总控要的「几节、几条、都来自哪些站点」在这一份报告里看全。
 */
function resourcesReport(access: DomainAccess, file: string): Record<string, unknown> | null {
  const view = access.read<{ file: string; present: boolean; markdown: string }>('resources', file);
  if (!view.present) return null;
  const curriculum = access.read<YamlView>('curriculum', joinPath(path.dirname(view.file), 'curriculum.yaml'));
  if (!curriculum.present) return null;
  const nodeIds = nodeIdsOf(curriculum.value);
  if (nodeIds.length === 0) return null;
  const report = validateResources({ file: view.file, markdown: view.markdown, nodeIds });

  const counts = new Map<string, number>();
  for (const section of fingerprintSections(view.markdown)) {
    if (!isSourceSection(section.heading)) continue;
    for (const row of section.hosts) counts.set(row.host, (counts.get(row.host) ?? 0) + row.entries);
  }
  const hosts = [...counts.entries()]
    .map(([host, entries]) => ({ host, entries }))
    .sort((a, b) => (b.entries - a.entries) || cmpCodePoints(a.host, b.host));
  const base = reportOf(view.file, 'resources', report.problems);
  if (hosts.length === 0) return { ...base, hosts };
  const shown = hosts.slice(0, 5).map((row) => `${row.host} ${row.entries} 条`).join('、');
  return {
    ...base,
    hosts,
    summary: `${String(base.summary)}；站点分布（只报不卡）：${hosts.length} 个站点——${shown}`
      + `${hosts.length > 5 ? '…' : ''}`,
  };
}

async function validateOneDataFile(access: DomainAccess, file: string): Promise<Record<string, unknown>> {
  const kind = kindOfFile(file);
  if (kind === null) {
    return reportOf(file, 'unknown', [blockingProblem(file, 1,
      '认不出这份文件该按哪类校验——数据层只有 curriculum.yaml / progress.yaml / subject.yaml '
      + '三份与 RESOURCES.md（也可以直接给科目目录）')]);
  }
  if (kind === 'resources') {
    return resourcesReport(access, file) ?? reportOf(file, kind, []);
  }
  if (kind === 'curriculum') {
    const view = access.read<YamlView>('curriculum', file);
    const problems = yamlProblems(view);
    if (problems.length > 0) return reportOf(file, kind, problems);
    const report: ValidationReport = validateCurriculum({
      file: view.file, value: view.value, text: view.text,
      schema: await packagedSchema('curriculum.schema.json'),
    });
    return reportOf(file, kind, report.problems);
  }
  if (kind === 'progress') {
    const view = access.read<YamlView & { curriculum: unknown }>('progress', file);
    const problems = yamlProblems(view);
    if (problems.length > 0) return reportOf(file, kind, problems);
    const report = validateProgress({
      file: view.file, value: view.value, text: view.text,
      schema: await packagedSchema('progress.schema.json'),
      knownNodeIds: nodeIdsOf(view.curriculum),
    });
    return reportOf(file, kind, report.problems);
  }
  const view = access.read<YamlView & { subjectDir: string | null }>('subjects', file);
  const problems = yamlProblems(view);
  if (problems.length > 0) return reportOf(file, kind, problems);
  const report = validateSubject({
    file: view.file, value: view.value, text: view.text,
    schema: await packagedSchema('subject.schema.json'),
    expectedSlug: view.subjectDir === null ? '' : path.basename(view.subjectDir),
  });
  return reportOf(file, kind, report.problems);
}

/** 一个科目目录 → 它的三份数据文件（存在的读，缺的报一条阻断）。 */
function dataFilesIn(access: DomainAccess, dir: string): { files: string[]; problems: StudyProblem[] } {
  const files: string[] = [];
  const problems: StudyProblem[] = [];
  for (const entry of DATA_FILES) {
    const candidate = joinPath(dir, entry.name);
    const facts = pathFactsOf(access, candidate);
    if (facts.kind === 'file') files.push(candidate);
    else problems.push(blockingProblem(candidate, 1, `${entry.name} 不存在：科目目录里缺这一份`));
  }
  return { files, problems };
}

export function validateCurriculumTool(): StudyToolSpec {
  return {
    name: 'studymate_validate_curriculum',
    description: '校验科目数据文件（大纲、进度、科目档案）与「资源清单」对节点的覆盖率，逐条回报文件、行号与是否阻断。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['paths'],
      properties: {
        paths: {
          type: 'array',
          items: TEXT,
          description: '数据文件或科目目录；给目录就校验它的三份数据文件。',
        },
      },
    },
    reads: ['workspace', 'curriculum', 'progress', 'subjects', 'resources'],
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['reports', 'blocking', 'blockingCount', 'summary'],
        properties: {
          reports: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'kind', 'summary', 'blocking', 'blockingCount', 'problems'],
              properties: {
                kind: TEXT,
                ...REPORT_KEYS,
                // #130：只有 `kind: 'resources'` 那一份带它（站点分布，只报不卡）。
                hosts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['host', 'entries'],
                    properties: { host: TEXT, entries: INTEGER },
                  },
                },
              },
            },
          },
          blocking: { type: 'boolean' },
          blockingCount: INTEGER,
          summary: TEXT,
        },
      },
      render: (_args, value: any) => [{
        type: 'text',
        text: [
          value.summary,
          ...value.reports.flatMap((report: any) => report.problems
            .map((problem: any) => `${problem.blocking ? '阻断' : '提示'} `
              + `${problem.file}:${problem.line} ${problem.message}`)),
        ].join('\n'),
      }],
    },
    execute: async (args: { paths: string[] }, run) => {
      const reports: Record<string, unknown>[] = [];
      for (const target of args.paths) {
        const facts = resolveGiven(run.access, target);
        if (facts.kind === 'dir') {
          const { files, problems } = dataFilesIn(run.access, facts.path);
          for (const problem of problems) {
            reports.push(reportOf(problem.file, 'missing', [problem]));
          }
          for (const file of files) reports.push(await validateOneDataFile(run.access, file));
          // 「资源清单」是第四份（可选）：在就一并判覆盖率，不在就不编一份空报告。
          const resources = resourcesReport(run.access, joinPath(facts.path, RESOURCES_FILE));
          if (resources !== null) reports.push(resources);
        } else {
          reports.push(await validateOneDataFile(run.access, facts.path));
        }
      }
      return { reports, ...totals(reports as { blockingCount: number }[]) };
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   二、studymate_validate_lesson —— 内容层（格式 + 锚点四态 + 图片存在性）
   ══════════════════════════════════════════════════════════════════════════ */

interface OutlineNode {
  id: string;
  title: string;
  /** `<4 位序号>-<节点id>.md` 里的序号，来自 `nodes:` 顺序。 */
  number: string;
}

function outlineNodes(access: DomainAccess, subjectDir: string | null): OutlineNode[] {
  if (subjectDir === null) return [];
  const view = access.read<YamlView>(
    'curriculum', joinPath(subjectDir, 'curriculum.yaml'),
  );
  const nodes = (view.value as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.map((node, index) => {
    const record = (node ?? {}) as Record<string, unknown>;
    return {
      id: typeof record.id === 'string' ? record.id : '',
      title: typeof record.title === 'string' ? record.title : '',
      number: String(index + 1).padStart(4, '0'),
    };
  });
}

function outlineNodeFor(nodes: OutlineNode[], file: string): OutlineNode | null {
  const base = path.basename(file).replace(/\.md$/, '');
  return nodes.find((node) => node.id !== '' && base === `${node.number}-${node.id}`) ?? null;
}

function validateOneLesson(
  access: DomainAccess, file: string, subjectDir: string | null,
): Record<string, unknown> {
  const problems = new FormatProblems();
  const notes: StudyProblem[] = [];
  const view = access.read<{ file: string; present: boolean; text: string }>('lessons', file);
  if (!view.present) {
    return {
      file: view.file, blocking: true, blockingCount: 1,
      summary: '阻断——1 条阻断问题（共 1 条）',
      problems: [blockingProblem(view.file, 1, '课件内容文件不存在（校验器要的是盘上真实存在的那一份）')],
      anchors: [], orphans: [],
    };
  }

  const poolFile = view.file.replace(/\.md$/, '.quiz.json');
  const poolView = access.read<{
    file: string; present: boolean; text: string; value: unknown; error: Error | null;
  }>('pool', poolFile);
  const poolPresent = poolView.present;
  let pool: Record<string, unknown> | null = null;
  if (poolPresent) {
    if (poolView.error) {
      // 语法错照 Python 的口径报一条普通错误，后面的对账按「没有题」走
      poolJsonError(poolView.text, poolView.error, poolView.file, problems);
    } else if (poolView.value === null || typeof poolView.value !== 'object'
      || Array.isArray(poolView.value)) {
      // 顶层不是对象：形状坏**不影响**后面的对账（Python 的 load_quiz 收了这条错照样返回）
      reportPoolShape(poolView.file, problems);
    } else {
      pool = poolView.value as Record<string, unknown>;
    }
  }

  const node = outlineNodeFor(outlineNodes(access, subjectDir), view.file);
  const result = parseLesson(view.text, view.file, {
    pool,
    poolFile: poolView.file,
    poolPresent,
    poolRaw: poolPresent ? poolView.text : undefined,
    outlineTitle: node?.title,
    nodeId: node?.id,
    // 图片存在性：`::: figure` 的本地相对路径按**课件同目录**解析（与迁移前的 Python 渲染器同口径）
    checkFigureSrc: (src) => {
      const decoded = path.resolve(path.dirname(view.file), decodeImageSrc(src));
      const facts = access.read<{ file: string; present: boolean }>('assets', decoded);
      return facts.present ? null
        : `图片文件不存在：${src}（解析到 ${decoded}）——从科目图片库 `
          + 'assets/img/pool/ 挑一张，或先采图';
    },
  });

  // 提示（软）与错误（阻断）合成一条清单：`blocking` 把两者分开，调用方按它决定放行。
  // `problems` 是本函数自己那一份收集器（题库 JSON 坏、顶层不是对象），`result.errors` 是
  // `parseLesson` 内部那一份——两边**都要收**，按 `file:line:message` 去重（两个实例各自
  // 去重，合起来会重复）。
  const merged = new Map<string, { file: string; line: number; message: string }>();
  for (const error of [...problems.errors, ...result.errors]) {
    merged.set(`${error.file}\n${error.line}\n${error.message}`, error);
  }
  const converted = [...merged.values()].map((error) => blockingProblem(error.file, error.line, error.message));
  for (const note of result.notes) {
    notes.push(noteProblem(note.file, note.line, note.message));
  }
  const allProblems = [...converted, ...notes];
  const anchors = (result.reconciliation?.anchors ?? []).map((anchor) => ({
    text: anchor.text, resolution: anchor.resolution, line: anchor.line, keys: anchor.keys,
  }));
  const orphans = (result.reconciliation?.orphans ?? []).map((orphan) => ({
    key: orphan.key, line: orphan.line, count: orphan.count,
  }));
  return {
    file: view.file,
    node: node === null ? null : { id: node.id, title: node.title, number: node.number },
    poolFile: poolView.file,
    poolPresent,
    ...conclusion(allProblems),
    problems: allProblems,
    anchors,
    orphans,
  };
}

export function validateLessonTool(): StudyToolSpec {
  return {
    name: 'studymate_validate_lesson',
    description: '校验课件内容文件与题库：格式、锚点四态对账、图片存在性，逐条回报行号与是否阻断。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['paths'],
      properties: {
        paths: {
          type: 'array',
          items: TEXT,
          description: '课件内容文件（.md）、lessons 目录或科目目录。',
        },
        subject: { type: 'string', description: '科目目录，用来取大纲里这一课的 title。' },
      },
    },
    reads: ['workspace', 'curriculum', 'lessons', 'pool', 'assets'],
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['reports', 'blocking', 'blockingCount', 'summary'],
        properties: {
          reports: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'summary', 'blocking', 'blockingCount', 'problems'],
              properties: {
                ...REPORT_KEYS,
                poolFile: TEXT,
                poolPresent: { type: 'boolean' },
                node: {
                  oneOf: [{
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'title', 'number'],
                    properties: { id: TEXT, title: TEXT, number: TEXT },
                  }, { type: 'null' }],
                },
                anchors: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['text', 'resolution', 'line', 'keys'],
                    properties: {
                      text: TEXT, line: INTEGER,
                      resolution: { type: 'string', enum: ['resolved', 'stale', 'ambiguous', 'missing'] },
                      keys: { type: 'array', items: TEXT },
                    },
                  },
                },
                orphans: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['key', 'line', 'count'],
                    properties: { key: TEXT, line: INTEGER, count: INTEGER },
                  },
                },
              },
            },
          },
          blocking: { type: 'boolean' },
          blockingCount: INTEGER,
          summary: TEXT,
        },
      },
      render: (_args, value: any) => [{
        type: 'text',
        text: [
          value.summary,
          ...value.reports.flatMap((report: any) => report.problems
            .map((problem: any) => `${problem.blocking ? '阻断' : '提示'} `
              + `${problem.file}:${problem.line} ${problem.message}`)),
        ].join('\n'),
      }],
    },
    execute: async (args: { paths: string[]; subject?: string }, run) => {
      const reports: Record<string, unknown>[] = [];
      for (const target of args.paths) {
        for (const file of lessonFilesUnder(run.access, target)) {
          const facts = resolveGiven(run.access, file);
          const subjectDir = (typeof args.subject === 'string' && args.subject.trim() !== ''
            ? resolveGiven(run.access, args.subject).path
            : facts.subjectDir);
          reports.push(validateOneLesson(run.access, facts.path, subjectDir));
        }
      }
      return { reports, ...totals(reports as { blockingCount: number }[]) };
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   三、studymate_validate_pool —— 图片库索引（迁移前的 Python 图片库校验器的行为移植）
   ══════════════════════════════════════════════════════════════════════════ */

const INDEX_REL = 'assets/img/pool.md';
const POOL_REL = 'assets/img/pool';
const REQUIRED_COLUMNS = ['文件', '主题标签', '一句话说明', '来源 URL', '许可', '尺寸', '抓取日期'];
const POOL_NAME_CHARS = '0-9A-Za-z\\u4e00-\\u9fa5';
const POOL_NAME_EXT = 'png|jpg|jpeg|webp|gif';
const POOL_NAME_RE = new RegExp(
  `^[${POOL_NAME_CHARS}]+(?:-[${POOL_NAME_CHARS}]+){3,}-[0-9]{2,}\\.(?:${POOL_NAME_EXT})$`);
const POOL_NAME_MAX = 60;
const POOL_NAME_SHAPE = '<主题>-<子主题>-<要点>-<来源缩写>-<NN>.<ext>';
const MAX_BYTES = 500 * 1024;
const SEPARATOR_RE = /^:?-{2,}:?$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function splitRow(line: string): string[] {
  const cells = line.trim().split('|').map((cell) => cell.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function isSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => SEPARATOR_RE.test(cell));
}

function findHeader(lines: string[]): { number: number; cells: string[] | null } {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes('|')) continue;
    const cells = splitRow(line);
    if (cells.includes('文件')) return { number: index + 1, cells };
  }
  return { number: 0, cells: null };
}

/** 抓取日期要写成有效的 YYYY-MM-DD；格式对但日期不存在（2026-02-30）也要拦。 */
function isCalendarDate(text: string): boolean {
  if (!DATE_RE.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function checkPoolRow(
  cells: string[], index: Map<string, number>, files: Map<string, number>, line: number,
): StudyProblem[] {
  const problems: StudyProblem[] = [];
  const cellOf = (name: string): string => {
    const position = index.get(name);
    return position !== undefined && position < cells.length ? cells[position] : '';
  };
  const name = cellOf('文件');
  if (name === '') {
    return [blockingProblem('', line, '`文件` 是空的（每行要写图片库里的文件名）')];
  }
  const bytes = files.get(name);
  const exists = bytes !== undefined;
  if (!exists) problems.push(blockingProblem('', line, `文件缺失：图片库里没有 ${POOL_REL}/${name}`));
  if (name.length > POOL_NAME_MAX) {
    problems.push(blockingProblem('', line,
      `文件名不合规：${name.length} 字符 > ${POOL_NAME_MAX} 字符（${name}）`));
  } else if (!POOL_NAME_RE.test(name)) {
    problems.push(blockingProblem('', line,
      `文件名不合规：要 \`${POOL_NAME_SHAPE}\`（只用 ${POOL_NAME_CHARS}、无空格）：${name}`));
  }
  for (const [column, hint] of [
    ['来源 URL', '这条图所在页面的地址，不是图片文件地址'],
    ['许可', '页面没标注也要写「未标注」'],
    ['抓取日期', '抓取那天，要写成 `YYYY-MM-DD` 这样的日期'],
  ] as const) {
    if (index.get(column) !== undefined && cellOf(column) === '') {
      problems.push(blockingProblem('', line, `\`${column}\` 为空（${hint}）`));
    }
  }
  const captured = cellOf('抓取日期');
  if (captured !== '' && !isCalendarDate(captured)) {
    problems.push(blockingProblem('', line, '`抓取日期` 要写成有效的 YYYY-MM-DD 日期'));
  }
  if (exists && bytes > MAX_BYTES) {
    // 只报字节：四舍五入成 KB 时 512001 B 会印成「500 KB > 500 KB」，自相矛盾
    problems.push(blockingProblem('', line, `超体积：${name} ${bytes} B > ${MAX_BYTES} B`
      + `（${MAX_BYTES / 1024} KB 上限；不缩放、超了就放弃）`));
  }
  return problems;
}

function checkSubjectPool(access: DomainAccess, subjectDir: string): Record<string, unknown> {
  const indexFile = joinPath(subjectDir, INDEX_REL);
  const view = access.read<AssetsView>('assets', subjectDir);
  const problems: StudyProblem[] = [];
  const at = (line: number, message: string): StudyProblem => blockingProblem(indexFile, line, message);

  if (!view.index.present) {
    problems.push(at(0, `索引不存在：${INDEX_REL}（索引是图片库的唯一检索入口）`));
    if (view.misplacedIndex) {
      problems.push(at(0, `索引写错了地方：找到 ${POOL_REL}/pool.md——`
        + `它应是图片库目录的兄弟 ${INDEX_REL}`));
    }
    return { dir: subjectDir, indexFile, rows: 0, problems, ...conclusion(problems) };
  }

  const files = new Map(view.files.map((entry) => [entry.name, entry.bytes]));

  // Python 的 `str.splitlines()`：`\r\n` / `\r` / `\n` 都算断行
  const lines = view.index.text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  const header = findHeader(lines);
  if (header.cells === null) {
    problems.push(at(0, `索引里没有表头行（逐字应为 | ${REQUIRED_COLUMNS.join(' | ')} |）`));
    return { dir: subjectDir, indexFile, rows: 0, problems, ...conclusion(problems) };
  }
  const columns = header.cells;
  const missing = REQUIRED_COLUMNS.filter((name) => !columns.includes(name));
  if (missing.length > 0) {
    problems.push(at(header.number, `索引缺列：${missing.join('、')}`));
  } else if (columns.join('|') !== REQUIRED_COLUMNS.join('|')) {
    problems.push(at(header.number, '表头与固定表头不一致（逐字应为 '
      + `| ${REQUIRED_COLUMNS.join(' | ')} |）：| ${columns.join(' | ')} |`));
  }
  const index = new Map<string, number>();
  columns.forEach((name, position) => { if (!index.has(name)) index.set(name, position); });

  let rows = 0;
  for (let number = header.number + 1; number <= lines.length; number += 1) {
    const line = lines[number - 1];
    if (line.trimStart().startsWith('#')) break;   // 表到此为止（索引末尾是 `## Gaps` 小节）
    if (!line.includes('|')) continue;
    const cells = splitRow(line);
    if (isSeparator(cells)) continue;
    rows += 1;
    if (cells.length !== columns.length) {
      problems.push(at(number, `数据行列数不对：应为 ${columns.length} 列，实际 ${cells.length} 列`));
    }
    for (const problem of checkPoolRow(cells, index, files, number)) {
      problems.push({ ...problem, file: indexFile });
    }
  }
  return { dir: subjectDir, indexFile, rows, problems, ...conclusion(problems) };
}

export function validatePoolTool(): StudyToolSpec {
  return {
    name: 'studymate_validate_pool',
    description: '校验科目图片库：pool.md 索引与图片目录逐行对账，逐条回报行号与是否阻断。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['paths'],
      properties: {
        paths: {
          type: 'array',
          items: TEXT,
          description: '科目目录或它的 assets/img/pool.md。',
        },
      },
    },
    reads: ['workspace', 'assets'],
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['reports', 'blocking', 'blockingCount', 'summary'],
        properties: {
          reports: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'dir', 'rows', 'summary', 'blocking', 'blockingCount', 'problems'],
              properties: { dir: TEXT, indexFile: TEXT, rows: INTEGER, ...REPORT_KEYS },
            },
          },
          blocking: { type: 'boolean' },
          blockingCount: INTEGER,
          summary: TEXT,
        },
      },
      render: (_args, value: any) => [{
        type: 'text',
        text: [
          value.summary,
          ...value.reports.flatMap((report: any) => report.problems
            .map((problem: any) => `${problem.file}:${problem.line} ${problem.message}`)),
        ].join('\n'),
      }],
    },
    execute: async (args: { paths: string[] }, run) => {
      const reports: Record<string, unknown>[] = [];
      for (const target of args.paths) {
        const facts = resolveGiven(run.access, target);
        const dir = facts.kind === 'dir' ? facts.path : path.dirname(facts.path);
        const report = checkSubjectPool(run.access, dir);
        reports.push({ ...report, file: report.indexFile as string });
      }
      return { reports, ...totals(reports as { blockingCount: number }[]) };
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   四、studymate_validate_handoff —— 交接门禁
   ══════════════════════════════════════════════════════════════════════════ */

/** `resources` 域给的清单视图（`lib/host/vault.ts` 的 `resources` 分支）。 */
interface ResourcesView {
  file: string;
  present: boolean;
  markdown: string;
  bytes: number;
}

const SECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['heading', 'entries', 'hosts', 'sha256', 'verified'],
  properties: {
    heading: TEXT,
    entries: INTEGER,
    hosts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['host', 'entries'],
        properties: { host: TEXT, entries: INTEGER },
      },
    },
    sha256: TEXT,
    verified: { type: 'boolean' },
  },
};

/**
 * 把 `deliver/RESOURCES.md` 读成逐节摘要。**这是旁路**：读不到、没这份文件、路径不合法，
 * 一律给空列表——门禁的结论只由交接边界决定，不能因为一份附属材料读不到而改判。
 *
 * `verified` 问的是核验工具的**指纹台账**（插件私有，不进学习工作区）：这一份内容
 * 核过没有，看指纹在不在里面——而不是看角色有没有说「核过了」。
 */
function handoffSections(access: DomainAccess, stagePath: string): HandoffSection[] {
  let view: ResourcesView;
  try {
    view = access.read<ResourcesView>('resources', path.join(stagePath, 'deliver', 'RESOURCES.md'));
  } catch {
    return [];
  }
  if (!view.present) return [];
  const verified = loadVerified();
  return fingerprintSections(view.markdown).map((section) => ({
    heading: section.heading,
    entries: section.entries,
    hosts: section.hosts,
    sha256: section.sha256,
    verified: verified.has(section.sha256),
  }));
}

export function validateHandoffTool(): StudyToolSpec {
  return {
    name: 'studymate_validate_handoff',
    description: '校验角色交接暂存区（handoff.json 与 deliver/），给出明确的放行或阻断结论。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['stage', 'role'],
      properties: {
        stage: { type: 'string', description: '暂存目录，绝对路径或相对工作区。' },
        role: { type: 'string', description: '期望交付的角色名，例如 curriculum-designer。' },
        node: { type: 'string', description: '节点级任务给节点 id；科目级任务省略。' },
      },
    },
    reads: ['handoff', 'resources'],
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['stage', 'verdict', 'blocking', 'blockingCount', 'role', 'outputs',
          'sections', 'summary', 'problems'],
        properties: {
          stage: TEXT,
          verdict: { type: 'string', enum: ['pass', 'block'] },
          blocking: { type: 'boolean' },
          blockingCount: INTEGER,
          role: { oneOf: [TEXT, { type: 'null' }] },
          outputs: INTEGER,
          sections: { type: 'array', items: SECTION_SCHEMA },
          summary: TEXT,
          problems: { type: 'array', items: PROBLEM_SCHEMA },
        },
      },
      render: (_args, value: any) => [{
        type: 'text',
        text: [
          `交接门禁：${value.verdict === 'pass' ? '放行' : '阻断'}（${value.stage}）`,
          value.summary,
          ...value.sections.map((section: any) => sectionLine(section)),
          ...value.problems.map((problem: any) => `${problem.file}:${problem.line} ${problem.message}`),
        ].join('\n'),
      }],
    },
    execute: async (args: { stage: string; role: string; node?: string }, run) => {
      const view = run.access.read<StageView>('handoff', args.stage);
      const verdict = validateHandoff({
        stagePath: view.stage,
        manifestText: view.manifest.text,
        entries: view.entries,
        expectedRole: args.role,
        expectedNode: args.node ?? null,
        schema: await packagedSchema('agent-handoff.schema.json'),
        sections: handoffSections(run.access, view.stage),
      });
      return {
        stage: verdict.stagePath,
        verdict: verdict.verdict,
        blocking: verdict.blocking,
        blockingCount: verdict.problems.filter((problem) => problem.blocking).length,
        role: verdict.role,
        outputs: verdict.outputs,
        sections: verdict.sections,
        summary: verdict.summary,
        problems: verdict.problems,
      };
    },
  };
}
