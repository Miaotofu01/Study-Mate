// #270 学习端「节点 ↔ Markdown 笔记」接线的真浏览器验收。
//
// 这里只走产品路径：真 Edge、正式组合客户端、临时 HOME 下的真实 notes HTTP/数据域。
// 场景覆盖票面八条：空节点也出现在左栏、首次新建先定默认本、左右两边编辑同一份原稿、
// 跨节点拖动只改关联、换默认本不搬旧文件、无界节点视图同一分类、课程卡只读且能精确跳回、
// 多本画布隔离并恢复相机。没有 seedDemo——笔记全部由界面创建，避免夹具替产品写数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROOT, buildFormalNotesClient, isMissingEdge, loadNotesPlaywright, startNotesHostFixture,
} from '../fixtures/notes_host_fixture.mjs';

const SHOT_DIR = path.join(ROOT, '.preview', 'notes-curriculum');
const WORKSPACE = path.join(os.tmpdir(), 'studymate-notes-curriculum-workspace');
const SCREENSHOT = (page, name) => page.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: false });

function hostTokenCss() {
  const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/tests/fixtures/host-theme-tokens.json'), 'utf8'));
  const block = values => Object.entries(values).map(([key, value]) => `${key}:${value}`).join(';');
  return `body{${block(snapshot.light)};color-scheme:light}body[data-ds-dark-theme]{${block(snapshot.dark)};color-scheme:dark}body{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}`;
}

async function assertNotesContrast(page, label) {
  const samples = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = color => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      const data = ctx.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2], data[3] / 255];
    };
    const blend = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
    const luminance = color => color.map(v => { const s = v / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; })
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const selectors = [
      '.learning-notes-tree .notes-status', '.learning-notes-tree .notes-help',
      '.learning-notes-tree .notes-empty-node', '.learning-notes-tree .notes-node-heading span',
      '.learning-notes-tree .notes-node-heading small', '.learning-notes-tree button',
      '.learning-notes-panel .notes-status', '.learning-notes-panel input[aria-label="学习笔记标题"]',
      '.learning-notes-panel .notes-actions select', '.learning-notes-panel .notes-help',
      '.learning-notes-panel .md-format-toolbar select', '.learning-notes-panel .md-format-toolbar button',
      '.learning-notes-panel .md-format-toolbar label', '.learning-notes-panel .md-format-toolbar input',
      '.learning-notes-panel .markdown-inline-editor .cm-line', '.learning-notes-panel .markdown-inline-editor .cm-line span',
      '.learning-notes-panel .markdown-inline-editor .md-syntax', '.learning-notes-panel .markdown-inline-editor .tok-keyword',
      '.learning-notes-panel .markdown-inline-editor table th', '.learning-notes-panel .markdown-inline-editor table td',
      '.learning-notes-panel .cm-content', '.learning-notes-panel .cm-gutterElement',
      '.learning-notes-panel .markdown-preview', '.learning-notes-panel .markdown-preview h1',
      '.learning-notes-panel .markdown-preview th', '.learning-notes-panel .markdown-preview td',
      '.learning-notes-panel .markdown-preview code span',
    ];
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)].flatMap(el => {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      if (style.visibility !== 'visible' || !rect.width || !rect.height || el.disabled
        || rect.bottom < 0 || rect.top > innerHeight || !(el.value || el.textContent).trim()) return [];
      const ancestors = []; for (let at = el; at; at = at.parentElement) ancestors.unshift(at);
      let bg = [255, 255, 255], opacity = 1;
      for (const ancestor of ancestors) {
        const computed = getComputedStyle(ancestor);
        bg = blend(rgba(computed.backgroundColor), bg); opacity *= Number(computed.opacity);
      }
      const color = rgba(style.color); color[3] *= opacity;
      const fg = blend(color, bg), a = luminance(fg), b = luminance(bg);
      return [{ selector, text: (el.value || el.textContent).trim().slice(0, 32), color: style.color,
        background: bg, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }];
    }));
  });
  assert.ok(samples.length >= 14, label + '：必须实际采到左右侧栏和编辑区，不得空转');
  const failures = samples.filter(sample => sample.ratio < 4.5);
  assert.deepEqual(failures, [], label + '：可见文字合成背景后的对比度应达到 WCAG AA 4.5:1');
  console.log(`对比度 ${label}：${samples.length} 个采样点，最低 ${Math.min(...samples.map(sample => sample.ratio)).toFixed(2)}:1`);
}

function node(id, title, lessonMarkdown, number) {
  return {
    id, title, kind: '概念', objective: '验证学习端与无界笔记共用同一份节点笔记。',
    problem: '', concepts: [], pitfalls: [], realworld: '', practice: '', resources: [],
    prerequisites: [], level: 0, tier: '学习中', raw_status: '学习中', notes: '', number,
    lesson_md: lessonMarkdown, lesson: 'demo/lessons/' + number + '-' + id + '.md',
    pool: {}, anchors: [], orphan_keys: [], orphans: [], question_kinds: {},
    attempts: { present: false, version: 0, questions: {} },
  };
}

