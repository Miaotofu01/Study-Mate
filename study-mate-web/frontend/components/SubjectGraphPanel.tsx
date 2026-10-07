"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import cytoscape from "cytoscape";
import clsx from "clsx";
import { AlertCircle, Loader2, Maximize2 } from "lucide-react";
import { api } from "@/lib/api";
import { useSplitRatio } from "@/lib/useResizable";
import type { CourseDetail, GraphNode, NodeStatus } from "@/lib/types";

// 「图谱 / 大纲」可复用面板：课程页右栏与聊天页右栏共用同一份实现。
// 自己拉取课程数据、自己持有 cytoscape 实例与分段视图，对外只暴露选中的节点 id。
//
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

export interface SubjectGraphPanelProps {
  slug: string;
  workspace?: string | null;
  defaultView?: "graph" | "outline";
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
  /** 点画布空白处取消选中（课程页用它回到"点击节点查看详情"空态；聊天右栏不需要） */
  onClearSelection?: () => void;
  /** 外部改了节点数据（如在节点详情里存了进度）时 +1，让面板重新拉一次课程数据 */
  refreshKey?: number;
  /**
   * 布局（2026-10-05 拍板②）：
   * - "segmented"（默认）：图谱 / 大纲分段切换，同屏只显示其一（课程页右栏）；
   * - "stacked"：大纲在上、图谱在下同屏双栏，中间手柄拖拽调占比（聊天右栏），
   *   占比持久化到 `splitStorageKey`。
   */
  layout?: "segmented" | "stacked";
  /** stacked 布局的占比持久化键（每处双栏面板各自独立） */
  splitStorageKey?: string;
  /** className for the wrapper; the panel must fill available width/height */
}

/** 大纲列表（按学习顺序，状态着色，点击选中）：分段与双栏两种布局共用 */
function OutlineRows({
  nodes,
  selectedNodeId,
  onSelect,
}: {
  nodes: GraphNode[];
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {nodes.map((n) => {
        const active = n.id === selectedNodeId;
        return (
          <button
            key={n.id}
            data-testid={`outline-node-${n.id}`}
            onClick={() => onSelect(n.id)}
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
    </>
  );
}

export function SubjectGraphPanel({
  slug,
  workspace,
  defaultView = "graph",
  selectedNodeId = null,
  onSelectNode,
  onClearSelection,
  refreshKey = 0,
  layout = "segmented",
  splitStorageKey = "studymate-subject-graph-split",
}: SubjectGraphPanelProps): JSX.Element {
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 分段视图：课程页默认图谱，聊天右栏默认大纲（由 defaultView 指定）；双栏布局不使用
  const [railView, setRailView] = useState<"graph" | "outline">(defaultView);
  // 双栏布局：上栏（大纲）占比拖拽与持久化
  const split = useSplitRatio({ storageKey: splitStorageKey, defaultRatio: 50 });
  const stacked = layout === "stacked";

  // 画布容器用 state 承载（而不是 useRef）：getCourse 可能先于容器挂载返回——那一提交里
  // elements 已经非空但容器还没挂载，ref 型依赖不会触发 effect 重跑，图谱就永远建不出来。
  // state 在容器挂载时变化，effect 必然重跑。
  const [graphContainer, setGraphContainer] = useState<HTMLDivElement | null>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  // 回调放 ref：外部的 onSelectNode 常是内联箭头（如聊天右栏 router.push），
  // 放进建图 effect 依赖会导致每次渲染都销毁重建 cytoscape。
  const onSelectRef = useRef(onSelectNode);
  useEffect(() => {
    onSelectRef.current = onSelectNode;
  }, [onSelectNode]);
  const onClearRef = useRef(onClearSelection);
  useEffect(() => {
    onClearRef.current = onClearSelection;
  }, [onClearSelection]);

  // 拉取当前科目的课程图谱
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setCourse(null);
    api
      .getCourse(slug, workspace)
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
  }, [slug, workspace, refreshKey]);

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
      onSelectRef.current?.(evt.target.id());
    });

    // 点空白处取消选中：课程页据此回到"点击节点查看详情"空态（聊天右栏不传该回调）
    cy.on("tap", (evt) => {
      if (evt.target === cy) onClearRef.current?.();
    });

    // 容器尺寸变化（折叠 / 拖宽右侧详情栏、窗口缩放）时让 cytoscape 重新适配画布
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

  // 高亮选中节点：外部 selectedNodeId 变化时同步画布选中态
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass("highlighted");
    if (selectedNodeId) {
      cy.getElementById(selectedNodeId).addClass("highlighted");
    }
  }, [selectedNodeId, elements]);

  const selectNode = useCallback((id: string) => {
    onSelectRef.current?.(id);
  }, []);

  // 重置视口：带 200ms 动画拟合全部节点（cy.fit 本身不支持动画参数，走 cy.animate 的 fit 选项）
  const resetViewport = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.animate({ fit: { eles: cy.elements(), padding: 24 } }, { duration: 200 });
  }, []);

  const nodes = course?.graph.nodes ?? [];

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      {/* 分段切换：图谱 / 大纲（仅分段布局；双栏布局两视图同屏，无需切换） */}
      {!stacked && (
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
      )}

      {/* 分段内容：两个视图都常驻挂载，用 hidden（display:none）切换，避免画布销毁重建 */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {stacked ? (
          /* 双栏（2026-10-05 拍板②）：大纲在上、图谱在下，中间手柄拖拽调占比。
             画布尺寸随手柄拖动变化，靠已有的 ResizeObserver 触发 cy.resize()+fit。 */
          <div ref={split.containerRef} className="flex h-full min-h-0 flex-col">
            <div
              data-testid="course-outline"
              className="min-h-0 overflow-y-auto py-1.5"
              style={{ flexBasis: `${split.ratio}%`, flexGrow: 0, flexShrink: 0 }}
            >
              <OutlineRows nodes={nodes} selectedNodeId={selectedNodeId} onSelect={selectNode} />
            </div>
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="调整大纲与图谱占比"
              title="拖动调整大纲与图谱占比"
              onMouseDown={split.startResize}
              className={clsx(
                "relative z-10 h-1.5 shrink-0 cursor-row-resize transition-colors",
                split.resizing ? "bg-brand/30" : "bg-transparent hover:bg-brand/20",
              )}
            />
            <div className="relative min-h-0 flex-1 bg-dot-matrix bg-[var(--surface-canvas)]">
              <div ref={setGraphContainer} data-testid="course-graph-canvas" className="h-full w-full" />
              <button
                onClick={resetViewport}
                className="absolute bottom-3 right-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg border bg-[var(--background)]/80 opacity-70 transition-opacity hover:bg-[var(--muted)] hover:opacity-100"
                style={{ borderColor: "var(--border)" }}
                title="重置视口"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
              <div className="sr-only" role="group" aria-label="节点列表">
                {nodes.map((n) => (
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
          </div>
        ) : (
          <>
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
                {nodes.map((n) => (
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
              <OutlineRows nodes={nodes} selectedNodeId={selectedNodeId} onSelect={selectNode} />
            </div>
          </>
        )}

        {/* 加载 / 错误浮层：保持画布与大纲常驻挂载 */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--surface-canvas)]/60">
            <Loader2 className="h-5 w-5 animate-spin opacity-50" />
          </div>
        )}
        {!loading && error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <AlertCircle className="h-5 w-5 text-red-500" />
            <p className="text-xs text-red-500">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
