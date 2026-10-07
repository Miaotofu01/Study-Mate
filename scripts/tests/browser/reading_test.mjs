/* 阅读端的浏览器 QA：把**真的 lib/client.js** 挂进夹具页，在真浏览器里走一遍
   「主页 → 科目主页（路线图）→ 课件页（三栏）」并收控制台/页面错误/失败请求。
   ────────────────────────────────────────────────────────────────────────────────
   为什么要有这一条：另外三套浏览器套件测的都是旧静态模板（`file://` + `.syn-*` /
   `.quiz` / `.katex`），对阅读端**零覆盖**（ticket #75 的验收面）。

   夹具怎么搭（三件事，缺一不可）：
     · 宿主的 token：从 scripts/tests/fixtures/host-theme-tokens.json 里取出 body{…} 与
       body[data-ds-dark-theme]{…} 两块原样铺进页面——亮暗两套都要能测，且取值与宿主一致；
     · 插件本体：CSS 与 JS 都**从 lib/client.js 里现取**（CSS 用正则取出内联串），
       不手抄一份标记——抄一份就等于测另一份实现；
     · 数据：临时工作区现造、`readLibrary()` 读成 payload、stub 掉 fetch 喂给前端，
       跑完即弃（仓库里不存样例数据）。

   浏览器二进制由 harness 探测；找不到时明确跳过（退出码 3），不是静默绿。
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readLibrary } from '../../../lib/library.ts';
import { extractCss } from '../fixtures/client-css.mjs';
import { CONTRAST_PROBE } from '../fixtures/contrast-probe.mjs';
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

/** 一份能读出「两层依赖 + 有课件」的最小科目树。 */
function subjectFiles(dirName, { slug, name }) {
  return {
    [`.learning/subjects/${dirName}/subject.yaml`]: [
      `slug: ${slug}`, `name: ${name}`, 'goal: 在真浏览器里把阅读端走一遍', 'status: 学习中',
      'created_at: "2026-01-02T03:04:05+08:00"', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/curriculum.yaml`]: [
      'nodes:',
      '  - id: 变量', '    title: 变量', '    kind: 概念', '    objective: 说清变量是什么',
      '    status: 已学完',
      '  - id: 函数', '    title: 函数', '    kind: 概念', '    objective: 说清函数是什么',
      '    prerequisites: [变量]', '    status: 学习中',
      '  - id: 闭包', '    title: 闭包', '    kind: 概念', '    objective: 说清闭包是什么',
      '    prerequisites: [函数]', '    status: 未开始',
      'edges:',
      '  - from: 变量', '    to: 函数', '    reason: 先有绑定再谈调用',
      '  - from: 函数', '    to: 闭包', '    reason: 先会调用再谈捕获', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/progress.yaml`]: [
      'updated_at: "2026-05-06T07:08:09+08:00"',
      'nodes:', '  变量:', '    status: 已学完', '  函数:', '    status: 学习中', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/lessons/1-变量.md`]: [
      '# 变量', '', '变量是名字指向值，别名见 [绑定](./glossary.md)。', '',
      '```js', 'const a = 1;', '```', '',
      '::: quiz 理解 锚点：变量的比喻', ':::', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/lessons/1-变量.quiz.json`]: JSON.stringify({
      变量的比喻: [{ q: '变量最接近下面哪个说法？', opts: ['名字指向值', '容器装着值'], ans: 0, why: '绑定是名字与值的对应。' }],
    }),
    [`.learning/subjects/${dirName}/lessons/2-函数.md`]: '# 函数\n\n函数是一段可复用的调用。\n',
    [`.learning/subjects/${dirName}/lessons/3-闭包.md`]: '# 闭包\n\n闭包是函数记住了它的作用域。\n',
    [`.learning/subjects/${dirName}/MISSION.md`]: '# 使命\n\n## Why\n\n因为要在浏览器里验。\n',
    [`.learning/subjects/${dirName}/GLOSSARY.md`]: '## 基础\n\n**绑定**: 名字指向值\n_Avoid_: 赋值\n',
    [`.learning/subjects/${dirName}/RESOURCES.md`]: '# 资源\n\n- 《入门》\n',
    [`.learning/subjects/${dirName}/misconceptions.yaml`]: '[]\n',
  };
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-reading-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(path.join(workspace, '.learning'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.learning', 'MEMORY.md'), '# 共享记忆\n');
  const files = Object.assign(
    subjectFiles('demo', { slug: 'demo', name: '演示科目' }),
    subjectFiles('second', { slug: 'second', name: '第二科目' }),
  );
  for (const [rel, content] of Object.entries(files)) {
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
    // 宿主自己也在这串后面写了这一条（body 的底色/字色），照抄
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
<title>StudyMate 阅读端 QA 夹具</title>
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
  // 数据从 Host 半的 /api/studymate/library 来；夹具里用现读的 payload stub 掉网络
  window.__Payload = ${json};
  window.fetch = function (url) {
    if (String(url).indexOf('/api/studymate/library') === 0) {
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve(window.__Payload); },
      });
    }
    return Promise.resolve({
      ok: false, status: 404,
      json: function () { return Promise.resolve({ error: '夹具没有这条接口：' + url }); },
    });
  };
  // 变更推送（#74）：阅读端挂载即订阅 /api/studymate/events。这个夹具页走的是 file://，
  // 那条请求只会被 CORS 拦掉——生产里它只在 /api 同源下开（见 lib/watch/channel.ts），
  // 而这一套验的是阅读端的静态面与主题对比度，推送根本不在它的验收面上。
  // 所以把 EventSource 收掉：lib/client.js 认这个早退（typeof EventSource !== 'function'
  // 就不订阅），而不是让一条注定失败的请求去污染「控制台/失败请求」那一项判据。
  // 这条通道本身在 browser/watch_push_test.mjs（真 EventSource ↔ 流式 Response）
  // 与真 DSH 探针（test_dsh_runtime.mjs）里验，两边各盖一半。
  window.EventSource = undefined;
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
  const file = path.join(dir, 'reading-fixture.html');
  fs.writeFileSync(file, html);
  return pathToFileURL(file).href;
}

