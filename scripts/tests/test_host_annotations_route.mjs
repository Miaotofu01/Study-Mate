/* 特征化测试：Host 半路由 · `POST /api/studymate/annotations`（ADR-0015 的 Host 半）
   ────────────────────────────────────────────────────────────────────────
   数据层（`lib/annotations.ts`）的栅栏已经由 test_host_annotations.mjs 钉住；这里钉的是
   **阅读端真正打到的那一层**：路由怎么挂、请求体什么形状、状态码怎么映射、错误怎么说话。

   验收标准逐条对应：
     1. **跨请求**：POST 落盘之后，另起一次 `readLibrary`（= 浏览器刷新后那次
        `GET /api/studymate/library`）仍带得回标注与版本号；重放同一个 operationId
        不产生第二遍写入（文件字节不变）；
     2. **另一个写入者改过之后**：POST 被 409 拒绝、**不写盘**，回执里带回当前标注与版本号
        （阅读端据此重读，不必再跑一趟）；
     3. **同 op 换内容**：409 `operation-id-conflict`；
     4. **坏请求/越界**：一律 400（信封是 route-envelope 那一份）+ 非 POST 405，且不写盘；
     5. **课件绝不被写**：整轮写入前后课件正文逐字节相等。

   工作区在 fs.mkdtemp 造的临时 HOME 里现造现弃（ADR-0009：仓库里不存样例数据）。

   两处刻意的写法（与 test_host_attempts_route.mjs 同一姿势）：
     · `DSH_HOME` 指向临时目录——`resolveWorkspace()` 读的就是它，走真路径而不是给路由开后门；
     · 路由**通过 `registerAnnotationRoutes` 挂一遍再取出来调**，不是直接调 handler：
       验收项「阅读端 → Host 半 → 落盘」里的第一跳就是这次注册。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { ANNOTATIONS_PATH, registerAnnotationRoutes } from '../../lib/annotations-route.ts';
import { annotationsVersion, readAnnotations } from '../../lib/annotations.ts';
import { readLibrary } from '../../lib/library.ts';

/* ── 临时工作区：跑完即弃 ─────────────────────────────────────────────── */

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
});

const SUBJECT = 'demo';
const NODE = 'net.layers';

/** 一份最小科目 + 一份临时 HOME，并把 DSH_HOME 指过去（resolveWorkspace 只认这个）。 */
function makeHome() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-annotations-route-'));
  TEMPS.push(root);
  const home = path.join(root, 'dsh');
  const workspace = path.join(root, 'ws');
  const subjectDir = path.join(workspace, '.learning', 'subjects', SUBJECT);
  fs.mkdirSync(path.join(subjectDir, 'lessons'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'studymate-config.yaml'), `workspace: ${JSON.stringify(workspace)}\n`);
  fs.writeFileSync(path.join(subjectDir, 'subject.yaml'), `slug: ${SUBJECT}\nname: 标注\n`);
  fs.writeFileSync(path.join(subjectDir, 'curriculum.yaml'), `nodes:\n  - id: ${NODE}\n    title: 分层\n`);
  fs.writeFileSync(path.join(subjectDir, 'progress.yaml'),
    'updated_at: "2026-09-24"\nnodes: {}\nproject:\n  current: ""\n');
  fs.writeFileSync(path.join(subjectDir, 'lessons', `0001-${NODE}.md`), '# 分层\n\n网络分四层。\n\n每层各管一段。\n');
  return { root, home, workspace, subjectDir, annotationsDir: path.join(subjectDir, 'annotations') };
}

/* ── 挂路由：模拟宿主的**两层** ctx（外层 `inject` → 注入后的 connection ctx）──
   注册约定与 `registerAttemptRoutes` / `registerAskSessionRoute` / `registerTaskRoute` 逐字相同：
   收外层 ctx、自己 `inject(['connection'])`。所以假 ctx 也要两层，`inject` 立刻回调。 */

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
  registerAnnotationRoutes(ctx);
  return { ctx, child, injections, routes, labels, route: routes[0] };
}

