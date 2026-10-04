/* 夹具：一个**独立于写入端**的最小 ZIP 读取器。

   为什么测试里要自己解一份：两个插件构建器现在用 `bin/zip.mjs` 打 ZIP，若测试拿同一个
   模块去读回来，等于自己证明自己——归档坏在「中央目录偏移」这类地方时两边一起错。
   这里按 ZIP 的格式从**尾部**（EOCD）往回读：从中央目录取条目清单与偏移，再按偏移取
   本地头与数据，最后 inflate。写入端换了实现，这里照样能读才算数。

   （Python 时代这一半由 `python -m zipfile -e` 担当，Python 退场后由它顶上。） */
import fs from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/** 找出中央目录末尾记录（EOCD）的位置：签名 0x06054b50，从尾部往前扫。 */
function endOfCentralDirectory(buffer) {
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('不是一份 ZIP：找不到中央目录末尾记录');
}

/** 列出归档里的条目名（按归档顺序）。 */
export function zipEntries(file) {
  const buffer = fs.readFileSync(file);
  const end = endOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录头签名不对');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** 读出全部条目：`{ 条目名: Buffer }`。 */
export function readZip(file) {
  const buffer = fs.readFileSync(file);
  const end = endOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录头签名不对');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`本地头签名不对：${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressedSize);
    files[name] = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** 把归档解到一个目录里（条目名里的 `/` 建目录）。 */
export function extractZip(file, directory) {
  const files = readZip(file);
  for (const [name, data] of Object.entries(files)) {
    const target = `${directory}/${name}`;
    fs.mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
    fs.writeFileSync(target, data);
  }
  return files;
}
