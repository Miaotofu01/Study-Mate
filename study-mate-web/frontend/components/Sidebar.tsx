"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import {
  GraduationCap,
  Loader2,
  MessagesSquare,
  Moon,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Settings,
  Sun,
  Trash2,
} from "lucide-react";
import { useWorkspace } from "@/lib/workspace";
import { useResizable } from "@/lib/useResizable";
import pkg from "../package.json";

const navItems = [
  // 「新对话」既是导航入口也是新会话动作：点它回到一个干净的新对话界面
  { href: "/chat", label: "新对话", icon: MessagesSquare, startsNewSession: true },
  { href: "/courses", label: "课程图谱", icon: GraduationCap, startsNewSession: false },
  { href: "/misconceptions", label: "概念本", icon: NotebookPen, startsNewSession: false },
];

// 侧边栏宽度：默认 240px（原 w-60），可拖拽范围 180–420px，刷新后保留
const SIDEBAR_WIDTH_KEY = "studymate-sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 420;

// 折叠态：收成 60px 图标轨，刷新后保留
const SIDEBAR_COLLAPSED_KEY = "studymate-sidebar-collapsed";
const SIDEBAR_COLLAPSED_WIDTH = 60;

type Theme = "light" | "dark";

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const {
    sessions,
    subjects,
    activeSessionId,
    currentSubjectSlug,
    setCurrentSubjectSlug,
    newSession,
    openSession,
    deleteSession,
    renameSession,
    createSubject,
  } = useWorkspace();

  // 拖拽调宽逻辑与右侧栏（RightRail）共用一套 useResizable
  const { width, resizing, startResize } = useResizable({
    storageKey: SIDEBAR_WIDTH_KEY,
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    maxWidth: SIDEBAR_MAX_WIDTH,
    side: "left",
  });

  const [theme, setTheme] = useState<Theme | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [showSubjectForm, setShowSubjectForm] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [goal, setGoal] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  // 折叠态：首帧保持展开（避免 SSR 不一致），水合后恢复持久化值
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
    } catch {
      // localStorage 不可用时保持展开
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // localStorage 不可用时仅本次会话生效
      }
      return next;
    });
  };

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("studymate-theme", next);
    } catch {
      // localStorage 不可用时仅本次会话生效
    }
    setTheme(next);
  };

  const subjectName = (subjectSlug: string) => {
    const found = subjects.find((s) => s.slug === subjectSlug);
    return found ? found.name : subjectSlug;
  };

  // 科目选中态只在课程页出现（其他页面不表达"在看哪门科目"）
  const onCourses = pathname.startsWith("/courses");

  const handleNewSession = () => {
    newSession();
    router.push("/chat");
  };

  const handleOpenSession = (id: string) => {
    void openSession(id).catch(() => undefined);
    router.push("/chat");
  };

  const handleRename = async (id: string, current: string) => {
    const title = window.prompt("重命名会话", current);
    if (title === null) return;
    const trimmed = title.trim();
    if (!trimmed || trimmed === current) return;
    try {
      await renameSession(id, trimmed);
    } catch {
      // 失败时静默保留原列表
    }
  };

  const handleDelete = async (id: string, title: string) => {
    if (!window.confirm(`删除会话「${title}」？`)) return;
    try {
      await deleteSession(id);
    } catch {
      // 忽略删除失败
    }
  };

  const resetForm = () => {
    setName("");
    setSlug("");
    setGoal("");
    setFormError(null);
  };

  const submitSubject = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("请填写科目名称");
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const created = await createSubject(trimmedName, slug, goal);
      resetForm();
      setShowSubjectForm(false);
      router.push(`/courses?subject=${encodeURIComponent(created.slug)}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const openWizard = () => {
    setShowSubjectForm(false);
    resetForm();
    router.push("/generate");
  };

  return (
    <aside
      className={clsx(
        "relative flex shrink-0 flex-col border-r bg-[var(--surface-subtle)] select-none",
        !resizing && "transition-[width] duration-200 ease-out motion-reduce:transition-none",
      )}
      style={{ borderColor: "var(--border)", width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : width }}
    >
      {/* 拖拽调宽手柄：折叠态隐藏，展开态沿右边缘左右拖动（180–420px 并持久化） */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧边栏宽度"
          title="拖动调整宽度"
          onMouseDown={startResize}
          className={clsx(
            "absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize transition-colors",
            resizing ? "bg-brand/30" : "bg-transparent hover:bg-brand/20",
          )}
        />
      )}

      {/* 品牌 + 折叠按钮 */}
      {collapsed ? (
        <div className="flex items-center justify-center py-3.5">
          <button
            onClick={toggleCollapsed}
            title="展开侧边栏"
            aria-label="展开侧边栏"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--foreground)]/70 transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2.5 py-4 pl-4 pr-3">
          {/* logo：public/icon-192.png（docs/images/logo.png 的 192×192 裁切版），圆角裁切 */}
          <img
            src="/icon-192.png"
            alt="StudyMate"
            width={28}
            height={28}
            className="h-7 w-7 shrink-0 rounded-xl object-cover shadow-xs"
          />
          <span className="min-w-0 flex-1 truncate font-serif text-[17px] font-semibold tracking-tight text-[var(--foreground)]">
            StudyMate
          </span>
          <button
            onClick={toggleCollapsed}
            title="折叠侧边栏"
            aria-label="折叠侧边栏"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--foreground)]/50 transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 导航 */}
      <nav className={clsx("flex flex-col gap-1 py-1.5", collapsed ? "px-2" : "px-3")}>
        {navItems.map((item) => {
          // 「新对话」只在真的没有活动会话时才算选中；否则选中交给会话行，
          // 避免「正在看历史会话」时导航和会话行同时发亮
          const active =
            pathname.startsWith(item.href) &&
            (!item.startsNewSession || activeSessionId === null);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={
                item.startsNewSession
                  ? () => {
                      newSession();
                    }
                  : undefined
              }
              title={collapsed ? item.label : undefined}
              className={clsx(
                "flex items-center gap-3 rounded-xl py-2 text-sm font-medium transition-all",
                collapsed ? "justify-center px-0" : "px-3",
                active
                  ? "bg-brand text-white shadow-xs"
                  : "text-[var(--foreground)]/80 hover:bg-[var(--muted)]/70 hover:text-[var(--foreground)]",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && item.label}
            </Link>
          );
        })}
      </nav>

      <div className={clsx("flex-1 overflow-y-auto px-3 pb-2", collapsed && "hidden")}>
        {/* 会话 */}
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between px-2">
            <span className="text-[11px] font-medium tracking-wide uppercase text-[var(--foreground)]/45">会话</span>
            <button
              onClick={handleNewSession}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-[var(--foreground)]/60 transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
              title="新对话"
            >
              <Plus className="h-3.5 w-3.5" />
              新对话
            </button>
          </div>

          <div className="flex flex-col gap-0.5">
            {sessions.length === 0 && (
              <p className="px-2 py-2 text-xs text-[var(--foreground)]/40">暂无会话</p>
            )}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={clsx(
                  "group flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm transition-colors",
                  activeSessionId === s.id
                    ? "bg-brand/10 font-medium text-brand"
                    : "text-[var(--foreground)]/80 hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)]",
                )}
                onClick={() => handleOpenSession(s.id)}
              >
                <span className="min-w-0 flex-1 truncate">{s.title || "未命名会话"}</span>

                {s.subject_slug && (
                  <span
                    className="shrink-0 truncate rounded px-1.5 py-0.5 text-[10px] bg-[var(--surface-card)] text-[var(--foreground)]/60 border border-[var(--border)]/50"
                    style={{ maxWidth: "4.5rem" }}
                    title={subjectName(s.subject_slug)}
                  >
                    {subjectName(s.subject_slug)}
                  </span>
                )}

                <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleRename(s.id, s.title);
                    }}
                    className="rounded p-1 opacity-60 transition-opacity hover:opacity-100"
                    title="重命名"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(s.id, s.title);
                    }}
                    className="rounded p-1 opacity-60 transition-opacity hover:opacity-100 hover:text-red-500"
                    title="删除"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 科目 */}
        <div className="mt-5">
          <div className="mb-1.5 flex items-center justify-between px-2">
            <span className="text-[11px] font-medium tracking-wide uppercase text-[var(--foreground)]/45">科目</span>
            <button
              onClick={() => {
                setShowSubjectForm((v) => !v);
                setFormError(null);
              }}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-[var(--foreground)]/60 transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
              title="新科目"
            >
              <Plus className="h-3.5 w-3.5" />
              新科目
            </button>
          </div>

          {showSubjectForm && (
            <div
              className="mb-2 flex flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-3 shadow-xs"
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="名称（必填）"
                className="w-full rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-brand"
              />
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="slug（留空自动生成）"
                className="w-full rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-brand"
              />
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="学习目标（可选）"
                rows={2}
                className="w-full resize-none rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-brand"
              />
              {formError && <p className="text-[11px] text-red-500">{formError}</p>}
              <div className="flex gap-1.5 pt-1">
                <button
                  onClick={() => void submitSubject()}
                  disabled={creating}
                  className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-light disabled:opacity-50 shadow-xs"
                >
                  {creating && <Loader2 className="h-3 w-3 animate-spin" />}
                  创建
                </button>
                <button
                  onClick={() => {
                    setShowSubjectForm(false);
                    resetForm();
                  }}
                  className="rounded-lg px-2.5 py-1.5 text-xs text-[var(--foreground)]/70 hover:bg-[var(--muted)]"
                >
                  取消
                </button>
              </div>
              <button
                onClick={openWizard}
                className="text-left text-[11px] text-brand-light hover:underline pt-1"
              >
                不想手填？用 AI 向导生成科目 →
              </button>
            </div>
          )}

          <div className="flex flex-col gap-0.5">
            {subjects.length === 0 && (
              <p className="px-2 py-2 text-xs text-[var(--foreground)]/40">暂无科目</p>
            )}
            {subjects.map((s) => {
              // 选中态只在课程页表达「当前在看的科目」，与会话行用同一套视觉
              const selected = onCourses && s.slug === currentSubjectSlug;
              return (
                <button
                  key={s.slug}
                  onClick={() => {
                    setCurrentSubjectSlug(s.slug);
                    router.push(`/courses?subject=${encodeURIComponent(s.slug)}`);
                  }}
                  title={s.name}
                  aria-current={selected ? "page" : undefined}
                  className={clsx(
                    "flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm transition-colors",
                    selected
                      ? "bg-brand/10 font-medium text-brand"
                      : "text-[var(--foreground)]/80 hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)]",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* 底栏：主题切换 + 设置 */}
      <div
        className={clsx("border-t py-2.5", collapsed ? "px-2" : "px-3")}
        style={{ borderColor: "var(--border)" }}
      >
        <div className={clsx("flex items-center gap-1.5", collapsed && "flex-col gap-2")}>
          <Link
            href="/settings"
            title={collapsed ? "设置" : undefined}
            className={clsx(
              "flex items-center gap-2.5 rounded-xl py-2 text-sm font-medium transition-all",
              collapsed ? "w-8 justify-center px-0" : "flex-1 px-3",
              pathname.startsWith("/settings")
                ? "bg-brand text-white shadow-xs"
                : "text-[var(--foreground)]/80 hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)]",
            )}
          >
            <Settings className="h-4 w-4 shrink-0" />
            {!collapsed && "设置"}
          </Link>
          {/* 明暗切换：与设置同一行、位于其右侧 */}
          <button
            onClick={toggleTheme}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-[var(--foreground)]/70 transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            title={theme === "dark" ? "切换到亮色模式" : "切换到暗夜模式"}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
        {!collapsed && (
          <div className="px-2 pt-2 text-[11px] text-[var(--foreground)]/40 font-mono">
            v{pkg.version} · learn with doing
          </div>
        )}
      </div>
    </aside>
  );
}
