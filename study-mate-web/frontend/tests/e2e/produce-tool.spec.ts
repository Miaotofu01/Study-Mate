import { expect, test } from "@playwright/test";

import { associateSubject } from "./helpers";

/**
 * 产课由会话 agent 调 produce_lesson（节点页「产出此课」按钮已删）。fixture 模式下 chat 走
 * canned 工具脚本（backend FIXTURE_TOOL_SCRIPTS["produce"]：produce_lesson(net.layers) → 收尾文本），
 * 请求体的 fixture_scenario 由路由拦截改写，不在生产 UI 上开入口。
 *
 * 新 UI：produce_lesson 的工具结果带 task 快照，前端渲染成 production-task-card（替代旧
 * tool-card），任务卡走到 done 并给出常显的课件入口——不是后端未 emit。
 *
 * 覆盖：任务卡终态 + 课件入口 + 按**精确会话 id**核对落库工具结果（非错误 + task/lesson 元数据）。
 */
const SUBJECT = "computer-networks";
const NODE = "net.layers";

test("a subject-associated session produces a lesson through the agent tool", async ({ page }) => {
  await page.route("**/api/chat/stream", async (route) => {
    const post = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...post, fixture_scenario: "produce" }) });
  });

  await page.goto("/chat");
  await associateSubject(page, SUBJECT);

  // 精确记下本次新建会话 id：监听 POST /api/chat/stream 的响应，从 SSE 的 session 事件取 id。
  // 不再按 subject_slug 去 sessions 里 find——同科目可能有其它会话，会撞错。
  const streamed = page.waitForResponse(
    (res) => res.url().includes("/api/chat/stream") && res.request().method() === "POST",
  );
  await page.getByRole("textbox").fill("产出第一课");
  await page.getByTitle("发送").click();
  const streamText = await (await streamed).text();
  const sessionId = streamText.match(/"session_id"\s*:\s*"([^"]+)"/)?.[1];
  expect(sessionId, "SSE 的 session 事件应带 session_id").toBeTruthy();

  // 新 UI：产课任务卡（替换旧 tool-card）走到终态，课件入口常显
  const card = page.getByTestId("production-task-card");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(page.getByTestId("open-lesson")).toBeVisible();

  // 收尾答复（fixture 第二轮的文本）
  await expect(page.getByText("已产出这一课")).toBeVisible({ timeout: 20_000 });

  // 轮询服务端本轮结束（不以末段文本出现当 done），再按精确 id 读落库记录
  await expect
    .poll(
      async () =>
        Boolean(
          (
            (await (await page.request.get(`/api/sessions/${sessionId}`)).json()) as {
              streaming?: boolean;
            }
          ).streaming,
        ),
      { timeout: 30_000 },
    )
    .toBe(false);

  const detail = (await (await page.request.get(`/api/sessions/${sessionId}`)).json()) as {
    messages: Array<{
      tools?: Array<{
        name: string;
        isError: boolean;
        task?: { status: string };
        lesson?: { subject_slug: string; node_id: string };
      }>;
    }>;
  };
  const call = detail.messages
    .flatMap((message) => message.tools ?? [])
    .find((tool) => tool.name === "produce_lesson");
  expect(call, "会话里应留下 produce_lesson 的调用记录").toBeTruthy();
  expect(call!.isError).toBe(false);
  expect(call!.task?.status).toBe("done");
  expect(call!.lesson?.subject_slug).toBe(SUBJECT);
  expect(call!.lesson?.node_id).toBe(NODE);
});
