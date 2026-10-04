/* StudyMate 原生工具 · **域边界与注册层**（`lib/tools/{domains,access,define,index,capability}.ts`）
   ────────────────────────────────────────────────────────────────────────
   issue #68 的验收有两条是「反证」性质的，这条套件就是它们的机器证据：

     · 故意让某个工具越权**读**一个未声明的域 → 必须抛（不是日志、不是文档约定）
     · 故意让某个工具**写**一个未声明的字段 → 必须抛

   反证之外还钉三件事：八个工具的**声明表**（谁读谁写，放宽一行就红）、
   `requires:['model']` 在无模型时返回 `{available:false, reason}` 且 **body 不跑**、
   以及「唯一注册点」`registerStudyMate` 真的注册了八个。

   夹具（临时 HOME/工作区、假 ctx）在 `fixtures/tools.mjs`：那是夹具不是套件，
   所以放在 `fixtures/` 下——放 `scripts/tests/` 根下会被套件覆盖断言当成「没登记的套件」。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAccess, DomainViolationError, matchesPattern } from '../../lib/tools/access.ts';
import { assertOutput, execute, fakeContext, loadTools, useHome } from './fixtures/tools.mjs';

const tools = await loadTools();

/* ── 一、八个工具的声明表（放宽一行就红） ──────────────────────────────── */

// 这张表是**唯一**一份「谁读谁写」的清单：改工具声明就必须改这里，评审看得见差异。
const DECLARATIONS = {
  studymate_workspace_context: {
    reads: ['workspace', 'memory', 'subjects', 'curriculum', 'progress', 'records'],
    writes: {},
  },
  studymate_validate_curriculum: {
    reads: ['workspace', 'curriculum', 'progress', 'subjects'],
    writes: {},
  },
  studymate_validate_lesson: {
    reads: ['workspace', 'curriculum', 'lessons', 'pool', 'assets'],
    writes: {},
  },
  studymate_validate_pool: {
    reads: ['workspace', 'assets'],
    writes: {},
  },
  studymate_validate_handoff: {
    reads: ['handoff'],
    writes: {},
  },
  studymate_renumber_lessons: {
    reads: ['workspace', 'curriculum', 'lessons'],
    writes: { lessons: ['lessons/*'] },
  },
  studymate_apply_empty_reasons: {
    reads: ['workspace', 'curriculum', 'lessons'],
    writes: { lessons: ['lessons/*#empty_reason'] },
  },
  studymate_export: {
    reads: [],
    writes: { export: ['**'] },
  },
};

test('八个工具都注册了，名字与 decisions §3 的下划线形态逐字一致', () => {
  const ctx = fakeContext();
  tools.registerStudyMate(ctx.ctx);
  assert.deepEqual([...ctx.definitions.keys()], [...tools.STUDY_TOOL_NAMES]);
  assert.equal(tools.STUDY_TOOL_NAMES.length, 8);
  for (const name of tools.STUDY_TOOL_NAMES) {
    // 模型 API 的 tools[].name 只接受 ^[a-zA-Z0-9_-]+$（含 DeepSeek 的兼容接口）
    assert.match(name, /^[a-z0-9_]+$/, `${name} 的名字会进模型 API 的 tools[].name`);
  }
});

test('每个工具的 reads/writes 与声明表逐字一致（未声明的域读不到、写不了）', () => {
  const ctx = fakeContext();
  tools.registerStudyMate(ctx.ctx);
  for (const [name, expected] of Object.entries(DECLARATIONS)) {
    const definition = ctx.definitions.get(name);
    assert.ok(definition, `没有注册 ${name}`);
    assert.deepEqual(definition.declaration.reads, expected.reads, `${name} 的 reads`);
    assert.deepEqual(definition.declaration.writes, expected.writes, `${name} 的 writes`);
  }
});

test('description 只有一句话：无换行、不超过常驻上下文的长度上限', () => {
  const ctx = fakeContext();
  tools.registerStudyMate(ctx.ctx);
  for (const [name, definition] of ctx.definitions) {
    assert.ok(!definition.description.includes('\n'), `${name} 的 description 里有换行`);
    assert.ok([...definition.description].length <= 120,
      `${name} 的 description 有 ${[...definition.description].length} 个码点——参数契约请进参考文档`);
  }
});

test('注册走 ctx.effect：每个工具都挂在可回收的副作用上', () => {
  const ctx = fakeContext();
  tools.registerStudyMate(ctx.ctx);
  assert.equal(ctx.effects.length, 8, '八个工具各挂一个 effect');
  for (const label of ctx.effects) assert.match(label, /^studymate: studymate_/);
});

