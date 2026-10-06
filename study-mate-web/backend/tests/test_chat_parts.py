"""有序 parts、中途 checkpoint、断线中断落库与流状态。

覆盖（2026-10-05）：
- parts 事件顺序契约：text/reasoning/notice 相邻合并、tool_call 插引用、tool_result 原位更新；
- 正常终态：同一 turn_id 只留一条 assistant，`stream_state=completed`，旧字段仍在；
- 中途 checkpoint：工具执行中 getSession 能读到 `stream_state=streaming` 与有序 parts；
- 真实 CancelledError（ASGI 任务取消）：中断终态 + running 工具标中断 + 不重复 append；
- 无产出不建空 assistant；
- GET session 顶层 `streaming` 反映会话租约占用；
- 盘问收口标记从正文与 parts 一并剥掉。
"""
from __future__ import annotations

import asyncio
import contextlib
import json

from app import concurrency, storage
from app.routers.chat import (
    PARTIAL_DISCONNECT_NOTICE,
    _accumulate_partial,
    _clean_parts,
    _clean_text,
    _persist_partial,
    _queue_get_heartbeat,
    _record_part,
    _write_turn,
)


def _bucket() -> dict:
    return {"text": [], "reasoning": [], "tools": [], "notices": [], "parts": [], "usage": None}


def _assistants(session_id: str) -> list[dict]:
    return [
        msg
        for msg in storage.require_session(session_id)["messages"]
        if msg.get("role") == "assistant"
    ]


# ---------- 纯函数：parts 顺序契约 ----------


def test_record_part_coalesces_and_breaks_on_tool():
    parts: list[dict] = []
    for event in (
        {"type": "reasoning", "content": "先想"},
        {"type": "reasoning", "content": "一下"},
        {"type": "text", "content": "正文一"},
        {"type": "tool_call", "id": "t1", "name": "list_workspace", "arguments": "{}"},
        {"type": "tool_result", "id": "t1", "content": "ok", "is_error": False},
        {"type": "text", "content": "正文二"},
        {"type": "text", "content": "接上"},
        {"type": "notice", "message": "提示"},
    ):
        _record_part(parts, event)
    assert parts == [
        {"type": "reasoning", "text": "先想一下"},
        {"type": "text", "text": "正文一"},
        {"type": "tool", "tool_id": "t1"},
        {"type": "text", "text": "正文二接上"},
        {"type": "notice", "text": "提示"},
    ]


def test_accumulate_partial_records_parts_in_order():
    bucket = _bucket()
    for event in (
        {"type": "reasoning", "content": "想"},
        {"type": "notice", "message": "提示"},
        {"type": "text", "content": "正文"},
        {"type": "tool_call", "id": "t1", "name": "x", "arguments": "{}"},
    ):
        _accumulate_partial(bucket, event)
    assert [part["type"] for part in bucket["parts"]] == ["reasoning", "notice", "text", "tool"]
    assert bucket["notices"] == ["提示"]
    assert bucket["tools"][0]["id"] == "t1" and bucket["tools"][0]["status"] == "running"


def test_notice_parts_stay_individual_and_match_notices_array(client):
    """notice 不参与相邻合并：每个事件独立一个 part，且与 notices 数组逐条对应。"""
    parts: list[dict] = []
    for event in (
        {"type": "notice", "message": "提示一"},
        {"type": "notice", "message": "提示二"},
    ):
        _record_part(parts, event)
    assert parts == [
        {"type": "notice", "text": "提示一"},
        {"type": "notice", "text": "提示二"},
    ]

    bucket = _bucket()
    for event in (
        {"type": "notice", "message": "提示一"},
        {"type": "notice", "message": "提示二"},
        {"type": "text", "content": "正文"},
        {"type": "notice", "message": "提示二"},
    ):
        _accumulate_partial(bucket, event)
    notice_texts = [part["text"] for part in bucket["parts"] if part["type"] == "notice"]
    assert notice_texts == ["提示一", "提示二", "提示二"] == bucket["notices"]
    assert [part["type"] for part in bucket["parts"]] == ["notice", "notice", "text", "notice"]

    session_id = storage.create_session("通知顺序")["id"]
    _write_turn(session_id, bucket, "m", turn_id="turn-1", final=True)
    saved = _assistants(session_id)[0]
    saved_notice_parts = [
        part["text"] for part in saved["parts"] if part["type"] == "notice"
    ]
    assert saved_notice_parts == saved["notices"]


