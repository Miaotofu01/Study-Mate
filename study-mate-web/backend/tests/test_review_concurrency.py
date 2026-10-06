"""并发守卫（R2/R8）的定向回归：会话一轮在飞时的拒绝与释放、跨会话/跨工作区并行、
编辑删除冲突、工具内冲突转 is_error、同 base 产课互斥。

全部走 temp data / fixture provider，不跑真实模型、不碰生产数据。
"""
from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from app import concurrency
from app import curriculum_store as cs
from app import draft as draft_svc
from app import storage
from app import workspace_ctx
from app.models import ChatRequest, RetryTicketRequest
from app.routers import chat as chat_router
from app.routers import production


@pytest.fixture(autouse=True)
def _clean_concurrency_registry():
    concurrency.reset()
    yield
    concurrency.reset()


# ---------- 模块原语 ----------


def test_acquire_release_and_conflict():
    concurrency.acquire("k", "占用")
    with pytest.raises(concurrency.ConflictError):
        concurrency.acquire("k", "再来")
    concurrency.release("k")
    concurrency.acquire("k", "复用")  # 释放后可再用
    concurrency.release("k")


def test_acquire_many_rolls_back_partial():
    concurrency.acquire("b", "占用")
    with pytest.raises(concurrency.ConflictError):
        concurrency.acquire_many([("a", "先占"), ("b", "冲突")])
    assert not concurrency.is_active("a"), "局部占用的键必须随失败回滚"
    assert concurrency.is_active("b")
    concurrency.release("b")


def test_produce_key_differs_by_base(tmp_path):
    a = concurrency.produce_key(tmp_path / "wsA" / "dup", "n")
    b = concurrency.produce_key(tmp_path / "wsB" / "dup", "n")
    assert a != b


def test_guarded_stream_releases_on_exhaustion():
    async def run():
        async def gen():
            yield "x"
            yield "y"

        lease = concurrency.acquire_many([("s1", "占用")])
        stream = concurrency.guarded_stream(gen(), lease)
        chunks = [chunk async for chunk in stream]
        assert chunks == ["x", "y"]
        assert not concurrency.is_active("s1")

    asyncio.run(run())


def test_guarded_stream_aclose_without_starting_releases():
    """生成器一次都没迭代就关闭：仍必须释放（Starlette 早退/未启动路径）。"""

    async def run():
        started = False

        async def gen():
            nonlocal started
            started = True
            yield "never"

        lease = concurrency.acquire_many([("s2", "占用")])
        stream = concurrency.guarded_stream(gen(), lease)
        await stream.aclose()
        assert not concurrency.is_active("s2")
        assert started is False

    asyncio.run(run())


def test_guarded_stream_releases_on_cancel():
    async def run():
        async def gen():
            yield "first"
            await asyncio.sleep(60)

        lease = concurrency.acquire_many([("s3", "占用")])
        stream = concurrency.guarded_stream(gen(), lease)

        async def consume():
            async for _ in stream:
                pass

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.05)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        assert not concurrency.is_active("s3")

    asyncio.run(run())


# ---------- F1：owner-token 租约防 ABA 双释放 ----------


def test_release_if_owner_rejects_stale_token():
    old = concurrency.acquire("aba", "旧占用")
    concurrency.release_if_owner("aba", old)  # 旧 owner 正常释放
    new = concurrency.acquire("aba", "新占用")
    concurrency.release_if_owner("aba", old)  # 过期 token 不得误删新 owner
    assert concurrency.is_active("aba")
    concurrency.release_if_owner("aba", new)


def test_lease_release_is_once_then_new_owner_survives():
    lease = concurrency.acquire_many([("aba2", "占用")])
    lease.release()  # 模拟 iterator 耗尽先释放
    assert not concurrency.is_active("aba2")
    concurrency.acquire("aba2", "新 owner")
    lease.release()  # 模拟迟到的 background：once + token 校验都不该误删
    assert concurrency.is_active("aba2")
    concurrency.release("aba2")


