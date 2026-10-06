import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { BACKEND_URL } from "./constants";
import { associateSubject } from "./helpers";

/**
 * 生产任务（product task）端到端：会话 agent 的工具结果里带结构化 `task` 快照 /
 * `lesson` 链接 / `assessment` 结果，前端渲染成任务卡。
 *
 * 协议（在飞实现已定，见 lib/types.ts 与 lib/api.ts）：
 * - SSE `task_update`：{ id: 父 tool_call id, task: ProductionTask 完整快照 }；
 * - SSE `tool_result` 可选带 lesson（产课成功）与 assessment（评估落盘结果）；
 * - 落库后 GET /api/sessions/{id} 的 messages[].tools[] 里仍带 task / lesson / assessment。
 *
 * fixture：`production_task`（produce_lesson(net.layers) 真跑产课链生成 HTML）、
 * `assessment_failure`（assess_node(fixture-missing-node) 真实 404 工具失败）。
 * 场景经 `page.route` 只改写页面发出的 chat/stream 请求体（既有 E2E 同规），
 * 不 mock 响应、不伪造 metadata。
 *
 * 收尾判据：轮询服务端 busy=false（GET /api/sessions/{id}.streaming），
 * 不以“末段文本出现”当成完成。
 */

const SUBJECT = "computer-networks";
const NODE = "net.layers";
const MISSING_NODE = "fixture-missing-node";

let counter = 0;
const createdIds: string[] = [];

function uniqueText(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

async function listSessions(
  request: APIRequestContext,
): Promise<Array<{ id: string; subject_slug: string | null }>> {
  return (await (await request.get(`${BACKEND_URL}/api/sessions`)).json()) as Array<{
    id: string;
    subject_slug: string | null;
  }>;
}

/** 只把页面发出的 chat/stream 请求注入指定 fixture 场景（seed 走 request，不经 page.route）。 */
async function injectScenario(page: Page, scenario: string): Promise<void> {
  await page.route("**/api/chat/stream", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...body, fixture_scenario: scenario }) });
  });
}

/** 用页面 UI 发首条消息（新会话态关联科目→发送），返回新建会话 id 与标题（= 唯一首条消息）。 */
async function sendFirstMessage(
  page: Page,
  request: APIRequestContext,
  text: string,
  scenario: string,
): Promise<{ id: string; title: string }> {
  await injectScenario(page, scenario);
  const before = new Set((await listSessions(request)).map((session) => session.id));
  await page.goto("/chat");
  await associateSubject(page, SUBJECT);
  await page.getByRole("textbox").fill(text);
  await page.getByTitle("发送").click();

  let created = "";
  await expect
    .poll(
      async () => {
        const fresh = (await listSessions(request)).filter(
          (session) => !before.has(session.id) && session.subject_slug === SUBJECT,
        );
        created = fresh[0]?.id ?? "";
        return created;
      },
      { timeout: 15_000 },
    )
    .not.toBe("");
  createdIds.push(created);
  return { id: created, title: text };
}

/** 经 API 预置一个旁路会话（用于 A→B→A 切换），标题 = 唯一首条消息。 */
async function seedSession(
  request: APIRequestContext,
  text: string,
): Promise<{ id: string; title: string }> {
  const before = new Set((await listSessions(request)).map((session) => session.id));
  const res = await request.post(`${BACKEND_URL}/api/chat/stream`, {
    data: { message: text, session_id: null },
  });
  expect(res.ok(), "旁路会话 fixture 流应正常返回").toBeTruthy();
  const fresh = (await listSessions(request)).filter((session) => !before.has(session.id));
  expect(fresh, "应新建且只新建一个旁路会话").toHaveLength(1);
  createdIds.push(fresh[0].id);
  return { id: fresh[0].id, title: text };
}

/** 轮询到服务端本轮结束（streaming=false）——不以末段文本出现当 done。 */
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
  task?: Record<string, unknown>;
  lesson?: Record<string, unknown>;
  assessment?: Record<string, unknown>;
};

async function findTool(
  request: APIRequestContext,
  sessionId: string,
  name: string,
): Promise<{ content: string; tool: ToolRecord } | null> {
  const detail = (await (await request.get(`${BACKEND_URL}/api/sessions/${sessionId}`)).json()) as {
    messages: Array<{ role: string; content?: string; tools?: ToolRecord[] }>;
  };
  for (const message of detail.messages) {
    const tool = (message.tools ?? []).find((item) => item.name === name);
    if (tool) return { content: message.content ?? "", tool };
  }
  return null;
}

test.afterEach(async ({ request }) => {
  while (createdIds.length) {
    const id = createdIds.pop()!;
    await request.delete(`${BACKEND_URL}/api/sessions/${id}`).catch(() => undefined);
  }
});

