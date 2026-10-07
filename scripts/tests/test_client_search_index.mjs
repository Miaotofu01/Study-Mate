/* 验收 #78 · 跨科目搜索的索引覆盖（第一、二、三段验收）
   ────────────────────────────────────────────────────────────────────────
   测试对象是 `lib/client.js` 工厂闭包里的**纯逻辑**（`buildIndex` 一族）与搜索面板本体——
   它们在浏览器里跑，但一条也不碰 DOM、网络与时钟（见 client.js 里的钩子注释）。

   验收标准逐条对到用例分组：
     1. 列表 / 表格 / 围栏 / 引用 / 提示块 / 配图题注都能被搜到 —— describe「逐类块」
     2. 术语组的规范叫法与别名都能被搜到                —— describe「术语表」
     3. 学习记录与误解记录的正文能被搜到                —— describe「学习记录 / 误解记录」
     4. 索引不落盘、重建一次与首次一致                  —— describe「派生物」
     5. 跨科目同名内容各留一条、点它进对的科目          —— describe「跨科目」
     6. 每条命中说得出属于哪门科目、哪个节点（#90）      —— describe「出处」

   附件折叠块的空态（第六条验收）在 `test_client_fold_empty_state.mjs`：
   套件按「搜索」与「附件」切开，是因为它们改的是 `lib/client.js` 里两块互不相干的地方，
   合并进集成分支时各自独立成立。

   数据**现造现弃**，不依赖 `examples/.learning/`（#83 会删它）也不依赖真工作区。
   ───────────────────────────────────────────────────────────────────────── */
import test from 'node:test';
import assert from 'node:assert/strict';

import { clientInternals, loadClient, renderWithState } from './fixtures/client_harness.mjs';

const internals = clientInternals();
const { buildIndex, lessonFragments, blockFragments, KIND_ORDER, SearchPalette, hitWhere } = internals;

/** 一节课件：`#78` 点名的六类块 + 未点名的四类，各来一条，标题都带可搜的独有词。 */
const LESSON = [
  '---',
  'title: 演示课件',
  '---',
  '',
  '## 小节·列表',
  '',
  '这段话很短。',
  '',
  '- 列表项甲',
  '- 列表项乙',
  '',
  '## 小节·表格',
  '',
  '| 表头甲 | 表头乙 |',
  '| --- | --- |',
  '| 单元格甲 | 单元格乙 |',
  '',
  '## 小节·围栏',
  '',
  '```bash',
  'echo 围栏内容甲',
  '```',
  '',
  '## 小节·引用',
  '',
  '> 引用内容甲',
  '',
  '## 小节·提示块',
  '',
  '::: tip 提示标题甲',
  '提示正文甲',
  ':::',
  '',
  '## 小节·配图题注',
  '',
  '::: svg',
  'alt: 配图替代文字甲',
  'caption: 配图题注甲',
  ':::',
  '',
  '## 小节·小标题与公式',
  '',
  '### 三级小标题甲',
  '',
  '$$',
  '\\frac{公式甲}{2}',
  '$$',
  '',
  '## 小节·练习块',
  '',
  '::: practice 动手做 | 练习标题甲',
  '练习正文甲',
  ':::',
  '',
  '## 小节·资源块',
  '',
  '::: resources',
  '- [资源条目标题甲](https://example.invalid/a) | 资源说明甲',
  ':::',
  '',
  '::: related',
  '- 相关条目标题甲',
  ':::',
  '',
].join('\n');

/** 一份科目 payload：字段形状与 `lib/library.ts` 的产出一致（只造用得上的那几个）。 */
function subject(overrides) {
  return Object.assign({
    slug: 'demo',
    name: '演示科目',
    nodes: [],
    glossary: [],
    records: [],
    misconceptions: [],
  }, overrides);
}

/** 一个带课件的节点。 */
function nodeWith(lesson, overrides) {
  return Object.assign({
    id: 'demo.one', number: '0001', title: '演示节点', level: 0, tier: '未开始',
    kind: '概念', objective: '说清演示目标', problem: '边界在哪', pitfalls: ['演示坑'],
    prerequisites: [], pool: {}, lesson: '0001-demo.one', lesson_md: lesson,
  }, overrides);
}

/** 在一个科目的索引里按关键词找命中。 */
function findHits(index, query) {
  const q = query.toLowerCase();
  return index.filter((hit) => hit.search.includes(q));
}

