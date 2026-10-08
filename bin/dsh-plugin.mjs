// npm / DSH 入口先初始化本包 TS 加载，再导出原插件契约。
import './typescript-runtime.mjs';

const { inject, apply } = await import('./dsh-plugin.ts');
export { inject, apply };
