import path from "node:path";

import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import { BACKEND_URL, E2E_DATA_DIR, E2E_WORKSPACE_DIR } from "./constants";

// 新会话的工作区入口（2026-10-04 拍板）：原「欢迎区引导块」整块移除，工作区选择移到
// 输入区上方的关联行；换到空工作区后科目列表为空。用例自己切走再切回（finally 兜底）。
const EMPTY_WS = path.join(E2E_DATA_DIR, "empty-ws");

async function switchWorkspace(request: APIRequestContext, target: string): Promise<void> {
  const response = await request.put(`${BACKEND_URL}/api/workspace`, { data: { path: target } });
  expect(response.status()).toBe(200);
}

test("the new-conversation association row reflects the current workspace", async ({
  page,
  request,
}) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  const row = page.getByTestId("new-session-association");
  await expect(row).toBeVisible();
  const subjectSelect = row.getByTitle("关联科目", { exact: true });
  const workspaceSelect = row.getByTitle("关联工作区", { exact: true });

  // 默认「不选」= 当前默认工作区（fixture 工作区，含科目）
  await expect(workspaceSelect).toHaveValue("");
  await expect(subjectSelect.locator("option", { hasText: "计算机网络" })).toHaveCount(1);

  try {
    // 换到空工作区：科目列表变空（只剩「不关联」），左侧边栏显示暂无科目
    await switchWorkspace(request, EMPTY_WS);
    await page.reload();
    await expect(page.getByTestId("new-session-association")).toBeVisible();
    await expect(page.locator("aside").first().getByText("暂无科目")).toBeVisible();
  } finally {
    await switchWorkspace(request, E2E_WORKSPACE_DIR);
  }
});
