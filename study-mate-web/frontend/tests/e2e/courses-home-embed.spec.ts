import { expect, test } from "@playwright/test";

/**
 * 2026-10-04：「我的课程」首页。
 *
 * /courses 不带 ?subject= 时不再回落第一个科目、也不再渲染图谱：只嵌入工作区首页。
 * 带 ?subject= 时与原来一致（图谱右栏 + 节点详情）。
 * 空工作区优先显示「还没有科目…」提示（fixture 有种子科目，这里覆盖不到）。
 */
test("我的课程：/courses 只嵌入工作区首页，不渲染图谱右栏", async ({ page }) => {
  await page.goto("/courses");

  const embed = page.getByTestId("home-embed");
  await expect(embed).toBeVisible();
  await expect(embed).toHaveAttribute("title", "我的课程");

  // 不带参数时没有右栏图谱、也没有大纲与节点详情
  await expect(page.getByTestId("course-graph-rail")).toHaveCount(0);
  await expect(page.getByTestId("course-outline")).toHaveCount(0);
  await expect(page.getByTestId("course-node-detail")).toHaveCount(0);
});

test("带 ?subject= 的课程页仍显示图谱右栏", async ({ page }) => {
  await page.goto("/courses?subject=computer-networks");

  await expect(page.getByTestId("course-graph-rail")).toBeVisible();
  await expect(page.getByTestId("graph-node-net.layers")).toBeAttached();
  await expect(page.getByTestId("home-embed")).toHaveCount(0);
});
