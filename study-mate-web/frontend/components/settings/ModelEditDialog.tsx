"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { Check, ChevronDown, ChevronRight, ChevronUp, Plus, X } from "lucide-react";

import type {
  InputModality,
  ProviderCapabilities,
  ProviderModel,
  ProviderModalities,
  ProviderReasoning,
} from "@/lib/types";

const INPUT_MODALITY_OPTIONS: { value: InputModality; label: string }[] = [
  { value: "text", label: "文本" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "pdf", label: "PDF" },
];

const CAPABILITY_OPTIONS: { key: keyof ProviderCapabilities; label: string }[] = [
  { key: "tool_call", label: "工具调用" },
  { key: "json_schema_output", label: "JSON Schema 输出" },
  { key: "native_web_search", label: "原生联网搜索" },
];

const ADVANCED_PANEL_ID = "model-edit-advanced";

export function EnableSwitch({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative h-5 w-9 shrink-0 rounded-full border transition-colors",
        checked ? "border-transparent bg-brand" : "bg-[var(--muted)]",
      )}
      style={checked ? undefined : { borderColor: "var(--border)" }}
    >
      <span
        className={clsx(
          "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all",
          checked ? "left-[1.125rem]" : "left-0.5",
        )}
      />
    </button>
  );
}

