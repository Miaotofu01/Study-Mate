/* 验收 #105 · 建答疑会话：宿主半那条路由 + 标题的拼法与识别（`lib/ask/session.ts`）
   ────────────────────────────────────────────────────────────────────────
   这条套件走 #102 Testing Decisions 的第二条缝：**宿主半 + 假 ctx**（先例
   `test_host_ask_route.mjs`、`test_host_qa_preset.mjs`）。真宿主的 `agentPresets.mount` 与
   `agents.create` 认不认这条调用序列，只有在真 DSH 里才证得了（spec 已接受这个口径）；这里
   钉的是我们能钉的那一半：

     · 建会话真的带了 `meta.agentPreset = 'qa'`（答疑预设）与当前工作区当 cwd；
     · `setup` 里真的 `mount` 了预设（顺序：resolve → acquireScope → create(setup: mount)）；
     · 标题拼成「答疑 · 科目 · 节点」并交给 `ctx.sessionTitle.rename`；
     · 共享记忆**注入一条且只注入一次**（多条消息就是重复注入）；
     · 没有可用模型时**一条会话都不建**、如实说明；
     · 宿主没挂 `sessionTitle` 时如实降级（`renamed:false`，会话照样建起来）；
     · 预设读不到 / 会话服务不在 → 走 `lib/route-envelope.ts` 的唯一信封；
     · 路由：路径在 `/api/studymate` 命名空间下、坏请求体 400、没工作区 500、没模型 503。

   数据现造现弃（ADR-0009）：工作区是临时目录，会话是假 agents 记下来的对象。
   ──────────────────────────────────────────────────────────────────────── */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASK_SESSION_PREFIX, ASK_SESSION_SEP, QA_AGENT_PRESET, QA_SESSION_PATH,
  isAskSessionTitle, openAskSession, registerAskRoute, titleForAskSession,
} from '../../lib/ask/index.ts';

/* ── 临时工作区 ────────────────────────────────────────────────────────── */

const TEMPS = [];
after(() => { for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true }); });

const MEMORY_MD = '讲法偏好：先给结论再给为什么。\n';

