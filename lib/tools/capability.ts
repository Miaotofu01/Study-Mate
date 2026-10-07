/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— 模型能力探测（**转发**给纯函数域那一份）

   判据本体搬去了 `lib/core/model.ts`：#79 的问答面板要用同一个 `{available:false, reason}`，
   而域规则表里子系统不许 import 工具域（`lib/tools/index.ts` 的文件头：方向只有「工具域 →
   子系统」一条）。两份探测迟早会漂成两个 `reason` 文案，面板与工具就会对同一个组合给出
   不同的说法——所以上移到纯函数域，工具域只留这个转发面，`lib/tools/context.ts` 与
   `lib/tools/define.ts` 的 import 一个字都不用改。

   为什么不把问答域写成 import 本文件：那是**反向边**，
   `scripts/tests/test_architecture_boundaries.mjs` 的域规则表会直接红。
   ───────────────────────────────────────────────────────────────────────── */

export { probeModel, unmetRequirement } from '../core/model.ts';
export type { ModelCapability, Requirement, ServiceReader } from '../core/model.ts';
