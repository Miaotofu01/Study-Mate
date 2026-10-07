/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 数据层 —— **路径包含判据**（全仓唯一一份）

   判「这个路径在不在那个目录里」的地方一共有四处，原来各写一份、三种写法：

     · `lib/reference.ts` 与 `lib/assets.ts`（逐字节相同的两份）——前后补分隔符再比；
     · `lib/export/run.ts` —— `path.relative` 之后看是不是 `..` 开头；
     · `lib/lab/sandbox.ts` 的 `isWithin` —— 补分隔符，但先判 `root` 自己带不带分隔符。

   三种写法在正常输入上同解，但在边上不同解：`root` 自己带尾分隔符时「补分隔符」那份
   会把 `root` 本身判在外面，`path.relative` 那份不会。安全边界**最不该**有的就是「换一处
   调用就换一个答案」——所以收成一份，判据只此一条。

   为什么放在 `lib/`（域 `lib`）而不是 `lib/host/` 或 `lib/core/`：
     · `lib/core/**` 是纯函数域，一个 `node:*` 都不许 import，而这里要 `node:path` / `node:fs`；
     · 放 `lib/host/` 会让 `lib/*.ts`（reference / assets 都在域 `lib`）反向 import 域 `host`，
       而 `host` 自己要读 `lib` 的数据层——域图立刻成环（`test_architecture_boundaries.mjs` 会红）。
   四个调用点所在的域（`lib` / `export` / `lab`）本来就都允许 import `lib`，所以这里是唯一
   一个不新增任何跨域边、也不成环的落点。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 路径包含：`target` 在 `root` 之内（含相等）。
 *
 * **两侧都必须是绝对路径**（`path.resolve` / `path.join` 出来的那种）；本函数内部会先
 * 规范化，所以带尾分隔符、带 `.`/`..` 段也判得对——这正是选 `path.relative` 而不是
 * 「字符串前后补分隔符再 startsWith」的原因：后者在 `root` 带尾分隔符时会把 `root`
 * 自己判成越界，也会把 Windows 上大小写不同的同一条路径判成越界（那是**误拒**，不是更严）。
 *
 * 边界之外一律 false，包括不同盘符/根（`path.relative` 那时给回一个绝对路径）。
 */
export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * 目标（或其最近存在的祖先）解掉符号链接之后的真实路径；解不出来返回 null。
 *
 * 断链与不存在的目标都走这条路——调用方按「读不到」处理，不让 realpath 的异常冒成 500。
 * 逐级往上找祖先而不是直接 `realpathSync`：要判越界的往往正是**还不存在**的路径
 * （新建一份资料、写一个还没建的文件），那时只有祖先解得开。
 */
export function realPathOf(target: string): string | null {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null; // 走到根都不存在
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * 真实路径判据：`target` 解掉符号链接之后必须还在 `realRoot`（**已经解过链接**的边界）里。
 *
 * 文本判据挡不住符号链接：`<科目>/assets/` 里放一个指向 `~/.ssh` 的软链，`path.resolve`
 * 之后仍然「在科目目录里」。所以还要解一次真身再判。边界算不出来（`realRoot` 为空或
 * `null`）时一律判越界——宁可拒绝，也不要漏。
 */
export function isWithinReal(realRoot: string | null, target: string): boolean {
  if (typeof realRoot !== 'string' || realRoot === '') return false;
  const realTarget = realPathOf(target);
  return realTarget !== null && isWithin(realRoot, realTarget);
}
