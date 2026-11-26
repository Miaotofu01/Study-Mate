// 正式组合客户端的隔离宿主夹具。只使用临时 HOME、真实 notes HTTP/存储和空会话服务。
// 夹具显式 seedDemo 才写测试演示；产品首次加载空库不会初始化演示正文。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { libraryPayload } from './reading_position_fixture.mjs';
import { handleNotes, NOTES_PATH } from '../../../lib/notes/route.ts';
import { MAX_REQUEST_BYTES, notesRoot, readNotesStore, writeNotesLayout, writeNotesResource } from '../../../lib/notes/store.ts';
import { makeDemo } from '../../../client/notes/fixtures.js';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const rootRequire = createRequire(path.join(ROOT, 'package.json'));

export const DEMO_FOLDERS = [
  { id: 'library', parent: null, name: '我的资料', kind: 'folder' },
  { id: 'book', parent: 'library', name: '学习与理解', kind: 'notebook' },
  { id: 'notes', parent: 'book', name: '概念', kind: 'folder' },
  { id: 'examples', parent: 'book', name: '例子', kind: 'folder' },
  { id: 'references', parent: 'library', name: '参考', kind: 'folder' },
];

export function buildFormalNotesClient() {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-client.mjs')], {
    cwd: ROOT, windowsHide: true, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`正式客户端构建失败，退出码 ${result.status}`);
}

export async function loadNotesPlaywright() {
  // 缺少源码或根 devDependency 是失败，只有缺浏览器二进制允许明确 skip。
  const entry = rootRequire.resolve('playwright');
  return import(pathToFileURL(entry).href);
}

export function isMissingEdge(error) {
  const text = String(error?.message || error);
  return /(Executable doesn't exist|is not found at|Unable to launch browser|not installed|no such file|ENOENT|Could not find Microsoft Edge)/i.test(text)
    && /(channel|msedge|Edge|executable)/i.test(text);
}

// 由各临时宿主页嵌入的同形加载器：分块成功缓存、失败不缓存，重试真的发请求。
// 保持函数自包含，嵌入源码时不依赖 Node 或测试进程闭包。
export function installNotesFixtureModuleLoader(modules, { asyncDisabled = false } = {}) {
  let rootEntry;
  const entries = Object.create(null);
  const promises = Object.create(null);
  window.__ModuleLoader__ = { load(entry) {
    if (typeof entry?.chunk === 'string') entries[entry.chunk] = entry;
    else rootEntry = entry;
  } };
  const require = name => {
    if (Object.hasOwn(modules, name)) return modules[name];
    throw new Error('夹具没有这个模块：' + name);
  };
  if (!asyncDisabled) require.async = spec => {
    if (typeof spec !== 'string' || !spec.startsWith('./')) return Promise.reject(new Error('夹具 require.async 只认包内相对分块：' + spec));
    const fileName = spec.slice(2);
    if (!/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(fileName)) return Promise.reject(new Error('夹具拒绝这个分块名：' + fileName));
    if (!promises[fileName]) {
      promises[fileName] = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/' + fileName;
        const fail = error => { delete promises[fileName]; reject(error); };
        script.onload = () => {
          const entry = entries[fileName];
          if (!entry) { fail(new Error('分块脚本没有登记：' + fileName)); return; }
          try { resolve(entry.factory(require)); } catch (error) { fail(error); }
        };
        script.onerror = () => fail(new Error('分块脚本加载失败：' + fileName));
        document.head.appendChild(script);
      });
    }
    return promises[fileName];
  };
  return { require, get entry() { return rootEntry; }, get chunks() { return Object.keys(entries); } };
}

