// 探索 agent 主循环（草案）：目标驱动的模拟用户。
// 定位：发现层，不是门禁——不写 expect，产物是 runs/<goalId>/<时间戳>/report.md。
// 运行：EXPLORER_GOAL=tests/explorer/goals/g1-xxx.md npm run explore

import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { chat, llmConfig } from "./llm";
import { Recorder, type EngineSignals, type RunStatus, type WallRecord } from "./recorder";

interface Goal {
  id: string;
  title: string;
  startUrl: string;
  maxSteps: number;
  maxWalls: number;
  text: string;
}

interface AgentAction {
  type: "click" | "fill" | "select" | "press" | "goto" | "wait" | "back" | "done" | "wall";
  target?: { role?: string; name?: string; label?: string; text?: string };
  value?: string;
  key?: string;
  url?: string;
  ms?: number;
  outcome?: "canonical" | "detour";
  summary?: string;
  detours?: string[];
  reason?: string;
  evidence?: string;
}

function parseGoal(file: string): Goal {
  const raw = fs.readFileSync(file, "utf-8");
  const field = (key: string, fallback: string): string => {
    const match = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(raw);
    return match ? match[1].trim() : fallback;
  };
  const bodyStart = raw.indexOf("---", raw.indexOf("---") + 3);
  return {
    id: field("id", path.basename(file, ".md")),
    title: field("title", path.basename(file, ".md")),
    startUrl: field("start_url", "/chat"),
    maxSteps: Number(field("max_steps", "25")),
    maxWalls: Number(field("max_walls", "3")),
    text: bodyStart >= 0 ? raw.slice(bodyStart + 3).trim() : raw.trim(),
  };
}

/** 从 LLM 回复中抠出第一个 JSON 对象（容忍 ```json 代码块包裹） */
function parseAction(raw: string): AgentAction | null {
  const cleaned = raw.replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { action?: AgentAction };
    return parsed.action ?? null;
  } catch {
    return null;
  }
}

function resolveLocator(page: Page, target: AgentAction["target"]): Locator | null {
  if (!target) return null;
  if (target.role && target.name) return page.getByRole(target.role as never, { name: target.name });
  if (target.label) return page.getByLabel(target.label);
  if (target.text) return page.getByText(target.text);
  return null;
}

async function pageState(page: Page): Promise<string> {
  return page.evaluate(() => `${location.href}|${document.body.innerText.length}`);
}

function buildObservation(
  goal: Goal,
  step: number,
  url: string,
  snapshot: string,
  engine: EngineSignals,
  log: string[],
): string {
  const engineBlock =
    engine.consoleErrors.length + engine.apiErrors.length + engine.requestFailures.length > 0
      ? `引擎信号（上一步之后）：\n${JSON.stringify(engine, null, 2)}`
      : "引擎信号：无";
  const history = log.length > 0 ? `最近动作与结果：\n${log.slice(-8).join("\n")}` : "（尚无动作历史）";
  const clipped = snapshot.length > 8000
    ? `${snapshot.slice(0, 8000)}…[快照截断，共 ${snapshot.length} 字符]`
    : snapshot;
  return [
    `# 目标（第 ${step}/${goal.maxSteps} 步，墙壁预算 ${goal.maxWalls}）`,
    goal.text,
    "",
    `# 当前 URL`,
    url,
    "",
    `# ${engineBlock}`,
    "",
    `# ${history}`,
    "",
    "# 当前页面可访问性快照",
    clipped,
    "",
    "请按策略输出下一步动作（一行 JSON）。",
  ].join("\n");
}

