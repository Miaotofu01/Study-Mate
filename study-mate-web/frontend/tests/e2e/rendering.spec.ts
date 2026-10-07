import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import { associateSubject } from "./helpers";

type Theme = "light" | "dark";

/**
 * 渲染兜底（P3 渲染矩阵的最小落地）：只覆盖关键浅/暗主题片段，不做全页视觉回归。
 *
 * 结构：本文件只由 playwright.config.ts 的 rendering-light / rendering-dark 两个项目各跑一次
 * （两个项目都只 testMatch 本文件）；主 `e2e` 项目 testIgnore 本文件，所以全量 E2E
 * 不会被整套双倍跑。CI smoke 走显式文件列表（chat-basic / courses），不含本文件，仍 5 条。
 *
 * 主题经 app 自己的 localStorage（studymate-theme，layout.tsx 的 themeInit 读同一键）应用，
 * 不依赖 Playwright 的 colorScheme 伪造——断言的是 app 真实渲染出的 data-theme 与 CSS 变量。
 * 颜色期望一律取“CSS 实际声明值”（getComputedStyle 解析语义变量），不硬编码颜色字面量。
 */

function expectedTheme(testInfo: TestInfo): Theme {
  const scheme = testInfo.project.use.colorScheme;
  if (scheme === "dark" || scheme === "light") return scheme;
  return testInfo.project.name.includes("dark") ? "dark" : "light";
}

/** 首帧前写入主题，再导航；并断言 data-theme 真的切到了期望值。 */
async function openWithTheme(page: Page, theme: Theme, path = "/chat"): Promise<void> {
  await page.addInitScript((value: string) => {
    localStorage.setItem("studymate-theme", value);
    localStorage.setItem("studymate-palette", "blue");
  }, theme);
  await page.goto(path);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** 取 CSS 变量的实际声明值，转成 computed 的 rgb(...) 串（任何颜色写法都能归一）。 */
async function cssVarAsComputedRgb(page: Page, name: string): Promise<string> {
  return page.evaluate((varName) => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    const probe = document.createElement("span");
    probe.style.color = raw || "rgb(0, 0, 0)";
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return rgb;
  }, name);
}

/** WCAG 对比度：取元素前景色与其最近不透明祖先背景色，避免硬编码判定阈值以外的猜测。 */
async function contrastRatio(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const parse = (value: string): { r: number; g: number; b: number; a: number } | null => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(",").map((piece) => parseFloat(piece.trim()));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const luminance = (c: { r: number; g: number; b: number }): number => {
      const channel = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    };
    const fg = parse(getComputedStyle(el).color);
    let node: HTMLElement | null = el as HTMLElement;
    let bg: { r: number; g: number; b: number; a: number } | null = null;
    while (node) {
      const candidate = parse(getComputedStyle(node).backgroundColor);
      if (candidate && candidate.a > 0.5) {
        bg = candidate;
        break;
      }
      node = node.parentElement;
    }
    if (!fg || !bg) return 21;
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  });
}

test("semantic surfaces resolve to the project theme", async ({ page }, testInfo) => {
  const theme = expectedTheme(testInfo);
  await openWithTheme(page, theme);

  // color-scheme 跟着主题（原生控件 / 滚动条口径）
  await expect(page.locator("html")).toHaveCSS("color-scheme", theme);

  const body = page.locator("body");
  await expect(body).toHaveCSS("color", await cssVarAsComputedRgb(page, "--foreground"));
  await expect(body).toHaveCSS("background-color", await cssVarAsComputedRgb(page, "--background"));
});

test("native select options keep readable foreground/background", async ({ page }, testInfo) => {
  const theme = expectedTheme(testInfo);
  await openWithTheme(page, theme);

  // 新对话关联行的科目下拉：<option> 颜色是「暗色下拉白字白底」雷区的定向断言
  const select = page.getByTestId("new-session-subject");
  await expect(select).toBeVisible();
  expect(await select.locator("option").count()).toBeGreaterThan(0);

  const option = select.locator("option").first();
  await expect(option).toHaveCSS("color", await cssVarAsComputedRgb(page, "--foreground"));
  await expect(option).toHaveCSS("background-color", await cssVarAsComputedRgb(page, "--surface-card"));
});

test("narrow viewport keeps the chat shell inside the viewport", async ({ page }, testInfo) => {
  const theme = expectedTheme(testInfo);
  await page.setViewportSize({ width: 375, height: 780 });
  await openWithTheme(page, theme);

  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    docScroll: document.documentElement.scrollWidth,
    bodyScroll: document.body.scrollWidth,
  }));
  // 窄屏不应出现横向溢出（允许 1px 亚像素误差）
  expect(metrics.docScroll, "文档不应横向溢出").toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.bodyScroll, "body 不应横向溢出").toBeLessThanOrEqual(metrics.innerWidth + 1);
  // 壳层核心交互件仍可见，未被横向溢出推出视口
  await expect(page.getByTestId("composer")).toBeVisible();
});

test("production task card status and lesson action stay visible and readable", async ({ page }, testInfo) => {
  const theme = expectedTheme(testInfo);
  await page.route("**/api/chat/stream", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...body, fixture_scenario: "production_task" }) });
  });
  await openWithTheme(page, theme);

  await associateSubject(page, "computer-networks");
  await page.getByRole("textbox").fill(`渲染任务卡-${theme}`);
  await page.getByTitle("发送").click();

  const card = page.getByTestId("production-task-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveAttribute("data-status", "done", { timeout: 30_000 });

  // 状态与课件入口都常显（入口不在折叠 details 里），且对比度以实际 CSS 声明为准
  const status = card.getByTestId("task-status");
  await expect(status).toBeVisible();
  expect(await contrastRatio(status), "任务卡状态文字对比度不足").toBeGreaterThanOrEqual(3);

  const openLesson = page.getByTestId("open-lesson");
  await expect(openLesson).toBeVisible();
  expect(await contrastRatio(openLesson), "打开课件按钮对比度不足").toBeGreaterThanOrEqual(3);
});
