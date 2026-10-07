import { expect, test, type Page } from "@playwright/test";

import { BACKEND_URL, STREAM_LAST_SEGMENT } from "./constants";

/**
 * R7 真实持久化回归：附件提取文本不得出现在历史用户气泡 / 编辑框里。
 *
 * 全 fixture（无真 LLM）：上传含独特提取文本的 txt，用户原文与提取内容不同；
 * 发送后以接口捕获的真实 session id 唯一定位（不用会被同名撞到的全局标题），
 * 断言：
 *  - GET session：content 含提取文本（送模型用），display_content / 标题是用户原文；
 *  - 刷新重开会话后：气泡只原文、无提取块，编辑框预填原文；
 *  - 编辑重发后：content 仍是「新原文 + 单份附件块」，提取文本不重复。
 *
 * 由验证员统一执行；本文件不在开发期起服务。
 */

async function sessionIdFromStream(body: string): Promise<string> {
  const match = body.match(/"session_id"\s*:\s*"([0-9a-fA-F]+)"/);
  expect(match, "SSE 里应有 session 事件").not.toBeNull();
  return match![1];
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** storage 标题规则：超过 24 字符截断并加省略号（附件-only 用文件名时同理）。 */
function expectedTitle(text: string): string {
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

/** 侧栏按标题打开会话（标题须唯一且未被截断）。 */
async function openSessionByTitle(page: Page, title: string) {
  await page.locator("aside").first().getByText(title).first().click();
  await expect(page.getByTestId("chat-title")).toHaveText(title);
}

test("attachment extract text stays out of user bubble and edit box (persisted)", async ({
  page,
  request,
}) => {
  const token = Date.now();
  const EXTRACT = `DISPLAY_EXTRACT_${token}`;
  const ORIGINAL = `展示原文_${token}`;
  const EDITED = `改后原文_${token}`;
  const FILENAME = `display-note-${token}.txt`;

  await page.goto("/chat");
  // 问候语由客户端 effect 写入，确认水合完成后再输入
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  await page.locator('input[type="file"]').setInputFiles({
    name: FILENAME,
    mimeType: "text/plain",
    buffer: Buffer.from(`附件提取正文第一行\n${EXTRACT}\n末行\n`),
  });
  await expect(page.getByText(FILENAME)).toBeVisible();

  await page.getByRole("textbox").fill(ORIGINAL);
  const streamResponse = page.waitForResponse(
    (res) => res.url().includes("/api/chat/stream") && res.request().method() === "POST",
  );
  await page.getByTitle("发送").click();
  const sessionId = await sessionIdFromStream(await (await streamResponse).text());
  await expect(page.getByTitle("停止")).toBeHidden({ timeout: 20_000 });
  const messages = page.getByTestId("chat-messages");
  await expect(messages.getByText(STREAM_LAST_SEGMENT).first()).toBeVisible();

  // 接口契约：content 含提取文本，display_content / 标题是原文
  const session = await (await request.get(`${BACKEND_URL}/api/sessions/${sessionId}`)).json();
  const firstUser = session.messages.find((m: { role: string }) => m.role === "user");
  expect(firstUser.content).toContain(EXTRACT);
  expect(firstUser.display_content).toBe(ORIGINAL);
  expect(session.title).toBe(ORIGINAL);
  expect(session.title).not.toContain(EXTRACT);

  // 即时 UI：气泡只原文，提取块不可见
  await expect(messages.getByText(ORIGINAL, { exact: true })).toBeVisible();
  await expect(messages.getByText(new RegExp(EXTRACT))).toHaveCount(0);

  // 刷新 + 重开会话（标题即原文，唯一，不用全局同名查表）
  await page.reload();
  await page.locator("aside").first().getByText(ORIGINAL).first().click();
  await expect(page.getByTestId("chat-title")).toHaveText(ORIGINAL);
  await expect(messages.getByText(ORIGINAL, { exact: true })).toBeVisible();
  await expect(messages.getByText(new RegExp(EXTRACT))).toHaveCount(0);

  // 编辑框预填原文（不是提取块）
  await messages.getByText(ORIGINAL, { exact: true }).first().hover();
  await page.getByTestId("user-message-edit").last().click();
  const box = page.getByTestId("message-edit-box");
  await expect(box.getByTestId("message-edit-input")).toHaveValue(ORIGINAL);

  // 编辑重发（附件随消息保留）：附加块不重复
  await box.getByTestId("message-edit-input").fill(EDITED);
  await box.getByTestId("message-edit-submit").click();
  await expect(messages.getByText(EDITED, { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTitle("停止")).toBeHidden({ timeout: 20_000 });

  const after = await (await request.get(`${BACKEND_URL}/api/sessions/${sessionId}`)).json();
  const editedUser = after.messages.find((m: { role: string }) => m.role === "user");
  expect(editedUser.display_content).toBe(EDITED);
  expect(editedUser.content.startsWith(EDITED)).toBeTruthy();
  expect(countOccurrences(editedUser.content, EXTRACT)).toBe(1);
  expect(editedUser.content).not.toContain(ORIGINAL);

  // 刷新后仍是原文、无提取块（持久化，非本地乐观）
  await page.reload();
  await page.locator("aside").first().getByText(EDITED).first().click();
  await expect(messages.getByText(EDITED, { exact: true })).toBeVisible();
  await expect(messages.getByText(new RegExp(EXTRACT))).toHaveCount(0);
});

test("attachment-only message can be resent as-is from the edit box", async ({ page, request }) => {
  const token = Date.now();
  const EXTRACT = `ONLY_EXTRACT_${token}`;
  const FILENAME = `only-note-${token}.txt`;
  // 侧栏标题会被 storage 截断（文件名 27 字符 > 24），导航改用 PATCH 的唯一短标题，
  // 产品标题另做独立断言（见下）。
  const SHORT_TITLE = `only-${token}`;
  const sessionUrl = () => `${BACKEND_URL}/api/sessions/${sessionId}`;

  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  await page.locator('input[type="file"]').setInputFiles({
    name: FILENAME,
    mimeType: "text/plain",
    buffer: Buffer.from(`附件正文\n${EXTRACT}\n`),
  });
  await expect(page.getByText(FILENAME)).toBeVisible();

  // 不输入正文，只发附件
  const streamResponse = page.waitForResponse(
    (res) => res.url().includes("/api/chat/stream") && res.request().method() === "POST",
  );
  await page.getByTitle("发送").click();
  const sessionId = await sessionIdFromStream(await (await streamResponse).text());
  await expect(page.getByTitle("停止")).toBeHidden({ timeout: 20_000 });
  const messages = page.getByTestId("chat-messages");
  await expect(messages.getByText(STREAM_LAST_SEGMENT).first()).toBeVisible();
  await expect(messages.getByText(new RegExp(EXTRACT))).toHaveCount(0);

  // 附件-only 标题 = 文件名；文件名 > 24 字符按契约截断加省略号，绝不出现提取文本
  const created = await (await request.get(sessionUrl())).json();
  expect(created.title).toBe(FILENAME.slice(0, 24) + "…");
  expect(created.title).toHaveLength(25);
  expect(created.title).not.toContain(EXTRACT);

  // 刷新 + 重开（用唯一短标题导航；标题持久化在上一断言已单独验证）
  const renamed = await request.patch(sessionUrl(), { data: { title: SHORT_TITLE } });
  expect(renamed.ok()).toBeTruthy();
  await page.reload();
  await openSessionByTitle(page, SHORT_TITLE);

  // 原样重发：编辑框空正文仍可发送（F5）。气泡无正文，hover 附件以露出操作条。
  await messages.locator("a[download]").first().hover();
  await page.getByTestId("user-message-edit").last().click();
  const box = page.getByTestId("message-edit-box");
  await expect(box.getByTestId("message-edit-input")).toHaveValue("");
  await expect(box.getByTestId("message-edit-submit")).toBeEnabled();
  await box.getByTestId("message-edit-submit").click();
  await expect(page.getByTitle("停止")).toBeHidden({ timeout: 20_000 });

  // 后端：display_content 仍空，提取文本只注入一次；标题按契约重新落为截断文件名
  const session = await (await request.get(sessionUrl())).json();
  const user = session.messages.find((m: { role: string }) => m.role === "user");
  expect(user.display_content).toBe("");
  expect(countOccurrences(user.content, EXTRACT)).toBe(1);
  expect(session.title).toBe(expectedTitle(FILENAME));
  expect(session.title).not.toContain(EXTRACT);

  // 再 PATCH 回短标题后刷新，确认持久化展示无提取块（非本地乐观）
  await request.patch(sessionUrl(), { data: { title: SHORT_TITLE } });
  await page.reload();
  await openSessionByTitle(page, SHORT_TITLE);
  await expect(messages.getByText(new RegExp(EXTRACT))).toHaveCount(0);
});
