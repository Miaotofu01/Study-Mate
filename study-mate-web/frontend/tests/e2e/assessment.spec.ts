import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { BACKEND_URL, E2E_DATA_DIR, subjectDir } from "./constants";
import { associateSubject, openNodeDetail, sendChatMessage } from "./helpers";

const MESSAGE = "请用一道题检查我对封装的理解";

// 评估用例会写 progress.yaml（置位）与 assessments/learning-records（落盘），
// 结束时恢复快照，避免字母序在后的用例（progress-transition 等）读到被置位的初始状态。
function snapshotSubjectState(slug: string) {
  const base = subjectDir(slug);
  const progressPath = path.join(base, "progress.yaml");
  const progress = fs.readFileSync(progressPath, "utf-8");
  const misconceptionsPath = path.join(base, "misconceptions.yaml");
  const misconceptions = fs.existsSync(misconceptionsPath)
    ? fs.readFileSync(misconceptionsPath, "utf-8")
    : null;
  const recorded = ["assessments", "learning-records"].map((name) => {
    const dir = path.join(base, name);
    return { dir, before: fs.existsSync(dir) ? fs.readdirSync(dir) : [] };
  });
  return {
    restore() {
      fs.writeFileSync(progressPath, progress);
      // assess 会经双落点写 misconceptions.yaml（canonical 源优先于 progress），一并还原
      if (misconceptions === null) {
        fs.rmSync(misconceptionsPath, { force: true });
      } else {
        fs.writeFileSync(misconceptionsPath, misconceptions);
      }
      for (const { dir, before } of recorded) {
        if (fs.existsSync(dir)) {
          for (const name of fs.readdirSync(dir)) {
            if (!before.includes(name)) fs.unlinkSync(path.join(dir, name));
          }
        }
      }
    },
  };
}

test("request an assessment and the state machine promotes the node", async ({
  page,
  request,
}) => {
  const snapshot = snapshotSubjectState("computer-networks");
  try {
    await page.goto("/chat");
    await expect(page.getByRole("heading")).not.toHaveText("你好");
    await associateSubject(page, "computer-networks");
    await sendChatMessage(page, MESSAGE);

    await openNodeDetail(page, "computer-networks", "1. 分层模型与封装");
    const detail = page.getByTestId("course-node-detail");
    const badge = detail.getByTestId("node-status-badge");

    // seed 里 net.layers 已是「能独立应用」；按状态机走到「初步理解」，评估通过才能推进到「能独立应用」
    await detail.getByTestId("node-next-statuses").getByRole("button", { name: "需要复习" }).click();
    await expect(badge).toHaveText("需要复习");
    await detail.getByTestId("node-next-statuses").getByRole("button", { name: "学习中" }).click();
    await expect(badge).toHaveText("学习中");
    await detail.getByTestId("node-next-statuses").getByRole("button", { name: "初步理解" }).click();
    await expect(badge).toHaveText("初步理解");

    // 会话列表就绪后再展开评估面板，避免选中会话为空
    await expect(page.locator("aside").getByText(MESSAGE)).toBeVisible();
    await detail.getByRole("button", { name: "申请评估" }).click();
    const sessionSelect = detail.getByRole("combobox", { name: "评估会话" });
    await expect(sessionSelect).toBeVisible();
    await expect(sessionSelect).toContainText(MESSAGE);

    await detail.getByRole("button", { name: "提交评估" }).click();
    const result = detail.getByTestId("assess-result");
    await expect(result.getByText("通过", { exact: true })).toBeVisible();
    await expect(result.getByText("掌握度 40%")).toBeVisible();
    await expect(result.getByText("复习首部与载荷的区别后重新评估本节")).toBeVisible();
    await expect(result.getByText("进度已更新至 能独立应用")).toBeVisible();
    await expect(result.getByText("assessments/001-net.layers.md")).toBeVisible();
    await expect(badge).toHaveText("能独立应用");

    const assessmentsDir = path.join(subjectDir("computer-networks"), "assessments");
    const records = fs.readdirSync(assessmentsDir).filter((name) => name.endsWith(".md"));
    expect(records).toEqual(["001-net.layers.md"]);
    const record = fs.readFileSync(path.join(assessmentsDir, records[0]), "utf-8");
    expect(record).toContain("verdict: 通过");

    const progress = fs.readFileSync(
      path.join(subjectDir("computer-networks"), "progress.yaml"),
      "utf-8",
    );
    expect(progress).toMatch(/net\.layers:[\s\S]*?status: 能独立应用/);
    expect(progress).toMatch(/net\.layers:[\s\S]*?mastery: 0\.4/);

    const metasRes = await request.get(`${BACKEND_URL}/api/sessions`);
    const metas = (await metasRes.json()) as Array<{ id: string; title: string }>;
    const meta = metas.find((m) => m.title === MESSAGE);
    expect(meta).toBeDefined();
    expect(fs.existsSync(path.join(E2E_DATA_DIR, "uploads", meta!.id))).toBe(false);
  } finally {
    snapshot.restore();
  }
});

