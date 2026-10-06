"""建课收口阶段（显式判据）测试（2026-10-05）。

覆盖：
- `_is_interview_finalize_phase` 真值表：明确确认语进入；否定语（先不要/如何/还没确认）不进入；
  收口提示 + 简短确认的辅助判据（上一助手带问号时不成立）；
- 进入收口阶段：本轮 schemas=[]、预算=INTERVIEW_FINALIZE_BUDGET、墙钟=收口专用、
  系统提示带收口口径、阶段状态 notice 落库一次；
- 一般盘问轮（非收口）仍保留只读工具；
- 收口阶段 plain 流输出完整标记 ⇒ 正常建草稿、落确认卡。
"""
from __future__ import annotations

import json

import pytest

from app import storage
from app import agent as agent_svc
from app import prompts
from app.routers.chat import (
    INTERVIEW_REQUIRED_FIELDS,
    _handle_interview_result,
    _interview_missing_fields,
    _is_interview_finalize_phase,
    finalize_notice,
)


def _assistant(session_id: str) -> dict:
    """本轮主助手回复（跳过 build_confirm / error 等编排提示消息）。"""
    msgs = storage.require_session(session_id)["messages"]
    return next(
        msg
        for msg in reversed(msgs)
        if msg.get("role") == "assistant" and not msg.get("kind")
    )


# ---------- 判据真值表 ----------


def test_finalize_phase_positive_phrases():
    for phrase in (
        "确认建课",
        "按你说的建课",
        "按上面的结论建课",
        "开始建课",
        "就这样建课",
        "可以建课",
        "好的，确认建课",
        "请确认建课",
        "那就建课",
    ):
        assert _is_interview_finalize_phase([], phrase) is True, phrase


def test_finalize_phase_negative_phrases():
    for phrase in (
        "先不要建课",
        "如何建课？",
        "怎么建课",
        "还没确认",
        "先别开始",
        "再想想",
    ):
        assert _is_interview_finalize_phase([], phrase) is False, phrase


@pytest.mark.parametrize(
    "phrase",
    [
        "如何开始建课",
        "怎么开始建课",
        "怎样开始建课",
        "可以建课吗",
        "能不能开始建课",
        "确认一下，怎么开始建课？",
        "如何确认建课",
        "开始建课？",
        "「开始建课」",
        "我不想开始建课",
        "有人建议开始建课",
        "你好，顺便说下什么时候开始建课",
    ],
)
def test_finalize_phase_question_or_quote_not_triggered(phrase):
    """含确认子串的提问/引用一律不触发（宁可漏判继续盘问，也不误建课）。"""
    assert _is_interview_finalize_phase([], phrase) is False, phrase


def test_finalize_phase_auxiliary_short_affirm():
    closing = [{"role": "assistant", "content": "信息齐了。请确认是否开始建课。"}]
    assert _is_interview_finalize_phase(closing, "好") is True
    assert _is_interview_finalize_phase(closing, "可以") is True
    # 上一助手还在提问 ⇒ 简短「好」不算收口（别猜）
    asking = [{"role": "assistant", "content": "想学到什么程度？"}]
    assert _is_interview_finalize_phase(asking, "好") is False
    # 没有收口提示语境 ⇒ 不触发
    assert _is_interview_finalize_phase([{"role": "assistant", "content": "讲个概念。"}], "好") is False
    assert _is_interview_finalize_phase([], "好") is False


# ---------- 集成：进入收口阶段 ----------


def _capture_run_agent(monkeypatch) -> list[dict]:
    captured: list[dict] = []

    async def fake_run_agent(turn_source, messages, ctx, emit, tool_schemas, **kwargs):
        captured.append(
            {
                "tool_schemas": tool_schemas,
                "budget": kwargs.get("budget"),
                "max_seconds": kwargs.get("max_seconds"),
                "messages": messages,
            }
        )
        await emit({"type": "text", "content": "收到"})
        return agent_svc.AgentOutcome(text="收到", rounds=1, tool_calls=0)

    monkeypatch.setattr(agent_svc, "run_agent", fake_run_agent)
    return captured


def test_interview_confirmation_enters_finalize_phase(client, monkeypatch):
    session_id = storage.create_session("盘问", mode="interview")["id"]
    captured = _capture_run_agent(monkeypatch)

    response = client.post(
        "/api/chat/stream",
        json={
            "message": "按上面的结论建课",
            "session_id": session_id,
            "fixture_scenario": "tools",
        },
    )
    assert response.status_code == 200
    assert len(captured) == 1
    call = captured[0]
    # 本轮工具面清空 + 收口预算/墙钟 + 收口系统提示
    assert call["tool_schemas"] == []
    assert call["budget"] == agent_svc.INTERVIEW_FINALIZE_BUDGET
    assert call["max_seconds"] == agent_svc.INTERVIEW_FINALIZE_MAX_SECONDS
    systems = [m["content"] for m in call["messages"] if m.get("role") == "system"]
    assert prompts.INTERVIEW_FINALIZE_PROMPT in systems
    # 阶段状态 notice 落库一次（含时限，不逐秒刷屏）
    saved = _assistant(session_id)
    notices = saved.get("notices") or []
    assert notices.count(finalize_notice()) == 1


