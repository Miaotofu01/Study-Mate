"""统一错误模型（ErrorInfo）与脱敏、停止意图登记。

一份 ErrorInfo 同时供三处使用：SSE `error` 事件、助手消息持久化 `error` 字段、
预 HTTP（503/409/422）JSON 体。字段口径见 ErrorInfo 定义；`request_id` 恒为
当前轮的 turn_id（不引入新 middleware）。

设计约束（2026-10-05 协调者拍板）：
- 真实错误（上游 4xx/5xx、传输中断、超时、异常 EOF、空响应）不得只发灰 notice、
  不得落成 completed；预算类截停（墙钟）也走 error 终态，工具次数受控收尾可 completed
  但保留真实 stopped_reason="budget"。
- 诊断文本（summary/detail/审计字段）一律脱敏且限长：不仅按 key 过滤，字符串里内嵌的
  Authorization / api-key / Bearer / sk- 也要打码——递归过滤 key 会漏掉 str 里的密钥。
- stop intent 绑定当前 active turn_id：turn 已结束则返回 stop=false，不残留 intent。
"""
from __future__ import annotations

import asyncio
import re
from dataclasses import asdict, dataclass
from typing import Any

SUMMARY_LIMIT = 200
DETAIL_LIMIT = 1200

# 每个字符串字段的输出上限（make / to_dict 统一口径）。脱敏对**全部** str 字段生效，
# 不只是 summary/detail——审计里塞进去的任意字段都可能夹带密钥。
_FIELD_LIMITS: dict[str, int] = {
    "code": 64,
    "phase": 40,
    "summary": SUMMARY_LIMIT,
    "upstream_code": 120,
    "detail": DETAIL_LIMIT,
    "stopped_reason": 64,
    "request_id": 128,
    "source": 64,
    "operation": 64,
}


class UpstreamEOFError(Exception):
    """上游流在缺少正常结束标记（finish/terminal event）时提前关闭。"""

# 规范化错误码（SSE / 持久化 / 预 HTTP 共用）
CODE_UPSTREAM_HTTP = "upstream_http"
CODE_UPSTREAM_TRANSPORT = "upstream_transport"
CODE_UPSTREAM_TIMEOUT = "upstream_timeout"
CODE_UPSTREAM_EOF = "upstream_eof"
CODE_UPSTREAM_EMPTY = "upstream_empty"
CODE_BUDGET_EXHAUSTED = "budget_exhausted"
CODE_NO_API_KEY = "no_api_key"
CODE_SKILLS_MISSING = "skills_missing"
CODE_SESSION_BUSY = "session_busy"
CODE_INVALID_REQUEST = "invalid_request"
CODE_USER_STOPPED = "user_stopped"
CODE_INTERNAL = "internal"

CODES = frozenset(
    {
        CODE_UPSTREAM_HTTP,
        CODE_UPSTREAM_TRANSPORT,
        CODE_UPSTREAM_TIMEOUT,
        CODE_UPSTREAM_EOF,
        CODE_UPSTREAM_EMPTY,
        CODE_BUDGET_EXHAUSTED,
        CODE_NO_API_KEY,
        CODE_SKILLS_MISSING,
        CODE_SESSION_BUSY,
        CODE_INVALID_REQUEST,
        CODE_USER_STOPPED,
        CODE_INTERNAL,
    }
)

# 值得重试的瞬时 HTTP 码（与 llm._TRANSIENT_STATUS 同口径，此处不反向依赖 llm）
_TRANSIENT_STATUS = frozenset({401, 408, 409, 425, 429, 500, 502, 503, 504, 522, 524})

