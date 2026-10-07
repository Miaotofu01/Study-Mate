import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "@/components/ChatView";
import type { SessionMeta, SubjectMeta } from "@/lib/types";
import { makeProvider, makeSettings } from "./fixtures";

// 集成用例：ChatView → Composer → 真实 useChatDraft（不 mock 该 hook），验证
//  - 手动从「新对话」点开历史会话：绝不迁移新对话草稿（adoptNewDraftInto=null）
//  - 首轮发消息、服务端在流式期间分配新 id：流式期间新打的下一条草稿被迁移而非清空
const { push, workspace, api, streamChat, buildDraft } = vi.hoisted(() => ({
  push: vi.fn(),
  workspace: { current: {} as Record<string, unknown> },
  api: {
    getSettings: vi.fn(),
    getSession: vi.fn(),
    getCourse: vi.fn(),
    getWorkspace: vi.fn(),
    attachmentFileUrl: vi.fn(() => "#"),
    courseFileUrl: vi.fn(() => "#"),
    draftFileUrl: vi.fn(() => "#"),
    promoteDraft: vi.fn(),
    renameSession: vi.fn(),
  },
  streamChat: vi.fn(),
  buildDraft: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
// 只替换 useWorkspace；useChatDraft 用真实实现（草稿迁移是要验证的对象）
vi.mock("@/lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace")>();
  return { ...actual, useWorkspace: () => workspace.current };
});
vi.mock("@/lib/api", () => ({
  api,
  buildDraft,
  streamChat,
  recheckTicket: vi.fn(),
  retryTicket: vi.fn(),
}));

// 稳定的函数身份：避免每次 setWorkspace 都生成新引用，让 ChatView 的 effect 反复重跑
const stable = {
  setActiveSessionId: vi.fn(),
  setActiveSubject: vi.fn(),
  setActiveWorkspace: vi.fn(),
  renameSession: vi.fn(),
  clearLoadedSession: vi.fn(),
  refreshSessions: vi.fn(),
  refreshSubjects: vi.fn(),
  setMisconceptionDraft: vi.fn(),
      // 建课编排开始/结束由 ChatView 上报（侧栏转圈推导用）
      setBuildingSessionId: vi.fn(),
};

function setWorkspace(over: Record<string, unknown> = {}) {
  workspace.current = {
    sessions: [] as SessionMeta[],
    subjects: [] as SubjectMeta[],
    subjectsLoaded: true,
    activeSessionId: null,
    activeSubjectSlug: null,
    activeNodeId: null,
    activeWorkspace: null,
    workspaceCandidates: [],
    loadedSession: null,
    ...stable,
    ...over,
  };
}

const historyMeta: SessionMeta = {
  id: "s-hist-1",
  title: "历史会话",
  message_count: 1,
  created_at: 1,
  updated_at: 1,
  subject_slug: null,
  node_id: null,
  mode: "chat",
  workspace: null,
  usage: null,
  active: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
  api.getCourse.mockRejectedValue(new Error("no course"));
});

describe("聊天草稿迁移集成（真实 useChatDraft）", () => {
  it("手动从新对话点开历史会话：不迁移新对话草稿", async () => {
    setWorkspace({ activeSessionId: null, loadedSession: null });
    const { rerender } = render(<ChatView />);
    const textbox = screen.getByRole("textbox");
    await userEvent.clear(textbox);
    await userEvent.type(textbox, "新对话草稿");
    expect(textbox).toHaveValue("新对话草稿");

    // 手动点开历史会话（走 loadedSession，不是服务端新建）：标记为 null，不迁移
    setWorkspace({
      sessions: [historyMeta],
      activeSessionId: "s-hist-1",
      loadedSession: { meta: historyMeta, messages: [{ role: "user", content: "历史问题" }] },
    });
    rerender(<ChatView />);
    await waitFor(() => expect(screen.getByTestId("chat-title")).toHaveTextContent("历史会话"));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));

    // 回到新对话：草稿仍在 __new__ 槽，证明上一步只是没迁、不是被丢
    setWorkspace({ activeSessionId: null, loadedSession: null });
    rerender(<ChatView />);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("新对话草稿"));
  });

  it("首轮服务端分配新 id：流式期间新打的下一条草稿被迁移而非清空", async () => {
    setWorkspace({ activeSessionId: null, loadedSession: null });
    const captured: { handlers: { onSession?: (id: string) => void } | null } = { handlers: null };
    streamChat.mockImplementation(
      (_text: string, _sid: string | null, h: { onSession?: (id: string) => void }) => {
        captured.handlers = h;
        return new Promise<void>(() => undefined); // 挂住，模拟流式进行中
      },
    );

    render(<ChatView />);
    const textbox = screen.getByRole("textbox");
    await userEvent.clear(textbox);
    await userEvent.type(textbox, "首条");
    await userEvent.click(screen.getByTitle("发送"));
    // 发送后 clearDraft 清空；流式期间用户又打了一条
    await userEvent.type(textbox, "第二条草稿");
    expect(textbox).toHaveValue("第二条草稿");

    // 服务端分配会话 id：与 setSessionId 同批设迁移标记
    expect(captured.handlers?.onSession).toBeTypeOf("function");
    await act(async () => {
      captured.handlers!.onSession!("s-new-1");
    });

    // 下一条草稿被迁到 s-new-1，而不是被清空
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("第二条草稿"));
  });
});
