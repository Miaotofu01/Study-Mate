/* 验收 #106 · 引用 chip：选中的那段跟着**下一条消息**走（阅读端 `lib/client.js`）
   ────────────────────────────────────────────────────────────────────────────────
   宿主那一侧的 `ref` **只是一个字符串**，没有反序列化入口：`codec.serialize(ref)` 是「提交
   那一刻进消息的那段文字」的唯一出处。所以这一票承重的是三件东西，本套件各守一半：

     1. **编解码是一对纯函数**（`ref` ↔ 原文 + 来源锚点）：往返逐字相等、坏 `ref` 不拦发送、
        `serialize` 出来的就是「原文 + 来源锚点」、`clipboardText` 是可读短形态；
     2. **引用来源在插件激活时注册、随插件卸载注销**：名字不与宿主的 reference / skill /
        command 撞；`(trigger, name)` 重复注册即抛（所以只许造一次）。
        ——这条是承重的：提交那一刻按 name 找不到 owner 的 codec，**整次发送失败、草稿还原**；
     3. **进草稿那条调用序列**（插入 / 换掉 / 撤掉）：同一会话只挂一条，再划一段换掉旧的；
        `draftRev` 的 CAS 失败要重试或把话说明白，别静默丢。

   夹具：`fixtures/client_harness.mjs`（React 桩 + `apply(fakeCtx)`）+ `fixtures/ask_draft_facade.js`
   那份**假输入门面**（与浏览器夹具 `browser/ask_quote_test.mjs` 共用同一份）。假门面照宿主的
   行为写照，**而且同时照两套投影**：`state.getSnapshot()` 给 `{draft, draftRev, detectText,
   clipboardText, occurrences, selection, caret}`——`occurrences[].offset/length` 是**剪贴板**
   坐标（一颗 chip 占它的 `clipboardText` 那么长），而 `insertReference` / `insertText` 收到的
   span 按 **detect** 长度校验（一颗 chip 恒占 1 个字，越界就拒——照宿主 `selectSpan` 的行为）。
   Node 里没有真选区与真编辑器——真鼠标拖拽那一条在 `browser/ask_quote_test.mjs`。数据现造现弃。
   ──────────────────────────────────────────────────────────────────────────────── */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clientInternals, drainEffects, findByProp, loadClient, renderWithState, resetHookState, setHookState,
} from './fixtures/client_harness.mjs';
import { makeAskDraft, CHIP_PLACEHOLDER } from './fixtures/ask_draft_facade.mjs';

const internals = clientInternals();
const {
  AskPanel,
  QUOTE_TRIGGER, QUOTE_SOURCE_NAME, QUOTE_REF_KIND,
  encodeQuoteRef, decodeQuoteRef, quoteForModel, quoteForClipboard, shortQuote, quoteSource,
  referenceInsertFor, quoteReferenceSource, quoteSlots,
  inputFacadeFor, ourOccurrence, putQuoteInDraft, dropQuoteFromDraft,
  detectLengthOf, detectOffsetOfClipboardOffset, chipDetectSpan,
} = internals;

const TEXT = '别名只是同一个值的两个名字：改了 a，b 也跟着变——它俩指向同一个值。';
const ANCHOR = { lesson: 'demo/1-变量.md', section: 'binding-2', sectionTitle: '绑定' };
const QUOTE = { text: TEXT, anchor: ANCHOR };
const HOST_TAKEN = ['reference', 'skill', 'command'];

/* ── 假输入门面：共用夹具 + 这一套要的「一条会话」那一层 ─────────────────── */

/** 一条假草稿。`sessionId` 就是 `conversation.input.for` 认的那个作用域。 */
function fakeDraft(sessionId, initial = '') {
  const draft = makeAskDraft({ initial });
  draft.session = sessionId;
  return draft;
}

/** 照宿主 `sessions.retain()` 给的那条引用：`binding.ctx` 就是输入门面的 `actx`。 */
function held(sessionId, draft) {
  const actx = { __session: sessionId };
  return {
    id: sessionId,
    reference: { sessionId, binding: { sessionId, ctx: actx } },
    actx,
  };
}

/**
 * 把插件装起来（`apply` 是唯一拿得到宿主服务的地方），并记下注册进来的引用来源。
 * `draft` 给了就装一条输入门面（`conversation.input.for(actx)` 认得出我们那条会话）。
 */
