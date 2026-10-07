import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { BACKEND_URL } from "./constants";

/**
 * 会话流生命周期 E2E：流式中切走/离开再回来，本轮流必须继续并在服务端完整落库。
 *
 * fixture 约束：用 lib fixture 场景 `stream_order`（后端 agent.FIXTURE_TOOL_SCRIPTS）——
 * 三段独特正文与两次工具调用交错，每次工具静默 ~2s，总时长 ~5s，够切换窗口；
 * 普通 chat 的默认场景只有固定分片、不含工具，不足以覆盖用户场景。
 * 场景经 `page.route` 只注入到页面发的 chat/stream 请求；seed 走 request（不经 page.route）。
 */

const FINAL_TEXT = "本轮学习内容已整理完成。";
const FIRST_TEXT = "先检查学习进度。";

let runCounter = 0;
const createdIds: string[] = [];

function uniqueTitle(prefix: string): string {
  runCounter += 1;
  return `${prefix}-${Date.now()}-${runCounter}`;
}

async function listSessionIds(request: APIRequestContext): Promise<string[]> {
  const res = await request.get(`${BACKEND_URL}/api/sessions`);
  const metas = (await res.json()) as Array<{ id: string }>;
  return metas.map((m) => m.id);
}

async function seedNewSession(
  request: APIRequestContext,
  message: string,
  title: string,
): Promise<string> {
  const before = new Set(await listSessionIds(request));
  const res = await request.post(`${BACKEND_URL}/api/chat/stream`, {
    data: { message, session_id: null },
  });
  expect(res.ok(), "fixture 流应正常返回").toBeTruthy();
  const after = await listSessionIds(request);
  const fresh = after.filter((id) => !before.has(id));
  expect(fresh, "应新建且只新建一个会话").toHaveLength(1);
  const id = fresh[0];
  await request.patch(`${BACKEND_URL}/api/sessions/${id}`, { data: { title } });
  createdIds.push(id);
  return id;
}

async function appendTurn(
  request: APIRequestContext,
  sessionId: string,
  message: string,
): Promise<void> {
  const res = await request.post(`${BACKEND_URL}/api/chat/stream`, {
    data: { message, session_id: sessionId },
  });
  expect(res.ok()).toBeTruthy();
}

/** 只把页面发出的 chat/stream 请求注入 stream_order 场景。 */
async function injectStreamOrder(page: Page): Promise<void> {
  await page.route("**/api/chat/stream", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    body.fixture_scenario = "stream_order";
    await route.continue({ postData: JSON.stringify(body) });
  });
}

async function editResendLastUserMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId("user-message-edit").last().click();
  await expect(page.getByTestId("message-edit-box")).toBeVisible();
  await page.getByTestId("message-edit-input").fill(text);
  await page.getByTestId("message-edit-submit").click();
}

function lastAssistantMessage(page: Page) {
  return page.getByTestId("chat-messages").locator("> div").last();
}

async function fetchSession(
  request: APIRequestContext,
  sessionId: string,
): Promise<{ messages: Array<Record<string, unknown>>; streaming: boolean }> {
  const session = (await (await request.get(`${BACKEND_URL}/api/sessions/${sessionId}`)).json()) as {
    messages: Array<Record<string, unknown>>;
    streaming?: boolean;
  };
  return { messages: session.messages, streaming: Boolean(session.streaming) };
}

function expectTurnCompleted(
  session: { messages: Array<Record<string, unknown>>; streaming: boolean },
): void {
  expect(session.streaming).toBe(false);
  expect(session.messages).toHaveLength(4);
  const reply = session.messages[3];
  expect(reply.role).toBe("assistant");
  expect(String(reply.content ?? "")).toContain(FINAL_TEXT);
  expect(reply.stream_state).toBe("completed");
  expect((reply.tools as unknown[])?.length ?? 0).toBe(2);
  const notices = (reply.notices as string[] | undefined) ?? [];
  expect(notices.some((n) => n.includes("连接中断"))).toBe(false);
}

/** DOM 有序 parts：reasoning → text → tool → text → tool → text。 */
async function expectOrderedParts(page: Page): Promise<void> {
  const host = lastAssistantMessage(page).getByTestId("assistant-parts");
  await expect(host).toBeVisible();
  const types = await host
    .locator("[data-part-type]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-part-type")));
  expect(types).toEqual(["reasoning", "text", "tool", "text", "tool", "text"]);
}

