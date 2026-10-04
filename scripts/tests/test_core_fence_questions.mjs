/* 纯函数域：写入栅栏的判据（lib/core/fence.ts）+ 题库题型与字段（lib/core/questions.ts）
   + 误解记录的字段定型（lib/core/misconceptions.ts）。
   ────────────────────────────────────────────────────────────────────────
   这三份都是**判据**，不是落盘：落盘那侧在 lib/reference.ts 与 lib/attempts.ts
   （各自的特征化套件钉行为）。这里钉的是判据本身——幂等台账的三种结论、operationId
   的归一与上限、版本比较、题型词表与必备字段、旧误解字段的搬运。

   数据都是内联对象，现造即弃；唯一的读盘是「拿真 schema 做一次词表对齐」。 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  IdempotencyLedger, OPERATION_ID_MAX, LEDGER_MAX, checkOperationId, fingerprintOf, versionMatches,
} from '../../lib/core/fence.ts';
import {
  QUESTION_KINDS, QUESTION_KIND_SHAPES, inferQuestionKind, questionKindProblem,
} from '../../lib/core/rules.ts';
import { checkPoolKinds } from '../../lib/core/questions.ts';
import {
  MISCONCEPTION_SOURCES, MISCONCEPTION_STATUSES, normalizeMisconception, normalizeMisconceptions,
  misconceptionIssues,
} from '../../lib/core/misconceptions.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/* ── 一、operationId 的归一与上限 ─────────────────────────────────────── */

test('operationId：trim 之后判空与长度，200 是上限之内', () => {
  assert.deepEqual(checkOperationId('abc'), { ok: true, id: 'abc' });
  // 双击时多打一个空格算同一次提交——trim 之后再判长度
  assert.deepEqual(checkOperationId('  abc  '), { ok: true, id: 'abc' });
  assert.deepEqual(checkOperationId('x'.repeat(OPERATION_ID_MAX)), { ok: true, id: 'x'.repeat(OPERATION_ID_MAX) });

  for (const bad of [undefined, null, '', '   ', 42, {}, 'x'.repeat(OPERATION_ID_MAX + 1)]) {
    const verdict = checkOperationId(bad);
    assert.equal(verdict.ok, false, JSON.stringify(bad));
    assert.ok(verdict.reason === 'empty' || verdict.reason === 'too-long');
  }
  // 空白不计入长度：`  ` + 200 个 x + `  ` 仍是上限之内
  assert.equal(checkOperationId(`  ${'x'.repeat(OPERATION_ID_MAX)}  `).ok, true);
});

test('指纹：分隔符不可打印，字段里带分隔符也撞不了键', () => {
  assert.equal(fingerprintOf(['a', 'b']), 'a\u0000b');
  // 值里带竖线之类可打印分隔符时，拼出来的键仍然不同（用 \u0000 的理由）
  assert.notEqual(fingerprintOf(['a|b', 'c']), fingerprintOf(['a', 'b|c']));
  assert.equal(fingerprintOf([]), '');
});

test('版本比较：两边都先转字符串再 trim', () => {
  assert.equal(versionMatches('abc', 'abc'), true);
  assert.equal(versionMatches(' abc ', 'abc'), true);
  // 文件里读出来的可能是数字（YAML 的日期/版本号）
  assert.equal(versionMatches(16, '16'), true);
  assert.equal(versionMatches('abc', 'abd'), false);
  // 没带期望版本是**调用方**要拦的（`expected-version-required`），这一层只做比较：
  // `undefined` 转成字符串是 "undefined"，不会与任何真实版本号相等——不会静默放行
  assert.equal(versionMatches(undefined, ''), false);
  assert.equal(versionMatches(null, ''), false);
});

/* ── 二、幂等台账的三种结论 ───────────────────────────────────────────── */

test('台账：没见过 → fresh；同 id 同指纹 → 回放原回执；同 id 换内容 → 冲突', () => {
  const ledger = new IdempotencyLedger();
  assert.equal(ledger.size, 0);

  const fresh = ledger.lookup('op-1', 'fp-1');
  assert.deepEqual(fresh, { kind: 'fresh', fingerprint: 'fp-1' });

  const response = { ok: true, value: 7 };
  ledger.remember('op-1', 'fp-1', response);
  assert.equal(ledger.size, 1);

  // 回放：**同一个对象**原样给回（不是拷贝）——回执里带着写完之后重读的清单，
  // 拷贝一份会让「重放与第一次逐字相等」变成两件事
  const replay = ledger.lookup('op-1', 'fp-1');
  assert.equal(replay.kind, 'replay');
  assert.equal(replay.response, response);

  const conflict = ledger.lookup('op-1', 'fp-2');
  assert.equal(conflict.kind, 'conflict');
  assert.equal(conflict.response, response, '冲突时也把上次的回执给回调用方，好让它说清「那次写的是什么」');
});

