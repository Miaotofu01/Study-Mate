/* 验收 #79 · 问答面板的请求体：上下文只带三样（纯函数域 `lib/core/ask.ts`）
   ────────────────────────────────────────────────────────────────────────
   规格 §7.4 钉死的是**上下文边界**，不是「大致带上」：

     「上下文只带：当前课件、选中文本、共享记忆。不背整个会话。」

   所以这里断言的是**发出去的那一份请求体**本身：
     · 顶层键恰好是那六个（多一个键都要在这里说清楚为什么）；
     · 三样上下文只出现在 `messages[0]` 的那一段文本里，各带小标题；
     · 没有任何会话痕迹——没有 sessionId、没有第二组 messages、没有历史问答。

   真模型调用要花额度，**门禁里不跑**（假 llm 的那一半在
   `scripts/tests/test_host_ask_route.mjs`）。数据现造现弃。
   ──────────────────────────────────────────────────────────────────────── */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASK_SYSTEM_PROMPT, MEMORY_LIMIT, LESSON_LIMIT,
  AskContextError, askContextText, assembleAnswer, buildAskContext, summarizeAnswer, topicFromQuestion,
} from '../../lib/core/ask.ts';
// 能力探测的本体在纯函数域（工具域与问答域共用一份，见 lib/core/model.ts 的文件头）
import { probeModel, unmetRequirement } from '../../lib/core/model.ts';

const LESSON = '# 子网与掩码\n\n## 掩码是按位与\n\n192.168.1.100/26 的网络地址是 192.168.1.64。\n';
const MEMORY = '讲法偏好：先给结论再给为什么；术语先来历后定义。';
const SELECTION = '掩码是按位与：100 与 192 逐位相与得 64。';
const QUESTION = '/26 的掩码是 255.255.255.192，为什么网络地址是 192.168.1.64，不是 192.168.1.0？';

function body(overrides = {}) {
  return buildAskContext({
    lesson: LESSON, selection: SELECTION, memory: MEMORY, question: QUESTION,
    provider: 'opencode-go', model: 'deepseek-v4.1-flash',
    ...overrides,
  });
}

test('#79 请求体：顶层键恰好是那六个，没有会话身份', () => {
  const request = body();
  assert.deepEqual(Object.keys(request).sort(), ['maxTokens', 'messages', 'model', 'provider', 'system', 'temperature']);
  // 会话身份一旦进来，这次调用就会被算进某条会话——面板是**一次性**调用，不属于任何会话
  for (const forbidden of ['sessionId', 'tools', 'toolHistory', 'purpose', 'history', 'conversation']) {
    assert.equal(Object.hasOwn(request, forbidden), false, `请求体里出现了 ${forbidden}`);
  }
  assert.equal(request.provider, 'opencode-go');
  assert.equal(request.model, 'deepseek-v4.1-flash');
  assert.equal(request.system, ASK_SYSTEM_PROMPT);
  assert.equal(request.messages.length, 1, '只该有一条 user 消息：多了就是把上一次问答背上了');
  assert.equal(request.messages[0].role, 'user');
});

test('#79 请求体：三样上下文各带小标题，一个不多一个不少', () => {
  const text = askContextText(body());
  assert.ok(text.includes('【共享记忆】'), '没带共享记忆');
  assert.ok(text.includes(MEMORY), '共享记忆被截掉或没进去');
  assert.ok(text.includes('【当前课件】'), '没带当前课件');
  assert.ok(text.includes('掩码是按位与'), '课件正文没进去');
  assert.ok(text.includes('【选中文本】'), '没带选中文本');
  assert.ok(text.includes(SELECTION), '选中的那段没进去');
  assert.ok(text.includes('【我的问题】'), '没带提问原文');
  assert.ok(text.includes(QUESTION), '提问原文没进去');
  // front matter 之类的元信息不该由组装层负责（路由那边切），这里只钉「三样都在」
  assert.equal(text.includes('【'), true);
});

test('#79 请求体：不背会话——同一个面板连问两次，第二次不带第一次的任何痕迹', () => {
  const first = body({ question: '第一问：掩码是什么？' });
  const second = body({ question: '第二问：那广播地址呢？' });
  const text = askContextText(second);
  assert.equal(text.includes('第一问'), false, '第二次提问把上一次的问题背上了');
  assert.equal(second.messages.length, 1, 'messages 里多出了历史轮次');
  assert.notEqual(askContextText(first), text);
  // 两条消息的**形状**完全一样（只有问题那一段不同）——这才是「一次性调用」
  assert.deepEqual(first.messages[0].content[0].type, second.messages[0].content[0].type);
});

test('#79 请求体：超长记忆与课件截断并标注，不静默丢', () => {
  const longMemory = '记'.repeat(MEMORY_LIMIT + 50);
  const longLesson = '课'.repeat(LESSON_LIMIT + 50);
  const text = askContextText(body({ memory: longMemory, lesson: longLesson }));
  assert.ok(text.includes('共享记忆太长，只带了开头一段'), '超长记忆被静默截断');
  assert.ok(text.includes('课件太长，只带了开头一段'), '超长课件被静默截断');
  assert.ok(text.length < MEMORY_LIMIT + LESSON_LIMIT + 500, '截断没生效：请求体还是整份长文');
});

