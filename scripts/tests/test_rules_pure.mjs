/* 纯函数规则层（lib/core/rules.ts）的逐条断言。
   ────────────────────────────────────────────────────────────────────────
   这一层的价值全在「同一条规则只有一份、而且能被钉住」。所以下面不写「跑通就行」的用例，
   而是把规格里的每一条判据逐个断言：四层的通过标准、题型与深度的匹配、旧六档 → 三档的
   六条映射（逐条一个子测试）、证据资格、分母口径。

   输入全是内联对象，不碰文件系统——这一层本来也不该碰（decisions.md §2）。 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  LAYERS, LAYER_RULES, judgeLayer, meetsLayer, missingCriteria,
  QUESTION_KINDS, QUESTION_KIND_SHAPES, QUESTION_RULES, layersForQuestion, questionsForLayer, servesLayer,
  checkQuestionMix, inferQuestionKind, questionKindProblem,
  TIERS, LEGACY_TIERS, LEGACY_TIER_MAP, toTier, isTier,
  EVIDENCE_BY_TRUST, NON_INDEPENDENT_EVIDENCE, isIndependentEvidence, evidenceRank,
  advance, checkCoverage,
} from '../../lib/core/rules.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/* ── 一、四层判定 ─────────────────────────────────────────────────────── */

test('四层的词表就是规格 §7.1 的四个，顺序从浅到深', () => {
  assert.deepEqual([...LAYERS], ['读懂', '改对', '查错', '造出']);
  assert.deepEqual(Object.keys(LAYER_RULES), [...LAYERS]);
  for (const layer of LAYERS) assert.equal(LAYER_RULES[layer].layer, layer);
});

test('读懂：说清因果**与**前提，缺一条就不算', () => {
  assert.equal(judgeLayer({ explainsCause: true, statesPreconditions: true }).layer, '读懂');
  assert.equal(judgeLayer({ explainsCause: true }).layer, null);
  assert.equal(judgeLayer({ statesPreconditions: true }).layer, null);
  assert.deepEqual(missingCriteria({ explainsCause: true }, '读懂'), ['说清前提']);
});

test('改对：先预测是前提，「预测一致」与「能解释差异」二者取一', () => {
  const both = { predictedBeforeRun: true, predictionMatches: true };
  assert.equal(judgeLayer(both).layer, '改对');
  assert.equal(judgeLayer({ predictedBeforeRun: true, explainedDifference: true }).layer, '改对');
  // 没先写预测就不叫「改对」：事后诸葛亮不是预测
  assert.equal(judgeLayer({ predictionMatches: true, explainedDifference: true }).layer, null);
  // 预测了但既没对上、也解释不了差异：停在读懂
  assert.equal(judgeLayer({ explainsCause: true, statesPreconditions: true, predictedBeforeRun: true }).layer, '读懂');
  assert.deepEqual(
    missingCriteria({ predictedBeforeRun: true }, '改对'),
    ['预测与实测一致 或 能解释预测与实测的差异'],
  );
});

test('查错：根因、修复、预防三条缺一不可', () => {
  assert.equal(judgeLayer({ rootCause: true, fix: true, prevention: true }).layer, '查错');
  assert.equal(judgeLayer({ rootCause: true, fix: true }).layer, null);
  assert.deepEqual(missingCriteria({ rootCause: true, fix: true }, '查错'), ['给出预防']);
});

test('造出：交付物能跑通**与**能解释取舍', () => {
  assert.equal(judgeLayer({ deliverableRuns: true, explainsTradeoffs: true }).layer, '造出');
  assert.equal(judgeLayer({ deliverableRuns: true }).layer, null);
  assert.deepEqual(missingCriteria({ deliverableRuns: true }, '造出'), ['能解释取舍']);
});

test('判定取**满足了的最高一层**，并给出再上一层缺什么', () => {
  const judgement = judgeLayer({
    explainsCause: true, statesPreconditions: true,
    predictedBeforeRun: true, predictionMatches: true,
    rootCause: true,
  });
  assert.equal(judgement.layer, '改对');
  assert.deepEqual([...judgement.met], ['读懂', '改对']);
  assert.deepEqual([...judgement.missing], ['给出修复', '给出预防']);
  assert.deepEqual([...judgeLayer({}).missing], ['说清因果，不只给结论', '说清前提']);
});

