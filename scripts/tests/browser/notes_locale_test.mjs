// Notes-owned copy: real bundled components, isolated Edge and synthetic local data only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, buildFormalNotesClient, loadNotesPlaywright, isMissingEdge, startNotesHostFixture } from '../fixtures/notes_host_fixture.mjs';
import { writeNotesResource } from '../../../lib/notes/store.ts';
import { libraryPayload } from '../fixtures/reading_position_fixture.mjs';

const shots = process.env.STUDYMATE_NOTES_SHOTS || path.join(ROOT, '.preview', 'notes-locale');
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.stack || error) }); }
  console.log(`${results.at(-1).ok ? 'PASS' : 'FAIL'} ${name}`);
};
buildFormalNotesClient();
const playwright = await loadNotesPlaywright();
let browser;
try { browser = await (playwright.default || playwright).chromium.launch({ channel: 'msedge', headless: true }); }
catch (error) { if (!isMissingEdge(error)) throw error; console.error('SKIP: Microsoft Edge unavailable'); process.exit(3); }
let fixture;
fs.mkdirSync(shots, { recursive: true });
try {
  const library = libraryPayload();
  fixture = await startNotesHostFixture({ seedDemo: true, build: false, library });
  const subject = library.subjects[0], node = subject.nodes[0];
  assert.equal(writeNotesResource({ home: fixture.home, expectedVersion: null, resource: {
    id: 'locale-course', type: 'course', title: '中文课程引用', parent: 'references',
    courseRef: { workspace: library.workspace, subject: subject.slug, node: node.id, title: node.title },
  } }).ok, true);
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' });
  await context.addInitScript(() => { window.__fixtureLocale = 'en'; });
  const problems = [], writes = [];
  await context.route('**/*', route => {
    if (route.request().url().startsWith(fixture.origin + '/') || /^(data|blob):/.test(route.request().url())) return route.continue();
    problems.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => problems.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
  await page.goto(fixture.origin);
  await page.locator('[data-proto="brand-switch"]').click();
  await page.locator('.studymate-notes .app-shell').waitFor();
  await page.waitForFunction(() => !document.querySelector('.persistence-gate'));
  const switchTo = async language => {
    await page.evaluate(value => window.__probe.locale.switchTo(value), language);
    await page.waitForFunction(value => document.querySelector('.tree-search')?.getAttribute('aria-label') === (value === 'zh' ? '搜索文件' : 'Search files'), language);
  };
  await check('English notes file tree uses translated accessible labels', async () => {
    assert.equal(await page.locator('.resource-tree').getAttribute('aria-label'), 'File hierarchy');
    assert.equal(await page.locator('.tree-search').getAttribute('aria-label'), 'Search files');
    assert.ok((await page.locator('.resource-tree').innerText()).includes('我的资料'));
  });
  await check('English import menu labels', async () => {
    assert.equal(await page.locator('.import-menu-button').getAttribute('aria-label'), 'Import');
    await page.locator('.import-menu-button').click();
    assert.match(await page.locator('.import-menu-items').innerText(), /Copy/);
    assert.match(await page.locator('.import-menu-items').innerText(), /Reference/);
    await page.keyboard.press('Escape');
  });
  await check('English persistence badge', async () => {
    assert.equal(await page.locator('.persistence-badge').innerText(), 'Saved');
  });
  await check('English folder dialog', async () => {
    // #320 后左栏只有一个「新建」菜单：点开菜单再选文件夹项，弹窗标题仍按语言切换。
    await page.locator('.notes-create-trigger').click();
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
    assert.equal(await page.locator('.modal').getAttribute('aria-label'), 'New folder');
    await page.keyboard.press('Escape');
  });
  await check('open folder/import dialogs switch live, retain drafts/focus and never save', async () => {
    const saved = fixture.read(), before = writes.length;
    await page.locator('.notes-create-trigger').click();
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
    const input = page.locator('.modal input');
    await input.fill('未保存的名称 draft');
    await input.evaluate(el => { el.setSelectionRange(2, 5); window.__folderInput = el; });
    await switchTo('zh');
    assert.equal(await page.locator('.modal').getAttribute('aria-label'), '新建文件夹');
    assert.deepEqual(await input.evaluate(el => [el === window.__folderInput, el === document.activeElement, el.value, el.selectionStart, el.selectionEnd]), [true, true, '未保存的名称 draft', 2, 5]);
    await switchTo('en');
    await page.keyboard.press('Escape');
    await page.locator('.import-menu-button').click();
    await switchTo('zh');
    assert.match(await page.locator('.import-menu-items').innerText(), /副本/);
    await switchTo('en');
    await page.getByRole('menuitem').filter({ hasText: 'Reference' }).click();
    await page.getByRole('button', { name: 'Add web reference', exact: true }).click();
    await page.getByRole('textbox', { name: 'Web page title', exact: true }).fill('中文网页标题');
    await page.getByRole('textbox', { name: 'Web page address', exact: true }).fill('https://example.invalid/kept');
    await switchTo('zh');
    assert.equal(await page.getByRole('textbox', { name: '网页标题', exact: true }).inputValue(), '中文网页标题');
    assert.equal(await page.getByRole('textbox', { name: '网页地址', exact: true }).inputValue(), 'https://example.invalid/kept');
    await switchTo('en');
    await page.keyboard.press('Escape');
    assert.equal(writes.length, before);
    assert.deepEqual(fixture.read().resources, saved.resources);
    assert.deepEqual(fixture.read().layout.folders, saved.layout.folders);
  });
  await check('course relink selection survives mounted switches without changing reference', async () => {
    const saved = fixture.read().resources['locale-course'], before = writes.length;
    await page.getByRole('button', { name: 'Open 中文课程引用', exact: true }).dblclick();
    await page.getByRole('button', { name: 'Relink manually', exact: true }).click();
    await page.getByRole('combobox', { name: 'Relink node', exact: true }).selectOption(subject.nodes[1].id);
    await switchTo('zh');
    assert.equal(await page.getByRole('combobox', { name: '重新关联节点', exact: true }).inputValue(), subject.nodes[1].id);
    await switchTo('en');
    assert.equal(await page.getByRole('combobox', { name: 'Relink node', exact: true }).inputValue(), subject.nodes[1].id);
    assert.deepEqual(fixture.read().resources['locale-course'], saved);
    assert.equal(writes.length, before);
    await page.getByRole('button', { name: 'Relink manually', exact: true }).click();
  });
  await check('Markdown editor keeps DOM, pending body, selection and link draft across locale lifecycle', async () => {
    const note = Object.values(fixture.read().resources).find(item => item.type === 'note');
    await page.getByRole('button', { name: 'Open ' + note.title, exact: true }).dblclick();
    const editor = page.locator('.note-editor .cm-content[role="textbox"]');
    await editor.waitFor();
    assert.equal(await editor.getAttribute('aria-label'), 'Markdown body');
    fixture.controls.pauseWrites = true;
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n未保存正文 draft');
    await page.locator('.persistence-badge[data-state="saving"]').waitFor();
    const before = writes.length;
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    const selection = await editor.evaluate(el => {
      window.__editorElement = el;
      const s = window.getSelection();
      return [el.textContent, s.anchorOffset, s.focusOffset, s.toString()];
    });
    await switchTo('zh');
    assert.equal(await editor.getAttribute('aria-label'), 'Markdown 正文');
    await switchTo('en');
    assert.deepEqual(await editor.evaluate(el => { const s = window.getSelection(); return [el.textContent, s.anchorOffset, s.focusOffset, s.toString()]; }), selection);
    assert.equal(await editor.evaluate(el => el === window.__editorElement && el === document.activeElement), true);
    await page.keyboard.press('Control+k');
    const href = page.locator('.md-format-toolbar__dialog input').first();
    await href.fill('https://example.invalid/unsaved');
    await page.locator('.md-format-toolbar__dialog input').nth(1).fill('链接草稿');
    await page.evaluate(() => window.__probe.locale.remove());
    await page.waitForFunction(() => document.querySelector('.tree-search').getAttribute('aria-label') === '搜索文件');
    assert.equal(await page.evaluate(() => window.__probe.locale.listeners), 0);
    await page.evaluate(() => window.__probe.locale.provide('en'));
    await page.waitForFunction(() => document.querySelector('.tree-search').getAttribute('aria-label') === 'Search files');
    assert.equal(await href.inputValue(), 'https://example.invalid/unsaved');
    assert.equal(await page.locator('.md-format-toolbar__dialog input').nth(1).inputValue(), '链接草稿');
    assert.equal(await editor.evaluate(el => el === window.__editorElement), true);
    assert.equal(writes.length, before);
    assert.equal(fixture.read().resources[note.id].markdown, note.markdown);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    fixture.controls.releaseWrites();
    await page.locator('.persistence-badge[data-state="saved"]').waitFor();
    assert.ok(fixture.read().resources[note.id].markdown.endsWith('未保存正文 draft'));
    await page.screenshot({ path: path.join(shots, 'editor-en.png') });
  });
  await check('all notes locale subscriptions and registrations dispose without preference writes', async () => {
    assert.equal(await page.evaluate(() => window.__probe.locale.writes), 0);
    await page.evaluate(() => window.__dispose());
    assert.deepEqual(await page.evaluate(() => [window.__probe.locale.listeners, window.__probe.locale.dictionaries, window.__probe.registrations.length]), [0, 0, 0]);
  });
  await check('no external requests or rendering errors', async () => {
    assert.deepEqual(problems, []); assert.deepEqual(fixture.problems, []);
  });
  await context.close();
} finally {
  if (fixture) await fixture.close();
  await browser.close();
  const summary = { pass: results.filter(x => x.ok).length, fail: results.filter(x => !x.ok).length, skipped: 0, results };
  fs.writeFileSync(path.join(shots, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  if (summary.fail) process.exitCode = 1;
}
