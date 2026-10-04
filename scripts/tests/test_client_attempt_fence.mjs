/* 验收 #72 · 阅读端作答落盘的**陈旧响应围栏**（Client 半）
   ────────────────────────────────────────────────────────────────────────
   测试对象是 `lib/client.js` 工厂闭包里的纯逻辑与写队列：它们跑在浏览器里，但一条也不碰 DOM、
   网络与时钟——`createAttemptWriter` 的 `send` 是注入的，套件自己决定每一笔什么时候回来、
   带什么回来。所以「旧响应不许覆盖新作答」这条能在这里被**真的撞一次**，而不是读代码猜。

   验收标准逐条对到用例分组：
     1. 写进去的作答读得回来（题 id ↔ stateKey 互逆）—— describe「形状」
     2. 旧读数 / 在飞的写入不许覆盖新作答          —— describe「栅栏」
     3. 写队列串行、版本号一笔接一笔              —— describe「写队列」
     4. 冲突时拒绝并重读、重来一次、如实告诉学生    —— describe「冲突」
     5. 主观题自评也走同一条路（选 null + 自评档）  —— describe「自评」
     6. 页面里不再有「只在内存里作答」的说法        —— describe「界面文案」

   「刷新页面仍在」那一条的**跨请求**证据在 Host 半：`test_host_attempts_route.mjs` 里
   「POST 落盘 → 另起一次 readLibrary」那一条。这里只验前端这一侧把作答交给了谁、怎么交。
   ───────────────────────────────────────────────────────────────────────── */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { clientInternals, viewText, CLIENT_PATH } from './fixtures/client_harness.mjs';

const I = clientInternals();
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8');

/** 一次 settle 之后（微任务队列排空）再断言：写队列全靠 promise 推进。 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 假发送端：每一笔都攥在手里，由套件决定什么时候回、回什么。 */
function makeSend() {
  const calls = [];
  const waiting = [];
  const send = (payload) => new Promise((resolve) => {
    calls.push(payload);
    waiting.push(resolve);
  });
  return {
    calls,
    send,
    reply(index, status, body) {
      const resolve = waiting[index];
      if (!resolve) throw new Error(`第 ${index} 笔还没发出去`);
      resolve({ status, body });
    },
    /** 与真实 sendAttempt 同形：网络断了也不抛，只给 status 0 + 一句话。 */
    fail(index, message) {
      waiting[index]({ status: 0, body: { error: 'network', message } });
    },
  };
}

/** 一份写回执（`attempts` 就是 attempts/ 文件的内容）。 */
function receipt(version, node, questions) {
  return { ok: true, version, attempts: { 节点: node, 课件: '0001-' + node + '.md', 最后写入: '2026-09-24T13:05:00.000Z', 题: questions } };
}

/** 一条「上次结果」，与 attempts.schema.json 的字段一致。 */
function last(chosen, correct, extra = {}) {
  return Object.assign({ 时: '2026-09-24T13:05:00.000Z', 选: chosen, 对: correct }, extra);
}

/** 本地那条作答（与 record 的乐观更新同形）。 */
function local(overrides = {}) {
  return Object.assign({ at: '刚刚', chosen: 0, correct: true, seq: 1, pending: 1 }, overrides);
}

const NODE = 'net.layers';
const KEY0 = NODE + '|每层各管一段|0';
const KEY1 = NODE + '|每层各管一段|1';
const OTHER = 'net.link|链路与帧|0';

/* ── 形状：写进去的作答读得回来 ───────────────────────────────────────── */

test('题 id 与 stateKey 互为逆运算：写进去的作答才读得回来', () => {
  assert.equal(I.attemptQuestionId(KEY0), '每层各管一段#0');
  assert.equal(I.attemptStateKey(NODE, '每层各管一段#0'), KEY0);
  // 锚点或题面里有 # 与 | 也不怕：两边都是「切最后一个 # / 切第一个 |」，拼回去仍然相等
  const trickyId = '花 $5 和 #10 的区别#2';
  const trickyKey = I.attemptStateKey(NODE, trickyId);
  assert.equal(I.attemptQuestionId(trickyKey), trickyId);
  assert.equal(I.attemptQuestionId('a|b|c|7'), 'b|c#7');
});