test('课型不再限层级（规格 §7.1 取消了这条）：证据里有 kind 也不影响判定', () => {
  // 回归防线：旧规则是「概念止于 L3」，谁把 kind 参数加回来，这条会红。
  const evidence = { deliverableRuns: true, explainsTradeoffs: true };
  assert.equal(judgeLayer(evidence).layer, '造出');
  assert.equal(judgeLayer({ ...evidence, kind: '概念' }).layer, '造出');
  assert.equal(judgeLayer({ ...evidence, nodeKind: '概念' }).layer, '造出');
});

test('meetsLayer：拿节点的目标层级来问够不够得着', () => {
  const evidence = { explainsCause: true, statesPreconditions: true, predictedBeforeRun: true, predictionMatches: true };
  assert.deepEqual(meetsLayer(evidence, '读懂'), { ok: true, missing: [] });
  assert.equal(meetsLayer(evidence, '改对').ok, true);
  const short = meetsLayer(evidence, '查错');
  assert.equal(short.ok, false);
  assert.deepEqual([...short.missing], ['说出根因', '给出修复', '给出预防']);
});

/* ── 二、题型与深度的匹配（规格 §7.2 / §7.3）────────────────────────────── */

test('四种题型与它们服务的层，逐条对齐规格 §7.2', () => {
  const expected = {
    客观题: { layers: ['读懂'], grading: '阅读端即时判' },
    预测验证: { layers: ['改对', '查错'], grading: 'Host 半代跑' },
    开放题: { layers: ['读懂', '查错'], grading: '学生自评' },
    交付物: { layers: ['造出'], grading: 'Host 半代跑' },
  };
  assert.deepEqual([...QUESTION_KINDS], Object.keys(expected));
  for (const [kind, want] of Object.entries(expected)) {
    assert.deepEqual([...layersForQuestion(kind)], want.layers, `${kind} 服务哪一层`);
    assert.equal(QUESTION_RULES[kind].grading, want.grading, `${kind} 走哪条判分轨`);
    // 判分原文来自规格，不是随手写的一句话
    assert.equal(typeof QUESTION_RULES[kind].display, 'string');
    assert.ok(QUESTION_RULES[kind].display.length > 0);
  }
});

test('servesLayer 是全表判据，不靠特例', () => {
  for (const kind of QUESTION_KINDS) {
    for (const layer of LAYERS) {
      assert.equal(servesLayer(kind, layer), layersForQuestion(kind).includes(layer), `${kind} / ${layer}`);
    }
  }
  assert.equal(servesLayer('客观题', '造出'), false);
  assert.equal(servesLayer('交付物', '读懂'), false);
});

test('反查：某一层该出什么题，且每种题型至少服务一层', () => {
  assert.deepEqual(questionsForLayer('读懂').sort(), ['客观题', '开放题'].sort());
  assert.deepEqual(questionsForLayer('改对'), ['预测验证']);
  assert.deepEqual(questionsForLayer('查错').sort(), ['开放题', '预测验证'].sort());
  assert.deepEqual(questionsForLayer('造出'), ['交付物']);
  for (const layer of LAYERS) assert.ok(questionsForLayer(layer).length > 0, `${layer} 没有任何题型能判`);
});

test('checkQuestionMix：题型与层不匹配要逐条报出来', () => {
  const problems = checkQuestionMix([
    { kind: '客观题', layer: '读懂' },
    { kind: '客观题', layer: '造出' },
    { kind: '交付物', layer: '造出', hasRunnableEvidence: false },
    { kind: '开放题', layer: '查错', hasReferenceAnswer: false },
  ]);
  assert.equal(problems.length, 3);
  assert.deepEqual(problems.map((problem) => problem.index), [1, 2, 3]);
  assert.match(problems[0].message, /第 2 题：题型「客观题」不服务「造出」层（它服务：读懂）/);
  assert.match(problems[1].message, /交付物题必须带可运行证据/);
  assert.match(problems[2].message, /开放题必须同时给参考答案与判分要点/);
});

