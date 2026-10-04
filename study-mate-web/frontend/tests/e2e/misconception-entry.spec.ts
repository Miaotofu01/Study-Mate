import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { STREAM_SEGMENTS, subjectDir } from "./constants";
import { associateSubject, sendChatMessage } from "./helpers";

const QUESTION = "分层有什么好处？为什么网络要分层？";
// adverse 用例用独立问题文本：e2e 工作区数据跨用例保留，题目撞车会让卡片定位命中多个元素
const NO_SUBJECT_QUESTION = "没有关联科目时也能记入概念本吗？";

test("save an assistant reply into the misconception notebook", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");
  await associateSubject(page, "computer-networks");
  await sendChatMessage(page, QUESTION);

  const saveButton = page.getByTitle("记入概念本");
  await expect(saveButton).toBeVisible();
  await saveButton.click();

  await expect(page).toHaveURL(/\/misconceptions/);
  await expect(page.getByRole("heading", { name: "记入概念本" })).toBeVisible();
  // 弹层内「科目」下拉承载从聊天带过来的科目；顶部筛选栏用的是「学科」标签。
  // 用 combobox 角色定位：getByLabel 会连同 textarea 的正文一起匹配（题干里也可能出现「科目」）
  await expect(page.getByRole("dialog").getByRole("combobox", { name: "科目" })).toHaveValue(
    "computer-networks",
  );
  // 节点下拉已移除（2026-10-04）：聊天侧预填的主题回落为科目名
  await expect(page.getByLabel("主题")).toHaveValue("计算机网络");
  await expect(page.getByLabel("当时的问题")).toHaveValue(QUESTION);
  await expect(page.getByLabel("答案要点")).toHaveValue(STREAM_SEGMENTS.join(""));

  await page.getByLabel("误解点").fill("以为分层是四段独立的程序");
  await page.getByRole("button", { name: "保存", exact: true }).click();

  // 用唯一的 question 文本锁定新卡片；主题文本会与其它卡片的节点徽标撞车
  const card = page.locator("div.group.rounded-xl", { hasText: QUESTION });
  await expect(card).toBeVisible();

  const progress = fs.readFileSync(
    path.join(subjectDir("computer-networks"), "progress.yaml"),
    "utf-8",
  );
  expect(progress).toContain(QUESTION);
  const notebook = fs.readFileSync(
    path.join(subjectDir("computer-networks"), "misconceptions.yaml"),
    "utf-8",
  );
  expect(notebook).toContain(QUESTION);
  expect(notebook).toContain("以为分层是四段独立的程序");
});

// adverse：聊天未关联科目时 draft.subject 为空，旧实现点保存毫无反应
test("record a misconception when the chat has no associated subject", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");
  await sendChatMessage(page, NO_SUBJECT_QUESTION);

  const saveButton = page.getByTitle("记入概念本");
  await expect(saveButton).toBeVisible();
  await saveButton.click();

  await expect(page).toHaveURL(/\/misconceptions/);
  const dialog = page.getByRole("dialog");
  const subjectSelect = dialog.getByRole("combobox", { name: "科目" });
  await expect(subjectSelect).toHaveValue("");

  // 未选科目：保存禁用且有可见提示，不静默失败
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await expect(page.getByText("概念本按科目归档，请先选择科目后再保存。")).toBeVisible();

  // 弹层内补选科目 → 节点下拉联动加载 → 保存可用
  await subjectSelect.selectOption({ label: "计算机网络" });
  await expect(dialog.getByRole("option", { name: "分层模型与封装" })).toBeAttached();
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeEnabled();

  await dialog.getByLabel("误解点").fill("以为没关联科目就记不了概念本");
  await dialog.getByLabel("关联节点").selectOption({ label: "分层模型与封装" });
  await dialog.getByRole("button", { name: "保存", exact: true }).click();

  // 用唯一的 question 文本锁定新卡片；主题预填为「学习笔记」，文本不唯一
  const card = page.locator("div.group.rounded-xl", { hasText: NO_SUBJECT_QUESTION });
  await expect(card).toBeVisible();

  const notebook = fs.readFileSync(
    path.join(subjectDir("computer-networks"), "misconceptions.yaml"),
    "utf-8",
  );
  expect(notebook).toContain(NO_SUBJECT_QUESTION);
  expect(notebook).toContain("以为没关联科目就记不了概念本");
});
