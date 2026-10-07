import { beforeEach, describe, expect, it, vi } from "vitest";
import { getChatRun, resetChatRuns, startChatRun } from "@/lib/chatStream";
import type { ProductionTask, TaskRole, ToolActivity } from "@/lib/types";

/**
 * 流收尾（finish）对任务卡的中断收束回归（2026-10-05 收尾整合）。
 *
 * 仅 mock @/lib/api 的 streamChat（不启真实流、不碰服务）；直接驱动真实 chatStream store：
 * 流结束后仍未落终态的 running 任务应收成 interrupted，且**同步**把卡内仍在 running 的角色
 * 与子工具一并收成 interrupted/error，而 done/error/timeout 的历史角色与工具原样保留。
 */

const streamChat = vi.hoisted(() => vi.fn());
// chatStream 只用到 streamChat；api 仅在 syncRun（本用例 sessionId=null，提前返回）里用。
// partial mock：保留真实 normalizeError（chatStream.finish 用它收编错误），只替换 api/streamChat。
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: {}, streamChat };
});

type HoHandlers = {
  onToolCall: (payload: { id: string; name: string; arguments: string }) => void;
  onTaskUpdate: (payload: { id: string; task: ProductionTask }) => void;
  onDone: () => void;
};
let handlers: HoHandlers;

function installStream(): void {
  streamChat.mockImplementation((_message: string, _sessionId: string | null, h: HoHandlers) => {
    handlers = h;
    return new Promise<void>(() => undefined);
  });
}

function role(id: string, over: Partial<TaskRole> = {}): TaskRole {
  return { id, name: over.name ?? id, status: over.status ?? "running", parts: [], tools: [], ...over };
}

function task(over: Partial<ProductionTask> = {}): ProductionTask {
  return {
    id: "call_p",
    kind: "produce_lesson",
    title: "变量与赋值",
    subject_slug: "python-basics",
    node_id: "py.var",
    workspace: "C:/ws/StudyMate",
    status: "running",
    roles: [],
    events: [],
    ...over,
  };
}

function lastAssistantTools(): ToolActivity[] {
  const snap = getChatRun(null);
  expect(snap).not.toBeNull();
  const message = snap!.messages[snap!.messages.length - 1];
  return message.tools ?? [];
}

function start(): void {
  startChatRun({
    sessionId: null,
    messages: [],
    text: "产课",
    attachments: undefined,
    usage: null,
    options: {} as never,
    onSession: vi.fn(),
    onSettled: vi.fn(),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  resetChatRuns();
  installStream();
});

describe("chatStream.finish · 任务中断收束", () => {
  it("running 任务收成 interrupted：内部 running 角色/子工具同步中断，历史终态保留", () => {
    start();
    const runningTool: ToolActivity = {
      id: "r-run#t1",
      name: "read_course_file",
      arguments: "{}",
      status: "running",
    };
    const doneTool: ToolActivity = {
      id: "r-done#t1",
      name: "render_lesson",
      arguments: "{}",
      status: "done",
      result: "已渲染",
      isError: false,
    };
    handlers.onToolCall({ id: "call_p", name: "produce_lesson", arguments: "{}" });
    handlers.onTaskUpdate({
      id: "call_p",
      task: task({
        roles: [
          role("r-run", {
            name: "讲解",
            status: "running",
            parts: [{ type: "tool", tool_id: "r-run#t1" }],
            tools: [runningTool],
          }),
          role("r-done", {
            name: "出题",
            status: "done",
            parts: [{ type: "tool", tool_id: "r-done#t1" }],
            tools: [doneTool],
          }),
          role("r-err", { name: "渲染", status: "error" }),
          role("r-timeout", { name: "备用", status: "timeout" }),
        ],
      }),
    });

    handlers.onDone();

    const tool = lastAssistantTools()[0];
    // 旧的父工具卡状态：中断归 error（不含 interrupted）
    expect(tool.status).toBe("error");
    expect(tool.task?.status).toBe("interrupted");

    const roles = Object.fromEntries((tool.task?.roles ?? []).map((item) => [item.id, item]));
    // 仍在 running 的角色与子工具一并收束
    expect(roles["r-run"].status).toBe("interrupted");
    expect(roles["r-run"].tools[0].status).toBe("error");
    expect(roles["r-run"].tools[0].isError).toBe(true);
    // 历史终态一律保留，不被洗白也不被改写
    expect(roles["r-done"].status).toBe("done");
    expect(roles["r-done"].tools[0].status).toBe("done");
    expect(roles["r-done"].tools[0].isError).toBe(false);
    expect(roles["r-err"].status).toBe("error");
    expect(roles["r-timeout"].status).toBe("timeout");
    expect(getChatRun(null)?.streaming).toBe(false);
  });

  it("finish 只收 running 任务：已 done / timeout 的任务与其历史原样保留", () => {
    start();
    handlers.onToolCall({ id: "call_t", name: "produce_lesson", arguments: "{}" });
    handlers.onToolCall({ id: "call_d", name: "produce_lesson", arguments: "{}" });
    const timeoutTask = task({
      id: "call_t",
      status: "timeout",
      roles: [role("r-timeout", { name: "备用", status: "timeout" })],
    });
    const doneTask = task({
      id: "call_d",
      status: "done",
      roles: [role("r-done", { name: "讲解", status: "done" })],
    });
    handlers.onTaskUpdate({ id: "call_t", task: timeoutTask });
    handlers.onTaskUpdate({ id: "call_d", task: doneTask });

    handlers.onDone();

    const byId = Object.fromEntries(lastAssistantTools().map((item) => [item.id, item]));
    expect(byId["call_t"].task?.status).toBe("timeout");
    expect(byId["call_t"].task?.roles[0].status).toBe("timeout");
    expect(byId["call_d"].task?.status).toBe("done");
    expect(byId["call_d"].task?.roles[0].status).toBe("done");
  });
});
