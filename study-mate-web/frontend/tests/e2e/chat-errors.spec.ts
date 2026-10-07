import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { BACKEND_URL } from "./constants";

/**
 * 聊天错误面 E2E：SSE 流中断 / HTTP 503 / 空产出 / 手动停止 vs 异常断线。
 *
 * 契约（后端 agent_d8da + 前端 ErrorNotice 定稿）：
 * - ErrorInfo = { code, status: number|null, upstream_code?, phase, summary, detail, retryable,
 *   stopped_reason?, request_id, source?, operation? }；
 * - SSE `error` 事件把 ErrorInfo **平铺**进 data（另带 message）；
 * - HTTP 错误体为 { detail: summary, error: ErrorInfo }；
 * - 助手消息把错误持久化为 `error` + `stream_state="error"`，刷新后仍能重放；
 * - ErrorNotice 根节点 testid=`error-notice`、`role="alert"`、`data-error-code` /
 *   `data-error-phase` / `data-error-tone`（danger 红 / neutral 中性）；子节点
 *   `error-notice-summary` / `error-notice-badge` / `error-notice-toggle`（aria-expanded）/
 *   `error-notice-detail` / `error-notice-copy`（aria-label=复制诊断信息）/ `error-notice-copied`。
 * - 用户手动停止 → tone=neutral（stopped_reason=user）；其余异常 → tone=danger。
 *
 * 后端 FIXTURE 场景（缺失时必须失败，不自动跳过）：
 * - `partial503`：先吐半句正文，再以 503 类上游错误收尾（正文保留）；
 * - `empty503`：未产出任何正文即以 503 收尾（空助手消息也必须留下 + 错误可持久）；
 * - `unexpected_eof` / `transport_error`：上游流中途断开的两种异常断线。
 *
 * 不依赖新 fixture 的用例一律在 `page.route` 造受控响应，不需要真实 API Key、
 * 不外呼上游；手动停止复用既有 `stream_order` 工具场景。
 */

const MESSAGE_PARTIAL = "请给我一段会中途断掉的讲解";
const MESSAGE_EMPTY = "请给我一个空结果";
const MESSAGE_STOP = "请给我一个会持续一阵的演示回答";
const MESSAGE_NORMAL_503 = "请解释一下 503 是什么意思";

/** 流序场景首段正文（与后端 agent.FIXTURE_TOOL_SCRIPTS.stream_order 一致）。 */
const STREAM_ORDER_FIRST_TEXT = "先检查学习进度。";

/** 正常结束、但正文里出现「503」——不得被当成错误（受控 SSE）。 */
const NORMAL_503_BODY =
  "event: delta\n" +
  'data: {"content":"HTTP 503 表示服务暂不可用，这里只是正常讲解。"}\n\n' +
  "event: done\n" +
  'data: {"session_id":"mock-normal-503"}\n\n';

/** HTTP 503 错误体：{ detail: summary, error: ErrorInfo }（无真实 API Key 也能复现）。 */
const HTTP_503_ERROR_INFO = {
  code: "upstream_http_503",
  status: 503,
  upstream_code: "503",
  phase: "request",
  summary: "模型服务暂时不可用，请稍后重试。",
  detail: "DeepSeek /chat/completions 返回 503 Service Unavailable（request_id=req-e2e-http-503）",
  retryable: true,
  request_id: "req-e2e-http-503",
  source: "provider",
  operation: "chat_stream",
};

let runCounter = 0;
const createdIds: string[] = [];

function uniqueMessage(prefix: string): string {
  runCounter += 1;
  return `${prefix.slice(0, 6)}-${Date.now()}-${runCounter}`;
}

async function listSessionIds(request: APIRequestContext): Promise<string[]> {
  const res = await request.get(`${BACKEND_URL}/api/sessions`);
  const metas = (await res.json()) as Array<{ id: string }>;
  return metas.map((m) => m.id);
}

/** 把页面发出的 POST /api/chat/stream 注入指定 fixture 场景（seed 走 request，不经此处）。 */
async function injectScenario(page: Page, scenario: string): Promise<void> {
  await page.route("**/api/chat/stream", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    body.fixture_scenario = scenario;
    await route.continue({ postData: JSON.stringify(body) });
  });
}

/** 造受控 SSE 响应：用于「正常正文含 503」这类无后端依赖的用例。 */
async function fulfillSse(page: Page, body: string): Promise<void> {
  await page.route("**/api/chat/stream", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body }),
  );
}

function lastAssistantMessage(page: Page) {
  return page.getByTestId("chat-messages").locator("> div").last();
}

async function sendFromNewChat(page: Page, message: string): Promise<void> {
  await page.goto("/chat");
  await page.getByRole("textbox").fill(message);
  await page.getByTitle("发送").click();
}

