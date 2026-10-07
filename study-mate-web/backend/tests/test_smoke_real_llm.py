"""真实 LLM 工具循环冒烟（默认跳过）。

设 `SMOKE_REAL_LLM=1` 才跑：对开发 settings 里带 key 的活跃提供商**真连一次**，
验证 K 系列工具化的整条通路（tools 声明 → 流式 tool_call 聚合 → 工具执行 →
tool 结果回喂 → 最终答复）。渠道口径：**串行不并发**、脚本自己钉死模型（live
settings 会被 UI 改掉）；方法与坑见 Web_CHANGE 2026-10-03 冒烟条目。

用法（在 `backend/`）：
    SMOKE_REAL_LLM=1 [SMOKE_MODEL=space-bunny-alpha] [SMOKE_SETTINGS=…] \
        .venv/Scripts/python.exe -m pytest tests/test_smoke_real_llm.py -s -q

注意：conftest 把 `STUDYMATE_E2E_FIXTURE=1` 与隔离 DATA_DIR 都设上了——本测试
显式关掉 fixture 门（否则 llm.stream_turn 直接吐 canned 文本），并按绝对路径读
**开发** settings（隔离 DATA_DIR 里没有提供商配置）。
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.getenv("SMOKE_REAL_LLM") != "1",
    reason="真实 LLM 冒烟默认跳过；设 SMOKE_REAL_LLM=1 才跑（真连中转渠道、串行、按次计费）",
)

# backend/tests/ -> backend/ -> study-mate-web/
DEFAULT_SETTINGS = Path(__file__).resolve().parents[2] / "data" / "settings.json"


@pytest.fixture()
def real_mode(monkeypatch):
    """关掉 fixture 门，让 llm.stream_turn 真连渠道。"""
    from app import llm

    monkeypatch.delenv("STUDYMATE_E2E_FIXTURE", raising=False)
    monkeypatch.setattr(llm, "_fixture_at_import", False)


def _provider(model_override: str | None = None) -> dict:
    path = Path(os.getenv("SMOKE_SETTINGS") or DEFAULT_SETTINGS)
    if not path.is_file():
        pytest.skip(f"找不到开发 settings：{path}")
    settings = json.loads(path.read_text(encoding="utf-8"))
    active = settings.get("active") or {}
    entry = next(
        (item for item in settings.get("providers") or [] if item.get("id") == active.get("provider_id")),
        None,
    )
    if entry is None or not entry.get("api_key"):
        pytest.skip("开发 settings 里没有带 key 的活跃提供商")
    model = model_override or os.getenv("SMOKE_MODEL") or str(active.get("model") or "")
    model_entry = next(
        (item for item in entry.get("models") or [] if item.get("name") == model), {}
    )
    return {
        "id": entry.get("id"),
        "base_url": entry.get("base_url"),
        "api_key": entry.get("api_key"),
        "api_format": entry.get("api_format") or "openai_chat",
        "model": model,
        "max_output_tokens": model_entry.get("max_output_tokens"),
    }


def test_tool_loop_against_real_provider(real_mode, tmp_path):
    from app import agent, tools

    provider = _provider()
    (tmp_path / "MISSION.md").write_text("使命：用一个能跑起来的最小项目验证学习闭环。", encoding="utf-8")
    ctx = tools.ToolContext(read_roots=[tmp_path], write_roots=[], label="冒烟工作区", state={})
    events: list[dict] = []

    async def emit(event: dict) -> None:
        events.append(event)

    messages = [
        {
            "role": "system",
            "content": (
                "你是冒烟测试助手。回答前**必须**先调用 list_workspace 工具查看工作区，"
                "再用 read_course_file 读取 MISSION.md，最后用一句话复述使命。"
            ),
        },
        {"role": "user", "content": "列出工作区并读 MISSION.md，然后用一句话告诉我使命是什么。"},
    ]

    outcome = asyncio.run(
        agent.run_agent(
            agent.real_turn_source(provider),
            messages,
            ctx,
            emit,
            tools.schemas(tools.CHAT_TOOLS),
            audit_meta={"kind": "smoke", "model": provider["model"]},
        )
    )

    print(
        f"\n[smoke] model={provider['model']} rounds={outcome.rounds} "
        f"tool_calls={outcome.tool_calls} degraded={outcome.degraded} "
        f"events={[e['type'] for e in events]}"
    )
    print(f"[smoke] text={outcome.text[:500]!r}")

    assert outcome.text.strip(), "真实模型未产出任何文本（wire/传输层可能有问题）"
    assert outcome.tool_calls >= 1, f"真实模型未发起工具调用：events={[e['type'] for e in events]}"
    assert any(e["type"] == "tool_result" for e in events), "没有工具结果回吐事件"
    assert not outcome.degraded, f"工具循环降级收尾（stopped_reason={outcome.stopped_reason}）"
