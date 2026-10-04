/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— 工具定义的**唯一造法**

   为什么要自己造而不是用宿主的 `defineTool`：本插件是**零依赖**的（`bin/dsh-plugin.ts`
   顶部的口径：不依赖宿主的类型包，按用到的成员描述形状），而 `@deepseek-ai/dsh-tools`
   在 profile 的 node_modules 里按 pnpm 的严格布局不一定解析得到。`defineTool` 做的事
   （把作者侧 DSL 编译成 JSON Schema + 调参数校验）这里各写一遍，**schema 直接写 JSON
   Schema**——就是宿主 `assertSupportedJsonSchema` 认的那个子集（type / oneOf / properties /
   required / additionalProperties / items / enum / const + 注解）。

   这一层把 #68 的三条约束焊在定义里，每个工具都绕不过去：

     1. **越权即抛**：`reads` / `writes` 进 `createAccess`，body 只能通过 `run.access` 碰数据。
     2. **模型能力是协商结果**：`requires: ['model']` 的工具在无模型时**不跑 body**，
        直接返回 `{available:false, reason}`；输出契约用 `oneOf` 把这个形状写进去。
     3. **参数契约不进 system prompt**：`description` 只有一句话，注册时**当场**拦下带换行或
        超过 `DESCRIPTION_LIMIT` 个码点的说明——参数表、返回形状、边界都不许写在这里，
        它们由技能按需加载的参考文档承载（#80 接）。
   ───────────────────────────────────────────────────────────────────────── */

import { createAccess, assertDeclaration } from './access.ts';
import type { Declaration, DomainAccess } from './access.ts';
import { unmetRequirement } from './capability.ts';
import type { Requirement, ServiceReader } from './capability.ts';
import { createWorkspaceVault } from './vault.ts';
import type { Vault } from './vault.ts';
import type { Domain } from './domains.ts';
import { validateAgainstSchema } from '../core/schema.ts';

/** 模型常驻上下文里能容忍的工具说明长度（码点）。超了就是往描述里塞契约了。 */
export const DESCRIPTION_LIMIT = 120;

export type JsonSchema = Record<string, unknown>;

export interface ContentBlock {
  type: 'text';
  text: string;
}

/** 工具**外露**的声明：读哪些域、写哪些字段、要哪些能力。 */
export interface StudyDeclaration {
  reads: readonly Domain[];
  writes: Readonly<Partial<Record<Domain, readonly string[]>>>;
  requires: readonly Requirement[];
}

/** 交给 `ctx.tools.register` 的定义。字段与宿主 `ToolDefinition` 的**用到的部分**对齐。 */
export interface ToolDefinitionLike {
  name: string;
  description: string;
  parameters: JsonSchema;
  output: { schema: JsonSchema; render: (args: unknown, value: JsonValue) => ContentBlock[] };
  execute: (args: unknown, exec: ToolRunLike) => Promise<unknown>;
  /**
   * 域声明**挂在定义上**，不藏在闭包里。
   *
   * 理由：issue #68 的验收是「声明之外的读写必须抛」，那么「声明是什么」就得是**可读的**
   * ——测试按它断言、架构边界检查（#69）按它查表、报告按它列表。宿主只投影
   * name/description/parameters 给模型，多这一个字段不影响任何宿主行为。
   */
  declaration: StudyDeclaration;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 宿主交给 body 的执行上下文：这里只用 `signal`（协作响应取消）。 */
export interface ToolRunLike {
  signal?: AbortSignal;
}

/** body 拿到的东西：**唯一的**数据入口（`access`）与工作区读法。 */
export interface StudyRun {
  access: DomainAccess;
  vault: Vault;
  signal: AbortSignal | undefined;
}

export interface StudyToolSpec {
  name: string;
  /** **一句话**。别在这里写参数表、返回形状、边界——那是参考文档的事。 */
  description: string;
  /** 参数 JSON Schema（隐式对象根请显式写 `type:'object'` + `properties`）。 */
  parameters: JsonSchema;
  output: { schema: JsonSchema; render: (args: any, value: any) => ContentBlock[] };
  reads?: readonly Domain[];
  writes?: Readonly<Partial<Record<Domain, readonly string[]>>>;
  requires?: readonly Requirement[];
  execute: (args: any, run: StudyRun) => Promise<unknown>;
}

/** 无模型时的协商形状。与工具自己的输出用 `oneOf` 拼在一起。 */
export const UNAVAILABLE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    available: { type: 'boolean', const: false },
    reason: { type: 'string' },
  },
  required: ['available', 'reason'],
};