/** 记录该页面流新建的会话，供 afterEach 快照 / 清理。 */
async function trackNewSession(request: APIRequestContext, before: Set<string>): Promise<string> {
  const after = await listSessionIds(request);
  const fresh = after.filter((id) => !before.has(id));
  expect(fresh, "页内流应新建且只新建一个会话").toHaveLength(1);
  createdIds.push(fresh[0]);
  return fresh[0];
}

async function fetchAssistant(
  request: APIRequestContext,
  sessionId: string,
): Promise<Record<string, unknown> & { streaming: boolean }> {
  const session = (await (await request.get(`${BACKEND_URL}/api/sessions/${sessionId}`)).json()) as {
    messages: Array<Record<string, unknown>>;
    streaming?: boolean;
  };
  const reply = session.messages.filter((m) => m.role === "assistant").at(-1) ?? {};
  return { ...reply, streaming: Boolean(session.streaming) };
}

function errorNotice(page: Page) {
  return page.getByTestId("error-notice");
}

/** 断言出现红错误卡（role=alert + danger + code/phase 非空），返回根 locator。 */
async function expectDangerNotice(page: Page) {
  const notice = errorNotice(page);
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveAttribute("role", "alert");
  await expect(notice).toHaveAttribute("data-error-tone", "danger");
  await expect(notice).toHaveAttribute("data-error-code", /\S+/);
  await expect(notice).toHaveAttribute("data-error-phase", /\S+/);
  await expect(notice.getByTestId("error-notice-summary")).not.toBeEmpty();
  return notice;
}

/** 展开 ErrorNotice 详情：toggle 的 aria-expanded 由 false 翻 true，detail 出现。 */
async function expandErrorDetails(page: Page): Promise<void> {
  const toggle = page.getByTestId("error-notice-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("error-notice-detail")).toBeVisible();
}

test.afterEach(async ({ request }, testInfo) => {
  // 清理前先把 API 消息快照 attach 到失败用例上，便于区分「没落库」还是「没渲染」。
  const failed = testInfo.status !== testInfo.expectedStatus && testInfo.status !== "skipped";
  if (failed) {
    for (const id of createdIds) {
      try {
        const res = await request.get(`${BACKEND_URL}/api/sessions/${id}`);
        if (res.ok()) {
          await testInfo.attach(`session-${id}.json`, {
            body: await res.text(),
            contentType: "application/json",
          });
        }
      } catch {
        // 快照失败不掩盖原始失败
      }
    }
  }
  while (createdIds.length) {
    const id = createdIds.pop()!;
    await request.delete(`${BACKEND_URL}/api/sessions/${id}`).catch(() => undefined);
  }
});

test("partial503：保留已产出的半句，红错误可展开详情，刷新后错误仍在", async ({
  page,
  request,
}) => {
  const message = uniqueMessage(MESSAGE_PARTIAL);
  const before = new Set(await listSessionIds(request));
  await injectScenario(page, "partial503");
  await sendFromNewChat(page, message);

  const notice = await expectDangerNotice(page);
  await expect(notice).toContainText("503");

  // 半句正文没有被错误吞掉：助手消息仍有非空正文片段
  const textParts = lastAssistantMessage(page).locator('[data-part-type="text"]');
  await expect(textParts.first()).toBeVisible();
  await expect(textParts.first()).not.toHaveText("");

  // 详情默认收起，展开后可见
  await expect(page.getByTestId("error-notice-detail")).toBeHidden();
  await expandErrorDetails(page);

  // 落库：该轮 stream_state=error，且错误信息随消息持久化
  const sessionId = await trackNewSession(request, before);
  await expect
    .poll(async () => (await fetchAssistant(request, sessionId)).streaming, { timeout: 20_000 })
    .toBe(false);
  const reply = await fetchAssistant(request, sessionId);
  expect(reply.stream_state).toBe("error");
  expect(reply.error, "ErrorInfo 应随助手消息持久化").toBeTruthy();

  // 刷新后错误仍在：重开会话应重新渲染红错误
  await page.reload();
  const sidebar = page.locator("aside").first();
  await expect(sidebar).toBeVisible();
  await sidebar.getByText(message).click();
  await expect(page.getByTestId("chat-title")).toContainText(message);
  await expect(errorNotice(page)).toBeVisible();
  await expect(errorNotice(page)).toHaveAttribute("data-error-tone", "danger");
});

test("empty503：没有正文也不丢——错误可见且刷新后仍能重放", async ({ page, request }) => {
  const message = uniqueMessage(MESSAGE_EMPTY);
  const before = new Set(await listSessionIds(request));
  await injectScenario(page, "empty503");
  await sendFromNewChat(page, message);

  await expectDangerNotice(page);
  // 用户轮不丢
  await expect(page.getByText(message).first()).toBeVisible();

  const sessionId = await trackNewSession(request, before);
  await expect
    .poll(async () => (await fetchAssistant(request, sessionId)).streaming, { timeout: 20_000 })
    .toBe(false);
  const reply = await fetchAssistant(request, sessionId);
  expect(reply.stream_state).toBe("error");
  expect(reply.error, "空产出兜底的 ErrorInfo 也应落库").toBeTruthy();

  // 刷新：空消息若被丢弃就再也找不到错误，这里必须仍可见
  await page.reload();
  const sidebar = page.locator("aside").first();
  await expect(sidebar).toBeVisible();
  await sidebar.getByText(message).click();
  await expect(page.getByTestId("chat-title")).toContainText(message);
  await expect(errorNotice(page)).toBeVisible();
});

test("HTTP 503：status/summary/detail 全部落到 ErrorNotice，无需真实 API Key", async ({
  page,
}) => {
  await page.route("**/api/chat/stream", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: HTTP_503_ERROR_INFO.summary, error: HTTP_503_ERROR_INFO }),
    }),
  );
  await sendFromNewChat(page, MESSAGE_NORMAL_503);

  const notice = await expectDangerNotice(page);
  await expect(notice).toHaveAttribute("data-error-code", HTTP_503_ERROR_INFO.code);
  await expect(notice).toHaveAttribute("data-error-phase", HTTP_503_ERROR_INFO.phase);
  await expect(notice.getByTestId("error-notice-badge")).toContainText("503");
  await expect(notice.getByTestId("error-notice-summary")).toContainText(
    HTTP_503_ERROR_INFO.summary,
  );

  // 详情默认收起，展开后能看到 detail / request_id
  await expect(page.getByTestId("error-notice-detail")).toBeHidden();
  await expandErrorDetails(page);
  await expect(page.getByTestId("error-notice-detail")).toContainText(
    HTTP_503_ERROR_INFO.request_id,
  );

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  // 复制诊断入口（aria-label=复制诊断信息）：点击后给出已复制反馈
  const copy = page.getByTestId("error-notice-copy");
  await expect(copy).toHaveAttribute("aria-label", "复制诊断信息");
  await copy.click();
  await expect(page.getByTestId("error-notice-copied")).toBeVisible();
});

