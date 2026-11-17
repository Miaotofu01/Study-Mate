/* 无界笔记 · ResourceTree 的真浏览器验收（#312）。
   跑法：node scripts/tests/browser/notes_resource_tree_test.mjs

   只验证 ResourceTree 组件本身的外部行为（挂真组件的临时夹具页，不依赖 App.jsx 集成）：
   - 文件/文件夹**单高亮互斥**：同一时刻树里最多一行 is-active；点击与外部 props 变化都收敛到一份高亮；
   - 文件更多菜单：重命名（行内编辑，Enter/失焦提交、Escape 取消、空名校验）+ 归档禁用占位；
     引用文件（origin.mode === 'reference'）重命名禁用并说明；
   - 文件夹/笔记本更多菜单：重命名；删除仅在**空目录**可用——非空禁用并给出计数提醒
     （trashed 资源计入、笔记本画布经 hasCanvasContent 计入）；空目录删除走 window.confirm 二次确认；
     系统根、initialParent 回退目录（notes/examples/references）、最后一本笔记本、默认本、绑定本各有独立禁用提醒；
   - 只读（canEdit=false）：更多按钮禁用、菜单打不开、树行不可拖拽；
   - 菜单初始焦点落在第一个可用项，全禁用时退回首项；
   - 行内重命名切换目标（编辑中点其他行）先提交旧编辑，不静默丢值；
   - 菜单打开/关闭（外点、Escape）与无控制台错误。

   需要 Microsoft Edge；没有就 SKIP（退出码 3）。页面由本文件用 esbuild 打到临时目录，
   临时目录在 finally 里清理。不连接真实 DSH 或模型。 */
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
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
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

const FOLDERS = [
  { id: 'library', parent: null, name: '我的资料', kind: 'folder' },
  { id: 'empty', parent: 'library', name: '空目录', kind: 'folder' },
  { id: 'full', parent: 'library', name: '概念目录', kind: 'folder' },
  { id: 'child', parent: 'full', name: '子目录', kind: 'folder' },
  { id: 'trashy', parent: 'library', name: '废纸目录', kind: 'folder' },
  { id: 'notes', parent: 'library', name: '未归属去处', kind: 'folder' },
  { id: 'book', parent: 'library', name: '数学本', kind: 'notebook', bindings: [{ workspace: 'w', subject: 'shuxue' }], defaultForSubjects: [{ workspace: 'w', subject: 'shuxue' }] },
  { id: 'empty-book', parent: 'library', name: '空本', kind: 'notebook' },
];
const RESOURCES = {
  'note-a': { id: 'note-a', type: 'note', title: '向量.md', parent: 'full', markdown: '# 向量' },
  'ref-1': { id: 'ref-1', type: 'svg', title: '引用.svg', parent: 'full', origin: { kind: 'file', mode: 'reference' } },
  'trash-1': { id: 'trash-1', type: 'note', title: '废纸.md', parent: 'trashy', trashed: true },
};

