"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";
import { AlertCircle, ArrowLeft, ListChecks, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import { GradingPanel } from "./GradingPanel";
import type { LessonInfo } from "@/lib/types";

export function LessonView() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { activeWorkspace } = useWorkspace();

  const subject = searchParams.get("subject");
  const nodeId = searchParams.get("node");
  // 课件所属工作区：优先 URL 显式携带（从节点详情跳来时带上），否则用会话当前工作区
  const workspace = searchParams.get("workspace") ?? activeWorkspace;

  const [lessons, setLessons] = useState<LessonInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    if (!subject) {
      setLessons(null);
      return;
    }
    let alive = true;
    setError(null);
    api
      .listLessons(subject, workspace)
      .then((res) => {
        if (alive) setLessons(res.lessons);
      })
      .catch((err) => {
        if (alive) {
          setLessons(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      alive = false;
    };
  }, [subject, workspace]);

  const lesson = useMemo(
    () => lessons?.find((l) => l.node_id === nodeId) ?? null,
    [lessons, nodeId],
  );

  // file 字段可能自带 lessons/ 前缀，统一剥掉后拼到 files/lessons/ 下；带上 workspace 让课件
  // 与它的共享资源（../../../assets/...）都从所属工作区解析。
  const fileSrc =
    subject && lesson
      ? api.courseFileUrl(
          subject,
          `lessons/${lesson.file.replace(/^\/?lessons\//, "")}`,
          workspace,
        )
      : null;

  const back = () => {
    router.push(subject ? `/courses?subject=${encodeURIComponent(subject)}` : "/courses");
  };

  return (
    // 壳层自身不产出横向滚动：主体行 overflow-hidden，判分面板再宽也只在内部裁切，
    // 返回/工具按钮（shrink-0）在窄屏下始终可达；iframe 内的渲染产物不受影响。
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      {/* 顶栏 */}
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5 sm:gap-3 sm:px-4"
        style={{ borderColor: "var(--border)" }}
      >
        <button
          onClick={back}
          className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs hover:bg-[var(--muted)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">返回图谱</span>
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {lesson?.title ?? nodeId ?? "课件"}
        </span>
        <button
          onClick={() => setPanelOpen((v) => !v)}
          disabled={!subject || !nodeId}
          className={clsx(
            "flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-xs disabled:opacity-40",
            panelOpen ? "border-brand bg-brand/10 text-brand" : "hover:bg-[var(--muted)]",
          )}
          style={panelOpen ? undefined : { borderColor: "var(--border)" }}
        >
          <ListChecks className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">判分面板</span>
        </button>
      </div>

      {/* 主体：iframe 与判分面板都限制在本行内，不把壳层撑宽 */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {fileSrc ? (
          <iframe src={fileSrc} title={lesson?.title ?? "课件"} className="h-full min-w-0 flex-1 border-0" />
        ) : (
          <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            {!subject || !nodeId ? (
              <p className="text-sm opacity-60">缺少 subject 或 node 参数</p>
            ) : error ? (
              <>
                <AlertCircle className="h-5 w-5 text-red-500" />
                <p className="text-sm text-red-500">{error}</p>
              </>
            ) : lessons === null ? (
              <Loader2 className="h-5 w-5 animate-spin opacity-50" />
            ) : !lesson ? (
              <p className="text-sm opacity-60">该节点没有课件</p>
            ) : null}
          </div>
        )}

        {panelOpen && subject && nodeId && (
          <GradingPanel
            key={`${subject}:${nodeId}:${workspace ?? ""}`}
            slug={subject}
            nodeId={nodeId}
            workspace={workspace}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
