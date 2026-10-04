/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 问答域 —— 目录出口（#79）

   阅读端问答面板的那一条路由：`POST /api/studymate/ask`（目标态规格 §7.4）。
   注册点在 `bin/dsh-plugin.ts` 里加**一行**（与另外三条路由同一份约定：收外层 ctx、
   自己 `inject(['connection'])`）：

     registerAskRoute(ctx);

   为什么不像别的子系统那样由 `lib/tools/index.ts` 的 `registerStudyMate` 代注册：问答面板
   走的是 **HTTP 路由**（浏览器侧直接调），不是总控的工具面——`registerStudyMate` 只在
   `tools` 服务就绪时跑，而阅读端的数据通路只依赖 `connection`。挂在那边会让「没装 tools 的
   组合里面板答不了」，与另外三条 `/api/studymate/*` 路由的口径也不一致。

   域图上这个域只有 `core` 与 `lib` 两条边（问答域不 import 工具域：能力探测的本体在
   `lib/core/model.ts`，见那里的文件头）。
   ───────────────────────────────────────────────────────────────────────── */

export { ASK_PATH, askPanel, registerAskRoute, collectStream, readLessonFromWorkspace, readMemoryFromWorkspace, resolveSelection, stripFrontMatter } from './route.ts';
export type { AskDeps, AskRequestInput, AskRouteContext, AskView, LessonLookup } from './route.ts';
