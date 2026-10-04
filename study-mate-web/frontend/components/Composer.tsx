"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Brain, Check, ChevronDown, FileText, Loader2, Paperclip, Send, Square, X } from "lucide-react";
import { api } from "@/lib/api";
import { formatFileSize } from "@/lib/format";
import { useChatDraft } from "@/lib/workspace";
import { activeModelOf, modelVariant, modelVariants, ModelSelector } from "./ModelSelector";
import type { AppSettings, AttachmentKind, SessionActive, UploadedAttachment } from "@/lib/types";

const ACCEPT =
  "image/*,.svg,.md,.txt,.csv,.json,.xml,.py,.js,.ts,.html,.css,.pdf,.docx,.xlsx,.pptx,.epub";
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

// 会话态输入框贴在视口底部，而外层 main 是 overflow-hidden：模型下拉若照常向下展开
// 会被整块裁掉。这里让它在输入区上方展开（ModelSelector 的下拉是 .absolute.right-0）。
// 只影响布局位置；若 ModelSelector 换成 portal 渲染，这段类名自然失效、行为回到默认。
const DROPDOWN_UPWARD = "[&_.absolute.right-0]:bottom-full [&_.absolute.right-0]:mb-1.5";

interface PendingAttachment {
  key: string;
  file: File;
  kind: AttachmentKind;
  previewUrl: string | null;
  status: "uploading" | "done" | "error";
  uploaded?: UploadedAttachment;
}

// 推理档位下拉：从模型弹层迁出的对话侧档位切换（ModelSelector 的弹层只负责切提供商/模型）。
// 触发按钮沿用「思考」指示同款 Brain 图标；外层包在 DROPDOWN_UPWARD 里，弹层
// （.absolute.right-0）同样向上展开。保存路径与 ModelSelector.setVariant 相同：整份 settings
// 写回 saveSettings，成功后再把新档位灌回上层状态；失败时红字就地提示（弹层此时已收起，
// 放在触发按钮旁边而不是弹层里，否则一点开就看不见了）。
interface ReasoningVariantSelectorProps {
  settings: AppSettings | null;
  onUpdated: (settings: AppSettings) => void;
  sessionId?: string | null;
  sessionActive?: SessionActive | null;
  onSessionActiveChange?: (active: SessionActive) => void;
}

