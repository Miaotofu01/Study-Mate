import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { BACKEND_URL, E2E_WORKSPACE_DIR, subjectDir } from "./constants";
import { associateWorkspace } from "./helpers";

/**
 * 会话级工作区隔离的真正端到端回归（对应 P1：科目读写必须落在会话绑定的工作区）。
 *
 * 布置：A = fixture 默认工作区（E2E_WORKSPACE_DIR，已含 computer-networks）；测试临时造一个
 * B（与 A 同 slug `computer-networks`，但科目名不同），只在 data/ 下，绝不碰真实数据。
 *
 * 为了让 B 出现在「新对话态关联工作区」下拉里，只 mock 掉 GET /api/workspace 的**候选列表**
 * 响应（把 A、B 都列为候选）。A 仍是后端默认工作区——所以一旦前端漏传 `?workspace=`，写盘会
 * 落到 A，下面的「A 不变 / B 变」断言就会失败，这条用例才真正守得住修复。
 *
 * 旅程：UI 关联会话工作区 B → 侧栏进入课程详情（应为 B 的标识）→ 保存节点进度 →
 * 断言 B 的 progress.yaml 变化、A 的逐字节不变（磁盘 + 后端 API 双证）→ 打开课件 iframe →
 * 断言 iframe 走 /api/workspace-files 前缀，且多层嵌套资源（课件页 + ../assets 资源）返回 200
 * 且内容来自 B（B 专属标记）。
 *
 * 数据唯一化 + 自带前后清理：B 每次先删后建；用例末尾删除 B；不新建会话、不改 fixture 配置，
 * 因此不依赖其它 spec 的执行顺序。
 */

const SLUG = "computer-networks";
const NODE_ID = "net.layers";
const B_SUBJECT_NAME = "计算机网络（E2E-B 隔离副本）";
const B_ASSET_MARKER = "E2E-WS-B-ASSET-MARKER";

const WORKSPACE_B = path.join(path.dirname(E2E_WORKSPACE_DIR), "e2e-ws-b");

function subjectProgressFile(workspace: string): string {
  return path.join(workspace, ".learning", "subjects", SLUG, "progress.yaml");
}

/** A 的科目目录（fixture 已备好），用于复制出 B。 */
const sourceSubjectDir = () => subjectDir(SLUG);

function makeWorkspaceB(): void {
  fs.rmSync(WORKSPACE_B, { recursive: true, force: true });
  const dst = path.join(WORKSPACE_B, ".learning", "subjects", SLUG);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(sourceSubjectDir(), dst, { recursive: true });

  // 同 slug、不同标识：改科目名（列表/详情应显示 B 的名字）
  const subjectYaml = path.join(dst, "subject.yaml");
  const yaml = fs.readFileSync(subjectYaml, "utf-8").replace(/^name:.*$/m, `name: ${B_SUBJECT_NAME}`);
  fs.writeFileSync(subjectYaml, yaml, "utf-8");

  // B 专属资源标记：证明嵌套资源内容确实来自 B，而不是默认工作区
  fs.appendFileSync(
    path.join(dst, "assets", "style.css"),
    `\n/* ${B_ASSET_MARKER} */\n`,
    "utf-8",
  );
}

function workspaceToken(workspace: string): string {
  // 与后端 workspace_files.encode_workspace_token 同口径：UTF-8 → base64url 无填充
  return Buffer.from(workspace, "utf8").toString("base64url");
}

