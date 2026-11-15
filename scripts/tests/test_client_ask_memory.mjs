/* 验收 #241 · 问答面板不再「挂载即建」空会话（阅读端 `lib/client.js`）
   ────────────────────────────────────────────────────────────────────────
   三个成因：①挂载 effect 没有持久凭据，面板挂上就建一条；②建完 `refresh()` 不等
   结果，刷新没落地时重挂按标题认不出刚建的那条，又建一条（竞态）；③宿主半 rename
   不 await，持久标题投影出来之前按标题认不出旧会话。症状：同标题的空会话在一分钟
   内聚堆（issue #241 现场）。

   修法（issue 期望方案 2）：面板把「科目/节点标题 → sessionId」记进 localStorage
   （读写都不抛——无痕模式里 localStorage 会抛，#241 现场就是 Win11），挂载按
   「记忆 → 标题快照 → 才建」三级认领，建成写回；学生点历史项也写回。

   为什么不走 fixtures/client_harness.mjs：那份夹具的沙箱 window 没有 localStorage，
   而本修复读写的正是 localStorage。这里照同一姿势自建加载器（new Function 的第一参
   就是 window 本身——扁平对象，参数名会遮蔽 globalThis.window），React 桩同样按
   调用次序喂帧、useEffect 收集起来显式跑。sessions 服务照宿主姿势从 `apply(ctx)` 进
   闭包（组件读的是 hostServices，不是 props）。fetch 是本地假货，不联网。
   ──────────────────────────────────────────────────────────────────────── */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
const MEMORY_KEY = 'studymate.ask.sessions.v1';

/* ── 自建加载器：沙箱 window 带 localStorage，React 是按帧喂值的桩 ────────── */

function makeStorage(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
}

/* 桩读模块级变量（不是捕获数组）：mountPanel 每次渲染都会重设 frames/pendingEffects。 */
let frames = null;
let frameIndex = 0;
let pendingEffects = [];

function stubReact() {
  const Fragment = Symbol('react.fragment');
  return {
    Fragment,
    // 类组件的基类（#174 ② 的渲染边界要 `extends React.Component`）。这份桩只求「工厂能物化」：
    // 边界里的 getDerivedStateFromError / componentDidCatch 在 Node 侧一次也跑不到。
    Component: class Component {
      constructor(props) { this.props = props; this.state = this.state || {}; }

      setState(patch) {
        const next = typeof patch === 'function' ? patch(this.state, this.props) : patch;
        this.state = Object.assign({}, this.state, next || {});
      }
    },
    createElement: (type, props, ...children) => ({
      type, props: props || {},
      children: children.length <= 1 ? children[0] : children,
    }),
    useState: (initial) => {
      const index = frameIndex++;
      const has = frames !== null && index < frames.length;
      return [has ? frames[index] : (typeof initial === 'function' ? initial() : initial), () => {}];
    },
    useEffect: (fn) => { if (typeof fn === 'function') pendingEffects.push(fn); },
    useMemo: (compute) => compute(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial === undefined ? null : initial }),
  };
}

let internals = null;
let clientStorage = null; // 工厂闭包捕获的那份 localStorage（与 read/write 同一个对象）
let pluginCache = null;   // 同一次工厂执行返回的插件（AskPanel 与 plugin 必须同一个闭包）

/** 加载一次（缓存）：拿到工厂闭包里的内部件（含 AskPanel 与记忆表两端）。 */
function loadClient() {
  if (internals) return internals;
  const loaded = [];
  clientStorage = makeStorage();
  const sandbox = { __ModuleLoader__: { load: (entry) => loaded.push(entry) }, localStorage: clientStorage };
  new Function('window', 'document', 'navigator', SOURCE)(sandbox, undefined, undefined);
  assert.equal(loaded.length, 1, '插件应当恰好注册一次');
  let captured = null;
  globalThis.__studymate_client_internals = (value) => { captured = value; };
  try {
    pluginCache = loaded[0].factory((name) => (name === 'react' ? stubReact() : undefined));
  } finally {
    delete globalThis.__studymate_client_internals;
  }
  assert.ok(captured, 'client.js 没有挂出内部件钩子');
  internals = captured;
  // 套件直接操作记忆表时也走同一份 storage（闭包里 window.localStorage 就是它）
  globalThis.localStorage = clientStorage;
  return internals;
}

/** 照宿主姿势把假服务交进闭包（组件读 hostServices）。必须用同一个工厂实例的 plugin。 */
function applyServices(ctx) {
  pluginCache.apply({
    get: (name) => (name === 'sessions' ? ctx.sessions : undefined),
    slots: { inject: (seat, callback) => { callback(); }, register: () => null },
  });
}

/* ── 挂载辅助：把 AskPanel 渲到第一帧并跑掉挂载 effect ─────────────────── */