function boot({ draft = null } = {}) {
  const sources = [];
  const effects = [];
  const inputTriggers = {
    registerSource(source) {
      if (sources.some((one) => one.trigger === source.trigger && one.name === source.name)) {
        throw new Error(`slash source "${source.trigger}${source.name}" is already registered`);
      }
      sources.push(source);
      return () => { const at = sources.indexOf(source); if (at >= 0) sources.splice(at, 1); };
    },
  };
  const conversation = {
    input: {
      for(actx) {
        if (!actx || !draft || actx.__session !== draft.session) throw new Error('conversation.input.for requires a retained Session scope');
        return draft;
      },
    },
  };
  const sessions = {
    scope: (id) => ({ __session: id }),
    retain: () => ({ release() {} }),
    list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} },
    refresh: () => Promise.resolve(),
  };
  const ctx = {
    get: (name) => ({ sessions, inputTriggers, conversation }[name]),
    slots: { inject: () => {}, register: () => () => {} },
    effect: (fn) => { const dispose = fn(); effects.push(dispose); return dispose; },
  };
  loadClient().plugin.apply(ctx);
  return { sources, effects, inputTriggers, conversation, sessions };
}

test.beforeEach(() => { quoteSlots.clear(); });

/* ══ 一、编解码：一对纯函数，往返逐字相等 ═══════════════════════════════ */

test('#106 编解码：原文 + 来源锚点往返逐字相等（引号、换行、分隔符都不歧义）', () => {
  const awkward = { text: '他说「a\nb」——{v:1,"kind":"x"} 不是我们的；\t尾声。', anchor: { lesson: '科目 A/1-×.md', section: 's-1', sectionTitle: '小节「一」' } };
  for (const quote of [QUOTE, awkward, { text: TEXT, anchor: { lesson: 'x.md' } }]) {
    const ref = encodeQuoteRef(quote);
    assert.equal(typeof ref, 'string');
    assert.ok(ref.startsWith('{'), 'ref 不是一行可读的 JSON：' + ref);
    const back = decodeQuoteRef(ref);
    assert.equal(back.text, quote.text, '原文没逐字回来');
    assert.deepEqual(back.anchor, {
      lesson: quote.anchor.lesson || '',
      section: quote.anchor.section || '',
      sectionTitle: quote.anchor.sectionTitle || '',
    });
  }
});

test('#106 编解码：不是我们编的、坏掉的 ref 一律给 null（别拦发送）', () => {
  const bad = [
    ['空串（空选区）', ''],
    ['宿主官方 @ 的那条 mention', '@src/lib/client.js'],
    ['JSON 但 kind 不对', JSON.stringify({ kind: 'someone.else', text: 'x' })],
    ['JSON 但正文是空的', JSON.stringify({ v: 1, kind: QUOTE_REF_KIND, text: '' })],
    ['半截 JSON', '{"v":1,"kind":"studymate.quote"'],
    ['压根不是字符串', null],
  ];
  for (const [why, ref] of bad) assert.equal(decodeQuoteRef(ref), null, why);
  // 解码不了也不许把发送拦下：原样退回
  assert.equal(quoteForModel('@src/x.js'), '@src/x.js');
  assert.equal(quoteForClipboard('@src/x.js'), '@src/x.js');
});

test('#106 空引用（没划中 / 太短）不产生 chip：ref 是空串、插入件是 null', () => {
  for (const empty of [null, undefined, { text: '' }, { text: 3 }]) {
    assert.equal(encodeQuoteRef(empty), '');
    assert.equal(referenceInsertFor(empty), null);
  }
});

/* ══ 二、两个投影：serialize 就是「原文 + 来源锚点」 ═════════════════════ */

test('#106 serialize：进消息的那段文字 = 原文 + 来源锚点（缺哪半就少写哪半）', () => {
  const full = quoteForModel(encodeQuoteRef(QUOTE));
  assert.ok(full.includes(TEXT), '原文没进消息：' + full);
  assert.ok(full.includes('绑定'), '来源小节没进消息：' + full);
  assert.ok(full.includes(ANCHOR.lesson), '这一课没进消息：' + full);
  assert.equal(full, `【引用】小节「绑定」 · ${ANCHOR.lesson}\n${TEXT}`);

  // 没有小节归属（起点在正文里但不在任何 section 里）时只写这一课
  const loose = { text: TEXT, anchor: { lesson: 'demo/1-变量.md', section: '', sectionTitle: '' } };
  assert.equal(quoteForModel(encodeQuoteRef(loose)), `【引用】${loose.anchor.lesson}\n${TEXT}`);
  // 连课都没有：只剩引用标记 + 原文，别留空的分隔符
  assert.equal(quoteForModel(encodeQuoteRef({ text: TEXT })), `【引用】${TEXT}`);
});