function isUnavailable(value: unknown): value is { available: false; reason: string } {
  return Boolean(value) && typeof value === 'object'
    && (value as { available?: unknown }).available === false
    && typeof (value as { reason?: unknown }).reason === 'string';
}

function assertDescription(name: string, description: string): void {
  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error(`工具「${name}」没有一句话说明——description 是模型唯一常驻看到的东西`);
  }
  if (description.includes('\n')) {
    throw new Error(`工具「${name}」的 description 里有换行：参数契约不进 system prompt，`
      + '详细契约交给技能按需加载的参考文档');
  }
  if ([...description].length > DESCRIPTION_LIMIT) {
    throw new Error(`工具「${name}」的 description 有 ${[...description].length} 个码点`
      + `（上限 ${DESCRIPTION_LIMIT}）：常驻上下文里只有一句话，参数表请写进参考文档`);
  }
}

/** 参数校验：用纯函数域那份 JSON Schema 子集校验器（#67），不引第二个实现。 */
function assertArgs(spec: StudyToolSpec, args: unknown): void {
  const problems = validateAgainstSchema(args, spec.parameters);
  if (problems.length === 0) return;
  const shown = problems.slice(0, 5).map((problem) => problem.message).join('；');
  throw new Error(`工具「${spec.name}」的参数不合法：${shown}`
    + `${problems.length > 5 ? `（共 ${problems.length} 条）` : ''}`);
}

/**
 * 造一个工具定义。`ctx` 只在执行时用来探能力，所以注册期不碰任何服务。
 */
export function defineStudyTool(ctx: ServiceReader, spec: StudyToolSpec): ToolDefinitionLike {
  assertDescription(spec.name, spec.description);
  const declaration: Declaration = { reads: spec.reads ?? [], writes: spec.writes ?? {} };
  assertDeclaration(spec.name, declaration);
  const requires = spec.requires ?? [];
  if (requires.length > 0) {
    // 声明了 requires 就必须让 `{available:false, reason}` 能过输出契约
    spec = {
      ...spec,
      output: {
        schema: { oneOf: [UNAVAILABLE_SCHEMA, spec.output.schema] },
        render: (args, value) => (isUnavailable(value)
          ? [{
            type: 'text',
            text: `这个工具这次没跑：${value.reason}。这不是失败——别的工具照常可用，`
              + '阅读端仍能读、能导出。',
          }]
          : spec.output.render(args, value)),
      },
    };
  }

  const execute = async (rawArgs: unknown, exec: ToolRunLike): Promise<unknown> => {
    const args = rawArgs ?? {};
    assertArgs(spec, args);
    if (exec?.signal?.aborted) throw new Error(`工具「${spec.name}」已取消`);
    const unmet = unmetRequirement(ctx, requires);
    if (unmet) return unmet;
    // 每次执行现造：工作区可能在两次调用之间被换掉（与 bin/dsh-plugin.ts 的路由同一口径）
    const vault = createWorkspaceVault();
    const access = createAccess({ tool: spec.name, declaration }, vault.load);
    return spec.execute(args, { access, vault, signal: exec?.signal });
  };

  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: spec.output,
    execute: execute as ToolDefinitionLike['execute'],
    declaration: { reads: declaration.reads ?? [], writes: declaration.writes ?? {}, requires },
  };
}

/**
 * 注册一个工具，并把它挂在 `ctx.effect` 上。
 *
 * 为什么一律走 effect（`dsh-plugin-api.md` §2.10 的官方理由）：注册是**有主的**副作用，
 * 插件卸载 / 组合撤回时要跟着拆掉。`ctx.tools.register` 自己返回 disposer，接住它更显式。
 */
export function registerStudyTool(
  ctx: ServiceReader & {
    tools?: { register?: (definition: unknown) => unknown };
    effect?: (fn: () => unknown, description?: string) => unknown;
  },
  spec: StudyToolSpec,
): void {
  const definition = defineStudyTool(ctx, spec);
  const register = ctx.tools?.register;
  if (typeof register !== 'function') {
    throw new Error('当前宿主没有 ctx.tools：StudyMate 的原生工具注册不了（需要 0.1.7-alpha.1+）');
  }
  const mount = (): unknown => register.call(ctx.tools, definition);
  if (typeof ctx.effect === 'function') ctx.effect(mount, `studymate: ${spec.name}`);
  else mount();
}