function makeWorkspace({ withMemory = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-qa-session-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(path.join(workspace, '.learning'), { recursive: true });
  if (withMemory) fs.writeFileSync(path.join(workspace, '.learning', 'MEMORY.md'), MEMORY_MD);
  return { root, workspace };
}

/* ── 假宿主半：预设注册表 / agents / sessionTitle / llm ─────────────────── */

/** 记下每一次调用的假 ctx 服务。 */
function fakeHost({ memory = MEMORY_MD, preset = { id: QA_AGENT_PRESET }, failResolve = null, withTitle = true, withAgents = true } = {}) {
  const calls = { resolve: [], acquireScope: [], create: [], mount: [], disposeScope: 0, inject: [], rename: [] };
  const messages = [];
  const created = new Map();
  const handle = {
    agent: {
      session: { id: 'pending' },
      inject: (message) => { messages.push(message); calls.inject.push(message); },
      dispose: () => { throw new Error('路由不许 dispose 刚建好的会话'); },
    },
  };
  const agentPresets = {
    resolve: async (id) => {
      calls.resolve.push(id);
      if (failResolve) throw new Error(failResolve);
      return preset;
    },
    acquireScope: async (id) => {
      calls.acquireScope.push(id);
      return { key: 'fake-scope-' + id, async [Symbol.asyncDispose]() { calls.disposeScope += 1; } };
    },
    mount: async (agentCtx, id) => { calls.mount.push({ agentCtx, id }); },
  };
  const agents = withAgents ? {
    create: async (options) => {
      calls.create.push(options);
      created.set(options.sessionId, handle);
      return handle;
    },
    get: (id) => created.get(id),
  } : null;
  const sessionTitle = withTitle ? {
    rename: (session, title) => { calls.rename.push({ session, title }); return { title }; },
  } : null;
  return { agentPresets, agents, sessionTitle, llm: { listProviders: () => [{ id: 'fake-provider' }] }, calls, messages, handle };
}

/** 一份完整的 deps：把假服务与工作区拼起来。 */
function depsFor(workspace, host, overrides = {}) {
  return {
    workspace,
    agentPresets: host.agentPresets,
    agents: host.agents,
    sessionTitle: host.sessionTitle,
    llm: host.llm,
    createId: () => 'studymate-qa-fixed',
    ...overrides,
  };
}

/* ══ 标题：拼法与识别（纯函数） ═══════════════════════════════════════════ */

test('#105 标题：三段拼成「答疑 · 科目 · 节点」，缺哪节就少写哪节', () => {
  assert.equal(titleForAskSession('网络', '子网与掩码'), `答疑${ASK_SESSION_SEP}网络${ASK_SESSION_SEP}子网与掩码`);
  assert.equal(titleForAskSession('网络', ''), `答疑${ASK_SESSION_SEP}网络`);
  assert.equal(titleForAskSession('', '子网与掩码'), `答疑${ASK_SESSION_SEP}子网与掩码`);
  assert.equal(titleForAskSession('', ''), ASK_SESSION_PREFIX);
  assert.equal(titleForAskSession(undefined, undefined), ASK_SESSION_PREFIX);
  // 两端空白裁掉、内部换行折成空格：标题是单行文本，分隔符不许被空白撑出空节
  assert.equal(titleForAskSession('  网络  ', ' 子网 \n 与掩码 '), `答疑${ASK_SESSION_SEP}网络${ASK_SESSION_SEP}子网 与掩码`);
  assert.equal(titleForAskSession('网络', '   '), `答疑${ASK_SESSION_SEP}网络`);
});

test('#105 识别：只认「答疑」这个前缀，不认别的以它开头的标题', () => {
  assert.equal(isAskSessionTitle(titleForAskSession('网络', '子网与掩码')), true);
  assert.equal(isAskSessionTitle(titleForAskSession('网络', '')), true);
  assert.equal(isAskSessionTitle(ASK_SESSION_PREFIX), true);
  // 「答疑解惑」不是我们那套；项目名恰好以「答疑」开头也不是（客户端那条判据用的是 title）
  assert.equal(isAskSessionTitle('答疑解惑'), false);
  assert.equal(isAskSessionTitle('答疑解'), false);
  assert.equal(isAskSessionTitle('问答 · 网络'), false);
  assert.equal(isAskSessionTitle('学习 · 网络'), false);
  // `title` 是可缺的（宿主还没投影出持久标题）：认不出来就是「没有上一段会话」，不是崩
  assert.equal(isAskSessionTitle(undefined), false);
  assert.equal(isAskSessionTitle(null), false);
  assert.equal(isAskSessionTitle(''), false);
});

/* ══ 建会话：按答疑预设、带 cwd、标题、共享记忆 ═════════════════════════ */

test('#105 建会话：resolve(qa) → acquireScope → create(带预设 id 与 cwd) → setup 里 mount', async () => {
  const { workspace } = makeWorkspace();
  const host = fakeHost();
  const view = await openAskSession(depsFor(workspace, host), { subject: '网络', node: '子网与掩码' });

  assert.equal(view.ok, true, JSON.stringify(view));
  assert.equal(view.available, true);
  assert.equal(view.sessionId, 'studymate-qa-fixed');

  // 预设：先解析成 id，再租 revision，再在 setup 里挂上
  assert.deepEqual(host.calls.resolve, [QA_AGENT_PRESET]);
  assert.deepEqual(host.calls.acquireScope, [QA_AGENT_PRESET]);
  // setup 是「组装」那一步：宿主发布 agent 之前跑它。假 agents 不替宿主调，这里自己调一次
  assert.equal(host.calls.mount.length, 0);
  assert.equal(host.calls.create.length, 1);
  const options = host.calls.create[0];
  assert.equal(options.sessionId, 'studymate-qa-fixed');
  // ★ 这就是「按答疑预设跑」的全部证据：meta.agentPreset（durable media）与 mount 的 id
  assert.deepEqual(options.meta, { cwd: workspace, agentPreset: QA_AGENT_PRESET });
  assert.equal(typeof options.setup, 'function');
  // setup 真的挂了预设（不是只写在 meta 里），而且挂的就是解析出来的那个 id
  await options.setup({ scoped: true });
  assert.equal(host.calls.mount.length, 1);
  assert.equal(host.calls.mount[0].id, QA_AGENT_PRESET);

  // 标题：拼法写进回执，且真的交给宿主的 sessionTitle 服务（宿主半没有 ISession.rename）
  assert.equal(view.title, `答疑${ASK_SESSION_SEP}网络${ASK_SESSION_SEP}子网与掩码`);
  assert.equal(view.renamed, true);
  assert.equal(host.calls.rename.length, 1);
  assert.equal(host.calls.rename[0].title, view.title);

  // 租来的 revision 用完就还；**handle 不许被拆掉**（那会把刚建好的会话拆了）
  assert.equal(host.calls.disposeScope, 1);
});

test('#105 建会话：共享记忆注入一条且只注入一条（模型可见的消息，之后不再重复）', async () => {
  const { workspace } = makeWorkspace();
  const host = fakeHost();
  const view = await openAskSession(depsFor(workspace, host), { subject: '网络', node: '子网与掩码' });

  assert.equal(view.memoryInjected, true);
  assert.equal(host.messages.length, 1, '开张时注入的不是恰好一条：' + JSON.stringify(host.messages));
  const message = host.messages[0];
  // 形状照宿主的 createUserMessage：身份 + role + 内容块 + 来源
  assert.equal(typeof message.id, 'string');
  assert.ok(message.id.length > 0);
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content, [{ type: 'text', text: MEMORY_MD.trim() }]);
  assert.equal(message.source.kind, 'user');
});

