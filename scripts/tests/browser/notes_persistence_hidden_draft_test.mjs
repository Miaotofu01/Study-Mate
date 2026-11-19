/* #303/f7135f6（fix/303-notes-performance）隐藏面（active=false）草稿保护回归。
   独立专属文件，不登记 checks；依赖 f7135f6 的 becameVisible 立即核对语义，
   必须在该分支合入并重建 dist 后执行（合入前跑会因缺少立即核对而失败，属预期）。
   覆盖：隐藏期在途/失败/409 冲突草稿在重显时不被外部快照覆盖，且之后可明确恢复；
   隐藏期间零轮询、清洁重显立即核对且不产生写请求。
   IME 组字与 applyBase 竞争无法在无头环境确定性构造（CDP imeSetComposition 对
   CM6 组字态没有可断言的稳定信号），未纳入；以人工验证。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, buildFormalNotesClient, loadNotesPlaywright, isMissingEdge,
  startNotesHostFixture, enterNotes,
} from '../fixtures/notes_host_fixture.mjs';

const OUT = path.join(ROOT, '.preview', 'notes-persistence-hidden');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(50); }
  throw new Error(message);
}
const SKIP_BUILD = ['0', 'false', 'no'].includes(String(process.env.STUDYMATE_NOTES_BROWSER_BUILD || '1').toLowerCase());
if (!SKIP_BUILD) buildFormalNotesClient();
const notes = page => page.locator('.app-shell');
const notesSurface = page => page.locator('[data-proto="notes-surface"]');
async function ready(page) {
  await notes(page).locator('.react-flow').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.persistence-gate'), null, { timeout: 15000 });
}
async function saved(page) { await notes(page).locator('.persistence-badge[data-state="saved"]').waitFor({ timeout: 15000 }); }
const inlineEditor = page => notes(page).locator('.note-editor .markdown-inline-editor .cm-content[role="textbox"]');
const editorText = page => inlineEditor(page).first().evaluate(el => el.textContent || '');
async function body(page, text) {
  const editor = inlineEditor(page);
  await editor.waitFor({ state: 'visible', timeout: 12000 });
  await editor.click();
  await page.keyboard.press('Control+A'); await page.keyboard.insertText(text);
}
// 左栏「新建」菜单 → role=menuitem「新建笔记」→ 同名弹窗「创建」；默认名 未命名.md。
async function createNote(page, fixture, text, name) {
  const before = new Set(Object.keys(fixture.read().resources));
  await notes(page).locator('.left-panel .panel-header').getByRole('button', { name: '新建', exact: true }).click();
  await notes(page).getByRole('menuitem', { name: '新建笔记', exact: true }).click();
  const dialog = page.locator('[role=dialog][aria-label="新建笔记"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  if (name !== undefined) await dialog.getByRole('textbox', { name: '笔记名称' }).fill(name);
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  await body(page, text);
  await until(() => Object.values(fixture.read().resources).some(r => !before.has(r.id) && r.markdown === text), '新笔记没有真实保存');
  await saved(page);
  return Object.values(fixture.read().resources).find(r => !before.has(r.id) && r.markdown === text).id;
}
// 切面即隐藏：surface='learning' 时笔记面 data-hidden=1 + inert，Board 不卸载（lib/client.js:6370）。
async function hideNotes(page) {
  await page.getByRole('button', { name: '切换到学习', exact: true }).click();
  await until(async () => (await notesSurface(page).getAttribute('data-hidden')) === '1', 'notes 面没有进入隐藏态');
}
async function showNotes(page) {
  await page.getByRole('button', { name: '切换到无界笔记', exact: true }).click();
  await until(async () => (await notesSurface(page).getAttribute('data-hidden')) === null, 'notes 面没有恢复显示');
}
function externalMarkdown(fixture, id, text) {
  const file = path.join(fixture.root, 'resources', `r-${id}.md`);
  const source = fs.readFileSync(file, 'utf8');
  const header = source.match(/^---\r?\nstudymate_notes: [^\r\n]*\r?\n---\r?\n/);
  assert.ok(header, 'owned MD 缺专用元信息头');
  fs.writeFileSync(file, header[0] + text, 'utf8');
}
const inflightResourcePost = (fixture, id) =>
  fixture.requests.some(r => r.body?.resource?.id === id && r.status === null);

const playwright = await loadNotesPlaywright();
const { chromium } = playwright.default || playwright;
let browser;
try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (error) {
  if (!isMissingEdge(error)) throw error;
  console.error('跳过 notes-persistence-hidden：缺 Microsoft Edge；退出码 3，不算通过。\n' + error.message); process.exit(3);
}

async function scenario(label, fn) {
  let fixture, context;
  const problems = [], expectedHttp = [], expectedStatuses = new Set();
  try {
    fixture = await startNotesHostFixture({ build: false });
    context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => problems.push('pageerror: ' + (error.stack || error.message)));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const location = message.location().url || '';
      if (expectedStatuses.size && location.includes('/api/studymate/notes') && /^Failed to load resource:/.test(message.text())) expectedHttp.push({ location, text: message.text() });
      else problems.push('console: ' + message.text());
    });
    page.on('response', response => { if (response.status() >= 400 && !(response.url().includes('/api/studymate/notes') && expectedStatuses.has(response.status()))) problems.push(`HTTP ${response.status()} ${response.url()}`); });
    page.on('requestfailed', request => problems.push('requestfailed: ' + request.url() + ' ' + (request.failure()?.errorText || '')));
    page.on('request', request => {
      const url = request.url();
      if (/^(data|blob|about):/.test(url)) return;
      if (!url.startsWith(fixture.origin + '/')) problems.push('external: ' + url);
    });
    await fn({ fixture, page, expectHttp: (...statuses) => statuses.forEach(status => expectedStatuses.add(status)) });
    assert.equal(problems.length, 0, problems.join('\n'));
    assert.equal(fixture.problems.length, 0, fixture.problems.join('\n'));
    assert.ok(expectedHttp.length <= fixture.requests.filter(r => expectedStatuses.has(r.status)).length, '未预期的 notes HTTP 控制台错误');
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
  await scenario('隐藏期在途草稿，重显不覆盖、释放后真实落地且不重发', async ({ fixture, page }) => {
    await enterNotes(page, fixture.origin); await ready(page);
    const id = await createNote(page, fixture, '# BASE-INFLIGHT\n');
    const draft = '# HIDDEN-INFLIGHT-DRAFT\n\n切面时 PUT 还在途，重显不能被外部快照盖掉。\n';
    fixture.controls.pauseWrites = true;
    await body(page, draft);
    await until(() => inflightResourcePost(fixture, id), '草稿没有进入在途写入');
    const postsAtInflight = fixture.requests.filter(r => r.method === 'POST').length;
    await hideNotes(page);
    await showNotes(page);
    assert.ok((await editorText(page)).includes('HIDDEN-INFLIGHT-DRAFT'), '重显后草稿被覆盖');
    await fixture.controls.releaseWrites();
    await until(() => fixture.read().resources[id].markdown === draft, '释放后草稿没有真实落地'); await saved(page);
    // 等一轮核对后确认没有多余重写：在途 1 次 + 落地 1 次，重显核对被 isDirty 挡住、清洁核对不重发。
    await delay(700);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await delay(600);
    assert.equal(fixture.requests.filter(r => r.method === 'POST').length, postsAtInflight, '恢复后产生了多余重写');
    assert.ok((await editorText(page)).includes('HIDDEN-INFLIGHT-DRAFT'), '恢复后编辑器正文被重置');
  });

  await scenario('隐藏期保存失败，重显草稿仍在、明确重试后真实保存', async ({ fixture, page, expectHttp }) => {
    expectHttp(503);
    await enterNotes(page, fixture.origin); await ready(page);
    const id = await createNote(page, fixture, '# ERROR-BASE\n');
    const draft = '# HIDDEN-FAILED-DRAFT\n\n失败发生在切面期间，草稿必须保留。\n';
    fixture.controls.pauseWrites = true;
    await body(page, draft);
    await until(() => inflightResourcePost(fixture, id), '草稿没有进入在途写入');
    await hideNotes(page);
    fixture.controls.writeFault = { status: 503, code: 'write-failed', message: '测试保存失败' };
    fixture.controls.releaseWrites();
    await until(() => fixture.requests.some(r => r.body?.resource?.id === id && r.status === 503), '隐藏期间失败没有发生');
    assert.equal(await notes(page).locator('.persistence-badge').getAttribute('data-state'), 'error', '隐藏面错误状态没有呈现');
    assert.equal(fixture.read().resources[id].markdown, '# ERROR-BASE\n', '失败后服务器被盲改');
    await showNotes(page);
    await notes(page).locator('.persistence-badge[data-state="error"]').waitFor({ timeout: 12000 });
    assert.ok((await editorText(page)).includes('HIDDEN-FAILED-DRAFT'), '重显后失败草稿丢失');
    fixture.controls.writeFault = null;
    await notes(page).getByRole('button', { name: '重试保存', exact: true }).click();
    await until(() => fixture.read().resources[id].markdown === draft, '重试没有保存最新草稿'); await saved(page);
    assert.ok((await editorText(page)).includes('HIDDEN-FAILED-DRAFT'), '恢复后编辑器正文被重置');
  });

  await scenario('隐藏期409冲突，重显不覆盖草稿，保留本地按冲突版本CAS恢复', async ({ fixture, page, expectHttp }) => {
    expectHttp(409);
    await enterNotes(page, fixture.origin); await ready(page);
    const id = await createNote(page, fixture, '# CONFLICT-BASE\n');
    const draft = '# HIDDEN-CONFLICT-DRAFT\n\n冲突发生在切面期间，重显不能显示外部版本。\n';
    fixture.controls.pauseWrites = true;
    await body(page, draft);
    await until(() => inflightResourcePost(fixture, id), '草稿没有进入在途写入');
    externalMarkdown(fixture, id, '# EXTERNAL-DURING-HIDDEN\n');
    await hideNotes(page);
    fixture.controls.releaseWrites();
    await until(() => fixture.requests.some(r => r.body?.resource?.id === id && r.status === 409), '隐藏期间冲突没有发生');
    assert.equal(await notes(page).locator('.persistence-badge').getAttribute('data-state'), 'conflict', '隐藏面冲突状态没有呈现');
    assert.equal(fixture.read().resources[id].markdown, '# EXTERNAL-DURING-HIDDEN\n', '服务器版本应保留外部修改');
    await showNotes(page);
    const text = await editorText(page);
    assert.ok(text.includes('HIDDEN-CONFLICT-DRAFT'), '重显后本地草稿丢失');
    assert.ok(!text.includes('EXTERNAL-DURING-HIDDEN'), '重显用外部快照覆盖了草稿');
    await notes(page).locator('.persistence-conflict[role="alert"]').waitFor({ timeout: 12000 });
    page.once('dialog', dialog => dialog.accept());
    await notes(page).getByRole('button', { name: '保留本地并重试保存', exact: true }).click();
    await until(() => fixture.read().resources[id].markdown === draft, '明确keep没有保存最新草稿'); await saved(page);
    assert.ok((await editorText(page)).includes('HIDDEN-CONFLICT-DRAFT'), '恢复后编辑器正文被重置');
  });

  await scenario('隐藏期间零轮询；清洁重显立即核对且不产生写请求', async ({ fixture, page }) => {
    await enterNotes(page, fixture.origin); await ready(page);
    await createNote(page, fixture, '# POLL-CANARY\n');
    const posts = fixture.requests.filter(r => r.method === 'POST').length;
    const gets = fixture.requests.filter(r => r.method === 'GET').length;
    await hideNotes(page);
    await delay(8500);
    assert.equal(fixture.requests.filter(r => r.method === 'GET').length, gets, '隐藏期间仍在轮询 GET');
    await showNotes(page);
    await until(() => fixture.requests.filter(r => r.method === 'GET').length > gets, '重显后没有立即核对', 2000);
    await delay(600);
    assert.equal(fixture.requests.filter(r => r.method === 'POST').length, posts, '清洁核对产生了写请求');
    await saved(page);
    assert.ok((await editorText(page)).includes('POLL-CANARY'), '核对重置了正文');
  });
} finally {
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'persistence-hidden-report.json'), JSON.stringify({ checks: results.length, failures: results.filter(r => !r.ok).length, results }, null, 2));
}
console.log(`\n${results.filter(r => !r.ok).length === 0 ? '全部通过' : '存在失败'}：${results.filter(r => r.ok).length}/${results.length} 隐藏面草稿保护场景通过`);
if (results.some(r => !r.ok)) process.exitCode = 1;
