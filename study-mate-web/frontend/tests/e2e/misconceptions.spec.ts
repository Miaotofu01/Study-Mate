import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { subjectDir } from "./constants";

const TOPIC = "E2E 临时概念：三次握手的次数";

const card = (page: Page, topic: string) =>
  page.locator("div.group.rounded-xl", { hasText: topic });

async function createEntry(
  page: Page,
  topic: string,
  importance: string,
  withNode = false,
): Promise<void> {
  await page.getByRole("button", { name: "记一条" }).click();
  await page.getByLabel("主题").fill(topic);
  await page.getByLabel("当时的问题").fill(`${topic}：当时的问题`);
  await page.getByLabel("误解点").fill(`${topic}：当时的误解`);
  await page.getByLabel("答案要点").fill(`${topic}：正确理解`);
  // 重要度 select 的可访问名包含选项文本，且其它字段的值可能含“重要度”字样，用 combobox 角色锁定
  await page.getByRole("combobox", { name: /重要度/ }).selectOption({ label: importance });
  if (withNode) {
    await page.getByLabel("关联节点").selectOption({ label: "分层模型与封装" });
  }
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(card(page, topic)).toBeVisible();
}

test("create a misconception entry and delete it", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/misconceptions");

  await page.getByRole("combobox", { name: "学科" }).selectOption({ label: "计算机网络" });
  await expect(page.getByRole("button", { name: "记一条" })).toBeEnabled();

  await page.getByRole("button", { name: "记一条" }).click();
  await page.getByLabel("主题").fill(TOPIC);
  await page.getByLabel("当时的问题").fill("为什么 TCP 握手是三次而不是两次？");
  await page.getByLabel("误解点").fill("以为两次握手也足以建立可靠连接");
  await page
    .getByLabel("答案要点")
    .fill("三次握手确认双方收发能力与初始序号，两次无法防止旧的重复连接请求");
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await expect(card(page, TOPIC)).toBeVisible();
  await expect(page.getByText("暂无概念本条目")).toHaveCount(0);

  await card(page, TOPIC).getByTitle("删除").click();
  await expect(card(page, TOPIC)).toHaveCount(0);
});

test("filter entries by importance chips and by node", async ({ page }) => {
  await page.goto("/misconceptions");
  await page.getByRole("combobox", { name: "学科" }).selectOption({ label: "计算机网络" });
  await expect(page.getByRole("button", { name: "记一条" })).toBeEnabled();

  await createEntry(page, "E2E 筛选高重要度", "高", true);
  await createEntry(page, "E2E 筛选中重要度", "中");
  await createEntry(page, "E2E 筛选低重要度", "低");

  const chips = (label: string) => page.getByRole("button", { name: label, exact: true });

  await chips("高").click();
  await expect(card(page, "E2E 筛选高重要度")).toBeVisible();
  await expect(card(page, "子网掩码的算法")).toBeVisible();
  await expect(card(page, "E2E 筛选中重要度")).toHaveCount(0);
  await expect(card(page, "E2E 筛选低重要度")).toHaveCount(0);
  await expect(card(page, "封装开销")).toHaveCount(0);

  await chips("中").click();
  await expect(card(page, "E2E 筛选中重要度")).toBeVisible();
  await expect(card(page, "封装开销")).toBeVisible();
  await expect(card(page, "E2E 筛选高重要度")).toHaveCount(0);

  await chips("低").click();
  await expect(card(page, "E2E 筛选低重要度")).toBeVisible();
  await expect(card(page, "E2E 筛选中重要度")).toHaveCount(0);
  await expect(card(page, "子网掩码的算法")).toHaveCount(0);

  await chips("全部").click();
  await expect(card(page, "E2E 筛选高重要度")).toBeVisible();
  await expect(card(page, "E2E 筛选中重要度")).toBeVisible();
  await expect(card(page, "E2E 筛选低重要度")).toBeVisible();

  await page.getByRole("combobox", { name: "节点" }).selectOption({ label: "分层模型与封装" });
  await expect(card(page, "E2E 筛选高重要度")).toBeVisible();
  await expect(card(page, "E2E 筛选中重要度")).toHaveCount(0);
  await expect(card(page, "E2E 筛选低重要度")).toHaveCount(0);
  await expect(card(page, "子网掩码的算法")).toHaveCount(0);

  await page.getByRole("combobox", { name: "节点" }).selectOption({ label: "全部节点" });
  await expect(card(page, "E2E 筛选高重要度")).toBeVisible();
  await expect(card(page, "子网掩码的算法")).toBeVisible();
});

test("edit an entry and see both stores updated", async ({ page }) => {
  const slug = "computer-networks";
  const followUp = "E2E 编辑后的跟进事项：用抓包验证 SYN/ACK";

  await page.goto("/misconceptions");
  await page.getByRole("combobox", { name: "学科" }).selectOption({ label: "计算机网络" });
  await expect(page.getByRole("button", { name: "记一条" })).toBeEnabled();
  await createEntry(page, "E2E 待编辑条目", "高", true);

  await card(page, "E2E 待编辑条目").getByTitle("编辑").click();
  await expect(page.getByRole("heading", { name: "编辑概念" })).toBeVisible();
  await page.getByRole("combobox", { name: /重要度/ }).selectOption({ label: "低" });
  await page.getByLabel("待跟进（可选）").fill(followUp);
  await page.getByRole("button", { name: "保存修改" }).click();

  const edited = card(page, "E2E 待编辑条目");
  await expect(edited).toBeVisible();
  await expect(edited.getByText("低", { exact: true })).toBeVisible();
  await expect(edited.getByText(followUp)).toBeVisible();

  const notebook = fs.readFileSync(path.join(subjectDir(slug), "misconceptions.yaml"), "utf-8");
  expect(notebook).toContain("E2E 待编辑条目");
  expect(notebook).toContain(followUp);
  const progress = fs.readFileSync(path.join(subjectDir(slug), "progress.yaml"), "utf-8");
  expect(progress).toContain("E2E 待编辑条目");
  expect(progress).toContain(followUp);
});

test("node chip locates the node on the graph; query params prefill the filters", async ({ page }) => {
  await page.goto("/misconceptions");
  await page.getByRole("combobox", { name: "学科" }).selectOption({ label: "计算机网络" });
  await expect(page.getByRole("button", { name: "记一条" })).toBeEnabled();
  await createEntry(page, "E2E 定位节点条目", "中", true);

  // 条目上的节点 chip → 图谱页定位该节点（详情在主区出现）
  await card(page, "E2E 定位节点条目").getByTitle(/在课程图谱中定位/).click();
  await expect(page).toHaveURL(/\/courses\?subject=computer-networks&node=net\.layers/);
  await expect(page.getByTestId("course-node-detail")).toBeVisible();
  await expect(page.getByRole("heading", { name: "分层模型与封装" })).toBeVisible();

  // 反向：带参进入概念本，筛选被预填
  await page.goto("/misconceptions?subject=computer-networks&node=net.layers");
  await expect(page.getByRole("combobox", { name: "节点" })).toHaveValue("net.layers");
  await expect(card(page, "E2E 定位节点条目")).toBeVisible();

  await page.on("dialog", (dialog) => dialog.accept());
  await card(page, "E2E 定位节点条目").getByTitle("删除").click();
  await expect(card(page, "E2E 定位节点条目")).toHaveCount(0);
});