/** 命中文本里出现某个词（用于「这一条索引里有没有某类内容」）。 */
function textsOf(index) {
  return index.map((hit) => hit.text);
}

const demoIndex = buildIndex([subject({ nodes: [nodeWith(LESSON)] })]);

/* ── 1. 逐类块：六类点名 + 四类顺带 ─────────────────────────────────────── */

test('#78 逐类块：列表 / 表格 / 围栏 / 引用 / 提示块 / 配图题注都进索引', () => {
  const cases = [
    ['列表项乙', '列表'],
    ['单元格甲', '表格'],
    ['表头乙', '表格的表头'],
    ['围栏内容甲', '围栏'],
    ['引用内容甲', '引用'],
    ['提示正文甲', '提示块正文'],
    ['提示标题甲', '提示块标题'],
    ['配图题注甲', '配图题注'],
  ];
  for (const [needle, what] of cases) {
    assert.ok(findHits(demoIndex, needle).length > 0, `${what}没有进索引：搜不到「${needle}」`);
  }
});

test('#78 逐类块：三级小标题、公式、练习块、resources / related 也进索引', () => {
  for (const needle of ['三级小标题甲', '公式甲', '练习正文甲', '练习标题甲', '资源条目标题甲', '相关条目标题甲']) {
    assert.ok(findHits(demoIndex, needle).length > 0, `搜不到「${needle}」`);
  }
});

test('#78 短段落不再被 20 字阈值挡在索引外', () => {
  // 「这段话很短。」只有 6 个字；旧实现 `block.text.length > 20` 会把它整个丢掉
  assert.ok(findHits(demoIndex, '这段话很短').length > 0, '短段落没进索引');
});

test('#78 命中带着「在哪一节 / 哪一类块」的位置信息', () => {
  const hit = findHits(demoIndex, '列表项甲')[0];
  assert.equal(hit.kind, '正文');
  assert.equal(hit.label, '小节·列表', '命中没有回报所在小节');
  assert.equal(hit.subject.slug, 'demo');
  assert.equal(hit.node.id, 'demo.one');
});

test('#78 围栏把语言名并进检索串（不冒充正文内容）', () => {
  const hit = findHits(demoIndex, 'echo 围栏内容甲')[0];
  assert.ok(hit, '围栏内容没进索引');
  assert.ok(hit.search.includes('bash'), '语言名没有进检索串');
  assert.equal(hit.text.includes('bash'), false, '语言名不该混进正文文本');
});

test('#78 配图的图号与 alt 进检索串，题注才是文本', () => {
  const hit = findHits(demoIndex, '配图题注甲')[0];
  assert.ok(hit, '配图题注没进索引');
  assert.ok(hit.search.includes('配图替代文字甲'), 'alt 没有进检索串');
  assert.ok(hit.search.includes('图 1'), '图号没有进检索串');
});

test('#78 锚点标记本身不进正文索引（题干走题库那一类，不重复）', () => {
  const withQuiz = buildIndex([subject({
    nodes: [nodeWith('## 小节\n\n::: quiz 单选 锚点：demo#q1\n:::')],
  })]);
  assert.equal(withQuiz.some((hit) => hit.kind === '正文' && hit.text.includes('单选')), false);
});

test('#78 正文片段：容器块里的嵌套正文递归取出', () => {
  const fragments = lessonFragments('## 小节\n\n::: warn 警告标题\n警告正文里的嵌套段\n:::');
  const texts = fragments.map((fragment) => fragment.text);
  assert.ok(texts.includes('警告标题'));
  assert.ok(texts.includes('警告正文里的嵌套段'));
});

test('#78 未知指令剩下的原文照索引，不静默丢内容', () => {
  const fragments = blockFragments({ type: 'unknown', name: 'x', header: '', text: '还没认识的块里的原文' }, '在哪');
  assert.deepEqual(fragments, [{ text: '还没认识的块里的原文', label: '在哪' }]);
});

/* ── 2. 术语表：规范叫法 + 别名 + 分组标题 ──────────────────────────────── */

const GLOSSARY_SUBJECT = subject({
  glossary: [{
    title: '待掌握',
    terms: [
      { term: '命令行（command line）', def: '敲命令让计算机干活的那个窗口。', avoid: '控制台、黑窗口' },
      { term: '变量（variable）', def: '给一个值起个名字存起来。', avoid: '' },
    ],
  }],
});
const glossaryIndex = buildIndex([GLOSSARY_SUBJECT]);
/** 面板里的检索判据：`search` 命中即上屏。 */
const hitsFor = (index, query) => index.filter((hit) => hit.search.includes(query.toLowerCase()));

