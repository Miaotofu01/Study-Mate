"""文件型会话存储：每个会话一个 JSON 文件，放在 data/sessions/<id>.json。

阶段 1 用文件存储，零依赖、可直接查看；后续会话量大了再换 SQLite。
"""
from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from .config import SESSIONS_DIR, UPLOADS_DIR, ensure_dirs


def _session_path(session_id: str) -> Path:
    return SESSIONS_DIR / f"{session_id}.json"


def create_session(
    title: str = "新的对话",
    mode: str = "chat",
    workspace: str | None = None,
) -> dict[str, Any]:
    """新建会话；workspace 为会话级工作区（绝对路径字符串），None 跟随全局发现。"""
    ensure_dirs()
    now = time.time()
    session = {
        "id": uuid.uuid4().hex[:12],
        "title": title,
        "messages": [],
        "created_at": now,
        "updated_at": now,
        "subject_slug": None,
        "node_id": None,
        "mode": mode,
        "workspace": workspace,
    }
    _write(session)
    return session


def _write(session: dict[str, Any]) -> None:
    session["updated_at"] = time.time()
    with _session_path(session["id"]).open("w", encoding="utf-8") as fh:
        json.dump(session, fh, ensure_ascii=False, indent=2)


def get_session(session_id: str) -> dict[str, Any] | None:
    path = _session_path(session_id)
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def require_session(session_id: str) -> dict[str, Any]:
    session = get_session(session_id)
    if session is None:
        raise KeyError(f"session not found: {session_id}")
    return session


def session_workspace(session_id: str | None) -> str | None:
    """会话绑定的会话级工作区（绝对路径字符串）；会话不存在或没绑定为 None。"""
    if not session_id:
        return None
    session = get_session(session_id)
    if session is None:
        return None
    return session.get("workspace")


def add_message(
    session_id: str,
    role: str,
    content: str,
    attachments: list[dict[str, Any]] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """追加消息；extra（kind/ticket_id/slug 等）原样并入消息记录。"""
    session = require_session(session_id)
    message: dict[str, Any] = {"role": role, "content": content}
    if attachments:
        message["attachments"] = attachments
    for key, value in extra.items():
        if value is not None:
            message[key] = value
    session["messages"].append(message)
    # 第一条用户消息自动作为会话标题
    if role == "user" and len(session["messages"]) == 1:
        session["title"] = content[:24] + ("…" if len(content) > 24 else "")
    _write(session)
    return session


def update_session(session_id: str, **fields: Any) -> dict[str, Any] | None:
    session = get_session(session_id)
    if session is None:
        return None
    session.update(fields)
    _write(session)
    return session


def list_sessions() -> list[dict[str, Any]]:
    ensure_dirs()
    metas: list[dict[str, Any]] = []
    for path in SESSIONS_DIR.glob("*.json"):
        with path.open("r", encoding="utf-8") as fh:
            s = json.load(fh)
        metas.append(
            {
                "id": s["id"],
                "title": s["title"],
                "message_count": len(s["messages"]),
                "created_at": s["created_at"],
                "updated_at": s["updated_at"],
                "subject_slug": s.get("subject_slug"),
                "node_id": s.get("node_id"),
                "mode": s.get("mode") or "chat",
                "workspace": s.get("workspace"),
            }
        )
    return sorted(metas, key=lambda m: m["updated_at"], reverse=True)


def delete_session(session_id: str) -> bool:
    path = _session_path(session_id)
    if path.exists():
        path.unlink()
        shutil.rmtree(UPLOADS_DIR / session_id, ignore_errors=True)
        return True
    return False


def rename_session(session_id: str, title: str) -> dict[str, Any]:
    session = require_session(session_id)
    session["title"] = title
    _write(session)
    return session
