/* 验收 #72 · 真浏览器里走一遍「作答 → 落盘 → 刷新仍在 → 别人改过之后再作答」
   ────────────────────────────────────────────────────────────────────────────────
   这一条把**真的 lib/client.js**（无打包、原样发货的那份）挂在夹具页里，用**真的 HTTP**
   打到**真的 Host 半**（`lib/attempts-route.ts` 注册出来的那条路由 + `lib/attempts.ts` 写盘），
   落到**真的工作区文件**上。夹具页与 mini-react 借用 #75 的浏览器 QA 骨架
   （`scripts/tests/browser/harness.mjs` + `fixtures/mini-react.js`），浏览器二进制探测不到就
   明确跳过（退出码 3），不是静默绿。

   为什么非要有这一条：Node 侧那套（test_client_attempt_fence.mjs）驱动的是工厂闭包里的
   纯逻辑与写队列——**React 接线不在覆盖里**（桩的 useEffect 根本不跑）。而这条验收要的
   「点一下 → 落盘 → 刷新页面「上次选了 X」还在 → 冲突如实告诉学生」全在接线那一层，
   只有真浏览器跑得出来。

   三个场景（对应 #72 的验收标准）：
     · attempts-write   点选项 → POST 的形状、回执覆盖到界面、磁盘上那一份
     · attempts-reload  真的重新导航一次（= 刷新页面）→「上次选了 A，对了」来自磁盘
     · attempts-conflict 另一个写入者改过之后再作答 → 409 拒绝 → 按回执里的版本重来一次 →
                        界面如实说、两条历史都在、谁的数据都没丢

   数据现造现弃（临时工作区 + 临时 HOME），跑完即删；仓库里不存样例数据。

   唯一一处不是「真」的：`/plugins/studymate/events`（#74 的变更推送）。阅读端挂载即订阅它，
   而推送不在这一套的验收面上，所以迷你宿主只回一条不推数据的 text/event-stream——
   让那条请求有个正当落点，不至于在「控制台/失败请求」那一项上把这一套判红。
   推送本身在 watch_push_test.mjs 与真 DSH 探针里验。
*/
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { attemptsVersion, writeAttempts } from '../../../lib/attempts.ts';
import { readLibrary } from '../../../lib/library.ts';
import { registerAttemptRoutes } from '../../../lib/attempts-route.ts';
import { extractCss } from '../fixtures/client-css.mjs';
import { openSession, finishSuite } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

let failures = 0;
function check(label, ok, detail = '') {
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}

/* ── 临时工作区 + 临时 HOME（resolveWorkspace 只认 DSH_HOME 下那份配置）───────── */

const TEMPS = [];

const NODE_ID = 'fn.call';           // 节点 id 的写法与 curriculum.schema.json 一致（ASCII）
const ANCHOR = '函数的调用';
const QUESTION = ANCHOR + '#0';
const CONFLICT_HISTORY_TEXT = '更早提交的版本。';

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-attempts-'));
  TEMPS.push(root);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'ws');
  const subjectDir = path.join(workspace, '.learning', 'subjects', 'demo');
  fs.mkdirSync(path.join(subjectDir, 'lessons'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'studymate-config.yaml'), `workspace: ${JSON.stringify(workspace)}\n`);
  fs.writeFileSync(path.join(subjectDir, 'subject.yaml'),
    'slug: demo\nname: 演示科目\ngoal: 在真浏览器里把作答落盘走一遍\nstatus: 学习中\n');
  fs.writeFileSync(path.join(subjectDir, 'curriculum.yaml'),
    `nodes:\n  - id: ${NODE_ID}\n    title: 函数调用\n    kind: 概念\n    objective: 说清调用是什么\n`);
  fs.writeFileSync(path.join(subjectDir, 'progress.yaml'),
    'updated_at: "2026-05-06T07:08:09+08:00"\nnodes:\n  fn.call:\n    status: 学习中\nproject:\n  current: ""\n');
  fs.writeFileSync(path.join(subjectDir, 'lessons', `0001-${NODE_ID}.md`),
    `# 函数调用\n\n函数是一段可复用的调用。\n\n::: quiz 理解 锚点：${ANCHOR}\n:::\n`);
  fs.writeFileSync(path.join(subjectDir, 'lessons', `0001-${NODE_ID}.quiz.json`), JSON.stringify({
    [ANCHOR]: [
      { q: '调用时发生的第一件事是什么？', opts: ['名字解析到函数', '参数被求值两次'], ans: 0, why: '先解析到函数，再谈参数。' },
      { q: '举一个调用栈被撑爆的例子。', answer: '无限递归。', criteria: '提到递归且没有基线条件。' },
    ],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(subjectDir, 'misconceptions.yaml'), '[]\n');
  return { root, home, workspace, subjectDir };
}

/* ── 夹具页 + 一个说 HTTP 的迷你宿主 ────────────────────────────────────
   页面上**不 stub fetch**：请求真的发到本进程起的 http 服务上；POST 那一跳走的是
   `registerAttemptRoutes` 注册出来的真路由（不是直接调 handler）。 */

function hostTokenCss() {
  const snapshot = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'host-theme-tokens.json'), 'utf8'));
  const block = (table) => Object.entries(table).map(([name, value]) => `${name}:${value}`).join(';');
  return [
    `body{${block(snapshot.light)}}`,
    `body[data-ds-dark-theme]{${block(snapshot.dark)}}`,
    'body{background-color:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
  ].join('\n');
}

