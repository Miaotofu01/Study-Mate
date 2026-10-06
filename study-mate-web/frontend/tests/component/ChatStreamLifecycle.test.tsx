import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "@/components/ChatView";
import { getChatRun } from "@/lib/chatStream";
import type { ChatMessage, ErrorInfo, MessagePart, SessionMeta } from "@/lib/types";
import { makeProvider, makeSettings } from "./fixtures";

/**
 * 会话流生命周期组件回归：流独立于 ChatView 挂载、按 session_id 存活（lib/chatStream.ts）；
 * 切会话不 abort、仅显式停止 abort 当前会话；切回优先用 store；parts 按到达顺序渲染。
 *
 * 用真实 ChatView + 真实 chatStream store，仅 mock @/lib/api 的 streamChat/getSession。
 * 每例唯一 session id：store 是模块级 Map，避免跨用例串状态。
 */

// 每个用例用唯一 session id：chatStream store 是模块级 Map，避免跨用例串状态。
let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

const userMsg = (text: string): ChatMessage => ({ role: "user", content: text, display_content: text });
const assistantMsg = (over: Partial<ChatMessage> = {}): ChatMessage => ({ role: "assistant", content: "", ...over });

function metaOf(id: string, title: string, messageCount: number): SessionMeta {
  return {
    id,
    title,
    message_count: messageCount,
    created_at: 1,
    updated_at: 2,
    subject_slug: null,
    node_id: null,
    mode: "chat",
    workspace: null,
    usage: null,
    active: null,
  };
}

// ── 受控 workspace store（真实 useState 语义：openSession 触发 re-render） ─────────────
const ws = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let snapshot: Record<string, unknown> = {};
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    init(base: Record<string, unknown>) {
      snapshot = base;
      emit();
    },
    get(): Record<string, unknown> {
      return snapshot;
    },
    patch(over: Record<string, unknown>) {
      snapshot = { ...snapshot, ...over };
      emit();
    },
    subscribe(l: () => void): () => void {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
});

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getSession: vi.fn(),
  getCourse: vi.fn(),
  getWorkspace: vi.fn(),
  attachmentFileUrl: vi.fn(() => "#"),
  courseFileUrl: vi.fn(() => "#"),
  draftFileUrl: vi.fn(() => "#"),
  promoteDraft: vi.fn(),
  uploadAttachment: vi.fn(),
  stopSession: vi.fn(),
}));
const streamChat = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock("@/lib/workspace", async () => {
  const React = await import("react");
  return {
    useWorkspace: () =>
      React.useSyncExternalStore(ws.subscribe, ws.get as () => never, ws.get as () => never),
    useChatDraft: () => {
      const [value, setValue] = React.useState("");
      return { value, setValue, clearDraft: () => setValue("") };
    },
  };
});

// partial mock：保留真实 normalizeError/redactSecrets 等纯函数（chatStream/ErrorNotice 用它收编错误），
// 只替换 api 与 streamChat；不能整模块替换，否则组件里的 normalizeError 会缺导出。
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api,
    buildDraft: vi.fn(),
    streamChat,
    recheckTicket: vi.fn(),
    retryTicket: vi.fn(),
  };
});

// 受控 streamChat：捕获每次调用的 handlers/options；signal abort 时以 AbortError 拒绝。
type Captured = {
  handlers: Record<string, (...args: never[]) => void>;
  options: { signal?: AbortSignal; replaceFrom?: number };
};
const calls: Captured[] = [];
function lastCall(): Captured {
  const call = calls[calls.length - 1];
  if (!call) throw new Error("streamChat 未被调用");
  return call;
}

