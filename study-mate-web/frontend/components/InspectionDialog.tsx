"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardEdit,
  Loader2,
  RefreshCw,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import clsx from "clsx";
import { api, recheckTicket, retryTicket } from "@/lib/api";
import type { InspectionTicket, TicketDetail } from "@/lib/types";

/**
 * 质检工单两段式模态（§5.1 C 行拍板④）：
 * 第一段 = 总览（报错按归属分组 + 全部重试/逐项处理/放弃）；
 * 第二段 = 逐项处理（产物快改/仅重试此项，处理完自动重跑渲染+检查）。
 * 不做 Web 内编辑器：大改走 base_dir 下的绝对路径 + 外部编辑 + 重新检查。
 */
export function InspectionDialog({
  ticketId,
  sessionId,
  onClose,
  onResolved,
}: {
  ticketId: string;
  sessionId?: string | null;
  onClose: () => void;
  onResolved?: () => void;
}) {
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<"overview" | "item">("overview");
  const [activePath, setActivePath] = useState<string | null>(null);
  const [activeContent, setActiveContent] = useState("");
  // 内容真实读到才允许保存：占位文本（尚未生成/读取失败）不可写回产物
  const [contentLoaded, setContentLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const detail = await api.getTicket(ticketId);
      setTicket(detail);
      if (detail.status === "已解决" || detail.status === "已放弃") {
        onResolved?.();
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [ticketId, onResolved]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openItem = useCallback(
    async (path: string) => {
      setStep("item");
      setActivePath(path);
      setActiveContent("");
      setContentLoaded(false);
      if (!ticket) return;
      // 读取根与保存根一致（审查 P0-2）：draft 工单读草稿目录，工作区工单读科目目录
      const url =
        ticket.base_label === "draft"
          ? api.draftFileUrl(ticket.slug, path)
          : api.courseFileUrl(ticket.slug, path);
      try {
        const res = await fetch(url);
        if (res.ok) {
          setActiveContent(await res.text());
          setContentLoaded(true);
        } else {
          setStreamError(`产物读取失败（${res.status}）：可用外部编辑器改 ${ticket.base_dir} 下的文件后点「重新检查」`);
        }
      } catch (err) {
        setStreamError(`产物读取失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [ticket],
  );

  const runStream = useCallback(
    async (run: (handlers: Parameters<typeof retryTicket>[1]) => Promise<void>) => {
      setBusy(true);
      setStreamError(null);
      try {
        await run({
          onSession: () => undefined,
          onStage: () => undefined,
          onRetry: () => undefined,
          onHandoff: () => undefined,
          onDone: () => undefined,
          onError: (message) => setStreamError(message),
        });
      } catch (err) {
        setStreamError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        await reload();
      }
    },
    [reload],
  );

  const owners = ticket ? Object.keys(ticket.groups) : [];
  const closed = ticket?.status === "已解决" || ticket?.status === "已放弃";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm p-4 transition-all"
      data-testid="inspection-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface-card)] shadow-2xl ring-1 ring-[var(--border)]/50"
      >
        {/* 工单头 */}
        <div
          className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-subtle)]/70 px-5 py-3.5"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
              <span data-testid="inspection-title">
                {ticket?.kind === "build" ? "建课大纲未过门禁" : "单课产出未过质检"}
                {ticket?.node_id ? ` · ${ticket.node_id}` : ""}
              </span>
            </div>
            {ticket && (
              <div className="mt-0.5 truncate text-xs text-[var(--foreground)]/60">
                工单 {ticket.id} · {ticket.slug}（{ticket.base_label === "draft" ? "草稿区" : "工作区"}）
                · 已重试 {ticket.retries} 次 · {ticket.status}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-[var(--foreground)]/50 transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 内容区 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loadError && <div className="text-sm text-red-500">{loadError}</div>}
          {!ticket && !loadError && (
            <div className="flex items-center gap-2 py-8 text-sm opacity-60">
              <Loader2 className="h-4 w-4 animate-spin" /> 读取工单…
            </div>
          )}

          {ticket && step === "overview" && (
            <div className="flex flex-col gap-4" data-testid="inspection-overview">
              {owners.map((owner) => (
                <div key={owner}>
                  <div className="mb-1.5 text-xs font-semibold opacity-70">归属：{owner}</div>
                  <ul
                    className="flex flex-col gap-1 rounded-xl border p-3 text-xs"
                    style={{ borderColor: "var(--border)" }}
                  >
                    {ticket.groups[owner].map((problem, i) => (
                      <li key={i} className="break-all leading-relaxed">
                        <span className="opacity-50">
                          {problem.path}
                          {problem.line ? `:${problem.line}` : ""}
                        </span>{" "}
                        {problem.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {owners.length === 0 && (
                <div className="text-sm opacity-60">报错清单为空（可能已被处理），点「重新检查」确认。</div>
              )}
              {/* 逐项处理：以产物文件为单元（快改 textarea / 仅重试此项） */}
              {ticket.artifacts.length > 0 && (
                <div>
                  <div className="mb-1.5 text-xs font-semibold opacity-70">产物（点开可快改/仅重试）</div>
                  <div className="flex flex-col gap-1">
                    {ticket.artifacts.map((path) => (
                      <button
                        key={path}
                        data-testid="inspection-artifact"
                        onClick={() => void openItem(path)}
                        className="break-all rounded-lg border px-3 py-1.5 text-left font-mono text-xs hover:bg-[var(--muted)]"
                        style={{ borderColor: "var(--border)" }}
                      >
                        {path}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {ticket.base_dir && (
                <div className="text-xs opacity-60">
                  产物目录：<span className="break-all font-mono">{ticket.base_dir}</span>
                  （外部编辑器改完回来点「重新检查」）
                </div>
              )}
            </div>
          )}

          {ticket && step === "item" && activePath && (
            <div className="flex flex-col gap-3" data-testid="inspection-item">
              <div className="flex items-center justify-between gap-2">
                <button
                  onClick={() => setStep("overview")}
                  className="text-xs text-brand-light hover:underline"
                >
                  ← 返回总览
                </button>
                <span className="break-all font-mono text-xs opacity-60">{activePath}</span>
              </div>
              <textarea
                data-testid="inspection-editor"
                value={activeContent}
                onChange={(e) => setActiveContent(e.target.value)}
                spellCheck={false}
                className="min-h-[240px] w-full resize-y rounded-xl border p-3 font-mono text-xs leading-relaxed outline-none focus:border-brand"
                style={{ borderColor: "var(--border)" }}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  data-testid="inspection-save"
                  disabled={busy || !contentLoaded}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.quickEditTicketArtifact(ticket.id, activePath, activeContent);
                      setStreamError(null);
                    } catch (err) {
                      setStreamError(`保存失败：${err instanceof Error ? err.message : String(err)}`);
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-light disabled:opacity-50"
                >
                  <ClipboardEdit className="h-3.5 w-3.5" /> 保存快改
                </button>
                <button
                  data-testid="inspection-retry-item"
                  disabled={busy}
                  onClick={() =>
                    void runStream((handlers) =>
                      retryTicket(ticket.id, handlers, { hint, sessionId }),
                    )
                  }
                  className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs hover:bg-[var(--muted)] disabled:opacity-50"
                  style={{ borderColor: "var(--border)" }}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> 仅重试此项
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 底部操作（第一段常驻） */}
        {ticket && step === "overview" && !closed && (
          <div
            className="flex shrink-0 flex-wrap items-center gap-2 border-t px-5 py-3"
            style={{ borderColor: "var(--border)" }}
          >
            <input
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="补充说明（可选，随重试交给角色）"
              className="min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-xs outline-none focus:border-brand"
              style={{ borderColor: "var(--border)" }}
            />
            <button
              data-testid="inspection-retry-all"
              disabled={busy}
              onClick={() => void runStream((handlers) => retryTicket(ticket.id, handlers, { hint, sessionId }))}
              className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-light disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              全部重试
            </button>
            <button
              data-testid="inspection-recheck"
              disabled={busy}
              onClick={() => void runStream((handlers) => recheckTicket(ticket.id, handlers, sessionId))}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs hover:bg-[var(--muted)] disabled:opacity-50"
              style={{ borderColor: "var(--border)" }}
            >
              <Wrench className="h-3.5 w-3.5" /> 重新检查
            </button>
            <button
              data-testid="inspection-abandon"
              disabled={busy}
              onClick={async () => {
                try {
                  await api.abandonTicket(ticket.id);
                } catch (err) {
                  setStreamError(`放弃失败：${err instanceof Error ? err.message : String(err)}`);
                }
                await reload();
              }}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-50"
              style={{ borderColor: "var(--border)" }}
            >
              <XCircle className="h-3.5 w-3.5" /> 放弃本次
            </button>
          </div>
        )}

        {(streamError || closed) && (
          <div
            className={clsx(
              "flex shrink-0 items-center gap-2 border-t px-5 py-2.5 text-xs",
              streamError ? "text-amber-600" : "text-emerald-600",
            )}
            style={{ borderColor: "var(--border)" }}
            data-testid={closed ? "inspection-closed" : "inspection-stream-error"}
          >
            {closed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
            {closed ? `工单已${ticket?.status}。` : streamError}
          </div>
        )}
      </div>
    </div>
  );
}

export type { InspectionTicket };
