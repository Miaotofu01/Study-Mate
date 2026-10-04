import { expect, test, type Page } from "@playwright/test";

import { sendChatMessage } from "./helpers";

const LEFT_COLLAPSED_WIDTH = 60;
const LEFT_DEFAULT_WIDTH = 240;

// /chat 上唯一的 <aside> 是左侧主导航栏（右侧栏是 div[role=complementary]）
const leftSidebar = (page: Page) => page.locator("aside").first();

test("left sidebar collapses to a 60px rail and keeps the state across reloads", async ({
  page,
}) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");
  await expect
    .poll(async () => Math.round((await leftSidebar(page).boundingBox())!.width))
    .toBe(LEFT_DEFAULT_WIDTH);

  await page.getByTitle("折叠侧边栏").click();
  await expect
    .poll(async () => Math.round((await leftSidebar(page).boundingBox())!.width))
    .toBe(LEFT_COLLAPSED_WIDTH);

  // 折叠态持久化：刷新后仍是 60px 图标轨
  await page.reload();
  await expect(page.getByRole("heading")).not.toHaveText("你好");
  await expect
    .poll(async () => Math.round((await leftSidebar(page).boundingBox())!.width))
    .toBe(LEFT_COLLAPSED_WIDTH);

  // 展开按钮把宽度收回默认值
  await page.getByTitle("展开侧边栏").click();
  await expect
    .poll(async () => Math.round((await leftSidebar(page).boundingBox())!.width))
    .toBe(LEFT_DEFAULT_WIDTH);
});

test("the chat title can be renamed inline from the top bar", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  await sendChatMessage(page, "重命名前的会话");
  await expect(page.getByTestId("chat-title")).toHaveText("重命名前的会话");

  await page.getByTitle("重命名会话").click();
  const input = page.getByTestId("chat-title-input");
  await expect(input).toBeVisible();
  await input.fill("重命名后的会话");
  await input.press("Enter");

  await expect(page.getByTestId("chat-title")).toHaveText("重命名后的会话");
  // 左侧会话列表同步更新
  await expect(page.locator("aside").first().getByText("重命名后的会话")).toBeVisible();
});
