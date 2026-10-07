"""评估/小结记录：front matter 解析、schema 校验、落盘与扫描。

schema 文件来自仓库根 schemas/*.schema.json（REPO_ROOT = BASE_DIR.parent.parent）。
"""
from __future__ import annotations

import json
import logging
import re
import threading
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

import yaml
from fastapi import HTTPException
from jsonschema import Draft7Validator

from . import curriculum_store as cs
from .config import SCHEMAS_DIR

logger = logging.getLogger(__name__)

SEQ_RE = re.compile(r"^(\d+)-")
_record_lock = threading.Lock()

# 分隔符行：兼容 --- 与 ... 的重复写法（---- / .....），只在格式修复时归一。
_DELIM_RE = re.compile(r"^\s*(?:-{3,}|\.{3,})\s*$")
_FENCE_LINE_RE = re.compile(r"^\s*```")
# 块标量头（key: | 或 key: >）：多行值里可能含结构性行，取快照不可靠，直接拒绝。
_BLOCK_SCALAR_RE = re.compile(r"[:：]\s*[|>][+-]?\s*$")


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


@dataclass(frozen=True)
class FrontMatterResult:
    """front matter 诊断结果：meta 为 None 时 stage/detail 说明失败原因。

    stage 取值：missing_leading_delimiter / missing_trailing_delimiter /
    yaml_error / not_mapping；成功时为 None。
    """

    meta: dict[str, Any] | None
    body: str
    stage: str | None = None
    detail: str = ""
    line: int | None = None
    column: int | None = None


def _yaml_location(exc: yaml.YAMLError) -> tuple[int | None, int | None]:
    mark = getattr(exc, "problem_mark", None) or getattr(exc, "context_mark", None)
    if mark is None:
        return None, None
    return mark.line + 1, mark.column + 1


def _yaml_reason(exc: yaml.YAMLError) -> str:
    """只取问题本身（不含整份 YAML 内容），并限长。"""
    problem = getattr(exc, "problem", None)
    if not problem:
        problem = str(exc).strip().splitlines()[0] if str(exc).strip() else "YAML 解析错误"
    context = getattr(exc, "context", None)
    text = f"{context}：{problem}" if context else str(problem)
    return text.strip()[:160]


def diagnose_front_matter(text: str) -> FrontMatterResult:
    """解析 `---` 分隔的 YAML front matter，失败时给出可区分的阶段诊断。

    与 parse_front_matter 同一套识别口径（先剥代码围栏、兼容 BOM），区别只在
    失败时不再一律返回 None，而是带 stage/detail/行列。
    """
    body = strip_code_fence((text or "").lstrip("\ufeff"))
    lines = body.splitlines()
    if not lines or lines[0].strip() != "---":
        return FrontMatterResult(None, body, "missing_leading_delimiter", "首行不是起始分隔符 ---")
    end = next((i for i in range(1, len(lines)) if lines[i].strip() in ("---", "...")), None)
    if end is None:
        return FrontMatterResult(None, body, "missing_trailing_delimiter", "有起始 --- 但缺少结束分隔符")
    front = "\n".join(lines[1:end])
    try:
        meta = yaml.safe_load(front)
    except yaml.YAMLError as exc:
        line, column = _yaml_location(exc)
        return FrontMatterResult(None, body, "yaml_error", _yaml_reason(exc), line, column)
    if not isinstance(meta, dict):
        kind = "空" if meta is None else type(meta).__name__
        return FrontMatterResult(None, body, "not_mapping", f"front matter 顶层不是 mapping（得到{kind}）")
    return FrontMatterResult(meta, "\n".join(lines[end + 1 :]))


def parse_front_matter(text: str) -> tuple[dict[str, Any] | None, str]:
    """兼容入口：解析 `---` 分隔的 YAML front matter；返回 (meta 或 None, 正文)。"""
    result = diagnose_front_matter(text)
    return result.meta, result.body


def repair_front_matter_local(text: str) -> tuple[str, str] | None:
    """确定性格式修复：只补/归一分隔符与围栏，绝不改动围栏内内容。

    返回 (修复后文本, 说明)；无法确定时返回 None（不瞎猜）。
    """
    body = strip_code_fence((text or "").lstrip("\ufeff"))
    lines = body.splitlines()
    if not lines:
        return None
    delim_idx = [i for i, line in enumerate(lines) if _DELIM_RE.match(line)]
    opens = bool(_DELIM_RE.match(lines[0]))
    if not opens and len(delim_idx) == 1 and delim_idx[0] > 0:
        head = "\n".join(lines[: delim_idx[0]])
        if _safe_mapping(head):
            return "---\n" + body.strip() + "\n", "补全起始分隔符"
    if opens and not any(i > 0 for i in delim_idx):
        inner = "\n".join(lines[1:])
        if _safe_mapping(inner):
            return "---\n" + inner.strip() + "\n---", "补全结束分隔符"
    if opens and len(delim_idx) >= 2:
        closing = delim_idx[-1]
        if _safe_mapping("\n".join(lines[1:closing])):
            normalized = ["---", *lines[1:closing], "---"]
            return "\n".join(normalized) + "\n", "归一化分隔符"
    return None