/* ── 二、反证：越权读 / 越权写必须抛 ──────────────────────────────────── */

function probeTool(overrides) {
  return {
    name: 'probe_domain_guard',
    description: '测试用的探针工具。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [],
    },
    execute: async () => ({}),
    ...overrides,
  };
}

const runProbe = (definition) => definition.execute({}, { signal: new AbortController().signal });

test('反证一：声明里没有 progress 的工具去读 progress —— 抛 DomainViolationError', async () => {
  const ctx = fakeContext();
  const definition = tools.defineStudyTool(ctx.ctx, probeTool({
    reads: ['workspace'],
    execute: async (_args, run) => ({ leaked: run.access.read('progress') !== undefined }),
  }));
  await assert.rejects(() => runProbe(definition), (error) => {
    assert.ok(error instanceof DomainViolationError, `抛的是 ${error?.name}`);
    assert.equal(error.code, 'DOMAIN_VIOLATION');
    assert.match(error.message, /^\[DOMAIN_VIOLATION\]/);
    assert.match(error.message, /progress/);
    assert.match(error.message, /workspace/, '消息里要说清声明了什么');
    return true;
  });
});

test('反证二：只允许写 nodes/*/status 的工具去写 mastery —— 抛，且回调一次都没跑', async () => {
  const ctx = fakeContext();
  let mutated = false;
  const definition = tools.defineStudyTool(ctx.ctx, probeTool({
    reads: ['progress'],
    writes: { progress: ['nodes/*/status'] },
    execute: async (_args, run) => {
      run.access.write('progress', 'nodes/0/mastery', () => { mutated = true; });
      return { mutated };
    },
  }));
  await assert.rejects(() => runProbe(definition), (error) => {
    assert.ok(error instanceof DomainViolationError);
    assert.match(error.message, /nodes\/0\/mastery/);
    return true;
  });
  assert.equal(mutated, false, '越权时回调不许执行——guard 在写盘路径上');
});

test('反证三：整个域没声明、或域声明了但字段模式不匹配，写也抛', async () => {
  const ctx = fakeContext();
  const definition = tools.defineStudyTool(ctx.ctx, probeTool({
    reads: ['progress', 'lessons'],
    writes: { progress: ['nodes/*/status'] },
    execute: async (_args, run) => {
      const results = [];
      for (const [domain, field] of [['lessons', 'lessons/0001-var.md#empty_reason'], ['export', 'x']]) {
        try {
          run.access.write(domain, field, () => 'wrote');
          results.push(`${domain}:放行`);
        } catch (error) {
          results.push(`${domain}:${error.code}`);
        }
      }
      return { results };
    },
  }));
  const value = await runProbe(definition);
  assert.deepEqual(value.results, ['lessons:DOMAIN_VIOLATION', 'export:DOMAIN_VIOLATION']);
});

test('正向对照：声明过的字段照常放行（guard 不是「一律抛」）', async () => {
  const ctx = fakeContext();
  let wrote = '';
  const definition = tools.defineStudyTool(ctx.ctx, probeTool({
    reads: ['progress'],
    writes: { progress: ['nodes/*/status'] },
    execute: async (_args, run) => {
      const value = run.access.write('progress', 'nodes/1/status', () => { wrote = '学习中'; return 'ok'; });
      return { value, wrote };
    },
  }));
  assert.deepEqual(await runProbe(definition), { value: 'ok', wrote: '学习中' });
});

test('字段路径模式：`*` 不跨段、`**` 吃任意多段', () => {
  assert.equal(matchesPattern('nodes/*/status', 'nodes/0/status'), true);
  assert.equal(matchesPattern('nodes/*/status', 'nodes/0/mastery'), false);
  assert.equal(matchesPattern('nodes/*/status', 'nodes/0/inner/status'), false);
  assert.equal(matchesPattern('lessons/*#empty_reason', 'lessons/0001-var.md#empty_reason'), true);
  assert.equal(matchesPattern('lessons/*', 'lessons/0001-var.md'), true);
  assert.equal(matchesPattern('lessons/*', 'lessons/sub/0001-var.md'), false);
  assert.equal(matchesPattern('**', 'a/b/c'), true);
  assert.equal(matchesPattern('a/**', 'a'), true, '`**` 可以吃零段');
});

test('声明写错（不认识的域、空的字段模式）在**注册时**就抛', () => {
  const ctx = fakeContext();
  assert.throws(() => tools.defineStudyTool(ctx.ctx, probeTool({ reads: ['progres'] })),
    /不认识的域/);
  assert.throws(() => tools.defineStudyTool(ctx.ctx, probeTool({ writes: { progress: [] } })),
    /一个字段模式都没给/);
});

