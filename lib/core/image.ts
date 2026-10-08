/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 —— 图片文件头

   一句话：给一张图的**头几个字节**，认出它是 PNG / JPEG / GIF / WebP 里的哪一种、
   报出**真实宽高**。只读字节：不碰盘、不联网、不解码像素、不引入图像库。

   为什么要这一层：图片库校验器原来只查文件存在、命名、索引列与体积上限——一张下载了
   一半的位图、或存成 `.png` 的 HTML 错误页可以全绿通过并进入课件（#100 实测）。规格说
   「尺寸看页面标注或图片文件头」，而**页面标注可能是被缩放过的那一版**，所以索引里的
   `尺寸` 以**文件头**为准，校验器按它复算。

   为什么只读文件头就够：四种格式的宽高都在最前面——
     · PNG   ：8 字节签名 + `IHDR` 块（长度 + 类型 + 宽 + 高，各 4 字节大端）
     · GIF   ：`GIF87a` / `GIF89a` + 宽 + 高（各 2 字节小端）
     · JPEG  ：`FF D8` 之后逐段走到第一个 `SOFn`（高在前、宽在后，各 2 字节大端）
     · WebP  ：`RIFF….WEBP` + 第一个块（`VP8 ` 有损 / `VP8L` 无损 / `VP8X` 扩展，三种布局）
   调用方按 64 字节取头就够（`lib/host/vault.ts` 的图片库视图就是这么取的）。

   认不出来一律返回 `null`——**「认不出」是结果，不是异常**：半个文件、错误页、
   没见过的格式，都该被如实报出来，而不是把校验器炸掉。
   ───────────────────────────────────────────────────────────────────────── */

/** 图片库里允许的四种位图。 */
export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp';

export interface ImageHeader {
  kind: ImageKind;
  width: number;
  height: number;
}

/** 扩展名 → 格式。不认的扩展名（或没有扩展名）返回 `null`。 */
export function imageKindOfExtension(name: string): ImageKind | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  switch (name.slice(dot + 1).toLowerCase()) {
    case 'png': return 'png';
    case 'jpg': case 'jpeg': return 'jpeg';
    case 'gif': return 'gif';
    case 'webp': return 'webp';
    default: return null;
  }
}

/**
 * 索引里 `尺寸` 那一格：`宽×高`。
 *
 * 分隔号认 `×` / `x` / `X` / `*`（有人手写 `x`），两端空白不算数。认不出返回 `null`——
 * 调用方据此给一句「这一格认不出」，而不是猜一个尺寸。
 */
export function parseSizeCell(text: string): { width: number; height: number } | null {
  const match = /^\s*(\d+)\s*[×xX*]\s*(\d+)\s*$/.exec(text);
  if (match === null) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/* ── 文件头解析 ─────────────────────────────────────────────────────────── */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u16be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function u16le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function u24le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
}

function u32be(bytes: Uint8Array, at: number): number {
  return (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8)
    | (bytes[at + 3] ?? 0)) >>> 0;
}

function u32le(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)
    | ((bytes[at + 3] ?? 0) << 24)) >>> 0;
}

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[at + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function parsePng(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 24) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }
  // 第一块必须是 IHDR（长度 13 + 类型 4 字节）；不查 CRC——校验器不看像素，只认宽高。
  if (!startsWith(bytes, 12, 'IHDR')) return null;
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  if (width === 0 || height === 0) return null;
  return { kind: 'png', width, height };
}

function parseGif(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 10) return null;
  if (!startsWith(bytes, 0, 'GIF87a') && !startsWith(bytes, 0, 'GIF89a')) return null;
  const width = u16le(bytes, 6);
  const height = u16le(bytes, 8);
  if (width === 0 || height === 0) return null;
  return { kind: 'gif', width, height };
}

function parseJpeg(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    let marker = bytes[at + 1] ?? 0;
    // 段之间可以垫任意多个 `FF`（填充字节）。
    while (marker === 0xff && at + 2 < bytes.length) {
      at += 1;
      marker = bytes[at + 1] ?? 0;
    }
    // 没有长度字段的标记：SOI 与 RSTn、TEM。
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = u16be(bytes, at + 2);
    if (length < 2) return null;
    // SOFn（帧头）：C0–CF 去掉 C4（霍夫曼表）、C8（JPG 扩展）、CC（算术编码表）。
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > bytes.length) return null;
      const height = u16be(bytes, at + 5);
      const width = u16be(bytes, at + 7);
      if (width === 0 || height === 0) return null;
      return { kind: 'jpeg', width, height };
    }
    // 还没见到帧头就撞上图像数据或文件尾：这份头认不出。
    if (marker === 0xd9 || marker === 0xda) return null;
    at += 2 + length;
  }
  return null;
}

function parseWebp(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 20) return null;
  if (!startsWith(bytes, 0, 'RIFF') || !startsWith(bytes, 8, 'WEBP')) return null;
  if (startsWith(bytes, 12, 'VP8 ')) {
    // 有损：帧标签 3 字节 + 起始码 9D 01 2A，然后宽高各 2 字节小端（各取低 14 位）。
    if (bytes.length < 30) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = u16le(bytes, 26) & 0x3fff;
    const height = u16le(bytes, 28) & 0x3fff;
    if (width === 0 || height === 0) return null;
    return { kind: 'webp', width, height };
  }
  if (startsWith(bytes, 12, 'VP8L')) {
    // 无损：签名 0x2F，然后 14 位宽-1、14 位高-1（小端 32 位里打包）。
    if (bytes.length < 25) return null;
    if (bytes[20] !== 0x2f) return null;
    const bits = u32le(bytes, 21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { kind: 'webp', width, height };
  }
  if (startsWith(bytes, 12, 'VP8X')) {
    // 扩展：4 字节标志，然后画布宽-1、高-1（各 3 字节小端）。
    if (bytes.length < 30) return null;
    const width = u24le(bytes, 24) + 1;
    const height = u24le(bytes, 27) + 1;
    return { kind: 'webp', width, height };
  }
  return null;
}

/**
 * 从文件头认出格式与真实宽高。**认不出返回 `null`**（头不完整、magic 对不上、
 * 走到了图像数据还没见到帧头）——调用方把这一种如实报成「文件头认不出」。
 */
export function parseImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length === 0) return null;
  if (bytes[0] === 0x89) return parsePng(bytes);
  if (bytes[0] === 0x47) return parseGif(bytes);
  if (bytes[0] === 0xff) return parseJpeg(bytes);
  if (bytes[0] === 0x52) return parseWebp(bytes);
  return null;
}