/** 面板的 hook 次序：sessionId / held / error / busy / menuOpen（useRef、useEffect 不占帧）。 */
function panelFrame({ sessionId = null, menuOpen = false } = {}) {
  return [sessionId, null, null, false, menuOpen];
}

/** 假会话服务（与 test_client_ask_panel.mjs 的 fakeSessions 同形，取最小面）。 */
function fakeCtx(sessionsRows) {
  const state = {
    ids: sessionsRows.map((row) => row.id),
    byId: Object.fromEntries(sessionsRows.map((row) => [row.id, row])),
    phase: 'ready',
    projectionsBySession: {},
  };
  const sessions = {
    list: { getSnapshot: () => state, subscribe: () => () => {} },
    retain: (id) => ({ sessionId: id, binding: { sessionId: id }, ready: Promise.resolve(), release: () => {} }),
    refresh: () => Promise.resolve(),
  };
  return { sessions };
}

function fakeKit() {
  const SessionProvider = (props) => props.children;
  const renderFactorySlot = (name, props) => ({
    type: 'div', props: { 'data-proto': 'host-conversation', 'data-name': name, 'data-variant': props && props.variant }, children: null,
  });
  return { SessionProvider, renderSlot: () => null, renderFactorySlot };
}

/** 渲一块面板（第一帧）并跑掉挂载 effect；返回原始元素树。fetch 由 mountPanel 预先装好。 */
function renderOnce(ctx, { subject = '计算机网络', node = '子网与掩码', sessionId = null, menuOpen = false } = {}) {
  const { AskPanel } = loadClient();
  frames = panelFrame({ sessionId, menuOpen });
  frameIndex = 0;
  pendingEffects = [];
  try {
    return AskPanel({
      subject: { slug: 'computer-networks', name: subject },
      node: { id: 'net.mask', title: node },
      quote: null, hostKit: fakeKit(),
    });
  } finally {
    frames = null;
    frameIndex = 0;
  }
}

async function drain() {
  for (const fn of pendingEffects.splice(0)) { const out = fn(); void out; }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 挂一块面板：清记忆表、写 seed、接线假服务、渲染第一帧、跑挂载 effect。
 * 返回断言把手：POST 账目、记忆表 dump、重挂。
 */
async function mountPanel({ seed, sessions: sessionsRows = [], subject = '计算机网络', node = '子网与掩码' } = {}) {
  loadClient();
  clientStorage.removeItem(MEMORY_KEY);
  for (const [key, id] of Object.entries(seed || {})) clientStorage.setItem(MEMORY_KEY, JSON.stringify({ ...JSON.parse(clientStorage.getItem(MEMORY_KEY) || '{}'), [key]: id }));
  const ctx = fakeCtx(sessionsRows);
  applyServices(ctx);
  const calls = [];
  const reply = { available: true, ok: true, sessionId: 'sess-new-' + Math.random().toString(16).slice(2), title: null, renamed: true };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => reply };
  };
  const tree = renderOnce(ctx, { subject, node });
  await drain();
  return {
    calls,
    createdId: () => (calls.length ? reply.sessionId : null),
    dump: () => {
      const raw = clientStorage.getItem(MEMORY_KEY);
      return raw ? JSON.parse(raw) : null;
    },
    remount: async () => {
      const again = renderOnce(ctx, { subject, node });
      await drain();
      return again;
    },
    ctx,
    tree,
  };
}

/* ══ 一、记忆表两端：读写都不抛 ═══════════════════════════════════════════ */

test('#241 记忆表：读——没存过/坏值/数组都当没有，绝不抛', () => {
  const { readAskSessionMemory, writeAskSessionMemory } = loadClient();
  clientStorage.removeItem(MEMORY_KEY);
  assert.deepEqual(readAskSessionMemory(), {}, '没存过');
  writeAskSessionMemory('临时课', 'tmp-1');
  assert.equal(readAskSessionMemory()['临时课'], 'tmp-1');
  globalThis.localStorage.setItem(MEMORY_KEY, '{{{bad');
  assert.deepEqual(readAskSessionMemory(), {}, '坏 JSON');
  globalThis.localStorage.setItem(MEMORY_KEY, JSON.stringify([1, 2]));
  assert.deepEqual(readAskSessionMemory(), {}, '数组不是表');
  globalThis.localStorage.setItem(MEMORY_KEY, JSON.stringify('str'));
  assert.deepEqual(readAskSessionMemory(), {}, '字符串不是表');
});

