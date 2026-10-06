"use client";

import { useEffect, useState, type JSX } from "react";

import { api } from "@/lib/api";

// 工作区首页（<workspace>/index.html）的嵌入：后端 /api/home/* 从工作区根提供，
// 页面里的相对引用（.learning/assets/...）因此能正确解析。
// ?theme= 驱动生成页的 learn-theme.js；本组件监听 <html data-theme> 的变化并同步。
function readTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function HomeEmbed({ workspace = null }: { workspace?: string | null }): JSX.Element {
  // 首帧统一为 light（SSR 与客户端一致，避免水合不一致），挂载后再对齐真实主题
  const [theme, setTheme] = useState<"dark" | "light">("light");

  useEffect(() => {
    setTheme(readTheme());
    const observer = new MutationObserver(() => {
      setTheme(readTheme());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  // 绑定工作区时走 `/api/workspace-files/<token>/home/index.html`（显式 index 保住相对层级，
  // 首页内 `.learning/assets/...` 仍在 home/ 前缀下）。缺省走旧的 /api/home 默认工作区路由。
  const base = api.workspaceFileBase(workspace);
  const src = base
    ? `${base}/home/index.html?theme=${theme}`
    : `/api/home/index.html?theme=${theme}`;

  return (
    <iframe
      data-testid="home-embed"
      src={src}
      title="我的课程"
      className="h-full w-full border-0"
    />
  );
}
