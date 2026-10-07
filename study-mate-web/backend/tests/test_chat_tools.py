"""会话动作工具（产课 / 评估）与盘问收口加固测试。

覆盖：
- 科目绑定的 chat 会话开放 produce_lesson / assess_node 与长墙钟；未绑定不开放；
- produce_lesson 真跑 run_produce 并以 task_update 回吐父工具任务、错误转 is_error；
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


def test_produce_lesson_runs_chain_and_emits_task_update(client, monkeypatch, new_subject, cs):
    from app import produce
    from app import tools as tools_svc

    slug, base = new_subject
    _seed_node(cs, slug, "a.first")
    calls: list[tuple] = []

    async def fake_run_produce(base_arg, slug_arg, node_id_arg, provider_arg, emit_arg, **kwargs):
        calls.append((base_arg, slug_arg, node_id_arg, provider_arg))
        await emit_arg({"event": "stage", "stage": "讲解", "status": "done"})
        await emit_arg(
            {"event": "done", "node_id": node_id_arg, "artifacts": ["lessons/0001-a.first.md"]}
        )

    monkeypatch.setattr(produce, "run_produce", fake_run_produce)

    events: list[dict] = []

    async def emit(event):
        events.append(event)

    ctx = ToolContext(
        read_roots=[base],
        write_roots=[],
        label="科目",
        state={
            "slug": slug,
            "node_id": "a.first",
            "session_id": None,
            "emit": emit,
            "tool_call_id": "call-1",
        },
    )
    result = asyncio.run(tools_svc.execute("produce_lesson", {}, ctx))

    assert result["is_error"] is False
    assert calls and calls[0][0] == base and calls[0][1] == slug and calls[0][2] == "a.first"
    assert calls[0][3] and calls[0][3].get("model")
    # 过程以父工具任务原位回吐（id = 父 call id），不再用 notice 刷屏
    updates = [e for e in events if e.get("type") == "task_update"]
    assert updates and all(e["id"] == "call-1" for e in updates)
    assert updates[-1]["task"]["status"] == "done"
    assert not [e for e in events if e.get("type") == "notice"]
    assert "lessons/0001-a.first.md" in result["content"]


def test_produce_lesson_out_of_order_failure_returns_error(client, monkeypatch, new_subject, cs):
    from app import produce
    from app import tools as tools_svc

    slug, base = new_subject
    _seed_node(cs, slug, "a.first")

    async def fake_run_produce(base_arg, slug_arg, node_id_arg, provider_arg, emit_arg, **kwargs):
        await emit_arg(
            {"event": "error", "message": "按大纲顺序产课：本节点排位 2，但已有 0 份课件——先产出前面的节点。"}
        )

    monkeypatch.setattr(produce, "run_produce", fake_run_produce)

    events: list[dict] = []

    async def emit(event):
        events.append(event)

    ctx = ToolContext(
        read_roots=[base],
        write_roots=[],
        label="科目",
        state={"slug": slug, "node_id": "a.second", "emit": emit, "tool_call_id": "call-2"},
    )
    result = asyncio.run(tools_svc.execute("produce_lesson", {"node_id": "a.second"}, ctx))

    assert result["is_error"] is True
    assert "按大纲顺序产课" in result["content"]
    updates = [e for e in events if e.get("type") == "task_update"]
    assert updates and updates[-1]["task"]["status"] == "error"
    assert "lesson" not in result


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
    first = {"name": "First", "purpose": "入门", "level": "能上手", "background": "零基础"}
    second = {"name": "Second", "purpose": "进阶", "level": "能独立", "background": "有基础"}
    reply = "先给一版结论。" + _marker(first) + "\n更正：" + _marker(second)

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


# ---------- start_course_interview（建课切换工具，2026-10-05 拍板③） ----------


def test_start_course_interview_switches_mode_and_closes_same_turn(client):
    """普通会话经工具切建课模式，同一轮的收口标记也要被解析出「确认建课」卡。"""
    import re

    from app import storage

    r = client.post(
        "/api/chat/stream",
        json={"message": "不知道学什么，帮我选方向", "fixture_scenario": "interview_switch"},
    )
    assert r.status_code == 200
    match = re.search(r'"session_id"\s*:\s*"([0-9a-f]+)"', r.text)
    assert match, f"SSE 里没有 session_id：{r.text[:200]}"
    session_id = match.group(1)

    session = storage.require_session(session_id)
    # 工具已把会话切进建课模式
    assert session["mode"] == "interview"
    # 同轮收口：草稿建立 + 确认卡落库 + 标记从正文剥掉
    kinds = [m.get("kind") for m in session["messages"]]
    assert "build_confirm" in kinds
    assistant_text = next(m["content"] for m in session["messages"] if m["role"] == "assistant")
    assert "<!--INTERVIEW_RESULT-->" not in assistant_text


def test_start_course_interview_offered_without_subject(client, monkeypatch):
    """未绑定科目的会话也要拿到 start_course_interview（切建课是它的核心用途）。"""
    from app import agent as agent_svc

    captured: list[list[str]] = []

    async def fake_run_agent(turn_source, messages, ctx, emit, tool_schemas, **kwargs):
        captured.append([s["name"] for s in tool_schemas])
        await emit({"type": "text", "content": "收到"})
        return agent_svc.AgentOutcome(text="收到", rounds=1, tool_calls=0)

    monkeypatch.setattr(agent_svc, "run_agent", fake_run_agent)
    r = client.post("/api/chat/stream", json={"message": "在吗", "fixture_scenario": "tools"})
    assert r.status_code == 200
    assert "start_course_interview" in captured[0]


def test_start_course_interview_refuses_subject_bound_session(client, new_subject):
    from app import storage
    from app.tools import ToolContext, execute

    slug, _ = new_subject
    session_id = storage.create_session("已绑科目")["id"]
    storage.update_session(session_id, subject_slug=slug)
    ctx = ToolContext(state={"session_id": session_id})

    result = asyncio.run(execute("start_course_interview", {}, ctx))
    assert result["is_error"] is True
    assert "已关联科目" in result["content"]
    # 模式保持 chat：失败的工具调用不得产生副作用
    assert str(storage.require_session(session_id).get("mode") or "chat") == "chat"


def test_start_course_interview_idempotent_when_already_interview(client):
    from app import storage
    from app.tools import ToolContext, execute

    session_id = storage.create_session("已是建课")["id"]
    storage.update_session(session_id, mode="interview")
    ctx = ToolContext(state={"session_id": session_id})

    result = asyncio.run(execute("start_course_interview", {}, ctx))
    assert result["is_error"] is False
    assert "已是建课会话" in result["content"]
