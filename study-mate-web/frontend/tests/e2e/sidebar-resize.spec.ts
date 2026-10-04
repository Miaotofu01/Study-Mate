import { expect, test, type Page } from "@playwright/test";

// /chat 页有两个可拖拽的栏：左（主侧边栏，手柄在右缘）与右（RightRail，手柄在左缘）。
// 两者通过手柄的 aria-label 区分，这里只认「调整侧边栏宽度」——即左栏那把。
const MIN_WIDTH = 180;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 240;
const WIDTH_KEY = "studymate-sidebar-width";
const HANDLE_NAME = "调整侧边栏宽度";

// 左栏是页面上唯一的 <aside>（右栏 RightRail 用 div[role=complementary]），
// 故「手柄所在的祖先 aside」稳定锁定主侧边栏
const sidebarOf = (page: Page) =>
  page.getByRole("separator", { name: HANDLE_NAME }).locator("xpath=ancestor::aside[1]");

async function dragHandleBy(page: Page, dx: number): Promise<void> {
  const box = await page.getByRole("separator", { name: HANDLE_NAME }).boundingBox();
  if (!box) throw new Error(`拖拽手柄「${HANDLE_NAME}」不可见`);
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

test("sidebar can be resized by dragging and keeps the width across reloads", async ({ page }) => {
  await page.goto("/chat");
  // 问候语由客户端 effect 写入，确认水合完成后再测宽度
  await expect(page.getByRole("heading")).not.toHaveText("你好");
  expect(Math.round((await sidebarOf(page).boundingBox())!.width)).toBe(DEFAULT_WIDTH);

  // 右栏同样可拖拽，但左栏拖拽不应影响右栏（两者手势各自独立）
  // 新对话默认折叠右栏：先展开，等宽度过渡到位再量
  await page.getByTitle("展开右侧边栏").click();
  await expect
    .poll(async () => Math.round((await page.getByTestId("chat-right-sidebar").boundingBox())!.width))
    .toBe(256);

  // 向右拖宽 120px
  await dragHandleBy(page, 120);
  expect(Math.round((await sidebarOf(page).boundingBox())!.width)).toBe(DEFAULT_WIDTH + 120);
  expect(await page.evaluate((key: string) => localStorage.getItem(key), WIDTH_KEY)).toBe("360");

  // 刷新后保留宽度（侧边栏宽度持久化是期望行为，与对话框草稿的「刷新即空」不同）
  await page.reload();
  await expect
    .poll(async () => Math.round((await sidebarOf(page).boundingBox())!.width))
    .toBe(DEFAULT_WIDTH + 120);

  // 拖过上限：钳制在 MAX_WIDTH
  await dragHandleBy(page, 500);
  expect(Math.round((await sidebarOf(page).boundingBox())!.width)).toBe(MAX_WIDTH);

  // 拖过下限：钳制在 MIN_WIDTH
  await dragHandleBy(page, -350);
  expect(Math.round((await sidebarOf(page).boundingBox())!.width)).toBe(MIN_WIDTH);

  await page.reload();
  await expect
    .poll(async () => Math.round((await sidebarOf(page).boundingBox())!.width))
    .toBe(MIN_WIDTH);
});
