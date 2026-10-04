"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  Brain,
  Check,
  ClipboardCheck,
  ExternalLink,
  FileText,
  Loader2,
  MessageSquare,
  Save,
  Sparkles,
  Wand2,
} from "lucide-react";
import clsx from "clsx";
import { api, produceNode } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import { InspectionDialog } from "./InspectionDialog";
import { MemoryDialog } from "./MemoryDialog";
import { VerdictBadge } from "./VerdictBadge";
import type {
  AssessResponse,
  AssessmentRecord,
  GraphNode,
  LabStatus,
  LessonInfo,
  MisconceptionItem,
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
  // 本次评估实际使用的会话 id：评估通过后的「沉淀记忆」入口从该会话提炼
  const [assessedSessionId, setAssessedSessionId] = useState<string | null>(null);
  // 「沉淀记忆」确认面板（评估通过后开，不预填，走 suggest）
  const [memoryOpen, setMemoryOpen] = useState(false);

  // 产课链（§5.1 C 行）：讲解→出题→渲染→检查→打回；进度内联播报，失败开工单
  const [producing, setProducing] = useState(false);
  const [produceLines, setProduceLines] = useState<string[]>([]);
  const [produceError, setProduceError] = useState<string | null>(null);
  const [produced, setProduced] = useState(false);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const [nodeTicketId, setNodeTicketId] = useState<string | null>(null);
  const nodeIdRef = useRef(node.id);
  useEffect(() => {
    nodeIdRef.current = node.id;
  }, [node.id]);

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
    setAssessedSessionId(null);
    setMemoryOpen(false);
    setProducing(false);
    setProduceLines([]);
    setProduceError(null);
    setProduced(false);
    setOpenTicketId(null);
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

  // 本节点未关闭的质检工单（角标入口）
  useEffect(() => {
    let alive = true;
    api
      .listTickets(slug, true)
      .then((tickets) => {
        if (alive) {
          const mine = tickets.find((t) => t.node_id === node.id);
          setNodeTicketId(mine?.id ?? null);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [slug, node.id]);

  const runProduce = () => {
    if (producing) return;
    const runningNodeId = node.id;
    setProducing(true);
    setProduceLines([]);
    setProduceError(null);
    setProduced(false);
    const mark = (line: string) => setProduceLines((prev) => [...prev, line]);
    void produceNode(slug, runningNodeId, {
      onSession: () => undefined,
      onStage: (payload) => {
        if (payload.status === "done") mark(`✅ ${payload.stage}完成`);
        else if (payload.status === "fail") mark(`⚠ ${payload.stage}未过`);
      },
      onRetry: (payload) =>
        mark(
            `🔁 第 ${payload.round} 轮打回（${payload.owners.join("、")}）${
                payload.reason ? `：${payload.reason}` : "，附报错原文重派"
            }`,
        ),
      onHandoff: (payload) => {
        mark("⛔ 打回两轮仍未通过，已转人工");
        setNodeTicketId(payload.ticket.id);
      },
      onDone: () => {
        if (nodeIdRef.current !== runningNodeId) return; // 在途产课的结果不写进切走后的节点视图
        setProduced(true);
        setHasLesson(true);
        lessonsCache.delete(slug); // 课件列表缓存失效：切走再切回不回退按钮标签
      },
      onError: (message) => {
        if (nodeIdRef.current !== runningNodeId) return;
        setProduceError(message);
      },
    })
      .catch((err) => {
        if (nodeIdRef.current === runningNodeId) {
          setProduceError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (nodeIdRef.current === runningNodeId) setProducing(false);
      });
  };

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
      // 记下本次评估用的会话：评估通过后的记忆入口按它提炼
      setAssessedSessionId(selectedSessionId);
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

        {/* 产课链入口（§5.1 C 行）：讲解→出题→渲染→检查，打回耗尽转人工 */}
        <div className="mb-4 flex flex-col gap-2 rounded-xl border p-3" style={{ borderColor: "var(--border)" }}>
          <button
            data-testid="produce-button"
            onClick={runProduce}
            disabled={producing}
            className="flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-[var(--muted)] disabled:opacity-50"
            style={{ borderColor: "var(--border)" }}
            title="为该节点产出课件：讲解与出题由角色子代理完成，渲染与质检由后端跑上游脚本"
          >
            {producing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            {producing ? "产课进行中…" : hasLesson ? "重新产出此课" : "产出此课"}
          </button>
          {nodeTicketId && (
            <button
              data-testid="node-ticket-entry"
              onClick={() => setOpenTicketId(nodeTicketId)}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-500/20 dark:text-amber-400"
            >
              ⚠ 有待处理的质检工单，点击查看
            </button>
          )}
          {produceLines.length > 0 && (
            <div data-testid="produce-progress" className="flex flex-col gap-1 rounded-lg px-2 py-1.5 text-xs" style={{ background: "var(--muted)" }}>
              {produceLines.map((line, i) => (
                <span key={i}>{line}</span>
              ))}
            </div>
          )}
          {produced && !producing && (
            <div data-testid="produce-done" className="flex items-center gap-1.5 text-xs text-emerald-600">
              <Check className="h-3.5 w-3.5" /> 课件已产出并通过质检，可以打开学习了。
            </div>
          )}
          {produceError && (
            <div data-testid="produce-error" className="text-xs text-amber-600">
              {produceError}
            </div>
          )}
        </div>

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

        {/* 本节点误解（概念本的节点维度入口，2026-10-04 连贯化拍板） */}
        <NodeMisconceptions slug={slug} nodeId={node.id} />

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
                <div data-testid="assess-result" className="flex flex-col gap-2">
                  <AssessResultPanel result={assessResult} />
                  {/* 评估通过：把本次评估会话里值得长期记住的内容写进 MEMORY.md */}
                  {assessResult.assessment.verdict === "通过" && assessedSessionId && (
                    <button
                      onClick={() => setMemoryOpen(true)}
                      data-testid="memory-entry-assess"
                      className="flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs hover:bg-[var(--muted)]"
                      style={{ borderColor: "var(--border)" }}
                      title="从本次评估会话提炼值得长期记住的内容，逐条确认后写入 MEMORY.md"
                    >
                      <Brain className="h-3.5 w-3.5" />
                      沉淀记忆
                    </button>
                  )}
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

      {/* 记忆写侧确认面板：fixed 遮罩，挂在节点详情根上避免被滚动容器裁切 */}
      {memoryOpen && assessedSessionId && (
        <MemoryDialog
          key={`${node.id}-${assessedSessionId}`}
          sessionId={assessedSessionId}
          onClose={() => setMemoryOpen(false)}
        />
      )}

      {/* 质检工单模态（产课失败 / 节点角标入口） */}
      {openTicketId && (
        <InspectionDialog
          ticketId={openTicketId}
          onClose={() => setOpenTicketId(null)}
          onResolved={() => setNodeTicketId(null)}
        />
      )}
    </div>
  );
}

const MISCONCEPTION_IMPORTANCE_LABEL: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

/** 本节点误解：概念本的节点维度入口（列出条目 + 带参跳转概念本管理）。 */
function NodeMisconceptions({ slug, nodeId }: { slug: string; nodeId: string }) {
  const [items, setItems] = useState<MisconceptionItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    setItems(null);
    api
      .listMisconceptions(slug, { node_id: nodeId })
      .then((res) => {
        if (alive) setItems(res.items);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [slug, nodeId]);

  return (
    <div className="mt-4 flex flex-col gap-2 rounded-xl border p-3" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">本节点误解</span>
        <a
          href={`/misconceptions?subject=${encodeURIComponent(slug)}&node=${encodeURIComponent(nodeId)}`}
          className="flex shrink-0 items-center gap-1 text-xs text-brand-light hover:underline"
          title="在概念本中查看与管理"
        >
          概念本
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      {items === null && (
        <span className="flex items-center gap-1.5 text-xs opacity-50">
          <Loader2 className="h-3 w-3 animate-spin" /> 读取中…
        </span>
      )}
      {items !== null && items.length === 0 && (
        <span className="text-xs opacity-40">本节点暂无误解记录</span>
      )}
      {items !== null && items.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-lg px-2 py-1.5 text-xs"
              style={{ background: "var(--muted)" }}
            >
              <div className="flex items-center gap-1.5">
                <span className="shrink-0 rounded px-1 text-[10px] font-medium opacity-70">
                  {MISCONCEPTION_IMPORTANCE_LABEL[item.importance] ?? item.importance}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium" title={item.topic}>
                  {item.topic}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 opacity-70">{item.misunderstanding}</p>
            </li>
          ))}
        </ul>
      )}
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