test('#241 记忆表：写——封顶 64 条丢最早写的；空标题/空 id 不写', () => {
  const { writeAskSessionMemory, readAskSessionMemory } = loadClient();
  clientStorage.removeItem(MEMORY_KEY);
  writeAskSessionMemory('', 'sess-1');
  writeAskSessionMemory('答疑 · 数学', '');
  assert.deepEqual(readAskSessionMemory(), {}, '空参数不写');
  for (let i = 0; i < 70; i++) writeAskSessionMemory('课-' + i, 'id-' + i);
  const table = readAskSessionMemory();
  assert.equal(Object.keys(table).length, 64);
  assert.equal(table['课-69'], 'id-69', '最新一条要在');
  assert.equal(table['课-0'], undefined, '最早的一条被挤掉');
  assert.equal(table['课-5'], undefined);
  assert.equal(table['课-6'], 'id-6', '边界后第一条要在');
});

test('#241 记忆表：无痕模式（localStorage 抛）读写都静默，不把面板带崩', () => {
  // 另开一个沙箱：localStorage 的每个方法都抛（工厂闭包捕获的就是这份）
  const loaded = [];
  const throwing = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  new Function('window', 'document', 'navigator', SOURCE)(
    { __ModuleLoader__: { load: (entry) => loaded.push(entry) }, localStorage: throwing }, undefined, undefined);
  let captured = null;
  globalThis.__studymate_client_internals = (value) => { captured = value; };
  try {
    loaded[0].factory((name) => (name === 'react' ? stubReact() : undefined));
  } finally {
    delete globalThis.__studymate_client_internals;
  }
  assert.doesNotThrow(() => captured.readAskSessionMemory());
  assert.doesNotThrow(() => captured.writeAskSessionMemory('答疑 · 数学 · 一元二次方程', 'sess-1'));
  assert.deepEqual(captured.readAskSessionMemory(), {});
});

/* ══ 二、挂载三级认领：记忆 → 标题快照 → 才建 ════════════════════════════ */

const SUBJECT_NAME = '计算机网络';
const NODE_TITLE = '子网与掩码';
const SEP = loadClient().ASK_SESSION_SEP;
const TITLE = `答疑${SEP}${SUBJECT_NAME}${SEP}${NODE_TITLE}`;

test('#241 挂载：记忆命中就直接认回那条会话，不发 POST、不建新的', async () => {
  const env = await mountPanel({ seed: { [TITLE]: 'sess-kept' } });
  assert.deepEqual(env.calls, []);
});

test('#241 挂载：没记忆时标题快照认得出（老会话/换浏览器），同样不建', async () => {
  const env = await mountPanel({ sessions: [{ id: 'sess-old', title: TITLE }] });
  assert.deepEqual(env.calls, []);
});

test('#241 挂载：记忆与快照都没有才建，建成写回记忆（重挂不再建第二条）', async () => {
  const env = await mountPanel();
  assert.equal(env.calls.length, 1, '只建一条');
  assert.equal(env.calls[0].url, '/api/studymate/qa/session');
  assert.equal(env.dump()[TITLE], env.createdId(), '建成要写回记忆');
  await env.remount();
  assert.equal(env.calls.length, 1, '重挂不再建：记忆命中');
});

test('#241 挂载：宿主标题还没投影出来（快照认不出）时，记忆兜底也不建', async () => {
  const env = await mountPanel({ seed: { [TITLE]: 'sess-mem' }, sessions: [{ id: 'sess-noise', title: '别的会话' }] });
  assert.deepEqual(env.calls, []);
});

test('#241 换节点：另一课没记忆、快照也没有时照常建，原课的记忆不受影响', async () => {
  const env = await mountPanel({ seed: { [TITLE]: 'sess-kept' }, node: '二次函数图像' });
  assert.equal(env.calls.length, 1, '新节点照常建');
  assert.equal(env.dump()[TITLE], 'sess-kept', '原课记忆不动');
  assert.equal(env.dump()['答疑' + SEP + SUBJECT_NAME + SEP + '二次函数图像'], env.createdId());
});

/* ══ 三、历史项点选写回 ══════════════════════════════════════════════════ */

test('#241 历史项：点「上一段会话」里哪条，哪条写进记忆成为这一课的恢复目标', async () => {
  const findByProp = (node, key, value, found = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return found;
    if (Array.isArray(node)) { for (const item of node) findByProp(item, key, value, found); return found; }
    if (node.props && node.props[key] === value) found.push(node);
    if ('children' in node) findByProp(node.children, key, value, found);
    if (node.props && node.props.children !== undefined) findByProp(node.props.children, key, value, found);
    return found;
  };
  const rows = [{ id: 'sess-a', title: TITLE }, { id: 'sess-b', title: TITLE }];
  const env = await mountPanel({ sessions: rows, seed: {} });
  // 把面板驱到 menuOpen 帧再渲染，找出历史项按钮
  const tree = renderOnce(env.ctx, { sessionId: 'sess-a', menuOpen: true });
  const items = findByProp(tree, 'data-proto', 'qa-history-item');
  assert.equal(items.length, 2, '历史项应当列出来');
  // 点第二条（旧的那条）
  items[1].props.onClick();
  assert.equal(env.dump()[TITLE], 'sess-b', '点谁，谁写进记忆');
});
