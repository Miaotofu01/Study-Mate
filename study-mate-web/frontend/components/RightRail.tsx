"use client";

import type { ReactNode } from "react";
import clsx from "clsx";
import { useResizable } from "@/lib/useResizable";

export interface RightRailProps {
  /** 展开态；收起时宽度过渡到 0，内容保持挂载并加 inert + aria-hidden（不 unmount） */
  open: boolean;
  /** 宽度持久化的 localStorage 键：聊天页与课程页各自独立 */
  storageKey: string;
  minWidth: number;
  maxWidth: number;
  /** 默认宽度，省略为 256（对应原 w-64） */
  defaultWidth?: number;
  /** 内容根附加类名（如 border-l；宽度以内联样式为准，类名里的 w-* 会被覆盖） */
  contentClassName?: string;
  /** 拖拽手柄的无障碍名称 */
  separatorLabel?: string;
  /** 测试锚点，如 chat-right-sidebar */
  testId?: string;
  children: ReactNode;
}

/**
 * 右侧栏外壳：折叠 / 展开用宽度过渡动画，内容保持挂载（收起时 inert + aria-hidden），
 * 宽度可拖拽并持久化到 storageKey。尺寸、持久化与手柄都独立于内容。
 *
 * 根元素用 `div[role=complementary]` 而非 `<aside>`：与主侧边栏的 `<aside>` 区分，
 * 避免测试与业务代码里「页面只有一个侧边栏 aside」的既有假设失效。
 */
export function RightRail({
  open,
  storageKey,
  minWidth,
  maxWidth,
  defaultWidth = 256,
  contentClassName,
  separatorLabel = "调整右侧边栏宽度",
  testId,
  children,
}: RightRailProps) {
  const { width, resizing, startResize } = useResizable({
    storageKey,
    defaultWidth,
    minWidth,
    maxWidth,
    side: "right",
  });

  return (
    <div
      role="complementary"
      data-testid={testId}
      // 收起时组件保持挂载：宽度过渡到 0 + inert/aria-hidden，避免下拉与区段状态被卸载重置
      inert={!open}
      aria-hidden={open ? undefined : true}
      className={clsx(
        "relative shrink-0 overflow-hidden",
        resizing
          ? "transition-none"
          : "transition-[width] duration-200 ease-out motion-reduce:transition-none",
      )}
      style={{ width: open ? width : 0 }}
    >
      {/* 拖拽手柄：左缘，向左拖变宽，宽度落盘到 storageKey */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={separatorLabel}
        title="拖动调整宽度"
        onMouseDown={startResize}
        className={clsx(
          "absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize transition-colors",
          resizing ? "bg-brand/30" : "bg-transparent hover:bg-brand/20",
        )}
      />
      {/* 内层保持拖拽宽度不跟着动画收缩，避免收起过程中文字回流抖动；裁剪交给外层 */}
      <div
        className={clsx("flex h-full min-w-0 flex-col overflow-y-auto", contentClassName)}
        style={{ width }}
      >
        {children}
      </div>
    </div>
  );
}
