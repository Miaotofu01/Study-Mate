import type {
  AppSettings,
  AssessPayload,
  AssessResponse,
  AttachmentsArea,
  CourseDetail,
  CourseRecords,
  DraftDetail,
  DraftInfo,
  ExportResult,
  GenerateCoursePayload,
  GenerateCourseResponse,
  GradePayload,
  GradeResult,
  GraphNode,
  InspectionTicket,
  LabStatus,
  LessonInfo,
  MemoryEntry,
  MisconceptionImportance,
  MisconceptionItem,
  MisconceptionPatch,
  MisconceptionPayload,
  NodeStatus,
  QuizItem,
  Session,
  SessionMeta,
  SubjectStatus,
  SubjectSummary,
  SummaryResponse,
  TestConnectionPayload,
  TestConnectionResponse,
  TicketDetail,
  TicketProblem,
  ToolActivity,
  UploadedAttachment,
  WorkspaceInfo,
} from "./types";

export class ApiError extends Error {
  readonly problems?: string[];

  constructor(message: string, problems?: string[]) {
    super(message);
    this.name = "ApiError";
    this.problems = problems;
  }
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const info = await errorInfo(res);
    throw new ApiError(info.message, info.problems);
  }
  return res.json() as Promise<T>;
}

async function errorInfo(res: Response): Promise<{ message: string; problems?: string[] }> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object") {
      const obj = body as Record<string, unknown>;
      if (Array.isArray(obj.problems) && obj.problems.length > 0) {
        const problems = obj.problems.map((p) => String(p)).filter(Boolean);
        if (problems.length) return { message: problems.join("；"), problems };
      }
      if ("detail" in obj) {
        const detail: unknown = obj.detail;
        if (typeof detail === "string" && detail) return { message: detail };
        if (Array.isArray(detail)) {
          const msgs = detail
            .map((item) => (item && typeof item === "object" && "msg" in item ? String((item as { msg: unknown }).msg) : String(item)))
            .filter(Boolean);
          if (msgs.length) return { message: msgs.join("；") };
        }
      }
    }
  } catch {
    // 响应体不是 JSON，退回 HTTP 状态文案
  }
  return { message: `${res.status} ${res.statusText}` };
}

async function errorMessage(res: Response): Promise<string> {
  return (await errorInfo(res)).message;
}

async function rawFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new ApiError(await errorMessage(res));
  return res.json() as Promise<T>;
}

export interface CreateCoursePayload {
  name: string;
  slug?: string;
  goal?: string;
}

/** 会话级工作区：null/undefined = 不带该参数，用后端当前默认工作区 */
export type WorkspaceParam = string | null | undefined;

/** 给 GET URL 挂上 `?workspace=<绝对路径>`（会话绑定的工作区）；缺省时原样返回 */
function withWorkspace(url: string, workspace: WorkspaceParam): string {
  if (!workspace) return url;
  const params = new URLSearchParams({ workspace });
  return `${url}${url.includes("?") ? "&" : "?"}${params.toString()}`;
}

export interface PatchCoursePayload {
  name?: string;
  goal?: string;
  status?: SubjectStatus;
}

export interface NodeProgressPayload {
  status?: NodeStatus;
  mastery?: number;
  notes?: string;
  lab_status?: LabStatus;
}

export interface MisconceptionQuery {
  importance?: MisconceptionImportance;
  node_id?: string;
}

