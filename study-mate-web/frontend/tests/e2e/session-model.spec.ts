import { expect, test } from "@playwright/test";

import { BACKEND_URL } from "./constants";
import { sendChatMessage } from "./helpers";

/**
 * 会话级模型/档位（2026-10-04）：每个会话持久化自己选的模型与思考档位。
 *
 * 口径：会话内切换 → 只写该会话的绑定（全局默认不动）；新对话态切换 → 仍写全局默认。
 * 刷新后重开会话仍是该会话的模型（会话级持久化）。
 */

/** 计数 PATCH /api/sessions/<id>（会话绑定写入）与 PUT /api/settings（全局默认写入） */
async function countWrites(page: import("@playwright/test").Page) {
  const counters = { sessionPatches: 0, globalWrites: 0 };
  await page.route(/\/api\/sessions\/[^/]+$/, async (route) => {
    if (route.request().method() === "PATCH") counters.sessionPatches += 1;
    await route.continue();
  });
  await page.route(/\/api\/settings$/, async (route) => {
    if (route.request().method() === "PUT") counters.globalWrites += 1;
    await route.continue();
  });
  return counters;
}

test("switching the model inside a session binds that session only", async ({
  page,
  request,
}) => {
  const counters = await countWrites(page);
  const before = await (await request.get(`${BACKEND_URL}/api/settings`)).json();
  const globalBefore = { provider_id: before.active.provider_id, model: before.active.model };

  await page.goto("/chat");
  await sendChatMessage(page, "会话内换模型");

  const modelSwitch = page.getByTitle("切换当前使用的提供商 / 模型");
  await expect(modelSwitch).toContainText("DeepSeek / deepseek-chat");
  await modelSwitch.click();
  await page.getByRole("button", { name: "deepseek-ai/DeepSeek-V3", exact: true }).click();
  await expect(modelSwitch).toContainText("SiliconFlow / deepseek-ai/DeepSeek-V3");

  // 写的是会话绑定，不是全局默认
  expect(counters.sessionPatches, "应 PATCH 会话绑定").toBeGreaterThan(0);
  expect(counters.globalWrites, "会话内切换不该改全局默认").toBe(0);
  const settings = await (await request.get(`${BACKEND_URL}/api/settings`)).json();
  expect(settings.active.provider_id).toBe(globalBefore.provider_id);
  expect(settings.active.model).toBe(globalBefore.model);

  // 落盘到会话 JSON
  const metas = (await (await request.get(`${BACKEND_URL}/api/sessions`)).json()) as Array<{
    id: string;
    title: string;
  }>;
  const meta = metas.find((m) => m.title.startsWith("会话内换模型"));
  expect(meta, "会话应已落盘").toBeDefined();
  const session = (await (await request.get(`${BACKEND_URL}/api/sessions/${meta!.id}`)).json()) as {
    active: { provider_id: string; model: string } | null;
  };
  expect(session.active).toEqual({
    provider_id: "siliconflow",
    model: "deepseek-ai/DeepSeek-V3",
    reasoning_variant: null,
  });

  // 后端确实用绑定模型跑这一轮：直接打 chat/stream，落库的 model 标识应是绑定的那个
  // （fixture 模式下不外呼上游，因此"绑定到没有 key 的提供商"也能验）
  const streamed = await request.post(`${BACKEND_URL}/api/chat/stream`, {
    data: { message: "绑定后这一轮", session_id: meta!.id },
  });
  expect(streamed.ok()).toBeTruthy();
  const after = (await (await request.get(`${BACKEND_URL}/api/sessions/${meta!.id}`)).json()) as {
    messages: Array<{ role: string; model?: string }>;
  };
  expect(after.messages[after.messages.length - 1].model).toBe(
    "SiliconFlow / deepseek-ai/DeepSeek-V3",
  );

  // 刷新后重开会话：仍是该会话选的模型
  await page.reload();
  await page.locator("aside").first().getByText("会话内换模型").click();
  await expect(page.getByTitle("切换当前使用的提供商 / 模型")).toContainText(
    "SiliconFlow / deepseek-ai/DeepSeek-V3",
  );
  // 绑到没配 key 的提供商 → 输入框如实禁用（不再"看着可用、一发就错"）
  await expect(page.getByRole("textbox")).toBeDisabled();
});

test("switching the model in a new conversation still updates the global default", async ({
  page,
  request,
}) => {
  const counters = await countWrites(page);
  await page.goto("/chat");

  // 新对话态：改的是全局默认
  await page.getByTitle("切换当前使用的提供商 / 模型").click();
  await page.getByRole("button", { name: "qwen-plus", exact: true }).click();
  await expect(page.getByTitle("切换当前使用的提供商 / 模型")).toContainText(
    "DashScope / qwen-plus",
  );
  expect(counters.globalWrites, "新对话态切换应写全局默认").toBeGreaterThan(0);
  expect(counters.sessionPatches, "新对话态还没有会话可绑").toBe(0);
  const settings = await (await request.get(`${BACKEND_URL}/api/settings`)).json();
  expect(settings.active.model).toBe("qwen-plus");

  // 收尾：仍是新对话态，把全局默认改回 DeepSeek，避免影响后续用例
  await page.getByTitle("切换当前使用的提供商 / 模型").click();
  await page.getByRole("button", { name: "deepseek-chat", exact: true }).click();
  await expect(page.getByTitle("切换当前使用的提供商 / 模型")).toContainText(
    "DeepSeek / deepseek-chat",
  );
});
