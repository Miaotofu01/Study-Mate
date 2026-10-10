// 阅读位置浏览器套件的夹具（不是断言套件，由 reading_position_test.mjs 加载）。
//
// 干两件事：
//   1. 把 `lib/client.js` 原文包成能在浏览器里跑的**最小宿主**：冻结模块表里只有 react
//      一个键（照 package.json 的 exports["./client"] 与宿主的装载契约），别的一律没有；
//   2. 造一份 `GET /api/studymate/library` 的应答——形状抄 `lib/library.ts` 的
//      `buildLibrary()` 返回值，锚点四态抄 `lib/core/anchors.ts` 的判定规则
//      （逐字相等→resolved；只差空白→stale；归一化后撞车→ambiguous；没有→missing）。
//      所以套件断言的是**真组件**在四态下的表现，不是夹具自己的逻辑。
//
// 位置内核（两个标记之间的那一段）由 Node 侧切出来再注入，浏览器里不重新解析源码。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', '..', '..', 'lib', 'client.js');   // scripts/tests/fixtures → 仓库根

/** 位置内核：两个标记之间的原文。标记没了就报错，别让套件悄悄测空气。 */
export function kernelSource() {
  const source = fs.readFileSync(CLIENT, 'utf8');
  const start = '/* -- STUDY_POSITION_KERNEL_START -- */';
  const end = '/* -- STUDY_POSITION_KERNEL_END -- */';
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  if (from < 0 || to <= from) throw new Error(`lib/client.js 里找不到 ${start} / ${end}`);
  return source.slice(from + start.length, to);
}

/* ── 课件内容：四节 + 四态锚点 ───────────────────────────────────────── */

/** 一段够长的正文，让每一节都撑得起滚动（短了位置恢复就没有可测的位移）。 */
function filler(topic, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(`${topic}的第 ${i + 1} 段：这一段足够长，用来把正文撑出可滚的高度。`
      + `位置恢复要能在中间落住，正文太短的话所有候选都会挤在首屏，测出来的东西没有意义。`
      + `所以每一节都写到能占满一屏以上，段落之间留出稳定的行高，让「同一段附近」这件事`
      + `有一个明确的像素范围可以断言。第 ${i + 1} 段的这句结尾也是唯一的，方便按段核对。`);
  }
  return out.join('\n\n');
}

/**
 * 四节正文，每节末尾一个 `::: quiz` 锚点，分别落到四态：
 *   resolved  —— 锚点文字与题库键逐字相同
 *   stale     —— 只差空白（题库键里多一个空格）
 *   ambiguous —— 抹掉空白后与两个题库键都相等
 *   missing   —— 题库里根本没有这个键
 * 第 3 节里放一句**唯一**的长句，给搜索用例当靶子。
 */
function lessonMarkdown() {
  return [
    '---',
    'title: 阅读位置三级恢复',
    '---',
    '',
    '## 这一课要解决什么',
    '',
    filler('开头', 12),
    '',
    '::: quiz 理解 锚点：位置恢复的第一级',
    ':::',
    '',
    '## 位置存在哪里',
    '',
    filler('中段', 12),
    '',
    '::: quiz 理解 锚点：本地偏好与学习工作区',
    ':::',
    '',
    '## 三级降级怎么退',
    '',
    '读到这里就停一下：这一句是搜索用例的靶子，它在整篇正文里只出现一次，所以搜到的第一条一定是本节。',
    '',
    filler('降级', 12),
    '',
    '::: quiz 理解 锚点：退到比例那一级',
    ':::',
    '',
    '## 四态定位与判分入口',
    '',
    filler('收尾', 12),
    '',
    '::: quiz 理解 锚点：这一条题库里没有',
    ':::',
    '',
  ].join('\n');
}