test('台账：记满上限先丢最旧的一条（Map 的插入顺序就是「最旧」）', () => {
  const ledger = new IdempotencyLedger(3);
  for (const id of ['a', 'b', 'c']) ledger.remember(id, 'fp', id);
  assert.equal(ledger.size, 3);
  ledger.remember('d', 'fp', 'd');
  assert.equal(ledger.size, 3, '上限就是上限，不无界增长');
  assert.equal(ledger.lookup('a', 'fp').kind, 'fresh', '最旧的 a 被丢掉了');
  assert.equal(ledger.lookup('b', 'fp').kind, 'replay');
  assert.equal(ledger.lookup('d', 'fp').kind, 'replay');
  assert.ok(LEDGER_MAX >= 100, '默认上限不该小到双击都防不住');
});

test('台账：两个实例互不影响（reference/ 与 attempts/ 各持一份）', () => {
  const first = new IdempotencyLedger(2);
  const second = new IdempotencyLedger(2);
  first.remember('op', 'fp', 'first');
  assert.equal(second.lookup('op', 'fp').kind, 'fresh');
  second.remember('op', 'fp', 'second');
  assert.equal(first.lookup('op', 'fp').response, 'first');
  assert.equal(second.lookup('op', 'fp').response, 'second');
});

/* ── 三、题型词表与必备字段 ───────────────────────────────────────────── */

test('题型词表就是目标态 §7.2 的四种，与 schema 的 enum 逐个相等', () => {
  assert.deepEqual([...QUESTION_KINDS], ['客观题', '预测验证', '开放题', '交付物']);
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'question.schema.json'), 'utf8'));
  assert.deepEqual(schema.properties.kind.enum, [...QUESTION_KINDS]);
  // 每种题型都有自己的字段表，且字段表里的 kind 与键一致
  for (const kind of QUESTION_KINDS) {
    assert.equal(QUESTION_KIND_SHAPES[kind].kind, kind);
    assert.ok(QUESTION_KIND_SHAPES[kind].required.length > 0, `${kind} 的必备字段不该为空`);
  }
});

test('推断：旧词表两种按字段认出来，两组字段同时出现返回 null（不猜）', () => {
  assert.equal(inferQuestionKind({ opts: ['a', 'b'], ans: 0, why: 'w' }), '客观题');
  assert.equal(inferQuestionKind({ ans: 0 }), '客观题');
  assert.equal(inferQuestionKind({ answer: 'a', criteria: 'c' }), '开放题');
  assert.equal(inferQuestionKind({ criteria: 'c' }), '开放题');
  assert.equal(inferQuestionKind({ opts: ['a'], answer: 'a' }), null, '两组同时出现：不猜');
  assert.equal(inferQuestionKind({ q: '只有题面' }), null, '推不出来就 null');
});

test('显式 kind：不在词表里报 unknown-kind，字段不对报 missing-field / ambiguous', () => {
  const unknown = questionKindProblem({ kind: '选择题', q: 'q' });
  assert.equal(unknown.code, 'unknown-kind');
  assert.match(unknown.message, /不在词表里/);
  assert.match(unknown.message, /客观题、预测验证、开放题、交付物/);

  const missing = questionKindProblem({ kind: '客观题', q: 'q', opts: ['a', 'b'] });
  assert.equal(missing.code, 'missing-field');
  assert.match(missing.message, /正确答案下标/);

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

/* ── 四、题库逐题检查（带真实行号）─────────────────────────────────────── */

test('checkPoolKinds：未知题型带题库文件与**真实行号**，合格题库零问题', () => {
  const raw = [
    '{',
    '  "锚点一": [',
    '    { "kind": "客观题", "q": "题", "opts": ["a", "b"], "ans": 0, "why": "w" },',
    '    { "kind": "选择题", "q": "题" }',
    '  ],',
    '  "锚点二": [',
    '    { "q": "旧题面", "answer": "a", "criteria": "c" }',
    '  ]',
    '}',
    '',
  ].join('\n');
  const pool = JSON.parse(raw);
  const issues = checkPoolKinds(pool, { poolFile: 'a.quiz.json', poolRaw: raw });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].file, 'a.quiz.json');
  assert.equal(issues[0].line, 4, '行号指向那道题的对象，不是锚点键');
  assert.equal(issues[0].code, 'unknown-kind');
  assert.equal(issues[0].anchor, '锚点一');
  assert.equal(issues[0].index, 1);

  // 没有原文时行号退化成 1（**退化成 1 而不是猜**）
  const noRaw = checkPoolKinds(pool, { poolFile: 'a.quiz.json' });
  assert.equal(noRaw[0].line, 1);

  // 干净题库（含旧写法）零问题
  assert.deepEqual(checkPoolKinds({ 锚点: [{ q: 'q', opts: ['a', 'b'], ans: 0, why: 'w' }] }, {}), []);
});

