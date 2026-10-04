/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— `studymate_export`（把学习工作区导成离线页面）

   #68 留的占位在这里落地（#82）。三件事的落点，改之前先读：

     · **跑法是任务**：导出登记成任务类型「导出」（`lib/export/task.ts`），工具起一个
       `durable: true` 的任务，然后**有上限地等**（30 秒）——等到就返回文件清单（目标态
       规格 §3.1 说 export 返回「导出的文件清单」），等不到就返回句柄与下一步提示，
       让模型用 `studymate_task_*` 那几个工具接着盯。状态查询从不阻塞这条规矩没被破坏：
       阻塞的只有这一次有上限的等待。
     · **DSH 侧不主动导出**：这里没有任何自动触发——不注册定时器、不在别的工具里顺带跑。
       只有模型（学生说「导出一份能离线看的」）或显式调用才会起这个任务。
     · **越权声明**：读域列的是「整份阅读端快照要读到的东西」（`readLibrary()` 一份就全读了，
       声明逐个列出来是为了让「这个工具能碰什么」是**可读**的，与 #68 的验收口径一致）；
       写域是导出产物的布局（`lib/export/plan.ts` 里那份清单），落盘判据在导出域的
       `writeUnder` 里（任务跑起来之后才写盘，那时工具的调用帧未必还在，所以判据不能只挂在
       `access.write` 上——这条偏差记在报告里）。
   ───────────────────────────────────────────────────────────────────────── */

import path from 'node:path';

import { DEFAULT_WAIT_MS, TASK_STATUSES, actorOf, taskService } from '../tasks/index.ts';
import type { TaskView } from '../tasks/index.ts';
import {
  EXPORT_KIND, OUT_DIR_NAME, checkExport, readExportDir,
} from '../export/index.ts';
import type { ExportTaskResult } from '../export/index.ts';
import type { WorkspaceFacts } from '../host/vault.ts';
import type { StudyRun, StudyToolSpec } from './define.ts';

const TEXT = { type: 'string' } as const;
const INTEGER = { type: 'integer' } as const;
const STRINGS = { type: 'array', items: TEXT } as const;

/** 产物布局 = 工具的写域声明（与 `lib/export/plan.ts` 里生成的那份逐条对应）。 */
export const EXPORT_WRITE_PATTERNS = [
  'index.html', 'data.js', 'host.js', 'boot.js', 'studymate-client.js', 'export.json',
  'vendor/**', 'assets/**',
] as const;

/** 等一次的上限：够导一份课件，又不至于把工具调用挂住（与任务域的默认值同一个量级）。 */
export const EXPORT_WAIT_MS = DEFAULT_WAIT_MS;

const SUBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'name', 'nodes', 'assets'],
  properties: { slug: TEXT, name: TEXT, nodes: INTEGER, assets: INTEGER },
};

