"""附件上传与读取：先落 pending 区，随消息发送后移入 data/uploads/<会话>/。"""
from __future__ import annotations

import re
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..config import PENDING_UPLOADS_DIR, UPLOADS_DIR

router = APIRouter(prefix="/api/uploads", tags=["uploads"])

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
PENDING_MAX_AGE_SECONDS = 24 * 3600
UPLOAD_ID_RE = re.compile(r"^[0-9a-f]{6,32}$")

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}


def safe_filename(name: str) -> str:
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = re.sub(r"[^\w.\- ]", "_", name).strip()
    return cleaned or "file"


def classify_kind(filename: str, mime: str | None = None) -> str:
    """SVG 归文档类（视觉模型不收 SVG），其余图片类为 image，其余为 doc。"""
    if filename.lower().endswith(".svg"):
        return "doc"
    if (mime and mime.startswith("image/")) or Path(filename).suffix.lower() in _IMAGE_EXTENSIONS:
        return "image"
    return "doc"


def find_by_id(file_id: str) -> tuple[Path, str] | None:
    """按 id 前缀在 pending 与各会话目录查找（id 必须是 hex，防遍历）。"""
    if not UPLOAD_ID_RE.fullmatch(file_id):
        return None
    bases = [PENDING_UPLOADS_DIR]
    if UPLOADS_DIR.is_dir():
        bases.extend(
            path
            for path in UPLOADS_DIR.iterdir()
            if path.is_dir() and path.name != "pending"
        )
    for base in bases:
        if not base.is_dir():
            continue
        for path in base.glob(f"{file_id}_*"):
            if path.is_file():
                name = path.name.split("_", 1)[1] if "_" in path.name else path.name
                return path, name
    return None


def cleanup_pending(max_age_seconds: float = PENDING_MAX_AGE_SECONDS) -> int:
    """清扫 pending 中超过时限的未引用文件（已随消息发送的文件不在 pending）。

    返回删除数量。
    """
    if not PENDING_UPLOADS_DIR.is_dir():
        return 0
    now = time.time()
    removed = 0
    for path in PENDING_UPLOADS_DIR.iterdir():
        try:
            if path.is_file() and now - path.stat().st_mtime > max_age_seconds:
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed


@router.post("")
async def upload_attachment(
    file: UploadFile = File(...),
    session_id: str | None = Form(None),
) -> dict[str, Any]:
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "附件超过 20MB 上限")
    filename = safe_filename(file.filename or "file")
    file_id = uuid.uuid4().hex[:16]
    PENDING_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    (PENDING_UPLOADS_DIR / f"{file_id}_{filename}").write_bytes(data)
    return {
        "id": file_id,
        "filename": filename,
        "size": len(data),
        "kind": classify_kind(filename, file.content_type),
    }


@router.get("/{file_id}/file")
def get_attachment_file(file_id: str) -> FileResponse:
    found = find_by_id(file_id)
    if found is None:
        raise HTTPException(404, "附件不存在")
    return FileResponse(found[0], filename=found[1])
