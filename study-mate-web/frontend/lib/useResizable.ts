"use client";

import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";

/**
 * 拖拽调宽的共享逻辑：宽度状态、localStorage 持久化与手柄手势。
 * 主侧边栏（Sidebar）与右侧栏（RightRail）共用，避免两份实现漂移。
 */
export interface UseResizableOptions {
  /** localStorage 键：主侧边栏与两个右侧栏各自独立 */
  storageKey: string;
  /** 默认宽度（px）；SSR 首帧即用它，避免与客户端水合结果不一致 */
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /**
   * 面板贴哪一缘，决定拖拽方向：
   * - "left"：面板贴左缘、手柄在右缘，向右拖变宽（主侧边栏）
   * - "right"：面板贴右缘、手柄在左缘，向左拖变宽（右侧栏）
   */
  side: "left" | "right";
}

export interface UseResizableResult {
  /** 当前宽度（px） */
  width: number;
  /** 是否正在拖拽：用于手柄高亮，以及拖拽时关掉宽度过渡动画 */
  resizing: boolean;
  /** 绑到拖拽手柄的 onMouseDown */
  startResize: (e: ReactMouseEvent) => void;
}

export function useResizable({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  side,
}: UseResizableOptions): UseResizableResult {
  const [width, setWidth] = useState(defaultWidth);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(defaultWidth);

  const clampWidth = (w: number) => Math.min(maxWidth, Math.max(minWidth, w));

  // 挂载时恢复持久化宽度（首帧保持默认值，避免与 SSR 输出不一致）
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved > 0) {
        const restored = clampWidth(Math.round(saved));
        widthRef.current = restored;
        setWidth(restored);
      }
    } catch {
      // localStorage 不可用时保持默认宽度
    }
  }, [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 拖拽调宽：手柄按下后监听 window 上的 move/up，宽度钳制在上下限内，松开时落盘
  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    setResizing(true);
    const onMove = (ev: MouseEvent) => {
      // 贴左缘的面板向右拖变宽；贴右缘的面板（手柄在左缘）向左拖变宽
      const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
      const next = clampWidth(startWidth + delta);
      widthRef.current = next;
      setWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      try {
        localStorage.setItem(storageKey, String(widthRef.current));
      } catch {
        // localStorage 不可用时仅本次会话生效
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 拖拽期间禁止文本选中，并保持 col-resize 光标
  useEffect(() => {
    if (!resizing) return;
    const prevSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.userSelect = prevSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [resizing]);

  return { width, resizing, startResize };
}

/**
 * 上下双栏的占比分割：上栏占比（%）、localStorage 持久化与横向手柄手势。
 * 聊天右栏「大纲在上 / 图谱在下」的同屏双栏用（2026-10-05 拍板②）；
 * 与 useResizable（左右分栏）平行，不共用状态以免语义混淆。
 *
 * 调用方须把返回的 `containerRef` 绑到包含双栏的容器元素上——拖拽换算
 * （像素位移 → 占比）依赖容器实时高度。
 */
export interface UseSplitRatioOptions {
  /** localStorage 键：每个双栏面板各自独立 */
  storageKey: string;
  /** 上栏初始占比（%）；SSR 首帧即用它，避免与客户端水合结果不一致 */
  defaultRatio: number;
  /** 占比上下限（%）：保证两栏都保持可用高度 */
  minRatio?: number;
  maxRatio?: number;
}

export interface UseSplitRatioResult {
  /** 上栏当前占比（%） */
  ratio: number;
  /** 是否正在拖拽：手柄高亮、拖拽时关掉过渡动画 */
  resizing: boolean;
  /** 绑到双栏容器的 ref：拖拽换算要读容器高度 */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 绑到拖拽手柄的 onMouseDown */
  startResize: (e: ReactMouseEvent) => void;
}

export function useSplitRatio({
  storageKey,
  defaultRatio,
  minRatio = 15,
  maxRatio = 85,
}: UseSplitRatioOptions): UseSplitRatioResult {
  const clampRatio = (r: number) => Math.min(maxRatio, Math.max(minRatio, r));
  const [ratio, setRatio] = useState(defaultRatio);
  const [resizing, setResizing] = useState(false);
  const ratioRef = useRef(defaultRatio);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 挂载时恢复持久化占比（首帧保持默认值，避免与 SSR 输出不一致）
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved > 0) {
        const restored = clampRatio(Math.round(saved));
        ratioRef.current = restored;
        setRatio(restored);
      }
    } catch {
      // localStorage 不可用时保持默认占比
    }
  }, [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 拖拽调占比：手柄按下后监听 window 上的 move/up，位移按容器高度换算成占比，松开落盘
  const startResize = (e: ReactMouseEvent) => {
    const container = containerRef.current;
    if (!container) return;
    e.preventDefault();
    const height = container.getBoundingClientRect().height;
    if (height <= 0) return;
    const startY = e.clientY;
    const startRatio = ratioRef.current;
    setResizing(true);
    const onMove = (ev: MouseEvent) => {
      // 向下拖 = 上栏（大纲）变高
      const next = clampRatio(startRatio + ((ev.clientY - startY) / height) * 100);
      ratioRef.current = next;
      setRatio(next);
    };
    const onUp = () => {
      setResizing(false);
      try {
        localStorage.setItem(storageKey, String(Math.round(ratioRef.current)));
      } catch {
        // localStorage 不可用时仅本次会话生效
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 拖拽期间禁止文本选中，并保持 row-resize 光标
  useEffect(() => {
    if (!resizing) return;
    const prevSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    return () => {
      document.body.style.userSelect = prevSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [resizing]);

  return { ratio, resizing, containerRef, startResize };
}
