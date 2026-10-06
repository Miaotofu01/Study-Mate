"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import { getStreamingChatRunSessionId, subscribeChatRuns } from "./chatStream";
import type { ChatMessage, Session, SessionMeta, SubjectSummary } from "./types";

type SessionWithContext = Session & {
  subject_slug?: string | null;
  node_id?: string | null;
  workspace?: string | null;
};

export interface LoadedSession {
  streaming?: boolean;
  meta: SessionMeta;
  messages: ChatMessage[];
}

export interface MisconceptionDraft {
  subject?: string;
  node?: string | null;
  topic?: string;
  question?: string;
  answer_summary?: string;
}

interface WorkspaceValue {
  sessions: SessionMeta[];
  subjects: SubjectSummary[];
  /** subjects 是否已加载过（区分「真的没有科目」与「还没拉到」；加载失败保持 false） */
  subjectsLoaded: boolean;
  refreshSessions: () => Promise<void>;
  refreshSubjects: () => Promise<void>;

  /** 会话级工作区（绝对路径）；null = 用当前默认工作区 */
  activeWorkspace: string | null;
  setActiveWorkspace: (path: string | null) => void;
  /** 可切换的工作区候选（当前生效 / 插件默认 / env 覆盖） */
  workspaceCandidates: string[];
  refreshWorkspaceCandidates: () => Promise<void>;

  /** 课程页当前正在看的科目（左侧边栏用它表达「选中」；由课程页发布） */
  currentSubjectSlug: string | null;
  setCurrentSubjectSlug: (slug: string | null) => void;

  activeSessionId: string | null;
  activeSubjectSlug: string | null;
  activeNodeId: string | null;
  setActiveSessionId: (id: string | null) => void;
  setActiveSubject: (slug: string | null, nodeId?: string | null) => void;

  /** 正在产出回复 / 跑建课编排的会话 id（侧栏条目转圈指示用，2026-10-05 补充拍板）；null = 没有。
   *  聊天流部分由 chatRuns 注册表推导；建课编排由 ChatView 经 setBuildingSessionId 上报。 */
  runningSessionId: string | null;
  /** 建课编排开始/结束时由 ChatView 调用（编排会话在 onSession 拿到 id 时也调） */
  setBuildingSessionId: (id: string | null) => void;

  loadedSession: LoadedSession | null;
  clearLoadedSession: () => void;
  openSession: (id: string) => Promise<void>;

  newSession: () => void;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;

  createSubject: (name: string, slug?: string, goal?: string) => Promise<SubjectSummary>;

  misconceptionDraft: MisconceptionDraft | null;
  setMisconceptionDraft: (draft: MisconceptionDraft | null) => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [subjects, setSubjects] = useState<SubjectSummary[]>([]);
  const [subjectsLoaded, setSubjectsLoaded] = useState(false);

