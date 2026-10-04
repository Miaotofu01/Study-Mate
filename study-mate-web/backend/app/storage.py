"""文件型会话存储：每个会话一个 JSON 文件，放在 data/sessions/<id>.json。

阶段 1 用文件存储，零依赖、可直接查看；后续会话量大了再换 SQLite。
"""
from __future__ import annotations

import contextlib
import json
import os
import shutil
import threading
import time
import uuid
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from .config import SESSIONS_DIR, UPLOADS_DIR, ensure_dirs

# 会话文件是"整文件读改写"，两个并发写者会各读一份旧内容、后写覆盖先写（丢消息），
# 读侧还可能读到写了一半的 JSON（真机实测：并发读写时出现 `Extra data` 解析错与 500）。
# 所以读写都走这把可重入锁：**单进程内同一时刻只有一个线程碰某个会话文件**。
# 另外 `_write` 仍是"临时文件 + os.replace"的原子替换——那是对外部的保证（备份/编辑器/
# 崩溃时刻），也让"上锁"这件事万一漏了一处也不至于读到半个文件。
_WRITE_LOCK = threading.RLock()


def _session_path(session_id: str) -> Path:
    return SESSIONS_DIR / f"{session_id}.json"


def create_session(
    title: str = "新的对话",
    mode: str = "chat",
    workspace: str | None = None,
    active: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """新建会话；workspace 为会话级工作区（绝对路径字符串），None 跟随全局发现。

    active 为会话绑定的模型三元组（`{provider_id, model, reasoning_variant}`，与
    `settings.active` 同形）；None = 跟随当前默认模型（2026-10-04：模型/档位按会话持久化）。
    """
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
        "active": active,
    }
    _write(session)
    return session


def _write(session: dict[str, Any]) -> None:
    """原子落盘：先写同目录临时文件、再 `os.replace`。

    直接 `open("w")` 是"先截断再逐段写"，读侧（`get_session` / `list_sessions`）正好撞上
    就会解析到半个 JSON；换成临时文件 + `os.replace` 后，读侧看到的永远是完整快照。
    """
    session["updated_at"] = time.time()
    path = _session_path(session["id"])
    payload = json.dumps(session, ensure_ascii=False, indent=2)
    with _WRITE_LOCK:
        tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        try:
            tmp.write_text(payload, encoding="utf-8")
            for attempt in range(6):
                try:
                    os.replace(tmp, path)
                    break
                except PermissionError:
                    # Windows：目标正被读侧打开（或被杀软/索引器扫描）时会短暂拒绝替换，
                    # 退避重试即可；重试耗尽再抛，别把它吞掉。
                    if attempt == 5:
                        raise
                    time.sleep(0.02 * (attempt + 1))
        finally:
            if tmp.exists():
                with contextlib.suppress(OSError):
                    tmp.unlink()


def get_session(session_id: str) -> dict[str, Any] | None:
    path = _session_path(session_id)
    with _WRITE_LOCK:
        try:
            with path.open("r", encoding="utf-8") as fh:
                return json.load(fh)
        except (FileNotFoundError, OSError):
            return None


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
    with _WRITE_LOCK:  # 读改写整体串行：并发追加不会互相覆盖（丢消息）
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
    with _WRITE_LOCK:
        session = get_session(session_id)
        if session is None:
            return None
        session.update(fields)
        _write(session)
    return session


def drop_messages(session_id: str, indices: Iterable[int]) -> list[dict[str, Any]]:
    """按下标批量删除消息，返回被删掉的消息（调用方据此清理其附件文件）。

    闲聊编辑（从某条用户消息起截断）与删除整轮都走这里；下标越界项自然忽略。
    """
    drop = {int(index) for index in indices}
    if not drop:
        return []
    with _WRITE_LOCK:
        session = require_session(session_id)  # 锁内重读：避免拿旧快照算下标
        removed = [msg for index, msg in enumerate(session["messages"]) if index in drop]
        if not removed:
            return []
        session["messages"] = [
            msg for index, msg in enumerate(session["messages"]) if index not in drop
        ]
        _write(session)
    return removed


def truncate_messages(session_id: str, start_index: int) -> list[dict[str, Any]]:
    """从 start_index 起截断（含）后续全部消息，返回被删掉的消息——编辑重发的存储侧原语。"""
    with _WRITE_LOCK:
        session = require_session(session_id)
        total = len(session["messages"])
        if start_index < 0:
            start_index = 0
        if start_index >= total:
            return []
        return drop_messages(session_id, range(start_index, total))


def list_sessions() -> list[dict[str, Any]]:
    ensure_dirs()
    metas: list[dict[str, Any]] = []
    with _WRITE_LOCK:
        paths = list(SESSIONS_DIR.glob("*.json"))
    for path in paths:
        if path.name.startswith("."):  # 原子写的临时文件（保险起见）
            continue
        try:
            with _WRITE_LOCK:
                with path.open("r", encoding="utf-8") as fh:
                    s = json.load(fh)
        except (OSError, json.JSONDecodeError):
            # 单个会话文件坏掉（历史遗留/外部改动）不该让整个会话列表 500，跳过它
            continue
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
                "active": s.get("active"),
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
    with _WRITE_LOCK:
        session = require_session(session_id)
        session["title"] = title
        _write(session)
    return session
