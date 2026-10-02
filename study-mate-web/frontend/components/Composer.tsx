"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Check, FileText, Loader2, Paperclip, Send, Square, X } from "lucide-react";
import { api } from "@/lib/api";
import { formatFileSize } from "@/lib/format";
import { useChatDraft } from "@/lib/workspace";
import { ModelSelector } from "./ModelSelector";
import type { AppSettings, AttachmentKind, UploadedAttachment } from "@/lib/types";

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

interface ComposerProps {
  streaming: boolean;
  disabled: boolean;
  elevated?: boolean;
  sessionId?: string | null;
  settings: AppSettings | null;
  onUpdated: (settings: AppSettings) => void;
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
      className={clsx("px-4 pb-4", elevated ? "pt-2" : "pt-3 border-t")}
      style={elevated ? undefined : { borderColor: "var(--border)" }}
    >
      <div className={clsx("mx-auto w-full", elevated ? "max-w-[720px]" : "max-w-3xl")}>
        <div
          className={clsx(
            "flex flex-col rounded-3xl border bg-[var(--muted)]/40 transition-colors",
            elevated ? "px-4 py-3" : "rounded-2xl px-3 py-2",
            dragActive && "border-brand",
          )}
          style={dragActive ? undefined : { borderColor: "var(--border)" }}
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
          {pending.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1 pb-2 pt-1">
              {pending.map((p) => (
                <div
                  key={p.key}
                  className="flex items-center gap-2 rounded-xl border py-1 pl-1 pr-1.5 text-xs"
                  style={{ borderColor: p.status === "error" ? "rgb(239 68 68 / 0.5)" : "var(--border)" }}
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
                    <span className="block max-w-[9rem] truncate">{p.file.name}</span>
                    <span className="block text-[10px] opacity-50">{formatFileSize(p.file.size)}</span>
                  </span>
                  {p.status === "uploading" && <Loader2 className="h-3 w-3 shrink-0 animate-spin opacity-60" />}
                  {p.status === "done" && <Check className="h-3 w-3 shrink-0 text-brand" />}
                  {p.status === "error" && <span className="shrink-0 text-red-500">失败</span>}
                  <button
                    onClick={() => removePending(p.key)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-50 hover:bg-[var(--muted)] hover:opacity-100"
                    title="移除"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2">
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
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--foreground)] opacity-60 transition-opacity hover:bg-[var(--muted)] hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
              title="添加附件（图片或文档）"
            >
              <Paperclip className="h-4 w-4" />
            </button>
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
                "min-h-[36px] flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:opacity-50 disabled:cursor-not-allowed",
                elevated && "py-1.5 text-[15px]",
              )}
            />
            {streaming ? (
              <button
                onClick={onStop}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--muted)] hover:opacity-80"
                title="停止"
              >
                <Square className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={() => void submit()}
                disabled={!canSend}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition-opacity hover:bg-brand-light disabled:opacity-30"
                title="发送"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* 模型快捷切换：从顶栏移入输入区底部 */}
          <div className={clsx("mt-1 flex items-center gap-2 px-1", DROPDOWN_UPWARD)}>
            <ModelSelector settings={settings} onUpdated={onUpdated} />
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
