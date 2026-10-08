/* 核验域（`lib/reach/**`，#125）：把「资源清单」里的链接核一遍。
   ────────────────────────────────────────────────────────────────────────
   这一套**只碰 loopback**：目标站与代理都是本进程里起的真 `node:http` 服务器（`127.0.0.1`
   与 `127.0.0.0/8` 上的其它回环地址），一个到仓外的请求都没有。判据全在盘上／在服务端的
   计数里，不看日志：

     · 清单摘链接那一步是纯函数（按 URL 去重、1 起行号、只认 http/https）——单独一组用例；
     · 一次核验的外部行为：计数、按站汇总、打不开的那几条、输出契约；
     · 排班：全局并发 ≤8、同站不并发（**服务端按 Host 计数**）、某个站忙不挡整个队列；
     · 缓存：第二遍**零请求**、`refresh` 才重核、`offline` 一个 socket 都不开；
     · 墙上预算：到点交回去、`next` 叫你再调一次、第二遍接着做完；
     · 路由表：直连连接层失败、代理通 → 路由是代理，且**路由只探一次**（直连只被碰一次）。

   夹具（临时 HOME/工作区、假 ctx、`execute`、`assertOutput`）在 `scripts/tests/fixtures/tools.mjs`；
   起 loopback 服务器的姿势照 `scripts/tests/test_watch_push.mjs`。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

import { assertOutput, execute, fakeContext, loadCore, loadTools, useHome } from './fixtures/tools.mjs';

const tools = await loadTools();
const reach = await loadCore('lib/reach/index.ts');

const TOOL = 'studymate_verify_sources';

/* ── 环境：代理变量与墙上预算都要能逐条用例地摆布 ───────────────────────── */

const PROXY_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
const BUDGET_KEY = 'STUDYMATE_REACH_WALL_BUDGET_MS';

/** 每条用例自己决定有没有代理：默认**清空**，免得跑门禁的那台机器上恰好配着一条代理。 */
const proxyPrevious = new WeakMap();
function useProxyEnv(t, value) {
  if (!proxyPrevious.has(t)) {
    proxyPrevious.set(t, new Map(PROXY_KEYS.map((key) => [key, process.env[key]])));
    t.after(() => {
      for (const [key, old] of proxyPrevious.get(t)) {
        if (old === undefined) delete process.env[key];
        else process.env[key] = old;
      }
    });
  }
  for (const key of PROXY_KEYS) delete process.env[key];
  if (value !== undefined) {
    process.env.HTTP_PROXY = value;
    process.env.http_proxy = value;
  }
}

/** 同一段用例里可以改好几次预算；恢复钩子只登记一次，免得 `t.after` 按登记顺序回放时
 *  把中间那个值留到最后（`t.after` 是 FIFO，不是 LIFO）。 */
const budgetPrevious = new WeakMap();
function useBudget(t, value) {
  if (!budgetPrevious.has(t)) {
    budgetPrevious.set(t, process.env[BUDGET_KEY]);
    t.after(() => {
      const old = budgetPrevious.get(t);
      if (old === undefined) delete process.env[BUDGET_KEY];
      else process.env[BUDGET_KEY] = old;
    });
  }
  if (value === undefined) delete process.env[BUDGET_KEY];
  else process.env[BUDGET_KEY] = String(value);
}

/* ── loopback 上的目标站与代理 ─────────────────────────────────────────── */

/** 起一个真的 HTTP 站；`handle(req, res, host)` 自己写响应。返回服务端计数。 */
async function startSite(handle) {
  const state = {
    requests: 0, inFlight: 0, maxInFlight: 0, perHost: new Map(), perHostMax: 0,
  };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    const live = (state.perHost.get(host) ?? 0) + 1;
    state.perHost.set(host, live);
    state.perHostMax = Math.max(state.perHostMax, live);
    // 释放名额挂在 `finish`（响应写完）而不是 `close`：客户端读完响应头就断连接，
    // 按 `close` 算会让「上一条还没释放、下一条已经到了」这种计时误差变成假红。
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.inFlight -= 1;
      state.perHost.set(host, (state.perHost.get(host) ?? 1) - 1);
    };
    res.on('finish', release);
    res.on('close', release);
    res.on('error', () => {});
    handle(req, res, host);
  });
  server.on('clientError', () => {});
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const port = server.address().port;
  return {
    port,
    state,
    url: (host, pathname) => `http://${host}:${port}${pathname}`,
    reset: () => { state.requests = 0; state.maxInFlight = 0; state.perHostMax = 0; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 一律 200；`delay` 毫秒后才答，用来观测并发。 */
function okHandler(delay = 0) {
  return (_req, res) => {
    const send = () => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); };
    if (delay === 0) send();
    else setTimeout(send, delay);
  };
}

