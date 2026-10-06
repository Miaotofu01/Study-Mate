import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatView } from "@/components/ChatView";
import type { SessionMeta, SubjectMeta } from "@/lib/types";
import { makeProvider, makeSettings } from "./fixtures";

// 「新对话态关联行」分支下沉：关联行只在**还没有会话**时出现，且科目/工作区两个下拉的
// 候选分别来自 subjects 与 workspaceCandidates。原用例断言的是已移除的「工作区引导块」
// （2026-10-04 第二轮 UI 改动后一直红，层不进根门禁），这里按现行 UI 重写。
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
      activeWorkspace: null,
      workspaceCandidates: [] as string[],
      setActiveSessionId: vi.fn(),
      setActiveSubject: vi.fn(),
      setActiveWorkspace: vi.fn(),
      renameSession: vi.fn(),
      loadedSession: null,
      clearLoadedSession: vi.fn(),
      refreshSessions: vi.fn(),
      refreshSubjects: vi.fn(),
      setMisconceptionDraft: vi.fn(),
      // 建课编排开始/结束由 ChatView 上报（侧栏转圈推导用）
      setBuildingSessionId: vi.fn(),
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
const { buildDraft } = vi.hoisted(() => ({ buildDraft: vi.fn() }));

vi.mock("@/lib/api", () => ({
  api,
  buildDraft,
  streamChat: vi.fn(),
  recheckTicket: vi.fn(),
  retryTicket: vi.fn(),
}));

function setWorkspace(over: Record<string, unknown>) {
  // 每例从初始形状起算，避免上一个用例的残留影响（尤其 loadedSession）。
  // 这里刻意放宽类型：mock 形状只需覆盖 ChatView 用到的字段，不必与真实 WorkspaceValue 同步。
  const base = {
    sessions: [] as SessionMeta[],
    subjects: [] as SubjectMeta[],
    subjectsLoaded: false,
    activeSessionId: null,
    activeSubjectSlug: null,
    activeNodeId: null,
    activeWorkspace: null,
    workspaceCandidates: [] as string[],
    loadedSession: null,
  };
  workspace.current = { ...workspace.current, ...base, ...over } as typeof workspace.current;
}

const subject: SubjectMeta = {
  name: "Python 入门",
  slug: "python-basics",
  goal: "会用 Python 写小工具",
  created_at: "2026-10-03T00:00:00Z",
  status: "进行中",
};

const sessionMeta: SessionMeta = {
  id: "s1",
  title: "旧会话",
  message_count: 2,
  created_at: 1,
  updated_at: 2,
  subject_slug: null,
  node_id: null,
  mode: "chat",
  workspace: null,
  usage: null,
  active: null,
};

const confirmSession: SessionMeta = {
  ...sessionMeta,
  id: "s-build",
  title: "建课会话",
  mode: "interview",
};

describe("ChatView 建课进度卡（长时间派工时「在干活」要看得见）", () => {
  it("收到 progress 快照时显示「阶段 · 第 N 轮 · 已等待 Ns」", async () => {
    setWorkspace({
      activeSessionId: "s-build",
      loadedSession: {
        meta: confirmSession,
        messages: [
          { role: "user", content: "帮我选方向" },
          {
            role: "assistant",
            content: "盘问完成，已为「X」建好草稿。",
            kind: "build_confirm",
            slug: "python",
          },
        ],
      },
    });
    api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
    // buildDraft 不发任何真事件，只回吐一份进度快照并挂着（模拟"还在跑"）
    buildDraft.mockImplementation((_slug: string, handlers: Record<string, unknown>) => {
      (handlers.onProgress as (p: unknown) => void)({
        stage: "大纲",
        round: 2,
        elapsed_s: 137.4,
        reasoning_chars: 12345,
        tool_calls: 1,
        last_tool: "list_workspace",
      });
      return new Promise(() => undefined);
    });

    render(<ChatView />);
    await screen.findByTestId("build-confirm-card");
    await userEvent.click(screen.getByTestId("build-confirm-button"));

    const text = await screen.findByTestId("build-progress-text");
    expect(text.textContent).toContain("大纲 · 第 2 轮 · 已等待 137s");
    expect(text.textContent).toContain("已调用 1 次工具（最近 list_workspace）");
    expect(text.textContent).toContain("已思考 12k 字");
  });
});

describe("ChatView 新对话态关联行（E2E 状态分支层下沉）", () => {
  it("新对话态渲染「科目 + 工作区」关联行，科目下拉按 subjects 给选项", () => {
    setWorkspace({ subjects: [subject], subjectsLoaded: true, workspaceCandidates: [] });
    api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
    render(<ChatView />);
    expect(screen.getByText("讲解一个概念")).toBeInTheDocument();
    expect(screen.getByTestId("new-session-association")).toBeInTheDocument();
    const subjectSelect = screen.getByTitle("关联科目", { exact: true });
    expect(subjectSelect).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Python 入门" }),
    ).toBeInTheDocument();
  });

  it("科目还没加载完时关联行照样在（它与 subjectsLoaded 无关）", () => {
    setWorkspace({ subjects: [], subjectsLoaded: false });
    api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
    render(<ChatView />);
    expect(screen.getByTestId("new-session-association")).toBeInTheDocument();
    // 科目下拉只剩「不关联」这一个选项
    const subjectSelect = screen.getByTitle("关联科目", { exact: true });
    expect(subjectSelect.querySelectorAll("option")).toHaveLength(1);
  });

  it("工作区下拉：默认项「默认工作区」+ 候选路径", () => {
    setWorkspace({
      workspaceCandidates: ["C:/ws/A", "C:/ws/B"],
      subjectsLoaded: true,
    });
    api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
    render(<ChatView />);
    const workspaceSelect = screen.getByTitle("关联工作区", { exact: true });
    const labels = Array.from(workspaceSelect.querySelectorAll("option")).map(
      (option) => option.textContent,
    );
    expect(labels).toEqual(["默认工作区", "C:/ws/A", "C:/ws/B"]);
  });

  it("打开已有会话后关联行消失（只在新对话态存在）", () => {
    setWorkspace({
      subjectsLoaded: true,
      activeSessionId: "s1",
      loadedSession: {
        meta: sessionMeta,
        messages: [{ role: "user", content: "旧问题" }],
      },
    });
    api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
    render(<ChatView />);
    expect(screen.getByText("旧问题")).toBeInTheDocument();
    expect(screen.queryByTestId("new-session-association")).not.toBeInTheDocument();
  });
});
