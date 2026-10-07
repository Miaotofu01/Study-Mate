import { expect, test } from "@playwright/test";

import { associateSubject, expandRightRail, sendChatMessage } from "./helpers";

/**
 * 2026-10-04：聊天右栏的科目图谱 / 大纲区（subject-graph-section）。
 *
 * 关联科目的会话在右栏多一段 SubjectGraphPanel，默认「大纲」视图；点大纲节点
 * 跳到课程页并定位（/courses?subject=<slug>&node=<id>）。
 * 这里刻意从会话列表重新打开，验证关联是从会话元数据恢复的，而非新对话态的本地选择。
 */
test("subject-associated session shows the graph section and jumps to the course page", async ({
  page,
}) => {
  await page.goto("/chat");
  await expandRightRail(page);
  await associateSubject(page, "computer-networks");
  await sendChatMessage(page, "看下这门课的图谱");

  // 从会话列表重新打开：关联从落库的会话元数据恢复
  await page.getByTitle("新对话").click();
  await page.locator("aside").first().getByText("看下这门课的图谱").click();
  await expect(page.getByTestId("chat-title")).toHaveText("看下这门课的图谱");
  // 该会话落盘过「右栏展开」态，重开通常已展开；折叠时才手动展开（等加载完再判，避免标签翻转竞态）
  await expandRightRail(page);

  await expect(page.getByTestId("subject-graph-section")).toBeVisible();
  // 聊天右栏默认大纲视图
  const outline = page.getByTestId("course-outline");
  await expect(outline).toBeVisible();

  await expect(page.getByTestId("outline-node-net.layers")).toBeVisible();
  await page.getByTestId("outline-node-net.layers").click();
  await expect(page).toHaveURL(/\/courses\?subject=computer-networks&node=net\.layers/);
});
