/* 问答面板的引用（#92）：真浏览器 + 真鼠标拖拽。
   ────────────────────────────────────────────────────────────────────────────────
   这条票要的是「选中正文 → 打开问答 → 点输入框/打字/切 tab 之后引用仍在」。**只有真浏览器
   能验**：Node 里没有真选区，而毛病恰恰出在「document 级 mouseup 读实时选区、判定失败就清空」——
   点输入框会让浏览器把文档选区折叠成空，那一次 mouseup 又冒到同一个监听上。

   所以这一条不搭假 DOM：真 `lib/client.js` + `fixtures/mini-react.js` + 宿主 token + 现抠的
   内联 CSS（与 reading_test.mjs / reading_routes_test.mjs 同一套夹具），鼠标动作走 CDP 的
   `Input.dispatchMouseEvent`——`session.send` 能直接下发，harness 里没有选区/拖拽助手，
   这里自己补一个 dragSelect（按下 → 挪几步 → 抬起）与 clickAt。

   取景要先把右栏打开：面板只在右栏开着「问答」tab 时才存在（选中之后的浮动胶囊
   `[data-proto="qa-chip"]` 会自己把它打开，那条路本身也在用例里）。

   口径（别顺手改回去）：
     · 断言只到「这条引用还在不在、送出去的是什么」这一层。**不钉引用原文的每一个字**：
       拖拽落点由浏览器定，套件不该猜它——断的是「面板显示的那一条 === POST 里送出去的那一条」，
       以及它确实是正文里的一段。
     · `/api/studymate/ask` 是夹具里的假货（记录请求体 + 回一份固定回执）：这里验的是**面板
       送出了什么**，真模型那条链路在 test_host_ask_route.mjs（假 llm，不花额度）。
     · 截图与 summary.json 落在 `.shots/ask-quote/`。

   浏览器二进制由 harness 探测；找不到时明确跳过（退出码 3），不是静默绿。
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readLibrary } from '../../../lib/library.ts';
import { extractCss } from '../fixtures/client-css.mjs';
import { openSession, finishSuite } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

let failures = 0;
function check(label, ok, detail = '') {
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}

/* ── 临时工作区：跑完即弃 ──────────────────────────────────────────────── */

const TEMPS = [];

/** 一份最小科目树。取景主角是「变量」那一课：两个小节，第一节里有一段够长的正文可以划。 */
function subjectFiles() {
  return {
    '.learning/subjects/demo/subject.yaml': [
      'slug: demo', 'name: 演示科目', 'goal: 在真浏览器里验问答引用', 'status: 学习中',
      'created_at: "2026-01-02T03:04:05+08:00"', '',
    ].join('\n'),
    '.learning/subjects/demo/curriculum.yaml': [
      'nodes:',
      '  - id: 变量', '    title: 变量', '    kind: 概念', '    objective: 说清变量是什么',
      '    status: 学习中', '',
    ].join('\n'),
    '.learning/subjects/demo/progress.yaml': [
      'updated_at: "2026-05-06T07:08:09+08:00"',
      'nodes:', '  变量:', '    status: 学习中', '',
    ].join('\n'),
    // 两个小节：引用要认出它落在哪一节（「来源：小节「绑定」」），所以第二小节是必要的
    '.learning/subjects/demo/lessons/1-变量.md': [
      '# 变量', '',
      '## 绑定', '',
      '变量是名字指向值：写了 const a = 1 之后，a 这个名字就指向 1，改 a 不会改到别的绑定；'
      + '别名只是同一个值的两个名字，不是把值复制一份。', '',
      '## 小结', '',
      '绑定是名字与值的对应，不是把值装进盒子里。', '',
    ].join('\n'),
    '.learning/subjects/demo/MISSION.md': '# 使命\n\n## Why\n\n因为要在浏览器里验。\n',
    '.learning/subjects/demo/GLOSSARY.md': '## 基础\n\n**绑定**: 名字指向值\n',
    '.learning/subjects/demo/RESOURCES.md': '# 资源\n\n- 《入门》\n',
    '.learning/subjects/demo/misconceptions.yaml': '[]\n',
  };
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-askquote-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(path.join(workspace, '.learning'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.learning', 'MEMORY.md'), '# 共享记忆\n');
  for (const [rel, content] of Object.entries(subjectFiles())) {
    const file = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { root, workspace };
}

/* ── 夹具页 ────────────────────────────────────────────────────────────── */

/** 宿主 token 的两块（亮/暗）原样铺开，让 --dsw-alias-* 在夹具里和真宿主一样能解。 */
function hostTokenCss() {
  const snapshot = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'host-theme-tokens.json'), 'utf8'));
  const block = (table) => Object.entries(table).map(([name, value]) => `${name}:${value}`).join(';');
  return [
    `body{${block(snapshot.light)}}`,
    `body[data-ds-dark-theme]{${block(snapshot.dark)}}`,
    'body{background-color:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
  ].join('\n');
}