  // 会话级工作区：null = 用后端当前默认工作区（发现规则见 backend/app/workspace.py）
  const [activeWorkspace, setActiveWorkspaceState] = useState<string | null>(null);
  const [workspaceCandidates, setWorkspaceCandidates] = useState<string[]>([]);
  // 课程页当前科目（左侧边栏选中态用）
  const [currentSubjectSlug, setCurrentSubjectSlug] = useState<string | null>(null);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSubjectSlug, setActiveSubjectSlug] = useState<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  // 谁在跑（侧栏条目转圈）：聊天流从 chatRuns 注册表推导（streaming 即在跑，切走不清——
  // 服务端还在产出，直到该轮结束）；建课编排由 ChatView 经 setBuildingSessionId 上报。
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null);
  const buildingSessionRef = useRef<string | null>(null);
  const chatStreamingRef = useRef<string | null>(null);
  const [loadedSession, setLoadedSession] = useState<LoadedSession | null>(null);

  // 建课编排的会话 id 变化时重算（聊天流部分由下方订阅回调维护）
  const setBuildingSessionId = useCallback((id: string | null) => {
    buildingSessionRef.current = id;
    setRunningSessionId(chatStreamingRef.current ?? id);
  }, []);

  useEffect(
    () =>
      subscribeChatRuns(() => {
        chatStreamingRef.current = getStreamingChatRunSessionId();
        setRunningSessionId(chatStreamingRef.current ?? buildingSessionRef.current);
      }),
    [],
  );
  const [misconceptionDraft, setMisconceptionDraft] = useState<MisconceptionDraft | null>(null);

  const sessionsRef = useRef<SessionMeta[]>([]);
  sessionsRef.current = sessions;
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;
  const activeWorkspaceRef = useRef<string | null>(null);
  activeWorkspaceRef.current = activeWorkspace;
  // openSession 请求序号：快速连点会话时，先发后到的旧响应不得覆盖最后点击的会话
  const openSessionRequestRef = useRef(0);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await api.listSessions());
    } catch {
      // 后端未就绪时保留现状
    }
  }, []);

  /** 按指定工作区重载科目列表（null = 默认工作区）；旧响应不得覆盖新工作区的结果 */
  const subjectsRequestRef = useRef(0);
  const loadSubjects = useCallback(async (workspace: string | null) => {
    const requestId = ++subjectsRequestRef.current;
    try {
      const list = await api.listCourses(workspace);
      if (requestId !== subjectsRequestRef.current) return;
      setSubjects(list);
      setSubjectsLoaded(true);
    } catch {
      // 后端未就绪时保留现状（subjectsLoaded 保持 false）
    }
  }, []);

  const refreshSubjects = useCallback(
    () => loadSubjects(activeWorkspaceRef.current),
    [loadSubjects],
  );

  const refreshWorkspaceCandidates = useCallback(async () => {
    try {
      const info = await api.getWorkspace();
      setWorkspaceCandidates(info.candidates);
    } catch {
      // 后端未就绪时保留现状
    }
  }, []);

  /** 切会话级工作区：立即用新值重载科目，避免读到上一次的列表 */
  const setActiveWorkspace = useCallback(
    (path: string | null) => {
      activeWorkspaceRef.current = path;
      setActiveWorkspaceState(path);
      void loadSubjects(path);
    },
    [loadSubjects],
  );

  useEffect(() => {
    void refreshSessions();
    void refreshSubjects();
    void refreshWorkspaceCandidates();
  }, [refreshSessions, refreshSubjects, refreshWorkspaceCandidates]);

  const setActiveSubject = useCallback(
    (slug: string | null, nodeId: string | null = null) => {
      setActiveSubjectSlug(slug);
      setActiveNodeId(nodeId);
    },
    [],
  );

  const newSession = useCallback(() => {
    // 使在飞的 openSession 失效，避免它随后把刚开的新对话覆盖回旧会话
    openSessionRequestRef.current += 1;
    setActiveSessionId(null);
    setActiveNodeId(null);
    // 新对话回到默认工作区（关联行里的工作区默认「不选」）
    if (activeWorkspaceRef.current !== null) setActiveWorkspace(null);
  }, [setActiveWorkspace]);

  const openSession = useCallback(
    async (id: string) => {
      const requestId = ++openSessionRequestRef.current;
      const data = (await api.getSession(id)) as SessionWithContext;
      // 期间用户又点了别的会话 / 开了新对话：丢弃这次过期响应
      if (requestId !== openSessionRequestRef.current) return;
      const known = sessionsRef.current.find((s) => s.id === id);
      const meta: SessionMeta = {
        id: data.id,
        title: data.title,
        message_count: data.messages.length,
        created_at: data.created_at,
        updated_at: data.updated_at,
        subject_slug: data.subject_slug ?? known?.subject_slug ?? null,
        node_id: data.node_id ?? known?.node_id ?? null,
        mode: (data as { mode?: "chat" | "interview" }).mode ?? "chat",
        workspace: data.workspace ?? known?.workspace ?? null,
        usage: data.usage ?? null,
        active: data.active ?? null,
      };
      setActiveSessionId(id);
      // 会话绑定了工作区就切过去（否则回到默认），科目列表随之重载
      setActiveWorkspace(meta.workspace ?? null);
      setLoadedSession({ meta, messages: data.messages, streaming: data.streaming });
    },
    [setActiveWorkspace],
  );

  const clearLoadedSession = useCallback(() => setLoadedSession(null), []);

  const deleteSession = useCallback(
    async (id: string) => {
      await api.deleteSession(id);
      chatDrafts.delete(id);
      if (activeSessionIdRef.current === id) {
        setActiveSessionId(null);
        setActiveNodeId(null);
      }
      await refreshSessions();
    },
    [refreshSessions],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      await api.renameSession(id, title);
      await refreshSessions();
    },
    [refreshSessions],
  );

  const createSubject = useCallback(
    async (name: string, slug?: string, goal?: string) => {
      const trimmedSlug = slug?.trim();
      const created = await api.createCourse(
        {
          name,
          slug: trimmedSlug ? trimmedSlug : undefined,
          goal: goal?.trim() ? goal : undefined,
        },
        // 建在会话当前工作区里，与随后的科目列表刷新保持同一工作区
        activeWorkspaceRef.current,
      );
      await refreshSubjects();
      return created;
    },
    [refreshSubjects],
  );

  const value = useMemo<WorkspaceValue>(
    () => ({
      sessions,
      subjects,
      subjectsLoaded,
      refreshSessions,
      refreshSubjects,
      activeWorkspace,
      setActiveWorkspace,
      workspaceCandidates,
      refreshWorkspaceCandidates,
      currentSubjectSlug,
      setCurrentSubjectSlug,
      activeSessionId,
      activeSubjectSlug,
      activeNodeId,
      setActiveSessionId,
      setActiveSubject,
      runningSessionId,
      setBuildingSessionId,
      loadedSession,
      clearLoadedSession,
      openSession,
      newSession,
      deleteSession,
      renameSession,
      createSubject,
      misconceptionDraft,
      setMisconceptionDraft,
    }),
    [
      sessions,
      subjects,
      subjectsLoaded,
      refreshSessions,
      refreshSubjects,
      activeWorkspace,
      setActiveWorkspace,
      workspaceCandidates,
      refreshWorkspaceCandidates,
      currentSubjectSlug,
      setCurrentSubjectSlug,
      activeSessionId,
      activeSubjectSlug,
      activeNodeId,
      setActiveSubject,
      runningSessionId,
      loadedSession,
      clearLoadedSession,
      openSession,
      newSession,
      deleteSession,
      renameSession,
      createSubject,
      misconceptionDraft,
      setMisconceptionDraft,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace 必须在 WorkspaceProvider 内使用");
  return ctx;
}

// ---- 输入框草稿：按会话 id 缓存，纯内存 ----

// 尚未落盘的新对话用固定槽位，切回来草稿还在
const NEW_SESSION_DRAFT_KEY = "__new__";

const chatDrafts = new Map<string, string>();

function draftKeyOf(sessionId: string | null): string {
  return sessionId ?? NEW_SESSION_DRAFT_KEY;
}

/**
 * 输入框草稿：以会话 id 为键缓存在内存里（浏览器刷新后归空，属预期行为）。
 * 切换会话时自动保存当前草稿、载入目标会话的草稿；发送成功后调 clearDraft 清空。
 *
 * `adoptNewDraftInto`：显式声明「这个会话 id 是服务端刚为本轮新建会话分配的」。仅此情形下，
 * 才把「新对话」槽位（`__new__`）里流式期间用户新打的下一条草稿迁到该 id 上，避免它被清空。
 *
 * 为什么要显式标记：`null → 已有 id` 既可能是「发首条消息后服务端分配了新 id」，也可能是
 * 「用户从新对话手动点开一个历史会话」。后者绝不能迁移——那会把新对话里写了一半的草稿
 * 串进历史会话。两者单看 prev/target key 无法区分，故由调用方用本参数标注（须与 sessionId
 * 在同一次状态更新里给出）。
 */
export function useChatDraft(sessionId: string | null, adoptNewDraftInto: string | null = null) {
  const [value, setValueState] = useState(() => chatDrafts.get(draftKeyOf(sessionId)) ?? "");
  const valueRef = useRef(value);
  valueRef.current = value;
  const sessionRef = useRef(sessionId);

  useEffect(() => {
    if (sessionRef.current === sessionId) return;
    // 先保存当前会话的草稿，再载入目标会话的草稿
    const previousKey = draftKeyOf(sessionRef.current);
    const targetKey = draftKeyOf(sessionId);
    sessionRef.current = sessionId;
    const current = valueRef.current;
    if (current) chatDrafts.set(previousKey, current);
    else chatDrafts.delete(previousKey);
    // 只在调用方显式标注「服务端新建会话」时迁移，且目标槽位为空
    if (
      adoptNewDraftInto !== null &&
      adoptNewDraftInto === sessionId &&
      previousKey === NEW_SESSION_DRAFT_KEY &&
      targetKey !== NEW_SESSION_DRAFT_KEY &&
      current &&
      !chatDrafts.has(targetKey)
    ) {
      chatDrafts.set(targetKey, current);
      chatDrafts.delete(NEW_SESSION_DRAFT_KEY);
    }
    setValueState(chatDrafts.get(targetKey) ?? "");
  }, [sessionId, adoptNewDraftInto]);

  const setValue = useCallback(
    (next: string) => {
      setValueState(next);
      const key = draftKeyOf(sessionId);
      if (next) chatDrafts.set(key, next);
      else chatDrafts.delete(key);
    },
    [sessionId],
  );

  const clearDraft = useCallback(() => {
    setValueState("");
    chatDrafts.delete(draftKeyOf(sessionId));
  }, [sessionId]);

  return { value, setValue, clearDraft };
}
