"""生产链路由：产课（C）、建课与落点确认（D）、草稿区、质检工单（④）。

SSE 编排端点的事件同时持久化为会话消息（kind: stage/handoff/done/error/
build_confirm），进度播报与失败卡按 §5.1 C 行拍板⑦④ 走 chat 流。

工作区口径（既有合同）：读写端点统一接受可选 `?workspace=`，绑定到该次请求；
SSE 端点的绑定还必须覆盖整个迭代期（runner 与它派生的大纲/采图子任务都在绑定内
创建），否则编排会落到全局发现的工作区，与会话级工作区脱节。
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from .. import concurrency
from .. import curriculum_store as cs
from .. import draft as draft_svc
from .. import produce as produce_svc
from .. import tickets as tickets_svc
from .. import workspace_ctx
from ..common import optional_workspace, require_provider
from ..llm import is_fixture_mode
from ..models import (
    AbandonTicketRequest,
    ClaimTicketRequest,
    MaterialRequest,
    PromoteRequest,
    RetryTicketRequest,
    TicketQuickEditRequest,
)
from ..storage import (
    add_message,
    create_session,
    delete_session,
    require_session,
    update_session,
)

router = APIRouter(prefix="/api", tags=["production"])

logger = logging.getLogger(__name__)

Event = dict[str, Any]


def _explicit_workspace(workspace: str | None) -> Path | None:
    """显式 `?workspace=` 路径（校验存在则 422）；未传返回 None。"""
    if workspace is None or not str(workspace).strip():
        return None
    return optional_workspace(str(workspace))


@contextmanager
def _request_scope(workspace: str | None):
    """请求级工作区绑定：显式传就绑定；未传**不改动** ContextVar。

    未传时绝不能 `bind(None)`——那会清掉调用者（如 workspace-files 令牌路由）
    已经绑定的工作区，导致读到全局工作区。
    """
    path = _explicit_workspace(workspace)
    if path is None:
        yield workspace_ctx.active()
        return
    with workspace_ctx.bind(path):
        yield path


def _stream_bound(workspace: str | None) -> Path | None:
    """SSE 迭代期要重新绑定的工作区：显式参数优先，否则沿用调用者当前绑定。"""
    path = _explicit_workspace(workspace)
    return path if path is not None else workspace_ctx.active()


def _sse(event: str, data: Event) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


SESSION_BUSY_MESSAGE = "该会话正在处理上一轮对话或编排，请等待它结束、或先停止后再试。"


def _produce_busy(base: Path, node_id: str | None) -> str:
    target = f"{base.name} / {node_id}" if node_id else base.name
    return f"该科目（节点）正在产课或编排中，请等待当前任务结束后再试：{target}。"


def _curriculum_busy(slug: str) -> str:
    return f"草稿「{slug}」正在建课编排中，请等待当前编排结束后再试。"


def _acquire_or_409(pairs: list[tuple[str, str]]) -> concurrency.Lease:
    """原子占用多个并发键并返回租约；任一冲突则整体回滚并把首个冲突转 409（不等待）。"""
    try:
        return concurrency.acquire_many(pairs)
    except concurrency.ConflictError as exc:
        raise HTTPException(409, str(exc)) from None


def _lease_add_or_409(lease: concurrency.Lease, key: str, message: str) -> None:
    """把单个键并入已有 Lease（如工单键已在手）；冲突转 409，已占的键由 lease 统一回滚。"""
    try:
        lease.add(key, concurrency.acquire(key, message))
    except concurrency.ConflictError as exc:
        raise HTTPException(409, str(exc)) from None


def _draft_scope_key(slug: str) -> str:
    """草稿级产课/编排目标键：草稿全局，键只按草稿目录（不按 workspace）。"""
    return concurrency.produce_key(draft_svc.draft_dir(slug), None)


@contextmanager
def _hold_draft(slug: str):
    """短作用域占草稿键：建课编排在飞时，破坏草稿的写操作（落点/删除/给料）一律 409。"""
    lease = _acquire_or_409([(_draft_scope_key(slug), _curriculum_busy(slug))])
    try:
        yield
    finally:
        lease.release()


def _provider(session_id: str | None = None) -> dict[str, Any]:
    """本次编排要用的 provider：给了会话就随会话绑定的模型，否则回落到全局默认。

    fixture 短路与「未配置」422 与旧实现逐字一致（require_provider 内同口径）。
    """
    if is_fixture_mode():
        return {"model": "fixture", "api_format": "openai_chat"}
    return require_provider(session_id)


def _provider_for(payload_session: str | None) -> dict[str, Any]:
    """请求带会话就按会话绑定取 provider；未带则保持原零参调用。"""
    return _provider(payload_session) if payload_session else _provider()


def _problem_lines(problems: Any, limit: int = 3) -> list[str]:
    """把 problems（dict 或 str 的混合列表）折成单行短文本，最多 limit 条。"""
    lines: list[str] = []
    for problem in problems or []:
        if isinstance(problem, dict):
            text = str(problem.get("message") or problem.get("path") or "")
        else:
            text = str(problem)
        text = " ".join(text.split())
        if not text:
            continue
        if len(text) > 40:
            text = text[:40] + "…"
        lines.append(text)
    return lines[:limit]


def _persist_event(session_id: str, event: Event) -> None:
    """把关键事件写成会话消息（刷新后仍在）。start 级事件只流不存。

    持久化是尽力而为：会话文件被并发删除、磁盘短暂不可写（Windows 读锁）都不该
    让编排的事件通道炸掉——否则 emit 二次抛异常会让 SSE 永无 finished（见
    `_stream_orchestration`）。失败只记日志，不改任何编排状态。
    """
    try:
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
                if event.get("problems"):
                    suffix += f"（问题 {len(event['problems'])} 条）"
                add_message(
                    session_id,
                    "assistant",
                    f"{'✅' if event.get('status') == 'done' else '⚠'} {event.get('stage', '')}{suffix}",
                    kind="stage",
                )
            return
        if kind == "retry":
            owners = "、".join(event.get("owners") or [])
            # 事件可辨：派工层重派带 reason（envelope 不合规）；编排自检打回没有。
            marker = "（派工）" if event.get("reason") else "（自检）"
            raw_problems = event.get("problems") or []
            problems = _problem_lines(raw_problems)
            detail = f" · 问题 {len(raw_problems)} 条：{'；'.join(problems)}" if problems else ""
            add_message(
                session_id,
                "assistant",
                f"🔁 第 {event.get('round')} 轮打回（{owners}）{marker}{detail}",
                kind="stage",
            )
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
    except Exception as exc:  # noqa: BLE001 - 持久化失败不得打断事件通道
        logger.warning("编排事件持久化失败（session=%s event=%s）：%s", session_id, event.get("event"), exc)


async def _stream_orchestration(
    session_id: str,
    runner: Any,
    bound: Path | None = None,
    release_lease: concurrency.Lease | None = None,
) -> StreamingResponse:
    """队列驱动的 SSE：runner 通过 emit 吐事件，事件转发并按规则持久化。

    持久化挂在 emit（生产侧）而非消费循环：客户端断连不再丢关键消息；
    生成器退出时回收 runner 任务（try/finally cancel）。

    `bound` 是本次请求的工作区绑定路径；在迭代期重新绑定（StreamingResponse 在
    独立任务里迭代，ContextVar 不跨任务共享），且 create_task 发生在这个绑定内，
    所以 runner 及其 `asyncio.create_task` 派生的子任务都继承同一工作区。

    `release_lease` 是本次请求占用的并发键租约（会话 + 产课目标）；generator
    finally 与 background 共享它，释放 once + owner-token 校验，防 ABA。
    """
    queue: asyncio.Queue[Event | None] = asyncio.Queue()
    lease = release_lease or concurrency.Lease()

    async def emit(event: Event) -> None:
        _persist_event(session_id, event)
        await queue.put(event)

    async def event_generator():
        with workspace_ctx.bind(bound):
            async def runner_safe():
                try:
                    await runner(emit)
                except Exception as exc:  # noqa: BLE001 - 编排内未捕获异常统一转 error 事件
                    with contextlib.suppress(Exception):
                        await emit({"event": "error", "message": f"{type(exc).__name__}: {exc}"})
                finally:
                    # 无论成功/异常/持久化失败都必须收尾，否则消费循环永远等不到 None
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
                lease.release()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
        background=BackgroundTask(lease.release),
    )


def _guarded_orchestration(
    *,
    scope_pairs: list[tuple[str, str]],
    requested_session: str | None,
    slug: str,
    node_id: str | None,
    bound: Path | None = None,
    lease: concurrency.Lease | None = None,
) -> tuple[concurrency.Lease, str]:
    """编排入口的并发守卫：**先占产课目标键，再建/取会话并占会话键**。

    顺序很重要：产课键冲突时在创建会话之前就 409，不会留下孤儿 session；
    会话键冲突（已有会话在飞）则回滚产课键并删掉本次新建的会话。已有会话时
    两把键经同一 Lease 组合，失败一起回滚（原子）。

    `lease` 允许调用方先占用更外层的键（如工单键）再并入本函数——工单键必须在
    读取工单之前就占住，才能避免认领改归属与 runner 取 base 交错。
    """
    lease = lease if lease is not None else _acquire_or_409(scope_pairs)
    created = False
    session_id = ""
    try:
        if requested_session:
            try:
                require_session(requested_session)
                session_id = requested_session
            except KeyError:
                requested_session = None
        if not requested_session:
            session = create_session(
                title=f"{slug} 的编排", workspace=str(bound) if bound is not None else None
            )
            session_id = str(session["id"])
            update_session(session_id, subject_slug=slug, node_id=node_id)
            created = True
        key = concurrency.session_key(session_id)
        try:
            lease.add(key, concurrency.acquire(key, SESSION_BUSY_MESSAGE))
        except concurrency.ConflictError as exc:
            raise HTTPException(409, str(exc)) from None
        return lease, session_id
    except BaseException:
        lease.release()
        if created and session_id:
            delete_session(session_id)
        raise


def _require_draft(slug: str) -> dict[str, Any]:
    """草稿必须存在；非法/越界 slug 一律 404 且不触盘（draft_dir 在写盘前校验）。"""
    try:
        draft = draft_svc.get_draft(slug)
    except ValueError:
        raise HTTPException(404, f"草稿不存在：{slug}") from None
    if draft is None:
        raise HTTPException(404, f"草稿不存在：{slug}")
    return draft


def _assert_ticket_workspace(ticket: dict[str, Any], bound: Path | None) -> None:
    """写入端点的归属校验：**unknown 无论是否带 ?workspace= 都不得放行**。

    - owned：按工单记录归属放行（unscoped 也用记录，base 不依赖请求 scope）。
    - legacy_draft：草稿区全局，放行。
    - other：scoped 请求明确属于别的工作区 → 404；unscoped 时记录即权威、base 取记录，放行。
    - ambiguous：无记录可证归属 → 409（scoped/unscoped 一致），绝不回落到「当前工作区
      同 slug」猜测归属；须先显式认领或直接放弃。
    """
    state = tickets_svc.ticket_ownership(ticket, _effective_workspace(bound))
    if state in ("owned", "legacy_draft"):
        return
    if state == "other":
        if bound is None:
            return
        raise HTTPException(404, f"工单不属于该工作区：{ticket.get('id', '')}")
    raise HTTPException(
        409,
        f"旧工单未记录工作区，无法确认归属：{ticket.get('id', '')}。"
        "请先在工单里确认归属（认领到目标工作区）或直接放弃，避免误改另一工作区的同名科目。",
    )


def _ticket_busy(ticket_id: str) -> str:
    return f"该工单正在处理中，请稍后再试：{ticket_id}。"


def _acquire_ticket(ticket_id: str) -> concurrency.Lease:
    """先占工单键（owner-token Lease）：重试/复检整段、快改/认领/放弃短作用域共用。

    工单键必须在读取工单之前占住——否则认领改归属可能与本请求取到的 base 交错，
    runner 会写到改归属后的目录。冲突即 409，不等待。
    """
    return _acquire_or_409([(concurrency.ticket_key(ticket_id), _ticket_busy(ticket_id))])


def _target_workspace_ok(workspace: Path, slug: str, node_id: str | None) -> bool:
    """目标工作区是否可承载该工单：合法 slug + 确有同 slug 科目（有节点则须含该节点）。

    只读盘校验，不建文件、不改归属；用于列表「可认领」判定与认领的显式校验。
    """
    if not cs.is_valid_slug(slug):
        return False
    with workspace_ctx.bind(workspace):
        if cs.get_subject(slug) is None:
            return False
        if node_id:
            curriculum = cs.get_curriculum(slug) or {}
            nodes = curriculum.get("nodes") or []
            if not any(str(n.get("id")) == str(node_id) for n in nodes):
                return False
    return True


def _effective_workspace(bound: Path | None) -> str:
    """本次请求的判定基准工作区：显式绑定优先，否则用当前解析的工作区。"""
    return str(bound) if bound is not None else str(workspace_ctx.resolve())


def _ticket_detail(ticket: dict[str, Any], bound: Path | None) -> dict[str, Any]:
    """scoped/unscoped 统一的工单详情：归属明确 + 模糊时 base_dir=None。

    - scoped 且明确属于别处（other）→ 404，绝不切过去。
    - ambiguous（归属无法证实）→ 200 只读，workspace_ambiguous=True、base_dir=None。
    - 其余（owned/legacy_draft）→ 给出解析后的 base_dir。
    """
    state = tickets_svc.ticket_ownership(ticket, _effective_workspace(bound))
    if bound is not None and state == "other":
        raise HTTPException(404, f"工单不属于该工作区：{ticket.get('id', '')}")
    detail = dict(ticket)
    detail["groups"] = tickets_svc.grouped_problems(detail)
    detail["workspace"] = tickets_svc.ticket_workspace(detail)
    detail["ownership"] = state
    ambiguous = state == "ambiguous"
    detail["workspace_ambiguous"] = ambiguous
    detail["base_dir"] = None if ambiguous else str(tickets_svc.ticket_dir_base(detail))
    return detail


def _ticket_brief(ticket: dict[str, Any], bound: Path | None) -> dict[str, Any]:
    """列表项：在工单原字段上补归属标记，供前端识别可认领的未知旧单。"""
    item = dict(ticket)
    item["workspace"] = tickets_svc.ticket_workspace(ticket)
    state = tickets_svc.ticket_ownership(ticket, _effective_workspace(bound))
    item["ownership"] = state
    item["workspace_ambiguous"] = state == "ambiguous"
    return item


# ---------- 产课链（C） ----------


@router.post("/courses/{slug}/nodes/{node_id}/produce")
async def produce_node(
    slug: str,
    node_id: str,
    payload: dict[str, Any] | None = None,
    workspace: str | None = None,
) -> StreamingResponse:
    with _request_scope(workspace) as bound:
        require_subject(slug)
        requested_session = (payload or {}).get("session_id")
        provider = _provider_for(requested_session)
        stream_bound = bound if bound is not None else workspace_ctx.active()
        base = cs.subject_dir(slug)
        lease, session_id = _guarded_orchestration(
            scope_pairs=[(concurrency.produce_key(base, node_id), _produce_busy(base, node_id))],
            requested_session=requested_session,
            slug=slug,
            node_id=node_id,
            bound=bound,
        )

    async def runner(emit: Any) -> None:
        await produce_svc.run_produce(cs.subject_dir(slug), slug, node_id, provider, emit)

    try:
        return await _stream_orchestration(session_id, runner, stream_bound, release_lease=lease)
    except BaseException:
        lease.release()
        raise


def require_subject(slug: str) -> dict[str, Any]:
    subject = cs.get_subject(slug)
    if subject is None:
        raise HTTPException(404, f"科目不存在：{slug}")
    return subject


# ---------- 建课链（D）：草稿区 + 编排 + 落点确认 ----------


@router.get("/drafts")
def list_drafts(workspace: str | None = None) -> list[dict[str, Any]]:
    with _request_scope(workspace):
        return draft_svc.list_drafts()


@router.delete("/drafts/{slug}")
def delete_draft(slug: str, workspace: str | None = None) -> dict[str, bool]:
    with _request_scope(workspace):
        try:
            _draft_scope_key(slug)
        except ValueError:
            raise HTTPException(404, f"草稿不存在：{slug}") from None
        # 建课编排在飞时不得删草稿：短作用域完整覆盖删除。
        with _hold_draft(slug):
            try:
                deleted = draft_svc.delete_draft(slug)
            except ValueError:
                raise HTTPException(404, f"草稿不存在：{slug}") from None
    if not deleted:
        raise HTTPException(404, f"草稿不存在：{slug}")
    return {"ok": True}


@router.get("/drafts/{slug}")
def get_draft(slug: str, workspace: str | None = None) -> dict[str, Any]:
    with _request_scope(workspace):
        draft = _require_draft(slug)
        curriculum = draft_svc.draft_curriculum(slug) or {"nodes": [], "edges": []}
        materials = sorted(
            path.name for path in (draft_svc.draft_dir(slug) / "reference").glob("*.md")
        ) if (draft_svc.draft_dir(slug) / "reference").is_dir() else []
    return {"draft": draft, "curriculum": curriculum, "materials": materials}


@router.get("/drafts/{slug}/files/{file_path:path}")
def get_draft_file(slug: str, file_path: str, workspace: str | None = None) -> Any:
    """草稿内文件读取（质检工单快改的读取根与 PUT /tickets/{id}/artifact 一致）。"""
    from fastapi.responses import FileResponse

    with _request_scope(workspace):
        _require_draft(slug)
        base = draft_svc.draft_dir(slug).resolve()
        target = (base / file_path).resolve()
        if target != base and base not in target.parents:
            raise HTTPException(400, "路径越出草稿目录")
        if not target.is_file():
            raise HTTPException(404, f"文件不存在：{file_path}")
    return FileResponse(target)


@router.post("/drafts/{slug}/materials")
def add_material(slug: str, payload: MaterialRequest, workspace: str | None = None) -> dict[str, Any]:
    """用户给料 → 转 Markdown → reference/ + RESOURCES.md（不做主动检索）。"""
    with _request_scope(workspace):
        _require_draft(slug)
        title = payload.title.strip()
        text = payload.text.strip()
        if not title or not text:
            raise HTTPException(422, "title 与 text 均不能为空")
        markdown = f"# {title}\n\n{text}\n"
        # 给料写 reference/：与建课编排共用草稿键，编排在飞时拒绝。
        with _hold_draft(slug):
            rel = draft_svc.write_material(slug, title, markdown)
    return {"ok": True, "path": rel}


@router.post("/drafts/{slug}/build")
async def build_draft(
    slug: str, payload: dict[str, Any] | None = None, workspace: str | None = None
) -> StreamingResponse:
    with _request_scope(workspace) as bound:
        _require_draft(slug)
        requested_session = (payload or {}).get("session_id")
        provider = _provider_for(requested_session)
        stream_bound = bound if bound is not None else workspace_ctx.active()
        lease, session_id = _guarded_orchestration(
            scope_pairs=[(_draft_scope_key(slug), _curriculum_busy(slug))],
            requested_session=requested_session,
            slug=slug,
            node_id=None,
            bound=bound,
        )

    async def runner(emit: Any) -> None:
        from .. import build as build_svc

        await build_svc.run_build(slug, provider, emit)

    try:
        return await _stream_orchestration(session_id, runner, stream_bound, release_lease=lease)
    except BaseException:
        lease.release()
        raise


@router.post("/drafts/{slug}/promote")
def promote_draft(
    slug: str, payload: PromoteRequest, workspace: str | None = None
) -> dict[str, Any]:
    """落点确认：草稿整体搬进学习工作区并刷新主页。"""
    with _request_scope(workspace):
        _require_draft(slug)
        # 落点恒为本次请求绑定的工作区（没传则发现链给出的工作区）。
        # 与建课编排共用草稿键：编排在飞时不得搬走草稿。
        with _hold_draft(slug):
            try:
                final = draft_svc.promote(slug)
            except FileExistsError as exc:
                raise HTTPException(409, str(exc)) from None
            except FileNotFoundError as exc:
                raise HTTPException(404, str(exc)) from None
    # 落点不改 slug：草稿 slug 就是未来科目 slug，据此把触发会话自动关联到新科目。
    # 会话不存在（update_session 返回 None）时静默跳过，落点本身照常成功。
    if payload.session_id:
        update_session(payload.session_id, subject_slug=slug, node_id=None)
    return {"ok": True, "subject_dir": str(final)}


# ---------- 质检工单（④） ----------


@router.get("/tickets")
def list_tickets(
    slug: str | None = None,
    open_only: bool = False,
    workspace: str | None = None,
    include_unscoped: bool = False,
) -> list[dict[str, Any]]:
    """工单列表。

    - 默认（include_unscoped=false）：带 workspace 时按归属筛选——本区 owned /
      legacy_draft 可见，外加本区确有同 slug 科目的可认领 ambiguous；owned-other 绝不出现。
    - include_unscoped=true：在上述基础上额外列出「未知归属」旧单（ambiguous），
      不要求当前区含同 slug、也绕过 slug 筛选（原 slug 仍在字段里标明）——目标科目
      已被删除的旧单因此仍可达、可直接放弃。
    """
    with _request_scope(workspace) as bound:
        tickets = tickets_svc.list_tickets(slug=None, open_only=open_only)
        tickets = _filter_tickets(tickets, bound, slug, include_unscoped)
        return [_ticket_brief(t, bound) for t in tickets]


def _filter_tickets(
    tickets: list[dict[str, Any]],
    bound: Path | None,
    slug: str | None,
    include_unscoped: bool,
) -> list[dict[str, Any]]:
    """列表可见性口径（scoped/unscoped 与 include_unscoped 统一在此收口）。"""
    if bound is None:
        return [t for t in tickets if slug is None or t.get("slug") == slug]
    effective = str(bound)
    out: list[dict[str, Any]] = []
    for ticket in tickets:
        state = tickets_svc.ticket_ownership(ticket, effective)
        if state in ("owned", "legacy_draft"):
            if slug is None or ticket.get("slug") == slug:
                out.append(ticket)
            continue
        if state != "ambiguous":
            continue  # other：明确属于别的工作区，绝不泄露
        if include_unscoped:
            out.append(ticket)  # 未知旧单一律列出（绕过 slug，避免无当前科目旧单不见）
            continue
        if slug is not None and ticket.get("slug") != slug:
            continue
        if _target_workspace_ok(bound, str(ticket.get("slug") or ""), ticket.get("node_id")):
            out.append(ticket)
    return out


@router.get("/tickets/{ticket_id}")
def get_ticket(ticket_id: str, workspace: str | None = None) -> dict[str, Any]:
    with _request_scope(workspace) as bound:
        ticket = tickets_svc.get_ticket(ticket_id)
        if ticket is None:
            raise HTTPException(404, f"工单不存在：{ticket_id}")
        return _ticket_detail(ticket, bound)


@router.post("/tickets/{ticket_id}/retry")
async def retry_ticket(
    ticket_id: str, payload: RetryTicketRequest, workspace: str | None = None
) -> StreamingResponse:
    with _request_scope(workspace) as bound:
        if tickets_svc.get_ticket(ticket_id) is None:
            raise HTTPException(404, f"工单不存在：{ticket_id}")
        # 先占工单键：重试全程持键，认领/放弃无法在 runner 取 base 期间改归属。
        lease = _acquire_ticket(ticket_id)
        try:
            ticket = tickets_svc.get_ticket(ticket_id)
            if ticket is None:
                raise HTTPException(404, f"工单不存在：{ticket_id}")
            _assert_ticket_workspace(ticket, bound)
            provider = _provider_for(payload.session_id)
            stream_bound = bound if bound is not None else workspace_ctx.active()
            base = tickets_svc.ticket_dir_base(ticket)
            node_id = ticket.get("node_id")
            _lease_add_or_409(
                lease, concurrency.produce_key(base, node_id), _produce_busy(base, node_id)
            )
            lease, session_id = _guarded_orchestration(
                scope_pairs=[],
                requested_session=payload.session_id,
                slug=str(ticket["slug"]),
                node_id=node_id,
                bound=bound,
                lease=lease,
            )
        except BaseException:
            lease.release()
            raise

    async def runner(emit: Any) -> None:
        await produce_svc.run_ticket_retry(ticket_id, provider, emit, hint=payload.hint)

    try:
        return await _stream_orchestration(session_id, runner, stream_bound, release_lease=lease)
    except BaseException:
        lease.release()
        raise


@router.post("/tickets/{ticket_id}/recheck")
async def recheck_ticket(
    ticket_id: str, payload: RetryTicketRequest, workspace: str | None = None
) -> StreamingResponse:
    with _request_scope(workspace) as bound:
        if tickets_svc.get_ticket(ticket_id) is None:
            raise HTTPException(404, f"工单不存在：{ticket_id}")
        lease = _acquire_ticket(ticket_id)
        try:
            ticket = tickets_svc.get_ticket(ticket_id)
            if ticket is None:
                raise HTTPException(404, f"工单不存在：{ticket_id}")
            _assert_ticket_workspace(ticket, bound)
            stream_bound = bound if bound is not None else workspace_ctx.active()
            base = tickets_svc.ticket_dir_base(ticket)
            node_id = ticket.get("node_id")
            _lease_add_or_409(
                lease, concurrency.produce_key(base, node_id), _produce_busy(base, node_id)
            )
            lease, session_id = _guarded_orchestration(
                scope_pairs=[],
                requested_session=payload.session_id,
                slug=str(ticket["slug"]),
                node_id=node_id,
                bound=bound,
                lease=lease,
            )
        except BaseException:
            lease.release()
            raise

    async def runner(emit: Any) -> None:
        await produce_svc.run_ticket_recheck(ticket_id, emit)

    try:
        return await _stream_orchestration(session_id, runner, stream_bound, release_lease=lease)
    except BaseException:
        lease.release()
        raise


@router.put("/tickets/{ticket_id}/artifact")
def quick_edit_artifact(
    ticket_id: str, payload: TicketQuickEditRequest, workspace: str | None = None
) -> dict[str, Any]:
    """单文件快改：文本产物 textarea 保存回科目目录（路径越出即拒）。"""
    with _request_scope(workspace) as bound:
        if tickets_svc.get_ticket(ticket_id) is None:
            raise HTTPException(404, f"工单不存在：{ticket_id}")
        lease = _acquire_ticket(ticket_id)
        try:
            ticket = tickets_svc.get_ticket(ticket_id)
            if ticket is None:
                raise HTTPException(404, f"工单不存在：{ticket_id}")
            _assert_ticket_workspace(ticket, bound)
            base = tickets_svc.ticket_dir_base(ticket).resolve()
            target = (base / payload.path).resolve()
            if target != base and base not in target.parents:
                raise HTTPException(400, "路径越出科目目录")
            if not target.is_file():
                raise HTTPException(404, f"产物不存在：{payload.path}")
            # 同一 base+节点的写操作与产课互斥：租约完整覆盖写盘，防止产课在飞时
            # 被快改覆盖（或在快改中途产课落盘）。工单键已在手，认领/放弃无法插进来。
            node_id = ticket.get("node_id")
            _lease_add_or_409(
                lease, concurrency.produce_key(base, node_id), _produce_busy(base, node_id)
            )
            target.write_text(payload.content, encoding="utf-8", newline="\n")
        finally:
            lease.release()
    return {"ok": True}


@router.post("/tickets/{ticket_id}/claim")
def claim_ticket(
    ticket_id: str, payload: ClaimTicketRequest, workspace: str | None = None
) -> dict[str, Any]:
    """认领旧工单：显式把归属确认到指定工作区并持久化（原子 RMW）。

    - 只写工单的 workspace 字段：不重写科目、不移动文件、不按 same-slug 静默猜。
    - 目标不限发现候选：接受任意已存在的绝对目录，但须确有同 slug 科目
      （有 node_id 时含该节点）。
    - 草稿单（全局）拒认领；已归属且目标不同工作区拒绝跨区重绑；相同归属幂等接受。
    - 仅 open（待处理/重试中）旧单可认领，已关闭单不复活。
    """
    target = _explicit_workspace(payload.workspace)
    if target is None:
        raise HTTPException(422, "认领必须指定目标工作区路径")
    with _request_scope(workspace) as bound:
        if tickets_svc.get_ticket(ticket_id) is None:
            raise HTTPException(404, f"工单不存在：{ticket_id}")
        lease = _acquire_ticket(ticket_id)
        try:
            ticket = tickets_svc.get_ticket(ticket_id)
            if ticket is None:
                raise HTTPException(404, f"工单不存在：{ticket_id}")
            if ticket.get("base_label") == "draft":
                raise HTTPException(409, "草稿工单全局可见，无需认领")
            state = tickets_svc.ticket_ownership(ticket, str(target))
            if state == "owned":
                return {"ok": True, "ticket": _ticket_detail(ticket, target)}
            if state == "other":
                raise HTTPException(409, "工单已归属其它工作区，不能跨区重绑")
            # 已关闭的旧单不认领复活：状态保持关闭语义；只有 open 旧单可认领。
            if ticket.get("status") not in ("待处理", "重试中"):
                raise HTTPException(
                    409, "工单已关闭，认领不会复活它；如需处理请重新产课后再建工单。"
                )
            slug = str(ticket.get("slug") or "")
            node_id = ticket.get("node_id")
            if not _target_workspace_ok(target, slug, node_id):
                raise HTTPException(422, "目标工作区没有该工单对应的科目或节点")
            updated = tickets_svc.update_ticket(ticket_id, workspace=str(target))
            if updated is None:
                raise HTTPException(404, f"工单不存在：{ticket_id}")
            return {"ok": True, "ticket": _ticket_detail(updated, target)}
        finally:
            lease.release()


@router.post("/tickets/{ticket_id}/abandon")
def abandon_ticket(
    ticket_id: str, payload: AbandonTicketRequest | None = None, workspace: str | None = None
) -> dict[str, Any]:
    """放弃（仅状态收口）：归属未确认的旧单也允许直接放弃，不触课程产物。

    scoped 且明确属于别的工作区 → 404（不得顺着请求 scope 放弃他人工作区的工单）。
    reason 非空则记入工单 close_reason；绝不把未知旧单当作「校验通过/已解决」。
    """
    with _request_scope(workspace) as bound:
        if tickets_svc.get_ticket(ticket_id) is None:
            raise HTTPException(404, f"工单不存在：{ticket_id}")
        lease = _acquire_ticket(ticket_id)
        try:
            ticket = tickets_svc.get_ticket(ticket_id)
            if ticket is None:
                raise HTTPException(404, f"工单不存在：{ticket_id}")
            if bound is not None and tickets_svc.ticket_ownership(ticket, str(bound)) == "other":
                raise HTTPException(404, f"工单不属于该工作区：{ticket_id}")
            fields: dict[str, Any] = {"status": "已放弃"}
            reason = (payload.reason or "").strip() if payload is not None else ""
            if reason:
                fields["close_reason"] = reason
            tickets_svc.update_ticket(ticket_id, **fields)
        finally:
            lease.release()
    return {"ok": True}
