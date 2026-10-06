/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 问答域 —— 目录出口

   问答域只有**一条**路由：`POST /api/studymate/qa/session`（建一条答疑会话，#105）。
   注册点在 `bin/dsh-plugin.ts` 里加**一行**（与 `/api/studymate/*` 下那几条路由同一份约定：
   收外层 ctx、自己 `inject(['connection'])`）：

     registerAskSessionRoute(ctx);

   为什么不像别的子系统那样由 `lib/tools/index.ts` 的 `registerStudyMate` 代注册：答疑会话
   是阅读端与宿主半之间的**数据通路**（浏览器侧直接调），不是总控的工具面——`registerStudyMate`
   只在 `tools` 服务就绪时跑，而阅读端的数据通路只依赖 `connection`。挂在那边会让「没装 tools
   的组合里建不出会话」，与 `/api/studymate/*` 下其余路由的口径也不一致。

   #107 退役了「面板自己调模型」那条链路：旧路由 `POST /api/studymate/ask`、它那份上下文组装
   （纯函数域里那个问答上下文模块，已随本票删除）与守着它们的两条套件整体删掉。面板不再有
   「请求体」这一层——它只 retain 宿主的一条真会话并渲染宿主正文，上下文由只读工具、引用
   chip 与开张注入三处拼出来（目标态规格 §7.4）。这个出口不再导出任何旧链路的符号，
   `bin/dsh-plugin.ts` 那一行也就只剩建会话这一条。

   域图上这个域只有 `core` 与 `lib` 两条边（问答域不 import 工具域：能力探测的本体在
   `lib/core/model.ts`，见那里的文件头）。
   ───────────────────────────────────────────────────────────────────────── */

export {
  QA_SESSION_PATH, QA_AGENT_PRESET, ASK_SESSION_PREFIX, ASK_SESSION_SEP,
  isAskSessionTitle, openAskSession, registerAskSessionRoute, titleForAskSession,
} from './session.ts';
export type { AskAgents, AskPresetRegistry, AskSessionDeps, AskSessionInput, AskSessionTitle, AskSessionView } from './session.ts';
// 共享记忆的读法：建会话那条路由开张时注入一条，读不到算空（不是错误）。
export { readMemoryFromWorkspace } from './memory.ts';
