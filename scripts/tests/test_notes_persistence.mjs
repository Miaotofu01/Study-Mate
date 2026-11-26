/* 无界笔记 · 持久化序列化与保存控制（client/notes/persistence.js）· 纯 Node 测试
   跑法：`node --test scripts/tests/test_notes_persistence.mjs`
   覆盖：序列化白名单/strip 运行时字段、防 cachedref 副本、受控 dataURL 解析、
   严格布局校验（folder parent:null/kind、非法几何、超限一律 throw）、
   保存控制器（基线同值不发、首 null、在途编辑顺序/旧回包不丢 draft、409 不自动发、
   明确 keep 的 CAS 重试、500 后新 draft + retry、suspend/wait/clear 代际、不同 key 不互相污染）。
   浏览器路径（DOMParser/File 真实解析、宿主 fetch）不在本文件覆盖范围。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  serializeResource,
  serializeOrigin,
  hydrateResource,
  serializeLayout,
  hydrateLayout,
  createSaveController,
  fingerprintOf,
  hydrateStore,
  rehydrateMediaResource,
  serializeStableScene,
  isValidId,
  isFileReference,
  physicalKindOf,
  SaveState,
  LIMITS,
} from '../../client/notes/persistence.js';
import { corruptMessage } from '../../client/notes/corrupt.js';

// ---------------------------------------------------------------------------
// 序列化：strip runtime/refpayload/unknown origin
// ---------------------------------------------------------------------------

test('serializeResource 剥运行时句柄（sourceFile/fileHandle/refBody）', () => {
  const resource = {
    id: 'r-abc', type: 'note', title: 'T', parent: 'notes', owner: 'me',
    markdown: '# hi',
    sourceFile: { fake: 'file' }, fileHandle: { fake: 'handle' }, refBody: 'cached body',
    origin: { kind: 'workspace', mode: 'copy', sourceId: 'orig' },
  };
  const dto = serializeResource(resource);
  assert.equal('sourceFile' in dto, false);
  assert.equal('fileHandle' in dto, false);
  assert.equal('refBody' in dto, false);
  assert.equal(dto.markdown, '# hi');
});

test('serializeResource 剥 unknown origin 字段（canReopen，即使 false）', () => {
  const resource = {
    id: 'r-x', type: 'image', title: 'pic', parent: 'refs',
    origin: { kind: 'file', mode: 'reference', name: 'a.png', lastModified: 1, canReopen: false, evil: 'payload' },
  };
  const dto = serializeResource(resource);
  assert.equal('canReopen' in dto.origin, false);
  assert.equal('evil' in dto.origin, false);
  assert.equal(dto.origin.kind, 'file');
  assert.equal(dto.origin.mode, 'reference');
});

test('serializeResource 外部文件引用只留元信息，不带 markdown/html/src', () => {
  const resource = {
    id: 'r-ref', type: 'html', title: 'page', parent: 'refs',
    html: '<p>cached</p>', src: 'data:image/png;base64,xxx', markdown: '# cached',
    origin: { kind: 'file', mode: 'reference', name: 'p.html', lastModified: 0 },
  };
  const dto = serializeResource(resource);
  assert.equal('html' in dto, false);
  assert.equal('src' in dto, false);
  assert.equal('markdown' in dto, false);
});

test('serializeResource 自有 note/media 保留 markdown/html/src', () => {
  const note = serializeResource({ id: 'r-n', type: 'note', title: 'T', markdown: '# body', parent: 'notes' });
  assert.equal(note.markdown, '# body');
  const html = serializeResource({ id: 'r-h', type: 'html', title: 'P', html: '<p>ok</p>', parent: 'refs' });
  assert.equal(html.html, '<p>ok</p>');
  const img = serializeResource({ id: 'r-i', type: 'image', title: 'I', src: 'data:image/png;base64,zzz', parent: 'refs' });
  assert.equal(img.src, 'data:image/png;base64,zzz');
});

test('serializeResource 外部引用不限 type：note 引用也只存元信息', () => {
  const dto = serializeResource({
    id: 'r-nref', type: 'note', title: 'N', parent: 'refs',
    markdown: '# cached copy',
    origin: { kind: 'file', mode: 'reference', name: 'a.md', lastModified: 0 },
  });
  assert.equal('markdown' in dto, false);
  assert.equal(isFileReference(dto), true);
  assert.equal(physicalKindOf(dto), 'json');
  assert.equal(physicalKindOf({ type: 'note' }), 'md');
  assert.equal(physicalKindOf({ type: 'image' }), 'json');
});

test('serializeResource parent:null 是合法值，不被丢掉', () => {
  const dto = serializeResource({ id: 'r-root', type: 'note', title: 'T', parent: null, markdown: 'x' });
  assert.equal('parent' in dto, true);
  assert.equal(dto.parent, null);
});

test('serializeResource 非法 id / 非法 type 显式 throw（不静默丢资源）', () => {
  assert.throws(() => serializeResource({ id: 'R_BAD', type: 'note', markdown: 'x' }), /id/);
  assert.throws(() => serializeResource({ id: 'r-ok', type: 'weird', markdown: 'x' }), /type/);
});

test('serializeResource 超限元信息/正文显式 throw（不静默截断）', () => {
  assert.throws(
    () => serializeResource({ id: 'r-a', type: 'note', title: 'x'.repeat(LIMITS.maxMetaChars + 1), markdown: 'y' }),
    /字符上限/,
  );
  assert.throws(
    () => serializeResource({ id: 'r-a', type: 'note', markdown: 'x'.repeat(LIMITS.maxNoteChars + 1) }),
    /字符上限/,
  );
});

test('serializeOrigin 白名单只留 kind/mode/name/lastModified/sourceId', () => {
  const origin = serializeOrigin({ kind: 'file', mode: 'copy', name: 'x', lastModified: 5, sourceId: 's', canReopen: true, extra: 1 });
  assert.deepEqual(Object.keys(origin).sort(), ['kind', 'lastModified', 'mode', 'name', 'sourceId']);
});

test('hydrateResource 外部引用补 referenceError + canReopen=false，不回填句柄', () => {
  const mem = hydrateResource({ id: 'r-r', type: 'image', title: 'I', origin: { kind: 'file', mode: 'reference', name: 'a.png', lastModified: 0 } });
  assert.equal(mem.origin.canReopen, false);
  assert.ok(mem.referenceError.length > 0);
  assert.equal('sourceFile' in mem, false);
  assert.equal('fileHandle' in mem, false);
});

// ---------------------------------------------------------------------------
// 防 cachedref 副本：引用发送绝不用缓存
// ---------------------------------------------------------------------------

test('hydrateResource 对外部引用不带 src/html/markdown（缓存不能作副本）', () => {
  const mem = hydrateResource({ id: 'r-r', type: 'html', title: 'P', html: '<p>cached</p>', src: 'data:...', origin: { kind: 'file', mode: 'reference', name: 'p.html', lastModified: 0 } });
  assert.equal('html' in mem, false);
  assert.equal('src' in mem, false);
  assert.equal('markdown' in mem, false);
});

// ---------------------------------------------------------------------------
// 稳态场景序列化
// ---------------------------------------------------------------------------

test('serializeStableScene 剥 selected/dragging/resizing/measured', () => {
  const scene = {
    nodes: [{ id: 'n1', type: 'knowledge', position: { x: 1, y: 2 }, selected: true, dragging: true, resizing: false, measured: { w: 3 }, style: { width: 300, height: 200 }, data: { contentId: 'r-1', collapsed: false } }],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', selected: true, type: 'relation', data: { label: 'L' } }],
  };
  const out = serializeStableScene(scene);
  assert.equal('selected' in out.nodes[0], false);
  assert.equal('dragging' in out.nodes[0], false);
  assert.equal('resizing' in out.nodes[0], false);
  assert.equal('measured' in out.nodes[0], false);
  assert.equal('selected' in out.edges[0], false);
  assert.equal(out.nodes[0].data.contentId, 'r-1');
  assert.equal(out.edges[0].data.label, 'L');
});

// ---------------------------------------------------------------------------
// 布局序列化：folder parent:null 与 kind 原样保留；非法几何/超限一律 throw
// ---------------------------------------------------------------------------

test('serializeLayout folder parent:null 保持 null 且保 kind（不造 library 自环）', () => {
  const layout = serializeLayout({
    folders: [
      { id: 'library', name: '我的资料', parent: null, kind: 'folder' },
      { id: 'book', name: '学习与理解', parent: 'library', kind: 'notebook' },
    ],
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  });
  assert.equal(layout.folders[0].parent, null);
  assert.equal(layout.folders[0].kind, 'folder');
  assert.equal(layout.folders[1].parent, 'library');
  assert.equal(layout.folders[1].kind, 'notebook');
});

test('hydrateLayout 同样保留 folder parent:null 与 kind', () => {
  const layout = hydrateLayout({
    folders: [{ id: 'library', name: 'L', parent: null, kind: 'folder' }],
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  });
  assert.equal(layout.folders[0].parent, null);
  assert.equal(layout.folders[0].kind, 'folder');
});

test('serializeLayout nodes 只保留白名单 data 字段', () => {
  const layout = serializeLayout({
    folders: [{ id: 'f1', name: 'F', parent: 'library' }],
    nodes: [{ id: 'n1', type: 'text', position: { x: 0, y: 0 }, style: { width: 300, height: 150 }, data: { text: 'hello', selected: true, evil: 'x', collapsed: true, expandedHeight: 255 } }],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'relation', data: { label: 'L', evil: 1 } }],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  const node = layout.nodes[0];
  assert.deepEqual(Object.keys(node.data).sort(), ['collapsed', 'expandedHeight', 'text']);
  assert.equal(node.data.text, 'hello');
  const edge = layout.edges[0];
  assert.deepEqual(Object.keys(edge.data), ['label']);
});

test('hydrateLayout 复原 edge marker/styles 用 fixture 默认值，且不强加 dragHandle', () => {
  const layout = hydrateLayout({
    folders: [],
    nodes: [
      { id: 'n1', type: 'knowledge', position: { x: 0, y: 0 }, style: { width: 310, height: 255 }, data: { contentId: 'r-1' } },
      { id: 't1', type: 'text', position: { x: 40, y: 50 }, style: { width: 260, height: 84 }, data: { text: '两行内容' } },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 't1', type: 'relation', data: { label: 'L' } }],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  assert.equal('dragHandle' in layout.nodes[0], false);
  assert.equal('dragHandle' in layout.nodes[1], false);
  const edge = layout.edges[0];
  assert.equal(edge.markerEnd.type, 'arrowclosed');
  assert.equal(edge.style.stroke, '#9caea7');
});

test('serializeLayout 优先保存缩放后的顶层 width/height 到 style', () => {
  const layout = serializeLayout({
    folders: [],
    nodes: [
      { id: 'n1', type: 'knowledge', position: { x: 0, y: 0 }, width: 380, height: 360, style: { width: 310, height: 255 }, data: { contentId: 'r-1' } },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  assert.deepEqual(layout.nodes[0].style, { width: 380, height: 360 });
  assert.equal('width' in layout.nodes[0], false);
  assert.equal('height' in layout.nodes[0], false);
});

test('serializeLayout 非法几何显式 throw（不静默归 0）', () => {
  assert.throws(
    () => serializeLayout({ folders: [], edges: [], viewport: null, nodes: [{ id: 'n1', type: 'text', position: { x: NaN, y: 0 }, data: {} }] }),
    /position/,
  );
  assert.throws(
    () => serializeLayout({ folders: [], edges: [], viewport: { x: 0, y: 0, zoom: Infinity }, nodes: [] }),
    /zoom/,
  );
  assert.throws(
    () => serializeLayout({ folders: [], edges: [], viewport: null, nodes: [{ id: 'n1', type: 'knowledge', position: { x: 1, y: 2 }, data: {} }] }),
    /contentId/,
  );
});

test('serializeLayout/hydrateLayout 超限显式 throw（不静默丢节点）', () => {
  const manyNodes = Array.from({ length: LIMITS.maxNodes + 1 }, (_, i) => ({
    id: 'n' + i, type: 'text', position: { x: 0, y: 0 }, data: { text: 't' },
  }));
  assert.throws(() => serializeLayout({ folders: [], nodes: manyNodes, edges: [], viewport: null }), /节点数量/);
  const manyFolders = Array.from({ length: LIMITS.maxFolders + 1 }, (_, i) => ({ id: 'f' + i, name: 'n', parent: null }));
  assert.throws(() => serializeLayout({ folders: manyFolders, nodes: [], edges: [], viewport: null }), /目录数量/);
  const manyEdges = Array.from({ length: LIMITS.maxEdges + 1 }, (_, i) => ({ id: 'e' + i, source: 'a', target: 'b', type: 'relation', data: { label: 'l' } }));
  assert.throws(() => serializeLayout({ folders: [], nodes: [], edges: manyEdges, viewport: null }), /连线数量/);
});

test('节点文字/连线标签超限显式 throw', () => {
  assert.throws(
    () => serializeLayout({ folders: [], edges: [], viewport: null, nodes: [{ id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: { text: 'x'.repeat(LIMITS.maxNodeTextChars + 1) } }] }),
    /字符上限/,
  );
  assert.throws(
    () => serializeLayout({ folders: [], nodes: [], viewport: null, edges: [{ id: 'e1', source: 'a', target: 'b', type: 'relation', data: { label: 'x'.repeat(LIMITS.maxEdgeLabelChars + 1) } }] }),
    /字符上限/,
  );
});

// ---------------------------------------------------------------------------
// 载入：必须认 schemaVersion，无效响应拒绝（不回 demo、不空库伪成功）
// ---------------------------------------------------------------------------

test('hydrateStore 返回 resources/layout/resourceVersions/storeId', () => {
  const store = hydrateStore({
    ok: true, schemaVersion: 1, storeId: 'store-1',
    resources: { 'r-1': { id: 'r-1', type: 'note', title: 'T', markdown: '# x' } },
    resourceVersions: { 'r-1': 'h1' },
    layout: { folders: [], nodes: [], edges: [], viewport: null },
    layoutVersion: 'lh',
  });
  assert.equal(store.resources['r-1'].markdown, '# x');
  assert.equal(store.resourceVersions['r-1'], 'h1');
  assert.equal(store.layoutVersion, 'lh');
  assert.equal(store.storeId, 'store-1');
  assert.ok(store.layout);
});

test('hydrateStore 拒绝无效 GET 响应（schemaVersion/形状不对就 throw，不伪成功）', () => {
  assert.throws(() => hydrateStore({ ok: true, resources: {}, resourceVersions: {}, layout: null, layoutVersion: null }), /schemaVersion/);
  assert.throws(() => hydrateStore({ ok: true, schemaVersion: 3, resources: {} }), /schemaVersion/);
  assert.throws(() => hydrateStore({ ok: true, schemaVersion: 1, resources: [] }), /resources/);
  assert.throws(() => hydrateStore({ ok: true, schemaVersion: 1, resources: {}, resourceVersions: 5 }), /resourceVersions/);
  assert.throws(() => hydrateStore({ ok: true, schemaVersion: 1, resources: { 'r-1': { id: 'R_BAD' } } }), /id/);
  assert.throws(() => hydrateStore(null), /JSON 对象/);
});

// ---------------------------------------------------------------------------
// 媒体重入：引用不重建；文件名按 type/mime 而非用户 title
// ---------------------------------------------------------------------------

test('rehydrateMediaResource 外部引用不尝试重建、不缓存副本', async () => {
  let called = 0;
  const readMediaFile = async () => { called++; return { type: 'image', title: 'x' }; };
  const resource = {
    id: 'r-ref', type: 'image', title: 'pic', html: '<svg></svg>', src: 'data:image/png;base64,AAAA',
    origin: { kind: 'file', mode: 'reference', name: 'a.png', lastModified: 0 },
  };
  const out = await rehydrateMediaResource(resource, { readMediaFile });
  assert.equal(called, 0);
  assert.equal(out.src, resource.src);
  assert.equal(out.origin.canReopen, undefined);
});

test('rehydrateMediaResource 图片用 canonical 文件名（不取用户 title），只接受 png/jpeg/webp', async () => {
  const seen = [];
  const readMediaFile = async (file) => { seen.push(file); return { type: 'image', title: file.name, mime: file.type, bytes: file.size, src: 'data:image/png;base64,AAAA' }; };
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const out = await rehydrateMediaResource({ id: 'r-i', type: 'image', title: '我的照片', src: png }, { readMediaFile });
  assert.equal(seen[0].name, 'image.png');
  assert.equal(seen[0].type, 'image/png');
  assert.equal(out.title, '我的照片');
  assert.equal(out.id, 'r-i');
  await assert.rejects(
    () => rehydrateMediaResource({ id: 'r-i', type: 'image', title: 'x', src: 'data:image/gif;base64,AAAA' }, { readMediaFile }),
    /png\/jpeg\/webp/,
  );
});

test('rehydrateMediaResource html 用 canonical.html；svg 抽单个 svg 元素走 SVG 入口', async () => {
  const seen = [];
  const readMediaFile = async (file) => { seen.push(file); return { type: file.type, title: file.name, html: '<html></html>', bytes: file.size }; };
  await rehydrateMediaResource({ id: 'r-h', type: 'html', title: '页面', html: '<p>x</p>' }, { readMediaFile });
  assert.equal(seen[0].name, 'media.html');
  assert.equal(seen[0].type, 'text/html');

  await rehydrateMediaResource({ id: 'r-s', type: 'svg', title: '图', html: '<div><svg viewBox="0 0 1 1"><rect/></svg></div>' }, { readMediaFile });
  assert.equal(seen[1].name, 'media.svg');
  assert.equal(seen[1].type, 'image/svg+xml');
  const text = await seen[1].text();
  assert.match(text, /^<svg/);
  assert.equal(text.includes('<div'), false);
});

// ---------------------------------------------------------------------------
// fingerprint：稳定、与 key 顺序无关
// ---------------------------------------------------------------------------

test('fingerprintOf 与对象 key 顺序无关', () => {
  assert.equal(fingerprintOf({ x: 1, y: 2 }), fingerprintOf({ y: 2, x: 1 }));
});

test('fingerprintOf 内容不同则不同', () => {
  assert.notEqual(fingerprintOf({ x: 1 }), fingerprintOf({ x: 2 }));
});

// ---------------------------------------------------------------------------
// 保存控制器
// ---------------------------------------------------------------------------

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

function recordingTransport() {
  const calls = [];
  const gates = [];
  return {
    calls, gates,
    async saveResource(resource, expectedVersion) {
      const d = deferred();
      gates.push({ kind: 'resource', resource, expectedVersion, d });
      calls.push({ kind: 'resource', id: resource.id, expectedVersion });
      return d.promise;
    },
    async saveLayout(layout, expectedVersion) {
      const d = deferred();
      gates.push({ kind: 'layout', layout, expectedVersion, d });
      calls.push({ kind: 'layout', expectedVersion });
      return d.promise;
    },
  };
}

test('与基线同值不发请求；基线不同则发', async () => {
  const transport = recordingTransport();
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  const dto = { id: 'r-1', type: 'note', markdown: 'v1' };
  controller.loadBase('r-1', 'ver-1', dto);
  controller.saveResource({ ...dto });
  await tick(10);
  assert.equal(transport.calls.length, 0);
  assert.equal(controller.getStatus('r-1').state, SaveState.SAVED);
  assert.equal(controller.getStatus('r-1').baseVersion, 'ver-1');

  controller.saveResource({ id: 'r-1', type: 'note', markdown: 'v2' });
  await tick(10);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].expectedVersion, 'ver-1');
});

test('首次保存 expectedVersion 为 null', async () => {
  const transport = recordingTransport();
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  controller.saveResource({ id: 'r-new', type: 'note', markdown: 'x' });
  await tick(10);
  assert.equal(transport.calls[0].expectedVersion, null);
});

test('在途编辑：旧回包不丢新草稿；新草稿用新 base 版本续存', async () => {
  const transport = recordingTransport();
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  controller.saveResource({ id: 'r-1', type: 'note', markdown: 'v1' });
  await tick(10);
  assert.equal(transport.gates.length, 1);
  assert.equal(transport.gates[0].resource.markdown, 'v1');
  assert.equal(transport.gates[0].expectedVersion, null);

  controller.saveResource({ id: 'r-1', type: 'note', markdown: 'v2' });
  transport.gates[0].d.resolve({ version: 'ver-v1' });
  await tick(10);

  const status = controller.getStatus('r-1');
  assert.equal(status.dirty, true);
  assert.equal(status.draft.markdown, 'v2');
  assert.equal(status.baseVersion, 'ver-v1');

  await tick(10);
  assert.equal(transport.gates.length, 2);
  assert.equal(transport.gates[1].resource.markdown, 'v2');
  assert.equal(transport.gates[1].expectedVersion, 'ver-v1');
  transport.gates[1].d.resolve({ version: 'ver-v2' });
  await tick(10);
  assert.equal(controller.getStatus('r-1').state, SaveState.SAVED);
  assert.equal(controller.isDirty(), false);
  assert.equal(controller.getStatus('r-1').draft, null);
});

// 模拟请求在途期间已排队的下一次 debounce；不靠机器速度碰运气。
for (const kind of ['resource', 'layout']) {
  for (const stoppedState of [SaveState.CONFLICT, SaveState.ERROR]) {
    test(`${kind}：在途失败后旧 debounce 不再发，回到旧基线也不解除 ${stoppedState}`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const transport = recordingTransport();
      const controller = createSaveController({ transport, debounceMs: 50, fingerprintOf });
      const key = kind === 'resource' ? 'r-stopped' : '__layout__';
      const payload = value => kind === 'resource'
        ? { id: key, type: 'note', markdown: `draft-${value}` }
        : { folders: [], nodes: [], edges: [], viewport: { x: value, y: 0, zoom: 1 } };
      const submit = value => kind === 'resource'
        ? controller.saveResource(payload(value)) : controller.saveLayout(payload(value));
      const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
      try {
        controller.loadBase(key, 'base-version', payload(0));
        submit(1);
        t.mock.timers.tick(50);
        assert.equal(transport.calls.length, 1);
        submit(2); // 第一请求尚未回包，这个定时器已排队。
        const error = Object.assign(new Error(stoppedState), stoppedState === SaveState.CONFLICT
          ? { code: 'version-conflict', version: 'server-version', current: payload(9) }
          : { code: 'network' });
        transport.gates[0].d.reject(error);
        await settle();
        assert.equal(controller.getStatus(key).state, stoppedState);
        submit(3);
        t.mock.timers.tick(1000);
        await settle();
        assert.equal(transport.calls.length, 1, '旧定时器不得在失败后自动重发最新草稿');
        assert.deepEqual(controller.getStatus(key).draft, payload(3));
        assert.equal(controller.getStatus(key).baseVersion, 'base-version');

        // 回到旧客户端基线不表示服务端已接受，仍须用户明确处理。
        submit(0);
        t.mock.timers.tick(1000);
        await settle();
        assert.equal(controller.getStatus(key).state, stoppedState);
        assert.deepEqual(controller.getStatus(key).draft, payload(0));
        assert.equal(transport.calls.length, 1);
        submit(3);
        if (stoppedState === SaveState.CONFLICT) controller.resolveConflict(key, { discard: false });
        else controller.retry(key);
        assert.equal(transport.calls.length, 2, '只有明确处理才允许再次提交');
        const second = transport.gates[1];
        assert.deepEqual(kind === 'resource' ? second.resource : second.layout, payload(3));
        assert.equal(second.expectedVersion, stoppedState === SaveState.CONFLICT ? 'server-version' : 'base-version');
        second.d.resolve({ version: 'saved-version' });
        await settle();
        assert.equal(controller.getStatus(key).state, SaveState.SAVED);
        assert.equal(controller.getStatus(key).draft, null);
      } finally {
        controller.dispose();
      }
    });
  }
}

test('409 冲突：停下、不自动再发、草稿保留；继续编辑仍取最新草稿且不自动发', async () => {
  let attempts = 0;
  const transport = {
    async saveResource(resource, expectedVersion) {
      attempts++;
      const err = new Error('conflict');
      err.code = 'version-conflict';
      err.current = { id: resource.id, markdown: 'server' };
      err.version = 'server-ver';
      throw err;
    },
    async saveLayout() { return { version: 'lv' }; },
  };
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  controller.saveResource({ id: 'r-c', type: 'note', markdown: 'local' });
  await tick(10);
  const status = controller.getStatus('r-c');
  assert.equal(status.state, SaveState.CONFLICT);
  assert.equal(status.conflict.version, 'server-ver');
  assert.equal(status.dirty, true);
  await tick(20);
  assert.equal(attempts, 1);

  // 冲突后继续编辑：草稿更新为最新，但**不自动再发**
  controller.saveResource({ id: 'r-c', type: 'note', markdown: 'local-2' });
  await tick(20);
  assert.equal(attempts, 1);
  assert.equal(controller.getStatus('r-c').draft.markdown, 'local-2');
  assert.equal(controller.getStatus('r-c').state, SaveState.CONFLICT);
});

test('明确 keep：resolveConflict(discard:false) 以服务器版本作 CAS 基准保存最新本地草稿', async () => {
  const seen = [];
  const transport = {
    async saveResource(resource, expectedVersion) {
      seen.push({ markdown: resource.markdown, expectedVersion });
      if (seen.length === 1) {
        const err = new Error('conflict');
        err.code = 'version-conflict';
        err.current = { id: resource.id };
        err.version = 'server-ver';
        throw err;
      }
      return { version: 'new-ver' };
    },
    async saveLayout() { return { version: 'lv' }; },
  };
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  controller.saveResource({ id: 'r-k', type: 'note', markdown: 'mine' });
  await tick(10);
  assert.equal(controller.getStatus('r-k').state, SaveState.CONFLICT);
  controller.saveResource({ id: 'r-k', type: 'note', markdown: 'mine-2' });
  await tick(5);

  controller.resolveConflict('r-k', { discard: false });
  await tick(10);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].markdown, 'mine-2');
  assert.equal(seen[1].expectedVersion, 'server-ver');
  assert.equal(controller.getStatus('r-k').state, SaveState.SAVED);
  assert.equal(controller.getStatus('r-k').baseVersion, 'new-ver');
});

test('resolveConflict(discard:true) 只清这个 key 的草稿与基线', async () => {
  const transport = {
    async saveResource() {
      const err = new Error('conflict');
      err.code = 'version-conflict';
      err.version = 'server-ver';
      throw err;
    },
    async saveLayout() { return { version: 'lv' }; },
  };
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  controller.saveResource({ id: 'r-d', type: 'note', markdown: 'x' });
  await tick(10);
  assert.equal(controller.getStatus('r-d').state, SaveState.CONFLICT);
  controller.resolveConflict('r-d', { discard: true });
  const status = controller.getStatus('r-d');
  assert.equal(status.draft, null);
  assert.equal(status.dirty, false);
  assert.equal(status.baseVersion, null);
  assert.equal(status.state, SaveState.IDLE);
});

test('500 失败后新草稿被收下（不自动发），显式 retry 用最新草稿', async () => {
  let fail = true;
  let attempts = 0;
  const transport = {
    async saveResource(resource) {
      attempts++;
      if (fail) { const e = new Error('net'); e.code = 'network'; throw e; }
      return { version: 'v' };
    },
    async saveLayout() { return { version: 'lv' }; },
  };
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  controller.saveResource({ id: 'r-e', type: 'note', markdown: 'x' });
  await tick(10);
  assert.equal(controller.getStatus('r-e').state, SaveState.ERROR);
  assert.equal(controller.isDirty(), true);

  // 失败后继续编辑：草稿更新，不自动重发
  controller.saveResource({ id: 'r-e', type: 'note', markdown: 'y' });
  await tick(20);
  assert.equal(attempts, 1);
  assert.equal(controller.getStatus('r-e').draft.markdown, 'y');

  fail = false;
  controller.retry('r-e');
  await tick(10);
  assert.equal(attempts, 2);
  assert.equal(controller.getStatus('r-e').state, SaveState.SAVED);
  assert.equal(controller.getStatus('r-e').dirty, false);
});

test('retry() 不带 key 重试全部 ERROR', async () => {
  let failing = true;
  const attempts = [];
  const transport = {
    async saveResource(resource) {
      attempts.push(resource.id);
      if (failing) { const e = new Error('net'); e.code = 'network'; throw e; }
      return { version: 'v' };
    },
    async saveLayout() { return { version: 'lv' }; },
  };
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  controller.saveResource({ id: 'r-1', type: 'note', markdown: 'a' });
  controller.saveResource({ id: 'r-2', type: 'note', markdown: 'b' });
  await tick(10);
  assert.equal(controller.getStatus('r-1').state, SaveState.ERROR);
  assert.equal(controller.getStatus('r-2').state, SaveState.ERROR);
  failing = false;
  controller.retry();
  await tick(10);
  assert.equal(controller.getStatus('r-1').state, SaveState.SAVED);
  assert.equal(controller.getStatus('r-2').state, SaveState.SAVED);
  assert.equal(attempts.length, 4);
});

test('不同 key 不互相污染：各自 base/草稿/状态独立', async () => {
  const transport = recordingTransport();
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  controller.saveResource({ id: 'r-1', type: 'note', markdown: 'a' });
  controller.saveResource({ id: 'r-2', type: 'note', markdown: 'b' });
  await tick(10);
  const g1 = transport.gates.find(g => g.resource.id === 'r-1');
  const g2 = transport.gates.find(g => g.resource.id === 'r-2');
  g1.d.resolve({ version: 'v1' });
  g2.d.resolve({ version: 'v2' });
  await tick(10);
  assert.equal(controller.getStatus('r-1').state, SaveState.SAVED);
  assert.equal(controller.getStatus('r-2').state, SaveState.SAVED);
  assert.equal(controller.getStatus('r-1').baseVersion, 'v1');
  assert.equal(controller.getStatus('r-2').baseVersion, 'v2');
  const statuses = controller.getStatuses();
  assert.deepEqual(Object.keys(statuses).sort(), ['r-1', 'r-2']);
  assert.equal(statuses['r-1'].dirty, false);
});

test('loadBase 在链脏时不丢草稿、不动基线', async () => {
  const transport = recordingTransport();
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  controller.saveResource({ id: 'r-1', type: 'note', markdown: 'v1' });
  await tick(10);
  controller.saveResource({ id: 'r-1', type: 'note', markdown: 'v2' });
  controller.loadBase('r-1', 'other-ver', { id: 'r-1', markdown: 'v1' });
  const status = controller.getStatus('r-1');
  assert.equal(status.draft.markdown, 'v2');
  assert.equal(status.baseVersion, null);
});

test('suspendAndWait：禁止新 outbound，等待已发请求 settle；resume 后继续调度', async () => {
  const transport = recordingTransport();
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  controller.saveResource({ id: 'r-1', type: 'note', markdown: 'v1' });
  await tick(10);
  assert.equal(transport.gates.length, 1);

  let settled = false;
  const waiting = controller.suspendAndWait().then(() => { settled = true; });
  // 挂起期间新草稿只收不发
  controller.saveResource({ id: 'r-1', type: 'note', markdown: 'v2' });
  await tick(20);
  assert.equal(transport.gates.length, 1);
  assert.equal(settled, false);

  transport.gates[0].d.resolve({ version: 'ver-1' });
  await waiting;
  assert.equal(settled, true);
  // 草稿仍在
  assert.equal(controller.getStatus('r-1').draft.markdown, 'v2');

  controller.resume();
  await tick(10);
  assert.equal(transport.gates.length, 2);
  assert.equal(transport.gates[1].resource.markdown, 'v2');
});

test('suspend 取消 debounce 定时器（挂起期间不会自己发出去）', async () => {
  const transport = recordingTransport();
  const controller = createSaveController({ transport, debounceMs: 50, fingerprintOf });
  controller.saveResource({ id: 'r-1', type: 'note', markdown: 'v1' });
  await controller.suspendAndWait();
  await tick(80);
  assert.equal(transport.gates.length, 0);
  assert.equal(controller.getStatus('r-1').draft.markdown, 'v1');
});

test('clear：清空链并推进代际，迟到回包不能污染新 base', async () => {
  const transport = recordingTransport();
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  controller.saveResource({ id: 'r-1', type: 'note', markdown: 'v1' });
  await tick(10);
  assert.equal(transport.gates.length, 1);

  controller.clear();
  controller.loadBase('r-1', 'fresh-ver', { id: 'r-1', markdown: 'server' });
  assert.equal(controller.getStatus('r-1').baseVersion, 'fresh-ver');

  // 旧的回包迟到
  transport.gates[0].d.resolve({ version: 'stale-ver' });
  await tick(20);
  const status = controller.getStatus('r-1');
  assert.equal(status.baseVersion, 'fresh-ver');
  assert.equal(status.baseFingerprint, fingerprintOf({ id: 'r-1', markdown: 'server' }));
  assert.equal(status.dirty, false);
});

test('dispose 后迟到回包不再改状态，也不发新请求', async () => {
  const transport = recordingTransport();
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  controller.saveResource({ id: 'r-1', type: 'note', markdown: 'v1' });
  await tick(10);
  controller.dispose();
  transport.gates[0].d.resolve({ version: 'v1' });
  await tick(20);
  assert.equal(controller.getStatus('r-1').state, SaveState.IDLE);
  controller.saveResource({ id: 'r-2', type: 'note', markdown: 'z' });
  await tick(20);
  assert.equal(transport.gates.length, 1);
});

test('重复提交与在途目标相同的草稿不生成第二次保存', async () => {
  const transport = recordingTransport();
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  const dto = { id: 'r-1', type: 'note', markdown: 'v1' };
  controller.saveResource(dto);
  controller.saveResource({ ...dto });
  await tick(20);
  assert.equal(transport.gates.length, 1);
});

test('subscribe 在每次状态变化时通知，且可用返回值退订', async () => {
  const transport = recordingTransport();
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  let count = 0;
  const off = controller.subscribe(() => { count++; });
  controller.saveResource({ id: 'r-1', type: 'note', markdown: 'v1' });
  await tick(10);
  assert.ok(count > 0);
  const before = count;
  off();
  controller.saveResource({ id: 'r-2', type: 'note', markdown: 'v2' });
  await tick(10);
  assert.equal(count, before);
});

// ---------------------------------------------------------------------------
// 独立 resource/layout 提交
// ---------------------------------------------------------------------------

test('独立 resource/layout 提交：saveLayout 独立于 saveResource', async () => {
  const calls = [];
  const transport = {
    async saveResource(resource, expectedVersion) { calls.push(['resource', resource.id]); return { resource, version: 'r' }; },
    async saveLayout(layout, expectedVersion) { calls.push(['layout', expectedVersion]); return { layout, version: 'l' }; },
  };
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  controller.saveLayout({ folders: [], nodes: [], edges: [], viewport: null });
  await tick(10);
  assert.equal(calls[0][0], 'layout');
  assert.equal(controller.getStatus('__layout__').state, SaveState.SAVED);
});

test('layout 基线同值不发请求', async () => {
  const transport = recordingTransport();
  const controller = createSaveController({ transport, debounceMs: 0, fingerprintOf });
  const layout = { folders: [], nodes: [], edges: [], viewport: null };
  controller.loadBase('__layout__', 'lv-1', layout);
  controller.saveLayout({ ...layout });
  await tick(10);
  assert.equal(transport.gates.length, 0);
});

test('isValidId 拒绝大写/非法字符/超长', () => {
  assert.equal(isValidId('r-abc-123'), true);
  assert.equal(isValidId('r-ABC'), false);
  assert.equal(isValidId('r_x'), false);
  assert.equal(isValidId(''), false);
  assert.equal(isValidId('a'.repeat(97)), false);
});

test('LIMITS 上限存在且合理', () => {
  assert.equal(LIMITS.maxNoteChars, 128 * 1024);
  assert.equal(LIMITS.maxNoteBytes, 512 * 1024);
  assert.equal(LIMITS.maxResources, 250);
  assert.equal(LIMITS.maxNodes, 120);
  assert.equal(LIMITS.maxEdges, 240);
  assert.equal(LIMITS.maxFolders, 80);
  assert.equal(LIMITS.maxMetaChars, 2000);
  assert.equal(LIMITS.maxNodeTextChars, 20000);
  assert.equal(LIMITS.maxEdgeLabelChars, 500);
});


/* ── #304 坏资源清单的 hydrate 与三档文案 ─────────────────────────────────── */

