"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { Check, Laptop, Moon, Palette, Sparkles, Sun } from "lucide-react";

export type ColorPalette = "blue" | "green";
export type ThemeMode = "light" | "dark" | "system";

export function ThemeView() {
  const [palette, setPalette] = useState<ColorPalette>("blue");
  const [mode, setMode] = useState<ThemeMode>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      const storedPalette = (localStorage.getItem("studymate-palette") as ColorPalette) || "blue";
      setPalette(storedPalette === "green" ? "green" : "blue");

      const storedMode = localStorage.getItem("studymate-theme") as ThemeMode | null;
      if (storedMode === "light" || storedMode === "dark" || storedMode === "system") {
        setMode(storedMode);
      } else {
        const docTheme = document.documentElement.dataset.theme;
        setMode(docTheme === "dark" ? "dark" : "light");
      }
    } catch {
      // 忽略无法访问 localStorage
    }
  }, []);

  const applyPalette = (next: ColorPalette) => {
    setPalette(next);
    document.documentElement.dataset.palette = next;
    try {
      localStorage.setItem("studymate-palette", next);
    } catch {
      // 忽略异常
    }
  };

  const applyMode = (next: ThemeMode) => {
    setMode(next);
    try {
      localStorage.setItem("studymate-theme", next);
    } catch {
      // 忽略异常
    }

    let actualTheme = next;
    if (next === "system") {
      actualTheme =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    }
    document.documentElement.dataset.theme = actualTheme;
  };

  return (
    <div className="mx-auto max-w-4xl px-8 py-8" data-testid="settings-theme-view">
      <div className="mb-8">
        <h1 className="flex items-center gap-2.5 font-serif text-2xl font-semibold tracking-tight text-[var(--foreground)]">
          <Palette className="h-6 w-6 text-brand" />
          外观与主题
        </h1>
        <p className="mt-1.5 text-sm text-[var(--foreground)]/60">
          自定义 StudyMate 的色彩基调与显示模式，定制舒适专注的沉浸学习氛围。
        </p>
      </div>

      {/* 调色方案 */}
      <section className="mb-10">
        <div className="mb-4">
          <h2 className="text-sm font-semibold tracking-wide text-[var(--foreground)]">
            调色方案（Color Palette）
          </h2>
          <p className="mt-0.5 text-xs text-[var(--foreground)]/50">
            决定全局核心品牌色、高亮强调色与界面底色微调。默认推荐现代科技蓝。
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* 科技蓝（默认） */}
          <div
            onClick={() => applyPalette("blue")}
            className={clsx(
              "group relative flex cursor-pointer flex-col justify-between rounded-2xl border p-5 transition-all",
              palette === "blue"
                ? "border-brand bg-brand/[0.04] shadow-sm ring-2 ring-brand/20"
                : "border-[var(--border)] hover:border-[var(--border)]/80 hover:bg-[var(--muted)]/40",
            )}
          >
            <div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="flex h-3 w-3 rounded-full bg-[#2563eb]" />
                  <span className="font-medium text-sm text-[var(--foreground)]">科技蓝（Oceanic Blue）</span>
                </div>
                <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
                  默认
                </span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-[var(--foreground)]/60">
                对标现代学术与知识工坊设计，深邃、专注、理智。在浅色下呈现清爽纯净，在暗色下明亮通透。
              </p>
            </div>

            {/* 色板预览胶囊 */}
            <div className="mt-5 flex items-center justify-between border-t border-[var(--border)]/50 pt-3">
              <div className="flex items-center gap-1.5">
                <span className="h-5 w-5 rounded-md bg-[#2563eb] shadow-xs" title="主色 #2563eb" />
                <span className="h-5 w-5 rounded-md bg-[#3b82f6] shadow-xs" title="次亮色 #3b82f6" />
                <span className="h-5 w-5 rounded-md bg-[#1d4ed8] shadow-xs" title="深色 #1d4ed8" />
                <span className="h-5 w-5 rounded-md border border-slate-300 bg-[#f8fafc] shadow-xs" title="浅色画布 #f8fafc" />
                <span className="h-5 w-5 rounded-md border border-slate-700 bg-[#0b0f19] shadow-xs" title="暗色画布 #0b0f19" />
              </div>
              {palette === "blue" && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand text-white">
                  <Check className="h-3.5 w-3.5" />
                </span>
              )}
            </div>
          </div>

          {/* 经典墨绿（可选） */}
          <div
            onClick={() => applyPalette("green")}
            className={clsx(
              "group relative flex cursor-pointer flex-col justify-between rounded-2xl border p-5 transition-all",
              palette === "green"
                ? "border-brand bg-brand/[0.04] shadow-sm ring-2 ring-brand/20"
                : "border-[var(--border)] hover:border-[var(--border)]/80 hover:bg-[var(--muted)]/40",
            )}
          >
            <div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="flex h-3 w-3 rounded-full bg-[#1c5a40]" />
                  <span className="font-medium text-sm text-[var(--foreground)]">经典墨绿（Forest Green）</span>
                </div>
                <span className="rounded-full bg-[var(--muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--foreground)]/60">
                  可选
                </span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-[var(--foreground)]/60">
                保留原版温润自然的纸张书卷质感（Paper `#f7f3ea`）与沉静的林木深绿，适合偏好经典纸书阅读感的用户。
              </p>
            </div>

            {/* 色板预览胶囊 */}
            <div className="mt-5 flex items-center justify-between border-t border-[var(--border)]/50 pt-3">
              <div className="flex items-center gap-1.5">
                <span className="h-5 w-5 rounded-md bg-[#1c5a40] shadow-xs" title="主色 #1c5a40" />
                <span className="h-5 w-5 rounded-md bg-[#2d7a58] shadow-xs" title="次亮色 #2d7a58" />
                <span className="h-5 w-5 rounded-md bg-[#143f2d] shadow-xs" title="深色 #143f2d" />
                <span className="h-5 w-5 rounded-md border border-[#ddd6c6] bg-[#f7f3ea] shadow-xs" title="纸张画布 #f7f3ea" />
                <span className="h-5 w-5 rounded-md border border-[#2c3530] bg-[#161b18] shadow-xs" title="暗夜竹青 #161b18" />
              </div>
              {palette === "green" && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand text-white">
                  <Check className="h-3.5 w-3.5" />
                </span>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 色彩模式 */}
      <section className="mb-10">
        <div className="mb-4">
          <h2 className="text-sm font-semibold tracking-wide text-[var(--foreground)]">
            显示模式（Display Mode）
          </h2>
          <p className="mt-0.5 text-xs text-[var(--foreground)]/50">
            切换明亮日间环境或沉浸暗夜模式，也可选择跟随操作系统自动切换。
          </p>
        </div>

        <div className="grid gap-3.5 sm:grid-cols-3">
          {/* 浅色 */}
          <button
            type="button"
            onClick={() => applyMode("light")}
            className={clsx(
              "flex flex-col items-center gap-2.5 rounded-2xl border p-4 text-center transition-all",
              mode === "light"
                ? "border-brand bg-brand/[0.04] shadow-sm ring-2 ring-brand/20"
                : "border-[var(--border)] hover:bg-[var(--muted)]/50",
            )}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <Sun className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-medium text-[var(--foreground)]">浅色模式</div>
              <div className="mt-0.5 text-[11px] text-[var(--foreground)]/50">清晰高对比度</div>
            </div>
          </button>

          {/* 暗夜 */}
          <button
            type="button"
            onClick={() => applyMode("dark")}
            className={clsx(
              "flex flex-col items-center gap-2.5 rounded-2xl border p-4 text-center transition-all",
              mode === "dark"
                ? "border-brand bg-brand/[0.04] shadow-sm ring-2 ring-brand/20"
                : "border-[var(--border)] hover:bg-[var(--muted)]/50",
            )}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-500 dark:text-indigo-400">
              <Moon className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-medium text-[var(--foreground)]">暗夜模式</div>
              <div className="mt-0.5 text-[11px] text-[var(--foreground)]/50">暗光护眼无眩光</div>
            </div>
          </button>

          {/* 跟随系统 */}
          <button
            type="button"
            onClick={() => applyMode("system")}
            className={clsx(
              "flex flex-col items-center gap-2.5 rounded-2xl border p-4 text-center transition-all",
              mode === "system"
                ? "border-brand bg-brand/[0.04] shadow-sm ring-2 ring-brand/20"
                : "border-[var(--border)] hover:bg-[var(--muted)]/50",
            )}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--muted)] text-[var(--foreground)]/70">
              <Laptop className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-medium text-[var(--foreground)]">跟随系统</div>
              <div className="mt-0.5 text-[11px] text-[var(--foreground)]/50">自动随系统昼夜调度</div>
            </div>
          </button>
        </div>
      </section>

      {/* 实时效果预览卡片 */}
      <section>
        <div className="mb-4">
          <h2 className="text-sm font-semibold tracking-wide text-[var(--foreground)]">
            当前效果即时预览（Live Preview）
          </h2>
          <p className="mt-0.5 text-xs text-[var(--foreground)]/50">
            下方为所选配色与模式下的迷你视口渲染效果。
          </p>
        </div>

        <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-card)] shadow-md">
          {/* 模拟顶栏 */}
          <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface-subtle)] px-4 py-2.5">
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
              <span className="ml-2 font-mono text-[11px] text-[var(--foreground)]/50">StudyMate Preview</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-medium text-brand">
                {palette === "blue" ? "科技蓝" : "经典墨绿"} · {mode}
              </span>
            </div>
          </div>

          {/* 模拟界面主体 */}
          <div className="grid grid-cols-[140px_1fr] p-4 text-xs">
            {/* 模拟侧栏 */}
            <div className="flex flex-col gap-1.5 border-r border-[var(--border)]/60 pr-3">
              <div className="flex items-center gap-1.5 rounded-lg bg-brand px-2 py-1.5 font-medium text-white shadow-xs">
                <Sparkles className="h-3 w-3" />
                <span>对话伴学</span>
              </div>
              <div className="rounded-lg px-2 py-1.5 text-[var(--foreground)]/70 hover:bg-[var(--muted)]">
                我的课程
              </div>
              <div className="rounded-lg px-2 py-1.5 text-[var(--foreground)]/70 hover:bg-[var(--muted)]">
                概念本
              </div>
            </div>

            {/* 模拟对话区 */}
            <div className="flex flex-col gap-3 pl-4">
              {/* 助手消息 */}
              <div className="flex items-start gap-2">
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-white">
                  <Sparkles className="h-2.5 w-2.5" />
                </div>
                <div className="rounded-xl border border-[var(--border)]/60 bg-[var(--surface-subtle)] p-2.5 text-[var(--foreground)]">
                  你好！今天我们来学习异步事件架构与错误隔离机制。
                </div>
              </div>

              {/* 用户消息 */}
              <div className="flex items-start justify-end gap-2">
                <div className="rounded-xl bg-brand px-3 py-2 text-white shadow-xs">
                  好的，请先帮我拆解一下核心数据流！
                </div>
              </div>

              {/* 模拟操作按钮 */}
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg bg-brand px-2.5 py-1 text-[11px] font-medium text-white shadow-xs"
                >
                  继续下一步
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface-card)] px-2.5 py-1 text-[11px] text-[var(--foreground)]/80 hover:bg-[var(--muted)]"
                >
                  记入概念本
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
