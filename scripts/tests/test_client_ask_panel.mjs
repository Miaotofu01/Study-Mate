/* 验收 #105 · 右栏「问答」面板 = 宿主的一条真会话（阅读端 `lib/client.js`）
   ────────────────────────────────────────────────────────────────────────
   面板原来是「一次一问一答」的表单：点「问一句」→ POST `/api/studymate/ask` → 一段回答。
   这条票把它换成宿主的一条真会话，于是这份套件钉的四件事全变了：

     1. **建会话走宿主半**：面板 POST 的是 `/api/studymate/qa/session`，请求体只有
        `{subject, node}`（拼标题用）——**没有** messages / history / sessionId 这些「面板自己
        背会话」的痕迹（旧契约的化身，见 #79 那条套件）；
     2. **retain 那条会话**：`sessions.retain(id, { source: 'studymateAsk' })`——`mainView`
        是宿主判「谁是当前会话」的标签，借了它会顶掉学生正在看的会话，所以逐字断言不是它；
     3. **嵌的是宿主正文**：`SessionProvider` 包着 `conversation.content`（`variant:'embedded'`），
        并且 Provider 指着的就是我们 retain 的那条引用；
     4. **上一段会话只列答疑会话**：标题前缀认（`title` 而不是会退化成项目名的 `displayTitle`），
        没有可用模型时如实说明、不假装会答。

   夹具：`fixtures/client_harness.mjs` 的 React 桩（`useState` 按调用次序喂帧、`useEffect`
   要显式 `drainEffects()` 才跑）+ 一个假的 `sessions` 服务（`apply(fakeCtx)` 时交给插件）。
   `fetch` 是本地假货——套件里不联网。数据现造现弃。
   ──────────────────────────────────────────────────────────────────────── */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clientInternals, drainEffects, findByProp, loadClient, renderWithState, resetHookState, setHookState,
} from './fixtures/client_harness.mjs';
// 宿主半那一份拼法（客户端 import 不了 lib/ask/**：它是零构建的浏览器文件，自己写了一份）
import {
  ASK_SESSION_PREFIX as HOST_PREFIX, ASK_SESSION_SEP as HOST_SEP,
  isAskSessionTitle as hostIsAskSessionTitle, titleForAskSession as hostTitleForAskSession,
} from '../../lib/ask/index.ts';

const internals = clientInternals();
const {
  AskPanel, QA_SESSION_ENDPOINT, ASK_RETAIN_SOURCE, ASK_SESSION_PREFIX, ASK_SESSION_SEP,
  titleForAskSession, isAskSessionTitle, askSessionRows, latestAskSessionId,
} = internals;

/* ── 假服务与假 fetch ──────────────────────────────────────────────────── */

const ASK_SOURCE = ASK_RETAIN_SOURCE;
assert.equal(ASK_SOURCE, 'studymateAsk', 'retain 的来源标签被改了？它必须是我们自己那个');

/** 假会话服务：记下 retain/release，列表是现造现用的快照。 */
function fakeSessions(rows = []) {
  const retained = [];
  const released = [];
  const refreshes = [];
  const state = {
    ids: rows.map((row) => row.id),
    byId: Object.fromEntries(rows.map((row) => [row.id, row])),
    phase: 'ready',
    projectionsBySession: {},
  };
  const references = {};
  const sessions = {
    retained,
    released,
    refreshes,
    list: { getSnapshot: () => state, subscribe: () => () => {} },
    retain: (id, options) => {
      retained.push({ id, options });
      const reference = {
        sessionId: id,
        binding: { sessionId: id },
        ready: Promise.resolve(),
        release: () => { released.push(id); },
      };
      references[id] = reference;
      return reference;
    },
    refresh: () => { refreshes.push(true); return Promise.resolve(); },
  };
  return { sessions, references, state };
}

let calls = [];
let reply = null;
let sessions = null;
let references = {};

globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  return { ok: true, status: 200, json: async () => reply };
};

