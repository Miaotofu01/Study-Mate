/* App 层 × ResourceTree 目录操作接线的真浏览器集成（#312）。
   跑法：node scripts/tests/browser/notes_tree_wiring_test.mjs

   正式组合客户端 + 真 notes HTTP/临时 HOME 的**空库**（首次载入只初始化目录结构，
   不 seed 任何演示资源）。树组件本身的外部行为已由 notes_resource_tree_test.mjs
   用临时夹具页覆盖；本套件只验证 App.jsx 的接线与数据安全：
   - 目录/文件重命名走 App 回调（markEdit → storeFolders/storeResources）并真实落盘
     （layout.json / r-*.json，含自动保存到 saved）；
   - 空目录删除：window.confirm 二次确认后真实删除；被删的是选中目录时回退选中
     （树内高亮收敛到回退目录）；
   - 保护判据与树侧同源（resource-tree-model.folderDeleteBlockReason），App 层用
     foldersRef/resourcesRef/sceneRef 再验一遍：根目录/非空目录/画布有节点的笔记本
      在菜单里禁用并说明；空且未绑定的笔记本可删；废纸篓内容节点也算画布内容（节点口径，
      防删除留下归属悬空的节点）；回退目录（概念/例子/参考，FALLBACK_FOLDER_IDS）按 id
      保护；最后一本笔记本由 model（resource-tree-model.js:59）与 App 层 deleteFolder
      双门一致禁止；
   - 拖放导入的 App 级写入门禁：可编辑态拖入文件→副本模式真实落盘；只读态（readFault）
     拖入文件→副本模式被入口门禁拒绝，store 不新增任何内容；
   - 载入失败（readFault）时 canEdit=false，树菜单按钮禁用；
   - 全程无控制台/页面错误。
   需要 Microsoft Edge；没有就退出码 3。不连接真实 DSH 或模型。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, buildFormalNotesClient, loadNotesPlaywright, isMissingEdge,
  startNotesHostFixture, enterNotes,
} from '../fixtures/notes_host_fixture.mjs';
import { writeNotesLayout, writeNotesResource } from '../../../lib/notes/store.ts';

const OUT = path.join(ROOT, '.preview', 'notes-tree-wiring');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
let failures = 0;
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}
async function guarded(label, fn) {
  try { await fn(); check(label, true); }
  catch (error) { check(label, false, String(error?.stack || error)); }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(50); }
  throw new Error(message);
}
const SKIP_BUILD = ['0', 'false', 'no'].includes(String(process.env.STUDYMATE_NOTES_BROWSER_BUILD || '1').toLowerCase());
if (!SKIP_BUILD) buildFormalNotesClient();

const notes = page => page.locator('.studymate-notes .app-shell');
async function ready(page) {
  await notes(page).locator('.react-flow').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.studymate-notes .persistence-gate'), null, { timeout: 15000 });
}
async function saved(page) {
  await notes(page).locator('.persistence-badge[data-state="saved"]').waitFor({ timeout: 15000 });
}
const moreOf = (page, label) => notes(page).locator(`[aria-label="${label}的更多操作"]`);
async function openMenu(page, label) {
  // 上个场景的菜单可能还开着（Escape 未必关得掉），先点空白处确保没有残留菜单挡住点击。
  while (await page.locator('[role="menu"].tree-more-menu').count()) {
    await page.mouse.click(8, 450);
    await delay(120);
  }
  await moreOf(page, label).click();
  await page.locator('[role="menu"]').waitFor({ state: 'visible', timeout: 5000 });
}
async function activeRows(page) {
  return page.evaluate(() => [...document.querySelectorAll('.studymate-notes .tree-row.is-active')].map(row => row.className.includes('tree-file')
    ? 'file:' + row.querySelector('.tree-label').textContent
    : 'folder:' + (row.querySelector('.tree-row-label')?.querySelector('.tree-label')?.textContent || '?')));
}
async function renameViaMenu(page, label, menuAria, next) {
  await openMenu(page, label);
  await page.locator(`[role="menu"][aria-label="${menuAria}"]`).getByRole('menuitem', { name: '重命名' }).click();
  const input = notes(page).locator('.tree-rename-input');
  await input.waitFor({ state: 'visible', timeout: 5000 });
  await input.fill(next);
  await input.press('Enter');
}
// 左栏只有一个「新建」菜单：点开 → role=menuitem → 同名弹窗 → 创建。
const CREATE_LABEL = { notebook: '新建笔记本', folder: '新建文件夹', note: '新建笔记' };
const CREATE_FIELD = { notebook: '笔记本名称', folder: '文件夹名称', note: '笔记名称' };
async function createViaMenu(page, kind, name) {
  const label = CREATE_LABEL[kind];
  await notes(page).locator('.left-panel .panel-header').getByRole('button', { name: '新建', exact: true }).click();
  await notes(page).getByRole('menuitem', { name: label, exact: true }).click();
  const dialog = page.locator(`[role=dialog][aria-label="${label}"]`);
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  if (name !== undefined) await dialog.getByRole('textbox', { name: CREATE_FIELD[kind] }).fill(name);
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  await delay(200);
}
const createFolder = (page, name) => createViaMenu(page, 'folder', name);
const createNotebook = (page, name) => createViaMenu(page, 'notebook', name);
async function createNote(page, fixture, text, name) {
  const before = new Set(Object.keys(fixture.read().resources));
  await createViaMenu(page, 'note', name);
  const editor = notes(page).locator('.note-editor .markdown-inline-editor .cm-content[role="textbox"]');
  await editor.waitFor({ state: 'visible', timeout: 12000 });
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
  await until(() => Object.values(fixture.read().resources).some(r => !before.has(r.id) && r.markdown === text), '新笔记没有真实保存');
  await saved(page);
  return Object.values(fixture.read().resources).find(r => !before.has(r.id) && r.markdown === text).id;
}
function externalMarkdown(fixture, id, text) {
  const file = path.join(fixture.root, 'resources', `r-${id}.md`);
  const source = fs.readFileSync(file, 'utf8');
  const header = source.match(/^---\r?\nstudymate_notes: [^\r\n]*\r?\n---\r?\n/);
  assert.ok(header, 'owned MD 缺专用元信息头');
  fs.writeFileSync(file, header[0] + text, 'utf8');
}

const playwright = await loadNotesPlaywright();
const { chromium } = playwright.default || playwright;
let browser;
try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (error) {
  if (!isMissingEdge(error)) throw error;
  console.error('跳过 notes-tree-wiring：需要已安装的 Microsoft Edge；退出码 3，不算通过。\n' + error.message);
  process.exit(3);
}

let fixture;
try {
  // 空库：只有 initialFolders 的五个系统目录，零资源——正好用来验证保护判据与删除回退。
  fixture = await startNotesHostFixture({ seedDemo: false, build: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce', locale: 'zh-CN' });
  const page = await context.newPage();
  const problems = [];
  let allowFault = false; // readFault 场景的 503 是预期内的，不计入问题
  const expectedFaults = new Set(); // 草稿按钮场景预期内的 503（writeFault）与 409（冲突）
  page.on('console', message => {
    // readFault/writeFault 场景的 503 是预期故障，浏览器会记一条资源加载错误——不是问题；
    // 冲突窗口内的 409 同理（expectedFaults 只在预期窗口内含 409）。
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('503') || (expectedFaults.has(409) && text.includes('409'))) return;
    problems.push('console: ' + text);
  });
  page.on('pageerror', error => problems.push('pageerror: ' + (error.stack || error.message)));
  page.on('requestfailed', request => { if (!allowFault && !request.url().includes('/plugins/studymate/events')) problems.push('requestfailed: ' + request.url()); });
  page.on('response', response => { if (response.status() >= 400 && !allowFault && !expectedFaults.has(response.status())) problems.push(`status ${response.status()}: ${response.url()}`); });
  try {
    await enterNotes(page, fixture.origin);
    await ready(page);

    await guarded('空库初始化：恰好五个系统目录、零资源', async () => {
      const store = fixture.read();
      assert.deepEqual(store.layout.folders.map(f => f.id), ['library', 'book', 'notes', 'examples', 'references']);
      assert.deepEqual(Object.keys(store.resources), []);
    });

    await guarded('资源/节点视图切换互斥高亮（is-active + aria-pressed）', async () => {
      const dir = page.locator('.studymate-notes .view-switch[aria-label="笔记目录视图"]');
      const files = dir.getByRole('button', { name: '资源视图', exact: true });
      const nodes = dir.getByRole('button', { name: '节点视图', exact: true });
      const classes = () => page.evaluate(() => [...document.querySelectorAll('.studymate-notes .view-switch[aria-label="笔记目录视图"] button')].slice(0, 2).map(b => b.classList.contains('is-active')));
      assert.deepEqual(await classes(), [true, false], '资源视图默认应高亮');
      assert.equal(await files.getAttribute('aria-pressed'), 'true');
      assert.equal(await nodes.getAttribute('aria-pressed'), 'false');
      await nodes.click();
      await until(async () => JSON.stringify(await classes()) === '[false,true]', '节点视图没有独占 is-active 高亮');
      assert.equal(await nodes.getAttribute('aria-pressed'), 'true');
      assert.equal(await files.getAttribute('aria-pressed'), 'false');
      await files.click();
      await until(async () => JSON.stringify(await classes()) === '[true,false]', '切回资源视图没有恢复高亮');
    });

    await guarded('左栏「新建」菜单：纯图标按钮、紧凑不裁切、三项图标与文字对齐、Escape 还焦点', async () => {
      const trigger = notes(page).locator('.left-panel .panel-header button.notes-create-trigger');
      assert.equal(await trigger.count(), 1, '左栏应有唯一「新建」按钮');
      assert.equal(await notes(page).locator('.left-panel').getByRole('button', { name: '新建笔记', exact: true }).count(), 0, '左栏不该再有独立的新建按钮');
      assert.equal(await trigger.getAttribute('aria-label'), '新建');
      assert.equal((await trigger.innerText()).trim(), '', '新建按钮应为纯图标，不含可见文字');
      assert.equal(await trigger.locator('svg').count(), 1, '新建按钮应含十字图标 svg');
      assert.equal(await trigger.getAttribute('aria-haspopup'), 'menu');
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      await trigger.click();
      const menu = page.locator('[role="menu"][aria-label="新建资源"]');
      await menu.waitFor({ state: 'visible', timeout: 5000 });
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
      const items = (await menu.getByRole('menuitem').allInnerTexts()).map(text => text.split('\n')[0].trim());
      assert.deepEqual(items, ['新建笔记本', '新建文件夹', '新建笔记'], '菜单项顺序不对：' + JSON.stringify(items));
      const placed = await page.evaluate(() => {
        const menu = document.querySelector('[role="menu"][aria-label="新建资源"]');
        const trigger = document.querySelector('.notes-create-trigger');
        const host = menu.closest('.app-shell');
        const m = menu.getBoundingClientRect(), t = trigger.getBoundingClientRect(), h = host?.getBoundingClientRect();
        const rows = [...menu.querySelectorAll('[role="menuitem"]')];
        const iconWidths = rows.map(row => row.querySelector('svg')?.getBoundingClientRect().width ?? 0);
        const textLefts = rows.map(row => row.querySelector('span')?.getBoundingClientRect().left ?? 0);
        return {
          inside: Boolean(host),
          gap: m.top - t.bottom,
          overlap: m.left < t.right && m.right > t.left,
          leftOffset: h ? m.left - h.left : -1,
          width: m.width,
          iconWidths,
          textLefts,
        };
      });
      assert.equal(placed.inside, true, '新建菜单没有挂到 .app-shell 下');
      assert.ok(placed.gap >= -2 && placed.gap <= 24, '新建菜单没有贴在触发器下方：' + placed.gap);
      assert.equal(placed.overlap, true, '新建菜单没有对齐触发器');
      assert.ok(placed.leftOffset >= 7.5, '新建菜单左侧不应被裁切：' + placed.leftOffset);
      assert.ok(placed.width < 180, '新建菜单宽度应紧凑（< 180px）：' + placed.width);
      assert.ok(Math.max(...placed.iconWidths) - Math.min(...placed.iconWidths) <= 0.5, '三项图标宽度应一致：' + JSON.stringify(placed.iconWidths));
      assert.ok(Math.max(...placed.textLefts) - Math.min(...placed.textLefts) <= 1, '三项文字左缘应垂直对齐：' + JSON.stringify(placed.textLefts));
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached', timeout: 5000 });
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.notes-create-trigger'))), true, 'Escape 后焦点没有回到「新建」');
    });


    await guarded('目录重命名走 App 回调并真实落盘（layout.json + saved）', async () => {
      await renameViaMenu(page, '参考', '参考 的目录操作', '参考资料');
      await until(() => fixture.read().layout.folders.some(f => f.id === 'references' && f.name === '参考资料'), '目录重命名没有落盘');
      assert.equal(await notes(page).locator('button[aria-label="参考资料 文件夹"]').count(), 1, '树标签没有更新');
      await saved(page);
    });

    await guarded('笔记重命名走 App 回调并真实落盘（r-*.json + saved）', async () => {
      const id = await createNote(page, fixture, '# WIRING-NOTE\n');
      await renameViaMenu(page, '未命名.md', '未命名.md 的文件操作', '会议记录.md');
      await until(() => fixture.read().resources[id]?.title === '会议记录.md', '笔记重命名没有落盘');
      assert.equal(await notes(page).locator('button[aria-label="打开 会议记录.md"]').count(), 1, '树标签没有更新');
      await saved(page);
    });

    await guarded('⋯ 复制 Markdown：同目录副本、不建画布卡片；归档占位', async () => {
      const text = '# COPY-WIRING\n';
      const id = await createNote(page, fixture, text, '复制源.md');
      const nodeCount = fixture.read().layout.nodes.length;
      await openMenu(page, '复制源.md');
      const menu = page.locator('[role="menu"][aria-label="复制源.md 的文件操作"]');
      const items = (await menu.getByRole('menuitem').allInnerTexts()).map(text => text.split('\n')[0].trim());
      assert.deepEqual(items, ['重命名', '复制 Markdown', '归档'], '文件菜单项顺序不对：' + JSON.stringify(items));
      const archive = menu.getByRole('menuitem', { name: '归档' });
      assert.equal(await archive.getAttribute('aria-disabled'), 'true', '归档占位应禁用');
      assert.equal(await archive.getAttribute('title'), '归档尚未实现，先占位。');
      await menu.getByRole('menuitem', { name: /^复制 Markdown/ }).click();
      await notes(page).locator('.toast').filter({ hasText: '未复制课程关联或画布卡片' }).waitFor({ timeout: 5000 });
      let copyId = null;
      await until(() => {
        const found = Object.values(fixture.read().resources).find(r => r.id !== id && r.markdown === text);
        if (found) copyId = found.id;
        return Boolean(found);
      }, '复制 Markdown 没有真实落盘');
      await saved(page);
      const store = fixture.read();
      assert.equal(store.resources[copyId].title, '复制源（副本）.md');
      assert.equal(store.resources[copyId].parent, store.resources[id].parent, '副本没有落在与原件同一目录');
      assert.equal(store.resources[copyId].origin?.mode, 'copy');
      assert.equal(store.layout.nodes.length, nodeCount, '复制自动加了画布卡片');
      assert.equal(await notes(page).locator('button[aria-label="打开 复制源（副本）.md"]').count(), 1, '树里没有副本行');
    });

    await guarded('左树拖入画布：只引用同一原件，不新建资源、不弹导入模式', async () => {
      const text = '# DRAG-REFERENCE\n';
      const id = await createNote(page, fixture, text, '拖入源.md');
      await notes(page).locator('.view-switch[aria-label="主视图"]').getByRole('button', { name: '画布', exact: true }).click();
      await notes(page).locator('.canvas-stage').waitFor({ state: 'visible', timeout: 10000 });
      const before = fixture.read();
      const row = notes(page).locator('.tree-row.tree-file').filter({ hasText: '拖入源.md' }).first();
      await row.dragTo(notes(page).locator('.canvas-stage'), { targetPosition: { x: 620, y: 400 } });
      assert.equal(await page.locator('[role=dialog][aria-label="选择导入模式"]').count(), 0, '内部拖动不该弹导入模式');
      await until(() => fixture.read().layout.nodes.length === before.layout.nodes.length + 1, '拖入后没有加画布卡片');
      await saved(page);
      const after = fixture.read();
      assert.equal(Object.keys(after.resources).length, Object.keys(before.resources).length, '内部拖动复制出了新资源');
      const added = after.layout.nodes.find(node => !before.layout.nodes.some(old => old.id === node.id));
      assert.equal(added.data?.contentId, id, '卡片没有引用同一原件');
      assert.equal(await notes(page).locator(`.react-flow__node:has([data-content-id="${id}"])`).count(), 1, '画布上没有该原件卡片');
    });

    await guarded('资源视图拖动文件和目录：换层级、拒绝循环、跨归属先确认，原稿和卡片不变', async () => {
      const tree = notes(page).locator('.resource-tree');
      const folderRow = name => tree.locator('.tree-row').filter({ has: page.getByRole('button', { name: name + ' 文件夹', exact: true }) });
      const fileRow = name => tree.locator('.tree-file').filter({ has: page.getByRole('button', { name: '打开 ' + name, exact: true }) });
      const before = fixture.read();
      const source = Object.values(before.resources).find(resource => resource.title === '拖入源.md');
      await fileRow(source.title).dragTo(folderRow('例子'));
      await until(() => fixture.read().resources[source.id]?.parent === 'examples', '同本移动没有落盘');
      await saved(page);
      await folderRow('例子').dragTo(folderRow('概念'));
      await until(() => fixture.read().layout.folders.some(folder => folder.id === 'examples' && folder.parent === 'notes'), '普通文件夹没有换层级');
      await saved(page);
      await folderRow('概念').dragTo(folderRow('例子'));
      assert.equal(await folderRow('概念').getAttribute('data-drop-target'), null);
      assert.equal(fixture.read().layout.folders.find(folder => folder.id === 'notes').parent, 'book');
      let asked = 0;
      page.once('dialog', async dialog => { asked++; await dialog.dismiss(); });
      await folderRow('例子').dragTo(folderRow('参考资料'));
      assert.equal(asked, 1, '跨归属未确认');
      assert.equal(fixture.read().layout.folders.find(folder => folder.id === 'examples').parent, 'notes');
      page.once('dialog', dialog => dialog.accept());
      await folderRow('例子').dragTo(folderRow('参考资料'));
      await until(() => fixture.read().layout.folders.some(folder => folder.id === 'examples' && folder.parent === 'references'), '跨归属移动没有落盘');
      await saved(page);
      const after = fixture.read();
      assert.deepEqual(after.resources[source.id], { ...source, parent: 'examples' });
      assert.deepEqual(after.layout.nodes, before.layout.nodes);
      assert.deepEqual(Object.keys(after.resources), Object.keys(before.resources));
      assert.equal(await fileRow(source.title).count(), 1);
    });

    await guarded('未知扩展名不在资源条目显示，右栏仅显示类型提示', async () => {
      await createNote(page, fixture, '# Extension content\n', '类型检查.md');
      page.once('dialog', dialog => dialog.accept());
      await renameViaMenu(page, '类型检查.md', '类型检查.md 的文件操作', '类型检查.unknown');
      await notes(page).getByRole('button', { name: '画布', exact: true }).click();
      const item = notes(page).getByRole('button', { name: '打开 类型检查.unknown', exact: true });
      await item.click();
      assert.doesNotMatch(await item.locator('..').innerText(), /不支持的文件/);
      const type = notes(page).locator('.right-panel .unsupported-note');
      await type.waitFor();
      assert.equal(await type.innerText(), '不支持的文件类型');
    });

    await guarded('笔记本目录菜单有「课程绑定」入口并打开绑定面板', async () => {
      await openMenu(page, '学习与理解');
      const menu = page.locator('[role="menu"][aria-label="学习与理解 的目录操作"]');
      const items = (await menu.getByRole('menuitem').allInnerTexts()).map(text => text.split('\n')[0].trim());
      assert.deepEqual(items, ['重命名', '课程绑定', '删除'], '笔记本目录菜单项不对：' + JSON.stringify(items));
      const bind = menu.getByRole('menuitem', { name: '课程绑定' });
      assert.equal(await bind.getAttribute('aria-disabled'), null, '已接线时「课程绑定」应可用');
      await bind.click();
      const panel = page.locator('[role=dialog][aria-label="课程绑定"]');
      await panel.waitFor({ state: 'visible', timeout: 5000 });
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached', timeout: 5000 });
    });


    await guarded('空目录删除：确认后落盘，选中目录回退到父目录', async () => {
      await createFolder(page, '临时夹');
      await until(() => fixture.read().layout.folders.some(f => f.name === '临时夹'), '新建文件夹没有落盘');
      await saved(page);
      const folderId = fixture.read().layout.folders.find(f => f.name === '临时夹').id;
      // 父目录取自建时的 picked 快照（前面点过文件时可能落在学习与理解，不一定是「概念」）。
      const parentId = fixture.read().layout.folders.find(f => f.id === folderId).parent;
      const parentName = fixture.read().layout.folders.find(f => f.id === parentId)?.name;
      await notes(page).locator(`button[aria-label="临时夹 文件夹"]`).click();
      await delay(80);
      assert.deepEqual(await activeRows(page), ['folder:临时夹'], '点击后没有高亮新目录');
      await openMenu(page, '临时夹');
      const deleteItem = page.locator('[role="menu"][aria-label="临时夹 的目录操作"]').getByRole('menuitem', { name: '删除' });
      assert.equal(await deleteItem.getAttribute('aria-disabled'), null, '空目录删除应该可用');
      page.once('dialog', dialog => dialog.accept());
      await deleteItem.click();
      await until(() => !fixture.read().layout.folders.some(f => f.id === folderId), '确认删除没有落盘');
      await saved(page);
      // 选中回退：「临时夹」挂在 parentName 下，删除后回退到父目录
      await until(async () => JSON.stringify(await activeRows(page)) === JSON.stringify([`folder:${parentName}`]), '删除后选中没有回退到父目录');
    });

    await guarded('空且未绑定的笔记本可删（保护判据放行）', async () => {
      await createNotebook(page, '临时本');
      await until(() => fixture.read().layout.folders.some(f => f.name === '临时本' && f.kind === 'notebook'), '新建笔记本没有落盘');
      await saved(page);
      const bookId = fixture.read().layout.folders.find(f => f.name === '临时本').id;
      await openMenu(page, '临时本');
      const deleteItem = page.locator('[role="menu"][aria-label="临时本 的目录操作"]').getByRole('menuitem', { name: '删除' });
      assert.equal(await deleteItem.getAttribute('aria-disabled'), null, '空且未绑定的笔记本删除应该可用');
      page.once('dialog', dialog => dialog.accept());
      await deleteItem.click();
      await until(() => !fixture.read().layout.folders.some(f => f.id === bookId), '笔记本删除没有落盘');
      await saved(page);
    });

    await guarded('根目录删除禁用并说明（保护判据：parent===null）', async () => {
      await openMenu(page, '我的资料');
      const deleteItem = page.locator('[role="menu"][aria-label="我的资料 的目录操作"]').getByRole('menuitem', { name: '删除' });
      assert.equal(await deleteItem.getAttribute('aria-disabled'), 'true');
      assert.ok((await deleteItem.textContent()).includes('根目录不可删除'));
      await page.keyboard.press('Escape');
    });

    await guarded('画布有节点的笔记本删除禁用（hasCanvasContent 经 App 传入）', async () => {
      // 用一个没有子目录/文件的全新笔记本：保证禁用理由走「画布上还有内容」分支，
      // 而不是被子目录/文件计数掩盖（学习与理解有子目录，理由串会先列子目录）。
      await createNotebook(page, '画布本');
      await until(() => fixture.read().layout.folders.some(f => f.name === '画布本'), '新建笔记本没有落盘');
      await saved(page);
      await notes(page).locator('button[aria-label="打开画布本画布"]').click();
      await notes(page).getByRole('button', { name: '添加纯内容节点', exact: true }).click();
      await notes(page).getByRole('textbox', { name: '纯节点内容', exact: true }).fill('WIRING-CANVAS-CANARY');
      await page.keyboard.press('Control+Enter');
      await until(() => fixture.read().layout.nodes.some(n => n.data?.text === 'WIRING-CANVAS-CANARY'), '画布节点没有落盘');
      await saved(page);
      await openMenu(page, '画布本');
      const deleteItem = page.locator('[role="menu"][aria-label="画布本 的目录操作"]').getByRole('menuitem', { name: '删除' });
      assert.equal(await deleteItem.getAttribute('aria-disabled'), 'true', '画布有节点的笔记本删除应该禁用');
      assert.ok((await deleteItem.textContent()).includes('画布上还有内容'), await deleteItem.textContent());
    });

    await guarded('回退目录与文件计数分支的删除禁用说明', async () => {
      // 概念是回退目录（FALLBACK_FOLDER_IDS，model 按 id 保护）：无论是否为空都禁删。
      await openMenu(page, '概念');
      const fallbackItem = page.locator('[role="menu"][aria-label="概念 的目录操作"]').getByRole('menuitem', { name: '删除' });
      assert.equal(await fallbackItem.getAttribute('aria-disabled'), 'true');
      assert.ok((await fallbackItem.textContent()).includes('未归属文件的默认去处'), await fallbackItem.textContent());
      await page.keyboard.press('Escape');
      // 文件计数分支：自建目录放一个文件，理由必须是「N 个文件」而非子目录/画布。
      await createFolder(page, '计数夹');
      await until(() => fixture.read().layout.folders.some(f => f.name === '计数夹'), '计数夹没有落盘');
      await saved(page);
      await notes(page).locator('button[aria-label="计数夹 文件夹"]').click();
      await createNote(page, fixture, '# COUNT-NOTE\n');
      await openMenu(page, '计数夹');
      const countItem = page.locator('[role="menu"][aria-label="计数夹 的目录操作"]').getByRole('menuitem', { name: '删除' });
      assert.equal(await countItem.getAttribute('aria-disabled'), 'true');
      assert.ok((await countItem.textContent()).includes('1 个文件'), await countItem.textContent());
      await page.keyboard.press('Escape');
    });

    await guarded('拖入文件→副本模式：真实落盘资源与画布节点（写管线正控）', async () => {
      const nodeCount = fixture.read().layout.nodes.length;
      const dataTransfer = await page.evaluateHandle(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['# DROP-COPY-CANARY\n'], 'drop-copy.md', { type: 'text/markdown' }));
        return dt;
      });
      await notes(page).locator('.canvas-stage').dispatchEvent('drop', { dataTransfer });
      await page.locator('[aria-label="以副本模式导入"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('[aria-label="以副本模式导入"]').click();
      let copyId = null;
      await until(() => {
        const found = Object.values(fixture.read().resources).find(r => r.markdown === '# DROP-COPY-CANARY\n');
        if (found) copyId = found.id;
        return !!found;
      }, '拖放副本没有真实落盘为资源');
      await saved(page);
      await until(() => fixture.read().layout.nodes.some(n => n.data?.contentId === copyId), '拖放副本没有生成画布节点');
      assert.equal(fixture.read().layout.nodes.length, nodeCount + 1, '画布节点数量应恰好 +1');
    });

    await guarded('废纸篓内容节点也阻断笔记本删除（hasCanvasContent 节点口径）', async () => {
      // 直接写库造状态：trashed 资源的 parent 挂在「参考」下（资源口径 folderIsEmpty
      // 看不到它），但画布节点 notebookId 指向学习与理解。若删除放行，这个节点会失去
      // 归属（activeNotebook 守卫让它永久不可见）——所以节点口径必须拦。
      // 注意 writeNotes* 的 expectedVersion:null 只对「文件不存在」合法；改已存在的
      // layout.json 必须传当前 layoutVersion（sha256），否则 409。
      // 学习与理解此刻是唯一笔记本，model 的「最后一本」优先级高于非空——先建陪跑本，
      // 才能让禁用理由走到画布/非空分支。
      await createNotebook(page, '陪跑本');
      await until(() => fixture.read().layout.folders.some(f => f.name === '陪跑本' && f.kind === 'notebook'), '陪跑本没有落盘');
      await saved(page);
      const store = fixture.read();
      // 本套件前面的「复制 Markdown」「左树拖入画布」用例会在学习与理解根目录留下文件，
      // 文件计数分支会先于画布分支命中。先把这些文件挪到「概念」，让禁用理由只走画布口径。
      for (const resource of Object.values(store.resources)) {
        if (resource.parent !== 'book' || resource.trashed) continue;
        const moved = writeNotesResource({ home: fixture.home, resource: { ...resource, parent: 'concepts' }, expectedVersion: store.resourceVersions[resource.id] });
        assert.ok(moved.ok, '搬走根目录文件失败: ' + (moved.ok ? '' : moved.message));
      }
      const resourceWrite = writeNotesResource({ home: fixture.home, resource: { id: 'trashcanary', type: 'note', title: '废纸篓样例.md', markdown: '# TRASHED-CANARY\n', parent: 'references', trashed: true }, expectedVersion: null });
      assert.ok(resourceWrite.ok, '废纸篓资源写入失败: ' + (resourceWrite.ok ? '' : resourceWrite.message));
      const layoutWrite = writeNotesLayout({ home: fixture.home, layout: { ...store.layout, folders: store.layout.folders.filter(f => f.parent !== 'book' || f.kind === 'notebook'), nodes: [...store.layout.nodes, { id: 'trash-node', type: 'knowledge', position: { x: 0, y: 0 }, data: { contentId: 'trashcanary', notebookId: 'book' } }] }, expectedVersion: store.layoutVersion });
      assert.ok(layoutWrite.ok, '废纸篓场景 layout 写入失败: ' + (layoutWrite.ok ? '' : layoutWrite.message));
      await enterNotes(page, fixture.origin);
      await ready(page);
      await openMenu(page, '学习与理解');
      const deleteItem = page.locator('[role="menu"][aria-label="学习与理解 的目录操作"]').getByRole('menuitem', { name: '删除' });
      assert.equal(await deleteItem.getAttribute('aria-disabled'), 'true', '废纸篓内容节点的笔记本删除应该禁用');
      assert.ok((await deleteItem.textContent()).includes('画布上还有内容'), await deleteItem.textContent());
      await page.keyboard.press('Escape');
    });

    await guarded('最后一本笔记本：树菜单判据（model）与 App 层双门一致', async () => {
      // 重写库为 [library, book] 两目录、零节点：book 成为唯一笔记本。model
      // （resource-tree-model.js:59）的「最后一本」已上线——菜单应禁用并说明；
      // App 层 deleteFolder 的同语义第二道门仍在（防御纵深，UI 到不了）。
      const store = fixture.read();
      const kept = store.layout.folders.filter(f => f.id === 'library' || f.id === 'book');
      const layoutWrite = writeNotesLayout({ home: fixture.home, layout: { ...store.layout, folders: kept, nodes: [], edges: [] }, expectedVersion: store.layoutVersion });
      assert.ok(layoutWrite.ok, '最后一本场景 layout 写入失败: ' + (layoutWrite.ok ? '' : layoutWrite.message));
      await enterNotes(page, fixture.origin);
      await ready(page);
      await openMenu(page, '学习与理解');
      const deleteItem = page.locator('[role="menu"][aria-label="学习与理解 的目录操作"]').getByRole('menuitem', { name: '删除' });
      assert.equal(await deleteItem.getAttribute('aria-disabled'), 'true', '最后一本笔记本的删除应该被禁用');
      assert.ok((await deleteItem.textContent()).includes('最后一本笔记本'), await deleteItem.textContent());
      await page.keyboard.press('Escape');
      await delay(1200);
      assert.ok(fixture.read().layout.folders.some(f => f.id === 'book'), '最后一本笔记本被删除了');
    });

    await guarded('删除活动笔记本：等待保存→刷新后恢复回退本视口，其他数据保留', async () => {
      // 接续上一场景（folders=[library, book]）：外部写库给新建的「第二本」一个
      // 独特视口，删掉活动的「学习与理解」→ App 把相机切到回退本；删除自身的
      // layout 提交必须已快照新相机（effect 在 setViewport(duration:0) 同步生效后
      // 才读 getViewport），刷新后不得落回已删本的相机。
      await createNotebook(page, '第二本');
      await until(() => fixture.read().layout.folders.some(f => f.name === '第二本' && f.kind === 'notebook'), '第二本没有落盘');
      await saved(page);
      const before = fixture.read();
      const resourceCount = Object.keys(before.resources).length;
      const second = before.layout.folders.find(f => f.name === '第二本');
      const write = writeNotesLayout({ home: fixture.home, layout: { ...before.layout, folders: before.layout.folders.map(f => f.id === second.id ? { ...f, viewport: { x: 777, y: 555, zoom: 0.8 } } : f) }, expectedVersion: before.layoutVersion });
      assert.ok(write.ok, '第二本视口写入失败: ' + (write.ok ? '' : write.message));
      await enterNotes(page, fixture.origin);
      await ready(page);
      await openMenu(page, '学习与理解');
      const deleteItem = page.locator('[role="menu"][aria-label="学习与理解 的目录操作"]').getByRole('menuitem', { name: '删除' });
      assert.equal(await deleteItem.getAttribute('aria-disabled'), null, '两本笔记本时删活动的这本应该可用');
      page.once('dialog', dialog => dialog.accept());
      await deleteItem.click();
      await until(() => !fixture.read().layout.folders.some(f => f.id === 'book'), '活动笔记本没有删除落盘');
      await saved(page);
      await delay(300); // 给删除提交与任何后续布局写留出完成时间
      const after = fixture.read();
      assert.deepEqual(after.layout.folders.map(f => f.id).sort(), ['library', second.id].sort(), '删除后目录集合不对');
      assert.equal(Object.keys(after.resources).length, resourceCount, '资源不应被删除波及');
      // 刷新：恢复的全局 viewport 必须是回退本（第二本）写入的相机，不是已删本的
      await enterNotes(page, fixture.origin);
      await ready(page);
      const matrix = await page.evaluate(() => document.querySelector('.studymate-notes .react-flow__viewport')?.style.transform || '');
      // react-flow 写的是 translate(777px, 555px) scale(0.8)（或 matrix(a,b,c,d,e,f)）
      let zoom = NaN, tx = NaN, ty = NaN;
      const t = matrix.match(/translate\(([-\d.e]+)(px)?,\s*([-\d.e]+)(px)?\)\s*scale\(([-\d.e]+)\)/);
      const mx = matrix.match(/matrix\(([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+)\)/);
      if (t) { tx = Number(t[1]); ty = Number(t[3]); zoom = Number(t[5]); }
      else if (mx) { tx = Number(mx[5]); ty = Number(mx[6]); zoom = Number(mx[4]); }
      else assert.fail('读不到画布视口 transform: ' + matrix);
      assert.ok(Math.abs(zoom - 0.8) < 0.01, `刷新后 zoom 不是回退本的 0.8（实际 ${zoom}）`);
      assert.ok(Math.abs(tx - 777) < 1 && Math.abs(ty - 555) < 1, `刷新后平移不是回退本的 (777,555)（实际 (${tx},${ty})）`);
    });

    await guarded('正常 dirty 不闪草稿按钮；保存失败与冲突的恢复入口保留', async () => {
      const ghostBtn = name => notes(page).getByRole('button', { name, exact: true });
      const id = await createNote(page, fixture, '# DRAFT-NOTE\n');
      const editor = notes(page).locator('.note-editor .markdown-inline-editor .cm-content[role="textbox"]');
      await editor.waitFor({ state: 'visible', timeout: 12000 });
      await editor.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText('# DRAFT-TYPING\n');
      // 自动保存防抖/在途的 dirty 窗口内持续采样：草稿恢复按钮不得闪现
      let flashed = 0;
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline) {
        if (await ghostBtn('导出本地草稿').count()) flashed++;
        await delay(30);
      }
      assert.equal(flashed, 0, '普通 dirty 期间草稿恢复按钮闪现');
      await saved(page);
      assert.equal(await ghostBtn('导出本地草稿').count(), 0, '保存成功后草稿按钮仍显示');

      // 保存失败：ERROR 稳定态必须给出恢复入口
      fixture.controls.writeFault = { status: 503, code: 'write-failed', message: '测试保存失败' };
      expectedFaults.add(503);
      await editor.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText('# FAULT-DRAFT\n');
      await notes(page).locator('.persistence-badge[data-state="error"]').waitFor({ timeout: 12000 });
      assert.equal(await ghostBtn('导出本地草稿').count(), 1, 'ERROR 态缺导出草稿入口');
      assert.equal(await ghostBtn('放弃本地，重新载入').count(), 1, 'ERROR 态缺重载入口');
      assert.equal(await ghostBtn('重试保存').count(), 1, 'ERROR 态缺重试入口');
      fixture.controls.writeFault = null;
      await ghostBtn('重试保存').click();
      await saved(page);
      assert.equal(await ghostBtn('导出本地草稿').count(), 0, '错误恢复后草稿按钮没有消失');

      // 冲突：409 后冲突条与恢复入口都在，明确 keep 后保存最新草稿
      fixture.controls.pauseWrites = true;
      expectedFaults.add(409);
      await editor.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText('# CONFLICT-DRAFT-1\n');
      await until(() => fixture.requests.some(r => r.status === null && r.body?.resource?.id === id), '没有在途写入');
      externalMarkdown(fixture, id, '# EXTERNAL-WINS\n');
      await editor.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText('# CONFLICT-DRAFT-2\n');
      fixture.controls.releaseWrites();
      await notes(page).locator('.persistence-badge[data-state="conflict"]').waitFor({ timeout: 12000 });
      assert.equal(await ghostBtn('导出本地草稿').count(), 1, '冲突态缺导出草稿入口');
      const keepBtn = ghostBtn('保留本地并重试保存');
      assert.equal(await keepBtn.count(), 1, '冲突态缺冲突条入口');
      page.once('dialog', dialog => dialog.accept());
      await keepBtn.click();
      await until(() => fixture.read().resources[id]?.markdown === '# CONFLICT-DRAFT-2\n', '冲突 keep 没有保存最新草稿');
      await saved(page);
      assert.equal(await ghostBtn('导出本地草稿').count(), 0, '冲突恢复后草稿按钮没有消失');
      expectedFaults.delete(409);
      expectedFaults.delete(503);
    });

    await guarded('载入失败时 canEdit=false：树菜单按钮禁用', async () => {
      fixture.controls.readFault = { status: 503, code: 'read-failed', message: '测试读失败' };
      allowFault = true;
      await enterNotes(page, fixture.origin);
      await notes(page).locator('.persistence-gate--error').waitFor({ timeout: 15000 });
      const moreButtons = notes(page).locator('.tree-more');
      assert.ok(await moreButtons.count() > 0, '只读态树里没有更多操作按钮');
      const disabled = await moreButtons.evaluateAll(els => els.every(el => el.disabled));
      assert.equal(disabled, true, '只读态更多操作按钮应全部禁用');
      // 拖放写入门禁（只读态负控）：drop() 本身不设门（会先弹模式对话框），拒绝发生在
      // applyDropMode 入口——store 必须一个字都不动。
      const beforeCount = Object.keys(fixture.read().resources).length;
      const dataTransfer = await page.evaluateHandle(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['# DROP-READONLY-CANARY\n'], 'drop-readonly.md', { type: 'text/markdown' }));
        return dt;
      });
      await notes(page).locator('.canvas-stage').dispatchEvent('drop', { dataTransfer });
      await page.locator('[aria-label="以副本模式导入"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('[aria-label="以副本模式导入"]').click();
      await notes(page).locator('.toast').filter({ hasText: '导入被拒绝' }).waitFor({ timeout: 5000 });
      await delay(400);
      const after = fixture.read();
      assert.equal(Object.keys(after.resources).length, beforeCount, '只读态拖放副本创建了资源');
      assert.ok(!Object.values(after.resources).some(r => (r.markdown || '').includes('DROP-READONLY-CANARY')), '只读态拖放内容进入 store');
    });

    check('全程无控制台/页面/失败请求（预期内 503 除外）', problems.length === 0, problems.join(' | '));
  } finally {
    fixture.controls.readFault = null;
    await context.close();
  }

  fs.writeFileSync(path.join(OUT, 'wiring-report.json'), JSON.stringify({ checks: results.length, failures, results }, null, 2));
  console.log(`\n${results.length - failures}/${results.length} 项通过；截图与报告 ${path.relative(ROOT, OUT)}`);
  if (failures) process.exitCode = 1;
} finally {
  await browser.close();
  if (fixture) await fixture.close();
}
