import { expect, test } from "@playwright/test";

import { fillGenerateWizard } from "./helpers";

test("generate a subject via the AI wizard and land on its graph", async ({ page }) => {
  await page.goto("/chat");
  await page.getByTitle("新科目").click();
  await page.getByText("用 AI 向导生成科目").click();
  await expect(page).toHaveURL(/\/generate/);

  await fillGenerateWizard(page, "测试生成科目");
  await page.getByRole("button", { name: "生成课程大纲" }).click();

  await expect(page).toHaveURL(/\/courses\?subject=subject-[a-f0-9]{6}/, { timeout: 30_000 });
  await expect(page.getByRole("link", { name: /测试生成科目/ })).toBeVisible();
  for (const nodeId of ["demo.intro", "demo.core", "demo.lab"]) {
    await expect(page.getByTestId(`graph-node-${nodeId}`)).toBeVisible();
  }
  await expect(page.getByTitle("新科目")).toBeVisible();
  await expect(page.locator("aside").getByText("测试生成科目")).toBeVisible();
});

test("gate rejection 422 renders the problems list without navigating", async ({ page }) => {
  const problems = ["节点 demo.intro 缺少 objective", "第 1 条边的 to 引用了不存在的节点：'demo.nope'"];
  await page.route("**/api/courses/generate", (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ detail: "大纲未通过上游门禁", problems }),
    }),
  );
  await page.goto("/generate");

  await fillGenerateWizard(page, "测试生成科目");
  await page.getByRole("button", { name: "生成课程大纲" }).click();

  await expect(page.getByText("大纲被上游校验脚本拦截，可调整描述重试")).toBeVisible();
  for (const problem of problems) {
    await expect(page.getByText(problem)).toBeVisible();
  }
  await expect(page).toHaveURL(/\/generate/);
});

test("gate-external failure 500 renders a generic error instead of problems", async ({ page }) => {
  await page.route("**/api/courses/generate", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ detail: "大纲生成请求失败：APIConnectionError: connection refused" }),
    }),
  );
  await page.goto("/generate");

  await fillGenerateWizard(page, "测试生成科目");
  await page.getByRole("button", { name: "生成课程大纲" }).click();

  await expect(
    page.getByText("大纲生成请求失败：APIConnectionError: connection refused"),
  ).toBeVisible();
  await expect(page.getByText("大纲被上游校验脚本拦截，可调整描述重试")).toHaveCount(0);
  await expect(page).toHaveURL(/\/generate/);
});
