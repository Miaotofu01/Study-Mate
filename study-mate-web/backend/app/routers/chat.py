"""聊天路由：会话 CRUD + SSE 流式对话（含附件与模态两段式）。"""
from __future__ import annotations

import asyncio
import json
import re
import shutil
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import agent as agent_svc
from .. import audit
from .. import curriculum_store as cs
from .. import memory as memory_svc
from .. import misconceptions as mc
from .. import prompts
from .. import records as records_svc
from .. import storage
from .. import tools as tools_svc
from .. import workspace_ctx
from ..common import optional_workspace
from ..config import PENDING_UPLOADS_DIR, UPLOADS_DIR, get_active_provider, load_settings
from ..doc_extract import extract_text
from ..llm import is_fixture_mode, stream_chat, supports_tools
from ..models import ChatRequest, NewSessionRequest, SessionPatchRequest
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


def _infer_focus_node(slug: str) -> str | None:
    """无显式节点时的默认聚焦（对照插件「接着上次学」）：先取学习中节点，否则第一个未开始。"""
    curriculum = cs.get_curriculum(slug) or {}
    nodes = [node for node in (curriculum.get("nodes") or []) if isinstance(node, dict)]
    if not nodes:
        return None
    entries = cs.get_progress(slug).get("nodes") or {}
    statuses = {
        str(node["id"]): str((entries.get(node["id"]) or {}).get("status") or "")
        for node in nodes
        if node.get("id")
    }
    for node in nodes:
        if statuses.get(str(node["id"])) == "学习中":
            return str(node["id"])
    for node in nodes:
        if not statuses.get(str(node["id"])):
            return str(node["id"])
    return None


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


MEMORY_INJECT_LIMIT = 6000

INTERVIEW_RESULT_RE = re.compile(
    r"<!--INTERVIEW_RESULT-->\s*(\{.*?\})\s*<!--/INTERVIEW_RESULT-->", re.DOTALL
)


def _handle_interview_result(session_id: str, reply: str) -> dict[str, Any] | None:
    """盘问收口：解析标记 → 建草稿 → 会话里落「确认建课」卡。

    返回 confirm 事件载荷；解析失败/建冲突返回 None（错误已写成会话消息）。
    """
    match = INTERVIEW_RESULT_RE.search(reply)
    if match is None:
        return None
    try:
        result = json.loads(match.group(1))
    except json.JSONDecodeError:
        storage.add_message(
            session_id,
            "assistant",
            "盘问收口标记解析失败（不是合法 JSON），请让教练重新给出结论。",
            kind="error",
        )
        return None
    if not isinstance(result, dict) or not str(result.get("name") or "").strip():
        storage.add_message(
            session_id, "assistant", "盘问收口缺少科目名（name），无法建课。", kind="error"
        )
        return None
    from .. import draft as draft_svc

    name = str(result["name"]).strip()
    try:
        slug = draft_svc.create_draft(
            name,
            slug=result.get("slug"),
            goal=str(result.get("purpose") or ""),
            interview=result,
        )
    except FileExistsError:
        storage.add_message(
            session_id,
            "assistant",
            f"草稿已存在（{name}），请到课程页处理或换一个科目名。",
            kind="error",
        )
        return None
    except ValueError as exc:
        storage.add_message(session_id, "assistant", str(exc), kind="error")
        return None
    storage.add_message(
        session_id,
        "assistant",
        f"盘问完成，已为「{name}」建好草稿（{slug}）。确认后开始建课编排：大纲与采图并行，过门禁后等你落点确认。",
        kind="build_confirm",
        slug=slug,
    )
    return {"slug": slug, "name": name}