const FIXTURE = `
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ResourceTree from './client/notes/ResourceTree.jsx';
import './client/notes/styles.css';
import './client/notes/components-v2.css';
import './client/notes/theme-v3.css';
import './client/notes/layout-v2.css';
import './client/notes/ui-v4.css';

const FOLDERS = ${JSON.stringify(FOLDERS)};
const RESOURCES = ${JSON.stringify(RESOURCES)};

window.__events = [];
window.__confirmLog = [];
window.__confirmNext = false;
window.confirm = (message) => { window.__confirmLog.push(String(message)); return window.__confirmNext; };

function Harness() {
  const [folders, setFolders] = useState(FOLDERS);
  const [resources, setResources] = useState(RESOURCES);
  const [selectedId, setSelectedId] = useState('note-a');
  const [selectedFolder, setSelectedFolder] = useState('full');
  const [canvasContent, setCanvasContent] = useState(false);
  const [canEdit, setCanEdit] = useState(true);
  window.__setSelectedId = setSelectedId;
  window.__setSelectedFolder = setSelectedFolder;
  window.__setCanvas = setCanvasContent;
  window.__setCanEdit = setCanEdit;
  window.__renameFolder = (id, name) => { window.__events.push({ type: 'renameFolder', id, name }); setFolders((previous) => previous.map((folder) => folder.id === id ? { ...folder, name } : folder)); };
  window.__renameResource = (id, title) => { window.__events.push({ type: 'renameResource', id, title }); setResources((previous) => ({ ...previous, [id]: { ...previous[id], title } })); };
  window.__deleteFolder = (id) => { window.__events.push({ type: 'deleteFolder', id }); setFolders((previous) => previous.filter((folder) => folder.id !== id)); };
  window.__removeEmptyBook = () => setFolders((previous) => previous.filter((folder) => folder.id !== 'empty-book'));
  // 目标在菜单打开期间消失/进废纸篓：外部状态变化的两种真实来源（轮询回灌、删除、回收站）。
  window.__removeFolder = (id) => setFolders((previous) => previous.filter((folder) => folder.id !== id));
  window.__trashResource = (id) => setResources((previous) => ({ ...previous, [id]: { ...previous[id], trashed: true } }));
  return <div className="app-shell v2 v3 v4" data-theme="light" style={{ position: 'relative', width: 900, height: 560, overflow: 'hidden', background: '#f6f7f9' }}>
    <ResourceTree
      folders={folders} resources={resources} search=""
      selectedId={selectedId} selectedFolder={selectedFolder}
      onFolderSelect={setSelectedFolder} onSelect={(id) => window.__events.push({ type: 'select', id })}
      onOpenDocument={(id) => window.__events.push({ type: 'open', id })}
      onCanvas={(id) => window.__events.push({ type: 'canvas', id })}
      canEdit={canEdit}
      onRenameFolder={window.__renameFolder}
      onDeleteFolder={window.__deleteFolder}
      onRenameResource={window.__renameResource}
      hasCanvasContent={() => canvasContent} />
  </div>;
}

createRoot(document.getElementById('root')).render(<Harness />);
`;

