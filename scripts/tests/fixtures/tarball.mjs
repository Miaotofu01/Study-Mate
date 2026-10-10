/* 解一个 `.tar.gz` —— 只做到「够用」：`npm pack` 产出的归档里全是 ustar 短名条目，
   普通文件与目录两种，没有长名/PAX/稀疏文件那些花样。

   为什么自己写而不是继续用 Python 的 `tarfile`：本仓已经没有 Python 了（ADR-0002；
   `CONTRIBUTING.md` 那句「**没有 Python 了**」）。`test_dsh_plugin_cli.mjs` 当年靠
   `python -c 'import tarfile…'` 解包，于是 `findPython` 一被删（`dceeb31`「安装器不再探测
   Python」）那一套就**在模块载入阶段**炸掉，而它只挂在按需入口上，几周没人发现。

   为什么不用系统 `tar`：那是一个新的系统依赖（Windows 上还得另说），而这条套件已经要
   pnpm 了；Node 自带的 `node:zlib` 就够，且不引入任何东西。

   落点是 `fixtures/`：`checks.mjs` 的套件遍历遇到 `fixtures` 目录会跳过，所以这里是
   「共用支持模块」的位置，不是套件。
   详见 [测试说明](../README.md) 与 `docs/adr/0002-引擎改用TypeScript.md`。 */
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

/** tar 头里的字段是「NUL 结尾的定长字符串」；没写满时也可能用空格收尾（八进制数字就是）。 */
function text(block, from, length) {
  const raw = block.subarray(from, from + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8').replaceAll('\0', '');
}

/**
 * 把 `archive` 解到 `destination`，返回解出来的普通文件绝对路径（目录不在内）。
 * 只认三种条目：目录（`5`）、普通文件（`0`/`\0`）；其余一律跳过并把大小算准——
 * 算错会让后面每一个条目都错位，所以宁可跳过内容也不能跳错偏移。
 */
export function extractTarGz(archive, destination) {
  const buffer = gunzipSync(fs.readFileSync(archive));
  const files = [];
  for (let offset = 0; offset + BLOCK <= buffer.length;) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) break;   // 归档以两个空块收尾，第一个就够停
    const name = text(header, 0, 100);
    const prefix = text(header, 345, 155);
    const size = Number.parseInt(text(header, 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(header[156] || 0x30);
    const target = path.join(destination, prefix ? `${prefix}/${name}` : name);
    offset += BLOCK;
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else if (type === '0' || type === '\0') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer.subarray(offset, offset + size));
      files.push(target);
    }
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
