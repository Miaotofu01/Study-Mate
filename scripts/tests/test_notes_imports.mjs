/* 无界笔记 · 导入与副本（`client/notes/imports.js`）· 纯函数，Node 里跑
   ────────────────────────────────────────────────────────────────────────────────
   这一套是原型 `prototypes/unbounded-notes/test_imports.mjs` 的**行为移植**：原样保留那 10 条
   断言（一条都没放宽），只是把源路径指到 `client/notes/`，并把原型里那段自己写的小 runner
   换成 `node:test` + `node:assert/strict`。原型那份用的是 `new File(...)`，Node 24 自带
   （`node:buffer` 的 File 已经挂到全局），所以这里不需要任何浏览器或 DOM。

   为什么这 10 条值得搬：它们钉的是「副本是独立内容、引用是同一原件」这条边界的**几个失败
   方向**——丢句柄、静默回退到缓存正文、把目录当文件读、超过大小上限不报错。任何一条松掉，
   「副本」与「引用」就会在界面上看起来一样、行为不一样。

   跑法：`node --test scripts/tests/test_notes_imports.mjs`（在 `npm test` 的默认门禁里）。
*/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  captureFileDrop,
  copyResource,
  copyTitle,
  gridAppearance,
  isFileReference,
  originDescription,
  readImportedEntry,
  readResourceFile,
  resolveFileReference,
} from '../../client/notes/imports.js';

const file = (body, name = 'sample.md') => new File([body], name, { type: 'text/markdown', lastModified: 100 });

test('副本导入是一份独立的 Markdown 快照，不留文件系统能力', async () => {
  const original = file('# Copy');
  const copied = await readImportedEntry({ file: original }, 'copy');
  assert.equal(copied.markdown, '# Copy');
  assert.equal(copied.origin.mode, 'copy');
  assert.equal('fileHandle' in copied, false);
  assert.equal('sourceFile' in copied, false);
  assert.equal(isFileReference(copied), false);
});

test('文件句柄引用每次都重读当前文件，从不申请写权限', async () => {
  let body = 'First';
  let reads = 0;
  const handle = {
    kind: 'file',
    async getFile() { reads++; return file(body); },
    requestPermission() { throw Error('must not request write permission'); },
  };
  const reference = await readImportedEntry({ handle }, 'reference');
  assert.equal(reference.markdown, 'First');
  assert.equal(reference.origin.canReopen, true);
  body = 'Updated original';
  const current = await resolveFileReference({ ...reference, id: 'stable-id' });
  assert.equal(current.id, 'stable-id');
  assert.equal(current.markdown, 'Updated original');
  assert.equal(reads, 2);
});

test('只有 File 的引用被标成「临时文件引用 · 本次」，与副本明确可分', async () => {
  const reference = await readImportedEntry({ file: file('Snapshot') }, 'reference');
  assert.equal(isFileReference(reference), true);
  assert.equal(reference.origin.canReopen, false);
  assert.match(originDescription(reference), /临时文件引用/);
  assert.match(originDescription(reference), /本次/);
});

test('丢掉的原件权限不能静默回退到缓存正文', async () => {
  const reference = {
    origin: { kind: 'file', mode: 'reference' },
    markdown: 'Stale private text',
    fileHandle: { async getFile() { throw new Error('permission revoked'); } },
  };
  await assert.rejects(resolveFileReference(reference), /引用不可用.*permission revoked/);
});

test('文件夹被拒绝，不做任何遍历', async () => {
  const handle = { kind: 'directory', values() { throw Error('No traversal'); } };
  await assert.rejects(readImportedEntry({ handle }, 'reference'), /不读取文件夹/);
});

test('不认识模式与超限文本都在建资源之前就拒绝', async () => {
  await assert.rejects(readImportedEntry({ file: file('x') }, 'move'), /副本或引用/);
  await assert.rejects(
    readResourceFile({ name: 'too-large.md', size: 512 * 1024 + 1, text() { throw Error('must not read'); } }),
    /512 KiB/,
  );
  await assert.rejects(readResourceFile(file('x'.repeat(128 * 1024 + 1))), /128 Ki/);
});

test('内部副本拿到独立身份，并丢掉文件句柄与原来的归属', () => {
  const source = {
    id: 'source', type: 'note', title: 'note.md', markdown: 'Original', parent: 'A',
    sourceFile: file('Original'), fileHandle: { kind: 'file' }, referenceError: 'old',
    origin: { mode: 'reference', kind: 'file' },
  };
  const copied = copyResource(source, 'independent', 'B');
  assert.equal(copied.id, 'independent');
  assert.equal(copied.parent, 'B');
  assert.equal(copied.title, 'note（副本）.md');
  assert.equal('fileHandle' in copied, false);
  assert.equal('sourceFile' in copied, false);
  assert.equal('referenceError' in copied, false);
  copied.markdown = 'Different';
  assert.equal(source.markdown, 'Original');
  assert.equal(isFileReference(copied), false);
});

test('副本命名保留扩展名，没有扩展名也能用', () => {
  assert.equal(copyTitle('image.svg'), 'image（副本）.svg');
  assert.equal(copyTitle('Concept'), 'Concept（副本）');
});

test('拖放时当场同时抓 File 与句柄；句柄被拒也安全', async () => {
  const original = file('x');
  let called = false;
  const entries = captureFileDrop({
    items: [{
      kind: 'file',
      getAsFile() { return original; },
      getAsFileSystemHandle() { called = true; return Promise.reject(new Error('unsupported')); },
    }],
  });
  assert.equal(called, true);
  assert.equal(entries[0].file, original);
  assert.equal(await entries[0].handle, null);
});

test('点阵间距与点径是画布坐标：跟着节点一起缩放', () => {
  for (const zoom of [0.2, 0.5, 1, 1.5, 2]) {
    const pattern = gridAppearance(zoom);
    assert.equal(pattern.gap, 24);
    assert.equal(pattern.size, 1.6);
    // 屏幕上的间距随缩放变化，这是「与节点一起缩放」，不是屏幕固定密度。
    assert.ok(Math.abs(pattern.gap * zoom - 24 * zoom) < 0.00001);
  }
});
