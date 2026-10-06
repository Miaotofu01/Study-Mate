import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { E2E_DATA_DIR, E2E_WORKSPACE_DIR } from "./constants";

// 旧工单恢复（R10）端到端旅程（契约：缺 workspace 的旧非 draft 单一律 ambiguous，需显式确认）：
// - 科目级入口能看到归属未知的旧单（不只节点角标）；
// - 详情显示「需要确认工作区」，确认前禁写；
// - 用户手输目标工作区 → 确认归属 → 服务端持久化 → 写操作只落目标工作区，默认工作区不被误写；
// - 放弃是 status-only，未知归属也能用且不动文件；
// - 默认主页「待归属」条保证已无对应科目的旧单也不静默消失。
//
// 造单：没有公共造单端点，直接写测试 data 目录的 tickets.json（只写 e2e-data，不碰生产 data）。
// 契约点：GET /api/tickets?include_unscoped=true、POST /api/tickets/{id}/claim。

const TICKETS_FILE = path.join(E2E_DATA_DIR, "tickets.json");
const DATA_ROOT = path.dirname(E2E_WORKSPACE_DIR);
// 目标工作区放在 e2e 工作区旁边（非默认、非发现候选）；用「手输绝对路径」确认归属
const TARGET_WS = path.join(DATA_ROOT, "e2e-ws-legacy-target");

const SLUG_SCOPED = "legacy-scoped-net";
const SLUG_ORPHAN = "legacy-orphan-net";

/** 在指定工作区造一个最小科目（带可读写的 lessons/01.md，内容用标记便于断言没被误改） */
function seedSubject(workspace: string, slug: string, marker: string): string {
  const subjectDir = path.join(workspace, ".learning", "subjects", slug);
  fs.mkdirSync(path.join(subjectDir, "lessons"), { recursive: true });
  fs.writeFileSync(
    path.join(subjectDir, "subject.yaml"),
    `name: ${slug}\nslug: ${slug}\ncreated_at: "2026-01-01"\nstatus: 进行中\n`,
    "utf-8",
  );
  fs.writeFileSync(path.join(subjectDir, "curriculum.yaml"), "nodes: []\nedges: []\n", "utf-8");
  fs.writeFileSync(path.join(subjectDir, "progress.yaml"), 'updated_at: "2026-01-01"\nnodes: {}\n', "utf-8");
  const artifact = path.join(subjectDir, "lessons", "01.md");
  fs.writeFileSync(artifact, marker, "utf-8");
  return artifact;
}

/** 造一张无 workspace 字段的旧工单（归属未知），追加进测试 tickets.json */
function seedLegacyTicket(id: string, slug: string): void {
  const now = Date.now() / 1000;
  const ticket = {
    id,
    kind: "produce",
    slug,
    node_id: null,
    base_label: "workspace",
    problems: [
      { owner: "讲解", path: "lessons/01.md", line: "", message: "E2E 旧单：课件未过质检" },
    ],
    artifacts: ["lessons/01.md"],
    retries: 0,
    status: "待处理",
    created_at: now,
    updated_at: now,
    // 关键：不写 workspace 字段 → 归属未知
  };
  fs.mkdirSync(E2E_DATA_DIR, { recursive: true });
  const existing = fs.existsSync(TICKETS_FILE)
    ? (JSON.parse(fs.readFileSync(TICKETS_FILE, "utf-8")) as unknown[]).filter(
        (t) => (t as { id: string }).id !== id,
      )
    : [];
  fs.writeFileSync(TICKETS_FILE, JSON.stringify([...existing, ticket], null, 2), "utf-8");
}

/** 从科目级入口打开一张工单（无 node 的旧单也走这里，不只节点角标） */
async function openTicketFromSubjectEntry(page: Page, slug: string): Promise<void> {
  await page.goto(`/courses?subject=${slug}`);
  await page.getByTestId("subject-tickets-entry").click();
  await page.getByTestId("subject-ticket-item").first().click();
  await expect(page.getByTestId("inspection-dialog")).toBeVisible();
}

test.beforeAll(() => {
  fs.rmSync(TARGET_WS, { recursive: true, force: true });
});

