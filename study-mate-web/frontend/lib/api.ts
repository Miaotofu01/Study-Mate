import type {
  AppSettings,
  AssessmentOutcome,
  AssessPayload,
  AssessResponse,
  AttachmentsArea,
  ChatMessage,
  CourseDetail,
  CourseRecords,
  DraftDetail,
  DraftInfo,
  ErrorInfo,
  ErrorPhase,
  ExportResult,
  GenerateCoursePayload,
  GenerateCourseResponse,
  GradePayload,
  GradeResult,
  GraphNode,
  InspectionTicket,
  LabStatus,
  LessonInfo,
  LessonLink,
  MemoryEntry,
  MisconceptionImportance,
  MisconceptionItem,
  MisconceptionPatch,
  MisconceptionPayload,
  NodeStatus,
  ProductionTask,
  QuizItem,
  Session,
  SessionActive,
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
  Usage,
  WorkspaceInfo,
} from "./types";

/** 常见密钥/令牌形态：前端兜底脱敏（后端已先脱敏，这里防止旧后端或代理回显泄密）。 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{6,}/g,
  /(?:api[_-]?key|apikey|access[_-]?token|secret)["'\s:=]+[A-Za-z0-9._\-+/=]{8,}/gi,
  /Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
];

/** 复制诊断/展示前脱敏；再按需截断，不把密钥带进剪贴板。 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[已脱敏]");
  return out;
}

function clampText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 后端 summary/detail 的限长（前端兜底，避免旧后端或代理回显超长原文）。 */
const SUMMARY_MAX = 200;
const DETAIL_MAX = 1200;

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 把任意输入（新 ErrorInfo / 旧字符串 / ApiError）规整成 ErrorInfo；空返回 null。 */
export function normalizeError(
  input: ErrorInfo | string | null | undefined,
  phase: ErrorPhase = "stream",
): ErrorInfo | null {
  if (input == null) return null;
  if (typeof input === "string") {
    const summary = clampText(redactSecrets(input).trim(), SUMMARY_MAX);
    if (!summary) return null;
    return {
      code: "legacy_error",
      status: null,
      upstream_code: null,
      phase,
      summary,
      detail: clampText(redactSecrets(input), DETAIL_MAX),
      retryable: false,
      stopped_reason: null,
      request_id: null,
      source: null,
      operation: null,
    };
  }
  return coerceErrorInfo(input, phase);
}

/** 判断是否为一个已带 ErrorInfo 形状的对象（后端已定稿结构）。 */
function isErrorInfoLike(value: unknown): value is Partial<ErrorInfo> {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.code === "string" || typeof obj.phase === "string";
}

/** 宽松收编后端 ErrorInfo：缺失字段给安全默认，summary/detail 兜底脱敏+限长。 */
export function coerceErrorInfo(input: Partial<ErrorInfo>, fallbackPhase: ErrorPhase = "stream"): ErrorInfo {
  const summary = clampText(redactSecrets(String(input.summary ?? "")).trim(), SUMMARY_MAX);
  const rawDetail = input.detail == null ? "" : String(input.detail);
  const detail = rawDetail ? clampText(redactSecrets(rawDetail), DETAIL_MAX) : null;
  const status = typeof input.status === "number" ? input.status : null;
  return {
    code: typeof input.code === "string" && input.code ? clampText(redactSecrets(input.code), 120) : "unknown_error",
    status,
    upstream_code: input.upstream_code == null ? null : clampText(redactSecrets(String(input.upstream_code)), 120),
    phase: (input.phase as ErrorPhase) ?? fallbackPhase,
    summary: summary || "请求失败，请重试。",
    detail,
    retryable:
      typeof input.retryable === "boolean"
        ? input.retryable
        : status != null && RETRYABLE_STATUSES.has(status),
    stopped_reason: input.stopped_reason == null ? null : String(input.stopped_reason),
    request_id: input.request_id == null ? null : clampText(redactSecrets(String(input.request_id)), 120),
    source: input.source == null ? null : clampText(redactSecrets(String(input.source)), 120),
    operation: input.operation == null ? null : clampText(redactSecrets(String(input.operation)), 120),
  };
}

export class ApiError extends Error {
  readonly problems?: string[];
  readonly status?: number;
  readonly detail?: string;
  readonly errorInfo?: ErrorInfo;