# 打码：按 key:value 形态、Bearer 头、常见密钥前缀。字符串级，覆盖 str 里内嵌的密钥。
# key 允许被引号包裹（JSON `"api_key": "..."` / Python `'api_key': '...'`）；值前若带
# `Bearer ` scheme 一并吞掉——否则只剩 "Bearer" 被打码，非 sk- 前缀的真令牌会原样泄漏。
_KEY_VALUE_SECRET = re.compile(
    r"""(?ix)
    (["']?)                                   # 1: key 的包裹引号（可有可无）
    \b(authorization|x-api-key|api[-_]?key)\b
    \1                                        # key 尾部引号与开头配对
    \s*[:=]\s*
    (?:bearer\s+)?                            # 吞掉 scheme，避免令牌裸露
    (?: "[^"]*" | '[^']*' | [^\s,;]+ )
    """
)
_SECRET_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (_KEY_VALUE_SECRET, r"\1\2\1: ***"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]+"), "Bearer ***"),
    (re.compile(r"\bsk-[A-Za-z0-9._\-]{6,}"), "sk-***"),
    (re.compile(r"\bAIza[0-9A-Za-z._\-]{20,}"), "AIza***"),
)


def redact_text(value: Any, limit: int = DETAIL_LIMIT) -> str:
    """脱敏 + 限长：先把字符串里内嵌的密钥打码，再截断。"""
    text = value if isinstance(value, str) else str(value or "")
    for pattern, replacement in _SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    if limit > 0 and len(text) > limit:
        text = f"{text[:limit]}…（共 {len(text)} 字符）"
    return text


def _redact_field(name: str, value: Any) -> Any:
    """按字段口径脱敏 + 限长；非 str 原样返回（None/bool/int）。"""
    if not isinstance(value, str):
        return value
    return redact_text(value, _FIELD_LIMITS.get(name, SUMMARY_LIMIT))



