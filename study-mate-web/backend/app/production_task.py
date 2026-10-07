"""产课父工具任务（ProductionTask）的状态归约、节流回吐与课件入口校验。

背景（§5.1 C 行）：聊天里调 `produce_lesson` 过去只把 progress 每 10s 折成一条
`notice`，刷新后过程全丢。现在改为**一次父工具任务**：`tools._tool_produce_lesson`
用本模块把产课链回吐的事件（stage / role_start / role_event / role_end / retry /
handoff / done / error）归约成一份完整快照，经 `emit({type:"task_update", id, task})`
原位回吐；chat 把它存到对应 `tools[i].task`，前端在原位展示，不再新增 notice/part。

职责边界：
- 本模块只做归约与回吐，不触盘、不派工、不改产课语义；真实文件校验由
  `lesson_link` 在**返回前**做（HTML 存在、可读、且与 listLessons 口径一致）。
- 子角色的正文/工具活动经 `role_event` 进入快照，按角色可回放；工具 id 带 role id
  前缀避免多角色同名 call id 冲突。正文/工具结果限长并**明确标注截断**，有序保留。
- `progress` 是时间心跳：只更新 `elapsed_s`，绝不 append 事件。
- 取消/异常收尾由调用方 `finalize`：running 角色一并转 interrupted，不假造 done。
"""
from __future__ import annotations

import asyncio
import contextlib
import copy
import re
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

KIND_PRODUCE_LESSON = "produce_lesson"

STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_ERROR = "error"
STATUS_TIMEOUT = "timeout"
STATUS_INTERRUPTED = "interrupted"

_ROLE_TERMINAL = (STATUS_DONE, STATUS_ERROR, STATUS_TIMEOUT, STATUS_INTERRUPTED)
_STAGE_STATUS = {"start": STATUS_RUNNING, "done": STATUS_DONE, "fail": STATUS_ERROR}

# UI 回吐上限：不把大段交付正文 / 工具文件 content 全灌进 SSE 快照。
ROLE_TEXT_LIMIT = 4000
TOOL_RESULT_LIMIT = 1500
TOOL_ARG_LIMIT = 800

# 正文截断提示单独一行、放在闭合围栏之外；前端可另据 part.truncated 提示。
TEXT_TRUNCATED_NOTICE = "\n\n…（角色正文过长，已截断显示）"
_INTERVIEW_BLOCK_RE = re.compile(
    r"<!--INTERVIEW_RESULT-->.*?<!--/INTERVIEW_RESULT-->", re.DOTALL
)
_INTERVIEW_START = "<!--INTERVIEW_RESULT-->"

_LESSON_HTML_RE = re.compile(r"^(\d+)-(.+)\.html$")


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return f"{text[:limit]}…（已截断，共 {len(text)} 字符）"


def _coerce_seconds(value: Any) -> float | None:
    """角色调用时限（秒）。缺省/非法返回 None；<=0 原样保留（表示不限时，不承诺有限等待）。"""
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _problem_head(problems: Any) -> str:
    """问题清单取首条摘要（给 stage/retry 的 message 用）。"""
    if not isinstance(problems, list) or not problems:
        return ""
    first = problems[0]
    if isinstance(first, dict):
        return str(first.get("message") or first.get("path") or "")
    return str(first)


def _safe_cut(text: str, limit: int) -> str:
    """按完整行边界截断；没有足够靠前的换行才硬切（避免半行/半围栏）。"""
    slice_ = text[:limit]
    newline = slice_.rfind("\n")
    if newline >= int(limit * 0.6):
        slice_ = slice_[:newline]
    return slice_.rstrip()


def _has_open_fence(text: str) -> bool:
    """是否留下了未闭合的 ``` 围栏（奇数个开围栏行）。"""
    open_fence = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            open_fence = not open_fence
    return open_fence


def _sanitize_role_text(text: str) -> str:
    """角色正文里若混入建课收口标记，先清掉完整块、再截到落单的开标记处。

    只处理被截断的正文（未截断时前端已有同口径隐藏逻辑），确保截断不会把标记内的
    内部 JSON 泄进快照。
    """
    text = _INTERVIEW_BLOCK_RE.sub("", text)
    index = text.find(_INTERVIEW_START)
    if index != -1:
        text = text[:index]
    return text.rstrip()


def _finalize_truncated(text: str) -> str:
    """截断收尾：安全切行 → 清标记 → 闭合围栏 → 补单独一行的截断提示。"""
    kept = _sanitize_role_text(_safe_cut(text, ROLE_TEXT_LIMIT))
    if _has_open_fence(kept):
        kept = kept.rstrip("\n") + "\n```"
    return kept + TEXT_TRUNCATED_NOTICE


