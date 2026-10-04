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
  registerAttemptRoutes({
    connection: { fetch: { register: (route) => { routes.push(route); return () => {}; } } },
    effect: (fn) => fn(),
  });
  const route = routes[0];
  const posts = [];
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
  return { server, posts, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
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
   同一处边界在 #75 的 reading_test.mjs 里有记（路线图 draw() 量到旧节点、坐标归零）。 */
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

  /* 3. 另一个写入者改过之后再作答：拒绝 → 重读 → 重来一次 → 如实说 */
  await session.scene('attempts-conflict', async (ctx) => {
    await openLesson(ctx);
    const stale = readLibrary({ workspace }).subjects[0].nodes[0].attempts.version;
    // 「另一个写入者」：模型重出题那侧直接用数据层写同一份文件（不走阅读端那条路）
    const other = writeAttempts({
      workspace, subject: 'demo', node: NODE_ID,
      questions: { [ANCHOR + '#1']: { 选: null, 对: true, 自评: '答对了' } },
      expectedVersion: stale, operationId: 'qa-other-writer-' + Date.now(),
    });
    check('另一个写入者写成了（它换了版本号）', other.ok === true && other.version !== stale, JSON.stringify(other).slice(0, 200));

    const postsBefore = host.posts.length;
    await ctx.evaluate(`document.querySelectorAll('.smb-opt')[1].click()`);   // 页面手里还是旧版本号
    await ctx.sleep(900);
    const seen = await ctx.evaluate(PROBE);
    const fresh = host.posts.slice(postsBefore);
    check('第一笔被 409 拒（拒绝写入，不静默）', fresh[0] && fresh[0].status === 409 && fresh[0].body.error === 'version-conflict',
      JSON.stringify(fresh.map((p) => [p.status, p.body.error])));
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
