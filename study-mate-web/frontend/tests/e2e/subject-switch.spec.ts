import { expect, test } from "@playwright/test";

import { associateSubject } from "./helpers";

test("switch subjects from the app sidebar and the chat association select", async ({ page }) => {
  // /courses 不带 ?subject= 时是「我的课程」首页嵌入（无图谱）；要图谱必须显式带科目
  await page.goto("/courses?subject=computer-networks");
  await expect(page.getByTestId("graph-node-net.layers")).toBeVisible();

  // 应用侧边栏科目区切换（课程页第二列科目列表已移除，aside 是唯一科目入口）
  await page.locator("aside").first().getByRole("button", { name: "线性代数" }).click();
  await expect(page).toHaveURL(/\/courses\?subject=linear-algebra/);
  await expect(page.getByTestId("graph-node-vector.space")).toBeVisible();
  await expect(page.getByTestId("graph-node-net.layers")).toHaveCount(0);

  await page.locator("aside").first().getByRole("button", { name: "计算机网络" }).click();
  await expect(page).toHaveURL(/\/courses\?subject=computer-networks/);
  await expect(page.getByTestId("graph-node-net.layers")).toBeVisible();

  // /chat 关联科目下拉切换（节点下拉已移除）
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");
  await associateSubject(page, "linear-algebra");
  await expect(page.getByTitle("关联科目", { exact: true })).toHaveValue("linear-algebra");
});
