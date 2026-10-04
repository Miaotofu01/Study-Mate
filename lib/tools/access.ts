/* StudyMate · 工具域 —— 域 guard 的**转发处**（实现搬到了 `lib/lib/access.ts`）

   为什么搬：`lib/lab/route.ts`（学生按「跑一次」那条路由）要用同一个 guard 造 access，
   而域规则表（`scripts/tests/test_architecture_boundaries.mjs`）里**实验域不许 import 工具域**
   ——tools → lab 是注册点那条边，反过去就是成环。guard 与工作区 vault 本来就是「Host 数据层」
   的东西（它们只回答「能不能碰这份数据」与「数据是什么」），搬进 `lib` 域之后两边都能用，
   域图上只剩 tools → lib 与 lab → lib 两条向下的边。

   这个文件**只做转发**：`lib/tools/**` 里现存的 `from './access.ts'` 一行都不用改，
   `lib/tools/index.ts` 的对外导出也一字不变（`export { createAccess, … } from './access.ts'`）。
   新代码请直接 import `../lib/access.ts`。 */
export * from '../lib/access.ts';
