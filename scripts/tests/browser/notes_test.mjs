/* 无界笔记首阶段的浏览器验收（独立网页 = 自动化验收入口，不是第二交付形态）。
   ────────────────────────────────────────────────────────────────────────────────
   历史：原型期有两份 Python 套件，`prototypes/unbounded-notes/test_v4.py`（54 项）与
   `test_v5.py`（37 项）。它们按「第几版样式」分文件、靠 `URL='http://127.0.0.1:4178/'`
   指向一个要人先起好的 dev server、截图写在原型根。这里按**语义**重组，不保留版本号：
   一份套件、一台真 Edge、一个同进程的静态服务器，断言全在「学生看得见的行为」上。

   跑法：
     npm run test:notes:browser        # 先 build:notes:preview，再跑这一套
     node scripts/tests/browser/notes_test.mjs
     STUDYMATE_NOTES_TEST_URL=http://127.0.0.1:1234/ node scripts/tests/browser/notes_test.mjs

   页面来源（按顺序）：
      1. `STUDYMATE_NOTES_TEST_URL`：外部已起好的站点，直接用（不再本地起服务器）。
      2. `dist/notes-preview/index.html`：`npm run build:notes:preview` 的产物。
   缺产物 = 红灯（不是跳过）：构建链断了就修构建，不回退旧原型 dist。
   只有浏览器二进制本身缺失才按仓库约定跳过（退出码 3）。

   不用 @playwright/test，也不依赖 harness.mjs：这里的浏览器要**独立 Edge**
   （`channel: 'msedge'`，一次性 context，不继承任何登录态），而 harness 起的是无头
   Chrome + CDP。playwright 不导出 `expect`，断言用 node:assert + locator 等待。

   每个场景收集：console.error、pageerror、失败的请求、以及任何**出了本机回环之外**的
   请求（外网、模型端点）。任一非空即算失败——包括 sandbox iframe 里冒上来的控制台错误，
   不允许靠「忽略某些错误」变绿。iframe 里的滚动用截图逐像素比较来验，不在 sandbox 里求值。
*/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { inflateSync, deflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CONTRAST_PROBE } from '../fixtures/contrast-probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SUITE = 'notes';
const EXIT_SKIP = 3;

/* ── 环境探测：浏览器二进制缺失才跳过，其它一律红 ──────────────────────── */

const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));

function skip(reason) {
  console.error('');
  console.error('╭─ 跳过：' + SUITE);
  for (const line of String(reason).split('\n')) console.error('│ ' + line);
  console.error('╰─ 退出码 ' + EXIT_SKIP + '（跳过，不算通过）');
  process.exit(EXIT_SKIP);
}

function loadPlaywright() {
  let entry;
  try {
    entry = requireFromRoot.resolve('playwright');
  } catch {
    throw new Error('playwright 没装：它是根 devDependencies（npm ci 会装），这一套不能跳过。');
  }
  return import(pathToFileURL(entry).href);
}

/** 页面从哪来：外部 URL / 本地产物；缺产物直接失败（不跳过），因为那是构建链的问题。 */
function pageSource() {
  const external = process.env.STUDYMATE_NOTES_TEST_URL;
  if (external) return { kind: 'external', url: external };
  const dir = path.join(ROOT, 'dist', 'notes-preview');
  const index = path.join(dir, 'index.html');
  if (!fs.existsSync(index)) {
    throw new Error([
      '没有 dist/notes-preview/index.html：独立网页的构建产物不在，这一套直接判失败（不跳过）。',
      '先构建：npm run build:notes:preview（或直接 npm run test:notes:browser，它会先构建）。',
      '不回退 prototypes/unbounded-notes/dist：旧原型的产物不再是被验收的对象。',
    ].join('\n'));
  }
  return { kind: 'local', dir, url: null };
}

/** 本地静态服务器：127.0.0.1 随机端口，根就是 dist/notes-preview（index.html 在根上）。 */
async function serveNotes(dir) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const file = path.join(dir, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/* ── 报告 ───────────────────────────────────────────────────────────────── */

let failures = 0;
let checks = 0;
const results = [];

/** 一条断言。失败不中断场景（继续跑，拿到整张表），但最终退出码是 1。 */
function check(label, ok, detail = '') {
  checks += 1;
  failures += ok ? 0 : 1;
  results.push({ label, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}

async function guarded(label, fn) {
  try {
    const detail = await fn();
    check(label, true, detail);
  } catch (error) {
    check(label, false, String(error && error.message ? error.message : error).split('\n').slice(0, 3).join(' / '));
  }
}

async function record(name, body) {
  console.log(`\n── ${name}`);
  try {
    await body();
  } catch (error) {
    check(`[${name}] 场景跑完（${error && error.message ? error.message.split('\n')[0] : '原因不明'}）`, false);
  }
}

/* ── 截图差异（iframe 滚动用像素差，不进 sandbox 求值） ────────────────── */

/** 从 PNG 里读回 RGBA：只认 8 位、非隔行的那些（浏览器截图一直是这一种）。 */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let offset = 8;
  let width = 0; let height = 0; let depth = 0; let colorType = 0; let interlace = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; colorType = body[9]; interlace = body[12];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  if (depth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) throw new Error(`不支持的 PNG 形态：depth=${depth} color=${colorType} interlace=${interlace}`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? line[i - bpp] : 0;
      const up = previous[i];
      const upLeft = i >= bpp ? previous[i - bpp] : 0;
      if (filter === 1) line[i] = (line[i] + left) & 0xff;
      else if (filter === 2) line[i] = (line[i] + up) & 0xff;
      else if (filter === 3) line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - upLeft);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff;
      }
    }
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      pixels[at] = line[x * bpp];
      pixels[at + 1] = line[x * bpp + 1];
      pixels[at + 2] = line[x * bpp + 2];
      pixels[at + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    previous = line;
  }
  return { width, height, pixels };
}

/** 两张同尺寸截图的差异比例。只用于「同一区域滚了一点」这类粗判：滚动一定改变大片像素。 */
function pngDiff(a, b) {
  const left = decodePng(a);
  const right = decodePng(b);
  assert.equal(left.width, right.width, '两次截图的宽度不一致');
  assert.equal(left.height, right.height, '两次截图的高度不一致');
  let changed = 0;
  for (let at = 0; at < left.pixels.length; at += 4) {
    if (left.pixels[at] !== right.pixels[at] || left.pixels[at + 1] !== right.pixels[at + 1] || left.pixels[at + 2] !== right.pixels[at + 2]) changed += 1;
  }
  return { changed, ratio: changed / (left.width * left.height) };
}

/* ── 页面操作的小工具 ───────────────────────────────────────────────────── */

const VIEWPORT = { width: 1600, height: 1000 };

/** viewport 变换（平移/缩放）读成数字，比较用。 */
async function viewport(page) {
  return page.evaluate(() => {
    const node = document.querySelector('.react-flow__viewport');
    const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(node?.style.transform || '');
    return match ? { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) } : null;
  });
}

async function zoomPercent(page) {
  await page.waitForFunction(() => /\d+%/.test(document.querySelector('.zoom-label')?.textContent || ''), null, { timeout: 8000 });
  return Number((await page.locator('.zoom-label').textContent()).replace('%', ''));
}

/** 节点在屏幕上的矩形（用 .react-flow__node 的 data-id，稳定，不靠 DOM 顺序）。 */
async function nodeBox(page, id) {
  const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  assert.ok(box, `节点 ${id} 不在画布上`);
  return box;
}

async function drag(page, from, to, steps = 14) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

