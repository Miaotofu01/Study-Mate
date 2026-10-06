"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, FolderOpen, Loader2, Save } from "lucide-react";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import type { WorkspaceInfo } from "@/lib/types";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-xs">
      <span className="shrink-0 pt-0.5 opacity-50">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

export function WorkspaceView() {
  const { refreshWorkspaceCandidates } = useWorkspace();
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  // 回填只发生在首次加载：并发/手动刷新的 load 不得覆盖用户正在编辑的输入
  const initializedRef = useRef(false);
  // 请求序号：过期响应（更早发出的 GET）不得覆盖更新的 info
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const data = await api.getWorkspace();
      if (requestId !== requestRef.current) return;
      setInfo(data);
      if (!initializedRef.current) {
        initializedRef.current = true;
        setInput(data.path);
      }
      setLoadError(null);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const path = input.trim();
    if (!path) {
      setSaveError("请填写目录的绝对路径");
      return;
    }
    if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/|~[\\/])/.test(path)) {
      setSaveError("请填写绝对路径，例如 D:\\StudyMate 或 /home/you/StudyMate");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSavedPath(null);
    try {
      requestRef.current += 1; // 使在飞的 GET 失效，避免旧响应覆盖刚保存的结果
      // PUT 成功即返回新工作区的完整信息（后端已热生效，无需重启）
      const data = await api.updateWorkspace(path);
      setInfo(data);
      setInput(data.path);
      setSavedPath(data.path);
      // 让会话关联行等处的候选工作区跟上新路径（候选只在 Provider 挂载时取一次）
      void refreshWorkspaceCandidates();
      window.setTimeout(() => setSavedPath(null), 6000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <div className="h-full px-6 py-8">
        <div className="mx-auto flex max-w-2xl items-start gap-3 rounded-xl border border-red-300/50 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="break-all">加载工作区信息失败：{loadError}</p>
            <button
              onClick={() => void load()}
              className="mt-2 rounded-lg border px-3 py-1.5 text-xs"
              style={{ borderColor: "var(--border)" }}
            >
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin opacity-50" />
      </div>
    );
  }

  return (
    <div className="h-full px-6 py-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-1 text-xl font-semibold">工作区</h1>
        <p className="mb-6 text-sm opacity-60">
          工作区与插件共用同一目录与发现规则；修改会写入 studymate-config.yaml 的 workspace 字段。
        </p>

        <section className="rounded-2xl border p-5" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 shrink-0 text-brand" />
            <span className="text-sm font-semibold">当前工作区</span>
            {info.exists ? null : (
              <span
                className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400"
                title="目录尚未创建，后端会在下次写入资料时自动建立"
              >
                目录不存在
              </span>
            )}
          </div>

          <div className="mt-4 flex flex-col gap-2.5">
            <Row label="路径">
              <span
                data-testid="workspace-path"
                className="break-all font-mono text-brand"
                title={info.path}
              >
                {info.path}
              </span>
            </Row>
            <Row label="来源">
              <span data-testid="workspace-source" className="break-all opacity-80">
                {info.source}
              </span>
            </Row>
            <Row label="科目目录">
              <span className="break-all font-mono opacity-80" title={info.subjects_dir}>
                {info.subjects_dir}
              </span>
            </Row>
            <Row label="配置文件">
              <span className="break-all font-mono opacity-80" title={info.config_path}>
                {info.config_path}
              </span>
            </Row>
            <Row label="科目数">
              <span data-testid="workspace-subject-count">{info.subject_count} 门</span>
            </Row>
          </div>
        </section>

        <section
          className="mt-4 rounded-2xl border p-5"
          style={{ borderColor: "var(--border)" }}
        >
          <h2 className="mb-1 text-sm font-semibold">切换工作区</h2>
          <p className="mb-3 text-xs opacity-60">
            填写新的目录绝对路径；新工作区下还没有科目时会从零开始。保存后立即对所有科目与文件读写生效。
          </p>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            placeholder="例如 D:\StudyMate 或 /home/you/StudyMate"
            aria-label="工作区目录绝对路径"
            data-testid="workspace-input"
            className="w-full rounded-lg border bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-brand-light"
            style={{ borderColor: "var(--border)" }}
          />

          {saveError && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-300/50 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-all">{saveError}</span>
            </div>
          )}
          {savedPath && (
            <div
              data-testid="workspace-saved"
              className="mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-xs"
              style={{ background: "rgb(var(--brand-rgb) / 0.08)" }}
            >
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
              <span className="min-w-0 flex-1 break-all">
                已切换到 {savedPath}，立即生效（无需重启）
              </span>
            </div>
          )}

          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={() => void save()}
              disabled={saving || input.trim().length === 0}
              data-testid="workspace-save"
              className="flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:bg-brand-light disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              保存
            </button>
            <button
              onClick={() => void load()}
              disabled={saving}
              className="rounded-xl border px-3.5 py-2.5 text-sm opacity-70 transition-colors hover:bg-[var(--muted)] hover:opacity-100 disabled:opacity-50"
              style={{ borderColor: "var(--border)" }}
            >
              重新载入
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
