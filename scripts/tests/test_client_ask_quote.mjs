/* 验收 #92 · 选中正文变成一条留得住的引用（阅读端 `lib/client.js`）
   ────────────────────────────────────────────────────────────────────────
   要钉住的是**捕获那一下的判据**与**面板拿这条引用做了什么**，两半各一条缝：

     · 捕获：`captureQuote(prev, 实时选区, 正文节点, 这一课的相对路径)` —— 读出一段合格的选区
       就冻结成 `{ text, anchor }`；**读不出就原样返回 prev**。这条缝是这张票的病根所在：
       document 级 `mouseup` 会在每一次点击后冒上来（点输入框、点面板别处、切 tab 都会让浏览器
       把文档选区折叠成空），原来的代码「判定失败就写空串」，于是学生一点输入框引用就没了。
       套件用**假 DOM**（`contains` / `data-section` / `querySelector('h2')` 三样与真 DOM 同判据）
       把各种读空的方式逐个喂进去，断言拿到的是**同一个对象**（不是内容相等：React 靠同引用跳过重渲染）。

     · 面板：`AskPanel` 渲染这条引用（原文 + 来源 + 一个「删掉」按钮），提交时随问题一起送出
       （`selection` + `selectionAnchor`），**提交成功才清掉**；没有引用时面板照样能问。
       面板本体在工厂闭包里（零构建、不加 export），靠 `fixtures/client_harness.mjs` 的 React 桩取出来。
       `fetch` 是本地假货——套件里不联网、更不调模型。数据现造现弃。

   真浏览器里的那一半（真鼠标拖拽 → 点输入框 → 引用仍在）在
   `scripts/tests/browser/ask_quote_test.mjs`：Node 里没有真选区，这一份只守判据与行为。
   ──────────────────────────────────────────────────────────────────────── */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { clientInternals, findByProp, renderWithState, setHookState, resetHookState } from './fixtures/client_harness.mjs';

const { AskPanel, ASK_ENDPOINT, captureQuote } = clientInternals();

/* ── 假 DOM：只造 `readQuote` 真的会碰的那几样 ───────────────────────────── */

/** 一个元素节点：`data-section` 是「这一节」的标记（真 DOM 里 section.smb-sec-block 就带它）。 */
function el({ id = '', section = null, title = null, text = null } = {}) {
  const node = {
    nodeType: 1,
    id,
    parentElement: null,
    textContent: text,
    getAttribute: (name) => (name === 'data-section' && section !== null ? String(section) : null),
    querySelector: (sel) => (sel === 'h2' ? node.__h2 : null),
  };
  if (title !== null) {
    // h2 是 section 的子节点，但**不在**起点的父链上（真 DOM 里起点在 h2 之后的段落里）
    node.__h2 = { nodeType: 1, textContent: title, parentElement: node, getAttribute: () => null, querySelector: () => null };
  }
  return node;
}

/**
 * 一棵假正文树：body → section[data-section] → p → 文本节点。
 * `contains` 与真 DOM 同判据（自己与后代算在内，别处的节点不算）。
 */
function fakeDoc() {
  const text = { nodeType: 3, parentElement: null, getAttribute: () => null, querySelector: () => null };
  const para = el();
  const section = el({ id: 'var-2', section: 1, title: '小结' });
  const body = el({ id: 'body' });
  const outside = el({ id: 'right-pane' });          // 右栏：选区落在面板里也要判成不合格

  text.parentElement = para;
  para.parentElement = section;
  section.parentElement = body;

  const inside = new Set([text, para, section, body, body.__h2].filter(Boolean));
  body.contains = (node) => inside.has(node);
  outside.parentElement = el({ id: 'root' });
  return { body, text, outside };
}

/** 假选区：`String(sel)` 走 toString，`getRangeAt(0).startContainer` 是起点——真 DOM 的读法。 */
function sel(text, start) {
  return { rangeCount: 1, toString: () => text, getRangeAt: () => ({ startContainer: start }) };
}

/** 点别处之后浏览器给的那一个：rangeCount 仍是 1，文本是空串（起点常在输入框里）。 */
const collapsed = (start) => sel('', start);

const LONG_ENOUGH = '掩码是按位与：100 与 192 逐位相与得 64。';
const LESSON = 'demo/1-变量.md';

/* ── 一、捕获：读不出合格的一段就**原样留着** ─────────────────────────────── */

test('#92 捕获：读到一段合格的选区就冻结成 { text, anchor }', () => {
  const { body, text } = fakeDoc();
  const quote = captureQuote(null, sel(LONG_ENOUGH, text), body, LESSON);

  assert.equal(quote.text, LONG_ENOUGH);
  // 来源锚点与文本一起在**捕获那一下**冻住：这一课在哪、落在哪一小节、小节叫什么
  assert.deepEqual(quote.anchor, { lesson: LESSON, section: 'var-2', sectionTitle: '小结' });
});

