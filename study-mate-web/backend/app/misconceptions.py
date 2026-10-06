"""误解本存储：misconceptions.yaml 与 progress.misconceptions 双落点同步。

misconceptions.yaml 是顶层 YAML list，最近一条在最前；progress.misconceptions
保持同序、字段逐字一致。旧条目缺 id 时补 uuid4 前 8 位并回写两个落点（幂等）。
"""
from __future__ import annotations

import contextlib
import os
import threading
import uuid
from datetime import date
from pathlib import Path
from typing import Any

import yaml

from . import curriculum_store as cs

REQUIRED_FIELDS = ("topic", "question", "misunderstanding", "answer_summary")
EDITABLE_FIELDS = (
    "topic",
    "question",
    "misunderstanding",
    "answer_summary",
    "follow_up",
    "importance",
    "node",
)

# 误解本与 progress.misconceptions 是两个落点，读改写必须整体串行（否则并发写各读
# 一份旧列表、后写覆盖先写；旧条目补 id 的回写也会互相盖）。进度侧再进
# curriculum_store 的 progress_transaction，两个落点与其它进度写者一并串行。
_lock = threading.RLock()


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            with contextlib.suppress(OSError):
                tmp.unlink()


def _file_path(slug: str) -> Path:
    return cs.subject_dir(slug) / "misconceptions.yaml"


def _read_file(slug: str) -> list[dict[str, Any]] | None:
    path = _file_path(slug)
    if not path.is_file():
        return None
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, yaml.YAMLError):
        return None
    return data if isinstance(data, list) else []


def _write_file(slug: str, items: list[dict[str, Any]]) -> None:
    path = _file_path(slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(path, yaml.safe_dump(items, allow_unicode=True, sort_keys=False))


def _sync(slug: str, items: list[dict[str, Any]]) -> None:
    """两处落点一次写齐：文件与 progress.misconceptions 用同一份列表。"""
    _write_file(slug, items)
    with cs.progress_transaction(slug) as progress:
        progress["misconceptions"] = items


def canonical_items(slug: str) -> list[dict[str, Any]]:
    """规范条目列表：misconceptions.yaml 优先；缺文件时从 progress 迁移。"""
    with _lock:
        file_items = _read_file(slug)
        if file_items is not None:
            items = [item for item in file_items if isinstance(item, dict)]
        else:
            items = [
                item
                for item in cs.get_progress(slug).get("misconceptions") or []
                if isinstance(item, dict)
            ]
        changed = False
        for item in items:
            if not item.get("id"):
                item["id"] = uuid.uuid4().hex[:8]
                changed = True
        if changed:
            _sync(slug, items)
        return items


def _find(items: list[dict[str, Any]], item_id: str) -> dict[str, Any] | None:
    return next((item for item in items if item.get("id") == item_id), None)


def list_items(
    slug: str,
    importance: str | None = None,
    node_id: str | None = None,
) -> list[dict[str, Any]]:
    items = canonical_items(slug)
    if importance is not None:
        items = [item for item in items if item.get("importance") == importance]
    if node_id is not None:
        items = [item for item in items if item.get("node") == node_id]
    return items


def create_item(slug: str, fields: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        items = canonical_items(slug)
        item: dict[str, Any] = {
            "id": uuid.uuid4().hex[:8],
            "date": fields["date"],
            "node": fields.get("node"),
            "topic": fields["topic"],
            "question": fields["question"],
            "misunderstanding": fields["misunderstanding"],
            "answer_summary": fields["answer_summary"],
            "follow_up": fields.get("follow_up"),
            "importance": fields.get("importance") or "medium",
        }
        items.insert(0, item)
        _sync(slug, items)
        return item


def update_item(slug: str, item_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    with _lock:
        items = canonical_items(slug)
        item = _find(items, item_id)
        if item is None:
            return None
        for key in EDITABLE_FIELDS:
            if key in patch:
                item[key] = patch[key]
        _sync(slug, items)
        return item


def delete_item(slug: str, item_id: str) -> bool:
    with _lock:
        items = canonical_items(slug)
        item = _find(items, item_id)
        if item is None:
            return False
        items.remove(item)
        _sync(slug, items)
        return True


def add_from_assessment(
    slug: str,
    node_id: str,
    questions: list[dict[str, Any]],
    follow_up: str | None,
) -> list[dict[str, Any]]:
    """把评估里没过的题落成误解条目：只有 verdict 为部分通过/不通过的题才落，全通过不落。

    每条对应一道未通过的题，字段都指向学生实际答错的证据：
    topic 取该题自带的简短误解点（缺省回退题面），question 取题面，
    misunderstanding 取学生作答原文（没作答写「会话中未作答」），
    answer_summary 取该题判分注记里缺的要点。topic 与已有条目重复的跳过。
    """
    created: list[dict[str, Any]] = []
    with _lock:
        items = canonical_items(slug)
        existing = {str(item.get("topic") or "") for item in items}
        for question in questions:
            if not isinstance(question, dict):
                continue
            if str(question.get("verdict") or "").strip() not in ("部分通过", "不通过"):
                continue
            q_text = str(question.get("q") or "").strip()
            topic = str(question.get("topic") or "").strip() or q_text
            if not topic or topic in existing:
                continue
            existing.add(topic)
            answer = str(question.get("answer") or "").strip()
            note = str(question.get("note") or "").strip()
            item: dict[str, Any] = {
                "id": uuid.uuid4().hex[:8],
                "date": date.today().isoformat(),
                "node": node_id,
                "topic": topic,
                "question": q_text,
                "misunderstanding": answer or "会话中未作答",
                "answer_summary": note or "（评估未给出答案要点）",
                "follow_up": follow_up or None,
                "importance": "medium",
            }
            created.append(item)
        if created:
            # 同一批按题目顺序整段前插，最近一次评估的条目在前
            items[:0] = created
            _sync(slug, items)
    return created
