/* #268：真组合客户端 + 真 notes HTTP/临时 HOME 的持久化回归。
   不接真实 DSH、模型、用户配置。故障/延迟控制只在测试 HTTP 服务器。
   正式原生空库、刷新恢复、保存失败/409草稿、媒体重验、引用失效与网页内存边界。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, DEMO_FOLDERS, buildFormalNotesClient, loadNotesPlaywright, isMissingEdge,
  startNotesHostFixture, enterNotes,
} from '../fixtures/notes_host_fixture.mjs';
import { writeNotesLayout, writeNotesResource } from '../../../lib/notes/store.ts';

const OUT = path.join(ROOT, '.preview', 'notes-persistence');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(50); }
  throw new Error(message);
}
// 父 agent 已完成正式 dist 构建；默认保留正式脚本自带构建，rerun 可用环境变量复用 dist。
const SKIP_BUILD = ['0', 'false', 'no'].includes(String(process.env.STUDYMATE_NOTES_BROWSER_BUILD || '1').toLowerCase());
if (!SKIP_BUILD) buildFormalNotesClient();
// 两种入口都渲染同一个 App 根 `.app-shell`；原生外面另有一层宿主命名空间包裹。
const notes = page => page.locator('.app-shell');
async function ready(page) {
  await notes(page).locator('.react-flow').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.persistence-gate'), null, { timeout: 15000 });
}
async function saved(page) { await notes(page).locator('.persistence-badge[data-state="saved"]').waitFor({ timeout: 15000 }); }
const inlineEditor = page => notes(page).locator('.note-editor .markdown-inline-editor .cm-content[role="textbox"]');
async function body(page, text) {
  // 当前 NoteEditor 只有一种内联 Markdown 源编辑态；不再有“编辑/源码/模式”切换。
  const editor = inlineEditor(page);
  await editor.waitFor({ state: 'visible', timeout: 12000 });
  await editor.click();
  await page.keyboard.press('Control+A'); await page.keyboard.insertText(text);
}
// 左栏只有一个「新建」菜单（菜单项 role=menuitem 同名弹窗）；独立 helper 留在本文件，
// 避免新增文件被静态覆盖器归错套件。
async function createResource(page, kind, name) {
  const label = kind === 'note' ? '新建笔记' : kind === 'folder' ? '新建文件夹' : '新建笔记本';
  await notes(page).locator('.left-panel .panel-header').getByRole('button', { name: '新建', exact: true }).click();
  await notes(page).getByRole('menuitem', { name: label, exact: true }).click();
  const dialog = page.locator(`[role=dialog][aria-label="${label}"]`);
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  if (name !== undefined) {
    const fieldName = kind === 'note' ? '笔记名称' : kind === 'folder' ? '文件夹名称' : '笔记本名称';
    await dialog.getByRole('textbox', { name: fieldName }).fill(name);
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
  return Object.values(fixture.read().resources).find(r => !before.has(r.id) && r.markdown === text).id;
}
async function openRight(page) {
  const toggle = notes(page).locator('.topbar-panel-toggle[aria-label="展开右侧栏"]');
  if (await toggle.count()) await toggle.click();
}
async function importFile(page, file, mode, { viaPicker = false } = {}) {
  await notes(page).getByRole('button', { name: '导入', exact: true }).click();
  if (viaPicker) {
    await notes(page).getByRole('menuitem', { name: /引用/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: '选择本地文件', exact: true }).click();
    return;
  }
  const chooser = page.waitForEvent('filechooser');
  await notes(page).getByRole('menuitem', { name: mode === 'copy' ? /副本/ : /引用/ }).click();
  if (mode === 'reference') await page.getByRole('dialog').getByRole('button', { name: '选择本地文件', exact: true }).click();
  await (await chooser).setFiles(file);
}
function externalMarkdown(fixture, id, text) {
  const file = path.join(fixture.root, 'resources', `r-${id}.md`);
  const source = fs.readFileSync(file, 'utf8');
  const header = source.match(/^---\r?\nstudymate_notes: [^\r\n]*\r?\n---\r?\n/);
  assert.ok(header, 'owned MD 缺专用元信息头');
  fs.writeFileSync(file, header[0] + text, 'utf8');
}
function seed(fixture, resource, position = { x: 80, y: 70 }) {
  const layout = { folders: structuredClone(DEMO_FOLDERS), nodes: [{ id: 'node-' + resource.id, type: 'knowledge', position, style: { width: 420, height: 300 }, data: { contentId: resource.id } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const a = writeNotesLayout({ home: fixture.home, layout, expectedVersion: null });
  const b = writeNotesResource({ home: fixture.home, resource: { ...resource, parent: 'notes' }, expectedVersion: null });
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(b.ok, true, JSON.stringify(b));
}
function containsExact(value, text) {
  if (value === text) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(child => containsExact(child, text));
}
const LEGACY_LOCK_ARTIFACTS = new Set(['notes.lock.db', 'notes.lock.db-journal', 'notes.lock.db-wal', 'notes.lock.db-shm']);
function lockArtifacts(root) {
  return fs.readdirSync(root).filter(name => LEGACY_LOCK_ARTIFACTS.has(name));
}
function makeV1Store(fixture, { withLayout = true } = {}) {
  const resource = { id: 'legacy-note', type: 'note', title: '旧版笔记.md', markdown: '# V1-CANARY\n\n正文原样保留。\n' };
  if (withLayout) seed(fixture, resource);
  else {
    const written = writeNotesResource({ home: fixture.home, resource: { ...resource, parent: 'notes' }, expectedVersion: null });
    assert.equal(written.ok, true, JSON.stringify(written));
  }
  const markerPath = path.join(fixture.root, '_format.json');
  // 用真实写 API 造结构，再把 marker 降为 v1 并移除写 API 留下的短命锁产物。
  fs.writeFileSync(markerPath, JSON.stringify({ format: 'studymate-notes', version: 1 }) + '\n', 'utf8');
  for (const name of lockArtifacts(fixture.root)) fs.rmSync(path.join(fixture.root, name), { force: true });
  assert.deepEqual(lockArtifacts(fixture.root), [], '测试旧库不应先带锁产物');
  const mdPath = path.join(fixture.root, 'resources', `r-${resource.id}.md`);
  return {
    resource, markerPath, mdPath,
    bytes: {
      marker: fs.readFileSync(markerPath),
      layout: withLayout ? fs.readFileSync(path.join(fixture.root, 'layout.json')) : null,
      md: fs.readFileSync(mdPath),
    },
  };
}
function assertOriginalBytes(store, { marker = true } = {}) {
  if (marker) assert.ok(fs.readFileSync(store.markerPath).equals(store.bytes.marker), 'v1 marker 原字节被改动');
  if (store.bytes.layout) assert.ok(fs.readFileSync(path.join(fixtureRootOf(store), 'layout.json')).equals(store.bytes.layout), 'v1 layout 原字节被改动');
  assert.ok(fs.readFileSync(store.mdPath).equals(store.bytes.md), 'v1 owned MD 原字节被改动');
}
function fixtureRootOf(store) { return path.dirname(store.markerPath); }
function assertNoPosts(fixture, label) {
  assert.equal(fixture.requests.filter(r => r.method === 'POST').length, 0, label);
}
function assertNoLocks(fixture, label) {
  assert.deepEqual(lockArtifacts(fixture.root), [], label);
}
async function upgradeGate(page) {
  await notes(page).locator('.react-flow').waitFor({ timeout: 15000 });
  const gate = notes(page).locator('.persistence-gate');
  await gate.getByText('旧笔记库保持只读。升级会先备份，旧版客户端随后不能写入。', { exact: true }).waitFor({ timeout: 15000 });
  const button = gate.getByRole('button', { name: '备份并升级笔记库', exact: true });
  await button.waitFor({ state: 'visible', timeout: 15000 });
  return { gate, button };
}
async function assertUpgradeReadOnly(page, fixture, label) {
  const { button } = await upgradeGate(page);
  await delay(400);
  assert.equal(await notes(page).locator('.workspace').evaluate(element => element.inert), true, label + '：工作区未只读');
  assert.equal(await notes(page).locator('.left-panel .notes-create-trigger').isDisabled(), true, label + '：新建菜单未禁用');
  // 旧 v1 只读走安全 Preview：实际没有内联编辑器/CodeMirror/格式工具栏，而不只是少了某个模式按钮。
  assert.equal(await notes(page).locator('.note-editor .markdown-inline-editor').count(), 0, label + '：只读旧库仍挂载内联编辑器');
  assert.equal(await notes(page).locator('.note-editor .cm-content').count(), 0, label + '：只读旧库仍挂载 CodeMirror');
  assert.equal(await notes(page).locator('.md-format-toolbar').count(), 0, label + '：只读旧库仍显示格式工具栏');
  assert.equal(await notes(page).locator('[contenteditable="true"]').count(), 0, label + '：只读旧库仍有可编辑区域');
  assertNoPosts(fixture, label + '：产生了 POST');
  assertNoLocks(fixture, label + '：产生了锁产物');
  return button;
}
async function stripUpgradeFlag(page) {
  await page.route('**/api/studymate/notes', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    // 模拟旧 Host：schemaVersion=1，但响应里还没有 requiresUpgrade 字段。
    assert.equal(json.schemaVersion, 1);
    assert.equal('requiresUpgrade' in json, true, '正式 v1 Host 应先带 requiresUpgrade');
    delete json.requiresUpgrade;
    const headers = { ...response.headers(), 'content-type': 'application/json' };
    delete headers['content-length']; delete headers['transfer-encoding'];
    await route.fulfill({ status: response.status(), headers, body: JSON.stringify(json) });
  });
}

