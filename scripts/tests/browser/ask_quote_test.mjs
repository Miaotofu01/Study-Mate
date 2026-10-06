/* 右栏「问答」tab = 宿主的一条真会话（#105）+ 引用 chip（#106）：真浏览器 + 真 `lib/client.js`。
   ────────────────────────────────────────────────────────────────────────────────
   #92 那条套件原来守的是「选中正文 → 面板上那条引用 → 点输入框/打字/切 tab 之后还在」。
   #105 把面板从「一次一问一答的表单」改成**宿主的一条真会话**：面板不再有自己的输入框、不再
   自己发请求，正文交给宿主的 `conversation.content`（`variant:'embedded'`），会话由插件宿主半
   建、客户端只 retain。于是这一条套件改守新形态的几件事：

     · 打开问答就有一条会话：POST `/api/studymate/qa/session`（请求体只有拼标题要的两个名字），
       然后 `retain` 它——来源标签是 `studymateAsk`（**不是** `mainView`）；
     · 面板嵌的是 `conversation.content`，而且被 `SessionProvider` 包着、指着我们 retain 的那条；
     · 「新对话」建一条新的并换过去，上一条被 release；「上一段会话」只列答疑会话（标题前缀认）；
     · 切「题目」tab 再切回、以及**真刷新页面**之后，会话还在（不重复建）。

   外加 #106 那条链（引用 chip 是承重件：#92 只把选中的那段冻成一条数据，这里才让它跟着
   **下一条消息**走）：

     · 真鼠标划一段正文 → 面板输入框上方出现一颗 chip（原文 + 来源小节），**而且它已经进了
       那条会话的草稿**——宿主没有提交钩子，草稿里没有它，消息就不会带上它；
     · 提交那一刻送出去的文字 = 我们注册的引用来源的 `codec.serialize(ref)`（探针照宿主那条
       调用走一遍：按 `occurrence.source` 找 owner，拿它序列化）；
     · 再划一段 → 旧的被**换掉**（草稿里始终只有一颗 chip），不是攒成两颗；
     · chip 点得开（看完整原文与来源）、删得掉（草稿里那颗同时撤掉），删掉之后照样能提问；
     · 太短的选区（误触）不产生 chip；点输入框、切 tab 都不会把 chip 弄丢。

   口径（别顺手改回去）：
     · 断言只到「哪条会话被 retain、送出去的是什么、面板里嵌的是不是那套、草稿里躺着几颗 chip」
       这一层，**不钉宿主正文渲染成什么样**——那由宿主自己保证，夹具只给一个带标记的替身。
     · 夹具页给的是**假的**宿主服务（会话列表 + retain + 一条建会话路由 + 一份假输入门面）。
       真宿主认不认这条调用序列只有在真 DSH 里证得了（spec #102 已接受这个口径）；这里验的是
       **阅读端送出了什么、往草稿里放了什么**。
     · 截图与 summary.json 落在 `.shots/ask-session/`。

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
      'slug: demo', 'name: 演示科目', 'goal: 在真浏览器里验问答会话', 'status: 学习中',
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
    // 两个小节：引用要认出它落在哪一节（「来源：小节「绑定」」），所以第二小节是必要的；
    // 两节里都留一段够长的正文——「再划一段换掉旧的」那一步要在另一节里划。
    '.learning/subjects/demo/lessons/1-变量.md': [
      '# 变量', '',
      '## 绑定', '',
      '变量是名字指向值：写了 const a = 1 之后，a 这个名字就指向 1，改 a 不会改到别的绑定；'
      + '别名只是同一个值的两个名字，不是把值复制一份。', '',
      '## 小结', '',
      '绑定是名字与值的对应，不是把值装进盒子里；改名字指的是换了另一个值，值本身不会跟着变。', '',
    ].join('\n'),
    '.learning/subjects/demo/MISSION.md': '# 使命\n\n## Why\n\n因为要在浏览器里验。\n',
    '.learning/subjects/demo/GLOSSARY.md': '## 基础\n\n**绑定**: 名字指向值\n',
    '.learning/subjects/demo/RESOURCES.md': '# 资源\n\n- 《入门》\n',
    '.learning/subjects/demo/misconceptions.yaml': '[]\n',
  };
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-asksession-'));
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

function buildFixture(dir, payload) {
  const css = extractCss(fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8'));
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>StudyMate 答疑会话 QA 夹具</title>
<style>
  html, body { margin: 0; height: 100%; }
  #root { height: 100%; }
  ${hostTokenCss()}
</style>
<style id="plugin-css">${css}</style>
<script src="${pathToFileURL(path.join(HERE, '..', 'fixtures', 'ask_draft_facade.js')).href}"></script>
<script>
  // 阅读端的宿主契约：window.__ModuleLoader__.load({id, factory})，factory 只 require('react')
  window.__StudymateSpec = null;
  window.__ModuleLoader__ = { load: function (spec) { window.__StudymateSpec = spec; } };
  window.__Payload = ${json};
  // 宿主客户端服务（#105 的假货）：会话列表 + retain/release + 建会话那条路由。
  // __HOST_SEED 由套件用 Page.addScriptToEvaluateOnNewDocument 提前塞进来，用来演「刷新之后
  // 那条会话还在磁盘上、列表里也还在」——种子在页面脚本之前就位，所以这里读得到。
  window.__HOST = {
    rows: (window.__HOST_SEED && window.__HOST_SEED.rows) || [],
    retains: [], releases: [], refreshes: 0,
    factoryCalls: [], providers: [],
    // #106：注册进来的引用来源（引用 chip 的 codec 就在这儿）与插件 fiber 上的 effect
    sources: [], sourceByName: {}, effects: [],
    seq: 0,
    snapshot: function () {
      var ids = [], byId = {};
      for (var i = 0; i < window.__HOST.rows.length; i++) { ids.push(window.__HOST.rows[i].id); byId[window.__HOST.rows[i].id] = window.__HOST.rows[i]; }
      return { ids: ids, byId: byId, phase: 'ready', projectionsBySession: {} };
    },
    addRow: function (row) { window.__HOST.rows.push(row); return row; },
    sessions: {
      list: { getSnapshot: function () { return window.__HOST.snapshot(); }, subscribe: function () { return function () {}; } },
      scope: function (id) { return { __session: id }; },
      retain: function (id, options) {
        window.__HOST.retains.push({ id: id, source: options && options.source });
        window.__DRAFT.session = id;
        return { sessionId: id, binding: { sessionId: id, ctx: { __session: id } }, ready: Promise.resolve({}),
          release: function () { window.__HOST.releases.push(id); } };
      },
      refresh: function () { window.__HOST.refreshes += 1; return Promise.resolve(); },
    },
  };
  // 假的宿主输入门面（#106）：那颗引用 chip 进的就是这里。**与 Node 套件共用同一份**
  // （scripts/tests/fixtures/ask_draft_facade.js，见那里的文件头）——它同时照宿主的**两套投影**：
  // occurrences[].offset/length 是剪贴板的（一颗 chip 占它的 clipboardText 那么长），
  // detectText 里同一颗 chip 只占一个占位符，insertReference / insertText 收到的 span
  // 按 **detect** 长度校验（越界就拒，照宿主 selectSpan 的行为）。
  window.__DRAFT = window.StudymateAskDraft.makeAskDraft();
  // 建会话那条路由的替身：记下请求体，回一条新会话，并把它放进列表（标题按同一套拼法）。
  window.__QA = {
    calls: [], reply: null,
    create: function (body) {
      window.__HOST.seq += 1;
      var id = 'qa-fixture-' + window.__HOST.seq;
      // 夹具镜像宿主那条路由的拼法（「答疑 · 科目 · 节点」，缺哪节少写哪节）
      var title = ['答疑', String(body.subject || '').trim(), String(body.node || '').trim()]
        .filter(function (part) { return part !== ''; }).join(' · ');
      window.__HOST.addRow({ id: id, title: title, displayTitle: title, updatedAt: Date.now(), blank: false, running: false, retainedBy: {} });
      // 新会话 = 新草稿（宿主是这样：草稿按会话分）
      window.__DRAFT.reset();
      return { available: true, ok: true, sessionId: id, title: title, renamed: true, memoryInjected: true };
    },
  };
  window.fetch = function (url, options) {
    var target = String(url);
    if (target.indexOf('/api/studymate/library') === 0) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(window.__Payload); } });
    }
    if (target.indexOf('/api/studymate/qa/session') === 0) {
      var body = {};
      try { body = JSON.parse((options && options.body) || '{}'); } catch (error) { body = {}; }
      window.__QA.calls.push({ url: target, method: (options && options.method) || 'GET', body: (options && options.body) || '' });
      if (window.__QA.reply) {
        var fixed = window.__QA.reply;
        return Promise.resolve({ ok: true, status: fixed.available === false ? 503 : 200, json: function () { return Promise.resolve(fixed); } });
      }
      var view = window.__QA.create(body);
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(view); } });
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
    // 真 React 把 children 放进函数组件的 props；mini-react 不（仓库里 PaneDrawer 的注释记过这个
    // 边界，它的对策是把内容改用 body 传）。SessionProvider 是**宿主**给的组件、props 形状改不了，
    // 所以这里**只在这一套夹具里**把那一步补上——让夹具与真宿主同语义，而不是绕开要验的那条路。
    // 只对函数组件补：DOM 元素那一支 mini-react 自己会渲染 children。
    var raw = window.MiniReact.createElement;
    window.MiniReact.createElement = function (type, props, kids) {
      var rest = Array.prototype.slice.call(arguments, 2);
      if (typeof type === 'function' && rest.length) {
        var merged = {};
        for (var key in (props || {})) merged[key] = props[key];
        merged.children = rest.length === 1 ? rest[0] : rest;
        return raw.apply(null, [type, merged].concat(rest));
      }
      return raw.apply(null, arguments);
    };

    var spec = window.__StudymateSpec;
    if (!spec) throw new Error('lib/client.js 没有向 window.__ModuleLoader__ 登记');
    var mod = spec.factory(function (name) { return name === 'react' ? window.MiniReact : undefined; });
    var Main = null;
    var registrations = [];
    var sessions = window.__HOST.sessions;
    var inputTriggers = {
      registerSource: function (source) {
        window.__HOST.sources.push(source);
        window.__HOST.sourceByName[source.name] = source;
        return function () {
          var at = window.__HOST.sources.indexOf(source);
          if (at >= 0) window.__HOST.sources.splice(at, 1);
          delete window.__HOST.sourceByName[source.name];
        };
      },
    };
    var conversation = {
      input: {
        // 照宿主的判据：actx 必须是**我们 retain 的那条会话**的作用域（拿不到就抛，不是返回 undefined）
        for: function (actx) {
          if (!actx || !actx.__session || actx.__session !== window.__DRAFT.session) {
            throw new Error('conversation.input.for requires a retained Session scope');
          }
          return window.__DRAFT;
        },
      },
    };
    mod.apply({
      slots: {
        inject: function (seat, callback) { callback(); },
        register: function (options, component) {
          registrations.push({ name: options && options.name, children: options && options.children, component: component });
          if (options && options.name === 'main') Main = component;
        },
      },
      sessions: sessions,
      inputTriggers: inputTriggers,
      conversation: conversation,
      get: function (name) {
        if (name === 'sessions') return sessions;
        if (name === 'inputTriggers') return inputTriggers;
        if (name === 'conversation') return conversation;
        return undefined;
      },
      effect: function (fn) { var dispose = fn(); window.__HOST.effects.push(dispose); return dispose; },
    });
    if (!Main) throw new Error('没有从 main 座位拿到组件');
    var mainSeat = registrations.filter(function (entry) { return entry.name === 'main'; })[0];
    window.__HOST.mainChildren = mainSeat ? mainSeat.children : null;

    // 框架交给这颗座位的标准件（#105 只用得到 SessionProvider / renderFactorySlot）。
    // SessionProvider 的替身把「罩着谁」记下来：真实宿主里 occurrence 的会话就是它给的。
    function SessionProvider(props) {
      var child = props.children;
      window.__HOST.providers.push({
        sessionId: props.session && props.session.sessionId,
        childName: child && child.props && child.props['data-name'],
        childVariant: child && child.props && child.props['data-variant'],
      });
      return child;
    }
    function renderFactorySlot(name, props) {
      window.__HOST.factoryCalls.push({ name: name, props: props });
      return window.MiniReact.createElement('div',
        { 'data-proto': 'host-conversation', 'data-name': name, 'data-variant': props && props.variant },
        '宿主会话正文');
    }
    window.MiniReact.mount(window.MiniReact.createElement(Main, {
      SessionProvider: SessionProvider,
      renderSlot: function () { return null; },
      renderFactorySlot: renderFactorySlot,
    }), document.getElementById('root'));
  }());
</script>
</body>
</html>
`;
  const file = path.join(dir, 'ask-session-fixture.html');
  fs.writeFileSync(file, html);
  return pathToFileURL(file).href;
}

/* ── 页面里的探针与几步操作 ────────────────────────────────────────────── */

