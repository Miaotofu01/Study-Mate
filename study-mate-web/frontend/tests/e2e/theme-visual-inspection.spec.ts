import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { sendChatMessage } from "./helpers";

const SCREENSHOT_DIR = path.resolve(__dirname, "../../test-results/screenshots");

test.beforeAll(() => {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
});

test("capture visual screenshots of the new theme system and workbench ui", async ({ page }) => {
  // 1. 验证默认调色板为 blue，并查看设置页
  await page.goto("/settings/theme");
  await expect(page.getByTestId("settings-theme-view")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "blue");
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "01-settings-theme-blue-light.png"),
    fullPage: true,
  });

  // 2. 切换为暗夜模式
  await page.getByTestId("settings-theme-view").getByRole("button", { name: /暗夜模式/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "02-settings-theme-blue-dark.png"),
    fullPage: true,
  });

  // 3. 切回浅色并切换为经典墨绿
  await page.getByTestId("settings-theme-view").getByRole("button", { name: /浅色模式/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByText("经典墨绿（Forest Green）").click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "green");
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "03-settings-theme-green-light.png"),
    fullPage: true,
  });

  // 4. 切回默认科技蓝并进入 /chat 视口（空状态）
  await page.getByText("科技蓝（Oceanic Blue）").click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "blue");
  await page.goto("/chat");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "04-chat-blue-workbench-empty.png"),
    fullPage: true,
  });

  // 5. 在 /chat 中发送一条消息，查看真实对话消息气泡与工具槽
  await sendChatMessage(page, "你好，请用一句话解释为什么需要传输层协议？");
  await expect(page.locator(".md-body").first()).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "05-chat-blue-conversation.png"),
    fullPage: true,
  });

  // 6. 查看课程图谱点阵背景与节点详情
  await page.goto("/courses");
  await expect(page.getByTestId("course-graph-rail")).toBeVisible();
  // 2026-10-04：大纲与图谱都收进右栏、默认显示图谱；先切到大纲选节点，再切回图谱截图
  await page.getByTestId("rail-view-outline").click();
  const outlineNode = page.locator('[data-testid^="outline-node-"]').first();
  await expect(outlineNode).toBeVisible();
  await outlineNode.click();
  await expect(page.getByTestId("course-node-detail")).toBeVisible();
  await page.getByTestId("rail-view-graph").click();
  await page.waitForTimeout(600);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "06-courses-dot-matrix-detail.png"),
    fullPage: true,
  });
});