test('#78 术语表：规范叫法搜得到', () => {
  const hits = hitsFor(glossaryIndex, '命令行');
  assert.equal(hits.length, 1, '规范叫法应恰好一条命中');
  assert.equal(hits[0].kind, '术语');
  assert.equal(hits[0].text, '命令行（command line）');
});

test('#78 术语表：别名也搜得到（这条曾经是死代码）', () => {
  for (const alias of ['控制台', '黑窗口']) {
    const hits = hitsFor(glossaryIndex, alias);
    assert.ok(hits.length > 0, `别名「${alias}」一个字都搜不到`);
    assert.equal(hits[0].text, '命令行（command line）', '别名应回到它的规范叫法那一条');
  }
});

test('#78 术语表：规范叫法与别名共用一条命中，不是两条重复项', () => {
  const term = glossaryIndex.filter((hit) => hit.text === '命令行（command line）');
  assert.equal(term.length, 1, '同一个词条应该只有一条命中');
  assert.ok(term[0].label.includes('别名：'), '别名应挂在 label 上一起被搜到');
});

test('#78 术语表：没有别名的词条照常进索引', () => {
  assert.ok(hitsFor(glossaryIndex, '变量').length > 0, '没有别名的词条没进索引');
});

test('#78 术语表：分组标题（待掌握 / 已掌握）也能搜到', () => {
  const hits = hitsFor(glossaryIndex, '待掌握');
  assert.ok(hits.length > 0, '术语分组标题没进索引');
  assert.equal(hits[0].kind, '术语');
});

/* ── 3. 学习记录与误解记录 ──────────────────────────────────────────────── */

const RECORD_MARKDOWN = [
  '# 学习记录 0001 · 分层模型与封装',
  '',
  '- 日期：2026-09-21',
  '',
  '## 观察到的证据',
  '',
  '他在没有提示的情况下把那条请求逐层算了一遍，说出「每加一个头，下面一层看到的是一整块」。',
  '',
].join('\n');

const MISCONCEPTION = {
  topic: '把赋值当成相等',
  source: '问答面板',
  evidence: '追问里说 `a = b` 就是判断相等',
  status: '未处理',
  at: '2026-09-21',
  legacy: { answer_summary: '画了一次内存格子的对应关系' },
};

const recordIndex = buildIndex([subject({
  records: [{ file: '0001-net.layers.md', title: '学习记录 0001 · 分层模型与封装', date: '2026-09-21', markdown: RECORD_MARKDOWN }],
  misconceptions: [MISCONCEPTION],
})]);

test('#78 学习记录：正文进索引（不只是标题）', () => {
  const hits = hitsFor(recordIndex, '每加一个头');
  assert.ok(hits.length > 0, '学习记录正文没进索引');
  assert.equal(hits[0].kind, '学习记录');
  assert.equal(hits[0].label, '2026-09-21', '命中应带上记录日期');
});

test('#78 学习记录：标题照旧搜得到', () => {
  assert.ok(hitsFor(recordIndex, '分层模型与封装').length > 0, '学习记录标题没进索引');
});

test('#78 误解记录：topic 与 evidence 都进索引', () => {
  assert.ok(hitsFor(recordIndex, '把赋值当成相等').length > 0, 'topic 没进索引');
  const evidence = hitsFor(recordIndex, '就是判断相等');
  assert.ok(evidence.length > 0, 'evidence 没进索引');
  assert.equal(evidence[0].kind, '误解');
});

test('#78 误解记录：旧字段里的「当时怎么解的」也进索引', () => {
  assert.ok(hitsFor(recordIndex, '内存格子的对应关系').length > 0, 'legacy.answer_summary 没进索引');
});

test('#78 误解记录：归一后的新字段（#71 单落点）一条都不用退回旧字段', () => {
  const fresh = buildIndex([subject({
    misconceptions: [{ topic: '单位换算搞反了', source: '讲解反馈', evidence: '把厘米当成了米', status: '已补练', at: '2026-10-01' }],
  })]);
  for (const needle of ['单位换算搞反了', '把厘米当成了米']) {
    assert.ok(hitsFor(fresh, needle).length > 0, `新字段没进索引：${needle}`);
  }
});