const playwright = await loadNotesPlaywright();
const { chromium } = playwright.default || playwright;
let browser;
try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (error) {
  if (!isMissingEdge(error)) throw error;
  console.error('跳过 notes-persistence：缺 Microsoft Edge；退出码 3，不算通过。\n' + error.message); process.exit(3);
}

async function scenario(label, fn) {
  let fixture, context;
  const problems = [], expectedHttp = [], expectedStatuses = new Set();
  try {
    fixture = await startNotesHostFixture({ build: false });
    context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce', acceptDownloads: true });
    // 明确测试浏览器不支持句柄时的 File-only 分支；不放宽产品授权或媒体沙箱。
    await context.addInitScript(() => Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined }));
    const page = await context.newPage();
    let navigating = false;
    page.on('pageerror', error => problems.push('pageerror: ' + (error.stack || error.message)));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const location = message.location().url || '';
      if (expectedStatuses.size && location.includes('/api/studymate/notes') && /^Failed to load resource:/.test(message.text())) expectedHttp.push({ location, text: message.text() });
      else problems.push('console: ' + message.text());
    });
    page.on('response', response => { if (response.status() >= 400 && !(response.url().includes('/api/studymate/notes') && expectedStatuses.has(response.status()))) problems.push(`HTTP ${response.status()} ${response.url()}`); });
    page.on('requestfailed', request => {
      if (navigating && request.url().endsWith('/plugins/studymate/events') && /ERR_ABORTED/.test(request.failure()?.errorText || '')) return;
      problems.push('requestfailed: ' + request.url() + ' ' + (request.failure()?.errorText || ''));
    });
    page.on('request', request => {
      const url = request.url();
      if (/^(data|blob|about):/.test(url)) return;
      if (!url.startsWith(fixture.origin + '/')) problems.push('external: ' + url);
    });
    const reload = async () => { navigating = true; try { await enterNotes(page, fixture.origin); await ready(page); } finally { navigating = false; } };
    await fn({ fixture, page, reload, expectHttp: (...statuses) => statuses.forEach(status => expectedStatuses.add(status)) });
    assert.equal(problems.length, 0, problems.join('\n'));
    assert.equal(fixture.problems.length, 0, fixture.problems.join('\n'));
    // 故意的 409/503 必须真实出现在服务器记录；只分类浏览器自身 HTTP 错误，不吞 JS 异常。
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
  await scenario('原生读载门禁、空库不seed与默认空布局先提交', async ({ fixture, page }) => {
    fixture.controls.pauseReads = true;
    await enterNotes(page, fixture.origin);
    await notes(page).locator('.persistence-gate').waitFor();
    assert.equal(await notes(page).locator('.left-panel .notes-create-trigger').isDisabled(), true);
    assert.notEqual(await notes(page).locator('.persistence-badge').getAttribute('data-state'), 'saved');
    await page.keyboard.press('n'); await page.keyboard.press('3'); await delay(150);
    assert.equal(await notes(page).locator('.tree-file').count(), 0);
    assert.equal(await notes(page).locator('.react-flow__minimap-node').count(), 0);
    assert.equal(fixture.requests.some(r => r.method === 'POST'), false);
    assert.equal(fs.existsSync(fixture.root), false);
    fixture.controls.releaseReads(); await ready(page); await saved(page);
    const snapshot = fixture.read();
    assert.deepEqual(snapshot.resources, {}); assert.equal(snapshot.layout.nodes.length, 0);
    assert.equal(snapshot.layout.folders.find(f => f.id === 'library').parent, null);
    assert.equal(snapshot.layout.folders.find(f => f.id === 'book').kind, 'notebook');
    assert.deepEqual(fs.readdirSync(path.join(fixture.root, 'resources')), []);
    assert.equal(fixture.requests.filter(r => r.method === 'POST')[0].body.operation, 'layout');
    assert.equal(await notes(page).locator('.brand-icon,.brand-name').count(), 0);
  });

  await scenario('owned MD、树/布局、纯文本和相机刷新可恢复；移动折叠不改正文', async ({ fixture, page, reload }) => {
    await enterNotes(page, fixture.origin); await ready(page);
    const text = '# 持久化恢复探针\n\nPERSIST-NOTE-CANARY\n\n---\n\n原文尾部保留。\n';
    const id = await createNote(page, fixture, text);
    const version = fixture.read().resourceVersions[id];
    const mdFile = path.join(fixture.root, 'resources', `r-${id}.md`);
    assert.ok(fs.readFileSync(mdFile, 'utf8').endsWith(text));
    await createResource(page, 'folder', '恢复后的文件夹');
    await until(() => fixture.read().layout.folders.some(f => f.name === '恢复后的文件夹'), '目录未保存');
    await notes(page).locator('.view-switch').getByRole('button', { name: '画布', exact: true }).click();
    await openRight(page); await notes(page).getByRole('button', { name: '放到画布', exact: true }).click();
    const card = notes(page).locator(`.react-flow__node:has([data-content-id="${id}"])`);
    await card.waitFor(); await card.getByRole('button', { name: /^折叠卡片 / }).click();
    const rect = await card.locator('.card-drag-handle').boundingBox();
    await page.mouse.move(rect.x + 35, rect.y + 20); await page.mouse.down();
    await page.mouse.move(rect.x + 90, rect.y + 55, { steps: 8 }); await page.mouse.up();
    await notes(page).getByRole('button', { name: '添加纯内容节点', exact: true }).click();
    await notes(page).getByRole('textbox', { name: '纯节点内容', exact: true }).fill('TEXT-NODE-PERSISTS');
    await page.keyboard.press('Control+Enter');
    const stage = await notes(page).locator('.canvas-stage').boundingBox();
    await page.mouse.move(stage.x + 20, stage.y + stage.height - 25); await page.mouse.wheel(0, -120);
    await saved(page);
    await until(() => fixture.read().layout.nodes.some(n => n.data.text === 'TEXT-NODE-PERSISTS') && fixture.read().layout.nodes.some(n => n.data.collapsed), '节点/折叠布局未保存');
    const before = fixture.read();
    assert.equal(before.resourceVersions[id], version, '移动/折叠修改了正文版本');
    assert.equal(JSON.stringify(before.layout).includes('PERSIST-NOTE-CANARY'), false, '布局出现第二份正文');
    const savedTextNode = before.layout.nodes.find(n => n.type === 'text' && n.data.text === 'TEXT-NODE-PERSISTS');
    assert.equal(savedTextNode?.style?.height, 84, '新建纯内容节点默认高度应为 84px');
    const posts = fixture.requests.filter(r => r.method === 'POST').length;
    await reload(); await saved(page); await delay(500);
    const after = fixture.read();
    assert.equal(after.resources[id].markdown, text);
    assert.equal(after.resourceVersions[id], version);
    assert.deepEqual(after.layout, before.layout);
    assert.equal(fixture.requests.filter(r => r.method === 'POST').length, posts, '恢复本身触发了不必要写入');
    assert.equal(await notes(page).locator('.knowledge-card.is-collapsed').count(), 1);
    assert.equal(await notes(page).locator('.text-node-content', { hasText: 'TEXT-NODE-PERSISTS' }).count(), 1);
    // 持久化水合还原后，纯内容节点仍必须整块可拖动并落盘新坐标。
    const hydratedTextNode = notes(page).locator('.react-flow__node-text', { hasText: 'TEXT-NODE-PERSISTS' });
    const textRect0 = await hydratedTextNode.boundingBox();
    await page.mouse.move(textRect0.x + 50, textRect0.y + 30); await page.mouse.down();
    await page.mouse.move(textRect0.x + 125, textRect0.y + 85, { steps: 8 }); await page.mouse.up();
    await delay(200);
    const textRect1 = await hydratedTextNode.boundingBox();
    assert.ok(Math.abs(textRect1.x - textRect0.x) > 40 && Math.abs(textRect1.y - textRect0.y) > 30,
      `水合还原后的纯内容节点未能拖动：${textRect0.x},${textRect0.y} → ${textRect1.x},${textRect1.y}`);
    await saved(page);
    await until(() => {
      const moved = fixture.read().layout.nodes.find(n => n.id === savedTextNode.id);
      return moved && (Math.abs(moved.position.x - savedTextNode.position.x) > 30 || Math.abs(moved.position.y - savedTextNode.position.y) > 20);
    }, '水合后拖动纯内容节点的新坐标未保存');
    await page.screenshot({ path: path.join(OUT, 'native-restored.png'), animations: 'disabled' });
  });

  await scenario('改名扩展名：普通改名保留 .md；换后缀先确认，取消还原；不认识的后缀只读封口', async ({ fixture, page }) => {
    await enterNotes(page, fixture.origin); await ready(page);
    const text = '# EXTENSION-CANARY\n\n正文原样保留。\n';
    const id = await createNote(page, fixture, text, '扩展名探针.md');
    const title = () => notes(page).getByRole('textbox', { name: '文档标题' });
    assert.equal(await title().inputValue(), '扩展名探针.md');

    // 普通改名：名字里仍带 .md，后缀没变，不弹确认，直接落盘。
    let confirms = 0;
    const onDialog = dialog => { confirms += 1; dialog.accept(); };
    page.on('dialog', onDialog);
    await title().fill('扩展名探针（改名）.md');
    await title().press('Enter');
    await until(() => fixture.read().resources[id]?.title === '扩展名探针（改名）.md', '普通改名没有落盘');
    assert.equal(confirms, 0, '后缀没变却弹了扩展名确认');
    await saved(page);

    // 换后缀：先取消 —— 标题还原、文件不动。
    page.off('dialog', onDialog);
    let cancelPrompt = '';
    page.once('dialog', dialog => { cancelPrompt = dialog.message(); dialog.dismiss(); });
    await title().fill('扩展名探针.txt');
    await title().press('Enter');
    await delay(250);
    assert.ok(cancelPrompt.includes('更改扩展名可能导致文件无法识别'), '换后缀没有先确认：' + cancelPrompt);
    assert.equal(fixture.read().resources[id].title, '扩展名探针（改名）.md', '取消确认后标题仍被改掉');
    assert.equal(await title().inputValue(), '扩展名探针（改名）.md', '取消确认后输入框没有还原');

    // 确认换成 .txt：仍是 Markdown，正文继续可编辑。
    page.once('dialog', dialog => dialog.accept());
    await title().fill('扩展名探针.txt');
    await title().press('Enter');
    await until(() => fixture.read().resources[id]?.title === '扩展名探针.txt', '确认后 .txt 没有落盘');
    await until(async () => (await inlineEditor(page).innerText()).includes('EXTENSION-CANARY'), '.txt 仍应可编辑');
    await saved(page);

    // 换成不认识的后缀：确认后只改名，正文进只读封口，内容不丢。
    page.once('dialog', dialog => dialog.accept());
    await title().fill('扩展名探针.png');
    await title().press('Enter');
    await until(() => fixture.read().resources[id]?.title === '扩展名探针.png', '确认后不认识的后缀没有落盘');
    await saved(page);
    assert.equal(await notes(page).locator('.document-scroll .unsupported-note[role="status"]').count(), 1, '不支持的扩展名没有只读说明');
    assert.equal(await notes(page).locator('.document-scroll .markdown-inline-editor').count(), 0, '不支持的扩展名仍挂着编辑器');
    assert.equal(await notes(page).locator('.document-scroll .md-format-toolbar').count(), 0, '不支持的扩展名仍有格式栏');
    assert.equal(await notes(page).locator('.document-stage .document-mode-switch').count(), 0, '不支持的扩展名仍显示文档视图模式');
    assert.equal(fixture.read().resources[id].markdown, text, '封口时正文被改写');

    // 改回 .md：再确认一次，编辑器与原文都回来。
    page.once('dialog', dialog => dialog.accept());
    await title().fill('扩展名探针.md');
    await title().press('Enter');
    await until(async () => (await inlineEditor(page).innerText()).includes('EXTENSION-CANARY'), '改回 .md 后正文没有回来');
    assert.equal(fixture.read().resources[id].markdown, text);
    await saved(page);
  });

  await scenario('⋯ 复制 Markdown：同目录副本、不复制关联与画布，刷新仍在', async ({ fixture, page, reload }) => {
    await enterNotes(page, fixture.origin); await ready(page);
    const text = '# COPY-SOURCE-CANARY\n\n被复制的正文。\n';
    const sourceId = await createNote(page, fixture, text, '复制源.md');
    await notes(page).locator('.view-switch').getByRole('button', { name: '画布', exact: true }).click();
    await openRight(page);
    await saved(page);
    assert.equal(Object.keys(fixture.read().resources).length, 1);

    await notes(page).locator('[aria-label="复制源.md的更多操作"]').click();
    const menu = page.locator('[role="menu"][aria-label="复制源.md 的文件操作"]');
    await menu.waitFor({ state: 'visible', timeout: 5000 });
    const items = (await menu.getByRole('menuitem').allInnerTexts()).map(text => text.split('\n')[0].trim());
    assert.deepEqual(items, ['重命名', '复制 Markdown', '归档'], '文件菜单项顺序/占位不对：' + JSON.stringify(items));
    await menu.getByRole('menuitem', { name: /^复制 Markdown/ }).click();
    let copyId = null;
    await until(() => {
      const found = Object.values(fixture.read().resources).find(r => r.id !== sourceId && r.title === '复制源（副本）.md');
      if (found) copyId = found.id;
      return Boolean(found);
    }, '同目录副本没有落盘');
    await saved(page);
    const copy = fixture.read().resources[copyId];
    assert.equal(copy.markdown, text, '副本正文与原件不一致');
    assert.equal(copy.parent, fixture.read().resources[sourceId].parent, '副本没有落在与原件相同的目录');
    assert.ok(copy.parent, '副本落到了根上（原件在笔记本里）');
    assert.equal(fixture.read().layout.nodes.filter(node => node.data?.contentId === copyId).length, 0, '复制自动加了画布卡片');
    assert.equal(copy.associations, undefined, '副本凭空得到了课程关联');
    assert.equal(copy.origin?.mode, 'copy', '副本没有记录来源');
    // 刷新后副本仍在同目录，正文不变。
    await reload(); await saved(page);
    const persisted = fixture.read().resources[copyId];
    assert.equal(persisted?.title, '复制源（副本）.md');
    assert.equal(persisted.markdown, text);
    assert.equal(persisted.parent, fixture.read().resources[sourceId].parent);
  });

  await scenario('保存失败仍收最新草稿，可导出、明确重试后真实保存', async ({ fixture, page, expectHttp }) => {
    expectHttp(503);
    await enterNotes(page, fixture.origin); await ready(page);
    const id = await createNote(page, fixture, '# BASE-SAVED\n');
    fixture.controls.writeFault = { status: 503, code: 'write-failed', message: '测试保存失败' };
    await body(page, '# FIRST-FAILED-DRAFT\n');
    await notes(page).locator('.persistence-badge[data-state="error"]').waitFor({ timeout: 12000 });
    const failedPosts = fixture.requests.filter(r => r.method === 'POST').length;
    const latest = '# LATEST-FAILED-DRAFT\n\n保存失败之后继续输入，不能丢。\n';
    await body(page, latest); await delay(700);
    assert.equal(fixture.read().resources[id].markdown, '# BASE-SAVED\n');
    assert.equal(fixture.requests.filter(r => r.method === 'POST').length, failedPosts, '失败后自动盲重试');
    const downloading = page.waitForEvent('download');
    await notes(page).getByRole('button', { name: '导出本地草稿', exact: true }).click();
    const download = await downloading;
    assert.ok(containsExact(JSON.parse(fs.readFileSync(await download.path(), 'utf8')), latest), '导出的不是最新草稿');
    fixture.controls.writeFault = null;
    await notes(page).getByRole('button', { name: '重试保存', exact: true }).click();
    await until(() => fixture.read().resources[id].markdown === latest, '重试没有保存最新草稿'); await saved(page);
  });

  await scenario('两版本409保留后续输入；用户明确keep按冲突版本CAS保存最新草稿', async ({ fixture, page, expectHttp }) => {
    expectHttp(409);
    await enterNotes(page, fixture.origin); await ready(page);
    const id = await createNote(page, fixture, '# CONFLICT-BASE\n');
    fixture.controls.pauseWrites = true;
    await body(page, '# FIRST-LOCAL-DRAFT\n');
    await until(() => fixture.requests.some(r => r.body?.resource?.id === id && r.body.resource.markdown === '# FIRST-LOCAL-DRAFT\n' && r.status === null), '没有在途写入');
    externalMarkdown(fixture, id, '# EXTERNAL-WINS-UNTIL-CONFIRMED\n');
    await body(page, '# SECOND-LOCAL-DRAFT\n');
    fixture.controls.releaseWrites();
    await notes(page).locator('.persistence-badge[data-state="conflict"]').waitFor({ timeout: 12000 });
    assert.ok(fixture.requests.some(r => r.status === 409));
    const count = fixture.requests.filter(r => r.method === 'POST').length;
    const latest = '# THIRD-LOCAL-DRAFT\n\n409 后继续输入。\n';
    await body(page, latest); await delay(1200);
    assert.equal(fixture.requests.filter(r => r.method === 'POST').length, count);
    assert.equal(fixture.read().resources[id].markdown, '# EXTERNAL-WINS-UNTIL-CONFIRMED\n');
    page.once('dialog', dialog => dialog.accept());
    await notes(page).getByRole('button', { name: '保留本地并重试保存', exact: true }).click();
    await until(() => fixture.read().resources[id].markdown === latest, '明确keep没有保存最新草稿'); await saved(page);
  });

  await scenario('清洁时外部编辑原MD可见，同版本刷新不自动回写', async ({ fixture, page }) => {
    await enterNotes(page, fixture.origin); await ready(page);
    const id = await createNote(page, fixture, '# OLD-EXTERNAL-VIEW\n');
    const posts = fixture.requests.filter(r => r.method === 'POST').length;
    externalMarkdown(fixture, id, '# LIVE-EXTERNAL-EDIT\n\n原文件修改可见。\n');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(async () => (await inlineEditor(page).innerText()).includes('LIVE-EXTERNAL-EDIT'), '清洁外部编辑没有更新正文');
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await delay(500);
    assert.equal(fixture.requests.filter(r => r.method === 'POST').length, posts, '外部版本检测覆盖了原文');
  });

  await scenario('文件引用只落元信息；刷新失效，显式重新选择才恢复同ID', async ({ fixture, page, reload }) => {
    const file = path.join(fixture.dir, 'reference-source.md');
    fs.writeFileSync(file, '# PRIVATE-REF-CONTENT\n', 'utf8');
    await enterNotes(page, fixture.origin); await ready(page);
    await importFile(page, file, 'reference');
    await until(() => Object.values(fixture.read().resources).some(r => r.origin?.mode === 'reference'), '引用元信息未保存'); await saved(page);
    const resource = Object.values(fixture.read().resources).find(r => r.origin?.mode === 'reference');
    assert.equal('markdown' in resource, false); assert.equal('canReopen' in resource.origin, false);
    const raw = fs.readFileSync(path.join(fixture.root, 'resources', `r-${resource.id}.json`), 'utf8');
    assert.equal(raw.includes('PRIVATE-REF-CONTENT'), false);
    await reload(); await openRight(page);
    assert.equal((await notes(page).innerText()).includes('PRIVATE-REF-CONTENT'), false);
    await notes(page).getByRole('button', { name: '重新关联文件', exact: true }).waitFor();
    fs.writeFileSync(file, '# EXPLICITLY-RESELECTED-CONTENT\n', 'utf8');
    const chooser = page.waitForEvent('filechooser');
    await notes(page).getByRole('button', { name: '重新关联文件', exact: true }).click();
    await (await chooser).setFiles(file);
    await until(async () => (await notes(page).innerText()).includes('已重新关联原文件'), '显式重新选择没有恢复');
    await saved(page);
    assert.deepEqual(Object.keys(fixture.read().resources), [resource.id]);
    assert.equal(fs.readFileSync(path.join(fixture.root, 'resources', `r-${resource.id}.json`), 'utf8').includes('EXPLICITLY-RESELECTED-CONTENT'), false);
  });

  await scenario('在途轮询不得用旧快照覆盖刚重读的引用正文与授权', async ({ fixture, page, reload }) => {
    // 真句柄分支：每次 getFile 都重新取内容，才能区分“重读后的新对象”和“旧快照复用的对象”。
    // 必须在文档加载前定义：导入面板按挂载时能力决定“句柄”还是“File-only”文案。
    await page.addInitScript(() => {
      window.__pickerFile = { content: '# REFERENCE-LIVE-CANARY-V1\n', lastModified: 1 };
      window.showOpenFilePicker = async () => [{
        kind: 'file',
        getFile: async () => new File([window.__pickerFile.content], 'live-source.md', { type: 'text/markdown', lastModified: window.__pickerFile.lastModified }),
      }];
    });
    await reload();
    await until(() => page.evaluate(() => typeof window.showOpenFilePicker === 'function'), '假句柄没有生效');
    await importFile(page, null, 'reference', { viaPicker: true });
    await until(() => Object.values(fixture.read().resources).some(r => r.origin?.mode === 'reference' && r.origin.canReopen === undefined), '句柄引用只应落元信息'); await saved(page);
    await notes(page).locator('.tree-file-open').first().click();
    await until(async () => (await notes(page).innerText()).includes('REFERENCE-LIVE-CANARY-V1'), '打开引用没有显示本次读取的正文');
    fixture.controls.pauseReadReplies = true;
    fixture.controls.pauseWrites = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(() => fixture.requests.some(r => r.readReplyPending), '轮询 GET 没有真正在途');
    // 旧快照已经算出、尚未回包：原件被改，用户再点开引用触发重读并替换内存对象。
    await page.evaluate(() => { window.__pickerFile.content = '# REFERENCE-LIVE-CANARY-V2\n'; window.__pickerFile.lastModified = 2; });
    await notes(page).locator('.tree-file-open').first().click();
    await until(async () => (await notes(page).innerText()).includes('REFERENCE-LIVE-CANARY-V2'), '重读没有拿到最新原件');
    // 重读触发的保存也被扣住：此刻旧快照先到，新正文仍只是本地草稿。
    await until(() => fixture.requests.some(r => r.method === 'POST' && r.status === null), '重读后的保存没有在途');
    fixture.controls.releaseReadReplies();
    await delay(900);
    const text = await notes(page).innerText();
    assert.equal(text.includes('REFERENCE-LIVE-CANARY-V2'), true, '旧轮询快照覆盖了刚重读的正文');
    assert.equal(text.includes('请重新选择原文件'), false, '在途快照把重新授权退回失效态');
    fixture.controls.releaseWrites();
    await saved(page);
    const savedResource = Object.values(fixture.read().resources).find(r => r.origin?.mode === 'reference');
    assert.equal('markdown' in savedResource, false, '重读正文被写进元信息文件');
  });

  await scenario('SVG重新清理保1800元素/不取标题猜类型/严格iframe，载入不改原JSON', async ({ fixture, page }) => {
    const circles = Array.from({ length: 1800 }, (_, i) => `<circle cx="${i % 40}" cy="${i % 40}" r="1"/>`).join('');
    const html = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" onload="window.__unsafeSvg=1">${circles}<script>window.parent.__unsafeSvg=1</script></svg>`;
    seed(fixture, { id: 'svg-probe', type: 'svg', title: 'misleading-title.html', mime: 'image/svg+xml', html, bytes: Buffer.byteLength(html) });
    const version = fixture.read().resourceVersions['svg-probe'];
    await enterNotes(page, fixture.origin); await ready(page);
    const iframe = notes(page).locator('iframe[srcdoc]').first(); await iframe.waitFor();
    const doc = await iframe.getAttribute('srcdoc');
    assert.equal((doc.match(/<circle\b/g) || []).length, 1800);
    assert.equal(/<script\b|\bonload\s*=/i.test(doc), false);
    assert.equal(await iframe.getAttribute('sandbox'), '');
    assert.equal(await page.evaluate(() => window.__unsafeSvg), undefined);
    await delay(600);
    assert.equal(fixture.requests.some(r => r.body?.operation === 'resource'), false);
    assert.equal(fixture.read().resourceVersions['svg-probe'], version);
  });

  await scenario('坏位图重载整体封口，不渲染原始src，不自动提交默认布局', async ({ fixture, page }) => {
    seed(fixture, { id: 'bad-image', type: 'image', title: 'bad.png', mime: 'image/png', src: 'data:image/png;base64,AAAA', bytes: 3, width: 1, height: 1 });
    await enterNotes(page, fixture.origin);
    await notes(page).locator('.persistence-gate--error').waitFor({ timeout: 15000 });
    assert.equal(await notes(page).locator('.left-panel .notes-create-trigger').isDisabled(), true);
    assert.equal(await notes(page).locator('img[src="data:image/png;base64,AAAA"]').count(), 0);
    assert.equal(fixture.requests.some(r => r.method === 'POST'), false);
  });

  await scenario('未知格式GET503只显示载入错误，无demo/默认回写', async ({ fixture, page, expectHttp }) => {
    expectHttp(503);
    fs.mkdirSync(fixture.root); fs.writeFileSync(path.join(fixture.root, '_format.json'), '{"format":"studymate-notes","version":9}');
    await enterNotes(page, fixture.origin);
    await notes(page).locator('.persistence-gate--error').waitFor({ timeout: 15000 });
    assert.ok(fixture.requests.some(r => r.status === 503));
    assert.equal(fixture.requests.some(r => r.method === 'POST'), false);
    assert.equal(await notes(page).locator('.tree-file').count(), 0);
    assert.equal(await notes(page).locator('.react-flow__minimap-node').count(), 0);
    assert.deepEqual(fs.readdirSync(fixture.root), ['_format.json']);
  });

  await scenario('独立网页继续内存：新笔记刷新消失，零notes API且没有存储域', async ({ fixture, page }) => {
    await page.goto(fixture.origin + '/preview/', { waitUntil: 'domcontentloaded' });
    await notes(page).locator('.react-flow').waitFor({ timeout: 15000 });
    await notes(page).locator('.left-panel .panel-header').getByRole('button', { name: '新建', exact: true }).click();
    await notes(page).getByRole('menuitem', { name: '新建笔记', exact: true }).click();
    await page.locator('[role=dialog][aria-label="新建笔记"]').getByRole('button', { name: '创建', exact: true }).click();
    await body(page, '# MEMORY-ONLY-PREVIEW\n');
    assert.equal(fixture.requests.length, 0);
    assert.equal(fs.existsSync(fixture.root), false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await notes(page).locator('.react-flow').waitFor({ timeout: 15000 });
    assert.equal((await notes(page).innerText()).includes('MEMORY-ONLY-PREVIEW'), false);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fs.existsSync(fixture.root), false);
    assert.equal(await notes(page).locator('.persistence-badge').count(), 0);
  });
  await scenario('旧v1 Host响应缺requiresUpgrade也只读：0 POST、禁编辑、不自动初始化', async ({ fixture, page }) => {
    const store = makeV1Store(fixture);
    await stripUpgradeFlag(page);
    await enterNotes(page, fixture.origin);
    await assertUpgradeReadOnly(page, fixture, 'v1 无升级标志');
    assertOriginalBytes(store);
    assert.equal(fs.existsSync(path.join(fixture.root, 'layout.json')), true);
    assert.equal(JSON.parse(fs.readFileSync(store.markerPath, 'utf8')).version, 1);
  });

  await scenario('旧v1库只读/取消确认/明确升级：备份逐字节、只换marker、重复reload不重写', async ({ fixture, page, reload }) => {
    const store = makeV1Store(fixture);
    await enterNotes(page, fixture.origin);
    const button = await assertUpgradeReadOnly(page, fixture, '旧 v1 只读态');
    assertOriginalBytes(store);
    page.once('dialog', dialog => dialog.dismiss());
    await button.click();
    await upgradeGate(page);
    assert.equal(JSON.parse(fs.readFileSync(store.markerPath, 'utf8')).version, 1, '取消确认不应升级');
    assert.equal(fixture.requests.filter(r => r.method === 'POST').length, 0, '取消确认不应 POST');
    assertOriginalBytes(store);
    assertNoLocks(fixture, '取消确认不应生成锁产物');

    page.once('dialog', dialog => dialog.accept());
    await button.click();
    await until(() => fixture.requests.some(r => r.method === 'POST' && r.body?.operation === 'upgrade' && r.status === 200), '显式确认没有发出 upgrade POST');
    await ready(page);
    const wire = await page.evaluate(async () => (await (await fetch('/api/studymate/notes', { cache: 'no-store' })).json()));
    assert.equal(wire.schemaVersion, 2); assert.equal(wire.requiresUpgrade, false);
    const upgradedMarker = fs.readFileSync(store.markerPath);
    assert.equal(JSON.parse(upgradedMarker.toString('utf8')).version, 2);
    assert.equal(fs.readFileSync(path.join(fixture.root, 'layout.json')).equals(store.bytes.layout), true, '升级重写了 layout 原字节');
    assert.equal(fs.readFileSync(store.mdPath).equals(store.bytes.md), true, '升级重写了 owned MD 原字节');
    const backupDirs = fs.readdirSync(fixture.root).filter(name => /^backup-v1-[0-9a-f-]{36}$/.test(name));
    assert.equal(backupDirs.length, 1, '升级没有生成唯一备份目录');
    const backupDir = path.join(fixture.root, backupDirs[0]);
    assert.equal(fs.readFileSync(path.join(backupDir, '_format.json')).equals(store.bytes.marker), true, '备份 marker 不是逐字节旧原文');
    assert.equal(fs.readFileSync(path.join(backupDir, 'layout.json')).equals(store.bytes.layout), true, '备份 layout 不是逐字节旧原文');
    assert.equal(fs.readFileSync(path.join(backupDir, 'resources', path.basename(store.mdPath))).equals(store.bytes.md), true, '备份 MD 不是逐字节旧原文');
    const posts = fixture.requests.filter(r => r.method === 'POST').map(r => r.body?.operation);
    assert.deepEqual(posts, ['upgrade'], '升级过程产生了额外写入');
    await reload(); await saved(page); await delay(500);
    assert.deepEqual(fixture.requests.filter(r => r.method === 'POST').map(r => r.body?.operation), ['upgrade'], '重复 reload 产生了额外 POST');
    assert.equal(fs.readFileSync(path.join(fixture.root, 'layout.json')).equals(store.bytes.layout), true, '重复 reload 重写了 layout');
    assert.equal(fs.readFileSync(store.mdPath).equals(store.bytes.md), true, '重复 reload 重写了 MD');
    assert.equal(fs.readFileSync(store.markerPath).equals(upgradedMarker), true, '重复 reload 重写了 marker');
  });

  // #4：上限按钮必须在 markEdit 前被拒绝，不能再留下持久假脏。
  await scenario('节点达上限拒绝不写脏：无离开提示、外部更新可见', async ({ fixture, page }) => {
    const nodes = Array.from({ length: 120 }, (_, i) => ({
      id: 'cap-node-' + String(i).padStart(3, '0'), type: 'text',
      position: { x: (i % 12) * 40, y: Math.floor(i / 12) * 30 },
      style: { width: 40, height: 30 }, data: { text: '' },
    }));
    const layout = { folders: structuredClone(DEMO_FOLDERS), nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const written = writeNotesLayout({ home: fixture.home, layout, expectedVersion: null });
    assert.equal(written.ok, true, JSON.stringify(written));
    const capResource = { id: 'cap-note', type: 'note', title: 'CAP笔记.md', markdown: '# CAP-BASE\n' };
    const resourceWritten = writeNotesResource({ home: fixture.home, resource: { ...capResource, parent: 'notes' }, expectedVersion: null });
    assert.equal(resourceWritten.ok, true, JSON.stringify(resourceWritten));

    await enterNotes(page, fixture.origin); await ready(page); await saved(page);
    assert.equal(await notes(page).getByRole('button', { name: '添加纯内容节点', exact: true }).isDisabled(), false);

    const dirty = () => page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(await dirty(), false, '基线就已经假脏');
    await notes(page).getByRole('button', { name: '添加纯内容节点', exact: true }).click();
    await notes(page).locator('.toast').filter({ hasText: '此体验版最多放置 120 个节点' }).waitFor({ timeout: 5000 });
    assert.equal(await dirty(), false, '节点达上限被拒后仍留下假脏（beforeunload 被拦截）');
    assert.equal(fixture.read().layout.nodes.length, 120, '上限被拒却改写了布局');
    assert.equal(Object.keys(fixture.read().resources).length, 1, '上限被拒却新增了资源');

    // 清洁状态下外部修改应被 focus 触发的轮询带入内存；假脏时 checkExternal 会被 isDirty 短路。
    await notes(page).locator('.tree-file-open').first().click();
    await inlineEditor(page).waitFor({ state: 'visible', timeout: 12000 });
    const postsBeforePoll = fixture.requests.filter(r => r.method === 'POST').length;
    externalMarkdown(fixture, capResource.id, '# CAP-EXTERNAL-CANARY\n\n上限按钮拒绝后仍应看见外部更新。\n');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(async () => (await inlineEditor(page).innerText()).includes('CAP-EXTERNAL-CANARY'), '外部更新没有进入内存，拒绝后可能仍假脏');
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await delay(500);
    assert.equal(fixture.requests.filter(r => r.method === 'POST').length, postsBeforePoll, '外部版本检测覆盖了原文');
  });

  await scenario('资源达上限拒绝不写脏：无离开提示、外部更新可见', async ({ fixture, page }) => {
    for (let i = 0; i < 250; i++) {
      const id = 'cap-res-' + String(i).padStart(3, '0');
      const written = writeNotesResource({
        home: fixture.home,
        resource: { id, type: 'note', title: `CAP ${i}.md`, markdown: `# CAP ${i}\n`, parent: 'notes' },
        expectedVersion: null,
      });
      assert.equal(written.ok, true, `seed 第 ${i} 篇失败：${JSON.stringify(written)}`);
    }
    await enterNotes(page, fixture.origin); await ready(page); await saved(page);
    assert.equal(await notes(page).locator('.left-panel .notes-create-trigger').isDisabled(), false);

    const dirty = () => page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(await dirty(), false, '基线就已经假脏');
    await notes(page).locator('.left-panel .notes-create-trigger').click();
    await notes(page).getByRole('menuitem', { name: '新建笔记', exact: true }).click();
    const capDialog = page.locator('[role=dialog][aria-label="新建笔记"]');
    await capDialog.getByRole('button', { name: '创建', exact: true }).click();
    await capDialog.getByRole('alert').filter({ hasText: '最多保留 250 个资源' }).waitFor({ timeout: 5000 });
    assert.equal(await dirty(), false, '资源达上限被拒后仍留下假脏（beforeunload 被拦截）');
    assert.equal(Object.keys(fixture.read().resources).length, 250, '上限被拒却新增了资源');
    await page.keyboard.press('Escape');
    await delay(200);

    await notes(page).locator('.tree-file-open').first().click();
    await inlineEditor(page).waitFor({ state: 'visible', timeout: 12000 });
    const postsBeforePoll = fixture.requests.filter(r => r.method === 'POST').length;
    externalMarkdown(fixture, 'cap-res-000', '# CAP-RESOURCE-EXTERNAL-CANARY\n\n资源上限拒绝后仍应看见外部更新。\n');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(async () => (await inlineEditor(page).innerText()).includes('CAP-RESOURCE-EXTERNAL-CANARY'), '外部更新没有进入内存，拒绝后可能仍假脏');
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await delay(500);
    assert.equal(fixture.requests.filter(r => r.method === 'POST').length, postsBeforePoll, '外部版本检测覆盖了原文');
  });

  await scenario('旧v1无layout库升级前不初始化：只读、0 POST、无layout、无锁', async ({ fixture, page }) => {
    const store = makeV1Store(fixture, { withLayout: false });
    await enterNotes(page, fixture.origin);
    await assertUpgradeReadOnly(page, fixture, '无 layout 的旧 v1 只读态');
    assertOriginalBytes(store);
    assert.equal(fs.existsSync(path.join(fixture.root, 'layout.json')), false, '只读阶段自动初始化了 layout');
  });
  await scenario('#304 坏资源自动只读降级：逐条横幅、好资源可用，修好后横幅消失', async ({ fixture, page, reload, expectHttp }) => {
    expectHttp(503);
    const good = { id: 'good-note', type: 'note', title: '好笔记', parent: 'notes', owner: '我', markdown: '# 好\n\n可以编辑。\n' };
    const bad = { id: 'bad-note', type: 'note', title: '坏笔记', parent: 'notes', owner: '我', markdown: '# 坏\n\n这段会坏。\n' };
    assert.equal(writeNotesResource({ home: fixture.home, resource: good, expectedVersion: null }).ok, true);
    assert.equal(writeNotesResource({ home: fixture.home, resource: bad, expectedVersion: null }).ok, true);
    const layout = {
      folders: structuredClone(DEMO_FOLDERS),
      nodes: [
        { id: 'node-good', type: 'knowledge', position: { x: 80, y: 70 }, style: { width: 420, height: 300 }, data: { contentId: 'good-note', notebookId: 'book' } },
        { id: 'node-bad', type: 'knowledge', position: { x: 560, y: 70 }, style: { width: 420, height: 300 }, data: { contentId: 'bad-note', notebookId: 'book' } },
      ],
      edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    };
    assert.equal(writeNotesLayout({ home: fixture.home, layout, expectedVersion: null }).ok, true);
    // 头三行保留，正文追加非法 UTF-8：严格 GET 必须 503，客户端应自动重试 skip。
    fs.appendFileSync(path.join(fixture.root, 'resources', 'r-bad-note.md'), Buffer.from([0xff, 0xfe]));

    await enterNotes(page, fixture.origin);
    await ready(page);
    assert.ok(fixture.requests.some(r => r.status === 503), '第一次严格 GET 应 503');
    assert.ok(fixture.requests.some(r => r.method === 'GET' && r.url?.includes('onCorrupt=skip')), '应自动重试 skip');
    const banner = notes(page).locator('.persistence-corrupt');
    await banner.waitFor({ timeout: 15000 });
    assert.equal(await banner.count(), 1);
    assert.match(await banner.first().innerText(), /笔记本「学习与理解」中的资源「坏笔记」的文件已损坏，未载入。/);
    // 坏卡不应进画布，好卡仍应在画布；随后好笔记仍可打开编辑。
    assert.equal(await notes(page).locator('.react-flow__node[data-id="node-bad"]').count(), 0, '坏资源不应生成画布节点');
    assert.equal(await notes(page).locator('.react-flow__node[data-id="node-good"]').count(), 1, '好资源应保留画布节点');
    await notes(page).locator('.tree-file', { hasText: '好笔记' }).click();
    await inlineEditor(page).waitFor({ state: 'visible', timeout: 12000 });
    // #320 后左栏新建入口是「新建」菜单：降级载入后门禁仍是开的（菜单可点、
    // 里面仍有「新建笔记」项），语义与旧直开按钮的 isDisabled 断言一致。
    const createTrigger = notes(page).locator('.notes-create-trigger');
    await createTrigger.waitFor({ timeout: 12000 });
    assert.equal(await createTrigger.isDisabled(), false);
    await createTrigger.click();
    await notes(page).getByRole('menuitem', { name: '新建笔记', exact: true }).waitFor({ timeout: 8000 });
    await page.keyboard.press('Escape');

    // 修好文件再进入：严格 GET 成功，skip 不再出现，横幅消失，坏资源重新出现。
    const beforeRepair = fixture.requests.length;
    externalMarkdown(fixture, 'bad-note', '# 已修好\n\n现在可以载入。\n');
    await reload();
    await notes(page).locator('.tree-file', { hasText: '坏笔记' }).waitFor({ timeout: 15000 });
    assert.equal(await notes(page).locator('.persistence-corrupt').count(), 0);
    const repairReads = fixture.requests.slice(beforeRepair).filter(r => r.method === 'GET');
    assert.ok(repairReads.length > 0, '修好后应重新读取');
    assert.equal(repairReads.some(r => r.url?.includes('onCorrupt=skip')), false, '修好后不应再带 onCorrupt=skip');
  });

} finally {
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'persistence-browser-report.json'), JSON.stringify({ checks: results.length, failures: results.filter(r => !r.ok).length, results }, null, 2));
}
console.log(`\n${results.filter(r => r.ok).length}/${results.length} 持久化场景通过`);
if (results.some(r => !r.ok)) process.exitCode = 1;
