/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 插件页状态（Host 半）

   插件管理页里的「学习工作区」状态卡要的是**事实与计数**，不是整份 library：
   它每打开一次插件页就会读一次，而 library 会把每门科目的课件、题库、作答都读进来。
   这里只投影出「工作区在哪、初始化没有、每门课的三档计数、哪门读不了、监听在不在」，
   形状固定、字段有界。

   两个刻意的写法：

     · **没配置 / 没建科目是状态，不是错误**。阅读端的 `GET /api/studymate/library`
       在没有 workspace 时返回 500——那条路是给「已经在读课件」的页面用的；插件页要在
       「还没配置」时也画得出来，所以这条路由永远 200，页面按 `configured/initialized`
       自己分空态。
     · **不在这里判工作区优先级**。`resolveWorkspace()` / `resolveWorkspaceSource()`
       是唯一一处「原生 config > 安装器 YAML」的判断（lib/workspace.ts），这里只读结果。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

import { readLibrary } from './library.ts';
import {
  configFile, readConfigObject, resolveRoot, resolveWorkspace, resolveWorkspaceSource,
} from './workspace.ts';

/** 监听状态由调用方注入（bin 域读 watch 再传进来），lib 域不反向依赖 watch。 */
export interface StatusWatch {
  watching: boolean;
  backend: string;
}

/** 一门科目的形状（只够画状态卡，不带课件/题库/作答）。 */
export interface StatusSubject {
  slug: string;
  name: string;
  status: string;
  updated_at: string;
  levels: number;
  continue_node: string;
  /** 三档计数：未开始 / 学习中 / 已学完。 */
  stats: Record<string, number>;
}

/** 读不出来的科目：只坏这一门，其余照常。 */
export interface StatusUnreadable {
  dir: string;
  error: string;
}

export interface StudyMateStatus {
  /** 这份状态是不是读成功（false 时 `error` 给机器码，页面翻字典）。 */
  ok: boolean;
  error?: 'internal' | 'workspace-unreadable';
  workspace: string;
  source: 'plugin-config' | 'installer-config' | '';
  configured: boolean;
  initialized: boolean;
  root: string;
  configFile: string;
  mode: 'native' | 'standalone' | 'unknown';
  today: string;
  timeZone: string;
  subjects: StatusSubject[];
  unreadable: StatusUnreadable[];
  watch: { watching: boolean; backend: string };
  generated_at: string;
}

function localToday(now: Date): { today: string; timeZone: string } {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  return { today, timeZone };
}

function installMode(config: Record<string, unknown>, profile: string | undefined): 'native' | 'standalone' | 'unknown' {
  const modes = config.installModes;
  if (!modes || typeof modes !== 'object' || Array.isArray(modes)) return 'unknown';
  const value = profile === undefined ? undefined : (modes as Record<string, unknown>)[profile];
  return value === 'native' || value === 'standalone' ? value : 'unknown';
}

/** 只投影状态卡要的字段；不把 library 的节点/课件/题库带出去。 */
function subjectSummary(subject: {
  slug?: unknown; name?: unknown; status?: unknown; updated_at?: unknown;
  levels?: unknown; continue_node?: unknown; stats?: unknown;
}): StatusSubject {
  const stats: Record<string, number> = {};
  if (subject.stats && typeof subject.stats === 'object' && !Array.isArray(subject.stats)) {
    for (const [tier, count] of Object.entries(subject.stats as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count)) stats[tier] = count;
    }
  }
  return {
    slug: typeof subject.slug === 'string' ? subject.slug : '',
    name: typeof subject.name === 'string' ? subject.name : '',
    status: typeof subject.status === 'string' ? subject.status : '',
    updated_at: typeof subject.updated_at === 'string' ? subject.updated_at : '',
    levels: typeof subject.levels === 'number' && Number.isFinite(subject.levels) ? subject.levels : 0,
    continue_node: typeof subject.continue_node === 'string' ? subject.continue_node : '',
    stats,
  };
}

/**
 * 生成插件页状态卡的载荷。纯读盘，不写；任何分支都不抛（`ok:false` 表达读失败）。
 *
 * @param options.profile - 用来查 `studymate-config.yaml` 的 `installModes`；缺省时 `mode: 'unknown'`。
 * @param options.now - 测试注入的时钟（today / generated_at）。
 * @param options.watch - 监听状态；由 bin 域从 `watchState()` 传入，缺省表示没有监听。
 */
export function buildStatus(options: { profile?: string; now?: Date; watch?: StatusWatch } = {}): StudyMateStatus {
  const now = options.now ?? new Date();
  const file = configFile();
  const config = readConfigObject(file) ?? {};
  const workspace = resolveWorkspace(file);
  const source = resolveWorkspaceSource(file);
  const root = resolveRoot(file);
  const { today, timeZone } = localToday(now);
  const subjectsDir = workspace === '' ? '' : path.join(workspace, '.learning', 'subjects');
  let initialized = false;
  try {
    initialized = subjectsDir !== '' && fs.statSync(subjectsDir).isDirectory();
  } catch {
    initialized = false;
  }

  const base: StudyMateStatus = {
    ok: true,
    workspace,
    source,
    configured: workspace !== '',
    initialized,
    root,
    configFile: file,
    mode: installMode(config, options.profile),
    today,
    timeZone,
    subjects: [],
    unreadable: [],
    watch: options.watch ?? { watching: false, backend: 'unavailable' },
    generated_at: now.toISOString(),
  };

  if (!initialized) return base;

  try {
    const library = readLibrary({ workspace, isolateBrokenSubjects: true });
    return {
      ...base,
      subjects: library.subjects.map(subjectSummary),
      unreadable: library.unreadable.map(entry => ({ dir: entry.dir, error: entry.error })),
    };
  } catch {
    return { ...base, ok: false, error: 'workspace-unreadable' };
  }
}

/** 读盘本身出错时的兜底载荷：仍然是 200，页面能画「读不到」。 */
export function failedStatus(error: 'internal' | 'workspace-unreadable', now = new Date()): StudyMateStatus {
  const { today, timeZone } = localToday(now);
  return {
    ok: false,
    error,
    workspace: '',
    source: '',
    configured: false,
    initialized: false,
    root: '',
    configFile: configFile(),
    mode: 'unknown',
    today,
    timeZone,
    subjects: [],
    unreadable: [],
    watch: { watching: false, backend: 'unavailable' },
    generated_at: now.toISOString(),
  };
}
