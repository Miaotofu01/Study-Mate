/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 任务域 —— 记录形状 / 句柄 / 越权错误 / 对外投影

   三层东西分清楚，别混：

     · `TaskRecord` —— **盘上那一份**（durable 的会以 JSON 落在 <DSH_HOME>/studymate/tasks/）。
     · `TaskHandle` —— **句柄**：`{ id, owner }` 两个字段，`start()` 发出去。它只对拿到它的那个
       owner 有效：别人（另一个会话标签）拿这个句柄来访问，`#assertAccess` 直接拒。这是 ticket
       里「别人拿到的句柄访问不了它」的落点。
     · `TaskView`   —— **对外投影**：工具与路由返回的就是它。带 `receipt`（终态回执）、
       `progress`（阅读端画进度条）、`canCancel`。路由再用 `toBoardView` 摘掉 `owner`
       ——进度条不需要知道是谁起的，摘掉就没有「从板子上抄个 owner 去伪造句柄」这条缝。

   owner 是**标签**，不是凭据：它在进程内标识「谁起的活」，防的是同一个进程里另一个会话/另一段
   代码顺手拿别人的句柄；它不防能读盘的人（盘上的记录本来就是人可读的 JSON）。写清楚这条边界，
   免得后来人把它当成权限系统。
   ───────────────────────────────────────────────────────────────────────── */

import { isTerminal } from './state.ts';
import type { TaskStatus, TerminalStatus } from './state.ts';

/** 任务结果/输入的 JSON 值域（与工具域的 JsonValue 同形，两个域各写一份，避免互相 import）。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 没有会话身份的调用方（探针、无头脚本、插件自己起的活）。等同于宿主 `ctx.jobs` 的「无主任务」：
 *  任何调用方都看得见、动得了。真要说「别人拿不到」的是**带会话标签**的那些。 */
export const UNOWNED = '本机';

/** 一件产物的状态：`进行中` 的是半成品（取消时不会被算进「保留」），`已完成` 的永远保留。 */
export const ARTIFACT_STATES = ['进行中', '已完成'] as const;
export type ArtifactState = (typeof ARTIFACT_STATES)[number];

export interface TaskArtifact {
  path: string;
  state: ArtifactState;
}

/** 进度：一行给人看的话 + 可选的步数（阅读端据此画进度条，percent 由服务算好）。 */
export interface TaskProgress {
  line: string;
  done?: number;
  total?: number;
}

/** 盘上那一份任务记录。字段只增不改语义；`version` 留给以后迁移。 */
export interface TaskRecord {
  version: 1;
  /** `<prefix>-<n>`，例如 `export-1`。前缀是 ASCII，方便做文件名与 URL 参数。 */
  id: string;
  /** 任务类型的中文名（`导出` / `资料格式转换` / `索引重建` …）。 */
  kind: string;
  prefix: string;
  /** 给模型/人看的一行：这次到底在干什么。 */
  label: string;
  owner: string;
  durable: boolean;
  status: TaskStatus;
  /** 第几次跑。resume 之后 +1（被重启打断的那一轮没有产物完整性可言）。 */
  attempt: number;
  progress: TaskProgress | null;
  artifacts: TaskArtifact[];
  /** 产出方要的入参（resume 时要拿同一份重跑）。 */
  input: JsonValue | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  /** 终态原因（失败为什么失败、取消是因为什么）。 */
  detail: string | null;
  /** 终态结果；**必须是对象**（见 `assertJson` 一侧的口径）。 */
  result: JsonValue | null;
  /** 被进程重启打断过：`resume` 只认这一类。 */
  interrupted: boolean;
  cancelReason: string | null;
}

/** 句柄：`start()` 发给 owner 的那两个字段。 */
export interface TaskHandle {
  readonly id: string;
  readonly owner: string;
}

export function handleOf(record: TaskRecord): TaskHandle {
  return { id: record.id, owner: record.owner };
}

/** 终态回执：三种结局各一份明确的话（ticket 的验收就是按这个数）。 */
export interface TaskReceipt {
  status: TerminalStatus;
  summary: string;
  /** 一定会保留的产物（已完成的）。 */
  kept: string[];
  /** 半成品（进行中的）：产出方按取消信号收尾，任务记录把它们标成「部分」。 */
  discarded: string[];
  result?: JsonValue;
}

/** 对外投影。路由另外用 `toBoardView` 摘掉 owner。 */
export interface TaskView {
  id: string;
  kind: string;
  label: string;
  owner: string;
  status: TaskStatus;
  durable: boolean;
  attempt: number;
  progress?: { line: string; done?: number; total?: number; percent?: number };
  artifacts: TaskArtifact[];
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
  detail?: string;
  interrupted?: boolean;
  canCancel: boolean;
  receipt?: TaskReceipt;
}

/** 阅读端要的那一片：进度条 + 一句状态 + 产物清单 + 终态回执，**没有 owner**（见文件头）。 */
export interface TaskBoardEntry {
  id: string;
  kind: string;
  label: string;
  status: TaskStatus;
  durable: boolean;
  attempt: number;
  progress?: TaskView['progress'];
  artifacts: TaskArtifact[];
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
  detail?: string;
  interrupted?: boolean;
  canCancel: boolean;
  receipt?: TaskReceipt;
}

/* ── 错误：越权 / 找不到 / 等待被打断。消息都要能照着改 ─────────────────── */