export function exportTool(): StudyToolSpec {
  return {
    name: 'studymate_export',
    description: '把学习工作区导成能离线打开的自包含页面（后台任务：可查状态、可取消）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subject: { type: 'string', description: '只导这一门科目（slug）；省略就是全部科目。' },
      },
    },
    reads: ['workspace', 'memory', 'subjects', 'curriculum', 'progress', 'lessons', 'pool', 'assets', 'records', 'reference', 'misconceptions'],
    writes: { export: [...EXPORT_WRITE_PATTERNS] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'status', 'settled', 'out', 'files', 'count', 'subjects', 'summary', 'next', 'note', 'problems'],
        properties: {
          taskId: TEXT,
          status: { type: 'string', enum: TASK_STATUSES },
          settled: { type: 'boolean' },
          out: TEXT,
          files: STRINGS,
          count: INTEGER,
          bytes: INTEGER,
          subjects: { type: 'array', items: SUBJECT_SCHEMA },
          summary: TEXT,
          /** 没结束时：下一步怎么盯它。结束了是空串。 */
          next: TEXT,
          note: TEXT,
          /** 泄漏守卫在这一份产物上发现的问题（不该有；有就是导出器漏了 Node 专用东西）。 */
          problems: STRINGS,
        },
      },
      render: (_args, value: any) => {
        const head = `导出任务 ${value.taskId}（${value.status}）`;
        if (!value.settled) {
          return [{ type: 'text', text: `${head}还在跑。${value.note}\n${value.next}` }];
        }
        if (value.status !== '完成') {
          return [{ type: 'text', text: `${head}：${value.summary || value.note}` }];
        }
        const problems = (value.problems as string[]).length > 0
          ? `\n⚠ 泄漏守卫有 ${value.problems.length} 条问题：${(value.problems as string[]).slice(0, 3).join('；')}`
          : '';
        return [{
          type: 'text',
          text: `${head}：${value.summary}\n导出目录：${value.out}（入口 index.html，${value.count} 个文件）`
            + `\n离线打开：用浏览器打开 ${path.join(String(value.out), 'index.html')}，或者直接双击它。`
            + problems,
        }];
      },
    },
    execute: async (args: { subject?: string }, run: StudyRun) => {
      const workspace = run.access.read<WorkspaceFacts>('workspace');
      if (!workspace.ready) {
        throw new Error(`工作区还没准备好：${workspace.path || '（配置里没有 workspace）'} 里没有 .learning/subjects/。`
          + '先建课（或者修一下 ~/.dsh/studymate-config.yaml 的 workspace）再导出。');
      }
      const subject = typeof args.subject === 'string' && args.subject.trim() !== '' ? args.subject.trim() : '';
      const subjects = subject === '' ? [] : [subject];
      const out = path.join(workspace.path, OUT_DIR_NAME);
      const actor = actorOf(run);
      const service = taskService();
      const handle = service.start(actor, {
        kind: EXPORT_KIND,
        label: subject === '' ? '导出整个学习工作区' : `导出科目 ${subject}`,
        durable: true,
        input: { workspace: workspace.path, ...subjects.length === 0 ? {} : { subjects } },
      });

      const waited = await service.wait(actor, handle, {
        timeoutMs: EXPORT_WAIT_MS,
        ...run.signal === undefined ? {} : { signal: run.signal },
      });
      const view: TaskView = waited.task;
      const result = (view.receipt?.result ?? null) as ExportTaskResult | null;

      if (!waited.settled) {
        return {
          taskId: view.id,
          status: view.status,
          settled: false,
          out,
          files: [],
          count: 0,
          bytes: 0,
          subjects: [],
          summary: '',
          next: waited.next,
          note: `导出还在跑（任务 ${view.id}，落盘记录在，重开 DSH 也接得上）。`,
          problems: [],
        };
      }

      const files = result?.files ?? [];
      // 产物落地之后自己扫一遍泄漏（F11）：导出器把 Node 专用东西漏进页面时，
      // 学生看到的是一张打不开的页面，而这里能当场说出来。
      const guard = files.length === 0
        ? { violations: [], manifestProblems: [] }
        : checkExportProducts(result?.out ?? out, [workspace.path, result?.out ?? out]);
      return {
        taskId: view.id,
        status: view.status,
        settled: true,
        out: result?.out ?? out,
        files,
        count: files.length,
        bytes: result?.bytes ?? 0,
        subjects: result?.subjects ?? [],
        summary: view.receipt?.summary ?? '',
        next: '',
        note: view.status === '完成'
          ? '这一份是自包含的：样式、公式、图片、题目都在导出的目录里，不联网也能看。'
          : `任务终态是「${view.status}」：${view.detail ?? ''}`,
        problems: [...guard.violations.map((violation) => `${violation.path}:${violation.line} [${violation.rule}] ${violation.what}`),
          ...guard.manifestProblems],
      };
    },
  };
}

/** 读回导出目录再过一遍守卫（工具返回值的 `problems` 就是它的结论）。 */
function checkExportProducts(
  out: string,
  machinePaths: readonly string[],
): { violations: { path: string; line: number; rule: string; what: string }[]; manifestProblems: string[] } {
  const { files, manifest } = readExportDir(out);
  const report = checkExport(files, manifest, { machinePaths });
  return { violations: report.violations, manifestProblems: report.manifestProblems };
}
