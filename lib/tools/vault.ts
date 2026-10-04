/* StudyMate · 工具域 —— 域数据读法的**转发处**（实现搬到了 `lib/host/vault.ts`）

   与 `access.ts` 同一件事、同一个理由（见那份文件头）：实验域的 Web 路由要用同一套读法，
   而实验域不许 import 工具域。这个文件只做转发，`lib/tools/**` 里的 `from './vault.ts'`
   一行都不用改。新代码请直接 import `../host/vault.ts`。 */
export * from '../host/vault.ts';
