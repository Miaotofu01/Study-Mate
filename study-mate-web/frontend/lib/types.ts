export type Role = "system" | "user" | "assistant";

export type AttachmentKind = "image" | "doc";

export interface MessageAttachment {
  id: string;
  filename: string;
  kind: AttachmentKind;
  size: number;
}

export type ChatMessageKind = "stage" | "handoff" | "done" | "error" | "build_confirm";

/** 一次 LLM 调用的用量（网关在末块带 usage；无渠道时该轮没有） */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** 工具调用卡（K0 工具化运行时）：id 由后端下发，用于把结果配回调用。 */
export interface ToolActivity {
  id: string;
  name: string;
  /** 原始 JSON 字符串（模型产出，未解析） */
  arguments: string;
  status: "running" | "done" | "error";
  result?: string;
  isError?: boolean;
  /**
   * 产课工具的运行快照（SSE `task_update`，键为父 tool_call id）。有它时该工具渲染成任务卡，
   * 不再用旧 ToolCards；刷新后从落库的 tools 里恢复。
   */
  task?: ProductionTask;
  /**
   * 产课成功时后端结构化下发的课件链接（tool_result.lesson）；打开课件按钮只认它，
   * 不解析模型文本、不猜路径。
   */
  lesson?: LessonLink;
  /** 评估工具的系统结果（tool_result.assessment）：写盘成功/失败由它说了算。 */
  assessment?: AssessmentOutcome;
}

export type MessagePart =
  | { type: "text" | "reasoning" | "notice"; text: string }
  | { type: "tool"; tool_id: string };

/** 产课任务 / 角色 / 阶段的统一状态（含超时/中断；旧 ToolActivity.status 仍只有 running|done|error）。 */
export type ProductionStatus = "running" | "done" | "error" | "timeout" | "interrupted";

/**
 * 角色派工方式：tools=角色工具循环（默认），fallback=工具循环未交付后的单次备用派工，
 * single_call=直连单次调用。旧持久化缺省视为普通角色。
 */
export type ExecutionMode = "tools" | "fallback" | "single_call";

/** 服务端结构化课件链接：subject/node/workspace/file 全由后端解析，前端不猜路径。 */
export interface LessonLink {
  subject_slug: string;
  node_id: string;
  title: string;
  /** 课件所属工作区（绝对路径，服务端已解析） */
  workspace: string;
  /** 相对 HTML 文件名（相对该科目 lessons/ 目录），仅作展示/核对，链接本身用 subject/node/workspace */
  file: string;
}

/** 评估工具的系统落盘结果：文字点评不得冒充它。 */
export interface AssessmentOutcome {
  status: "saved" | "failed";
  node_id: string;
  subject_slug: string;
  record_file?: string;
  verdict?: string;
  mastery?: number;
  progress_updated?: boolean;
  error?: string;
  /** 失败时不启动后台修复；固定 false（缺省也按 false 理解） */
  background?: false;
}

/** 产课任务里的一个角色：有序正文片段 + 该角色自己的工具卡。 */
export interface TaskRole {
  /** 唯一 id（同一任务内角色工具 id 也须唯一，工具结果据此原位回填） */
  id: string;
  name: string;
  status: ProductionStatus;
  /** 有序 text/reasoning/tool_id 片段，工具由 tool_id 引用 tools */
  parts: MessagePart[];
  tools: ToolActivity[];
  round?: number;
  /** 本次派工已等待秒数：按该角色自身开始时刻计，终态后冻结（done 不再涨） */
  elapsed_s?: number;
  /** 派工方式；缺省=旧快照/普通角色，不作为 fallback 显示 */
  execution_mode?: ExecutionMode;
  /** fallback 的短说明（后端固定文案），仅备用派工角色有 */
  fallback_reason?: string;
  /** 本次单次调用的墙钟时限（秒）；<=0 或缺省表示未设时限，不承诺有限等待 */
  max_seconds?: number;
  /** 角色终态说明（如工具循环未交付回落的原文），仅在有值时透出 */
  message?: string;
}

/** 产课阶段事件（讲解/出题/渲染/检查/打回等）。 */
export interface TaskStage {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  message?: string;
}

/**
 * 一次产课任务的完整快照（SSE `task_update.task`，绑在父 produce 工具上）。
 * status 含 interrupted：stop/断线后从 GET 同步也应得到它，不能永久 running。
 */
export interface ProductionTask {
  id: string;
  kind: "produce_lesson";
  title: string;
  subject_slug: string;
  node_id: string;
  /** 任务所属工作区（绝对路径，服务端已解析） */
  workspace: string;
  status: ProductionStatus;
  /** 当前阶段短名（可选，等于 events 里正在跑的那一步） */
  stage?: string;
  elapsed_s?: number;
  round?: number;
  roles: TaskRole[];
  events: TaskStage[];
  lesson?: LessonLink;
  error?: string;
}

