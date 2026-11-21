/* 无界笔记持久化 · `lib/notes/route.ts` 的 Node 回归（#268）
   ────────────────────────────────────────────────────────────────────────
   这一套钉的是**HTTP 那一层**的外部契约：URL、状态码、错误信封、GET/POST 的形状。
   存储层的文件格式与锁在 `test_notes_store.mjs`，不重复。

   工作区在 `fs.mkdtempSync` 造的临时 HOME 里现造现弃（ADR-0009：仓库里不存样例数据），
   绝不碰真实 DSH 目录、也不起真实宿主（直接调 `handleNotes`，不起 3080）。
   ──────────────────────────────────────────────────────────────────────── */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { handleNotes, NOTES_PATH } from '../../lib/notes/route.ts';
import { notesRoot } from '../../lib/notes/store.ts';

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不阻断测试结果。
    }
  }
});

function makeHome() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-notes-route-'));
  TEMPS.push(root);
  return root;
}

// Request 要绝对 URL；路由只读 method/body，不看 host。
const ORIGIN = 'http://notes.test';

function postJson(body) {
  return new Request(`${ORIGIN}${NOTES_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function noteResource(id, overrides = {}) {
  return {
    id,
    type: 'note',
    title: '示例笔记',
    parent: 'notes',
    owner: '我',
    markdown: '# 你好\n\n正文\n',
    ...overrides,
  };
}

const BACKUP_DIR_RE = /^backup-v1-[0-9a-f-]{36}$/;

function noteFileBytes(id) {
  const { markdown, ...meta } = noteResource(id);
  return Buffer.from(`---\nstudymate_notes: ${JSON.stringify(meta)}\n---\n${markdown}`, 'utf8');
}

function seedV1(home) {
  const root = notesRoot(home);
  const resources = path.join(root, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  const layout = { folders: [], nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  fs.writeFileSync(path.join(root, '_format.json'), JSON.stringify({ format: 'studymate-notes', version: 1 }) + '\n');
  fs.writeFileSync(path.join(root, 'layout.json'), JSON.stringify(layout) + '\n');
  fs.writeFileSync(path.join(resources, 'r-legacy.md'), noteFileBytes('legacy'));
  return { root, layout };
}

/* ── 路由路径与方法 ───────────────────────────────────────────────────────── */

test('路由路径固定为 /api/studymate/notes', () => {
  assert.equal(NOTES_PATH, '/api/studymate/notes');
});

test('GET 空 HOME 返回空数据域且不创建任何目录', async () => {
  const home = makeHome();
  const response = await handleNotes(new Request(ORIGIN + NOTES_PATH, { method: 'GET' }), home);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.schemaVersion, 2);
  assert.equal(body.requiresUpgrade, false);
  assert.deepEqual(body.resources, {});
  assert.deepEqual(body.resourceVersions, {});
  assert.equal(body.layout, null);
  assert.equal(body.layoutVersion, null);
  // 关键：读不创建。
  assert.equal(fs.existsSync(notesRoot(home)), false, 'GET 不该创建数据域目录');
  // storeId 不得漏出本机绝对路径。
  assert.equal(typeof body.storeId, 'string');
  assert.equal(body.storeId.includes(home), false, 'storeId 不该含绝对路径');
  assert.equal(body.storeId.includes(path.sep), false, 'storeId 不该含路径分隔符');
});

/* ── POST 资源：形状、版本栅栏 ────────────────────────────────────────────── */

test('POST 资源返回资源与版本；再读能读回', async () => {
  const home = makeHome();
  const created = await handleNotes(postJson({ operation: 'resource', resource: noteResource('a'), expectedVersion: null }), home);
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.ok, true);
  assert.equal(createdBody.resource.id, 'a');
  assert.match(createdBody.version, /^[0-9a-f]{64}$/);

  const read = await handleNotes(new Request(ORIGIN + NOTES_PATH, { method: 'GET' }), home);
  const readBody = await read.json();
  assert.equal(readBody.resources.a.markdown, '# 你好\n\n正文\n');
  assert.equal(readBody.resourceVersions.a, createdBody.version);
});

test('POST 缺 expectedVersion → 400 expected-version-required', async () => {
  const home = makeHome();
  const response = await handleNotes(postJson({ operation: 'resource', resource: noteResource('b') }), home);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'expected-version-required');
});

test('POST 非法 expectedVersion → 400 expected-version-required', async () => {
  const home = makeHome();
  for (const value of ['', 'xyz', 'A'.repeat(64)]) {
    const response = await handleNotes(postJson({ operation: 'resource', resource: noteResource('c'), expectedVersion: value }), home);
    assert.equal(response.status, 400, `expectedVersion=${value}`);
    assert.equal((await response.json()).error.code, 'expected-version-required');
  }
});

test('POST 非法资源 → 400 body-invalid', async () => {
  const home = makeHome();
  const response = await handleNotes(postJson({ operation: 'resource', resource: { id: 'BAD', type: 'note', markdown: 'x' }, expectedVersion: null }), home);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'body-invalid');
});

test('版本冲突 → 409，回包带 current / resource / version', async () => {
  const home = makeHome();
  const first = await handleNotes(postJson({ operation: 'resource', resource: noteResource('d', { markdown: 'v1' }), expectedVersion: null }), home);
  const v1 = (await first.json()).version;
  await handleNotes(postJson({ operation: 'resource', resource: noteResource('d', { markdown: 'v2' }), expectedVersion: v1 }), home);

  const stale = await handleNotes(postJson({ operation: 'resource', resource: noteResource('d', { markdown: 'v3' }), expectedVersion: v1 }), home);
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.error.code, 'version-conflict');
  // 前端按 current / version 取值（bridge.jsx），必须都在。
  assert.equal(typeof body.current, 'object');
  assert.equal(body.current.markdown, 'v2');
  assert.equal(body.resource.markdown, 'v2');
  assert.match(body.version, /^[0-9a-f]{64}$/);
  assert.notEqual(body.version, v1);
});

test('布局冲突 → 409，回包带 current / layout / version', async () => {
  const home = makeHome();
  const layout = { folders: [], nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const first = await handleNotes(postJson({ operation: 'layout', layout, expectedVersion: null }), home);
  const v1 = (await first.json()).version;
  const changed = { ...layout, viewport: { x: 10, y: 0, zoom: 1 } };
  await handleNotes(postJson({ operation: 'layout', layout: changed, expectedVersion: v1 }), home);

  const stale = await handleNotes(postJson({ operation: 'layout', layout, expectedVersion: v1 }), home);
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.error.code, 'version-conflict');
  assert.equal(body.current.viewport.x, 10);
  assert.equal(body.layout.viewport.x, 10);
  assert.notEqual(body.version, v1);
});

/* ── 请求体与方法的边界 ───────────────────────────────────────────────────── */

test('请求体不是合法 JSON → 400 body-invalid', async () => {
  const home = makeHome();
  const response = await handleNotes(postJson('{oops'), home);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'body-invalid');
});

test('未知 operation → 400 body-invalid', async () => {
  const home = makeHome();
  const response = await handleNotes(postJson({ operation: 'whatever' }), home);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'body-invalid');
});

test('不支持的方法 → 405 method-not-allowed', async () => {
  const home = makeHome();
  const response = await handleNotes(new Request(ORIGIN + NOTES_PATH, { method: 'DELETE' }), home);
  assert.equal(response.status, 405);
  assert.equal((await response.json()).error.code, 'method-not-allowed');
});

test('请求体超过 6 MiB → 413 body-invalid', async () => {
  const home = makeHome();
  const big = noteResource('big', { markdown: 'x'.repeat(7 * 1024 * 1024) });
  const response = await handleNotes(postJson({ operation: 'resource', resource: big, expectedVersion: null }), home);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'body-invalid');
});

/* ── format2：v1 只读 / 显式升级 / GET 版本标记 ────────────────────────────── */

test('v1 GET 报 requiresUpgrade:true；普通 resource/layout 写入被拒且 marker 不动', async () => {
  const home = makeHome();
  const seeded = seedV1(home);
  const markerFile = path.join(seeded.root, '_format.json');
  const before = fs.readFileSync(markerFile);

  const read = await handleNotes(new Request(ORIGIN + NOTES_PATH, { method: 'GET' }), home);
  assert.equal(read.status, 200);
  const body = await read.json();
  assert.equal(body.ok, true);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.requiresUpgrade, true);
  assert.equal(body.resources.legacy.markdown, '# 你好\n\n正文\n');
  assert.deepEqual(body.layout.viewport, { x: 0, y: 0, zoom: 1 });

  for (const request of [
    postJson({ operation: 'resource', resource: noteResource('new'), expectedVersion: null }),
    postJson({ operation: 'layout', layout: seeded.layout, expectedVersion: null }),
  ]) {
    const denied = await handleNotes(request, home);
    assert.equal(denied.status, 503);
    assert.equal((await denied.json()).error.code, 'notes-format-invalid');
  }
  assert.deepEqual(fs.readFileSync(markerFile), before);
  assert.equal(fs.existsSync(path.join(seeded.root, 'notes.lock.db')), false, 'v1 拒写不应先建锁库');
});

test('POST {operation:"upgrade"} 显式升级 v1：备份标识不泄露路径、重复幂等、GET 变 v2', async () => {
  const home = makeHome();
  const seeded = seedV1(home);
  const markerFile = path.join(seeded.root, '_format.json');
  const layoutFile = path.join(seeded.root, 'layout.json');
  const resourceFile = path.join(seeded.root, 'resources', 'r-legacy.md');
  const before = {
    marker: fs.readFileSync(markerFile),
    layout: fs.readFileSync(layoutFile),
    resource: fs.readFileSync(resourceFile),
  };

  const upgraded = await handleNotes(postJson({ operation: 'upgrade' }), home);
  assert.equal(upgraded.status, 200);
  const upgradeBody = await upgraded.json();
  assert.equal(upgradeBody.ok, true);
  assert.equal(upgradeBody.schemaVersion, 2);
  assert.equal(upgradeBody.requiresUpgrade, false);
  assert.match(upgradeBody.backup, BACKUP_DIR_RE);
  assert.match(upgradeBody.backupId, BACKUP_DIR_RE);
  assert.equal(upgradeBody.backup, upgradeBody.backupId);
  assert.equal(upgradeBody.backup.includes(home), false, 'backup 不泄露绝对路径');
  assert.equal(/[\\/]/.test(upgradeBody.backup), false);
  assert.equal(fs.statSync(path.join(seeded.root, upgradeBody.backupId)).isDirectory(), true);
  assert.deepEqual(fs.readFileSync(path.join(seeded.root, upgradeBody.backupId, '_format.json')), before.marker);
  assert.deepEqual(fs.readFileSync(layoutFile), before.layout, '升级不改布局原始 bytes');
  assert.deepEqual(fs.readFileSync(resourceFile), before.resource, '升级不改正文原始 bytes');

  const after = await handleNotes(new Request(ORIGIN + NOTES_PATH, { method: 'GET' }), home);
  const afterBody = await after.json();
  assert.equal(afterBody.schemaVersion, 2);
  assert.equal(afterBody.requiresUpgrade, false);
  assert.equal(afterBody.resources.legacy.markdown, '# 你好\n\n正文\n');

  const repeat = await handleNotes(postJson({ operation: 'upgrade' }), home);
  const repeatBody = await repeat.json();
  assert.equal(repeat.status, 200);
  assert.equal(repeatBody.schemaVersion, 2);
  assert.equal(repeatBody.requiresUpgrade, false);
  assert.equal(repeatBody.backup, 'already-v2');
  assert.equal(repeatBody.backupId, 'already-v2');
});

test('POST upgrade 空 HOME 初始化 v2 且与重复调用幂等', async () => {
  const home = makeHome();
  const created = await handleNotes(postJson({ operation: 'upgrade' }), home);
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.ok, true);
  assert.equal(createdBody.schemaVersion, 2);
  assert.equal(createdBody.requiresUpgrade, false);
  assert.equal(createdBody.backup, 'already-v2');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(notesRoot(home), '_format.json'), 'utf8')),
    { format: 'studymate-notes', version: 2 },
  );

  const repeat = await handleNotes(postJson({ operation: 'upgrade' }), home);
  const repeatBody = await repeat.json();
  assert.equal(repeat.status, 200);
  assert.equal(repeatBody.schemaVersion, 2);
  assert.equal(repeatBody.requiresUpgrade, false);
  assert.equal(repeatBody.backup, 'already-v2');
  assert.equal(repeatBody.backupId, 'already-v2');
});

/* ── 数据域损坏：GET fail closed，绝不返回空布局 ──────────────────────────── */

test('非空且无 _format.json 的目录：GET 503，不会返回空布局', async () => {
  const home = makeHome();
  const root = notesRoot(home);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '别人的文件.txt'), 'x');

  const response = await handleNotes(new Request(ORIGIN + NOTES_PATH, { method: 'GET' }), home);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'file-shape-unknown');
  // 关键：失败时不能带一份「空布局」出去（否则前端会拿 defaults 覆盖回去）。
  assert.equal('layout' in body, false);
});

test('损坏的 layout.json：GET 503 而不是把坏布局当空', async () => {
  const home = makeHome();
  const root = notesRoot(home);
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(root, '_format.json'), JSON.stringify({ format: 'studymate-notes', version: 1 }));
  fs.writeFileSync(path.join(root, 'layout.json'), '{not json');

  const response = await handleNotes(new Request(ORIGIN + NOTES_PATH, { method: 'GET' }), home);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'file-shape-unknown');
});

test('未知 _format.json：GET 503', async () => {
  const home = makeHome();
  const root = notesRoot(home);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '_format.json'), '{"format":"other","version":9}');

  const response = await handleNotes(new Request(ORIGIN + NOTES_PATH, { method: 'GET' }), home);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'file-shape-unknown');
});

/* ── 数据根守卫：相对路径/空白一律拒绝，且不落目录 ─────────────────────────── */

test('数据根不是绝对路径 → 400 path-invalid，且不建任何目录', async () => {
  for (const home of ['relative/notes', '', '   ']) {
    const response = await handleNotes(new Request(ORIGIN + NOTES_PATH, { method: 'GET' }), home);
    assert.equal(response.status, 400, `home=${JSON.stringify(home)}`);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'path-invalid');
  }
  // 相对路径不该在仓库里留下痕迹。
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  assert.equal(fs.existsSync(path.join(repoRoot, 'studymate-notes')), false);
  assert.equal(fs.existsSync(path.join(repoRoot, 'relative')), false);
});

test('POST 时数据根不是绝对路径 → 400 path-invalid', async () => {
  const response = await handleNotes(postJson({ operation: 'resource', resource: noteResource('rel'), expectedVersion: null }), 'relative/notes');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'path-invalid');
});

/* ── #304 onCorrupt=skip 的 HTTP 契约 ─────────────────────────────────────── */

test('#304 GET ?onCorrupt=skip 返回 corrupt 清单；普通 GET 仍 503；非法值 400', async () => {
  const home = makeHome();
  const good = await handleNotes(postJson({ operation: 'resource', resource: noteResource('ok'), expectedVersion: null }), home);
  assert.equal(good.status, 200);
  const bad = await handleNotes(postJson({
    operation: 'resource',
    resource: { id: 'bad', type: 'link', title: '坏链接', parent: 'notes', url: 'https://example.com', summary: '' },
    expectedVersion: null,
  }), home);
  assert.equal(bad.status, 200, await bad.text());
  fs.writeFileSync(path.join(notesRoot(home), 'resources', 'r-bad.json'), '{ not json');

  const strict = await handleNotes(new Request(`${ORIGIN}${NOTES_PATH}`, { method: 'GET' }), home);
  assert.equal(strict.status, 503);
  const strictBody = await strict.json();
  assert.equal(strictBody.ok, false);
  assert.equal(strictBody.error.code, 'file-shape-unknown');

  const skipped = await handleNotes(new Request(`${ORIGIN}${NOTES_PATH}?onCorrupt=skip`, { method: 'GET' }), home);
  assert.equal(skipped.status, 200);
  const body = await skipped.json();
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body.resources), ['ok']);
  assert.equal(body.corrupt.length, 1);
  assert.equal(body.corrupt[0].id, 'bad');
  assert.equal(body.corrupt[0].kind, 'json');
  assert.equal(body.corrupt[0].message, '资源文件已损坏，暂时无法载入。');
  assert.equal(JSON.stringify(body).includes(home), false);

  const invalid = await handleNotes(new Request(`${ORIGIN}${NOTES_PATH}?onCorrupt=nope`, { method: 'GET' }), home);
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.error.code, 'body-invalid');
});
