"""LLM 统一适配层：按 provider.api_format 分派 openai_chat / openai_responses / anthropic。

内部消息统一为 openai 风格 content parts：
{"type": "text", "text": ...} 与 {"type": "image_url", "image_url": {"url": "data:mime;base64,..."}}，
由本模块翻译为各协议的请求结构并解析流式/非流式响应；上游错误原样透出。
"""
from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import logging
import os
import re
import time
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from openai import APIStatusError, AsyncOpenAI

from . import errors

try:
    import httpx
except ImportError:  # openai v3 自带 httpx2（同 API 的分叉）
    import httpx2 as httpx

logger = logging.getLogger(__name__)

API_FORMATS = ("openai_chat", "openai_responses", "anthropic")
ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_MAX_TOKENS = 4096
# 推理模型（含 reasoning 链）长产出时 60s 偏紧：实测 mimo-v2.6-flash（medium）
# 单次课件派工纯思考约 10 分钟、全程 694s；300s 读超时在网关负载下会误杀长产出。
REQUEST_TIMEOUT = float(os.getenv("STUDYMATE_LLM_TIMEOUT", "900.0") or 900.0)
# 个人中转网关（new-api 一类）会间歇性返回 401/空响应/读超时：每个请求整体重试
# 少量次数，只对"连接已建立但上游不稳"的失败类型重试，写盘型副作用不存在所以安全。
LLM_RETRIES = max(1, int(os.getenv("STUDYMATE_LLM_RETRIES", "3") or 3))
# 单次 chat_once 的**总时限**（绝对 deadline，覆盖全部重试与退避）。per-read 的
# REQUEST_TIMEOUT 只在"网关每 899s 吐一个字节"时永不触发（实测有会话静默 2h38m）；
# 轮数预算也封不住"一次调用本身跑很久"。默认 300s，`STUDYMATE_LLM_MAX_SECONDS` 可覆盖；
# 建课/产课等长派工由调用方显式传 max_seconds（实测单次可达 694s，owner 给 1800s）。
MAX_SECONDS = float(os.getenv("STUDYMATE_LLM_MAX_SECONDS", "300") or 300.0)
TEMPERATURE = 0.2
_ERROR_TEXT_LIMIT = 2000
# 档位表里有两类取值（2026-10-04 维护者指出）：`low/medium/high/max` 是**推理档位**，
# 直接映射到协议的 effort 参数；`disabled/enabled`、`off/on` 是**思考开关**——"开"没有
# 对应的档位名，映射成默认档（medium），"关"完全不发思考参数。把开关值原样当 effort
# 发出去会被网关 400（实测 new-api 只认 none/minimal/low/medium/high/xhigh/max）。
REASONING_OFF_VALUES = frozenset(
    {"off", "disabled", "disable", "none", "false", "no", "0", "关闭", "禁用", "停用"}
)
REASONING_ON_VALUES = frozenset(
    {"on", "enabled", "enable", "true", "yes", "1", "default", "auto", "开启", "启用", "默认"}
)
OPENAI_EFFORT_VALUES = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
DEFAULT_REASONING_EFFORT = "medium"
ANTHROPIC_THINKING_BUDGETS = {"low": 2048, "medium": 8192, "high": 24576}
# Anthropic 要求 budget_tokens < max_tokens
ANTHROPIC_THINKING_HEADROOM = 4096


class ProviderTransientError(RuntimeError):
    """上游瞬时失败（鉴权抖动 / 读超时 / 空响应）：值得整体重试。"""


class LLMDeadlineExceeded(RuntimeError):
    """单次调用总时限用尽（绝对 deadline 覆盖全部重试）：不再重试，立即收尾。

    故意不是 ProviderTransientError：超时若被外层当成瞬时失败，就会"每次重试再给
    一整个时限"，把单次调用无限延长——这正是总时限要堵死的路径。
    """


# 网关抖动状态下值得重试的 HTTP 码（401 是 new-api 一类网关的鉴权抖动，见模块注释）
_TRANSIENT_STATUS = frozenset({401, 408, 409, 425, 429, 500, 502, 503, 504, 522, 524})


def _status_of(exc: "ProviderError") -> int | None:
    """取 ProviderError 的 HTTP 状态码：优先结构化属性，回落字符串里的 `HTTP NNN`。"""
    status = getattr(exc, "status", None)
    if isinstance(status, int) and not isinstance(status, bool):
        return status
    match = re.match(r"HTTP (\d{3})", str(exc))
    return int(match.group(1)) if match else None


def _is_transient(exc: Exception) -> bool:
    """网关的鉴权抖动（同一把 key 时好时坏）、读超时、空响应按瞬时失败重试。

    openai SDK 抛的是具名子类（APITimeoutError / AuthenticationError…）；responses 与
    anthropic 协议走裸 httpx，抛 TimeoutException / TransportError，或由本模块包成
    ProviderError——三处都要认，避免"只有 openai_chat 才会重试"的协议差异。
    """
    name = type(exc).__name__
    if name in ("APITimeoutError", "TimeoutError", "APIConnectionError", "InternalServerError", "AuthenticationError"):
        return True
    if isinstance(exc, APIStatusError):
        # SDK 各状态子类（RateLimitError 429 / ConflictError 409 …）统一按状态码判定，
        # 与 ProviderError 同口径，别让"哪个渠道走 SDK"决定能不能重试。
        return exc.status_code in _TRANSIENT_STATUS
    if isinstance(exc, httpx.TimeoutException):
        return True
    if isinstance(exc, httpx.TransportError):
        return True
    if isinstance(exc, ProviderError):
        return _status_of(exc) in _TRANSIENT_STATUS
    return isinstance(exc, ProviderTransientError)


@dataclass(frozen=True)
class ReasoningRequest:
    """归一化后的思考请求。

    enabled=False 表示"本次不发任何思考参数"；effort 为要发的档位名（None = 用默认档）。
    """

    enabled: bool
    effort: str | None = None


def _reasoning_request(provider: dict[str, Any]) -> ReasoningRequest:
    """把用户声明的档位名归一化成"开关 + 档位"。

    - 未启用推理 / 档位表为空 / 档位为空 → 不思考。
    - 开关类取值（`disabled` / `off` / `enabled` / `on` …）→ 关：不思考；开：用默认档（medium）。
    - 其余值按**档位**原样透出（各协议自行决定收不收；Anthropic 只认自己的预算表，
      认不出就不发思考参数，不会 400）。
    """
    reasoning = provider.get("reasoning")
    if not isinstance(reasoning, dict) or not reasoning.get("enabled"):
        return ReasoningRequest(False)
    variants = reasoning.get("variants")
    if not isinstance(variants, list) or not variants:
        return ReasoningRequest(False)
    variant = str(provider.get("reasoning_variant") or "") or str(
        reasoning.get("default_variant") or ""
    )
    variant = variant.strip()
    if not variant:
        return ReasoningRequest(False)
    lowered = variant.lower()
    if lowered in REASONING_OFF_VALUES:
        return ReasoningRequest(False)
    if lowered in REASONING_ON_VALUES:
        return ReasoningRequest(True, None)
    return ReasoningRequest(True, lowered)