/** 一次 POST：路由注册出来的那个 handler 原样吃一个 Request（与宿主同一条路径）。 */
function post(route, body, init = {}) {
  return route.fetch(new Request('http://127.0.0.1' + ANNOTATIONS_PATH, Object.assign({
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

/** 一条最普通的标注。 */
function annotation(overrides = {}) {
  return {
    id: 'a-1',
    note: '这里要回看',
    ranges: [{ line: 3, kind: 'para', hash: 'h-1', start: 2, end: 6 }],
    created: '2026-11-10T09:00:00.000Z',
    modified: '2026-11-10T09:00:00.000Z',
    ...overrides,
  };
}

/** 一次完整的写入请求体：`expectedVersion` 默认取当前盘上的版本号（= 阅读端刚读到的那个）。 */
function submission(workspace, overrides = {}) {
  return Object.assign({
    subject: SUBJECT,
    node: NODE,
    annotations: [annotation()],
    operationId: op('post'),
    expectedVersion: annotationsVersion({ workspace, subject: SUBJECT, node: NODE }),
  }, overrides);
}

/* ── 注册 ─────────────────────────────────────────────────────────────── */

test('路由挂得上：路径、方法、请求体，以及缺 connection 时不炸', () => {
  const { routes, labels, injections } = connect();
  assert.equal(routes.length, 1);
  const [route] = routes;
  assert.equal(route.path, ANNOTATIONS_PATH);
  assert.equal(route.path, '/api/studymate/annotations', '阅读端的标注端点必须与它逐字一致');
  assert.deepEqual(route.methods, ['POST'], '只开写；读走 payload 的 node.annotations，不另开一条读路径');
  assert.equal(route.requestBody, 'buffered');
  assert.equal(typeof route.fetch, 'function');
  assert.deepEqual(labels, ['studymate: 课件标注路由'], '注册是有主的副作用（走 effect）');

  // 外层 ctx 只 inject 一次，而且只要 connection（与另外几条路由同一份清单）
  assert.deepEqual(injections, [['connection']]);

  // headless / 更老的宿主：没有 inject、或注入后缺 connection / effect 时**一条路由都不挂**，
  // 也绝不抛——挂不上就是这一个功能不可用，插件其余部分照常
  const nothing = [];
  const bare = { inject: (names, handler) => handler({}) };
  assert.doesNotThrow(() => registerAnnotationRoutes(undefined));
  assert.doesNotThrow(() => registerAnnotationRoutes(null));
  assert.doesNotThrow(() => registerAnnotationRoutes({}));
  assert.doesNotThrow(() => registerAnnotationRoutes(bare));
  assert.doesNotThrow(() => registerAnnotationRoutes({
    inject: (names, handler) => handler({ connection: {}, effect: () => {} }),
  }));
  assert.doesNotThrow(() => registerAnnotationRoutes({
    inject: (names, handler) => handler({ connection: { fetch: { register: (route) => nothing.push(route) } } }),
  }));
  assert.deepEqual(nothing, [], '缺 effect 时不许注册');
});

/* ── 1. 落盘 + 跨请求读回 + 重放 ──────────────────────────────────────── */

test('POST 落盘：回执、状态码，以及**另起一次读**（= 刷新页面）仍带得回标注', async () => {
  const { home, workspace, annotationsDir } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();

  // 标注之前：payload 说这个节点没标过，但版本号是可用基线（第一次写入要带上它）
  const before = readLibrary({ workspace }).subjects[0].nodes[0];
  assert.equal(before.annotations.present, false);
  assert.match(before.annotations.version, /^[0-9a-f]{16}$/);

  const body = submission(workspace, { expectedVersion: before.annotations.version });
  const response = await post(route, body);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.ok, true);
  assert.match(receipt.version, /^[0-9a-f]{16}$/);
  assert.notEqual(receipt.version, before.annotations.version, '写完版本号要换一个：它就是下一次的栅栏');
  assert.equal(receipt.annotations['节点'], NODE);
  assert.equal(receipt.annotations['标']['a-1'].note, '这里要回看');

  // **跨请求**：这是浏览器刷新后真正走的读路径（GET /api/studymate/library → readLibrary）
  const refreshed = readLibrary({ workspace }).subjects[0].nodes[0];
  assert.equal(refreshed.annotations.present, true);
  assert.equal(refreshed.annotations.version, receipt.version);
  assert.deepEqual(refreshed.annotations.items, Object.values(receipt.annotations['标']),
    '刷新页面后标注还在：数据来自 annotations/，不是页面内存');

  // 落盘文件与回执同一份（回执不是另拼的一个对象）
  const onDisk = JSON.parse(fs.readFileSync(path.join(annotationsDir, `0001-${NODE}.json`), 'utf8'));
  assert.deepEqual(onDisk, receipt.annotations);
  assert.equal(countFiles(annotationsDir), 1);
});

test('重放同一个 operationId：回执相等、文件字节不变、不产生第二遍写入', async () => {
  const { home, workspace, annotationsDir } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();

  const body = submission(workspace);
  const first = await (await post(route, body)).json();
  const file = path.join(annotationsDir, `0001-${NODE}.json`);
  const bytes = fs.readFileSync(file);

  const replay = await post(route, body);
  assert.equal(replay.status, 200);
  const second = await replay.json();
  assert.deepEqual(second, first, '重放要原样回放上次的回执');
  assert.deepEqual(fs.readFileSync(file), bytes, '重放后文件字节不变');
  assert.equal(countFiles(annotationsDir), 1);
});

test('全量替换：第二次 POST 就是全部标注（删掉的旧的不会回来）', async () => {
  const { home, workspace } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();

  const first = await (await post(route, submission(workspace, {
    annotations: [annotation({ id: 'a-1' }), annotation({ id: 'b-2' })],
  }))).json();
  const second = await (await post(route, submission(workspace, {
    annotations: [annotation({ id: 'b-2', note: '只留第二条' })],
    expectedVersion: first.version,
    operationId: op('replace'),
  }))).json();
  assert.equal(second.ok, true);
  assert.deepEqual(Object.keys(second.annotations['标']), ['b-2']);
  assert.deepEqual(readLibrary({ workspace }).subjects[0].nodes[0].annotations.items.map((one) => one.id), ['b-2']);
});

/* ── 2. 另一个写入者 ──────────────────────────────────────────────────── */

test('另一个写入者改过之后：409 拒绝、不写盘、带回当前标注（阅读端据此重读）', async () => {
  const { home, workspace, annotationsDir } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();

  // 学生甲先标（也是走路由）
  const 甲 = await (await post(route, submission(workspace, {
    annotations: [annotation({ id: 'a-1', note: '甲写的' })],
  }))).json();
  const file = path.join(annotationsDir, `0001-${NODE}.json`);
  const bytes = fs.readFileSync(file);

  // 学生乙手里还是标注**之前**那个版本号（页面开着没刷）
  const stale = await post(route, submission(workspace, {
    annotations: [annotation({ id: 'b-2', note: '乙写的' })],
    expectedVersion: '0000000000000000',
    operationId: op('stale'),
  }));
  assert.equal(stale.status, 409);
  const refused = await stale.json();
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'version-conflict');
  assert.match(refused.error.message, /版本号对不上/, '拒绝的原因要是一句人话，阅读端原样带给学生');
  assert.equal(refused.version, 甲.version, '冲突时顺手带回当前版本号 = 已经重读过了');
  assert.deepEqual(refused.annotations, 甲.annotations, '带回来的是甲写的那份：乙的没丢也没覆盖');
  assert.deepEqual(fs.readFileSync(file), bytes, '被拒绝的那次不写盘');

  // 阅读端按带回的版本号重来：这次成功
  const retried = await (await post(route, submission(workspace, {
    annotations: [annotation({ id: 'b-2', note: '乙写的' })],
    expectedVersion: refused.version,
    operationId: op('retry'),
  }))).json();
  assert.equal(retried.ok, true);
  assert.equal(retried.annotations['标']['b-2'].note, '乙写的');
});

test('同一个 operationId 换内容：409 operation-id-conflict，不写盘', async () => {
  const { home, workspace, annotationsDir } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();

  const operationId = op('same-op');
  const first = await (await post(route, submission(workspace, { operationId }))).json();
  const filesAfterFirst = countFiles(annotationsDir);

  const conflict = await post(route, submission(workspace, {
    operationId,
    annotations: [annotation({ note: '同一次提交但内容不同' })],
    expectedVersion: first.version,
  }));
  assert.equal(conflict.status, 409);
  const refused = await conflict.json();
  assert.equal(refused.error.code, 'operation-id-conflict');
  assert.equal(refused.version, first.version);
  assert.deepEqual(refused.annotations, first.annotations);
  assert.equal(countFiles(annotationsDir), filesAfterFirst);
});

/* ── 3. 请求体与状态码 ────────────────────────────────────────────────── */

test('坏请求：非 JSON、缺字段、越界科目/节点、没有课件 —— 一律 400 且不写盘', async () => {
  const { home, workspace, annotationsDir } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();

  const notJson = await post(route, null, { body: '这不是 JSON' });
  assert.equal(notJson.status, 400);
  assert.equal((await notJson.json()).error.code, 'body-invalid');

  const cases = [
    ['operation-id-invalid', { operationId: undefined }],
    ['annotations-invalid', { annotations: {} }],
    ['expected-version-required', { expectedVersion: undefined }],
    ['subject-invalid', { subject: '演示/科目' }],
    ['node-invalid', { node: '../net.layers' }],
    ['lesson-missing', { node: 'net.tcp' }],
  ];
  for (const [error, overrides] of cases) {
    const response = await post(route, submission(workspace, Object.assign({ operationId: op('bad') }, overrides)));
    assert.equal(response.status, 400, error);
    const body = await response.json();
    assert.equal(body.ok, false, error);
    assert.equal(body.error.code, error);
    assert.equal(typeof body.error.message, 'string');
    assert.notEqual(body.error.message, '', '拒绝必须带一句能给学生看的话');
  }
  assert.equal(countFiles(annotationsDir), 0, '坏请求一律不写盘');

  // 只收 POST：别的动词给 405（宿主按 methods 过滤，这里是第二道）
  const wrongMethod = await route.fetch(new Request('http://127.0.0.1' + ANNOTATIONS_PATH, { method: 'GET' }));
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

/* ── 4. 课件逐字不变 ──────────────────────────────────────────────────── */

test('整轮写入前后：课件正文逐字节相等（标注绝不写回 .md）', async () => {
  const { home, workspace, subjectDir, annotationsDir } = makeHome();
  process.env.DSH_HOME = home;
  const { route } = connect();

  const lesson = path.join(subjectDir, 'lessons', `0001-${NODE}.md`);
  const lessonBytes = fs.readFileSync(lesson);

  const first = await (await post(route, submission(workspace))).json();
  await post(route, submission(workspace, {
    annotations: [],
    expectedVersion: first.version,
    operationId: op('clear'),
  }));
  // 再来一次被拒的写入（冲突路径也不许碰课件）
  await post(route, submission(workspace, { expectedVersion: '0000000000000000', operationId: op('conflict') }));

  assert.deepEqual(fs.readFileSync(lesson), lessonBytes, '课件正文必须逐字不变（ADR-0015）');
  assert.deepEqual(fs.readdirSync(path.join(subjectDir, 'lessons')), [`0001-${NODE}.md`]);
  assert.deepEqual(fs.readdirSync(annotationsDir), [`0001-${NODE}.json`], '标注只落在 annotations/ 一个文件里');

  // 数据层读得到的与 payload 是同一份
  assert.deepEqual(readAnnotations({ workspace, subject: SUBJECT, node: NODE }).data['标'], {});
  assert.equal(readLibrary({ workspace }).subjects[0].nodes[0].annotations.present, true);
});
