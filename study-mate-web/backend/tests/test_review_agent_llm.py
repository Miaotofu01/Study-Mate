"""本轮核心域审查的回归测试（llm / roles / tools / multimodal）。

锁住的确定性缺陷：
- openai_chat 路径（含 loopback 裸 httpx 客户端）每轮新建的客户端必须关闭；
- tools 被上游拒绝时的回落必须把 SDK 的 APIStatusError 也算上（原实现只认 ProviderError）；
- `_is_transient` 必须覆盖 responses/anthropic 走的 httpx 异常与 ProviderError 状态码；
- `_anthropic_payload` 不得产出相邻同角色消息（agent 的收尾/空闲提醒会触发）；
- 写路径的盘符相对 / UNC / 反斜杠 / ADS 越界必须在校验阶段拦掉并 resolve 兜底；
- Stage-2 降级时被放弃的生成器要 aclose；
- tools 被停用的强制收尾轮不得执行模型仍吐出的 tool_calls。
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx
import pytest

from app import errors, llm


def _run(coro):
    return asyncio.run(coro)


# ---------- 假流式客户端 ----------


def _make_client(chunks, fail=None, finish=True):
    """默认在末尾补一个 `finish_reason="stop"` 的终块；`finish=False` 模拟半途断流。"""
    client = SimpleNamespace()
    client.closed = False
    client.last_kwargs = None

    async def create(**kwargs):
        client.last_kwargs = kwargs
        if fail is not None:
            raise fail

        async def gen():
            stream = list(chunks)
            if finish:
                stream.append(_chunk(finish_reason="stop"))
            for chunk in stream:
                yield chunk

        return gen()

    async def close():
        client.closed = True

    client.chat = SimpleNamespace(completions=SimpleNamespace(create=create))
    client.close = close
    return client


def _chunk(*, content=None, tool_calls=None, usage=None, finish_reason=None):
    delta = SimpleNamespace(
        content=content, reasoning_content=None, reasoning=None, tool_calls=tool_calls
    )
    return SimpleNamespace(
        choices=[SimpleNamespace(delta=delta, finish_reason=finish_reason)], usage=usage
    )


def _real_mode(monkeypatch):
    monkeypatch.setattr(llm, "is_fixture_mode", lambda: False)


def _bad_request_error(status: int = 400):
    response = httpx.Response(status, request=httpx.Request("POST", "http://example.test"))
    return llm.APIStatusError("tools unsupported", response=response, body=None)


def _status_error(exc_cls, status: int):
    response = httpx.Response(status, request=httpx.Request("POST", "http://example.test"))
    return exc_cls("status", response=response, body=None)


# ---------- B1：客户端关闭 ----------


def test_openai_turn_closes_client(monkeypatch):
    fake = _make_client([_chunk(content="hi")])
    monkeypatch.setattr(llm, "build_client", lambda _p: fake)
    _real_mode(monkeypatch)

    async def drain():
        async for _ in llm._openai_chat_turn(
            {"model": "m", "api_format": "openai_chat"}, [{"role": "user", "content": "q"}], None, None
        ):
            pass

    _run(drain())
    assert fake.closed is True


def test_stream_chat_closes_client(monkeypatch):
    fake = _make_client([_chunk(content="a"), _chunk(content="b")])
    monkeypatch.setattr(llm, "build_client", lambda _p: fake)
    _real_mode(monkeypatch)

    async def collect():
        return [
            piece
            async for piece in llm.stream_chat(
                {"model": "m", "api_format": "openai_chat"}, [{"role": "user", "content": "q"}]
            )
        ]

    assert _run(collect()) == ["a", "b"]
    assert fake.closed is True


def test_stream_chat_flattens_list_content(monkeypatch):
    fake = _make_client([_chunk(content=[{"type": "text", "text": "hi"}])])
    monkeypatch.setattr(llm, "build_client", lambda _p: fake)
    _real_mode(monkeypatch)

    async def collect():
        return [
            piece
            async for piece in llm.stream_chat(
                {"model": "m", "api_format": "openai_chat"}, [{"role": "user", "content": "q"}]
            )
        ]

    assert _run(collect()) == ["hi"]


def test_stream_chat_raises_eof_when_finish_missing(monkeypatch):
    """有数据但缺 finish 标记必须判异常 EOF，不得当成功——恢复旧的"静默半截". 反向锁。"""
    fake = _make_client([_chunk(content="半截")], finish=False)
    monkeypatch.setattr(llm, "build_client", lambda _p: fake)
    _real_mode(monkeypatch)

    async def collect():
        return [
            piece
            async for piece in llm.stream_chat(
                {"model": "m", "api_format": "openai_chat"}, [{"role": "user", "content": "q"}]
            )
        ]

    with pytest.raises(errors.UpstreamEOFError):
        _run(collect())
    assert fake.closed is True


def test_chat_openai_chat_flattens_list_content(monkeypatch):
    """非流式聚合路径同样不得把 parts 列表 str() 成 Python repr（会破坏结构化 JSON）。"""
    fake = _make_client(
        [_chunk(content=[{"type": "text", "text": '{"a":'}, {"type": "text", "text": "1}"}])]
    )
    monkeypatch.setattr(llm, "build_client", lambda _p: fake)
    _real_mode(monkeypatch)

    text = _run(
        llm._chat_openai_chat(
            {"model": "m", "api_format": "openai_chat"}, [{"role": "user", "content": "q"}], True
        )
    )
    assert text == '{"a":1}'
    assert "type" not in text  # 不是 str(list) 的 repr
    assert fake.closed is True


def test_openai_chat_turn_flattens_list_content(monkeypatch):
    fake = _make_client([_chunk(content=[{"type": "text", "text": "你好"}])])
    monkeypatch.setattr(llm, "build_client", lambda _p: fake)
    _real_mode(monkeypatch)

    async def collect():
        return [
            event
            async for event in llm._openai_chat_turn(
                {"model": "m", "api_format": "openai_chat"},
                [{"role": "user", "content": "q"}],
                None,
                None,
            )
        ]

    events = _run(collect())
    assert events == [{"type": "text", "content": "你好"}]


# ---------- B2：tools 拒绝回落要认 SDK 状态错误 ----------


def test_stream_turn_falls_back_on_sdk_bad_request(monkeypatch):
    calls: list = []

    async def fake(provider, messages, tools, tool_choice):
        calls.append(tools)
        if tools:
            raise _bad_request_error(400)
        yield {"type": "text", "content": "fallback-text"}

    monkeypatch.setattr(llm, "TURN_IMPLEMENTATIONS", {"openai_chat": fake})
    _real_mode(monkeypatch)

    async def collect():
        return [
            event
            async for event in llm.stream_turn(
                {"api_format": "openai_chat", "model": "m"},
                [{"role": "user", "content": "q"}],
                tools=[{"name": "t", "description": "", "parameters": {}}],
            )
        ]

    out = _run(collect())
    assert calls[0] is not None and calls[1] is None, "tools 轮后应回落一次无 tools"
    assert out[-1] == {"type": "text", "content": "fallback-text"}


def test_stream_turn_propagates_non_400_status(monkeypatch):
    async def fake(provider, messages, tools, tool_choice):
        raise _bad_request_error(500)
        yield  # pragma: no cover

    monkeypatch.setattr(llm, "TURN_IMPLEMENTATIONS", {"openai_chat": fake})
    _real_mode(monkeypatch)

    async def collect():
        return [
            event
            async for event in llm.stream_turn(
                {"api_format": "openai_chat", "model": "m"},
                [{"role": "user", "content": "q"}],
                tools=[{"name": "t", "description": "", "parameters": {}}],
            )
        ]

    with pytest.raises(llm.APIStatusError):
        _run(collect())


# ---------- B3：瞬态判据覆盖 httpx 与 ProviderError ----------


def test_is_transient_covers_httpx_and_provider_error():
    assert llm._is_transient(httpx.ReadTimeout("t")) is True
    assert llm._is_transient(httpx.ConnectError("c")) is True
    assert llm._is_transient(llm.ProviderError("HTTP 503: upstream")) is True
    assert llm._is_transient(llm.ProviderError("HTTP 401: jitter")) is True
    assert llm._is_transient(llm.ProviderError("HTTP 400: bad request")) is False
    assert llm._is_transient(llm.ProviderError("no status")) is False


def test_is_transient_covers_sdk_status_errors_by_code():
    """SDK 状态子类按 status_code 与 ProviderError 同口径（429/409 也要重试）。"""
    from openai import BadRequestError, ConflictError, RateLimitError, UnprocessableEntityError

    assert llm._is_transient(_status_error(RateLimitError, 429)) is True
    assert llm._is_transient(_status_error(ConflictError, 409)) is True
    assert llm._is_transient(_status_error(BadRequestError, 400)) is False
    assert llm._is_transient(_status_error(UnprocessableEntityError, 422)) is False


# ---------- 回落只对"真 tools 拒绝"发生 ----------


def _stream_turn_collect(monkeypatch, exc):
    calls: list = []

    async def fake(provider, messages, tools, tool_choice):
        calls.append(tools)
        if tools:
            raise exc
        yield {"type": "text", "content": "fallback-text"}

    monkeypatch.setattr(llm, "TURN_IMPLEMENTATIONS", {"openai_chat": fake})
    _real_mode(monkeypatch)

    async def collect():
        return [
            event
            async for event in llm.stream_turn(
                {"api_format": "openai_chat", "model": "m"},
                [{"role": "user", "content": "q"}],
                tools=[{"name": "t", "description": "", "parameters": {}}],
            )
        ]

    return calls, collect


def test_stream_turn_does_not_fall_back_on_provider_error_status(monkeypatch):
    """ProviderError(HTTP 401/500) 不该剥工具重试一次——原样抛给瞬时重试层。"""
    for status in (401, 429, 500, 503):
        calls, collect = _stream_turn_collect(
            monkeypatch, llm.ProviderError(f"HTTP {status}: upstream")
        )
        with pytest.raises(llm.ProviderError):
            _run(collect())
        assert len(calls) == 1, f"HTTP {status} 只应调用一次（未回落），实际 {len(calls)}"


def test_stream_turn_falls_back_on_provider_error_400(monkeypatch):
    calls, collect = _stream_turn_collect(
        monkeypatch, llm.ProviderError("HTTP 400: tools not supported")
    )
    out = _run(collect())
    assert [c for c in calls] == [calls[0], None]
    assert out[-1] == {"type": "text", "content": "fallback-text"}


# ---------- B4：Anthropic 相邻同角色合并 ----------


def test_anthropic_payload_merges_adjacent_user_roles():
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "讲一下"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "c1", "name": "list_workspace", "arguments": "{}"}],
        },
        {"role": "tool", "tool_call_id": "c1", "name": "list_workspace", "content": "ok"},
        {"role": "user", "content": "（预算将尽：请尽快收尾。）"},
    ]
    payload = llm._anthropic_payload({"model": "m", "api_format": "anthropic"}, messages, False)
    roles = [message["role"] for message in payload["messages"]]
    assert roles == ["user", "assistant", "user"], roles
    last_blocks = [block["type"] for block in payload["messages"][-1]["content"]]
    assert last_blocks[0] == "tool_result", "tool_result 必须仍在 user 消息最前"
    assert "text" in last_blocks


# ---------- B5：写路径越界（Windows 语义，Linux 可跑） ----------


@pytest.mark.parametrize(
    "bad",
    [
        "C:evil.md",
        "..\\x.md",
        "\\\\server\\share\\x.md",
        "/etc/passwd",
        "lessons/a.md:stream",  # NTFS ADS
        "a\\b.md",
        "..",
    ],
)
def test_roles_envelope_rejects_windows_escape(bad):
    from app import roles

    with pytest.raises(ValueError):
        roles.envelope_files({"files": [{"path": bad, "content": "x"}]})


def test_roles_envelope_accepts_normal_path():
    from app import roles

    cleaned = roles.envelope_files(
        {"files": [{"path": "lessons/0001-a.md", "content": "正文"}]}
    )
    assert cleaned[0]["path"] == "lessons/0001-a.md"


def test_write_deliver_file_rejects_drive_relative(tmp_path):
    from app import tools as tools_svc

    ctx = tools_svc.ToolContext(
        read_roots=[], write_roots=[], label="x", state={"stage_dir": str(tmp_path / "stage")}
    )
    result = _run(
        tools_svc.execute("write_deliver_file", {"path": "C:evil.md", "content": "x"}, ctx)
    )
    assert result["is_error"] is True
    assert "sandbox" in result["content"]
    deliver = tmp_path / "stage" / "deliver"
    assert not deliver.exists() or not any(deliver.rglob("*"))


def test_safe_write_target_containment(tmp_path):
    from app.tools import SandboxError, safe_write_target

    base = tmp_path / "deliver"
    base.mkdir()
    target = safe_write_target(base, "lessons/a.md")
    assert base.resolve() in target.parents
    with pytest.raises(SandboxError):
        safe_write_target(base, "C:evil.md")
    with pytest.raises(SandboxError):
        safe_write_target(base, "..\\escape.md")


def test_roles_write_deliver_containment(tmp_path):
    from app import roles
    from app.tools import SandboxError

    with pytest.raises(SandboxError):
        roles.write_deliver(tmp_path / "stage", [{"path": "C:evil.md", "content": "x"}])


def test_read_within_still_allows_normal_path(tmp_path):
    from app import tools as tools_svc

    root = tmp_path / "subject"
    root.mkdir()
    (root / "MISSION.md").write_text("正文", encoding="utf-8")
    ctx = tools_svc.ToolContext(read_roots=[root], write_roots=[], label="科目")
    assert _run(tools_svc.execute("read_course_file", {"path": "MISSION.md"}, ctx))["is_error"] is False
    assert _run(tools_svc.execute("read_course_file", {"path": "C:\\Windows\\win.ini"}, ctx))["is_error"] is True


# ---------- B7：Stage-2 放弃的生成器要关闭 ----------


class _RecordingGen:
    def __init__(self, fail: bool):
        self.fail = fail
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.fail:
            raise RuntimeError("image input not supported")
        return "ok"

    async def aclose(self):
        self.closed = True


def test_prime_stream_closes_abandoned_generator():
    from app.multimodal import prime_stream

    first = _RecordingGen(True)
    second = _RecordingGen(False)
    sequence = [first, second]
    index = {"i": 0}

    def make_stream(items):
        gen = sequence[index["i"]]
        index["i"] += 1
        return gen

    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,AAAA"},
                    "_filename": "a.png",
                }
            ],
        }
    ]

    gen, first_piece, notice = _run(prime_stream(make_stream, messages, "custom-model"))
    assert first_piece == "ok"
    assert notice  # Stage-2 降级提示
    assert first.closed is True
    assert gen is second


# ---------- B8：tools 停用时不得执行 tool_calls ----------


def test_turn_suppresses_tool_calls_when_tools_disabled(monkeypatch):
    call = SimpleNamespace(
        index=0, id="c1", function=SimpleNamespace(name="list_workspace", arguments="{}")
    )
    fake = _make_client([_chunk(tool_calls=[call])])
    monkeypatch.setattr(llm, "build_client", lambda _p: fake)
    _real_mode(monkeypatch)
    provider = {"model": "m", "api_format": "openai_chat"}
    messages = [{"role": "user", "content": "q"}]

    async def collect(tools):
        return [event async for event in llm._openai_chat_turn(provider, messages, tools, None)]

    disabled = _run(collect(None))
    assert all(event["type"] != "tool_calls" for event in disabled)

    enabled = _run(collect([{"name": "list_workspace", "description": "", "parameters": {}}]))
    assert any(event["type"] == "tool_calls" for event in enabled)