function storePayload(extra = {}) {
  return {
    ok: true, schemaVersion: 2, requiresUpgrade: false, storeId: 'notes-test',
    resources: {}, resourceVersions: {}, layout: null, layoutVersion: null, ...extra,
  };
}

test('hydrateStore 缺省 corrupt 为空数组，显式清单按白名单收下', () => {
  assert.deepEqual(hydrateStore(storePayload()).corrupt, []);
  const payload = storePayload({
    corrupt: [{
      id: 'bad', kind: 'json', notebook: '笔记本甲', message: '资源文件已损坏，暂时无法载入。',
      title: '坏链接', associations: [{ workspace: 'ws', subject: 'math', node: 'n-1', title: '数学' }],
    }],
  });
  const parsed = hydrateStore(payload);
  assert.equal(parsed.corrupt.length, 1);
  assert.equal(parsed.corrupt[0].title, '坏链接');
  assert.equal(parsed.corrupt[0].notebook, '笔记本甲');
  assert.equal(parsed.corrupt[0].associations[0].node, 'n-1');
});

test('hydrateStore 拒绝非数组/坏 kind/超长 title/坏课程关联', () => {
  assert.throws(() => hydrateStore(storePayload({ corrupt: {} })), /corrupt 必须是数组/);
  assert.throws(() => hydrateStore(storePayload({ corrupt: [{ id: 'bad', kind: 'txt', notebook: null, message: 'x' }] })), /kind 非法/);
  assert.throws(() => hydrateStore(storePayload({ corrupt: [{ id: 'bad', kind: 'md', notebook: null, message: 'x', title: 'a'.repeat(2001) }] })), /title 非法/);
  assert.throws(() => hydrateStore(storePayload({ corrupt: [{ id: 'bad', kind: 'md', notebook: null, message: 'x', associations: [{ workspace: 'ws' }] }] })), /课程关联非法/);
});

