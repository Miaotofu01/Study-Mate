import { expect, test } from "@playwright/test";

import { associateSubject } from "./helpers";

/**
 * 产课改由会话 agent 调工具（2026-10-04 拍板：节点页「产出此课」按钮删除，
 * 产课＝agent 工具 + 用户在聊天里提）。fixture 模式下 chat 走 canned 工具脚本
 * （后端 FIXTURE_TOOL_SCRIPTS["produce"]：produce_lesson(net.layers) → 收尾文本），
 * 请求体的 fixture_scenario 由路由拦截改写，不在生产 UI 上开入口。
 *
 * 覆盖：工具卡出现在消息体（不再折进「中间过程」）、工具真的跑通（会话里留下
 * produce_lesson 的非错误结果）、以及收尾答复可见。
 */
const SUBJECT = "computer-networks";

test("a subject-associated session produces a lesson through the agent tool", async ({ page }) => {
  await page.route("**/api/chat/stream", async (route) => {
    const post = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...post, fixture_scenario: "produce" }) });
  });

  await page.goto("/chat");
  await associateSubject(page, SUBJECT);
  await page.getByRole("textbox").fill("产出第一课");
  await page.getByTitle("发送").click();

  // 工具卡常显在消息体（不是折在 panel 里），名字是 produce_lesson
  const card = page.getByTestId("tool-card").filter({ hasText: "produce_lesson" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  // 收尾答复（fixture 第二轮的文本）
  await expect(page.getByText("已产出这一课")).toBeVisible({ timeout: 20_000 });

  // 工具确实跑通了：会话里那条助手消息的 tools[0] 是 produce_lesson 且非错误
  const sessions = (await (await page.request.get("/api/sessions")).json()) as Array<{
    id: string;
    subject_slug: string | null;
  }>;
  const bound = sessions.find((item) => item.subject_slug === SUBJECT);
  expect(bound, "产课会话应绑定到科目").toBeTruthy();
  const detail = (await (await page.request.get(`/api/sessions/${bound!.id}`)).json()) as {
    messages: Array<{ tools?: Array<{ name: string; isError: boolean; result?: string }> }>;
  };
  const call = detail.messages
    .flatMap((message) => message.tools ?? [])
    .find((tool) => tool.name === "produce_lesson");
  expect(call, "会话里应留下 produce_lesson 的调用记录").toBeTruthy();
  expect(call!.isError).toBe(false);
});