test('#105 建会话：共享记忆为空就不注入（不是注入一条空的）', async () => {
  const { workspace } = makeWorkspace({ withMemory: false });
  const host = fakeHost();
  const view = await openAskSession(depsFor(workspace, host), { subject: '网络' });

  assert.equal(view.ok, true);
  assert.equal(view.memoryInjected, false);
  assert.equal(host.messages.length, 0);
  // 会话照样建得起来：没有共享记忆的新工作区不是错误
  assert.equal(host.calls.create.length, 1);
});

test('#105 降级：宿主没挂 sessionTitle 时不抛、也不假装改过标题', async () => {
  const { workspace } = makeWorkspace();
  const host = fakeHost({ withTitle: false });
  const view = await openAskSession(depsFor(workspace, host), { subject: '网络', node: '子网与掩码' });

  assert.equal(view.ok, true, JSON.stringify(view));
  assert.equal(view.renamed, false, '没有改名服务却说自己改过');
  // 该给的还是给：会话 id 与「标题本该长什么样」都在（客户端据此显示/落位）
  assert.equal(view.sessionId, 'studymate-qa-fixed');
  assert.equal(view.title, `答疑${ASK_SESSION_SEP}网络${ASK_SESSION_SEP}子网与掩码`);
});

/* ══ 没有可用模型：不建会话、如实说明 ═══════════════════════════════════ */

test('#105 无模型：一条会话都不建，available:false + reason（一个字的谎都不说）', async () => {
  const { workspace } = makeWorkspace();
  const host = fakeHost();
  const view = await openAskSession(
    { workspace, agentPresets: host.agentPresets, agents: host.agents, sessionTitle: host.sessionTitle, llm: undefined },
    { subject: '网络', node: '子网与掩码' },
  );

  assert.equal(view.available, false);
  assert.equal(view.ok, false);
  assert.equal(typeof view.reason, 'string');
  assert.ok(view.reason.length > 0);
  assert.equal(view.error.code, 'model-unavailable');
  assert.equal(view.error.message, view.reason);
  assert.equal(Object.hasOwn(view, 'sessionId'), false, '没有模型却建了会话');
  assert.equal(host.calls.create.length, 0, '没有模型却调了 agents.create');
  assert.equal(host.calls.resolve.length, 0, '没有模型却去解析了预设');
});

/* ══ 建不出来时走唯一信封 ═══════════════════════════════════════════════ */

test('#105 预设读不到：preset-unavailable 信封 + 能照做的一句话，不建会话', async () => {
  const { workspace } = makeWorkspace();
  const host = fakeHost({ failResolve: 'no such preset' });
  const view = await openAskSession(depsFor(workspace, host), { subject: '网络' });

  assert.equal(view.ok, false);
  assert.equal(view.available, true);
  assert.equal(view.error.code, 'preset-unavailable');
  assert.match(view.error.message, /答疑模式/);
  assert.equal(host.calls.create.length, 0);
});

test('#105 会话服务不在：session-create-failed，不假装建成了', async () => {
  const { workspace } = makeWorkspace();
  const host = fakeHost({ withAgents: false });
  const view = await openAskSession(depsFor(workspace, host), { subject: '网络' });

  assert.equal(view.ok, false);
  assert.equal(view.error.code, 'session-create-failed');
  assert.equal(Object.hasOwn(view, 'sessionId'), false);
});

test('#105 agents.create 抛错：session-create-failed，且租来的 revision 照样还掉', async () => {
  const { workspace } = makeWorkspace();
  const host = fakeHost();
  const deps = depsFor(workspace, host, {
    agents: { create: async () => { throw new Error('preset mount failed'); }, get: () => undefined },
  });
  const view = await openAskSession(deps, { subject: '网络' });

  assert.equal(view.ok, false);
  assert.equal(view.error.code, 'session-create-failed');
  assert.match(view.error.message, /preset mount failed/);
  assert.equal(host.calls.disposeScope, 1, '创建失败时把租来的预设 revision 漏掉了');
});

/* ══ 路由：注册形状、状态码、信封 ═══════════════════════════════════════ */

const DSH_HOME = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-qa-home-'));
TEMPS.push(DSH_HOME);
let routeWorkspace = '';

