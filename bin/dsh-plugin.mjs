// npm / DSH 入口先初始化本包 TS 加载，再导出原插件契约。
//
// `Config` 必须从**这个入口**转出去：宿主读的是 package.json exports["."] 指向的 `.mjs`，
// 不是 `dsh-plugin.ts`。schema 与插件本体同住 `dsh-plugin.ts`（同一个 TS 模块经
// `typescript-runtime.mjs` 装载；schemastery 由宿主提供，与 dsh-win-pwsh7 同一条）。
import './typescript-runtime.mjs';

const { inject, apply, Config } = await import('./dsh-plugin.ts');
export { inject, apply, Config };
