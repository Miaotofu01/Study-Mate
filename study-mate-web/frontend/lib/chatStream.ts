"use client";

import { api, normalizeError, streamChat } from "./api";
import type { StreamChatOptions } from "./api";
import type {
  AssessmentOutcome,
  ChatMessage,
  ErrorInfo,
  LessonLink,
  MessagePart,
  ProductionTask,
  ToolActivity,
  Usage,
} from "./types";

export interface ChatRunSnapshot {
  messages: ChatMessage[];
  usage: Usage | null;
  streaming: boolean;
  syncing: boolean;
  syncError: string | null;
  error: ErrorInfo | null;
}

interface ChatRun {
  sessionId: string | null;
  controller: AbortController;
  snapshot: ChatRunSnapshot;
  assistantIndex: number;
  settled: boolean;
  syncVersion: number;
  /** 用户点了“停止”：仅用于本地即时中性收尾；同步后以服务端 stream_state/stopped_reason 为准。 */
  stopRequested: boolean;
}

const runs = new Map<string, ChatRun>();
const listeners = new Set<() => void>();
let pendingRun: ChatRun | null = null;

function runFor(sessionId: string | null): ChatRun | undefined | null {
  return sessionId === null ? pendingRun : runs.get(sessionId);
}

/** 取消息里最近一条带 error 的助手消息错误（恢复/同步后的落库口径）。 */
export function lastMessageError(messages: ChatMessage[]): ErrorInfo | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "assistant" && message.error) return message.error;
  }
  return null;
}

/**
 * 本地即时“用户主动停止”错误：中性/amber。**仅**表示用户在本地点了停止，
 * 不声称服务端已确认；同步后若服务端落为 disconnect/unknown，以服务端口径为准。
 */
function userStoppedError(): ErrorInfo {
  return {
    code: "user_stopped",
    status: null,
    upstream_code: null,
    phase: "finalize",
    summary: "已停止本轮生成。",
    detail: null,
    retryable: true,
    stopped_reason: "user_stop",
    request_id: null,
  };
}

/**
 * 非用户主动的意外中断（非 stop 的 AbortError / EOF）：红色，不伪称是用户或服务端停止。
 * `resetChatRuns` 等内部取消走 settled 守卫，不会落到这里。
 */
function unexpectedInterruptionError(): ErrorInfo {
  return {
    code: "transport",
    status: null,
    upstream_code: null,
    phase: "stream",
    summary: "本轮被意外中断，未正常结束，请重试。",
    detail: null,
    retryable: true,
    stopped_reason: null,
    request_id: null,
  };
}

export function getChatRun(sessionId: string | null): ChatRunSnapshot | null {
  return runFor(sessionId)?.snapshot ?? null;
}

export function subscribeChatRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 正在流式产出的会话 id（侧栏条目转圈用，2026-10-05 补充拍板）；没有则 null。
 * 尚未拿到 id 的新对话轮（pendingRun）不算：侧栏还没有它的条目，无处显示转圈。
 */
export function getStreamingChatRunSessionId(): string | null {
  for (const [id, run] of runs) {
    if (run.snapshot.streaming) return id;
  }
  return null;
}

function publish(run: ChatRun, patch: Partial<ChatRunSnapshot>): void {
  run.snapshot = { ...run.snapshot, ...patch };
  for (const listener of listeners) listener();
}

function patchAssistant(run: ChatRun, update: (message: ChatMessage) => ChatMessage): void {
  const messages = [...run.snapshot.messages];
  const message = messages[run.assistantIndex];
  if (!message || message.role !== "assistant" || message.kind) return;
  messages[run.assistantIndex] = update(message);
  publish(run, { messages });
}

function appendPart(parts: MessagePart[], part: MessagePart): MessagePart[] {
  const last = parts.at(-1);
  if (part.type !== "tool" && part.type !== "notice" && last?.type === part.type) {
    return [...parts.slice(0, -1), { ...part, text: last.text + part.text }];
  }
  return [...parts, part];
}

/** 任务状态 → 旧 ToolActivity.status（不含 interrupted，中断归 error 供旧卡片/面板显示）。 */
function toolStatusFromTask(status: ProductionTask["status"]): ToolActivity["status"] {
  if (status === "done") return "done";
  if (status === "running") return "running";
  return "error";
}

