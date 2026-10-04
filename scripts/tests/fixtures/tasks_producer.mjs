/* 夹具：**进程 A** —— 起一个 durable 任务、把进度与产物落盘，然后按场景收场。
   ────────────────────────────────────────────────────────────────────────
   这是 `test_tasks_model.mjs` 的跨进程那一节用的另一半：父测试 spawn 本文件（真·另一个进程），
   它退出之后父进程用同一个台账目录**重新加载**，验「关掉 DSH 再开，落盘的关键任务接得上」。
   所以这里必须是**真进程边界**（spawn），不能退化成「同一个进程里 new 两次服务」。

   用法：
     node tasks_producer.mjs <lib/tasks 入口的绝对路径> <台账目录> <mid-flight|done>

   两个场景：
     · mid-flight —— 进度与产物都落盘了，但执行还停在「运行」时**硬退出**（模拟关掉 DSH）。
       重开之后应当读到一条「失败 + interrupted」的记录：能查、能 resume 接着跑、能 destroy 收尾。
     · done —— 正常跑完，验「完成」这种结局也活得比进程久（回执从盘上重新派生得出来）。
   ──────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , modulePath, taskDir, scenario] = process.argv;
if (!modulePath || !taskDir) {
  process.stderr.write('用法：node tasks_producer.mjs <lib/tasks/index.ts> <台账目录> <mid-flight|done>\n');
  process.exit(2);
}

const tasks = await import(pathToFileURL(modulePath).href);
const service = tasks.createTaskService({ dir: taskDir });
const artifacts = path.join(taskDir, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const first = path.join(artifacts, 'first.txt');
const second = path.join(artifacts, 'second.txt');

service.registerKind(tasks.defineTaskKind({
  kind: '导出',
  prefix: 'export',
  async run(job) {
    job.progress('1/2 写第一份', { done: 1, total: 2 });
    fs.writeFileSync(first, '第一份写完了\n');
    job.artifact(first, '已完成');
    job.progress('2/2 写第二份', { done: 2, total: 2 });
    if (scenario === 'mid-flight') {
      fs.writeFileSync(second, '第二份写了一半\n');
      job.artifact(second, '进行中');
      service.flush(); // 进度是节流写的：硬退出之前显式刷一次，盘上才是「正在跑」的样子
      process.exit(0);
    }
    fs.writeFileSync(second, '第二份也写完了\n');
    job.artifact(second, '已完成');
    return { detail: '两份都写完', result: { files: [first, second] } };
  },
}));

// mid-flight 这一场景会在 start() 里同步跑到底然后 process.exit，所以回执照**先**写出去，
// 而且用 writeSync：process.exit 会截断还没冲掉的异步 stdout。
fs.writeSync(1, `${JSON.stringify({ started: { id: 'export-1', owner: 'session-A' }, scenario })}\n`);

service.start('session-A', {
  kind: '导出', label: '导出 demo 科目（跨进程夹具）', durable: true,
});