function ReasoningVariantSelector({
  settings,
  onUpdated,
  sessionId = null,
  sessionActive = null,
  onSessionActiveChange,
}: ReasoningVariantSelectorProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 生效三元组：会话绑定优先，否则全局默认（与 ModelSelector 同一口径）
  const effective = settings ? sessionActive ?? settings.active : null;
  const activeModel = settings && effective ? activeModelOf(settings, effective) : null;
  const variants = modelVariants(activeModel);
  const activeVariant = effective?.reasoning_variant || modelVariant(activeModel) || null;

  // 当前模型没有可选档位（reasoning 未启用 / variants 为空），或没配置提供商时不渲染
  if (!settings || settings.providers.length === 0 || variants.length === 0 || !effective) {
    return null;
  }

  const choose = (variant: string) => {
    setOpen(false);
    if (variant === activeVariant) {
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    const nextActive: SessionActive = { ...effective, reasoning_variant: variant };
    // 会话内切换档位：写会话绑定；否则写全局默认
    if (sessionId && onSessionActiveChange) {
      void api
        .setSessionActive(sessionId, nextActive)
        .then(() => onSessionActiveChange(nextActive))
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setSaving(false));
      return;
    }
    void api
      .saveSettings({
        providers: settings.providers,
        active: nextActive,
        system_prompt: settings.system_prompt,
      })
      .then(() => onUpdated({ ...settings, active: nextActive }))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="relative shrink-0" data-testid="reasoning-variant-selector">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs hover:bg-[var(--muted)]"
        style={{ borderColor: "var(--border)" }}
        title="切换推理档位"
      >
        <Brain className="h-3 w-3 shrink-0 opacity-60" />
        <span className="min-w-0 truncate" data-testid="reasoning-variant-label">
          {activeVariant ?? "默认"}
        </span>
        {saving ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin opacity-60" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        )}
      </button>

      {error && (
        <span
          className="max-w-[12rem] shrink truncate text-[11px] text-red-500"
          title={error}
        >
          {error}
        </span>
      )}

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            data-testid="reasoning-variant-menu"
            className="absolute right-0 z-40 mt-1.5 max-h-64 w-48 overflow-y-auto rounded-xl border shadow-lg"
            style={{ borderColor: "var(--border)", background: "var(--background)" }}
          >
            <div className="px-3 pb-1 pt-2 text-[11px] font-medium opacity-50">思考档位</div>
            {variants.map((variant) => {
              const current = variant === activeVariant;
              return (
                <button
                  key={variant}
                  onClick={() => choose(variant)}
                  aria-pressed={current}
                  data-reasoning-variant={variant}
                  className={clsx(
                    "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors",
                    current ? "bg-brand/10 text-brand" : "hover:bg-[var(--muted)]",
                  )}
                >
                  <span className="min-w-0 truncate">{variant}</span>
                  {current && <Check className="h-3 w-3 shrink-0" />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

interface ComposerProps {
  streaming: boolean;
  disabled: boolean;
  elevated?: boolean;
  sessionId?: string | null;
  settings: AppSettings | null;
  onUpdated: (settings: AppSettings) => void;
  /** 会话绑定的模型/档位（null = 跟随全局默认；会话内切换只改这个会话） */
  sessionActive?: SessionActive | null;
  onSessionActiveChange?: (active: SessionActive) => void;
  onSend: (text: string, attachments: UploadedAttachment[]) => void;
  onStop: () => void;
}

export function Composer({
  streaming,
  disabled,
  elevated = false,
  sessionId = null,
  settings,
  onUpdated,
  sessionActive = null,
  onSessionActiveChange,
  onSend,
  onStop,
}: ComposerProps) {
  // 草稿按会话 id 缓存：切会话自动保存/载入，发送后清空
  const { value, setValue, clearDraft } = useChatDraft(sessionId);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inflightRef = useRef(new Map<string, Promise<void>>());
  const pendingRef = useRef<PendingAttachment[]>([]);
  pendingRef.current = pending;

  const revoke = (p: PendingAttachment) => {
    if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
  };

  useEffect(() => {
    const map = inflightRef.current;
    return () => {
      map.clear();
      pendingRef.current.forEach(revoke);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadOne = (item: PendingAttachment) => {
    const task = api
      .uploadAttachment(item.file, sessionId)
      .then((res) => {
        setPending((prev) =>
          prev.map((p) =>
            p.key === item.key ? { ...p, status: "done", uploaded: res } : p,
          ),
        );
      })
      .catch((err) => {
        setPending((prev) =>
          prev.map((p) => (p.key === item.key ? { ...p, status: "error" } : p)),
        );
        setHint(
          `附件「${item.file.name}」上传失败：${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        inflightRef.current.delete(item.key);
      });
    inflightRef.current.set(item.key, task);
  };

  const addFiles = (files: FileList | File[]) => {
    if (disabled) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setHint(null);
    const next: PendingAttachment[] = [];
    let count = pendingRef.current.length;
    let message: string | null = null;
    for (const file of list) {
      if (count >= MAX_ATTACHMENTS) {
        message = `单条消息最多 ${MAX_ATTACHMENTS} 个附件`;
        break;
      }
      if (file.size > MAX_FILE_SIZE) {
        message = `「${file.name}」超过 20MB 上限，已跳过`;
        continue;
      }
      const isImage = file.type.startsWith("image/") && file.type !== "image/svg+xml";
      const item: PendingAttachment = {
        key: `${Date.now()}-${count}-${file.name}`,
        file,
        kind: isImage ? "image" : "doc",
        previewUrl: isImage ? URL.createObjectURL(file) : null,
        status: "uploading",
      };
      next.push(item);
      count += 1;
    }
    if (message) setHint(message);
    if (next.length > 0) {
      setPending((prev) => [...prev, ...next]);
      next.forEach(uploadOne);
    }
  };

  const removePending = (key: string) => {
    setPending((prev) => {
      const target = prev.find((p) => p.key === key);
      if (target) revoke(target);
      return prev.filter((p) => p.key !== key);
    });
  };

  const clearPending = () => {
    setPending((prev) => {
      prev.forEach(revoke);
      return [];
    });
  };

  const submit = async () => {
    if (streaming || disabled) return;
    if (inflightRef.current.size > 0) {
      await Promise.allSettled(Array.from(inflightRef.current.values()));
    }
    const text = value.trim();
    const current = pendingRef.current;
    const uploaded = current
      .filter((p) => p.status === "done" && p.uploaded)
      .map((p) => p.uploaded!);
    const failed = current.filter((p) => p.status === "error").length;
    if (failed > 0) setHint(`${failed} 个附件上传失败，将不随消息发送`);
    if (!text && uploaded.length === 0) return;
    onSend(text, uploaded);
    clearDraft();
    clearPending();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  };

  // 输入框高度跟随内容：切会话载入草稿、发送后清空都要重新量一次
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend =
    !streaming && !disabled && (value.trim().length > 0 || pending.some((p) => p.status === "done"));

  return (
    <div
      data-testid="composer"
      className={clsx("px-4 pb-4", elevated ? "pt-2" : "pt-3")}
    >
      <div className={clsx("mx-auto w-full", elevated ? "max-w-[720px]" : "max-w-3xl")}>
        <div
          className={clsx(
            "flex flex-col rounded-3xl border bg-[var(--surface-card)] p-3 shadow-card transition-all",
            "focus-within:border-brand focus-within:shadow-md focus-within:ring-2 focus-within:ring-brand/15",
            dragActive && "border-brand ring-2 ring-brand/20",
          )}
          style={{ borderColor: dragActive ? undefined : "var(--border)" }}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDragActive(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragActive(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            if (!disabled) addFiles(e.dataTransfer.files);
          }}
        >
          {/* 待发送附件胶囊条 */}
          {pending.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1 pb-2.5 pt-0.5">
              {pending.map((p) => (
                <div
                  key={p.key}
                  className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-subtle)] py-1 pl-1 pr-2 text-xs shadow-xs"
                  style={{ borderColor: p.status === "error" ? "rgb(239 68 68 / 0.5)" : undefined }}
                  title={p.status === "error" ? "上传失败" : p.file.name}
                >
                  {p.kind === "image" && p.previewUrl ? (
                    <img
                      src={p.previewUrl}
                      alt={p.file.name}
                      className="h-8 w-8 shrink-0 rounded-lg object-cover"
                    />
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--muted)]">
                      <FileText className="h-4 w-4 opacity-60" />
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="block max-w-[9rem] truncate font-medium">{p.file.name}</span>
                    <span className="block text-[10px] opacity-50">{formatFileSize(p.file.size)}</span>
                  </span>
                  {p.status === "uploading" && <Loader2 className="h-3 w-3 shrink-0 animate-spin opacity-60" />}
                  {p.status === "done" && <Check className="h-3 w-3 shrink-0 text-brand" />}
                  {p.status === "error" && <span className="shrink-0 text-red-500">失败</span>}
                  <button
                    onClick={() => removePending(p.key)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md opacity-50 transition-opacity hover:bg-[var(--muted)] hover:opacity-100"
                    title="移除"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* 舒畅输入区 */}
          <div className="px-1">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={elevated ? 2 : 1}
              placeholder={
                disabled
                  ? "请先到设置页配置模型"
                  : "给 StudyMate 发消息…（Enter 发送，Shift+Enter 换行）"
              }
              disabled={disabled}
              className={clsx(
                "min-h-[38px] w-full resize-none bg-transparent py-1.5 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--foreground)]/40 disabled:cursor-not-allowed",
                elevated && "text-[15px]",
              )}
            />
          </div>

          {/* 底部工具条：左侧附件，右侧「模型 + 思考档位 + 发送」（2026-10-04 拍板：下拉靠右） */}
          <div className="mt-2 flex items-center justify-between border-t border-[var(--border)]/40 pt-2">
            <div className="flex items-center gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-[var(--foreground)]/65 transition-all hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-30"
                title="添加附件（图片或文档）"
              >
                <Paperclip className="h-4 w-4" />
              </button>
            </div>

            <div className="flex min-w-0 items-center gap-2">
              {/* 模型快捷切换 + 推理档位下拉（都向上展开；会话内切换写会话绑定） */}
              <div className={clsx("flex min-w-0 items-center gap-1", DROPDOWN_UPWARD)}>
                <ModelSelector
                  settings={settings}
                  onUpdated={onUpdated}
                  sessionId={sessionId}
                  sessionActive={sessionActive}
                  onSessionActiveChange={onSessionActiveChange}
                />
                <ReasoningVariantSelector
                  settings={settings}
                  onUpdated={onUpdated}
                  sessionId={sessionId}
                  sessionActive={sessionActive}
                  onSessionActiveChange={onSessionActiveChange}
                />
              </div>

              {streaming ? (
                <button
                  onClick={onStop}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--muted)] text-[var(--foreground)] transition-opacity hover:opacity-80"
                  title="停止"
                >
                  <Square className="h-3.5 w-3.5" />
                </button>
              ) : (
                <button
                  onClick={() => void submit()}
                  disabled={!canSend}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-xs transition-all hover:bg-brand-light disabled:opacity-30"
                  title="发送"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        {hint && (
          <div className="mt-1.5 flex items-center gap-2 px-2 text-[11px] text-red-500">
            <span className="min-w-0 flex-1">{hint}</span>
            <button onClick={() => setHint(null)} className="shrink-0 opacity-50 hover:opacity-100">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
