import { expect, test } from "@playwright/test";

const PROVIDER_NAME = "模型实验室";

test("model rows expose four actions, the edit dialog and the chat-side thinking tier", async ({
  page,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/settings/providers");

  // 自包含地造一个自定义提供商，断言完在用例尾部删净，避免污染同一 run 的其它用例
  await page.getByRole("button", { name: "添加提供商" }).click();
  await page.getByRole("button", { name: "自定义" }).click();
  await page.getByLabel("名称").fill(PROVIDER_NAME);
  await page.getByLabel("Base URL").fill("https://lab.example.com/v1");
  await page.getByLabel(/API Key/).fill("sk-lab-test");

  await page.getByRole("button", { name: "添加模型" }).click();
  await page.getByRole("dialog").getByLabel("模型 ID", { exact: true }).fill("lab-base");
  await page.getByRole("button", { name: "保存模型" }).click();

  // 第二个模型走完整弹窗：模态复选框组 + 最大输出 Token + 高级区推理档位
  await page.getByRole("button", { name: "添加模型" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("模型 ID", { exact: true }).fill("lab-vision");
  await dialog.getByLabel("显示名", { exact: true }).fill("视觉实验室");
  await dialog.getByLabel("上下文长度", { exact: true }).fill("1000000");
  await dialog.getByLabel("最大输出 Token", { exact: true }).fill("8192");

  // 模态是复选框组（role=checkbox 的按钮），不是下拉
  const imageModality = dialog.getByRole("checkbox", { name: "图片" });
  await expect(imageModality).toHaveAttribute("aria-checked", "false");
  await expect(dialog.getByRole("combobox", { name: "模态" })).toHaveCount(0);
  await imageModality.click();
  await expect(imageModality).toHaveAttribute("aria-checked", "true");

  // 高级：ChevronRight 折叠区，展开后是推理档位 chip 编辑器 + 能力声明开关
  const advancedToggle = dialog.getByRole("button", { name: "高级" });
  await expect(advancedToggle).toHaveAttribute("aria-expanded", "false");
  await advancedToggle.click();
  await expect(advancedToggle).toHaveAttribute("aria-expanded", "true");

  const capability = dialog.getByRole("checkbox", { name: "工具调用" });
  await capability.click();
  await expect(capability).toHaveAttribute("aria-checked", "true");

  await dialog.getByRole("switch", { name: "启用推理档位" }).click();
  await expect(dialog.getByRole("switch", { name: "启用推理档位" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  const chipInputs = dialog.locator("input[data-reasoning-variant-input]");
  await dialog.getByRole("button", { name: "添加档位" }).click();
  await chipInputs.nth(0).fill("off");
  await dialog.getByRole("button", { name: "添加档位" }).click();
  await chipInputs.nth(1).fill("low");
  await dialog.getByRole("button", { name: "添加档位" }).click();
  await chipInputs.nth(2).fill("high");
  await expect(chipInputs).toHaveCount(3);

  // 默认档位从档位列表里选
  await dialog.getByRole("combobox", { name: "默认档位" }).selectOption("high");
  await page.getByRole("button", { name: "保存模型" }).click();

  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("button", { name: new RegExp(PROVIDER_NAME) })).toBeVisible();

  // API Key 落盘后回填输入框（真实值，密码点显示）
  const keyInput = page.getByLabel(/API Key/);
  await expect(keyInput).toHaveValue("sk-lab-test");
  await expect(keyInput).toHaveAttribute("type", "password");
  await page.getByTitle("显示密钥").click();
  await expect(keyInput).toHaveAttribute("type", "text");
  await page.getByTitle("隐藏密钥").click();
  await expect(keyInput).toHaveAttribute("type", "password");
  await expect(page.getByPlaceholder("已保存，留空则不修改")).toHaveCount(0);

  // 只读摘要行：上下文徽标 / 模态徽标 / 推理档位徽标 + 显示名回退
  await expect(page.getByText("1M")).toBeVisible();
  await expect(page.getByText("视觉", { exact: true })).toBeVisible();
  await expect(page.getByText("思考 · high")).toBeVisible();

  // 模型行 4 个操作：测试 / 编辑 / 删除 / 启用开关
  await expect(page.getByTitle("测试 lab-vision")).toBeVisible();
  await expect(page.getByTitle("编辑 lab-vision")).toBeVisible();
  await expect(page.getByTitle("删除 lab-vision")).toBeVisible();
  await expect(page.getByTitle("启用或停用模型 lab-vision")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // 单模型测试：输入框里是回填的真实 Key，fixture 拦截上游拿到连通结果
  await page.getByTitle("测试 lab-vision").click();
  await expect(page.getByText(/连接成功 · \d+ ms/)).toBeVisible();

  // 停用 lab-base 后行内出现「已停用」，开关翻假
  await page.getByTitle("启用或停用模型 lab-base").click();
  await expect(page.getByTitle("启用或停用模型 lab-base")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.getByText("已停用")).toHaveCount(1);

  // 提供商级开关：停用后左列出现「已停用」徽标，再启用恢复
  await page.getByTitle("启用或停用提供商").click();
  await expect(page.getByTitle("启用或停用提供商")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("已停用")).toHaveCount(2);
  await page.getByTitle("启用或停用提供商").click();
  await expect(page.getByTitle("启用或停用提供商")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("已停用")).toHaveCount(1);

  // 设为当前使用：激活时跳过已停用模型，落到支持推理的 lab-vision
  await page.getByTitle("更多操作").click();
  await page.getByRole("button", { name: "设为当前使用" }).click();
  await expect(page.getByText("使用中")).toBeVisible();

  await page.goto("/chat");
  const modelSwitch = page.getByTitle("切换当前使用的提供商 / 模型");
  await expect(modelSwitch).toContainText(`${PROVIDER_NAME} / lab-vision`);

  await modelSwitch.click();
  // 对话侧：停用模型不出现；档位按模型的 reasoning.variants 展示，默认档位高亮
  await expect(page.getByRole("button", { name: /lab-base/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /视觉实验室/ })).toBeVisible();
  await expect(page.getByText("思考档位")).toBeVisible();
  await expect(page.getByRole("button", { name: "high", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: "low", exact: true }).click();
  await modelSwitch.click();
  await expect(page.getByRole("button", { name: "low", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // 自清理：删掉本轮创建的提供商，当前使用回落到 DeepSeek
  await page.goto("/settings/providers");
  await page.getByRole("button", { name: new RegExp(PROVIDER_NAME) }).click();
  await page.getByTitle("更多操作").click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("button", { name: new RegExp(PROVIDER_NAME) })).toHaveCount(0);

  await page.goto("/chat");
  await expect(page.getByTitle("切换当前使用的提供商 / 模型")).toContainText(
    "DeepSeek / deepseek-chat",
  );
});