/* ── 4. 索引是派生物：不落盘、重建一致 ─────────────────────────────────── */

test('#78 索引是派生物：同一份输入重建两次，结果逐字相同', () => {
  const subjects = [subject({ nodes: [nodeWith(LESSON)], glossary: GLOSSARY_SUBJECT.glossary, misconceptions: [MISCONCEPTION] })];
  const first = buildIndex(subjects);
  const snapshot = JSON.stringify(first);
  // 中间插一次别的重建，确认没有藏在闭包里的累积状态（`seen` 必须是每次调用新建的）
  buildIndex([subject({ nodes: [nodeWith('## 别的\n\n别的段落')] })]);
  const again = buildIndex(subjects);
  assert.equal(JSON.stringify(again), snapshot, '重建结果与首次不一致');
  assert.ok(first.length > 0);
});

test('#78 索引是派生物：建索引不改动输入（没有第二份真相被写回）', () => {
  const subjects = [subject({ nodes: [nodeWith(LESSON)], glossary: GLOSSARY_SUBJECT.glossary, misconceptions: [MISCONCEPTION] })];
  const before = JSON.stringify(subjects);
  buildIndex(subjects);
  assert.equal(JSON.stringify(subjects), before, 'buildIndex 改了传进来的科目数据');
});

test('#78 索引是派生物：索引只活在返回值里，没有任何落盘入口', () => {
  // 读 client.js 源码断言：建索引这一段不出现任何写盘/存储调用。
  // 规格 §4.3「索引：阅读端内存，按需扫描工作区，不落盘」——这条是**否定性**要求，
  // 只能这样钉：出现 fetch 写、localStorage、IndexedDB 都算越界。
  const source = loadClient().source;
  const start = source.indexOf('function buildIndex(');
  assert.ok(start > 0, '找不到 buildIndex');
  const section = source.slice(start, source.indexOf('\n    function SearchPalette', start));
  for (const forbidden of ['fetch(', 'localStorage', 'sessionStorage', 'indexedDB', 'XMLHttpRequest']) {
    assert.equal(section.includes(forbidden), false, `建索引这一段出现了 ${forbidden}：索引不许落盘`);
  }
});

test('#78 索引是派生物：空工作区给空数组，不抛错', () => {
  assert.deepEqual(buildIndex([]), []);
  assert.deepEqual(buildIndex([subject({})]), []);
  // 字段缺失（老 payload / 半份科目）也不许炸
  assert.doesNotThrow(() => buildIndex([subject({ nodes: [{ id: 'x', title: '光杆节点' }], glossary: [{ title: '组', terms: [] }] })]));
});

/* ── 5. 跨科目：去重键含科目与节点，跳转进对的科目 ─────────────────────── */

const SAME_TEXT = '两个科目里一字不差的一段话';
const CROSS = buildIndex([
  subject({ slug: 'alpha', name: '甲科目', nodes: [nodeWith(`## 小结\n\n${SAME_TEXT}`, { id: 'alpha.one', title: '小结' })] }),
  subject({ slug: 'beta', name: '乙科目', nodes: [nodeWith(`## 小结\n\n${SAME_TEXT}`, { id: 'beta.one', title: '小结' })] }),
]);

test('#78 跨科目：同名内容在两个科目里各留一条', () => {
  const hits = CROSS.filter((hit) => hit.text === SAME_TEXT);
  assert.equal(hits.length, 2, '跨科目同名内容被去重吃掉了一条');
  assert.deepEqual(hits.map((hit) => hit.subject.slug).sort(), ['alpha', 'beta']);
});

test('#78 跨科目：同名小节标题也各留一条，且各带自己的节点', () => {
  const hits = CROSS.filter((hit) => hit.text === '小结' && hit.kind === '正文');
  assert.equal(hits.length, 2, '同名小节标题被去重吃掉了一条');
  assert.deepEqual(hits.map((hit) => hit.node.id).sort(), ['alpha.one', 'beta.one']);
});

