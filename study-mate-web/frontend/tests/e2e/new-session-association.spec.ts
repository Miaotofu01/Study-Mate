import { expect, test } from "@playwright/test";

import { BACKEND_URL, E2E_WORKSPACE_DIR } from "./constants";
import { associateSubject, associateWorkspace, sendChatMessage } from "./helpers";

// 会话级工作区（2026-10-04 拍板甲）：新对话态的输入区上方有「科目 + 工作区」关联行；
// 工作区默认「不选」= 当前默认工作区；选了之后科目列表来自该工作区，会话把它记进元数据。
test("a new conversation can bind a workspace and the session remembers it", async ({
  page,
  request,
}) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  const row = page.getByTestId("new-session-association");
  await expect(row).toBeVisible();
  const workspaceSelect = row.getByTitle("关联工作区", { exact: true });
  const subjectSelect = row.getByTitle("关联科目", { exact: true });

  // 默认不选工作区；候选里能选到 fixture 的工作区绝对路径
  await expect(workspaceSelect).toHaveValue("");
  await expect(workspaceSelect.locator("option").first()).toHaveText("默认工作区");
  await expect(
    workspaceSelect.locator("option", { hasText: E2E_WORKSPACE_DIR }),
  ).toHaveCount(1);

  // 显式绑到 fixture 工作区：科目列表按该工作区重载
  await associateWorkspace(page, E2E_WORKSPACE_DIR);
  await expect(subjectSelect.locator("option", { hasText: "计算机网络" })).toHaveCount(1);

  await associateSubject(page, "computer-networks");
  await sendChatMessage(page, "工作区绑定的会话");

  // 会话元数据带上 workspace 与科关联
  const metasRes = await request.get(`${BACKEND_URL}/api/sessions`);
  const metas = (await metasRes.json()) as Array<{
    id: string;
    title: string;
    workspace?: string | null;
  }>;
  const meta = metas.find((m) => m.title === "工作区绑定的会话");
  expect(meta, "会话应已落盘").toBeDefined();
  const sessionRes = await request.get(`${BACKEND_URL}/api/sessions/${meta!.id}`);
  const session = (await sessionRes.json()) as {
    workspace?: string | null;
    subject_slug?: string | null;
  };
  expect(session.workspace?.toLowerCase()).toBe(E2E_WORKSPACE_DIR.toLowerCase());
  expect(session.subject_slug).toBe("computer-networks");

  // 已有会话：关联行隐藏
  await expect(page.getByTestId("new-session-association")).toHaveCount(0);
});
