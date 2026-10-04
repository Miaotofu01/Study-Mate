export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

/** 盘问收口标记（后端内部记账用的注释块）：渲染 / 复制时一并剥掉，历史消息也保持干净 */
const INTERVIEW_START = "<!--INTERVIEW_RESULT-->";
const INTERVIEW_BLOCK = /<!--INTERVIEW_RESULT-->[\s\S]*?<!--\/INTERVIEW_RESULT-->/g;

/**
 * 助手正文的展示清洗：剥掉收口标记与"半截标记"（流式期间标记可能只吐出一半），并去掉
 * 首尾空白（模型常以空行开头，气泡里会留一段莫名空格）。
 */
export function cleanAssistantText(text: string): string {
  const cleaned = text.replace(INTERVIEW_BLOCK, "");
  const opened = cleaned.indexOf(INTERVIEW_START);
  const cut = opened === -1 ? cleaned : cleaned.slice(0, opened);
  return cut.trim();
}