beforeEach(() => {
  calls = [];
  reply = null;
  const made = fakeSessions([]);
  sessions = made.sessions;
  references = made.references;
  // 服务只能从 `apply(ctx)` 进闭包（它不是 props）：这里照宿主的姿势把它交进去
  loadClient().plugin.apply({
    get: (name) => (name === 'sessions' ? sessions : undefined),
    slots: { inject: (seat, callback) => { callback(); }, register: () => null },
  });
});

const SUBJECT = { slug: 'computer-networks', name: '计算机网络' };
const NODE = { id: 'net.mask', title: '子网与掩码' };
const TITLE = `答疑${ASK_SESSION_SEP}计算机网络${ASK_SESSION_SEP}子网与掩码`;
const SELECTION = '掩码是按位与：100 与 192 逐位相与得 64。';
const QUOTE = { text: SELECTION, anchor: { lesson: 'computer-networks/0003-net.mask.md', section: 'mask-2', sectionTitle: '掩码' } };

/** 面板的 hook 次序：sessionId / held / error / busy / menuOpen（useRef、useEffect 不占帧）。 */
function frame({ sessionId = null, reference = null, error = null, busy = false, menuOpen = false } = {}) {
  return [sessionId, sessionId && reference ? { id: sessionId, reference } : null, error, busy, menuOpen];
}

/** 假的宿主标准件：`renderFactorySlot` 记账并给出一个带标记的元素。 */
function fakeKit() {
  const factoryCalls = [];
  const SessionProvider = (props) => props.children;
  const renderFactorySlot = (name, props) => {
    factoryCalls.push({ name, props });
    return {
      type: 'div',
      props: { 'data-proto': 'host-conversation', 'data-name': name, 'data-variant': props && props.variant },
      children: null,
    };
  };
  return { kit: { SessionProvider, renderSlot: () => null, renderFactorySlot }, factoryCalls, SessionProvider };
}

/** 在元素树里找「type === 某个函数」的节点（`findByProp` 只按 props 找，这里按组件找）。 */
function findByType(node, type, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) { for (const item of node) findByType(item, type, found); return found; }
  if (node.type === type) found.push(node);
  if ('children' in node) findByType(node.children, type, found);
  if (node.props && node.props.children !== undefined) findByType(node.props.children, type, found);
  return found;
}

/** 面板渲染成文本（把 useState 驱到某一帧）；effect 不跑，行为类断言调 `drainEffects`。 */
function renderText(state, props = {}) {
  const { kit } = fakeKit();
  return renderWithState(AskPanel, { subject: SUBJECT, node: NODE, quote: null, hostKit: kit, ...props }, state)
    .replace(/\s+/g, ' ').trim();
}

/** 只渲染一次、拿原始元素树（结构类断言用；`viewText` 会把组件就地展开，这里不需要）。 */
function renderTree(state, props = {}) {
  resetHookState();
  setHookState(state);
  try {
    return AskPanel({ subject: SUBJECT, node: NODE, quote: null, hostKit: fakeKit().kit, ...props });
  } finally {
    resetHookState();
  }
}

/* ══ 一、纯函数：标题的拼法与识别、会话列表的认法 ═════════════════════════ */

test('#105 标题：拼法与宿主半逐字一致（缺哪节少写哪节），识别只认「答疑」+ 一节以上', () => {
  assert.equal(titleForAskSession('计算机网络', '子网与掩码'), TITLE);
  assert.equal(titleForAskSession('计算机网络', ''), `答疑${ASK_SESSION_SEP}计算机网络`);
  assert.equal(titleForAskSession('', ''), '答疑');
  assert.equal(isAskSessionTitle(TITLE), true);
  assert.equal(isAskSessionTitle('答疑解惑'), false, '「以答疑开头就算」会认错别的标题');
  assert.equal(isAskSessionTitle('学习 · 计算机网络'), false);
  assert.equal(isAskSessionTitle(undefined), false, 'title 是可缺的：认不出就是「没有上一段」');
});

