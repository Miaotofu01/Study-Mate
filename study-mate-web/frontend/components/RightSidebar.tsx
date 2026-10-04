"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ExternalLink, FileText, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { contextUsagePercent, formatTokens } from "@/lib/contextWindow";
import { useWorkspace } from "@/lib/workspace";
import { SubjectGraphPanel } from "./SubjectGraphPanel";
import type { AttachmentsArea, Usage } from "@/lib/types";

// 纯内容组件：外壳（宽度动画 / 拖拽 / inert）在 RightRail，本组件只渲染各区段。
// 折叠不再卸载内容，区段状态（如科目下拉的本地态）在折叠后依然保留。
//
// 2026-10-04 拍板：「会话关联」整段（科目下拉 / 生成小结 / 沉淀记忆）移除——关联改在
// 新对话态的输入区上方；小结与沉淀记忆的入口暂时悬空（后端能力保留）。右栏只剩
// 上下文窗口、附件区与会话信息。
interface RightSidebarProps {
  sessionId: string | null;
  messageCount: number;
  /** 最近一轮用量；为新对话或未产出过用量时为 null */
  usage: Usage | null;
  /** 当前生效模型标识「提供商 / 模型」 */
  modelLabel: string | null;
  /** 当前模型生效的上下文长度（未声明时已由调用方兜底） */
  contextWindow: number;
}

