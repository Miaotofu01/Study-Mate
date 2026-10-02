import { expect, type Page } from "@playwright/test";

import { STREAM_LAST_SEGMENT } from "./constants";

export async function fillGenerateWizard(page: Page, name: string): Promise<void> {
  // SSR 静态页：等 React 水合完成再输入，避免受控输入被水合重置
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
  await page.getByLabel("科目名称").fill(name);
  await page.getByLabel("学习目的").fill("E2E 目的：验证生成向导的完整旅程");
  await page.getByLabel("当前程度").fill("E2E 程度：零基础，只会用浏览器");
  await page.getByLabel("前置基础").fill("E2E 前置：会命令行基本操作");
}

export async function associateSubjectNode(
  page: Page,
  slug: string,
  nodeId?: string,
): Promise<void> {
  // exact：禁用态「生成小结」按钮的 title（需关联科目且会话中有消息）含同样字样
  await page.getByTitle("关联科目", { exact: true }).selectOption(slug);
  if (nodeId !== undefined) {
    await page.getByTitle("关联节点", { exact: true }).selectOption(nodeId);
  }
}

export async function sendChatMessage(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox").fill(text);
  await page.getByTitle("发送").click();
  // 流式期间「发送」会被「停止」替换；等它收回来才算这轮回复完成并已落盘
  await expect(page.getByTitle("停止")).toBeVisible();
  await expect(page.getByTitle("停止")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText(STREAM_LAST_SEGMENT).first()).toBeVisible();
}

export async function openNodeDetail(page: Page, slug: string, nodeLabel: string): Promise<void> {
  await page.goto(`/courses?subject=${slug}`);
  await expect(page.getByText("点击节点查看详情")).toBeVisible();
  await page.getByRole("button", { name: nodeLabel }).dispatchEvent("click");
}
