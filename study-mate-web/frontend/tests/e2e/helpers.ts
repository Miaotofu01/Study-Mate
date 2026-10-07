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

/**
 * 右侧边栏（RightRail）在「新对话」态默认折叠；关联科目等操作都在右栏内，
 * 先把折叠的右栏展开再操作（已展开时为 no-op）。
 */
export async function expandRightRail(page: Page): Promise<void> {
  const expand = page.getByTitle("展开右侧边栏");
  if ((await expand.count()) > 0) {
    await expand.click();
    // 等宽度过渡到位（折叠态宽度为 0，展开后才有可点区域）
    await expect
      .poll(
        async () =>
          Math.round((await page.getByTestId("chat-right-sidebar").boundingBox())?.width ?? 0),
      )
      .toBeGreaterThan(0);
  }
}

export async function associateSubject(page: Page, slug: string): Promise<void> {
  // 科目关联移到「新对话态」输入区上方的关联行（已有会话不再显示该行）。
  // exact：禁用态「生成小结」按钮的 title（已随小结悬空移除，保留 exact 以防同名文案回归）。
  await page.getByTitle("关联科目", { exact: true }).selectOption(slug);
}

/** 新对话态关联行里选工作区（空值 = 默认工作区，不调用它即可） */
export async function associateWorkspace(page: Page, path: string): Promise<void> {
  await page.getByTitle("关联工作区", { exact: true }).selectOption(path);
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
  // 大纲与图谱都收进右栏（默认图谱，2026-10-04）：先切到「大纲」段，再按标题点节点行
  await page.getByTestId("rail-view-outline").click();
  await page
    .getByTestId("course-outline")
    .getByRole("button", { name: nodeLabel })
    .dispatchEvent("click");
}
