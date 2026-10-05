/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 任务域 —— 五个原生工具（`studymate_task_*`）

   为什么任务域**不 import 工具域**，而是由注册点把 `registerStudyTool` 传进来：工具域是
   「谁注册谁」的那一头（`lib/tools/index.ts` 的清单会 import 每一个子系统）。要是这边反过来
   import `../tools/define.ts`，域图上就出现 tools ↔ tasks 的**环**，而架构边界测试（#69）
   按域查环、默认拒绝。所以两个域之间只有一条边：**工具域 → 任务域**，方向由注册点注入。

   这五个工具的分工（`start` 不在这里，是刻意的）：

     · `studymate_task_status` —— 不阻塞地看（一个 id 或列全部）
     · `studymate_task_wait`   —— 有上限地等，超时给下一步
     · `studymate_task_cancel` —— 取消 + 回执（哪些已完成的产物会保留）
     · `studymate_task_destroy`—— 销毁 + 回执（先回执、后删文件）
     · `studymate_task_resume` —— 接上被 DSH 重启打断的落盘任务

   **起任务不是工具**：目标是「插件自己执行的后台工作」（导出、资料格式转换、索引重建），
   那些活由产出方起——导出工具（#82）拿到句柄就返回给模型，模型再用上面这几个工具盯它。
   给模型一个「凭空起任务」的入口只会让它造出没有产出方的空任务。

   owner 标签取自宿主执行上下文里的调用方（`exec.agent.id`）：同一个会话看得见、动得了自己
   的任务与「本机」的无主任务，别的会话的任务一律拒（`TASK_FORBIDDEN`）。
   ───────────────────────────────────────────────────────────────────────── */

import { MAX_WAIT_MS, DEFAULT_WAIT_MS } from './service.ts';
import type { TaskService } from './service.ts';
import { TASK_STATUSES } from './state.ts';
import { UNOWNED } from './record.ts';
import type { TaskView } from './record.ts';

/** 工具域 `define.ts` 需要的上下文形状（结构化对齐，不 import）。 */
export interface TaskToolContext {
  tools?: { register?: (definition: unknown) => unknown };
  effect?: (fn: () => unknown, description?: string) => unknown;
  inject?: (names: string[], handler: (ctx: TaskInjectContext) => void) => unknown;
  get?: (name: string) => unknown;
}

/** `ctx.inject(['connection'], cb)` 给的那层上下文。 */
export interface TaskInjectContext {
  connection?: { fetch?: { register?: (route: unknown) => unknown } };
  effect?: (fn: () => unknown, description?: string) => unknown;
}

/** 工具 body 拿到的执行上下文（`define.ts` 的 `StudyRun` 的超集里我们用到的两个成员）。 */
export interface TaskRunLike {
  signal?: AbortSignal;
  /** 调用方的会话标签；没有会话身份的调用方是 undefined（无主任务）。 */
  agent?: string;
}

/** 与工具域 `StudyToolSpec` 同形的一份（见文件头：不 import，避免成环）。 */
export interface TaskToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: any, value: any) => { type: 'text'; text: string }[];
  };
  execute: (args: any, run: TaskRunLike) => Promise<unknown>;
}

/** 注册点注入的造工具能力。 */
export interface TaskToolRegistry {
  registerStudyTool: (ctx: TaskToolContext, spec: TaskToolSpec) => void;
}

const TEXT = { type: 'string' } as const;
const INTEGER = { type: 'integer' } as const;
const STRINGS = { type: 'array', items: TEXT } as const;

const PROGRESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['line'],
  properties: { line: TEXT, done: INTEGER, total: INTEGER, percent: { type: 'number' } },
};

const ARTIFACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'state'],
  properties: { path: TEXT, state: { type: 'string', enum: ['进行中', '已完成'] } },
};

const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'kept', 'discarded'],
  properties: {
    status: { type: 'string', enum: ['完成', '失败', '已取消'] },
    summary: TEXT,
    kept: STRINGS,
    discarded: STRINGS,
    // 产出方的返回值：契约是 JSON 对象（见 service.ts 里的同一口径）
    result: { type: 'object', additionalProperties: true },
  },
};