/* ── 三、模型能力是协商结果 ───────────────────────────────────────────── */

const MODEL_PROBE = probeTool({
  name: 'probe_requires_model',
  requires: ['model'],
  reads: [],
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ran'],
      properties: { ran: { type: 'boolean' } },
    },
    render: () => [],
  },
});

test('requires:["model"] 的工具在没有 llm 服务的上下文里不跑 body，返回 {available:false, reason}', async () => {
  const ctx = fakeContext();
  let ran = false;
  const definition = tools.defineStudyTool(ctx.ctx, {
    ...MODEL_PROBE,
    execute: async () => { ran = true; return { ran }; },
  });
  const value = await runProbe(definition);
  assert.equal(ran, false, '没有模型时 body 一行都不许跑');
  assert.equal(value.available, false);
  assert.equal(typeof value.reason, 'string');
  assert.ok(value.reason.length > 0);
  await assertOutput(assert, definition, value);
});

test('llm 在、但一个 provider 都没注册 —— 还是协商成不可用', async () => {
  const ctx = fakeContext({ llm: { listProviders: () => [] } });
  let ran = false;
  const definition = tools.defineStudyTool(ctx.ctx, {
    ...MODEL_PROBE,
    execute: async () => { ran = true; return { ran }; },
  });
  const value = await runProbe(definition);
  assert.equal(ran, false);
  assert.equal(value.available, false);
  assert.match(value.reason, /provider/);
});

test('有 provider 路由时 body 照常跑（能力探测不误报）', async () => {
  const ctx = fakeContext({ llm: { listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }] } });
  let ran = false;
  const definition = tools.defineStudyTool(ctx.ctx, {
    ...MODEL_PROBE,
    execute: async () => { ran = true; return { ran }; },
  });
  assert.deepEqual(await runProbe(definition), { ran: true });
  assert.equal(ran, true);
});

test('requires 工具的输出契约同时接受正常值与 {available:false}（oneOf 两支）', async () => {
  const ctx = fakeContext();
  const definition = tools.defineStudyTool(ctx.ctx, { ...MODEL_PROBE, execute: async () => ({ ran: true }) });
  assert.ok(Array.isArray(definition.output.schema.oneOf), 'requires 工具的输出契约要写成 oneOf');
  assert.equal(definition.output.schema.oneOf.length, 2);
  await assertOutput(assert, definition, { ran: true });
  await assertOutput(assert, definition, { available: false, reason: '没有模型' });
});

test('workspace.context 的 capabilities 里带着模型能力；没有工作区也照实说、不抛', async (t) => {
  useHome(t, { withWorkspace: false });
  const ctx = fakeContext();
  tools.registerContextTools(ctx.ctx);
  const value = await execute(ctx, 'studymate_workspace_context', {});
  assert.equal(value.workspace.ready, false);
  assert.equal(value.subjects.length, 0);
  assert.ok(value.notes.some((note) => /workspace/.test(note)), '要给出可操作的提示');
  assert.equal(value.capabilities.model.available, false);
  assert.match(value.capabilities.model.reason, /模型/);
});

/* ── 四、唯一注册点 ───────────────────────────────────────────────────── */

test('registerStudyMate 是唯一入口：各子系统各自导出 registerXxx', () => {
  for (const name of ['registerContextTools', 'registerValidatorTools', 'registerRewriteTools', 'registerExportTools']) {
    assert.equal(typeof tools[name], 'function', `lib/tools/index.ts 应导出 ${name}`);
  }
  const only = fakeContext();
  tools.registerContextTools(only.ctx);
  assert.deepEqual([...only.definitions.keys()], ['studymate_workspace_context']);
});

test('没有 ctx.tools 时 registerStudyMate 抛一句能照着做的错，而不是 TypeError', () => {
  assert.throws(() => tools.registerStudyMate({ effect: () => {} }), /ctx\.tools/);
});

test('createAccess 直接用时也要声明：没声明的域读不到数据，装载器一次都不跑', () => {
  let loaded = 0;
  const access = createAccess(
    { tool: 'unit', declaration: { reads: ['workspace'], writes: { workspace: ['x'] } } },
    () => { loaded += 1; return 'data'; },
  );
  assert.equal(access.read('workspace'), 'data');
  assert.throws(() => access.read('pool'), DomainViolationError);
  assert.equal(loaded, 1, '越权时装载器一次都不该被调到——数据根本没露出来');
});