async function buildFixture(dir) {
  await build({
    absWorkingDir: ROOT,
    stdin: {
      contents: FIXTURE,
      resolveDir: ROOT,
      sourcefile: 'notes-resource-tree-fixture.jsx',
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
    logLevel: 'silent',
  });
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,"><link rel="stylesheet" href="bundle.css">
<style>html,body,#root{margin:0;width:100%;height:100%;}</style>
</head>
<body><div id="root"></div><script src="bundle.js"></script></body></html>`);
}

/* ── 页面操作小工具 ─────────────────────────────────────────────────────── */

const folderRow = (page, name) => page.locator('.tree-row', { has: page.locator(`button[aria-label="${name} 文件夹"]`) });
const fileRow = (page, title) => page.locator('.tree-row.tree-file', { has: page.locator(`button[aria-label="打开 ${title}"]`) });
const moreOf = (page, label) => page.locator(`[aria-label="${label}的更多操作"]`);

async function openMenu(page, label) {
  await page.click(`[aria-label="${label}的更多操作"]`);
  await page.waitForSelector('[role="menu"]', { state: 'visible' });
}

async function activeRows(page) {
  return page.evaluate(() => [...document.querySelectorAll('.tree-row.is-active')].map((row) => row.className.includes('tree-file')
    ? 'file:' + row.querySelector('.tree-label').textContent
    : 'folder:' + (row.querySelector('.tree-row-label')?.querySelector('.tree-label')?.textContent || '?')));
}

async function events(page) {
  return page.evaluate(() => window.__events.slice());
}

/* ── 场景 ──────────────────────────────────────────────────────────────── */

async function main() {
  const playwright = await loadPlaywright();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-tree-'));
  const problems = [];
  let server = null, browser = null;
  try {
    await buildFixture(tmp);
    const { origin, server: s } = await serve(tmp);
    server = s;
    const { chromium } = playwright.default || playwright;
    try {
      browser = await chromium.launch({ channel: 'msedge', headless: true });
    } catch (error) {
      const missing = /(Executable doesn't exist|is not found at|Unable to launch browser|not installed|no such file|ENOENT|Could not find (Microsoft Edge|Chrome))/i.test(String(error.message))
        && /(channel|msedge|Edge|executable)/i.test(String(error.message));
      if (missing) skip('启动不了独立 Edge（channel: msedge）：' + String(error.message).split('\n')[0]);
      throw error;
    }
    const context = await browser.newContext({ viewport: { width: 1000, height: 640 } });
    const page = await context.newPage();
    page.on('console', (message) => { if (message.type() === 'error') problems.push('console: ' + message.text()); });
    page.on('pageerror', (error) => problems.push('pageerror: ' + error.message));
    page.on('requestfailed', (request) => problems.push('requestfailed: ' + request.url()));
    await page.goto(origin + '/', { waitUntil: 'load' });
    await page.waitForSelector('.resource-tree');

    /* 1. 单高亮互斥 */
    check('初始恰好一行高亮（文件优先）', JSON.stringify(await activeRows(page)) === JSON.stringify(['file:向量.md']), JSON.stringify(await activeRows(page)));
    await page.click('button[aria-label="空目录 文件夹"]');
    check('点文件夹后：只亮文件夹', JSON.stringify(await activeRows(page)) === JSON.stringify(['folder:空目录']), JSON.stringify(await activeRows(page)));
    await page.click('button[aria-label="打开 向量.md"]');
    check('点文件后：只亮文件，文件夹高亮互斥退位', JSON.stringify(await activeRows(page)) === JSON.stringify(['file:向量.md']), JSON.stringify(await activeRows(page)));
    await page.evaluate(() => window.__setSelectedFolder('library'));
    await page.waitForTimeout(60);
    check('外部改 selectedFolder：跟随文件夹，文件退位', JSON.stringify(await activeRows(page)) === JSON.stringify(['folder:我的资料']), JSON.stringify(await activeRows(page)));
    await page.evaluate(() => window.__setSelectedId('ref-1'));
    await page.waitForTimeout(60);
    check('外部改 selectedId：跟随文件，文件夹退位', JSON.stringify(await activeRows(page)) === JSON.stringify(['file:引用.svg']), JSON.stringify(await activeRows(page)));

    /* 2. 文件菜单：重命名 + 归档占位 */
    await page.evaluate(() => { window.__events.length = 0; });
    await openMenu(page, '向量.md');
    const fileMenu = page.locator('[role="menu"][aria-label="向量.md 的文件操作"]');
    check('文件菜单出现', await fileMenu.isVisible());
    const renameItem = fileMenu.getByRole('menuitem', { name: '重命名' });
    check('文件菜单有重命名且可用', (await renameItem.getAttribute('aria-disabled')) === null);
    const archiveItem = fileMenu.getByRole('menuitem', { name: '归档' });
    check('归档是禁用占位', (await archiveItem.getAttribute('aria-disabled')) === 'true' && (await archiveItem.getAttribute('title')).includes('尚未实现'));
    await archiveItem.click({ force: true });
    check('点禁用的归档无回调且菜单不关', (await events(page)).length === 0 && await fileMenu.isVisible(),
      'events=' + JSON.stringify(await events(page)) + ' menus=' + (await page.locator('[role="menu"]').count()) + ' pointers=' + JSON.stringify(await page.evaluate(() => window.__pointLog)));

    /* 3. 行内重命名 */
    await renameItem.click();
    const input = page.locator('.tree-rename-input');
    await input.waitFor({ state: 'visible' });
    check('重命名进入行内编辑并预填原名', (await input.inputValue()) === '向量.md');
    await input.fill('向量空间.md');
    await input.press('Enter');
    await page.waitForTimeout(60);
    check('Enter 提交重命名回调', JSON.stringify((await events(page)).at(-1)) === JSON.stringify({ type: 'renameResource', id: 'note-a', title: '向量空间.md' }), JSON.stringify((await events(page)).at(-1)));
    check('树标签更新为新标题', await page.locator('button[aria-label="打开 向量空间.md"]').count() === 1);
    await openMenu(page, '向量空间.md');
    await page.locator('[role="menu"][aria-label="向量空间.md 的文件操作"]').getByRole('menuitem', { name: '重命名' }).click();
    await input.fill('   ');
    await input.press('Enter');
    check('空名校验：显示错误且不提交', await page.locator('.tree-rename-error[role="alert"]').isVisible() && (await events(page)).every((event) => event.type !== 'renameResource' || event.title !== '   '));
    await input.press('Escape');
    await page.waitForTimeout(60);
    check('Escape 取消重命名', await page.locator('.tree-rename-input').count() === 0);

    /* 4. 引用文件不可重命名 */
    await openMenu(page, '引用.svg');
    const refMenu = page.locator('[role="menu"][aria-label="引用.svg 的文件操作"]');
    const refRename = refMenu.getByRole('menuitem', { name: '重命名' });
    check('引用文件的重命名禁用并说明', (await refRename.getAttribute('aria-disabled')) === 'true' && (await refRename.textContent()).includes('跟随来源'));
    await refRename.click({ force: true });
    check('点禁用的重命名无反应', (await events(page)).every((event) => event.type !== 'renameResource' || event.id !== 'ref-1'));
    await page.keyboard.press('Escape');

    /* 5. 文件夹菜单与重命名 */
    await openMenu(page, '概念目录');
    const folderMenu = page.locator('[role="menu"][aria-label="概念目录 的目录操作"]');
    check('目录菜单有重命名与删除两项', (await folderMenu.getByRole('menuitem', { name: '重命名' }).count()) === 1 && (await folderMenu.getByRole('menuitem', { name: '删除' }).count()) === 1);
    await folderMenu.getByRole('menuitem', { name: '重命名' }).click();
    await input.fill('  概念库  ');
    await input.press('Enter');
    await page.waitForTimeout(60);
    check('目录重命名回调（去空白）', JSON.stringify((await events(page)).at(-1)) === JSON.stringify({ type: 'renameFolder', id: 'full', name: '概念库' }), JSON.stringify((await events(page)).at(-1)));
    check('目录标签更新', await page.locator('button[aria-label="概念库 文件夹"]').count() === 1);

    /* 6. 非空目录删除禁用并提醒 */
    await openMenu(page, '概念库');
    const deleteFull = page.locator('[role="menu"][aria-label="概念库 的目录操作"]').getByRole('menuitem', { name: '删除' });
    check('非空目录删除禁用', (await deleteFull.getAttribute('aria-disabled')) === 'true');
    const fullHint = await deleteFull.textContent();
    check('提醒含计数（1 个子目录、2 个文件）', fullHint.includes('1 个子目录') && fullHint.includes('2 个文件'), fullHint);
    await deleteFull.click({ force: true });
    check('点禁用的删除不弹确认、无回调', (await page.evaluate(() => window.__confirmLog.length)) === 0 && (await events(page)).every((event) => event.type !== 'deleteFolder'));
    await page.keyboard.press('Escape');

    await openMenu(page, '废纸目录');
    const deleteTrashy = page.locator('[role="menu"][aria-label="废纸目录 的目录操作"]').getByRole('menuitem', { name: '删除' });
    const trashyHint = await deleteTrashy.textContent();
    check('废纸篓资源计入内容并提醒', (await deleteTrashy.getAttribute('aria-disabled')) === 'true' && trashyHint.includes('含废纸篓项'), trashyHint);
    await page.keyboard.press('Escape');

    /* 7. 空目录删除：二次确认 */
    await openMenu(page, '空目录');
    const deleteEmpty = page.locator('[role="menu"][aria-label="空目录 的目录操作"]').getByRole('menuitem', { name: '删除' });
    check('空目录删除可用', (await deleteEmpty.getAttribute('aria-disabled')) === null);
    await page.evaluate(() => { window.__confirmNext = false; });
    await deleteEmpty.click();
    const confirmLog = await page.evaluate(() => window.__confirmLog.slice());
    check('第一次确认弹出且文案说明目录名与不可撤销', confirmLog.length === 1 && confirmLog[0].includes('「空目录」') && confirmLog[0].includes('空') && confirmLog[0].includes('无法撤销'), JSON.stringify(confirmLog));
    check('取消确认不删除', (await events(page)).every((event) => event.type !== 'deleteFolder') && (await moreOf(page, '空目录').count()) === 1);
    await page.evaluate(() => { window.__confirmNext = true; });
    await page.keyboard.press('Escape');
    await openMenu(page, '空目录');
    await page.locator('[role="menu"][aria-label="空目录 的目录操作"]').getByRole('menuitem', { name: '删除' }).click();
    await page.waitForTimeout(60);
    check('确认后回调 deleteFolder 且行消失', JSON.stringify((await events(page)).at(-1)) === JSON.stringify({ type: 'deleteFolder', id: 'empty' }) && (await moreOf(page, '空目录').count()) === 0, JSON.stringify((await events(page)).at(-1)));

    /* 8. 笔记本：画布内容经 hasCanvasContent 计入 */
    await openMenu(page, '空本');
    const bookMenu = page.locator('[role="menu"][aria-label="空本 的目录操作"]');
    check('空笔记本（画布无节点）删除可用', (await bookMenu.getByRole('menuitem', { name: '删除' }).getAttribute('aria-disabled')) === null);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__setCanvas(true));
    await page.waitForTimeout(60);
    await openMenu(page, '空本');
    const deleteBook = page.locator('[role="menu"][aria-label="空本 的目录操作"]').getByRole('menuitem', { name: '删除' });
    check('画布有节点时笔记本删除禁用', (await deleteBook.getAttribute('aria-disabled')) === 'true' && (await deleteBook.textContent()).includes('画布上还有内容'));
    const confirmCountBeforeCanvas = await page.evaluate(() => window.__confirmLog.length);
    await deleteBook.click({ force: true });
    check('画布非空不弹确认', (await page.evaluate(() => window.__confirmLog.length)) === confirmCountBeforeCanvas);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__setCanvas(false));
    await page.waitForTimeout(60);

    /* 9. 系统根与默认笔记本保护 + 不可编辑态 */
    await openMenu(page, '我的资料');
    const deleteRoot = page.locator('[role="menu"][aria-label="我的资料 的目录操作"]').getByRole('menuitem', { name: '删除' });
    check('系统根目录删除禁用并说明', (await deleteRoot.getAttribute('aria-disabled')) === 'true' && (await deleteRoot.textContent()).includes('根目录不可删除'));
    await page.keyboard.press('Escape');
    await openMenu(page, '数学本');
    const deleteDefault = page.locator('[role="menu"][aria-label="数学本 的目录操作"]').getByRole('menuitem', { name: '删除' });
    check('默认笔记本删除禁用并说明', (await deleteDefault.getAttribute('aria-disabled')) === 'true' && (await deleteDefault.textContent()).includes('默认笔记本'));
    await page.keyboard.press('Escape');
    // 最后一本笔记本：移走空本后，数学本即使同时是默认本也按「最后一本」提醒（此时无从先换默认本）。
    await page.evaluate(() => window.__removeEmptyBook());
    await page.waitForTimeout(60);
    await openMenu(page, '数学本');
    const deleteLastBook = page.locator('[role="menu"][aria-label="数学本 的目录操作"]').getByRole('menuitem', { name: '删除' });
    check('最后一本笔记本删除禁用并说明（优先于默认本提醒）', (await deleteLastBook.getAttribute('aria-disabled')) === 'true' && (await deleteLastBook.textContent()).includes('最后一本'), await deleteLastBook.textContent());
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__setCanEdit(false));
    await page.waitForTimeout(60);
    check('只读态树行不可拖拽', (await page.locator('.tree-row.tree-file').first().getAttribute('draggable')) === 'false');
    const moreDisabled = page.locator('[aria-label="向量空间.md的更多操作"]');
    check('不可编辑态：更多按钮禁用，菜单打不开', await moreDisabled.isDisabled() && (await moreDisabled.click({ force: true }).then(() => page.locator('[role="menu"]').count(), () => 0)) === 0);
    await page.evaluate(() => window.__setCanEdit(true));
    await page.waitForTimeout(60);

    /* 10. 菜单开合：外点与 Escape */
    await openMenu(page, '我的资料');
    await page.click('button[aria-label="打开 向量空间.md"]');
    check('点击树内其他行关闭菜单', (await page.locator('[role="menu"]').count()) === 0);
    await openMenu(page, '我的资料');
    await page.keyboard.press('Escape');
    check('Escape 关闭菜单', (await page.locator('[role="menu"]').count()) === 0);

    /* 12. 回退目录保护 / 菜单初始焦点 / 重命名切换目标不丢值 */
    await openMenu(page, '未归属去处');
    const deleteFallback = page.locator('[role="menu"][aria-label="未归属去处 的目录操作"]').getByRole('menuitem', { name: '删除' });
    check('回退目录（initialParent 去处，id=notes）删除禁用并说明后果', (await deleteFallback.getAttribute('aria-disabled')) === 'true' && (await deleteFallback.textContent()).includes('默认去处'), await deleteFallback.textContent());
    await page.keyboard.press('Escape');
    await openMenu(page, '概念库');
    const firstFocus = await page.evaluate(() => { const item = document.activeElement; return item?.getAttribute('role') === 'menuitem' && item.getAttribute('aria-disabled') === null ? 'enabled-first' : 'not-first-enabled'; });
    check('菜单初始焦点落在第一个可用项（不是禁用项）', firstFocus === 'enabled-first', firstFocus);
    await page.keyboard.press('Escape');
    await openMenu(page, '引用.svg');
    const refFocus = await page.evaluate(() => { const item = document.activeElement; return item?.getAttribute('role') === 'menuitem' ? (item.getAttribute('aria-disabled') === 'true' ? 'disabled-fallback' : 'enabled') : 'none'; });
    check('全禁用菜单退回首项（仍可聚焦并带 title 说明）', refFocus === 'disabled-fallback', refFocus);
    await page.keyboard.press('Escape');
    // A2：重命名编辑中直接点另一行的更多按钮——pointerdown 捕获先提交旧编辑，不静默丢值。
    await openMenu(page, '子目录');
    await page.locator('[role="menu"][aria-label="子目录 的目录操作"]').getByRole('menuitem', { name: '重命名' }).click();
    const renameInput = page.locator('.tree-rename-input');
    await renameInput.waitFor({ state: 'visible' });
    await renameInput.fill('子目录改名');
    await page.evaluate(() => { window.__events.length = 0; });
    await page.click('[aria-label="废纸目录的更多操作"]');
    await page.waitForTimeout(60);
    const flushEvents = await events(page);
    check('重命名切换目标：旧编辑先提交（不静默丢失）', flushEvents.some(e => e.type === 'renameFolder' && e.id === 'child' && e.name === '子目录改名'), JSON.stringify(flushEvents));
    check('旧编辑提交后菜单照常切到新目标', await page.locator('[role="menu"][aria-label="废纸目录 的目录操作"]').isVisible());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
    check('提交后树标签更新为新目录名', await page.locator('button[aria-label="子目录改名 文件夹"]').count() === 1);

    /* 13. 异步只读门禁与目标消失：菜单/行内编辑必须收起（agy 报告 #1/#2） */
    // #1 菜单 portal 到 .app-shell 末尾，与 .persistence-gate 同为 z-index 80、DOM 序在后，
    // 所以只把更多按钮置 disabled 不够：已打开的菜单会浮在门禁遮罩上并穿透 inert 仍可点。
    await openMenu(page, '我的资料');
    check('#1 前置：菜单确实打开', (await page.locator('[role="menu"]').count()) === 1);
    await page.evaluate(() => window.__setCanEdit(false));
    await page.waitForTimeout(60);
    check('#1 进入只读：已打开的菜单被收起（不叠在门禁遮罩上）', (await page.locator('[role="menu"]').count()) === 0);
    // 行内重命名在只读切换时同样收起，不留可编辑但 inert 的残留态。
    await page.evaluate(() => window.__setCanEdit(true));
    await page.waitForTimeout(60);
    await openMenu(page, '废纸目录');
    await page.locator('[role="menu"][aria-label="废纸目录 的目录操作"]').getByRole('menuitem', { name: '重命名' }).click();
    await page.locator('.tree-rename-input').waitFor({ state: 'visible' });
    await page.evaluate(() => { window.__events.length = 0; });
    await page.evaluate(() => window.__setCanEdit(false));
    await page.waitForTimeout(60);
    check('#1 进入只读：行内重命名收起且不误提交', (await page.locator('.tree-rename-input').count()) === 0 && (await events(page)).length === 0,
      'renameInputs=' + (await page.locator('.tree-rename-input').count()) + ' events=' + JSON.stringify(await events(page)));
    await page.evaluate(() => window.__setCanEdit(true));
    await page.waitForTimeout(60);

    // #2 目标在菜单打开期间消失（外部刷新移除目录 / 被移入废纸篓）时收起菜单；
    // 判断放在 effect 里，渲染期不再 setState，也不会把过期目标画到屏幕上。
    await openMenu(page, '子目录改名');
    await page.evaluate(() => window.__removeFolder('child'));
    await page.waitForTimeout(60);
    check('#2 目录被外部移除：菜单收起且目标行消失', (await page.locator('[role="menu"]').count()) === 0 && (await page.locator('button[aria-label="子目录改名 文件夹"]').count()) === 0);
    await openMenu(page, '向量空间.md');
    check('#2 前置：文件菜单确实打开', (await page.locator('[role="menu"]').count()) === 1);
    await page.evaluate(() => window.__trashResource('note-a'));
    await page.waitForTimeout(60);
    check('#2 文件被移入废纸篓：菜单收起（不再显示「引用文件」的误导说明）', (await page.locator('[role="menu"]').count()) === 0 && (await page.locator('button[aria-label="打开 向量空间.md"]').count()) === 0);

    /* 11. 干净的控制台与网络 */
    check('无控制台错误 / 页面异常 / 失败请求', problems.length === 0, problems.join(' | '));

    console.log(`\\n${checks - failures}/${checks} checks passed`);
    return failures;
  } catch (error) {
    check('套件执行完成', false, error.stack || error.message);
    return failures;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

process.exit(await main() === 0 ? 0 : 1);