const HELPERS = `
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const text = (sel) => { const el = q(sel); return el ? el.textContent.trim() : null; };
`;

/** 面板上的会话面：哪条被 retain、嵌了什么、单子里有哪些条目。 */
const SESSION_PROBE = `(() => {
  ${HELPERS}
  const panel = q('.smb-askbody');
  return {
    panelOpen: !!panel,
    panelText: panel ? panel.innerText : null,
    creates: (window.__QA.calls || []).length,
    lastCreate: (window.__QA.calls || []).slice(-1)[0] || null,
    retains: (window.__HOST.retains || []).slice(),
    releases: (window.__HOST.releases || []).slice(),
    refreshes: window.__HOST.refreshes,
    factoryCalls: (window.__HOST.factoryCalls || []).slice(),
    providers: (window.__HOST.providers || []).slice(),
    mainChildren: window.__HOST.mainChildren,
    embedded: !!q('[data-proto="host-conversation"]'),
    embeddedVariant: q('[data-proto="host-conversation"]') ? q('[data-proto="host-conversation"]').getAttribute('data-variant') : null,
    historyItems: qa('[data-proto="qa-history-item"]').map((el) => ({ id: el.getAttribute('data-session'), text: el.textContent.trim() })),
    historyOpen: !!q('[data-proto="qa-history-list"]'),
    tabAsk: q('[data-proto="tab-ask"]') ? q('[data-proto="tab-ask"]').getAttribute('aria-selected') : null,
    quoteText: q('[data-proto="qa-quote"]') ? q('[data-proto="qa-quote"]').textContent.trim() : null,
    newButton: !!q('[data-proto="qa-new"]'),
    historyButton: !!q('[data-proto="qa-history"]'),
    liveSelection: String(window.getSelection()),
  };
})()`;