def _coerce_status(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


_STATUS_IN_TEXT = re.compile(
    r"""(?i)
    (?:
        \bHTTP(?:/\d(?:\.\d)?)?\s+
        |\bError\s+code:\s*
        |['"]?status(?:_?code)?['"]?\s*[:=]\s*['"]?
    )
    (\d{3})\b
    """,
    re.X,
)


def _status_from_text(text: str) -> int | None:
    match = _STATUS_IN_TEXT.search(text)
    return int(match.group(1)) if match else None


_JSON_CODE_IN_TEXT = re.compile(r"(?i)['\"]code['\"]\s*:\s*['\"]([^'\"]{1,120})['\"]")
_JSON_TYPE_IN_TEXT = re.compile(r"(?i)['\"]type['\"]\s*:\s*['\"]([^'\"]{1,120})['\"]")


def _upstream_code_from_text(text: str) -> str | None:
    """从上游错误体/冲突提示里抓一个短 code（如 system_memory_overloaded）。

    兼容双引号 JSON 与单引号（Python dict repr / SDK 拼出来的 body）两种形态。
    """
    for pattern in (_JSON_CODE_IN_TEXT, _JSON_TYPE_IN_TEXT):
        match = pattern.search(text)
        if match:
            return match.group(1)
    return None


@dataclass(frozen=True)
class ErrorInfo:
    """规范化的错误快照；dict 形态经 to_dict() 供 SSE/JSON/持久化。"""

    code: str
    phase: str
    summary: str
    retryable: bool = False
    status: int | None = None
    upstream_code: str | None = None
    detail: str | None = None
    stopped_reason: str | None = None
    request_id: str | None = None
    source: str | None = None
    operation: str | None = None

    def to_dict(self) -> dict[str, Any]:
        # 每个 str 字段都脱敏 + 限长（不只 summary/detail）。
        return {key: _redact_field(key, value) for key, value in asdict(self).items()}

    def with_request_id(self, request_id: str | None) -> "ErrorInfo":
        if request_id == self.request_id:
            return self
        return ErrorInfo(**{**asdict(self), "request_id": request_id})


def make(
    code: str,
    *,
    phase: str,
    summary: str,
    retryable: bool = False,
    status: int | None = None,
    upstream_code: str | None = None,
    detail: str | None = None,
    stopped_reason: str | None = None,
    request_id: str | None = None,
    source: str | None = None,
    operation: str | None = None,
) -> ErrorInfo:
    return ErrorInfo(
        code=_redact_field("code", code),
        phase=_redact_field("phase", phase),
        summary=_redact_field("summary", summary),
        retryable=retryable,
        status=_coerce_status(status),
        upstream_code=_redact_field("upstream_code", upstream_code),
        detail=_redact_field("detail", detail),
        stopped_reason=_redact_field("stopped_reason", stopped_reason),
        request_id=_redact_field("request_id", request_id),
        source=_redact_field("source", source),
        operation=_redact_field("operation", operation),
    )


def _summarize(code: str, status: int | None, upstream_code: str | None) -> str:
    if code == CODE_UPSTREAM_HTTP:
        suffix = f"（{upstream_code}）" if upstream_code else ""
        return f"上游服务返回 HTTP {status}{suffix}，本轮未完成。"
    if code == CODE_UPSTREAM_TRANSPORT:
        return "与模型服务的连接中断，本轮未完成。"
    if code == CODE_UPSTREAM_TIMEOUT:
        return "模型服务响应超时，本轮未完成。"
    if code == CODE_UPSTREAM_EOF:
        return "上游连接提前中断（响应未正常结束），本轮未完成。"
    if code == CODE_UPSTREAM_EMPTY:
        return "上游返回了空响应，本轮未完成。"
    if code == CODE_BUDGET_EXHAUSTED:
        return "本轮已达到单次时长上限，已用现有内容收尾。"
    if code == CODE_SESSION_BUSY:
        return "该会话正在处理上一轮回复或编排，请稍后再试。"
    if code == CODE_INVALID_REQUEST:
        return "请求参数不合法，已拒绝且未产生任何会话或消息。"
    if code == CODE_SKILLS_MISSING:
        return "技能规范缺失，无法保证行为口径，本轮未开始。"
    if code == CODE_NO_API_KEY:
        return "尚未配置模型 API Key，请到 Settings 填写。"
    if code == CODE_USER_STOPPED:
        return "已按你的要求停止本轮。"
    return "本轮处理出错，未完成。"


def from_exception(
    exc: BaseException,
    *,
    phase: str = "stream",
    request_id: str | None = None,
    source: str | None = None,
    operation: str | None = None,
    status: int | None = None,
    upstream_code: str | None = None,
) -> ErrorInfo:
    """把任意异常规范化成 ErrorInfo（SDK / httpx / 本模块 ProviderError 都认）。"""
    text = redact_text(str(exc), DETAIL_LIMIT)
    name = type(exc).__name__
    status = _coerce_status(status) or _coerce_status(getattr(exc, "status_code", None)) or _coerce_status(
        getattr(exc, "status", None)
    )
    if status is None:
        status = _status_from_text(text)
    body = getattr(exc, "body", None)
    body_error = body.get("error", body) if isinstance(body, dict) else {}
    body_code = (body_error.get("code") or body_error.get("type")) if isinstance(body_error, dict) else None
    upstream_code = (
        upstream_code
        or getattr(exc, "upstream_code", None)
        or (str(body_code) if body_code else None)
        or _upstream_code_from_text(text)
    )
    explicit_code = getattr(exc, "code", None)
    code: str | None = explicit_code if explicit_code in CODES else None
    cancelled = isinstance(exc, asyncio.CancelledError)

    if code is None:
        if cancelled:
            # 任务被取消 = 连接断开，**不是**用户点了停止；user_stop 只能由 stop endpoint
            # 经 request_stop/consume_stop 显式登记，绝不能在异常映射层默认。
            code = CODE_UPSTREAM_TRANSPORT
        elif isinstance(exc, asyncio.TimeoutError) or name in (
            "TimeoutError",
            "APITimeoutError",
            "ReadTimeout",
            "ConnectTimeout",
            "WriteTimeout",
            "TimeoutException",
            "LLMDeadlineExceeded",
        ):
            code = CODE_UPSTREAM_TIMEOUT
        elif name in ("RemoteProtocolError", "IncompleteRead", "UpstreamEOFError", "ProtocolError"):
            code = CODE_UPSTREAM_EOF
        elif name in (
            "ConnectError",
            "ConnectTimeout",
            "ReadError",
            "WriteError",
            "TransportError",
            "NetworkError",
            "APIConnectionError",
            "PoolTimeout",
        ) or "Connection" in name:
            code = CODE_UPSTREAM_TRANSPORT
        elif status is not None:
            code = CODE_UPSTREAM_HTTP
        elif "空响应" in text:
            code = CODE_UPSTREAM_EMPTY
        else:
            code = CODE_INTERNAL

    retryable = {
        CODE_UPSTREAM_HTTP: status is None or status in _TRANSIENT_STATUS,
        CODE_UPSTREAM_TRANSPORT: True,
        CODE_UPSTREAM_TIMEOUT: True,
        CODE_UPSTREAM_EOF: True,
        CODE_UPSTREAM_EMPTY: True,
        CODE_BUDGET_EXHAUSTED: False,
        CODE_USER_STOPPED: False,
    }.get(code, False)
    # ProviderError 可显式声明 retryable（如测试注入的确定性失败 retryable=False），优先于按码推导。
    explicit_retryable = getattr(exc, "retryable", None)
    if isinstance(explicit_retryable, bool):
        retryable = explicit_retryable
    stopped_reason = {
        CODE_UPSTREAM_HTTP: "upstream_http",
        CODE_UPSTREAM_TRANSPORT: "transport",
        CODE_UPSTREAM_TIMEOUT: "timeout",
        CODE_UPSTREAM_EOF: "eof",
        CODE_UPSTREAM_EMPTY: "empty",
        CODE_USER_STOPPED: "user_stop",
    }.get(code)
    if cancelled and stopped_reason == "transport":
        stopped_reason = "disconnect"

    return make(
        code,
        phase=phase,
        summary=_summarize(code, status, upstream_code),
        retryable=retryable,
        status=status,
        upstream_code=upstream_code,
        detail=text,
        stopped_reason=stopped_reason,
        request_id=request_id,
        source=source,
        operation=operation,
    )


# ---------- stop intent：绑定当前 active turn_id ----------

_active_turns: dict[str, str] = {}
_stop_intents: dict[str, str] = {}


def register_turn(session_id: str, turn_id: str) -> None:
    """登记会话当前在飞的 turn；同一会话由租约保证至多一个。"""
    _active_turns[session_id] = turn_id
    _stop_intents.pop(session_id, None)


def clear_turn(session_id: str, turn_id: str) -> None:
    """turn 结束：仅在仍是该 turn 时清除，连带清掉未消费的 intent（不残留）。"""
    if _active_turns.get(session_id) == turn_id:
        _active_turns.pop(session_id, None)
    if _stop_intents.get(session_id) == turn_id:
        _stop_intents.pop(session_id, None)


def active_turn(session_id: str) -> str:
    return _active_turns.get(session_id, "")


def request_stop(session_id: str, turn_id: str) -> bool:
    """登记一次停止意图；必须精确匹配当前 active turn，否则返回 False 且不残留。"""
    if not turn_id or _active_turns.get(session_id) != turn_id:
        _stop_intents.pop(session_id, None)
        return False
    _stop_intents[session_id] = turn_id
    return True


def consume_stop(session_id: str, turn_id: str) -> bool:
    """消费停止意图（单次）：命中当前 turn 返回 True 并清除；不命中一律不动。

    不能用 `pop(...) == turn_id`：pop 先删后比对，非 owner 的调用会把别的 turn
    待消费的 intent 一并删掉。
    """
    if _stop_intents.get(session_id) != turn_id:
        return False
    _stop_intents.pop(session_id, None)
    return True


def has_stop_intent(session_id: str, turn_id: str) -> bool:
    return _stop_intents.get(session_id) == turn_id