test('#105 防漂移：宿主半拼出来的标题，客户端必须逐字认得（同一份前缀，两个文件）', () => {
  // 这份判据是「注释祈祷」的替代品：客户端那份重复实现漂了，症状是「上一段会话」列不出来
  // 或列出别人的会话——很难查。所以拿宿主半的拼法去喂客户端的识别，逐条对上。
  assert.equal(ASK_SESSION_PREFIX, HOST_PREFIX, '两边的前缀字面量不一致');
  assert.equal(ASK_SESSION_SEP, HOST_SEP, '两边的分隔符不一致');
  for (const [subject, node] of [['数学', '0003-变量'], ['网络', '子网与掩码'], ['', ''], ['  数学  ', ' 变量 ']]) {
    const title = hostTitleForAskSession(subject, node);
    assert.equal(titleForAskSession(subject, node), title, `两边的拼法不一致：「${title}」`);
    assert.equal(isAskSessionTitle(title), true, `客户端认不出宿主拼出来的「${title}」`);
    assert.equal(hostIsAskSessionTitle(title), true);
  }
  // 反证：宿主不认的，客户端也不许认
  for (const title of ['答疑解惑', '学习 · 数学', '', undefined]) {
    assert.equal(isAskSessionTitle(title), hostIsAskSessionTitle(title), `对「${title}」两边判得不一样`);
  }
});

test('#105 上一段会话：只列答疑会话，用 title 不用会退化成项目名的 displayTitle', () => {
  const rows = [
    { id: 'learn-1', title: '学习 · 计算机网络', displayTitle: '学习 · 计算机网络', updatedAt: 300 },
    { id: 'ask-old', title: `答疑${ASK_SESSION_SEP}计算机网络${ASK_SESSION_SEP}子网与掩码`, displayTitle: 'x', updatedAt: 100 },
    { id: 'ask-new', title: `答疑${ASK_SESSION_SEP}计算机网络${ASK_SESSION_SEP}子网与掩码`, displayTitle: 'x', updatedAt: 200 },
    // 工作目录恰好以「答疑」开头的项目：displayTitle 会退化成它，title 缺 → 不算我们那几条
    { id: 'other', displayTitle: '答疑项目 · 别的会话', updatedAt: 400 },
  ];
  const made = fakeSessions(rows);
  const ours = askSessionRows(made.sessions);
  assert.deepEqual(ours.map((row) => row.id), ['ask-new', 'ask-old'], '没按最近在前排，或把别的会话算进来了');
  assert.equal(latestAskSessionId(made.sessions, TITLE), 'ask-new');
  assert.equal(latestAskSessionId(made.sessions, `答疑${ASK_SESSION_SEP}别的科目`), null);
});

/* ══ 二、注册形状：拿得到 SessionProvider 的前提 ═════════════════════════ */

test('#105 注册：main 声明了非 root 子座位（不然永远拿不到 SessionProvider），插件注入会话服务', () => {
  const plugin = loadClient().plugin;
  assert.deepEqual(plugin.inject, ['slots', 'sessions', 'inputTriggers', 'conversation']);
  const registered = [];
  plugin.apply({
    get: () => undefined,
    slots: { inject: (seat, callback) => { callback(); }, register: (options, component) => { registered.push({ options, component }); return () => {}; } },
  });
  const main = registered.find((entry) => entry.options.name === 'main');
  assert.ok(main, '没在 main 座位注册阅读端本体');
  assert.deepEqual(main.options.children, { 'studymate.ask.session': { kind: 'single', scope: 'session' } },
    'children 里没有非 root 子座位：框架不会把 SessionProvider 交给我们');
});

/* ══ 三、建会话：走宿主半那条路由，请求体里没有会话 ═══════════════════════ */

