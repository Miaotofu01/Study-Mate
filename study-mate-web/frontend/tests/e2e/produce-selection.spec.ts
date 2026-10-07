import fs from "node:fs";
import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { BACKEND_URL, E2E_WORKSPACE_DIR, subjectDir } from "./constants";
import { associateSubject } from "./helpers";

/**
 * 产课节点选择回归 + 备用派工卡片回放。
 *
 * 第一条（空参数 `produce_lesson({})` 选节点）跑**真实 HTTP fixture 后端**，不 mock 响应、
 * 不伪造 metadata。文件下半部分另有一条**明确标注为 UI-only** 的落库快照回放用例
 * （mock GET /api/sessions，不发真实模型事件）。
 *
 * 真实事故：用户在「已学过第一课」的会话里要下一课，模型调 `produce_lesson({})`；
 * 旧实现把会话聚焦节点（第一课，已产出）当成目标 → 又产了一遍第一课。
 * 期望：**没有显式 node_id 时严格按大纲顺序选第一个未产出节点**。
 *
 * 驱动 fixture：`fixture_scenario=produce_next`（backend `FIXTURE_TOOL_SCRIPTS`）第一条
 * 就是 `produce_lesson(arguments="{}")`，没有其它后门；断言只落在工具结果的
 * `lesson` / `task` 快照上。修复前本用例会得到 node1，修复后才得到 node2。
 *
 * 独立临时科目（现有 API 建，用完删），不碰共享 computer-networks，避免并发污染。
 */

const NODE1 = "reg-alpha";
const NODE2 = "reg-beta";
const FINAL_TEXT = "已按大纲顺序处理下一节尚未产出的课件，请以工具结果为准。";

let counter = 0;
const createdSubjects: string[] = [];
const createdSessions: string[] = [];

function uniqueSlug(): string {
  counter += 1;
  return `e2e-reg-${Date.now()}-${counter}`;
}

/** 现有 API 建两节点（均概念）临时科目；第二课 = 第一个未产出节点。 */
async function createTwoNodeSubject(request: APIRequestContext, slug: string): Promise<void> {
  const created = await request.post(`${BACKEND_URL}/api/courses`, {
    data: { name: `产课选择回归 ${slug}`, slug, goal: "验证空参数产课的节点选择" },
  });
  expect(created.ok(), `创建临时科目应成功：${created.status()}`).toBeTruthy();
  const saved = await request.put(`${BACKEND_URL}/api/courses/${slug}/curriculum`, {
    data: {
      nodes: [
        {
          id: NODE1,
          title: "回归第一课",
          kind: "概念",
          objective: "为回归建立已产出的第一课",
          problem: "E2E 记录用节点",
          prerequisites: [],
          status: "未开始",
          mastery: 0,
        },
        {
          id: NODE2,
          title: "回归第二课",
          kind: "概念",
          objective: "验证空参数产课落在第一个未产出节点",
          problem: "E2E 记录用节点",
          prerequisites: [NODE1],
          status: "未开始",
          mastery: 0,
        },
      ],
      edges: [{ from: NODE1, to: NODE2, reason: "" }],
    },
  });
  expect(saved.ok(), `写入两节点大纲应成功：${saved.status()}`).toBeTruthy();
}

/**
 * 经真实 HTTP 产课端点把第一课**完整**产出（.md / .quiz.json / .html）。
 *
 * 不能只种 `.md` 占位：上游 `check_lesson.py` 的编号规则只看同目录 `*.html`
 * （`NUMBERED_NAME_RE = ^(\d{4})-.*\.html$`）。目录里没有 `0001-*.html` 时，第二课的
 * `0002-*.html` 会被判成「同目录第一份课件应 0001 → 跳号」，真产课链 check 失败、
 * 任务转 error。必须走真实产课链让首课产物齐备，不放宽产品 check。
 */
