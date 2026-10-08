/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 —— 数据层校验与交接门禁

   目标态规格 §10.1 的「数据层门禁」：`schemas/*.json` 校验、引用完整性、大纲 DAG 无环与
   位次不倒挂、实验课前置非空；外加 Agent 交接协议那道机器门禁，以及「资源清单」对大纲节点的
   覆盖率（「够了」的判据）。这一层把这几类校验都做成
   **纯函数**：出入都是已经解析好的值 + 调用方注入的盘上快照，**不碰文件系统**
   （`decisions.md` §2）。好处是每一条规则都能拿内联字符串当输入断言，现造即弃。

   统一的回报形状是 `{file, line, column?, message, blocking}` 的**逐条问题**——替掉
   「读 exit code」。`file` 由调用方注入：这一层不知道盘上文件叫什么，也不该知道。

   行号来自 `lib/core/yamlpos.ts` / `lib/core/jsonpos.ts`（真实解析位置，不是文本搜索）。
   调用方没给原文时行号退化成 1——**退化成 1 而不是猜一个**，猜出来的行号比没有更坏。
   ───────────────────────────────────────────────────────────────────────── */

import { pointerOf, validateAgainstSchema } from './schema.ts';
import type { SchemaProblem, SchemaPath } from './schema.ts';
import { indexYaml, hasOuterWhitespace } from './yamlpos.ts';
import type { PositionHit } from './yamlpos.ts';
import { indexJson, JsonSyntaxError } from './jsonpos.ts';
// 进度词表（三档 + 旧六档映射）的唯一实现在规则层；这里只读它的判据，不另写一份
import { LEGACY_TIERS, LEGACY_TIER_MAP, isTier } from './rules.ts';
// 「资源清单」的分节与条目解析在 resources.ts（纯函数，无依赖）；这里只做覆盖率判断
import { isSourceSection, resourceEntries } from './resources.ts';

/* ── 统一的回报形状 ───────────────────────────────────────────────────── */

export interface StudyProblem {
  file: string;
  line: number;
  column?: number;
  message: string;
  blocking: boolean;
}

export interface ValidationReport {
  file: string;
  problems: StudyProblem[];
  /** 有没有**阻断**问题——调用方据此决定放行还是拦住，不用去数 problems 的长度。 */
  blocking: boolean;
  blockingCount: number;
  /** 一行中文结论，可直接打给人看。 */
  summary: string;
}

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function summarize(file: string, problems: StudyProblem[]): ValidationReport {
  const blockingCount = problems.filter((problem) => problem.blocking).length;
  const summary = blockingCount > 0
    ? `${file}：阻断——${blockingCount} 条阻断问题（共 ${problems.length} 条）`
    : (problems.length > 0 ? `${file}：放行——${problems.length} 条提示` : `${file}：放行——没有问题`);
  return { file, problems, blocking: blockingCount > 0, blockingCount, summary };
}

function withColumn(line: number, column: number | undefined): { line: number; column?: number } {
  return column === undefined ? { line } : { line, column };
}

/** 一次查询拿到「写进问题的位置」。column 缺省时**不写这个键**，免得出现 `column: undefined`。 */
function place(lookup: Lookup, path: SchemaPath): { line: number; column?: number } {
  const hit = lookup(path);
  return withColumn(hit.line, hit.column);
}

/* ── 位置查找：给了原文才有真行号 ─────────────────────────────────────── */

type Lookup = (path: SchemaPath) => PositionHit;

const NO_POSITION: Lookup = () => ({ line: 1, column: 1, exact: false });

function yamlLookup(text: string | undefined): Lookup {
  if (typeof text !== 'string' || text === '') return NO_POSITION;
  const index = indexYaml(text);
  return (path) => index.at(path);
}

function pushSchemaProblems(
  out: StudyProblem[],
  file: string,
  lookup: Lookup,
  schema: unknown,
  value: unknown,
): void {
  for (const problem of validateAgainstSchema(value, schema)) {
    const hit = lookup(problem.path);
    const pointer = pointerOf(problem.path);
    out.push({
      file,
      ...withColumn(hit.line, hit.column),
      message: `${problem.message}${pointer === '' ? '' : `（位置 ${pointer}）`}`,
      // schema 级问题一律阻断：schema 说得出「哪里不对」，而数据可能压根没被检查到。
      blocking: true,
    });
  }
}

/* ══════════════════════════════════════════════════════════════════════
   一、大纲校验
   ══════════════════════════════════════════════════════════════════════ */

export interface YamlDocumentInput {
  /** 调用方注入的展示路径，进 `StudyProblem.file`。 */
  file: string;
  /** 已经解析好的值（YAML 由 `lib/yaml.ts` 解析，这一层不碰解析器）。 */
  value: unknown;
  /** 原文；给了才有真实行号。 */
  text?: string;
  /** `schemas/curriculum.schema.json` 之类，由调用方读盘并解析后传进来。 */
  schema: unknown;
}

interface StructureError {
  path: SchemaPath;
  message: string;
}