const lessonA = [
  '---', 'title: 课程甲', '---', '',
  '## 第一节', '',
  '课程甲正文：这是从学习工作区读出来的真课件，不会被复制进笔记库。', '',
].join('\n');
const lessonB = [
  '---', 'title: 课程乙', '---', '',
  '## 乙的第一节', '',
  '课程乙正文：拖课程卡时只带来源，不带正文。', '',
].join('\n');

function curriculumLibrary() {
  const makeNode = (id, title, lesson, number) => node(id, title, lesson, number);
  const subject = {
    slug: 'demo', name: '课程科目', goal: '把节点笔记接进学习端。', status: '学习中',
    created_at: '2026-01-02T03:04:05+08:00', updated_at: '2026-12-31T10:00:00+08:00',
    project: '节点笔记接线', mission: { goal: '', done: [], todo: [] },
    glossary: [], resources_md: '', reference: [], reference_version: 1,
    misconceptions: [], misconception_library: [], misconception_issues: [], records: [],
    nodes: [
      makeNode('course-a', '课程甲', lessonA, '0001'),
      // 没有笔记、也没有课件的节点同样要出现在左栏；学习右栏仍可打开它的笔记。
      makeNode('course-b', '课程乙', lessonB, '0002'),
      makeNode('course-c', '课程丙', '', '0003'),
    ],
    levels: 1,
    stats: { 未开始: 0, 学习中: 3, 已学完: 0 },
    continue_node: 'course-a', order: ['course-a', 'course-b', 'course-c'],
  };
  return {
    workspace: WORKSPACE,
    generated_at: '2026-02-01T10:00:00+08:00', today: '2026-02-01', memory_md: '',
    subjects: [subject],
  };
}

async function waitFor(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('等待超时：' + message + (last ? '（' + last.message + '）' : ''));
}

const noteEntries = store => Object.values(store.resources || {}).filter(resource => resource.type === 'note');
const noteByTitle = (store, title) => noteEntries(store).find(resource => resource.title === title);
const noteTitles = store => noteEntries(store).map(resource => resource.title).sort();
const assocNodeIds = note => (note.associations || []).map(ref => ref.workspace + '|' + ref.subject + '|' + ref.node).sort();

async function waitReady(page, selector) {
  await page.locator(selector).waitFor({ state: 'visible', timeout: 20000 });
}

async function waitEnabled(locator, message) {
  await waitFor(() => locator.isEnabled(), message, 20000);
}

async function waitSaved(page, rootSelector) {
  await page.locator(rootSelector + ' .notes-status').filter({ hasText: '已保存' }).first()
    .waitFor({ state: 'visible', timeout: 20000 });
}

async function ensureLeftPane(page) {
  const lesson = page.locator('.smb-lesson');
  if (!(await lesson.count())) return;
  if ((await lesson.getAttribute('data-left')) !== '1') {
    await page.locator('[data-proto="toggle-left"]').click();
    await page.locator('.smb-lesson[data-left="1"]').waitFor({ state: 'visible' });
  }
}

// 打开学习右栏的「笔记」。右栏收起时没有 tab，只有右侧窄轨；先点窄轨。
async function openNotesPane(page) {
  const panel = page.locator('.learning-notes-panel');
  if (!(await panel.isVisible().catch(() => false))) {
    const rail = page.locator('[data-proto="toggle-notes"]');
    if (await rail.isVisible().catch(() => false)) await rail.click();
    else await page.locator('[data-proto="tab-notes"]').click();
  }
  await panel.waitFor({ state: 'visible', timeout: 20000 });
}