  constructor(
    message: string,
    problems?: string[],
    options: { status?: number; detail?: string; errorInfo?: ErrorInfo } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.problems = problems;
    this.status = options.status;
    this.detail = options.detail;
    this.errorInfo = options.errorInfo;
  }
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const info = await parseErrorResponse(res);
    throw new ApiError(info.message, info.problems, {
      status: res.status,
      detail: info.error.detail ?? undefined,
      errorInfo: info.error,
    });
  }
  return res.json() as Promise<T>;
}

interface ParsedError {
  message: string;
  problems?: string[];
  error: ErrorInfo;
}

/**
 * 解析非 2xx 响应：优先读后端定稿 `{detail: summary, error: ErrorInfo}`；
 * 无 `error` 时（旧后端 / 代理 / 纯文本）合成一个 HTTP 错误 Info。
 */
async function parseErrorResponse(res: Response): Promise<ParsedError> {
  let problems: string[] | undefined;
  let fallbackSummary = `${res.status} ${res.statusText}`.trim();
  let fallbackDetail: string | null = null;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object") {
      const obj = body as Record<string, unknown>;
      if (Array.isArray(obj.problems) && obj.problems.length > 0) {
        problems = obj.problems.map((p) => String(p)).filter(Boolean);
        if (problems.length) fallbackSummary = problems.join("；");
      }
      if (isErrorInfoLike(obj.error)) {
        const error = coerceErrorInfo({ ...(obj.error as Partial<ErrorInfo>), status: (obj.error as Partial<ErrorInfo>).status ?? res.status }, "request");
        return { message: error.summary, problems, error };
      }
      if ("detail" in obj) {
        const detail: unknown = obj.detail;
        if (typeof detail === "string" && detail) {
          fallbackSummary = detail;
          fallbackDetail = detail;
        } else if (Array.isArray(detail)) {
          const msgs = detail
            .map((item) =>
              item && typeof item === "object" && "msg" in item
                ? String((item as { msg: unknown }).msg)
                : String(item),
            )
            .filter(Boolean);
          if (msgs.length) {
            fallbackSummary = msgs.join("；");
            fallbackDetail = fallbackSummary;
          }
        }
      }
    }
  } catch {
    // 响应体不是 JSON，退回 HTTP 状态文案
  }
  const error = coerceErrorInfo(
    {
      code: "upstream_http",
      status: res.status,
      upstream_code: null,
      phase: "request",
      summary: fallbackSummary,
      detail: fallbackDetail,
      retryable: RETRYABLE_STATUSES.has(res.status),
    },
    "request",
  );
  return { message: error.summary, problems, error };
}

async function errorMessage(res: Response): Promise<string> {
  return (await parseErrorResponse(res)).message;
}

async function rawFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const info = await parseErrorResponse(res);
    throw new ApiError(info.message, info.problems, { status: res.status, detail: info.error.detail ?? undefined, errorInfo: info.error });
  }
  return res.json() as Promise<T>;
}

/**
 * 把 SSE `event:error` 的平铺载荷收编为 ErrorInfo；兼容旧后端只带 `message` 的形态。
 */
