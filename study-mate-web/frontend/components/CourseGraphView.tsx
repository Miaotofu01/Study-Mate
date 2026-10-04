"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Loader2,
  MousePointerClick,
  PanelRightClose,
  PanelRightOpen,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import { NodeDetail } from "./NodeDetail";
import { RightRail } from "./RightRail";
import { SubjectGraphPanel } from "./SubjectGraphPanel";
import { HomeEmbed } from "./HomeEmbed";
import type { CourseDetail, ExportResult, GraphNode, SubjectStatus } from "@/lib/types";

// 右栏承载「大纲 / 图谱」分段切换（2026-10-04 再对调）：默认进图谱，主区只剩节点详情
const GRAPH_WIDTH_KEY = "studymate-course-graph-width";
const GRAPH_DEFAULT_WIDTH = 480;
const GRAPH_MIN_WIDTH = 320;
const GRAPH_MAX_WIDTH = 760;

// 科目状态（进行中 / 暂停 / 已完成）：科目总览里可就地改，走后端 PATCH /api/courses/{slug}
const SUBJECT_STATUSES: SubjectStatus[] = ["进行中", "暂停", "已完成"];

export function CourseGraphView() {
  const searchParams = useSearchParams();
  const { subjects, refreshSubjects, setCurrentSubjectSlug } = useWorkspace();

  const [subjectsReady, setSubjectsReady] = useState(false);
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // 右栏面板重拉计数：节点进度保存后 +1（见 handleUpdated）
  const [graphRefreshKey, setGraphRefreshKey] = useState(0);
  // 科目总览：状态可就地修改
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 图谱右侧边栏：默认展开
  const [detailOpen, setDetailOpen] = useState(true);
  // ?node= 预选只消费一次（概念本「定位节点」入口），避免 course 更新时反复抢选中态
  const consumedNodeParam = useRef<string | null>(null);

  const requestedSlug = searchParams.get("subject");
  const requestedNode = searchParams.get("node");
  // 不带 ?subject= 时进入「我的课程」首页（嵌入工作区 index.html），不再回落到第一个科目
  const activeSlug = requestedSlug;

  useEffect(() => {
    void refreshSubjects().finally(() => setSubjectsReady(true));
  }, [refreshSubjects]);

  // 把"当前在看的科目"发布给左侧边栏，用于科目行的选中态
  useEffect(() => {
    setCurrentSubjectSlug(activeSlug);
  }, [activeSlug, setCurrentSubjectSlug]);

  // 头部总览用的派生值（node_done / node_total / avg_mastery 来自科目摘要）
  const subjectSummary = useMemo(
    () => subjects.find((s) => s.slug === activeSlug) ?? null,
    [subjects, activeSlug],
  );

  /** 就地改科目状态：乐观更新头部，落盘后刷新科目摘要 */
  const changeStatus = useCallback(
    async (status: SubjectStatus) => {
      if (!activeSlug || statusSaving) return;
      setStatusSaving(true);
      setStatusError(null);
      try {
        await api.patchCourse(activeSlug, { status });
        setCourse((prev) => (prev ? { ...prev, subject: { ...prev.subject, status } } : prev));
        await refreshSubjects();
      } catch (err) {
        setStatusError(err instanceof Error ? err.message : String(err));
      } finally {
        setStatusSaving(false);
      }
    },
    [activeSlug, statusSaving, refreshSubjects],
  );

  // 拉取当前科目的课程图谱（主区头部与节点详情用；右栏图谱面板自带一份数据）
  useEffect(() => {
    if (!activeSlug) {
      setCourse(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    setSelectedNodeId(null);
    setExportResult(null);
    setExportError(null);
    api
      .getCourse(activeSlug)
      .then((detail) => {
        if (alive) setCourse(detail);
      })
      .catch((err) => {
        if (alive) {
          setCourse(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activeSlug]);

  // ?node= 预选：课程加载完成后选中该节点（仅消费一次）
  useEffect(() => {
    if (!course || !requestedNode) return;
    if (consumedNodeParam.current === requestedNode) return;
    if (course.graph.nodes.some((n) => n.id === requestedNode)) {
      consumedNodeParam.current = requestedNode;
      setSelectedNodeId(requestedNode);
    }
  }, [course, requestedNode]);

  const handleUpdated = useCallback(
    (updated: GraphNode) => {
      setCourse((prev) =>
        prev
          ? {
              ...prev,
              graph: {
                ...prev.graph,
                nodes: prev.graph.nodes.map((n) => (n.id === updated.id ? updated : n)),
              },
            }
          : prev,
      );
      // 右栏图谱/大纲由 SubjectGraphPanel 自持一份数据（它自己 getCourse）：
      // 节点详情里存了进度后要让面板重拉，否则节点配色停在旧状态。
      setGraphRefreshKey((n) => n + 1);
      void refreshSubjects();
    },
    [refreshSubjects],
  );

  const selectedNode = useMemo(
    () => course?.graph.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [course, selectedNodeId],
  );

  const selectNode = useCallback((id: string) => setSelectedNodeId(id), []);

  const handleExport = useCallback(async () => {
    if (!activeSlug || exporting) return;
    setExporting(true);
    setExportResult(null);
    setExportError(null);
    setCopied(false);
    try {
      const res = await api.exportCourse(activeSlug);
      setExportResult(res);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, [activeSlug, exporting]);

  const copyExportDir = useCallback(async () => {
    if (!exportResult) return;
    try {
      await navigator.clipboard.writeText(exportResult.export_dir);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时忽略
    }
  }, [exportResult]);

  if (!subjectsReady) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin opacity-50" />
      </div>
    );
  }

  if (subjects.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm opacity-60">还没有科目。</p>
        <p className="text-xs opacity-40">
          先在侧边栏「科目」区点击「+ 新科目」，或
          <Link href="/generate" className="mx-1 text-brand hover:underline">
            让 AI 生成一门科目
          </Link>。
        </p>
      </div>
    );
  }

  // 不带 ?subject= → 「我的课程」：只嵌入工作区首页，不渲染图谱 / 大纲 / 节点详情。
  // 空工作区（subjects.length === 0）优先于首页嵌入，走上面的「还没有科目…」提示。
  if (!requestedSlug) {
    return (
      <div className="h-full w-full">
        <HomeEmbed />
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* 主区：科目头部 + 节点详情（大纲与图谱都收进右栏，2026-10-04 再对调拍板） */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* 头部：科目名 + 状态/进度总览 + 图谱开关 + 导出 */}
        <div
          className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5"
          style={{ borderColor: "var(--border)" }}
        >
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {course?.subject.name ?? (loading ? "加载中…" : "")}
          </h1>
          {/* 科目总览（2026-10-04 拍板 A）：状态从左侧边栏的绿点移到这里，并可就地改 */}
          {course && (
            <div className="hidden shrink-0 items-center gap-2.5 text-[11px] text-[var(--foreground)]/60 md:flex">
              {subjectSummary && (
                <span title="已完成节点（能独立应用 / 已通过项目验证）/ 总节点数">
                  进度 {subjectSummary.node_done}/{subjectSummary.node_total} · 平均掌握度{" "}
                  {Math.round(subjectSummary.avg_mastery * 100)}%
                </span>
              )}
              <label className="flex shrink-0 items-center gap-1.5">
                <span className="opacity-60">状态</span>
                <select
                  value={course.subject.status}
                  onChange={(e) => void changeStatus(e.target.value as SubjectStatus)}
                  disabled={statusSaving}
                  title="科目状态"
                  data-testid="subject-status"
                  className="rounded-lg border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-[11px] outline-none focus:border-brand disabled:opacity-50"
                >
                  {SUBJECT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </label>
              {statusError && (
                <span className="max-w-[12rem] truncate text-red-500" title={statusError}>
                  状态保存失败：{statusError}
                </span>
              )}
            </div>
          )}
          <button
            onClick={() => setDetailOpen((v) => !v)}
            className="flex h-7 w-7 items-center justify-center rounded-lg border opacity-70 transition-opacity hover:bg-[var(--muted)] hover:opacity-100"
            style={{ borderColor: "var(--border)" }}
            title={detailOpen ? "折叠课程图谱" : "展开课程图谱"}
          >
            {detailOpen ? (
              <PanelRightClose className="h-4 w-4" />
            ) : (
              <PanelRightOpen className="h-4 w-4" />
            )}
          </button>
          {course && (
            <button
              onClick={() => void handleExport()}
              disabled={exporting}
              className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-[var(--muted)] disabled:opacity-50"
              style={{ borderColor: "var(--border)" }}
              title="把当前科目导出为静态课程工作区"
            >
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              导出静态工作区
            </button>
          )}
        </div>

        {/* 导出结果 / 错误浮层 */}
        {course && !loading && (exportResult || exportError) && (
          <div className="absolute right-3 top-12 z-10 flex flex-col items-end gap-2">
            {exportResult && (
              <div
                className="flex w-80 flex-col gap-1.5 rounded-xl border bg-[var(--background)] p-3 text-xs shadow-lg"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">导出完成</span>
                  <button
                    onClick={() => setExportResult(null)}
                    className="opacity-50 hover:opacity-100"
                    title="关闭"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex items-start gap-1">
                  <code className="min-w-0 flex-1 break-all leading-relaxed opacity-80">
                    {exportResult.export_dir}
                  </code>
                  <button
                    onClick={() => void copyExportDir()}
                    className="shrink-0 rounded p-0.5 opacity-60 hover:bg-[var(--muted)] hover:opacity-100"
                    title="复制路径"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-brand" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                <div className="opacity-60">共 {exportResult.pages} 个页面</div>
                <div className="opacity-60">可用 gen_home / check_lesson 直接校验</div>
              </div>
            )}
            {exportError && (
              <div className="flex w-80 items-start justify-between gap-2 rounded-xl border border-red-300/50 bg-[var(--background)] p-3 text-xs text-red-600 shadow-lg dark:text-red-400">
                <span className="min-w-0 flex-1 break-all">{exportError}</span>
                <button
                  onClick={() => setExportError(null)}
                  className="shrink-0 opacity-50 hover:opacity-100"
                  title="关闭"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {loading && (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin opacity-50" />
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <AlertCircle className="h-6 w-6 text-red-500" />
            <p className="text-sm text-red-500">{error}</p>
          </div>
        )}

        {!loading && !error && course && course.graph.nodes.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-sm opacity-50">
            这门科目还没有节点
          </div>
        )}

        {!loading && !error && course && course.graph.nodes.length > 0 && (
          /* 节点详情：撑满主区剩余高度（大纲列表已移入右栏，见 SubjectGraphPanel 内分段切换） */
          <div className="min-h-0 flex-1 overflow-hidden">
            {selectedNode ? (
              <div data-testid="course-node-detail" className="h-full">
                <NodeDetail
                  slug={course.subject.slug}
                  node={selectedNode}
                  onSelectNode={selectNode}
                  onUpdated={handleUpdated}
                />
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center opacity-50">
                <MousePointerClick className="h-6 w-6" />
                <p className="text-sm">点击节点查看详情</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 右侧栏：大纲 / 图谱分段切换由 SubjectGraphPanel 提供（可折叠 / 可拖宽；sr-only 节点按钮供测试与键盘路径） */}
      <RightRail
        open={detailOpen}
        storageKey={GRAPH_WIDTH_KEY}
        defaultWidth={GRAPH_DEFAULT_WIDTH}
        minWidth={GRAPH_MIN_WIDTH}
        maxWidth={GRAPH_MAX_WIDTH}
        separatorLabel="调整课程图谱宽度"
        testId="course-graph-rail"
        contentClassName="border-l"
      >
        <SubjectGraphPanel
          slug={requestedSlug}
          selectedNodeId={selectedNodeId}
          onSelectNode={selectNode}
          onClearSelection={() => setSelectedNodeId(null)}
          refreshKey={graphRefreshKey}
          defaultView="graph"
        />
      </RightRail>
    </div>
  );
}