function installControlledStream(): void {
  calls.length = 0;
  streamChat.mockImplementation(
    (
      _message: string,
      _sessionId: string | null,
      handlers: Captured["handlers"],
      options: Captured["options"],
    ) => {
      calls.push({ handlers, options });
      return new Promise<void>((_resolve, reject) => {
        const signal = options?.signal;
        const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (!signal) return;
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  );
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────────
const REVIEW_TEXT = "第一节课已经产出完成！";
const CONTINUE = "请继续";

function harness(): {
  aId: string;
  bId: string;
  aLoaded: ChatMessage[];
  serverA: ChatMessage[];
  serverB: ChatMessage[];
} {
  const aId = uniq("A");
  const bId = uniq("B");
  const aLoaded: ChatMessage[] = [
    userMsg("从这个科目开始学习"),
    assistantMsg({
      content: "好的，我们开始学习「网页组件认知与设计入门」！",
      reasoning: "先了解学习环境……",
      tools: [
        { id: "call_list", name: "list_workspace", arguments: "{}", status: "done", result: "…", isError: false },
        { id: "call_produce", name: "produce_lesson", arguments: "{}", status: "running" },
      ],
      notices: ["讲解中…", "（本轮输出过程中连接中断，这里只保存了已经产出的部分。）"],
    }),
    userMsg(CONTINUE),
    assistantMsg({ content: "第一节课已经产出完成……" }),
  ];
  const serverA: ChatMessage[] = [aLoaded[0], aLoaded[1], userMsg(CONTINUE)];
  const serverB: ChatMessage[] = [userMsg("B 的问题"), assistantMsg({ content: "B 的回答" })];

  api.getSession.mockImplementation(async (id: string) => {
    if (id === aId) return { id: aId, title: "从这个科目开始学习", messages: serverA };
    if (id === bId) return { id: bId, title: "另一个会话", messages: serverB };
    throw new Error(`unexpected session ${id}`);
  });

  ws.init({
    sessions: [metaOf(aId, "从这个科目开始学习", aLoaded.length), metaOf(bId, "另一个会话", serverB.length)],
    subjects: [],
    subjectsLoaded: true,
    activeSessionId: aId,
    activeSubjectSlug: null,
    activeNodeId: null,
    activeWorkspace: null,
    workspaceCandidates: [],
    loadedSession: { meta: metaOf(aId, "从这个科目开始学习", aLoaded.length), messages: aLoaded },
    setActiveSessionId: (id: string | null) => {
      if (ws.get().activeSessionId !== id) ws.patch({ activeSessionId: id });
    },
    setActiveSubject: vi.fn(),
    setActiveWorkspace: vi.fn(),
    renameSession: vi.fn(),
    clearLoadedSession: () => ws.patch({ loadedSession: null }),
    openSession: async (id: string) => {
      const data = (await api.getSession(id)) as { id: string; title: string; messages: ChatMessage[] };
      ws.patch({
        activeSessionId: id,
        loadedSession: { meta: metaOf(data.id, data.title, data.messages.length), messages: data.messages },
      });
    },
    refreshSessions: vi.fn(),
    refreshSubjects: vi.fn(),
    setMisconceptionDraft: vi.fn(),
  });
  return { aId, bId, aLoaded, serverA, serverB };
}

function mountStaticWorkspace(sid: string, messages: ChatMessage[], streaming = false): void {
  ws.init({
    sessions: [metaOf(sid, "静态会话", messages.length)],
    subjects: [],
    subjectsLoaded: true,
    activeSessionId: sid,
    activeSubjectSlug: null,
    activeNodeId: null,
    activeWorkspace: null,
    workspaceCandidates: [],
    loadedSession: { meta: metaOf(sid, "静态会话", messages.length), messages, streaming },
    setActiveSessionId: vi.fn(),
    setActiveSubject: vi.fn(),
    setActiveWorkspace: vi.fn(),
    renameSession: vi.fn(),
    clearLoadedSession: vi.fn(),
    openSession: vi.fn(),
    refreshSessions: vi.fn(),
    refreshSubjects: vi.fn(),
    setMisconceptionDraft: vi.fn(),
  });
}

async function switchTo(id: string): Promise<void> {
  await act(async () => {
    await (ws.get().openSession as (id: string) => Promise<void>)(id);
  });
}

async function editResendUserMessage(text: string): Promise<void> {
  const edits = screen.getAllByTestId("user-message-edit");
  await userEvent.click(edits[edits.length - 1]);
  const box = await screen.findByTestId("message-edit-box");
  const input = box.querySelector("textarea") as HTMLTextAreaElement;
  await userEvent.clear(input);
  if (text) await userEvent.type(input, text);
  await userEvent.click(screen.getByTestId("message-edit-submit"));
}

async function sendViaComposer(text: string): Promise<void> {
  const box = screen.getByPlaceholderText(/给 StudyMate 发消息/);
  await userEvent.type(box, text);
  await userEvent.click(screen.getByTitle("发送"));
}

/** assistant-parts 里各 part wrapper 的 data-part-type，按文档顺序。 */
function partTypes(): (string | null)[] {
  const host = screen.getByTestId("assistant-parts");
  return Array.from(host.querySelectorAll("[data-part-type]")).map((el) =>
    el.getAttribute("data-part-type"),
  );
}

function partsOfType(type: string): HTMLElement[] {
  const host = screen.getByTestId("assistant-parts");
  return Array.from(host.querySelectorAll<HTMLElement>(`[data-part-type="${type}"]`));
}

/** 只取 assistant-parts 里的工具卡（避开历史轮 legacy 布局里的工具卡）。 */
function toolCardsInParts(): HTMLElement[] {
  const host = screen.getByTestId("assistant-parts");
  return Array.from(host.querySelectorAll<HTMLElement>('[data-testid="tool-card"]'));
}

beforeEach(() => {
  vi.resetAllMocks();
  installControlledStream();
  api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
  api.getCourse.mockRejectedValue(new Error("no course"));
  // 停止先登记服务端 intent（限时），成功/失败都回落到本地 abort；测试给成功回执。
  api.stopSession.mockResolvedValue({ ok: true, stop: true });
});

describe("回归 · 切会话不 abort 在飞流，切回优先用 store 恢复", () => {
  it("A 流式中切到 B：A 的流不被 abort", async () => {
    const { bId } = harness();
    render(<ChatView />);
    await screen.findByText(CONTINUE);

    await editResendUserMessage(CONTINUE);
    await act(async () => {
      lastCall().handlers.onToolCall({ id: "call_p", name: "produce_lesson", arguments: "{}" } as never);
      lastCall().handlers.onDelta(REVIEW_TEXT as never);
    });
    expect(screen.getByText(REVIEW_TEXT)).toBeInTheDocument();

    await switchTo(bId);

    expect(lastCall().options.signal?.aborted).toBe(false);
  });

  it("A→B→A：切回 A 时已产出的正文/工具卡从 store 恢复（不被服务端快照覆盖）", async () => {
    const { aId, bId } = harness();
    render(<ChatView />);
    await screen.findByText(CONTINUE);

    await editResendUserMessage(CONTINUE);
    await act(async () => {
      lastCall().handlers.onToolCall({ id: "call_p", name: "produce_lesson", arguments: "{}" } as never);
      lastCall().handlers.onDelta(REVIEW_TEXT as never);
    });

    await switchTo(bId);
    expect(await screen.findByText("B 的回答")).toBeInTheDocument();
    await switchTo(aId);

    expect(screen.getByText(REVIEW_TEXT)).toBeInTheDocument();
    // 加载的历史轮本身也带旧工具卡，这里只要求本轮的工具卡存在
    expect(screen.getAllByTestId("tool-cards").length).toBeGreaterThan(0);
  });

  it("后台继续：切走后新的 delta 仍追加到 A，切回可见", async () => {
    const { aId, bId } = harness();
    render(<ChatView />);
    await screen.findByText(CONTINUE);

    await editResendUserMessage(CONTINUE);
    await switchTo(bId);
    await act(async () => {
      lastCall().handlers.onDelta("切走后产生的新内容" as never);
    });
    await switchTo(aId);

    expect(screen.getByText("切走后产生的新内容")).toBeInTheDocument();
    expect(lastCall().options.signal?.aborted).toBe(false);
  });
});

describe("回归 · 停止只 abort 当前会话的流", () => {
  it("在 B 点停止只 abort B，A 的后台流不受影响", async () => {
    const { bId } = harness();
    render(<ChatView />);
    await screen.findByText(CONTINUE);

    await editResendUserMessage(CONTINUE);
    await act(async () => {
      lastCall().handlers.onDelta("A 正在流……" as never);
    });
    const aCall = lastCall();

    await switchTo(bId);
    expect(await screen.findByText("B 的回答")).toBeInTheDocument();

    await sendViaComposer("B 的新消息");
    expect(calls).toHaveLength(2);
    const bCall = lastCall();
    await act(async () => {
      bCall.handlers.onDelta("B 正在流……" as never);
    });

    await userEvent.click(screen.getByTitle("停止"));
    // stopChatRun 现在是 async：登记 stop intent 后（微任务）才 abort，等它落地再断言。
    await act(async () => {});

    expect(bCall.options.signal?.aborted).toBe(true);
    expect(aCall.options.signal?.aborted).toBe(false);
  });
});

describe("回归 · 离开 /chat remount 经 store 恢复", () => {
  it("流式中卸载再挂载，应经 store 恢复本轮流式内容", async () => {
    harness();
    const first = render(<ChatView />);
    await screen.findByText(CONTINUE);

    await editResendUserMessage(CONTINUE);
    await act(async () => {
      lastCall().handlers.onDelta("remount 前已产出的半截正文" as never);
    });
    expect(screen.getByText("remount 前已产出的半截正文")).toBeInTheDocument();

    first.unmount();
    ws.patch({ loadedSession: null });
    render(<ChatView />);

    await waitFor(() =>
      expect(screen.getByText("remount 前已产出的半截正文")).toBeInTheDocument(),
    );
  });
});

describe("回归 · 后台流事件不得串到别的会话", () => {
  it("切到 B 后，A 的 onError 不在 B 上弹错误横幅；切回 A 才显示", async () => {
    const { aId, bId, serverA, serverB } = harness();
    // 服务端会把本轮错误随助手消息持久化为结构化 error（刷新/同步的权威口径）：
    // 这里让 A 的快照带上该 error，验证「同步后服务端 message 仍有 error」而非本地字符串被冲掉。
    const aError: ErrorInfo = {
      code: "upstream_transport",
      status: null,
      upstream_code: null,
      phase: "stream",
      summary: "A 的后台错误",
      detail: null,
      retryable: true,
      stopped_reason: "disconnect",
      request_id: "turn-a",
    };
    api.getSession.mockImplementation(async (id: string) =>
      id === aId
        ? {
            id: aId,
            title: "从这个科目开始学习",
            messages: [
              ...serverA,
              assistantMsg({ content: "", error: aError, stream_state: "error" }),
            ],
          }
        : { id: bId, title: "另一个会话", messages: serverB },
    );

    render(<ChatView />);
    await screen.findByText(CONTINUE);

    await editResendUserMessage(CONTINUE);
    await switchTo(bId);
    expect(await screen.findByText("B 的回答")).toBeInTheDocument();

    await act(async () => {
      lastCall().handlers.onError(aError as never);
    });

    expect(screen.queryByText("A 的后台错误")).not.toBeInTheDocument();
    expect(screen.getByText("B 的回答")).toBeInTheDocument();

    await switchTo(aId);
    expect(await screen.findByText("A 的后台错误")).toBeInTheDocument();
  });

  it("切到 B 后，A 的 onDelta 不改写 B 的最后一条消息", async () => {
    const { bId } = harness();
    render(<ChatView />);
    await screen.findByText(CONTINUE);

    await editResendUserMessage(CONTINUE);
    await switchTo(bId);
    expect(await screen.findByText("B 的回答")).toBeInTheDocument();

    await act(async () => {
      lastCall().handlers.onDelta("（这段属于 A）" as never);
    });

    expect(screen.queryByText(/这段属于 A/)).not.toBeInTheDocument();
    expect(screen.getByText("B 的回答")).toBeInTheDocument();
  });
});

describe("有序 parts 渲染", () => {
  it("实时：textA → tool1 → textB → tool2 → textC 按流到达顺序渲染，tool result 原位", async () => {
    harness();
    render(<ChatView />);
    await screen.findByText(CONTINUE);

    await editResendUserMessage(CONTINUE);
    const h = lastCall().handlers;
    await act(async () => {
      h.onDelta("文A" as never);
      h.onToolCall({ id: "t1", name: "list_workspace", arguments: "{}" } as never);
      h.onDelta("文B" as never);
      h.onToolResult({ id: "t1", name: "list_workspace", content: "结果一", is_error: false } as never);
      h.onToolCall({ id: "t2", name: "produce_lesson", arguments: "{}" } as never);
      h.onDelta("文C" as never);
    });

    expect(partTypes()).toEqual(["text", "tool", "text", "tool", "text"]);
    const texts = partsOfType("text").map((el) => el.textContent);
    expect(texts).toEqual(["文A", "文B", "文C"]);
    const cards = toolCardsInParts();
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("结果一");
    expect(cards[0].textContent).toContain("list_workspace");
    expect(cards[1].textContent).toContain("produce_lesson");
  });

  it("加载：落库 parts 顺序保持，tool result 由 tool_id 原位、不位移", async () => {
    const sid = uniq("ord");
    const parts: MessagePart[] = [
      { type: "text", text: "文A" },
      { type: "tool", tool_id: "t1" },
      { type: "text", text: "文B" },
      { type: "tool", tool_id: "t2" },
      { type: "text", text: "文C" },
    ];
    mountStaticWorkspace(sid, [
      userMsg("顺序"),
      assistantMsg({
        content: "文A文B文C",
        parts,
        tools: [
          { id: "t1", name: "list_workspace", arguments: "{}", status: "done", result: "结果一", isError: false },
          { id: "t2", name: "produce_lesson", arguments: "{}", status: "done", result: "结果二", isError: false },
        ],
      }),
    ]);
    render(<ChatView />);

    expect(await screen.findByTestId("assistant-parts")).toBeInTheDocument();
    expect(partTypes()).toEqual(["text", "tool", "text", "tool", "text"]);
    expect(partsOfType("text").map((el) => el.textContent)).toEqual(["文A", "文B", "文C"]);
    const cards = toolCardsInParts();
    expect(cards[0].textContent).toContain("结果一");
    expect(cards[1].textContent).toContain("结果二");
  });

  it("reasoning / notice part 也按顺序渲染为对应 data-part-type", async () => {
    const sid = uniq("rn");
    mountStaticWorkspace(sid, [
      userMsg("推理"),
      assistantMsg({
        content: "正文",
        parts: [
          { type: "reasoning", text: "思路一" },
          { type: "notice", text: "提示一" },
          { type: "text", text: "正文" },
        ],
        reasoning: "思路一",
        notices: ["提示一"],
      }),
    ]);
    render(<ChatView />);

    expect(await screen.findByTestId("assistant-parts")).toBeInTheDocument();
    expect(partTypes()).toEqual(["reasoning", "notice", "text"]);
  });

  it("legacy 回落：无 parts 的旧消息仍按 content/reasoning/tools 渲染", async () => {
    const sid = uniq("legacy");
    mountStaticWorkspace(sid, [
      userMsg("旧问题"),
      assistantMsg({
        content: "旧回答正文",
        reasoning: "旧思维链",
        tools: [{ id: "t1", name: "list_workspace", arguments: "{}", status: "done", result: "旧结果", isError: false }],
      }),
    ]);
    render(<ChatView />);

    expect(await screen.findByText("旧回答正文")).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-parts")).not.toBeInTheDocument();
    expect(screen.getByTestId("tool-cards")).toBeInTheDocument();
    expect(screen.getByText("list_workspace")).toBeInTheDocument();
  });
});

describe("边界 · 已结束缓存不覆盖 API 新开的更新会话", () => {
  it("completed run 同步完成后再开更新会话（更多消息）：用 fresh 而非旧缓存，编辑下标基于 fresh", async () => {
    const { aId, aLoaded } = harness();
    render(<ChatView />);
    await screen.findByText(CONTINUE);

    await editResendUserMessage(CONTINUE);
    await act(async () => {
      lastCall().handlers.onDelta("本轮完成" as never);
      lastCall().handlers.onDone("" as never);
    });
    // 等本轮 run 的 sync 落地：settled 且不在 syncing
    await waitFor(() => {
      const run = getChatRun(aId);
      expect(run?.streaming).toBe(false);
      expect(run?.syncing).toBe(false);
    });

    // 服务端会话被更新：追加一轮（共 6 条，最后一条用户消息下标 4）
    const fresh: ChatMessage[] = [
      ...aLoaded,
      userMsg("后来追加的问题"),
      assistantMsg({ content: "后来追加的回答" }),
    ];
    api.getSession.mockImplementation(async (id: string) =>
      id === aId
        ? { id: aId, title: "从这个科目开始学习", messages: fresh }
        : { id: "B", title: "另一个会话", messages: [] },
    );

    await switchTo(aId);

    // 用 fresh（旧 completed 缓存里没有这一条）
    expect(screen.getByText("后来追加的回答")).toBeInTheDocument();
    // 编辑下标基于 fresh：最后一条用户消息 = index 4
    await editResendUserMessage("后来追加的问题");
    expect(lastCall().options.replaceFrom).toBe(4);
  });
});

describe("边界 · 初始恢复（loadedSession.streaming，无 store）轮询到完成", () => {
  it("GET 先 busy 后 false：同步期间输入禁用，完成后解除并呈现最新 parts", async () => {
    const sid = uniq("reload");
    const partial: ChatMessage[] = [
      userMsg("进度"),
      assistantMsg({ content: "半截", parts: [{ type: "text", text: "半截" }] }),
    ];
    const settled: ChatMessage[] = [
      userMsg("进度"),
      assistantMsg({
        content: "完整正文",
        parts: [
          { type: "text", text: "完整正文" },
          { type: "tool", tool_id: "t1" },
        ],
        tools: [
          { id: "t1", name: "read_course_file", arguments: "{}", status: "done", result: "ok", isError: false },
        ],
      }),
    ];
    let call = 0;
    api.getSession.mockImplementation(async (id: string) => {
      call += 1;
      return { id, title: "重载", messages: call === 1 ? partial : settled, streaming: call === 1 };
    });
    mountStaticWorkspace(sid, partial, true);

    render(<ChatView />);

    // 同步中：未同步 → 输入禁用（Composer 禁用时 placeholder 会换成提示语，故按 role 取）
    await waitFor(() => expect(screen.getByRole("textbox")).toBeDisabled());

    // 轮询完成后：最新 parts 呈现、输入解除
    await waitFor(() => expect(screen.getByText("完整正文")).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByTestId("assistant-parts")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox")).not.toBeDisabled());
  });
});
