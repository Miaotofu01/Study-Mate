import { expect, test } from "@playwright/test";

import { BACKEND_URL, STREAM_SEGMENTS } from "./constants";
import { associateSubjectNode, sendChatMessage } from "./helpers";

test("chat with course context writes subject/node back into the session", async ({
  page,
  request,
}) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  await associateSubjectNode(page, "computer-networks", "net.layers");
  await sendChatMessage(page, "继续学这一节");

  const topBarTitle = page.getByTestId("chat-title");
  await expect(topBarTitle).toHaveText("继续学这一节");
  await expect(page.getByTitle("发送")).toBeVisible();
  await expect(page.getByRole("textbox")).toBeEnabled();

  await sendChatMessage(page, "再讲细一点");
  await expect(page.getByText(STREAM_SEGMENTS[0])).toHaveCount(2);

  // 切到新会话再切回来：科目/节点下拉从会话元数据恢复
  // （「+ 新对话」按钮已从顶栏移除，新对话入口在左侧边栏）
  await page.getByTitle("新对话").click();
  await expect(topBarTitle).toHaveText("新的对话");
  // 会话列表在左侧边栏（aside 第一个）；右侧边栏同样用 aside，故限定 first()
  await page.locator("aside").first().getByText("继续学这一节").click();
  await expect(topBarTitle).toHaveText("继续学这一节");
  await expect(page.getByText("再讲细一点")).toBeVisible();
  await expect(page.getByTitle("关联科目")).toHaveValue("computer-networks");
  await expect(page.getByTitle("关联节点")).toHaveValue("net.layers");

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
  expect(session.node_id).toBe("net.layers");
  expect(session.messages).toHaveLength(4);
  expect(session.messages[0].role).toBe("user");
  expect(session.messages[0].content).toBe("继续学这一节");
  expect(session.messages[1].role).toBe("assistant");
});