/**
 * 本地收尾：把仍在 running 的任务标 interrupted，并同步其内仍在 running 的角色与子工具；
 * done/error/timeout 的历史角色与工具一律原样保留（不洗白、不改写已完成的过程）。
 * 子工具 status 只有 running|done|error，running 子工具归 error 并标 isError，与后端
 * `_write_turn(final_reason="disconnect")` 同口径。
 */
function interruptRunningTask(task: ProductionTask): ProductionTask {
  return {
    ...task,
    status: "interrupted" as const,
    roles: task.roles.map((role) =>
      role.status !== "running"
        ? role
        : {
            ...role,
            status: "interrupted" as const,
            tools: (role.tools ?? []).map((item) =>
              item.status === "running"
                ? { ...item, status: "error" as const, isError: true }
                : item,
            ),
          },
    ),
  };
}

interface ToolResultPayload {
  id: string;
  name: string;
  content: string;
  is_error: boolean;
  task?: ProductionTask;
  lesson?: LessonLink;
  assessment?: AssessmentOutcome;
}

/** 把一次 tool_result 落到目标工具上（保留已有 arguments / task / 结构化载荷）。 */
function withToolResult(tool: ToolActivity, payload: ToolResultPayload): ToolActivity {
  const status = payload.task
    ? toolStatusFromTask(payload.task.status)
    : payload.is_error
      ? ("error" as const)
      : ("done" as const);
  return {
    ...tool,
    name: payload.name || tool.name,
    status,
    result: payload.content,
    isError: payload.is_error,
    ...(payload.task ? { task: payload.task } : {}),
    ...(payload.lesson ? { lesson: payload.lesson } : {}),
    ...(payload.assessment ? { assessment: payload.assessment } : {}),
  };
}

/**
 * 按 id 原位回填工具结果：先找顶层工具，再找任务角色内嵌工具（角色 id 各自隔离，
 * 不跨角色串改）。未命中时返回 found=false，由调用方决定是否补卡。
 */
function applyToolResult(
  tools: ToolActivity[],
  payload: ToolResultPayload,
): { tools: ToolActivity[]; found: boolean } {
  const topIndex = tools.findIndex((tool) => tool.id === payload.id);
  if (topIndex >= 0) {
    const next = [...tools];
    next[topIndex] = withToolResult(next[topIndex], payload);
    return { tools: next, found: true };
  }
  let found = false;
  const next = tools.map((tool) => {
    if (!tool.task || !tool.task.roles.some((role) => role.tools.some((item) => item.id === payload.id))) {
      return tool;
    }
    found = true;
    const roles = tool.task.roles.map((role) => ({
      ...role,
      tools: role.tools.map((item) => (item.id === payload.id ? withToolResult(item, payload) : item)),
    }));
    return { ...tool, task: { ...tool.task, roles } };
  });
  return { tools: next, found };
}

/**
 * task_update 只把完整快照写到已存在的父 produce 工具上：不追加 message / parts，也不产生
 * notice。未知 id 直接丢弃——后端规范保证 tool_call 先到，且后端对未知 id 同样忽略；不补假卡
 * 以免两侧行为不对称。终态快照如果丢失，由 tool_result.task 兜底收尾。
 */
function applyTaskUpdate(
  tools: ToolActivity[],
  payload: { id: string; task: ProductionTask },
): ToolActivity[] {
  const index = tools.findIndex((tool) => tool.id === payload.id);
  if (index < 0) return tools;
  const next = [...tools];
  next[index] = { ...next[index], task: payload.task, status: toolStatusFromTask(payload.task.status) };
  return next;
}

async function syncRun(run: ChatRun): Promise<void> {
  if (!run.sessionId) return;
  const version = ++run.syncVersion;
  publish(run, { syncing: true, syncError: null });
  try {
    let data = await api.getSession(run.sessionId);
    for (let attempt = 0; data.streaming && attempt < 40; attempt += 1) {
      if (run.syncVersion !== version || runFor(run.sessionId) !== run) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
      data = await api.getSession(run.sessionId);
    }
    if (run.syncVersion !== version || runFor(run.sessionId) !== run) return;
    if (data.streaming) throw new Error("本轮仍在结束处理中，请稍后重试同步。");
    const messages = data.messages.map((message, index) => {
      const local = run.snapshot.messages[index];
      return local?.notices?.length && local.content === message.content
        ? { ...message, notices: message.notices ?? local.notices }
        : message;
    });
    // 服务端消息的 stream_state/error 是权威：同步后用它覆盖本地即时错误（如把本地 user_stop
    // 校正为服务端 disconnect/unknown），避免前端伪称“服务端已确认停止”。
    publish(run, {
      messages,
      usage: data.usage ?? run.snapshot.usage,
      syncing: false,
      error: lastMessageError(messages),
    });
  } catch (err) {
    if (run.syncVersion !== version || runFor(run.sessionId) !== run) return;
    publish(run, { syncing: false, syncError: err instanceof Error ? err.message : String(err) });
  }
}

