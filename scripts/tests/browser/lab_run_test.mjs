/* 验收 #77 · 真浏览器里点一次「跑一次」：真命令跑起来、真实输出回到界面、落在作答数据里
   ────────────────────────────────────────────────────────────────────────────────
   这一条把**真的 lib/client.js**（无打包、原样发货的那份）挂在夹具页里，用**真的 HTTP**
   打到**真的 Host 半**（`lib/lab/route.ts` 注册出来的那条路由 → 任务域 → `lib/lab/runner.ts`
   真的 spawn 一条命令），落到**真的工作区文件**上。夹具页与 mini-react 借用 #75 的浏览器
   QA 骨架（`scripts/tests/browser/harness.mjs`），浏览器二进制探测不到就明确跳过（退出码 3）。

   为什么非要有这一条：Node 侧那套（`test_client_lab_run.mjs`）断言的是渲染函数与纯映射——
   **React 接线不在覆盖里**（桩的 `useEffect` 根本不跑）。而这条验收要的
   「学生按下去才跑 → 真实输出出现在界面上 → 刷新之后还在 → 界面上一个判决词都没有」
   全在接线那一层，只有真浏览器跑得出来。

   三个场景（对应 #77 的验收标准）：
     · lab-no-autorun   打开课件：**一次请求都不发**，界面上只有一颗「跑一次」
     · lab-run          按一下：POST 形状对、命令真的跑了（脚本留下的文件是物证）、
                        退出码与两条流的原文出现在界面上、落进 attempts/<NNNN>-<节点>.json
     · lab-reload       刷新页面：那一段事实仍在（来自磁盘，不是页面内存），仍无判决词

   「判决词」的判据与 Node 侧同一套：界面上**除两条流原文之外**的字里不许有
   通过 / 不通过 / 正确 / 错误 / 对了 / 错了 这类结论（规格 §7.3：三轨里没有一轨叫 agent）。

   数据现造现弃（临时工作区 + 临时 HOME），跑完即删；仓库里不存样例数据。

   唯一一处不是「真」的：`/api/studymate/events`（#74 的变更推送）——理由与
   `attempts_test.mjs` 里那段逐字相同：那不在这一套的验收面上，但夹具是「真 HTTP 迷你宿主」，
   客户端发的每条请求都得有正当落点，否则会被 QA 骨架算成失败请求。
*/
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readLibrary } from '../../../lib/library.ts';
import { registerAttemptRoutes } from '../../../lib/attempts-route.ts';
import { registerLabRoute } from '../../../lib/lab/route.ts';
import { resetRunLedger } from '../../../lib/lab/ledger.ts';
import { resetTaskService } from '../../../lib/tasks/index.ts';
import { extractCss } from '../fixtures/client-css.mjs';
import { openSession, finishSuite } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

let failures = 0;
function check(label, ok, detail = '') {
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}

const TEMPS = [];

const NODE_ID = 'lab.deliverable';
const ANCHOR = '交付物那一题';
const QUESTION = ANCHOR + '#0';
/** 那条被声明的命令：`node check.mjs`——脚本自己写一个物证文件、吐两行输出、非零退出。 */
const COMMAND = 'node check.mjs';
const STDOUT_LINE = 'stdout 里的第一行';
const STDERR_LINE = 'stderr 里的报错原文';