// 真 React 树，主面板/slot/service 形状同品牌回归。没有模型或真实用户会话。
const HOST_SOURCE = `
import React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';
const registrations = [];
const cleanups = [];
const own = task => { const off = task(); if (typeof off === 'function') cleanups.push(off); return off; };
let layoutSelects = 0;
const EMPTY = Object.freeze({byId:Object.freeze({}),order:Object.freeze([])});
const services = {
  slots: {
    inject(_name, task) { return own(task); },
    register(spec, component) { const row = {spec,component}; registrations.push(row); return () => { const i = registrations.indexOf(row); if (i >= 0) registrations.splice(i, 1); }; },
  },
  sessions: {list:{subscribe(){return()=>{}},getSnapshot(){return EMPTY}}},
  inputTriggers:{registerSource(){return()=>{}}},
  conversation:{input:{for(){throw new Error('夹具没有显式会话')}}},
  layout:{selectPanel(){layoutSelects++}},
};
const moduleLoader = (${installNotesFixtureModuleLoader.toString()})({
  react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient,
}, { asyncDisabled: window.__disableChunkAsync });
const localeDictionaries = new Map(), localeListeners = new Set(), localeInjections = [];
let activeLocale = 'en', localeWrites = 0;
const locale = {
  register(ns, dict) { localeDictionaries.set(ns, dict); return () => localeDictionaries.delete(ns); },
  bind: ns => (key, params = {}) => Object.entries(params).reduce(
    (text, [name, value]) => text.split('{' + name + '}').join(String(value)),
    localeDictionaries.get(ns)?.[activeLocale]?.[key] ?? localeDictionaries.get(ns)?.en?.[key] ?? key),
  subscribe(fn) { localeListeners.add(fn); return () => localeListeners.delete(fn); },
  setLocale() { localeWrites++; },
};
const mountLocale = item => {
  const effects = [];
  item.fn({ locale, effect(task) { const off = task(); if (typeof off === 'function') effects.push(off); return off; } });
  item.off = () => { for (const off of effects.reverse()) off(); };
};
const localeProbe = {
  provide(language) { activeLocale = language; services.locale = locale; for (const item of localeInjections) if (!item.off) mountLocale(item); },
  remove() { delete services.locale; for (const item of localeInjections) { item.off?.(); item.off = null; } },
  switchTo(language) { activeLocale = language; for (const fn of [...localeListeners]) fn(); },
  get listeners() { return localeListeners.size; },
  get dictionaries() { return localeDictionaries.size; },
  get writes() { return localeWrites; },
};
if (window.__fixtureLocale) localeProbe.provide(window.__fixtureLocale);
window.__probe = {
  locale: localeProbe,
  get registrations(){return registrations.map(({spec})=>JSON.parse(JSON.stringify(spec)))},
  get chunkRegistrations(){return moduleLoader.chunks},
  get layoutSelects(){return layoutSelects},
  applied:false,
};
window.__start=()=>{
  if(!moduleLoader.entry) throw new Error('组合产物没有登记模块');
  const cleanup = moduleLoader.entry.factory(moduleLoader.require).apply({
    ...services,
    get(name){return services[name]},
    effect: own,
    inject(names, fn) {
      if (!names.includes('locale')) return;
      const item = {fn, off:null}; localeInjections.push(item);
      if (services.locale) mountLocale(item);
      cleanups.push(() => { item.off?.(); const i = localeInjections.indexOf(item); if (i >= 0) localeInjections.splice(i, 1); });
    },
  });
  if (typeof cleanup === 'function') cleanups.push(cleanup);
  window.__probe.applied=true;
  const main=registrations.find(x=>x.spec.name==='main');
  if(!main)throw new Error('组合产物没有登记 main');
  const SessionProvider=({children})=>children;
  const root=ReactDOMClient.createRoot(document.getElementById('root'));
  root.render(React.createElement(main.component,{SessionProvider,renderSlot:()=>null,renderFactorySlot:()=>null}));
  window.__dispose=()=>{root.unmount();for(const cleanup of cleanups.reverse())cleanup()};
};
`;

