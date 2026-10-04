/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 实验域 —— 跑过的记录（进程活着时在内存，同时落一份到盘上）

   两个消费方，诉求不同：

     · `studymate_task_status` / `wait` 那一侧要的是**事实**（这次真跑了什么），任务域的
       `TaskView.receipt` 只放得下一句摘要——摘要说不清退出码与那 200 行报错原文。
     · 作答数据的**回填**要的是同一份事实：这次跑的退出码、时长、stdout/stderr 原文。

   所以事实放在这里，键是任务 id。**同时落一份盘**（`<DSH_HOME>/studymate/lab-runs/<id>.json`）
   的理由与任务域的 durable 同源：长命令可能跑得比一次工具调用长得多，DSH 重启之后
   「上次那条到底跑出什么了」不该只有一个「被打断」的空壳。落盘失败只记一行问题，不影响跑。

   台账**只增不改语义**：`跑` 一旦写进去就是既成事实（命令已经跑过了，输出不可能回滚）。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

import type { RunFacts } from './runner.ts';

/** 一条账：任务 id → 那次跑的事实。 */
export interface RunEntry {
  /** 任务 id（`lab-1` 这种）。 */
  taskId: string;
  /** 科目 slug 与节点 id：回填作答数据要用，也是人复核时的定位。 */
  subject: string;
  node: string;
  /** 题 id（`<锚点文本>#<题号>`）。 */
  question: string;
  /** 那条命令是从哪来的（`题目里的 <字段>`），写进账里好回答「谁声明的命令」。 */
  commandFrom: string;
  /** 跑的事实；还没跑完时是 null。 */
  facts: RunFacts | null;
  /** 已经写进作答数据了（写成功那一刻置位）——重放 / 重试据此判断要不要再写一次。 */
  written: boolean;
  /** 写作答数据遇到的事（成功时是空串）。 */
  writeNote: string;
  at: string;
}

export interface RunLedger {
  dir: string;
  put(entry: RunEntry): void;
  get(taskId: string): RunEntry | null;
  /** 落盘收尾（写失败只记一行，不抛）。 */
  flush(): void;
  /** 读盘 / 写盘遇到的问题。 */
  problems(): string[];
}

/** 台账目录：与任务域同一层（`<DSH_HOME>/studymate/`），掉一个都还能一眼找到另一个。 */
export function labRunsDir(home?: string): string {
  const base = home ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh');
  return path.join(base, 'studymate', 'lab-runs');
}

export function createRunLedger(options: { dir?: string } = {}): RunLedger {
  const dir = options.dir ?? labRunsDir();
  const entries = new Map<string, RunEntry>();
  const problems: string[] = [];

  return {
    dir,

    put(entry) {
      entries.set(entry.taskId, entry);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${entry.taskId}.json`),
          `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
      } catch (error) {
        problems.push(`跑过的记录 ${entry.taskId} 写不进 ${dir}：${error instanceof Error ? error.message : String(error)}`);
      }
    },

    get(taskId) {
      return entries.get(taskId) ?? null;
    },

    flush() {
      // put 每次都同步写，这里没有排队的活；留着这个方法是让调用方的收尾有一处可写。
    },

    problems: () => [...problems],
  };
}

let singleton: RunLedger | undefined;

/** 进程里唯一的那一份台账（与任务域同一个姿势：谁先来谁建）。 */
export function runLedger(): RunLedger {
  if (!singleton) singleton = createRunLedger();
  return singleton;
}

/** 丢掉单例（测试用；换 `DSH_HOME` 之后要重新落盘就得先丢）。 */
export function resetRunLedger(): void {
  singleton = undefined;
}
