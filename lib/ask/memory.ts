/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 问答域 —— 共享记忆（`.learning/MEMORY.md`）的读法

   为什么单独一个文件：这份「共享记忆在哪、读不到算什么」的判据今天有两个消费方——
   `/ask` 那条旧路由（拼请求体）与「建答疑会话」那条新路由（开张时注入一条）。两个模块
   互相 import 会成环（`test_architecture_boundaries.mjs` 的模块级环检测会红），所以判据
   放这里、两边都往下依赖它。

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
