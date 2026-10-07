import { expect, type Page, test } from "@playwright/test";

import { expandRightRail, sendChatMessage } from "./helpers";

/**
 * 2026-10-04 轮：消息级操作与「中间过程」折叠。
 *
 * 覆盖：
 * - 助手名称栏（提供商 / 模型）
 * - 右栏「上下文窗口」栏（用量来自 SSE usage / 会话落库值）
 * - 思维链收进 process-panel 折叠区（默认收起）；工具卡已移出、常显在消息体
 * - 用户消息复制/编辑（编辑=从该条截断并重新生成）
 * - 助手消息删除整轮（内联二次确认）
 */

/** 消息区（会话标题会与消息正文撞词，断言一律限定在消息区内） */
function messages(page: Page) {
  return page.getByTestId("chat-messages");
}

/** 用 process 场景改写请求体：拿到思维链 + 两次工具调用 + 用量 */
async function useProcessScenario(page: Page): Promise<void> {
  await page.route("**/api/chat/stream", async (route) => {
    const post = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({
      postData: JSON.stringify({ ...post, fixture_scenario: "process" }),
    });
  });
}

test("assistant name bar and context window panel show model and usage", async ({ page }) => {
  await page.goto("/chat");
  await expandRightRail(page);
  await sendChatMessage(page, "你好");

  // 助手名称栏：显示「提供商 / 模型」（fixture settings 的当前使用项）
  await expect(page.getByTestId("assistant-name").first()).toHaveText("DeepSeek / deepseek-chat");

  // 右栏「上下文窗口」：模型名 + 用量数字 + 百分比（deepseek-chat 未声明上下文 → 兜底默认值）
  await expect(page.getByTestId("context-window-model")).toHaveText("DeepSeek / deepseek-chat");
  const usageLine = page.getByTestId("context-window-usage");
  await expect(usageLine).toContainText("11.5k");
  await expect(usageLine).toContainText("%");
  await expect(page.getByTestId("context-window-bar")).toBeVisible();
});

test("thinking fragments fold independently between tool calls", async ({ page }) => {
  await useProcessScenario(page);
  await page.goto("/chat");
  await expandRightRail(page);

  await page.getByRole("textbox").fill("用工具看看工作区");
  await page.getByTitle("发送").click();
  // 场景末段文本 = 本轮结束
  await expect(messages(page).getByText("过程折叠场景")).toBeVisible({ timeout: 20_000 });

  const panels = page.getByTestId("process-panel");
  await expect(panels).toHaveCount(3);
  const panel = panels.first();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("process-label")).toContainText("中间过程");

  // 工具卡已移出折叠区、常显在消息体里：不展开任何东西就能看到两张
  const cards = page.getByTestId("tool-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toBeVisible();

  // 默认收起：<details> 无 open 属性，思维链不可见
  await expect(panel).not.toHaveAttribute("open", "");
  await expect(panel.getByTestId("process-reasoning")).toBeHidden();

  // 展开后：思维链正文可见（工具卡不在折叠区内，不受影响）
  await panel.getByTestId("process-summary").click();
  await expect(panel).toHaveAttribute("open", "");
  await expect(panel.getByTestId("process-reasoning")).toContainText("先看看工作区");
  await expect(panels.nth(1).getByTestId("process-reasoning")).toBeHidden();
  expect(await page.getByTestId("assistant-parts").locator("[data-part-type]").evaluateAll(
    (elements) => elements.map((element) => element.getAttribute("data-part-type")),
  )).toEqual(["reasoning", "tool", "reasoning", "tool", "reasoning", "text"]);
});

test("editing a user message truncates later turns and regenerates", async ({ page }) => {
  await page.goto("/chat");
  await expandRightRail(page);
  await sendChatMessage(page, "原始问题");
  await sendChatMessage(page, "后续问题");
  await expect(page.getByTestId("session-message-count")).toHaveText("4 条");

  // 编辑第一条用户消息：就地变编辑框，提交后从该句重新生成
  await messages(page).getByText("原始问题").first().hover();
  await page.getByTestId("user-message-edit").first().click();
  const box = page.getByTestId("message-edit-box");
  await expect(box).toBeVisible();
  await box.getByTestId("message-edit-input").fill("改后的问题");
  await box.getByTestId("message-edit-submit").click();

  await expect(messages(page).getByText("改后的问题")).toBeVisible({ timeout: 20_000 });
  // 该句之后的整轮被截断：只剩 1 轮 = 2 条
  await expect(page.getByTestId("session-message-count")).toHaveText("2 条");
  await expect(messages(page).getByText("后续问题")).toHaveCount(0);
  await expect(messages(page).getByText("原始问题")).toHaveCount(0);
});

test("edit box keeps original attachments removable", async ({ page }) => {
  await page.goto("/chat");
  await expandRightRail(page);
  await page.getByRole("textbox").fill("带附件的问题");
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("e2e attachment"),
  });
  await expect(page.getByTestId("composer").getByText("note.txt")).toBeVisible();
  await page.getByTitle("发送").click();
  await expect(page.getByTitle("停止")).toBeHidden({ timeout: 20_000 });

  // 编辑时原附件默认保留，可移除
  await messages(page).getByText("带附件的问题").first().hover();
  await page.getByTestId("user-message-edit").first().click();
  const attachment = page.getByTestId("message-edit-attachment").first();
  await expect(attachment).toContainText("note.txt");
  await attachment.getByTitle("移除 note.txt").click();
  await expect(page.getByTestId("message-edit-attachment")).toHaveCount(0);
  await page.getByTestId("message-edit-cancel").click();
  await expect(page.getByTestId("message-edit-box")).toHaveCount(0);
});

test("deleting a turn removes the question together with its answer", async ({ page }) => {
  await page.goto("/chat");
  await expandRightRail(page);
  await sendChatMessage(page, "要被删掉的问题");
  await expect(page.getByTestId("session-message-count")).toHaveText("2 条");

  // 内联二次确认（对照 DeepTutor，不弹模态）
  await page.getByTestId("turn-delete").first().click();
  await expect(page.getByTestId("turn-delete-confirm")).toBeVisible();
  await page.getByTestId("turn-delete-confirm-yes").click();

  await expect(page.getByTestId("session-message-count")).toHaveText("0 条");
  await expect(messages(page).getByText("要被删掉的问题")).toHaveCount(0);
});