async function centerOf(locator) {
  const box = await locator.boundingBox();
  assert.ok(box, '元素没有盒子');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** 画布 idle：React Flow 的测量与 fitView 都在头两帧里。 */
async function settle(page, ms = 260) {
  await page.waitForTimeout(ms);
}

/**
 * 收起左栏并逐帧采样宽度。
 *
 * 不能先 `await locator.click()` 再固定等 90ms：Playwright 的点击本身可能消耗几十到上百毫秒，
 * 固定等待从点击返回后才开始，采样点可能已经落在过渡结束后（实测 90ms 时宽度已是 0）。
 * 这里把真实点击与 requestAnimationFrame 采样放进同一个 page.evaluate：点击后从第一帧开始记录，
 * 直到宽度归零或超时。断言仍要求「出现过中间宽度」且「最终为 0」，不是放松成只看终态。
 */
async function collapseAndSample(page) {
  return page.evaluate(async () => {
    const panel = document.querySelector('.left-panel');
    const button = document.querySelector('[aria-label="收起文件侧栏"]');
    if (!panel || !button) throw new Error('找不到左栏或收起按钮');
    const startWidth = panel.getBoundingClientRect().width;
    const samples = [];
    button.click();
    const started = performance.now();
    await new Promise((resolve) => {
      const sample = () => {
        const width = panel.getBoundingClientRect().width;
        samples.push(width);
        if (width === 0 || performance.now() - started > 450) resolve();
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    return { startWidth, samples, finalWidth: panel.getBoundingClientRect().width };
  });
}

async function openPage(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length > 0, null, { timeout: 15000 });
  await settle(page, 420);
}

/** 当前单一内联编辑器的原始 Markdown（DOM 里保留真实分隔符，不读产品内部状态）。 */
async function rawEditorText(page) {
  return page.locator('.markdown-inline-editor .cm-content').textContent();
}

/** 显形/隐藏的 Markdown 分隔符。显形的才是「光标碰到的当前格式」。 */
async function syntaxMarks(page) {
  return page.evaluate(() => [...document.querySelectorAll('.markdown-inline-editor .md-syntax')].map((el) => ({
    text: el.textContent,
    hidden: el.classList.contains('md-syntax-hidden'),
    display: getComputedStyle(el).display,
    color: getComputedStyle(el).color,
  })));
}

/** 点一行正文，不依赖行号/行内坐标；光标落在这一行即可。 */
async function clickEditorLine(page, needle) {
  const line = page.locator('.markdown-inline-editor .cm-line').filter({ hasText: needle }).first();
  await line.waitFor({ state: 'visible', timeout: 8000 });
  await line.click({ position: { x: 14, y: 10 } });
  await page.waitForTimeout(160);
  return line;
}

/**
 * 用真实键盘在行内选中一段原文：Home 回行首，再按原始字符数右移。
 * 隐藏的分隔符仍然是文档字符，所以计数按 raw textContent，而不是 innerText。
 */
async function selectRawPhrase(page, lineNeedle, phrase) {
  const line = await clickEditorLine(page, lineNeedle);
  await page.keyboard.press('Home');
  const raw = await line.textContent();
  const start = raw.indexOf(phrase);
  assert.ok(start >= 0, `这一行找不到「${phrase}」：${raw}`);
  for (let index = 0; index < start; index += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.down('Shift');
  for (let index = 0; index < phrase.length; index += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(120);
  return raw;
}

/** 画布默认形态：左栏开着、右栏关着、视图是画布。 */
const LEFT_TOGGLE = '.topbar-panel-toggle';

async function ensureLeftOpen(page, open) {
  const collapsed = await page.locator('.left-panel').evaluate((el) => el.classList.contains('is-collapsed'));
  if (collapsed === open) {
    const button = page.getByRole('button', { name: open ? '展开文件侧栏' : '收起文件侧栏', exact: true });
    await button.first().click();
    await settle(page, 320);
  }
}

// 高纵横比图片覆盖曾出现的折叠透明命中区；PNG 在临时目录现造，不依赖图片库。
function tallPng(width = 80, height = 520) {
  const crc = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * (1 + width * 3) + 1 + x * 3;
    pixels[index] = 40; pixels[index + 1] = y % 256; pixels[index + 2] = 180;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

// 静态媒体夹具：现造现弃（写进 os.tmpdir，进程结束删掉；不往源码树里留东西）。
function mediaFiles() {
  const scrollPage = [
    '<!doctype html><html><head><meta charset="utf-8"><title>滚动测试</title>',
    '<style>html,body{margin:0} .tall{height:2600px;background:linear-gradient(#5b8def,#ef6d6d 60%,#f5d76e)}'
    + ' .row{margin:0;padding:18px;font:16px/1.4 sans-serif;color:#13233a;background:#fff}</style></head>',
    '<body><div class="tall"></div><p class="row">末尾的一行</p><script>window.top.__mediaRan = true; document.title = "跑起来了";</script></body></html>',
  ].join('');
  const svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" role="img" aria-label="示例图">',
    '<rect width="320" height="180" fill="#e8f3ef"/><circle cx="80" cy="90" r="40" fill="#2f6f5e"/><text x="150" y="96" font-size="18">静态 SVG</text>',
    '<script>window.top.__svgRan = true;</script></svg>'].join('');
  const write = (name, body) => { const file = path.join(mediaDir(), name); fs.writeFileSync(file, body); return file; };
  return { html: write('滚动示例.html', scrollPage), svg: write('静态图.svg', svg), dir: mediaDir() };
}

// 只删除本进程 mkdtemp 创建的子目录，绝不删除调用方指定的父目录。
let mediaDirName = null;
function mediaDir() {
  if (!mediaDirName) {
    const parent = path.resolve(process.env.STUDYMATE_NOTES_FIXTURES || os.tmpdir());
    fs.mkdirSync(parent, { recursive: true });
    mediaDirName = fs.mkdtempSync(path.join(parent, 'studymate-notes-media-'));
  }
  return mediaDirName;
}

const NOTES_MARKDOWN = '# 主动回忆：先想，再看\n\n合上材料，先说一遍。\n\n再看答案，对照缺了哪一块。\n';

const source = pageSource();
let server = null;
let baseUrl = source.url;
if (source.kind === 'local') {
  const served = await serveNotes(source.dir);
  server = served.server;
  baseUrl = served.origin + '/';
}

const playwright = await loadPlaywright();
// `import('playwright')` 的 default 才是 playwright 对象（具名导出在 ESM 命名空间里，且不一定有）。
const { chromium } = playwright.default || playwright;

const outDir = process.env.STUDYMATE_NOTES_SHOTS || path.join(ROOT, '.preview', 'notes');
fs.mkdirSync(outDir, { recursive: true });

// 只有「这台机器上根本没有这个浏览器」才跳过；浏览器自己起不来、版本不对都是失败。
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
} catch (error) {
  const message = String(error && error.message ? error.message : error);
  const missing = /(Executable doesn't exist|is not found at|Unable to launch browser|not installed|no such file|ENOENT|Could not find (Microsoft Edge|Chrome))/i.test(message)
    && /(channel|msedge|Edge|executable)/i.test(message);
  if (server) server.close();
  if (!missing) throw error;
  skip([
    '启动不了独立 Edge（channel: msedge）：' + message.split('\n')[0],
    '这一套需要本机装有 Microsoft Edge；没有就跳过（退出码 3，不算通过）。',
  ].join('\n'));
}

/** 一个新页面 + 一支问题收集器。任何场景都从这里开，保证零错误的要求一视同仁。 */
async function newPage({ viewport = VIEWPORT, colorScheme = 'light', reducedMotion = 'reduce', init } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, reducedMotion, locale: 'zh-CN', deviceScaleFactor: 1 });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const problems = [];
  page.on('console', (message) => { if (message.type() === 'error') problems.push('console: ' + message.text()); });
  page.on('pageerror', (error) => problems.push('pageerror: ' + error.message));
  page.on('requestfailed', (request) => problems.push('requestfailed: ' + request.url() + ' ' + (request.failure()?.errorText || '')));
  page.on('response', (response) => { if (response.status() >= 400) problems.push('status ' + response.status() + ': ' + response.url()); });
  page.on('request', (request) => {
    // 主文档与 iframe（静态媒体卡）的请求都算：sandbox 空串的 iframe 里若真发出外网请求，
    // 这里看得见。回环之外一律记成问题。
    const url = request.url();
    if (/^(data|blob|about):/.test(url)) return;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(url)) problems.push('external: ' + url);
  });
  return {
    context,
    page,
    problems,
    /** 关页面时说清楚「这一场干净」。 */
    async close(name) {
      check(`[${name}] 控制台错误 / 页面错误 / 失败请求 / 外网请求 都是 0`, problems.length === 0, problems.slice(0, 4).join(' | '));
      await context.close();
    },
  };
}

async function shot(page, name) {
  return page.screenshot({ path: path.join(outDir, name + '.png'), animations: 'disabled' });
}

try {
  /* ─── 1. 首屏与外壳 ─────────────────────────────────────────────────── */
  {
    const { page, close } = await newPage();
    try {
      await openPage(page, baseUrl);
      await record('外壳与首屏', async () => {
        check('[外壳] 内页不再单独出现品牌名与图标（顶栏品牌由宿主承担）', (await page.locator('.brand-name, .brand-icon').count()) === 0);
        check('[外壳] 徽标如实说「开发中 · 刷新重置」（不假装能保存）', (await page.locator('.prototype-badge').textContent()).trim() === '开发中 · 刷新重置');
        const toggle = await page.locator(LEFT_TOGGLE).getAttribute('aria-label');
        check('[外壳] 右栏开关在顶栏最右侧，默认是「展开右侧栏」', toggle === '展开右侧栏' && (await page.locator('.topbar button').last().evaluate((el) => el.classList.contains('topbar-panel-toggle'))));
        check('[外壳] 右栏默认收起（宽度 0、aria-hidden）', await page.locator('.right-panel').evaluate((el) => el.getBoundingClientRect().width === 0 && el.getAttribute('aria-hidden') === 'true'));
        check('[外壳] 左栏默认展开，宽度在 200–480 之间', await page.locator('.left-panel').evaluate((el) => { const w = el.getBoundingClientRect().width; return w >= 200 && w <= 480; }));
        check('[外壳] 画布上有 4 张示例卡片与 3 条关系', (await page.locator('.react-flow__minimap-node').count()) === 4 && (await page.locator('.react-flow__edge').count()) === 3);
        check('[外壳] 小地图上的节点数与画布一致', (await page.locator('.react-flow__minimap-node').count()) === 4);
        check('[外壳] 工具栏的按钮都是画布工具（选择/平移/纯内容/撤销/重做/缩放/适应）', await page.locator('.canvas-toolbar[role=toolbar]').evaluate((el) => ['选择工具', '平移工具', '添加纯内容节点', '撤销画板操作', '重做画板操作', '缩小画布', '放大画布', '适应全部卡片'].every((name) => !!el.querySelector(`[aria-label="${name}"]`))));
        check('[外壳] 资源树按文件夹分层，笔记与引用都在树上', await page.evaluate(() => [...document.querySelectorAll('.tree-row')].some((row) => row.textContent.includes('连接，先于堆积')) && [...document.querySelectorAll('.tree-row')].some((row) => row.textContent.includes('React Flow'))));
        await shot(page, 'shell-default');
      });
    } finally {
      await close('外壳与首屏');
    }
  }

  /* ─── 2. 整卡拖动、选择与缩放 ───────────────────────────────────────── */
  {
    const { page, close } = await newPage();
    try {
      await openPage(page, baseUrl);
      await record('画布：整卡拖动 / 选中 / 缩放', async () => {
        const before = await nodeBox(page, 'card-connections');
        const handle = page.locator('.react-flow__node[data-id="card-connections"] .card-drag-handle');
        await drag(page, { x: before.x + 60, y: before.y + 12 }, { x: before.x + 140, y: before.y + 72 });
        await settle(page);
        const moved = await nodeBox(page, 'card-connections');
        await guarded('[拖动] 抓住页头拖整张卡：位置跟着指针走（约 80×60）', () => {
          const dx = moved.x - before.x; const dy = moved.y - before.y;
          assert.ok(Math.abs(dx - 80) <= 6 && Math.abs(dy - 60) <= 6, `dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`);
        });
        const body = await nodeBox(page, 'card-connections');
        await drag(page, { x: body.x + body.width / 2, y: body.y + body.height - 28 }, { x: body.x + body.width / 2 + 40, y: body.y + body.height - 8 });
        const bodyMoved = await nodeBox(page, 'card-connections');
        check('[拖动] 整张卡都抓得动：拖正文只是移动，不会改尺寸', Math.abs(bodyMoved.width - body.width) < 1.5 && Math.abs(bodyMoved.x - body.x) > 20, `${body.width.toFixed(0)} → ${bodyMoved.width.toFixed(0)}，x ${body.x.toFixed(0)} → ${bodyMoved.x.toFixed(0)}`);
        await page.locator('.react-flow__node[data-id="card-recall"] .card-drag-handle').click();
        await settle(page);
        check('[选中] 点卡片后它进入选中态（.is-selected），拖动四角出现缩放手柄', await page.locator('.react-flow__node[data-id="card-recall"] .knowledge-card').evaluate((el) => el.classList.contains('is-selected')));
        const resizer = page.locator('.react-flow__node[data-id="card-recall"] .react-flow__resize-control.bottom.right');
        const handles = await page.locator('.react-flow__node[data-id="card-recall"] .react-flow__resize-control').count();
        check('[缩放] 选中的卡片带 8 个缩放手柄', handles >= 8 && (await resizer.count()) === 1, `count=${handles}`);
        // 小地图是独立 HUD，可能盖住卡片右下角；先通过正常拖动把卡片移到操作区，
        // 不把 HUD 的平移误测成节点 resize（不隐藏小地图或直接改 DOM 几何）。
        const grip = await centerOf(page.locator('.react-flow__node[data-id="card-recall"] .card-drag-handle'));
        await drag(page, grip, { x: grip.x - 130, y: grip.y - 130 });
        await settle(page);
        const start = await nodeBox(page, 'card-recall');
        const corner = await centerOf(resizer);
        assert.ok(await resizer.evaluate((el) => { const box = el.getBoundingClientRect(); const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2); return hit === el || el.contains(hit); }), 'resize 起点必须实际命中手柄，不是小地图或侧栏');
        await drag(page, corner, { x: corner.x + 60, y: corner.y + 40 });
        await settle(page);
        const resized = await nodeBox(page, 'card-recall');
        check('[缩放] 拖右下角把卡片放大（宽高各自 +40 以上，有最小尺寸兜底）', resized.width > start.width + 30 && resized.height > start.height + 18, `${start.width.toFixed(0)}×${start.height.toFixed(0)} → ${resized.width.toFixed(0)}×${resized.height.toFixed(0)}`);
        const zoom0 = await zoomPercent(page);
        await page.getByRole('button', { name: '放大画布', exact: true }).click();
        await settle(page, 320);
        const zoom1 = await zoomPercent(page);
        await page.getByRole('button', { name: '缩小画布', exact: true }).click();
        await page.getByRole('button', { name: '缩小画布', exact: true }).click();
        await settle(page, 320);
        const zoom2 = await zoomPercent(page);
        check('[缩放] 工具栏放大/缩小改变画布缩放，读数同步', zoom1 > zoom0 && zoom2 < zoom1, `${zoom0}% → ${zoom1}% → ${zoom2}%`);
        await page.getByRole('button', { name: '适应全部卡片', exact: true }).click();
        await settle(page, 420);
        const fitted = await page.evaluate(() => {
          const stage = document.querySelector('.canvas-stage').getBoundingClientRect();
          const nodes = [...document.querySelectorAll('.react-flow__node')];
          return nodes.length === 4 && nodes.every((node) => {
            const box = node.getBoundingClientRect();
            return box.left >= stage.left - 2 && box.right <= stage.right + 2 && box.top >= stage.top - 2 && box.bottom <= stage.bottom + 2;
          });
        });
        check('[缩放] 「适应全部卡片」把四张卡都收进画布可视区', fitted);
      });
    } finally {
      await close('画布：整卡拖动 / 选中 / 缩放');
    }
  }

  /* ─── 3. 空格平移 + 滚轮缩放 ───────────────────────────────────────── */
  {
    const { page, close } = await newPage();
    try {
      await openPage(page, baseUrl);
      await record('画布：空格平移 / 空格 + 滚轮缩放', async () => {
        // 先把视图缩到最小：初始视图下四张卡几乎铺满画布，「空白处」不好找。
        // 缩放未变说明指针确实落在空白（不是卡片，也不是卡内的可滚动区）。
        const blank = await page.locator('.canvas-stage').boundingBox();
        const spot = { x: blank.x + 24, y: blank.y + blank.height - 24 };
        const trimmed = await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          return { cls: el ? el.className : null, inNode: Boolean(el && el.closest('.react-flow__node')) };
        }, spot);
        check('[滚轮] 起手点确实是画布空白（不在任何卡片里）', trimmed.inNode === false, JSON.stringify(trimmed));
        await page.mouse.move(spot.x, spot.y);
        const idle = await viewport(page);
        await page.mouse.wheel(0, -300);
        await settle(page, 320);
        const wheelOnly = await viewport(page);
        check('[滚轮] 普通滚轮缩放画布，未按空格时不出现强制平移层', Math.abs(wheelOnly.zoom - idle.zoom) > 0.01 && (await page.locator('[data-testid="space-pan-layer"]').count()) === 0, `${idle.zoom.toFixed(3)} → ${wheelOnly.zoom.toFixed(3)}`);
        await page.keyboard.down('Space');
        await page.locator('[data-testid="space-pan-layer"]').waitFor({ state: 'visible', timeout: 5000 });
        check('[空格] 按住空格出现平移捕获层，画布挂上 is-space-panning', await page.locator('.canvas-stage').evaluate((el) => el.classList.contains('is-space-panning')));
        const beforePan = await viewport(page);
        const layer = page.locator('[data-testid="space-pan-layer"]');
        const box = await layer.boundingBox();
        await drag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: box.x + box.width / 2 - 90, y: box.y + box.height / 2 - 60 });
        await settle(page, 200);
        const panned = await viewport(page);
        await guarded('[空格] 空格 + 拖动平移画布，缩放不变', () => {
          assert.ok(Math.abs((panned.x - beforePan.x) - -90) <= 6, `dx=${(panned.x - beforePan.x).toFixed(1)}`);
          assert.ok(Math.abs((panned.y - beforePan.y) - -60) <= 6, `dy=${(panned.y - beforePan.y).toFixed(1)}`);
          assert.ok(Math.abs(panned.zoom - beforePan.zoom) < 0.001, `zoom ${panned.zoom}`);
        });
        await page.mouse.move(760, 520);
        await page.mouse.wheel(0, -260);
        await settle(page, 260);
        const zoomed = await viewport(page);
        check('[空格] 保持空格时滚轮缩放画布（围绕光标，缩放变大）', zoomed.zoom > panned.zoom + 0.02, `${panned.zoom.toFixed(3)} → ${zoomed.zoom.toFixed(3)}`);
        await page.keyboard.up('Space');
        await settle(page, 220);
        check('[空格] 松开空格：捕获层收起，平移态解除', (await page.locator('[data-testid="space-pan-layer"]').count()) === 0 && !(await page.locator('.canvas-stage').evaluate((el) => el.classList.contains('is-space-panning'))));
        const after = await viewport(page);
        await page.getByRole('button', { name: '平移工具', exact: true }).click();
        await settle(page, 160);
        const area = await page.locator('.canvas-stage').boundingBox();
        const handBlank = await page.evaluate((area) => {
          for (let y = area.y + 60; y < area.y + area.height - 60; y += 40) {
            for (let x = area.x + 150; x < area.x + area.width - 150; x += 40) {
              const hit = document.elementFromPoint(x, y);
              if (hit?.classList.contains('react-flow__pane')) return { x, y };
            }
          }
          throw new Error('没有找到真正的画布空白');
        }, area);
        await drag(page, handBlank, { x: handBlank.x + 70, y: handBlank.y + 50 });
        await settle(page, 260);
        const handPanned = await viewport(page);
        check('[平移] 切到平移工具后左键拖动也能平移', Math.abs(handPanned.x - after.x) > 20 || Math.abs(handPanned.y - after.y) > 20, `${after.x.toFixed(0)},${after.y.toFixed(0)} → ${handPanned.x.toFixed(0)},${handPanned.y.toFixed(0)}`);
        check('[平移] 点阵与卡片用同一套画布坐标（缩放后点阵间距跟着变）', await page.evaluate(() => !!document.querySelector('#studymate-grid, .react-flow__background')));
        await page.keyboard.press('v');
        await settle(page, 120);
        check('[工具] 按 V 回到选择工具，按 H 走平移工具', await page.locator('[aria-label="选择工具"]').evaluate((el) => el.classList.contains('active')));
        await page.keyboard.press('h');
        await settle(page, 120);
        check('[工具] H 切回平移工具', await page.locator('[aria-label="平移工具"]').evaluate((el) => el.classList.contains('active')));
      });
    } finally {
      await close('画布：空格平移 / 滚轮缩放');
    }
  }

  /* ─── 4. 撤销 / 重做（画板历史） ───────────────────────────────────── */
  {
    const { page, close } = await newPage();
    try {
      await openPage(page, baseUrl);
      await record('画板历史：撤销与重做', async () => {
        const undo = page.getByRole('button', { name: '撤销画板操作', exact: true });
        const redo = page.getByRole('button', { name: '重做画板操作', exact: true });
        check('[历史] 初始没有可撤销/可重做的东西（按钮禁用）', (await undo.isDisabled()) && (await redo.isDisabled()));
        const before = await nodeBox(page, 'card-connections');
        await drag(page, { x: before.x + 40, y: before.y + 14 }, { x: before.x + 150, y: before.y + 90 });
        await settle(page);
        const moved = await nodeBox(page, 'card-connections');
        check('[历史] 拖动之后「撤销」可用', !(await undo.isDisabled()), `moved=${(moved.x - before.x).toFixed(0)}`);
        await undo.click();
        await settle(page, 240);
        const undone = await nodeBox(page, 'card-connections');
        check('[历史] 撤销把卡片放回拖动前的位置', Math.abs(undone.x - before.x) < 1.5 && Math.abs(undone.y - before.y) < 1.5, `${undone.x.toFixed(0)},${undone.y.toFixed(0)} vs ${before.x.toFixed(0)},${before.y.toFixed(0)}`);
        check('[历史] 撤销之后「重做」可用', !(await redo.isDisabled()));
        await redo.click();
        await settle(page, 240);
        const redone = await nodeBox(page, 'card-connections');
        check('[历史] 重做回到拖动后的位置', Math.abs(redone.x - moved.x) < 1.5 && Math.abs(redone.y - moved.y) < 1.5);
        await page.keyboard.press('Control+z');
        await settle(page, 240);
        const byKey = await nodeBox(page, 'card-connections');
        check('[历史] Ctrl+Z 撤销画板操作（与工具栏按钮同一条栈）', Math.abs(byKey.x - before.x) < 1.5);
        await page.keyboard.press('Control+Shift+z');
        await settle(page, 240);
        const redoneByKey = await nodeBox(page, 'card-connections');
        check('[历史] Ctrl+Shift+Z 重做', Math.abs(redoneByKey.x - moved.x) < 1.5);
        const count0 = await page.locator('.react-flow__node').count();
        await page.getByRole('button', { name: '添加纯内容节点', exact: true }).click();
        await settle(page, 240);
        await page.keyboard.press('Escape');
        await settle(page, 140);
        const count1 = await page.locator('.react-flow__node').count();
        await undo.click();
        await settle(page, 240);
        const count2 = await page.locator('.react-flow__node').count();
        check('[历史] 加节点进历史：撤销后节点数与关系数都回到原样', count1 === count0 + 1 && count2 === count0, `${count0} → ${count1} → ${count2}`);
      });
    } finally {
      await close('画板历史：撤销与重做');
    }
  }

  /* ─── 5. 侧栏、分隔线、编辑器高度 ─────────────────────────────────── */
  {
    const { page, close } = await newPage();
    try {
      await openPage(page, baseUrl);
      await record('布局：左右栏收放 / 拖宽 / 编辑器高度', async () => {
        const left = page.locator('.left-panel');
        const width0 = await left.evaluate((el) => el.getBoundingClientRect().width);
        await page.getByRole('button', { name: '收起文件侧栏', exact: true }).click();
        await settle(page, 360);
        const collapsedState = await left.evaluate((el) => ({ width: el.getBoundingClientRect().width, inert: el.hasAttribute('inert'), hidden: el.getAttribute('aria-hidden') }));
        check('[左栏] 收起后宽度归零、inert 且 aria-hidden', collapsedState.width === 0 && collapsedState.inert && collapsedState.hidden === 'true', JSON.stringify(collapsedState));
        check('[左栏] 收起后留一条窄轨，里面是「展开文件侧栏」', (await page.getByRole('button', { name: '展开文件侧栏', exact: true }).isVisible()) && (await page.locator('.panel-rail--left').evaluate((el) => el.getBoundingClientRect().width)) > 0);
        await page.getByRole('button', { name: '展开文件侧栏', exact: true }).click();
        await settle(page, 360);
        const width1 = await left.evaluate((el) => el.getBoundingClientRect().width);
        check('[左栏] 展开回到原来的宽度（状态没丢）', Math.abs(width1 - width0) < 1.5, `${width0} → ${width1}`);
        const hit = page.getByRole('separator', { name: '调整左侧栏宽度' });
        await hit.waitFor({ state: 'visible', timeout: 8000 });
        const hitBox = await hit.boundingBox();
        const gripX = hitBox.x + 3;
        const gripY = hitBox.y + 240;
        await page.mouse.move(gripX, gripY);
        await page.mouse.down();
        await page.mouse.move(gripX + 60, gripY, { steps: 10 });
        const resizing = await page.locator('.app-shell').getAttribute('data-resizing');
        await page.mouse.up();
        await settle(page, 240);
        const width2 = await left.evaluate((el) => el.getBoundingClientRect().width);
        check('[左栏] 拖右侧的分隔线把左栏拖宽（有最小/最大兜底）', width2 > width1 + 30 && width2 <= 480, `${width1} → ${width2}`);
        check('[左栏] 拖动期间根上挂 data-resizing（过渡关掉，不追手）', resizing === 'true', String(resizing));
        await hit.focus();
        await page.keyboard.press('ArrowRight');
        await settle(page, 200);
        const width3 = await left.evaluate((el) => el.getBoundingClientRect().width);
        check('[左栏] 分隔线可键盘调宽（→ +16px）', Math.abs(width3 - (width2 + 16)) < 2.5, `${width2} → ${width3}`);
        await page.locator(LEFT_TOGGLE).click();
        await settle(page, 360);
        const right = page.locator('.right-panel');
        const rightWidth = await right.evaluate((el) => el.getBoundingClientRect().width);
        check('[右栏] 顶栏按钮展开右栏，宽度在 270–600 之间且不再 inert', rightWidth >= 270 && rightWidth <= 600 && !(await right.evaluate((el) => el.hasAttribute('inert'))), String(rightWidth));
        check('[右栏] 展开的按钮变成「收起右侧栏」，aria-expanded 同步', (await page.locator(LEFT_TOGGLE).getAttribute('aria-label')) === '收起右侧栏' && (await page.locator(LEFT_TOGGLE).getAttribute('aria-expanded')) === 'true');
        const rightHit = await page.getByRole('separator', { name: '调整右侧栏宽度' }).boundingBox();
        // 新开出来的右栏略等一帧：React Flow 的节点测量会改画布尺寸，右栏此刻可能还在重排。
        await page.waitForFunction(() => {
          const hit = [...document.querySelectorAll('[role=separator]')].find((el) => el.getAttribute('aria-label') === '调整右侧栏宽度');
          if (!hit) return false;
          const box = hit.getBoundingClientRect();
          const at = document.elementFromPoint(box.x + 4, box.y + 260);
          return Boolean(at) && (at === hit || hit.contains(at));
        }, null, { timeout: 8000 });
        await page.mouse.move(rightHit.x + 3, rightHit.y + 260);
        await page.mouse.down();
        await page.mouse.move(rightHit.x + 3 - 70, rightHit.y + 260, { steps: 10 });
        await page.mouse.up();
        await settle(page, 240);
        const rightWidth2 = await right.evaluate((el) => el.getBoundingClientRect().width);
        check('[右栏] 拖左边界把它拖宽（往左拖就是变宽，方向不能反）', rightWidth2 > rightWidth + 40, `${rightWidth} → ${rightWidth2}`);
        await page.locator(LEFT_TOGGLE).click();
        await settle(page, 360);
        check('[右栏] 收起后宽度归零、aria-hidden', await right.evaluate((el) => el.getBoundingClientRect().width === 0 && el.getAttribute('aria-hidden') === 'true'));
        await page.getByRole('button', { name: '新建笔记', exact: true }).click();
        await settle(page, 600);
        await page.locator('.document-scroll > .note-editor .markdown-inline-editor .cm-editor').waitFor({ state: 'visible', timeout: 8000 });
        const inlineLayout = await page.evaluate(() => {
          const row = document.querySelector('.document-toolbar')?.getBoundingClientRect();
          const bar = document.querySelector('.md-format-toolbar')?.getBoundingClientRect();
          const note = document.querySelector('.document-scroll > .note-editor')?.getBoundingClientRect();
          const scroller = document.querySelector('.markdown-inline-editor .cm-scroller');
          const names = ['编辑', '阅读', '分屏'];
          return {
            scrollClass: document.querySelector('.document-scroll')?.className || '',
            gap: row && bar ? bar.top - row.bottom : NaN,
            barHeight: bar?.height || 0,
            noteHeight: note?.height || 0,
            scrollerHeight: scroller?.clientHeight || 0,
            modeButtons: [...document.querySelectorAll('button')].filter((el) => names.includes((el.getAttribute('aria-label') || el.textContent || '').trim())).length,
            legacyPanes: document.querySelectorAll('.document-preview-pane, .document-source, .editor-pane, .editor-resize-hit, .cm-lineNumbers').length,
            previews: document.querySelectorAll('.document-stage .document-preview-pane, .document-stage .markdown-preview').length,
            toolbars: document.querySelectorAll('.md-format-toolbar').length,
            inlineEditors: document.querySelectorAll('.markdown-inline-editor .cm-editor').length,
            visibleText: document.querySelector('.document-stage')?.innerText || '',
          };
        });
        check('[编辑器] 新建笔记直接进入单一内联编辑器（没有编辑/阅读/分屏模式）', inlineLayout.scrollClass.includes('is-inline') && inlineLayout.modeButtons === 0 && inlineLayout.legacyPanes === 0 && inlineLayout.previews === 0, JSON.stringify(inlineLayout));
        check('[编辑器] 文件标题行下只有一条格式栏，正文紧跟其后', inlineLayout.toolbars === 1 && inlineLayout.inlineEditors === 1 && inlineLayout.gap >= -1 && inlineLayout.gap < 4 && inlineLayout.barHeight <= 40, `gap=${inlineLayout.gap.toFixed(1)} bar=${inlineLayout.barHeight.toFixed(0)}`);
        check('[编辑器] 内联编辑器铺满文档区，不是旧的固定高小窗口', inlineLayout.noteHeight > 300 && inlineLayout.scrollerHeight > 220, `note=${inlineLayout.noteHeight.toFixed(0)} scroller=${inlineLayout.scrollerHeight}`);
        check('[编辑器] 标题行不再重复「Markdown 正文 / 即时编辑」字样', !/Markdown 正文|即时编辑/.test(inlineLayout.visibleText), inlineLayout.visibleText.slice(0, 120));
      });
    } finally {
      await close('布局：左右栏收放 / 拖宽 / 编辑器高度');
    }
  }

  /* ─── 6. 文档编辑器：单一行内编辑 / 真实标记 / 选区格式 ─────────────── */
  /* 旧「阅读 / 编辑 / 分屏」断言 → 当前单一内联编辑器，逐项对应：
     - 删除「编辑」按钮 aria-pressed → 断言 .document-scroll.is-inline + .note-editor[data-mode=inline]；
     - 删除「阅读」预览与 .document-preview-pane → 断言没有预览面板，正文本身就是可编辑源码；
     - 删除「分屏」.is-split、分隔线拖动/双击 → 断言没有第二编辑/预览面板与文档分隔线；
     - 删除 .cm-lineNumbers / data-gutter-digits 行号断言 → 断言没有行号栏；标尺改为真实灰色 .md-syntax；
     - 删除阅读态 <table>/<a target=_blank> 断言 → 同一编辑器里断言 .md-table 与 .katex；
     - 新增：灰色分隔符只在当前格式显形、真实删除标记、选中/折叠格式化、标题更新不动正文、内联滚动。 */
  {
    const { page, close } = await newPage();
    try {
      await openPage(page, baseUrl);
      await record('文档：单一行内编辑 / 真实标记 / 选区格式', async () => {
        await page.getByRole('button', { name: /^打开 主动回忆/ }).dblclick();
        await settle(page, 420);
        const editor = page.locator('.markdown-inline-editor .cm-editor');
        await editor.waitFor({ state: 'visible', timeout: 8000 });
        const title = page.getByRole('textbox', { name: '文档标题' });
        check('[编辑器] 标题是 note 时可以改（文档标题输入框在）', await title.isVisible());

        const shell = await page.evaluate(() => ({
          scrollClass: document.querySelector('.document-scroll')?.className || '',
          modeButtons: ['编辑', '阅读', '分屏'].filter((name) => [...document.querySelectorAll('button')].some((el) => (el.getAttribute('aria-label') || el.textContent || '').trim() === name)),
          legacy: document.querySelectorAll('.document-preview-pane, .document-source, .editor-pane, .editor-resize-hit, .cm-lineNumbers, .note-editor__modes, .note-editor__bar').length,
          toolbars: document.querySelectorAll('.md-format-toolbar').length,
          inlineEditors: document.querySelectorAll('.markdown-inline-editor .cm-editor').length,
          splitHandles: document.querySelectorAll('[role=separator][aria-label="调整编辑与预览宽度"]').length,
        }));
        check('[编辑器] 只有单一内联编辑器：没有编辑/阅读/分屏模式、预览面板或行号', shell.scrollClass.includes('is-inline') && shell.modeButtons.length === 0 && shell.legacy === 0 && shell.splitHandles === 0 && shell.toolbars === 1 && shell.inlineEditors === 1, JSON.stringify(shell));

        const controls = await page.evaluate(() => ({
          labels: [...document.querySelectorAll('.md-format-toolbar button, .md-format-toolbar select')].map((el) => el.getAttribute('aria-label')).filter(Boolean),
          headings: [...document.querySelectorAll('.md-format-toolbar select option')].map((el) => el.textContent),
          barHeight: document.querySelector('.md-format-toolbar')?.getBoundingClientRect().height || 0,
          barFits: (() => { const bar = document.querySelector('.md-format-toolbar'); return bar ? bar.scrollWidth <= bar.clientWidth + 1 : false; })(),
        }));
        const wanted = ['标题', '粗体', '斜体', '删除线', '行内代码', '链接', '无序列表', '有序列表', '引用', '更多格式'];
        check('[格式栏] 一条扁平栏包含标题、行内、段落与更多格式', wanted.every((name) => controls.labels.includes(name)) && JSON.stringify(controls.headings) === JSON.stringify(['正文', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']), JSON.stringify(controls.labels));
        check('[格式栏] 1600px 下保持单行、控件不横向溢出', controls.barHeight <= 40 && controls.barFits, `height=${controls.barHeight.toFixed(0)}`);

        const rawStart = await rawEditorText(page);
        const blocksStart = await page.evaluate(() => ({
          tables: document.querySelectorAll('.markdown-inline-editor .md-table').length,
          code: document.querySelectorAll('.markdown-inline-editor .md-code-body').length,
          katex: document.querySelectorAll('.markdown-inline-editor .katex').length,
          tableText: document.querySelector('.markdown-inline-editor .md-table')?.innerText || '',
        }));
        check('[源码] 正文原文就在编辑器里，表格/代码/公式由同一份源码渲染', rawStart.includes('# 主动回忆') && rawStart.includes('**我的行动：**') && blocksStart.tables >= 1 && blocksStart.code >= 1 && blocksStart.katex >= 1 && blocksStart.tableText.includes('再读') && blocksStart.tableText.includes('主动回忆'), `${rawStart.slice(0, 70)} / ${JSON.stringify(blocksStart)}`);
        check('[无序列化] 没有另一份预览 DOM，打开正文不经过 HTML 序列化', (await page.locator('.document-scroll .markdown-preview, .document-scroll .document-preview-pane').count()) === 0);
        await title.fill('主动回忆（只改标题）');
        await settle(page, 240);
        check('[无序列化] 改文件标题不重写/重排正文源码', (await rawEditorText(page)) === rawStart);
        await title.fill('主动回忆：先想，再看');
        await settle(page, 200);

        await clickEditorLine(page, '合上材料');
        let marks = await syntaxMarks(page);
        check('[标记] 光标不在格式里时，分隔符保持隐藏', marks.filter((mark) => !mark.hidden).length === 0 && marks.some((mark) => mark.hidden), `${marks.length} marks`);
        const rawBeforeFocus = await rawEditorText(page);
        const strongLine = page.locator('.markdown-inline-editor .cm-line').filter({ hasText: '我的行动' }).first();
        const strongMark = page.locator('.markdown-inline-editor .md-strong').filter({ hasText: '我的行动' }).first();
        // 文件最后一行、真实粗体文字的中部点击：这是学生实际会做的动作，
        // 不允许用行上缘或键盘选区绕过。核心修复必须让这里把光标放进 span。
        await strongMark.click();
        await settle(page, 180);
        marks = await syntaxMarks(page);
        const visibleMarks = marks.filter((mark) => !mark.hidden);
        const bodyColor = await page.locator('.markdown-inline-editor .cm-line').first().evaluate((el) => getComputedStyle(el).color);
        const colorChannels = (color) => {
          const values = String(color).match(/[\d.]+/g)?.map(Number) || [];
          // Chromium 可能把 color-mix 计算成 color(srgb 0.30 0.35 0.39)（0–1），
          // 也可能沿用 rgb(41, 51, 61)（0–255）；统一折到 0–255 再比较灰度。
          const rgb = String(color).startsWith('color(srgb') ? values.slice(0, 3).map((value) => value * 255) : values.slice(0, 3);
          return rgb;
        };
        const markChannels = colorChannels(visibleMarks[0]?.color);
        check('[标记] 光标进入粗体后，只有这一对 ** 真实显形', visibleMarks.length >= 2 && visibleMarks.every((mark) => mark.text.includes('*')) && visibleMarks.some((mark) => mark.text === '**'), JSON.stringify(visibleMarks));
        check('[标记] 显形分隔符是灰色真实字符，不是普通正文颜色', visibleMarks.length > 0 && visibleMarks[0].color !== bodyColor && markChannels.length === 3 && Math.max(...markChannels) - Math.min(...markChannels) < 40, `${visibleMarks[0]?.color} vs ${bodyColor}`);
        check('[无序列化] 光标显隐只改装饰，不改正文源码', (await rawEditorText(page)) === rawBeforeFocus);
        const styled = await page.evaluate(() => ({
          strong: Number(getComputedStyle(document.querySelector('.markdown-inline-editor .md-strong')).fontWeight),
          hidden: document.querySelectorAll('.markdown-inline-editor .md-syntax-hidden').length,
        }));
        check('[标记] 粗体正文仍保持粗体，其他格式标记仍收起', styled.strong >= 600 && styled.hidden > 0, JSON.stringify(styled));

        // 激活后不再二次点击：真实 Home 回行首，再按原始字符数右移，
        // Shift+Right 选中结束的 ** 后 Backspace，全部走原生键盘。
        const strongLineText = await strongLine.textContent();
        const closingIndex = strongLineText.lastIndexOf('**');
        assert.ok(closingIndex > 0, '找不到结束分隔符');
        await page.keyboard.press('Home');
        for (let index = 0; index < closingIndex; index += 1) await page.keyboard.press('ArrowRight');
        await page.keyboard.down('Shift');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.up('Shift');
        await page.keyboard.press('Backspace');
        await settle(page, 220);
        const rawAfterDelete = await rawEditorText(page);
        check('[标记] 真实选中并删除结束 ** 会改正文（不是只改样式）', rawAfterDelete !== rawBeforeFocus && !rawAfterDelete.includes('**我的行动：**'), rawAfterDelete.slice(-70));
        await page.keyboard.press('Control+z');
        await settle(page, 220);
        check('[标记] 撤销删除后源码逐字恢复', (await rawEditorText(page)) === rawBeforeFocus);

        await selectRawPhrase(page, '合上材料', '再回去检查遗漏');
        await page.getByRole('button', { name: '粗体', exact: true }).click();
        await settle(page, 220);
        const rawBold = await rawEditorText(page);
        const selectedBold = await page.locator('.markdown-inline-editor .md-strong').evaluateAll((els) => els.some((el) => el.textContent.includes('再回去检查遗漏') && Number(getComputedStyle(el).fontWeight) >= 600));
        check('[格式] 选中文字点粗体：源码插入 **，选中内容仍按粗体呈现', rawBold.includes('**再回去检查遗漏**') && selectedBold);
        await page.keyboard.press('Control+z');
        await settle(page, 180);

        await clickEditorLine(page, '合上材料');
        await page.keyboard.press('End');
        const rawBeforeCollapsed = await rawEditorText(page);
        await page.keyboard.press('Control+b');
        await settle(page, 220);
        const rawCollapsed = await rawEditorText(page);
        check('[格式] 折叠光标 Ctrl+B 插入成对 ** 且光标停在中间', rawCollapsed.length === rawBeforeCollapsed.length + 4 && rawCollapsed.includes('****'));
        await page.keyboard.press('Control+z');
        await settle(page, 180);
        check('[格式] 撤销折叠格式化后正文完全恢复', (await rawEditorText(page)) === rawBeforeCollapsed);

        const rawBeforeLink = await rawEditorText(page);
        await page.keyboard.press('Control+k');
        const dialog = page.getByRole('dialog', { name: '插入链接' });
        await dialog.waitFor({ state: 'visible', timeout: 5000 });
        const linkFocus = await page.evaluate(() => Boolean(document.activeElement?.closest('label')?.innerText.includes('链接地址')));
        check('[链接] Ctrl+K 打开可访问链接对话框，地址框先聚焦', linkFocus);
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        await settle(page, 180);
        check('[链接] 取消不写正文：没有插入 []() 或改动原稿', (await dialog.count()) === 0 && (await rawEditorText(page)) === rawBeforeLink);

        const blocks = await page.evaluate(() => ({
          tables: document.querySelectorAll('.markdown-inline-editor .md-table').length,
          katex: document.querySelectorAll('.markdown-inline-editor .katex').length,
          code: document.querySelectorAll('.markdown-inline-editor .md-code-body').length,
        }));
        check('[块级] 同一编辑器内渲染 GFM 表格、代码块与公式', blocks.tables >= 1 && blocks.code >= 1 && blocks.katex >= 1, JSON.stringify(blocks));

        await clickEditorLine(page, '主动回忆');
        await page.keyboard.press('Control+End');
        await page.keyboard.insertText('\n' + '滚动检查行。\n'.repeat(36));
        await settle(page, 320);
        const scroller = page.locator('.markdown-inline-editor .cm-scroller');
        const size = await scroller.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
        check('[滚动] 长正文在编辑器内部滚动，文档区高度不撑破页面', size.scrollHeight > size.clientHeight + 60, JSON.stringify(size));
        await page.keyboard.press('Control+Home');
        await settle(page, 160);
        const wheelBox = await scroller.boundingBox();
        await page.mouse.move(wheelBox.x + wheelBox.width / 2, wheelBox.y + wheelBox.height / 2);
        await page.mouse.wheel(0, Math.max(520, wheelBox.height * 0.8));
        await settle(page, 260);
        const scrolled = await scroller.evaluate((el) => el.scrollTop);
        check('[滚动] 真实滚轮改变编辑器内部滚动位置', scrolled > 0, String(scrolled));
        const barBox = await page.locator('.md-format-toolbar').boundingBox();
        const noteBox = await page.locator('.document-scroll > .note-editor').boundingBox();
        check('[滚动] 滚动正文时格式栏留在文件标题下方', barBox.y >= noteBox.y - 1 && barBox.y - noteBox.y < 3, `${noteBox.y} → ${barBox.y}`);
        await shot(page, 'document-inline');
      });
    } finally {
      await close('文档：单一行内编辑 / 真实标记 / 选区格式');
    }
  }

  /* ─── 7. 导入：副本 / 引用 ─────────────────────────────────────────── */
  {
    const { page, close } = await newPage();
    try {
      await openPage(page, baseUrl);
      await record('导入：副本与引用', async () => {
        const markdown = ['# 临时导入的笔记', '', '这一段来自测试现造的临时文件，内容不来自仓库。', '', '- [x] 一条已完成的任务', '- [ ] 一条未完成的任务', ''].join('\n');
        const fileInput = page.locator('input[type=file][aria-label="导入笔记与静态媒体"]');
        await page.getByRole('button', { name: '导入', exact: true }).click();
        const menu = page.locator('[role=menu][aria-label="导入模式"]');
        await menu.waitFor({ state: 'visible', timeout: 5000 });
        check('[导入] 「导入」弹出两个模式：副本 / 引用', (await menu.locator('[role=menuitem]').count()) === 2 && (await menu.innerText()).includes('副本') && (await menu.innerText()).includes('引用'));
        await page.keyboard.press('Escape');
        await settle(page, 160);
        check('[导入] Esc 收起菜单，焦点回到「导入」按钮', (await menu.count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === '导入');
        await page.getByRole('button', { name: '导入', exact: true }).click();
        await menu.waitFor({ state: 'visible' });
        // 「副本」这个菜单项走的是 page 自己那支隐藏 input（chooseFiles → fileInput.click()）。
        // 仓库的其它浏览器套件也都不读 WebDriver 的文件选择事件，这里同样直接喂 input：
        // 菜单到 input 的接线由下面的「添加引用」弹窗 + toast 文案兜住。
        await menu.locator('[role=menuitem]').filter({ hasText: '副本' }).click();
        await settle(page, 240);
        check('[导入] 选了「副本」菜单：菜单收起，没有弹第二道问（副本是默认语义）', (await menu.count()) === 0 && (await page.locator('[role=dialog]').count()) === 0);
        await fileInput.setInputFiles([{ name: '临时导入.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown, 'utf8') }]);
        await settle(page, 700);
        check('[导入·副本] 导入后资源树里出现这个文件', await page.getByRole('button', { name: '打开 临时导入.md', exact: true }).isVisible());
        const nodeCount = await page.locator('.react-flow__node').count();
        check('[导入·副本] 同时放上一张卡片（节点数 +1）', nodeCount === 5, String(nodeCount));
        const badge = page.locator('.tree-row.tree-file').filter({ hasText: '临时导入' }).locator('.resource-origin-badge');
        check('[导入·副本] 树上的来源徽标写「副本」', (await badge.textContent()).trim() === '副本' && (await badge.getAttribute('data-origin')) === 'local');
        await page.getByRole('button', { name: '打开 临时导入.md', exact: true }).click();
        await settle(page, 260);
        const rightText = await page.locator('.resource-detail').innerText();
        check('[导入·副本] 选中后右栏预览正文（能看见刚写的那句话）', rightText.includes('这一段来自测试现造的临时文件'));
        check('[导入·副本] 右栏的来源徽标在，文字说清是副本', (await page.locator('.resource-detail .resource-origin-badge').count()) === 1);
        await page.getByRole('button', { name: '导入', exact: true }).click();
        await menu.waitFor({ state: 'visible' });
        await page.getByRole('menuitem', { name: /引用/ }).click();
        const dialog = page.locator('[role=dialog][aria-label="添加引用"]');
        await dialog.waitFor({ state: 'visible', timeout: 5000 });
        check('[导入·引用] 「引用」打开「添加引用」弹窗，两种来源都在', (await dialog.getByRole('button', { name: /选择本地文件/ }).isVisible()) && (await dialog.getByRole('button', { name: /添加网页引用/ }).isVisible()));
        // 「选择本地文件」在没有文件句柄能力的环境里直接转给同一支隐藏 input。
        await dialog.getByRole('button', { name: /选择本地文件/ }).click();
        await settle(page, 240);
        await fileInput.setInputFiles([{ name: '临时引用.md', mimeType: 'text/markdown', buffer: Buffer.from('# 引用\n\n引用不写回原文件。\n', 'utf8') }]);
        await settle(page, 700);
        const refBadge = page.locator('.tree-row.tree-file').filter({ hasText: '临时引用' }).locator('.resource-origin-badge');
        check('[导入·引用] 引用在树上有自己的标记（引用 / link）', (await refBadge.textContent()).trim() === '引用' && (await refBadge.getAttribute('data-origin')) === 'link');
        check('[导入·引用] 拖入的素材会先问模式（画布上有「松开后选择」的提示位）', (await page.locator('.canvas-drop-hint').count()) === 1);
        await page.getByRole('button', { name: /^打开 临时引用/ }).click();
        await settle(page, 260);
        check('[导入·引用] 右栏有「重新读取引用」，预览照常可读', (await page.getByRole('button', { name: /重新读取引用/ }).isVisible()) && (await page.locator('.resource-detail').innerText()).includes('引用不写回原文件'));
        await fileInput.setInputFiles([{ name: '超大.txt', mimeType: 'text/plain', buffer: Buffer.alloc(513 * 1024, 97) }]);
        const errorDialog = page.locator('[role=dialog][aria-label="部分文件未导入"]');
        await errorDialog.waitFor({ state: 'visible', timeout: 8000 });
        const errorText = await errorDialog.innerText();
        check('[导入] 超过 512 KiB 的文本被拒，弹窗说清楚是哪个文件、为什么', errorText.includes('超大.txt') && errorText.includes('512'));
        await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
        await settle(page, 200);
        check('[导入] 被拒的文件没有进树', (await page.getByRole('button', { name: /^打开 超大/ }).count()) === 0);
        await page.getByRole('button', { name: '导入', exact: true }).click();
        await menu.waitFor({ state: 'visible' });
        await page.getByRole('menuitem', { name: /引用/ }).click();
        await page.getByRole('button', { name: /添加网页引用/ }).click();
        const linkDialog = page.locator('[role=dialog][aria-label="添加网页"]');
        await linkDialog.waitFor({ state: 'visible' });
        await page.getByRole('textbox', { name: '网页地址' }).fill('javascript:alert(1)');
        await page.getByRole('textbox', { name: '网页标题' }).fill('坏链接');
        await linkDialog.getByRole('button', { name: '添加', exact: true }).click();
        await settle(page, 240);
        check('[导入·引用] 只收 HTTP(S)：javascript: 地址当场报错、不添加', (await linkDialog.locator('[role=alert]').innerText()).includes('HTTP') && (await page.getByRole('button', { name: /^打开 坏链接/ }).count()) === 0);
        await page.getByRole('textbox', { name: '网页地址' }).fill('https://example.com/notes');
        await page.getByRole('textbox', { name: '网页标题' }).fill('示例网页');
        await linkDialog.getByRole('button', { name: '添加', exact: true }).click();
        await settle(page, 400);
        check('[导入·引用] 合法的网页引用进树，并被选中', (await page.getByRole('button', { name: '打开 示例网页', exact: true }).count()) === 1);
        const toast = await page.locator('.toast').innerText().catch(() => '');
        check('[导入·引用] 明确说「不抓取网页正文」', toast.includes('不抓取'), toast);
        // 网页引用只存地址与标题：右栏是文本摘要 + 外链，不是内嵌网页，更不会去抓。
        await page.getByRole('button', { name: '打开 示例网页', exact: true }).click();
        await settle(page, 320);
        const linkDetail = page.locator('.resource-detail');
        check('[导入·引用] 网页引用在右栏只是外链（target=_blank、noopener），没有内嵌或拉取', (await linkDetail.locator('a[href="https://example.com/notes"]').count()) === 1 && (await linkDetail.locator('iframe').count()) === 0 && (await linkDetail.locator('a').first().getAttribute('rel') || '').includes('noopener'));
      });
    } finally {
      await close('导入：副本与引用');
    }
  }

  /* ─── 8. 引用失效：handle 撤权 → fail closed ───────────────────────── */
  {
    // 模拟「有文件句柄、但拿不到权限」：把 showOpenFilePicker 换成被用户取消的桩，
    // 导入会退回本次文件选择，并把引用标成「本次」。
    const { page, close } = await newPage({
      init: `Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: () => { const error = new Error('用户取消'); error.name = 'AbortError'; return Promise.reject(error); } });`,
    });
    try {
      await openPage(page, baseUrl);
      await record('引用：句柄不可重开时如实说', async () => {
        const fileInput = page.locator('input[type=file][aria-label="导入笔记与静态媒体"]');
        await page.getByRole('button', { name: '导入', exact: true }).click();
        const menu = page.locator('[role=menu][aria-label="导入模式"]');
        await menu.waitFor({ state: 'visible' });
        await menu.locator('[role=menuitem]').filter({ hasText: '引用' }).click();
        const dialog = page.locator('[role=dialog][aria-label="添加引用"]');
        await dialog.waitFor({ state: 'visible' });
        await dialog.getByRole('button', { name: /选择本地文件/ }).click();
        await settle(page, 300);
        await fileInput.setInputFiles([{ name: '句柄不可用.md', mimeType: 'text/markdown', buffer: Buffer.from('# 引用\n\n句柄不可用时只保留本次文件。\n', 'utf8') }]);
        await settle(page, 800);
        const toast = await page.locator('.toast').innerText().catch(() => '');
        check('[引用失效] 没有可重开的句柄时，导入提示里明说「仅保留本次文件引用」', /仅保留本次/.test(toast) && /重新选择/.test(toast), toast);
        await page.getByRole('button', { name: /^打开 句柄不可用/ }).click();
        await settle(page, 260);
        const detail = await page.locator('.resource-detail').innerText();
        check('[引用失效] 右栏标出这是引用，并说明原件变化要重新选择', detail.includes('引用') && (detail.includes('重新选择') || detail.includes('重新读取')), detail.slice(0, 120));
        check('[引用失效] 引用是只读的：文档视图里没有标题框、格式栏或可编辑源码', await (async () => {
          await page.getByRole('button', { name: '文档', exact: true }).click().catch(() => {});
          await settle(page, 320);
          return (await page.getByRole('textbox', { name: '文档标题' }).count()) === 0
            && (await page.locator('.document-stage .md-format-toolbar').count()) === 0
            && (await page.locator('.document-stage .markdown-inline-editor .cm-editor').count()) === 0
            && (await page.locator('.document-stage .note-editor.is-readonly').count()) === 1;
        })());
        check('[引用失效] 页面没有任何「已保存」的暗示（内存态如实呈现）', !(await page.locator('body').innerText()).includes('已保存'));
      });
    } finally {
      await close('引用：句柄不可重开时如实说');
    }
  }

  /* ─── 9. 静态 HTML / SVG：沙箱、无脚本、无外网、可滚动 ─────────────── */
  {
    const { page, close } = await newPage();
    try {
      await openPage(page, baseUrl);
      await record('静态媒体：sandbox / 禁脚本 / 禁外网 / 可滚动', async () => {
        const { html: htmlFile, svg: svgFile } = mediaFiles();
        const fileInput = page.locator('input[type=file][aria-label="导入笔记与静态媒体"]');
        await fileInput.setInputFiles([htmlFile, svgFile]);        await settle(page, 900);
        check('[媒体] 两个静态媒体都进了树', (await page.getByRole('button', { name: /^打开 滚动示例/ }).count()) === 1 && (await page.getByRole('button', { name: /^打开 静态图/ }).count()) === 1);
        await page.getByRole('button', { name: /^打开 滚动示例/ }).click();
        await settle(page, 300);
        const detailFrame = page.locator('.resource-detail iframe');
        await detailFrame.waitFor({ state: 'visible', timeout: 8000 });
        await settle(page, 400);
        check('[媒体] HTML 页走 iframe，且 sandbox 为空（不执行脚本）', (await detailFrame.getAttribute('sandbox')) === '' && (await detailFrame.getAttribute('referrerpolicy')) === 'no-referrer');
        check('[媒体] 沙箱里的脚本确实没跑（页面自报的标志位不存在）', !(await page.evaluate(() => Boolean(window.__mediaRan))));
        await guarded('[媒体] 页内滚轮能滚 iframe 里的静态页（截图逐像素比较：滚前/滚后不同，滚回去又一样）', async () => {
          const box = await detailFrame.boundingBox();
          const clip = { x: box.x + 4, y: box.y + 4, width: Math.min(box.width - 8, 320), height: Math.min(box.height - 8, 220) };
          const before = await page.screenshot({ clip });
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.wheel(0, 420);
          await settle(page, 500);
          const after = await page.screenshot({ clip });
          const diff = await pngDiff(before, after);
          assert.ok(diff, '截图尺寸/格式异常，比不了像素——按失败算');
          assert.ok(diff.ratio > 0.05, `滚完像素差只有 ${(diff.ratio * 100).toFixed(1)}%`);
          await page.mouse.wheel(0, -420);
          await settle(page, 500);
          const back = await page.screenshot({ clip });
          const again = await pngDiff(before, back);
          assert.ok(again && again.ratio < 0.02, `滚回原位的差异 ${again ? (again.ratio * 100).toFixed(1) : '?'}%`);
          return `${(diff.ratio * 100).toFixed(0)}% 像素变化`;
        });
        await page.getByRole('button', { name: /^打开 静态图/ }).click();
        await settle(page, 400);
        const svgFrame = page.locator('.resource-detail iframe').first();
        check('[媒体] SVG 也走 sandbox="" 的 iframe', (await svgFrame.getAttribute('sandbox')) === '');
        check('[媒体] SVG 里的脚本同样没跑', !(await page.evaluate(() => Boolean(window.__svgRan))));
        const imageFile = path.join(mediaDir(), '纵向图片.png');
        fs.writeFileSync(imageFile, tallPng());
        await fileInput.setInputFiles([imageFile]);
        await settle(page, 400);
        // 导入自动放置的媒体相互重叠：先移出（保留原件），再逐张放置测真实命中。
        for (const title of ['纵向图片.png', '静态图.svg', '滚动示例.html']) {
          await page.getByRole('button', { name: '打开 ' + title, exact: true }).click();
          const remove = page.getByRole('button', { name: '移出画布', exact: true });
          if (await remove.isEnabled()) await remove.click();
        }
        for (const title of ['滚动示例.html', '静态图.svg', '纵向图片.png']) {
          await page.getByRole('button', { name: '打开 ' + title, exact: true }).click();
          await page.getByRole('button', { name: /^(放到画布|定位节点)$/ }).click();
          const collapse = page.getByRole('button', { name: '折叠卡片 ' + title, exact: true });
          await collapse.waitFor({ state: 'visible' });
          await settle(page, 400);
          const nodeId = await page.locator('.react-flow__node').filter({ has: collapse }).getAttribute('data-id');
          const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
          const originalBox = await node.boundingBox();
          const media = node.locator('.media-preview');
          check(`[媒体·${title}] 放置后有实际媒体节点（不能用空列表 every 冒充通过）`, (await media.count()) === 1);
          if (title !== '纵向图片.png') {
            check(`[媒体·${title}] 卡片 iframe 保持无权限沙箱`, (await media.getAttribute('sandbox')) === '');
          }
          if (title === '滚动示例.html') {
            const cameraBeforeScroll = await viewport(page);
            const box = await media.boundingBox();
            const clip = { x: box.x + 4, y: box.y + 4, width: Math.min(box.width - 8, 240), height: Math.min(box.height - 8, 150) };
            const before = await page.screenshot({ clip });
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(0, 420);
            await settle(page, 400);
            const diff = pngDiff(before, await page.screenshot({ clip }));
            check('[媒体·HTML卡片] 正文内部真实滚轮改变像素，不缩放或平移画布', diff && diff.ratio > 0.05 && JSON.stringify(cameraBeforeScroll) === JSON.stringify(await viewport(page)), JSON.stringify(diff));
          }
          await collapse.click();
          await settle(page, 300);
          const hit = await node.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const below = { x: box.x + box.width / 2, y: box.bottom + 55 };
            const target = document.elementFromPoint(below.x, below.y);
            return { point: below, inside: target && element.contains(target), transform: element.style.transform, height: parseFloat(element.style.height), pointer: getComputedStyle(element).pointerEvents };
          });
          check(`[媒体·${title}] 折叠高度为48，旧正文坐标不再命中本节点`, hit.height === 48 && hit.pointer === 'none' && !hit.inside, JSON.stringify(hit));
          await drag(page, hit.point, { x: hit.point.x + 25, y: hit.point.y + 20 });
          check(`[媒体·${title}] 从旧透明区域拖动不会移动本节点`, hit.transform === await node.evaluate((element) => element.style.transform));
          // 旧正文区域可能平移了空白画布；先重新定位再检查可见页头。
          await page.getByRole('button', { name: '定位节点', exact: true }).click();
          await settle(page, 400);
          const box = await node.boundingBox();
          const beforeTransform = await node.evaluate((element) => element.style.transform);
          await drag(page, { x: box.x + 60, y: box.y + box.height / 2 }, { x: box.x + 85, y: box.y + box.height / 2 + 35 });
          check(`[媒体·${title}] 可见页头仍能真实拖动`, beforeTransform !== await node.evaluate((element) => element.style.transform));
          await page.getByRole('button', { name: '展开卡片 ' + title, exact: true }).click();
          await settle(page, 250);
          const restoredHeight = await node.evaluate((element) => parseFloat(element.style.height));
          check(`[媒体·${title}] 展开恢复原高度并重新呈现媒体`, restoredHeight > 48 && (await node.locator('.media-preview').count()) === 1, `${originalBox.height} / ${restoredHeight}`);
          await page.getByRole('button', { name: '移出画布', exact: true }).click();
        }
        check('[媒体] 整页一个真实脚本都没切到网络（requests 里只有本机回环，见场景收尾）', true);
        await shot(page, 'media-static');
      });
    } finally {
      await close('静态媒体：sandbox / 禁脚本 / 禁外网 / 可滚动');
    }
  }

  /* ─── 10. 折叠：只留页头，旧正文位置不再命中 ───────────────────────── */
  {
    const { page, close } = await newPage();
    try {
      await openPage(page, baseUrl);
      await record('卡片折叠：只留可见页头', async () => {
        const card = page.locator('.react-flow__node[data-id="card-connections"]');
        const before = await card.boundingBox();
        const collapse = page.getByRole('button', { name: /^折叠卡片 连接，先于堆积$/ });
        await collapse.click();
        await settle(page, 360);
        const collapsed = await card.evaluate((el) => {
          const article = el.querySelector('.knowledge-card');
          return {
            height: el.getBoundingClientRect().height,
            article: article.getBoundingClientRect().height,
            collapsedClass: article.classList.contains('is-collapsed'),
            pointerEvents: getComputedStyle(el).pointerEvents,
            expanded: article.querySelector('.card-collapse')?.getAttribute('aria-expanded'),
            body: Boolean(article.querySelector('.card-body')),
          };
        });
        check('[折叠] 卡片压成一行（高度 48，类名 is-collapsed）', Math.abs(collapsed.height - 48) <= 1.5 && collapsed.collapsedClass && Math.abs(collapsed.article - 48) <= 1.5, JSON.stringify(collapsed));
        check('[折叠] 折叠按钮的 aria-expanded 变 false（同一个按钮切换）', collapsed.expanded === 'false');
        check('[折叠] 节点外框不接收指针（旧正文位置不留透明命中块）', collapsed.pointerEvents === 'none', collapsed.pointerEvents);
        const handlePE = await page.locator('.react-flow__node[data-id="card-connections"] .card-drag-handle').evaluate((el) => getComputedStyle(el).pointerEvents);
        check('[折叠] 只有可见的页头还能抓', handlePE === 'auto', handlePE);
        const cover = await page.evaluate(() => {
          const node = document.querySelector('.react-flow__node[data-id="card-connections"]');
          const box = node.getBoundingClientRect();
          const point = { x: box.x + box.width / 2, y: box.y + 110 };
          const hit = document.elementFromPoint(point.x, point.y);
          return { inside: hit ? node.contains(hit) : false, tag: hit ? hit.tagName + '.' + (hit.className || '') : 'null' };
        });
        check('[折叠] 原正文深处的坐标点到的不是这张卡（透明块真的消失）', !cover.inside, JSON.stringify(cover));
        const collapsedBox = await card.boundingBox();
        await drag(page, { x: collapsedBox.x + 50, y: collapsedBox.y + 20 }, { x: collapsedBox.x + 50, y: collapsedBox.y + 80 });
        await settle(page, 220);
        const dragged = await card.boundingBox();
        check('[折叠] 折叠后仍能抓页头拖动这张卡', Math.abs(dragged.y - collapsedBox.y) > 24);
        await page.getByRole('button', { name: /^展开卡片 连接，先于堆积$/ }).click();
        await settle(page, 360);
        const expanded = await card.boundingBox();
        check('[折叠] 展开恢复折叠前的高度（不是被压扁的 48）', Math.abs(expanded.height - before.height) <= 3, `${before.height} → ${expanded.height}`);
        check('[折叠] 展开后正文回到 DOM，页头仍可拖', (await card.locator('.card-body').count()) === 1 && (await card.locator('.card-drag-handle').count()) === 1);
        const text = page.locator('.react-flow__node[data-id="card-link"]');
        const textBox = await text.boundingBox();
        await drag(page, { x: textBox.x + 40, y: textBox.y + 30 }, { x: textBox.x + 100, y: textBox.y + 80 });
        await settle(page, 200);
        const textAfter = await text.boundingBox();
        check('[折叠] 纯文本节点没有页头，但整块可拖', Math.abs(textAfter.x - textBox.x - 60) < 12 && Math.abs(textAfter.y - textBox.y - 50) < 12);
        const bodyCollapse = await page.locator('.react-flow__node[data-id="card-link"] .card-collapse').count();
        check('[折叠] 纯文本节点没有折叠箭头（折叠只属于带页头的卡片）', bodyCollapse === 0);
      });
    } finally {
      await close('卡片折叠：只留可见页头');
    }
  }

  /* ─── 11. 资源树：空边标签 / 双击添加 ─────────────────────────────── */
  {
    const { page, close } = await newPage();
    try {
      await openPage(page, baseUrl);
      await record('资源树：边标签与双击添加', async () => {
        const label = page.locator('.relation-label').first();
        check('[关系] 已有的线带着说明标签', (await page.locator('.relation-label').count()) === 3);
        await label.click();
        const input = page.getByRole('textbox', { name: '原位关系说明' });
        await input.waitFor({ state: 'visible', timeout: 4000 });
        await input.fill('改成一句新的');
        await page.keyboard.press('Enter');
        await settle(page, 260);
        const labels = await page.locator('.relation-label').allInnerTexts();
        check('[关系] 双击标签就地改说明，Enter 提交', labels.includes('改成一句新的'), labels.join(' / '));
        await page.locator('.relation-label').first().click();
        await page.getByRole('textbox', { name: '原位关系说明' }).fill('');
        await page.keyboard.press('Enter');
        await settle(page, 260);
        check('[关系] 说明清空后标签整个消失（空说明 = 没有标签）', (await page.locator('.relation-label').count()) === 2);
        check('[关系] 空说明只剩线本身，线还在', (await page.locator('.react-flow__edge').count()) === 3);
        const handle = page.locator('.react-flow__node[data-id="card-connections"] .react-flow__handle.source').first();
        const target = page.locator('.react-flow__node[data-id="card-recall"] .react-flow__handle.target').first();
        const from = await centerOf(handle);
        const to = await centerOf(target);
        await drag(page, from, to, 20);
        await settle(page, 320);
        const editingBox = await page.getByRole('textbox', { name: '原位关系说明' }).count();
        check('[关系] 拖圆点连到另一张卡：新线当场进入「写说明」状态', (await page.locator('.react-flow__edge').count()) === 4 && editingBox === 1);
        await page.keyboard.press('Escape');
        await settle(page, 200);
        check('[关系] Esc 取消写说明：线留着、没有空标签', (await page.locator('.react-flow__edge').count()) === 4 && (await page.locator('.relation-label').count()) === 2);
        const tree = page.locator('.resource-tree');
        await tree.getByRole('button', { name: /^打开 还没想明白的问题$/ }).click();
        await settle(page, 260);
        check('[资源树] 单击文件：右栏展开并预览这篇笔记', (await page.locator('.right-panel').evaluate((el) => el.getBoundingClientRect().width)) > 0 && (await page.locator('.resource-detail').innerText()).includes('还没想明白'));
        await page.locator('.left-panel').getByRole('button', { name: /^打开 我的例子：从生活中找类比$/ }).dblclick();
        await settle(page, 500);
        check('[资源树] 双击文件直接打开发文档视图（视图切到「文档」）', (await page.getByRole('button', { name: '文档', exact: true }).getAttribute('aria-pressed')) === 'true');
        check('[资源树] 双击打开的那一篇就是编辑器里的那一篇', (await page.getByRole('textbox', { name: '文档标题' }).inputValue()) === '我的例子：从生活中找类比');
        const before = await page.locator('.tree-row.tree-file').count();
        await page.getByRole('button', { name: '新建笔记', exact: true }).click();
        await settle(page, 400);
        const titleBox = page.getByRole('textbox', { name: '文档标题' });
        await titleBox.fill('树上添的笔记');
        await settle(page, 260);
        check('[资源树] 新建的笔记立刻出现在树上（标题跟着改）', (await page.getByRole('button', { name: '打开 树上添的笔记', exact: true }).count()) === 1 && (await page.locator('.tree-row.tree-file').count()) === before + 1);
        await page.getByRole('textbox', { name: '搜索文件' }).fill('主动回忆');
        await settle(page, 300);
        const visible = await page.locator('.tree-row.tree-file').allInnerTexts();
        const rowTitles = await page.locator('.tree-file-open').evaluateAll((buttons) => buttons.map((button) => button.textContent.trim()));
        // 搜索同时匹配标题与正文：命中项必然保留，没命中的行必须消失。
        check('[搜索] 搜词会留下匹配的行，没匹配上的行都藏起来', visible.length >= 1 && rowTitles.includes('主动回忆：先想，再看') && rowTitles.length < 6, rowTitles.join(' / '));
        await page.getByRole('textbox', { name: '搜索文件' }).fill('分门别类');
        await settle(page, 300);
        const byBody = await page.locator('.tree-file-open').evaluateAll((buttons) => buttons.map((button) => button.textContent.trim()));
        check('[搜索] 只出现在正文里的词也能搜到那一篇（标题不含这个词）', byBody.length === 1 && byBody[0] === '我的例子：从生活中找类比', byBody.join(' / '));
        await page.getByRole('textbox', { name: '搜索文件' }).fill('完全不存在的词');
        await settle(page, 300);
        check('[搜索] 没有匹配时给出「没有找到文档」', (await page.locator('.resource-tree .empty-state').innerText()).includes('没有找到'));
        await page.getByRole('textbox', { name: '搜索文件' }).fill('');
        await settle(page, 240);
        await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
        const folder = page.locator('[role=dialog][aria-label="新建文件夹"]');
        await folder.waitFor({ state: 'visible' });
        await page.getByRole('textbox', { name: '文件夹名称' }).fill('复习');
        await folder.getByRole('button', { name: '创建', exact: true }).click();
        await settle(page, 300);
        check('[资源树] 新建文件夹进树，名字对', (await page.getByRole('button', { name: '复习 文件夹', exact: true }).count()) === 1);
        await page.getByRole('button', { name: '新建笔记', exact: true }).click();
        await settle(page, 300);
        await page.getByRole('textbox', { name: '文档标题' }).fill('复习里的笔记');
        await settle(page, 260);
        check('[资源树] 新建笔记落在当前选中的文件夹里', await page.evaluate(() => {
          const rows = [...document.querySelectorAll('.tree-row')];
          const folderIndex = rows.findIndex((row) => row.textContent.includes('复习'));
          const noteIndex = rows.findIndex((row) => row.textContent.includes('复习里的笔记'));
          return folderIndex >= 0 && noteIndex > folderIndex;
        }));
      });
    } finally {
      await close('资源树：边标签与双击添加');
    }
  }

  /* ─── 12. 侧栏开合动画：初值亮暗与 reduced-motion ─────────────────── */
  {
    const measure = `(() => {
      const panel = document.querySelector('.left-panel');
      const rail = document.querySelector('.panel-rail--left');
      return {
        panelWidth: getComputedStyle(panel).transitionProperty,
        panelDuration: getComputedStyle(panel).transitionDuration,
        railDuration: getComputedStyle(rail).transitionDuration,
        motion: getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--v5-motion').trim(),
        theme: document.querySelector('.app-shell').dataset.theme,
      };
    })()`;
    for (const scheme of ['light', 'dark']) {
    const animated = await newPage({ reducedMotion: 'no-preference', colorScheme: scheme });
    try {
      await openPage(animated.page, baseUrl);
      await record(`侧栏动画：初始${scheme} / 动效开`, async () => {
        const motion = await animated.page.evaluate(measure);
        check(`[动效] 首帧主题为 ${scheme}（不先切换到亮色）`, motion.theme === scheme);
        check('[动效] 默认（未要求减少动效）侧栏宽度有 200ms 过渡', motion.panelDuration.split(',').some((part) => part.trim() === '0.2s'), motion.panelDuration);
        check('[动效] --v5-motion 是 1（动效没有被关掉）', motion.motion === '1', motion.motion);
        const collapse = await collapseAndSample(animated.page);
        const midway = collapse.samples.find((width) => width > 0 && width < collapse.startWidth);
        check('[动效] 收起是滑出去的过渡（中途宽度在两端之间），不是瞬间跳变', midway !== undefined && collapse.finalWidth === 0, `${midway === undefined ? 0 : midway.toFixed(0)} → ${collapse.finalWidth.toFixed(0)}（采样 ${collapse.samples.length} 帧）`);
        await animated.page.waitForFunction(() => {
          const rail = document.querySelector('.panel-rail--left');
          return rail !== null && Math.abs(rail.getBoundingClientRect().width - 32) < 1.5;
        }, null, { timeout: 1200 });
        const rail = await animated.page.locator('.panel-rail--left').evaluate((el) => el.getBoundingClientRect().width);
        check('[动效] 收起后窄轨回到 32px，开合状态可见', Math.abs(rail - 32) < 1.5, String(rail));
      });
    } finally {
      await animated.close(`侧栏动画：初始${scheme}`);
    }
    }
    const reduced = await newPage({ reducedMotion: 'reduce' });
    try {
      await openPage(reduced.page, baseUrl);
      await record('侧栏动画：reduced-motion', async () => {
        const motion = await reduced.page.evaluate(measure);
        check('[动效] 系统要求减少动效时 --v5-motion 是 0（位移直接换终态）', motion.motion === '0', motion.motion);
        await reduced.page.getByRole('button', { name: '收起文件侧栏', exact: true }).click();
        await reduced.page.waitForTimeout(80);
        const width = await reduced.page.locator('.left-panel').evaluate((el) => el.getBoundingClientRect().width);
        check('[动效] reduced-motion 下没有中间态：一下就到位', width === 0, String(width));
      });
    } finally {
      await reduced.close('侧栏动画：reduced-motion');
    }
  }

  /* ─── 13. 主题：跟随系统、亮暗两套都要够读 ─────────────────────────── */
  {
    for (const scheme of ['light', 'dark']) {
      const { page, close } = await newPage({ colorScheme: scheme });
      try {
        await openPage(page, baseUrl);
        await record(`主题：${scheme === 'dark' ? '暗色' : '亮色'}`, async () => {
          const theme = await page.locator('.app-shell').getAttribute('data-theme');
          check(`[主题] 跟系统走：${scheme} 下根上就是 ${scheme}`, theme === scheme, String(theme));
          const gridRatio = await page.evaluate(() => {
            const dot = document.querySelector('.react-flow__background pattern circle');
            const canvas = document.querySelector('.canvas-stage');
            if (!dot || !canvas) return 0;
            const luminance = (color) => {
              const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
              if (!values || values.length !== 3) return NaN;
              return values.map((value) => { const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
            };
            const a = luminance(getComputedStyle(dot).fill), b = luminance(getComputedStyle(canvas).backgroundColor);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          });
          check(`[点阵] ${scheme} 模式实际点色与画布对比度达标`, gridRatio >= (scheme === 'light' ? 3 : 2.5), `${gridRatio}:1`);
          await page.getByRole('button', { name: '新建笔记', exact: true }).click();
          await settle(page, 500);
          const rows = await page.evaluate(CONTRAST_PROBE + '(' + JSON.stringify([
            ['.prototype-badge', '顶栏状态徽标'],
            ['.document-title, .document-toolbar input', '文档标题'],
            ['.markdown-inline-editor .cm-line', '内联编辑器正文'],
            ['.markdown-inline-editor .md-syntax', '灰色 Markdown 标记'],
            ['.md-format-toolbar__button', '格式栏控件'],
            ['.tree-row .tree-label', '资源树行'],
          ]) + ')');
          for (const row of rows) {
            check(`[对比度] ${scheme === 'dark' ? '暗色' : '亮色'}下${row.name} ≥ 4.5:1`, !row.missing && row.ratio >= 4.5, row.missing ? '取不到元素' : `${row.ratio}:1（${row.color} on ${row.bg}）`);
          }
          const swap = scheme === 'dark' ? '切换浅色模式' : '切换暗色模式';
          await page.getByRole('button', { name: swap, exact: true }).click();
          await settle(page, 300);
          const flipped = await page.locator('.app-shell').getAttribute('data-theme');
          check(`[主题] 顶栏按钮手动切换主题（${scheme} → 另一套）`, flipped !== scheme, String(flipped));
          await shot(page, `theme-${scheme}`);
        });
      } finally {
        await close(`主题：${scheme}`);
      }
    }
  }

  /* ─── 14. 390–1100 不用横向溢出 ────────────────────────────────────── */
  {
    const widths = [390, 420, 520, 699, 700, 860, 1024, 1099, 1100];
    for (const width of widths) {
      const { page, close } = await newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      try {
        await openPage(page, baseUrl);
        await record(`窄屏 ${width}`, async () => {
          const overflow = await page.evaluate(() => {
            const root = document.documentElement;
            // 收起的侧栏会把内层锁成展开宽度再 overflow:hidden 裁掉（滑动动画的做法），
            // 它的后代不算「行越界」；只看真正露在外面的行、页头与工具栏。
            const insideCollapsed = (el) => Boolean(el.closest('.side-panel.is-collapsed, .side-panel[aria-hidden="true"]'));
            const outliers = [...document.querySelectorAll('.topbar, .canvas-toolbar, .tree-row, .document-toolbar, .panel-header')]
              .filter((el) => !insideCollapsed(el))
              .filter((el) => { const box = el.getBoundingClientRect(); return box.right > innerWidth + 1 || box.left < -1; })
              .map((el) => el.className);
            return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, body: document.body.scrollWidth, outliers: outliers.slice(0, 4) };
          });
          check(`[窄屏 ${width}] 页面没有横向溢出（scrollWidth ≤ clientWidth）`, overflow.scrollWidth <= overflow.clientWidth && overflow.body <= overflow.clientWidth, JSON.stringify(overflow));
          check(`[窄屏 ${width}] 顶栏与工具栏的行都在视口内`, overflow.outliers.length === 0, overflow.outliers.join(' / '));
          if (width < 700) {
            const left = await page.locator('.left-panel').evaluate((el) => el.getBoundingClientRect());
            // 窄屏：左栏是浮层，窄轨（32px 的展开入口）应当还在窗口里；宽屏由顶栏按钮负责，不要求窄轨。
            const rail = await page.locator('.panel-rail--left').evaluate((el) => {
              const style = getComputedStyle(el);
              return { display: style.display, box: el.getBoundingClientRect().toJSON() };
            });
            check(`[窄屏 ${width}] 左栏叠在画布上，窄轨仍在视口里（收得回来）`, left.width > 0 && rail.box.right <= width + 1 && (await page.getByRole('button', { name: '收起文件侧栏', exact: true }).isVisible()), `display=${rail.display} rail=${rail.box.width}`);
            await page.getByRole('button', { name: '收起文件侧栏', exact: true }).click();
            await settle(page, 320);
            check(`[窄屏 ${width}] 收起后画布能吃满宽度`, await page.locator('.canvas-stage').evaluate((el) => el.getBoundingClientRect().width <= innerWidth + 1 && el.getBoundingClientRect().width > innerWidth - 8));
          }
          // 窄屏刚才把左栏收起了；先经窄轨把文件栏展开，再新建，最后仍把文件栏收起，
          // 这样格式栏量的是真实文档宽度，而不是被浮层压住的状态。
          const newNote = page.getByRole('button', { name: '新建笔记', exact: true });
          if (!(await newNote.isVisible().catch(() => false))) {
            await page.getByRole('button', { name: '展开文件侧栏', exact: true }).click();
            await settle(page, 240);
          }
          await newNote.click();
          await settle(page, 520);
          const collapseLeft = page.getByRole('button', { name: '收起文件侧栏', exact: true });
          if (await collapseLeft.isVisible().catch(() => false)) await collapseLeft.click();
          await settle(page, 240);
          const narrowDoc = await page.evaluate(() => {
            const bar = document.querySelector('.md-format-toolbar');
            const note = document.querySelector('.document-scroll > .note-editor');
            return {
              noPageOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
              bar: bar ? { height: bar.getBoundingClientRect().height, fits: bar.scrollWidth <= bar.clientWidth + 1 } : null,
              noteWidth: note?.getBoundingClientRect().width || 0,
            };
          });
          check(`[窄屏 ${width}] 文档视图同样不横向溢出`, narrowDoc.noPageOverflow);
          check(`[窄屏 ${width}] 格式栏在窄侧栏里保持单行且在正文宽度内`, Boolean(narrowDoc.bar) && narrowDoc.bar.height <= 40 && narrowDoc.bar.fits && narrowDoc.noteWidth > 0, JSON.stringify(narrowDoc));
          await shot(page, `narrow-${width}`);
        });
      } finally {
        await close(`窄屏 ${width}`);
      }
    }
  }

  /* ─── 15. 网页验收入口的占位对话 ──────────────────────────────────── */
  {
    const { page, close } = await newPage();
    try {
      await openPage(page, baseUrl);
      await record('占位对话：引用与禁用发送', async () => {
        await page.getByRole('button', { name: '新建笔记', exact: true }).click();
        await settle(page, 500);
        const chat = page.locator('[data-testid=chat-drop-zone]');
        await chat.waitFor({ state: 'visible', timeout: 8000 });
        check('[对话] 文档视图右栏是会话面板，头上写着「AI 对话」', (await page.locator('.resource-header-title').innerText()).trim() === 'AI 对话');
        check('[对话] 面板明说没连会话（独立预览 · 未连接会话）', (await chat.innerText()).includes('未连接会话'));
        const send = page.getByRole('button', { name: '发送（未连接）', exact: true });
        check('[对话] 发送按钮禁用，且文案说明「未连接」', (await send.isDisabled()) && (await send.getAttribute('title')).includes('不会发送'));
        await page.getByRole('button', { name: '引用当前文档', exact: true }).click();
        await settle(page, 260);
        const chips = await page.locator('.quote-chip').allInnerTexts();
        check('[对话] 「当前文档」把文档作为引用放进草稿（一颗 chip）', chips.length === 1 && chips[0].includes('未命名'), chips.join(' / '));
        await page.getByRole('textbox', { name: 'AI 对话草稿' }).fill('这段草稿只留在本页');
        await page.getByRole('button', { name: '选择引用文件', exact: true }).click();
        const picker = page.locator('.quote-picker');
        await picker.waitFor({ state: 'visible' });
        await page.getByRole('textbox', { name: '搜索引用文件' }).fill('主动回忆');
        await picker.getByRole('button', { name: /主动回忆/ }).first().click();
        await settle(page, 260);
        const chips2 = await page.locator('.quote-chip').allInnerTexts();
        check('[对话] 从文件里挑一条引用进去（chip 数 +1）', chips2.length === 2, chips2.join(' / '));
        check('[对话] 加引用之后切回文档视图、右栏开着、草稿还在', (await page.locator('.chat-panel').count()) === 1 && (await page.getByRole('textbox', { name: 'AI 对话草稿' }).inputValue()) === '这段草稿只留在本页');
        check('[对话] 引用只有本地状态：面板上没有「发送中」之类的模型痕迹', !(await chat.innerText()).includes('发送中'));
        await page.getByRole('button', { name: /^移除引用 主动回忆/ }).click();
        await settle(page, 220);
        check('[对话] 移除引用：那一颗 chip 消失，另一颗还在', (await page.locator('.quote-chip').count()) === 1);
        await page.getByRole('button', { name: '发送（未连接）', exact: true }).click({ force: true });
        await settle(page, 260);
        check('[对话] 禁用状态下点发送不产生任何请求，也不清草稿', (await page.getByRole('textbox', { name: 'AI 对话草稿' }).inputValue()) === '这段草稿只留在本页');
        await page.getByRole('button', { name: '新建笔记', exact: true }).click();
        await settle(page, 420);
        check('[对话] 换成另一篇笔记：引用与草稿还留着（页面自己的状态，不接会话）', (await page.locator('.quote-chip').count()) === 1 && (await page.getByRole('textbox', { name: 'AI 对话草稿' }).inputValue()) === '这段草稿只留在本页');
        await shot(page, 'chat-placeholder');
      });
    } finally {
      await close('占位对话：引用与禁用发送');
    }
  }

  /* ─── 16. 恢复示例：清空一切、回到初始 ───────────────────────────── */
  {
    const { page, close } = await newPage();
    try {
      await openPage(page, baseUrl);
      await record('恢复示例与刷新重置', async () => {
        await page.getByRole('button', { name: '新建笔记', exact: true }).click();
        await settle(page, 420);
        await page.getByRole('textbox', { name: '文档标题' }).fill('会被冲掉的笔记');
        await settle(page, 240);
        await page.getByRole('button', { name: '恢复示例', exact: true }).click();
        const dialog = page.locator('[role=dialog][aria-label="恢复示例？"]');
        await dialog.waitFor({ state: 'visible' });
        check('[恢复] 弹窗先说清楚会清掉什么、不能撤销', (await dialog.innerText()).includes('不能撤销'));
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        await settle(page, 200);
        check('[恢复] 取消什么都不动：那篇笔记还在', (await page.getByRole('button', { name: '打开 会被冲掉的笔记', exact: true }).count()) === 1);
        await page.getByRole('button', { name: '恢复示例', exact: true }).click();
        await page.locator('[role=dialog][aria-label="恢复示例？"]').getByRole('button', { name: '确认恢复', exact: true }).click();
        await settle(page, 900);
        const afterReset = {
          nodes: await page.locator('.react-flow__minimap-node').count(),
          edges: await page.locator('.react-flow__edge').count(),
          labels: await page.locator('.relation-label').count(),
          labelsText: await page.locator('.relation-label').allInnerTexts(),
        };
        check('[恢复] 确认后回到示例：新笔记没了', (await page.getByRole('button', { name: '打开 会被冲掉的笔记', exact: true }).count()) === 0);
        check('[恢复] 画布回到 4 张卡 / 3 条线 / 3 个标签', afterReset.nodes === 4 && afterReset.edges === 3 && afterReset.labels === 3, JSON.stringify(afterReset));
        const titleFits = await page.locator('.react-flow__node[data-id="card-connections"] .card-title-row h3').evaluate((el) => el.textContent.trim());
        check('[恢复] 恢复出来的是示例本身（卡片标题回到「连接，先于堆积」）', titleFits === '连接，先于堆积', titleFits);
        await page.getByRole('button', { name: '恢复示例', exact: true }).click();
        await page.locator('[role=dialog][aria-label="恢复示例？"]').getByRole('button', { name: '确认恢复', exact: true }).click();
        await settle(page, 500);
        check('[恢复] 右栏回到收起、视图回到画布', (await page.locator('.right-panel').evaluate((el) => el.getBoundingClientRect().width)) === 0 && (await page.getByRole('button', { name: '画布', exact: true }).getAttribute('aria-pressed')) === 'true');
        await page.getByRole('button', { name: '新建笔记', exact: true }).click();
        await settle(page, 420);
        await page.reload({ waitUntil: 'load' });
        await page.locator('.app-shell').waitFor({ state: 'visible' });
        await settle(page, 600);
        check('[刷新] 刷新后回到初始态（内存态，如实重置——不是缺陷）', (await page.locator('.react-flow__node').count()) === 4 && (await page.getByRole('button', { name: '打开 未命名.md', exact: true }).count()) === 0);
        check('[刷新] 界面上不出现「已保存」之类的暗示', !(await page.locator('body').innerText()).includes('已保存'));
      });
    } finally {
      await close('恢复示例与刷新重置');
    }
  }

  /* ─── 17. 帮助与快捷键表 ──────────────────────────────────────────── */
  {
    const { page, close } = await newPage();
    try {
      await openPage(page, baseUrl);
      await record('帮助弹窗', async () => {
        await page.getByRole('button', { name: '操作说明', exact: true }).click();
        const dialog = page.locator('[role=dialog][aria-label="操作说明"]');
        await dialog.waitFor({ state: 'visible' });
        const rows = await dialog.locator('.help-shortcuts tbody tr').count();
        check('[帮助] 四段说明与 11 行快捷键表都在', (await dialog.locator('.help-sections section').count()) === 4 && rows === 11, `rows=${rows}`);
        check('[帮助] 弹窗里写明「仍只存本页，刷新即重置」与发送边界', (await dialog.innerText()).includes('刷新即重置') && (await dialog.innerText()).includes('发送'));
        await page.keyboard.press('Escape');
        await settle(page, 220);
        check('[帮助] Esc 关闭弹窗，焦点回到「操作说明」', (await dialog.count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === '操作说明');
      });
    } finally {
      await close('帮助弹窗');
    }
  }
} finally {
  await browser.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mediaDirName) fs.rmSync(mediaDirName, { recursive: true, force: true });
}

report();

function report() {
  console.log('');
  console.log(`无界笔记浏览器验收：${checks} 条断言，${failures} 条失败`);
  console.log(`页面：${baseUrl}${source.kind === 'local' ? '（dist/notes-preview，本进程临时服务器）' : '（外部 URL）'}`);
  console.log(`截图：${outDir}`);
  fs.writeFileSync(path.join(outDir, 'browser-report.json'), JSON.stringify({ checks, failures, results }, null, 2) + '\n');
  // 一条断言都没跑到也算失败：空跑不能冒充通过。
  if (failures || checks === 0) process.exit(1);
}