def test_interview_question_turn_keeps_readonly_tools(client, monkeypatch):
    session_id = storage.create_session("盘问", mode="interview")["id"]
    captured = _capture_run_agent(monkeypatch)

    response = client.post(
        "/api/chat/stream",
        json={"message": "如何建课？", "session_id": session_id, "fixture_scenario": "tools"},
    )
    assert response.status_code == 200 and len(captured) == 1
    names = {schema["name"] for schema in captured[0]["tool_schemas"]}
    assert "read_course_file" in names and names  # 一般盘问轮保留只读工具
    assert captured[0]["budget"] is None
    assert captured[0]["max_seconds"] != agent_svc.INTERVIEW_FINALIZE_MAX_SECONDS


@pytest.mark.parametrize(
    "phrase",
    ["如何开始建课", "可以建课吗", "确认一下，怎么开始建课？", "能不能开始建课"],
)
def test_interview_question_does_not_disable_tools_or_build_draft(client, monkeypatch, phrase):
    """提问轮不得误触发收口：工具面未被清空，也不落 build_confirm 草稿卡。"""
    session_id = storage.create_session("盘问", mode="interview")["id"]
    captured = _capture_run_agent(monkeypatch)

    response = client.post(
        "/api/chat/stream",
        json={"message": phrase, "session_id": session_id, "fixture_scenario": "tools"},
    )
    assert response.status_code == 200 and len(captured) == 1
    assert captured[0]["tool_schemas"]  # 未进入收口 ⇒ 工具仍开放
    assert captured[0]["budget"] is None
    kinds = [msg.get("kind") for msg in storage.require_session(session_id)["messages"]]
    assert "build_confirm" not in kinds


# ---------- 集成：收口阶段 plain 流输出标记 ----------


def test_finalize_plain_stream_builds_draft_and_confirm(client):
    session_id = storage.create_session("盘问", mode="interview")["id"]
    response = client.post(
        "/api/chat/stream",
        json={"message": "确认建课", "session_id": session_id, "fixture_scenario": "interview"},
    )
    assert response.status_code == 200
    session = storage.require_session(session_id)
    kinds = [msg.get("kind") for msg in session["messages"]]
    assert "build_confirm" in kinds
    # 收口标记从正文与 parts 剥掉，阶段 notice 仍在
    assistant = _assistant(session_id)
    assert "<!--INTERVIEW_RESULT-->" not in assistant["content"]
    assert finalize_notice() in (assistant.get("notices") or [])
    # 确认卡载荷可用（草稿 slug 已建立）
    confirm = next(msg for msg in session["messages"] if msg.get("kind") == "build_confirm")
    assert confirm.get("slug")


# ---------- 收口字段机械校验 ----------


def _marker(payload: dict) -> str:
    return (
        "<!--INTERVIEW_RESULT-->"
        + json.dumps(payload, ensure_ascii=False)
        + "<!--/INTERVIEW_RESULT-->"
    )


def test_interview_missing_required_fields_blocks_draft(client):
    from app.routers.chat import _handle_interview_result

    session_id = storage.create_session("缺字段")["id"]
    # 只有 name：purpose/level/background 缺失 ⇒ 不建草稿，回错误提示要求补充
    assert _handle_interview_result(session_id, _marker({"name": "只有名字"})) is None
    messages = storage.require_session(session_id)["messages"]
    errors = [msg for msg in messages if msg.get("kind") == "error"]
    assert errors and all(
        key in errors[-1]["content"] for key in ("purpose", "level", "background")
    )
    assert not [msg for msg in messages if msg.get("kind") == "build_confirm"]


def test_interview_placeholder_value_blocks_draft(client):
    from app.routers.chat import _handle_interview_result

    session_id = storage.create_session("占位")["id"]
    payload = {"name": "科目", "purpose": "待定", "level": "未知", "background": "零基础"}
    assert _handle_interview_result(session_id, _marker(payload)) is None
    error = next(
        msg for msg in storage.require_session(session_id)["messages"] if msg.get("kind") == "error"
    )
    assert "purpose" in error["content"] and "level" in error["content"]


def test_interview_missing_fields_helper_allows_zero_background():
    assert _interview_missing_fields(
        {"name": "n", "purpose": "p", "level": "l", "background": "零基础"}
    ) == []
    missing = _interview_missing_fields({"name": "n"})
    assert missing == ["purpose", "level", "background"]
    assert list(INTERVIEW_REQUIRED_FIELDS) == ["name", "purpose", "level", "background"]


def test_interview_non_string_required_field_treated_missing():
    """list/dict/number 等非文本不能靠 str() 冒充已确认值。"""
    result = {"name": "科目", "purpose": {"a": 1}, "level": ["x"], "background": 0}
    assert _interview_missing_fields(result) == ["purpose", "level", "background"]
    assert _interview_missing_fields(
        {"name": "n", "purpose": "p", "level": "l", "background": "零基础"}
    ) == []
