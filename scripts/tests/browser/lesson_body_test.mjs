/* 课件页正文与页头的呈现（#89）：配图、代码块、长内容、字号行高、页头两条、面包屑、题目标记。
   ────────────────────────────────────────────────────────────────────────────────
   为什么单开一条：同目录的 reading_routes_test.mjs（#86）把四个面各取一次景，夹具里那点内容
   是**取景用**的——一张 480 宽的位图、两小节、一条题目、没有长标识符、没有宽表格、没有长代码行、
   没有长中文标题。这一条把 #89 的验收面逐个摆出来：每个场景的夹具都是**刚好越界**的那一份，
   读数写进 metrics，宽窄两档各跑一遍，每个场景一张截图。

   口径（别顺手改回去）：
     · 断的是**关系**不是值：配图「不超列宽」、矢量图「跟着列宽变」、代码行「在块内滚而不是撑破」、
       长内容「页面与正文列都没有横向滚动」、正文「所有成句元素的字号只有一种、行高跟着字号走」、
       页头「小节跳转与课件标题在同一条上」、面包屑「按全角字数省略」。没有一条断言钉死具体像素值
       （spec 的呈现条目是意图级的）；唯一贴着值的是暗色配图的亮度**小于**亮色（关系式），
       以及面包屑「留下几个字」的下限（那是「省略得有分寸」这句话的机器化的那一半）。
     · 正文那批取样元素是**真渲染出来的**：探针按选择器捞 DOM，量 computed style，不看源码。
     · 夹具页面的搭法与 reading_routes_test.mjs 同一套（真 lib/client.js + fixtures/mini-react.js +
       宿主 token 快照 + 现抠的内联 CSS + stub 掉 fetch/EventSource + ResizeObserver 垫片）。
       差别只有夹具内容：这一条要「刚好越界」的那一份。

   **矢量图那条路以前量不到，现在能量真货了**（#97 结掉的缺口）：`::: svg` → `SvgFrame` 用
   innerHTML 把 SVG 贴进图框，而 mini-react 每次重渲染都整树重建 DOM、effect 只在 deps 变化时
   重跑，于是「挂载之后才贴进去的 innerHTML」会被下一次重渲染抹掉（真 React 会 diff、节点不换，
   所以客户端那段代码本身是对的）。这条差别一度让这一套只能**现造一个同形状的元素**
   （`div.smb-figure__frame > svg`）去量「随列宽流动」这条 CSS 契约——只证明规则写得对，
   证明不了客户端真的把块里的图形贴了上去（#89 的报告如实记了这条）。
   现在 `mini-react.js` 的重建把**无 React 子节点**的元素的 innerHTML 按路径带到同位置元素上
   （等价于真 React「不碰自己没渲染过的子节点」），于是夹具内容里可以写真的 `::: svg` 块，
   `lesson-body-*-svg` 那几场断言的就是**客户端产出的那个 `<svg>`**：它在、里面有内容文件里的
   图形、随列宽流动、暗色下被压暗。

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

/** 从一段 computed `filter` 里读出 brightness 的倍数（没有就当中性 1）。
    配图的亮暗断言一律走这一条**关系式**：暗色 < 亮色、且暗色 < 1，不钉具体像素。 */
function brightness(filter) {
  const m = /brightness\(([\d.]+)\)/.exec(String(filter));
  return m ? Number(m[1]) : 1;
}

/* ── 两档视口 ──────────────────────────────────────────────────────────────
   与 #86 同一对：窄档取 800×900（真的低于 900 那条断点，且刚好越过后台栏「装得下」的门槛
   ——画布 − 两条窄轨 76 − 中栏保底 420 ≥ 右栏最小 280）。两档都跑，截图才「可判」。 */
const VIEWPORTS = [
  { key: 'wide', width: 1440, height: 960 },
  { key: 'narrow', width: 800, height: 900 },
];

const TEMPS = [];

/* ── 夹具内容 ──────────────────────────────────────────────────────────── */

/** 课件标题故意长：19 个中文字，宽档 18em 的内存取不下，窄档 12em 更取不下——两档都真的省略。 */
const LONG_TITLE = '变量与作用域在嵌套函数里的绑定关系与提升时机（含闭包）';

/** 位图配图：1100×280、白底。宽度**故意**比两档的正文列都宽（宽档列约 712、窄档约 372），
    这样「缩到列宽」这件事在两档下都真的发生了，而不是「本来就放得下」。
    源用 SVG data URL 喂给 `img`：受不受列宽约束只取决于元素走的是 `img`（位图那条路）
    还是内联 `svg`（矢量那条路），与源格式无关；夹具页走 file://，取图路由到不了服务端。 */
const BITMAP_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="280" viewBox="0 0 1100 280">',
  '<rect width="1100" height="280" fill="#ffffff"/>',
  '<rect x="40" y="40" width="300" height="200" rx="16" fill="#4c6ef5"/>',
  '<text x="190" y="155" font-family="sans-serif" font-size="42" fill="#ffffff" text-anchor="middle">名字</text>',
  '<line x1="370" y1="140" x2="700" y2="140" stroke="#4c6ef5" stroke-width="10"/>',
  '<polygon points="700,110 760,140 700,170" fill="#4c6ef5"/>',
  '<rect x="780" y="40" width="280" height="200" rx="16" fill="#12b886"/>',
  '<text x="920" y="155" font-family="sans-serif" font-size="42" fill="#ffffff" text-anchor="middle">值</text>',
  '</svg>',
].join('');
const BITMAP_SRC = 'data:image/svg+xml;base64,' + Buffer.from(BITMAP_SVG, 'utf8').toString('base64');