export const api = {
  listSessions: () => jsonFetch<SessionMeta[]>("/api/sessions"),
  getSession: (id: string) => jsonFetch<Session>(`/api/sessions/${id}`),
  createSession: () =>
    jsonFetch<Session>("/api/sessions", { method: "POST", body: JSON.stringify({}) }),
  renameSession: (id: string, title: string) =>
    jsonFetch<Session>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  /** 绑定/解绑会话级工作区（null = 回到默认工作区） */
  setSessionWorkspace: (id: string, workspace: string | null) =>
    jsonFetch<Session>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ workspace }),
    }),
  deleteSession: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),

  listCourses: (workspace?: WorkspaceParam) =>
    jsonFetch<SubjectSummary[]>(withWorkspace("/api/courses", workspace)),
  createCourse: (payload: CreateCoursePayload) =>
    jsonFetch<SubjectSummary>("/api/courses", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getCourse: (slug: string, workspace?: WorkspaceParam) =>
    jsonFetch<CourseDetail>(
      withWorkspace(`/api/courses/${encodeURIComponent(slug)}`, workspace),
    ),
  patchCourse: (slug: string, payload: PatchCoursePayload) =>
    jsonFetch<SubjectSummary>(`/api/courses/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteCourse: (slug: string) =>
    jsonFetch<{ ok: boolean }>(`/api/courses/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    }),
  updateNodeProgress: (slug: string, nodeId: string, payload: NodeProgressPayload) =>
    jsonFetch<{ ok: boolean; node: GraphNode }>(
      `/api/courses/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nodeId)}/progress`,
      { method: "PUT", body: JSON.stringify(payload) },
    ),

  listMisconceptions: (slug: string, query: MisconceptionQuery = {}) => {
    const params = new URLSearchParams();
    if (query.importance) params.set("importance", query.importance);
    if (query.node_id) params.set("node_id", query.node_id);
    const qs = params.toString();
    return jsonFetch<{ items: MisconceptionItem[] }>(
      `/api/courses/${encodeURIComponent(slug)}/misconceptions${qs ? `?${qs}` : ""}`,
    );
  },
  createMisconception: (slug: string, payload: MisconceptionPayload) =>
    jsonFetch<{ item: MisconceptionItem }>(
      `/api/courses/${encodeURIComponent(slug)}/misconceptions`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  updateMisconception: (slug: string, id: string, payload: MisconceptionPatch) =>
    jsonFetch<{ item: MisconceptionItem }>(
      `/api/courses/${encodeURIComponent(slug)}/misconceptions/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(payload) },
    ),
  deleteMisconception: (slug: string, id: string) =>
    jsonFetch<{ ok: boolean }>(
      `/api/courses/${encodeURIComponent(slug)}/misconceptions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),

  listLessons: (slug: string) =>
    jsonFetch<{ lessons: LessonInfo[] }>(
      `/api/courses/${encodeURIComponent(slug)}/lessons`,
    ),
  getQuiz: (slug: string, nodeId: string) =>
    jsonFetch<{ items: QuizItem[] }>(
      `/api/courses/${encodeURIComponent(slug)}/quiz/${encodeURIComponent(nodeId)}`,
    ),
  gradeAnswer: (slug: string, nodeId: string, payload: GradePayload) =>
    jsonFetch<GradeResult>(
      `/api/courses/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nodeId)}/grade`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  assessNode: (slug: string, nodeId: string, payload: AssessPayload) =>
    jsonFetch<AssessResponse>(
      `/api/courses/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nodeId)}/assess`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  listRecords: (slug: string) =>
    jsonFetch<CourseRecords>(`/api/courses/${encodeURIComponent(slug)}/records`),
  generateSessionSummary: (slug: string, sessionId: string) =>
    jsonFetch<SummaryResponse>(
      `/api/courses/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/summary`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  exportCourse: (slug: string) =>
    jsonFetch<ExportResult>(`/api/courses/${encodeURIComponent(slug)}/export`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  generateCourse: (payload: GenerateCoursePayload) =>
    jsonFetch<GenerateCourseResponse>("/api/courses/generate", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getSettings: () => jsonFetch<AppSettings>("/api/settings"),
  saveSettings: (settings: AppSettings) =>
    jsonFetch<{ ok: boolean }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  testConnection: (payload: TestConnectionPayload) =>
    jsonFetch<TestConnectionResponse>("/api/settings/test", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  uploadAttachment: (file: File, sessionId?: string | null) => {
    const form = new FormData();
    form.append("file", file);
    if (sessionId) form.append("session_id", sessionId);
    return rawFetch<UploadedAttachment>("/api/uploads", {
      method: "POST",
      body: form,
    });
  },
  attachmentFileUrl: (id: string) =>
    `/api/uploads/${encodeURIComponent(id)}/file`,

  // 工作区：查看发现结果 / 预览某个路径 / 改选目录（立即生效，无需重启）
  getWorkspace: (path?: string | null) =>
    jsonFetch<WorkspaceInfo>(
      path ? `/api/workspace?path=${encodeURIComponent(path)}` : "/api/workspace",
    ),
  updateWorkspace: (path: string) =>
    jsonFetch<WorkspaceInfo>("/api/workspace", {
      method: "PUT",
      body: JSON.stringify({ path }),
    }),

  // 附件区清单：术语表 / 本地资料 / 学习记录 / 会话摘要（可按会话工作区读取）
  getAttachmentsArea: (slug: string, workspace?: WorkspaceParam) =>
    jsonFetch<AttachmentsArea>(
      withWorkspace(`/api/courses/${encodeURIComponent(slug)}/attachments-area`, workspace),
    ),
  courseFileUrl: (slug: string, relativePath: string, workspace?: WorkspaceParam) =>
    withWorkspace(
      `/api/courses/${encodeURIComponent(slug)}/files/${relativePath
        .split("/")
        .filter(Boolean)
        .map((part) => encodeURIComponent(part))
        .join("/")}`,
      workspace,
    ),

  // 记忆写侧：先建议后逐条确认
  suggestMemory: (sessionId: string) =>
    jsonFetch<{ ok: boolean; entries: MemoryEntry[] }>("/api/memory/suggest", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId }),
    }),
  confirmMemory: (entries: MemoryEntry[], sessionId?: string) =>
    jsonFetch<{ ok: boolean; path: string; written: number }>("/api/memory/confirm", {
      method: "POST",
      // session_id 与 suggestMemory 保持一致：给了才写到该会话绑定的工作区，
      // 否则会落到全局默认工作区，出现"建议取自 A 工作区、写入却落到 B 工作区"。
      body: JSON.stringify(sessionId ? { entries, session_id: sessionId } : { entries }),
    }),

  // ---------- 生产链（§5.1 C/D/工单） ----------

  // 质检工单
  listTickets: (slug?: string, openOnly = false) => {
    const params = new URLSearchParams();
    if (slug) params.set("slug", slug);
    if (openOnly) params.set("open_only", "true");
    const qs = params.toString();
    return jsonFetch<InspectionTicket[]>(`/api/tickets${qs ? `?${qs}` : ""}`);
  },
  getTicket: (id: string) =>
    jsonFetch<TicketDetail>(`/api/tickets/${encodeURIComponent(id)}`),
  quickEditTicketArtifact: (id: string, path: string, content: string) =>
    jsonFetch<{ ok: boolean }>(`/api/tickets/${encodeURIComponent(id)}/artifact`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    }),
  abandonTicket: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/tickets/${encodeURIComponent(id)}/abandon`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  // 草稿区（建课链 D）
  listDrafts: () => jsonFetch<DraftInfo[]>("/api/drafts"),
  getDraft: (slug: string) =>
    jsonFetch<DraftDetail>(`/api/drafts/${encodeURIComponent(slug)}`),
  deleteDraft: (slug: string) =>
    jsonFetch<{ ok: boolean }>(`/api/drafts/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    }),
  addDraftMaterial: (slug: string, title: string, text: string) =>
    jsonFetch<{ ok: boolean; path: string }>(
      `/api/drafts/${encodeURIComponent(slug)}/materials`,
      { method: "POST", body: JSON.stringify({ title, text }) },
    ),
  draftFileUrl: (slug: string, relativePath: string) =>
    `/api/drafts/${encodeURIComponent(slug)}/files/${relativePath
      .split("/")
      .filter(Boolean)
      .map((part) => encodeURIComponent(part))
      .join("/")}`,

  promoteDraft: (slug: string, target?: string) =>
    jsonFetch<{ ok: boolean; subject_dir: string }>(
      `/api/drafts/${encodeURIComponent(slug)}/promote`,
      { method: "POST", body: JSON.stringify({ target: target ?? null }) },
    ),
};