test('#106 clipboardText：可读短形态（换行压平、超长截断），草稿里的占位就是它', () => {
  assert.equal(quoteForClipboard(encodeQuoteRef(QUOTE)), `【引用】${TEXT}（小节「绑定」 · ${ANCHOR.lesson}）`);
  const long = { text: '一二三四五六七八九十'.repeat(8), anchor: ANCHOR };
  const short = quoteForClipboard(encodeQuoteRef(long));
  assert.ok(short.includes('…'), '长引用没截断：' + short);
  assert.ok([...short].length < 80, '短形态还是太长：' + short);
  // 一行化的判据在 shortQuote 里：换行/缩进压成空格
  assert.equal(shortQuote('  a\n b\t c  '), 'a b c');
  assert.equal(shortQuote(TEXT), TEXT);
});

test('#106 插入件：source 是我们的名字、ref 解得回原文、label 是短形态', () => {
  const insert = referenceInsertFor(QUOTE);
  assert.equal(insert.source, QUOTE_SOURCE_NAME);
  assert.equal(decodeQuoteRef(insert.ref).text, TEXT);
  assert.equal(insert.clipboardText, quoteForClipboard(insert.ref));
  assert.ok(insert.label.length <= 60);
  assert.equal(insert.appearance, undefined, '没说这一条是 file/folder/session，别硬安一个');
});

/* ══ 三、引用来源：注册形状与生命周期（承重） ═══════════════════════════ */

test('#106 来源：trigger 是 @、名字不撞宿主那三个，codec 在册', () => {
  const source = quoteReferenceSource();
  assert.equal(source.trigger, QUOTE_TRIGGER);
  assert.equal(source.trigger, '@');
  assert.equal(source.name, QUOTE_SOURCE_NAME);
  for (const taken of HOST_TAKEN) {
    assert.notEqual(source.name, taken, `名字撞上了宿主的 ${taken}：重复注册会抛，整套引用都进不去`);
  }
  assert.equal(typeof source.codec.serialize, 'function');
  assert.equal(typeof source.codec.clipboardText, 'function');
  assert.equal(typeof source.onPick, 'function');
  assert.equal(typeof source.candidates, 'function');
  assert.equal(typeof source.warm, 'undefined', '没用到就别声明（声明了宿主会调它）');
});

test('#106 来源：候选读「这个会话此刻那条引用」，没有就给空数组', async () => {
  const source = quoteReferenceSource();
  assert.deepEqual(await source.candidates({ sessionId: 'qa-1' }, {}), []);
  quoteSlots.set('qa-1', QUOTE);
  const list = await source.candidates({ sessionId: 'qa-1' }, {});
  assert.equal(list.length, 1);
  assert.equal(decodeQuoteRef(list[0].value).text, TEXT);
  // 多会话并行时各是各的
  assert.deepEqual(await source.candidates({ sessionId: 'qa-2' }, {}), []);
});

test('#106 来源：onPick 产出的就是那条引用（走宿主 pick 通道时的形状）', () => {
  const source = quoteReferenceSource();
  const candidate = { name: 'quote', value: encodeQuoteRef(QUOTE) };
  const outcome = source.onPick({ candidate });
  assert.ok(outcome && outcome.insert, 'onPick 没给出插入件');
  assert.equal(outcome.insert.source, QUOTE_SOURCE_NAME);
  assert.equal(decodeQuoteRef(outcome.insert.ref).text, TEXT);
  // 认不出的候选：什么都不做，别造一颗空 chip
  assert.equal(source.onPick({ candidate: { value: '@src/x.js' } }), undefined);
});

