/* StudyMate 原生工具 · **域边界与注册层**（`lib/tools/{domains,access,define,index,capability}.ts`）
   ────────────────────────────────────────────────────────────────────────
   issue #68 的验收有两条是「反证」性质的，这条套件就是它们的机器证据：

     · 故意让某个工具越权**读**一个未声明的域 → 必须抛（不是日志、不是文档约定）
     · 故意让某个工具**写**一个未声明的字段 → 必须抛

   反证之外还钉三件事：注册点上全部工具的**声明表**（谁读谁写，放宽一行就红）、
   `requires:['model']` 在无模型时返回 `{available:false, reason}` 且 **body 不跑**、
   以及「唯一注册点」`registerStudyMate` 真的把每个子系统都挂上了。
   #73 之后注册点上有两个子系统（学习数据九个 + 任务域五个），#77 加了实验域一个、
   #125 加了核验域一个，断言按各份名字表拼起来算。

   夹具（临时 HOME/工作区、假 ctx）在 `fixtures/tools.mjs`：那是夹具不是套件，
   所以放在 `fixtures/` 下——放 `scripts/tests/` 根下会被套件覆盖断言当成「没登记的套件」。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAccess, DomainViolationError, matchesPattern } from '../../lib/host/access.ts';
import { assertOutput, execute, fakeContext, loadTools, useHome } from './fixtures/tools.mjs';

const tools = await loadTools();
// #125 之后注册点上有四个子系统：学习数据的九个工具 + 任务域的五个 + 实验域的一个（#77）
// + 核验域的一个（#125）。名字表各自是自己目录里导出的那一份（不在这里手写第二遍），
// 所以「谁注册了什么」只有一处真相。
const tasks = await import('../../lib/tasks/index.ts');
const lab = await import('../../lib/lab/index.ts');
const reach = await import('../../lib/reach/index.ts');
// 注册顺序 = 学习面一张表（核验那条在表尾，注册点里也跟着排在 `registerExportTools` 之后）
// + 任务域 + 实验域，与 `registerStudyMate` 里那一串调用逐位对应。
const ALL_TOOL_NAMES = [...tools.STUDY_TOOL_NAMES, ...tasks.TASK_TOOL_NAMES, ...lab.LAB_TOOL_NAMES];

/* ── 一、注册点上全部工具的声明表（放宽一行就红） ─────────────────────── */

// 这张表是**唯一**一份「谁读谁写」的清单：改工具声明就必须改这里，评审看得见差异。
const DECLARATIONS = {
  studymate_workspace_context: {
    reads: ['workspace', 'memory', 'subjects', 'curriculum', 'progress', 'records'],
    writes: {},
  },
  studymate_validate_curriculum: {
    // #130：「资源清单」的覆盖率也在这一支（读大纲拿节点 id、读清单拿条目），所以多一个域。
    reads: ['workspace', 'curriculum', 'progress', 'subjects', 'resources'],
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
    // #129：门禁本身只读盘上快照；`resources` 是那条**旁路**——若 `deliver/` 里有
    // `RESOURCES.md`，就按节给条目数、域名分布与内容指纹（它不参与放行/阻断的判定）。
    reads: ['handoff', 'resources'],
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
  // #82：导出读的是「整份阅读端快照要读到的东西」（readLibrary 一份全读，逐个列出来是为了让
  // 「这个工具能碰什么」可读）；写域是导出产物的布局（lib/export/plan.ts 里那份清单）。
  studymate_export: {
    reads: ['workspace', 'memory', 'subjects', 'curriculum', 'progress', 'lessons', 'pool',
      'assets', 'records', 'reference', 'misconceptions'],
    writes: { export: ['index.html', 'data.js', 'host.js', 'boot.js', 'studymate-client.js', 'export.json', 'vendor/**', 'assets/**'] },
  },
  // #73 任务域：任务状态不是学习数据域（`lib/host/domains.ts` 里没有它），
  // 所以五个工具一个域都不读、一个字段都不写——它们碰的是插件自己的台账。
  studymate_task_status: { reads: [], writes: {} },
  studymate_task_wait: { reads: [], writes: {} },
  studymate_task_cancel: { reads: [], writes: {} },
  studymate_task_destroy: { reads: [], writes: {} },
  studymate_task_resume: { reads: [], writes: {} },
  // #77 实验域：命令从题库里那道交付物题来（读 pool），落脚点是 lab 目录（读 lab），
  // 事实写作答数据（写 attempts 的 `跑` 字段）。**不做判定**——所以这一个工具只写事实，
  // 不写任何「通过与否」的字段（表里那一行就是这条边界）。
  studymate_lab_run: {
    reads: ['pool', 'lab', 'attempts', 'workspace'],
    writes: { attempts: ['**'] },
  },
  // #125 核验域：读工作区（定位清单）与「资源清单」那一份文件；一个字段都不写——
  // 探过的结果进的是 `<DSH_HOME>` 下的缓存，那不是学习数据的域（见 lib/reach/index.ts 文件头）。
  studymate_verify_sources: {
    reads: ['workspace', 'resources'],
    writes: {},
  },
};

test('注册点上的工具一个不多一个不少：九个学习数据工具 + 五个任务工具 + 一个实验工具', () => {
  const ctx = fakeContext();
  tools.registerStudyMate(ctx.ctx);
  assert.deepEqual([...ctx.definitions.keys()], ALL_TOOL_NAMES);
  assert.equal(tools.STUDY_TOOL_NAMES.length, 9);
  assert.equal(tasks.TASK_TOOL_NAMES.length, 5);
  assert.equal(lab.LAB_TOOL_NAMES.length, 1);
  assert.equal(reach.REACH_TOOL_NAMES.length, 1);
  assert.deepEqual([...reach.REACH_TOOL_NAMES], [tools.STUDY_TOOL_NAMES[8]]);
  for (const name of ALL_TOOL_NAMES) {
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
  const toolEffects = ctx.effects.filter((label) => label.startsWith('studymate: studymate_'));
  assert.equal(toolEffects.length, ALL_TOOL_NAMES.length, '每个工具各挂一个 effect');
  for (const label of toolEffects) assert.match(label, /^studymate: studymate_/);
  // 工具之外的四条**子系统级** effect（按注册清单的顺序）：
  //   · #82 导出：任务类型在**加载时**登记（重开 DSH 之后 resume 要靠它按名字找回跑法），卸载时注销；
  //   · #73 任务服务：卸载时给销毁回执（请求取消活任务 + 落盘刷一遍）；
  //   · #74 文件监听：学习工作区一变就往通知总线上发一条；
  //   · #77 实验域：台账收尾（事实已经落盘，这一步是给「卸载也要有收尾」一个明确的落点）。
  // 夹具没有 inject，所以各家的**路由**都不在这份清单里（任务那条在 test_tasks_model.mjs 里验，
  // 监听那条在 test_watch_push.mjs / 真 DSH 探针里验，导出那条在 test_export_tool_task.mjs 里验，
  // 实验域那条在 test_lab_runner.mjs 与浏览器 QA 里验）。
  assert.deepEqual(ctx.effects.filter((label) => !label.startsWith('studymate: studymate_')),
    ['studymate: 导出任务类型（卸载时注销）', 'studymate: 任务服务（销毁回执）',
      'studymate: 学习工作区文件监听', 'studymate: 实验代跑台账（收尾落盘）']);
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
