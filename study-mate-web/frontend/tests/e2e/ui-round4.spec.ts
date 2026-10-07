import { expect, test, type Page } from "@playwright/test";

import { BACKEND_URL } from "./constants";
import { expandRightRail, sendChatMessage } from "./helpers";

/**
 * 2026-10-05 第四轮 UI（拍板①②④）的旅程级回归：
 *  - ①：侧栏会话默认只显最近 5 条，历史收进「展开历史会话」；区块可折叠（组件层已覆盖）；
 *  - ②：聊天右栏「图谱与大纲」同屏双栏（大纲上 / 图谱下，手柄调占比，占满选项卡以下空间）；
 *  - ④：客户端导航切走再返回（浏览器后退），活动会话自动恢复——不再出现
 *    「侧栏高亮旧会话、主区却是新对话空态」的断连。
 */

/** 打开侧栏里标题为 title 的会话（标题 = 首条用户消息，主区空态开场按钮不在 aside 里） */
async function openSessionByTitle(page: Page, title: string) {
  await page.locator("aside").first().getByText(title).click();
  await expect(page.getByTestId("chat-title")).toHaveText(title);
}

test("switching pages and back restores the active conversation", async ({ page }) => {
  const message = "切走再回来，这条会话要还在";
  await page.goto("/chat");
  await sendChatMessage(page, message);

  // 客户端导航去课程页（不点「新对话」——那会显式重置活动会话）
  await page.getByRole("link", { name: "我的课程" }).click();
  await expect(page).toHaveURL(/\/courses/);

  // 浏览器后退回 /chat：ChatView 重挂载，活动会话应自动恢复
  await page.goBack();
  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByTestId("chat-title")).toHaveText(message);
  await expect(page.getByTestId("chat-messages")).toContainText(message);
  // 空态（开场选项 / 关联行）不回归
  await expect(page.getByRole("button", { name: "讲解一个概念" })).toHaveCount(0);
  await expect(page.getByTestId("new-session-association")).toHaveCount(0);
});

test("sidebar caps sessions at five with an expand control", async ({ page, request }) => {
  // 造 6 条全新会话（updated_at 最新）：无论世界里有几条旧会话，最新的 6 条都是它们
  const suffix = Date.now();
  const titles = Array.from({ length: 6 }, (_, i) => `侧栏历史会话${suffix}-${i}`);
  for (const title of titles) {
    const res = await request.post("/api/sessions", { data: { title } });
    expect(res.ok()).toBeTruthy();
  }

  await page.goto("/chat");
  const sidebar = page.locator("aside").first();
  // 隐藏条数 = 世界里的总会话数 - 5（本目录每轮 globalSetup 清空，只多出本轮其它用例的会话）
  const total = (
    (await (await request.get(`${BACKEND_URL}/api/sessions`)).json()) as unknown[]
  ).length;
  // 会话按 updated_at 倒序：titles[5] 最后造、最新，visibleSessions=前 5 条，最先造的 titles[0] 收进展开按钮
  for (const title of titles.slice(1)) {
    await expect(sidebar.getByText(title)).toBeVisible();
  }
  await expect(sidebar.getByText(titles[0])).toBeHidden();
  await expect(page.getByTestId("session-history-expand")).toContainText(
    `还有 ${total - 5} 条`,
  );

  // 展开 → 全部可见；收起 → 回到 5 条形态
  await page.getByTestId("session-history-expand").click();
  for (const title of titles) {
    await expect(sidebar.getByText(title)).toBeVisible();
  }
  await page.getByTestId("session-history-collapse").click();
  await expect(sidebar.getByText(titles[0])).toBeHidden();
});

test("chat rail shows outline and graph stacked with an adjustable split", async ({ page }) => {
  await page.goto("/chat");
  // 关联科目（新对话态关联行）后展开右栏
  await page.getByTitle("关联科目", { exact: true }).selectOption("computer-networks");
  await expandRightRail(page);
  const section = page.getByTestId("subject-graph-section");
  await expect(section).toBeVisible();

  // 同屏双栏：大纲与图谱画布同时可见；分段切换按钮（课程页专属）不再出现在聊天右栏
  const outline = section.getByTestId("course-outline");
  const canvas = section.getByTestId("course-graph-canvas");
  await expect(outline).toBeVisible();
  await expect(canvas).toBeVisible();
  await expect(page.getByTestId("rail-view-outline")).toHaveCount(0);

  // 拖中间手柄向下 = 大纲变高
  const handle = section.locator('[role="separator"]');
  const before = (await outline.boundingBox())!;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 80, { steps: 5 });
  await page.mouse.up();
  const after = (await outline.boundingBox())!;
  expect(after.height).toBeGreaterThan(before.height + 40);
  // 画布仍在（拖拽后 cytoscape 画布容器保持渲染，未塌缩成 0 高）
  await expect(canvas).toBeVisible();
});