test('#106 注册：挂在插件 fiber 上——插件活着它就注册着，卸载时注销（提交那一刻必须在册）', () => {
  const { sources, effects } = boot();
  assert.equal(sources.length, 1, '插件激活时没有注册引用来源');
  assert.equal(sources[0].trigger, '@');
  assert.equal(sources[0].name, QUOTE_SOURCE_NAME);
  assert.equal(typeof sources[0].codec.serialize, 'function', '在册的那份没带 codec：提交会被拦下');
  // 插件卸载 = fiber 上的 effect 全跑一遍 disposer：注册必须跟着撤
  for (const dispose of effects) { if (typeof dispose === 'function') dispose(); }
  assert.deepEqual(sources, [], '插件卸载后引用来源还注册着');
});

/* ══ 四、进草稿：插入 / 换掉 / 撤掉 ═══════════════════════════════════════ */

test('#106 插入：草稿里没有我们的 chip 就落在末尾，且只有一个 ref', () => {
  const draft = fakeDraft('qa-1', '请讲讲这个');
  const slot = held('qa-1', draft);
  boot({ draft });

  assert.equal(putQuoteInDraft(slot, QUOTE), 'in');
  assert.equal(draft.chips.length, 1);
  assert.equal(decodeQuoteRef(draft.chips[0].ref).text, TEXT);
  assert.ok(draft.draft.includes(TEXT), 'chip 没进草稿：' + draft.draft);
  assert.ok(draft.draft.startsWith('请讲讲这个'), '打好的字被动了：' + draft.draft);
  // 已经是这一条：不重复插
  assert.equal(putQuoteInDraft(slot, QUOTE), 'same');
  assert.equal(draft.chips.length, 1);
});

test('#106 换掉：同一会话只挂一条——再划一段换掉旧的，不攒成两颗', () => {
  const draft = fakeDraft('qa-1', '前缀 ');
  boot({ draft });
  const slot = held('qa-1', draft);

  putQuoteInDraft(slot, QUOTE);
  const second = { text: '换一段重问：别名只是同一个值的两个名字。', anchor: { lesson: 'demo/1-变量.md', section: 'binding-3', sectionTitle: '小结' } };
  assert.equal(putQuoteInDraft(slot, second), 'in');
  assert.equal(draft.chips.length, 1, '攒成两颗了：模型答的不是学生此刻指着的那一段');
  assert.equal(decodeQuoteRef(draft.chips[0].ref).text, second.text);
  assert.equal(draft.draft.includes(TEXT), false, '旧那一段还留在草稿里：' + draft.draft);
  assert.ok(draft.draft.startsWith('前缀 '), '打好的字被动了：' + draft.draft);
});

/* ── 两套投影：chip 的 detect 坐标是一个字，不是 clipboardText 那么长 ────────
   宿主的事实（见 fixtures/ask_draft_facade.js 的文件头）：`occurrences[].offset/length`
   是**剪贴板**坐标，而 `insertReference` / `insertText` 的 `span` 要的是 **detect** 坐标。
   这两条断言就是把「实现拿错了哪一套坐标」钉死。 */

test('#106 坐标：chip 在 detect 投影里恒占 1 个字，检测长度 = 剪贴板长度 − Σ(length−1)', () => {
  const draft = fakeDraft('qa-1', '前缀 ');
  boot({ draft });
  assert.equal(putQuoteInDraft(held('qa-1', draft), QUOTE), 'in');
  const now = draft.state.getSnapshot();
  const chip = ourOccurrence(now);
  const span = chipDetectSpan(chip, now.occurrences);
  assert.equal(now.clipboardText.slice(chip.offset, chip.offset + chip.length), chip.clipboardText,
    '夹具自身写错了：occurrence 的 offset/length 该是剪贴板坐标');
  assert.equal(now.detectText.slice(span.start, span.end), CHIP_PLACEHOLDER,
    'chip 在 detect 投影里该正好占一个占位符');
  assert.equal(span.end, span.start + 1, 'chip 的 detect 长度必须是 1');
  assert.ok(chip.length > 1, '这条断言的对照价值在于 clipboardText 确实比 1 长');
  assert.equal(detectLengthOf(now), now.clipboardText.length - (chip.length - 1),
    'detect 长度折算错了');
  assert.equal(detectLengthOf(now), now.detectText.length);
  // 剪贴板偏移 → detect 偏移：chip 的首尾都在同一个字上（这就是 >> 换了坐标 << 会越界的根）
  assert.equal(detectOffsetOfClipboardOffset(now.occurrences, chip.offset), span.start);
  assert.equal(detectOffsetOfClipboardOffset(now.occurrences, chip.offset + chip.length), span.end);
});

