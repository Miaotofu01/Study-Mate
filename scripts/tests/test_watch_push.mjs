// 变更推送（#74 `lib/watch/channel.ts`）的两条路，都在**真 HTTP** 上过一遍：
//   · 路 A：`connection.fetch.register` 返回一个 body 没写完的 `Response`（/api 下）；
//   · 路 B：`ctx.webServer.register` 的 exact 路由（/plugins 下，退路）。
//
// 中间那个 bridge 是照 DSH 载体的实现抄的（dsh-client-connection/lib/index.js:34-100：
// 先 writeHead，再 `for await (chunk of response.body)` 逐块 write）——「流式 Response
// 能不能当 SSE」这件事就是靠它成立，所以这里必须同形，不能图省事直接 res.write。
// 真 DSH 里的同一条验在 test_dsh_runtime.mjs。
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { useHome } from './fixtures/tools.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const watch = await import(pathToFileURL(path.join(ROOT, 'lib/watch/index.ts')).href);

/** 起一个真 HTTP 服务；`handler(req, res)` 自己写响应。 */
async function serve(handler) {
  const server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 与 DSH 载体的 bridge() 同形：Request 进来，Response 的 body 逐块写出去。 */
async function bridge(req, res, routeFetch) {
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  const request = new Request(new URL(req.url, 'http://127.0.0.1'), {
    method: req.method,
    headers: req.headers,
    signal: abort.signal,
  });
  const response = await routeFetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (!response.body) { res.end(); return; }
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

/** 读一条 SSE 流直到出现目标文本（或超时）。 */
function readerOf(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  return {
    text: () => text,
    async until(pattern, what) {
      const deadline = Date.now() + 5000;
      while (!pattern(text)) {
        if (Date.now() > deadline) throw new Error(`等不到${what}：${JSON.stringify(text)}`);
        const { value, done } = await reader.read();
        if (done) throw new Error(`流结束了（在等${what}）：${JSON.stringify(text)}`);
        text += decoder.decode(value, { stream: true });
      }
      return text;
    },
    cancel: () => reader.cancel(),
  };
}

/** 收下 console.warn（推送线在「没有工作区」这类情况下只警告，不该刷进套件输出）。 */
function captureWarnings(t) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => { console.warn = originalWarn; });
  return warnings;
}

