"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  FileText,
  FolderOpen,
  Info,
  Loader2,
  NotebookPen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pencil,
  Sparkles,
  Trash2,
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
import { activeModelOf } from "./ModelSelector";
import { api, buildDraft, streamChat } from "@/lib/api";
import type { OrchestrationProgress } from "@/lib/api";
import { contextWindowOf } from "@/lib/contextWindow";
import { cleanAssistantText, formatFileSize } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import type {
  AppSettings,
  AttachmentKind,
  ChatMessage,
  GraphNode,
  MessageAttachment,
  SessionActive,
  ToolActivity,
  UploadedAttachment,
  Usage,
} from "@/lib/types";

/** 出站附件的最小形状：既有附件（MessageAttachment）与新上传（UploadedAttachment）都满足 */
type OutgoingAttachment = {
  id: string;
  filename: string;
  kind: AttachmentKind;
  size: number;
};

const GREETINGS: Record<"morning" | "afternoon" | "evening", string[]> = {
  morning: ["早上好，今天想弄懂什么？", "早安，学习的好时光。"],
  afternoon: ["下午好，继续加油！", "午后正是动手练习的好时候。"],
  evening: ["晚上好，夜色正适合学习。", "晚上好，今天进展如何？"],
};

const STARTERS = ["讲解一个概念", "出几道练习题", "按我的课程进度继续", "帮我制定学习计划"];
// 建课会话入口（§5.1 F 行）：建课会话注入 learning-system + learning-discovery，探索与盘问同会话
const DISCOVERY_STARTER = "不知道学什么，帮我选方向";
// 建课完成后的一键开课：不发新端点，走普通聊天把「产出第一课」交给智能体的 produce_lesson 工具
const FIRST_LESSON_PROMPT = "开始第一课：请按大纲顺序产出第一个节点，并告诉我产到哪了";

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

/**
 * 该草稿是否已有建课产物：会话里存在 slug 相同的 done 卡即视为建过。
 * done 卡由后端在建课收口时落库（production.py），所以刷新后判据仍在，
 * 「确认建课」按钮据此永久禁用，不靠一次性本地状态。
 */
