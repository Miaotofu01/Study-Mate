"""跨科目共享记忆（<WS>/.learning/MEMORY.md）。

读侧供开场切片与展示；写侧只在用户逐条确认后增量插入分节（不整篇重写），
分节与模板 templates/MEMORY.md 一致。
"""
from __future__ import annotations

import contextlib
import os
import re
import threading
import uuid
from pathlib import Path

from . import curriculum_store as cs
from .config import REPO_ROOT

MEMORY_FILENAME = "MEMORY.md"
TEMPLATE_PATH = REPO_ROOT / "templates" / "MEMORY.md"
SECTIONS = ["我是谁", "教学偏好", "学习习惯", "跨科目观察"]
_SECTION_RE = re.compile(r"^##\s+(.+?)\s*$")
_write_lock = threading.Lock()


def _atomic_write(path: Path, text: str) -> None:
    """临时文件 + os.replace：读者永远看到完整快照，不会撞上写了一半的 MEMORY.md。"""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            with contextlib.suppress(OSError):
                tmp.unlink()


def memory_path() -> Path:
    return cs.workspace_dir() / ".learning" / MEMORY_FILENAME


def read_memory() -> str | None:
    path = memory_path()
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8")


def append_entries(entries: list[dict[str, str]]) -> tuple[Path, int]:
    with _write_lock:
        path = memory_path()
        if path.exists():
            lines = path.read_text(encoding="utf-8").splitlines()
        elif TEMPLATE_PATH.is_file():
            lines = TEMPLATE_PATH.read_text(encoding="utf-8").splitlines()
        else:
            lines = ["# 学习者记忆", ""]
        written = 0
        for entry in entries:
            section = str(entry.get("section") or "").strip()
            content = str(entry.get("content") or "").strip()
            if not section or not content:
                continue
            lines, inserted = _insert(lines, section, content)
            written += 1 if inserted else 0
        path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(path, "\n".join(lines).rstrip() + "\n")
        return path, written


def _insert(lines: list[str], section: str, content: str) -> tuple[list[str], bool]:
    item = f"- {content}"
    heading = next(
        (
            i
            for i, line in enumerate(lines)
            if (match := _SECTION_RE.match(line)) and match.group(1) == section
        ),
        None,
    )
    if heading is None:
        return lines + ["", f"## {section}", "", item], True
    end = next(
        (i for i in range(heading + 1, len(lines)) if _SECTION_RE.match(lines[i])),
        len(lines),
    )
    if item in lines[heading:end]:
        return lines, False
    insert_at = end
    while insert_at > heading + 1 and not lines[insert_at - 1].strip():
        insert_at -= 1
    return lines[:insert_at] + [item, ""] + lines[insert_at:], True
