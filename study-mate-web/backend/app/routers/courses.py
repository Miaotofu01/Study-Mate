"""课程图谱与进度路由。"""
from __future__ import annotations

from contextlib import contextmanager
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from .. import curriculum_store as cs
from .. import workspace_ctx
from ..common import optional_workspace, require_subject
from ..models import (
    CreateSubjectRequest,
    PatchSubjectRequest,
    SaveCurriculumRequest,
    UpdateProgressRequest,
)

router = APIRouter(prefix="/api", tags=["courses"])


@contextmanager
def bound_workspace(raw: str | None) -> Iterator[Path | None]:
    """把可选的 ?workspace= query 挂进会话级上下文：没给走全局发现；
    给了但目录不存在 422。yield 的是绑定后的路径（可能为 None）。"""
    with workspace_ctx.bind(optional_workspace(raw)) as bound:
        yield bound


def _effective_views(slug: str) -> list[dict[str, Any]]:
    curriculum = cs.get_curriculum(slug) or {}
    entries = cs.get_progress(slug).get("nodes") or {}
    nodes = curriculum.get("nodes") or []
    return [
        cs.effective_node(node, entries.get(node.get("id")), i + 1, cs.TRANSITIONS)
        for i, node in enumerate(nodes)
        if isinstance(node, dict)
    ]


@router.get("/courses")
def list_courses(workspace: str | None = None) -> list[dict[str, Any]]:
    with bound_workspace(workspace):
        return cs.list_subjects()


@router.post("/courses")
def create_course(payload: CreateSubjectRequest, workspace: str | None = None) -> dict[str, Any]:
    with bound_workspace(workspace):
        name = payload.name.strip()
        if not name:
            raise HTTPException(422, "科目名称不能为空")
        if payload.slug is not None and not cs.is_valid_slug(payload.slug):
            raise HTTPException(422, "slug 格式非法：只允许小写字母、数字，用连字符分隔")
        summary = cs.create_subject(name, payload.slug, (payload.goal or "").strip())
        if summary is None:
            if payload.slug:
                raise HTTPException(409, f"slug 已存在：{payload.slug}")
            raise HTTPException(409, "自动生成的 slug 冲突，请显式指定 slug")
        return summary


@router.get("/courses/{slug}")
def get_course(slug: str, workspace: str | None = None) -> dict[str, Any]:
    with bound_workspace(workspace):
        subject = require_subject(slug)
        curriculum = cs.get_curriculum(slug) or {}
        edges = [
            {"from": edge.get("from"), "to": edge.get("to"), "reason": edge.get("reason") or ""}
            for edge in (curriculum.get("edges") or [])
            if isinstance(edge, dict)
        ]
        return {
            "subject": {
                "name": subject.get("name", ""),
                "slug": subject.get("slug") or slug,
                "goal": subject.get("goal", ""),
                "created_at": subject.get("created_at", ""),
                "status": subject.get("status", ""),
            },
            "graph": {"nodes": _effective_views(slug), "edges": edges},
        }


@router.put("/courses/{slug}/curriculum")
def save_curriculum(slug: str, payload: SaveCurriculumRequest, workspace: str | None = None) -> Any:
    with bound_workspace(workspace):
        require_subject(slug)
        data = {"nodes": payload.nodes, "edges": payload.edges}
        problems = cs.validate_curriculum(data)
        if problems:
            return JSONResponse(
                status_code=422,
                content={"detail": "课程数据校验失败", "problems": problems},
            )
        cs.save_curriculum(slug, data)
        return {"ok": True}


@router.patch("/courses/{slug}")
def patch_course(slug: str, payload: PatchSubjectRequest, workspace: str | None = None) -> dict[str, Any]:
    with bound_workspace(workspace):
        require_subject(slug)
        if payload.status is not None and payload.status not in cs.SUBJECT_STATUSES:
            raise HTTPException(422, f"科目状态非法：{payload.status}")
        if payload.name is not None and not payload.name.strip():
            raise HTTPException(422, "科目名称不能为空")
        name = payload.name.strip() if payload.name is not None else None
        summary = cs.update_subject(slug, name=name, goal=payload.goal, status=payload.status)
        if summary is None:
            raise HTTPException(404, f"科目不存在：{slug}")
        return summary


@router.delete("/courses/{slug}")
def delete_course(slug: str, workspace: str | None = None) -> dict[str, bool]:
    with bound_workspace(workspace):
        require_subject(slug)
        if not cs.delete_subject(slug):
            raise HTTPException(404, f"科目不存在：{slug}")
        return {"ok": True}


@router.put("/courses/{slug}/nodes/{node_id}/progress")
def update_node_progress(
    slug: str,
    node_id: str,
    payload: UpdateProgressRequest,
    workspace: str | None = None,
) -> dict[str, Any]:
    with bound_workspace(workspace):
        require_subject(slug)
        curriculum = cs.get_curriculum(slug) or {}
        nodes = [node for node in (curriculum.get("nodes") or []) if isinstance(node, dict)]
        node = next((item for item in nodes if item.get("id") == node_id), None)
        if node is None:
            raise HTTPException(404, f"节点不存在：{node_id}")

        # 读-改-写整段在 progress_transaction 的锁内完成：并发改同一科目的不同节点
        # 不再各读一份旧内容互相覆盖（校验失败在块内抛出，不落盘）。
        with cs.progress_transaction(slug) as progress:
            entries = progress.setdefault("nodes", {})
            entry = dict(entries.get(node_id) or {})
            current_status = entry.get("status") or node.get("status") or "未开始"

            if payload.status is not None and payload.status != current_status:
                if payload.status not in cs.NODE_STATUSES:
                    raise HTTPException(422, f"节点状态非法：{payload.status}")
                if payload.status not in cs.TRANSITIONS.get(current_status, []):
                    raise HTTPException(409, f"不允许从 {current_status} 变更为 {payload.status}")
                entry["status"] = payload.status

            if payload.mastery is not None:
                entry["mastery"] = round(max(0.0, min(1.0, float(payload.mastery))), 2)
            if payload.notes is not None:
                entry["notes"] = payload.notes
            if payload.lab_status is not None:
                if payload.lab_status not in cs.LAB_STATUSES:
                    raise HTTPException(422, f"lab_status 非法，可选值：{'/'.join(cs.LAB_STATUSES)}")
                entry["lab_status"] = payload.lab_status

            entries[node_id] = entry

        index = next(i for i, item in enumerate(nodes) if item is node) + 1
        return {"ok": True, "node": cs.effective_node(node, entry, index, cs.TRANSITIONS)}
