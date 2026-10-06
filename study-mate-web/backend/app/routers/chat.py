"""聊天路由：会话 CRUD + SSE 流式对话（含附件与模态两段式）。"""
from __future__ import annotations

import asyncio
import contextlib
import copy
import json
import re
import shutil
import time
import uuid
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from .. import agent as agent_svc
from .. import audit, errors
from .. import concurrency
from .. import curriculum_store as cs
from .. import memory as memory_svc
from .. import misconceptions as mc
from .. import prompts
from .. import records as records_svc
from .. import storage
from .. import tools as tools_svc
from .. import workspace_ctx
from ..common import optional_workspace
from ..config import (
    PENDING_UPLOADS_DIR,
    UPLOADS_DIR,
    get_active_provider,
    get_session_provider,
    load_settings,
)
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
from .uploads import UPLOAD_ID_RE, classify_kind, safe_attachment_path

router = APIRouter(prefix="/api", tags=["chat"])

@router.post("/sessions/{session_id}/stop")
async def stop_session(session_id: str):
    if storage.get_session(session_id) is None:
        raise HTTPException(404, "会话不存在")
    stopped = errors.request_stop(session_id, errors.active_turn(session_id))
    return {"ok": True, "stop": stopped}


MAX_ATTACHMENT_CHARS_TOTAL = 60000
MAX_ATTACHMENTS_PER_MESSAGE = 10

SESSION_BUSY_MESSAGE = "该会话正在处理上一轮回复或编排，请等待它结束、或先停止当前轮次后再发送。"
SESSION_BUSY_EDIT_MESSAGE = "该会话正在处理上一轮回复或编排，暂不能编辑或删除消息；请先停止当前轮次。"

# 中途 checkpoint：工具边界立即写，正文/思维链按这个间隔节流（真机写得别太碎）。
CHECKPOINT_INTERVAL = 0.6
# 静默期 SSE 注释心跳：让 send 失败把断开暴露出来，及时取消 runner 并释放会话租约。
HEARTBEAT_INTERVAL = 3.0
SSE_HEARTBEAT = ": ping\n\n"


def _acquire_session(lease: concurrency.Lease, session_id: str, message: str) -> None:
    """占用会话键并记进租约；已有在飞轮次则 409（不等待）。"""
    key = concurrency.session_key(session_id)
    try:
        token = concurrency.acquire(key, message)
    except concurrency.ConflictError as exc:
        raise HTTPException(409, str(exc)) from None
    lease.add(key, token)


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _queue_get_heartbeat(
    queue: asyncio.Queue[dict[str, Any]],
) -> dict[str, Any] | None:
    """取一个事件；静默超时返回 None，让调用方补发 SSE 注释心跳。

    用独立 Task + `asyncio.wait` 而非 `wait_for(queue.get())`：后者在内层 get 被取消
    又恰好拿到事件的边界上有丢事件竞态（该事件会随取消一起丢掉）。无论超时还是外层被
    取消（客户端断开），都在 finally 里取消并收殓未完成的 getter，避免留下悬挂的
    `Queue.get` 任务。
    """
    getter = asyncio.ensure_future(queue.get())
    try:
        done, _ = await asyncio.wait({getter}, timeout=HEARTBEAT_INTERVAL)
        if done:
            return getter.result()
        return None
    finally:
        if not getter.done():
            getter.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await getter


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


def _model_label(provider: dict[str, Any] | None) -> str | None:
    """落进助手消息的模型标识（「提供商 / 模型」），供消息名称栏与右栏用量栏回放。"""
    if not provider:
        return None
    name = str(provider.get("name") or "").strip()
    model = str(provider.get("model") or "").strip()
    if name and model:
        return f"{name} / {model}"
    return model or name or None


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
# 收口标记是内部记账用的注释块，不该出现在会话正文里（2026-10-04 维护者反馈：
# 历史消息里躺着 `<!--INTERVIEW_RESULT-->{...}<!--/INTERVIEW_RESULT-->`，很难看）
INTERVIEW_START = "<!--INTERVIEW_RESULT-->"
# 收口标记缺席时的可行动提示。只发一次、且只在"像收尾"的那轮发——盘问本来就要来回多轮，
# 每轮追加一条会变成刷屏（2026-10-04 真机：模型口头上说"建课完成"却没吐标记，用户侧完全卡住）。
INTERVIEW_CLOSE_HINT = (
    "未收到建课收口标记：请再说一次「按上面的结论建课」，或继续回答教练的问题。"
)

# 建课收口阶段的显式判据（2026-10-05）：用户明确确认建课时进入——本轮工具面清空、
# 只做纯最终输出。**只认完整明确命令**：整句 fullmatch 有限前缀 + 命令 + 句尾标点，
# 任意前后文（"如何开始建课/我不想开始建课/有人建议开始建课/可以建课吗"）一律不触发。
# 宁可漏判（继续盘问）也不误建课。
_CONFIRM_COMMANDS = (
    r"确认建课|按你说的(?:来)?建课|按上面的结论(?:来)?建课|按上面结论建课|"
    r"开始建课|就这样建课|这就建课|可以建课|建课吧|那就建课"
)
_CONFIRM_PREFIX = r"(?:(?:好[的了]?|嗯|行|请|现在|那就|那|OK|ok)[，,]?\s*)?"
_CONFIRM_TAIL = r"[！!。.，,~～\s]*"
INTERVIEW_CONFIRM_RE = re.compile(
    rf"^(?:{_CONFIRM_PREFIX})?(?:{_CONFIRM_COMMANDS}){_CONFIRM_TAIL}$"
)
# 辅助判据：收口提示之后的一句简短确认。用**有限词集合**（不是字符集合，任意字组合不算）。
_SHORT_AFFIRM_WORDS = frozenset(
    {"好", "好的", "行", "嗯", "对", "是", "是的", "可以", "没问题", "开始吧", "就这样", "就这样吧", "确认", "ok"}
)
_SHORT_AFFIRM_TAIL = "！!。.，,~～、 \t"
# 收口阶段阶段状态提示（一轮一次，给出时限与可停止；不逐秒刷屏、不新增计时 UI）。
INTERVIEW_FINALIZE_NOTICE_TEMPLATE = (
    "（正在整理建课信息，最多等待约 {seconds:.0f}s；期间可随时停止。本轮不再调用工具。）"
)


def finalize_notice() -> str:
    return INTERVIEW_FINALIZE_NOTICE_TEMPLATE.format(
        seconds=agent_svc.INTERVIEW_FINALIZE_MAX_SECONDS
    )


# 收口必填字段与占位值：只凭 name 就建草稿会把盘问没问全的信息当成已确认。
# 机械校验关键字段完整（不靠模型自述、不把模型创造值当用户已确认）。
INTERVIEW_REQUIRED_FIELDS = ("name", "purpose", "level", "background")
INTERVIEW_PLACEHOLDER_VALUES = frozenset(
    {
        "",
        "未知",
        "不详",
        "待定",
        "未提供",
        "未说明",
        "没提供",
        "n/a",
        "na",
        "none",
        "null",
        "-",
        "—",
        "?",
        "无",
    }
)


