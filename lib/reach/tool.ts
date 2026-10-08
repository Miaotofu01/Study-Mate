/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 核验域 —— 原生工具 `studymate_verify_sources`（issue #125）

   一句话：把「资源清单」里的每条链接探一遍，如实报出哪些打得开、哪些打不开。

   这个文件是那一趟的全部编排，四件事按顺序做完：

     1. **定位清单**：`RESOURCES.md` 本身、含它的科目目录，或暂存目录里的
        `deliver/RESOURCES.md`。定位不到就返回一份「没找到」的报告，**绝不抛**——
        总控在角色刚交回清单时调用它，路径写错是常事，不该把会话炸掉。
     2. **核只补增量**：缓存按 URL 记账（`cache.ts`），7 天内打得开的、6 小时内打不开的
        都当新鲜，直接跳过；`refresh` 才重核。第一遍白跑这件事就是被这一层消掉的。
     3. **先定路由表再批量**：拿第一条待核的链接探一次直连；连接层失败且有代理就再试一次
        代理，试通了就把表换成代理、**这条的结果直接复用**（不再探第二遍）。剩下的交给
        `schedule.ts`（并发 8、同站串行 1、墙上预算到点不再起新的）。
     4. **如实报**：`failures` 只列**这一轮真探过且打不开**的（缓存里的旧结论不算数），
        `hosts` 按 hostname 从**全部**条目汇总。`next` 说下一步：还有没探完的就叫它用同一个
        manifest 再调一次；都探完了还有打不开的就叫它去换来源。

   为什么 `lib/reach` **不 import `lib/tools/**`**：域图上只有「工具域 → 核验域」一条边
   （`lib/tools/index.ts` 调 `registerReachTools` 时把 `registerStudyTool` 当参数递进来，
   与任务域、实验域同一个姿势）。反过来 import 会成环，架构边界测试（#69）按域查环、默认拒绝。
   所以 `ReachToolSpec` 是按 `lib/tasks/tools.ts` 那套手抄的一份结构对齐——那条边是
   `lib/reach/index.ts` 的文件头在守。

   为什么调用方**不传 URL 列表**：清单实测有 118 条（terminal-workflow，2026-10-07），
   让调用方把 118 条抄进参数既费上下文、又会与盘上那一份悄悄不一致。清单是唯一出处。

   为什么**永不抛**：核验的每一步都可能是「没有」——没这个文件、没这条缓存、连接不上、
   超时、证书过不了。那些都是**结果**，不是异常。工具的输出契约里没有「异常」这一支。
   ───────────────────────────────────────────────────────────────────────── */

import path from 'node:path';

import { cmpCodePoints } from '../core/format.ts';
import type { DomainAccess } from '../host/access.ts';
import type { Domain } from '../host/domains.ts';
import { cacheFile, isFresh, loadCache, markVerified, saveCache } from './cache.ts';
import type { CacheEntry } from './cache.ts';
import { extractLinks } from './manifest.ts';
import type { ManifestEntry } from './manifest.ts';
import { runProbes } from './schedule.ts';
import type { ProbeFn, ProbeOutcome } from './schedule.ts';
import { fingerprintSections, hostOf, sectionLine } from './sections.ts';
import type { SectionFingerprint } from './sections.ts';
import { proxyFromEnv, requestOnce } from './transport.ts';
import type { RequestResult, RouteName } from './transport.ts';

/* ── 一次核验里用到的几个数（都给测试留一个可读的出口）──────────────────── */

/** 墙上预算默认值：两分钟。一次工具调用等两分钟已经够长，再长就该交回去让模型接着调。 */
export const DEFAULT_WALL_BUDGET_MS = 120_000;

/** 墙上预算的硬上限：十分钟。比这更长就不是「核一遍清单」而是「挂着不放了」。 */
export const MAX_WALL_BUDGET_MS = 600_000;

/** 单条请求的超时：8 秒。站点没回应就是没回应，不值得让整轮核验卡在它身上。 */
export const PROBE_TIMEOUT_MS = 8_000;

/** 同时最多几条在飞。 */
export const REACH_CONCURRENCY = 8;

/** 同一个 hostname 同时最多几条——礼貌，不是性能取舍（见 schedule.ts 文件头）。 */
export const REACH_PER_HOST = 1;

