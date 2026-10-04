"""会话动作工具（产课 / 评估）与盘问收口加固测试。

覆盖：
- 科目绑定的 chat 会话开放 produce_lesson / assess_node 与长墙钟；未绑定不开放；
- produce_lesson 真跑 run_produce 并转发进度 notice、错误转 is_error；
- assess_node 复用评估服务返回中文摘要；
- 盘问收口取最后一段标记、坏 JSON 回显原文、无标记给可行动提示。
"""
from __future__ import annotations

import asyncio
import json

from app.tools import ToolContext


# ---------- 动态工具集 / 墙钟 ----------


def test_subject_bound_chat_offers_action_tools_and_long_budget(client, monkeypatch, new_subject):
    from app import agent as agent_svc

    slug, _ = new_subject
    captured: list[dict] = []

    async def fake_run_agent(turn_source, messages, ctx, emit, tool_schemas, **kwargs):
        captured.append(
            {
                "tool_schemas": tool_schemas,
                "max_seconds": kwargs.get("max_seconds"),
                "state": dict(ctx.state),
                "messages": messages,
            }
        )
        await emit({"type": "text", "content": "收到"})
        return agent_svc.AgentOutcome(text="收到", rounds=1, tool_calls=0)

    monkeypatch.setattr(agent_svc, "run_agent", fake_run_agent)

    bound = client.post(
        "/api/chat/stream",
        json={"message": "开始学", "subject_slug": slug, "fixture_scenario": "tools"},
    )
    assert bound.status_code == 200 and len(captured) == 1
    call = captured[0]
    names = {schema["name"] for schema in call["tool_schemas"]}
    assert {"produce_lesson", "assess_node"} <= names
    assert call["max_seconds"] == agent_svc.ORCH_MAX_SECONDS
    # ToolContext.state 带上会话上下文与进度回吐通道
    assert call["state"]["slug"] == slug
    assert call["state"]["session_id"]
    assert callable(call["state"]["emit"])
    # 系统提示里有一行动作提示（不注入技能全文——技能仍走按需 read_skill）
    hints = [m["content"] for m in call["messages"] if m["role"] == "system"]
    assert any("produce_lesson" in text and "assess_node" in text for text in hints)

    unbound = client.post(
        "/api/chat/stream", json={"message": "你在吗", "fixture_scenario": "tools"}
    )
    assert unbound.status_code == 200 and len(captured) == 2
    plain = captured[1]
    plain_names = {schema["name"] for schema in plain["tool_schemas"]}
    assert not ({"produce_lesson", "assess_node"} & plain_names)
    assert plain["max_seconds"] == agent_svc.CHAT_MAX_SECONDS
    assert plain["state"]["slug"] is None


# ---------- produce_lesson ----------


def _seed_node(cs, slug: str, node_id: str = "a.first") -> str:
    cs.save_curriculum(
        slug,
        {
            "nodes": [
                {"id": node_id, "title": "第一课", "kind": "概念", "objective": "目标"},
                {"id": "a.second", "title": "第二课", "kind": "概念", "objective": "目标"},
            ],
            "edges": [],
        },
    )
    return node_id


def test_produce_lesson_runs_chain_and_forwards_notice(client, monkeypatch, new_subject, cs):
    from app import produce
    from app import tools as tools_svc

    slug, base = new_subject
    _seed_node(cs, slug, "a.first")
    calls: list[tuple] = []

    async def fake_run_produce(base_arg, slug_arg, node_id_arg, provider_arg, emit_arg):
        calls.append((base_arg, slug_arg, node_id_arg, provider_arg))
        await emit_arg({"event": "stage", "stage": "讲解", "status": "done"})
        await emit_arg(
            {"event": "done", "node_id": node_id_arg, "artifacts": ["lessons/0001-a.first.md"]}
        )

    monkeypatch.setattr(produce, "run_produce", fake_run_produce)

    notices: list[dict] = []

    async def emit(event):
        notices.append(event)

    ctx = ToolContext(
        read_roots=[base],
        write_roots=[],
        label="科目",
        state={"slug": slug, "node_id": "a.first", "session_id": None, "emit": emit},
    )
    result = asyncio.run(tools_svc.execute("produce_lesson", {}, ctx))

    assert result["is_error"] is False
    assert calls and calls[0][0] == base and calls[0][1] == slug and calls[0][2] == "a.first"
    assert calls[0][3] and calls[0][3].get("model")
    assert any(
        event.get("type") == "notice" and "讲解完成" in str(event.get("message")) for event in notices
    )
    assert "lessons/0001-a.first.md" in result["content"]


