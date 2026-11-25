/* 宿主 main 卸载 → 同一标签重进：无界笔记面、同篇文档与按篇模式、学习位置。

   为什么不能只点品牌切换：`[data-proto="brand-switch"]` 是同一个 main 里的两个面互换，
   笔记 Board 只是隐藏、不卸载（lib/client.js 的 `.smb-surface--notes`）。ADR-0022 要的
   「退出学习后重进」是宿主把 main 组件整个卸掉，再在同一个标签里挂回来——品牌切换测不到
   这条链路。夹具自带的 index.html 只暴露一次挂载，所以本套件把一页最小的宿主壳写进
   fixture 的临时目录，由同一个 origin 提供：加载 `/client.js` 并调用 `factory(require).apply(ctx)`
   一次，按需加载 `/client.notes.js`，取出 `spec.name === 'main'` 的注册，再用
   `ReactDOMClient.createRoot(...).unmount()` 卸载、`createRoot(...).render(...)` 重挂。
   apply 只发生一次：重进复用的是同一个插件实例、同一个工厂闭包，和宿主换会话时一样。

   覆盖（第一条场景）：
   - 两篇独立文档，各自切到不同的文档视图模式；
   - 同标签退出到宿主聊天（真 main 卸载：DOM 清空、React root 置空、插件不重新 apply），
     重进后自动回到笔记面、同一篇文档、同一模式；另一篇的模式不被带走；
   - 活动笔记本：在第二本笔记本里放一张卡片，退出重进后画布仍停在那本、卡片仍在；
   - 学习面：进入 demo 科目的一课，退出重进后仍回到那一课（surface/科目/节点位置）。
   覆盖（第二条场景）：
   - 保存请求已到服务器、仍被夹具扣住时退出，重进后先看到未落盘草稿，再放行并落盘。

   不覆盖（如实说明）：
   - 失败 / 409 / 在途重试的细节由 `notes_persistence_session_test.mjs` 在 hook 层覆盖；
     本套件只走真实 bridge + App 接线。
   - 工作区不串：夹具一次只喂一个 `library.workspace`，中途换工作区需要另造推送/刷新路径，
     会改动夹具；这里不声称覆盖，留给后续套件。
   - 文档模式本身的行为（行号、滚动、局部显形）由组件层套件覆盖；这里只断「按篇恢复」。

   运行：缺 Microsoft Edge 退出码 3；STUDYMATE_NOTES_BROWSER_BUILD=0 跳过 dist 重建
   （协调构建窗口时必须带上，避免在别人跑集成时改 dist）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import {
  ROOT, buildFormalNotesClient, loadNotesPlaywright, isMissingEdge,
  installNotesFixtureModuleLoader, startNotesHostFixture,
} from '../fixtures/notes_host_fixture.mjs';

const results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(50); }
  throw new Error(message);
}
const SKIP_BUILD = ['0', 'false', 'no'].includes(String(process.env.STUDYMATE_NOTES_BROWSER_BUILD || '1').toLowerCase());
if (!SKIP_BUILD) buildFormalNotesClient();

// 宿主壳：和 notes_host_fixture.mjs 的 HOST_SOURCE 同一套服务桩，但把 main 的挂/卸
// 做成显式按钮（按钮在 React 树外，卸载不会把按钮一起卸掉）。
const HOST_SOURCE = `
import React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';

const registrations = [];
const cleanups = [];
let applied = false;
let brandClicks = 0;
const EMPTY = Object.freeze({ byId: Object.freeze({}), order: Object.freeze([]) });
const services = {
  slots: {
    inject(_name, task) { task(); return () => {}; },
    register(spec, component) { registrations.push({ spec, component }); return () => {}; },
  },
  sessions: { list: { subscribe() { return () => {}; }, getSnapshot() { return EMPTY; } } },
  inputTriggers: { registerSource() { return () => {}; } },
  conversation: { input: { for() { throw new Error('夹具没有显式会话'); } } },
  layout: { selectPanel() {} },
};
const moduleLoader = (${installNotesFixtureModuleLoader.toString()})({
  react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient,
});
document.addEventListener('click', event => {
  const target = event.target;
  if (target && target.closest && target.closest('[data-proto="brand-switch"]')) brandClicks += 1;
}, true);

const host = {
  mountCount: 0,
  unmountCount: 0,
  applied: false,
  main: null,
  root: null,
  start() {
    if (!moduleLoader.entry) throw new Error('组合产物没有登记模块');
    moduleLoader.entry.factory(moduleLoader.require).apply({
      ...services,
      get(name) { return services[name]; },
      effect(task) { const cleanup = task(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
    });
    applied = true;
    const main = registrations.find(item => item.spec.name === 'main');
    if (!main) throw new Error('组合产物没有登记 main');
    this.main = main;
    this.mount();
  },
  mount() {
    if (!this.main) throw new Error('main 没有注册');
    document.getElementById('host-chat').hidden = true;
    const container = document.getElementById('host-main');
    container.hidden = false;
    this.root = ReactDOMClient.createRoot(container);
    this.root.render(React.createElement(this.main.component, {
      SessionProvider: ({ children }) => children,
      renderSlot: () => null,
      renderFactorySlot: () => null,
    }));
    this.mountCount += 1;
  },
  exitToChat() {
    if (!this.root) throw new Error('main 没有挂载');
    this.root.unmount();
    this.root = null;
    document.getElementById('host-main').hidden = true;
    document.getElementById('host-chat').hidden = false;
    this.unmountCount += 1;
  },
  reenter() { this.mount(); },
  probe() {
    return {
      applied,
      mountCount: this.mountCount,
      unmountCount: this.unmountCount,
      mainMounted: Boolean(this.root),
      brandClicks,
    };
  },
};
document.getElementById('exit-to-chat').addEventListener('click', () => host.exitToChat());
document.getElementById('reenter').addEventListener('click', () => host.reenter());
window.__host = host;
`;

const HOST_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<title>StudyMate 宿主重进夹具</title>
<style>
html, body { height: 100%; margin: 0; }
body { background: #f6f7f9; color: #1b1f27; font: 13px/1.4 system-ui, sans-serif; }
#host { display: flex; flex-direction: column; height: 100%; }
#host-chrome { flex: 0 0 34px; display: flex; align-items: center; gap: 10px; padding: 0 12px; background: #1f2937; color: #fff; }
#host-chrome strong { font-size: 12px; font-weight: 600; }
#host-chrome button { margin-left: auto; border: 1px solid #6b7280; border-radius: 4px; background: #111827; color: #fff; padding: 3px 9px; cursor: pointer; }
#host-main { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
#host-main[hidden], #host-chat[hidden] { display: none; }
#host-chat { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
#host-chat h1 { margin: 0; font-size: 18px; }
#host-chat p { margin: 0; color: #4d5666; }
#host-chat button { border: 1px solid #1c7164; border-radius: 4px; background: #1c7164; color: #fff; padding: 6px 14px; cursor: pointer; }
</style>
</head>
<body>
<div id="host">
  <div id="host-chrome"><strong>宿主外壳（不在插件 main 里）</strong><button id="exit-to-chat" type="button">退出学习，回到宿主聊天</button></div>
  <div id="host-main"></div>
  <section id="host-chat" hidden>
    <h1>宿主聊天</h1>
    <p data-proto="host-chat-body">学习面板已从宿主 main 容器卸载。</p>
    <button id="reenter" type="button">重进学习</button>
  </section>
</div>
<script src="/reentry.host.js"></script>
<script src="/client.js"></script>
<script>window.__host.start()</script>
</body>
</html>`;

let hostScriptPromise = null;
function browserHostScript() {
  if (!hostScriptPromise) {
    hostScriptPromise = esbuild.build({
      absWorkingDir: ROOT,
      stdin: { contents: HOST_SOURCE, resolveDir: ROOT, sourcefile: 'notes-host-reentry-host.js' },
      bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
      define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    }).then(result => result.outputFiles[0].text);
  }
  return hostScriptPromise;
}

async function writeHostPage(fixture) {
  const script = await browserHostScript();
  fs.writeFileSync(path.join(fixture.dir, 'reentry.host.js'), script);
  fs.writeFileSync(path.join(fixture.dir, 'reentry.html'), HOST_HTML);
}

const notes = page => page.locator('.smb-surface--notes');
const inlineEditor = page => notes(page).locator('.document-stage .note-editor .markdown-inline-editor .cm-content[role="textbox"]');
const editorText = page => inlineEditor(page).first().evaluate(element => element.textContent || '');

async function badge(page) {
  return (await notes(page).locator('.persistence-badge').first().getAttribute('data-state')) || '';
}
async function saved(page) { await notes(page).locator('.persistence-badge[data-state="saved"]').waitFor({ timeout: 15000 }); }
async function waitBadge(page, states, message, timeout = 15000) {
  await until(async () => states.includes(await badge(page)), message, timeout);
}
async function ready(page) {
  // 文档视图里画布 stage 是 visibility:hidden，Playwright 的默认 visible 会等不到；
  // 这里只要求画布已挂载、加载闸门已消失、保存徽标已 saved。
  await notes(page).locator('.react-flow').waitFor({ state: 'attached', timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.smb-surface--notes .persistence-gate'), null, { timeout: 15000 });
  await saved(page);
}
async function currentTitle(page) {
  const input = notes(page).locator('input[aria-label="文档标题"]');
  if (await input.count()) return input.inputValue();
  return (await notes(page).locator('.document-title').first().textContent()) || '';
}
async function body(page, text) {
  const editor = inlineEditor(page);
  await editor.waitFor({ state: 'visible', timeout: 12000 });
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
}
async function openNotesMenu(page) {
  await notes(page).locator('.notes-create-trigger').click();
  await notes(page).locator('[role="menu"][aria-label="新建资源"]').waitFor({ state: 'visible', timeout: 5000 });
}
async function createViaMenu(page, kind, name) {
  const label = { notebook: '新建笔记本', folder: '新建文件夹', note: '新建笔记' }[kind];
  await openNotesMenu(page);
  await notes(page).getByRole('menuitem', { name: label, exact: true }).click();
  const dialog = notes(page).locator(`[role="dialog"][aria-label="${label}"]`);
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  await dialog.getByRole('textbox', { name: kind === 'note' ? '笔记名称' : kind === 'notebook' ? '笔记本名称' : '文件夹名称' }).fill(name);
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  await delay(250);
}
async function createNote(page, fixture, name, text) {
  const before = new Set(Object.keys(fixture.read().resources));
  const same = resource => String(resource.markdown || '').trim() === text.trim();
  await createViaMenu(page, 'note', name);
  await body(page, text);
  await until(() => Object.values(fixture.read().resources).some(same), '新笔记没有真实保存', 20000);
  await saved(page);
  const resource = Object.values(fixture.read().resources).find(item => !before.has(item.id) && same(item));
  assert.ok(resource, '没有找到刚创建的笔记');
  return resource;
}
async function createNotebook(page, fixture, name) {
  const before = new Set((fixture.read().layout?.folders || []).map(folder => folder.id));
  await createViaMenu(page, 'notebook', name);
  await until(() => (fixture.read().layout?.folders || []).some(folder => !before.has(folder.id) && folder.name === name), '笔记本没有真实保存');
  await saved(page);
  return (fixture.read().layout.folders || []).find(folder => folder.name === name && folder.kind === 'notebook');
}
async function openFromTree(page, title) {
  const button = notes(page).locator(`button[aria-label="打开 ${title}"]`).first();
  await button.waitFor({ state: 'visible', timeout: 12000 });
  await button.click();
  await until(async () => (await currentTitle(page)).includes(title.replace(/\.md$/, '')), '文件没有打开：' + title);
  await saved(page);
}
const modeGroup = page => notes(page).locator('[aria-label="文档视图模式"]');
async function pickMode(page, label) {
  const group = modeGroup(page);
  await group.waitFor({ state: 'visible', timeout: 12000 });
  const button = group.getByRole('button', { name: label, exact: true });
  await button.click();
  await until(async () => (await button.getAttribute('aria-pressed')) === 'true', '文档模式没有切到 ' + label);
  await delay(320);
}
async function currentMode(page) {
  const pressed = modeGroup(page).locator('button[aria-pressed="true"]');
  return ((await pressed.first().textContent()) || '').trim();
}
async function documentScrollClass(page) {
  return (await notes(page).locator('.document-scroll').first().getAttribute('class')) || '';
}
async function brandClicks(page) {
  return (await page.evaluate(() => window.__host.probe())).brandClicks;
}
async function probe(page) { return page.evaluate(() => window.__host.probe()); }
async function waitMount(page, mountCount, unmountCount) {
  await page.waitForFunction(([mounted, unmounted]) => {
    const state = window.__host.probe();
    return state.mountCount === mounted && state.unmountCount === unmounted;
  }, [mountCount, unmountCount], { timeout: 15000 });
}
async function assertMounted(page, mountCount) {
  const state = await probe(page);
  assert.equal(state.mainMounted, true, 'main 没有挂载');
  assert.equal(state.mountCount, mountCount, '挂载次数不对');
  assert.equal(await page.locator('#host-main .smb-root').count(), 1, '宿主 main 容器里没有真实 smb-root');
}
async function exitToChat(page, unmountCount) {
  await page.locator('#exit-to-chat').click();
  await waitMount(page, unmountCount, unmountCount);
  const state = await probe(page);
  assert.equal(state.mainMounted, false, 'main 仍然挂载');
  assert.equal(state.unmountCount, unmountCount, '卸载次数不对');
  for (const selector of ['.smb-root', '[data-proto="brand-switch"]', '.app-shell', '.react-flow']) {
    assert.equal(await page.locator('#host-main ' + selector).count(), 0, '卸载后宿主 main 里仍有 ' + selector);
  }
  assert.equal((await page.locator('#host-main').innerText()).trim(), '', '卸载后宿主 main 里仍有可见文字');
  assert.equal(await page.locator('#host-main').getAttribute('hidden'), '', '宿主 main 容器没有隐藏');
  assert.ok(await page.locator('#host-chat').isVisible(), '宿主聊天没有出现');
}
async function reenter(page, mountCount, unmountCount) {
  await page.locator('#reenter').click();
  await waitMount(page, mountCount, unmountCount);
  await assertMounted(page, mountCount);
  await page.locator('[data-proto="brand-switch"]').waitFor({ state: 'visible', timeout: 15000 });
}
async function waitNotesLoaded(page) {
  await page.waitForFunction(() => document.querySelector('#host-main .smb-root')?.dataset.surface === 'notes', null, { timeout: 15000 });
  await notes(page).locator('.app-shell').waitFor({ state: 'visible', timeout: 15000 });
  await notes(page).locator('.react-flow').waitFor({ state: 'attached', timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.smb-surface--notes .persistence-gate'), null, { timeout: 15000 });
}
async function waitNotesRestored(page) {
  await waitNotesLoaded(page);
  await saved(page);
}
async function waitLearningRestored(page) {
  await page.waitForFunction(() => document.querySelector('#host-main .smb-root')?.dataset.surface === 'learning', null, { timeout: 15000 });
  await page.locator('[data-proto="learning-surface"]').waitFor({ state: 'visible', timeout: 15000 });
}
async function enterNotes(page) {
  const brand = page.locator('[data-proto="brand-switch"]');
  assert.equal(await brand.getAttribute('data-surface'), 'learning', '初始面不是学习');
  await brand.click();
  await waitNotesRestored(page);
}
async function enterLearning(page) {
  await page.locator('[data-proto="brand-switch"]').click();
  await waitLearningRestored(page);
}
async function openDemoLesson(page) {
  await page.locator('.smb-course').filter({ hasText: '演示科目' }).first().click();
  const card = page.locator('[data-proto="learning-surface"] button[data-node="reading-position"]');
  await card.waitFor({ state: 'visible', timeout: 12000 });
  await card.click();
  await page.locator('.smb-lesson').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('.smb-lesson .smb-doc').waitFor({ state: 'visible', timeout: 15000 });
  await until(async () => ((await page.locator('.smb-crumb--current').first().textContent()) || '').includes('阅读位置三级恢复'), '没有进入 demo 课件');
}

const playwright = await loadNotesPlaywright();
const { chromium } = playwright.default || playwright;
let browser;
try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (error) {
  if (!isMissingEdge(error)) throw error;
  console.error('跳过 notes-host-reentry：缺 Microsoft Edge；退出码 3，不算通过。\n' + error.message);
  process.exit(3);
}

async function scenario(label, fn) {
  let fixture, context;
  const problems = [];
  try {
    fixture = await startNotesHostFixture({ build: false });
    await writeHostPage(fixture);
    context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => problems.push('pageerror: ' + (error.stack || error.message)));
    page.on('console', message => { if (message.type() === 'error') problems.push('console: ' + message.text()); });
    page.on('response', response => { if (response.status() >= 400) problems.push(`HTTP ${response.status()} ${response.url()}`); });
    page.on('requestfailed', request => {
      const error = request.failure()?.errorText || '';
      // EventSource 在页面/上下文收尾时被浏览器中止，不是页面错误。
      if (new URL(request.url()).pathname === '/plugins/studymate/events' && /ERR_ABORTED/.test(error)) return;
      problems.push('requestfailed: ' + request.url() + ' ' + error);
    });
    page.on('request', request => {
      const url = request.url();
      if (/^(data|blob|about):/.test(url)) return;
      if (!url.startsWith(fixture.origin + '/')) problems.push('external: ' + url);
    });
    await page.goto(fixture.origin + '/reentry.html', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-proto="brand-switch"]').waitFor({ state: 'visible', timeout: 15000 });
    await assertMounted(page, 1);
    assert.equal(fixture.chunkRequests.length, 0, '学习首屏不应请求笔记分块');
    await fn({ fixture, page });
    assert.deepEqual(fixture.chunkRequests.map(({ path, status }) => [path, status]), [['/client.notes.js', 200]], '同标签重进不应重新请求笔记分块');
    assert.equal(problems.length, 0, problems.join('\n'));
    assert.equal(fixture.problems.length, 0, fixture.problems.join('\n'));
    results.push({ label, ok: true });
    console.log('PASS  ' + label);
  } catch (error) {
    results.push({ label, ok: false, detail: String(error.stack || error), problems, serverProblems: fixture?.problems });
    console.error('FAIL  ' + label + '\n' + (error.stack || error));
  } finally {
    if (context) await context.close();
    if (fixture) await fixture.close();
  }
}

try {
  await scenario('同标签真卸载 main 后重进：笔记面、同篇文档与按篇模式、活动笔记本、学习课件位置都恢复', async ({ fixture, page }) => {
    await enterNotes(page);

    const docA = await createNote(page, fixture, '甲文档.md', '# 甲文档\n\n甲正文。\n');
    await pickMode(page, '预览');
    assert.equal(await currentMode(page), '预览');
    assert.match(await documentScrollClass(page), /is-preview/);
    assert.equal(await notes(page).locator('.document-stage [data-testid="note-editor"]').getAttribute('data-mode'), 'preview');

    const docB = await createNote(page, fixture, '乙文档.md', '# 乙文档\n\n乙正文。\n');
    await pickMode(page, '双列');
    assert.equal(await currentMode(page), '双列');
    assert.match(await documentScrollClass(page), /is-split/);
    assert.equal(await notes(page).locator('.document-stage [data-testid="note-editor"]').getAttribute('data-mode'), 'split');
    const markdownB = fixture.read().resources[docB.id].markdown;

    // 按篇模式不串：两篇来回打开，各自仍是自己的模式。
    await openFromTree(page, '甲文档.md');
    assert.equal(await currentMode(page), '预览');
    await openFromTree(page, '乙文档.md');
    assert.equal(await currentMode(page), '双列');

    // 真把左右侧栏都收起：它们也是本标签的界面记忆，退出重进后应保持收起。
    await notes(page).getByRole('button', { name: '收起文件侧栏', exact: true }).click();
    await notes(page).locator('.left-panel.is-collapsed').waitFor({ state: 'attached', timeout: 10000 });
    await notes(page).getByRole('button', { name: '收起右侧栏', exact: true }).click();
    await notes(page).locator('.right-panel.is-collapsed').waitFor({ state: 'attached', timeout: 10000 });
    assert.equal(await notes(page).locator('.left-panel').getAttribute('aria-hidden'), 'true');
    assert.equal(await notes(page).locator('.right-panel').getAttribute('aria-hidden'), 'true');
    const clicksBeforeExit = await brandClicks(page);

    await delay(350);
    await exitToChat(page, 1);
    assert.equal(await brandClicks(page), clicksBeforeExit, '退出后品牌点击计数变了');

    await reenter(page, 2, 1);
    await waitNotesRestored(page);
    assert.equal(await brandClicks(page), clicksBeforeExit, '重进笔记面靠的是品牌切换，不是视图记忆');
    await until(async () => (await currentTitle(page)).includes('乙文档'), '重进后没有回到原来那篇文档');
    assert.equal(await currentMode(page), '双列', '重进后按篇模式没有恢复');
    assert.match(await documentScrollClass(page), /is-split/);
    assert.equal(fixture.read().resources[docB.id].markdown, markdownB, '切换模式改写了正文');
    assert.equal(await notes(page).locator('.left-panel.is-collapsed').count(), 1, '重进后左侧栏没有保持收起');
    assert.equal(await notes(page).locator('.right-panel.is-collapsed').count(), 1, '重进后右侧栏没有保持收起');
    await notes(page).getByRole('button', { name: '展开文件侧栏', exact: true }).click();
    await notes(page).locator('.left-panel:not(.is-collapsed)').waitFor({ timeout: 10000 });
    await notes(page).getByRole('button', { name: '展开右侧栏', exact: true }).click();
    await notes(page).locator('.right-panel:not(.is-collapsed)').waitFor({ timeout: 10000 });

    // 另一篇的模式也没被带走。
    await openFromTree(page, '甲文档.md');
    assert.equal(await currentMode(page), '预览');
    await openFromTree(page, '乙文档.md');
    assert.equal(await currentMode(page), '双列');

    // 活动笔记本：换到第二本笔记本，把当前文档的卡片放到那本画布上。
    const notebook = await createNotebook(page, fixture, '重进本');
    await page.getByRole('button', { name: '打开重进本画布', exact: true }).click();
    await page.locator('[aria-label="主视图"]').getByRole('button', { name: '画布', exact: true }).waitFor({ state: 'visible' });
    await until(async () => (await page.locator('[aria-label="主视图"]').getByRole('button', { name: '画布', exact: true }).getAttribute('aria-pressed')) === 'true', '没有切到画布');
    await notes(page).locator('.tree-row.is-notebook.is-active').filter({ hasText: '重进本' }).waitFor({ state: 'visible' });
    const place = page.getByRole('button', { name: '放到画布', exact: true });
    await place.waitFor({ state: 'visible', timeout: 12000 });
    await place.click();
    await notes(page).locator('.react-flow__node').filter({ hasText: '乙文档.md' }).waitFor({ state: 'visible', timeout: 12000 });
    await saved(page);
    await until(() => (fixture.read().layout?.nodes || []).some(node => node.data?.contentId === docB.id && node.data?.notebookId === notebook.id), '卡片没有归到新笔记本');

    await delay(350);
    const clicksBeforeNotebookExit = await brandClicks(page);
    await exitToChat(page, 2);
    assert.equal(await brandClicks(page), clicksBeforeNotebookExit, '退出后品牌点击计数变了');
    await reenter(page, 3, 2);
    await waitNotesRestored(page);
    assert.equal(await brandClicks(page), clicksBeforeNotebookExit, '重进画布靠的是品牌切换，不是视图记忆');
    await until(async () => (await page.locator('[aria-label="主视图"]').getByRole('button', { name: '画布', exact: true }).getAttribute('aria-pressed')) === 'true', '重进后没有回到画布');
    // 树的单高亮同时有 selectedId 时按文件显示，不能拿行高亮当活动本判据；
    // 活动本由画布可见卡与 fixture 里的 notebookId 证明。
    await notes(page).locator('.tree-row.is-notebook').filter({ hasText: '重进本' }).first().waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '适应全部卡片', exact: true }).click();
    await notes(page).locator('.react-flow__node').filter({ hasText: '乙文档.md' }).waitFor({ state: 'visible', timeout: 12000 });

    // 学习面：从笔记面切到学习，进入 demo 的一课，再走同一条卸载/重进链路。
    await enterLearning(page);
    await page.locator('.smb-course').filter({ hasText: '演示科目' }).first().waitFor({ state: 'visible', timeout: 12000 });
    await openDemoLesson(page);
    const clicksBeforeLearningExit = await brandClicks(page);
    await delay(350);
    await exitToChat(page, 3);
    assert.equal(await brandClicks(page), clicksBeforeLearningExit, '退出后品牌点击计数变了');
    await reenter(page, 4, 3);
    await waitLearningRestored(page);
    assert.equal(await brandClicks(page), clicksBeforeLearningExit, '重进学习面靠的是品牌切换，不是视图记忆');
    await page.locator('.smb-lesson').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('.smb-lesson .smb-doc').waitFor({ state: 'visible', timeout: 15000 });
    await until(async () => ((await page.locator('.smb-crumb--current').first().textContent()) || '').includes('阅读位置三级恢复'), '重进后没有回到原来那一课');
    const notesSurface = page.locator('[data-proto="notes-surface"]');
    assert.equal(await notesSurface.getAttribute('data-hidden'), '1', '学习面重进后笔记面没有隐藏');
  });

  await scenario('保存请求在途时真卸载 main：重进先看到草稿，放行后落盘', async ({ fixture, page }) => {
    await enterNotes(page);
    const note = await createNote(page, fixture, '草稿重进.md', '# 草稿重进\n\n初始。\n');
    await pickMode(page, '渲染编辑');
    assert.equal(await currentMode(page), '渲染编辑');

    fixture.controls.pauseWrites = true;
    const marker = '未保存补一句。';
    const draft = '# 草稿重进\n\n初始。\n\n' + marker + '\n';
    await body(page, draft);
    // 等到保存请求真的到了服务器、被夹具扣住：这才叫「在途」，不是 debounce 计时器。
    await until(() => fixture.requests.some(request =>
      request.method === 'POST' && request.status === null
      && request.body?.operation === 'resource'
      && request.body?.resource?.id === note.id
      && String(request.body.resource.markdown || '').includes(marker)), '保存请求没有到达服务器', 20000);
    await waitBadge(page, ['pending', 'saving'], '草稿没有进入待保存状态');
    await delay(250);

    await exitToChat(page, 1);
    // 写请求仍在夹具里扣着；重进后先看内存里的草稿。此时不能等 saved 徽标——
    // 在途保存本来就不是 saved，等它会把「草稿恢复」误判成超时。
    await reenter(page, 2, 1);
    await waitNotesLoaded(page);
    await until(async () => (await currentTitle(page)).includes('草稿重进'), '重进后没有回到草稿那篇文档');
    await inlineEditor(page).waitFor({ state: 'visible', timeout: 12000 });
    await until(async () => (await editorText(page)).includes(marker), '重进后没有恢复未落盘草稿');
    assert.notEqual(await badge(page), 'saved', '写请求还在扣着，徽标却显示已保存');

    fixture.controls.releaseWrites();
    await saved(page);
    await until(() => String(fixture.read().resources[note.id].markdown).includes(marker), '放行后草稿没有落盘');
  });
} finally {
  await browser.close();
}

const failed = results.filter(result => !result.ok);
if (failed.length) {
  console.error(`\nnotes-host-reentry：${failed.length}/${results.length} 个场景失败`);
  for (const failure of failed) {
    console.error('\n--- ' + failure.label + ' ---\n' + failure.detail);
    if (failure.problems?.length) console.error('页面问题：\n' + failure.problems.join('\n'));
    if (failure.serverProblems?.length) console.error('夹具问题：\n' + failure.serverProblems.join('\n'));
  }
  process.exit(1);
}
console.log(`\nnotes-host-reentry：${results.length} 个场景通过`);
