// 正式客户端 + 真 React/Edge；临时 notes 数据域，不连接真实宿主或模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, buildFormalNotesClient, loadNotesPlaywright, isMissingEdge, startNotesHostFixture } from '../fixtures/notes_host_fixture.mjs';
import { writeNotesResource } from '../../../lib/notes/store.ts';
import { libraryPayload } from '../fixtures/reading_position_fixture.mjs';

const shots = process.env.STUDYMATE_NOTES_SHOTS || path.join(ROOT, '.preview', 'locale');
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, ok: false, error: String(error.stack || error) }); console.error('FAIL ' + name + '\n' + error.stack); }
};
buildFormalNotesClient();
const playwright = await loadNotesPlaywright();
let browser;
try { browser = await (playwright.default || playwright).chromium.launch({ channel: 'msedge', headless: true }); }
catch (error) {
  if (!isMissingEdge(error)) throw error;
  console.error('SKIP locale browser: Microsoft Edge is unavailable');
  process.exit(3);
}
fs.mkdirSync(shots, { recursive: true });
let fixture;
try {
  const library = libraryPayload();
  const originalLibrary = JSON.stringify(library);
  fixture = await startNotesHostFixture({ seedDemo: true, build: false, library });
  const subject = library.subjects[0];
  const node = subject.nodes[0];
  assert.equal(writeNotesResource({ home: fixture.home, expectedVersion: null, resource: {
    id: 'locale-course', type: 'course', title: '中文课程引用', parent: 'references',
    courseRef: { workspace: library.workspace, subject: subject.slug, node: node.id, title: node.title },
  } }).ok, true);
  const savedBefore = fixture.read();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US', reducedMotion: 'reduce' });
  const problems = [], writes = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(fixture.origin + '/') || /^(data|blob):/.test(url)) return route.continue();
    problems.push('external request: ' + url);
    return route.abort();
  });
  await context.addInitScript(() => {
    window.__fixtureLocale = 'en';
    window.__storageWrites = [];
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { window.__storageWrites.push({ key, value }); return set.call(this, key, value); };
  });
  const page = await context.newPage();
  page.on('pageerror', error => problems.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
  await page.goto(fixture.origin);
  await page.locator('.smb-hero__title').waitFor();
  const switchTo = async language => {
    await page.evaluate(value => window.__probe.locale.switchTo(value), language);
    await page.waitForFunction(value => document.querySelector('[data-proto="brand-switch"]')?.title === (value === 'zh' ? '打开无界笔记' : 'Open unbounded notes')
      || document.querySelector('[data-proto="brand-switch"]')?.title === (value === 'zh' ? '回到学习' : 'Back to learning'), language);
  };
  await check('mounted home/sidebar switch en → zh → en without writes or remount', async () => {
    assert.equal(await page.locator('.smb-hero__title').innerText(), 'Learning workspace');
    await page.evaluate(() => { window.__homeElement = document.querySelector('.smb-hero__title'); });
    // usePaneWidths() 挂载后 200ms 会写入默认 studymate.panes.v1，先等它落定再测语言切换本身零写入。
    await page.waitForFunction(
      () => window.__storageWrites.some(w => w.key === 'studymate.panes.v1'),
      null,
      { timeout: 1000 },
    ).catch(() => {});
    const before = await page.evaluate(() => window.__storageWrites.length);
    await switchTo('zh');
    assert.equal(await page.locator('.smb-hero__title').innerText(), '学习工作台');
    await switchTo('en');
    assert.equal(await page.evaluate(() => window.__homeElement === document.querySelector('.smb-hero__title')), true);
    assert.deepEqual(await page.evaluate(() => window.__probe.registrations.filter(x => x.name === 'sidebar.panellist').map(x => x.label)), ['Learning']);
    assert.equal(await page.evaluate(() => window.__storageWrites.length), before);
    assert.equal(writes.length, 0);
    await page.screenshot({ path: path.join(shots, 'home-en.png') });
  });
  await check('reader content, selected lesson, DOM and scroll survive locale switches', async () => {
    await page.locator('[data-proto="continue"]').click();
    await page.locator('.smb-center__body').waitFor();
    // .smb-center__body 带 scroll-behavior: smooth，直接赋值 scrollTop 会平滑滑行；
    // 旧代码等 scrollTop > 400 就读 top 会采到滑行中途值，切回 en 时滑行已落定到 450 而表现为「漂移」。
    // 改用 instant 立即到位并等 scrollTop === 450 后，zh ↔ en 重渲染前后 scrollTop 严格相等。
    await page.locator('.smb-center__body').evaluate(el => {
      el.scrollTo({ top: 450, behavior: 'instant' });
      window.__readerElement = el;
    });
    await page.waitForFunction(() => document.querySelector('.smb-center__body').scrollTop === 450);
    const content = await page.locator('.smb-center__body').innerText();
    const top = await page.locator('.smb-center__body').evaluate(el => el.scrollTop);
    await switchTo('zh');
    await switchTo('en');
    assert.equal(await page.locator('.smb-center__body').innerText(), content);
    const afterSwitch = await page.locator('.smb-center__body').evaluate(el => el.scrollTop);
    assert.equal(afterSwitch, top);
    assert.equal(await page.evaluate(() => window.__readerElement === document.querySelector('.smb-center__body')), true);
    assert.equal(JSON.stringify(library), originalLibrary);
  });
  await page.locator('[data-proto="brand-switch"]').click();
  await page.locator('.studymate-notes .app-shell').waitFor();
  await page.waitForFunction(() => !document.querySelector('.studymate-notes .persistence-gate'));
  await check('notes course-reference preview switches live with unchanged course content', async () => {
    await page.getByRole('button', { name: 'Open 中文课程引用', exact: true }).dblclick();
    await page.locator('[data-proto="course-ref-open"]').waitFor();
    assert.equal(await page.locator('[data-proto="course-ref-open"]').innerText(), 'Open in learning');
    const content = await page.locator('.smb-refcourse__body .smb-sec-block').allTextContents();
    await switchTo('zh');
    assert.equal(await page.locator('[data-proto="course-ref-open"]').innerText(), '在学习端打开');
    await switchTo('en');
    assert.deepEqual(await page.locator('.smb-refcourse__body .smb-sec-block').allTextContents(), content);
  });
  await check('unsaved notes dialog survives locale removal/rearrival without writes', async () => {
    // #320 后左栏只有一个「新建」菜单：点开菜单再选文件夹项（与 notes_locale_test 同款路径）。
    await page.locator('.notes-create-trigger').click();
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
    const input = page.locator('.modal input');
    await input.fill('未保存的文件夹 draft');
    await input.evaluate(el => { window.__draftElement = el; });
    const before = writes.length;
    await switchTo('zh');
    await switchTo('en');
    await page.evaluate(() => window.__probe.locale.remove());
    await page.waitForFunction(() => document.querySelector('[data-proto="brand-switch"]').title === '回到学习');
    assert.equal(await page.evaluate(() => window.__probe.locale.listeners), 0);
    await page.evaluate(() => window.__probe.locale.provide('en'));
    await page.waitForFunction(() => document.querySelector('[data-proto="brand-switch"]').title === 'Back to learning');
    assert.equal(await input.inputValue(), '未保存的文件夹 draft');
    assert.equal(await input.evaluate(el => el === window.__draftElement), true);
    assert.equal(writes.length, before);
    assert.deepEqual(fixture.read().resources, savedBefore.resources);
    assert.deepEqual(fixture.read().layout.folders, savedBefore.layout.folders);
    await page.screenshot({ path: path.join(shots, 'notes-draft-en.png') });
  });
  await check('unload clears locale subscriptions and dictionary registrations; no preference writes', async () => {
    assert.equal(await page.evaluate(() => window.__probe.locale.writes), 0);
    await page.evaluate(() => window.__dispose());
    assert.deepEqual(await page.evaluate(() => ({ listeners: window.__probe.locale.listeners, dictionaries: window.__probe.locale.dictionaries, entries: window.__probe.registrations.length })), { listeners: 0, dictionaries: 0, entries: 0 });
    assert.equal(await page.locator('#root').innerHTML(), '');
  });
  await check('no external requests, page/console errors or fixture server errors', async () => {
    assert.deepEqual(problems, []);
    assert.deepEqual(fixture.problems, []);
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
