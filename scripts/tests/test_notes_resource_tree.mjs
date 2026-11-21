/* 无界笔记 · 资源树纯逻辑（#312）· 空目录判定 / 重命名校验 / 可重命名判定
   ────────────────────────────────────────────────────────────────────────────
   判定住在 client/notes/resource-tree-model.js（无 React、无 DOM），这里钉住行为契约：

     1. initialParent：示例资源的默认归属回退与 App.jsx 的既有用法逐字一致。
     2. folderIsEmpty：仅空目录可删的判据本身——有子目录不算空；任何资源都算内容，
        **含废纸篓里的 trashed 资源**（删除目录不许顺带删除/孤立任何资源，删除数据
        语义不在这里改变）；宿主传入 hasCanvasContent 时笔记本画布非空也不算空。
     3. folderContentSummary：非空提醒的计数与 folderIsEmpty 同一口径。
     4. canRenameResource：引用型文件（origin.mode === 'reference'）不可重命名，
        trashed 不可重命名；自有笔记 / 副本 / 网页 / 课程卡可以（只改元数据 title）。
     5. 名称校验：去空白、空名拒绝、上限按代码点（80 / 160，与 App 输入框 maxLength 一致）。
*/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  initialFolders, initialParent, resourceFolder,
  folderIsEmpty, folderContentSummary, canRenameResource,
  validateFolderName, validateFileTitle, FOLDER_NAME_MAX, FILE_TITLE_MAX,
  folderDeleteBlockReason,
} from '../../client/notes/resource-tree-model.js';

const note = (id, parent, extra = {}) => ({ id, type: 'note', title: id + '.md', parent, ...extra });

test('initialParent：示例资源默认归属与既有用法一致', () => {
  assert.equal(initialParent({ type: 'note', id: 'note-recall' }), 'notes');
  assert.equal(initialParent({ type: 'note', id: 'note-example' }), 'examples');
  assert.equal(initialParent({ type: 'link', id: 'link-1' }), 'references');
  assert.equal(initialParent({ type: 'image', id: 'img-1' }), 'references');
  // initialFolders 仍是那五条，形状未变（App.jsx 从 ResourceTree.jsx 再导出取值）。
  assert.deepEqual(initialFolders.map(folder => [folder.id, folder.parent, folder.kind]), [
    ['library', null, 'folder'], ['book', 'library', 'notebook'], ['notes', 'book', 'folder'],
    ['examples', 'book', 'folder'], ['references', 'library', 'folder'],
  ]);
  assert.equal(resourceFolder({ type: 'note', id: 'x' }), 'notes');
  assert.equal(resourceFolder({ type: 'note', id: 'x', parent: 'book' }), 'book');
});

test('folderIsEmpty：有子目录不算空', () => {
  const folders = [
    { id: 'a', parent: null, name: 'A', kind: 'folder' },
    { id: 'b', parent: 'a', name: 'B', kind: 'folder' },
  ];
  assert.equal(folderIsEmpty(folders, {}, 'a'), false);
  assert.equal(folderIsEmpty(folders, {}, 'b'), true);
  assert.equal(folderIsEmpty(folders, {}, '不存在'), true);
});

test('folderIsEmpty：任何资源都算内容，trashed 也算（删除不许孤立废纸篓资源）', () => {
  const folders = [{ id: 'a', parent: null, name: 'A', kind: 'folder' }];
  assert.equal(folderIsEmpty(folders, { n1: note('n1', 'a') }, 'a'), false);
  assert.equal(folderIsEmpty(folders, { n1: note('n1', 'a', { trashed: true }) }, 'a'), false);
  // 没有显式 parent 的资源按 initialParent 回退：'notes' 里的资源让 notes 非空。
  assert.equal(folderIsEmpty(initialFolders, { n1: note('n1', undefined) }, 'notes'), false);
  assert.equal(folderIsEmpty(initialFolders, {}, 'examples'), true);
});

test('folderIsEmpty：hasCanvasContent 把笔记本判成非空（画布上有节点时）', () => {
  const folders = [{ id: 'book', parent: 'library', name: '本', kind: 'notebook' }];
  assert.equal(folderIsEmpty(folders, {}, 'book'), true);
  assert.equal(folderIsEmpty(folders, {}, 'book', true), false);
  assert.equal(folderIsEmpty(folders, {}, 'book', false), true);
});

test('folderContentSummary：子目录与资源计数（trashed 计入）', () => {
  const folders = [
    { id: 'a', parent: null, name: 'A', kind: 'folder' },
    { id: 'b', parent: 'a', name: 'B', kind: 'folder' },
  ];
  const resources = { n1: note('n1', 'a'), n2: note('n2', 'a', { trashed: true }) };
  assert.deepEqual(folderContentSummary(folders, resources, 'a'), { children: 1, files: 2 });
  assert.deepEqual(folderContentSummary(folders, {}, 'b'), { children: 0, files: 0 });
});

test('canRenameResource：引用文件与废纸篓不可重命名，其余资源可以', () => {
  assert.equal(canRenameResource(note('n1', 'a')), true);
  assert.equal(canRenameResource(note('n1', 'a', { trashed: true })), false);
  assert.equal(canRenameResource({ id: 'c1', type: 'link', title: '网页' }), true);
  assert.equal(canRenameResource({ id: 'f1', type: 'svg', title: '图.svg', origin: { kind: 'file', mode: 'copy' } }), true);
  assert.equal(canRenameResource({ id: 'f2', type: 'svg', title: '引用.svg', origin: { kind: 'file', mode: 'reference' } }), false);
  assert.equal(canRenameResource(null), false);
  assert.equal(canRenameResource(undefined), false);
});

