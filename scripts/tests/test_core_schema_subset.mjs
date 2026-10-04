/* JSON Schema 子集校验器（lib/core/schema.ts）的逐条断言。
   ────────────────────────────────────────────────────────────────────────
   这一层的承诺是「**枚举过什么就支持什么，没枚举的一律报出来**」。所以两件事都要钉：

     1. 六份真 schema 里出现的关键字，必须**全部**落在枚举表里（读盘枚举，不手抄）——
        以后谁往 schema 里加一个 `oneOf`，这里当场红，而不是静默放行；
     2. 每个已支持的关键字都有正向与反向用例，反向用例断言的是**逐条**问题。

   schema 与数据都是内联对象，唯一的读盘是「拿真 schema 做回归」。 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  ANNOTATION_KEYWORDS, ASSERTION_KEYWORDS, UNSUPPORTED_KEYWORDS, SUPPORTED_TYPES, SUPPORTED_FORMATS,
  deepEqual, pointerOf, validateAgainstSchema,
} from '../../lib/core/schema.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCHEMA_DIR = path.join(ROOT, 'schemas');

function readSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
}

/** 按 **schema 位置**（不是属性名位置）枚举一份 schema 用到的关键字。 */
function keywordsOf(schema, found = new Set()) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return found;
  for (const [keyword, value] of Object.entries(schema)) {
    found.add(keyword);
    if (keyword === 'properties') {
      for (const child of Object.values(value || {})) keywordsOf(child, found);
    } else if (keyword === 'items') {
      if (Array.isArray(value)) for (const child of value) keywordsOf(child, found);
      else keywordsOf(value, found);
    } else if (keyword === 'additionalProperties') {
      if (value && typeof value === 'object') keywordsOf(value, found);
    } else if (['oneOf', 'anyOf', 'allOf'].includes(keyword)) {
      for (const child of value || []) keywordsOf(child, found);
    }
  }
  return found;
}

function messagesOf(value, schema) {
  return validateAgainstSchema(value, schema).map((problem) => problem.message);
}

/* ── 一、枚举表与真 schema 对齐 ───────────────────────────────────────── */

test('六份 schema 用到的关键字全部在枚举表里（新增关键字会当场红）', () => {
  const declared = new Set([...ANNOTATION_KEYWORDS, ...ASSERTION_KEYWORDS]);
  const files = fs.readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.schema.json')).sort();
  assert.equal(files.length, 6, `schemas/ 下应当有六份 schema，实际 ${JSON.stringify(files)}`);
  const seen = new Set();
  for (const name of files) {
    for (const keyword of keywordsOf(readSchema(name))) {
      seen.add(keyword);
      assert.ok(
        declared.has(keyword),
        `${name} 用了 ${keyword}，但它既不在 ANNOTATION_KEYWORDS 也不在 ASSERTION_KEYWORDS 里：`
        + '要么实现它并登记，要么写进 UNSUPPORTED_KEYWORDS 说明替代方案',
      );
    }
  }
  // 反向：枚举表里声明的断言关键字，得真有 schema 在用（不然就是没人验过的死代码）
  for (const keyword of ASSERTION_KEYWORDS) {
    assert.ok(seen.has(keyword), `ASSERTION_KEYWORDS 里的 ${keyword} 在六份 schema 里一次都没出现`);
  }
  assert.deepEqual([...seen].filter((keyword) => !declared.has(keyword)), []);
});

test('两份表不重叠，且未支持清单不与已支持清单混在一起', () => {
  const annotation = new Set(ANNOTATION_KEYWORDS);
  const assertion = new Set(ASSERTION_KEYWORDS);
  const unsupported = new Set(UNSUPPORTED_KEYWORDS);
  for (const keyword of assertion) assert.equal(annotation.has(keyword), false, `${keyword} 同时出现在两张表里`);
  for (const keyword of unsupported) {
    assert.equal(assertion.has(keyword), false, `${keyword} 既说支持又说不支持`);
    assert.equal(annotation.has(keyword), false, `${keyword} 既说忽略又说不支持`);
  }
  assert.deepEqual([...SUPPORTED_TYPES], ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  assert.deepEqual([...SUPPORTED_FORMATS], ['date', 'date-time']);
});

/* ── 二、不支持的关键字必须吵，不许静默放行 ───────────────────────────── */

test('未实现的关键字报出来，且报的是关键字名本身', () => {
  const problems = validateAgainstSchema({ a: 1 }, { type: 'object', oneOf: [{ required: ['a'] }] });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].keyword, 'oneOf');
  assert.match(problems[0].message, /不实现的关键字 oneOf/);
  assert.match(problems[0].message, /不会假装支持/);
});