/**
 * 生效的墙上预算。**只给测试开一个缝**（`STUDYMATE_REACH_WALL_BUDGET_MS`）：
 * 预算那条用例要验的是「到点之后交回去、下一次接着做」，真等两分钟没人愿意跑门禁。
 * 与 `lib/lab/tools.ts` 的 `inlineWaitMs()` 同一个姿势：生产路径不设它就取默认值，
 * 写了非法值也退回默认——**不猜**。
 */
export function reachWallBudgetMs(): number {
  const raw = process.env.STUDYMATE_REACH_WALL_BUDGET_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_WALL_BUDGET_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_WALL_BUDGET_MS) return DEFAULT_WALL_BUDGET_MS;
  return value;
}

/* ── 工具域 `define.ts` 需要的形状（结构化对齐，不 import：见文件头）────── */

/** 工具域 `define.ts` 的上下文（注册点注入，`lib/reach/index.ts` 用它）。 */
export interface ReachToolContext {
  tools?: { register?: (definition: unknown) => unknown };
  effect?: (fn: () => unknown, description?: string) => unknown;
}

/** body 拿到的执行上下文：只要 `access` 与 `signal`（与 `define.ts` 的 `StudyRun` 对齐）。 */
export interface ReachRun {
  access: DomainAccess;
  signal?: AbortSignal | undefined;
}

/** 与工具域 `StudyToolSpec` 同形的一份（见文件头：不 import 工具域，避免成环）。
 *
 *  `reads` 用 `Domain` 联合而不是 `string`：注册点注入的 `registerStudyTool` 收的是
 *  `StudyToolSpec`，两边要**互相可赋值**（工具域那份的 `reads` 就是 `readonly Domain[]`）；
 *  写成 `readonly string[]` 会让 `registerReachTools(ctx, { registerStudyTool })` 这一句
 *  在 tsc 下报「参数不可赋值」，而靠一句 `as` 咽下去就等于把两边的对账拆了。 */
export interface ReachToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: any, value: any) => { type: 'text'; text: string }[];
  };
  reads?: readonly Domain[];
  writes?: Readonly<Partial<Record<Domain, readonly string[]>>>;
  execute: (args: any, run: any) => Promise<unknown>;
}

/** 注册点注入的造工具能力。 */
export interface ReachToolRegistry {
  registerStudyTool: (ctx: ReachToolContext, spec: ReachToolSpec) => void;
}

/* ── 契约：参数、输出、域声明 ──────────────────────────────────────────── */

const TEXT = { type: 'string' } as const;
const INTEGER = { type: 'integer' } as const;

export const REACH_READS: readonly Domain[] = ['workspace', 'resources'];
export const REACH_WRITES: Readonly<Partial<Record<Domain, readonly string[]>>> = {};

export const REACH_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['manifest'],
  properties: {
    manifest: {
      type: 'string',
      description: '「资源清单」的路径：RESOURCES.md 本身、含它的科目目录，或暂存目录里的 deliver/RESOURCES.md（相对工作区根或绝对路径）。',
    },
    offline: { type: 'boolean', description: '只用缓存、不发请求（默认 false）。' },
    refresh: { type: 'boolean', description: '忽略缓存重核（默认 false）。' },
  },
} as const;

const HOST_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['host', 'entries', 'ok', 'failed'],
  properties: { host: TEXT, entries: INTEGER, ok: INTEGER, failed: INTEGER },
} as const;

const FAILURE_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['line', 'url', 'status', 'note'],
  properties: { line: INTEGER, url: TEXT, status: INTEGER, note: TEXT },
} as const;

/**
 * 一节资源的花名册：标题、条目数、内容指纹、这一节核过没有。
 *
 * `verified` 的判据是**这一节里至少有一条链接、且每条都有结论**（这一轮探到的或缓存里新鲜的），
 * 而不是「整份清单都核完了」——这正是「按节冻结」要的那一格：主干核完就能被下游取用。
 * 一条链接都没有的小节（例如只有 `[Local: …]` 指针或整节都是缺口）**不算核过**：核验工具核的是
 * 链接，那种小节没有可核的东西，就不该记一份「核过」——`verified` 的语义是「台账里有这一份指纹
 * 的记录」，空真会让门禁对一份没核过的内容说「已核」。
 * 一份指纹的核过记录落在插件私有台账（`<DSH_HOME>/studymate/reach/verified.json`），
 * 交接门禁拿同一份指纹去问它，于是「改了一节只有那一节要重核」。
 */
const SECTION_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['heading', 'entries', 'sha256', 'verified'],
  properties: { heading: TEXT, entries: INTEGER, sha256: TEXT, verified: { type: 'boolean' } },
} as const;

