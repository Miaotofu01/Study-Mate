import { expect, test, type Page } from "@playwright/test";

import { BACKEND_URL } from "./constants";
import { associateSubject, expandRightRail } from "./helpers";

/**
 * 修复期回归（聊天主链，2026-10-05 review）：
 *  - 编排结束后以服务端消息回灌：本地-only 临时卡不残留，编辑/删除下标与服务端一致
 *  - 编辑/删除必须经「刷新/重开会话」验证持久化（仅看 DOM 会被本地乐观截断掩盖）
 *  - 附件区拉取失败给「错误 + 重试」，不再停在永久「读取中…」
 *
 * 与 course-build.spec.ts 用同一套 fixture 建课链，只新增用例，不改既有文件。
 * 由验证员统一执行；本文件未在开发期跑过。
 */

const DRAFT_SLUG = "python";
const DISCOVERY_STARTER = "不知道学什么，帮我选方向";
// 与 ChatView 的 FIRST_LESSON_PROMPT 一致（按钮同名，故断言一律 scope 到用户气泡）
const FIRST_LESSON_PROMPT = "开始第一课";
const EDITED_PROMPT = "改后：只产出第一课";

/** 从建课会话的 SSE 响应体里取出后端分配的 session_id（不依赖标题/并发） */
async function sessionIdFromStream(body: string): Promise<string> {
  const match = body.match(/"session_id"\s*:\s*"([0-9a-fA-F]+)"/);
  expect(match, "SSE 里应有 session 事件").not.toBeNull();
  return match![1];
}

/** 打开侧栏里标题为 title 的会话（本测试已把会话改成唯一标题，避免同名 strict violation） */
async function openSessionByTitle(page: Page, title: string) {
  await page.locator("aside").first().getByText(title).click();
  await expect(page.getByTestId("chat-title")).toHaveText(title);
}

test("build/promote resyncs server messages and edit/delete survive reload", async ({
  page,
  request,
}) => {
  // 幂等：清掉上一轮残留，避免收口「草稿已存在」/promote 409
  await page.request.delete(`/api/drafts/${DRAFT_SLUG}`);
  await page.request.delete(`/api/courses/${DRAFT_SLUG}`);

  // 2026-10-05 拍板③：建课走「普通会话 + agent 工具切入」，首轮经 API 驱动
  // （fixture 场景是测试专用参数），从 SSE 响应体里拿本会话 id；改唯一标题便于 reload 后重开
  const first = await request.post("/api/chat/stream", {
    data: { message: DISCOVERY_STARTER, fixture_scenario: "interview_switch" },
  });
  expect(first.ok()).toBeTruthy();
  const sessionId = await sessionIdFromStream(await first.text());

  const uniqueTitle = `review-chat-resync-${Date.now()}`;
  const renamed = await request.patch(`${BACKEND_URL}/api/sessions/${sessionId}`, {
    data: { title: uniqueTitle },
  });
  expect(renamed.ok()).toBeTruthy();

  await page.goto("/chat");
  await openSessionByTitle(page, uniqueTitle);
  await expect(page.getByTestId("build-confirm-card")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("build-confirm-button").click();
  await expect(page.getByTestId("build-done-card")).toBeVisible({ timeout: 30_000 });

  // 回灌后：本地-only 临时卡（文案唯一带 ⚙ 前缀）不应残留；
  // 注意不能用「包含 开始建课编排」这种子串断言——建课确认卡的合法正文里就含
  // “确认后开始建课编排：大纲与采图并行…”，会误命中。
  const messages = page.getByTestId("chat-messages");
  await expect(messages.getByText(/⚙\s*开始建课编排/)).toHaveCount(0);
  // 强断言：服务端持久化的阶段卡仍在（证明消息流确实回灌成了服务端版本，而非空)
  await expect(messages.getByTestId("orchestration-stage").first()).toBeVisible();

  await page.getByTestId("promote-button").click();
  await expect(page.getByTestId("chat-notice")).toContainText("已落盘到工作区");
  // promote 的本地完成卡同样不落库，回灌后不应残留（精确匹配 ✅ 前缀那条）
  await expect(messages.getByText(/✅\s*落点确认完成/)).toHaveCount(0);

  // 一键开课：发普通 user 消息，等本轮结束后编辑它（此时下标必须与服务端 1:1）
  await expect(page.getByTestId("produce-first-lesson")).toBeVisible();
  await page.getByTestId("produce-first-lesson").click();
  const userBubble = () => messages.locator("div.bg-brand");
  await expect(userBubble().last()).toContainText(FIRST_LESSON_PROMPT);
  await expect(page.getByTitle("停止")).toBeHidden({ timeout: 20_000 });

  await userBubble().last().hover();
  await page.getByTestId("user-message-edit").last().click();
  const box = page.getByTestId("message-edit-box");
  await box.getByTestId("message-edit-input").fill(EDITED_PROMPT);
  await box.getByTestId("message-edit-submit").click();
  await expect(messages.getByText(EDITED_PROMPT)).toBeVisible({ timeout: 20_000 });

  // 关键：刷新 + 重开后会话再断言（否则只验了本地乐观截断）
  await page.reload();
  await openSessionByTitle(page, uniqueTitle);
  await expect(page.getByTestId("chat-messages").getByText(EDITED_PROMPT)).toBeVisible();
  await expect(page.getByTestId("chat-messages").locator("div.bg-brand").last()).not.toContainText(
    FIRST_LESSON_PROMPT,
  );

  // 删除本轮后同样要持久化：删掉这条被编辑的轮，再刷新重开确认没复活
  await page.getByTestId("turn-delete").last().click();
  await page.getByTestId("turn-delete-confirm-yes").click();
  await expect(page.getByTestId("chat-messages").getByText(EDITED_PROMPT)).toHaveCount(0);

  await page.reload();
  await openSessionByTitle(page, uniqueTitle);
  await expect(page.getByTestId("chat-messages").getByText(EDITED_PROMPT)).toHaveCount(0);
  await expect(page.getByTestId("chat-messages")).toContainText(DISCOVERY_STARTER);
});

test("attachments area shows an error with retry instead of a permanent spinner", async ({
  page,
}) => {
  // StrictMode 下 effect 会跑两次：用「保持失败直到断言完」的开关，避免 once 被双跑吃掉
  let shouldFail = true;
  await page.route("**/api/courses/**/attachments-area*", async (route) => {
    if (shouldFail) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "附件区暂时不可用" }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/chat");
  await associateSubject(page, "computer-networks");
  await expandRightRail(page);
  await page.getByTestId("rail-tab-session").click();

  const area = page.getByTestId("chat-right-sidebar").getByTestId("chat-attachments-area");
  await expect(area).toContainText("附件区读取失败");

  // 断言到错误后再放行，点重试应恢复真实内容（GLOSSARY.md 由 globalSetup 拷入）
  shouldFail = false;
  await area.getByRole("button", { name: "重试" }).click();
  await expect(area.getByText("术语表 · 1")).toBeVisible();
});
