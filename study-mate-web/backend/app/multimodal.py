"""模态两段式：视觉能力判定、按能力注入图片块、失败后剔除重试一次。

对照 DeepTutor 的 multimodal 管线：Stage-1 发送端按能力注入（支持视觉→注入
图片块，统一表示由适配层按格式翻译；不支持→占位行 + notice）；Stage-2 带图
请求失败后按错误标记剔除占位并重试一次，已知视觉模型不降级。
视觉判定以模型的 modalities 为准，未配置（None）时查内置前缀表。
视频/音频一律按不支持处理为文本占位，不实际发送。
"""
from __future__ import annotations

import base64
import contextlib
from collections.abc import AsyncGenerator, Callable
from typing import Any

VISION_MODEL_PREFIXES: tuple[str, ...] = (
    "gpt-4o",
    "gpt-4.1",
    "gpt-5",
    "o3",
    "o4",
    "claude-3",
    "claude-4",
    "gemini",
    "glm-4v",
    "qwen-vl",
    "deepseek-vl",
)

IMAGE_MIME_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
}

VIDEO_EXTENSIONS = frozenset({".mp4", ".mov", ".avi", ".mkv", ".webm"})
AUDIO_EXTENSIONS = frozenset({".mp3", ".wav", ".m4a", ".ogg", ".flac"})

STRIP_PLACEHOLDER = "[图片：{name} —— 当前模型不支持图片输入，已剔除]"
VIDEO_PLACEHOLDER = "[视频：{name} —— 暂不支持视频输入，已剔除]"
AUDIO_PLACEHOLDER = "[音频：{name} —— 暂不支持音频输入，已剔除]"
STAGE1_NOTICE = "当前模型不支持图片输入，图片已剔除"
STAGE2_NOTICE = "模型不支持图片输入，已自动剔除并重试"

_IMAGE_ERROR_MARKERS = (
    "image",
    "vision",
    "multimodal",
    "image_url",
    "content type",
    "must be a string",
    "expected a string",
    "expected string",
    "invalid type for 'messages",
)

_IMAGE_BLOCK_TYPES = frozenset({"image_url", "image"})


def is_known_vision_model(model: str) -> bool:
    name = (model or "").strip().lower()
    return any(name.startswith(prefix) for prefix in VISION_MODEL_PREFIXES)


def supports_vision(model: str, modalities: Any = None) -> bool:
    """模型视觉能力：配置了 modalities 以其 image 为准，未配置查内置前缀表。

    modalities 另兼容 "on"/"off" 字符串（chat.py 经 provider["vision"] 传入的
    派生三态），旧 schema 的 "auto" 与缺省同等对待。
    """
    if isinstance(modalities, dict):
        return bool(modalities.get("image"))
    if modalities == "on":
        return True
    if modalities == "off":
        return False
    return is_known_vision_model(model)


def guess_image_mime(filename: str) -> str:
    dot = filename.rfind(".")
    ext = filename[dot:].lower() if dot != -1 else ""
    return IMAGE_MIME_TYPES.get(ext, "image/png")


def make_image_part(filename: str, data: bytes, mime: str | None = None) -> dict[str, Any]:
    """内部统一表示的图片块（data-URL）；_filename 供剔除占位与私有键剥离用。"""
    media_type = mime or guess_image_mime(filename)
    encoded = base64.b64encode(data).decode("ascii")
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{media_type};base64,{encoded}"},
        "_filename": filename,
    }


def _last_user_index(messages: list[dict[str, Any]]) -> int | None:
    for index in range(len(messages) - 1, -1, -1):
        if messages[index].get("role") == "user":
            return index
    return None


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return str(content or "")


def inject_images(
    messages: list[dict[str, Any]],
    images: list[dict[str, Any]],
    model: str,
    modalities: Any = None,
) -> str | None:
    """Stage-1：把图片注入最后一条 user 消息，返回需发给前端的 notice（或 None）。

    images 每项 {filename, data, mime?}。支持视觉→图片块注入（openai 风格
    parts，由适配层按格式翻译）；不支持→该消息文本对应位置插占位行，不注入。
    """
    if not images:
        return None
    index = _last_user_index(messages)
    if index is None:
        return None
    message = messages[index]
    if not supports_vision(model, modalities):
        text = _text_of(message.get("content")).rstrip()
        lines = [
            STRIP_PLACEHOLDER.format(name=item.get("filename") or "图片") for item in images
        ]
        placeholder = "\n".join(lines)
        messages[index] = {
            **message,
            "content": f"{text}\n{placeholder}" if text else placeholder,
        }
        return STAGE1_NOTICE
    parts: list[Any] = []
    content = message.get("content")
    if isinstance(content, str):
        if content:
            parts.append({"type": "text", "text": content})
    elif isinstance(content, list):
        parts.extend(content)
    for item in images:
        parts.append(
            make_image_part(
                str(item.get("filename") or "image"),
                item.get("data") or b"",
                item.get("mime"),
            )
        )
    messages[index] = {**message, "content": parts}
    return None


def has_image_parts(messages: list[dict[str, Any]]) -> bool:
    for message in messages:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        if any(
            isinstance(part, dict) and part.get("type") in _IMAGE_BLOCK_TYPES
            for part in content
        ):
            return True
    return False


def strip_image_parts(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """返回新消息列表：全部图片块替换为占位行（文本合并为纯字符串 content）。"""
    stripped: list[dict[str, Any]] = []
    for message in messages:
        content = message.get("content")
        if not isinstance(content, list):
            stripped.append(message)
            continue
        text_chunks: list[str] = []
        lines: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") in _IMAGE_BLOCK_TYPES:
                name = str(part.get("_filename") or "") or "图片"
                lines.append(STRIP_PLACEHOLDER.format(name=name))
            elif part.get("type") == "text":
                text_chunks.append(part.get("text", ""))
        text = "".join(text_chunks).rstrip()
        stripped.append({**message, "content": "\n".join(([text] if text else []) + lines)})
    return stripped


def error_matches_image_unsupported(exc: Exception) -> bool:
    """上游错误文本命中图片不支持标记集（参照 DeepTutor is_image_input_unsupported）。"""
    text = str(exc).lower()
    return any(marker in text for marker in _IMAGE_ERROR_MARKERS)


def should_degrade_to_text(exc: Exception, model: str, messages: list[dict[str, Any]]) -> bool:
    """Stage-2 判定：带图请求失败、错误命中标记、且模型不在已知视觉名单。"""
    if not has_image_parts(messages):
        return False
    if is_known_vision_model(model):
        return False
    return error_matches_image_unsupported(exc)


async def prime_stream(
    make_stream: Callable[[list[dict[str, Any]]], AsyncGenerator[str, None]],
    messages: list[dict[str, Any]],
    model: str,
) -> tuple[AsyncGenerator[str, None], str | None, str | None]:
    """打开流式生成器并取首个增量；首帧失败按 Stage-2 剔除重试一次。

    返回 (生成器, 首个增量或 None, notice 或 None)；重试再失败时原样抛出。
    """
    generator = make_stream(messages)
    try:
        first = await generator.__anext__()
    except StopAsyncIteration:
        return generator, None, None
    except Exception as exc:
        if not should_degrade_to_text(exc, model, messages):
            raise
        # 被放弃的首个生成器持有已打开的上游流/连接：先关掉再重试，别等 GC
        with contextlib.suppress(Exception):
            await generator.aclose()
        generator = make_stream(strip_image_parts(messages))
        try:
            first = await generator.__anext__()
        except StopAsyncIteration:
            return generator, None, STAGE2_NOTICE
        return generator, first, STAGE2_NOTICE
    return generator, first, None