test('#78 跨科目：点命中跳进它自己那个科目，不是先到的那个', () => {
  // 复刻 StudyMateApp 里 onPick 的分支（client.js：hit.node && hit.subject → goLesson）
  const picked = [];
  const onPick = (hit) => {
    if (hit.node && hit.subject) picked.push(['lesson', hit.subject.slug, hit.node.id]);
    else if (hit.subject) picked.push(['subject', hit.subject.slug]);
  };
  for (const hit of CROSS.filter((one) => one.text === SAME_TEXT)) onPick(hit);
  assert.deepEqual(picked, [
    ['lesson', 'alpha', 'alpha.one'],
    ['lesson', 'beta', 'beta.one'],
  ]);
});

test('#78 跨科目：同一科目内重复的同一段话仍然只留一条', () => {
  const dup = buildIndex([subject({
    nodes: [nodeWith('## 小节\n\n重复的一段话\n\n另一个小节里重复的一段话', { id: 'one' })],
  })]);
  assert.equal(dup.filter((hit) => hit.text === '重复的一段话').length, 1, '同一节点内应去重');
});

/* ── 6. 每条命中说得出「在哪」（#90） ──────────────────────────────────────
   结果行那一行出处文字是给跨科目搜索用的：同一条正文可能来自任何一门课，
   科目与节点必须排在最前（被省略号截掉时先丢的是补充，不是出处）。 */

test('#90 出处：科目在前、节点其次、这一条自己的补充在最后', () => {
  const index = buildIndex([subject({
    nodes: [nodeWith('## 小节·列表\n\n列表项甲', { id: 'demo.one', title: '演示节点' })],
  })]);
  assert.equal(hitWhere(findHits(index, '列表项甲')[0]), '演示科目 · 演示节点 · 小节·列表');
  // 节点上的命中（大纲那几类）没有小节补充，出处就只有科目与节点
  assert.equal(hitWhere(findHits(index, '说清演示目标')[0]), '演示科目 · 演示节点 · 目标');
});

test('#90 出处：节点为空的命中（术语 / 学习记录 / 误解）退到科目，补充照旧跟在后面', () => {
  const index = buildIndex([subject({
    nodes: [],
    glossary: [{ title: '组', terms: [{ term: '术语甲', def: '释义甲', avoid: '' }] }],
    records: [{ title: '记录标题', date: '2026-01-01', markdown: '# 记录标题\n\n记录的正文甲\n' }],
  })]);
  // 术语的 `label` 是它的释义（`buildIndex` 有意这么定：释义也要能搜到），所以出处那行
  // 是「科目 · 释义」——科目在最前，方程那一条断的就是这个
  const term = hitWhere(findHits(index, '术语甲')[0]);
  assert.ok(term.startsWith('演示科目 · '), `科目没有排在最前：${term}`);
  assert.ok(term.includes('释义甲'), `补充丢了：${term}`);
  assert.equal(hitWhere(findHits(index, '记录的正文甲')[0]), '演示科目 · 2026-01-01');
});

test('#90 出处：补充与类别同名时丢掉（没有小节名的一课，隐含小节名就叫「正文」）', () => {
  // 没有 front matter 标题、也没有二级标题：`parseLesson` 的兜底小节名恰好是「正文」，
  // 那一条不丢补充的话会印成「正文 正文 正文」
  const index = buildIndex([subject({ nodes: [nodeWith('一句话都没有小节名的正文。')] })]);
  const hit = findHits(index, '一句话都没有小节名')[0];
  assert.equal(hit.kind, '正文');
  assert.equal(hit.label, '正文');
  assert.equal(hitWhere(hit), '演示科目 · 演示节点');
});

test('#78 五类内容都建得出来，类目名与排序表一致', () => {
  const index = buildIndex([subject({
    nodes: [nodeWith(LESSON, { pool: { 'demo.one#q1': [{ q: '题干甲', opts: ['选项甲'] }] } })],
    glossary: GLOSSARY_SUBJECT.glossary,
    records: [{ title: '记录标题', date: '2026-01-01', markdown: '# 记录标题\n\n记录的正文甲\n' }],
    misconceptions: [MISCONCEPTION],
  })]);
  const kinds = new Set(index.map((hit) => hit.kind));
  assert.deepEqual([...KIND_ORDER].sort(), ['大纲', '学习记录', '题目', '术语', '误解', '正文'].sort());
  for (const kind of KIND_ORDER) assert.ok(kinds.has(kind), `这一类一条都没建出来：${kind}`);
  for (const needle of ['题干甲', '选项甲', '记录的正文甲', '说清演示目标', '演示坑']) {
    assert.ok(findHits(index, needle).length > 0, `五类内容缺一条：${needle}`);
  }
});
