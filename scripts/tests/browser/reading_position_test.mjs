// 课件页阅读位置三级恢复（#76）· 真 Chrome 里跑真 `lib/client.js`
//
//   node scripts/tests/browser/reading_position_test.mjs
//
// 为什么值得单写一套：位置恢复的另一半（量 DOM、读写本地偏好、切视图不丢）只有真浏览器
// 跑得出来。这里**不测夹具**——把 `lib/client.js` 原文喂给一个最小的模块装载器
// （照宿主冻结模块表的样子，只有 react 一个键），用真 React 挂出 `StudyMateApp` 本体，
// 再用 CDP 点真按钮、滚真滚动区、读真 DOM 属性。
//
// 纯数学那一半（三级降级选哪一级、滚到哪）在 `scripts/tests/test_client_reading_position.mjs`
// （默认门禁里跑，不需要浏览器）；这一套管的是「它接进界面之后还对」。
//
// 浏览器二进制要探测；找不到就**明确跳过并说明**，不静默绿（照 scripts/tests/README.md）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', '..', '..', 'lib', 'client.js');   // scripts/tests/browser → 仓库根
const FIXTURE = path.join(HERE, '..', 'fixtures', 'reading_position_fixture.mjs');

const TOLERANCE = 10;         // 像素容差：clamp 与重排都会差几个像素，差一整屏才是错
const SETTLE_MS = 1800;       // 实现里的恢复重试窗口是 1500ms，留点余量

/* ── 浏览器二进制：探测 ─────────────────────────────────────────────── */

function findChrome() {
  const candidates = [process.env.STUDYMATE_CHROME, 'google-chrome', 'chromium', 'chromium-browser', 'chrome']
    .filter(Boolean);
  for (const command of candidates) {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (!probe.error && probe.status === 0) {
      return { command, version: String(probe.stdout || '').trim() };
    }
  }
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.log('跳过：没探测到 Chrome / Chromium。'
    + '设 STUDYMATE_CHROME=<可执行文件>，或装上 google-chrome / chromium 再跑这一套。');
  process.exit(0);
}

/* ── 夹具：`lib/client.js` + 最小装载器 → 一份能上屏的资源表 ─────────── */

const { buildAssets, kernelSource } = await import(FIXTURE);
const assets = buildAssets(fs.readFileSync(CLIENT, 'utf8'), kernelSource());
const route = (name) => assets.find((asset) => asset.path === name) || null;

/* ── 起浏览器 + CDP ─────────────────────────────────────────────────── */