/** 内联矢量图（`::: svg`）：块里的 SVG 由客户端**原样透传**（`SvgFrame` 把 `block.svg` 用
    innerHTML 贴进图框），与位图那条 `<img>` 是两条独立的路。这一块以前不写进夹具内容——
    mini-react 会把贴进去的 innerHTML 在下一次重渲染时抹掉（文件头那段夹具边界），于是
    「客户端产出的内联 SVG」零浏览器覆盖（#97 结掉的就是这条）。
    3:1 的 viewBox 与 900×300 的属性宽高是刻意写的：「属性宽高被 CSS 压过、比例靠 viewBox
    保住」这件事才有东西可断。那条弧线的 `d` 逐字进断言，用来证明贴进来的是**内容文件里的
    图形**，而不是一个空壳。 */
const INLINE_SVG_PATH = 'M80 226 C 300 60, 600 60, 820 226';
const INLINE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300" viewBox="0 0 900 300">',
  '<rect width="900" height="300" fill="#ffffff"/>',
  '<path d="' + INLINE_SVG_PATH + '" fill="none" stroke="#4c6ef5" stroke-width="12"/>',
  '<circle cx="80" cy="226" r="14" fill="#4c6ef5"/>',
  '<circle cx="820" cy="226" r="14" fill="#12b886"/>',
  '</svg>',
].join('');

/** 一行真的比列宽长很多的代码（宽档列约 712px，这行约 1000px）。 */
const LONG_CODE_LINE = 'const binding = resolveNestedScopeBinding(outer, inner, { strict: true, fallback: "outer-binding-name-that-is-really-long" });';

/** 一个不含空格的长标识符 + 一条长 URL：两者都能把正文列顶宽，除非正文允许在词内断行。 */
const LONG_TOKEN = 'studymate_pane_widths_v1_override_for_narrow_canvas_scenarios_' + 'x'.repeat(24);
const LONG_URL = 'https://example.com/docs/very/long/path/that/never/breaks/' + 'segment-'.repeat(6) + 'end';

