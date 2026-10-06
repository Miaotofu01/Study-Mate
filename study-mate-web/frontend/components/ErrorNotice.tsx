"use client";

import { useId, useState } from "react";
import { AlertCircle, Copy } from "lucide-react";
import clsx from "clsx";
import { normalizeError } from "@/lib/api";
import type { ErrorInfo } from "@/lib/types";

export function ErrorNotice({ error, text, className }: {
  error?: ErrorInfo | null;
  text?: string;
  className?: string;
}) {
  const info = normalizeError(error ?? text ?? "回复异常结束");
  const id = useId();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  if (!info) return null;
  const neutral = info.code === "user_stopped" || info.stopped_reason === "user_stop";
  const diagnostic = [
    info.summary,
    info.status ? `HTTP ${info.status}` : "",
    `错误码：${info.code}`,
    info.upstream_code ? `上游错误码：${info.upstream_code}` : "",
    `阶段：${info.phase}`,
    info.request_id ? `轮次：${info.request_id}` : "",
    info.detail,
  ].filter(Boolean).join("\n");
  return (
    <div role="alert" data-testid="error-notice" data-error-code={info.code}
      data-error-phase={info.phase} data-error-tone={neutral ? "neutral" : "danger"}
      className={clsx("my-3 rounded-xl border px-4 py-3 text-sm", className,
        neutral ? "border-amber-400/50 bg-amber-500/10 text-amber-800 dark:text-amber-300"
          : "border-red-400/50 bg-red-500/10 text-red-700 dark:text-red-300")}>
      <div className="flex items-start gap-2">
        <AlertCircle aria-hidden="true" data-testid="error-notice-icon" className="mt-0.5 h-4 w-4 shrink-0" />
        <span data-testid="error-notice-summary" className="min-w-0 flex-1 break-words">{info.summary}</span>
        {info.status && <span data-testid="error-notice-badge" className="shrink-0 font-mono">{info.status}</span>}
      </div>
      <div className="mt-2 flex gap-3 text-xs">
        <button type="button" data-testid="error-notice-toggle" aria-expanded={open} aria-controls={id}
          onClick={() => setOpen(!open)} className="underline underline-offset-2">{open ? "收起详情" : "查看详情"}</button>
        <button type="button" data-testid="error-notice-copy" aria-label="复制诊断信息" className="flex items-center gap-1"
          onClick={() => { void navigator.clipboard.writeText(diagnostic).then(() => {
            setCopied(true); setCopyError(false);
          }).catch(() => setCopyError(true)); }}>
          <Copy aria-hidden="true" className="h-3 w-3" />复制诊断信息
        </button>
        {copied && <span data-testid="error-notice-copied">已复制</span>}
        {copyError && <span>复制失败，请展开详情后手动复制。</span>}
      </div>
      {open && <pre id={id} data-testid="error-notice-detail" className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{diagnostic}</pre>}
    </div>
  );
}
