/* 明暗主题三态语义（跟随宿主/显式覆盖/系统偏好）的真浏览器回归。
   跑法：node scripts/tests/browser/notes_theme_test.mjs

   语义口径（docs/规范/阅读端呈现.md §九）：默认跟宿主主题；顶栏显式切换是本页会话内的
   **覆盖**，优先级最高，只作用于笔记模块；覆盖一旦写入就一直在 light/dark 之间翻转、
   不会自动回到跟随——刷新后才回到跟随宿主。独立网页没有宿主，跟随系统偏好，
   覆盖压过系统偏好，同样刷新即清。

   覆盖项（真组合客户端 + 真 notes HTTP/临时 HOME + 可编程宿主暗色属性）：
   - 宿主 light：明→暗→明来回切；宿主切 dark 后模块跟随；host dark 下再来回切；
   - 覆盖期间宿主再变化**不**跟随（覆盖优先）；刷新后回到跟随宿主；
   - hosted 模式不写宿主 DOM：html 无 data-theme / 无内联 colorScheme，宿主 body 背景不变；
   - host dark + 模块 light 时宿主暗色规则不倒灌：app-shell color-scheme 仍是 light，
     树内 scrollbar-color 仍是模块亮色值（主动注入更晚的宿主级规则，并用模块外的 DOM 作正控）；
   - 独立 /preview/：写 documentElement（data-theme + colorScheme），覆盖压过系统偏好；
   - 全程无控制台/页面错误。
   需要 Microsoft Edge；没有就退出码 3。不连接真实 DSH 或模型。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, buildFormalNotesClient, loadNotesPlaywright, isMissingEdge,
  startNotesHostFixture, enterNotes,
} from '../fixtures/notes_host_fixture.mjs';

const OUT = path.join(ROOT, '.preview', 'notes-theme');
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
const SKIP_BUILD = ['0', 'false', 'no'].includes(String(process.env.STUDYMATE_NOTES_BROWSER_BUILD || '1').toLowerCase());
if (!SKIP_BUILD) buildFormalNotesClient();

const notes = page => page.locator('.studymate-notes .app-shell');
const theme = page => notes(page).getAttribute('data-theme');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setHostDark(page, dark) {
  await page.evaluate(d => {
    if (d) document.body.setAttribute('data-ds-dark-theme', '');
    else document.body.removeAttribute('data-ds-dark-theme');
  }, dark);
}
async function waitForTheme(page, value, root = '.studymate-notes') {
  await page.waitForFunction(
    ({ v, root }) => document.querySelector(`${root} .app-shell`)?.getAttribute('data-theme') === v,
    { v: value, root }, { timeout: 10000 },
  );
}
async function toggle(page) {
  await notes(page).locator('.theme-switch').click();
}
/* hosted 模式的 DOM 不变量：笔记模块不许写宿主的 html/body 主题。 */
async function assertHostDomUntouched(page, label) {
  const state = await page.evaluate(() => ({
    htmlTheme: document.documentElement.getAttribute('data-theme'),
    htmlColorScheme: document.documentElement.style.colorScheme || '',
    bodyBackground: getComputedStyle(document.body).backgroundColor,
  }));
  assert.equal(state.htmlTheme, null, `${label}: hosted 模式写了 html[data-theme]`);
  assert.equal(state.htmlColorScheme, '', `${label}: hosted 模式写了 html 的内联 color-scheme`);
  assert.equal(state.bodyBackground, 'rgb(246, 247, 249)', `${label}: 宿主 body 背景被改动`);
}

const playwright = await loadNotesPlaywright();
const { chromium } = playwright.default || playwright;
let browser;
try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (error) {
  if (!isMissingEdge(error)) throw error;
  console.error('跳过 notes-theme：需要已安装的 Microsoft Edge；退出码 3，不算通过。\n' + error.message);
  process.exit(3);
}