test('corruptMessage 按课程 → 笔记本 → 未知逐档降级，不猜课程', () => {
  const courseLibrary = { workspace: 'ws', subjects: [{ slug: 'math', name: '数学', nodes: [{ id: 'n-1', title: '数学课' }] }] };
  const folders = [{ id: 'nb', kind: 'notebook', name: '笔记本甲' }];
  const scene = { nodes: [{ data: { contentId: 'bad', notebookId: 'nb' } }] };
  const base = { id: 'bad', kind: 'md', notebook: '笔记本甲', message: '资源文件已损坏，暂时无法载入。' };
  assert.equal(
    corruptMessage({ ...base, title: '坏笔记', associations: [{ workspace: 'ws', subject: 'math', node: 'n-1' }] }, courseLibrary, folders, scene),
    '课程「数学课」下的笔记「坏笔记」的文件已损坏，未载入；其余笔记可正常编辑。',
  );
  assert.equal(
    corruptMessage(base, courseLibrary, folders, scene),
    '笔记本「笔记本甲」中的资源「bad」的文件已损坏，未载入。',
  );
  assert.equal(
    corruptMessage({ ...base, notebook: null }, courseLibrary, [], { nodes: [] }),
    '元数据损坏、无法确定课程（文件 bad）：内容无法解析，未载入。',
  );
  // workspace 不匹配时不拿坏文件里的课程标题猜课程，退到笔记本档。
  assert.equal(
    corruptMessage({ ...base, title: '坏笔记', associations: [{ workspace: 'other', subject: 'math', node: 'n-1', title: '别处课程' }] }, courseLibrary, folders, scene),
    '笔记本「笔记本甲」中的资源「坏笔记」的文件已损坏，未载入。',
  );
});
