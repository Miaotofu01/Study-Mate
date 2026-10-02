"""评估/小结记录：front matter 解析、schema 校验、落盘与扫描。

schema 文件来自仓库根 schemas/*.schema.json（REPO_ROOT = BASE_DIR.parent.parent）。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import yaml
from fastapi import HTTPException
from jsonschema import Draft7Validator

from . import curriculum_store as cs
from .config import SCHEMAS_DIR

SEQ_RE = re.compile(r"^(\d+)-")


def _load_schema(name: str) -> dict[str, Any]:
    path = SCHEMAS_DIR / f"{name}.schema.json"
    if not path.is_file():
        raise HTTPException(503, f"上游 schema 缺失：{path}")
    return json.loads(path.read_text(encoding="utf-8"))


def schema_problems(name: str, data: Any) -> list[str]:
    """按 schema 校验，返回问题清单（每条一处路径 + 消息）。"""
    validator = Draft7Validator(_load_schema(name))
    errors = sorted(validator.iter_errors(data), key=lambda err: list(err.path))
    return [
        ("/".join(str(part) for part in err.path) or "<root>") + ": " + err.message
        for err in errors
    ]


def strip_code_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 2 and lines[-1].strip().startswith("```"):
            stripped = "\n".join(lines[1:-1]).strip()
    return stripped


def parse_front_matter(text: str) -> tuple[dict[str, Any] | None, str]:
    """解析 `---` 分隔的 YAML front matter；返回 (meta 或 None, 正文)。"""
    body = strip_code_fence(text.lstrip("\ufeff"))
    lines = body.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, body
    end = next(
        (i for i in range(1, len(lines)) if lines[i].strip() in ("---", "...")),
        None,
    )
    if end is None:
        return None, body
    try:
        meta = yaml.safe_load("\n".join(lines[1:end]))
    except yaml.YAMLError:
        return None, body
    return (meta if isinstance(meta, dict) else None), "\n".join(lines[end + 1 :])


def dump_front_matter(meta: dict[str, Any]) -> str:
    return "---\n" + yaml.safe_dump(meta, allow_unicode=True, sort_keys=False) + "---\n"


def next_seq(directory: Path) -> int:
    highest = 0
    if directory.is_dir():
        for path in directory.iterdir():
            match = SEQ_RE.match(path.name)
            if match:
                highest = max(highest, int(match.group(1)))
    return highest + 1


def write_assessment(
    slug: str,
    node_id: str,
    meta: dict[str, Any],
    node_title: str,
    node_kind: str,
) -> str:
    directory = cs.subject_dir(slug) / "assessments"
    directory.mkdir(parents=True, exist_ok=True)
    seq = next_seq(directory)
    rel = f"assessments/{seq:03d}-{node_id}.md"
    lines = [
        f"# 评估记录 {seq:03d} · {node_title}",
        "",
        f"- 节点：`{node_id}`（{node_kind or '课型未知'}）",
        f"- 日期：{meta.get('date', '')}",
        f"- 结论：**{meta.get('verdict', '')}**，建议掌握度 {meta.get('mastery', '未给出')}",
        "",
    ]
    for i, question in enumerate(meta.get("questions") or [], start=1):
        lines.append(f"## 题 {i} · {question.get('kind') or '未标注'}")
        lines.append("")
        lines.append(str(question.get("q") or ""))
        lines.append("")
        lines.append(f"**作答**：{question.get('answer') or '（无作答记录）'}")
        lines.append("")
        lines.append(f"**结论**：{question.get('verdict', '')}。{question.get('note') or ''}")
        lines.append("")
    lines.append("## 下一步")
    lines.append("")
    lines.append(str(meta.get("next") or ""))
    (cs.subject_dir(slug) / rel).write_text(
        dump_front_matter(meta) + "\n" + "\n".join(lines),
        encoding="utf-8",
    )
    return rel


def write_summary(slug: str, meta: dict[str, Any]) -> str:
    directory = cs.subject_dir(slug) / "sessions"
    directory.mkdir(parents=True, exist_ok=True)
    day = str(meta.get("date") or "")
    rel = f"sessions/{day}.md"
    lines = [f"# {day} 会话摘要", "", "## 本次要点", ""]
    lines.extend(f"- {item}" for item in meta.get("learned") or [])
    lines.extend(["", "## 卡在哪", ""])
    lines.extend(f"- {item}" for item in meta.get("weaknesses") or [])
    lines.extend(["", "## 下次从哪继续", "", str(meta.get("next_step") or "")])
    (cs.subject_dir(slug) / rel).write_text(
        dump_front_matter(meta) + "\n" + "\n".join(lines),
        encoding="utf-8",
    )
    return rel


def list_records(slug: str) -> dict[str, list[dict[str, Any]]]:
    base = cs.subject_dir(slug)
    assessments: list[dict[str, Any]] = []
    assessments_dir = base / "assessments"
    if assessments_dir.is_dir():
        for path in sorted(assessments_dir.glob("*.md")):
            try:
                meta, _ = parse_front_matter(path.read_text(encoding="utf-8"))
            except OSError:
                continue
            if meta is None:
                continue
            assessments.append(
                {
                    "file": f"assessments/{path.name}",
                    "node": meta.get("node", ""),
                    "date": str(meta.get("date", "")),
                    "verdict": meta.get("verdict", ""),
                }
            )
    summaries: list[dict[str, Any]] = []
    sessions_dir = base / "sessions"
    if sessions_dir.is_dir():
        for path in sorted(sessions_dir.glob("*.md")):
            try:
                meta, _ = parse_front_matter(path.read_text(encoding="utf-8"))
            except OSError:
                continue
            if meta is None:
                continue
            summaries.append(
                {
                    "file": f"sessions/{path.name}",
                    "date": str(meta.get("date", "")),
                    "subject": meta.get("subject", ""),
                }
            )
    return {"assessments": assessments, "summaries": summaries}
