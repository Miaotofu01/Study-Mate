// Real-runtime regression tests. The supplied DSH installation is read-only.
// STUDYMATE_DSH_PACKAGE=/absolute/path/to/@deepseek-ai/dsh \
// STUDYMATE_DSH_EXPECTED_VERSION=0.2.0-rc.2 node --test scripts/tests/test_dsh_runtime.mjs
// Without STUDYMATE_DSH_PACKAGE these tests skip; normal unit tests need no DSH.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

// 夹具：造一份最小科目（#68 的原生工具探针要一个真工作区）。那是夹具不是套件，
// 所以住在 scripts/tests/fixtures/ 下——放根下会被 checks.mjs 的套件覆盖断言当成漏登记。
import { writeSubject } from './fixtures/tools.mjs';
import { fakeReactRoot } from './fixtures/export_workspace.mjs';

const self = fileURLToPath(import.meta.url);
const project = path.resolve(path.dirname(self), '../..');
const runtime = process.env.STUDYMATE_DSH_PACKAGE;
const marker = 'STUDYMATE_RUNTIME_RESULT ';

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function redact(text) {
  return String(text).replace(/https?:\/\/[^\s<>"')]+/g, '[url]')
    .replace(/((?:token|authorization|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}

function atLeastRelease(version, minor, patch) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  assert.ok(match, `Unrecognized DSH version: ${version}`);
  return Number(match[1]) > 0 || Number(match[2]) > minor ||
    Number(match[2]) === minor && Number(match[3]) >= patch;
}

const modern = version => atLeastRelease(version, 1, 7);


/* ── #68：原生工具在**真 DSH** 里的注册与调用 ──────────────────────────────

   这一段验的是三件事，报告里也照这个口径写：

     1. 插件在真 DSH 里加载后，九个 `studymate_*` 工具**在 ctx.tools 上按名字查得到**，
        而且模型侧投影里只有一句话说明（没有参数表）；
     2. 直接走**真 dispatch**（`ctx.tools.execute`，含参数校验与输出契约校验）调
        `studymate_workspace_context` / `studymate_validate_curriculum` /
        `studymate_validate_lesson`，拿到结构化返回；
     3. 反证：越权读、越权写、无模型协商 —— 都通过真 dispatch 走一遍。

   **不验**的是「模型在真实会话里自己调了它」：那要花模型额度，默认门禁里不跑
   （`modelRequestsIssued: 0` 就是这条边界）。

   探针工作区造在隔离 HOME 里、并把 `DSH_HOME` 临时指过去——不碰 fixture 已经摆好的那些
   文件（`unchanged()` 会逐个字节比对它们）。 */
const STUDY_TOOL_NAMES = [
  'studymate_workspace_context',
  'studymate_validate_curriculum',
  'studymate_validate_lesson',
  'studymate_validate_pool',
  'studymate_validate_handoff',
  'studymate_renumber_lessons',
  'studymate_apply_empty_reasons',
  'studymate_export',
  // #125：核验「资源清单」里的链接。它要发真网络请求，所以这一套只验「按名字注册得到、
  // 模型侧投影只有一句话」；真实探测在 `test_reach_verify.mjs` 的 loopback 上验。
  'studymate_verify_sources',
];

const PROBE_TOOLS = [
  { name: 'studymate_probe_domain_read', declaration: { reads: ['workspace'] },
    body: 'read-pool' },
  { name: 'studymate_probe_domain_write',
    declaration: { reads: ['progress'], writes: { progress: ['nodes/*/status'] } },
    body: 'write-mastery' },
];

function dispatch(app, name, args = {}) {
  return app.ctx.tools.execute({
    callId: `studymate-probe-${name}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  });
}

function textOf(result) {
  return (result.content || []).map((block) => block.text ?? '').join('\n');
}

async function probeNativeTools(app, home) {
  const missing = STUDY_TOOL_NAMES.filter((name) => !app.ctx.tools.get(name));
  assert.deepEqual(missing, [], `这些原生工具没注册：${missing.join('、')}`);

  // 模型真正看到的那一份：只白名单 name / description / parameters，且说明只有一句
  const exposed = app.ctx.tools.schemas().filter((schema) => STUDY_TOOL_NAMES.includes(schema.name));
  assert.equal(exposed.length, STUDY_TOOL_NAMES.length, '九个工具都要出现在模型侧投影里');
  for (const schema of exposed) {
    assert.deepEqual(Object.keys(schema).sort(), ['description', 'name', 'parameters'],
      `${schema.name} 的模型侧投影多了字段`);
    assert.ok(!schema.description.includes('\n'), `${schema.name} 的说明里有换行`);
  }

  // ── 隔离的探针工作区 ──────────────────────────────────────────────────
  const root = fs.mkdtempSync(path.join(home, 'studymate-probe-'));
  const probeDsh = path.join(root, '.dsh');
  const probeWorkspace = path.join(root, '学习资料');
  fs.mkdirSync(probeDsh, { recursive: true });
  fs.mkdirSync(probeWorkspace, { recursive: true });
  // 安装器写的形态：一行注释 + JSON 对象（JSON 也是合法 YAML）；下面原生加载那段要按同样形态读回来
  fs.writeFileSync(path.join(probeDsh, 'studymate-config.yaml'),
    `# StudyMate 学习工作区与引擎项目定位\n${JSON.stringify({ workspace: probeWorkspace }, null, 2)}\n`);
  writeSubject(probeWorkspace, 'demo');
  fs.writeFileSync(path.join(probeWorkspace, '.learning', 'MEMORY.md'), '# 画像\n\n探针用。\n');

  const previousDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = probeDsh;
  const outcome = {};
  try {
    // ① 工作区摘要（结构化，不是 exit code）
    const context = await dispatch(app, 'studymate_workspace_context');
    assert.equal(context.isError, false, textOf(context));
    const summary = context.value;
    assert.equal(summary.workspace.path, probeWorkspace);
    assert.match(summary.workspace.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(summary.subjects.map((subject) => subject.slug), ['demo']);
    assert.deepEqual(summary.subjects[0].nodes.map((node) => node.id), ['var', 'fn']);
    assert.equal(summary.subjects[0].current.id, 'var');
    assert.ok(summary.capabilities && summary.capabilities.model, '摘要里要带可用能力');
    outcome.workspaceContext = {
      path: summary.workspace.path,
      today: summary.workspace.today,
      timeZone: summary.workspace.timeZone,
      subjects: summary.subjects.map((subject) => ({
        slug: subject.slug, nodes: subject.nodes.length, current: subject.current.id,
      })),
      model: summary.capabilities.model,
    };

    // ①′ #70 的原生安装断言不在这里：安装是 **runProfile 里插件 apply 触发的**，写的是 profile 的
    //     DSH_HOME。探针不碰真实 DSH HOME，所以由 harness（外层测试）读那份配置逐条断言。

    // ② 两个校验器也走真 dispatch：参数校验 + 输出契约（含嵌套 oneOf）都由宿主盖章
    const curriculum = await dispatch(app, 'studymate_validate_curriculum', { paths: ['demo'] });
    assert.equal(curriculum.isError, false, textOf(curriculum));
    assert.equal(curriculum.value.blocking, false, textOf(curriculum));
    assert.deepEqual(curriculum.value.reports.map((report) => report.kind),
      ['curriculum', 'progress', 'subject']);
    const lesson = await dispatch(app, 'studymate_validate_lesson', { paths: ['demo/lessons/0001-var.md'] });
    assert.equal(lesson.isError, false, textOf(lesson));
    assert.equal(lesson.value.reports[0].node.id, 'var');
    assert.deepEqual(lesson.value.reports[0].anchors.map((anchor) => anchor.resolution), ['resolved']);
    outcome.validators = {
      curriculum: curriculum.value.summary,
      lesson: lesson.value.reports[0].summary,
    };

    // ②′ 导出（#82）也走真 dispatch：起一个 durable 任务、有上限地等、拿回文件清单。
    //     React 用夹具（这台机器上不一定装了 React，探针不该依赖它；真渲染由 --browser 那一套
    //     用真 React + 真 Chrome 在 file:// 下验）。探针的 DSH_HOME 是隔离的，所以解析顺序里
    //     的 profile 那一跳指不到东西，这里显式给一个候选根。
    process.env.STUDYMATE_REACT_DIR = fakeReactRoot(root);
    const exported = await dispatch(app, 'studymate_export', {});
    assert.equal(exported.isError, false, textOf(exported));
    assert.equal(exported.value.settled, true, textOf(exported));
    assert.equal(exported.value.status, '完成', textOf(exported));
    assert.ok(exported.value.files.includes('index.html'), JSON.stringify(exported.value.files));
    assert.deepEqual(exported.value.problems, [], '泄漏守卫不该在真宿主里报出问题');
    assert.ok(fs.existsSync(path.join(probeWorkspace, 'export', 'index.html')));
    outcome.exportRun = {
      taskId: exported.value.taskId,
      status: exported.value.status,
      files: exported.value.count,
      subjects: exported.value.subjects.map((subject) => subject.slug),
    };

    // ③ 反证：越权读 / 越权写 —— 注册两个**故意越权**的探针工具，走真 dispatch
    const toolsModule = await import(pathToFileURL(path.join(project, 'lib/tools/index.ts')).href);
    for (const probe of PROBE_TOOLS) {
      const definition = toolsModule.defineStudyTool({ get: () => undefined }, {
        name: probe.name,
        description: '探针：故意越权，用来验 guard 在真宿主里真的抛。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: {} },
          render: () => [],
        },
        reads: probe.declaration.reads,
        writes: probe.declaration.writes,
        execute: async (_args, run) => {
          if (probe.body === 'read-pool') run.access.read('pool');
          else run.access.write('progress', 'nodes/0/mastery', () => '不该发生');
          return {};
        },
      });
      app.ctx.tools.register(definition);
      const result = await dispatch(app, probe.name);
      assert.equal(result.isError, true, `${probe.name} 越权居然成功了`);
      assert.match(textOf(result), /DOMAIN_VIOLATION/, textOf(result));
      outcome[probe.body === 'read-pool' ? 'domainReadViolation' : 'domainWriteViolation'] =
        textOf(result).split('\n')[0].slice(0, 160);
    }

    // ④ 无模型协商：requires:['model'] 的工具在**没有 llm 服务**的上下文里不跑 body
    let ran = false;
    const requiresModel = toolsModule.defineStudyTool({ get: () => undefined }, {
      name: 'studymate_probe_requires_model',
      description: '探针：声明要模型，用来验无模型时的协商形状。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object', additionalProperties: false, required: ['ran'],
          properties: { ran: { type: 'boolean' } },
        },
        render: () => [],
      },
      reads: [],
      requires: ['model'],
      execute: async () => { ran = true; return { ran: true }; },
    });
    app.ctx.tools.register(requiresModel);
    const negotiated = await dispatch(app, 'studymate_probe_requires_model');
    assert.equal(negotiated.isError, false, textOf(negotiated));
    assert.equal(negotiated.value.available, false);
    assert.equal(typeof negotiated.value.reason, 'string');
    assert.equal(ran, false, '没有模型时 body 一行都不许跑');
    outcome.modelNegotiation = negotiated.value;
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
  return outcome;
}

/* ── #74：文件监听与变更推送在**真 DSH** 里的两条路 ────────────────────────

   监听在插件 apply 时解析学习工作区（`~/.dsh/studymate-config.yaml`），所以下面这份
   探针工作区必须**先**造好、**再**启动真 DSH。只在「原生安装 + web profile」这个
   真会加载插件的组合里造它——别的场景有自己的配置断言，别去碰（migrated 用例要逐字节比对）。

   验的三件事：
     1. 生产路（`connection.fetch.register` 返回一个 body 没写完的 Response，挂在 /api 下）
        真能建起 SSE：先用宿主打印的那条 URL 换会话 cookie，再读到建连问候；
     2. 退路（`ctx.webServer.register` 的 exact 路由）在**真 webServer** 上也能建起来，
        而且没有会话时必须 401——这条路不在 /api 围栏里，认证是自己判的；
     3. 改一个课件文件 / 新建一个科目 → 通知真的推过来（`{kind:'changed',domains,at,seq}`）。

   **不验**：浏览器里的 EventSource（那要真浏览器）。页面侧的接线由
   scripts/tests/test_watch_client.mjs 拿同一份 lib/client.js 在 VM 里跑过。
   `modelRequestsIssued: 0` 这条边界不变。 */
function prepareWatchWorkspace(home) {
  // 工作区用**夹具那一个**（LEARN_WORKSPACE）：插件 apply 时跑的 installPayload 会按
  // 环境变量重写 studymate-config.yaml，另行造一个目录只会让监听盯错地方。
  const workspace = fs.realpathSync(process.env.LEARN_WORKSPACE);
  assert.ok(inside(home, workspace), '监听探针的工作区要在隔离 HOME 里');
  const subject = writeSubject(workspace, 'demo');
  return { workspace, lesson: path.join(subject.lessonsDir, '0001-var.md') };
}

/** 一条 SSE 流：收帧 + 等到条件成立（读流本身也要有超时，别把整支探针吊死）。 */
function sseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let cursor = 0;
  const notices = [];
  const harvest = () => {
    for (;;) {
      const start = text.indexOf('data: ', cursor);
      if (start < 0) return;
      const end = text.indexOf('\n\n', start);
      if (end < 0) return;
      const raw = text.slice(start + 'data: '.length, end);
      cursor = end + 2;
      try { notices.push(JSON.parse(raw)); } catch { /* 不是 JSON 的帧当没见过 */ }
    }
  };
  const pump = async (done, what, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      harvest();
      if (done()) return;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`等不到${what}：${JSON.stringify(text.slice(-300))}`);
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ timedOut: true }), left);
          timer.unref?.();
        }),
      ]);
      if (chunk.timedOut) throw new Error(`等不到${what}（读流超时）：${JSON.stringify(text.slice(-300))}`);
      if (chunk.done) throw new Error(`流断了（在等${what}）`);
      text += decoder.decode(chunk.value, { stream: true });
    }
  };
  return {
    text: () => text,
    notices: () => notices.slice(),
    greeting: async (what) => { await pump(() => /: studymate connected backend=/.test(text), what); return text; },
    waitForNotices: (count, what) => pump(() => notices.length >= count, what),
    close: () => reader.cancel(),
  };
}