/**
 * 引用 chip 那一半（#106）：面板上那颗的样子 + **草稿里真实躺着的那颗**（假输入门面）
 * + 我们注册的引用来源按它自己的 codec 序列化出来的那段文字。
 *
 * 「提交时送出去的就是那段」在夹具里的判据就是这个：宿主提交时做的唯一一件事是按
 * `occurrence.source` 找 owner 的 `codec.serialize(ref)`——这里照同一条调用走一遍。
 */
const CHIP_PROBE = `(async () => {
  ${HELPERS}
  const draft = window.__DRAFT.state.getSnapshot();
  const chips = (draft.occurrences || []).map((one) => ({ source: one.source, ref: one.ref, label: one.label, offset: one.offset, length: one.length }));
  const serialized = [];
  for (const chip of chips) {
    const owner = window.__HOST.sourceByName[chip.source];
    serialized.push(owner && owner.codec ? await owner.codec.serialize(chip.ref, new AbortController().signal) : null);
  }
  return {
    sources: (window.__HOST.sources || []).map((one) => ({ trigger: one.trigger, name: one.name, hasCodec: !!(one.codec && one.codec.serialize) })),
    draftText: draft.draft,
    chips: chips,
    chipCount: chips.length,
    serialized: serialized,
    notices: window.__DRAFT.notices.slice(),
    panelChip: q('[data-proto="qa-quote"]') ? q('[data-proto="qa-quote"]').textContent.trim() : null,
    panelWhere: text('[data-proto="qa-quote"] .smb-askquote__where'),
    quoteOpen: q('[data-proto="qa-quote"]') ? q('[data-proto="qa-quote"]').getAttribute('data-open') : null,
    hasToggle: !!q('[data-proto="qa-quote-toggle"]'),
    hasDrop: !!q('[data-proto="qa-quote-clear"]'),
    fullText: q('[data-proto="qa-quote-full"]') ? q('[data-proto="qa-quote-full"]').textContent.trim() : null,
    floatChip: q('[data-proto="qa-chip"]') ? q('[data-proto="qa-chip"]').textContent.trim() : null,
    embedded: !!q('[data-proto="host-conversation"]'),
    effects: (window.__HOST.effects || []).length,
  };
})()`;