async function produceFirstLesson(request: APIRequestContext, slug: string): Promise<void> {
  const res = await request.post(`${BACKEND_URL}/api/courses/${slug}/nodes/${NODE1}/produce`, {
    data: { session_id: null },
    timeout: 60_000,
  });
  expect(res.ok(), `第一课产课请求应成功：${res.status()}`).toBeTruthy();
  const body = await res.text();
  // 该端点会顺带建一个「编排」会话；记录并在收尾删除，避免污染其它用例的侧栏。
  const orchSession = body.match(/"session_id"\s*:\s*"([^"]+)"/)?.[1];
  if (orchSession) createdSessions.push(orchSession);
  expect(body, "第一课应真实走完产课链（done）").toContain("event: done");
  const lessons = path.join(subjectDir(slug), "lessons");
  expect(
    fs.existsSync(path.join(lessons, `0001-${NODE1}.html`)),
    "第一课 html 应落盘",
  ).toBeTruthy();
  expect(
    fs.existsSync(path.join(lessons, `0001-${NODE1}.quiz.json`)),
    "第一课题库应落盘",
  ).toBeTruthy();
}

/** 第一课置为学习中 → 服务端聚焦节点 = 第一课（复刻真实事故的 ctx 聚焦）。 */
async function markFirstLessonStudying(
  request: APIRequestContext,
  slug: string,
): Promise<void> {
  const res = await request.put(`${BACKEND_URL}/api/courses/${slug}/nodes/${NODE1}/progress`, {
    data: { status: "学习中" },
  });
  expect(res.ok(), `第一课置为学习中应成功：${res.status()}`).toBeTruthy();
}

/** UI 发首条消息并注入 produce_next 场景，返回新建会话 id。 */
async function sendProduceNext(page: Page, slug: string, text: string): Promise<string> {
  await page.route("**/api/chat/stream", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...body, fixture_scenario: "produce_next" }) });
  });

  await page.goto("/chat");
  await associateSubject(page, slug);

  const streamed = page.waitForResponse(
    (res) => res.url().includes("/api/chat/stream") && res.request().method() === "POST",
  );
  await page.getByRole("textbox").fill(text);
  await page.getByTitle("发送").click();
  const streamText = await (await streamed).text();
  const sessionId = streamText.match(/"session_id"\s*:\s*"([^"]+)"/)?.[1];
  expect(sessionId, "SSE 的 session 事件应带 session_id").toBeTruthy();
  createdSessions.push(sessionId!);
  return sessionId!;
}

async function waitIdle(request: APIRequestContext, sessionId: string): Promise<void> {
  await expect
    .poll(
      async () =>
        Boolean(
          (
            (await (await request.get(`${BACKEND_URL}/api/sessions/${sessionId}`)).json()) as {
              streaming?: boolean;
            }
          ).streaming,
        ),
      { timeout: 30_000 },
    )
    .toBe(false);
}

type ToolRecord = Record<string, unknown> & {
  name?: string;
  isError?: boolean;
  task?: { status?: string; node_id?: string };
  lesson?: { subject_slug?: string; node_id?: string };
};

async function findTool(
  request: APIRequestContext,
  sessionId: string,
  name: string,
): Promise<ToolRecord | null> {
  const detail = (await (await request.get(`${BACKEND_URL}/api/sessions/${sessionId}`)).json()) as {
    messages: Array<{ tools?: ToolRecord[] }>;
  };
  for (const message of detail.messages) {
    const tool = (message.tools ?? []).find((item) => item.name === name);
    if (tool) return tool;
  }
  return null;
}

test.afterEach(async ({ request }) => {
  while (createdSessions.length) {
    const id = createdSessions.pop()!;
    await request.delete(`${BACKEND_URL}/api/sessions/${id}`).catch(() => undefined);
  }
  while (createdSubjects.length) {
    const slug = createdSubjects.pop()!;
    await request.delete(`${BACKEND_URL}/api/courses/${slug}`).catch(() => undefined);
  }
});

