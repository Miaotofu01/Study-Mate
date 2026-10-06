"""附件上传与读取：先落 pending 区，随消息发送后移入 data/uploads/<会话>/。"""
from __future__ import annotations

import re
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import storage
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


def safe_attachment_path(path: Path, base: Path) -> bool:
    """附件必须是 base 内的普通文件且非符号链接——挡住跟随/搬运到外部目标。"""
    if path.is_symlink() or not path.is_file():
        return False
    return storage.path_within(path, base)


def _safe_base(path: Path, root: Path) -> bool:
    """目录本身须是 root 内的真实目录（拒符号链接目录）。"""
    return not path.is_symlink() and path.is_dir() and storage.path_within(path, root)


def classify_kind(filename: str, mime: str | None = None) -> str:
    """SVG 归文档类（视觉模型不收 SVG），其余图片类为 image，其余为 doc。"""
    if filename.lower().endswith(".svg"):
        return "doc"
    if (mime and mime.startswith("image/")) or Path(filename).suffix.lower() in _IMAGE_EXTENSIONS:
        return "image"
    return "doc"


def find_by_id(file_id: str) -> tuple[Path, str] | None:
    """按 id 前缀在 pending 与各会话目录查找（id 必须是 hex，防遍历）。

    每个命中都要求是根目录内的普通文件、非符号链接；会话目录本身也拒符号链接，
    否则会跟随到外部读取/下载任意文件。
    """
    if not UPLOAD_ID_RE.fullmatch(file_id):
        return None
    bases = [PENDING_UPLOADS_DIR]
    if UPLOADS_DIR.is_dir():
        bases.extend(
            path
            for path in UPLOADS_DIR.iterdir()
            if path.is_dir() and not path.is_symlink() and path.name != "pending"
        )
    for base in bases:
        if not _safe_base(base, PENDING_UPLOADS_DIR if base == PENDING_UPLOADS_DIR else UPLOADS_DIR):
            continue
        for path in base.glob(f"{file_id}_*"):
            if safe_attachment_path(path, base):
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
    # 只多读 1 字节就能判超限，避免整包先驻内存再判 20MB（大 body 会先打爆内存）
    data = await file.read(MAX_UPLOAD_BYTES + 1)
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
        # 与发送侧 _attachment_meta 一致：只看文件名后缀（发送时拿不到 content-type），
        # 否则无图片扩展名但声明 image/* 的文件会出现「上传=image、落库=doc」的漂移。
        "kind": classify_kind(filename),
    }


@router.get("/{file_id}/file")
def get_attachment_file(file_id: str) -> FileResponse:
    found = find_by_id(file_id)
    if found is None:
        raise HTTPException(404, "附件不存在")
    return FileResponse(found[0], filename=found[1])
