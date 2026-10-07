"""会话任务协议与工具元数据契约（2026-10-05 核心整合）。

覆盖：
- chat 桶里 `task_update` 原位更新父工具卡的 task 快照（深复制、不 append parts/notice、
  终态同步旧 status）；
- `tool_result` 透传 task/lesson/assessment 元数据并随 turn 落库；
- agent 执行工具时在 ctx.state 设置父 tool_call_id，finally 恢复不污染下一个工具；
- agent 把工具结果的 task/lesson/assessment 保留进 tool_activities 与 tool_result 事件；
- assess_node 失败且无 assessment 时补确定性 failed 元数据（node_id 从参数、subject_slug 取 state）；
- 本轮允许 schema 之外的调用返回明确错误、不执行（收口阶段 schemas=[] 也不越权）；
- 完整 INTERVIEW_RESULT 标记已输出时优先收口，本轮不再执行后置工具。
"""
from __future__ import annotations

import asyncio
import json
import uuid

from app import storage
from app.agent import (
    ASSESS_FAILURE_CORRECTION,
    INTERVIEW_MARKER_CLOSE,
    INTERVIEW_MARKER_OPEN,
    has_complete_interview_marker,
    run_agent,
)
from app.routers.chat import (
    _accumulate_partial,
    _task_is_terminal,
    _tool_status_from_task,
    _write_turn,
)
from app.tools import ToolContext


def _bucket() -> dict:
    return {"text": [], "reasoning": [], "tools": [], "notices": [], "parts": [], "usage": None}


def _assistants(session_id: str) -> list[dict]:
    return [
        msg
        for msg in storage.require_session(session_id)["messages"]
        if msg.get("role") == "assistant"
    ]


def _task(status: str = "running", **extra: object) -> dict:
    return {
        "id": "task-1",
        "kind": "produce_lesson",
        "title": "分层模型",
        "subject_slug": "net",
        "node_id": "net.layers",
        "workspace": "/ws",
        "status": status,
        "roles": [],
        "events": [],
        **extra,
    }


def _scripted_source(turns: list[list[dict]]) -> object:
    """按脚本逐轮吐事件；最后一段脚本耗尽后重复最后一段（通常是纯文本收尾）。"""
    cursor = {"i": 0}

    async def source(messages, tools):
        index = min(cursor["i"], len(turns) - 1)
        cursor["i"] += 1
        for event in turns[index]:
            yield event

    return source


# ---------- chat 桶：task_update ----------


def test_accumulate_task_update_updates_in_place_without_parts():
    bucket = _bucket()
    _accumulate_partial(
        bucket, {"type": "tool_call", "id": "t1", "name": "produce_lesson", "arguments": "{}"}
    )
    task = _task("running")
    _accumulate_partial(bucket, {"type": "task_update", "id": "t1", "task": task})
    assert [part["type"] for part in bucket["parts"]] == ["tool"]
    assert bucket["notices"] == []
    assert bucket["tools"][0]["task"]["status"] == "running"
    # 深复制：调用方随后修改原快照不污染已落桶的副本
    assert bucket["tools"][0]["task"] is not task
    task["status"] = "error"
    assert bucket["tools"][0]["task"]["status"] == "running"


def test_accumulate_task_terminal_syncs_legacy_status():
    bucket = _bucket()
    _accumulate_partial(
        bucket, {"type": "tool_call", "id": "t1", "name": "produce_lesson", "arguments": "{}"}
    )
    _accumulate_partial(bucket, {"type": "task_update", "id": "t1", "task": _task("interrupted")})
    assert bucket["tools"][0]["task"]["status"] == "interrupted"
    assert bucket["tools"][0]["status"] == "error"  # 旧卡片状态：中断归 error
    assert _task_is_terminal({"status": "done"}) is True
    assert _task_is_terminal({"status": "interrupted"}) is True
    assert _task_is_terminal({"status": "running"}) is False
    assert _tool_status_from_task({"status": "done"}) == "done"
    assert _tool_status_from_task({"status": "running"}) == "running"


