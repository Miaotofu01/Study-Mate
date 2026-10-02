import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { BACKEND_URL, E2E_DATA_DIR, subjectDir } from "./constants";
import { associateSubjectNode, openNodeDetail, sendChatMessage } from "./helpers";

const MESSAGE = "请用一道题检查我对封装的理解";

test("request an assessment and the state machine promotes the node", async ({
  page,
  request,
}) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");
  await associateSubjectNode(page, "computer-networks");
  await sendChatMessage(page, MESSAGE);

  await openNodeDetail(page, "computer-networks", "1. 分层模型与封装");
  const detail = page.locator("div.w-80.border-l");
  const badge = detail.getByTestId("node-status-badge");

  // seed 里 net.layers 已是「能独立应用」；按状态机走到「初步理解」，评估通过才能推进到「能独立应用」
  await detail.getByTestId("node-next-statuses").getByRole("button", { name: "需要复习" }).click();
  await expect(badge).toHaveText("需要复习");
  await detail.getByTestId("node-next-statuses").getByRole("button", { name: "学习中" }).click();
  await expect(badge).toHaveText("学习中");
  await detail.getByTestId("node-next-statuses").getByRole("button", { name: "初步理解" }).click();
  await expect(badge).toHaveText("初步理解");

  // 会话列表就绪后再展开评估面板，避免选中会话为空
  await expect(page.locator("aside").getByText(MESSAGE)).toBeVisible();
  await detail.getByRole("button", { name: "申请评估" }).click();
  const sessionSelect = detail.getByLabel("评估会话");
  await expect(sessionSelect).toBeVisible();
  await expect(sessionSelect).toContainText(MESSAGE);

  await detail.getByRole("button", { name: "提交评估" }).click();
  const result = detail.getByTestId("assess-result");
  await expect(result.getByText("通过", { exact: true })).toBeVisible();
  await expect(result.getByText("掌握度 40%")).toBeVisible();
  await expect(result.getByText("复习首部与载荷的区别后重新评估本节")).toBeVisible();
  await expect(result.getByText("进度已更新至 能独立应用")).toBeVisible();
  await expect(result.getByText("assessments/001-net.layers.md")).toBeVisible();
  await expect(badge).toHaveText("能独立应用");

  const assessmentsDir = path.join(subjectDir("computer-networks"), "assessments");
  const records = fs.readdirSync(assessmentsDir).filter((name) => name.endsWith(".md"));
  expect(records).toEqual(["001-net.layers.md"]);
  const record = fs.readFileSync(path.join(assessmentsDir, records[0]), "utf-8");
  expect(record).toContain("verdict: 通过");

  const progress = fs.readFileSync(
    path.join(subjectDir("computer-networks"), "progress.yaml"),
    "utf-8",
  );
  expect(progress).toMatch(/net\.layers:[\s\S]*?status: 能独立应用/);
  expect(progress).toMatch(/net\.layers:[\s\S]*?mastery: 0\.4/);

  const metasRes = await request.get(`${BACKEND_URL}/api/sessions`);
  const metas = (await metasRes.json()) as Array<{ id: string; title: string }>;
  const meta = metas.find((m) => m.title === MESSAGE);
  expect(meta).toBeDefined();
  expect(fs.existsSync(path.join(E2E_DATA_DIR, "uploads", meta!.id))).toBe(false);
});