export function coerceSseError(payload: Record<string, unknown>): ErrorInfo {
  if (isErrorInfoLike(payload)) return coerceErrorInfo(payload as Partial<ErrorInfo>, "stream");
  const message = typeof payload.message === "string" ? payload.message : "";
  return (
    normalizeError(message, "stream") ?? {
      code: "unknown_error",
      status: null,
      upstream_code: null,
      phase: "stream",
      summary: "本轮发生未知错误。",
      detail: null,
      retryable: false,
      stopped_reason: null,
      request_id: null,
    }
  );
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

/**
 * 工作区路径 → URL-safe token（base64url，无填充）。
 *
 * 用途：iframe 里的课件/主页会对共享资源做相对引用（`../../../assets/...`、`.learning/assets/...`），
 * 浏览器解析相对 URL 时会丢掉 query，所以 `?workspace=` 传不到子资源请求。把工作区编进路径前缀
 * 后，嵌套引用解析出来仍带前缀，不依赖 Referer。
 * 信任模型与 `?workspace=` 一致（本机单机）：后端解码后仍须校验目录存在且在根内。
 */
function toWorkspaceToken(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 工作区前缀只读资源根：`/api/workspace-files/<token>`；无 workspace 时返回 null（走旧默认工作区路由）。
 * 后端 `/api/workspace-files/{token}/...` 系委托原 handler 的只读路由：
 * - 课件/科目资源：`<base>/courses/{slug}/files/{rel}`（`../../../assets` 自然落到 `<base>/courses/assets/...`）
 * - 工作区主页：`<base>/home/index.html`（显式 `index` 保住相对层级，`.learning/assets/...` 仍在 `home/` 下）
 */
export function workspaceFileBaseOf(workspace: WorkspaceParam): string | null {
  if (!workspace) return null;
  return `/api/workspace-files/${toWorkspaceToken(workspace)}`;
}

/** 把相对路径逐段编码（保留 `/` 分隔），供资源 URL 复用 */
function encodeRelPath(relativePath: string): string {
  return relativePath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
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
  /** 绑定/解绑会话级模型与档位（null = 回到当前默认模型） */
  setSessionActive: (id: string, active: SessionActive | null) =>
    jsonFetch<Session>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ active }),
    }),
  deleteSession: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /**
   * 登记“用户主动停止”意图（后端绑定 active turn_id，15s 内一次消费；无 active 轮返回 stop:false）。
   * 限时等待，绝不无限阻塞：超时/异常一律返回 `{ok:false, stop:false}`，调用方仍应本地 abort。
   */
  stopSession: (id: string, timeoutMs = 1500): Promise<{ ok: boolean; stop: boolean }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(`/api/sessions/${encodeURIComponent(id)}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: controller.signal,
      keepalive: true,
    })
      .then(async (res) =>
        res.ok ? ((await res.json()) as { ok: boolean; stop?: boolean }) : { ok: false, stop: false },
      )
      .then((data) => ({ ok: Boolean(data.ok), stop: Boolean(data.stop) }))
      .catch(() => ({ ok: false, stop: false }))
      .finally(() => clearTimeout(timer));
  },
  /** 删除整轮（index 指向该轮的用户消息或助手回复，服务端成对删掉） */
  deleteTurn: (id: string, index: number) =>
    jsonFetch<{ ok: boolean; deleted: number[]; messages: ChatMessage[] }>(
      `/api/sessions/${encodeURIComponent(id)}/messages/${index}`,
      { method: "DELETE" },
    ),

  listCourses: (workspace?: WorkspaceParam) =>
    jsonFetch<SubjectSummary[]>(withWorkspace("/api/courses", workspace)),
  createCourse: (payload: CreateCoursePayload, workspace?: WorkspaceParam) =>
    jsonFetch<SubjectSummary>(withWorkspace("/api/courses", workspace), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getCourse: (slug: string, workspace?: WorkspaceParam) =>
    jsonFetch<CourseDetail>(
      withWorkspace(`/api/courses/${encodeURIComponent(slug)}`, workspace),
    ),
  patchCourse: (slug: string, payload: PatchCoursePayload, workspace?: WorkspaceParam) =>
    jsonFetch<SubjectSummary>(
      withWorkspace(`/api/courses/${encodeURIComponent(slug)}`, workspace),
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    ),
  deleteCourse: (slug: string, workspace?: WorkspaceParam) =>
    jsonFetch<{ ok: boolean }>(
      withWorkspace(`/api/courses/${encodeURIComponent(slug)}`, workspace),
      {
        method: "DELETE",
      },
    ),
  updateNodeProgress: (
    slug: string,
    nodeId: string,
    payload: NodeProgressPayload,
    workspace?: WorkspaceParam,
  ) =>
    jsonFetch<{ ok: boolean; node: GraphNode }>(
      withWorkspace(
        `/api/courses/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nodeId)}/progress`,
        workspace,
      ),
      { method: "PUT", body: JSON.stringify(payload) },
    ),

  listMisconceptions: (slug: string, query: MisconceptionQuery = {}, workspace?: WorkspaceParam) => {
    const params = new URLSearchParams();
    if (query.importance) params.set("importance", query.importance);
    if (query.node_id) params.set("node_id", query.node_id);
    const qs = params.toString();
    return jsonFetch<{ items: MisconceptionItem[] }>(
      withWorkspace(
        `/api/courses/${encodeURIComponent(slug)}/misconceptions${qs ? `?${qs}` : ""}`,
        workspace,
      ),
    );
  },
  createMisconception: (slug: string, payload: MisconceptionPayload, workspace?: WorkspaceParam) =>
    jsonFetch<{ item: MisconceptionItem }>(
      withWorkspace(`/api/courses/${encodeURIComponent(slug)}/misconceptions`, workspace),
      { method: "POST", body: JSON.stringify(payload) },
    ),
  updateMisconception: (
    slug: string,
    id: string,
    payload: MisconceptionPatch,
    workspace?: WorkspaceParam,
  ) =>
    jsonFetch<{ item: MisconceptionItem }>(
      withWorkspace(
        `/api/courses/${encodeURIComponent(slug)}/misconceptions/${encodeURIComponent(id)}`,
        workspace,
      ),
      { method: "PUT", body: JSON.stringify(payload) },
    ),
  deleteMisconception: (slug: string, id: string, workspace?: WorkspaceParam) =>
    jsonFetch<{ ok: boolean }>(
      withWorkspace(
        `/api/courses/${encodeURIComponent(slug)}/misconceptions/${encodeURIComponent(id)}`,
        workspace,
      ),
      { method: "DELETE" },
    ),

  listLessons: (slug: string, workspace?: WorkspaceParam) =>
    jsonFetch<{ lessons: LessonInfo[] }>(
      withWorkspace(`/api/courses/${encodeURIComponent(slug)}/lessons`, workspace),
    ),
  getQuiz: (slug: string, nodeId: string, workspace?: WorkspaceParam) =>
    jsonFetch<{ items: QuizItem[] }>(
      withWorkspace(
        `/api/courses/${encodeURIComponent(slug)}/quiz/${encodeURIComponent(nodeId)}`,
        workspace,
      ),
    ),
  gradeAnswer: (
    slug: string,
    nodeId: string,
    payload: GradePayload,
    workspace?: WorkspaceParam,
  ) =>
    jsonFetch<GradeResult>(
      withWorkspace(
        `/api/courses/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nodeId)}/grade`,
        workspace,
      ),
      { method: "POST", body: JSON.stringify(payload) },
    ),
  assessNode: (
    slug: string,
    nodeId: string,
    payload: AssessPayload,
    workspace?: WorkspaceParam,
  ) =>
    jsonFetch<AssessResponse>(
      withWorkspace(
        `/api/courses/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nodeId)}/assess`,
        workspace,
      ),
      { method: "POST", body: JSON.stringify(payload) },
    ),
  listRecords: (slug: string, workspace?: WorkspaceParam) =>
    jsonFetch<CourseRecords>(
      withWorkspace(`/api/courses/${encodeURIComponent(slug)}/records`, workspace),
    ),
  generateSessionSummary: (slug: string, sessionId: string, workspace?: WorkspaceParam) =>
    jsonFetch<SummaryResponse>(
      withWorkspace(
        `/api/courses/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/summary`,
        workspace,
      ),
      { method: "POST", body: JSON.stringify({}) },
    ),
  exportCourse: (slug: string, workspace?: WorkspaceParam) =>
    jsonFetch<ExportResult>(
      withWorkspace(`/api/courses/${encodeURIComponent(slug)}/export`, workspace),
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    ),

  generateCourse: (payload: GenerateCoursePayload, workspace?: WorkspaceParam) =>
    jsonFetch<GenerateCourseResponse>(withWorkspace("/api/courses/generate", workspace), {
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
  // 绑定工作区时走 `/api/workspace-files/<token>/courses/<slug>/files/...`：课件的嵌套相对引用
  // （../../../assets 落在 <base>/courses/assets、../assets 落在本 slug 的 files/assets）都带前缀；
  // 缺省保持旧的默认工作区路由。
  workspaceFileBase: workspaceFileBaseOf,
  courseFileUrl: (slug: string, relativePath: string, workspace?: WorkspaceParam) => {
    const rel = encodeRelPath(relativePath);
    const base = workspaceFileBaseOf(workspace);
    if (base) return `${base}/courses/${encodeURIComponent(slug)}/files/${rel}`;
    return `/api/courses/${encodeURIComponent(slug)}/files/${rel}`;
  },

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

  // 质检工单（工单可能属于某个工作区；旧 ticket 无 workspace 时回落默认）
  // includeUnscoped：额外列出归属未知（ambiguous）的单（后端保证不含 owned-other），
  //   免得它们在列表里静默消失；绝不能为看见未知单把 workspace 猜成某个工作区去认领。
  listTickets: (
    slug?: string,
    openOnly = false,
    workspace?: WorkspaceParam,
    includeUnscoped = false,
  ) => {
    const params = new URLSearchParams();
    if (slug) params.set("slug", slug);
    if (openOnly) params.set("open_only", "true");
    if (includeUnscoped) params.set("include_unscoped", "true");
    const qs = params.toString();
    return jsonFetch<InspectionTicket[]>(
      withWorkspace(`/api/tickets${qs ? `?${qs}` : ""}`, workspace),
    );
  },
  getTicket: (id: string, workspace?: WorkspaceParam) =>
    jsonFetch<TicketDetail>(
      withWorkspace(`/api/tickets/${encodeURIComponent(id)}`, workspace),
    ),
  /**
   * 确认旧工单归属：用户选定/手输 workspace 后由服务端持久化，之后详情与写操作才按该归属放行。
   * workspace 走请求体（不是 `?workspace=` scope），因为这一步正是在决定归属。
   * 响应 {ok, ticket}；错误：无目录/科目/节点 422、draft/已归属别区重绑 409、相同归属幂等 200。
   */
  confirmTicketWorkspace: (id: string, workspace: string) =>
    jsonFetch<{ ok: boolean; ticket: TicketDetail }>(
      `/api/tickets/${encodeURIComponent(id)}/claim`,
      {
        method: "POST",
        body: JSON.stringify({ workspace }),
      },
    ),
  quickEditTicketArtifact: (
    id: string,
    path: string,
    content: string,
    workspace?: WorkspaceParam,
  ) =>
    jsonFetch<{ ok: boolean }>(
      withWorkspace(`/api/tickets/${encodeURIComponent(id)}/artifact`, workspace),
      {
        method: "PUT",
        body: JSON.stringify({ path, content }),
      },
    ),
  abandonTicket: (id: string, workspace?: WorkspaceParam) =>
    jsonFetch<{ ok: boolean }>(
      withWorkspace(`/api/tickets/${encodeURIComponent(id)}/abandon`, workspace),
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    ),

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

  // 落点确认：带上会话 id，后端据此把 promote 出来的科目关联回该会话
  promoteDraft: (slug: string, sessionId?: string | null, target?: string) =>
    jsonFetch<{ ok: boolean; subject_dir: string }>(
      `/api/drafts/${encodeURIComponent(slug)}/promote`,
      {
        method: "POST",
        body: JSON.stringify({ target: target ?? null, session_id: sessionId ?? null }),
      },
    ),
};

export interface StreamHandlers {
  onSession?: (sessionId: string) => void;
  onDelta?: (piece: string) => void;
  /** 思维链增量（网关 reasoning_content / anthropic thinking_delta） */
  onReasoning?: (piece: string) => void;
  onNotice?: (message: string) => void;
  onConfirm?: (payload: { slug: string; name: string }) => void;
  /** 工具化运行时（K0）：模型发起一次工具调用 */
  onToolCall?: (payload: { id: string; name: string; arguments: string }) => void;
  /**
   * 工具执行结果回吐（is_error 表示工具以错误文本回填，循环不中断）。
   * task / lesson / assessment 是后端结构化透传的可选载荷（TOOL_METADATA_KEYS）：
   * 产课终态 task、课件链接、评估落盘结果；前端只信这些字段，不解析 content 文本、不猜路径。
   * 终态 task_update 丢失时，靠 tool_result.task 兜底把卡收成 done。
   */
  onToolResult?: (payload: {
    id: string;
    name: string;
    content: string;
    is_error: boolean;
    task?: ProductionTask;
    lesson?: LessonLink;
    assessment?: AssessmentOutcome;
  }) => void;
  /**
   * 产课任务快照（SSE `task_update`）：id 为父 tool_call id，task 为完整快照。
   * 只更新对应 ToolActivity.task，不追加 message / parts；高频进度也只刷新同一张卡。
   */
  onTaskUpdate?: (payload: { id: string; task: ProductionTask }) => void;
  /** 本轮 LLM 用量（右栏「上下文窗口」栏） */
  onUsage?: (usage: Usage) => void;
  onDone?: (sessionId: string) => void;
  /**
   * 本轮错误：新后端下发结构化 ErrorInfo，旧后端/旧调用点仍可能是字符串。
   * 前端统一用 `normalizeError` 收编，调用方按 ErrorInfo 处理。
   */
  onError?: (error: ErrorInfo | string) => void;
}

/** 编排进度快照（后端 ProgressReporter 每几秒发一次）：用来证明"确实在工作" */
export interface OrchestrationProgress {
  stage: string;
  round: number;
  elapsed_s: number;
  reasoning_chars: number;
  text_chars?: number;
  tool_calls: number;
  last_tool?: string;
}

/** 编排 SSE 的事件处理（production 路由：stage/retry/progress/handoff/done/error）。 */
export interface OrchestrationHandlers {
  onSession?: (sessionId: string) => void;
  onStage?: (payload: { stage: string; status: string; artifacts?: string[]; problems?: TicketProblem[] }) => void;
  /** 周期性进度（第几轮 / 已等待多久 / 工具次数）：编排卡据此显示"在干活" */
  onProgress?: (payload: OrchestrationProgress) => void;
  onRetry?: (payload: { round: number; owners: string[]; reason?: string }) => void;
  onHandoff?: (payload: { ticket: InspectionTicket }) => void;
  onDone?: (payload: { message?: string; slug?: string; stage?: string; artifacts?: string[] }) => void;
  onError?: (error: ErrorInfo | string) => void;
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
  /**
   * 编辑重发：被取代的旧用户消息下标（含，其后全部消息在服务端一并截断）。
   * 只有编辑已有会话的用户消息时才带；普通发送不带此键。
   */
  replaceFrom?: number;
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
  const {
    subjectSlug,
    nodeId,
    attachments,
    workspace,
    mode = null,
    fixtureScenario = null,
    replaceFrom,
    signal,
  } = options;
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
      ...(replaceFrom === undefined ? {} : { replace_from: replaceFrom }),
    }),
    signal,
  });

  if (!res.ok) {
    handlers.onError?.((await parseErrorResponse(res)).error);
    return;
  }

  // done / error 是前端复位 streaming 的唯一入口：流自然结束却没等到它们（后端任务被取消、
  // 进程被杀、连接被中间层截断），必须补一条错误，否则界面会一直转圈。
  let settled = false;
  await consumeSSE(res, (event, payload) => {
    if (event === "session") handlers.onSession?.(payload.session_id as string);
    else if (event === "delta") handlers.onDelta?.(payload.content as string);
    else if (event === "reasoning") handlers.onReasoning?.(payload.content as string);
    else if (event === "notice") handlers.onNotice?.(payload.message as string);
    else if (event === "tool_call")
      handlers.onToolCall?.(payload as unknown as { id: string; name: string; arguments: string });
    else if (event === "tool_result")
      handlers.onToolResult?.(
        payload as unknown as {
          id: string;
          name: string;
          content: string;
          is_error: boolean;
          task?: ProductionTask;
          lesson?: LessonLink;
          assessment?: AssessmentOutcome;
        },
      );
    else if (event === "task_update")
      handlers.onTaskUpdate?.(
        payload as unknown as { id: string; task: ProductionTask },
      );
    else if (event === "usage") handlers.onUsage?.(payload.usage as Usage);
    else if (event === "confirm") handlers.onConfirm?.(payload as never);
    else if (event === "done") {
      settled = true;
      handlers.onDone?.(payload.session_id as string);
    } else if (event === "error") {
      settled = true;
      handlers.onError?.(coerceSseError(payload));
    }
  });
  if (!settled) {
    // 流自然结束却没等到 done/error：连接被截断（EOF）。给结构化 transport 错误，红色展示且可重试。
    handlers.onError?.({
      code: "eof",
      status: null,
      upstream_code: null,
      phase: "stream",
      summary: "连接中断：本轮未正常结束，请重试。",
      detail: null,
      retryable: true,
      stopped_reason: null,
      request_id: null,
    });
  }
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
    handlers.onError?.((await parseErrorResponse(res)).error);
    return;
  }
  await consumeSSE(res, (event, payload) => {
    if (event === "session") handlers.onSession?.(payload.session_id as string);
    else if (event === "stage") handlers.onStage?.(payload as never);
    else if (event === "progress") handlers.onProgress?.(payload as never);
    else if (event === "retry") handlers.onRetry?.(payload as never);
    else if (event === "handoff") handlers.onHandoff?.(payload as never);
    else if (event === "done") handlers.onDone?.(payload);
    else if (event === "error") handlers.onError?.(coerceSseError(payload));
    // finished / confirm 在编排流里忽略（confirm 仅 chat 流使用；progress 高频、不持久化）
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
  options: { hint?: string; sessionId?: string | null; workspace?: WorkspaceParam } = {},
): Promise<void> {
  return streamOrchestration(
    withWorkspace(`/api/tickets/${encodeURIComponent(id)}/retry`, options.workspace),
    { hint: options.hint ?? null, session_id: options.sessionId ?? null },
    handlers,
  );
}

/** 工单复检（外部改完文件后只重跑渲染+检查）。 */
export function recheckTicket(
  id: string,
  handlers: OrchestrationHandlers,
  sessionId?: string | null,
  workspace?: WorkspaceParam,
): Promise<void> {
  return streamOrchestration(
    withWorkspace(`/api/tickets/${encodeURIComponent(id)}/recheck`, workspace),
    { session_id: sessionId ?? null },
    handlers,
  );
}
