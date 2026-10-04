/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— 模型能力探测

   目标态规格 §3.1 的第三条：「模型能力缺失是**协商结果**」——没有可用模型时工具返回
   `{available:false, reason}`，而不是让整个插件不 apply、也不是假装成功。

   宿主**没有** `isAvailable()` 这种单一 API（`dsh-plugin-api.md` Q9.3）：能探测的只有三层
   事实，从便宜到贵——`ctx.llm` 服务在不在、有没有注册的 provider 路由、某个 provider 有没有
   宣告模型。这里只探前两层：`listModels()` 空**不等于**不能调（核心路由仍接受未列出的 id），
   拿它当「没有模型」会误报。真正的真相只有 `stream()` 知道，而那要花额度——门禁里不跑。

   所以 `available:true` 的含义是「模型服务与 provider 都在，建议试一次」，
   `available:false` 才是**确定**不可用。这句话要一起进报告，别把它说成「模型一定可用」。
   ───────────────────────────────────────────────────────────────────────── */

/** 工具声明里的能力名。现在只有 `model` 一项。 */
export type Requirement = 'model';

export interface ModelCapability {
  available: boolean;
  /** 不可用时的原因（可读、可照着排查）。可用时不写这个键。 */
  reason?: string;
  /** 已注册的 provider 路由 id（`LlmProviderInfo` 的 `id`，另附人类可读的 `name`）。 */
  providers?: string[];
}

/** 只用到 `get` 的宿主上下文：零依赖的插件按**用到的成员**描述形状。 */
export interface ServiceReader {
  get?: (name: string) => unknown;
}

interface LlmLike {
  listProviders?: () => unknown;
}

function providerLabel(entry: unknown): string {
  if (entry && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const name = typeof record.name === 'string' ? record.name : '';
    if (id && name && name !== id) return `${id}（${name}）`;
    if (id || name) return id || name;
  }
  return String(entry);
}

/**
 * 探测模型能力。**每次都现探**：provider 是运行期挂上来的，注册时探一次会把
 * 「后来配好了模型」永久记成不可用。
 */
export function probeModel(ctx: ServiceReader): ModelCapability {
  let llm: unknown;
  try {
    llm = ctx.get?.('llm');
  } catch (error) {
    return { available: false, reason: `取 ctx.llm 失败：${(error as Error).message}` };
  }
  if (!llm || typeof llm !== 'object') {
    return {
      available: false,
      reason: '这个组合没挂模型服务（ctx.llm 不在）——阅读端仍能读、能导出，'
        + '要模型的能力这次不跑',
    };
  }
  let providers: unknown;
  try {
    const list = (llm as LlmLike).listProviders;
    providers = typeof list === 'function' ? list.call(llm) : [];
  } catch (error) {
    return { available: false, reason: `列 provider 失败：${(error as Error).message}` };
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    return {
      available: false,
      reason: '宿主里一个模型 provider 都没注册（adapter 没挂上）——'
        + '要模型的能力这次不跑',
    };
  }
  return { available: true, providers: providers.map(providerLabel) };
}

/**
 * `requires` 里有没有这项能力。返回 null = 都满足；否则给出 `{available:false, reason}` 的
 * 整个形状——工具包装层把它原样返回，body 一行都不跑。
 */
export function unmetRequirement(
  ctx: ServiceReader, requires: readonly Requirement[],
): { available: false; reason: string } | null {
  if (requires.includes('model')) {
    const model = probeModel(ctx);
    if (!model.available) {
      return { available: false, reason: model.reason ?? '模型能力不可用' };
    }
  }
  return null;
}
