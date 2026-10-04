/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 任务域 —— 落盘（durable 任务的那一半）

   落点：`<DSH_HOME>/studymate/tasks/<id>.json`，**一个任务一个文件**。

   为什么是这里：
     · 任务状态是**插件私有**数据（不是学习数据），所以不进学习工作区、不污染学生的交付物目录
       （阅读端只写 `reference/` 与 `attempts/` 那条规矩是给学习数据立的，别把状态塞进去）。
     · 跟着 `DSH_HOME` 走，跨进程重开就找得到同一份台账（ticket 的「关掉 DSH 再开能接上」）。
     · 装机路径改造（#70）之后 `~/.dsh/studymate/engine/` 不再有源码树拷贝，这个目录从此只放
       插件自己的状态。**只在真的起了 durable 任务时才创建**——不读不写、不安装就建目录，
       安装器的「没有 ~/.dsh/studymate」断言才不会被顺手打破。
     · 一个任务一个文件：坏掉一份不影响别的；人是可以直接打开看的（故意写成缩进 JSON）。

   为什么原子写（临时文件 + rename）：`renameSync` 在同一文件系统里是原子的，重开时读到的
   要么是旧的一份完整记录、要么是新的一份，不会读到写了一半的半个 JSON。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from '../workspace.ts';
import { isTaskStatus, isTerminal } from './state.ts';
import type { TaskArtifact, TaskProgress, TaskRecord } from './record.ts';

/** 任务台账目录。`DSH_HOME` 每次现读（测试会把 HOME 指到临时目录，缓存住就串了）。 */
export function tasksDir(home: string = dshHome()): string {
  return path.join(home, 'studymate', 'tasks');
}

export function taskFile(id: string, home?: string): string {
  return path.join(tasksDir(home), `${id}.json`);
}

/* ── 读回来时按字段收窄：盘上的文件可能是人手改过的，不许让一个坏字段把整个服务带崩 ── */

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function artifactsOf(value: unknown): TaskArtifact[] {
  if (!Array.isArray(value)) return [];
  const out: TaskArtifact[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.path !== 'string' || record.path === '') continue;
    out.push({ path: record.path, state: record.state === '已完成' ? '已完成' : '进行中' });
  }
  return out;
}

function progressOf(value: unknown): TaskProgress | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.line !== 'string') return null;
  const done = num(record.done);
  const total = num(record.total);
  return {
    line: record.line,
    ...done === undefined ? {} : { done },
    ...total === undefined ? {} : { total },
  };
}

/** 一份文件 → 一条记录；形状不对就返回一句问题（调用方收进 problems，不是抛）。 */
export function parseRecord(text: string, file: string): { record: TaskRecord } | { problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { problem: `${file} 不是合法 JSON：${(error as Error).message}（这份记录先跳过，文件没动）` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { problem: `${file} 的顶层不是对象（这份记录先跳过，文件没动）` };
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || value.id === '') return { problem: `${file} 没有 id（先跳过）` };
  if (!isTaskStatus(value.status)) return { problem: `${file} 的状态「${String(value.status)}」不在六态里（先跳过）` };
  const record: TaskRecord = {
    version: 1,
    id: value.id,
    kind: str(value.kind, '未知任务'),
    prefix: str(value.prefix, value.id.replace(/-\d+$/, '') || 'task'),
    label: str(value.label, value.id),
    owner: str(value.owner, '本机') || '本机',
    durable: value.durable !== false,
    status: value.status,
    attempt: Math.max(1, Math.floor(num(value.attempt) ?? 1)),
    progress: progressOf(value.progress),
    artifacts: artifactsOf(value.artifacts),
    input: (value.input ?? null) as TaskRecord['input'],
    createdAt: str(value.createdAt, new Date(0).toISOString()),
    updatedAt: str(value.updatedAt, str(value.createdAt, new Date(0).toISOString())),
    settledAt: typeof value.settledAt === 'string' ? value.settledAt : null,
    detail: typeof value.detail === 'string' ? value.detail : null,
    result: (value.result ?? null) as TaskRecord['result'],
    interrupted: value.interrupted === true,
    cancelReason: typeof value.cancelReason === 'string' ? value.cancelReason : null,
  };
  return { record };
}

export interface TaskStore {
  readonly dir: string;
  fileOf(id: string): string;
  /** 读回全部落盘记录；坏文件收进 problems，不抛。 */
  load(): { records: TaskRecord[]; problems: string[] };
  save(record: TaskRecord): void;
  /** 删掉一个任务的记录文件（**调用方负责先给回执**）。返回删掉的文件路径。 */
  remove(id: string): string[];
  exists(id: string): boolean;
}

export function createTaskStore(options: { home?: string; dir?: string } = {}): TaskStore {
  const dir = options.dir ?? tasksDir(options.home);
  let counter = 0;
  const fileOf = (id: string): string => path.join(dir, `${id}.json`);
  return {
    dir,
    fileOf,
    load(): { records: TaskRecord[]; problems: string[] } {
      const records: TaskRecord[] = [];
      const problems: string[] = [];
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        // 目录还不存在 = 一个 durable 任务都没起过。这不是错误，也不建目录。
        return { records, problems };
      }
      for (const entry of entries.sort()) {
        if (!entry.endsWith('.json')) continue;
        const file = path.join(dir, entry);
        let text: string;
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch (error) {
          problems.push(`${file} 读不了：${(error as Error).message}`);
          continue;
        }
        const parsed = parseRecord(text, file);
        if ('problem' in parsed) {
          problems.push(parsed.problem);
          continue;
        }
        records.push(parsed.record);
      }
      return { records, problems };
    },
    save(record: TaskRecord): void {
      fs.mkdirSync(dir, { recursive: true });
      const file = fileOf(record.id);
      const temporary = `${file}.${process.pid}.${counter += 1}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
      fs.renameSync(temporary, file);
    },
    remove(id: string): string[] {
      const file = fileOf(id);
      const removed: string[] = [];
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        removed.push(file);
      }
      return removed;
    },
    exists(id: string): boolean {
      return fs.existsSync(fileOf(id));
    },
  };
}

/** 重启打断的判定：盘上还写着活着的状态，说明那一轮的进程没了。 */
export function wasInterrupted(status: TaskRecord['status']): boolean {
  return !isTerminal(status);
}
