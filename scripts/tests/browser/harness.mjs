/* 浏览器 QA 的共用骨架：探测浏览器 → 起 CDP → 收控制台/页面错误/失败请求 → 出截图集与 summary.json。
   ────────────────────────────────────────────────────────────────────────────────
   这个文件是**照抄被删掉的原型**（`prototype/reading-client/tools/shot.mjs`）做出来的，
   主干里原先没有这两样东西，抄它是「删原型」的前置条件（顺序反了就没了）：

     · 四个 CDP 域的收集方式：
         Runtime.consoleAPICalled → console.error / console.warning
         Runtime.exceptionThrown  → pageerror（未捕获的页面错误）
         Log.entryAdded           → log（浏览器自己记的错误，比如资源与安全策略）
         Network.loadingFailed    → requestfailed（请求挂了：404 之外还有被拦、被中断）
     · summary.json 的形状：每个场景一条，带 metrics + problems + warnings。

   为什么不用 `chrome --screenshot`：那个开关拿不到控制台，也点不动东西。
   要验的恰恰是「点进去之后还对不对、有没有报错」，所以走 CDP。

   浏览器二进制**探测**，不写死 `google-chrome`：宿主机器上装的可能是 chromium、chrome，
   也可能在非标准路径（用环境变量指）。找不到时**明确跳过并说明**（退出码 3），
   不是静默绿 —— 一个没跑过的用例报 PASS，比红更坏。
*/
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 找不到浏览器时的退出码：与「断言失败」(1)、「用法错」(2) 都分开，一眼看得出是跳过。 */
export const EXIT_SKIP = 3;

/* ── 浏览器探测 ────────────────────────────────────────────────────────── */

/** 环境变量优先，其次 PATH 上的常见名字，最后是 macOS 的 .app 内置路径。 */
const ENV_KEYS = ['STUDYMATE_CHROME', 'CHROME_BIN', 'CHROMIUM_BIN', 'PUPPETEER_EXECUTABLE_PATH'];
const PATH_NAMES = [
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'chrome', 'google-chrome-beta', 'google-chrome-unstable',
];
const APP_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function executable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name) {
  const found = spawnSync('which', [name], { encoding: 'utf8' });
  if (found.status !== 0) return null;
  const file = (found.stdout || '').trim().split('\n')[0];
  return file || null;
}

/**
 * 找到本机的 Chromium 系浏览器。返回 `{ path, source }`，找不到返回 null。
 * `source` 会写进日志与 summary.json —— 出问题时要能一眼看出「跑的是哪个二进制、从哪找的」。
 */
export function findBrowser() {
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value && executable(value)) return { path: value, source: '$' + key };
  }
  for (const name of PATH_NAMES) {
    const file = onPath(name);
    if (file && executable(file)) return { path: file, source: 'PATH:' + name };
  }
  for (const file of APP_PATHS) {
    const expanded = file.replace(/^~/, process.env.HOME || '~');
    if (executable(expanded)) return { path: expanded, source: 'app:' + file };
  }
  return null;
}

/** 探测失败时给人看的一段说明：试过哪些、怎么覆盖。 */
export function probeHelp() {
  return [
    '没找到 Chromium 系浏览器，这个套件**跳过**（不是通过）。',
    '试过这些：',
    '  · 环境变量 ' + ENV_KEYS.join(' / ') + '（指到可执行文件的绝对路径）',
    '  · PATH 上的 ' + PATH_NAMES.join(' / '),
    '  · macOS 的 /Applications/*.app 内置路径',
    '装上任意一个，或 `STUDYMATE_CHROME=/path/to/chrome npm run test:browser` 指过去。',
  ].join('\n');
}

/**
 * 明确跳过：打一段醒目的说明并以 EXIT_SKIP 退出。
 * 不是静默绿 —— 没跑过的用例报通过，比红更坏。
 */
