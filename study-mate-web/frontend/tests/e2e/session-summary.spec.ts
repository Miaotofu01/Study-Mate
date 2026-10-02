import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { subjectDir } from "./constants";
import { associateSubjectNode, sendChatMessage } from "./helpers";

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

test("generate a session summary and persist it under sessions/", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  // 空会话（无消息）时按钮保持禁用
  const summarize = page.getByRole("button", { name: "生成小结" });
  await expect(summarize).toBeDisabled();

  await associateSubjectNode(page, "computer-networks");
  await expect(summarize).toBeDisabled();
  await sendChatMessage(page, "帮我收个尾，总结这次的学习");
  await expect(summarize).toBeEnabled();

  await summarize.click();
  await expect(page.getByText(/小结已写入：sessions\/\d{4}-\d{2}-\d{2}\.md/)).toBeVisible();
  await expect(page.getByText("下一步：下次从链路层与以太网帧继续")).toBeVisible();

  const summaryPath = path.join(subjectDir("computer-networks"), "sessions", `${today()}.md`);
  expect(fs.existsSync(summaryPath)).toBe(true);
  const content = fs.readFileSync(summaryPath, "utf-8");
  expect(content).toContain("subject: 计算机网络");
  expect(content).toContain("learned:");
  expect(content).toContain("说出了分层模型把一次请求拆成多段处理");
  expect(content).toContain("next_step: 下次从链路层与以太网帧继续");
});
