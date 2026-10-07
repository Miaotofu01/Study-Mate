import { expect, test } from "@playwright/test";

import { STREAM_LAST_SEGMENT } from "./constants";

test("upload a txt attachment and send it with a message", async ({ page }) => {
  await page.goto("/chat");

  // 问候语由客户端 effect 写入，确认水合完成后再输入
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  await page.locator('input[type="file"]').setInputFiles({
    name: "e2e-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("TCP 三次握手笔记：SYN → SYN/ACK → ACK。"),
  });

  await expect(page.getByText("e2e-note.txt")).toBeVisible();

  await page.getByRole("textbox").fill("帮我看看这份笔记");
  await page.getByTitle("发送").click();

  await expect(page.getByText(STREAM_LAST_SEGMENT)).toBeVisible();

  await expect(page.locator('a[download="e2e-note.txt"]')).toBeVisible();
  // 用户原文现在也作为会话标题（R7 display_content），全局 getByText 会同时命中
  // 侧栏标题与顶部 chat-title；限定到消息区，断言气泡里显示的是用户原文。
  await expect(
    page.getByTestId("chat-messages").getByText("帮我看看这份笔记", { exact: true }),
  ).toBeVisible();
});