const PROFILE = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'smtest-readpos-'));
const PORT = 9700 + Math.floor(Math.random() * 250);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const child = spawn(chrome.command, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars',
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`,
  '--window-size=1400,900',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`${ORIGIN}/json/list`)).json();
      const page = list.find((item) => item.type === 'page');
      if (page) return page;
    } catch (error) { /* 还没起来 */ }
    await sleep(100);
  }
  throw new Error(`${chrome.command} 没起来（调试端口 ${PORT} 上没有页面目标）`);
}

let ws;
let send;
let failures = 0;
let passed = 0;

function check(label, ok, detail) {
  if (ok) { passed += 1; console.log(`  ✔ ${label}`); return; }
  failures += 1;
  console.error(`  ✖ ${label}${detail === undefined ? '' : `\n      ${JSON.stringify(detail)}`}`);
}

console.log(`阅读位置套件：${chrome.command}（${chrome.version}）`);

try {
  const page = await pageTarget();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP 连接失败'));
  });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Fetch.requestPaused') {
      // 页面请求一律自己答：夹具与 react 都在资源表里，不起服务器、不联网
      const { requestId, request } = message.params;
      let resource = null;
      try {
        const url = new URL(request.url);
        if (url.origin === ORIGIN) resource = route(url.pathname.replace(/^\//, '') || 'index.html');
      } catch (error) { resource = null; }
      if (!resource) {
        send('Fetch.fulfillRequest', { requestId, responseCode: 404, body: '' }).catch(() => {});
        return;
      }
      send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'content-type', value: resource.type },
          { name: 'cache-control', value: 'no-store' },
        ],
        body: Buffer.from(resource.body, 'utf8').toString('base64'),
      }).catch(() => {});
      return;
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  };
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = (nextId += 1);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Page.navigate', { url: `${ORIGIN}/index.html` });

  /** 一次探针：表达式在页面里求值。返回 Promise 的写成 IIFE（CDP 会等它）。 */
  async function probe(expression) {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression: `(${expression})`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(`页面里抛了：${exceptionDetails.text} ${exceptionDetails.exception?.description || ''}`);
    }
    return result.value;
  }

  /** 等到探针返回真（React 渲染与恢复重试都是异步的）。 */
  async function until(expression, { timeout = 8000, every = 100 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await probe(expression)) return true;
      if (Date.now() > deadline) return false;
      await sleep(every);
    }
  }

  const wait = (ms) => probe(`new Promise((r) => setTimeout(r, ${ms}))`);
  const settle = () => wait(SETTLE_MS);

  /* ── 上屏 ──────────────────────────────────────────────────────────── */

  const booted = await until(`typeof window.__sm === 'object' && !!window.__smPlugin && !!window.__smModules['react'] && !!window.__smModules['react-dom/client']`);
  check('最小装载器拿到 bundle 工厂，react / react-dom 都在冻结模块表里', booted);
  if (!booted) {
    const why = await probe(`({ boot: window.__smBoot || [], hasPlugin: !!window.__smPlugin, hasReact: !!window.__smModules['react'], hasDom: !!window.__smModules['react-dom/client'], hasScheduler: !!window.__smModules['scheduler'] })`);
    throw new Error(`页面没准备好：${JSON.stringify(why)}`);
  }

  const storage = await probe(`(() => {
    try { window.localStorage.setItem('__probe', '1'); window.localStorage.removeItem('__probe'); return 'ok'; }
    catch (error) { return 'blocked:' + error.name; }
  })()`);
  check(`本地偏好可用（${storage}）`, storage === 'ok');
  await probe(`window.__sm.clearPrefs()`);

  const diag = await probe(`({ modules: Object.keys(window.__smModules || {}), boot: window.__smBoot })`);
  check('冻结模块表里的键都执行完并挂上了（react / react-dom / scheduler）',
    ['scheduler', 'react', 'react-dom', 'react-dom/client'].every((key) => diag.modules.indexOf(key) >= 0) && diag.boot.length === 0, diag);
  const mounted = await probe(`window.__sm.mount()`);
  check('插件 apply() 往 main 座位登记了阅读端本体', mounted && mounted.seats.indexOf('main') >= 0, mounted);
  const onHome = await until(`!!document.querySelector('[data-proto="continue"]')`);
  check('真 client.js 挂起来了（主页「接着上次」出现）', onHome);
  if (!onHome) {
    const why = await probe(`({ host: document.getElementById('host').innerHTML.slice(0, 300), rootChildren: document.getElementById('host').childNodes.length, errors: window.__smErrors, boot: window.__smBoot, fetched: window.__smFetchLog })`);
    throw new Error(`没上屏：${JSON.stringify(why)}`);
  }

  const entered = await probe(`(async () => {
    window.__sm.click('[data-proto="continue"]');
    await new Promise((r) => setTimeout(r, 300));
    const s = window.__sm.probe();
    return {
      inLesson: s.inLesson,
      markers: document.querySelectorAll('.smb-qmark').length,
      sections: document.querySelectorAll('.smb-doc [data-section]').length,
      ids: s.sections.map((one) => one.id),
    };
  })()`);
  check('进课件页：正文小节与题目标记都渲染出来了',
    entered.inLesson === true && entered.sections === 5 && entered.markers === 4, entered);

  /* ── 验收 1：从课件跳去提问再回来，回到原位 ─────────────────────────── */

  const seeded = await probe(`(async () => {
    window.__sm.scrollTo(2, 220);
    await new Promise((r) => setTimeout(r, 400));       // 等滚动事件落盘
    return window.__sm.probe();
  })()`);
  const readout = await probe(`(() => {
    const holder = document.querySelector('template[data-proto="reading-position"]');
    if (!holder) return { present: false };
    const node = holder.content.firstElementChild;
    return { present: true, section: node.dataset.section, offset: node.dataset.sectionOffset, top: node.dataset.top };
  })()`);
  check('阅读位置的只读读数在位（后面几条验收都读它，读不到就不能算验过）',
    readout.present === true && Number.isFinite(Number(readout.offset)) && Number.isFinite(Number(readout.top)), readout);

  check('种子位置落在正文中间（不是顶部，也不是底部）',
    seeded.pageY > 300 && seeded.pageY < seeded.max - 100 && seeded.atSection === 2 && seeded.max > 2000, seeded);

  const asked = await probe(`(async () => {
    window.__sm.click('[data-proto="quiz-marker"]');    // 右栏滑出（正文重排）
    await new Promise((r) => setTimeout(r, 450));
    const opened = !!document.querySelector('.smb-right');
    window.__sm.click('[data-proto="toggle-quiz"]');    // 再点一次收起
    await new Promise((r) => setTimeout(r, 700));
    return { opened, closed: !document.querySelector('.smb-right'), after: window.__sm.probe() };
  })()`);
  check('右栏确实滑出又收起（这一段不是空跑）', asked.opened === true && asked.closed === true, asked);
  check(`验收 1 · 跳去提问再回来：回到原位（${seeded.pageY} → ${asked.after.pageY}，容差 ${TOLERANCE}）`,
    Math.abs(asked.after.pageY - seeded.pageY) <= TOLERANCE, { seeded, after: asked.after });
  check('验收 1 · 回来时还在同一节、同一段内偏移',
    asked.after.atSection === 2 && Math.abs(asked.after.sectionOffset - 220) <= TOLERANCE, asked.after);

  /* ── 验收 2：从搜索跳进正文再返回，位置可复现 ─────────────────────── */

  const home = await probe(`(async () => {
    window.__sm.click('.smb-brand');
    await new Promise((r) => setTimeout(r, 300));
    const title = document.querySelector('.smb-hero__title');
    return title ? title.textContent : '';
  })()`);
  check('回到主页（第 1 级）', home === '学习工作台', home);

  const searched = await probe(`(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    if (!document.querySelector('.smb-palette input')) return { opened: false };
    window.__sm.type('.smb-palette input', '读到这里就停一下');
    await new Promise((r) => setTimeout(r, 250));
    const hits = Array.from(document.querySelectorAll('.smb-hit'));
    if (!hits.length) return { opened: true, hits: 0 };
    hits[0].click();
    await new Promise((r) => setTimeout(r, 900));
    return { opened: true, hits: hits.length, inLesson: window.__sm.probe().inLesson };
  })()`);
  check('搜索面板能打开、能搜到正文那一段并跳进课件',
    searched.opened === true && searched.hits > 0 && searched.inLesson === true, searched);

  await settle();
  const afterSearch = await probe(`window.__sm.probe()`);
  check(`验收 2 · 从搜索跳进正文：位置可复现（${seeded.pageY} → ${afterSearch.pageY}）`,
    Math.abs(afterSearch.pageY - seeded.pageY) <= TOLERANCE, { seeded, afterSearch });
  check('验收 2 · 落在同一节、同一段内偏移',
    afterSearch.atSection === 2 && Math.abs(afterSearch.sectionOffset - 220) <= TOLERANCE, afterSearch);

  /* ── 验收 3：section 漂移 → 按 offset 降级，仍落在同一段附近 ───────── */

  const drifted = await probe(`(async () => {
    // 模拟「正文被改过」：把第 2 节拉长 2000px，后面几节整体被推下去。
    // 存下来的像素位置（${seeded.pageY}）从此落不到第 3 节上——只有按 offset 降级才对
    window.__sm.growSection(1, 2000);
    await new Promise((r) => setTimeout(r, 200));
    window.__sm.click('.smb-brand');
    await new Promise((r) => setTimeout(r, 300));
    window.__sm.click('[data-proto="continue"]');
    await new Promise((r) => setTimeout(r, ${SETTLE_MS + 400}));
    return window.__sm.probe();
  })()`);
  check('验收 3 · 正文改长后重进：没回到顶部', drifted.pageY > 400, drifted);
  check('验收 3 · section 漂了按 offset 降级：仍落在原来那一节附近',
    drifted.atSection === 2 && Math.abs(drifted.sectionOffset - 220) <= 60, drifted);

  /* ── 验收 5：位置只住在浏览器本地偏好里 ───────────────────────────── */

  const stored = await probe(`window.__sm.prefs()`);
  check('验收 5 · 位置只写本地偏好这一个键，没有别的存储落点（栏宽那个键本来就存在）',
    JSON.stringify(stored.keys.sort()) === '["studymate.panes.v1","studymate.reading.v1"]', stored.keys);
  const entry = stored.table && typeof stored.table === 'object' ? stored.table['demo/reading-position'] : null;
  check('验收 5 · 一篇文章一条，键名与 studymate.panes.v1 同族',
    stored.table && typeof stored.table === 'object'
      && Object.keys(stored.table).every((key) => key.indexOf('demo/') === 0), stored.table);
  check('验收 5 · 形状就是 {sectionId, offset, scrollTop, progress}',
    entry && Object.keys(entry).sort().join(',') === 'offset,progress,scrollTop,sectionId'
      && typeof entry.sectionId === 'string'
      && Number.isFinite(entry.offset) && Number.isFinite(entry.scrollTop)
      && entry.progress >= 0 && entry.progress <= 1,
    entry);

  /* ── 验收 3 的第三级：连小节都找不到时退到比例 ─────────────────────── */

  const byProgress = await probe(`(async () => {
    window.__sm.setPrefs({ 'demo/reading-position': { sectionId: 'sec-gone', offset: 0, progress: 0.5 } });
    window.__sm.click('.smb-brand');
    await new Promise((r) => setTimeout(r, 300));
    window.__sm.click('[data-proto="continue"]');
    await new Promise((r) => setTimeout(r, ${SETTLE_MS + 300}));
    return window.__sm.probe();
  })()`);
  check('验收 3 · 小节没了退到 progress：按比例落在正文中间，不是顶部',
    byProgress.pageY > 100 && Math.abs(byProgress.pageY - byProgress.max * 0.5) <= TOLERANCE * 4, byProgress);

  /* ── 验收 4：锚点四态 —— 非 resolved 时判分入口关闭 + 给出解释 ─────── */

  const anchors = await probe(`(async () => {
    const marks = Array.from(document.querySelectorAll('.smb-qmark')).map((el) => ({
      state: el.dataset.state, badge: el.querySelector('.smb-qmark__n').textContent,
    }));
    const out = [];
    const count = document.querySelectorAll('.smb-qmark').length;
    for (let i = 0; i < count; i += 1) {
      window.__sm.clickAll('.smb-qmark', i);
      await new Promise((r) => setTimeout(r, 240));
      // 右栏里四条锚点卡都渲染着（可折叠），所以只看**这一条**：按 data-anchor 取
      const card = document.querySelector('.smb-agroup[data-anchor="' + i + '"]');
      out.push({
        state: document.querySelectorAll('.smb-qmark')[i].dataset.state,
        options: card ? card.querySelectorAll('[data-proto="option"]').length : -1,
        asks: card ? card.querySelectorAll('.smb-q__ask').length : -1,
        warn: card && card.querySelector('.smb-note--warn') ? card.querySelector('.smb-note--warn').textContent : '',
        text: card ? card.textContent : '',
      });
      window.__sm.click('[data-proto="toggle-quiz"]');
      await new Promise((r) => setTimeout(r, 260));
    }
    return { marks, out };
  })()`);

  const states = anchors.marks.map((mark) => mark.state);
  check('正文四个标记正好对应四态各一条',
    JSON.stringify(states) === '["resolved","stale","ambiguous","missing"]', states);

  const byState = {};
  for (const one of anchors.out) byState[one.state] = one;

  check('resolved · 判分入口开着（选项按钮都在），不给警告',
    byState.resolved && byState.resolved.options >= 3 && byState.resolved.warn === '',
    byState.resolved && { options: byState.resolved.options, warn: byState.resolved.warn });

  check('stale · 判分入口关闭，并解释「要人来确认，确认前不判分」',
    byState.stale && byState.stale.options === 0 && byState.stale.asks === 0
      && byState.stale.text.indexOf('锚点与题库键只差空白') >= 0
      && byState.stale.text.indexOf('确认前不判分') >= 0,
    byState.stale && { options: byState.stale.options, warn: byState.stale.warn });

  check('ambiguous · 判分入口关闭，并解释「一个锚点对上了多个题库键」',
    byState.ambiguous && byState.ambiguous.options === 0 && byState.ambiguous.asks === 0
      && byState.ambiguous.text.indexOf('对上了多个题库键') >= 0
      && byState.ambiguous.text.indexOf('选一个才算数') >= 0,
    byState.ambiguous && { options: byState.ambiguous.options, warn: byState.ambiguous.warn });

  check('missing · 判分入口关闭，并解释「题库里没有这道题」',
    byState.missing && byState.missing.options === 0 && byState.missing.asks === 0
      && byState.missing.text.indexOf('题库里没有这道题') >= 0,
    byState.missing && { options: byState.missing.options, warn: byState.missing.warn });

  check('非 resolved 的解释在正文标记上就看得到（不是只有右栏才知道）',
    anchors.marks[1].badge.indexOf('只差空白') >= 0
      && anchors.marks[2].badge.indexOf('多个题库键') >= 0
      && anchors.marks[3].badge.indexOf('没有这道题') >= 0,
    anchors.marks);

  /* ── 归零按层级区分：单栏两级归零，课件页不复位 ────────────────────── */

  const resets = await probe(`(async () => {
    window.__sm.click('.smb-brand');
    await new Promise((r) => setTimeout(r, 300));
    const scroller = document.querySelector('.smb-scroll');
    scroller.scrollTop = 300;
    await new Promise((r) => setTimeout(r, 120));
    const seeded = scroller.scrollTop;
    window.__sm.clickSubject('演示科目');                 // 进第 2 级（科目主页）
    await new Promise((r) => setTimeout(r, 400));
    const toSubject = document.querySelector('.smb-scroll').scrollTop;
    window.__sm.click('.smb-crumb');                     // 回第 1 级
    await new Promise((r) => setTimeout(r, 400));
    const toHome = document.querySelector('.smb-scroll').scrollTop;
    const box = document.querySelector('.smb-scroll');
    return { seeded, toSubject, toHome, scrollHeight: box.scrollHeight, clientHeight: box.clientHeight };
  })()`);
  check('第 1/2 级仍然归零（主页 → 科目主页 → 主页）',
    resets.seeded > 0 && resets.toSubject === 0 && resets.toHome === 0, resets);

  const kept = await probe(`(async () => {
    window.__sm.click('[data-proto="nav-subject"]');
    await new Promise((r) => setTimeout(r, 300));
    window.__sm.click('[data-proto="open-node"]');
    await new Promise((r) => setTimeout(r, ${SETTLE_MS + 300}));
    return window.__sm.probe();
  })()`);
  check('课件页不归零：进课件页走恢复而不是回顶部', kept.pageY > 100, kept);

  console.log(`\n阅读位置（真 Chrome + 真 client.js）：${passed} 项通过，${failures} 项失败`);
} catch (error) {
  failures += 1;
  console.error(`套件自身出错：${error && error.stack ? error.stack : error}`);
} finally {
  try { if (ws) ws.close(); } catch (error) { /* 关不掉就算了 */ }
  await new Promise((resolve) => {
    const done = () => resolve();
    child.once('exit', done);
    setTimeout(done, 3000);
    child.kill();
  });
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (error) { /* 删不掉就留着 */ }
}

process.exit(failures ? 1 : 0);