def test_guarded_stream_old_lease_cannot_release_new_owner():
    """真实序列：耗尽释放 → 同键重新 acquire → 旧 background(aclose) → 新锁仍 active。"""

    async def run():
        async def gen():
            yield "x"

        lease = concurrency.acquire_many([("aba3", "占用")])
        stream = concurrency.guarded_stream(gen(), lease)
        async for _ in stream:
            pass
        assert not concurrency.is_active("aba3")

        concurrency.acquire("aba3", "新 owner")
        await stream.aclose()  # 旧 background 兜底路径
        assert concurrency.is_active("aba3"), "旧租约不得释放新 owner"
        concurrency.release("aba3")

    asyncio.run(run())


# ---------- 会话：拒绝 / 释放 / 并行 ----------


def test_chat_same_session_second_request_409_then_release(client):
    sid = storage.create_session("并发会话")["id"]

    async def run():
        first = await chat_router.chat_stream(ChatRequest(message="第一轮", session_id=sid))
        assert isinstance(first, StreamingResponse)
        assert concurrency.is_active(concurrency.session_key(sid))

        rejected = await chat_router.chat_stream(ChatRequest(message="第二轮", session_id=sid))
        assert rejected.status_code == 409
        assert "正在处理" in rejected.body.decode("utf-8")
        # 被拒绝的请求不得落任何消息
        assert len(storage.require_session(sid)["messages"]) == 1

        await first.body_iterator.aclose()
        assert not concurrency.is_active(concurrency.session_key(sid))

        second = await chat_router.chat_stream(ChatRequest(message="第三轮", session_id=sid))
        await second.body_iterator.aclose()
        assert len(storage.require_session(sid)["messages"]) == 2

    asyncio.run(run())


def test_chat_cancel_releases_session(client):
    """前端点停止 → 流迭代被取消 → 守卫必须释放（正常停止后可用）。"""
    sid = storage.create_session("取消释放")["id"]

    async def run():
        resp = await chat_router.chat_stream(ChatRequest(message="开始", session_id=sid))
        stream = resp.body_iterator

        async def consume():
            async for _ in stream:
                pass

        task = asyncio.create_task(consume())
        # fixture 流每段 0.4s，确保已进入迭代再取消
        await asyncio.sleep(0.05)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

        for _ in range(100):
            if not concurrency.is_active(concurrency.session_key(sid)):
                break
            await asyncio.sleep(0.01)
        assert not concurrency.is_active(concurrency.session_key(sid))

    asyncio.run(run())


def test_chat_different_sessions_run_parallel(client):
    sid_a = storage.create_session("会话A")["id"]
    sid_b = storage.create_session("会话B")["id"]

    async def run():
        a = await chat_router.chat_stream(ChatRequest(message="a", session_id=sid_a))
        b = await chat_router.chat_stream(ChatRequest(message="b", session_id=sid_b))
        assert concurrency.is_active(concurrency.session_key(sid_a))
        assert concurrency.is_active(concurrency.session_key(sid_b))
        await a.body_iterator.aclose()
        await b.body_iterator.aclose()

    asyncio.run(run())


def test_edit_delete_rejected_while_session_busy(client):
    sid = storage.create_session("破坏操作")["id"]
    storage.add_message(sid, "user", "旧问题")
    storage.add_message(sid, "assistant", "旧回答")

    async def start():
        return await chat_router.chat_stream(ChatRequest(message="新一轮", session_id=sid))

    held = asyncio.run(start())
    try:
        assert client.delete(f"/api/sessions/{sid}/messages/0").status_code == 409
        assert client.delete(f"/api/sessions/{sid}").status_code == 409
        edited = client.post(
            "/api/chat/stream",
            json={"message": "编辑后的", "session_id": sid, "replace_from": 0},
        )
        assert edited.status_code == 409
        # 在飞期间旧消息一条都不能少
        assert len(storage.require_session(sid)["messages"]) == 3
    finally:
        asyncio.run(held.body_iterator.aclose())

    assert client.delete(f"/api/sessions/{sid}/messages/0").status_code == 200


# ---------- 生产：同 base 互斥 / 跨 workspace 并行 ----------


def _make_subject(root: Path, slug: str) -> None:
    with workspace_ctx.bind(root):
        cs.create_subject("同名科目", slug=slug)