# ---------- storage.upsert_turn_message ----------


def test_upsert_turn_message_is_index_preserving(client):
    session_id = storage.create_session("upsert")["id"]
    storage.add_message(session_id, "user", "问题")
    storage.upsert_turn_message(
        session_id, "turn-1", content="半截", parts=[{"type": "text", "text": "半截"}],
        stream_state="streaming",
    )
    storage.upsert_turn_message(
        session_id, "turn-1", content="完整", parts=[{"type": "text", "text": "完整"}],
        stream_state="completed",
    )
    messages = storage.require_session(session_id)["messages"]
    assert len(messages) == 2 and messages[0]["content"] == "问题"
    assert messages[1]["content"] == "完整"
    assert messages[1]["stream_state"] == "completed"
    assert storage.require_session(session_id)["messages"][1]["turn_id"] == "turn-1"


# ---------- _write_turn 终态语义 ----------


def test_write_turn_marks_running_tool_interrupted_on_disconnect(client):
    session_id = storage.create_session("中断")["id"]
    bucket = _bucket()
    _accumulate_partial(bucket, {"type": "text", "content": "半截正文"})
    _accumulate_partial(
        bucket, {"type": "tool_call", "id": "t1", "name": "produce_lesson", "arguments": "{}"}
    )
    assert _persist_partial(session_id, bucket, "m", reason="disconnect", turn_id="turn-1")
    # 同一 turn_id 的终态可重复覆盖：不新增第二条
    assert _persist_partial(session_id, bucket, "m", reason="disconnect", turn_id="turn-1")
    assistants = _assistants(session_id)
    assert len(assistants) == 1
    saved = assistants[0]
    assert saved["content"] == "半截正文"
    assert saved["stream_state"] == "interrupted"
    tools = saved["tools"]
    assert tools[0]["status"] == "error" and tools[0]["isError"] is True
    assert "未收到执行结果" in tools[0]["result"]
    assert [part["type"] for part in saved["parts"]] == ["text", "tool"]
    # 新结构：真实错误落 `error` 终态，不再只发灰 notice。
    assert saved["error"]["code"] == "upstream_transport"
    assert saved["error"]["stopped_reason"] == "disconnect"
    assert saved["stopped_reason"] == "disconnect"
    assert PARTIAL_DISCONNECT_NOTICE not in (saved.get("notices") or [])


def test_write_turn_no_empty_assistant_for_notice_only(client):
    session_id = storage.create_session("无产出")["id"]
    bucket = _bucket()
    _accumulate_partial(bucket, {"type": "notice", "message": "模型已回退"})
    assert _write_turn(session_id, bucket, "m", turn_id="turn-1", final=True) is False
    assert _assistants(session_id) == []


def test_write_turn_strips_interview_marker_from_parts(client):
    session_id = storage.create_session("剥标记")["id"]
    marker = (
        "<!--INTERVIEW_RESULT-->"
        + json.dumps({"name": "Python"}, ensure_ascii=False)
        + "<!--/INTERVIEW_RESULT-->"
    )
    bucket = _bucket()
    _accumulate_partial(bucket, {"type": "text", "content": f"前言{marker}后记"})
    _write_turn(session_id, bucket, "m", turn_id="turn-1", final=True)
    saved = _assistants(session_id)[0]
    assert "<!--INTERVIEW_RESULT-->" not in saved["content"]
    text = "".join(p["text"] for p in saved["parts"] if p["type"] == "text")
    assert "<!--INTERVIEW_RESULT-->" not in text and "前言后记" in text


def test_clean_parts_keeps_internal_whitespace_and_positions():
    """' Hello ' / tool / ' world '：只裁全局首尾，内部空白保留，tool 位置不动。"""
    parts = [
        {"type": "text", "text": " Hello "},
        {"type": "tool", "tool_id": "t1"},
        {"type": "text", "text": " world "},
    ]
    cleaned = _clean_parts(parts)
    assert cleaned == [
        {"type": "text", "text": "Hello "},
        {"type": "tool", "tool_id": "t1"},
        {"type": "text", "text": " world"},
    ]
    assert "".join(p["text"] for p in cleaned if p["type"] == "text") == "Hello  world"