test('#79 请求体：缺课件或缺提问直接抛错，不猜也不发空上下文', () => {
  assert.throws(() => body({ lesson: '   ' }), (error) => error instanceof AskContextError && error.field === 'lesson');
  assert.throws(() => body({ question: '' }), (error) => error instanceof AskContextError && error.field === 'question');
  assert.throws(() => body({ provider: '' }), (error) => error instanceof AskContextError && error.field === 'provider');
  assert.throws(() => body({ model: '' }), (error) => error instanceof AskContextError && error.field === 'model');
});

test('#79 请求体：没划中段落时不带「选中文本」那一段，其余三样照旧', () => {
  const text = askContextText(body({ selection: '   ' }));
  assert.equal(text.includes('【选中文本】'), false);
  assert.ok(text.includes('【共享记忆】') && text.includes('【当前课件】') && text.includes('【我的问题】'));
});

test('#79 回答拆分：【回答】/【摘要】两段，摘要按码位截到上限', () => {
  const parsed = assembleAnswer('【回答】\n掩码按位与，所以是 64。\n\n【摘要】\n掩码按位与：100 与 192 得 64');
  assert.equal(parsed.body, '掩码按位与，所以是 64。');
  assert.equal(parsed.summary, '掩码按位与：100 与 192 得 64');
});

test('#79 回答拆分：模型没照格式来时退回把正文压成一句，不假装拿到了摘要', () => {
  const parsed = assembleAnswer('**掩码是按位与**，所以 192.168.1.100/26 的网络地址是 64。');
  assert.ok(parsed.body.includes('掩码是按位与'));
  assert.equal(parsed.body.includes('【'), false);
  assert.ok(parsed.summary.length > 0 && parsed.summary.length <= 60);
  assert.equal(parsed.summary.includes('*'), false, '摘要里还留着 Markdown 记号');
});

test('#79 回答拆分：空输出给空，不编一句', () => {
  assert.deepEqual(assembleAnswer('   '), { body: '', summary: '' });
  assert.deepEqual(assembleAnswer(null), { body: '', summary: '' });
});

test('#79 摘要：按码位截断（中文不会被截成半个字）', () => {
  const summary = summarizeAnswer('一'.repeat(200));
  assert.equal([...summary].length, 60);
});

test('#79 topic：从提问原文里取第一个句子，确定且可复现', () => {
  // 长问句按码位截到 40：topic 是「卡在哪」的一句话，界面上放不下一整段
  assert.equal(topicFromQuestion(QUESTION), '/26 的掩码是 255.255.255.192，为什么网络地址是 192.16');
  assert.equal(topicFromQuestion(QUESTION), topicFromQuestion(QUESTION), '同一次提问两次得到不同的 topic');
  assert.equal(topicFromQuestion('掩码是什么？那广播地址呢？'), '掩码是什么');
  assert.equal(topicFromQuestion('   '), '');
  assert.equal([...topicFromQuestion('一'.repeat(200))].length, 40);
});

/* ── 能力探测：`{available:false, reason}` 的唯一判据（工具域与问答域共用）──── */

test('#79 能力探测：三层事实里只探前两层，available:true 的含义是「建议试一次」', () => {
  const noService = probeModel({ get: () => undefined });
  assert.equal(noService.available, false);
  assert.match(noService.reason, /ctx\.llm 不在/);

  const noProvider = probeModel({ get: () => ({ listProviders: () => [] }) });
  assert.equal(noProvider.available, false);
  assert.match(noProvider.reason, /provider/);

  const ok = probeModel({ get: () => ({ listProviders: () => [{ id: 'p1', name: 'P1' }, { id: 'p2' }] }) });
  assert.equal(ok.available, true);
  // 可用时**不写** reason：写了就等于说「这次一定答得出来」，而真相只有 stream() 知道
  assert.equal(Object.hasOwn(ok, 'reason'), false);
  assert.deepEqual(ok.providers, ['p1（P1）', 'p2']);
});

test('#79 能力探测：listProviders 抛错时给得出原因，不让异常冒到调用方', () => {
  const view = probeModel({ get: () => ({ listProviders: () => { throw new Error('adapter 崩了'); } }) });
  assert.equal(view.available, false);
  assert.match(view.reason, /adapter 崩了/);
});

test('#79 能力探测：unmetRequirement 只对声明了 model 的工具判', () => {
  const ok = { get: () => ({ listProviders: () => [{ id: 'p1' }] }) };
  assert.equal(unmetRequirement(ok, []), null);
  assert.equal(unmetRequirement(ok, ['model']), null);
  const unmet = unmetRequirement({ get: () => undefined }, ['model']);
  assert.equal(unmet.available, false);
  assert.match(unmet.reason, /ctx\.llm 不在/);
});
