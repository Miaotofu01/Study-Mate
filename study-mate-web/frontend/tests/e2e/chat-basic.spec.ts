import { expect, test } from "@playwright/test";

import { STREAM_NEXT_STEP_ANCHOR, STREAM_VISIBLE_SEGMENTS } from "./constants";

test("welcome starters start a streamed reply and the composer recovers", async ({ page }) => {
  await page.goto("/chat");

  await expect(page.getByRole("heading")).toBeVisible();
  await expect(
    page.getByText("StudyMate 会陪你讲概念、做练习、跑项目"),
  ).toBeVisible();
  for (const chip of ["讲解一个概念", "出几道练习题", "按我的课程进度继续", "帮我制定学习计划"]) {
    await expect(page.getByRole("button", { name: chip })).toBeVisible();
  }

  const topBarTitle = page.getByTestId("chat-title");
  await expect(topBarTitle).toHaveText("新的对话");

  // 问候语由客户端 effect 写入，确认水合完成后再点击
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  // 拍板③：开场选项只把文本填进输入框，不直接发起请求
  await page.getByRole("button", { name: "讲解一个概念" }).click();
  await expect(page.getByRole("textbox")).toHaveValue("讲解一个概念");
  await expect(page.getByRole("button", { name: "出几道练习题" })).toBeVisible();

  // 先挂响应等待再点击：断言这一轮确实走了 SSE 流（status + Content-Type）。
  // 这里刻意替换掉原先「末段尚未出现」的负断言——fixture 分片间隔固定，机器快慢
  // 会让末段在第一段断言前就到达，属竞态假红；SSE 契约断言稳定且更贴近真实行为。
  const streamResponse = page.waitForResponse((res) => res.url().includes("/api/chat/stream"));
  await page.getByTitle("发送").click();
  const response = await streamResponse;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"] ?? "").toContain("text/event-stream");

  await expect(page.getByRole("button", { name: "出几道练习题" })).toHaveCount(0);

  await expect(page.getByText(STREAM_VISIBLE_SEGMENTS[0])).toBeVisible();
  for (const segment of STREAM_VISIBLE_SEGMENTS.slice(1)) {
    await expect(page.getByText(segment)).toBeVisible();
  }

  // H②：一段流式回复的末尾带「下一步」呈现锚点（回复「继续」进入下一节）
  await expect(page.getByText(STREAM_NEXT_STEP_ANCHOR)).toBeVisible();

  await expect(page.getByTitle("发送")).toBeVisible();
  await expect(page.getByRole("textbox")).toBeEnabled();

  await expect(topBarTitle).toContainText("讲解一个概念");
  await expect(page.getByText("新的对话")).toHaveCount(0);
});
