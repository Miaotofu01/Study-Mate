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
import type { ChatMessage, Session, SessionMeta, SubjectSummary } from "./types";

type SessionWithContext = Session & {
  subject_slug?: string | null;
  node_id?: string | null;
};

export interface LoadedSession {
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
  refreshSessions: () => Promise<void>;
  refreshSubjects: () => Promise<void>;

  activeSessionId: string | null;
  activeSubjectSlug: string | null;
  activeNodeId: string | null;
  setActiveSessionId: (id: string | null) => void;
  setActiveSubject: (slug: string | null, nodeId?: string | null) => void;

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

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSubjectSlug, setActiveSubjectSlug] = useState<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [loadedSession, setLoadedSession] = useState<LoadedSession | null>(null);
  const [misconceptionDraft, setMisconceptionDraft] = useState<MisconceptionDraft | null>(null);

  const sessionsRef = useRef<SessionMeta[]>([]);
  sessionsRef.current = sessions;
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await api.listSessions());
    } catch {
      // 后端未就绪时保留现状
    }
  }, []);

  const refreshSubjects = useCallback(async () => {
    try {
      setSubjects(await api.listCourses());
    } catch {
      // 后端未就绪时保留现状
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
    void refreshSubjects();
  }, [refreshSessions, refreshSubjects]);

  const setActiveSubject = useCallback(
    (slug: string | null, nodeId: string | null = null) => {
      setActiveSubjectSlug(slug);
      setActiveNodeId(nodeId);
    },
    [],
  );

  const newSession = useCallback(() => {
    setActiveSessionId(null);
    setActiveNodeId(null);
  }, []);

  const openSession = useCallback(async (id: string) => {
    const data = (await api.getSession(id)) as SessionWithContext;
    const known = sessionsRef.current.find((s) => s.id === id);
    const meta: SessionMeta = {
      id: data.id,
      title: data.title,
      message_count: data.messages.length,
      created_at: data.created_at,
      updated_at: data.updated_at,
      subject_slug: data.subject_slug ?? known?.subject_slug ?? null,
      node_id: data.node_id ?? known?.node_id ?? null,
    };
    setActiveSessionId(id);
    setLoadedSession({ meta, messages: data.messages });
  }, []);

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
      const created = await api.createCourse({
        name,
        slug: trimmedSlug ? trimmedSlug : undefined,
        goal: goal?.trim() ? goal : undefined,
      });
      await refreshSubjects();
      return created;
    },
    [refreshSubjects],
  );

  const value = useMemo<WorkspaceValue>(
    () => ({
      sessions,
      subjects,
      refreshSessions,
      refreshSubjects,
      activeSessionId,
      activeSubjectSlug,
      activeNodeId,
      setActiveSessionId,
      setActiveSubject,
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
      refreshSessions,
      refreshSubjects,
      activeSessionId,
      activeSubjectSlug,
      activeNodeId,
      setActiveSubject,
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
 */
export function useChatDraft(sessionId: string | null) {
  const [value, setValueState] = useState(() => chatDrafts.get(draftKeyOf(sessionId)) ?? "");
  const valueRef = useRef(value);
  valueRef.current = value;
  const sessionRef = useRef(sessionId);

  useEffect(() => {
    if (sessionRef.current === sessionId) return;
    // 先保存当前会话的草稿，再载入目标会话的草稿
    const previousKey = draftKeyOf(sessionRef.current);
    sessionRef.current = sessionId;
    const current = valueRef.current;
    if (current) chatDrafts.set(previousKey, current);
    else chatDrafts.delete(previousKey);
    setValueState(chatDrafts.get(draftKeyOf(sessionId)) ?? "");
  }, [sessionId]);

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
