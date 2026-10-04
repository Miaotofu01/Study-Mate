import { expect, test } from "@playwright/test";

import { STREAM_LAST_SEGMENT, STREAM_NEXT_STEP_ANCHOR, STREAM_VISIBLE_SEGMENTS } from "./constants";

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

  await page.getByRole("button", { name: "讲解一个概念" }).click();

  await expect(page.getByRole("button", { name: "出几道练习题" })).toHaveCount(0);

  await expect(page.getByText(STREAM_VISIBLE_SEGMENTS[0])).toBeVisible();
  await expect.poll(async () => page.getByText(STREAM_LAST_SEGMENT).count()).toBe(0);
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
