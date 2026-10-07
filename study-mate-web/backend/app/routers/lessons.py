"""M2 课件展示：只读服务科目目录里已有的课件产物。"""
from __future__ import annotations

import glob as globlib
import json
import re
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse

from .. import curriculum_store as cs
from ..common import require_subject
from ..config import REPO_ROOT
from .courses import bound_workspace

router = APIRouter(prefix="/api", tags=["lessons"])

LESSON_RE = re.compile(r"^(\d+)-(.+)\.html$")
CONTENT_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".gif": "image/gif",
    ".woff2": "font/woff2",
}


def _node_map(slug: str) -> dict[str, dict[str, Any]]:
    curriculum = cs.get_curriculum(slug) or {}
    return {
        node.get("id"): node
        for node in (curriculum.get("nodes") or [])
        if isinstance(node, dict) and node.get("id")
    }


@router.get("/courses/{slug}/lessons")
def list_lessons(slug: str, workspace: str | None = None) -> dict[str, list[dict[str, Any]]]:
    with bound_workspace(workspace):
        require_subject(slug)
        lessons_dir = cs.subject_dir(slug) / "lessons"
        nodes = _node_map(slug)
        items: list[dict[str, Any]] = []
        if lessons_dir.is_dir():
            for path in lessons_dir.glob("*.html"):
                match = LESSON_RE.match(path.name)
                if not match:
                    continue
                node_id = match.group(2)
                node = nodes.get(node_id)
                items.append(
                    {
                        "seq": int(match.group(1)),
                        "node_id": node_id,
                        "file": f"lessons/{path.name}",
                        "title": (node or {}).get("title") or node_id,
                        "kind": (node or {}).get("kind"),
                        "status": (node or {}).get("status"),
                        "has_quiz": (lessons_dir / f"{path.stem}.quiz.json").is_file(),
                    }
                )
        items.sort(key=lambda item: item["seq"])
        return {"lessons": items}


@router.get("/courses/{slug}/files/{file_path:path}")
def get_file(slug: str, file_path: str, workspace: str | None = None) -> Any:
    with bound_workspace(workspace):
        require_subject(slug)
        base = cs.subject_dir(slug).resolve()
        target = (base / file_path).resolve()
        if target != base and base not in target.parents:
            raise HTTPException(400, "路径越出科目目录")
        if not target.is_file():
            if file_path == "index.html":
                return HTMLResponse(
                    f'<meta http-equiv="refresh" content="0;url=/courses?subject={slug}">',
                )
            raise HTTPException(404, f"文件不存在：{file_path}")
        media_type = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        return FileResponse(target, media_type=media_type)


@router.get("/courses/{slug}/attachments-area")
def list_attachments_area(slug: str, workspace: str | None = None) -> dict[str, Any]:
    """附件区清单：术语表、reference/ 本地资料、学习记录、会话摘要（内容经 /files/ 读）。"""
    with bound_workspace(workspace):
        require_subject(slug)
        base = cs.subject_dir(slug)

        def list_dir(name: str) -> list[str]:
            directory = base / name
            return sorted(path.name for path in directory.glob("*.md")) if directory.is_dir() else []

        return {
            "glossary": "GLOSSARY.md" if (base / "GLOSSARY.md").is_file() else None,
            "reference": list_dir("reference"),
            "learning_records": list_dir("learning-records"),
            "sessions": list_dir("sessions"),
        }


@router.get("/courses/assets/{file_path:path}")
def get_shared_asset(file_path: str, workspace: str | None = None) -> FileResponse:
    """课件里的 `../../../assets/...`（KaTeX/主题/sayo）落到这里：先工作区 assets，缺则回退仓库 templates/assets。"""
    name = file_path.replace("\\", "/")
    if name.startswith("/") or ".." in name.split("/"):
        raise HTTPException(400, "路径非法")
    with bound_workspace(workspace):
        for raw_base in (cs.workspace_dir() / ".learning" / "assets", REPO_ROOT / "templates" / "assets"):
            base = raw_base.resolve()
            target = (base / name).resolve()
            if target == base or base not in target.parents:
                continue
            if target.is_file():
                media_type = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
                return FileResponse(target, media_type=media_type)
        raise HTTPException(404, f"共享资源不存在：{file_path}")


@router.get("/courses/{slug}/quiz/{node_id}")
def get_quiz(slug: str, node_id: str, workspace: str | None = None) -> dict[str, list[dict[str, Any]]]:
    with bound_workspace(workspace):
        require_subject(slug)
        if node_id not in _node_map(slug):
            raise HTTPException(404, f"节点不存在：{node_id}")
        lessons_dir = cs.subject_dir(slug) / "lessons"
        items: list[dict[str, Any]] = []
        if lessons_dir.is_dir():
            pattern = f"*-{globlib.escape(node_id)}.quiz.json"
            for path in sorted(lessons_dir.glob(pattern)):
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                    raise HTTPException(500, f"题目文件解析失败：{path.name}（{exc}）") from None
                if not isinstance(data, dict):
                    continue
                for anchor, questions in data.items():
                    if not isinstance(questions, list):
                        continue
                    for question in questions:
                        if isinstance(question, dict):
                            item: dict[str, Any] = {"anchor": anchor}
                            item.update(question)
                            items.append(item)
        return {"items": items}
