"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  FileText,
  FolderOpen,
  Info,
  Loader2,
  NotebookPen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Sparkles,
  User,
  Wrench,
  X,
} from "lucide-react";
import clsx from "clsx";
import Markdown from "./Markdown";
import { Composer } from "./Composer";
import { InspectionDialog } from "./InspectionDialog";
import { RightRail } from "./RightRail";
import { RightSidebar } from "./RightSidebar";
import { api, buildDraft, streamChat } from "@/lib/api";
import { formatFileSize } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import type {
  AppSettings,
  ChatMessage,
  GraphNode,
  MessageAttachment,
  ToolActivity,
  UploadedAttachment,
} from "@/lib/types";

const GREETINGS: Record<"morning" | "afternoon" | "evening", string[]> = {
  morning: ["早上好，今天想弄懂什么？", "早安，学习的好时光。"],
  afternoon: ["下午好，继续加油！", "午后正是动手练习的好时候。"],
  evening: ["晚上好，夜色正适合学习。", "晚上好，今天进展如何？"],
};

const STARTERS = ["讲解一个概念", "出几道练习题", "按我的课程进度继续", "帮我制定学习计划"];
// 建课会话入口（§5.1 F 行）：建课会话注入 learning-system + learning-discovery，探索与盘问同会话
const DISCOVERY_STARTER = "不知道学什么，帮我选方向";

// 右侧边栏宽度：默认 256px（原 w-64），可拖拽范围 200–480px，键与课程页互不干扰
const RIGHT_SIDEBAR_WIDTH_KEY = "studymate-chat-right-sidebar-width";
const RIGHT_SIDEBAR_DEFAULT_WIDTH = 256;
const RIGHT_SIDEBAR_MIN_WIDTH = 200;
const RIGHT_SIDEBAR_MAX_WIDTH = 480;

