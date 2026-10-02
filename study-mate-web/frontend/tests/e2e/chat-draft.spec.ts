import { expect, test } from "@playwright/test";

import { sendChatMessage } from "./helpers";

test("composer drafts are cached per session and survive session switches", async ({ page }) => {
  await page.goto("/chat");
  // 问候语由客户端 effect 写入，确认水合完成
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  const textbox = page.getByRole("textbox");
  const openSession = (title: string) =>
    page.locator("aside").first().getByText(title).click();

  // 先落一个会话，后面切来切去都拿它当目标会话
  const title = "草稿缓存的第一个会话";
  await sendChatMessage(page, title);

  // 切到新对话（固定槽），写一份草稿
  await page.getByTitle("新对话").click();
  await expect(page.getByTestId("chat-title")).toHaveText("新的对话");
  const newDraft = "新对话里写了一半的草稿";
  await textbox.fill(newDraft);
  await expect(textbox).toHaveValue(newDraft);

  // 切到历史会话：草稿被存起，输入框载入该会话自己的（空）草稿
  await openSession(title);
  await expect(page.getByTestId("chat-title")).toHaveText(title);
  await expect(textbox).toHaveValue("");

  // 在历史会话里写另一份草稿
  const sessionDraft = "历史会话里写了一半的草稿";
  await textbox.fill(sessionDraft);

  // 切回新对话：之前的草稿还在
  await page.getByTitle("新对话").click();
  await expect(textbox).toHaveValue(newDraft);

  // 再切回历史会话：这份草稿也还在
  await openSession(title);
  await expect(textbox).toHaveValue(sessionDraft);
});

test("sending a message clears that session's draft only", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  const textbox = page.getByRole("textbox");
  const openSession = (title: string) =>
    page.locator("aside").first().getByText(title).click();

  const title = "发送后草稿应清空的会话";
  await sendChatMessage(page, title);

  // 新对话槽位先存一份草稿，用于和历史会话的草稿区分
  await page.getByTitle("新对话").click();
  const newDraft = "新对话槽里的草稿";
  await textbox.fill(newDraft);

  // 切到该会话：载入它自己的（空）草稿
  await openSession(title);
  await expect(textbox).toHaveValue("");

  // 写草稿后发送：该会话的草稿被清空
  const sent = "随消息一起发出去的草稿";
  await textbox.fill(sent);
  await sendChatMessage(page, sent);
  await expect(textbox).toHaveValue("");

  // 新对话槽的草稿不受影响；切回该会话，已发送的草稿不会复活
  await page.getByTitle("新对话").click();
  await expect(textbox).toHaveValue(newDraft);
  await openSession(title);
  await expect(textbox).toHaveValue("");
});
