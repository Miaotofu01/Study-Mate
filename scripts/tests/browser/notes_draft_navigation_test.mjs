/* 导航卸载前后，笔记正文的真实可达状态（真 dist 组合客户端 + 真 notes HTTP）。

   本套件回答：在真实 App 里，用户在保存请求在途（saveStatus=pending）或保存失败
   （saveStatus=error）时继续输入，这段输入会不会在「点侧栏另一个文件」这类会卸载编辑器
   （App.jsx 两个挂载点，key 随资源 id 变化）的导航里被搬到别的文件、被静默丢弃，或反过来
   被误标成「未保存草稿」。

   已核实的产品事实（按它断言，不假装更严格）：
   - App.jsx 的 patchOwnedNote/updateResource 用 markEdit() 门禁，而
     useNotesPersistence.markEdit() 只在 isNative && stateRef.current !== 'ready'（loadState）
     时返回 false；saveStatus=pending/error 都**不**影响 loadState。所以 pending/error 期间的
     输入会被 App 接受、props 同步前进，最终（重试后）落盘。
   - loadState !== 'ready' 时 App 把 NoteEditor 设为只读，键盘打不进字。
   → 「编辑器草稿领先于 props」在宿主侧只剩 loadState 翻转那一帧的竞态，无法确定性构造；
     未确认草稿的恢复/冲突锁定/导出由组件层覆盖（notes_live_editor_test.mjs ⑨–㉓）。

   不覆盖（如实说明）：
   - 插件 HMR 同页重载会丢掉 NoteEditor 内存里的草稿暂存，且不触发 beforeunload；宿主没有
     可接的钩子，这里不宣称已保护。
   - 真实 409（外部改文件后保存被拒）未在本套件构造：notes 的版本栅栏由 #303 的持久化套件
     与组件层冲突用例覆盖，这里只覆盖 pending/error。
   - 学习节点笔记 LearningNotes.jsx 的挂载点需要学习面上下文，本套件不构建那个宿主。
   运行：缺 Microsoft Edge 退出码 3；STUDYMATE_NOTES_BROWSER_BUILD=0 可跳过构建。 */