function formatCreatedAt(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

/** 右栏选项卡：图谱与大纲 / 上下文窗口 / 会话与附件（各占一页） */
type RailTab = "graph" | "context" | "session";

const RAIL_TABS: { id: RailTab; label: string; testId: string }[] = [
  { id: "graph", label: "图谱与大纲", testId: "rail-tab-graph" },
  { id: "context", label: "上下文窗口", testId: "rail-tab-context" },
  { id: "session", label: "会话与附件", testId: "rail-tab-session" },
];

export function RightSidebar({
  sessionId,
  messageCount,
  usage,
  modelLabel,
  contextWindow,
}: RightSidebarProps) {
  const router = useRouter();
  const { sessions, subjects, activeSubjectSlug, activeWorkspace } = useWorkspace();

  const meta = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const subjectName = subjects.find((s) => s.slug === activeSubjectSlug)?.name ?? null;

  const used = usage?.prompt_tokens ?? 0;
  const percent = contextUsagePercent(used, contextWindow);

  // 选项卡：全部面板常驻挂载、用 hidden 切换（同图谱/大纲分段），避免附件拉取与画布被销毁重建。
  // override 为空时按规则推导默认页：关联科目则「图谱与大纲」，否则「上下文窗口」（科目异步恢复也能跟上）；
  // 用户点过某页后 override 生效，之后切科目不再抢回默认页。
  const hasSubject = Boolean(activeSubjectSlug);
  const [tabOverride, setTabOverride] = useState<RailTab | null>(null);
  const activeTab: RailTab =
    tabOverride && !(tabOverride === "graph" && !hasSubject)
      ? tabOverride
      : hasSubject
        ? "graph"
        : "context";
  // 未关联科目时图谱页无内容可显示，直接不出现该选项卡
  const tabs = hasSubject ? RAIL_TABS : RAIL_TABS.filter((t) => t.id !== "graph");

  return (
    <>
      {/* 选项卡条：与图谱/大纲分段切换同一套视觉语言 */}
      <div
        role="group"
        aria-label="聊天右栏选项卡"
        data-testid="chat-rail-tabs"
        className="flex shrink-0 gap-1 border-b px-2 py-2"
        style={{ borderColor: "var(--border)" }}
      >
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              data-testid={tab.testId}
              onClick={() => setTabOverride(tab.id)}
              aria-pressed={active}
              title={tab.label}
              className={clsx(
                // 右栏默认 256px、最小 200px：三个页签要放下五个字的标签，用小一号字 +
                // 紧内边距，truncate 只作兜底（悬停有完整 title）
                "min-w-0 flex-1 truncate rounded-md px-1 py-1 text-[11px] leading-4 transition-colors",
                active
                  ? "bg-brand/10 font-medium text-brand"
                  : "opacity-70 hover:bg-[var(--muted)] hover:opacity-100",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 上下文窗口：最近一轮的 prompt tokens 占当前模型上下文长度的比例 */}
      <div
        data-testid="context-window"
        className={clsx(
          "flex flex-col gap-1.5 border-b px-4 py-4",
          activeTab !== "context" && "hidden",
        )}
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="shrink-0 text-xs font-medium opacity-50">上下文窗口</span>
          {modelLabel && (
            <span
              data-testid="context-window-model"
              className="min-w-0 truncate text-[11px] opacity-60"
              title={modelLabel}
            >
              {modelLabel}
            </span>
          )}
        </div>
        <div data-testid="context-window-usage" className="text-sm font-medium">
          {usage
            ? `${formatTokens(used)} / ${formatTokens(contextWindow)} (${percent}%)`
            : `— / ${formatTokens(contextWindow)}`}
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="上下文窗口占用"
          className="h-1.5 w-full overflow-hidden rounded-full"
          style={{ background: "var(--muted)" }}
        >
          <div
            data-testid="context-window-bar"
            className="h-full rounded-full bg-brand transition-[width] duration-300"
            style={{ width: `${Math.max(percent, usage ? 2 : 0)}%` }}
          />
        </div>
        {!usage && <span className="text-[10px] opacity-40">本轮结束后显示用量</span>}
      </div>

      {/* 科目图谱 / 大纲：关联科目后出现。聊天右栏窄（200–480px），默认大纲视图，
          点节点跳课程页定位（?subject=&node=），图谱视图仍可分段切换。 */}
      {activeSubjectSlug && (
        <div
          data-testid="subject-graph-section"
          className={clsx("h-80 shrink-0 border-b", activeTab !== "graph" && "hidden")}
          style={{ borderColor: "var(--border)" }}
        >
          <SubjectGraphPanel
            slug={activeSubjectSlug}
            workspace={activeWorkspace}
            defaultView="outline"
            onSelectNode={(id) =>
              router.push(
                `/courses?subject=${encodeURIComponent(activeSubjectSlug)}&node=${encodeURIComponent(id)}`,
              )
            }
          />
        </div>
      )}

      {/* 会话与附件页：附件区（仅关联科目后出现，四组文件链接，按会话工作区读取）+ 元信息区 */}
      <div className={clsx("flex flex-col", activeTab !== "session" && "hidden")}>
        {activeSubjectSlug && (
          <AttachmentsAreaSection slug={activeSubjectSlug} workspace={activeWorkspace} />
        )}

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
      </div>
    </>
  );
}

interface AttachmentFile {
  /** 展示用文件名 */
  name: string;
  /** 相对科目目录的路径，拼到 /api/courses/{slug}/files/ 后 */
  relPath: string;
}

/** 附件区：术语表 / 本地资料 / 学习记录 / 会话摘要，按科目目录扫描后经 /files/ 打开 */
function AttachmentsAreaSection({ slug, workspace }: { slug: string; workspace: string | null }) {
  const [area, setArea] = useState<AttachmentsArea | null>(null);

  // 右侧栏（RightRail）挂载、科目切换、会话工作区切换时各拉一次；先清空，避免用新 slug +
  // 旧文件名拼出脏链接
  useEffect(() => {
    let alive = true;
    setArea(null);
    api
      .getAttachmentsArea(slug, workspace)
      .then((res) => {
        if (alive) setArea(res);
      })
      .catch(() => {
        if (alive) setArea(null);
      });
    return () => {
      alive = false;
    };
  }, [slug, workspace]);

  const groups: { label: string; files: AttachmentFile[] }[] = [
    {
      label: "术语表",
      files: area?.glossary ? [{ name: area.glossary, relPath: area.glossary }] : [],
    },
    {
      label: "本地资料",
      files: (area?.reference ?? []).map((name) => ({ name, relPath: `reference/${name}` })),
    },
    {
      label: "学习记录",
      files: (area?.learning_records ?? []).map((name) => ({
        name,
        relPath: `learning-records/${name}`,
      })),
    },
    {
      label: "会话摘要",
      files: (area?.sessions ?? []).map((name) => ({ name, relPath: `sessions/${name}` })),
    },
  ];

  return (
    <div
      data-testid="chat-attachments-area"
      className="flex flex-col gap-3 border-b px-4 py-4"
      style={{ borderColor: "var(--border)" }}
    >
      <span className="text-xs font-medium opacity-50">附件区</span>

      {!area && (
        <div className="flex items-center gap-1.5 text-[11px] opacity-50">
          <Loader2 className="h-3 w-3 animate-spin" />
          读取中…
        </div>
      )}

      {area?.glossary === null &&
        area.reference.length === 0 &&
        area.learning_records.length === 0 &&
        area.sessions.length === 0 && (
          <span className="text-[11px] opacity-40">该科目暂无附件文件</span>
        )}

      {groups.map((group) =>
        group.files.length === 0 ? null : (
          <div key={group.label} className="flex flex-col gap-1">
            <span className="text-[11px] opacity-40">
              {group.label} · {group.files.length}
            </span>
            {group.files.map((file) => (
              <a
                key={file.relPath}
                href={api.courseFileUrl(slug, file.relPath, workspace)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-[11px] transition-colors hover:bg-[var(--muted)]"
                style={{ color: "var(--link)" }}
                title={`${file.relPath}（新标签页打开）`}
              >
                <FileText className="h-3 w-3 shrink-0 opacity-60" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-40" />
              </a>
            ))}
          </div>
        ),
      )}
    </div>
  );
}