test('没见过的关键字也报出来', () => {
  const problems = validateAgainstSchema(1, { type: 'number', xMadeUp: true });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].keyword, 'xMadeUp');
  assert.match(problems[0].message, /不认识的关键字 xMadeUp/);
});

test('布尔 schema 与元组式 items 都有明确报错与替代方案', () => {
  const booleanSchema = validateAgainstSchema('x', false);
  assert.equal(booleanSchema[0].keyword, 'schema');
  assert.match(booleanSchema[0].message, /布尔 schema/);

  const tuple = validateAgainstSchema([1, 'a'], { type: 'array', items: [{ type: 'number' }, { type: 'string' }] });
  assert.equal(tuple.length, 1);
  assert.equal(tuple[0].keyword, 'items');
  assert.match(tuple[0].message, /元组形式/);
});

test('注解关键字被忽略，不产生问题', () => {
  assert.deepEqual(validateAgainstSchema('x', {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'T',
    description: 'D',
    type: 'string',
  }), []);
});

/* ── 三、逐个断言关键字 ───────────────────────────────────────────────── */

test('type：单值、数组形式、以及不认识的类型名', () => {
  assert.deepEqual(messagesOf('x', { type: 'string' }), []);
  assert.deepEqual(messagesOf(1, { type: 'string' }), ['类型应为 ["string"]，实际是 integer']);
  assert.deepEqual(messagesOf(null, { type: ['string', 'null'] }), []);
  assert.deepEqual(messagesOf(undefined, { type: ['string', 'null'] }), ['类型应为 ["string","null"]，实际是 undefined']);
  assert.deepEqual(messagesOf([], { type: 'object' }), ['类型应为 ["object"]，实际是 array']);
  assert.deepEqual(messagesOf(1.5, { type: 'integer' }), ['类型应为 ["integer"]，实际是 number']);
  assert.deepEqual(messagesOf(1.0, { type: 'integer' }), []);
  assert.deepEqual(messagesOf(true, { type: 'boolean' }), []);
  const unknown = validateAgainstSchema(1, { type: 'quantity' });
  assert.equal(unknown.length, 1);
  assert.match(unknown[0].message, /不认识的类型名 \["quantity"\]/);
});

test('类型不对时不再往下查长度/范围，避免一串噪声', () => {
  assert.deepEqual(messagesOf(3, { type: 'string', minLength: 5, pattern: '^a' }), ['类型应为 ["string"]，实际是 integer']);
});

test('required：缺一条报一条，路径带上缺的那个键', () => {
  const problems = validateAgainstSchema({ a: 1 }, { type: 'object', required: ['a', 'b', 'c'] });
  assert.equal(problems.length, 2);
  assert.deepEqual(problems.map((problem) => problem.path), [['b'], ['c']]);
  assert.deepEqual(problems.map((problem) => problem.message), ['缺少必填字段 b', '缺少必填字段 c']);
});

test('additionalProperties：false 挡额外键，对象 schema 逐个查', () => {
  assert.deepEqual(
    messagesOf({ a: 1, b: 2 }, { type: 'object', properties: { a: {} }, additionalProperties: false }),
    ['不允许额外字段 ["b"]'],
  );
  assert.deepEqual(
    messagesOf({ a: 1, b: 2 }, { type: 'object', properties: { a: {} }, additionalProperties: { type: 'string' } }),
    ['类型应为 ["string"]，实际是 integer'],
  );
  assert.deepEqual(messagesOf({ a: 1, b: 2 }, { type: 'object', properties: { a: {} } }), []);
});