test('payload 的 node.attempts 与写回执都落成同一形状的本地作答（seq 0 = 不是这次会话答的）', () => {
  const node = { id: NODE, attempts: { present: true, version: 'v1', questions: { '每层各管一段#0': { id: '每层各管一段#0', 上次结果: last(2, false, { 错因: '记错了' }) } } } };
  const fromPayload = I.attemptsFromPayload(node);
  assert.deepEqual([...fromPayload.keys()], [KEY0]);
  assert.deepEqual(fromPayload.get(KEY0), {
    at: '2026-09-24T13:05:00.000Z', chosen: 2, correct: false, self: undefined, reason: '记错了', seq: 0, pending: 0,
  });
  const fromReceipt = I.attemptsFromReceipt(NODE, { 题: { '每层各管一段#1': { 上次结果: last(null, true, { 自评: '答了一半' }) } } });
  assert.equal(fromReceipt.get(KEY1).self, '答了一半');
  assert.equal(fromReceipt.get(KEY1).seq, 0);
});

/* ── 栅栏：旧的不许盖新的 ─────────────────────────────────────────────── */

test('旧读数盖不掉新作答：本地那条比这次读数新（seq 更大），一律留下', () => {
  const before = new Map([[KEY0, local({ chosen: 3, correct: false, seq: 4, pending: 0 })]]);
  // 这份读数是在动作 2 之后开始读的：它不可能知道动作 4 那次作答
  const incoming = new Map([[KEY0, I.attemptFromDisk(last(0, true))]]);
  const after = I.mergeNodeAttempts(before, NODE, incoming, 2);
  assert.equal(after.get(KEY0).chosen, 3, '旧响应不许覆盖新作答');
  assert.equal(after.get(KEY0).seq, 4);
});

test('没落的写入（pending）不许被任何读数覆盖，哪怕读数看起来更新', () => {
  const before = new Map([[KEY0, local({ chosen: 1, correct: false, seq: 1, pending: 1 })]]);
  const incoming = new Map([[KEY0, I.attemptFromDisk(last(0, true))]]);
  const after = I.mergeNodeAttempts(before, NODE, incoming, 9);
  assert.equal(after.get(KEY0).chosen, 1, '这一笔还没落盘，盘上那份含不含它还两说');
  assert.equal(after.get(KEY0).pending, 1);
});

test('不是新的、也没有在飞：以盘上为准（文件是真相），提示与 seq 留着', () => {
  const before = new Map([[KEY0, local({ chosen: 1, correct: false, seq: 2, pending: 0, note: { bad: true, text: '别处刚改过' } })]]);
  const incoming = new Map([[KEY0, I.attemptFromDisk(last(0, true))]]);
  const after = I.mergeNodeAttempts(before, NODE, incoming, 2);
  assert.equal(after.get(KEY0).chosen, 0, '盘上那份说了算');
  assert.equal(after.get(KEY0).seq, 2, 'seq 不倒退：它记的是「这条被谁动过」');
  assert.deepEqual(after.get(KEY0).note, { bad: true, text: '别处刚改过' }, '提示要穿得过一次合并');
});

test('盘上确实没有的：新的与在飞的留着，其余按盘上的算（别人重写了就是真没了）', () => {
  const before = new Map([
    [KEY0, local({ seq: 5, pending: 0 })],      // 比读数新 → 留
    [KEY1, local({ seq: 1, pending: 1 })],      // 在飞 → 留
    [OTHER, local({ seq: 1, pending: 0 })],     // 别的节点 → 这次读数管不着
  ]);
  const vacant = NODE + '|另一段锚点|0';
  before.set(vacant, local({ seq: 0, pending: 0 }));   // 旧且没在飞 → 丢
  const after = I.mergeNodeAttempts(before, NODE, new Map(), 4);
  assert.deepEqual([...after.keys()].sort(), [KEY0, KEY1, OTHER].sort());
  assert.equal(after.has(vacant), false);
});

test('只动这个节点的键：换节点回来不会把上一个节点的本地作答洗掉', () => {
  const before = new Map([[OTHER, local({ chosen: 2, seq: 3, pending: 0 })]]);
  const after = I.mergeNodeAttempts(before, NODE, new Map([[KEY0, I.attemptFromDisk(last(1, false))]]), 0);
  assert.deepEqual(after.get(OTHER), before.get(OTHER));
  assert.equal(after.get(KEY0).chosen, 1);
});

/* ── 写队列：串行 + 版本号接力 ────────────────────────────────────────── */