test('checkQuestionMix：合规的一组题不出问题', () => {
  assert.deepEqual(checkQuestionMix([
    { kind: '客观题', layer: '读懂' },
    { kind: '预测验证', layer: '改对' },
    { kind: '开放题', layer: '查错', hasReferenceAnswer: true },
    { kind: '交付物', layer: '造出', hasRunnableEvidence: true },
  ]), []);
});

/* ── 二之二、题库里一道题的字段要求（#71：题库扩到四种题型）───────────────
   这一节断言的是**字段要求**本身（哪种题型必须有哪几个字段、显式 kind 与旧写法的严格度分界），
   逐题带行号的检查在 lib/core/questions.ts，由 test_core_fence_questions.mjs 钉住。 */

test('每种题型的字段表：kind 与键一致，必备字段非空', () => {
  assert.deepEqual(Object.keys(QUESTION_KIND_SHAPES), [...QUESTION_KINDS]);
  for (const kind of QUESTION_KINDS) {
    assert.equal(QUESTION_KIND_SHAPES[kind].kind, kind);
    assert.ok(QUESTION_KIND_SHAPES[kind].required.length > 0, `${kind} 的必备字段不该为空`);
  }
  assert.deepEqual(QUESTION_KIND_SHAPES['客观题'].required, ['opts', 'ans', 'why']);
  assert.deepEqual(QUESTION_KIND_SHAPES['预测验证'].required, ['预测', '比对']);
  assert.deepEqual(QUESTION_KIND_SHAPES['开放题'].required, ['answer', 'criteria']);
  assert.deepEqual(QUESTION_KIND_SHAPES['交付物'].required, ['交付物', '证据']);
});

test('推断题型：旧词表两种按字段认出来，两组同时出现返回 null（不猜）', () => {
  assert.equal(inferQuestionKind({ opts: ['a', 'b'], ans: 0, why: 'w' }), '客观题');
  assert.equal(inferQuestionKind({ ans: 0 }), '客观题');
  assert.equal(inferQuestionKind({ answer: 'a', criteria: 'c' }), '开放题');
  assert.equal(inferQuestionKind({ criteria: 'c' }), '开放题');
  assert.equal(inferQuestionKind({ opts: ['a'], answer: 'a' }), null, '两组同时出现：不猜');
  assert.equal(inferQuestionKind({ q: '只有题面' }), null, '推不出来就 null');
});

test('显式 kind：未知题型 / 字段不全 / 字段与 kind 不一致，各报一条', () => {
  const unknown = questionKindProblem({ kind: '选择题', q: 'q' });
  assert.equal(unknown.code, 'unknown-kind');
  assert.match(unknown.message, /不在词表里/);
  assert.match(unknown.message, /客观题、预测验证、开放题、交付物/);

  const missing = questionKindProblem({ kind: '客观题', q: 'q', opts: ['a', 'b'] });
  assert.equal(missing.code, 'missing-field');
  assert.match(missing.message, /正确答案下标/);
  assert.match(missing.message, /选项（opts）、正确答案下标（ans）、答完的一句解释（why）/);

  const ambiguous = questionKindProblem({ kind: '预测验证', q: 'q', 预测: 'p', 比对: 'b', opts: ['a', 'b'], ans: 0 });
  assert.equal(ambiguous.code, 'ambiguous');

  // 四种题型各来一条合格的
  assert.equal(questionKindProblem({ kind: '客观题', q: 'q', opts: ['a', 'b'], ans: 1, why: 'w' }), null);
  assert.equal(questionKindProblem({ kind: '预测验证', q: 'q', 预测: 'p', 比对: 'b' }), null);
  assert.equal(questionKindProblem({ kind: '开放题', q: 'q', answer: 'a', criteria: 'c' }), null);
  assert.equal(questionKindProblem({ kind: '交付物', q: 'q', 交付物: 'd', 证据: 'e' }), null);
});

test('旧题库（不写 kind）照旧读得进：只查两组旧字段同时出现', () => {
  // 缺 why / opts 只有一项 / answer 是空串——旧题库不该因为新规矩变红
  assert.equal(questionKindProblem({ q: 'q', opts: ['a'], ans: 9 }), null);
  assert.equal(questionKindProblem({ q: 'q', answer: '', criteria: '' }), null);
  assert.equal(questionKindProblem({ q: '只有题面' }), null);
  // 唯一会红的：两组旧字段同时出现
  const both = questionKindProblem({ q: 'q', opts: ['a', 'b'], ans: 0, why: 'w', answer: 'a', criteria: 'c' });
  assert.equal(both.code, 'ambiguous');
  assert.match(both.message, /只能二选一/);
});