/** 判决词：界面自己的文案里一个都不许有（两条流的原文除外——那是证据）。 */
const VERDICT_WORDS = ['通过', '不通过', '正确', '错误', '对了', '错了', '算你过', '判定'];

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-labqa-'));
  TEMPS.push(root);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'ws');
  const subjectDir = path.join(workspace, '.learning', 'subjects', 'demo');
  const labRun = path.join(subjectDir, 'lab', `0001-${NODE_ID}`);
  fs.mkdirSync(path.join(subjectDir, 'lessons'), { recursive: true });
  fs.mkdirSync(labRun, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'studymate-config.yaml'), `workspace: ${JSON.stringify(workspace)}\n`);
  fs.writeFileSync(path.join(subjectDir, 'subject.yaml'),
    'slug: demo\nname: 演示科目\ngoal: 在真浏览器里把一次代跑走一遍\nstatus: 学习中\n');
  fs.writeFileSync(path.join(subjectDir, 'curriculum.yaml'),
    `nodes:\n  - id: ${NODE_ID}\n    title: 交付物那一题\n    kind: 实操\n    objective: 造出能跑的东西\n`);
  fs.writeFileSync(path.join(subjectDir, 'progress.yaml'),
    `updated_at: "2026-05-06T07:08:09+08:00"\nnodes:\n  ${NODE_ID}:\n    status: 学习中\nproject:\n  current: ""\n`);
  fs.writeFileSync(path.join(subjectDir, 'lessons', `0001-${NODE_ID}.md`),
    `# 交付物\n\n先自己造，再让 Host 半跑题目里声明的那条命令。\n\n::: quiz 应用 锚点：${ANCHOR}\n:::\n`);
  fs.writeFileSync(path.join(subjectDir, 'lessons', `0001-${NODE_ID}.quiz.json`), JSON.stringify({
    [ANCHOR]: [
      {
        kind: '交付物', q: '写出一个能跑的脚本，并留下可运行证据。',
        交付物: '一个能跑出结果的脚本', 证据: COMMAND,
      },
    ],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(subjectDir, 'misconceptions.yaml'), '[]\n');

  // 被代跑的那个脚本：留一个物证文件（证明命令真的在这台机器上跑过）、吐两行、非零退出。
  // 用**绝对路径**的 node：命令是空白切词、不开 shell，所以第一条词必须真的在 PATH 上——
  // 夹具里直接把 process.execPath 写进「证据」字段（真实课件里会写 python3 / node 这类）。
  fs.writeFileSync(path.join(labRun, 'check.mjs'), [
    "import fs from 'node:fs';",
    "fs.writeFileSync('ran.marker', 'the command really ran');",
    `process.stdout.write(${JSON.stringify(STDOUT_LINE + '\n')});`,
    `process.stderr.write(${JSON.stringify(STDERR_LINE + '\n')});`,
    'process.exit(3);',
  ].join('\n') + '\n');
  return { root, home, workspace, subjectDir, labRun };
}

/* ── 夹具页 + 一个说 HTTP 的迷你宿主 ────────────────────────────────────
   页面上**不 stub fetch**：请求真的发到本进程起的 http 服务上；代跑那一跳走的是
   `registerLabRoute` 注册出来的真路由（不是直接调 handler）。 */

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
<title>StudyMate 实验代跑 QA</title>
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

/** 迷你宿主：library 现读，代跑与作答都交给真路由；每一次请求都记下来给断言用。 */
async function startHost(workspace) {
  const labRoutes = [];
  const attemptRoutes = [];
  // 注册约定：收外层 ctx、自己 inject(['connection'])（与 registerAskSessionRoute 同一姿势）
  const fakeOuter = (sink) => ({
    inject: (names, handler) => handler({
      connection: { fetch: { register: (route) => { sink.push(route); return () => {}; } } },
      effect: (fn) => fn(),
    }),
  });
  registerLabRoute(fakeOuter(labRoutes));
  registerAttemptRoutes(fakeOuter(attemptRoutes));
  const labRoute = labRoutes[0];
  const attemptRoute = attemptRoutes[0];
  const html = fixtureHtml();
  const posts = [];
  const gets = [];

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  const seenPaths = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    seenPaths.push(req.method + ' ' + url.pathname);
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
        // 变更推送（#74）：不在这一套的验收面上，但请求得有正当落点（见文件头）。
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write(': studymate 夹具：变更推送不在这一套的验收面上\n\n');
        res.on('close', () => { if (!res.writableEnded) res.end(); });
        return;
      }
      if (url.pathname === '/api/studymate/tasks') {
        // 任务板子（#73）：路由本身在 test_tasks_model.mjs 与真 DSH 探针里验；
        // 这里给同一份形状，让「跑得久时页面能显示进度」这条接线的请求有正当落点。
        gets.push({ path: url.pathname });
        return send(200, JSON.stringify({ at: new Date().toISOString(), tasks: [] }), 'application/json; charset=utf-8');
      }
      if (url.pathname === '/api/studymate/lab-run') {
        const body = await readBody(req);
        const request = new Request('http://127.0.0.1/api/studymate/lab-run', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body,
        });
        const response = await labRoute.fetch(request);
        const text = await response.text();
        posts.push({ status: response.status, sent: JSON.parse(body.toString('utf8')), body: JSON.parse(text) });
        return send(response.status, text, 'application/json; charset=utf-8');
      }
      if (url.pathname === '/api/studymate/attempts') {
        const body = await readBody(req);
        const request = new Request('http://127.0.0.1/api/studymate/attempts', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body,
        });
        const response = await attemptRoute.fetch(request);
        const text = await response.text();
        return send(response.status, text, 'application/json; charset=utf-8');
      }
      return send(404, 'not found', 'text/plain');
    } catch (error) {
      return send(500, String(error && error.stack || error), 'text/plain');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, posts, gets, port: server.address().port, seen: () => seenPaths, close: () => new Promise((r) => server.close(r)) };
}

/* ── 页面里的探针 ──────────────────────────────────────────────────────── */