export function recoverChatRun(sessionId: string, messages: ChatMessage[], usage: Usage | null): void {
  if (runs.has(sessionId)) return;
  const run: ChatRun = {
    sessionId,
    controller: new AbortController(),
    assistantIndex: messages.length - 1,
    settled: true,
    syncVersion: 0,
    stopRequested: false,
    snapshot: {
      messages,
      usage,
      streaming: false,
      syncing: true,
      syncError: null,
      error: lastMessageError(messages),
    },
  };
  runs.set(sessionId, run);
  void syncRun(run);
}

export function retryChatSync(sessionId: string | null): Promise<void> {
  const run = runFor(sessionId);
  return run ? syncRun(run) : Promise.resolve();
}

export function forgetChatRun(sessionId: string | null): void {
  const run = runFor(sessionId);
  if (!run || run.snapshot.streaming || run.snapshot.syncing) return;
  run.syncVersion += 1;
  if (sessionId === null) pendingRun = null;
  else runs.delete(sessionId);
  for (const listener of listeners) listener();
}

export function resetChatRuns(): void {
  for (const run of [...runs.values(), ...(pendingRun ? [pendingRun] : [])]) {
    run.settled = true;
    run.syncVersion += 1;
    run.controller.abort();
  }
  runs.clear();
  pendingRun = null;
  for (const listener of listeners) listener();
}

export function stopChatRun(sessionId: string | null): Promise<void> {
  const run = runFor(sessionId);
  if (!run) return Promise.resolve();
  run.stopRequested = true;
  // 先登记服务端 intent（限时），无论登记成功/超时/异常都本地 abort；绝不无限等待。
  const registered = run.sessionId
    ? api.stopSession(run.sessionId)
    : Promise.resolve({ ok: false, stop: false });
  return registered.then(
    () => run.controller.abort(),
    () => run.controller.abort(),
  );
}