/**
 * 输出契约。**刻意短**：一行一条的明细不进返回值（宿主对工具结果有 8192 字符的截断，
 * 118 条明细会被悄悄切掉一半，读起来像是「只核了前 60 条」）。要明细自己去读缓存。
 */
export const REACH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['manifest', 'total', 'ok', 'failed', 'cached', 'probed', 'pending',
    'route', 'hosts', 'sections', 'failures', 'summary', 'next'],
  properties: {
    manifest: TEXT,
    total: INTEGER,
    ok: INTEGER,
    failed: INTEGER,
    cached: INTEGER,
    probed: INTEGER,
    pending: INTEGER,
    route: { type: 'string', enum: ['直连', '代理', '未探'] },
    hosts: { type: 'array', items: HOST_ROW_SCHEMA },
    sections: { type: 'array', items: SECTION_ROW_SCHEMA },
    failures: { type: 'array', items: FAILURE_ROW_SCHEMA },
    summary: TEXT,
    next: TEXT,
    // 台账落点（选填）：报告里说清结论存在哪，免得有人去学习数据目录里找它。
    cache: TEXT,
  },
} as const;

/* ── 报告形状 ──────────────────────────────────────────────────────────── */

export interface HostRow {
  host: string;
  entries: number;
  ok: number;
  failed: number;
}

export interface FailureRow {
  line: number;
  url: string;
  status: number;
  note: string;
}

/** 一节资源的对外一格：指纹 + 条目数 + 这一节核过没有。 */
export interface SectionRow {
  heading: string;
  entries: number;
  sha256: string;
  verified: boolean;
}

export interface ReachReport {
  manifest: string;
  total: number;
  ok: number;
  failed: number;
  cached: number;
  probed: number;
  pending: number;
  route: RouteName;
  hosts: HostRow[];
  sections: SectionRow[];
  failures: FailureRow[];
  summary: string;
  next: string;
  cache: string;
}

/** 一条链接的最终结论（缓存来的与这一轮探来的合并成同一种形状）。 */
interface Verdict {
  ok: boolean;
  status: number;
  note: string;
  route: RouteName;
  /** true = 这一轮没探它，结论是缓存里的。 */
  cached: boolean;
}

/* ── 定位「资源清单」 ──────────────────────────────────────────────────── */

const RESOURCES_NAME = 'RESOURCES.md';
const STAGE_DELIVER = 'deliver';

/** `workspace` 域给了 target 之后的读法形状（`lib/host/vault.ts` 的 `pathFacts`）。 */
interface PathView {
  path: string;
  kind: 'file' | 'dir' | 'missing';
  entries?: readonly string[];
}

function has(list: readonly string[] | undefined, name: string): boolean {
  return list !== undefined && list.includes(name);
}

/**
 * 把参数里的那个路径变成**盘上那份 `RESOURCES.md` 的绝对路径**。定位不到返回 null，
 * 由调用方编一句「我找了哪几处」的报告。**不猜**：一个目录里有别的 md 不算清单。
 */
export function locateManifest(access: DomainAccess, manifest: string): string | null {
  const located = access.read<PathView>('workspace', manifest);
  if (located.kind === 'file') {
    return path.basename(located.path) === RESOURCES_NAME ? located.path : null;
  }
  if (located.kind !== 'dir') return null;
  if (has(located.entries, RESOURCES_NAME)) return path.join(located.path, RESOURCES_NAME);
  if (has(located.entries, STAGE_DELIVER)) {
    const deliver = access.read<PathView>('workspace', path.join(located.path, STAGE_DELIVER));
    if (deliver.kind === 'dir' && has(deliver.entries, RESOURCES_NAME)) {
      return path.join(deliver.path, RESOURCES_NAME);
    }
  }
  return null;
}

/* ── 报告的编排 ────────────────────────────────────────────────────────── */

const MISSING_MANIFEST_NEXT = '把参数 manifest 改成「资源清单」的路径：RESOURCES.md 本身、含它的科目目录，'
  + '或暂存目录里的 deliver/RESOURCES.md（相对工作区根或绝对路径）。';

function emptyReport(manifest: string, summary: string, next: string, cache: string): ReachReport {
  return {
    manifest, total: 0, ok: 0, failed: 0, cached: 0, probed: 0, pending: 0,
    route: '未探', hosts: [], sections: [], failures: [], summary, next, cache,
  };
}