def test_produce_same_base_rejected_other_workspace_parallel(client, tmp_path, monkeypatch):
    slug, node = "dup", "n1"
    ws_a, ws_b = tmp_path / "wsA", tmp_path / "wsB"
    _make_subject(ws_a, slug)
    _make_subject(ws_b, slug)

    async def fake_run_produce(*_args, **_kwargs):
        return None

    monkeypatch.setattr(production.produce_svc, "run_produce", fake_run_produce)
    base_a = ws_a / ".learning" / "subjects" / slug
    base_b = ws_b / ".learning" / "subjects" / slug

    async def collect(resp: StreamingResponse) -> None:
        async for _ in resp.body_iterator:
            pass

    async def run():
        held = await production.produce_node(slug, node, {"session_id": None}, workspace=str(ws_a))
        with pytest.raises(HTTPException) as excinfo:
            await production.produce_node(slug, node, {"session_id": None}, workspace=str(ws_a))
        assert excinfo.value.status_code == 409
        # 不同 workspace 的同 slug/同节点不被阻断（键按真实目录）
        other = await production.produce_node(slug, node, {"session_id": None}, workspace=str(ws_b))
        await collect(held)
        await collect(other)

    asyncio.run(run())
    assert not concurrency.is_active(concurrency.produce_key(base_a, node))
    assert not concurrency.is_active(concurrency.produce_key(base_b, node))


def test_quick_edit_conflicts_with_active_produce(client, tmp_path, monkeypatch):
    base = tmp_path / "quick"
    (base / "lessons").mkdir(parents=True)
    target = base / "lessons" / "0001-a.md"
    target.write_text("旧内容", encoding="utf-8")

    # 缺 workspace 的非草稿旧单如今一律 ambiguous（unscoped 也 409）；本用例验证快改
    # 与在飞产课互斥，故显式记归属，让 owned 路径照常走到写盘。
    ticket = {
        "id": "t1",
        "slug": "quick",
        "node_id": "a",
        "workspace": str(workspace_ctx.resolve()),
    }
    monkeypatch.setattr(production.tickets_svc, "get_ticket", lambda _tid: ticket)
    monkeypatch.setattr(production.tickets_svc, "ticket_dir_base", lambda _t: base)

    key = concurrency.produce_key(base.resolve(), "a")
    concurrency.acquire(key, "产课中")
    try:
        blocked = client.put(
            "/api/tickets/t1/artifact",
            json={"path": "lessons/0001-a.md", "content": "覆盖"},
        )
        assert blocked.status_code == 409
        assert target.read_text(encoding="utf-8") == "旧内容"
    finally:
        concurrency.release(key)

    ok = client.put(
        "/api/tickets/t1/artifact",
        json={"path": "lessons/0001-a.md", "content": "正常写入"},
    )
    assert ok.status_code == 200
    assert target.read_text(encoding="utf-8") == "正常写入"


def test_recheck_conflicts_with_active_produce(client, tmp_path, monkeypatch):
    base = tmp_path / "recheck"
    base.mkdir()
    ticket = {"id": "t2", "slug": "recheck", "node_id": "n1"}
    monkeypatch.setattr(production.tickets_svc, "get_ticket", lambda _tid: ticket)
    monkeypatch.setattr(production.tickets_svc, "ticket_dir_base", lambda _t: base)

    key = concurrency.produce_key(base, "n1")
    concurrency.acquire(key, "产课中")
    try:
        async def run():
            with pytest.raises(HTTPException) as excinfo:
                await production.recheck_ticket("t2", RetryTicketRequest(session_id=None), None)
            assert excinfo.value.status_code == 409

        asyncio.run(run())
    finally:
        concurrency.release(key)


def test_produce_conflict_does_not_create_orphan_session(client, tmp_path, monkeypatch):
    """F2：产课键冲突必须发生在建会话之前——409 不得留下孤儿 session。"""
    slug, node = "orphan", "n1"
    ws = tmp_path / "orphanws"
    _make_subject(ws, slug)
    base = ws / ".learning" / "subjects" / slug

    key = concurrency.produce_key(base, node)
    concurrency.acquire(key, "产课中")
    try:
        before = len(storage.list_sessions())

        async def run():
            with pytest.raises(HTTPException) as excinfo:
                await production.produce_node(slug, node, {"session_id": None}, workspace=str(ws))
            assert excinfo.value.status_code == 409

        asyncio.run(run())
        assert len(storage.list_sessions()) == before, "产课冲突不得新建会话（孤儿）"
    finally:
        concurrency.release(key)


