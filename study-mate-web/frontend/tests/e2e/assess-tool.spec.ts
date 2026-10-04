import { expect, test } from "@playwright/test";

import { associateSubject } from "./helpers";

/**
 * 评估同样改由会话 agent 调工具（节点页「申请评估」块删除）。fixture 模式下走
 * FIXTURE_TOOL_SCRIPTS["assess"]：assess_node(net.layers, evidence) → 收尾文本。
 *
 * 覆盖：工具卡常显 + 工具拿到判定结果（非错误）+ 评估记录真的落盘。
 */
const SUBJECT = "computer-networks";
const NODE = "net.layers";

test("a subject-associated session assesses a node through the agent tool", async ({ page }) => {
  await page.route("**/api/chat/stream", async (route) => {
    const post = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...post, fixture_scenario: "assess" }) });
  });

  await page.goto("/chat");
  await associateSubject(page, SUBJECT);
  await page.getByRole("textbox").fill("帮我评估一下这一节");
  await page.getByTitle("发送").click();

  const card = page.getByTestId("tool-card").filter({ hasText: "assess_node" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("评估完成")).toBeVisible({ timeout: 20_000 });

  // 工具结果里带回判定（fixture 的评估派工）
  const sessions = (await (await page.request.get("/api/sessions")).json()) as Array<{
    id: string;
    subject_slug: string | null;
  }>;
  const bound = sessions.find((item) => item.subject_slug === SUBJECT);
  expect(bound, "评估会话应绑定到科目").toBeTruthy();
  const detail = (await (await page.request.get(`/api/sessions/${bound!.id}`)).json()) as {
    messages: Array<{ tools?: Array<{ name: string; isError: boolean; result?: string }> }>;
  };
  const call = detail.messages.flatMap((message) => message.tools ?? []).find((t) => t.name === "assess_node");
  expect(call, "会话里应留下 assess_node 的调用记录").toBeTruthy();
  expect(call!.isError).toBe(false);
  expect(String(call!.result)).toContain("判定");

  // 评估记录落盘（记录区接口能看到这一节的评估）
  const records = (await (
    await page.request.get(`/api/courses/${SUBJECT}/records`)
  ).json()) as { assessments?: Array<{ node?: string }> };
  expect(
    (records.assessments ?? []).some((item) => item.node === NODE),
    "评估记录应包含本节",
  ).toBe(true);
});