def _openai_reasoning_effort(provider: dict[str, Any]) -> str | None:
    """OpenAI 兼容格式要发的 reasoning_effort；不思考返回 None。

    开关"开"与未识别的档位名都落到默认档（medium），保证"要求思考"真的生效；
    `none` 是网关接受的显式关闭值，不主动发（关就用"不发参数"表达）。
    """
    request = _reasoning_request(provider)
    if not request.enabled:
        return None
    effort = (request.effort or DEFAULT_REASONING_EFFORT).lower()
    if effort == "none":
        return None
    return effort


def _max_output_limit(provider: dict[str, Any]) -> int | None:
    """模型声明的最大输出 tokens；None 表示按协议默认（不发送该参数）。"""
    limit = provider.get("max_output_tokens")
    if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
        return None
    return limit


class ProviderError(RuntimeError):
    """上游返回错误（含状态码与响应体摘要）。

    兼容旧构造 `ProviderError("HTTP 503: ...")`：status 从字符串解析；新增结构化
    `status` / `code`（error.code 原文）供 ErrorInfo 规范化，`retryable=False` 可显式
    禁止重试（如测试注入的确定性失败）。
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
        upstream_code: str | None = None,
        retryable: bool | None = None,
    ) -> None:
        super().__init__(message)
        match = re.match(r"HTTP (\d{3})", message or "")
        self.status = status if isinstance(status, int) else (
            int(match.group(1)) if match else None
        )
        self.code = code
        self.upstream_code = upstream_code
        self.retryable = retryable


# 只有"上游不接受 tools"这一类请求错误值得去掉 tools 再试一次：400/404/422。
# 鉴权（401）、限流（429）、服务端（5xx）等即使重发也不该剥工具——那会白白多打一次网关，
# 且掩盖了真正的瞬时失败（应交给 _is_transient 整体重试）。
_TOOLS_REJECT_STATUS = frozenset({400, 404, 422})


def _is_tools_rejection(exc: Exception) -> bool:
    """判定异常是否属于"tools 参数被上游拒绝"，可按状态码统一识别两种异常来源。"""
    if isinstance(exc, APIStatusError):
        return exc.status_code in _TOOLS_REJECT_STATUS
    if isinstance(exc, ProviderError):
        return _status_of(exc) in _TOOLS_REJECT_STATUS
    return False


def _loopback_mounts(base_url: str) -> dict[str, None] | None:
    """base_url 指向本机时返回强制直连的 mounts；否则 None（保持默认代理行为）。

    httpx 在 Windows 上会经 urllib 读到注册表里的系统代理，连发往 127.0.0.1 的
    请求也扔进代理——本机网关（new-api 一类）多这一跳，代理一抖长流就断。
    mount 值为 None 即命中后回落默认 transport（httpx 自己的 no_proxy 机制）。
    """
    try:
        host = (urlparse(base_url).hostname or "").lower()
    except ValueError:
        return None
    if host and host != "localhost":
        try:
            if not ipaddress.ip_address(host).is_loopback:
                return None
        except ValueError:
            return None
    if not host:
        return None
    mounts: dict[str, None] = {
        "all://localhost": None,
        "all://127.0.0.1": None,
        "all://[::1]": None,
    }
    if host not in ("localhost", "127.0.0.1", "::1", "[::1]"):
        mounts[f"all://{host}"] = None
    return mounts


def _raw_client(provider: dict[str, Any]) -> httpx.AsyncClient:
    """裸 httpx 客户端（responses / anthropic 协议用）；本机 base_url 显式直连。"""
    mounts = _loopback_mounts(str(provider.get("base_url") or ""))
    if mounts is None:
        return httpx.AsyncClient(timeout=REQUEST_TIMEOUT)
    return httpx.AsyncClient(timeout=REQUEST_TIMEOUT, mounts=mounts)


def build_client(provider: dict[str, Any]) -> AsyncOpenAI:
    mounts = _loopback_mounts(str(provider.get("base_url") or ""))
    # max_retries=0：openai SDK 默认还会整请求重试 2 次，叠上本层与 agent 层的重试，
    # 单轮最坏耗时会被放大成 3×3×(per-read 900s)——实测有会话因此挂了 2 小时 38 分。
    # 重试统一由 chat_once / agent 控制，SDK 层不再自己重来。
    if mounts is None:
        return AsyncOpenAI(
            base_url=provider.get("base_url") or None,
            api_key=provider.get("api_key") or "missing",
            timeout=REQUEST_TIMEOUT,
            max_retries=0,
        )
    return AsyncOpenAI(
        base_url=provider.get("base_url") or None,
        api_key=provider.get("api_key") or "missing",
        timeout=REQUEST_TIMEOUT,
        max_retries=0,
        http_client=httpx.AsyncClient(timeout=REQUEST_TIMEOUT, mounts=mounts),
    )


async def _close_quietly(client: Any) -> None:
    """关闭本次调用自建的客户端。

    openai_chat 路径的 `build_client` 每轮都新建连接池；loopback 网关下传入的是裸
    `httpx.AsyncClient`（没有 `__del__` 兜底），不显式关闭会在长会话里持续泄漏 fd。
    用 try/finally 而非 `async with`，是为了兼容测试里注入的假 client（只需有 `chat`）。
    """
    close = getattr(client, "close", None)
    if close is None:
        return
    with contextlib.suppress(Exception):
        await close()


def _text_of_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return str(content or "")


def _content_parts(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content else []
    return [part for part in (content or []) if isinstance(part, dict)]


def _data_url_parts(url: str) -> tuple[str, str] | None:
    match = re.fullmatch(r"data:([^;,]+);base64,(.+)", url, re.DOTALL)
    if not match:
        return None
    return match.group(1), match.group(2)


class ToolCallAccumulator:
    """流式 tool_call 增量聚合（DSH assembler / DeepTutor ToolCallAccumulator 同规）。

    按 wire `index` 建块；`id`/`name` **赋值不追加**（网关重复发 id 会涨到几万
    字符被 400，见尽调存档）；`arguments` 拼接。`block-end`（协议给出完整块时）
    覆盖为权威值，先到先得。
    """

    def __init__(self) -> None:
        self._blocks: dict[int, dict[str, str]] = {}
        self._order: list[int] = []

    def _ensure(self, index: int) -> dict[str, str]:
        block = self._blocks.get(index)
        if block is None:
            block = {"id": "", "name": "", "arguments": ""}
            self._blocks[index] = block
            self._order.append(index)
        return block

    def push(
        self,
        index: int,
        *,
        id: str | None = None,
        name: str | None = None,
        arguments_delta: str = "",
        arguments_full: str | None = None,
    ) -> None:
        block = self._ensure(index)
        if id:
            block["id"] = str(id)
        if name:
            block["name"] = str(name)
        if arguments_delta:
            block["arguments"] += arguments_delta
        if arguments_full is not None:
            block["arguments"] = arguments_full

    def finalize(self) -> list[dict[str, str]]:
        calls: list[dict[str, str]] = []
        for index in self._order:
            block = self._blocks[index]
            calls.append(
                {
                    "id": block["id"] or f"call-{index}",
                    "name": block["name"],
                    "arguments": block["arguments"],
                }
            )
        return calls


def _delta_field(delta: Any, key: str) -> str:
    """取 delta 上的字段：openai SDK 对网关扩展字段（如 reasoning_content）走
    `model_extra`，直接 getattr 不一定拿得到，两处都查一次。"""
    value = getattr(delta, key, None)
    if value is None:
        extra = getattr(delta, "model_extra", None) or {}
        if isinstance(extra, dict):
            value = extra.get(key)
    return str(value) if value else ""


def _delta_text(value: Any) -> str:
    """把 delta.content 归一成字符串。

    正常是 str；个别网关把 content 作为 parts 列表返回（`[{"type":"text","text":...}]`）。
    直接 `str(list)` 会得到 Python repr，破坏结构化 JSON／正文，所以统一在这里拍平。
    """
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(
            str(part.get("text", "")) for part in value if isinstance(part, dict)
        )
    return "" if value is None else str(value)


def _usage_payload(usage: Any) -> dict[str, int] | None:
    """把协议各异的 usage 统一成 {prompt_tokens, completion_tokens, total_tokens}。

    openai_chat 走 prompt_/completion_tokens，anthropic 与 responses 走 input_/output_tokens；
    三者都没有时返回 None（不产生空的用量事件）。
    """
    if usage is None:
        return None

    def _number(key: str) -> int | None:
        if isinstance(usage, dict):
            value = usage.get(key)
        else:
            value = getattr(usage, key, None)
            if value is None:
                extra = getattr(usage, "model_extra", None) or {}
                if isinstance(extra, dict):
                    value = extra.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return int(value)

    prompt = _number("prompt_tokens")
    if prompt is None:
        prompt = _number("input_tokens")
    completion = _number("completion_tokens")
    if completion is None:
        completion = _number("output_tokens")
    total = _number("total_tokens")
    if prompt is None and completion is None and total is None:
        return None
    prompt = prompt or 0
    completion = completion or 0
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total if total is not None else prompt + completion,
    }


def _openai_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "parameters": tool.get("parameters") or {"type": "object", "properties": {}},
            },
        }
        for tool in tools
    ]


def _responses_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "name": tool["name"],
            "description": tool.get("description", ""),
            "parameters": tool.get("parameters") or {"type": "object", "properties": {}},
        }
        for tool in tools
    ]


def _anthropic_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "name": tool["name"],
            "description": tool.get("description", ""),
            "input_schema": tool.get("parameters") or {"type": "object", "properties": {}},
        }
        for tool in tools
    ]


def _openai_wire_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """openai_chat 外发消息：剔除内部私有键，并映射 tool_calls / role:tool。"""
    wire: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "tool":
            wire.append(
                {
                    "role": "tool",
                    "tool_call_id": message.get("tool_call_id") or "",
                    "content": _text_of_content(message.get("content")),
                }
            )
            continue
        content = message.get("content")
        if isinstance(content, list):
            content = [
                {key: value for key, value in part.items() if not str(key).startswith("_")}
                for part in content
                if isinstance(part, dict)
            ]
        entry = {key: value for key, value in message.items() if not str(key).startswith("_")}
        entry["content"] = content
        calls = message.get("tool_calls")
        if calls:
            entry["content"] = _text_of_content(content) or None
            entry["tool_calls"] = [
                {
                    "id": call["id"],
                    "type": "function",
                    "function": {"name": call["name"], "arguments": call["arguments"]},
                }
                for call in calls
            ]
        wire.append(entry)
    return wire


def _provider_url(provider: dict[str, Any], path: str) -> str:
    base = str(provider.get("base_url") or "").rstrip("/")
    return f"{base}{path}"


def _bearer_headers(provider: dict[str, Any]) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {provider.get('api_key') or ''}",
        "Content-Type": "application/json",
    }


def _anthropic_headers(provider: dict[str, Any]) -> dict[str, str]:
    return {
        "x-api-key": str(provider.get("api_key") or ""),
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
    }


def _error_body(response: httpx.Response) -> str:
    return f"HTTP {response.status_code}: {response.text[:_ERROR_TEXT_LIMIT]}"


def _upstream_code_of(body: str) -> str | None:
    """抓上游错误体里的 error.code / error.type（如 system_memory_overloaded）。"""
    match = re.search(r'"code"\s*:\s*"([^"]{1,120})"', body)
    if match:
        return match.group(1)
    match = re.search(r'"type"\s*:\s*"([^"]{1,120})"', body)
    return match.group(1) if match else None


def _provider_error(message: str, *, status: int | None = None) -> ProviderError:
    """构造带结构化状态的 ProviderError：从 `HTTP NNN` 与 body 里的 code 解析。"""
    body = str(message or "")
    match = re.match(r"HTTP (\d{3})", body)
    resolved = status if isinstance(status, int) else (int(match.group(1)) if match else None)
    return ProviderError(
        body[:_ERROR_TEXT_LIMIT], status=resolved, upstream_code=_upstream_code_of(body)
    )


async def _raise_for_status(response: httpx.Response) -> None:
    if response.status_code >= 400:
        body = (await response.aread()).decode("utf-8", errors="replace")
        raise ProviderError(
            f"HTTP {response.status_code}: {body[:_ERROR_TEXT_LIMIT]}",
            status=response.status_code,
            upstream_code=_upstream_code_of(body),
        )


async def _iter_sse(response: httpx.Response) -> AsyncGenerator[tuple[str, dict[str, Any]], None]:
    """解析 SSE 数据行；兼容 httpx（原样行）与 httpx2（自动剥 data: 前缀）。"""
    event_name = ""
    async for raw_line in response.aiter_lines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("event:"):
            event_name = line[len("event:"):].strip()
            continue
        if line.startswith("data:"):
            line = line[len("data:"):].strip()
        if not line or line == "[DONE]":
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            yield str(data.get("type") or event_name), data
        event_name = ""


# ---------- openai_chat：{base}/chat/completions，delta 流，response_format ----------


async def _stream_openai_chat(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
) -> AsyncGenerator[str, None]:
    kwargs: dict[str, Any] = {}
    limit = _max_output_limit(provider)
    if limit is not None:
        kwargs["max_tokens"] = limit
    effort = _openai_reasoning_effort(provider)
    if effort:
        kwargs["extra_body"] = {"reasoning_effort": effort}
    client = build_client(provider)
    saw_chunk = False
    finished = False
    try:
        stream = await client.chat.completions.create(
            model=provider.get("model") or "",
            messages=_openai_wire_messages(messages),  # type: ignore[arg-type]
            stream=True,
            **kwargs,
        )
        async for chunk in stream:
            saw_chunk = True
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            if getattr(choice, "finish_reason", None):
                finished = True
            delta = choice.delta
            text = _delta_text(delta.content)
            if text:
                yield text
        if saw_chunk and not finished:
            raise errors.UpstreamEOFError("上游流未正常结束（缺少 finish 标记）")
    finally:
        await _close_quietly(client)


async def _chat_openai_chat(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    json_mode: bool,
) -> str:
    client = build_client(provider)
    kwargs: dict[str, Any] = {}
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    limit = _max_output_limit(provider)
    if limit is not None:
        kwargs["max_tokens"] = limit
    effort = _openai_reasoning_effort(provider)
    if effort:
        kwargs["extra_body"] = {"reasoning_effort": effort}
    # 走流式再聚合：部分中转网关对长非流式请求有 ~120s 硬超时（HTTP 524），
    # 流式增量不受该窗口限制；语义等价（仍拿到完整文本），长产出（课件/题库）必需。
    chunks: list[str] = []
    try:
        stream = await client.chat.completions.create(
            model=provider.get("model") or "",
            messages=_openai_wire_messages(messages),  # type: ignore[arg-type]
            temperature=TEMPERATURE,
            stream=True,
            **kwargs,
        )
        async for chunk in stream:
            for choice in chunk.choices or []:
                delta = getattr(choice, "delta", None)
                text = _delta_text(getattr(delta, "content", None)) if delta is not None else ""
                if text:
                    chunks.append(text)
    finally:
        await _close_quietly(client)
    return "".join(chunks)


# ---------- openai_responses：{base}/responses，system→instructions ----------


def _responses_payload(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    json_mode: bool,
    stream: bool,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str | None = None,
) -> dict[str, Any]:
    instructions = "\n\n".join(
        _text_of_content(message.get("content"))
        for message in messages
        if message.get("role") == "system"
    )
    input_items: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            continue
        if role == "tool":
            input_items.append(
                {
                    "type": "function_call_output",
                    "call_id": message.get("tool_call_id") or "",
                    "output": _text_of_content(message.get("content")),
                }
            )
            continue
        calls = message.get("tool_calls")
        if calls:
            text = _text_of_content(message.get("content"))
            if text:
                input_items.append(
                    {"role": "assistant", "content": [{"type": "output_text", "text": text}]}
                )
            for call in calls:
                input_items.append(
                    {
                        "type": "function_call",
                        "call_id": call["id"],
                        "name": call["name"],
                        "arguments": call["arguments"],
                    }
                )
            continue
        parts: list[dict[str, Any]] = []
        for part in _content_parts(message.get("content")):
            if part.get("type") == "text":
                parts.append({"type": "input_text", "text": part.get("text", "")})
            elif part.get("type") == "image_url":
                url = (part.get("image_url") or {}).get("url", "")
                if url:
                    parts.append({"type": "input_image", "image_url": url})
        if not parts:
            parts = [{"type": "input_text", "text": ""}]
        input_items.append({"role": role, "content": parts})
    payload: dict[str, Any] = {
        "model": provider.get("model") or "",
        "input": input_items,
        "stream": stream,
    }
    if instructions:
        payload["instructions"] = instructions
    if json_mode:
        payload["text"] = {"format": {"type": "json_object"}}
    limit = _max_output_limit(provider)
    if limit is not None:
        payload["max_output_tokens"] = limit
    effort = _openai_reasoning_effort(provider)
    if effort:
        payload["reasoning"] = {"effort": effort}
    if tools:
        payload["tools"] = _responses_tools(tools)
        payload["tool_choice"] = tool_choice or "auto"
    return payload


def _responses_output_text(data: dict[str, Any]) -> str:
    chunks: list[str] = []
    for item in data.get("output") or []:
        if not isinstance(item, dict):
            continue
        for part in item.get("content") or []:
            if isinstance(part, dict) and part.get("type") == "output_text":
                chunks.append(part.get("text", ""))
    return "".join(chunks)


async def _stream_openai_responses(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
) -> AsyncGenerator[str, None]:
    payload = _responses_payload(provider, messages, json_mode=False, stream=True)
    async with _raw_client(provider) as client:
        async with client.stream(
            "POST",
            _provider_url(provider, "/responses"),
            headers=_bearer_headers(provider),
            json=payload,
        ) as response:
            await _raise_for_status(response)
            async for event_type, data in _iter_sse(response):
                if event_type == "response.output_text.delta":
                    piece = str(data.get("delta") or "")
                    if piece:
                        yield piece
                elif event_type in ("error", "response.failed"):
                    raise _provider_error(json.dumps(data, ensure_ascii=False))


async def _chat_openai_responses(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    json_mode: bool,
) -> str:
    payload = _responses_payload(provider, messages, json_mode=json_mode, stream=False)
    if not _reasoning_request(provider).enabled:
        # 推理模型不接受自定义 temperature，开启思考时留给协议默认值
        payload["temperature"] = TEMPERATURE
    async with _raw_client(provider) as client:
        response = await client.post(
            _provider_url(provider, "/responses"),
            headers=_bearer_headers(provider),
            json=payload,
        )
    if response.status_code >= 400:
        raise ProviderError(
            _error_body(response),
            status=response.status_code,
            upstream_code=_upstream_code_of(response.text),
        )
    data = response.json()
    if data.get("error"):
        raise _provider_error(json.dumps(data["error"], ensure_ascii=False))
    return _responses_output_text(data)


# ---------- anthropic：{base}/v1/messages，system 独立参数，JSON 模式走提示词约束 ----------


def _merge_adjacent_roles(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """合并相邻同角色消息：Anthropic 要求 user/assistant 交替。

    agent 的 WRAPUP/IDLE/打转提醒以 role:user 追加在 tool_result 之后，会形成
    「user(tool_result) + user(提示)」连续两条；严格 Claude 模型直接 400
    `messages: roles must alternate`。合并只在角色相同时发生，tool_result 仍在最前。
    """
    merged: list[dict[str, Any]] = []
    for message in messages:
        content = list(message.get("content") or [])
        if merged and merged[-1]["role"] == message["role"]:
            merged[-1]["content"] = list(merged[-1]["content"]) + content
        else:
            merged.append({"role": message["role"], "content": content})
    return merged


def _anthropic_payload(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    json_mode: bool,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str | None = None,
) -> dict[str, Any]:
    system_chunks = [
        _text_of_content(message.get("content"))
        for message in messages
        if message.get("role") == "system"
    ]
    if json_mode:
        system_chunks.append("只输出一个合法的 JSON 对象，不要输出任何其他文字。")
    payload_messages: list[dict[str, Any]] = []
    pending_results: list[dict[str, Any]] = []

    def flush_results() -> None:
        # Anthropic 要求 tool_result 块同处一条 user 消息且排在最前
        if pending_results:
            payload_messages.append({"role": "user", "content": list(pending_results)})
            pending_results.clear()

    for message in messages:
        role = message.get("role")
        if role == "system":
            continue
        if role == "tool":
            pending_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": message.get("tool_call_id") or "",
                    "content": _text_of_content(message.get("content")),
                    "is_error": bool(message.get("is_error")),
                }
            )
            continue
        flush_results()
        blocks: list[dict[str, Any]] = []
        text = _text_of_content(message.get("content"))
        calls = message.get("tool_calls")
        if calls:
            if text:
                blocks.append({"type": "text", "text": text})
            for call in calls:
                try:
                    parsed = json.loads(call.get("arguments") or "{}")
                except json.JSONDecodeError:
                    parsed = {}
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": call["id"],
                        "name": call["name"],
                        "input": parsed if isinstance(parsed, dict) else {},
                    }
                )
        else:
            for part in _content_parts(message.get("content")):
                if part.get("type") == "text":
                    blocks.append({"type": "text", "text": part.get("text", "")})
                elif part.get("type") == "image_url":
                    url = (part.get("image_url") or {}).get("url", "")
                    parsed_url = _data_url_parts(url)
                    if parsed_url:
                        mime, encoded = parsed_url
                        blocks.append(
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": mime,
                                    "data": encoded,
                                },
                            }
                        )
        if not blocks:
            blocks = [{"type": "text", "text": ""}]
        payload_messages.append({"role": role, "content": blocks})
    flush_results()
    payload_messages = _merge_adjacent_roles(payload_messages)
    payload: dict[str, Any] = {
        "model": provider.get("model") or "",
        "max_tokens": _max_output_limit(provider) or DEFAULT_MAX_TOKENS,
        "messages": payload_messages,
    }
    request = _reasoning_request(provider)
    budget = (
        ANTHROPIC_THINKING_BUDGETS.get(request.effort or DEFAULT_REASONING_EFFORT)
        if request.enabled
        else None
    )
    if budget is not None:
        # 协议要求 budget_tokens < max_tokens：声明值不足时抬高到预算 + 余量
        payload["max_tokens"] = max(payload["max_tokens"], budget + ANTHROPIC_THINKING_HEADROOM)
        payload["thinking"] = {"type": "enabled", "budget_tokens": budget}
    system_text = "\n\n".join(chunk for chunk in system_chunks if chunk)
    if system_text:
        payload["system"] = system_text
    if tools:
        payload["tools"] = _anthropic_tools(tools)
        payload["tool_choice"] = {"type": "auto"} if (tool_choice in (None, "auto")) else tool_choice
    return payload


async def _stream_anthropic(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
) -> AsyncGenerator[str, None]:
    payload = _anthropic_payload(provider, messages, json_mode=False)
    payload["stream"] = True
    async with _raw_client(provider) as client:
        async with client.stream(
            "POST",
            _provider_url(provider, "/v1/messages"),
            headers=_anthropic_headers(provider),
            json=payload,
        ) as response:
            await _raise_for_status(response)
            async for event_type, data in _iter_sse(response):
                if event_type == "content_block_delta":
                    delta = data.get("delta") or {}
                    if delta.get("type") == "text_delta" and delta.get("text"):
                        yield str(delta["text"])
                elif event_type == "error":
                    raise _provider_error(json.dumps(data.get("error") or data, ensure_ascii=False))


async def _chat_anthropic(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    json_mode: bool,
) -> str:
    payload = _anthropic_payload(provider, messages, json_mode)
    if not _reasoning_request(provider).enabled:
        # 开启 extended thinking 时 Anthropic 只接受协议默认 temperature
        payload["temperature"] = TEMPERATURE
    async with _raw_client(provider) as client:
        response = await client.post(
            _provider_url(provider, "/v1/messages"),
            headers=_anthropic_headers(provider),
            json=payload,
        )
    if response.status_code >= 400:
        raise ProviderError(
            _error_body(response),
            status=response.status_code,
            upstream_code=_upstream_code_of(response.text),
        )
    data = response.json()
    return "".join(
        part.get("text", "")
        for part in data.get("content") or []
        if isinstance(part, dict) and part.get("type") == "text"
    )


# ---------- 工具化轮次（K0）：一次 LLM 调用 → 文本增量 + 聚合后的 tool_calls ----------


async def _openai_chat_turn(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    tool_choice: str | None,
) -> AsyncGenerator[dict[str, Any], None]:
    client = build_client(provider)
    kwargs: dict[str, Any] = {}
    limit = _max_output_limit(provider)
    if limit is not None:
        kwargs["max_tokens"] = limit
    effort = _openai_reasoning_effort(provider)
    if effort:
        kwargs["extra_body"] = {"reasoning_effort": effort}
    if tools:
        kwargs["tools"] = _openai_tools(tools)
        kwargs["tool_choice"] = tool_choice or "auto"
    accumulator = ToolCallAccumulator()
    usage: dict[str, int] | None = None
    saw_chunk = False
    finished = False
    try:
        stream = await client.chat.completions.create(
            model=provider.get("model") or "",
            messages=_openai_wire_messages(messages),  # type: ignore[arg-type]
            temperature=TEMPERATURE,
            stream=True,
            **kwargs,
        )
        async for chunk in stream:
            saw_chunk = True
            # 网关（new-api 一类）默认在末块带 usage：不主动发 stream_options，
            # 免得某些上游不认这个参数；见到就收，见不到就没有用量事件。
            chunk_usage = _usage_payload(getattr(chunk, "usage", None))
            if chunk_usage is not None:
                usage = chunk_usage
            for choice in chunk.choices or []:
                if getattr(choice, "finish_reason", None):
                    finished = True
                delta = getattr(choice, "delta", None)
                if delta is None:
                    continue
                # 思维链与正文分开：DeepSeek 系网关用 reasoning_content，个别用 reasoning
                reasoning = _delta_field(delta, "reasoning_content") or _delta_field(delta, "reasoning")
                if reasoning:
                    yield {"type": "reasoning", "content": reasoning}
                text = _delta_text(getattr(delta, "content", None))
                if text:
                    yield {"type": "text", "content": text}
                for call in getattr(delta, "tool_calls", None) or []:
                    function = getattr(call, "function", None)
                    accumulator.push(
                        int(getattr(call, "index", 0) or 0),
                        id=getattr(call, "id", None),
                        name=getattr(function, "name", None) if function is not None else None,
                        arguments_delta=(
                            (getattr(function, "arguments", None) or "") if function is not None else ""
                        ),
                    )
        if saw_chunk and not finished:
            # 有数据但缺 finish 标记：连接在半途被掐断，别当成正常结束
            raise errors.UpstreamEOFError("上游流未正常结束（缺少 finish 标记）")
    finally:
        await _close_quietly(client)
    # tools 被停用（强制收尾轮）时不得执行模型仍吐出的 tool_calls，否则绕开"只能出文本"约束
    calls = [call for call in accumulator.finalize() if call["name"]] if tools else []
    if calls:
        yield {"type": "tool_calls", "tool_calls": calls}
    if usage is not None:
        yield {"type": "usage", "usage": usage}


async def _openai_responses_turn(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    tool_choice: str | None,
) -> AsyncGenerator[dict[str, Any], None]:
    payload = _responses_payload(
        provider, messages, json_mode=False, stream=True, tools=tools, tool_choice=tool_choice
    )
    accumulator = ToolCallAccumulator()
    by_item: dict[str, int] = {}
    next_index = 0
    usage: dict[str, int] | None = None
    saw_event = False
    terminated = False
    async with _raw_client(provider) as client:
        async with client.stream(
            "POST",
            _provider_url(provider, "/responses"),
            headers=_bearer_headers(provider),
            json=payload,
        ) as response:
            await _raise_for_status(response)
            async for event_type, data in _iter_sse(response):
                saw_event = True
                if event_type == "response.output_text.delta":
                    piece = str(data.get("delta") or "")
                    if piece:
                        yield {"type": "text", "content": piece}
                elif event_type in ("response.reasoning_summary_text.delta", "response.reasoning_text.delta"):
                    piece = str(data.get("delta") or "")
                    if piece:
                        yield {"type": "reasoning", "content": piece}
                elif event_type == "response.output_item.added":
                    item = data.get("item") or {}
                    if item.get("type") == "function_call":
                        item_id = str(item.get("id") or item.get("call_id") or next_index)
                        by_item[item_id] = next_index
                        accumulator.push(
                            next_index,
                            id=item.get("call_id") or item.get("id"),
                            name=item.get("name"),
                            arguments_delta=item.get("arguments") or "",
                        )
                        next_index += 1
                elif event_type == "response.function_call_arguments.delta":
                    index = by_item.get(str(data.get("item_id") or ""))
                    if index is not None:
                        accumulator.push(index, arguments_delta=str(data.get("delta") or ""))
                elif event_type == "response.output_item.done":
                    item = data.get("item") or {}
                    if item.get("type") == "function_call":
                        index = by_item.get(str(item.get("id") or item.get("call_id") or ""))
                        if index is not None:
                            accumulator.push(
                                index,
                                id=item.get("call_id") or item.get("id"),
                                name=item.get("name"),
                                arguments_full=item.get("arguments"),
                            )
                elif event_type == "response.completed":
                    terminated = True
                    payload_obj = data.get("response") or {}
                    usage = _usage_payload(payload_obj.get("usage")) or usage
                elif event_type in ("error", "response.failed"):
                    raise _provider_error(json.dumps(data, ensure_ascii=False))
    if saw_event and not terminated:
        raise errors.UpstreamEOFError("responses 流未正常结束（缺少 response.completed）")
    calls = [call for call in accumulator.finalize() if call["name"]] if tools else []
    if calls:
        yield {"type": "tool_calls", "tool_calls": calls}
    if usage is not None:
        yield {"type": "usage", "usage": usage}


async def _anthropic_turn(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    tool_choice: str | None,
) -> AsyncGenerator[dict[str, Any], None]:
    payload = _anthropic_payload(
        provider, messages, json_mode=False, tools=tools, tool_choice=tool_choice
    )
    payload["stream"] = True
    accumulator = ToolCallAccumulator()
    usage: dict[str, int] = {}
    saw_event = False
    terminated = False
    async with _raw_client(provider) as client:
        async with client.stream(
            "POST",
            _provider_url(provider, "/v1/messages"),
            headers=_anthropic_headers(provider),
            json=payload,
        ) as response:
            await _raise_for_status(response)
            async for event_type, data in _iter_sse(response):
                saw_event = True
                if event_type == "message_start":
                    started = _usage_payload((data.get("message") or {}).get("usage"))
                    if started is not None:
                        usage["input_tokens"] = started["prompt_tokens"]
                elif event_type == "content_block_start":
                    block = data.get("content_block") or {}
                    if block.get("type") == "tool_use":
                        accumulator.push(
                            int(data.get("index") or 0),
                            id=block.get("id"),
                            name=block.get("name"),
                        )
                elif event_type == "content_block_delta":
                    index = int(data.get("index") or 0)
                    delta = data.get("delta") or {}
                    if delta.get("type") == "text_delta" and delta.get("text"):
                        yield {"type": "text", "content": str(delta["text"])}
                    elif delta.get("type") == "thinking_delta" and delta.get("thinking"):
                        yield {"type": "reasoning", "content": str(delta["thinking"])}
                    elif delta.get("type") == "input_json_delta":
                        accumulator.push(index, arguments_delta=str(delta.get("partial_json") or ""))
                elif event_type == "message_delta":
                    merged = _usage_payload(data.get("usage"))
                    if merged is not None:
                        usage["output_tokens"] = merged["completion_tokens"]
                elif event_type == "message_stop":
                    terminated = True
                elif event_type == "error":
                    raise _provider_error(json.dumps(data.get("error") or data, ensure_ascii=False))
    if saw_event and not terminated:
        raise errors.UpstreamEOFError("anthropic 流未正常结束（缺少 message_stop）")
    calls = [call for call in accumulator.finalize() if call["name"]] if tools else []
    if calls:
        yield {"type": "tool_calls", "tool_calls": calls}
    final_usage = _usage_payload(usage) if usage else None
    if final_usage is not None:
        yield {"type": "usage", "usage": final_usage}


TURN_IMPLEMENTATIONS = {
    "openai_chat": _openai_chat_turn,
    "openai_responses": _openai_responses_turn,
    "anthropic": _anthropic_turn,
}


def supports_tools(provider: dict[str, Any] | None) -> bool:
    """工具调用默认对所有配置的模型开启（2026-10-04 维护者定档，不再依赖能力声明）。

    上游若不接受 tools 参数，`stream_turn` 会自动回落一次不带 tools 的调用，因此
    这里无需做能力判定；只要有一个 provider 字典就走工具化路径。
    """
    return provider is not None


async def stream_turn(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str | None = None,
    fixture_scenario: str | None = None,
) -> AsyncGenerator[dict[str, Any], None]:
    """一次带工具的轮次：yield {"type":"text"} 增量；结束时若有工具调用再 yield
    {"type":"tool_calls","tool_calls":[{id,name,arguments}]}。

    fixture 模式只吐纯文本（工具脚本由 agent 层提供，见 agent.py）；真实模式下
    tools 参数被上游拒绝时，回落一次不带 tools 的调用（措辞因网关而异，不再按
    错误文本筛选：凡首轮未吐任何内容的 ProviderError 都回落一次）。
    """
    if is_fixture_mode():
        async for piece in _fixture_stream(fixture_scenario):
            yield {"type": "text", "content": piece}
        return
    api_format = str(provider.get("api_format") or "openai_chat")
    implementation = TURN_IMPLEMENTATIONS.get(api_format)
    if implementation is None:
        raise ValueError(f"未知 API 格式：{api_format}")
    if tools:
        emitted = False
        try:
            async for event in implementation(provider, messages, tools, tool_choice):
                emitted = True
                yield event
            return
        except (ProviderError, APIStatusError) as exc:
            # 只有"上游不接受 tools"（400/404/422）才去掉 tools 再试一次：一句措辞各异的
            # 请求错误值得救；401/429/5xx 等原样抛，交给上层瞬时重试，别浪费一次剥工具调用。
            if emitted or not _is_tools_rejection(exc):
                raise
            logger.warning("tools 参数被上游拒绝，回落纯文本调用：%s", exc)
            await asyncio.sleep(0.5)
    async for event in implementation(provider, messages, None, None):
        yield event


# ---------- E2E fixture 模式：STUDYMATE_E2E_FIXTURE=1 时 LLM 调用不外呼 ----------

FIXTURE_ENV = "STUDYMATE_E2E_FIXTURE"
FIXTURE_SCENARIO_ENV = "STUDYMATE_E2E_SCENARIO"
FIXTURE_STREAM_SEGMENTS = (
    "这是固定测试回复的第一段：先把要讲的概念立起来。",
    "第二段：用一个具体例子把要点串起来。",
    "第三段：轮到你动手练习，试着自己复述一遍。",
    "第四段：本次回复到此结束，欢迎继续提问。\n\n"
    "**下一步**：回复「继续」就进入下一节。",
)
# 建课会话场景：助手按盘问节奏收口并输出标记（后端解析后建草稿、落确认卡）
FIXTURE_INTERVIEW_SEGMENTS = (
    "好——那我们不急着定科目。先聊聊：最近有没有什么事让你想学点新东西？\n\n"
    "**下一步**：回答上面的问题，或直接说「帮我推荐」。",
    "听起来你对动手做东西更有兴趣。给你三个可组合的方向：\n\n"
    "1. **(Recommended)** 用 Python 做一个小工具（比如批量整理文件）\n"
    "2. 做一个个人静态主页（HTML/CSS 入门）\n"
    "3. 数据整理与可视化入门\n\n"
    "**下一步**：挑一个方向，或说说你的想法。",
    "好，就以「用 Python 做一个小工具」为目标来盘科目。\n\n"
    "**下一步**：回答几个前置问题（目的/程度/基础），盘完我建草稿。",
    "盘问收口：科目定为「Python 实用小工具」。"
    '<!--INTERVIEW_RESULT-->{"name": "Python 实用小工具", "purpose": "能独立写出解决日常问题的小脚本", '
    '"level": "能独立做项目", "background": "没学过编程", "project": "批量整理文件的命令行工具", '
    '"carrier": "jupyter"}<!--/INTERVIEW_RESULT-->',
)
FIXTURE_STREAM_DELAY_SECONDS = 0.4
_fixture_at_import = os.getenv(FIXTURE_ENV) == "1"


def is_fixture_mode() -> bool:
    return _fixture_at_import or os.getenv(FIXTURE_ENV) == "1"


def _fixture_segments(scenario: str | None = None) -> tuple[str, ...]:
    if (scenario or os.getenv(FIXTURE_SCENARIO_ENV)) == "interview":
        return FIXTURE_INTERVIEW_SEGMENTS
    return FIXTURE_STREAM_SEGMENTS


FIXTURE_CURRICULUM: dict[str, Any] = {
    "nodes": [
        {
            "id": "demo.intro",
            "title": "课程绪论",
            "kind": "概念",
            "objective": "能说清这门课要解决的问题与学习路线",
            "problem": "想系统入门但没有整体地图，不知道先学哪块。",
            "prerequisites": [],
            "concepts": ["学习路线"],
            "resources": [],
            "practice": "以讲为主：先建立整体框架再逐层展开。",
            "pitfalls": [],
            "realworld": "",
            "status": "未开始",
            "mastery": 0,
        },
        {
            "id": "demo.core",
            "title": "核心方法",
            "kind": "实操",
            "objective": "能独立完成一个小练习并解释每一步",
            "problem": "看过讲解仍不会动手，缺少可模仿的最小练习。",
            "prerequisites": ["demo.intro"],
            "concepts": ["最小练习"],
            "resources": [],
            "practice": "讲练并重：先讲要点，再完成一个带测试的小练习。",
            "pitfalls": [],
            "realworld": "",
            "status": "未开始",
            "mastery": 0,
        },
        {
            "id": "demo.lab",
            "title": "阶段实验",
            "kind": "实验",
            "objective": "能按验收清单独立完成阶段任务",
            "problem": "学完前面的课后需要一个真实的整合验收点。",
            "prerequisites": ["demo.core"],
            "concepts": [],
            "resources": [],
            "practice": "以练为主：完成验收任务并逐条对照清单自查。",
            "pitfalls": [],
            "realworld": "",
            "status": "未开始",
            "mastery": 0,
        },
    ],
    "edges": [
        {"from": "demo.intro", "to": "demo.core", "reason": "先建立框架再动手练习"},
    ],
}


def _fixture_chat(fixture_kind: str | None) -> str:
    if fixture_kind == "grade":
        return json.dumps(
            {
                "verdict": "部分通过",
                "evidence": ["作答里逐字提到了封装，对上了判分要点一"],
                "missing": ["判分要点二在作答里引用不出证据"],
                "comment": "把第二点也说清楚即可通过。",
            },
            ensure_ascii=False,
        )
    if fixture_kind == "assess":
        return (
            "---\n"
            "node: net.layers\n"
            'date: "2026-01-01"\n'
            "questions:\n"
            "  - q: 用自己的话说清分层模型解决什么问题\n"
            "    kind: 概念\n"
            "    answer: 会话中未作答\n"
            "    verdict: 部分通过\n"
            "    topic: 分层模型解决的问题\n"
            "    note: 提到了封装但没说清首部的作用，差一步\n"
            "  - q: 举一个封装在真实请求里的例子\n"
            "    kind: 证据核验\n"
            "    answer: 会话中未作答\n"
            "    verdict: 不通过\n"
            "    topic: 封装在真实请求里的体现\n"
            "    note: 作答里引用不出对应证据\n"
            "mastery: 0.4\n"
            "verdict: 通过\n"
            "next: 复习首部与载荷的区别后重新评估本节\n"
            "---\n"
        )
    if fixture_kind == "summary":
        return (
            "---\n"
            'date: "2026-01-01"\n'
            "subject: 计算机网络\n"
            "session_goal: 弄清分层模型与封装的基本框架\n"
            "learned:\n"
            "  - 说出了分层模型把一次请求拆成多段处理\n"
            "  - 用一次 HTTP 请求示例数了各层加的头\n"
            "next_step: 下次从链路层与以太网帧继续\n"
            "weaknesses:\n"
            "  - 还说不清首部与载荷在每一跳怎么变化\n"
            "memory_updates:\n"
            "  - 偏好先看一个具体例子再动手推演\n"
            "  - 对协议分层这类抽象内容需要图示辅助\n"
            "---\n"
        )
    if fixture_kind == "generate":
        # 角色派工统一 envelope 交付：curriculum-designer 的 JSON 图放 data 键
        return json.dumps(
            {"files": [], "data": FIXTURE_CURRICULUM, "report": {"summary": ["fixture 大纲"]}},
            ensure_ascii=False,
        )
    if fixture_kind == "memory_suggest":
        return json.dumps(
            {
                "entries": [
                    {"section": "教学偏好", "content": "讲解后偏好先看一次 HTTP 请求的实际例子再动手。"},
                    {"section": "学习习惯", "content": "常见卡点：分层与封装的边界容易混。"},
                ]
            },
            ensure_ascii=False,
        )
    return "这是固定测试回复。"


async def _fixture_stream(scenario: str | None = None) -> AsyncGenerator[str, None]:
    segments = _fixture_segments(scenario)
    for index, segment in enumerate(segments):
        if index:
            await asyncio.sleep(FIXTURE_STREAM_DELAY_SECONDS)
        yield segment


# ---------- 对外入口 ----------


async def stream_chat(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    fixture_scenario: str | None = None,
) -> AsyncGenerator[str, None]:
    """流式返回 assistant 文本增量；provider 为当前生效 provider 字典。

    fixture_scenario 仅在 fixture 模式下生效（E2E 按请求选场景，免改后端 env）。
    """
    if is_fixture_mode():
        async for piece in _fixture_stream(fixture_scenario):
            yield piece
        return
    api_format = str(provider.get("api_format") or "openai_chat")
    if api_format == "openai_chat":
        generator = _stream_openai_chat(provider, messages)
    elif api_format == "openai_responses":
        generator = _stream_openai_responses(provider, messages)
    elif api_format == "anthropic":
        generator = _stream_anthropic(provider, messages)
    else:
        raise ValueError(f"未知 API 格式：{api_format}")
    async for piece in generator:
        yield piece


async def _await_within_deadline(
    make_awaitable: Callable[[], Awaitable[Any]], deadline: float | None, limit: float
) -> Any:
    """等待一次尝试，但不越过绝对 deadline；越过即取消并抛 LLMDeadlineExceeded。

    asyncio.wait_for 超时会取消内层协程，内层 `try/finally` 仍会 await 关闭自建客户端，
    因此取消路径不泄漏连接。deadline 为 None 表示不限时（max_seconds<=0）。
    """
    if deadline is None:
        return await make_awaitable()
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise LLMDeadlineExceeded(f"单次调用超过 {limit:.0f}s 总时限")
    try:
        return await asyncio.wait_for(make_awaitable(), timeout=remaining)
    except asyncio.TimeoutError:
        raise LLMDeadlineExceeded(f"单次调用超过 {limit:.0f}s 总时限") from None


async def _sleep_within_deadline(delay: float, deadline: float | None, limit: float) -> None:
    """退避 sleep 也受总时限约束：剩余不足只睡到 deadline，睡满即抛（不再重试）。"""
    if deadline is None:
        await asyncio.sleep(delay)
        return
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise LLMDeadlineExceeded(f"单次调用超过 {limit:.0f}s 总时限")
    await asyncio.sleep(min(delay, remaining))
    if time.monotonic() >= deadline:
        raise LLMDeadlineExceeded(f"单次调用超过 {limit:.0f}s 总时限")


async def chat_once(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    json_mode: bool = False,
    fixture_kind: str | None = None,
    max_seconds: float | None = None,
) -> str:
    """非流式调用，temperature 0.2；json_mode 按协议启用结构化输出。

    fixture_kind 仅在 fixture 模式下生效，决定返回哪类 canned 内容；
    非 fixture 模式下该参数被忽略。网关瞬时失败（鉴权抖动/读超时/空响应）
    整体重试 LLM_RETRIES 次；某一格式持续失败仍抛原异常。

    max_seconds 覆盖本次调用的**总时限**（默认 MAX_SECONDS，即
    `STUDYMATE_LLM_MAX_SECONDS`）：绝对 deadline 覆盖全部重试与退避，到点抛
    LLMDeadlineExceeded 且不再重试。<=0 表示不限时。建课/产课长派工传 1800。
    """
    if is_fixture_mode():
        return _fixture_chat(fixture_kind)
    api_format = str(provider.get("api_format") or "openai_chat")
    if api_format not in API_FORMATS:
        raise ValueError(f"未知 API 格式：{api_format}")
    dispatched = {
        "openai_chat": _chat_openai_chat,
        "openai_responses": _chat_openai_responses,
        "anthropic": _chat_anthropic,
    }
    limit = MAX_SECONDS if max_seconds is None else float(max_seconds)
    deadline = time.monotonic() + limit if limit > 0 else None
    call = dispatched[api_format]
    last: Exception | None = None
    for attempt in range(LLM_RETRIES):
        try:
            text = await _await_within_deadline(
                lambda: call(provider, messages, json_mode), deadline, limit
            )
        except LLMDeadlineExceeded:
            # 总时限用尽：绝不再进重试——否则每次重试再给一整个时限，等于无限延长
            raise
        except Exception as exc:  # noqa: BLE001 - 只对瞬时失败重试，其余抛出
            if not _is_transient(exc) or attempt == LLM_RETRIES - 1:
                raise
            last = exc
            await _sleep_within_deadline(1.5 * (attempt + 1), deadline, limit)
            continue
        if not text.strip():
            if attempt == LLM_RETRIES - 1:
                raise ProviderTransientError("上游返回空响应")
            await _sleep_within_deadline(1.5 * (attempt + 1), deadline, limit)
            continue
        return text
    raise ProviderTransientError(str(last) if last else "上游调用失败")


def extract_json(text: str) -> Any:
    """容错解析 LLM 输出的 JSON：剥代码围栏、截首尾大括号。失败返回 None。"""
    if not text:
        return None
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 2 and lines[-1].strip().startswith("```"):
            stripped = "\n".join(lines[1:-1]).strip()
    for open_char, close_char in (("{", "}"), ("[", "]")):
        start = stripped.find(open_char)
        end = stripped.rfind(close_char)
        if start != -1 and end > start:
            try:
                return json.loads(stripped[start : end + 1])
            except json.JSONDecodeError:
                continue
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return None