/** 请求是被取消的（信号打上来）不是站点答的——这种不算结论，也不该进台账。 */
function isCancelled(result: RequestResult): boolean {
  return result.transport && result.status === 0 && result.note === '已取消';
}

interface AssembleInput {
  manifest: string;
  links: readonly ManifestEntry[];
  verdicts: ReadonlyMap<string, Verdict>;
  probed: ReadonlySet<string>;
  pending: readonly string[];
  route: RouteName;
  cachedCount: number;
  offline: boolean;
  cache: string;
  /** 这一份清单切出来的小节（带指纹）——`verified` 就是在这里按「链接都有结论」判的。 */
  sections: readonly SectionFingerprint[];
}

function assemble(input: AssembleInput): ReachReport {
  const { links, verdicts } = input;
  let ok = 0;
  let failed = 0;
  const hostRows = new Map<string, HostRow>();
  for (const link of links) {
    const verdict = verdicts.get(link.url);
    if (verdict !== undefined) {
      if (verdict.ok) ok += 1;
      else failed += 1;
    }
    const host = hostOf(link.url);
    const row = hostRows.get(host) ?? { host, entries: 0, ok: 0, failed: 0 };
    row.entries += 1;
    if (verdict !== undefined) {
      if (verdict.ok) row.ok += 1;
      else row.failed += 1;
    }
    hostRows.set(host, row);
  }

  const failures: FailureRow[] = [];
  for (const link of links) {
    if (!input.probed.has(link.url)) continue;
    const verdict = verdicts.get(link.url);
    if (verdict === undefined || verdict.ok) continue;
    failures.push({
      line: link.line,
      url: link.url,
      status: verdict.status,
      note: verdict.note === '' ? '站点答了不成功状态' : verdict.note,
    });
  }

  const total = links.length;
  const summary = total === 0
    ? `「${input.manifest}」里没有 http/https 链接，没什么可核的。`
    : `「${input.manifest}」里共 ${total} 条链接：打得开 ${ok}、打不开 ${failed}；`
      + `这一轮探了 ${input.probed.size} 条、用缓存 ${input.cachedCount} 条`
      + `${input.pending.length === 0 ? '' : `，还有 ${input.pending.length} 条没轮到`}。`
      + `${input.offline ? '离线模式：一个请求都没发。' : ''}`;

  let next = '';
  if (input.pending.length > 0) {
    next = input.offline
      ? `这 ${input.pending.length} 条在缓存里没有记录（这次是离线模式，一个请求都没发）：`
        + '去掉 offline 再调一次 studymate_verify_sources。'
      : `还有 ${input.pending.length} 条没探完（墙上预算用完或调用被取消）：`
        + '用同一个 manifest 再调一次 studymate_verify_sources——缓存会让它只接着探剩下的。';
  } else if (failed > 0) {
    next = `${failed} 条打不开：把它们从清单里去掉，或换成等价来源后重核`;
  }

  // 逐节：这一节里**至少有一条链接、且每条都有结论**才算核过。
  // 判据刻意不写成「整份清单都核完」：按节冻结要的就是「主干那一节核完，下游就能取用」。
  // 也刻意不把「一条链接都没有的小节」算成核过——核验工具核的是链接，那种小节没有可核的
  // 东西，就不该记一份「核过」的记录（`verified` 的语义是「台账里有这一份指纹的记录」）。
  const sections: SectionRow[] = input.sections.map((section) => ({
    heading: section.heading,
    entries: section.entries,
    sha256: section.sha256,
    verified: section.urls.length > 0 && section.urls.every((url) => verdicts.has(url)),
  }));

  return {
    manifest: input.manifest,
    total,
    ok,
    failed,
    cached: input.cachedCount,
    probed: input.probed.size,
    pending: input.pending.length,
    route: input.route,
    hosts: [...hostRows.values()].sort((a, b) => cmpCodePoints(a.host, b.host)),
    sections,
    failures,
    summary,
    next,
    cache: input.cache,
  };
}

/**
 * 把这一轮核过的小节记进指纹台账，再把报告原样交回去。
 *
 * 记账是**旁路**：写不进去不影响报告（`markVerified` 自己吞异常）；反过来报告也不因为
 * 「记没记上」而改一个字——台账是给下一轮与交接门禁看的加速器，不是这一轮的结论。
 */