/**
 * 统一错误载荷的「阶段」——与后端定稿 `ErrorInfo.phase` 对齐：
 * preflight=请求前（未配 key 等）、request=HTTP 请求失败、stream=流式读取失败、
 * tool=工具执行失败、finalize=收尾/预算墙钟截停。
 */
export type ErrorPhase = "preflight" | "request" | "stream" | "tool" | "finalize";

/**
 * 统一错误信息（SSE `event:error` 平铺载荷、消息 `error` 字段、HTTP `{detail, error}` 同结构）。
 *
 * `code` 刻意保持开放 string（后端会新增 `budget_exhausted` 等），前端不因未知 code 阻塞；
 * 常见值：`upstream_http` / `transport` / `timeout` / `eof` / `empty` / `user_stopped`。
 * `summary`（<=200）与 `detail`（脱敏 <=1200）由后端产出，前端仅作兜底截断/再次脱敏。
 */
export interface ErrorInfo {
  code: string;
  status: number | null;
  upstream_code: string | null;
  phase: ErrorPhase;
  summary: string;
  detail?: string | null;
  retryable: boolean;
  /** 主动/非正常终止原因：`user_stop` / `disconnect` / `wallclock` / `budget` / `unknown`… */
  stopped_reason?: string | null;
  /** = 本轮 turn_id；诊断关联与“是否同一轮”判定用 */
  request_id?: string | null;
  /** 可选：错误来源（后端 errors.py 新增；旧后端缺失） */
  source?: string | null;
  /** 可选：触发操作（后端 errors.py 新增；旧后端缺失） */
  operation?: string | null;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /**
   * R7 展示原文：content 是送模型的完整文本（含文档附件提取）；有附件时后端另存用户原文。
   * 渲染 / 编辑 / 复制 / 再发送一律 `display_content ?? content`（用 ??，空串保留为空）；
   * 旧消息与助手消息没有该字段，自动回落 content。
   */
  display_content?: string;
  attachments?: MessageAttachment[];
  /** 编排事件持久化成的消息类型（stage/handoff/done/error/build_confirm） */
  kind?: ChatMessageKind;
  ticket_id?: string;
  slug?: string;
  /** 本轮工具调用与结果（落库：刷新后仍在「中间过程」折叠区里） */
  tools?: ToolActivity[];
  /** 按 SSE 顺序记录的片段；旧消息缺省时沿用历史布局。工具结果由 tool_id 引用 tools。 */
  parts?: MessagePart[];
  stream_state?: "streaming" | "completed" | "interrupted" | "error";
  /**
   * 本轮结构化错误（SSE `error` / 落库；刷新/切会话后据此回看诊断）。
   * 注意：无正文但有 error 的消息**不可**被空消息过滤删掉（错误本身就是本轮产出）。
   */
  error?: ErrorInfo | null;
  stopped_reason?: string | null;
  turn_id?: string;
  /** 思维链原文（落库，供「中间过程」折叠区回放） */
  reasoning?: string;
  /** 产出这条回复的模型标识「提供商 / 模型」（落库，供消息名称栏） */
  model?: string;
  /** 本轮 SSE 提示（绑定/图片降级/重试）：只在前端会话内呈现，收进「中间过程」折叠区 */
  notices?: string[];
}

export interface Session {
  streaming?: boolean;
  id: string;
  title: string;
  messages: ChatMessage[];
  created_at: number;
  updated_at: number;
  /** 会话级工作区（绝对路径）；null = 用当前默认工作区 */
  workspace?: string | null;
  /** 最近一轮的用量（右栏「上下文窗口」栏据此显示占用） */
  usage?: Usage | null;
  /** 会话绑定的模型/档位；null = 跟随当前默认模型 */
  active?: SessionActive | null;
}

export interface SessionMeta {
  id: string;
  title: string;
  message_count: number;
  created_at: number;
  updated_at: number;
  subject_slug: string | null;
  node_id: string | null;
  /** 会话模式：interview = 建课会话（不收科目关联） */
  mode: "chat" | "interview";
  /** 会话级工作区（绝对路径）；null = 用当前默认工作区 */
  workspace?: string | null;
  /** 最近一轮的用量（打开历史会话时回填右栏用量栏） */
  usage?: Usage | null;
  /** 会话绑定的模型/档位；null = 跟随当前默认模型 */
  active?: SessionActive | null;
}

export type NodeStatus =
  | "未开始"
  | "学习中"
  | "初步理解"
  | "能独立应用"
  | "需要复习"
  | "已通过项目验证";

export type NodeKind = "概念" | "实操" | "实验";

export type SubjectStatus = "进行中" | "暂停" | "已完成";

export interface ResourceItem {
  title: string;
  url?: string;
  type?: string;
}

