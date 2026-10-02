"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Info,
  Loader2,
  NotebookPen,
  PanelRightClose,
  PanelRightOpen,
  Sparkles,
  User,
  X,
} from "lucide-react";
import clsx from "clsx";
import Markdown from "./Markdown";
import { Composer } from "./Composer";
import { RightRail } from "./RightRail";
import { RightSidebar } from "./RightSidebar";
import { api, streamChat } from "@/lib/api";
import { formatFileSize } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import type {
  AppSettings,
  ChatMessage,
  GraphNode,
  MessageAttachment,
  SummaryResponse,
  UploadedAttachment,
} from "@/lib/types";

const GREETINGS: Record<"morning" | "afternoon" | "evening", string[]> = {
  morning: ["早上好，今天想弄懂什么？", "早安，学习的好时光。"],
  afternoon: ["下午好，继续加油！", "午后正是动手练习的好时候。"],
  evening: ["晚上好，夜色正适合学习。", "晚上好，今天进展如何？"],
};

const STARTERS = ["讲解一个概念", "出几道练习题", "按我的课程进度继续", "帮我制定学习计划"];

// 右侧边栏宽度：默认 256px（原 w-64），可拖拽范围 200–480px，键与课程页互不干扰
const RIGHT_SIDEBAR_WIDTH_KEY = "studymate-chat-right-sidebar-width";
const RIGHT_SIDEBAR_DEFAULT_WIDTH = 256;
const RIGHT_SIDEBAR_MIN_WIDTH = 200;
const RIGHT_SIDEBAR_MAX_WIDTH = 480;

// 挂载时按时段随机定死一组成 state，避免水合抖动
function pickGreeting(): string {
  const hour = new Date().getHours();
  const group = hour < 12 ? GREETINGS.morning : hour < 18 ? GREETINGS.afternoon : GREETINGS.evening;
  return group[Math.floor(Math.random() * group.length)];
}