def test_produce_lesson_out_of_order_failure_returns_error(client, monkeypatch, new_subject, cs):
    from app import produce
    from app import tools as tools_svc

    slug, base = new_subject
    _seed_node(cs, slug, "a.first")

    async def fake_run_produce(base_arg, slug_arg, node_id_arg, provider_arg, emit_arg):
        await emit_arg(
            {"event": "error", "message": "按大纲顺序产课：本节点排位 2，但已有 0 份课件——先产出前面的节点。"}
        )

    monkeypatch.setattr(produce, "run_produce", fake_run_produce)

    notices: list[dict] = []

    async def emit(event):
        notices.append(event)

    ctx = ToolContext(
        read_roots=[base],
        write_roots=[],
        label="科目",
        state={"slug": slug, "node_id": "a.second", "emit": emit},
    )
    result = asyncio.run(tools_svc.execute("produce_lesson", {"node_id": "a.second"}, ctx))

    assert result["is_error"] is True
    assert "按大纲顺序产课" in result["content"]
    assert any(event.get("type") == "notice" for event in notices)


def test_produce_lesson_without_subject_is_error(client):
    from app import tools as tools_svc

    ctx = ToolContext(read_roots=[], write_roots=[], label="工作区", state={})
    result = asyncio.run(tools_svc.execute("produce_lesson", {}, ctx))
    assert result["is_error"] is True
    assert "未关联科目" in result["content"]


# ---------- assess_node ----------


def test_assess_node_returns_chinese_summary(client, new_subject, cs):
    from app import storage
    from app import tools as tools_svc

    slug, base = new_subject
    _seed_node(cs, slug, "a.first")
    session_id = storage.create_session("评估会话")["id"]
    storage.update_session(session_id, subject_slug=slug)

    ctx = ToolContext(
        read_roots=[base],
        write_roots=[],
        label="科目",
        state={"slug": slug, "session_id": session_id},
    )
    result = asyncio.run(
        tools_svc.execute(
            "assess_node",
            {"node_id": "a.first", "evidence": "我把分层与封装的关系讲了一遍"},
            ctx,
        )
    )

    assert result["is_error"] is False
    assert "判定：通过" in result["content"]
    assert "掌握度" in result["content"]
    assert "已置位" in result["content"]
    assert (base / "assessments").is_dir() and any((base / "assessments").glob("*.md"))


def test_assess_node_requires_evidence(client, new_subject, cs):
    from app import storage
    from app import tools as tools_svc

    slug, base = new_subject
    _seed_node(cs, slug, "a.first")
    session_id = storage.create_session("评估会话")["id"]
    ctx = ToolContext(
        read_roots=[base],
        write_roots=[],
        label="科目",
        state={"slug": slug, "session_id": session_id},
    )
    result = asyncio.run(tools_svc.execute("assess_node", {"node_id": "a.first"}, ctx))
    assert result["is_error"] is True
    assert "evidence" in result["content"]


# ---------- 盘问收口加固 ----------


def _marker(payload: dict) -> str:
    return "<!--INTERVIEW_RESULT-->" + json.dumps(payload, ensure_ascii=False) + "<!--/INTERVIEW_RESULT-->"


def test_interview_last_marker_wins(client, monkeypatch):
    from app import draft, storage
    from app.routers.chat import _handle_interview_result

    session_id = storage.create_session("盘问")["id"]
    seen: dict = {}

    def fake_create_draft(name, slug=None, goal="", interview=None):
        seen["name"] = name
        return "second-slug"

    monkeypatch.setattr(draft, "create_draft", fake_create_draft)
    reply = "先给一版结论。" + _marker({"name": "First"}) + "\n更正：" + _marker({"name": "Second"})

    confirm = _handle_interview_result(session_id, reply)
    assert confirm == {"slug": "second-slug", "name": "Second"}
    assert seen["name"] == "Second"


def test_interview_unparseable_marker_echoes_raw_text(client):
    from app import storage
    from app.routers.chat import _handle_interview_result

    session_id = storage.create_session("盘问坏JSON")["id"]
    reply = "结论如下。\n\n<!--INTERVIEW_RESULT-->{bad json here}<!--/INTERVIEW_RESULT-->"

    assert _handle_interview_result(session_id, reply) is None
    messages = storage.require_session(session_id)["messages"]
    errors = [m for m in messages if m.get("kind") == "error"]
    assert errors and "bad json here" in errors[-1]["content"]


def test_interview_hint_only_on_conclusion_shape_and_once(client):
    """收口提示的触发面要窄：还在提问的轮次不发，收尾形态最多发一次。"""
    from app import storage
    from app.routers.chat import _handle_interview_result

    session_id = storage.create_session("盘问无标记")["id"]
    # 还在提问（带问号）⇒ 不发提示（否则盘问每一轮都会刷一条）
    assert _handle_interview_result(session_id, "先说说什么让你想学前端？") is None
    messages = storage.require_session(session_id)["messages"]
    assert not any("未收到建课收口标记" in m["content"] for m in messages)

    # 收尾形态（没有问号）⇒ 发一条
    assert _handle_interview_result(session_id, "结论已定，准备开始建课。") is None
    messages = storage.require_session(session_id)["messages"]
    hints = [m for m in messages if "未收到建课收口标记" in m["content"]]
    assert len(hints) == 1 and hints[0]["kind"] == "error"

    # 再来一轮仍不收口 ⇒ 不再重复发
    assert _handle_interview_result(session_id, "还是没有标记。") is None
    messages = storage.require_session(session_id)["messages"]
    assert sum(1 for m in messages if "未收到建课收口标记" in m["content"]) == 1
