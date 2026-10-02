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
  Pencil,
  Plus,
  Settings,
  Sun,
  Trash2,
} from "lucide-react";
import { useWorkspace } from "@/lib/workspace";
import { useResizable } from "@/lib/useResizable";
import type { SubjectStatus } from "@/lib/types";
import pkg from "../package.json";

const navItems = [
  { href: "/chat", label: "Chat", icon: MessagesSquare },
  { href: "/courses", label: "课程图谱", icon: GraduationCap },
  { href: "/misconceptions", label: "概念本", icon: NotebookPen },
];

const STATUS_DOT: Record<SubjectStatus, string> = {
  进行中: "#22c55e",
  暂停: "#f59e0b",
  已完成: "#9aa5a1",
};

// 侧边栏宽度：默认 240px（原 w-60），可拖拽范围 180–420px，刷新后保留
const SIDEBAR_WIDTH_KEY = "studymate-sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 420;

type Theme = "light" | "dark";

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const {
    sessions,
    subjects,
    activeSessionId,
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
  const [showSubjectForm, setShowSubjectForm] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [goal, setGoal] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

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
      className="relative flex shrink-0 flex-col border-r"
      style={{ borderColor: "var(--border)", width }}
    >
      {/* 拖拽调宽手柄：沿右边缘左右拖动，宽度 180–420px 并持久化 */}
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

      {/* 品牌 */}
      <div className="flex items-center gap-2 px-5 py-4">
        {/* logo：public/icon-192.png（docs/images/logo.png 的 192×192 裁切版），圆角裁切 */}
        <img
          src="/icon-192.png"
          alt="StudyMate"
          width={28}
          height={28}
          className="h-7 w-7 shrink-0 rounded-xl object-cover"
        />
        <span className="text-lg font-semibold tracking-tight">StudyMate</span>
      </div>

      {/* 导航 */}
      <nav className="flex flex-col gap-1 px-3 py-2">
        {navItems.map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active ? "bg-brand text-white" : "hover:bg-[var(--muted)]",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1 overflow-y-auto px-3 pb-2">
        {/* 会话 */}
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-xs font-medium opacity-50">会话</span>
            <button
              onClick={handleNewSession}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs opacity-70 hover:bg-[var(--muted)] hover:opacity-100"
              title="新对话"
            >
              <Plus className="h-3.5 w-3.5" />
              新对话
            </button>
          </div>

          <div className="flex flex-col gap-0.5">
            {sessions.length === 0 && (
              <p className="px-2 py-1 text-xs opacity-40">暂无会话</p>
            )}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={clsx(
                  "group flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm transition-colors",
                  activeSessionId === s.id ? "bg-brand/10 text-brand" : "hover:bg-[var(--muted)]",
                )}
                onClick={() => handleOpenSession(s.id)}
              >
                <span className="min-w-0 flex-1 truncate">{s.title || "未命名会话"}</span>

                {s.subject_slug && (
                  <span
                    className="shrink-0 truncate rounded px-1 text-[10px]"
                    style={{ background: "var(--muted)", maxWidth: "4.5rem" }}
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
                    className="rounded p-0.5 opacity-60 hover:opacity-100"
                    title="重命名"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(s.id, s.title);
                    }}
                    className="rounded p-0.5 opacity-60 hover:opacity-100"
                    title="删除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 科目 */}
        <div className="mt-5">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-xs font-medium opacity-50">科目</span>
            <button
              onClick={() => {
                setShowSubjectForm((v) => !v);
                setFormError(null);
              }}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs opacity-70 hover:bg-[var(--muted)] hover:opacity-100"
              title="新科目"
            >
              <Plus className="h-3.5 w-3.5" />
              新科目
            </button>
          </div>

          {showSubjectForm && (
            <div
              className="mb-2 flex flex-col gap-1.5 rounded-xl border p-2"
              style={{ borderColor: "var(--border)" }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="名称（必填）"
                className="w-full rounded-md border bg-transparent px-2 py-1 text-xs outline-none"
                style={{ borderColor: "var(--border)" }}
              />
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="slug（留空自动生成）"
                className="w-full rounded-md border bg-transparent px-2 py-1 text-xs outline-none"
                style={{ borderColor: "var(--border)" }}
              />
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="学习目标（可选）"
                rows={2}
                className="w-full resize-none rounded-md border bg-transparent px-2 py-1 text-xs outline-none"
                style={{ borderColor: "var(--border)" }}
              />
              {formError && <p className="text-[11px] text-red-500">{formError}</p>}
              <div className="flex gap-1.5">
                <button
                  onClick={() => void submitSubject()}
                  disabled={creating}
                  className="flex flex-1 items-center justify-center gap-1 rounded-md bg-brand px-2 py-1 text-xs text-white hover:bg-brand-light disabled:opacity-50"
                >
                  {creating && <Loader2 className="h-3 w-3 animate-spin" />}
                  创建
                </button>
                <button
                  onClick={() => {
                    setShowSubjectForm(false);
                    resetForm();
                  }}
                  className="rounded-md px-2 py-1 text-xs hover:bg-[var(--muted)]"
                >
                  取消
                </button>
              </div>
              <button
                onClick={openWizard}
                className="text-left text-[11px] text-brand-light hover:underline"
              >
                不想手填？用 AI 向导生成科目 →
              </button>
            </div>
          )}

          <div className="flex flex-col gap-0.5">
            {subjects.length === 0 && (
              <p className="px-2 py-1 text-xs opacity-40">暂无科目</p>
            )}
            {subjects.map((s) => (
              <button
                key={s.slug}
                onClick={() => router.push(`/courses?subject=${encodeURIComponent(s.slug)}`)}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-[var(--muted)]"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: STATUS_DOT[s.status] ?? "#9aa5a1" }}
                  title={s.status}
                />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 底栏：主题切换 + 设置 */}
      <div className="border-t px-3 py-3" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleTheme}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--muted)]"
            title={theme === "dark" ? "切换到亮色模式" : "切换到暗夜模式"}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <Link
            href="/settings"
            className={clsx(
              "flex flex-1 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              pathname.startsWith("/settings") ? "bg-brand text-white" : "hover:bg-[var(--muted)]",
            )}
          >
            <Settings className="h-4 w-4" />
            设置
          </Link>
        </div>
        <div className="px-2 pt-2 text-xs opacity-50">
          v{pkg.version} · learn with doing
        </div>
      </div>
    </aside>
  );
}