/* ── 页面里用到的探针 ──────────────────────────────────────────────────── */

const PROBE = `(() => {
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const map = q('.smb-map');
  const table = map && map.querySelector('table.smb-vh');
  return {
    hasRoot: !!q('.smb-root'),
    motion: q('.smb-root') && q('.smb-root').getAttribute('data-motion'),
    subjects: qa('.smb-course').length,
    courses: qa('.smb-course__name').map((el) => el.textContent.trim()),
    mapLabel: map && map.getAttribute('aria-label'),
    mapRole: map && map.getAttribute('role'),
    edgeSvgs: qa('.smb-map svg[aria-hidden="true"]').length,
    edgePaths: qa('.smb-map__edges path').length,
    // 连线的几何也记下来：路径在不在、坐标是不是落在图里（截图里看不清时靠这个判）
    edgeD: qa('.smb-map__edges path').map((one) => one.getAttribute('d')),
    edgeStyle: (() => { const svg = q('.smb-map__edges'); if (!svg) return null; const cs = getComputedStyle(svg);
      return [svg.getAttribute('class'), svg.namespaceURI, cs.position, cs.width, cs.height, cs.top].join(' | '); })(),
    nodeRects: qa('[data-node]').map((el) => { const r = el.getBoundingClientRect(); return el.dataset.node + ':' + Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top); }),
    edgeBox: (() => { const svg = q('.smb-map__edges'); if (!svg) return null; const r = svg.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    mapBox: (() => { const box = q('.smb-map'); if (!box) return null; const r = box.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    levels: qa('.smb-map__level').length,
    tableCaption: table && table.querySelector('caption') && table.querySelector('caption').textContent,
    tableRows: table ? table.querySelectorAll('tbody tr').length : 0,
    tableHead: table ? Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent) : [],
    tableFirstRow: table && table.querySelector('tbody tr') ? Array.from(table.querySelector('tbody tr').children).map((td) => td.textContent) : [],
    // <table> 的盒宽压不到 1px（min-content 撑着），所以判「视觉隐藏的配方有没有真的生效」：
    // 绝对定位 + clip-path + overflow。类名写错时这三样会是 static/none/visible——那就露馅了。
    tableHidden: table ? {
      position: getComputedStyle(table).position,
      clipPath: getComputedStyle(table).clipPath,
      overflow: getComputedStyle(table).overflow,
      width: Math.round(table.getBoundingClientRect().width),
    } : null,
    leftPane: !!q('.smb-left'),
    rails: qa('.smb-rail').length,
    railExpanded: qa('.smb-rail__btn, [class*="rail"] button').map((el) => el.getAttribute('aria-expanded')),
    panes: { left: !!q('.smb-left'), center: !!q('.smb-center'), right: !!q('.smb-right') },
    rails: qa('.smb-rail').length,
    crumb: q('.smb-crumb--current') && q('.smb-crumb--current').textContent,
    progressbar: (() => {
      const el = q('[role="progressbar"]');
      return el ? { label: el.getAttribute('aria-label'), now: el.getAttribute('aria-valuenow'), min: el.getAttribute('aria-valuemin'), max: el.getAttribute('aria-valuemax') } : null;
    })(),
    motionOptions: qa('.smb-select option').map((one) => one.value),
    motionLabel: q('.smb-motionpick') ? q('.smb-motionpick').getAttribute('title') : null,
    bodyText: document.body.innerText.slice(0, 400),
  };
})()`;

