// 学习预设也可以单独加载，不能依赖主插件提前注册 TS 加载钩子。
import './typescript-runtime.mjs';

const { inject, apply } = await import('../lib/tools/learning-preset.ts');
export { inject, apply };
