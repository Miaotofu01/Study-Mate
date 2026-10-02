import { expect, test } from "@playwright/test";

test("grading panel lists quiz items and grades an open answer", async ({ page }) => {
  await page.goto("/lesson?subject=computer-networks&node=net.layers");
  await page.getByRole("button", { name: "判分面板" }).click();

  const panel = page.locator("aside");
  await expect(panel.locator("div.rounded-xl.border")).toHaveCount(5);
  await expect(panel.getByText("页内判分")).toHaveCount(2);
  await expect(panel.getByText("✓ 正确答案")).toHaveCount(2);
  await expect(panel.getByPlaceholder("在此作答，然后提交判分…")).toHaveCount(3);

  const openItem = panel
    .locator("div.rounded-xl.border")
    .filter({ hasText: "请举一个跨层的例子" });
  await expect(openItem).toHaveCount(1);
  await openItem.getByPlaceholder("在此作答，然后提交判分…").fill("我全都懂了，没什么问题");
  await openItem.getByRole("button", { name: "提交判分" }).click();

  const result = openItem.locator("div.rounded-lg.border");
  await expect(result.getByText("部分通过", { exact: true })).toBeVisible();
  await expect(result.getByText("证据引用")).toBeVisible();
  await expect(result.getByText("作答里逐字提到了封装，对上了判分要点一")).toBeVisible();
  await expect(result.getByText("缺口")).toBeVisible();
  await expect(result.getByText("判分要点二在作答里引用不出证据")).toBeVisible();
  await expect(result.getByText("把第二点也说清楚即可通过。")).toBeVisible();

  // 再提交一次：fixture 内容固定，断言结果块被整体替换而不是追加残留
  await openItem
    .getByPlaceholder("在此作答，然后提交判分…")
    .fill("封装是上层整份内容当作载荷，前面加上本层首部，逐层套下去");
  await openItem.getByRole("button", { name: "提交判分" }).click();
  await expect(openItem.locator("div.rounded-lg.border")).toHaveCount(1);
  await expect(openItem.getByText("把第二点也说清楚即可通过。")).toHaveCount(1);
  await expect(result.getByText("部分通过", { exact: true })).toBeVisible();
});