export type LabStatus = "待生成" | "待提交" | "待评估" | "已通过";

export interface GraphNode {
  id: string;
  title: string;
  kind: NodeKind;
  objective: string;
  problem: string;
  prerequisites: string[];
  concepts: string[];
  resources: ResourceItem[];
  practice: string;
  pitfalls: string[];
  realworld: string;
  status: NodeStatus;
  mastery: number;
  notes: string;
  index: number;
  next_statuses: NodeStatus[];
  lab_status?: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  reason: string;
}

export interface SubjectMeta {
  name: string;
  slug: string;
  goal: string;
  created_at: string;
  status: SubjectStatus;
}

export interface CourseDetail {
  subject: SubjectMeta;
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
}

export interface SubjectSummary {
  slug: string;
  name: string;
  goal: string;
  status: SubjectStatus;
  created_at: string;
  node_total: number;
  node_done: number;
  avg_mastery: number;
}

export type ProviderKind = "preset" | "custom";

export type ApiFormat = "openai_chat" | "openai_responses" | "anthropic";

export type InputModality = "text" | "image" | "video" | "pdf";

export interface ProviderModalities {
  text: boolean;
  image: boolean;
  video: boolean;
  pdf: boolean;
}

export interface ProviderReasoning {
  enabled: boolean;
  variants: string[];
  default_variant: string | null;
}

export interface ProviderCapabilities {
  tool_call: boolean;
  json_schema_output: boolean;
  native_web_search: boolean;
}

export interface ProviderModel {
  name: string;
  display_name?: string;
  /** 未配置（null）时视觉能力按内置前缀表自动判定 */
  modalities: ProviderModalities | null;
  context_window?: number | null;
  max_output_tokens?: number | null;
  reasoning: ProviderReasoning | null;
  /** 仅落盘与展示，不参与请求 */
  capabilities: ProviderCapabilities | null;
  enabled?: boolean;
}

export interface ProviderEntry {
  id: string;
  name: string;
  kind: ProviderKind;
  preset_key: string | null;
  base_url: string;
  api_key: string;
  has_key: boolean;
  api_format: ApiFormat;
  models: ProviderModel[];
  created_at: string;
  enabled?: boolean;
}

export interface ActiveProvider {
  provider_id: string;
  model: string;
  reasoning_variant?: string | null;
}

/** 会话绑定的模型三元组（与 settings.active 同形；null = 跟随当前默认模型） */
export type SessionActive = ActiveProvider;

export interface AppSettings {
  providers: ProviderEntry[];
  active: ActiveProvider;
  system_prompt: string;
  /**
   * 后端内置的默认系统提示词（只读元信息，GET /api/settings 返回）。
   * 「恢复默认」以此为准，避免前端硬编码第二份、与后端口径漂移。
   * 旧后端未提供该字段时为 undefined，前端回退到本地兜底常量。
   */
  default_system_prompt?: string;
}

export interface UploadedAttachment {
  id: string;
  filename: string;
  size: number;
  kind: AttachmentKind;
}

export interface TestConnectionPayload {
  base_url: string;
  api_key: string;
  api_format: ApiFormat;
  model: string;
  provider_id?: string;
}

export interface TestConnectionResponse {
  ok: boolean;
  latency_ms: number;
  sample: string;
}

export type MisconceptionImportance = "low" | "medium" | "high";

export interface MisconceptionItem {
  id: string;
  date: string;
  node: string | null;
  topic: string;
  question: string;
  misunderstanding: string;
  answer_summary: string;
  follow_up: string | null;
  importance: MisconceptionImportance;
}

export interface MisconceptionPayload {
  topic: string;
  question: string;
  misunderstanding: string;
  answer_summary: string;
  /** 传 null 表示清空该字段（后端 PUT/POST 均接受 null） */
  follow_up?: string | null;
  importance?: MisconceptionImportance;
  node?: string | null;
}

export type MisconceptionPatch = Partial<MisconceptionPayload>;

export interface LessonInfo {
  seq: number;
  node_id: string;
  file: string;
  title: string;
  kind: string | null;
  status: string | null;
  has_quiz: boolean;
}

export interface QuizItem {
  anchor: string;
  q: string;
  opts?: string[];
  ans?: number;
  why?: string;
  answer?: string;
  criteria?: string;
}

export type GradeVerdict = "通过" | "部分通过" | "不通过";

export interface GradePayload {
  question: string;
  criteria: string;
  answer: string;
  reference_answer?: string;
}

export interface GradeResult {
  verdict: GradeVerdict;
  evidence: string[];
  missing: string[];
  comment: string;
}

export interface AssessPayload {
  session_id?: string;
  extra_context?: string;
}

export interface AssessQuestion {
  q: string;
  kind?: string;
  answer?: string;
  verdict: string;
  note?: string;
}