async function writeBrowserHost(dir, { asyncDisabled = false } = {}) {
  const esbuild = await import(pathToFileURL(rootRequire.resolve('esbuild')).href);
  await esbuild.build({
    absWorkingDir: ROOT,
    stdin: { contents: HOST_SOURCE, resolveDir: ROOT, sourcefile: 'notes-persistence-host.js' },
    outfile: path.join(dir, 'host.js'), bundle: true, format: 'iife', platform: 'browser',
    target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  fs.copyFileSync(path.join(ROOT, 'dist', 'client.js'), path.join(dir, 'client.js'));
  fs.copyFileSync(path.join(ROOT, 'dist', 'client.notes.js'), path.join(dir, 'client.notes.js'));
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>StudyMate notes persistence fixture</title><style>html,body,#root{height:100%;margin:0}body{background:#f6f7f9}</style></head><body><div id="root"></div><script>window.__disableChunkAsync=${JSON.stringify(asyncDisabled)}</script><script src="/host.js"></script><script src="/client.js"></script><script>window.__start()</script></body></html>`);
}

function requireOk(result) {
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result));
  return result.value;
}

export function seedNotesDemo(home) {
  const demo = makeDemo();
  // 显式 fixture DTO，不用被测客户端 serializer 构造种子，避免同错相抵。
  const layout = {
    folders: structuredClone(DEMO_FOLDERS), viewport: { x: 0, y: 0, zoom: 1 },
    nodes: demo.scene.nodes.map(n => ({ id: n.id, type: n.type, position: n.position, data: n.data, style: n.style })),
    edges: demo.scene.edges.map(e => ({ id: e.id, type: 'relation', source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, data: e.data })),
  };
  requireOk(writeNotesLayout({ home, layout, expectedVersion: null }));
  for (const resource of Object.values(demo.resources)) {
    const parent = resource.type === 'note' ? (resource.id === 'note-example' ? 'examples' : 'notes') : 'references';
    requireOk(writeNotesResource({ home, resource: { ...resource, parent }, expectedVersion: null }));
  }
}