export class TaskAccessError extends Error {
  readonly code = 'TASK_FORBIDDEN';
  constructor(detail: { id: string; actor: string; owner: string; why: string }) {
    super(`[TASK_FORBIDDEN] 任务「${detail.id}」不是你（${detail.actor}）的：${detail.why}；`
      + `它属于「${detail.owner}」。句柄只对发出去的那个 owner 有效——`
      + '要查你自己的任务就不带 id 调 status，或者用你自己那个任务的 id。');
    this.name = 'TaskAccessError';
  }
}

export class TaskNotFoundError extends Error {
  readonly code = 'TASK_NOT_FOUND';
  constructor(id: string, known: readonly string[]) {
    super(`[TASK_NOT_FOUND] 没有任务「${id}」：它可能已经被销毁，或者从来就不存在。`
      + `${known.length === 0 ? '现在一个任务都没有。' : `现在还看得见的是：${known.join('、')}`}`);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskWaitAbortedError extends Error {
  readonly code = 'TASK_WAIT_ABORTED';
  constructor(id: string, reason: string) {
    super(`[TASK_WAIT_ABORTED] 等任务「${id}」的过程被打断了（${reason}）。任务本身没被取消——`
      + '要停它就调 cancel；要接着看就再调一次 status（那个从不阻塞）。');
    this.name = 'TaskWaitAbortedError';
  }
}

/* ── 校验：入参与结果一律走 JSON 值域 ──────────────────────────────────── */

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return typeof value === 'object' ? '对象' : typeof value;
}

/** 递归查一遍「这份值能不能原样落盘」。落盘失败要到重启后才发现，那太晚了。 */
export function assertJson(value: unknown, what: string, path = ''): void {
  if (value === undefined) {
    throw new Error(`[TASK_BAD_INPUT] ${what} 里有 undefined${path ? `（${path}）` : ''}：`
      + '任务记录要落盘，JSON 里没有 undefined——要表示「没有」就用 null 或者干脆别写这个键');
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`[TASK_BAD_INPUT] ${what} 里有 ${typeof value}${path ? `（${path}）` : ''}：落不了盘`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`[TASK_BAD_INPUT] ${what} 里有 ${String(value)}${path ? `（${path}）` : ''}：JSON 里没有 NaN/Infinity`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, what, `${path}/${index}`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) assertJson(child, what, `${path}/${key}`);
  }
}

/* ── 投影 ──────────────────────────────────────────────────────────────── */

function percentOf(progress: { done?: number; total?: number }): number | undefined {
  const { done, total } = progress;
  if (typeof done !== 'number' || typeof total !== 'number' || total <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function progressView(record: TaskRecord): TaskView['progress'] {
  if (!record.progress) return undefined;
  const percent = percentOf(record.progress);
  return {
    line: record.progress.line,
    ...record.progress.done === undefined ? {} : { done: record.progress.done },
    ...record.progress.total === undefined ? {} : { total: record.progress.total },
    ...percent === undefined ? {} : { percent },
  };
}

function keptOf(record: TaskRecord): string[] {
  return record.artifacts.filter((artifact) => artifact.state === '已完成').map((artifact) => artifact.path);
}

function discardedOf(record: TaskRecord): string[] {
  return record.artifacts.filter((artifact) => artifact.state === '进行中').map((artifact) => artifact.path);
}

/**
 * 终态回执。**派生**出来的（不单独存一份），所以盘上的记录重新加载后照样读得到：
 * `status + detail + result + artifacts` 四样就够写清三种结局。
 */
export function receiptOf(record: TaskRecord): TaskReceipt | undefined {
  if (!isTerminal(record.status)) return undefined;
  const kept = keptOf(record);
  const discarded = discardedOf(record);
  const artifacts = kept.length + discarded.length === 0
    ? '这次没有产物'
    : `保留 ${kept.length} 件已完成的产物${kept.length > 0 ? `（${kept.join('、')}）` : ''}`
      + (discarded.length > 0 ? `；${discarded.length} 件半成品不算数（${discarded.join('、')}）` : '');
  const parts: string[] = [];
  if (record.status === '完成') {
    parts.push(`${record.kind}「${record.label}」做完了${record.detail === null ? '' : `：${record.detail}`}`);
  } else if (record.status === '失败') {
    parts.push(`${record.kind}「${record.label}」失败了${record.detail === null ? '（产出方没给原因）' : `：${record.detail}`}`
      + (record.interrupted ? '（这一轮是被 DSH 重启打断的，可以 resume 接上）' : ''));
  } else {
    parts.push(`${record.kind}「${record.label}」已取消`
      + (record.cancelReason === null ? '' : `（${record.cancelReason}）`)
      + (record.detail === null ? '' : `：${record.detail}`));
  }
  parts.push(artifacts);
  return {
    status: record.status,
    summary: `${parts.join('；')}。`,
    kept,
    discarded,
    ...record.result === null ? {} : { result: record.result },
  };
}

export function toView(record: TaskRecord): TaskView {
  const progress = progressView(record);
  const receipt = receiptOf(record);
  return {
    id: record.id,
    kind: record.kind,
    label: record.label,
    owner: record.owner,
    status: record.status,
    durable: record.durable,
    attempt: record.attempt,
    ...progress === undefined ? {} : { progress },
    artifacts: record.artifacts.map((artifact) => ({ ...artifact })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...record.settledAt === null ? {} : { settledAt: record.settledAt },
    ...record.detail === null ? {} : { detail: record.detail },
    ...record.interrupted ? { interrupted: true } : {},
    canCancel: !isTerminal(record.status),
    ...receipt === undefined ? {} : { receipt },
  };
}

export function toBoardView(record: TaskRecord): TaskBoardEntry {
  const { owner: _owner, ...board } = toView(record);
  return board;
}
