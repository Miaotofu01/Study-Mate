// #303：正式组合客户端 + 真 React/notes HTTP，独立 Edge、临时 HOME。
// 用调用计数与请求行为断言性能边界，不把机器耗时阈值当正确性。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, buildFormalNotesClient, loadNotesPlaywright, isMissingEdge, startNotesHostFixture, enterNotes } from '../fixtures/notes_host_fixture.mjs';

const OUT = path.join(ROOT, '.preview', 'notes-performance');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(40); }
  throw new Error('等待超时：' + label);
}
const board = page => page.locator('.studymate-notes .app-shell');
const gets = fixture => fixture.requests.filter(request => request.method === 'GET').length;
async function saved(page) { await board(page).locator('.persistence-badge[data-state="saved"]').waitFor({ timeout: 15000 }); }
async function scenario(label, run) {
  try { await run(); results.push({ label, ok: true }); console.log('PASS ' + label); }
  catch (error) { results.push({ label, ok: false, error: error.stack || String(error) }); console.error('FAIL ' + label + '\n' + (error.stack || error)); }
}

async function main() {
  if (!['0', 'false', 'no'].includes(String(process.env.STUDYMATE_NOTES_BROWSER_BUILD || '1').toLowerCase())) buildFormalNotesClient();
  const playwright = await loadNotesPlaywright();
  const { chromium } = playwright.default || playwright;
  let browser;
  try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  catch (error) { if (isMissingEdge(error)) { console.error('SKIP: 缺少 Microsoft Edge：' + error.message); process.exitCode = 3; return; } throw error; }
  let fixture, context;
  const problems = [];
  try {
    fixture = await startNotesHostFixture({ build: false, seedDemo: true });
    context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' });
    const page = await context.newPage();
    page.on('pageerror', error => problems.push('pageerror: ' + error.message));
    page.on('console', message => { if (message.type() === 'error') problems.push('console: ' + message.text()); });
    page.on('requestfailed', request => problems.push('requestfailed: ' + request.url()));
    page.on('request', request => { if (!request.url().startsWith(fixture.origin + '/') && !/^(data:|blob:)/.test(request.url())) problems.push('external: ' + request.url()); });
    page.on('response', response => { if (response.status() >= 400) problems.push('HTTP ' + response.status() + ': ' + response.url()); });
    // fingerprintOf 是递归 stableStringify：最终逐个 stringify 原始字段，而非整个 DTO。
    // 只监测已知笔记全文字符串；不统计布局/版本表/DOM 的一般 stringify。
    const bodies = Object.values(fixture.read().resources).filter(resource => resource.type === 'note')
      .map(resource => [resource.markdown, resource.id]);
    assert.ok(bodies.length >= 2);
    await page.addInitScript(entries => {
      const bodyIds = new Map(entries), stringify = JSON.stringify;
      window.__resourceSerializationProbe = { calls: [], reset() { this.calls.length = 0; } };
      JSON.stringify = function(value, ...args) {
        if (typeof value === 'string' && bodyIds.has(value)) window.__resourceSerializationProbe.calls.push(bodyIds.get(value));
        return stringify.call(this, value, ...args);
      };
    }, bodies);
    // 安装在页面计时器创建之前；fastForward 跨越多个 7 秒周期，无需真实等待。
    await page.clock.install();
    await enterNotes(page, fixture.origin);
    await page.waitForFunction(() => !document.querySelector('.persistence-gate'));
    await saved(page);

    await scenario('场景拖动/折叠只保存布局：不重新 fingerprint 原文，正文版本不变', async () => {
      await board(page).getByRole('button', { name: '适应全部卡片', exact: true }).click();
      await page.waitForTimeout(400);
      await saved(page);
      assert.ok((await page.evaluate(() => window.__resourceSerializationProbe.calls)).length > 0, '探针必须确实见过资源 DTO，不能空转');
      const before = fixture.read();
      const postsBefore = fixture.requests.filter(request => request.method === 'POST').length;
      const card = board(page).locator('.react-flow__node .card-drag-handle').first();
      const targetId = await card.evaluate(element => element.closest('.react-flow__node').getAttribute('data-id'));
      const position = before.layout.nodes.find(node => node.id === targetId).position;
      await page.evaluate(() => window.__resourceSerializationProbe.reset());
      const rect = await card.boundingBox(); assert.ok(rect);
      await page.mouse.move(rect.x + rect.width * .4, rect.y + rect.height / 2);
      await page.mouse.down(); await page.mouse.move(rect.x + rect.width * .4 + 80, rect.y + rect.height / 2 + 50, { steps: 6 }); await page.mouse.up();
      await until(() => {
        const node = fixture.read().layout.nodes.find(item => item.id === targetId);
        return node.position.x !== position.x || node.position.y !== position.y;
      }, '拖动位置写入布局');
      await saved(page);
      const fold = board(page).getByRole('button', { name: /折叠卡片/ }).first();
      await fold.click();
      await until(() => fixture.read().layout.nodes.some(node => node.data?.collapsed), '折叠状态写入布局');
      await saved(page);
      assert.deepEqual(await page.evaluate(() => window.__resourceSerializationProbe.calls), [], '场景变更不得重新遍历/散列资源正文');
      const after = fixture.read();
      assert.deepEqual(after.resourceVersions, before.resourceVersions);
      const posts = fixture.requests.filter(request => request.method === 'POST').slice(postsBefore);
      assert.ok(posts.length >= 2, '真实布局保存必须发生');
      assert.ok(posts.every(request => request.body.operation === 'layout'));
    });

    await scenario('离开无界笔记暂停外部轮询，重新显示立即检查外部版本', async () => {
      await page.locator('[data-proto="brand-switch"]').click();
      await board(page).waitFor({ state: 'hidden' });
      const before = gets(fixture);
      await page.clock.fastForward(21000);
      await page.waitForTimeout(100);
      assert.equal(gets(fixture), before, '隐藏面跨过三个轮询周期仍应零 GET');
      await page.locator('[data-proto="brand-switch"]').click();
      await board(page).waitFor({ state: 'visible' });
      await until(() => gets(fixture) > before, '重显后立即读取一次外部版本（不能等下一次 7 秒周期）', 3000);
      await saved(page);
    });

    await scenario('无界面隐藏时学习节点笔记仍可新建和编辑同一份 MD', async () => {
      if (await board(page).isVisible()) await page.locator('[data-proto="brand-switch"]').click();
      await board(page).waitFor({ state: 'hidden' });
      await page.locator('[data-proto="nav-subject"]').filter({ hasText: '演示科目' }).click();
      await page.locator('[data-proto="open-node"][data-node="reading-position"]').click();
      if (await page.locator('.smb-lesson').count() && (await page.locator('.smb-lesson').getAttribute('data-left')) !== '1') {
        await page.locator('[data-proto="toggle-left"]').click();
        await page.locator('.smb-lesson[data-left="1"]').waitFor({ state: 'visible' });
      }
      await page.locator('[data-proto="left-pane-notes"]').click();
      const tree = page.locator('.learning-notes-tree');
      // 新建入口在学习右栏（ADR-0019 起左树顶不再有「新建节点笔记」）；右栏收起时先点窄轨。
      const notesRail = page.locator('[data-proto="toggle-notes"]');
      if (await notesRail.isVisible().catch(() => false)) await notesRail.click();
      else await page.locator('[data-proto="tab-notes"]').click();
      await page.locator('.learning-notes-panel').waitFor({ state: 'visible', timeout: 20000 });
      await page.locator('.learning-notes-panel').getByRole('button', { name: '新建笔记', exact: true }).click();
      const picker = page.locator('.notes-picker');
      await picker.waitFor({ state: 'visible' });
      await page.locator('[aria-label="科目默认笔记本"]').selectOption('book');
      await picker.getByRole('button', { name: '确认选择', exact: true }).click();
      const editor = page.locator('.learning-notes-panel .markdown-inline-editor .cm-content[role="textbox"]');
      await editor.waitFor({ state: 'visible' });
      await editor.click(); await page.keyboard.press('Control+A');
      const text = '# HIDDEN-BOARD-SHARED-NOTE\n\n共享学习笔记仍正常保存。';
      await page.keyboard.insertText(text);
      await until(() => Object.values(fixture.read().resources).some(resource => resource.markdown === text), '隐藏 Board 仍持久化学习笔记');
      await tree.locator('.notes-status').filter({ hasText: '已保存' }).waitFor({ timeout: 15000 });
      const before = gets(fixture);
      await page.clock.fastForward(21000);
      await page.waitForTimeout(100);
      assert.equal(gets(fixture), before, '学习笔记可以保存，不需要隐藏 Board 恢复定时 GET');
      assert.equal(await board(page).isVisible(), false);
    });
    await scenario('隔离宿主无控制台错误、页面异常、HTTP 失败或外网请求', async () => {
      assert.deepEqual(fixture.problems, []); assert.deepEqual(problems, []);
    });
  } finally {
    if (context) await context.close();
    if (fixture) await fixture.close();
    await browser.close();
    fs.writeFileSync(path.join(OUT, 'browser-report.json'), JSON.stringify({ results, problems }, null, 2) + '\n');
  }
  const failures = results.filter(result => !result.ok);
  console.log(`${results.length - failures.length}/${results.length} 性能行为场景通过`);
  if (failures.length) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
