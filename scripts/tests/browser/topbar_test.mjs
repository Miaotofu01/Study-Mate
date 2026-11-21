/* 顶栏的手动收起/展开（本套件）。
   ────────────────────────────────────────────────────────────────────────────────
   为什么单开一条：顶栏这一面没有一条浏览器套件专门钉。reading_routes_test.mjs 只在四个路由
   各取一次景、量的是三栏让位；lesson_body_test.mjs 量的是正文与页头。收起/展开是**交互**
   （点击、键盘、刷新后还在、窄档恒一行），只能真浏览器里跑。

   口径（别顺手改回去）：
     · 断的是**形状与行为**：收起后顶栏高度是 14px（±1）、正文紧贴顶栏下沿、整条细条可点、
       aria-expanded 双向翻转、焦点走 Tab 能到、Enter 能切；宽档一行、窄档（720 / 390）也一行
       且两个偏好控件不出现、没有横向滚动条、面包屑上限 12em（全角字）。
     · 收起后「焦点仍在同一个按钮上」**不在这里验**：夹具页用 fixtures/mini-react.js，它每次
       setState 整树重建 DOM，节点身份保不住（文件头写着「夹具只断言元素与属性」）。那条在
       export_file_test.mjs 的真 React 导出页上验。
     · 刷新持久化在夹具里验（file:// 下 localStorage 可写，已实测）；导出页的持久化与
       「localStorage 抛错退化为默认展开」也在 export_file_test.mjs。
     · 动效只断「关掉时不走过渡」：`data-motion="off"` 与 `prefers-reduced-motion: reduce`
       下 computed transition-duration 都是 0s；不断具体动画波形（harness 截图判不了）。
     · 控制台报错由 harness 兜底：scene 里任何 console error / pageerror / 失败请求都算失败，
       所以本套件不再单独写一条「没有报错」。

   夹具与 reading_routes_test.mjs / lesson_body_test.mjs 同一套（真 lib/client.js + mini-react +
   宿主 token 快照 + 现抠内联 CSS + stub 掉 fetch/EventSource + ResizeObserver 垫片）；内容只留
   顶栏要看的东西：长课件标题（让面包屑真的省略）、一节课文。
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
/** transition-duration 是**每一条过渡一行**的列表（顶栏有 max-height 与 padding 两条），
    所以「关掉」要断「每一项都是 0s」，不能拿整串去比 '0s'。 */
function noTransition(value) {
  return String(value).split(',').every((one) => one.trim() === '0s');
}

function check(label, ok, detail = '') {
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}

/* ── 三档视口 ──────────────────────────────────────────────────────────────
   宽档取 1440（同其它套件）；窄档取 720 与 390：720 是「刚好低于 900 断点、常见平板竖屏」，
   390 是任务点名的那一档（iPhone 尺寸），nowrap 之后最容易挤爆的宽度。 */
const VIEWPORTS = [
  { key: 'wide', width: 1440, height: 960 },
  { key: 'narrow', width: 720, height: 900 },
  { key: 'tiny', width: 390, height: 844 },
];

const TOPBAR_KEY = 'studymate.topbar.v1';
const TEMPS = [];

/* ── 夹具 ──────────────────────────────────────────────────────────────── */

/** 课件标题 19 个中文字：宽档 18em 装不下、窄档 12em 更装不下——面包屑两档都真的省略。 */
const LONG_TITLE = '变量与作用域在嵌套函数里的绑定关系与提升时机（含闭包）';

