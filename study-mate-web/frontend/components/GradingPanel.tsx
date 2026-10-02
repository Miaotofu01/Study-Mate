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
  onClose: () => void;
}

export function GradingPanel({ slug, nodeId, onClose }: GradingPanelProps) {
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
      .getQuiz(slug, nodeId)
      .then((res) => {
        if (alive) setItems(res.items);
      })
      .catch((err) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [slug, nodeId]);

  const submitGrade = async (idx: number, item: QuizItem) => {
    const answer = (answers[idx] ?? "").trim();
    if (!answer || busy[idx]) return;
    setBusy((prev) => ({ ...prev, [idx]: true }));
    setErrors((prev) => ({ ...prev, [idx]: "" }));
    try {
      const res = await api.gradeAnswer(slug, nodeId, {
        question: item.q,
        criteria: item.criteria ?? "",
        answer,
        reference_answer: item.answer,
      });
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
        "flex h-full shrink-0 flex-col border-l",
        wide ? "w-[36rem]" : "w-[22rem]",
      )}
      style={{ borderColor: "var(--border)" }}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border)" }}
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium">判分面板</span>
        <button
          onClick={() => setWide((v) => !v)}
          className="rounded p-1 opacity-60 hover:bg-[var(--muted)] hover:opacity-100"
          title={wide ? "收窄" : "加宽"}
        >
          {wide ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={onClose}
          className="rounded p-1 opacity-60 hover:bg-[var(--muted)] hover:opacity-100"
          title="关闭"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {loadError && (
          <div className="flex items-start gap-2 rounded-xl border border-red-300/50 bg-red-500/10 px-3 py-2.5 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{loadError}</span>
          </div>
        )}

        {!loadError && items === null && (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin opacity-50" />
          </div>
        )}

        {!loadError && items !== null && items.length === 0 && (
          <p className="py-10 text-center text-sm opacity-50">该节点暂无题目</p>
        )}

        <div className="flex flex-col gap-3">
          {items?.map((item, idx) => {
            const isChoice = Array.isArray(item.opts) && item.opts.length > 0;
            return (
              <div
                key={idx}
                className="rounded-xl border p-3"
                style={{ borderColor: "var(--border)" }}
              >
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                  {item.q}
                </pre>

                {isChoice ? (
                  <>
                    <div className="mt-2 flex flex-col gap-1">
                      {item.opts!.map((opt, oi) => (
                        <div
                          key={oi}
                          className={clsx(
                            "rounded-lg px-2 py-1 text-xs",
                            oi === item.ans
                              ? "bg-green-500/10 text-green-600 dark:text-green-400"
                              : "bg-[var(--muted)] opacity-70",
                          )}
                        >
                          {String.fromCharCode(65 + oi)}. {opt}
                          {oi === item.ans && <span className="ml-1.5">✓ 正确答案</span>}
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand">
                        页内判分
                      </span>
                      {item.why && <span className="text-[11px] opacity-60">✓ {item.why}</span>}
                    </div>
                  </>
                ) : (
                  <>
                    {item.criteria && (
                      <div className="mt-2">
                        <div className="mb-0.5 text-[11px] font-medium opacity-50">判分要点</div>
                        <pre
                          className="whitespace-pre-wrap break-words rounded-lg px-2 py-1.5 font-mono text-[11px] leading-relaxed opacity-80"
                          style={{ background: "var(--muted)" }}
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
                      className="mt-2 w-full resize-y rounded-lg border bg-transparent px-2 py-1.5 text-sm outline-none"
                      style={{ borderColor: "var(--border)" }}
                    />
                    <button
                      onClick={() => void submitGrade(idx, item)}
                      disabled={busy[idx] || !(answers[idx] ?? "").trim()}
                      className="mt-2 flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1 text-xs text-white hover:bg-brand-light disabled:opacity-40"
                    >
                      {busy[idx] ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Send className="h-3 w-3" />
                      )}
                      提交判分
                    </button>
                    {errors[idx] && (
                      <p className="mt-2 break-all text-xs text-red-500">{errors[idx]}</p>
                    )}
                    {results[idx] && (
                      <div
                        className="mt-3 flex flex-col gap-2 rounded-lg border p-2.5"
                        style={{ borderColor: "var(--border)" }}
                      >
                        <VerdictBadge verdict={results[idx].verdict} />
                        {results[idx].evidence.length > 0 && (
                          <div>
                            <div className="mb-0.5 text-[11px] font-medium opacity-50">证据引用</div>
                            <ul className="list-disc pl-4">
                              {results[idx].evidence.map((e, i) => (
                                <li key={i} className="whitespace-pre-wrap break-words opacity-80">
                                  {e}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {results[idx].missing.length > 0 && (
                          <div>
                            <div className="mb-0.5 text-[11px] font-medium opacity-50">缺口</div>
                            <ul className="list-disc pl-4">
                              {results[idx].missing.map((m, i) => (
                                <li key={i} className="whitespace-pre-wrap break-words opacity-80">
                                  {m}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {results[idx].comment && (
                          <p className="whitespace-pre-wrap break-words opacity-80">
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
