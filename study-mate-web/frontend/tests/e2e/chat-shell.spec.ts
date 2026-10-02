import { expect, test, type Page } from "@playwright/test";

import { associateSubjectNode, sendChatMessage } from "./helpers";

// 与 ChatView 中的常量保持一致
const RIGHT_WIDTH_KEY = "studymate-chat-right-sidebar-width";
const RIGHT_HANDLE_NAME = "调整右侧边栏宽度";
const RIGHT_DEFAULT_WIDTH = 256;
const RIGHT_MIN_WIDTH = 200;

// 右栏手柄在左缘：dx 为负（向左拖）变宽，与贴右缘面板的方向一致
async function dragRightHandleBy(page: Page, dx: number): Promise<void> {
  const box = await page.getByRole("separator", { name: RIGHT_HANDLE_NAME }).boundingBox();
  if (!box) throw new Error(`拖拽手柄「${RIGHT_HANDLE_NAME}」不可见`);
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

test("chat shell: top bar keeps only the title plus a right-sidebar toggle", async ({ page }) => {
  await page.goto("/chat");
  // 问候语由客户端 effect 写入，确认水合完成
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  const topBar = page.getByTestId("chat-topbar");
  await expect(topBar.getByTestId("chat-title")).toHaveText("新的对话");

  // 顶栏上的新对话按钮、科目/节点下拉、模型选择器都已移走
  await expect(page.getByRole("button", { name: "+ 新对话" })).toHaveCount(0);
  await expect(topBar.getByTitle("关联科目", { exact: true })).toHaveCount(0);
  await expect(topBar.getByTitle("关联节点", { exact: true })).toHaveCount(0);
  await expect(topBar.getByTitle("切换当前使用的提供商 / 模型")).toHaveCount(0);

  // 侧边栏里的「新对话」入口保留
  await expect(page.getByTitle("新对话")).toBeVisible();
});

test("chat shell: right sidebar carries association controls and session meta", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  const sidebar = page.getByTestId("chat-right-sidebar");
  await expect(sidebar).toBeVisible();

  // 关联区：未选科目时节点下拉禁用
  await expect(sidebar.getByTitle("关联科目", { exact: true })).toBeVisible();
  await expect(sidebar.getByTitle("关联节点", { exact: true })).toBeDisabled();
  await expect(sidebar.getByRole("button", { name: "生成小结" })).toBeDisabled();

  // 元信息区：新会话没有创建时间
  await expect(sidebar.getByTestId("session-message-count")).toHaveText("0 条");
  await expect(sidebar.getByTestId("session-created-at")).toHaveText("—");
  await expect(sidebar.getByTestId("session-subject")).toHaveText("未关联");

  // 模型选择器移入输入区
  await expect(page.getByTestId("composer").getByTitle("切换当前使用的提供商 / 模型")).toBeVisible();

  // 折叠 / 展开：内容保持挂载（不 unmount），宽度过渡到 0 并标记 inert + aria-hidden
  await page.getByTitle("折叠右侧边栏").click();
  await expect(sidebar).toBeHidden();
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect.poll(async () => sidebar.getAttribute("inert")).not.toBeNull();
  await expect(page.getByTitle("展开右侧边栏")).toBeVisible();
  await page.getByTitle("展开右侧边栏").click();
  await expect(sidebar).toBeVisible();
  await expect(sidebar).not.toHaveAttribute("aria-hidden", "true");
  await expect.poll(async () => sidebar.getAttribute("inert")).toBeNull();
});

test("chat shell: right sidebar can be resized by dragging and persists the width", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  const sidebar = page.getByTestId("chat-right-sidebar");
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())!.width))
    .toBe(RIGHT_DEFAULT_WIDTH);

  // 向左拖宽 60px（与左栏同一套 useResizable，方向相反）
  await dragRightHandleBy(page, -60);
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())!.width))
    .toBe(RIGHT_DEFAULT_WIDTH + 60);
  expect(await page.evaluate((key: string) => localStorage.getItem(key), RIGHT_WIDTH_KEY)).toBe("316");

  // 刷新后保留宽度（与左栏一致；折叠态本身不持久化，刷新回到默认展开）
  await page.reload();
  await expect(page.getByRole("heading")).not.toHaveText("你好");
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())!.width))
    .toBe(RIGHT_DEFAULT_WIDTH + 60);

  // 拖过下限：钳制在 RIGHT_MIN_WIDTH（dx 控制在视口内，Desktop Chrome 视口宽 1280）
  await dragRightHandleBy(page, 120);
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())!.width))
    .toBe(RIGHT_MIN_WIDTH);
});

test("chat shell: right sidebar reflects course association and session meta", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  const sidebar = page.getByTestId("chat-right-sidebar");
  await associateSubjectNode(page, "computer-networks", "net.layers");
  await sendChatMessage(page, "元信息面板下的会话");

  // 元信息随会话更新：消息数、创建时间、关联科目
  await expect(sidebar.getByTestId("session-message-count")).toHaveText("2 条");
  await expect(sidebar.getByTestId("session-created-at")).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  await expect(sidebar.getByTestId("session-subject")).toHaveText("计算机网络");

  // 生成小结在有关联科目且有消息后可用
  await expect(sidebar.getByRole("button", { name: "生成小结" })).toBeEnabled();
});
