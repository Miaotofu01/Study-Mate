/* 无界笔记 · useNotesPersistence 的「同一标签页关掉 main 再挂回来」真 React 验收。

   背景：宿主 main 关闭会卸载 App；如果 hook 在 cleanup 里 dispose 保存控制器，已接受但
   未落盘的编辑（pending / in-flight / error / conflict，含 layout）会随控制器消失。本套件
   用真 React 19（development 构建，因此 StrictMode 会真的双调 effect）+ 假 transport，把
   「关闭 → 再挂回」的真实时序走一遍，断言：

   1. 在途保存时关闭 main：重挂复用同一控制器，正文仍是草稿，不重发 GET，不把 remount
      的默认相机写成 layout 草稿；在途回包落地后基线前移。
   2. debounce 窗口内关闭 main：控制器继续把已接受的编辑存下去，重挂不重发。
   3. 保存失败后关闭：重挂仍停在 error、草稿还在，只有用户显式重试才写。
   4. 409 冲突后关闭：重挂仍是 conflict、草稿还在，绝不自动覆盖。
   5. StrictMode 双挂载只发一次 GET；卸载再挂回不重新载入（clean 时只补一次外部版本核对）。
   6. 同一会话两个 main 竞争：旧实例写权限 fail closed（新挂载接管租约）。
   7. 显式丢弃（失败的草稿）：丢弃的 GET 在途时关 main，重挂仍执行丢弃，旧稿绝不重发。
   8. 旧格式（v1）库：相机恢复途中关 main，重挂停在 upgrade，编辑门禁绝不重开、零写。
   9. 重挂时相机恢复未完成不写 layout；恢复后用同一相机重复上报也不产生假写（指纹去重）。
  10. 显式 reload 之后 lease 必须重新镜像 runtime：关 main 再挂回不能显示 reload 前的旧稿。
  11. 首次载入失败后重试成功（adopt 从未设置过 lease.restored）：重挂同样不能显示旧稿。

   不覆盖：真实宿主 bridge 的接线（App/bridge 由另一条线负责）、真实文件系统（版本栅栏在
   Node 套件与 notes HTTP 套件里覆盖）。esbuild 只把本页打进临时目录，不碰 dist。
   运行：缺 Microsoft Edge 退出码 3。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const rootRequire = createRequire(path.join(ROOT, 'package.json'));

const PAGE_SOURCE = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import useNotesPersistence from './client/notes/useNotesPersistence.js';
import { createNotesPersistenceSession, getNotesPersistenceSessionStore } from './client/notes/persistence-session.js';

const FOLDERS = [
  { id: 'library', parent: null, name: '我的资料', kind: 'folder' },
  { id: 'notes', parent: 'library', name: '概念', kind: 'folder' },
];
const CAMERA = { x: 10, y: 20, zoom: 0.8 };
const BASE_TEXT = 'base';

const ctl = window.__ctl = {
  loads: 0,
  resourceWrites: 0,
  layoutWrites: 0,
  writes: [],
  held: [],
  hold: false,
  // GET 也能挂起：用来制造「显式丢弃的载入还在途时关掉 main」的窗口。
  gets: [],
  holdGet: false,
  payloadOverride: null,
  // 相机恢复也能挂起：用来制造「旧格式基线已拿到、相机还没恢复完就关掉 main」的窗口。
  viewportHeld: [],
  holdViewport: false,
  fault: null,
  getFault: null,
  version: 1,
  // 假服务器状态：写入成功后 GET 也要反映出来，否则「重挂后核对外部版本」会把界面拉回旧稿，
  // 测出来的就不是本 hook 的问题了。
  serverText: BASE_TEXT,
  resourceTag: 'v1',
  layoutTag: 'l1',
  viewports: [],
  camera: { x: 0, y: 0, zoom: 1 },
  session: createNotesPersistenceSession({ label: 'hook-test' }),
  store() { return getNotesPersistenceSessionStore(ctl.session); },
  payload() {
    return {
      schemaVersion: 2,
      storeId: 'store-1',
      resources: { r1: { id: 'r1', type: 'note', title: '一', parent: 'notes', owner: 'me', markdown: ctl.serverText } },
      resourceVersions: { r1: ctl.resourceTag },
      layout: { folders: FOLDERS, nodes: [], edges: [], viewport: CAMERA },
      layoutVersion: ctl.layoutTag,
    };
  },
  commit(kind, dto, version) {
    if (kind === 'resource') {
      ctl.resourceTag = version;
      if (typeof dto.markdown === 'string') ctl.serverText = dto.markdown;
    } else {
      ctl.layoutTag = version;
    }
  },
  write(kind, dto, expectedVersion) {
    ctl.writes.push({ kind, dto, expectedVersion });
    if (kind === 'resource') ctl.resourceWrites += 1; else ctl.layoutWrites += 1;
    const fault = ctl.fault;
    if (fault) {
      const error = new Error(fault.message || '测试注入的失败');
      error.code = fault.code || 'network';
      if (fault.code === 'version-conflict') { error.current = ctl.payload(); error.version = fault.version || 'v-server'; }
      return Promise.reject(error);
    }
    if (!ctl.hold) {
      const version = 'v' + (++ctl.version);
      ctl.commit(kind, dto, version);
      return Promise.resolve({ version });
    }
    return new Promise((resolve, reject) => ctl.held.push({ kind, dto, expectedVersion, resolve, reject }));
  },
  release(index, version) {
    const entry = ctl.held.splice(index, 1)[0];
    if (!entry) throw new Error('没有挂起的写请求：' + index);
    const tag = version || 'v' + (++ctl.version);
    ctl.commit(entry.kind, entry.dto, tag);
    entry.resolve({ version: tag });
  },
  reject(index) {
    const entry = ctl.held.splice(index, 1)[0];
    if (!entry) throw new Error('没有挂起的写请求：' + index);
    const error = new Error('测试注入的写失败');
    error.code = 'network';
    entry.reject(error);
  },
  resolveGet(index, payload) {
    const entry = ctl.gets.splice(index, 1)[0];
    if (!entry) throw new Error('没有挂起的 GET：' + index);
    entry.resolve(payload || entry.payload);
  },
  releaseViewport(index) {
    const entry = ctl.viewportHeld.splice(index, 1)[0];
    if (!entry) throw new Error('没有挂起的相机恢复：' + index);
    entry.resolve();
  },
};
ctl.transport = {
  loadStore() {
    ctl.loads += 1;
    if (ctl.getFault) {
      const error = new Error(ctl.getFault.message || '测试注入的读失败');
      error.code = 'network';
      return Promise.reject(error);
    }
    const payload = ctl.payloadOverride || ctl.payload();
    if (!ctl.holdGet) return Promise.resolve(payload);
    return new Promise((resolve, reject) => ctl.gets.push({ payload, resolve, reject }));
  },
  saveResource(dto, expectedVersion) { return ctl.write('resource', dto, expectedVersion); },
  saveLayout(dto, expectedVersion) { return ctl.write('layout', dto, expectedVersion); },
};

function Board() {
  const [resources, setResources] = React.useState(() => ctl.payload().resources);
  const [scene, setScene] = React.useState({ nodes: [], edges: [] });
  const [folders, setFolders] = React.useState([]);
  const flow = React.useMemo(() => ({
    setViewport(viewport) {
      ctl.viewports.push(viewport);
      const apply = () => { ctl.camera = { ...viewport }; };
      if (!ctl.holdViewport) { apply(); return Promise.resolve(); }
      return new Promise(resolve => ctl.viewportHeld.push({ viewport, resolve: () => { apply(); resolve(); } }));
    },
    getViewport() { return ctl.camera; },
  }), []);
  const hook = useNotesPersistence({
    persistence: ctl.transport,
    persistenceSession: ctl.session,
    resources, setResources, scene, setScene, folders, setFolders,
    active: true, flow, initialFolders: [],
  });
  window.__hook = hook;
  window.__render = { resources, scene, folders };
  window.__setText = text => setResources(current => ({ ...current, r1: { ...current.r1, markdown: text } }));
  return null;
}

window.__roots = [];
window.__mount = () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(React.StrictMode, null, React.createElement(Board)));
  window.__roots.push({ root, container });
};
window.__unmountAll = () => {
  for (const { root, container } of window.__roots.splice(0)) { root.unmount(); container.remove(); }
  window.__hook = null; window.__render = null;
};
`;

const results = [];

async function writePage(dir) {
  const esbuild = await import(pathToFileURL(rootRequire.resolve('esbuild')).href);
  await esbuild.build({
    absWorkingDir: ROOT,
    stdin: { contents: PAGE_SOURCE, resolveDir: ROOT, sourcefile: 'notes-persistence-session-page.js' },
    outfile: path.join(dir, 'app.js'), bundle: true, format: 'iife', platform: 'browser',
    target: 'es2022', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
  });
  fs.writeFileSync(path.join(dir, 'index.html'),
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="icon" href="data:,">'
    + '<title>notes persistence session fixture</title></head><body><script src="/app.js"></script></body></html>');
}

async function startServer(dir) {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const file = pathname === '/' ? path.join(dir, 'index.html') : path.join(dir, pathname);
    const resolved = path.resolve(file), root = path.resolve(dir);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) { response.writeHead(404); response.end(); return; }
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }[path.extname(resolved)] || 'application/octet-stream';
    response.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
    response.end(fs.readFileSync(resolved));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

const playwrightEntry = rootRequire.resolve('playwright');
const playwright = await import(pathToFileURL(playwrightEntry).href);
const { chromium } = playwright.default || playwright;
let browser;
try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (error) {
  const text = String(error?.message || error);
  if (!/(channel|msedge|Edge|executable|not installed|Executable doesn't exist|ENOENT)/i.test(text)) throw error;
  console.error('跳过 notes-persistence-session：缺 Microsoft Edge；退出码 3，不算通过。\n' + text);
  process.exit(3);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(50); }
  throw new Error(message);
}

const dir = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'studymate-notes-session-'));
await writePage(dir);
const { server, origin } = await startServer(dir);

async function scenario(label, fn) {
  const problems = [];
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1200, height: 800 }, locale: 'zh-CN' });
    const page = await context.newPage();
    page.on('pageerror', error => problems.push('pageerror: ' + (error.stack || error.message)));
    page.on('console', message => { if (message.type() === 'error') problems.push('console: ' + message.text()); });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ctl && typeof window.__mount === 'function');
    await fn(page);
    assert.deepEqual(problems, [], '页面不该有错误：\n' + problems.join('\n'));
    results.push({ label, ok: true });
    console.log('PASS  ' + label);
  } catch (error) {
    results.push({ label, ok: false, detail: String(error.stack || error) });
    console.error('FAIL  ' + label + '\n' + (error.stack || error));
  } finally {
    if (context) await context.close();
  }
  return results[results.length - 1].ok;
}

const ready = page => page.waitForFunction(() => window.__hook && window.__hook.loadState === 'ready', null, { timeout: 12000 });
const status = (page, key) => page.evaluate(name => window.__hook?.saveStatus?.[name]?.state || '', key);
const text = page => page.evaluate(() => window.__render?.resources?.r1?.markdown || '');
const counters = page => page.evaluate(() => ({ loads: window.__ctl.loads, resourceWrites: window.__ctl.resourceWrites, layoutWrites: window.__ctl.layoutWrites, held: window.__ctl.held.length }));

await scenario('在途保存时关闭 main → 重挂恢复草稿、不重发 GET、不写 layout、相机复位', async page => {
  await page.evaluate(() => window.__mount());
  await ready(page);
  assert.equal((await counters(page)).loads, 1, '首次挂载只发一次 GET');
  assert.equal(await text(page), 'base');

  // 用户输入被 App 接受（markEdit 门禁 + setResources），debounce 后进入在途。
  await page.evaluate(() => { window.__ctl.hold = true; window.__setText('在途正文'); });
  await until(async () => (await counters(page)).resourceWrites === 1 && (await counters(page)).held === 1, '在途保存没有发出');
  assert.equal(await status(page, 'r1'), 'saving');
  assert.equal((await counters(page)).layoutWrites, 0, '只改正文不该写 layout');

  const before = await counters(page);
  await page.evaluate(() => window.__unmountAll());
  await page.evaluate(() => window.__mount());
  await ready(page);

  const after = await counters(page);
  assert.equal(after.loads, 1, '重挂不重发 GET');
  assert.equal(after.resourceWrites, before.resourceWrites, '重挂不重发在途写请求');
  assert.equal(after.layoutWrites, 0, '重挂的默认相机不能写成 layout 草稿');
  assert.equal(await text(page), '在途正文', '重挂要拿回会话里的草稿，而不是 App 的初始 fixtures');
  assert.equal(await status(page, 'r1'), 'saving', '在途状态跨卸载保留');
  const lastViewport = await page.evaluate(() => window.__ctl.viewports[window.__ctl.viewports.length - 1]);
  assert.deepEqual(lastViewport, { x: 10, y: 20, zoom: 0.8 }, '重挂要还原保存的相机');

  // 在途回包（卸载期间发出、重挂之后回来）落地：基线前移，草稿清空。
  await page.evaluate(() => window.__ctl.release(0, 'v2'));
  await until(async () => (await status(page, 'r1')) === 'saved', '在途回包没有把状态推到 saved');
  assert.equal((await counters(page)).resourceWrites, 1, '同一草稿只发一次写请求');
});

await scenario('debounce 窗口内关闭 main → 已接受的编辑仍在关闭期间落盘，重挂不重发', async page => {
  await page.evaluate(() => window.__mount());
  await ready(page);
  await page.evaluate(() => { window.__ctl.hold = true; window.__setText('关掉也要存'); });
  await until(async () => (await status(page, 'r1')) === 'pending', '编辑没有进入 pending');
  assert.equal((await counters(page)).resourceWrites, 0, 'debounce 还没到点');

  // 宿主 main 关掉：控制器不 dispose，debounce 定时器继续走。
  await page.evaluate(() => window.__unmountAll());
  await until(async () => (await counters(page)).resourceWrites === 1 && (await counters(page)).held === 1, '关闭期间没有把编辑存下去');

  await page.evaluate(() => window.__mount());
  await ready(page);
  assert.equal((await counters(page)).loads, 1, '重挂不重发 GET');
  assert.equal(await text(page), '关掉也要存', '重挂正文是关闭前已接受的编辑');
  await page.evaluate(() => window.__ctl.release(0, 'v2'));
  await until(async () => (await status(page, 'r1')) === 'saved', '回包没有落到重挂之后的实例');
});

await scenario('保存失败后关闭 main → 重挂仍是 error 且草稿在，用户显式重试才写', async page => {
  await page.evaluate(() => window.__mount());
  await ready(page);
  await page.evaluate(() => { window.__ctl.fault = { code: 'network', message: '断网' }; window.__setText('失败也要留住'); });
  await until(async () => (await status(page, 'r1')) === 'error', '没有进入 error');
  await page.evaluate(() => window.__unmountAll());
  await page.evaluate(() => { window.__ctl.fault = null; window.__mount(); });
  await ready(page);

  assert.equal((await counters(page)).loads, 1, '重挂不重发 GET');
  assert.equal(await text(page), '失败也要留住', '失败草稿跨卸载保留');
  assert.equal(await status(page, 'r1'), 'error', '重挂仍是失败面，不自动重试');
  assert.equal((await counters(page)).resourceWrites, 1, '重挂不偷偷重发');

  await page.evaluate(() => window.__hook.retryAll());
  await until(async () => (await status(page, 'r1')) === 'saved', '显式重试没有把草稿存下去');
  assert.equal((await counters(page)).resourceWrites, 2);
});

await scenario('409 冲突后关闭 main → 重挂仍是 conflict、草稿在，绝不自动覆盖', async page => {
  await page.evaluate(() => window.__mount());
  await ready(page);
  await page.evaluate(() => {
    window.__ctl.fault = { code: 'version-conflict', version: 'v-server' };
    window.__setText('冲突的本地稿');
  });
  await until(async () => (await status(page, 'r1')) === 'conflict', '没有进入 conflict');
  assert.ok((await page.evaluate(() => window.__hook.conflictKeys)).includes('r1'));

  await page.evaluate(() => window.__unmountAll());
  await page.evaluate(() => { window.__ctl.fault = null; window.__mount(); });
  await ready(page);
  assert.equal((await counters(page)).loads, 1);
  assert.equal(await text(page), '冲突的本地稿');
  assert.equal(await status(page, 'r1'), 'conflict', '重挂仍是冲突面');
  assert.ok((await page.evaluate(() => window.__hook.conflictKeys)).includes('r1'));
  assert.equal((await counters(page)).resourceWrites, 1, '重挂绝不自动覆盖冲突');

  // 只有用户显式「保留本地」才以服务器版本为 CAS 基准再存。
  await page.evaluate(() => window.__hook.resolveConflict('r1', { discard: false }));
  await until(async () => (await counters(page)).resourceWrites === 2, '显式保留本地没有发出写请求');
  const casBase = await page.evaluate(() => window.__ctl.writes[window.__ctl.writes.length - 1].expectedVersion);
  assert.equal(casBase, 'v-server', '保留本地要用冲突回包里的服务器版本作 CAS 基准，不能偷换');
  await until(async () => (await status(page, 'r1')) === 'saved', '保留本地的重试没有落盘');
});

await scenario('StrictMode 双挂载只发一次 GET；卸载再挂回不重新载入', async page => {
  await page.evaluate(() => window.__mount());
  await ready(page);
  assert.equal((await counters(page)).loads, 1, 'StrictMode 双调 effect 只发一次 GET');
  assert.equal((await counters(page)).layoutWrites, 0);
  // 卸载再挂回：控制器与载入基线都在会话里；因为链是干净的，adopt 会立即核对一次外部版本
  // （不允许「再进永远跳过 GET」），所以这里的第二次读是那次核对，不是重新载入。
  await page.evaluate(() => window.__unmountAll());
  await page.evaluate(() => window.__mount());
  await ready(page);
  assert.equal((await counters(page)).loads, 2, '重挂没有重新载入，只多一次外部版本核对');
  assert.equal(await text(page), 'base');
  assert.equal((await counters(page)).layoutWrites, 0, '核对同版本时不写 layout');
});

await scenario('同一会话两个 main 竞争：旧实例写权限 fail closed', async page => {
  await page.evaluate(() => window.__mount());
  await ready(page);
  await page.evaluate(() => { window.__staleHook = window.__hook; window.__mount(); });
  await page.waitForFunction(() => window.__hook && window.__hook !== window.__staleHook, null, { timeout: 12000 });
  await ready(page);
  const verdict = await page.evaluate(() => ({
    staleMarkEdit: window.__staleHook.markEdit(),
    freshMarkEdit: window.__hook.markEdit(),
  }));
  assert.equal(verdict.staleMarkEdit, false, '被接管的实例不能再接受编辑');
  assert.equal(verdict.freshMarkEdit, true, '新挂载仍可编辑');
  // 首次挂载 1 次 GET + 接管后的外部版本核对 1 次；没有第二份载入。
  assert.equal((await counters(page)).loads, 2, '两个 main 竞争不重新载入');
  await page.evaluate(() => window.__unmountAll());
});

await scenario('显式丢弃 + 失败的草稿：丢弃的 GET 在途时关 main，重挂仍执行丢弃且不重发旧稿', async page => {
  await page.evaluate(() => window.__mount());
  await ready(page);
  await page.evaluate(() => { window.__ctl.fault = { code: 'network', message: '断网' }; window.__setText('要丢弃的失败稿'); });
  await until(async () => (await status(page, 'r1')) === 'error', '没有进入 error');
  assert.equal((await counters(page)).resourceWrites, 1);

  // 用户点「放弃本地重新载入」并确认；GET 挂起，然后 main 被关掉。
  await page.evaluate(() => {
    window.__ctl.fault = null;
    window.__ctl.holdGet = true;
    window.confirm = () => true;
    window.__reload = window.__hook.reloadStore({ confirmDiscard: true });
  });
  await until(async () => (await page.evaluate(() => window.__ctl.gets.length)) === 1, 'reload 没有发出 GET');
  await page.evaluate(() => window.__unmountAll());
  // 回包落在没人挂载的窗口里。重挂必须复用这次载入（携带「确认丢弃」），不能重发旧草稿。
  await page.evaluate(() => window.__ctl.resolveGet(0, window.__ctl.payload()));
  await delay(150);
  await page.evaluate(() => { window.__ctl.holdGet = false; window.__ctl.loads = 0; window.__mount(); });
  await ready(page);
  await until(async () => (await counters(page)).loads === 1, '重挂后只应补一次外部版本核对（回包必须被复用）');
  assert.equal(await page.evaluate(() => window.__ctl.store().loadOp.applied), true, '已回包但没应用的载入要被重挂认领');

  const after = await counters(page);
  assert.equal(after.loads, 1, '重挂复用这次载入，不再重发 GET');
  assert.equal(after.resourceWrites, 1, '被丢弃的失败稿绝不能重发');
  assert.equal(await text(page), 'base', '丢弃后应显示重新载入的服务器版本');
  const state = await page.evaluate(() => ({
    dirty: window.__ctl.store().isDirty(),
    states: Object.values(window.__hook.saveStatus).map(item => item.state),
    canEdit: window.__hook.canEdit,
  }));
  assert.equal(state.dirty, false, '确认丢弃之后会话里不该再有草稿');
  assert.deepEqual(state.states.filter(name => name !== 'saved' && name !== 'idle'), [], '丢弃后不该残留 pending/error/saving 状态');
  assert.equal(state.canEdit, true);
  await delay(900);
  assert.equal((await counters(page)).resourceWrites, 1, '等过一个 debounce 周期也不能迟到重发');
});

await scenario('旧格式库：相机恢复途中关 main，重挂停在 upgrade、编辑门禁绝不重开', async page => {
  await page.evaluate(() => {
    const payload = window.__ctl.payload();
    window.__ctl.payloadOverride = { ...payload, schemaVersion: 1 };
    window.__ctl.holdViewport = true;
    window.__mount();
  });
  await until(async () => (await page.evaluate(() => window.__ctl.viewportHeld.length)) === 1, '载入没有走到相机恢复');
  const midway = await page.evaluate(() => ({ state: window.__hook.loadState, canEdit: window.__hook.canEdit }));
  assert.equal(midway.state, 'loading', '相机恢复完成前仍是载入面');
  assert.equal(midway.canEdit, false);

  // 相机还没恢复完就关掉 main：会话里已有 v1 基线，但没有应用过编辑门禁。
  await page.evaluate(() => window.__unmountAll());
  await page.evaluate(() => { window.__ctl.holdViewport = false; window.__ctl.releaseViewport(0); });
  await delay(150);
  await page.evaluate(() => window.__mount());
  await page.waitForFunction(() => window.__hook && window.__hook.loadState === 'upgrade', null, { timeout: 12000 });

  const after = await page.evaluate(() => ({
    canEdit: window.__hook.canEdit,
    loads: window.__ctl.loads,
    resourceWrites: window.__ctl.resourceWrites,
    layoutWrites: window.__ctl.layoutWrites,
    storeState: window.__ctl.store().loadState,
  }));
  assert.equal(after.storeState, 'upgrade');
  assert.equal(after.canEdit, false, '旧格式库重挂后仍必须只读');
  assert.equal(after.loads, 1, '重挂不重新载入');
  assert.equal(after.resourceWrites, 0, '只读库不能写资源');
  assert.equal(after.layoutWrites, 0, '重挂的默认相机不能写成 layout 草稿');

  // 再挂一次也不可能把门禁打开。
  await page.evaluate(() => window.__unmountAll());
  await page.evaluate(() => window.__mount());
  await page.waitForFunction(() => window.__hook && window.__hook.loadState === 'upgrade', null, { timeout: 12000 });
  assert.equal(await page.evaluate(() => window.__hook.canEdit), false);
  assert.equal((await counters(page)).loads, 1);
  await delay(900);
  assert.equal((await counters(page)).layoutWrites, 0);
});

await scenario('重挂时相机恢复未完成不写 layout；恢复后用同一相机也不产生假写', async page => {
  await page.evaluate(() => window.__mount());
  await ready(page);
  await page.evaluate(() => { window.__ctl.holdViewport = true; window.__unmountAll(); window.__mount(); });
  // StrictMode 会双调 effect：两次 restore 都可能走到相机恢复，所以这里是「至少一次」。
  await until(async () => (await page.evaluate(() => window.__ctl.viewportHeld.length)) >= 1, '重挂没有走到相机恢复');
  const midway = await page.evaluate(() => ({ state: window.__hook.loadState, canEdit: window.__hook.canEdit, writes: window.__ctl.layoutWrites }));
  assert.equal(midway.state, 'loading', '相机恢复完成前保持载入门禁');
  assert.equal(midway.canEdit, false);
  assert.equal(midway.writes, 0, '相机恢复期间不能写 layout');

  await page.evaluate(() => {
    window.__ctl.holdViewport = false;
    while (window.__ctl.viewportHeld.length) window.__ctl.releaseViewport(0);
  });
  await ready(page);
  await until(async () => (await counters(page)).loads === 2, 'clean 重挂应补一次外部版本核对');
  const restored = await page.evaluate(() => ({
    camera: window.__ctl.camera,
    last: window.__ctl.store().lastViewport,
    writes: window.__ctl.layoutWrites,
  }));
  assert.deepEqual(restored.last, { x: 10, y: 20, zoom: 0.8 });
  assert.deepEqual(restored.camera, { x: 10, y: 20, zoom: 0.8 }, '相机要真正还原到 flow 上');
  assert.equal(restored.writes, 0, '还原相机本身不是一次 layout 编辑');
  await delay(300);
  assert.equal((await counters(page)).layoutWrites, 0, '重挂后的捕获 effect 不能把恢复的相机另存一遍');

  // 用户没动相机时 App 再报一次同样的相机，也不能产生 layout 写。
  await page.evaluate(() => window.__hook.saveViewport({ x: 10, y: 20, zoom: 0.8 }));
  await delay(300);
  assert.equal((await counters(page)).layoutWrites, 0, '同一相机重复上报必须被指纹去重');
  // 真改了相机才写一次（证明去重没有把保存路径焊死）。
  await page.evaluate(() => window.__hook.saveViewport({ x: 1, y: 2, zoom: 1 }));
  await until(async () => (await counters(page)).layoutWrites === 1, '改相机后没有保存 layout');
});

await scenario('显式 reload 之后：lease 必须恢复 runtime 镜像，关 main 再挂回不显示旧稿', async page => {
  await page.evaluate(() => window.__mount());
  await ready(page);
  await page.evaluate(() => window.__setText('第一版'));
  await until(async () => (await status(page, 'r1')) === 'saved', '第一版没有落盘');

  await page.evaluate(async () => { window.confirm = () => true; await window.__hook.reloadStore({ confirmDiscard: true }); });
  await ready(page);
  assert.equal(await text(page), '第一版', 'reload 后应显示服务器上的版本');

  await page.evaluate(() => window.__setText('reload 之后'));
  await until(async () => (await status(page, 'r1')) === 'saved', 'reload 之后的编辑没有落盘');

  await page.evaluate(() => window.__unmountAll());
  await page.evaluate(() => window.__mount());
  await ready(page);
  assert.equal(await text(page), 'reload 之后', 'reload 之后的编辑必须写进会话 runtime，重挂不能显示旧稿');
  await until(async () => (await counters(page)).loads === 3, 'clean 重挂应补一次外部版本核对');
  assert.equal(await status(page, 'r1'), 'saved', '同版本核对不该把干净状态打回 pending');
});

await scenario('首次载入失败后重试成功：lease 也必须恢复 runtime 镜像，关 main 再挂回不显示旧稿', async page => {
  await page.evaluate(() => { window.__ctl.getFault = { message: '断网' }; window.__mount(); });
  await page.waitForFunction(() => window.__hook && window.__hook.loadState === 'error', null, { timeout: 12000 });
  assert.equal(await page.evaluate(() => window.__hook.canEdit), false, '载入失败不能开编辑门禁');

  // 用户点「重试载入」：这回 GET 成功。这条路径里 adopt 已经从没设置过 lease.restored。
  await page.evaluate(async () => {
    window.__ctl.getFault = null;
    window.confirm = () => true;
    await window.__hook.reloadStore({ confirmDiscard: true });
  });
  await ready(page);
  assert.equal(await text(page), 'base');
  await page.evaluate(() => window.__setText('重试之后'));
  await until(async () => (await status(page, 'r1')) === 'saved', '重试之后的编辑没有落盘');

  await page.evaluate(() => window.__unmountAll());
  await page.evaluate(() => window.__mount());
  await ready(page);
  assert.equal(await text(page), '重试之后', '重试成功后 lease 必须重新镜像 runtime，重挂不能显示旧稿');
});

await browser.close();
server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });

const failed = results.filter(result => !result.ok);
if (failed.length) {
  console.error(`\n${failed.length}/${results.length} 个场景失败`);
  process.exit(1);
}
console.log(`\n${results.length} 个场景全部通过`);