def test_task_update_unknown_id_is_noop():
    bucket = _bucket()
    _accumulate_partial(bucket, {"type": "task_update", "id": "ghost", "task": _task()})
    assert bucket["tools"] == [] and bucket["parts"] == []


def test_tool_result_metadata_persisted_with_turn(client):
    session_id = storage.create_session("元数据")["id"]
    bucket = _bucket()
    _accumulate_partial(
        bucket, {"type": "tool_call", "id": "t1", "name": "assess_node", "arguments": "{}"}
    )
    _accumulate_partial(
        bucket,
        {
            "type": "tool_result",
            "id": "t1",
            "name": "assess_node",
            "content": "评估失败",
            "is_error": True,
            "assessment": {
                "status": "failed",
                "node_id": "net.layers",
                "subject_slug": "net",
                "background": False,
            },
        },
    )
    _accumulate_partial(
        bucket,
        {
            "type": "tool_result",
            "id": "t2",
            "name": "produce_lesson",
            "content": "已产出",
            "is_error": False,
            "lesson": {"subject_slug": "net", "node_id": "net.layers", "file": "0001-x.html"},
        },
    )
    # t2 未先声明 tool_call：仅验证元数据不串到 t1
    _write_turn(session_id, bucket, "m", turn_id="turn-1", final=True)
    saved = _assistants(session_id)[0]["tools"]
    assert saved[0]["assessment"]["status"] == "failed"
    assert saved[0].get("lesson") is None


def test_tool_result_lesson_metadata_persisted(client):
    session_id = storage.create_session("课件链接")["id"]
    bucket = _bucket()
    for event in (
        {"type": "tool_call", "id": "t1", "name": "produce_lesson", "arguments": "{}"},
        {
            "type": "tool_result",
            "id": "t1",
            "name": "produce_lesson",
            "content": "已产出节点",
            "is_error": False,
            "lesson": {"subject_slug": "net", "node_id": "net.layers", "file": "0001-x.html"},
        },
    ):
        _accumulate_partial(bucket, event)
    _write_turn(session_id, bucket, "m", turn_id="turn-1", final=True)
    saved = _assistants(session_id)[0]["tools"][0]
    assert saved["status"] == "done"
    assert saved["lesson"]["file"] == "0001-x.html"


# ---------- agent：tool_call_id 与元数据 ----------


def test_agent_sets_tool_call_id_and_forwards_metadata(monkeypatch):
    from app import tools as tools_svc

    captured: list[dict] = []

    async def fake_execute(name, arguments, ctx):
        captured.append({"name": name, "call_id": (ctx.state or {}).get("tool_call_id")})
        return {
            "content": "已产出",
            "is_error": False,
            "lesson": {"subject_slug": "net", "node_id": "net.layers", "file": "x.html"},
            "assessment": {"status": "saved", "node_id": "net.layers", "subject_slug": "net"},
        }

    monkeypatch.setattr(tools_svc, "execute", fake_execute)
    events: list[dict] = []

    async def emit(event):
        events.append(event)

    ctx = ToolContext(state={"slug": "net"})
    outcome = asyncio.run(
        run_agent(
            _scripted_source(
                [
                    [
                        {
                            "type": "tool_calls",
                            "tool_calls": [
                                {
                                    "id": "c1",
                                    "name": "produce_lesson",
                                    "arguments": json.dumps({"node_id": "net.layers"}),
                                }
                            ],
                        }
                    ],
                    [{"type": "text", "content": "完成"}],
                ]
            ),
            [{"role": "user", "content": "产出"}],
            ctx,
            emit,
            [{"name": "produce_lesson"}],
        )
    )

    assert captured == [{"name": "produce_lesson", "call_id": "c1"}]
    assert ctx.state.get("tool_call_id") is None  # finally 恢复，不污染下一工具
    activity = outcome.tools[0]
    assert activity["lesson"]["file"] == "x.html"
    assert activity["assessment"]["status"] == "saved"
    result_events = [event for event in events if event.get("type") == "tool_result"]
    assert result_events[0]["lesson"]["file"] == "x.html"
    assert result_events[0]["assessment"]["status"] == "saved"


