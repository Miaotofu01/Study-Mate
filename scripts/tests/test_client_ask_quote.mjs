/* 验收 #92 · 选中正文变成一条留得住的引用：**捕获那一下的判据**（阅读端 `lib/client.js`）
   ────────────────────────────────────────────────────────────────────────
   `captureQuote(prev, 实时选区, 正文节点, 这一课的相对路径)`：读出一段合格的选区就冻结成
   `{ text, anchor }`；**读不出就原样返回 prev**。这条判据是 #92 的病根所在——document 级
   `mouseup` 会在每一次点击后冒上来（点输入框、点面板别处、切 tab 都会让浏览器把文档选区折叠
   成空），原来的代码「判定失败就写空串」，于是学生一点输入框引用就没了。

   套件用**假 DOM**（`contains` / `data-section` / `querySelector('h2')` 三样与真 DOM 同判据）
   把各种读空的方式逐个喂进去，断言拿到的是**同一个对象**（不是内容相等：React 靠同引用跳过重渲染）。

   这条引用的**下游**两票各自守：
     · 面板上那条只读展示、以及「面板不再自己调模型、改成嵌宿主会话」→ `test_client_ask_panel.mjs`（#105）；
     · 可点开、可删掉、只跟下一条消息走的**引用 chip** → #106（挂在宿主输入框上方）。
   这里只留捕获那一半：它是纯函数，与面板长什么样无关，不该跟着一起退役。
   数据现造现弃。
   ──────────────────────────────────────────────────────────────────────── */
import test from 'node:test';
import assert from 'node:assert/strict';

import { clientInternals } from './fixtures/client_harness.mjs';

const { captureQuote } = clientInternals();

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