test('checkPoolKinds：值不是数组的键不在这里报（形状坏由 pool-shape 说）', () => {
  const issues = checkPoolKinds({ 锚点: { q: '不是数组' }, 空: [] }, { poolFile: 'a.quiz.json' });
  assert.deepEqual(issues, []);
});

/* ── 五、误解记录的字段定型 ───────────────────────────────────────────── */

test('新写法原样归一；词表就是规格 §5.4 那三个来源与三个状态', () => {
  assert.deepEqual([...MISCONCEPTION_SOURCES], ['问答面板', '讲解反馈', '实验课验收']);
  assert.deepEqual([...MISCONCEPTION_STATUSES], ['未处理', '已补练', '已消解']);
  assert.deepEqual(
    normalizeMisconception({ topic: '掩码', source: '问答面板', evidence: '提问原文', status: '已补练', at: '2026-09-24' }),
    { topic: '掩码', source: '问答面板', evidence: '提问原文', status: '已补练', at: '2026-09-24' },
  );
});

test('旧写法（date/question/misunderstanding/answer_summary）读得进，字段搬到新名字上', () => {
  const one = normalizeMisconception({
    date: '2026-09-24',
    node: 'net.ip',
    topic: '子网掩码的算法',
    question: '为什么网络地址是 .64？',
    misunderstanding: '把掩码当成按点切字符串',
    answer_summary: '掩码是按位与',
    follow_up: '在 lab 里跑一遍',
    importance: 'high',
  });
  assert.equal(one.topic, '子网掩码的算法');
  assert.equal(one.evidence, '为什么网络地址是 .64？', 'evidence 取提问原文（信息最多）');
  assert.equal(one.at, '2026-09-24', 'date → at');
  assert.equal(one.source, '讲解反馈', '旧记录没有来源，按讲解反馈算');
  assert.equal(one.status, '未处理', '旧记录没有处置状态，按未处理算');
  // 旧字段原样留着（界面还要显示），别在归一里丢掉
  assert.deepEqual(one.legacy, {
    date: '2026-09-24', node: 'net.ip', question: '为什么网络地址是 .64？',
    misunderstanding: '把掩码当成按点切字符串', answer_summary: '掩码是按位与',
    follow_up: '在 lab 里跑一遍', importance: 'high',
  });
});

test('evidence 的取值顺序：提问原文 → 误解描述 → 当时怎么解的', () => {
  assert.equal(normalizeMisconception({ topic: 't', misunderstanding: 'm', answer_summary: 'a' }).evidence, 'm');
  assert.equal(normalizeMisconception({ topic: 't', answer_summary: 'a' }).evidence, 'a');
  assert.equal(normalizeMisconception({ topic: 't' }).evidence, '');
});

test('没有 topic 的记录返回 null（不猜：编一个 topic 等于在档案里写假数据）', () => {
  for (const bad of [null, undefined, 'x', 42, [], {}, { topic: '' }, { topic: '   ' }]) {
    assert.equal(normalizeMisconception(bad), null, JSON.stringify(bad));
  }
  // 数组输入：能归一的留下，不能的丢掉
  assert.equal(normalizeMisconceptions([{ topic: 't' }, {}, null]).length, 1);
  assert.deepEqual(normalizeMisconceptions('不是数组'), []);
  assert.deepEqual(normalizeMisconceptions(null), []);
});

test('issues 说清「哪几个字段被搬走了」与缺什么，别让迁移静默发生', () => {
  const issues = misconceptionIssues({ topic: 't', date: '2026-09-24', question: 'q' }, 2);
  assert.equal(issues.length, 3);
  assert.match(issues[0], /第 3 条/);
  assert.match(issues[0], /date → at/);
  assert.match(issues[0], /question → evidence/);
  assert.match(issues[1], /缺 source/);
  assert.match(issues[2], /缺 status/);

  // 完整的新写法零提示
  assert.deepEqual(
    misconceptionIssues({ topic: 't', source: '问答面板', evidence: 'e', status: '未处理', at: '2026-09-24' }),
    [],
  );
  // 非对象不报（归一那边已经丢掉它了）
  assert.deepEqual(misconceptionIssues(null), []);
});