def _interview_missing_fields(result: dict[str, Any]) -> list[str]:
    """返回缺失/占位的必填字段名（空列表表示信息完整可建草稿）。

    字段必须是**非空字符串**：list/dict/number 等非文本一律视为未提供
    （str(dict) 不能把非文本当成已确认值）；"零基础" 这类明确字符串有效。
    """
    missing: list[str] = []
    for key in INTERVIEW_REQUIRED_FIELDS:
        value = result.get(key)
        if not isinstance(value, str):
            missing.append(key)
            continue
        text = value.strip()
        if not text or text.lower() in INTERVIEW_PLACEHOLDER_VALUES:
            missing.append(key)
    return missing


def _is_interview_finalize_phase(messages: list[dict[str, Any]], message: str) -> bool:
    """本轮是否进入建课收口阶段（mode=interview 时由调用方再判）。

    保守识别「完整明确命令」：整句 fullmatch 有限前缀 + 命令 + 句尾标点；任意前后文
    （"如何开始建课/我不想开始建课/有人建议开始建课/可以建课吗"）都不触发。
    漏判只是继续盘问，远好于误建课。
    - 完整命令 ⇒ 收口。
    - 简短确认（"好/可以/就这样"）的辅助判据：仅当上一助手是收口提示（无问号、含
      「确认」且提「建课/开始」）时成立，不猜。
    """
    text = (message or "").strip()
    if not text:
        return False
    if INTERVIEW_CONFIRM_RE.fullmatch(text):
        return True
    if text.strip(_SHORT_AFFIRM_TAIL) not in _SHORT_AFFIRM_WORDS:
        return False
    previous = next(
        (msg for msg in reversed(messages) if msg.get("role") == "assistant"), None
    )
    if previous is None:
        return False
    prev_text = str(previous.get("content") or "")
    if "？" in prev_text or "?" in prev_text:
        return False
    return "确认" in prev_text and ("建课" in prev_text or "开始" in prev_text)


def _strip_interview_markers(text: str) -> str:
    """剥掉盘问收口标记再落库。

    未闭合的开标记也要切掉：流式期间标记可能只吐出一半，留着比全剥更难看。
    """
    cleaned = INTERVIEW_RESULT_RE.sub("", text)
    opened = cleaned.find(INTERVIEW_START)
    if opened != -1:
        cleaned = cleaned[:opened]
    return cleaned.strip()


def _maybe_prompt_interview_close(session_id: str, reply: str) -> None:
    """这一轮没吐收口标记时，判断要不要给那条可行动提示。

    只在两个条件同时成立时才发，避免盘问轮刷屏：
    - 回复里没有问号 ⇒ 模型这轮不再提问，形态上是"收尾"；
    - 本会话没发过这条提示、也没已建好的草稿。
    """
    text = _strip_interview_markers(reply)
    if "？" in text or "?" in text:
        return
    session = storage.get_session(session_id)
    if session is None:
        return
    messages = session.get("messages") or []
    if any(str(msg.get("kind") or "") == "build_confirm" for msg in messages):
        return
    if any(INTERVIEW_CLOSE_HINT in str(msg.get("content") or "") for msg in messages):
        return
    storage.add_message(session_id, "assistant", INTERVIEW_CLOSE_HINT, kind="error")


# 任务快照的终态：到点必须立即 checkpoint（不能等 0.6s 节流），保证刷新即见终态。
# timeout 与 done/error/interrupted 同为终态：到点不得再回落 running，刷新即见超时。
_TERMINAL_TASK_STATUSES = ("done", "error", "timeout", "interrupted")


def _task_is_terminal(task: Any) -> bool:
    return isinstance(task, dict) and str(task.get("status") or "") in _TERMINAL_TASK_STATUSES


def _tool_status_from_task(task: dict[str, Any]) -> str:
    """任务状态 → 旧 ToolActivity.status（interrupted 归 error 供旧卡片兜底显示）。"""
    status = str(task.get("status") or "")
    if status == "done":
        return "done"
    if status == "running":
        return "running"
    return "error"


def _accumulate_partial(bucket: dict[str, Any], event: dict[str, Any]) -> None:
    """把已回吐的事件攒进兜底桶：客户端中途断开时靠它把已产出的内容落库。

    同时按事件顺序维护 `bucket["parts"]`——这是回放时正文与工具卡交错的唯一依据。
    """
    _record_part(bucket.setdefault("parts", []), event)
    kind = str(event.get("type") or "")
    if kind == "text":
        bucket["text"].append(str(event.get("content") or ""))
    elif kind == "reasoning":
        bucket["reasoning"].append(str(event.get("content") or ""))
    elif kind == "error":
        bucket["error"] = {key: value for key, value in event.items() if key not in ("type", "message")}
        if not bucket["error"].get("summary"):
            bucket["error"] = errors.make("internal", phase="stream", summary=str(event.get("message") or "回复失败")).to_dict()
    elif kind == "notice":
        message = str(event.get("message") or "")
        if message:
            bucket["notices"].append(message)
    elif kind == "tool_call":
        bucket["tools"].append(
            {
                "id": str(event.get("id") or ""),
                "name": str(event.get("name") or ""),
                "arguments": str(event.get("arguments") or ""),
                "status": "running",
            }
        )
    elif kind == "task_update":
        # 只原位更新父工具卡的 task 快照：不 append parts、不产生 notice（高频进度刷新同一张卡）。
        # 深复制避免后续事件/调用方继续修改同一 dict 污染已落库快照（快照可能很大）。
        target = str(event.get("id") or "")
        task = event.get("task")
        if target and isinstance(task, dict):
            for tool in bucket["tools"]:
                if tool["id"] == target:
                    tool["task"] = copy.deepcopy(task)
                    tool["status"] = _tool_status_from_task(task)
                    break
    elif kind == "tool_result":
        target = str(event.get("id") or "")
        for tool in bucket["tools"]:
            if tool["id"] == target:
                tool.update(
                    {
                        "status": "error" if event.get("is_error") else "done",
                        "result": str(event.get("content") or ""),
                        "isError": bool(event.get("is_error")),
                    }
                )
                # 透传工具结构化元数据（task/lesson/assessment），供前端任务卡与系统状态卡。
                for key in ("task", "lesson", "assessment"):
                    if event.get(key) is not None:
                        tool[key] = copy.deepcopy(event[key])
                break
    elif kind == "usage":
        payload = event.get("usage")
        if isinstance(payload, dict):
            bucket["usage"] = payload


PARTIAL_DISCONNECT_NOTICE = "（本轮输出过程中连接中断，这里只保存了已经产出的部分。）"
PARTIAL_ERROR_NOTICE = "（本轮输出过程中出错，这里只保存了已经产出的部分。）"
TOOL_INTERRUPTED_RESULT = "（本轮在工具返回前结束，未收到执行结果）"

