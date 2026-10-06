import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "@/components/ChatView";
import type { ChatMessage, SessionMeta, SubjectMeta } from "@/lib/types";
import { makeProvider, makeSettings } from "./fixtures";

// R7 前端契约：用户气泡 / 编辑框 / 复制用 `display_content ?? content`，附件提取文本不得暴露；
// 旧消息（无字段）回落 content；附件-only 空串保持空（不回落成提取块）。助手消息仍用 content。
const EXTRACT_MARK = "UNIQUE_EXTRACT_MARK_9f3a17";

const { push, workspace, api, streamChat } = vi.hoisted(() => ({
  push: vi.fn(),
  workspace: { current: {} as Record<string, unknown> },
  api: {
    getSettings: vi.fn(),
    getCourse: vi.fn(),
    getWorkspace: vi.fn(),
    attachmentFileUrl: vi.fn(() => "#"),
    courseFileUrl: vi.fn(() => "#"),
    draftFileUrl: vi.fn(() => "#"),
    uploadAttachment: vi.fn(),
    promoteDraft: vi.fn(),
    renameSession: vi.fn(),
  },
  streamChat: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => workspace.current,
  useChatDraft: vi.fn(() => ({ value: "", setValue: vi.fn(), clearDraft: vi.fn() })),
}));
vi.mock("@/lib/api", () => ({
  api,
  buildDraft: vi.fn(),
  streamChat,
  recheckTicket: vi.fn(),
  retryTicket: vi.fn(),
}));

const sessionMeta: SessionMeta = {
  id: "s-display",
  title: "展示契约",
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

function loadSession(messages: ChatMessage[]) {
  workspace.current = {
    sessions: [sessionMeta],
    subjects: [] as SubjectMeta[],
    subjectsLoaded: true,
    activeSessionId: sessionMeta.id,
    activeSubjectSlug: null,
    activeNodeId: null,
    activeWorkspace: null,
    workspaceCandidates: [],
    setActiveSessionId: vi.fn(),
    setActiveSubject: vi.fn(),
    setActiveWorkspace: vi.fn(),
    renameSession: vi.fn(),
    loadedSession: { meta: sessionMeta, messages },
    clearLoadedSession: vi.fn(),
    refreshSessions: vi.fn(),
    refreshSubjects: vi.fn(),
    setMisconceptionDraft: vi.fn(),
      // 建课编排开始/结束由 ChatView 上报（侧栏转圈推导用）
      setBuildingSessionId: vi.fn(),
  };
  api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
}

const attachment = { id: "att-1", filename: "notes.txt", kind: "doc" as const, size: 10 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ChatView display_content（R7 展示文本分离）", () => {
  it("用户气泡只显示原文，编辑框预填原文，提取文本不出现", async () => {
    loadSession([
      {
        role: "user",
        content: `用户原文\n\n附件：notes.txt\n${EXTRACT_MARK}`,
        display_content: "用户原文",
        attachments: [attachment],
      },
      { role: "assistant", content: "助手的回答" },
    ]);
    render(<ChatView />);

    expect(await screen.findByText("用户原文")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(EXTRACT_MARK))).not.toBeInTheDocument();
    expect(screen.getByText("助手的回答")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("user-message-edit"));
    expect(screen.getByTestId("message-edit-input")).toHaveValue("用户原文");
  });

  it("旧消息无 display_content 字段时回落 content", async () => {
    loadSession([{ role: "user", content: "旧的用户消息" }]);
    render(<ChatView />);
    expect(await screen.findByText("旧的用户消息")).toBeInTheDocument();
  });

  it("附件-only 空 display_content 保持为空，不回落显示提取块", async () => {
    loadSession([
      {
        role: "user",
        content: `附件：notes.txt\n${EXTRACT_MARK}`,
        display_content: "",
        attachments: [attachment],
      },
      { role: "assistant", content: "看完了" },
    ]);
    render(<ChatView />);

    expect(await screen.findByText("看完了")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(EXTRACT_MARK))).not.toBeInTheDocument();
    // 空正文也仍是用户消息：操作条在（可编辑），编辑框预填空串
    await userEvent.click(screen.getByTestId("user-message-edit"));
    expect(screen.getByTestId("message-edit-input")).toHaveValue("");
  });

  it("附件-only 空正文可原样重发：空 message + 原附件 ids + replace_from", async () => {
    loadSession([
      {
        role: "user",
        content: `附件：notes.txt\n${EXTRACT_MARK}`,
        display_content: "",
        attachments: [attachment],
      },
      { role: "assistant", content: "看完了" },
    ]);
    render(<ChatView />);
    await screen.findByText("看完了");
    await userEvent.click(screen.getByTestId("user-message-edit"));

    // 与 Composer 同口径：有附件时发送按钮不禁用（此前空正文被 early return / disabled 挡住）
    const submitButton = screen.getByTestId("message-edit-submit");
    expect(submitButton).toBeEnabled();
    streamChat.mockImplementation(() => new Promise(() => undefined));
    await userEvent.click(submitButton);

    expect(streamChat).toHaveBeenCalledTimes(1);
    const [message, , , options] = streamChat.mock.calls[0];
    expect(message).toBe("");
    expect(options.attachments).toEqual(["att-1"]);
    expect(options.replaceFrom).toBe(0);
  });
});