test('#92 捕获：文本两端空白不进引用（划到换行/缩进不该带进面板）', () => {
  const { body, text } = fakeDoc();
  const quote = captureQuote(null, sel('\n  ' + LONG_ENOUGH + '  \n', text), body, LESSON);
  assert.equal(quote.text, LONG_ENOUGH);
});

test('#92 捕获：读到空选区返回**同一个对象**（点输入框让浏览器折叠选区不该抹掉引用）', () => {
  const { body, text, outside } = fakeDoc();
  const frozen = captureQuote(null, sel(LONG_ENOUGH, text), body, LESSON);

  // 这一组就是「一次判定失败就把引用抹了」的全部触发方式，逐个喂
  const empty = [
    ['折叠成空串（起点还在正文里）', collapsed(text)],
    ['折叠成空串（起点落到面板里）', collapsed(outside)],
    ['真的没有 range', { rangeCount: 0, toString: () => '', getRangeAt: () => { throw new Error('没有 range'); } }],
    ['压根没有选区对象', null],
    ['一个字的误触', sel('好', text)],
    ['三个字，不到四个', sel('看不懂', text)],
    ['只有空白', sel('   \n  ', text)],
    ['选区落在正文之外（右栏面板里划的）', sel('这是面板里的一段话，够长了。', outside)],
  ];
  for (const [why, live] of empty) {
    assert.equal(captureQuote(frozen, live, body, LESSON), frozen, `这一种读空的方式把引用抹了：${why}`);
  }
});

test('#92 捕获：正文节点还没挂上（首帧）也不清引用', () => {
  const { body, text } = fakeDoc();
  const frozen = captureQuote(null, sel(LONG_ENOUGH, text), body, LESSON);
  assert.equal(captureQuote(frozen, sel(LONG_ENOUGH, text), null, LESSON), frozen);
});

test('#92 捕获：再从正文里划一段就换成新的那一段', () => {
  const { body, text } = fakeDoc();
  const first = captureQuote(null, sel(LONG_ENOUGH, text), body, LESSON);
  const second = captureQuote(first, sel('换一段重问：别名只是同一个值的两个名字。', text), body, LESSON);
  assert.notEqual(second, first, '划了新的一段却没换');
  assert.equal(second.text, '换一段重问：别名只是同一个值的两个名字。');
});

test('#92 捕获：模型还没就绪时的正文（没有小节归属）也留得下引用', () => {
  // 起点在 `<article>` 里、但不在任何 `section.smb-sec-block` 里（课件标题那一段）：
  // 小节那一格是空的，引用本身照样成立——别把它判成「没划中」
  const { body, text } = fakeDoc();
  const loose = { nodeType: 3, parentElement: body, getAttribute: () => null, querySelector: () => null };
  text.parentElement = loose;
  const quote = captureQuote(null, sel(LONG_ENOUGH, text), body, LESSON);
  assert.equal(quote.text, LONG_ENOUGH);
  assert.deepEqual(quote.anchor, { lesson: LESSON, section: '', sectionTitle: '' });
});

/* ── 二、面板：渲染这条引用 ──────────────────────────────────────────────── */

const SUBJECT = { slug: 'demo' };
const NODE = { id: '变量', title: '变量' };
const QUOTE = { text: LONG_ENOUGH, anchor: { lesson: LESSON, section: 'var-2', sectionTitle: '小结' } };

let cleared = 0;
const clearQuote = () => { cleared += 1; };

function render(state, props = {}) {
  return renderWithState(
    AskPanel,
    { subject: SUBJECT, node: NODE, quote: QUOTE, focusTick: 0, onQuoteClear: clearQuote, ...props },
    state,
  ).replace(/\s+/g, ' ').trim();
}

beforeEach(() => { cleared = 0; });

test('#92 面板：引用以「原文 + 来源 + 删掉」一条出现', () => {
  const text = render([]);
  assert.ok(text.includes(LONG_ENOUGH), '引用原文没渲染出来：' + text);
  assert.ok(text.includes('小结'), '引用来自哪一小节没写出来：' + text);
  assert.ok(text.includes('删掉'), '引用上没有可删的入口：' + text);
  assert.equal(text.includes('在正文里划一段'), false, '已经有引用了还在提示「划一段」');
});

test('#92 面板：没有引用时面板照样能用（提示划一段，输入框与「问一句」都在）', () => {
  const text = render([], { quote: null });
  assert.ok(text.includes('在正文里划一段'), '没有引用时没给提示：' + text);
  assert.equal(text.includes(LONG_ENOUGH), false, '没引用却渲染出了一段引用原文');
});

