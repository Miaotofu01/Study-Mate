/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 问答域 —— 共享记忆（`.learning/MEMORY.md`）的读法

   为什么单独一个文件：这份「共享记忆在哪、读不到算什么」的判据与建会话那条路由分开放——
   路由只管「会话怎么建、标题怎么写」，记忆的落点与缺省值单独一件事，套件也各自钉各自的那一半。
   #107 之后它只有一个消费方（`lib/ask/session.ts`：开张时注入一条），但仍然不并回去：
   记忆的读法掺进建会话的流程里，读不到与建不成就会被写成同一类失败。

   读不到**不是错误**：没有共享记忆的新工作区照样能问、能答。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

/** 真宿主里的共享记忆：`.learning/MEMORY.md`；读不到就是空（不是错误）。 */
export function readMemoryFromWorkspace(workspace: string): string {
  try {
    return fs.readFileSync(path.resolve(workspace, '.learning', 'MEMORY.md'), 'utf8');
  } catch {
    return '';
  }
}
