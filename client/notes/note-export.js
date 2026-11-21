// 统一导出当前 Markdown 原稿（#312）。
// 学习右栏、无界侧栏与文档视图共用 NoteEditor，导出也只在 NoteEditor 这一层接线，
// 三个面天然一致。文件名来自笔记标题，经安全处理（非法字符、Windows 保留名、
// 末尾点空格、长度）后加 .md 扩展名；导出内容是当前原稿逐字写出，不做规范化。

const ILLEGAL_FILENAME = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
// Windows 对这些名字即使带扩展名也拒绝（CON.foo、CON.foo.md 同样非法），判据
// 是第一个点号之前的段，见 https://learn.microsoft.com/windows/win32/fileio/naming-a-file
const RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MARKDOWN_EXTENSION = /\.(md|markdown|txt)$/i;
// 路径总长有限（多数文件系统 255），给标题留 80 个字符是稳妥上限。
const MAX_BASE_NAME_CHARS = 80;
const FALLBACK_BASE_NAME = '未命名';

// 纯函数：标题 → 不含扩展名的安全文件名。
export function exportBaseName(title) {
  let name = String(title ?? '').trim();
  // 标题里已有的 Markdown 扩展名不再重复一次。
  name = name.replace(MARKDOWN_EXTENSION, '');
  name = name.replace(ILLEGAL_FILENAME, ' ');
  name = name.replace(/\s+/g, ' ').trim();
  // Windows 末尾的点与空格会被静默丢弃，落盘前后名字不一致，先去掉。
  name = name.replace(/[. ]+$/g, '');
  if (RESERVED_BASENAME.test(name.split('.', 1)[0])) name = '笔记-' + name;
  name = [...name].slice(0, MAX_BASE_NAME_CHARS).join('').trim();
  name = name.replace(/[. ]+$/g, '');
  return name || FALLBACK_BASE_NAME;
}

// 纯函数：标题 → 带扩展名的安全文件名。
export function exportFileName(title) {
  return exportBaseName(title) + '.md';
}

// 纯函数：一次导出的全部事实，便于测试与将来的其他出口复用。
export function noteExportPayload(title, markdown) {
  return {
    filename: exportFileName(title),
    content: String(markdown ?? ''),
    mime: 'text/markdown;charset=utf-8',
  };
}

// 触发浏览器下载。document 可注入以便在 Node 测试里驱动；
// Blob/URL 沿用全局实现（与 client/notes/App.jsx 的草稿导出同一套浏览器行为）。
export function downloadNoteMarkdown({ title, markdown, document = globalThis.document } = {}) {
  if (!document || typeof document.createElement !== 'function') {
    throw new Error('导出需要浏览器文档环境。');
  }
  const payload = noteExportPayload(title, markdown);
  const blob = new Blob([payload.content], { type: payload.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = payload.filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return payload.filename;
}