test("empty-arg produce_lesson picks the first unproduced node, not the focused produced one", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const slug = uniqueSlug();
  createdSubjects.push(slug);
  await createTwoNodeSubject(request, slug);
  await produceFirstLesson(request, slug);
  await markFirstLessonStudying(request, slug);

  const sessionId = await sendProduceNext(page, slug, "产出下一课");

  // 任务卡走到终态；入口常显（真跑产课链生成 HTML）
  const card = page.getByTestId("production-task-card");
  await expect(card).toHaveCount(1);
  // 先等任一终态，再抓证据后断言 done：afterEach 会删会话与临时科目，失败后无从回查。
  await expect
    .poll(async () => (await card.getAttribute("data-status")) ?? "", { timeout: 45_000 })
    .toMatch(/^(done|error|interrupted|timeout)$/);
  if ((await card.getAttribute("data-status")) !== "done") {
    await waitIdle(request, sessionId);
    const record = await findTool(request, sessionId, "produce_lesson");
    await test.info().attach("produce_lesson 落库记录（失败现场）", {
      contentType: "application/json",
      body: JSON.stringify(record, null, 2),
    });
    const cardError = await card.getByTestId("task-error").textContent().catch(() => null);
    if (cardError) {
      await test.info().attach("任务卡 task-error 文本", {
        contentType: "text/plain",
        body: cardError,
      });
    }
  }
  await expect(card).toHaveAttribute("data-status", "done", { timeout: 45_000 });
  await expect(card.getByTestId("open-lesson")).toBeVisible();
  await expect(page.getByText(FINAL_TEXT)).toBeVisible({ timeout: 20_000 });

  // 服务端本轮结束，再按精确会话 id 核对落库的工具结果
  await waitIdle(request, sessionId);
  const call = await findTool(request, sessionId, "produce_lesson");
  expect(call, "会话里应留下 produce_lesson 记录").toBeTruthy();
  expect(call!.isError).toBe(false);
  expect(call!.task?.status).toBe("done");
  // 核心断言：空参数产课落在第一个未产出节点（node2），而不是聚焦的已产出 node1。
  expect(call!.task?.node_id).toBe(NODE2);
  expect(call!.lesson?.subject_slug).toBe(slug);
  expect(call!.lesson?.node_id).toBe(NODE2);
});

// ---------------------------------------------------------------------------
// UI 契约回放（**仅 UI**，mock GET /api/sessions 的落库快照，不发真实模型事件、
// 不伪造后端 role_start/task_update；HTTP 真实后端 fixture 的产课回归见上面的用例）。
//
// 场景：首次派工（execution_mode=tools）未交付 → 自动备用派工（execution_mode=fallback）。
// 「历史失败 + 重试」即这两个角色**共存**在落库快照里，不是新的手动重试控件。
// 参数化两种终态：done（备用交付成功）/ error（备用仍未交付）。
// 断言：首次失败角色保留、备用派工时限与原因、任务终态非 running、reload 后字段不丢。
// ---------------------------------------------------------------------------

const REPLAY_SESSION_ID = "e2e-replay-session";
const REPLAY_TITLE = "回放：首次未交付加备用派工";

function replaySessionMeta(): Record<string, unknown> {
  const now = Date.now() / 1000;
  return {
    id: REPLAY_SESSION_ID,
    title: REPLAY_TITLE,
    message_count: 1,
    created_at: now,
    updated_at: now,
    subject_slug: null,
    node_id: null,
    mode: "chat",
    workspace: null,
    usage: null,
  };
}

/** 落库的产课任务快照：首个 tools 角色 error，其后 fallback 角色随终态取 done/error。 */
function replayTask(terminal: "done" | "error"): Record<string, unknown> {
  const nodeId = "net.layers";
  return {
    id: "call-replay-1",
    kind: "produce_lesson",
    title: "回放：首次未交付 + 备用派工",
    subject_slug: "computer-networks",
    node_id: nodeId,
    workspace: E2E_WORKSPACE_DIR,
    status: terminal,
    stage: "检查",
    elapsed_s: 128,
    round: 1,
    roles: [
      {
        id: "role-first",
        name: "讲解",
        status: "error",
        parts: [],
        tools: [],
        round: 1,
        elapsed_s: 31,
        execution_mode: "tools",
        message: "角色工具循环未交付，回落单次派工",
      },
      {
        id: "role-fallback",
        name: "讲解",
        status: terminal,
        parts: [],
        tools: [],
        round: 0,
        elapsed_s: 97,
        execution_mode: "fallback",
        fallback_reason: "角色工具循环未交付",
        max_seconds: 1800,
      },
    ],
    events: [{ id: "stage-check", name: "检查", status: terminal === "done" ? "done" : "error" }],
    ...(terminal === "done"
      ? {
          lesson: {
            subject_slug: "computer-networks",
            node_id: nodeId,
            title: "分层模型与封装",
            workspace: E2E_WORKSPACE_DIR,
            file: "lessons/0001-net.layers.html",
          },
        }
      : { error: "备用派工仍未交付，已停止" }),
  };
}

