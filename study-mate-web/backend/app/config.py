"""运行时配置：多 Provider 设置从 <study-mate-web>/data/settings.json 读取，环境变量可覆盖。

settings v3 结构：providers[]（id/name/kind/preset_key/base_url/api_key/
api_format/models/created_at/enabled）+ active{provider_id, model,
reasoning_variant} + 顶层 system_prompt。models 项为 name/display_name/
modalities{text,image,video,pdf}|None/context_window/max_output_tokens/
reasoning{enabled,variants[],default_variant}|None/capabilities{tool_call,
json_schema_output,native_web_search}|None/enabled：
- modalities 为 None 表示未配置，视觉判定回落内置前缀表；
- reasoning.enabled 为 False 或 variants 为空时不发思考参数；
- 工具调用默认对所有配置的模型开启（2026-10-04），`capabilities.tool_call` 不再参与门控；
旧模型字段（vision 三态 / thinking 四档）在读取时迁移为上述结构，
active.thinking 迁移为 reasoning_variant；迁移对行为无感。
旧单 provider 结构在读取时自动迁移，迁移立即写回且不丢 key。
"""
from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BASE_DIR.parent.parent
WEB_ROOT = BASE_DIR.parent
DATA_DIR = Path(os.getenv("STUDYMATE_DATA_DIR") or (WEB_ROOT / "data"))
SETTINGS_PATH = DATA_DIR / "settings.json"
SESSIONS_DIR = DATA_DIR / "sessions"
UPLOADS_DIR = DATA_DIR / "uploads"
PENDING_UPLOADS_DIR = UPLOADS_DIR / "pending"
SCHEMAS_DIR = REPO_ROOT / "schemas"
SCRIPTS_DIR = REPO_ROOT / "scripts"

API_FORMATS = ("openai_chat", "openai_responses", "anthropic")
INPUT_MODALITIES = ("text", "image", "video", "pdf")
LEGACY_VISION_MODES = ("auto", "on", "off")
LEGACY_REASONING_VARIANTS = ("off", "low", "medium", "high")

PRESET_PROVIDERS: dict[str, dict[str, str]] = {
    "deepseek": {
        "name": "DeepSeek",
        "base_url": "https://api.deepseek.com",
        "api_format": "openai_chat",
        "model": "deepseek-chat",
    },
    "siliconflow": {
        "name": "SiliconFlow",
        "base_url": "https://api.siliconflow.cn/v1",
        "api_format": "openai_chat",
        "model": "deepseek-ai/DeepSeek-V3",
    },
    "dashscope": {
        "name": "DashScope",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "api_format": "openai_chat",
        "model": "qwen-plus",
    },
    "openai": {
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "api_format": "openai_chat",
        "model": "gpt-4o-mini",
    },
}

PERSONA_PROMPT = (
    "你是 StudyMate 自学系统的主教练（学习模式），坚持 learn with doing：讲清概念后引导学习者动手练习，"
    "用通俗的语言和具体的例子解释知识。开场先按学习者近期状态报告上次学到哪、这次建议学什么；"
    "每轮回复的最后一行都按「**下一步**：<谁做什么> —— <怎么触发>」的格式给出下一步，别让学生停在那儿等。"
)
DEFAULT_SYSTEM_PROMPT = PERSONA_PROMPT
_LEGACY_DEFAULT_SYSTEM_PROMPT = (
    "你是 StudyMate，一个陪伴式学习助手。你的原则是 learn with doing："
    "讲清概念后引导学习者动手练习，用通俗的语言和具体的例子解释知识。"
)


def new_provider_id() -> str:
    return uuid.uuid4().hex[:12]


def _preset_entry(preset_key: str) -> dict[str, Any]:
    preset = PRESET_PROVIDERS[preset_key]
    return {
        "id": preset_key,
        "name": preset["name"],
        "kind": "preset",
        "preset_key": preset_key,
        "base_url": preset["base_url"],
        "api_key": "",
        "api_format": preset["api_format"],
        "models": [_default_model(preset["model"])],
        "created_at": time.time(),
        "enabled": True,
    }


def _default_model(name: str) -> dict[str, Any]:
    return {
        "name": name,
        "display_name": "",
        "modalities": None,
        "context_window": None,
        "max_output_tokens": None,
        "reasoning": None,
        "capabilities": None,
        "enabled": True,
    }


