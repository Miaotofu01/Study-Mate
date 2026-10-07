import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { E2E_DATA_DIR } from "./constants";
import { openNodeDetail } from "./helpers";

test("export the static workspace and verify generated files", async ({ page }) => {
  await openNodeDetail(page, "computer-networks", "1. 分层模型与封装");
  await page.getByRole("button", { name: "导出静态工作区" }).click();

  const float = page.locator("div.w-80", { hasText: "导出完成" });
  await expect(float).toBeVisible({ timeout: 30_000 });
  await expect(float.getByText(/共 [1-9]\d* 个页面/)).toBeVisible();
  await expect(float.locator("code")).toContainText(/exports.+computer-networks/);

  const exportRoot = path.join(E2E_DATA_DIR, "exports", "computer-networks");
  expect(fs.existsSync(path.join(exportRoot, "index.html"))).toBe(true);
  expect(
    fs.existsSync(path.join(exportRoot, ".learning", "subjects", "computer-networks", "index.html")),
  ).toBe(true);
});

test("export failure shows the error detail in the float", async ({ page }) => {
  await openNodeDetail(page, "computer-networks", "1. 分层模型与封装");
  await page.route("**/api/courses/computer-networks/export", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ detail: "导出失败（退出码 1）：模拟 gen_home 崩溃" }),
    }),
  );
  await page.getByRole("button", { name: "导出静态工作区" }).click();

  await expect(page.getByText("导出失败（退出码 1）：模拟 gen_home 崩溃")).toBeVisible();
  await expect(page.getByText("导出完成")).toHaveCount(0);
});
