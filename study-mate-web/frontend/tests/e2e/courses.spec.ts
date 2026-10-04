import { expect, test } from "@playwright/test";

import { BACKEND_URL } from "./constants";

test("open a node detail and its lesson page", async ({ page }) => {
  await page.goto("/courses?subject=computer-networks");

  await expect(page.getByText("点击节点查看详情")).toBeVisible();

  // 画布节点无法用坐标点击，走 a11y 隐藏节点列表（sr-only 按钮可聚焦、可触发；默认视图即图谱）
  await page.getByTestId("graph-node-net.layers").dispatchEvent("click");

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

test("course rail: default graph view in collapsible rail; outline is a segmented view", async ({
  page,
}) => {
  await page.goto("/courses?subject=computer-networks");

  // 默认视图 = 图谱：主区只有详情空态，右栏图谱可见、大纲隐藏
  await expect(page.getByTestId("course-graph-rail")).toBeVisible();
  await expect(page.getByText("点击节点查看详情")).toBeVisible();
  await expect(page.getByTestId("graph-node-net.layers")).toBeAttached();
  await expect(page.getByTestId("course-outline")).toBeHidden();

  // 画布存在（cytoscape 会铺 3 层 canvas），并打标记验证分段切换不销毁重建
  const canvas = page.locator('[data-testid="course-graph-canvas"] canvas');
  await expect(canvas.first()).toBeAttached();
  const canvasCount = await canvas.count();
  expect(canvasCount).toBeGreaterThan(0);
  await page.evaluate(() => {
    document
      .querySelector('[data-testid="course-graph-canvas"] canvas')
      ?.setAttribute("data-keep", "1");
  });

  // 折叠：宽度归零、内容保持挂载（aria-hidden / sr-only 节点按钮不卸载）
  const rail = page.getByTestId("course-graph-rail");
  await page.getByTitle("折叠课程图谱").click();
  await expect
    .poll(async () => Math.round((await rail.boundingBox())?.width ?? -1))
    .toBe(0);
  await expect(rail).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByTestId("graph-node-net.layers")).toBeAttached();

  // 展开：切到「大纲」段 → 大纲行可见，点击后节点详情在主区出现
  await page.getByTitle("展开课程图谱").click();
  await expect(rail).not.toHaveAttribute("aria-hidden", "true");
  await page.getByTestId("rail-view-outline").click();
  await expect(page.getByTestId("course-outline")).toBeVisible();
  await page.getByTestId("outline-node-net.layers").click();
  await expect(page.getByTestId("course-node-detail")).toBeVisible();
  await expect(page.getByRole("heading", { name: "分层模型与封装" })).toBeVisible();

  // 切回「图谱」段：画布仍是同一份（标记还在、层数不变），sr-only 节点按钮仍可选中节点
  await page.getByTestId("rail-view-graph").click();
  await expect(canvas).toHaveCount(canvasCount);
  expect(
    await page.evaluate(
      () =>
        document
          .querySelector('[data-testid="course-graph-canvas"] canvas')
          ?.getAttribute("data-keep") ?? null,
    ),
  ).toBe("1");
  await page.getByTestId("graph-node-net.layers").dispatchEvent("click");
  await expect(
    page.getByRole("heading", { name: "分层模型与封装" }),
  ).toBeVisible();
});

// 科目总览（2026-10-04 拍板 A）：状态从左侧边栏绿点移到课程页头部，并可就地改
test("course header shows the subject overview and edits the status in place", async ({
  page,
  request,
}) => {
  await page.goto("/courses?subject=computer-networks");

  const status = page.getByTestId("subject-status");
  await expect(status).toBeVisible();
  await expect(status).toHaveValue("进行中");
  await expect(page.getByText(/进度 \d+\/\d+ · 平均掌握度/)).toBeVisible();

  await status.selectOption("暂停");
  await expect(status).toHaveValue("暂停");
  const afterSuspend = (await (await request.get(`${BACKEND_URL}/api/courses`)).json()) as Array<{
    slug: string;
    status: string;
  }>;
  expect(afterSuspend.find((c) => c.slug === "computer-networks")?.status).toBe("暂停");

  // 还原，避免污染同一轮里的其它用例
  await status.selectOption("进行中");
  await expect(status).toHaveValue("进行中");
});

// 左侧边栏的科目行改成「选中」语义（去掉状态绿点后）：只表达当前在看的科目
test("the sidebar marks the subject currently open on the courses page", async ({ page }) => {
  await page.goto("/courses?subject=computer-networks");

  const sidebar = page.locator("aside").first();
  await expect(sidebar.locator('button[aria-current="page"]')).toHaveText("计算机网络");

  await sidebar.getByRole("button", { name: "线性代数" }).click();
  await expect(page).toHaveURL(/subject=linear-algebra/);
  await expect(sidebar.locator('button[aria-current="page"]')).toHaveText("线性代数");
});
