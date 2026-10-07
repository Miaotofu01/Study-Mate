"""Pydantic 请求/响应模型。"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

Role = Literal["system", "user", "assistant"]

APIFormat = Literal["openai_chat", "openai_responses", "anthropic"]

LEGACY_VISION_MODES = ("auto", "on", "off")
LEGACY_THINKING_TIERS = ("off", "low", "medium", "high")
LEGACY_REASONING_VARIANTS = ["off", "low", "medium", "high"]


def _legacy_modalities(vision: str) -> dict[str, bool]:
    return {"text": True, "image": vision == "on", "video": False, "pdf": False}


class Message(BaseModel):
    role: Role
    content: str


class ModelModalities(BaseModel):
    text: bool = True
    image: bool = False
    video: bool = False
    pdf: bool = False


class ModelReasoning(BaseModel):
    enabled: bool = False
    variants: list[str] = Field(default_factory=list)
    default_variant: str | None = None


class ModelCapabilities(BaseModel):
    tool_call: bool = False
    json_schema_output: bool = False
    native_web_search: bool = False


class ModelEntry(BaseModel):
    name: str
    display_name: str = ""
    modalities: ModelModalities | None = None
    context_window: int | None = None
    max_output_tokens: int | None = None
    reasoning: ModelReasoning | None = None
    capabilities: ModelCapabilities | None = None
    enabled: bool = True

    @model_validator(mode="before")
    @classmethod
    def _upgrade_legacy(cls, data: Any) -> Any:
        """旧模型字段（vision 三态 / thinking 四档）按迁移规则补齐新字段。"""
        if not isinstance(data, dict):
            return data
        if "vision" not in data and "thinking" not in data:
            return data
        upgraded = {key: value for key, value in data.items() if key not in ("vision", "thinking")}
        vision = str(data.get("vision") or "auto")
        thinking = str(data.get("thinking") or "off")
        if upgraded.get("modalities") is None and vision in ("on", "off"):
            upgraded["modalities"] = _legacy_modalities(vision)
        if (
            upgraded.get("reasoning") is None
            and thinking in LEGACY_THINKING_TIERS
            and thinking != "off"
        ):
            upgraded["reasoning"] = {
                "enabled": True,
                "variants": list(LEGACY_REASONING_VARIANTS),
                "default_variant": thinking,
            }
        return upgraded


class ProviderEntry(BaseModel):
    id: str = ""
    name: str = ""
    kind: Literal["preset", "custom"] = "custom"
    preset_key: str | None = None
    base_url: str = ""
    api_key: str = ""
    api_format: APIFormat = "openai_chat"
    models: list[ModelEntry] = Field(default_factory=list)
    created_at: float | str = 0.0
    enabled: bool = True


class ActiveRef(BaseModel):
    provider_id: str = ""
    model: str = ""
    reasoning_variant: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _upgrade_legacy(cls, data: Any) -> Any:
        """旧 active.thinking → reasoning_variant（"off" 原样保留为档位名）。"""
        if not isinstance(data, dict) or "thinking" not in data:
            return data
        upgraded = {key: value for key, value in data.items() if key != "thinking"}
        tier = data.get("thinking")
        if tier and not upgraded.get("reasoning_variant"):
            upgraded["reasoning_variant"] = str(tier)
        return upgraded


class Settings(BaseModel):
    providers: list[ProviderEntry] = Field(default_factory=list)
    active: ActiveRef = Field(default_factory=ActiveRef)
    system_prompt: str = ""


class ProviderTestRequest(BaseModel):
    base_url: str = ""
    api_key: str = ""
    api_format: APIFormat = "openai_chat"
    model: str = ""
    provider_id: str = ""


class ChatRequest(BaseModel):
    """发送一条消息。session_id 为空时新建会话；attachment_ids 引用
    POST /api/uploads 返回的附件标识。mode 只在新建会话时生效（建课会话=interview）。
    workspace 只在新建会话时生效：本次会话的工作区（绝对路径字符串）。
    replace_from 用于「编辑重发」：先截断该下标的用户消息及其后全部消息，再追加新消息。"""

    message: str
    session_id: str | None = None
    subject_slug: str | None = None
    node_id: str | None = None
    attachment_ids: list[str] = Field(default_factory=list)
    mode: Literal["chat", "interview"] | None = None
    workspace: str | None = None
    """仅 fixture 模式生效：E2E 按请求选固定流场景（interview），免改后端 env。"""
    fixture_scenario: str | None = None
    """编辑重发：被取代的旧用户消息下标（含，其后全部消息一并截断）。"""
    replace_from: int | None = None


class NewSessionRequest(BaseModel):
    title: str = "新的对话"
    workspace: str | None = None


class SessionActiveRequest(BaseModel):
    """会话绑定的模型三元组（与 settings.active 同形，2026-10-04）。"""

    provider_id: str
    model: str
    reasoning_variant: str | None = None


class SessionPatchRequest(BaseModel):
    """PATCH /api/sessions/{id}：title / workspace / active 均可选。

    三者的「缺省」与「显式 null」靠 model_fields_set 区分：只传 title 维持旧行为；
    传 workspace=null 表示显式清空会话级工作区（回到全局发现）；active=null 表示
    解绑模型（回到当前默认模型），传三元组则绑定到该会话。
    """

    title: str | None = None
    workspace: str | None = None
    active: SessionActiveRequest | None = None


class SessionMeta(BaseModel):
    id: str
    title: str
    message_count: int
    created_at: float
    updated_at: float
    subject_slug: str | None = None
    node_id: str | None = None


class CreateSubjectRequest(BaseModel):
    name: str
    slug: str | None = None
    goal: str | None = None


class PatchSubjectRequest(BaseModel):
    name: str | None = None
    goal: str | None = None
    status: str | None = None


class SaveCurriculumRequest(BaseModel):
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)


class UpdateProgressRequest(BaseModel):
    status: str | None = None
    mastery: float | None = None
    notes: str | None = None
    lab_status: str | None = None


class MisconceptionCreateRequest(BaseModel):
    topic: str
    question: str
    misunderstanding: str
    answer_summary: str
    follow_up: str | None = None
    importance: str = "medium"
    node: str | None = None


class GradeRequest(BaseModel):
    question: str
    criteria: str
    answer: str
    reference_answer: str | None = None


class AssessRequest(BaseModel):
    session_id: str | None = None
    extra_context: str | None = None


class SummaryRequest(BaseModel):
    extra_context: str | None = None


class GenerateCourseRequest(BaseModel):
    name: str
    purpose: str
    level: str
    background: str
    project: str | None = None
    carrier: str | None = None
    slug: str | None = None


class MaterialRequest(BaseModel):
    """建课草稿的落盘结构化资料（粘贴文本 → 转 Markdown 入 reference/）。"""

    title: str
    text: str


class PromoteRequest(BaseModel):
    """落点确认：target 为空时用发现链给出的工作区。

    session_id 为触发本次建课的会话：落点成功后把该会话关联到新科目
    （此前建完课不自动关联，学习者得手动再选一次科目）。
    """

    target: str | None = None
    session_id: str | None = None


class RetryTicketRequest(BaseModel):
    """工单重试/复检：hint 为可选的学习者补充说明（进派工值）。"""

    session_id: str | None = None
    hint: str | None = None


class TicketQuickEditRequest(BaseModel):
    """工单单文件快改（textarea 保存回科目目录）。"""

    path: str
    content: str


class ClaimTicketRequest(BaseModel):
    """认领旧工单：显式指定该工单归属的工作区（绝对路径）。

    只写工单的 workspace 字段，不重写科目、不移动文件；目标必须是已存在、
    确有同 slug 科目（有 node_id 时还要含该节点）的合法工作区。
    """

    workspace: str


class AbandonTicketRequest(BaseModel):
    """放弃工单：reason 可选，仅记录收口理由（不改课程产物、不改归属）。"""

    reason: str | None = None


class SubjectSummary(BaseModel):
    slug: str
    name: str
    goal: str = ""
    status: str = ""
    created_at: str = ""
    node_total: int = 0
    node_done: int = 0
    avg_mastery: float = 0
