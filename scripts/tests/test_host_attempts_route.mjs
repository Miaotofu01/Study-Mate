/* 特征化测试：Host 半路由 · `POST /api/studymate/attempts`（#72 的 Host 半）
   ────────────────────────────────────────────────────────────────────────
   数据层（`lib/attempts.ts`）的栅栏已经由 test_host_attempts_fence.mjs 钉住；这里钉的是
   **阅读端真正打到的那一层**：路由怎么挂、请求体什么形状、状态码怎么映射、错误怎么说话。

   验收标准逐条对应：
     1. **跨请求**：POST 落盘之后，另起一次 `readLibrary`（= 浏览器刷新后那次
        `GET /api/studymate/library`）仍带得回「上次选了 X」；重放同一个 operationId
        不产生第二条记录（文件字节不变）；
     2. **另一个写入者改过之后**：POST 被 409 拒绝、**不写盘**，回执里带回当前内容与版本号
        （阅读端据此重读，不必再跑一趟），学生看得到冲突原文；
     3. **主观题自评**（答对了 / 答了一半 / 没答上）同样落盘，字段是 `自评`；
     4. **题库逐字不变**：`.quiz.json` 与课件正文在整轮写入前后逐字节相等。

   工作区在 fs.mkdtemp 造的临时 HOME 里现造现弃（ADR-0009：仓库里不存样例数据）。

   两处刻意的写法：
     · `DSH_HOME` 指向临时目录——`resolveWorkspace()` 读的就是它，走真路径而不是给路由开后门；
     · 路由**通过 `registerAttemptRoutes` 挂一遍再取出来调**，不是直接调 handler：
       验收项「阅读端 → Host 半 → 落盘」里的第一跳就是这次注册。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { ATTEMPTS_PATH, registerAttemptRoutes } from '../../lib/attempts-route.ts';
import { attemptsVersion, writeAttempts } from '../../lib/attempts.ts';
import { readLibrary } from '../../lib/library.ts';

/* ── 临时工作区：跑完即弃 ─────────────────────────────────────────────── */

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
});

const SUBJECT = 'demo';
const NODE = 'net.layers';
const OBJECTIVE = '每层各管一段#0';
const OPEN = '每层各管一段#1';

/** 一份最小科目 + 一份临时 HOME，并把 DSH_HOME 指过去（resolveWorkspace 只认这个）。 */
function makeHome() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-route-'));
  TEMPS.push(root);
  const home = path.join(root, 'dsh');
  const workspace = path.join(root, 'ws');
  const subjectDir = path.join(workspace, '.learning', 'subjects', SUBJECT);
  fs.mkdirSync(path.join(subjectDir, 'lessons'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'studymate-config.yaml'), `workspace: ${JSON.stringify(workspace)}\n`);
  fs.writeFileSync(path.join(subjectDir, 'subject.yaml'), `slug: ${SUBJECT}\nname: 作答\n`);
  fs.writeFileSync(path.join(subjectDir, 'curriculum.yaml'), `nodes:\n  - id: ${NODE}\n    title: 分层\n`);
  fs.writeFileSync(path.join(subjectDir, 'progress.yaml'),
    'updated_at: "2026-09-24"\nnodes:\n  net.layers:\n    status: 学习中\nproject:\n  current: ""\n');
  fs.writeFileSync(path.join(subjectDir, 'lessons', `0001-${NODE}.md`),
    '# 分层\n\n::: quiz 理解 锚点：每层各管一段\n:::\n');
  fs.writeFileSync(path.join(subjectDir, 'lessons', `0001-${NODE}.quiz.json`), JSON.stringify({
    '每层各管一段': [
      { q: '哪一层解析域名？', opts: ['应用层', '传输层', '网络层', '链路层'], ans: 0, why: 'DNS 在应用层。' },
      { q: '举一个跨层的例子。', answer: '隧道：内层 IP 包被塞进外层载荷。', criteria: '同时涉及两层以上。' },
    ],
  }, null, 2) + '\n');
  return { root, home, workspace, subjectDir, attemptsDir: path.join(subjectDir, 'attempts') };
}

/* ── 挂路由：模拟宿主的**两层** ctx（外层 `inject` → 注入后的 connection ctx）──
   注册约定与 `registerAskSessionRoute` / `registerTaskRoute` 逐字相同：收外层 ctx、自己
   `inject(['connection'])`。所以假 ctx 也要两层，`inject` 立刻回调（与宿主同一时机）。 */

function connect() {
  const routes = [];
  const labels = [];
  const child = {
    connection: { fetch: { register: (route) => { routes.push(route); return () => {}; } } },
    effect: (fn, label) => { labels.push(label); return fn(); },
  };
  const injections = [];
  const ctx = {
    inject: (names, handler) => { injections.push(names); handler(child); },
  };
  registerAttemptRoutes(ctx);
  return { ctx, child, injections, routes, labels, route: routes[0] };
}