class ProductionTaskReducer:
    """产课事件流 → ProductionTask 快照的纯归约器（不打印、不落盘、不 await）。"""

    def __init__(
        self,
        *,
        task_id: str,
        title: str,
        subject_slug: str,
        node_id: str,
        workspace: str,
        kind: str = KIND_PRODUCE_LESSON,
    ) -> None:
        self._task: dict[str, Any] = {
            "id": str(task_id),
            "kind": str(kind),
            "title": str(title),
            "subject_slug": str(subject_slug),
            "node_id": str(node_id),
            "workspace": str(workspace),
            "status": STATUS_RUNNING,
            "round": 0,
            "elapsed_s": 0.0,
            "roles": [],
            "events": [],
        }
        self._started = time.monotonic()
        self._roles: dict[str, dict[str, Any]] = {}
        self._role_started: dict[str, float] = {}
        self._stages: dict[tuple[str, int], dict[str, Any]] = {}
        self._attempt = 0
        self._sequence = 0

    # ---------- 终态 / 心跳 ----------

    def touch(self, elapsed_s: float | None = None) -> None:
        """只更新 elapsed（时间心跳），不 append 任何日志。

        任务 elapsed 是总时长；每个**运行中**角色另按自身开始时刻刷新 elapsed，
        角色一旦终态即冻结（done 的耗时不再继续涨）。
        """
        value = time.monotonic() - self._started if elapsed_s is None else elapsed_s
        self._task["elapsed_s"] = round(float(value), 1)
        now = time.monotonic()
        for role in self._task["roles"]:
            if role.get("status") != STATUS_RUNNING:
                continue
            started = self._role_started.get(role["id"])
            if started is not None:
                role["elapsed_s"] = round(now - started, 1)

    def set_lesson(self, lesson: dict[str, Any] | None) -> None:
        if lesson:
            self._task["lesson"] = copy.deepcopy(lesson)

    def finalize(self, status: str, error: str | None = None) -> None:
        """收尾：置任务终态；仍在 running 的角色一并转 interrupted（不假造过程）。

        终态不再有「当前阶段」，清掉 stage 字段，免得终态快照仍声称某阶段在跑；
        历史 events 的真实状态一律保留（不把未完成的阶段伪报 done）。
        """
        self._task["status"] = status
        if error:
            self._task["error"] = str(error)
        self._clear_current_stage()
        for role in self._task["roles"]:
            if role["status"] == STATUS_RUNNING:
                role["status"] = STATUS_INTERRUPTED
                started = self._role_started.get(role["id"])
                if started is not None:
                    role["elapsed_s"] = round(time.monotonic() - started, 1)
        self.touch()

    def _clear_current_stage(self) -> None:
        """只清任务级「当前阶段」指针，不动 events 里历史阶段的真实状态。"""
        self._task.pop("stage", None)

    def snapshot(self) -> dict[str, Any]:
        return copy.deepcopy(self._task)

    # ---------- 事件归约 ----------

    def consume(self, event: dict[str, Any]) -> None:
        kind = str(event.get("event") or "")
        if kind == "stage":
            self._consume_stage(event)
        elif kind == "role_start":
            self._role_start(event)
        elif kind == "role_event":
            self._role_event(event)
        elif kind == "role_end":
            self._role_end(event)
        elif kind == "retry":
            self._consume_retry(event)
        elif kind == "handoff":
            self._consume_handoff(event)
        elif kind == "done":
            self._task["status"] = STATUS_DONE
            self._clear_current_stage()
        elif kind == "error":
            self._task["status"] = STATUS_ERROR
            self._task["error"] = str(event.get("message") or "产课失败")
            self._clear_current_stage()
        # progress 是心跳：只改 elapsed（由调用方 touch），不 append

    def _consume_stage(self, event: dict[str, Any]) -> None:
        name = str(event.get("stage") or "").strip()
        if not name:
            return
        status = _STAGE_STATUS.get(str(event.get("status") or ""), STATUS_RUNNING)
        key = (name, self._attempt)
        stage = self._stages.get(key)
        if stage is None:
            stage = {"id": f"{name}#{self._attempt}", "name": name, "status": status}
            self._stages[key] = stage
            self._task["events"].append(stage)
        stage["status"] = status
        message = self._stage_message(event)
        if message:
            stage["message"] = message
        if status == STATUS_RUNNING:
            self._task["stage"] = name

    @staticmethod
    def _stage_message(event: dict[str, Any]) -> str:
        problems = event.get("problems") or []
        if problems:
            head = _problem_head(problems)
            more = f" 等 {len(problems)} 条" if len(problems) > 1 else ""
            return _truncate(f"{head}{more}", 300)
        message = event.get("message")
        return _truncate(str(message), 300) if message else ""

    def _consume_retry(self, event: dict[str, Any]) -> None:
        owners = "、".join(str(o) for o in event.get("owners") or []) or "总控"
        head = _problem_head(event.get("problems"))
        reason = str(event.get("reason") or "")
        if reason:
            label = "派工重派"
            message = f"{owners}原值重派：{head or reason}"
        else:
            self._attempt = max(self._attempt + 1, int(event.get("round") or 0))
            self._task["round"] = self._attempt
            label = "打回"
            message = f"第 {self._attempt} 轮打回（{owners}）：{head or '按报错修正'}"
        self._sequence += 1
        self._task["events"].append(
            {
                "id": f"{label}#{self._sequence}",
                "name": label,
                "status": STATUS_DONE,
                "message": _truncate(message, 300),
            }
        )

    def _consume_handoff(self, event: dict[str, Any]) -> None:
        ticket = event.get("ticket") or {}
        ticket_id = str(ticket.get("id") or "") if isinstance(ticket, dict) else ""
        self._sequence += 1
        self._task["events"].append(
            {
                "id": f"转人工#{self._sequence}",
                "name": "转人工",
                "status": STATUS_ERROR,
                "message": f"质检未过，已转人工（工单 {ticket_id}）" if ticket_id else "质检未过，已转人工",
            }
        )

    # ---------- 角色 ----------

    def _role_start(self, event: dict[str, Any]) -> None:
        role_id = str(event.get("role_id") or "").strip()
        if not role_id:
            return
        role = self._roles.get(role_id)
        if role is None:
            name = str(event.get("role") or event.get("name") or "角色")
            role = {"id": role_id, "name": name, "status": STATUS_RUNNING, "parts": [], "tools": []}
            round_no = event.get("round")
            if isinstance(round_no, int) and not isinstance(round_no, bool):
                role["round"] = round_no
            self._roles[role_id] = role
            self._role_started[role_id] = time.monotonic()
            self._task["roles"].append(role)
        # 派工方式（tools=角色工具循环，fallback=循环未交付后的单次备用派工，
        # single_call=直连单次）；缺省视为旧事件/普通角色，不发明默认值。
        mode = str(event.get("execution_mode") or "").strip()
        if mode:
            role["execution_mode"] = mode
        fallback_reason = str(event.get("fallback_reason") or "").strip()
        if fallback_reason:
            role["fallback_reason"] = fallback_reason
        max_seconds = _coerce_seconds(event.get("max_seconds"))
        if max_seconds is not None:
            role["max_seconds"] = max_seconds
        role["status"] = STATUS_RUNNING

    def _role_event(self, event: dict[str, Any]) -> None:
        role_id = str(event.get("role_id") or "").strip()
        role = self._roles.get(role_id)
        if role is None:
            return
        etype = str(event.get("type") or "")
        if etype in ("text", "reasoning"):
            self._append_text(role, etype, str(event.get("content") or ""))
        elif etype == "tool_call":
            self._tool_call(role, event)
        elif etype == "tool_result":
            self._tool_result(role, event)

    @staticmethod
    def _append_text(role: dict[str, Any], etype: str, text: str) -> None:
        if not text:
            return
        parts = role["parts"]
        if parts and parts[-1].get("type") == etype:
            part = parts[-1]
            if part.get("truncated"):
                return  # 已截断：后续增量丢弃（有序保留已显示部分）
            combined = str(part.get("text") or "") + text
            if len(combined) <= ROLE_TEXT_LIMIT:
                part["text"] = combined
            else:
                part["text"] = _finalize_truncated(combined)
                part["truncated"] = True
            return
        if len(text) <= ROLE_TEXT_LIMIT:
            parts.append({"type": etype, "text": text})
        else:
            parts.append({"type": etype, "text": _finalize_truncated(text), "truncated": True})

    def _tool_call(self, role: dict[str, Any], event: dict[str, Any]) -> None:
        raw_id = str(event.get("id") or "")
        tool_id = f"{role['id']}:{raw_id}"
        role["parts"].append({"type": "tool", "tool_id": tool_id})
        role["tools"].append(
            {
                "id": tool_id,
                "name": str(event.get("name") or ""),
                "arguments": _truncate(str(event.get("arguments") or ""), TOOL_ARG_LIMIT),
                "status": STATUS_RUNNING,
            }
        )

    def _tool_result(self, role: dict[str, Any], event: dict[str, Any]) -> None:
        raw_id = str(event.get("id") or "")
        tool_id = f"{role['id']}:{raw_id}"
        for tool in role["tools"]:
            if tool["id"] != tool_id:
                continue
            tool["status"] = STATUS_ERROR if event.get("is_error") else STATUS_DONE
            tool["result"] = _truncate(str(event.get("content") or ""), TOOL_RESULT_LIMIT)
            tool["isError"] = bool(event.get("is_error"))
            return

    def _role_end(self, event: dict[str, Any]) -> None:
        role_id = str(event.get("role_id") or "").strip()
        role = self._roles.get(role_id)
        if role is None:
            return
        status = str(event.get("status") or "")
        role["status"] = status if status in _ROLE_TERMINAL else STATUS_DONE
        message = str(event.get("message") or "").strip()
        if message:
            role["message"] = _truncate(message, 300)
        started = self._role_started.get(role_id)
        if started is not None:
            # 按角色自身开始时刻结算；终态后 touch 不再改写（done 耗时冻结）。
            role["elapsed_s"] = round(time.monotonic() - started, 1)


