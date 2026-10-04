"""路由层公共依赖：404 守卫、provider 检查、日期工具。"""
from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from . import curriculum_store as cs
from . import storage
from . import workspace_ctx
from .config import get_active_provider, get_session_provider
from .llm import is_fixture_mode


def today() -> str:
    return date.today().isoformat()


def optional_workspace(raw: str | None) -> Path | None:
    """可选的工作区路径参数：没传（或空串）返回 None；给了就必须是存在的目录，
    否则 422。返回值直接交给 workspace_ctx.bind 使用。"""
    if raw is None or not str(raw).strip():
        return None
    try:
        return workspace_ctx.validate_dir(str(raw))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


def require_subject(slug: str) -> dict[str, Any]:
    if not cs.is_valid_slug(slug):
        raise HTTPException(404, f"科目不存在：{slug}")
    subject = cs.get_subject(slug)
    if subject is None:
        raise HTTPException(404, f"科目不存在：{slug}")
    return subject


def require_node(slug: str, node_id: str) -> tuple[dict[str, Any], int]:
    """返回 (节点, 1 基位次)；节点不存在 404。"""
    curriculum = cs.get_curriculum(slug) or {}
    nodes = [node for node in (curriculum.get("nodes") or []) if isinstance(node, dict)]
    for index, node in enumerate(nodes, start=1):
        if node.get("id") == node_id:
            return node, index
    raise HTTPException(404, f"节点不存在：{node_id}")


def node_ids(slug: str) -> set[str]:
    curriculum = cs.get_curriculum(slug) or {}
    return {
        node.get("id")
        for node in (curriculum.get("nodes") or [])
        if isinstance(node, dict) and node.get("id")
    }


def require_provider(session_id: str | None = None) -> dict[str, Any]:
    """当前调用要用的 provider。

    给了 session_id 且该会话绑定了模型/档位就用它（2026-10-04：模型按会话持久化）；
    绑定失效或无绑定则回落当前默认模型——与会话内聊天同一套口径，避免"聊天用一个模型、
    小结/评估用另一个"。
    """
    if is_fixture_mode():
        return {"model": "fixture", "api_format": "openai_chat"}
    session = storage.get_session(session_id) if session_id else None
    bound = session.get("active") if session else None
    provider = get_session_provider(bound) if bound else None
    if provider is None:
        provider = get_active_provider()
    if provider is None or not provider.get("api_key"):
        raise HTTPException(422, "尚未配置模型 API Key，请先到 Settings 填写。")
    return provider
