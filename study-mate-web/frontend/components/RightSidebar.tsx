"use client";

import { useEffect, useState } from "react";
import { ExternalLink, FileText, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import type { AttachmentsArea } from "@/lib/types";

// 纯内容组件：外壳（宽度动画 / 拖拽 / inert）在 RightRail，本组件只渲染各区段。
// 折叠不再卸载内容，区段状态（如科目下拉的本地态）在折叠后依然保留。
//
// 2026-10-04 拍板：「会话关联」整段（科目下拉 / 生成小结 / 沉淀记忆）移除——关联改在
// 新对话态的输入区上方；小结与沉淀记忆的入口暂时悬空（后端能力保留）。右栏只剩
// 附件区与会话信息。
interface RightSidebarProps {
  sessionId: string | null;
  messageCount: number;
}

function formatCreatedAt(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

export function RightSidebar({ sessionId, messageCount }: RightSidebarProps) {
  const { sessions, subjects, activeSubjectSlug, activeWorkspace } = useWorkspace();

  const meta = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const subjectName = subjects.find((s) => s.slug === activeSubjectSlug)?.name ?? null;

  return (
    <>
      {/* 附件区：仅关联科目后出现，四组文件链接（新标签页打开；按会话工作区读取） */}
      {activeSubjectSlug && <AttachmentsAreaSection slug={activeSubjectSlug} workspace={activeWorkspace} />}

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