function pool() {
  return {
    '位置恢复的第一级': [
      { kind: '客观题', q: '位置恢复的第一级是什么？', opts: ['section', 'offset', 'progress'], ans: 0, why: '先按小节找回去。' },
      { kind: '客观题', q: '第一级靠什么认出同一个小节？', opts: ['下标', 'id', '标题文字'], ans: 1, why: '按 id，插入一节不会串位。' },
      { kind: '客观题', q: '段内偏移是什么？', opts: ['整篇比例', '这一节里的偏移', '滚动条宽度'], ans: 1, why: '段内偏移跟着小节走。' },
    ],
    '本地偏好与学习工作区 ': [                      // 尾随空格：只差空白 → stale
      { kind: '客观题', q: '位置存在哪里？', opts: ['学习工作区', '浏览器本地偏好'], ans: 1, why: '位置不进工作区。' },
      { kind: '客观题', q: '为什么不写进工作区？', opts: ['它不是学习内容', '写不进去'], ans: 0, why: '位置是浏览器本地的东西。' },
    ],
    '退到比例那一级': [                              // 归一化后与下一行撞车 → ambiguous
      { kind: '客观题', q: '退到比例那一级是什么意思？', opts: ['按整篇比例', '回到顶部'], ans: 0, why: '比例是最后一根锚。' },
    ],
    '退到比例那一级 ': [                             // 抹掉空白后与上一行相同
      { kind: '客观题', q: '比例那一级什么时候用？', opts: ['小节找不到时', '每次都用'], ans: 0, why: '前面两级都不成立时才用它。' },
    ],
  };
}

/* ── library 应答 ───────────────────────────────────────────────────── */

function node(number, id, title, lesson_md, anchors, poolData, tier) {
  return {
    id, title, kind: '概念', objective: '把阅读位置讲清楚，并说清它为什么不住在工作区里。',
    problem: '', concepts: [], pitfalls: [], realworld: '', practice: '', resources: [],
    prerequisites: [], level: 0, tier, raw_status: tier, notes: '', number,
    lesson_md, lesson: `demo/lessons/${number}-${id}.md`,
    pool: poolData, anchors,
    orphan_keys: [], orphans: [], question_kinds: {},
    attempts: { present: false, version: 0, questions: {} },
  };
}

/** 锚点四态的形状与 `lib/core/anchors.ts` 的 AnchorMatch 一致。 */
const anchor = (text, resolution, keys) => ({
  text, level: '理解', line: 1, resolution, keys,
  candidates: keys.map((key) => ({ key, line: 1, count: 1 })),
});

