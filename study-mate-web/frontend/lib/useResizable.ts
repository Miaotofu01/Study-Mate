"use client";

import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

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
