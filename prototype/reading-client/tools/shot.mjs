// 原型自检：把每个变体的每个界面真跑一遍，收控制台错误、页面错误、失败请求，出整页截图。
//   node prototype/reading-client/tools/shot.mjs [--base http://127.0.0.1:4173]
//        [--only A,B] [--scenes home,lesson] [--width 1440]
// 产物：prototype/reading-client/.shots/<变体>-<界面>.png 与 summary.json
//
// 为什么不用 chrome 的 --screenshot：那个开关拿不到控制台，也点不动东西。
// 这个原型要验的恰恰是「点进去之后还对不对」，所以走 CDP。
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '.shots');
const baseArg = process.argv.indexOf('--base');
const BASE = baseArg > -1 ? process.argv[baseArg + 1] : 'http://127.0.0.1:4173';
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > -1 ? process.argv[onlyArg + 1].toUpperCase().split(',') : ['A', 'B', 'C'];
const widthArg = process.argv.indexOf('--width');
const WIDTH = widthArg > -1 ? Number(process.argv[widthArg + 1]) : 1440;
const scenesArg = process.argv.indexOf('--scenes');
const WANTED = scenesArg > -1 ? process.argv[scenesArg + 1].split(',') : null;
const SUFFIX = WIDTH === 1440 ? '' : `-${WIDTH}`;
const PORT = 9500 + Math.floor(Math.random() * 400);
const PROFILE = join(tmpdir(), 'smshot-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每个变体都要能走通的路：首页 → 科目 → 课件 → 作答。
// 定位靠 data-proto 钩子（变体自己贴的），不靠类名——类名是版式的一部分，三个变体不一样。
const GO_SUBJECT = 'document.querySelector("[data-proto=\'nav-subject\']")?.click()';
const OPEN_NODE = 'document.querySelector("[data-proto=\'open-node\']")?.click()';
const ANSWER = 'document.querySelectorAll("[data-proto=\'option\']")[1]?.click()';
const SEARCH = `(() => {
  const input = document.querySelector('[data-proto="search-input"]');
  if (!input) return 'no-search-input';
  input.focus();
  input.value = '子网';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const form = input.closest('form');
  if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return 'ok';
})()`;
// 选中正文 → 点「就这段问一句」→ 面板里提问：问答面板是 §7.4 的那条交互，必须真跑一遍
const SELECT_TEXT = `(() => {
  const p = document.querySelector('.sm-prose p, article p');
  if (!p) return 'no-paragraph';
  const range = document.createRange();
  range.selectNodeContents(p);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return 'selected';
})()`;
const CLICK_CHIP = 'document.querySelector(\'[data-proto="qa-chip"]\')?.click()';
const ASK = `(() => {
  const input = document.querySelector('[data-proto="qa-input"]');
  if (!input) return 'no-input';
  input.value = '这里的位运算为什么不是按 8 位切？';
  const form = input.closest('form');
  if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return 'asked';
})()`;

const SCENES = [
  { name: 'home', steps: [] },
  { name: 'subject', steps: [GO_SUBJECT] },
  { name: 'lesson', steps: [GO_SUBJECT, OPEN_NODE] },
  { name: 'lesson-answered', steps: [GO_SUBJECT, OPEN_NODE, ANSWER] },
  { name: 'search', steps: [SEARCH] },
  { name: 'qa', steps: [GO_SUBJECT, OPEN_NODE, SELECT_TEXT, CLICK_CHIP, ASK] },
  { name: 'anchor-stale', steps: [GO_SUBJECT, OPEN_NODE, `document.querySelector('.sm-proto-bar select').value='stale'; document.querySelector('.sm-proto-bar select').dispatchEvent(new Event('change',{bubbles:true}))`] },
];

const chrome = spawn('google-chrome', ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`, '--window-size=1440,960', 'about:blank'], { stdio: 'ignore' });
let spawnError = null;
chrome.on('error', (e) => { spawnError = e; });

async function target() {
  for (let i = 0; i < 80; i++) {
    if (spawnError) throw new Error(`chrome 起不来：${spawnError.message}`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error('chrome 没起来');
}

async function killChrome() {
  await new Promise((resolve) => {
    const done = () => resolve();
    chrome.once('exit', done);
    setTimeout(done, 3000);
    chrome.kill();
  });
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
}

let ws;
let id = 0;
const pending = new Map();
const events = [];
function send(method, params = {}) {
  return new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res && res.result ? res.result.value : undefined;
}

const report = { base: BASE, ranAt: new Date().toISOString(), scenes: [] };

try {
  const page = await target();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      events.push({ kind: 'console.' + m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? '').join(' ') });
    }
    if (m.method === 'Runtime.exceptionThrown') {
      events.push({ kind: 'pageerror', text: m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text });
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      events.push({ kind: 'log', text: m.params.entry.text + ' ' + (m.params.entry.url || '') });
    }
    if (m.method === 'Network.loadingFailed') {
      events.push({ kind: 'requestfailed', text: m.params.errorText + ' ' + (m.params.requestId || '') });
    }
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 960, deviceScaleFactor: 1, mobile: false });

  mkdirSync(OUT, { recursive: true });

  for (const variant of ONLY) {
    for (const scene of SCENES.filter((s) => !WANTED || WANTED.includes(s.name))) {
      events.length = 0;
      // 每个场景都从首页进：URL 定死入口，不捡上一场留下的位置
      await send('Page.navigate', { url: `${BASE}/?variant=${variant}&view=home` });
      await sleep(900);
      for (const step of scene.steps) {
        await evaluate(step);
        await sleep(450);
      }
      const metrics = await evaluate(`JSON.stringify({
        title: document.title,
        scrollHeight: document.documentElement.scrollHeight,
        bodyText: document.body.innerText.slice(0, 260),
        appChildren: document.getElementById('app').childElementCount
      })`);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const file = join(OUT, `${variant}-${scene.name}${SUFFIX}.png`);
      if (shot && shot.data) writeFileSync(file, Buffer.from(shot.data, 'base64'));
      report.scenes.push({
        variant, scene: scene.name + SUFFIX, file: `${variant}-${scene.name}${SUFFIX}.png`,
        metrics: JSON.parse(metrics || '{}'),
        problems: events.filter((e) => e.kind !== 'console.warning'),
        warnings: events.filter((e) => e.kind === 'console.warning'),
      });
      console.log(`${variant}/${scene.name}${events.length ? ' ⚠ ' + events.length + ' 条' : ' ok'}`);
    }
  }
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(report, null, 2));
  const bad = report.scenes.filter((s) => s.problems.length);
  console.log(`\n截图 ${report.scenes.length} 张 → ${OUT}`);
  if (bad.length) {
    console.log(`有问题的界面 ${bad.length} 个：`);
    for (const s of bad) for (const p of s.problems) console.log(`  ${s.variant}/${s.scene} [${p.kind}] ${p.text.slice(0, 240)}`);
  } else {
    console.log('控制台、页面错误、失败请求：全干净');
  }
} finally {
  try { ws && ws.close(); } catch {}
  await killChrome();
}
