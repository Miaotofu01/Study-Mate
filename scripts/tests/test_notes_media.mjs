/* 无界笔记 · 静态媒体的边界（`client/notes/media.js`）· 纯函数，Node 里跑
   ────────────────────────────────────────────────────────────────────────────────
   这一套是原型 `prototypes/unbounded-notes/test_media.mjs` 的**行为移植**：12 条断言原样保留，
   只把源路径指到 `client/notes/`，小 runner 换成 `node:test` + `node:assert/strict`。
   字节流全部现造（`Uint8Array`），不读任何真实图片文件，也不碰用户的图片目录。

   钉的是三类边界，每一类都对应一个真会出事的失败方向：
     · 大小与像素上限（4 MiB / 512 KiB / 256 KiB；每边 8192、总计 1600 万像素）；
     · 动画图（APNG 的 acTL、WebP 的 VP8X 动画位与 ANIM/ANMF 块）一律拒绝；
     · 坏文件必须**明说坏在哪**（格式不匹配 / 数据不完整 / 缺少尺寸），而不是静默出一张 0×0。

   跑法：`node --test scripts/tests/test_notes_media.mjs`（在 `npm test` 的默认门禁里）。
*/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEDIA_LIMITS,
  validateMediaSize,
  validateRasterDimensions,
  validateMediaDimensions,
  parseRasterHeader,
} from '../../client/notes/media.js';

const asBytes = (...values) => Uint8Array.from(values);
const ascii = (value) => [...Buffer.from(value, 'ascii')];
const u32be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u24le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

