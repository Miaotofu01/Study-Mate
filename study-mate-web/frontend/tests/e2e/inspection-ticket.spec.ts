import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { E2E_DATA_DIR, E2E_WORKSPACE_DIR } from "./constants";
import { openNodeDetail } from "./helpers";

const TICKETS_FILE = path.join(E2E_DATA_DIR, "tickets.json");

/** 工单存储是 data/tickets.json（与 sessions 同层的文件存储），E2E 直接落盘种子数据。 */
function seedTicket(slug: string, nodeId: string): void {
  const now = Date.now() / 1000;
  const ticket = {
    id: "e2eticket0001",
    kind: "produce",
    slug,
    node_id: nodeId,
    base_label: "workspace",
    // 记录归属：无 workspace 的旧单已是 ambiguous，会要求先确认工作区（另一个 E2E 覆盖）
    workspace: E2E_WORKSPACE_DIR,
    problems: [
      {
        owner: "讲解",
        path: "GLOSSARY.md",
        line: "3",
        message: "E2E 示例问题：术语表缺少本课主题词",
      },
    ],
    artifacts: ["GLOSSARY.md"],
    retries: 0,
    status: "待处理",
    created_at: now,
    updated_at: now,
  };
  fs.mkdirSync(E2E_DATA_DIR, { recursive: true });
  const existing = fs.existsSync(TICKETS_FILE)
    ? (JSON.parse(fs.readFileSync(TICKETS_FILE, "utf-8")) as unknown[]).filter(
        (t) => (t as { id: string }).id !== ticket.id,
      )
    : [];
  fs.writeFileSync(
    TICKETS_FILE,
    JSON.stringify([...existing, ticket], null, 2),
    "utf-8",
  );
}

test("handoff ticket surfaces on the node, two-step dialog closes via abandon", async ({
  page,
}) => {
  seedTicket("computer-networks", "net.layers");

  await openNodeDetail(page, "computer-networks", "分层模型与封装");
  await expect(page.getByTestId("node-ticket-entry")).toBeVisible();
  await page.getByTestId("node-ticket-entry").click();

  // 第一段：总览按归属分组
  await expect(page.getByTestId("inspection-dialog")).toBeVisible();
  await expect(page.getByTestId("inspection-overview")).toContainText("归属：讲解");
  await expect(page.getByTestId("inspection-overview")).toContainText(
    "E2E 示例问题：术语表缺少本课主题词",
  );

  // 第二段：产物快改（textarea 保存回科目目录；等内容真读到再保存，避免占位写回）
  await page.getByTestId("inspection-artifact").first().click();
  const editor = page.getByTestId("inspection-editor");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(/Glossary|术语表/, { timeout: 10_000 });
  await page.getByTestId("inspection-save").click();

  // 回总览后放弃收口：工单状态落盘，节点角标消失
  await page.getByRole("button", { name: /返回总览/ }).click();
  await page.getByTestId("inspection-abandon").click();
  await expect(page.getByTestId("inspection-closed")).toContainText("已放弃");
  await page.getByRole("button", { name: "关闭" }).click();
  await expect(page.getByTestId("node-ticket-entry")).toHaveCount(0);
});