test.afterEach(async ({ request }) => {
  while (createdIds.length) {
    const id = createdIds.pop()!;
    await request.delete(`${BACKEND_URL}/api/sessions/${id}`).catch(() => undefined);
  }
});

test("switch to another session mid-stream and back: the turn completes", async ({ page, request }) => {
  const aTitle = uniqueTitle("流生命周期A");
  const bTitle = uniqueTitle("流生命周期B");
  const aId = await seedNewSession(request, "从这个科目开始学习", aTitle);
  await appendTurn(request, aId, "请继续");
  await seedNewSession(request, "另一个会话", bTitle);

  await injectStreamOrder(page);
  await page.goto("/chat");
  const sidebar = page.locator("aside").first();
  await expect(sidebar).toBeVisible();

  await sidebar.getByText(aTitle).click();
  await expect(page.getByTestId("chat-title")).toHaveText(aTitle);

  await editResendLastUserMessage(page, "请继续");
  // 请求在执行：停止按钮可见 + 首段正文出现，且工具卡确实处于「调用中」窗口
  await expect(page.getByTitle("停止")).toBeVisible();
  await expect(lastAssistantMessage(page).getByText(FIRST_TEXT)).toBeVisible();
  await expect(lastAssistantMessage(page).getByTestId("tool-card").first()).toContainText("调用中");

  // 工具执行中切走 → 切回
  await sidebar.getByText(bTitle).click();
  await expect(page.getByTestId("chat-title")).toHaveText(bTitle);
  await sidebar.getByText(aTitle).click();
  await expect(page.getByTestId("chat-title")).toHaveText(aTitle);

  await expect(lastAssistantMessage(page).getByText(FINAL_TEXT)).toBeVisible({ timeout: 20_000 });
  await expectOrderedParts(page);
  // done/租约释放有滞后：先 poll 到服务端 streaming=false 再读消息，避开竞态
  await expect
    .poll(async () => (await fetchSession(request, aId)).streaming, { timeout: 20_000 })
    .toBe(false);
  expectTurnCompleted(await fetchSession(request, aId));

  // reload 后重开会话：历史（落库）顺序仍是 reasoning/text/tool/text/tool/text
  await page.reload();
  const sidebar2 = page.locator("aside").first();
  await expect(sidebar2).toBeVisible();
  await sidebar2.getByText(aTitle).click();
  await expect(page.getByTestId("chat-title")).toHaveText(aTitle);
  await expect(lastAssistantMessage(page).getByText(FINAL_TEXT)).toBeVisible();
  await expectOrderedParts(page);
});

test("leave /chat mid-stream and return: the run is restored", async ({ page, request }) => {
  const aTitle = uniqueTitle("流生命周期离开");
  const aId = await seedNewSession(request, "从这个科目开始学习", aTitle);
  await appendTurn(request, aId, "请继续");

  await injectStreamOrder(page);
  await page.goto("/chat");
  const sidebar = page.locator("aside").first();
  await expect(sidebar).toBeVisible();

  await sidebar.getByText(aTitle).click();
  await expect(page.getByTestId("chat-title")).toHaveText(aTitle);

  await editResendLastUserMessage(page, "请继续");
  await expect(page.getByTitle("停止")).toBeVisible();
  await expect(lastAssistantMessage(page).getByText(FIRST_TEXT)).toBeVisible();

  // SPA 离开 /chat（侧栏 Link 路由，非整页刷新）再经会话行回来
  await sidebar.getByText("我的课程").click();
  await expect(page).toHaveURL(/\/courses/);
  await sidebar.getByText(aTitle).click();
  await expect(page.getByTestId("chat-title")).toHaveText(aTitle);

  await expect(lastAssistantMessage(page).getByText(FINAL_TEXT)).toBeVisible({ timeout: 20_000 });
  await expectOrderedParts(page);
  await expect
    .poll(async () => (await fetchSession(request, aId)).streaming, { timeout: 20_000 })
    .toBe(false);
  expectTurnCompleted(await fetchSession(request, aId));
});
