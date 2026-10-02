import { expect, test } from "@playwright/test";

import { associateSubjectNode } from "./helpers";

test("switch subjects from the graph list, the sidebar and the chat top bar", async ({ page }) => {
  // /courses 不带参数时默认显示第一个科目
  await page.goto("/courses");
  await expect(page.getByTestId("graph-node-net.layers")).toBeVisible();

  // 图谱页左侧科目列表切换 → URL 与图谱对应
  await page.getByRole("link", { name: /线性代数/ }).click();
  await expect(page).toHaveURL(/\/courses\?subject=linear-algebra/);
  await expect(page.getByTestId("graph-node-vector.space")).toBeVisible();
  await expect(page.getByTestId("graph-node-net.layers")).toHaveCount(0);

  // 应用侧边栏科目区切换（/courses 上左主侧边栏是唯一的 aside，右节点详情是 div）
  await page.locator("aside").first().getByRole("button", { name: "计算机网络" }).click();
  await expect(page).toHaveURL(/\/courses\?subject=computer-networks/);
  await expect(page.getByTestId("graph-node-net.layers")).toBeVisible();

  // /chat 顶栏科目下拉切换后，节点下拉随之刷新
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");
  await associateSubjectNode(page, "linear-algebra", "vector.space");
  await expect(page.getByTitle("关联科目", { exact: true })).toHaveValue("linear-algebra");
  await expect(page.getByTitle("关联节点", { exact: true })).toHaveValue("vector.space");
});