/** 一次 POST：路由注册出来的那个 handler 原样吃一个 Request（与宿主同一条路径）。 */
function post(route, body, init = {}) {
  return route.fetch(new Request('http://127.0.0.1' + ATTEMPTS_PATH, Object.assign({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, init)));
}

let seq = 0;
function op(name) {
  seq += 1;
  return `${name}-${process.pid}-${seq}`;
}

function countFiles(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/** 一次完整的作答请求体：`expectedVersion` 默认取当前盘上的版本号（等于阅读端刚读到的那个）。 */
function submission(workspace, overrides = {}) {
  return Object.assign({
    subject: SUBJECT,
    node: NODE,
    questions: { [OBJECTIVE]: { 选: 0, 对: true } },
    operationId: op('post'),
    expectedVersion: attemptsVersion({ workspace, subject: SUBJECT, node: NODE }),
  }, overrides);
}

/* ── 注册 ─────────────────────────────────────────────────────────────── */

test('路由挂得上：路径、方法、请求体，以及缺 connection 时不炸', () => {
  const { routes, labels, injections } = connect();
  assert.equal(routes.length, 1);
  const [route] = routes;
  assert.equal(route.path, ATTEMPTS_PATH);
  assert.equal(route.path, '/api/studymate/attempts', '阅读端 lib/client.js 的 ATTEMPTS_ENDPOINT 必须与它逐字一致');
  assert.deepEqual(route.methods, ['POST'], '只开写；读走 payload 的 node.attempts，不另开一条读路径');
  assert.equal(route.requestBody, 'buffered');
  assert.equal(typeof route.fetch, 'function');
  assert.deepEqual(labels, ['studymate: 作答数据路由'], '注册是有主的副作用（走 effect）');

  // 外层 ctx 只 inject 一次，而且只要 connection（与另外三条路由同一份清单）
  assert.deepEqual(injections, [['connection']]);

  // headless / 更老的宿主：没有 inject、或注入后缺 connection / effect 时**一条路由都不挂**，
  // 也绝不抛——挂不上就是这一个功能不可用，插件其余部分照常
  const nothing = [];
  const bare = { inject: (names, handler) => handler({}) };
  assert.doesNotThrow(() => registerAttemptRoutes(undefined));
  assert.doesNotThrow(() => registerAttemptRoutes(null));
  assert.doesNotThrow(() => registerAttemptRoutes({}));
  assert.doesNotThrow(() => registerAttemptRoutes(bare));
  assert.doesNotThrow(() => registerAttemptRoutes({
    inject: (names, handler) => handler({ connection: {}, effect: () => {} }),
  }));
  assert.doesNotThrow(() => registerAttemptRoutes({
    inject: (names, handler) => handler({ connection: { fetch: { register: (route) => nothing.push(route) } } }),
  }));
  assert.deepEqual(nothing, [], '缺 effect 时不许注册');
});

/* ── 1. 落盘 + 跨请求读回 + 重放 ──────────────────────────────────────── */

test('POST 落盘：回执、状态码，以及**另起一次读**（= 刷新页面）仍带得回答作', async () => {
  const { home, workspace, attemptsDir } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();

  // 作答之前：payload 说这个节点没作答过，但版本号是可用基线（第一次写入要带上它）
  const before = readLibrary({ workspace }).subjects[0].nodes[0];
  assert.equal(before.attempts.present, false);
  assert.match(before.attempts.version, /^[0-9a-f]{16}$/);

  const body = submission(workspace, { expectedVersion: before.attempts.version });
  const response = await post(route, body);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.ok, true);
  assert.match(receipt.version, /^[0-9a-f]{16}$/);
  assert.notEqual(receipt.version, before.attempts.version, '写完版本号要换一个：它就是下一次的栅栏');
  const last = receipt.attempts['题'][OBJECTIVE]['上次结果'];
  assert.equal(last['选'], 0);
  assert.equal(last['对'], true);

  // **跨请求**：这是浏览器刷新后真正走的读路径（GET /api/studymate/library → readLibrary）
  const refreshed = readLibrary({ workspace }).subjects[0].nodes[0];
  assert.equal(refreshed.attempts.present, true);
  assert.equal(refreshed.attempts.version, receipt.version);
  assert.deepEqual(refreshed.attempts.questions[OBJECTIVE]['上次结果'], last,
    '刷新页面后「上次选了 X」还在：数据来自 attempts/，不是页面内存');

  // 落盘文件与回执同一份（回执不是另拼的一个对象）
  const onDisk = JSON.parse(fs.readFileSync(path.join(attemptsDir, `0001-${NODE}.json`), 'utf8'));
  assert.deepEqual(onDisk, receipt.attempts);
  assert.equal(countFiles(attemptsDir), 1);
});

test('重放同一个 operationId：回执相等、文件字节不变、不产生第二条记录', async () => {
  const { home, workspace, attemptsDir } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();

  const body = submission(workspace);
  const first = await (await post(route, body)).json();
  const file = path.join(attemptsDir, `0001-${NODE}.json`);
  const bytes = fs.readFileSync(file);

  const replay = await post(route, body);
  assert.equal(replay.status, 200);
  const second = await replay.json();
  assert.deepEqual(second, first, '重放要原样回放上次的回执');
  assert.deepEqual(fs.readFileSync(file), bytes, '重放后文件字节不变');
  assert.equal(countFiles(attemptsDir), 1);
});

test('再答一次是追加：history 里两条，上次结果是新的那条', async () => {
  const { home, workspace } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();

  const first = await (await post(route, submission(workspace))).json();
  const second = await (await post(route, submission(workspace, {
    questions: { [OBJECTIVE]: { 选: 2, 对: false, 错因: '把 DNS 当成网络层的事' } },
    expectedVersion: first.version,
    operationId: op('again'),
  }))).json();
  const one = second.attempts['题'][OBJECTIVE];
  assert.equal(one['作答历史'].length, 2);
  assert.deepEqual(one['上次结果'], {
    时: one['作答历史'][1]['时'], 选: 2, 对: false, 错因: '把 DNS 当成网络层的事',
  });
});

/* ── 2. 另一个写入者 ──────────────────────────────────────────────────── */

test('另一个写入者改过之后：409 拒绝、不写盘、带回当前内容（阅读端据此重读）', async () => {
  const { home, workspace, attemptsDir } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();

  // 学生甲先答（也是走路由）
  const 甲 = await (await post(route, submission(workspace))).json();
  const file = path.join(attemptsDir, `0001-${NODE}.json`);
  const bytes = fs.readFileSync(file);

  // 学生乙手里还是作答**之前**那个版本号（页面开着没刷）
  const stale = await post(route, submission(workspace, {
    questions: { [OBJECTIVE]: { 选: 3, 对: false } },
    expectedVersion: '0000000000000000',
    operationId: op('stale'),
  }));
  assert.equal(stale.status, 409);
  const refused = await stale.json();
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'version-conflict');
  assert.match(refused.error.message, /版本号对不上/, '拒绝的原因要是一句人话，阅读端原样带给学生');
  assert.equal(refused.version, 甲.version, '冲突时顺手带回当前版本号 = 已经重读过了');
  assert.deepEqual(refused.attempts, 甲.attempts, '带回来的是甲写的那份：乙的数据没丢也没覆盖');
  assert.deepEqual(fs.readFileSync(file), bytes, '被拒绝的那次不写盘');

  // 阅读端按带回的版本号重来：这次成功，甲那条历史还在
  const retried = await (await post(route, submission(workspace, {
    questions: { [OBJECTIVE]: { 选: 3, 对: false } },
    expectedVersion: refused.version,
    operationId: op('retry'),
  }))).json();
  assert.equal(retried.ok, true);
  assert.equal(retried.attempts['题'][OBJECTIVE]['作答历史'].length, 2, '甲那条没丢');
  assert.equal(retried.attempts['题'][OBJECTIVE]['上次结果']['选'], 3);
});

