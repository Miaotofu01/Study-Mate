"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Brain, Check, Loader2, X } from "lucide-react";
import { api } from "@/lib/api";
import { MEMORY_SECTIONS, type MemoryEntry } from "@/lib/types";

interface MemoryDialogProps {
  sessionId: string;
  onClose: () => void;
  /** 写入成功后触发（供外层给出持久反馈） */
  onWritten?: (written: number) => void;
  /** 预填的待确认条目（如小结的 memory_updates）：存在且非空时直接以其初始化，不再调 suggest */
  initialEntries?: { section: string; content: string }[];
}

interface EntryDraft {
  key: string;
  section: string;
  content: string;
  /** 复选框：默认勾选，用户逐条挑选 */
  selected: boolean;
}

function normalizeSection(section: string): string {
  return MEMORY_SECTIONS.includes(section as (typeof MEMORY_SECTIONS)[number])
    ? section
    : MEMORY_SECTIONS[0];
}

/**
 * 记忆写侧确认面板：先 suggest（LLM 提炼，可能为空），逐条勾选/改分节/改文案后 confirm 写 MEMORY.md。
 * 挂在聊天页外层（fixed 遮罩），不放进右侧栏，避免被右栏的滚动容器裁掉。
 *
 * initialEntries 存在且非空时（如小结的 memory_updates，纯字符串没有分节信息），
 * 直接用这批条目初始化（分节由 normalizeSection 兜底），跳过 suggest；为空则走 suggest 流程。
 */
export function MemoryDialog({ sessionId, onClose, onWritten, initialEntries }: MemoryDialogProps) {
  const [entries, setEntries] = useState<EntryDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<{ path: string; written: number } | null>(null);
  const [nonce, setNonce] = useState(0);

  // 预填条目只在挂载时读一次：对话框重开后由外层重新挂载（key）带回新值；
  // 期间用户的勾选/改文案不被父组件重渲染覆盖
  const initialRef = useRef(initialEntries);
  initialRef.current = initialEntries;

  useEffect(() => {
    const prefill = initialRef.current;
    if (prefill && prefill.length > 0) {
      setEntries(
        prefill.map((entry, i) => ({
          key: `entry-${i}`,
          section: normalizeSection(entry.section),
          content: entry.content,
          selected: true,
        })),
      );
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .suggestMemory(sessionId)
      .then((res) => {
        if (!alive) return;
        setEntries(
          res.entries.map((entry, i) => ({
            key: `entry-${i}`,
            section: normalizeSection(entry.section),
            content: entry.content,
            selected: true,
          })),
        );
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialEntries 只在挂载时生效（见 initialRef），sessionId/nonce 变化才重新加载
  }, [sessionId, nonce]);

  const patch = useCallback((key: string, next: Partial<EntryDraft>) => {
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, ...next } : e)));
  }, []);

  const pending: MemoryEntry[] = entries
    .filter((e) => e.selected && e.content.trim().length > 0)
    .map((e) => ({ section: e.section, content: e.content.trim() }));

  const confirm = async () => {
    if (pending.length === 0 || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.confirmMemory(pending, sessionId);
      setResult({ path: res.path, written: res.written });
      onWritten?.(res.written);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm p-4 transition-all"
      data-testid="memory-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="沉淀记忆"
        className="flex max-h-[82vh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface-card)] shadow-2xl ring-1 ring-[var(--border)]/50"
      >
        <header
          className="flex shrink-0 items-center gap-2.5 border-b border-[var(--border)] bg-[var(--surface-subtle)]/70 px-5 py-3.5"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <Brain className="h-4 w-4 shrink-0" />
          </div>
          <span className="min-w-0 flex-1 font-serif text-base font-semibold text-[var(--foreground)]">沉淀记忆</span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--foreground)]/50 transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-4 text-xs text-[var(--foreground)]/60 leading-relaxed">
            从本会话提炼值得长期记住的内容：只记跨科目、跨会话仍成立的偏好与习惯。
            逐条勾选后可改分节与文案，确认后写入 MEMORY.md。
          </p>

          {loading && (
            <div className="flex flex-col items-center gap-2 py-10 text-sm opacity-60">
              <Loader2 className="h-5 w-5 animate-spin opacity-50" />
              正在提炼…
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-2 rounded-xl border border-red-300/50 bg-red-500/10 px-3 py-2.5 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 break-all">{error}</span>
              </div>
              <button
                onClick={() => setNonce((v) => v + 1)}
                className="self-start rounded-lg border px-3 py-1.5 text-xs hover:bg-[var(--muted)]"
                style={{ borderColor: "var(--border)" }}
              >
                重试
              </button>
            </div>
          )}

          {!loading && !error && entries.length === 0 && (
            <p data-testid="memory-empty" className="py-8 text-center text-sm opacity-60">
              本次会话没有值得沉淀的建议
            </p>
          )}

          {!loading && !error && entries.length > 0 && (
            <div className="flex flex-col gap-3">
              {entries.map((entry) => (
                <div
                  key={entry.key}
                  className="flex gap-2.5 rounded-xl border p-3"
                  style={{ borderColor: "var(--border)" }}
                >
                  <input
                    type="checkbox"
                    checked={entry.selected}
                    onChange={(e) => patch(entry.key, { selected: e.target.checked })}
                    aria-label="写入这条记忆"
                    className="mt-1 h-3.5 w-3.5 shrink-0"
                    style={{ accentColor: "rgb(var(--brand-rgb))" }}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <select
                      value={entry.section}
                      onChange={(e) => patch(entry.key, { section: e.target.value })}
                      aria-label="记忆分节"
                      className="w-full truncate rounded-lg border bg-transparent px-2 py-1 text-xs outline-none"
                      style={{ borderColor: "var(--border)" }}
                    >
                      {MEMORY_SECTIONS.map((section) => (
                        <option key={section} value={section}>
                          {section}
                        </option>
                      ))}
                    </select>
                    <textarea
                      value={entry.content}
                      onChange={(e) => patch(entry.key, { content: e.target.value })}
                      rows={3}
                      aria-label="记忆内容"
                      className="w-full resize-y rounded-lg border bg-transparent px-2 py-1.5 text-sm leading-relaxed outline-none"
                      style={{ borderColor: "var(--border)" }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {result && (
            <div
              data-testid="memory-result"
              className="mt-4 flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs"
              style={{ background: "rgb(var(--brand-rgb) / 0.08)" }}
            >
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
              <span className="min-w-0 flex-1 break-all">
                已写入 {result.written} 条记忆到 {result.path}
              </span>
            </div>
          )}

          {saveError && (
            <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-300/50 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-all">{saveError}</span>
            </div>
          )}
        </div>

        <footer
          className="flex shrink-0 items-center gap-2 border-t px-5 py-3.5"
          style={{ borderColor: "var(--border)" }}
        >
          <button
            onClick={() => void confirm()}
            disabled={pending.length === 0 || saving || loading || Boolean(result)}
            data-testid="memory-confirm"
            className="flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition-opacity hover:bg-brand-light disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
            写入记忆{pending.length > 0 ? `（${pending.length}）` : ""}
          </button>
          <button
            onClick={onClose}
            className="rounded-xl border px-3.5 py-2 text-sm opacity-70 transition-colors hover:bg-[var(--muted)] hover:opacity-100"
            style={{ borderColor: "var(--border)" }}
          >
            {result ? "完成" : "取消"}
          </button>
          {pending.length === 0 && !loading && !error && entries.length > 0 && (
            <span className="text-xs opacity-50">
              {entries.some((e) => e.selected) ? "勾选条目的内容不能为空" : "至少勾选一条"}
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}
