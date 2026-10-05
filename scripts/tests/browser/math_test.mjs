/* 公式排版（#91）· **真浏览器里排版、按需加载、降级与报错**
   ────────────────────────────────────────────────────────────────────────────────
   跑法：`node scripts/tests/browser/math_test.mjs`（或 `npm run test:browser`）。
   浏览器二进制由 harness 探测；找不到时明确跳过（退出码 3），不是静默绿。

   这一套要的是**真排版**：夹具是一个说 HTTP 的迷你宿主（照 attempts_test.mjs 的骨架），
   它把**包里那份 KaTeX dist** 按 `lib/math-route.ts` 注册出来的路由原样投送（注册走真
   `registerMathRoute`，所以这里也在验「路由真的挂得上、路径与字节都对」）。页面跑的是真
   `lib/client.js` + mini-react。

   五个场景各对一条验收：
     · `math-prose`：正文的行内与块级公式**排出来了**（.katex 在、字体真的加载、TeX 不在外面）；
     · `math-question-only`：正文一个公式都没有，公式只出现在**题面与选项**里——打开题库那一刻
       才去取资源（判据把题库字段算进去了），并且坏公式给一句明确的错、TeX 原文仍可读；
     · `no-math`：整页没有数学式 → **一条公式资源的请求都不发**（判据是服务端的请求日志，
       不是 performance entries——`file://` 下那份读数是空的，这条教训记在勘察里）；
     · `math-missing`：资源缺失（宿主说「没备好」）→ 降级成可读 TeX + 一句人话，页面不空白；
     · `math-broken`：排版失败（LaTeX 本身坏了）→ 同一句人话，且不影响别的公式。

   为什么「资源缺失」那场要摘掉两条问题：一台装坏了 KaTeX 的机器**本来**就会在控制台留一条
   404/加载失败的记录。这一场判的是「这时候学生看到什么」，所以把那几条**预期内**的记录认下来
   （先断言它们确实出现过），剩下的问题照旧算数——不是把问题清单清空。
   ──────────────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readLibrary } from '../../../lib/library.ts';
import { registerMathRoute } from '../../../lib/math-route.ts';
import { extractCss } from '../fixtures/client-css.mjs';
import { writeSubject } from '../fixtures/tools.mjs';
import { openSession, finishSuite } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

let failures = 0;
function check(label, ok, detail = '') {
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}

/* ── 现造一份工作区：三门课件各管一条判据（跑完即弃，ADR-0009 不存样例数据）─────────
   · `公式`：正文行内 + 块级公式；
   · `无公式`：整页一个数学式都没有（老课件 / 非数学课）；
   · `题面`：正文没有公式，公式只在题面与选项里（还有一个 LaTeX 坏掉的题）。 */

const MATH_LESSON = [
  '---', 'title: 公式', 'goal: 排出来。', '---', '',
  '## 一节', '',
  '行内公式 $a^2 + b^2 = c^2$ 与文字排在一起。', '',
  '$$', 'E = mc^2', '$$', '',
  '::: quiz 理解 锚点：公式题', ':::',
  '',
].join('\n');

const PLAIN_LESSON = [
  '---', 'title: 无公式', 'goal: 一个数学式都没有。', '---', '',
  '## 一节', '',
  '这一段里没有任何公式，价格写成 5 元，代码写成 `x = 5`。', '',
  '::: quiz 理解 锚点：普通题', ':::',
  '',
].join('\n');

const QUESTION_LESSON = [
  '---', 'title: 题面', 'goal: 公式只在题面里。', '---', '',
  '## 一节', '',
  '正文这一段**没有**数学式；公式只写在题面与选项里。', '',
  '::: quiz 理解 锚点：题面题', ':::',
  '',
].join('\n');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-math-'));
  const workspace = path.join(root, '学习资料');
  const nodes = [{ id: '公式', title: '公式' }, { id: '无公式', title: '无公式' }, { id: '题面', title: '题面' }];
  const { dir } = writeSubject(workspace, 'math', {
    nodes, lesson: MATH_LESSON, pool: null, secondLesson: false,
  });
  const lessons = path.join(dir, 'lessons');
  fs.writeFileSync(path.join(lessons, '0001-公式.quiz.json'), JSON.stringify({
    公式题: [{ kind: '客观题', q: '算一算 $x^2 = 4$。', opts: ['$x = 2$', '$x = -2$', '都不是'], ans: 0, why: '两个根。' }],
  }, null, 2));
  fs.writeFileSync(path.join(lessons, '0002-无公式.md'), PLAIN_LESSON);
  fs.writeFileSync(path.join(lessons, '0002-无公式.quiz.json'), JSON.stringify({
    普通题: [{ kind: '客观题', q: '5 元能买几个？', opts: ['一个', '两个', '三个'], ans: 0, why: '单价就是 5 元。' }],
  }, null, 2));
  fs.writeFileSync(path.join(lessons, '0003-题面.md'), QUESTION_LESSON);
  fs.writeFileSync(path.join(lessons, '0003-题面.quiz.json'), JSON.stringify({
    题面题: [
      { kind: '客观题', q: '解方程 $x^2 = 4$ 得到什么？', opts: ['$x = \\pm 2$', '$x = 2$ 一个', '无解'], ans: 0, why: '开方要带正负。' },
      // 坏 LaTeX（少了收尾的 `}`）：内容层的确定性错误抓不到它（`$` 是配对的），
      // 只有排版那一步会失败——正是「排版失败给一句明确的错」那条要验的输入。
      { kind: '客观题', q: '这一段 $\\frac{1}$ 排不出来。', opts: ['甲', '乙'], ans: 0, why: '坏公式。' },
    ],
  }, null, 2));
  return { root, workspace };
}