def _safe_mapping(fragment: str) -> bool:
    try:
        return isinstance(yaml.safe_load(fragment), dict)
    except yaml.YAMLError:
        return False


@dataclass(frozen=True)
class SemanticSnapshot:
    """原始（可能无法整体解析的）评估输出里可靠取回的语义快照。

    fields 为全部顶层键值，questions 为每题的字段集合（含未知键）；校验时要求
    修复结果与快照结构等价：键集合相同、题目数量与顺序相同、已有取值不得改变。
    """

    fields: dict[str, Any]
    questions: list[dict[str, Any]]


def parse_semantic_mapping(text: str) -> dict[str, Any] | None:
    """只做机械去噪（去围栏行、首尾分隔符行）后能整体 yaml.safe_load 成 mapping 才返回。

    不做任何字段级猜测：任何无法整体解析的原文一律返回 None，据此保守拒绝 LLM 修复。
    """
    body = strip_code_fence((text or "").lstrip("\ufeff"))
    lines = body.splitlines()
    if any(_BLOCK_SCALAR_RE.search(line) for line in lines):
        return None  # 多行值可能与分隔符/围栏行混淆，保守拒绝
    candidates: list[str] = ["\n".join(lines)]
    no_fence = [line for line in lines if not _FENCE_LINE_RE.match(line)]
    if no_fence != lines:
        candidates.append("\n".join(no_fence))
    for candidate in list(candidates):
        candidate_lines = candidate.splitlines()
        trimmed = list(candidate_lines)
        if trimmed and _DELIM_RE.match(trimmed[0]):
            trimmed = trimmed[1:]
        if trimmed and _DELIM_RE.match(trimmed[-1]):
            trimmed = trimmed[:-1]
        if trimmed != candidate_lines:
            candidates.append("\n".join(trimmed))
    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            data = yaml.safe_load(candidate)
        except yaml.YAMLError:
            continue
        if isinstance(data, dict):
            return data
    return None


def semantic_snapshot(mapping: dict[str, Any] | None) -> SemanticSnapshot | None:
    if not isinstance(mapping, dict):
        return None
    fields = dict(mapping)
    questions: list[dict[str, Any]] = []
    for question in mapping.get("questions") or []:
        if not isinstance(question, dict):
            return None
        questions.append(dict(question))
    return SemanticSnapshot(fields, questions)


def snapshot_reliable(snapshot: SemanticSnapshot | None) -> bool:
    """可靠锚的最低要求：能整体解析出映射，且结论、节点、日期与逐题判分要点齐全。

    缺任一项时不做 LLM 修复——无法证明修复没改判/没改证据，按「不确定拒绝保存」处理。
    """
    if snapshot is None:
        return False
    if not str(snapshot.fields.get("verdict") or "").strip():
        return False
    if not str(snapshot.fields.get("node") or "").strip():
        return False
    if not str(snapshot.fields.get("date") or "").strip():
        return False
    if not snapshot.questions:
        return False
    for question in snapshot.questions:
        if not str(question.get("q") or "").strip():
            return False
        if not str(question.get("verdict") or "").strip():
            return False
    return True


def _scalar_changed(raw: Any, repaired: Any) -> bool:
    """标量是否被改写。布尔与数值异型一律算改写（True≠1、False≠0），
    但 int/float 数值相等（1 与 1.0）放行。"""
    raw_bool = isinstance(raw, bool)
    repaired_bool = isinstance(repaired, bool)
    if raw_bool or repaired_bool:
        return not (raw_bool and repaired_bool and raw == repaired)
    return raw != repaired


