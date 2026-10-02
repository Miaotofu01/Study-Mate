import { expect, test } from "@playwright/test";

test("open a node detail and its lesson page", async ({ page }) => {
  await page.goto("/courses?subject=computer-networks");

  await expect(page.getByText("点击节点查看详情")).toBeVisible();

  // 画布节点无法用坐标点击，走 a11y 隐藏节点列表（sr-only 按钮可聚焦、可触发）
  await page
    .getByRole("button", { name: "1. 分层模型与封装" })
    .dispatchEvent("click");

  await expect(page.getByRole("heading", { name: "分层模型与封装" })).toBeVisible();
  await expect(
    page.getByText("能画出一次网页请求经过的各层，并说清每层加了什么头"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "打开课件" })).toBeVisible();

  await page.getByRole("button", { name: "打开课件" }).click();
  await expect(page).toHaveURL(/\/lesson\?subject=computer-networks&node=net\.layers/);

  const lessonFrame = page.frameLocator("iframe");
  await expect(lessonFrame.locator("h1")).toContainText("分层模型与封装");
});

test("node detail rail defaults to open and can be collapsed and expanded", async ({ page }) => {
  await page.goto("/courses?subject=computer-networks");

  // 节点详情归入右侧边栏，默认展开：未选节点时空态提示可见
  const rail = page.getByTestId("course-node-detail");
  await expect(rail).toBeVisible();
  await expect(page.getByText("点击节点查看详情")).toBeVisible();

  // 折叠：宽度归零、内容保持挂载（aria-hidden），图谱区让出宽度
  await page.getByTitle("折叠节点详情").click();
  await expect(rail).toBeHidden();
  await expect(rail).toHaveAttribute("aria-hidden", "true");

  // 展开后回到默认宽度，空态提示仍在
  await page.getByTitle("展开节点详情").click();
  await expect(rail).toBeVisible();
  await expect(rail).not.toHaveAttribute("aria-hidden", "true");
  await expect(page.getByText("点击节点查看详情")).toBeVisible();
});
