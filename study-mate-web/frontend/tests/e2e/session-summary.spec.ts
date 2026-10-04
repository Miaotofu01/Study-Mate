import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { subjectDir } from "./constants";
import { associateSubject, expandRightRail, sendChatMessage } from "./helpers";

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

test("generate a session summary and persist it under sessions/", async ({ page }) => {
  // 2026-10-04 拍板：「生成小结」入口暂时悬空（右栏会话关联区整段移除）。
  // 后端能力与 api.generateSessionSummary 都保留，重新接入入口后删掉这行即可恢复。
  test.skip(true, "「生成小结」入口已悬空（2026-10-04 拍板），待重新接入后恢复");
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  // 新对话默认折叠右栏：先展开，才拿得到「生成小结」按钮
  await expandRightRail(page);
  // 空会话（无消息）时按钮保持禁用
  const summarize = page.getByRole("button", { name: "生成小结" });
  await expect(summarize).toBeDisabled();

  await associateSubject(page, "computer-networks");
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

  // H④：同日第二次小结不再覆盖，改为在文末追加一段「## 本场摘要（HH:MM）」。
  // 用 waitForResponse 等第二轮落盘（两条成功条文案相同，光断言 UI 追不上第二次写文件）
  const secondRound = page.waitForResponse(
    (res) => res.url().includes("/summary") && res.request().method() === "POST",
  );
  await summarize.click();
  const secondResponse = await secondRound;
  expect(secondResponse.status()).toBe(200);
  await expect(page.getByText(/小结已写入：sessions\/\d{4}-\d{2}-\d{2}\.md/)).toBeVisible();

  const appended = fs.readFileSync(summaryPath, "utf-8");
  expect(appended.match(/## 本次要点/g)).toHaveLength(2);
  expect(appended).toContain("## 本场摘要（");
  // 首轮写入的 front matter 与正文都还在（追加而非覆盖）
  expect(appended).toContain("subject: 计算机网络");
  expect(appended.match(/next_step: 下次从链路层与以太网帧继续/g)).toHaveLength(1);

  // I：会话结束时后端已在小结里产出 memory_updates（fixture 2 条）→ 结果区给一键沉淀入口，
  // 点击后用这两条预填确认弹窗（不再调 suggest）
  const suggestEntry = page.getByTestId("memory-suggest-entry");
  await expect(suggestEntry).toContainText("2");
  await suggestEntry.click();
  const dialog = page.getByTestId("memory-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("偏好先看一个具体例子再动手推演")).toBeVisible();
  await expect(dialog.getByText("对协议分层这类抽象内容需要图示辅助")).toBeVisible();
  await dialog.getByTestId("memory-confirm").click();
  await expect(dialog.getByTestId("memory-result")).toContainText("已写入");
});