export function libraryPayload() {
  const poolData = pool();
  const anchors = [
    anchor('位置恢复的第一级', 'resolved', ['位置恢复的第一级']),
    anchor('本地偏好与学习工作区', 'stale', ['本地偏好与学习工作区 ']),
    anchor('退到比例那一级', 'ambiguous', ['退到比例那一级', '退到比例那一级 ']),
    anchor('这一条题库里没有', 'missing', []),
  ];
  const second = [
    anchor('位置恢复的第一级', 'resolved', ['位置恢复的第一级']),
    anchor('本地偏好与学习工作区', 'stale', ['本地偏好与学习工作区 ']),
  ];

  /* 主页要多几门科目才滚得起来（滚动位置归零那一条要有位置可归）。
     这些科目只用来撑高度：一门一个节点、一节正文，没有锚点。 */
  const fillerSubjects = [];
  for (let i = 0; i < 5; i += 1) {
    const slug = 'filler-' + i;
    fillerSubjects.push({
      slug, name: '撑高度科目 ' + (i + 1), goal: '只用来让主页与科目主页有可滚的高度。',
      status: '未开始', created_at: '2026-01-02T03:04:05+08:00', updated_at: '2026-01-0' + (i + 1) + 'T10:00:00+08:00',
      project: '', mission: { goal: '', done: [], todo: [] },
      glossary: [], resources_md: '', reference: [], reference_version: 1,
      misconceptions: [], misconception_library: [], misconception_issues: [], records: [],
      nodes: [node('0001', 'filler-node', '撑高度的一课',
        ['---', 'title: 撑高度', '---', '', '## 只有一节', '', filler('撑高度', 14), ''].join('\n'),
        [], {}, '未开始')],
      levels: 1, stats: { 未开始: 1, 学习中: 0, 已学完: 0 },
      continue_node: 'filler-node', order: ['filler-node'],
    });
  }

  const subject = {
    slug: 'demo', name: '演示科目', goal: '把阅读位置三级恢复讲清楚', status: '学习中',
    created_at: '2026-01-02T03:04:05+08:00',
    // 最近改动的那一门（`lastTouched` 按这个挑主卡），所以主页的「接着上次」一定是 demo
    updated_at: '2026-12-31T10:00:00+08:00',
    project: '阅读端收口', mission: { goal: '', done: [], todo: [] },
    glossary: [], resources_md: '', reference: [], reference_version: 1,
    misconceptions: [], misconception_library: [], misconception_issues: [],
    records: [],
    nodes: [
      node('0001', 'reading-position', '阅读位置三级恢复', lessonMarkdown(), anchors, poolData, '学习中'),
      node('0002', 'anchor-states', '锚点四态与判分入口',
        ['---', 'title: 锚点四态', '---', '', '## 四态', '', filler('四态', 12), '',
          '::: quiz 理解 锚点：位置恢复的第一级', ':::', '',
          '::: quiz 理解 锚点：本地偏好与学习工作区', ':::', ''].join('\n'),
        second, poolData, '未开始'),
    ],
    levels: 1,
    stats: { 未开始: 1, 学习中: 1, 已学完: 0 },
    continue_node: 'reading-position', order: ['reading-position', 'anchor-states'],
  };

  return {
    workspace: '/tmp/studymate-reading-position-fixture',
    generated_at: '2026-02-01T10:00:00+08:00',
    today: '2026-02-01',
    memory_md: '',
    subjects: [subject].concat(fillerSubjects),
  };
}

/* ── 页面：最小宿主装载器 + 夹具探针 ────────────────────────────────── */

/**
 * 真 React 的 CJS 文件路径。react / react-dom 从**全局 npm 安装**解析：本仓库的
 * devDependencies 里没有它们（只有 typescript），而宿主是懒 CJS 模型——插件 bundle
 * 只 require 一个 `react` 键，所以任何一份 CommonJS 构建的 react 都能跑。
 * 版本与宿主不一定同号，所以这一套只断言插件自己的行为，不断言 React 的行为。
 */
function reactPaths() {
  const globalRoot = () => {
    const probe = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true });
    return probe.status === 0 ? String(probe.stdout || '').trim() : '';
  };
  const roots = [
    path.join(HERE, 'noop.cjs'),                       // 本仓库的 node_modules
    process.env.STUDYMATE_REACT_DIR || '',
    process.env.NODE_PATH || '',
    globalRoot(),
  ].filter(Boolean);
  for (const root of roots) {
    try {
      const from = createRequire(path.join(root, 'noop.cjs'));
      const react = path.join(path.dirname(from.resolve('react')), 'cjs', 'react.production.js');
      const reactDom = path.join(path.dirname(from.resolve('react-dom/client')), 'cjs', 'react-dom-client.production.js');
      // react-dom-client 顶部就 `require("scheduler")`，scheduler 是 react-dom 的**嵌套依赖**
      // （顶层不一定有），所以从 react-dom 自己的位置解析
      const reactDomDir = path.dirname(from.resolve('react-dom/client'));
      const reactDomCore = path.join(path.dirname(from.resolve('react-dom')), 'cjs', 'react-dom.production.js');
      const scheduler = path.join(path.dirname(createRequire(path.join(reactDomDir, 'noop.cjs')).resolve('scheduler')), 'cjs', 'scheduler.production.js');
      if (fs.existsSync(react) && fs.existsSync(reactDom) && fs.existsSync(reactDomCore) && fs.existsSync(scheduler)) {
        return { react, reactDom, reactDomCore, scheduler };
      }
    } catch (error) { /* 这一处没有，换下一处 */ }
  }
  throw new Error('找不到 react / react-dom：在仓库里 `npm i -D react react-dom`，'
    + '或设 STUDYMATE_REACT_DIR=<装了 react 的目录>，或全局装一份。');
}