// H③：verdict=通过改为权威置位——实验课节点与 prerequisites 一起置「已通过项目验证」，
// 并写 learning-records/<seq>-<node_id>.md；响应带 promoted 与 learning_record。
const EXPERIMENT_MESSAGE = "抓完一次完整 TCP 会话后的自评";
const PREREQUISITE_IDS = ["net.layers", "net.link", "net.ip", "net.tcp"];

test("assessing the experiment node promotes it with its prerequisites", async ({ page }) => {
  const snapshot = snapshotSubjectState("computer-networks");
  try {
    type Promoted = { id: string; title: string; status: string };
    let assessResponse: { promoted?: Promoted[]; learning_record?: string } | null = null;
    // 捕获 UI 这条链路上的真实响应体：promoted / learning_record 只在响应里，前端不渲染
    await page.route(
      "**/api/courses/computer-networks/nodes/net.experiment/assess",
      async (route) => {
        const response = await route.fetch();
        assessResponse = (await response.json()) as { promoted?: Promoted[] };
        await route.fulfill({ response });
      },
    );

    await page.goto("/chat");
    await expect(page.getByRole("heading")).not.toHaveText("你好");
    await associateSubject(page, "computer-networks");
    await sendChatMessage(page, EXPERIMENT_MESSAGE);

    await openNodeDetail(page, "computer-networks", "5. 实验：TCP 回显客户端与抓包");
    const detail = page.getByTestId("course-node-detail");
    await expect(detail.getByTestId("node-status-badge")).toHaveText("未开始");
    await detail.getByRole("button", { name: "申请评估" }).click();
    const sessionSelect = detail.getByRole("combobox", { name: "评估会话" });
    await expect(sessionSelect).toBeVisible();
    await expect(sessionSelect).toContainText(EXPERIMENT_MESSAGE);

    await detail.getByRole("button", { name: "提交评估" }).click();
    const result = detail.getByTestId("assess-result");
    await expect(result.getByText("通过", { exact: true })).toBeVisible();
    await expect(result.getByText("进度已更新至 已通过项目验证")).toBeVisible();
    await expect(detail.getByTestId("node-status-badge")).toHaveText("已通过项目验证");

    expect(assessResponse, "应捕获到评估响应").not.toBeNull();
    const promoted = assessResponse!.promoted ?? [];
    expect(promoted.map((item) => item.id)).toEqual(["net.experiment", ...PREREQUISITE_IDS]);
    for (const item of promoted) {
      expect(item.status).toBe("已通过项目验证");
    }
    // 学习记录编号从 001 起：上一条用例结束时已把它落下的 assessments/learning-records 恢复删除
    expect(assessResponse!.learning_record).toBe("learning-records/001-net.experiment.md");

    const learningRecordsDir = path.join(subjectDir("computer-networks"), "learning-records");
    expect(fs.readdirSync(learningRecordsDir)).toEqual(["001-net.experiment.md"]);
    const record = fs.readFileSync(
      path.join(learningRecordsDir, "001-net.experiment.md"),
      "utf-8",
    );
    expect(record).toContain("LR-001 实验通过：实验：TCP 回显客户端与抓包");
    expect(record).toContain("依据：`assessments/001-net.experiment.md`");
    expect(record).toContain("verdict=通过");

    const progress = fs.readFileSync(
      path.join(subjectDir("computer-networks"), "progress.yaml"),
      "utf-8",
    );
    for (const nodeId of ["net.experiment", ...PREREQUISITE_IDS]) {
      // status 未必是该节点条目的第一个键（既有条目会被保留在前）；Windows 上 YAML 落盘为 CRLF
      expect(progress).toMatch(
        new RegExp(
          `${nodeId.replace(/\./g, "\\.")}:\\r?\\n(?:\\s{4}[\\w-]+:.*\\r?\\n)*?\\s{4}status: 已通过项目验证`,
        ),
      );
    }

    // I：评估通过后结果面板给「沉淀记忆」入口（从该次评估会话提炼，fixture 2 条建议）
    const memoryEntry = detail.getByTestId("memory-entry-assess");
    await expect(memoryEntry).toBeVisible();
    await memoryEntry.click();
    await expect(page.getByTestId("memory-dialog")).toBeVisible();
  } finally {
    snapshot.restore();
  }
});
