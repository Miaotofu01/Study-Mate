// 课件配图的取址。
//
// 内容文件里的 `::: figure ../assets/img/pool/x.png` 是相对 **lessons/ 目录**写的
// （见 docs/规范/课件内容格式.md §4），落在 <科目>/assets/ 下。浏览器不能直接读工作区，
// 所以由 Host 半按 <科目> + 相对路径取文件，路径必须先证明还在该科目目录里。
import fs from 'node:fs';
import path from 'node:path';

import { isWithin, isWithinReal, realPathOf } from './paths.ts';

const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif',
};

/** 科目目录的绝对路径。subject 里出现分隔符或 `..` 直接判不合法。 */
function subjectRoot(workspace: string, subject: unknown): string | null {
  if (typeof subject !== 'string' || !subject || subject.includes('/') || subject.includes('\\') || subject.includes('..')) return null;
  return path.resolve(workspace, '.learning', 'subjects', subject);
}

/**
 * 把 <科目> + 相对路径 解成一个可读的绝对路径；越界、不存在、不是文件都返回 null。
 * 解码交给调用方（查询串里的 path 已经 decode 过）。
 */
export function assetFile({ workspace, subject, rel }: { workspace: string; subject: unknown; rel: unknown }): string | null {
  const root = subjectRoot(workspace, subject);
  if (!root || typeof rel !== 'string' || !rel) return null;
  const full = path.resolve(root, rel);
  if (!isWithin(root, full)) return null;
  // 文本判据挡不住符号链接：解掉链接后还得落在科目目录里，否则取址就是一条越界的读盘口子
  // （边界给的是**科目目录**：科目目录自己挂成符号链接是用户自己的布置，真实工作区里合法；
  //   越界指的是目标逃出了科目目录——目标态规格 §4.3）
  if (!isWithinReal(realPathOf(root), full)) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return full;
}

export function contentTypeOf(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}