export interface StreamHandlers {
  onSession?: (sessionId: string) => void;
  onDelta?: (piece: string) => void;
  onNotice?: (message: string) => void;
  onConfirm?: (payload: { slug: string; name: string }) => void;
  /** 工具化运行时（K0）：模型发起一次工具调用 */
  onToolCall?: (payload: { id: string; name: string; arguments: string }) => void;
  /** 工具执行结果回吐（is_error 表示工具以错误文本回填，循环不中断） */
  onToolResult?: (payload: { id: string; name: string; content: string; is_error: boolean }) => void;
  onDone?: (sessionId: string) => void;
  onError?: (message: string) => void;
}

/** 编排 SSE 的事件处理（production 路由：stage/retry/handoff/done/error）。 */
export interface OrchestrationHandlers {
  onSession?: (sessionId: string) => void;
  onStage?: (payload: { stage: string; status: string; artifacts?: string[]; problems?: TicketProblem[] }) => void;
  onRetry?: (payload: { round: number; owners: string[]; reason?: string }) => void;
  onHandoff?: (payload: { ticket: InspectionTicket }) => void;
  onDone?: (payload: { message?: string; slug?: string; stage?: string; artifacts?: string[] }) => void;
  onError?: (message: string) => void;
}

export interface StreamChatOptions {
  /** undefined = 该键不随请求发送（建课会话不带科目关联；发送 null 则表示取消关联） */
  subjectSlug?: string | null;
  nodeId?: string | null;
  /** 会话级工作区（仅新建会话时生效；已有会话忽略） */
  workspace?: string | null;
  attachments?: string[];
  /** 新建会话时的会话模式（建课会话 = interview）；已有会话忽略 */
  mode?: "chat" | "interview" | null;
  /** 仅 fixture 模式生效：按请求选固定流场景（E2E 专用） */
  fixtureScenario?: string | null;
  signal?: AbortSignal;
}