test('#106 坐标：chip 后面有学生打的字时，换掉只动那一颗 chip——不连带删字', () => {
  const draft = fakeDraft('qa-1', '先说一句：');
  boot({ draft });
  const slot = held('qa-1', draft);
  assert.equal(putQuoteInDraft(slot, QUOTE), 'in');
  // 学生接着在 chip **后面**打了一段字（宿主草稿里 chip 之后可以有文字）
  draft.insertText('再问一句', { start: draft.detect.length, end: draft.detect.length, draftRev: draft.rev });
  const after = draft.draft;
  assert.ok(after.includes('再问一句'), '夹具没把后面那段字放进去：' + after);
  const tail = after.slice(after.indexOf('再问一句'));

  const second = { text: '换一段：别名只是同一个值的两个名字。', anchor: ANCHOR };
  assert.equal(putQuoteInDraft(slot, second), 'in');
  // 只有那一颗 chip 被换掉：学生打的字一个不落
  assert.equal(draft.chips.length, 1, '换完该还是只有一颗 chip：' + JSON.stringify(draft.chips));
  assert.equal(draft.draft.includes(TEXT), false, '旧那一段还留在草稿里：' + draft.draft);
  assert.ok(draft.draft.includes(tail.trim()), 'chip 后面学生打的字被连带删了：' + draft.draft);
  assert.equal(decodeQuoteRef(draft.chips[0].ref).text, second.text);
});

test('#106 坐标：chip 后头还跟着别的来源的 chip（宿主自己的 @ 引用）时，新建不越界', () => {
  const draft = fakeDraft('qa-1', '');
  boot({ draft });
  // 先放一颗**别的来源**的 chip：剪贴板里它很长，detect 里只占 1 个字。
  // 旧实现拿剪贴板长度当 detect 落点，这一条会在 span.end > detectLength 上被拒。
  assert.equal(draft.insertReference(
    { source: 'file', ref: 'demo/x.md', label: 'x.md', clipboardText: 'x.md（宿主自己的引用）' },
    { start: 0, end: 0, draftRev: draft.rev },
  ), true);
  assert.equal(putQuoteInDraft(held('qa-1', draft), QUOTE), 'in');
  assert.equal(draft.chips.length, 2, '我们的 chip 没插进去：' + JSON.stringify(draft.chips));
  const ours = ourOccurrence(draft.state.getSnapshot());
  assert.ok(ours, '草稿里找不到我们的 chip');
  assert.equal(decodeQuoteRef(ours.ref).text, TEXT);
  // 落点紧接着宿主那颗（而不是「剪贴板长度那么远」的越界处）
  assert.equal(ours.offset, 'x.md（宿主自己的引用） '.length, '我们的 chip 没落在宿主那颗之后：' + ours.offset);
  assert.ok(draft.draft.startsWith('x.md（宿主自己的引用）'), '宿主那颗被动了：' + draft.draft);
});

test('#106 坐标：草稿里有光标/选区时新建落在它那里（detect 空间），不是剪贴板长度处', () => {
  const draft = fakeDraft('qa-1', '前一段话');
  boot({ draft });
  draft.select(2);                                  // detect 空间里第 2 个字之后
  assert.equal(putQuoteInDraft(held('qa-1', draft), QUOTE), 'in');
  const now = draft.state.getSnapshot();
  const chip = ourOccurrence(now);
  // 「前一段话」的前两个字留在 chip 前面——插进去的位置是 detect 的 2，不是草稿末尾
  assert.ok(draft.draft.startsWith('前一'), '落点不是光标那里：' + draft.draft);
  assert.equal(now.detectText.indexOf(CHIP_PLACEHOLDER), 2, 'detect 空间的落点不是 2：' + now.detectText);
  assert.equal(chip.offset, 2, '剪贴板空间的落点也该是 2（前面没有别的 chip）');
});

