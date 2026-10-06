/* 验收 #107 · 旧问答链路退役：三条硬事实
   ────────────────────────────────────────────────────────────────────────
   #105 把「问答面板」换成了宿主的一条真会话，#107 就把旧的拆掉——这一票的验收面是
   **三条硬事实**，这条套件把它们写成会失败的断言（其余相关行为由既有套件覆盖）：

     1. **旧路由没注册**：`POST /api/studymate/ask` 不在登记表里。用一个假 connection
        跑插件那条注册路（`bin/dsh-plugin.ts` 调的 `registerAskSessionRoute`），断言登记表
        里只有 `/api/studymate/qa/session`；「请求它得到明确的『没有』」按宿主的登记表语义
        断言（path 不在表里 → 404 `not-found`，不是 200、也不是 500）。
     2. **面板那一侧没有「请求体」这一层**：`lib/client.js` 里没有发往旧路由的 POST 常量
        （那会以带引号的路径字面量出现），也没有那份上下文组装；旧链路的两个模块本身不在盘上，
        也没有任何源码还 import 它们。
     3. **问一句不写 `misconceptions.yaml`**：新会话链路跑一遍，整个工作区逐字节不变；
        同时断言**其余写入方仍写得进去**（`writeMisconception` 落一条 `讲解反馈`），
        以及 `问答面板` 这个值仍留在词表与 schema 里（旧数据要校验得过，读侧兼容）。

   数据现造现弃（ADR-0009）：工作区是临时目录，宿主的服务是假对象，`fetch` 不联网。
   ──────────────────────────────────────────────────────────────────────── */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { QA_AGENT_PRESET, QA_SESSION_PATH, registerAskSessionRoute } from '../../lib/ask/index.ts';
import { readMisconceptions, writeMisconception } from '../../lib/misconceptions.ts';
import { MISCONCEPTION_SOURCES } from '../../lib/core/misconceptions.ts';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** 旧链路的两个模块与旧路由路径：退役之后**不许**再回到盘上、注册表里或源码里。 */
const RETIRED_PATH = '/api/studymate/ask';
const RETIRED_MODULES = ['lib/ask/route.ts', 'lib/core/ask.ts'];

const TEMPS = [];
const ORIGINAL_DSH_HOME = process.env.DSH_HOME;
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
  if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIGINAL_DSH_HOME;
});

const MEMORY_MD = '讲法偏好：先给结论再给为什么。\n';
const MISCONCEPTIONS_YAML = [
  '# 这份文件只追加，不做整篇重写',
  '- topic: 掩码',
  '  source: 问答面板',
  '  evidence: 提问原文：为什么网络地址是 .64？',
  '  status: 未处理',
  '  at: 2026-09-24',
  '',
].join('\n');

/** 现造一份工作区：一个科目（带一份旧误解记录的字节）+ 共享记忆。 */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-ask-retire-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  const subjectDir = path.join(workspace, '.learning', 'subjects', '网络');
  fs.mkdirSync(subjectDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.learning', 'MEMORY.md'), MEMORY_MD);
  fs.writeFileSync(path.join(subjectDir, 'misconceptions.yaml'), MISCONCEPTIONS_YAML);
  // DSH_HOME 指向临时目录：`resolveWorkspace()` 走的是 `~/.dsh/studymate-config.yaml`。
  const dshHome = path.join(root, '.dsh');
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(path.join(dshHome, 'studymate-config.yaml'), `workspace: ${JSON.stringify(workspace)}\n`);
  return { workspace, dshHome };
}

/** 工作区里每一份文件的**逐字节**快照（相对路径 → base64）。 */
function snapshotWorkspace(workspace) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      out[path.relative(workspace, full).split(path.sep).join('/')] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(workspace);
  return out;
}

/* ── 假宿主半：登记表 + 预设注册表 + agents + sessionTitle + llm ────────── */

/**
 * 假 connection 的登记表：**以 path 为键**（与 `bin/dsh-plugin.ts` 里写的那份契约逐字相同：
 * 「同一个 path 注册第二次会抛 already registered」）。
 *
 * `dispatch` 模拟宿主的请求语义：表里有就交给那条路由，表里没有就是**明确的 404**
 * （`{ok:false, error:{code:'not-found'}}`）——真宿主里未注册的 path 就是这么回的，
 * 「不是 200、也不是 500」这句话因此有一个可断言的形状。
 */
function fakeConnection() {
  const routes = new Map();
  return {
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error(`Duplicate route: ${route.path}`);
      routes.set(route.path, route);
      return route;
    },
    dispatch(pathname) {
      if (!routes.has(pathname)) {
        return Response.json({ ok: false, error: { code: 'not-found', message: `没有这条路由：${pathname}` } }, { status: 404 });
      }
      return null; // 命中的那条由调用点自己 fetch（这里不替它发请求）
    },
  };
}

