"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ChevronDown, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { ActiveProvider, AppSettings, ProviderModel, SessionActive } from "@/lib/types";

const isUsableProvider = (p: { enabled?: boolean }) => p.enabled !== false;
const isUsableModel = (m: { enabled?: boolean }) => m.enabled !== false;

/** 某模型的默认推理档位；reasoning 未启用时为 null */
export function modelVariant(model: ProviderModel | null): string | null {
  const reasoning = model?.reasoning;
  if (!reasoning?.enabled) return null;
  return reasoning.default_variant ?? null;
}

/** 模型的可选推理档位列表；reasoning 未启用时为空 */
export function modelVariants(model: ProviderModel | null): string[] {
  const reasoning = model?.reasoning;
  if (!reasoning?.enabled) return [];
  return (reasoning.variants ?? []).filter((item) => item.trim().length > 0);
}

/** 当前 active 配置指向的那个模型；提供商或模型没配好时为 null。
 *  传入 active 可查"会话绑定的那个模型"而不是全局默认。 */
export function activeModelOf(
  settings: AppSettings,
  active: ActiveProvider = settings.active,
): ProviderModel | null {
  const entry = settings.providers.find((p) => p.id === active.provider_id) ?? null;
  return entry?.models.find((m) => m.name === active.model) ?? null;
}

/**
 * 真正生效的三元组：会话绑定**完全可用**时用它，否则回落到全局默认。
 * 判据与后端 `config.get_session_provider` 对齐（提供商存在且启用、模型仍在模型表里）；
 * 绑定失效（提供商被删/停用、模型被移除）时前端如实显示回落后的默认模型，
 * 而不是拿失效绑定去禁用输入（后端本会回落并给提示）。
 */
export function effectiveActiveOf(
  settings: AppSettings | null,
  sessionActive: SessionActive | null | undefined,
): ActiveProvider | null {
  if (!settings) return sessionActive ?? null;
  if (sessionActive) {
    const entry = settings.providers.find((p) => p.id === sessionActive.provider_id);
    if (
      entry &&
      entry.enabled !== false &&
      entry.models.some((m) => m.name === sessionActive.model)
    ) {
      return sessionActive;
    }
  }
  return settings.active;
}

interface ModelSelectorProps {
  settings: AppSettings | null;
  onUpdated: (settings: AppSettings) => void;
  /** 会话态：会话绑定的模型三元组（null/undefined = 跟随全局默认） */
  sessionId?: string | null;
  sessionActive?: SessionActive | null;
  /** 会话内切换模型后回灌本地状态（写的是会话绑定，不动全局默认） */
  onSessionActiveChange?: (active: SessionActive) => void;
}

export function ModelSelector({
  settings,
  onUpdated,
  sessionId = null,
  sessionActive = null,
  onSessionActiveChange,
}: ModelSelectorProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!settings || settings.providers.length === 0) {
    return (
      <button
        onClick={() => router.push("/settings/providers")}
        className="shrink-0 rounded-lg border px-2.5 py-1 text-xs opacity-70 hover:bg-[var(--muted)] hover:opacity-100"
        style={{ borderColor: "var(--border)" }}
        title="尚未配置模型提供商，点击前往设置"
      >
        未配置
      </button>
    );
  }

  // 生效的三元组：会话绑定可用优先，绑定失效（提供商被删/停用、模型被移除）则回落全局默认
  const effective: ActiveProvider = effectiveActiveOf(settings, sessionActive) ?? settings.active;
  const activeEntry =
    settings.providers.find((p) => p.id === effective.provider_id) ?? null;
  const label = activeEntry
    ? `${activeEntry.name} / ${effective.model || "未选模型"}`
    : "未选择模型";

  const activeModel: ProviderModel | null = activeModelOf(settings, effective);

  const save = async (active: ActiveProvider) => {
    setOpen(false);
    setSwitching(true);
    setError(null);
    // 会话内切换：只改这个会话的绑定（全局默认留给新对话）；否则改全局默认
    if (sessionId && onSessionActiveChange) {
      try {
        await api.setSessionActive(sessionId, active);
        onSessionActiveChange(active);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSwitching(false);
      }
      return;
    }
    try {
      await api.saveSettings({
        providers: settings.providers,
        active,
        system_prompt: settings.system_prompt,
      });
      onUpdated({ ...settings, active });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(false);
    }
  };

  const pick = (providerId: string, model: ProviderModel) => {
    if (effective.provider_id === providerId && effective.model === model.name) {
      setOpen(false);
      return;
    }
    void save({
      provider_id: providerId,
      model: model.name,
      reasoning_variant: modelVariant(model),
    });
  };

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-[14rem] items-center gap-1 rounded-lg border px-2.5 py-1 text-xs hover:bg-[var(--muted)]"
        style={{ borderColor: "var(--border)" }}
        title="切换当前使用的提供商 / 模型"
      >
        <span className="min-w-0 truncate">{label}</span>
        {switching ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 z-40 mt-1.5 max-h-80 w-64 overflow-y-auto rounded-xl border shadow-lg"
            style={{ borderColor: "var(--border)", background: "var(--background)" }}
          >
            {error && (
              <p className="border-b border-red-300/50 bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            {settings.providers.filter(isUsableProvider).map((p) => (
              <div key={p.id} className="py-1">
                <div className="flex items-center justify-between px-3 py-1 text-[11px] font-medium opacity-50">
                  <span className="truncate">{p.name}</span>
                  {!p.has_key && <span className="shrink-0">未设 API Key</span>}
                </div>
                {p.models.filter(isUsableModel).length === 0 && (
                  <p className="px-3 py-1 text-[11px] opacity-40">无模型</p>
                )}
                {p.models.filter(isUsableModel).map((m) => {
                  const current = p.id === effective.provider_id && m.name === effective.model;
                  return (
                    <button
                      key={m.name}
                      onClick={() => pick(p.id, m)}
                      className={clsx(
                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors",
                        current ? "bg-brand/10 text-brand" : "hover:bg-[var(--muted)]",
                      )}
                    >
                      <span className="min-w-0 truncate">{m.display_name || m.name}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {m.modalities?.image && <span className="text-[10px] opacity-60">视觉</span>}
                        {m.reasoning?.enabled && (
                          <span className="text-[10px] opacity-60">思考</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
            {settings.providers.filter(isUsableProvider).length === 0 && (
              <p className="px-3 py-2 text-[11px] opacity-40">没有已启用的提供商</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
