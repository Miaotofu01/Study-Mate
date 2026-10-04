"""质检工单：生产链打回重试耗尽后的转人工载体（§5.1 C 行 2026-10-03 拍板④）。

工单持久化在 data/tickets.json（与 sessions 同层的文件存储），按科目维度
挂角标；收口三态：重试通过/重新检查通过 → 已解决，放弃 → 已放弃。
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .config import DATA_DIR

TICKETS_PATH = DATA_DIR / "tickets.json"

STATUSES = ("待处理", "重试中", "已解决", "已放弃")
MAX_RETRIES = 2

_lock = threading.Lock()


def _load() -> list[dict[str, Any]]:
    if not TICKETS_PATH.is_file():
        return []
    try:
        data = json.loads(TICKETS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def _save(tickets: list[dict[str, Any]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    TICKETS_PATH.write_text(
        json.dumps(tickets, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def create_ticket(
    kind: str,
    slug: str,
    node_id: str | None,
    base_label: str,
    problems: list[dict[str, str]],
    artifacts: list[str],
) -> dict[str, Any]:
    """建工单。problems 每项 {owner, path, line, message}；artifacts 是产物相对路径清单。"""
    now = time.time()
    ticket = {
        "id": uuid.uuid4().hex[:12],
        "kind": kind,
        "slug": slug,
        "node_id": node_id,
        "base_label": base_label,
        "problems": problems,
        "artifacts": artifacts,
        "retries": 0,
        "status": "待处理",
        "created_at": now,
        "updated_at": now,
    }
    with _lock:
        tickets = _load()
        tickets.append(ticket)
        _save(tickets)
    return ticket


def get_ticket(ticket_id: str) -> dict[str, Any] | None:
    with _lock:
        return next((t for t in _load() if t.get("id") == ticket_id), None)


def update_ticket(ticket_id: str, **fields: Any) -> dict[str, Any] | None:
    with _lock:
        tickets = _load()
        ticket = next((t for t in tickets if t.get("id") == ticket_id), None)
        if ticket is None:
            return None
        ticket.update(fields)
        ticket["updated_at"] = time.time()
        _save(tickets)
        return ticket


def list_tickets(slug: str | None = None, open_only: bool = False) -> list[dict[str, Any]]:
    with _lock:
        tickets = _load()
    if slug is not None:
        tickets = [t for t in tickets if t.get("slug") == slug]
    if open_only:
        tickets = [t for t in tickets if t.get("status") in ("待处理", "重试中")]
    return sorted(tickets, key=lambda t: t.get("created_at", 0), reverse=True)


def grouped_problems(ticket: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
    """报错按归属分组（讲解/出题/总控）；分组由 orchestrate 落盘时按路径模式写好。"""
    groups: dict[str, list[dict[str, str]]] = {}
    for problem in ticket.get("problems") or []:
        owner = str(problem.get("owner") or "总控")
        groups.setdefault(owner, []).append(problem)
    return groups


def ticket_dir_base(ticket: dict[str, Any]) -> Path:
    """工单对应的科目基目录：草稿区或工作区。"""
    from . import draft as draft_svc
    from . import curriculum_store as cs

    if ticket.get("base_label") == "draft":
        return draft_svc.draft_dir(str(ticket["slug"]))
    return cs.subject_dir(str(ticket["slug"]))