test('推送路 A：connection.fetch.register 的流式 Response 就是一条 SSE（/api 下）', async (t) => {
  // 隔离 DSH_HOME：推送线会顺手把监听也拉起来，这里不让它去读真实工作区配置
  useHome(t, { withWorkspace: false });
  watch.resetWatchRegistryForTests();
  const warnings = captureWarnings(t);

  const routes = [];
  const ctx = {
    get: (name) => (name === 'connection'
      ? { fetch: { register(route) { routes.push(route); return async () => {}; } } }
      : undefined),
  };
  const dispose = watch.registerWatchChannel(ctx);
  t.after(() => Promise.resolve(dispose()));

  assert.equal(routes.length, 1, '只注册一条路由');
  assert.equal(routes[0].path, '/api/studymate/events');
  assert.deepEqual(routes[0].methods, ['GET']);
  assert.equal(routes[0].requestBody, 'buffered');
  assert.ok(warnings.some((text) => /没配置学习工作区/.test(text)), '没有工作区只该警告，不该抛');

  const server = await serve((req, res) => {
    if (new URL(req.url, 'http://x').pathname !== routes[0].path) { res.writeHead(404); res.end(); return; }
    return bridge(req, res, routes[0].fetch);
  });
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.port}/api/studymate/events`, {
    headers: { accept: 'text/event-stream' },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const stream = readerOf(response);
  t.after(() => stream.cancel());
  await stream.until((text) => text.includes(': studymate connected'), '建连问候');

  watch.publishChange(['lesson']);
  const frame = await stream.until((text) => /data: \{.*\}\n\n/.test(text), '变更通知帧');
  assert.match(frame, /^data: \{"kind":"changed","domains":\["lesson"\],"at":"[^"]+","seq":\d+\}$/m);
  await stream.cancel();
});

test('推送路 B（退路）：webServer 的 exact 路由，认证自己判（有 connection 就用 requestRejection）', async (t) => {
  useHome(t, { withWorkspace: false });
  watch.resetWatchRegistryForTests();
  captureWarnings(t);

  const routes = [];
  const connection = {
    requestRejection: (req) => (req.headers.cookie ? undefined : 401),
  };
  const ctx = {
    get: (name) => {
      if (name === 'connection') return connection;
      if (name === 'webServer') return { register(route) { routes.push(route); return () => {}; } };
      return undefined;
    },
  };
  const dispose = watch.registerWatchChannel(ctx, { route: 'webServer' });
  t.after(() => dispose());

  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'exact');
  assert.equal(routes[0].path, '/plugins/studymate/events');

  const server = await serve((req, res) => {
    if (new URL(req.url, 'http://x').pathname !== routes[0].path) { res.writeHead(404); res.end(); return; }
    return routes[0].handler(req, res);
  });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.port}/plugins/studymate/events`;

  // 不带会话：这条路不在 /api 围栏里，必须自己拒
  const denied = await fetch(endpoint);
  assert.equal(denied.status, 401);
  const wrongMethod = await fetch(endpoint, { method: 'POST', headers: { cookie: 'a=b' } });
  assert.equal(wrongMethod.status, 405);

  const response = await fetch(endpoint, { headers: { cookie: 'a=b', accept: 'text/event-stream' } });
  assert.equal(response.status, 200);
  const stream = readerOf(response);
  t.after(() => stream.cancel());
  await stream.until((text) => text.includes(': studymate connected'), '建连问候');
  watch.publishChange(['pool']);
  const frame = await stream.until((text) => /data: \{.*\}\n\n/.test(text), '变更通知帧');
  assert.match(frame, /"domains":\["pool"\]/);
  await stream.cancel();
});

test('没有 connection.fetch.register 时自动退到 webServer，两条都没有就只警告', async (t) => {
  useHome(t, { withWorkspace: false });
  watch.resetWatchRegistryForTests();
  const warnings = captureWarnings(t);

  const routes = [];
  const fallback = watch.registerWatchChannel({
    get: (name) => {
      if (name === 'connection') return {}; // 服务在，但没有 fetch.register
      if (name === 'webServer') return { register(route) { routes.push(route); return () => {}; } };
      return undefined;
    },
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/plugins/studymate/events');
  fallback();

  const nothing = watch.registerWatchChannel({ get: () => undefined });
  assert.equal(typeof nothing, 'function');
  assert.doesNotThrow(() => nothing());
  assert.equal(warnings.some((text) => /没有 connection 也没有 webServer/.test(text)), true);
});

test('监听起不来不拖垮注册：取服务抛错 / 配置读不了都只警告，注册照常返回', async (t) => {
  useHome(t, { withWorkspace: false });
  watch.resetWatchRegistryForTests();
  const warnings = captureWarnings(t);

  // ① 取 fs 服务这一步就抛（宿主坏了 / 老宿主的 getter 会炸）：registerWatch 不许往外抛
  assert.doesNotThrow(() => watch.registerWatch({
    effect: (fn) => fn(),
    get: () => { throw new Error('服务取不到（探针）'); },
  }));
  assert.equal(warnings.some((text) => /服务取不到/.test(text)), true, `要记下原因：${JSON.stringify(warnings)}`);

  // ② 抛过一次之后，注册线还能再起来（不能把「已起」的标记留在半路）
  watch.resetWatchRegistryForTests();
  assert.doesNotThrow(() => watch.registerWatch({ effect: (fn) => fn(), get: () => undefined }));

  // ③ 配置读不了（DSH_HOME 指向一个不存在的目录）也只是「没得监听」
  process.env.DSH_HOME = path.join(os.tmpdir(), 'studymate-watch-不存在的家-' + Date.now());
  watch.resetWatchRegistryForTests();
  assert.doesNotThrow(() => watch.registerWatch({ effect: (fn) => fn(), get: () => undefined }));
});
