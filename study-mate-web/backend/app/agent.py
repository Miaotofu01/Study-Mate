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
import json
from dataclasses import dataclass
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
}
FIXTURE_TOOL_SCENARIOS = tuple(FIXTURE_TOOL_SCRIPTS)


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
            if turn.get("text"):
                yield {"type": "text", "content": str(turn["text"])}
            if turn.get("tool_calls"):
                # 预算耗尽轮（tools 为空）时不再执行脚本里的工具调用
                if tools:
                    yield {"type": "tool_calls", "tool_calls": turn["tool_calls"]}
                else:
                    yield {"type": "text", "content": "（工具已停用，直接作答。）"}
            return
        async for piece in llm._fixture_stream(fallback_scenario):  # noqa: SLF001 - 复用固定流
            yield {"type": "text", "content": piece}

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
) -> AgentOutcome:
    budget = budget or AgentBudget()
    messages = list(messages)
    text_parts: list[str] = []
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
        rounds += 1
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
            try:
                async for event in turn_source(messages, tools_active):
                    if event["type"] == "text":
                        piece = str(event["content"])
                        if piece:
                            turn_text.append(piece)
                            text_parts.append(piece)
                            await emit({"type": "text", "content": piece})
                    elif event["type"] == "tool_calls":
                        calls = list(event.get("tool_calls") or [])
                break
            except Exception as exc:  # noqa: BLE001 - 传输失败：未可见则重试，已可见则降级
                if text_parts or attempt >= turn_retries:
                    audit.record("agent_transport_error", round=rounds, error=str(exc))
                    await emit({"type": "notice", "message": f"（上游中断，带着已有内容收尾：{exc}）"})
                    return AgentOutcome(
                        "".join(text_parts), rounds, tool_count, degraded=True, stopped_reason="transport"
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
                    "".join(text_parts), rounds, tool_count, degraded=True, stopped_reason="idle"
                )
            audit.record(
                "agent_done", rounds=rounds, tool_calls=tool_count, text="".join(text_parts)
            )
            return AgentOutcome("".join(text_parts), rounds, tool_count)

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
            await emit({"type": "tool_call", "id": call_id, "name": name, "arguments": str(call.get("arguments") or "")})
            result = await _execute_tool(name, call.get("arguments"), ctx)
            audit.record(
                "tool_call",
                id=call_id,
                name=name,
                arguments=str(call.get("arguments") or ""),
                is_error=bool(result.get("is_error")),
                result=str(result.get("content") or ""),
            )
            await emit(
                {
                    "type": "tool_result",
                    "id": call_id,
                    "name": name,
                    "content": str(result.get("content") or ""),
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
        "".join(text_parts), rounds, tool_count, degraded=True, stopped_reason="budget"
    )


async def _execute_tool(name: str, arguments: Any, ctx: ToolContext) -> dict[str, Any]:
    from . import tools as tools_svc

    return await tools_svc.execute(name, arguments, ctx)


def _clamp(text: str) -> str:
    if len(text) > TOOL_RESULT_LIMIT:
        return f"{text[:TOOL_RESULT_LIMIT]}\n…（工具结果超长截断）"
    return text