/** 打开一条 SSE；路由是插件动态 import 之后才挂上的，所以前几秒允许 404。 */
async function openSse(url, headers, tries = 50) {
  let last = 0;
  for (let attempt = 0; attempt < tries; attempt++) {
    const response = await fetch(url, { headers: { accept: 'text/event-stream', ...headers } });
    if (response.status === 200) return sseReader(response);
    last = response.status;
    try { await response.body?.cancel(); } catch { /* 丢掉这个响应体 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${url} 一直不是 200（最后是 ${last}）`);
}

async function probeWatch(app, probe) {
  const connection = app.ctx.get('connection');
  const origin = `http://127.0.0.1:${app.ctx.get('webServer').port}`;

  // 宿主打印的那条 URL 自带一次性 token；换出会话 cookie，之后按正常浏览器的方式请求 /api
  const authorized = await fetch(connection.authenticatedUrl(`${origin}/`), { redirect: 'manual' });
  const cookie = (authorized.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';')[0]).join('; ');
  assert.ok(cookie, '换不到浏览器会话 cookie');
  try { await authorized.body?.cancel(); } catch { /* 只是拿 Set-Cookie */ }

  const watchModule = await import(pathToFileURL(path.join(project, 'lib/watch/index.ts')).href);
  // 退路：把 exact 路由挂到**真 webServer** 上。生产里这条路只在拿不到
  // connection.fetch.register 时才选（这里显式挂一次，把它也验到）。
  const disposeFallback = watchModule.registerWatchChannel({
    get: (name) => ((name === 'webServer' || name === 'connection') ? app.ctx.get(name) : undefined),
  }, { route: 'webServer' });

  const api = await openSse(`${origin}/api/studymate/events`, { cookie });
  const fallback = await openSse(`${origin}/plugins/studymate/events`, { cookie });
  try {
    // 退路不在 /api 围栏里：没有会话必须自己拒（不是 200）
    const denied = await fetch(`${origin}/plugins/studymate/events`);
    assert.equal(denied.status, 401, '退路没有会话时该 401');
    try { await denied.body?.cancel(); } catch { /* 只要状态码 */ }

    const apiGreeting = await api.greeting('/api 建连问候');
    await fallback.greeting('退路建连问候');

    // ① 改一个课件文件：两条通道都该收到通知。
    // 监听是**异步**起来的（扫盘 + 每个目录等 chokidar ready），改动恰好落在观察者挂好之前时
    // 那一条不补发（宿主自己的 HMR 也是靠重扫/重连兜底）。所以这里「改到收到为止，最多三次」，
    // 顺手把用了第几次记进结果——如果每次都要第二次才收到，说明就绪窗口还偏长。
    let attempt = 0;
    let lessonNotice = null;
    while (lessonNotice === null && attempt < 3) {
      attempt += 1;
      fs.appendFileSync(probe.lesson, `\n探针改动第 ${attempt} 次。\n`);
      try { await api.waitForNotices(1, '/api 上「课件变了」的通知', 3000); } catch { /* 再试一次 */ }
      lessonNotice = api.notices()[0] ?? null;
    }
    assert.ok(lessonNotice, '改了三次课件文件，一条通知都没收到');
    await fallback.waitForNotices(1, '退路上「课件变了」的通知', 3000);
    assert.equal(lessonNotice.kind, 'changed');
    assert.deepEqual(lessonNotice.domains, ['lesson'], JSON.stringify(lessonNotice));
    assert.match(lessonNotice.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(Number.isSafeInteger(lessonNotice.seq), true);

    // 监听是**异步**起来的（扫盘 + 逐个挂观察者），所以建连问候可能是「那一刻」的旧标签。
    // 收到通知说明它确实在跑；这时再连一条，读到的 backend 才是结论。
    const settled = await openSse(`${origin}/api/studymate/events`, { cookie });
    const settledGreeting = await settled.greeting('复核问候');
    await settled.close();
    const backend = /backend=([^\s]+)/.exec(settledGreeting)[1];

    // ② 外层新建一个科目：阅读端要能自动看见（这里验通知，页面侧的重取在 test_watch_client.mjs）
    writeSubject(probe.workspace, 'brand-new');
    await api.waitForNotices(2, '「新建科目」的通知');
    const all = api.notices();
    assert.equal(all.some((notice) => notice.domains.includes('subjects')), true,
      `没有一条通知说「科目层变了」：${JSON.stringify(all)}`);
    assert.equal(all.every((notice) => notice.seq > lessonNotice.seq || notice === lessonNotice), true,
      'seq 要单调递增');

    return {
      backend,
      apiGreeting: apiGreeting.split('\n')[0],
      settledGreeting: settledGreeting.split('\n')[0],
      lessonNotice,
      attempts: attempt,
      notices: all,
      fallbackNotices: fallback.notices(),
      unauthorizedFallback: denied.status,
    };
  } finally {
    await api.close().catch(() => {});
    await fallback.close().catch(() => {});
    await disposeFallback?.();
  }
}

async function probe() {
  const stdout = process.stdout.write.bind(process.stdout);
  const quiet = (_chunk, encoding, callback) => {
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  };
  // Web startup prints an access-token URL; only emit our explicit result.
  // StudyMate 自己的警告先收下来（排查用：注册失败时它只说一行，看不见就只能猜）。
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((value) => String(value)).join(' '));
    originalWarn.apply(console, args);
  };
  process.stdout.write = quiet;
  process.stderr.write = quiet;
  const timer = setTimeout(() => {
    stdout(`${marker}${JSON.stringify({ ok: false, error: 'Runtime probe timed out after 45 seconds' })}\n`);
    process.exit(2);
  }, 45000);
  let app;
  let scope;
  let result;
  try {
    assert.ok(runtime && path.isAbsolute(runtime), 'STUDYMATE_DSH_PACKAGE must be absolute');
    const temporary = fs.realpathSync(os.tmpdir());
    const home = fs.realpathSync(os.homedir());
    const dshHome = fs.realpathSync(process.env.DSH_HOME);
    assert.ok(inside(temporary, home), 'Refusing to use a non-temporary HOME');
    assert.ok(inside(home, dshHome), 'DSH_HOME must be inside the isolated HOME');
    assert.ok(inside(home, fs.realpathSync(process.env.LEARN_WORKSPACE)), 'Workspace must be isolated');
    process.chdir(home);

    const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8'));
    const isModern = modern(manifest.version);
    const requireRuntime = createRequire(path.join(runtime, 'package.json'));
    const fromRuntime = name => import(pathToFileURL(requireRuntime.resolve(`@deepseek-ai/${name}`)).href);
    const publicBoot = path.join(runtime, 'lib/profile-boot.js');
    const bootFile = fs.existsSync(publicBoot) ? publicBoot : path.join(runtime, 'lib',
      fs.readdirSync(path.join(runtime, 'lib')).find(file => /^profile-boot-.+\.js$/.test(file)));
    const bootExports = await import(pathToFileURL(bootFile).href);
    const runProfile = bootExports.runProfile || Object.values(bootExports).find(value => typeof value === 'function' && value.name === 'runProfile');
    assert.equal(typeof runProfile, 'function', 'The installed DSH must expose runProfile');
    const [{ loadLayeredEnv, loadProfileDirectory }, registry] = await Promise.all([
      fromRuntime('dsh-app-boot'), fromRuntime(isModern ? 'dsh-agent-preset-registry' : 'dsh-agent-presets'),
    ]);
    const profileName = process.env.STUDYMATE_RUNTIME_PROFILE || 'web';
    // #74：监听探针要先有一份「插件加载时就存在」的学习工作区（监听在 apply 时解析配置）
    const watchProbe = process.env.STUDYMATE_RUNTIME_SCENARIO === 'native' && profileName === 'web'
      ? prepareWatchWorkspace(home) : null;
    app = await runProfile({
      environment: loadLayeredEnv('studymate-runtime-regression', home), profile: profileName, patchFiles: [],
      // Desktop owns this profile and supplies it directly to runProfile.
      ...(profileName === 'desktop' ? { resolvedProfile: {
        profile: loadProfileDirectory('dsh', path.join(dshHome, 'profiles', profileName), path.join(runtime, 'package.json')),
        installAnchor: path.join(runtime, 'package.json'),
      } } : {}),
      args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
    });
    assert.ok(app.ctx.get('webServer')?.port > 0, 'Web must listen on an ephemeral port');
    const fresh = process.env.STUDYMATE_RUNTIME_SCENARIO === 'fresh';
    const nativeEntries = [...app.ctx.loader.entries()].filter(entry => entry.options.name === '@yunmiao/studymate');
    assert.equal(nativeEntries.length, fresh ? 0 : 1, 'Only native installations should have a native entry');
    const downgraded = process.env.STUDYMATE_RUNTIME_SCENARIO === 'downgraded';
    const migrated = downgraded || process.env.STUDYMATE_RUNTIME_SCENARIO === 'migrated';
    if (!fresh) {
      assert.equal(Boolean(nativeEntries[0].disabled), migrated, 'Only the migrated native entry should be disabled');
      if (!migrated) assert.equal(nativeEntries[0].fiber?.state, 2, 'Native entry must remain Active');
    }
    const expectLearning = fresh || migrated || isModern;
    const roster = await app.ctx.agentPresets.list();
    const standard = await app.ctx.agentPresets[isModern ? 'resolve' : 'resolveMountable']('standard');
    assert.equal(standard.broken, undefined, 'Standard mode must remain usable');
    if (downgraded) {
      const declaration = [...app.ctx.loader.entries()].find(entry => entry.options.id === 'studymate-learning-preset');
      assert.equal(declaration?.disabled, true, 'Old DSH must skip the newer declaration before importing it');
    } else {
      assert.equal(roster.filter(preset => preset.id === 'learning').length, expectLearning ? 1 : 0,
        'Learning preset must exist exactly once when supported');
    }
    if (expectLearning && !downgraded) {
      const preset = await app.ctx.agentPresets[isModern ? 'resolve' : 'resolveMountable']('learning');
      assert.equal(preset.broken, undefined);
      if (!isModern) {
        const { createScope } = await fromRuntime('dsh-scope');
        scope = createScope(app.ctx, {});
        await app.ctx.agentPresets.mount(scope.ctx, 'learning');
      }
      const mounts = registry.livePresetMounts(app.ctx.fiber).filter(mount => mount.presetId === 'learning');
      assert.equal(mounts.length, 1, 'There must be exactly one learning composition');
      if (isModern) assert.deepEqual(await registry.auditRows(mounts[0].tree), { failed: [], pending: [] });
      else assert.deepEqual(await registry.inactiveRows(mounts[0].tree), []);
      const workflowName = `@deepseek-ai/dsh-workflow-${atLeastRelease(manifest.version, 1, 6) ? 'ptc' : 'worker-thread'}`;
      const workflow = [...mounts[0].tree.entries()].find(entry => entry.options.name === workflowName);
      assert.equal(workflow?.fiber?.state, 2, 'The correct workflow must be Active');
    }
    // #68：原生工具在真 DSH 里的注册与调用。
    //
    // 只在「StudyMate 插件**真的被加载**」时跑：standalone（默认 install）写的是**声明式预设**
    // ——预设直接由 `@deepseek-ai/dsh-agent-preset` 提供，插件包根本没进 profile，所以那种安装
    // 下不存在原生工具（`nativeTools` 会是 null，调用方按 null 断言）。native 安装才会加载插件。
    // 老宿主（<0.1.7）没有 tools 服务，也跳过。
    const pluginLoaded = nativeEntries.length === 1 && !nativeEntries[0].disabled;
    const nativeTools = modern(manifest.version) && pluginLoaded
      ? await probeNativeTools(app, home) : null;
    // #74：监听与推送（两条路）——同样只在插件真的加载了的时候跑
    const watch = watchProbe && pluginLoaded && modern(manifest.version)
      ? await probeWatch(app, watchProbe) : null;
    result = { ok: true, version: manifest.version, webStarted: true, nativeDisabled: migrated,
      learningPresets: roster.filter(preset => preset.id === 'learning').length,
      learningReady: expectLearning && !downgraded, modelRequestsIssued: 0,
      ...nativeTools === null ? {} : { nativeTools },
      ...watch === null ? {} : { watch },
      studyMateWarnings: warnings.filter((text) => text.includes('StudyMate')).slice(0, 5) };
  } catch (error) {
    process.exitCode = 1;
    result = { ok: false, error: redact(error.stack || error),
      studyMateWarnings: warnings.filter((text) => text.includes('StudyMate')).slice(0, 5) };
  } finally {
    try {
      if (scope) await scope.dispose();
      if (app) await app.shutdown.shutdown(process.exitCode || 0);
    } catch (error) {
      process.exitCode = 1;
      result = { ok: false, error: redact(error.stack || error), previous: result };
    }
    clearTimeout(timer);
  }
  stdout(`${marker}${JSON.stringify(result)}\n`);
}