function replaySessionDetail(terminal: "done" | "error"): Record<string, unknown> {
  const now = Date.now() / 1000;
  return {
    id: REPLAY_SESSION_ID,
    title: REPLAY_TITLE,
    created_at: now,
    updated_at: now,
    streaming: false,
    subject_slug: null,
    node_id: null,
    mode: "chat",
    workspace: null,
    usage: null,
    messages: [
      {
        role: "assistant",
        content: terminal === "done" ? "已产出这一课" : "备用派工仍未交付",
        tools: [
          {
            id: "call-replay-1",
            name: "produce_lesson",
            arguments: "{}",
            status: terminal,
            isError: terminal === "error",
            task: replayTask(terminal),
          },
        ],
      },
    ],
  };
}

for (const terminal of ["done", "error"] as const) {
  test(`persisted fallback card replays first error + fallback limits (${terminal})`, async ({
    page,
  }) => {
    await page.route("**/api/sessions**", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/sessions") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([replaySessionMeta()]),
        });
      }
      if (pathname === `/api/sessions/${REPLAY_SESSION_ID}`) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(replaySessionDetail(terminal)),
        });
      }
      return route.continue();
    });

    await page.goto("/chat");
    await page.locator("aside").first().getByText(REPLAY_TITLE).first().click();

    const card = page.getByTestId("production-task-card");
    await expect(card).toHaveAttribute("data-status", terminal);
    // 首次派工失败保留在快照里（与自动备用派工角色共存）
    await expect(
      card.locator('[data-testid="task-role"][data-role-id="role-first"]'),
    ).toHaveAttribute("data-status", "error");
    // 备用派工角色：执行方式 + 固定原因 + 调用时限
    await expect(
      card.locator('[data-testid="task-role"][data-role-id="role-fallback"]'),
    ).toHaveAttribute("data-execution-mode", "fallback");
    const note = card.getByTestId("fallback-note");
    await expect(note).toHaveAttribute("data-status", terminal);
    await expect(note).toContainText("原因：角色工具循环未交付");
    await expect(card.getByTestId("fallback-limit")).toContainText("调用时限 1800s");
    // 结束态文案：不是「正在备用派工」
    await expect(card.getByTestId("fallback-status")).toContainText(
      terminal === "done" ? "备用派工已完成" : "备用派工失败",
    );
    // 结束态：任务与所有角色都不再是 running
    await expect(card).not.toHaveAttribute("data-status", "running");
    for (const role of await card.getByTestId("task-role").all()) {
      await expect(role).not.toHaveAttribute("data-status", "running");
    }

    // reload：同一落库快照重放，字段不丢
    await page.reload();
    await page.locator("aside").first().getByText(REPLAY_TITLE).first().click();
    const restored = page.getByTestId("production-task-card");
    await expect(restored).toHaveAttribute("data-status", terminal);
    await expect(
      restored.locator('[data-testid="task-role"][data-role-id="role-first"]'),
    ).toHaveAttribute("data-status", "error");
    await expect(
      restored.locator('[data-testid="task-role"][data-role-id="role-fallback"]'),
    ).toHaveAttribute("data-execution-mode", "fallback");
    await expect(restored.getByTestId("fallback-limit")).toContainText("调用时限 1800s");
    await expect(restored.getByTestId("fallback-note")).toContainText("原因：角色工具循环未交付");
  });
}