_PART_TEXT_KINDS = ("text", "reasoning", "notice")


def _record_part(parts: list[dict[str, Any]], event: dict[str, Any]) -> None:
    """按事件顺序维护有序 parts（契约同前端 types）。

    text/reasoning 与相邻同类合并；**notice 不合并**——每个 notice 事件独立成一个 part，
    与 `notices` 数组逐条一一对应（前端按条匹配，合并会与 Set 去重后的剩余 notices 错位）。
    `tool_call` 插入 `{type:'tool', tool_id}`，`tool_result`/`usage` 不新增 part
    （工具结果只更新 `tools` 数组里的原条目）。
    """
    kind = str(event.get("type") or "")
    if kind == "tool_call":
        parts.append({"type": "tool", "tool_id": str(event.get("id") or "")})
        return
    if kind not in _PART_TEXT_KINDS:
        return
    text = str(event.get("message") if kind == "notice" else event.get("content") or "")
    if not text:
        return
    if kind in ("text", "reasoning") and parts and parts[-1].get("type") == kind:
        parts[-1]["text"] = str(parts[-1].get("text") or "") + text
    else:
        parts.append({"type": kind, "text": text})


def _bucket_has_output(bucket: dict[str, Any]) -> bool:
    """有正文/思维链/工具才算产出；只有 notice 不建空助手消息。"""
    return bool(
        "".join(bucket.get("text") or []).strip()
        or "".join(bucket.get("reasoning") or []).strip()
        or bucket.get("tools")
        or bucket.get("error")
    )


# 收口标记的展示清洗：与前端 format.ts 的 INTERVIEW_BLOCK 同口径（任意内容、非贪婪）。
INTERVIEW_BLOCK_RE = re.compile(
    r"<!--INTERVIEW_RESULT-->.*?<!--/INTERVIEW_RESULT-->", re.DOTALL
)


def _hidden_spans(merged: str) -> list[tuple[int, int]]:
    """合并正文里的隐藏区间：完整标记块 + 首个未被覆盖的半截标记起至末尾（同前端）。"""
    spans = [(match.start(), match.end()) for match in INTERVIEW_BLOCK_RE.finditer(merged)]

    def covered(pos: int) -> bool:
        return any(start <= pos < end for start, end in spans)

    for pos in range(len(merged) - len(INTERVIEW_START) + 1):
        if not covered(pos) and merged.startswith(INTERVIEW_START, pos):
            spans.append((pos, len(merged)))
            break
    spans.sort()
    return spans


def _keep_outside(merged: str, start: int, end: int, hidden: list[tuple[int, int]]) -> str:
    """取 [start, end) 内未被任何隐藏区间覆盖的部分（多段顺次拼接）。"""
    out: list[str] = []
    cursor = start
    for hole_start, hole_end in hidden:
        if hole_end <= cursor or hole_start >= end:
            continue
        if hole_start > cursor:
            out.append(merged[cursor:hole_start])
        cursor = max(cursor, hole_end)
    if cursor < end:
        out.append(merged[cursor:end])
    return "".join(out)


def _clean_text(text: str) -> str:
    """单段正文清洗：剥标记 + 去首尾空白（与 `_strip_interview_markers` 口径一致）。"""
    return _keep_outside(text, 0, len(text), _hidden_spans(text)).strip()