def _opening_slice(slug: str) -> str | None:
    """开场状态切片（record-keeping 恢复视图的等价子集）：MEMORY 分节 + 最近 5 误解 / 3 学习记录 / 3 评估记录。"""
    lines: list[str] = []
    memory_text = memory_svc.read_memory()
    if memory_text:
        lines.append("【共享记忆】")
        text = memory_text.strip()
        if len(text) > MEMORY_INJECT_LIMIT:
            text = text[:MEMORY_INJECT_LIMIT] + "\n…（共享记忆过长，已截断）"
        lines.append(text)
    misconceptions = mc.canonical_items(slug)
    if misconceptions:
        lines.append("【最近误解】")
        for item in misconceptions[:5]:
            lines.append(
                f"- {item.get('topic', '')}：{item.get('misunderstanding', '')}"
                f"（答案要点：{item.get('answer_summary', '')}）"
            )
    records = records_svc.list_records(slug)
    if records["learning_records"]:
        lines.append("【最近学习记录】")
        lines.extend(
            f"- {record['date']} {record['node']}（{record['file']}）"
            for record in records["learning_records"][-3:]
        )
    if records["assessments"]:
        lines.append("【最近评估】")
        lines.extend(
            f"- {record['date']} {record['node']}：{record['verdict']}"
            for record in records["assessments"][-3:]
        )
    if not lines:
        return None
    lines.append("（以上是学习者近期状态切片，供开场报告与「下一步」建议参考）")
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
    # 会话级工作区：给了就必须是存在的目录（422），否则会话落在落空绑定上
    workspace = optional_workspace(payload.workspace)
    return storage.create_session(
        title=payload.title, workspace=str(workspace) if workspace is not None else None
    )


@router.get("/sessions/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    return _require_session(session_id)


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str) -> dict[str, bool]:
    _require_session(session_id)
    return {"ok": storage.delete_session(session_id)}


@router.patch("/sessions/{session_id}")
def patch_session(session_id: str, payload: SessionPatchRequest) -> dict[str, Any]:
    """改标题 / 换会话工作区（均可选）。

    「没传」与「显式 null」用 model_fields_set 区分：只传 title 维持旧行为；
    workspace 显式 null（或空串）清空绑定，回到全局发现；非空值须是存在目录。
    """
    _require_session(session_id)
    fields: dict[str, Any] = {}
    if "title" in payload.model_fields_set:
        # title 只接受非空字符串：显式 null 会让列表标题变成 None，前端渲染成 "null"。
        title = (payload.title or "").strip()
        if not title:
            raise HTTPException(422, "标题不能为空")
        fields["title"] = title
    if "workspace" in payload.model_fields_set:
        workspace = optional_workspace(payload.workspace)
        fields["workspace"] = str(workspace) if workspace is not None else None
    if not fields:
        raise HTTPException(422, "没有要更新的字段（title / workspace 二选一或都给）")
    updated = storage.update_session(session_id, **fields)
    assert updated is not None  # 上一步 _require_session 已确认会话存在
    return updated