def _diff_values(raw: Any, repaired: Any) -> list[str]:
    """比较两组值，返回差异描述；键集合、列表长度与顺序都算差异。"""
    if isinstance(raw, dict) and isinstance(repaired, dict):
        problems: list[str] = []
        for key, value in raw.items():
            if key not in repaired:
                problems.append(f"字段 {key} 被删除")
            else:
                problems.extend(f"{key}.{item}" for item in _diff_values(value, repaired[key]))
        for key in repaired:
            if key not in raw:
                problems.append(f"新增字段 {key}")
        return problems
    if isinstance(raw, list) and isinstance(repaired, list):
        if len(raw) != len(repaired):
            return [f"数量被改动（{len(raw)} -> {len(repaired)}）"]
        problems = []
        for index, (left, right) in enumerate(zip(raw, repaired), start=1):
            problems.extend(f"第 {index} 项 {item}" for item in _diff_values(left, right))
        return problems
    if _scalar_changed(raw, repaired):
        return [f"取值被改写（{raw!r} -> {repaired!r}）"]
    return []


def verify_snapshot(snapshot: SemanticSnapshot, meta: dict[str, Any]) -> list[str]:
    """校验修复结果与原文语义快照结构等价：不增删题目、不新增字段、不改已有取值。"""
    if not isinstance(meta, dict):
        return ["修复结果不是 mapping"]
    return _diff_values(snapshot.fields, meta)


def log_parse_failure(what: str, raw: str, result: FrontMatterResult) -> None:
    """诊断日志：只记阶段/长度/行列与原因，不回显原文内容（避免泄漏作答原文）。"""
    logger.warning(
        "%s解析失败 stage=%s len=%d line=%s column=%s detail=%s",
        what,
        result.stage,
        len(raw or ""),
        result.line,
        result.column,
        result.detail,
    )


def log_format_repair(what: str, kind: str, note: str = "") -> None:
    logger.info("%s已做%s格式修复 %s", what, "本地" if kind == "local" else "一次有限 LLM", note)


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
    with _record_lock:  # 与 write_learning_record/write_summary 同锁：并发评估不得抢同序号
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


def write_learning_record(
    slug: str,
    node_id: str,
    node_title: str,
    kind: str,
    assessment_rel: str,
) -> str:
    """学习记录：仅可观察证据时写（当前入口是评估通过），编号递增、不删旧条。"""
    with _record_lock:
        directory = cs.subject_dir(slug) / "learning-records"
        directory.mkdir(parents=True, exist_ok=True)
        seq = next_seq(directory)
        rel = f"learning-records/{seq:03d}-{node_id}.md"
        text = (
            "---\n"
            f'date: "{date.today().isoformat()}"\n'
            f"node: {node_id}\n"
            "---\n\n"
            f"# LR-{seq:03d} {kind}：{node_title}\n\n"
            f"依据：`{assessment_rel}`（verdict=通过，评估作答原文为可观察证据）。\n"
        )
        (cs.subject_dir(slug) / rel).write_text(text, encoding="utf-8")
        return rel


def write_summary(slug: str, meta: dict[str, Any]) -> str:
    with _record_lock:
        directory = cs.subject_dir(slug) / "sessions"
        directory.mkdir(parents=True, exist_ok=True)
        day = str(meta.get("date") or "")
        rel = f"sessions/{day}.md"
        path = cs.subject_dir(slug) / rel
        section_lines = ["## 本次要点", ""]
        section_lines.extend(f"- {item}" for item in meta.get("learned") or [])
        section_lines.extend(["", "## 卡在哪", ""])
        section_lines.extend(f"- {item}" for item in meta.get("weaknesses") or [])
        section_lines.extend(["", "## 下次从哪继续", "", str(meta.get("next_step") or "")])
        section = "\n".join(section_lines)
        if path.exists():
            stamp = datetime.now().strftime("%H:%M")
            existing = path.read_text(encoding="utf-8")
            path.write_text(
                existing.rstrip() + f"\n\n---\n\n## 本场摘要（{stamp}）\n\n{section}\n",
                encoding="utf-8",
            )
            return rel
        path.write_text(
            dump_front_matter(meta) + "\n# " + f"{day} 会话摘要\n\n{section}\n",
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
            except (OSError, UnicodeError):  # 非 UTF-8 记录不得让整表 500
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
            except (OSError, UnicodeError):  # 非 UTF-8 记录不得让整表 500
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
    learning_records: list[dict[str, Any]] = []
    lr_dir = base / "learning-records"
    if lr_dir.is_dir():
        for path in sorted(lr_dir.glob("*.md")):
            try:
                meta, _ = parse_front_matter(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError):  # 非 UTF-8 记录不得让整表 500
                continue
            if meta is None:
                continue
            learning_records.append(
                {
                    "file": f"learning-records/{path.name}",
                    "date": str(meta.get("date", "")),
                    "node": meta.get("node", ""),
                }
            )
    return {
        "assessments": assessments,
        "summaries": summaries,
        "learning_records": learning_records,
    }
