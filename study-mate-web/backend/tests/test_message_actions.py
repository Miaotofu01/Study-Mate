"""消息级操作：编辑重发（截断+重发）与删除整轮，以及 reasoning/usage/tools 的落库。

2026-10-04 拍板：编辑=从该条用户消息起截断再重发（等效重新生成回复）；删除=删整轮
（用户提问 + 助手回复成对删）；思维链/工具/用量随助手消息落库。
"""
from __future__ import annotations


DISCOVERY_STARTER = "不知道学什么，帮我选方向"


def _send(client, session_id: str | None, message: str, **extra):
    payload: dict = {"message": message, "session_id": session_id}
    payload.update(extra)
    response = client.post("/api/chat/stream", json=payload)
    assert response.status_code == 200
    return response.text


def _messages(client, session_id: str) -> list[dict]:
    return client.get(f"/api/sessions/{session_id}").json()["messages"]


def test_storage_truncate_and_drop(client):
    from app import storage

    session = storage.create_session(title="存储原语")
    for index in range(4):
        storage.add_message(session["id"], "user" if index % 2 == 0 else "assistant", f"m{index}")

    removed = storage.truncate_messages(session["id"], 2)
    assert [item["content"] for item in removed] == ["m2", "m3"]
    assert [item["content"] for item in storage.require_session(session["id"])["messages"]] == [
        "m0",
        "m1",
    ]

    # 越界起点不删任何东西；批量删按下标并返回被删项
    assert storage.truncate_messages(session["id"], 99) == []
    dropped = storage.drop_messages(session["id"], [1])
    assert [item["content"] for item in dropped] == ["m1"]
    assert [item["content"] for item in storage.require_session(session["id"])["messages"]] == ["m0"]


def test_edit_resend_truncates_and_replaces(client):
    session_id = client.post("/api/sessions", json={}).json()["id"]
    _send(client, session_id, "第一问")
    _send(client, session_id, "第二问")
    assert [m["role"] for m in _messages(client, session_id)] == [
        "user",
        "assistant",
        "user",
        "assistant",
    ]

    # 编辑第二条用户消息（下标 2）：截断其后全部消息，用新文本重发
    _send(client, session_id, "第二问（改）", replace_from=2)
    messages = _messages(client, session_id)
    assert len(messages) == 4
    assert messages[2]["content"] == "第二问（改）"
    assert messages[3]["role"] == "assistant"
    assert "第二问（改）" not in messages[0]["content"]
    # 被顶掉的旧答复不在历史里
    assert "第一问" in messages[0]["content"]


def test_edit_resend_keeps_reused_attachment(client):
    from app.config import UPLOADS_DIR

    session_id = client.post("/api/sessions", json={}).json()["id"]
    uploaded = client.post(
        "/api/uploads",
        data={"session_id": session_id},
        files={"file": ("note.txt", b"hello attachment", "text/plain")},
    ).json()

    _send(client, session_id, "带附件的一问", attachment_ids=[uploaded["id"]])
    stored = _messages(client, session_id)
    assert stored[0]["attachments"][0]["id"] == uploaded["id"]
    session_dir = UPLOADS_DIR / session_id
    assert list(session_dir.glob(f"{uploaded['id']}_*"))

    # 保留原附件重发：文件还在、附件记录还在
    _send(
        client,
        session_id,
        "带附件的一问（改）",
        attachment_ids=[uploaded["id"]],
        replace_from=0,
    )
    assert list(session_dir.glob(f"{uploaded['id']}_*"))
    rebuilt = _messages(client, session_id)
    assert rebuilt[0]["content"].startswith("带附件的一问（改）")
    assert rebuilt[0]["attachments"][0]["id"] == uploaded["id"]

    # 编辑时移除附件：文件被清理、新消息不再带附件
    _send(client, session_id, "不带附件的一问", replace_from=0)
    assert not list(session_dir.glob(f"{uploaded['id']}_*"))
    assert "attachments" not in _messages(client, session_id)[0]


def test_delete_turn_removes_pair(client):
    from app.config import UPLOADS_DIR

    session_id = client.post("/api/sessions", json={}).json()["id"]
    uploaded = client.post(
        "/api/uploads",
        data={"session_id": session_id},
        files={"file": ("note.txt", b"bye", "text/plain")},
    ).json()
    _send(client, session_id, "第一问", attachment_ids=[uploaded["id"]])
    _send(client, session_id, "第二问")
    assert len(_messages(client, session_id)) == 4
    assert list((UPLOADS_DIR / session_id).glob(f"{uploaded['id']}_*"))

    # 点助手回复上的删除（下标 1）：连它前面的用户消息一起删，附件一并清理
    response = client.delete(f"/api/sessions/{session_id}/messages/1")
    assert response.status_code == 200
    body = response.json()
    assert body["deleted"] == [0, 1]
    assert [m["content"] for m in body["messages"]] == ["第二问", body["messages"][1]["content"]]
    assert "第一问" not in [m["content"] for m in body["messages"]]
    assert not list((UPLOADS_DIR / session_id).glob(f"{uploaded['id']}_*"))

    # 点用户消息上的删除（下标 0）：连它后面的助手回复一起删
    response = client.delete(f"/api/sessions/{session_id}/messages/0")
    assert response.json()["deleted"] == [0, 1]
    assert client.get(f"/api/sessions/{session_id}").json()["messages"] == []