test('#92 面板：「删掉」真的走回调（清除只有学生显式删除与提交成功两处）', () => {
  resetHookState();
  try {
    const tree = AskPanel({ subject: SUBJECT, node: NODE, quote: QUOTE, focusTick: 0, onQuoteClear: clearQuote });
    const found = findByProp(tree, 'data-proto', 'qa-quote-clear');
    assert.equal(found.length, 1, '引用上应该恰好有一颗「删掉」按钮');
    found[0].props.onClick();
    assert.equal(cleared, 1, '点了「删掉」却没通知外面清引用');
  } finally {
    resetHookState();
  }
});

/* ── 三、面板：提交时随问题送出，成功才清 ────────────────────────────────── */

let calls = [];
let reply = null;
globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  return { ok: true, status: 200, json: async () => reply };
};

const QUESTION = '掩码怎么算？';

const OK_REPLY = {
  available: true,
  ok: true,
  model: { provider: 'fake-provider', model: 'fake-model' },
  answer: '掩码按位与：100 与 192 得 64。',
  misconception: { topic: '掩码怎么算', source: '问答面板', evidence: '提问原文：掩码怎么算？', status: '未处理', at: '2026-10-05' },
  write: { ok: true, version: 'v1', replayed: false },
};

const UNAVAILABLE_REPLY = {
  available: false,
  ok: false,
  reason: '宿主里一个模型 provider 都没注册',
  error: { code: 'model-unavailable', message: '宿主里一个模型 provider 都没注册' },
};

/** 取出「问一句」那颗按钮的 onClick 并点它（元素树是桩造的，只能这样找）。 */
function clickAsk(props = {}, question = QUESTION) {
  // 先 reset 再喂：桩的 hook 游标是**模块级**的，直接调 `AskPanel(...)` 会把它留在上一次的
  // 位置（`resetHookState` 才归零），那时 `setHookState` 喂的帧落在错误的槽上——症状是
  // 问题成了空串、`ask()` 早退，看起来像「面板没发请求」。
  resetHookState();
  setHookState([question, null, false]);
  try {
    const tree = AskPanel({ subject: SUBJECT, node: NODE, quote: QUOTE, focusTick: 0, onQuoteClear: clearQuote, ...props });
    const found = findByProp(tree, 'data-proto', 'qa-ask');
    assert.equal(found.length, 1, '面板里应该恰好有一颗「问一句」按钮');
    return found[0].props.onClick;
  } finally {
    resetHookState();
  }
}

beforeEach(() => { calls = []; reply = null; });

test('#92 提交：问题带着这条引用（原文 + 来源锚点）一起送出去', async () => {
  reply = OK_REPLY;
  await clickAsk()();

  assert.equal(calls.length, 1, '面板没有发请求');
  assert.equal(calls[0].url, ASK_ENDPOINT);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.selection, LONG_ENOUGH, '送出去的引用原文不对：' + body.selection);
  assert.deepEqual(body.selectionAnchor, { lesson: LESSON, section: 'var-2', sectionTitle: '小结' },
    '送出去的来源锚点不对：' + JSON.stringify(body.selectionAnchor));
  assert.equal(body.question, QUESTION);
  // 面板**不背会话**：请求体里仍然只有那几样
  for (const forbidden of ['messages', 'history', 'sessionId', 'conversation']) {
    assert.equal(Object.hasOwn(body, forbidden), false, `请求体里出现了 ${forbidden}`);
  }
});

test('#92 提交：没有引用时请求体里就没有引用这两格（面板照样能问）', async () => {
  reply = OK_REPLY;
  await clickAsk({ quote: null })();

  const body = JSON.parse(calls[0].options.body);
  assert.equal(Object.hasOwn(body, 'selection'), true, '没有引用时也该有 selection 那一格（空串）');
  assert.equal(body.selection, '');
  assert.equal(Object.hasOwn(body, 'selectionAnchor'), false, '没有引用却带了一个来源锚点');
});

test('#92 提交：答成了才清引用（引用确实落进了误解记录）', async () => {
  reply = OK_REPLY;
  await clickAsk()();
  assert.equal(cleared, 1, '提交成功却没清引用');
});

test('#92 提交：没有可用模型时如实说明，且**不清**引用（学生配好模型再问一次）', async () => {
  reply = UNAVAILABLE_REPLY;
  await clickAsk()();
  assert.equal(cleared, 0, '这一次没有回答、也没有落误解记录，却把引用清了');
  const text = render([QUESTION, UNAVAILABLE_REPLY, false]);
  assert.ok(text.includes('没有可用的模型'), '没有可用模型时没给如实的说明：' + text);
});
