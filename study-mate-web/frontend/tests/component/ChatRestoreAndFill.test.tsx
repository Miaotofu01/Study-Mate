import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "@/components/ChatView";
import { makeProvider, makeSettings } from "./fixtures";

// 2026-10-05 拍板③④的组件级回归：
//  - 拍板③：开场选项点击只把文本填进输入框（不直接发送），发送走输入框链路；
//  - 拍板④：挂载时 activeSessionId 非空且无 loadedSession ⇒ 自动重开该会话（恢复视图），
//    会话已被删（openSession 拒绝）时静默失败，不崩溃也不做兜底。
const { push, workspace, api, streamChat } = vi.hoisted(() => ({
  push: vi.fn(),
  workspace: { current: {} as Record<string, unknown> },
  api: {
    getSettings: vi.fn(),
    getSession: vi.fn(),
    getCourse: vi.fn(),
    attachmentFileUrl: vi.fn(() => "#"),
  },
  streamChat: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/workspace", async () => {
  const { useState } = await import("react");
  return {
    useWorkspace: () => workspace.current,
    // 状态化草稿：填充要能进受控输入框（真实 useState 驱动 re-render）
    useChatDraft: () => {
      const [value, setValue] = useState("");
      return { value, setValue, clearDraft: () => setValue("") };
    },
  };
});
vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  api,
  buildDraft: vi.fn(),
  streamChat,
  recheckTicket: vi.fn(),
  retryTicket: vi.fn(),
}));

function setWorkspace(over: Record<string, unknown>) {
  workspace.current = {
    sessions: [],
    subjects: [],
    subjectsLoaded: true,
    activeSessionId: null,
    activeSubjectSlug: null,
    activeNodeId: null,
    activeWorkspace: null,
    workspaceCandidates: [],
    setActiveSessionId: vi.fn(),
    setActiveSubject: vi.fn(),
    setActiveWorkspace: vi.fn(),
    renameSession: vi.fn(),
    loadedSession: null,
    clearLoadedSession: vi.fn(),
    refreshSessions: vi.fn(),
    refreshSubjects: vi.fn(),
    setMisconceptionDraft: vi.fn(),
    openSession: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
  api.getCourse.mockRejectedValue(new Error("no course"));
  // handleSend 对 streamChat 的返回值调用 .catch：必须回一个 Promise
  streamChat.mockImplementation(() => Promise.resolve());
});

describe("开场选项填充（拍板③）", () => {
  it("点击开场选项只填充输入框，不发起请求", async () => {
    setWorkspace({});
    render(<ChatView />);
    await screen.findByText("讲解一个概念");

    await userEvent.click(screen.getByRole("button", { name: "讲解一个概念" }));

    const textarea = screen.getByPlaceholderText(/给 StudyMate 发消息/);
    expect(textarea).toHaveValue("讲解一个概念");
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("填充后的文本由用户手动发送；探索入口同样只填充", async () => {
    setWorkspace({});
    render(<ChatView />);
    await screen.findByTestId("discovery-starter");

    await userEvent.click(screen.getByTestId("discovery-starter"));
    expect(screen.getByPlaceholderText(/给 StudyMate 发消息/)).toHaveValue(
      "不知道学什么，帮我选方向",
    );

    await userEvent.click(screen.getByTitle("发送"));
    expect(streamChat).toHaveBeenCalledTimes(1);
  });
});

describe("挂载恢复活动会话（拍板④）", () => {
  it("切页回来（activeSessionId 非空、无 loadedSession）自动重开该会话", async () => {
    const openSession = vi.fn().mockResolvedValue(undefined);
    setWorkspace({ activeSessionId: "s9", openSession });
    render(<ChatView />);

    await waitFor(() => expect(openSession).toHaveBeenCalledWith("s9"));
  });

  it("已有 loadedSession（正常点开会话）时不重复恢复", () => {
    const openSession = vi.fn().mockResolvedValue(undefined);
    setWorkspace({
      activeSessionId: "s1",
      openSession,
      loadedSession: {
        meta: {
          id: "s1",
          title: "旧会话",
          message_count: 1,
          created_at: 1,
          updated_at: 1,
          subject_slug: null,
          node_id: null,
          mode: "chat",
          workspace: null,
          usage: null,
          active: null,
        },
        messages: [{ role: "user", content: "旧问题" }],
      },
    });
    render(<ChatView />);

    expect(openSession).not.toHaveBeenCalled();
    expect(screen.getByText("旧问题")).toBeInTheDocument();
  });

  it("会话已被删除（openSession 拒绝）时静默失败，界面停留在新对话空态", async () => {
    const openSession = vi.fn().mockRejectedValue(new Error("not found"));
    setWorkspace({ activeSessionId: "gone", openSession });
    render(<ChatView />);

    await waitFor(() => expect(openSession).toHaveBeenCalledWith("gone"));
    // 不崩溃：空态开场选项仍然在
    expect(await screen.findByText("讲解一个概念")).toBeInTheDocument();
  });
});
