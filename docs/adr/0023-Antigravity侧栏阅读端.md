# Antigravity 侧栏阅读端：用原生 Sidecar 承载同一份阅读界面

Antigravity 插件包在 `antigravity/studymate/sidecars/reader/` 增加一个基于宿主原生 `sidecar_sdk` 的
**StudyMate Reader** 侧栏面板（入口 `SIDECAR_UI_ENTRYPOINT_AUX_PANE`，面板地址
`sidecar://studymate/reader/`）。它复用与 DSH 阅读端同一份 `lib/client.js` 渲染代码和 `lib/**` 数据层，
构建期由 `bin/antigravity-plugin.mjs` 把这些源码、`bin/typescript-runtime.mjs` 与确定性的 React
`vendor/` 一起封进插件产物。`npx -y @yunmiao/studymate@latest export` 的离线静态页面保留，作为没有
Antigravity 的机器与存档场景的补充。

## Context

[ADR-0003](0003-阅读端只嵌DSH.md) 定下的边界是「DSH 里只有一个阅读端，不做第二个 DSH 前端」，同时把
Antigravity 与 Codex·ChatGPT Work 归入「无头 CLI + 导出静态页面，先维持可用、后单独演进」。这条演进有了
宿主侧的抓手：Antigravity 提供 `sidecar_sdk`（`SidecarApp` 的 `page()` / `api()` 与 `Response`），允许插件
自己声明一个侧栏视图，并允许该视图通过宿主 token（`X-Sidecar-Token`）调用同一个进程里的 HTTP 路由。

只要侧栏面板能读写学习工作区，「学生只能在导出页面里读课件」就不成立了：导出是**复制**一份数据给浏览
器，改不动原工作区；而阅读端的价值恰好在写回——作答写 `attempts/`、划选写 `annotations/`、跑实验、记
笔记。把这些能力留在无头侧，等于让人先把内容抄进导出页再抄回来。

代价是这一侧多出一个「界面形态」。要避免的是**第二套渲染与第二套数据格式**，而不是多一个宿主入口。

## Decision

- **侧栏面板是宿主原生视图，不是第二个前端**：`sidecar_sdk` 的 `page()` 只发静态文件（`index.html`、
  `host.js`、`boot.js`、`studymate-client.js`、`vendor/*.js`），`api()` 只把请求转给 `lib/**` 的现有
  路由实现。面板自己不定义数据模型，也不新增一套组件树。
- **渲染代码只有一份**：`lib/client.js`（连同 `build:client` 产出的可选分块 `client.notes.js`）原样随插件
  发货，构建时经 `copySidecarClient` 拷进 `sidecars/reader/client/`。页面里跑的组件与 DSH 阅读端、导出静态页面是
  同一份源码；差别只在宿主桥接（`host.js` 提供 `window.__smDefine` / `require.async`、
  `__STUDYMATE_WS_URIS__` 与 fetch 拦截器），以及面板用 `PollingEventSource` 轮询
  `/api/studymate/poll-version` 代替宿主的变更推送。
- **数据层零分叉**：`copySidecarEngine` 把 `lib/**` 与 `bin/typescript-runtime.mjs` 拷进
  `sidecars/reader/engine/`，`main.mjs` 用 `engine/bin/typescript-runtime.mjs` 注册类型擦除 load hook 后
  直接 `import('./engine/lib/library.ts')` 等模块。错误信封仍由 `lib/route-envelope.ts` 统一，写入栅栏
  （`operationId` 幂等、`expectedVersion` 版本冲突 409）与其他宿主完全一致。
- **React 是构建期确定性 vendor**：`resolveReact({ probeGlobal: false })` 找一份
  production 构建，包成 `window.__smDefine(name, factory)` 的形状写进 `vendor/`。运行时若 `vendor/` 缺失，
  `/vendor/*` 路由仍会尝试重新解析；这台机器确实没有 React 时返回 404 `react-missing` JSON，而不是发一份
  打不开的页面。
- **离线的 `studymate export` 保留**：它现在的定位是「没有 Antigravity 的机器、或想存档时导一份自包含
  静态页」，不再是这一侧的主要阅读方式。技能里两条路径并列：面板链接 `sidecar://studymate/reader/`
  与会话里的 `npx -y @yunmiao/studymate@latest export`。
- **契约测试在构建产物上跑**：`scripts/tests/test_antigravity_sidecar.mjs` 先把插件构建到临时目录，再用
  `module.registerHooks` 把裸模块 `sidecar_sdk` 指到 `scripts/tests/fixtures/sidecar-sdk-mock.mjs`，对
  `sidecars/reader/main.mjs` 的静态路由与 8 组数据 API 逐条断言。测的是发货件，不是源码近似物。

## Consequences

- 「阅读端只嵌 DSH」的范围被正式改写：**DSH 仍是唯一把阅读端放在 `main` 槽位的宿主**，Antigravity 多了
  一个侧栏视图，但两者共用同一份组件与数据层。ADR-0003 的禁令（不做第二个 DSH 前端、不接管会话区）不变。
- 插件包变大：`sidecars/reader/engine/lib/**` 是 `lib/**` 的完整拷贝，再加 5 个 production vendor 文件。
  这是为了「面板进程能在没有仓库 `node_modules` 的机器上直接跑」付的代价；构建产物的一致性由
  `scripts/tests/test_antigravity_plugin.mjs` 的清单断言守住。
- `lib/**` 的任何破坏性改动都会同时影响 DSH、导出与侧栏三处。这是同一个实现的应有之义，也是为什么
  `scripts/tests/test_antigravity_sidecar.mjs` 必须断言真实响应形状（`version-conflict`、`{text, entry}`、
  notes 的 64 位版本号）而不是另立一套测试专用口径。
- Sidecar 长驻进程需要重启策略与静态缓存：`sidecar.json` 用 `restart_policy: always`，`main.mjs` 对页面与
  vendor 文件做进程内缓存，数据 API 不走缓存。
- 面板能用到的宿主能力仅限 `sidecar_sdk` 与宿主 token；`ask_question`、`invoke_subagent` 这类智能体侧
  能力仍只在对话里。面板的「把这段发给当前对话」通过宿主桥接完成，不复制一份对话状态机。