export function validateCurriculum(input: YamlDocumentInput): ValidationReport {
  const problems: StudyProblem[] = [];
  const lookup = yamlLookup(input.text);
  pushSchemaProblems(problems, input.file, lookup, input.schema, input.value);

  if (!isPlainObject(input.value)) {
    problems.push({
      file: input.file,
      line: 1,
      message: '顶层不是 mapping：大纲必须是含 nodes / edges 的对象',
      blocking: true,
    });
    return summarize(input.file, problems);
  }

  const rawNodes = hasOwn(input.value, 'nodes') ? input.value.nodes : undefined;
  const rawEdges = hasOwn(input.value, 'edges') ? input.value.edges : undefined;

  // 结构检查先行：schema 报错后不能继续把错误类型当列表用（Python 侧踩过这个 TypeError）。
  const structure: StructureError[] = [];
  if (!Array.isArray(rawNodes)) structure.push({ path: ['nodes'], message: 'nodes 必须是数组' });
  if (!Array.isArray(rawEdges)) structure.push({ path: ['edges'], message: 'edges 必须是数组' });

  const nodes = Array.isArray(rawNodes) ? rawNodes : [];
  const edges = Array.isArray(rawEdges) ? rawEdges : [];

  nodes.forEach((node, index) => {
    if (!isPlainObject(node)) {
      structure.push({ path: ['nodes', index], message: `nodes[${index}] 必须是对象` });
      return;
    }
    if (typeof node.id !== 'string' || node.id === '') {
      structure.push({ path: ['nodes', index, 'id'], message: `nodes[${index}] 缺字符串 id` });
      return;
    }
    const label = node.id;
    if (hasOwn(node, 'prerequisites') && (!Array.isArray(node.prerequisites) || !node.prerequisites.every((item) => typeof item === 'string'))) {
      structure.push({ path: ['nodes', index, 'prerequisites'], message: `${label}: prerequisites 必须是字符串数组` });
    }
    if (hasOwn(node, 'kind') && typeof node.kind !== 'string') {
      structure.push({ path: ['nodes', index, 'kind'], message: `${label}: kind 必须是字符串` });
    }
  });

  edges.forEach((edge, index) => {
    if (!isPlainObject(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      structure.push({ path: ['edges', index], message: `edges[${index}] 必须是含字符串 from / to 的对象` });
    }
  });

  for (const error of structure) {
    const hit = lookup(error.path);
    problems.push({ file: input.file, ...withColumn(hit.line, hit.column), message: error.message, blocking: true });
  }
  // 结构坏到读不出节点列表时，语义检查只会把同一件事重复说一遍。
  if (structure.length > 0) return summarize(input.file, problems);

  const indexed = nodes.map((node, index) => ({ node: node as JsonObject, index }));
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const { node, index } of indexed) {
    const id = node.id as string;
    if (seen.has(id)) {
      const hit = lookup(['nodes', index, 'id']);
      problems.push({
        file: input.file,
        ...withColumn(hit.line, hit.column),
        message: `重复 id: ${id}`,
        blocking: true,
      });
    }
    seen.add(id);
    if (!ids.includes(id)) ids.push(id);
  }

  const prerequisitesOf = (node: JsonObject): string[] =>
    Array.isArray(node.prerequisites) ? (node.prerequisites as string[]) : [];

  for (const { node, index } of indexed) {
    for (const [position, prerequisite] of prerequisitesOf(node).entries()) {
      if (!seen.has(prerequisite)) {
        const hit = lookup(['nodes', index, 'prerequisites', position]);
        problems.push({
          file: input.file,
          ...withColumn(hit.line, hit.column),
          message: `${node.id}: prerequisites 引用了不存在的节点 ${prerequisite}`,
          blocking: true,
        });
      }
    }
  }

  const edgeList = edges as JsonObject[];
  for (const [index, edge] of edgeList.entries()) {
    for (const key of ['from', 'to'] as const) {
      const target = edge[key] as string;
      if (!seen.has(target)) {
        const hit = lookup(['edges', index, key]);
        problems.push({
          file: input.file,
          ...withColumn(hit.line, hit.column),
          message: `edge ${String(edge.from)} -> ${String(edge.to)}: ${key} 指向不存在的节点 ${target}`,
          blocking: true,
        });
      }
    }
  }

  // 位次倒挂：nodes 的书写顺序就是教学位次（课件文件名 `<序号>-<节点id>.md` 的序号按它算），
  // 所以依赖只能指向前面的节点；指向后面 = 学生还没学就被要求用它。
  const rank = new Map<string, number>();
  ids.forEach((id, position) => rank.set(id, position));
  const inverted: { dependent: string; prerequisite: string }[] = [];
  const seenInverted = new Set<string>();
  const noteInversion = (dependent: string, prerequisite: string): void => {
    const key = `${dependent}\u0000${prerequisite}`;
    if (seenInverted.has(key)) return;
    seenInverted.add(key);
    inverted.push({ dependent, prerequisite });
  };
  for (const { node } of indexed) {
    const id = node.id as string;
    for (const prerequisite of prerequisitesOf(node)) {
      const dependent = rank.get(id);
      const dependency = rank.get(prerequisite);
      if (dependent !== undefined && dependency !== undefined && dependency > dependent) {
        noteInversion(id, prerequisite);
      }
    }
  }
  for (const edge of edgeList) {
    const from = rank.get(edge.from as string);
    const to = rank.get(edge.to as string);
    // 边 `from -> to` 的含义是「先学 from 再学 to」，所以 from 排到 to 后面就是倒挂。
    if (from !== undefined && to !== undefined && from > to) noteInversion(edge.to as string, edge.from as string);
  }
  for (const { dependent, prerequisite } of inverted) {
    const hit = lookup(['nodes', rank.get(dependent) as number, 'prerequisites']);
    const dependentRank = (rank.get(dependent) as number) + 1;
    const prerequisiteRank = (rank.get(prerequisite) as number) + 1;
    problems.push({
      file: input.file,
      ...withColumn(hit.line, hit.column),
      message: `${dependent}（第 ${dependentRank} 位）依赖 ${prerequisite}（第 ${prerequisiteRank} 位）——`
        + 'nodes 顺序即教学位次，依赖只能指向前面的节点',
      blocking: true,
    });
  }

  // 实验课必须有非空 prerequisites：它验收的就是「学到目前的知识能做出什么」，没写验收哪些课
  // 就无从判。
  for (const { node, index } of indexed) {
    if (node.kind === '实验' && prerequisitesOf(node).length === 0) {
      const hit = lookup(['nodes', index, 'prerequisites']);
      problems.push({
        file: input.file,
        ...withColumn(hit.line, hit.column),
        message: `${String(node.id)}: 实验课必须有 prerequisites（列出验收哪些节点）`,
        blocking: true,
      });
    }
  }

  // 环检测（Kahn 拓扑排序）：prerequisites 与 edges 合成一张有向图，DAG 是硬要求。
  // 排序不掉的节点就是环上的节点——比手写 DFS 的颜色标记稳，也没有递归深度问题。
  const graph = new Map<string, Set<string>>();
  for (const id of ids) graph.set(id, new Set());
  for (const { node } of indexed) {
    const id = node.id as string;
    for (const prerequisite of prerequisitesOf(node)) {
      if (graph.has(prerequisite)) (graph.get(prerequisite) as Set<string>).add(id);
    }
  }
  for (const edge of edgeList) {
    const from = edge.from as string;
    const to = edge.to as string;
    if (graph.has(from) && graph.has(to)) (graph.get(from) as Set<string>).add(to);
  }
  const indegree = new Map<string, number>();
  for (const id of ids) indegree.set(id, 0);
  for (const targets of graph.values()) {
    for (const target of targets) indegree.set(target, (indegree.get(target) as number) + 1);
  }
  const ready = ids.filter((id) => indegree.get(id) === 0);
  let settled = 0;
  while (ready.length > 0) {
    const id = ready.pop() as string;
    settled++;
    for (const target of graph.get(id) as Set<string>) {
      const next = (indegree.get(target) as number) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (settled < ids.length) {
    const stuck = ids.filter((id) => (indegree.get(id) as number) > 0);
    problems.push({
      file: input.file,
      ...place(lookup, ['nodes']),
      message: `存在环：${stuck.length} 个节点排不出拓扑序（${stuck.slice(0, 6).join(', ')}${stuck.length > 6 ? '…' : ''}）`,
      blocking: true,
    });
  }

  // 孤儿只是提示：末端节点本来就没人依赖它。
  const referenced = new Set<string>();
  for (const { node } of indexed) for (const prerequisite of prerequisitesOf(node)) referenced.add(prerequisite);
  for (const edge of edgeList) referenced.add(edge.from as string);
  const orphans = ids.filter((id) => !referenced.has(id));
  if (orphans.length > 0) {
    problems.push({
      file: input.file,
      ...place(lookup, ['nodes']),
      message: `没有被任何节点依赖的末端节点：${orphans.slice(0, 8).join('、')}${orphans.length > 8 ? '…' : ''}（提示，不阻断）`,
      blocking: false,
    });
  }

  return summarize(input.file, problems);
}

/* ══════════════════════════════════════════════════════════════════════
   二、进度校验（schema 与取值）
   ══════════════════════════════════════════════════════════════════════ */

/*
 * 旧六档 → 三档（目标态规格 §5.2）的**唯一实现**在 `lib/core/rules.ts`：这里 import 它，
 * 不再抄第二份映射表——曾经两份并存，改一次词表要动两处，漂了也没有测试拦得住。
 * 域边方向是 lib → core，没问题（`decisions.md` §2）。
 */

/**
 * schema 里的 `status` 枚举**就地展开**成「三档 + 旧六档」。
 *
 * 为什么不在 `progress.schema.json` 的 enum 里直接写上九个值：那份 schema 是**写侧**的合同，
 * 它说「新写的必须是这三档」；旧值只在读侧被容忍，写侧不该在词表里给它们留位置。
 * 展开只加枚举项、不动其它关键字，所以可以放心就地改这一条路径。
 */
function expandStatusEnum(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return schema;
  const root = schema as Record<string, unknown>;
  const nodes = root.properties as Record<string, unknown> | undefined;
  const nodeEntry = nodes?.nodes as Record<string, unknown> | undefined;
  const extra = nodeEntry?.additionalProperties as Record<string, unknown> | undefined;
  const props = extra?.properties as Record<string, unknown> | undefined;
  const status = props?.status as Record<string, unknown> | undefined;
  if (status === undefined || !Array.isArray(status.enum)) return schema;
  const values = new Set<unknown>([...status.enum, ...LEGACY_TIERS]);
  return {
    ...root,
    properties: {
      ...nodes,
      nodes: {
        ...nodeEntry,
        additionalProperties: {
          ...extra,
          properties: { ...props, status: { ...status, enum: [...values] } },
        },
      },
    },
  };
}

export interface ProgressInput extends YamlDocumentInput {
  /**
   * 大纲里的节点 id（调用方从同一科目的 curriculum 取来传进来）。
   * 给了才做「引用完整性」：进度里出现不存在的节点 id、或大纲节点在进度里缺席。
   * 刻意做成可选——单独校验一份 progress.yaml 时不强求另一份文件在场。
   */
  knownNodeIds?: readonly string[];
}

export function validateProgress(input: ProgressInput): ValidationReport {
  const problems: StudyProblem[] = [];
  const lookup = yamlLookup(input.text);
  // 旧六档是**读得进**的：先把 schema 的 enum 展开，再拿展开后的那份校验，
  // 于是旧文件不会报「不在允许值」，而真正的野词（连旧词表都不是）照样被拦下。
  pushSchemaProblems(problems, input.file, lookup, expandStatusEnum(input.schema), input.value);

  if (!isPlainObject(input.value)) {
    problems.push({ file: input.file, line: 1, message: '顶层不是 mapping：进度必须是含 updated_at / nodes / project 的对象', blocking: true });
    return summarize(input.file, problems);
  }

  if (typeof input.value.updated_at === 'string' && hasOuterWhitespace(input.value.updated_at)) {
    problems.push({
      file: input.file,
      ...place(lookup, ['updated_at']),
      message: 'updated_at 两端有空白：日期时间写成了带空白的字符串，比较时会不等',
      blocking: false,
    });
  }

  // 旧字段的迁移提示（**不阻断**）：字段名变了、落点搬了，学生与维护者看到的却是结果——
  // 不说一声，下一次写盘时旧字段静默消失，没人知道为什么。
  if (hasOwn(input.value, 'misconceptions')) {
    problems.push({
      file: input.file,
      ...place(lookup, ['misconceptions']),
      message: 'progress.yaml 里的 misconceptions 是旧的双落点：误解记录现在只落在 misconceptions.yaml'
        + '（目标态规格 §5.4），这份副本读得进但不再被读，写回时删掉它',
      blocking: false,
    });
  }

  const rawNodes = hasOwn(input.value, 'nodes') ? input.value.nodes : undefined;
  if (isPlainObject(rawNodes)) {
    const keys = Object.keys(rawNodes);
    if (keys.length === 0) {
      problems.push({
        file: input.file,
        ...place(lookup, ['nodes']),
        message: 'nodes 是空的：这份进度里没有任何节点状态（提示，不阻断）',
        blocking: false,
      });
    }
    for (const key of keys) {
      const entry = rawNodes[key];
      if (!isPlainObject(entry)) continue;
      const status = entry.status;
      if (typeof status === 'string') {
        // 新词表就是三档；旧词表读到就映射，但要说出来——否则「写回时状态会变」这件事
        // 只会发生在下一次保存时，没人知道为什么。
        const tier = LEGACY_TIER_MAP.get(status);
        if (tier !== undefined && tier !== status) {
          problems.push({
            file: input.file,
            ...place(lookup, ['nodes', key, 'status']),
            message: `节点 ${key} 的状态「${status}」属旧六档词表，写回时映射为「${tier}」（规格 §5.2）`,
            blocking: false,
          });
        }
        if (!isTier(status) && tier === undefined) {
          // schema 的 enum 已经会报一次；这里只补一句「它连旧词表也不是」，说明为什么会被
          // 静默当成「未开始」。
          problems.push({
            file: input.file,
            ...place(lookup, ['nodes', key, 'status']),
            message: `节点 ${key} 的状态「${status}」不在任何一版词表里：读侧会保守地当成「未开始」`,
            blocking: false,
          });
        }
      }
      // mastery 已从词表里删掉（目标态规格 §5.2）：读到就说一声，别让它静默留着
      if (hasOwn(entry, 'mastery')) {
        problems.push({
          file: input.file,
          ...place(lookup, ['nodes', key, 'mastery']),
          message: `节点 ${key} 还带着 mastery：掌握度字段已取消（规格 §5.2），读得进、写回时删掉它`,
          blocking: false,
        });
      }
    }

    if (input.knownNodeIds) {
      const known = new Set(input.knownNodeIds);
      for (const key of keys) {
        if (!known.has(key)) {
          problems.push({
            file: input.file,
            ...place(lookup, ['nodes', key]),
            message: `进度里出现大纲没有的节点 ${key}：这条状态不会被任何一节课读到`,
            blocking: true,
          });
        }
      }
      const absent = input.knownNodeIds.filter((id) => !hasOwn(rawNodes, id));
      if (absent.length > 0) {
        problems.push({
          file: input.file,
          ...place(lookup, ['nodes']),
          message: `大纲里有、进度里没有的节点：${absent.slice(0, 8).join('、')}${absent.length > 8 ? '…' : ''}（提示，不阻断）`,
          blocking: false,
        });
      }
    }
  }

  return summarize(input.file, problems);
}

/* ══════════════════════════════════════════════════════════════════════
   三、科目校验（schema 与取值）
   ══════════════════════════════════════════════════════════════════════ */

export interface SubjectInput extends YamlDocumentInput {
  /** 科目目录名。给了才比 `slug`——目标态里目录名是权威，slug 只是档案副本。 */
  expectedSlug?: string;
}

export function validateSubject(input: SubjectInput): ValidationReport {
  const problems: StudyProblem[] = [];
  const lookup = yamlLookup(input.text);
  pushSchemaProblems(problems, input.file, lookup, input.schema, input.value);

  if (!isPlainObject(input.value)) {
    problems.push({ file: input.file, line: 1, message: '顶层不是 mapping：科目档案必须是含 name / slug / goal / created_at / status 的对象', blocking: true });
    return summarize(input.file, problems);
  }

  const value = input.value;
  // schema 里 name / goal 只有 `type: string`：空串是合法 JSON，但一个没有名字的科目
  // 在阅读端只能显示成一个空白标题。schema 表达不了的取值，就在这里补。
  for (const field of ['name', 'goal'] as const) {
    if (typeof value[field] === 'string' && value[field].trim() === '') {
      problems.push({
        file: input.file,
        ...place(lookup, [field]),
        message: `${field} 是空串：科目档案必须有非空的 ${field}`,
        blocking: true,
      });
    }
  }

  for (const field of ['name', 'slug', 'goal'] as const) {
    if (typeof value[field] === 'string' && value[field] !== '' && hasOuterWhitespace(value[field])) {
      problems.push({
        file: input.file,
        ...place(lookup, [field]),
        message: `${field} 两端有空白：目录名与 slug 的比较、搜索去重都会因此对不上`,
        blocking: false,
      });
    }
  }

  if (input.expectedSlug !== undefined && typeof value.slug === 'string' && value.slug !== input.expectedSlug) {
    problems.push({
      file: input.file,
      ...place(lookup, ['slug']),
      message: `slug「${value.slug}」与科目目录名「${input.expectedSlug}」不一致：目录名是权威，档案里的 slug 只是副本（提示，不阻断）`,
      blocking: false,
    });
  }

  return summarize(input.file, problems);
}

/* ══════════════════════════════════════════════════════════════════════
   四、资源清单的覆盖率（「够了」的判据）
   ══════════════════════════════════════════════════════════════════════ */

export interface ResourcesInput {
  /** 调用方注入的展示路径，进 `StudyProblem.file`。 */
  file: string;
  /** 「资源清单」的正文。 */
  markdown: string;
  /** 大纲里的节点 id（顺序照大纲）。 */
  nodeIds: readonly string[];
}

/** 清单条数的上限倍数：超过「节点数 × 这个数」就是膨胀（实测五门科目是节点数的 2.8–7.1 倍）。 */
export const RESOURCE_ENTRY_LIMIT = 2;

/**
 * 「够了」的机器判据：**每个节点至少一处来源**（不少）、**条数不超过节点数 × 2**（不膨胀）。
 *
 * 判据全落在**提示**（`blocking: false`）上，不阻断——「服务 <节点 id>」这个标记是这一批
 * 新加的写法，现存清单一条都没有；判成阻断等于升级即整片变红（与图片完整性那一条同一个
 * 口径）。总控看这几条提示决定要不要派「资料收集」补收集。
 *
 * 站点分布**不在这里**报：它在交接门禁的 `sections[].hosts` 里（只报不卡，见 #129）。
 */
export function validateResources(input: ResourcesInput): ValidationReport {
  const problems: StudyProblem[] = [];
  const entries = resourceEntries(input.markdown).filter((entry) => isSourceSection(entry.heading));
  const known = new Set(input.nodeIds);
  const served = new Set<string>();
  const unknown = new Set<string>();
  let unmarked = 0;

  for (const entry of entries) {
    if (entry.nodes.length === 0) {
      unmarked += 1;
      continue;
    }
    for (const node of entry.nodes) {
      if (known.has(node)) {
        served.add(node);
      } else if (!unknown.has(node)) {
        unknown.add(node);
        problems.push({
          file: input.file,
          line: entry.line,
          message: `「服务」里写了不存在的节点 id: ${node}（节点 id 照「课程大纲」，别自己造）`,
          blocking: false,
        });
      }
    }
  }

  const missing = input.nodeIds.filter((id) => !served.has(id));
  if (missing.length > 0) {
    problems.push({
      file: input.file,
      line: 1,
      message: `还有 ${missing.length} 个节点指不出一处来源（共 ${input.nodeIds.length} 个节点）：${missing.join('、')}`,
      blocking: false,
    });
    for (const node of missing) {
      problems.push({
        file: input.file,
        line: 1,
        message: `节点 ${node} 指不出一处来源：清单里没有任何一条声明「服务 ${node}」`,
        blocking: false,
      });
    }
  }

  // 没有节点就没什么可比（那种大纲本身已经被别处报过了），不在这里编一条除零的结论。
  const nodes = input.nodeIds.length;
  const limit = nodes * RESOURCE_ENTRY_LIMIT;
  if (nodes > 0 && entries.length > limit) {
    // 倍数也要报出来（#128 的实现决定：「如实报出条数、节点数与倍数」）。
    const times = Math.round((entries.length / nodes) * 10) / 10;
    problems.push({
      file: input.file,
      line: 1,
      message: `清单条目 ${entries.length} 条 > 节点数 ${nodes} × ${RESOURCE_ENTRY_LIMIT} = ${limit}`
        + `（${times} 倍）：清单在膨胀——每条来源都该服务到节点，别拿条目充长度`,
      blocking: false,
    });
  }

  if (unmarked > 0) {
    problems.push({
      file: input.file,
      line: 1,
      message: `${unmarked} 条来源条目没写「服务 <节点 id>」（条目行末加 \`· 服务 node.id\`，多条用「、」分隔）：`
        + '它们不参与覆盖率',
      blocking: false,
    });
  }

  return summarize(input.file, problems);
}

/* ══════════════════════════════════════════════════════════════════════
   五、交接门禁（Agent 交接协议 + deliver/ 盘上快照）
   ══════════════════════════════════════════════════════════════════════ */

/** `deliver/` 与 `handoff.json` 的盘上快照。由调用方走盘得到——这一层不碰文件系统。 */
export interface StageEntry {
  /** 相对 stage 根，一律 `/` 分隔。 */
  path: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  /** `kind: file` 时调用方算好的 SHA-256（十六进制小写）。给了就复算比对。 */
  sha256?: string;
  /** `kind: symlink` 时的链接目标，只用于展示。 */
  target?: string;
}

/** 一节资源的规模与指纹（`RESOURCES.md` 的一节）。
 *
 *  由调用方算好递进来，因为算指纹要 `node:crypto`（纯函数域不许碰），而分节与「指纹的
 *  输入文本」在 `lib/core/resources.ts` 里定义一次、核验域与这里共用同一份。 */
export interface HandoffSection {
  /** `## ` 之后的标题正文。 */
  heading: string;
  /** 这一节的条目数。 */
  entries: number;
  /** 按域名的分布（只报不卡）。 */
  hosts: { host: string; entries: number }[];
  /** 这一节内容（含标题行）的 SHA-256，十六进制小写。 */
  sha256: string;
  /** 这一份指纹在核验台账里有没有记录。 */
  verified: boolean;
}

export interface HandoffInput {
  stagePath: string;
  manifestText: string;
  entries: readonly StageEntry[];
  expectedRole: string;
  /** 不传 = 科目级任务，此时 manifest 的 `node_id` 必须是 `null`。 */
  expectedNode?: string | null;
  schema: unknown;
  /** `deliver/RESOURCES.md` 的分节摘要；不是资源清单的交接就不传（= 空列表）。 */
  sections?: readonly HandoffSection[];
}

export interface HandoffVerdict {
  stagePath: string;
  /** **明确结论**：`pass` = 可以合盘，`block` = 不复制、不删 stage、不把任务说成完成。 */
  verdict: 'pass' | 'block';
  blocking: boolean;
  problems: StudyProblem[];
  summary: string;
  role: string | null;
  outputs: number;
  /** 逐节的规模、出处与指纹；总控看这份摘要就不必把清单读进上下文。 */
  sections: HandoffSection[];
}

const DRIVE_RE = /^[A-Za-z]:/;
const HANDOFF = 'handoff.json';
const DELIVER = 'deliver';

function trimTrailingSlash(text: string): string {
  return text.replace(/\/+$/, '');
}

/** `outputs[].path` 的安全判据，逐条对齐迁移前的 Python 交接校验器的 `safe_relative`。 */
function safeRelative(value: string): string | null {
  if (value.includes('\\')) return 'output.path 必须用 /，不能含反斜杠';
  if (value.startsWith('/') || DRIVE_RE.test(value)) return 'output.path 必须是 deliver/ 下的相对路径（不能是绝对路径或 Windows 盘符路径）';
  const parts = value.split('/');
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    return 'output.path 不能含空段、. 或 ..';
  }
  return null;
}

export function validateHandoff(input: HandoffInput): HandoffVerdict {
  const stage = trimTrailingSlash(input.stagePath);
  const manifestFile = `${stage}/${HANDOFF}`;
  const problems: StudyProblem[] = [];
  const byPath = new Map<string, StageEntry>();
  for (const entry of input.entries) byPath.set(entry.path, entry);

  const sections = input.sections ?? [];
  const block = (file: string, line: number, message: string, column?: number): void => {
    problems.push({ file, ...withColumn(line, column), message, blocking: true });
  };

  // stage 级：manifest 与 deliver/ 必须都在，且都不能是符号链接（协议第 52 行）。
  const manifestEntry = byPath.get(HANDOFF);
  if (!manifestEntry) block(manifestFile, 1, `stage 根缺 ${HANDOFF}`);
  else if (manifestEntry.kind === 'symlink') block(manifestFile, 1, `${HANDOFF} 不能是符号链接${manifestEntry.target ? `（指向 ${manifestEntry.target}）` : ''}`);
  else if (manifestEntry.kind !== 'file') block(manifestFile, 1, `${HANDOFF} 必须是普通文件`);

  const deliverEntry = byPath.get(DELIVER);
  if (!deliverEntry) block(`${stage}/${DELIVER}`, 1, `stage 根缺 ${DELIVER}/`);
  else if (deliverEntry.kind === 'symlink') block(`${stage}/${DELIVER}`, 1, `${DELIVER}/ 不能是符号链接${deliverEntry.target ? `（指向 ${deliverEntry.target}）` : ''}`);
  else if (deliverEntry.kind !== 'dir') block(`${stage}/${DELIVER}`, 1, `${DELIVER} 必须是目录`);

  const manifestReadable = manifestEntry !== undefined && manifestEntry.kind === 'file';
  if (!manifestReadable) {
    return finishHandoff(stage, problems, null, 0, sections);
  }

  let positions: ReturnType<typeof indexJson> | null = null;
  try {
    positions = indexJson(input.manifestText);
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      block(manifestFile, error.line, `${HANDOFF} 不是合法 JSON：${error.message}`, error.column);
      return finishHandoff(stage, problems, null, 0, sections);
    }
    throw error;
  }

  // 重复键：Python 侧用 object_pairs_hook 拒掉，JSON.parse 只会静默取最后一个。
  for (const duplicate of positions.duplicates) {
    block(manifestFile, duplicate.line, `重复 JSON key: ${duplicate.key}`, duplicate.column);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(input.manifestText);
  } catch (error) {
    block(manifestFile, 1, `${HANDOFF} 不是合法 JSON：${(error as Error).message}`);
    return finishHandoff(stage, problems, null, 0, sections);
  }

  const lookup: Lookup = (path) => positions.at(path);
  pushSchemaProblems(problems, manifestFile, lookup, input.schema, manifest);

  if (!isPlainObject(manifest)) {
    block(manifestFile, 1, `${HANDOFF} 顶层必须是对象`);
    return finishHandoff(stage, problems, null, 0, sections);
  }

  // schema 已经把类型报过一遍了；这里只在类型可用时才做语义判断，避免连环报错。
  const role = typeof manifest.role === 'string' ? manifest.role : null;
  const outputs = Array.isArray(manifest.outputs) ? manifest.outputs : [];

  // 角色 / 节点绑定：自然语言回复不能覆盖 manifest（协议第 45 行）。
  if (role !== null && role !== input.expectedRole) {
    const hit = lookup(['role']);
    block(manifestFile, hit.line, `角色错配：manifest=${role}，expected=${input.expectedRole}`, hit.column);
  }
  const nodeId = hasOwn(manifest, 'node_id') ? manifest.node_id : undefined;
  if (nodeId !== undefined) {
    const hit = lookup(['node_id']);
    if (input.expectedNode === undefined || input.expectedNode === null) {
      if (nodeId !== null) {
        block(manifestFile, hit.line, `科目级任务 node_id 必须是 null，实际为 ${JSON.stringify(nodeId)}`, hit.column);
      }
    } else if (nodeId !== input.expectedNode) {
      block(manifestFile, hit.line, `节点错配：manifest=${JSON.stringify(nodeId)}，expected=${JSON.stringify(input.expectedNode)}`, hit.column);
    }
  }

  // 状态语义（协议「状态语义」一节）。
  const status = manifest.status;
  if (status === 'succeeded') {
    if (outputs.length === 0) {
      const hit = lookup(['outputs']);
      block(manifestFile, hit.line, 'succeeded 必须声明至少一个 output', hit.column);
    }
    const checks = Array.isArray(manifest.checks) ? manifest.checks : [];
    const bad = checks
      .filter((item): item is JsonObject => isPlainObject(item) && item.status !== undefined && item.status !== 'passed')
      .map((item) => String(item.name));
    if (bad.length > 0) {
      const hit = lookup(['checks']);
      block(manifestFile, hit.line, `succeeded 不能包含 failed / not_run 的 check：${bad.join('、')}`, hit.column);
    }
  } else if (status === 'blocked') {
    const gaps = Array.isArray(manifest.gaps) ? manifest.gaps : [];
    if (gaps.length === 0) {
      const hit = lookup(['gaps']);
      block(manifestFile, hit.line, 'blocked 必须在 gaps 里写明阻塞原因', hit.column);
    }
  }

  // outputs 逐条：路径边界 → 盘上存在 → 类型与 sha256。
  const declaredFiles = new Set<string>();
  const declaredRoots: string[] = [];
  const declared = new Set<string>();
  outputs.forEach((output, index) => {
    if (!isPlainObject(output) || typeof output.path !== 'string') return; // schema 已报
    const relative = output.path;
    const complaint = safeRelative(relative);
    if (complaint !== null) {
      const hit = lookup(['outputs', index, 'path']);
      block(manifestFile, hit.line, `${complaint}：${relative}`, hit.column);
      return;
    }
    if (declared.has(relative)) {
      const hit = lookup(['outputs', index, 'path']);
      block(manifestFile, hit.line, `outputs 重复声明路径: ${relative}`, hit.column);
      return;
    }
    declared.add(relative);

    const target = `${DELIVER}/${relative}`;
    const entry = byPath.get(target);
    const hit = lookup(['outputs', index, 'path']);
    if (!entry) {
      block(manifestFile, hit.line, `output 在盘上不存在: ${target}`, hit.column);
      return;
    }
    if (entry.kind === 'symlink') {
      block(manifestFile, hit.line, `output 不能是符号链接: ${target}${entry.target ? `（指向 ${entry.target}）` : ''}`, hit.column);
      return;
    }

    if (output.kind === 'file') {
      if (entry.kind !== 'file') {
        block(manifestFile, hit.line, `kind=file 但盘上不是普通文件: ${target}`, hit.column);
        return;
      }
      declaredFiles.add(relative);
      if (typeof output.sha256 === 'string' && entry.sha256 !== undefined && entry.sha256 !== output.sha256) {
        block(manifestFile, hit.line, `sha256 不匹配: ${relative}（盘上 ${entry.sha256}）`, hit.column);
      }
    } else if (output.kind === 'tree') {
      if (hasOwn(output, 'sha256')) {
        block(manifestFile, hit.line, `sha256 仅支持 kind=file: ${relative}`, hit.column);
      }
      if (entry.kind !== 'dir') {
        block(manifestFile, hit.line, `kind=tree 但盘上不是目录: ${target}`, hit.column);
        return;
      }
      const prefix = `${target}/`;
      const inside = input.entries.filter((item) => item.path.startsWith(prefix) && item.kind === 'file');
      if (inside.length === 0) {
        block(manifestFile, hit.line, `kind=tree 不能声明空目录: ${relative}`, hit.column);
        return;
      }
      declaredRoots.push(prefix);
    }
  });

  // deliver/ 覆盖：多出来的「顺手文件」会阻断合盘（协议第 51 行）。
  const actualFiles = input.entries
    .filter((entry) => entry.kind === 'file' && entry.path.startsWith(`${DELIVER}/`))
    .map((entry) => entry.path);
  const undeclared = actualFiles.filter((path) =>
    !declaredFiles.has(path.slice(DELIVER.length + 1)) && !declaredRoots.some((root) => path.startsWith(root)));
  if (undeclared.length > 0) {
    const shown = undeclared.slice(0, 8).map((path) => path.slice(DELIVER.length + 1));
    block(
      `${stage}/${DELIVER}`,
      1,
      `deliver/ 有未声明产物：${shown.join('、')}${undeclared.length > 8 ? '…' : ''}`,
    );
  }

  // deliver/ 里不能有符号链接、目录联接，也不能有既不是普通文件也不是目录的东西。
  for (const entry of input.entries) {
    if (!entry.path.startsWith(`${DELIVER}/`)) continue;
    const display = `${stage}/${entry.path}`;
    if (entry.kind === 'symlink') {
      block(display, 1, `deliver 里不能有符号链接或目录联接${entry.target ? `（指向 ${entry.target}）` : ''}`);
    } else if (entry.kind === 'other') {
      block(display, 1, 'deliver 里只允许普通文件与目录');
    }
  }

  return finishHandoff(stage, problems, role, outputs.length, sections);
}

