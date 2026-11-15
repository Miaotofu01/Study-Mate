/* 验收（③ 阅读端标注）· 真浏览器里走一遍「划选 → 高亮并写注释 → 覆盖层/小标记 → 刷新仍在 → 失效重指」
   ────────────────────────────────────────────────────────────────────────────────
   这一条把**真的 lib/client.js**（无打包、原样发货的那份）挂在夹具页里，页面与宿主之间走
   **真 HTTP**：GET payload 由本进程的迷你宿主现读工作区给，POST 走**本进程实现的
   `/api/studymate/annotations` 契约**（整份数组 + operationId + expectedVersion，回执中文键信封）。
   浏览器二进制探测不到就明确跳过（退出码 3），不是静默绿。

   两场：
     · annotations-create  划选一段 → 浮动按钮 → 写注释保存 → 覆盖层矩形 + 小标记出现 →
                           点标记读回注释；刷新页面后标注从 payload 读回来、还画在原文上。
     · annotations-stale   改课件正文（宿主 payload 变了）→ 列表显示「这条标注的原文已变」、
                           **不贴到错位置**（覆盖层一个矩形都不画）→「重新指定到当前段落」
                           → 按新原文重写 → 高亮回来。

   数据现造现弃（临时工作区 + 临时 HOME），跑完即删；仓库里不存样例数据。
   只读快照（⑤）那半在 Node 套件 test_export_annotations.mjs 里断。 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/* ── 临时工作区 + 临时 HOME ────────────────────────────────────────────── */

const NODE_ID = 'fn.call';
const LESSON_FILE = 'lessons/0001-fn.call.md';

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-annot-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'ws');
  const subjectDir = path.join(workspace, '.learning', 'subjects', 'demo');
  fs.mkdirSync(path.join(subjectDir, 'lessons'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'studymate-config.yaml'), `workspace: ${JSON.stringify(workspace)}\n`);
  fs.writeFileSync(path.join(subjectDir, 'subject.yaml'),
    'slug: demo\nname: 演示科目\ngoal: 在真浏览器里把标注走一遍\nstatus: 学习中\n');
  fs.writeFileSync(path.join(subjectDir, 'curriculum.yaml'),
    `nodes:\n  - id: ${NODE_ID}\n    title: 函数调用\n    kind: 概念\n    objective: 说清调用是什么\n`);
  fs.writeFileSync(path.join(subjectDir, 'progress.yaml'),
    'updated_at: "2026-05-06T07:08:09+08:00"\nnodes:\n  fn.call:\n    status: 学习中\nproject:\n  current: ""\n');
  fs.writeFileSync(path.join(subjectDir, 'misconceptions.yaml'), '[]\n');
  return { root, home, workspace, subjectDir, lessonFile: path.join(subjectDir, LESSON_FILE) };
}

/** 课件正文：一段纯文本（好划选）、一段带公式、一个提示块（嵌套块也带 data-line）。 */
function lessonMarkdown(paragraph) {
  return [
    '# 函数调用',
    '',
    paragraph,
    '',
    '公式那一句：$f(x) = x + 1$ 在 $x=1$ 处连续。',
    '',
    '::: note 注意',
    '**左右极限相等**才是极限存在。',
    ':::',
    '',
  ].join('\n');
}

const FIRST_PARAGRAPH = '函数是一段可复用的调用。调用时先解析名字，再求值参数。';

/* ── 迷你宿主：真 HTTP + 内存里的标注（形状照 Host 半契约） ──────────────── */

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
<title>StudyMate 标注 QA</title>
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

/**
 * 迷你宿主：library 现读工作区（把内存里的标注贴到 node.annotations 上，形状与 Host 半一致），
 * `POST /api/studymate/annotations` 按契约校验版本号并整份落进内存。
 */