test('另一个写入者是模型侧（直接用数据层写）：路由这侧一样拒绝并重读', async () => {
  const { home, workspace } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();
  const before = attemptsVersion({ workspace, subject: SUBJECT, node: NODE });

  // 模型重出题那侧不经路由，直接调数据层——两条写入路径撞的是同一份文件
  const model = writeAttempts({
    workspace, subject: SUBJECT, node: NODE,
    questions: { [OPEN]: { 选: null, 对: true, 自评: '答了一半' } },
    expectedVersion: before, operationId: op('model'),
  });
  assert.equal(model.ok, true);

  const response = await post(route, submission(workspace, { expectedVersion: before }));
  assert.equal(response.status, 409);
  const refused = await response.json();
  assert.equal(refused.version, model.version);
  assert.equal(refused.attempts['题'][OPEN]['上次结果']['自评'], '答了一半');
});

/* ── 3. 主观题自评 ────────────────────────────────────────────────────── */

test('主观题自评（答对了 / 答了一半 / 没答上）同样落盘，字段是「自评」', async () => {
  const { home, workspace, attemptsDir } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();

  let version = attemptsVersion({ workspace, subject: SUBJECT, node: NODE });
  const 档 = ['答对了', '答了一半', '没答上'];
  for (const label of 档) {
    const response = await post(route, submission(workspace, {
      questions: { [OPEN]: { 选: null, 对: label === '答对了', 自评: label } },
      expectedVersion: version,
      operationId: op('self'),
    }));
    assert.equal(response.status, 200, label);
    version = (await response.json()).version;
  }

  const raw = JSON.parse(fs.readFileSync(path.join(attemptsDir, `0001-${NODE}.json`), 'utf8'));
  const one = raw['题'][OPEN];
  assert.deepEqual(one['作答历史'].map((entry) => entry['自评']), 档);
  assert.deepEqual(one['作答历史'].map((entry) => entry['对']), [true, false, false],
    '「对」取自评的第一档：只有「答对了」算对');
  assert.equal(one['作答历史'].every((entry) => entry['选'] === null), true);
  // 自评也回得到界面上（刷新页面那次读的就是这条路径）
  assert.equal(readLibrary({ workspace }).subjects[0].nodes[0].attempts.questions[OPEN]['上次结果']['自评'], '没答上');
});