def _clean_parts(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """保序片段清洗（对齐前端 format.ts cleanAssistantParts 的隐藏区间口径）。

    与前端逐块 trim 的唯一区别：这里只对**合并全文**裁一次全局首尾空白并映射回原
    span，保留片段之间（如 `' Hello '` / tool / `' world '`）的内部空白——存储不能丢
    内部空白，否则模型历史与复制出的正文会被粘连成 `Helloworld`。清洗后为空的 text
    片段丢弃，非 text 片段原位不动。结果满足 `join(text parts) == _clean_text(全文)`。
    """
    spans: dict[int, tuple[int, int]] = {}
    merged = ""
    for index, part in enumerate(parts):
        if part.get("type") != "text":
            continue
        piece = str(part.get("text") or "")
        spans[index] = (len(merged), len(merged) + len(piece))
        merged += piece
    hidden = _hidden_spans(merged)

    def is_hidden(pos: int) -> bool:
        return any(start <= pos < end for start, end in hidden)

    kept = [pos for pos in range(len(merged)) if not is_hidden(pos)]
    visible = "".join(merged[pos] for pos in kept)
    left = len(visible) - len(visible.lstrip())
    right = len(visible) - len(visible.rstrip())
    if right:
        kept = kept[: len(kept) - right]
    if left:
        kept = kept[left:]
    keep_set = set(kept)

    result: list[dict[str, Any]] = []
    for index, part in enumerate(parts):
        if part.get("type") != "text":
            result.append(part)
            continue
        start, end = spans[index]
        piece = "".join(merged[pos] for pos in range(start, end) if pos in keep_set)
        if piece:
            result.append({**part, "text": piece})
    return result


def _write_turn(
    session_id: str,
    bucket: dict[str, Any],
    model_label: str | None,
    *,
    turn_id: str | None = None,
    final_reason: str | None = None,
    final: bool = False,
) -> bool:
    """把当前桶落进会话：turn_id 给定时原位 upsert，否则追加（兼容旧调用）。

    这是正常落库与断开兜底的**唯一**来源——桶在 chat 的 emit 里同时看得见 run_agent
    事件与 ToolContext.emit 的工具进度，`outcome` 看不到后者，因此不另用 outcome。

    终态语义（写入助手消息的 `stream_state`）：
    - final_reason="disconnect"：仍在 running 的工具标为中断，state=interrupted；
    - final_reason="error"：state=error；
    - final=True：正常结束，state=completed；
    - 其余为中途 checkpoint，state=streaming。
    无产出（只有 notice）时不建空助手消息，返回 False。
    """
    if final_reason == "disconnect" and turn_id and errors.consume_stop(session_id, turn_id):
        final_reason = "user_stop"
    if final_reason in ("disconnect", "user_stop"):
        bucket["stopped_reason"] = final_reason
        bucket["error"] = errors.make(
            "user_stopped" if final_reason == "user_stop" else "upstream_transport",
            phase="stream", summary="已停止本轮回复。" if final_reason == "user_stop" else "连接意外中断，回复未完成。",
            stopped_reason=final_reason, request_id=turn_id,
            retryable=final_reason != "user_stop",
        ).to_dict()
    if not _bucket_has_output(bucket):
        return False
    text = "".join(bucket.get("text") or [])
    reasoning = "".join(bucket.get("reasoning") or [])
    tools = [dict(tool) for tool in (bucket.get("tools") or [])]
    notices = list(bucket.get("notices") or [])
    parts = [dict(part) for part in (bucket.get("parts") or [])]
    if final_reason is not None:
        for tool in tools:
            if tool.get("status") == "running":
                tool["status"] = "error"
                tool["isError"] = True
                if not str(tool.get("result") or "").strip():
                    tool["result"] = TOOL_INTERRUPTED_RESULT
        if not bucket.get("error"):
            notices.append(PARTIAL_DISCONNECT_NOTICE if final_reason == "disconnect" else PARTIAL_ERROR_NOTICE)
    if final_reason in ("disconnect", "user_stop"):
        stream_state = "interrupted"
    elif final_reason == "error" or bucket.get("error"):
        stream_state = "error"
    elif final:
        stream_state = "completed"
    else:
        stream_state = "streaming"
    parts = _clean_parts(parts)
    if not any(part.get("type") == "text" for part in parts) and text.strip():
        # 兼容手工构造、未带 parts 的桶：补一个清洗后的 text part，保证正文不丢。
        cleaned = _clean_text(text)
        if cleaned:
            parts = [{"type": "text", "text": cleaned}, *parts]
    # 正文口径与前端 cleanAssistantText 一致；`_clean_parts` 只裁全局首尾，故
    # `join(parts.text) == _clean_text(text)` 恒成立（内部边界空白保留在片段里）。
    content = _clean_text(text)
    fields: dict[str, Any] = {
        "reasoning": reasoning or None,
        "tools": tools or None,
        "notices": notices or None,
        "parts": parts or None,
        "model": model_label,
        "stream_state": stream_state,
    }
    if bucket.get("error"):
        fields["error"] = {**bucket["error"], "request_id": turn_id}
    if bucket.get("stopped_reason"):
        fields["stopped_reason"] = bucket["stopped_reason"]
    try:
        if turn_id:
            storage.upsert_turn_message(session_id, turn_id, content=content, **fields)
        else:
            storage.add_message(session_id, "assistant", content, **fields)
    except KeyError:  # 会话被并发删掉：兜底失败不该再抛
        return False
    return True


def _persist_partial(
    session_id: str,
    bucket: dict[str, Any],
    model_label: str | None,
    reason: str = "disconnect",
    turn_id: str | None = None,
) -> bool:
    """兜底落库：保住流式期间已经吐出去的内容（终态覆盖同一 turn_id）。见 `_write_turn`。"""
    return _write_turn(
        session_id, bucket, model_label, turn_id=turn_id, final_reason=reason
    )


def _current_session_mode(session_id: str, fallback: str) -> str:
    """按请求开始的同一条派生规则读「此刻」的会话模式。

    agent 可在一轮对话中途经 `start_course_interview` 工具把会话切进建课模式：
    收口判定若仍用请求开始时的 mode，本轮切模式 + 当场收口（一句话给足信息）就永远
    解析不到。科目绑定优先级与请求开始时一致（绑了科目一律 chat）。
    """
    session = storage.get_session(session_id)
    if session is None:
        return fallback
    if session.get("subject_slug"):
        return "chat"
    return str(session.get("mode") or fallback or "chat")


def _handle_interview_result(session_id: str, reply: str) -> dict[str, Any] | None:
    """盘问收口：解析标记 → 建草稿 → 会话里落「确认建课」卡。

    返回 confirm 事件载荷；解析失败/建冲突返回 None（错误已写成会话消息）。
    多段标记以**最后一段完整**为准（模型可能先吐半成品结论再修正）。
    """
    matches = list(INTERVIEW_RESULT_RE.finditer(reply))
    if not matches:
        _maybe_prompt_interview_close(session_id, reply)
        return None
    match = matches[-1]
    try:
        result = json.loads(match.group(1))
    except json.JSONDecodeError:
        storage.add_message(
            session_id,
            "assistant",
            f"盘问收口标记解析失败（不是合法 JSON），收到的原文：{match.group(0)[:300]}",
            kind="error",
        )
        return None
    if not isinstance(result, dict):
        storage.add_message(
            session_id, "assistant", "盘问收口标记不是 JSON 对象，无法建课。", kind="error"
        )
        return None
    missing = _interview_missing_fields(result)
    if missing:
        # 关键信息没问全就不建草稿：回错误提示要求补充（机械校验，不靠模型自述）。
        storage.add_message(
            session_id,
            "assistant",
            f"盘问收口缺少必要信息：{'、'.join(missing)}，请补充后再确认建课。",
            kind="error",
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
        if safe_attachment_path(path, PENDING_UPLOADS_DIR):
            return path
    return None


def _find_in_session(session_id: str, file_id: str) -> Path | None:
    """会话已落盘的附件（编辑重发时保留原附件，文件不重复搬动）。"""
    if not UPLOAD_ID_RE.fullmatch(file_id) or not storage.is_valid_session_id(session_id):
        return None
    session_dir = UPLOADS_DIR / session_id
    if (
        session_dir.is_symlink()
        or not storage.path_within(session_dir, UPLOADS_DIR)
        or not session_dir.is_dir()
    ):
        return None
    for path in session_dir.glob(f"{file_id}_*"):
        if safe_attachment_path(path, session_dir):
            return path
    return None


def _attachment_meta(file_id: str, path: Path) -> dict[str, Any]:
    filename = path.name.split("_", 1)[1] if "_" in path.name else path.name
    return {
        "id": file_id,
        "filename": filename,
        "kind": classify_kind(filename),
        "size": path.stat().st_size,
        "_path": str(path),
    }


def _validate_attachment_ids(attachment_ids: list[str]) -> None:
    """发送前对附件数量/格式做纯校验（不触盘）；超限或非法一律 422。"""
    if len(attachment_ids) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise HTTPException(
            422,
            f"单条消息附件数上限 {MAX_ATTACHMENTS_PER_MESSAGE} 个"
            f"（当前 {len(attachment_ids)} 个）",
        )
    seen: set[str] = set()
    for file_id in attachment_ids:
        if not UPLOAD_ID_RE.fullmatch(file_id):
            raise HTTPException(422, f"附件标识非法：{file_id}")
        if file_id in seen:
            raise HTTPException(422, f"附件标识重复：{file_id}")
        seen.add(file_id)


def _resolve_attachments(
    session_id: str | None, attachment_ids: list[str]
) -> list[tuple[str, Path]]:
    """只读解析附件的落点：返回 [(id, path)]；任一失效即 422，不搬文件、不落消息。

    在截断/建会话之前调用，保证「校验失败不产生半搬迁与幽灵消息」。
    """
    resolved: list[tuple[str, Path]] = []
    missing: list[str] = []
    for file_id in attachment_ids:
        source = _find_pending(file_id)
        if source is None and session_id:
            source = _find_in_session(session_id, file_id)
        if source is None:
            missing.append(file_id)
        else:
            resolved.append((file_id, source))
    if missing:
        raise HTTPException(
            422, f"附件不存在或已过期：{'、'.join(missing)}，请重新上传后再发送。"
        )
    return resolved


def _materialize_attachments(
    session_id: str, resolved: list[tuple[str, Path]]
) -> list[dict[str, Any]]:
    """把已校验的附件落位：pending 的移入会话目录，已在本会话目录的原地复用
    （编辑重发不重复搬运）。返回元数据（含内部寻址用的 _path）。"""
    target_dir = UPLOADS_DIR / session_id
    metas: list[dict[str, Any]] = []
    for file_id, source in resolved:
        if source.parent == target_dir:
            target = source
        else:
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / source.name
            shutil.move(str(source), str(target))
        metas.append(_attachment_meta(file_id, target))
    return metas


def _cleanup_attachments(
    session_id: str, removed: list[dict[str, Any]], keep_ids: set[str]
) -> None:
    """删除被截断消息留下的附件文件，避免盘上堆积。

    两道保护（2026-10-04）：
    - `keep_ids`：本次仍要重发的附件（编辑重发会原样复用会话目录里的文件）；
    - **会话里其它消息仍在引用的 id**：同一附件可以被多条消息引用，只按"被截断"就删文件
      会让后面那条消息的图片变 404。
    """
    session_dir = UPLOADS_DIR / session_id
    if (
        not storage.is_valid_session_id(session_id)
        or session_dir.is_symlink()
        or not storage.path_within(session_dir, UPLOADS_DIR)
        or not session_dir.is_dir()
    ):
        return
    session = storage.get_session(session_id)
    if session is None:
        return
    survivors = {
        str(attachment.get("id") or "")
        for message in session.get("messages") or []
        for attachment in message.get("attachments") or []
    }
    for message in removed:
        for attachment in message.get("attachments") or []:
            file_id = str(attachment.get("id") or "")
            if not file_id or file_id in keep_ids or file_id in survivors:
                continue
            for path in session_dir.glob(f"{file_id}_*"):
                if path.is_file():
                    path.unlink(missing_ok=True)


def _attachment_block(attachment: dict[str, Any]) -> str:
    filename = str(attachment["filename"])
    if attachment.get("kind") == "image":
        # 图片走多模态注入（_load_images / inject_images），不属于文档解析，返回空块
        return ""
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
        if not block:  # 图片：不进文本（由多模态注入承担）
            continue
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
    session = _require_session(session_id)
    # 前端停止后 poll 用：会话键仍被在飞轮次占用 ⇒ 仍在流式（即使还没有助手消息）。
    session["streaming"] = concurrency.is_active(concurrency.session_key(session_id))
    return session


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str) -> dict[str, bool]:
    _require_session(session_id)
    # 短作用域租约：完整覆盖删除操作，避免"检查后被在飞轮次追上"的竞态；
    # 正常前端停止后会话键已释放，删除照常可用。
    lease = concurrency.Lease()
    try:
        _acquire_session(lease, session_id, SESSION_BUSY_EDIT_MESSAGE)
        return {"ok": storage.delete_session(session_id)}
    finally:
        lease.release()


@router.patch("/sessions/{session_id}")
def patch_session(session_id: str, payload: SessionPatchRequest) -> dict[str, Any]:
    """改标题 / 换会话工作区 / 绑定或解绑模型（均可选）。

    「没传」与「显式 null」用 model_fields_set 区分：只传 title 维持旧行为；
    workspace 显式 null（或空串）清空绑定，回到全局发现；非空值须是存在目录。
    active 传三元组则把该会话绑到指定模型（校验提供商与模型都存在，否则 422）；
    显式 null 解绑，回到当前默认模型。
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
    if "active" in payload.model_fields_set:
        if payload.active is None:
            fields["active"] = None
        else:
            bound = payload.active.model_dump()
            if get_session_provider(bound) is None:
                raise HTTPException(422, "模型不可用：提供商已停用/不存在，或该模型已不在模型表里")
            fields["active"] = bound
    if not fields:
        raise HTTPException(422, "没有要更新的字段（title / workspace / active 三选一或都给）")
    updated = storage.update_session(session_id, **fields)
    assert updated is not None  # 上一步 _require_session 已确认会话存在
    return updated


@router.delete("/sessions/{session_id}/messages/{index}")
def delete_turn(session_id: str, index: int) -> dict[str, Any]:
    """删除整轮：index 指向该轮的用户消息或助手回复，成对删掉（对照 DeepTutor 的删整轮）。

    用户消息配它后面紧邻的助手回复；助手消息配它前面紧邻的用户消息。两侧都不存在时
    只删这一条（例如流式中断留下的孤立助手占位）。附件随之清理。
    """
    # 删除整轮会破坏在飞轮次的数据：先占租约（短作用域，完整覆盖 storage 改动），
    # 再在锁内重读会话、校验下标并按锁内快照算 targets——不能拿 acquire 前的旧快照。
    lease = concurrency.Lease()
    try:
        _acquire_session(lease, session_id, SESSION_BUSY_EDIT_MESSAGE)
        session = _require_session(session_id)
        messages: list[dict[str, Any]] = session["messages"]
        if index < 0 or index >= len(messages):
            raise HTTPException(404, f"消息下标不存在：{index}")
        role = messages[index].get("role")
        targets = {index}
        if role == "assistant" and index - 1 >= 0 and messages[index - 1].get("role") == "user":
            targets.add(index - 1)
        elif role == "user" and index + 1 < len(messages) and messages[index + 1].get("role") == "assistant":
            targets.add(index + 1)
        removed = storage.drop_messages(session_id, targets)
        _cleanup_attachments(session_id, removed, keep_ids=set())
        updated = storage.require_session(session_id)
    finally:
        lease.release()
    return {
        "ok": True,
        "deleted": sorted(targets),
        "messages": updated["messages"],
    }


@router.post("/chat/stream")
async def chat_stream(payload: ChatRequest):
    try:
        return await _chat_stream(payload)
    except HTTPException as exc:
        code = {503: "skills_missing", 409: "session_busy"}.get(exc.status_code, "invalid_request")
        info = errors.make(code, phase="preflight", summary=str(exc.detail), detail=str(exc.detail),
                           status=exc.status_code, retryable=exc.status_code in (409, 503)).to_dict()
        return JSONResponse(status_code=exc.status_code, content={"detail": info["summary"], "error": info})


async def _chat_stream(payload: ChatRequest):
    """SSE 流式对话。事件：session / delta / reasoning / notice / tool_call / tool_result
    / usage / confirm / done / error。

    会话模式（拍板⑧/F）：关联科目的会话注入 local-qa（chat 链路收口）；
    建课会话（mode=interview）注入 learning-system + learning-discovery，
    盘问收口标记解析后建草稿并落「确认建课」卡。
    """
    # 技能规范先于一切副作用检查（缺失 503 时不建会话、不留消息）：
    # 模式先于会话定——已有会话看其 mode/科目联动，新会话看 payload.mode
    session_id = payload.session_id
    if session_id and not storage.is_valid_session_id(session_id):
        # 非法 ID（含 `..\settings` 这类路径穿越）一律 422，不触盘、不误当新会话
        raise HTTPException(422, f"会话标识非法：{session_id}")
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
    # 会话绑定的模型/档位优先（2026-10-04）：绑定了就用它，绑定失效（提供商/模型被删或停用）
    # 则回落到当前默认模型，并在流里给一条提示——不能让会话静默跑在别的模型上。
    bound_active = existing.get("active") if existing is not None else None
    provider = get_session_provider(bound_active) if bound_active else None
    model_fallback_notice: str | None = None
    if provider is None:
        if bound_active:
            model_fallback_notice = "会话绑定的模型已不可用，已回退到当前默认模型。"
        provider = get_active_provider()
    if is_fixture_mode() and provider is None:
        provider = {"model": "fixture", "api_format": "openai_chat"}
    model_label = _model_label(provider)

    # 会话级工作区：已有会话沿用其绑定；新建会话按请求里的可选 workspace 建
    # （先校验目录存在，不存在 422 → 不建会话、不留消息；入会话 JSON 前归一化为字符串）
    ws_candidate = existing.get("workspace") if existing is not None else None
    if ws_candidate is None and (payload.workspace or "").strip():
        ws_candidate = str(optional_workspace(payload.workspace))
    ws_bound: str | None = ws_candidate

    # 附件发送前完整校验（纯校验 + 只读解析）：超限/非法/失效 id 一律 422，
    # 且发生在建会话/截断/搬文件之前——失败不留下空会话、半搬迁或幽灵消息。
    _validate_attachment_ids(payload.attachment_ids)
    resolved_attachments = _resolve_attachments(session_id, payload.attachment_ids)

    # 一次请求一个租约：预返回异常 / SSE iterator-finally / background 三条释放路径
    # 共享它（once + owner-token 校验，防 ABA 误释放新 owner）。
    guard_lease = concurrency.Lease()
    if existing is not None:
        _acquire_session(guard_lease, str(session_id), SESSION_BUSY_MESSAGE)

    async def _respond() -> StreamingResponse:
        nonlocal session_id
        if existing is not None:
            session = existing
        else:
            session = storage.create_session(mode=mode, workspace=ws_bound)
            session_id = session["id"]
            session = storage.require_session(session_id)
            # 新会话拿到 id 后立刻占键：返回流之前就已经有守卫，后续同 id 请求直接 409。
            _acquire_session(guard_lease, session_id, SESSION_BUSY_MESSAGE)

        with workspace_ctx.bind(ws_bound):
            # 编辑重发：先把被编辑的那条用户消息及其后的全部消息截断（它们会被新文本取代），
            # 再追加新的用户消息。被截断消息的附件先清盘（仍要重发的原附件由 keep_ids 保留）。
            if existing is not None and payload.replace_from is not None:
                if int(payload.replace_from) < 0:
                    raise HTTPException(422, "replace_from 不能为负")
                removed = storage.truncate_messages(session_id, int(payload.replace_from))
                _cleanup_attachments(session_id, removed, keep_ids=set(payload.attachment_ids))
                session = storage.require_session(session_id)

            # 附件落位（已在上方校验过）：pending 移入会话目录，已在本会话目录的原地复用
            attachments = _materialize_attachments(session_id, resolved_attachments)
            # 附件文本提取是同步重活（PDF 解析上限 20MB）：挪到线程池，别堵住事件循环
            # （堵住会让同一进程里其它 SSE 流、上传一起"卡住"）
            effective_text = await asyncio.to_thread(
                _compose_effective_text, payload.message, attachments
            )
            stored_attachments = [
                {key: attachment[key] for key in ("id", "filename", "kind", "size")}
                for attachment in attachments
            ]
            storage.add_message(
                session_id,
                "user",
                effective_text,
                # 展示文本与模型上下文文本分离（R7）：正文气泡/编辑框用原文，
                # 附件提取文本仍只在 effective_text（LLM history content 不变）。
                display_content=payload.message,
                attachments=stored_attachments or None,
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

            # K1/K2 工具化开关先算好：系统提示是否提示产课/评估工具，与工具上下文共用同一判据。
            # 工具调用默认对所有配置的模型开启（2026-10-04）；fixture 模式仅在显式工具场景走循环。
            fixture_tool = is_fixture_mode() and payload.fixture_scenario in agent_svc.FIXTURE_TOOL_SCENARIOS
            use_tools = fixture_tool or (not is_fixture_mode() and supports_tools(provider))
            # 只有绑定了科目的会话才开放产课/评估动作工具（未绑定会话不得凭空产课/评估）
            offer_actions = use_tools and bool(context_slug)
            # 建课收口阶段（显式判据）：interview 会话 + 用户明确确认建课 ⇒ 本轮工具面清空、
            # 只做纯最终输出（预算 1 次 + 最多 1 修复）。一般盘问轮的只读工具保留不动。
            finalize_phase = mode == "interview" and _is_interview_finalize_phase(
                session["messages"], payload.message
            )

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
            if offer_actions:
                # 一行动作提示，不注入技能全文（细节规范由模型按需 read_skill）
                subject_name = (cs.get_subject(context_slug) or {}).get("name") or context_slug
                messages.append(
                    {
                        "role": "system",
                        "content": (
                            f"【工具】本会话关联科目「{subject_name}」（{context_slug}）。"
                            "要产课调用 produce_lesson（按大纲顺序，未指定节点则产出第一个未产出的节点）；"
                            "要评估调用 assess_node（需学习者给出作答原文）。"
                            "细节规范用 read_skill 按需读取（learning-coach / lesson-design / practice-evaluator）。"
                            "工具状态是权威：产品/评估是否落盘只看工具返回的系统状态（task/lesson/assessment）；"
                            "文字点评不等于评估落盘；没有成功任务时不得承诺后台修复或稍后完成。"
                        ),
                    }
                )
            if finalize_phase:
                # 收口阶段的补充口径：只整理已确认信息，缺关键值必须追问，不得凭空创建。
                messages.append(
                    {"role": "system", "content": prompts.INTERVIEW_FINALIZE_PROMPT}
                )
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
            # 收口阶段本轮 schemas=[]（纯最终输出，不跑工具）；一般盘问轮只读工具照常。
            tool_schemas = (
                []
                if finalize_phase
                else (
                    tools_svc.schemas(
                        tools_svc.CHAT_TOOLS
                        + (tools_svc.CHAT_ACTION_TOOLS if offer_actions else ())
                    )
                    if use_tools
                    else []
                )
            )
            # 工具进度回吐通道（提前建好）：产课/评估工具经 ToolContext.state["emit"] 把进度转成 notice
            queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
            # checkpoint/兜底桶：边发边攒，且是正常落库与断开兜底的唯一来源——它同时看得见
            # run_agent 事件与 ToolContext.emit 的工具进度（outcome 看不到后者）。
            partial: dict[str, Any] = {
                "text": [],
                "reasoning": [],
                "tools": [],
                "notices": [],
                "parts": [],
                "usage": None,
            }
            # 每轮助手回复固定一个 turn_id：checkpoint 与终态都按它原位 upsert，绝不重复 append。
            turn_id = uuid.uuid4().hex
            checkpoint_state: dict[str, float] = {"last": 0.0}

            def checkpoint(kind: str, *, force: bool = False) -> None:
                """中途 checkpoint：工具边界/notice 立即写，正文/思维链/任务快照按间隔节流。

                任务快照终态由调用方以 force=True 传进来（立即落库，刷新即见终态）。
                """
                if not _bucket_has_output(partial):
                    return
                now = time.monotonic()
                if (
                    not force
                    and kind in ("text", "reasoning", "task_update")
                    and now - checkpoint_state["last"] < CHECKPOINT_INTERVAL
                ):
                    return
                if _write_turn(session_id, partial, model_label, turn_id=turn_id):
                    checkpoint_state["last"] = now

            def record_notice(message: str) -> None:
                """把直接 yield 的 preamble notice 也收进桶，保证落库 notice 与流一致。"""
                _accumulate_partial(partial, {"type": "notice", "message": message})
                checkpoint("notice", force=True)

            async def emit(event: dict[str, Any]) -> None:
                _accumulate_partial(partial, event)
                kind = str(event.get("type") or "")
                # task_update 的近似高频进度按 0.6s 节流；任务进终态立即 checkpoint。
                checkpoint(
                    kind,
                    force=kind == "task_update" and _task_is_terminal(event.get("task")),
                )
                await queue.put(event)

            if use_tools:
                bound_subject = cs.get_subject(context_slug) if context_slug else None
                read_roots = [cs.subject_dir(context_slug)] if context_slug else [cs.subjects_dir()]
                tool_ctx = tools_svc.ToolContext(
                    read_roots=read_roots,
                    write_roots=[],
                    label=str(bound_subject.get("name")) if bound_subject else "工作区",
                    state={
                        "session_id": session_id,
                        "slug": context_slug,
                        "node_id": context_node,
                        "workspace": ws_bound,
                        "emit": emit,
                    },
                )
                turn_source = (
                    agent_svc.fixture_turn_source(str(payload.fixture_scenario), payload.fixture_scenario)
                    if fixture_tool
                    else agent_svc.real_turn_source(provider, payload.fixture_scenario)  # type: ignore[arg-type]
                )

            async def _tool_event_source():
                """工具化对话的队列驱动 SSE：agent 事件（text/tool_call/tool_result）转发并落审计。"""
                yield _sse("session", {"session_id": session_id})

                if model_fallback_notice:
                    record_notice(model_fallback_notice)
                    yield _sse("notice", {"message": model_fallback_notice})

                if binding_notice:
                    record_notice(binding_notice)
                    yield _sse("notice", {"message": binding_notice})

                if not is_fixture_mode() and (provider is None or not provider.get("api_key")):
                    info = errors.make("no_api_key", phase="preflight", summary="尚未配置模型 API Key，请到 Settings 填写。", request_id=turn_id).to_dict()
                    partial["error"] = info
                    _write_turn(session_id, partial, model_label, turn_id=turn_id, final_reason="error")
                    yield _sse("error", {"message": info["summary"], **info})
                    return

                if stage1_notice:
                    record_notice(stage1_notice)
                    yield _sse("notice", {"message": stage1_notice})

                if finalize_phase:
                    # 阶段状态只在这一轮发一次（不是心跳刷屏），并落库供刷新后回放。
                    notice = finalize_notice()
                    record_notice(notice)
                    yield _sse("notice", {"message": notice})

                audit.bind(f"chat-{session_id}")
                event_names = {
                    "text": "delta",
                    "reasoning": "reasoning",
                    "tool_call": "tool_call",
                    "tool_result": "tool_result",
                    "task_update": "task_update",
                    "usage": "usage",
                    "notice": "notice",
                    "confirm": "confirm",
                    "error": "error",
                }

                async def runner() -> None:
                    persisted = False
                    try:
                        # 开放产课/评估工具时必须给长墙钟：工具执行在每轮的 asyncio.wait_for 之外，
                        # 一次产课可达数分钟；若沿用聊天 300s 上限，工具返回后下一轮会在循环顶部
                        # 撞上已过期的 deadline，整轮被降级为 wallclock。聊天（无动作工具）仍用 300s。
                        # 收口阶段只做纯最终输出，用更短的专用墙钟。
                        budget_seconds = (
                            agent_svc.INTERVIEW_FINALIZE_MAX_SECONDS
                            if finalize_phase
                            else (
                                agent_svc.ORCH_MAX_SECONDS
                                if offer_actions
                                else agent_svc.CHAT_MAX_SECONDS
                            )
                        )
                        outcome = await agent_svc.run_agent(
                            turn_source,
                            messages,
                            tool_ctx,
                            emit,
                            tool_schemas,
                            budget=(
                                agent_svc.INTERVIEW_FINALIZE_BUDGET if finalize_phase else None
                            ),
                            max_seconds=budget_seconds,
                            audit_meta={
                                "kind": "chat",
                                "turn_id": turn_id,
                                "session_id": session_id,
                                "model": str(provider.get("model") or ""),
                            },
                        )
                        reply = outcome.text
                        if outcome.error:
                            partial["error"] = {**outcome.error, "request_id": turn_id}
                        if outcome.stopped_reason:
                            partial["stopped_reason"] = outcome.stopped_reason
                        if outcome.degraded and not outcome.error:
                            await emit({"type": "notice", "message": f"（本轮受控收尾：{outcome.stopped_reason or 'budget'}。）"})
                        # 正常终态：把累积桶（含 emit 期间的 parts/notices/tools）原位写回同一
                        # turn_id；桶里没产出就不建空助手消息。
                        if _bucket_has_output(partial):
                            _write_turn(
                                session_id, partial, model_label, turn_id=turn_id, final=True
                            )
                            persisted = True
                        if outcome.usage:
                            storage.update_session(session_id, usage=outcome.usage)
                            await queue.put({"type": "usage", "usage": outcome.usage})
                        # 收口判定用「此刻」的会话模式：agent 本轮可能刚经工具切进建课模式
                        if not outcome.error and _current_session_mode(session_id, mode) == "interview":
                            confirm_event = _handle_interview_result(session_id, reply)
                            if confirm_event is not None:
                                await queue.put({"type": "confirm", **confirm_event})
                    except asyncio.CancelledError:
                        # 客户端断开（切会话 / 关页 / 点停止）：把已产出内容按同一 turn_id 落成
                        # 中断终态（仍在 running 的工具标为中断），再让取消继续往上抛。
                        if not persisted:
                            _persist_partial(
                                session_id, partial, model_label, reason="disconnect", turn_id=turn_id
                            )
                        raise
                    except Exception as exc:  # noqa: BLE001 - 统一转 SSE 错误事件
                        info = errors.from_exception(exc, request_id=turn_id).to_dict()
                        partial["error"] = info
                        if not persisted:
                            _persist_partial(
                                session_id, partial, model_label, reason="error", turn_id=turn_id
                            )
                        await queue.put({"type": "error", "message": info["summary"], **info})
                    finally:
                        with contextlib.suppress(asyncio.CancelledError):
                            await queue.put({"type": "__end__"})

                task = asyncio.create_task(runner())
                try:
                    while True:
                        event = await _queue_get_heartbeat(queue)
                        if event is None:  # 静默期心跳：让断开及时触发取消与租约释放
                            yield SSE_HEARTBEAT
                            continue
                        if event.get("type") == "__end__":
                            break
                        name = event_names.get(str(event.get("type")), "notice")
                        yield _sse(name, {key: value for key, value in event.items() if key != "type"})
                finally:
                    # 客户端断开时 Starlette 会取消这个迭代任务：**必须把 runner 一起取消**，
                    # 否则孤儿任务会继续打网关、烧 token，还可能往已被编辑截断的会话里追加
                    # "幽灵消息"（此前是 `await task`，取消时立刻抛 CancelledError，不等待也不取消）。
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
                yield _sse("done", {"session_id": session_id})

            async def tool_event_generator():
                # SSE 由 StreamingResponse 在别的任务里迭代：这里重新挂绑定，
                # 保证后续 agent 工具循环读取到的科目/工作区与该会话一致
                with workspace_ctx.bind(ws_bound):
                    errors.register_turn(session_id, turn_id)
                    try:
                        async for event in _tool_event_source():
                            yield event
                    finally:
                        errors.clear_turn(session_id, turn_id)

            async def _plain_event_source():
                # 先把 session_id 发给前端（新建会话时前端需要）
                yield _sse("session", {"session_id": session_id})

                if model_fallback_notice:
                    record_notice(model_fallback_notice)
                    yield _sse("notice", {"message": model_fallback_notice})

                if binding_notice:
                    record_notice(binding_notice)
                    yield _sse("notice", {"message": binding_notice})

                if finalize_phase:
                    notice = finalize_notice()
                    record_notice(notice)
                    yield _sse("notice", {"message": notice})

                if not is_fixture_mode() and (provider is None or not provider.get("api_key")):
                    info = errors.make("no_api_key", phase="preflight", summary="尚未配置模型 API Key，请到 Settings 填写。", request_id=turn_id).to_dict()
                    partial["error"] = info
                    _write_turn(session_id, partial, model_label, turn_id=turn_id, final_reason="error")
                    yield _sse("error", {"message": info["summary"], **info})
                    return

                events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
                persisted = False
                stream_error: BaseException | None = None

                async def produce() -> None:
                    """把上游流搬进队列：正文/notice 逐条入队，结束/异常各发一个哨兵。

                    放到独立任务里，SSE 侧才能一边等事件一边发心跳——上游静默读取期间
                    也能让断开被及时检测到。
                    """
                    try:
                        if stage1_notice:
                            await events.put({"type": "notice", "message": stage1_notice})

                        def make_stream(items: list[dict[str, Any]]) -> AsyncGenerator[str, None]:
                            return stream_chat(provider, items, fixture_scenario=payload.fixture_scenario)

                        generator, first, retry_notice = await prime_stream(
                            make_stream, messages, str(provider.get("model") or "")
                        )
                        if retry_notice:
                            await events.put({"type": "notice", "message": retry_notice})
                        piece = first
                        while piece is not None:
                            await events.put({"type": "text", "content": piece})
                            try:
                                piece = await generator.__anext__()
                            except StopAsyncIteration:
                                break
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:  # noqa: BLE001 - 交给 SSE 侧统一转错误事件
                        await events.put(
                            {"type": "__error__", "exception": exc}
                        )
                    finally:
                        with contextlib.suppress(asyncio.CancelledError, Exception):
                            await events.put({"type": "__end__"})

                task = asyncio.create_task(produce())
                try:
                    while True:
                        event = await _queue_get_heartbeat(events)
                        if event is None:
                            yield SSE_HEARTBEAT
                            continue
                        kind = str(event.get("type") or "")
                        if kind == "__end__":
                            break
                        if kind == "__error__":
                            stream_error = event.get("exception") or RuntimeError("上游连接异常")
                            break
                        if kind == "notice":
                            record_notice(str(event.get("message") or ""))
                            yield _sse("notice", {"message": event.get("message")})
                        else:
                            _accumulate_partial(partial, event)
                            checkpoint("text")
                            yield _sse("delta", {"content": event.get("content")})
                    if stream_error is not None:
                        raise stream_error
                    # 正常终态：同一 turn_id 原位写回（part 交错与正文一并落库）。
                    if _bucket_has_output(partial):
                        _write_turn(
                            session_id, partial, model_label, turn_id=turn_id, final=True
                        )
                        persisted = True
                    # fixture 模式没有真实网关：补一条假用量，让右栏用量栏在 E2E 里可断言
                    if is_fixture_mode():
                        storage.update_session(session_id, usage=dict(agent_svc.FIXTURE_USAGE))
                        yield _sse("usage", {"usage": dict(agent_svc.FIXTURE_USAGE)})
                    if mode == "interview":
                        reply = "".join(partial.get("text") or [])
                        confirm_event = _handle_interview_result(session_id, reply)
                        if confirm_event is not None:
                            yield _sse("confirm", confirm_event)
                    yield _sse("done", {"session_id": session_id})
                except Exception as exc:  # noqa: BLE001 - 统一转成 SSE 错误事件
                    info = errors.from_exception(exc, request_id=turn_id).to_dict()
                    partial["error"] = info
                    if not persisted:
                        _persist_partial(
                            session_id, partial, model_label, reason="error", turn_id=turn_id
                        )
                        persisted = True
                    yield _sse("error", {"message": info["summary"], **info})
                finally:
                    # 取消（切会话 / 关页 / 点停止）走 CancelledError/GeneratorExit，上面
                    # 的 except 抓不到：先取消生产者，再把已产出内容落成中断终态。
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
                    if not persisted:
                        _persist_partial(
                            session_id, partial, model_label, reason="disconnect", turn_id=turn_id
                        )

            async def event_generator():
                # 与工具化路径同理：迭代期重挂绑定，防止 ContextVar 丢失/跨请求泄漏
                with workspace_ctx.bind(ws_bound):
                    errors.register_turn(session_id, turn_id)
                    try:
                        async for event in _plain_event_source():
                            yield event
                    finally:
                        errors.clear_turn(session_id, turn_id)

            stream = tool_event_generator() if use_tools else event_generator()
            return StreamingResponse(
                # 守卫随流生命周期释放：正常结束 / 取消（前端停止、切会话、关页）/
                # 异常都释放；guarded_stream 与 background 共享同一租约（once + token
                # 校验），重复释放 no-op，也不会误释放之后的新 owner。
                concurrency.guarded_stream(stream, guard_lease),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
                background=BackgroundTask(guard_lease.release),
            )

    try:
        return await _respond()
    except BaseException:
        guard_lease.release()
        raise