def test_write_turn_hello_world_preserves_internal_space(client):
    """存储不能把 'Hello ' + 'world' 粘成 Helloworld（模型历史/复制都会受损）。"""
    session_id = storage.create_session("HelloWorld")["id"]
    bucket = _bucket()
    for event in (
        {"type": "text", "content": " Hello "},
        {"type": "tool_call", "id": "t1", "name": "x", "arguments": "{}"},
        {"type": "text", "content": " world "},
    ):
        _accumulate_partial(bucket, event)
    _write_turn(session_id, bucket, "m", turn_id="turn-1", final=True)
    saved = _assistants(session_id)[0]
    assert saved["content"] == "Hello  world"
    assert [part["text"] for part in saved["parts"] if part["type"] == "text"] == [
        "Hello ",
        " world",
    ]
    assert [part["type"] for part in saved["parts"]] == ["text", "tool", "text"]


def test_clean_parts_hides_cross_notice_marker_without_moving_neighbors():
    """标记跨 notice 断开：JSON 不泄露，前后 text 与非 text 片段位置不变。"""
    parts = [
        {"type": "text", "text": "前"},
        {"type": "tool", "tool_id": "t2"},
        {"type": "text", "text": '<!--INTERVIEW_RESULT-->{"name": "X"}'},
        {"type": "notice", "text": "提示"},
        {"type": "text", "text": "<!--/INTERVIEW_RESULT-->后"},
    ]
    cleaned = _clean_parts(parts)
    assert [part["type"] for part in cleaned] == ["text", "tool", "notice", "text"]
    assert cleaned[0]["text"] == "前"
    assert cleaned[3]["text"] == "后"
    assert cleaned[2] == {"type": "notice", "text": "提示"}
    visible = "".join(part["text"] for part in cleaned if part["type"] == "text")
    assert "INTERVIEW_RESULT" not in visible and '"name"' not in visible


def test_clean_text_matches_clean_parts_concatenation_for_marker():
    raw = '前言<!--INTERVIEW_RESULT-->{"name": "X"}<!--/INTERVIEW_RESULT-->后记'
    assert _clean_text(raw) == "前言后记"
    assert _clean_parts([{"type": "text", "text": raw}]) == [
        {"type": "text", "text": "前言后记"}
    ]


def test_write_turn_content_equals_text_parts_join_with_whitespace(client):
    """普通换行/空白也不逐片段 trim：全局裁首尾、保留内部空白、join==content。"""
    session_id = storage.create_session("换行trim")["id"]
    bucket = _bucket()
    for event in (
        {"type": "text", "content": " A \n"},
        {"type": "tool_call", "id": "t1", "name": "x", "arguments": "{}"},
        {"type": "text", "content": "\n B "},
    ):
        _accumulate_partial(bucket, event)
    _write_turn(session_id, bucket, "m", turn_id="turn-1", final=True)
    saved = _assistants(session_id)[0]
    assert [part["type"] for part in saved["parts"]] == ["text", "tool", "text"]
    texts = [part["text"] for part in saved["parts"] if part["type"] == "text"]
    assert texts == ["A \n", "\n B"]
    assert saved["content"] == "A \n\n B"
    assert "".join(texts) == saved["content"]


# ---------- SSE 心跳 helper：取消不留悬挂 getter ----------


def test_queue_get_heartbeat_cancels_getter_on_outer_cancel(monkeypatch):
    import app.routers.chat as chat

    monkeypatch.setattr(chat, "HEARTBEAT_INTERVAL", 30.0)

    async def run() -> None:
        queue: asyncio.Queue = asyncio.Queue()
        baseline = set(asyncio.all_tasks())
        task = asyncio.create_task(chat._queue_get_heartbeat(queue))
        await asyncio.sleep(0.05)  # 进入 asyncio.wait，getter 已挂起
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await asyncio.sleep(0.05)  # 让 finally 的取消收殓落地
        leftover = [
            pending
            for pending in asyncio.all_tasks()
            if pending not in baseline and pending is not asyncio.current_task()
        ]
        assert leftover == [], leftover
        assert not list(getattr(queue, "_getters", []))

    asyncio.run(run())


