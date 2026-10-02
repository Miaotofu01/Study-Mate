"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  Check,
  ClipboardCheck,
  ExternalLink,
  FileText,
  Loader2,
  MessageSquare,
  Save,
  Sparkles,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import { VerdictBadge } from "./VerdictBadge";
import type {
  AssessResponse,
  AssessmentRecord,
  GraphNode,
  LabStatus,
  LessonInfo,
  NodeKind,
  NodeStatus,
} from "@/lib/types";

const KIND_STYLE: Record<NodeKind, string> = {
  概念: "#14b8a6",
  实操: "#3b82f6",
  实验: "#f59e0b",
};

const STATUS_COLOR: Record<NodeStatus, string> = {
  未开始: "#9aa5a1",
  学习中: "#3b82f6",
  初步理解: "#14b8a6",
  能独立应用: "#22c55e",
  需要复习: "#f59e0b",
  已通过项目验证: "#1c5a40",
};

const LAB_STATUSES: LabStatus[] = ["待生成", "待提交", "待评估", "已通过"];

const lessonsCache = new Map<string, LessonInfo[]>();

interface NodeDetailProps {
  slug: string;
  node: GraphNode;
  onSelectNode: (id: string) => void;
  onUpdated: (node: GraphNode) => void;
}

export function NodeDetail({ slug, node, onSelectNode, onUpdated }: NodeDetailProps) {
  const router = useRouter();
  const { sessions, setActiveSubject } = useWorkspace();

  const [mastery, setMastery] = useState(node.mastery);
  const [notes, setNotes] = useState(node.notes);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hasLesson, setHasLesson] = useState(false);

  const [assessOpen, setAssessOpen] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [extraContext, setExtraContext] = useState("");
  const [assessing, setAssessing] = useState(false);
  const [assessResult, setAssessResult] = useState<AssessResponse | null>(null);
  const [assessError, setAssessError] = useState<string | null>(null);
  const [records, setRecords] = useState<AssessmentRecord[] | null>(null);

  useEffect(() => {
    setMastery(node.mastery);
    setNotes(node.notes);
    setSaving(false);
    setSaved(false);
    setError(null);
    setAssessOpen(false);
    setAssessResult(null);
    setAssessError(null);
    setExtraContext("");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在切换节点时重置；保存后的值由 save() 自己同步，避免抹掉"已保存"反馈
  }, [node.id]);

  // 课件列表缓存判断当前节点是否有课件
  useEffect(() => {
    let alive = true;
    const cached = lessonsCache.get(slug);
    if (cached) {
      setHasLesson(cached.some((l) => l.node_id === node.id));
      return;
    }
    api
      .listLessons(slug)
      .then((res) => {
        lessonsCache.set(slug, res.lessons);
        if (alive) setHasLesson(res.lessons.some((l) => l.node_id === node.id));
      })
      .catch(() => {
        if (alive) setHasLesson(false);
      });
    return () => {
      alive = false;
    };
  }, [slug, node.id]);

  const save = async (payload: {
    status?: NodeStatus;
    mastery?: number;
    notes?: string;
    lab_status?: LabStatus;
  }) => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.updateNodeProgress(slug, node.id, payload);
      onUpdated(res.node);
      setMastery(res.node.mastery);
      setNotes(res.node.notes);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const askStudyMate = () => {
    setActiveSubject(slug, node.id);
    router.push("/chat");
  };

  const openLesson = () => {
    router.push(`/lesson?subject=${encodeURIComponent(slug)}&node=${encodeURIComponent(node.id)}`);
  };

  const subjectSessions = sessions
    .filter((s) => s.subject_slug === slug)
    .sort((a, b) => b.updated_at - a.updated_at);

  const toggleAssess = () => {
    const next = !assessOpen;
    setAssessOpen(next);
    if (next) {
      setAssessResult(null);
      setAssessError(null);
      setSelectedSessionId(subjectSessions[0]?.id ?? "");
      setRecords(null);
      api
        .listRecords(slug)
        .then((res) => setRecords(res.assessments.filter((a) => a.node === node.id)))
        .catch(() => setRecords([]));
    }
  };

  const submitAssess = async () => {
    if (!selectedSessionId) return;
    setAssessing(true);
    setAssessError(null);
    try {
      const trimmed = extraContext.trim();
      const res = await api.assessNode(slug, node.id, {
        session_id: selectedSessionId,
        extra_context: trimmed ? trimmed : undefined,
      });
      setAssessResult(res);
      if (res.node) onUpdated(res.node);
    } catch (err) {
      setAssessError(err instanceof Error ? err.message : String(err));
    } finally {
      setAssessing(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs opacity-50">#{node.index}</span>
          <span
            className="rounded px-1.5 py-0.5 text-[11px] text-white"
            style={{ background: KIND_STYLE[node.kind] ?? "#6b7280" }}
          >
            {node.kind}
          </span>
          <span
            data-testid="node-status-badge"
            className="rounded px-1.5 py-0.5 text-[11px] text-white"
            style={{ background: STATUS_COLOR[node.status] ?? "#6b7280" }}
          >
            {node.status}
          </span>
        </div>
        <h2 className="mb-4 text-lg font-semibold leading-snug">{node.title}</h2>

        {hasLesson && (
          <button
            onClick={openLesson}
            className="mb-4 flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm text-white transition-colors hover:bg-brand-light"
          >
            <BookOpen className="h-4 w-4" />
            打开课件
          </button>
        )}

        <Section label="目标">
          <p className="text-sm leading-relaxed">{node.objective || "—"}</p>
        </Section>

        <Section label="要解决的问题">
          <p className="text-sm leading-relaxed">{node.problem || "—"}</p>
        </Section>

        {node.prerequisites.length > 0 && (
          <Section label="前置节点">
            <div className="flex flex-wrap gap-1.5">
              {node.prerequisites.map((p) => (
                <button
                  key={p}
                  onClick={() => onSelectNode(p)}
                  className="rounded-full border px-2 py-0.5 text-xs hover:bg-[var(--muted)]"
                  style={{ borderColor: "var(--border)" }}
                >
                  {p}
                </button>
              ))}
            </div>
          </Section>
        )}

        {node.concepts.length > 0 && (
          <Section label="核心概念">
            <div className="flex flex-wrap gap-1.5">
              {node.concepts.map((c) => (
                <span
                  key={c}
                  className="rounded-full px-2 py-0.5 text-xs"
                  style={{ background: "var(--muted)" }}
                >
                  {c}
                </span>
              ))}
            </div>
          </Section>
        )}

        {node.resources.length > 0 && (
          <Section label="学习资源">
            <ul className="flex flex-col gap-1.5">
              {node.resources.map((r, i) => (
                <li key={i} className="flex items-start gap-1.5 text-sm">
                  {r.type && (
                    <span
                      className="mt-0.5 shrink-0 rounded px-1 text-[10px]"
                      style={{ background: "var(--muted)" }}
                    >
                      {r.type}
                    </span>
                  )}
                  {r.url ? (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-brand-light hover:underline"
                    >
                      {r.title}
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    <span>{r.title}</span>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {node.practice && (
          <Section label="练习">
            <p className="text-sm leading-relaxed">{node.practice}</p>
          </Section>
        )}

        {node.pitfalls.length > 0 && (
          <Section label="易错点">
            <ul className="list-disc pl-5 text-sm leading-relaxed">
              {node.pitfalls.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </Section>
        )}

        {node.realworld && (
          <Section label="真实世界">
            <p className="text-sm leading-relaxed">{node.realworld}</p>
          </Section>
        )}

        {/* 进度编辑 */}
        <div
          className="mt-5 flex flex-col gap-3 rounded-xl border p-3"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="text-sm font-medium">进度</div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs opacity-60">变更状态</span>
            <div className="flex flex-wrap gap-1.5" data-testid="node-next-statuses">
              {node.next_statuses.length === 0 && (
                <span className="text-xs opacity-40">当前状态无可变更项</span>
              )}
              {node.next_statuses.map((s) => (
                <button
                  key={s}
                  onClick={() => void save({ status: s })}
                  disabled={saving}
                  className="rounded-full border px-2 py-0.5 text-xs hover:bg-[var(--muted)] disabled:opacity-50"
                  style={{ borderColor: "var(--border)" }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs opacity-60">
              掌握度 {Math.round(mastery * 100)}%
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={mastery}
              onChange={(e) => setMastery(Number(e.target.value))}
              className="w-full accent-brand"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs opacity-60">笔记</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="记录你的理解、卡点…"
              className="w-full resize-none rounded-lg border bg-transparent px-2 py-1.5 text-sm outline-none"
              style={{ borderColor: "var(--border)" }}
            />
          </label>

          {error && <p className="text-xs text-red-500">{error}</p>}

          <button
            onClick={() => void save({ mastery, notes })}
            disabled={saving}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-light disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : saved ? (
              <Check className="h-4 w-4" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saved ? "已保存" : "保存进度"}
          </button>
        </div>

        {/* 实验状态（仅实验节点） */}
        {node.kind === "实验" && (
          <div
            className="mt-4 flex flex-col gap-2 rounded-xl border p-3"
            style={{ borderColor: "var(--border)" }}
          >
            <div className="text-sm font-medium">实验状态</div>
            <div className="text-xs opacity-60">当前：{node.lab_status ?? "未设置"}</div>
            <div className="flex flex-wrap gap-1.5">
              {LAB_STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => void save({ lab_status: s })}
                  disabled={saving}
                  className={clsx(
                    "rounded-full border px-2 py-0.5 text-xs hover:bg-[var(--muted)] disabled:opacity-50",
                    node.lab_status === s && "border-brand bg-brand/10 text-brand",
                  )}
                  style={node.lab_status === s ? undefined : { borderColor: "var(--border)" }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 申请评估 */}
        <div
          className="mt-4 flex flex-col gap-3 rounded-xl border p-3"
          style={{ borderColor: "var(--border)" }}
        >
          <button
            onClick={toggleAssess}
            className="flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm hover:bg-[var(--muted)]"
            style={{ borderColor: "var(--border)" }}
          >
            <ClipboardCheck className="h-4 w-4" />
            {assessOpen ? "收起评估" : "申请评估"}
          </button>

          {assessOpen && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs opacity-60">评估会话</span>
                {subjectSessions.length === 0 ? (
                  <span className="text-xs opacity-40">
                    没有关联「{slug}」的会话，先在聊天里关联本科目并对话
                  </span>
                ) : (
                  <select
                    value={selectedSessionId}
                    onChange={(e) => setSelectedSessionId(e.target.value)}
                    className="w-full truncate rounded-lg border bg-transparent px-2 py-1.5 text-sm outline-none"
                    style={{ borderColor: "var(--border)" }}
                  >
                    {subjectSessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title || "未命名会话"}（{s.message_count} 条）
                      </option>
                    ))}
                  </select>
                )}
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs opacity-60">补充说明（可选）</span>
                <textarea
                  value={extraContext}
                  onChange={(e) => setExtraContext(e.target.value)}
                  rows={2}
                  placeholder="例如：重点评估我对 XX 的理解，实验卡在了 YY"
                  className="w-full resize-none rounded-lg border bg-transparent px-2 py-1.5 text-sm outline-none"
                  style={{ borderColor: "var(--border)" }}
                />
              </label>

              <button
                onClick={() => void submitAssess()}
                disabled={!selectedSessionId || assessing}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-light disabled:opacity-50"
              >
                {assessing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {assessing ? "评估中…" : "提交评估"}
              </button>

              {assessError && <p className="break-all text-xs text-red-500">{assessError}</p>}

              {assessResult && (
                <div data-testid="assess-result">
                  <AssessResultPanel result={assessResult} />
                </div>
              )}

              {records !== null && (
                <div className="flex flex-col gap-1">
                  <div className="text-xs font-medium opacity-60">历史评估</div>
                  {records.length === 0 ? (
                    <span className="text-xs opacity-40">本节点暂无评估记录</span>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {records.map((r) => (
                        <li
                          key={r.file}
                          className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-xs"
                          style={{ background: "var(--muted)" }}
                        >
                          <FileText className="h-3 w-3 shrink-0 opacity-50" />
                          <span className="shrink-0 opacity-70">{r.date}</span>
                          <VerdictBadge verdict={r.verdict} />
                          <span className="min-w-0 flex-1 truncate break-all opacity-60" title={r.file}>
                            {r.file}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="border-t px-4 py-3" style={{ borderColor: "var(--border)" }}>
        <button
          onClick={askStudyMate}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm hover:bg-[var(--muted)]"
          style={{ borderColor: "var(--border)" }}
        >
          <MessageSquare className="h-4 w-4" />
          问 StudyMate
        </button>
      </div>
    </div>
  );
}

function AssessResultPanel({ result }: { result: AssessResponse }) {
  const { assessment } = result;
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-2.5" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-center gap-2">
        <VerdictBadge verdict={assessment.verdict} />
        {assessment.mastery != null && (
          <span className="text-xs opacity-70">掌握度 {Math.round(assessment.mastery * 100)}%</span>
        )}
      </div>

      {assessment.next && (
        <div className="text-xs">
          <span className="font-medium opacity-60">下一步：</span>
          <span className="opacity-80">{assessment.next}</span>
        </div>
      )}

      <div className="text-xs">
        <span className={result.progress_updated ? "text-green-600 dark:text-green-400" : "opacity-60"}>
          {result.progress_updated
            ? `进度已更新至 ${result.node?.status ?? assessment.verdict}`
            : "状态未变（当前状态不可流转）"}
        </span>
      </div>

      {assessment.questions.length > 0 && (
        <div className="flex flex-col gap-1">
          {assessment.questions.map((q, i) => (
            <details key={i} className="rounded-lg px-2 py-1" style={{ background: "var(--muted)" }}>
              <summary className="cursor-pointer text-xs leading-relaxed">
                <VerdictBadge verdict={q.verdict} />
                <span className="ml-1.5">{q.q}</span>
              </summary>
              <div className="mt-1.5 flex flex-col gap-1 pl-1">
                {q.answer && (
                  <p className="whitespace-pre-wrap text-xs opacity-80">答：{q.answer}</p>
                )}
                {q.note && <p className="whitespace-pre-wrap text-xs opacity-70">评语：{q.note}</p>}
              </div>
            </details>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 break-all text-[11px] opacity-60">
        <FileText className="h-3 w-3 shrink-0" />
        {result.record_file}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3.5">
      <div className="mb-1 text-xs font-medium opacity-50">{label}</div>
      {children}
    </div>
  );
}
