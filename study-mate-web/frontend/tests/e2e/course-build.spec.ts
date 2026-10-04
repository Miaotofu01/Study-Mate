import { expect, test } from "@playwright/test";

const DRAFT_SLUG = "python";

test("discovery interview ends in a draft, build orchestration and promotion", async ({ page }) => {
  // 幂等：上一轮残留的同名草稿/科目会让收口标记解析撞"草稿已存在"、promote 撞 409
  await page.request.delete(`/api/drafts/${DRAFT_SLUG}`);
  await page.request.delete(`/api/courses/${DRAFT_SLUG}`);
  // 建课会话入口（§5.1 F 行）：探索与盘问同一会话；fixture 的 interview 场景
  // 在首轮回复里带收口标记，后端解析后建草稿并持久化「确认建课」卡
  await page.goto("/chat");
  await page.getByTestId("discovery-starter").click();

  await expect(page.getByTestId("build-confirm-card")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("build-confirm-button").click();

  // 建课编排：大纲+采图并行 → 门禁 → 落盘（fixture 全绿）
  await expect(page.getByTestId("build-done-card")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("promote-button").click();
  await expect(page.getByTestId("chat-notice")).toContainText("已落盘到工作区");

  // 落点确认后科目进入工作区
  await page.goto("/courses");
  await expect(page.locator("aside").first().getByText("Python 实用小工具")).toBeVisible();
});

test("confirmed draft exists in the draft area and can be discarded", async ({ page }) => {
  await page.request.delete(`/api/drafts/${DRAFT_SLUG}`);
  await page.goto("/chat");
  await page.getByTestId("discovery-starter").click();
  await expect(page.getByTestId("build-confirm-card")).toBeVisible({ timeout: 20_000 });

  // 草稿区里能看到它；用完即弃，不污染其他用例
  const res = await page.request.get("/api/drafts");
  const drafts = (await res.json()) as { slug: string }[];
  expect(drafts.some((d) => d.slug === DRAFT_SLUG)).toBeTruthy();
  const del = await page.request.delete(`/api/drafts/${DRAFT_SLUG}`);
  expect(del.ok()).toBeTruthy();
});
