/* StudyMate 原生工具 · **schema 子集**（`lib/tools/**`、`lib/tasks/**`、`lib/lab/**`）
   ────────────────────────────────────────────────────────────────────────
   为什么单独有这条套件：宿主的 `tools.register()` 只校验**输出** schema，参数 schema 它不查；
   而我们自己的 `defineStudyTool` 是零依赖实现，不做任何校验。于是「多写一个关键字」或
   「`type` 写成数组」在单测里全绿、在真宿主里**整批工具注册不上**——实测发生过一次：

     StudyMate：原生工具注册失败，总控只能退回旧路径。
     unsupported JSON schema: schema.properties.跑.oneOf[0].properties.退出码.type
     must be a single type string (type arrays are not supported)

   真 DSH 探针（`test_dsh_runtime.mjs`）没抓住它：那条探针只按名字查八个学习工具，而炸的是
   实验域与任务域的 schema；而且注册是逐工具挂 `ctx.effect` 的，一个工具炸不代表整批查不到。
   所以这里**不看名字、直接逐个走 schema**，把宿主那套子集在门禁里重述一遍。

   子集的唯一出处是宿主自己的报错文本（`dsh-tools` 的 `assertSupportedJsonSchema`）：
     type / oneOf / properties / required / additionalProperties / items / enum / const + 注解
   本套件零依赖（不 import 宿主的包），所以子集变了要跟着改这里——**改之前先去读宿主那条报错**。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeContext, loadTools } from './fixtures/tools.mjs';

const tools = await loadTools();
const tasks = await import('../../lib/tasks/index.ts');
const lab = await import('../../lib/lab/index.ts');

/** 注册点上全部工具的名字（三份名字表各自是自己目录里的那一份，不在这里手写第二遍）。 */
const ALL_TOOL_NAMES = [...tools.STUDY_TOOL_NAMES, ...tasks.TASK_TOOL_NAMES, ...lab.LAB_TOOL_NAMES];

/** 宿主认的关键字。注解只放行 description / title（其余一律当违规）。 */
const ASSERTION_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const ANNOTATION_KEYS = new Set(['description', 'title']);

/** 宿主认的单个类型字符串（`SCHEMA_TYPES`）。 */
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

/** 「本体」关键字：它们只能挂在一个声明了 `type` 或 `oneOf` 的节点上，也不能与 `oneOf` 并列。 */
const BODY_KEYS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];

/** 每个本体关键字只在这些 type 上成立（宿主逐对查的就是这张表）。 */
const KEY_TYPES = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: ['string', 'number', 'integer', 'boolean', 'null'],
  const: ['string', 'number', 'integer', 'boolean', 'null'],
};

/** 一个标量是否合某个 type（宿主的 `scalarMatches`：非有限数与 `-0` 都不算数）。 */
function scalarMatches(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0);
    case 'integer': return typeof value === 'number' && Number.isInteger(value) && !Object.is(value, -0);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

/**
 * 走一遍 schema，回报所有不合规的位置（路径 + 为什么）。
 *
 * 判据逐条对着宿主 `dsh-tools` 的 `assertSupportedJsonSchema` 抄——包括**它拒收的姿势**，
 * 不只是它认的关键字。这里漏掉一条，症状就是「门禁全绿、真宿主里整条预设注册不上」：
 * 真出过一次（`studymate_lesson_read` 的输出契约写成 `found: { const: true }`——有 `const`
 * 却没有 `type`，宿主报 `…found.const requires type or oneOf`，答疑会话**建都建不起来**，
 * 面板连输入框都没有）。别把宿主收得比这里严的那部分当成「写漏了」。
 * @param node 待检查的 schema 节点
 * @param at 当前路径（只用于报错）
 */