function startHost(workspace, state, reads) {
  const posts = [];
  const html = fixtureHtml();
  const envelope = () => ({
    节点: NODE_ID,
    课件: LESSON_FILE,
    最后写入: new Date().toISOString(),
    // 回执/落盘形状：`标` 是「标注 id → 标注」的 Record（阅读端收到后自己归一成数组）
    标: Object.fromEntries(state.items.map((one) => [one.id, one])),
  });
  const receiptOf = (version) => ({
    ok: true,
    annotations: envelope(),
    version,
  });

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
        reads.count += 1;
        const data = readLibrary({ workspace });
        const node = data.subjects[0].nodes[0];
        node.annotations = { present: state.present, version: state.version, items: state.items };
        return send(200, JSON.stringify(data), 'application/json; charset=utf-8');
      }
      if (url.pathname === '/api/studymate/events') {
        // 阅读端挂载即订阅变更推送：这一套不验推送，给一条不推数据的 text/event-stream，
        // 让请求有正当落点（否则 QA 骨架会把 404 算成失败请求）。
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write(': studymate 夹具：变更推送不在这一套的验收面上\n\n');
        res.on('close', () => { if (!res.writableEnded) res.end(); });
        return;
      }
      if (url.pathname === '/api/studymate/annotations' && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        // 幂等重放：同一个 operationId 回同一份回执，不写第二遍
        if (state.lastOperation && state.lastOperation.operationId === body.operationId) {
          posts.push({ status: 200, body: state.lastOperation.receipt, request: body, replayed: true });
          return send(200, JSON.stringify(state.lastOperation.receipt), 'application/json; charset=utf-8');
        }
        if (String(body.expectedVersion || '') !== state.version) {
          const reply = {
            ok: false,
            error: { code: 'version-conflict', message: '别处刚改过这一页的标注（夹具）' },
            annotations: envelope(),
            version: state.version,
          };
          posts.push({ status: 409, body: reply, request: body });
          return send(409, JSON.stringify(reply), 'application/json; charset=utf-8');
        }
        state.seq += 1;
        state.version = 'v' + state.seq;
        state.items = Array.isArray(body.annotations) ? body.annotations : [];
        state.present = true;
        const receipt = receiptOf(state.version);
        state.lastOperation = { operationId: body.operationId, receipt };
        posts.push({ status: 200, body: receipt, request: body });
        return send(200, JSON.stringify(receipt), 'application/json; charset=utf-8');
      }
      return send(404, 'not found', 'text/plain');
    } catch (error) {
      return send(500, String((error && error.stack) || error), 'text/plain');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      posts,
      port: server.address().port,
      close: () => new Promise((r) => {
        server.close(r);
        // EventSource 那条长连接不算「请求还在飞」：主动断掉，别让 close 等它
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      }),
    }));
  });
}

/* ── 页面里的探针 ──────────────────────────────────────────────────────── */

/** 三层导航：主页 → 科目页 → 课件页。 */
async function openLesson(ctx, fixture) {
  await ctx.navigate(fixture, { settle: 1200 });
  await ctx.evaluate(`document.querySelectorAll('.smb-course')[0].click()`);
  await ctx.sleep(300);
  await ctx.evaluate(`document.querySelectorAll('[data-proto="open-node"]')[0].click()`);
  await ctx.sleep(500);
}

/**
 * 在正文第一段里划选 [from, to)。用真 Selection + 真 mouseup：
 * 客户端只有一个 document 级 mouseup 监听，这里触发的是同一条路（不调私有函数）。
 */
function selectParagraph(from, to) {
  return `(() => {
    const para = Array.from(document.querySelectorAll('.smb-doc p')).find((el) => el.textContent.indexOf('函数是一段') === 0);
    if (!para) return 'no-para';
    const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node) return 'no-text';
    const range = document.createRange();
    range.setStart(node, ${from});
    range.setEnd(node, ${to});
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return sel.toString();
  })()`;
}

const PROBE = `(() => {
  const text = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };
  const all = (sel) => Array.from(document.querySelectorAll(sel));
  const popover = document.querySelector('.smb-annot-popover');
  const panel = document.querySelector('.smb-annotpanel');
  return {
    pick: !!document.querySelector('[data-proto="annotation-pick"]'),
    editor: !!document.querySelector('[data-proto="annotation-editor"]'),
    highlights: all('.smb-annot__hl').length,
    highlightIds: all('.smb-annot__hl').map((el) => el.getAttribute('data-annotation-id')),
    markers: all('.smb-annot__marker').map((el) => el.textContent.trim()),
    popover: popover ? { note: text('.smb-annot-popover__note'), full: popover.textContent.trim() } : null,
    panel: panel ? { head: text('.smb-annotpanel__head'), expanded: !!(document.querySelector('.smb-annotlist')) } : null,
    states: all('[data-proto="annotation-state"]').map((el) => el.textContent.trim()),
    items: all('.smb-annotitem').map((el) => el.getAttribute('data-state')),
    reassign: all('[data-proto="annotation-reassign"]').map((el) => ({ disabled: !!el.disabled, text: el.textContent.trim() })),
    readonly: (document.querySelector('.smb-root') || {}).getAttribute ? document.querySelector('.smb-root').getAttribute('data-readonly') : null,
  };
})()`;

/* ── 跑 ────────────────────────────────────────────────────────────────── */

const { home, workspace, lessonFile } = makeWorkspace();
process.env.DSH_HOME = home;
fs.writeFileSync(lessonFile, lessonMarkdown(FIRST_PARAGRAPH));

