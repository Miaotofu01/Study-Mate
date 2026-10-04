"""课程仓储层：<workspace>/.learning/subjects/<slug>/{subject,curriculum,progress}.yaml。

工作区与插件 `.learning` 布局同构，发现规则见 app/workspace.py（复用上游 learn_workspace()）。
"""
from __future__ import annotations

import re
import shutil
import uuid
from datetime import date
from pathlib import Path
from typing import Any

import yaml

from . import workspace_ctx

NODE_STATUSES = [
    "未开始",
    "学习中",
    "初步理解",
    "能独立应用",
    "需要复习",
    "已通过项目验证",
]
KINDS = ["概念", "实操", "实验"]
SUBJECT_STATUSES = ["进行中", "暂停", "已完成"]
IMPORTANCES = ["low", "medium", "high"]
LAB_STATUSES = ["待生成", "待提交", "待评估", "已通过"]
VERDICTS = ["通过", "部分通过", "不通过"]
NODE_ID_RE = re.compile(r"^[a-z0-9]+([.-][a-z0-9]+)*$")
SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

TRANSITIONS: dict[str, list[str]] = {
    "未开始": ["学习中"],
    "学习中": ["初步理解", "需要复习"],
    "初步理解": ["能独立应用", "需要复习"],
    "能独立应用": ["已通过项目验证", "需要复习"],
    "已通过项目验证": ["需要复习"],
    "需要复习": ["学习中"],
}
DONE_STATUSES = {"能独立应用", "已通过项目验证"}

def workspace_dir() -> Path:
    # 会话级上下文收口点：bundle 了 ContextVar 绑定就用它，否则回到全局发现
    return workspace_ctx.resolve()


def subjects_dir() -> Path:
    return workspace_dir() / ".learning" / "subjects"


def subject_dir(slug: str) -> Path:
    return subjects_dir() / slug


def _yaml_path(slug: str, name: str) -> Path:
    return subject_dir(slug) / name