function subjectFiles(dirName, { slug, name, touched }) {
  return {
    [`.learning/subjects/${dirName}/subject.yaml`]: [
      `slug: ${slug}`, `name: ${name}`, 'goal: 在真浏览器里看一次顶栏', 'status: 学习中',
      'created_at: "2026-01-02T03:04:05+08:00"', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/curriculum.yaml`]: [
      'nodes:',
      '  - id: 绑定', `    title: ${LONG_TITLE}`, '    kind: 概念',
      '    objective: 说清绑定发生在作用域里', '    status: 学习中',
      '  - id: 闭包', '    title: 闭包', '    kind: 概念', '    objective: 说清闭包是什么',
      '    prerequisites: [绑定]', '    status: 未开始', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/progress.yaml`]: [
      `updated_at: "${touched}"`, 'nodes:', '  绑定:', '    status: 学习中', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/lessons/1-绑定.md`]: [
      '# 绑定', '',
      '名字指向值，而不是把值装进盒子里。这一节只用来让课件页有正文可看，顶栏才是验收面。', '',
      '## 一小节', '', '再来一段。', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/lessons/2-闭包.md`]: '# 闭包\n\n闭包是函数记住了它的作用域。\n',
    [`.learning/subjects/${dirName}/MISSION.md`]: '# 使命\n\n## Why\n\n因为要在浏览器里验。\n',
    [`.learning/subjects/${dirName}/GLOSSARY.md`]: '## 基础\n\n**绑定**: 名字指向值\n',
    [`.learning/subjects/${dirName}/RESOURCES.md`]: '# 资源\n\n- 《入门》\n',
    [`.learning/subjects/${dirName}/misconceptions.yaml`]: '[]\n',
  };
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-topbar-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(path.join(workspace, '.learning'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.learning', 'MEMORY.yaml'), '# 共享记忆\n');
  const files = subjectFiles('demo', { slug: 'demo', name: '演示科目', touched: '2026-05-06T07:08:09+08:00' });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { root, workspace };
}

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
<title>StudyMate 顶栏 QA 夹具</title>
<style>
  html, body { margin: 0; height: 100%; }
  #root { height: 100%; }
  ${hostTokenCss()}
</style>
<style id="plugin-css">${css}</style>
<script>
  window.__StudymateSpec = null;
  window.__ModuleLoader__ = { load: function (spec) { window.__StudymateSpec = spec; } };
  window.__Payload = ${json};
  window.fetch = function (url) {
    if (String(url).indexOf('/api/studymate/library') === 0) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(window.__Payload); } });
    }
    return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.resolve({ error: '夹具没有这条接口：' + url }); } });
  };
  window.EventSource = undefined;
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
        register: function (options, component) { if (options && options.name === 'main') Main = component; },
      },
    });
    if (!Main) throw new Error('没有从 main 座位拿到组件');
    window.MiniReact.mount(window.MiniReact.createElement(Main, null), document.getElementById('root'));
  }());
