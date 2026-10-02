"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { Brain, ChevronDown, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { ActiveProvider, AppSettings, ProviderModel } from "@/lib/types";

const isUsableProvider = (p: { enabled?: boolean }) => p.enabled !== false;
const isUsableModel = (m: { enabled?: boolean }) => m.enabled !== false;

function modelVariant(model: ProviderModel | null): string | null {
  const reasoning = model?.reasoning;
  if (!reasoning?.enabled) return null;
  return reasoning.default_variant ?? null;
}

function modelVariants(model: ProviderModel | null): string[] {
  const reasoning = model?.reasoning;
  if (!reasoning?.enabled) return [];
  return (reasoning.variants ?? []).filter((item) => item.trim().length > 0);
}

interface ModelSelectorProps {
  settings: AppSettings | null;
  onUpdated: (settings: AppSettings) => void;
}

export function ModelSelector({ settings, onUpdated }: ModelSelectorProps) {
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

  const activeEntry =
    settings.providers.find((p) => p.id === settings.active.provider_id) ?? null;
  const label = activeEntry
    ? `${activeEntry.name} / ${settings.active.model || "未选模型"}`
    : "未选择模型";

  const activeModel: ProviderModel | null =
    activeEntry?.models.find((m) => m.name === settings.active.model) ?? null;
  const variants = modelVariants(activeModel);
  const activeVariant: string | null =
    settings.active.reasoning_variant || modelVariant(activeModel);

  const save = async (active: ActiveProvider) => {
    setOpen(false);
    setSwitching(true);
    setError(null);
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
    if (settings.active.provider_id === providerId && settings.active.model === model.name) {
      setOpen(false);
      return;
    }
    void save({
      provider_id: providerId,
      model: model.name,
      reasoning_variant: modelVariant(model),
    });
  };

  const setVariant = (variant: string) => {
    if (!settings.active.provider_id || variant === activeVariant) {
      setOpen(false);
      return;
    }
    void save({ ...settings.active, reasoning_variant: variant });
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
                  const current = p.id === settings.active.provider_id && m.name === settings.active.model;
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

            {variants.length > 0 && (
              <div className="border-t px-3 py-2" style={{ borderColor: "var(--border)" }}>
                <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium opacity-50">
                  <Brain className="h-3 w-3" />
                  思考档位
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {variants.map((variant) => (
                    <button
                      key={variant}
                      onClick={() => setVariant(variant)}
                      aria-pressed={activeVariant === variant}
                      data-reasoning-variant={variant}
                      className={clsx(
                        "rounded-md px-1.5 py-1 text-[11px] transition-colors",
                        activeVariant === variant
                          ? "bg-brand text-white"
                          : "border hover:bg-[var(--muted)]",
                      )}
                      style={activeVariant === variant ? undefined : { borderColor: "var(--border)" }}
                      title={`思考档位：${variant}`}
                    >
                      {variant}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
