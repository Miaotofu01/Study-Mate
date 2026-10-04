"""客户端中途断开（切会话 / 关页 / 点停止）时，已经流出去的回复必须落库。

真机现象（2026-10-04 维护者反馈）：重发一条建课消息，流式里看得见回复，切一下会话
就没了——因为两条路径都把落库放在"整条流跑完之后"：
- 工具路径（`_tool_event_source` + runner）：断开时 Starlette 取消 SSE 迭代任务、
  进而 `task.cancel()` 掉 runner，落库那几行执行不到；
- 纯流路径（`stream_chat`，模型声明不支持工具时走它）：落库在 while 循环之后，
  而 `CancelledError` 继承自 `BaseException`，原来的 `except Exception` 抓不到。
"""
from __future__ import annotations

import asyncio
import contextlib
import json

from app import storage
from app.routers.chat import _accumulate_partial, _persist_partial


def test_partial_bucket_accumulates_and_persists(client):
    session_id = storage.create_session("兜底落库")["id"]
    bucket = {"text": [], "reasoning": [], "tools": [], "notices": [], "usage": None}

    for event in (
        {"type": "reasoning", "content": "先想一下"},
        {"type": "text", "content": "半截回复"},
        {"type": "notice", "message": "讲解完成"},
        {"type": "tool_call", "id": "t1", "name": "list_workspace", "arguments": "{}"},
        {"type": "tool_result", "id": "t1", "name": "list_workspace", "content": "ok", "is_error": False},
        {"type": "usage", "usage": {"prompt_tokens": 7}},
    ):
        _accumulate_partial(bucket, event)

    _persist_partial(session_id, bucket, "my-api / 模型")

    messages = storage.require_session(session_id)["messages"]
    assert len(messages) == 1
    saved = messages[0]
    assert saved["role"] == "assistant" and saved["content"] == "半截回复"
    assert saved["reasoning"] == "先想一下"
    assert saved["model"] == "my-api / 模型"
    assert saved["tools"][0]["name"] == "list_workspace"
    assert saved["tools"][0]["status"] == "done" and saved["tools"][0]["isError"] is False
    assert any("中断" in item for item in saved["notices"])
    assert any("讲解完成" in item for item in saved["notices"])


def test_partial_persist_is_noop_when_nothing_produced(client):
    session_id = storage.create_session("空桶")["id"]
    bucket = {"text": [], "reasoning": [], "tools": [], "notices": [], "usage": None}
    _persist_partial(session_id, bucket, None)
    assert storage.require_session(session_id)["messages"] == []


def _drive_and_disconnect(session_id: str, body: dict) -> None:
    """手工喂 ASGI，等它开始吐 delta 后取消 app 任务——uvicorn 在客户端断开时就是这么做的。"""
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
        saw_delta = asyncio.Event()
        delivered = False
        idle = asyncio.Event()

        async def receive():
            # 请求体只给一次；之后挂住等断开——绝不能"秒回"空输入，
            # 那会让 Starlette 的断线监听空转（实测会把测试卡死）。
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": payload, "more_body": False}
            await idle.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.body" and b"delta" in message.get("body", b""):
                saw_delta.set()

        task = asyncio.create_task(app(scope, receive, send))
        await asyncio.wait_for(saw_delta.wait(), timeout=10)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        # 取消的传播要走几个事件循环滴答（runner / 生成器收到取消后才兜底落库）
        for _ in range(60):
            if any(m.get("role") == "assistant" for m in storage.require_session(session_id)["messages"]):
                return
            await asyncio.sleep(0.05)

    asyncio.run(run())


def test_disconnect_keeps_streamed_reply_of_tool_path(client, monkeypatch):
    """工具路径：断开后，流式里已经吐出的文字与工具调用都要在会话里留下。"""
    from app import agent as agent_svc

    session_id = storage.create_session("断开抢救-工具")["id"]

    async def fake_run_agent(turn_source, messages, ctx, emit, schemas, **kwargs):
        await emit({"type": "text", "content": "已经产出的半截回复"})
        await emit({"type": "tool_call", "id": "t1", "name": "list_workspace", "arguments": "{}"})
        await emit(
            {"type": "tool_result", "id": "t1", "name": "list_workspace", "content": "ok", "is_error": False}
        )
        await asyncio.sleep(60)  # 模拟长回合：真实建课/产课在这里会跑几分钟，用户正是这时切走
        raise AssertionError("断开后不该再跑完这一轮")

    monkeypatch.setattr(agent_svc, "run_agent", fake_run_agent)

    # fixture_scenario 落进 FIXTURE_TOOL_SCRIPTS 的键 ⇒ 走工具路径
    _drive_and_disconnect(session_id, {"message": "开始建课", "session_id": session_id, "fixture_scenario": "tools"})

    messages = storage.require_session(session_id)["messages"]
    assert messages, "断开后已经流出去的回复不该丢"
    saved = messages[-1]
    assert saved["role"] == "assistant"
    assert saved["content"] == "已经产出的半截回复"
    assert saved["tools"][0]["name"] == "list_workspace"
    assert any("中断" in item for item in saved.get("notices") or [])


def test_disconnect_keeps_streamed_reply_of_plain_path(client, monkeypatch):
    """纯流路径（模型不支持工具时）：断开同样要保住已经流出的正文。"""
    import app.routers.chat as chat

    session_id = storage.create_session("断开抢救-纯流")["id"]

    async def fake_stream_chat(provider, items, fixture_scenario=None):
        yield "半截正文"
        await asyncio.sleep(60)
        raise AssertionError("断开后不该再产出")

    monkeypatch.setattr(chat, "stream_chat", fake_stream_chat)

    _drive_and_disconnect(session_id, {"message": "讲个概念", "session_id": session_id})

    messages = storage.require_session(session_id)["messages"]
    assert messages, "断开后已经流出去的正文不该丢"
    saved = messages[-1]
    assert saved["role"] == "assistant"
    assert saved["content"] == "半截正文"
    assert any("中断" in item for item in saved.get("notices") or [])
