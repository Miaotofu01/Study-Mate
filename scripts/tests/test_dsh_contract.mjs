/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 宿主契约守门（按需套件，`npm run test:dsh-contract`）

   为什么单独有这一份：仓库里那条**默认门禁**里的 schema 检查
   （`scripts/tests/test_tools_schema_subset.mjs`）把宿主的规则**手抄**成了一张关键字清单。
   手抄就会漂——2026-10-07 真出过一次：`studymate_lesson_read` 的输出契约写成
   `found: { const: true }`（有 `const` 没 `type`），宿主 `assertSupportedJsonSchema`
   当场拒收，那条预设行整行挂不上，答疑会话**建都建不起来**；而当时那道手抄的检查
   **绿着通过**——它抄漏了「放置规则」（`const` 必须配 `type` 或 `oneOf`）。

   这里的做法换一层：**不抄规则，直接拿宿主自己的校验器**扫我们注册点上每一个工具。
   它要一份真宿主安装（`STUDYMATE_DSH_PACKAGE`，与 `test:dsh` 同一个环境变量），所以
   不进默认门禁、也不进 CI（CI 没有宿主包）。没设这个变量时整份跳过。

   三件事，缺一不可：

     1. **扫**：`registerStudyMate` 的十五个原生工具 + 答疑预设那条插件行注册的只读工具，
        逐个把 `parameters` 与 `output.schema` 交给宿主的 `assertSupportedJsonSchema`；
     2. **反证**：同一个校验器对一份已知不合规的 schema 必须**报错**——否则这条套件自己
        就是个空转（第 1 条绿了也说明不了任何事）；
     3. **对照参考实现**：程序化建会话的字段清单（`agents.create` 的 `sessionId / meta /
        agentOptions / setup`）住在宿主的 `createWebhookSession` 里。这里读那份源码，断言
        它**仍然**这么写——宿主改了契约，这里先红，然后再去改我们的调用。同一份字段清单在
        `test_host_ask_session.mjs`（默认门禁）里按「我们递出去的键」钉了一遍。
   ───────────────────────────────────────────────────────────────────────── */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { fakeContext, loadTools } from './fixtures/tools.mjs';

/** 与 `test:dsh`（`test_dsh_runtime.mjs`）同一个环境变量：已安装的 DSH 包目录（只读）。 */
const runtime = process.env.STUDYMATE_DSH_PACKAGE;

/** 参考实现里那次 `agents.create` 的字段（`createWebhookSession`）。我们的调用必须逐项带上。 */
export const REFERENCE_CREATE_KEYS = ['sessionId', 'meta', 'agentOptions', 'setup'];

/**
 * 在已安装的宿主包里找一个模块。
 *
 * npm 与 pnpm 两种铺法都试：`<pkg>/node_modules/@deepseek-ai/<x>` 与
 * `<pkg>/../<x>`（后者是 `STUDYMATE_DSH_PACKAGE` 直接指到 `@deepseek-ai` 那一层时）。
 * 找不到返回 null——调用方据此**跳过并说明**，不把它当成失败（旧宿主可能没有这个模块）。
 */