test('字段的非空判据：空串、纯空白、选项少于两项、ans 不是整数都算缺', () => {
  for (const item of [
    { kind: '客观题', q: 'q', opts: ['a', 'b'], ans: 0, why: '   ' },
    { kind: '客观题', q: 'q', opts: ['a'], ans: 0, why: 'w' },
    { kind: '客观题', q: 'q', opts: ['a', ''], ans: 0, why: 'w' },
    { kind: '客观题', q: 'q', opts: ['a', 'b'], ans: 1.5, why: 'w' },
    { kind: '客观题', q: 'q', opts: ['a', 'b'], ans: '0', why: 'w' },
    { kind: '开放题', q: 'q', answer: 'a', criteria: '' },
    { kind: '预测验证', q: 'q', 预测: '', 比对: 'b' },
    { kind: '交付物', q: 'q', 交付物: 'd', 证据: '  ' },
  ]) {
    assert.equal(questionKindProblem(item).code, 'missing-field', JSON.stringify(item));
  }
});

test('knownKinds 可注入：词表换了判据跟着换（不在函数里硬编码第二份）', () => {
  const custom = ['选择', '填空'];
  assert.equal(questionKindProblem({ kind: '选择', q: 'q' }, custom), null, '认得的词就不报');
  assert.equal(questionKindProblem({ kind: '客观题', q: 'q' }, custom).code, 'unknown-kind');
});

/* ── 三、旧六档 → 三档：逐条断言（验收标准点名的那六条）─────────────────── */

test('旧六档 → 三档，逐条', async (t) => {
  const cases = [
    ['未开始', '未开始'],
    ['学习中', '学习中'],
    ['初步理解', '学习中'],
    ['能独立应用', '已学完'],
    ['需要复习', '已学完'],
    ['已通过项目验证', '已学完'],
  ];
  for (const [legacy, tier] of cases) {
    await t.test(`${legacy} → ${tier}`, () => {
      assert.equal(toTier(legacy), tier);
      assert.equal(LEGACY_TIER_MAP.get(legacy), tier);
    });
  }
  // 六档之外没有第七条；多了就说明有人偷偷加了词表
  assert.equal(LEGACY_TIER_MAP.size, 6);
  assert.deepEqual(cases.map(([legacy]) => legacy), [...LEGACY_TIERS]);
});

test('三档原样通过，读到不认识的一律退回「未开始」', () => {
  assert.deepEqual([...TIERS], ['未开始', '学习中', '已学完']);
  for (const tier of TIERS) {
    assert.equal(toTier(tier), tier);
    assert.equal(isTier(tier), true);
  }
  for (const junk of ['', '   ', 'mastered', '已掌握', null, undefined, 3, {}, ['学习中']]) {
    assert.equal(toTier(junk), '未开始', `${JSON.stringify(junk)} 必须退回未开始`);
    assert.equal(isTier(junk), false);
  }
  // 原型链上的名字不能把词表捅穿
  assert.equal(LEGACY_TIER_MAP.get('constructor'), undefined);
  assert.equal(toTier('constructor'), '未开始');
});

/* ── 四、证据资格（规格 §7.5）────────────────────────────────────────── */

test('证据可信度排序与排除清单，逐条对齐规格 §7.5', () => {
  assert.deepEqual([...EVIDENCE_BY_TRUST], ['运行结果', '学生自写的测试', '解释能力', '口头确认']);
  assert.deepEqual([...NON_INDEPENDENT_EVIDENCE], ['自评', '同日重试', '关键词标签', '仅浏览过']);
  EVIDENCE_BY_TRUST.forEach((kind, index) => {
    assert.equal(evidenceRank(kind), index, `${kind} 的序号`);
    assert.equal(isIndependentEvidence(kind), true);
  });
  for (const kind of NON_INDEPENDENT_EVIDENCE) {
    assert.equal(evidenceRank(kind), -1, `${kind} 不参与排序`);
    assert.equal(isIndependentEvidence(kind), false);
  }
  assert.equal(isIndependentEvidence('模型说学生懂了'), false);
});

