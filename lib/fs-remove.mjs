import fs from 'node:fs';
import path from 'node:path';

/**
 * 删掉一棵目录树（或单个文件）。目标不存在时静默返回。
 *
 * 为什么不用 `fs.rmSync(target, { recursive: true, force: true })`：
 * 在 Node 24 + Windows + 路径含中文（或其它非 ASCII 字符）时，同步递归删除会把整个进程
 * 打成 `0xC0000005`（同机 Node 22 不复现；异步 `fs.rm` 与手工 unlink/rmdir 都不崩）。
 * 中文用户名下安装器会因此在「清理暂存目录」这一步静默失败。
 */
export function removeTreeSync(target) {
  let stat;
  try {
    stat = fs.lstatSync(target, { throwIfNoEntry: false });
  } catch {
    return;
  }
  if (!stat) return;
  if (!stat.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) removeTreeSync(child);
    else fs.unlinkSync(child);
  }
  fs.rmdirSync(target);
}
