/* 验收 #79 · 问答面板那条路由：真实回答链路 + 误解记录落盘（`lib/ask/**`）
   ────────────────────────────────────────────────────────────────────────
   真模型调用要花额度，**默认门禁里不跑**（ticket 的验收口径）。这里用**注入一个假 llm
   服务**证明链路是通的：`ctx.llm.stream()` 被真的调到、请求体被真的组装出来、回答被真的
   拼回来、误解记录被真的写进 `misconceptions.yaml`。

   假 llm 是一个**最小的 async generator**：形状照 `dsh-plugin-api.md` §9.2 的块流
   （`text-delta` + 终止的 `finish`），不是把 stream 换成「返回一个字符串」——那样就绕过了
   我们真正要验的那一段（拼流）。

   另一半在 `scripts/tests/test_core_ask_context.mjs`（请求体的形状，纯函数域）。
   数据现造现弃，不依赖 `examples/.learning/`。
   ──────────────────────────────────────────────────────────────────────── */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { ASK_PATH, askPanel, collectStream, registerAskRoute, resolveSelection, stripFrontMatter } from '../../lib/ask/index.ts';
import { misconceptionsVersion, readMisconceptions } from '../../lib/misconceptions.ts';
import { parseYaml } from '../../lib/yaml.ts';

/* ── 临时工作区：跑完即弃 ─────────────────────────────────────────────── */

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
});

const SUBJECT = 'demo';
const NODE = 'net.mask';
const LESSON_FILE = `0003-${NODE}.md`;
const LESSON_MD = [
  '---',
  'title: 子网与掩码',
  'goal: 会用按位与算网络地址',
  '---',
  '',
  '# 子网与掩码',
  '',
  '## 掩码是按位与',
  '',
  '192.168.1.100/26 的网络地址是 192.168.1.64。',
  '',
].join('\n');
const MEMORY_MD = '讲法偏好：先给结论再给为什么。\n';