function fixtureHtml() {
  const css = extractCss(fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8'));
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>StudyMate 作答落盘 QA</title>
<style>html, body { margin: 0; height: 100%; } #root { height: 100%; }
${hostTokenCss()}</style>
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

/** 迷你宿主：library 现读，attempts 交给真路由；POST 与回执都记下来给断言用。 */
async function startHost(workspace) {
  const routes = [];
  // 注册约定：收外层 ctx、自己 inject(['connection'])（与 registerAskSessionRoute 同一姿势）
  registerAttemptRoutes({
    inject: (names, handler) => handler({
      connection: { fetch: { register: (route) => { routes.push(route); return () => {}; } } },
      effect: (fn) => fn(),
    }),
  });
  const route = routes[0];
  const posts = [];
  const eventClients = new Set();
  const html = fixtureHtml();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
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
      if (url.pathname === '/plugins/studymate/events') {
        // 变更推送（#74）：阅读端挂载即订阅这条通道。这一套验的是作答落盘，推送不在它的
        // 验收面上——但夹具是「真 HTTP 迷你宿主」，客户端发的每条请求都得有正当落点
        // （favicon 那条补 204 也是这个理由），不接这一下浏览器就记一条 404，
        // 会被 QA 骨架算成失败请求。
        //
        // 这里给一条**最朴素的** text/event-stream：先握个手，之后一个 data 都不发。
        // 为什么不挂 lib/watch 的真通道：openChannel 会顺带 ensureWatching，把文件监听
        // 拉起来——那会给这一套引入它不需要的后台活动（本套自己往盘上写作答，会反过来
        // 触发通知与重取），而这一套要的只是「请求有个正当落点」。没有 data 就不会触发
        // 重取，不会干扰「只发了一笔 POST」与作答计数那几条断言。
        // 真通道的形状与两条推送路在 watch_push_test.mjs 与真 DSH 探针里验。
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write(': studymate 夹具：变更推送默认不推数据（#213 的竞态场景会手动推一条）\n\n');
        eventClients.add(res);
        res.on('close', () => { eventClients.delete(res); if (!res.writableEnded) res.end(); });
        return;
      }
      if (url.pathname === '/api/studymate/attempts') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const request = new Request('http://127.0.0.1/api/studymate/attempts', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks),
        });
        const response = await route.fetch(request);
        const text = await response.text();
        posts.push({ status: response.status, body: JSON.parse(text) });
        return send(response.status, text, 'application/json; charset=utf-8');
      }
      return send(404, 'not found', 'text/plain');
    } catch (error) {
      return send(500, String(error && error.stack || error), 'text/plain');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server, posts, port: server.address().port,
    // 模拟「另一个标签页刚写过盘」：推一条真实形状的变更通知，让本页静默重读 payload
    push: (notice) => {
      const frame = 'data: ' + JSON.stringify(notice || { kind: 'changed' }) + '\n\n';
      for (const res of eventClients) res.write(frame);
      return eventClients.size;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

/* ── 页面里的探针 ──────────────────────────────────────────────────────── */

const OPEN_QUIZ = `(() => {
  const marker = document.querySelector('.smb-qmark');
  if (!marker) return 'no-marker';
  marker.click();
  return 'ok';
})()`;

const PROBE = `(() => {
  const one = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };
  const all = (sel) => Array.from(document.querySelectorAll(sel)).map((el) => el.textContent.trim());
  const why = document.querySelector('.smb-why');
  return {
    options: all('.smb-opt'),
    optionsShown: document.querySelectorAll('.smb-opt').length,
    why: why ? { head: one('.smb-why b'), meta: one('.smb-why .smb-meta') } : null,
    review: all('.smb-review'),
    notes: all('.smb-q__note'),
    noteTone: (document.querySelector('.smb-q__note') || {}).dataset ? document.querySelector('.smb-q__note').dataset.tone : null,
    answered: one('.smb-center__head .smb-meta'),
    qsum: one('.smb-qsum .smb-meta'),
  };
})()`;

/* ── 跑 ────────────────────────────────────────────────────────────────── */

const { home, workspace, subjectDir } = makeWorkspace();
process.env.DSH_HOME = home;
const host = await startHost(workspace);
const fixture = `http://127.0.0.1:${host.port}/fixture.html`;
const attemptsFile = path.join(subjectDir, 'attempts', `0001-${NODE_ID}.json`);
const readAttempts = () => JSON.parse(fs.readFileSync(attemptsFile, 'utf8'));

const session = await openSession({ suite: 'attempts' });

/* 夹具边界（不是阅读端的缺陷）：mini-react 每次重画都**整树重建**，而 `LessonPage` 的
   ResizeObserver effect 把 `.smb-lesson` 那个节点闭在里面（真 React 里节点不换，所以那样写是对的）。
   重建之后观察者再回调，读到的是**已脱离文档**的旧节点 → 宽 0 → 两条栏永远收起，
   题目（在右栏里）就点不到。这里把 ResizeObserver 换成不回调的空实现：effect 里那次
   `measure()` 仍然打头跑一次、量到的是真布局（实测 1440），被测的作答路径一条不少。
   同一处边界（mini-react 整树重建 → 闭在 effect 里的 DOM 量到旧节点）在 reading_routes_test.mjs
   里有记：LessonPage 的 ResizeObserver 量画布宽，被闭住的旧节点一脱离文档就报 0。 */
await session.inject('window.ResizeObserver = function () { this.observe = function () {}; this.unobserve = function () {}; this.disconnect = function () {}; };');

/** 三层导航：主页 → 科目页 → 课件页 → 右栏题目（每次都是全新一次页面加载）。 */
async function openLesson(ctx) {
  await ctx.navigate(fixture, { settle: 1200 });
  await ctx.evaluate(`document.querySelectorAll('.smb-course')[0].click()`);
  await ctx.sleep(300);
  await ctx.evaluate(`document.querySelectorAll('[data-proto="open-node"]')[0].click()`);
  await ctx.sleep(400);
  await ctx.evaluate(OPEN_QUIZ);
  await ctx.sleep(400);
}

try {
  /* 1. 点一下 → 落盘 */
  await session.scene('attempts-write', async (ctx) => {
    await openLesson(ctx);
    const before = await ctx.evaluate(PROBE);
    check('题目在右栏里（两道：一道客观、一道开放）', before.optionsShown === 2, JSON.stringify(before.options));
    check('作答前磁盘上没有作答文件', !fs.existsSync(attemptsFile));

    await ctx.evaluate(`document.querySelectorAll('.smb-opt')[0].click()`);
    await ctx.sleep(700);
    const seen = await ctx.evaluate(PROBE);
    check('界面立刻判对（页内判分，规格 §7.3）', seen.why && seen.why.head === '对了', JSON.stringify(seen.why));
    check('界面说的是「已记进作答数据」而不是「只在内存里」',
      seen.why && /已记进作答数据（本题库文件不动）/.test(seen.why.meta), JSON.stringify(seen.why));
    check('「上次选了 A，对了」就地显示', JSON.stringify(seen.review).includes('上次选了 A，对了'), JSON.stringify(seen.review));
    check('这一课的作答计数从 0 变 1', seen.qsum === '作答 1 / 2', String(seen.qsum));

    check('只发了一笔 POST /api/studymate/attempts', host.posts.length === 1, JSON.stringify(host.posts.map((p) => p.status)));
    const [post] = host.posts;
    const sent = post.body && post.body.ok;
    check('Host 半回了 200 + ok', post.status === 200 && sent === true, JSON.stringify(post.body).slice(0, 200));
    check('落盘文件里就是这一条（题 id、选、对）',
      fs.existsSync(attemptsFile)
      && readAttempts()['题'][QUESTION]['上次结果']['选'] === 0
      && readAttempts()['题'][QUESTION]['上次结果']['对'] === true,
      fs.existsSync(attemptsFile) ? JSON.stringify(readAttempts()['题'][QUESTION]['上次结果']) : '文件不在');
    check('题库文件没被碰过',
      fs.readFileSync(path.join(subjectDir, 'lessons', `0001-${NODE_ID}.quiz.json`), 'utf8').includes('调用时发生的第一件事'),
      '题库读不到');
    return { posts: host.posts.length, why: seen.why, review: seen.review, answered: seen.qsum };
  });

  /* 2. 刷新页面（真的重新导航一次）→ 上次选了 X 还在 */
  await session.scene('attempts-reload', async (ctx) => {
    const postsBefore = host.posts.length;
    await openLesson(ctx);   // 全新一次页面加载：本地作答全空，一切来自磁盘
    const seen = await ctx.evaluate(PROBE);
    check('刷新后「上次选了 A，对了」仍在（来自 attempts/，不是页面内存）',
      JSON.stringify(seen.review).includes('上次选了 A，对了'), JSON.stringify(seen.review));
    check('刷新后这一课的作答计数是 1 / 2', seen.qsum === '作答 1 / 2', String(seen.qsum));
    check('刷新本身不发写请求', host.posts.length === postsBefore, String(host.posts.length - postsBefore));
    return { review: seen.review, answered: seen.qsum };
  });

  /* 3. #213 主观题：受控草稿落盘 → 切 tab 不丢 → 刷新还在 → 自评快照 → 带进答疑 */
  await session.scene('attempts-subjective-draft', async (ctx) => {
    const ANSWER = '我先写下的作答：先解析名字，再求值参数。';
    const SUBJECTIVE = ANCHOR + '#1';
    await openLesson(ctx);

    const typed = await ctx.evaluate(`(() => {
      const ta = document.querySelector('[data-proto="subjective-answer"]');
      if (!ta) return 'no-textarea';
      ta.value = ${JSON.stringify(ANSWER)};
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);
    check('主观题只有一个受控输入框（三种题型共用它）', typed === 'ok', String(typed));
    await ctx.sleep(1300);   // 900ms 防抖 + 一笔写请求

    check('只打字不自评：草稿落进顶层 草稿，不建题条目、不动作答历史',
      fs.existsSync(attemptsFile)
      && readAttempts()['草稿'] && readAttempts()['草稿'][SUBJECTIVE]
      && readAttempts()['草稿'][SUBJECTIVE]['文本'] === ANSWER
      && !readAttempts()['题'][SUBJECTIVE],
      fs.existsSync(attemptsFile) ? JSON.stringify({ 草稿: readAttempts()['草稿'], 题: Object.keys(readAttempts()['题'] || {}) }) : '文件不在');
    const answered = await ctx.evaluate(`(() => (document.querySelector('.smb-qsum .smb-meta') || {}).textContent || '')()`);
    check('「已作答 N/M」不被草稿污染（仍是 1 / 2）', /作答 1 \/ 2/.test(answered), answered);

    // 切到「问答」再切回「题目」：右栏卸载重挂，文本仍在（受控值来自顶部 drafts 状态）
    await ctx.evaluate(`document.querySelector('[data-proto="tab-ask"]').click()`);
    await ctx.sleep(300);
    await ctx.evaluate(`document.querySelector('[data-proto="tab-quiz"]').click()`);
    await ctx.sleep(300);
    const afterTabs = await ctx.evaluate(`(() => {
      const ta = document.querySelector('[data-proto="subjective-answer"]');
      const meta = document.querySelector('[data-proto="answer-time"]');
      return { value: ta ? ta.value : null, meta: meta ? meta.textContent.trim() : null };
    })()`);
    check('切 tab 之后文本还在（不是 local state 被卸载）', afterTabs.value === ANSWER, JSON.stringify(afterTabs));
    check('卡片上显示上次作答时间（草稿回执里的「时」）', !!afterTabs.meta && /上次作答：\d{2}-\d{2} \d{2}:\d{2}/.test(afterTabs.meta), String(afterTabs.meta));

    // 展开参考内容：输入框不丢字
    const opened = await ctx.evaluate(`(() => {
      const one = Array.from(document.querySelectorAll('button')).find((b) => /^展开参考/.test(b.textContent.trim()));
      if (one) one.click();
      return one ? one.textContent.trim() : null;
    })()`);
    await ctx.sleep(250);
    const afterOpen = await ctx.evaluate(`(document.querySelector('[data-proto="subjective-answer"]') || {}).value || ''`);
    check('展开参考内容之后文本不丢', !!opened && afterOpen === ANSWER, JSON.stringify({ opened, value: afterOpen.slice(0, 40) }));

    // 自评：文本作为快照进历史条目（这是离散动作，允许进 作答历史）
    const postsBefore = host.posts.length;
    const hit = await ctx.evaluate(`(() => {
      const all = Array.from(document.querySelectorAll('button'));
      const one = all.find((b) => b.textContent.trim() === '答了一半');
      if (!one) return { found: false, labels: all.map((b) => b.textContent.trim()).filter((t) => t.includes('答')) };
      one.click();
      return { found: true };
    })()`);
    check('展开参考内容之后找得到三档自评按钮', hit.found === true, JSON.stringify(hit));
    await ctx.sleep(1100);
    check('自评发出一笔写请求', host.posts.length === postsBefore + 1,
      JSON.stringify(host.posts.slice(postsBefore).map((p) => ({ status: p.status, body: p.body && p.body.error }))));
    const onDisk = readAttempts();
    const entry = onDisk['题'][SUBJECTIVE] && onDisk['题'][SUBJECTIVE]['作答历史'].slice(-1)[0];
    check('自评之后：历史 +1、条目带 作答、上次结果同步',
      !!entry && entry['作答'] === ANSWER && onDisk['题'][SUBJECTIVE]['上次结果']['自评'] === '答了一半'
      && onDisk['题'][SUBJECTIVE]['作答历史'].length === 1,
      JSON.stringify(entry));
    const answeredAfter = await ctx.evaluate(`(() => (document.querySelector('.smb-qsum .smb-meta') || {}).textContent || '')()`);
    check('自评之后「已作答 N/M」才变成 2 / 2', /作答 2 \/ 2/.test(answeredAfter), answeredAfter);

    // 刷新：文本、时间、自评都从磁盘读回来
    await openLesson(ctx);
    const reloaded = await ctx.evaluate(`(() => {
      const ta = document.querySelector('[data-proto="subjective-answer"]');
      const meta = document.querySelector('[data-proto="answer-time"]');
      return { value: ta ? ta.value : null, meta: meta ? meta.textContent.trim() : null,
        answered: (document.querySelector('.smb-qsum .smb-meta') || {}).textContent || '' };
    })()`);
    check('刷新之后草稿文本还在（来自 payload 的 草稿）', reloaded.value === ANSWER, JSON.stringify(reloaded));
    check('刷新之后还看得见上次作答时间', /上次作答：\d{2}-\d{2} \d{2}:\d{2}/.test(reloaded.meta || ''), String(reloaded.meta));
    check('刷新之后作答计数仍是 2 / 2', /作答 2 \/ 2/.test(reloaded.answered), reloaded.answered);

    // 带进答疑：题目卡片上的按钮 → 右栏切到问答 + 引用 chip 预填（发送由学生自己按）
    await ctx.evaluate(`document.querySelector('[data-proto="ask-with-answer"]').click()`);
    await ctx.sleep(500);
    const asked = await ctx.evaluate(`(() => {
      const tab = document.querySelector('[data-proto="tab-ask"]');
      const chip = document.querySelector('[data-proto="qa-quote"]');
      return {
        selected: tab ? tab.getAttribute('aria-selected') : null,
        chip: chip ? chip.textContent.trim() : null,
      };
    })()`);
    check('点「带进答疑」后右栏切到问答', asked.selected === 'true', JSON.stringify(asked));
    check('草稿区出现「题干 + 我的作答」的引用 chip（预填，不替学生发送）',
      !!asked.chip && /我的作答/.test(asked.chip), String(asked.chip));
    await ctx.evaluate(`(() => { const b = document.querySelector('[data-proto="qa-quote-toggle"]'); if (b) b.click(); })()`);
    await ctx.sleep(200);
    const full = await ctx.evaluate(`(() => (document.querySelector('[data-proto="qa-quote-full"]') || {}).textContent || '')()`);
    check('chip 展开是完整引用（题干 + 作答原文）',
      full.includes('先解析名字') && full.includes('我的作答：'), full.slice(0, 80));

    // 粘贴超长文本：写入侧截断到 8192 再落盘，不 500、不丢整段
    await ctx.evaluate(`document.querySelector('[data-proto="tab-quiz"]').click()`);
    await ctx.sleep(300);
    const postsBeforeLong = host.posts.length;
    await ctx.evaluate(`(() => {
      const ta = document.querySelector('[data-proto="subjective-answer"]');
      ta.value = 'a'.repeat(9000);
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await ctx.sleep(1400);
    const longPost = host.posts.slice(postsBeforeLong)[0];
    const longEntry = readAttempts()['草稿'][SUBJECTIVE];
    check('超长文本的草稿写入成功（不是 500）', !!longPost && longPost.status === 200 && longPost.body && longPost.body.ok === true,
      JSON.stringify(longPost && { status: longPost.status, body: longPost.body && longPost.body.error }));
    check('落盘前按 8192 字符截断（不拒绝、不丢整段）',
      !!longEntry && longEntry['文本'].length === 8192, JSON.stringify(longEntry && longEntry['文本'].length));
    const longValue = await ctx.evaluate(`(document.querySelector('[data-proto="subjective-answer"]') || {}).value || ''`);
    check('输入框里也是截断后的那一段（受控值没有回退）', longValue.length === 8192, String(longValue.length));

    return { draft: onDisk['草稿'][SUBJECTIVE]['文本'], history: onDisk['题'][SUBJECTIVE]['作答历史'].length, chip: asked.chip };
  });

  /* 3b. #213 双标签页竞态：A 正在写（防抖未触发），B 写了同一题并触发本页重读——A 的字不能被吞 */
  await session.scene('attempts-subjective-race', async (ctx) => {
    const MINE = 'A 正在写的这一版，还没到防抖时间。';
    const THEIRS = 'B 在另一个标签页里写下的版本。';
    const SUBJECTIVE = ANCHOR + '#1';
    await openLesson(ctx);
    await ctx.evaluate(`(() => {
      const ta = document.querySelector('[data-proto="subjective-answer"]');
      ta.value = ${JSON.stringify('A 正在写的这一版，还没到防抖时间。')};
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    // B 立即写盘（A 的 900ms 防抖还在路上），拿到的是 A 打字前的版本
    const raceVersion = attemptsVersion({ workspace, subject: 'demo', node: NODE_ID });
    const b = writeAttempts({
      workspace, subject: 'demo', node: NODE_ID,
      questions: { [SUBJECTIVE]: { 草稿: { 文本: 'B 在另一个标签页里写下的版本。' } } },
      operationId: 'race-b-' + Date.now(), expectedVersion: raceVersion,
    });
    if (!b.ok) throw new Error('B 的写入没成功：' + JSON.stringify(b));
    const pushed = host.push({ kind: 'changed' });
    check('竞态夹具：B 写盘成功并推了一条变更', b.ok === true && pushed >= 1, JSON.stringify({ pushed }));
    await ctx.sleep(400);   // 重读已回来、A 的防抖还没到点
    const mid = await ctx.evaluate(`(document.querySelector('[data-proto="subjective-answer"]') || {}).value || ''`);
    check('B 的重读没有覆盖 A 正在写的字（dirty 栅栏）', mid === MINE, JSON.stringify({ mid, theirs: THEIRS }));
    await ctx.sleep(1400);  // A 的防抖落盘（可能先 409 再带新版本重来一次）
    const onDisk = readAttempts();
    check('A 的字最终落到盘上（B 的草稿没赢）',
      onDisk['草稿'] && onDisk['草稿'][SUBJECTIVE] && onDisk['草稿'][SUBJECTIVE]['文本'] === MINE,
      JSON.stringify(onDisk['草稿'] && onDisk['草稿'][SUBJECTIVE]));
    const postsAfter = host.posts.slice(-2).map((p) => p.status);
    check('A 的写入最终 200；若先撞上 409，也是带新版本重来（不是静默丢）',
      postsAfter.includes(200) && postsAfter.every((s) => s === 200 || s === 409), JSON.stringify(postsAfter));
    return { mid, finalText: onDisk['草稿'][SUBJECTIVE]['文本'], statuses: postsAfter };
  });

  /* 4. 另一个写入者改过之后再作答：拒绝 → 重读 → 重来一次 → 如实说 */
  await session.scene('attempts-conflict', async (ctx) => {
    await openLesson(ctx);
    const stale = readLibrary({ workspace }).subjects[0].nodes[0].attempts.version;
    // 「另一个写入者」：模型重出题那侧直接用数据层写同一份文件（不走阅读端那条路）
    const other = writeAttempts({
      workspace, subject: 'demo', node: NODE_ID,
      questions: { [ANCHOR + '#1']: { 选: null, 对: true, 自评: '答对了', 作答: CONFLICT_HISTORY_TEXT } },
      expectedVersion: stale, operationId: 'qa-other-writer-' + Date.now(),
    });
    check('另一个写入者写成了（它换了版本号）', other.ok === true && other.version !== stale, JSON.stringify(other).slice(0, 200));

    const postsBefore = host.posts.length;
    await ctx.evaluate(`document.querySelectorAll('.smb-opt')[1].click()`);   // 页面手里还是旧版本号
    await ctx.sleep(900);
    const seen = await ctx.evaluate(PROBE);
    const fresh = host.posts.slice(postsBefore);
    check('第一笔被 409 拒（拒绝写入，不静默）', fresh[0] && fresh[0].status === 409 && fresh[0].body.error.code === 'version-conflict',
      JSON.stringify(fresh.map((p) => [p.status, p.body.error && p.body.error.code])));
    check('客户端拿回执里的版本号重来了一次（重读 + 重试同一个 operationId）',
      fresh[1] && fresh[1].status === 200
      && fresh[1].body.attempts['题'][QUESTION]['作答历史'].length === 2,
      JSON.stringify(fresh.map((p) => p.status)));
    check('学生看得见冲突那句话（不是静默丢数据）',
      JSON.stringify(seen.notes).includes('别处刚改过这份作答数据'), JSON.stringify(seen.notes));
    const onDisk = readAttempts();
    check('两条历史都在：另一个写入者那条没丢',
      onDisk['题'][ANCHOR + '#1'] && onDisk['题'][ANCHOR + '#1']['上次结果']['自评'] === '答对了',
      JSON.stringify(Object.keys(onDisk['题'])));
    check('学生这次选的那一项也落了盘',
      onDisk['题'][QUESTION]['上次结果']['选'] === 1 && onDisk['题'][QUESTION]['作答历史'].length === 2,
      JSON.stringify(onDisk['题'][QUESTION]['上次结果']));
    return { statuses: fresh.map((p) => p.status), notes: seen.notes };
  });

  /* 5. 一道坏题（题干缺字段）：一块占位，面板与其它题照常（#174 验收） */
  await session.scene('attempts-missing-stem', async (ctx) => {
    const quizFile = path.join(subjectDir, 'lessons', `0001-${NODE_ID}.quiz.json`);
    // 题库里把题干写成了 `stem`（模型重出题时最常见的坏形状）：作为第三题塞进去。
    const items = JSON.parse(fs.readFileSync(quizFile, 'utf8'))[ANCHOR];
    items.push({ stem: '题干写成 stem 的坏题', opts: ['甲', '乙'], ans: 0, why: '补上题干之后这一段才有用。' });
    fs.writeFileSync(quizFile, JSON.stringify({ [ANCHOR]: items }, null, 2) + '\n');

    await openLesson(ctx);
    const seen = await ctx.evaluate(`(() => {
      const qs = document.querySelectorAll('.smb-q');
      const miss = document.querySelector('.smb-q__missing');
      const body = document.querySelector('.smb-center__body');
      return {
        questions: qs.length,
        missing: miss ? { proto: miss.dataset.proto, missing: miss.dataset.missing, text: miss.textContent.trim() } : null,
        options: document.querySelectorAll('.smb-opt').length,
        bodyOk: !!body,
      };
    })()`);
    check('正文还在、三道题都在右栏（坏的那道没把整个面板带走）',
      seen.bodyOk && seen.questions === 3, JSON.stringify({ questions: seen.questions, bodyOk: seen.bodyOk }));
    check('坏题渲染成占位（带 question-missing 钩子）',
      !!seen.missing && seen.missing.proto === 'question-missing' && seen.missing.missing === 'q',
      JSON.stringify(seen.missing));
    check('占位说得出是哪一道题（节点 + 题号）',
      !!seen.missing && /节点 fn\.call · 第 3 题/.test(seen.missing.text), JSON.stringify(seen.missing && seen.missing.text));
    check('好题的选项照常（2 + 2，坏题自己的 2 个也没丢）', seen.options === 4, String(seen.options));
    return { questions: seen.questions, missing: seen.missing, options: seen.options };
  });

  /* 6. 一道会崩的题（`opts` 写成字符串）：只有它那一格变成兜底，其余照常（#174 ②） */
  await session.scene('attempts-boundary', async (ctx) => {
    const quizFile = path.join(subjectDir, 'lessons', `0001-${NODE_ID}.quiz.json`);
    const items = JSON.parse(fs.readFileSync(quizFile, 'utf8'))[ANCHOR];
    // `opts` 是字符串：`(item.opts || []).map` 里没有 map，Question 渲染时直接抛 TypeError
    items.push({ q: '这一道会在渲染时抛异常', opts: '不是数组', ans: 0, why: '看边界怎么接' });
    fs.writeFileSync(quizFile, JSON.stringify({ [ANCHOR]: items }, null, 2) + '\n');

    await openLesson(ctx);
    const seen = await ctx.evaluate(`(() => {
      const zone = document.querySelector('.smb-boundary[data-proto="question-crash"]');
      return {
        questions: document.querySelectorAll('.smb-q').length,
        boundaries: document.querySelectorAll('.smb-boundary').length,
        zone: zone ? zone.textContent.trim() : null,
        options: document.querySelectorAll('.smb-opt').length,
        bodyOk: !!document.querySelector('.smb-center__body'),
      };
    })()`);
    check('正文还在，坏题只占一格（其余三道照常渲染）',
      seen.bodyOk && seen.questions === 3 && seen.boundaries === 1,
      JSON.stringify({ questions: seen.questions, boundaries: seen.boundaries, bodyOk: seen.bodyOk }));
    check('兜底卡片说得出是哪一道题',
      !!seen.zone && /节点 fn\.call · 第 4 题/.test(seen.zone), JSON.stringify(seen.zone));
    check('好题的选项一个没丢', seen.options === 4, String(seen.options));

    // 「重试」：点了重画一次。数据还是坏的，所以卡片会再出现——重点是**面板活着**，不用刷页。
    await ctx.evaluate(`document.querySelector('.smb-boundary[data-proto="question-crash"] button').click()`);
    await ctx.sleep(400);
    const after = await ctx.evaluate(`(() => ({
      boundaries: document.querySelectorAll('.smb-boundary').length,
      questions: document.querySelectorAll('.smb-q').length,
      bodyOk: !!document.querySelector('.smb-center__body'),
    }))()`);
    check('点「重试」重画一次，面板没被带走（坏数据下卡片照旧在）',
      after.bodyOk && after.boundaries === 1 && after.questions === 3, JSON.stringify(after));
    return { questions: seen.questions, boundaries: seen.boundaries };
  });

  /* 7. #213 清空草稿：历史里已有作答文本时，读侧仍把空草稿当「显式清空」——刷新后输入框为空，
        「上次作答」回到历史快照时刻 */
  await session.scene('attempts-subjective-cleared', async (ctx) => {
    const SUBJECTIVE = ANCHOR + '#1';
    const before = readAttempts();
    const snapshot = before['题'][SUBJECTIVE]['上次结果'];
    check('清空前历史快照里已有作答文本（这正是不能回落的判据）',
      snapshot && snapshot['作答'] === CONFLICT_HISTORY_TEXT, JSON.stringify(snapshot));

    await openLesson(ctx);
    await ctx.evaluate(`(() => {
      const ta = document.querySelector('[data-proto="subjective-answer"]');
      ta.value = ${JSON.stringify('准备清掉的这一段。')};
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await ctx.sleep(1300);
    const typed = readAttempts();
    check('先落下一版非空草稿（清空之前的对照）',
      typed['草稿'] && typed['草稿'][SUBJECTIVE] && typed['草稿'][SUBJECTIVE]['文本'] === '准备清掉的这一段。',
      JSON.stringify(typed['草稿'] && typed['草稿'][SUBJECTIVE]));

    await ctx.evaluate(`(() => {
      const ta = document.querySelector('[data-proto="subjective-answer"]');
      ta.value = '';
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await ctx.sleep(1300);
    const cleared = readAttempts();
    const tombstone = cleared['草稿'] && cleared['草稿'][SUBJECTIVE];
    check('清空落的是墓碑：键还在、文本为空（不是删键）',
      !!tombstone && tombstone['文本'] === '', JSON.stringify(tombstone));
    check('清空不动历史与上次结果',
      JSON.stringify(cleared['题'][SUBJECTIVE]) === JSON.stringify(typed['题'][SUBJECTIVE]),
      JSON.stringify(cleared['题'][SUBJECTIVE]));

    await openLesson(ctx);
    const seen = await ctx.evaluate(`(() => {
      const ta = document.querySelector('[data-proto="subjective-answer"]');
      const at = document.querySelector('[data-proto="answer-time"]');
      return {
        value: ta ? ta.value : null,
        at: at ? at.textContent.trim() : '',
        meta: document.querySelector('.smb-answer-meta') ? document.querySelector('.smb-answer-meta').textContent.trim() : '',
        qsum: document.querySelector('.smb-qsum .smb-meta') ? document.querySelector('.smb-qsum .smb-meta').textContent.trim() : '',
      };
    })()`);
    const at = new Date(snapshot['时']);
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    const expected = pad(at.getMonth() + 1) + '-' + pad(at.getDate()) + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes());
    check('刷新后输入框为空（历史有作答文本，也不回填）', seen.value === '', JSON.stringify(seen));
    check('上次作答仍是历史快照的时刻，不是清空那一刻',
      seen.at === '上次作答：' + expected, JSON.stringify({ seen: seen.at, expected }));
    check('清空草稿不清历史：总计数仍是 2 / N', /^作答 2 \/ \d+$/.test(seen.qsum), JSON.stringify(seen.qsum));
    return { value: seen.value, at: seen.at, tombstone };
  });
} catch (error) {
  check('作答落盘的浏览器 QA 跑完（浏览器起来、夹具能开）', false, String(error && error.stack || error));
  await session.scene('attempts-error', async (ctx) => { ctx.note('harness', String(error && error.stack || error)); });
}

/* 版本冲突那条 409 是这条用例**故意**撞出来的（拒绝就是设计，见 attempts-conflict 场景）：
   浏览器会把任何非 2xx 记一条 log，它不是页面问题，从场景问题里摘掉——
   其余控制台错误、页面错误、失败请求一条都不放过。 */
for (const scene of session.report.scenes) {
  scene.problems = scene.problems.filter((one) => !(one.kind === 'log' && one.text.includes('409') && one.text.includes('/api/studymate/attempts')));
}

console.log(failures ? `\n${failures} 条失败` : '\n全部通过');
await finishSuite(session, { suite: 'attempts', failed: failures });
await host.close();
for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