/* ── 请求体与状态码 ───────────────────────────────────────────────────── */

test('坏请求：非 JSON、缺字段、越界科目/节点、没有课件 —— 一律 400 且不写盘', async () => {
  const { home, workspace, attemptsDir } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();

  const notJson = await post(route, null, { body: '这不是 JSON' });
  assert.equal(notJson.status, 400);
  assert.equal((await notJson.json()).error.code, 'body-invalid');

  const cases = [
    ['operation-id-invalid', { operationId: undefined }],
    ['questions-invalid', { questions: {} }],
    ['expected-version-required', { expectedVersion: undefined }],
    ['subject-invalid', { subject: '演示/科目' }],
    ['node-invalid', { node: '../net.layers' }],
    ['lesson-missing', { node: 'net.tcp' }],
  ];
  for (const [error, overrides] of cases) {
    const response = await post(route, submission(workspace, Object.assign({ operationId: op('bad') }, overrides)));
    assert.equal(response.status, 400, error);
    const body = await response.json();
    assert.equal(body.error.code, error);
    assert.equal(typeof body.error.message, 'string');
    assert.notEqual(body.error.message, '', '拒绝必须带一句能给学生看的话');
  }
  assert.equal(countFiles(attemptsDir), 0, '坏请求一律不写盘');

  // 只收 POST：别的动词给 405（宿主按 methods 过滤，这里是第二道）
  const wrongMethod = await route.fetch(new Request('http://127.0.0.1' + ATTEMPTS_PATH, { method: 'GET' }));
  assert.equal(wrongMethod.status, 405);
  assert.equal((await wrongMethod.json()).error.code, 'method-not-allowed');
});

test('没配工作区：500 加一句能自救的话，不抛', async () => {
  const { home } = makeHome();
  process.env.DSH_HOME = path.join(home, '空');   // 目录不存在 = 没配 workspace
  const { route } = connect();
  const response = await post(route, { subject: SUBJECT, node: NODE });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error.code, 'no-workspace');
  assert.match(body.error.message, /studymate-config\.yaml/);
});

/* ── 4. 题库逐字不变 ──────────────────────────────────────────────────── */

test('整轮写入前后：题库与课件正文逐字节相等（作答绝不写回题库）', async () => {
  const { home, workspace, subjectDir, attemptsDir } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();

  const pool = path.join(subjectDir, 'lessons', `0001-${NODE}.quiz.json`);
  const lesson = path.join(subjectDir, 'lessons', `0001-${NODE}.md`);
  const poolBytes = fs.readFileSync(pool);
  const lessonBytes = fs.readFileSync(lesson);

  const first = await (await post(route, submission(workspace))).json();
  await post(route, submission(workspace, {
    questions: { [OPEN]: { 选: null, 对: true, 自评: '答对了' } },
    expectedVersion: first.version, operationId: op('open'),
  }));
  // 再来一次被拒的写入（冲突路径也不许碰题库）
  await post(route, submission(workspace, { expectedVersion: '0000000000000000', operationId: op('conflict') }));

  assert.deepEqual(fs.readFileSync(pool), poolBytes, '题库必须逐字不变（ADR-0007）');
  assert.deepEqual(fs.readFileSync(lesson), lessonBytes, '课件正文也不动');
  assert.equal(fs.readdirSync(path.join(subjectDir, 'lessons')).filter((name) => name.endsWith('.quiz.json')).length, 1);
  assert.deepEqual(fs.readdirSync(attemptsDir), [`0001-${NODE}.json`], '作答只落在 attempts/ 一个文件里');
});