def test_agent_assess_failure_fallback_and_correction(monkeypatch):
    from app import tools as tools_svc

    async def fake_execute(name, arguments, ctx):
        return {"content": "评估失败：节点不存在", "is_error": True}

    monkeypatch.setattr(tools_svc, "execute", fake_execute)
    events: list[dict] = []
    messages_seen: list[list[dict]] = []

    async def emit(event):
        events.append(event)

    turns = [
        [
            {
                "type": "tool_calls",
                "tool_calls": [
                    {
                        "id": "c1",
                        "name": "assess_node",
                        "arguments": json.dumps(
                            {"node_id": "fixture-missing-node", "evidence": "x"}
                        ),
                    }
                ],
            }
        ],
        [{"type": "text", "content": "评估未完成"}],
    ]
    cursor = {"i": 0}

    async def source(messages, tools):
        messages_seen.append([m for m in messages])
        index = min(cursor["i"], len(turns) - 1)
        cursor["i"] += 1
        for event in turns[index]:
            yield event

    ctx = ToolContext(state={"slug": "net", "session_id": "s1"})
    outcome = asyncio.run(
        run_agent(source, [{"role": "user", "content": "评估"}], ctx, emit, [{"name": "assess_node"}])
    )

    activity = outcome.tools[0]
    assert activity["assessment"] == {
        "status": "failed",
        "node_id": "fixture-missing-node",
        "subject_slug": "net",
        "background": False,
        "error": "评估失败：节点不存在",
    }
    result_event = next(event for event in events if event.get("type") == "tool_result")
    assert result_event["assessment"]["status"] == "failed"
    # 第二轮 LLM 调用前已追加受控纠正消息
    assert any(
        msg.get("content") == ASSESS_FAILURE_CORRECTION for msg in messages_seen[1]
    )


def test_agent_rejects_tool_outside_allowlist(monkeypatch):
    from app import tools as tools_svc

    async def fake_execute(name, arguments, ctx):  # pragma: no cover - 不应被调用
        raise AssertionError("收口阶段不允许执行工具")

    monkeypatch.setattr(tools_svc, "execute", fake_execute)
    events: list[dict] = []

    async def emit(event):
        events.append(event)

    ctx = ToolContext(state={"slug": "net"})
    outcome = asyncio.run(
        run_agent(
            _scripted_source(
                [
                    [
                        {
                            "type": "tool_calls",
                            "tool_calls": [
                                {"id": "c1", "name": "produce_lesson", "arguments": "{}"}
                            ],
                        }
                    ],
                    [{"type": "text", "content": "已按现有信息作答"}],
                ]
            ),
            [{"role": "user", "content": "确认"}],
            ctx,
            emit,
            [],  # 收口阶段 schemas 为空
        )
    )

    assert outcome.tools[0]["status"] == "error"
    assert "本轮不开放该工具" in outcome.tools[0]["result"]
    result_event = next(event for event in events if event.get("type") == "tool_result")
    assert result_event["is_error"] is True


def test_agent_prefers_interview_close_over_tool_calls(monkeypatch):
    from app import tools as tools_svc

    async def fake_execute(name, arguments, ctx):  # pragma: no cover - 不应被调用
        raise AssertionError("完整收口标记已输出，不应执行后置工具")

    monkeypatch.setattr(tools_svc, "execute", fake_execute)
    marker = (
        "盘问收口："
        + INTERVIEW_MARKER_OPEN
        + json.dumps({"name": "Python"})
        + INTERVIEW_MARKER_CLOSE
    )
    ctx = ToolContext(state={"session_id": "s1"})

    async def emit(event):
        return None

    async def source(messages, tools):
        yield {"type": "text", "content": marker}
        yield {
            "type": "tool_calls",
            "tool_calls": [{"id": "c1", "name": "produce_lesson", "arguments": "{}"}],
        }

    outcome = asyncio.run(
        run_agent(
            source,
            [{"role": "user", "content": "确认建课"}],
            ctx,
            emit,
            [{"name": "produce_lesson"}],
        )
    )
    assert outcome.tools == []
    assert has_complete_interview_marker(outcome.text)