def test_produce_existing_busy_session_rolls_back_keys(client, tmp_path, monkeypatch):
    """F2：已有会话在飞时，产课键与会话键一起回滚（不残留已占的产课键）。"""
    slug, node = "atomic", "n1"
    ws = tmp_path / "atomicws"
    _make_subject(ws, slug)
    base = ws / ".learning" / "subjects" / slug
    sid = storage.create_session("在飞会话")["id"]
    concurrency.acquire(concurrency.session_key(sid), "会话占用")

    async def fake_run_produce(*_a, **_k):
        return None

    monkeypatch.setattr(production.produce_svc, "run_produce", fake_run_produce)
    try:
        async def run():
            with pytest.raises(HTTPException) as excinfo:
                await production.produce_node(slug, node, {"session_id": sid}, workspace=str(ws))
            assert excinfo.value.status_code == 409

        asyncio.run(run())
        assert not concurrency.is_active(concurrency.produce_key(base, node)), "产课键必须随失败回滚"
        assert concurrency.is_active(concurrency.session_key(sid)), "他人占的会话键不得被动"
    finally:
        concurrency.release(concurrency.session_key(sid))


def test_draft_writes_blocked_while_build_scope_held(client):
    """F3：建课编排在飞时，promote / delete / materials 共用草稿键被阻断。"""
    slug = "conc-draft"
    draft_svc.create_draft("并发草稿", slug=slug)
    key = concurrency.produce_key(draft_svc.draft_dir(slug), None)
    concurrency.acquire(key, "建课中")
    try:
        assert client.post(f"/api/drafts/{slug}/promote", json={}).status_code == 409
        assert client.delete(f"/api/drafts/{slug}").status_code == 409
        assert (
            client.post(f"/api/drafts/{slug}/materials", json={"title": "t", "text": "body"}).status_code
            == 409
        )
    finally:
        concurrency.release(key)

    assert client.delete(f"/api/drafts/{slug}").status_code == 200


def test_delete_turn_mutates_under_session_lease(client, monkeypatch):
    """F4：删除整轮的读/校验/改必须在租约保护内（不能在 acquire 前算旧快照）。"""
    sid = storage.create_session("锁内重读")["id"]
    storage.add_message(sid, "user", "问题")
    storage.add_message(sid, "assistant", "回答")

    real_drop = storage.drop_messages
    seen = {}

    def spy(session_id, indices):
        seen["active"] = concurrency.is_active(concurrency.session_key(sid))
        return real_drop(session_id, indices)

    monkeypatch.setattr(storage, "drop_messages", spy)
    response = client.delete(f"/api/sessions/{sid}/messages/0")
    assert response.status_code == 200
    assert seen.get("active") is True, "删除必须在会话租约内执行"
    assert not concurrency.is_active(concurrency.session_key(sid)), "删除后租约必须释放"


# ---------- 工具内冲突：明确 tool error 而非 500 ----------


def test_produce_lesson_tool_conflict_is_error(client, monkeypatch):
    from app import tools as tools_svc

    slug, node = "toolbusy", "n1"
    ws = workspace_ctx.resolve()
    _make_subject(ws, slug)
    cs.save_curriculum(
        slug,
        {
            "nodes": [
                {
                    "id": node,
                    "title": "节点",
                    "objective": "目标",
                    "kind": "概念",
                    "prerequisites": [],
                    "concepts": [],
                    "pitfalls": [],
                    "status": "未开始",
                }
            ],
            "edges": [],
        },
    )
    base = ws / ".learning" / "subjects" / slug

    key = concurrency.produce_key(base, node)
    concurrency.acquire(key, "产课中")
    try:
        ctx = tools_svc.ToolContext(
            read_roots=[base],
            label="科目",
            state={"session_id": None, "slug": slug, "node_id": node, "emit": None},
        )
        result = asyncio.run(tools_svc.execute("produce_lesson", {"node_id": node}, ctx))
        assert result["is_error"] is True
        assert "正在产课" in result["content"]
    finally:
        concurrency.release(key)