function png(width, height, extraChunks = []) {
  const chunk = (type, data = []) => [...u32be(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
  return asBytes(
    ...ascii('\x89PNG\r\n\x1a\n'),
    ...chunk('IHDR', [...u32be(width), ...u32be(height), 8, 2, 0, 0, 0]),
    ...extraChunks.flatMap(([type, data]) => chunk(type, data)),
    ...chunk('IEND'),
  );
}

function webp(chunks) {
  const body = chunks.flatMap(([kind, data]) => [
    ...ascii(kind), ...u32le(data.length), ...data, ...(data.length & 1 ? [0] : []),
  ]);
  const riffSize = 4 + body.length;
  return asBytes(...ascii('RIFF'), ...u32le(riffSize), ...ascii('WEBP'), ...body);
}

function webpVp8x(width, height, flags = 0) {
  return webp([['VP8X', [flags, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]]]);
}
function webpVp8(width, height) {
  return webp([['VP8 ', [0, 0, 0, 0x9d, 1, 0x2a, width & 255, (width >>> 8) & 0x3f, height & 255, (height >>> 8) & 0x3f]]]);
}
function webpVp8l(width, height) {
  const w = width - 1, h = height - 1;
  return webp([['VP8L', [0x2f, w & 255, ((w >>> 8) & 0x3f) | ((h & 3) << 6), (h >>> 2) & 255, (h >>> 10) & 0x0f]], ['JUNK', [0, 0, 0, 0]]]);
}
function jpeg(width, height) {
  return asBytes(
    0xff, 0xd8,
    0xff, 0xc0, 0, 8, 8, (height >>> 8) & 255, height & 255, (width >>> 8) & 255, width & 255, 1,
    0xff, 0xd9,
  );
}

const animatedError = /暂不支持动画图片/;
const dimensionsError = /图片尺寸过大/;

test('导出的位图尺寸校验别名与冻结的上限表', () => {
  assert.equal(validateMediaDimensions, validateRasterDimensions);
  assert.equal(Object.isFrozen(MEDIA_LIMITS), true);
  assert.deepEqual(validateRasterDimensions(1, 1), { width: 1, height: 1 });
});

test('字节上限：恰好等于上限通过，多一个字节就拒', () => {
  assert.equal(validateMediaSize('image', 4 * 1024 * 1024), true);
  assert.throws(() => validateMediaSize('image', 4 * 1024 * 1024 + 1), /文件过大/);
  assert.equal(validateMediaSize('svg', 512 * 1024), true);
  assert.throws(() => validateMediaSize('svg', 512 * 1024 + 1), /文件过大/);
  assert.equal(validateMediaSize('html', 256 * 1024), true);
  assert.throws(() => validateMediaSize('html', 256 * 1024 + 1), /文件过大/);
});

test('字节数非有限或为负时拒绝', () => {
  for (const size of [NaN, Infinity, -Infinity, -1]) {
    assert.throws(() => validateMediaSize('image', size), /文件大小无效/);
  }
  assert.equal(validateMediaSize('image', 0), true);
});

test('位图尺寸校验：两条上限各自贴边都通过', () => {
  assert.deepEqual(validateRasterDimensions(8192, 1), { width: 8192, height: 1 });
  assert.deepEqual(validateRasterDimensions(1, 8192), { width: 1, height: 8192 });
  assert.deepEqual(validateRasterDimensions(4000, 4000), { width: 4000, height: 4000 });
});

test('位图尺寸校验：非法整数与被突破的上限都拒绝', () => {
  for (const [width, height] of [[0, 1], [1, 0], [-1, 1], [1, -1], [NaN, 1], [1, NaN], [1.5, 2], [2, Infinity], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
    assert.throws(() => validateRasterDimensions(width, height), /无法读取图片尺寸/);
  }
  assert.throws(() => validateRasterDimensions(8193, 1), dimensionsError);
  assert.throws(() => validateRasterDimensions(1, 8193), dimensionsError);
  assert.throws(() => validateRasterDimensions(4001, 4000), dimensionsError);
});

test('PNG：读出尺寸、守住上限、坏头报得出来', () => {
  assert.deepEqual(parseRasterHeader(png(8192, 1), 'image/png'), { width: 8192, height: 1, animated: false });
  assert.deepEqual(parseRasterHeader(png(4000, 4000), 'image/png'), { width: 4000, height: 4000, animated: false });
  assert.throws(() => parseRasterHeader(png(8193, 1), 'image/png'), dimensionsError);
  assert.throws(() => parseRasterHeader(png(4001, 4000), 'image/png'), dimensionsError);
  const wrongSignature = png(1, 1); wrongSignature[0] = 0;
  assert.throws(() => parseRasterHeader(wrongSignature, 'image/png'), /PNG 格式不匹配/);
  const zeroDimensions = png(0, 1);
  assert.throws(() => parseRasterHeader(zeroDimensions, 'image/png'), /无法读取图片尺寸/);
  assert.throws(() => parseRasterHeader(png(1, 1).subarray(0, 25), 'image/png'), /PNG 格式不匹配/);
  const missingEnd = png(1, 1).subarray(0, 33);
  assert.throws(() => parseRasterHeader(missingEnd, 'image/png'), /PNG 文件数据不完整/);
  const brokenChunk = png(1, 1); brokenChunk[8] = 100;
  assert.throws(() => parseRasterHeader(brokenChunk, 'image/png'), /PNG 文件数据不完整/);
});

test('PNG：APNG 的动画控制块被拒', () => {
  assert.throws(() => parseRasterHeader(png(1, 1, [['acTL', [...u32be(1), ...u32be(0)]]]), 'image/png'), animatedError);
});

test('JPEG：从 SOF 取尺寸；缺 SOF 或不完整都拒', () => {
  assert.deepEqual(parseRasterHeader(jpeg(320, 240), 'image/jpeg'), { width: 320, height: 240, animated: false });
  assert.throws(() => parseRasterHeader(jpeg(8193, 1), 'image/jpeg'), dimensionsError);
  assert.throws(() => parseRasterHeader(jpeg(0, 1), 'image/jpeg'), /无法读取图片尺寸/);
  const wrongSignature = jpeg(1, 1); wrongSignature[1] = 0;
  assert.throws(() => parseRasterHeader(wrongSignature, 'image/jpeg'), /JPEG 格式不匹配/);
  assert.throws(() => parseRasterHeader(asBytes(0xff, 0xd8, 0xff, 0xd9), 'image/jpeg'), /缺少有效尺寸信息/);
  assert.throws(() => parseRasterHeader(asBytes(0xff, 0xd8, 0xff, 0xc0, 0, 9, 8, 0, 1, 0, 1, 1), 'image/jpeg'), /JPEG 文件数据不完整/);
});

test('WebP VP8X：读出尺寸，动画位被拒', () => {
  assert.deepEqual(parseRasterHeader(webpVp8x(640, 480), 'image/webp'), { width: 640, height: 480, animated: false });
  assert.throws(() => parseRasterHeader(webpVp8x(8193, 1), 'image/webp'), dimensionsError);
  assert.throws(() => parseRasterHeader(webpVp8x(1, 1, 2), 'image/webp'), animatedError);
});

test('WebP 的 VP8 与 VP8L 简单码流头给得出尺寸', () => {
  assert.deepEqual(parseRasterHeader(webpVp8(320, 240), 'image/webp'), { width: 320, height: 240, animated: false });
  assert.deepEqual(parseRasterHeader(webpVp8l(300, 200), 'image/webp'), { width: 300, height: 200, animated: false });
});

test('WebP：动画块、坏长度、缺尺寸都拒', () => {
  const validFrameHeader = [0, 0, 0, 0, ...u24le(0), ...u24le(0)];
  assert.throws(() => parseRasterHeader(webp([['VP8X', [2, 0, 0, 0, ...u24le(0), ...u24le(0)]], ['ANIM', [0, 0, 0, 0, 0, 0]]]), 'image/webp'), animatedError);
  assert.throws(() => parseRasterHeader(webp([['VP8X', [0, 0, 0, 0, ...u24le(0), ...u24le(0)]], ['ANMF', validFrameHeader]]), 'image/webp'), animatedError);
  assert.throws(() => parseRasterHeader(webp([['JUNK', [1, 2, 3, 4, 5, 6]], ['JUNK', [0, 0, 0, 0]]]), 'image/webp'), /缺少有效尺寸信息/);
  const badRiffSize = webpVp8x(1, 1); badRiffSize[4]++;
  assert.throws(() => parseRasterHeader(badRiffSize, 'image/webp'), /长度标记无效/);
  const truncated = webpVp8x(1, 1); truncated[16] = 20;
  assert.throws(() => parseRasterHeader(truncated, 'image/webp'), /WebP 文件数据不完整/);
});

test('MIME 对不上与不认识的格式都拒', () => {
  assert.throws(() => parseRasterHeader(png(1, 1), 'image/jpeg'), /JPEG 格式不匹配/);
  assert.throws(() => parseRasterHeader(jpeg(1, 1), 'image/webp'), /WebP 格式不匹配/);
  assert.throws(() => parseRasterHeader(png(1, 1), 'image/gif'), /不支持的图片格式/);
});