def _read_yaml(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    return data if isinstance(data, dict) else None


def _write_yaml(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        yaml.safe_dump(data, fh, allow_unicode=True, sort_keys=False)


def ensure_workspace() -> None:
    # 只建目录，不种入示例：默认工作区与插件共用，不往插件在用的目录塞示例数据
    subjects_dir().mkdir(parents=True, exist_ok=True)


def is_valid_slug(slug: str) -> bool:
    return bool(SLUG_RE.match(slug))


def generate_slug(name: str) -> str:
    return _generate_slug(name)


def _generate_slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or f"subject-{uuid.uuid4().hex[:6]}"


def effective_node(
    curriculum_node: dict[str, Any],
    progress_entry: dict[str, Any] | None,
    index: int,
    transitions: dict[str, list[str]],
) -> dict[str, Any]:
    entry = progress_entry or {}
    status = entry.get("status") or curriculum_node.get("status") or "未开始"
    mastery = entry.get("mastery")
    if mastery is None:
        mastery = curriculum_node.get("mastery")
    if not isinstance(mastery, (int, float)) or isinstance(mastery, bool):
        mastery = 0
    notes = entry.get("notes")
    if notes is None:
        notes = curriculum_node.get("notes", "")
    return {
        "id": curriculum_node.get("id", ""),
        "title": curriculum_node.get("title", ""),
        "kind": curriculum_node.get("kind", ""),
        "objective": curriculum_node.get("objective", ""),
        "problem": curriculum_node.get("problem", ""),
        "prerequisites": list(curriculum_node.get("prerequisites") or []),
        "concepts": list(curriculum_node.get("concepts") or []),
        "resources": list(curriculum_node.get("resources") or []),
        "practice": curriculum_node.get("practice", ""),
        "pitfalls": list(curriculum_node.get("pitfalls") or []),
        "realworld": curriculum_node.get("realworld", ""),
        "status": status,
        "mastery": round(float(mastery), 2),
        "notes": notes or "",
        "lab_status": entry.get("lab_status"),
        "index": index,
        "next_statuses": list(transitions.get(status, [])),
    }


def get_subject(slug: str) -> dict[str, Any] | None:
    data = _read_yaml(_yaml_path(slug, "subject.yaml"))
    if data is None:
        return None
    data.setdefault("slug", slug)
    return data


def save_subject(slug: str, data: dict[str, Any]) -> None:
    _write_yaml(_yaml_path(slug, "subject.yaml"), data)


def get_curriculum(slug: str) -> dict[str, Any] | None:
    return _read_yaml(_yaml_path(slug, "curriculum.yaml"))


def get_progress(slug: str) -> dict[str, Any]:
    data = _read_yaml(_yaml_path(slug, "progress.yaml"))
    if data is None:
        return {"updated_at": "", "nodes": {}, "misconceptions": [], "project": {"current": ""}}
    data.setdefault("updated_at", "")
    data.setdefault("nodes", {})
    data.setdefault("misconceptions", [])
    data.setdefault("project", {"current": ""})
    return data


def save_curriculum(slug: str, data: dict[str, Any]) -> None:
    problems = validate_curriculum(data)
    if problems:
        raise ValueError(problems)
    _write_yaml(_yaml_path(slug, "curriculum.yaml"), data)


def save_progress(slug: str, data: dict[str, Any]) -> None:
    payload = dict(data)
    payload["updated_at"] = date.today().isoformat()
    _write_yaml(_yaml_path(slug, "progress.yaml"), payload)


def validate_curriculum(data: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    nodes = data.get("nodes")
    if not isinstance(nodes, list):
        return ["nodes 必须是数组"]

    ids: set[str] = set()
    for i, node in enumerate(nodes):
        if not isinstance(node, dict):
            problems.append(f"第 {i + 1} 个节点不是对象")
            continue
        node_id = node.get("id")
        if not isinstance(node_id, str) or not NODE_ID_RE.match(node_id):
            problems.append(f"第 {i + 1} 个节点 id 非法：{node_id!r}")
            continue
        if node_id in ids:
            problems.append(f"节点 id 重复：{node_id}")
        ids.add(node_id)
        title = node.get("title")
        if not isinstance(title, str) or not title.strip():
            problems.append(f"节点 {node_id} 缺少 title")
        kind = node.get("kind")
        if kind is not None and kind not in KINDS:
            problems.append(f"节点 {node_id} 的 kind 非法：{kind!r}")
        status = node.get("status")
        if status is not None and status not in NODE_STATUSES:
            problems.append(f"节点 {node_id} 的 status 非法：{status!r}")
        mastery = node.get("mastery")
        if mastery is not None and (
            not isinstance(mastery, (int, float))
            or isinstance(mastery, bool)
            or not 0 <= mastery <= 1
        ):
            problems.append(f"节点 {node_id} 的 mastery 必须是 0~1 的数字")

    for i, node in enumerate(nodes):
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        prerequisites = node.get("prerequisites") or []
        if not isinstance(prerequisites, list):
            problems.append(f"节点 {node_id} 的 prerequisites 必须是数组")
            continue
        for prerequisite in prerequisites:
            if prerequisite not in ids:
                problems.append(f"节点 {node_id} 的前置节点不存在：{prerequisite!r}")

    edges = data.get("edges")
    if not isinstance(edges, list):
        problems.append("edges 必须是数组")
        return problems
    for i, edge in enumerate(edges):
        if not isinstance(edge, dict):
            problems.append(f"第 {i + 1} 条边不是对象")
            continue
        for key in ("from", "to"):
            value = edge.get(key)
            if value not in ids:
                problems.append(f"第 {i + 1} 条边的 {key} 引用了不存在的节点：{value!r}")
    return problems


def subject_summary(slug: str) -> dict[str, Any] | None:
    subject = get_subject(slug)
    if subject is None:
        return None
    curriculum = get_curriculum(slug) or {}
    entries = get_progress(slug).get("nodes") or {}
    nodes = curriculum.get("nodes") or []
    views = [
        effective_node(node, entries.get(node.get("id")), i + 1, TRANSITIONS)
        for i, node in enumerate(nodes)
        if isinstance(node, dict)
    ]
    total = len(views)
    done = sum(1 for view in views if view["status"] in DONE_STATUSES)
    average = round(sum(view["mastery"] for view in views) / total, 2) if total else 0
    return {
        "slug": subject.get("slug") or slug,
        "name": subject.get("name", ""),
        "goal": subject.get("goal", ""),
        "status": subject.get("status", ""),
        "created_at": subject.get("created_at", ""),
        "node_total": total,
        "node_done": done,
        "avg_mastery": average,
    }


def list_subjects() -> list[dict[str, Any]]:
    subjects = subjects_dir()
    if not subjects.exists():
        return []
    summaries: list[dict[str, Any]] = []
    for child in sorted(subjects.iterdir()):
        if not child.is_dir():
            continue
        summary = subject_summary(child.name)
        if summary is not None:
            summaries.append(summary)
    return summaries


def create_subject(name: str, slug: str | None = None, goal: str = "") -> dict[str, Any] | None:
    resolved = slug or _generate_slug(name)
    if subject_dir(resolved).exists():
        return None
    subject_dir(resolved).mkdir(parents=True, exist_ok=True)
    save_subject(
        resolved,
        {
            "name": name,
            "slug": resolved,
            "goal": goal,
            "created_at": date.today().isoformat(),
            "status": "进行中",
        },
    )
    save_curriculum(resolved, {"nodes": [], "edges": []})
    save_progress(resolved, {"nodes": {}, "misconceptions": [], "project": {"current": ""}})
    return subject_summary(resolved)


def update_subject(
    slug: str,
    name: str | None = None,
    goal: str | None = None,
    status: str | None = None,
) -> dict[str, Any] | None:
    subject = get_subject(slug)
    if subject is None:
        return None
    if name is not None:
        subject["name"] = name
    if goal is not None:
        subject["goal"] = goal
    if status is not None:
        subject["status"] = status
    save_subject(slug, subject)
    return subject_summary(slug)


def delete_subject(slug: str) -> bool:
    directory = subject_dir(slug)
    if not directory.exists():
        return False
    shutil.rmtree(directory)
    return True