function hostModule(pkg, relative) {
  for (const candidate of [
    path.join(pkg, 'node_modules', '@deepseek-ai', relative),
    path.join(pkg, '..', relative),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 没给真宿主就**明确跳过**——不许空跑成 pass。

    `t.skip` 之前这里写的是裸 `return;`：`node:test` 把「回调正常跑完」记成通过，于是没设
    `STUDYMATE_DSH_PACKAGE` 时四条里有一条显示跳过、另外三条显示通过，而那三条一条断言都没做。
    「这一条到底验过没有」因此不可知——`test_dsh_plugin_cli.mjs` 就是同一类问题在载入阶段
    静默死了几周的。判据与措辞一处定义，别处只给指针。 */
function requireRuntime(t) {
  if (runtime === undefined || runtime === '') {
    t.skip('未设置 STUDYMATE_DSH_PACKAGE：跳过真宿主契约检查（见 scripts/tests/README.md）');
    return false;
  }
  return true;
}

test('宿主契约：没给 STUDYMATE_DSH_PACKAGE 就跳过（与 test:dsh 同一口径）', t => {
  if (!requireRuntime(t)) return;
  assert.ok(fs.existsSync(runtime), `STUDYMATE_DSH_PACKAGE 指向的目录不存在：${runtime}`);
});

/** 注册点上全部工具的定义：十五个原生工具 + 答疑预设那条行注册的只读工具。 */
async function allDefinitions() {
  const { registerStudyMate } = await loadTools();
  const learning = fakeContext();
  registerStudyMate(learning.ctx);

  const preset = await import('../../lib/tools/qa-preset.ts');
  const qa = fakeContext();
  // 预设作用域里那条 restriction 在这份套件里没有受众：`deny` 的名单校验会走真宿主逻辑，
  // 这里只要它别挡住工具注册。
  qa.ctx.tools.restrict = () => () => {};
  preset.apply(qa.ctx);

  return [
    ...[...learning.definitions.values()].map(definition => ({ where: '学习面', definition })),
    ...[...qa.definitions.values()].map(definition => ({ where: '答疑面', definition })),
  ];
}

test('宿主契约：注册点上每个工具的 schema 都过宿主自己的校验器', async t => {
  if (!requireRuntime(t)) return;

  const modulePath = hostModule(runtime, path.join('dsh-tools', 'lib', 'types', 'json-schema.js'));
  if (modulePath === null) {
    t.skip(`这份宿主安装里找不到 dsh-tools 的 json-schema 模块（${runtime}）：跳过`);
    return;
  }
  const { assertSupportedJsonSchema } = await import(pathToFileURL(modulePath).href);
  assert.equal(typeof assertSupportedJsonSchema, 'function', '宿主校验器没导出 assertSupportedJsonSchema，套件要跟着改');

  const definitions = await allDefinitions();
  assert.ok(definitions.length >= 15, `注册点上应该至少有 15 个工具，实际 ${definitions.length} 个`);

  const problems = [];
  for (const { where, definition } of definitions) {
    for (const [what, schema] of [
      ['parameters', definition.parameters],
      ['output.schema', definition.output?.schema],
    ]) {
      if (schema === undefined) continue;
      try {
        assertSupportedJsonSchema(schema);
      } catch (error) {
        problems.push(`${where} · ${definition.name} · ${what}\n    ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  assert.deepEqual(problems, [], `宿主不认这些 schema：\n${problems.join('\n')}`);
});

test('宿主契约：反证——宿主校验器对已知不合规的 schema 必须报错', async t => {
  if (!requireRuntime(t)) return;

  const modulePath = hostModule(runtime, path.join('dsh-tools', 'lib', 'types', 'json-schema.js'));
  if (modulePath === null) {
    t.skip('这份宿主安装里找不到 dsh-tools 的 json-schema 模块：跳过');
    return;
  }
  const { assertSupportedJsonSchema } = await import(pathToFileURL(modulePath).href);

  // 就是 2026-10-07 那次事故的原形状：有 `const` 没 `type`。
  const knownBad = {
    type: 'object',
    additionalProperties: false,
    required: ['found'],
    properties: { found: { const: true } },
  };
  assert.throws(() => assertSupportedJsonSchema(knownBad),
    /requires type or oneOf/, '这条校验器认了这个 schema：那第 2 条扫出来的绿不算数');

  // 同一个校验器对合规形状必须放行（否则它只会拒绝一切，反证也说明不了什么）
  assertSupportedJsonSchema({
    type: 'object',
    additionalProperties: false,
    required: ['found'],
    properties: { found: { type: 'boolean', const: true } },
  });
});

test('宿主契约：参考实现的 createWebhookSession 仍然带着那四个字段', async t => {
  if (!requireRuntime(t)) return;

  const modulePath = hostModule(runtime, path.join('dsh-webhook', 'lib', 'types', 'session.js'));
  if (modulePath === null) {
    t.skip(`这份宿主安装里找不到 dsh-webhook 的 session.js（${runtime}）：跳过`);
    return;
  }
  const source = fs.readFileSync(modulePath, 'utf8');

  // 只认「那次调用块里出现过这几个键」。宿主改了契约（改名、删字段），这里先红，
  // 然后再去改 lib/ask/session.ts 的调用并重跑 test_host_ask_session.mjs。
  const missing = REFERENCE_CREATE_KEYS.filter(key => !source.includes(key));
  assert.deepEqual(missing, [],
    `宿主参考调用里不再出现这些字段：${missing.join('、')}——`
    + '先读那份源码确认新契约，再改 lib/ask/session.ts 与 test_host_ask_session.mjs');
  assert.ok(source.includes('meta') && source.includes('agentPreset'),
    '参考调用里 meta.agentPreset 不见了：按预设建会话的契约可能已经换了写法');
});