/** 面板默认拿到的那份回执（套件可以在场景里换掉它，见 `SET_REPLY`）。 */
const OK_REPLY = {
  available: true,
  ok: true,
  model: { provider: 'fixture-provider', model: 'fixture-model' },
  answer: '别名与绑定是一回事：名字指向同一个值，不是复制。',
  misconception: {
    topic: '为什么别名不是复制', source: '问答面板',
    evidence: '提问原文：为什么别名不是复制？\n回答摘要：名字指向同一个值\n引用：…\n位置：demo/1-变量.md · 小节「绑定」',
    status: '未处理', at: '2026-10-05',
  },
  write: { ok: true, version: 'fixture-v1', replayed: false },
};

function buildFixture(dir, payload) {
  const css = extractCss(fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8'));
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>StudyMate 问答引用 QA 夹具</title>
<style>
  html, body { margin: 0; height: 100%; }
  #root { height: 100%; }
  ${hostTokenCss()}
</style>
<style id="plugin-css">${css}</style>
<script>
  // 阅读端的宿主契约：window.__ModuleLoader__.load({id, factory})，factory 只 require('react')
  window.__StudymateSpec = null;
  window.__ModuleLoader__ = { load: function (spec) { window.__StudymateSpec = spec; } };
  window.__Payload = ${json};
  // 问答那条路由的替身：把每一次 POST 的请求体原样记下来（套件据此断言「送出去的是什么」），
  // 回一份现成的回执。真模型那条链路不在这一条套件的验收面上。
  window.__ASK = { calls: [], reply: ${JSON.stringify(OK_REPLY)} };
  window.fetch = function (url, options) {
    var target = String(url);
    if (target.indexOf('/api/studymate/library') === 0) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(window.__Payload); } });
    }
    if (target.indexOf('/api/studymate/ask') === 0) {
      window.__ASK.calls.push({ url: target, method: (options && options.method) || 'GET', body: (options && options.body) || '' });
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(window.__ASK.reply); } });
    }
    return Promise.resolve({
      ok: false, status: 404,
      json: function () { return Promise.resolve({ error: '夹具没有这条接口：' + target }); },
    });
  };
  // 变更推送（#74）：夹具页走 file://，那条请求只会被拦掉、变成一条「失败请求」。
  // lib/client.js 认这个早退（typeof EventSource !== 'function' 就不订阅）。
  window.EventSource = undefined;
  /* mini-react 每次重渲染都**整树重建 DOM**（不 diff），把节点闭在 effect 里、之后还去量它的
     代码在夹具里量到的是已经被换掉的旧节点：LessonPage 的 ResizeObserver 量画布宽，旧节点一
     脱离文档就报 0，画布宽被写成 0，右栏永远打不开——而这条套件全靠右栏。真 React 里节点不换，
     那段代码本身是对的（同一条夹具边界 reading_routes_test.mjs 已经记过一次）。这里换成
     「observe 时同步报一次真实尺寸、之后不再报」：一次场景里窗口尺寸不会变。 */
  window.ResizeObserver = function (callback) {
    this.observe = function (target) {
      callback([{ target: target, contentRect: target.getBoundingClientRect() }], this);
    };
    this.unobserve = function () {};
    this.disconnect = function () {};
  };
</script>
</head>
<body>
<div id="root"></div>
<script src="${pathToFileURL(path.join(HERE, '..', 'fixtures', 'mini-react.js')).href}"></script>
<script src="${pathToFileURL(path.join(ROOT, 'lib', 'client.js')).href}"></script>
<script>
  (function () {
    var spec = window.__StudymateSpec;
    if (!spec) throw new Error('lib/client.js 没有向 window.__ModuleLoader__ 登记');
    var mod = spec.factory(function (name) { return name === 'react' ? window.MiniReact : undefined; });
    var Main = null;
    mod.apply({
      slots: {
        inject: function (seat, callback) { callback(); },
        register: function (options, component) {
          if (options && options.name === 'main') Main = component;
        },
      },
    });
    if (!Main) throw new Error('没有从 main 座位拿到组件');
    window.MiniReact.mount(window.MiniReact.createElement(Main, null), document.getElementById('root'));
  }());
