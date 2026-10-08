// 答疑预设也可以单独加载，不能依赖主插件提前注册 TS 加载钩子。
import './typescript-runtime.mjs';

const { inject, apply, QA_DENIED_TOOL_NAMES } = await import('../lib/tools/qa-preset.ts');
export { inject, apply, QA_DENIED_TOOL_NAMES };