test('#105 建会话：面板 POST /api/studymate/qa/session，请求体只有 {subject, node}', async () => {
  reply = { available: true, ok: true, sessionId: 'qa-1', title: TITLE, renamed: true, memoryInjected: true };
  const kit = fakeKit();
  resetHookState();
  setHookState(frame());
  let tree = null;
  try {
    tree = AskPanel({ subject: SUBJECT, node: NODE, quote: null, hostKit: kit.kit });
    assert.ok(tree, '面板没渲染出来');
    // 挂载时没有现成会话 → 请宿主半建一条（effect 里的事；桩要显式跑一次）
    for (const cleanup of drainEffects()) cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    resetHookState();
  }

  assert.equal(calls.length, 1, '面板没有去建会话');
  assert.equal(calls[0].url, QA_SESSION_ENDPOINT);
  assert.equal(calls[0].url, '/api/studymate/qa/session');
  assert.equal(calls[0].options.method, 'POST');
  const body = JSON.parse(calls[0].options.body);
  // 面板**不背会话**：送出去的只有拼标题要的两个展示名
  assert.deepEqual(Object.keys(body).sort(), ['node', 'subject']);
  assert.equal(body.subject, '计算机网络');
  assert.equal(body.node, '子网与掩码');
  for (const forbidden of ['messages', 'history', 'sessionId', 'conversation', 'question']) {
    assert.equal(Object.hasOwn(body, forbidden), false, `请求体里出现了 ${forbidden}（那是旧的「面板自己拼会话」）`);
  }
});

test('#105 建会话：没有现成会话时，面板不去 retain 一条不存在的会话', () => {
  resetHookState();
  setHookState(frame());
  try {
    AskPanel({ subject: SUBJECT, node: NODE, quote: null, hostKit: fakeKit().kit });
    drainEffects();
  } finally {
    resetHookState();
  }
  assert.equal(sessions.retained.length, 0);
});

/* ══ 四、retain：来源标签绝不能用 mainView，卸载时 release ═══════════════ */

test('#105 retain：选中的那条会话用 { source: "studymateAsk" } retain，换会话时 release', () => {
  resetHookState();
  setHookState(frame({ sessionId: 'qa-7', reference: { sessionId: 'qa-7', release() {} } }));
  try {
    AskPanel({ subject: SUBJECT, node: NODE, quote: null, hostKit: fakeKit().kit });
    const cleanups = drainEffects();
    assert.equal(sessions.retained.length, 1, '没有 retain 面板那条会话');
    assert.equal(sessions.retained[0].id, 'qa-7');
    assert.equal(sessions.retained[0].options.source, 'studymateAsk');
    assert.notEqual(sessions.retained[0].options.source, 'mainView',
      'mainView 是宿主判「谁是当前会话」的标签，借了它会顶掉学生正在看的会话');
    // 卸载 / 换会话：必须释放，否则那条会话永远不退休
    for (const cleanup of cleanups) cleanup();
    assert.deepEqual(sessions.released, ['qa-7']);
  } finally {
    resetHookState();
  }
});

/* ══ 五、嵌的是宿主正文，并且被 SessionProvider 指着我们那条 ═════════════ */

test('#105 嵌正文：SessionProvider 包着 conversation.content（embedded），指向我们 retain 的引用', () => {
  const reference = { sessionId: 'qa-9', binding: { sessionId: 'qa-9' }, ready: Promise.resolve(), release() {} };
  const { kit, factoryCalls, SessionProvider } = fakeKit();
  const tree = renderTree(frame({ sessionId: 'qa-9', reference }), { hostKit: kit });

  const providers = findByType(tree, SessionProvider);
  assert.equal(providers.length, 1, '面板没有用 SessionProvider 把正文罩起来');
  assert.equal(providers[0].props.session, reference, 'SessionProvider 指的不是我们 retain 的那条引用');

  // 罩在里面的就是宿主正文那个工厂，入参只给 embedded / active / hero:false
  const embedded = findByProp(providers[0].children, 'data-name', 'conversation.content');
  assert.equal(embedded.length, 1, 'SessionProvider 里包的不是 conversation.content');
  assert.equal(embedded[0].props['data-variant'], 'embedded');
  assert.deepEqual(factoryCalls.map((call) => call.name), ['conversation.content']);
  assert.deepEqual(factoryCalls[0].props, { variant: 'embedded', phase: 'active', hero: false });
  // 渲染得出来 = 这一格真的进了树（不是某个 if 后面的死代码）
  assert.ok(renderText(frame({ sessionId: 'qa-9', reference })).length > 0);
});

test('#105 没有宿主标准件时如实说明（嵌不了就说嵌不了，不是白屏）', () => {
  const text = renderText(frame({ sessionId: 'qa-9', reference: { sessionId: 'qa-9', release() {} } }), { hostKit: null });
  assert.ok(text.includes('嵌不了宿主会话'), text);
});

