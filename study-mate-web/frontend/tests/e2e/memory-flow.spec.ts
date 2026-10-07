import fs from "node:fs";

import { expect, test } from "@playwright/test";

import { memoryFilePath } from "./constants";
import { expandRightRail, sendChatMessage } from "./helpers";

// 记忆写侧（I）：会话有消息后「沉淀记忆」→ suggest 提炼（fixture 2 条：教学偏好/学习习惯）
// → 逐条勾选写入 MEMORY.md；同条目后端去重，所以第二轮同条目不重复落盘。
//
// 2026-10-04 拍板：「沉淀记忆」入口暂时悬空（右栏会话关联区整段移除），前端暂时没有入口。
// 后端能力（/api/memory/suggest、/api/memory/confirm）与 MemoryDialog 组件都保留，
// 重新接入入口后删掉下面的 test.skip 即可恢复这两条用例。
const PARKED = "「沉淀记忆」入口已悬空（2026-10-04 拍板），待重新接入后恢复";
const PREFS_ENTRY = "讲解后偏好先看一次 HTTP 请求的实际例子再动手。";
const HABIT_ENTRY = "常见卡点：分层与封装的边界容易混。";

test("suggested memories are written into MEMORY.md only when selected", async ({ page }) => {
  test.skip(true, PARKED);
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");
  const sidebar = page.getByTestId("chat-right-sidebar");

  // 入口态：会话没有消息时禁用
  await expect(sidebar.getByTestId("memory-entry")).toBeDisabled();

  await sendChatMessage(page, "把分层模型再讲一遍");
  // 新对话默认折叠右栏：发完消息后展开，才能点「沉淀记忆」
  await expandRightRail(page);
  await expect(sidebar.getByTestId("memory-entry")).toBeEnabled();
  await sidebar.getByTestId("memory-entry").click();

  const dialog = page.getByTestId("memory-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "写入这条记忆" })).toHaveCount(2);
  await expect(dialog.getByTestId("memory-confirm")).toHaveText("写入记忆（2）");

  // 取消勾选第二条：只写勾中的那条
  await dialog.getByRole("checkbox", { name: "写入这条记忆" }).nth(1).uncheck();
  await expect(dialog.getByTestId("memory-confirm")).toHaveText("写入记忆（1）");
  await dialog.getByTestId("memory-confirm").click();

  const result = dialog.getByTestId("memory-result");
  await expect(result).toContainText("已写入 1 条记忆");
  await expect(result).toContainText(memoryFilePath());

  const memory = fs.readFileSync(memoryFilePath(), "utf-8");
  // 条目要落在「教学偏好」分节内（分节标题由模板自带，只断言标题没有判别力）
  const prefsSection = memory.split("## 教学偏好")[1]?.split("\n## ")[0] ?? "";
  expect(prefsSection).toContain(`- ${PREFS_ENTRY}`);
  expect(memory).not.toContain(HABIT_ENTRY);

  // 重开再来一轮（幂等）：同条目后端去重，只有新勾的第二条真正落盘
  await dialog.getByRole("button", { name: "完成" }).click();
  await expect(dialog).toHaveCount(0);
  await sidebar.getByTestId("memory-entry").click();

  const second = page.getByTestId("memory-dialog");
  await expect(second.getByRole("checkbox", { name: "写入这条记忆" })).toHaveCount(2);
  await second.getByTestId("memory-confirm").click();
  await expect(second.getByTestId("memory-result")).toContainText("已写入 1 条记忆");

  const memoryAgain = fs.readFileSync(memoryFilePath(), "utf-8");
  expect(memoryAgain).toContain(`- ${HABIT_ENTRY}`);
  expect(memoryAgain.split(`- ${PREFS_ENTRY}`).length - 1).toBe(1);
  await second.getByRole("button", { name: "完成" }).click();
});

// adverse：建议为空（本会话没有值得沉淀的内容）时空态 + 确认按钮禁用，不静默写空
test("an empty suggestion list shows the empty state and keeps confirm disabled", async ({ page }) => {
  test.skip(true, PARKED);
  await page.route("**/api/memory/suggest", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, entries: [] }),
    }),
  );
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");
  await sendChatMessage(page, "这次没什么值得长期记住的");
  await expandRightRail(page);

  await page.getByTestId("chat-right-sidebar").getByTestId("memory-entry").click();
  const dialog = page.getByTestId("memory-dialog");
  await expect(dialog.getByTestId("memory-empty")).toBeVisible();
  await expect(dialog.getByTestId("memory-confirm")).toBeDisabled();
  await expect(dialog.getByTestId("memory-result")).toHaveCount(0);
});