export const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'label', 'owner', 'status', 'durable', 'attempt', 'artifacts',
    'createdAt', 'updatedAt', 'canCancel'],
  properties: {
    id: TEXT,
    kind: TEXT,
    label: TEXT,
    owner: TEXT,
    status: { type: 'string', enum: TASK_STATUSES },
    durable: { type: 'boolean' },
    attempt: INTEGER,
    progress: PROGRESS_SCHEMA,
    artifacts: { type: 'array', items: ARTIFACT_SCHEMA },
    createdAt: TEXT,
    updatedAt: TEXT,
    settledAt: TEXT,
    detail: TEXT,
    interrupted: { type: 'boolean' },
    canCancel: { type: 'boolean' },
    receipt: RECEIPT_SCHEMA,
  },
};

/** 调用方的 owner 标签：有会话身份就是它，没有就是「本机」（无主任务，谁都看得见）。 */
export function actorOf(run: TaskRunLike | undefined): string {
  const id = run?.agent;
  return typeof id === 'string' && id.trim() !== '' ? id : UNOWNED;
}

function viewLine(view: TaskView): string {
  const progress = view.progress
    ? ` · ${view.progress.line}${view.progress.percent === undefined ? '' : `（${view.progress.percent}%）`}`
    : '';
  return `${view.id}｜${view.status}｜${view.kind}：${view.label}${progress}`;
}

/**
 * 造五个工具。`service` 由注册点那一份单例传进来——工具与路由必须看同一份台账，
 * 否则「起了任务但查不到」。
 */
