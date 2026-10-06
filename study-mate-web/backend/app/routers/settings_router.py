"""设置路由：多 Provider 配置读写与连接测试。"""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, HTTPException

from ..config import (
    DEFAULT_SYSTEM_PROMPT,
    load_settings,
    mutate_settings,
    new_provider_id,
)
from ..llm import chat_once
from ..models import ProviderTestRequest, Settings

router = APIRouter(prefix="/api/settings", tags=["settings"])

KEY_MASK = "********"


def _stored_api_key(provider_id: str) -> str:
    """已存提供商的 api_key；测试连接时输入框留空即回落到它。"""
    if not provider_id:
        return ""
    for provider in load_settings().get("providers") or []:
        if provider.get("id") == provider_id:
            return str(provider.get("api_key") or "")
    return ""


@router.get("")
def get_settings() -> dict[str, Any]:
    """api_key 明文返回（供前端回填输入框），另带 has_key 便于判空。

    `default_system_prompt` 是只读元信息（后端唯一默认文案来源），不进 settings、
    不影响 PUT——前端「恢复默认」据此回填，避免跨端硬编码漂移。
    """
    settings = load_settings()
    return {
        "providers": [
            {**provider, "has_key": bool(provider.get("api_key"))}
            for provider in settings.get("providers") or []
        ],
        "active": settings.get("active") or {"provider_id": "", "model": ""},
        "system_prompt": settings.get("system_prompt", ""),
        "default_system_prompt": DEFAULT_SYSTEM_PROMPT,
    }


@router.put("")
def update_settings(payload: Settings) -> dict[str, Any]:
    incoming = payload.model_dump()
    submitted_providers = incoming.get("providers") or []
    # 只在显式带上 system_prompt 时改写：显式空串是合法值（清空），缺省则保持原值。
    set_prompt = "system_prompt" in payload.model_fields_set

    def apply(current: dict[str, Any]) -> dict[str, Any]:
        existing = {
            provider.get("id"): provider for provider in current.get("providers") or []
        }
        providers: list[dict[str, Any]] = []
        for provider in submitted_providers:
            if not provider.get("id"):
                provider["id"] = new_provider_id()
            if not provider.get("created_at"):
                provider["created_at"] = time.time()
            # 掩码或空 key 不覆盖原值，只有传新值才更新
            submitted_key = str(provider.get("api_key") or "")
            if submitted_key in ("", KEY_MASK):
                provider["api_key"] = (existing.get(provider["id"]) or {}).get("api_key") or ""
            providers.append(provider)
        current["providers"] = providers
        current["active"] = incoming.get("active") or {}
        if set_prompt:
            current["system_prompt"] = str(incoming.get("system_prompt") or "")
        return current

    # 读-改-写整体在 config 的锁内完成，并发保存不会互相覆盖
    mutate_settings(apply)
    return {"ok": True}


@router.post("/test")
async def test_provider(payload: ProviderTestRequest) -> dict[str, Any]:
    api_key = payload.api_key or ""
    if not api_key or api_key == KEY_MASK:
        api_key = _stored_api_key(payload.provider_id)
    if not api_key:
        raise HTTPException(422, "缺少 API Key")
    provider = {
        "base_url": payload.base_url,
        "api_key": api_key,
        "api_format": payload.api_format,
        "model": payload.model,
    }
    started = time.perf_counter()
    try:
        sample = await chat_once(provider, [{"role": "user", "content": "ping，请回复 ok"}])
    except Exception as exc:  # noqa: BLE001 - 上游错误统一转 502
        raise HTTPException(502, f"{type(exc).__name__}: {exc}") from None
    return {
        "ok": True,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "sample": sample[:200],
    }
