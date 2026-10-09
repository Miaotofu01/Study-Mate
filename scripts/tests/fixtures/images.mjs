/* 现造的最小图片字节（#132）：只到「文件头够解析出格式与宽高」为止，**不引入图像库**。
   ────────────────────────────────────────────────────────────────────────
   为什么不用真图：图片库校验器**不解码**（规格明文：纯标准库、不联网、不看像素），它只需要
   文件头那几个字节。所以这里造的是**结构合法的头**——PNG 的 IHDR 块带真 CRC、JPEG 是一个
   真的 SOF0 段、GIF 是 `GIF89a` + 逻辑屏描述符、WebP 是 `RIFF….WEBP` + 一个真块头。

   夹具目录被 `scripts/release/checks.mjs` 的套件遍历显式跳过（它是夹具，不是套件）。 */

/** PNG 的 CRC-32（多项式 0xEDB88320，与 zlib 同一个）。IHDR 块带上真 CRC 才算结构合法。 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head, payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([body, crc]);
}

/** PNG：签名 + IHDR（宽高在这里）+ IEND。没有 IDAT——校验器不看像素。 */
export function pngBytes(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型：RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** GIF：`GIF89a` + 逻辑屏描述符（宽高各 2 字节小端）+ 尾字节。 */
export function gifBytes(width, height) {
  const bytes = Buffer.alloc(13);
  bytes.write('GIF89a', 0, 'ascii');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  bytes[12] = 0x3b;   // trailer
  return bytes;
}

/** JPEG：`FF D8` + 一个 SOF0 段（高在前、宽在后）+ `FF D9`。 */
export function jpegBytes(width, height) {
  const segment = Buffer.alloc(13);
  segment[0] = 0xff;
  segment[1] = 0xc0;
  segment.writeUInt16BE(11, 2);       // 段长 = 2 + 负载 9
  segment[4] = 8;                     // 精度
  segment.writeUInt16BE(height, 5);
  segment.writeUInt16BE(width, 7);
  segment[9] = 1;                     // 分量数
  segment[10] = 1;
  segment[11] = 0x11;
  segment[12] = 0;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment, Buffer.from([0xff, 0xd9])]);
}

function riffWebp(fourcc, payload) {
  const chunk = Buffer.alloc(8);
  chunk.write(fourcc, 0, 'ascii');
  chunk.writeUInt32LE(payload.length, 4);
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunk, payload]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/** WebP 无损（`VP8L`）：0x2F 签名 + 14 位宽-1、14 位高-1。 */
export function webpBytes(width, height) {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE((((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)) >>> 0, 1);
  return riffWebp('VP8L', payload);
}

/** WebP 有损（`VP8 `）：帧标签 3 字节 + 起始码 9D 01 2A + 宽高各 2 字节小端。 */
export function webpLossyBytes(width, height) {
  // 14 字节负载：真块后面还有压缩数据，这里只补够解析器要读到的长度。
  const payload = Buffer.alloc(14);
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return riffWebp('VP8 ', payload);
}

/** WebP 扩展（`VP8X`）：4 字节标志 + 画布宽-1、高-1（各 3 字节小端）。 */
export function webpExtendedBytes(width, height) {
  const payload = Buffer.alloc(14);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return riffWebp('VP8X', payload);
}

/** 一张「不是图」的东西：下载失败时常见的 HTML 错误页（存成 `.png` 就是这个）。 */
export function htmlBytes() {
  return Buffer.from('<!DOCTYPE html><html><body>404 Not Found</body></html>', 'utf8');
}

/** 只有前几个字节的半个头：认不出，也不该抛。 */
export function truncatedBytes(length = 3) {
  return pngBytes(800, 600).subarray(0, length);
}
