/* 验收 #79 · 问答面板接上模型（阅读端 `lib/client.js`）
   ────────────────────────────────────────────────────────────────────────
   面板原来是 `setTimeout(240ms)` + 一段硬编码的假回答（界面还标着「尚未接模型」）。这个套件
   钉住**换成真调用之后**的三件事：

     1. 点「问一句」真的发 `POST /api/studymate/ask`，请求体里只有那几样（subject / node /
        selection / selectionAnchor / question / operationId）——**没有会话**；
     2. 回答与那条误解记录按 Host 半的回执渲染出来，不再有「尚未接模型」与「会记一条」；
     3. 没有可用模型时如实说明，并且**一个字的回答都不编**。

   面板本体在 `lib/client.js` 的工厂闭包里（零构建、不加 export），靠
   `fixtures/client_harness.mjs` 的 React 桩取出来。`fetch` 是本地假货——套件里不联网、
   更不调模型。数据现造现弃。
   ──────────────────────────────────────────────────────────────────────── */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { clientInternals, findByProp, renderWithState, setHookState, resetHookState } from './fixtures/client_harness.mjs';

const { AskPanel, ASK_ENDPOINT } = clientInternals();

/** 假 fetch：记下每一次调用，按脚本给回执。 */
let calls = [];
let reply = null;
globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  const payload = reply;
  return { ok: true, status: 200, json: async () => payload };
};

beforeEach(() => { calls = []; reply = null; });

const SUBJECT = { slug: 'computer-networks', misconception_version: 'v1' };
const NODE = { id: 'net.mask', title: '子网与掩码' };
const SELECTION = '掩码是按位与：100 与 192 逐位相与得 64。';
// #92：面板拿到的是一条**冻好的引用**（文本 + 来源锚点），不是一个跟着实时选区跑的字符串。
// 这一份套件是 #79 的验收面（面板接模型），所以只按新形状喂进去；「读到空不清引用」「提交
// 才清」那些判据归 test_client_ask_quote.mjs。
const QUOTE = { text: SELECTION, anchor: { lesson: 'computer-networks/0003-net.mask.md', section: 'mask-2', sectionTitle: '掩码' } };
const QUESTION = '掩码怎么算？';

const OK_REPLY = {
  available: true,
  ok: true,
  model: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  answer: '掩码按位与：100 与 192 得 64，所以网络地址是 192.168.1.64。',
  misconception: {
    topic: '掩码怎么算', source: '问答面板',
    evidence: '提问原文：掩码怎么算？\n回答摘要：掩码按位与算出网络地址\n位置：computer-networks/0003-net.mask.md',
    status: '未处理', at: '2026-10-05',
  },
  write: { ok: true, version: 'abc123', replayed: false },
};

const UNAVAILABLE_REPLY = {
  available: false,
  ok: false,
  reason: '宿主里一个模型 provider 都没注册（adapter 没挂上）——要模型的能力这次不跑',
  error: { code: 'model-unavailable', message: '宿主里一个模型 provider 都没注册（adapter 没挂上）——要模型的能力这次不跑' },
};

/** 把面板渲染成文本（把 useState 驱到某一帧）。 */
function render(state) {
  return renderWithState(AskPanel, { subject: SUBJECT, node: NODE, quote: QUOTE, focusTick: 1 }, state)
    .replace(/\s+/g, ' ').trim();
}

/**
 * 取出「问一句」那颗按钮的 onClick 并点它（元素树是桩造的，只能这样找）。
 *
 * 必须先把 `question` 那一帧喂进去：桩的 `useState` 按调用次序取值，不喂就是空串，
 * 而面板对空问题直接 return（连 fetch 都不会发）——套件会误判成「面板没接上模型」。
 * 点完立刻把钩子清掉，别给后面的渲染留痕。
 */
function clickAsk(question = QUESTION) {
  setHookState([question, null, false]);
  try {
    const tree = AskPanel({ subject: SUBJECT, node: NODE, quote: QUOTE, focusTick: 1 });
    const found = findByProp(tree, 'data-proto', 'qa-ask');
    assert.equal(found.length, 1, '面板里应该恰好有一颗「问一句」按钮');
    return found[0].props.onClick;
  } finally {
    resetHookState();
  }
}

