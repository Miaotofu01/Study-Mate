import test from 'node:test';
import assert from 'node:assert/strict';
import { associateNote, courseRef, createNotesWorkspace, linkedNotes, normalizeAssociations, normalizeCourseRef, notebookOf, resolveCourse, sameCourse, sameSubject } from '../../client/notes/curriculum.js';
import { hydrateLayout, hydrateResource, hydrateStore, serializeLayout, serializeResource } from '../../client/notes/persistence.js';

const scope = { workspace: 'D:\\学习', subject: 'math', title: '数学' };
const a = courseRef(scope, { id: 'node-a', title: '同名节点' });
const b = courseRef(scope, { id: 'node-b', title: '同名节点' });
const other = { workspace: scope.workspace, subject: 'physics', node: 'p', title: '物理' };
const note = { id: 'note-1', type: 'note', parent: 'nested', title: '原件.md', markdown: '# 原稿\r\n\r\n-  保留空白\r\n', associations: [a, other] };
const folders = [{ id: 'library', name: '资源库', parent: null }, { id: 'book', name: '共享本', parent: 'library', kind: 'notebook', bindings: [scope, other], defaultForSubjects: [scope, other], viewport: { x: 42, y: -3, zoom: 0.75 } }, { id: 'nested', name: '旧目录', parent: 'book' }];
const node = { id: 'card', type: 'knowledge', data: { contentId: note.id, notebookId: 'book' }, position: { x: 1, y: 2 } };

test('课程身份只比较精确来源，不以显示名猜测替代节点', () => {
  assert.equal(sameSubject(a, b), true);
  assert.equal(sameCourse(a, b), false);
  assert.equal(sameCourse(a, { ...a, title: '改名' }), true);
  assert.equal(sameSubject(a, { ...a, workspace: 'D:\\另一个' }), false);
  const library = { workspace: scope.workspace, subjects: [{ slug: scope.subject, name: '数学', nodes: [{ id: a.node, title: '改名' }] }] };
  assert.equal(resolveCourse(library, a).node.title, '改名');
  assert.equal(resolveCourse(library, b), null);
  assert.equal(resolveCourse(library, { ...a, workspace: 'D:\\另一个' }), null);
  assert.equal(resolveCourse(library, { ...a, subject: 'renamed' }), null);
});

test('节点分类拖动只替换同科目关联，不改正文、内容身份、原件归属与其它科目', () => {
  const next = associateNote(note, b);
  assert.notEqual(next, note);
  assert.deepEqual(next.associations, [other, b]);
  for (const key of ['id', 'parent', 'title', 'markdown']) assert.equal(next[key], note[key]);
  assert.deepEqual(note.associations, [a, other]);
  assert.equal(notebookOf(next, folders).id, 'book');
  assert.equal(linkedNotes({ [next.id]: next }, a).length, 0);
  assert.equal(linkedNotes({ [next.id]: next }, b)[0].id, note.id);
});

test('分类关联有独立上限，拒绝重复科目和第33个科目，不截断原稿', () => {
  assert.throws(() => normalizeAssociations([a, b]), /一个节点/);
  const many = Array.from({ length: 32 }, (_, i) => ({ ...a, subject: 's' + i }));
  assert.equal(normalizeAssociations(many).length, 32);
  assert.throws(() => associateNote({ ...note, associations: many }, a), /32/);
  assert.equal(many.length, 32);
  assert.throws(() => normalizeCourseRef({ ...a, node: ' ' }), /node/);
  assert.throws(() => normalizeCourseRef({ ...a, workspace: 'x'.repeat(2001) }), /workspace/);
  assert.deepEqual(normalizeCourseRef({ ...a, body: '不能复制课程正文' }), a);
});

test('软删除可恢复，外部文件引用不是可分类的自有笔记', () => {
  const resources = { owned: note, trash: { ...note, id: 'trash', trashed: true }, external: { ...note, id: 'external', origin: { kind: 'file', mode: 'reference' } } };
  assert.deepEqual(linkedNotes(resources, a).map(item => item.id), [note.id]);
  assert.equal(linkedNotes(resources, a, true).length, 2);
  assert.equal(linkedNotes({ n: { ...resources.trash, trashed: false } }, a).length, 1);
  assert.equal(notebookOf(note, [{ id: 'nested', parent: 'nested' }]), null);
});

test('新增资源元信息往返保留原文，且不接受错误资源角色', () => {
  assert.deepEqual(hydrateResource(serializeResource({ ...note, trashed: false })), { ...note, trashed: false });
  const course = { id: 'course', type: 'course', title: a.title, courseRef: a };
  assert.deepEqual(hydrateResource(serializeResource(course)), course);
  assert.equal('markdown' in serializeResource(course), false);
  assert.throws(() => serializeResource({ ...note, courseRef: a }), /课程卡/);
  assert.throws(() => hydrateResource({ ...note, courseRef: a }), /课程卡/);
  assert.throws(() => serializeResource({ ...note, origin: { kind: 'file', mode: 'reference' } }), /自有笔记/);
  assert.throws(() => hydrateResource({ ...note, trashed: 'yes' }), /布尔/);
});

