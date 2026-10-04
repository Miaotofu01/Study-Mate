"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  Cable,
  Check,
  Eye,
  EyeOff,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Undo2,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
  ActiveProvider,
  ApiFormat,
  AppSettings,
  ProviderEntry,
  ProviderKind,
  ProviderModel,
} from "@/lib/types";
import { EnableSwitch, ModelEditDialog } from "./ModelEditDialog";

export const PROVIDER_PRESETS = [
  { key: "deepseek", name: "DeepSeek", base_url: "https://api.deepseek.com", model: "deepseek-chat" },
  { key: "siliconflow", name: "SiliconFlow", base_url: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
  { key: "dashscope", name: "DashScope", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { key: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
] as const;

const API_FORMAT_LABEL: Record<ApiFormat, string> = {
  openai_chat: "OpenAI 兼容 Chat Completions",
  openai_responses: "OpenAI Responses",
  anthropic: "Anthropic Messages",
};

const API_FORMAT_BADGE: Record<ApiFormat, { label: string; className: string }> = {
  openai_chat: { label: "Chat", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  openai_responses: { label: "Responses", className: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  anthropic: { label: "Anthropic", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
};

interface ProviderDraft {
  id: string;
  kind: ProviderKind;
  preset_key: string | null;
  name: string;
  base_url: string;
  api_key: string;
  api_format: ApiFormat;
  models: ProviderModel[];
  has_key: boolean;
  created_at: string;
  isNew: boolean;
  enabled: boolean;
}

interface ModelTestState {
  status: "pending" | "ok" | "error";
  latency_ms?: number;
  message?: string;
}

function defaultModel(name: string): ProviderModel {
  return {
    name,
    display_name: "",
    modalities: null,
    context_window: null,
    max_output_tokens: null,
    reasoning: null,
    // 工具调用默认对所有模型开启（2026-10-04）
    capabilities: { tool_call: true, json_schema_output: false, native_web_search: false },
    enabled: true,
  };
}

function modelVariant(model: ProviderModel | null | undefined): string | null {
  const reasoning = model?.reasoning;
  if (!reasoning?.enabled) return null;
  return reasoning.default_variant ?? null;
}

function normalizeModel(model: ProviderModel): ProviderModel {
  const reasoning = model.reasoning;
  return {
    name: model.name,
    display_name: model.display_name ?? "",
    modalities: model.modalities ?? null,
    context_window: model.context_window ?? null,
    max_output_tokens: model.max_output_tokens ?? null,
    reasoning: reasoning
      ? {
          enabled: reasoning.enabled ?? false,
          variants: (reasoning.variants ?? []).map((item) => String(item)),
          default_variant: reasoning.default_variant ?? null,
        }
      : null,
    capabilities: model.capabilities
      ? {
          tool_call: model.capabilities.tool_call ?? true,
          json_schema_output: model.capabilities.json_schema_output ?? false,
          native_web_search: model.capabilities.native_web_search ?? false,
        }
      : null,
    enabled: model.enabled ?? true,
  };
}

function toDraft(entry: ProviderEntry, isNew: boolean): ProviderDraft {
  return {
    id: entry.id,
    kind: entry.kind,
    preset_key: entry.preset_key,
    name: entry.name,
    base_url: entry.base_url,
    api_key: entry.api_key,
    api_format: entry.api_format,
    models: entry.models.map(normalizeModel),
    has_key: entry.has_key,
    created_at: entry.created_at,
    isNew,
    enabled: entry.enabled ?? true,
  };
}

function activeForProvider(provider: ProviderEntry): ActiveProvider {
  const model =
    provider.models.find((m) => m.enabled ?? true) ?? provider.models[0] ?? null;
  return {
    provider_id: provider.id,
    model: model?.name ?? "",
    reasoning_variant: modelVariant(model),
  };
}

function newProviderId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanModels(models: ProviderModel[]): ProviderModel[] {
  return models
    .map((m) => normalizeModel({ ...m, name: m.name.trim() }))
    .filter((m) => m.name.length > 0);
}

function formatContextWindow(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function FormatBadge({ format }: { format: ApiFormat }) {
  const badge = API_FORMAT_BADGE[format];
  return (
    <span
      className={clsx("rounded px-1.5 py-0.5 text-[10px] font-medium", badge.className)}
      title={API_FORMAT_LABEL[format]}
    >
      {badge.label}
    </span>
  );
}

function ModelBadge({
  children,
  title,
  testId,
}: {
  children: React.ReactNode;
  title?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] opacity-70"
      title={title}
    >
      {children}
    </span>
  );
}

export function ProvidersView() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  // 实时生效：所有编辑走防抖落盘，状态只用于头部反馈（无需「保存」按钮）
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [modelTests, setModelTests] = useState<Record<number, ModelTestState>>({});

  // 防抖落盘要读最新值：state 在事件回调里可能还是旧的，统一用 ref 兜住
  const settingsRef = useRef<AppSettings | null>(null);
  settingsRef.current = settings;
  const draftRef = useRef<ProviderDraft | null>(null);
  draftRef.current = draft;
  const apiKeyRef = useRef("");
  apiKeyRef.current = apiKeyInput;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFlashRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashSaved = useCallback(() => {
    setSaveState("saved");
    if (savedFlashRef.current) clearTimeout(savedFlashRef.current);
    savedFlashRef.current = setTimeout(() => setSaveState("idle"), 1600);
  }, []);

  const clearEditorState = useCallback(() => {
    setMenuOpen(false);
    setEditingIndex(null);
    setModelTests({});
    setShowApiKey(false);
  }, []);

  const load = useCallback(
    async (preferId?: string) => {
      try {
        const s = await api.getSettings();
        setSettings(s);
        setLoadError(null);
        const target = preferId || s.active.provider_id || s.providers[0]?.id || null;
        const entry = s.providers.find((p) => p.id === target) ?? s.providers[0] ?? null;
        setSelectedId(entry?.id ?? null);
        setDraft(entry ? toDraft(entry, false) : null);
        setApiKeyInput(entry?.api_key ?? "");
        clearEditorState();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    },
    [clearEditorState],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 即时落盘：把当前（或显式传入的）草稿合并进 providers 后 PUT。
   * 不回读 settings，避免把用户正在输入的内容冲掉；本地状态即权威。
   */
  const saveDraft = useCallback(
    async (
      opts: { draftOverride?: ProviderDraft; active?: ActiveProvider; apiKey?: string } = {},
    ): Promise<boolean> => {
      const current = opts.draftOverride ?? draftRef.current;
      const s = settingsRef.current;
      if (!current || !s) return true;
      if (!current.name.trim()) {
        setActionError("请填写提供商名称");
        return false;
      }
      const key = opts.apiKey ?? apiKeyRef.current;
      const cleaned = cleanModels(current.models);
      let providers = s.providers;
      let active = opts.active ?? s.active;
      const entry: ProviderEntry = {
        id: current.id,
        name: current.name.trim(),
        kind: current.kind,
        preset_key: current.preset_key,
        base_url: current.base_url.trim(),
        api_key: key || current.api_key,
        has_key: current.has_key || key.length > 0,
        api_format: current.api_format,
        models: cleaned,
        created_at: current.created_at,
        enabled: current.enabled,
      };
      providers = current.isNew
        ? [...providers.filter((p) => p.id !== current.id), entry]
        : providers.map((p) => (p.id === current.id ? entry : p));
      // 当前使用中的模型被删掉时顺延到该提供商的第一个模型（没有则回退到其它可用提供商）
      if (active.provider_id === current.id && !cleaned.some((m) => m.name === active.model)) {
        if (cleaned.length > 0) {
          active = {
            provider_id: current.id,
            model: cleaned[0].name,
            reasoning_variant: modelVariant(cleaned[0]),
          };
        } else {
          const fallback = providers.find(
            (p) =>
              p.id !== current.id &&
              (p.enabled ?? true) &&
              p.models.some((m) => m.enabled ?? true),
          );
          active = fallback ? activeForProvider(fallback) : { provider_id: "", model: "" };
        }
      }
      setSettings((prev) => (prev ? { ...prev, providers, active } : prev));
      setActionError(null);
      setSaveState("saving");
      try {
        await api.saveSettings({ providers, active, system_prompt: s.system_prompt });
        flashSaved();
        return true;
      } catch (err) {
        setSaveState("idle");
        setActionError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [flashSaved],
  );

  // 防抖落盘：编辑期间合并请求；切换提供商 / 卸载前用 flushSave 立即落盘
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void saveDraft();
    }, 500);
  }, [saveDraft]);

  const flushSave = useCallback(async (): Promise<boolean> => {
    if (!saveTimerRef.current) return true;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    return saveDraft();
  }, [saveDraft]);

  // 卸载（含切页）时把挂起的防抖改动落盘
  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        void saveDraft();
      }
      if (savedFlashRef.current) clearTimeout(savedFlashRef.current);
    },
    [saveDraft],
  );

  const selectProvider = async (id: string) => {
    if (!adding && id === selectedId) return;
    await flushSave();
    clearEditorState();
    setAdding(false);
    setActionError(null);
    const entry = settingsRef.current?.providers.find((p) => p.id === id) ?? null;
    setSelectedId(entry ? id : null);
    setDraft(entry ? toDraft(entry, false) : null);
    setApiKeyInput(entry?.api_key ?? "");
  };

  const openAdd = async () => {
    if (adding) return;
    await flushSave();
    clearEditorState();
    setActionError(null);
    setAdding(true);
  };

  const createProvider = (presetKey: string) => {
    if (!settings) return;
    const id = newProviderId();
    const now = new Date().toISOString();
    let entry: ProviderEntry;
    if (presetKey === "custom") {
      entry = {
        id,
        name: "自定义提供商",
        kind: "custom",
        preset_key: null,
        base_url: "",
        api_key: "",
        has_key: false,
        api_format: "openai_chat",
        models: [],
        created_at: now,
        enabled: true,
      };
    } else {
      const preset = PROVIDER_PRESETS.find((p) => p.key === presetKey);
      if (!preset) return;
      entry = {
        id,
        name: preset.name,
        kind: "preset",
        preset_key: preset.key,
        base_url: preset.base_url,
        api_key: "",
        has_key: false,
        api_format: "openai_chat",
        models: [defaultModel(preset.model)],
        created_at: now,
        enabled: true,
      };
    }
    setSettings((s) => (s ? { ...s, providers: [...s.providers, entry] } : s));
    clearEditorState();
    setAdding(false);
    setSelectedId(id);
    const nextDraft = toDraft(entry, true);
    setDraft(nextDraft);
    setApiKeyInput("");
    setActionError(null);
    // 新提供商立即落盘（否则切换后本地状态与磁盘不一致）
    void saveDraft({ draftOverride: nextDraft, apiKey: "" });
  };

  const updateDraft = (patch: Partial<ProviderDraft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    scheduleSave();
  };

  const updateModels = (fn: (models: ProviderModel[]) => ProviderModel[]) => {
    setDraft((d) => (d ? { ...d, models: fn(d.models) } : d));
    setModelTests({});
    scheduleSave();
  };

  const updateModel = (index: number, patch: Partial<ProviderModel>) => {
    updateModels((models) =>
      models.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    );
  };

  const openModelDialog = () => {
    if (!draft) return;
    const emptyIndex = draft.models.findIndex((m) => !m.name.trim());
    if (emptyIndex >= 0) {
      setEditingIndex(emptyIndex);
      return;
    }
    const next = defaultModel("");
    const index = draft.models.length;
    setDraft((d) => (d ? { ...d, models: [...d.models, next] } : d));
    setModelTests({});
    setEditingIndex(index);
  };

  const saveModel = (model: ProviderModel) => {
    const index = editingIndex;
    setEditingIndex(null);
    if (index === null) return;
    updateModels((models) => models.map((m, i) => (i === index ? normalizeModel(model) : m)));
  };

  const cancelModelEdit = () => {
    const index = editingIndex;
    const models = draft?.models ?? [];
    setEditingIndex(null);
    if (index === null) return;
    if (!models[index]?.name.trim()) {
      updateModels((list) => list.filter((_, i) => i !== index));
    }
  };

  const restoreDefault = () => {
    if (!draft?.preset_key) return;
    const preset = PROVIDER_PRESETS.find((p) => p.key === draft.preset_key);
    if (!preset) return;
    const nextDraft: ProviderDraft = {
      ...draft,
      base_url: preset.base_url,
      models: [defaultModel(preset.model)],
    };
    setDraft(nextDraft);
    setMenuOpen(false);
    void saveDraft({ draftOverride: nextDraft });
  };

  const activate = async () => {
    if (!draft || !settings) return;
    if (!draft.enabled) {
      setActionError("提供商已停用，请先启用再设为当前使用");
      return;
    }
    const cleaned = cleanModels(draft.models);
    if (cleaned.length === 0) {
      setActionError("至少有一个模型名称才能设为当前使用");
      return;
    }
    const usable = cleaned.filter((m) => m.enabled ?? true);
    const pool = usable.length > 0 ? usable : cleaned;
    const keepActive =
      settings.active.provider_id === draft.id &&
      pool.some((m) => m.name === settings.active.model);
    const target =
      (keepActive ? pool.find((m) => m.name === settings.active.model) : undefined) ?? pool[0];
    const variant =
      (keepActive ? settings.active.reasoning_variant : undefined) ?? modelVariant(target);
    // 同时把草稿里最新编辑过的模型一并落盘
    await saveDraft({
      active: { provider_id: draft.id, model: target.name, reasoning_variant: variant },
    });
    setMenuOpen(false);
  };

  const toggleProviderEnabled = () => {
    if (!draft || !settings) return;
    const nextEnabled = !draft.enabled;
    let active = settings.active;
    if (!nextEnabled && active.provider_id === draft.id) {
      const fallback = settings.providers.find(
        (p) => p.id !== draft.id && (p.enabled ?? true),
      );
      active = fallback ? activeForProvider(fallback) : { provider_id: "", model: "" };
    }
    const nextDraft = { ...draft, enabled: nextEnabled };
    setDraft(nextDraft);
    void saveDraft({ active, draftOverride: nextDraft });
  };

  const deleteProvider = async () => {
    if (!draft || draft.kind !== "custom" || !settings) return;
    if (!window.confirm(`删除提供商「${draft.name || "未命名"}」？此操作不可撤销。`)) return;
    setMenuOpen(false);
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setActionError(null);
    setSaveState("saving");
    try {
      const providers = settings.providers.filter((p) => p.id !== draft.id);
      let active = settings.active;
      if (active.provider_id === draft.id) {
        const next = providers.find((p) => (p.enabled ?? true));
        active = next ? activeForProvider(next) : { provider_id: "", model: "" };
      }
      await api.saveSettings({ providers, active, system_prompt: settings.system_prompt });
      setSelectedId(null);
      setDraft(null);
      setApiKeyInput("");
      clearEditorState();
      await load();
      flashSaved();
    } catch (err) {
      setSaveState("idle");
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const runModelTest = async (index: number, model: ProviderModel) => {
    if (!draft) return;
    if (!draft.base_url.trim()) {
      setModelTests((s) => ({ ...s, [index]: { status: "error", message: "请先填写 Base URL" } }));
      return;
    }
    setModelTests((s) => ({ ...s, [index]: { status: "pending" } }));
    try {
      const res = await api.testConnection({
        base_url: draft.base_url.trim(),
        api_key: apiKeyInput,
        api_format: draft.api_format,
        model: model.name,
        provider_id: draft.id,
      });
      setModelTests((s) => ({ ...s, [index]: { status: "ok", latency_ms: res.latency_ms } }));
    } catch (err) {
      setModelTests((s) => ({
        ...s,
        [index]: { status: "error", message: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  if (loadError) {
    return (
      <div className="h-full px-6 py-8">
        <div className="mx-auto flex max-w-4xl items-start gap-2 rounded-xl border border-red-300/50 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
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

  const filtered = settings.providers.filter((p) =>
    p.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const isActive = (id: string) => settings.active.provider_id === id;

  return (
    <div className="h-full px-6 py-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-1 text-xl font-semibold">模型提供商</h1>
        <p className="mb-6 text-sm opacity-60">
          管理模型提供商与当前使用的「提供商 / 模型」，所有聊天与评估调用都经过它。
        </p>

        <div className="flex items-start gap-5">
          {/* 左列：提供商列表 */}
          <div className="flex w-64 shrink-0 flex-col">
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-40" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索提供商"
                className="w-full rounded-lg border bg-transparent py-1.5 pl-8 pr-2 text-xs outline-none"
                style={{ borderColor: "var(--border)" }}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              {filtered.length === 0 && (
                <p className="px-1 py-2 text-xs opacity-40">
                  {settings.providers.length === 0 ? "还没有提供商，点击下方添加" : "没有匹配的提供商"}
                </p>
              )}
              {filtered.map((p) => {
                const selected = !adding && p.id === selectedId;
                const usableModels = p.models.filter((m) => m.enabled ?? true).length;
                return (
                  <button
                    key={p.id}
                    onClick={() => void selectProvider(p.id)}
                    className={clsx(
                      "rounded-xl border px-3 py-2.5 text-left transition-colors",
                      selected ? "bg-brand/5" : "hover:bg-[var(--muted)]",
                      p.enabled === false && "opacity-50",
                    )}
                    style={{ borderColor: selected ? "rgb(var(--brand-rgb) / 0.5)" : "var(--border)" }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                      {isActive(p.id) && (
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ background: "rgb(var(--brand-rgb) / 0.12)", color: "rgb(var(--brand-rgb))" }}
                        >
                          使用中
                        </span>
                      )}
                      {p.enabled === false && (
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ background: "var(--muted)" }}
                        >
                          已停用
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] opacity-60">
                      <FormatBadge format={p.api_format} />
                      <span>{usableModels} 个模型</span>
                    </div>
                  </button>
                );
              })}
            </div>

            <button
              onClick={() => void openAdd()}
              className={clsx(
                "mt-3 flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-sm transition-colors",
                adding ? "bg-brand/5" : "hover:bg-[var(--muted)]",
              )}
              style={{ borderColor: adding ? "rgb(var(--brand-rgb) / 0.5)" : "var(--border)" }}
            >
              <Plus className="h-4 w-4" />
              添加提供商
            </button>
          </div>

          {/* 右栏：添加面板 / 编辑器（互斥） */}
          <div className="min-w-0 flex-1">
            {adding ? (
              <section
                className="rounded-2xl border p-5"
                style={{ borderColor: "var(--border)" }}
              >
                <h2 className="mb-1 text-base font-semibold">添加提供商</h2>
                <p className="mb-4 text-xs opacity-60">从预设中选择，或创建自定义提供商。</p>
                <div className="grid grid-cols-2 gap-2">
                  {PROVIDER_PRESETS.map((p) => (
                    <button
                      key={p.key}
                      onClick={() => createProvider(p.key)}
                      className="rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-[var(--muted)]"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <span className="block text-sm font-medium">{p.name}</span>
                      <span className="mt-0.5 block truncate text-[11px] opacity-50">{p.base_url}</span>
                    </button>
                  ))}
                  <button
                    onClick={() => createProvider("custom")}
                    className="rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-[var(--muted)]"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <span className="block text-sm font-medium">自定义</span>
                    <span className="mt-0.5 block truncate text-[11px] opacity-50">任意 OpenAI / Anthropic 兼容端点</span>
                  </button>
                </div>
                <div className="mt-4 flex gap-2 border-t pt-4" style={{ borderColor: "var(--border)" }}>
                  <button
                    onClick={() => {
                      setAdding(false);
                      setActionError(null);
                    }}
                    className="rounded-lg border px-3 py-1.5 text-xs hover:bg-[var(--muted)]"
                    style={{ borderColor: "var(--border)" }}
                  >
                    取消
                  </button>
                </div>
              </section>
            ) : draft ? (
              <section
                className="rounded-2xl border"
                style={{ borderColor: "var(--border)" }}
              >
                <header
                  className="flex items-center gap-2 border-b px-5 py-3.5"
                  style={{ borderColor: "var(--border)" }}
                >
                  <Cable className="h-4 w-4 shrink-0 text-brand" />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {draft.name || "未命名提供商"}
                  </span>
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                    style={{ background: "var(--muted)" }}
                  >
                    {draft.kind === "preset" ? "预设" : "自定义"}
                  </span>
                  {/* 实时生效：编辑即落盘，这里只给一个轻量的状态反馈 */}
                  {saveState !== "idle" && (
                    <span className="text-[11px] opacity-50">
                      {saveState === "saving" ? "保存中…" : "已保存"}
                    </span>
                  )}
                  <div className="ml-1 flex shrink-0 items-center gap-1.5">
                    <span className="text-[11px] opacity-50">启用</span>
                    <EnableSwitch
                      checked={draft.enabled}
                      onChange={() => void toggleProviderEnabled()}
                      label={draft.enabled ? "停用提供商" : "启用提供商"}
                      title="启用或停用提供商"
                    />
                    <div className="relative">
                      <button
                        onClick={() => setMenuOpen((o) => !o)}
                        title="更多操作"
                        aria-label="更多操作"
                        className="flex h-7 w-7 items-center justify-center rounded-lg opacity-60 transition-colors hover:bg-[var(--muted)] hover:opacity-100"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                      {menuOpen && (
                        <>
                          <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                          <div
                            className="absolute right-0 top-8 z-40 w-40 overflow-hidden rounded-xl border py-1 shadow-lg"
                            style={{ borderColor: "var(--border)", background: "var(--background)" }}
                          >
                            <button
                              onClick={() => void activate()}
                              className={clsx(
                                "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-[var(--muted)]",
                                isActive(draft.id) && "text-brand",
                              )}
                            >
                              设为当前使用
                              {isActive(draft.id) && <Check className="h-3.5 w-3.5" />}
                            </button>
                            {draft.kind === "preset" && (
                              <button
                                onClick={restoreDefault}
                                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-[var(--muted)]"
                              >
                                <Undo2 className="h-3.5 w-3.5" />
                                恢复默认
                              </button>
                            )}
                            {draft.kind === "custom" && (
                              <button
                                onClick={() => void deleteProvider()}
                                className="flex w-full items-center px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-500/10 dark:text-red-400"
                              >
                                删除
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </header>

                <div className="flex flex-col gap-4 p-5">
                  <Field label="名称">
                    <input
                      value={draft.name}
                      onChange={(e) => updateDraft({ name: e.target.value })}
                      className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-light"
                      style={{ borderColor: "var(--border)" }}
                    />
                  </Field>
                  <Field label="Base URL">
                    <input
                      value={draft.base_url}
                      onChange={(e) => updateDraft({ base_url: e.target.value })}
                      placeholder="https://api.example.com/v1"
                      className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-light"
                      style={{ borderColor: "var(--border)" }}
                    />
                  </Field>
                  <Field label="API Key">
                    <div className="relative">
                      <input
                        type={showApiKey ? "text" : "password"}
                        value={apiKeyInput}
                        onChange={(e) => {
                          setApiKeyInput(e.target.value);
                          scheduleSave();
                        }}
                        placeholder="粘贴你的 API Key"
                        autoComplete="off"
                        aria-label="API Key"
                        className="w-full rounded-lg border bg-transparent px-3 py-2 pr-9 text-sm outline-none focus:border-brand-light"
                        style={{ borderColor: "var(--border)" }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey((v) => !v)}
                        title={showApiKey ? "隐藏密钥" : "显示密钥"}
                        aria-label={showApiKey ? "隐藏密钥" : "显示密钥"}
                        className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md opacity-50 transition-colors hover:bg-[var(--muted)] hover:opacity-100"
                      >
                        {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </Field>
                  <Field label="API 格式">
                    <select
                      value={draft.api_format}
                      onChange={(e) => updateDraft({ api_format: e.target.value as ApiFormat })}
                      className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-light"
                      style={{ borderColor: "var(--border)" }}
                    >
                      {(Object.keys(API_FORMAT_LABEL) as ApiFormat[]).map((f) => (
                        <option key={f} value={f}>
                          {API_FORMAT_LABEL[f]}
                        </option>
                      ))}
                    </select>
                  </Field>

                  {/* 模型区：只读摘要行，编辑走弹窗 */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium opacity-70">模型</span>
                      <button
                        onClick={openModelDialog}
                        className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-brand-light hover:bg-[var(--muted)]"
                        title="添加模型"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        添加模型
                      </button>
                    </div>
                    {draft.models.length === 0 && (
                      <p
                        className="rounded-lg border border-dashed px-3 py-4 text-center text-[11px] opacity-50"
                        style={{ borderColor: "var(--border)" }}
                      >
                        还没有模型，点右上角「添加模型」
                      </p>
                    )}
                    {draft.models.map((m, i) => {
                      const state = modelTests[i];
                      const variant = m.reasoning?.enabled ? m.reasoning.default_variant : null;
                      return (
                        <div
                          key={i}
                          className={clsx(
                            "rounded-xl border px-3 py-2",
                            m.enabled === false && "opacity-50",
                          )}
                          style={{ borderColor: "var(--border)" }}
                        >
                          <div className="flex items-center gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-sm font-medium">
                                  {m.display_name || m.name || "未命名模型"}
                                </span>
                                {m.display_name && m.display_name !== m.name && (
                                  <span className="truncate text-[11px] opacity-50">{m.name}</span>
                                )}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-1">
                                {m.context_window != null && m.context_window > 0 && (
                                  <ModelBadge title={`上下文长度 ${m.context_window} tokens`}>
                                    {formatContextWindow(m.context_window)}
                                  </ModelBadge>
                                )}
                                {m.modalities != null && (
                                  <ModelBadge
                                    title={
                                      m.modalities.image
                                        ? "视觉能力：显式声明支持图片输入"
                                        : "视觉能力：显式声明不支持图片输入"
                                    }
                                  >
                                    {m.modalities.image ? "视觉" : "无视觉"}
                                  </ModelBadge>
                                )}
                                {variant ? (
                                  <ModelBadge
                                    testId="model-variant-badge"
                                    title={`思考档位：${variant}（可选档位 ${m.reasoning?.variants.join(" / ") || "无"}）`}
                                  >
                                    {variant}
                                  </ModelBadge>
                                ) : (
                                  m.reasoning?.enabled && <ModelBadge title="推理已启用，未设默认档位">思考</ModelBadge>
                                )}
                                {m.enabled === false && <ModelBadge>已停用</ModelBadge>}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-0.5">
                              <button
                                onClick={() => void runModelTest(i, m)}
                                disabled={!m.name.trim()}
                                title={`测试 ${m.name || "未命名模型"}`}
                                aria-label={`测试 ${m.name || "未命名模型"}`}
                                className="flex h-8 w-8 items-center justify-center rounded-lg opacity-60 transition-colors hover:bg-[var(--muted)] hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                              >
                                {state?.status === "pending" ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Zap className="h-3.5 w-3.5" />
                                )}
                              </button>
                              <button
                                onClick={() => setEditingIndex(i)}
                                title={`编辑 ${m.name || "未命名模型"}`}
                                aria-label={`编辑 ${m.name || "未命名模型"}`}
                                className="flex h-8 w-8 items-center justify-center rounded-lg opacity-60 transition-colors hover:bg-[var(--muted)] hover:opacity-100"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => updateModels((models) => models.filter((_, idx) => idx !== i))}
                                title={`删除 ${m.name || "未命名模型"}`}
                                aria-label={`删除 ${m.name || "未命名模型"}`}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-red-500 transition-colors hover:bg-red-500/10"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                              <EnableSwitch
                                checked={m.enabled ?? true}
                                onChange={(next) => updateModel(i, { enabled: next })}
                                label={m.enabled ? `停用模型 ${m.name}` : `启用模型 ${m.name}`}
                                title={`启用或停用模型 ${m.name || "未命名模型"}`}
                              />
                            </div>
                          </div>
                          {state && state.status !== "pending" && (
                            <p
                              className={clsx(
                                "mt-1 break-all text-[11px]",
                                state.status === "ok"
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-red-600 dark:text-red-400",
                              )}
                            >
                              {state.status === "ok"
                                ? `连接成功 · ${state.latency_ms} ms`
                                : state.message}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {actionError && (
                    <div className="flex items-start gap-2 rounded-xl border border-red-300/50 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                      <span className="min-w-0 flex-1 break-all">{actionError}</span>
                    </div>
                  )}
                </div>
              </section>
            ) : (
              <div
                className="flex flex-col items-center justify-center rounded-2xl border px-6 py-16 text-center"
                style={{ borderColor: "var(--border)" }}
              >
                <Cable className="mb-3 h-8 w-8 opacity-30" />
                <p className="text-sm opacity-60">在左侧选择一个提供商进行编辑</p>
                <p className="mt-1 text-xs opacity-40">或点击「添加提供商」接入新的模型服务</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {editingIndex !== null && draft && (
        <ModelEditDialog
          title={draft.models[editingIndex]?.name ? "编辑模型" : "添加模型"}
          initial={draft.models[editingIndex] ?? defaultModel("")}
          onSave={saveModel}
          onCancel={cancelModelEdit}
        />
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium opacity-70">{label}</span>
        {children}
      </label>
      {hint && <p className="text-[11px] opacity-50">{hint}</p>}
    </div>
  );
}