function hasBuilt(slug: string, messages: ChatMessage[]): boolean {
  return messages.some((msg) => msg.kind === "done" && msg.slug === slug);
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
  // 编辑中的用户消息下标（就地变成编辑框；提交=从该句截断并重新生成）
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  // 「删除整轮」的内联二次确认（对照 DeepTutor：不再弹模态）
  const [confirmDeleteIndex, setConfirmDeleteIndex] = useState<number | null>(null);
  // 最近一轮的用量（右栏「上下文窗口」栏；历史会话从 meta.usage 回填）
  const [usage, setUsage] = useState<Usage | null>(null);
  // 会话绑定的模型/档位（null = 跟随全局默认；2026-10-04：模型按会话持久化）
  const [sessionActive, setSessionActive] = useState<SessionActive | null>(null);
  // 建课编排的实时进度（后端每几秒一份快照）：长时间派工时"在干活"要看得见
  const [buildProgress, setBuildProgress] = useState<OrchestrationProgress | null>(null);

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
  // 流式自动跟随：仅当用户本来就在底部附近时才贴底；一旦向上翻就停止跟随
  const stickToBottomRef = useRef(true);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const rightOpenRef = useRef(rightOpen);
  rightOpenRef.current = rightOpen;
  const renameCommitRef = useRef(false);

  const hasMessages = messages.length > 0;

  // 名称栏与右栏用量栏共用：生效的「提供商 / 模型」与上下文长度。
  // 会话绑定了模型就用会话的（2026-10-04：模型按会话持久化），否则用全局默认。
  const effectiveActive = sessionActive ?? settings?.active ?? null;
  const activeModelLabel = useMemo(() => {
    if (!settings || !effectiveActive) return null;
    const entry = settings.providers.find((p) => p.id === effectiveActive.provider_id);
    if (!entry) return null;
    return effectiveActive.model ? `${entry.name} / ${effectiveActive.model}` : entry.name;
  }, [settings, effectiveActive]);
  const activeContextWindow = useMemo(
    () => contextWindowOf(settings && effectiveActive ? activeModelOf(settings, effectiveActive) : null),
    [settings, effectiveActive],
  );

  // API Key 判据也按生效的三元组算：会话绑到没配 key 的提供商时输入框要如实禁用
  const hasKey: boolean | null = settings
    ? effectiveActive === null
      ? false
      : (settings.providers.find((p) => p.id === effectiveActive.provider_id)?.has_key ?? false)
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
    // 首屏/切会话一律从底部开始（与「用户手动上翻」区分开）
    stickToBottomRef.current = true;
    setActiveSessionId(loadedSession.meta.id);
    setSessionId(loadedSession.meta.id);
    setMessages(loadedSession.messages);
    setError(null);
    setNotice(null);
    setStreaming(false);
    setEditingIndex(null);
    setConfirmDeleteIndex(null);
    setUsage(loadedSession.meta.usage ?? null);
    // 恢复该会话绑定的模型/档位（新对话态下为 null = 跟随全局默认）
    setSessionActive(loadedSession.meta.active ?? null);
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
    // 新对话回到贴底跟随
    stickToBottomRef.current = true;
    setSessionId(null);
    setMessages([]);
    setError(null);
    setNotice(null);
    setStreaming(false);
    setEditingIndex(null);
    setConfirmDeleteIndex(null);
    setUsage(null);
    setSessionActive(null);
    // 新会话不继承上一会话的科目/节点（绑死语义：科目关联从干净状态开始）
    setActiveSubject(null, null);
    // 新对话默认折叠右侧边栏
    setRightOpen(false);
  }, [activeSessionId, setActiveSubject]);

  // 自动滚动到底部：只在用户本来就贴底时跟随，向上翻后不再被流式增量拉回
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, notice]);

  // 记录是否贴底：距底部 32px 以内算"粘着"，用户上翻即停止跟随
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 32;
  }, []);

  const appendKindMessage = useCallback((message: Partial<ChatMessage> & Pick<ChatMessage, "role" | "content">) => {
    setMessages((prev) => [...prev, message as ChatMessage]);
  }, []);

  const handleSend = useCallback(
    (
      text: string,
      attachments: OutgoingAttachment[] = [],
      opts: { mode?: "chat" | "interview"; fixtureScenario?: string; replaceFrom?: number } = {},
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

      // 乐观地先显示用户消息和一个空的 assistant 占位。
      // 编辑重发（replaceFrom）时先截断该下标起的本地消息——与后端 truncate 对齐。
      setMessages((prev) => {
        const base = opts.replaceFrom === undefined ? prev : prev.slice(0, opts.replaceFrom);
        return [
          ...base,
          metas.length > 0 ? { role: "user", content: text, attachments: metas } : { role: "user", content: text },
          { role: "assistant", content: "" },
        ];
      });

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

      // 思维链增量与生效用量都挂在最后一条 assistant 占位上（与 tools 同处「中间过程」）
      const patchReasoning = (piece: string) => {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant" && !last.kind) {
            next[next.length - 1] = { ...last, reasoning: (last.reasoning ?? "") + piece };
          }
          return next;
        });
      };

      // SSE 提示（绑定/图片降级/重试）：收进当前消息的「中间过程」折叠区，不再单独挂横幅
      const appendNoticeToMessage = (message: string) => {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant" && !last.kind) {
            next[next.length - 1] = { ...last, notices: [...(last.notices ?? []), message] };
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
          onReasoning: (piece) => patchReasoning(piece),
          onNotice: (message) => appendNoticeToMessage(message),
          onUsage: (next) => setUsage(next),
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
          // 编辑重发：服务端据此先截断旧消息再追加（普通发送不带该键）
          replaceFrom: opts.replaceFrom,
          signal: controller.signal,
        },
      ).catch((err) => {
        if (err.name !== "AbortError") setError(String(err));
        setStreaming(false);
      });
    },
    [sessionId, activeSubjectSlug, activeNodeId, activeWorkspace, setActiveSessionId, refreshSessions, appendKindMessage],
  );

  // 建课 done 卡上的「开始第一课」：不发新端点，复用普通发送路径，让智能体用 produce_lesson 工具产出
  const startFirstLesson = useCallback(() => {
    handleSend(FIRST_LESSON_PROMPT);
  }, [handleSend]);

  // 确认建课：草稿上跑建课编排（大纲+采图并行 → 门禁 → 落盘），进度播报进会话
  const startBuild = useCallback(
    (slug: string) => {
      if (building) return;
      setBuilding(true);
      setBuildProgress(null);
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
          setBuildProgress(null); // 有真事件了，进度快照让位给阶段卡
          if (payload.status === "done") mark(`✅ ${payload.stage}完成`, "stage");
          else if (payload.status === "fail") mark(`⚠ ${payload.stage}未过`, "stage");
        },
        onProgress: (payload) => setBuildProgress(payload),
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
      }, sessionId, orchestrationController.signal).finally(() => {
        setBuilding(false);
        setBuildProgress(null);
      });
    },
    [building, sessionId, appendKindMessage, refreshSubjects, refreshSessions],
  );

  // 落点确认：草稿整体搬进学习工作区；带上会话 id（后端据此写 subject_slug）
  const promoteDraftToWorkspace = useCallback(
    async (slug: string) => {
      setPromoting(true);
      setError(null);
      try {
        const res = await api.promoteDraft(slug, sessionId);
        setNotice(`已落盘到工作区：${res.subject_dir}`);
        appendKindMessage({ role: "assistant", content: `✅ 落点确认完成，科目「${slug}」已进入工作区。`, kind: "done" });
        void refreshSubjects();
        // 会话的科目关联由后端在 promote 时落库，这里刷新本地列表并选中新科目
        void refreshSessions();
        setActiveSubject(slug);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPromoting(false);
      }
    },
    [appendKindMessage, refreshSubjects, refreshSessions, sessionId, setActiveSubject],
  );

  const handleStop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  // 编辑重发：从该下标截断（本地 + 服务端），用编辑后的文本与附件重新生成回复。
  // 不做"改字不改答复"的原位编辑——语义就是"从这句话重新生成"。
  const submitEdit = useCallback(
    (index: number, text: string, attachments: OutgoingAttachment[]) => {
      setEditingIndex(null);
      handleSend(text, attachments, { replaceFrom: index });
    },
    [handleSend],
  );

  // 删除整轮：index 指向助手回复，服务端把该轮的用户消息与回复成对删掉（附件一并清理）
  const deleteTurnAt = useCallback(
    async (index: number) => {
      if (!sessionId) return;
      setConfirmDeleteIndex(null);
      try {
        const res = await api.deleteTurn(sessionId, index);
        setMessages(res.messages);
        void refreshSessions();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId, refreshSessions],
  );

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
            onScroll={handleScroll}
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
                  {/* 空态大图标：品牌图标（public/icon-192.png），比原来的 48px 放大一档 */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/icon-192.png"
                    alt="StudyMate"
                    className="mb-5 h-20 w-20 rounded-2xl shadow-xs"
                  />
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

              <div data-testid="chat-messages" className="flex flex-col gap-6">
                {messages.map((msg, i) => {
                  // 编排事件持久化成的消息卡（stage/handoff/done/error/build_confirm）
                  if (msg.kind) {
                    return (
                      <KindMessageCard
                        key={i}
                        message={msg}
                        building={building}
                        promoting={promoting}
                        streaming={streaming}
                        subjectReady={Boolean(msg.slug && subjects.some((s) => s.slug === msg.slug))}
                        built={Boolean(msg.slug && hasBuilt(msg.slug, messages))}
                        onConfirmBuild={() => msg.slug && startBuild(msg.slug)}
                        onPromote={() => msg.slug && void promoteDraftToWorkspace(msg.slug)}
                        onProduceFirstLesson={startFirstLesson}
                        onOpenTicket={() => msg.ticket_id && setInspectionTicketId(msg.ticket_id)}
                      />
                    );
                  }
                  const isUser = msg.role === "user";
                  const isLastAssistant = !isUser && i === messages.length - 1;
                  const isStreamingHere = streaming && isLastAssistant;
                  const showCursor = !msg.content && isStreamingHere && !msg.reasoning;
                  const isEditing = editingIndex === i;
                  const deleting = confirmDeleteIndex === i;
                  // 展示/复制/记入概念本统一用清洗后的文本：剥掉盘问收口标记、去掉首尾空行
                  const clean = isUser ? msg.content : cleanAssistantText(msg.content);
                  return (
                    <div
                      key={i}
                      className={clsx("group flex gap-3.5", isUser && "flex-row-reverse")}
                    >
                      {/* 消息头像 46px（2026-10-04 定档）；用户圆形、助手圆角方形。
                          空态欢迎区那个大图标是另一处（品牌图标），不随头像尺寸变动。 */}
                      <div
                        className={clsx(
                          "mt-0.5 flex h-[46px] w-[46px] shrink-0 items-center justify-center shadow-xs",
                          isUser ? "rounded-full" : "rounded-2xl",
                        )}
                        style={{
                          background: isUser ? "var(--muted)" : "rgb(var(--brand-rgb))",
                          color: isUser ? "var(--foreground)" : "#fff",
                        }}
                      >
                        {isUser ? (
                          <User className="h-6 w-6" />
                        ) : (
                          <Sparkles className="h-6 w-6" />
                        )}
                      </div>
                      {/* 用户消息靠右并加品牌色气泡；assistant 保持裸文本不加气泡 */}
                      <div
                        className={clsx(
                          "min-w-0 flex-1 pt-0.5",
                          isUser && "flex flex-col items-end",
                        )}
                      >
                        {/* 助手名称栏：显示产出这条回复的模型（历史消息用落库值，实时用当前生效模型） */}
                        {!isUser && (
                          <div
                            data-testid="assistant-name"
                            className="mb-1 max-w-full truncate text-[11px] font-medium opacity-50"
                          >
                            {msg.model ?? activeModelLabel ?? "StudyMate"}
                          </div>
                        )}
                        {/* 中间过程折叠区：只留思维链 + 本轮提示，默认收起；工具卡已移出，常显 */}
                        {!isUser && (
                          <ProcessPanel
                            reasoning={msg.reasoning}
                            tools={msg.tools}
                            notices={msg.notices}
                            streaming={isStreamingHere}
                          />
                        )}
                        {/* 工具调用卡：不再藏在折叠区里，流式期间与回放都直接可见 */}
                        {!isUser && msg.tools && msg.tools.length > 0 && <ToolCards tools={msg.tools} />}
                        {isEditing ? (
                          <UserMessageEditor
                            initialText={msg.content}
                            initialAttachments={msg.attachments ?? []}
                            sessionId={sessionId}
                            onSubmit={(text, attachments) => submitEdit(i, text, attachments)}
                            onCancel={() => setEditingIndex(null)}
                          />
                        ) : clean ? (
                          isUser ? (
                            <div className="max-w-[85%] rounded-2xl bg-brand px-4 py-2.5 text-sm text-white shadow-xs [&_a]:text-white [&_a]:underline [&_code]:bg-black/20 [&_pre]:bg-black/30">
                              <Markdown content={clean} />
                            </div>
                          ) : (
                            <div className="relative">
                              <Markdown content={clean} />
                              {isStreamingHere && (
                                <span className="ml-1 inline-block h-4 w-1.5 align-middle rounded-xs bg-brand animate-pulse" />
                              )}
                            </div>
                          )
                        ) : null}

                        {/* 消息操作条：用户=复制/编辑（小图标），助手=复制/记入概念本/删除本轮 */}
                        {!isEditing && (isUser || clean) && (
                          <div
                            className={clsx(
                              "mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
                              isUser && "justify-end",
                              deleting && "opacity-100",
                            )}
                          >
                            {isUser ? (
                              <>
                                <IconAction
                                  title="复制"
                                  testId="user-message-copy"
                                  onClick={() => handleCopyMessage(i, clean)}
                                >
                                  {copiedIndex === i ? (
                                    <Check className="h-3.5 w-3.5 text-brand" />
                                  ) : (
                                    <Copy className="h-3.5 w-3.5" />
                                  )}
                                </IconAction>
                                <IconAction
                                  title="编辑：从这条消息重新生成"
                                  testId="user-message-edit"
                                  disabled={streaming}
                                  onClick={() => {
                                    setConfirmDeleteIndex(null);
                                    setEditingIndex(i);
                                  }}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </IconAction>
                              </>
                            ) : deleting ? (
                              <span
                                data-testid="turn-delete-confirm"
                                className="flex items-center gap-2 rounded-md bg-red-500/10 px-2 py-0.5 text-[11px] text-red-600 dark:text-red-400"
                              >
                                删除本轮（问答一起删）？
                                <button
                                  type="button"
                                  data-testid="turn-delete-confirm-yes"
                                  onClick={() => void deleteTurnAt(i)}
                                  className="font-medium underline"
                                >
                                  删除
                                </button>
                                <button
                                  type="button"
                                  data-testid="turn-delete-confirm-no"
                                  onClick={() => setConfirmDeleteIndex(null)}
                                  className="opacity-70 hover:opacity-100"
                                >
                                  取消
                                </button>
                              </span>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleCopyMessage(i, clean)}
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
                                  onClick={() => saveToMisconceptions(i, clean)}
                                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--foreground)]/50 hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                                  title="记入概念本"
                                >
                                  <NotebookPen className="h-3 w-3" />
                                  <span>记入概念本</span>
                                </button>
                                <button
                                  type="button"
                                  data-testid="turn-delete"
                                  disabled={!sessionId || streaming}
                                  onClick={() => setConfirmDeleteIndex(i)}
                                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--foreground)]/50 hover:bg-red-500/10 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-red-400"
                                  title="删除本轮（用户提问与这条回复一起删）"
                                >
                                  <Trash2 className="h-3 w-3" />
                                  <span>删除本轮</span>
                                </button>
                              </>
                            )}
                          </div>
                        )}

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

              {/* 建课编排进行中的实时进度：长时间派工（实测单轮 126s）不再是"一片死寂" */}
              {buildProgress && (
                <div
                  data-testid="build-progress"
                  className="mt-5 flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs"
                  style={{ background: "var(--muted)" }}
                >
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-brand" />
                  <span data-testid="build-progress-text" className="min-w-0 flex-1 truncate">
                    {buildProgress.stage} · 第 {Math.max(1, buildProgress.round)} 轮 · 已等待{" "}
                    {Math.round(buildProgress.elapsed_s)}s
                    {buildProgress.tool_calls > 0
                      ? ` · 已调用 ${buildProgress.tool_calls} 次工具${
                          buildProgress.last_tool ? `（最近 ${buildProgress.last_tool}）` : ""
                        }`
                      : ""}
                    {buildProgress.reasoning_chars > 0
                      ? ` · 已思考 ${Math.max(1, Math.round(buildProgress.reasoning_chars / 1000))}k 字`
                      : ""}
                  </span>
                </div>
              )}

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
            sessionActive={sessionActive}
            onSessionActiveChange={setSessionActive}
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
          usage={usage}
          modelLabel={activeModelLabel}
          contextWindow={activeContextWindow}
        />
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
  streaming,
  subjectReady,
  built,
  onConfirmBuild,
  onPromote,
  onProduceFirstLesson,
  onOpenTicket,
}: {
  message: ChatMessage;
  building: boolean;
  promoting: boolean;
  streaming: boolean;
  /** 该 done 卡的科目是否已落进工作区（落点确认完成后为 true） */
  subjectReady: boolean;
  /** 该 confirm 卡的草稿是否已有建课产物（done 卡落库，刷新后仍为 true） */
  built: boolean;
  onConfirmBuild: () => void;
  onPromote: () => void;
  onProduceFirstLesson: () => void;
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
            disabled={building || built}
            className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-light disabled:cursor-not-allowed disabled:opacity-50"
          >
            {built ? (
              <Check className="h-3.5 w-3.5" />
            ) : building ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {built ? "已建课" : building ? "建课编排进行中…" : "确认建课"}
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
        <div className="flex flex-wrap items-center gap-2">
          <button
            data-testid="promote-button"
            onClick={onPromote}
            disabled={promoting || subjectReady}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {subjectReady ? "已进入工作区" : promoting ? "落盘中…" : "落点确认：搬进学习工作区"}
          </button>
          {/* 科目已落进工作区后：一键让智能体走工具产出第一课（只是发一条普通聊天消息） */}
          {subjectReady && (
            <button
              data-testid="produce-first-lesson"
              onClick={onProduceFirstLesson}
              disabled={streaming}
              className="rounded-lg border border-emerald-500/60 px-3 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/10 disabled:opacity-50 dark:text-emerald-400"
            >
              开始第一课
            </button>
          )}
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

/** 消息操作条上的小图标按钮（用户侧复制/编辑）：静默图标 + tooltip 文案。 */
function IconAction({
  title,
  testId,
  onClick,
  disabled,
  children,
}: {
  title: string;
  testId: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--foreground)]/50 transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * 中间过程折叠区（单层）：思维链 + 本轮提示，默认收起；工具卡已移到消息体里常显。
 * 落库后刷新仍可回放（reasoning / notices 存在会话消息里）；流式期间表头显示进行中状态。
 * 若两者都没有则整块不渲染（不留空面板）。tools 仅用于表头文案（如「正在调用工具…」）。
 */
function ProcessPanel({
  reasoning,
  tools,
  notices,
  streaming,
}: {
  reasoning?: string;
  tools?: ToolActivity[];
  notices?: string[];
  streaming: boolean;
}) {
  const hasReasoning = Boolean(reasoning && reasoning.trim());
  const toolCount = tools?.length ?? 0;
  const noticeCount = notices?.length ?? 0;
  const running = Boolean(streaming && tools?.some((tool) => tool.status === "running"));
  // 面板本体只承载思维链 + 提示：两者都没有就不渲染空面板
  if (!hasReasoning && noticeCount === 0) return null;

  const parts: string[] = [];
  if (hasReasoning) parts.push("思考");
  if (toolCount > 0) parts.push(`${toolCount} 次工具调用`);
  if (parts.length === 0) parts.push("提示");
  const label = running
    ? "正在调用工具…"
    : streaming && hasReasoning && toolCount === 0
      ? "正在思考…"
      : `中间过程 · ${parts.join(" · ")}`;

  return (
    <details
      data-testid="process-panel"
      className="group mb-2 rounded-xl border text-xs"
      style={{ borderColor: "var(--border)", background: "var(--muted)" }}
    >
      <summary
        data-testid="process-summary"
        className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 opacity-70 transition-opacity hover:opacity-100"
      >
        <Brain className={clsx("h-3 w-3 shrink-0", streaming && "text-brand")} />
        <span data-testid="process-label" className="min-w-0 truncate">
          {label}
        </span>
        <ChevronDown className="ml-auto h-3 w-3 shrink-0 opacity-60 transition-transform group-open:rotate-180" />
      </summary>
      <div
        className="flex flex-col gap-2 border-t px-3 py-2"
        style={{ borderColor: "var(--border)" }}
      >
        {noticeCount > 0 && (
          <ul data-testid="process-notices" className="flex flex-col gap-0.5 opacity-70">
            {notices!.map((item, index) => (
              <li key={index}>· {item}</li>
            ))}
          </ul>
        )}
        {hasReasoning && (
          <div
            data-testid="process-reasoning"
            className="max-h-64 overflow-y-auto break-words opacity-60"
          >
            <Markdown content={reasoning!} />
          </div>
        )}
      </div>
    </details>
  );
}

/**
 * 用户消息的就地编辑框（编辑=从这条消息重新生成）：
 * 文本可改，附件可增删（原有附件默认保留、可移除，也能追加新上传）。
 */
function UserMessageEditor({
  initialText,
  initialAttachments,
  sessionId,
  onSubmit,
  onCancel,
}: {
  initialText: string;
  initialAttachments: MessageAttachment[];
  sessionId: string | null;
  onSubmit: (text: string, attachments: OutgoingAttachment[]) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] = useState<OutgoingAttachment[]>(initialAttachments);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);

  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setError(null);
    setUploading((count) => count + list.length);
    for (const file of list) {
      void api
        .uploadAttachment(file, sessionId)
        .then((res) =>
          setAttachments((prev) => [
            ...prev,
            { id: res.id, filename: res.filename, kind: res.kind, size: res.size },
          ]),
        )
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setUploading((count) => count - 1));
    }
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed, attachments);
  };

  return (
    <div
      data-testid="message-edit-box"
      className="w-full max-w-[85%] rounded-2xl border bg-[var(--surface-card)] p-3 shadow-card"
      style={{ borderColor: "var(--border)" }}
    >
      <textarea
        ref={textareaRef}
        data-testid="message-edit-input"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const el = e.target;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={2}
        className="w-full resize-none bg-transparent text-sm outline-none"
      />

      {attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {attachments.map((attachment) => (
            <span
              key={attachment.id}
              data-testid="message-edit-attachment"
              className="flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px]"
              style={{ borderColor: "var(--border)" }}
            >
              <FileText className="h-3 w-3 shrink-0 opacity-60" />
              <span className="max-w-[10rem] truncate">{attachment.filename}</span>
              <button
                type="button"
                title={`移除 ${attachment.filename}`}
                aria-label={`移除 ${attachment.filename}`}
                onClick={() =>
                  setAttachments((prev) => prev.filter((item) => item.id !== attachment.id))
                }
                className="flex h-4 w-4 items-center justify-center rounded opacity-50 hover:bg-[var(--muted)] hover:opacity-100"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <p className="mt-1.5 text-[11px] text-red-500">{error}</p>}

      <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            data-testid="message-edit-add-file"
            onClick={() => fileInputRef.current?.click()}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--foreground)]/60 hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            title="添加附件"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>
          {uploading > 0 && <Loader2 className="h-3 w-3 animate-spin opacity-60" />}
          <span className="text-[11px] opacity-50">编辑后发送＝从这条消息重新生成回复</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="message-edit-cancel"
            onClick={onCancel}
            className="rounded-lg px-2.5 py-1 text-[11px] opacity-70 transition-colors hover:bg-[var(--muted)] hover:opacity-100"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="message-edit-submit"
            onClick={submit}
            disabled={!text.trim() || uploading > 0}
            className="rounded-lg bg-brand px-3 py-1 text-[11px] font-medium text-white transition-colors hover:bg-brand-light disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>
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