export function taskToolSpecs(service: TaskService): TaskToolSpec[] {
  return [
    {
      name: 'studymate_task_status',
      description: '看后台任务的状态（不阻塞）：给 id 看一个，不给就列出你自己的任务。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: '任务 id（例如 export-1）；省略就是列全部。' } },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['tasks', 'notes'],
          properties: { tasks: { type: 'array', items: TASK_VIEW_SCHEMA }, notes: STRINGS },
        },
        render: (_args, value: any) => {
          const tasks: TaskView[] = value.tasks;
          if (tasks.length === 0) {
            return [{ type: 'text', text: (value.notes as string[]).join('\n') || '现在没有任务。' }];
          }
          const lines = tasks.map((task) => (task.receipt ? `${viewLine(task)}——${task.receipt.summary}` : viewLine(task)));
          const notes = (value.notes as string[]).length > 0 ? `\n${(value.notes as string[]).join('\n')}` : '';
          return [{ type: 'text', text: `${lines.join('\n')}${notes}` }];
        },
      },
      execute: async (args: { id?: string }, run) => {
        const actor = actorOf(run);
        if (typeof args.id === 'string' && args.id !== '') {
          return { tasks: [service.status(actor, args.id)], notes: [] };
        }
        const tasks = service.list(actor);
        const live = tasks.filter((task) => task.status === '运行' || task.status === '取消中' || task.status === '排队');
        return {
          tasks,
          notes: [
            ...tasks.length === 0
              ? ['现在没有任务。任务由产出方起（导出这类工具），起完把 id 给你；'
                + '这一句之后你可以随时用 studymate_task_status 看它。']
              : [],
            ...live.length === 0 ? [] : [`${live.length} 个还没结束；等它们就用 studymate_task_wait（有上限）。`],
            ...tasks.some((task) => task.interrupted)
              ? ['有任务是被 DSH 重启打断的（interrupted）：要接着做用 studymate_task_resume，要收尾用 studymate_task_destroy。']
              : [],
          ],
        };
      },
    },

    {
      name: 'studymate_task_wait',
      description: '等一个后台任务结束，单次有上限；超时会给出下一步怎么走，不会一直挂着。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: '任务 id。' },
          // 上界只写在描述里，**不写 `minimum`/`maximum`**：宿主认的 JSON Schema 子集是
          // 「type / oneOf / properties / required / additionalProperties / items / enum / const
          // + 注解」，多一个关键字就整批工具注册不上（实测过：注册期直接抛，插件只能退回旧路径）。
          // 真正的上界由 `service.wait` 按 `MAX_WAIT_MS` 自己拒（越界回 `[TASK_BAD_INPUT]`）。
          timeoutMs: {
            type: 'integer',
            description: `这次最多等多少毫秒（默认 ${DEFAULT_WAIT_MS}，上限 ${MAX_WAIT_MS}）；超时返回下一步提示。`,
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['settled', 'timedOut', 'waitedMs', 'task', 'next'],
          properties: {
            settled: { type: 'boolean' },
            timedOut: { type: 'boolean' },
            waitedMs: INTEGER,
            task: TASK_VIEW_SCHEMA,
            next: TEXT,
          },
        },
        render: (_args, value: any) => {
          const task: TaskView = value.task;
          if (value.settled) {
            return [{ type: 'text', text: `${viewLine(task)}——${task.receipt?.summary ?? '结束了。'}` }];
          }
          return [{
            type: 'text',
            text: `等了 ${Math.round(value.waitedMs / 1000)} 秒还没结束：${viewLine(task)}\n${value.next}`,
          }];
        },
      },
      execute: async (args: { id: string; timeoutMs?: number }, run) => {
        const actor = actorOf(run);
        return service.wait(actor, args.id, {
          ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
          ...run?.signal === undefined ? {} : { signal: run.signal },
        });
      },
    },

    {
      name: 'studymate_task_cancel',
      description: '请求取消一个后台任务；回执说清哪些已完成的产物会保留。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: '任务 id。' },
          reason: { type: 'string', description: '为什么取消（写进记录，学生与产出方都看得到）。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'status', 'requested', 'kept', 'discarded', 'note'],
          properties: {
            id: TEXT,
            status: { type: 'string', enum: TASK_STATUSES },
            requested: { type: 'boolean' },
            kept: STRINGS,
            discarded: STRINGS,
            note: TEXT,
          },
        },
        render: (_args, value: any) => [{ type: 'text', text: `${value.id} 现在是「${value.status}」。${value.note}` }],
      },
      execute: async (args: { id: string; reason?: string }, run) => service.cancel(
        actorOf(run), args.id, args.reason,
      ),
    },

    {
      name: 'studymate_task_destroy',
      description: '销毁一个已结束任务的记录与文件：先给回执，后删文件。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: '任务 id；任务必须已经结束（完成/失败/已取消）。' },
          deleteArtifacts: {
            type: 'boolean',
            description: '连产物一起删（默认 false：产物一律保留，只清记录）。',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'status', 'order', 'recordFiles', 'artifactsKept', 'artifactsDeleted', 'note'],
          properties: {
            id: TEXT,
            status: { type: 'string', enum: TASK_STATUSES },
            order: TEXT,
            recordFiles: STRINGS,
            artifactsKept: STRINGS,
            artifactsDeleted: STRINGS,
            note: TEXT,
          },
        },
        render: (_args, value: any) => [{ type: 'text', text: `${value.id}（${value.status}）销毁回执：${value.note}` }],
      },
      execute: async (args: { id: string; deleteArtifacts?: boolean }, run) => service.destroy(
        actorOf(run), args.id, { deleteArtifacts: args.deleteArtifacts === true },
      ),
    },

    {
      name: 'studymate_task_resume',
      description: '接上一个被 DSH 重启打断的落盘任务，按原来的类型重跑一遍。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: '任务 id；它要是被打断的那种（interrupted）。' } },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['task', 'note'],
          properties: { task: TASK_VIEW_SCHEMA, note: TEXT },
        },
        render: (_args, value: any) => [{ type: 'text', text: `${viewLine(value.task)}\n${value.note}` }],
      },
      execute: async (args: { id: string }, run) => {
        const task = service.resume(actorOf(run), args.id);
        return {
          task,
          note: '已经按原来的类型重新排上（attempt +1）。原来的进度与已完成产物都留着；'
            + '要盯它就用 studymate_task_status 或 studymate_task_wait。',
        };
      },
    },
  ];
}
