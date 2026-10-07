"""chat_once 总时限（绝对 deadline）回归测试。

锁住的确定性缺陷：
- 单次调用总时限必须覆盖重试与退避（per-read REQUEST_TIMEOUT 只在窗口内吐过字节
  时才不触发，兜不住"每 899s 吐一字节"的静默长跑）；
- deadline 到点抛 LLMDeadlineExceeded，且不再进重试（否则每次重试再给一整个时限，
  等于无限延长）；
- 默认取 STUDYMATE_LLM_MAX_SECONDS（MAX_SECONDS），max_seconds 可覆盖，<=0 不限时；
- 被取消的挂起尝试仍会关闭自建客户端；
- fixture 路径不受 deadline 影响（立即返回 canned）。
"""
from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import httpx
import pytest

from app import llm


def _run(coro):
    return asyncio.run(coro)


def _real_mode(monkeypatch):
    monkeypatch.setattr(llm, "is_fixture_mode", lambda: False)


PROVIDER = {"model": "m", "api_format": "openai_chat"}
MESSAGES = [{"role": "user", "content": "q"}]


def _hanging_client():
    """openai_chat 客户端假体：create 挂住，close 记录是否被调用。"""
    client = SimpleNamespace(closed=False)

    async def create(**kwargs):
        await asyncio.sleep(60)

    async def close():
        client.closed = True

    client.chat = SimpleNamespace(completions=SimpleNamespace(create=create))
    client.close = close
    return client


# ---------- 总时限覆盖退避与重试 ----------


def test_deadline_covers_backoff_and_stops_retrying(monkeypatch):
    _real_mode(monkeypatch)
    monkeypatch.setattr(llm, "LLM_RETRIES", 5)
    calls = {"n": 0}

    async def always_transient(provider, messages, json_mode):
        calls["n"] += 1
        raise httpx.ReadTimeout("t")

    monkeypatch.setattr(llm, "_chat_openai_chat", always_transient)
    start = time.monotonic()
    with pytest.raises(llm.LLMDeadlineExceeded):
        _run(llm.chat_once(PROVIDER, MESSAGES, max_seconds=0.3))
    elapsed = time.monotonic() - start
    assert calls["n"] == 1, "退避已吃掉全部预算，不该再发起第 2 次尝试"
    assert elapsed < 1.5, f"总时限应封住退避，实际 {elapsed:.2f}s"


def test_deadline_cancels_hanging_attempt(monkeypatch):
    _real_mode(monkeypatch)

    async def hangs(provider, messages, json_mode):
        await asyncio.sleep(60)
        return "late"

    monkeypatch.setattr(llm, "_chat_openai_chat", hangs)
    start = time.monotonic()
    with pytest.raises(llm.LLMDeadlineExceeded):
        _run(llm.chat_once(PROVIDER, MESSAGES, max_seconds=0.1))
    assert time.monotonic() - start < 2


def test_deadline_cancellation_closes_client(monkeypatch):
    """asyncio.wait_for 取消挂起尝试后，_chat_openai_chat 的 finally 仍应关闭客户端。"""
    _real_mode(monkeypatch)
    fake = _hanging_client()
    monkeypatch.setattr(llm, "build_client", lambda _p: fake)
    with pytest.raises(llm.LLMDeadlineExceeded):
        _run(llm.chat_once(PROVIDER, MESSAGES, max_seconds=0.1))
    assert fake.closed is True


def test_transient_retry_still_works_within_deadline(monkeypatch):
    """总时限只封上限，不误伤窗口内的正常瞬时重试。"""
    _real_mode(monkeypatch)
    monkeypatch.setattr(llm, "LLM_RETRIES", 3)
    calls = {"n": 0}

    async def flaky(provider, messages, json_mode):
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ReadTimeout("t")
        return "ok"

    monkeypatch.setattr(llm, "_chat_openai_chat", flaky)
    assert _run(llm.chat_once(PROVIDER, MESSAGES, max_seconds=10)) == "ok"
    assert calls["n"] == 2


# ---------- max_seconds 覆盖 / <=0 不限时 ----------


def test_max_seconds_overrides_default(monkeypatch):
    _real_mode(monkeypatch)
    monkeypatch.setattr(llm, "MAX_SECONDS", 0.05)

    async def slow_ok(provider, messages, json_mode):
        await asyncio.sleep(0.2)
        return "ok"

    monkeypatch.setattr(llm, "_chat_openai_chat", slow_ok)
    with pytest.raises(llm.LLMDeadlineExceeded):
        _run(llm.chat_once(PROVIDER, MESSAGES))
    assert _run(llm.chat_once(PROVIDER, MESSAGES, max_seconds=5)) == "ok"


def test_max_seconds_nonpositive_disables_deadline(monkeypatch):
    _real_mode(monkeypatch)
    monkeypatch.setattr(llm, "MAX_SECONDS", 0.01)

    async def slow_ok(provider, messages, json_mode):
        await asyncio.sleep(0.1)
        return "ok"

    monkeypatch.setattr(llm, "_chat_openai_chat", slow_ok)
    assert _run(llm.chat_once(PROVIDER, MESSAGES, max_seconds=0)) == "ok"


# ---------- 判据与 fixture 兼容 ----------


def test_deadline_exceeded_is_not_transient():
    """超时不得被外层当瞬时失败重试——否则单次调用无限延长。"""
    assert llm._is_transient(llm.LLMDeadlineExceeded("t")) is False


def test_fixture_path_ignores_deadline():
    # conftest 在 import 期就设了 STUDYMATE_E2E_FIXTURE=1（fixture_at_import=True）
    result = _run(llm.chat_once(PROVIDER, MESSAGES, fixture_kind="grade", max_seconds=0.0001))
    assert "verdict" in result