/* ══ 六、上一段会话与当前那条 ═════════════════════════════════════════════ */

test('#105 上一段会话：单子上只有答疑会话，点一条就换过去', () => {
  const made = fakeSessions([
    { id: 'ask-1', title: `答疑${ASK_SESSION_SEP}计算机网络`, displayTitle: '不计较', updatedAt: 100 },
    { id: 'learn-1', title: '学习 · 计算机网络', displayTitle: '学习 · 计算机网络', updatedAt: 200 },
    { id: 'ask-2', title: `答疑${ASK_SESSION_SEP}计算机网络${ASK_SESSION_SEP}子网与掩码`, displayTitle: '不计较', updatedAt: 300 },
  ]);
  sessions = made.sessions;
  loadClient().plugin.apply({
    get: (name) => (name === 'sessions' ? sessions : undefined),
    slots: { inject: (seat, callback) => { callback(); }, register: () => null },
  });

  const tree = renderTree(frame({ sessionId: 'ask-2', menuOpen: true }));
  const items = findByProp(tree, 'data-proto', 'qa-history-item');
  assert.deepEqual(items.map((item) => item.props['data-session']), ['ask-2', 'ask-1'],
    '单子里混进了非答疑会话，或者没按最近的在前');
  const text = renderText(frame({ sessionId: 'ask-2', menuOpen: true }));
  assert.ok(text.includes('答疑' + ASK_SESSION_SEP + '计算机网络'), text);
  assert.equal(text.includes('学习 · 计算机网络'), false, '学习会话不该出现在答疑的单子里');
});

/* ══ 七、没有可用模型：如实说明，旧文案一句不留 ═══════════════════════════ */

test('#105 无模型：如实说明，且不再提「误解记录 / 不经过总控 / 回答不进会话记录」', () => {
  const text = renderText(frame({
    error: { unavailable: true, reason: '宿主里一个模型 provider 都没注册' },
  }));
  assert.ok(text.includes('这条链路上没有可用的模型'), text);
  assert.ok(text.includes('provider 都没注册'), '没把 reason 带出来：' + text);
  assert.ok(text.includes('不假装会答'), text);
  for (const gone of ['不经过总控', '回答不进会话记录', '误解记录', '问一句', '错一条']) {
    assert.equal(text.includes(gone), false, `旧文案还在：${gone}`);
  }
});

test('#105 建不出来（不是没模型）：说清是哪一格没开起来，同样不假装会答', () => {
  const text = renderText(frame({ error: { unavailable: false, reason: '读不到「答疑模式」预设' } }));
  assert.ok(text.includes('这条答疑会话没开起来'), text);
  assert.ok(text.includes('读不到「答疑模式」预设'), text);
  assert.equal(text.includes('没有可用的模型'), false, '这不是「没有模型」，别说成没有模型');
});

/* ══ 八、选中的那一段：面板上看得见（可点开 / 可删掉的 chip 归 #106） ═════ */

test('#105 引用：选中的那一段与它的来源在面板上看得见', () => {
  const text = renderText(frame(), { quote: QUOTE });
  assert.ok(text.includes(SELECTION), '选中的那段没显示出来：' + text);
  assert.ok(text.includes('来源：小节「掩码」 · computer-networks/0003-net.mask.md'), text);
  // chip 那一层（点开看原文、删掉、进草稿、提交时送出去的是什么）归 #106：
  // `test_client_ask_chip.mjs` 守纯函数与调用序列，`browser/ask_quote_test.mjs` 守真鼠标那一条。
});

test('#105 入口：顶部有「新对话」与「上一段会话」', () => {
  const tree = renderTree(frame());
  assert.equal(findByProp(tree, 'data-proto', 'qa-new').length, 1);
  assert.equal(findByProp(tree, 'data-proto', 'qa-history').length, 1);
  const text = renderText(frame());
  assert.ok(text.includes('这条会话住在宿主里'), '没说明这段会话住在哪儿：' + text);
});