test('#106 CAS：坐标过期（draftRev 让了一次）要重读状态重试，别静默丢', () => {
  const draft = fakeDraft('qa-1');
  // 第一次调用让 rev 先过期一次：insertReference 会静默返回 false
  const rawInsert = draft.insertReference;
  let first = true;
  draft.insertReference = (ref, span) => {
    if (first) { first = false; draft.rev += 7; return false; }   // 模拟「读状态之后编辑器又提交了一次」
    return rawInsert(ref, span);
  };
  boot({ draft });
  const slot = held('qa-1', draft);

  assert.equal(putQuoteInDraft(slot, QUOTE), 'in');
  assert.equal(draft.chips.length, 1);
  assert.equal(draft.notices.length, 0, '成了就不该提示');
});

test('#106 CAS：两次都让位才认输——返回 failed（调用方据此给一句可读提示）', () => {
  const draft = fakeDraft('qa-1');
  draft.insertReference = () => false;
  boot({ draft });
  assert.equal(putQuoteInDraft(held('qa-1', draft), QUOTE), 'failed');
  assert.equal(draft.chips.length, 0);
});

test('#106 拿不到输入门面 / 没有那件服务：返回 unavailable，不抛', () => {
  boot();                                        // 装了服务，但这一条会话没有 input 门面
  assert.equal(putQuoteInDraft(held('qa-1', null), QUOTE), 'unavailable');
  assert.equal(dropQuoteFromDraft(held('qa-1', null)), 'unavailable');
});

test('#106 撤掉：把草稿里我们那一颗剪掉，别的字与别的 chip 都不动', () => {
  const draft = fakeDraft('qa-1', '请讲讲：');
  boot({ draft });
  const slot = held('qa-1', draft);
  putQuoteInDraft(slot, QUOTE);
  // 学生接着在 chip 后面打字（宿主草稿里 chip 之后可以有文字）。注意 chip 后面那个分隔空格
  // 是宿主 `insertReference` 自己加的，撤掉 chip 不会把它一起收走——这正是「只动这一段」。
  draft.insertText('再补一句', { start: draft.detect.length, end: draft.detect.length, draftRev: draft.rev });
  const withChip = draft.draft;
  assert.ok(withChip.includes('再补一句'), '夹具没把后面那段字放进去：' + withChip);

  assert.equal(dropQuoteFromDraft(slot), 'gone');
  assert.equal(draft.chips.length, 0);
  assert.equal(draft.draft, '请讲讲： 再补一句', `草稿没回到「原文 + 分隔空格 + 后打的字」：${JSON.stringify(draft.draft)}`);
  assert.equal(draft.draft.includes(TEXT), false);
  // 已经没有那一颗了：再来一次是空操作，不是错
  assert.equal(dropQuoteFromDraft(slot), 'gone');
});

test('#106 撤掉：别的来源的 chip 与我们那颗一起在时，只撤我们那颗（剪贴板退路切的是剪贴板坐标）', () => {
  const draft = fakeDraft('qa-1', '');
  boot({ draft });
  draft.insertReference(
    { source: 'file', ref: 'demo/x.md', label: 'x.md', clipboardText: 'x.md（宿主自己的引用）' },
    { start: 0, end: 0, draftRev: draft.rev },
  );
  const slot = held('qa-1', draft);
  putQuoteInDraft(slot, QUOTE);
  assert.equal(draft.chips.length, 2, '前置条件：两颗 chip 都在');
  assert.equal(dropQuoteFromDraft(slot), 'gone');
  assert.equal(draft.chips.length, 1, '只该撤掉我们那一颗');
  assert.equal(draft.chips[0].source, 'file', '撤错了对象：' + JSON.stringify(draft.chips));
  assert.ok(draft.draft.includes('x.md（宿主自己的引用）'), '宿主那颗的字被动了：' + draft.draft);
});

/* ══ 五、面板上那颗 chip：看得见、点得开、删得掉 ═════════════════════════ */

const SUBJECT = { slug: 'demo', name: '演示科目' };
const NODE = { id: '变量', title: '变量' };

function fakeKit() {
  const SessionProvider = (props) => props.children;
  const renderFactorySlot = () => ({ type: 'div', props: { 'data-proto': 'host-conversation' }, children: null });
  return { SessionProvider, renderSlot: () => null, renderFactorySlot };
}

/** AskPanel 的 hook 次序：sessionId / held / error / busy / menuOpen / quoteOpen。 */
function frame({ sessionId = null, reference = null } = {}) {
  return [sessionId, sessionId && reference ? { id: sessionId, reference } : null, null, false, false, false];
}