test('一本可绑定多个科目；默认与画布分区、相机跨序列化保留', () => {
  const layout = serializeLayout({ folders, nodes: [node], edges: [] });
  const result = hydrateLayout(layout);
  assert.deepEqual(result.folders, folders.map(folder => folder.kind === 'notebook' ? { ...folder, bindings: folder.bindings.map(ref => normalizeCourseRef(ref, { subjectOnly: true })), defaultForSubjects: folder.defaultForSubjects.map(ref => normalizeCourseRef(ref, { subjectOnly: true })) } : folder));
  assert.equal(result.nodes[0].data.notebookId, 'book');
  assert.deepEqual(result.folders[1].viewport, folders[1].viewport);
  assert.throws(() => serializeLayout({ folders, nodes: [{ ...node, data: { ...node.data, notebookId: 'missing' } }] }), /不存在/);
  assert.throws(() => hydrateLayout({ folders, nodes: [{ ...node, data: { ...node.data, notebookId: 'missing' } }] }), /不存在/);
  const duplicateDefault = [...folders, { id: 'book-2', name: '另一本', parent: null, kind: 'notebook', bindings: [scope], defaultForSubjects: [scope] }];
  assert.throws(() => serializeLayout({ folders: duplicateDefault }), /一个默认/);
  assert.throws(() => hydrateLayout({ folders: duplicateDefault }), /一个默认/);
  assert.throws(() => serializeLayout({ folders: [{ id: 'book', name: '本', parent: null, kind: 'notebook', defaultForSubjects: [scope] }] }), /先绑定/);
});

test('笔记本相机沿用宿主闭合边界，越界或额外字段不被静默清理', () => {
  const bookWithCamera = viewport => [{ ...folders[1], parent: null, viewport }];
  for (const viewport of [{ x: -1e6, y: 1e6, zoom: 0.01 }, { x: 1e6, y: -1e6, zoom: 10 }]) {
    assert.deepEqual(serializeLayout({ folders: bookWithCamera(viewport) }).folders[0].viewport, viewport);
  }
  for (const viewport of [null, { x: 1e6 + 1, y: 0, zoom: 1 }, { x: 0, y: -1e6 - 1, zoom: 1 }, { x: 0, y: 0, zoom: 0.009 }, { x: 0, y: 0, zoom: 11 }, { x: 0, y: 0, zoom: 1, extra: true }]) {
    assert.throws(() => serializeLayout({ folders: bookWithCamera(viewport) }), /viewport/);
    assert.throws(() => hydrateLayout({ folders: bookWithCamera(viewport), nodes: [], edges: [] }), /viewport/);
  }
  // 格式1全局视口不缩紧：这里只约束新增的笔记本相机。
  const legacyCamera = { x: 1e6 + 1, y: 0, zoom: 0.001 };
  assert.deepEqual(serializeLayout({ folders: [], viewport: legacyCamera }).viewport, legacyCamera);
});

test('格式1只读升级标志与格式2均可载入，未知格式显式拒绝', () => {
  const base = { ok: true, resources: {}, resourceVersions: {}, layout: null, layoutVersion: null };
  assert.equal(hydrateStore({ ...base, schemaVersion: 1, requiresUpgrade: true }).requiresUpgrade, true);
  assert.equal(hydrateStore({ ...base, schemaVersion: 1 }).requiresUpgrade, true);
  assert.equal(hydrateStore({ ...base, schemaVersion: 1, requiresUpgrade: false }).requiresUpgrade, true);
  assert.equal(hydrateStore({ ...base, schemaVersion: 2 }).requiresUpgrade, false);
  assert.throws(() => hydrateStore({ ...base, schemaVersion: 3 }), /schemaVersion/);
});

test('共享工作空间只发布状态与转发命令，不跨main串号或自行读写网络', () => {
  const bridge = createNotesWorkspace(), second = createNotesWorkspace();
  let notifications = 0, commandCalls = 0;
  const unsubscribe = bridge.subscribe(() => notifications++);
  assert.equal(bridge.getSnapshot().canEdit, false);
  const state = { resources: { [note.id]: note }, folders, canEdit: true };
  bridge.publish(state, { markdown(id, text) { commandCalls++; assert.equal(id, note.id); return text; } });
  assert.equal(bridge.getSnapshot(), state);
  assert.equal(bridge.dispatch('markdown', note.id, '原文'), '原文');
  assert.equal(commandCalls, 1);
  assert.equal(second.getSnapshot().canEdit, false);
  bridge.detach();
  assert.equal(bridge.dispatch('markdown', note.id, '无写入'), undefined);
  assert.equal(commandCalls, 1);
  assert.equal(notifications, 2);
  unsubscribe(); bridge.publish(state, {});
  assert.equal(notifications, 2);
});