let fixture;
try {
  fixture = await startNotesHostFixture({ seedDemo: true, build: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce', locale: 'zh-CN' });
  const page = await context.newPage();
  const problems = [];
  page.on('console', message => { if (message.type() === 'error') problems.push('console: ' + message.text()); });
  page.on('pageerror', error => problems.push('pageerror: ' + (error.stack || error.message)));
  page.on('requestfailed', request => {
    // /plugins/studymate/events 是 SSE 长连接，页面导航/关闭时必然以 requestfailed 收场——夹具噪音，不算问题。
    if (request.url().includes('/plugins/studymate/events')) return;
    problems.push('requestfailed: ' + request.url());
  });
  try {
    await enterNotes(page, fixture.origin);
    await notes(page).locator('.react-flow').waitFor({ timeout: 15000 });

    await guarded('宿主 light：默认跟随，hosted 不写宿主 DOM', async () => {
      assert.equal(await theme(page), 'light');
      await assertHostDomUntouched(page, '初始');
    });

    await guarded('宿主切 dark 再切回：模块双向跟随（尚无覆盖，纯跟随态）', async () => {
      await setHostDark(page, true);
      await waitForTheme(page, 'dark');
      await setHostDark(page, false);
      await waitForTheme(page, 'light');
    });

    await guarded('宿主 light 下明→暗→明来回切；按钮文案说明覆盖语义', async () => {
      await toggle(page);
      await waitForTheme(page, 'dark');
      assert.equal(await theme(page), 'dark');
      assert.ok((await notes(page).locator('.theme-switch').getAttribute('title')).includes('覆盖仅本页'), 'title 缺覆盖语义说明');
      await toggle(page);
      await waitForTheme(page, 'light');
      await assertHostDomUntouched(page, '明→暗→明往返后');
    }); // 场景结束时 override=light，宿主 light

    await guarded('host dark 下覆盖来回切：light 压过宿主暗色，再翻回', async () => {
      await setHostDark(page, true); // 宿主暗色，但覆盖 light 在——模块保持 light（覆盖优先的第一半证据）
      await delay(200);
      assert.equal(await theme(page), 'light', '宿主暗色打断了显式覆盖');
      await toggle(page); // override = dark
      await waitForTheme(page, 'dark');
      await toggle(page); // override = light
      await waitForTheme(page, 'light');
    }); // 场景结束时 override=light，宿主 dark

    await guarded('覆盖期间宿主变化不跟随（覆盖优先，不会自动回到跟随态）', async () => {
      await toggle(page); // override = dark，宿主仍是 dark
      await waitForTheme(page, 'dark');
      await setHostDark(page, false); // 宿主 dark→light：模块必须仍是 dark（不跟随）——判别点
      await delay(200);
      assert.equal(await theme(page), 'dark', '宿主变化打断了显式覆盖');
      await setHostDark(page, true); // 宿主 light→dark：模块保持 dark（视觉相同）
      await setHostDark(page, false); // 再回 light：模块仍是 dark
      await delay(200);
      assert.equal(await theme(page), 'dark', '宿主变化打断了显式覆盖');
    }); // 场景结束时 override=dark，宿主 light

    await guarded('刷新后回到跟随宿主（覆盖是会话内的，刷新即清）', async () => {
      await enterNotes(page, fixture.origin); // reload 后 override 清空，宿主此刻是 light
      await notes(page).locator('.react-flow').waitFor({ timeout: 15000 });
      assert.equal(await theme(page), 'light', '刷新后没有回到跟随宿主');
      await assertHostDomUntouched(page, '刷新往返后');
    }); // 场景结束时 override=null，宿主 light

    await guarded('host dark + 模块 light：宿主暗色规则不倒灌（color-scheme / 滚动条）', async () => {
      // 夹具不加载 DSH 样式。特意在分块样式之后加入宿主规则，并选一个不等于模块色板的颜色。
      await page.addStyleTag({ content: `body[data-ds-dark-theme] * {
        color-scheme: dark; scrollbar-color: rgb(17, 19, 23) transparent;
      }` });
      await setHostDark(page, true);
      await waitForTheme(page, 'dark');
      const host = await page.locator('#root').evaluate(el => {
        const style = getComputedStyle(el);
        return { colorScheme: style.colorScheme, scrollbarColor: style.scrollbarColor };
      });
      assert.equal(host.colorScheme, 'dark', '宿主规则没有作用于模块外的正控');
      assert.ok(host.scrollbarColor.includes('rgb(17, 19, 23)'), `宿主滚动条规则未生效：${host.scrollbarColor}`);
      await toggle(page); // override = light：宿主暗色 + 模块亮色并存
      await waitForTheme(page, 'light');
      const probe = (readyOnly) => {
        const shell = document.querySelector('.studymate-notes .app-shell');
        const tree = shell?.querySelector('.resource-tree');
        const actual = {
          colorScheme: shell ? getComputedStyle(shell).colorScheme : '(no shell)',
          scrollbarColor: tree ? getComputedStyle(tree).scrollbarColor : '(no tree)',
        };
        return !readyOnly || (actual.colorScheme === 'light' && actual.scrollbarColor.includes('rgb(207, 212, 222)'))
          ? actual : null;
      };
      // data-theme 已翻转不代表 Edge 同一拍已重算后代的滚动条样式。
      const sample = await page.waitForFunction(probe, true, { timeout: 5000 }).catch(async cause => {
        assert.fail(`模块没有保持亮色样式：${JSON.stringify(await page.evaluate(probe))} (${cause.message})`);
      });
      await sample.dispose();
    });

    check('hosted 全程无控制台/页面/失败请求', problems.length === 0, problems.join(' | '));

    /* ── 独立 /preview/：无宿主，跟随系统偏好；覆盖压过系统；刷新即清 ── */
    await guarded('独立网页：跟随系统偏好并写 documentElement', async () => {
      await page.goto(fixture.origin + '/preview/', { waitUntil: 'domcontentloaded' });
      await page.locator('.app-shell').waitFor({ timeout: 15000 });
      await waitForTheme(page, 'light', ''); // context colorScheme=light
      const html = await page.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'), colorScheme: document.documentElement.style.colorScheme }));
      assert.equal(html.theme, 'light');
      assert.equal(html.colorScheme, 'light');
    });

    await guarded('独立网页：覆盖压过系统偏好；刷新后回到系统偏好', async () => {
      await page.emulateMedia({ colorScheme: 'dark' }); // 系统偏好切 dark
      await waitForTheme(page, 'dark', '');
      await page.locator('.app-shell .theme-switch').click(); // override = light
      await waitForTheme(page, 'light', '');
      await page.emulateMedia({ colorScheme: 'light' }); // 系统切回 light，模块保持覆盖 light（同值）
      await delay(150);
      assert.equal(await page.locator('.app-shell').getAttribute('data-theme'), 'light');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.app-shell').waitFor({ timeout: 15000 });
      await waitForTheme(page, 'light', ''); // override 清空，回到系统 light
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light');
    });

    check('独立网页全程无新增控制台/页面错误', problems.length === 0, problems.join(' | '));
  } finally { await context.close(); }

  fs.writeFileSync(path.join(OUT, 'theme-report.json'), JSON.stringify({ checks: results.length, failures, results }, null, 2));
  console.log(`\n${results.length - failures}/${results.length} 项通过；报告 ${path.relative(ROOT, OUT)}`);
  if (failures) process.exitCode = 1;
} finally {
  await browser.close();
  if (fixture) await fixture.close();
}
