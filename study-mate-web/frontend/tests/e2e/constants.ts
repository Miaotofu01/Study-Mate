import path from "node:path";

export const STREAM_SEGMENTS = [
  "这是固定测试回复的第一段：先把要讲的概念立起来。",
  "第二段：用一个具体例子把要点串起来。",
  "第三段：轮到你动手练习，试着自己复述一遍。",
  "第四段：本次回复到此结束，欢迎继续提问。",
] as const;

export const STREAM_LAST_SEGMENT = STREAM_SEGMENTS[STREAM_SEGMENTS.length - 1];

export const BACKEND_URL = "http://127.0.0.1:8290";
const STUDY_MATE_WEB_DIR = path.resolve(__dirname, "../../..");
export const BACKEND_DIR = path.join(STUDY_MATE_WEB_DIR, "backend");
// 运行产物在 <study-mate-web>/data/，与 config.py 的 WEB_ROOT/DATA_DIR 和 playwright.config 一致
export const E2E_WORKSPACE_DIR = path.join(STUDY_MATE_WEB_DIR, "data", "e2e-ws");
export const E2E_DATA_DIR = path.join(STUDY_MATE_WEB_DIR, "data", "e2e-data");

export const subjectDir = (slug: string) =>
  path.join(E2E_WORKSPACE_DIR, "subjects", slug);
