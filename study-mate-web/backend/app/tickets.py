"""质检工单：生产链打回重试耗尽后的转人工载体（§5.1 C 行 2026-10-03 拍板④）。

工单持久化在 data/tickets.json（与 sessions 同层的文件存储），按科目维度
挂角标；收口三态：重试通过/重新检查通过 → 已解决，放弃 → 已放弃。
"""
from __future__ import annotations

import contextlib
import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .config import DATA_DIR

TICKETS_PATH = DATA_DIR / "tickets.json"

STATUSES = ("待处理", "重试中", "已解决", "已放弃")
MAX_RETRIES = 2

# 读改写（load→append/update→save）整体串行：两个并发写者各读旧内容后写会丢工单。
_lock = threading.RLock()


def _quarantine() -> None:
    """坏文件改名留证：绝不静默删除或在下一次 _save 时覆盖掉工单证据。"""
    try:
        corrupt = TICKETS_PATH.with_name(f"{TICKETS_PATH.name}.corrupt-{int(time.time())}")
        TICKETS_PATH.replace(corrupt)
    except OSError:
        pass


def _load() -> list[dict[str, Any]]:
    if not TICKETS_PATH.is_file():
        return []
    try:
        data = json.loads(TICKETS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        _quarantine()
        return []
    return data if isinstance(data, list) else []


def _save(tickets: list[dict[str, Any]]) -> None:
    """原子落盘：临时文件 + os.replace（读侧永远看到完整快照，崩溃不产生半截 JSON）。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(tickets, ensure_ascii=False, indent=2)
    tmp = TICKETS_PATH.with_name(f".{TICKETS_PATH.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        tmp.write_text(payload, encoding="utf-8")
        for attempt in range(6):
            try:
                os.replace(tmp, TICKETS_PATH)
                break
            except PermissionError:
                # Windows：读侧/索引器短暂占用目标文件，退避重试；耗尽再抛，绝不吞
                if attempt == 5:
                    raise
                time.sleep(0.02 * (attempt + 1))
    finally:
        if tmp.exists():
            with contextlib.suppress(OSError):
                tmp.unlink()


def create_ticket(
    kind: str,
    slug: str,
    node_id: str | None,
    base_label: str,
    problems: list[dict[str, str]],
    artifacts: list[str],
    workspace: str | None = None,
) -> dict[str, Any]:
    """建工单。problems 每项 {owner, path, line, message}；artifacts 是产物相对路径清单。

    workspace 是工单真实归属的工作区（绝对路径）；同名科目跨工作区不串单的根据。
    草稿期建课工单也记所属工作区，供按工作区过滤/展示。
    """
    now = time.time()
    ticket = {
        "id": uuid.uuid4().hex[:12],
        "kind": kind,
        "slug": slug,
        "node_id": node_id,
        "base_label": base_label,
        "problems": problems,
        "artifacts": artifacts,
        "workspace": str(workspace) if workspace else None,
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


def ticket_workspace(ticket: dict[str, Any]) -> str | None:
    """工单记录的真实归属工作区（绝对路径字符串）；旧工单没有该字段时为 None。"""
    value = ticket.get("workspace")
    return str(value) if value else None


def matches_workspace(ticket: dict[str, Any], workspace: str | None) -> bool:
    """工单是否属于该工作区（列表过滤，避免同名跨工作区串单）。

    - 有归属：解析后路径相等才算。
    - 旧草稿工单（base_label=draft 且无归属）：草稿区是全局的，任何工作区 scope 下
      都可见可操作，但绝不当成某工作区的 subject 去改。
    - 其余缺 workspace 的旧单：一律 ambiguous（即便默认区有同 slug 也不能证明归属），
      不在按工作区过滤的列表里出现，须经显式认领流程确认归属后才有 belongs。
    """
    if workspace is None:
        return True
    return ticket_ownership(ticket, workspace) in ("owned", "legacy_draft")


def ticket_ownership(ticket: dict[str, Any], workspace: str) -> str:
    """归属判定：owned / other / legacy_draft / ambiguous（legacy_default 为历史值，不再产出）。

    legacy 单凭记录无法证明归属时返回 ambiguous——调用方必须阻断写入（409），
    不得按当前请求 workspace 认领去改另一边同名科目；即便默认工作区存在同名科目，
    也不能凭此证明归属（已授权显式确认流程，故不保留 legacy_default 自动认领）。
    """
    stored = ticket_workspace(ticket)
    if stored:
        return "owned" if _same_path(stored, workspace) else "other"
    if ticket.get("base_label") == "draft":
        return "legacy_draft"
    return "ambiguous"


def _same_path(left: str | Path, right: str | Path) -> bool:
    try:
        return Path(left).resolve() == Path(right).resolve()
    except OSError:
        return False


def ticket_dir_base(ticket: dict[str, Any]) -> Path:
    """工单对应的科目基目录：优先按工单记录的真实归属工作区解析（不看请求绑定）。

    调用方必须先确认归属非 ambiguous（详情对 ambiguous 给 base_dir=None、写入端点
    一律 409）；此函数对缺归属的非草稿单回落到当前绑定，仅作旧调用方的最后兜底。
    """
    from . import draft as draft_svc
    from . import curriculum_store as cs

    slug = str(ticket["slug"])
    if ticket.get("base_label") == "draft":
        return draft_svc.draft_dir(slug)
    stored = ticket_workspace(ticket)
    if stored:
        if not cs.is_valid_slug(slug):
            raise ValueError(f"slug 格式非法：{slug}")
        return Path(stored) / ".learning" / "subjects" / slug
    return cs.subject_dir(slug)