function violations(node, at = 'schema') {
  const found = [];
  if (node === undefined) return found; // 没有 output schema 的工具：不查
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    found.push(`${at} 必须是 schema 对象`);
    return found;
  }
  for (const [key, value] of Object.entries(node)) {
    if (ANNOTATION_KEYS.has(key)) {
      if (typeof value !== 'string') found.push(`${at}.${key} 必须是字符串`);
      continue;
    }
    if (!ASSERTION_KEYS.has(key)) found.push(`${at}.${key} 不是宿主认的关键字`);
  }

  const hasType = Object.hasOwn(node, 'type');
  const hasOneOf = Object.hasOwn(node, 'oneOf');
  if (hasType && hasOneOf) {
    found.push(`${at} 不能同时声明 type 与 oneOf`);
    return found;
  }
  if (!hasType && !hasOneOf) {
    for (const key of BODY_KEYS) if (Object.hasOwn(node, key)) found.push(`${at}.${key} 缺 type 或 oneOf`);
    return found;
  }
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) found.push(`${at}.oneOf 至少两支（恰好命中一支）`);
    else node.oneOf.forEach((branch, index) => found.push(...violations(branch, `${at}.oneOf[${index}]`)));
    for (const key of BODY_KEYS) if (Object.hasOwn(node, key)) found.push(`${at}.${key} 不能与 oneOf 并列`);
    return found;
  }

  // 类型数组（`['integer','null']`）是**最隐蔽**的一种：DSH 只接受单个类型字符串，
  // 可空要写成 `oneOf` 两支。实测就是它让整批工具注册不上。
  const type = node.type;
  if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
    found.push(`${at}.type 必须是 ${SCHEMA_TYPES.join('/')} 里的单个字符串（收到 ${JSON.stringify(type)}）`);
    return found;
  }
  for (const [key, types] of Object.entries(KEY_TYPES)) {
    if (Object.hasOwn(node, key) && !types.includes(type)) found.push(`${at}.${key} 不能挂在 type=${type} 上`);
  }

  if (type === 'object') {
    const properties = node.properties;
    if (properties !== undefined && (properties === null || typeof properties !== 'object' || Array.isArray(properties))) {
      found.push(`${at}.properties 必须是「名字 → schema」的对象`);
    } else if (properties !== undefined) {
      for (const [name, child] of Object.entries(properties)) found.push(...violations(child, `${at}.properties.${name}`));
    }
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
        found.push(`${at}.required 必须是字符串数组`);
      } else {
        for (const name of node.required) {
          if (!Object.hasOwn(properties ?? {}, name)) found.push(`${at}.required 点了不在 properties 里的「${name}」`);
        }
      }
    }
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      found.push(`${at}.additionalProperties 必须是布尔`);
    }
    return found;
  }
  if (type === 'array') {
    if (Object.hasOwn(node, 'items')) found.push(...violations(node.items, `${at}.items`));
    return found;
  }

  const hasEnum = Object.hasOwn(node, 'enum');
  const allowed = hasEnum ? node.enum : undefined;
  const enumOk = Array.isArray(allowed) && allowed.length > 0 && allowed.every((entry) => scalarMatches(type, entry));
  if (hasEnum && !enumOk) found.push(`${at}.enum 必须是合 type=${type} 的非空数组`);
  if (Object.hasOwn(node, 'const')) {
    if (!scalarMatches(type, node.const)) found.push(`${at}.const 要是 type=${type} 的取值（收到 ${JSON.stringify(node.const)}）`);
    else if (enumOk && !allowed.includes(node.const)) found.push(`${at}.const 得在 enum 里`);
  }
  return found;
}

test('注册点上每个工具的 parameters 与 output 都只用宿主认的 schema 子集', () => {
  const { ctx, definitions } = fakeContext();
  tools.registerStudyMate(ctx);
  // 不空转：注册点上该有几个工具就有几个（少一个说明注册路径断了，不是 schema 的锅）
  assert.deepEqual([...definitions.keys()].sort(), [...ALL_TOOL_NAMES].sort());
  for (const definition of definitions.values()) {
    assert.deepEqual(violations(definition.parameters), [], `${definition.name} 的参数 schema`);
    assert.deepEqual(violations(definition.output?.schema), [], `${definition.name} 的输出 schema`);
  }
});

