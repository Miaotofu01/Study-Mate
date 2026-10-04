/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 构建期 —— 零依赖的确定性 ZIP 写入

   为什么自己写：两个无头宿主插件的构建（`bin/openai-plugin.mjs`、
   `bin/antigravity-plugin.mjs`）都要打一个 ZIP 出来。这条以前借 Python 的 `zipfile`
   完成，Python 随 #83 退役，而**不能为此引一个运行时依赖**——这个包是零依赖的，
   构建器也不该把依赖图撑开。

   “确定性”是硬要求：同样的输入必须产出**逐字节相同**的归档（测试会重建一次比对），
   所以时间戳固定、条目顺序按路径排序、压缩参数固定（deflateRawSync 默认档）。

   形状对齐 Python 侧原来那份（`zipfile.ZipInfo` + `date_time=(2020,1,1,0,0,0)` +
   `external_attr=0o100644 << 16`）：DOS 时间 0、DOS 日期 0x2821（2020-01-01）、
   文件权限 0644。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

/** 2020-01-01 00:00:00 的 DOS 日期（年 - 1980 左移 9 | 月左移 5 | 日）。 */
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
/** 0644 的档位放在 external attributes 的高 16 位。**不能写 `<< 16`**：0o100644 << 16 在
    JS 里是带符号的 int32，会变成负数，writeUInt32LE 直接抛。 */
const MODE_0644 = 0o100644 * 65536;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** 目录下所有普通文件，按相对路径排序（与 Python 的 `sorted(root.rglob('*'))` 同序）。 */
export function listFiles(root, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = path.join(root, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listFiles(file, name));
    else if (entry.isFile()) found.push({ name, file });
  }
  return found;
}

/**
 * 把一个目录打成 ZIP。条目名以**父目录**为根（`<dir>` 是 `.../studymate` 时，
 * 归档里第一条是 `studymate/...`），与原来 Python 侧的 `relative_to(root.parent)` 一致。
 */
export function writeZip(directory, output) {
  const rootName = path.basename(directory);
  const entries = listFiles(directory).map(({ name, file }) => {
    const data = fs.readFileSync(file);
    return { name: `${rootName}/${name}`, data, compressed: deflateRawSync(data) };
  });

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    // Python 只在名字不是 ASCII 时才置 UTF-8 标记位；跟着走，字节才与原来一致。
    const flags = /^[\x20-\x7e]*$/.test(entry.name) ? 0 : 0x800;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);          // extra length
    chunks.push(local, name, entry.compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x031e, 4);     // version made by: UNIX + 3.0
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(entry.compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);         // extra
    header.writeUInt16LE(0, 32);         // comment
    header.writeUInt16LE(0, 34);         // disk number
    header.writeUInt16LE(0, 36);         // internal attributes
    header.writeUInt32LE(MODE_0644, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + entry.compressed.length;
  }

  const directory_ = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory_.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(output, Buffer.concat([...chunks, directory_, end]));
}