test('properties 递归，路径能指到嵌套的那一项', () => {
  const problems = validateAgainstSchema(
    { nodes: [{ id: 'a' }, { id: 3 }] },
    { type: 'object', properties: { nodes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } } },
  );
  assert.equal(problems.length, 1);
  assert.deepEqual(problems[0].path, ['nodes', 1, 'id']);
  assert.equal(pointerOf(problems[0].path), '/nodes/1/id');
});

test('enum / const 按深比较，不受键序影响', () => {
  assert.deepEqual(validateAgainstSchema('b', { enum: ['a', 'b'] }), []);
  const bad = validateAgainstSchema('c', { enum: ['a', 'b'] });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].keyword, 'enum');
  assert.match(bad[0].message, /不在允许值 \["a","b"\] 中/);

  const schema = { const: { x: 1, y: 2 } };
  assert.deepEqual(validateAgainstSchema({ y: 2, x: 1 }, schema), []);
  assert.equal(validateAgainstSchema({ x: 1 }, schema).length, 1);
  assert.equal(validateAgainstSchema({ x: 1, y: 2, z: 3 }, schema).length, 1);
});

test('deepEqual 的边界', () => {
  assert.equal(deepEqual([1, [2, { a: 3 }]], [1, [2, { a: 3 }]]), true);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(deepEqual(null, undefined), false);
  assert.equal(deepEqual('1', 1), false);
});

test('pattern 用 search 语义；非法正则报出来而不是抛异常', () => {
  assert.deepEqual(messagesOf('abc', { type: 'string', pattern: 'b' }), []);
  assert.deepEqual(messagesOf('abc', { type: 'string', pattern: '^b' }), ['不匹配要求的格式 ^b']);
  const broken = validateAgainstSchema('abc', { type: 'string', pattern: '[' });
  assert.equal(broken.length, 1);
  assert.match(broken[0].message, /不是合法正则/);
});

test('minLength / maxLength 数码点，不数 UTF-16 码元', () => {
  // '👍' 是 1 个码点、2 个 UTF-16 码元：用 .length 会把它当成两个字符
  assert.deepEqual(messagesOf('👍', { type: 'string', minLength: 1, maxLength: 1 }), []);
  assert.deepEqual(messagesOf('👍', { type: 'string', maxLength: 1, minLength: 2 }), ['至少 2 个字符，实际 1 个']);
  assert.deepEqual(messagesOf('ab', { type: 'string', maxLength: 1 }), ['最多 1 个字符，实际 2 个']);
});

test('minimum / maximum 只对数字生效', () => {
  assert.deepEqual(messagesOf(0.5, { type: 'number', minimum: 0, maximum: 1 }), []);
  assert.deepEqual(messagesOf(-1, { type: 'number', minimum: 0 }), ['不能小于 0，实际 -1']);
  assert.deepEqual(messagesOf(2, { type: 'number', maximum: 1 }), ['不能大于 1，实际 2']);
  assert.deepEqual(messagesOf('x', { type: 'string', minimum: 0 }), []);
});

test('minItems', () => {
  assert.deepEqual(messagesOf([1], { type: 'array', minItems: 1 }), []);
  assert.deepEqual(messagesOf([], { type: 'array', minItems: 1 }), ['至少 1 项，实际 0 项']);
});

test('format：date 与 date-time 按断言处理，且要求日期真实存在', () => {
  assert.deepEqual(messagesOf('2026-09-24', { type: 'string', format: 'date' }), []);
  assert.deepEqual(messagesOf('2026-02-30', { type: 'string', format: 'date' }), ['2026-02-30 不是真实存在的日期']);
  assert.deepEqual(messagesOf('2024-02-29', { type: 'string', format: 'date' }), []);
  assert.deepEqual(messagesOf('2026-9-4', { type: 'string', format: 'date' }), ['不是 YYYY-MM-DD 形状的日期']);

  assert.deepEqual(messagesOf('2026-09-24T21:05:00+08:00', { type: 'string', format: 'date-time' }), []);
  assert.deepEqual(messagesOf('2026-09-24T21:05:00Z', { type: 'string', format: 'date-time' }), []);
  assert.deepEqual(messagesOf('2026-09-24', { type: 'string', format: 'date-time' }), ['不是 RFC 3339 形状的 date-time（例：2026-09-24T21:05:00+08:00）']);
  assert.deepEqual(messagesOf('2026-09-24T25:05:00+08:00', { type: 'string', format: 'date-time' }), ['2026-09-24T25:05:00+08:00 的时刻越界']);

  const unknown = validateAgainstSchema('x', { type: 'string', format: 'email' });
  assert.equal(unknown.length, 1);
  assert.match(unknown[0].message, /format "email" 不在本子集里/);
});