test.afterAll(() => {
  // 清掉注入默认工作区的科目与目标工作区，避免污染同轮其它用例
  fs.rmSync(path.join(E2E_WORKSPACE_DIR, ".learning", "subjects", SLUG_SCOPED), {
    recursive: true,
    force: true,
  });
  fs.rmSync(TARGET_WS, { recursive: true, force: true });
});

test("归属未知旧单：科目入口可见、确认前禁写，确认归属后只写目标工作区", async ({ page }) => {
  // 同 slug 同时存在于默认工作区（A）与目标工作区（B）：确认前不得改任何一边
  const defaultArtifact = seedSubject(E2E_WORKSPACE_DIR, SLUG_SCOPED, "default-before");
  const targetArtifact = seedSubject(TARGET_WS, SLUG_SCOPED, "target-before");
  seedLegacyTicket("e2elegacy0001", SLUG_SCOPED);

  await openTicketFromSubjectEntry(page, SLUG_SCOPED);

  const panel = page.getByTestId("inspection-unknown");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("需要确认工作区");
  await expect(panel).toContainText("同名科目");

  // 确认前：会改产物的操作禁用；放弃可用
  await expect(page.getByTestId("inspection-retry-all")).toBeDisabled();
  await expect(page.getByTestId("inspection-recheck")).toBeDisabled();
  await expect(page.getByTestId("inspection-artifact")).toBeDisabled();
  await expect(page.getByTestId("inspection-abandon")).toBeEnabled();
  // 未确认前两边都不动
  expect(fs.readFileSync(defaultArtifact, "utf-8")).toBe("default-before");
  expect(fs.readFileSync(targetArtifact, "utf-8")).toBe("target-before");

  // 手输目标工作区 + 确认归属（不自动认领；候选里的默认工作区不被自动选中）
  await page.getByTestId("inspection-workspace-manual").fill(TARGET_WS);
  await page.getByTestId("inspection-confirm-ownership").click();

  await expect(page.getByTestId("inspection-unknown")).toHaveCount(0);
  await expect(page.getByTestId("inspection-retry-all")).toBeEnabled();
  await expect(page.getByTestId("inspection-artifact")).toBeEnabled();
  // 确认只持久化归属，不写文件
  expect(fs.readFileSync(targetArtifact, "utf-8")).toBe("target-before");
  expect(fs.readFileSync(defaultArtifact, "utf-8")).toBe("default-before");

  // 确认后快改只落目标工作区
  await page.getByTestId("inspection-artifact").first().click();
  const editor = page.getByTestId("inspection-editor");
  await expect(editor).toHaveValue("target-before");
  await editor.fill("target-after");
  await page.getByTestId("inspection-save").click();
  await expect.poll(() => fs.readFileSync(targetArtifact, "utf-8")).toBe("target-after");
  // 默认工作区同名科目没被误写
  expect(fs.readFileSync(defaultArtifact, "utf-8")).toBe("default-before");
});

test("已无对应科目的未知旧单：默认主页「待归属」条可见，可直接放弃且不动文件", async ({ page }) => {
  // 该 slug 只在目标工作区存在，默认工作区没有对应科目
  const targetArtifact = seedSubject(TARGET_WS, SLUG_ORPHAN, "orphan-before");
  seedLegacyTicket("e2elegacy0002", SLUG_ORPHAN);

  await page.goto("/courses");
  const strip = page.getByTestId("pending-ownership-entry");
  await expect(strip).toBeVisible();
  await strip
    .getByTestId("pending-ownership-item")
    .filter({ hasText: SLUG_ORPHAN })
    .click();
  await expect(page.getByTestId("inspection-dialog")).toBeVisible();
  await expect(page.getByTestId("inspection-unknown")).toBeVisible();
  await expect(page.getByTestId("inspection-abandon")).toBeEnabled();

  await page.getByTestId("inspection-abandon").click();
  await expect(page.getByTestId("inspection-closed")).toContainText("已放弃");

  // 放弃不改文件、不在默认工作区误建同名科目
  expect(fs.readFileSync(targetArtifact, "utf-8")).toBe("orphan-before");
  expect(
    fs.existsSync(path.join(E2E_WORKSPACE_DIR, ".learning", "subjects", SLUG_ORPHAN)),
  ).toBe(false);
});
