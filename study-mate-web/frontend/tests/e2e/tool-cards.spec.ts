import { expect, test } from "@playwright/test";

import { associateSubject, expandRightRail } from "./helpers";

/**
 * K0/K1：工具化 chat 的端到端呈现。
 *
 * fixture 模式下 chat 走 canned 工具脚本（后端 FIXTURE_TOOL_SCRIPTS["tools"]：
 * list_workspace → read_course_file(MISSION.md) → 最终答复）。请求体的
 * fixture_scenario 由路由拦截改写，避免为测试在生产 UI 上开入口。
 */
test("tool loop streams tool cards then the final answer", async ({ page }) => {
  await page.route("**/api/chat/stream", async (route) => {
    const post = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({
      postData: JSON.stringify({ ...post, fixture_scenario: "tools" }),
    });
  });

  await page.goto("/chat");
  await expandRightRail(page);
  await associateSubject(page, "computer-networks");

  await page.getByRole("textbox").fill("用工具看看工作区");
  await page.getByTitle("发送").click();
  await expect(page.getByTitle("停止")).toBeVisible();
  await expect(page.getByTitle("停止")).toBeHidden({ timeout: 20_000 });

  // 工具卡已移出「中间过程」折叠区，直接常显在助手消息体里：无需展开任何折叠区
  const cards = page.getByTestId("tool-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: "list_workspace" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "read_course_file" })).toHaveCount(1);
  await expect(cards.first()).toBeVisible();

  // tools 场景既无思维链也无提示：折叠区整块不渲染（不留空面板）
  await expect(page.getByTestId("process-panel")).toHaveCount(0);

  // 展开首卡：结果区出现（工作区根目录可列出）
  await cards.first().locator("summary").click();
  await expect(cards.first().getByTestId("tool-result")).toBeVisible();

  // 工具轮之后模型给出最终答复
  await expect(page.getByText("工具已就绪")).toBeVisible();
});