function recordVerified(report: ReachReport): ReachReport {
  const at = Date.now();
  const records = report.sections
    .filter((section) => section.verified)
    .map((section) => [section.sha256, { at }] as const);
  if (records.length > 0) markVerified(records);
  return report;
}

/* ── 渲染：一句能读的报告 ──────────────────────────────────────────────── */

export function renderReachReport(value: ReachReport): string {
  const head = `核验「${value.manifest}」：共 ${value.total} 条`
    + `（打得开 ${value.ok}、打不开 ${value.failed}；这一轮探 ${value.probed} 条、用缓存 ${value.cached} 条`
    + `${value.pending === 0 ? '' : `、没轮到 ${value.pending} 条`}）；路由：${value.route}`;
  // 逐节那一行与交接门禁的文本输出共用同一句（`sectionLine`）。
  const sections = value.sections.map((row) => sectionLine(row));
  const hosts = value.hosts.map((row) => `· ${row.host}：${row.entries} 条（打得开 ${row.ok}、打不开 ${row.failed}）`);
  const failures = value.failures.map((row) => `✗ 第 ${row.line} 行 ${row.url}`
    + `${row.status === 0 ? '' : `——HTTP ${row.status}`}（${row.note}）`);
  const tail = value.next === '' ? [] : [value.next];
  return [head, ...sections, ...hosts, ...failures, ...tail].join('\n');
}

/* ── 工具本体 ──────────────────────────────────────────────────────────── */

export interface ReachArgs {
  manifest: string;
  offline?: boolean;
  refresh?: boolean;
}

/**
 * 造那个工具。**没有可注入的服务**：缓存是盘上的、代理从环境来、请求由 `transport.ts` 发，
 * 所以这个 spec 是纯粹的一支（与实验域那个要任务服务的不同）。
 */
