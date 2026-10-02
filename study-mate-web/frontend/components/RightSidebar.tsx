"use client";

import { Loader2, ScrollText } from "lucide-react";
import { useWorkspace } from "@/lib/workspace";
import type { GraphNode } from "@/lib/types";

// 纯内容组件：外壳（宽度动画 / 拖拽 / inert）在 RightRail，本组件只渲染两个区段。
// 折叠不再卸载内容，区段状态（如科目下拉的本地态）在折叠后依然保留。
interface RightSidebarProps {
  sessionId: string | null;
  messageCount: number;
  nodes: GraphNode[];
  summarizing: boolean;
  canSummarize: boolean;
  onSummarize: () => void;
}

function formatCreatedAt(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

export function RightSidebar({
  sessionId,
  messageCount,
  nodes,
  summarizing,
  canSummarize,
  onSummarize,
}: RightSidebarProps) {
  const { sessions, subjects, activeSubjectSlug, activeNodeId, setActiveSubject } = useWorkspace();

  const meta = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const subjectName = subjects.find((s) => s.slug === activeSubjectSlug)?.name ?? null;

  return (
    <>
      {/* 关联区：科目 / 节点下拉 + 生成小结（自顶栏移入） */}
      <div className="flex flex-col gap-3 border-b px-4 py-4" style={{ borderColor: "var(--border)" }}>
        <span className="text-xs font-medium opacity-50">会话关联</span>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] opacity-50">科目</span>
          <select
            value={activeSubjectSlug ?? ""}
            onChange={(e) => {
              const value = e.target.value;
              setActiveSubject(value === "" ? null : value, null);
            }}
            className="w-full truncate rounded-lg border bg-transparent px-2 py-1 text-xs outline-none"
            style={{ borderColor: "var(--border)" }}
            title="关联科目"
          >
            <option value="">不关联</option>
            {subjects.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] opacity-50">节点</span>
          <select
            value={activeNodeId ?? ""}
            onChange={(e) => {
              const value = e.target.value;
              setActiveSubject(activeSubjectSlug, value === "" ? null : value);
            }}
            disabled={!activeSubjectSlug}
            className="w-full truncate rounded-lg border bg-transparent px-2 py-1 text-xs outline-none disabled:opacity-40"
            style={{ borderColor: "var(--border)" }}
            title="关联节点"
          >
            <option value="">整门科目</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.index}. {n.title}
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={onSummarize}
          disabled={!canSummarize || summarizing}
          className="flex items-center justify-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ borderColor: "var(--border)" }}
          title={canSummarize ? "为本会话生成学习小结" : "需关联科目且会话中有消息"}
        >
          {summarizing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ScrollText className="h-3.5 w-3.5" />
          )}
          生成小结
        </button>
      </div>

      {/* 元信息区 */}
      <div className="flex flex-col gap-2 px-4 py-4">
        <span className="text-xs font-medium opacity-50">会话信息</span>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="shrink-0 opacity-50">消息数</span>
          <span data-testid="session-message-count" className="shrink-0">
            {messageCount} 条
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="shrink-0 opacity-50">创建时间</span>
          <span data-testid="session-created-at" className="truncate">
            {meta ? formatCreatedAt(meta.created_at) : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="shrink-0 opacity-50">关联科目</span>
          <span
            data-testid="session-subject"
            className="truncate"
            title={subjectName ?? undefined}
          >
            {subjectName ?? "未关联"}
          </span>
        </div>
      </div>
    </>
  );
}
