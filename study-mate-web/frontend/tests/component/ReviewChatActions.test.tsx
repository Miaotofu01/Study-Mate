import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "@/components/ChatView";
import type { ChatMessage, SessionMeta, SubjectMeta } from "@/lib/types";
import { makeProvider, makeSettings } from "./fixtures";

// 修复期回归：聊天主链的编辑/删除下标一致性与建课中断/错误分支。
// 覆盖：
//  - B1：建课结束后回灌服务端消息，本地-only 卡不残留（下标与 server 一致）
//  - B3：建课进行中点「停止」必须中止编排流
//  - B7：仅思维链/工具、正文为空的错误轮不得把消息整条移除
const { push, workspace, api, buildDraft, streamChat } = vi.hoisted(() => ({
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
  buildDraft: vi.fn(),
  streamChat: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/workspace", async () => {
  const { useState } = await import("react");
  return {
    useWorkspace: () => workspace.current,
    // 状态化草稿（真实 useState）：2026-10-05 拍板③后开场选项只填充输入框，
    // 测试要走「点开场选项 → 填充 → 点发送」的完整链路，值必须能进受控输入框
    useChatDraft: () => {
      const [value, setValue] = useState("");
      return { value, setValue, clearDraft: () => setValue("") };
    },
  };
});
// partial mock：保留真实 normalizeError（ErrorNotice/chatStream 用它把错误收编成结构字段），
// 只替换 api/buildDraft/streamChat；整模块替换会让组件缺 normalizeError 导出。
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api,
    buildDraft,
    streamChat,
    recheckTicket: vi.fn(),
    retryTicket: vi.fn(),
  };
});