/** 三个层级各取几个真的会出现的选择器（一个视图里只有其中一些）。 */
const CONTRAST_TARGETS = {
  home: [
    ['.smb-course__goal', '主页·科目目标（二级文字）'],
    ['.smb-hero__sub', '主页·说明文字'],
    ['.smb-chip', '主页·状态 chip'],
    ['.smb-select', '顶栏·动效档选择器'],
  ],
  subject: [
    ['.smb-subhead__goal', '科目页·目标'],
    ['.smb-block__hint', '科目页·提示（三级文字）'],
    ['.smb-map__levelname', '路线图·层名（四级文字）'],
    ['.smb-card__goal', '路线图·卡片目标（二级文字）'],
    ['.smb-chip--已学完', '路线图·「已学完」chip（语义色文字档）'],
    ['.smb-chip--学习中', '路线图·「学习中」chip（语义色文字档）'],
  ],
  lesson: [
    ['.smb-doc a', '课件·正文链接'],
    ['.smb-crumb', '课件·面包屑（三级文字）'],
    ['.smb-center__head', '课件·正文头'],
  ],
};

/* ── 跑 ────────────────────────────────────────────────────────────────── */

// 先起会话：找不到浏览器就直接跳过（退出码 3），别先造一堆临时工作区再丢下不管
const session = await openSession({ suite: 'reading', width: 1440, height: 960 });
try {
  const { root, workspace } = makeWorkspace();
  const payload = readLibrary({ workspace });
  const fixture = buildFixture(root, payload);
  console.log(`夹具：${fixture}`);
  console.log(`数据：${workspace}（跑完删）`);
  /* 主页：工作台 + 科目列表 + 顶栏的动效档 */
  await session.scene('reading-home', async (ctx) => {
    await ctx.navigate(fixture, { settle: 1200 });
    const seen = await ctx.evaluate(PROBE);
    check('阅读端挂起来了（.smb-root 在）', seen.hasRoot, JSON.stringify(seen.bodyText));
    check('主页列出两门科目', seen.subjects === 2, `实际 ${seen.subjects}`);
    check('科目名对得上（chip 也在同一行里，所以按包含判）',
      seen.courses.some((one) => one.includes('演示科目')) && seen.courses.some((one) => one.includes('第二科目')),
      JSON.stringify(seen.courses));
    check('顶栏有动效档选择器，四档齐全',
      JSON.stringify(seen.motionOptions) === JSON.stringify(['auto', 'full', 'reduced', 'off']),
      JSON.stringify(seen.motionOptions));
    check('默认档是 auto（跟随系统）', seen.motion === null || seen.motion === 'auto', String(seen.motion));
    return seen;
  });

  /* 科目主页：路线图的 aria-label + 视觉隐藏的 <table>（ticket #75 的图表兜底） */
  await session.scene('reading-subject', async (ctx) => {
    await ctx.navigate(fixture, { settle: 1200 });
    await ctx.evaluate(`document.querySelectorAll('.smb-course')[0].click()`);
    const log = await ctx.evaluate(`JSON.stringify((window.__rectLog__ || []).slice(0, 8))`);
    console.log('      data-node 的 rect 记录：' + log);
    await ctx.sleep(400);
    const seen = await ctx.evaluate(PROBE);
    check('进了科目主页（科目名在标题里）', String(seen.bodyText).includes('演示科目'), JSON.stringify(seen.bodyText).slice(0, 200));
    check('路线图容器有 aria-label（说清是什么图）', /^路线图：演示科目，3 层、3 个节点/.test(String(seen.mapLabel)), String(seen.mapLabel));
    check('路线图容器是 role=group（里面有可点卡片，不能当 role=img 吞掉）', seen.mapRole === 'group', String(seen.mapRole));
    check('两条装饰 svg 都 aria-hidden（读屏不再念一堆 path）', seen.edgeSvgs === 2, `实际 ${seen.edgeSvgs}`);
    // 只断言「连线元素在」：连线几何（edgeD）**不在断言范围**——迷你 React 每次状态变化整树重建，
    // 而路线图的 draw() 把 DOM 节点闭在 effect 里（真 React 里节点不换，所以这是对的），
    // 于是重建后它量到的是旧节点、坐标归零。这是夹具的已知边界，不是阅读端的缺陷。
    check('连线元素按前置关系建出来了（2 条）', seen.edgePaths === 2, `实际 ${seen.edgePaths}`);
    check('视觉隐藏的 <table> 在，且「看不见」的配方真的生效',
      seen.tableRows === 3 && seen.tableHidden && seen.tableHidden.position === 'absolute'
      && seen.tableHidden.clipPath === 'inset(50%)' && seen.tableHidden.overflow === 'hidden',
      `rows=${seen.tableRows} style=${JSON.stringify(seen.tableHidden)}`);
    check('表格有 caption 与四个表头', /^路线图：/.test(String(seen.tableCaption))
      && JSON.stringify(seen.tableHead) === JSON.stringify(['节点', '层', '前置', '状态']),
      `${seen.tableCaption} / ${JSON.stringify(seen.tableHead)}`);
    check('第一行把前置关系写清楚了', JSON.stringify(seen.tableFirstRow) === JSON.stringify(['变量', '1', '无', '已学完']),
      JSON.stringify(seen.tableFirstRow));
    check('进度条是真 role=progressbar（带 min/max/now 与 label）',
      seen.progressbar && seen.progressbar.min === '0' && Number(seen.progressbar.max) === 3
      && seen.progressbar.label && seen.progressbar.label.includes('已学完'),
      JSON.stringify(seen.progressbar));
    return seen;
  });

  /* 课件页：三栏骨架 + 真 progressbar + 面包屑 */
  await session.scene('reading-lesson', async (ctx) => {
    await ctx.navigate(fixture, { settle: 1200 });
    await ctx.evaluate(`document.querySelectorAll('.smb-course')[0].click()`);
    await ctx.sleep(300);
    await ctx.evaluate(`document.querySelectorAll('[data-proto="open-node"]')[1].click()`);   // 「函数」有课件
    await ctx.sleep(400);
    const seen = await ctx.evaluate(PROBE);
    check('进了课件页（面包屑停在节点名上）', seen.crumb === '函数', String(seen.crumb));
    check('中栏在（左右栏默认收起，规格 §4.1）', seen.panes.center && !seen.panes.left, JSON.stringify(seen.panes));
    check('收起的两条栏留了窄轨入口', seen.rails >= 2, `窄轨 ${seen.rails} 条`);
    check('正文读出来了', String(seen.bodyText).includes('函数是一段可复用的调用'), JSON.stringify(seen.bodyText).slice(0, 200));
    check('窄轨按钮带 aria-expanded（收起态可读出来）', seen.railExpanded.length >= 1 && seen.railExpanded.every((one) => one === 'false'),
      JSON.stringify(seen.railExpanded));
    return seen;
  });

  /* 动效四档：切档 → 计算样式跟着变；系统偏好 → auto 落 reduced */
  await session.scene('reading-motion', async (ctx) => {
    await ctx.navigate(fixture, { settle: 1200 });
    const read = `(() => {
      const root = document.querySelector('.smb-root');
      return {
        attr: root.getAttribute('data-motion'),
        token: getComputedStyle(root).getPropertyValue('--smb-motion').trim(),
        transition: getComputedStyle(document.querySelector('.smb-searchbtn') || root).transitionDuration,
      };
    })()`;
    const seen = { auto: await ctx.evaluate(read) };
    for (const level of ['full', 'reduced', 'off']) {
      await ctx.evaluate(`(() => {
        const select = document.querySelector('.smb-select');
        select.value = '${level}';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await ctx.sleep(200);
      seen[level] = await ctx.evaluate(read);
    }
    check('四档都写到了 data-motion 上', ['full', 'reduced', 'off'].every((one) => seen[one].attr === one),
      JSON.stringify(seen));
    check('--smb-motion 随档位变：full 140ms / reduced 70ms / off 0s',
      seen.full.token === '140ms' && seen.reduced.token === '70ms' && /^0(m?s|s)$/.test(seen.off.token),
      JSON.stringify([seen.full.token, seen.reduced.token, seen.off.token]));
    check('默认 auto 档取 full 的时长', seen.auto.token === '140ms', String(seen.auto.token));

    // 系统说「减少动效」：auto 档要落到 reduced，显式档位不受影响
    await ctx.evaluate(`(() => {
      const select = document.querySelector('.smb-select');
      select.value = 'auto';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await ctx.sleep(150);
    await session.emulate({ reducedMotion: 'reduce' });
    const reduced = await ctx.evaluate(read);
    check('prefers-reduced-motion: reduce 时 auto 档落到 70ms', reduced.token === '70ms', JSON.stringify(reduced));
    await ctx.evaluate(`(() => {
      const select = document.querySelector('.smb-select');
      select.value = 'full';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await ctx.sleep(150);
    const forced = await ctx.evaluate(read);
    check('显式的 full 档不被系统偏好改写（还是 140ms）', forced.token === '140ms', JSON.stringify(forced));
    check('localStorage 里记下了这一档（本地偏好）',
      await ctx.evaluate(`window.localStorage.getItem('studymate.motion.v1')`) === 'full');
    await session.emulate({});   // 还原，别把偏好漏给后面的场景
    return { ...seen, reducedBySystem: reduced, forced };
  });

  /* 对比度：在真引擎里量「实际用上的颜色」（三个层级各取几个取样点） */
  for (const theme of ['light', 'dark']) {
    await session.scene('reading-contrast-' + theme, async (ctx) => {
      await ctx.navigate(fixture, { settle: 1200 });
      // 宿主用 body[data-ds-dark-theme] 切亮暗（不是 prefers-color-scheme）
      await ctx.evaluate(theme === 'dark'
        ? `document.body.setAttribute('data-ds-dark-theme', '')`
        : `document.body.removeAttribute('data-ds-dark-theme')`);
      await ctx.sleep(200);

      const rows = [];
      const measure = async (where) => {
        const part = await ctx.evaluate(CONTRAST_PROBE + '(' + JSON.stringify(CONTRAST_TARGETS[where]) + ')');
        rows.push(...part);
      };
      await measure('home');
      await ctx.evaluate(`document.querySelectorAll('.smb-course')[0].click()`);
      await ctx.sleep(300);
      await measure('subject');
      // 取「变量」那一课：夹具里它带一条正文链接，正好验 .smb-doc a 的文字档
      await ctx.evaluate(`document.querySelectorAll('[data-proto="open-node"]')[0].click()`);
      await ctx.sleep(400);
      await measure('lesson');

      const missing = rows.filter((one) => one.missing).map((one) => one.name);
      check(`[${theme}] 探针命中所有取样点`, missing.length === 0, JSON.stringify(missing));
      const low = rows.filter((one) => !one.missing && one.ratio < 4.5);
      check(`[${theme}] 渲染出来的文字对比度都达 AA（≥ 4.5:1）`, low.length === 0,
        low.map((one) => `${one.name} ${one.ratio}:1（${one.color} on ${one.bg}）`).join('；'));
      console.log('      ' + rows.filter((one) => !one.missing)
        .map((one) => `${one.name}=${one.ratio}`).join('  '));
      return { theme, rows };
    });
  }
} catch (error) {
  check('阅读端 QA 跑完（浏览器起来、夹具能开）', false, String(error));
  await session.scene('reading-error', async (ctx) => { ctx.note('harness', String(error)); });
}

console.log(failures ? `\n${failures} 条失败` : '\n全部通过');
await finishSuite(session, { suite: 'reading', failed: failures });
for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
