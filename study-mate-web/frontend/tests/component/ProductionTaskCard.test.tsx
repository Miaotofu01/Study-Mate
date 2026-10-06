import { createElement } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "@/components/ChatView";
import { ProductionTaskCard } from "@/components/ProductionTaskCard";
import type {
  AssessmentOutcome,
  ChatMessage,
  LessonLink,
  ProductionTask,
  SessionMeta,
  TaskRole,
} from "@/lib/types";
import { makeProvider, makeSettings } from "./fixtures";

/**
 * 产课任务卡 / 评估状态 / 课件入口组件回归。
 * 用真实 ChatView + 真实 chatStream store，仅 mock @/lib/api 的 streamChat/getSession；
 * task_update / tool_result 走真实 handlers，不假装后端已生成 fixture。
 */

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
// Next Link 在无 App Router provider 的 jsdom 里需要最小 mock：保留 href 语义。
vi.mock("next/link", () => ({
  default: (props: { href: string; children: unknown }) => {
    const { href, children, ...rest } = props as Record<string, unknown> & { href: string };
    return createElement("a", { href, ...rest }, children as never);
  },
}));

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

// partial mock：保留真实 normalizeError/redactSecrets（ErrorNotice 与 chatStream.finish 依赖），
// 只替换 api 与 streamChat；整模块替换会让组件缺 normalizeError 导出。
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

type Captured = {
  handlers: Record<string, (...args: never[]) => void>;
  options: { signal?: AbortSignal };
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
        if (!signal) return;
        const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  );
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────────
const LESSON: LessonLink = {
  subject_slug: "python-basics",
  node_id: "py.var",
  title: "变量与赋值",
  workspace: "C:/ws/StudyMate",
  file: "lessons/0001-py.var.html",
};

function stage(id: string, name: string, status: "running" | "done" | "error", message?: string) {
  return { id, name, status, message };
}

function taskFixture(over: Partial<ProductionTask> = {}): ProductionTask {
  return {
    id: "task-1",
    kind: "produce_lesson",
    title: "变量与赋值",
    subject_slug: "python-basics",
    node_id: "py.var",
    workspace: "C:/ws/StudyMate",
    status: "running",
    stage: "讲解",
    elapsed_s: 3,
    round: 1,
    roles: [
      {
        id: "role-explainer",
        name: "讲解",
        status: "running",
        round: 1,
        elapsed_s: 2,
        parts: [
          { type: "text", text: "变量是给数据起名字。" },
          { type: "reasoning", text: "先讲定义再举例。" },
          {
            type: "tool",
            tool_id: "role-explainer#read",
          },
        ],
        tools: [
          {
            id: "role-explainer#read",
            name: "read_course_file",
            arguments: "{}",
            status: "done",
            result: "资料已读",
            isError: false,
          },
        ],
      },
    ],
    events: [stage("讲解#1", "讲解", "running"), stage("出题#1", "出题", "done")],
    ...over,
  };
}

/** 一次备用派工角色：真实契约 execution_mode=fallback + fallback_reason + max_seconds。 */
function fallbackRole(over: Partial<TaskRole> = {}): TaskRole {
  return {
    id: "role-fallback",
    name: "讲解",
    status: "running",
    execution_mode: "fallback",
    fallback_reason: "角色工具循环未交付",
    max_seconds: 1800,
    elapsed_s: 42,
    parts: [],
    tools: [],
    ...over,
  };
}

