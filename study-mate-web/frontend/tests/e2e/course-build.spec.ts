import { expect, test } from "@playwright/test";

import { BACKEND_URL } from "./constants";
import { expandRightRail } from "./helpers";

const DRAFT_SLUG = "python";
const DISCOVERY_STARTER = "不知道学什么，帮我选方向";

test("discovery interview ends in a draft, build orchestration and promotion", async ({
  page,
  request,
}) => {
  // 幂等：上一轮残留的同名草稿/科目会让收口标记解析撞"草稿已存在"、promote 撞 409
  await page.request.delete(`/api/drafts/${DRAFT_SLUG}`);
  await page.request.delete(`/api/courses/${DRAFT_SLUG}`);
  // 2026-10-05 拍板③：开场选项只填充输入框；建课改由普通会话里的 agent 经
  // start_course_interview 工具切入（收口判定用「本轮结束时的会话模式」，同轮即收口）。
  // fixture 的场景选择是测试专用参数，首轮经 API 驱动；其后全部走 UI。
  const first = await request.post("/api/chat/stream", {
    data: { message: DISCOVERY_STARTER, fixture_scenario: "interview_switch" },
  });
  expect(first.ok()).toBeTruthy();

  await page.goto("/chat");
  // 从侧栏点开该会话（标题 = 首条用户消息；主区空态的同名开场按钮不在 aside 里）
  await page.locator("aside").first().getByText(DISCOVERY_STARTER).click();
  await expect(page.getByTestId("chat-title")).toHaveText(DISCOVERY_STARTER);

  await expect(page.getByTestId("build-confirm-card")).toBeVisible({ timeout: 20_000 });
  // 收口标记是内部记账，不该出现在可见正文里（2026-10-04 维护者反馈的体验问题）
  await expect(page.getByTestId("chat-messages")).not.toContainText("<!--INTERVIEW_RESULT-->");
  await page.getByTestId("build-confirm-button").click();

  // 建课编排：大纲+采图并行 → 交付检查 → 落盘（fixture 全绿）。
  // fixture 走固定单次派工，没有内层「大纲自检」（那是非 fixture 工具循环才发的阶段）。
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
  // 发出的普通用户消息（= ChatView 的 FIRST_LESSON_PROMPT）；用用户气泡定位，避开同名按钮
  await expect(
    page.getByTestId("chat-messages").locator("div.bg-brand").last(),
  ).toContainText("开始第一课");

  // 落点确认后科目进入工作区
  await page.goto("/courses");
  await expect(
    page.locator("aside").first().getByRole("button", { name: "Python 实用小工具" }),
  ).toBeVisible();
});

test("confirmed draft exists in the draft area and can be discarded", async ({
  page,
  request,
}) => {
  await page.request.delete(`/api/drafts/${DRAFT_SLUG}`);
  // 拍板③后建课走「普通会话 + agent 工具切入」：首轮经 API 驱动（fixture 专用参数）
  const first = await request.post("/api/chat/stream", {
    data: { message: DISCOVERY_STARTER, fixture_scenario: "interview_switch" },
  });
  expect(first.ok()).toBeTruthy();
  // 标题（= 首条用户消息）与上一个用例同名；改成唯一标题，避免侧栏 getByText 撞 strict
  const sessionId = (await first.text()).match(/"session_id"\s*:\s*"([0-9a-fA-F]+)"/)?.[1];
  expect(sessionId, "SSE 里应有 session 事件").toBeTruthy();
  const uniqueTitle = `建课草稿区-${Date.now()}`;
  const renamed = await page.request.patch(`${BACKEND_URL}/api/sessions/${sessionId}`, {
    data: { title: uniqueTitle },
  });
  expect(renamed.ok()).toBeTruthy();

  await page.goto("/chat");
  await page.locator("aside").first().getByText(uniqueTitle).click();
  await expect(page.getByTestId("build-confirm-card")).toBeVisible({ timeout: 20_000 });

  // 草稿区里能看到它；用完即弃，不污染其他用例
  const res = await page.request.get("/api/drafts");
  const drafts = (await res.json()) as { slug: string }[];
  expect(drafts.some((d) => d.slug === DRAFT_SLUG)).toBeTruthy();
  const del = await page.request.delete(`/api/drafts/${DRAFT_SLUG}`);
  expect(del.ok()).toBeTruthy();
});