test("正常正文里出现「503」不报错", async ({ page }) => {
  await fulfillSse(page, NORMAL_503_BODY);
  await sendFromNewChat(page, MESSAGE_NORMAL_503);

  await expect(page.getByText(/HTTP 503 表示服务暂不可用/)).toBeVisible();
  await expect(page.getByTestId("error-notice")).toHaveCount(0);
});

test("手动停止：保留已产出正文，落 interrupted，错误卡为中性而非红", async ({
  page,
  request,
}) => {
  const before = new Set(await listSessionIds(request));
  await injectScenario(page, "stream_order");
  await sendFromNewChat(page, MESSAGE_STOP);

  await expect(page.getByTitle("停止")).toBeVisible();
  await expect(lastAssistantMessage(page).getByText(STREAM_ORDER_FIRST_TEXT)).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTitle("停止").click();
  await expect(page.getByTitle("停止")).toBeHidden({ timeout: 20_000 });

  // 停下来的这一轮编码为 interrupted（不是 error），已产出正文保留
  const sessionId = await trackNewSession(request, before);
  await expect
    .poll(async () => (await fetchAssistant(request, sessionId)).streaming, { timeout: 20_000 })
    .toBe(false);
  const reply = await fetchAssistant(request, sessionId);
  expect(reply.stream_state).toBe("interrupted");
  await expect(lastAssistantMessage(page).getByText(STREAM_ORDER_FIRST_TEXT)).toBeVisible();

  // 用户停止 = neutral（对比异常断线的 danger）
  const notice = errorNotice(page);
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(notice).toHaveAttribute("data-error-tone", "neutral");
  await expect(notice).not.toHaveAttribute("data-error-tone", "danger");
});

for (const scenario of ["unexpected_eof", "transport_error"] as const) {
  test(`异常断线 ${scenario}：红错误、可重试、错误落库`, async ({ page, request }) => {

    const message = uniqueMessage(`异常断线-${scenario}`);
    const before = new Set(await listSessionIds(request));
    await injectScenario(page, scenario);
    await sendFromNewChat(page, message);

    const notice = await expectDangerNotice(page);
    await expect(notice.getByTestId("error-notice-summary")).toContainText(/连接|中断|断/);

    // 错误随本轮消息落库为 stream_state=error
    const sessionId = await trackNewSession(request, before);
    await expect
      .poll(async () => (await fetchAssistant(request, sessionId)).streaming, { timeout: 20_000 })
      .toBe(false);
    const reply = await fetchAssistant(request, sessionId);
    expect(reply.stream_state).toBe("error");
    expect(reply.error).toBeTruthy();

    await page.unroute("**/api/chat/stream");
  });
}