def test_queue_get_heartbeat_timeout_does_not_swallow_event(monkeypatch):
    import app.routers.chat as chat

    monkeypatch.setattr(chat, "HEARTBEAT_INTERVAL", 0.05)

    async def run() -> None:
        queue: asyncio.Queue = asyncio.Queue()
        assert await chat._queue_get_heartbeat(queue) is None  # 静默超时
        event = {"type": "text", "content": "x"}
        await queue.put(event)
        assert await chat._queue_get_heartbeat(queue) == event  # 事件不被心跳吞掉
        assert not list(getattr(queue, "_getters", []))

    asyncio.run(run())


# ---------- GET session 流状态 ----------


def test_get_session_exposes_streaming_and_stream_state(client):
    session_id = storage.create_session("流状态")["id"]
    bucket = _bucket()
    _accumulate_partial(bucket, {"type": "text", "content": "进行中"})
    _write_turn(session_id, bucket, "m", turn_id="turn-1")  # 中途 checkpoint
    token = concurrency.acquire(concurrency.session_key(session_id), "busy")
    try:
        body = client.get(f"/api/sessions/{session_id}").json()
        assert body["streaming"] is True
        assert body["messages"][0]["stream_state"] == "streaming"
    finally:
        concurrency.release_if_owner(concurrency.session_key(session_id), token)
    body = client.get(f"/api/sessions/{session_id}").json()
    assert body["streaming"] is False


# ---------- 端到端：正常终态的有序 parts ----------


def test_process_scenario_persists_ordered_parts(client):
    session_id = client.post("/api/sessions", json={}).json()["id"]
    body = client.post(
        "/api/chat/stream",
        json={"message": "走工具链", "session_id": session_id, "fixture_scenario": "process"},
    )
    assert body.status_code == 200 and "event: tool_call" in body.text

    assistants = _assistants(session_id)
    assert len(assistants) == 1
    saved = assistants[0]
    assert saved["stream_state"] == "completed"
    # 流顺序：3 段 reasoning 与 2 次工具调用交错，最后一段正文
    assert [part["type"] for part in saved["parts"]] == [
        "reasoning",
        "tool",
        "reasoning",
        "tool",
        "reasoning",
        "text",
    ]
    tool_ids = [part["tool_id"] for part in saved["parts"] if part["type"] == "tool"]
    assert tool_ids == [tool["id"] for tool in saved["tools"]]
    # 旧字段仍在，正文与 parts 文本一致
    content = saved["content"]
    assert "过程折叠场景" in content
    assert "".join(p["text"] for p in saved["parts"] if p["type"] == "text") == content
    assert [tool["name"] for tool in saved["tools"]] == ["list_workspace", "read_course_file"]


def test_stream_order_scenario_persists_interleaved_parts(client):
    """确定性流序 fixture：三段正文与两次工具调用交错，最终落库顺序可精确断言。"""
    session_id = client.post("/api/sessions", json={}).json()["id"]
    response = client.post(
        "/api/chat/stream",
        json={"message": "开始", "session_id": session_id, "fixture_scenario": "stream_order"},
    )
    assert response.status_code == 200
    saved = _assistants(session_id)[-1]
    assert saved["stream_state"] == "completed"
    assert [part["type"] for part in saved["parts"]] == [
        "reasoning",
        "text",
        "tool",
        "text",
        "tool",
        "text",
    ]
    texts = [part["text"] for part in saved["parts"] if part["type"] == "text"]
    assert texts == ["先检查学习进度。", "已查看进度，接着读取课件。", "本轮学习内容已整理完成。"]
    assert saved["content"] == "".join(texts)
    assert [part["tool_id"] for part in saved["parts"] if part["type"] == "tool"] == [
        "order-1",
        "order-2",
    ]


def test_plain_path_persists_text_parts(client):
    session_id = client.post("/api/sessions", json={}).json()["id"]
    response = client.post(
        "/api/chat/stream", json={"message": "讲个概念", "session_id": session_id}
    )
    assert response.status_code == 200
    assistants = _assistants(session_id)
    assert len(assistants) == 1
    saved = assistants[0]
    assert saved["stream_state"] == "completed"
    assert saved["parts"] and all(part["type"] == "text" for part in saved["parts"])
    assert "".join(p["text"] for p in saved["parts"]) == saved["content"]
    assert not saved.get("tools")