function makeWorkspace({ withMemory = true, withLesson = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-ask-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  const subjectDir = path.join(workspace, '.learning', 'subjects', SUBJECT);
  fs.mkdirSync(path.join(subjectDir, 'lessons'), { recursive: true });
  fs.writeFileSync(path.join(subjectDir, 'subject.yaml'), `slug: ${SUBJECT}\nname: 网络\n`);
  fs.writeFileSync(path.join(subjectDir, 'curriculum.yaml'), `nodes:\n  - id: ${NODE}\n    title: 子网与掩码\n`);
  if (withLesson) fs.writeFileSync(path.join(subjectDir, 'lessons', LESSON_FILE), LESSON_MD);
  if (withMemory) fs.writeFileSync(path.join(workspace, '.learning', 'MEMORY.md'), MEMORY_MD);
  return { root, workspace, subjectDir };
}

/** 唯一的 operationId：模块级台账只在内存里，测试之间不能撞 id。 */
let seq = 0;
function op(name) {
  seq += 1;
  return `${name}-${process.pid}-${seq}`;
}

/* ── 假 llm：块流形状照 §9.2，另记下每一次调用 ─────────────────────────── */

function fakeLlm(answer = '【回答】\n掩码按位与：100 与 192 得 64，所以网络地址是 192.168.1.64。\n【摘要】\n掩码按位与算出网络地址') {
  const calls = [];
  return {
    calls,
    listProviders: () => [{ id: 'fake-provider', name: '假 provider' }],
    async listModels() { return [{ provider: 'fake-provider', id: 'fake-model', name: '假模型' }]; },
    stream(options) {
      calls.push(options);
      return (async function* chunks() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        for (const piece of String(answer).split('\n')) yield { type: 'text-delta', index: 0, text: piece + '\n' };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

/** 一个「没有模型服务」的组合：`ctx.get('llm')` 给 undefined。 */
const noLlm = { listProviders: undefined };

const DEFAULT_SELECTION = { provider: 'fake-provider', model: 'fake-model' };

/* ══ 链路：假 llm 真的被调到，回答真的被拼回来 ═══════════════════════════ */

test('#79 链路：面板独立调模型，回答拼回来，误解记录落盘且字段齐全', async () => {
  const { workspace, subjectDir } = makeWorkspace();
  const llm = fakeLlm();

  const view = await askPanel(
    { workspace, llm, defaultSelection: DEFAULT_SELECTION, now: new Date(2026, 9, 5) },
    { subject: SUBJECT, node: NODE, selection: '192.168.1.100/26 的网络地址是 192.168.1.64。', question: '/26 的掩码是 255.255.255.192，为什么网络地址是 192.168.1.64，不是 192.168.1.0？', operationId: op('first') },
  );

  assert.equal(view.available, true);
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.deepEqual(view.model, { provider: 'fake-provider', model: 'fake-model' });
  assert.ok(view.answer.includes('掩码按位与：100 与 192 得 64'), '回答没拼回来：' + view.answer);

  // 假 llm 收到的就是组装出来的那一份：三样上下文各一段，没有会话身份
  assert.equal(llm.calls.length, 1);
  const sent = llm.calls[0];
  assert.deepEqual(Object.keys(sent).sort(), ['maxTokens', 'messages', 'model', 'provider', 'system', 'temperature']);
  const sentText = sent.messages[0].content[0].text;
  assert.ok(sentText.includes('【共享记忆】') && sentText.includes(MEMORY_MD.trim()), '共享记忆没进请求体');
  assert.ok(sentText.includes('【当前课件】') && sentText.includes('掩码是按位与'), '当前课件没进请求体');
  assert.ok(sentText.includes('【选中文本】') && sentText.includes('192.168.1.100/26'), '选中文本没进请求体');
  assert.ok(sentText.includes('【我的问题】'), '提问原文没进请求体');
  assert.equal(sentText.includes('---\ntitle:'), false, '课件 front matter 也发给了模型');
  assert.equal(sent.messages.length, 1);
  assert.equal(Object.hasOwn(sent, 'sessionId'), false);

  // 落盘：五字段齐全、source 是「问答面板」
  assert.deepEqual(view.misconception, {
    topic: '/26 的掩码是 255.255.255.192，为什么网络地址是 192.16',
    source: '问答面板',
    evidence: [
      '提问原文：/26 的掩码是 255.255.255.192，为什么网络地址是 192.168.1.64，不是 192.168.1.0？',
      '回答摘要：掩码按位与算出网络地址',
      `位置：${SUBJECT}/${LESSON_FILE}`,
    ].join('\n'),
    status: '未处理',
    at: '2026-10-05',
  });
  assert.equal(view.write.ok, true);

  const file = path.join(subjectDir, 'misconceptions.yaml');
  const raw = fs.readFileSync(file, 'utf8');
  // 真的是一份能被 YAML 读回来的列表（不是我们自说自话的字符串）
  const parsed = parseYaml(raw, { file });
  assert.equal(Array.isArray(parsed), true);
  assert.deepEqual(parsed, [{
    topic: '/26 的掩码是 255.255.255.192，为什么网络地址是 192.16',
    source: '问答面板',
    evidence: view.misconception.evidence,
    status: '未处理',
    at: '2026-10-05',
  }]);
  assert.deepEqual(readMisconceptions({ workspace, subject: SUBJECT }), parsed);
  assert.equal(view.write.version, misconceptionsVersion({ workspace, subject: SUBJECT }));
});

test('#79 落盘：追加不覆盖——文件头注释与旧记录原样留着', () => {
  const { workspace, subjectDir } = makeWorkspace();
  const file = path.join(subjectDir, 'misconceptions.yaml');
  const head = '# 误解库：只追加。\n- date: "2026-09-24"\n  node: net.ip\n  topic: 旧的一条\n  question: 旧问题\n';
  fs.writeFileSync(file, head);

  const view = askPanel(
    { workspace, llm: fakeLlm(), defaultSelection: DEFAULT_SELECTION, now: new Date(2026, 9, 5) },
    { subject: SUBJECT, node: NODE, question: '掩码怎么算？', operationId: op('append') },
  );

  // askPanel 是 async：这里等它落地
  return view.then((result) => {
    assert.equal(result.ok, true, JSON.stringify(result));
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.startsWith(head), '旧内容被改写了：\n' + raw);
    assert.ok(raw.includes('- topic: 掩码怎么算'), '新记录没接上去');
    // 旧记录（旧字段写法）仍读得进，且被归一到新字段
    const items = readMisconceptions({ workspace, subject: SUBJECT });
    assert.equal(items.length, 2);
    assert.equal(items[0].topic, '旧的一条');
    assert.equal(items[0].evidence, '旧问题');
    assert.equal(items[0].at, '2026-09-24');
  });
});

test('#79 幂等：同一个 operationId 重放只回放原回执，不写第二条', async () => {
  const { workspace, subjectDir } = makeWorkspace();
  const id = op('replay');
  const deps = { workspace, llm: fakeLlm(), defaultSelection: DEFAULT_SELECTION, now: new Date(2026, 9, 5) };
  const input = { subject: SUBJECT, node: NODE, question: '掩码怎么算？', operationId: id };

  const first = await askPanel(deps, input);
  const bytes = fs.readFileSync(path.join(subjectDir, 'misconceptions.yaml'), 'utf8');
  const second = await askPanel(deps, input);

  assert.equal(first.write.replayed, false);
  assert.equal(second.write.replayed, true, '重放没有被台账接住');
  assert.equal(second.write.version, first.write.version);
  assert.equal(fs.readFileSync(path.join(subjectDir, 'misconceptions.yaml'), 'utf8'), bytes, '重放写了第二遍');
  assert.equal(readMisconceptions({ workspace, subject: SUBJECT }).length, 1);
});

test('#79 幂等：同一个 operationId 换了内容 → 拒绝，不写盘', async () => {
  const { workspace, subjectDir } = makeWorkspace();
  const id = op('conflict');
  const deps = { workspace, llm: fakeLlm(), defaultSelection: DEFAULT_SELECTION, now: new Date(2026, 9, 5) };
  await askPanel(deps, { subject: SUBJECT, node: NODE, question: '第一问', operationId: id });
  const bytes = fs.readFileSync(path.join(subjectDir, 'misconceptions.yaml'), 'utf8');

  const second = await askPanel(deps, { subject: SUBJECT, node: NODE, question: '换了一问', operationId: id });
  // 回答照给（模型那边确实调了），但写盘被拒
  assert.equal(second.ok, true);
  assert.equal(second.write.ok, false);
  assert.equal(second.write.error, 'operation-id-conflict');
  assert.equal(fs.readFileSync(path.join(subjectDir, 'misconceptions.yaml'), 'utf8'), bytes);
});

test('#79 版本栅栏：expectedVersion 对不上就拒绝写入，回答不受影响', async () => {
  const { workspace, subjectDir } = makeWorkspace();
  const file = path.join(subjectDir, 'misconceptions.yaml');
  fs.writeFileSync(file, '- topic: 旧的一条\n  source: 讲解反馈\n  evidence: 旧问题\n  status: 未处理\n  at: "2026-09-24"\n');
  const bytes = fs.readFileSync(file, 'utf8');

  const view = await askPanel(
    { workspace, llm: fakeLlm(), defaultSelection: DEFAULT_SELECTION, now: new Date(2026, 9, 5) },
    { subject: SUBJECT, node: NODE, question: '掩码怎么算？', operationId: op('stale'), expectedVersion: '不存在的版本号' },
  );

  assert.equal(view.ok, true, '版本冲突不该把回答一起吞掉');
  assert.equal(view.write.ok, false);
  assert.equal(view.write.error, 'version-conflict');
  assert.equal(view.write.version, misconceptionsVersion({ workspace, subject: SUBJECT }));
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, '版本对不上却写了盘');
});

/* ══ 没有可用模型：如实说明，不假装会答 ═════════════════════════════════ */

test('#79 无模型：ctx.llm 不在 → available:false + reason，一个字的回答都不编', async () => {
  const { workspace, subjectDir } = makeWorkspace();
  const view = await askPanel(
    { workspace, llm: undefined, defaultSelection: null, now: new Date(2026, 9, 5) },
    { subject: SUBJECT, node: NODE, question: '掩码怎么算？', operationId: op('nomodel') },
  );

  assert.equal(view.available, false);
  assert.equal(view.ok, false);
  assert.equal(typeof view.reason, 'string');
  assert.ok(view.reason.length > 0);
  assert.equal(Object.hasOwn(view, 'answer'), false, '没有模型却给出了回答');
  assert.equal(Object.hasOwn(view, 'misconception'), false, '没有回答却写了误解记录');
  assert.equal(fs.existsSync(path.join(subjectDir, 'misconceptions.yaml')), false);
});

test('#79 无模型：一个 provider 都没注册 → available:false + reason', async () => {
  const { workspace } = makeWorkspace();
  const view = await askPanel(
    { workspace, llm: { listProviders: () => [] }, defaultSelection: null },
    { subject: SUBJECT, node: NODE, question: '掩码怎么算？', operationId: op('noprovider') },
  );
  assert.equal(view.available, false);
  assert.match(view.reason, /provider/);
});

test('#79 无模型：provider 在但选不出模型 → available:false，并给出可照做的下一步', async () => {
  const { workspace } = makeWorkspace();
  const llm = { listProviders: () => [{ id: 'fake-provider', name: '假 provider' }], listModels: async () => [] };
  const view = await askPanel(
    { workspace, llm, defaultSelection: null },
    { subject: SUBJECT, node: NODE, question: '掩码怎么算？', operationId: op('nomodelid') },
  );
  assert.equal(view.available, false);
  assert.match(view.reason, /默认模型/);
});

test('#79 有模型但调用失败：available:true + ok:false，不写成 available:false', async () => {
  const { workspace, subjectDir } = makeWorkspace();
  const llm = { ...fakeLlm(), stream: () => { throw new Error('provider 402 余额不足'); } };
  const view = await askPanel(
    { workspace, llm, defaultSelection: DEFAULT_SELECTION, now: new Date(2026, 9, 5) },
    { subject: SUBJECT, node: NODE, question: '掩码怎么算？', operationId: op('boom') },
  );
  assert.equal(view.available, true);
  assert.equal(view.ok, false);
  assert.equal(view.error.code, 'model-error');
  assert.match(view.error.message, /余额不足/);
  assert.equal(fs.existsSync(path.join(subjectDir, 'misconceptions.yaml')), false, '没答成却写了误解记录');
});

test('#79 模型回了空话：ok:false，且不写一条没有摘要的误解记录', async () => {
  const { workspace, subjectDir } = makeWorkspace();
  const view = await askPanel(
    { workspace, llm: fakeLlm('   '), defaultSelection: DEFAULT_SELECTION, now: new Date(2026, 9, 5) },
    { subject: SUBJECT, node: NODE, question: '掩码怎么算？', operationId: op('empty') },
  );
  assert.equal(view.available, true);
  assert.equal(view.ok, false);
  assert.equal(view.error.code, 'model-empty');
  assert.equal(fs.existsSync(path.join(subjectDir, 'misconceptions.yaml')), false);
});

test('#79 读不到这一课：报 lesson-not-found，不拿别的课件凑', async () => {
  const { workspace } = makeWorkspace({ withLesson: false });
  const llm = fakeLlm();
  const view = await askPanel(
    { workspace, llm, defaultSelection: DEFAULT_SELECTION },
    { subject: SUBJECT, node: NODE, question: '掩码怎么算？', operationId: op('nolesson') },
  );
  assert.equal(view.ok, false);
  assert.equal(view.error.code, 'lesson-not-found');
  assert.equal(llm.calls.length, 0, '课件都没读到就调了模型');
});

test('#79 共享记忆为空：照样答得出来，请求体里就没有那一段', async () => {
  const { workspace } = makeWorkspace({ withMemory: false });
  const llm = fakeLlm();
  const view = await askPanel(
    { workspace, llm, defaultSelection: DEFAULT_SELECTION, now: new Date(2026, 9, 5) },
    { subject: SUBJECT, node: NODE, question: '掩码怎么算？', operationId: op('nomemory') },
  );
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.equal(llm.calls[0].messages[0].content[0].text.includes('【共享记忆】'), false);
});

/* ══ 拼流与选模型这两个零件 ═════════════════════════════════════════════ */

test('#79 拼流：只取 text-delta，其余块原样忽略', async () => {
  const text = await collectStream((async function* chunks() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'reasoning-delta', index: 0, text: '（这是思考，不该进回答）' };
    yield { type: 'text-delta', index: 0, text: '第一段' };
    yield { type: 'text-delta', index: 0, text: '第二段' };
    yield { type: 'finish', reason: 'stop' };
  })());
  assert.equal(text, '第一段第二段');
});

test('#79 选模型：请求体覆盖 > 宿主默认 > provider 宣告的第一个', async () => {
  const llm = { listProviders: () => [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], listModels: async (id) => [{ provider: id, id: id + '-model', name: id }] };
  assert.deepEqual(await resolveSelection(llm, { provider: 'p2', model: 'm9' }), { provider: 'p2', model: 'm9' });
  assert.deepEqual(await resolveSelection(llm, { provider: 'p1', model: 'm1' }), { provider: 'p1', model: 'm1' });
  assert.deepEqual(await resolveSelection(llm, null), { provider: 'p1', model: 'p1-model' });
});

test('#79 front matter：只切开头那一段，正文一字不动', () => {
  assert.equal(stripFrontMatter(LESSON_MD), '\n# 子网与掩码\n\n## 掩码是按位与\n\n192.168.1.100/26 的网络地址是 192.168.1.64。\n');
  assert.equal(stripFrontMatter('# 没有 front matter\n'), '# 没有 front matter\n');
  // 首行是 --- 但没有收尾：原样发出去，不把整份课件吃掉
  assert.equal(stripFrontMatter('---\ntitle: x\n正文\n'), '---\ntitle: x\n正文\n');
});

/* ══ 路由注册：真宿主那条路（connection.fetch.register） ═════════════════ */

const DSH_HOME = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-ask-home-'));
TEMPS.push(DSH_HOME);
let routeWorkspace = '';

before(() => {
  const made = makeWorkspace();
  routeWorkspace = made.workspace;
  fs.writeFileSync(path.join(DSH_HOME, 'studymate-config.yaml'), `workspace: "${routeWorkspace}"\n`);
  process.env.DSH_HOME = DSH_HOME;
});

/** 一个假 ctx：`inject(['connection'])` 立刻回调，`effect` 立刻执行（与宿主同一时机）。 */
function fakeCtx({ llm, selection }) {
  const routes = [];
  const child = {
    connection: { fetch: { register: (route) => { routes.push(route); return route; } } },
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
    get: (name) => (name === 'llm' ? llm : name === 'agentDefaultModel' ? selection : undefined),
  };
  const ctx = { inject: (names, handler) => { assert.deepEqual(names, ['connection']); handler(child); } };
  return { ctx, routes };
}

test('#79 路由：POST /api/studymate/ask 注册在 /api/studymate 命名空间下，形状与另外三条一致', async () => {
  const llm = fakeLlm();
  const { ctx, routes } = fakeCtx({ llm, selection: { currentSelection: () => DEFAULT_SELECTION } });
  registerAskRoute(ctx);

  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, ASK_PATH);
  assert.deepEqual(routes[0].methods, ['POST']);
  assert.equal(routes[0].requestBody, 'buffered');

  const response = await routes[0].fetch(new Request('http://localhost' + ASK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: SUBJECT, node: NODE, selection: '这一段', question: '掩码怎么算？', operationId: op('route') }),
  }));
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.equal(view.misconception.source, '问答面板');
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].messages.length, 1);
  assert.equal(Object.hasOwn(llm.calls[0], 'sessionId'), false);
});

test('#79 路由：请求体不是 JSON 对象 → 400；没模型 → 503（面板按状态码区分）', async () => {
  const { ctx, routes } = fakeCtx({ llm: fakeLlm(), selection: { currentSelection: () => DEFAULT_SELECTION } });
  registerAskRoute(ctx);

  const bad = await routes[0].fetch(new Request('http://localhost' + ASK_PATH, { method: 'POST', body: 'not json' }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'body-invalid');

  const missing = await routes[0].fetch(new Request('http://localhost' + ASK_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: SUBJECT, node: NODE }),
  }));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'question-required');

  const { ctx: noModelCtx, routes: noModelRoutes } = fakeCtx({ llm: undefined, selection: null });
  registerAskRoute(noModelCtx);
  const unavailable = await noModelRoutes[0].fetch(new Request('http://localhost' + ASK_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: SUBJECT, node: NODE, question: '掩码怎么算？', operationId: op('route-nomodel') }),
  }));
  assert.equal(unavailable.status, 503);
  const view = await unavailable.json();
  assert.equal(view.available, false);
  assert.equal(view.ok, false);
  assert.equal(typeof view.reason, 'string');
});
