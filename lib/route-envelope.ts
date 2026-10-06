/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 数据层 —— 阅读端 HTTP 路由的**唯一错误信封**

   阅读端（`lib/client.js`）与 Host 半之间靠五条 `/api/studymate/*` 路由说话。成功那一侧
   各条形状不同（`{ok:true, attempts, version}`、`{at, tasks}`、面板的 `{available, ok,
   answer…}`），这是对的——它们本来就在说不同的事。**失败那一侧不该不同**：原来
   `ask` 回 `{available, ok, error:{code, message}}`，而 `attempts` / `lab` / `reference`
   / `library` 回 `{error:'<字符串码>', message}`（library 那条更离谱：`error` 里放的是一整句
   给人看的话）。同一个客户端要按两种形状解析同一种东西，而**任何文档都没写过这个形状**。

   现在只有一种：`{ ok: false, error: { code, message }, ...extra }`
     · `code`   机读的短码（`version-conflict`、`body-invalid`、`no-workspace`…），客户端按它
                分支——`error` 是对象，所以「按码比较」与「取给人看的话」不再抢同一个字段；
     · `message` 给人看的一句话，**原样**递到界面上（学生照着它能自救）；
     · `extra`  这一条路由额外要带回去的东西（冲突时的 `attempts` / `version`、
                面板的 `available` / `model`）。`ok` 与 `error` 不许被 extra 覆盖。

   为什么不是「每条路由自己拼一个字面量」：那正是漂开的成因（三个文件各写一遍
   `{ error: '…', message }`）。这里是**唯一**的构造点，数据层的回执（`lib/attempts.ts` 的
   `AttemptsRefusal`、`lib/reference.ts` 的 `ReferenceRefusal`）也用它——回执被路由原样递出去，
   两处各拼一遍就等于两套信封。

   契约的人读版在 `docs/规范/工程约束.md` §三「阅读端 HTTP 路由」。
   ───────────────────────────────────────────────────────────────────────── */

/**
 * 全部机读码（**词表**）：客户端按 `error.code` 分支，所以码是契约的一部分，不是随手写的
 * 字符串。新增一个码就加进这里——`test_host_route_envelope.mjs` 会扫源码，调用点用了
 * 词表外的码就红（`errorView(error.field + '-invalid')` 那类拼出来的码不在此列，它们
 * 落在 `<字段>-invalid` 这一族里）。
 */
export const ROUTE_ERROR_CODES = [
  'ask-failed', 'body-invalid', 'evidence-invalid', 'expected-version-required',
  'file-shape-unknown', 'http-error', 'internal', 'lesson-missing', 'lesson-not-found', 'markdown-invalid',
  'method-not-allowed', 'model-empty', 'model-error', 'model-unavailable', 'name-conflict',
  'network', 'no-workspace', 'node-invalid', 'operation-id-conflict', 'operation-id-invalid',
  'path-invalid', 'preset-unavailable', 'question-required', 'questions-invalid',
  'session-create-failed', 'subject-invalid', 'title-invalid',
  'topic-invalid', 'version-conflict', 'workspace-missing', 'write-failed', 'write-verification-failed',
] as const;

/** 错误信封的**形状**（数据层的回执类型直接引用它，别各写一份）。 */
export interface RouteErrorEnvelope {
  ok: false;
  error: { code: string; message: string };
}

/**
 * 错误信封的**唯一**构造点。`extra` 是这一条路由额外要带回去的字段（冲突时的当前内容、
 * 面板的 `available`）；`ok` 与 `error` 排在后面，所以 extra 里同名也覆盖不掉它们。
 */
export function errorBody(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): RouteErrorEnvelope & Record<string, unknown> {
  return { ...extra, ok: false, error: { code, message } };
}

/** 同一个信封包成 HTTP 响应：`routeError(409, 'version-conflict', '…', { version })`。 */
export function routeError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(errorBody(code, message, extra), { status });
}