test('pointerOf 转义 ~ 与 /', () => {
  assert.equal(pointerOf([]), '');
  assert.equal(pointerOf(['a', 0, 'b']), '/a/0/b');
  assert.equal(pointerOf(['a/b', 'c~d']), '/a~1b/c~0d');
});

/* ── 四、拿六份真 schema 做一次回归 ────────────────────────────────────── */

test('真 schema 对好数据零问题、对坏数据逐条报（六份都跑一遍）', () => {
  const samples = {
    'curriculum.schema.json': [
      { nodes: [{ id: 'a', title: 'A', kind: '概念', objective: 'o', prerequisites: [], status: '未开始' }], edges: [] },
      { nodes: [{ id: 'A', title: 'A', kind: '概念', objective: 'o', prerequisites: [], status: '未开始' }], edges: [] },
    ],
    'progress.schema.json': [
      { updated_at: '2026-09-24T21:05:00+08:00', nodes: { a: { status: '学习中', mastery: 0.3 } }, misconceptions: [], project: { current: '' } },
      { updated_at: '2026-09-24', nodes: {}, misconceptions: [], project: {} },
    ],
    'subject.schema.json': [
      { name: '线性代数', slug: 'linear-algebra', goal: 'g', created_at: '2026-09-18', status: '进行中' },
      { name: '线性代数', slug: 'Linear_Algebra', goal: 'g', created_at: '2026/09/18', status: '在学' },
    ],
    'agent-handoff.schema.json': [
      {
        schema_version: 1, role: 'curriculum-designer', subject: 'linear-algebra', node_id: null,
        status: 'succeeded', outputs: [{ path: 'curriculum.yaml', kind: 'file' }], checks: [], gaps: [],
      },
      {
        schema_version: 2, role: 'teacher', subject: 'linear-algebra', node_id: null,
        status: 'done', outputs: [{ path: 'curriculum.yaml', kind: 'file', extra: 1 }], checks: [], gaps: [],
      },
    ],
    'assessment.schema.json': [
      { node: 'a', date: '2026-09-24', questions: [{ q: 'q', verdict: '通过' }], verdict: '通过' },
      { node: 'a', date: '2026-09-24', questions: [], verdict: '勉强' },
    ],
    'session-summary.schema.json': [
      { date: '2026-09-24', subject: 'a', session_goal: 'g', learned: [], next_step: 'n', weaknesses: [] },
      { date: '2026-09-24', subject: 'a', session_goal: 'g', learned: [], next_step: 'n' },
    ],
  };
  for (const [name, [good, bad]] of Object.entries(samples)) {
    const schema = readSchema(name);
    assert.deepEqual(validateAgainstSchema(good, schema), [], `${name} 的好数据不该有问题`);
    const problems = validateAgainstSchema(bad, schema);
    assert.ok(problems.length > 0, `${name} 的坏数据应当被拦下`);
    for (const problem of problems) {
      assert.equal(typeof problem.message, 'string');
      assert.ok(problem.message.length > 0);
    }
  }
});

test('真 schema 缺文件或有 null 时不会抛异常', () => {
  for (const name of fs.readdirSync(SCHEMA_DIR).filter((file) => file.endsWith('.json'))) {
    const schema = readSchema(name);
    assert.doesNotThrow(() => validateAgainstSchema(null, schema), name);
    assert.doesNotThrow(() => validateAgainstSchema(undefined, schema), name);
    assert.doesNotThrow(() => validateAgainstSchema([], schema), name);
  }
});
