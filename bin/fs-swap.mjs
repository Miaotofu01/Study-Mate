/* 把构建好的成品「挪到位」的唯一出处。
   ────────────────────────────────────────────────────────────────────────
   `fs.renameSync` 在同一卷里是原子的，这是首选。但 Windows 上目录改名会因为
   「目标已存在」或「源目录里有活着的句柄」直接给 EPERM（NTFS 语义，Win10/11 一样；
   Linux 的同名操作反而成功），而安装器和两个构建器都靠「临时目录 → 目标」这一步落盘。
   于是这里给一条退路：改名不成就退化成「清目标 + 复制 + 删源」——成品目录不大，
   慢一点但不会把安装 / 构建直接失败掉。 */

import fs from 'node:fs';
import { removeTreeSync } from '../lib/fs-remove.mjs';

/** 值得退化重试的失败码。ENOENT 不在此列：那是路径写错了，退化只会把真 bug 藏起来。 */
const FALLBACK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EXDEV', 'ENOTEMPTY', 'EEXIST']);

/**
 * 把 `from` 挪到 `to`。
 * @returns {'rename'|'copy'} 这次实际走了哪条路（只用于诊断 / 测试断言）
 */
export function moveIntoPlace(from, to) {
  try {
    fs.renameSync(from, to);
    return 'rename';
  } catch (error) {
    if (!FALLBACK_CODES.has(error?.code)) throw error;
    // 目标还在（Windows 不允许用 rename 顶掉一个已存在的目录）→ 先清干净再复制。
    // 清目录用 removeTreeSync 而不是 fs.rmSync：后者在 Node 24 + Windows + 非 ASCII 路径上
    // 会把进程直接打死（0xC0000005），详见 lib/fs-remove.mjs 的注释。
    removeTreeSync(to);
    // `filter` 不是为了过滤，是为了**绕开 Node 的 Windows 原生拷贝快路径**：不带 filter 时，
    // 目标路径只要含非 UTF-8 字符（中文用户名、带重音的目录名）就静默一个文件都不拷，
    // 偶尔还直接 0xC0000005 崩掉（nodejs/node#59636）。恒真的 filter 强制走 JS 实现。
    // 仓库里 `bin/studymate.mjs` 的 copyPayload 也是这么绕的，改的时候两处一起看。
    fs.cpSync(from, to, { recursive: true, force: true, filter: () => true });
    removeTreeSync(from);
    return 'copy';
  }
}