@router.post("/chat/stream")
async def chat_stream(payload: ChatRequest):
    """SSE 流式对话。事件：session / delta / notice / confirm / done / error。

    会话模式（拍板⑧/F）：关联科目的会话注入 local-qa（chat 链路收口）；
    建课会话（mode=interview）注入 learning-system + learning-discovery，
    盘问收口标记解析后建草稿并落「确认建课」卡。
    """
    # 技能规范先于一切副作用检查（缺失 503 时不建会话、不留消息）：
    # 模式先于会话定——已有会话看其 mode/科目联动，新会话看 payload.mode
    session_id = payload.session_id
    existing = storage.get_session(session_id) if session_id else None
    if session_id and existing is None:
        session_id = None
    if existing is not None:
        mode = "chat" if existing.get("subject_slug") else str(existing.get("mode") or "chat")
    else:
        mode = payload.mode or "chat"
    # 旧规则「显式科目强制 chat」由下方绑定语义接管：interview 会话拒绝科目关联（保模式），
    # 其余新建会话 + 显式科目本来就是默认 chat。
    if mode == "interview":
        skill_text, missing_skills = prompts.inject_interview()
    else:
        skill_text, missing_skills = prompts.inject("chat")
    if missing_skills:
        raise HTTPException(503, f"技能规范缺失，无法保证行为口径：{'、'.join(missing_skills)}")

    settings = load_settings()
    provider = get_active_provider()
    if is_fixture_mode() and provider is None:
        provider = {"model": "fixture", "api_format": "openai_chat"}

    # 会话级工作区：已有会话沿用其绑定；新建会话按请求里的可选 workspace 建
    # （先校验目录存在，不存在 422 → 不建会话、不留消息；入会话 JSON 前归一化为字符串）
    ws_candidate = existing.get("workspace") if existing is not None else None
    if ws_candidate is None and (payload.workspace or "").strip():
        ws_candidate = str(optional_workspace(payload.workspace))
    ws_bound: str | None = ws_candidate

    if existing is not None:
        session = existing
    else:
        session = storage.create_session(mode=mode, workspace=ws_bound)
        session_id = session["id"]
        session = storage.require_session(session_id)

    with workspace_ctx.bind(ws_bound):
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

        # 课程联动（绑死语义，2026-10-04 拍板）：科目一经绑定不可更换（换科目=开新会话），
        # 节点可在科目内随时切换；interview 会话不收科目关联（归属由盘问收口→草稿→落点确认自带）。
        binding_notice: str | None = None
        if "subject_slug" in payload.model_fields_set or "node_id" in payload.model_fields_set:
            bound_slug = session.get("subject_slug")
            if bound_slug:
                if (
                    "subject_slug" in payload.model_fields_set
                    and payload.subject_slug
                    and payload.subject_slug != bound_slug
                ):
                    binding_notice = "会话已绑定科目，更换科目请开新会话。"
                node_id = None
                if payload.node_id and _node_exists(str(bound_slug), payload.node_id):
                    node_id = payload.node_id
                if node_id != session.get("node_id"):
                    storage.update_session(session_id, node_id=node_id)
                context_slug: str | None = str(bound_slug)
            elif (
                mode == "interview"
                and "subject_slug" in payload.model_fields_set
                and payload.subject_slug
            ):
                binding_notice = "建课会话不关联已有科目：方向确认后自动建草稿，落点确认后归入工作区。"
                context_slug = None
            elif payload.subject_slug and cs.get_subject(payload.subject_slug) is not None:
                node_id = payload.node_id if payload.node_id and _node_exists(
                    payload.subject_slug, payload.node_id
                ) else None
                storage.update_session(session_id, subject_slug=payload.subject_slug, node_id=node_id)
                context_slug = payload.subject_slug
            else:
                storage.update_session(session_id, subject_slug=None, node_id=None)
                context_slug = None
            session = storage.require_session(session_id)
        else:
            context_slug = session.get("subject_slug")
        context_node = session.get("node_id")
        if context_slug and not context_node:
            context_node = _infer_focus_node(str(context_slug))

        try:
            course_context = _course_context(context_slug, context_node) if context_slug else None
        except Exception:  # noqa: BLE001 - 课程上下文组装失败不阻断聊天
            course_context = None

        opening: str | None = None
        if context_slug and len(session["messages"]) == 1:
            try:  # noqa: SIM105 - 开场切片组装失败同样不阻断聊天
                opening = _opening_slice(context_slug)
            except Exception:  # noqa: BLE001
                opening = None

        # 历史重放纯文本；图片只注入当前（最后一条 user）消息
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": settings.get("system_prompt", "")}
        ]
        if skill_text:
            messages.append({"role": "system", "content": skill_text})
        if course_context:
            messages.append({"role": "system", "content": course_context})
        if opening:
            messages.append({"role": "system", "content": opening})
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

        # K1：工具化 chat（只读工具 read_course_file / list_workspace / read_skill）。
        # 工具调用默认对所有配置的模型开启（2026-10-04）：真实模型一律走工具循环，上游
        # 不接受 tools 时由 llm.stream_turn 自动回落纯文本一次。fixture 模式仅在显式工具
        # 场景走循环，其余保持原有固定流（E2E 稳定）。
        fixture_tool = is_fixture_mode() and payload.fixture_scenario in agent_svc.FIXTURE_TOOL_SCENARIOS
        use_tools = fixture_tool or (not is_fixture_mode() and supports_tools(provider))
        tool_schemas = tools_svc.schemas(tools_svc.CHAT_TOOLS) if use_tools else []
        if use_tools:
            bound_subject = cs.get_subject(context_slug) if context_slug else None
            read_roots = [cs.subject_dir(context_slug)] if context_slug else [cs.subjects_dir()]
            tool_ctx = tools_svc.ToolContext(
                read_roots=read_roots,
                write_roots=[],
                label=str(bound_subject.get("name")) if bound_subject else "工作区",
            )
            turn_source = (
                agent_svc.fixture_turn_source(str(payload.fixture_scenario), payload.fixture_scenario)
                if fixture_tool
                else agent_svc.real_turn_source(provider, payload.fixture_scenario)  # type: ignore[arg-type]
            )

        async def _tool_event_source():
            """工具化对话的队列驱动 SSE：agent 事件（text/tool_call/tool_result）转发并落审计。"""
            yield _sse("session", {"session_id": session_id})

            if binding_notice:
                yield _sse("notice", {"message": binding_notice})

            if not is_fixture_mode() and (provider is None or not provider.get("api_key")):
                yield _sse("error", {"message": "尚未配置模型 API Key，请到 Settings 填写。"})
                return

            if stage1_notice:
                yield _sse("notice", {"message": stage1_notice})

            audit.bind(f"chat-{session_id}")
            queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
            event_names = {
                "text": "delta",
                "tool_call": "tool_call",
                "tool_result": "tool_result",
                "notice": "notice",
                "confirm": "confirm",
                "error": "error",
            }

            async def emit(event: dict[str, Any]) -> None:
                await queue.put(event)

            async def runner() -> None:
                try:
                    outcome = await agent_svc.run_agent(
                        turn_source,
                        messages,
                        tool_ctx,
                        emit,
                        tool_schemas,
                        audit_meta={
                            "kind": "chat",
                            "session_id": session_id,
                            "model": str(provider.get("model") or ""),
                        },
                    )
                    reply = outcome.text
                    if reply:
                        storage.add_message(session_id, "assistant", reply)
                    if mode == "interview":
                        confirm_event = _handle_interview_result(session_id, reply)
                        if confirm_event is not None:
                            await queue.put({"type": "confirm", **confirm_event})
                    if outcome.degraded:
                        await queue.put({"type": "notice", "message": "（本轮达到轮次/工具预算，已按现有信息作答。）"})
                except Exception as exc:  # noqa: BLE001 - 统一转 SSE 错误事件
                    await queue.put({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
                finally:
                    await queue.put({"type": "__end__"})

            task = asyncio.create_task(runner())
            try:
                while True:
                    event = await queue.get()
                    if event.get("type") == "__end__":
                        break
                    name = event_names.get(str(event.get("type")), "notice")
                    yield _sse(name, {key: value for key, value in event.items() if key != "type"})
            finally:
                await task
            yield _sse("done", {"session_id": session_id})

        async def tool_event_generator():
            # SSE 由 StreamingResponse 在别的任务里迭代：这里重新挂绑定，
            # 保证后续 agent 工具循环读取到的科目/工作区与该会话一致
            with workspace_ctx.bind(ws_bound):
                async for event in _tool_event_source():
                    yield event

        async def _plain_event_source():
            # 先把 session_id 发给前端（新建会话时前端需要）
            yield _sse("session", {"session_id": session_id})

            if binding_notice:
                yield _sse("notice", {"message": binding_notice})

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
                    return stream_chat(provider, items, fixture_scenario=payload.fixture_scenario)

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

                reply = "".join(collected)
                storage.add_message(session_id, "assistant", reply)
                if mode == "interview":
                    confirm_event = _handle_interview_result(session_id, reply)
                    if confirm_event is not None:
                        yield _sse("confirm", confirm_event)
                yield _sse("done", {"session_id": session_id})
            except Exception as exc:  # noqa: BLE001 - 统一转成 SSE 错误事件
                if collected:
                    storage.add_message(session_id, "assistant", "".join(collected))
                yield _sse("error", {"message": f"{type(exc).__name__}: {exc}"})

        async def event_generator():
            # 与工具化路径同理：迭代期重挂绑定，防止 ContextVar 丢失/跨请求泄漏
            with workspace_ctx.bind(ws_bound):
                async for event in _plain_event_source():
                    yield event

        return StreamingResponse(
            tool_event_generator() if use_tools else event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
