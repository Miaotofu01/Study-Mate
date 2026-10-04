import type { ProviderModel } from "./types";

/**
 * 模型未声明「上下文长度」时的兜底默认值（token 数）。
 *
 * 兜底语义（2026-10-04 拍板）：设置页不再把默认值预填进输入框——留空就是"没声明"，
 * 由使用侧兜底。右栏「上下文窗口」栏的分母、以及「添加模型」弹窗的占位提示都取这里。
 */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/** 某模型实际生效的上下文长度：声明值优先，否则兜底默认 */
export function contextWindowOf(model: ProviderModel | null | undefined): number {
  const declared = model?.context_window;
  if (typeof declared === "number" && declared > 0) return declared;
  return DEFAULT_CONTEXT_WINDOW;
}

/** token 数缩写：11500 → 11.5k，1000000 → 1M，2560000 → 2.6M */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : Number(millions.toFixed(1))}M`;
  }
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : Number(thousands.toFixed(1))}k`;
  }
  return String(Math.round(value));
}

/** 上下文占用百分比（0–100 的整数，向上取整避免 0.4% 显示成 0%） */
export function contextUsagePercent(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.ceil((used / total) * 100));
}
