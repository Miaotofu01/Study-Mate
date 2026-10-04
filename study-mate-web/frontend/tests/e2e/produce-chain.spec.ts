import { expect, test } from "@playwright/test";

import { fillGenerateWizard, openNodeDetail } from "./helpers";

const SUBJECT = "e2e-produce-course";

test("produce lessons in curriculum order with stage progress and gate", async ({ page }) => {
  // 4 次导航 + 3 次产课（每次渲染/检查两个真实子进程），预算放宽
  test.setTimeout(180_000);
  // 幂等：上一轮残留的同名科目会撞 409
  await page.request.delete(`/api/courses/${SUBJECT}`);
  // 用 AI 向导先建一门带 fixture 大纲的科目（demo.intro/core/lab 三节点，无课件）
  await page.goto("/chat");
  await page.getByTitle("新科目").click();
  await page.getByText("用 AI 向导生成科目").click();
  await expect(page).toHaveURL(/\/generate/);
  await fillGenerateWizard(page, "E2E Produce Course");
  await page.getByRole("button", { name: "生成课程大纲" }).click();
  await expect(page).toHaveURL(/\/courses\?subject=e2e-produce-course/, { timeout: 30_000 });

  // 上游检查器要求课件编号连续：跳过前两课直接产实验课会被拒
  await openNodeDetail(page, SUBJECT, "阶段实验");
  await page.getByTestId("produce-button").click();
  await expect(page.getByTestId("produce-error")).toContainText("按大纲顺序产课");

  // 按顺序产第一课：讲解 → 出题 → 渲染 → 检查（fixture 交付必过质检）
  await openNodeDetail(page, SUBJECT, "课程绪论");
  await expect(page.getByTestId("produce-button")).toBeVisible();
  await page.getByTestId("produce-button").click();
  await expect(page.getByTestId("produce-progress")).toBeVisible();
  await expect(page.getByTestId("produce-done")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "打开课件" })).toBeVisible();

  // 第二课（实操课）：fixture 连带 lab 任务与 solutions
  await openNodeDetail(page, SUBJECT, "核心方法");
  await page.getByTestId("produce-button").click();
  await expect(page.getByTestId("produce-done")).toBeVisible({ timeout: 60_000 });
});
