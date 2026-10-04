/* #74 的**真浏览器**端到端：改盘上的文件 → 监听 → SSE → 打开的页面自己更新（不刷新）。
   ────────────────────────────────────────────────────────────────────────────────
   为什么要有这一条：这张 ticket 的验收第一条是「改一个课件文件：打开的页面收到推送并更新，
   **无需手动刷新**」。Host 半那一节在真 DSH 探针里验过（改文件 → 收到通知），页面那一节在
   Node 里用同一份 lib/client.js 验过（通知 → 静默重取 → 沿用旧引用）。剩下唯一没被真东西
   连起来的一段是**浏览器的 EventSource ↔ 我们那条流式 Response**：这条只有真浏览器能验。

   夹具怎么搭：
     · 一个**真 HTTP 服务**：/ 给夹具页，/api/studymate/library 现读临时工作区，
       /api/studymate/events 走 lib/watch 的推送通道（bridge 与宿主载体同形：先 writeHead、
       再逐块 write body）；
     · 页面里是真的 fetch 与真的 EventSource（**不 stub**），插件本体是从 lib/client.js
       现取的（不手抄一份标记）；
     · 监听走 Node fs.watch 后端（这台机器上有没有 ctx.fs 不由我们定），DSH_HOME 指向
       临时配置，工作区现造、跑完即弃。

   浏览器二进制由 harness 探测；找不到时明确跳过（退出码 3），不是静默绿。 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readLibrary } from '../../../lib/library.ts';
import * as watch from '../../../lib/watch/index.ts';
import { extractCss } from '../fixtures/client-css.mjs';
import { writeSubject } from '../fixtures/tools.mjs';
import { finishSuite, openSession } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SUITE = 'watch-push';

let failures = 0;
function check(label, ok, detail = '') {
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}

/* ── 临时工作区 + 隔离的 DSH_HOME（跑完即弃，ADR-0009）──────────────────── */

const TEMPS = [];

function subjectYamlNamed(slug, name) {
  return [`name: ${name}`, `slug: ${slug}`, 'goal: 在真浏览器里验推送', 'status: 学习中',
    'created_at: "2026-01-02T03:04:05+08:00"', ''].join('\n');
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-watch-push-'));
  TEMPS.push(root);
  const home = path.join(root, 'home');
  const dshHome = path.join(home, '.dsh');
  const workspace = path.join(home, '学习资料');
  fs.mkdirSync(dshHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(dshHome, 'studymate-config.yaml'), `workspace: ${JSON.stringify(workspace)}\n`);
  const demo = writeSubject(workspace, 'demo');
  fs.writeFileSync(path.join(demo.dir, 'subject.yaml'), subjectYamlNamed('demo', '演示科目'));
  return { root, dshHome, workspace, demo };
}

/* ── 真 HTTP 服务：页面 + 数据 + SSE ───────────────────────────────────── */

