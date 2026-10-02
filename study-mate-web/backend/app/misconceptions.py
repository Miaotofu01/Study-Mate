"""误解本存储：misconceptions.yaml 与 progress.misconceptions 双落点同步。

misconceptions.yaml 是顶层 YAML list，最近一条在最前；progress.misconceptions
保持同序、字段逐字一致。旧条目缺 id 时补 uuid4 前 8 位并回写两个落点（幂等）。
"""
from __future__ import annotations

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


def _file_path(slug: str) -> Path:
    return cs.subject_dir(slug) / "misconceptions.yaml"


def _read_file(slug: str) -> list[dict[str, Any]] | None:
    path = _file_path(slug)
    if not path.is_file():
        return None
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return None
    return data if isinstance(data, list) else []


def _write_file(slug: str, items: list[dict[str, Any]]) -> None:
    path = _file_path(slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        yaml.safe_dump(items, fh, allow_unicode=True, sort_keys=False)


def _sync(slug: str, items: list[dict[str, Any]]) -> None:
    """两处落点一次写齐：文件与 progress.misconceptions 用同一份列表。"""
    _write_file(slug, items)
    progress = cs.get_progress(slug)
    progress["misconceptions"] = items
    cs.save_progress(slug, progress)


def canonical_items(slug: str) -> list[dict[str, Any]]:
    """规范条目列表：misconceptions.yaml 优先；缺文件时从 progress 迁移。"""
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
    topics: list[str],
    questions: list[dict[str, Any]],
    follow_up: str | None,
) -> list[dict[str, Any]]:
    """评估产出的误解按条目写入双落点；topic 与已有条目重复的跳过。

    topic 逐字取自 assessment.misconceptions；其余字段从对应 question 上下文取
    （misunderstanding 用 note，answer_summary 用作答原文，缺了用 note/topic 兜底），
    importance 默认 medium。
    """
    created: list[dict[str, Any]] = []
    if not topics:
        return created
    items = canonical_items(slug)
    existing = {str(item.get("topic") or "") for item in items}
    question_index = 0
    for topic in topics:
        topic = str(topic).strip()
        if not topic or topic in existing:
            continue
        existing.add(topic)
        question = questions[min(question_index, len(questions) - 1)] if questions else {}
        question_index += 1
        note = str(question.get("note") or "")
        answer = str(question.get("answer") or "")
        item: dict[str, Any] = {
            "id": uuid.uuid4().hex[:8],
            "date": date.today().isoformat(),
            "node": node_id,
            "topic": topic,
            "question": str(question.get("q") or topic),
            "misunderstanding": note or topic,
            "answer_summary": answer or note or topic,
            "follow_up": follow_up or None,
            "importance": "medium",
        }
        items.insert(0, item)
        created.append(item)
    if created:
        _sync(slug, items)
    return created
