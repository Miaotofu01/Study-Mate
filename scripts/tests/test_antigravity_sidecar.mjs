/* Antigravity Sidecar 阅读端契约测试（Wave 2B）。
   ────────────────────────────────────────────────────────────────────────
   先把插件构建到临时目录，再**直接导入构建产物** `sidecars/reader/main.mjs`：
   构建产物里的 `engine/lib/**` 是仓库 `lib/**` 的闭包，所以下面每一条断言测的都是
   真实数据层，不是另写一份替身。

   `sidecar_sdk` 是 Antigravity 宿主进程里的裸模块，CI 上解析不到。这里用 Node 原生的
   `module.registerHooks` 把说明符指到 `fixtures/sidecar-sdk-mock.mjs`，对 `main.mjs` 零侵入。

   契约口径：Sidecar 复用同一份 `lib/client.js`，所以错误码与响应形状必须与 DSH 路由一致
   （`version-conflict`、`{text, entry}` 等），不能为测试另造一套。
   ──────────────────────────────────────────────────────────────────────── */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after } from 'node:test';

import { buildAntigravityPlugin } from '../../bin/antigravity-plugin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mockUrl = pathToFileURL(path.join(root, 'scripts', 'tests', 'fixtures', 'sidecar-sdk-mock.mjs')).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'sidecar_sdk') return { url: mockUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

/* 测试进程的环境隔离：不要把开发机上的 ~/.dsh、工作区或笔记域带进来。 */
process.env.STUDYMATE_SIDECAR_NO_AUTORUN = '1';
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-agy-sidecar-home-'));
process.env.DSH_HOME = HOME_DIR;
process.env.HOME = HOME_DIR;
process.env.USERPROFILE = HOME_DIR;
delete process.env.STUDYMATE_WORKSPACE;
delete process.env.LEARN_WORKSPACE;
delete process.env.STUDYMATE_NOTES_HOME;
after(() => fs.rmSync(HOME_DIR, { recursive: true, force: true }));

/* ── 构建一次，所有用例共用 ─────────────────────────────────────────────── */

let built = null;
function buildOnce() {
  if (built) return built;
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-agy-sidecar-build-'));
  const result = buildAntigravityPlugin({ output });
  built = { ...result, output };
  return built;
}
after(() => {
  if (built) fs.rmSync(built.output, { recursive: true, force: true });
});

function readerDir(plugin) {
  return path.join(plugin, 'sidecars', 'reader');
}

/* ── 临时工作区：现造现弃 ───────────────────────────────────────────────── */

const SUBJECT = 'net-basics';
const NODE = 'net.layers';

