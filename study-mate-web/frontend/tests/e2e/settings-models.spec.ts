import { expect, test } from "@playwright/test";

const PROVIDER_NAME = "模型实验室";

test("model rows expose four actions, the edit dialog and the chat-side reasoning tier dropdown", async ({
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

  // 工具调用默认开启、无开关；这里用仍在的「JSON Schema 输出」验证能力开关可切换
  const capability = dialog.getByRole("checkbox", { name: "JSON Schema 输出" });
  await capability.click();
  await expect(capability).toHaveAttribute("aria-checked", "true");

  await dialog.getByRole("switch", { name: "启用推理档位" }).click();
  await expect(dialog.getByRole("switch", { name: "启用推理档位" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // 启用后默认预置 disabled / enabled 两档，默认档位取最高档（enabled）
  const chipInputs = dialog.locator("input[data-reasoning-variant-input]");
  await expect(chipInputs).toHaveCount(2);
  await expect(dialog.getByRole("combobox", { name: "默认档位" })).toHaveValue("enabled");

  // 再追加三档并改名，验证 chip 编辑器可增改
  await dialog.getByRole("button", { name: "添加档位" }).click();
  await chipInputs.nth(2).fill("low");
  await dialog.getByRole("button", { name: "添加档位" }).click();
  await chipInputs.nth(3).fill("medium");
  await dialog.getByRole("button", { name: "添加档位" }).click();
  await chipInputs.nth(4).fill("high");
  await expect(chipInputs).toHaveCount(5);

  // 默认档位从档位列表里选
  await dialog.getByRole("combobox", { name: "默认档位" }).selectOption("high");
  await page.getByRole("button", { name: "保存模型" }).click();

  // 实时生效：无需再点「保存」，左侧列表里该提供商已在
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
  // 对话侧：停用模型不出现；模型弹层已不再承载档位 chip，档位走输入区旁的独立下拉
  await expect(page.getByRole("button", { name: /lab-base/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /视觉实验室/ })).toBeVisible();

  // 先收起模型弹层：它的 fixed 遮罩（z-30）会挡住旁边新加的档位下拉
  await page.mouse.click(4, 4);
  await expect(page.getByRole("button", { name: /视觉实验室/ })).toHaveCount(0);

  // 档位下拉：当前档位（模型默认 high）显示在触发按钮上，展开后当前项打勾高亮
  const tierTrigger = page.getByTitle("切换推理档位");
  await expect(tierTrigger).toContainText("思考 · high");
  await tierTrigger.click();
  const tierMenu = page.getByTestId("reasoning-variant-menu");
  await expect(tierMenu.getByRole("button", { name: "high", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // 选 low 落盘：触发按钮文案即时更新，刷新后仍保持（settings 已写回服务端）
  await tierMenu.getByRole("button", { name: "low", exact: true }).click();
  await expect(tierTrigger).toContainText("思考 · low");
  await page.reload();
  await expect(page.getByTitle("切换推理档位")).toContainText("思考 · low");

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