export interface Assessment {
  node: string;
  date: string;
  layer?: string;
  questions: AssessQuestion[];
  mastery?: number;
  verdict: string;
  next?: string;
  misconceptions?: string[];
}

export interface AssessResponse {
  ok: boolean;
  record_file: string;
  assessment: Assessment;
  progress_updated: boolean;
  node: GraphNode | null;
}

export interface AssessmentRecord {
  file: string;
  node: string;
  date: string;
  verdict: string;
}

export interface SummaryRecord {
  file: string;
  date: string;
  subject: string;
}

export interface CourseRecords {
  assessments: AssessmentRecord[];
  summaries: SummaryRecord[];
}

export interface SummaryResult {
  date: string;
  subject: string;
  session_goal: string;
  learned: string[];
  next_step: string;
  weaknesses: string[];
  memory_updates?: string[];
}

export interface SummaryResponse {
  ok: boolean;
  record_file: string;
  summary: SummaryResult;
}

export interface ExportResult {
  ok: boolean;
  export_dir: string;
  index_file: string;
  pages: number;
}

export interface WorkspaceInfo {
  path: string;
  /** 来源说明文案，如「环境变量 STUDYMATE_WORKSPACE」「默认（~/StudyMate，上游未配置）」 */
  source: string;
  exists: boolean;
  subjects_dir: string;
  config_path: string;
  subject_count: number;
  /** 可切换的工作区候选路径（当前生效路径、插件默认、env 覆盖值；去重保序） */
  candidates: string[];
}

/** 附件区清单：文件内容经 GET /api/courses/{slug}/files/{path} 读 */
export interface AttachmentsArea {
  /** 术语表文件名（存在时为 "GLOSSARY.md"，否则 null） */
  glossary: string | null;
  reference: string[];
  learning_records: string[];
  sessions: string[];
}

/** 记忆写侧的待确认条目 */
export interface MemoryEntry {
  section: string;
  content: string;
}

export const MEMORY_SECTIONS = ["我是谁", "教学偏好", "学习习惯", "跨科目观察"] as const;

export interface GenerateCoursePayload {
  name: string;
  purpose: string;
  level: string;
  background: string;
  project?: string;
  carrier?: string;
}

export interface GenerateCourseResponse {
  summary: SubjectSummary;
  curriculum: { nodes: GraphNode[]; edges: GraphEdge[] };
}

/** 编排事件的持久化载荷（与后端 production 路由的 SSE 事件对应） */
export interface TicketProblem {
  owner: string;
  path: string;
  line: string;
  message: string;
}

export type TicketStatus = "待处理" | "重试中" | "已解决" | "已放弃";

/**
 * 工单归属判定（与后端 `tickets.ticket_ownership` 同一口径）：
 * - owned / legacy_draft：可安全定位到某工作区（或全局草稿区）；
 * - other：明确属于别的工作区（该 scope 下应 404）；
 * - ambiguous：缺 workspace 记录、无法证实归属，写入前必须由用户显式确认；
 * - legacy_default：**历史值，后端已不再产出**；仅为兼容旧快照保留在联合类型里。
 *   绝不能据此把缺归属的旧单回落/认领到默认工作区——缺 workspace 一律走确认流程。
 */
export type TicketOwnership = "owned" | "other" | "legacy_draft" | "legacy_default" | "ambiguous";

export interface InspectionTicket {
  id: string;
  kind: "produce" | "build";
  slug: string;
  node_id: string | null;
  base_label: string;
  problems: TicketProblem[];
  artifacts: string[];
  retries: number;
  status: TicketStatus;
  created_at: number;
  updated_at: number;
  /**
   * 工单记录的真实归属工作区（绝对路径）。缺失表示旧单归属未知（ambiguous），
   * 必须走「确认归属」流程，**绝不能回落默认工作区自动认领**。
   */
  workspace?: string | null;
  /**
   * 归属模糊的旧单标志（后端对无法证实归属的旧单置 true）。
   * 为 true 时详情需展示「需要确认工作区」，确认前禁止一切会改产物的操作。
   */
  workspace_ambiguous?: boolean;
  /** 服务端归属判定（后端 list/detail 均回传；owned/other/legacy_draft/ambiguous） */
  ownership?: TicketOwnership | null;
}

export interface TicketDetail extends InspectionTicket {
  groups: Record<string, TicketProblem[]>;
  /** 归属模糊的旧单没有可安全指向的产物目录，服务端返回 null（不得拿请求工作区猜） */
  base_dir: string | null;
}

export interface DraftInfo {
  slug: string;
  name: string;
  goal: string;
}

export interface DraftDetail {
  draft: DraftInfo & Record<string, unknown>;
  curriculum: { nodes: GraphNode[]; edges: GraphEdge[] };
  materials: string[];
}
