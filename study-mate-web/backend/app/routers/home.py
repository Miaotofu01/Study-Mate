"""工作区主页：只读服务根 index.html 及其相对引用的工作区文件。

主页由 gen_home.py 生成在工作区根，页面里用相对路径引 `.learning/assets/**`
与 `.learning/subjects/**`；这里把整个工作区作为只读文件根，路径越出即拒。
"""
from __future__ import annotations

from contextlib import contextmanager

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import curriculum_store as cs
from .. import workspace_ctx
from ..common import optional_workspace

router = APIRouter(prefix="/api", tags=["home"])


@contextmanager
def _scope(workspace: str | None):
    """显式 `?workspace=` 才改绑定；未传保留调用者已绑定的工作区（不 bind(None) 清掉）。"""
    if workspace is None or not str(workspace).strip():
        yield
        return
    with workspace_ctx.bind(optional_workspace(str(workspace))):
        yield


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


@router.get("/home")
def get_home(workspace: str | None = None) -> FileResponse:
    """工作区根主页 <ws>/index.html；未生成则 404。可选 `?workspace=` 指定工作区。"""
    with _scope(workspace):
        target = (cs.workspace_dir() / "index.html").resolve()
        if not target.is_file():
            raise HTTPException(404, "工作区主页不存在：index.html")
    return FileResponse(target, media_type="text/html")


@router.get("/home/{file_path:path}")
def get_home_file(file_path: str, workspace: str | None = None) -> FileResponse:
    """工作区根下的任意文件（主页相对引用由此解析）：词法 + 解析后双重越界防护。"""
    name = file_path.replace("\\", "/")
    if name.startswith("/") or ".." in name.split("/"):
        raise HTTPException(400, "路径非法")
    with _scope(workspace):
        base = cs.workspace_dir().resolve()
        target = (base / name).resolve()
        if target != base and base not in target.parents:
            raise HTTPException(400, "路径越出工作区")
        if not target.is_file():
            raise HTTPException(404, f"文件不存在：{file_path}")
    media_type = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
    return FileResponse(target, media_type=media_type)
