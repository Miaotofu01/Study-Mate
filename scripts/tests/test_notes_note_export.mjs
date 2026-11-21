/* 无界笔记 · 统一导出当前 Markdown（`client/notes/note-export.js`）· 纯函数，Node 里跑
   ────────────────────────────────────────────────────────────────────────────────
   #312：学习右栏、无界侧栏与文档视图共用 `NoteEditor`，导出只在 NoteEditor 这一层接线。
   这一套钉的是导出的两个失败方向：

   1. 文件名不安全：标题里的非法字符、Windows 保留名、末尾点空格、超长标题、
      已带扩展名的标题，任何一条松掉都会在 Windows 落盘时改名或被系统拒绝。
   2. 原稿不再原：导出内容必须逐字等于当前正文（混合换行保真、空正文允许），
      不做规范化、不截断——与编辑器「原稿唯一」的口径一致。

   跑法：`node --test scripts/tests/test_notes_note_export.mjs`（在 `npm test` 的默认门禁里）。
*/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  downloadNoteMarkdown,
  exportBaseName,
  exportFileName,
  noteExportPayload,
} from '../../client/notes/note-export.js';

test('标题里的中文与全角标点原样保留，补 .md 扩展名', () => {
  assert.equal(exportFileName('主动回忆：先想，再看'), '主动回忆：先想，再看.md');
  assert.equal(exportBaseName('连接，先于堆积'), '连接，先于堆积');
});

test('已带 Markdown 扩展名的标题不再重复扩展名', () => {
  assert.equal(exportFileName('笔记.md'), '笔记.md');
  assert.equal(exportFileName('笔记.markdown'), '笔记.md');
  assert.equal(exportFileName('笔记.txt'), '笔记.md');
  assert.equal(exportFileName('NOTES.MD'), 'NOTES.md');
  // 点号与扩展名之间夹了空格不算扩展名，但末尾空格要清掉。
  assert.equal(exportFileName('name .md'), 'name.md');
});

test('Windows 非法字符被替换成空格并折叠', () => {
  assert.equal(exportFileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j.md');
  assert.equal(exportFileName('a\u0000b\u001fc\u007f'), 'a b c.md');
  assert.equal(exportFileName('a\t\nb'), 'a b.md');
});

test('Windows 保留名（不区分大小写）加前缀避开系统拒绝', () => {
  assert.equal(exportFileName('CON'), '笔记-CON.md');
  assert.equal(exportFileName('com1'), '笔记-com1.md');
  assert.equal(exportFileName('nul.md'), '笔记-nul.md');
  // 带任意扩展名的保留名同样非法：Windows 只看第一个点号之前的段。
  assert.equal(exportFileName('con.foo'), '笔记-con.foo.md');
  assert.equal(exportFileName('CON.foo.md'), '笔记-CON.foo.md');
  assert.equal(exportFileName('com1.bar'), '笔记-com1.bar.md');
  // 只含保留名作前缀的普通词不受影响。
  assert.equal(exportFileName('connection.md'), 'connection.md');
  assert.equal(exportFileName('console.md'), 'console.md');
  assert.equal(exportFileName('连接'), '连接.md');
});

test('末尾点与空格被清掉（Windows 会静默丢弃它们）', () => {
  assert.equal(exportFileName('标题...'), '标题.md');
  assert.equal(exportFileName('标题  '), '标题.md');
  assert.equal(exportFileName('标题. '), '标题.md');
});

test('空标题与缺标题回退到「未命名」', () => {
  assert.equal(exportFileName(''), '未命名.md');
  assert.equal(exportFileName('   '), '未命名.md');
  assert.equal(exportFileName(null), '未命名.md');
  assert.equal(exportFileName(undefined), '未命名.md');
});

test('超长标题按 80 个字符截断（按字符数，不按字节）', () => {
  const long = '中'.repeat(100);
  assert.equal(exportBaseName(long), '中'.repeat(80));
  // 截断后落在末尾的点与空格同样要清掉。
  const dotted = '好.'.repeat(60);
  assert.equal(exportBaseName(dotted), '好.'.repeat(39) + '好');
});

test('导出内容逐字等于当前原稿，不做规范化', async () => {
  const markdown = '# 标题\r\n\r\n正文\r\n行尾两空格  \n';
  const payload = noteExportPayload('混合换行', markdown);
  assert.equal(payload.filename, '混合换行.md');
  assert.equal(payload.content, markdown);
  assert.equal(payload.mime, 'text/markdown;charset=utf-8');
  // 空正文也允许导出：导出是只读操作，不因内容为空而拒绝。
  const empty = noteExportPayload('空笔记', '');
  assert.equal(empty.content, '');
});

test('downloadNoteMarkdown 用标题命名、原稿落 Blob，并回收对象 URL', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const created = [];
  const fakeDocument = {
    createElement(tag) {
      const anchor = { tag, href: undefined, download: undefined, clicks: 0, click() { anchor.clicks += 1; } };
      created.push(anchor);
      return anchor;
    },
  };
  const createdUrls = [];
  const revokedUrls = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { createdUrls.push(blob); return 'blob:note-export-test'; };
  URL.revokeObjectURL = (url) => revokedUrls.push(url);
  try {
    const filename = downloadNoteMarkdown({
      title: '安全/标题',
      markdown: '# 原稿\n',
      document: fakeDocument,
    });
    assert.equal(filename, '安全 标题.md');
    assert.equal(created.length, 1);
    assert.equal(created[0].download, '安全 标题.md');
    assert.equal(created[0].href, 'blob:note-export-test');
    assert.equal(created[0].clicks, 1);
    assert.equal(createdUrls.length, 1);
    assert.equal(await createdUrls[0].text(), '# 原稿\n');
    // URL 回收挂在定时器上，回收发生在点击之后、内容已交付。
    assert.deepEqual(revokedUrls, []);
    t.mock.timers.tick(1000);
    assert.deepEqual(revokedUrls, ['blob:note-export-test']);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test('没有浏览器文档环境时如实报错，不静默吞掉导出', () => {
  assert.throws(() => downloadNoteMarkdown({ title: 'x', markdown: '', document: undefined }), /浏览器文档环境/);
  assert.throws(() => downloadNoteMarkdown({ title: 'x', markdown: '', document: {} }), /浏览器文档环境/);
});