function ModalityCheckbox({
  modality,
  label,
  checked,
  onChange,
}: {
  modality: InputModality;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={label}
      data-model-input-modality={modality}
      onClick={() => onChange(!checked)}
      className={clsx(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors",
        checked ? "border-brand bg-brand/10" : "hover:bg-[var(--muted)]",
      )}
      style={checked ? undefined : { borderColor: "var(--border)" }}
    >
      <span
        className={clsx(
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
          checked ? "border-brand bg-brand text-white" : "bg-transparent",
        )}
        style={checked ? undefined : { borderColor: "var(--border)" }}
      >
        {checked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
      </span>
      <span className="font-medium">{label}</span>
    </button>
  );
}

function CapabilityCheckbox({
  capability,
  label,
  checked,
  onChange,
}: {
  capability: keyof ProviderCapabilities;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={`${label}（仅落盘与展示，暂不影响请求）`}
      data-model-capability={capability}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-left"
    >
      <span
        className={clsx(
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
          checked ? "border-brand bg-brand text-white" : "bg-transparent",
        )}
        style={checked ? undefined : { borderColor: "var(--border)" }}
      >
        {checked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
      </span>
      <span className="text-xs">{label}</span>
    </button>
  );
}

function emptyModalities(): Record<InputModality, boolean> {
  return { text: false, image: false, video: false, pdf: false };
}

interface ModelEditDialogProps {
  title: string;
  initial: ProviderModel;
  onSave: (model: ProviderModel) => void;
  onCancel: () => void;
}

export function ModelEditDialog({ title, initial, onSave, onCancel }: ModelEditDialogProps) {
  const [name, setName] = useState(initial.name);
  const [displayName, setDisplayName] = useState(initial.display_name ?? "");
  const [checks, setChecks] = useState<Record<InputModality, boolean>>(() => ({
    ...emptyModalities(),
    ...(initial.modalities ?? {}),
  }));
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    initial.max_output_tokens == null ? "" : String(initial.max_output_tokens),
  );
  const [contextWindow, setContextWindow] = useState(
    initial.context_window == null ? "" : String(initial.context_window),
  );
  const [reasoningEnabled, setReasoningEnabled] = useState(initial.reasoning?.enabled ?? false);
  const [variants, setVariants] = useState<string[]>(initial.reasoning?.variants ?? []);
  const [defaultVariant, setDefaultVariant] = useState<string>(initial.reasoning?.default_variant ?? "");
  const [capabilities, setCapabilities] = useState<ProviderCapabilities>(
    initial.capabilities ?? { tool_call: false, json_schema_output: false, native_web_search: false },
  );
  const [enabled, setEnabled] = useState(initial.enabled ?? true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const parsePositiveInt = useCallback((raw: string): number | null | undefined => {
    const text = raw.trim();
    if (!text) return null;
    const parsed = Number(text);
    if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
    return parsed;
  }, []);

  const addVariant = () => {
    const base = "level";
    let index = variants.length + 1;
    while (variants.includes(`${base}-${index}`)) index += 1;
    setVariants((list) => [...list, `${base}-${index}`]);
  };

  const renameVariant = (index: number, value: string) => {
    setVariants((list) => list.map((item, i) => (i === index ? value : item)));
    if (defaultVariant === variants[index]) setDefaultVariant(value);
  };

  const removeVariant = (index: number) => {
    setVariants((list) => list.filter((_, i) => i !== index));
  };

  const moveVariant = (index: number, offset: number) => {
    setVariants((list) => {
      const target = index + offset;
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("请填写模型 ID");
      return;
    }
    const outputTokens = parsePositiveInt(maxOutputTokens);
    if (outputTokens === undefined) {
      setError("最大输出 Token 请填写正整数，或留空表示用默认值");
      return;
    }
    const contextTokens = parsePositiveInt(contextWindow);
    if (contextTokens === undefined) {
      setError("上下文长度请填写正整数（token 数），或留空");
      return;
    }
    const anyModality = INPUT_MODALITY_OPTIONS.some((option) => checks[option.value]);
    const modalities: ProviderModalities | null = anyModality ? { ...checks } : null;
    const cleanedVariants = variants.map((item) => item.trim()).filter(Boolean);
    const reasoning: ProviderReasoning | null = reasoningEnabled
      ? {
          enabled: true,
          variants: cleanedVariants,
          default_variant:
            defaultVariant && cleanedVariants.includes(defaultVariant) ? defaultVariant : null,
        }
      : null;
    onSave({
      name: trimmed,
      display_name: displayName.trim(),
      modalities,
      context_window: contextTokens,
      max_output_tokens: outputTokens,
      reasoning,
      capabilities,
      enabled,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-2xl border bg-[var(--background)] p-5 shadow-xl"
        style={{ borderColor: "var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label="模型 ID" hint="发送给 API 的模型 id，如 deepseek-chat">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="deepseek-chat"
              autoFocus
              autoComplete="off"
              className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-light"
              style={{ borderColor: "var(--border)" }}
            />
          </Field>
          <Field label="显示名" hint="留空则列表里显示模型 ID">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="DeepSeek V3"
              autoComplete="off"
              className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-light"
              style={{ borderColor: "var(--border)" }}
            />
          </Field>

          <Group
            label="模态"
            hint={
              INPUT_MODALITY_OPTIONS.some((option) => checks[option.value])
                ? "勾选即视为显式声明；视频 / PDF 输入暂不实际发送，仅作能力记录"
                : "未勾选任何模态 = 未配置：视觉能力按内置前缀表自动判定"
            }
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {INPUT_MODALITY_OPTIONS.map((option) => (
                <ModalityCheckbox
                  key={option.value}
                  modality={option.value}
                  label={option.label}
                  checked={checks[option.value]}
                  onChange={(next) => setChecks((c) => ({ ...c, [option.value]: next }))}
                />
              ))}
            </div>
          </Group>

          <Field label="最大输出 Token" hint="该模型的输出上限，留空则用各协议的默认值">
            <input
              value={maxOutputTokens}
              onChange={(e) => setMaxOutputTokens(e.target.value)}
              inputMode="numeric"
              placeholder="如 8192"
              className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-light"
              style={{ borderColor: "var(--border)" }}
            />
          </Field>
          <Field label="上下文长度" hint="token 数，仅用于列表徽标，不发送给 API">
            <input
              value={contextWindow}
              onChange={(e) => setContextWindow(e.target.value)}
              inputMode="numeric"
              placeholder="如 128000"
              className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-light"
              style={{ borderColor: "var(--border)" }}
            />
          </Field>

          {/* 高级：ChevronRight 展开旋转 90°；收起时内容保持挂载并 inert（保留局部草稿） */}
          <div className="rounded-lg border" style={{ borderColor: "var(--border)" }}>
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-controls={ADVANCED_PANEL_ID}
              onClick={() => setAdvancedOpen((open) => !open)}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium opacity-70 transition-colors hover:opacity-100"
            >
              <ChevronRight
                className={clsx("h-3.5 w-3.5 transition-transform", advancedOpen && "rotate-90")}
              />
              高级
            </button>
            <div
              id={ADVANCED_PANEL_ID}
              inert={!advancedOpen}
              className={clsx(
                "grid border-t transition-[grid-template-rows]",
                advancedOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
              )}
              style={{ borderColor: "var(--border)" }}
            >
              <div className="flex flex-col gap-4 overflow-hidden px-3 py-3">
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-xs font-medium opacity-70">推理档位</span>
                  <span className="text-[11px] opacity-50">
                    启用后按提供商的 API 格式映射为协议思考参数
                  </span>
                </div>
                <EnableSwitch
                  checked={reasoningEnabled}
                  onChange={setReasoningEnabled}
                  label="启用推理档位"
                  title="启用或停用推理档位"
                />
              </div>

              {reasoningEnabled && (
                <>
                  <div className="flex flex-col gap-2">
                    <span className="text-[11px] opacity-50">
                      档位列表（有序，低 → 高）：可改名、排序、增删；未启用时不发送思考参数
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {variants.map((variant, index) => (
                        <div
                          key={index}
                          data-reasoning-variant={variant}
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (!event.altKey) return;
                            if (event.key === "ArrowUp") {
                              event.preventDefault();
                              moveVariant(index, -1);
                            } else if (event.key === "ArrowDown") {
                              event.preventDefault();
                              moveVariant(index, 1);
                            }
                          }}
                          className="flex items-center gap-0.5 rounded-full border py-0.5 pl-2 pr-0.5"
                          style={{ borderColor: "var(--border)" }}
                        >
                          <input
                            value={variant}
                            onChange={(e) => renameVariant(index, e.target.value)}
                            aria-label={`推理档位 ${index + 1}`}
                            data-reasoning-variant-input
                            className="w-20 bg-transparent text-xs outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => moveVariant(index, -1)}
                            disabled={index === 0}
                            title={`上移 ${variant || "未命名档位"}`}
                            aria-label={`上移推理档位 ${index + 1}`}
                            className="flex h-5 w-5 items-center justify-center rounded-full opacity-50 hover:bg-[var(--muted)] hover:opacity-100 disabled:opacity-20"
                          >
                            <ChevronUp className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveVariant(index, 1)}
                            disabled={index === variants.length - 1}
                            title={`下移 ${variant || "未命名档位"}`}
                            aria-label={`下移推理档位 ${index + 1}`}
                            className="flex h-5 w-5 items-center justify-center rounded-full opacity-50 hover:bg-[var(--muted)] hover:opacity-100 disabled:opacity-20"
                          >
                            <ChevronDown className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeVariant(index)}
                            title={`删除档位 ${variant || "未命名"}`}
                            aria-label={`删除推理档位 ${index + 1}`}
                            className="flex h-5 w-5 items-center justify-center rounded-full text-red-500 opacity-60 hover:bg-red-500/10 hover:opacity-100"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={addVariant}
                        className="flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs opacity-60 transition-colors hover:bg-[var(--muted)] hover:opacity-100"
                        style={{ borderColor: "var(--border)" }}
                      >
                        <Plus className="h-3 w-3" />
                        添加档位
                      </button>
                    </div>
                  </div>

                  <Field label="默认档位" hint="对话侧未显式选择档位时使用；空则使用各协议默认行为">
                    <select
                      value={defaultVariant}
                      onChange={(e) => setDefaultVariant(e.target.value)}
                      aria-label="默认档位"
                      className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-light"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <option value="">（无）</option>
                      {variants
                        .filter((variant) => variant.trim())
                        .map((variant, index) => (
                          <option key={`${index}-${variant}`} value={variant}>
                            {variant}
                          </option>
                        ))}
                    </select>
                  </Field>
                </>
              )}

              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium opacity-70">能力声明</span>
                <span className="text-[11px] opacity-50">仅落盘与展示，暂不影响请求</span>
                <div className="flex flex-col gap-2">
                  {CAPABILITY_OPTIONS.map((option) => (
                    <CapabilityCheckbox
                      key={option.key}
                      capability={option.key}
                      label={option.label}
                      checked={capabilities[option.key]}
                      onChange={(next) =>
                        setCapabilities((c) => ({ ...c, [option.key]: next }))
                      }
                    />
                  ))}
                </div>
              </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ borderColor: "var(--border)" }}>
            <div className="flex flex-col">
              <span className="text-xs font-medium opacity-70">启用</span>
              <span className="text-[11px] opacity-50">停用后不出现在对话的模型选择里</span>
            </div>
            <EnableSwitch
              checked={enabled}
              onChange={setEnabled}
              label="启用模型"
              title="启用或停用此模型"
            />
          </div>

          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

          <div className="flex items-center justify-end gap-2 border-t pt-4" style={{ borderColor: "var(--border)" }}>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border px-3.5 py-2 text-xs transition-colors hover:bg-[var(--muted)]"
              style={{ borderColor: "var(--border)" }}
            >
              取消
            </button>
            <button
              type="submit"
              className="rounded-lg bg-brand px-3.5 py-2 text-xs font-medium text-white transition-opacity hover:bg-brand-light"
            >
              保存模型
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
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

function Group({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium opacity-70">{label}</span>
      {children}
      {hint && <p className="text-[11px] opacity-50">{hint}</p>}
    </div>
  );
}