# ---------- 端到端：真实工具实现 + 元数据落库 ----------


def _seed_single_node_subject(client, cs, node_id: str) -> tuple[str, str]:
    """建一门只含一个无前置节点的科目，返回 (slug, session_id)；节点排位 1 == 已产出 0+1。"""
    slug = client.post(
        "/api/courses", json={"name": f"集成-{uuid.uuid4().hex[:8]}"}
    ).json()["slug"]
    node = {
        "id": node_id,
        "title": "分层模型",
        "kind": "概念",
        "objective": "能说清分层模型解决的问题",
        "problem": "缺少整体地图。",
        "prerequisites": [],
        "concepts": ["分层"],
        "resources": [],
        "practice": "以讲为主。",
        "pitfalls": [],
        "realworld": "",
        "status": "未开始",
        "mastery": 0,
    }
    response = client.put(
        f"/api/courses/{slug}/curriculum", json={"nodes": [node], "edges": []}
    )
    assert response.status_code == 200, response.text
    session_id = storage.create_session("集成会话")["id"]
    storage.update_session(session_id, subject_slug=slug)
    return slug, session_id


def test_production_task_fixture_persists_done_task_and_lesson(client, cs):
    slug, session_id = _seed_single_node_subject(client, cs, "net.layers")
    response = client.post(
        "/api/chat/stream",
        json={
            "message": "产出这一课",
            "session_id": session_id,
            "fixture_scenario": "production_task",
        },
    )
    assert response.status_code == 200
    assert "event: task_update" in response.text
    saved = _assistants(session_id)[-1]
    produce_tools = [tool for tool in (saved.get("tools") or []) if tool["name"] == "produce_lesson"]
    assert produce_tools, saved.get("tools")
    task = produce_tools[0].get("task")
    assert task is not None and task["status"] == "done"
    assert task["subject_slug"] == slug and task["node_id"] == "net.layers"
    assert produce_tools[0].get("lesson", {}).get("node_id") == "net.layers"


def test_assessment_failure_fixture_persists_failed_metadata(client, cs):
    slug, session_id = _seed_single_node_subject(client, cs, "net.layers")
    response = client.post(
        "/api/chat/stream",
        json={
            "message": "评估我",
            "session_id": session_id,
            "fixture_scenario": "assessment_failure",
        },
    )
    assert response.status_code == 200
    saved = _assistants(session_id)[-1]
    assess_tools = [tool for tool in (saved.get("tools") or []) if tool["name"] == "assess_node"]
    assert assess_tools, saved.get("tools")
    assessment = assess_tools[0].get("assessment")
    assert assessment is not None
    assert assessment["status"] == "failed"
    assert assessment["node_id"] == "fixture-missing-node"
    assert assessment["subject_slug"] == slug
    assert assessment["background"] is False
    # 模型末段嘴上说「我认为通过」，但系统状态仍是 failed（不靠删文字假装可靠）
    assert "我认为通过" in saved["content"]


# ---------- 角色派工提示：tools_enabled 按 route 指明注册工具 ----------


def test_inject_role_default_keeps_envelope_adaption():
    from app import prompts

    text, missing = prompts.inject_role("produce_content")
    assert missing == []
    assert "JSON envelope" in text
    assert "write_deliver_file" not in text


def test_inject_role_tools_enabled_names_produce_tools():
    from app import prompts

    text, missing = prompts.inject_role("produce_content", tools_enabled=True)
    assert missing == []
    for tool in ("read_course_file", "list_workspace", "write_deliver_file", "run_check"):
        assert tool in text, tool
    # 工具循环版不再要求 envelope 交付（正文不再出现 envelope 交付指令）
    assert "改为 JSON envelope 交付" not in text


def test_inject_role_generate_tool_loop_uses_submit_curriculum():
    from app import prompts

    text, missing = prompts.inject_role("generate", tools_enabled=True)
    assert missing == []
    assert "submit_curriculum" in text
    assert "write_deliver_file" not in text
    # 技能全文不裁剪：route 对应的规范仍在
    assert "curriculum-designer" in text