/** 假宿主服务：只需要建会话跑得起来的那几件。 */
function fakeHost() {
  const calls = { resolve: [], create: [], mount: [], inject: [] };
  const created = new Map();
  const agentPresets = {
    resolve: async (id) => { calls.resolve.push(id); return { id: QA_AGENT_PRESET }; },
    acquireScope: async (id) => ({ key: id, async [Symbol.asyncDispose]() {} }),
    mount: async (agentCtx, id) => { calls.mount.push({ agentCtx, id }); },
  };
  const handle = {
    agent: {
      session: { id: 'pending' },
      inject: (message) => { calls.inject.push(message); },
      dispose: () => { throw new Error('建会话那条路由不许 dispose 刚建好的会话'); },
    },
  };
  const agents = {
    create: async (options) => { calls.create.push(options); created.set(options.sessionId, handle); return handle; },
    get: (id) => created.get(id),
  };
  const sessionTitle = { rename: () => ({}) };
  return { agentPresets, agents, sessionTitle, llm: { listProviders: () => [{ id: 'fake-provider' }] }, calls };
}

/** 把插件那条注册路跑起来：`bin/dsh-plugin.ts` 就是拿这几件去调注册入口的。 */
function registerRoute(host) {
  const registry = fakeConnection();
  const ctx = {
    agentPresets: host.agentPresets,
    inject(names, handler) {
      assert.deepEqual(names, ['connection']);
      handler({
        connection: { fetch: { register: (route) => registry.register(route) } },
        effect: (fn) => fn(),
        get: (name) => (name === 'agents' ? host.agents
          : name === 'sessionTitle' ? host.sessionTitle
            : name === 'llm' ? host.llm
              : name === 'agentPresets' ? host.agentPresets
                : undefined),
      });
    },
  };
  registerAskSessionRoute(ctx);
  return registry;
}

/* ══ 1. 旧路由没注册 ═════════════════════════════════════════════════════ */

test('#107 旧路由没注册：登记表里只有建会话那一条，请求旧路径回的是明确的 404', () => {
  const registry = registerRoute(fakeHost());
  assert.deepEqual([...registry.routes.keys()], [QA_SESSION_PATH]);
  assert.equal(registry.routes.has(RETIRED_PATH), false, '旧路由又注册回来了');

  // 「请求它得到明确没有这条路由」：不是 200（空转），也不是 500（坏了）
  const response = registry.dispatch(RETIRED_PATH);
  assert.equal(response.status, 404);
  const body = response.json();
  return body.then((view) => {
    assert.equal(view.ok, false);
    assert.equal(view.error.code, 'not-found');
    assert.ok(view.error.message.length > 0);
  });
});

