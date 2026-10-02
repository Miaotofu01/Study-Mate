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

// 节点详情归入右侧边栏：默认展开，宽度默认 320px（原 w-80），可拖拽范围 240–520px，刷新后保留
const DETAIL_WIDTH_KEY = "studymate-course-detail-width";
const DETAIL_DEFAULT_WIDTH = 320;
const DETAIL_MIN_WIDTH = 240;
const DETAIL_MAX_WIDTH = 520;

const STATUS_FILL: Record<NodeStatus, string> = {
  未开始: "#9aa5a1",
  学习中: "#3b82f6",
  初步理解: "#14b8a6",
  能独立应用: "#22c55e",
  需要复习: "#f59e0b",
  已通过项目验证: "#1c5a40",
};

const STATUS_DOT: Record<SubjectStatus, string> = {
  进行中: "#22c55e",
  暂停: "#f59e0b",
  已完成: "#9aa5a1",
};

const EDGE_GRAY = "#9aa5a1";

function buildStyles(): cytoscape.StylesheetJson {
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
        "border-width": 4,
        "border-color": "#1c5a40",
        "overlay-color": "#1c5a40",
        "overlay-opacity": 0.12,
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
  const { subjects, refreshSubjects } = useWorkspace();

  const [subjectsReady, setSubjectsReady] = useState(false);
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 节点详情右侧边栏：默认展开（大量用例依赖详情可见）
  const [detailOpen, setDetailOpen] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  const requestedSlug = searchParams.get("subject");
  const activeSlug = requestedSlug || subjects[0]?.slug || null;

  useEffect(() => {
    void refreshSubjects().finally(() => setSubjectsReady(true));
  }, [refreshSubjects]);

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
    const container = containerRef.current;
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
      wheelSensitivity: 0.2,
    });
    cyRef.current = cy;

    cy.on("tap", "node", (evt) => {
      setSelectedNodeId(evt.target.id());
    });
    cy.on("tap", (evt) => {
      if (evt.target === cy) setSelectedNodeId(null);
    });

    // 容器尺寸变化（折叠 / 拖宽右侧详情栏、窗口缩放）时让 cytoscapes 重新适配画布
    const observer = new ResizeObserver(() => cy.resize());
    observer.observe(container);

    return () => {
      observer.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [elements]);

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
      {/* 科目列表 */}
      <div
        className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r px-2 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        {subjects.map((s) => {
          const active = s.slug === activeSlug;
          const percent = Math.round((s.avg_mastery ?? 0) * 100);
          return (
            <Link
              key={s.slug}
              href={`/courses?subject=${encodeURIComponent(s.slug)}`}
              className={clsx(
                "flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                active ? "bg-brand/10" : "hover:bg-[var(--muted)]",
              )}
            >
              <span className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: STATUS_DOT[s.status] ?? "#9aa5a1" }}
                />
                <span
                  className={clsx("truncate text-sm", active && "font-medium text-brand")}
                >
                  {s.name}
                </span>
              </span>
              <span className="pl-3.5 text-[11px] opacity-50">
                {s.node_done}/{s.node_total} · 掌握 {percent}%
              </span>
            </Link>
          );
        })}
      </div>

      {/* 图谱画布 */}
      <div className="relative min-w-0 flex-1">
        <div ref={containerRef} className="h-full w-full" />
        {/* 详情栏折叠按钮：必须放在图区（面板收起后宽度为 0，按钮在面板里点不到） */}
        <button
          onClick={() => setDetailOpen((v) => !v)}
          className="absolute left-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-lg border bg-[var(--background)] opacity-70 shadow-sm transition-opacity hover:bg-[var(--muted)] hover:opacity-100"
          style={{ borderColor: "var(--border)" }}
          title={detailOpen ? "折叠节点详情" : "展开节点详情"}
        >
          {detailOpen ? (
            <PanelRightClose className="h-4 w-4" />
          ) : (
            <PanelRightOpen className="h-4 w-4" />
          )}
        </button>
        <div className="sr-only" role="group" aria-label="节点列表">
          {(course?.graph.nodes ?? []).map((n) => (
            <button key={n.id} data-testid={`graph-node-${n.id}`} onClick={() => selectNode(n.id)}>
              {n.index}. {n.title}
            </button>
          ))}
        </div>

        {course && !loading && (
          <div className="absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
            <button
              onClick={() => void handleExport()}
              disabled={exporting}
              className="flex items-center gap-1.5 rounded-lg border bg-[var(--background)] px-2.5 py-1.5 text-xs shadow-sm hover:bg-[var(--muted)] disabled:opacity-50"
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
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--background)]/60">
            <Loader2 className="h-6 w-6 animate-spin opacity-50" />
          </div>
        )}
        {!loading && error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <AlertCircle className="h-6 w-6 text-red-500" />
            <p className="text-sm text-red-500">{error}</p>
          </div>
        )}
        {!loading && !error && course && course.graph.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm opacity-50">
            这门科目还没有节点
          </div>
        )}
      </div>

      {/* 节点详情：与聊天页右侧边栏共用 RightRail（默认展开，可折叠 / 拖宽） */}
      <RightRail
        open={detailOpen}
        storageKey={DETAIL_WIDTH_KEY}
        defaultWidth={DETAIL_DEFAULT_WIDTH}
        minWidth={DETAIL_MIN_WIDTH}
        maxWidth={DETAIL_MAX_WIDTH}
        separatorLabel="调整节点详情宽度"
        testId="course-node-detail"
        contentClassName="w-80 border-l"
      >
        {course && selectedNode ? (
          <NodeDetail
            slug={course.subject.slug}
            node={selectedNode}
            onSelectNode={selectNode}
            onUpdated={handleUpdated}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center opacity-50">
            <MousePointerClick className="h-6 w-6" />
            <p className="text-sm">点击节点查看详情</p>
          </div>
        )}
      </RightRail>
    </div>
  );
}
