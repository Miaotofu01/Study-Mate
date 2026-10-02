"""LLM 统一适配层：按 provider.api_format 分派 openai_chat / openai_responses / anthropic。

内部消息统一为 openai 风格 content parts：
{"type": "text", "text": ...} 与 {"type": "image_url", "image_url": {"url": "data:mime;base64,..."}}，
由本模块翻译为各协议的请求结构并解析流式/非流式响应；上游错误原样透出。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import AsyncGenerator
from typing import Any

from openai import AsyncOpenAI

try:
    import httpx
except ImportError:  # openai v3 自带 httpx2（同 API 的分叉）
    import httpx2 as httpx

API_FORMATS = ("openai_chat", "openai_responses", "anthropic")
ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_MAX_TOKENS = 4096
REQUEST_TIMEOUT = 60.0
TEMPERATURE = 0.2
_ERROR_TEXT_LIMIT = 2000
REASONING_OFF_VARIANT = "off"
ANTHROPIC_THINKING_BUDGETS = {"low": 2048, "medium": 8192, "high": 24576}
# Anthropic 要求 budget_tokens < max_tokens
ANTHROPIC_THINKING_HEADROOM = 4096


def _reasoning_variant(provider: dict[str, Any]) -> str:
    """当前生效推理档位；未启用 / variants 为空 / "off" 时返回 ""（不发思考参数）。"""
    reasoning = provider.get("reasoning")
    if not isinstance(reasoning, dict) or not reasoning.get("enabled"):
        return ""
    variants = reasoning.get("variants")
    if not isinstance(variants, list) or not variants:
        return ""
    variant = str(provider.get("reasoning_variant") or "") or str(
        reasoning.get("default_variant") or ""
    )
    return "" if variant == REASONING_OFF_VARIANT else variant


def _max_output_limit(provider: dict[str, Any]) -> int | None:
    """模型声明的最大输出 tokens；None 表示按协议默认（不发送该参数）。"""
    limit = provider.get("max_output_tokens")
    if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
        return None
    return limit


class ProviderError(RuntimeError):
    """上游返回错误（含状态码与响应体摘要）。"""


def build_client(provider: dict[str, Any]) -> AsyncOpenAI:
    return AsyncOpenAI(
        base_url=provider.get("base_url") or None,
        api_key=provider.get("api_key") or "missing",
        timeout=REQUEST_TIMEOUT,
    )


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


def _openai_wire_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """openai_chat 外发消息：剔除内部私有键（_filename 等下划线开头）。"""
    wire = []
    for message in messages:
        content = message.get("content")
        if isinstance(content, list):
            content = [
                {key: value for key, value in part.items() if not str(key).startswith("_")}
                for part in content
                if isinstance(part, dict)
            ]
        wire.append({**message, "content": content})
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


async def _raise_for_status(response: httpx.Response) -> None:
    if response.status_code >= 400:
        body = (await response.aread()).decode("utf-8", errors="replace")
        raise ProviderError(f"HTTP {response.status_code}: {body[:_ERROR_TEXT_LIMIT]}")


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
    client = build_client(provider)
    kwargs: dict[str, Any] = {}
    limit = _max_output_limit(provider)
    if limit is not None:
        kwargs["max_tokens"] = limit
    variant = _reasoning_variant(provider)
    if variant:
        kwargs["extra_body"] = {"reasoning_effort": variant}
    stream = await client.chat.completions.create(
        model=provider.get("model") or "",
        messages=_openai_wire_messages(messages),  # type: ignore[arg-type]
        stream=True,
        **kwargs,
    )
    async for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta.content:
            yield delta.content


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
    variant = _reasoning_variant(provider)
    if variant:
        kwargs["extra_body"] = {"reasoning_effort": variant}
    response = await client.chat.completions.create(
        model=provider.get("model") or "",
        messages=_openai_wire_messages(messages),  # type: ignore[arg-type]
        temperature=TEMPERATURE,
        **kwargs,
    )
    return response.choices[0].message.content or ""


# ---------- openai_responses：{base}/responses，system→instructions ----------


def _responses_payload(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    json_mode: bool,
    stream: bool,
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
    variant = _reasoning_variant(provider)
    if variant:
        payload["reasoning"] = {"effort": variant}
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
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
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
                    raise ProviderError(json.dumps(data, ensure_ascii=False)[:_ERROR_TEXT_LIMIT])


async def _chat_openai_responses(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    json_mode: bool,
) -> str:
    payload = _responses_payload(provider, messages, json_mode=json_mode, stream=False)
    if not _reasoning_variant(provider):
        # 推理模型不接受自定义 temperature，开启思考时留给协议默认值
        payload["temperature"] = TEMPERATURE
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        response = await client.post(
            _provider_url(provider, "/responses"),
            headers=_bearer_headers(provider),
            json=payload,
        )
    if response.status_code >= 400:
        raise ProviderError(_error_body(response))
    data = response.json()
    if data.get("error"):
        raise ProviderError(json.dumps(data["error"], ensure_ascii=False)[:_ERROR_TEXT_LIMIT])
    return _responses_output_text(data)


# ---------- anthropic：{base}/v1/messages，system 独立参数，JSON 模式走提示词约束 ----------


def _anthropic_payload(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    json_mode: bool,
) -> dict[str, Any]:
    system_chunks = [
        _text_of_content(message.get("content"))
        for message in messages
        if message.get("role") == "system"
    ]
    if json_mode:
        system_chunks.append("只输出一个合法的 JSON 对象，不要输出任何其他文字。")
    payload_messages: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            continue
        blocks: list[dict[str, Any]] = []
        for part in _content_parts(message.get("content")):
            if part.get("type") == "text":
                blocks.append({"type": "text", "text": part.get("text", "")})
            elif part.get("type") == "image_url":
                url = (part.get("image_url") or {}).get("url", "")
                parsed = _data_url_parts(url)
                if parsed:
                    mime, encoded = parsed
                    blocks.append(
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": mime, "data": encoded},
                        }
                    )
        if not blocks:
            blocks = [{"type": "text", "text": ""}]
        payload_messages.append({"role": role, "content": blocks})
    payload: dict[str, Any] = {
        "model": provider.get("model") or "",
        "max_tokens": _max_output_limit(provider) or DEFAULT_MAX_TOKENS,
        "messages": payload_messages,
    }
    variant = _reasoning_variant(provider)
    budget = ANTHROPIC_THINKING_BUDGETS.get(variant) if variant else None
    if budget is not None:
        # 协议要求 budget_tokens < max_tokens：声明值不足时抬高到预算 + 余量
        payload["max_tokens"] = max(payload["max_tokens"], budget + ANTHROPIC_THINKING_HEADROOM)
        payload["thinking"] = {"type": "enabled", "budget_tokens": budget}
    system_text = "\n\n".join(chunk for chunk in system_chunks if chunk)
    if system_text:
        payload["system"] = system_text
    return payload


async def _stream_anthropic(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
) -> AsyncGenerator[str, None]:
    payload = _anthropic_payload(provider, messages, json_mode=False)
    payload["stream"] = True
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
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
                    raise ProviderError(
                        json.dumps(data.get("error") or data, ensure_ascii=False)[:_ERROR_TEXT_LIMIT]
                    )


async def _chat_anthropic(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    json_mode: bool,
) -> str:
    payload = _anthropic_payload(provider, messages, json_mode)
    if not _reasoning_variant(provider):
        # 开启 extended thinking 时 Anthropic 只接受协议默认 temperature
        payload["temperature"] = TEMPERATURE
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        response = await client.post(
            _provider_url(provider, "/v1/messages"),
            headers=_anthropic_headers(provider),
            json=payload,
        )
    if response.status_code >= 400:
        raise ProviderError(_error_body(response))
    data = response.json()
    return "".join(
        part.get("text", "")
        for part in data.get("content") or []
        if isinstance(part, dict) and part.get("type") == "text"
    )


# ---------- E2E fixture 模式：STUDYMATE_E2E_FIXTURE=1 时 LLM 调用不外呼 ----------

FIXTURE_ENV = "STUDYMATE_E2E_FIXTURE"
FIXTURE_STREAM_SEGMENTS = (
    "这是固定测试回复的第一段：先把要讲的概念立起来。",
    "第二段：用一个具体例子把要点串起来。",
    "第三段：轮到你动手练习，试着自己复述一遍。",
    "第四段：本次回复到此结束，欢迎继续提问。",
)
FIXTURE_STREAM_DELAY_SECONDS = 0.4
_fixture_at_import = os.getenv(FIXTURE_ENV) == "1"


def is_fixture_mode() -> bool:
    return _fixture_at_import or os.getenv(FIXTURE_ENV) == "1"


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
            "    note: 提到了封装但没说清首部的作用，差一步\n"
            "  - q: 举一个封装在真实请求里的例子\n"
            "    kind: 证据核验\n"
            "    answer: 会话中未作答\n"
            "    verdict: 不通过\n"
            "    note: 作答里引用不出对应证据\n"
            "mastery: 0.4\n"
            "verdict: 通过\n"
            "next: 复习首部与载荷的区别后重新评估本节\n"
            "misconceptions:\n"
            "  - 把 OSI 七层当成实际实现\n"
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
            "---\n"
        )
    if fixture_kind == "generate":
        return json.dumps(FIXTURE_CURRICULUM, ensure_ascii=False)
    return "这是固定测试回复。"


async def _fixture_stream() -> AsyncGenerator[str, None]:
    for index, segment in enumerate(FIXTURE_STREAM_SEGMENTS):
        if index:
            await asyncio.sleep(FIXTURE_STREAM_DELAY_SECONDS)
        yield segment


# ---------- 对外入口 ----------


async def stream_chat(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
) -> AsyncGenerator[str, None]:
    """流式返回 assistant 文本增量；provider 为当前生效 provider 字典。"""
    if is_fixture_mode():
        async for piece in _fixture_stream():
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


async def chat_once(
    provider: dict[str, Any],
    messages: list[dict[str, Any]],
    json_mode: bool = False,
    fixture_kind: str | None = None,
) -> str:
    """非流式调用，temperature 0.2；json_mode 按协议启用结构化输出。

    fixture_kind 仅在 fixture 模式下生效，决定返回哪类 canned 内容；
    非 fixture 模式下该参数被忽略。
    """
    if is_fixture_mode():
        return _fixture_chat(fixture_kind)
    api_format = str(provider.get("api_format") or "openai_chat")
    if api_format == "openai_chat":
        return await _chat_openai_chat(provider, messages, json_mode)
    if api_format == "openai_responses":
        return await _chat_openai_responses(provider, messages, json_mode)
    if api_format == "anthropic":
        return await _chat_anthropic(provider, messages, json_mode)
    raise ValueError(f"未知 API 格式：{api_format}")


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