import assert from 'node:assert/strict';
import {
  buildFormalNotesClient, loadNotesPlaywright, isMissingEdge,
  startNotesHostFixture, enterNotes,
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
const notes = page => page.locator('.app-shell');
async function ready(page) {
  await notes(page).locator('.react-flow').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.persistence-gate'), null, { timeout: 15000 });
}
async function saved(page) { await notes(page).locator('.persistence-badge[data-state="saved"]').waitFor({ timeout: 15000 }); }
async function badge(page) {
  return (await notes(page).locator('.persistence-badge').first().getAttribute('data-state')) || '';
}
async function waitBadge(page, state, timeout = 15000) {
  await until(async () => (await badge(page)) === state, '保存徽标没有进入 ' + state, timeout);
}
const inlineEditor = page => notes(page).locator('.note-editor .markdown-inline-editor .cm-content[role="textbox"]');
const editorText = page => inlineEditor(page).first().evaluate(el => el.textContent || '');
async function body(page, text) {
  const editor = inlineEditor(page);
  await editor.waitFor({ state: 'visible', timeout: 12000 });
  await editor.click();
  await page.keyboard.press('Control+A'); await page.keyboard.insertText(text);
}
// 左栏「新建」菜单 → role=menuitem → 同名弹窗；名字可留默认（未命名.md）。
async function createResource(page, kind, name) {
  const label = kind === 'note' ? '新建笔记' : kind === 'folder' ? '新建文件夹' : '新建笔记本';
  await notes(page).locator('.left-panel .panel-header').getByRole('button', { name: '新建', exact: true }).click();
  await notes(page).getByRole('menuitem', { name: label, exact: true }).click();
  const dialog = page.locator(`[role=dialog][aria-label="${label}"]`);
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  if (name !== undefined) {
    const field = kind === 'note' ? '笔记名称' : kind === 'folder' ? '文件夹名称' : '笔记本名称';
    await dialog.getByRole('textbox', { name: field }).fill(name);
  }
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  await delay(120);
}
async function createNote(page, fixture, text, name) {
  const before = new Set(Object.keys(fixture.read().resources));
  await createResource(page, 'note', name);
  await body(page, text);
  await until(() => Object.values(fixture.read().resources).some(r => !before.has(r.id) && r.markdown === text), '新笔记没有真实保存');
  await saved(page);
  return Object.values(fixture.read().resources).find(r => !before.has(r.id) && r.markdown === text);
}
async function currentTitle(page) {
  const input = notes(page).locator('input[aria-label="文档标题"]');
  if (await input.count()) return input.inputValue();
  return (await notes(page).locator('.document-title').first().textContent()) || '';
}
// 点侧栏里的文件（真实鼠标路径）：先等标题换过去，打开时会有一次读取。
async function openFromTree(page, title, { waitSaved = true } = {}) {
  const button = notes(page).locator(`button[aria-label="打开 ${title}"]`).first();
  await button.waitFor({ state: 'visible', timeout: 12000 });
  await button.click();
  await until(async () => (await currentTitle(page)).includes(title.replace(/\.md$/, '')), '文件没有打开：' + title);
  if (waitSaved) await saved(page);
}
async function twoNotes(page, fixture, first, second) {
  // 名字在新建弹窗里一次给全：标题输入框是「Enter/失焦才提交」的，不靠 fill 即改即存。
  const a = await createNote(page, fixture, first.body, first.title);
  const b = await createNote(page, fixture, second.body, second.title);
  assert.equal(a.title, first.title);
  assert.equal(b.title, second.title);
  return { a, b };
}

const playwright = await loadNotesPlaywright();
const { chromium } = playwright.default || playwright;
let browser;
try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (error) {
  if (!isMissingEdge(error)) throw error;
  console.error('跳过 notes-draft-navigation：缺 Microsoft Edge；退出码 3，不算通过。\n' + error.message); process.exit(3);
}

async function scenario(label, fn) {
  let fixture, context;
  const problems = [];
  try {
    fixture = await startNotesHostFixture({ build: false });
    context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => problems.push('pageerror: ' + (error.stack || error.message)));
    page.on('console', message => { if (message.type() === 'error') problems.push('console: ' + message.text()); });
    page.on('response', response => { if (response.status() >= 400) problems.push(`HTTP ${response.status()} ${response.url()}`); });
    page.on('requestfailed', request => problems.push('requestfailed: ' + request.url() + ' ' + (request.failure()?.errorText || '')));
    page.on('request', request => {
      const url = request.url();
      if (/^(data|blob|about):/.test(url)) return;
      if (!url.startsWith(fixture.origin + '/')) problems.push('external: ' + url);
    });
    await fn({ fixture, page });
    // 注入的 HTTP 失败按预期发生：只允许它出现在我们自己触发的那一段。
    const unexpected = problems.filter(problem => !/HTTP 500/.test(problem) && !/status of 500/.test(problem));
    assert.equal(unexpected.length, 0, unexpected.join('\n'));
    assert.equal(fixture.problems.length, 0, fixture.problems.join('\n'));
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
  await scenario('保存请求在途（pending）时继续输入 → 切到另一个文件：输入留在原文件，不串、不标草稿', async ({ fixture, page }) => {
    await enterNotes(page, fixture.origin); await ready(page);
    const { a, b } = await twoNotes(page, fixture,
      { body: '# NAV-P\n', title: '导航待写.md' }, { body: '# NAV-Q\n', title: '导航别处.md' });
    await openFromTree(page, '导航待写.md');

    fixture.controls.pauseWrites = true;
    await body(page, '# NAV-P\n\n正文\n');
    await waitBadge(page, 'pending');
    await inlineEditor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('尾巴甲');
    await until(async () => (await editorText(page)).includes('尾巴甲'), '在途时的输入没有进入编辑器');

    // 真实导航：在途时点另一个文件（编辑器卸载、key 换掉），再放开被挂住的写入。
    await openFromTree(page, '导航别处.md', { waitSaved: false });
    fixture.controls.releaseWrites();
    await saved(page);

    // 如实断言：pending 期间 App 仍接受输入，放行后这段输入落在**原文件**里。
    assert.ok(String(fixture.read().resources[a.id].markdown).includes('尾巴甲'), '在途时的输入应当已经写进原文件');
    assert.ok(!String(fixture.read().resources[b.id].markdown).includes('尾巴甲'), '输入不该串到另一个文件');
    assert.ok(!String(fixture.read().resources[b.id].markdown).includes('NAV-P'), '第二个文件不该被写入第一个文件的内容');

    await openFromTree(page, '导航待写.md');
    await inlineEditor(page).waitFor({ state: 'visible', timeout: 12000 });
    assert.ok((await editorText(page)).includes('尾巴甲'), '切回来编辑器应当显示已接受的输入');
    assert.equal(await notes(page).locator('.note-editor__status').count(), 0, '已接受的输入不应当被标成「已恢复的未保存草稿」');
  });

  await scenario('保存失败（error）时继续输入 → 重试落盘 → 导航往返：内容与文件一致，不误拦关闭页面', async ({ fixture, page }) => {
    await enterNotes(page, fixture.origin); await ready(page);
    const { a, b } = await twoNotes(page, fixture,
      { body: '# NAV-E\n', title: '导航失败.md' }, { body: '# NAV-R\n', title: '导航旁路.md' });
    await openFromTree(page, '导航失败.md');

    // 注入一次真实 HTTP 失败：徽标进入 error。此后继续输入——App 仍接受（见文件头说明）。
    fixture.controls.writeFault = { status: 500, code: 'write-failed', message: '测试注入的保存失败' };
    await inlineEditor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('X');
    await waitBadge(page, 'error', 12000);
    await page.keyboard.type('Y');
    await until(async () => (await editorText(page)).includes('XY'), '失败态下的输入没有进入编辑器');
    assert.ok(!String(fixture.read().resources[a.id].markdown).includes('XY'), '失败态下这段输入还没落盘');

    // 清掉注入的失败并重试：App 把本地最新正文写回文件。
    fixture.controls.writeFault = null;
    await notes(page).getByRole('button', { name: /重试/ }).first().click();
    await waitBadge(page, 'saved');
    assert.ok(String(fixture.read().resources[a.id].markdown).includes('XY'), '重试后本地最新正文应当落盘');
    assert.ok(!String(fixture.read().resources[b.id].markdown).includes('XY'), '重试不该改到另一个文件');

    // 导航往返：编辑器显示的就是文件里的版本，不出现「已恢复草稿」。
    await openFromTree(page, '导航旁路.md');
    await openFromTree(page, '导航失败.md');
    await inlineEditor(page).waitFor({ state: 'visible', timeout: 12000 });
    assert.ok((await editorText(page)).includes('XY'), '切回来编辑器内容应当与文件一致');
    assert.equal(await notes(page).locator('.note-editor__status').count(), 0, '没有未确认草稿时不该出现恢复提示');
    assert.ok(String(fixture.read().resources[a.id].markdown).includes('XY'), '导航不该改动文件');

    // 没有未确认草稿时，App 不该拦关闭页面（beforeunload 不 preventDefault）。
    const blocked = await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(blocked, false, '没有未确认草稿时不该拦关闭页面');
  });

  const failed = results.filter(result => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
}