test('#106 chip 界面：原文 + 来源小节在，点开看全文的入口在，删掉的入口也在', () => {
  const text = renderWithState(AskPanel, { subject: SUBJECT, node: NODE, quote: QUOTE, hostKit: fakeKit() }, frame())
    .replace(/\s+/g, ' ').trim();
  assert.ok(text.includes(TEXT), 'chip 上没写原文：' + text);
  assert.ok(text.includes('来源：小节「绑定」 · demo/1-变量.md'), text);

  resetHookState();
  setHookState(frame());
  let tree = null;
  try { tree = AskPanel({ subject: SUBJECT, node: NODE, quote: QUOTE, hostKit: fakeKit() }); } finally { resetHookState(); }
  assert.equal(findByProp(tree, 'data-proto', 'qa-quote-toggle').length, 1, '没有「点开看原文」的入口');
  assert.equal(findByProp(tree, 'data-proto', 'qa-quote-clear').length, 1, '没有「删掉」的入口');
  // 默认收起：chip 是输入框上方的附件，不该一上来就吃掉正文高度
  assert.equal(findByProp(tree, 'data-proto', 'qa-quote-full').length, 0);
});

test('#106 删除：点一下删掉，草稿里那颗跟着撤掉，学生照样能直接提问', () => {
  const draft = fakeDraft('qa-1', '先谢谢');
  boot({ draft });
  const slot = held('qa-1', draft);
  const cleared = [];
  const reference = slot.reference;

  resetHookState();
  setHookState(frame({ sessionId: 'qa-1', reference }));
  let tree = null;
  try {
    tree = AskPanel({
      subject: SUBJECT, node: NODE, quote: QUOTE, hostKit: fakeKit(),
      onQuoteClear: () => cleared.push(true),
    });
    drainEffects();                      // 插入引用 + 订阅草稿
  } finally { resetHookState(); }

  assert.equal(draft.chips.length, 1, '面板看见引用时没把它放进草稿（宿主没有提交钩子，这一步不能省）');
  assert.equal(quoteSlots.get('qa-1'), QUOTE, '会话槽里没有当前这条引用');

  const drop = findByProp(tree, 'data-proto', 'qa-quote-clear')[0];
  drop.props.onClick();
  assert.ok(cleared.length >= 1, '没把「学生不要这段引用了」告诉最外层');
  assert.equal(draft.chips.length, 0, '草稿里那颗没撤掉——下一问还会带上它');
  assert.equal(draft.draft.trim(), '先谢谢');
  assert.equal(quoteSlots.has('qa-1'), false);
});

test('#106 提交即让位：草稿里那颗没了（消息真送出去了）就清掉面板上这一颗', () => {
  const draft = fakeDraft('qa-1');
  boot({ draft });
  const slot = held('qa-1', draft);
  const cleared = [];

  resetHookState();
  setHookState(frame({ sessionId: 'qa-1', reference: slot.reference }));
  try {
    AskPanel({ subject: SUBJECT, node: NODE, quote: QUOTE, hostKit: fakeKit(), onQuoteClear: () => cleared.push(true) });
    drainEffects();
  } finally { resetHookState(); }

  assert.equal(draft.draft.includes(TEXT), true);
  // 宿主发完就清草稿（我们够不着提交钩子，看见的是这一步）
  draft.setDraft('');
  assert.deepEqual(cleared, [true], '消息送出去了，面板上那一颗还留着');
});

test('#106 提交没成功（草稿被还原）：chip 回来，引用留着——那一次什么都没送出去', () => {
  const draft = fakeDraft('qa-1');
  boot({ draft });
  const slot = held('qa-1', draft);
  const cleared = [];

  resetHookState();
  setHookState(frame({ sessionId: 'qa-1', reference: slot.reference }));
  try {
    AskPanel({ subject: SUBJECT, node: NODE, quote: QUOTE, hostKit: fakeKit(), onQuoteClear: () => cleared.push(true) });
    drainEffects();
  } finally { resetHookState(); }

  // 发送被拦下：草稿原样还回来（chip 还在），面板订阅看到的一直是「在」
  assert.ok(ourOccurrence(draft.state.getSnapshot()), 'chip 不该被我们弄丢');
  assert.deepEqual(cleared, [], '那一次什么都没送出去，引用不该被清');
});