/**
 * 把一份 CJS 文件包成 `function (module, exports, require, process)`。
 * 宿主那边插件只认模块表里的键，所以这里也只给这几样——不引打包器，也不动原文一个字。
 * `require` 交给页面上的 `__smRequire`（就是模块表本身），于是 react-dom-client 顶部那句
 * `require("scheduler")` / `require("react")` / `require("react-dom")` 都走同一条路。
 *
 * 取的是 **production** 构建（少一层 dev 专用代码）；代价是没有 React 的 dev 警告——
 * 这一套断言的是插件自己的行为，不是 React 的行为。
 */
function cjsBody(file) {
  return [
    '(function (module, exports, require, process) {',
    fs.readFileSync(file, 'utf8'),
    '})(window.__smModule, window.__smModule.exports, window.__smRequire, window.__smProcess);',
  ].join('\n');
}

function html(clientSource, kernel) {
  const { react, reactDom, reactDomCore, scheduler } = reactPaths();
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>阅读位置（真 client.js）</title>
<style>
  /* 测试里要的是「立刻到位」：实现自己也用 instant 定位，这里把平滑滚动彻底关掉，
     免得断言读到的是动画中间那一帧 */
  * { scroll-behavior: auto !important; }
  html, body { margin: 0; height: 100%; }
  /* 三栏壳要一个确定的画布高度，不然 .smb-center__body 没有可滚范围 */
  #host { height: 100vh; }
  #host > * { height: 100%; }
</style>
</head>
<body>
<div id="host"></div>

<script>
/* ① 宿主装载器的最小替身：只登记、不执行。宿主是懒 CJS 模型，
      bundle 执行时只 register，第一次 require 才跑工厂。 */
window.__ModuleLoader__ = {
  load(entry) { window.__smPlugin = entry; },
};

/* ② 冻结模块表：宿主只给这 9 个键，插件只用 react —— 这里也只提供 react。 */
(function () {
  var factories = Object.create(null);
  var loaded = Object.create(null);
  window.__smDefine = function (name, factory) { factories[name] = factory; };
  /* 先把模块登记进表，再让浏览器执行它——它自己会往 window 上挂产物。
     宿主那边是「factory(require) → exports」的懒模型，这里只是把同一件事
     拆成「登记 + 执行」两步，因为 React 的 UMD 构建要真的被浏览器执行一次。 */
  window.__smRegister = function (name) {
    if (loaded[name]) return;
    if (!factories[name]) throw new Error('模块表里没有这个键：' + name);
    loaded[name] = true;
    window.__smModules[name] = factories[name]();
  };
  /* 表里的名字是模块说明符（'react'、'react-dom/client'），大小写与全局变量名不同，
     所以另开一张导出表，不拿 window 上的名字当键。 */
  window.__smModules = Object.create(null);
  window.__smRequire = function (name) {
    if (typeof window.__smModules[name] !== 'undefined') return window.__smModules[name];
    window.__smRegister(name);
    if (typeof window.__smModules[name] === 'undefined') throw new Error('模块表里没有这个键：' + name);
    return window.__smModules[name];
  };
})();

/* ③ 位置内核原文（Node 侧从 lib/client.js 的标记之间切出来，原样注入） */
(function () {
${kernel}
  window.__smKernel = { POSITION_TIERS: POSITION_TIERS, topmostSectionIndex: topmostSectionIndex, resolveReadingTargets: resolveReadingTargets, readingPositionOf: readingPositionOf, readingPositionSettled: readingPositionSettled };
})();
</script>

<script>
/* 真 React 的 CJS 构建：只包一层 module / exports / require，不动它一个字 */
window.__smProcess = { env: { NODE_ENV: 'production' }, emit: function () {}, argv: [] };
window.__smModule = { exports: {} };
</script>
<script>
window.__smBoot = [];
window.addEventListener('error', function (event) { window.__smBoot.push('error: ' + event.message); });
</script>
<script>try { ${cjsBody(scheduler)} } catch (error) { window.__smBoot.push('scheduler: ' + error.message); }</script>
<script>window.__smModules['scheduler'] = window.__smModule.exports; window.__smModule = { exports: {} };</script>

<script>try { ${cjsBody(react)} } catch (error) { window.__smBoot.push('react: ' + error.message); }</script>
<script>window.__smModules['react'] = window.__smModule.exports; window.__smModule = { exports: {} };</script>

<script>try { ${cjsBody(reactDomCore)} } catch (error) { window.__smBoot.push('react-dom: ' + error.message); }</script>
<script>window.__smModules['react-dom'] = window.__smModule.exports; window.__smModule = { exports: {} };</script>

<script>try { ${cjsBody(reactDom)} } catch (error) { window.__smBoot.push('react-dom/client: ' + error.message); }</script>
<script>window.__smModules['react-dom/client'] = window.__smModule.exports; window.__smModule = { exports: {} };</script>

<script>
/* ④ 被测对象：lib/client.js 原文（一个字都不改）。它执行时只做两件事——
      往 __ModuleLoader__ 登记工厂、把样式注进 <head>；工厂要等第一次 require 才跑。 */
${clientSource}
</script>

<script>
/* ⑤ library 应答：形状抄 lib/library.ts，位置偏好一律从零开始 */
window.__smLibrary = ${JSON.stringify(libraryPayload()).replace(/</g, '\\u003c')};
window.__smFetchLog = [];
window.fetch = function (url, options) {
  window.__smFetchLog.push(String(url));
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve(window.__smLibrary); },
  });
};

