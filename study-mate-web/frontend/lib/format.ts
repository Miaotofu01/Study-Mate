import type { MessagePart } from "./types";

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

/** 相对某份合并正文的隐藏区间 [start, end)。 */
interface HiddenSpan {
  start: number;
  end: number;
}

/** 与 cleanAssistantText 同口径：完整标记块 + 首个未被完整块覆盖的半截标记起至末尾。 */
function hiddenSpansOf(merged: string): HiddenSpan[] {
  const spans: HiddenSpan[] = [];
  const blocks = new RegExp(INTERVIEW_BLOCK.source, "g");
  for (const match of merged.matchAll(blocks)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length });
  }
  const covered = (pos: number) => spans.some((span) => pos >= span.start && pos < span.end);
  for (let pos = 0; pos + INTERVIEW_START.length <= merged.length; pos += 1) {
    if (!covered(pos) && merged.startsWith(INTERVIEW_START, pos)) {
      spans.push({ start: pos, end: merged.length });
      break;
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** 取 span 内未被任何隐藏区间覆盖的部分（完整块被剔除，多段顺次拼接）。 */
function keepOutside(merged: string, span: HiddenSpan, hidden: HiddenSpan[]): string {
  let out = "";
  let cursor = span.start;
  for (const hole of hidden) {
    if (hole.end <= cursor || hole.start >= span.end) continue;
    if (hole.start > cursor) out += merged.slice(cursor, hole.start);
    cursor = Math.max(cursor, hole.end);
  }
  if (cursor < span.end) out += merged.slice(cursor, span.end);
  return out;
}

/**
 * 保序片段清洗：把全部 text 片段拼成一份正文求收口标记隐藏区间，再按各片段在原正文里的
 * 跨度回填——跨 tool / reasoning / notice 边界的标记与 JSON 一并隐藏，非 text 片段原位不动。
 * text 片段一律按 cleanAssistantText 口径裁剪首尾（与旧的逐片段清洗一致），清洗后为空的丢弃。
 */
export function cleanAssistantParts(parts: MessagePart[]): MessagePart[] {
  let merged = "";
  const spans = new Map<number, HiddenSpan>();
  parts.forEach((part, index) => {
    if (part.type !== "text") return;
    spans.set(index, { start: merged.length, end: merged.length + part.text.length });
    merged += part.text;
  });
  const hidden = hiddenSpansOf(merged);
  const result: MessagePart[] = [];
  parts.forEach((part, index) => {
    if (part.type !== "text") {
      result.push(part);
      return;
    }
    const span = spans.get(index)!;
    const text = keepOutside(merged, span, hidden).trim();
    if (text) result.push({ ...part, text });
  });
  return result;
}