class TaskUpdateStream:
    """把 reducer 事件节流回吐成 `task_update` 快照，并跑一条只改 elapsed 的心跳。"""

    def __init__(
        self,
        reducer: ProductionTaskReducer,
        emit: Callable[[dict[str, Any]], Awaitable[None]] | None,
        *,
        text_interval: float = 0.3,
        heartbeat_interval: float = 3.0,
    ) -> None:
        self._reducer = reducer
        self._emit = emit
        self._text_interval = max(0.0, text_interval)
        self._heartbeat_interval = max(0.1, heartbeat_interval)
        self._last_emit = 0.0
        self._heartbeat: asyncio.Task[None] | None = None

    @property
    def reducer(self) -> ProductionTaskReducer:
        return self._reducer

    async def _send(self) -> None:
        if self._emit is None:
            return
        task = self._reducer.snapshot()
        self._last_emit = time.monotonic()
        await self._emit({"type": "task_update", "id": task["id"], "task": task})

    async def consume(self, event: dict[str, Any]) -> None:
        self._reducer.consume(event)
        kind = str(event.get("event") or "")
        force = kind in (
            "stage",
            "retry",
            "handoff",
            "done",
            "error",
            "role_start",
            "role_end",
        )
        if kind == "role_event":
            force = str(event.get("type") or "") not in ("text", "reasoning")
        if force or time.monotonic() - self._last_emit >= self._text_interval:
            await self._send()

    async def start(self) -> None:
        await self._send()
        if self._emit is not None:
            self._heartbeat = asyncio.create_task(self._run_heartbeat())

    async def _run_heartbeat(self) -> None:
        while True:
            await asyncio.sleep(self._heartbeat_interval)
            self._reducer.touch()
            await self._send()

    async def stop(self) -> None:
        task = self._heartbeat
        self._heartbeat = None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._reducer.touch()
        await self._send()

    async def emit_current(self) -> None:
        """收尾后补发一次当前快照（如刚补上 lesson 入口的最终 flush）。"""
        self._reducer.touch()
        await self._send()