const OPEN_QUIZ = `(() => {
  const marker = document.querySelector('.smb-qmark');
  if (!marker) return 'no-marker';
  marker.click();
  return 'ok';
})()`;

/** 展开某一题的参考内容（交付物题的代跑块挂在展开区里，与参考答案同一处）。 */
const OPEN_REFERENCE = `(() => {
  const buttons = Array.from(document.querySelectorAll('.smb-btn'));
  const reveal = buttons.find((one) => one.textContent.indexOf('展开参考内容') === 0);
  if (!reveal) return 'no-reveal';
  reveal.click();
  return 'ok';
})()`;

const PROBE = `(() => {
  const one = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };
  const lab = document.querySelector('[data-proto="lab-run"]');
  const button = document.querySelector('[data-proto="lab-run-button"]');
  const streams = Array.from(document.querySelectorAll('.smb-lab__stream pre')).map((el) => el.textContent);
  return {
    hasLab: !!lab,
    labText: lab ? lab.textContent : null,
    button: button ? { text: button.textContent.trim(), disabled: button.disabled } : null,
    command: one('.smb-lab__cmd'),
    facts: Array.from(document.querySelectorAll('.smb-lab__fact')).map((el) => el.textContent.trim()),
    streams,
    hints: Array.from(document.querySelectorAll('.smb-lab__hint')).map((el) => el.textContent.trim()),
    refusal: one('.smb-note'),
  };
})()`;

/* ── 跑 ────────────────────────────────────────────────────────────────── */

const { home, workspace, subjectDir, labRun } = makeWorkspace();
process.env.DSH_HOME = home;
resetTaskService();
resetRunLedger();
const host = await startHost(workspace);
const fixture = `http://127.0.0.1:${host.port}/fixture.html`;
const attemptsFile = path.join(subjectDir, 'attempts', `0001-${NODE_ID}.json`);
const markerFile = path.join(labRun, 'ran.marker');
const readAttempts = () => JSON.parse(fs.readFileSync(attemptsFile, 'utf8'));

const session = await openSession({ suite: 'lab-run' });

/* 夹具边界（与 attempts_test.mjs 里同一处，理由逐字相同）：mini-react 每次重画都整树重建，
   而 `LessonPage` 的 ResizeObserver effect 把节点闭在里面（真 React 里节点不换）。
   换成不回调的空实现，effect 里那次 measure() 仍打头跑一次、量到真布局。 */
await session.inject('window.ResizeObserver = function () { this.observe = function () {}; this.unobserve = function () {}; this.disconnect = function () {}; };');

/** 三层导航：主页 → 科目页 → 课件页 → 右栏题目。 */
async function openLesson(ctx) {
  await ctx.navigate(fixture, { settle: 1200 });
  await ctx.evaluate(`document.querySelectorAll('.smb-course')[0].click()`);
  await ctx.sleep(300);
  await ctx.evaluate(`document.querySelectorAll('[data-proto="open-node"]')[0].click()`);
  await ctx.sleep(400);
  await ctx.evaluate(OPEN_QUIZ);
  await ctx.sleep(400);
  // 交付物题的代跑块在**展开区**里（与「交付物 / 可运行证据」同一处）：先展开。
  // 折叠着的时候它一个字都不该出现在页面上——那正是「打开课件不自动跑」的一半。
  await ctx.evaluate(OPEN_REFERENCE);
  await ctx.sleep(300);
}

