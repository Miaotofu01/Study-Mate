"""生产链路由：产课（C）、建课与落点确认（D）、草稿区、质检工单（④）。

SSE 编排端点的事件同时持久化为会话消息（kind: stage/handoff/done/error/
build_confirm），进度播报与失败卡按 §5.1 C 行拍板⑦④ 走 chat 流。
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import curriculum_store as cs
from .. import draft as draft_svc
from .. import produce as produce_svc
from .. import tickets as tickets_svc
from ..common import require_provider
from ..config import get_active_provider
from ..llm import is_fixture_mode
from ..models import (
    MaterialRequest,
    PromoteRequest,
    RetryTicketRequest,
    TicketQuickEditRequest,
)
from ..storage import add_message, create_session, require_session, update_session

router = APIRouter(prefix="/api", tags=["production"])

Event = dict[str, Any]


def _sse(event: str, data: Event) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _provider() -> dict[str, Any]:
    if is_fixture_mode():
        return {"model": "fixture", "api_format": "openai_chat"}
    provider = get_active_provider()
    if provider is None or not provider.get("api_key"):
        raise HTTPException(422, "尚未配置模型 API Key，请先到 Settings 填写。")
    return provider


def _persist_event(session_id: str, event: Event) -> None:
    """把关键事件写成会话消息（刷新后仍在）。start 级事件只流不存。"""
    kind = str(event.get("event"))
    if kind == "stage":
        if event.get("status") in ("done", "fail"):
            suffix = ""
            if event.get("status") == "done" and event.get("artifacts"):
                suffix = f"（{len(event['artifacts'])} 份产物）"
            elif event.get("status") == "done" and event.get("downloaded") is not None:
                suffix = f"（{event['downloaded']} 张，Gaps {len(event.get('gaps') or [])} 条）"
            elif event.get("status") == "done" and event.get("nodes") is not None:
                suffix = f"（{event['nodes']} 个节点）"
            add_message(
                session_id,
                "assistant",
                f"{'✅' if event.get('status') == 'done' else '⚠'} {event.get('stage', '')}{suffix}",
                kind="stage",
            )
        return
    if kind == "retry":
        owners = "、".join(event.get("owners") or [])
        add_message(session_id, "assistant", f"🔁 第 {event.get('round')} 轮打回（{owners}），附报错原文重派", kind="stage")
        return
    if kind == "handoff":
        ticket = event.get("ticket") or {}
        add_message(
            session_id,
            "assistant",
            f"质检未过，已转人工（工单 {ticket.get('id', '')}）",
            kind="handoff",
            ticket_id=ticket.get("id", ""),
        )
        return
    if kind == "done":
        message = str(event.get("message") or "编排完成")
        add_message(session_id, "assistant", message, kind="done", slug=event.get("slug"))
        return
    if kind == "error":
        add_message(session_id, "assistant", str(event.get("message") or "编排失败"), kind="error")
        return


async def _stream_orchestration(
    session_id: str, runner: Any
) -> StreamingResponse:
    """队列驱动的 SSE：runner 通过 emit 吐事件，事件转发并按规则持久化。

    持久化挂在 emit（生产侧）而非消费循环：客户端断连不再丢关键消息；
    生成器退出时回收 runner 任务（try/finally cancel）。
    """
    queue: asyncio.Queue[Event | None] = asyncio.Queue()

    async def emit(event: Event) -> None:
        _persist_event(session_id, event)
        await queue.put(event)

    async def event_generator():
        async def runner_safe():
            try:
                await runner(emit)
            except Exception as exc:  # noqa: BLE001 - 编排内未捕获异常统一转 error 事件
                await emit({"event": "error", "message": f"{type(exc).__name__}: {exc}"})
            await queue.put(None)

        task = asyncio.create_task(runner_safe())
        try:
            yield _sse("session", {"session_id": session_id})
            while True:
                event = await queue.get()
                if event is None:
                    break
                name = str(event.get("event") or "notice")
                payload = {k: v for k, v in event.items() if k != "event"}
                yield _sse(name, payload)
            await task
            yield _sse("finished", {"session_id": session_id})
        finally:
            task.cancel()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


def _session_for(payload_session: str | None, slug: str, node_id: str | None) -> str:
    if payload_session:
        try:
            require_session(payload_session)
            return payload_session
        except KeyError:
            pass
    session = create_session(title=f"{slug} 的编排")
    update_session(session["id"], subject_slug=slug, node_id=node_id)
    return str(session["id"])


# ---------- 产课链（C） ----------


@router.post("/courses/{slug}/nodes/{node_id}/produce")
async def produce_node(slug: str, node_id: str, payload: dict[str, Any] | None = None) -> StreamingResponse:
    require_subject(slug)
    session_id = _session_for((payload or {}).get("session_id"), slug, node_id)
    provider = _provider()

    async def runner(emit: Any) -> None:
        await produce_svc.run_produce(cs.subject_dir(slug), slug, node_id, provider, emit)

    return await _stream_orchestration(session_id, runner)


def require_subject(slug: str) -> dict[str, Any]:
    subject = cs.get_subject(slug)
    if subject is None:
        raise HTTPException(404, f"科目不存在：{slug}")
    return subject


# ---------- 建课链（D）：草稿区 + 编排 + 落点确认 ----------


@router.get("/drafts")
def list_drafts() -> list[dict[str, Any]]:
    return draft_svc.list_drafts()


@router.delete("/drafts/{slug}")
def delete_draft(slug: str) -> dict[str, bool]:
    if not draft_svc.delete_draft(slug):
        raise HTTPException(404, f"草稿不存在：{slug}")
    return {"ok": True}


@router.get("/drafts/{slug}")
def get_draft(slug: str) -> dict[str, Any]:
    draft = draft_svc.get_draft(slug)
    if draft is None:
        raise HTTPException(404, f"草稿不存在：{slug}")
    curriculum = draft_svc.draft_curriculum(slug) or {"nodes": [], "edges": []}
    materials = sorted(
        path.name for path in (draft_svc.draft_dir(slug) / "reference").glob("*.md")
    ) if (draft_svc.draft_dir(slug) / "reference").is_dir() else []
    return {"draft": draft, "curriculum": curriculum, "materials": materials}


@router.get("/drafts/{slug}/files/{file_path:path}")
def get_draft_file(slug: str, file_path: str) -> Any:
    """草稿内文件读取（质检工单快改的读取根与 PUT /tickets/{id}/artifact 一致）。"""
    from fastapi.responses import FileResponse

    if draft_svc.get_draft(slug) is None:
        raise HTTPException(404, f"草稿不存在：{slug}")
    base = draft_svc.draft_dir(slug).resolve()
    target = (base / file_path).resolve()
    if target != base and base not in target.parents:
        raise HTTPException(400, "路径越出草稿目录")
    if not target.is_file():
        raise HTTPException(404, f"文件不存在：{file_path}")
    return FileResponse(target)


@router.post("/drafts/{slug}/materials")
def add_material(slug: str, payload: MaterialRequest) -> dict[str, Any]:
    """用户给料 → 转 Markdown → reference/ + RESOURCES.md（不做主动检索）。"""
    if draft_svc.get_draft(slug) is None:
        raise HTTPException(404, f"草稿不存在：{slug}")
    title = payload.title.strip()
    text = payload.text.strip()
    if not title or not text:
        raise HTTPException(422, "title 与 text 均不能为空")
    markdown = f"# {title}\n\n{text}\n"
    rel = draft_svc.write_material(slug, title, markdown)
    return {"ok": True, "path": rel}


@router.post("/drafts/{slug}/build")
async def build_draft(slug: str, payload: dict[str, Any] | None = None) -> StreamingResponse:
    if draft_svc.get_draft(slug) is None:
        raise HTTPException(404, f"草稿不存在：{slug}")
    session_id = _session_for((payload or {}).get("session_id"), slug, None)
    provider = _provider()

    async def runner(emit: Any) -> None:
        from .. import build as build_svc

        await build_svc.run_build(slug, provider, emit)

    return await _stream_orchestration(session_id, runner)


@router.post("/drafts/{slug}/promote")
def promote_draft(slug: str, payload: PromoteRequest) -> dict[str, Any]:
    """落点确认：草稿整体搬进学习工作区并刷新主页。"""
    if draft_svc.get_draft(slug) is None:
        raise HTTPException(404, f"草稿不存在：{slug}")
    # 落点恒为发现链给出的工作区（任意路径作落点会绕过工作区边界，不开放）
    try:
        final = draft_svc.promote(slug)
    except FileExistsError as exc:
        raise HTTPException(409, str(exc)) from None
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from None
    return {"ok": True, "subject_dir": str(final)}


# ---------- 质检工单（④） ----------


@router.get("/tickets")
def list_tickets(slug: str | None = None, open_only: bool = False) -> list[dict[str, Any]]:
    return tickets_svc.list_tickets(slug=slug, open_only=open_only)


@router.get("/tickets/{ticket_id}")
def get_ticket(ticket_id: str) -> dict[str, Any]:
    ticket = tickets_svc.get_ticket(ticket_id)
    if ticket is None:
        raise HTTPException(404, f"工单不存在：{ticket_id}")
    ticket = dict(ticket)
    ticket["groups"] = tickets_svc.grouped_problems(ticket)
    ticket["base_dir"] = str(tickets_svc.ticket_dir_base(ticket))
    return ticket


@router.post("/tickets/{ticket_id}/retry")
async def retry_ticket(ticket_id: str, payload: RetryTicketRequest) -> StreamingResponse:
    ticket = tickets_svc.get_ticket(ticket_id)
    if ticket is None:
        raise HTTPException(404, f"工单不存在：{ticket_id}")
    session_id = _session_for(payload.session_id, str(ticket["slug"]), ticket.get("node_id"))
    provider = require_provider()

    async def runner(emit: Any) -> None:
        await produce_svc.run_ticket_retry(ticket_id, provider, emit, hint=payload.hint)

    return await _stream_orchestration(session_id, runner)


@router.post("/tickets/{ticket_id}/recheck")
async def recheck_ticket(ticket_id: str, payload: RetryTicketRequest) -> StreamingResponse:
    ticket = tickets_svc.get_ticket(ticket_id)
    if ticket is None:
        raise HTTPException(404, f"工单不存在：{ticket_id}")
    session_id = _session_for(payload.session_id, str(ticket["slug"]), ticket.get("node_id"))

    async def runner(emit: Any) -> None:
        await produce_svc.run_ticket_recheck(ticket_id, emit)

    return await _stream_orchestration(session_id, runner)


@router.put("/tickets/{ticket_id}/artifact")
def quick_edit_artifact(ticket_id: str, payload: TicketQuickEditRequest) -> dict[str, Any]:
    """单文件快改：文本产物 textarea 保存回科目目录（路径越出即拒）。"""
    ticket = tickets_svc.get_ticket(ticket_id)
    if ticket is None:
        raise HTTPException(404, f"工单不存在：{ticket_id}")
    base = tickets_svc.ticket_dir_base(ticket).resolve()
    target = (base / payload.path).resolve()
    if target != base and base not in target.parents:
        raise HTTPException(400, "路径越出科目目录")
    if not target.is_file():
        raise HTTPException(404, f"产物不存在：{payload.path}")
    target.write_text(payload.content, encoding="utf-8", newline="\n")
    return {"ok": True}


@router.post("/tickets/{ticket_id}/abandon")
def abandon_ticket(ticket_id: str) -> dict[str, Any]:
    ticket = tickets_svc.get_ticket(ticket_id)
    if ticket is None:
        raise HTTPException(404, f"工单不存在：{ticket_id}")
    tickets_svc.update_ticket(ticket_id, status="已放弃")
    return {"ok": True}
