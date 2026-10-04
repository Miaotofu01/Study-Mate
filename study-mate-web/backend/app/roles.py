"""生产角色派工基建（§5.1 C 行 2026-10-03 拍板①③④）。

子代理 = 后端无工具单次 LLM 调用：system = 角色 SKILL.md 全文 + 派工适配
（prompts.inject_role），user = 派工值。多文件交付走 JSON envelope
{files:[{path,content}], data, report}，由本模块解析并逐字落盘到
`.stage/<角色>-<节点>/deliver/`，再由编排方搬正式位——一份产物只过作者之手。
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from . import audit
from . import prompts
from .llm import chat_once, extract_json

ENVELOPE_MISSING = "角色回复不是规定的 JSON envelope（缺 files/data/report 任一结构）"

# 打回归属：产物路径模式 → 角色（机械映射，§5.1 C 行拍板④；不实现第二份规则，
# 这里只把 learning-system「课件三份产物的归属」表翻译成路径模式）。
OWNERSHIP: list[tuple[str, str]] = [
    (r"lessons/[^/]*\.quiz\.json$", "出题"),
    (r"^lab/", "出题"),
    (r"lessons/.+\.md$", "讲解"),
    (r"^curriculum\.yaml$", "课设"),
]


def owner_of(rel_path: str) -> str:
    normal = rel_path.replace("\\", "/")
    for pattern, owner in OWNERSHIP:
        if re.search(pattern, normal):
            return owner
    return "总控"


def parse_envelope(text: str) -> dict[str, Any]:
    """解析角色回复的 JSON envelope；结构不合规抛 ValueError（编排方转为打回证据）。

    兼容一种真实模型行为：回复根对象**直接就是**产物 JSON（如大纲 {'nodes','edges'}），
    没有 envelope 外壳——归位到 `data` 键，等价于 files 为空的交付。
    """
    data = extract_json(text)
    if not isinstance(data, dict):
        raise ValueError(ENVELOPE_MISSING)
    files = data.get("files")
    if files is None and data.get("data") is None:
        if "nodes" in data or "edges" in data:
            return {"files": [], "data": data, "report": {}}
        raise ValueError(ENVELOPE_MISSING)
    if files is not None and not isinstance(files, list):
        raise ValueError(ENVELOPE_MISSING)
    return data


def envelope_files(envelope: dict[str, Any]) -> list[dict[str, str]]:
    """合规性检查后的文件清单：path 非空、content 是字符串；非法项抛 ValueError。"""
    files = envelope.get("files") or []
    cleaned: list[dict[str, str]] = []
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("envelope 的 files 数组里有非对象项")
        path = str(item.get("path") or "").strip()
        content = item.get("content")
        if not path or not isinstance(content, str):
            raise ValueError(f"envelope 文件项缺 path 或 content：{path!r}")
        if path.startswith("/") or ".." in Path(path).parts or Path(path).is_absolute():
            raise ValueError(f"envelope 文件路径越出科目目录：{path}")
        cleaned.append({"path": path, "content": content})
    return cleaned


def write_deliver(stage_dir: Path, files: list[dict[str, str]]) -> list[Path]:
    """逐字落 deliver/（.stage/<角色>-<节点>/deliver/<相对路径>），返回落盘绝对路径。"""
    written: list[Path] = []
    for item in files:
        target = stage_dir / "deliver" / item["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(item["content"], encoding="utf-8", newline="\n")
        written.append(target)
    return written


def promote_deliver(stage_dir: Path, base: Path, files: list[dict[str, str]]) -> list[str]:
    """deliver/ → 正式位（cp 原样搬），返回搬入的相对路径清单。"""
    deliver = stage_dir / "deliver"
    moved: list[str] = []
    for item in files:
        source = deliver / item["path"]
        target = base / item["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        moved.append(item["path"])
    return moved


def clear_stage(stage_dir: Path) -> None:
    shutil.rmtree(stage_dir, ignore_errors=True)


async def dispatch_role(
    provider: dict[str, Any],
    route: str,
    values: str,
    fixture_kind: str | None = None,
) -> dict[str, Any]:
    """派一次角色：注入全文 + 值，单次调用，返回解析后的 envelope。

    技能规范缺失 503；envelope 不合规抛 ValueError（带上游回复头部摘要，供打回）。
    """
    system_text, missing = prompts.inject_role(route)
    if missing:
        raise HTTPException(503, f"角色技能规范缺失：{'、'.join(missing)}")
    messages = [
        {"role": "system", "content": system_text},
        {"role": "user", "content": values},
    ]
    audit.record("dispatch", route=route, fixture_kind=fixture_kind, values=values)
    raw = await chat_once(provider, messages, json_mode=True, fixture_kind=fixture_kind)
    audit.record("dispatch_reply", route=route, raw=raw)
    try:
        return parse_envelope(raw)
    except ValueError as exc:
        head = (raw or "").strip()[:200]
        raise ValueError(f"{exc}；上游回复开头：{head}") from None
