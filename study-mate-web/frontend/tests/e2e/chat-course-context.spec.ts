import { expect, test } from "@playwright/test";

import { BACKEND_URL, STREAM_VISIBLE_SEGMENTS } from "./constants";
import { associateSubject, expandRightRail, sendChatMessage } from "./helpers";

test("chat with course context binds the subject and keeps it locked", async ({
  page,
  request,
}) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  await associateSubject(page, "computer-networks");
  await sendChatMessage(page, "继续学这一节");

  const topBarTitle = page.getByTestId("chat-title");
  await expect(topBarTitle).toHaveText("继续学这一节");
  await expect(page.getByTitle("发送")).toBeVisible();
  await expect(page.getByRole("textbox")).toBeEnabled();

  await sendChatMessage(page, "再讲细一点");
  await expect(page.getByText(STREAM_VISIBLE_SEGMENTS[0])).toHaveCount(2);

  // 绑死语义（2026-10-04）：已有会话不再显示新对话关联行 → 会话中途无法改科目
  await expect(page.getByTestId("new-session-association")).toHaveCount(0);

  // 切到新会话：关联行回来且复位「不关联」
  await page.getByTitle("新对话").click();
  await expect(topBarTitle).toHaveText("新的对话");
  const subjectSelect = page.getByTitle("关联科目", { exact: true });
  await expect(subjectSelect).toHaveValue("");
  await expect(subjectSelect).toBeEnabled();
  // 会话列表在左侧边栏（aside 第一个）
  await page.locator("aside").first().getByText("继续学这一节").click();
  await expect(topBarTitle).toHaveText("继续学这一节");
  await expect(page.getByText("再讲细一点")).toBeVisible();
  // 绑定从会话元数据恢复：关联行随会话隐藏，改由右栏「会话信息」回显
  await expect(page.getByTestId("new-session-association")).toHaveCount(0);
  await expandRightRail(page);
  await expect(page.getByTestId("session-subject")).toHaveText("计算机网络");

  const metasRes = await request.get(`${BACKEND_URL}/api/sessions`);
  const metas = (await metasRes.json()) as Array<{ id: string; title: string }>;
  const meta = metas.find((m) => m.title === "继续学这一节");
  expect(meta, "会话应已落盘").toBeDefined();
  const sessionRes = await request.get(`${BACKEND_URL}/api/sessions/${meta!.id}`);
  const session = (await sessionRes.json()) as {
    subject_slug: string | null;
    node_id: string | null;
    messages: Array<{ role: string; content: string }>;
  };
  expect(session.subject_slug).toBe("computer-networks");
  // 节点不再由前端指定（自动推断只作用于注入，不落盘）
  expect(session.node_id).toBeNull();
  expect(session.messages).toHaveLength(4);
  expect(session.messages[0].role).toBe("user");
  expect(session.messages[0].content).toBe("继续学这一节");
  expect(session.messages[1].role).toBe("assistant");
});
