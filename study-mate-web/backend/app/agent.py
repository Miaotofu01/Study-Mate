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
from . import llm, errors
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
# 建课收口阶段的墙钟：本轮只做纯最终输出（不跑工具），不需要聊天那 300s；
# 默认取聊天上限与 120s 的较小值，可用 STUDYMATE_INTERVIEW_FINALIZE_MAX_SECONDS 覆盖。
INTERVIEW_FINALIZE_MAX_SECONDS = float(
    os.getenv("STUDYMATE_INTERVIEW_FINALIZE_MAX_SECONDS", str(min(CHAT_MAX_SECONDS, 120)))
    or min(CHAT_MAX_SECONDS, 120)
)

# 盘问收口标记（与 chat.py 同口径）：完整成对出现才视为「已收口」。
INTERVIEW_MARKER_OPEN = "<!--INTERVIEW_RESULT-->"
INTERVIEW_MARKER_CLOSE = "<!--/INTERVIEW_RESULT-->"

# 工具结果里可随工具卡下发的结构化元数据（tool_result 与 tool_activities 一并保留）。
TOOL_METADATA_KEYS = ("task", "lesson", "assessment")

# assess_node 判失败、工具未自带 assessment 时给模型的受控纠正：约束收尾不要把失败说成成功。
ASSESS_FAILURE_CORRECTION = (
    "（系统状态：assess_node 未落盘——评估失败，未写入评估记录、未置位。"
    "请如实说明评估未完成或失败，不要声称已写入评估记录、已置位或已掌握；"
    "信息足够时可重试，或在回复里请学习者补充作答。）"
)


def has_complete_interview_marker(text: str) -> bool:
    """文本里是否有完整成对的收口标记（开标记出现在闭标记之前）。"""
    opened = text.find(INTERVIEW_MARKER_OPEN)
    if opened == -1:
        return False
    return text.find(INTERVIEW_MARKER_CLOSE, opened + len(INTERVIEW_MARKER_OPEN)) != -1


def _parse_arguments(arguments: Any) -> dict[str, Any]:
    if isinstance(arguments, dict):
        return arguments
    if isinstance(arguments, str) and arguments.strip():
        try:
            parsed = json.loads(arguments)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def assessment_failure_meta(
    name: str, arguments: Any, ctx: ToolContext, content: str
) -> dict[str, Any] | None:
    """assess_node 失败且结果没带 assessment 时，补一份确定性失败元数据。

    node_id 从工具参数解析、subject_slug 取会话上下文（ctx.state.slug）：供前端系统
    状态卡如实展示「评估未落盘」，不靠删正文假装可靠。
    """
    if name != "assess_node":
        return None
    args = _parse_arguments(arguments)
    meta: dict[str, Any] = {
        "status": "failed",
        "node_id": str(args.get("node_id") or "").strip(),
        "subject_slug": str((ctx.state or {}).get("slug") or "").strip(),
        "background": False,
    }
    text = str(content or "").strip()
    if text:
        meta["error"] = text
    return meta


@dataclass(frozen=True)
class AgentBudget:
    explore_rounds: int = 8
    wrapup_rounds: int = 3
    forced_rounds: int = 1
    idle_rescues: int = 2

    @property
    def total_rounds(self) -> int:
        return self.explore_rounds + self.wrapup_rounds + self.forced_rounds