function finishHandoff(
  stage: string,
  problems: StudyProblem[],
  role: string | null,
  outputs: number,
  sections: readonly HandoffSection[],
): HandoffVerdict {
  const blocking = problems.some((problem) => problem.blocking);
  const blockingCount = problems.filter((problem) => problem.blocking).length;
  const summary = blocking
    ? `阻断：${stage} 的交接边界不合法——${blockingCount} 条阻断问题（共 ${problems.length} 条）。不复制、不删 stage、不把任务说成完成。`
    : `放行：${stage} 的交接边界合法（${role ?? '角色未知'}，${outputs} 个 output`
      + `${sections.length === 0 ? '' : `；资源清单 ${sections.length} 节：${describeSections(sections)}`}）。`
      + '这只说明边界合法，领域校验仍要各跑各的。';
  return {
    stagePath: stage,
    verdict: blocking ? 'block' : 'pass',
    blocking,
    problems,
    summary,
    role,
    outputs,
    sections: [...sections],
  };
}

/** 摘要里那半句：`延伸阅读 42 条（已核）· 缺口 3 条（未核）`。 */
function describeSections(sections: readonly HandoffSection[]): string {
  return sections
    .map((section) => `${section.heading === '' ? '(无标题)' : section.heading} ${section.entries} 条`
      + `（${section.verified ? '已核' : '未核'}）`)
    .join(' · ');
}