async function requestBytes(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('fixture request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function sendResponse(response, value) {
  response.writeHead(value.status, Object.fromEntries(value.headers));
  response.end(Buffer.from(await value.arrayBuffer()));
}

function faultResponse(fault) {
  return Response.json({ ok: false, error: { code: fault.code || 'write-failed', message: fault.message || '测试控制的 HTTP 失败' } }, { status: fault.status || 503 });
}

function safeStaticPath(dir, suffix) {
  const target = path.resolve(dir, '.' + suffix);
  const relative = path.relative(path.resolve(dir), target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? target : null;
}

/** 每实例独立 HOME 与 localhost 端口；fault/delay 仅属于测试服务器，不进入产品。 */
export async function startNotesHostFixture({ seedDemo = false, library = libraryPayload(), build = true, asyncDisabled = false } = {}) {
  if (build) buildFormalNotesClient();
  const tempParent = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempParent, 'studymate-notes-host-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  let server;
  const requests = [];
  const chunkRequests = [];
  const problems = [];
  const pendingReads = new Set();
  const pendingWrites = new Set();
  const pendingReadReplies = new Set();
  const controls = {
    pauseReads: false, pauseWrites: false, pauseReadReplies: false, readFault: null, writeFault: null, chunkFailures: 0,
    releaseReads() { this.pauseReads = false; for (const release of pendingReads) release(); pendingReads.clear(); },
    releaseWrites() { this.pauseWrites = false; for (const release of pendingWrites) release(); pendingWrites.clear(); },
    releaseReadReplies() { this.pauseReadReplies = false; for (const release of pendingReadReplies) release(); pendingReadReplies.clear(); },
  };
  const waitIfPaused = (kind) => {
    const [flag, queue] = kind === 'read' ? ['pauseReads', pendingReads]
      : kind === 'readReply' ? ['pauseReadReplies', pendingReadReplies] : ['pauseWrites', pendingWrites];
    return controls[flag] ? new Promise(resolve => queue.add(resolve)) : undefined;
  };
  try {
    await writeBrowserHost(dir, { asyncDisabled });
    if (seedDemo) seedNotesDemo(home);
    server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        const pathname = decodeURIComponent(url.pathname);
        // 宿主按需拉的分块（client.*.js）：逐条记录 + 可注入一次失败（503），
        // 验收断言用请求条数，不猜测浏览器缓存行为。
        if (/^\/client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(pathname)) {
          const record = { path: pathname, status: null };
          chunkRequests.push(record);
          response.once('finish', () => { record.status = response.statusCode; });
          if (controls.chunkFailures > 0) {
            controls.chunkFailures -= 1;
            response.writeHead(503, { 'content-type': 'text/plain' });
            response.end('chunk failure injected by fixture');
            return;
          }
        }
        if (pathname === NOTES_PATH) {
          const bytes = await requestBytes(request);
          let body = null;
          if (bytes.length) { try { body = JSON.parse(bytes.toString('utf8')); } catch { /* 真 route 判断 JSON */ } }
          const record = { method: request.method, url: request.url, body, status: null };
          requests.push(record);
          const kind = request.method === 'GET' ? 'read' : 'write';
          await waitIfPaused(kind);
          const fault = kind === 'read' ? controls.readFault : controls.writeFault;
          const real = new Request('http://127.0.0.1' + request.url, {
            method: request.method, headers: request.headers,
            ...(bytes.length ? { body: bytes } : {}),
          });
          const answer = fault ? faultResponse(fault) : await handleNotes(real, home);
          record.status = answer.status;
          record.readReplyPending = kind === 'read' && controls.pauseReadReplies;
          if (kind === 'read') await waitIfPaused('readReply');
          await sendResponse(response, answer);
          record.readReplyPending = false;
          return;
        }
        if (pathname === '/api/studymate/library') {
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(JSON.stringify(library));
          return;
        }
        if (pathname === '/plugins/studymate/events') {
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          response.write(': connected\n\n');
          return;
        }
        // 同端口的独立 preview；源码仍不接 adapter，以请求日志证明内存边界。
        // Vite 产物使用 /assets 和 /favicon.svg 绝对路径；临时宿主也须提供它们。
        const previewPage = pathname.startsWith('/preview/');
        const preview = previewPage || pathname.startsWith('/assets/') || pathname === '/favicon.svg';
        const staticRoot = preview ? path.join(ROOT, 'dist', 'notes-preview') : dir;
        const suffix = previewPage ? pathname.slice('/preview'.length) : pathname;
        const target = safeStaticPath(staticRoot, suffix === '/' ? '/index.html' : suffix);
        if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          response.writeHead(404, { 'content-type': 'text/plain' }); response.end('not found'); return;
        }
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[path.extname(target)] || 'application/octet-stream';
        response.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
        response.end(fs.readFileSync(target));
      } catch (error) {
        problems.push(error?.stack || String(error));
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(String(error?.message || error));
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    return {
      dir, home, root: notesRoot(home), origin, server, controls, requests, chunkRequests, problems,
      read() { return requireOk(readNotesStore({ home })); },
      async close() {
        controls.releaseReads(); controls.releaseWrites(); controls.releaseReadReplies();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        // 删除前验证 mkdtemp 的绝对根，禁止把环境变量给出的父目录当清理目标。
        assert.equal(path.dirname(path.resolve(dir)), tempParent);
        assert.ok(path.basename(dir).startsWith('studymate-notes-host-'));
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      },
    };
  } catch (error) {
    controls.releaseReads(); controls.releaseWrites(); controls.releaseReadReplies();
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.equal(path.dirname(path.resolve(dir)), tempParent);
    assert.ok(path.basename(dir).startsWith('studymate-notes-host-'));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    throw error;
  }
}

export async function enterNotes(page, origin) {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-proto="brand-switch"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-proto="brand-switch"]').click();
  // NoteEditor 也使用样式命名空间；这里只等待唯一的 Board 根，不把组件当工作空间。
  await page.locator('.studymate-notes .app-shell').waitFor({ state: 'visible', timeout: 15000 });
}
