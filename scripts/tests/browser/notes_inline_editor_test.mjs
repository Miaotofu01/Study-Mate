/* 无界笔记 · 源码优先行内即时编辑器的专属真浏览器验收（MarkdownInlineEditor）。
   跑法：node scripts/tests/browser/notes_inline_editor_test.mjs
   只覆盖本模块契约：原始 Markdown 字节、局部揭示真实分隔符、原始坐标 API、
   混合换行 undo/redo、安全块 widget、亮暗 AA、只读与上限。页面打到临时目录，
   不改仓库构建入口；共享测试清单与 test:notes:browser 已登记本套件。

   需要真实的 Microsoft Edge；没有就 SKIP（退出码 3），不静默换 Chromium。 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));
const EXIT_SKIP = 3;

const INITIAL = [
  '开头',
  '',
  'plain **bold** plain **other**',
  '',
  '# Head',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '> quote',
  '',
  '| **Name** | *Score* |',
  '| :--- | ---: |',
  '| A | `92` |',
  '',
  '- [x] done',
  '- [ ] todo',
  '',
  'Inline $x^2$ and block:',
  '',
  '$$a+b$$',
  '',
  '$$',
  '\\int_0^1 x\\,dx',
  '$$',
  '',
  '![示意图](https://example.com/a.png)',
].join('\r\n');
const MIXED = 'a\r\nb\nc\rd';

let checks = 0;
let failures = 0;
function check(label, ok, detail = '') {
  checks += 1;
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}

function skip(reason) {
  console.error(`SKIP  ${reason}`);
  process.exit(EXIT_SKIP);
}

function loadPlaywright() {
  const entry = requireFromRoot.resolve('playwright');
  return import(pathToFileURL(entry).href);
}

async function serve(dir) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
  };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const file = path.join(dir, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': types[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

const FIXTURE = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import MarkdownInlineEditor from './client/notes/MarkdownInlineEditor.jsx';

const INITIAL = ${JSON.stringify(INITIAL)};
window.__changes = [];
window.__value = INITIAL;
window.__MIXED = ${JSON.stringify(MIXED)};

function App() {
  const [value, setValue] = React.useState(INITIAL);
  const [theme, setTheme] = React.useState('light');
  const [readOnly, setReadOnly] = React.useState(false);
  React.useEffect(() => {
    window.__setTheme = setTheme;
    window.__setReadOnly = setReadOnly;
    window.__setValue = (next) => { window.__value = next; setValue(next); };
  }, []);
  return (
    <div style={{ height: '620px', padding: '20px' }}>
      <MarkdownInlineEditor
        value={value}
        theme={theme}
        readOnly={readOnly}
        label="Markdown 正文"
        onChange={(next) => {
          window.__changes.push(next);
          window.__value = next;
          setValue(next);
        }}
        onSelectionChange={(snapshot) => { window.__selection = snapshot; }}
        onApi={(api) => { window.__api = api; }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
);
`;

async function buildFixture(dir) {
  await build({
    absWorkingDir: ROOT,
    stdin: {
      contents: FIXTURE,
      resolveDir: ROOT,
      sourcefile: 'notes-inline-editor-fixture.jsx',
      loader: 'jsx',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110'],
    jsx: 'automatic',
    minify: true,
    outfile: path.join(dir, 'bundle.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: {
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.svg': 'dataurl',
      '.png': 'dataurl',
    },
    logLevel: 'silent',
  });
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,"><link rel="stylesheet" href="bundle.css"></head>
<body><div id="root"></div><script src="bundle.js"></script></body></html>`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-inline-editor-'));
  const playwright = await loadPlaywright();
  const { chromium } = playwright.default || playwright;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    skip(`没有可用的 Microsoft Edge：${String(error && error.message ? error.message : error)}`);
  }
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  const requests = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('data:') && !url.startsWith('blob:')) requests.push(url);
  });

  try {
    await buildFixture(tmp);
    const { server, origin } = await serve(tmp);
    try {
      await page.goto(origin, { waitUntil: 'load' });
      await page.waitForSelector('.cm-content', { timeout: 30000 });
      await page.waitForSelector('.md-image-placeholder');
      await page.waitForTimeout(200);

      const initialText = await page.evaluate(() => window.__api.read().text);
      check('挂载后 text 与传入原始字节完全一致（含 CRLF）', initialText === INITIAL);
      check('StrictMode 只挂载一个编辑器', (await page.locator('.cm-editor').count()) === 1);
      const a11y = await page.evaluate(() => ({
        testid: document.querySelector('.markdown-inline-editor')?.dataset.testid,
        role: document.querySelector('.cm-content')?.getAttribute('role'),
        label: document.querySelector('.cm-content')?.getAttribute('aria-label'),
      }));
      check('根 testid 与可访问 textbox 标签存在',
        a11y.testid === 'markdown-inline-editor' && a11y.role === 'textbox' && a11y.label === 'Markdown 正文',
        JSON.stringify(a11y));

      await page.evaluate(() => window.__setValue(window.__MIXED));
      await page.waitForTimeout(80);
      check('外部混合换行值按原字节接受',
        (await page.evaluate(() => window.__api.read().text)) === MIXED);
      await page.evaluate((value) => window.__setValue(value), INITIAL);
      await page.waitForTimeout(80);

      // 回归：工具栏编辑后，外部同 id 用更短正文覆盖。旧实现先改 canonical 再派发，
      // changeFilter 会拿新短串去推算旧长文档的改动而拒绝，留下「值新、文档旧」。
      const toolbarEdit = await page.evaluate(() => {
        const text = window.__api.read().text;
        const from = text.indexOf('plain');
        window.__changes.length = 0;
        const ok = window.__api.edit({
          changes: [{ from, to: from + 'plain'.length, insert: '**plain**' }],
          selection: { anchor: from + 2 },
        });
        return { ok, changes: window.__changes.length };
      });
      check('工具栏式编辑先落一版', toolbarEdit.ok && toolbarEdit.changes === 1);

      const shortBody = '标题行\n\n正文行';
      const shortExternal = await page.evaluate((value) => {
        window.__changes.length = 0;
        window.__setValue(value);
        return new Promise((resolve) => setTimeout(() => {
          const raw = window.__api.read();
          resolve({
            raw,
            doc: [...document.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n'),
            changes: window.__changes.length,
          });
        }, 100));
      }, shortBody);
      check('外部更短正文后 canonical 与 CM 文档成对更新',
        shortExternal.raw.text === shortBody && shortExternal.doc === shortBody,
        `raw=${JSON.stringify(shortExternal.raw.text)} doc=${JSON.stringify(shortExternal.doc)}`);
      check('外部更短正文不触发 onChange', shortExternal.changes === 0);
      check('外部更短正文后选区仍在界内',
        shortExternal.raw.from >= 0 && shortExternal.raw.to <= shortBody.length && shortExternal.raw.from <= shortExternal.raw.to,
        `from=${shortExternal.raw.from} to=${shortExternal.raw.to}`);
      const shortUndo = await page.evaluate(() => {
        const ok = window.__api.undo();
        return { ok, text: window.__api.read().text };
      });
      check('外部覆盖后撤销基线重置为这份正文', shortUndo.ok === false && shortUndo.text === shortBody);

      const longerBody = '标题行\n\n正文行\n\n更长的外部更新';
      const longerExternal = await page.evaluate((value) => {
        window.__changes.length = 0;
        window.__setValue(value);
        return new Promise((resolve) => setTimeout(() => {
          resolve({
            text: window.__api.read().text,
            doc: [...document.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n'),
            changes: window.__changes.length,
          });
        }, 100));
      }, longerBody);
      check('外部更长正文同样成对更新且不回调',
        longerExternal.text === longerBody && longerExternal.doc === longerBody && longerExternal.changes === 0,
        JSON.stringify(longerExternal));

      const equalExternal = await page.evaluate((value) => {
        window.__changes.length = 0;
        window.__setValue(value);
        return new Promise((resolve) => setTimeout(() => {
          resolve({ text: window.__api.read().text, changes: window.__changes.length });
        }, 100));
      }, longerBody);
      check('外部同值同步不回调也不改写',
        equalExternal.text === longerBody && equalExternal.changes === 0);

      await page.evaluate((value) => window.__setValue(value), INITIAL);
      await page.waitForTimeout(100);

      const rendered = await page.evaluate(() => ({
        table: Boolean(document.querySelector('.md-table-widget table')),
        tableText: document.querySelector('.md-table-widget')?.innerText || '',
        katex: document.querySelectorAll('.katex').length,
        image: Boolean(document.querySelector('.md-image-placeholder')),
        imageSrcCount: document.querySelectorAll('.cm-content img:not(.cm-widgetBuffer)').length,
        fenceVisible: Boolean(document.querySelector('.md-code-fence')),
        fenceOffLines: document.querySelectorAll('.md-code-fence-off').length,
        codeLang: document.querySelector('.md-code-lang')?.textContent || '',
        contentText: document.querySelector('.cm-content')?.innerText || '',
        tokKeyword: document.querySelectorAll('.tok-keyword').length,
        strong: document.querySelectorAll('.md-strong').length,
        emphasis: document.querySelectorAll('.md-emphasis').length,
        tableStrong: document.querySelectorAll('.md-table-widget th strong').length,
        tableEm: document.querySelectorAll('.md-table-widget th em').length,
        tableCode: document.querySelectorAll('.md-table-widget td code').length,
        taskCount: document.querySelectorAll('.md-task-widget').length,
        taskChecked: document.querySelectorAll('.md-task-widget input:checked').length,
        mathBlocks: document.querySelectorAll('.md-math-block').length,
      }));
      check('非活动 GFM 表格渲染为安全 DOM 表格',
        rendered.table && rendered.tableText.includes('Name') && rendered.tableText.includes('A'),
        JSON.stringify(rendered.tableText.slice(0, 40)));
      check('非活动公式仍渲染 KaTeX', rendered.katex >= 2, `katex=${rendered.katex}`);
      check('非活动图片只留本地占位，不建 img/src', rendered.image && rendered.imageSrcCount === 0);
      check('非活动代码围栏：开围栏行显示语言角标、闭围栏仍隐藏，代码正文与高亮类保留',
        !rendered.fenceVisible && rendered.fenceOffLines === 1 && rendered.codeLang === 'js'
        && !rendered.contentText.includes('```') && rendered.tokKeyword > 0,
        `fenceOff=${rendered.fenceOffLines} lang=${rendered.codeLang} tok=${rendered.tokKeyword}`);
      check('强调/加粗使用语义类', rendered.strong >= 2 && rendered.emphasis === 0);
      check('表格单元格安全渲染 bold/italic/code，不露原始标记',
        rendered.tableStrong > 0 && rendered.tableEm > 0 && rendered.tableCode > 0
          && !rendered.tableText.includes('**') && !rendered.tableText.includes('`'),
        `strong=${rendered.tableStrong} em=${rendered.tableEm} code=${rendered.tableCode}`);
      check('GFM 任务休息态显示只读勾选框',
        rendered.taskCount === 2 && rendered.taskChecked === 1,
        `tasks=${rendered.taskCount} checked=${rendered.taskChecked}`);
      check('多行 $$ 公式渲染为 display 块', rendered.mathBlocks >= 2,
        `blocks=${rendered.mathBlocks} katex=${rendered.katex}`);

      const tokenContrast = await page.evaluate(() => {
        const root = document.querySelector('.markdown-inline-editor');
        const token = document.querySelector('.tok-keyword');
        const rgb = (value) => (value.match(/\d+(?:\.\d+)?/g) || []).slice(0, 3).map(Number);
        const lum = (value) => {
          const [r, g, b] = rgb(value).map((channel) => {
            const s = channel / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (fg, bg) => {
          const a = lum(fg);
          const b = lum(bg);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        return {
          light: ratio(getComputedStyle(token).color, getComputedStyle(root).backgroundColor),
          token: getComputedStyle(token).color,
        };
      });
      check('浅色代码高亮对底色达到 AA', tokenContrast.light >= 4.5,
        `ratio=${tokenContrast.light.toFixed(2)} fg=${tokenContrast.token}`);

      await page.evaluate(() => window.__setTheme('dark'));
      await page.waitForTimeout(80);
      const darkContrast = await page.evaluate(() => {
        const root = document.querySelector('.markdown-inline-editor');
        // 宿主暗色会提供这些变量；临时页自己补真实暗色 surface/text。
        root.style.setProperty('--surface', '#1e2423');
        root.style.setProperty('--text', '#d7e0db');
        root.style.setProperty('--muted', '#a0ada6');
        const token = document.querySelector('.tok-keyword');
        const rgb = (value) => (value.match(/\d+(?:\.\d+)?/g) || []).slice(0, 3).map(Number);
        const lum = (value) => {
          const [r, g, b] = rgb(value).map((channel) => {
            const s = channel / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const a = lum(getComputedStyle(token).color);
        const b = lum(getComputedStyle(root).backgroundColor);
        return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), fg: getComputedStyle(token).color };
      });
      check('深色代码高亮对宿主暗底达到 AA', darkContrast.ratio >= 4.5,
        `ratio=${darkContrast.ratio.toFixed(2)} fg=${darkContrast.fg}`);
      await page.evaluate(() => {
        const root = document.querySelector('.markdown-inline-editor');
        ['--surface', '--text', '--muted'].forEach((name) => root.style.removeProperty(name));
        window.__setTheme('light');
        window.__changes.length = 0;
        window.__api.focus();
      });
      await page.waitForTimeout(80);
      check('焦点/主题切换不触发 onChange', (await page.evaluate(() => window.__changes.length)) === 0);

      // 任务：休息态是勾选框；点进去后勾选框消失，真实 [x] 以灰字显形。
      await page.locator('.md-task-widget').first().click();
      await page.waitForTimeout(80);
      const taskActive = await page.evaluate(() => ({
        widgets: document.querySelectorAll('.md-task-widget').length,
        visible: [...document.querySelectorAll('.md-syntax:not(.md-syntax-hidden)')].map((node) => node.textContent).join(''),
        raw: window.__api.read(),
      }));
      check('任务点入后显形真实可编辑的 [x]',
        taskActive.widgets === 1 && taskActive.visible.includes('[x]') && taskActive.raw.text === INITIAL,
        `widgets=${taskActive.widgets} visible=${JSON.stringify(taskActive.visible)}`);

      // 表格：点第二格应回到该格源码，而不是永远回到第一列表头。
      const cellRawIndex = INITIAL.indexOf('`92`');
      await page.locator('.md-table-widget tbody td').nth(1).click();
      await page.waitForTimeout(80);
      const tableCell = await page.evaluate(() => window.__api.read());
      check('表格点击映射到被点单元格的源码',
        tableCell.from === cellRawIndex,
        `from=${tableCell.from} expected=${cellRawIndex}`);

      // 多行公式：点到内容开头，而不是开头的 $$ 标记里面。
      const mathRawIndex = INITIAL.indexOf('\\int_0^1');
      await page.locator('.md-math-block').last().click();
      await page.waitForTimeout(80);
      const mathActive = await page.evaluate(() => ({
        read: window.__api.read(),
        blocks: document.querySelectorAll('.md-math-block').length,
        rawVisible: document.querySelector('.cm-content')?.innerText.includes('\\int_0^1'),
      }));
      check('多行公式点入内容开头并只显形该区域',
        mathActive.read.from === mathRawIndex && mathActive.read.text === INITIAL && mathActive.rawVisible && mathActive.blocks >= 1,
        `from=${mathActive.read.from} expected=${mathRawIndex} blocks=${mathActive.blocks}`);

      const singleMathRawIndex = INITIAL.indexOf('$$a+b$$') + 2;
      await page.locator('.md-math-block').first().click();
      await page.waitForTimeout(80);
      check('单行整行公式也点入内容开头，不在开标记内',
        (await page.evaluate(() => window.__api.read().from)) === singleMathRawIndex,
        `from=${await page.evaluate(() => window.__api.read().from)} expected=${singleMathRawIndex}`);

      // 只揭示被光标碰到的那个加粗 span：第一个 ** 显形，第二个仍藏。
      await page.locator('.md-strong').first().click();
      await page.waitForTimeout(80);
      const reveal = await page.evaluate(() => ({
        visible: [...document.querySelectorAll('.md-syntax:not(.md-syntax-hidden)')].map((node) => node.textContent).join(''),
        hiddenCount: document.querySelectorAll('.md-syntax-hidden').length,
        raw: window.__api.read(),
        changes: window.__changes.length,
      }));
      const boldIndex = INITIAL.indexOf('bold');
      check('光标只揭示所在加粗 span 的分隔符', reveal.visible.includes('**') && reveal.hiddenCount >= 2,
        `visible=${JSON.stringify(reveal.visible)} hidden=${reveal.hiddenCount}`);
      check('read().from/to 是 canonical 原始坐标（CRLF 偏移）',
        reveal.raw.from === reveal.raw.to && reveal.raw.from >= boldIndex - 1 && reveal.raw.from <= boldIndex + 4,
        `from=${reveal.raw.from} boldIndex=${boldIndex}`);
      check('揭示分隔符本身不触发 onChange', reveal.changes === 0);
      check('揭示/主题切换不改写原始字节', reveal.raw.text === INITIAL);
      const markerContrast = await page.evaluate(() => {
        const root = document.querySelector('.markdown-inline-editor');
        const marker = document.querySelector('.md-syntax:not(.md-syntax-hidden)');
        const rgb = (value) => {
          const numbers = (value.match(/[\d.]+/g) || []).map(Number);
          // color-mix 的 computed value 可能是 color(srgb 0.68 0.73 0.70)。
          return value.startsWith('color(') ? numbers.slice(0, 3).map((channel) => channel * 255) : numbers.slice(0, 3);
        };
        const lum = (value) => {
          const [r, g, b] = rgb(value).map((channel) => {
            const s = channel / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const a = lum(getComputedStyle(marker).color);
        const b = lum(getComputedStyle(root).backgroundColor);
        return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), fg: getComputedStyle(marker).color };
      });
      check('灰色真实分隔符在浅色下达到 AA', markerContrast.ratio >= 4.5,
        `ratio=${markerContrast.ratio.toFixed(2)} fg=${markerContrast.fg}`);
      await page.evaluate(() => {
        const root = document.querySelector('.markdown-inline-editor');
        root.style.setProperty('--surface', '#1e2423');
        root.style.setProperty('--text', '#d7e0db');
        root.style.setProperty('--muted', '#a0ada6');
        window.__setTheme('dark');
      });
      await page.waitForTimeout(80);
      const darkMarker = await page.evaluate(() => {
        const root = document.querySelector('.markdown-inline-editor');
        const marker = document.querySelector('.md-syntax:not(.md-syntax-hidden)');
        const rgb = (value) => {
          const numbers = (value.match(/[\d.]+/g) || []).map(Number);
          return value.startsWith('color(') ? numbers.slice(0, 3).map((channel) => channel * 255) : numbers.slice(0, 3);
        };
        const lum = (value) => {
          const [r, g, b] = rgb(value).map((channel) => {
            const s = channel / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const a = lum(getComputedStyle(marker).color);
        const b = lum(getComputedStyle(root).backgroundColor);
        return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      });
      check('灰色真实分隔符在暗色宿主下达到 AA', darkMarker.ratio >= 4.5, `ratio=${darkMarker.ratio.toFixed(2)}`);
      await page.evaluate(() => {
        const root = document.querySelector('.markdown-inline-editor');
        ['--surface', '--text', '--muted'].forEach((name) => root.style.removeProperty(name));
        window.__setTheme('light');
      });
      await page.waitForTimeout(80);

      const wrap = await page.evaluate(() => {
        const { text } = window.__api.read();
        const from = text.indexOf('plain');
        const to = from + 'plain'.length;
        window.__changes.length = 0;
        const ok = window.__api.edit({
          changes: [{ from, to, insert: `**${text.slice(from, to)}**` }],
          selection: { anchor: from + 2, head: to + 2 },
        });
        return { ok, text: window.__api.read(), changes: window.__changes.length };
      });
      check('api.edit 按原始坐标跨 CRLF 生效且只回调一次',
        wrap.ok === true && wrap.text.text === INITIAL.replace('plain **bold**', '**plain** **bold**') && wrap.changes === 1,
        JSON.stringify(wrap.text));
      check('api.edit 的 selection 回读为原始坐标', wrap.text.from === 8 && wrap.text.to === 13,
        `from=${wrap.text.from} to=${wrap.text.to}`);

      const rawUndo = await page.evaluate(() => {
        window.__setValue('a\r\nb\nc\rd');
        return new Promise((resolve) => setTimeout(() => {
          window.__api.edit({ changes: [{ from: 0, to: 8, insert: 'X' }], selection: { anchor: 1 } });
          const edited = window.__api.read().text;
          const undid = window.__api.undo();
          const undone = window.__api.read().text;
          const redid = window.__api.redo();
          const redone = window.__api.read().text;
          resolve({ edited, undid, undone, redid, redone });
        }, 60));
      });
      check('api.edit 跨混合换行按原始字节替换', rawUndo.edited === 'X', JSON.stringify(rawUndo.edited));
      check('api.undo 精确恢复混合换行', rawUndo.undid && rawUndo.undone === MIXED, JSON.stringify(rawUndo.undone));
      check('api.redo 精确恢复编辑后原文', rawUndo.redid && rawUndo.redone === 'X', JSON.stringify(rawUndo.redone));

      await page.evaluate(() => { window.__setValue(''); window.__changes.length = 0; });
      await page.waitForTimeout(80);
      check('空正文保持空串且不回调', (await page.evaluate(() => window.__api.read().text)) === '');
      const oversize = await page.evaluate(() => {
        window.__changes.length = 0;
        const before = window.__api.read().text;
        const ok = window.__api.edit({
          changes: [{ from: 0, to: 0, insert: 'x'.repeat(128 * 1024 + 1) }],
        });
        return { ok, before, after: window.__api.read().text, changes: window.__changes.length };
      });
      check('超过 128 Ki 的编辑被拒绝且原稿不动',
        oversize.ok === false && oversize.after === oversize.before && oversize.changes === 0);

      await page.evaluate(() => window.__setValue('中文'));
      await page.waitForTimeout(80);
      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+Home');
      const cdp = await page.context().newCDPSession(page);
      await page.evaluate(() => { window.__changes.length = 0; });
      await cdp.send('Input.imeSetComposition', { text: '外部', selectionStart: 2, selectionEnd: 2 });
      // 组合期间父组件推进来一个旧值；已敲的中文不能被它覆盖。
      await page.evaluate(() => window.__setValue('旧回显'));
      await cdp.send('Input.insertText', { text: '外部覆盖' });
      await page.waitForTimeout(350);
      const imeState = await page.evaluate(() => ({
        read: window.__api.read().text,
        parentValue: window.__value,
        lastChange: window.__changes.at(-1),
        changes: window.__changes.slice(),
      }));
      check('真实 CDP IME：提交后的用户文本进入 canonical',
        imeState.read === '外部覆盖中文',
        JSON.stringify(imeState));
      check('真实 CDP IME：最终父资源不是旧回声',
        imeState.parentValue === '外部覆盖中文' && imeState.lastChange === '外部覆盖中文',
        JSON.stringify(imeState));

      // 原生键盘：标题前缀隐藏时，光标在原始 0 号位置敲 X 必须得到 `X# 外部`。
      await page.evaluate(() => { window.__setValue('# 外部'); window.__changes.length = 0; });
      await page.waitForTimeout(80);
      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+Home');
      const headingAtStart = await page.evaluate(() => ({
        from: window.__api.read().from,
        visible: [...document.querySelectorAll('.md-syntax:not(.md-syntax-hidden)')].map((node) => node.textContent).join(''),
      }));
      check('行首标题前缀在可编辑左边界显形', headingAtStart.from === 0 && headingAtStart.visible.includes('# '),
        JSON.stringify(headingAtStart));
      await page.keyboard.type('X');
      await page.waitForTimeout(120);
      const headingTyped = await page.evaluate(() => ({
        text: window.__api.read().text,
        changes: window.__changes.length,
      }));
      check('原生键盘在行首输入落在原始 0 号位置', headingTyped.text === 'X# 外部',
        JSON.stringify(headingTyped));

      // 原生键盘：加粗 span 左边界（紧挨开 `**` 之前）敲 X，X 必须落在标记之前。
      await page.evaluate(() => { window.__setValue('a **bold** b'); window.__changes.length = 0; });
      await page.waitForTimeout(80);
      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+Home');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      const strongBoundary = await page.evaluate(() => ({
        from: window.__api.read().from,
        visible: [...document.querySelectorAll('.md-syntax:not(.md-syntax-hidden)')].map((node) => node.textContent).join(''),
      }));
      check('加粗 span 左边界显形真实 ** 且光标在原始 2 号位置',
        strongBoundary.from === 2 && strongBoundary.visible.includes('**'),
        JSON.stringify(strongBoundary));
      await page.keyboard.type('X');
      await page.waitForTimeout(120);
      const strongTyped = await page.evaluate(() => window.__api.read().text);
      check('原生键盘在加粗左边界输入落在标记之前', strongTyped === 'a X**bold** b',
        JSON.stringify(strongTyped));

      // Home 后右移进入隐藏标记本身：光标落在真实 * 上时也必须显形。
      await page.evaluate(() => { window.__setValue('a **bold** b'); window.__changes.length = 0; });
      await page.waitForTimeout(80);
      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+Home');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      const insideMarker = await page.evaluate(() => ({
        from: window.__api.read().from,
        visible: [...document.querySelectorAll('.md-syntax:not(.md-syntax-hidden)')].map((node) => node.textContent).join(''),
      }));
      check('方向键进入隐藏分隔符内部也显形', insideMarker.from === 3 && insideMarker.visible.includes('**'),
        JSON.stringify(insideMarker));

      await page.evaluate(() => {
        window.__setValue('a\r\nb\nc\rd');
        window.__changes.length = 0;
      });
      await page.waitForTimeout(80);
      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type('Z');
      await page.keyboard.press('Control+Z');
      await page.waitForTimeout(100);
      check('原生 Ctrl+Z 恢复混合换行', (await page.evaluate(() => window.__api.read().text)) === MIXED,
        JSON.stringify(await page.evaluate(() => window.__api.read().text)));

      // 真实键盘删除文档里的分隔符字符：Home 后右移 6 格到第一个 *，连按两次 Delete。
      await page.evaluate((value) => { window.__setValue(value); window.__changes.length = 0; }, INITIAL);
      await page.waitForTimeout(80);
      await page.locator('.md-strong').first().click();
      await page.keyboard.press('Home');
      for (let index = 0; index < 6; index += 1) await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Delete');
      await page.keyboard.press('Delete');
      await page.waitForTimeout(120);
      const deleted = await page.evaluate(() => window.__api.read().text);
      check('键盘真的删掉分隔符字符而不是假装饰',
        deleted.includes('plain bold** plain **other**') && !deleted.includes('plain **bold**'),
        JSON.stringify(deleted.split('\r\n')[2]));

      // 真实鼠标点最后一行加粗文字的正中：表格/代码围栏/公式块 widget 之后，
      // CM 的 block 高度必须把 widget 的纵向间距算进去，否则精确点选落空。
      const centerDoc = [
        '# 主动回忆',
        '',
        '| 再读 | 主动回忆 |',
        '| --- | --- |',
        '| 感觉熟悉 | 暴露缺口 |',
        '',
        '```js',
        'const answer = recall(concept);',
        '```',
        '',
        '$$',
        'P(记住) \\neq P(觉得熟悉)',
        '$$',
        '',
        '**我的行动：** 学完一节后复述。',
      ].join('\n');
      await page.evaluate((value) => {
        window.__setValue(value);
        window.__changes.length = 0;
      }, centerDoc);
      await page.waitForTimeout(120);
      const centerStrong = page.locator('.markdown-inline-editor .md-strong').last();
      await centerStrong.scrollIntoViewIfNeeded();
      const centerBox = await centerStrong.boundingBox();
      const centerVisible = await page.evaluate(() => {
        const scroller = document.querySelector('.markdown-inline-editor .cm-scroller');
        const strong = [...document.querySelectorAll('.markdown-inline-editor .md-strong')].at(-1);
        const s = scroller.getBoundingClientRect();
        const r = strong.getBoundingClientRect();
        return { scrollTop: scroller.scrollTop, strongTop: r.top, strongBottom: r.bottom, scrollerTop: s.top, scrollerBottom: s.bottom };
      });
      check('最后一行加粗在视口内且不依赖滚动才点选',
        centerVisible.scrollTop === 0 && centerVisible.strongTop >= centerVisible.scrollerTop &&
          centerVisible.strongBottom <= centerVisible.scrollerBottom,
        JSON.stringify(centerVisible));
      check('最后一行加粗文字有可点击几何框', Boolean(centerBox && centerBox.width > 0 && centerBox.height > 0),
        JSON.stringify(centerBox));
      if (centerBox) {
        await page.mouse.click(centerBox.x + centerBox.width / 2, centerBox.y + centerBox.height / 2);
        await page.waitForTimeout(180);
        const centerHit = await page.evaluate(() => ({
          text: window.__api.read().text,
          from: window.__api.read().from,
          to: window.__api.read().to,
          visible: [...document.querySelectorAll('.md-syntax:not(.md-syntax-hidden)')].map((node) => node.textContent).join(''),
          changes: window.__changes.length,
        }));
        check('原生鼠标点中最后一行加粗文字中心后光标进入正文',
          centerHit.from > 0 && centerHit.from < centerHit.text.length,
          JSON.stringify(centerHit));
        check('原生鼠标点中加粗文字后只揭示该 span 的真实 ****（开/闭各两个）',
          centerHit.visible === '****', JSON.stringify(centerHit.visible));
        check('原生点选加粗不触发正文 onChange', centerHit.changes === 0,
          String(centerHit.changes));
      }

      // 嵌套强调：同一行外层加粗里再套斜体，点内层中心仍必须落进真实字符。
      const nestedDoc = [
        '| A | B |',
        '| --- | --- |',
        '| x | y |',
        '',
        '```js',
        'const a = 1;',
        '```',
        '',
        '**外层 *内层* 外层**',
      ].join('\n');
      await page.evaluate((value) => {
        window.__setValue(value);
        window.__changes.length = 0;
      }, nestedDoc);
      await page.waitForTimeout(120);
      const nestedEmphasis = page.locator('.markdown-inline-editor .md-emphasis').last();
      await nestedEmphasis.scrollIntoViewIfNeeded();
      const nestedBox = await nestedEmphasis.boundingBox();
      check('嵌套强调有可点击几何框', Boolean(nestedBox && nestedBox.width > 0));
      if (nestedBox) {
        await page.mouse.click(nestedBox.x + nestedBox.width / 2, nestedBox.y + nestedBox.height / 2);
        await page.waitForTimeout(180);
        const nestedHit = await page.evaluate(() => ({
          text: window.__api.read().text,
          from: window.__api.read().from,
          visible: [...document.querySelectorAll('.md-syntax:not(.md-syntax-hidden)')].map((node) => node.textContent).join(''),
          changes: window.__changes.length,
        }));
        check('原生点中嵌套强调中心后光标进入正文且正文未变',
          nestedHit.from > 0 && nestedHit.text === nestedDoc, JSON.stringify(nestedHit));
        check('嵌套强调点入后揭示真实星号', /^\*+$/.test(nestedHit.visible) && nestedHit.visible.length > 0,
          JSON.stringify(nestedHit.visible));
        check('嵌套强调点选不改写正文、不回调', nestedHit.changes === 0, String(nestedHit.changes));
      }

      check('没有远端图片/公式请求', requests.length === 0, requests.join(', '));
      check('无 console/page 错误', errors.length === 0, errors.join(' / '));
    } finally {
      server.close();
    }
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