test("explorer（草案）：目标驱动的模拟用户", async ({ page }) => {
  test.setTimeout(30 * 60 * 1000);
  const goalFile = process.env.EXPLORER_GOAL;
  test.skip(!goalFile, "未指定 EXPLORER_GOAL，例如 EXPLORER_GOAL=tests/explorer/goals/g1-xxx.md");
  const goal = parseGoal(path.resolve(goalFile!));
  const recorder = new Recorder(goal.id);
  recorder.attachPage(page);

  const policy = fs.readFileSync(path.join(__dirname, "policy.md"), "utf-8");
  const cfg = llmConfig();
  const startedAt = new Date().toISOString();

  await page.goto(goal.startUrl);

  // 世界预检：fixture 种子工作区的两个标志——侧边栏种子科目 + fixture 的 DeepSeek 模型标签。
  // 不符立刻失败：曾因 3810 前端端口被复用，浏览器经别人的前端代理到其开发后端，
  // 静默探索了整轮错误世界。这里是硬断言，不是 agent 的 wall。
  await expect(page.getByRole("button", { name: /计算机网络/ }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTitle("切换当前使用的提供商 / 模型")).toContainText("DeepSeek", {
    timeout: 20_000,
  });

  const log: string[] = [];
  const walls: WallRecord[] = [];
  let status: RunStatus = "budget_exhausted";
  let summary = "步数预算耗尽，目标未完成";
  let detours: string[] = [];
  let step = 0;

  for (step = 1; step <= goal.maxSteps; step++) {
    const engine = recorder.takeEngine();
    const stateBefore = await pageState(page);
    const snapshot = await page.locator("body").ariaSnapshot();
    const observation = buildObservation(goal, step, page.url(), snapshot, engine, log);

    let raw: string;
    try {
      raw = await chat(cfg, [
        { role: "system", content: policy },
        { role: "user", content: observation },
      ]);
    } catch (err) {
      status = "blocked";
      summary = `LLM 调用失败：${err instanceof Error ? err.message : String(err)}`;
      break;
    }

    const action = parseAction(raw);
    if (!action) {
      const result = "无法解析 LLM 输出为动作 JSON（已要求重试）";
      log.push(`第 ${step} 步：解析失败`);
      await recorder.recordStep({ step, observation, rawReply: raw, action: null, result, engine, screenshot: await page.screenshot().catch(() => null) });
      continue;
    }

    let result: string;
    if (action.type === "done") {
      status = action.outcome ?? "canonical";
      summary = action.summary ?? "";
      detours = action.detours ?? [];
      result = "agent 声明目标完成";
    } else if (action.type === "wall") {
      result = `agent 报告墙壁：${action.reason ?? ""}`;
      const wall: WallRecord = {
        step,
        reason: action.reason ?? "(未说明)",
        evidence: action.evidence ?? "",
        url: page.url(),
        snapshotExcerpt: snapshot.slice(0, 1500),
        engine,
      };
      walls.push(wall);
      recorder.recordWall(wall); // 即时落盘，绕开也不丢
      if (walls.length > goal.maxWalls) {
        status = "blocked";
        summary = `墙壁超预算（${walls.length} > ${goal.maxWalls}），退出`;
        await recorder.recordStep({ step, observation, rawReply: raw, action, result, engine, screenshot: await page.screenshot().catch(() => null) });
        break;
      }
    } else {
      result = await runAction(page, action, stateBefore);
    }

    log.push(`第 ${step} 步：${action.type} → ${result}`);
    const screenshot = await page.screenshot().catch(() => null);
    await recorder.recordStep({ step, observation, rawReply: raw, action, result, engine, screenshot });

    if (action.type === "done") break;
  }

  const reportPath = recorder.report({
    goalId: goal.id,
    goalTitle: goal.title,
    goalText: goal.text,
    model: cfg.model,
    status,
    summary,
    detours,
    walls,
    steps: step,
    startedAt,
  });
  // 探索结果不是门禁：不 expect，证据与墙壁报告在 runDir/report.md
  console.log(`[explorer] 运行目录：${recorder.runDir}`);
  console.log(`[explorer] 报告：${reportPath}`);
});

async function runAction(page: Page, action: AgentAction, stateBefore: string): Promise<string> {
  try {
    switch (action.type) {
      case "goto":
        await page.goto(action.url ?? "/");
        return `已打开 ${action.url}`;
      case "wait":
        await page.waitForTimeout(action.ms ?? 500);
        return `等待 ${action.ms ?? 500}ms`;
      case "back":
        await page.goBack();
        return "已后退";
      case "press":
        await page.keyboard.press(action.key ?? "Enter");
        return `已按键 ${action.key ?? "Enter"}`;
      default:
        break;
    }
    const locator = resolveLocator(page, action.target);
    if (!locator) return "定位失败：target 需要 role+name / label / text 之一";
    const count = await locator.count();
    if (count === 0) return "定位失败：页面上没有匹配控件，换描述重试";
    if (count > 1) return `定位歧义：匹配到 ${count} 个控件，请用更精确的 role/name`;
    const target = locator.first();
    if (action.type === "click") {
      await target.click({ timeout: 5000 });
    } else if (action.type === "fill") {
      await target.fill(String(action.value ?? ""), { timeout: 5000 });
    } else if (action.type === "select") {
      await target.selectOption(String(action.value ?? ""), { timeout: 5000 });
    } else {
      return `未知动作类型 ${action.type}`;
    }
    await page.waitForTimeout(600);
    return (await pageState(page)) === stateBefore
      ? "已执行，但页面无变化（URL 与正文长度均未变）——可能是墙，也可能需要等待"
      : "已执行，页面有变化";
  } catch (err) {
    return `动作执行失败：${err instanceof Error ? err.message : String(err)}（mechanics 层允许重试）`;
  }
}