export function startChatRun(input: {
  sessionId: string | null;
  messages: ChatMessage[];
  text: string;
  attachments: ChatMessage["attachments"];
  usage: Usage | null;
  model?: string;
  options: Omit<StreamChatOptions, "signal">;
  onSession: (id: string) => void;
  onSettled: () => void;
}): void {
  const current = runFor(input.sessionId);
  if (current?.snapshot.streaming || current?.snapshot.syncing || current?.snapshot.syncError) return;
  const base = input.options.replaceFrom === undefined
    ? input.messages
    : input.messages.slice(0, input.options.replaceFrom);
  const run: ChatRun = {
    sessionId: input.sessionId,
    controller: new AbortController(),
    assistantIndex: base.length + 1,
    settled: false,
    syncVersion: 0,
    stopRequested: false,
    snapshot: {
      messages: [
        ...base,
        { role: "user", content: input.text, display_content: input.text, attachments: input.attachments },
        { role: "assistant", content: "", parts: [], model: input.model },
      ],
      usage: input.usage,
      streaming: true,
      syncing: false,
      syncError: null,
      error: null,
    },
  };
  if (input.sessionId === null) pendingRun = run;
  else runs.set(input.sessionId, run);
  publish(run, {});

  const finish = (errorValue: ErrorInfo | string | null = null) => {
    if (run.settled) return;
    run.settled = true;
    const error = normalizeError(errorValue);
    const original = run.snapshot.messages[run.assistantIndex];
    const raw = original && error ? { ...original, error,
      stopped_reason: error.stopped_reason,
      stream_state: (error.code === "user_stopped" ? "interrupted" : "error") as ChatMessage["stream_state"],
    } : original;
    // 流结束后仍未落终态的本地任务卡标 interrupted：pending/failed 的卡不永久转圈。
    // 同步把卡内仍在 running 的角色与子工具一并收成 interrupted/error（done/error/timeout
    // 的历史一律保留），随后 GET 同步仍以服务端快照为准覆盖。
    const hasRunningTask = raw?.tools?.some((tool) => tool.task?.status === "running") ?? false;
    const assistant =
      hasRunningTask && raw?.tools
        ? {
            ...raw,
            tools: raw.tools.map((tool) => {
              const task = tool.task;
              if (!task || task.status !== "running") return tool;
              return {
                ...tool,
                status: toolStatusFromTask("interrupted"),
                task: interruptRunningTask(task),
              };
            }),
          }
        : raw;
    const messages = assistant && !assistant.error && !assistant.content && !assistant.reasoning && !assistant.tools?.length && !assistant.notices?.length
      ? run.snapshot.messages.filter((_, index) => index !== run.assistantIndex)
      : assistant
        ? run.snapshot.messages.map((message, index) => (index === run.assistantIndex ? assistant : message))
        : run.snapshot.messages;
    publish(run, { messages, streaming: false, error });
    input.onSettled();
    void syncRun(run);
  };
  const appendText = (type: "text" | "reasoning" | "notice", text: string) => {
    if (run.settled) return;
    patchAssistant(run, (message) => ({
      ...message,
      ...(type === "text" ? { content: message.content + text } : {}),
      ...(type === "reasoning" ? { reasoning: (message.reasoning ?? "") + text } : {}),
      ...(type === "notice" ? { notices: [...(message.notices ?? []), text] } : {}),
      parts: appendPart(message.parts ?? [], { type, text }),
    }));
  };
  void streamChat(input.text, input.sessionId, {
    onSession: (id) => {
      if (run.settled) return;
      run.sessionId = id;
      if (pendingRun === run) pendingRun = null;
      runs.set(id, run);
      input.onSession(id);
      publish(run, {});
    },
    onDelta: (text) => appendText("text", text),
    onReasoning: (text) => appendText("reasoning", text),
    onNotice: (text) => appendText("notice", text),
    onUsage: (usage) => { if (!run.settled) publish(run, { usage }); },
    onToolCall: ({ id, name, arguments: args }) => {
      if (run.settled) return;
      patchAssistant(run, (message) => {
        const exists = message.tools?.some((tool) => tool.id === id);
        return {
          ...message,
          tools: exists ? message.tools : [...(message.tools ?? []), { id, name, arguments: args, status: "running" }],
          parts: exists ? message.parts : appendPart(message.parts ?? [], { type: "tool", tool_id: id }),
        };
      });
    },
    onToolResult: ({ id, name, content, is_error, task, lesson, assessment }) => {
      if (run.settled) return;
      patchAssistant(run, (message) => {
        const tools = message.tools ?? [];
        const { tools: nextTools, found } = applyToolResult(tools, {
          id, name, content, is_error, task, lesson, assessment,
        });
        if (found) return { ...message, tools: nextTools };
        // 未知 id：沿用旧行为补一张工具卡并占位一个 part
        return {
          ...message, tools: nextTools,
          parts: appendPart(message.parts ?? [], { type: "tool", tool_id: id }),
        };
      });
    },
    onTaskUpdate: ({ id, task }) => {
      if (run.settled) return;
      patchAssistant(run, (message) => ({
        ...message,
        tools: applyTaskUpdate(message.tools ?? [], { id, task }),
      }));
    },
    onConfirm: ({ slug, name }) => {
      if (run.settled) return;
      publish(run, { messages: [...run.snapshot.messages, {
        role: "assistant", kind: "build_confirm", slug,
        content: `盘问完成，已为「${name}」建好草稿。确认后开始建课编排。`,
      }] });
    },
    onDone: () => finish(),
    onError: (error) => finish(error),
  }, { ...input.options, signal: run.controller.signal }).then(() => {
    if (!run.settled) finish("连接中断：本轮未正常结束，请重试。");
  }).catch((err: unknown) => {
    if ((err as Error)?.name === "AbortError") {
      finish(run.stopRequested ? userStoppedError() : unexpectedInterruptionError());
    } else {
      finish(normalizeError((err as { errorInfo?: ErrorInfo })?.errorInfo ?? String(err)));
    }
  });
}
