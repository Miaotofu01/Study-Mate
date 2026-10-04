import { expect, test } from "@playwright/test";

import { BACKEND_URL } from "./constants";
import { associateSubject, expandRightRail } from "./helpers";

// 附件区（H④-前端）：关联科目后右栏出现四组文件链接；文件内容经 /api/courses/{slug}/files/ 读。
// globalSetup 只往 e2e 副本拷了 GLOSSARY.md（术语表组有数据）；reference/ 与 learning-records/
// 没有种子数据，empty 组按前端实现直接不渲染。
test("the chat right rail exposes the attachments area for the associated subject", async ({
  page,
  request,
}) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading")).not.toHaveText("你好");

  // 未关联科目时不渲染附件区
  await expect(page.getByTestId("chat-attachments-area")).toHaveCount(0);

  await associateSubject(page, "computer-networks");
  // 附件区在右栏里，而右栏在新对话态默认折叠：先展开再断言
  await expandRightRail(page);
  const area = page.getByTestId("chat-right-sidebar").getByTestId("chat-attachments-area");
  await expect(area).toBeVisible();

  // 术语表组：GLOSSARY.md 以新标签页链接呈现（globalSetup 从 examples 拷入的副本）
  await expect(area.getByText("术语表 · 1")).toBeVisible();
  const glossary = area.getByRole("link", { name: "GLOSSARY.md" });
  await expect(glossary).toBeVisible();
  await expect(glossary).toHaveAttribute(
    "href",
    "/api/courses/computer-networks/files/GLOSSARY.md",
  );
  await expect(glossary).toHaveAttribute("target", "_blank");

  // 链接指向的文件真实可读（fixture 后端上的 GET /files/）
  const res = await request.get(`${BACKEND_URL}/api/courses/computer-networks/files/GLOSSARY.md`);
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain("计算机网络");
  expect(body).toContain("## 待掌握");
  expect(body).toContain("首部与载荷");

  // 空组不渲染：reference/ 没有种子数据，「本地资料」整组缺席
  await expect(area.getByText("本地资料")).toHaveCount(0);

  // 只有 yaml 的 linear-algebra：四组全空 → 空态文案，且没有任何链接
  await associateSubject(page, "linear-algebra");
  await expect(area.getByText("该科目暂无附件文件")).toBeVisible();
  await expect(area.getByRole("link")).toHaveCount(0);

  // 切回 computer-networks：按新 slug 重新拉取，术语表链接回来
  await associateSubject(page, "computer-networks");
  await expect(area.getByRole("link", { name: "GLOSSARY.md" })).toBeVisible();
});
