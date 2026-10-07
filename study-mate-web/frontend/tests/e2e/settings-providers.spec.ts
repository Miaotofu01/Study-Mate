import { expect, test } from "@playwright/test";

test("add a custom provider, activate it and see it in the chat bar", async ({ page }) => {
  await page.goto("/settings/providers");

  await page.getByRole("button", { name: "添加提供商" }).click();
  await page.getByRole("button", { name: "自定义" }).click();

  await page.getByLabel("名称").fill("我的中转");
  await page.getByLabel("Base URL").fill("https://relay.example.com/v1");
  await page.getByLabel("API 格式").selectOption("anthropic");

  // 自定义提供商初始没有模型，第一个模型走编辑弹窗
  await page.getByRole("button", { name: "添加模型" }).click();
  await page.getByRole("dialog").getByLabel("模型 ID").fill("relay-pro");
  await page.getByRole("button", { name: "保存模型" }).click();

  // 实时生效：无需点「保存」，左侧列表已出现
  await expect(page.getByRole("button", { name: /我的中转/ })).toBeVisible();

  await page.getByTitle("更多操作").click();
  await page.getByRole("button", { name: "设为当前使用" }).click();
  await expect(page.getByText("使用中")).toBeVisible();

  await page.goto("/chat");
  await expect(page.getByTitle("切换当前使用的提供商 / 模型")).toContainText(
    "我的中转 / relay-pro",
  );
});

test("delete a custom provider and the active falls back to the first remaining", async ({
  page,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/settings/providers");

  await page.getByRole("button", { name: "添加提供商" }).click();
  await page.getByRole("button", { name: "自定义" }).click();
  await page.getByLabel("名称").fill("待删除中转");
  await page.getByLabel("Base URL").fill("https://to-delete.example.com/v1");
  await page.getByRole("button", { name: "添加模型" }).click();
  await page.getByRole("dialog").getByLabel("模型 ID").fill("tmp-model");
  await page.getByRole("button", { name: "保存模型" }).click();
  await expect(page.getByRole("button", { name: /待删除中转/ })).toBeVisible();

  await page.getByTitle("更多操作").click();
  await page.getByRole("button", { name: "设为当前使用" }).click();
  await expect(page.getByText("使用中")).toBeVisible();

  await page.getByTitle("更多操作").click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("button", { name: /待删除中转/ })).toHaveCount(0);

  await page.goto("/chat");
  await expect(page.getByTitle("切换当前使用的提供商 / 模型")).toContainText(
    "DeepSeek / deepseek-chat",
  );
});

test("restore default resets preset fields", async ({ page }) => {
  await page.goto("/settings/providers");

  await page.getByRole("button", { name: /SiliconFlow/ }).click();
  await page.getByLabel("Base URL").fill("https://mirror.example.com/v1");

  // 先用弹窗把默认模型改掉，验证「恢复默认」会连模型一起重置
  await page.getByTitle("编辑 deepseek-ai/DeepSeek-V3").click();
  await page.getByRole("dialog").getByLabel("模型 ID").fill("custom-mirror-model");
  await page.getByRole("button", { name: "保存模型" }).click();
  await expect(page.getByTitle("编辑 custom-mirror-model")).toBeVisible();

  await page.getByTitle("更多操作").click();
  await page.getByRole("button", { name: "恢复默认" }).click();

  await expect(page.getByLabel("Base URL")).toHaveValue("https://api.siliconflow.cn/v1");
  await expect(page.getByTitle("编辑 deepseek-ai/DeepSeek-V3")).toBeVisible();
  await expect(page.getByTitle("编辑 custom-mirror-model")).toHaveCount(0);
});

// 连接测试入口收敛到模型行内的「测试」按钮（底部「测试连接」已随实时生效一并移除）
test("testing a model without an api key reports the error", async ({ page }) => {
  await page.goto("/settings/providers");

  await page.getByRole("button", { name: /SiliconFlow/ }).click();
  await page.getByLabel("Base URL").fill("http://10.255.255.1:9/v1");
  await page.getByTitle("测试 deepseek-ai/DeepSeek-V3").click();

  await expect(page.getByText("缺少 API Key")).toBeVisible();
});

test("a model test surfaces an upstream failure for an unreachable address", async ({ page }) => {
  await page.route("**/api/settings/test", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ detail: "APIConnectionError: Connection error." }),
    }),
  );
  await page.goto("/settings/providers");

  await page.getByRole("button", { name: /SiliconFlow/ }).click();
  await page.getByLabel("Base URL").fill("http://10.255.255.1:9/v1");
  await page.getByLabel(/API Key/).fill("sk-e2e-unreachable");
  await page.getByTitle("测试 deepseek-ai/DeepSeek-V3").click();

  await expect(page.getByText("APIConnectionError: Connection error.")).toBeVisible();
  await expect(page.getByText("连接成功")).toHaveCount(0);
});

test("a stored api key is backfilled into the input and drives the connection test", async ({
  page,
}) => {
  await page.goto("/settings/providers");

  // fixture 里只有 DeepSeek 存了 Key：选中后输入框应回填真实 Key，而不是掩码占位
  await page.getByRole("button", { name: /DeepSeek/ }).click();
  const keyInput = page.getByLabel(/API Key/);
  await expect(keyInput).toHaveAttribute("type", "password");
  await expect(keyInput).not.toHaveValue("");
  await expect(page.getByPlaceholder("已保存，留空则不修改")).toHaveCount(0);

  // 眼睛切换明文 / 掩码
  await page.getByTitle("显示密钥").click();
  await expect(keyInput).toHaveAttribute("type", "text");
  await page.getByTitle("隐藏密钥").click();
  await expect(keyInput).toHaveAttribute("type", "password");

  // 回填的 Key 参与模型连接测试（fixture 模式不外呼上游）
  await page.getByTitle("测试 deepseek-chat").click();
  await expect(page.getByText(/连接成功 · \d+ ms/)).toBeVisible();
  await expect(page.getByText("缺少 API Key")).toHaveCount(0);
});

test("clearing the api key still falls back to the stored one for connection tests", async ({
  page,
}) => {
  await page.goto("/settings/providers");

  // 输入框清空时不再填充占位文案，后端回落已存 Key（fixture 只有 DeepSeek 存了 Key）
  await page.getByRole("button", { name: /DeepSeek/ }).click();
  const keyInput = page.getByLabel(/API Key/);
  await expect(keyInput).not.toHaveValue("");
  await keyInput.fill("");
  await expect(keyInput).toHaveValue("");

  await page.getByTitle("测试 deepseek-chat").click();
  await expect(page.getByText(/连接成功 · \d+ ms/)).toBeVisible();
  await expect(page.getByText("缺少 API Key")).toHaveCount(0);
});
