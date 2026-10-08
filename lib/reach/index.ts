/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 核验域 —— 目录出口（原生工具 `studymate_verify_sources`，issue #125）

   注册点（`lib/tools/index.ts` 的 `registerStudyMate`）只加一行：

     registerReachTools(ctx, { registerStudyTool });

   域内的分工：

     · `manifest.ts`  —— 清单里有哪些链接（纯函数：不碰盘、不发请求）
     · `sections.ts`  —— 清单按 `##` 分节，逐节配链接、按域名的分布与**内容指纹**
     · `transport.ts` —— 一条 HTTP/1.1 GET 怎么发出去（`node:net`／`node:tls`，四个分支）
     · `schedule.ts`  —— 并发、同站礼貌、路由表、墙上预算（probe 是注入的，测试能驱动）
     · `cache.ts`     —— 两本台账：按 URL 的探测结论、按**小节指纹**的「这一份核过没有」
     · `tool.ts`      —— 定位清单、核只补增量、定路由表、如实报

   核验域**不 import 工具域**：`registerStudyTool` 由注册点当参数递进来，所以域图上只有
   「工具域 → 核验域」一条边（与 `lib/lab/index.ts`、`lib/tasks/index.ts` 同一个口径）。
   反过来说，往这个域里加 `../tools/**` 的 import 就是加了一条反向边，架构边界测试
   （#69）按域查环、默认拒绝。域声明里唯一要 `host` 的是「工具 body 拿到的
   `DomainAccess`」那个类型（只用 type，运行期一行都不借）。

   两本台账为什么落在 `<DSH_HOME>/studymate/reach/`（`cache.json` 按 URL、`verified.json` 按
   小节指纹）而不是学习工作区里：这是插件私有状态，不是学习数据。学习工作区的布局由
   docs/adr/0004-学习数据格式冻结与例外.md 冻着——学生看得见的目录里多出一份「探过哪些链接」
   的台账，既没有对应的阅读端出口，也会让「换台机器同步学习数据」带上一份与本地网络环境
   绑死的记录。与任务台账（`lib/tasks/store.ts`）选同一个落点、同一个理由。
   ───────────────────────────────────────────────────────────────────────── */

import { verifySourcesTool } from './tool.ts';
import type { ReachToolContext, ReachToolRegistry, ReachToolSpec } from './tool.ts';

/** 这个域注册的原生工具名字表（注册点与测试共用一份，别在两处各写一遍）。 */
export const REACH_TOOL_NAMES = ['studymate_verify_sources'] as const;

/**
 * 把核验域挂到插件上。注册点只调这一行：
 *
 *     registerReachTools(ctx, { registerStudyTool });
 *
 * `registerStudyTool` 是注册点注入进来的——核验域自己不 import 工具域（见文件头）。
 */
export function registerReachTools(ctx: ReachToolContext, registry: ReachToolRegistry): void {
  registry.registerStudyTool(ctx, verifySourcesTool());
}

export {
  DEFAULT_WALL_BUDGET_MS, MAX_WALL_BUDGET_MS, PROBE_TIMEOUT_MS, REACH_CONCURRENCY, REACH_PER_HOST,
  REACH_OUTPUT_SCHEMA, REACH_PARAMETERS, REACH_READS, REACH_WRITES, locateManifest,
  reachWallBudgetMs, renderReachReport, verifySourcesTool,
} from './tool.ts';
export { extractLinks } from './manifest.ts';
export { parseProxy, proxyFromEnv, requestOnce } from './transport.ts';
export { runProbes } from './schedule.ts';
export { fingerprintSections, hostOf, sha256Text } from './sections.ts';
export {
  cacheFile, isFresh, loadCache, loadVerified, markVerified, reachDir, saveCache, verifiedFile,
} from './cache.ts';
export type { HostRow, FailureRow, ReachArgs, ReachReport, ReachRun, ReachToolContext, ReachToolRegistry, ReachToolSpec, SectionRow } from './tool.ts';
export type { ManifestEntry } from './manifest.ts';
export type { ProbeFn, ProbeOutcome, ProbeTarget, ScheduleResult } from './schedule.ts';
export type { ProxyTarget, RequestResult, RouteName } from './transport.ts';
export type { CacheEntries, CacheEntry, VerifiedEntries, VerifiedRecord } from './cache.ts';
export type { ResourceHost, SectionFingerprint } from './sections.ts';