/** 一份能读出「有课件」的最小科目树；这一课就是取景主角。 */
function subjectFiles(dirName, { slug, name, touched }) {
  const lesson = [
    `# ${LONG_TITLE}`, '',
    // 正文：段落、列表、引用、提示块、练习块——「同一屏里只有一种正文大小」逐个取样
    `变量是名字指向值。长标识符 ${LONG_TOKEN} 与长链接 ${LONG_URL} 都在这一段里。`, '',
    '- 绑定发生在作用域里，不在值里',
    '- 内层作用域看得见外层，反过来不行', '',
    '> 引用也是一段成句的正文，字号与行距跟段落一样。', '',
    '::: tip 读法',
    '提示块里的字同样是正文。',
    ':::', '',
    '```js', LONG_CODE_LINE, 'const b = a + 1;', '```', '',
    // 位图（宽 1100）与矢量图（随列宽流动）各一张
    `::: figure ${BITMAP_SRC}`,
    'alt: 名字与值的对应示意（宽图）',
    'caption: 图 1 · 绑定示意',
    ':::', '',
    // 内联矢量图（#97）：块里的 SVG 原样透传，走的是与上面那张位图完全不同的另一条路
    '::: svg',
    'alt: 名字与值之间的一条连线（内联矢量图）',
    'caption: 内联画的那条线',
    '',
    INLINE_SVG,
    ':::', '',
    // 宽表格：表头是 nowrap 的，六列都写成一句完整的话——表格的 min-content 于是真的比列宽大，
    // 「在表格这一层里横向滚动、不往外撑」这件事才被验到（表头写成两个字的话，表格会自己缩进列宽里）
    '| 绑定的名字写在这里 | 指向的是什么值 | 在哪个作用域里 | 什么时候才可见 | 这一列的说明要写长一点 | 备注一栏也写长一点 |',
    '| --- | --- | --- | --- | --- | --- |',
    `| ${LONG_TOKEN} | 内层 | 嵌套函数 | 定义之后 | 一段很长的说明文字也要能换行 | 见上 |`,
    '| b | 外层 | 顶层 | 一直 | 普通一行 | 无 |', '',
    '::: practice 动手做 | 写两次绑定',
    '练习块里的正文也是正文。',
    ':::', '',
    '## 小结', '',
    '小结段落里再放一个长标识符：' + LONG_TOKEN + '。', '',
    '::: quiz 理解 锚点：变量的比喻', ':::', '',
    '::: quiz 应用 锚点：作用域的嵌套', ':::', '',
    '::: quiz 分析 锚点：绑定的时机', ':::', '',
  ].join('\n');

  return {
    [`.learning/subjects/${dirName}/subject.yaml`]: [
      `slug: ${slug}`, `name: ${name}`, 'goal: 在真浏览器里把课件页的正文与页头看一遍', 'status: 学习中',
      'created_at: "2026-01-02T03:04:05+08:00"', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/curriculum.yaml`]: [
      'nodes:',
      `  - id: 绑定`, `    title: ${LONG_TITLE}`, '    kind: 概念',
      '    objective: 说清绑定发生在作用域里而不是值里', '    status: 学习中',
      '  - id: 闭包', '    title: 闭包', '    kind: 概念', '    objective: 说清闭包是什么',
      '    prerequisites: [绑定]', '    status: 未开始', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/progress.yaml`]: [
      `updated_at: "${touched}"`, 'nodes:', '  绑定:', '    status: 学习中', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/lessons/1-绑定.md`]: lesson,
    // 三条锚点各一组题：正文里的标记要一眼看出属于右栏第几组
    [`.learning/subjects/${dirName}/lessons/1-绑定.quiz.json`]: JSON.stringify({
      变量的比喻: [{
        q: '变量最接近下面哪个说法？',
        opts: ['名字指向值', '容器装着值', '一段可复用的调用'],
        ans: 0,
        why: '绑定是名字与值的对应，不是把值装进盒子里。',
      }],
      作用域的嵌套: [{ q: '内层作用域看得到外层的绑定吗？', opts: ['看得到', '看不到'], ans: 0, why: '作用域链向上查。' }],
      绑定的时机: [{ q: '绑定在什么时候确定？', opts: ['定义时', '每次读取时'], ans: 0, why: '定义时就绑好了。' }],
    }),
    [`.learning/subjects/${dirName}/lessons/2-闭包.md`]: '# 闭包\n\n闭包是函数记住了它的作用域。\n',
    [`.learning/subjects/${dirName}/MISSION.md`]: '# 使命\n\n## Why\n\n因为要在浏览器里验。\n',
    [`.learning/subjects/${dirName}/GLOSSARY.md`]: '## 基础\n\n**绑定**: 名字指向值\n_Avoid_: 赋值\n',
    [`.learning/subjects/${dirName}/RESOURCES.md`]: '# 资源\n\n- 《入门》\n',
    [`.learning/subjects/${dirName}/misconceptions.yaml`]: '[]\n',
  };
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-body-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(path.join(workspace, '.learning'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.learning', 'MEMORY.md'), '# 共享记忆\n');
  const files = subjectFiles('demo', { slug: 'demo', name: '演示科目', touched: '2026-05-06T07:08:09+08:00' });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { root, workspace };
}

/* ── 夹具页（与 #86 同一套搭法）─────────────────────────────────────────── */

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
<title>StudyMate 课件页正文与页头 QA 夹具</title>
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
  // 变更推送那条 EventSource 在 file:// 下注定失败，而推送不在这一面的验收面上：收掉它
  // （lib/client.js 认这个早退）。这条通道由 watch_push_test.mjs 覆盖。
  window.EventSource = undefined;
  // mini-react 每次重渲染整树重建 DOM，被 effect 闭住的旧节点一脱离文档就报 0 宽——
  // 于是 LessonPage 的 ResizeObserver 会把画布宽量成 0、两条栏永远打不开。垫片只在 observe
  // 时同步报一次真实尺寸，与真 React 下「只有真的变了才回调」等价。见 #86 同一处的长注释。
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
  const file = path.join(dir, 'lesson-body-fixture.html');
  fs.writeFileSync(file, html);
  return pathToFileURL(file).href;
}

/* ── 页面里的探针 ──────────────────────────────────────────────────────── */

const PROBE = `(() => {
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const px = (value) => Math.round(parseFloat(value) * 100) / 100;
  const doc = q('article.smb-doc');
  const center = q('.smb-center__body');
  const head = q('.smb-center__head');
  const frame = q('.smb-figure__frame');
  const img = q('.smb-figure__frame img');
  const svg = q('.smb-figure__frame > svg');
  const pre = q('.smb-code pre');
  const bar = q('.smb-code__bar');
  const tableWrap = q('.smb-table-wrap');
  const table = q('.smb-table');
  const crumb = q('.smb-crumb--current');
  const secs = q('.smb-secs');
  const name = q('.smb-center__name');
  const meta = q('.smb-center__head .smb-meta');

  // 一块元素的内容宽（扣掉左右内边距）：正文列的「列宽」说的就是这个
  const inner = (el) => {
    if (!el) return 0;
    const s = getComputedStyle(el);
    return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
  };
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      right: Math.round(r.right), bottom: Math.round(r.bottom) }; };

  // 面包屑里**真的露出来**的中文字有几个：逐字量 client rect，落在盒子里的才算
  const visibleChars = (el) => {
    if (!el || !el.firstChild) return 0;
    const box = el.getBoundingClientRect();
    const range = document.createRange();
    const text = String(el.textContent || '');
    let n = 0;
    for (let i = 0; i < text.length; i += 1) {
      range.setStart(el.firstChild, i);
      range.setEnd(el.firstChild, i + 1);
      const r = range.getBoundingClientRect();
      if (r.width > 0 && r.right <= box.right + 0.5 && r.left >= box.left - 0.5) n += 1;
    }
    return n;
  };

  // 正文取样：成句的元素（段落 / 列表项 / 表格单元 / 引用 / 提示块 / 练习块 / 目标 / 题面 / 选项 / 解析）
  const PROSE = [
    ['正文·段落', 'article.smb-doc p:not(.smb-hero__eyebrow)'],
    ['正文·列表项', 'article.smb-doc li'],
    ['正文·表格单元', 'article.smb-doc td'],
    ['正文·引用', 'article.smb-doc blockquote'],
    ['正文·提示块', 'article.smb-doc .smb-note'],
    ['正文·练习块', 'article.smb-doc .smb-practice__body'],
    ['正文·本节目标', 'article.smb-doc .smb-goal'],
    ['右栏·题干', '.smb-q__text p'],
    ['右栏·选项', '.smb-opt'],
    ['右栏·组标题', '.smb-agroup__text'],
  ];
  const prose = [];
  for (const [label, sel] of PROSE) {
    const el = q(sel);
    if (!el) { prose.push({ label, sel, missing: true }); continue; }
    const s = getComputedStyle(el);
    const size = parseFloat(s.fontSize);
    const line = parseFloat(s.lineHeight);
    prose.push({ label, sel, size: px(size), line: px(line), ratio: Math.round((line / size) * 1000) / 1000 });
  }

  const root = q('.smb-root');

  // 内联矢量图那条路（#97）：量的是**真渲染出来的那个 <svg>**——课件内容里的 ::: svg 块
  // 由客户端 SvgFrame 用 innerHTML 原样贴进图框。以前这里现造一个同形状的元素来量 CSS 契约，
  // 那只证明「规则写得对」，证明不了「客户端真的把块里的图形贴上去了」（#89 报告里如实记了这条）。
  const svgEl = q('.smb-figure__frame > svg');
  const svgBox = svgEl ? svgEl.parentElement : null;
  const vector = svgEl ? (() => {
    const line = svgEl.getBoundingClientRect();
    return {
      frameInner: px(inner(svgBox)), w: px(line.width), h: px(line.height),
      display: getComputedStyle(svgEl).display, filter: getComputedStyle(svgEl).filter,
      ratio: Math.round((line.height / line.width) * 1000) / 1000,
    };
  })() : null;

  return {
    width: window.innerWidth,
    breakpoint900: window.matchMedia('(max-width: 900px)').matches,
    // 正文列：列宽、有没有横向溢出
    doc: { box: rect(doc), inner: px(inner(doc)), overflowX: doc ? doc.scrollWidth - doc.clientWidth : null },
    // 配图两条路：位图是真渲染出来的那一张；矢量图量的是同形状元素的 CSS 契约
    vector,
    figure: frame ? {
      frameInner: px(inner(frame)),
      img: img ? { w: px(img.getBoundingClientRect().width), h: px(img.getBoundingClientRect().height),
        natural: img.naturalWidth, maxWidth: cs(img).maxWidth, filter: cs(img).filter, loaded: img.complete && img.naturalWidth > 0 } : null,
      svg: svg ? { w: px(svg.getBoundingClientRect().width), h: px(svg.getBoundingClientRect().height),
        filter: cs(svg).filter, viewBox: svg.getAttribute('viewBox') } : null,
    } : null,
    // 代码块：语言标签 + 块内横向滚动
    code: pre ? {
      lang: bar && bar.querySelector('b') ? bar.querySelector('b').textContent.trim() : null,
      preClientW: px(pre.clientWidth), preScrollW: px(pre.scrollWidth),
      blockInner: px(inner(q('.smb-code'))), whiteSpace: cs(pre).whiteSpace,
    } : null,
    // 长内容：长标识符 / 长 URL / 宽表格
    longText: (() => {
      const el = qa('article.smb-doc p').find((one) => one.textContent.indexOf('studymate_pane_widths') >= 0);
      return el ? { clientW: px(el.clientWidth), scrollW: px(el.scrollWidth) } : null;
    })(),
    table: tableWrap && table ? {
      wrapClientW: px(tableWrap.clientWidth), wrapScrollW: px(tableWrap.scrollWidth),
      tableW: px(table.getBoundingClientRect().width),
    } : null,
    overflow: {
      page: document.documentElement.scrollWidth - window.innerWidth,
      center: center ? center.scrollWidth - center.clientWidth : null,
      doc: doc ? doc.scrollWidth - doc.clientWidth : null,
    },
    // 字号与行高：一屏里成句的文字只有一种字号，行高跟着它走
    prose,
    bodyTokens: root ? {
      size: cs(root).getPropertyValue('--smb-fs-body').trim(),
      line: cs(root).getPropertyValue('--smb-lh-body').trim(),
      fontSize: px(parseFloat(cs(root).fontSize)),
      lineHeight: px(parseFloat(cs(root).lineHeight)),
    } : null,
    // 顶部：原来两条（标题条 + 小节目录条）现在是一条
    head: head ? {
      box: rect(head), innerW: px(inner(head)),
      hasName: !!name && head.contains(name),
      hasSecs: !!secs && head.contains(secs),
      hasMeta: !!meta && head.contains(meta),
      nameBox: rect(name), secsBox: rect(secs), metaBox: rect(meta),
      secsCount: qa('.smb-sec').length,
      bars: qa('.smb-center__head, .smb-secsbar').length,
      rails: qa('.smb-rail').length,
      // 这一条里的内容确实铺在两端（不是缩在左边一小截）：首个子元素贴着左内边距、末个贴着右内边距
      edge: (() => {
        const kids = Array.from(head.children).filter((el) => el.getBoundingClientRect().width > 0);
        if (!kids.length) return null;
        const style = getComputedStyle(head);
        const first = kids[0].getBoundingClientRect();
        const last = kids[kids.length - 1].getBoundingClientRect();
        return {
          leadIn: Math.round(first.left - (head.getBoundingClientRect().left + parseFloat(style.paddingLeft))),
          trailIn: Math.round((head.getBoundingClientRect().right - parseFloat(style.paddingRight)) - last.right),
          // 相邻两块之间最大的那段空白：只记不判——「空着大半条」这件事由截图与这一条一起看
          maxGap: Math.round(kids.slice(1).reduce((worst, el, i) => {
            const gap = el.getBoundingClientRect().left - kids[i].getBoundingClientRect().right;
            return Math.max(worst, gap);
          }, 0)),
        };
      })(),
    } : null,
    // 面包屑：按全角字省略
    crumb: crumb ? {
      text: crumb.textContent, clientW: px(crumb.clientWidth), scrollW: px(crumb.scrollWidth),
      maxWidth: cs(crumb).maxWidth, fontSize: px(parseFloat(cs(crumb).fontSize)),
      visible: visibleChars(crumb), overflow: cs(crumb).overflow, textOverflow: cs(crumb).textOverflow,
      // 宽度上限换算成「几个全角字」：em 那一档算出来是整数，ch 那一档不是
      limitEm: Math.round((crumb.clientWidth / parseFloat(cs(crumb).fontSize)) * 100) / 100,
    } : null,
    // 题目标记：组号要与右栏那一组的编号对得上
    markers: qa('[data-proto="quiz-marker"]').map((el) => ({
      no: el.querySelector('.smb-qmark__no') ? el.querySelector('.smb-qmark__no').textContent.trim() : null,
      badge: el.querySelector('.smb-qmark__badge') ? el.querySelector('.smb-qmark__badge').textContent.trim() : null,
      text: el.querySelector('.smb-qmark__text') ? el.querySelector('.smb-qmark__text').textContent.trim() : null,
      count: el.querySelector('.smb-qmark__n') ? el.querySelector('.smb-qmark__n').textContent.trim() : null,
      group: el.getAttribute('data-group'),
    })),
    groups: qa('.smb-agroup').map((el) => ({
      no: el.querySelector('.smb-agroup__no') ? el.querySelector('.smb-agroup__no').textContent.trim() : null,
      title: el.querySelector('.smb-agroup__text') ? el.querySelector('.smb-agroup__text').textContent.trim() : null,
    })),
    bodyText: document.body.innerText.slice(0, 300),
  };
})()`;

/* 内联 SVG 那一场的专用探针：只量那张矢量图与它所在的一圈，读的是**真渲染出来的** `<svg>`
   （`::: svg` 块由 SvgFrame 原样贴进图框）。「不是空壳」就看三样：命名空间是 SVG、
   里面有内容文件里那几个图形、弧线的 d 逐字相同。 */
const SVG_PROBE = `(() => {
  const svg = document.querySelector('.smb-figure__frame > svg');
  if (!svg) return null;
  const frame = svg.parentElement;
  const fig = frame.closest('figure');
  const doc = document.querySelector('article.smb-doc');
  const cs = getComputedStyle(svg);
  const px = (value) => Math.round(parseFloat(value) * 100) / 100;
  const inner = (el) => {
    if (!el) return 0;
    const s = getComputedStyle(el);
    return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
  };
  const box = svg.getBoundingClientRect();
  return {
    ns: svg.namespaceURI,
    viewBox: svg.getAttribute('viewBox'),
    attrWidth: svg.getAttribute('width'), attrHeight: svg.getAttribute('height'),
    shapes: svg.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon, text').length,
    pathD: svg.querySelector('path') ? svg.querySelector('path').getAttribute('d') : null,
    display: cs.display, filter: cs.filter,
    w: px(box.width), h: px(box.height),
    ratio: box.width > 0 ? Math.round((box.height / box.width) * 1000) / 1000 : 0,
    frameInner: px(inner(frame)),
    frameRole: frame.getAttribute('role'), frameLabel: frame.getAttribute('aria-label'),
    caption: fig && fig.querySelector('figcaption') ? fig.querySelector('figcaption').textContent.trim() : null,
    docInner: px(inner(doc)),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
})()`;

/** 把那张内联矢量图滚到视口中间，场景末尾的截图才「可判」。 */
const SCROLL_TO_INLINE_SVG = `(() => {
  const svg = document.querySelector('.smb-figure__frame > svg');
  if (svg) svg.scrollIntoView({ block: 'center' });
})()`;

/* ── 页面上的几步操作（都靠真点击） ─────────────────────────────────────── */

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

const OPEN_QUIZ = `(() => {
  const btn = document.querySelector('[data-proto="toggle-quiz"]');
  if (btn) btn.click();
})()`;

/** 工作台 → 科目主页 → 课件页（+ 拉开右栏「题目」）。每一步都靠真点击，不碰内部状态。 */
async function enterLesson(ctx, { quiz = true } = {}) {
  await ctx.evaluate(OPEN_SUBJECT);
  await ctx.sleep(400);
  await ctx.evaluate(OPEN_LESSON);
  await ctx.sleep(500);
  if (quiz) {
    await ctx.evaluate(OPEN_QUIZ);
    await ctx.sleep(400);
  }
}

function setTheme(ctx, theme) {
  return ctx.evaluate(theme === 'dark'
    ? `document.body.setAttribute('data-ds-dark-theme', '')`
    : `document.body.removeAttribute('data-ds-dark-theme')`);
}

/* ── 跑 ────────────────────────────────────────────────────────────────── */

// 先起会话：找不到浏览器就直接跳过（退出码 3），别先造一堆临时目录再丢下不管
const session = await openSession({ suite: 'lesson-body', width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });

async function useViewport(viewport) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
  });
  await session.sleep(150);
}

/** 两档的读数存下来给最后那一场对账（「窄档不是宽档的截图」）。 */
const seen = {};

try {
  const { root, workspace } = makeWorkspace();
  const payload = readLibrary({ workspace });
  const fixture = buildFixture(root, payload);
  console.log(`夹具：${fixture}`);
  console.log(`数据：${workspace}（跑完删）`);

  for (const viewport of VIEWPORTS) {
    await useViewport(viewport);
    const narrow = viewport.key === 'narrow';
    const tag = '[' + viewport.key + ' ' + viewport.width + '×' + viewport.height + ']';

    /* ── 正文与页头（亮色） ──────────────────────────────────────────── */
    await session.scene('lesson-body-' + viewport.key, async (ctx) => {
      await ctx.navigate(fixture, { settle: 1200 });
      await enterLesson(ctx);
      const one = await ctx.evaluate(PROBE);
      seen[viewport.key] = one;

      check(`${tag} 进了课件页（长标题在正文里）`,
        one.doc.box && one.doc.box.w > 0 && String(one.bodyText).indexOf('变量与作用域') >= 0,
        JSON.stringify(one.bodyText).slice(0, 120));
      check(`${tag} 位图配图进了正文且真的加载出来了`,
        !!one.figure && !!one.figure.img && one.figure.img.scheme !== 'none' && one.figure.img.loaded,
        JSON.stringify(one.figure && one.figure.img));

      /* 条目 5：位图不超正文列宽；矢量图随列宽 */
      const imgW = one.figure.img.w;
      const column = one.doc.inner;
      check(`${tag} 位图配图不超正文列宽（图 ${imgW} ≤ 列 ${column}）`, imgW <= column + 1,
        `img=${imgW} doc=${column} natural=${one.figure.img.natural}`);
      check(`${tag} 位图是「缩到列宽」而不是「本来就小」（原图 ${one.figure.img.natural} 比列宽大）`,
        one.figure.img.natural > column, `${one.figure.img.natural} vs ${column}`);
      const svgW = one.vector ? one.vector.w : 0;
      check(`${tag} 矢量图随列宽流动（铺满图框内容宽 ${one.vector && one.vector.frameInner}，实际 ${svgW}；图上写的 width=900 被 CSS 压过）`,
        !!one.vector && one.vector.display === 'block' && Math.abs(svgW - one.vector.frameInner) <= 2,
        JSON.stringify(one.vector));
      check(`${tag} 矢量图保持自己的比例、没被拉伸或裁掉（高/宽 ${one.vector && one.vector.ratio} ≈ 300/900）`,
        !!one.vector && Math.abs(one.vector.ratio - 300 / 900) < 0.01, JSON.stringify(one.vector));
      check(`${tag} 矢量图也不超正文列宽（${svgW} ≤ ${column}）`,
        !!one.vector && svgW <= column + 1, `${svgW} vs ${column}`);

      /* 条目 11：代码块带语言标签、超长行在块内滚动 */
      check(`${tag} 代码块带语言标签`, one.code.lang === 'js', String(one.code.lang));
      check(`${tag} 超长代码行在块内横向滚动（内容 ${one.code.preScrollW} > 可见 ${one.code.preClientW}）`,
        one.code.whiteSpace === 'pre' && one.code.preScrollW > one.code.preClientW + 1,
        JSON.stringify(one.code));
      check(`${tag} 代码块本身不超正文列宽（${one.code.blockInner} ≤ ${column}）`,
        one.code.blockInner <= column + 1, `${one.code.blockInner} vs ${column}`);

      /* 条目 15：长标识符 / URL / 宽表格不撑出横向滚动条 */
      check(`${tag} 长标识符与长 URL 在段落里断行（段落不溢出：${one.longText.scrollW} ≤ ${one.longText.clientW}）`,
        !!one.longText && one.longText.scrollW <= one.longText.clientW + 1, JSON.stringify(one.longText));
      check(`${tag} 宽表格在自己那一层里横向滚动（内容 ${one.table.wrapScrollW} > 可见 ${one.table.wrapClientW}）`,
        !!one.table && one.table.wrapScrollW > one.table.wrapClientW + 1, JSON.stringify(one.table));
      check(`${tag} 页面级没有横向滚动条（${one.overflow.page}）`, one.overflow.page === 0, JSON.stringify(one.overflow));
      check(`${tag} 正文列自己也没有横向溢出（${one.overflow.center}）`, one.overflow.center === 0, JSON.stringify(one.overflow));

      /* 条目 14：正文只有一套字号 + 配套行高 */
      const missing = one.prose.filter((row) => row.missing);
      check(`${tag} 正文取样点全部命中（段落/列表/表格/引用/提示/练习/目标/题面/选项/解析）`,
        missing.length === 0, missing.map((row) => row.label).join('、'));
      const sizes = [...new Set(one.prose.map((row) => row.size))];
      check(`${tag} 一屏里成句的文字只有一种字号（${sizes.join('/')}px）`, sizes.length === 1, JSON.stringify(one.prose));
      const ratios = [...new Set(one.prose.map((row) => row.ratio))];
      check(`${tag} 行高跟着字号走（正文那一档 ${one.bodyTokens.line}，实测比值 ${ratios.join('/')}）`,
        ratios.length === 1 && Math.abs(ratios[0] - Number(one.bodyTokens.line)) < 0.01,
        JSON.stringify({ ratios, token: one.bodyTokens }));
      check(`${tag} 正文那一档字号就是 token 的值（${one.bodyTokens.size} = ${one.bodyTokens.fontSize}px）`,
        Number(one.bodyTokens.size.replace('px', '')) === one.bodyTokens.fontSize, JSON.stringify(one.bodyTokens));

      /* 条目 12：顶部只有一条，课件标题与小节跳转都在上面 */
      check(`${tag} 课件页顶栏只有一条（标题 + 小节 + 进度都在它里面）`,
        one.head.bars === 1 && one.head.hasName && one.head.hasSecs && one.head.hasMeta,
        JSON.stringify({ bars: one.head.bars, name: one.head.hasName, secs: one.head.hasSecs, meta: one.head.hasMeta }));
      check(`${tag} 小节跳转真的在顶部这条里（${one.head.secsCount} 个小节）`,
        one.head.secsCount >= 2 && one.head.secsBox.w > 0, JSON.stringify(one.head.secsBox));
      check(`${tag} 顶部这条不空着：内容从左边距铺到右边距（首块差 ${one.head.edge.leadIn}px、末块差 ${one.head.edge.trailIn}px、最大空隙 ${one.head.edge.maxGap}px）`,
        Math.abs(one.head.edge.leadIn) <= 1 && Math.abs(one.head.edge.trailIn) <= 1,
        JSON.stringify(one.head.edge));
      if (!narrow) {
        check('[wide] 课件标题与小节跳转在同一条线上（不是各占一条）',
          Math.abs(one.head.secsBox.y - one.head.nameBox.y) <= 8,
          JSON.stringify({ name: one.head.nameBox, secs: one.head.secsBox }));
      }

      /* 条目 13：面包屑长标题按全角字省略 */
      // 「有分寸」的下限：宽档至少留 12 个中文字、窄档至少 8 个。按 ch 算的那一版只有约 10 个字
      // （ch 是数字宽的一半），宽档这一条就会红——这正是「按字算不按字母算」的机器判据。
      check(`${tag} 面包屑真的砍掉了字、又没砍秃（全文 ${one.crumb.text.length} 字，露出来 ${one.crumb.visible} 字）`,
        one.crumb.visible < one.crumb.text.length && one.crumb.visible >= (narrow ? 8 : 12)
        && one.crumb.textOverflow === 'ellipsis' && one.crumb.overflow === 'hidden',
        JSON.stringify(one.crumb));
      check(`${tag} 面包屑的上限是「几个全角字」的整数（${one.crumb.limitEm}em = ${one.crumb.maxWidth}）`,
        Number.isInteger(one.crumb.limitEm) && one.crumb.limitEm >= 12, JSON.stringify(one.crumb));

      /* 条目 16：正文里的题目标记看得出属于哪一组 */
      const numbers = one.markers.map((row) => row.no);
      const groupNumbers = one.groups.map((row) => row.no);
      check(`${tag} 每条题目标记都带组号，组号与右栏那一组的编号对得上`,
        one.markers.length === 3 && JSON.stringify(numbers) === JSON.stringify(['1', '2', '3'])
        && JSON.stringify(numbers) === JSON.stringify(groupNumbers),
        JSON.stringify({ markers: numbers, groups: groupNumbers }));
      check(`${tag} 标记上还带着这一组的锚点原文与题数`,
        one.markers.every((row) => !!row.text && !!row.count) && one.markers[0].badge === '练习',
        JSON.stringify(one.markers));

      return {
        viewport: viewport.key, size: [one.width, viewport.height],
        docInner: one.doc.inner, figure: one.figure, code: one.code,
        longText: one.longText, table: one.table, overflow: one.overflow,
        prose: one.prose, bodyTokens: one.bodyTokens, head: one.head, crumb: one.crumb,
        markers: one.markers, groups: one.groups,
      };
    });

    /* ── 正文里的题目标记（条目 16）：这一张截图专门给「一眼看得出属于哪一组」 ── */
    await session.scene('lesson-body-' + viewport.key + '-markers', async (ctx) => {
      await ctx.navigate(fixture, { settle: 1200 });
      await enterLesson(ctx);
      await ctx.evaluate(`(() => {
        const marker = document.querySelector('[data-proto="quiz-marker"]');
        if (marker) marker.scrollIntoView({ block: 'center' });
      })()`);
      await ctx.sleep(500);
      const marks = await ctx.evaluate(`(() => {
        const all = Array.from(document.querySelectorAll('[data-proto="quiz-marker"]'));
        const circle = document.querySelector('.smb-qmark__no');
        const groupNo = document.querySelector('.smb-agroup__no');
        const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
          return [Math.round(r.width), Math.round(r.height)]; };
        return {
          count: all.length,
          inView: all.filter((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }).length,
          rows: all.map((el) => ({
            no: el.querySelector('.smb-qmark__no').textContent.trim(),
            chip: el.querySelector('.smb-qmark__badge').textContent.trim(),
            text: el.querySelector('.smb-qmark__text').textContent.trim(),
            count: el.querySelector('.smb-qmark__n').textContent.trim(),
          })),
          circle: box(circle), groupNo: box(groupNo),
        };
      })()`);

      check(`${tag} 题目标记滚进了视口（这一张截图专门看分组）`, marks.inView >= 1 && marks.count === 3,
        JSON.stringify(marks.rows));
      check(`${tag} 每条标记都写着「练习」+ 组号 + 这一组的锚点原文 + 题数`,
        marks.rows.every((row) => row.chip === '练习' && /^\d+$/.test(row.no) && !!row.text && /题$/.test(row.count)),
        JSON.stringify(marks.rows));
      check(`${tag} 正文标记的组号圆圈与右栏组号同尺寸（${marks.circle} vs ${marks.groupNo}）`,
        JSON.stringify(marks.circle) === JSON.stringify(marks.groupNo)
        && marks.circle[0] > 0, JSON.stringify({ marker: marks.circle, group: marks.groupNo }));

      return { viewport: viewport.key, size: [viewport.width, viewport.height], marks };
    });

    /* ── 暗色：白底配图不刺眼 ────────────────────────────────────────── */
    await session.scene('lesson-body-' + viewport.key + '-dark', async (ctx) => {
      await ctx.navigate(fixture, { settle: 1200 });
      await setTheme(ctx, 'dark');
      await ctx.sleep(200);
      await enterLesson(ctx);
      const dark = await ctx.evaluate(PROBE);
      const light = seen[viewport.key];
      const themeTag = `[dark·${viewport.key}]`;

      const svgFilter = (one) => (one.vector ? one.vector.filter : 'none');
      check(`${themeTag} 位图配图在暗色下被压暗（${light.figure.img.filter} → ${dark.figure.img.filter}）`,
        brightness(dark.figure.img.filter) < brightness(light.figure.img.filter)
        && brightness(dark.figure.img.filter) < 1,
        JSON.stringify({ light: light.figure.img.filter, dark: dark.figure.img.filter }));
      check(`${themeTag} 矢量图在暗色下同样被压暗（${svgFilter(light)} → ${svgFilter(dark)}）`,
        !!dark.vector && brightness(dark.vector.filter) < brightness(svgFilter(light))
        && brightness(dark.vector.filter) < 1,
        JSON.stringify({ light: svgFilter(light), dark: svgFilter(dark) }));
      check(`${themeTag} 亮色下不压暗（默认不给图加滤镜）`,
        brightness(light.figure.img.filter) === 1 && brightness(svgFilter(light)) === 1,
        JSON.stringify({ img: light.figure.img.filter, svg: svgFilter(light) }));
      check(`${themeTag} 暗色下正文列与页面依旧没有横向溢出（${dark.overflow.center} / ${dark.overflow.page}）`,
        dark.overflow.center === 0 && dark.overflow.page === 0, JSON.stringify(dark.overflow));

      return {
        viewport: viewport.key, theme: 'dark', size: [dark.width, viewport.height],
        figureFilter: { img: dark.figure.img.filter, svg: svgFilter(dark) },
        lightFilter: { img: light.figure.img.filter, svg: svgFilter(light) },
        overflow: dark.overflow,
      };
    });

    /* ── 内联矢量图（#97）：课件里的 `::: svg` 真被客户端贴出来了 ──────────
       这一场就是「把句号画上」的那一场。之前这一面**零浏览器覆盖**：夹具内容里没有 `::: svg`，
       而 mini-react 每次重渲染整树重建 DOM、effect 不重跑，SvgFrame 用 innerHTML 贴进去的
       SVG 活不过下一次重渲染；所以主场景里那条「矢量图随列宽流动」量的是**现造的同形状元素**，
       只证明 CSS 规则写得对，证明不了客户端真的把块里的图形贴了上去。
       这里把 `::: svg` 写进夹具内容，断言全部打在**真渲染出来的那个 <svg>**上：
       它在、里面有内容文件里的图形、随列宽流动、暗色下被压暗。 */
    await session.scene('lesson-body-' + viewport.key + '-svg', async (ctx) => {
      await ctx.navigate(fixture, { settle: 1200 });
      await enterLesson(ctx);
      await ctx.evaluate(SCROLL_TO_INLINE_SVG);
      await ctx.sleep(300);
      const light = await ctx.evaluate(SVG_PROBE);

      check(`${tag} 课件里的 ::: svg 渲染成了一个真 SVG 元素、不是空壳（图形 ${light && light.shapes} 个，弧线 d=${light && light.pathD}）`,
        !!light && light.ns === 'http://www.w3.org/2000/svg'
        && light.shapes >= 3 && light.pathD === INLINE_SVG_PATH,
        JSON.stringify(light && { ns: light.ns, shapes: light.shapes, d: light.pathD }));
      check(`${tag} 贴进来的是块里那张图：viewBox 与属性宽高原样在（${light && light.viewBox} / width=${light && light.attrWidth}）`,
        !!light && light.viewBox === '0 0 900 300' && light.attrWidth === '900', JSON.stringify(light && {
          viewBox: light.viewBox, width: light.attrWidth, height: light.attrHeight }));
      check(`${tag} 图框按 alt: 报出角色与标签（role=${light && light.frameRole} label=${light && light.frameLabel}）`,
        !!light && light.frameRole === 'img'
        && light.frameLabel === '名字与值之间的一条连线（内联矢量图）',
        JSON.stringify(light && { role: light.frameRole, label: light.frameLabel }));
      check(`${tag} 内联图与位图共用一条编号序列（这一张是图 2：${light && light.caption}）`,
        !!light && /^图 2 · /.test(String(light.caption)), String(light && light.caption));
      check(`${tag} 内联 SVG 随列宽流动、又不超列宽（铺满 ${light && light.frameInner}、实际 ${light && light.w}、列 ${light && light.docInner}）`,
        !!light && light.display === 'block' && light.w > 0
        && Math.abs(light.w - light.frameInner) <= 2 && light.w <= light.docInner + 1,
        JSON.stringify(light && { w: light.w, frameInner: light.frameInner, docInner: light.docInner }));
      check(`${tag} 比例来自 viewBox、没被拉伸也没被裁掉（高/宽 ${light && light.ratio} ≈ 300/900）`,
        !!light && Math.abs(light.ratio - 300 / 900) < 0.01, JSON.stringify(light && { ratio: light.ratio }));
      check(`${tag} 内联 SVG 亮色下不压暗（${light && light.filter}）`,
        !!light && brightness(light.filter) === 1, String(light && light.filter));

      await setTheme(ctx, 'dark');
      await ctx.sleep(250);
      const dark = await ctx.evaluate(SVG_PROBE);
      check(`${tag} 内联 SVG 暗色下被压暗（${light && light.filter} → ${dark && dark.filter}）`,
        !!dark && brightness(dark.filter) < 1 && brightness(dark.filter) < brightness(light.filter),
        JSON.stringify({ light: light && light.filter, dark: dark && dark.filter }));
      check(`${tag} 内联 SVG 在暗色下依旧不撑破页面（横向溢出 ${dark && dark.overflow}）`,
        !!dark && dark.overflow === 0 && dark.w <= dark.docInner + 1,
        JSON.stringify(dark && { overflow: dark.overflow, w: dark.w, docInner: dark.docInner }));

      return {
        viewport: viewport.key, size: [viewport.width, viewport.height],
        light: light && { w: light.w, h: light.h, ratio: light.ratio, frameInner: light.frameInner,
          shapes: light.shapes, pathD: light.pathD, viewBox: light.viewBox, filter: light.filter },
        dark: dark && { filter: dark.filter, overflow: dark.overflow, w: dark.w },
      };
    });
  }

  /* ── 两档对账：窄档不是宽档的截图 ─────────────────────────────────── */
  await session.scene('lesson-body-compare', async (ctx) => {
    const wide = seen.wide;
    const narrow = seen.narrow;
    check('两档的读数都取到了（窄档跑在宽档之后）', !!wide && !!narrow);
    if (wide && narrow) {
      check('两档的正文列宽确实不同（窄档不是宽档的截图）',
        wide.doc.inner > narrow.doc.inner + 100, `${wide.doc.inner} vs ${narrow.doc.inner}`);
      check('矢量图在两档下跟着列宽变（同一张图，宽档更宽）',
        !!wide.vector && !!narrow.vector && wide.vector.w > narrow.vector.w + 50,
        `${wide.vector && wide.vector.w} vs ${narrow.vector && narrow.vector.w}`);
      check('面包屑的窄档覆盖真的生效了（两档的上限不同）',
        wide.crumb.maxWidth !== narrow.crumb.maxWidth,
        `wide=${wide.crumb.maxWidth} narrow=${narrow.crumb.maxWidth}`);
      check('窄档的段落更窄，但长标识符依旧不把段落顶宽',
        narrow.longText.scrollW <= narrow.longText.clientW + 1 && narrow.doc.inner < wide.doc.inner,
        JSON.stringify({ narrow: narrow.longText, wide: wide.longText }));
      check('两档下面包屑都留下了足够多的中文字（宽档 ' + wide.crumb.visible + ' 字、窄档 ' + narrow.crumb.visible + ' 字）',
        wide.crumb.visible >= 12 && narrow.crumb.visible >= 8,
        JSON.stringify({ wide: wide.crumb, narrow: narrow.crumb }));
      check('两档下面包屑都是同一句长标题（省略的是同一段文字）',
        wide.crumb.text === narrow.crumb.text && wide.crumb.text.length >= 15, String(wide.crumb.text));
    }
    await ctx.navigate(fixture, { settle: 800 });   // 这一场只为对账，别留一张空白页
    return wide && narrow ? {
      docInner: { wide: wide.doc.inner, narrow: narrow.doc.inner },
      svg: { wide: wide.vector && wide.vector.w, narrow: narrow.vector && narrow.vector.w },
      crumb: { wide: wide.crumb, narrow: narrow.crumb },
      proseSizes: {
        wide: [...new Set(wide.prose.map((row) => row.size))],
        narrow: [...new Set(narrow.prose.map((row) => row.size))],
      },
    } : {};
  });
} catch (error) {
  check('课件页正文套件跑完（浏览器起来、夹具能开）', false, String(error));
  await session.scene('lesson-body-error', async (ctx) => { ctx.note('harness', String(error)); });
}

console.log(failures ? `\n${failures} 条失败` : '\n全部通过');
await finishSuite(session, { suite: 'lesson-body', failed: failures });
for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
