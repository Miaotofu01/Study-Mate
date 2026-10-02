"""路由层公共依赖：404 守卫、provider 检查、日期工具。"""
from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import HTTPException

from . import curriculum_store as cs
from .config import get_active_provider
from .llm import is_fixture_mode


def today() -> str:
    return date.today().isoformat()


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


def require_provider() -> dict[str, Any]:
    if is_fixture_mode():
        return {"model": "fixture", "api_format": "openai_chat"}
    provider = get_active_provider()
    if provider is None or not provider.get("api_key"):
        raise HTTPException(422, "尚未配置模型 API Key，请先到 Settings 填写。")
    return provider