test('folderDeleteBlockReason：系统根、回退目录、最后一本、默认本、绑定本与非空各有独立提醒', () => {
  const root = initialFolders.find((folder) => folder.id === 'library');
  assert.equal(folderDeleteBlockReason(initialFolders, {}, root), '根目录不可删除。');
  // 回退目录（initialParent 的去处）按 id 保护，空也不可删；提醒点名后果。
  for (const id of ['notes', 'examples', 'references']) {
    const folder = initialFolders.find((item) => item.id === id);
    assert.match(folderDeleteBlockReason(initialFolders, {}, folder), /默认去处.*不再显示/);
  }
  // 最后一本笔记本不可删，且优先于默认本/绑定本提醒（只剩一本时「先更换默认本」无从操作）。
  const lastBook = { id: 'b1', parent: 'library', name: '默认本', kind: 'notebook', defaultForSubjects: [{ workspace: 'w', subject: 'sub1' }], bindings: [{ workspace: 'w', subject: 'sub1' }] };
  assert.match(folderDeleteBlockReason(initialFolders, {}, lastBook), /最后一本笔记本/);
  // 两本笔记本时，非默认非绑定的空本可删（不受最后一本规则影响）。
  assert.equal(folderDeleteBlockReason([lastBook, { id: 'b2', parent: 'library', name: '空本', kind: 'notebook' }], {}, { id: 'b2', parent: 'library', name: '空本', kind: 'notebook' }), '');
  const defaultBook = { ...lastBook, id: 'b3' };
  assert.match(folderDeleteBlockReason([defaultBook, { id: 'b4', parent: 'library', name: '别的本', kind: 'notebook' }], {}, defaultBook), /默认笔记本/);
  const boundBook = { id: 'b5', parent: 'library', name: '绑定本', kind: 'notebook', bindings: [{ workspace: 'w', subject: 'sub1' }, { workspace: 'w', subject: 'sub2' }] };
  // initialFolders 只有 'book' 一本笔记本，绑定本进来即「最后一本」；两本并存时才轮到绑定提醒。
  assert.match(folderDeleteBlockReason([...initialFolders, boundBook], {}, boundBook), /绑定了 2 个科目/);
  // 非空的提醒保留计数口径（含废纸篓项标注）——用非回退目录验证。
  const folders = [...initialFolders, { id: 'full', parent: 'library', name: '满目录', kind: 'folder' }];
  const resources = { n1: note('n1', 'full'), t1: note('t1', 'full', { trashed: true }) };
  const fullHint = folderDeleteBlockReason(folders, resources, folders.find((folder) => folder.id === 'full'));
  assert.match(fullHint, /2 个文件/);
  assert.match(fullHint, /含废纸篓项/);
  // 仅画布非空的笔记本提醒画布内容（非回退、非最后一本的目录）。
  const canvasBook = { id: 'b6', parent: 'library', name: '画布本', kind: 'notebook' };
  assert.equal(folderDeleteBlockReason([canvasBook, { id: 'b7', parent: 'library', name: '第二本', kind: 'notebook' }], {}, canvasBook, true), '「画布本」不是空目录（画布上还有内容），清空后才能删除。');
  // 根、回退目录、最后一本、默认本、绑定本的阻断优先于非空提醒。
  const boundNonEmpty = { ...boundBook, parent: 'library' };
  assert.match(folderDeleteBlockReason([...initialFolders, boundBook], { n1: note('n1', 'b5') }, boundNonEmpty), /绑定了/);
  // 空且未绑定的普通目录/笔记本允许删除。
  assert.equal(folderDeleteBlockReason(folders, {}, { id: 'plain', parent: 'library', name: '空目录', kind: 'folder' }), '');
  assert.equal(folderDeleteBlockReason([{ id: 'b8a', parent: 'library', name: '本一', kind: 'notebook' }, { id: 'b8', parent: 'library', name: '空本', kind: 'notebook' }], {}, { id: 'b8', parent: 'library', name: '空本', kind: 'notebook' }), '');
  // 传入 null/undefined 目录一律阻断（兜底）。
  assert.equal(folderDeleteBlockReason(initialFolders, {}, null), '根目录不可删除。');
});

test('validateFolderName / validateFileTitle：去空白、空名拒绝、按代码点计上限', () => {
  assert.deepEqual(validateFolderName('  概念  '), { ok: true, name: '概念' });
  assert.equal(validateFolderName('   ').ok, false);
  assert.equal(validateFolderName('').ok, false);
  assert.equal(validateFolderName('x'.repeat(FOLDER_NAME_MAX)).ok, true);
  assert.equal(validateFolderName('x'.repeat(FOLDER_NAME_MAX + 1)).ok, false);
  assert.equal(validateFolderName('概'.repeat(FOLDER_NAME_MAX)).ok, true);
  assert.equal(validateFolderName('概'.repeat(FOLDER_NAME_MAX + 1)).ok, false);
  assert.deepEqual(validateFileTitle(' 向量空间.md '), { ok: true, name: '向量空间.md' });
  assert.equal(validateFileTitle('   ').ok, false);
  assert.equal(validateFileTitle('t'.repeat(FILE_TITLE_MAX)).ok, true);
  assert.equal(validateFileTitle('t'.repeat(FILE_TITLE_MAX + 1)).ok, false);
  // 非字符串输入一律拒绝，不抛异常。
  assert.equal(validateFolderName(null).ok, false);
  assert.equal(validateFileTitle(42).ok, false);
});