# ---------- 真实取消（ASGI 任务被取消） ----------


def _drive_and_cancel(session_id: str, body: dict, *, marker: bytes = b"delta", inspect=None) -> None:
    """手工喂 ASGI，等出站体命中 marker 后取消 app 任务（uvicorn 客户端断开即如此）。"""
    from app.main import app

    async def run() -> None:
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/api/chat/stream",
            "raw_path": b"/api/chat/stream",
            "query_string": b"",
            "root_path": "",
            "headers": [(b"host", b"test"), (b"content-type", b"application/json")],
            "client": ("test", 1234),
            "server": ("test", 80),
        }
        payload = json.dumps(body).encode()
        delivered = False
        idle = asyncio.Event()
        ready = asyncio.Event()
        buffer = bytearray()

        async def receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": payload, "more_body": False}
            await idle.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.body":
                buffer.extend(message.get("body", b""))
                if marker in bytes(buffer):
                    ready.set()

        task = asyncio.create_task(app(scope, receive, send))
        await asyncio.wait_for(ready.wait(), timeout=10)
        if inspect is not None:
            await inspect(session_id)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        for _ in range(80):
            msgs = _assistants(session_id)
            if msgs and msgs[-1].get("stream_state") in ("interrupted", "error"):
                return
            await asyncio.sleep(0.05)
        raise AssertionError("取消后没等到中断终态落库")

    asyncio.run(run())


def test_disconnect_mid_tool_marks_interrupted_and_keeps_order(client, monkeypatch):
    from app import agent as agent_svc

    session_id = storage.create_session("工具中断")["id"]

    async def fake_run_agent(turn_source, messages, ctx, emit, schemas, **kwargs):
        await emit({"type": "reasoning", "content": "先想一下"})
        await emit(
            {"type": "tool_call", "id": "t1", "name": "list_workspace", "arguments": "{}"}
        )
        await asyncio.sleep(60)
        raise AssertionError("断开后不该再跑完这一轮")

    monkeypatch.setattr(agent_svc, "run_agent", fake_run_agent)

    async def inspect(sid: str) -> None:
        # 工具执行中（真实取消前）：checkpoint 已可 GET，状态 streaming、顺序正确
        saved = _assistants(sid)[-1]
        assert saved["stream_state"] == "streaming"
        assert [part["type"] for part in saved["parts"]] == ["reasoning", "tool"]
        assert saved["tools"][0]["status"] == "running"

    _drive_and_cancel(
        session_id,
        {"message": "开始建课", "session_id": session_id, "fixture_scenario": "tools"},
        marker=b"tool_call",
        inspect=inspect,
    )

    assistants = _assistants(session_id)
    assert len(assistants) == 1
    saved = assistants[0]
    assert saved["stream_state"] == "interrupted"
    assert saved["content"] == "先想一下" or saved["content"] == ""
    assert [part["type"] for part in saved["parts"]] == ["reasoning", "tool"]
    assert saved["tools"][0]["status"] == "error" and saved["tools"][0]["isError"] is True
    assert saved["error"]["code"] == "upstream_transport"
    assert saved["error"]["stopped_reason"] == "disconnect"


def test_disconnect_plain_path_marks_interrupted(client, monkeypatch):
    import app.routers.chat as chat

    session_id = storage.create_session("纯流中断")["id"]

    async def fake_stream_chat(provider, items, fixture_scenario=None):
        yield "半截正文"
        await asyncio.sleep(60)
        raise AssertionError("断开后不该再产出")

    monkeypatch.setattr(chat, "stream_chat", fake_stream_chat)

    _drive_and_cancel(session_id, {"message": "讲个概念", "session_id": session_id})

    assistants = _assistants(session_id)
    assert len(assistants) == 1
    saved = assistants[0]
    assert saved["stream_state"] == "interrupted"
    assert saved["content"] == "半截正文"
    assert [part["type"] for part in saved["parts"]] == ["text"]
    assert saved["error"]["code"] == "upstream_transport"
    assert saved["error"]["stopped_reason"] == "disconnect"
