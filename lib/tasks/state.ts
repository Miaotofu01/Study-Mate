/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 任务域 —— 六态状态机（值用中文，与目标态规格 §3.2 逐字一致）

   为什么自己写而不用宿主的 `ctx.jobs`（`dsh-jobs` + `dsh-jobs-local` + `dsh-tool-jobs`）：

     1. **不能落盘**。`dsh-jobs-local` 的模块注释写明「keeps every job — lifecycle state,
        the bounded output ring, and the model cursor — in memory」，而本 ticket 的硬要求是
        「导出这类关键任务落盘，重开 DSH 能接上」。宿主的 registry 没有重载入口，也没有
        「我上次跑到哪、产物在哪」这些字段。
     2. **要挂 attached controller**。`ctx.jobs.start()` 在没有 controller 服务该 owner 时**拒绝**
        启动（`dsh-plugin-api.md` §5.9），也就是组合里必须挂着 `dsh-tool-jobs`。StudyMate 是
        零依赖插件、还要在 headless/tui 组合里活着，不能被别的包的有无决定能不能起任务。
     3. 状态词表不同：宿主是 `running/stopping/completed/killed/failed`，本 ticket 要的是
        排队/运行/取消中/完成/失败/已取消（六态、中文枚举值）。

   代价是宿主那套「完成通知 + 唤醒 agent」（`ctx.jobs.events` + `agent.followup`）要自己接
   ——那张票不在本 ticket 范围里（宿主子 agent 的进度统一呈现另算，见目标态规格 §3.2 末句）。

   转移表是**唯一**的合法性来源：终态只进不出（`失败 → 排队` 是唯一的例外，专给被 DSH 重启
   打断的落盘任务 resume 用，服务侧还要再查 `interrupted` 才放行）。
   ───────────────────────────────────────────────────────────────────────── */

/** 六个状态。枚举值**就是**中文——工具输出、路由返回、盘上的记录三处用同一份词表。 */
export const TASK_STATUSES = ['排队', '运行', '取消中', '完成', '失败', '已取消'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 终态：到了就再也不动（first-wins）；`destroy` 只收终态的任务。 */
export const TERMINAL_STATUSES = ['完成', '失败', '已取消'] as const;

/** 终态的词表类型：回执（receipt）只可能是这三个之一。 */
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** 还没结束的状态（活着、可以被取消）。 */
export const LIVE_STATUSES: readonly TaskStatus[] = ['排队', '运行', '取消中'];

const STATUS_SET: ReadonlySet<string> = new Set(TASK_STATUSES);

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

/** 类型谓词：`if (!isTerminal(...)) return;` 之后调用方就能把 status 当终态用。 */
export function isTerminal(status: TaskStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly TaskStatus[]).includes(status);
}

export function isLive(status: TaskStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

/**
 * 合法转移。读法：`排队 → 运行`（调度器捡起来）、`运行 → 取消中`（收到取消请求）、
 * `取消中 → 完成`（取消信号发出后它还是跑完了——产物已经写好，报「已取消」是撒谎）。
 */
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  排队: ['运行', '已取消', '失败'],
  运行: ['取消中', '完成', '失败'],
  取消中: ['已取消', '完成'],
  完成: [],
  // 唯一的「从终态回来」：被重启打断的落盘任务 resume 重跑一遍（服务侧还要查 interrupted）
  失败: ['排队'],
  已取消: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 非法转移是**代码 bug**，不是用户输入错误——抛错，别静默改正。 */
export function assertTransition(id: string, from: TaskStatus, to: TaskStatus): void {
  if (canTransition(from, to)) return;
  throw new Error(`[TASK_BAD_TRANSITION] 任务 ${id} 不能从「${from}」转到「${to}」`
    + `（合法的是：${TRANSITIONS[from].length === 0 ? '没有，它已经是终态' : TRANSITIONS[from].join('、')}）`);
}