def _upgrade_model(model: dict[str, Any]) -> dict[str, Any]:
    """旧模型字段 → v3：vision 的 on/off → modalities，"auto"/缺省 → None；
    thinking 的 low/medium/high → 启用态 reasoning（默认档位即旧值），"off"/缺省 → None。
    新字段缺省时补齐默认值，返回新字典（调用方据返回值判断是否发生变化）。"""
    upgraded = dict(model)
    vision = str(upgraded.pop("vision", "") or "")
    thinking = str(upgraded.pop("thinking", "") or "")
    if upgraded.get("modalities") is None and vision in ("on", "off"):
        upgraded["modalities"] = {
            "text": True,
            "image": vision == "on",
            "video": False,
            "pdf": False,
        }
    if (
        upgraded.get("reasoning") is None
        and thinking in LEGACY_REASONING_VARIANTS
        and thinking != "off"
    ):
        upgraded["reasoning"] = {
            "enabled": True,
            "variants": list(LEGACY_REASONING_VARIANTS),
            "default_variant": thinking,
        }
    upgraded.setdefault("display_name", "")
    upgraded.setdefault("modalities", None)
    upgraded.setdefault("context_window", None)
    upgraded.setdefault("max_output_tokens", None)
    upgraded.setdefault("reasoning", None)
    upgraded.setdefault("capabilities", None)
    upgraded.setdefault("enabled", True)
    return upgraded


def _upgrade_active(active: dict[str, Any]) -> dict[str, Any]:
    """旧 active.thinking → reasoning_variant；"off"/缺省 → None（回落模型默认档位）。"""
    upgraded = dict(active)
    thinking = str(upgraded.pop("thinking", "") or "")
    if not upgraded.get("reasoning_variant"):
        upgraded["reasoning_variant"] = thinking or None
    return upgraded


def _upgrade_settings(settings: dict[str, Any]) -> bool:
    """模型与 active 升级到 v3；有变化返回 True（调用方负责写回）。"""
    changed = False
    active = settings.get("active")
    if isinstance(active, dict) and ("thinking" in active or "reasoning_variant" not in active):
        settings["active"] = _upgrade_active(active)
        changed = True
    providers = settings.get("providers")
    if not isinstance(providers, list):
        return changed
    for provider in providers:
        if not isinstance(provider, dict):
            continue
        models = provider.get("models")
        if not isinstance(models, list):
            continue
        upgraded = [_upgrade_model(model) for model in models if isinstance(model, dict)]
        if upgraded != models:
            provider["models"] = upgraded
            changed = True
    return changed


def default_settings() -> dict[str, Any]:
    return {
        "providers": [_preset_entry(key) for key in PRESET_PROVIDERS],
        "active": {
            "provider_id": "deepseek",
            "model": PRESET_PROVIDERS["deepseek"]["model"],
            "reasoning_variant": None,
        },
        "system_prompt": DEFAULT_SYSTEM_PROMPT,
    }


def _migrate_v1(settings: dict[str, Any]) -> dict[str, Any]:
    """旧单 provider 结构 → 多 provider 结构：base_url 与预设精确一致记为该
    preset，否则 custom「原有配置」；旧 model 成为 models[0]（vision=auto）；
    active 指向它；key 原样保留。"""
    old = settings.get("provider") or {}
    base_url = str(old.get("base_url") or "")
    model = str(old.get("model") or "")
    api_key = str(old.get("api_key") or "")
    preset_key = next(
        (key for key, preset in PRESET_PROVIDERS.items() if preset["base_url"] == base_url),
        "",
    )
    if preset_key:
        entry = _preset_entry(preset_key)
    else:
        entry = {
            "id": new_provider_id(),
            "name": "原有配置",
            "kind": "custom",
            "preset_key": "",
            "base_url": base_url,
            "api_key": "",
            "api_format": "openai_chat",
            "models": [],
            "created_at": time.time(),
            "enabled": True,
        }
    entry["api_key"] = api_key
    entry["models"] = [_default_model(model)]
    return {
        "providers": [entry],
        "active": {
            "provider_id": entry["id"],
            "model": model,
            "reasoning_variant": None,
        },
        "system_prompt": settings.get("system_prompt") or DEFAULT_SYSTEM_PROMPT,
    }


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)