function fixture(t, scenario, profileName = 'web') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-runtime-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "家 O'Brien");
  const dshHome = path.join(home, '.dsh');
  const profile = path.join(dshHome, 'profiles', profileName);
  const workspace = path.join(home, '学习资料');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, DSH_HOME: dshHome, LEARN_WORKSPACE: workspace,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    DSH_TELEMETRY_DISABLED: '1', STUDYMATE_DSH_PACKAGE: path.resolve(runtime), STUDYMATE_RUNTIME_SCENARIO: scenario,
    STUDYMATE_RUNTIME_PROFILE: profileName });
  const installed = path.join(profile, 'node_modules/@yunmiao/studymate');
  if (scenario !== 'fresh') fs.mkdirSync(path.dirname(installed), { recursive: true });
  if (scenario === 'native') fs.symlinkSync(project, installed, process.platform === 'win32' ? 'junction' : 'dir');
  else if (scenario !== 'fresh') {
    fs.mkdirSync(path.join(installed, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: '@yunmiao/studymate', version: '0.1.3',
      exports: { '.': './bin/dsh-plugin.mjs' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    fs.copyFileSync(path.join(project, 'cordis.patch.yml'), path.join(installed, 'cordis.patch.yml'));
    // A 0.1.3 entry which must never run after the installer takes ownership.
    fs.writeFileSync(path.join(installed, 'bin/dsh-plugin.mjs'),
      'export const inject = ["agentPresets"]; export function apply() { throw new Error("StudyMate 0.1.3 incompatible native entry was executed"); }');
  }
  const manifest = path.join(profile, 'package.json');
  if (scenario !== 'fresh' || profileName === 'desktop') fs.writeFileSync(manifest, JSON.stringify({ name: 'studymate-test-profile', private: true,
    dependencies: scenario === 'fresh' ? {} : { '@yunmiao/studymate': scenario === 'native'
      ? JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version : '0.1.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
      ...(scenario === 'fresh' ? [] : ['@yunmiao/studymate'])] } } }, null, 2));
  const patch = path.join(profile, 'cordis.patch.yml');
  const unrelatedPatch = '# Existing unrelated plugin\n- insert:\n  - id: unrelated-disabled\n    name: "@local/not-installed"\n    disabled: true\n';
  fs.writeFileSync(patch, unrelatedPatch);
  const preserved = [path.join(dshHome, 'cordis.patch.yml'),
    path.join(dshHome, 'profiles/other/package.json'), path.join(dshHome, 'profiles/other/cordis.patch.yml')];
  if (scenario !== 'fresh') preserved.unshift(path.join(profile, 'pnpm-lock.yaml'));
  for (const file of preserved) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, file.endsWith('package.json') ? '{"private":true,"custom":"keep"}\n'
      : file.endsWith('pnpm-lock.yaml') ? "lockfileVersion: '9.0'\nsettings: {}\n" : '# Keep this profile untouched\n[]\n');
  }
  if (fs.existsSync(manifest)) preserved.unshift(manifest);
  const before = preserved.map(file => fs.readFileSync(file));
  function unchanged() {
    preserved.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index], `${file} must remain unchanged`));
    assert.ok(fs.readFileSync(patch, 'utf8').startsWith(unrelatedPatch), 'Unrelated profile patch bytes must remain unchanged');
  }
  function runProbe(selectedRuntime = runtime, selectedScenario = scenario) {
    const result = spawnSync(process.execPath, [self, '--probe'], {
      env: { ...env, STUDYMATE_DSH_PACKAGE: selectedRuntime, STUDYMATE_RUNTIME_SCENARIO: selectedScenario },
      cwd: home, encoding: 'utf8', timeout: 60000, windowsHide: true,
    });
    const line = result.stdout?.split(/\r?\n/).find(text => text.startsWith(marker));
    assert.ok(line, redact(result.error?.message || result.stderr || 'Probe produced no result'));
    const outcome = JSON.parse(line.slice(marker.length));
    assert.equal(result.status, 0, JSON.stringify(outcome));
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    return outcome;
  }
  function install(selectedRuntime = runtime, ...extra) {
    const bin = path.join(temporary, 'bin');
    fs.rmSync(bin, { recursive: true, force: true });
    fs.mkdirSync(bin);
    const dshBin = path.join(selectedRuntime, 'lib/bin.js');
    if (process.platform === 'win32') {
      // Keep the shim ASCII: cmd.exe must not decode Unicode installation paths.
      fs.writeFileSync(path.join(bin, 'dsh.cmd'), '@echo off\r\n"%STUDYMATE_TEST_NODE%" "%STUDYMATE_TEST_DSH_BIN%" %*\r\n');
    } else {
      // Match a real npm command while using only the supplied DSH installation.
      fs.symlinkSync(dshBin, path.join(bin, 'dsh'), 'file');
      fs.symlinkSync(process.execPath, path.join(bin, 'node'), 'file');
    }
    const installerEnv = { ...env, PATH: bin + path.delimiter + (env.PATH || env.Path || ''),
      STUDYMATE_TEST_NODE: process.execPath, STUDYMATE_TEST_DSH_BIN: dshBin };
    delete installerEnv.Path;
    const result = spawnSync(process.execPath, [path.join(project, 'bin/studymate.mjs'), 'install',
      ...(profileName === 'web' ? [] : ['--profile', profileName]), ...extra], {
      env: installerEnv, cwd: home, encoding: 'utf8', timeout: 60000, windowsHide: true,
    });
    assert.equal(result.status, 0, redact(result.error?.message || result.stderr || result.stdout));
  }
  // 安装器写的是「一行 YAML 注释 + JSON 对象」；JSON 对象也是合法 YAML（bin/studymate.mjs）
  function settings() {
    const file = path.join(dshHome, 'studymate-config.yaml');
    assert.ok(fs.existsSync(file), `${file} 必须在安装后存在`);
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^#[^\r\n]*\r?\n/, ''));
  }
  return { home, dshHome, workspace, patch, unchanged, runProbe, install, settings };
}