export function skipSuite(suite, reason) {
  console.error('');
  console.error('╭─ 跳过：' + suite);
  for (const line of String(reason).split('\n')) console.error('│ ' + line);
  console.error('╰─ 退出码 ' + EXIT_SKIP + '（跳过，不算通过）');
  process.exit(EXIT_SKIP);
}

/** 拿到浏览器，拿不到就明确跳过。手动工具（自己 spawn 的那种）用这个。 */
export function requireBrowser(suite) {
  const browser = findBrowser();
  if (!browser) skipSuite(suite, probeHelp());
  return browser;
}

/** 一次性的 profile 目录：跑完请删（`rm -rf <返回值>`），别把本机浏览器配置搅了。 */
export function tempProfile(tag) {
  return join(tmpdir(), 'smqa-' + tag + '-' + Date.now());
}

/* ── CDP 会话 ──────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起一个无头浏览器、连上第一个 page target，拿回一个会话对象。
 *
 * @param {object} options
 * @param {string} options.suite      套件名，写进 summary.json
 * @param {number} [options.width]    视口宽（默认 1440）
 * @param {number} [options.height]   视口高（默认 960）
 * @param {number} [options.port]     调试端口基础值（默认 9500 + 随机 400，多个套件并行不撞）
 */
export async function openSession({ suite, width = 1440, height = 960, port } = {}) {
  const browser = requireBrowser(suite);

  const PORT = port || 9500 + Math.floor(Math.random() * 400);
  // profile 放临时目录、跑完删：不污染本机浏览器配置，也不留垃圾
  const PROFILE = tempProfile(suite);
  const child = spawn(browser.path, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' });

  // 没装浏览器时 spawn 抛的是未捕获的 ENOENT（带回溯），把文档里那条失败路径变成死代码。
  // 接住 'error' 存下来，交给 target() 抛出去 —— 还是同一个 catch：一行可读报错 + 非零退出 + 收尾。
  let spawnError = null;
  child.on('error', (error) => { spawnError = error; });

  async function killBrowser() {
    await new Promise((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      setTimeout(done, 3000);
      child.kill();
    });
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
  }

  async function target() {
    for (let i = 0; i < 80; i++) {
      if (spawnError) throw new Error(`浏览器起不来（${browser.path}）：${spawnError.message}`);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page) return page;
      } catch { /* 还没起来，继续等 */ }
      await sleep(200);
    }
    throw new Error(`浏览器没起来（${browser.path}，端口 ${PORT}）`);
  }

  let ws;
  let id = 0;
  const pending = new Map();
  const events = [];
  try {
    const page = await target();
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve) => { ws.onopen = resolve; });
  } catch (error) {
    await killBrowser();
    throw error;
  }

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      events.push({ kind: 'console.' + m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? '').join(' ') });
    }
    if (m.method === 'Runtime.exceptionThrown') {
      events.push({ kind: 'pageerror', text: m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text });
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      events.push({ kind: 'log', text: m.params.entry.text + ' ' + (m.params.entry.url || '') });
    }
    if (m.method === 'Network.loadingFailed') {
      events.push({ kind: 'requestfailed', text: m.params.errorText + ' ' + (m.params.requestId || '') });
    }
  };

  function send(method, params = {}) {
    return new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  /** 在页面里求值并拿回值（不是句柄）。页面自己抛错也算失败，别静默成 undefined。 */
  async function evaluate(expression) {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res && res.exceptionDetails) {
      throw new Error('页面求值抛错：' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res && res.result ? res.result.value : undefined;
  }

  async function navigate(url, { settle = 900 } = {}) {
    await send('Page.navigate', { url });
    await sleep(settle);
  }

  const report = {
    suite,
    browser: { path: browser.path, source: browser.source },
    ranAt: new Date().toISOString(),
    scenes: [],
  };
  const seen = new Map();

  const session = {
    send,
    evaluate,
    navigate,
    sleep,
    report,
    scenes: seen,
    width,
    height,

    /** 在文档创建之前注入脚本（给页面准备 window 上的桩，早于任何页面脚本）。 */
    inject(script) {
      return send('Page.addScriptToEvaluateOnNewDocument', { source: script });
    },

    /** 模拟系统偏好（`prefers-reduced-motion` 的取值靠它切）。 */
    emulate({ reducedMotion, colorScheme } = {}) {
      const features = [];
      if (reducedMotion) features.push({ name: 'prefers-reduced-motion', value: reducedMotion });
      if (colorScheme) features.push({ name: 'prefers-color-scheme', value: colorScheme });
      return send('Emulation.setEmulatedMedia', { features });
    },

    /**
     * 一个用例 = 一段步骤 + 一张截图 + 一条 summary 记录。
     * 事件缓冲在场景开始时清空，所以每条记录里的 problems/warnings 只属于这个场景。
     * `run` 返回一个对象就当作本场景的 metrics 记下来。`run` 里可以用 ctx.note 主动记一条问题。
     */
    async scene(name, run) {
      events.length = 0;
      const notes = [];
      const ctx = {
        evaluate,
        navigate,
        sleep,
        note: (kind, text) => notes.push({ kind, text: String(text) }),
      };
      const metrics = await run(ctx);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      // problems/warnings 分开：警告不判失败（宿主自己的告警不该拦住我们的门禁），错误判。
      const problems = events.filter((e) => e.kind !== 'console.warning');
      const warnings = events.filter((e) => e.kind === 'console.warning');
      const record = {
        scene: name,
        file: name + '.png',
        png: shot && shot.data ? Buffer.from(shot.data, 'base64') : null,
        metrics: metrics && typeof metrics === 'object' ? metrics : {},
        problems: [...problems, ...notes].map((e) => ({ kind: e.kind, text: String(e.text) })),
        warnings: warnings.map((e) => ({ kind: e.kind, text: String(e.text) })),
      };
      report.scenes.push(record);
      seen.set(name, record);
      console.log(`${problems.length || notes.length ? '⚠ ' : 'ok '} ${name}`
        + (problems.length + notes.length ? `（${problems.length + notes.length} 条问题）` : ''));
      return record;
    },

    /**
     * 收尾：把截图与 summary.json 落到 outDir，打印一段人能读的结论。
     * 返回「有问题的场景数」，调用方据此定退出码。
     */
    async finish(outDir) {
      mkdirSync(outDir, { recursive: true });
      let shots = 0;
      for (const record of report.scenes) {
        if (!record.png) continue;
        writeFileSync(join(outDir, record.file), record.png);
        delete record.png;
        shots++;
      }
      writeFileSync(join(outDir, 'summary.json'), JSON.stringify(report, null, 2));
      const bad = report.scenes.filter((s) => s.problems.length);
      console.log(`\n截图 ${shots} 张 + summary.json → ${outDir}`);
      console.log(`浏览器：${browser.path}（${browser.source}）`);
      if (bad.length) {
        console.log(`有问题的场景 ${bad.length} 个：`);
        for (const s of bad) for (const p of s.problems) console.log(`  ${s.scene} [${p.kind}] ${p.text.slice(0, 240)}`);
      } else {
        console.log('控制台错误、页面错误、失败请求：全干净');
      }
      return bad.length;
    },

    async close() {
      try { ws && ws.close(); } catch { /* 已经关了 */ }
      await killBrowser();
    },
  };

  return session;
}

/** 截图与 summary.json 的落点：仓库根的 `.shots/<套件>/`（已 gitignore，不进库）。 */
export function shotsDir(suite) {
  return join(process.cwd(), '.shots', suite);
}

/** 统一收尾：合并「断言失败数」与「场景问题数」，只有两者都为 0 才算过。 */
export async function finishSuite(session, { suite, failed }) {
  const problems = await session.finish(shotsDir(suite));
  await session.close();
  if (failed || problems) {
    console.error(`\n${suite}：${failed} 条断言失败，${problems} 个场景有控制台/页面/请求问题`);
    process.exit(1);
  }
  console.log(`${suite}：通过`);
}