export function verifySourcesTool(): ReachToolSpec {
  return {
    name: 'studymate_verify_sources',
    description: '核验「资源清单」里的链接能不能打开：并发取、先定路由表、结果留缓存，再核只补增量。',
    parameters: REACH_PARAMETERS,
    reads: REACH_READS,
    writes: REACH_WRITES,
    output: {
      schema: REACH_OUTPUT_SCHEMA,
      render: (_args, value: ReachReport) => [{
        type: 'text',
        // 「没找到」这类空报告没有逐站行可列，直接给 summary + next 两句——那两句就是全部信息。
        text: value.total === 0 && value.probed === 0 && value.cached === 0
          ? [value.summary, value.next].filter((line) => line !== '').join('\n')
          : renderReachReport(value),
      }],
    },
    execute: async (args: ReachArgs, run: ReachRun): Promise<ReachReport> => {
      const manifest = typeof args.manifest === 'string' ? args.manifest : '';
      const cache = cacheFile();
      const notFound = (summary: string, next: string): ReachReport => emptyReport(manifest, summary, next, cache);

      // ── 1. 定位清单（永不抛：路径写错是常事，给一句能照着改的话）──────────
      let located: string | null;
      try {
        located = locateManifest(run.access, manifest);
      } catch (error) {
        return notFound(
          `读不了「${manifest}」指的那个路径：${error instanceof Error ? error.message : String(error)}。`,
          MISSING_MANIFEST_NEXT,
        );
      }
      if (located === null) {
        return notFound(
          `没找到「资源清单」：按「${manifest}」找到的不是一份 ${RESOURCES_NAME} 文件，`
          + `也不是含它的目录（也不含 ${STAGE_DELIVER}/${RESOURCES_NAME}）。`,
          MISSING_MANIFEST_NEXT,
        );
      }

      // ── 2. 读清单（`resources` 域只认 RESOURCES.md 这一份）────────────────
      let view: { file: string; present: boolean; markdown: string; bytes: number };
      try {
        view = run.access.read('resources', located);
      } catch (error) {
        return notFound(
          `读不了「资源清单」${located}：${error instanceof Error ? error.message : String(error)}`,
          `这个域只认 ${RESOURCES_NAME} 这一份文件：把 manifest 指到科目目录或暂存目录 deliver/ 下的 ${RESOURCES_NAME}。`,
        );
      }
      if (!view.present) {
        return notFound(
          `按「${manifest}」定位到 ${located}，但这份文件不在盘上。`,
          MISSING_MANIFEST_NEXT,
        );
      }

      // ── 3. 摘链接 + 分节 + 4. 缓存分片 ────────────────────────────────
      const links = extractLinks(view.markdown);
      const sections = fingerprintSections(view.markdown);
      const refresh = args.refresh === true;
      const offline = args.offline === true;
      const clock = Date.now();
      const ledger = loadCache();
      const cachedVerdicts = new Map<string, CacheEntry>();
      const toProbe: ManifestEntry[] = [];
      for (const link of links) {
        const entry = ledger.get(link.url);
        if (!refresh && entry !== undefined && isFresh(entry, clock)) cachedVerdicts.set(link.url, entry);
        else toProbe.push(link);
      }
      const cachedCount = cachedVerdicts.size;

      // ── 5. 离线：一个 socket 都不开 ───────────────────────────────────
      if (offline) {
        const verdicts = new Map<string, Verdict>();
        for (const [url, entry] of cachedVerdicts) {
          verdicts.set(url, { ok: entry.ok, status: entry.status, note: entry.note, route: entry.route, cached: true });
        }
        return recordVerified(assemble({
          manifest: located, links, verdicts, probed: new Set(), pending: toProbe.map((link) => link.url),
          route: '未探', cachedCount, offline: true, cache, sections,
        }));
      }

      // ── 6. 先定路由表：拿第一条待核的探一次，结果直接复用 ──────────────
      const proxy = proxyFromEnv(process.env);
      const deadline = clock + reachWallBudgetMs();
      const probe: ProbeFn = (url, route) => {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return Promise.resolve({
            ok: false, status: 0, statusText: '', contentType: '', note: 'URL 解析不了', transport: true,
          });
        }
        return requestOnce(parsed, {
          route, proxy, timeoutMs: PROBE_TIMEOUT_MS,
          ...run.signal === undefined ? {} : { signal: run.signal },
        });
      };

      let route: RouteName = '未探';
      const outcomes: ProbeOutcome[] = [];
      const budgetLeft = (): boolean => Date.now() < deadline;
      if (toProbe.length > 0 && budgetLeft()) {
        const first = toProbe[0];
        if (first !== undefined) {
          route = '直连';
          let result = await probe(first.url, '直连');
          if (result.transport && proxy !== null) {
            // 连接层才换路；HTTP 4xx/5xx 是站点自己的答复，换条路也一样。
            const retry = await probe(first.url, '代理');
            if (retry.ok) {
              route = '代理';
              result = retry;
            }
          }
          outcomes.push({ url: first.url, result, route });
          const rest = toProbe.slice(1).map((link) => ({ url: link.url, host: hostOf(link.url) }));
          const scheduled = await runProbes(rest, {
            route,
            hasProxy: proxy !== null,
            concurrency: REACH_CONCURRENCY,
            perHost: REACH_PER_HOST,
            deadline,
            now: () => Date.now(),
            ...run.signal === undefined ? {} : { signal: run.signal },
            probe,
          });
          route = scheduled.route;
          outcomes.push(...scheduled.outcomes);
        }
      }
      // 预算在第一条之前就用完了：一条都没探过，路由也就无从谈起（`未探`）。

      // ── 7. 合并结论、写台账 ────────────────────────────────────────────
      const settled = outcomes.filter((outcome) => !isCancelled(outcome.result));
      const settledUrls = new Set(settled.map((outcome) => outcome.url));
      const verdicts = new Map<string, Verdict>();
      for (const [url, entry] of cachedVerdicts) {
        verdicts.set(url, { ok: entry.ok, status: entry.status, note: entry.note, route: entry.route, cached: true });
      }
      for (const outcome of settled) {
        verdicts.set(outcome.url, {
          ok: outcome.result.ok,
          status: outcome.result.status,
          note: outcome.result.note,
          route: outcome.route,
          cached: false,
        });
      }
      if (settled.length > 0) {
        const updated = new Map(ledger);
        const at = Date.now();
        for (const outcome of settled) {
          updated.set(outcome.url, {
            ok: outcome.result.ok,
            status: outcome.result.status,
            route: outcome.route,
            at,
            note: outcome.result.note,
          });
        }
        saveCache(updated);
      }

      // 没探完 = 待探里没有结论的那些（既含预算到点从没起过的，也含被取消的）。
      const pending = toProbe.filter((link) => !settledUrls.has(link.url)).map((link) => link.url);
      // 「一条都没探过」时路由如实报 `未探`（路由表没被用过）。
      if (settled.length === 0) route = '未探';

      return recordVerified(assemble({
        manifest: located, links, verdicts, probed: settledUrls, pending,
        route, cachedCount, offline: false, cache, sections,
      }));
    },
  };
}
