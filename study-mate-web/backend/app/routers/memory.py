"""记忆写侧：会话结束/评估通过后组 memory_updates 建议，用户逐条确认后写 MEMORY.md。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import memory as memory_svc
from .. import prompts
from .. import storage
from .. import workspace_ctx
from ..common import require_provider
from ..llm import chat_once, extract_json
from .records import _format_messages

router = APIRouter(prefix="/api/memory", tags=["memory"])

SUGGEST_SYSTEM_PROMPT = (
    "你是 StudyMate 的共享记忆管家。从学习会话里提炼值得长期记住的教学备注，"
    "只记跨科目、跨会话仍成立的东西（偏好、习惯、水平、稳定的观察）；"
    "知识点细节与一次性事件不记。每条一句话。"
)


class MemoryEntry(BaseModel):
    section: str
    content: str


class MemoryConfirmRequest(BaseModel):
    """逐条确认写入 MEMORY.md。session_id 可选：给了就写到该会话绑定的工作区。"""

    entries: list[MemoryEntry]
    session_id: str | None = None


class MemorySuggestRequest(BaseModel):
    session_id: str


@router.get("")
def get_memory() -> dict[str, Any]:
    return {
        "path": str(memory_svc.memory_path()),
        "exists": memory_svc.memory_path().is_file(),
        "content": memory_svc.read_memory(),
        "sections": memory_svc.SECTIONS,
    }


@router.post("/suggest")
async def suggest_updates(payload: MemorySuggestRequest) -> dict[str, Any]:
    session = storage.get_session(payload.session_id)
    if session is None:
        raise HTTPException(404, f"会话不存在：{payload.session_id}")
    if not (session.get("messages") or []):
        raise HTTPException(422, "会话没有消息，无可提炼的记忆建议")
    # 会话级工作区：建议链路（课程切片/读课工具）要落到该会话绑定的工作区
    with workspace_ctx.bind(session.get("workspace")):
        return await _suggest_updates(session)


async def _suggest_updates(session: dict[str, Any]) -> dict[str, Any]:
    provider = require_provider()
    skill_text, missing_skills = prompts.inject("summary")
    if missing_skills:
        raise HTTPException(503, f"技能规范缺失，无法保证记忆口径：{'、'.join(missing_skills)}")
    sections = "、".join(memory_svc.SECTIONS)
    user_lines = [
        f"【会话标题】{session.get('title', '')}",
        "【会话记录】",
        _format_messages(session.get("messages") or []),
        "",
        "请输出值得写进共享记忆的建议，只输出一个 JSON 对象：",
        f'{{"entries": [{{"section": "分节名（{sections} 之一）", "content": "一句话"}}]}}',
        "没有值得记的就输出 {\"entries\": []}，不要输出其他文字。",
    ]
    try:
        raw = await chat_once(
            provider,
            [
                {"role": "system", "content": SUGGEST_SYSTEM_PROMPT},
                *([{"role": "system", "content": skill_text}] if skill_text else []),
                {"role": "user", "content": "\n".join(user_lines)},
            ],
            json_mode=True,
            fixture_kind="memory_suggest",
        )
    except Exception as exc:  # noqa: BLE001 - 上游错误统一转 502，不落盘
        raise HTTPException(502, f"记忆建议请求失败：{type(exc).__name__}: {exc}") from None
    data = extract_json(raw)
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise HTTPException(502, f"记忆建议输出无法解析：{raw[:200]}")
    cleaned = [
        {"section": str(item.get("section") or "").strip(), "content": str(item.get("content") or "").strip()}
        for item in entries
        if isinstance(item, dict) and str(item.get("content") or "").strip()
    ]
    return {"ok": True, "entries": cleaned}


def _confirm_updates(payload: MemoryConfirmRequest) -> dict[str, Any]:
    """确认写入本体；由 confirm_updates 包一层会话级工作区绑定。"""
    path, written = memory_svc.append_entries(
        [entry.model_dump() for entry in payload.entries]
    )
    return {"ok": True, "path": str(path), "written": written}


@router.post("/confirm")
def confirm_updates(payload: MemoryConfirmRequest) -> dict[str, Any]:
    if not payload.entries:
        raise HTTPException(422, "没有要写入的记忆条目")
    for entry in payload.entries:
        if entry.section not in memory_svc.SECTIONS:
            raise HTTPException(422, f"未知的记忆分节：{entry.section}")
        content = entry.content.strip()
        if not content:
            raise HTTPException(422, "记忆内容不能为空")
        if any(ch in content for ch in "\r\n") or len(content) > 200:
            raise HTTPException(422, "记忆内容必须是一句话：不含换行、200 字以内")
    # 会话级工作区：带 session_id 时写到该会话绑定的工作区；没带维持全局（旧行为）
    with workspace_ctx.bind(storage.session_workspace(payload.session_id)):
        return _confirm_updates(payload)
