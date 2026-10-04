// 课件配图的取址。
//
// 内容文件里的 `::: figure ../assets/img/pool/x.png` 是相对 **lessons/ 目录**写的
// （见 docs/规范/课件内容格式.md §4），落在 <科目>/assets/ 下。浏览器不能直接读工作区，
// 所以由 Host 半按 <科目> + 相对路径取文件，路径必须先证明还在该科目目录里。
import fs from 'node:fs';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif',
};

/** 科目目录的绝对路径。subject 里出现分隔符或 `..` 直接判不合法。 */
function subjectRoot(workspace: string, subject: unknown): string | null {
  if (typeof subject !== 'string' || !subject || subject.includes('/') || subject.includes('\\') || subject.includes('..')) return null;
  return path.resolve(workspace, '.learning', 'subjects', subject);
}

/** 越界判据：前后都补分隔符再比，避免 /a/bc 被当成在 /a/b 里面。 */
function inside(root: string, full: string): boolean {
  return full === root || full.startsWith(root + path.sep);
}

/**
 * 目标（或其最近存在的祖先）解掉符号链接之后的真实路径；解不出来返回 null。
 * 断链与不存在的目标都走这条路——调用方按「取不到」处理，不让 realpath 的异常冒成 500。
 */
function realPathOf(target: string): string | null {
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
 * 真实路径判据：target 解掉符号链接之后必须还在 realRoot（已解过链接的边界）里。
 * 边界给的是**科目目录**：科目目录自己挂成符号链接是用户自己的布置（真实工作区里合法），
 * 越界指的是目标逃出了科目目录（目标态规格 §4.3）。边界算不出来时一律判越界。
 */
function insideReal(realRoot: string | null, target: string): boolean {
  if (typeof realRoot !== 'string' || realRoot === '') return false;
  const realTarget = realPathOf(target);
  return realTarget !== null && inside(realRoot, realTarget);
}

/**
 * 把 <科目> + 相对路径 解成一个可读的绝对路径；越界、不存在、不是文件都返回 null。
 * 解码交给调用方（查询串里的 path 已经 decode 过）。
 */
export function assetFile({ workspace, subject, rel }: { workspace: string; subject: unknown; rel: unknown }): string | null {
  const root = subjectRoot(workspace, subject);
  if (!root || typeof rel !== 'string' || !rel) return null;
  const full = path.resolve(root, rel);
  if (!inside(root, full)) return null;
  // 文本判据挡不住符号链接：解掉链接后还得落在科目目录里，否则取址就是一条越界的读盘口子
  if (!insideReal(realPathOf(root), full)) return null;
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
