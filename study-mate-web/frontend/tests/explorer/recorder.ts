// 轨迹记录器：steps.jsonl（逐步观测/动作/结果）+ 逐步截图 + walls.jsonl（首次撞墙即记）
// + report.md（给人分级的墙壁报告）。只写 runs/<goalId>/<时间戳>/，不碰被测应用数据。

import fs from "node:fs";
import path from "node:path";
import type { ConsoleMessage, Page, Request, Response } from "@playwright/test";

export interface EngineSignals {
  consoleErrors: string[];
  apiErrors: string[];
  requestFailures: string[];
}

export interface WallRecord {
  step: number;
  reason: string;
  evidence: string;
  url: string;
  snapshotExcerpt: string;
  engine: EngineSignals;
}

export type RunStatus = "canonical" | "detour" | "blocked" | "budget_exhausted";

function excerpt(text: string, max = 1500): string {
  return text.length > max ? `${text.slice(0, max)}…[截断，共 ${text.length} 字符]` : text;
}

export class Recorder {
  readonly runDir: string;
  private readonly stepsPath: string;
  private readonly wallsPath: string;
  private engine: EngineSignals = { consoleErrors: [], apiErrors: [], requestFailures: [] };

  constructor(goalId: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.runDir = path.join(__dirname, "runs", goalId, stamp);
    fs.mkdirSync(this.runDir, { recursive: true });
    this.stepsPath = path.join(this.runDir, "steps.jsonl");
    this.wallsPath = path.join(this.runDir, "walls.jsonl");
  }

  /** 引擎信号按步累计：本步观察时取走并清空，避免同一错误重复灌入每一轮 */
  attachPage(page: Page): void {
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error") this.engine.consoleErrors.push(excerpt(msg.text(), 300));
    });
    page.on("pageerror", (err) => {
      this.engine.consoleErrors.push(`pageerror: ${err.message}`.slice(0, 300));
    });
    page.on("requestfailed", (req: Request) => {
      this.engine.requestFailures.push(
        `${req.method()} ${req.url()} ${req.failure()?.errorText ?? ""}`.slice(0, 300),
      );
    });
    page.on("response", (res: Response) => {
      if (res.status() >= 400 && res.url().includes("/api/")) {
        this.engine.apiErrors.push(`${res.status()} ${res.url()}`.slice(0, 300));
      }
    });
  }

  takeEngine(): EngineSignals {
    const taken = {
      consoleErrors: [...this.engine.consoleErrors],
      apiErrors: [...this.engine.apiErrors],
      requestFailures: [...this.engine.requestFailures],
    };
    this.engine = { consoleErrors: [], apiErrors: [], requestFailures: [] };
    return taken;
  }

  async recordStep(input: {
    step: number;
    observation: string;
    rawReply: string;
    action: unknown;
    result: string;
    engine: EngineSignals;
    screenshot: Buffer | null;
  }): Promise<void> {
    const line = JSON.stringify({
      step: input.step,
      at: new Date().toISOString(),
      observation: input.observation,
      rawReply: input.rawReply,
      action: input.action,
      result: input.result,
      engine: input.engine,
    });
    fs.appendFileSync(this.stepsPath, `${line}\n`);
    if (input.screenshot) {
      fs.writeFileSync(
        path.join(this.runDir, `step-${String(input.step).padStart(3, "0")}.png`),
        input.screenshot,
      );
    }
  }

  /** 首次撞墙即时落盘：即使 agent 随后绕开，墙的证据也不丢 */
  recordWall(wall: WallRecord): void {
    fs.appendFileSync(this.wallsPath, `${JSON.stringify({ ...wall, at: new Date().toISOString() })}\n`);
  }

  report(input: {
    goalId: string;
    goalTitle: string;
    goalText: string;
    model: string;
    status: RunStatus;
    summary: string;
    detours: string[];
    walls: WallRecord[];
    steps: number;
    startedAt: string;
  }): string {
    const endedAt = new Date().toISOString();
    const lines = [
      `# 探索运行报告：${input.goalId}`,
      "",
      `- 目标：${input.goalTitle}`,
      `- 模型：${input.model}`,
      `- 结果：**${input.status}**（canonical=正路完成 / detour=借道完成 / blocked=受阻 / budget_exhausted=预算耗尽）`,
      `- 步数：${input.steps}`,
      `- 时间：${input.startedAt} → ${endedAt}`,
      `- 摘要：${input.summary}`,
      "",
      "## 目标原文",
      input.goalText,
      "",
      "## 借道记录",
      input.detours.length > 0 ? input.detours.map((d) => `- ${d}`).join("\n") : "- 无",
      "",
      "## 墙壁清单（待分级：功能缺陷 / 设计死路 / agent 失误 / 环境问题）",
      input.walls.length > 0
        ? input.walls
            .map(
              (w) =>
                `### 第 ${w.step} 步 — ${w.reason}\n\n- 页面：${w.url}\n- 证据：${w.evidence}\n- 快照摘录：${excerpt(w.snapshotExcerpt, 400)}\n- 引擎信号：${JSON.stringify(w.engine)}`,
            )
            .join("\n\n")
        : "- 本运行未记录墙壁",
      "",
      "## 证据文件",
      `- 逐步轨迹：steps.jsonl（含每步截图 step-NNN.png）`,
    ];
    const reportPath = path.join(this.runDir, "report.md");
    fs.writeFileSync(reportPath, `${lines.join("\n")}\n`);
    return reportPath;
  }
}
