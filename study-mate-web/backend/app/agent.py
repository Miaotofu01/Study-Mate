"""Agent loop runner（K0 基建）：带工具的多轮循环，预算分层 + 失控降级。

形态取自尽调存档 §二（DeepTutor 起步值 + DSH 折中）：

- 终止判据：某轮 LLM 不再发起 tool_calls，其文本即最终答案。
- 预算：探索 8 轮（工具可用）+ 收尾 3 轮（工具仍可用但注入"尽快收尾"提示）+
  强制收尾 1 轮（去掉 tools，模型只能出文本）；"只思考不行动"最多救 2 次。
- 防打转：连续相同的调用在 3/5/8 次发提醒（不阻断）。
- 工具失败一律转 `role:tool` 错误文本让模型自愈，不炸循环。
- 传输失败：尚未产出可见输出时重试；已可见则带着已有文本降级收尾。

事件经 `emit` 回吐（text / tool_call / tool_result / notice），调用方转 SSE 并
按需持久化；每次工具调用与结果同时追加写审计（`audit.record`）。
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import time
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Awaitable, Callable

from . import audit
from . import llm
from .tools import ToolContext

Emit = Callable[[dict[str, Any]], Awaitable[None]]
TurnSource = Callable[[list[dict[str, Any]], list[dict[str, Any]]], AsyncGenerator[dict[str, Any], None]]
# 单次工具结果回吐进上下文时的上限（完整内容已落审计文件）
TOOL_RESULT_LIMIT = 20000
WRAPUP_NUDGE = "（预算将尽：请尽快用已有信息收尾，不要再发起新的工具调用。）"
FORCED_NUDGE = "（工具预算已耗尽：请只根据已获得的信息，直接给出最终答复。）"
IDLE_NUDGE = "（上一轮没有任何输出，请直接给出最终答复。）"
# 墙钟上限（2026-10-04）：轮数预算之外再兜一层"单次总时长"。
# 为什么需要：`llm.REQUEST_TIMEOUT` 是 **per-read** 超时，网关只要在窗口内吐过字节就永不触发
# （实测有会话在 `agent_start` 之后静默 9507s）；轮数预算也封不住"一轮本身跑了半小时"。
# 两个口径分开：聊天一轮 300s 就该给答案了；建课/产课的单次派工实测可达 694s，给 1800s。
CHAT_MAX_SECONDS = float(os.getenv("STUDYMATE_CHAT_MAX_SECONDS", "300") or 300)
ORCH_MAX_SECONDS = float(os.getenv("STUDYMATE_ORCH_MAX_SECONDS", "1800") or 1800)


@dataclass(frozen=True)
class AgentBudget:
    explore_rounds: int = 8
    wrapup_rounds: int = 3
    forced_rounds: int = 1
    idle_rescues: int = 2

    @property
    def total_rounds(self) -> int:
        return self.explore_rounds + self.wrapup_rounds + self.forced_rounds


@dataclass
class AgentOutcome:
    text: str
    rounds: int
    tool_calls: int
    degraded: bool = False
    stopped_reason: str = ""
    # 本轮累计的思维链原文（落库进助手消息，供折叠区回放）
    reasoning: str = ""
    # 最后一次 LLM 调用的用量（网关在末块带 usage；无渠道时为 None）
    usage: dict[str, int] | None = None
    # 本轮工具调用与结果（落库进助手消息，字段名与前端 ToolActivity 对齐）
    tools: list[dict[str, Any]] = field(default_factory=list)


class ProgressReporter:
    """把「第几轮 / 思考了多少字 / 已等待多久」定期回吐，让编排卡能显示"确实在工作"。

    做法上刻意不逐条转发：思维链一次几千条（实测单轮 3396 个事件），转发会把 SSE 打爆。
    这里只做两件事——事件驱动地记数（`note`，不发包）+ 定时发一份快照（`_tick`）。
    即使快照没有变化也照发：**"已经等了 128 秒"本身就是用户需要的信息**。
    """

    def __init__(self, emit_progress: Emit, interval: float = 5.0) -> None:
        self._emit = emit_progress
        self._interval = max(0.5, interval)
        self._started = time.monotonic()
        self.round = 0
        self.reasoning_chars = 0
        self.text_chars = 0
        self.tool_calls = 0
        self.last_tool = ""
        self._task: asyncio.Task[None] | None = None

    def note(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "reasoning":
            self.reasoning_chars += len(str(event.get("content") or ""))
        elif kind == "text":
            self.text_chars += len(str(event.get("content") or ""))
        # turn_source 吐的是整批 tool_calls（复数）；单数形态只有 SSE 出站事件用，
        # 两种都认，免得计数又悄悄归零（真机实测：20 次调用曾报 0）。
        elif kind == "tool_calls":
            batch = event.get("tool_calls") or []
            self.tool_calls += len(batch)
            if batch:
                self.last_tool = str((batch[-1] or {}).get("name") or self.last_tool)
        elif kind == "tool_call":
            self.tool_calls += 1
            if event.get("name"):
                self.last_tool = str(event["name"])

    def snapshot(self, **extra: Any) -> dict[str, Any]:
        return {
            "round": self.round,
            "elapsed_s": round(time.monotonic() - self._started, 1),
            "reasoning_chars": self.reasoning_chars,
            "text_chars": self.text_chars,
            "tool_calls": self.tool_calls,
            "last_tool": self.last_tool,
            **extra,
        }

    async def _tick(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            await self._emit(self.snapshot())

    async def __aenter__(self) -> "ProgressReporter":
        await self._emit(self.snapshot())  # 先发一帧：按下按钮马上有东西出现
        self._task = asyncio.create_task(self._tick())
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._task is None:
            return
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task
        self._task = None


def real_turn_source(
    provider: dict[str, Any], fixture_scenario: str | None = None
) -> TurnSource:
    async def source(
        messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> AsyncGenerator[dict[str, Any], None]:
        async for event in llm.stream_turn(
            provider, messages, tools=tools or None, fixture_scenario=fixture_scenario
        ):
            yield event

    return source


# ---------- fixture 脚本（E2E）：canned tool_calls 序列 ----------

FIXTURE_TOOL_SCRIPTS: dict[str, list[dict[str, Any]]] = {
    "tools": [
        {"tool_calls": [{"id": "call-1", "name": "list_workspace", "arguments": "{}"}]},
        {
            "tool_calls": [
                {
                    "id": "call-2",
                    "name": "read_course_file",
                    "arguments": json.dumps({"path": "MISSION.md"}),
                }
            ]
        },
        {"text": "工具已就绪：我看过工作区，也读到了科目资料。下面开始讲解。"},
    ],
    # 过程折叠场景（E2E）：思维链 + 工具调用 + 结论，供折叠区与用量栏断言
    "process": [
        {
            "reasoning": "先看看工作区里有什么资料，再决定讲什么。",
            "tool_calls": [{"id": "call-1", "name": "list_workspace", "arguments": "{}"}],
        },
        {
            "reasoning": "读一下 MISSION.md，确认这门课的教学口径。",
            "tool_calls": [
                {
                    "id": "call-2",
                    "name": "read_course_file",
                    "arguments": json.dumps({"path": "MISSION.md"}),
                }
            ],
        },
        {"reasoning": "资料齐了，可以给出结论。", "text": "（过程折叠场景）我看过工作区与资料，下面开始讲解。"},
    ],
    # 会话动作工具场景（E2E 契约）：绑定科目的会话里，产课 / 评估改由 chat agent 调工具完成。
    # 节点用 E2E 种子科目「计算机网络」大纲里的第一位 net.layers（按大纲顺序产课的先决条件：
    # 它是排序最靠前、前置为空的节点，未产出时位次 1 == 已产出 0 + 1，顺序守卫必过）。
    "produce": [
        {
            "tool_calls": [
                {
                    "id": "call-1",
                    "name": "produce_lesson",
                    "arguments": json.dumps({"node_id": "net.layers"}, ensure_ascii=False),
                }
            ]
        },
        {"text": "已产出这一课：讲解与题库都已落盘，可以继续往后推进或让我评估你的掌握情况。"},
    ],
    "assess": [
        {
            "tool_calls": [
                {
                    "id": "call-1",
                    "name": "assess_node",
                    "arguments": json.dumps(
                        {
                            "node_id": "net.layers",
                            "evidence": "分层模型把一次请求拆成多段处理，每层加自己的首部，封装就是逐层加头。",
                        },
                        ensure_ascii=False,
                    ),
                }
            ]
        },
        {"text": "评估完成：判定与掌握度已写入评估记录，可打开记录查看判分细节。"},
    ],
}
FIXTURE_TOOL_SCENARIOS = tuple(FIXTURE_TOOL_SCRIPTS)
# fixture 模式下的假用量：真实网关在末块带 usage，E2E 需要确定性数字
FIXTURE_USAGE: dict[str, int] = {
    "prompt_tokens": 11500,
    "completion_tokens": 320,
    "total_tokens": 11820,
}


def fixture_turn_source(scenario: str, fallback_scenario: str | None = None) -> TurnSource:
    """按脚本逐轮吐；脚本耗尽后回落纯文本 fixtures 流。"""
    script = list(FIXTURE_TOOL_SCRIPTS.get(scenario) or [])
    cursor = {"index": 0}

    async def source(
        messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> AsyncGenerator[dict[str, Any], None]:
        if cursor["index"] < len(script):
            turn = script[cursor["index"]]
            cursor["index"] += 1
            if turn.get("reasoning"):
                yield {"type": "reasoning", "content": str(turn["reasoning"])}
            if turn.get("text"):
                yield {"type": "text", "content": str(turn["text"])}
            if turn.get("tool_calls"):
                # 预算耗尽轮（tools 为空）时不再执行脚本里的工具调用
                if tools:
                    yield {"type": "tool_calls", "tool_calls": turn["tool_calls"]}
                else:
                    yield {"type": "text", "content": "（工具已停用，直接作答。）"}
            yield {"type": "usage", "usage": dict(FIXTURE_USAGE)}
            return
        async for piece in llm._fixture_stream(fallback_scenario):  # noqa: SLF001 - 复用固定流
            yield {"type": "text", "content": piece}
        yield {"type": "usage", "usage": dict(FIXTURE_USAGE)}

    return source


# ---------- 主循环 ----------


def _signature(calls: list[dict[str, Any]]) -> str:
    return json.dumps([[c.get("name"), c.get("arguments")] for c in calls], ensure_ascii=False)


async def run_agent(
    turn_source: TurnSource,
    messages: list[dict[str, Any]],
    ctx: ToolContext,
    emit: Emit,
    tool_schemas: list[dict[str, Any]],
    *,
    budget: AgentBudget | None = None,
    turn_retries: int = 2,
    audit_meta: dict[str, Any] | None = None,
    max_seconds: float | None = None,
    on_progress: Emit | None = None,
    progress_interval: float = 5.0,
) -> AgentOutcome:
    """带工具的多轮循环（公开入口）。

    `max_seconds` = 墙钟上限（到点用现有内容收尾，stopped_reason="wallclock"）；
    `on_progress` = 进度快照回调（编排卡靠它显示「第 N 轮 · 已等待 Ns」，见 ProgressReporter）。
    """
    reporter = ProgressReporter(on_progress, progress_interval) if on_progress is not None else None
    if reporter is not None:
        await reporter.__aenter__()
    try:
        return await _run_agent_loop(
            turn_source,
            messages,
            ctx,
            emit,
            tool_schemas,
            budget=budget,
            turn_retries=turn_retries,
            audit_meta=audit_meta,
            max_seconds=max_seconds,
            reporter=reporter,
        )
    finally:
        if reporter is not None:
            await reporter.__aexit__(None, None, None)


async def _run_agent_loop(
    turn_source: TurnSource,
    messages: list[dict[str, Any]],
    ctx: ToolContext,
    emit: Emit,
    tool_schemas: list[dict[str, Any]],
    *,
    budget: AgentBudget | None = None,
    turn_retries: int = 2,
    audit_meta: dict[str, Any] | None = None,
    max_seconds: float | None = None,
    reporter: "ProgressReporter | None" = None,
) -> AgentOutcome:
    budget = budget or AgentBudget()
    deadline = time.monotonic() + max_seconds if max_seconds else None
    messages = list(messages)
    text_parts: list[str] = []
    reasoning_parts: list[str] = []
    tool_activities: list[dict[str, Any]] = []
    usage: dict[str, int] | None = None
    tool_count = 0
    rounds = 0
    repeat_sig = ""
    repeat_count = 0
    idle = 0
    wrapup_notified = False
    forced = False
    tools_active = list(tool_schemas)

    if audit_meta:
        audit.record("agent_start", **audit_meta)

    while rounds < budget.total_rounds:
        if deadline is not None and time.monotonic() >= deadline:
            audit.record("agent_wallclock", rounds=rounds, limit_s=max_seconds)
            await emit(
                {"type": "notice", "message": f"（已到单次时长上限 {max_seconds:.0f}s，用现有内容收尾。）"}
            )
            return AgentOutcome(
                "".join(text_parts),
                rounds,
                tool_count,
                degraded=True,
                stopped_reason="wallclock",
                reasoning="".join(reasoning_parts),
                usage=usage,
                tools=tool_activities,
            )
        rounds += 1
        if reporter is not None:
            reporter.round = rounds
        if rounds > budget.explore_rounds + budget.wrapup_rounds and not forced:
            tools_active = []
            forced = True
            messages.append({"role": "user", "content": FORCED_NUDGE})
        elif rounds == budget.explore_rounds + 1 and not wrapup_notified:
            wrapup_notified = True
            messages.append({"role": "user", "content": WRAPUP_NUDGE})

        turn_text: list[str] = []
        calls: list[dict[str, Any]] = []
        attempt = 0
        while True:
            turn_text.clear()
            calls = []
            async def consume() -> None:
                nonlocal calls, usage
                async for event in turn_source(messages, tools_active):
                    if reporter is not None:
                        reporter.note(event)
                    if event["type"] == "text":
                        piece = str(event["content"])
                        if piece:
                            turn_text.append(piece)
                            text_parts.append(piece)
                            await emit({"type": "text", "content": piece})
                    elif event["type"] == "reasoning":
                        piece = str(event["content"])
                        if piece:
                            reasoning_parts.append(piece)
                            await emit({"type": "reasoning", "content": piece})
                    elif event["type"] == "usage":
                        payload = event.get("usage")
                        if isinstance(payload, dict):
                            usage = {
                                key: int(value)
                                for key, value in payload.items()
                                if isinstance(value, (int, float)) and not isinstance(value, bool)
                            }
                    elif event["type"] == "tool_calls":
                        calls = list(event.get("tool_calls") or [])

            remaining = None if deadline is None else deadline - time.monotonic()
            try:
                if remaining is None:
                    await consume()
                else:
                    await asyncio.wait_for(consume(), timeout=max(0.1, remaining))
                break
            except asyncio.TimeoutError:
                # 单轮本身跑过了墙钟上限：不再重试/不再等（这正是"永久卡住"的成因）
                audit.record("agent_wallclock_turn", round=rounds, limit_s=max_seconds)
                await emit(
                    {"type": "notice", "message": f"（单轮超过 {max_seconds:.0f}s 上限，用现有内容收尾。）"}
                )
                return AgentOutcome(
                    "".join(text_parts),
                    rounds,
                    tool_count,
                    degraded=True,
                    stopped_reason="wallclock",
                    reasoning="".join(reasoning_parts),
                    usage=usage,
                    tools=tool_activities,
                )
            except Exception as exc:  # noqa: BLE001 - 传输失败：未可见则重试，已可见则降级
                # 确定性错误（400 / 鉴权失败等）重试也不会成功：直接降级，别白等 + 白烧请求
                transient = llm._is_transient(exc)  # noqa: SLF001 - 与 chat_once 共用同一判据
                if text_parts or reasoning_parts or not transient or attempt >= turn_retries:
                    audit.record("agent_transport_error", round=rounds, error=str(exc))
                    produced = bool(text_parts or reasoning_parts)
                    await emit(
                        {
                            "type": "notice",
                            "message": (
                                f"（上游中断，带着已有内容收尾：{exc}）"
                                if produced
                                else f"（本轮未能产出内容：{exc}）"
                            ),
                        }
                    )
                    return AgentOutcome(
                        "".join(text_parts),
                        rounds,
                        tool_count,
                        degraded=True,
                        stopped_reason="transport",
                        reasoning="".join(reasoning_parts),
                        tools=tool_activities,
                        usage=usage,
                    )
                attempt += 1
                await asyncio.sleep(1.5 * attempt)

        if not calls:
            final_text = "".join(turn_text)
            if not final_text.strip():
                idle += 1
                if idle <= budget.idle_rescues and rounds < budget.total_rounds:
                    messages.append({"role": "user", "content": IDLE_NUDGE})
                    continue
                return AgentOutcome(
                    "".join(text_parts),
                    rounds,
                    tool_count,
                    degraded=True,
                    stopped_reason="idle",
                    reasoning="".join(reasoning_parts),
                    tools=tool_activities,
                    usage=usage,
                )
            audit.record(
                "agent_done", rounds=rounds, tool_calls=tool_count, text="".join(text_parts)
            )
            return AgentOutcome(
                "".join(text_parts),
                rounds,
                tool_count,
                reasoning="".join(reasoning_parts),
                tools=tool_activities,
                usage=usage,
            )

        signature = _signature(calls)
        repeat_count = repeat_count + 1 if signature == repeat_sig else 1
        repeat_sig = signature

        messages.append(
            {"role": "assistant", "content": "".join(turn_text), "tool_calls": calls}
        )
        for call in calls:
            tool_count += 1
            call_id = str(call.get("id") or f"call-{tool_count}")
            name = str(call.get("name") or "")
            arguments = str(call.get("arguments") or "")
            tool_activities.append(
                {"id": call_id, "name": name, "arguments": arguments, "status": "running"}
            )
            await emit({"type": "tool_call", "id": call_id, "name": name, "arguments": arguments})
            result = await _execute_tool(name, call.get("arguments"), ctx)
            is_error = bool(result.get("is_error"))
            content = str(result.get("content") or "")
            for activity in tool_activities:
                if activity["id"] == call_id:
                    activity.update(
                        {"status": "error" if is_error else "done", "result": content, "isError": is_error}
                    )
                    break
            audit.record(
                "tool_call",
                id=call_id,
                name=name,
                arguments=arguments,
                is_error=is_error,
                result=content,
            )
            await emit(
                {
                    "type": "tool_result",
                    "id": call_id,
                    "name": name,
                    "content": content,
                    "is_error": bool(result.get("is_error")),
                }
            )
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": name,
                    "content": _clamp(str(result.get("content") or "(no output)")),
                    "is_error": bool(result.get("is_error")),
                }
            )

        if repeat_count in (3, 5, 8):
            messages.append(
                {
                    "role": "user",
                    "content": f"（你已连续 {repeat_count} 次发起完全相同的调用，可能陷入了打转：请换一个思路或直接作答。）",
                }
            )

    audit.record("agent_exhausted", rounds=rounds, tool_calls=tool_count)
    return AgentOutcome(
        "".join(text_parts),
        rounds,
        tool_count,
        degraded=True,
        stopped_reason="budget",
        reasoning="".join(reasoning_parts),
        tools=tool_activities,
        usage=usage,
    )


async def _execute_tool(name: str, arguments: Any, ctx: ToolContext) -> dict[str, Any]:
    from . import tools as tools_svc

    return await tools_svc.execute(name, arguments, ctx)


def _clamp(text: str) -> str:
    if len(text) > TOOL_RESULT_LIMIT:
        return f"{text[:TOOL_RESULT_LIMIT]}\n…（工具结果超长截断）"
    return text
