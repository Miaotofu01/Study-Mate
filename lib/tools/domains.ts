/* StudyMate · 工具域 —— 数据域词表的**转发处**（实现搬到了 `lib/lib/domains.ts`）

   「一个工具能碰哪些学习数据」是 Host 数据层的词表（`lib/lib/access.ts` 是它的执行点），
   所以它跟着 guard 一起搬。这个文件只做转发，新代码请直接 import `../lib/domains.ts`。 */
export * from '../lib/domains.ts';