</script>
</body>
</html>
`;
  const file = path.join(dir, 'ask-quote-fixture.html');
  fs.writeFileSync(file, html);
  return pathToFileURL(file).href;
}

/* ── 页面里的探针与几步操作 ────────────────────────────────────────────── */

const HELPERS = `
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const text = (sel) => { const el = q(sel); return el ? el.textContent.trim() : null; };
`;

/** 选中之后每一步都读这一份：引用还在不在、输入框里是什么、发出去过什么。 */
const ASK_PROBE = `(() => {
  ${HELPERS}
  const quote = q('[data-proto="qa-quote"]');
  const quoteText = quote ? quote.querySelector('.smb-quote__text') : null;
  const quoteWhere = quote ? quote.querySelector('.smb-quote__where') : null;
  const panel = q('.smb-askbody');
  const last = (window.__ASK.calls || []).slice(-1)[0] || null;
  return {
    panelOpen: !!panel,
    panelText: panel ? panel.innerText : null,
    tabAsk: q('[data-proto="tab-ask"]') ? q('[data-proto="tab-ask"]').getAttribute('aria-selected') : null,
    chip: text('[data-proto="qa-chip"]'),
    quoteText: quoteText ? quoteText.textContent : null,
    quoteWhere: quoteWhere ? quoteWhere.textContent : null,
    drop: !!q('[data-proto="qa-quote-clear"]'),
    inputValue: q('[data-proto="qa-input"]') ? q('[data-proto="qa-input"]').value : null,
    askCalls: (window.__ASK.calls || []).length,
    lastAsk: last,
    liveSelection: String(window.getSelection()),
  };
})()`;

/**
 * 挑一段够长的正文段落，把它前 40 个字的位置量出来（给真鼠标拖拽用）。
 *
 * 量的是 `Range.getClientRects()`——文字**真正**画在哪，不是段落盒子的矩形：段落有内边距，
 * 按盒子中心按下去可能落在空白上，选不出任何字。滚动用 `behavior:'instant'`：正文滚动区带
 * `scroll-behavior: smooth`，平滑滚动会让这里的 rect 与之后的鼠标动作对不上。
 */
const SELECT_TARGET = `(() => {
  const art = document.querySelector('article.smb-doc');
  if (!art) return null;
  const paras = Array.from(art.querySelectorAll('.smb-sec-block p'));
  const pick = paras.find((p) => (p.textContent || '').trim().length >= 24);
  if (!pick) return null;
  pick.scrollIntoView({ block: 'center', behavior: 'instant' });
  const walker = document.createTreeWalker(pick, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && node.nodeValue.trim().length < 12) node = walker.nextNode();
  if (!node) return null;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, Math.min(node.nodeValue.length, 40));
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
  if (!rects.length) return null;
  const first = rects[0];
  const last = rects[rects.length - 1];
  return {
    text: range.toString(),
    lines: rects.length,
    section: (pick.closest('.smb-sec-block') || {}).id || '',
    from: { x: Math.round(first.left) + 1, y: Math.round(first.top + first.height / 2) },
    to: { x: Math.round(last.right) - 1, y: Math.round(last.top + last.height / 2) },
  };
})()`;

/** 点某个元素的**正中间**：坐标取自页面里的实测矩形（视口 CSS 像素，与 CDP 同一套）。 */
function clickSelector(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('要点的元素不在：' + ${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;
}

/** 往问答输入框里打字：mini-react 把 onChange 直连成 change 监听，所以设值后派发 change。 */
function typeQuestion(value) {
  return `(() => {
    const input = document.querySelector('[data-proto="qa-input"]');
    if (!input) throw new Error('问答输入框不在');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`;
}

const OPEN_SUBJECT = `(() => {
  const cards = Array.from(document.querySelectorAll('[data-proto="nav-subject"]'));
  (cards.find((el) => el.textContent.includes('演示科目')) || cards[0]).click();
})()`;

const OPEN_LESSON = `(() => {
  const cards = Array.from(document.querySelectorAll('[data-proto="open-node"]'));
  (cards.find((el) => el.textContent.includes('变量')) || cards[0]).click();
})()`;

/** 换掉夹具那份回执：没有可用模型那一场用它。 */
function setReply(reply) {
  return `(() => { window.__ASK.reply = ${JSON.stringify(reply)}; return true; })()`;
}

/* ── 真鼠标 ────────────────────────────────────────────────────────────── */

/** 点一下：按下 → 抬起。`mouseup` 是这条套件的关键——客户端的捕获监听就挂在它上面。 */
async function clickAt(session, point) {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
  await session.sleep(200);
}

/** 真拖拽划词：按下 → 分几步挪过去 → 抬起。几步是必要的，一步到位浏览器不认成划选。 */
async function dragSelect(session, target) {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.from.x, y: target.from.y, button: 'left', buttons: 1, clickCount: 1 });
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(target.from.x + (target.to.x - target.from.x) * (i / steps)),
      y: Math.round(target.from.y + (target.to.y - target.from.y) * (i / steps)),
      button: 'left', buttons: 1,
    });
    await session.sleep(25);
  }
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.to.x, y: target.to.y, button: 'left', buttons: 0, clickCount: 1 });
  await session.sleep(250);
}

/* ── 跑 ────────────────────────────────────────────────────────────────── */

const session = await openSession({ suite: 'ask-quote', width: 1440, height: 960 });

/** 首页 → 科目页 → 课件页。每个场景都从头走一遍，场景之间不带上一步的状态。 */
async function openLesson(ctx) {
  await ctx.navigate(fixture, { settle: 1200 });
  await ctx.evaluate(OPEN_SUBJECT);
  await ctx.sleep(300);
  await ctx.evaluate(OPEN_LESSON);
  await ctx.sleep(400);
}

/** 划一段正文并断言浮动胶囊浮出来了（捕获真的读到了）。返回拖拽的读数。 */
async function selectParagraph(ctx, tag) {
  const target = await ctx.evaluate(SELECT_TARGET);
  check(`${tag} 取到了要划的那一段正文（够四个字、位置量得出来）`,
    !!target && target.text.trim().length >= 8, JSON.stringify(target));
  if (!target) return null;
  await dragSelect(session, target);
  const seen = await ctx.evaluate(ASK_PROBE);
  check(`${tag} 真鼠标划完正文后浮出「就这段问一句」`,
    seen.chip === '就这段问一句', `chip=${JSON.stringify(seen.chip)} live=${JSON.stringify(seen.liveSelection)}`);
  return target;
}

/** 「问一句」那颗按钮点了之后等回执渲染完。 */
async function askOnce(ctx, question = '为什么别名不是复制？') {
  await ctx.evaluate(typeQuestion(question));
  await ctx.sleep(200);
  await ctx.evaluate(`document.querySelector('[data-proto="qa-ask"]').click()`);
  await ctx.sleep(500);
}

let fixture = null;
try {
  const { root, workspace } = makeWorkspace();
  const payload = readLibrary({ workspace });
  fixture = buildFixture(root, payload);
  console.log(`夹具：${fixture}`);
  console.log(`数据：${workspace}（跑完删）`);

  /* ── 一、选中 → 打开问答 → 点输入框/打字/切 tab 之后引用仍在（这条票的主用例）── */
  await session.scene('ask-quote-keep', async (ctx) => {
    await openLesson(ctx);
    const target = await selectParagraph(ctx, '[选中]');
    if (!target) return { failed: '没有可以划的正文段落' };

    // 浮动胶囊 → 右栏滑出并停在「问答」
    await ctx.evaluate(`document.querySelector('[data-proto="qa-chip"]').click()`);
    await ctx.sleep(400);
    const opened = await ctx.evaluate(ASK_PROBE);
    check('[选中] 点胶囊后问答面板带着一条引用出现',
      opened.panelOpen && !!opened.quoteText && opened.drop,
      `open=${opened.panelOpen} quote=${JSON.stringify(opened.quoteText)} drop=${opened.drop}`);
    check('[选中] 引用写着它的来源小节（捕获那一下冻住的锚点）',
      /小节「绑定」/.test(String(opened.quoteWhere)), String(opened.quoteWhere));
    check('[选中] 引用原文确实是正文里的一段',
      !!opened.quoteText && payload.subjects[0].nodes[0].lesson_md.includes(opened.quoteText.trim()),
      JSON.stringify(opened.quoteText));

    // ① 点输入框：真鼠标点 → mouseup → 浏览器把文档选区折叠成空。这正是原来的病根。
    await clickAt(session, await ctx.evaluate(clickSelector('[data-proto="qa-input"]')));
    const afterClick = await ctx.evaluate(ASK_PROBE);
    check('[选中] 点输入框之后引用仍在（病根：读到空选区不得清已存在的引用）',
      afterClick.quoteText === opened.quoteText && afterClick.drop,
      `quote=${JSON.stringify(afterClick.quoteText)} live=${JSON.stringify(afterClick.liveSelection)}`);

    // ② 打字
    await ctx.evaluate(typeQuestion('为什么别名不是复制？'));
    await ctx.sleep(200);
    const afterType = await ctx.evaluate(ASK_PROBE);
    check('[选中] 打字之后引用仍在',
      afterType.quoteText === opened.quoteText && afterType.inputValue === '为什么别名不是复制？',
      `quote=${JSON.stringify(afterType.quoteText)} input=${JSON.stringify(afterType.inputValue)}`);

    // ③ 切走 tab 再切回来（面板会被卸载重挂：引用住在面板外面，所以不该丢）
    await ctx.evaluate(`document.querySelector('[data-proto="tab-quiz"]').click()`);
    await ctx.sleep(300);
    const onQuiz = await ctx.evaluate(ASK_PROBE);
    check('[选中] 切到「题目」tab 后面板换了一面', onQuiz.panelOpen === false, JSON.stringify(onQuiz.panelOpen));
    await ctx.evaluate(`document.querySelector('[data-proto="tab-ask"]').click()`);
    await ctx.sleep(300);
    const back = await ctx.evaluate(ASK_PROBE);
    check('[选中] 切回「问答」tab 之后引用仍在',
      back.quoteText === opened.quoteText && back.inputValue === '为什么别名不是复制？',
      `quote=${JSON.stringify(back.quoteText)} input=${JSON.stringify(back.inputValue)}`);

    // ④ 提交：引用随问题一起送出去，成功后清掉
    await ctx.evaluate(`document.querySelector('[data-proto="qa-ask"]').click()`);
    await ctx.sleep(500);
    const sent = await ctx.evaluate(ASK_PROBE);
    check('[选中] 提交真的发出了请求', sent.askCalls === 1, `askCalls=${sent.askCalls}`);
    const body = sent.lastAsk ? JSON.parse(sent.lastAsk.body) : {};
    check('[选中] 送出去的就是面板上那一条引用',
      body.selection === opened.quoteText,
      `sent=${JSON.stringify(body.selection)} shown=${JSON.stringify(opened.quoteText)}`);
    check('[选中] 引用带着来源锚点（哪一课、哪一小节）',
      !!body.selectionAnchor && body.selectionAnchor.lesson === 'demo/1-变量.md'
      && body.selectionAnchor.section === target.section && body.selectionAnchor.sectionTitle === '绑定',
      JSON.stringify(body.selectionAnchor));
    check('[选中] 提交成功后引用清掉（面板回到「划一段」的提示）',
      sent.quoteText === null && /在正文里划一段/.test(String(sent.panelText)),
      `quote=${JSON.stringify(sent.quoteText)}`);
    check('[选中] 回答与那条误解记录按回执渲染出来',
      /已记一条误解记录/.test(String(sent.panelText)) && /fixture-model/.test(String(sent.panelText)),
      String(sent.panelText).slice(0, 120));

    return {
      dragged: target.text, lines: target.lines, section: target.section,
      quoteShown: opened.quoteText, quoteWhere: opened.quoteWhere,
      quoteKeptAfterClick: afterClick.quoteText === opened.quoteText,
      quoteKeptAfterTyping: afterType.quoteText === opened.quoteText,
      quoteKeptAfterTabSwitch: back.quoteText === opened.quoteText,
      liveSelectionAtClick: afterClick.liveSelection,
      sentBody: body,
    };
  });

  /* ── 二、显式删除：清除的另一处 ──────────────────────────────────────── */
  await session.scene('ask-quote-drop', async (ctx) => {
    await openLesson(ctx);
    const target = await selectParagraph(ctx, '[删掉]');
    if (!target) return { failed: '没有可以划的正文段落' };
    await ctx.evaluate(`document.querySelector('[data-proto="qa-chip"]').click()`);
    await ctx.sleep(400);
    const opened = await ctx.evaluate(ASK_PROBE);

    await clickAt(session, await ctx.evaluate(clickSelector('[data-proto="qa-quote-clear"]')));
    const dropped = await ctx.evaluate(ASK_PROBE);
    check('[删掉] 点「删掉」之后引用没了、提示回来了',
      dropped.quoteText === null && /在正文里划一段/.test(String(dropped.panelText)),
      `quote=${JSON.stringify(dropped.quoteText)}`);

    // 删掉之后照样能提问：请求体里没有引用这两格
    await askOnce(ctx, '那绑定到底是什么？');
    const asked = await ctx.evaluate(ASK_PROBE);
    const body = asked.lastAsk ? JSON.parse(asked.lastAsk.body) : {};
    check('[删掉] 没有引用时照样问得出去，且请求体里不带引用',
      asked.askCalls === 1 && body.selection === '' && !Object.hasOwn(body, 'selectionAnchor'),
      JSON.stringify(body));

    return { dragged: target.text, quoteBeforeDrop: opened.quoteText, sentBody: body };
  });

  /* ── 三、从头就没有引用：面板照样能用 ────────────────────────────────── */
  await session.scene('ask-quote-blank', async (ctx) => {
    await openLesson(ctx);
    // 不划词，直接从右栏的窄轨打开「问答」
    await ctx.evaluate(`document.querySelector('[data-proto="toggle-ask"]').click()`);
    await ctx.sleep(400);
    const opened = await ctx.evaluate(ASK_PROBE);
    check('[无引用] 没划词时面板照样打得开、给的是「划一段」的提示',
      opened.panelOpen && opened.quoteText === null && /在正文里划一段/.test(String(opened.panelText)),
      String(opened.panelText).slice(0, 80));
    check('[无引用] 页面上没有浮动胶囊（没引用可带）', opened.chip === null, String(opened.chip));

    await askOnce(ctx, '这一课在讲什么？');
    const asked = await ctx.evaluate(ASK_PROBE);
    const body = asked.lastAsk ? JSON.parse(asked.lastAsk.body) : {};
    check('[无引用] 照样问得出去，送出去的是一格空引用',
      asked.askCalls === 1 && body.selection === '' && !Object.hasOwn(body, 'selectionAnchor'),
      JSON.stringify(body));

    return { openedHint: /在正文里划一段/.test(String(opened.panelText)), sentBody: body };
  });

  /* ── 四、没有可用模型：如实说明，且**不清**引用 ──────────────────────── */
  await session.scene('ask-quote-unavailable', async (ctx) => {
    await openLesson(ctx);
    await ctx.evaluate(setReply({
      available: false,
      ok: false,
      reason: '夹具：宿主里一个模型 provider 都没注册',
      error: { code: 'model-unavailable', message: '夹具：宿主里一个模型 provider 都没注册' },
    }));
    const target = await selectParagraph(ctx, '[无模型]');
    if (!target) return { failed: '没有可以划的正文段落' };
    await ctx.evaluate(`document.querySelector('[data-proto="qa-chip"]').click()`);
    await ctx.sleep(400);
    const opened = await ctx.evaluate(ASK_PROBE);

    await askOnce(ctx, '这一课在讲什么？');
    const asked = await ctx.evaluate(ASK_PROBE);
    check('[无模型] 如实说明这条链路上没有可用的模型',
      /没有可用的模型/.test(String(asked.panelText)) && /provider 都没注册/.test(String(asked.panelText)),
      String(asked.panelText).slice(0, 140));
    check('[无模型] 不假装会答：一个字都没编，也没说记了误解记录',
      /没有写误解记录/.test(String(asked.panelText)) && !/已记一条误解记录/.test(String(asked.panelText)),
      String(asked.panelText).slice(0, 140));
    check('[无模型] 引用留着——一个字都没落盘，配好模型该能拿同一条引用再问一次',
      asked.quoteText === opened.quoteText && asked.drop,
      `before=${JSON.stringify(opened.quoteText)} after=${JSON.stringify(asked.quoteText)}`);

    return { quoteBefore: opened.quoteText, quoteAfter: asked.quoteText, panelText: String(asked.panelText).slice(0, 200) };
  });
} catch (error) {
  check('问答引用套件跑完（浏览器起来、夹具能开）', false, String(error));
  await session.scene('ask-quote-error', async (ctx) => { ctx.note('harness', String(error)); });
}

console.log(failures ? `\n${failures} 条失败` : '\n全部通过');
await finishSuite(session, { suite: 'ask-quote', failed: failures });
for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
