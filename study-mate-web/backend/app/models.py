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
    POST /api/uploads 返回的附件标识。"""

    message: str
    session_id: str | None = None
    subject_slug: str | None = None
    node_id: str | None = None
    attachment_ids: list[str] = Field(default_factory=list)


class NewSessionRequest(BaseModel):
    title: str = "新的对话"


class RenameSessionRequest(BaseModel):
    title: str


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


class SubjectSummary(BaseModel):
    slug: str
    name: str
    goal: str = ""
    status: str = ""
    created_at: str = ""
    node_total: int = 0
    node_done: int = 0
    avg_mastery: float = 0
