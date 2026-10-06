"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { AlertCircle, Loader2, Maximize2, Minimize2, Send, X } from "lucide-react";
import { api } from "@/lib/api";
import { VerdictBadge } from "./VerdictBadge";
import type { GradeResult, QuizItem } from "@/lib/types";

interface GradingPanelProps {
  slug: string;
  nodeId: string;
  /** 会话级工作区（null = 默认）：题目读取与判分都落到它 */
  workspace: string | null;
  onClose: () => void;
}

export function GradingPanel({ slug, nodeId, workspace, onClose }: GradingPanelProps) {
  const [items, setItems] = useState<QuizItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wide, setWide] = useState(false);

  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [results, setResults] = useState<Record<number, GradeResult>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});

  useEffect(() => {
    let alive = true;
    api
      .getQuiz(slug, nodeId, workspace)
      .then((res) => {
        if (alive) setItems(res.items);
      })
      .catch((err) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [slug, nodeId, workspace]);

  const submitGrade = async (idx: number, item: QuizItem) => {
    const answer = (answers[idx] ?? "").trim();
    if (!answer || busy[idx]) return;
    setBusy((prev) => ({ ...prev, [idx]: true }));
    setErrors((prev) => ({ ...prev, [idx]: "" }));
    try {
      const res = await api.gradeAnswer(
        slug,
        nodeId,
        {
          question: item.q,
          criteria: item.criteria ?? "",
          answer,
          reference_answer: item.answer,
        },
        workspace,
      );
      setResults((prev) => ({ ...prev, [idx]: res }));
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [idx]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusy((prev) => ({ ...prev, [idx]: false }));
    }
  };

  return (
    <aside
      className={clsx(
        "flex h-full shrink-0 flex-col border-l bg-[var(--surface-subtle)]",
        // 宽度不超过视口的 85%/95%：窄屏下判分面板不会把 iframe 挤成 0 宽或撑宽壳层
        wide ? "w-[min(36rem,95vw)]" : "w-[min(24rem,85vw)]",
      )}
      style={{ borderColor: "var(--border)" }}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-card)] px-4 py-2.5 shadow-xs"
      >
        <span className="min-w-0 flex-1 truncate font-serif text-sm font-semibold text-[var(--foreground)]">
          判分与练习面板
        </span>
        <button
          onClick={() => setWide((v) => !v)}
          className="rounded-lg p-1.5 text-[var(--foreground)]/60 transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          title={wide ? "收窄" : "加宽"}
        >
          {wide ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-[var(--foreground)]/60 transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          title="关闭"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 题号快速定位导轨（Chips） */}
      {items && items.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--border)]/60 bg-[var(--surface-subtle)] px-4 py-2">
          <span className="text-[11px] font-medium text-[var(--foreground)]/45">题目:</span>
          {items.map((_, i) => (
            <a
              key={i}
              href={`#quiz-item-${i}`}
              className={clsx(
                "flex h-6 min-w-6 items-center justify-center rounded-lg px-1.5 text-[11px] font-medium transition-all shadow-xs",
                results[i]
                  ? "bg-brand text-white"
                  : answers[i]?.trim()
                    ? "bg-brand/20 text-brand border border-brand/30"
                    : "border border-[var(--border)] bg-[var(--surface-card)] text-[var(--foreground)]/70 hover:bg-[var(--muted)]",
              )}
            >
              Q{i + 1}
            </a>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loadError && (
          <div className="flex items-start gap-2 rounded-xl border border-red-300/50 bg-red-500/10 px-3 py-2.5 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{loadError}</span>
          </div>
        )}

        {!loadError && items === null && (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-brand" />
          </div>
        )}

        {!loadError && items !== null && items.length === 0 && (
          <p className="py-10 text-center text-sm text-[var(--foreground)]/50">该节点暂无题目</p>
        )}

        <div className="flex flex-col gap-4">
          {items?.map((item, idx) => {
            const isChoice = Array.isArray(item.opts) && item.opts.length > 0;
            return (
              <div
                key={idx}
                id={`quiz-item-${idx}`}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4 shadow-xs transition-all"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="rounded-md bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
                    第 {idx + 1} 题 · {isChoice ? "选择题" : "开放思考题"}
                  </span>
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-[var(--foreground)]">
                  {item.q}
                </pre>

                {isChoice ? (
                  <>
                    <div className="mt-3 flex flex-col gap-1.5">
                      {item.opts!.map((opt, oi) => (
                        <div
                          key={oi}
                          className={clsx(
                            "rounded-lg px-3 py-1.5 text-xs transition-colors",
                            oi === item.ans
                              ? "bg-green-500/10 text-green-700 dark:text-green-300 font-medium"
                              : "bg-[var(--surface-subtle)] text-[var(--foreground)]/80",
                          )}
                        >
                          <span className="font-semibold">{String.fromCharCode(65 + oi)}.</span> {opt}
                          {oi === item.ans && <span className="ml-2 font-medium">✓ 正确答案</span>}
                        </div>
                      ))}
                    </div>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <span className="rounded-md bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">
                        页内判分
                      </span>
                      {item.why && <span className="text-[11px] text-[var(--foreground)]/60">✓ {item.why}</span>}
                    </div>
                  </>
                ) : (
                  <>
                    {item.criteria && (
                      <div className="mt-3">
                        <div className="mb-1 text-[11px] font-medium text-[var(--foreground)]/50">判分要点与证据标准</div>
                        <pre
                          className="whitespace-pre-wrap break-words rounded-lg border border-[var(--border)]/50 bg-[var(--surface-subtle)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--foreground)]/80"
                        >
                          {item.criteria}
                        </pre>
                      </div>
                    )}
                    <textarea
                      value={answers[idx] ?? ""}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [idx]: e.target.value }))}
                      rows={4}
                      placeholder="在此作答，然后提交判分…"
                      className="mt-3 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] p-2.5 text-xs text-[var(--foreground)] outline-none focus:border-brand"
                    />
                    <div className="mt-2 flex items-center justify-between">
                      <button
                        onClick={() => void submitGrade(idx, item)}
                        disabled={busy[idx] || !(answers[idx] ?? "").trim()}
                        className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white shadow-xs transition-colors hover:bg-brand-light disabled:opacity-40"
                      >
                        {busy[idx] ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Send className="h-3 w-3" />
                        )}
                        提交判分
                      </button>
                    </div>
                    {errors[idx] && (
                      <p className="mt-2 break-all text-xs text-red-500">{errors[idx]}</p>
                    )}
                    {results[idx] && (
                      <div
                        className="mt-3 flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] p-3 shadow-xs"
                      >
                        <VerdictBadge verdict={results[idx].verdict} />
                        {results[idx].evidence.length > 0 && (
                          <div>
                            <div className="mb-1 text-[11px] font-medium text-[var(--foreground)]/50">证据引用</div>
                            <ul className="list-disc pl-4 text-xs text-[var(--foreground)]/80">
                              {results[idx].evidence.map((e, i) => (
                                <li key={i} className="whitespace-pre-wrap break-words">
                                  {e}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {results[idx].missing.length > 0 && (
                          <div>
                            <div className="mb-1 text-[11px] font-medium text-[var(--foreground)]/50">缺口与建议</div>
                            <ul className="list-disc pl-4 text-xs text-[var(--foreground)]/80">
                              {results[idx].missing.map((m, i) => (
                                <li key={i} className="whitespace-pre-wrap break-words text-amber-600 dark:text-amber-400">
                                  {m}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {results[idx].comment && (
                          <p className="whitespace-pre-wrap break-words text-xs text-[var(--foreground)]/80 leading-relaxed">
                            {results[idx].comment}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
