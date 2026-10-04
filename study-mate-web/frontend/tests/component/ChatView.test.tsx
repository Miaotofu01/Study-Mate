import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatView } from "@/components/ChatView";
import type { SessionMeta, SubjectMeta } from "@/lib/types";
import { makeSettings, makeWorkspaceInfo } from "./fixtures";

// 「无科目 prefill」分支下沉：subjectsLoaded 区分「确实没科目」与「还没拉到」，
// 该前置状态在旅程级 E2E 射程外（fixture 世界必有科目），在此用组件测试覆盖。
const { push, workspace, api } = vi.hoisted(() => ({
  push: vi.fn(),
  workspace: {
    current: {
      sessions: [] as SessionMeta[],
      subjects: [] as SubjectMeta[],
      subjectsLoaded: false,
      activeSessionId: null,
      activeSubjectSlug: null,
      activeNodeId: null,
      setActiveSessionId: vi.fn(),
      setActiveSubject: vi.fn(),
      loadedSession: null,
      clearLoadedSession: vi.fn(),
      refreshSessions: vi.fn(),
      refreshSubjects: vi.fn(),
      setMisconceptionDraft: vi.fn(),
    },
  },
  api: {
    getSettings: vi.fn(),
    getCourse: vi.fn(),
    getWorkspace: vi.fn(),
    attachmentFileUrl: vi.fn(() => "#"),
    courseFileUrl: vi.fn(() => "#"),
    draftFileUrl: vi.fn(() => "#"),
    abandonTicket: vi.fn(),
    confirmMemory: vi.fn(),
    generateSessionSummary: vi.fn(),
    getTicket: vi.fn(),
    promoteDraft: vi.fn(),
    quickEditTicketArtifact: vi.fn(),
    uploadAttachment: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => workspace.current,
  useChatDraft: vi.fn(() => ({ value: "", setValue: vi.fn(), clearDraft: vi.fn() })),
}));
vi.mock("@/lib/api", () => ({
  api,
  buildDraft: vi.fn(),
  streamChat: vi.fn(),
  recheckTicket: vi.fn(),
  retryTicket: vi.fn(),
}));

function setWorkspace(over: Partial<typeof workspace.current>) {
  workspace.current = { ...workspace.current, ...over };
}

const subject: SubjectMeta = {
  name: "Python 入门",
  slug: "python-basics",
  goal: "会用 Python 写小工具",
  created_at: "2026-10-03T00:00:00Z",
  status: "进行中",
};

describe("ChatView 无科目分支（E2E 状态分支层下沉）", () => {
  it("subjectsLoaded=false（还没拉到）：欢迎区出现，但不渲染工作区引导块", () => {
    setWorkspace({ subjectsLoaded: false, subjects: [] });
    api.getSettings.mockResolvedValue(makeSettings([]));
    render(<ChatView />);
    expect(screen.getByText("讲解一个概念")).toBeInTheDocument();
    expect(screen.queryByText("选择学习工作区")).not.toBeInTheDocument();
  });

  it("subjectsLoaded=true 且无科目：渲染工作区引导块并读取工作区信息", async () => {
    setWorkspace({ subjectsLoaded: true, subjects: [] });
    api.getSettings.mockResolvedValue(makeSettings([]));
    api.getWorkspace.mockResolvedValue(makeWorkspaceInfo());
    render(<ChatView />);
    expect(await screen.findByText("选择学习工作区")).toBeInTheDocument();
    expect(api.getWorkspace).toHaveBeenCalled();
  });

  it("已有科目：即使 subjectsLoaded=true 也不出现引导块", () => {
    setWorkspace({ subjectsLoaded: true, subjects: [subject] });
    api.getSettings.mockResolvedValue(makeSettings([]));
    render(<ChatView />);
    expect(screen.getByText("讲解一个概念")).toBeInTheDocument();
    expect(screen.queryByText("选择学习工作区")).not.toBeInTheDocument();
  });
});