test("session-bound workspace isolates course reads/writes and iframe nested assets", async ({
  page,
  request,
}) => {
  makeWorkspaceB();
  const aProgressFile = subjectProgressFile(E2E_WORKSPACE_DIR);
  const bProgressFile = subjectProgressFile(WORKSPACE_B);
  const aBefore = fs.existsSync(aProgressFile) ? fs.readFileSync(aProgressFile, "utf-8") : "";
  const bBefore = fs.readFileSync(bProgressFile, "utf-8");

  // 只把候选列表补上 B（后端默认工作区仍是 A）
  await page.route("**/api/workspace", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/workspace" && !url.searchParams.has("path")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          path: E2E_WORKSPACE_DIR,
          source: "E2E review fixture",
          exists: true,
          subjects_dir: path.join(E2E_WORKSPACE_DIR, ".learning", "subjects"),
          config_path: "",
          subject_count: 1,
          candidates: [E2E_WORKSPACE_DIR, WORKSPACE_B],
        }),
      });
      return;
    }
    await route.continue();
  });

  try {
    // 记录节点进度写入请求，确认前端确实带了 workspace
    const progressWrites: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (req.method() === "PUT" && url.includes(`/nodes/${NODE_ID}/progress`)) {
        progressWrites.push(url);
      }
    });

    await page.goto("/chat");
    const row = page.getByTestId("new-session-association");
    await expect(row).toBeVisible();
    const subjectSelect = row.getByTitle("关联科目", { exact: true });

    // UI 关联到 B：科目列表按 B 重载，显示 B 的标识
    await associateWorkspace(page, WORKSPACE_B);
    await expect(subjectSelect.locator("option", { hasText: B_SUBJECT_NAME })).toHaveCount(1);

    // 侧栏进入课程详情（SPA，保留 activeWorkspace=B；不得整页刷新，否则内存态丢失）
    const sidebar = page.locator("aside").first();
    await sidebar.getByRole("button", { name: B_SUBJECT_NAME }).click();
    await expect(page).toHaveURL(new RegExp(`/courses\\?subject=${SLUG}`));
    await expect(page.getByRole("heading", { name: B_SUBJECT_NAME })).toBeVisible();

    // 选中节点（sr-only 节点按钮可触发；不走 openNodeDetail，避免整页导航丢工作区）
    await page.getByTestId(`graph-node-${NODE_ID}`).dispatchEvent("click");
    const detail = page.getByTestId("course-node-detail");
    await expect(detail).toBeVisible();
    await expect(page.getByRole("heading", { name: "分层模型与封装" })).toBeVisible();

    // 保存进度（掌握度 + 唯一笔记，保证 B 一定发生可判别变化）
    const uniqueNote = `E2E-REVIEW-B-${Date.now()}`;
    await detail.locator('input[type="range"]').evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(el, "0.05");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await detail.getByPlaceholder("记录你的理解、卡点…").fill(uniqueNote);
    await detail.getByRole("button", { name: "保存进度" }).click();
    await expect(detail.getByText("已保存")).toBeVisible();

    // 写入请求带 workspace=B（前端透传的直接证据）
    expect(progressWrites.length).toBeGreaterThan(0);
    expect(
      progressWrites.some(
        (u) => (new URL(u).searchParams.get("workspace") ?? "").toLowerCase() === WORKSPACE_B.toLowerCase(),
      ),
    ).toBe(true);

    // B 变：磁盘 progress.yaml 出现唯一笔记；A 逐字节不变（缺一即说明读写落错了工作区）
    await expect
      .poll(() => fs.readFileSync(bProgressFile, "utf-8"))
      .toContain(uniqueNote);
    const bAfter = fs.readFileSync(bProgressFile, "utf-8");
    expect(bAfter).not.toBe(bBefore);
    const aAfter = fs.readFileSync(aProgressFile, "utf-8");
    expect(aAfter).toBe(aBefore);
    expect(aAfter).not.toContain(uniqueNote);

    // 后端 API 双证：同一 slug，A 的节点状态/笔记与 B 不同（B 已改、A 未改）
    const aApi = (await (await request.get(`${BACKEND_URL}/api/courses/${SLUG}?workspace=${encodeURIComponent(E2E_WORKSPACE_DIR)}`)).json()) as {
      graph: { nodes: Array<{ id: string; notes: string }> };
    };
    const bApi = (await (await request.get(`${BACKEND_URL}/api/courses/${SLUG}?workspace=${encodeURIComponent(WORKSPACE_B)}`)).json()) as {
      subject: { name: string };
      graph: { nodes: Array<{ id: string; notes: string }> };
    };
    expect(bApi.subject.name).toBe(B_SUBJECT_NAME);
    expect(bApi.graph.nodes.find((n) => n.id === NODE_ID)?.notes).toContain(uniqueNote);
    expect(aApi.graph.nodes.find((n) => n.id === NODE_ID)?.notes ?? "").not.toContain(uniqueNote);

    // 课件 iframe：URL 与 iframe src 都带 workspace=B 的前缀路由
    await page.getByRole("button", { name: "打开课件" }).click();
    await expect(page).toHaveURL(new RegExp(`/lesson\\?.*workspace=`));
    await expect
      .poll(() => (new URL(page.url()).searchParams.get("workspace") ?? "").toLowerCase())
      .toBe(WORKSPACE_B.toLowerCase());

    const iframeSrc = await page.locator("iframe").getAttribute("src");
    expect(iframeSrc, "课件 iframe 应走 /api/workspace-files 前缀").toContain("/api/workspace-files/");
    const frame = page.frameLocator("iframe");
    await expect(frame.locator("h1")).toContainText("分层模型与封装");

    // 多层嵌套资源：课件页 + `../assets` 科目资源都要 200，且科目资源内容来自 B（专属标记）
    const token = workspaceToken(WORKSPACE_B);
    const wsBase = `${BACKEND_URL}/api/workspace-files/${token}`;
    const lessonRes = await request.get(`${wsBase}/courses/${SLUG}/files/lessons/0001-${NODE_ID}.html`);
    expect(lessonRes.ok()).toBe(true);
    expect(await lessonRes.text()).toContain("分层模型与封装");

    const assetRes = await request.get(`${wsBase}/courses/${SLUG}/files/assets/style.css`);
    expect(assetRes.ok()).toBe(true);
    expect(await assetRes.text()).toContain(B_ASSET_MARKER);

    // 同一共享/科目资源在默认工作区（A）里不含 B 标记 → 内容确实来自 B
    const defaultAsset = await request.get(
      `${BACKEND_URL}/api/courses/${SLUG}/files/assets/style.css`,
    );
    expect(defaultAsset.ok()).toBe(true);
    expect(await defaultAsset.text()).not.toContain(B_ASSET_MARKER);
  } finally {
    fs.rmSync(WORKSPACE_B, { recursive: true, force: true });
  }
});