/** 一个元素的中心点（给「点输入框」那一步用真鼠标）。 */
function pointOf(selector, offsetY) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, ${Number(offsetY) || 24})) };
  })()`;
}

/**
 * 挑一段够长的正文段落，把它前 40 个字的位置量出来（给真鼠标拖拽用）。
 *
 * 量的是 `Range.getClientRects()`——文字**真正**画在哪，不是段落盒子的矩形；滚动用
 * `behavior:'instant'`：正文滚动区带 `scroll-behavior: smooth`，平滑滚动会让这里的 rect 与
 * 之后的鼠标动作对不上。`title` 给了就只在这一小节里挑（「再划一段换掉旧的」要另一节）；
 * 没给就在有段落的小节里挑第一个够长的——`# 变量` 那个标题自己也是一节、但没有段落。
 */
function selectTargetIn(title, take) {
  return `(() => {
    const art = document.querySelector('article.smb-doc');
    if (!art) return null;
    const blocks = Array.from(art.querySelectorAll('.smb-sec-block'));
    const wanted = ${JSON.stringify(title || '')};
    const scoped = wanted
      ? blocks.filter((el) => { const head = el.querySelector('h2'); return head && head.textContent.trim() === wanted; })
      : blocks;
    let pick = null;
    for (const one of scoped) {
      pick = Array.from(one.querySelectorAll('p')).find((p) => (p.textContent || '').trim().length >= 24);
      if (pick) break;
    }
    if (!pick) return null;
    const block = pick.closest('.smb-sec-block') || scoped[0];
    pick.scrollIntoView({ block: 'center', behavior: 'instant' });
    const walker = document.createTreeWalker(pick, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && node.nodeValue.trim().length < 12) node = walker.nextNode();
    if (!node) return null;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(node.nodeValue.length, ${Number(take) || 40}));
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
    if (!rects.length) return null;
    const first = rects[0];
    const last = rects[rects.length - 1];
    return {
      text: range.toString(),
      section: block.id,
      sectionTitle: (block.querySelector('h2') || {}).textContent || '',
      from: { x: Math.round(first.left) + 1, y: Math.round(first.top + first.height / 2) },
      to: { x: Math.round(last.right) - 1, y: Math.round(last.top + last.height / 2) },
    };
  })()`;
}

const SELECT_TARGET = selectTargetIn('', 40);

const OPEN_SUBJECT = `(() => {
  const cards = Array.from(document.querySelectorAll('[data-proto="nav-subject"]'));
  (cards.find((el) => el.textContent.includes('演示科目')) || cards[0]).click();
})()`;

const OPEN_LESSON = `(() => {
  const cards = Array.from(document.querySelectorAll('[data-proto="open-node"]'));
  (cards.find((el) => el.textContent.includes('变量')) || cards[0]).click();
})()`;