try {
  /* 1. 打开课件：不自动跑 */
  await session.scene('lab-no-autorun', async (ctx) => {
    await openLesson(ctx);
    const before = await ctx.evaluate(PROBE);
    check('交付物题在右栏里', before.hasLab === true, JSON.stringify(before.labText));
    check('入口是一颗「跑一次」按钮', before.button && before.button.text === '跑一次', JSON.stringify(before.button));
    check('打开课件**不发**代跑请求（学生按下去才跑）', host.posts.length === 0, JSON.stringify(host.posts.map((p) => p.status)));
    check('还没跑过：界面上没有退出码，也没有输出块',
      !String(before.labText).includes('退出码') && before.streams.length === 0, JSON.stringify(before.facts));
    check('命令还躺在脚本文件里、没有被谁执行过（物证文件不在）', !fs.existsSync(markerFile));
    return { button: before.button, posts: host.posts.length };
  });

  /* 2. 按一下：真命令跑起来，真实输出回到界面并落盘 */
  await session.scene('lab-run', async (ctx) => {
    const clicked = await ctx.evaluate(`(() => {
      const button = document.querySelector('[data-proto="lab-run-button"]');
      if (!button) return 'no-button';
      button.click();
      return 'clicked';
    })()`);
    check('按得下去（按钮没被禁用）', clicked === 'clicked', clicked);
    await ctx.sleep(1500);
    const seen = await ctx.evaluate(PROBE);

    check('发了一笔 POST /api/studymate/lab-run', host.posts.length === 1, JSON.stringify(host.posts.map((p) => p.status)));
    const [post] = host.posts;
    check('请求体只有三个坐标（命令不在请求里——它从题目里来）',
      post && post.sent.subject === 'demo' && post.sent.node === NODE_ID && post.sent.question === QUESTION
      && Object.keys(post.sent).length === 3,
      JSON.stringify(post && post.sent));
    check('Host 半回了「跑完了」', post && post.body['状态'] === '跑完了', JSON.stringify(post && post.body).slice(0, 300));
    check('命令真的在这台机器上跑了（脚本留下的物证）',
      fs.existsSync(markerFile) && fs.readFileSync(markerFile, 'utf8') === 'the command really ran');
    check('界面显示那条命令', seen.command === COMMAND, JSON.stringify(seen.command));
    check('界面显示退出码 3（数字原样，不是判决）',
      JSON.stringify(seen.facts).includes('退出码：3'), JSON.stringify(seen.facts));
    check('界面显示两条流的原文',
      seen.streams.some((one) => one.includes('stdout 里的第一行'))
      && seen.streams.some((one) => one.includes('stderr 里的报错原文')),
      JSON.stringify(seen.streams));
    check('界面明说「通过与否不在这一层」', JSON.stringify(seen.hints).includes('通过与否不在这一层'), JSON.stringify(seen.hints));

    // 「只显示事实」的界面侧判据：除两条流原文之外，界面的字里没有判决词
    const uiOnly = String(seen.labText).split(STDOUT_LINE).join('').split(STDERR_LINE).join('')
      .split('通过与否不在这一层').join('').split('标准错误').join('').split('标准输出').join('');
    for (const word of VERDICT_WORDS) {
      check(`界面文案里没有判决词「${word}」`, !uiOnly.includes(word), uiOnly.slice(0, 200));
    }

    check('事实落进了 attempts/<NNNN>-<节点>.json 的 `跑` 字段',
      fs.existsSync(attemptsFile) && readAttempts()['题'][QUESTION]['上次结果']['跑']['退出码'] === 3,
      fs.existsSync(attemptsFile) ? JSON.stringify(readAttempts()['题'][QUESTION]['上次结果']).slice(0, 300) : '文件不在');
    check('落盘那一份的 stdout/stderr 与脚本吐的逐字一致',
      readAttempts()['题'][QUESTION]['上次结果']['跑']['stdout'].includes(STDOUT_LINE)
      && readAttempts()['题'][QUESTION]['上次结果']['跑']['stderr'].includes(STDERR_LINE));
    check('题库文件没被碰过（ADR-0007）',
      fs.readFileSync(path.join(subjectDir, 'lessons', `0001-${NODE_ID}.quiz.json`), 'utf8').includes(COMMAND));
    return { status: post.body['状态'], exit: readAttempts()['题'][QUESTION]['上次结果']['跑']['退出码'] };
  });

  /* 3. 刷新页面：那一段事实仍在（来自磁盘），仍无判决词 */
  await session.scene('lab-reload', async (ctx) => {
    const postsBefore = host.posts.length;
    await openLesson(ctx);
    const seen = await ctx.evaluate(PROBE);
    check('刷新后界面仍显示那条命令与退出码（来自 attempts/，不是页面内存）',
      seen.command === COMMAND && JSON.stringify(seen.facts).includes('退出码：3'),
      JSON.stringify({ command: seen.command, facts: seen.facts }));
    check('刷新后两条流的原文也还在',
      seen.streams.some((one) => one.includes('stdout 里的第一行')), JSON.stringify(seen.streams));
    check('刷新本身不发代跑请求', host.posts.length === postsBefore, String(host.posts.length - postsBefore));
    const uiOnly = String(seen.labText).split(STDOUT_LINE).join('').split(STDERR_LINE).join('')
      .split('通过与否不在这一层').join('').split('标准错误').join('').split('标准输出').join('');
    for (const word of VERDICT_WORDS) {
      check(`刷新后界面文案里仍没有判决词「${word}」`, !uiOnly.includes(word), uiOnly.slice(0, 200));
    }
    return { command: seen.command, facts: seen.facts };
  });
} catch (error) {
  check('实验代跑的浏览器 QA 跑完（浏览器起来、夹具能开）', false, String(error && error.stack || error));
  await session.scene('lab-error', async (ctx) => { ctx.note('harness', String(error && error.stack || error)); });
}

console.log(failures ? `\n${failures} 条失败` : '\n全部通过');
await finishSuite(session, { suite: 'lab-run', failed: failures });
await host.close();
for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