def lesson_link(
    *,
    base: Path,
    subject_slug: str,
    node_id: str,
    title: str,
    workspace: str,
    artifacts: Any,
    node_ids: set[str] | None = None,
) -> dict[str, Any] | None:
    """真实校验后的课件入口（相对 lessons/HTML 路径）。

    只在 HTML 产物确实存在、可读，且与 listLessons 口径一致（
    `lessons/<NNNN>-<node_id>.html`，且该节点仍在课表里）时返回；失败/handoff/
    伪造路径一律返回 None——不凭产物清单伪造入口。
    """
    if node_ids is not None and str(node_id) not in node_ids:
        return None
    resolved_base = base.resolve()
    for raw in artifacts or []:
        norm = str(raw).replace("\\", "/")
        if not norm.startswith("lessons/") or not norm.endswith(".html"):
            continue
        name = norm[len("lessons/") :]
        if "/" in name:
            continue
        match = _LESSON_HTML_RE.match(name)
        if not match or match.group(2) != node_id:
            continue
        target = (resolved_base / norm).resolve()
        if target != resolved_base and resolved_base not in target.parents:
            continue
        try:
            if not target.is_file():
                continue
            with target.open("rb") as handle:
                if not handle.read(1):
                    continue
        except OSError:
            continue
        return {
            "subject_slug": str(subject_slug),
            "node_id": str(node_id),
            "title": str(title),
            "workspace": str(workspace),
            "file": norm,
        }
    return None