/** 直接开右栏的「问答」（不划词那条路）。 */
const OPEN_ASK = `(() => { document.querySelector('[data-proto="toggle-ask"]').click(); })()`;
const OPEN_QUIZ = `(() => { document.querySelector('[data-proto="tab-quiz"]').click(); })()`;
const BACK_TO_ASK = `(() => { document.querySelector('[data-proto="tab-ask"]').click(); })()`;
const CLICK_NEW = `(() => { document.querySelector('[data-proto="qa-new"]').click(); })()`;
const OPEN_HISTORY = `(() => { document.querySelector('[data-proto="qa-history"]').click(); })()`;

/** 往夹具的会话列表里塞几行（演「上一段会话」与「刷新之后还在」）。 */
function seedRows(rows) {
  return `(() => { ${JSON.stringify(rows)}.forEach((row) => window.__HOST.addRow(row)); return window.__HOST.rows.length; })()`;
}

/** 点单子里某一条（按 id）。 */
function clickHistoryItem(id) {
  return `(() => {
    const item = document.querySelector('[data-proto="qa-history-item"][data-session=${JSON.stringify(id)}]');
    if (!item) throw new Error('单子里没有这条会话：' + ${JSON.stringify(id)});
    item.click();
    return true;
  })()`;
}

/* ── 真鼠标 ────────────────────────────────────────────────────────────── */

/** 点一下：按下 → 抬起。 */
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

const session = await openSession({ suite: 'ask-session', width: 1440, height: 960 });

/** 首页 → 科目页 → 课件页。每个场景都从头走一遍，场景之间不带上一步的状态。 */
async function openLesson(ctx) {
  await ctx.navigate(fixture, { settle: 1200 });
  await ctx.evaluate(OPEN_SUBJECT);
  await ctx.sleep(300);
  await ctx.evaluate(OPEN_LESSON);
  await ctx.sleep(400);
}

/** 打开「问答」并等面板把会话认下来（建会话那条路是异步的）。 */
async function openAskTab(ctx) {
  await ctx.evaluate(OPEN_ASK);
  await ctx.sleep(600);
}

