import { expect, test } from "@playwright/test";

import { openNodeDetail } from "./helpers";

test("lesson iframe quiz scores inline and navigates to the next lesson", async ({ page }) => {
  await openNodeDetail(page, "computer-networks", "1. 分层模型与封装");
  await page.getByRole("button", { name: "打开课件" }).click();
  await expect(page).toHaveURL(/\/lesson\?subject=computer-networks&node=net\.layers/);

  const frame = page.frameLocator("iframe");
  await expect(frame.locator("h1")).toHaveText("分层模型与封装");

  // 第一组选择题：点错标红并出现「✗ 再想想」，改选对的标绿并给出 why
  const firstGroup = frame.locator(".quiz").first();
  const opts = firstGroup.locator(".quiz__opt");
  await opts.nth(1).click();
  await expect(opts.nth(1)).toHaveClass(/is-wrong/);
  await expect(firstGroup.locator(".feedback")).toContainText("✗ 再想想");

  await opts.nth(0).click();
  await expect(opts.nth(0)).toHaveClass(/is-correct/);
  await expect(firstGroup.locator(".feedback")).toContainText("✓ 对");
  await expect(firstGroup.locator(".feedback")).toContainText("域名解析由应用层的 DNS 完成");

  // 注入的双选择题题组：全组答完后出现组计分行（quiz.js 真实判分）
  const scoredGroup = frame.locator(".quiz").last();
  await scoredGroup.locator(".quiz__opt").nth(0).click();
  await scoredGroup.locator(".quiz__opt").nth(5).click();
  await expect(scoredGroup.locator(".quiz__score")).toHaveText("本题组：答对 1 / 2");
  await expect(scoredGroup.locator(".feedback").last()).toContainText("✗ 再想想");

  // 课件内「下一节」指针不断链
  await frame.locator(".lesson-nav__link--next").click();
  await expect
    .poll(() => page.frames().some((f) => f.url().includes("0002-net.link.html")))
    .toBe(true);
  await expect(frame.locator("h1")).toHaveText("链路层与以太网帧");
});
