/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 核验域 —— 探过的结果留在哪

   落点：`<DSH_HOME>/studymate/reach/cache.json`，**按 URL 一份台账**。

   为什么是这里（与任务台账同一个理由，见 `lib/tasks/store.ts` 的文件头）：这是**插件私有**
   状态，不是学习数据。学习工作区的布局由 docs/adr/0004-学习数据格式冻结与例外.md 冻着，
   不该为了「少发几个请求」往学生看得见的目录里塞一份缓存。

   为什么按 URL 而不是按清单：**这才是「第一遍白跑变成增量」的那一步**。那一场（2026-10-07）
   清单从 105 条涨到 118 条，第一遍 12.75 分钟的核验整段作废、又从头跑了 10.65 分钟；
   按 URL 记账之后，第二遍只需要探新增的那 13 条。

   为什么原子写（临时文件 + rename）：与任务台账同一个理由——重开时读到的要么是旧的一份
   完整台账、要么是新的一份，不会读到写了一半的半个 JSON。

   为什么读的时候容错、写的时候吞异常：**缓存是加速器，不是事实来源**。它坏了就当没有，
   绝不能因为一份缓存把整轮核验带崩。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from '../workspace.ts';
import type { RouteName } from './transport.ts';

export interface CacheEntry {
  readonly ok: boolean;
  readonly status: number;
  readonly route: RouteName;
  /** 这一条是什么时候核的（毫秒时间戳）。 */
  readonly at: number;
  /** 打不开时的一句原因；打得开是空串。 */
  readonly note: string;
}

export type CacheEntries = Map<string, CacheEntry>;

/** 打得开的留久一点：稳定来源本来就难得失效，7 天够用。 */
const TTL_OK_MS = 7 * 24 * 60 * 60 * 1000;
/** 打不开的留短一点：站点临时抽风不该被记一星期。 */
const TTL_FAIL_MS = 6 * 60 * 60 * 1000;
/** 上限：一份台账不该无限长下去。超了丢最老的。 */
const MAX_ENTRIES = 2000;

export function reachDir(home: string = dshHome()): string {
  return path.join(home, 'studymate', 'reach');
}

export function cacheFile(home: string = dshHome()): string {
  return path.join(reachDir(home), 'cache.json');
}

export function isFresh(entry: CacheEntry, now: number): boolean {
  return now - entry.at < (entry.ok ? TTL_OK_MS : TTL_FAIL_MS);
}

function entryOf(value: unknown): CacheEntry | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const status = record.status;
  const route = record.route;
  const at = record.at;
  if (typeof record.ok !== 'boolean') return null;
  if (typeof status !== 'number' || !Number.isFinite(status)) return null;
  if (route !== '直连' && route !== '代理' && route !== '未探') return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  return { ok: record.ok, status, route, at, note: typeof record.note === 'string' ? record.note : '' };
}

/** 读台账。**文件不存在、坏掉、读不动都是「没有缓存」**，一律返回空表。 */
export function loadCache(home: string = dshHome()): CacheEntries {
  let text = '';
  try {
    text = fs.readFileSync(cacheFile(home), 'utf8');
  } catch {
    return new Map();
  }
  try {
    const parsed = JSON.parse(text) as { entries?: unknown } | null;
    const raw = parsed?.entries;
    if (raw === null || typeof raw !== 'object') return new Map();
    const out: CacheEntries = new Map();
    for (const [url, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = entryOf(value);
      if (entry !== null) out.set(url, entry);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** 写台账。写不进去就算了——下一轮重探一遍，结论一样，只是慢一点。 */
export function saveCache(entries: CacheEntries, home: string = dshHome()): void {
  try {
    const dir = reachDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const kept = [...entries.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
    const body = JSON.stringify({ version: 1, entries: Object.fromEntries(kept) }, null, 2);
    const file = cacheFile(home);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // 见文件头：缓存写不进去不影响这一轮的结论
  }
}