let fixture = null;
try {
  const { root, workspace } = makeWorkspace();
  const payload = readLibrary({ workspace });
  fixture = buildFixture(root, payload);
  console.log(`夹具：${fixture}`);
  console.log(`数据：${workspace}（跑完删）`);

  /* ── 一、打开问答：建一条会话、retain 它、面板里嵌的是宿主正文 ─────────── */
  await session.scene('ask-session-open', async (ctx) => {
    await openLesson(ctx);
    await openAskTab(ctx);
    const seen = await ctx.evaluate(SESSION_PROBE);

    check('[打开] 面板起来了，顶部有「新对话」与「上一段会话」',
      seen.panelOpen && seen.newButton && seen.historyButton,
      `open=${seen.panelOpen} new=${seen.newButton} history=${seen.historyButton}`);
    check('[打开] 一条现成的都没有，于是请宿主半建了一条（POST /api/studymate/qa/session）',
      seen.creates === 1 && !!seen.lastCreate && seen.lastCreate.url.indexOf('/api/studymate/qa/session') === 0,
      `creates=${seen.creates} last=${JSON.stringify(seen.lastCreate)}`);
    const body = seen.lastCreate ? JSON.parse(seen.lastCreate.body) : {};
    check('[打开] 请求体只有拼标题要的两个展示名（面板不背会话）',
      JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['node', 'subject'])
      && body.subject === '演示科目' && body.node === '变量',
      JSON.stringify(body));
    check('[打开] retain 了刚建的那条，来源标签是 studymateAsk（绝不能用 mainView）',
      seen.retains.length === 1 && seen.retains[0].source === 'studymateAsk'
      && seen.retains[0].id === 'qa-fixture-1',
      JSON.stringify(seen.retains));
    check('[打开] 嵌的是 conversation.content，入参 embedded / active / hero:false',
      seen.factoryCalls.length >= 1 && seen.factoryCalls[0].name === 'conversation.content'
      && seen.factoryCalls[0].props.variant === 'embedded' && seen.factoryCalls[0].props.phase === 'active'
      && seen.factoryCalls[0].props.hero === false,
      JSON.stringify(seen.factoryCalls));
    check('[打开] 宿主正文被 SessionProvider 包着，指着我们 retain 的那条',
      seen.providers.length >= 1 && seen.providers[0].sessionId === 'qa-fixture-1'
      && seen.providers[0].childName === 'conversation.content'
      && seen.providers[0].childVariant === 'embedded',
      JSON.stringify(seen.providers));
    check('[打开] 宿主正文那一格真的渲染进了 DOM',
      seen.embedded && seen.embeddedVariant === 'embedded',
      `embedded=${seen.embedded} variant=${seen.embeddedVariant}`);
    check('[打开] main 座位声明了非 root 的子座位（不然框架不会给 SessionProvider）',
      !!seen.mainChildren && !!seen.mainChildren['studymate.ask.session']
      && seen.mainChildren['studymate.ask.session'].scope === 'session',
      JSON.stringify(seen.mainChildren));

    return { creates: seen.creates, retains: seen.retains, providers: seen.providers, body };
  });

  /* ── 二、划一段 → chip 进草稿；点输入框 / 切 tab 都不丢；点得开、删得掉 ────── */
  await session.scene('ask-session-keep', async (ctx) => {
    await openLesson(ctx);
    // 先划一段正文：面板上看得见那一段与它的来源，而且它已经进了那条会话的草稿（#106）
    const target = await ctx.evaluate(SELECT_TARGET);
    check('[保持] 取到了要划的那一段正文', !!target && target.text.trim().length >= 8, JSON.stringify(target));
    if (target) await dragSelect(session, target);
    const chipped = await ctx.evaluate(`(() => { const el = document.querySelector('[data-proto="qa-chip"]'); return el ? el.textContent.trim() : null; })()`);
    check('[保持] 真鼠标划完正文后浮出「就这段问一句」', chipped === '就这段问一句', String(chipped));

    await ctx.evaluate(`document.querySelector('[data-proto="qa-chip"]').click()`);
    await ctx.sleep(600);
    const opened = await ctx.evaluate(SESSION_PROBE);
    check('[保持] 从正文发问打开的面板带着那条引用（原文 + 来源小节）',
      !!opened.quoteText && opened.quoteText.includes('绑定'),
      JSON.stringify(opened.quoteText));

    /* #106：chip 那一半的正面判据——注册的来源、草稿里那颗、以及**提交时会送出去的文字** */
    const first = await ctx.evaluate(CHIP_PROBE);
    check('[chip] 引用来源在插件激活时就注册着（trigger @、名字不撞宿主、codec 在册）',
      first.sources.length === 1 && first.sources[0].trigger === '@'
      && first.sources[0].name === 'studymate' && first.sources[0].hasCodec,
      JSON.stringify(first.sources));
    check('[chip] 划中的那段真的进了那条会话的草稿（宿主没有提交钩子，这一步不能省）',
      first.chipCount === 1 && first.chips[0].source === 'studymate',
      `chips=${JSON.stringify(first.chips)}`);
    check('[chip] 提交时送出去的就是那段原文 + 来源锚点（走 codec.serialize）',
      !!first.serialized[0] && first.serialized[0].includes(target.text.trim())
      && first.serialized[0].includes('小节「绑定」') && first.serialized[0].includes('1-变量.md'),
      JSON.stringify(first.serialized));
    check('[chip] 面板上那颗写着原文与来源小节，点开看全文与删掉的入口都在',
      !!first.panelChip && first.panelChip.includes('绑定') && !!first.panelWhere
      && first.panelWhere.includes('小节「绑定」') && first.hasToggle && first.hasDrop,
      `chip=${JSON.stringify(first.panelChip)} where=${JSON.stringify(first.panelWhere)}`);

    // 点开看原文：完整那一段出来（chip 上一行是省略形态）
    await ctx.evaluate(`document.querySelector('[data-proto="qa-quote-toggle"]').click()`);
    await ctx.sleep(200);
    const unfolded = await ctx.evaluate(CHIP_PROBE);
    check('[chip] 点开 chip 看到完整原文与来源小节',
      unfolded.quoteOpen === '1' && !!unfolded.fullText && unfolded.fullText.includes(target.text.trim()),
      `open=${unfolded.quoteOpen} full=${JSON.stringify(unfolded.fullText)}`);

    // 「点输入框」：宿主正文那一格点一下（文档选区被折叠成空），引用不该被抹掉
    const spot = await ctx.evaluate(pointOf('[data-proto="host-conversation"]', 20));
    check('[保持] 取到了宿主正文那一格的位置（点它 = 点输入框）', !!spot, JSON.stringify(spot));
    if (spot) await clickAt(session, spot);
    const afterClick = await ctx.evaluate(CHIP_PROBE);
    check('[chip] 点输入框之后 chip 还在（草稿里也还是那一颗，没多出第二颗）',
      !!afterClick.panelChip && afterClick.chipCount === 1
      && afterClick.chips[0].ref === first.chips[0].ref,
      `chip=${JSON.stringify(afterClick.panelChip)} chips=${JSON.stringify(afterClick.chips)}`);

    // 切到「题目」再切回「问答」：面板会被卸载重挂——会话、chip 与草稿里那一颗都该还在
    await ctx.evaluate(OPEN_QUIZ);
    await ctx.sleep(300);
    const onQuiz = await ctx.evaluate(SESSION_PROBE);
    check('[保持] 切到「题目」后面板换了一面', onQuiz.panelOpen === false, String(onQuiz.panelOpen));
    await ctx.evaluate(BACK_TO_ASK);
    await ctx.sleep(600);
    const back = await ctx.evaluate(SESSION_PROBE);
    check('[保持] 切回来之后会话还是那一条（没有再建一条）',
      back.panelOpen && back.creates === opened.creates && back.retains.length >= 1
      && back.retains[back.retains.length - 1].id === 'qa-fixture-1',
      `creates=${back.creates} retains=${JSON.stringify(back.retains)}`);
    check('[保持] 切回来之后引用也还在',
      back.quoteText === unfolded.panelChip && !!back.quoteText,
      `before=${JSON.stringify(unfolded.panelChip)} after=${JSON.stringify(back.quoteText)}`);
    const kept = await ctx.evaluate(CHIP_PROBE);
    check('[chip] 切回来草稿里还是那一颗（重挂不许把同一段插成两颗）',
      kept.chipCount === 1 && kept.chips[0].ref === first.chips[0].ref,
      JSON.stringify(kept.chips));

    return { quote: opened.quoteText, keeps: back.retains.length, creates: back.creates, ref: first.chips[0].ref };
  });

  /* ── 二之二、再划一段：旧的被换掉（同一会话只挂一条，不攒成两颗） ──────────── */
  await session.scene('ask-chip-replace', async (ctx) => {
    await openLesson(ctx);
    const first = await ctx.evaluate(selectTargetIn('绑定', 40));
    check('[换掉] 取到了第一段（绑定）', !!first && first.text.trim().length >= 8, JSON.stringify(first));
    if (first) await dragSelect(session, first);
    await ctx.evaluate(`document.querySelector('[data-proto="qa-chip"]').click()`);
    await ctx.sleep(600);
    const before = await ctx.evaluate(CHIP_PROBE);
    check('[换掉] 第一段已经进了草稿', before.chipCount === 1, JSON.stringify(before.chips));

    const second = await ctx.evaluate(selectTargetIn('小结', 40));
    check('[换掉] 取到了第二段（小结，另一节）',
      !!second && second.text.trim().length >= 8 && second.sectionTitle.trim() === '小结',
      JSON.stringify(second));
    if (second) await dragSelect(session, second);
    await ctx.sleep(400);
    const after = await ctx.evaluate(CHIP_PROBE);

    check('[换掉] 还是只有一颗 chip（新选区换掉旧的，不是攒成两颗）',
      after.chipCount === 1, JSON.stringify(after.chips));
    check('[换掉] 那一颗换成了新的一段（ref 变了）',
      after.chips[0].ref !== before.chips[0].ref, 'ref 没变：旧的没被换掉');
    check('[换掉] 送出去的是新那段 + 它的来源小节（旧那段的原文不在草稿里了）',
      !!after.serialized[0] && after.serialized[0].includes(second.text.trim())
      && after.serialized[0].includes('小节「小结」')
      && !after.draftText.includes(first.text.trim()),
      JSON.stringify(after.serialized));

    return { chips: after.chips.length, serialized: after.serialized[0] };
  });

  /* ── 二之三、删掉 chip：草稿里那颗也撤掉，照样能直接提问 ──────────────────── */
  await session.scene('ask-chip-drop', async (ctx) => {
    await openLesson(ctx);
    const target = await ctx.evaluate(SELECT_TARGET);
    if (target) await dragSelect(session, target);
    await ctx.evaluate(`document.querySelector('[data-proto="qa-chip"]').click()`);
    await ctx.sleep(600);
    const before = await ctx.evaluate(CHIP_PROBE);
    check('[删掉] 划一段之后草稿里有一颗', before.chipCount === 1, JSON.stringify(before.chips));

    await ctx.evaluate(`document.querySelector('[data-proto="qa-quote-clear"]').click()`);
    await ctx.sleep(300);
    const after = await ctx.evaluate(CHIP_PROBE);
    check('[删掉] chip 从面板上没了，草稿里那颗也撤掉了',
      after.panelChip === null && after.chipCount === 0 && !after.draftText.includes(target.text.trim()),
      `panel=${JSON.stringify(after.panelChip)} chips=${JSON.stringify(after.chips)} draft=${JSON.stringify(after.draftText)}`);
    check('[删掉] 删掉之后照样能直接提问（面板与宿主输入框都还在）',
      after.embedded && !after.hasDrop, `embedded=${after.embedded} drop=${after.hasDrop}`);

    return { draft: after.draftText, chips: after.chipCount };
  });

  /* ── 二之四、太短的选区（误触）不产生 chip ──────────────────────────────── */
  await session.scene('ask-chip-short', async (ctx) => {
    await openLesson(ctx);
    await openAskTab(ctx);                       // 面板先开着：太短也不该冒出一颗
    const target = await ctx.evaluate(selectTargetIn('绑定', 2));
    check('[太短] 取到了一个两字的选区', !!target && [...target.text.trim()].length <= 3, JSON.stringify(target));
    if (target) await dragSelect(session, target);
    const seen = await ctx.evaluate(CHIP_PROBE);
    check('[太短] 两字的误触不产生 chip（面板上没有、草稿里也没有）',
      seen.panelChip === null && seen.chipCount === 0,
      `panel=${JSON.stringify(seen.panelChip)} chips=${JSON.stringify(seen.chips)}`);
    check('[太短] 浮出的「就这段问一句」也没有', seen.floatChip === null, String(seen.floatChip));

    return { chips: seen.chipCount };
  });

  /* ── 三、「新对话」建新的并换过去；「上一段会话」只列答疑会话 ────────────── */
  await session.scene('ask-session-switch', async (ctx) => {
    await openLesson(ctx);
    await openAskTab(ctx);
    const first = await ctx.evaluate(SESSION_PROBE);

    // 单子里先塞两条别的：一条答疑（较早）、一条学习会话（更新的）——只有前者该出现
    await ctx.evaluate(seedRows([
      { id: 'qa-older', title: '答疑 · 演示科目 · 变量', displayTitle: '不计较', updatedAt: 100, blank: false, running: false, retainedBy: {} },
      { id: 'learn-1', title: '学习 · 演示科目 · 变量', displayTitle: '学习 · 演示科目 · 变量', updatedAt: 999, blank: false, running: false, retainedBy: {} },
    ]));

    await ctx.evaluate(CLICK_NEW);
    await ctx.sleep(600);
    const second = await ctx.evaluate(SESSION_PROBE);
    check('[切换] 「新对话」建了一条新的会话并 retain 它',
      second.creates === first.creates + 1
      && second.retains[second.retains.length - 1].id === 'qa-fixture-2',
      `creates=${second.creates} retains=${JSON.stringify(second.retains)}`);
    check('[切换] 上一条会话被 release（不 release 它永远不退休）',
      second.releases.includes('qa-fixture-1'),
      JSON.stringify(second.releases));
    check('[切换] 嵌的换成了新那一条',
      second.providers[second.providers.length - 1].sessionId === 'qa-fixture-2',
      JSON.stringify(second.providers));

    await ctx.evaluate(OPEN_HISTORY);
    await ctx.sleep(300);
    const listed = await ctx.evaluate(SESSION_PROBE);
    const ids = listed.historyItems.map((item) => item.id);
    check('[切换] 「上一段会话」单子里只有答疑会话，最近的在前',
      listed.historyOpen && ids.length === 3 && ids[0] === 'qa-fixture-2'
      && ids.indexOf('qa-older') > 0 && ids.indexOf('learn-1') < 0,
      JSON.stringify(listed.historyItems));

    await ctx.evaluate(clickHistoryItem('qa-older'));
    await ctx.sleep(500);
    const picked = await ctx.evaluate(SESSION_PROBE);
    check('[切换] 点一条上一段会话就换过去（也 retain 它）',
      picked.retains[picked.retains.length - 1].id === 'qa-older'
      && picked.providers[picked.providers.length - 1].sessionId === 'qa-older',
      JSON.stringify(picked.retains));
    check('[切换] 换过去的会话照样没再建新的',
      picked.creates === second.creates, `creates=${picked.creates}`);

    return { ids, picked: picked.retains[picked.retains.length - 1] };
  });
} catch (error) {
  check('答疑会话套件跑完（浏览器起来、夹具能开）', false, String(error));
  await session.scene('ask-session-error', async (ctx) => { ctx.note('harness', String(error)); });
}