/* ── 夹具页 ────────────────────────────────────────────────────────────── */

function fixtureHtml() {
  const css = extractCss(fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8'));
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>StudyMate 公式排版 QA</title>
<style>html, body { margin: 0; height: 100%; } #root { height: 100%; }</style>
<style id="plugin-css">${css}</style>
<script>
  window.__StudymateSpec = null;
  window.__ModuleLoader__ = { load: function (spec) { window.__StudymateSpec = spec; } };
</script>
</head>
<body>
<div id="root"></div>
<script src="/mini-react.js"></script>
<script src="/client.js"></script>
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
}

/* ── 迷你宿主：library 现读；公式资源走**真的** registerMathRoute ────────── */

async function startHost(workspace) {
  const mathRoutes = [];
  registerMathRoute({
    inject: (names, handler) => handler({
      connection: { fetch: { register: (route) => { mathRoutes.push(route); return () => {}; } } },
      effect: (fn) => fn(),
    }),
  });
  const requests = [];
  const state = { missing: false };
  const html = fixtureHtml();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ path: url.pathname });
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    try {
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (url.pathname === '/fixture.html' || url.pathname === '/') return send(200, html, 'text/html; charset=utf-8');
      if (url.pathname === '/client.js') return send(200, fs.readFileSync(path.join(ROOT, 'lib', 'client.js')), 'text/javascript; charset=utf-8');
      if (url.pathname === '/mini-react.js') return send(200, fs.readFileSync(path.join(HERE, '..', 'fixtures', 'mini-react.js')), 'text/javascript; charset=utf-8');
      if (url.pathname === '/api/studymate/library') {
        return send(200, JSON.stringify(readLibrary({ workspace })), 'application/json; charset=utf-8');
      }
      if (url.pathname === '/api/studymate/events') {
        // 阅读端挂载即订阅推送。这一套验的是公式，推送不在它的验收面上——但夹具是真 HTTP
        // 宿主，客户端发的每条请求都得有个正当落点，不然浏览器会记一条 404 把场景判红。
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write(': studymate 夹具：变更推送不在这一套的验收面上\n\n');
        res.on('close', () => { if (!res.writableEnded) res.end(); });
        return;
      }
      if (url.pathname === '/api/studymate/attempts') {
        return send(403, JSON.stringify({ error: { code: 'read-only', message: '夹具不落盘' } }), 'application/json; charset=utf-8');
      }
      const route = mathRoutes.find((one) => one.path === url.pathname);
      if (route) {
        // 「包里的资源没装上」那一种状态：路由在，文件取不到（`mathAssetFile` 会给 404）。
        // 这里直接短路成 404，模拟学生机器上装坏了的包。
        if (state.missing) return send(404, 'not found', 'text/plain');
        const response = await route.fetch(new Request(`http://127.0.0.1${url.pathname}`));
        return send(response.status, Buffer.from(await response.arrayBuffer()),
          response.headers.get('content-type') || 'application/octet-stream');
      }
      return send(404, 'not found', 'text/plain');
    } catch (error) {
      return send(500, String((error && error.stack) || error), 'text/plain');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    state,
    mathRequests: () => requests.filter((one) => one.path.startsWith('/api/studymate/math/')).map((one) => one.path),
    reset: () => { requests.length = 0; },
    // 关掉那条 SSE（阅读端挂着不放手）：不掐掉它 server.close() 会一直等，收尾就卡在这里——
    // 症状是套件跑完什么都不打印（踩过）。
    close: async () => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/* ── 页面里的探针与操作 ────────────────────────────────────────────────── */

/** 打开某一课：主页 → 科目 → 第 n 个节点（n 从 0 起）。 */
const openNode = (index) => `(() => {
  const course = document.querySelector('[data-proto="nav-subject"]');
  if (course) course.click();
  return 'subject';
})()`;
const clickNode = (index) => `(() => {
  const nodes = Array.from(document.querySelectorAll('[data-proto="open-node"]'));
  if (!nodes[${index}]) return 'no-node-' + nodes.length;
  nodes[${index}].click();
  return 'ok';
})()`;
const openQuiz = `(() => {
  const toggle = document.querySelector('[data-proto="toggle-quiz"]');
  if (!toggle) return 'no-toggle';
  toggle.click();
  return 'ok';
})()`;

const MATH_PROBE = `(() => {
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const texOf = (el) => (el ? (el.querySelector('annotation[encoding="application/x-tex"]') || {}).textContent : null);
  const block = q('.smb-math-block');
  const inline = q('.smb-math');
  const bad = qa('.smb-math__bad').map((el) => el.textContent.trim());
  return {
    docText: ((q('.smb-doc') || document.body).textContent || '').slice(0, 120),
    docBlocks: qa('.smb-doc > *').length,
    inlineKatex: !!(inline && inline.querySelector('.katex')),
    inlineTex: texOf(inline),
    blockKatex: !!(block && block.querySelector('.katex')),
    blockTex: texOf(block),
    blockRaw: block ? !block.querySelector('.katex') : null,
    questionKatex: qa('.smb-q__text .katex').length,
    optionKatex: qa('.smb-opt .katex').length,
    bad,
    // 右栏渲染出来的题目数（题面/选项里的公式就在它们里面）
    qCount: qa('.smb-q').length,
    fontMain: document.fonts ? document.fonts.check('16px KaTeX_Main') : null,
    mathStylesheet: qa('link[data-smb-math]').map((el) => el.getAttribute('href')),
  };
})()`;

/* ── 跑 ────────────────────────────────────────────────────────────────── */

const { root, workspace } = makeWorkspace();
const host = await startHost(workspace);
const entry = `http://127.0.0.1:${host.port}/fixture.html`;
console.log(`夹具：${entry}（工作区现造在临时目录，跑完删）`);

const session = await openSession({ suite: 'math' });
/* mini-react 每次重画都**整树重建 DOM**，而 `LessonPage` 的 ResizeObserver effect 把
   `.smb-lesson` 那个节点闭在里面（真 React 里节点不换，所以那样写是对的）：重建之后观察者
   回调读到的是已脱离文档的旧节点 → 宽 0 → 两条栏永远收起，右栏的题目就点不到。这是夹具边界
   不是客户端缺陷（同一条账记在 attempts_test.mjs 与 reading_test.mjs）。换成不回调的空实现：
   effect 里那次 measure() 仍然打头跑一次、量到的是真布局。 */
await session.inject('window.ResizeObserver = function () { this.observe = function () {}; this.unobserve = function () {}; this.disconnect = function () {}; };');
try {
  /* ① 正文的行内与块级公式排出来了 */
  await session.scene('math-prose', async (ctx) => {
    host.reset();
    await ctx.navigate(entry, { settle: 1200 });
    await ctx.evaluate(openNode(0));
    await ctx.sleep(400);
    await ctx.evaluate(clickNode(0));
    await ctx.sleep(1200);
    const seen = await ctx.evaluate(MATH_PROBE);
    check('行内公式排出来了（.katex 在 .smb-math 里）', seen.inlineKatex === true, JSON.stringify(seen.inlineTex));
    check('块级公式排出来了，不是 TeX 原文', seen.blockKatex === true && seen.blockRaw === false,
      JSON.stringify([seen.blockKatex, seen.blockRaw]));
    check('排的还是正文那两处公式', /a\^2\s*\+\s*b\^2/.test(String(seen.inlineTex)) && /E\s*=\s*mc/.test(String(seen.blockTex)),
      JSON.stringify([seen.inlineTex, seen.blockTex]));
    check('KaTeX 的字体真的加载了（不是兜底字形）', seen.fontMain === true, String(seen.fontMain));
    const asked = host.mathRequests();
    check('按需加载：这时才去取公式资源（样式表 + 引擎 + 字体）',
      asked.some((p) => p.endsWith('/katex.min.css')) && asked.some((p) => p.endsWith('/katex.min.js')),
      JSON.stringify(asked));
    check('字体文件也取了（排版真的用上了那套字形）',
      asked.some((p) => p.startsWith('/api/studymate/math/fonts/')), JSON.stringify(asked));
    return seen;
  });

  /* ② 公式只出现在题面与选项里：打开题库那一刻才取资源；坏公式给一句人话 */
  await session.scene('math-question-only', async (ctx) => {
    host.reset();
    await ctx.navigate(entry, { settle: 1200 });
    await ctx.evaluate(openNode(0));
    await ctx.sleep(400);
    await ctx.evaluate(clickNode(2));
    await ctx.sleep(1000);
    const before = host.mathRequests();
    const closed = await ctx.evaluate(MATH_PROBE);
    check('正文没有数学式时，一进课件页不取公式资源', before.length === 0, JSON.stringify(before));
    check('右栏没打开时不排版（也就没有请求）', closed.questionKatex === 0, String(closed.questionKatex));

    check('题库打得开', (await ctx.evaluate(openQuiz)) === 'ok');
    await ctx.sleep(1200);
    const after = await ctx.evaluate(MATH_PROBE);
    check('题面里的公式排出来了（判据把题库字段算进去了）', after.questionKatex >= 1, JSON.stringify(after));
    check('选项里的公式也排出来了', after.optionKatex >= 2, JSON.stringify(after.optionKatex));
    const asked = host.mathRequests();
    check('资源是在打开题库那一刻才取的', asked.some((p) => p.endsWith('/katex.min.js')), JSON.stringify(asked));
    check('坏公式给一句明确的错，TeX 原文仍可读',
      after.bad.length >= 1 && after.bad.every((text) => text.startsWith('公式没排出来：')),
      JSON.stringify(after.bad));
    check('坏公式不影响别的公式（同页其它公式照排）', after.questionKatex >= 1 && after.optionKatex >= 2,
      JSON.stringify([after.questionKatex, after.optionKatex]));
    return { before, after };
  });

  /* ③ 整页没有数学式：一条公式资源的请求都不发 */
  await session.scene('no-math', async (ctx) => {
    host.reset();
    await ctx.navigate(entry, { settle: 1200 });
    await ctx.evaluate(openNode(0));
    await ctx.sleep(400);
    await ctx.evaluate(clickNode(1));
    await ctx.sleep(900);
    await ctx.evaluate(openQuiz);
    await ctx.sleep(600);
    const seen = await ctx.evaluate(MATH_PROBE);
    const asked = host.mathRequests();
    check('页面里一个数学元素都没有', seen.inlineKatex === false && seen.blockKatex === false && seen.questionKatex === 0,
      JSON.stringify([seen.inlineKatex, seen.blockKatex, seen.questionKatex]));
    check('零请求：没有数学式的页面不加载公式资源', asked.length === 0, JSON.stringify(asked));
    check('页面照常渲染（不是空白）', seen.docBlocks > 0 && String(seen.docText).includes('没有任何公式'),
      JSON.stringify([seen.docBlocks, seen.docText]));
    return seen;
  });

  /* ④ 资源缺失：降级成可读 TeX + 一句人话，页面不空白 */
  await session.scene('math-missing', async (ctx) => {
    host.reset();
    host.state.missing = true;
    try {
      await ctx.navigate(entry, { settle: 1200 });
      await ctx.evaluate(openNode(0));
      await ctx.sleep(400);
      await ctx.evaluate(clickNode(0));
      await ctx.sleep(1500);
      const seen = await ctx.evaluate(MATH_PROBE);
      check('资源缺失时降级成**可读的 TeX 原文**，不是空白',
        seen.blockRaw === true && String(seen.blockTex || '').length === 0
        && String(seen.docText).length > 0, JSON.stringify([seen.blockRaw, seen.docText]));
      check('并且给了一句能照着排查的错', seen.bad.length >= 1 && /公式没排出来：/.test(seen.bad[0]),
        JSON.stringify(seen.bad));
      return seen;
    } finally {
      host.state.missing = false;
    }
  });

  /* ⑤ 收尾：把「资源缺失」那场里**预期内**的失败记录认下来——它们正是那一场要模拟的现象：
     404 会记成一条 console 错误（文本里有 URL），没回来的那两条会记成 requestfailed。这一场判
     的是「这时候学生看到什么」，所以先把这些记录认下来（并断言它们确实出现过），其余照旧算数。
     **不是**把问题清单清空。 */
  const missingScene = session.scenes.get('math-missing');
  if (missingScene) {
    const expected = missingScene.problems.filter((one) => one.kind === 'requestfailed' || /katex\.min/.test(one.text));
    missingScene.problems = missingScene.problems.filter((one) => !expected.includes(one));
    if (expected.length === 0) {
      failures += 1;
      console.log('FAIL  资源缺失那一场应当留下加载失败的记录（它正是这一场的现象）');
    } else {
      console.log(`（math-missing：认下 ${expected.length} 条预期内的资源加载失败记录）`);
    }
  }
} finally {
  await host.close();
  fs.rmSync(root, { recursive: true, force: true });
  await finishSuite(session, { suite: 'math', failed: failures });
}
