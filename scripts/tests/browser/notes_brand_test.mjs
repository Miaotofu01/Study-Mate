/* 品牌两面切换（#262）与内页品牌去重（#268）。
   正式组合产物 + 真 React/Edge + 真 notes HTTP/临时 HOME；只显式 fixture seedDemo。
   产品首次空库不会写演示。保留唯一学习侧栏、原生 inert、DOM 保活与隐藏快捷键反证。
   不连接真实 DSH/模型；缺浏览器二进制才退出码 3，其他依赖/源码问题必须红。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, buildFormalNotesClient, loadNotesPlaywright, isMissingEdge, startNotesHostFixture,
} from '../fixtures/notes_host_fixture.mjs';

const VIEWPORT = { width: 1280, height: 900 };
const SHOTS = process.env.STUDYMATE_NOTES_SHOTS || path.join(ROOT, '.preview', 'notes-brand');
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

async function waitSurface(page, name) {
  await page.waitForFunction(surface => {
    const node = document.querySelector(`[data-proto="${surface}-surface"]`);
    if (!node) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none' && node.getBoundingClientRect().width > 100;
  }, name, { timeout: 10000 });
}

async function surfaceVisible(page, name) {
  return page.evaluate(surface => {
    const node = document.querySelector(`[data-proto="${surface}-surface"]`);
    if (!node) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }, name);
}

// 在创建任何临时数据域前构建、核对依赖并启动浏览器；缺 Edge 时没有待清理的服务器。
buildFormalNotesClient();
const playwright = await loadNotesPlaywright();
const { chromium } = playwright.default || playwright;
let browser;
try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (error) {
  if (!isMissingEdge(error)) throw error;
  console.error('跳过 notes-brand：需要已安装的 Microsoft Edge；退出码 3，不算通过。\n' + error.message);
  process.exit(3);
}

let fixture;
fs.mkdirSync(SHOTS, { recursive: true });
try {
  fixture = await startNotesHostFixture({ seedDemo: true, build: false });
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'light', reducedMotion: 'reduce', locale: 'zh-CN', deviceScaleFactor: 1 });
  const page = await context.newPage();
  const problems = [];
  page.on('console', message => { if (message.type() === 'error') problems.push('console: ' + message.text()); });
  page.on('pageerror', error => problems.push('pageerror: ' + (error.stack || error.message)));
  page.on('requestfailed', request => problems.push('requestfailed: ' + request.url() + ' ' + (request.failure()?.errorText || '')));
  page.on('response', response => { if (response.status() >= 400) problems.push(`status ${response.status()}: ${response.url()}`); });
  page.on('request', request => {
    const url = request.url();
    if (/^(data|blob|about):/.test(url)) return;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(url)) problems.push('external: ' + url);
  });
  const shot = name => page.screenshot({ path: path.join(SHOTS, name + '.png'), animations: 'disabled' });
  try {
    await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    try { await page.locator('.smb-brand').waitFor({ timeout: 15000 }); }
    catch (error) {
      console.error('BOOT PROBLEMS:\n' + problems.join('\n'));
      console.error('BODY:\n' + (await page.locator('body').innerText()).slice(0, 2000));
      throw error;
    }

    await guarded('宿主一个 main（studymate），children 同时声明学习/笔记会话座位', async () => {
      const probe = await page.evaluate(() => ({ regs: window.__probe.registrations, selects: window.__probe.layoutSelects, applied: window.__probe.applied }));
      assert.equal(probe.applied, true);
      const mains = probe.regs.filter(spec => spec.name === 'main');
      assert.equal(mains.length, 1, JSON.stringify(probe.regs));
      assert.equal(mains[0].key, 'studymate');
      assert.deepEqual(Object.keys(mains[0].children).sort(), ['studymate.ask.session', 'studymate.notes.session']);
      for (const seat of Object.values(mains[0].children)) assert.equal(seat.scope, 'session');
      assert.equal(probe.selects, 0);
    });

    await guarded('侧栏只登记学习，笔记不注册独立入口', async () => {
      const regs = await page.evaluate(() => window.__probe.registrations);
      const sidebar = regs.filter(spec => spec.name === 'sidebar.panellist');
      assert.equal(sidebar.length, 1, JSON.stringify(sidebar));
      assert.equal(sidebar[0].id, 'studymate');
      assert.equal(sidebar[0].label, '学习');
      assert.equal(regs.some(spec => spec.key === 'studymate-notes'), false);
    });

    await waitSurface(page, 'learning');
    await guarded('学习态品牌换面入口和放大字号保留；学习工作台承接原主页', async () => {
      assert.deepEqual((await page.locator('.smb-brand__name').allTextContents()).map(x => x.trim()), ['StudyMate', '无界笔记']);
      assert.equal(await page.locator('.smb-brand__mark').innerText(), '学');
      assert.equal((await page.locator('[data-proto="workspace-home"]').innerText()).trim(), '学习工作台');
      assert.equal(await page.getByRole('button', { name: '主页', exact: true }).count(), 0);
      const brand = await page.locator('.smb-brand').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
      const crumb = await page.locator('.smb-crumb').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
      assert.ok(brand >= crumb * 1.15, `品牌 ${brand}px vs 普通操作 ${crumb}px`);
    });
    await shot('01-learning-home');

    await guarded('学习内部科目导航照旧', async () => {
      await page.locator('.smb-course').first().click();
      await page.waitForFunction(() => document.querySelector('.smb-subhead__title') || document.querySelector('.smb-hero__title'), null, { timeout: 8000 });
      assert.ok(await page.locator('.smb-crumb').count() >= 2);
      await page.locator('[data-proto="workspace-home"]').click();
      await page.locator('.smb-hero__title').waitFor({ timeout: 8000 });
    });

    await guarded('首次点击才懒挂笔记；顺序交换、绿底白色∞、两面原生 inert 正确', async () => {
      assert.equal(await page.locator('.studymate-notes').count(), 0);
      await page.locator('[data-proto="brand-switch"]').click();
      await waitSurface(page, 'notes');
      await page.locator('.studymate-notes .react-flow').waitFor({ timeout: 15000 });
      await page.waitForFunction(() => !document.querySelector('.studymate-notes .persistence-gate'), null, { timeout: 15000 });
      const surfaces = await page.evaluate(() => {
        const read = name => { const el = document.querySelector(`[data-proto="${name}-surface"]`); return { inert: el.inert, attr: el.hasAttribute('inert'), aria: el.getAttribute('aria-hidden') }; };
        return { learning: read('learning'), notes: read('notes') };
      });
      assert.deepEqual(surfaces, { learning: { inert: true, attr: true, aria: 'true' }, notes: { inert: false, attr: false, aria: null } });
      assert.deepEqual((await page.locator('.smb-brand__name').allTextContents()).map(x => x.trim()), ['无界笔记', 'StudyMate']);
      assert.equal(await page.locator('[data-proto="brand-switch"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.smb-brand__mark svg path[d^="M10 24"]').count(), 1);
      assert.equal(await page.locator('.smb-brand__mark svg rect[fill="#1c7164"]').count(), 1);
    });

    await guarded('内页不再重复品牌图标/名称，外层品牌和工具栏仍在', async () => {
      assert.equal(await page.locator('.studymate-notes .brand-icon, .studymate-notes .brand-name').count(), 0);
      assert.equal(await page.locator('.smb-brand').count(), 1);
      assert.equal(await page.locator('.studymate-notes .left-panel .notes-create-trigger').count(), 1);
      assert.equal(await page.locator('.studymate-notes button[aria-label="新建笔记"]').count(), 0);
      assert.equal(await page.locator('.studymate-notes .canvas-toolbar').count(), 1);
    });

    await guarded('显式 fixture 的4张存量示例可载入，主动适应后都在可视区', async () => {
      await page.waitForFunction(() => document.querySelectorAll('.studymate-notes .react-flow__minimap-node').length === 4, null, { timeout: 15000 });
      await page.locator('.studymate-notes button[aria-label="适应全部卡片"]').click();
      await page.waitForFunction(() => {
        const stage = document.querySelector('.studymate-notes .canvas-stage').getBoundingClientRect();
        const nodes = [...document.querySelectorAll('.studymate-notes .react-flow__node')];
        return nodes.length === 4 && nodes.every(node => { const r = node.getBoundingClientRect(); return r.width > 10 && r.height > 10 && r.left >= stage.left && r.right <= stage.right && r.top >= stage.top && r.bottom <= stage.bottom; });
      }, null, { timeout: 10000 });
    });
    await shot('02-notes-surface');

    await guarded('新建笔记切走再切回：同DOM且正文资源仍在', async () => {
      await page.locator('.studymate-notes .left-panel .panel-header .notes-create-trigger').click();
      await page.locator('.studymate-notes [role="menu"][aria-label="新建资源"]').getByRole('menuitem', { name: '新建笔记', exact: true }).click();
      const dialog = page.locator('[role=dialog][aria-label="新建笔记"]');
      await dialog.getByRole('button', { name: '创建', exact: true }).click();
      await dialog.waitFor({ state: 'detached', timeout: 8000 });
      await page.waitForFunction(() => [...document.querySelectorAll('.studymate-notes .tree-row')].some(row => row.textContent.includes('未命名.md')), null, { timeout: 8000 });
      await page.evaluate(() => { window.__notesElement = document.querySelector('.studymate-notes'); });
      await page.locator('[data-proto="brand-switch"]').click();
      await waitSurface(page, 'learning');
      await page.locator('[data-proto="brand-switch"]').click();
      await waitSurface(page, 'notes');
      assert.equal(await page.evaluate(() => window.__notesElement === document.querySelector('.studymate-notes')), true);
      assert.equal(await page.locator('.studymate-notes .tree-row', { hasText: '未命名.md' }).count(), 1);
    });
    await shot('03-notes-after-roundtrip');

    await guarded('笔记前台快捷键 V/H 生效', async () => {
      await page.locator('.studymate-notes .view-switch[aria-label="主视图"] button', { hasText: '画布' }).click();
      await page.keyboard.press('v');
      await page.waitForFunction(() => document.querySelector('.studymate-notes .canvas-toolbar button[aria-label="选择工具"]')?.classList.contains('active'));
      await page.keyboard.press('h');
      await page.waitForFunction(() => document.querySelector('.studymate-notes .canvas-toolbar button[aria-label="平移工具"]')?.classList.contains('active'));
    });

    await guarded('学习态按1/V/Space不改隐藏画布视口/工具，不挂平移层', async () => {
      const before = await page.locator('.studymate-notes .react-flow__viewport').getAttribute('style');
      await page.locator('[data-proto="brand-switch"]').click();
      await waitSurface(page, 'learning');
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
      await page.keyboard.press('1');
      await page.keyboard.press('v');
      await page.keyboard.down('Space');
      await page.waitForTimeout(250);
      assert.equal(await page.locator('.studymate-notes .pan-capture-layer').count(), 0);
      await page.keyboard.up('Space');
      assert.equal(await page.locator('.studymate-notes .react-flow__viewport').getAttribute('style'), before);
      await page.locator('[data-proto="brand-switch"]').click();
      await waitSurface(page, 'notes');
      assert.equal(await page.locator('.studymate-notes .canvas-toolbar button[aria-label="平移工具"]').evaluate(el => el.classList.contains('active')), true);
    });

    const bar = page.locator('.smb-topbar');
    const motion = bar.locator('.smb-motionpick select');
    const font = bar.locator('.smb-fontpick select');
    const switchBrand = () => bar.locator('[data-proto="brand-switch"]').click();

    await guarded('无界的 Markdown 预览和编辑器响应字号，动效应用到实际控件', async () => {
      const sample = page.locator('.studymate-notes .side-panel.left-panel');
      const elapsed = () => sample.evaluate(el => Math.max(...getComputedStyle(el).transitionDuration.split(',').map(parseFloat)));
      const durations = [];
      for (const level of ['full', 'reduced', 'off', 'auto']) {
        await motion.selectOption(level);
        durations.push(await elapsed());
      }
      assert.ok(durations[0] > durations[1] && durations[1] > 0, JSON.stringify(durations));
      assert.equal(durations[2], 0);
      assert.equal(durations[3], durations[1], '系统减少动效时 auto 应走减弱档');

      const assertSize = async (name, content) => {
        const readSize = () => content.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
        await font.selectOption('standard');
        const standard = await readSize();
        await font.selectOption('xlarge');
        assert.ok(await readSize() > standard, `${name} 没应用特大字号`);
      };
      await assertSize('画布预览', page.locator('.studymate-notes #card-body-card-recall.markdown-preview'));
      await page.locator('.studymate-notes button[aria-label="打开 未命名.md"]').dblclick();
      await assertSize('文档编辑', page.locator('.studymate-notes .document-stage .cm-content'));
    });

    await guarded('宽档和窄档顶栏等高，两面共用字号和动效，搜索与导航只留在学习', async () => {
      try {
        await font.selectOption('xlarge');
        await motion.selectOption('off');
        for (const width of [VIEWPORT.width, 478]) {
          await page.setViewportSize({ ...VIEWPORT, width });
          const measure = () => bar.evaluate(el => ({
            height: el.getBoundingClientRect().height,
            overflow: el.scrollWidth - el.clientWidth,
          }));
          assert.equal(await bar.locator('.smb-crumbs, .smb-searchbtn').count(), 0);
          const notesBox = await measure();
          await switchBrand();
          await waitSurface(page, 'learning');
          const learningBox = await measure();
          assert.equal(learningBox.height, notesBox.height, `${width}px：${JSON.stringify({ learningBox, notesBox })}`);
          assert.ok(learningBox.overflow <= 1 && notesBox.overflow <= 1);
          assert.equal(await font.inputValue(), 'xlarge');
          assert.equal(await motion.inputValue(), 'off');
          assert.equal(await bar.locator('.smb-searchbtn').count(), 1);
          await switchBrand();
          await waitSurface(page, 'notes');
        }
      } finally {
        await page.setViewportSize(VIEWPORT);
      }
    });

    await guarded('切回后工作台面包屑仍可用', async () => {
      if (await surfaceVisible(page, 'notes')) await switchBrand();
      await waitSurface(page, 'learning');
      await font.selectOption('standard');
      await motion.selectOption('auto');
      await page.locator('[data-proto="workspace-home"]').click();
      await waitSurface(page, 'learning');
      await page.locator('.smb-hero__title').waitFor({ timeout: 8000 });
      assert.equal(await surfaceVisible(page, 'notes'), false);
      assert.equal(await page.locator('.smb-brand__name').first().innerText(), 'StudyMate');
      const hidden = await page.locator('[data-proto="notes-surface"]').evaluate(el => ({ attr: el.hasAttribute('inert'), prop: el.inert, aria: el.getAttribute('aria-hidden'), visibility: getComputedStyle(el).visibility, opacity: getComputedStyle(el).opacity }));
      assert.deepEqual(hidden, { attr: true, prop: true, aria: 'true', visibility: 'hidden', opacity: '0' });
    });
    await shot('04-back-to-learning');

    check('真实 notes HTTP已被使用，无控制台/页面/失败/外网请求', fixture.requests.some(r => r.method === 'GET' && r.status === 200) && problems.length === 0 && fixture.problems.length === 0, [...problems, ...fixture.problems].join('\n'));
  } finally { await context.close(); }

  fs.writeFileSync(path.join(SHOTS, 'brand-report.json'), JSON.stringify({ checks: results.length, failures, results }, null, 2));
  console.log(`\n${results.length - failures}/${results.length} 项通过；截图 ${path.relative(ROOT, SHOTS)}`);
  if (failures) process.exitCode = 1;
} finally {
  await browser.close();
  if (fixture) await fixture.close();
}