/* ── 四、真刷新：会话在磁盘上，回来还是那一条 ──────────────────────────────
   用 `Page.addScriptToEvaluateOnNewDocument` 提前把「列表里有一条答疑会话」塞进去：它就是
   「上一次打开留下的那条会话」。真刷新之后面板该认得出它，而不是又建一条。 */
try {
  await session.inject(`window.__HOST_SEED = { rows: [
    { id: 'qa-persisted', title: '答疑 · 演示科目 · 变量', displayTitle: '不计题', updatedAt: 5, blank: false, running: false, retainedBy: {} },
    { id: 'learn-1', title: '学习 · 演示科目 · 变量', displayTitle: '学习 · 演示科目 · 变量', updatedAt: 9, blank: false, running: false, retainedBy: {} }
  ] };`);
  await session.scene('ask-session-reload', async (ctx) => {
    await openLesson(ctx);
    await openAskTab(ctx);
    const seen = await ctx.evaluate(SESSION_PROBE);
    check('[刷新] 页面重开之后认出了最近那条答疑会话，没有再建一条',
      seen.creates === 0, `creates=${seen.creates} ${JSON.stringify(seen.lastCreate)}`);
    check('[刷新] retain 的就是那条落盘的会话（标题前缀认，不用另存 id 清单）',
      seen.retains.length === 1 && seen.retains[0].id === 'qa-persisted'
      && seen.retains[0].source === 'studymateAsk',
      JSON.stringify(seen.retains));
    check('[刷新] 嵌的还是宿主正文，指着那条会话',
      seen.embedded && seen.providers[seen.providers.length - 1].sessionId === 'qa-persisted',
      JSON.stringify(seen.providers));
    return { creates: seen.creates, retains: seen.retains };
  });
} catch (error) {
  check('刷新那一条跑完了', false, String(error));
}

console.log(failures ? `\n${failures} 条失败` : '\n全部通过');
await finishSuite(session, { suite: 'ask-session', failed: failures });
for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