function makeWorkspace(t, { empty = false } = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-agy-sidecar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  if (empty) return { dir, ws };

  const subjectDir = path.join(ws, '.learning', 'subjects', SUBJECT);
  fs.mkdirSync(path.join(subjectDir, 'lessons'), { recursive: true });
  fs.writeFileSync(path.join(subjectDir, 'subject.yaml'), [
    `name: 网络基础`,
    `slug: ${SUBJECT}`,
    'goal: 能独立解释一次网页请求经过了哪些层',
    'created_at: "2026-11-20"',
    'status: 进行中',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(subjectDir, 'curriculum.yaml'), [
    'nodes:',
    `  - id: ${NODE}`,
    '    title: 分层',
    '    objective: 说清每一层各管一段',
    '    prerequisites: []',
    '    status: 未开始',
    '    kind: 概念',
    'edges: []',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(subjectDir, 'progress.yaml'), [
    'updated_at: "2026-11-20"',
    'nodes: {}',
    'project:',
    '  current: ""',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(subjectDir, 'lessons', `0001-${NODE}.md`), [
    '# 分层',
    '',
    '## 讲解',
    '',
    '网络分成若干层，每层只关心自己那一段。',
    '',
    '::: quiz 理解 锚点：每层各管一段',
    ':::',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(subjectDir, 'lessons', `0001-${NODE}.quiz.json`), `${JSON.stringify({
    '每层各管一段': [
      { q: 'DNS 在哪一层？', opts: ['应用层', '传输层', '网络层', '链路层'], ans: 0, why: 'DNS 是应用层协议。' },
    ],
  }, null, 2)}\n`);
  return { dir, ws, subjectDir };
}

let seq = 0;
function op(name) {
  seq += 1;
  return `${name}-${process.pid}-${seq}`;
}

/* ── 导入构建产物 ───────────────────────────────────────────────────────── */

const apps = new Map();
async function appFor(plugin) {
  const key = path.resolve(plugin);
  if (apps.has(key)) return apps.get(key);
  const main = path.join(readerDir(plugin), 'main.mjs');
  assert.ok(fs.existsSync(main), `构建产物缺少 ${main}`);
  const module = await import(`${pathToFileURL(main).href}?t=${Date.now()}`);
  const app = module.createReaderApp();
  apps.set(key, app);
  return app;
}

function workspaceUri(ws) {
  const posix = path.resolve(ws).split(path.sep).join('/');
  const drive = posix.replace(/^([A-Za-z]):/, '$1%3A');
  return `file:///${drive.replace(/^\/+/, '')}`;
}

async function libraryOf(app, ws) {
  const result = await app.requestApi('GET', '/api/studymate/library', { query: { ws } });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json;
}

/* ── 1. 静态页面与资源路由 ─────────────────────────────────────────────── */

test('1. 静态页面与资源路由：页面、宿主脚本与五个 React vendor 全部 200', async (t) => {
  const { plugin } = buildOnce();
  const app = await appFor(plugin);
  const pages = [
    ['/', 'text/html'],
    ['/preload.js', 'application/javascript'],
    ['/host.js', 'application/javascript'],
    ['/boot.js', 'application/javascript'],
    ['/studymate-client.js', 'application/javascript'],
    ['/vendor/scheduler.production.js', 'application/javascript'],
    ['/vendor/react.production.js', 'application/javascript'],
    ['/vendor/react-dom.production.js', 'application/javascript'],
    ['/vendor/react-dom-client.production.js', 'application/javascript'],
    ['/vendor/react-jsx-runtime.production.js', 'application/javascript'],
  ];
  for (const [route, mime] of pages) {
    const response = await app.requestPage(route);
    assert.equal(response.status, 200, `${route} 应返回 200`);
    assert.ok(String(response.contentType).includes(mime), `${route} 的 MIME 是 ${response.contentType}，期望 ${mime}`);
    assert.ok(Buffer.isBuffer(response.body) || typeof response.body === 'string', `${route} 应有响应体`);
  }
  // 笔记分块是构建产物：存在就必须 200，不存在时主包明确 404（不静默回退）。
  const notesChunk = path.join(readerDir(plugin), 'client', 'client.notes.js');
  const notes = await app.requestPage('/client.notes.js');
  assert.equal(notes.status, fs.existsSync(notesChunk) ? 200 : 404);
});

/* ── 2. Vendor 运行时兜底 ──────────────────────────────────────────────── */

test('2. Vendor 运行时兜底：删掉产物 vendor/ 后仍能动态生成；无 React 时 404 react-missing', async (t) => {
  const { plugin, output } = buildOnce();
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-agy-fallback-')), 'studymate');
  t.after(() => fs.rmSync(path.dirname(copy), { recursive: true, force: true }));
  fs.cpSync(plugin, copy, { recursive: true });
  const vendorDir = path.join(readerDir(copy), 'vendor');
  fs.rmSync(vendorDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(vendorDir), false);

  const saved = {
    react: process.env.STUDYMATE_REACT_DIR,
    nodePath: process.env.NODE_PATH,
    dshHome: process.env.DSH_HOME,
    path: process.env.PATH,
  };
  const restore = () => {
    for (const [key, value] of Object.entries({
      STUDYMATE_REACT_DIR: saved.react,
      NODE_PATH: saved.nodePath,
      DSH_HOME: saved.dshHome,
      PATH: saved.path,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  t.after(restore);

  try {
    // 仓库 devDependencies 里有一份 React：显式指过去，测试不依赖全局 npm。
    process.env.STUDYMATE_REACT_DIR = path.join(root, 'node_modules');
    const app = await appFor(copy);
    for (const route of ['/vendor/react.production.js', '/vendor/react-jsx-runtime.production.js']) {
      const response = await app.requestPage(route);
      assert.equal(response.status, 200, `${route} 应能运行期兜底生成`);
      assert.ok(String(response.body).includes('window.__smDefine'), `${route} 必须走 vendorFile 包装壳`);
    }

    // 模拟「这台机器没有 React」：候选根全空、npm 探测也没有。
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-agy-no-react-'));
    t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
    process.env.STUDYMATE_REACT_DIR = empty;
    process.env.NODE_PATH = '';
    process.env.DSH_HOME = path.join(empty, 'dsh');
    process.env.PATH = empty;
    const missing = await app.requestPage('/vendor/react.production.js');
    assert.equal(missing.status, 404);
    assert.equal(JSON.parse(String(missing.body)).error.code, 'react-missing');
  } finally {
    restore();
  }
});

/* ── 3. library ────────────────────────────────────────────────────────── */

test('3. GET library：空工作区、损坏科目隔离、ws 的 file:// 与 %3A 编码', async (t) => {
  const { plugin } = buildOnce();
  const app = await appFor(plugin);

  const empty = makeWorkspace(t, { empty: true });
  const blank = await app.requestApi('GET', '/api/studymate/library', { query: { ws: empty.ws } });
  assert.equal(blank.status, 200);
  assert.equal(blank.json.version, 1, '空工作区给 API 版本号 1');
  assert.deepEqual(blank.json.subjects, []);

  const ws = makeWorkspace(t);
  const brokenDir = path.join(ws.ws, '.learning', 'subjects', 'broken-subject');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, 'subject.yaml'), 'name: [未闭合\n');
  const mixed = await libraryOf(app, ws.ws);
  assert.equal(mixed.subjects.length, 1, '坏的那门不进 subjects');
  assert.equal(mixed.subjects[0].slug, SUBJECT);
  assert.equal(mixed.unreadable.length, 1, '坏的那门要点名');
  assert.equal(mixed.unreadable[0].dir, 'broken-subject');
  assert.match(mixed.unreadable[0].error, /subject\.yaml/);

  const uri = workspaceUri(ws.ws);
  assert.match(uri, /%3A/, 'Windows 盘符必须被 %3A 编码，测试才真的走了解码分支');
  const viaJson = await app.requestApi('GET', '/api/studymate/library', {
    query: { ws: JSON.stringify([uri]) },
  });
  assert.equal(viaJson.status, 200);
  assert.equal(viaJson.json.subjects[0].slug, SUBJECT);

  const direct = await libraryOf(app, ws.ws);
  assert.equal(direct.subjects[0].slug, SUBJECT);
});

/* ── 4. attempts ───────────────────────────────────────────────────────── */

test('4. POST attempts：首次写入、版本冲突、幂等重放、缺字段与越界', async (t) => {
  const { plugin } = buildOnce();
  const app = await appFor(plugin);
  const ws = makeWorkspace(t);
  const lib = await libraryOf(app, ws.ws);
  const baseline = lib.subjects[0].nodes[0].attempts.version;
  assert.match(baseline, /^[0-9a-f]{16}$/);

  const questions = { '每层各管一段#0': { 选: 0, 对: true } };
  const operationId = op('attempt');
  const first = await app.requestApi('POST', '/api/studymate/attempts', {
    body: { ws: ws.ws, subject: SUBJECT, node: NODE, questions, expectedVersion: baseline, operationId },
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  assert.match(first.json.version, /^[0-9a-f]{16}$/, '版本号是内容哈希，写回时拿它当 expectedVersion');
  const written = path.join(ws.subjectDir, 'attempts', `0001-${NODE}.json`);
  assert.ok(fs.existsSync(written), '必须落盘到 attempts/');
  assert.equal(JSON.parse(fs.readFileSync(written, 'utf8'))['题']['每层各管一段#0']['上次结果']['选'], 0);

  const replay = await app.requestApi('POST', '/api/studymate/attempts', {
    body: { ws: ws.ws, subject: SUBJECT, node: NODE, questions, expectedVersion: baseline, operationId },
  });
  assert.equal(replay.status, 200, '同一个 operationId 重放是 200，不是冲突');
  assert.equal(replay.json.ok, true);
  assert.equal(replay.json.version, first.json.version, '重放原样回放上次回执');

  const conflict = await app.requestApi('POST', '/api/studymate/attempts', {
    body: {
      ws: ws.ws, subject: SUBJECT, node: NODE,
      questions: { '每层各管一段#0': { 选: 1, 对: false } },
      expectedVersion: baseline, operationId: op('attempt-stale'),
    },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'version-conflict');

  for (const body of [
    { ws: ws.ws, subject: SUBJECT, node: NODE, questions },
    { ws: ws.ws, subject: SUBJECT, node: '../x', questions, expectedVersion: baseline, operationId: op('attempt-bad-node') },
  ]) {
    const bad = await app.requestApi('POST', '/api/studymate/attempts', { body });
    assert.equal(bad.status, 400, JSON.stringify(bad.json));
    assert.equal(bad.json.ok, false);
    assert.equal(typeof bad.json.error.code, 'string');
  }
});

/* ── 5. annotations ────────────────────────────────────────────────────── */

test('5. POST annotations：落盘、旧版本 409、非法 node 400', async (t) => {
  const { plugin } = buildOnce();
  const app = await appFor(plugin);
  const ws = makeWorkspace(t);
  const lib = await libraryOf(app, ws.ws);
  const baseline = lib.subjects[0].nodes[0].annotations.version;
  assert.match(baseline, /^[0-9a-f]{16}$/);
  const at = '2026-11-20T10:00:00.000Z';
  const annotations = [{
    id: 'a1',
    note: '这段是分层的关键',
    ranges: [{ line: 5, kind: 'para', hash: 'h1', start: 0, end: 4 }],
    created: at,
    modified: at,
  }];
  const operationId = op('annotation');
  const first = await app.requestApi('POST', '/api/studymate/annotations', {
    body: { ws: ws.ws, subject: SUBJECT, node: NODE, annotations, expectedVersion: baseline, operationId },
  });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.ok, true);
  const file = path.join(ws.subjectDir, 'annotations', `0001-${NODE}.json`);
  assert.ok(fs.existsSync(file), '标注必须落盘到 annotations/');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['标'].a1.note, '这段是分层的关键');

  const stale = await app.requestApi('POST', '/api/studymate/annotations', {
    body: {
      ws: ws.ws, subject: SUBJECT, node: NODE,
      annotations: [{ ...annotations[0], note: '改一下' }],
      expectedVersion: baseline, operationId: op('annotation-stale'),
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, 'version-conflict');

  const traversal = await app.requestApi('POST', '/api/studymate/annotations', {
    body: {
      ws: ws.ws, subject: SUBJECT, node: '../x',
      annotations, expectedVersion: baseline, operationId: op('annotation-node'),
    },
  });
  assert.equal(traversal.status, 400);
  assert.equal(traversal.json.ok, false);
  // 数据层的词表是 node-invalid（path-invalid 属于取址类路由，如 asset）。
  assert.equal(traversal.json.error.code, 'node-invalid');
});

/* ── 6. reference ──────────────────────────────────────────────────────── */

test('6. GET/POST reference：写入 notes.md、读回、缺失/穿越 404、旧版本 409', async (t) => {
  const { plugin } = buildOnce();
  const app = await appFor(plugin);
  const ws = makeWorkspace(t);
  const lib = await libraryOf(app, ws.ws);
  const baseline = lib.subjects[0].reference_version;
  assert.ok(typeof baseline === 'string' && baseline.length > 0);

  const created = await app.requestApi('POST', '/api/studymate/reference', {
    body: {
      ws: ws.ws, subject: SUBJECT, title: 'notes', markdown: '# 参考资料\n\n一条手写笔记。\n',
      expectedVersion: baseline, operationId: op('reference'),
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json.ok, true);
  assert.equal(created.json.entry.path, 'notes.md');
  assert.ok(fs.existsSync(path.join(ws.subjectDir, 'reference', 'notes.md')));

  const read = await app.requestApi('GET', '/api/studymate/reference', {
    query: { ws: ws.ws, subject: SUBJECT, path: 'notes.md' },
  });
  assert.equal(read.status, 200);
  assert.match(read.json.text, /一条手写笔记/);
  assert.equal(read.json.entry.path, 'notes.md');
  assert.match(read.json.entry.title, /notes/);

  for (const rel of ['missing.md', '../secret.md']) {
    const missing = await app.requestApi('GET', '/api/studymate/reference', {
      query: { ws: ws.ws, subject: SUBJECT, path: rel },
    });
    assert.equal(missing.status, 404, `${rel} 应为 404`);
    assert.equal(missing.json.error.code, 'not-found', `${rel} 用标准错误信封`);
  }

  const stale = await app.requestApi('POST', '/api/studymate/reference', {
    body: {
      ws: ws.ws, subject: SUBJECT, title: 'second', markdown: '第二份',
      expectedVersion: baseline, operationId: op('reference-stale'),
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, 'version-conflict');
});

/* ── 7. asset ──────────────────────────────────────────────────────────── */

test('7. GET asset：SVG 的 MIME 与 no-store，路径穿越 404', async (t) => {
  const { plugin } = buildOnce();
  const app = await appFor(plugin);
  const ws = makeWorkspace(t);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>\n';
  fs.mkdirSync(path.join(ws.subjectDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ws.subjectDir, 'assets', 'diagram.svg'), svg);

  const good = await app.requestApi('GET', '/api/studymate/asset', {
    query: { ws: ws.ws, subject: SUBJECT, path: 'assets/diagram.svg' },
  });
  assert.equal(good.status, 200);
  assert.equal(good.contentType, 'image/svg+xml');
  assert.equal(good.headers['Cache-Control'], 'no-store');
  assert.equal(Buffer.from(good.body).toString('utf8'), svg);

  const escape = await app.requestApi('GET', '/api/studymate/asset', {
    query: { ws: ws.ws, subject: SUBJECT, path: '../../etc/passwd' },
  });
  assert.equal(escape.status, 404);
});

/* ── 8. tasks 与 lab-run ───────────────────────────────────────────────── */

test('8. GET tasks 与 POST lab-run：任务板形状与非法请求体 400', async (t) => {
  const { plugin } = buildOnce();
  const app = await appFor(plugin);
  const tasks = await app.requestApi('GET', '/api/studymate/tasks');
  assert.equal(tasks.status, 200);
  assert.equal(typeof tasks.json.at, 'string');
  assert.ok(Array.isArray(tasks.json.tasks));

  const lab = await app.requestApi('POST', '/api/studymate/lab-run', { body: {} });
  assert.equal(lab.status, 400);
  assert.equal(lab.json.ok, false);
  assert.equal(lab.json.error.code, 'body-invalid');
});

/* ── 9. status ─────────────────────────────────────────────────────────── */

test('9. GET status：ok、workspace、initialized、subjects、watch', async (t) => {
  const { plugin } = buildOnce();
  const app = await appFor(plugin);
  const ws = makeWorkspace(t);
  const status = await app.requestApi('GET', '/api/studymate/status', { query: { ws: ws.ws } });
  assert.equal(status.status, 200);
  assert.equal(status.json.ok, true);
  assert.equal(path.resolve(status.json.workspace), path.resolve(ws.ws));
  assert.equal(status.json.initialized, true);
  assert.ok(Array.isArray(status.json.subjects));
  assert.equal(status.json.watch.watching, true);
  assert.equal(status.json.watch.backend, 'sidecar-poll');
});

/* ── 10. notes ─────────────────────────────────────────────────────────── */

test('10. GET/POST notes：空域、资源落盘、旧版本 409、布局、未知 operation 400', async (t) => {
  const { plugin } = buildOnce();
  const app = await appFor(plugin);
  const ws = makeWorkspace(t);

  const empty = await app.requestApi('GET', '/api/studymate/notes', { query: { ws: ws.ws } });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.ok, true);
  assert.equal(empty.json.schemaVersion, 2);
  assert.deepEqual(empty.json.resources, {});
  assert.equal(empty.json.layout, null);

  const resource = { id: 'note-1', type: 'note', title: '分层笔记', markdown: '# 分层\n\n一次请求经过四层。\n' };
  const created = await app.requestApi('POST', '/api/studymate/notes', {
    body: { ws: ws.ws, operation: 'resource', resource, expectedVersion: null },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json.ok, true);
  assert.match(created.json.version, /^[0-9a-f]{64}$/);
  const noteFile = path.join(ws.ws, '.learning', 'studymate-notes', 'resources', 'r-note-1.md');
  assert.ok(fs.existsSync(noteFile), '笔记必须持久化到 <ws>/.learning/studymate-notes/');
  assert.match(fs.readFileSync(noteFile, 'utf8'), /一次请求经过四层/);

  const conflict = await app.requestApi('POST', '/api/studymate/notes', {
    body: { ws: ws.ws, operation: 'resource', resource: { ...resource, markdown: '# 改' }, expectedVersion: 'a'.repeat(64) },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'version-conflict');

  const layout = { folders: [], nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const layoutResponse = await app.requestApi('POST', '/api/studymate/notes', {
    body: { ws: ws.ws, operation: 'layout', layout, expectedVersion: null },
  });
  assert.equal(layoutResponse.status, 200, JSON.stringify(layoutResponse.json));
  assert.equal(layoutResponse.json.ok, true);
  assert.match(layoutResponse.json.version, /^[0-9a-f]{64}$/);

  const invalid = await app.requestApi('POST', '/api/studymate/notes', {
    body: { ws: ws.ws, operation: 'invalid' },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'body-invalid');

  const afterWrite = await app.requestApi('GET', '/api/studymate/notes', { query: { ws: ws.ws } });
  assert.equal(afterWrite.status, 200);
  assert.equal(afterWrite.json.resources['note-1'].title, '分层笔记');
  assert.deepEqual(afterWrite.json.layout, layout);
});

/* ── 11. poll-version ──────────────────────────────────────────────────── */

test('11. GET poll-version：修改、同数删建、超过 605 个文件都改变令牌', async (t) => {
  const { plugin } = buildOnce();
  const app = await appFor(plugin);
  const ws = makeWorkspace(t);
  const poll = async () => {
    const result = await app.requestApi('GET', '/api/studymate/poll-version', { query: { ws: ws.ws } });
    assert.equal(result.status, 200);
    return result.json.version;
  };

  const first = await poll();
  assert.notEqual(first, 'empty');
  const lesson = path.join(ws.subjectDir, 'lessons', `0001-${NODE}.md`);
  fs.appendFileSync(lesson, '\n\n追加一行。\n');
  const second = await poll();
  assert.notEqual(second, first, '内容修改必须改变令牌');

  const bulk = path.join(ws.ws, '.learning', 'bulk');
  fs.mkdirSync(bulk, { recursive: true });
  fs.writeFileSync(path.join(bulk, 'a.md'), 'AAAA');
  const withA = await poll();
  fs.rmSync(path.join(bulk, 'a.md'));
  fs.writeFileSync(path.join(bulk, 'b.md'), 'AAAA');
  const withB = await poll();
  assert.notEqual(withB, withA, '同数量删旧建新也必须改变令牌（路径进摘要）');

  for (let index = 0; index < 700; index += 1) {
    fs.writeFileSync(path.join(bulk, `f-${String(index).padStart(4, '0')}.md`), 'x');
  }
  const many = await poll();
  fs.writeFileSync(path.join(bulk, 'f-0604.md'), 'yy');
  const after605 = await poll();
  assert.notEqual(after605, many, '第 605 个文件的修改不能被扫描上限漏掉');
});

/* ── 12. math ──────────────────────────────────────────────────────────── */

test('12. GET math/*：CSS、JS、woff2 的精确 MIME 与未知路径 404', async (t) => {
  const { plugin } = buildOnce();
  const app = await appFor(plugin);
  const font = fs.readdirSync(path.join(root, 'lib', 'katex', 'fonts')).filter((name) => name.endsWith('.woff2')).sort()[0];
  assert.ok(font, '仓库里应随包发 KaTeX 字体');

  const css = await app.requestApi('GET', '/api/studymate/math/katex.min.css');
  assert.equal(css.status, 200);
  assert.ok(String(css.contentType).startsWith('text/css'), css.contentType);

  const js = await app.requestApi('GET', '/api/studymate/math/katex.min.js');
  assert.equal(js.status, 200);
  assert.match(String(js.contentType), /javascript/);

  const woff = await app.requestApi('GET', `/api/studymate/math/fonts/${font}`);
  assert.equal(woff.status, 200);
  assert.equal(woff.contentType, 'font/woff2');
  assert.ok(Buffer.from(woff.body).length > 0);

  const missing = await app.requestApi('GET', '/api/studymate/math/nope.css');
  assert.equal(missing.status, 404);
});

/* ── 13. 静态源码契约 ──────────────────────────────────────────────────── */

test('13. 静态源码契约：无 Gemini、脚本顺序、host 桥接能力', () => {
  const { plugin } = buildOnce();
  const reader = readerDir(plugin);
  for (const name of ['sidecar.json', 'boot.js', 'host.js', 'index.html']) {
    const text = fs.readFileSync(path.join(reader, name), 'utf8');
    assert.equal(text.includes('Gemini'), false, `${name} 里不该有 Gemini 硬编码`);
  }
  const index = fs.readFileSync(path.join(reader, 'index.html'), 'utf8');
  assert.ok(index.includes('<script src="/preload.js"></script>'));
  assert.ok(index.includes('/vendor/react-jsx-runtime.production.js'));
  assert.equal(index.includes('/vendor/katex.production.js'), false);

  const host = fs.readFileSync(path.join(reader, 'host.js'), 'utf8');
  for (const token of ['clearTimeout', 'clearInterval', 'react/jsx-runtime', 'react/jsx-dev-runtime', '__smNotifyWorkspaceChanged']) {
    assert.ok(host.includes(token), `host.js 缺少 ${token}`);
  }
  assert.ok(host.includes('require.async') || /\basync\b/.test(host), 'host.js 必须提供分块加载能力');
});
