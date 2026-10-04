"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, FolderOpen, Loader2, Save } from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import type { WorkspaceInfo } from "@/lib/types";

interface WorkspaceOnboardingProps {
  /** 切换成功后回调：刷新 useWorkspace() 的工作区上下文，并由外层给出反馈（本块可能因科目恢复而卸载） */
  onSwitched: (path: string) => void | Promise<void>;
}

/**
 * 新会话态的学习工作区引导块：当前工作区还没有科目时出现在欢迎区下方。
 *
 * 数据在挂载时拉一次 GET /api/workspace（含 candidates），不污染 useWorkspace() 的既有加载逻辑；
 * 切换走 PUT /api/workspace（后端即时生效），成功后由 onSwitched 刷新科目列表与当前路径。
 * 已有科目时外层不渲染本组件，避免干扰正常用户。
 */
export function WorkspaceOnboarding({ onSwitched }: WorkspaceOnboardingProps) {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 当前生效/选中项：初始为当前路径，切换成功后随 PUT 返回更新
  const [selected, setSelected] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 请求序号：过期响应（更早发出的 GET）不得覆盖更新的 info
  const requestRef = useRef(0);
  // 本次会话内用过的路径：切走后配置里的旧值会被覆盖，candidates 不再包含它，靠这里兜住"切回去"
  const visitedRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const data = await api.getWorkspace();
      if (requestId !== requestRef.current) return;
      visitedRef.current.add(data.path);
      setInfo(data);
      setSelected(data.path);
      setLoadError(null);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const candidates = useMemo(() => {
    const list = [...(info?.candidates ?? [])];
    for (const path of visitedRef.current) {
      if (!list.includes(path)) list.push(path);
    }
    return list;
  }, [info]);

  /** 切换工作区：候选点选与手输共用；成功后刷新工作区上下文并由外层给反馈 */
  const switchTo = async (path: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      if (info?.path) visitedRef.current.add(info.path);
      requestRef.current += 1; // 使在飞的 GET 失效，避免旧响应覆盖刚保存的结果
      const data = await api.updateWorkspace(path);
      visitedRef.current.add(data.path);
      setInfo(data);
      setSelected(data.path);
      setInput(data.path);
      await onSwitched(data.path);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSelected(info?.path ?? null);
    } finally {
      setSaving(false);
    }
  };

  /** 输入框路径校验（与设置页同一套口径） */
  const submitInput = async () => {
    const path = input.trim();
    if (!path) {
      setSaveError("请填写目录的绝对路径");
      return;
    }
    if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/|~[\\/])/.test(path)) {
      setSaveError("请填写绝对路径，例如 D:\\StudyMate 或 /home/you/StudyMate");
      return;
    }
    await switchTo(path);
  };

  return (
    <section
      data-testid="workspace-onboarding"
      className="mx-auto mt-2 w-full max-w-2xl rounded-2xl border p-5 text-left"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex items-center gap-2">
        <FolderOpen className="h-4 w-4 shrink-0 text-brand" />
        <span className="text-sm font-semibold">选择学习工作区</span>
      </div>

      {!info && !loadError && (
        <div className="flex items-center gap-1.5 py-6 text-xs opacity-60">
          <Loader2 className="h-3.5 w-3.5 animate-spin opacity-50" />
          正在读取工作区…
        </div>
      )}

      {loadError && (
        <div className="mt-3 flex flex-col items-start gap-2">
          <div className="flex w-full items-start gap-2 rounded-xl border border-red-300/50 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-all">读取工作区信息失败：{loadError}</span>
          </div>
          <button
            onClick={() => void load()}
            className="rounded-lg border px-3 py-1.5 text-xs hover:bg-[var(--muted)]"
            style={{ borderColor: "var(--border)" }}
          >
            重试
          </button>
        </div>
      )}

      {info && (
        <>
          <p className="mt-2 text-xs opacity-60">
            当前工作区（
            <span className="break-all font-mono text-brand" title={info.path}>
              {info.path}
            </span>
            ）还没有科目。可以换一个已有工作区目录，或保持默认后去创建课程。
          </p>

          {candidates.map((candidate) => {
            const isCurrent = candidate === info.path;
            const isSelected = selected === candidate;
            return (
              <button
                key={candidate}
                type="button"
                onClick={() => void switchTo(candidate)}
                disabled={saving}
                aria-pressed={isSelected}
                data-testid="workspace-candidate"
                data-current={isCurrent ? "true" : undefined}
                className={clsx(
                  "mt-2 flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-[var(--muted)] disabled:opacity-50",
                  isSelected && "border-brand bg-brand/10",
                )}
                style={isSelected ? undefined : { borderColor: "var(--border)" }}
                title={`切换到 ${candidate}`}
              >
                <span className="min-w-0 flex-1 break-all font-mono">{candidate}</span>
                {isCurrent && (
                  <span className="shrink-0 rounded bg-brand/15 px-1.5 py-0.5 text-[10px] font-medium text-brand">
                    当前
                  </span>
                )}
              </button>
            );
          })}

          <div className="mt-3 flex items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitInput();
              }}
              placeholder="手输目录绝对路径，例如 D:\\StudyMate"
              aria-label="学习工作区目录绝对路径"
              data-testid="workspace-onboarding-input"
              className="min-w-0 flex-1 rounded-lg border bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus:border-brand-light"
              style={{ borderColor: "var(--border)" }}
            />
            <button
              onClick={() => void submitInput()}
              disabled={saving || input.trim().length === 0}
              data-testid="workspace-onboarding-save"
              className="flex shrink-0 items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:bg-brand-light disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              切换
            </button>
          </div>

          {saveError && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-300/50 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-all">{saveError}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
