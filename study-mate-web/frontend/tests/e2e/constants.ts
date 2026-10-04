import fs from "node:fs";
import path from "node:path";

/** 后端 FIXTURE_STREAM_SEGMENTS 的**原始分段**（markdown 源文本，含 ** 标记）。
 *  misconception「记入概念本」的 answer_summary 预填按原文拼接近似，用这一份。 */
export const STREAM_SEGMENTS = [
  "这是固定测试回复的第一段：先把要讲的概念立起来。",
  "第二段：用一个具体例子把要点串起来。",
  "第三段：轮到你动手练习，试着自己复述一遍。",
  "第四段：本次回复到此结束，欢迎继续提问。\n\n**下一步**：回复「继续」就进入下一节。",
] as const;

/** H② 开场流尾段的「下一步」呈现锚点：加粗语法渲染后 DOM 里只剩纯文本 */
export const STREAM_NEXT_STEP_ANCHOR = "下一步：回复「继续」就进入下一节。";

/** **渲染后可见**的分段文本：前三段与原始分段逐字一致，末段拆成正文与「下一步」两节 */
export const STREAM_VISIBLE_SEGMENTS = [
  "这是固定测试回复的第一段：先把要讲的概念立起来。",
  "第二段：用一个具体例子把要点串起来。",
  "第三段：轮到你动手练习，试着自己复述一遍。",
  "第四段：本次回复到此结束，欢迎继续提问。",
  STREAM_NEXT_STEP_ANCHOR,
] as const;

/** 等一段流式回复结束用：最后一段的可见文本（helpers.sendChatMessage 的收尾判据） */
export const STREAM_LAST_SEGMENT = STREAM_VISIBLE_SEGMENTS[STREAM_VISIBLE_SEGMENTS.length - 1];

export const BACKEND_URL = "http://127.0.0.1:8290";
const STUDY_MATE_WEB_DIR = path.resolve(__dirname, "../../..");
export const BACKEND_DIR = path.join(STUDY_MATE_WEB_DIR, "backend");
// 运行产物在 <study-mate-web>/data/，与 config.py 的 WEB_ROOT/DATA_DIR 和 playwright.config 一致
export const E2E_WORKSPACE_DIR = path.join(STUDY_MATE_WEB_DIR, "data", "e2e-ws");
export const E2E_DATA_DIR = path.join(STUDY_MATE_WEB_DIR, "data", "e2e-data");

/** 工作区发现用的配置文件（后端 env STUDYMATE_CONFIG 指向它）：
 *  PUT /api/workspace 只写这里，不碰开发者真实的 ~/.dsh/studymate-config.yaml。 */
export const E2E_CONFIG_FILE = "studymate-config.yaml";
export const E2E_CONFIG_PATH = path.join(E2E_DATA_DIR, E2E_CONFIG_FILE);

/** 跨科目共享记忆（I 阶段写侧的目标文件） */
export const memoryFilePath = () => path.join(E2E_WORKSPACE_DIR, ".learning", "MEMORY.md");

/** 把 e2e 工作区路径写进 E2E_CONFIG_PATH（格式与后端 workspace.set_configured_workspace
 *  一致：无引号纯标量，反斜杠不做 YAML 转义）。
 *  Playwright 的 webServer 早于 globalSetup 启动，配置文件必须在后端进程起来前就在位，
 *  否则工作区发现会读不到配置并回落到真实 ~/StudyMate（且进程内缓存整个测试轮次）。 */
export function ensureWorkspaceConfig(): void {
  fs.mkdirSync(E2E_DATA_DIR, { recursive: true });
  fs.writeFileSync(E2E_CONFIG_PATH, `workspace: ${E2E_WORKSPACE_DIR}\n`, "utf-8");
}

export const subjectDir = (slug: string) =>
  path.join(E2E_WORKSPACE_DIR, ".learning", "subjects", slug);