if (process.argv.includes('--probe')) {
  await probe();
} else if (!runtime) {
  test('real DSH integration (set STUDYMATE_DSH_PACKAGE to enable)', { skip: true }, () => {});
} else {
  assert.ok(path.isAbsolute(runtime), 'STUDYMATE_DSH_PACKAGE must be absolute');
  const metadata = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@deepseek-ai/dsh');
  if (process.env.STUDYMATE_DSH_EXPECTED_VERSION) assert.equal(metadata.version, process.env.STUDYMATE_DSH_EXPECTED_VERSION);
  test(`DSH ${metadata.version}: fresh standalone install and reinstall expose one usable learning mode`, { timeout: 120000 }, t => {
    const f = fixture(t, 'fresh');
    const learningData = path.join(f.workspace, 'keep.txt');
    fs.writeFileSync(learningData, 'existing learning data');
    assert.equal(fs.existsSync(path.join(f.dshHome, 'studymate-config.yaml')), false);
    assert.equal(fs.existsSync(path.join(f.dshHome, 'profiles/web/package.json')), false);
    for (let installation = 0; installation < 2; installation++) {
      f.install();
      const outcome = f.runProbe();
      assert.equal(outcome.learningPresets, 1);
      assert.equal(outcome.learningReady, true);
      // standalone 安装写的是声明式预设：插件包不进 profile，原生工具这时不存在
      assert.equal(outcome.nativeTools, undefined, JSON.stringify(outcome.nativeTools));
      assert.equal(fs.readFileSync(learningData, 'utf8'), 'existing learning data');
      f.unchanged();
    }
    // #70 只改了**原生插件路径**：standalone 安装照旧把引擎副本落在 <dshHome>/studymate/engine，
    // <root> 也照旧指向它。那份副本是**只读材料**：技能、预设、schema、工作区数据骨架与文档
    // （#83 之后引擎没有可执行脚本，Python 引擎整体退役）。
    const config = f.settings();
    const engine = path.join(f.dshHome, 'studymate', 'engine');
    assert.equal(fs.realpathSync(config.root), fs.realpathSync(engine));
    assert.equal(fs.existsSync(path.join(config.root, 'preset', 'learning', 'agent.cordis.yml')), true);
    assert.equal(fs.existsSync(path.join(config.root, 'schemas', 'curriculum.schema.json')), true);
    assert.equal(fs.existsSync(path.join(config.root, 'templates', 'MEMORY.md')), true);
    assert.equal(fs.existsSync(path.join(config.root, 'preset', 'skills', 'learning-system', 'SKILL.md')), true);
    assert.equal(fs.realpathSync(config.workspace), fs.realpathSync(f.workspace));
  });
  test(`DSH ${metadata.version}: native entry keeps Web usable`, { timeout: 70000 }, t => {
    const f = fixture(t, 'native');
    const outcome = f.runProbe();
    assert.equal(outcome.learningPresets, modern(metadata.version) ? 1 : 0);
    if (modern(metadata.version)) {
      // #70：从零装一次（插件路径）——引擎就是已安装的包，~/.dsh/studymate/ 不该出现
      const config = f.settings();
      assert.equal(fs.realpathSync(config.root), fs.realpathSync(project),
        `原生加载的 <root> 指向了 ${config.root}，不是包自身`);
      assert.deepEqual(config.installModes, { web: 'native' });
      // 判据是「没有 engine/ 这份**源码树副本**」，不是「这个目录不存在」：探针这次跑了一次
      // 导出（#82），任务台账 `studymate/tasks/export-*.json` 是 #73 明文规定的落点
      // （store.ts 的文件头：只在真起了 durable 任务时才创建）。源码树副本才是 #70 要拦的东西。
      assert.equal(fs.existsSync(path.join(f.dshHome, 'studymate', 'engine')), false,
        '原生加载不许往 ~/.dsh/studymate/engine 写源码树副本');
      assert.equal(fs.existsSync(path.join(f.dshHome, 'studymate', 'scripts')), false,
        '原生加载不许往 ~/.dsh/studymate/ 写源码树副本');
      assert.equal(fs.existsSync(path.join(f.dshHome, 'studymate', 'lib')), false,
        '原生加载不许往 ~/.dsh/studymate/ 写源码树副本');
      // 原生加载的引擎就是包自身：技能、预设、schema 与数据骨架都在包里
      assert.equal(fs.existsSync(path.join(config.root, 'preset', 'learning', 'agent.cordis.yml')), true);
      assert.equal(fs.existsSync(path.join(config.root, 'preset', 'skills', 'learning-system', 'SKILL.md')), true);
      // ① #68：插件在真 DSH 里加载后，九个原生工具注册得上、body 调得动、越权会抛
      const tools = outcome.nativeTools;
      assert.ok(tools, `原生工具探针没跑：${JSON.stringify(outcome.studyMateWarnings || [])}`);
      assert.equal(tools.workspaceContext.path, tools.workspaceContext.path);
      assert.match(tools.workspaceContext.today, /^\d{4}-\d{2}-\d{2}$/);
      assert.deepEqual(tools.workspaceContext.subjects, [{ slug: 'demo', nodes: 2, current: 'var' }]);
      assert.match(tools.domainReadViolation, /DOMAIN_VIOLATION/);
      assert.match(tools.domainWriteViolation, /DOMAIN_VIOLATION/);
      assert.equal(tools.modelNegotiation.available, false);
      assert.equal(typeof tools.modelNegotiation.reason, 'string');
      // #74：文件监听与变更推送（两条路）在真 DSH 里的实测
      const watch = outcome.watch;
      assert.ok(watch, `监听探针没跑：${JSON.stringify(outcome.studyMateWarnings || [])}`);
      assert.equal(watch.backend, 'fs-service', 'web 组合里有 ctx.fs，该走宿主的 watch');
      assert.match(watch.lessonNotice.at, /^\d{4}-\d{2}-\d{2}T/, 'at 是 ISO 时刻');
      assert.ok(watch.attempts >= 1 && watch.attempts <= 3, `就绪窗口偏长：第 ${watch.attempts} 次改动才收到`);
      assert.equal(watch.notices.some((notice) => notice.domains.includes('subjects')), true,
        '新建科目要推出一条「科目层变了」的通知');
      assert.match(watch.apiGreeting, /^: studymate connected backend=/);
      assert.deepEqual(watch.lessonNotice.domains, ['lesson']);
      assert.equal(watch.lessonNotice.kind, 'changed');
      assert.equal(watch.fallbackNotices.length >= 1, true, '退路（webServer 精确路由）也要收到通知');
      assert.equal(watch.unauthorizedFallback, 401, '退路没会话时必须自己拒');
    }
    if (!modern(metadata.version)) {
      assert.equal(fs.existsSync(path.join(f.dshHome, 'studymate-config.yaml')), false);
      assert.equal(fs.existsSync(path.join(f.dshHome, 'studymate')), false);
    }
    f.unchanged();
  });
  if (atLeastRelease(metadata.version, 2, 0)) {
    for (const scenario of ['native', 'fresh']) {
      test(`DSH ${metadata.version}: Desktop ${scenario} installation exposes one usable learning mode`, { timeout: 70000 }, t => {
        const f = fixture(t, scenario, 'desktop');
        assert.equal(fs.existsSync(path.join(f.dshHome, 'studymate-config.yaml')), false);
        const learningData = path.join(f.workspace, 'keep.txt');
        fs.writeFileSync(learningData, 'existing learning data');
        if (scenario === 'fresh') f.install();
        const outcome = f.runProbe();
        assert.equal(outcome.learningPresets, 1);
        assert.equal(outcome.learningReady, true);
        if (scenario === 'native') {
          assert.ok(outcome.nativeTools, `原生工具探针没跑：${JSON.stringify(outcome.studyMateWarnings || [])}`);
          assert.match(outcome.nativeTools.domainReadViolation, /DOMAIN_VIOLATION/);
        } else {
          assert.equal(outcome.nativeTools, undefined);
        }
        assert.equal(fs.readFileSync(learningData, 'utf8'), 'existing learning data');
        f.unchanged();
      });
    }
  }
  test(`DSH ${metadata.version}: installer recovers the old native package without changing other profiles`, { timeout: 70000 }, t => {
    const f = fixture(t, 'migrated');
    const learningData = path.join(f.workspace, 'learning-data.txt');
    fs.writeFileSync(learningData, 'existing learning data');
    fs.writeFileSync(path.join(f.dshHome, 'studymate-config.yaml'), JSON.stringify({ workspace: f.workspace, custom: 'keep' }));
    f.install();
    f.unchanged();
    const outcome = f.runProbe();
    assert.equal(outcome.learningPresets, 1);
    assert.equal(outcome.nativeDisabled, true);
    assert.equal(outcome.nativeTools, undefined, '插件被停用时不该有原生工具');
    assert.equal(fs.readFileSync(learningData, 'utf8'), 'existing learning data');
    const config = JSON.parse(fs.readFileSync(path.join(f.dshHome, 'studymate-config.yaml'), 'utf8').replace(/^#[^\r\n]*\r?\n/, ''));
    assert.equal(config.custom, 'keep');
    f.unchanged();
  });
  test(`DSH ${metadata.version}: switching standalone to native re-points <root> at the installed package`, { timeout: 70000 }, t => {
    // 完整走一遍真实迁移：standalone 安装 → 显式交接（`--mode native`，只换注册与归属）→ 原生启动，
    // 启动时插件自己跑一遍 installPayload。交接那一步不落载荷，所以引擎路径是原生启动写的。
    const f = fixture(t, 'native');
    f.install();
    const standalone = f.settings();
    const engine = path.join(f.dshHome, 'studymate', 'engine');
    assert.equal(fs.realpathSync(standalone.root), fs.realpathSync(engine));
    assert.equal(standalone.installModes.web, 'standalone');
    // 交接安装必须先摘掉 installer 自己的声明，否则原生启动会拒绝接管（这是设计，不是这次改的）
    f.install(runtime, '--mode', 'native');
    assert.equal(f.settings().installModes.web, 'native');
    const outcome = f.runProbe();
    assert.equal(outcome.learningReady, true);
    const switched = f.settings();
    assert.equal(fs.realpathSync(switched.root), fs.realpathSync(project),
      `native 启动后 <root> 还是 ${switched.root}`);
    assert.deepEqual(switched.installModes, { web: 'native' });
    // 换完之后 <root> 是包自身：技能、预设与数据骨架都在里面——预设的 customSkillDirs 指的就是它
    assert.equal(fs.existsSync(path.join(switched.root, 'preset', 'learning', 'agent.cordis.yml')), true);
    assert.equal(fs.existsSync(path.join(switched.root, 'preset', 'skills', 'learning-system', 'SKILL.md')), true);
    assert.equal(fs.realpathSync(switched.workspace), fs.realpathSync(f.workspace));
  });
  if (process.env.STUDYMATE_DSH_DOWNGRADE_PACKAGE) {
    test('a modern installer declaration cannot prevent older DSH from booting, and reinstall restores learning', { timeout: 120000 }, t => {
      const older = process.env.STUDYMATE_DSH_DOWNGRADE_PACKAGE;
      assert.equal(modern(metadata.version), true);
      const f = fixture(t, 'migrated');
      const data = path.join(f.workspace, 'keep.txt');
      fs.writeFileSync(data, 'keep learning data');
      f.install();
      f.runProbe();
      const config = path.join(f.dshHome, 'studymate-config.yaml');
      const before = [f.patch, config].map(file => fs.readFileSync(file));
      f.runProbe(older, 'downgraded');
      [f.patch, config].forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
      f.install(older);
      assert.equal(f.runProbe(older).learningPresets, 1);
      assert.equal(fs.readFileSync(data, 'utf8'), 'keep learning data');
      f.unchanged();
    });
  }
}