async function openLesson(page, title) {
  await ensureLeftPane(page);
  const current = page.locator('.smb-node[data-proto="tree-node"][aria-current="true"]');
  if (await current.count()) {
    if ((await current.first().innerText()).includes(title)) return;
  }
  await page.locator('[data-proto="left-pane-course"]').click();
  await page.locator('.smb-node[data-proto="tree-node"]').filter({ hasText: title }).click();
  await page.locator('.smb-center__head').filter({ hasText: title }).waitFor({ state: 'visible' });
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // 独立运行默认构建；显式关闭仅用于验证上一版正式产物或复用已构建的最终产物。
  if (!['0', 'false', 'no'].includes(String(process.env.STUDYMATE_NOTES_BROWSER_BUILD || '1').toLowerCase())) buildFormalNotesClient();
  const playwright = await loadNotesPlaywright();
  const { chromium } = playwright.default || playwright;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  } catch (error) {
    if (isMissingEdge(error)) {
      console.error('SKIP: 没有可用的 Microsoft Edge（' + error.message + '）');
      process.exitCode = 3;
      return;
    }
    throw error;
  }

  const fixture = await startNotesHostFixture({ build: false, library: curriculumLibrary() });
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce',
    locale: 'zh-CN', deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  try {
    // ① 空节点也全部列出。从科目主页点进课程甲，再切左栏「笔记」。
    await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: hostTokenCss() });
    await page.locator('[data-proto="nav-subject"]').filter({ hasText: '课程科目' }).click();
    await page.locator('[data-proto="open-node"][data-node="course-a"]').click();
    await page.locator('.smb-center__head').filter({ hasText: '课程甲' }).waitFor({ state: 'visible' });
    await ensureLeftPane(page);
    await page.locator('[data-proto="left-pane-notes"]')
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => { throw new Error('学习页没有笔记入口：组合产物未导出 createNotesWorkspace / LearningNotesTree / LearningNotesPanel。'); });
    await page.locator('[data-proto="left-pane-notes"]').click();
    await waitReady(page, '.learning-notes-tree');
    await waitFor(async () => await page.locator('.learning-notes-tree .notes-empty-node').count() === 3,
      '三个尚无笔记的节点都显示空态');
    const groups = page.locator('.learning-notes-tree .notes-node-group');
    assert.equal(await groups.count(), 3, '左栏应列出科目内全部节点');
    const groupText = await groups.allInnerTexts();
    for (const title of ['课程甲', '课程乙', '课程丙']) {
      assert.ok(groupText.some(text => text.includes(title)), '左栏缺少节点 ' + title);
    }
    assert.equal(await page.locator('.learning-notes-tree .notes-md-row').count(), 0, '开始前不应有笔记');
    // 新建入口只在学习右栏：左树顶不再有「新建节点笔记」，顶部改为默认本 + 课程笔记本。
    assert.equal(await page.locator('.learning-notes-tree').getByRole('button', { name: '新建节点笔记' }).count(), 0,
      '左树顶不再有「新建节点笔记」');
    assert.match(await page.locator('.learning-notes-tree .notes-default-book').innerText(), /默认本：尚未选择/,
      '左栏顶部显示默认本');
    await SCREENSHOT(page, '01-empty-nodes');

    // ② 首次新建：先让用户选/建默认本，再建 .md，并关联当前节点。
    await openNotesPane(page);
    await waitReady(page, '.learning-notes-panel');
    const panelNewNote = page.locator('.learning-notes-panel').getByRole('button', { name: '新建笔记', exact: true });
    await waitEnabled(panelNewNote, '笔记数据载入后可新建');
    await panelNewNote.click();
    await waitReady(page, '.notes-picker');
    assert.equal(await page.locator('.notes-picker').getByText('只影响以后新建的笔记，不搬动已有文件。').count(), 1,
      '首次新建必须先确认默认笔记本');
    await page.locator('[aria-label="科目默认笔记本"]').selectOption('new');
    await page.locator('[aria-label="笔记本名称"]').fill('课程笔记');
    const confirmDefault = page.locator('.notes-picker').getByRole('button', { name: '确认选择' });
    await waitEnabled(confirmDefault, '默认本表单可提交');
    await confirmDefault.click();
    await waitFor(async () => await page.locator('.learning-notes-tree .notes-md-row').count() === 1,
      '确认默认本后创建一条笔记');
    await page.locator('[data-proto="tab-notes"][aria-selected="true"]').waitFor({ state: 'visible' });
    await waitReady(page, '.learning-notes-panel');
    await waitSaved(page, '.learning-notes-tree');
    assert.match(await page.locator('.learning-notes-panel .notes-origin').innerText(), /原件目录：课程笔记/,
      '右栏标题下显示原件目录（不重复文件名）');
    assert.match(await page.locator('.learning-notes-panel .notes-association').innerText(), /课程甲/,
      '右栏显示本课关联');
    assert.match(await page.locator('.learning-notes-tree .notes-default-book').innerText(), /默认本：课程笔记/,
      '新建后左栏顶部显示默认本');
    assert.equal(await page.locator('.learning-notes-tree .notes-book-of').first().innerText(), '课程笔记',
      '左树笔记行显示所属本');
    assert.equal(await page.locator('.learning-notes-panel input[aria-label="学习笔记标题"]').inputValue(), '课程甲.md',
      '新建的 Markdown 标题取当前节点');
    await SCREENSHOT(page, '02-first-note');

    let store = await waitFor(() => {
      const value = fixture.read();
      return noteByTitle(value, '课程甲.md') && value.layout.folders.some(folder => folder.name === '课程笔记')
        ? value : null;
    }, '第一条笔记与默认笔记本落盘');
    let noteA = noteByTitle(store, '课程甲.md');
    assert.equal(noteA.markdown, '', '新建笔记正文为空');
    assert.deepEqual(assocNodeIds(noteA), [WORKSPACE + '|demo|course-a'], '新笔记只关联当前节点');
    const bookA = store.layout.folders.find(folder => folder.name === '课程笔记');
    assert.ok(bookA && bookA.kind === 'notebook', '默认笔记本已落盘');
    assert.equal(noteA.parent, bookA.id, '笔记原件归属默认笔记本');

    // ③ 左右共用原稿：在同一内联编辑器写入与追加，不经过第二份文档或模式切换。
    const source = page.locator('.learning-notes-panel .markdown-inline-editor .cm-content[role="textbox"]');
    await source.waitFor({ state: 'visible' });
    assert.equal(await page.locator('.learning-notes-panel [role="toolbar"][aria-label="Markdown 格式"]').count(), 1, '文件标题下只有一条格式栏');
    await page.locator('.learning-notes-panel .notes-title-row').getByRole('button', { name: '导出当前 Markdown' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('.learning-notes-panel .note-editor').getByRole('button', { name: '导出当前 Markdown' }).count(), 0, '学习侧栏导出只在标题行');
    assert.equal(await page.locator('.learning-notes-panel .note-editor__modes, .learning-notes-panel .markdown-live-editor__hint').count(), 0, '旧模式和常驻说明已移除');
    const flat = await page.locator('.learning-notes-panel .note-editor').evaluate(el =>
      [el, el.querySelector('.markdown-inline-editor')].map(node => {
        const css = getComputedStyle(node);
        return [css.backgroundColor, css.borderTopWidth, css.borderRadius, css.boxShadow];
      }));
    // #312 A5：编辑面不再透宿主，.note-editor 自己承担加深一档的面（亮暗均深）；
    // 但仍然不另套卡片——圆角边框与阴影的旧契约保持不变，正文编辑器本体依旧透明。
    assert.deepEqual(flat.map(([, border, radius, shadow]) => [border, radius, shadow]), [
      ['0px', '0px', 'none'],
      ['0px', '0px', 'none'],
    ], '外层与正文内部都不另套卡片、圆角边框或阴影');
    assert.notEqual(flat[0][0], 'rgba(0, 0, 0, 0)', 'A5：编辑面外层有自己的加深面，不再透宿主背景');
    assert.equal(flat[1][0], 'rgba(0, 0, 0, 0)', '正文编辑器本体保持透明，面由外层承担');
    await source.click();
    await page.keyboard.insertText('即时写入的正文。');
    await waitFor(() => noteByTitle(fixture.read(), '课程甲.md')?.markdown.includes('即时写入的正文。'), '内联编辑写入同一份原稿');
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n\n源码追加的正文。');
    await waitFor(() => noteByTitle(fixture.read(), '课程甲.md')?.markdown.includes('源码追加的正文。'), '直接追加原稿落盘');
    noteA = noteByTitle(fixture.read(), '课程甲.md');
    assert.ok(noteA.markdown.includes('即时写入的正文。') && noteA.markdown.includes('源码追加的正文。'), '两次输入写入同一原稿');
    assert.equal(noteA.parent, bookA.id, '编辑正文不改原件归属');
    assert.equal(await page.locator('.learning-notes-panel input[aria-label="学习笔记标题"]').inputValue(), '课程甲.md', '格式栏不会改动文件名');
    await waitSaved(page, '.learning-notes-panel');
    await SCREENSHOT(page, '03-editor');

    // 亮→暗→亮：正常渲染、局部灰色标记、链接框都跟随宿主；操作显示态不保存正文。
    const originalMarkdown = noteA.markdown;
    const themeMarkdown = originalMarkdown + '\n\n# 暗色预览标题\n\n**AA粗体** 与 *AA斜体*，周围文字不切换源码。\n\n| 项目 | 值 |\n| --- | --- |\n| 对比度 | 清晰 |\n\n```javascript\n// 注释\nconst value = 42;\nfunction label() { return "笔记"; }\n```\n';
    await source.click();
    await page.keyboard.press('Control+A'); await page.keyboard.insertText(themeMarkdown);
    await waitFor(() => noteByTitle(fixture.read(), '课程甲.md')?.markdown === themeMarkdown, '主题测试原稿落盘');
    await waitSaved(page, '.learning-notes-panel');
    const themePosts = fixture.requests.filter(request => request.method === 'POST').length;
    const strong = page.locator('.learning-notes-panel .markdown-inline-editor .md-strong').filter({ hasText: 'AA粗体' }).first();
    for (const theme of ['light', 'dark', 'light']) {
      await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value === 'dark'), theme);
      await waitFor(async () => await page.locator('.learning-notes-panel .note-editor').getAttribute('data-theme') === theme, '侧栏编辑器跟随宿主主题');
      await page.locator('.learning-notes-panel input[aria-label="学习笔记标题"]').focus();
      await assertNotesContrast(page, theme + '/正常渲染');
      await strong.click();
      assert.equal(await page.locator('.learning-notes-panel .md-syntax:not(.md-syntax-hidden)').count(), 2, '仅当前粗体的两组真实标记显现');
      assert.ok(Number(await strong.evaluate(el => getComputedStyle(el).fontWeight)) >= 600, '标记显现时文字仍加粗');
      await assertNotesContrast(page, theme + '/局部标记');
      await page.locator('.learning-notes-panel').getByRole('button', { name: '链接', exact: true }).click();
      const dialog = page.locator('.learning-notes-panel [role="dialog"]');
      await dialog.getByLabel('链接地址', { exact: true }).fill('https://example.org/notes-aa');
      await assertNotesContrast(page, theme + '/链接框');
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      const inputColor = await page.locator('.learning-notes-panel input[aria-label="学习笔记标题"]').evaluate(el => getComputedStyle(el).backgroundColor);
      if (theme === 'dark') assert.notEqual(inputColor, 'rgb(255, 255, 255)', '暗色标题输入框不能仍是白底');
      await strong.click();
      await SCREENSHOT(page, theme === 'dark' ? '03b-editor-dark' : '03c-editor-light');
    }
    assert.equal(noteByTitle(fixture.read(), '课程甲.md').markdown, themeMarkdown, '主题、光标显隐和未提交链接框不改写原稿');
    assert.equal(fixture.requests.filter(request => request.method === 'POST').length, themePosts, '显示态变化不应自动写入');
    await source.click();
    await page.keyboard.press('Control+A'); await page.keyboard.insertText(originalMarkdown);
    await waitFor(() => noteByTitle(fixture.read(), '课程甲.md')?.markdown === originalMarkdown, '主题测试结束恢复原测试正文');
    await waitSaved(page, '.learning-notes-panel');

    // ④ 给课程乙建一条笔记，再把课程甲那条拖到课程乙：只换关联。
    await openLesson(page, '课程乙');
    await page.locator('[data-proto="left-pane-notes"]').click();
    await openNotesPane(page);
    await waitReady(page, '.learning-notes-panel');
    // 切节点禁止沿用上一课的选中：选择器为空，标题与正文都不在。
    await waitFor(async () => (await page.locator('.learning-notes-panel [aria-label="选择学习笔记"]').inputValue()) === '',
      '切到课程乙后右栏不沿用课程甲的选中');
    assert.equal(await page.locator('.learning-notes-panel input[aria-label="学习笔记标题"]').count(), 0, '切课后不显示上一课的笔记');
    const panelNewNoteB = page.locator('.learning-notes-panel').getByRole('button', { name: '新建笔记', exact: true });
    await waitEnabled(panelNewNoteB, '课程乙可新建笔记');
    await panelNewNoteB.click();
    await waitFor(async () => await page.locator('.learning-notes-tree .notes-md-row').count() === 2,
      '课程乙创建第二条笔记');
    await waitSaved(page, '.learning-notes-tree');
    const noteB = await waitFor(() => noteByTitle(fixture.read(), '课程乙.md'), '第二条笔记落盘');
    assert.equal(noteB.parent, bookA.id, '第二条默认仍落在同一本');
    const beforeDrag = fixture.read();
    const beforeLayout = JSON.stringify(beforeDrag.layout);
    const beforeNote = noteByTitle(beforeDrag, '课程甲.md');
    const groupA = page.locator('.learning-notes-tree .notes-node-group').filter({ hasText: '课程甲' }).first();
    const groupB = page.locator('.learning-notes-tree .notes-node-group').filter({ hasText: '课程乙' }).first();
    // 同科目换节点由 App 统一确认一次（ADR-0019）；拖动只 dispatch associate，确认在那一层。
    const sameSubjectConfirm = page.waitForEvent('dialog', { timeout: 10000 }).then(dialog => dialog.accept());
    await groupA.locator('.notes-md-row').first().dragTo(groupB);
    await sameSubjectConfirm;
    await waitFor(() => {
      const current = noteByTitle(fixture.read(), '课程甲.md');
      return current && assocNodeIds(current).join() === WORKSPACE + '|demo|course-b';
    }, '跨节点拖动把同科目关联换成课程乙');
    const afterDrag = fixture.read();
    const afterNote = noteByTitle(afterDrag, '课程甲.md');
    for (const key of ['id', 'title', 'markdown', 'parent']) {
      assert.equal(afterNote[key], beforeNote[key], '拖动只改关联，不改 ' + key);
    }
    assert.equal(JSON.stringify(afterDrag.layout), beforeLayout, '拖动笔记不应动画布布局');
    await waitFor(async () => (await groupB.innerText()).includes('课程甲.md'), '课程乙分组下出现课程甲.md');
    await SCREENSHOT(page, '04-drag-association');

    // ⑤ 换默认本只影响以后新建。课程丙已是无课件节点，仍能打开学习右栏笔记。
    await openLesson(page, '课程丙');
    await page.locator('[data-proto="left-pane-notes"]').click();
    const booksToggle = page.locator('.learning-notes-tree').getByRole('button', { name: '课程笔记本' });
    await waitEnabled(booksToggle, '可打开课程笔记本列表');
    await booksToggle.click();
    await waitReady(page, '.learning-notes-tree .notes-books');
    const booksPanel = page.locator('.learning-notes-tree .notes-books');
    assert.match(await booksPanel.innerText(), /课程笔记/, '课程笔记本列表显示当前科目绑定的本');
    assert.match(await booksPanel.innerText(), /默认本/, '列表标出当前默认本');
    await booksPanel.getByRole('button', { name: '新建笔记本并设为默认本…' }).click();
    await booksPanel.getByLabel('新课程笔记本名称').fill('第二本');
    await booksPanel.getByRole('button', { name: '创建并设为默认本' }).click();
    await waitFor(async () => (await page.locator('.learning-notes-tree .notes-default-book').innerText()).includes('第二本'),
      '默认本切换为第二本');
    await booksPanel.getByRole('button', { name: '关闭', exact: true }).click();
    await openNotesPane(page);
    const panelNewNoteC = page.locator('.learning-notes-panel').getByRole('button', { name: '新建笔记', exact: true });
    await waitEnabled(panelNewNoteC, '课程丙可新建笔记');
    await panelNewNoteC.click();
    await waitFor(async () => await page.locator('.learning-notes-tree .notes-md-row').count() === 3,
      '课程丙在第二本下新建第三条笔记');
    await page.locator('[data-proto="tab-notes"][aria-selected="true"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.learning-notes-panel input[aria-label="学习笔记标题"]').inputValue(), '课程丙.md',
      '没有课件的节点也能在学习右栏打开笔记');
    // 已绑定的本之间也能改默认本：把默认本改回课程笔记。
    await booksToggle.click();
    await waitReady(page, '.learning-notes-tree .notes-books');
    await page.locator('.learning-notes-tree .notes-books').getByRole('button', { name: '设为默认本' }).first().click();
    await waitFor(async () => (await page.locator('.learning-notes-tree .notes-default-book').innerText()).includes('课程笔记'),
      '可把默认本改回已绑定的本');
    await page.locator('.learning-notes-tree .notes-books').getByRole('button', { name: '关闭', exact: true }).click();
    const storeAfterDefault = await waitFor(() => {
      const value = fixture.read();
      return noteByTitle(value, '课程丙.md') && value.layout.folders.some(folder => folder.name === '第二本')
        ? value : null;
    }, '第三条笔记与第二本落盘');
    const bookB = storeAfterDefault.layout.folders.find(folder => folder.name === '第二本');
    const noteC = noteByTitle(storeAfterDefault, '课程丙.md');
    assert.ok(bookB, '第二本已落盘');
    assert.equal(noteC.parent, bookB.id, '新笔记进新默认本');
    assert.equal(noteByTitle(storeAfterDefault, '课程甲.md').parent, bookA.id, '旧笔记不被搬走');
    assert.equal(noteByTitle(storeAfterDefault, '课程乙.md').parent, bookA.id, '旧笔记不被搬走');
    assert.equal(noteByTitle(storeAfterDefault, '课程甲.md').markdown, noteA.markdown, '旧正文不被搬动改写');
    assert.equal(await page.locator('[data-proto="missing-lesson-notice"]').count(), 1, '无课件节点明确提示缺课件');
    await waitSaved(page, '.learning-notes-tree');
    await SCREENSHOT(page, '05-no-lesson-default-book');

    // ④b 展开分组不切课；跨节点点某一篇先切课，再由右栏打开那一篇（ADR-0019）。
    await openLesson(page, '课程丙');
    await page.locator('[data-proto="left-pane-notes"]').click();
    const groupBNode = page.locator('.learning-notes-tree .notes-node-group').filter({ hasText: '课程乙' }).first();
    const toggleB = groupBNode.getByRole('button', { name: /(收起|展开) 课程乙/ });
    await toggleB.click();
    assert.equal(await page.locator('.smb-center__head').filter({ hasText: '课程丙' }).count(), 1, '收起分组不切课');
    await toggleB.click();
    assert.equal(await page.locator('.smb-center__head').filter({ hasText: '课程丙' }).count(), 1, '展开分组也不切课');
    await groupBNode.locator('.notes-md-row').filter({ hasText: '课程甲.md' }).locator('.notes-md-open').click();
    await page.locator('.smb-center__head').filter({ hasText: '课程乙' }).waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('.learning-notes-panel input[aria-label="学习笔记标题"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.learning-notes-panel input[aria-label="学习笔记标题"]').inputValue(), '课程甲.md',
      '跨节点点笔记：先切到课程乙，再在右栏打开同一篇');
    const notesPaneButton = page.locator('[data-proto="left-pane-notes"]');
    if (await notesPaneButton.count() && (await notesPaneButton.getAttribute('aria-pressed')) !== 'true') await notesPaneButton.click();
    await waitReady(page, '.learning-notes-tree');

    // ⑨ 软删除→恢复：原文、归属和画布布局都原样回来，只移出各视图。
    const beforeTrash = fixture.read();
    const noteABeforeTrash = noteByTitle(beforeTrash, '课程甲.md');
    const layoutBeforeTrash = JSON.stringify(beforeTrash.layout);
    assert.ok(noteABeforeTrash && !noteABeforeTrash.trashed, '删除前笔记仍在用');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('.learning-notes-tree').getByRole('button', { name: '删除 课程甲.md' }).click();
    const trashed = await waitFor(() => {
      const value = fixture.read();
      return noteByTitle(value, '课程甲.md')?.trashed ? value : null;
    }, '笔记进入废纸篓');
    assert.equal(noteByTitle(trashed, '课程甲.md').markdown, noteABeforeTrash.markdown, '删除不改正文');
    assert.deepEqual(noteByTitle(trashed, '课程甲.md').associations, noteABeforeTrash.associations, '删除不改归属');
    assert.equal(await page.locator('.learning-notes-tree .notes-md-row').count(), 2, '废纸篓里的笔记从节点视图隐藏');
    await page.locator('.learning-notes-tree .notes-trash summary').click();
    await page.locator('.learning-notes-tree .notes-trash').getByText('课程甲.md').waitFor({ state: 'visible' });
    await page.locator('.learning-notes-tree .notes-trash').getByRole('button', { name: '恢复' }).click();
    const restored = await waitFor(() => {
      const value = fixture.read();
      return noteByTitle(value, '课程甲.md')?.trashed ? null : value;
    }, '笔记从废纸篓恢复');
    const noteAAfterRestore = noteByTitle(restored, '课程甲.md');
    assert.equal(noteAAfterRestore.id, noteABeforeTrash.id, '恢复的是同一份原稿');
    assert.equal(noteAAfterRestore.markdown, noteABeforeTrash.markdown, '恢复保留正文');
    assert.equal(noteAAfterRestore.parent, noteABeforeTrash.parent, '恢复保留归属笔记本');
    assert.deepEqual(noteAAfterRestore.associations, noteABeforeTrash.associations, '恢复保留节点关联');
    assert.equal(JSON.stringify(restored.layout), layoutBeforeTrash, '删除与恢复不重建画布布局');
    assert.equal(await page.locator('.learning-notes-tree .notes-md-row').count(), 3, '恢复后笔记回到节点视图');
    await SCREENSHOT(page, '05b-trash-restore');

    // ⑥ 无界侧栏「节点视图」看到同一套书与节点分类。
    await page.locator('[data-proto="brand-switch"]').click();
    await page.locator('[data-proto="notes-surface"]').waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('[data-proto="notes-surface"] .view-switch[aria-label="笔记目录视图"]')
      .getByRole('button', { name: '节点视图' }).click();
    await waitReady(page, '.node-notebook-tree');
    const bookOneNode = page.locator('.node-notebook-tree [role="treeitem"]')
      .filter({ has: page.locator('.notes-book-heading b', { hasText: '课程笔记' }) });
    const bookTwoNode = page.locator('.node-notebook-tree [role="treeitem"]')
      .filter({ has: page.locator('.notes-book-heading b', { hasText: '第二本' }) });
    const bookOneCanvas = bookOneNode.getByRole('button', { name: '打开课程笔记画布' });
    const bookTwoCanvas = bookTwoNode.getByRole('button', { name: '打开第二本画布' });
    assert.equal(await bookOneNode.count(), 1, '节点视图应列出第一本');
    assert.equal(await bookTwoNode.count(), 1, '节点视图应列出第二本');
    assert.match(await bookOneNode.innerText(), /课程甲[\s\S]*课程乙[\s\S]*课程丙/, '第一本保留同一科目分类');
    assert.match(await bookOneNode.innerText(), /课程甲\.md/, '拖动后的笔记在课程乙分类下');
    const bookTwoText = await bookTwoNode.innerText();
    assert.match(bookTwoText, /课程丙\.md/, '第二本只含自己的笔记');
    assert.doesNotMatch(bookTwoText, /课程甲\.md|课程乙\.md/, '第一本的笔记不串到第二本');
    // 本名旁是绑定摘要；行内「⋯ → 课程绑定」替代手输 slug；笔记文件行不放这个菜单。
    assert.equal(await page.locator('.node-notebook-tree').getByRole('button', { name: '手动绑定科目' }).count(), 0,
      '不再用手输 slug 的手动绑定按钮');
    assert.match(await bookOneNode.locator('.notes-book-binding').innerText(), /课程科目/,
      '本名旁显示绑定摘要');
    assert.equal(await bookOneNode.getByRole('button', { name: /更多操作/ }).count(), 0,
      '笔记文件行不放课程绑定菜单，管理入口在标题下');
    await bookOneNode.getByRole('button', { name: '更多 课程笔记 操作' }).click();
    await bookOneNode.getByRole('menuitem', { name: '课程绑定' }).click();
    const bindForm = page.locator('[data-proto="notebook-bindings-form"]');
    await bindForm.waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await bindForm.innerText(), /课程科目/, '「⋯ → 课程绑定」打开绑定表单');
    assert.ok(await bindForm.getByRole('button', { name: '解除绑定' }).count() >= 1, '绑定行有解除绑定入口');
    await page.getByRole('button', { name: '关闭弹窗' }).click();
    await SCREENSHOT(page, '06-node-view');
    await bookOneCanvas.click();
    await bookOneNode.locator('.notes-md-row').filter({ hasText: '课程甲.md' }).locator('.notes-md-open').click();
    const right = page.locator('[data-proto="notes-surface"] .right-panel');
    const linkedCourse = right.locator('.resource-header').getByRole('button', { name: '管理课程关联：课程科目', exact: true });
    await linkedCourse.waitFor({ state: 'visible' });
    assert.equal(await linkedCourse.innerText(), '课程科目', '右栏标题旁显示科目名而不是节点名');
    assert.equal(await right.locator('.resource-detail .course-association-bar').count(), 0, '右栏正文不重复展示关联条');
    await linkedCourse.click();
    const relations = page.locator('[data-proto="note-associations-form"]');
    await relations.waitFor({ state: 'visible' });
    assert.match(await relations.innerText(), /课程乙/, '同一个选项打开关联管理并展示具体节点');
    await page.getByRole('button', { name: '关闭弹窗' }).click();

    // ⑦ 拖课程节点到画布：只有标题 + 跳转，不复制正文；侧栏是实际只读课件。
    // 先把「课程笔记」这本设为当前画布，课程卡才会落到这一本，而不是初始的空画布。
    await bookOneCanvas.click();
    const stage = page.locator('[data-proto="notes-surface"] .canvas-stage');
    await waitReady(page, '.node-notebook-tree');
    const headingA = bookOneNode.locator('.notes-node-heading').filter({ hasText: '· 课程甲' }).first();
    await headingA.dragTo(stage);
    const courseCard = page.locator('[data-proto="notes-surface"] .course-reference-card');
    await courseCard.waitFor({ state: 'visible', timeout: 20000 });
    // React Flow 新建节点在测量期给节点写 inline visibility:hidden（页头按钮继承，
    // getByRole 按可访问树过滤会漏掉）；等按钮真正可访问后再断言，保留数量与语义检查。
    await waitFor(async () => await courseCard.getByRole('button', { name: '跳转' }).count() === 1,
      '课程卡跳转按钮进入可访问树（React Flow 测量瞬态结束）');
    const jumpButton = courseCard.getByRole('button', { name: '跳转' });
    assert.equal(await courseCard.count(), 1, '画布上出现一张课程卡');
    assert.match(await courseCard.locator('h3').textContent(), /课程甲/, '课程卡标题来自来源节点');
    assert.equal(await courseCard.locator('.card-body').count(), 0, '课程卡不带笔记正文');
    assert.equal(await jumpButton.count(), 1, '课程卡只有显式跳转');
    const courseResource = await waitFor(() => {
      const value = fixture.read();
      return Object.values(value.resources).find(resource => resource.type === 'course' && resource.courseRef?.node === 'course-a') || null;
    }, '课程卡落进真实数据域');
    assert.equal(courseResource.title, '课程甲', '课程卡只存来源标题，不存正文');
    assert.equal(courseResource.courseRef.node, 'course-a', '课程卡保留精确节点引用');
    assert.ok(!courseResource.markdown, '课程卡不复制课件正文');
    await courseCard.locator('h3').click();
    await waitReady(page, '#right-panel .course-readonly');
    const readonly = page.locator('#right-panel .course-readonly');
    assert.match(await readonly.innerText(), /课程甲正文/, '侧栏显示学习工作区里的真课件');
    assert.equal(await readonly.locator('.note-editor').count(), 0, '课程引用不是 Markdown 笔记编辑器');
    assert.match(await readonly.innerText(), /课件只读/, '侧栏明确说明正文只读');
    const cardTransform = await page.locator('[data-proto="notes-surface"] .react-flow__node').first().getAttribute('style');
    const viewportBefore = await page.locator('[data-proto="notes-surface"] .react-flow__viewport').getAttribute('style');
    await SCREENSHOT(page, '07-course-card');

    // 精确跳回学习源，无界画布不被重建。
    await readonly.getByRole('button', { name: '跳转到课程节点' }).click();
    await page.locator('[data-proto="learning-surface"]').waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('[data-proto="notes-surface"]').waitFor({ state: 'hidden', timeout: 20000 });
    await page.locator('.smb-center__head').filter({ hasText: '课程甲' }).waitFor({ state: 'visible' });
    assert.match(await page.locator('[data-proto="learning-surface"] .smb-doc').innerText(), /课程甲正文/, '跳回的是同一篇课件');
    await page.locator('[data-proto="left-pane-course"]').click();
    await page.locator('.smb-node[data-proto="tree-node"][aria-current="true"]').filter({ hasText: '课程甲' })
      .waitFor({ state: 'visible' });
    await page.locator('[data-proto="brand-switch"]').click();
    await page.locator('[data-proto="notes-surface"]').waitFor({ state: 'visible', timeout: 20000 });
    await courseCard.waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-proto="notes-surface"] .course-reference-card').count(), 1, '跳转不重建画布上的课程卡');
    assert.equal(await page.locator('[data-proto="notes-surface"] .react-flow__node').first().getAttribute('style'), cardTransform,
      '跳转前后卡片几何不变');
    assert.equal(await page.locator('[data-proto="notes-surface"] .react-flow__viewport').getAttribute('style'), viewportBefore,
      '跳转前后相机不变');
    await SCREENSHOT(page, '08-jump-back');

    // ⑧ 多本画布隔离；切回第一本恢复相机。
    await page.locator('.node-notebook-tree').waitFor({ state: 'visible' });
    const zoomBefore = (await page.locator('[data-proto="notes-surface"] .zoom-label').innerText()).trim();
    await bookTwoCanvas.click();
    await page.locator('[data-proto="notes-surface"] .course-reference-card').waitFor({ state: 'detached' }).catch(() => {});
    assert.equal(await page.locator('[data-proto="notes-surface"] .course-reference-card').count(), 0, '第二本画布是空的');
    await bookOneCanvas.click();
    await page.locator('[data-proto="notes-surface"] .course-reference-card').waitFor({ state: 'visible' });
    assert.equal((await page.locator('[data-proto="notes-surface"] .zoom-label').innerText()).trim(), zoomBefore,
      '切回第一本恢复相机缩放');
    await SCREENSHOT(page, '09-book-isolation');

    assert.deepEqual(pageErrors, [], '页面不应有未捕获异常');
    const relevantConsole = consoleErrors.filter(text => !/favicon|Failed to load resource/i.test(text));
    assert.deepEqual(relevantConsole, [], '控制台不应有错误');
    assert.deepEqual(fixture.problems, [], '夹具宿主不应记录异常');
    const gets = fixture.requests.filter(request => request.method === 'GET' && request.status === 200);
    assert.ok(gets.length > 0, '笔记数据确实走了真实 GET');
    // 请求记录里只有请求体；schema 是响应字段，直接问一次真实路由。
    const wire = await page.evaluate(async () => (await fetch('/api/studymate/notes')).json());
    assert.ok(wire && typeof wire === 'object' && wire.resources, '笔记 GET 返回数据域');
    const schema = wire.schemaVersion;
    assert.equal(schema, 2, 'Host 笔记数据域已升级到 schema2');
    console.log('通过：notes curriculum 10 项验收（含学习笔记亮暗与对比度）');
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
