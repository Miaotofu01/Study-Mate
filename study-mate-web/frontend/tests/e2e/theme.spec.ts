import { expect, test } from "@playwright/test";

test("theme toggle persists across reload", async ({ page }) => {
  await page.goto("/chat");

  // 问候语由客户端 effect 写入，确认水合完成后再点击
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  const toggle = page.getByTitle(/切换到/);
  await expect(toggle).toHaveAttribute("title", "切换到暗夜模式");

  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => localStorage.getItem("studymate-theme"))).toBe("dark");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByTitle("切换到亮色模式").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