</script>
</body>
</html>
`;
  const file = path.join(dir, 'topbar-fixture.html');
  fs.writeFileSync(file, html);
  return pathToFileURL(file).href;
}

/* ── 页面里的探针 ──────────────────────────────────────────────────────── */

/** 一次量完「顶栏这一面」：高度、一行、细条命中、aria、焦点环、过渡、面包屑、横向溢出。
    两种状态（展开/收起）都用同一支探针，差异由调用方对账。 */
const PROBE = `(() => {
  const q = (sel) => document.querySelector(sel);
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      left: Math.round(r.left), top: Math.round(r.top),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
      width: Math.round(r.width), height: Math.round(r.height),
    };
  };
  const head = q('.smb-topbar');
  const root = q('.smb-root');
  const toggle = q('.smb-topbar__toggle');
  const content = q('.smb-lesson') || q('.smb-scroll');
  const toggleBox = box(toggle);
  const visible = head ? Array.from(head.children).filter((el) => cs(el).display !== 'none') : [];
  const headBox = box(head);
  const inside = headBox ? visible.filter((el) => {
    const b = el.getBoundingClientRect();
    return b.top >= headBox.top - 1 && b.bottom <= headBox.bottom + 1;
  }) : [];
  const crumb = q('.smb-crumb--current');
  const midY = toggleBox ? toggleBox.top + Math.max(1, Math.floor(toggleBox.height / 2)) : 0;
  const hit = toggleBox ? document.elementFromPoint(toggleBox.left + 6, midY) : null;
  // 「整条可点」在三个横向位置取样：左端、正中、右端。
  const stripHitAll = !!toggleBox && [0.06, 0.5, 0.94].every((ratio) => {
    const el = document.elementFromPoint(toggleBox.left + toggleBox.width * ratio, midY);
    return !!el && (el === toggle || toggle.contains(el));
  });
  return {
    rootTag: root ? root.getAttribute('data-topbar') : 'no-root',
    head: headBox,
    headWrap: head ? cs(head).flexWrap : null,
    toggle: toggleBox,
    toggleLast: head ? head.lastElementChild === toggle : false,
    toggleIcon: !!(toggle && toggle.querySelector('svg')),
    attrs: toggle ? {
      expanded: toggle.getAttribute('aria-expanded'),
      label: toggle.getAttribute('aria-label'),
      title: toggle.getAttribute('title'),
      controls: toggle.getAttribute('aria-controls'),
      headerId: head ? head.id : null,
    } : null,
    labelText: toggle ? toggle.textContent.trim() : null,
    contentTop: content ? Math.round(content.getBoundingClientRect().top) : null,
    contentBelowHead: !!(headBox && content)
      && Math.abs(content.getBoundingClientRect().top - headBox.bottom) <= 1,
    oneRow: visible.length > 0 && inside.length === visible.length,
    visible: visible.map((el) => el.getAttribute('class') || el.tagName),
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    headOverflow: head ? head.scrollWidth - head.clientWidth : null,
    brandName: cs(q('.smb-brand__name')) ? cs(q('.smb-brand__name')).display : 'missing',
    brand: box(q('.smb-brand')),
    search: box(q('.smb-searchbtn')),
    fontpick: cs(q('.smb-fontpick')) ? cs(q('.smb-fontpick')).display : 'missing',
    motionpick: cs(q('.smb-motionpick')) ? cs(q('.smb-motionpick')).display : 'missing',
    crumb: crumb ? {
      maxWidth: cs(crumb).maxWidth,
      width: box(crumb).width,
      fontSize: parseFloat(cs(crumb).fontSize),
      text: crumb.textContent,
      truncated: crumb.scrollWidth > crumb.clientWidth + 1,
    } : null,
    // 三条面包屑各自的读数：窄档不能把「主页」「科目名」也一起挤成一个字。
    crumbs: Array.from(document.querySelectorAll('.smb-crumbs .smb-crumb')).map((el) => ({
      text: el.textContent,
      width: box(el).width,
      truncated: el.scrollWidth > el.clientWidth + 1,
    })),
    stripHit: !!hit && (hit === toggle || toggle.contains(hit)),
    stripHitAll: stripHitAll,
    hitTag: hit ? (hit.getAttribute('class') || hit.tagName) : null,
    focused: document.activeElement === toggle,
    focusVisible: !!(toggle && toggle.matches(':focus-visible')),
    outline: toggle ? {
      style: cs(toggle).outlineStyle,
      width: cs(toggle).outlineWidth,
      color: cs(toggle).outlineColor,
      offset: cs(toggle).outlineOffset,
    } : null,
    transition: head ? cs(head).transitionDuration : null,
    motion: root ? root.getAttribute('data-motion') : null,
    onlyToggle: visible.length === 1 && visible[0] === toggle,
  };
})()`;

const FOCUS_PROBE = `(() => {
  const b = document.querySelector('.smb-topbar__toggle');
  if (!b) return null;
  const cs = getComputedStyle(b);
  return {
    focused: document.activeElement === b,
    focusVisible: b.matches(':focus-visible'),
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    outlineColor: cs.outlineColor,
    outlineOffset: cs.outlineOffset,
  };
})()`;

const OPEN_SUBJECT = `(() => {
  const card = document.querySelector('[data-proto="nav-subject"]');
  if (!card) throw new Error('工作台上没有科目卡片');
  card.click();
})()`;

const OPEN_LESSON = `(() => {
  const card = document.querySelector('[data-proto="open-node"]');
  if (!card) throw new Error('科目主页上没有节点卡片');
  card.click();
})()`;

const CLICK_TOGGLE = `(() => {
  const b = document.querySelector('.smb-topbar__toggle');
  if (!b) throw new Error('顶栏里没有收起开关');
  b.click();
})()`;

const REMOVE_KEY = `localStorage.removeItem(${JSON.stringify(TOPBAR_KEY)})`;

const SET_MOTION = `(() => {
  const sel = document.querySelector('.smb-motionpick .smb-select');
  if (!sel) throw new Error('顶栏里没有动效选择器');
  sel.value = %VALUE%;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`;

/* ── 跑 ────────────────────────────────────────────────────────────────── */

// 先起会话：找不到浏览器就直接跳过（退出码 3），别先造一堆临时目录再丢下不管
const session = await openSession({ suite: 'topbar', width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });

async function useViewport(viewport) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
  });
  await session.sleep(150);
}

async function key(type, key, code, keyCode, text) {
  await session.send('Input.dispatchKeyEvent', {
    type, key, code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
}

async function pressTab() {
  await key('rawKeyDown', 'Tab', 'Tab', 9);
  await key('keyUp', 'Tab', 'Tab', 9);
  await session.sleep(40);
}

async function pressEnter() {
  await key('keyDown', 'Enter', 'Enter', 13, '\r');
  await key('keyUp', 'Enter', 'Enter', 13);
  await session.sleep(60);
}

/** 真鼠标点：坐标是视口 CSS 像素（Emulation 只改视口，不改缩放）。 */
async function clickAt(x, y) {
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  await session.sleep(60);
}

/** 打开夹具 → 清掉上次的收起状态 → 重新加载（挂载时 effect 会把默认态写回去）
    → 工作台 → 科目主页 → 课件页。清完再加载，否则「默认展开」会被上一次的镜像抢先。 */
async function openClean(ctx, fixture) {
  await ctx.navigate(fixture, { settle: 1000 });
  await ctx.evaluate(REMOVE_KEY);
  await ctx.navigate(fixture, { settle: 1200 });
  await ctx.evaluate(OPEN_SUBJECT);
  await ctx.sleep(420);
  await ctx.evaluate(OPEN_LESSON);
  await ctx.sleep(520);
}

try {
  const { root, workspace } = makeWorkspace();
  const payload = readLibrary({ workspace });
  const fixture = buildFixture(root, payload);
  console.log(`夹具：${fixture}`);
  console.log(`数据：${workspace}（跑完删）`);

  for (const viewport of VIEWPORTS) {
    await useViewport(viewport);
    const narrow = viewport.width <= 900;
    const tag = `[${viewport.key} ${viewport.width}×${viewport.height}]`;

    await session.scene(`topbar-${viewport.key}`, async (ctx) => {
      await openClean(ctx, fixture);

      /* ── 展开态（默认） ─────────────────────────────────────────── */
      const open = await ctx.evaluate(PROBE);

      check(`${tag} 默认是展开的（壳上没有 data-topbar）`, open.rootTag === null, String(open.rootTag));
      check(`${tag} 顶栏里有一枚收起的图标按钮、在最右端`,
        !!open.toggle && open.toggle.width > 0 && open.toggleLast && open.toggleIcon,
        JSON.stringify({ box: open.toggle, last: open.toggleLast, icon: open.toggleIcon }));
      check(`${tag} aria 三件套：expanded=true、label=收起顶栏、controls 指回顶栏 id`,
        !!open.attrs && open.attrs.expanded === 'true' && open.attrs.label === '收起顶栏'
        && open.attrs.title === '收起顶栏' && open.attrs.controls === 'smb-topbar'
        && open.attrs.headerId === 'smb-topbar',
        JSON.stringify(open.attrs));
      check(`${tag} 顶栏是一行（所有可见子元素都在顶栏的上下沿之间）`,
        open.oneRow, JSON.stringify(open.visible));
      // oneRow 只保证子元素没跑出栏外；子元素内部折行（390px 上搜索按钮曾被挤成「搜/索」两行）
      // 会把顶栏撑高，所以再对高度与搜索按钮高度各设一道上限。
      check(`${tag} 顶栏只有一行的高度（${open.head && open.head.height}px，没有子元素折成两行）`,
        !!open.head && open.head.height <= 56, JSON.stringify(open.head));
      check(`${tag} 搜索按钮没有被挤成两行（高 ${open.search && open.search.height}px）`,
        !!open.search && open.search.height <= 30, JSON.stringify(open.search));
      if (viewport.key === 'tiny') {
        check(`${tag} 手机竖屏藏掉品牌文字、只留「学」`,
          open.brandName === 'none' && !!open.brand && open.brand.width <= 40,
          JSON.stringify({ brandName: open.brandName, brand: open.brand }));
      } else {
        check(`${tag} 品牌文字还在（没有误伤）`, open.brandName !== 'none', String(open.brandName));
      }
      check(`${tag} 顶栏不设 flex-wrap:wrap（宽窄一致）`, open.headWrap === 'nowrap', String(open.headWrap));
      check(`${tag} 正文紧贴顶栏下沿、没被顶栏盖住`, open.contentBelowHead,
        `contentTop=${open.contentTop} headBottom=${open.head && open.head.bottom}`);
      check(`${tag} 页面没有横向滚动条`, open.pageOverflow <= 1, String(open.pageOverflow));
      check(`${tag} 顶栏自己也没溢出（子元素挤在栏内）`, open.headOverflow <= 1, String(open.headOverflow));
      const crumbs = open.crumbs || [];
      check(`${tag} 面包屑三条都在（学习工作台 / 科目 / 当前课件）`,
        crumbs.length === 3 && crumbs[0].text === '学习工作台' && crumbs[2].text.length > 4,
        JSON.stringify(crumbs.map((one) => one.text)));
      check(`${tag} 窄画布下「学习工作台」「科目名」没被挤成一个字（只有当前标题去省略）`,
        crumbs.length === 3 && crumbs.slice(0, 2).every((one) => !one.truncated && one.width >= 20),
        JSON.stringify(crumbs));
      check(`${tag} 当前标题那条至少留够 2 个字宽（${open.crumb && open.crumb.width}px）`,
        !!open.crumb && open.crumb.width >= 24, JSON.stringify(open.crumb));

      if (narrow) {
        check(`${tag} 字号、动效两个阅读偏好控件不出现（.smb-fontpick / .smb-motionpick 隐藏）`,
          open.fontpick === 'none' && open.motionpick === 'none',
          JSON.stringify({ fontpick: open.fontpick, motionpick: open.motionpick }));
        const limit = open.crumb ? open.crumb.fontSize * 12 : 0;
        check(`${tag} 面包屑上限是 12 个全角字（${limit}px），没有改宽`,
          !!open.crumb && Math.abs(parseFloat(open.crumb.maxWidth) - limit) <= 1,
          JSON.stringify(open.crumb && { maxWidth: open.crumb.maxWidth, fontSize: open.crumb.fontSize }));
        check(`${tag} 长课件标题真的被省略到上限以内（${open.crumb && open.crumb.width} ≤ ${limit}）`,
          !!open.crumb && open.crumb.width <= limit + 1 && open.crumb.truncated,
          JSON.stringify(open.crumb));
      } else {
        check(`${tag} 宽档两个阅读偏好控件都在（没有误伤）`,
          open.fontpick !== 'none' && open.motionpick !== 'none',
          JSON.stringify({ fontpick: open.fontpick, motionpick: open.motionpick }));
      }

      /* ── 键盘：Tab 到按钮、Enter 切换、可见焦点环 ────────────────── */
      let arrived = false;
      for (let i = 0; i < 14 && !arrived; i += 1) {
        await pressTab();
        arrived = await session.evaluate(`document.activeElement === document.querySelector('.smb-topbar__toggle')`);
      }
      const ring = await ctx.evaluate(FOCUS_PROBE);
      check(`${tag} Tab 能走到收起按钮`, arrived && !!ring && ring.focused, JSON.stringify(ring));
      check(`${tag} 键盘焦点有可见的焦点环（outline 2px、不是 none）`,
        !!ring && ring.focusVisible && ring.outlineStyle !== 'none' && parseFloat(ring.outlineWidth) >= 2,
        JSON.stringify(ring));

      await pressEnter();
      await session.sleep(320);
      const mini = await ctx.evaluate(PROBE);

      check(`${tag} 按 Enter 收起：壳上 data-topbar=mini`, mini.rootTag === 'mini', String(mini.rootTag));
      check(`${tag} 收起后顶栏高度是 14px（±1）`,
        !!mini.head && Math.abs(mini.head.height - 14) <= 1, JSON.stringify(mini.head));
      check(`${tag} 收起后顶栏只剩那一个按钮、其余入口都藏起来`,
        mini.onlyToggle && mini.headOverflow <= 1, JSON.stringify({ visible: mini.visible, overflow: mini.headOverflow }));
      check(`${tag} 收起后 aria 翻成 false / 展开顶栏`,
        !!mini.attrs && mini.attrs.expanded === 'false' && mini.attrs.label === '展开顶栏'
        && mini.attrs.controls === 'smb-topbar' && mini.attrs.headerId === 'smb-topbar',
        JSON.stringify(mini.attrs));
      check(`${tag} 收起后细条里的字也说明「展开顶栏」`, mini.labelText === '展开顶栏', String(mini.labelText));
      check(`${tag} 正文随之上移（${open.contentTop} → ${mini.contentTop}，顶栏矮了 ${(open.head && open.head.height) - (mini.head && mini.head.height)}）`,
        mini.contentTop <= open.contentTop - 15 && mini.contentBelowHead,
        JSON.stringify({ open: open.contentTop, mini: mini.contentTop }));
      check(`${tag} 整条 14px 细条都可点（左端、正中、右端取样命中的都是按钮）`,
        mini.stripHit && mini.stripHitAll, String(mini.hitTag));

      // 再点细条本身（真鼠标，左端 + 垂直居中）——恢复入口「永远在眼前」。
      const stripX = mini.toggle.left + 8;
      const stripY = mini.toggle.top + Math.floor(mini.toggle.height / 2);
      await clickAt(stripX, stripY);
      await session.sleep(320);
      const back = await ctx.evaluate(PROBE);

      check(`${tag} 点细条展开回去：data-topbar 撤掉、高度回到原样（±1）`,
        back.rootTag === null && !!back.head && Math.abs(back.head.height - open.head.height) <= 1,
        JSON.stringify({ root: back.rootTag, head: back.head && back.head.height, open: open.head && open.head.height }));
      check(`${tag} 展开后 aria-expanded 翻回 true、label 回到「收起顶栏」`,
        !!back.attrs && back.attrs.expanded === 'true' && back.attrs.label === '收起顶栏',
        JSON.stringify(back.attrs));
      check(`${tag} 展开后正文回到原来的位置（±1）`,
        Math.abs(back.contentTop - open.contentTop) <= 1 && back.contentBelowHead,
        JSON.stringify({ back: back.contentTop, open: open.contentTop }));

      /* ── 刷新后保持（收起与展开两个方向都验） ────────────────────── */
      await ctx.evaluate(CLICK_TOGGLE);
      await session.sleep(280);
      await ctx.navigate(fixture, { settle: 1300 });
      const persistedMini = await ctx.evaluate(PROBE);
      check(`${tag} 收起后刷新：仍是收起态（壳上 mini、高度 14px、aria=false）`,
        persistedMini.rootTag === 'mini' && !!persistedMini.head
        && Math.abs(persistedMini.head.height - 14) <= 1
        && !!persistedMini.attrs && persistedMini.attrs.expanded === 'false',
        JSON.stringify({ root: persistedMini.rootTag, head: persistedMini.head, attrs: persistedMini.attrs }));

      await ctx.evaluate(CLICK_TOGGLE);
      await session.sleep(280);
      await ctx.navigate(fixture, { settle: 1300 });
      const persistedOpen = await ctx.evaluate(PROBE);
      check(`${tag} 展开后刷新：仍是展开态（aria=true）`,
        persistedOpen.rootTag === null && !!persistedOpen.attrs && persistedOpen.attrs.expanded === 'true',
        JSON.stringify({ root: persistedOpen.rootTag, attrs: persistedOpen.attrs }));

      /* ── 关掉动效时不走过渡（宽档才有那个控件） ──────────────────── */
      if (!narrow) {
        const setMotion = (value) => ctx.evaluate(SET_MOTION.replace('%VALUE%', JSON.stringify(value)));
        await setMotion('off');
        await session.sleep(160);
        const off = await ctx.evaluate(PROBE);
        check(`[${viewport.key}] data-motion="off" 时顶栏没有过渡（transition-duration=${off.transition}）`,
          off.motion === 'off' && noTransition(off.transition), JSON.stringify({ motion: off.motion, transition: off.transition }));

        await setMotion('auto');
        await session.sleep(160);
        const auto = await ctx.evaluate(PROBE);
        check(`[${viewport.key}] auto 档在默认环境下有过渡（transition-duration=${auto.transition}，不是 0s）`,
          auto.motion === 'auto' && auto.transition !== '0s', String(auto.transition));

        await session.emulate({ reducedMotion: 'reduce' });
        await session.sleep(160);
        const reduced = await ctx.evaluate(PROBE);
        check(`[${viewport.key}] prefers-reduced-motion 时 auto 档顶栏不做过渡（transition-duration=${reduced.transition}）`,
          noTransition(reduced.transition), String(reduced.transition));
        await session.emulate({ reducedMotion: 'no-preference' });
        await session.sleep(120);
      }

      return {
        open: { head: open.head, contentTop: open.contentTop, crumb: open.crumb, fontpick: open.fontpick },
        mini: { head: mini.head, contentTop: mini.contentTop, onlyToggle: mini.onlyToggle },
        back: { head: back.head, contentTop: back.contentTop },
        persisted: { mini: persistedMini.rootTag, open: persistedOpen.rootTag },
      };
    });

    // 再取一张「课件页 + 收起态」的截图：14px 细条压在正文上方，正文从细条下沿开始。
    // 主场景结束在首页展开态，人工复核时看不到细条在真内容上的样子。
    await session.scene(`topbar-mini-${viewport.key}`, async (ctx) => {
      await ctx.navigate(fixture, { settle: 1200 });
      await ctx.evaluate(OPEN_SUBJECT);
      await ctx.sleep(420);
      await ctx.evaluate(OPEN_LESSON);
      await ctx.sleep(520);
      await ctx.evaluate(CLICK_TOGGLE);
      await session.sleep(360);
      const seen = await ctx.evaluate(PROBE);
      check(`${tag} 收起态截图的读数：14px、正文从细条下沿开始`,
        seen.rootTag === 'mini' && !!seen.head && Math.abs(seen.head.height - 14) <= 1
        && seen.contentBelowHead, JSON.stringify({ head: seen.head, contentTop: seen.contentTop }));
      return { head: seen.head, contentTop: seen.contentTop };
    });
  }
} catch (error) {
  check('顶栏套件跑完（浏览器起来、夹具能开）', false, String(error));
  await session.scene('topbar-error', async (ctx) => { ctx.note('harness', String(error)); });
}

console.log(failures ? `\n${failures} 条失败` : '\n全部通过');
await finishSuite(session, { suite: 'topbar', failed: failures });
for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