test('#107 起插件那条注册路（真 apply）：整张路由表里没有旧路径，建会话那条在', () => {
  // 假 connection 起**真** `bin/dsh-plugin.ts` 的 apply（与 test_bundle.mjs 同一种姿势：
  // 子进程 + 临时 HOME / DSH_HOME），把注册到的每一条路由收回来。
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-ask-plugin-'));
  TEMPS.push(dir);
  const code = `
    import { apply } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'bin', 'dsh-plugin.ts')).href)};
    const routes = [];
    const warnings = [];
    console.warn = (message) => { warnings.push(String(message)); };
    const ctx = {
      get: () => ({ name: 'web', home: process.env.DSH_HOME }),
      agentPresets: { register: async () => async () => {} },
      effect: async (fn) => { await fn(); },
      inject: (names, handler) => {
        if (names.includes('tools')) return;   // 工具域那一层与本条无关
        handler({
          connection: { fetch: { register: (route) => { routes.push(route); return route; } } },
          effect: (fn) => { fn(); return () => {}; },
          get: () => undefined,
        });
      },
    };
    await apply(ctx);
    // 那几条路由是浮动 Promise（apply 不等它们，见 bin/dsh-plugin.ts 的加载边界说明）：
    // 等到建会话那条出现为止，再报整张表
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !routes.some((route) => route.path === '/api/studymate/qa/session')) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    console.log(JSON.stringify({ paths: routes.map((route) => route.path), warnings }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: dir, USERPROFILE: dir,
      DSH_HOME: path.join(dir, '.dsh'),
      LEARN_WORKSPACE: path.join(dir, 'ws'),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const state = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.ok(state.paths.includes(QA_SESSION_PATH), `插件没把建会话那条路由挂上：${state.paths.join('、')}`);
  assert.equal(state.paths.includes(RETIRED_PATH), false, `旧路由还挂在插件上：${state.paths.join('、')}`);
  assert.equal(state.paths.includes('/api/studymate/library'), true, '插件连阅读端数据通路都没挂上，这条断言就白断了');
});

test('#107 旧链路的两份模块不在盘上，也没有任何源码还 import 它们', () => {
  for (const relative of RETIRED_MODULES) {
    assert.equal(fs.existsSync(path.join(ROOT, relative)), false, `${relative} 还留在盘上`);
  }
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (['.ts', '.js', '.mjs'].includes(path.extname(entry.name))) sources.push(full);
    }
  };
  for (const root of ['lib', 'bin']) walk(path.join(ROOT, root));
  const offenders = sources
    .filter((file) => /(?:from|import)\s*\(?\s*['"][^'"]*core\/ask\.ts['"]/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
  assert.deepEqual(offenders, [], `还有源码 import 已退役的 lib/core/ask.ts：${offenders.join('、')}`);
  // 插件那条注册路点名的是新入口，旧入口的名字一个都不留
  const plugin = fs.readFileSync(path.join(ROOT, 'bin', 'dsh-plugin.ts'), 'utf8');
  assert.match(plugin, /registerAskSessionRoute/);
  assert.equal(/registerAskRoute\b/.test(plugin), false, 'bin/dsh-plugin.ts 还在调旧注册入口');
});

/* ══ 2. 面板那一侧没有「请求体」这一层 ═══════════════════════════════════ */

test('#107 面板那一侧没有请求体：客户端里没有发往旧路由的 POST，也没有那份上下文组装', () => {
  const client = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
  // 代码里的路由常量一定带引号；注释里提一句历史不算「还发着请求」
  assert.equal(client.includes(`'${RETIRED_PATH}'`) || client.includes(`"${RETIRED_PATH}"`), false,
    '客户端里还有发往旧路由的路径常量');
  assert.equal(client.includes('buildAskContext'), false, '客户端里还有旧的上下文组装');
  assert.equal(/ASK_ENDPOINT\b/.test(client), false, '客户端里还留着旧路由的常量名');
  // 正面的那一半：面板请宿主半建会话用的是新路由
  assert.equal(client.includes(`'${QA_SESSION_PATH}'`), true, '客户端没有建会话那条路由的常量');
});

/* ══ 3. 问一句不写 misconceptions.yaml；其余写入方照旧 ═══════════════════ */

test('#107 走一遍新会话链路：整个工作区逐字节不变（一个字都不落盘）', async () => {
  const { workspace, dshHome } = makeWorkspace();
  process.env.DSH_HOME = dshHome;
  const host = fakeHost();
  const registry = registerRoute(host);

  const before = snapshotWorkspace(workspace);
  const response = await registry.routes.get(QA_SESSION_PATH).fetch(new Request('http://localhost' + QA_SESSION_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: '网络', node: '子网与掩码' }),
  }));
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.equal(host.calls.create.length, 1);
  assert.equal(host.calls.inject.length, 1, '共享记忆该注入一条');

  assert.deepEqual(snapshotWorkspace(workspace), before, '建会话这条链路碰了工作区');
  assert.equal(fs.readFileSync(path.join(workspace, '.learning', 'subjects', '网络', 'misconceptions.yaml'), 'utf8'), MISCONCEPTIONS_YAML);
});

test('#107 其余写入方照旧：讲解反馈仍写得进，旧记录里的「问答面板」仍读得进、校验得过', () => {
  const { workspace, dshHome } = makeWorkspace();
  process.env.DSH_HOME = dshHome;

  // 面板不再是写入方，但误解记录这套机制一个字都没退役：另一条写入方照样落得下去
  const write = writeMisconception({
    workspace,
    subject: '网络',
    record: { topic: '掩码的算法', source: '讲解反馈', evidence: '讲解里说了掩码按位与' },
    operationId: 'retire-1',
    now: new Date('2026-10-07T00:00:00Z'),
  });
  assert.equal(write.ok, true, JSON.stringify(write));
  assert.equal(write.entry.source, '讲解反馈');

  const items = readMisconceptions({ workspace, subject: '网络' });
  assert.deepEqual(items.map((item) => item.source), ['问答面板', '讲解反馈']);
  // 没给 source 时兜底成「讲解反馈」——与读侧归一同一句话（不再是面板那个值）
  const fallback = writeMisconception({
    workspace, subject: '网络',
    record: { topic: '兜底', evidence: '没给 source' },
    operationId: 'retire-2', now: new Date('2026-10-07T00:00:00Z'),
  });
  assert.equal(fallback.ok, true, JSON.stringify(fallback));
  assert.equal(fallback.entry.source, '讲解反馈');

  // 读侧兼容：`问答面板` 这个值仍在词表与 schema 的 enum 里（旧学科里已落盘的记录要校验得过）
  assert.ok([...MISCONCEPTION_SOURCES].includes('问答面板'));
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'misconceptions.schema.json'), 'utf8'));
  assert.ok(schema.items.properties.source.enum.includes('问答面板'), 'schema 里把「问答面板」删掉了：旧数据会校验不过');
});
