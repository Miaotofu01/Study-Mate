"""推理档位取值兼容（2026-10-04）。

维护者指出：档位表里其实混着**两种语义**——`low/medium/high/max` 是推理**档位**，而
`disabled/enabled`、`off/on` 是**思考开关**。开关的"开"没有对应档位名，早先实现把它
原样当 `reasoning_effort` 发出去，实测被网关 400（new-api 只认 none/minimal/low/medium/
high/xhigh/max）。本文件锁住归一化行为与"绝不把开关值当档位发"的回归。

Anthropic 侧的已知边界保持不变：认不出的档位名不发思考参数（宁可退回默认，也不 400）。
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app import llm


def _provider(
    variant: str,
    variants: tuple[str, ...] = ("disabled", "enabled"),
    default: str = "enabled",
    enabled: bool = True,
) -> dict:
    return {
        "model": "m",
        "api_format": "openai_chat",
        "reasoning": {
            "enabled": enabled,
            "variants": list(variants),
            "default_variant": default,
        },
        "reasoning_variant": variant,
    }


@pytest.mark.parametrize(
    "variant,expected",
    [
        ("disabled", None),
        ("off", None),
        ("none", None),
        ("false", None),
        ("关闭", None),
        ("enabled", "medium"),
        ("on", "medium"),
        ("开启", "medium"),
        ("默认", "medium"),
    ],
)
def test_switch_values_are_not_sent_as_effort(variant, expected):
    assert llm._openai_reasoning_effort(_provider(variant)) == expected


@pytest.mark.parametrize("variant", ["minimal", "low", "medium", "high", "xhigh", "max"])
def test_tier_values_pass_through(variant):
    assert llm._openai_reasoning_effort(_provider(variant)) == variant


def test_unknown_tier_passes_through_for_openai():
    # 自由档位名照发（自定义网关可能有自己的词表）；Anthropic 认不出则不发思考参数
    assert llm._openai_reasoning_effort(_provider("deep")) == "deep"
    payload = llm._anthropic_payload(_provider("deep"), [{"role": "user", "content": "q"}], False)
    assert "thinking" not in payload
    # 而"开关开"会带上默认档预算（不能因为档位名不是 low/high 就当作没开思考）
    enabled = llm._anthropic_payload(_provider("enabled"), [{"role": "user", "content": "q"}], False)
    assert enabled["thinking"] == {"type": "enabled", "budget_tokens": 8192}


def test_reasoning_off_or_no_variants_sends_nothing():
    assert llm._reasoning_request(_provider("enabled", enabled=False)).enabled is False
    assert llm._reasoning_request(_provider("enabled", variants=())).enabled is False
    assert llm._reasoning_request({"reasoning": None}).enabled is False
    assert llm._openai_reasoning_effort(_provider("enabled", enabled=False)) is None
    assert llm._openai_reasoning_effort(_provider("enabled", variants=())) is None


def test_empty_variant_falls_back_to_model_default():
    # 未显式选择档位 → 用模型声明的 default_variant（这里 default=enabled → 默认档 medium）
    assert llm._openai_reasoning_effort(_provider("")) == "medium"
    # default 是 off 类取值则不思考
    assert llm._openai_reasoning_effort(_provider("", default="disabled")) is None


def test_anthropic_budget_mapping():
    def budget(variant: str) -> int | None:
        request = llm._reasoning_request(_provider(variant))
        if not request.enabled:
            return None
        return llm.ANTHROPIC_THINKING_BUDGETS.get(
            request.effort or llm.DEFAULT_REASONING_EFFORT
        )

    assert budget("disabled") is None
    assert budget("enabled") == 8192
    assert budget("low") == 2048
    assert budget("high") == 24576
    assert budget("deep") is None


def _capture_openai_turn(monkeypatch, provider: dict) -> dict:
    """跑一次 openai turn 并把传给 SDK 的 kwargs 抓出来（用假 client，不外呼）。"""
    captured: dict = {}

    async def create(**kwargs):
        captured.update(kwargs)

        async def empty():
            if False:  # pragma: no cover - 空流
                yield None

        return empty()

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    monkeypatch.setattr(llm, "build_client", lambda _provider: client)
    monkeypatch.setattr(llm, "is_fixture_mode", lambda: False)

    async def drain():
        async for _ in llm._openai_chat_turn(
            provider, [{"role": "user", "content": "q"}], None, None
        ):
            pass

    asyncio.run(drain())
    return captured


def test_openai_turn_sends_default_effort_for_switch_on(monkeypatch):
    """回归：`enabled` 曾被原样当 reasoning_effort 发出去 → 网关 400。"""
    captured = _capture_openai_turn(monkeypatch, _provider("enabled"))
    assert captured["extra_body"] == {"reasoning_effort": "medium"}


def test_openai_turn_omits_reasoning_when_switch_off(monkeypatch):
    captured = _capture_openai_turn(monkeypatch, _provider("disabled"))
    assert "extra_body" not in captured
