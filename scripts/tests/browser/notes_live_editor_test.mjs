/* 无界笔记 · NoteEditor + MarkdownInlineEditor + 格式工具条的真浏览器验收。
   跑法：node scripts/tests/browser/notes_live_editor_test.mjs

   只验证集成后的外部行为，不碰产品构建入口，也不改 registry：
   - 文件标题行下只有一条常驻 Markdown 格式条，没有旧即时编辑器/模式行/提示；
   - 真实分隔符只在当前加粗/斜体 span 显形，正文保持排版，删掉的是真字符；
   - 工具条按钮/标题选择/溢出菜单在选中与折叠光标下都工作；
   - 原始坐标跨 CRLF/混合换行，undo/redo，链接弹窗冻结选区与文档变化的拒绝；
   - 空文档、外部 props/回声、快速换 resource ID、CDP IME；
   - 只读预览链接、128 Ki 上限与超限修复；
   - 公式/GFM 表格/图片/代码/原始 HTML 不产生远端请求；
   - 335px 窄栏单行工具条与亮暗 AA。

   需要真实 Microsoft Edge；没有就 SKIP（退出码 3），不静默回退 Chromium。
   页面由本文件用 esbuild 打到临时目录，临时目录在 finally 里清理。 */

import assert from 'node:assert/strict';
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
// The product's own limit, not a copy: an accidental change must fail here.
const { MAX_MARKDOWN_LENGTH } = await import(
  pathToFileURL(path.join(ROOT, 'client', 'notes', 'markdown-inline.js')).href
);

const INITIAL = [
  '# 工作台',
  '',
  'plain **bold** 与 **other**，*italic* 和 ~~gone~~。',
  '',
  '第二段 **再次加粗**。',
  '',
  '列表项',
  '',
  '链接文字',
].join('\r\n');

const RICH = [
  '# 富文本',
  '',
  '公式 $x^2$。',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '![示意图](https://example.com/pic.png)',
  '',
  '<b>safe raw html</b>',
  '<script>window.__pwned = 1;</script>',
  '<img src="https://example.com/raw.png">',
].join('\r\n');

const MIXED = '# 混合\r\nbody\nline\rtail';

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

