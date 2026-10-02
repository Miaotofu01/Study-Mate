"""聊天路由：会话 CRUD + SSE 流式对话（含附件与模态两段式）。"""
from __future__ import annotations

import json
import re
import shutil
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import curriculum_store as cs
from .. import storage
from ..config import PENDING_UPLOADS_DIR, UPLOADS_DIR, get_active_provider, load_settings
from ..doc_extract import extract_text
from ..llm import is_fixture_mode, stream_chat
from ..models import ChatRequest, NewSessionRequest, RenameSessionRequest
from ..multimodal import (
    AUDIO_EXTENSIONS,
    AUDIO_PLACEHOLDER,
    VIDEO_EXTENSIONS,
    VIDEO_PLACEHOLDER,
    inject_images,
    prime_stream,
)
from .uploads import UPLOAD_ID_RE, classify_kind

router = APIRouter(prefix="/api", tags=["chat"])

MAX_ATTACHMENT_CHARS_TOTAL = 60000


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _require_session(session_id: str) -> dict[str, Any]:
    try:
        return storage.require_session(session_id)
    except KeyError:
        raise HTTPException(404, f"会话不存在：{session_id}") from None


def _node_exists(slug: str, node_id: str) -> bool:
    curriculum = cs.get_curriculum(slug) or {}
    return any(
        node.get("id") == node_id
        for node in (curriculum.get("nodes") or [])
        if isinstance(node, dict)
    )


def _course_context(slug: str, node_id: str | None) -> str | None:
    subject = cs.get_subject(slug)
    summary = cs.subject_summary(slug)
    if subject is None or summary is None:
        return None
    curriculum = cs.get_curriculum(slug) or {}
    entries = cs.get_progress(slug).get("nodes") or {}
    nodes = [node for node in (curriculum.get("nodes") or []) if isinstance(node, dict)]
    views = [
        cs.effective_node(node, entries.get(node.get("id")), i + 1, cs.TRANSITIONS)
        for i, node in enumerate(nodes)
    ]
    project = cs.get_progress(slug).get("project") or {}

    lines = [
        f"【课程上下文】当前科目：{subject.get('name', '')}（{slug}）",
        f"科目目标：{subject.get('goal', '')}",
        "课程进度：共 "
        f"{summary['node_total']} 个节点，已完成 {summary['node_done']} 个；"
        f"当前项目：{project.get('current') or '无'}",
        "节点列表（按学习顺序）：",
    ]
    for view in views:
        lines.append(f"{view['index']}. {view['title']}（{view['kind']}）— {view['status']}")

    current = next((view for view in views if view["id"] == node_id), None) if node_id else None
    if current is not None:
        titles = {view["id"]: view["title"] for view in views}
        prerequisites = "、".join(titles.get(pre, pre) for pre in current["prerequisites"]) or "无"
        concepts = "、".join(current["concepts"]) or "无"
        lines.append(f"【当前节点】{current['title']}（{current['kind']}）")
        lines.append(f"学习目标：{current['objective']}")
        lines.append(f"前置节点：{prerequisites}")
        lines.append(f"涉及概念：{concepts}")
        if current["pitfalls"]:
            lines.append("易错点：")
            lines.extend(f"- {pitfall}" for pitfall in current["pitfalls"])
        else:
            lines.append("易错点：无")
        lines.append(
            f"当前进度：{current['status']}，掌握度 {current['mastery']}；"
            f"学习笔记：{current['notes'] or '无'}"
        )

    lines.append("请围绕上述课程内容辅导学习者，遵循 learn with doing：讲清概念后引导动手练习。")
    return "\n".join(lines)


def _find_pending(file_id: str) -> Path | None:
    if not UPLOAD_ID_RE.fullmatch(file_id):
        return None
    for path in PENDING_UPLOADS_DIR.glob(f"{file_id}_*"):
        if path.is_file():
            return path
    return None


def _move_attachments(session_id: str, attachment_ids: list[str]) -> list[dict[str, Any]]:
    """把 pending 中被引用的文件移入 data/uploads/<session_id>/，返回元数据
    （含内部寻址用的 _path，落库前剔除）。"""
    moved: list[dict[str, Any]] = []
    target_dir = UPLOADS_DIR / session_id
    for file_id in attachment_ids:
        source = _find_pending(file_id)
        if source is None:
            continue
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / source.name
        shutil.move(str(source), str(target))
        filename = source.name.split("_", 1)[1] if "_" in source.name else source.name
        moved.append(
            {
                "id": file_id,
                "filename": filename,
                "kind": classify_kind(filename),
                "size": target.stat().st_size,
                "_path": str(target),
            }
        )
    return moved


def _attachment_block(attachment: dict[str, Any]) -> str:
    filename = str(attachment["filename"])
    suffix = Path(filename).suffix.lower()
    if suffix in VIDEO_EXTENSIONS:
        return VIDEO_PLACEHOLDER.format(name=filename)
    if suffix in AUDIO_EXTENSIONS:
        return AUDIO_PLACEHOLDER.format(name=filename)
    try:
        text = extract_text(filename, Path(attachment["_path"]).read_bytes())
    except Exception as exc:  # noqa: BLE001 - 解析失败转占位，不阻断发送
        return f"[附件 {filename} 解析失败：{exc}]"
    return f"附件：{filename}\n{text}"