const state = { seq: 0, version: '', present: false, items: [], lastOperation: null };
const reads = { count: 0 };
const host = await startHost(workspace, state, reads);
const fixture = `http://127.0.0.1:${host.port}/fixture.html`;

const session = await openSession({ suite: 'annotations' });

/* 夹具边界与 attempts_test.mjs 同一条：mini-react 每次重画整树重建，把 DOM 节点闭在 effect
   里的 ResizeObserver 会量到已脱离文档的旧节点。这里换成不回调的空实现——覆盖层的测量走
   自己的 effect（标注变了才重跑），不依赖 ResizeObserver 回调。
   公式：这一套验的是标注偏移，不是 KaTeX 排版；给 `window.__STUDYMATE_MATH__` 声明
   「没有资源位置」，MathSpan 走可读降级（TeXT 原文 + 一句说明），不发任何 math 请求。
   文本 walker 对数学元素按 `data-tex` 当原子——降级态与排好版态在标注偏移上是同一口径。 */
await session.inject([
  'window.ResizeObserver = function () { this.observe = function () {}; this.unobserve = function () {}; this.disconnect = function () {}; };',
  'window.__STUDYMATE_MATH__ = { css: "", js: "" };',
].join('\n'));

try {
  /* 1. 划选 → 浮动按钮 → 写注释 → 覆盖层 + 小标记 → 点标记读注释 → 刷新仍在 */
  await session.scene('annotations-create', async (ctx) => {
    await openLesson(ctx, fixture);
    const selected = await ctx.evaluate(selectParagraph(0, 6));
    check('划中正文一段（真 Selection）', selected === FIRST_PARAGRAPH.slice(0, 6), String(selected));
    await ctx.sleep(250);
    const afterSelect = await ctx.evaluate(PROBE);
    check('选区附近出现浮动按钮「高亮并写注释」', afterSelect.pick === true, JSON.stringify(afterSelect.pick));

    await ctx.evaluate(`document.querySelector('[data-proto="annotation-pick"]').click()`);
    await ctx.sleep(250);
    const editor = await ctx.evaluate(`(() => {
      const box = document.querySelector('[data-proto="annotation-editor"]');
      const ta = box && box.querySelector('textarea');
      return { open: !!box, title: box ? box.textContent.trim().slice(0, 20) : null, hasTextarea: !!ta };
    })()`);
    check('点开后是小编辑器（textarea + 保存/取消）', editor.open && editor.hasTextarea, JSON.stringify(editor));

    await ctx.evaluate(`(() => {
      const ta = document.querySelector('[data-proto="annotation-editor"] textarea');
      ta.value = '这里讲的是调用的第一步：解析名字。';
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return ta.value;
    })()`);
    await ctx.sleep(150);
    await ctx.evaluate(`document.querySelector('[data-proto="annotation-save"]').click()`);
    await ctx.sleep(700);

    check('只发了一笔 POST /api/studymate/annotations', host.posts.length === 1, JSON.stringify(host.posts.map((p) => p.status)));
    const post = host.posts[0];
    const sent = post && post.body && post.body.ok ? null : post.body;
    check('Host 半回了 200 + ok（回执是中文键信封）', post.status === 200 && post.body.ok === true && !!post.body.annotations['标'], JSON.stringify(sent).slice(0, 200));
    check('回执带版本号，落进内存的那份就是刚写的', state.version === 'v1' && state.items.length === 1, JSON.stringify({ version: state.version, items: state.items.length }));
    const one = state.items[0];
    check('标注形状：id / note / ranges[{line,kind,hash,start,end}] / created / modified',
      !!one && typeof one.id === 'string' && one.note.indexOf('解析名字') >= 0
      && Array.isArray(one.ranges) && one.ranges.length === 1
      && one.ranges[0].kind === 'para' && /^[0-9a-f]{8}$/.test(one.ranges[0].hash)
      && one.ranges[0].start === 0 && one.ranges[0].end === 6,
      JSON.stringify(one));
    check('请求体带 subject / node / 整份数组 / operationId / expectedVersion（首次为空串）',
      post.request.subject === 'demo' && post.request.node === NODE_ID
      && Array.isArray(post.request.annotations) && post.request.annotations.length === 1
      && typeof post.request.operationId === 'string' && post.request.operationId.length > 0
      && post.request.expectedVersion === '',
      JSON.stringify({ keys: Object.keys(post.request || {}) }));

    const painted = await ctx.evaluate(PROBE);
    check('覆盖层画出了高亮矩形（Range.getClientRects + 绝对定位，不重写正文）',
      painted.highlights > 0, JSON.stringify({ highlights: painted.highlights }));
    check('正文里出现行内小标记（数字 1）', JSON.stringify(painted.markers) === '["1"]', JSON.stringify(painted.markers));
    check('标注列表出现「本页标注 1 条」', !!painted.panel && painted.panel.head.indexOf('本页标注 1 条') >= 0, JSON.stringify(painted.panel));

    await ctx.evaluate(`document.querySelector('.smb-annot__marker').click()`);
    await ctx.sleep(250);
    const opened = await ctx.evaluate(PROBE);
    check('点小标记能读回注释（popover）',
      !!opened.popover && opened.popover.note.indexOf('解析名字') >= 0, JSON.stringify(opened.popover));

    // 刷新（真的重新导航一次）：标注从 payload 读回来、还画在原文上
    const postsBefore = host.posts.length;
    await openLesson(ctx, fixture);
    const reloaded = await ctx.evaluate(PROBE);
    check('刷新后标注还在：payload → 覆盖层 + 小标记',
      reloaded.highlights > 0 && JSON.stringify(reloaded.markers) === '["1"]',
      JSON.stringify({ highlights: reloaded.highlights, markers: reloaded.markers }));
    check('刷新本身不发写请求', host.posts.length === postsBefore, String(host.posts.length - postsBefore));
    check('刷新读的是新 payload（GET library 至少两次）', reads.count >= 2, String(reads.count));
    return { posts: host.posts.length, highlights: reloaded.highlights, markers: reloaded.markers };
  });

  /* 2. 改课件正文 → 列表说「原文已变」、不贴错位置 → 重新指定 → 高亮回来 */
  await session.scene('annotations-stale', async (ctx) => {
    const before = state.items[0].ranges[0].hash;
    // 「模型重写了这一课」：宿主侧文件变了，payload 跟着变；标注还是旧的那一条
    fs.writeFileSync(lessonFile, lessonMarkdown('函数是可复用的调用。调用时先解析名字，再求值参数。'));
    await openLesson(ctx, fixture);

    const stale = await ctx.evaluate(PROBE);
    check('原文已变：覆盖层一个矩形都不画（不贴到错位置）', stale.highlights === 0, JSON.stringify(stale.highlightIds));

    await ctx.evaluate(`document.querySelector('[data-proto="annotations-toggle"]').click()`);
    await ctx.sleep(250);
    const expanded = await ctx.evaluate(PROBE);
    check('列表里标出「这条标注的原文已变」', expanded.states.includes('这条标注的原文已变'), JSON.stringify(expanded.states));
    check('列表可展开，条目状态是 stale', expanded.panel && expanded.panel.expanded && JSON.stringify(expanded.items) === '["stale"]',
      JSON.stringify({ panel: expanded.panel, items: expanded.items }));
    check('给出「重新指定到当前段落」按钮且可用', expanded.reassign.length === 1 && expanded.reassign[0].disabled === false,
      JSON.stringify(expanded.reassign));

    const postsBefore = host.posts.length;
    await ctx.evaluate(`document.querySelector('[data-proto="annotation-reassign"]').click()`);
    await ctx.sleep(700);
    check('重新指定发了一笔写请求（不是只改本地）', host.posts.length === postsBefore + 1,
      String(host.posts.length - postsBefore));
    const next = state.items[0];
    check('重指后 hash 换成了当前原文的哈希（版本号也前进了）',
      next.ranges[0].hash !== before && state.version !== 'v1',
      JSON.stringify({ before, after: next.ranges[0].hash, version: state.version }));
    check('重指后原注释还在（只改锚点，不改注释）', next.note.indexOf('解析名字') >= 0, next.note);

    const resolved = await ctx.evaluate(PROBE);
    check('重指后高亮按新原文画回来了', resolved.highlights > 0, String(resolved.highlights));
    check('状态回到 resolved（列表里不再有 stale 徽标）',
      resolved.states.every((text) => text !== '这条标注的原文已变'), JSON.stringify(resolved.states));
    return { highlights: resolved.highlights, hashChanged: next.ranges[0].hash !== before };
  });

  /* 3. ④ 多选标注 → 拼一条引用进答疑（走现成的 chip 机制，不新开路由、不写标注） */
  await session.scene('annotations-ask', async (ctx) => {
    await openLesson(ctx, fixture);

    // 在带公式的那一段再建一条标注（第二段起）：划「公式那一句」五个字
    const selected = await ctx.evaluate(`(() => {
      const para = Array.from(document.querySelectorAll('.smb-doc p')).find((el) => el.textContent.indexOf('公式那一句') === 0);
      if (!para) return 'no-para';
      const node = document.createTreeWalker(para, NodeFilter.SHOW_TEXT).nextNode();
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 5);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return sel.toString();
    })()`);
    check('第二段（含公式）也能划选建标注', selected === '公式那一句', String(selected));
    await ctx.sleep(250);
    await ctx.evaluate(`document.querySelector('[data-proto="annotation-pick"]').click()`);
    await ctx.sleep(250);
    await ctx.evaluate(`(() => {
      const ta = document.querySelector('[data-proto="annotation-editor"] textarea');
      ta.value = '公式这一句的注释';
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await ctx.sleep(150);
    const writesBefore = host.posts.length;
    await ctx.evaluate(`document.querySelector('[data-proto="annotation-save"]').click()`);
    await ctx.sleep(700);
    check('第二条标注写成（整份数组写回，两条都在）', host.posts.length === writesBefore + 1 && state.items.length === 2,
      JSON.stringify({ posts: host.posts.length, items: state.items.length }));

    // 展开列表 → 勾选两条
    await ctx.evaluate(`document.querySelector('[data-proto="annotations-toggle"]').click()`);
    await ctx.sleep(250);
    for (let i = 0; i < 2; i++) {
      await ctx.evaluate(`document.querySelectorAll('[data-proto="annotation-pick"]')[${i}].click()`);
      await ctx.sleep(200);
    }
    const picked = await ctx.evaluate(`(() => {
      const boxes = Array.from(document.querySelectorAll('[data-proto="annotation-pick"]'));
      const ask = document.querySelector('[data-proto="annotations-ask"]');
      return { checked: boxes.map((el) => !!el.checked), askText: ask ? ask.textContent.trim() : null, disabled: ask ? !!ask.disabled : null };
    })()`);
    check('多选两条标注：checkbox 都勾上，按钮写着「带着 2 条标注提问」',
      JSON.stringify(picked.checked) === '[true,true]' && picked.askText === '带着 2 条标注提问' && !picked.disabled,
      JSON.stringify(picked));

    const annotationsBefore = JSON.stringify(state.items);
    await ctx.evaluate(`document.querySelector('[data-proto="annotations-ask"]').click()`);
    await ctx.sleep(800);
    const ask = await ctx.evaluate(`(() => {
      const chip = document.querySelector('[data-proto="qa-quote"]');
      const toggle = document.querySelector('[data-proto="qa-quote-toggle"]');
      const tab = document.querySelector('[data-proto="tab-ask"]');
      const panel = document.querySelector('.smb-askbody');
      return {
        chip: chip ? chip.textContent.trim() : null,
        tabSelected: tab ? tab.getAttribute('aria-selected') : null,
        panel: !!panel,
        chipToggle: !!toggle,
      };
    })()`);
    check('点「带着 2 条标注提问」把右栏切到「问答」tab', ask.tabSelected === 'true', JSON.stringify(ask));
    check('问答面板输入框上方出现一条引用 chip（走现成 #106 机制）',
      !!ask.chip && ask.chip.indexOf('引用') >= 0 && ask.chip.indexOf('标注 1') >= 0 && ask.chip.indexOf('标注 2') >= 0,
      JSON.stringify(ask.chip));

    await ctx.evaluate(`document.querySelector('[data-proto="qa-quote-toggle"]').click()`);
    await ctx.sleep(250);
    const full = await ctx.evaluate(`(() => {
      const box = document.querySelector('[data-proto="qa-quote-full"]');
      return box ? box.textContent : null;
    })()`);
    check('点开 chip 看全文：两条标注的原文 + 注释都在',
      !!full && full.indexOf('标注 1（第') >= 0 && full.indexOf('标注 2（第') >= 0
      && full.indexOf('注释：') >= 0,
      JSON.stringify(full && full.slice(0, 80)));
    check('提问只拼引用、不改标注数据（没有多发写请求）', JSON.stringify(state.items) === annotationsBefore,
      JSON.stringify({ posts: host.posts.length }));
    return { chip: ask.chip, full: full && full.slice(0, 60) };
  });
} catch (error) {
  failures += 1;
  console.error('套件抛错：', error);
}

console.log(failures ? `\n${failures} 条失败` : '\n全部通过');
// 先关浏览器再关夹具服务器：页面开着时那条 EventSource 长连接还在，先 close 服务器会等它，
// 顺序反了会挂住进程（attempts_test.mjs 也是这个收尾顺序）。
await finishSuite(session, { suite: 'annotations', failed: failures });
await host.close();
try { fs.rmSync(path.dirname(home), { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