test("production task renders a single card with a lesson entry and persists the snapshot", async ({
  page,
  request,
}) => {
  const { id, title } = await sendFirstMessage(page, request, uniqueText("产出第一课"), "production_task");
  await expect(page.getByTestId("chat-title")).toHaveText(title);

  // 单卡：这一次产课只渲染一张任务卡
  const card = page.getByTestId("production-task-card");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(card.getByTestId("task-title")).toBeVisible();
  await expect(card.getByTestId("task-status")).toBeVisible();
  await expect(card.getByTestId("task-status")).toHaveText("已完成");
  // 终态不再显示「当前阶段」（后端收尾清空 task.stage）；阶段历史仍保留在 events 里。
  await expect(card.getByTestId("task-stage-current")).toHaveCount(0);
  // 角色与阶段结构存在；只断言 fixture 真实走到的阶段。fixture 的 produce 走
  // factory() 单次派工（见 backend/app/produce.py 的 is_fixture_mode 分支），
  // 不经过角色的 `_role_tool_loop`，因此**没有**「交付自检」——那是非 fixture 的
  // 工具循环自检，归后端 mock-role 单测，不在这里假造。
  await expect(card.getByTestId("task-role").first()).toBeVisible();
  const stages = card.getByTestId("task-stages");
  await expect(stages).toContainText("讲解");
  await expect(stages).toContainText("出题");
  await expect(stages).toContainText("渲染");
  await expect(stages).toContainText("检查");
  // 真实历史阶段：渲染 / 检查 都已 done（终态卡不靠 task-stage-current 撑门面）
  await expect(card.getByTestId("task-stage").filter({ hasText: "渲染" })).toHaveAttribute(
    "data-status",
    "done",
  );
  await expect(card.getByTestId("task-stage").filter({ hasText: "检查" })).toHaveAttribute(
    "data-status",
    "done",
  );

  // 课件入口常显（不在折叠 details 里），href 指向 /lesson?subject&node&workspace
  const openLesson = page.getByTestId("open-lesson");
  await expect(openLesson).toBeVisible();
  const href = await openLesson.getAttribute("href");
  expect(href, "打开课件应有 href").toBeTruthy();
  const url = new URL(href!, "http://localhost");
  expect(url.pathname).toBe("/lesson");
  expect(url.searchParams.get("subject")).toBe(SUBJECT);
  expect(url.searchParams.get("node")).toBe(NODE);
  expect(url.searchParams.get("workspace"), "课件链接应带已解析工作区").toBeTruthy();

  // 收尾：轮询服务端结束，再核对落库的快照/链接
  await waitIdle(request, id);
  const found = await findTool(request, id, "produce_lesson");
  expect(found, "会话里应留下 produce_lesson 记录").toBeTruthy();
  expect(found!.tool.isError).toBe(false);
  const task = found!.tool.task;
  expect(task, "落库工具记录应带 task 快照").toBeTruthy();
  expect(task!.status).toBe("done");
  expect(task!.subject_slug).toBe(SUBJECT);
  expect(task!.node_id).toBe(NODE);
  expect(String(task!.workspace)).toBeTruthy();
  const lesson = found!.tool.lesson;
  expect(lesson, "落库工具记录应带 lesson 链接").toBeTruthy();
  expect(lesson!.subject_slug).toBe(SUBJECT);
  expect(lesson!.node_id).toBe(NODE);
  expect(String(lesson!.workspace)).toBeTruthy();
});

test("assessment failure shows the system failed box over the model's success claim", async ({
  page,
  request,
}) => {
  const { id } = await sendFirstMessage(page, request, uniqueText("评估这一节"), "assessment_failure");

  // 系统结果框以 assessment 元数据为准，不被末段“我认为通过”的文字冒充
  const status = page.getByTestId("assessment-status");
  await expect(status).toBeVisible({ timeout: 30_000 });
  await expect(status).toHaveAttribute("data-status", "failed");
  await expect(status).toContainText("评估失败，未保存，未启动后台修复");

  // 模型末段仍自称通过：可见，但不得据此判定评估成功
  await expect(page.getByTestId("chat-messages")).toContainText("我认为通过");

  await waitIdle(request, id);
  const found = await findTool(request, id, "assess_node");
  expect(found, "会话里应留下 assess_node 记录").toBeTruthy();
  expect(found!.tool.isError).toBe(true);
  const assessment = found!.tool.assessment;
  expect(assessment, "工具结果应带 assessment 元数据").toBeTruthy();
  expect(assessment!.status).toBe("failed");
  expect(assessment!.node_id).toBe(MISSING_NODE);
  expect(assessment!.background).toBe(false);
});

test("production task card survives A→B→A switching and reload", async ({ page, request }) => {
  // 旁路会话先预置（页面加载时即可在侧栏点到），避免切换时再触发一次侧栏刷新
  const b = await seedSession(request, uniqueText("旁路会话"));
  const a = await sendFirstMessage(page, request, uniqueText("生产任务A"), "production_task");

  // 任务链（fixture factory）在 role_start→role_end 之间无延迟，追加「必须处于 running 窗口」
  // 的断言极易 flaky；流式中切走的生命周期已由 chat-stream-lifecycle（stream_order）钉住，
  // 这里只测「切换 + reload 后快照/lesson 仍持久」。
  const card = page.getByTestId("production-task-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await waitIdle(request, a.id);

  // A→B→A：侧栏 SPA 点击切换，不是 page.goto 伪切换
  const sidebar = page.locator("aside").first();
  await sidebar.getByText(b.title).click();
  await expect(page.getByTestId("chat-title")).toHaveText(b.title);
  await sidebar.getByText(a.title).click();
  await expect(page.getByTestId("chat-title")).toHaveText(a.title);

  // 切回后任务卡与课件入口仍从落库快照恢复
  await expect(card).toHaveAttribute("data-status", "done");
  await expect(card.getByTestId("open-lesson")).toBeVisible();

  // reload：任务卡从落库快照恢复，课件入口仍在
  await page.reload();
  const sidebar2 = page.locator("aside").first();
  await sidebar2.getByText(a.title).click();
  await expect(page.getByTestId("chat-title")).toHaveText(a.title);
  const restored = page.getByTestId("production-task-card");
  await expect(restored).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(restored.getByTestId("open-lesson")).toBeVisible();
});
