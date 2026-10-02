"""M1 错误概念本：双落点 CRUD。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from .. import curriculum_store as cs
from .. import misconceptions as mc
from ..common import node_ids, require_subject, today
from ..models import MisconceptionCreateRequest

router = APIRouter(prefix="/api", tags=["misconceptions"])


def _validate_importance(importance: str) -> str:
    if importance not in cs.IMPORTANCES:
        raise HTTPException(422, f"importance 非法，可选值：{'/'.join(cs.IMPORTANCES)}")
    return importance


def _validate_node(slug: str, node: Any) -> str | None:
    if node is None or node == "":
        return None
    if not isinstance(node, str) or node not in node_ids(slug):
        raise HTTPException(422, f"节点不存在：{node}")
    return node


@router.get("/courses/{slug}/misconceptions")
def list_misconceptions(
    slug: str,
    importance: str | None = None,
    node_id: str | None = None,
) -> dict[str, list[dict[str, Any]]]:
    require_subject(slug)
    return {"items": mc.list_items(slug, importance=importance, node_id=node_id)}


@router.post("/courses/{slug}/misconceptions")
def create_misconception(slug: str, payload: MisconceptionCreateRequest) -> dict[str, Any]:
    require_subject(slug)
    fields = {
        "topic": payload.topic.strip(),
        "question": payload.question.strip(),
        "misunderstanding": payload.misunderstanding.strip(),
        "answer_summary": payload.answer_summary.strip(),
    }
    for key, value in fields.items():
        if not value:
            raise HTTPException(422, f"{key} 不能为空")
    item = mc.create_item(
        slug,
        {
            **fields,
            "follow_up": (payload.follow_up or "").strip() or None,
            "importance": _validate_importance(payload.importance),
            "node": _validate_node(slug, payload.node),
            "date": today(),
        },
    )
    return {"item": item}


@router.put("/courses/{slug}/misconceptions/{item_id}")
def update_misconception(
    slug: str,
    item_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    require_subject(slug)
    patch: dict[str, Any] = {}
    for key in mc.EDITABLE_FIELDS:
        if key not in payload:
            continue
        value = payload[key]
        if key in mc.REQUIRED_FIELDS:
            if not isinstance(value, str) or not value.strip():
                raise HTTPException(422, f"{key} 不能为空")
            patch[key] = value.strip()
        elif key == "importance":
            if not isinstance(value, str):
                raise HTTPException(422, f"importance 非法，可选值：{'/'.join(cs.IMPORTANCES)}")
            patch[key] = _validate_importance(value)
        elif key == "node":
            patch[key] = _validate_node(slug, value)
        else:
            if value is not None and not isinstance(value, str):
                raise HTTPException(422, "follow_up 必须是字符串或 null")
            patch[key] = (value or "").strip() or None
    item = mc.update_item(slug, item_id, patch)
    if item is None:
        raise HTTPException(404, f"误解条目不存在：{item_id}")
    return {"item": item}


@router.delete("/courses/{slug}/misconceptions/{item_id}")
def delete_misconception(slug: str, item_id: str) -> dict[str, bool]:
    require_subject(slug)
    if not mc.delete_item(slug, item_id):
        raise HTTPException(404, f"误解条目不存在：{item_id}")
    return {"ok": True}
