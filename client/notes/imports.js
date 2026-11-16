import { readMediaFile } from './media.js';

export const IMPORT_FILE_ACCEPT = '.md,.markdown,.txt,image/png,image/jpeg,image/webp,image/svg+xml,.svg,.html,.htm';
export const IMPORT_PICKER_TYPES = [{ description: '笔记和静态媒体', accept: {
  'text/plain': ['.txt'], 'text/markdown': ['.md', '.markdown'],
  'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'],
  'image/svg+xml': ['.svg'], 'text/html': ['.html', '.htm'],
} }];
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_TEXT_LENGTH = 128 * 1024;
const PAYLOAD_KEYS = ['type', 'title', 'markdown', 'summary', 'url', 'html', 'src', 'mime', 'bytes', 'width', 'height'];
const validateMode = (mode) => { if (!['copy', 'reference'].includes(mode)) throw new Error('请选择副本或引用模式。'); };

export function isFileReference(resource) {
  return resource?.origin?.kind === 'file' && resource.origin.mode === 'reference';
}
export function copyTitle(title = '未命名') {
  const name = String(title), dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}（副本）${name.slice(dot)}` : `${name}（副本）`;
}

export async function readResourceFile(file) {
  if (!file || typeof file.text !== 'function' || !Number.isFinite(file.size)) throw new Error('未提供有效文件。');
  const title = String(file.name || '未命名').slice(0, 160);
  if (/\.(md|markdown|txt)$/i.test(title)) {
    if (file.size > MAX_TEXT_BYTES) throw new Error('文本文件不得超过 512 KiB。');
    const markdown = await file.text();
    if (markdown.length > MAX_TEXT_LENGTH) throw new Error('正文最多 128 Ki 字符。');
    return { type: 'note', title, markdown, bytes: file.size, mime: 'text/markdown' };
  }
  const ext = title.split('.').at(-1).toLowerCase();
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', html: 'text/html', htm: 'text/html' }[ext];
  const readable = !file.type && mime ? new File([file], title, { type: mime, lastModified: file.lastModified }) : file;
  return readMediaFile(readable);
}

// Capture handles while the browser's drop event still owns its data store.
// No directories are traversed, and no filesystem write permission is requested.
export function captureFileDrop(transfer) {
  const items = [...(transfer?.items || [])].filter((item) => item.kind === 'file');
  if (items.length) return items.map((item) => {
    let handle = null;
    try { handle = typeof item.getAsFileSystemHandle === 'function' ? Promise.resolve(item.getAsFileSystemHandle()).catch(() => null) : null; } catch { /* A File-only fallback is labelled honestly. */ }
    return { file: item.getAsFile(), handle };
  }).filter((entry) => entry.file || entry.handle);
  return [...(transfer?.files || [])].map((file) => ({ file, handle: null }));
}

export async function readImportedEntry(entry, mode) {
  validateMode(mode);
  const handle = entry.handle ? await entry.handle : null;
  if (handle?.kind === 'directory') throw new Error('仅允许选择单个文件，不读取文件夹。');
  const canReopen = handle?.kind === 'file' && typeof handle.getFile === 'function';
  const file = mode === 'reference' && canReopen ? await handle.getFile() : entry.file || (canReopen ? await handle.getFile() : null);
  const resource = await readResourceFile(file);
  const origin = { kind: 'file', mode, name: String(file.name || resource.title), lastModified: Number(file.lastModified) || 0, canReopen: mode === 'reference' && canReopen };
  if (mode === 'copy') return { ...resource, origin };
  return { ...resource, origin, sourceFile: file, fileHandle: canReopen ? handle : null };
}

export async function resolveFileReference(resource) {
  if (!isFileReference(resource)) return resource;
  try {
    const file = resource.fileHandle ? await resource.fileHandle.getFile() : resource.sourceFile;
    if (!file) throw new Error('请重新选择原文件。');
    const payload = await readResourceFile(file);
    return { ...resource, ...payload, title: resource.title, referenceError: '', sourceFile: file,
      origin: { ...resource.origin, lastModified: Number(file.lastModified) || 0 } };
  } catch (error) {
    throw new Error(`原文件引用不可用，请重新选择文件：${error?.message || error}`);
  }
}

// A copied resource is independent: never inherit a File/handle or live origin.
export function copyResource(resource, id, parent) {
  const payload = Object.fromEntries(PAYLOAD_KEYS.filter((key) => resource[key] !== undefined).map((key) => [key, resource[key]]));
  return { ...payload, id, title: copyTitle(resource.title), parent,
    origin: { kind: 'workspace', mode: 'copy', sourceId: resource.id } };
}

export function originDescription(resource) {
  if (!resource?.origin) return '';
  if (isFileReference(resource)) return resource.origin.canReopen ? '原文件引用 · 只读 · 打开时重新读取' : '临时文件引用 · 只读 · 本环境只能使用本次选中的文件';
  return resource.origin.mode === 'copy' ? '独立副本 · 修改不影响来源' : '资源引用';
}

// 点阵属于画布内容，不是屏幕贴图：间距与点径都用画布坐标。
// 因此缩放时点阵与节点一起缩放，卡片与卡片之间的相对间距保持不变。
export function gridAppearance() {
  return { gap: 24, size: 1.6 };
}