def test_delete_turn_rejects_missing_index(client):
    session_id = client.post("/api/sessions", json={}).json()["id"]
    _send(client, session_id, "只有一问")
    assert client.delete(f"/api/sessions/{session_id}/messages/9").status_code == 404
    assert client.delete("/api/sessions/does-not-exist/messages/0").status_code == 404


def test_assistant_message_persists_model_reasoning_tools_and_usage(client):
    session_id = client.post("/api/sessions", json={}).json()["id"]
    body = _send(client, session_id, "走工具链", fixture_scenario="process")

    # SSE 里应有思维链、两次工具调用与用量事件
    assert "event: reasoning" in body
    assert body.count("event: tool_call") == 2
    assert "event: tool_result" in body
    assert "event: usage" in body

    messages = _messages(client, session_id)
    assistant = messages[-1]
    assert assistant["role"] == "assistant"
    assert "过程折叠场景" in assistant["content"]
    # 落库：模型标识 / 思维链 / 工具调用（刷新后仍能回放折叠区）
    # 模型标识是「提供商 / 模型」；无提供商（纯 fixture）时为 fixture
    label = assistant["model"]
    assert isinstance(label, str) and label
    if "/" in label:
        provider_name, _, model_name = label.partition(" / ")
        assert provider_name and model_name
    else:
        assert label == "fixture"
    assert "先看看工作区" in assistant["reasoning"]
    assert [tool["name"] for tool in assistant["tools"]] == ["list_workspace", "read_course_file"]
    # 工作区可列出 → 成功；工作区里没有 MISSION.md → 以错误文本回填（循环不中断），状态落成 error
    assert assistant["tools"][0]["status"] == "done" and assistant["tools"][0]["isError"] is False
    assert assistant["tools"][1]["status"] == "error" and assistant["tools"][1]["isError"] is True

    # 会话级用量（右栏上下文窗口栏的数据源）
    session = client.get(f"/api/sessions/{session_id}").json()
    assert session["usage"]["prompt_tokens"] == 11500


def test_interview_marker_is_stripped_from_stored_message(client):
    """盘问收口标记是内部记账，不该留在会话正文里（维护者反馈的体验问题）。"""
    # 收口会真的建草稿（fixture 名字固定 → slug python）：前后各清一次，别污染别的用例
    # （test_production_flow 的同名用例依赖自己是第一个建它的）
    client.delete("/api/drafts/python")
    try:
        # 不预先建会话：mode 只在"新建会话"时生效（已有会话看它自己的 mode）
        body = _send(
            client,
            None,
            DISCOVERY_STARTER,
            mode="interview",
            fixture_scenario="interview",
        )
        session_id = client.get("/api/sessions").json()[0]["id"]

        messages = _messages(client, session_id)
        # fixture 的 interview 场景会收口 → 应落一张 build_confirm 卡
        assert any(m.get("kind") == "build_confirm" for m in messages), body
        plain_assistant = [
            m for m in messages if m["role"] == "assistant" and not m.get("kind")
        ]
        assert plain_assistant, messages
        for message in plain_assistant:
            assert "<!--INTERVIEW_RESULT-->" not in message["content"]
            assert "<!--/INTERVIEW_RESULT-->" not in message["content"]
            assert not message["content"].startswith("\n")
            assert message["content"] == message["content"].strip()
    finally:
        client.delete("/api/drafts/python")


def test_strip_interview_markers_helper():
    from app.routers.chat import _strip_interview_markers

    closed = '结论如下。\n\n<!--INTERVIEW_RESULT-->{"name": "X"}<!--/INTERVIEW_RESULT-->'
    assert _strip_interview_markers(closed) == "结论如下。"
    # 半截标记（流式期间只吐出一半）也要切掉
    assert _strip_interview_markers('结论。\n\n<!--INTERVIEW_RESULT-->{"nam') == "结论。"
    # 无标记时只做首尾去空白
    assert _strip_interview_markers("\n\n普通回复。\n") == "普通回复。"


def test_build_gate_retry_reports_real_owners(client, monkeypatch):
    """建课打回卡上的归属要与 problems 一致（此前硬编码「出题」，大纲问题其实归「课设」）。"""
    import asyncio

    from app import build, draft as draft_svc

    draft_svc.create_draft("归属核对课", slug="owner-probe", goal="核对打回卡归属")
    events: list[dict] = []

    async def fake_gate(_data):
        return [{"path": "curriculum.yaml", "line": "", "message": "节点 kind 非法", "owner": "课设"}]

    async def emit(event):
        events.append(event)

    monkeypatch.setattr(build, "run_curriculum_gate", fake_gate)
    monkeypatch.setattr(build, "_dispatch_curriculum", _fake_dispatch_with_curriculum)

    asyncio.run(build._curriculum_chain("owner-probe", "派工值", {"model": "m"}, emit))
    retries = [e for e in events if e.get("event") == "retry"]
    assert retries and retries[0]["owners"] == ["课设"], retries
    draft_svc.delete_draft("owner-probe")


async def _fake_dispatch_with_curriculum(provider, values, emit):
    return {"files": [], "data": {"nodes": [{"id": "a.b"}], "edges": []}, "report": {}}