def _compose_effective_text(message: str, attachments: list[dict[str, Any]]) -> str:
    """用户原文 + 文档附件提取文本（附件：<文件名> 标题块），合计 60000 字符预算。"""
    blocks = [message] if message else []
    used = 0
    for attachment in attachments:
        block = _attachment_block(attachment)
        if block.startswith("附件：") and attachment.get("kind") == "doc":
            title, _, body = block.partition("\n")
            remaining = MAX_ATTACHMENT_CHARS_TOTAL - used
            if remaining <= 0:
                block = (
                    f"{title}\n[已达单条消息附件文本总量上限"
                    f"（{MAX_ATTACHMENT_CHARS_TOTAL} 字符），未注入]"
                )
            else:
                if len(body) > remaining:
                    body = f"{body[:remaining]}…（超总量上限截断）"
                    block = f"{title}\n{body}"
                used += len(body)
        blocks.append(block)
    return "\n\n".join(blocks)


def _load_images(attachments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    images: list[dict[str, Any]] = []
    for attachment in attachments:
        if attachment.get("kind") != "image":
            continue
        try:
            images.append(
                {
                    "filename": attachment["filename"],
                    "data": Path(attachment["_path"]).read_bytes(),
                }
            )
        except OSError:
            continue
    return images


@router.get("/sessions")
def list_sessions() -> list[dict[str, Any]]:
    return storage.list_sessions()


@router.post("/sessions")
def create_session(payload: NewSessionRequest) -> dict[str, Any]:
    return storage.create_session(title=payload.title)


@router.get("/sessions/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    return _require_session(session_id)


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str) -> dict[str, bool]:
    _require_session(session_id)
    return {"ok": storage.delete_session(session_id)}


@router.patch("/sessions/{session_id}")
def rename_session(session_id: str, payload: RenameSessionRequest) -> dict[str, Any]:
    return storage.rename_session(session_id, payload.title)


@router.post("/chat/stream")
async def chat_stream(payload: ChatRequest):
    """SSE 流式对话。事件：session / delta / notice / done / error。"""
    settings = load_settings()
    provider = get_active_provider()
    if is_fixture_mode() and provider is None:
        provider = {"model": "fixture", "api_format": "openai_chat"}

    # 定位或新建会话
    session_id = payload.session_id
    if session_id:
        try:
            storage.require_session(session_id)
        except KeyError:
            session_id = None
    if not session_id:
        session = storage.create_session()
        session_id = session["id"]

    # 附件：pending 移入会话目录 → 组装有效文本 → 落库（含附件元数据）
    attachments = _move_attachments(session_id, payload.attachment_ids)
    effective_text = _compose_effective_text(payload.message, attachments)
    stored_attachments = [
        {key: attachment[key] for key in ("id", "filename", "kind", "size")}
        for attachment in attachments
    ]
    storage.add_message(
        session_id, "user", effective_text, attachments=stored_attachments or None
    )
    session = storage.require_session(session_id)

    # 课程联动：显式传 subject_slug 时写回会话（传 null 表示取消关联），否则沿用会话已有上下文
    if "subject_slug" in payload.model_fields_set:
        if payload.subject_slug and cs.get_subject(payload.subject_slug) is not None:
            node_id = payload.node_id if payload.node_id and _node_exists(
                payload.subject_slug, payload.node_id
            ) else None
            storage.update_session(session_id, subject_slug=payload.subject_slug, node_id=node_id)
            context_slug: str | None = payload.subject_slug
        else:
            storage.update_session(session_id, subject_slug=None, node_id=None)
            context_slug = None
        session = storage.require_session(session_id)
    else:
        context_slug = session.get("subject_slug")
    context_node = session.get("node_id")

    try:
        course_context = _course_context(context_slug, context_node) if context_slug else None
    except Exception:  # noqa: BLE001 - 课程上下文组装失败不阻断聊天
        course_context = None

    # 历史重放纯文本；图片只注入当前（最后一条 user）消息
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": settings.get("system_prompt", "")}
    ]
    if course_context:
        messages.append({"role": "system", "content": course_context})
    messages.extend(
        {"role": item["role"], "content": item["content"]}
        for item in session["messages"]
    )

    stage1_notice: str | None = None
    images = _load_images(attachments)
    if images and provider is not None:
        stage1_notice = inject_images(
            messages,
            images,
            str(provider.get("model") or ""),
            str(provider.get("vision") or "auto"),
        )

    async def event_generator():
        # 先把 session_id 发给前端（新建会话时前端需要）
        yield _sse("session", {"session_id": session_id})

        if not is_fixture_mode() and (provider is None or not provider.get("api_key")):
            yield _sse(
                "error",
                {"message": "尚未配置模型 API Key，请到 Settings 填写。"},
            )
            return

        collected: list[str] = []
        try:
            if stage1_notice:
                yield _sse("notice", {"message": stage1_notice})

            def make_stream(items: list[dict[str, Any]]) -> AsyncGenerator[str, None]:
                return stream_chat(provider, items)

            generator, first, retry_notice = await prime_stream(
                make_stream, messages, str(provider.get("model") or "")
            )
            if retry_notice:
                yield _sse("notice", {"message": retry_notice})

            piece = first
            while piece is not None:
                collected.append(piece)
                yield _sse("delta", {"content": piece})
                try:
                    piece = await generator.__anext__()
                except StopAsyncIteration:
                    break

            storage.add_message(session_id, "assistant", "".join(collected))
            yield _sse("done", {"session_id": session_id})
        except Exception as exc:  # noqa: BLE001 - 统一转成 SSE 错误事件
            if collected:
                storage.add_message(session_id, "assistant", "".join(collected))
            yield _sse("error", {"message": f"{type(exc).__name__}: {exc}"})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
