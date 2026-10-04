export type Role = "system" | "user" | "assistant";

export type AttachmentKind = "image" | "doc";

export interface MessageAttachment {
  id: string;
  filename: string;
  kind: AttachmentKind;
  size: number;
}

export type ChatMessageKind = "stage" | "handoff" | "done" | "error" | "build_confirm";

/** 工具调用卡（K0 工具化运行时）：id 由后端下发，用于把结果配回调用。 */
export interface ToolActivity {
  id: string;
  name: string;
  /** 原始 JSON 字符串（模型产出，未解析） */
  arguments: string;
  status: "running" | "done" | "error";
  result?: string;
  isError?: boolean;
}

export interface ChatMessage {
  role: Role;
  content: string;
  attachments?: MessageAttachment[];
  /** 编排事件持久化成的消息类型（stage/handoff/done/error/build_confirm） */
  kind?: ChatMessageKind;
  ticket_id?: string;
  slug?: string;
  /** 本轮工具调用与结果（仅流式期间在前端呈现，兼审计 UI；不落会话历史） */
  tools?: ToolActivity[];
}

export interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  created_at: number;
  updated_at: number;
  /** 会话级工作区（绝对路径）；null = 用当前默认工作区 */
  workspace?: string | null;
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

export interface AppSettings {
  providers: ProviderEntry[];
  active: ActiveProvider;
  system_prompt: string;
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
  follow_up?: string;
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
}

export interface TicketDetail extends InspectionTicket {
  groups: Record<string, TicketProblem[]>;
  base_dir: string;
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