function setWorkspace(over: Record<string, unknown>) {
  workspace.current = {
    sessions: [] as SessionMeta[],
    subjects: [] as SubjectMeta[],
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
      // 建课编排开始/结束由 ChatView 上报（侧栏转圈推导用）
      setBuildingSessionId: vi.fn(),
    // 挂载恢复（2026-10-05 拍板④）在 activeSessionId 非空且无 loadedSession 时会调它
    openSession: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const sessionMeta: SessionMeta = {
  id: "s-build",
  title: "建课会话",
  message_count: 3,
  created_at: 1,
  updated_at: 1,
  subject_slug: null,
  node_id: null,
  mode: "interview",
  workspace: null,
  usage: null,
  active: null,
};

const confirmCard: ChatMessage = {
  role: "assistant",
  content: "盘问完成，已为「Python」建好草稿。",
  kind: "build_confirm",
  slug: "python",
};

beforeEach(() => {
  // reset（非 clear）清掉上一例遗留的实现/once 队列，避免跨例串味
  vi.resetAllMocks();
  api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
  api.getCourse.mockRejectedValue(new Error("no course"));
});

describe("聊天主链修复期回归", () => {
  it("建课结束后回灌服务端消息：本地-only 开始卡不残留（B1）", async () => {
    const serverMessages: ChatMessage[] = [
      { role: "user", content: "帮我选方向" },
      { role: "assistant", content: "盘问完成，已为「Python」建好草稿。", kind: "build_confirm", slug: "python" },
      { role: "assistant", content: "✅ 门禁完成（来自服务端）", kind: "stage" },
      { role: "assistant", content: "建课完成", kind: "done", slug: "python" },
    ];
    setWorkspace({
      activeSessionId: "s-build",
      loadedSession: { meta: sessionMeta, messages: [serverMessages[0], serverMessages[1]] },
    });
    api.getSession.mockResolvedValue({
      id: "s-build",
      title: "建课会话",
      messages: serverMessages,
      created_at: 1,
      updated_at: 1,
      usage: null,
      active: null,
    });
    buildDraft.mockImplementation(
      (_slug: string, handlers: Record<string, (p: unknown) => void>) => {
        handlers.onStage({ stage: "门禁", status: "done" });
        handlers.onDone({ slug: "python", message: "建课完成" });
        return Promise.resolve();
      },
    );

    render(<ChatView />);
    await screen.findByTestId("build-confirm-card");
    await userEvent.click(screen.getByTestId("build-confirm-button"));

    // 回灌后：服务端卡在、本地-only「开始建课编排」卡被替换掉
    await waitFor(() => expect(api.getSession).toHaveBeenCalledWith("s-build"));
    await screen.findByText("✅ 门禁完成（来自服务端）");
    expect(screen.queryByText(/开始建课编排/)).not.toBeInTheDocument();
    // done 卡只应有一张（服务端回灌那一张），不是本地追加的重复
    expect(screen.getAllByTestId("build-done-card")).toHaveLength(1);
  });

  it("建课进行中点停止会中止编排流（B3）", async () => {
    setWorkspace({ activeSessionId: "s-build", loadedSession: { meta: sessionMeta, messages: [confirmCard] } });
    let captured: AbortSignal | null = null;
    buildDraft.mockImplementation(
      (_slug: string, _handlers: unknown, _sid: unknown, signal: AbortSignal) => {
        captured = signal;
        return new Promise<void>(() => undefined);
      },
    );

    render(<ChatView />);
    await screen.findByTestId("build-confirm-card");
    await userEvent.click(screen.getByTestId("build-confirm-button"));
    await userEvent.click(await screen.findByTitle("停止"));

    expect(captured).not.toBeNull();
    expect(captured!.aborted).toBe(true);
    // 停止后回到发送态
    await screen.findByTitle("发送");
  });

  it("仅思维链、正文为空的错误轮不清空该条消息（B7）", async () => {
    setWorkspace({ activeSessionId: null, loadedSession: null });
    streamChat.mockImplementation(
      (
        _text: string,
        _sid: string | null,
        handlers: { onReasoning?: (p: string) => void; onError?: (m: string) => void },
      ) => {
        handlers.onReasoning?.("先想想这个问题的边界");
        handlers.onError?.("上游传输错误");
        return Promise.resolve();
      },
    );

    render(<ChatView />);
    // 开场选项只填充输入框（拍板③）：填充后点发送触发 handleSend
    await userEvent.click(screen.getByRole("button", { name: "讲解一个概念" }));
    await userEvent.click(screen.getByTitle("发送"));

    // 消息保留：思维链折叠面板还在（修复前占位被整条移除 → 无面板）
    await screen.findByTestId("process-panel");
    expect(screen.getByText("上游传输错误")).toBeInTheDocument();
  });

  it("会话绑定的提供商被删后回落到全局默认，不误禁用输入（B10）", async () => {
    const staleMeta: SessionMeta = {
      ...sessionMeta,
      id: "s1",
      title: "旧会话",
      mode: "chat",
      active: { provider_id: "gone", model: "removed-model" },
    };
    setWorkspace({
      activeSessionId: "s1",
      loadedSession: { meta: staleMeta, messages: [{ role: "user", content: "旧问题" }] },
    });

    render(<ChatView />);
    await screen.findByText("旧问题");

    // 显示真实生效的默认模型（而非失效绑定/未选择），输入框可用
    await waitFor(() =>
      expect(screen.getByTitle("切换当前使用的提供商 / 模型")).toHaveTextContent(
        "测试渠道 / model-a",
      ),
    );
    expect(screen.getByRole("textbox")).toBeEnabled();
  });

  it("回灌失败显示错误+重试并暂停发送/编辑，重试成功后恢复（F3/F4）", async () => {
    const serverMessages: ChatMessage[] = [
      { role: "user", content: "帮我选方向" },
      { role: "assistant", content: "盘问完成，已为「Python」建好草稿。", kind: "build_confirm", slug: "python" },
      { role: "assistant", content: "✅ 门禁完成（来自服务端）", kind: "stage" },
      { role: "assistant", content: "建课完成", kind: "done", slug: "python" },
    ];
    setWorkspace({
      activeSessionId: "s-build",
      loadedSession: { meta: sessionMeta, messages: [serverMessages[0], serverMessages[1]] },
    });
    const sessionObj = {
      id: "s-build",
      title: "建课会话",
      messages: serverMessages,
      created_at: 1,
      updated_at: 1,
      usage: null,
      active: null,
    };
    api.getSession.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(sessionObj);
    buildDraft.mockImplementation(
      (_slug: string, handlers: Record<string, (p: unknown) => void>) => {
        handlers.onDone({ slug: "python", message: "建课完成" });
        return Promise.resolve();
      },
    );

    render(<ChatView />);
    await screen.findByTestId("build-confirm-card");
    await userEvent.click(screen.getByTestId("build-confirm-button"));

    // 失败：错误 banner + 发送/编辑暂停
    await screen.findByTestId("chat-sync-error");
    expect(screen.getByRole("textbox")).toBeDisabled();

    // 重试成功：banner 消失、恢复可发送
    await userEvent.click(
      within(screen.getByTestId("chat-sync-error")).getByRole("button", { name: "重试" }),
    );
    await waitFor(() => expect(screen.queryByTestId("chat-sync-error")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
  });

  it("对话轮结束后对齐后端补写的消息（F5）", async () => {
    setWorkspace({ activeSessionId: null, loadedSession: null });
    api.getSession.mockResolvedValue({
      id: "s5",
      title: "新对话",
      messages: [
        { role: "user", content: "讲解一个概念" },
        { role: "assistant", content: "好的，我们开始。" },
        { role: "assistant", content: "未收到建课收口标记：请再说一次「按上面的结论建课」。", kind: "error" },
      ],
      created_at: 1,
      updated_at: 1,
      usage: null,
      active: null,
    });
    streamChat.mockImplementation(
      (
        _text: string,
        _sid: string | null,
        handlers: { onSession?: (id: string) => void; onDone?: (id: string) => void },
      ) => {
        handlers.onSession?.("s5");
        handlers.onDone?.("s5");
        return Promise.resolve();
      },
    );

    render(<ChatView />);
    // 开场选项只填充输入框（拍板③）：填充后点发送触发 handleSend
    await userEvent.click(screen.getByRole("button", { name: "讲解一个概念" }));
    await userEvent.click(screen.getByTitle("发送"));

    await waitFor(() => expect(api.getSession).toHaveBeenCalledWith("s5"));
    // 后端在 SSE 之外补写的收口提示应对齐显示（此前本地看不到 → 下标持续偏移）
    await screen.findByText(/未收到建课收口标记/);
  });
});