test('每个工具的 parameters 都是对象根，且必填项写成宿主认的 required 数组', () => {
  const { ctx, definitions } = fakeContext();
  tools.registerStudyMate(ctx);
  for (const definition of definitions.values()) {
    const parameters = definition.parameters;
    assert.equal(parameters.type, 'object', `${definition.name} 的参数根必须是 object`);
    assert.equal(parameters.additionalProperties, false, `${definition.name} 的参数根要显式收口`);
    if (parameters.required !== undefined) {
      assert.ok(Array.isArray(parameters.required), `${definition.name} 的 required 必须是数组`);
      for (const name of parameters.required) {
        assert.ok(Object.hasOwn(parameters.properties ?? {}, name), `${definition.name} 的必填项 ${name} 没在 properties 里`);
      }
    }
  }
});

test('答疑预设的只读工具也只用宿主认的子集（它不在 registerStudyMate 里，别漏检）', async () => {
  // #104：`studymate_lesson_read` 只挂进答疑预设，所以上面那两条按注册点扫的断言看不到它。
  // 真宿主同样会拿 `assertSupportedJsonSchema` 查它的输出契约——一个多余关键字就整条预设注册不上。
  const { apply } = await import('../../lib/tools/qa-preset.ts');
  const { ctx, definitions } = fakeContext();
  // fakeContext 没有 restrict（那是宿主作用域上的成员）：补一个假的，走正常路径
  ctx.tools.restrict = () => () => {};
  apply(ctx);
  assert.deepEqual([...definitions.keys()], ['studymate_lesson_read']);
  const definition = definitions.get('studymate_lesson_read');
  assert.deepEqual(violations(definition.parameters), [], '参数 schema');
  assert.deepEqual(violations(definition.output?.schema), [], '输出 schema');
  assert.equal(definition.parameters.type, 'object');
  assert.equal(definition.parameters.additionalProperties, false);
});

test('子集检查自己不是空转：宿主不认的写法逐条报得出来', () => {
  // 这些全是**真出现过或真会被拒**的写法，一条不报就说明上面那个走查退化了。
  const bad = [
    [{ type: ['integer', 'null'] }, '类型数组'],
    [{ type: 'integer', minimum: 1 }, 'minimum'],
    [{ type: 'string', pattern: '^a$' }, 'pattern'],
    [{ type: 'string', format: 'date' }, 'format'],
    [{ $ref: '#/definitions/x' }, '$ref'],
    [{ anyOf: [{ type: 'string' }] }, 'anyOf'],
    [{ type: 'object', properties: { a: { type: 'string', maxLength: 3 } } }, '嵌套的 maxLength'],
    [{ oneOf: [{ type: ['string', 'null'] }] }, 'oneOf 分支里的类型数组'],
    // 下面这批是「有本体关键字、却没有 type / oneOf」那一类：真出过一次（答疑预设的输出契约），
    // 症状是预设在真宿主里整条注册不上。
    [{ const: true }, '只有 const 没有 type'],
    [{ enum: ['a', 'b'] }, '只有 enum 没有 type'],
    [{ properties: { a: { type: 'string' } } }, '只有 properties 没有 type'],
    [{ items: { type: 'string' } }, '只有 items 没有 type'],
    [{ type: 'object', oneOf: [{ type: 'string' }, { type: 'null' }] }, 'type 与 oneOf 同时声明'],
    [{ oneOf: [{ type: 'string' }] }, 'oneOf 只有一支'],
    [{ type: 'string', items: { type: 'string' } }, 'items 挂在 string 上'],
    [{ type: 'boolean', const: 'yes' }, 'const 与 type 对不上'],
    [{ type: 'object', properties: {}, required: ['a'] }, 'required 点了不存在的键'],
    [{ type: 'object', additionalProperties: 'no' }, 'additionalProperties 不是布尔'],
  ];
  for (const [schema, what] of bad) {
    assert.ok(violations(schema).length > 0, `${what} 应该被报出来，实际没报`);
  }
  // 反向：合法的写法不许误报——可空的两支 oneOf、以及修好之后的布尔常量（本轮真出过的那条）
  assert.deepEqual(violations({ oneOf: [{ type: 'integer' }, { type: 'null' }] }), []);
  assert.deepEqual(violations({ type: 'boolean', const: false }), []);
  assert.deepEqual(violations(undefined), [], '没有 output schema 的工具不该被报');
});