def load_settings() -> dict[str, Any]:
    """读取设置；文件缺失写入默认值，旧结构原地迁移写回。"""
    ensure_dirs()
    if not SETTINGS_PATH.exists():
        settings = default_settings()
        save_settings(settings)
        return settings

    with SETTINGS_PATH.open("r", encoding="utf-8") as fh:
        settings = json.load(fh)

    if "providers" not in settings and "provider" in settings:
        settings = _migrate_v1(settings)
        save_settings(settings)
    settings.setdefault("providers", [])
    settings.setdefault("active", {})
    settings.setdefault("system_prompt", DEFAULT_SYSTEM_PROMPT)
    if settings.get("system_prompt") == _LEGACY_DEFAULT_SYSTEM_PROMPT:
        settings["system_prompt"] = DEFAULT_SYSTEM_PROMPT
        save_settings(settings)
    if _upgrade_settings(settings):
        save_settings(settings)
    return settings


def save_settings(settings: dict[str, Any]) -> None:
    ensure_dirs()
    with SETTINGS_PATH.open("w", encoding="utf-8") as fh:
        json.dump(settings, fh, ensure_ascii=False, indent=2)


def _model_field(entries: list[dict[str, Any]], model: str, key: str, default: Any) -> Any:
    for item in entries:
        if item.get("name") == model and key in item:
            return item.get(key)
    return default


def _model_reasoning_variant(
    reasoning: Any,
    active_variant: str,
) -> str:
    """当前生效推理档位：active.reasoning_variant 优先，回落模型默认档位。"""
    if not isinstance(reasoning, dict) or not reasoning.get("enabled"):
        return ""
    variants = reasoning.get("variants")
    if not isinstance(variants, list) or not variants:
        return ""
    variant = active_variant or str(reasoning.get("default_variant") or "")
    return "" if variant == "off" else str(variant)


def get_active_provider() -> dict[str, Any] | None:
    """当前生效 provider 字典（含 model 与模态 / 最大输出 / 推理档位）。

    环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 覆盖对应字段，
    优先级最高、不写盘；无 providers、active 指向不存在或该提供商已停用时返回 None。
    """
    settings = load_settings()
    providers = settings.get("providers") or []
    active = settings.get("active") or {}
    provider = next(
        (item for item in providers if item.get("id") == active.get("provider_id")),
        None,
    )
    if provider is None or not provider.get("enabled", True):
        return None

    entries = provider.get("models") or []
    usable = [item for item in entries if item.get("enabled", True)]
    model = str(active.get("model") or "")
    if os.getenv("LLM_MODEL"):
        model = os.environ["LLM_MODEL"]
    exists = any(item.get("name") == model for item in entries)
    if not exists:
        fallback = usable or entries
        model = str(fallback[0].get("name") or "") if fallback else ""
    elif usable and not any(item.get("name") == model for item in usable):
        # 当前模型被停用：回落到该提供商第一个可用模型
        model = str(usable[0].get("name") or "")

    modalities = _model_field(entries, model, "modalities", None)
    reasoning = _model_field(entries, model, "reasoning", None)
    variant = _model_reasoning_variant(reasoning, str(active.get("reasoning_variant") or ""))

    return {
        **provider,
        "model": model,
        "modalities": modalities,
        "max_output_tokens": _model_field(entries, model, "max_output_tokens", None),
        "reasoning": reasoning,
        "reasoning_variant": variant,
        # 工具调用默认对所有模型开启（2026-10-04）；capabilities 保留落盘/展示
        "capabilities": _model_field(entries, model, "capabilities", None),
        # 兼容 chat.py 既有的 provider["vision"] 读取方式：由 modalities 派生三态
        "vision": (
            "on"
            if isinstance(modalities, dict) and modalities.get("image")
            else "off"
            if isinstance(modalities, dict)
            else "auto"
        ),
        "base_url": os.getenv("LLM_BASE_URL", str(provider.get("base_url") or "")),
        "api_key": os.getenv("LLM_API_KEY", str(provider.get("api_key") or "")),
    }