before(() => {
  routeWorkspace = makeWorkspace().workspace;
  fs.writeFileSync(path.join(DSH_HOME, 'studymate-config.yaml'), `workspace: "${routeWorkspace}"\n`);
  process.env.DSH_HOME = DSH_HOME;
});

/**
 * 假 ctx：`inject(['connection'])` 立刻回调，`effect` 立刻执行（与宿主同一时机）。
 * 只注册建会话那条路由——`/ask` 那条由 `test_host_ask_route.mjs` 守着（#107 退役）。
 */
function fakeCtx({ host = fakeHost(), registerAsk = false } = {}) {
  const routes = [];
  const child = {
    connection: { fetch: { register: (route) => { routes.push(route); return route; } } },
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
    get: (name) => (name === 'agents' ? host.agents
      : name === 'sessionTitle' ? host.sessionTitle
        : name === 'agentPresets' ? host.agentPresets
          : name === 'llm' ? host.llm
            : undefined),
  };
  const ctx = {
    agentPresets: host.agentPresets,
    inject: (names, handler) => { assert.deepEqual(names, ['connection']); handler(child); },
  };
  if (registerAsk) return { ctx, routes, child };
  return { ctx, routes, child };
}

test('#105 路由：POST /api/studymate/qa/session 挂在 /api/studymate 命名空间下', async () => {
  const host = fakeHost();
  // 只挂建会话那条：直接调它的注册入口（registerAskRoute 会连 `/ask` 一起挂，那条这里不验）
  const { registerAskSessionRoute } = await import('../../lib/ask/session.ts');
  const { ctx, routes } = fakeCtx({ host });
  registerAskSessionRoute(ctx);

  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, QA_SESSION_PATH);
  assert.equal(routes[0].path, '/api/studymate/qa/session');
  assert.deepEqual(routes[0].methods, ['POST']);
  assert.equal(routes[0].requestBody, 'buffered');

  const response = await routes[0].fetch(new Request('http://localhost' + QA_SESSION_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: '网络', node: '子网与掩码' }),
  }));
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.ok, true, JSON.stringify(view));
  // 路由自己造 id（`studymate-qa-<uuid>`）：只要它是那条被建出来的会话的 id
  assert.match(view.sessionId, /^studymate-qa-/);
  assert.equal(host.calls.create[0].sessionId, view.sessionId);
  assert.equal(view.title, `答疑${ASK_SESSION_SEP}网络${ASK_SESSION_SEP}子网与掩码`);
  assert.equal(view.memoryInjected, true);
});

test('#105 路由：坏请求体 400、没工作区 500、没模型 503——每种都是同一个信封', async () => {
  const { registerAskSessionRoute } = await import('../../lib/ask/session.ts');
  const { ctx, routes } = fakeCtx({ host: fakeHost() });
  registerAskSessionRoute(ctx);

  const bad = await routes[0].fetch(new Request('http://localhost' + QA_SESSION_PATH, { method: 'POST', body: 'not json' }));
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.equal(badBody.ok, false);
  assert.equal(badBody.error.code, 'body-invalid');
  assert.equal(badBody.available, true);

  // 没有工作区：DSH_HOME 指向一个没有配置的目录
  const emptyHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-qa-nohome-'));
  TEMPS.push(emptyHome);
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = emptyHome;
  try {
    const missing = await routes[0].fetch(new Request('http://localhost' + QA_SESSION_PATH, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }));
    assert.equal(missing.status, 500);
    const missingBody = await missing.json();
    assert.equal(missingBody.ok, false);
    assert.equal(missingBody.error.code, 'workspace-missing');
  } finally {
    process.env.DSH_HOME = previous;
  }

  // 没有可用模型：一张会话都不建，503 + available:false（面板据此显示警示块）
  const noModel = fakeHost({ withTitle: false });
  noModel.llm = undefined;
  const { ctx: noModelCtx, routes: noModelRoutes } = fakeCtx({ host: noModel });
  registerAskSessionRoute(noModelCtx);
  const unavailable = await noModelRoutes[0].fetch(new Request('http://localhost' + QA_SESSION_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: '网络' }),
  }));
  assert.equal(unavailable.status, 503);
  const view = await unavailable.json();
  assert.equal(view.available, false);
  assert.equal(view.ok, false);
  assert.ok(typeof view.reason === 'string' && view.reason.length > 0);
  assert.equal(noModel.calls.create.length, 0, '没有模型却把会话建出来了');
});

test('#105 注册入口：registerAskRoute 把两条路由一起挂上（bin/dsh-plugin.ts 那一行不动）', () => {
  const host = fakeHost();
  const { ctx, routes } = fakeCtx({ host });
  registerAskRoute(ctx);
  const paths = routes.map((route) => route.path).sort();
  assert.deepEqual(paths, ['/api/studymate/ask', QA_SESSION_PATH].sort());
});