# 建课收口阶段预算：1 次纯最终输出 + 最多 1 次修复（forced 轮去工具再给一次）。
INTERVIEW_FINALIZE_BUDGET = AgentBudget(explore_rounds=1, wrapup_rounds=0, forced_rounds=1)


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
    error: dict[str, Any] | None = None


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
    "produce_next": [
        {
            "tool_calls": [
                {"id": "call-1", "name": "produce_lesson", "arguments": "{}"},
            ]
        },
        {"text": "已按大纲顺序处理下一节尚未产出的课件，请以工具结果为准。"},
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
    # 产课任务卡场景（E2E）：真实跑 produce_lesson fixture 链生成 HTML，工具回吐
    # task/lesson 元数据并 emit task_update；前端据此渲染任务卡而非旧工具卡。
    "production_task": [
        {
            "tool_calls": [
                {
                    "id": "call-1",
                    "name": "produce_lesson",
                    "arguments": json.dumps({"node_id": "net.layers"}, ensure_ascii=False),
                }
            ]
        },
        {"text": "已产出该课：讲解与题库都已落盘，可在任务卡打开课件继续学习。"},
    ],
    # 评估确定性失败场景（E2E）：节点不存在 ⇒ 真实 assess 失败且无 assessment 元数据；
    # agent 补 status=failed 机器状态。末段故意说「我认为通过」，用于断言系统状态仍为 failed。
    "assessment_failure": [
        {
            "tool_calls": [
                {
                    "id": "call-1",
                    "name": "assess_node",
                    "arguments": json.dumps(
                        {"node_id": "fixture-missing-node", "evidence": "fixture作答"},
                        ensure_ascii=False,
                    ),
                }
            ]
        },
        {"text": "我认为通过——不过以系统状态为准：若评估未落盘，请补全作答后再评估。"},
    ],
    # 流序 E2E 场景（fixture_scenario=stream_order）：三段独特正文与两次工具调用交错，
    # 每次工具静默 ~2s（靠 tool_calls 的 delay 键），总时长 ~5s。用于验证
    # 「编辑请继续 → 工具执行中切换会话 → 切回/停止」时 SSE 心跳、中途 checkpoint、
    # 有序 parts 与中断终态，最终落库内容与顺序可精确断言。
    "stream_order": [
        {
            "reasoning": "先确认学习进度，再读课件。",
            "text": "先检查学习进度。",
            "tool_calls": [
                {
                    "id": "order-1",
                    "name": "read_course_file",
                    "arguments": json.dumps({"path": "MISSION.md"}),
                    "delay": 2,
                }
            ],
        },
        {
            "text": "已查看进度，接着读取课件。",
            "tool_calls": [
                {
                    "id": "order-2",
                    "name": "read_course_file",
                    "arguments": json.dumps({"path": "MISSION.md"}),
                    "delay": 2,
                }
            ],
        },
        {"text": "本轮学习内容已整理完成。"},
    ],
    # 建课切换场景（E2E，2026-10-05 拍板③）：普通会话里 agent 经 start_course_interview
    # 切入建课模式并当场收口——收口判定用「本轮结束时的会话模式」，同轮即出「确认建课」卡。
    # 标记载荷与 llm.FIXTURE_INTERVIEW_SEGMENTS 末段一致（落到同一名草稿 python）。
    "interview_switch": [
        {
            "tool_calls": [
                {"id": "call-1", "name": "start_course_interview", "arguments": "{}"},
            ],
        },
        {
            "text": (
                "好——就以「用 Python 做一个小工具」为目标来盘科目。"
                "盘问收口：科目定为「Python 实用小工具」。"
                '<!--INTERVIEW_RESULT-->{"name": "Python 实用小工具", "purpose": "能独立写出解决日常问题的小脚本", '
                '"level": "能独立做项目", "background": "没学过编程", "project": "批量整理文件的命令行工具", '
                '"carrier": "jupyter"}<!--/INTERVIEW_RESULT-->'
            ),
        },
    ],
}
FIXTURE_ERROR_SCENARIOS = ("partial503", "empty503", "unexpected_eof", "transport_error")
FIXTURE_TOOL_SCENARIOS = (*FIXTURE_TOOL_SCRIPTS, *FIXTURE_ERROR_SCENARIOS)
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
        if scenario in FIXTURE_ERROR_SCENARIOS:
            if scenario != "empty503":
                yield {"type": "text", "content": "我已经开始整理这节课，但回复尚未完成。"}
            if scenario in ("partial503", "empty503"):
                raise llm.ProviderError('HTTP 503: {"error":{"code":"system_memory_overloaded","message":"system memory overloaded"}}')
            if scenario == "unexpected_eof":
                raise errors.UpstreamEOFError("连接在正常结束标记前关闭")
            raise ConnectionError("模型服务连接中断")
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
    # 本轮允许执行的工具名（按传入 schema）。收口阶段 schemas=[] ⇒ 允许集为空：
    # 上游若无视 tools=[] 仍发起调用，一律返回明确错误而**不执行**，避免越权副作用。
    allowed_tools = {
        str(schema.get("name") or "") for schema in tool_schemas if isinstance(schema, dict)
    }

    if audit_meta:
        audit.record("agent_start", **audit_meta)

    async def failed(exc: BaseException, reason: str) -> AgentOutcome:
        info = errors.from_exception(exc, request_id=(audit_meta or {}).get("turn_id"))
        if reason == "wallclock":
            info = errors.make("budget_exhausted", phase="stream", summary="本轮达到时长上限，回复未正常完成。", detail=str(exc), stopped_reason=reason, request_id=(audit_meta or {}).get("turn_id"))
        payload = info.to_dict()
        await emit({"type": "error", "message": payload["summary"], **payload})
        return AgentOutcome("".join(text_parts), rounds, tool_count, degraded=True,
                            stopped_reason=reason, reasoning="".join(reasoning_parts),
                            usage=usage, tools=tool_activities, error=payload)

    while rounds < budget.total_rounds:
        if deadline is not None and time.monotonic() >= deadline:
            audit.record("agent_wallclock", rounds=rounds, limit_s=max_seconds)
            return await failed(TimeoutError(f"单次时长上限 {max_seconds:.0f}s"), "wallclock")
        rounds += 1
        if reporter is not None:
            reporter.round = rounds
        if rounds > budget.explore_rounds + budget.wrapup_rounds and not forced:
            tools_active = []
            allowed_tools = set()
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
                return await failed(TimeoutError(f"单轮时长上限 {max_seconds}s"), "wallclock")
            except Exception as exc:  # noqa: BLE001 - 传输失败：未可见则重试，已可见则降级
                # 确定性错误（400 / 鉴权失败等）重试也不会成功：直接降级，别白等 + 白烧请求
                transient = llm._is_transient(exc)  # noqa: SLF001 - 与 chat_once 共用同一判据
                if text_parts or reasoning_parts or not transient or attempt >= turn_retries:
                    audit.record("agent_transport_error", round=rounds, error=str(exc))
                    return await failed(exc, "transport")
                attempt += 1
                await asyncio.sleep(1.5 * attempt)

        if not calls:
            final_text = "".join(turn_text)
            if not final_text.strip():
                idle += 1
                if idle <= budget.idle_rescues and rounds < budget.total_rounds:
                    messages.append({"role": "user", "content": IDLE_NUDGE})
                    continue
                return await failed(RuntimeError("上游空响应，未收到回复或工具调用"), "empty")
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

        # 完整收口标记已输出：优先收口，本轮不得再执行后置工具（标记是建草稿的权威依据）。
        if calls and has_complete_interview_marker("".join(text_parts)):
            audit.record(
                "agent_interview_close", rounds=rounds, skipped_tool_calls=len(calls)
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
            # 本轮允许集之外（含收口阶段 schemas=[]）：返回明确错误，绝不执行。
            if name not in allowed_tools:
                available = "、".join(sorted(allowed_tools)) or "无"
                result: dict[str, Any] = {
                    "content": (
                        f"本轮不开放该工具：{name}（本轮可用工具：{available}）。"
                        "请直接根据已获得的信息作答。"
                    ),
                    "is_error": True,
                }
            else:
                # fixture 脚本可用 `delay` 键模拟"工具静默执行"（真机产课要几分钟）；该键只出现
                # 在 fixture tool_calls 里，真实模型不会带回，生产路径不受影响。
                delay = call.get("delay")
                if isinstance(delay, (int, float)) and not isinstance(delay, bool) and delay > 0:
                    await asyncio.sleep(float(delay))
                # 工具经 ctx.state["tool_call_id"] 认领父调用：emit task_update 时以此为 id。
                # finally 恢复原值，不把本调用 id 污染给下一个工具。
                previous_call_id = ctx.state.get("tool_call_id")
                ctx.state["tool_call_id"] = call_id
                audit_token = audit.snapshot_token()
                try:
                    result = await _execute_tool(name, call.get("arguments"), ctx)
                finally:
                    audit.restore(audit_token)
                    if previous_call_id is None:
                        ctx.state.pop("tool_call_id", None)
                    else:
                        ctx.state["tool_call_id"] = previous_call_id
            is_error = bool(result.get("is_error"))
            content = str(result.get("content") or "")
            # 保留工具下发的结构化元数据（task/lesson/assessment），随工具卡一并落库/下发。
            metadata: dict[str, Any] = {
                key: result[key] for key in TOOL_METADATA_KEYS if result.get(key) is not None
            }
            # assess_node 失败且工具未带 assessment：补确定性失败元数据（供前端系统状态卡）。
            if is_error and "assessment" not in metadata:
                fallback = assessment_failure_meta(name, call.get("arguments"), ctx, content)
                if fallback is not None:
                    metadata["assessment"] = fallback
            for activity in tool_activities:
                if activity["id"] == call_id:
                    activity.update(
                        {
                            "status": "error" if is_error else "done",
                            "result": content,
                            "isError": is_error,
                            **metadata,
                        }
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
                    "is_error": is_error,
                    **metadata,
                }
            )
            tool_content = str(result.get("content") or "(no output)")
            if name == "assess_node" and is_error:
                # 机器状态提示随工具结果给模型，避免把「未落盘」当成成功。
                tool_content += (
                    "\n（系统状态：评估未落盘——assessment=failed；"
                    "不要声称已写入评估记录或已置位。）"
                )
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": name,
                    "content": _clamp(tool_content),
                    "is_error": is_error,
                }
            )
            if name == "assess_node" and is_error:
                # 受控纠正消息：约束模型随后收尾时如实说明评估失败。
                messages.append({"role": "user", "content": ASSESS_FAILURE_CORRECTION})

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