function metaOf(id: string, messageCount: number): SessionMeta {
  return {
    id,
    title: "产课会话",
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

function mountStaticWorkspace(sid: string, messages: ChatMessage[]): void {
  ws.init({
    sessions: [metaOf(sid, messages.length)],
    subjects: [],
    subjectsLoaded: true,
    activeSessionId: sid,
    activeSubjectSlug: null,
    activeNodeId: null,
    activeWorkspace: null,
    workspaceCandidates: [],
    loadedSession: { meta: metaOf(sid, messages.length), messages },
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

function mountEmptyWorkspace(sid: string): void {
  mountStaticWorkspace(sid, [{ role: "user", content: "开始", display_content: "开始" }]);
}

async function startRun(): Promise<Captured> {
  const box = screen.getByPlaceholderText(/给 StudyMate 发消息/);
  await userEvent.type(box, "产课");
  await userEvent.click(screen.getByTitle("发送"));
  return lastCall();
}

function partTypes(): (string | null)[] {
  const host = screen.getByTestId("assistant-parts");
  return Array.from(host.querySelectorAll("[data-part-type]")).map((el) =>
    el.getAttribute("data-part-type"),
  );
}

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

beforeEach(() => {
  vi.resetAllMocks();
  installControlledStream();
  api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
  api.getCourse.mockRejectedValue(new Error("no course"));
  // 停止先登记服务端 intent（限时），随后本地 abort；pendingRun（无 session）其实不走服务端。
  api.stopSession.mockResolvedValue({ ok: true, stop: true });
});

// ── 直接渲染任务卡 ───────────────────────────────────────────────────────────────
describe("ProductionTaskCard · 常显与展开", () => {
  it("常显角色/阶段/已等待，展开后角色正文保序、思考独立折叠", () => {
    render(<ProductionTaskCard task={taskFixture()} />);

    expect(screen.getByTestId("production-task-card")).toHaveAttribute("data-status", "running");
    expect(screen.getByTestId("task-title")).toHaveTextContent("变量与赋值");
    expect(screen.getByTestId("task-stage-current")).toHaveTextContent("讲解");
    expect(screen.getByTestId("task-elapsed")).toHaveTextContent("已等待 3s");
    expect(screen.getByTestId("task-roles").querySelectorAll('[data-testid="task-role"]')).toHaveLength(1);
    expect(screen.getByTestId("task-stages").querySelectorAll('[data-testid="task-stage"]')).toHaveLength(2);

    // 角色正文按 parts 顺序：text → reasoning(可折叠) → tool
    const body = within(screen.getByTestId("role-body"));
    expect(body.getByText("变量是给数据起名字。")).toBeInTheDocument();
    expect(screen.getByTestId("role-reasoning")).toBeInTheDocument();
    const toolCard = body.getByTestId("tool-card");
    expect(toolCard).toHaveAttribute("data-tool-id", "role-explainer#read");
    expect(within(toolCard).getByTestId("tool-result")).toHaveTextContent("资料已读");
    // 未完成不给课件入口
    expect(screen.queryByTestId("open-lesson")).not.toBeInTheDocument();
  });

  it("done 时常显「打开课件」，href 显式带 workspace（服务端结构化 lesson）", () => {
    render(
      <ProductionTaskCard
        task={taskFixture({ status: "done", lesson: LESSON, stage: undefined })}
      />,
    );
    const link = screen.getByTestId("open-lesson");
    expect(link).toHaveAttribute(
      "href",
      "/lesson?subject=python-basics&node=py.var&workspace=C%3A%2Fws%2FStudyMate",
    );
    // 不在 details 里：details 未展开仍可见
    expect(screen.getByTestId("task-details").hasAttribute("open")).toBe(false);
    expect(link).toBeVisible();
  });

  it("失败：明确错误、无打开课件按钮；中断：明确中断文案", () => {
    const first = render(
      <ProductionTaskCard task={taskFixture({ status: "error", error: "检查未通过", lesson: LESSON })} />,
    );
    expect(screen.getByTestId("task-error")).toHaveTextContent("检查未通过");
    expect(screen.queryByTestId("open-lesson")).not.toBeInTheDocument();
    first.unmount();

    render(<ProductionTaskCard task={taskFixture({ id: "t2", status: "interrupted" })} />);
    expect(screen.getByTestId("production-task-card")).toHaveAttribute("data-status", "interrupted");
    expect(screen.getByTestId("task-interrupted")).toHaveTextContent("已中断");
    expect(screen.queryByTestId("open-lesson")).not.toBeInTheDocument();
  });

  it("终态不再写「正在等待」：done 显示耗时", () => {
    render(<ProductionTaskCard task={taskFixture({ status: "done", lesson: LESSON, elapsed_s: 80 })} />);
    expect(screen.getByTestId("task-elapsed")).toHaveTextContent("耗时 80s");
    expect(screen.getByTestId("task-elapsed")).not.toHaveTextContent("已等待");
  });

  it.each(["done", "error", "timeout", "interrupted"] as const)(
    "%s 终态即使带 stage 也不显示「当前阶段」",
    (status) => {
      render(<ProductionTaskCard task={taskFixture({ status, stage: "检查" })} />);
      expect(screen.queryByTestId("task-stage-current")).not.toBeInTheDocument();
    },
  );
});

// ── fallback 备用派工角色的真实状态呈现 ───────────────────────────────────────────
describe("ProductionTaskCard · 备用派工", () => {
  it("fallback 角色常显「备用派工」徽标、原因、本次等待、调用时限与静默说明", () => {
    render(<ProductionTaskCard task={taskFixture({ roles: [fallbackRole()] })} />);

    expect(screen.getByTestId("role-fallback-badge")).toHaveTextContent("备用派工");
    const note = screen.getByTestId("fallback-note");
    expect(note).toHaveAttribute("data-role-id", "role-fallback");
    expect(screen.getByTestId("fallback-status")).toHaveTextContent("首次未交付，正在备用派工");
    expect(note).toHaveTextContent("原因：角色工具循环未交付");
    expect(screen.getByTestId("fallback-wait")).toHaveTextContent("本次角色等待 42s");
    expect(screen.getByTestId("fallback-limit")).toHaveTextContent("调用时限 1800s");
    expect(screen.getByTestId("fallback-silent")).toHaveTextContent("该角色为单次调用");
    expect(screen.getByTestId("fallback-silent")).toHaveTextContent("无正文与子工具增量");
  });

  it("max_seconds<=0 显示不承诺有限等待；终态文案不再说「正在」", () => {
    const first = render(
      <ProductionTaskCard task={taskFixture({ roles: [fallbackRole({ max_seconds: 0 })] })} />,
    );
    expect(screen.getByTestId("fallback-limit")).toHaveTextContent("不承诺有限等待");
    first.unmount();

    render(
      <ProductionTaskCard
        task={taskFixture({ status: "done", roles: [fallbackRole({ status: "done" })] })}
      />,
    );
    expect(screen.getByTestId("fallback-status")).toHaveTextContent("备用派工已完成");
    expect(screen.getByTestId("fallback-status")).not.toHaveTextContent("正在");
  });

  it("普通工具角色（tools / single_call / 缺省）不显示 fallback", () => {
    render(
      <ProductionTaskCard
        task={taskFixture({
          roles: [
            { id: "role-tools", name: "讲解", status: "running", execution_mode: "tools", parts: [], tools: [] },
            { id: "role-single", name: "出题", status: "running", execution_mode: "single_call", max_seconds: 1800, parts: [], tools: [] },
            { id: "role-legacy", name: "渲染", status: "running", parts: [], tools: [] },
          ],
        })}
      />,
    );
    expect(screen.queryByTestId("role-fallback-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fallback-notes")).not.toBeInTheDocument();
  });

  it("失败来源保留：首次角色 error 不因备用派工而伪成功，任务仍红错、无课件入口", () => {
    const primary: TaskRole = {
      id: "role-primary",
      name: "讲解",
      status: "error",
      execution_mode: "tools",
      message: "角色工具循环未交付，回落单次派工",
      parts: [],
      tools: [],
    };
    render(
      <ProductionTaskCard
        task={taskFixture({
          status: "error",
          error: "角色工具循环未交付",
          lesson: LESSON,
          roles: [primary, fallbackRole({ status: "error" })],
        })}
      />,
    );

    expect(screen.getByTestId("production-task-card")).toHaveAttribute("data-status", "error");
    expect(screen.getByTestId("task-error")).toHaveTextContent("角色工具循环未交付");
    const primaryRow = document.querySelector(
      '[data-testid="task-role"][data-role-id="role-primary"]',
    ) as HTMLElement;
    expect(primaryRow).toHaveAttribute("data-status", "error");
    expect(primaryRow).toHaveAttribute("data-execution-mode", "tools");
    expect(screen.getByTestId("fallback-status")).toHaveTextContent("备用派工失败");
    // 失败态不因为曾有 lesson 就放行入口
    expect(screen.queryByTestId("open-lesson")).not.toBeInTheDocument();
  });

  it("timeout：任务与备用派工角色状态都如实标超时", () => {
    render(
      <ProductionTaskCard
        task={taskFixture({ status: "timeout", roles: [fallbackRole({ status: "timeout" })] })}
      />,
    );
    expect(screen.getByTestId("task-timeout")).toHaveTextContent("已超时");
    expect(screen.getByTestId("fallback-status")).toHaveTextContent("备用派工超时");
    expect(screen.getByTestId("task-role")).toHaveAttribute("data-status", "timeout");
  });

  it("旧持久化兼容：无 execution_mode 的角色不渲染 fallback 区", () => {
    render(
      <ProductionTaskCard
        task={taskFixture({
          roles: [
            {
              id: "role-old",
              name: "讲解",
              status: "done",
              elapsed_s: 7,
              parts: [{ type: "text", text: "旧快照正文" }],
              tools: [],
            },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("task-role")).toHaveAttribute("data-status", "done");
    expect(screen.getByTestId("task-role")).not.toHaveAttribute("data-execution-mode");
    expect(screen.queryByTestId("role-fallback-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fallback-notes")).not.toBeInTheDocument();
  });
});

// ── ChatView 集成：真实 stream handlers + 受控 mock ──────────────────────────────
describe("ChatView · task_update 只刷新同一张卡", () => {
  it("100 次 task_update 仍是一张卡，进度原位更新，不追加 parts/message", async () => {
    const sid = uniq("prog");
    mountEmptyWorkspace(sid);
    render(<ChatView />);

    const h = (await startRun()).handlers;
    await act(async () => {
      h.onToolCall({ id: "call_p", name: "produce_lesson", arguments: "{}" } as never);
    });
    await act(async () => {
      for (let i = 1; i <= 100; i += 1) {
        h.onTaskUpdate({
          id: "call_p",
          task: taskFixture({ elapsed_s: i, stage: i >= 100 ? "检查" : "讲解" }),
        } as never);
      }
    });

    expect(screen.getAllByTestId("production-task-card")).toHaveLength(1);
    expect(screen.getByTestId("task-elapsed")).toHaveTextContent("已等待 100s");
    expect(screen.getByTestId("task-stage-current")).toHaveTextContent("检查");
    // 只有父工具一个 part，不因 100 次快照膨胀
    expect(partTypes()).toEqual(["tool"]);
  });

  it("100 次心跳：fallback 角色耗时原位增长，仍只一张卡、不新增 notice/part", async () => {
    const sid = uniq("fbbeat");
    mountEmptyWorkspace(sid);
    render(<ChatView />);

    const h = (await startRun()).handlers;
    await act(async () => {
      h.onToolCall({ id: "call_p", name: "produce_lesson", arguments: "{}" } as never);
      h.onTaskUpdate({ id: "call_p", task: taskFixture({ roles: [fallbackRole({ elapsed_s: 1 })] }) } as never);
    });
    await act(async () => {
      for (let i = 1; i <= 100; i += 1) {
        h.onTaskUpdate({
          id: "call_p",
          task: taskFixture({ roles: [fallbackRole({ elapsed_s: i })] }),
        } as never);
      }
    });

    expect(screen.getAllByTestId("production-task-card")).toHaveLength(1);
    expect(screen.getByTestId("fallback-wait")).toHaveTextContent("本次角色等待 100s");
    expect(partTypes()).toEqual(["tool"]);
    expect(screen.queryByTestId("process-panel")).not.toBeInTheDocument();
  });

  it("刷新回放落库的 fallback 快照：备用派工状态与失败来源仍在", async () => {
    const sid = uniq("fbreload");
    mountStaticWorkspace(sid, [
      { role: "user", content: "产课", display_content: "产课" },
      {
        role: "assistant",
        content: "",
        parts: [{ type: "tool", tool_id: "call_fb" }],
        tools: [
          {
            id: "call_fb",
            name: "produce_lesson",
            arguments: "{}",
            status: "error",
            isError: true,
            task: taskFixture({
              status: "error",
              error: "角色工具循环未交付",
              roles: [
                {
                  id: "role-primary",
                  name: "讲解",
                  status: "error",
                  execution_mode: "tools",
                  parts: [],
                  tools: [],
                },
                fallbackRole({ status: "error" }),
              ],
            }),
          },
        ],
      },
    ]);
    render(<ChatView />);

    expect(await screen.findByTestId("production-task-card")).toHaveAttribute("data-status", "error");
    expect(screen.getByTestId("fallback-note")).toBeInTheDocument();
    expect(screen.getByTestId("fallback-status")).toHaveTextContent("备用派工失败");
    expect(screen.getByTestId("task-error")).toHaveTextContent("角色工具循环未交付");
  });

  it("停止本地 pending 卡：未拿终态的任务转 interrupted，不永久 running", async () => {
    // 新对话态（无 session id）：流只活在 pendingRun，GET 同步无从兜底
    ws.init({
      sessions: [],
      subjects: [],
      subjectsLoaded: true,
      activeSessionId: null,
      activeSubjectSlug: null,
      activeNodeId: null,
      activeWorkspace: null,
      workspaceCandidates: [],
      loadedSession: null,
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
    render(<ChatView />);

    const h = (await startRun()).handlers;
    await act(async () => {
      h.onToolCall({ id: "call_p", name: "produce_lesson", arguments: "{}" } as never);
      h.onTaskUpdate({ id: "call_p", task: taskFixture({ status: "running" }) } as never);
    });
    expect(screen.getByTestId("production-task-card")).toHaveAttribute("data-status", "running");

    await userEvent.click(screen.getByTitle("停止"));
    // stopChatRun 现在是 async：abort 在微任务里落地，等到 finish 收束任务后再断言。
    await act(async () => {});

    expect(screen.getByTestId("production-task-card")).toHaveAttribute("data-status", "interrupted");
    expect(screen.getByTestId("task-interrupted")).toHaveTextContent("已中断");
  });

  it("终态 task_update 丢失：仅 tool_result.task(done)+lesson 也收成 done 卡并给链接，finish 不误标 interrupted", async () => {
    const sid = uniq("fallback");
    mountEmptyWorkspace(sid);
    render(<ChatView />);

    const h = (await startRun()).handlers;
    await act(async () => {
      h.onToolCall({ id: "call_p", name: "produce_lesson", arguments: "{}" } as never);
      h.onTaskUpdate({ id: "call_p", task: taskFixture({ status: "running" }) } as never);
    });
    expect(screen.getByTestId("production-task-card")).toHaveAttribute("data-status", "running");

    // 跳过终态 task_update，只有 tool_result 带 task(done)+lesson
    await act(async () => {
      h.onToolResult({
        id: "call_p",
        name: "produce_lesson",
        content: "已产出",
        is_error: false,
        task: taskFixture({ status: "done", lesson: LESSON }),
        lesson: LESSON,
      } as never);
    });
    expect(screen.getByTestId("production-task-card")).toHaveAttribute("data-status", "done");
    expect(screen.getByTestId("open-lesson")).toBeInTheDocument();

    // 正常收尾：完成态任务不得被 settle 误标 interrupted
    await act(async () => {
      h.onDone(sid as never);
    });
    expect(screen.getByTestId("production-task-card")).toHaveAttribute("data-status", "done");
  });

  it("未知 id 的 task_update 丢弃：不补假卡、不新增 part", async () => {
    const sid = uniq("unknown");
    mountEmptyWorkspace(sid);
    render(<ChatView />);

    const h = (await startRun()).handlers;
    await act(async () => {
      h.onTaskUpdate({ id: "ghost", task: taskFixture({ status: "running" }) } as never);
    });

    expect(screen.queryByTestId("production-task-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("assistant-parts")).not.toBeInTheDocument();
  });

  it("刷新/切回加载落库 task：直接渲染任务卡，旧无 task 工具仍走旧卡", async () => {
    const sid = uniq("reload");
    mountStaticWorkspace(sid, [
      { role: "user", content: "产课", display_content: "产课" },
      {
        role: "assistant",
        content: "",
        parts: [
          { type: "tool", tool_id: "call_old" },
          { type: "tool", tool_id: "call_new" },
        ],
        tools: [
          { id: "call_old", name: "read_course_file", arguments: "{}", status: "done", result: "旧", isError: false },
          {
            id: "call_new",
            name: "produce_lesson",
            arguments: "{}",
            status: "done",
            task: taskFixture({ status: "done", lesson: LESSON }),
          },
        ],
      },
    ]);
    render(<ChatView />);

    expect(await screen.findByTestId("production-task-card")).toBeInTheDocument();
    // 老工具（无 task）仍是旧 ToolCards
    expect(screen.getByTestId("tool-cards")).toBeInTheDocument();
    expect(screen.getByTestId("open-lesson")).toBeInTheDocument();
  });
});

describe("ChatView · 角色工具 id 隔离与结果原位", () => {
  it("两个角色的工具 id 互不串；结果按 id 回填到所属角色", async () => {
    const sid = uniq("roles");
    mountEmptyWorkspace(sid);
    render(<ChatView />);

    const h = (await startRun()).handlers;
    const twoRoles: ProductionTask = taskFixture({
      roles: [
        {
          id: "role-a",
          name: "讲解",
          status: "running",
          parts: [{ type: "tool", tool_id: "role-a#t1" }],
          tools: [{ id: "role-a#t1", name: "read_course_file", arguments: "{}", status: "running" }],
        },
        {
          id: "role-b",
          name: "出题",
          status: "running",
          parts: [{ type: "tool", tool_id: "role-b#t1" }],
          tools: [{ id: "role-b#t1", name: "render_lesson", arguments: "{}", status: "running" }],
        },
      ],
      events: [],
    });
    await act(async () => {
      h.onToolCall({ id: "call_p", name: "produce_lesson", arguments: "{}" } as never);
      h.onTaskUpdate({ id: "call_p", task: twoRoles } as never);
    });
    await act(async () => {
      h.onToolResult({
        id: "role-a#t1", name: "read_course_file", content: "A 的资料", is_error: false,
      } as never);
    });

    const roleA = document.querySelector('[data-testid="role-body"][data-role-id="role-a"]') as HTMLElement;
    const roleB = document.querySelector('[data-testid="role-body"][data-role-id="role-b"]') as HTMLElement;
    expect(within(roleA).getByTestId("tool-result")).toHaveTextContent("A 的资料");
    expect(within(roleB).queryByTestId("tool-result")).not.toBeInTheDocument();
    // 仍是同一张卡，结果没有另外生成工具卡
    expect(screen.getAllByTestId("production-task-card")).toHaveLength(1);
  });

  it("父 produce 工具 tool_result 原位：parts 顺序不变，lesson 落到同一卡入口", async () => {
    const sid = uniq("inplace");
    mountEmptyWorkspace(sid);
    render(<ChatView />);

    const h = (await startRun()).handlers;
    await act(async () => {
      h.onDelta("讲解中" as never);
      h.onToolCall({ id: "call_p", name: "produce_lesson", arguments: "{}" } as never);
      h.onTaskUpdate({ id: "call_p", task: taskFixture({ status: "done", lesson: LESSON }) } as never);
      h.onDelta("已完成" as never);
    });

    expect(partTypes()).toEqual(["text", "tool", "text"]);
    expect(screen.getByTestId("open-lesson")).toBeInTheDocument();
    expect(screen.getAllByTestId("production-task-card")).toHaveLength(1);
  });
});

describe("ChatView · 评估系统状态压过模型口头点评", () => {
  it("assessment.status=failed：显示未保存、未启动后台修复，即使正文说通过", async () => {
    const sid = uniq("assess");
    mountEmptyWorkspace(sid);
    render(<ChatView />);

    const h = (await startRun()).handlers;
    const failed: AssessmentOutcome = {
      status: "failed",
      node_id: "py.var",
      subject_slug: "python-basics",
      error: "节点不存在：py.var",
      background: false,
    };
    await act(async () => {
      h.onToolCall({ id: "call_a", name: "assess_node", arguments: "{}" } as never);
      h.onToolResult({
        id: "call_a",
        name: "assess_node",
        content: "判定：通过；掌握度：80",
        is_error: false,
        assessment: failed,
      } as never);
      h.onDelta("评估完成：判定与掌握度已写入评估记录。" as never);
    });

    const status = screen.getByTestId("assessment-status");
    expect(status).toHaveAttribute("data-status", "failed");
    expect(status).toHaveTextContent("评估失败，未保存，未启动后台修复");
    expect(status).toHaveTextContent("节点不存在：py.var");
  });
});

describe("ChatView · 老工具 / notice 兼容", () => {
  it("无 task 的旧消息仍走 ToolCards（legacy 无 parts 分支）", async () => {
    const sid = uniq("legacy");
    mountStaticWorkspace(sid, [
      { role: "user", content: "旧", display_content: "旧" },
      {
        role: "assistant",
        content: "旧回答",
        notices: ["提示一", "提示二"],
        tools: [
          { id: "t1", name: "list_workspace", arguments: "{}", status: "done", result: "old", isError: false },
        ],
      },
    ]);
    render(<ChatView />);

    expect(await screen.findByTestId("tool-cards")).toBeInTheDocument();
    expect(screen.getByText("list_workspace")).toBeInTheDocument();
    expect(screen.queryByTestId("production-task-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-panel")).toBeInTheDocument();
  });

  it("同消息相邻 notice 合一个折叠面板，且不串到 text 另一侧", async () => {
    const sid = uniq("notice");
    mountStaticWorkspace(sid, [
      { role: "user", content: "提示", display_content: "提示" },
      {
        role: "assistant",
        content: "前文后文",
        parts: [
          { type: "text", text: "前文" },
          { type: "notice", text: "提示一" },
          { type: "notice", text: "提示二" },
          { type: "text", text: "后文" },
        ],
        notices: ["提示一", "提示二"],
      },
    ]);
    render(<ChatView />);

    await screen.findByTestId("assistant-parts");
    expect(partTypes()).toEqual(["text", "notice", "text"]);
    const panels = screen.getAllByTestId("process-panel");
    expect(panels).toHaveLength(1);
    expect(panels[0].querySelectorAll('[data-testid="process-notices"] li')).toHaveLength(2);
    expect(panels[0]).toHaveTextContent("提示一");
    expect(panels[0]).toHaveTextContent("提示二");
  });
});