// 相对亮度（#312 A5 面加深断言用）：支持 rgb()/color()（srgb 0-1 通道）两种 computed 形态。
function lumOf(value) {
  const numbers = (value.match(/[\d.]+/g) || []).map(Number);
  const channels = value.startsWith('color(')
    ? numbers.slice(0, 3).map((channel) => channel * 255)
    : numbers.slice(0, 3);
  const [r, g, b] = channels.map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
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
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import NoteEditor from './client/notes/NoteEditor.jsx';
// 真实应用的预览样式来自 preview.jsx import 的 styles.css；夹具不走那个入口，
// 必须显式引入，只读预览的标题/引用/语言角标规则才与真实 bundle 一致。
import './client/notes/styles.css';
import { canonicalOffsetMap, rawOffsetMap } from './client/notes/markdown-inline.js';

const INITIAL = ${JSON.stringify(INITIAL)};
const MAX = ${MAX_MARKDOWN_LENGTH};
const LIGHT = {
  '--smb-bg': '#f7f8fa', '--smb-text': '#29333d', '--smb-text-3': '#5c6874',
  '--smb-line-strong': '#d9dfe5', '--smb-raise': '#eef1f3', '--smb-text-link': '#205f91',
  '--surface': '#f7f8fa', '--text': '#29333d', '--muted': '#5c6874',
  '--border': '#d9dfe5', '--code': '#eef1f3', '--accent-soft': '#eaf0f5',
  background: '#f7f8fa', color: '#29333d',
};
const DARK = {
  '--smb-bg': '#1e2423', '--smb-text': '#d7e0db', '--smb-text-3': '#a0ada6',
  '--smb-line-strong': '#39433f', '--smb-raise': '#252d36', '--smb-text-link': '#9ecdf3',
  '--surface': '#1e2423', '--text': '#d7e0db', '--muted': '#a0ada6',
  '--border': '#39433f', '--code': '#252d36', '--accent-soft': '#303e4c',
  background: '#1e2423', color: '#d7e0db',
};

window.__MAX = MAX;
window.__changes = [];
window.__opened = [];
window.__ready = false;
window.open = (url) => { window.__opened.push(url); return null; };

function findView() {
  const dom = document.querySelector('.markdown-inline-editor .cm-editor');
  if (!dom) return null;
  return EditorView.findFromDOM(dom);
}

function rawSelection() {
  const view = findView();
  const text = window.__resource.markdown;
  if (!view) return { text, from: 0, to: 0, empty: true };
  const map = canonicalOffsetMap(text);
  const range = view.state.selection.main;
  return {
    text,
    from: map[Math.min(range.from, map.length - 1)],
    to: map[Math.min(range.to, map.length - 1)],
    empty: range.empty,
  };
}

function Harness() {
  const initialResource = { id: 'note-alpha', title: '三角笔记.md', markdown: INITIAL };
  const [resource, setResourceState] = useState(initialResource);
  const [readOnly, setReadOnly] = useState(false);
  const [theme, setTheme] = useState('light');
  const resourceRef = useRef(initialResource);
  resourceRef.current = resource;

  const applyResource = (next) => {
    const base = resourceRef.current;
    const value = typeof next === 'string' ? { ...base, markdown: next } : { ...base, ...next };
    resourceRef.current = value;
    window.__resource = value;
    setResourceState(value);
  };

  window.__resource = resource;
  window.__setResource = applyResource;
  window.__setMarkdown = (markdown) => applyResource({ markdown });
  window.__setReadOnly = setReadOnly;
  window.__setTheme = setTheme;
  window.__resetChanges = () => { window.__changes.length = 0; };
  window.__rawSelection = rawSelection;
  window.__docLength = () => {
    const view = findView();
    return view ? view.state.doc.length : -1;
  };
  window.__focusEditor = () => { const view = findView(); if (view) view.focus(); };
  window.__setRawSelection = (from, to = from) => {
    const view = findView();
    if (!view) return false;
    const text = resourceRef.current.markdown;
    const normalized = text.replace(/\\r\\n|\\r/g, '\\n');
    if (view.state.doc.length !== normalized.length) return false;
    const map = rawOffsetMap(text);
    const clamp = (value) => Math.max(0, Math.min(text.length, Math.trunc(Number(value) || 0)));
    const anchor = map[clamp(from)];
    const head = map[clamp(to)];
    view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
    view.focus();
    return true;
  };

  useEffect(() => { window.__ready = true; }, []);

  return (
    <div className="studymate-notes" data-theme={theme} style={{ ...(theme === 'dark' ? DARK : LIGHT), height: '100%' }}>
      <header className="fixture-file-title" data-testid="fixture-file-title">{resource.title}</header>
      <div className="fixture-editor" data-resource-length={resource.markdown.length}>
        <NoteEditor
          resource={resource}
          readOnly={readOnly}
          theme={theme}
          onChange={(markdown) => {
            window.__changes.push(markdown);
            window.__lastChange = markdown;
            const next = { ...resourceRef.current, markdown };
            resourceRef.current = next;
            window.__resource = next;
            setResourceState(next);
          }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode><Harness /></React.StrictMode>
);
`;

async function buildFixture(dir) {
  await build({
    absWorkingDir: ROOT,
    stdin: {
      contents: FIXTURE,
      resolveDir: ROOT,
      sourcefile: 'notes-live-editor-fixture.jsx',
      loader: 'jsx',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110'],
    jsx: 'automatic',
    jsxDev: true,
    minify: false,
    outfile: path.join(dir, 'bundle.js'),
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: {
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.svg': 'dataurl',
      '.png': 'dataurl',
    },
    logLevel: 'silent',
  });
  const cssPath = path.join(dir, 'bundle.css');
  const { scopeNotesCss } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'client-build-helpers.mjs')).href);
  if (fs.existsSync(cssPath)) {
    fs.writeFileSync(cssPath, scopeNotesCss(fs.readFileSync(cssPath, 'utf8')));
  }
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,"><link rel="stylesheet" href="bundle.css">
<style>html,body,#root{margin:0;width:100%;height:100%;}.studymate-notes{display:flex;flex-direction:column;box-sizing:border-box;padding:0 8px;}.fixture-file-title{flex:0 0 auto;padding:8px 2px;font:600 13px/1.4 system-ui,sans-serif;}.fixture-editor{display:flex;flex:1 1 auto;min-height:0;flex-direction:column;}</style>
</head>
<body><div id="root"></div><script src="bundle.js"></script></body></html>`);
}

async function markdown(page) {
  return page.evaluate(() => window.__resource.markdown);
}

async function waitForMarkdown(page, expected) {
  await page.waitForFunction((value) => window.__resource?.markdown === value, expected, { timeout: 15000 });
  // The parent's committed render, not only the fixture ref, must have landed;
  // otherwise the next external swap races the previous own-edit commit.
  await page.waitForFunction(
    (value) => document.querySelector('.fixture-editor')?.getAttribute('data-resource-length') === String(value.length),
    expected,
    { timeout: 15000 },
  );
  // The canonical prop and the CM document settle on separate ticks. Wait for
  // both before the next external swap so two updates cannot race each other.
  const docLength = expected.replace(/\r\n|\r/g, '\n').length;
  await page.waitForFunction(
    (length) => window.__docLength?.() === length,
    docLength,
    { timeout: 15000 },
  );
  await page.waitForTimeout(60);
}

async function setMarkdown(page, value) {
  await page.evaluate((markdown) => window.__setMarkdown(markdown), value);
  await waitForMarkdown(page, value);
}

async function setResource(page, resource) {
  await page.evaluate((next) => window.__setResource(next), resource);
  await page.waitForFunction((id) => window.__resource?.id === id, resource.id, { timeout: 15000 });
  await page.waitForTimeout(120);
}

async function setRawSelection(page, from, to = from) {
  // External props and the CM doc settle on different ticks; retry briefly so a
  // raw range is never silently applied to the previous document.
  let ok = false;
  for (let attempt = 0; attempt < 20 && !ok; attempt += 1) {
    ok = await page.evaluate(([start, end]) => window.__setRawSelection(start, end), [from, to]);
    if (!ok) await page.waitForTimeout(50);
  }
  if (!ok) {
    const state = await page.evaluate(() => ({
      resourceLength: window.__resource?.markdown.length,
      docLength: window.__docLength(),
      editors: document.querySelectorAll('.cm-editor').length,
      renderedLength: Number(document.querySelector('.fixture-editor')?.getAttribute('data-resource-length')),
    }));
    assert.fail(`raw selection ${from}..${to} was not applied: ${JSON.stringify(state)}`);
  }
  await page.waitForTimeout(60);
}

async function selectText(page, needle, occurrence = 0) {
  const range = await page.evaluate(({ text, index }) => {
    const source = window.__resource.markdown;
    let cursor = -1;
    for (let count = 0; count <= index; count += 1) {
      cursor = source.indexOf(text, cursor + 1);
      if (cursor < 0) return null;
    }
    return { from: cursor, to: cursor + text.length };
  }, { text: needle, index: occurrence });
  assert.ok(range, `could not find ${needle} #${occurrence}`);
  await setRawSelection(page, range.from, range.to);
  return range;
}

async function selectAll(page) {
  const length = await page.evaluate(() => window.__resource.markdown.length);
  await setRawSelection(page, 0, length);
}

async function clickControl(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(140);
}

async function chooseHeading(page, value) {
  await page.locator('select[aria-label="标题"]').selectOption(String(value));
  await page.waitForTimeout(140);
}

async function openOverflow(page) {
  await page.getByRole('button', { name: '更多格式', exact: true }).click();
  await page.getByRole('menu', { name: '更多格式' }).waitFor({ state: 'visible' });
}

async function clickMenuItem(page, name) {
  await page.getByRole('menuitem', { name, exact: true }).click();
  await page.waitForTimeout(160);
}

async function openLinkDialog(page) {
  await clickControl(page, '链接');
  await page.getByRole('dialog').waitFor({ state: 'visible' });
}

async function fillLink(page, href, text) {
  await page.getByLabel('链接地址').fill(href);
  if (text !== undefined) await page.getByLabel('链接文字（可选）').fill(text);
}

async function submitLink(page) {
  await page.getByRole('button', { name: '应用链接', exact: true }).click();
  await page.waitForTimeout(180);
}

async function changeCount(page) {
  return page.evaluate(() => window.__changes.length);
}

async function waitForPaint(page) {
  await page.waitForTimeout(120);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-live-editor-'));
  const playwright = await loadPlaywright();
  const { chromium } = playwright.default || playwright;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    skip(`没有可用的 Microsoft Edge（需要 channel: msedge）：${String(error && error.message ? error.message : error)}`);
  }

  const page = await browser.newPage({ viewport: { width: 335, height: 760 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  const requests = [];
  const popups = [];
  let server;
  try {
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('popup', (popup) => {
      popups.push(popup.url() || 'about:blank');
      popup.close().catch(() => {});
    });

    await buildFixture(tmp);
    const served = await serve(tmp);
    server = served.server;
    const { origin } = served;

    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) {
        await route.continue();
      } else {
        requests.push(url);
        await route.abort();
      }
    });

    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForSelector('.markdown-inline-editor .cm-editor', { timeout: 30000 });
    await page.waitForFunction(() => window.__ready === true && window.__resource, null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('.cm-editor').length === 1, null, { timeout: 15000 });
    await waitForPaint(page);

    // ── 1. 结构：文件标题行 + 一条常驻工具条 + 内容；旧 UI 不存在 ──────────────
    const structure = await page.evaluate(() => {
      const title = document.querySelector('[data-testid="fixture-file-title"]');
      const toolbar = document.querySelector('.md-format-toolbar');
      const controls = [...toolbar.querySelectorAll('button, select')];
      const rects = controls.map((control) => control.getBoundingClientRect());
      const rows = new Set(rects.map((rect) => Math.round(rect.top + rect.height / 2)));
      const labels = controls.map((control) => control.getAttribute('aria-label')).filter(Boolean);
      const options = [...toolbar.querySelectorAll('select option')].map((option) => option.textContent);
      const toolbarStyle = getComputedStyle(toolbar);
      const editorStyle = getComputedStyle(document.querySelector('.note-editor'));
      return {
        titleText: title?.textContent || '',
        titleRect: title?.getBoundingClientRect().toJSON(),
        toolbarRect: toolbar?.getBoundingClientRect().toJSON(),
        toolbarCount: document.querySelectorAll('[role="toolbar"][aria-label="Markdown 格式"]').length,
        toolbarName: toolbar?.getAttribute('aria-label') || '',
        editorCount: document.querySelectorAll('.cm-editor').length,
        oldModes: document.querySelectorAll('.note-editor__modes, .markdown-live-editor, .milkdown, .note-editor__preview').length,
        labels,
        options,
        rows: rows.size,
        flexWrap: toolbarStyle.flexWrap,
        toolbarBorderTop: toolbarStyle.borderTopWidth,
        toolbarBorderLeft: toolbarStyle.borderLeftWidth,
        toolbarShadow: toolbarStyle.boxShadow,
        toolbarRadius: toolbarStyle.borderRadius,
        editorBorderTop: editorStyle.borderTopWidth,
        editorShadow: editorStyle.boxShadow,
        innerFrame: (() => {
          const css = getComputedStyle(document.querySelector('.markdown-inline-editor'));
          return [css.backgroundColor, css.borderTopWidth, css.borderRadius, css.boxShadow];
        })(),
        bodyText: document.body.innerText,
        scrollWidth: document.documentElement.scrollWidth,
        toolbarWidth: toolbarRectOf(toolbar),
      };
      function toolbarRectOf(node) {
        const rect = node.getBoundingClientRect();
        return { width: rect.width, left: rect.left, right: rect.right, height: rect.height };
      }
    });

    check('文件标题行在工具条上方', structure.titleText === '三角笔记.md'
      && structure.toolbarRect.top >= structure.titleRect.bottom - 1,
      JSON.stringify({ title: structure.titleRect, toolbar: structure.toolbarRect }));
    check('只有一个语义 Markdown 格式工具条', structure.toolbarCount === 1 && structure.toolbarName === 'Markdown 格式');
    check('工具条只有一行、无横向溢出', structure.rows === 1
      && structure.flexWrap === 'nowrap'
      && structure.toolbarWidth.width <= 335
      && structure.scrollWidth <= 335,
      JSON.stringify({ rows: structure.rows, width: structure.toolbarWidth, scroll: structure.scrollWidth }));
    check('工具条是扁平条：无上/左框、无圆角大卡、无阴影',
      structure.toolbarBorderTop === '0px' && structure.toolbarBorderLeft === '0px'
      && structure.toolbarRadius === '0px' && structure.toolbarShadow === 'none'
      && structure.editorBorderTop === '0px' && structure.editorShadow === 'none',
      JSON.stringify(structure));
    check('正文内部也没有卡片背景、圆角边框或阴影',
      JSON.stringify(structure.innerFrame) === JSON.stringify(['rgba(0, 0, 0, 0)', '0px', '0px', 'none']),
      JSON.stringify(structure.innerFrame));
    check('没有旧模式行/即时编辑器/预览壳', structure.oldModes === 0);
    check('没有可见的 Markdown 正文/即时编辑/源码模式/模式提示',
      !/Markdown 正文|即时编辑|源码模式|源码|预览/.test(structure.bodyText),
      JSON.stringify(structure.bodyText.slice(0, 200)));
    check('StrictMode 只挂载一个编辑器', structure.editorCount === 1);
    check('标题选项是 正文/H1..H6', structure.options.join(',') === '正文,H1,H2,H3,H4,H5,H6');
    check('所有格式控件都有中文可访问名',
      ['粗体', '斜体', '删除线', '行内代码', '链接', '无序列表', '有序列表', '引用', '更多格式'].every((label) => structure.labels.includes(label)),
      JSON.stringify(structure.labels));
    check('首次挂载不写回父级', (await changeCount(page)) === 0);
    check('初始原始字节完整（含 CRLF）', (await markdown(page)) === INITIAL);

    // ── 2. 分隔符只对当前 span 显形；正文保持样式；删除是真字符 ───────────────
    const boldStart = INITIAL.indexOf('**bold**');
    const boldText = INITIAL.indexOf('bold');
    await setRawSelection(page, boldText, boldText + 4);
    const focusedFrame = await page.locator('.markdown-inline-editor').evaluate(el => {
      const css = getComputedStyle(el);
      return [css.borderTopWidth, css.borderRadius, css.boxShadow];
    });
    check('正文聚焦后也不恢复圆角卡片外框', JSON.stringify(focusedFrame) === JSON.stringify(['0px', '0px', 'none']), JSON.stringify(focusedFrame));
    const boldDecor = await page.evaluate(() => {
      const syntax = [...document.querySelectorAll('.md-syntax')];
      return {
        visible: syntax.filter((node) => !node.classList.contains('md-syntax-hidden')).map((node) => node.textContent).join(''),
        hidden: syntax.filter((node) => node.classList.contains('md-syntax-hidden')).map((node) => node.textContent).join(''),
        strong: [...document.querySelectorAll('.md-strong')].map((node) => ({ weight: getComputedStyle(node).fontWeight, text: node.textContent })),
        emphasis: [...document.querySelectorAll('.md-emphasis')].map((node) => getComputedStyle(node).fontStyle),
        strike: [...document.querySelectorAll('.md-strike')].map((node) => getComputedStyle(node).textDecorationLine),
        changes: window.__changes.length,
      };
    });
    check('光标只显形当前加粗 span 的四个星号', boldDecor.visible === '****', JSON.stringify(boldDecor));
    check('其他格式的分隔符仍然隐藏', boldDecor.hidden.includes('**') && boldDecor.hidden.includes('*') && boldDecor.hidden.includes('~~'),
      JSON.stringify(boldDecor.hidden));
    check('加粗正文保持 bold、斜体/删除线仍是排版样式',
      boldDecor.strong.length >= 2 && boldDecor.strong.every((item) => item.weight === '700')
      && boldDecor.emphasis.length >= 1 && boldDecor.emphasis.every((style) => style === 'italic')
      && boldDecor.strike.length >= 1 && boldDecor.strike.every((line) => line.includes('line-through')),
      JSON.stringify(boldDecor));
    check('揭示分隔符不写父级', boldDecor.changes === 0);

    await setRawSelection(page, boldStart, boldStart);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(160);
    const deleted = await markdown(page);
    check('键盘 Delete 真的删掉两个起始 * 字符',
      deleted.includes('plain bold** 与') && !deleted.includes('plain **bold**'),
      JSON.stringify(deleted.split('\r\n')[2]));

    await setMarkdown(page, INITIAL);
    const italicIndex = INITIAL.indexOf('italic');
    await setRawSelection(page, italicIndex, italicIndex + 6);
    const italicDecor = await page.evaluate(() => ({
      visible: [...document.querySelectorAll('.md-syntax:not(.md-syntax-hidden)')].map((node) => node.textContent).join(''),
      strong: [...document.querySelectorAll('.md-strong')].map((node) => getComputedStyle(node).fontWeight),
      emphasis: [...document.querySelectorAll('.md-emphasis')].map((node) => getComputedStyle(node).fontStyle),
    }));
    check('光标在斜体里只显形这一对 *', italicDecor.visible === '**', JSON.stringify(italicDecor));
    check('其他加粗 span 仍渲染为粗体且标记隐藏',
      italicDecor.strong.length >= 2 && italicDecor.emphasis.length >= 1
      && italicDecor.emphasis.every((style) => style === 'italic'),
      JSON.stringify(italicDecor));

    // ── 3. 工具条：选中/折叠格式化、标题、列表/引用/代码/表格 ─────────────────
    await setMarkdown(page, INITIAL);
    await selectText(page, '列表项');
    await clickControl(page, '粗体');
    await waitForMarkdown(page, INITIAL.replace('列表项', '**列表项**'));
    check('选中文本点击粗体精确包住选区', (await markdown(page)) === INITIAL.replace('列表项', '**列表项**'));

    await clickControl(page, '粗体');
    await waitForMarkdown(page, INITIAL);
    check('再次点击同一格式取消粗体', (await markdown(page)) === INITIAL);

    // ── #312 A4：光标在粗体内部再点粗体 —— 真浏览器路径复现，必须解包不嵌套 ──
    await setMarkdown(page, 'plain **加粗段** tail');
    const innerAt = (await markdown(page)).indexOf('加粗段') + 1;
    await setRawSelection(page, innerAt, innerAt);
    await clickControl(page, '粗体');
    await waitForMarkdown(page, 'plain 加粗段 tail');
    const a4Unwrapped = await markdown(page);
    check('A4 光标在粗体内部再点粗体解包且不嵌套',
      a4Unwrapped === 'plain 加粗段 tail' && !a4Unwrapped.includes('**'),
      JSON.stringify(a4Unwrapped));

    await setMarkdown(page, '**外部 *内部* 尾**');
    const nestedAt = (await markdown(page)).indexOf('内部') + 1;
    await setRawSelection(page, nestedAt, nestedAt);
    await clickControl(page, '粗体');
    await waitForMarkdown(page, '外部 *内部* 尾');
    const a4Nested = await markdown(page);
    check('A4 光标在内层格式里点粗体只解包外层粗体',
      a4Nested === '外部 *内部* 尾' && !a4Nested.includes('****'),
      JSON.stringify(a4Nested));

    const listIndex = INITIAL.indexOf('列表项');
    await setMarkdown(page, INITIAL); // A4 复现后恢复原状，后续折叠光标测试依赖原文档坐标
    await setRawSelection(page, listIndex + '列表项'.length, listIndex + '列表项'.length);
    await clickControl(page, '斜体');
    await waitForMarkdown(page, INITIAL.replace('列表项', '列表项**'));
    const collapsed = await page.evaluate(() => window.__rawSelection());
    check('折叠光标点击斜体插入空对并把光标放中间',
      (await markdown(page)) === INITIAL.replace('列表项', '列表项**')
      && collapsed.from === listIndex + 4 && collapsed.to === listIndex + 4,
      JSON.stringify(collapsed));

    await setMarkdown(page, '标题行\n\n正文行');
    await selectText(page, '标题行');
    await chooseHeading(page, 1);
    await waitForMarkdown(page, '# 标题行\n\n正文行');
    check('标题选择 H1 写入一个 #', (await markdown(page)) === '# 标题行\n\n正文行');

    // ── #312 A2：编辑态标题带层级梯度类（md-heading-N）──
    const headingProbe = await page.evaluate(() => {
      const node = document.querySelector('.markdown-inline-editor .md-heading');
      return node ? { classes: node.className, size: getComputedStyle(node).fontSize } : null;
    });
    check('A2 编辑态标题带 md-heading-1 梯度类且字号放大',
      !!headingProbe && /md-heading-1/.test(headingProbe.classes) && parseFloat(headingProbe.size) > 13,
      JSON.stringify(headingProbe));
    await chooseHeading(page, 6);
    await waitForMarkdown(page, '###### 标题行\n\n正文行');
    check('标题选择 H6 切换为六个 #', (await markdown(page)) === '###### 标题行\n\n正文行');
    await chooseHeading(page, 0);
    await waitForMarkdown(page, '标题行\n\n正文行');
    check('标题选择正文去掉标题标记', (await markdown(page)) === '标题行\n\n正文行');

    await setMarkdown(page, '甲\n乙');
    await selectAll(page);
    await clickControl(page, '无序列表');
    await waitForMarkdown(page, '- 甲\n- 乙');
    check('多行选区加无序列表', (await markdown(page)) === '- 甲\n- 乙');
    await selectAll(page);
    await clickControl(page, '无序列表');
    await waitForMarkdown(page, '甲\n乙');
    check('再次点击无序列表取消前缀', (await markdown(page)) === '甲\n乙');
    await selectAll(page);
    await clickControl(page, '有序列表');
    await waitForMarkdown(page, '1. 甲\n2. 乙');
    check('有序列表按行编号', (await markdown(page)) === '1. 甲\n2. 乙');
    await selectAll(page);
    await clickControl(page, '引用');
    await waitForMarkdown(page, '> 1. 甲\n> 2. 乙');
    check('引用保留有序列表容器前缀', (await markdown(page)) === '> 1. 甲\n> 2. 乙');

    await setMarkdown(page, '代码行');
    await setRawSelection(page, 0, 0);
    await openOverflow(page);
    await clickMenuItem(page, '代码块');
    const codeBlock = await markdown(page);
    check('溢出菜单代码块包住当前行',
      /^```\n代码行\n```$/.test(codeBlock), JSON.stringify(codeBlock));

    await setMarkdown(page, '表格\n');
    await setRawSelection(page, 0, 0);
    await openOverflow(page);
    await clickMenuItem(page, '表格');
    const tableSource = await markdown(page);
    check('溢出菜单表格插入 GFM 表格骨架',
      tableSource.includes('| --- | --- |') && tableSource.includes('|  |  |'), JSON.stringify(tableSource));

    const beforeUndo = '表格\n';
    await page.getByRole('button', { name: '更多格式', exact: true }).focus();
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(180);
    check('焦点在工具条时 Ctrl+Z 撤销表格', (await markdown(page)) === beforeUndo, JSON.stringify(await markdown(page)));
    await page.getByRole('button', { name: '更多格式', exact: true }).focus();
    await page.keyboard.press('Control+y');
    await page.waitForTimeout(180);
    check('焦点在工具条时 Ctrl+Y 重做表格', (await markdown(page)) === tableSource);
    await openOverflow(page);
    await clickMenuItem(page, '撤销');
    await waitForMarkdown(page, beforeUndo);
    check('溢出菜单撤销可用', (await markdown(page)) === beforeUndo);
    await openOverflow(page);
    await clickMenuItem(page, '重做');
    await waitForMarkdown(page, tableSource);
    check('溢出菜单重做可用', (await markdown(page)) === tableSource);

    await setMarkdown(page, '快捷键');
    await selectText(page, '快捷键');
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(180);
    check('Ctrl+B 在编辑器焦点下加粗选区', (await markdown(page)) === '**快捷键**', JSON.stringify(await markdown(page)));
    await setMarkdown(page, '快捷键');
    await selectText(page, '快捷键');
    await page.keyboard.press('Control+i');
    await page.waitForTimeout(180);
    check('Ctrl+I 在编辑器焦点下斜体选区', (await markdown(page)) === '*快捷键*', JSON.stringify(await markdown(page)));
    await setMarkdown(page, '快捷键');
    await selectText(page, '快捷键');
    const ctrlKChanges = await changeCount(page);
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').waitFor({ state: 'visible' });
    check('Ctrl+K 打开链接弹窗且未改正文',
      (await markdown(page)) === '快捷键' && (await changeCount(page)) === ctrlKChanges);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await waitForPaint(page);

    // ── 4. 原始坐标跨 CRLF 与混合换行，未触碰字节不变 ───────────────────────
    await setMarkdown(page, MIXED);
    const bodyIndex = MIXED.indexOf('body');
    await setRawSelection(page, bodyIndex, bodyIndex + 4);
    await clickControl(page, '粗体');
    await waitForMarkdown(page, '# 混合\r\n**body**\nline\rtail');
    check('跨 CRLF 选区按原始坐标包粗体，CR/LF 逐字节保留',
      (await markdown(page)) === '# 混合\r\n**body**\nline\rtail');

    await setMarkdown(page, MIXED);
    await selectText(page, 'line');
    await clickControl(page, '引用');
    await waitForMarkdown(page, '# 混合\r\nbody\n> line\rtail');
    check('混合换行中给第二行加引用不改其他行尾',
      (await markdown(page)) === '# 混合\r\nbody\n> line\rtail');

    // ── 5. 链接：取消、冻结、文档变化拒绝、已有链接与 URL 安全 ───────────────
    await setMarkdown(page, '前文 链接文字 后文');
    const cancelRange = await selectText(page, '链接文字');
    const beforeCancel = await changeCount(page);
    await openLinkDialog(page);
    check('链接弹窗打开时不写正文', (await markdown(page)) === '前文 链接文字 后文');
    const frozenWhileOpen = await page.evaluate(() => window.__rawSelection());
    check('链接弹窗打开时编辑器选区仍是打开前的原始范围',
      frozenWhileOpen.from === cancelRange.from && frozenWhileOpen.to === cancelRange.to,
      JSON.stringify(frozenWhileOpen));
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await waitForPaint(page);
    check('取消链接不写正文也不触发 onChange',
      (await markdown(page)) === '前文 链接文字 后文' && (await changeCount(page)) === beforeCancel);

    await selectText(page, '链接文字');
    await openLinkDialog(page);
    await fillLink(page, 'https://example.com/a?x=1', '链接文字');
    await submitLink(page);
    await waitForMarkdown(page, '前文 [链接文字](https://example.com/a?x=1) 后文');
    check('应用链接写入显式 http(s) URL', (await markdown(page)) === '前文 [链接文字](https://example.com/a?x=1) 后文');

    await setMarkdown(page, '甲 乙 丙');
    const frozenRange = await selectText(page, '乙');
    await openLinkDialog(page);
    await setRawSelection(page, 0, 1);
    await fillLink(page, 'https://example.com/frozen', '乙');
    await submitLink(page);
    await waitForMarkdown(page, '甲 [乙](https://example.com/frozen) 丙');
    check('弹窗按打开时冻结的选区应用，而不是当前选区',
      (await markdown(page)) === '甲 [乙](https://example.com/frozen) 丙',
      JSON.stringify({ frozenRange, now: await markdown(page) }));

    await setMarkdown(page, '文档一 链接');
    await selectText(page, '链接');
    await openLinkDialog(page);
    await setMarkdown(page, '文档二 链接');
    await fillLink(page, 'https://example.com/stale');
    const beforeStale = await markdown(page);
    await submitLink(page);
    const staleState = await page.evaluate(() => ({
      markdown: window.__resource.markdown,
      alert: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent).join(' | '),
    }));
    check('打开后正文变化则拒绝链接且不写入',
      staleState.markdown === beforeStale && !staleState.markdown.includes('[链接]')
      && /打开链接框后正文已更新/.test(staleState.alert),
      JSON.stringify(staleState));
    if (await page.getByRole('button', { name: '取消', exact: true }).count()) {
      await page.getByRole('button', { name: '取消', exact: true }).click();
    }
    await waitForPaint(page);

    await setMarkdown(page, '[旧文](https://old.example/a) 尾');
    const existingLinkIndex = (await markdown(page)).indexOf('旧文');
    await setRawSelection(page, existingLinkIndex + 1, existingLinkIndex + 1);
    await openLinkDialog(page);
    check('已有链接打开时预填旧地址',
      (await page.getByLabel('链接地址').inputValue()) === 'https://old.example/a');
    await fillLink(page, 'https://new.example/b');
    await submitLink(page);
    await waitForMarkdown(page, '[旧文](https://new.example/b) 尾');
    check('已有链接只更新地址并保留链接文字',
      (await markdown(page)) === '[旧文](https://new.example/b) 尾');

    await setMarkdown(page, '拒绝协议');
    await selectText(page, '拒绝协议');
    await openLinkDialog(page);
    await fillLink(page, 'mailto:a@b.c');
    const invalidBefore = await changeCount(page);
    await submitLink(page);
    const invalid = await page.evaluate(() => ({
      markdown: window.__resource.markdown,
      alert: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent).join(' | '),
    }));
    check('链接弹窗拒绝 mailto 且不写正文',
      invalid.markdown === '拒绝协议' && /http/.test(invalid.alert) && (await changeCount(page)) === invalidBefore,
      JSON.stringify(invalid));
    await page.keyboard.press('Escape');
    await waitForPaint(page);

    // ── 6. 空文档、清空、外部 props/回声 ─────────────────────────────────────
    await setMarkdown(page, '');
    await setRawSelection(page, 0, 0);
    await clickControl(page, '粗体');
    await waitForMarkdown(page, '****');
    const emptyPair = await page.evaluate(() => window.__rawSelection());
    check('空文档折叠光标加粗插入空对并停在中间',
      (await markdown(page)) === '****' && emptyPair.from === 2 && emptyPair.to === 2,
      JSON.stringify(emptyPair));
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(180);
    check('清空正文以空字符串写回父级',
      (await markdown(page)) === '' && (await page.evaluate(() => window.__changes.at(-1))) === '');

    const echoCount = await changeCount(page);
    await setMarkdown(page, '# 外部');
    check('外部 props 更新不触发 onChange', (await changeCount(page)) === echoCount && (await markdown(page)) === '# 外部');
    await setRawSelection(page, 0, 0);
    await page.keyboard.type('X');
    await page.waitForFunction(() => window.__resource.markdown !== '# 外部', null, { timeout: 15000 });
    const ownEcho = await page.evaluate(() => ({
      markdown: window.__resource.markdown,
      changes: window.__changes.length,
      selection: window.__rawSelection(),
    }));
    check('自己的编辑只回调一次并更新父级',
      ownEcho.markdown.startsWith('X# 外部')
      && ownEcho.changes === echoCount + 1,
      JSON.stringify(ownEcho));
    await setMarkdown(page, ownEcho.markdown);
    const afterEcho = await page.evaluate(() => ({
      changes: window.__changes.length,
      selection: window.__rawSelection(),
      markdown: window.__resource.markdown,
    }));
    check('父级回声不重复 onChange 也不重置选区',
      afterEcho.changes === echoCount + 1 && afterEcho.markdown === ownEcho.markdown
      && afterEcho.selection.from === ownEcho.selection.from,
      JSON.stringify(afterEcho));

    // ── 7. 快速卸载/重挂 + 新 resource ID ────────────────────────────────────
    await page.evaluate(() => {
      window.__setResource({ id: 'note-beta', markdown: 'B 文档' });
      window.__setResource({ id: 'note-gamma', markdown: 'G 文档' });
    });
    await page.waitForFunction(() => window.__resource?.id === 'note-gamma', null, { timeout: 15000 });
    await page.waitForTimeout(220);
    const remounted = await page.evaluate(() => ({
      editors: document.querySelectorAll('.cm-editor').length,
      markdown: window.__resource.markdown,
      toolbar: document.querySelectorAll('[role="toolbar"][aria-label="Markdown 格式"]').length,
    }));
    check('快速换 resource ID 后只有一个新编辑器且没有旧草稿',
      remounted.editors === 1 && remounted.markdown === 'G 文档' && remounted.toolbar === 1,
      JSON.stringify(remounted));

    // ── 8. 真实 CDP IME：外部旧回声不能盖掉最终父级资源 ──────────────────────
    await setResource(page, { id: 'note-ime', markdown: '中文' });
    await setRawSelection(page, 2, 2);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', {
      text: '外部覆盖',
      selectionStart: 4,
      selectionEnd: 4,
      replacementStart: 0,
      replacementEnd: 0,
    });
    await page.waitForTimeout(100);
    // 组合期间外部旧回声只会挂起，不会进 CM 文档；这里不能等文档长度。
    await page.evaluate(() => window.__setMarkdown('旧回显'));
    await page.waitForFunction(() => window.__resource.markdown === '旧回显', null, { timeout: 15000 });
    await page.waitForTimeout(100);
    await cdp.send('Input.insertText', { text: '外部覆盖' });
    // 组合结束可能晚于 DOM 提交；等最终资源落到已提交中文，而不是只看固定延时。
    await page.waitForFunction(
      () => {
        const text = window.__resource.markdown;
        return text.includes('外部覆盖') && !text.includes('旧回显');
      },
      null,
      { timeout: 5000 },
    );
    await page.waitForTimeout(100);
    const ime = await page.evaluate(() => ({
      markdown: window.__resource.markdown,
      changes: window.__changes.slice(),
      editors: document.querySelectorAll('.cm-editor').length,
    }));
    check('IME 组合期间的外部旧回声不覆盖已提交中文',
      ime.markdown.includes('外部覆盖') && !ime.markdown.includes('旧回显')
      && ime.changes.some((value) => value.includes('外部覆盖')) && ime.editors === 1,
      JSON.stringify(ime));

    // ── 9. 只读：不可编辑，安全 http(s) 才是链接 ─────────────────────────────
    await setMarkdown(page, '[安全](https://example.com/safe) [邮件](mailto:a@b.c) [脚本](javascript:alert(1))');
    await page.evaluate(() => window.__setReadOnly(true));
    await page.waitForSelector('.note-editor.is-readonly', { timeout: 10000 });
    await waitForPaint(page);
    const readonly = await page.evaluate(() => ({
      editors: document.querySelectorAll('.cm-editor').length,
      toolbars: document.querySelectorAll('[role="toolbar"]').length,
      preview: Boolean(document.querySelector('.note-editor__preview')),
      anchors: [...document.querySelectorAll('.note-editor__preview a')].map((node) => ({
        href: node.getAttribute('href') || '', text: node.textContent,
      })),
    }));
    check('只读不渲染编辑器或工具条', readonly.editors === 0 && readonly.toolbars === 0 && readonly.preview);
    const safeAnchor = readonly.anchors.find((anchor) => anchor.href === 'https://example.com/safe');
    const unsafeAnchors = readonly.anchors.filter((anchor) => /^(mailto:|javascript:)/i.test(anchor.href));
    const unsafeLabelsAsAnchors = readonly.anchors.filter((anchor) => /邮件|脚本/.test(anchor.text));
    check('只读预览只把 http(s) 渲染为链接，mailto/js 不是 anchor',
      Boolean(safeAnchor) && readonly.anchors.length === 1
      && unsafeAnchors.length === 0 && unsafeLabelsAsAnchors.length === 0
      && readonly.anchors.every((anchor) => /^https?:/i.test(anchor.href)),
      JSON.stringify(readonly.anchors));
    if (safeAnchor) {
      await page.evaluate(() => { window.__opened.length = 0; });
      const beforeUrl = page.url();
      const safeLink = page.locator('.note-editor__preview a[href="https://example.com/safe"]');
      const linkAttrs = await safeLink.evaluate((node) => ({
        target: node.getAttribute('target') || '',
        rel: node.getAttribute('rel') || '',
      }));
      await safeLink.click();
      await waitForPaint(page);
      const opened = await page.evaluate(() => window.__opened.slice());
      check('只读安全链接不导航当前页且新页打开',
        page.url() === beforeUrl
        && linkAttrs.target === '_blank'
        && /\bnoopener\b/.test(linkAttrs.rel),
        JSON.stringify({ opened, popups, linkAttrs, url: page.url() }));
    }
    const readonlyBefore = await markdown(page);
    await page.keyboard.press('Control+a');
    await page.keyboard.type('X');
    await waitForPaint(page);
    check('只读下键盘不能改父级正文', (await markdown(page)) === readonlyBefore);

    // ── #312 A3/A2 只读预览：语言角标、无语言不标、引用块左边条 ───────────────
    // 只读态没有 CM 编辑器，waitForMarkdown 的 __docLength 等不到 —— 直接等预览渲染。
    const readonlyA3Markdown = '```python\nprint(1)\n```\n\n```\n无语言\n```\n\n> 引用段';
    await page.evaluate((value) => window.__setMarkdown(value), readonlyA3Markdown);
    await page.waitForFunction((value) => window.__resource?.markdown === value, readonlyA3Markdown, { timeout: 15000 });
    await page.waitForFunction(
      () => document.querySelector('.note-editor__preview')?.innerText.includes('无语言'),
      null,
      { timeout: 15000 },
    );
    await waitForPaint(page);
    const readonlyA3 = await page.evaluate(() => {
      const pres = [...document.querySelectorAll('.note-editor__preview pre')];
      return {
        marked: pres.map((pre) => ({
          lang: pre.getAttribute('data-md-lang') || '',
          after: getComputedStyle(pre, '::after').content,
        })),
        quote: (() => {
          const quote = document.querySelector('.note-editor__preview blockquote');
          return quote ? getComputedStyle(quote).borderLeftWidth : '';
        })(),
      };
    });
    check('A3 只读预览带语言代码块显示语言角标，无语言不标',
      readonlyA3.marked.length === 2
      && readonlyA3.marked[0].lang === 'python' && readonlyA3.marked[0].after.includes('python')
      && readonlyA3.marked[1].lang === '' && (readonlyA3.marked[1].after === 'none' || readonlyA3.marked[1].after === 'normal'),
      JSON.stringify(readonlyA3));
    check('A2 只读预览引用块有左边条', readonlyA3.quote === '3px', JSON.stringify(readonlyA3.quote));

    // ── #312 A5 只读渲染面：只读态也盖加深面，亮暗两主题都断言 ─────────────────
    const readonlyFaceOf = () => page.evaluate(() => {
      const face = getComputedStyle(document.querySelector('.note-editor.is-readonly')).backgroundColor;
      const host = getComputedStyle(document.querySelector('.studymate-notes')).backgroundColor;
      const preview = getComputedStyle(document.querySelector('.note-editor__preview')).backgroundColor;
      return { face, host, preview };
    });
    const readonlyFaceLight = await readonlyFaceOf();
    check('A5 只读渲染面亮色比宿主面深一档',
      lumOf(readonlyFaceLight.face) < lumOf(readonlyFaceLight.host) && lumOf(readonlyFaceLight.host) - lumOf(readonlyFaceLight.face) < 0.12,
      JSON.stringify(readonlyFaceLight));
    await page.evaluate(() => window.__setTheme('dark'));
    await waitForPaint(page);
    const readonlyFaceDark = await readonlyFaceOf();
    check('A5 只读渲染面暗色比旧宿主面 #1e2423 更深',
      lumOf(readonlyFaceDark.face) < lumOf('rgb(30, 36, 35)'),
      JSON.stringify(readonlyFaceDark));
    await page.evaluate(() => window.__setTheme('light'));
    await waitForPaint(page);
    await page.evaluate(() => window.__setReadOnly(false));
    await page.waitForSelector('.markdown-inline-editor .cm-editor', { timeout: 10000 });
    await waitForPaint(page);

    // ── 10. 128 Ki：整笔拒绝、超限源可修复且不截断 ──────────────────────────
    check('模块上限就是 128 Ki', (await page.evaluate(() => window.__MAX)) === MAX_MARKDOWN_LENGTH);
    await setMarkdown(page, 'a'.repeat(MAX_MARKDOWN_LENGTH - 2));
    await setRawSelection(page, MAX_MARKDOWN_LENGTH - 2, MAX_MARKDOWN_LENGTH - 2);
    const limitBefore = await changeCount(page);
    await page.keyboard.insertText('12345');
    await page.waitForTimeout(180);
    const rejected = await page.evaluate(() => ({
      markdown: window.__resource.markdown,
      changes: window.__changes.length,
      alert: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent).join(' | '),
    }));
    check('超过 128 Ki 的整笔输入被拒绝且原稿不截断',
      rejected.markdown.length === MAX_MARKDOWN_LENGTH - 2
      && rejected.changes === limitBefore
      && rejected.markdown === 'a'.repeat(MAX_MARKDOWN_LENGTH - 2),
      JSON.stringify({ length: rejected.markdown.length, changes: rejected.changes, alert: rejected.alert }));

    // 超限文件以新 resource ID 打开：新编辑器必须完整装下原稿，而不是截断到上限。
    await setResource(page, { id: 'note-oversize', markdown: 'b'.repeat(MAX_MARKDOWN_LENGTH + 1) });
    await page.waitForFunction(
      (length) => typeof window.__docLength === 'function' && window.__docLength() === length,
      MAX_MARKDOWN_LENGTH + 1,
      { timeout: 15000 },
    );
    const oversize = await page.evaluate(() => ({
      toolbarDisabled: document.querySelector('.md-format-toolbar')?.getAttribute('aria-disabled'),
      selectDisabled: document.querySelector('select[aria-label="标题"]')?.disabled,
      buttonDisabled: [...document.querySelectorAll('.md-format-toolbar button')].every((node) => node.disabled),
      docLength: window.__docLength(),
      textLength: window.__resource.markdown.length,
    }));
    check('超限源完整保留、工具条禁用',
      oversize.docLength === MAX_MARKDOWN_LENGTH + 1
      && oversize.textLength === MAX_MARKDOWN_LENGTH + 1
      && oversize.toolbarDisabled === 'true'
      && oversize.selectDisabled === true
      && oversize.buttonDisabled === true,
      JSON.stringify(oversize));
    await setRawSelection(page, MAX_MARKDOWN_LENGTH + 1, MAX_MARKDOWN_LENGTH + 1);
    await page.keyboard.insertText('Z');
    await page.waitForTimeout(160);
    check('超限时继续输入也被整笔拒绝',
      (await markdown(page)) === 'b'.repeat(MAX_MARKDOWN_LENGTH + 1));
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText('修复');
    await waitForMarkdown(page, '修复');
    const repaired = await page.evaluate(() => ({
      toolbarDisabled: document.querySelector('.md-format-toolbar')?.getAttribute('aria-disabled'),
      buttonsDisabled: [...document.querySelectorAll('.md-format-toolbar button')].some((node) => node.disabled),
      changes: window.__changes.at(-1),
    }));
    check('超限源可整体替换修复且工具条恢复',
      (await markdown(page)) === '修复' && repaired.toolbarDisabled == null
      && !repaired.buttonsDisabled && repaired.changes === '修复',
      JSON.stringify(repaired));

    // ── 11. 公式/表格/图片/代码/原始 HTML 只读渲染且零远端请求 ───────────────
    await setMarkdown(page, RICH);
    await setRawSelection(page, 0, 0);
    await waitForPaint(page);
    const rich = await page.evaluate(() => ({
      katex: document.querySelectorAll('.katex').length,
      table: Boolean(document.querySelector('.md-table-widget table')),
      imagePlaceholder: Boolean(document.querySelector('.md-image-placeholder')),
      img: document.querySelectorAll('.cm-content img').length,
      imgSrcs: [...document.querySelectorAll('.cm-content img')].map((node) => node.getAttribute('src') || ''),
      codeBody: document.querySelectorAll('.md-code-body').length,
      codeLang: document.querySelector('.md-code-lang')?.textContent || '',
      scripts: document.querySelectorAll('.cm-content script').length,
      pwned: window.__pwned,
      text: document.querySelector('.cm-content')?.innerText || '',
    }));
    check('公式渲染 KaTeX', rich.katex >= 1, JSON.stringify(rich.katex));
    check('GFM 表格渲染为安全 DOM 表格', rich.table);
    check('图片只留本地占位，img 全部是内联资源',
      rich.imagePlaceholder
      && rich.imgSrcs.every((src) => !src || /^(data:|blob:)/.test(src))
      && !rich.imgSrcs.some((src) => /example\.com\/(pic|raw)\.png/.test(src)),
      JSON.stringify(rich.imgSrcs));
    check('代码围栏正文保留并可高亮', rich.codeBody >= 1);
    // ── #312 A3 编辑态：休息态开围栏行显示语言角标，点角标显形围栏源码 ──
    check('A3 编辑态开围栏行显示语言角标 js', rich.codeLang === 'js', JSON.stringify(rich.codeLang));
    await page.locator('.md-code-lang').click();
    await waitForPaint(page);
    const chipReveal = await page.evaluate(() => ({
      chips: document.querySelectorAll('.md-code-lang').length,
      fenceSource: [...document.querySelectorAll('.markdown-inline-editor .md-syntax:not(.md-syntax-hidden)')]
        .map((node) => node.textContent).join(''),
    }));
    check('A3 点语言角标后显形围栏源码',
      chipReveal.chips === 0 && chipReveal.fenceSource.includes('```'),
      JSON.stringify(chipReveal));

    // ── A3 可访问性：button 语义 + 键盘可操作（Enter），不写父级、焦点回编辑器 ──
    await setMarkdown(page, RICH);
    await setRawSelection(page, 0, 0);
    await waitForPaint(page);
    const chipA11y = await page.evaluate(() => {
      const chip = document.querySelector('.md-code-lang');
      if (!chip) return { chip: false };
      chip.focus();
      return {
        chip: true,
        focused: document.activeElement === chip,
        role: chip.getAttribute('role'),
        tabIndex: chip.tabIndex,
        label: chip.getAttribute('aria-label') || '',
      };
    });
    check('A3 语言角标有 button 语义且可编程聚焦（不进 Tab 序）',
      chipA11y.chip && chipA11y.focused && chipA11y.role === 'button' && chipA11y.tabIndex === -1
      && chipA11y.label.includes('js'),
      JSON.stringify(chipA11y));
    await page.keyboard.press('Enter');
    await waitForPaint(page);
    const kbReveal = await page.evaluate(() => ({
      fenceVisible: Boolean(document.querySelector('.markdown-inline-editor .md-code-fence')),
      chips: document.querySelectorAll('.md-code-lang').length,
      focusInEditor: Boolean(document.activeElement?.closest('.cm-editor')),
    }));
    check('A3 键盘 Enter 显形围栏、焦点回到编辑器',
      kbReveal.fenceVisible && kbReveal.chips === 0 && kbReveal.focusInEditor,
      JSON.stringify(kbReveal));
    await setMarkdown(page, RICH);
    await setRawSelection(page, 0, 0);
    await waitForPaint(page);
    const srClick = await page.evaluate(() => {
      const chip = document.querySelector('.md-code-lang');
      if (!chip) return { chip: false };
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0, cancelable: true }));
      return {
        chip: true,
        fenceVisible: Boolean(document.querySelector('.markdown-inline-editor .md-code-fence')),
        focusInEditor: Boolean(document.activeElement?.closest('.cm-editor')),
      };
    });
    check('A3 读屏激活（detail=0 click）显形围栏且焦点回编辑器',
      srClick.chip && srClick.fenceVisible && srClick.focusInEditor,
      JSON.stringify(srClick));
    check('原始 HTML 不执行 script、不建远端 img',
      rich.scripts === 0
      && rich.pwned === undefined
      && !rich.imgSrcs.some((src) => /example\.com\/raw\.png/.test(src)),
      JSON.stringify({ scripts: rich.scripts, pwned: rich.pwned, imgSrcs: rich.imgSrcs }));
    check('原始 HTML 作为文字留在源码中', rich.text.includes('<b>safe raw html</b>'));
    check('富文本没有远端图片/公式请求', requests.length === 0, requests.join(', '));

    // ── 12. 源码编辑不导航；335px 亮暗单行与 AA ─────────────────────────────
    await setMarkdown(page, 'https://example.com/typing');
    const beforeUrl = page.url();
    await setRawSelection(page, 0, 0);
    await page.keyboard.type('x');
    await page.waitForTimeout(160);
    check('源码里输入 URL 不导航且编辑区没有 anchor',
      page.url() === beforeUrl
      && (await markdown(page)).startsWith('xhttps://example.com/typing')
      && (await page.locator('.cm-content a').count()) === 0);

    // 文档带一个休息态围栏：chip 在亮暗两主题下都要过 AA（#312 A3 可访问性）。
    await setMarkdown(page, '**粗体** 与 `代码`\n\n```js\nconst x = 1;\n```');
    const themeBold = (await markdown(page)).indexOf('粗体');
    await setRawSelection(page, themeBold, themeBold + 2);
    await page.setViewportSize({ width: 335, height: 760 });
    await waitForPaint(page);
    const measureTheme = async (name) => page.evaluate((label) => {
      const toolbar = document.querySelector('.md-format-toolbar');
      const controls = [...toolbar.querySelectorAll('button, select')];
      const rects = controls.map((node) => node.getBoundingClientRect());
      const rows = new Set(rects.map((rect) => Math.round(rect.top + rect.height / 2)));
      const background = (node) => {
        let current = node;
        while (current) {
          const value = getComputedStyle(current).backgroundColor;
          const alpha = value.startsWith('rgba') ? Number((value.match(/[\d.]+/g) || [])[3] || 1) : 1;
          if (alpha > 0.05) return value;
          current = current.parentElement;
        }
        return 'rgb(255,255,255)';
      };
      const rgb = (value) => {
        const numbers = (value.match(/[\d.]+/g) || []).map(Number);
        if (value.startsWith('color(')) return numbers.slice(0, 3).map((channel) => channel * 255);
        return numbers.slice(0, 3);
      };
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
      const marker = document.querySelector('.md-syntax:not(.md-syntax-hidden)');
      const code = document.querySelector('.md-inline-code');
      const editor = document.querySelector('.markdown-inline-editor');
      const bg = background(editor);
      return {
        label,
        rows: rows.size,
        toolbarHeight: toolbar.getBoundingClientRect().height,
        toolbarWidth: toolbar.getBoundingClientRect().width,
        scrollWidth: document.documentElement.scrollWidth,
        markerRatio: marker ? ratio(getComputedStyle(marker).color, bg) : 0,
        markerColor: marker ? getComputedStyle(marker).color : '',
        codeRatio: code ? ratio(getComputedStyle(code).color, getComputedStyle(code).backgroundColor) : 0,
        codeColor: code ? getComputedStyle(code).color : '',
        codeBg: code ? getComputedStyle(code).backgroundColor : '',
      };
    }, name);

    const light = await measureTheme('light');
    check('335px 浅色工具条仍是一行且无横向溢出',
      light.rows === 1 && light.toolbarWidth <= 335 && light.scrollWidth <= 335 && light.toolbarHeight < 40,
      JSON.stringify(light));
    check('浅色灰色分隔符与代码达到 AA',
      light.markerRatio >= 4.5 && light.codeRatio >= 4.5,
      JSON.stringify(light));
    // ── #312 A1/A5：下拉弹层 color-scheme、实底色与 AA，编辑面比宿主面深一档（亮色）──
    const faceOf = () => page.evaluate(() => {
      const rgb = (value) => {
        const numbers = (value.match(/[\d.]+/g) || []).map(Number);
        if (value.startsWith('color(')) return numbers.slice(0, 3).map((channel) => channel * 255);
        return numbers.slice(0, 3);
      };
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
      const select = document.querySelector('.md-format-toolbar__select');
      const option = select?.querySelector('option');
      const chip = document.querySelector('.md-code-lang');
      const alpha = (value) => (value.startsWith('rgba') ? Number((value.match(/[\d.]+/g) || [])[3] || 1) : 1);
      return {
        scheme: getComputedStyle(select).colorScheme,
        selectBg: getComputedStyle(select).backgroundColor,
        optionColor: option ? getComputedStyle(option).color : '',
        optionBg: option ? getComputedStyle(option).backgroundColor : '',
        optionRatio: option ? ratio(getComputedStyle(option).color, getComputedStyle(option).backgroundColor) : 0,
        selectAlpha: alpha(getComputedStyle(select).backgroundColor),
        chipRatio: chip ? ratio(getComputedStyle(chip).color, getComputedStyle(chip).backgroundColor) : 0,
        chipColor: chip ? getComputedStyle(chip).color : '',
        chipBg: chip ? getComputedStyle(chip).backgroundColor : '',
        face: getComputedStyle(document.querySelector('.note-editor')).backgroundColor,
        host: getComputedStyle(document.querySelector('.studymate-notes')).backgroundColor,
      };
    });
    const faceLight = await faceOf();
    check('A1 亮色下拉弹层 color-scheme 是 light', faceLight.scheme === 'light', JSON.stringify(faceLight));
    check('A1 亮色下拉收起态有明确实底色', faceLight.selectAlpha > 0.9, JSON.stringify(faceLight));
    check('A1 亮色下拉 option 实底且对比 >= AA',
      faceLight.optionRatio >= 4.5 && faceLight.optionBg !== 'rgba(0, 0, 0, 0)',
      JSON.stringify(faceLight));
    check('A3 亮色语言角标对比 >= AA',
      faceLight.chipRatio >= 4.5 && faceLight.chipBg !== 'rgba(0, 0, 0, 0)',
      JSON.stringify(faceLight));
    check('A5 亮色编辑面比宿主面深一档',
      lumOf(faceLight.face) < lumOf(faceLight.host) && lumOf(faceLight.host) - lumOf(faceLight.face) < 0.12,
      JSON.stringify(faceLight));
    await page.evaluate(() => window.__setTheme('dark'));
    await waitForPaint(page);
    const dark = await measureTheme('dark');
    check('335px 深色工具条仍是一行且无横向溢出',
      dark.rows === 1 && dark.toolbarWidth <= 335 && dark.scrollWidth <= 335 && dark.toolbarHeight < 40,
      JSON.stringify(dark));
    check('深色灰色分隔符与代码达到 AA',
      dark.markerRatio >= 4.5 && dark.codeRatio >= 4.5,
      JSON.stringify(dark));
    const faceDark = await faceOf();
    check('A1 暗色下拉弹层 color-scheme 是 dark', faceDark.scheme === 'dark', JSON.stringify(faceDark));
    check('A1 暗色下拉收起态有明确实底色且 option 实底对比 >= AA',
      faceDark.selectAlpha > 0.9 && faceDark.optionRatio >= 4.5 && faceDark.optionBg !== 'rgba(0, 0, 0, 0)',
      JSON.stringify(faceDark));
    check('A3 暗色语言角标对比 >= AA',
      faceDark.chipRatio >= 4.5 && faceDark.chipBg !== 'rgba(0, 0, 0, 0)',
      JSON.stringify(faceDark));
    check('A5 暗色编辑面比旧宿主面 #1e2423 更深',
      lumOf(faceDark.face) < lumOf('rgb(30, 36, 35)'),
      JSON.stringify(faceDark));
    await page.evaluate(() => window.__setTheme('light'));
    await waitForPaint(page);

    check('全程无 console/page 错误', errors.length === 0, errors.join(' / '));
    check('全程无远端请求（含被中止的）', requests.length === 0, requests.join(', '));
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
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