// 右侧边栏折叠态按会话持久化：新对话始终默认折叠，已有会话各自记住折叠状态
const rightOpenKey = (id: string) => `studymate-chat-right-sidebar-open:${id}`;
function readRightOpen(id: string): boolean | null {
  try {
    const raw = localStorage.getItem(rightOpenKey(id));
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    // localStorage 不可用时走默认
  }
  return null;
}
function writeRightOpen(id: string, open: boolean): void {
  try {
    localStorage.setItem(rightOpenKey(id), open ? "1" : "0");
  } catch {
    // localStorage 不可用时仅本次会话生效
  }
}

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
    activeWorkspace,
    setActiveWorkspace,
    workspaceCandidates,
    setActiveSessionId,
    setActiveSubject,
    loadedSession,
    clearLoadedSession,
    refreshSessions,
    refreshSubjects,
    renameSession,
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
  // 右侧边栏折叠态：新对话默认折叠；已有会话按 id 恢复其持久化值
  const [rightOpen, setRightOpen] = useState(false);
  // 建课编排（confirm 卡 → build 流 → done 卡 → 落点确认）
  const [building, setBuilding] = useState(false);
  const [promoting, setPromoting] = useState(false);
  // 质检工单模态（handoff 卡入口）
  const [inspectionTicketId, setInspectionTicketId] = useState<string | null>(null);
  // 顶栏内联重命名（随标题）；Enter 提交，Esc / 失焦取消
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  // 消息复制反馈
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleCopyMessage = useCallback((index: number, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 1500);
  }, []);

  const toggleRight = useCallback(() => {
    setRightOpen((v) => {
      const next = !v;
      // 新对话不做持久化（始终默认折叠）；已有会话记住自己的折叠态
      if (sessionIdRef.current) writeRightOpen(sessionIdRef.current, next);
      return next;
    });
  }, []);

  const abortRef = useRef<AbortController | null>(null);
  const orchestrationAbortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const rightOpenRef = useRef(rightOpen);
  rightOpenRef.current = rightOpen;
  const renameCommitRef = useRef(false);

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

  // 顶栏内联重命名：按钮紧随标题，位置随标题文本长度浮动
  const startRename = useCallback(() => {
    if (!sessionId) return;
    renameCommitRef.current = false;
    setRenameValue(sessionTitle);
    setRenaming(true);
  }, [sessionId, sessionTitle]);

  const commitRename = useCallback(async () => {
    if (renameCommitRef.current) return;
    renameCommitRef.current = true;
    setRenaming(false);
    const title = renameValue.trim();
    if (!sessionId || !title || title === sessionTitle) return;
    try {
      await renameSession(sessionId, title);
    } catch {
      // 失败时保留原标题
    }
  }, [renameValue, sessionId, sessionTitle, renameSession]);

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
      .getCourse(activeSubjectSlug, activeWorkspace)
      .then((detail) => {
        if (alive) setNodes(detail.graph.nodes);
      })
      .catch(() => {
        if (alive) setNodes([]);
      });
    return () => {
      alive = false;
    };
  }, [activeSubjectSlug, activeWorkspace]);

  // 消费打开的历史会话：替换消息与会话 id，并恢复科目/节点上下文
  useEffect(() => {
    if (!loadedSession) return;
    abortRef.current?.abort();
    orchestrationAbortRef.current?.abort();
    setBuilding(false);
    setActiveSessionId(loadedSession.meta.id);
    setSessionId(loadedSession.meta.id);
    setMessages(loadedSession.messages);
    setError(null);
    setNotice(null);
    setStreaming(false);
    setActiveSubject(loadedSession.meta.subject_slug, loadedSession.meta.node_id);
    // 恢复该会话自己的右侧栏折叠状态（无记忆时默认展开）
    setRightOpen(readRightOpen(loadedSession.meta.id) ?? true);
    clearLoadedSession();
  }, [loadedSession, clearLoadedSession, setActiveSessionId, setActiveSubject]);

  // activeSessionId 变为 null（新对话/删除当前会话）时清空本地消息
  useEffect(() => {
    if (activeSessionId !== null) return;
    abortRef.current?.abort();
    orchestrationAbortRef.current?.abort();
    setBuilding(false);
    setSessionId(null);
    setMessages([]);
    setError(null);
    setNotice(null);
    setStreaming(false);
    // 新会话不继承上一会话的科目/节点（绑死语义：科目关联从干净状态开始）
    setActiveSubject(null, null);
    // 新对话默认折叠右侧边栏
    setRightOpen(false);
  }, [activeSessionId, setActiveSubject]);

  // 自动滚动到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, notice]);

  const appendKindMessage = useCallback((message: Partial<ChatMessage> & Pick<ChatMessage, "role" | "content">) => {
    setMessages((prev) => [...prev, message as ChatMessage]);
  }, []);

  const handleSend = useCallback(
    (
      text: string,
      attachments: UploadedAttachment[] = [],
      opts: { mode?: "chat" | "interview"; fixtureScenario?: string } = {},
    ) => {
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
          // kind 卡（编排播报）不吃聊天 delta
          if (last && last.role === "assistant" && !last.kind) {
            next[next.length - 1] = { ...last, content: patch(last.content) };
          }
          return next;
        });
      };

      // 工具卡（K0）：挂在最后一条 assistant 占位上，随流式更新
      const patchTools = (patch: (tools: ToolActivity[]) => ToolActivity[]) => {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant" && !last.kind) {
            next[next.length - 1] = { ...last, tools: patch(last.tools ?? []) };
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
            // 新对话晋升为已有会话：沿用当前折叠态并落盘，后续切回时保持一致
            writeRightOpen(id, rightOpenRef.current);
          },
          onDelta: (piece) => {
            assistantBuffer += piece;
            patchAssistant((c) => c + piece);
          },
          onNotice: (message) => setNotice(message),
          onToolCall: ({ id, name, arguments: args }) => {
            patchTools((tools) => [
              ...tools,
              { id, name, arguments: args, status: "running" },
            ]);
          },
          onToolResult: ({ id, name, content, is_error }) => {
            patchTools((tools) => {
              const index = tools.findIndex((tool) => tool.id === id);
              const resolved: ToolActivity = {
                id,
                name,
                arguments: index >= 0 ? tools[index].arguments : "",
                status: is_error ? "error" : "done",
                result: content,
                isError: is_error,
              };
              if (index < 0) return [...tools, resolved];
              const next = [...tools];
              next[index] = { ...next[index], ...resolved };
              return next;
            });
          },
          onConfirm: (payload) => {
            // 盘问收口：后端已建草稿并持久化确认卡，本地同步追加
            appendKindMessage({
              role: "assistant",
              content: `盘问完成，已为「${payload.name}」建好草稿。确认后开始建课编排。`,
              kind: "build_confirm",
              slug: payload.slug,
            });
            void refreshSessions();
          },
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
          // 建课会话不带科目关联（键整体省略，后端 mode 保持 interview）
          subjectSlug: opts.mode === "interview" ? undefined : activeSubjectSlug,
          nodeId: opts.mode === "interview" ? undefined : activeNodeId,
          // 会话级工作区：仅新建会话时生效
          workspace: activeWorkspace,
          attachments: attachments.map((a) => a.id),
          mode: opts.mode ?? null,
          // E2E 专用：fixture 模式下按请求选固定流场景（建课会话用 interview 场景拿收口标记）
          fixtureScenario: opts.fixtureScenario ?? (opts.mode === "interview" ? "interview" : null),
          signal: controller.signal,
        },
      ).catch((err) => {
        if (err.name !== "AbortError") setError(String(err));
        setStreaming(false);
      });
    },
    [sessionId, activeSubjectSlug, activeNodeId, activeWorkspace, setActiveSessionId, refreshSessions, appendKindMessage],
  );

  // 确认建课：草稿上跑建课编排（大纲+采图并行 → 门禁 → 落盘），进度播报进会话
  const startBuild = useCallback(
    (slug: string) => {
      if (building) return;
      setBuilding(true);
      setError(null);
      const orchestrationController = new AbortController();
      orchestrationAbortRef.current = orchestrationController;
      const mark = (content: string, kind: ChatMessage["kind"]) => appendKindMessage({ role: "assistant", content, kind });
      mark("⚙ 开始建课编排：大纲与采图并行…", "stage");
      buildDraft(slug, {
        onSession: (id) => {
          if (!sessionId) {
            setSessionId(id);
            setActiveSessionId(id);
            writeRightOpen(id, rightOpenRef.current);
          }
        },
        onStage: (payload) => {
          if (payload.status === "done") mark(`✅ ${payload.stage}完成`, "stage");
          else if (payload.status === "fail") mark(`⚠ ${payload.stage}未过`, "stage");
        },
        onRetry: (payload) =>
            mark(
                `🔁 第 ${payload.round} 轮打回（${payload.owners.join("、")}）${
                    payload.reason ? `：${payload.reason}` : ""
                }`,
                "stage",
            ),
        onHandoff: (payload) =>
          appendKindMessage({
            role: "assistant",
            content: `质检未过，已转人工（工单 ${payload.ticket.id}）`,
            kind: "handoff",
            ticket_id: payload.ticket.id,
          }),
        onDone: (payload) => {
          // 必须带 slug：落点确认按钮（build-done-card）靠它出现
          appendKindMessage({
            role: "assistant",
            content: payload.message || "建课完成",
            kind: "done",
            slug: payload.slug,
          });
          void refreshSubjects();
          void refreshSessions();
        },
        onError: (message) => {
          mark(message, "error");
          void refreshSessions();
        },
      }, sessionId, orchestrationController.signal).finally(() => setBuilding(false));
    },
    [building, sessionId, appendKindMessage, refreshSubjects, refreshSessions],
  );

  // 落点确认：草稿整体搬进学习工作区
  const promoteDraftToWorkspace = useCallback(
    async (slug: string) => {
      setPromoting(true);
      setError(null);
      try {
        const res = await api.promoteDraft(slug);
        setNotice(`已落盘到工作区：${res.subject_dir}`);
        appendKindMessage({ role: "assistant", content: `✅ 落点确认完成，科目「${slug}」已进入工作区。`, kind: "done" });
        void refreshSubjects();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPromoting(false);
      }
    },
    [appendKindMessage, refreshSubjects],
  );

  const handleStop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

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

  // 小结（生成小结）与「沉淀记忆」的 UI 入口已按 2026-10-04 拍板移除（功能悬空，后端保留）。
  // 相关代码：MemoryDialog.tsx / api.generateSessionSummary / api.suggestMemory 均未删除，
  // 重新接入时在输入区或消息操作条上挂回入口即可。
  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：标题 + 紧随其后的重命名按钮，右侧是右栏折叠开关 */}
        <div
          data-testid="chat-topbar"
          className="flex items-center justify-between gap-3 border-b px-5 py-3"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {renaming ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    renameCommitRef.current = true;
                    setRenaming(false);
                  }
                }}
                aria-label="重命名会话"
                data-testid="chat-title-input"
                className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-0.5 text-sm outline-none focus:border-brand-light"
                style={{ borderColor: "var(--border)" }}
              />
            ) : (
              <>
                <span data-testid="chat-title" className="min-w-0 truncate text-sm font-medium">
                  {sessionTitle}
                </span>
                {sessionId && (
                  <button
                    onClick={startRename}
                    title="重命名会话"
                    aria-label="重命名会话"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-50 transition-opacity hover:bg-[var(--muted)] hover:opacity-100"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </>
            )}
          </div>
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

        {/* 消息区 + 输入区：外层弹性占位实现两态落底过渡 */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            className="min-h-0 overflow-y-auto mask-edge-fade"
            style={{
              flexGrow: hasMessages ? 1 : 0,
              flexShrink: 1,
              transition: "flex-grow 650ms cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          >
            <div className="mx-auto max-w-3xl px-5 py-6">
              {!hasMessages && (
                <div className="flex flex-col items-center py-12 text-center">
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10 text-brand shadow-xs">
                    <Sparkles className="h-6 w-6" />
                  </div>
                  <h1 className="mb-2.5 font-serif text-3xl sm:text-4xl font-medium tracking-tight text-[var(--foreground)]">
                    {greeting}
                  </h1>
                  <p className="mb-7 max-w-md text-sm text-[var(--foreground)]/60 leading-relaxed">
                    StudyMate 会陪你讲概念、做练习、跑项目。直接输入问题，或从下面的起点开始。
                  </p>
                  <div className="flex max-w-[720px] flex-wrap justify-center gap-2.5">
                    {STARTERS.map((s) => (
                      <button
                        key={s}
                        onClick={() => handleSend(s)}
                        className="rounded-full border border-[var(--border)] bg-[var(--surface-card)] px-4 py-2 text-sm text-[var(--foreground)]/85 shadow-xs transition-all hover:border-brand/40 hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)]"
                      >
                        {s}
                      </button>
                    ))}
                    <button
                      data-testid="discovery-starter"
                      onClick={() => handleSend(DISCOVERY_STARTER, [], { mode: "interview" })}
                      className="rounded-full border border-brand/40 bg-brand/5 px-4 py-2 text-sm font-medium text-brand shadow-xs transition-all hover:bg-brand/10"
                      title="进入建课会话：先聊方向，盘问结束后建课"
                    >
                      {DISCOVERY_STARTER}
                    </button>
                  </div>
                </div>
              )}

              {/* 工作区引导块已移除（2026-10-04 拍板）：工作区选择改到新对话态输入区上方的关联行 */}

              <div className="flex flex-col gap-6">
                {messages.map((msg, i) => {
                  // 编排事件持久化成的消息卡（stage/handoff/done/error/build_confirm）
                  if (msg.kind) {
                    return (
                      <KindMessageCard
                        key={i}
                        message={msg}
                        building={building}
                        promoting={promoting}
                        onConfirmBuild={() => msg.slug && startBuild(msg.slug)}
                        onPromote={() => msg.slug && void promoteDraftToWorkspace(msg.slug)}
                        onOpenTicket={() => msg.ticket_id && setInspectionTicketId(msg.ticket_id)}
                      />
                    );
                  }
                  const isUser = msg.role === "user";
                  const isLastAssistant = !isUser && i === messages.length - 1;
                  const showCursor = !msg.content && streaming && isLastAssistant;
                  return (
                    <div
                      key={i}
                      className={clsx("group flex gap-3.5", isUser && "flex-row-reverse")}
                    >
                      <div
                        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl shadow-xs"
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
                        {!isUser && msg.tools && msg.tools.length > 0 && (
                          <ToolCards tools={msg.tools} />
                        )}
                        {msg.content ? (
                          isUser ? (
                            <div className="max-w-[85%] rounded-2xl bg-brand px-4 py-2.5 text-sm text-white shadow-xs [&_a]:text-white [&_a]:underline [&_code]:bg-black/20 [&_pre]:bg-black/30">
                              <Markdown content={msg.content} />
                            </div>
                          ) : (
                            <div className="relative">
                              <Markdown content={msg.content} />
                              {streaming && isLastAssistant && (
                                <span className="ml-1 inline-block h-4 w-1.5 align-middle rounded-xs bg-brand animate-pulse" />
                              )}
                              {/* 助手消息悬停操作条 */}
                              <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                                <button
                                  type="button"
                                  onClick={() => handleCopyMessage(i, msg.content)}
                                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--foreground)]/50 hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                                  title="复制回答"
                                >
                                  {copiedIndex === i ? (
                                    <>
                                      <Check className="h-3 w-3 text-brand" />
                                      <span className="text-brand">已复制</span>
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="h-3 w-3" />
                                      <span>复制</span>
                                    </>
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => saveToMisconceptions(i, msg.content)}
                                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--foreground)]/50 hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                                  title="记入概念本"
                                >
                                  <NotebookPen className="h-3 w-3" />
                                  <span>记入概念本</span>
                                </button>
                              </div>
                            </div>
                          )
                        ) : null}
                        {showCursor && (
                          <div className="flex items-center gap-2 py-1 text-sm text-[var(--foreground)]/60">
                            <Loader2 className="h-4 w-4 animate-spin text-brand" />
                            <span className="text-xs">StudyMate 正在思考…</span>
                          </div>
                        )}
                        {isUser && msg.attachments && msg.attachments.length > 0 && (
                          <MessageAttachments attachments={msg.attachments} onPreview={setPreview} />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {notice && (
                <div
                  data-testid="chat-notice"
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

          {/* 新对话态关联行：输入框上方左侧，「关联科目」+「工作区」并排。
              只在新对话（还没有会话）时出现；发出第一条消息成了正式会话就隐藏。
              工作区默认「不选」= 用当前默认工作区；选中后会重载该工作区的科目列表。 */}
          {sessionId === null && (
            <div data-testid="new-session-association" className="px-4 pt-3">
              <div
                className={clsx(
                  "mx-auto flex flex-wrap items-center gap-3",
                  hasMessages ? "max-w-3xl" : "max-w-[720px]",
                )}
              >
                <label className="flex items-center gap-1.5 text-xs">
                  <span className="shrink-0 text-[11px] text-[var(--foreground)]/50">科目</span>
                  <select
                    value={activeSubjectSlug ?? ""}
                    onChange={(e) => {
                      const value = e.target.value;
                      setActiveSubject(value === "" ? null : value, null);
                    }}
                    title="关联科目"
                    data-testid="new-session-subject"
                    className="min-w-0 max-w-[12rem] truncate rounded-lg border border-[var(--border)] bg-transparent px-2 py-1 text-xs outline-none focus:border-brand"
                  >
                    <option value="">不关联</option>
                    {subjects.map((s) => (
                      <option key={s.slug} value={s.slug}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-1.5 text-xs">
                  <FolderOpen className="h-3 w-3 shrink-0 opacity-50" />
                  <span className="shrink-0 text-[11px] text-[var(--foreground)]/50">工作区</span>
                  <select
                    value={activeWorkspace ?? ""}
                    onChange={(e) => {
                      const value = e.target.value;
                      setActiveWorkspace(value === "" ? null : value);
                      // 换工作区后原先的科目可能不在新工作区里，重置关联
                      setActiveSubject(null, null);
                    }}
                    title="关联工作区"
                    data-testid="new-session-workspace"
                    className="min-w-0 max-w-[18rem] truncate rounded-lg border border-[var(--border)] bg-transparent px-2 py-1 text-xs outline-none focus:border-brand"
                  >
                    <option value="">默认工作区</option>
                    {workspaceCandidates.map((path) => (
                      <option key={path} value={path}>
                        {path}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          )}

          <Composer
            streaming={streaming || building}
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
        <RightSidebar sessionId={sessionId} messageCount={messages.length} />
      </RightRail>

      {/* 质检工单（handoff 卡入口） */}
      {inspectionTicketId && (
        <InspectionDialog
          ticketId={inspectionTicketId}
          sessionId={sessionId}
          onClose={() => setInspectionTicketId(null)}
        />
      )}
    </div>
  );
}

/** 编排事件持久化消息的卡片形态（§5.1 C 行拍板⑦④：阶段播报 + 失败卡 + 确认卡）。 */
function KindMessageCard({
  message,
  building,
  promoting,
  onConfirmBuild,
  onPromote,
  onOpenTicket,
}: {
  message: ChatMessage;
  building: boolean;
  promoting: boolean;
  onConfirmBuild: () => void;
  onPromote: () => void;
  onOpenTicket: () => void;
}) {
  const { kind, content } = message;
  if (kind === "handoff") {
    return (
      <div
        data-testid="handoff-card"
        className="flex flex-col gap-2 rounded-xl border border-amber-400/50 bg-amber-500/10 px-4 py-3"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {content}
        </div>
        <div>
          <button
            data-testid="handoff-open"
            onClick={onOpenTicket}
            className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-600"
          >
            查看质检报告
          </button>
        </div>
      </div>
    );
  }
  if (kind === "build_confirm") {
    return (
      <div
        data-testid="build-confirm-card"
        className="flex flex-col gap-2 rounded-xl border px-4 py-3"
        style={{ borderColor: "rgb(var(--brand-rgb) / 0.5)", background: "rgb(var(--brand-rgb) / 0.06)" }}
      >
        <div className="text-sm">{content}</div>
        <div>
          <button
            data-testid="build-confirm-button"
            onClick={onConfirmBuild}
            disabled={building}
            className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-light disabled:opacity-50"
          >
            {building ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {building ? "建课编排进行中…" : "确认建课"}
          </button>
        </div>
      </div>
    );
  }
  if (kind === "done" && message.slug) {
    // 建课 done：带落点确认动作
    return (
      <div
        data-testid="build-done-card"
        className="flex flex-col gap-2 rounded-xl border border-emerald-400/50 bg-emerald-500/10 px-4 py-3"
      >
        <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {content}
        </div>
        <div>
          <button
            data-testid="promote-button"
            onClick={onPromote}
            disabled={promoting}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
          >
            {promoting ? "落盘中…" : "落点确认：搬进学习工作区"}
          </button>
        </div>
      </div>
    );
  }
  const isError = kind === "error";
  return (
    <div
      data-testid={isError ? "orchestration-error" : "orchestration-stage"}
      className={clsx(
        "rounded-xl px-4 py-2 text-xs",
        isError ? "border border-red-300/50 bg-red-500/10 text-red-600 dark:text-red-400" : "opacity-80",
      )}
      style={isError ? undefined : { background: "var(--muted)" }}
    >
      {content}
    </div>
  );
}

/** 工具调用卡（K0）：可展开的调用 + 结果，兼作审计视图。 */
function ToolCards({ tools }: { tools: ToolActivity[] }) {
  return (
    <div data-testid="tool-cards" className="mb-2 flex flex-col gap-1.5">
      {tools.map((tool) => (
        <details
          key={tool.id}
          data-testid="tool-card"
          className="rounded-lg border px-2.5 py-1.5 text-xs"
          style={{ borderColor: "var(--border)", background: "var(--muted)" }}
        >
          <summary className="flex cursor-pointer list-none items-center gap-1.5">
            {tool.status === "running" ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-brand" />
            ) : tool.status === "error" ? (
              <AlertCircle className="h-3 w-3 shrink-0 text-amber-500" />
            ) : (
              <Wrench className="h-3 w-3 shrink-0 text-emerald-500" />
            )}
            <span className="font-medium" data-testid="tool-name">
              {tool.name}
            </span>
            <span className="opacity-50">
              {tool.status === "running" ? "调用中…" : tool.status === "error" ? "返回错误" : "完成"}
            </span>
          </summary>
          <div className="mt-1.5 space-y-1">
            <div className="break-all">
              <span className="opacity-60">参数：</span>
              <code>{tool.arguments || "{}"}</code>
            </div>
            {tool.result !== undefined && (
              <pre
                data-testid="tool-result"
                className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/5 p-1.5 text-[11px] dark:bg-white/5"
              >
                {tool.result}
              </pre>
            )}
          </div>
        </details>
      ))}
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