/* ── 五、三档推进 ─────────────────────────────────────────────────────── */

test('推进：开始学习只把「未开始」推到「学习中」', () => {
  assert.deepEqual(advance('未开始', { kind: '开始学习' }), {
    from: '未开始', to: '学习中', changed: true, reason: '开始学习：未开始 → 学习中',
  });
  assert.equal(advance('学习中', { kind: '开始学习' }).changed, false);
  assert.equal(advance('已学完', { kind: '开始学习' }).changed, false);
});

test('推进：只有独立证据能推到「已学完」', () => {
  for (const evidence of EVIDENCE_BY_TRUST) {
    const result = advance('学习中', { kind: '证据通过', evidence });
    assert.equal(result.to, '已学完', `${evidence} 应当能推动状态`);
    assert.equal(result.changed, true);
  }
  for (const evidence of NON_INDEPENDENT_EVIDENCE) {
    const result = advance('学习中', { kind: '证据通过', evidence });
    assert.equal(result.to, '学习中', `${evidence} 不该推动状态`);
    assert.equal(result.changed, false);
    assert.match(result.reason, /不算独立通过证据/);
  }
  // 旧词表读到的值也照样按三档推进
  assert.equal(advance('初步理解', { kind: '证据通过', evidence: '运行结果' }).from, '学习中');
});

test('推进：「要求复习」是一次回退，未开始不动', () => {
  assert.equal(advance('已学完', { kind: '要求复习' }).to, '学习中');
  assert.equal(advance('已学完', { kind: '要求复习' }).changed, true);
  assert.equal(advance('学习中', { kind: '要求复习' }).changed, false);
  assert.equal(advance('未开始', { kind: '要求复习' }).to, '未开始');
});

test('推进：签名里没有「谁说的」——模型输出进不来', () => {
  // 规格 §7.5「模型输出不能直接改进度状态」。这里靠的是**签名里根本没有这个位置**：
  // 事件只有三种 kind，多塞的字段一个都不读。
  const smuggled = advance('未开始', { kind: '证据通过', evidence: '自评', model: 'gpt', role: 'practice-evaluator', said: '已掌握' });
  assert.equal(smuggled.to, '未开始');
  const unknownEvent = advance('未开始', { kind: '模型判定通过' });
  assert.equal(unknownEvent.to, '未开始');
  assert.equal(unknownEvent.changed, false);
  assert.match(unknownEvent.reason, /不认识的推进事件/);
});

/* ── 六、分母口径 ─────────────────────────────────────────────────────── */

test('分母口径：范围为空时绝不显示「通过」', () => {
  const empty = checkCoverage([], ['随便什么']);
  assert.equal(empty.passed, false);
  assert.equal(empty.total, 0);
  assert.match(empty.reason, /范围为空时绝不显示「通过」/);
});

test('分母口径：全部必需核心点才算通过', () => {
  const full = checkCoverage(['a', 'b', 'c'], ['a', 'b', 'c', '多出来的']);
  assert.equal(full.passed, true);
  assert.equal(full.covered, 3);
  assert.equal(full.total, 3);

  const partial = checkCoverage(['a', 'b', 'c'], ['a']);
  assert.equal(partial.passed, false);
  assert.deepEqual([...partial.missing], ['b', 'c']);
  assert.equal(partial.covered, 1);
  assert.match(partial.reason, /还缺 2 \/ 3 个必需核心点：b、c/);
});

/* ── 七、这一层真的不碰文件系统 ───────────────────────────────────────── */

test('lib/core/** 不 import 任何 node:*（decisions.md §2）', () => {
  const directory = path.join(ROOT, 'lib', 'core');
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length >= 3, `lib/core/ 下至少有三个模块，实际 ${JSON.stringify(files)}`);
  for (const name of files) {
    const source = fs.readFileSync(path.join(directory, name), 'utf8');
    assert.equal(/from\s+['"]node:/.test(source), false, `${name} 里出现了 node: import`);
    assert.equal(/require\s*\(/.test(source), false, `${name} 里出现了 require`);
    assert.equal(/from\s+['"]\.\.\//.test(source), false, `${name} import 了 lib/core/ 之外的东西`);
  }
});