test('写队列串行：同一时刻只有一笔在飞，第二笔带的是第一笔回执里的版本号', async () => {
  const send = makeSend();
  const applied = [];
  const writer = I.createAttemptWriter({
    send: send.send,
    onApplied: (job, body, note) => applied.push({ job, body, note }),
    onRefused: () => { throw new Error('不该被拒'); },
  });
  writer.push(I.attemptJob({ subject: 'demo', node: NODE, stateKey: KEY0, patch: { chosen: 0, correct: true }, seq: 1, expectedVersion: 'v0' }));
  writer.push(I.attemptJob({ subject: 'demo', node: NODE, stateKey: KEY1, patch: { chosen: null, correct: true, self: '答对了' }, seq: 2, expectedVersion: 'v0' }));
  assert.equal(send.calls.length, 1, '第二笔要排队，不能同时发——并发发出去的必然带过期版本号');
  assert.equal(send.calls[0].expectedVersion, 'v0');
  assert.equal(send.calls[0].questions['每层各管一段#0']['选'], 0);
  assert.equal(writer.pending('demo/' + NODE), 2);

  send.reply(0, 200, receipt('v1', NODE, { '每层各管一段#0': { 上次结果: last(0, true) } }));
  await tick();
  assert.equal(send.calls.length, 2, '第一笔回来才发第二笔');
  assert.equal(send.calls[1].expectedVersion, 'v1', '第二笔的栅栏 = 第一笔回执里的版本号');
  assert.notEqual(send.calls[1].operationId, send.calls[0].operationId, '每一次点击一个幂等键');

  send.reply(1, 200, receipt('v2', NODE, { '每层各管一段#1': { 上次结果: last(null, true, { 自评: '答对了' }) } }));
  await tick();
  assert.equal(applied.length, 2);
  assert.equal(writer.pending('demo/' + NODE), 0);
  assert.equal(applied[1].body.version, 'v2');
});

test('旧回执不许覆盖新作答：第一笔回来时，第二笔（更晚的动作）仍然在界面上', async () => {
  const send = makeSend();
  // 与 StudyMateApp 的接线同形：settle（pending-1）+ 栅栏合并（allowSeq = 这一笔自己的 seq）
  let state = new Map();
  const writer = I.createAttemptWriter({
    send: send.send,
    onApplied: (job, body, note) => {
      const incoming = I.attemptsFromReceipt(job.node, body.attempts);
      state = I.mergeNodeAttempts(I.settleAttempt(state, job, note), job.node, incoming, job.seq);
    },
    onRefused: (job, body) => { state = I.settleAttempt(state, job, I.refusalNote(body, false)); },
  });
  const answer = (key, patch, seq) => {
    state.set(key, Object.assign({ at: '刚刚', chosen: null, correct: false, seq, pending: 1 }, patch));
    writer.push(I.attemptJob({ subject: 'demo', node: NODE, stateKey: key, patch, seq, expectedVersion: 'v0' }));
  };

  answer(KEY0, { chosen: 0, correct: true }, 1);
  answer(KEY1, { chosen: 1, correct: false }, 2);   // 第一笔还在飞的时候学生又答了一题

  // 第一笔的回执里**没有**第二题（盘上确实还没有它）
  send.reply(0, 200, receipt('v1', NODE, { '每层各管一段#0': { 上次结果: last(0, true) } }));
  await tick();
  assert.equal(state.get(KEY0).pending, 0, '第一笔落定了');
  assert.equal(state.get(KEY1).chosen, 1, '第二笔（更新）没被第一笔的回执盖掉');
  assert.equal(state.get(KEY1).pending, 1, '它还在飞');

  send.reply(1, 200, receipt('v2', NODE, {
    '每层各管一段#0': { 上次结果: last(0, true) },
    '每层各管一段#1': { 上次结果: last(1, false) },
  }));
  await tick();
  assert.equal(state.get(KEY1).pending, 0);
  assert.equal(state.get(KEY1).chosen, 1, '两笔都在，最后一次作答是学生最后点的那个');
});

/* ── 冲突：拒绝 + 重读 + 重来一次 + 如实说 ────────────────────────────── */

