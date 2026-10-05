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

/**
 * 走一遍 schema，回报所有不合规的位置（路径 + 为什么）。
 * @param node 待检查的 schema 节点
 * @param at 当前路径（只用于报错）
 */
function violations(node, at = 'schema') {
  const found = [];
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) return found;
  for (const [key, value] of Object.entries(node)) {
    if (ANNOTATION_KEYS.has(key)) continue;
    if (!ASSERTION_KEYS.has(key)) {
      found.push(`${at}.${key} 不是宿主认的关键字`);
      continue;
    }
    if (key === 'type') {
      // 类型数组（`['integer','null']`）是**最隐蔽**的一种：DSH 只接受单个类型字符串，
      // 可空要写成 `oneOf` 两支。实测就是它让整批工具注册不上。
      if (typeof value !== 'string') found.push(`${at}.type 必须是单个类型字符串（收到 ${JSON.stringify(value)}）`);
      continue;
    }
    if (key === 'oneOf') {
      if (!Array.isArray(value) || value.length === 0) found.push(`${at}.oneOf 必须是非空数组`);
      else value.forEach((branch, index) => found.push(...violations(branch, `${at}.oneOf[${index}]`)));
      continue;
    }
    if (key === 'properties') {
      for (const [name, child] of Object.entries(value ?? {})) found.push(...violations(child, `${at}.properties.${name}`));
      continue;
    }
    if (key === 'items') {
      found.push(...violations(value, `${at}.items`));
      continue;
    }
    // required / additionalProperties / enum / const：形状由下面的断言兜，这里不递归。
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
  ];
  for (const [schema, what] of bad) {
    assert.ok(violations(schema).length > 0, `${what} 应该被报出来，实际没报`);
  }
  // 反向：合法的可空写法（oneOf 两支）不许误报
  assert.deepEqual(violations({ oneOf: [{ type: 'integer' }, { type: 'null' }] }), []);
});
