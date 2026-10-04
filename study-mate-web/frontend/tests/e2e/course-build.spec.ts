import { expect, test } from "@playwright/test";

import { BACKEND_URL } from "./constants";
import { expandRightRail } from "./helpers";

const DRAFT_SLUG = "python";

test("discovery interview ends in a draft, build orchestration and promotion", async ({
  page,
  request,
}) => {
  // 幂等：上一轮残留的同名草稿/科目会让收口标记解析撞"草稿已存在"、promote 撞 409
  await page.request.delete(`/api/drafts/${DRAFT_SLUG}`);
  await page.request.delete(`/api/courses/${DRAFT_SLUG}`);
  // 建课会话入口（§5.1 F 行）：探索与盘问同一会话；fixture 的 interview 场景
  // 在首轮回复里带收口标记，后端解析后建草稿并持久化「确认建课」卡
  await page.goto("/chat");
  await page.getByTestId("discovery-starter").click();

  await expect(page.getByTestId("build-confirm-card")).toBeVisible({ timeout: 20_000 });
  // 收口标记是内部记账，不该出现在可见正文里（2026-10-04 维护者反馈的体验问题）
  await expect(page.getByTestId("chat-messages")).not.toContainText("<!--INTERVIEW_RESULT-->");
  await page.getByTestId("build-confirm-button").click();

  // 建课编排：大纲+采图并行 → 门禁 → 落盘（fixture 全绿）
  await expect(page.getByTestId("build-done-card")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("promote-button").click();
  await expect(page.getByTestId("chat-notice")).toContainText("已落盘到工作区");

  // 落点确认带上会话 id：后端把该会话绑定到新科目（换科目需开新会话）
  const sessions = (await (await request.get(`${BACKEND_URL}/api/sessions`)).json()) as Array<{
    id: string;
    subject_slug: string | null;
  }>;
  expect(
    sessions.some((s) => s.subject_slug === DRAFT_SLUG),
    "promote 后触发会话应已绑定新科目",
  ).toBeTruthy();
  // 右栏出现科目图谱区（activeSubjectSlug 被 promote 选中）
  await expandRightRail(page);
  await expect(page.getByTestId("subject-graph-section")).toBeVisible();

  // build-done 卡上的「开始第一课」：科目进入工作区后出现，点击只发一条普通聊天消息
  const firstLesson = page.getByTestId("produce-first-lesson");
  await expect(firstLesson).toBeVisible();
  await firstLesson.click();
  await expect(page.getByTestId("chat-messages")).toContainText(
    "开始第一课：请按大纲顺序产出第一个节点，并告诉我产到哪了",
  );

  // 落点确认后科目进入工作区
  await page.goto("/courses");
  await expect(
    page.locator("aside").first().getByRole("button", { name: "Python 实用小工具" }),
  ).toBeVisible();
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
