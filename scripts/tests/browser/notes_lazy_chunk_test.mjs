/* #302 方案A：懒分块验收。真组合产物 + 真 notes HTTP/临时 HOME，不接真实 DSH、模型或用户配置。
   ①学习首屏零分块请求且学习功能照常；②首次打开笔记恰一次分块请求、往返保活不重拉；
   ③失败/重试有明确状态不静默回退；旧宿主没有 require.async 也一样（学习面完全不受影响）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, buildFormalNotesClient, loadNotesPlaywright, isMissingEdge, startNotesHostFixture,
} from '../fixtures/notes_host_fixture.mjs';

const OUT = path.join(ROOT, '.preview', 'notes-lazy-chunk');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 父 agent 已完成正式 dist 构建；默认保留正式脚本自带构建，rerun 可用环境变量复用 dist。
const SKIP_BUILD = ['0', 'false', 'no'].includes(String(process.env.STUDYMATE_NOTES_BROWSER_BUILD || '1').toLowerCase());
if (!SKIP_BUILD) buildFormalNotesClient();

const notes = page => page.locator('.app-shell');
async function ready(page) {
  await notes(page).locator('.react-flow').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.persistence-gate'), null, { timeout: 15000 });
}

const playwright = await loadNotesPlaywright();
const { chromium } = playwright.default || playwright;
let browser;
try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (error) {
  if (!isMissingEdge(error)) throw error;
  console.error('跳过 notes-lazy-chunk：缺 Microsoft Edge；退出码 3，不算通过。\n' + error.message); process.exit(3);
}

async function scenario(label, fn, { asyncDisabled = false } = {}) {
  let fixture, context;
  const problems = [], expectedChunkErrors = [];
  try {
    fixture = await startNotesHostFixture({ build: false, asyncDisabled });
    context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await context.newPage();
    let navigating = false;
    page.on('pageerror', error => problems.push('pageerror: ' + (error.stack || error.message)));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const location = message.location().url || '';
      // 注入的 503 会让浏览器记一条脚本资源错误；只分类这条，不吞 JS 异常。
      if (/client\.notes\.js/.test(location) && /^Failed to load resource:/.test(message.text())) expectedChunkErrors.push({ location, text: message.text() });
      else problems.push('console: ' + message.text());
    });
    page.on('response', response => {
      if (response.status() >= 400 && !/client\.notes\.js/.test(response.url())) problems.push(`HTTP ${response.status()} ${response.url()}`);
    });
    page.on('requestfailed', request => {
      if (navigating && request.url().endsWith('/plugins/studymate/events') && /ERR_ABORTED/.test(request.failure()?.errorText || '')) return;
      // 注入的 503 会让浏览器把分块脚本请求记成 ERR_ABORTED——这是注入的本意，不算问题。
      if (/client\.notes\.js/.test(request.url()) && (fixture.controls.chunkFailures > 0 || fixture.chunkRequests.some(r => (r.status || 0) >= 400))) return;
      problems.push('requestfailed: ' + request.url() + ' ' + (request.failure()?.errorText || ''));
    });
    page.on('request', request => {
      const url = request.url();
      if (/^(data|blob|about):/.test(url)) return;
      if (!url.startsWith(fixture.origin + '/')) problems.push('external: ' + url);
    });
    await fn({ fixture, page });
    assert.equal(problems.length, 0, problems.join('\n'));
    assert.equal(fixture.problems.length, 0, fixture.problems.join('\n'));
    assert.ok(expectedChunkErrors.length <= fixture.chunkRequests.filter(r => r.status >= 400).length, '未预期的分块加载控制台错误');
    results.push({ label, ok: true }); console.log('PASS  ' + label);
  } catch (error) {
    results.push({ label, ok: false, detail: String(error.stack || error), problems, serverProblems: fixture?.problems });
    console.error('FAIL  ' + label + '\n' + (error.stack || error));
  } finally {
    if (context) await context.close();
    if (fixture) await fixture.close();
  }
}

try {
  await scenario('学习首屏零分块请求：注册面完整、进入课件页照常', async ({ fixture, page }) => {
    await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-proto="brand-switch"]').waitFor({ state: 'visible', timeout: 15000 });
    await delay(400);
    assert.equal(fixture.chunkRequests.length, 0, '学习首屏发出了分块请求');
    const probe = await page.evaluate(() => ({
      registrations: window.__probe.registrations,
      chunkRegistrations: window.__probe.chunkRegistrations,
      applied: window.__probe.applied,
    }));
    assert.equal(probe.applied, true, '组合入口没有完成 apply');
    assert.deepEqual(probe.chunkRegistrations, [], 'apply 阶段就登记了分块');
    const main = probe.registrations.find(r => r.name === 'main');
    assert.ok(main, 'main 没有登记');
    assert.deepEqual(Object.keys(main.children || {}), ['studymate.ask.session', 'studymate.notes.session'], 'main 会话座位不对');
    assert.ok(probe.registrations.some(r => r.label === '学习'), '侧栏学习面板没有登记');
    // 学习功能本体：进课件页，正文照常渲染。
    await page.getByText('接着上次').first().click();
    await page.getByText('阅读位置三级恢复').first().waitFor({ timeout: 15000 });
    assert.equal(fixture.chunkRequests.length, 0, '课件页发出了分块请求');
    await page.screenshot({ path: path.join(OUT, 'learning-first-screen.png'), animations: 'disabled' });
  });

  await scenario('首次打开笔记恰一次分块请求；往返保活不重拉、画布不重挂', async ({ fixture, page }) => {
    await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-proto="brand-switch"]').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('[data-proto="brand-switch"]').click();
    await ready(page);
    assert.equal(fixture.chunkRequests.length, 1, '首次打开笔记应恰好一次分块请求');
    assert.equal(fixture.chunkRequests[0].path, '/client.notes.js');
    assert.equal(fixture.chunkRequests[0].status, 200);
    assert.deepEqual(await page.evaluate(() => window.__probe.chunkRegistrations), ['client.notes.js']);
    // 画布草稿：纯内容节点；往返后必须原样还在（不重挂、不重下载）。
    await notes(page).getByRole('button', { name: '添加纯内容节点', exact: true }).click();
    await notes(page).getByRole('textbox', { name: '纯节点内容', exact: true }).fill('LAZY-KEEPALIVE-CANARY');
    await page.keyboard.press('Control+Enter');
    await notes(page).locator('.text-node-content', { hasText: 'LAZY-KEEPALIVE-CANARY' }).waitFor({ timeout: 15000 });
    await page.locator('[data-proto="brand-switch"]').click();
    await page.getByText('接着上次').first().waitFor({ timeout: 15000 });
    await page.locator('[data-proto="brand-switch"]').click();
    await ready(page);
    assert.equal(fixture.chunkRequests.length, 1, '往返之后重新下载了分块');
    assert.equal(await notes(page).locator('.text-node-content', { hasText: 'LAZY-KEEPALIVE-CANARY' }).count(), 1, '往返后画布被重挂，草稿丢了');
    await page.screenshot({ path: path.join(OUT, 'notes-after-roundtrip.png'), animations: 'disabled' });
  });

  await scenario('分块失败有明确错误态与重试：重试成功后恰两次请求、零 pageerror', async ({ fixture, page }) => {
    fixture.controls.chunkFailures = 1;
    await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-proto="brand-switch"]').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('[data-proto="brand-switch"]').click();
    const gate = page.locator('.studymate-notes-chunk-gate[role="alert"]');
    await gate.waitFor({ timeout: 15000 });
    assert.ok((await gate.innerText()).includes('无界笔记加载失败'), '失败态文案缺失');
    assert.equal(fixture.chunkRequests.length, 1);
    assert.equal(fixture.chunkRequests[0].status, 503);
    assert.equal(await notes(page).locator('.app-shell').count(), 0, '失败时不得渲染笔记组件');
    fixture.controls.chunkFailures = 0;
    await gate.getByRole('button', { name: '重试', exact: true }).click();
    await ready(page);
    assert.equal(fixture.chunkRequests.length, 2, '重试后应恰两次分块请求');
    assert.equal(fixture.chunkRequests[1].status, 200);
  });

  await scenario('旧宿主没有 require.async：学习面照常，笔记明确失败、不静默回退、零请求', async ({ fixture, page }) => {
    await page.addInitScript(() => { window.__fixtureLocale = 'en'; });
    await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-proto="brand-switch"]').waitFor({ state: 'visible', timeout: 15000 });
    await delay(300);
    assert.equal(fixture.chunkRequests.length, 0);
    await page.locator('[data-proto="brand-switch"]').click();
    const gate = page.locator('.studymate-notes-chunk-gate[role="alert"]');
    await gate.waitFor({ timeout: 15000 });
    assert.ok((await gate.innerText()).includes('require.async 缺失'), '旧宿主能力缺失要有明确文案');
    assert.ok((await gate.innerText()).includes('Unbounded notes could not be loaded'));
    assert.equal(await gate.getByRole('button').innerText(), 'Retry');
    await page.evaluate(() => window.__probe.locale.switchTo('zh'));
    await gate.getByRole('button', { name: '重试', exact: true }).waitFor();
    assert.ok((await gate.innerText()).includes('无界笔记加载失败'));
    assert.equal(await page.evaluate(() => window.__probe.locale.writes), 0);
    assert.equal(fixture.chunkRequests.length, 0, '没有 require.async 还试图拉分块');
    // 学习面完全不受影响：切回学习、进课件页照常。
    await page.locator('[data-proto="brand-switch"]').click();
    await page.getByText('接着上次').first().waitFor({ timeout: 15000 });
    await page.getByText('接着上次').first().click();
    await page.getByText('阅读位置三级恢复').first().waitFor({ timeout: 15000 });
    assert.equal(fixture.chunkRequests.length, 0);
  }, { asyncDisabled: true });
} finally {
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'lazy-chunk-browser-report.json'), JSON.stringify({ checks: results.length, failures: results.filter(r => !r.ok).length, results }, null, 2));
}
console.log(`\n${results.filter(r => r.ok).length}/${results.length} 懒分块场景通过`);
if (results.some(r => !r.ok)) process.exitCode = 1;
