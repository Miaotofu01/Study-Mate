"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import cytoscape from "cytoscape";
import clsx from "clsx";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Loader2,
  Maximize2,
  MousePointerClick,
  PanelRightClose,
  PanelRightOpen,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import { NodeDetail } from "./NodeDetail";
import { RightRail } from "./RightRail";
import type { CourseDetail, ExportResult, GraphNode, NodeStatus, SubjectStatus } from "@/lib/types";

// 右栏承载「大纲 / 图谱」分段切换（2026-10-04 再对调）：默认进图谱，主区只剩节点详情
const GRAPH_WIDTH_KEY = "studymate-course-graph-width";
const GRAPH_DEFAULT_WIDTH = 480;
const GRAPH_MIN_WIDTH = 320;
const GRAPH_MAX_WIDTH = 760;

// 滚轮缩放灵敏度：cytoscape 默认 1，也就是最灵敏。早前用的 0.2 太钝（一步几乎不动），
// 现回到最灵敏档；若后续觉得偏猛再往下调。
// （自定义该值时 cytoscape 会打印一条 console warn，属预期行为，不要去消除）
const WHEEL_SENSITIVITY = 1;

const STATUS_FILL: Record<NodeStatus, string> = {
  未开始: "#9aa5a1",
  学习中: "#3b82f6",
  初步理解: "#14b8a6",
  能独立应用: "#22c55e",
  需要复习: "#f59e0b",
  已通过项目验证: "#1c5a40",
};

const KIND_FILL: Record<GraphNode["kind"], string> = {
  概念: "#14b8a6",
  实操: "#3b82f6",
  实验: "#f59e0b",
};

// 科目状态（进行中 / 暂停 / 已完成）：科目总览里可就地改，走后端 PATCH /api/courses/{slug}
const SUBJECT_STATUSES: SubjectStatus[] = ["进行中", "暂停", "已完成"];

const EDGE_GRAY = "#9aa5a1";

function getBrandColor(): string {
  if (typeof document === "undefined") return "#2563eb";
  const palette = document.documentElement.dataset.palette;
  const isDark = document.documentElement.dataset.theme === "dark";
  if (palette === "green") {
    return isDark ? "#4ade80" : "#1c5a40";
  }
  return isDark ? "#60a5fa" : "#2563eb";
}

function buildStyles(): cytoscape.StylesheetJson {
  const brandColor = getBrandColor();
  const styles: cytoscape.StylesheetJson = [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        width: "label",
        padding: "10px",
        height: 30,
        "background-color": STATUS_FILL["未开始"],
        color: "#ffffff",
        label: "data(label)",
        "font-size": 11,
        "text-wrap": "wrap",
        "text-max-width": "90",
        "text-valign": "center",
        "text-halign": "center",
        "border-width": 1,
        "border-color": EDGE_GRAY,
      },
    },
    {
      selector: "edge",
      style: {
        width: 1.5,
        "line-color": EDGE_GRAY,
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "target-arrow-color": EDGE_GRAY,
        "arrow-scale": 0.9,
      },
    },
    {
      selector: "node.highlighted",
      style: {
        "border-width": 3,
        "border-color": brandColor,
        "overlay-color": brandColor,
        "overlay-opacity": 0.16,
        "overlay-padding": 6,
      },
    },
  ];

  for (const status of Object.keys(STATUS_FILL) as NodeStatus[]) {
    styles.push({
      selector: `node[status="${status}"]`,
      style: { "background-color": STATUS_FILL[status] },
    });
  }

  return styles;
}

