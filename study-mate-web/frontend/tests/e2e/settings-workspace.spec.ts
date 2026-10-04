import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { E2E_CONFIG_PATH, E2E_DATA_DIR, E2E_WORKSPACE_DIR } from "./constants";

// 工作区设置页：GET/PUT /api/workspace。E2E 后端经 STUDYMATE_CONFIG 指向 e2e-data 下的配置
// 文件，PUT 只改这个文件（不碰真实 ~/.dsh），改完立即生效。
test("workspace settings render the discovered e2e workspace", async ({ page }) => {
  await page.goto("/settings/workspace");

  await expect(page.getByRole("heading", { name: "工作区", exact: true })).toBeVisible();
  await expect(page.getByTestId("workspace-path")).toHaveText(E2E_WORKSPACE_DIR);
  // 来源是配置发现（不再是环境变量注入）
  await expect(page.getByTestId("workspace-source")).toContainText("studymate-config.yaml");
  await expect(page.getByTestId("workspace-input")).toHaveValue(E2E_WORKSPACE_DIR);

  // generate.spec.ts 会留下一个生成科目，所以只断言确定性下界
  const count = await page.getByTestId("workspace-subject-count").textContent();
  expect(Number.parseInt(count ?? "", 10)).toBeGreaterThanOrEqual(2);

  expect(fs.readFileSync(E2E_CONFIG_PATH, "utf-8")).toContain(
    `workspace: ${E2E_WORKSPACE_DIR}`,
  );
});

test("switching the workspace takes effect immediately and can be restored", async ({ page }) => {
  const probeDir = path.join(E2E_DATA_DIR, "workspace-probe");
  await page.goto("/settings/workspace");
  await expect(page.getByTestId("workspace-path")).toHaveText(E2E_WORKSPACE_DIR);
  const initialCount = await page.getByTestId("workspace-subject-count").textContent();
  expect(initialCount).not.toBeNull();

  try {
    await page.getByTestId("workspace-input").fill(probeDir);
    await page.getByTestId("workspace-save").click();

    await expect(page.getByTestId("workspace-saved")).toContainText(probeDir);
    await expect(page.getByTestId("workspace-path")).toHaveText(probeDir);
    await expect(page.getByTestId("workspace-subject-count")).toHaveText("0 门");
    // PUT 落盘在 e2e 配置里
    expect(fs.readFileSync(E2E_CONFIG_PATH, "utf-8")).toContain(`workspace: ${probeDir}`);
  } finally {
    // 恢复原路径：同轮后续用例（sidebar-resize / subject-switch）仍跑在 e2e-ws 上
    await page.getByTestId("workspace-input").fill(E2E_WORKSPACE_DIR);
    await page.getByTestId("workspace-save").click();
    await expect(page.getByTestId("workspace-saved")).toContainText(E2E_WORKSPACE_DIR);
    await expect(page.getByTestId("workspace-path")).toHaveText(E2E_WORKSPACE_DIR);
    await expect(page.getByTestId("workspace-subject-count")).toHaveText(initialCount!);
    expect(fs.readFileSync(E2E_CONFIG_PATH, "utf-8")).toContain(
      `workspace: ${E2E_WORKSPACE_DIR}`,
    );
  }
});