/** 与宿主载体同形：先 writeHead，再把 Response 的 body 逐块写出去（SSE 靠的就是这个）。 */
async function bridge(req, res, routeFetch) {
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  const request = new Request(new URL(req.url, 'http://127.0.0.1'), {
    method: req.method, headers: req.headers, signal: abort.signal,
  });
  const response = await routeFetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (!response.body) { res.end(); return; }
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

function buildPage() {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
  const css = extractCss(source);
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>#74 推送端到端夹具</title>
<style>html, body { margin: 0; height: 100%; } #root { height: 100%; }</style>
<style id="plugin-css">${css}</style>
<script>
  // 数一下页面发了几次 /api/studymate/library：推送驱动的话，改一次文件只多一次；
  // 轮询的话它会一直涨。这是「页面靠推送更新」的直接凭据。
  window.__fetchCount = 0;
  (function () {
    var original = window.fetch;
    window.fetch = function () { window.__fetchCount += 1; return original.apply(this, arguments); };
  }());
  window.__ModuleLoader__ = { load: function (spec) { window.__StudymateSpec = spec; } };
</script>
</head>
<body>
<div id="root"></div>
<script src="/mini-react.js"></script>
<script src="/client.js"></script>
<script>
  (function () {
    var spec = window.__StudymateSpec;
    if (!spec) throw new Error('lib/client.js 没有向 window.__ModuleLoader__ 登记');
    var mod = spec.factory(function (name) { return name === 'react' ? window.MiniReact : undefined; });
    var Main = null;
    mod.apply({
      slots: {
        inject: function (seat, callback) { callback(); },
        register: function (options, component) { if (options && options.name === 'main') Main = component; },
      },
    });
    if (!Main) throw new Error('没有从 main 座位拿到组件');
    window.MiniReact.mount(window.MiniReact.createElement(Main, null), document.getElementById('root'));
  }());
</script>
</body>
</html>
`;
}

async function serve({ workspace, sseRoute, page, miniReact }) {
  const server = http.createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      try {
        if (pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page);
          return;
        }
        if (pathname === '/favicon.ico') {
          // 夹具页不需要图标：不接这一下，浏览器那条 404 会算进「失败请求」里
          res.writeHead(204); res.end();
          return;
        }
        if (pathname === '/client.js' || pathname === '/mini-react.js') {
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
          res.end(pathname === '/client.js'
            ? fs.readFileSync(path.join(ROOT, 'lib', 'client.js'))
            : fs.readFileSync(miniReact));
          return;
        }
        if (pathname === '/api/studymate/library') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(readLibrary({ workspace })));
          return;
        }
        if (pathname === '/api/studymate/events') {
          await bridge(req, res, sseRoute.fetch);
          return;
        }
        res.writeHead(404); res.end('not found');
      } catch (error) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(String(error && error.message ? error.message : error));
      }
    })();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 轮询页面文本，等某个词出现（推送是异步的：监听去抖 + 重取 + 重渲）。 */
async function waitForText(session, needle, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let text = '';
  for (;;) {
    text = await session.evaluate('document.body.innerText');
    if (String(text).includes(needle)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/* ── 跑 ────────────────────────────────────────────────────────────────── */

const previousDshHome = process.env.DSH_HOME;
let server = null;
let disposeChannel = null;
let session = null;
try {
  const { dshHome, workspace, demo } = makeWorkspace();
  process.env.DSH_HOME = dshHome;

  // 推送通道：真的注册进 lib/watch（生产里那行挂在 connection 注入里，这里用一个最小载体接住）
  const routes = [];
  const connection = { fetch: { register: (route) => { routes.push(route); return () => {}; } } };
  disposeChannel = watch.registerWatchChannel({ get: (name) => (name === 'connection' ? connection : undefined) });
  const sseRoute = routes[0];
  if (!sseRoute) throw new Error('推送路由没注册上');

  // 监听：Node fs.watch 后端（这台机器没有 ctx.fs 服务），工作区来自隔离的 DSH_HOME
  watch.registerWatch({ effect: (fn) => fn(), get: () => undefined });

  server = await serve({
    workspace,
    sseRoute,
    page: buildPage(),
    miniReact: path.join(ROOT, 'scripts', 'tests', 'fixtures', 'mini-react.js'),
  });

  session = await openSession({ suite: SUITE });
  // 页面没被重新加载的凭据：刷新会把它抹掉
  await session.inject('window.__alive = "first-load";');

  await session.scene('watch-push', async (ctx) => {
    await ctx.navigate(server.origin + '/', { settle: 1500 });
    const initial = await ctx.evaluate('document.body.innerText');
    check('夹具页渲染出科目列表', String(initial).includes('演示科目'), String(initial).slice(0, 200));
    const fetchesAfterLoad = await ctx.evaluate('window.__fetchCount');
    check('首屏只取了一次库数据', fetchesAfterLoad === 1, String(fetchesAfterLoad));

    // ① 改盘上的科目文件：打开的页面要自己更新，不许手动刷新
    fs.writeFileSync(path.join(demo.dir, 'subject.yaml'), subjectYamlNamed('demo', '演示科目（改过）'));
    const renamed = await waitForText(ctx, '演示科目（改过）');
    check('改一个科目文件：页面收到推送并更新，无需手动刷新', renamed,
      String(await ctx.evaluate('document.body.innerText')).slice(0, 200));
    check('页面没有重新加载（推送更新，不是刷新）', await ctx.evaluate('window.__alive') === 'first-load');

    // ② 外层新建一个科目：阅读端要自动出现
    const fresh = writeSubject(workspace, 'brand-new');
    fs.writeFileSync(path.join(fresh.dir, 'subject.yaml'), subjectYamlNamed('brand-new', '新来的科目'));
    const appeared = await waitForText(ctx, '新来的科目');
    check('外层新建一个科目：阅读端自动出现', appeared,
      String(await ctx.evaluate('document.body.innerText')).slice(0, 200));

    const fetches = await ctx.evaluate('window.__fetchCount');
    check('两次变更只多取了两次（推送驱动，不是轮询）', fetches === 3, String(fetches));
    return { fetchesAfterLoad, fetches, renamed, appeared };
  });
} catch (error) {
  check('真浏览器端到端跑完（浏览器起来、夹具能开）', false, String(error && error.stack ? error.stack : error));
} finally {
  if (session) await finishSuite(session, { suite: SUITE, failed: failures });
  if (server) await server.close();
  if (disposeChannel) disposeChannel();
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} 条失败` : '\n全部通过');
if (failures) process.exit(1);
