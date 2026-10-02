import type {
  AppSettings,
  AssessPayload,
  AssessResponse,
  CourseDetail,
  CourseRecords,
  ExportResult,
  GenerateCoursePayload,
  GenerateCourseResponse,
  GradePayload,
  GradeResult,
  GraphNode,
  LabStatus,
  LessonInfo,
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
  UploadedAttachment,
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
  deleteSession: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),

  listCourses: () => jsonFetch<SubjectSummary[]>("/api/courses"),
  createCourse: (payload: CreateCoursePayload) =>
    jsonFetch<SubjectSummary>("/api/courses", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getCourse: (slug: string) =>
    jsonFetch<CourseDetail>(`/api/courses/${encodeURIComponent(slug)}`),
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
};

export interface StreamHandlers {
  onSession?: (sessionId: string) => void;
  onDelta?: (piece: string) => void;
  onNotice?: (message: string) => void;
  onDone?: (sessionId: string) => void;
  onError?: (message: string) => void;
}

export interface StreamChatOptions {
  subjectSlug?: string | null;
  nodeId?: string | null;
  attachments?: string[];
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
  const { subjectSlug = null, nodeId = null, attachments, signal } = options;
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      session_id: sessionId,
      subject_slug: subjectSlug,
      node_id: nodeId,
      attachment_ids: attachments ?? [],
    }),
    signal,
  });

  if (!res.ok) {
    handlers.onError?.(await errorMessage(res));
    return;
  }

  if (!res.body) {
    handlers.onError?.("响应没有 body");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 事件以空行分隔
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
      const payload = JSON.parse(data);

      if (event === "session") handlers.onSession?.(payload.session_id);
      else if (event === "delta") handlers.onDelta?.(payload.content);
      else if (event === "notice") handlers.onNotice?.(payload.message);
      else if (event === "done") handlers.onDone?.(payload.session_id);
      else if (event === "error") handlers.onError?.(payload.message);
    }
  }
}
