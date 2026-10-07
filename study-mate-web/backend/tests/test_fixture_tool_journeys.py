"""会话动作工具的 fixture 全链路（E2E 契约）：产课 / 评估两个 journey。

节点页的「产出此课」「申请评估」按钮已删除：产课与评估现在由 chat agent 调
`produce_lesson` / `assess_node` 完成。E2E 全程 fixture 模式，端到端覆盖这两条
journey 就靠 agent.py 里同名的 fixture 场景脚本（场景名 "produce" / "assess"
是冻结契约，E2E 经 chat body 的 fixture_scenario 注入）。

两条 journey 都走 `POST /api/chat/stream` 的真实 SSE：建会话 → 绑定科目 → 发一问。
"""
from __future__ import annotations

import json

import pytest

NET_LAYERS = "net.layers"

# 与 E2E 种子科目「计算机网络」大纲同构的最小课程：net.layers 排第一位、无前置。
# 产课顺序守卫（produce.run_produce）：新科目无课件时位次 1 == 已产出 0 + 1，必过。
SEED_CURRICULUM = {
    "nodes": [
        {
            "id": NET_LAYERS,
            "title": "分层模型与封装",
            "kind": "概念",
            "objective": "能说清一次网页请求经过的各层各加了什么头",
            "prerequisites": [],
        },
        {
            "id": "net.link",
            "title": "链路层与以太网帧",
            "kind": "概念",
            "objective": "能读出一个以太网帧的字段",
            "prerequisites": [NET_LAYERS],
        },
    ],
    "edges": [{"from": NET_LAYERS, "to": "net.link", "reason": "先立分层框架再看链路层"}],
}


def sse_events(response) -> list[tuple[str, dict]]:
    """把 SSE 响应解析成 (event, data) 序列（与 test_production_flow 同规）。"""
    out: list[tuple[str, dict]] = []
    current = None
    for line in response.text.splitlines():
        if line.startswith("event: "):
            current = line[7:]
        elif line.startswith("data: ") and current is not None:
            out.append((current, json.loads(line[6:])))
            current = None
    return out


@pytest.fixture()
def bound_subject(client, new_subject, cs):
    """带课程大纲的科目（net.layers 为首节点），返回 (slug, 科目目录)。"""
    slug, base = new_subject
    cs.save_curriculum(slug, SEED_CURRICULUM)
    return slug, base


def _bind_session(slug: str, node_id: str = NET_LAYERS) -> str:
    """建会话并绑定科目 + 节点（产课/评估只对绑定科目的会话开放）。"""
    from app import storage

    session = storage.create_session("工具 journey")
    storage.update_session(session["id"], subject_slug=slug, node_id=node_id)
    return session["id"]


def _post(client, session_id: str, scenario: str):
    return client.post(
        "/api/chat/stream",
        json={"message": "开始", "session_id": session_id, "fixture_scenario": scenario},
    )


def test_produce_journey_runs_chain_and_writes_artifacts(client, bound_subject):
    slug, base = bound_subject
    session_id = _bind_session(slug)

    response = _post(client, session_id, "produce")
    assert response.status_code == 200
    events = sse_events(response)

    call = next(data for name, data in events if name == "tool_call")
    assert call["name"] == "produce_lesson"
    result = next(data for name, data in events if name == "tool_result")
    assert result["name"] == "produce_lesson"
    assert result["is_error"] is False
    assert "已产出节点" in result["content"]

    # 产课链真跑（讲解 → 出题 → 渲染 → 检查），三份产物落到科目目录
    for rel in (
        f"lessons/0001-{NET_LAYERS}.md",
        f"lessons/0001-{NET_LAYERS}.quiz.json",
        f"lessons/0001-{NET_LAYERS}.html",
    ):
        assert (base / rel).is_file(), rel

    # 助手回复持久化，工具活动（含结果）随消息落库
    assistant = client.get(f"/api/sessions/{session_id}").json()["messages"][-1]
    assert assistant["role"] == "assistant"
    assert "落盘" in assistant["content"]
    tools = assistant.get("tools") or []
    assert [tool["name"] for tool in tools] == ["produce_lesson"]
    assert tools[0]["isError"] is False


def test_assess_journey_returns_summary_and_writes_record(client, bound_subject):
    slug, base = bound_subject
    session_id = _bind_session(slug)

    response = _post(client, session_id, "assess")
    assert response.status_code == 200
    events = sse_events(response)

    call = next(data for name, data in events if name == "tool_call")
    assert call["name"] == "assess_node"
    result = next(data for name, data in events if name == "tool_result")
    assert result["name"] == "assess_node"
    assert result["is_error"] is False
    assert "判定：通过" in result["content"]

    # 助手持久化回复（工具结果随消息落库）带着评估摘要
    assistant = client.get(f"/api/sessions/{session_id}").json()["messages"][-1]
    assert "判定" in assistant["content"]
    tools = assistant.get("tools") or []
    assert [tool["name"] for tool in tools] == ["assess_node"]
    assert "判定：通过" in tools[0]["result"]

    # 评估记录落盘（fixture 模式下可观察）
    records = list((base / "assessments").glob("*.md"))
    assert records, "评估记录未写入"


def test_unbound_session_is_not_offered_action_tools(client, monkeypatch):
    """未绑定科目的会话不开放产课/评估：直接观察路由交给 agent 的 tool_schemas。

    选这个观察点：SSE 不回吐工具声明，但 http 路由把 tool_schemas 作为参数交给
    agent.run_agent——在这里截获，能直接证明「未提供」，比断言工具执行报错更贴题。
    """
    from app import agent as agent_svc

    captured: list[list[dict]] = []

    async def fake_run_agent(turn_source, messages, ctx, emit, tool_schemas, **kwargs):
        captured.append(tool_schemas)
        await emit({"type": "text", "content": "收到"})
        return agent_svc.AgentOutcome(text="收到", rounds=1, tool_calls=0)

    monkeypatch.setattr(agent_svc, "run_agent", fake_run_agent)

    response = client.post(
        "/api/chat/stream",
        json={"message": "没有绑定科目", "fixture_scenario": "produce"},
    )
    assert response.status_code == 200
    names = {schema["name"] for schema in captured[0]}
    assert "produce_lesson" not in names
    assert "assess_node" not in names
