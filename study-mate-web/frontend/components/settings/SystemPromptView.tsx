"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Undo2 } from "lucide-react";
import { api } from "@/lib/api";
import type { AppSettings } from "@/lib/types";

// 与后端 config.py DEFAULT_SETTINGS.system_prompt 保持一致
export const DEFAULT_SYSTEM_PROMPT =
  "你是 StudyMate 自学系统的主教练（学习模式），按 learning-system 技能规范调度学习流程。" +
  "坚持 learn with doing：讲清概念后引导学习者动手练习，用通俗的语言和具体的例子解释知识。";

export function SystemPromptView() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [value, setValue] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        setValue(s.system_prompt);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveSettings({
        providers: settings.providers,
        active: settings.active,
        system_prompt: value,
      });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <div className="h-full px-6 py-8">
        <div className="mx-auto max-w-2xl rounded-xl border border-red-300/50 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          加载设置失败：{loadError}
        </div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin opacity-50" />
      </div>
    );
  }

  const changed = value !== settings.system_prompt;

  return (
    <div className="h-full px-6 py-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-1 text-xl font-semibold">系统提示词</h1>
        <p className="mb-6 text-sm opacity-60">
          独立于提供商的全局配置，保存后对所有聊天与评估调用立即生效。
        </p>

        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={12}
          className="w-full resize-y rounded-xl border bg-transparent px-4 py-3 text-sm leading-relaxed outline-none focus:border-brand-light"
          style={{ borderColor: "var(--border)" }}
        />

        {saveError && (
          <div className="mt-3 rounded-xl border border-red-300/50 bg-red-500/10 px-4 py-2.5 text-xs text-red-600 dark:text-red-400">
            {saveError}
          </div>
        )}

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={() => void save()}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:bg-brand-light disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
            {saved ? "已保存" : "保存"}
          </button>
          <button
            onClick={() => setValue(DEFAULT_SYSTEM_PROMPT)}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-xl border px-3.5 py-2.5 text-sm opacity-70 transition-colors hover:bg-[var(--muted)] hover:opacity-100 disabled:opacity-50"
            style={{ borderColor: "var(--border)" }}
          >
            <Undo2 className="h-4 w-4" />
            恢复默认
          </button>
          {changed && !saved && <span className="text-xs opacity-50">有未保存的修改</span>}
        </div>
      </div>
    </div>
  );
}