export function ChatView() {
  const {
    sessions,
    subjects,
    activeSessionId,
    activeSubjectSlug,
    activeNodeId,
    setActiveSessionId,
    setActiveSubject,
    loadedSession,
    clearLoadedSession,
    refreshSessions,
    refreshSubjects,
    setMisconceptionDraft,
  } = useWorkspace();
  const router = useRouter();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [greeting, setGreeting] = useState("你好");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsFailed, setSettingsFailed] = useState(false);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [preview, setPreview] = useState<MessageAttachment | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryResult, setSummaryResult] = useState<SummaryResponse | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // 右侧边栏折叠态：组件内 state，刷新后回到默认展开（宽度则持久化）
  const [rightOpen, setRightOpen] = useState(true);

  const toggleRight = useCallback(() => setRightOpen((v) => !v), []);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const hasMessages = messages.length > 0;

  const hasKey: boolean | null = settings
    ? (settings.providers.find((p) => p.id === settings.active.provider_id)?.has_key ?? false)
    : settingsFailed
      ? false
      : null;

  const sessionTitle = useMemo(() => {
    if (!sessionId) return "新的对话";
    return sessions.find((s) => s.id === sessionId)?.title ?? "对话中";
  }, [sessionId, sessions]);

  // 模型提供商设置：API Key 检查与 Composer 内的模型选择器共用
  useEffect(() => {
    api
      .getSettings()
      .then(setSettings)
      .catch(() => setSettingsFailed(true));
  }, []);

  // 时段问候：挂载后随机定死
  useEffect(() => {
    setGreeting(pickGreeting());
  }, []);

  // 侧边栏共享数据
  useEffect(() => {
    void refreshSessions();
    void refreshSubjects();
  }, [refreshSessions, refreshSubjects]);

  // 选中科目后拉取该科目的节点列表（用于节点下拉）
  useEffect(() => {
    if (!activeSubjectSlug) {
      setNodes([]);
      return;
    }
    let alive = true;
    api
      .getCourse(activeSubjectSlug)
      .then((detail) => {
        if (alive) setNodes(detail.graph.nodes);
      })
      .catch(() => {
        if (alive) setNodes([]);
      });
    return () => {
      alive = false;
    };
  }, [activeSubjectSlug]);

  // 消费打开的历史会话：替换消息与会话 id，并恢复科目/节点上下文
  useEffect(() => {
    if (!loadedSession) return;
    abortRef.current?.abort();
    setActiveSessionId(loadedSession.meta.id);
    setSessionId(loadedSession.meta.id);
    setMessages(loadedSession.messages);
    setError(null);
    setNotice(null);
    setStreaming(false);
    setSummaryResult(null);
    setSummaryError(null);
    setActiveSubject(loadedSession.meta.subject_slug, loadedSession.meta.node_id);
    clearLoadedSession();
  }, [loadedSession, clearLoadedSession, setActiveSessionId, setActiveSubject]);

  // activeSessionId 变为 null（新对话/删除当前会话）时清空本地消息
  useEffect(() => {
    if (activeSessionId !== null) return;
    abortRef.current?.abort();
    setSessionId(null);
    setMessages([]);
    setError(null);
    setNotice(null);
    setStreaming(false);
    setSummaryResult(null);
    setSummaryError(null);
  }, [activeSessionId]);

  // 自动滚动到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, notice]);

  const handleSend = useCallback(
    (text: string, attachments: UploadedAttachment[] = []) => {
      setError(null);
      setNotice(null);
      setStreaming(true);

      const metas: MessageAttachment[] = attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        kind: a.kind,
        size: a.size,
      }));

      // 乐观地先显示用户消息和一个空的 assistant 占位
      setMessages((prev) => [
        ...prev,
        metas.length > 0 ? { role: "user", content: text, attachments: metas } : { role: "user", content: text },
        { role: "assistant", content: "" },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;
      let assistantBuffer = "";

      const patchAssistant = (patch: (c: string) => string) => {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { ...last, content: patch(last.content) };
          }
          return next;
        });
      };

      streamChat(
        text,
        sessionId,
        {
          onSession: (id) => {
            setSessionId(id);
            setActiveSessionId(id);
          },
          onDelta: (piece) => {
            assistantBuffer += piece;
            patchAssistant((c) => c + piece);
          },
          onNotice: (message) => setNotice(message),
          onDone: () => {
            setStreaming(false);
            void refreshSessions();
          },
          onError: (msg) => {
            setError(msg);
            // 空回复且报错时移除占位气泡
            if (!assistantBuffer) {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === "assistant" && !last.content) next.pop();
                return next;
              });
            }
            setStreaming(false);
            void refreshSessions();
          },
        },
        {
          subjectSlug: activeSubjectSlug,
          nodeId: activeNodeId,
          attachments: attachments.map((a) => a.id),
          signal: controller.signal,
        },
      ).catch((err) => {
        if (err.name !== "AbortError") setError(String(err));
        setStreaming(false);
      });
    },
    [sessionId, activeSubjectSlug, activeNodeId, setActiveSessionId, refreshSessions],
  );

  const handleStop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  const handleSummary = useCallback(async () => {
    if (!activeSubjectSlug || !sessionId || streaming) return;
    setSummarizing(true);
    setSummaryError(null);
    setSummaryResult(null);
    try {
      const res = await api.generateSessionSummary(activeSubjectSlug, sessionId);
      setSummaryResult(res);
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : String(err));
    } finally {
      setSummarizing(false);
    }
  }, [activeSubjectSlug, sessionId, streaming]);

  const saveToMisconceptions = useCallback(
    (index: number, content: string) => {
      let question = "";
      for (let i = index - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") {
          question = messages[i].content;
          break;
        }
      }
      const topic =
        nodes.find((n) => n.id === activeNodeId)?.title ??
        subjects.find((s) => s.slug === activeSubjectSlug)?.name ??
        "学习笔记";
      setMisconceptionDraft({
        subject: activeSubjectSlug ?? undefined,
        node: activeNodeId,
        topic,
        question,
        answer_summary: content.length > 300 ? `${content.slice(0, 300)}…` : content,
      });
      router.push("/misconceptions");
    },
    [messages, nodes, subjects, activeNodeId, activeSubjectSlug, setMisconceptionDraft, router],
  );

  const canSummarize = Boolean(activeSubjectSlug && sessionId && messages.length > 0 && !streaming);

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏 */}
        <div
          data-testid="chat-topbar"
          className="flex items-center justify-between gap-3 border-b px-5 py-3"
          style={{ borderColor: "var(--border)" }}
        >
          <span data-testid="chat-title" className="min-w-0 truncate text-sm font-medium">
            {sessionTitle}
          </span>
          <button
            onClick={toggleRight}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg opacity-60 transition-opacity hover:bg-[var(--muted)] hover:opacity-100"
            title={rightOpen ? "折叠右侧边栏" : "展开右侧边栏"}
          >
            {rightOpen ? (
              <PanelRightClose className="h-4 w-4" />
            ) : (
              <PanelRightOpen className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* 小结结果 / 错误条 */}
        {summaryResult && (
          <div
            className="flex items-start gap-2 border-b px-5 py-2.5 text-xs"
            style={{ borderColor: "var(--border)", background: "rgb(var(--brand-rgb) / 0.08)" }}
          >
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
            <div className="min-w-0 flex-1">
              <div className="break-all">小结已写入：{summaryResult.record_file}</div>
              {summaryResult.summary.next_step && (
                <div className="mt-0.5 opacity-70">下一步：{summaryResult.summary.next_step}</div>
              )}
            </div>
            <button
              onClick={() => setSummaryResult(null)}
              className="shrink-0 opacity-50 hover:opacity-100"
              title="关闭"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {summaryError && (
          <div className="flex items-start gap-2 border-b border-red-300/50 bg-red-500/10 px-5 py-2.5 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-all">{summaryError}</span>
            <button
              onClick={() => setSummaryError(null)}
              className="shrink-0 opacity-50 hover:opacity-100"
              title="关闭"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* 消息区 + 输入区：外层弹性占位实现两态落底过渡 */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            className="min-h-0 overflow-y-auto"
            style={{
              flexGrow: hasMessages ? 1 : 0,
              flexShrink: 1,
              transition: "flex-grow 650ms cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          >
            <div className="mx-auto max-w-3xl px-5 py-6">
              {!hasMessages && (
                <div className="flex flex-col items-center py-12 text-center">
                  <Sparkles className="mb-4 h-10 w-10 text-brand" />
                  <h1 className="mb-2 text-2xl font-semibold">{greeting}</h1>
                  <p className="mb-7 max-w-md text-sm opacity-60">
                    StudyMate 会陪你讲概念、做练习、跑项目。直接输入问题，或从下面的起点开始。
                  </p>
                  <div className="flex max-w-[720px] flex-wrap justify-center gap-2">
                    {STARTERS.map((s) => (
                      <button
                        key={s}
                        onClick={() => handleSend(s)}
                        className="rounded-full border px-3.5 py-1.5 text-sm transition-colors hover:bg-[var(--muted)]"
                        style={{ borderColor: "var(--border)" }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-5">
                {messages.map((msg, i) => {
                  const isUser = msg.role === "user";
                  const showCursor = !msg.content && streaming && i === messages.length - 1;
                  return (
                    <div
                      key={i}
                      className={clsx("group flex gap-3", isUser && "flex-row-reverse")}
                    >
                      <div
                        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                        style={{
                          background: isUser ? "var(--muted)" : "rgb(var(--brand-rgb))",
                          color: isUser ? "var(--foreground)" : "#fff",
                        }}
                      >
                        {isUser ? (
                          <User className="h-4 w-4" />
                        ) : (
                          <Sparkles className="h-4 w-4" />
                        )}
                      </div>
                      {/* 用户消息靠右并加品牌色气泡；assistant 保持裸文本不加气泡 */}
                      <div
                        className={clsx(
                          "min-w-0 flex-1 pt-0.5",
                          isUser && "flex flex-col items-end",
                        )}
                      >
                        {msg.content ? (
                          isUser ? (
                            <div className="max-w-[85%] rounded-2xl bg-brand px-4 py-2.5 text-sm text-white [&_a]:text-white [&_code]:bg-black/20 [&_pre]:bg-black/30">
                              <Markdown content={msg.content} />
                            </div>
                          ) : (
                            <Markdown content={msg.content} />
                          )
                        ) : null}
                        {showCursor && <Loader2 className="h-4 w-4 animate-spin opacity-50" />}
                        {isUser && msg.attachments && msg.attachments.length > 0 && (
                          <MessageAttachments attachments={msg.attachments} onPreview={setPreview} />
                        )}
                      </div>
                      {!isUser && msg.content && (
                        <button
                          onClick={() => saveToMisconceptions(i, msg.content)}
                          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg opacity-0 transition-opacity hover:bg-[var(--muted)] focus:opacity-100 group-hover:opacity-100"
                          title="记入概念本"
                        >
                          <NotebookPen className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {notice && (
                <div
                  className="mt-5 flex items-start gap-2 rounded-xl px-4 py-2.5 text-xs"
                  style={{ background: "rgb(var(--brand-rgb) / 0.08)" }}
                >
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
                  <span className="min-w-0 flex-1">{notice}</span>
                  <button
                    onClick={() => setNotice(null)}
                    className="shrink-0 opacity-50 hover:opacity-100"
                    title="关闭"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              {error && (
                <div className="mt-5 flex items-start gap-2 rounded-xl border border-red-300/50 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          </div>

          <Composer
            streaming={streaming}
            disabled={hasKey === false}
            elevated={!hasMessages}
            sessionId={sessionId}
            settings={settings}
            onUpdated={setSettings}
            onSend={handleSend}
            onStop={handleStop}
          />

          <div
            aria-hidden="true"
            className="shrink-0"
            style={{
              flexGrow: hasMessages ? 0 : 1.4,
              transition: "flex-grow 650ms cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          />
        </div>

        {/* 图片放大预览 */}
        {preview && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8"
            onClick={() => setPreview(null)}
            title="点击关闭"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={api.attachmentFileUrl(preview.id)}
              alt={preview.filename}
              className="max-h-full max-w-full rounded-xl object-contain"
            />
          </div>
        )}
      </div>

      <RightRail
        open={rightOpen}
        storageKey={RIGHT_SIDEBAR_WIDTH_KEY}
        defaultWidth={RIGHT_SIDEBAR_DEFAULT_WIDTH}
        minWidth={RIGHT_SIDEBAR_MIN_WIDTH}
        maxWidth={RIGHT_SIDEBAR_MAX_WIDTH}
        testId="chat-right-sidebar"
        contentClassName="border-l"
      >
        <RightSidebar
          sessionId={sessionId}
          messageCount={messages.length}
          nodes={nodes}
          summarizing={summarizing}
          canSummarize={canSummarize}
          onSummarize={() => void handleSummary()}
        />
      </RightRail>
    </div>
  );
}

function MessageAttachments({
  attachments,
  onPreview,
}: {
  attachments: MessageAttachment[];
  onPreview: (attachment: MessageAttachment) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((a) =>
        a.kind === "image" ? (
          <button
            key={a.id}
            onClick={() => onPreview(a)}
            className="shrink-0 overflow-hidden rounded-lg border"
            style={{ borderColor: "var(--border)" }}
            title={`${a.filename}（点击放大）`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={api.attachmentFileUrl(a.id)}
              alt={a.filename}
              className="h-20 w-20 object-cover"
            />
          </button>
        ) : (
          <a
            key={a.id}
            href={api.attachmentFileUrl(a.id)}
            download={a.filename}
            className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors hover:bg-[var(--muted)]"
            style={{ borderColor: "var(--border)" }}
            title={`下载 ${a.filename}`}
          >
            <FileText className="h-3.5 w-3.5 shrink-0 opacity-60" />
            <span className="max-w-[12rem] truncate">{a.filename}</span>
            <span className="shrink-0 opacity-50">{formatFileSize(a.size)}</span>
          </a>
        ),
      )}
    </div>
  );
}