/** 一张清单里各路径的答复表：没列到的 404。 */
function routeHandler(table) {
  return (req, res) => {
    const status = table[req.url] ?? 404;
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(status === 200 ? 'ok' : 'no');
  };
}

/**
 * 直连连接层就失败的目标站：接上就写一句不是状态行的东西。用真 socket 才数得清
 * 「直连被碰了几次」——连接被拒的那种失败根本没有服务端可数。
 */
async function startBrokenSite() {
  const state = { hits: 0 };
  const server = net.createServer((socket) => {
    state.hits += 1;
    socket.on('error', () => {});
    socket.on('data', () => { socket.write('NONSENSE\r\n\r\n'); socket.end(); });
  });
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  return {
    port: server.address().port,
    hits: () => state.hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 一个够用的转发代理桩：不真转发，一律答 200——用来验「换了路之后结果对不对」。 */
async function startStubProxy() {
  const state = { hits: 0 };
  const server = http.createServer((_req, res) => {
    state.hits += 1;
    res.on('error', () => {});
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('proxied');
  });
  server.on('clientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/* ── 清单与调用 ────────────────────────────────────────────────────────── */

/** 在科目目录里落一份 `RESOURCES.md`，返回目录的绝对路径。 */
function writeManifest(home, lines, { slug = 'demo' } = {}) {
  const dir = path.join(home.workspace, '.learning', 'subjects', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'RESOURCES.md'), lines.join('\n'), 'utf8');
  return dir;
}

function relativeTo(home, target) {
  return path.relative(home.workspace, target);
}

async function verify(ctx, args) {
  return execute(ctx, TOOL, args);
}

function registered() {
  const ctx = fakeContext();
  tools.registerStudyMate(ctx.ctx);
  return ctx;
}

/* ── 一、`manifest.ts`：清单里有哪些链接（纯函数）───────────────────────── */

test('清单摘链接：按 URL 去重、行号 1 起、只认 http/https、不认非 URL 的 Markdown 链接', () => {
  const markdown = [
    '# 资源清单',                                            // 1
    '- [A 官方文档](https://a.example/one) 一行用途',          // 2
    '- [A 同一个链接再说一次](https://a.example/one)',         // 3（与第 2 行同 URL：去重）
    '- [本地教材](./reference/教材.md)',                      // 4（不是 http(s) 链接）
    '裸链接 https://b.example/two 结束',                      // 5
    '- [B 带锚点](https://b.example/two#setup)',              // 6（URL 不同：不算重复）
    '- [C](https://c.example/three)',                        // 7
    'ftp://ftp.example/x',                                   // 8（协议不是 http/https）
  ].join('\n');
  const entries = reach.extractLinks(markdown);
  assert.deepEqual(entries.map((entry) => entry.url), [
    'https://a.example/one',
    'https://b.example/two',
    'https://b.example/two#setup',
    'https://c.example/three',
  ]);
  assert.deepEqual(entries.map((entry) => entry.line), [2, 5, 6, 7]);
  assert.equal(entries[0].title.includes('A 官方文档'), true);
  assert.equal(entries.some((entry) => entry.url.includes('ftp')), false);
  assert.equal(entries.some((entry) => entry.url.includes('reference')), false);
});

test('清单摘链接：标题为空时回落到那一行的原文，且不为空清单编条目', () => {
  assert.deepEqual(reach.extractLinks('没有链接的一段正文。'), []);
  const entries = reach.extractLinks('- https://a.example/one');
  assert.equal(entries.length, 1);
  assert.ok(entries[0].title.length > 0, '标题不该是空串');
});

/* ── 二、`schedule.ts`：排班（不用网络的直接驱动）───────────────────────── */

function okResult() {
  return { ok: true, status: 200, statusText: 'OK', contentType: '', note: '', transport: false };
}

function failResult() {
  return { ok: false, status: 0, statusText: '', contentType: '', note: '连不上（连接被拒）', transport: true };
}

test('排班：同站忙只挡它自己那一条，不挡整个队列', async () => {
  const started = [];
  const targetOf = [
    { url: 'http://a/1', host: 'a' },
    { url: 'http://a/2', host: 'a' },
    { url: 'http://b/3', host: 'b' },
    { url: 'http://c/4', host: 'c' },
  ];
  const result = await reach.runProbes(targetOf, {
    route: '直连', hasProxy: false, concurrency: 4, perHost: 1,
    deadline: Date.now() + 60_000, now: Date.now,
    probe: async (url) => {
      started.push(url);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return okResult();
    },
  });
  assert.deepEqual(result.pending, []);
  assert.equal(result.outcomes.length, 4);
  // 第 2 条与第 1 条同站、被它挡住 → b/3 先于 a/2 跑完（这就是「不挡整个队列」）。
  assert.ok(started.indexOf('http://b/3') < started.indexOf('http://a/2'),
    `同站忙把整个队列挡住了：${started.join('、')}`);
});

test('排班：到点之后不再起新的，没起过的按原序进 pending', async () => {
  const started = [];
  const targets = [1, 2, 3].map((index) => ({ url: `http://h/${index}`, host: 'h' }));
  const result = await reach.runProbes(targets, {
    route: '直连', hasProxy: false, concurrency: 2, perHost: 1,
    deadline: Date.now() - 1, now: Date.now,
    probe: async (url) => { started.push(url); return okResult(); },
  });
  assert.deepEqual(started, []);
  assert.deepEqual(result.pending, targets.map((target) => target.url));
  assert.equal(result.outcomes.length, 0);
});

test('排班：连接层失败才换另一条路，只换一次，换通了队尾照新表走', async () => {
  const calls = [];
  const targets = [1, 2, 3].map((index) => ({ url: `http://h/${index}`, host: 'h' }));
  const result = await reach.runProbes(targets, {
    route: '直连', hasProxy: true, concurrency: 4, perHost: 1,
    deadline: Date.now() + 60_000, now: Date.now,
    probe: async (url, route) => {
      calls.push(`${url}|${route}`);
      return route === '直连' ? failResult() : okResult();
    },
  });
  assert.equal(result.route, '代理');
  assert.deepEqual(result.outcomes.map((outcome) => outcome.route), ['代理', '代理', '代理']);
  assert.equal(calls.filter((call) => call.endsWith('|直连')).length, 1, '直连只该试一次');
  assert.equal(calls.filter((call) => call.endsWith('|代理')).length, 3);
});

test('排班：HTTP 层失败（4xx）不换路', async () => {
  const calls = [];
  const result = await reach.runProbes([{ url: 'http://h/404', host: 'h' }], {
    route: '直连', hasProxy: true, concurrency: 2, perHost: 1,
    deadline: Date.now() + 60_000, now: Date.now,
    probe: async (url, route) => {
      calls.push(route);
      return { ok: false, status: 404, statusText: 'Not Found', contentType: '', note: '', transport: false };
    },
  });
  assert.deepEqual(calls, ['直连']);
  assert.equal(result.route, '直连');
  assert.equal(result.outcomes[0].result.status, 404);
});

/* ── 三、一次核验的外部行为 ───────────────────────────────────────────── */

test('几个链接打一次：计数、按站汇总、打不开的那条在 failures 里，输出过契约', async (t) => {
  const home = useHome(t);
  useProxyEnv(t);
  const site = await startSite(routeHandler({ '/ok1': 200, '/ok2': 200 }));
  t.after(() => site.close());

  const dir = writeManifest(home, [
    '# 资源清单',
    `- [好一](${site.url('127.0.0.1', '/ok1')})`,
    `- [坏一](${site.url('127.0.0.1', '/dead')})`,   // 第 3 行：404
    `- [好二](${site.url('127.0.0.2', '/ok2')})`,
  ]);
  const ctx = registered();
  const value = await verify(ctx, { manifest: relativeTo(home, dir) });

  assert.equal(value.total, 3);
  assert.equal(value.ok, 2);
  assert.equal(value.failed, 1);
  assert.equal(value.pending, 0);
  assert.equal(value.probed, 3);
  assert.equal(value.cached, 0);
  assert.deepEqual(value.hosts, [
    { host: '127.0.0.1', entries: 2, ok: 1, failed: 1 },
    { host: '127.0.0.2', entries: 1, ok: 1, failed: 0 },
  ]);
  assert.equal(value.failures.length, 1, JSON.stringify(value.failures));
  assert.equal(value.failures[0].line, 3);
  assert.match(value.failures[0].url, /\/dead$/);
  assert.equal(value.failures[0].status, 404);
  assert.match(value.next, /1 条打不开/);
  assert.equal(value.route, '直连');
  await assertOutput(assert, ctx.definitions.get(TOOL), value);
});

test('定位清单：目录 / RESOURCES.md 本身 / 暂存目录的 deliver 三种写法都认；找不到不抛', async (t) => {
  const home = useHome(t);
  useProxyEnv(t);
  const site = await startSite(routeHandler({ '/ok': 200 }));
  t.after(() => site.close());

  const lines = ['# 资源清单', `- [好](${site.url('127.0.0.1', '/ok')})`];
  const subjectDir = writeManifest(home, lines, { slug: 'alpha' });
  const stage = path.join(home.workspace, '.studymate-stage', 'resource-scout-alpha');
  fs.mkdirSync(path.join(stage, 'deliver'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'deliver', 'RESOURCES.md'), lines.join('\n'), 'utf8');

  const ctx = registered();
  for (const manifest of [
    relativeTo(home, subjectDir),
    relativeTo(home, path.join(subjectDir, 'RESOURCES.md')),
    relativeTo(home, stage),
    relativeTo(home, path.join(stage, 'deliver')),
  ]) {
    const value = await verify(ctx, { manifest });
    assert.equal(value.total, 1, `${manifest} 没定位到清单`);
    assert.equal(value.ok, 1, `${manifest} 的链接没核成`);
  }

  // 找不到：一份报告，不是异常；summary 说找了什么，next 说该传哪个路径。
  const nowhere = path.join(home.workspace, '不存在的目录');
  const missing = await verify(ctx, { manifest: '不存在的目录' });
  assert.equal(missing.total, 0);
  assert.equal(missing.route, '未探');
  assert.match(missing.summary, /没找到/);
  assert.match(missing.next, /RESOURCES\.md/);
  await assertOutput(assert, ctx.definitions.get(TOOL), missing);

  // 目录里有一份别的 md：不算清单（这个域只认 RESOURCES.md）。
  const wrong = path.join(home.workspace, '其它目录');
  fs.mkdirSync(wrong, { recursive: true });
  fs.writeFileSync(path.join(wrong, 'NOTES.md'), lines.join('\n'), 'utf8');
  const refused = await verify(ctx, { manifest: relativeTo(home, wrong) });
  assert.equal(refused.total, 0);
  assert.match(refused.summary, /没找到/);
  assert.equal(fs.existsSync(nowhere), false);
});

test('输出契约：空清单与「没找到」都过一遍', async (t) => {
  const home = useHome(t);
  useProxyEnv(t);
  const emptyDir = writeManifest(home, ['# 资源清单', '这一份里一个链接都没有。'], { slug: 'empty' });
  const ctx = registered();
  const value = await verify(ctx, { manifest: relativeTo(home, emptyDir) });
  assert.equal(value.total, 0);
  assert.equal(value.next, '');
  assert.match(value.summary, /没有 http\/https 链接/);
  await assertOutput(assert, ctx.definitions.get(TOOL), value);
});

/* ── 四、并发与同站礼貌（服务端计数）───────────────────────────────────── */

test('全局并发 ≤8，且同一个站从不并发两条', async (t) => {
  const home = useHome(t);
  useProxyEnv(t);
  const site = await startSite(okHandler(40));
  t.after(() => site.close());
  const ctx = registered();

  // 十个不同的 hostname（都在 127.0.0.0/8 回环里）、每个一条 → 全局能并发起来。
  const many = [];
  for (let index = 1; index <= 10; index += 1) many.push(`127.0.0.${index}`);
  const wideDir = writeManifest(home, [
    '# 资源清单',
    ...many.map((host) => `- [x](${site.url(host, `/${host}`)})`),
  ], { slug: 'wide' });
  const wide = await verify(ctx, { manifest: relativeTo(home, wideDir) });
  assert.equal(wide.total, 10);
  assert.equal(wide.ok, 10);
  assert.ok(site.state.maxInFlight <= 8, `全局并发到了 ${site.state.maxInFlight}，超过 8`);
  assert.ok(site.state.maxInFlight >= 2, `全局并发只有 ${site.state.maxInFlight}：根本没并发起来`);
  assert.equal(site.state.perHostMax, 1, '同一个站上同时出现了两条');

  // 四条全在同一个 hostname 上 → 老老实实串行。
  site.reset();
  const narrowDir = writeManifest(home, [
    '# 资源清单',
    ...[1, 2, 3, 4].map((index) => `- [x](${site.url('127.0.0.1', `/n${index}`)})`),
  ], { slug: 'narrow' });
  const narrow = await verify(ctx, { manifest: relativeTo(home, narrowDir) });
  assert.equal(narrow.ok, 4);
  assert.equal(site.state.perHostMax, 1, '同站没有串行');
  assert.equal(site.state.maxInFlight, 1, '同站串行时全局不该有第二条在飞');
});

/* ── 五、缓存：第二遍零请求，refresh 才重核 ────────────────────────────── */

test('第二遍同一个清单零新请求、结论一样；refresh 才重探', async (t) => {
  const home = useHome(t);
  useProxyEnv(t);
  const site = await startSite(routeHandler({ '/a': 200, '/dead': 404 }));
  t.after(() => site.close());
  const dir = writeManifest(home, [
    '# 资源清单',
    `- [a](${site.url('127.0.0.1', '/a')})`,
    `- [坏](${site.url('127.0.0.1', '/dead')})`,
  ]);

  const ctx = registered();
  const first = await verify(ctx, { manifest: relativeTo(home, dir) });
  assert.equal(first.probed, 2);
  assert.equal(first.cached, 0);
  assert.equal(site.state.requests, 2);

  site.reset();
  const second = await verify(ctx, { manifest: relativeTo(home, dir) });
  assert.equal(site.state.requests, 0, '第二遍不该再发请求');
  assert.equal(second.cached, 2);
  assert.equal(second.probed, 0);
  assert.equal(second.total, first.total);
  assert.equal(second.ok, first.ok);
  assert.equal(second.failed, first.failed);
  // `failures` 只列**这一轮真探过**的：缓存带回来的旧结论不算（它是上一轮的证据）。
  assert.equal(second.failures.length, 0, '缓存里的旧失败不该冒充这一轮的 failures');

  const refreshed = await verify(ctx, { manifest: relativeTo(home, dir), refresh: true });
  assert.equal(site.state.requests, 2, 'refresh 要忽略缓存重探一遍');
  assert.equal(refreshed.cached, 0);
  assert.equal(refreshed.probed, 2);
  assert.equal(refreshed.failed, 1);
});

test('offline：冷缓存下不开任何 socket，全进 pending，next 说去掉 offline', async (t) => {
  const home = useHome(t);
  useProxyEnv(t);
  const site = await startSite(okHandler());
  t.after(() => site.close());
  const dir = writeManifest(home, [
    '# 资源清单',
    `- [a](${site.url('127.0.0.1', '/a')})`,
    `- [b](${site.url('127.0.0.2', '/b')})`,
  ]);

  const ctx = registered();
  const value = await verify(ctx, { manifest: relativeTo(home, dir), offline: true });
  assert.equal(site.state.requests, 0, 'offline 不该开 socket');
  assert.equal(value.pending, 2);
  assert.equal(value.probed, 0);
  assert.equal(value.cached, 0);
  assert.equal(value.route, '未探');
  assert.match(value.next, /offline/);
  await assertOutput(assert, ctx.definitions.get(TOOL), value);

  // 暖缓存下 offline 用缓存里的结论，不再 pending。
  await verify(ctx, { manifest: relativeTo(home, dir) });
  site.reset();
  const warm = await verify(ctx, { manifest: relativeTo(home, dir), offline: true });
  assert.equal(site.state.requests, 0);
  assert.equal(warm.cached, 2);
  assert.equal(warm.pending, 0);
  assert.equal(warm.ok, 2);
});

/* ── 六、墙上预算：到点交回去，第二遍接着做完 ──────────────────────────── */

test('墙上预算用完：pending > 0 且 next 让再调一次；去掉预算后第二遍做完', async (t) => {
  const home = useHome(t);
  useProxyEnv(t);
  const site = await startSite(okHandler(120));
  t.after(() => site.close());
  const dir = writeManifest(home, [
    '# 资源清单',
    ...[1, 2, 3].map((index) => `- [x](${site.url('127.0.0.1', `/p${index}`)})`),
  ]);

  const ctx = registered();
  useBudget(t, 50);
  const first = await verify(ctx, { manifest: relativeTo(home, dir) });
  assert.ok(first.pending > 0, `没交回去：${JSON.stringify(first)}`);
  assert.match(first.next, /再调一次/);
  assert.match(first.next, /manifest/);
  assert.equal(first.total, 3);
  await assertOutput(assert, ctx.definitions.get(TOOL), first);

  useBudget(t, undefined);
  const second = await verify(ctx, { manifest: relativeTo(home, dir) });
  assert.equal(second.pending, 0);
  assert.equal(second.ok, 3);
  assert.ok(second.cached >= 1, '第二遍该用上第一遍已经核出来的');
});

test('墙上预算的解析：默认 120000，合法值照收，非法值与越界都退回默认', (t) => {
  useBudget(t, undefined);
  assert.equal(reach.reachWallBudgetMs(), reach.DEFAULT_WALL_BUDGET_MS);
  assert.equal(reach.DEFAULT_WALL_BUDGET_MS, 120_000);
  useBudget(t, 1234);
  assert.equal(reach.reachWallBudgetMs(), 1234);
  for (const bad of ['0', '-5', '1.5', 'abc', String(reach.MAX_WALL_BUDGET_MS + 1)]) {
    useBudget(t, bad);
    assert.equal(reach.reachWallBudgetMs(), reach.DEFAULT_WALL_BUDGET_MS, `${bad} 不该被收下`);
  }
});

/* ── 七、路由表：直连不通就换代理，且只探一次 ──────────────────────────── */

test('直连连接层失败、代理通 → 路由是代理，直连只被碰一次（不是每条 URL 都先试直连）', async (t) => {
  const home = useHome(t);
  const broken = await startBrokenSite();
  t.after(() => broken.close());
  const proxy = await startStubProxy();
  t.after(() => proxy.close());
  useProxyEnv(t, `http://127.0.0.1:${proxy.port}`);

  const dir = writeManifest(home, [
    '# 资源清单',
    ...[1, 2, 3].map((index) => `- [x](http://127.0.0.1:${broken.port}/p${index})`),
  ]);
  const ctx = registered();
  const value = await verify(ctx, { manifest: relativeTo(home, dir) });

  assert.equal(value.route, '代理');
  assert.equal(value.ok, 3, JSON.stringify(value.failures));
  assert.equal(broken.hits(), 1, '路由只该探一次：直连被碰的次数不是 1');
  assert.equal(proxy.state.hits, 3, '每条真核验各走一条代理连接');
  await assertOutput(assert, ctx.definitions.get(TOOL), value);
});