export function CourseGraphView() {
  const searchParams = useSearchParams();
  const { subjects, refreshSubjects, setCurrentSubjectSlug } = useWorkspace();

  const [subjectsReady, setSubjectsReady] = useState(false);
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // 科目总览：状态可就地修改
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 图谱右侧边栏：默认展开
  const [detailOpen, setDetailOpen] = useState(true);
  // 右栏分段视图：默认图谱（依赖 graph-node-* 的既有用例无需切换即可用）
  const [railView, setRailView] = useState<"graph" | "outline">("graph");
  // ?node= 预选只消费一次（概念本「定位节点」入口），避免 course 更新时反复抢选中态
  const consumedNodeParam = useRef<string | null>(null);

  // 画布容器用 state 承载（而不是 useRef）：/courses 在 subjectsReady 之前走 early-return
  // 不渲染右栏，而 getCourse 可能先于 refreshSubjects 返回——那一提交里 elements 已经非空但
  // 容器还没挂载，ref 型依赖不会触发 effect 重跑，图谱就永远建不出来。state 在容器挂载时
  // 变化，effect 必然重跑。
  const [graphContainer, setGraphContainer] = useState<HTMLDivElement | null>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  const requestedSlug = searchParams.get("subject");
  const requestedNode = searchParams.get("node");
  const activeSlug = requestedSlug || subjects[0]?.slug || null;

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

  // 拉取当前科目的课程图谱
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

  const elements = useMemo<cytoscape.ElementDefinition[]>(() => {
    if (!course) return [];
    const nodes: cytoscape.ElementDefinition[] = course.graph.nodes.map((n) => ({
      data: {
        id: n.id,
        label: n.title,
        title: n.title,
        status: n.status,
        kind: n.kind,
        index: n.index,
      },
    }));
    const edges: cytoscape.ElementDefinition[] = course.graph.edges.map((e, i) => ({
      data: { id: `e-${i}-${e.from}-${e.to}`, source: e.from, target: e.to, reason: e.reason },
    }));
    return [...nodes, ...edges];
  }, [course]);

  // 重建图谱：切换科目或保存进度（course 变化）时销毁重建
  useEffect(() => {
    const container = graphContainer;
    if (!container || elements.length === 0) return;

    const cy = cytoscape({
      container,
      elements,
      style: buildStyles(),
      layout: {
        name: "breadthfirst",
        directed: true,
        padding: 24,
        spacingFactor: 1.15,
      },
      wheelSensitivity: WHEEL_SENSITIVITY,
    });
    cy.fit();
    cyRef.current = cy;

    cy.on("tap", "node", (evt) => {
      setSelectedNodeId(evt.target.id());
    });
    cy.on("tap", (evt) => {
      if (evt.target === cy) setSelectedNodeId(null);
    });

    // 容器尺寸变化（折叠 / 拖宽右侧详情栏、窗口缩放）时让 cytoscapes 重新适配画布
    const observer = new ResizeObserver(() => {
      cy.resize();
      cy.fit();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [graphContainer, elements]);

  // 折叠状态变化时重新自适应画布
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const timer = setTimeout(() => {
      cy.resize();
      cy.fit();
    }, 220);
    return () => clearTimeout(timer);
  }, [detailOpen]);

  // 切回图谱视图：display:none 期间画布拿不到尺寸，delayed resize + fit（沿用折叠处理的 220ms 思路）
  useEffect(() => {
    if (railView !== "graph") return;
    const cy = cyRef.current;
    if (!cy) return;
    const timer = setTimeout(() => {
      cy.resize();
      cy.fit();
    }, 220);
    return () => clearTimeout(timer);
  }, [railView]);

  // 高亮选中节点
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass("highlighted");
    if (selectedNodeId) {
      cy.getElementById(selectedNodeId).addClass("highlighted");
    }
  }, [selectedNodeId, elements]);

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
      void refreshSubjects();
    },
    [refreshSubjects],
  );

  const selectedNode = useMemo(
    () => course?.graph.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [course, selectedNodeId],
  );

  const selectNode = useCallback((id: string) => setSelectedNodeId(id), []);

  // 重置视口：带 200ms 动画拟合全部节点（cy.fit 本身不支持动画参数，走 cy.animate 的 fit 选项）
  const resetViewport = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.animate({ fit: { eles: cy.elements(), padding: 24 } }, { duration: 200 });
  }, []);

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
          /* 节点详情：撑满主区剩余高度（大纲列表已移入右栏，见 RightRail 内分段切换） */
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

      {/* 右侧栏：大纲 / 图谱分段切换（可折叠 / 可拖宽；sr-only 节点按钮供测试与键盘路径） */}
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
        <div className="flex h-full min-w-0 flex-col">
          {/* 分段切换：图谱（默认）/ 大纲 */}
          <div
            role="group"
            aria-label="课程右栏视图切换"
            className="inline-flex shrink-0 gap-1 border-b px-3 py-2"
            style={{ borderColor: "var(--border)" }}
          >
            <button
              data-testid="rail-view-graph"
              onClick={() => setRailView("graph")}
              aria-pressed={railView === "graph"}
              className={clsx(
                "rounded-md px-3 py-1 text-xs transition-colors",
                railView === "graph"
                  ? "bg-brand/10 font-medium text-brand"
                  : "opacity-70 hover:bg-[var(--muted)] hover:opacity-100",
              )}
            >
              图谱
            </button>
            <button
              data-testid="rail-view-outline"
              onClick={() => setRailView("outline")}
              aria-pressed={railView === "outline"}
              className={clsx(
                "rounded-md px-3 py-1 text-xs transition-colors",
                railView === "outline"
                  ? "bg-brand/10 font-medium text-brand"
                  : "opacity-70 hover:bg-[var(--muted)] hover:opacity-100",
              )}
            >
              大纲
            </button>
          </div>

          {/* 分段内容：两个视图都常驻挂载，用 hidden（display:none）切换，避免画布销毁重建 */}
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {/* 图谱视图：画布 + 右下角重置视口按钮 + sr-only 节点按钮 */}
            <div
              className={clsx(
                "relative h-full w-full bg-dot-matrix bg-[var(--surface-canvas)]",
                railView !== "graph" && "hidden",
              )}
            >
              <div
                ref={setGraphContainer}
                data-testid="course-graph-canvas"
                className="h-full w-full"
              />
              <button
                onClick={resetViewport}
                className="absolute bottom-3 right-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg border bg-[var(--background)]/80 opacity-70 transition-opacity hover:bg-[var(--muted)] hover:opacity-100"
                style={{ borderColor: "var(--border)" }}
                title="重置视口"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
              <div className="sr-only" role="group" aria-label="节点列表">
                {(course?.graph.nodes ?? []).map((n) => (
                  <button
                    key={n.id}
                    data-testid={`graph-node-${n.id}`}
                    aria-label={`图谱节点 ${n.index}`}
                    onClick={() => selectNode(n.id)}
                  >
                    {n.index}. {n.title}
                  </button>
                ))}
              </div>
            </div>

            {/* 大纲视图：按学习顺序，状态着色，点击选中节点 */}
            <div
              data-testid="course-outline"
              className={clsx("h-full overflow-y-auto py-1.5", railView !== "outline" && "hidden")}
            >
              {(course?.graph.nodes ?? []).map((n) => {
                const active = n.id === selectedNodeId;
                return (
                  <button
                    key={n.id}
                    data-testid={`outline-node-${n.id}`}
                    onClick={() => setSelectedNodeId(n.id)}
                    className={clsx(
                      "flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors",
                      active ? "bg-brand/10" : "hover:bg-[var(--muted)]",
                    )}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: STATUS_FILL[n.status] ?? "#9aa5a1" }}
                      title={n.status}
                    />
                    <span className={clsx("min-w-0 flex-1 truncate", active && "font-medium text-brand")}>
                      {n.index}. {n.title}
                    </span>
                    <span
                      className="shrink-0 rounded px-1 py-0.5 text-[10px] text-white"
                      style={{ background: KIND_FILL[n.kind] ?? "#6b7280" }}
                    >
                      {n.kind}
                    </span>
                    <span className="w-10 shrink-0 text-right text-[11px] opacity-50">
                      {Math.round(n.mastery * 100)}%
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </RightRail>
    </div>
  );
}