/**
 * 发送消息并通过 fetch + ReadableStream 解析 SSE。
 * 用原生 fetch 而非 EventSource，因为 EventSource 不支持 POST。
 */
export async function streamChat(
  message: string,
  sessionId: string | null,
  handlers: StreamHandlers,
  options: StreamChatOptions = {},
): Promise<void> {
  const { subjectSlug, nodeId, attachments, workspace, mode = null, fixtureScenario = null, signal } = options;
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      session_id: sessionId,
      ...(subjectSlug === undefined ? {} : { subject_slug: subjectSlug }),
      ...(nodeId === undefined ? {} : { node_id: nodeId }),
      ...(workspace === undefined ? {} : { workspace }),
      attachment_ids: attachments ?? [],
      mode,
      fixture_scenario: fixtureScenario,
    }),
    signal,
  });

  if (!res.ok) {
    handlers.onError?.(await errorMessage(res));
    return;
  }

  await consumeSSE(res, (event, payload) => {
    if (event === "session") handlers.onSession?.(payload.session_id as string);
    else if (event === "delta") handlers.onDelta?.(payload.content as string);
    else if (event === "notice") handlers.onNotice?.(payload.message as string);
    else if (event === "tool_call")
      handlers.onToolCall?.(payload as unknown as { id: string; name: string; arguments: string });
    else if (event === "tool_result")
      handlers.onToolResult?.(
        payload as unknown as { id: string; name: string; content: string; is_error: boolean },
      );
    else if (event === "confirm") handlers.onConfirm?.(payload as never);
    else if (event === "done") handlers.onDone?.(payload.session_id as string);
    else if (event === "error") handlers.onError?.(payload.message as string);
  });
}

/** 解析一条 SSE 事件流（fetch + ReadableStream）；事件名与载荷交给 sink。 */
async function consumeSSE(
  res: Response,
  sink: (event: string, payload: Record<string, unknown>) => void,
): Promise<void> {
  if (!res.body) throw new ApiError("响应没有 body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      let event = "message";
      let data = "";
      for (const line of part.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue;
      sink(event, JSON.parse(data));
    }
  }
}

/** 编排端点通用客户端：产课 / 建课 / 工单重试与复检（POST SSE）。 */
export async function streamOrchestration(
  url: string,
  body: Record<string, unknown>,
  handlers: OrchestrationHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    handlers.onError?.(await errorMessage(res));
    return;
  }
  await consumeSSE(res, (event, payload) => {
    if (event === "session") handlers.onSession?.(payload.session_id as string);
    else if (event === "stage") handlers.onStage?.(payload as never);
    else if (event === "retry") handlers.onRetry?.(payload as never);
    else if (event === "handoff") handlers.onHandoff?.(payload as never);
    else if (event === "done") handlers.onDone?.(payload);
    else if (event === "error") handlers.onError?.(String(payload.message));
    // finished / confirm 在编排流里忽略（confirm 仅 chat 流使用）
  });
}

/** 产课（C 链）：为节点跑「讲解→出题→渲染→检查→打回」。 */
export function produceNode(
  slug: string,
  nodeId: string,
  handlers: OrchestrationHandlers,
  sessionId?: string | null,
): Promise<void> {
  return streamOrchestration(
    `/api/courses/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nodeId)}/produce`,
    { session_id: sessionId ?? null },
    handlers,
  );
}

/** 建课编排（D 链）：草稿上跑「大纲+采图并行 → 门禁 → 落盘」。 */
export function buildDraft(
  slug: string,
  handlers: OrchestrationHandlers,
  sessionId?: string | null,
  signal?: AbortSignal,
): Promise<void> {
  return streamOrchestration(
    `/api/drafts/${encodeURIComponent(slug)}/build`,
    { session_id: sessionId ?? null },
    handlers,
    signal,
  );
}

/** 工单重试（按归属重派，附报错原文与可选补充说明）。 */
export function retryTicket(
  id: string,
  handlers: OrchestrationHandlers,
  options: { hint?: string; sessionId?: string | null } = {},
): Promise<void> {
  return streamOrchestration(
    `/api/tickets/${encodeURIComponent(id)}/retry`,
    { hint: options.hint ?? null, session_id: options.sessionId ?? null },
    handlers,
  );
}

/** 工单复检（外部改完文件后只重跑渲染+检查）。 */
export function recheckTicket(
  id: string,
  handlers: OrchestrationHandlers,
  sessionId?: string | null,
): Promise<void> {
  return streamOrchestration(
    `/api/tickets/${encodeURIComponent(id)}/recheck`,
    { session_id: sessionId ?? null },
    handlers,
  );
}