/* ⑥ 夹具探针：不是断言，只是给 Node 侧读页面状态用的 */
window.__sm = {
  probe: function () {
    var scroller = document.querySelector('.smb-center__body');
    if (!scroller) return { inLesson: false };
    var frame = scroller.getBoundingClientRect();
    // 读数挂在 <template> 里：内容不进渲染树，要穿过 content 取
    var holder = scroller.querySelector('template[data-proto="reading-position"]');
    var readout = holder && holder.content ? holder.content.firstElementChild : null;
    return {
      inLesson: true,
      pageY: scroller.scrollTop,
      max: scroller.scrollHeight - scroller.clientHeight,
      viewport: Math.round(frame.height),
      sectionIndex: readout ? Number(readout.dataset.section) : -1,
      sectionOffset: readout ? Number(readout.dataset.sectionOffset) : -1,
      sections: Array.prototype.map.call(scroller.querySelectorAll('[data-section]'), function (el) {
        var rect = el.getBoundingClientRect();
        return { id: el.id, top: Math.round(rect.top - frame.top + scroller.scrollTop), height: Math.round(rect.height) };
      }),
      /* 「读到哪一节」按几何算（最后一个起点不晚于当前滚动位置的、且自己撑得起半屏的小节）——
         与实现里的判定同一口径，但不依赖 React 的 state 什么时候更新过 */
      atSection: (function () {
        var top = scroller.scrollTop;
        var found = -1;
        var list = scroller.querySelectorAll('[data-section]');
        for (var i = 0; i < list.length; i += 1) {
          var rect = list[i].getBoundingClientRect();
          var start = rect.top - frame.top + top;
          if (rect.height < frame.height / 2) continue;
          if (start <= top + 1) found = Number(list[i].dataset.section);
        }
        return found;
      })(),
      anchorGroups: Array.prototype.map.call(document.querySelectorAll('.smb-agroup'), function (el) {
        return {
          index: Number(el.dataset.anchor),
          options: el.querySelectorAll('[data-proto="option"]').length,
          asks: el.querySelectorAll('.smb-q__ask').length,
          warn: el.querySelector('.smb-note--warn') ? el.querySelector('.smb-note--warn').textContent : '',
          text: el.textContent,
        };
      }),
    };
  },
  prefs: function () {
    var keys = [];
    for (var i = 0; i < window.localStorage.length; i++) keys.push(window.localStorage.key(i));
    var table = null;
    try { table = JSON.parse(window.localStorage.getItem('studymate.reading.v1') || 'null'); } catch (error) { table = 'bad-json'; }
    return { keys: keys, table: table };
  },
  setPrefs: function (table) { window.localStorage.setItem('studymate.reading.v1', JSON.stringify(table)); },
  clearPrefs: function () { window.localStorage.clear(); },
  clickSubject: function (name) {
    var rows = document.querySelectorAll('[data-proto="nav-subject"]');
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].textContent.indexOf(name) >= 0) { rows[i].click(); return true; }
    }
    return false;
  },
  click: function (selector) {
    var el = document.querySelector(selector);
    if (!el) return false;
    el.click();
    return true;
  },
  clickAll: function (selector, index) {
    var list = document.querySelectorAll(selector);
    if (!list[index]) return false;
    list[index].click();
    return true;
  },
  type: function (selector, value) {
    var el = document.querySelector(selector);
    if (!el) return false;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
  scrollTo: function (sectionIndex, offset) {
    var scroller = document.querySelector('.smb-center__body');
    var section = document.querySelector('[data-section="' + sectionIndex + '"]');
    if (!scroller || !section) return false;
    var top = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = top + offset;
    return true;
  },
  growSection: function (sectionIndex, height) {
    var section = document.querySelector('[data-section="' + sectionIndex + '"]');
    if (!section) return false;
    var spacer = document.createElement('div');
    spacer.style.height = height + 'px';
    section.appendChild(spacer);
    window.dispatchEvent(new Event('resize'));
    return true;
  },
  mount: function () {
    var React = window.__smRequire('react');
    var client = window.__smRequire('react-dom/client');
    var plugin = window.__smPlugin.factory(window.__smRequire);
    /* 宿主给插件的座位表：插件只往 main 与 sidebar.panellist 两个座位登记。
       这里只要接住 main 那一个（阅读端本体），侧栏那一行图标与位置恢复无关。 */
    var seats = {};
    window.__smSeats = seats;
    var slots = {
      inject: function (name, fn) { if (name === 'main') fn(); },
      register: function (seat, component) { seats[seat.name] = component; return function () {}; },
    };
    plugin.apply({ slots: slots });
    if (!seats.main) throw new Error('插件没有往 main 座位登记阅读端本体');
    window.__smErrors = [];
    var host = document.getElementById('host');
    window.__smRoot = client.createRoot(host, {
      onUncaughtError: function (error) { window.__smErrors.push(String(error && error.message || error)); },
      onCaughtError: function (error) { window.__smErrors.push(String(error && error.message || error)); },
      onRecoverableError: function (error) { window.__smErrors.push(String(error && error.message || error)); },
    });
    window.__smRoot.render(React.createElement(seats.main));
    // 宿主那边渲染是异步排队的；测试里要一个确定的起点，所以就地冲一次。
    // flushSync 在 React 19 里挂在 react-dom 上，不在 react-dom/client 上。
    var flushSync = window.__smModules['react-dom'] && window.__smModules['react-dom'].flushSync;
    if (typeof flushSync === 'function') flushSync(function () {});
    return { seats: Object.keys(seats), rootChildren: host.childNodes.length, flushSync: typeof flushSync, hasChannel: typeof MessageChannel };
  },
};
</script>
</body>
</html>
`;
}

/* ── 资源表：交给 CDP 的 Fetch.fulfillRequest 逐条作答 ──────────────── */

/**
 * @param {string} clientSource `lib/client.js` 原文
 * @param {string} kernel 位置内核原文
 * @returns {{path: string, type: string, body: string}[]}
 */
export function buildAssets(clientSource, kernel) {
  return [
    { path: 'index.html', type: 'text/html; charset=utf-8', body: html(clientSource, kernel) },
  ];
}

/* 直接跑本文件时给一句提示：它是夹具，断言在 reading_position_test.mjs 里 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  console.log('这是浏览器套件的夹具，由 scripts/tests/browser/reading_position_test.mjs 加载。');
}
