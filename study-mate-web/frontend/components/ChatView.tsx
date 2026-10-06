"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  BookOpen,
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
import { ErrorNotice } from "./ErrorNotice";
import { InspectionDialog } from "./InspectionDialog";
import { ProductionTaskCard, lessonHref } from "./ProductionTaskCard";
import { RightRail } from "./RightRail";
import { RightSidebar } from "./RightSidebar";
import { activeModelOf, effectiveActiveOf } from "./ModelSelector";
import { api, buildDraft, normalizeError } from "@/lib/api";
import { forgetChatRun, getChatRun, recoverChatRun, retryChatSync, startChatRun, stopChatRun, subscribeChatRuns } from "@/lib/chatStream";
import type { OrchestrationProgress } from "@/lib/api";
import { contextWindowOf } from "@/lib/contextWindow";
import { cleanAssistantParts, cleanAssistantText, formatFileSize } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import type {
  AppSettings,
  AssessmentOutcome,
  AttachmentKind,
  ChatMessage,
  ErrorInfo,
  GraphNode,
  LessonLink,
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
// 方向探索入口（§5.1 F 行）：2026-10-05 拍板③后只负责把这句话填进输入框；发出后由
// 智能体经 start_course_interview 工具把会话切入建课盘问（普通会话可中途进入建课会话），
// 前端不再直接以 interview 模式开会话。
const DISCOVERY_STARTER = "不知道学什么，帮我选方向";
// 建课完成后的一键开课：不发新端点，走普通聊天把「产出第一课」交给智能体的 produce_lesson 工具
const FIRST_LESSON_PROMPT = "开始第一课";

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

/**
 * 用户消息的展示原文（R7）：有 display_content 就显示/编辑它（可能是空串），
 * 否则回落 content（旧消息）。复制 / 气泡 / 编辑框 / 概念本 / regenerate 都走这里，
 * 助手消息不适用（仍用 content / cleanAssistantText）。
 */
function userDisplayText(msg: Pick<ChatMessage, "content" | "display_content">): string {
  return msg.display_content ?? msg.content;
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
    openSession,
    setBuildingSessionId,
    refreshSessions,
    refreshSubjects,
    renameSession,
    setMisconceptionDraft,
  } = useWorkspace();
  const router = useRouter();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<ErrorInfo | string | null>(null);
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
  // 服务端刚为本轮新建的会话 id（用于让草稿迁移只发生在"真新会话"，手动切历史会话不迁移）。
  // 必须与 setSessionId 同批更新，hook 才能在同一次 render 里看到标记。
  const [adoptedNewDraftId, setAdoptedNewDraftId] = useState<string | null>(null);

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

  const viewEpochRef = useRef(0);
  const mountedRef = useRef(true);
  const orchestrationAbortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 流式自动跟随：仅当用户本来就在底部附近时才贴底；一旦向上翻就停止跟随
  const stickToBottomRef = useRef(true);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const rightOpenRef = useRef(rightOpen);
  rightOpenRef.current = rightOpen;
  const renameCommitRef = useRef(false);
  // Composer 的填充句柄：开场选项把文本填进输入框（不直接发送，2026-10-05 拍板③）
  const composerFillRef = useRef<{ fill: (text: string) => void } | null>(null);

  // 会话同步门锁：编辑/删除/发送都依赖「本地消息与服务端 1:1」。编排结束会回灌服务端消息；
  // 回灌进行中或失败期间禁用危险的消息操作（含发送），避免在错位状态下传下标。
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const unsynced = syncing || syncError !== null;
  const unsyncedRef = useRef(false);
  unsyncedRef.current = unsynced;
  // 消息变更纪元：载入会话 / 新建对话 / 发送 / 建课 / 删除都会 bump。
  // 回灌在 await 返回后若纪元已变（有更新的消息变更），则作废这份可能过时的服务端快照。
  const mutationEpochRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  const hasMessages = messages.length > 0;

  // 名称栏与右栏用量栏共用：生效的「提供商 / 模型」与上下文长度。
  // 会话绑定可用就用会话的，绑定失效（提供商被删/停用、模型被移除）则回落全局默认——
  // 与后端 get_session_provider 同为「完全可用才生效」，避免显示失效绑定/误禁用输入。
  const effectiveActive = effectiveActiveOf(settings, sessionActive);
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

  // 挂载恢复（2026-10-05 拍板④）：从其他页面回到 /chat 时 ChatView 会重挂载，
  // 本地 sessionId/messages 归零，而 WorkspaceProvider 里的 activeSessionId 还指着
  // 原会话——不恢复就会出现「侧栏高亮旧会话、主区却是新对话空态」的断连。
  // 这里挂载时主动重开活动会话；会话已被删除则静默失败（拍板：不做兜底）。
  const restoredOnMountRef = useRef(false);
  useEffect(() => {
    if (restoredOnMountRef.current) return;
    restoredOnMountRef.current = true;
    if (activeSessionId === null || loadedSession !== null) return;
    void openSession(activeSessionId).catch(() => undefined);
  }, [activeSessionId, loadedSession, openSession]);

  useEffect(() => {
    mountedRef.current = true;
    const restoreRun = (initial = false) => {
      const run = getChatRun(sessionIdRef.current);
      if (!run || (initial && sessionIdRef.current === null && !run.streaming)) return;
      setMessages(run.messages);
      setUsage(run.usage);
      setStreaming(run.streaming);
      setSyncing(run.syncing);
      setSyncError(run.syncError);
      setError(run.error);
    };
    restoreRun(true);
    const unsubscribe = subscribeChatRuns(restoreRun);
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, []);

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
    viewEpochRef.current += 1;
    sessionIdRef.current = loadedSession.meta.id;
    if (loadedSession.streaming && !getChatRun(loadedSession.meta.id)) {
      recoverChatRun(loadedSession.meta.id, loadedSession.messages, loadedSession.meta.usage ?? null);
    }
    let live = getChatRun(loadedSession.meta.id);
    const completedError = live?.error ?? null;
    if (live && !live.streaming && !live.syncing && !live.syncError) {
      forgetChatRun(loadedSession.meta.id);
      if (!loadedSession.streaming) live = null;
    }
    orchestrationAbortRef.current?.abort();
    setBuilding(false);
    // 换会话是有更新的消息变更：作废在飞的回灌，并清掉同步错误锁
    mutationEpochRef.current += 1;
    setSyncing(false);
    setSyncError(null);
    // 历史会话由服务端已存在：不设草稿迁移标记（手动点开历史会话绝不能把 __new__ 草稿迁进来）
    setAdoptedNewDraftId(null);
    // 首屏/切会话一律从底部开始（与「用户手动上翻」区分开）
    stickToBottomRef.current = true;
    setActiveSessionId(loadedSession.meta.id);
    setSessionId(loadedSession.meta.id);
    setMessages(live?.messages ?? loadedSession.messages);
    setError(live?.error ?? completedError);
    setNotice(null);
    setStreaming(live?.streaming ?? false);
    setSyncing(live?.syncing ?? false);
    setSyncError(live?.syncError ?? null);
    setEditingIndex(null);
    setConfirmDeleteIndex(null);
    setUsage(live?.usage ?? loadedSession.meta.usage ?? null);
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
    viewEpochRef.current += 1;
    sessionIdRef.current = null;
    forgetChatRun(null);
    orchestrationAbortRef.current?.abort();
    setBuilding(false);
    mutationEpochRef.current += 1;
    setSyncing(false);
    setSyncError(null);
    // 新对话回到干净槽位：清掉旧迁移标记
    setAdoptedNewDraftId(null);
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

  // 编排/对话结束后以服务端消息回灌本地：本地只追加的临时卡（⚙ 开始卡等）会让可编辑/
  // 可删除消息的本地下标与服务端错位（开发与计划 §消息级操作 1:1 不变式）；后端也可能在
  // SSE 之外补写消息（interview 收口提示/解析失败卡），统一用回灌对齐。
  // 守卫：会话没切走、且期间没有更新的消息变更（纪元未变），否则丢弃过时快照。
  const resyncMessages = useCallback(
    async (target: string | null, options: { keepLocalWhenSame?: boolean } = {}) => {
      if (!target || sessionIdRef.current !== target) return;
      if (getChatRun(target)?.syncError) {
        await retryChatSync(target);
        return;
      }
      const epoch = mutationEpochRef.current;
      const localCount = messagesRef.current.length;
      setSyncing(true);
      setSyncError(null);
      try {
        const data = await api.getSession(target);
        if (sessionIdRef.current !== target || mutationEpochRef.current !== epoch) {
          setSyncing(false);
          return;
        }
        // 对话轮的常规回灌：长度没变就保留本地（保住只在前端呈现的 notices，避免无谓重渲染）
        if (!options.keepLocalWhenSame || data.messages.length !== localCount) {
          forgetChatRun(target);
          setMessages(data.messages);
          setUsage(data.usage ?? null);
        }
        setSyncing(false);
      } catch (err: unknown) {
        if (sessionIdRef.current !== target || mutationEpochRef.current !== epoch) {
          setSyncing(false);
          return;
        }
        setSyncError(err instanceof Error ? err.message : String(err));
        setSyncing(false);
      }
    },
    [],
  );

  const handleSend = useCallback(
    (
      text: string,
      attachments: OutgoingAttachment[] = [],
      opts: { mode?: "chat" | "interview"; fixtureScenario?: string; replaceFrom?: number } = {},
    ) => {
      // 未同步（回灌中/失败）时不发送：避免与服务端消息错位、或让新消息被过时的回灌快照覆盖
      const currentRun = getChatRun(sessionId);
      if (unsyncedRef.current || currentRun?.streaming || currentRun?.syncing || currentRun?.syncError) return;
      setError(null);
      setNotice(null);
      setStreaming(true);
      // 新消息 = 有更新的消息变更，作废在飞的回灌
      mutationEpochRef.current += 1;

      const metas: MessageAttachment[] = attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        kind: a.kind,
        size: a.size,
      }));

      const viewEpoch = viewEpochRef.current;
      startChatRun({
        sessionId,
        messages: messagesRef.current,
        text,
        attachments: metas.length ? metas : undefined,
        usage,
        model: activeModelLabel ?? undefined,
        onSession: (id) => {
          void refreshSessions();
          // 新会话分配 id 时可能已经切走；后台流不能把用户拉回原会话。
          if (!mountedRef.current || viewEpochRef.current !== viewEpoch) return;
          sessionIdRef.current = id;
          setSessionId(id);
          setActiveSessionId(id);
          if (sessionId === null) setAdoptedNewDraftId(id);
          writeRightOpen(id, rightOpenRef.current);
        },
        onSettled: () => { void refreshSessions(); },
        options: {
          subjectSlug: opts.mode === "interview" ? undefined : activeSubjectSlug,
          nodeId: opts.mode === "interview" ? undefined : activeNodeId,
          workspace: activeWorkspace,
          attachments: attachments.map((a) => a.id),
          mode: opts.mode ?? null,
          fixtureScenario: opts.fixtureScenario ?? (opts.mode === "interview" ? "interview" : null),
          replaceFrom: opts.replaceFrom,
        },
      });
    },
    [sessionId, activeSubjectSlug, activeNodeId, activeWorkspace, usage, activeModelLabel, setActiveSessionId, refreshSessions],
  );

  // 建课 done 卡上的「开始第一课」：不发新端点，复用普通发送路径，让智能体用 produce_lesson 工具产出
  const startFirstLesson = useCallback(() => {
    handleSend(FIRST_LESSON_PROMPT);
  }, [handleSend]);

  // 确认建课：草稿上跑建课编排（大纲+采图并行 → 门禁 → 落盘），进度播报进会话
  const startBuild = useCallback(
    (slug: string) => {
      if (building) return;
      forgetChatRun(sessionId);
      setBuilding(true);
      // 建课编排也算「会话在跑」：侧栏条目转圈（2026-10-05 补充拍板）
      setBuildingSessionId(sessionId);
      setBuildProgress(null);
      setError(null);
      // 建课开始 = 有更新的消息变更，作废在飞的回灌
      mutationEpochRef.current += 1;
      const orchestrationController = new AbortController();
      orchestrationAbortRef.current = orchestrationController;
      // 本次编排落到哪个会话（新建会话时由 onSession 补上）：回灌与错误卡的归属判据
      let activeId: string | null = sessionId;
      const mark = (content: string, kind: ChatMessage["kind"]) => appendKindMessage({ role: "assistant", content, kind });
      mark("⚙ 开始建课编排：大纲与采图并行…", "stage");
      buildDraft(slug, {
        onSession: (id) => {
          activeId = id;
          sessionIdRef.current = id;
          // 新对话态直接进建课：编排会话在这里才拿到 id，转圈跟着改挂
          setBuildingSessionId(id);
          if (!sessionId) {
            setSessionId(id);
            setActiveSessionId(id);
            setAdoptedNewDraftId(id);
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
          mark(normalizeError(message)?.summary ?? "建课失败", "error");
          void refreshSessions();
        },
      }, sessionId, orchestrationController.signal)
        .catch((err: unknown) => {
          // 中止（切会话/点停止）不算失败，不回写错误卡；网络/协议失败且仍在本会话才提示
          if ((err as Error)?.name === "AbortError") return;
          if (sessionIdRef.current !== activeId) return;
          mark(String(err), "error");
        })
        .finally(() => {
          setBuilding(false);
          setBuildingSessionId(null);
          setBuildProgress(null);
          // 编排结束（成功/失败/取消）都以服务端消息为准回灌：本地临时卡不占可操作下标
          void resyncMessages(activeId);
        });
    },
    [building, sessionId, appendKindMessage, setBuildingSessionId, refreshSubjects, refreshSessions, resyncMessages],
  );

  // 落点确认：草稿整体搬进学习工作区；带上会话 id（后端据此写 subject_slug）
  const promoteDraftToWorkspace = useCallback(
    async (slug: string) => {
      setPromoting(true);
      setError(null);
      try {
        const res = await api.promoteDraft(slug, sessionId);
        setNotice(`已落盘到工作区：${res.subject_dir}`);
        // 落点确认的可见反馈走 banner + done 卡 promote 按钮翻成「已进入工作区」；
        // 不再追加本地-only 完成卡（它会占用可操作消息下标与服务端错位）。
        void refreshSubjects();
        // 会话的科目关联由后端在 promote 时落库，这里刷新本地列表并选中新科目
        void refreshSessions();
        setActiveSubject(slug);
        // 以服务端消息为准回灌（本地 === 服务端，编辑/删除下标才对得上）
        await resyncMessages(sessionId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPromoting(false);
      }
    },
    [refreshSubjects, refreshSessions, sessionId, setActiveSubject, resyncMessages],
  );

  const handleStop = () => {
    // 聊天流与建课编排各持一个控制器：停止按钮对两者都要生效（建课中绝不能点了没反应）
    stopChatRun(sessionIdRef.current);
    orchestrationAbortRef.current?.abort();
    setBuilding(false);
    setBuildProgress(null);
    // 纯空占位（一个字都没吐就停）会让本地比服务端多一条，导致后续下标错位：回灌对齐
    const tail = messagesRef.current[messagesRef.current.length - 1];
    if (
      !getChatRun(sessionIdRef.current) &&
      tail &&
      tail.role === "assistant" &&
      !tail.content &&
      !tail.reasoning &&
      !(tail.tools && tail.tools.length > 0)
    ) {
      void resyncMessages(sessionIdRef.current, { keepLocalWhenSame: true });
    }
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
        // 删除是有更新的消息变更：作废在飞的回灌，再用服务端返回的消息对齐
        mutationEpochRef.current += 1;
        forgetChatRun(sessionId);
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
          // 记入概念本用展示原文（无附件/旧消息回落 content）
          question = userDisplayText(messages[i]);
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
                        onClick={() => composerFillRef.current?.fill(s)}
                        className="rounded-full border border-[var(--border)] bg-[var(--surface-card)] px-4 py-2 text-sm text-[var(--foreground)]/85 shadow-xs transition-all hover:border-brand/40 hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)]"
                      >
                        {s}
                      </button>
                    ))}
                    <button
                      data-testid="discovery-starter"
                      onClick={() => composerFillRef.current?.fill(DISCOVERY_STARTER)}
                      className="rounded-full border border-brand/40 bg-brand/5 px-4 py-2 text-sm font-medium text-brand shadow-xs transition-all hover:bg-brand/10"
                      title="填入输入框：发出后教练会把会话切入建课盘问"
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
                  // 展示/复制/记入概念本统一用清洗后的文本：用户消息用展示原文（R7），
                  // 助手消息剥掉盘问收口标记、去掉首尾空行
                  const clean = isUser
                    ? userDisplayText(msg)
                    : cleanAssistantText(msg.content);
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
                        {!isUser && <AssistantMessageBody message={msg} streaming={isStreamingHere} />}
                        {!isUser && (msg.error || msg.stream_state === "error" || msg.stream_state === "interrupted") && (
                          <ErrorNotice error={msg.error ?? normalizeError(msg.stopped_reason === "user_stop" ? {
                            code: "user_stopped", phase: "finalize", summary: "已停止本轮回复。", retryable: false,
                            status: null, upstream_code: null, stopped_reason: "user_stop",
                          } : "回复异常结束，已保留收到的内容。")} />
                        )}
                        {isEditing ? (
                          <UserMessageEditor
                            initialText={userDisplayText(msg)}
                            initialAttachments={msg.attachments ?? []}
                            sessionId={sessionId}
                            onSubmit={(text, attachments) => submitEdit(i, text, attachments)}
                            onCancel={() => setEditingIndex(null)}
                          />
                        ) : isUser && clean ? (
                          <div className="max-w-[85%] rounded-2xl bg-brand px-4 py-2.5 text-sm text-white shadow-xs [&_a]:text-white [&_a]:underline [&_code]:bg-black/20 [&_pre]:bg-black/30">
                            <Markdown content={clean} />
                          </div>
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
                                  disabled={streaming || building || unsynced}
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
                                  disabled={!sessionId || streaming || building || unsynced}
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

              {error && !messages.some((message) => message.error) && (
                <ErrorNotice error={normalizeError(error)} />
              )}

              {/* 回灌失败：消息已可能与服务端错位，暂停发送/编辑/删除直到重试成功 */}
              {syncError && (
                <div
                  data-testid="chat-sync-error"
                  className="mt-5 flex items-start gap-2 rounded-xl border border-amber-400/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    会话同步失败：{syncError}（为避免误删/下标错位，消息操作已暂停）
                  </span>
                  <button
                    type="button"
                    onClick={() => void resyncMessages(sessionIdRef.current)}
                    className="shrink-0 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-amber-500/10"
                    style={{ borderColor: "var(--border)" }}
                  >
                    重试
                  </button>
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
            disabled={hasKey === false || unsynced}
            disabledHint={
              syncError
                ? "会话未同步，请先在上方重试同步"
                : unsynced
                  ? "正在同步会话…"
                  : undefined
            }
            elevated={!hasMessages}
            sessionId={sessionId}
            settings={settings}
            onUpdated={setSettings}
            sessionActive={sessionActive}
            onSessionActiveChange={setSessionActive}
            adoptNewDraftInto={adoptedNewDraftId}
            fillHandle={composerFillRef}
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

      {/* 质检工单（handoff 卡入口）：带上会话工作区，归属判定才不会回落到默认猜 */}
      {inspectionTicketId && (
        <InspectionDialog
          key={inspectionTicketId}
          ticketId={inspectionTicketId}
          sessionId={sessionId}
          workspace={activeWorkspace}
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
  if (isError) return <div data-testid="orchestration-error"><ErrorNotice text={content} /></div>;
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

/** 产课成功入口：常显打开课件（链接只来自服务端结构化 lesson，不解析模型文本/猜路径）。 */
function LessonLinkButton({ lesson }: { lesson: LessonLink }) {
  return (
    <Link
      data-testid="open-lesson"
      href={lessonHref(lesson)}
      className="flex w-fit items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-light"
      title={lesson.title}
    >
      <BookOpen className="h-3.5 w-3.5" />
      打开课件
    </Link>
  );
}

/**
 * 评估工具的系统落盘状态：写盘成功/失败由后端结构化 assessment 决定。
 * 模型可以口头说「已通过」，但只要 status=failed，这里必须显示未保存、未启动后台修复。
 */
function AssessmentStatus({ outcome }: { outcome: AssessmentOutcome }) {
  const failed = outcome.status === "failed";
  const meta: string[] = [];
  if (outcome.verdict) meta.push(`判定：${outcome.verdict}`);
  if (typeof outcome.mastery === "number") meta.push(`掌握度：${outcome.mastery}`);
  if (typeof outcome.progress_updated === "boolean") {
    meta.push(outcome.progress_updated ? "进度已置位" : "进度未置位");
  }
  return (
    <div
      data-testid="assessment-status"
      data-status={outcome.status}
      className={clsx(
        "flex w-fit flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 text-xs",
        failed
          ? "border-red-300/60 bg-red-500/10 text-red-600 dark:text-red-400"
          : "border-emerald-300/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      )}
    >
      <div className="flex items-center gap-1.5 font-medium">
        {failed ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        )}
        {failed ? "评估失败，未保存，未启动后台修复" : "评估记录已保存"}
      </div>
      {failed
        ? outcome.error && <div className="opacity-80">{outcome.error}</div>
        : meta.length > 0 && <div className="opacity-80">{meta.join(" · ")}</div>}
    </div>
  );
}

/**
 * 单个工具的视图分发：产课任务 → 任务卡（父 produce 工具一卡）；评估/产课成功 → 常显系统状态
 * 与课件入口；其余工具回落旧 ToolCards。旧消息没有 task 时行为不变。
 */
function ToolActivityView({ tool }: { tool: ToolActivity }) {
  const task = tool.task;
  const lesson = tool.lesson ?? task?.lesson;
  const lessonReady =
    Boolean(lesson) && (task ? task.status === "done" : tool.status === "done" && !tool.isError);
  return (
    <div data-testid="tool-activity" data-tool-id={tool.id} className="flex min-w-0 flex-col gap-1.5">
      {task ? (
        <ProductionTaskCard task={task} lesson={lessonReady ? lesson : undefined} />
      ) : (
        <>
          <ToolCards tools={[tool]} />
          {lessonReady && lesson ? <LessonLinkButton lesson={lesson} /> : null}
        </>
      )}
      {tool.assessment ? <AssessmentStatus outcome={tool.assessment} /> : null}
    </div>
  );
}

function AssistantMessageBody({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  const parts = cleanAssistantParts(message.parts ?? []);
  if (!message.parts?.length) {
    return <>
      <ProcessPanel reasoning={message.reasoning} tools={message.tools} notices={message.notices} streaming={streaming} />
      {message.tools?.length ? (
        <div className="mb-2 flex flex-col gap-1.5">
          {message.tools.map((tool) => <ToolActivityView key={tool.id} tool={tool} />)}
        </div>
      ) : null}
      {message.content && <Markdown content={cleanAssistantText(message.content)} />}
    </>;
  }
  const orderedNotices = new Set(parts.flatMap((part) => part.type === "notice" ? [part.text] : []));
  const remainingNotices = message.notices?.filter((notice) => !orderedNotices.has(notice));
  const nodes: React.ReactNode[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.type === "notice") {
      // 相邻 notice 合成一个折叠面板；遇到 text/tool/reasoning 即断组，不串到另一侧。
      const group: string[] = [];
      let cursor = index;
      while (cursor < parts.length && parts[cursor].type === "notice") {
        group.push((parts[cursor] as { type: "notice"; text: string }).text);
        cursor += 1;
      }
      nodes.push(
        <div key={`notice-${index}`} data-part-type="notice">
          <ProcessPanel notices={group} streaming={streaming && cursor === parts.length} />
        </div>,
      );
      index = cursor - 1;
      continue;
    }
    const active = streaming && index === parts.length - 1;
    if (part.type === "tool") {
      const tool = message.tools?.find((item) => item.id === part.tool_id);
      nodes.push(tool ? <div key={index} data-part-type="tool"><ToolActivityView tool={tool} /></div> : null);
      continue;
    }
    if (part.type === "text") {
      const text = cleanAssistantText(part.text);
      nodes.push(text ? <div key={index} data-part-type="text"><Markdown content={text} /></div> : null);
      continue;
    }
    nodes.push(
      <div key={index} data-part-type={part.type}>
        <ProcessPanel reasoning={part.type === "reasoning" ? part.text : undefined} streaming={active} />
      </div>,
    );
  }
  return <div data-testid="assistant-parts" className="flex flex-col gap-2">
    {nodes}
    {remainingNotices?.length ? <ProcessPanel notices={remainingNotices} streaming={false} /> : null}
    {streaming && message.content && (
      <Loader2
        data-testid="assistant-streaming"
        className="mt-1 h-4 w-4 shrink-0 animate-spin text-brand"
        aria-label="正在输出"
      />
    )}
  </div>;
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
    // 与 Composer.canSend 同口径：正文非空或仍有附件即可发送；纯附件（空正文）保持
    // display_content 为空的语义，重发时不回落成附件提取块。
    if (uploading > 0) return;
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
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
            disabled={(!text.trim() && attachments.length === 0) || uploading > 0}
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
          className={clsx("rounded-lg border px-2.5 py-1.5 text-xs", tool.status === "error" && "border-red-400/50 bg-red-500/10 text-red-700 dark:text-red-300")}
          style={tool.status === "error" ? undefined : { borderColor: "var(--border)", background: "var(--muted)" }}
        >
          <summary className="flex cursor-pointer list-none items-center gap-1.5">
            {tool.status === "running" ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-brand" />
            ) : tool.status === "error" ? (
              <AlertCircle className="h-3 w-3 shrink-0 text-red-500" />
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
