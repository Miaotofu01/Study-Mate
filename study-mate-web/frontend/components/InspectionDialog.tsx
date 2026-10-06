"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardEdit,
  HelpCircle,
  Loader2,
  RefreshCw,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import clsx from "clsx";
import { api, normalizeError, recheckTicket, retryTicket } from "@/lib/api";
import type { InspectionTicket, TicketDetail } from "@/lib/types";

/**
 * 质检工单两段式模态（§5.1 C 行拍板④）：
 * 第一段 = 总览（报错按归属分组 + 全部重试/逐项处理/放弃）；
 * 第二段 = 逐项处理（产物快改/仅重试此项，处理完自动重跑渲染+检查）。
 * 不做 Web 内编辑器：大改走 base_dir 下的绝对路径 + 外部编辑 + 重新检查。
 *
 * 旧工单恢复（R10）：归属未知（workspace_ambiguous / base_dir=null）的旧单，
 * 总览顶部展示「需要确认工作区」，确认前禁止一切会改产物的操作，也不自动选择同名科目。
 */
export function InspectionDialog({
  ticketId,
  sessionId,
  workspace = null,
  onClose,
  onResolved,
  onChanged,
}: {
  ticketId: string;
  sessionId?: string | null;
  /** 会话级工作区（null = 默认）：工单读取/产物快改/重试复检都落到它 */
  workspace?: string | null;
  onClose: () => void;
  onResolved?: () => void;
  /** 归属确认 / 放弃等变更成功后回调（供入口列表刷新） */
  onChanged?: () => void;
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

  // 发现链默认工作区：会话未绑定时用它作读 scope。必须给一个显式值——
  // 空着读后端不判归属，归属模糊的旧单会被当成可写（拿默认工作区猜）。
  const [defaultWs, setDefaultWs] = useState<string | null | undefined>(undefined);
  // 确认归属候选（后端发现链给出的已知工作区）
  const [candidates, setCandidates] = useState<string[]>([]);
  // 用户选定/手输的候选工作区（空 = 尚未选择）；绝不自动预选
  const [chosenWorkspace, setChosenWorkspace] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // 供 reload 复用；加载序列号用于丢弃「切单/重复加载」后在飞的旧响应
  const ticketRef = useRef<TicketDetail | null>(null);
  const loadSeqRef = useRef(0);

  // 取默认候选工作区 + 候选清单（确认归属用）
  useEffect(() => {
    let alive = true;
    api
      .getWorkspace()
      .then((info) => {
        if (!alive) return;
        setCandidates(info.candidates);
        setDefaultWs(info.candidates[0] ?? null);
      })
      .catch(() => {
        if (alive) setDefaultWs(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const fallback = workspace ?? defaultWs;
    if (fallback === undefined) return; // 默认候选尚未解析：不空 scope 误读
    // 工单已持久归属则用它，否则显式会话工作区 / 发现链默认候选
    const readScope = ticketRef.current?.workspace ?? fallback;
    const seq = ++loadSeqRef.current;
    try {
      const detail = await api.getTicket(ticketId, readScope);
      if (seq !== loadSeqRef.current) return; // 已被更晚的加载取代
      ticketRef.current = detail;
      setTicket(detail);
      setLoadError(null);
      if (detail.status === "已解决" || detail.status === "已放弃") onResolved?.();
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [ticketId, workspace, defaultWs, onResolved]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 切单由调用方 `key={ticketId}` 重挂载处理：本地态自然归零，在飞响应随卸载失效。


  // 归属未知：缺 workspace 记录的旧非草稿单（后端统一判 ambiguous、base_dir=null）；
  // 草稿单（base_label=draft）属全局草稿区，不算未知。
  const unknown = Boolean(
    ticket &&
      ticket.base_label !== "draft" &&
      (!ticket.workspace || ticket.workspace_ambiguous || ticket.base_dir === null),
  );
  const closed = ticket?.status === "已解决" || ticket?.status === "已放弃";
  // 已确认归属的工单以其持久归属为准；未知时不给任何猜测值（写操作同时也被禁用）
  const effectiveWorkspace = unknown
    ? null
    : ticket?.workspace ?? workspace ?? defaultWs ?? null;
  // 放弃等 status-only 操作仍带当前 scope：unknown 服务端会放行，owned-other 则如实 404
  const scopedWorkspace = ticket?.workspace ?? workspace ?? defaultWs ?? null;
  const writesDisabled = busy || !ticket || unknown || closed;

  const openItem = useCallback(
    async (path: string) => {
      // 归属未确认前不读产物：路径根未知，读错工作区同样危险
      if (!ticket || unknown) return;
      setStep("item");
      setActivePath(path);
      setActiveContent("");
      setContentLoaded(false);
      // 读取根与保存根一致（审查 P0-2）：draft 工单读草稿目录，工作区工单读科目目录
      const ws = effectiveWorkspace;
      const url =
        ticket.base_label === "draft"
          ? api.draftFileUrl(ticket.slug, path)
          : api.courseFileUrl(ticket.slug, path, ws);
      try {
        const res = await fetch(url);
        if (res.ok) {
          setActiveContent(await res.text());
          setContentLoaded(true);
        } else {
          setStreamError(
            `产物读取失败（${res.status}）：可用外部编辑器改 ${ticket.base_dir ?? "该工作区"} 下的文件后点「重新检查」`,
          );
        }
      } catch (err) {
        setStreamError(`产物读取失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [ticket, unknown, effectiveWorkspace],
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
          onError: (message) => setStreamError(normalizeError(message)?.summary ?? "操作失败"),
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

  // 确认归属：用户显式选定后调用服务端持久化；成功即按其归属刷新（允许重试/复检/快改）
  const confirmOwnership = useCallback(async () => {
    const target = chosenWorkspace.trim();
    if (!ticket || !target || confirmBusy) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      const res = await api.confirmTicketWorkspace(ticket.id, target);
      const updated = res.ticket;
      // 先记持久归属供 reload 作读 scope，再按归属重取（不假设响应带 base_dir/groups）
      ticketRef.current = { ...updated, workspace: updated.workspace ?? target };
      setTicket(ticketRef.current);
      setChosenWorkspace("");
      onChanged?.();
      await reload();
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirmBusy(false);
    }
  }, [ticket, chosenWorkspace, confirmBusy, onChanged, reload]);

  // 放弃：status-only，不删文件；归属未知也能用——带当前 scope 但不拿它替未知单认领
  const abandon = useCallback(async () => {
    if (!ticket || busy) return;
    setBusy(true);
    setStreamError(null);
    try {
      await api.abandonTicket(ticket.id, scopedWorkspace ?? undefined);
      onChanged?.();
      await reload();
    } catch (err) {
      setStreamError(`放弃失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [ticket, busy, scopedWorkspace, onChanged, reload]);

  const owners = ticket ? Object.keys(ticket.groups) : [];

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
              {/* 归属未知：需用户确认工作区，确认前禁写 */}
              {unknown && (
                <div
                  data-testid="inspection-unknown"
                  className="flex flex-col gap-2 rounded-xl border border-amber-400/50 bg-amber-500/10 p-3 text-xs"
                >
                  <div className="flex items-center gap-1.5 font-semibold text-amber-700 dark:text-amber-400">
                    <HelpCircle className="h-3.5 w-3.5 shrink-0" /> 需要确认工作区
                  </div>
                  <p className="leading-relaxed opacity-80">
                    这是一张旧工单，没有记录它属于哪个工作区。系统<strong>不会自动选择</strong>同名科目，
                    以免改错别的工作区里的文件。请确认它应归属到哪个工作区后再操作。
                  </p>
                  {candidates.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <span className="opacity-60">已知工作区</span>
                      {candidates.map((path) => (
                        <label key={path} className="flex items-center gap-1.5 break-all font-mono">
                          <input
                            type="radio"
                            name={`ticket-workspace-${ticketId}`}
                            data-testid="inspection-workspace-candidate"
                            checked={chosenWorkspace === path}
                            onChange={() => setChosenWorkspace(path)}
                          />
                          {path}
                        </label>
                      ))}
                    </div>
                  )}
                  <label className="flex flex-col gap-1">
                    <span className="opacity-60">或手输工作区绝对路径</span>
                    <input
                      data-testid="inspection-workspace-manual"
                      value={candidates.includes(chosenWorkspace) ? "" : chosenWorkspace}
                      onChange={(e) => setChosenWorkspace(e.target.value)}
                      placeholder="例如 D:\\workspaces\\StudyMate"
                      className="rounded-lg border px-2 py-1 font-mono outline-none focus:border-brand"
                      style={{ borderColor: "var(--border)" }}
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      data-testid="inspection-confirm-ownership"
                      disabled={!chosenWorkspace.trim() || confirmBusy}
                      onClick={() => void confirmOwnership()}
                      className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-light disabled:opacity-50"
                    >
                      {confirmBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      )}
                      确认归属
                    </button>
                    <span className="opacity-50">确认前不能重试 / 复检 / 快改</span>
                  </div>
                  {confirmError && (
                    <div data-testid="inspection-confirm-error" className="break-all text-red-500">
                      确认失败：{confirmError}
                    </div>
                  )}
                </div>
              )}

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
              {/* 逐项处理：以产物文件为单元（快改 textarea / 仅重试此项）。归属未知时禁读禁改 */}
              {ticket.artifacts.length > 0 && (
                <div>
                  <div className="mb-1.5 text-xs font-semibold opacity-70">
                    产物（点开可快改/仅重试）
                    {unknown && <span className="ml-1 font-normal opacity-60">· 归属未确认，暂不可用</span>}
                  </div>
                  <div className="flex flex-col gap-1">
                    {ticket.artifacts.map((path) => (
                      <button
                        key={path}
                        data-testid="inspection-artifact"
                        disabled={unknown}
                        onClick={() => void openItem(path)}
                        className="break-all rounded-lg border px-3 py-1.5 text-left font-mono text-xs hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-50"
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
                  disabled={writesDisabled || !contentLoaded}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.quickEditTicketArtifact(
                        ticket.id,
                        activePath,
                        activeContent,
                        effectiveWorkspace,
                      );
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
                  disabled={writesDisabled}
                  onClick={() =>
                    void runStream((handlers) =>
                      retryTicket(ticket.id, handlers, {
                        hint,
                        sessionId,
                        workspace: effectiveWorkspace,
                      }),
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
              disabled={writesDisabled}
              onClick={() =>
                void runStream((handlers) =>
                  retryTicket(ticket.id, handlers, {
                    hint,
                    sessionId,
                    workspace: effectiveWorkspace,
                  }),
                )
              }
              className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-light disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              全部重试
            </button>
            <button
              data-testid="inspection-recheck"
              disabled={writesDisabled}
              onClick={() =>
                void runStream((handlers) =>
                  recheckTicket(ticket.id, handlers, sessionId, effectiveWorkspace),
                )
              }
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs hover:bg-[var(--muted)] disabled:opacity-50"
              style={{ borderColor: "var(--border)" }}
            >
              <Wrench className="h-3.5 w-3.5" /> 重新检查
            </button>
            {/* 放弃是 status-only、不删文件，归属未知也能用（不拿调用方 workspace 认领） */}
            <button
              data-testid="inspection-abandon"
              disabled={busy}
              onClick={() => void abandon()}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-50"
              style={{ borderColor: "var(--border)" }}
            >
              <XCircle className="h-3.5 w-3.5" /> 放弃工单
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