test('#79 面板：点「问一句」真的发 POST，请求体只有那几样', async () => {
  reply = OK_REPLY;
  await clickAsk()();

  assert.equal(calls.length, 1, '面板没有发请求（还是那段假回答）');
  assert.equal(calls[0].url, ASK_ENDPOINT);
  assert.equal(calls[0].url, '/api/studymate/ask');
  assert.equal(calls[0].options.method, 'POST');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ['node', 'operationId', 'question', 'selection', 'selectionAnchor', 'subject']);
  assert.equal(body.subject, 'computer-networks');
  assert.equal(body.node, 'net.mask');
  assert.equal(body.selection, SELECTION);
  // #92：引用不是光有原文——来源锚点（哪一课、哪一小节）也随问题一起送出去
  assert.deepEqual(body.selectionAnchor, QUOTE.anchor);
  assert.equal(body.question, QUESTION);
  assert.match(body.operationId, /^ask-/);
  // 面板**不背会话**：请求体里没有 messages / history / sessionId 这类东西
  for (const forbidden of ['messages', 'history', 'sessionId', 'conversation']) {
    assert.equal(Object.hasOwn(body, forbidden), false, `请求体里出现了 ${forbidden}`);
  }
  // 也不带 expectedVersion：这份文件是「只追加」的，而快照里的版本号随时会过期——
  // 带上它只会在总控刚写过之后把面板这一笔挡掉（理由见 client.js 那处注释）
  assert.equal(Object.hasOwn(body, 'expectedVersion'), false);
});

test('#79 面板：回答与那条误解记录按回执渲染，承诺不再是空头支票', () => {
  const text = render([QUESTION, OK_REPLY, false]);
  assert.ok(text.includes(OK_REPLY.answer), '回答没渲染出来：' + text);
  assert.ok(text.includes('已记一条误解记录'), '没说明记录已经写下去了：' + text);
  assert.ok(text.includes('topic「掩码怎么算」'), '没显示 topic：' + text);
  assert.ok(text.includes('source 问答面板'), '没显示 source：' + text);
  assert.ok(text.includes('status 未处理'), '没显示 status：' + text);
  assert.ok(text.includes('at 2026-10-05'), '没显示 at：' + text);
  assert.ok(text.includes('总控下次开场读得到'), '没说明这条记录下次开场读得到');
  // 旧文案与旧承诺都不该再出现
  assert.equal(text.includes('尚未接模型'), false, '徽标还是「尚未接模型」');
  assert.equal(text.includes('会记一条误解记录'), false, '还是「会记」（未实现的承诺）');
  assert.equal(text.includes('问答面板还没有接上模型'), false, '假回答还在');
  assert.ok(text.includes('模型 deepseek-v4.1-flash'), '没显示用的是哪个模型：' + text);
});

test('#79 面板：没有可用模型时如实说明，不编回答、不说已记录', () => {
  const text = render([QUESTION, UNAVAILABLE_REPLY, false]);
  assert.ok(text.includes('这条链路上没有可用的模型'), '没如实说明没有模型：' + text);
  assert.ok(text.includes('adapter 没挂上'), '没把 reason 带出来：' + text);
  assert.ok(text.includes('没有写误解记录'), '没说明这次不写记录：' + text);
  assert.equal(text.includes('已记一条误解记录'), false, '没有模型却说记了误解记录');
  assert.equal(text.includes('没有可用模型'), true);
});

test('#79 面板：有模型但没答成时，说清「回答没拿到，所以没写记录」', () => {
  const text = render([QUESTION, { available: true, ok: false, error: { code: 'model-error', message: '模型没答上来：provider 402 余额不足' } }, false]);
  assert.ok(text.includes('这次没答上来'), text);
  assert.ok(text.includes('余额不足'), text);
  assert.ok(text.includes('没有写误解记录'), text);
  assert.equal(text.includes('已记一条误解记录'), false);
});

test('#79 面板：回答拿到了但写盘失败时，两件事分开报（回答不跟着丢）', () => {
  const text = render([QUESTION, {
    ...OK_REPLY,
    write: { ok: false, error: 'version-conflict', message: '误解记录已经变了：版本号对不上，这次不写' },
  }, false]);
  assert.ok(text.includes(OK_REPLY.answer), '回答被写盘失败一起吞掉了');
  assert.ok(text.includes('回答拿到了，但误解记录没写进去'), text);
  assert.ok(text.includes('版本号对不上'), text);
  assert.equal(text.includes('已记一条误解记录'), false, '写盘失败却说记下了');
});

test('#79 面板：输入框空着时按钮是禁用的（不会拿空问题去花一次调用）', () => {
  const tree = AskPanel({ subject: SUBJECT, node: NODE, quote: QUOTE, focusTick: 0 });
  const found = findByProp(tree, 'data-proto', 'qa-ask');
  assert.equal(found.length, 1);
  assert.equal(found[0].props.disabled, true, '空问题也能点');
});

test('#79 面板：选中那段照旧显示，提示语说明了「不经过总控、回答不进会话记录」', () => {
  const text = render([]);
  assert.ok(text.includes(SELECTION), '选中的那段没显示');
  assert.ok(text.includes('不经过总控'), text);
  assert.ok(text.includes('回答不进会话记录'), text);
});
