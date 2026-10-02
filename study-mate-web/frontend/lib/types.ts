export type Role = "system" | "user" | "assistant";

export type AttachmentKind = "image" | "doc";

export interface MessageAttachment {
  id: string;
  filename: string;
  kind: AttachmentKind;
  size: number;
}

export interface ChatMessage {
  role: Role;
  content: string;
  attachments?: MessageAttachment[];
}

export interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  created_at: number;
  updated_at: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  message_count: number;
  created_at: number;
  updated_at: number;
  subject_slug: string | null;
  node_id: string | null;
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
