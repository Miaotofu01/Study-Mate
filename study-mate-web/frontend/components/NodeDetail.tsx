"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  Check,
  ExternalLink,
  Loader2,
  Save,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { InspectionDialog } from "./InspectionDialog";
import type {
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

/** 课件缓存按「工作区 + 科目」分槽：同名 slug 在不同工作区不得互相污染 */
function lessonsCacheKey(slug: string, workspace: string | null): string {
  return `${workspace ?? ""}::${slug}`;
}

interface NodeDetailProps {
  slug: string;
  node: GraphNode;
  /** 会话级工作区（null = 默认）：读课件/写进度/读误解都落到它 */
  workspace: string | null;
  onSelectNode: (id: string) => void;
  onUpdated: (node: GraphNode) => void;
}

export function NodeDetail({ slug, node, workspace, onSelectNode, onUpdated }: NodeDetailProps) {
  const router = useRouter();

  const [mastery, setMastery] = useState(node.mastery);
  const [notes, setNotes] = useState(node.notes);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hasLesson, setHasLesson] = useState(false);

  // 质检工单角标入口（产课链按钮移除后，工单仍是独立的检查入口）
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const [nodeTicketId, setNodeTicketId] = useState<string | null>(null);

  // 用户是否在输入框里改过（未保存）：外部刷新节点数据时不得覆盖正在编辑的草稿
  const dirtyRef = useRef(false);
  const lastNodeIdRef = useRef(node.id);

  useEffect(() => {
    const switchedNode = lastNodeIdRef.current !== node.id;
    if (switchedNode) {
      lastNodeIdRef.current = node.id;
      dirtyRef.current = false;
      setMastery(node.mastery);
      setNotes(node.notes);
      setSaving(false);
      setSaved(false);
      setError(null);
      setOpenTicketId(null);
      return;
    }
    // 同一节点被外部更新（如聊天侧评估改进度）：没有本地未保存改动时才回填，
    // 避免抹掉用户正在编辑、还没点保存的掌握度/笔记。
    if (!dirtyRef.current) {
      setMastery(node.mastery);
      setNotes(node.notes);
    }
  }, [node.id, node.mastery, node.notes]);

  // 课件列表缓存判断当前节点是否有课件
  useEffect(() => {
    let alive = true;
    const cacheKey = lessonsCacheKey(slug, workspace);
    const cached = lessonsCache.get(cacheKey);
    if (cached) {
      setHasLesson(cached.some((l) => l.node_id === node.id));
      return;
    }
    api
      .listLessons(slug, workspace)
      .then((res) => {
        lessonsCache.set(cacheKey, res.lessons);
        if (alive) setHasLesson(res.lessons.some((l) => l.node_id === node.id));
      })
      .catch(() => {
        if (alive) setHasLesson(false);
      });
    return () => {
      alive = false;
    };
  }, [slug, node.id, workspace]);

  // 本节点未关闭的质检工单（角标入口）
  useEffect(() => {
    let alive = true;
    api
      .listTickets(slug, true, workspace)
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
  }, [slug, node.id, workspace]);

  const save = async (payload: {
    status?: NodeStatus;
    mastery?: number;
    notes?: string;
    lab_status?: LabStatus;
  }) => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.updateNodeProgress(slug, node.id, payload, workspace);
      onUpdated(res.node);
      // 只有本次真的提交了掌握度/笔记才回填并清掉「未保存」标记；状态 / 实验状态保存
      // 不能覆盖用户正在编辑但还没保存的掌握度与笔记。
      if (payload.mastery !== undefined) {
        setMastery(res.node.mastery);
        dirtyRef.current = false;
      }
      if (payload.notes !== undefined) {
        setNotes(res.node.notes);
        dirtyRef.current = false;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const openLesson = () => {
    const workspaceParam = workspace ? `&workspace=${encodeURIComponent(workspace)}` : "";
    router.push(
      `/lesson?subject=${encodeURIComponent(slug)}&node=${encodeURIComponent(node.id)}${workspaceParam}`,
    );
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

        {/* 质检工单角标入口（检查入口，独立于已移除的产课链按钮） */}
        {nodeTicketId && (
          <button
            data-testid="node-ticket-entry"
            onClick={() => setOpenTicketId(nodeTicketId)}
            className="mb-4 flex w-full items-center justify-center gap-1.5 rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-500/20 dark:text-amber-400"
          >
            ⚠ 有待处理的质检工单，点击查看
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
              onChange={(e) => {
                dirtyRef.current = true;
                setMastery(Number(e.target.value));
              }}
              className="w-full accent-brand"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs opacity-60">笔记</span>
            <textarea
              value={notes}
              onChange={(e) => {
                dirtyRef.current = true;
                setNotes(e.target.value);
              }}
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
        <NodeMisconceptions slug={slug} nodeId={node.id} workspace={workspace} />
      </div>

      {/* 质检工单模态（节点角标入口） */}
      {openTicketId && (
        <InspectionDialog
          key={openTicketId}
          ticketId={openTicketId}
          workspace={workspace}
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
function NodeMisconceptions({
  slug,
  nodeId,
  workspace,
}: {
  slug: string;
  nodeId: string;
  workspace: string | null;
}) {
  const [items, setItems] = useState<MisconceptionItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    setItems(null);
    api
      .listMisconceptions(slug, { node_id: nodeId }, workspace)
      .then((res) => {
        if (alive) setItems(res.items);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [slug, nodeId, workspace]);

  const misconceptionsHref = `/misconceptions?subject=${encodeURIComponent(slug)}&node=${encodeURIComponent(nodeId)}${
    workspace ? `&workspace=${encodeURIComponent(workspace)}` : ""
  }`;

  return (
    <div className="mt-4 flex flex-col gap-2 rounded-xl border p-3" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">本节点误解</span>
        <a
          href={misconceptionsHref}
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

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3.5">
      <div className="mb-1 text-xs font-medium opacity-50">{label}</div>
      {children}
    </div>
  );
}
