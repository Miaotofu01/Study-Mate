"""会话级模型绑定（2026-10-04 拍板）：每个会话持久化当前选择的模型与思考档位。

口径：会话绑定三元组（`{provider_id, model, reasoning_variant}`，与 `settings.active` 同形）；
会话内聊天与"该会话的"小结/评估都跑在绑定的模型上；绑定失效（提供商停用/删除、模型被移除）
回落当前默认模型并给一条提示。绑定的档位仍走 `llm._reasoning_request` 归一化（开关值不会被
当档位发出去）。
"""
from __future__ import annotations

import pytest

from app import config


def _chat(client, session_id: str, message: str) -> str:
    response = client.post(
        "/api/chat/stream", json={"message": message, "session_id": session_id}
    )
    assert response.status_code == 200
    return response.text


def test_patch_binds_and_clears_model(client):
    session_id = client.post("/api/sessions", json={}).json()["id"]
    # 默认不带绑定
    assert client.get(f"/api/sessions/{session_id}").json()["active"] is None

    bound = {"provider_id": "dashscope", "model": "qwen-plus", "reasoning_variant": "high"}
    patched = client.patch(f"/api/sessions/{session_id}", json={"active": bound}).json()
    assert patched["active"] == bound
    # 落盘 + 列表 meta 都带
    assert client.get(f"/api/sessions/{session_id}").json()["active"] == bound
    meta = next(m for m in client.get("/api/sessions").json() if m["id"] == session_id)
    assert meta["active"] == bound

    # 显式 null 解绑；只传 title 时绑定保持
    client.patch(f"/api/sessions/{session_id}", json={"title": "改名"})
    assert client.get(f"/api/sessions/{session_id}").json()["active"] == bound
    cleared = client.patch(f"/api/sessions/{session_id}", json={"active": None}).json()
    assert cleared["active"] is None


def test_patch_rejects_unavailable_model(client):
    session_id = client.post("/api/sessions", json={}).json()["id"]
    bad_provider = client.patch(
        f"/api/sessions/{session_id}",
        json={"active": {"provider_id": "does-not-exist", "model": "m"}},
    )
    assert bad_provider.status_code == 422
    bad_model = client.patch(
        f"/api/sessions/{session_id}",
        json={"active": {"provider_id": "deepseek", "model": "does-not-exist"}},
    )
    assert bad_model.status_code == 422
    # 被拒后没有留下半吊子绑定
    assert client.get(f"/api/sessions/{session_id}").json()["active"] is None


def test_get_session_provider_only_accepts_resolvable_binding():
    assert config.get_session_provider(None) is None
    assert config.get_session_provider({}) is None
    assert config.get_session_provider({"provider_id": "deepseek", "model": ""}) is None
    good = config.get_session_provider({"provider_id": "deepseek", "model": "deepseek-chat"})
    assert good is not None and good["name"] == "DeepSeek"
    # 档位随绑定生效（这里声明档位表为空 → 归一化成不发思考参数）
    assert good["reasoning_variant"] == ""


def test_model_reasoning_variant_keeps_explicit_off():
    """显式选"关"与"没选"必须区分：抹空会让下游回落默认档（可能把思考又打开）。"""
    reasoning = {"enabled": True, "variants": ["off", "high"], "default_variant": "high"}
    assert config._model_reasoning_variant(reasoning, "off") == "off"
    assert config._model_reasoning_variant(reasoning, "disabled") == "disabled"
    assert config._model_reasoning_variant(reasoning, "") == "high"
    assert config._model_reasoning_variant(reasoning, "high") == "high"
    assert config._model_reasoning_variant(None, "high") == ""
    assert config._model_reasoning_variant({"enabled": False, "variants": ["a"]}, "a") == ""


def test_get_session_provider_respects_binding_variant():
    settings = config.load_settings()
    original = [dict(provider) for provider in settings["providers"]]
    probe = {
        "id": "probe-reasoning",
        "name": "探针",
        "kind": "custom",
        "preset_key": None,
        "base_url": "http://127.0.0.1:1/v1",
        "api_key": "sk-probe",
        "api_format": "openai_chat",
        "enabled": True,
        "models": [
            {
                "name": "probe-model",
                "display_name": "",
                "modalities": None,
                "context_window": None,
                "max_output_tokens": None,
                "capabilities": None,
                "enabled": True,
                "reasoning": {"enabled": True, "variants": ["off", "low", "high"], "default_variant": "high"},
            }
        ],
    }
    settings["providers"] = original + [probe]
    config.save_settings(settings)
    try:
        bound = config.get_session_provider(
            {"provider_id": "probe-reasoning", "model": "probe-model", "reasoning_variant": "low"}
        )
        assert bound is not None and bound["reasoning_variant"] == "low"
        # 未指定档位 → 用模型默认档（high）
        default = config.get_session_provider(
            {"provider_id": "probe-reasoning", "model": "probe-model"}
        )
        assert default is not None and default["reasoning_variant"] == "high"
    finally:
        restored = config.load_settings()
        restored["providers"] = original
        config.save_settings(restored)


def test_chat_runs_on_bound_model_and_falls_back_with_notice(client, monkeypatch):
    """会话内聊天用绑定模型（助手消息的 model 标识可证）；绑定失效则回落 + 提示。"""
    session_id = client.post("/api/sessions", json={}).json()["id"]
    client.patch(
        f"/api/sessions/{session_id}",
        json={"active": {"provider_id": "siliconflow", "model": "deepseek-ai/DeepSeek-V3"}},
    )

    _chat(client, session_id, "第一问")
    messages = client.get(f"/api/sessions/{session_id}").json()["messages"]
    assert messages[-1]["model"] == "SiliconFlow / deepseek-ai/DeepSeek-V3"

    # 模拟绑定失效：提供商被停用 → 回落默认模型，并给出提示
    settings = config.load_settings()
    for provider in settings["providers"]:
        if provider["id"] == "siliconflow":
            provider["enabled"] = False
    config.save_settings(settings)
    try:
        body = _chat(client, session_id, "第二问")
        assert "会话绑定的模型已不可用" in body
        messages = client.get(f"/api/sessions/{session_id}").json()["messages"]
        assert messages[-1]["model"] == "DeepSeek / deepseek-chat"
    finally:
        settings = config.load_settings()
        for provider in settings["providers"]:
            if provider["id"] == "siliconflow":
                provider["enabled"] = True
        config.save_settings(settings)


def test_fixture_session_binding_does_not_break_fixture_chat(client):
    """fixture 模式下会话绑定照样被解析（真实 provider 字典），但流内容仍是 canned。"""
    session_id = client.post("/api/sessions", json={}).json()["id"]
    client.patch(
        f"/api/sessions/{session_id}",
        json={"active": {"provider_id": "openai", "model": "gpt-4o-mini"}},
    )
    body = _chat(client, session_id, "嗨")
    assert "event: delta" in body
    messages = client.get(f"/api/sessions/{session_id}").json()["messages"]
    assert messages[-1]["model"] == "OpenAI / gpt-4o-mini"


@pytest.mark.parametrize("field", ["title", "workspace", "active"])
def test_patch_empty_body_still_422(client, field):
    session_id = client.post("/api/sessions", json={}).json()["id"]
    assert client.patch(f"/api/sessions/{session_id}", json={}).status_code == 422