test('版本冲突：Host 拒了这次写入，回执里的当前内容就是重读结果，按新版本重来一次', async () => {
  const send = makeSend();
  const refusals = [];
  const applied = [];
  const writer = I.createAttemptWriter({
    send: send.send,
    onApplied: (job, body, note) => applied.push({ job, body, note }),
    onRefused: (job, body, retrying) => refusals.push({ job, body, retrying }),
  });
  const job = I.attemptJob({ subject: 'demo', node: NODE, stateKey: KEY0, patch: { chosen: 3, correct: false }, seq: 7, expectedVersion: 'v0' });
  writer.push(job);
  send.reply(0, 409, {
    ok: false, status: 409, error: 'version-conflict',
    message: '作答数据已经变了：版本号对不上，这次不写（请按当前内容重来）',
    version: 'v9', attempts: { 节点: NODE, 课件: '0001-' + NODE + '.md', 最后写入: '2026-09-24T13:05:00.000Z', 题: { '每层各管一段#0': { 上次结果: last(0, true, { 错因: '别处刚写的' }) } } },
  });
  await tick();
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].retrying, true, '还会自动重来一次：界面这侧先不说「没写进去」');
  assert.equal(send.calls.length, 2, '被拒之后重来一次');
  assert.equal(send.calls[1].expectedVersion, 'v9', '重来用的是**冲突回执里带回的**版本号（那就是重读）');
  assert.equal(send.calls[1].operationId, job.operationId, '重试沿用同一个幂等键：真写成了也只落一条');
  assert.deepEqual(send.calls[1].questions, send.calls[0].questions, '重试的内容一字不改');

  send.reply(1, 200, receipt('v10', NODE, { '每层各管一段#0': { 上次结果: last(3, false) } }));
  await tick();
  assert.equal(applied.length, 1);
  assert.equal(applied[0].note.bad, false, '成功那一路带着「刚才撞过版本」的提示回去：不能让学生什么都没看见');
  assert.match(applied[0].note.text, /已按最新版本重记了一次/);
  assert.equal(writer.pending('demo/' + NODE), 0);
});

test('第二次还撞：不再自动重来，如实说「这次没写进去」，队列继续跑下一笔', async () => {
  const send = makeSend();
  const refused = [];
  const applied = [];
  const writer = I.createAttemptWriter({
    send: send.send,
    onApplied: (job, body, note) => applied.push({ job, note }),
    onRefused: (job, body, retrying) => refused.push(retrying ? 'retrying' : I.refusalNote(body, false)),
  });
  writer.push(I.attemptJob({ subject: 'demo', node: NODE, stateKey: KEY0, patch: { chosen: 1, correct: false }, seq: 1, expectedVersion: 'v0' }));
  writer.push(I.attemptJob({ subject: 'demo', node: NODE, stateKey: KEY1, patch: { chosen: 2, correct: false }, seq: 2, expectedVersion: 'v0' }));

  const conflict = { ok: false, status: 409, error: 'version-conflict', message: '作答数据已经变了：版本号对不上，这次不写（请按当前内容重来）', version: 'v9' };
  send.reply(0, 409, conflict);
  await tick();
  send.reply(1, 409, conflict);
  await tick();
  assert.deepEqual(refused.slice(0, 2), ['retrying', { bad: true, text: '别处刚改过这份作答数据，这次没写进去（已重读最新内容）。再点一次即可。' }]);
  assert.equal(send.calls.length, 3, '只重来一次，不无限循环');
  assert.equal(send.calls[2].questions['每层各管一段#1']['选'], 2, '队列没卡死：下一笔照常发');

  send.reply(2, 200, receipt('v10', NODE, { '每层各管一段#1': { 上次结果: last(2, false) } }));
  await tick();
  assert.equal(applied.length, 1);
  assert.equal(applied[0].note, null, '这一笔没撞过版本：不留提示');
  assert.equal(writer.pending('demo/' + NODE), 0);
});

test('网络断了也是一句给学生的话：不抛、pending 归零、队列继续', async () => {
  const send = makeSend();
  const notes = [];
  const writer = I.createAttemptWriter({
    send: send.send,
    onApplied: () => { throw new Error('不该写成'); },
    onRefused: (job, body, retrying) => notes.push(I.refusalNote(body, retrying)),
  });
  writer.push(I.attemptJob({ subject: 'demo', node: NODE, stateKey: KEY0, patch: { chosen: 0, correct: true }, seq: 1, expectedVersion: 'v0' }));
  send.fail(0, 'Failed to fetch');
  await tick();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].bad, true);
  assert.match(notes[0].text, /Failed to fetch/);
  assert.equal(writer.pending('demo/' + NODE), 0, 'pending 必须归零，否则这条作答再也不接受任何读数');
});

test('采纳版本号：走过的不回头——过期 payload 不许把栅栏拨回去', async () => {
  const send = makeSend();
  const writer = I.createAttemptWriter({ send: send.send, onApplied: () => {}, onRefused: () => {} });
  const line = 'demo/' + NODE;
  const answer = (key, seq, expectedVersion) => writer.push(
    I.attemptJob({ subject: 'demo', node: NODE, stateKey: key, patch: { chosen: 0, correct: true }, seq, expectedVersion }),
  );

  answer(KEY0, 5, 'v0');
  writer.acceptVersion(line, 'v-stale');   // 有在飞的写入：payload 的版本号先别插队
  assert.equal(send.calls[0].expectedVersion, 'v0');

  send.reply(0, 200, receipt('v1', NODE, { '每层各管一段#0': { 上次结果: last(0, true) } }));
  await tick();

  // 页面加载时那份 payload（v0）现在才被合并进来：它比队列手里的 v1 旧，不许采纳
  writer.acceptVersion(line, 'v0');
  answer(KEY0, 6, 'x');
  assert.equal(send.calls[1].expectedVersion, 'v1', '过期读数不许把版本号拨回去（否则下一次作答必然白撞一次 409）');

  // 真·新版本（别处改过、重读到了）照样采纳
  send.reply(1, 200, receipt('v2', NODE, { '每层各管一段#0': { 上次结果: last(0, true) } }));
  await tick();
  writer.acceptVersion(line, 'v2');
  answer(KEY0, 7, 'x');
  assert.equal(send.calls[2].expectedVersion, 'v2');
});

/* ── 自评：主观题走同一条路 ───────────────────────────────────────────── */

test('主观题自评：选是 null、对取自评第一档、自评原样带走', () => {
  const job = I.attemptJob({ subject: 'demo', node: NODE, stateKey: KEY1, patch: { chosen: null, correct: true, self: '答了一半' }, seq: 3, expectedVersion: 'v0' });
  assert.deepEqual(job.patch, { 选: null, 对: true, 自评: '答了一半', 错因: undefined });
  assert.equal(job.questionId, '每层各管一段#1');
  const wrong = I.attemptJob({ subject: 'demo', node: NODE, stateKey: KEY1, patch: { chosen: null, correct: false, self: '没答上' }, seq: 4, expectedVersion: 'v0' });
  assert.equal(wrong.patch['对'], false);
  // 错因是可选的：界面上没有输入框就先不带，字段口径见 schemas/attempts.schema.json
  assert.equal(Object.hasOwn(job, 'patch') && job.patch['错因'], undefined);
});

/* ── 界面文案：不再说「只在内存里」 ───────────────────────────────────── */

test('页面里不再有「只在内存里作答」的说法，落盘状态是三种如实说法', () => {
  // 源码级断言：这几句话一个字都不许留在客户端里（旧文案见 #72 的验收项）
  for (const said of ['只在页面内存里', '只存在内存里', '刷新即丢', '这里不假装已经做了', '已记进本次会话']) {
    assert.equal(SOURCE.includes(said), false, `client.js 里不该再有「${said}」`);
  }
  // 写回路径就在同一个文件里，界面上说的「已记进作答数据」才有出处
  assert.equal(SOURCE.includes("'/api/studymate/attempts'"), true);

  const item = { q: '哪一层解析域名？', opts: ['应用层', '传输层'], ans: 0, why: 'DNS 在应用层。' };
  const base = {
    item, index: 0, node: { id: NODE }, subject: { slug: 'demo' }, stateKey: KEY0,
    chosen: 0, self: null, attempts: new Map(), record() {}, onChoose() {}, onSelf() {},
  };
  const render = (attempts) => viewText(I.Question(Object.assign({}, base, { attempts })));

  const pending = render(new Map([[KEY0, local({ pending: 1 })]]));
  assert.match(pending, /正在写进作答数据…/);
  assert.equal(pending.includes('已记进作答数据'), false, '还在飞的时候不许说已经记好了');

  const done = render(new Map([[KEY0, local({ pending: 0 })]]));
  assert.match(done, /已记进作答数据（本题库文件不动）/);
  assert.match(done, /上次选了 A，对了/);

  const bad = render(new Map([[KEY0, local({ pending: 0, note: { bad: true, text: '别处刚改过这份作答数据，这次没写进去（已重读最新内容）。再点一次即可。' } })]]));
  assert.match(bad, /这次没写进作答数据（本题库文件不动）/);
  assert.match(bad, /别处刚改过这份作答数据/);

  const info = render(new Map([[KEY0, local({ pending: 0, note: { bad: false, text: '别处刚改过这份作答数据，已按最新版本重记了一次。' } })]]));
  assert.match(info, /已记进作答数据（本题库文件不动）/);
  assert.match(info, /已按最新版本重记了一次/);
});
