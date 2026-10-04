"""K0 工具化基建测试：wire 映射 / 流式聚合 / agent loop / 沙箱 / 审计 / fixture 工具卡。"""
from __future__ import annotations

import asyncio
import json

import pytest

from app import audit
from app.tools import ToolContext


# ---------- wire 映射（三格式） ----------


def test_accumulator_assigns_id_and_appends_arguments():
    from app.llm import ToolCallAccumulator

    acc = ToolCallAccumulator()
    acc.push(0, id="call-1", name="read_course_file", arguments_delta='{"path":')
    acc.push(0, id="call-1", name="read_course_file", arguments_delta='"MISSION.md"}')
    # id/name 重复发时赋值不追加（网关重复发 id 曾涨到几万字符）
    acc.push(0, id="call-1", name="")
    calls = acc.finalize()
    assert calls == [
        {"id": "call-1", "name": "read_course_file", "arguments": '{"path":"MISSION.md"}'}
    ]


def test_accumulator_arguments_full_is_authoritative():
    from app.llm import ToolCallAccumulator

    acc = ToolCallAccumulator()
    acc.push(1, name="t", arguments_delta='{"a":')
    acc.push(1, arguments_full='{"a":1}')
    assert acc.finalize()[0]["arguments"] == '{"a":1}'


def test_openai_wire_messages_maps_tool_calls_and_results():
    from app.llm import _openai_wire_messages

    wire = _openai_wire_messages(
        [
            {"role": "user", "content": "q"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "c1", "name": "list_workspace", "arguments": "{}"}],
            },
            {"role": "tool", "tool_call_id": "c1", "name": "list_workspace", "content": "ok"},
        ]
    )
    assistant = wire[1]
    assert assistant["content"] is None
    assert assistant["tool_calls"][0]["function"]["name"] == "list_workspace"
    assert assistant["tool_calls"][0]["id"] == "c1"
    assert wire[2] == {"role": "tool", "tool_call_id": "c1", "content": "ok"}


def test_anthropic_payload_maps_tools_and_merges_results():
    from app.llm import _anthropic_payload

    payload = _anthropic_payload(
        {"model": "m", "api_format": "anthropic"},
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "q"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "c1", "name": "read_course_file", "arguments": '{"path":"M.md"}'}],
            },
            {"role": "tool", "tool_call_id": "c1", "name": "read_course_file", "content": "body", "is_error": False},
            {"role": "tool", "tool_call_id": "c1b", "name": "x", "content": "bad", "is_error": True},
        ],
        False,
        tools=[{"name": "read_course_file", "description": "d", "parameters": {"type": "object"}}],
    )
    assert payload["tools"][0]["input_schema"] == {"type": "object"}
    assert payload["tool_choice"] == {"type": "auto"}
    assistant = next(m for m in payload["messages"] if m["role"] == "assistant")
    assert assistant["content"][0]["type"] == "tool_use"
    assert assistant["content"][0]["input"] == {"path": "M.md"}
    # 连续两条 tool 结果合并为一条 user 消息（协议要求 tool_result 成组在最前）
    result_msgs = [
        m
        for m in payload["messages"]
        if m["role"] == "user" and isinstance(m["content"], list) and m["content"] and m["content"][0].get("type") == "tool_result"
    ]
    assert len(result_msgs) == 1
    assert [b["tool_use_id"] for b in result_msgs[0]["content"]] == ["c1", "c1b"]
    assert result_msgs[0]["content"][1]["is_error"] is True


def test_responses_payload_maps_tools_and_function_call_items():
    from app.llm import _responses_payload

    payload = _responses_payload(
        {"model": "m", "api_format": "openai_responses"},
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "q"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "name": "list_workspace", "arguments": "{}"}]},
            {"role": "tool", "tool_call_id": "c1", "name": "list_workspace", "content": "ok"},
        ],
        json_mode=False,
        stream=True,
        tools=[{"name": "list_workspace", "description": "d", "parameters": {"type": "object"}}],
    )
    assert payload["tools"][0]["type"] == "function"
    assert payload["tool_choice"] == "auto"
    kinds = [item.get("type") for item in payload["input"]]
    assert "function_call" in kinds and "function_call_output" in kinds


def test_supports_tools_defaults_on_for_all_models():
    """工具调用默认对所有配置的模型开启（2026-10-04）——不再依赖能力声明。"""
    from app.llm import supports_tools

    assert supports_tools({"capabilities": {"tool_call": True}}) is True
    assert supports_tools({"capabilities": {"tool_call": False}}) is True
    assert supports_tools({"capabilities": None}) is True
    assert supports_tools({"model": "any"}) is True
    assert supports_tools(None) is False


# ---------- 沙箱边界 ----------


def test_sandbox_rejects_escape_and_reads_within(tmp_path):
    from app import tools as tools_svc

    root = tmp_path / "subject"
    root.mkdir()
    (root / "MISSION.md").write_text("使命正文", encoding="utf-8")
    ctx = ToolContext(read_roots=[root], write_roots=[], label="测试科目")

    result = asyncio.run(tools_svc.execute("read_course_file", {"path": "MISSION.md"}, ctx))
    assert result["is_error"] is False and "使命正文" in result["content"]

    escaped = asyncio.run(tools_svc.execute("read_course_file", {"path": "../../secret.md"}, ctx))
    assert escaped["is_error"] is True
    assert "sandbox: file access denied" in escaped["content"]

    absolute = asyncio.run(tools_svc.execute("read_course_file", {"path": "C:\\Windows\\win.ini"}, ctx))
    assert absolute["is_error"] is True

    listing = asyncio.run(tools_svc.execute("list_workspace", {}, ctx))
    assert listing["is_error"] is False and "MISSION.md" in listing["content"]


def test_read_skill_reads_repo_skills():
    from app import tools as tools_svc

    ctx = ToolContext(read_roots=[], write_roots=[], label="工作区")
    result = asyncio.run(tools_svc.execute("read_skill", {"name": "local-qa"}, ctx))
    assert result["is_error"] is False
    bad = asyncio.run(tools_svc.execute("read_skill", {"name": "../etc"}, ctx))
    assert bad["is_error"] is True


def test_unknown_tool_and_bad_json_return_error_not_raise():
    from app import tools as tools_svc

    ctx = ToolContext(read_roots=[], write_roots=[], label="x")
    assert asyncio.run(tools_svc.execute("nope", {}, ctx))["is_error"] is True
    assert asyncio.run(tools_svc.execute("list_workspace", "{not json", ctx))["is_error"] is True


# ---------- agent loop ----------


def _run(coro):
    return asyncio.run(coro)


def test_agent_forces_text_after_budget():
    from app import agent

    async def source(messages, tools):
        if tools:
            yield {"type": "tool_calls", "tool_calls": [{"id": "x", "name": "nope", "arguments": "{}"}]}
        else:
            yield {"type": "text", "content": "最终答复"}

    events: list[dict] = []

    async def emit(event):
        events.append(event)

    ctx = ToolContext(read_roots=[], write_roots=[], label="x")
    outcome = _run(
        agent.run_agent(
            source,
            [{"role": "user", "content": "q"}],
            ctx,
            emit,
            [{"name": "nope", "description": "", "parameters": {}}],
            budget=agent.AgentBudget(explore_rounds=1, wrapup_rounds=1, forced_rounds=1),
        )
    )
    assert outcome.text == "最终答复"
    assert outcome.degraded is False
    assert outcome.rounds == 3
    names = [e["type"] for e in events]
    assert "tool_call" in names and "tool_result" in names
    # 工具失败转 is_error 文本，循环不炸
    failed = [e for e in events if e["type"] == "tool_result"]
    assert failed and failed[0]["is_error"] is True


def test_agent_idle_rescue_then_answer():
    from app import agent

    state = {"n": 0}

    async def source(messages, tools):
        state["n"] += 1
        if state["n"] == 1:
            return
        yield {"type": "text", "content": "补上的答复"}

    async def emit(event):
        return None

    ctx = ToolContext(read_roots=[], write_roots=[], label="x")
    outcome = _run(agent.run_agent(source, [{"role": "user", "content": "q"}], ctx, emit, []))
    assert outcome.text == "补上的答复"
    assert outcome.rounds == 2


def test_agent_exhausts_budget_marks_degraded():
    from app import agent

    async def source(messages, tools):
        # 即使 tools 被停用仍继续发起调用（模拟不听话的上游），逼出预算耗尽安全网
        yield {"type": "tool_calls", "tool_calls": [{"id": "x", "name": "nope", "arguments": "{}"}]}

    async def emit(event):
        return None

    ctx = ToolContext(read_roots=[], write_roots=[], label="x")
    outcome = _run(
        agent.run_agent(
            source,
            [{"role": "user", "content": "q"}],
            ctx,
            emit,
            [{"name": "nope", "description": "", "parameters": {}}],
            budget=agent.AgentBudget(explore_rounds=2, wrapup_rounds=1, forced_rounds=1),
        )
    )
    assert outcome.degraded is True
    assert outcome.stopped_reason == "budget"
    assert outcome.rounds == 4


# ---------- 审计 ----------


def test_audit_dispatch_retained_on_contract_failure(monkeypatch):
    from app import llm, roles

    monkeypatch.setattr(llm, "is_fixture_mode", lambda: False)

    async def bad_chat(provider, messages, json_mode=False, fixture_kind=None):
        return '{oops not json'

    monkeypatch.setattr(roles, "chat_once", bad_chat)
    audit.bind("test-audit-retain")
    with pytest.raises(ValueError):
        _run(roles.dispatch_role({"model": "m"}, "chat", "派工值正文"))
    log = audit.AUDIT_DIR / "test-audit-retain.jsonl"
    assert log.is_file()
    text = log.read_text(encoding="utf-8")
    # 派工值与原始回复都落盘——失败也不清除（修 10-03"堵点无文件证据"缺口）
    assert "派工值正文" in text
    assert "dispatch_reply" in text
    assert "oops" in text


def test_audit_redacts_sensitive_keys(tmp_path):
    log = audit.AuditLog("redact-test")
    log.append({"event": "x", "api_key": "secret", "note": "ok"})
    text = log.path.read_text(encoding="utf-8")
    assert "secret" not in text
    assert "***" in text


# ---------- 建课链 envelope 兜底（K2 硬停 bug 修复） ----------


def test_build_dispatch_retries_contract_failure(monkeypatch):
    from app import build, llm, roles

    monkeypatch.setattr(llm, "is_fixture_mode", lambda: False)
    calls = {"n": 0}

    async def flaky(provider, route, values, fixture_kind=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError("上游回复不是规定的 JSON envelope")
        return {"files": [], "data": {"nodes": [], "edges": []}, "report": {}}

    monkeypatch.setattr(roles, "dispatch_role", flaky)
    events: list[dict] = []

    async def emit(event):
        events.append(event)

    env = _run(build._dispatch_curriculum({"model": "m"}, "值", emit))
    assert env is not None
    assert calls["n"] == 2
    assert events and events[0]["event"] == "retry"


def test_build_dispatch_exhausts_contract_failures(monkeypatch):
    from app import build, llm, roles

    monkeypatch.setattr(llm, "is_fixture_mode", lambda: False)

    async def always_bad(provider, route, values, fixture_kind=None):
        raise ValueError("envelope 畸形")

    monkeypatch.setattr(roles, "dispatch_role", always_bad)
    events: list[dict] = []

    async def emit(event):
        events.append(event)

    assert _run(build._dispatch_curriculum({"model": "m"}, "值", emit)) is None
    assert [e["event"] for e in events].count("retry") == build.MAX_RETRIES
    assert events[-1]["event"] == "error"


# ---------- fixture 工具卡（chat SSE） ----------


def test_chat_fixture_tools_emits_tool_events(client):
    r = client.post(
        "/api/chat/stream",
        json={"message": "帮我看看工作区", "fixture_scenario": "tools"},
    )
    names = []
    current = None
    datas = []
    for line in r.text.splitlines():
        if line.startswith("event: "):
            current = line[7:]
        elif line.startswith("data: ") and current is not None:
            names.append(current)
            datas.append((current, json.loads(line[6:])))
            current = None
    assert "tool_call" in names
    assert "tool_result" in names
    assert "delta" in names and "done" in names
    call = next(d for name, d in datas if name == "tool_call")
    assert call["name"] in {"list_workspace", "read_course_file"}
    result = next(d for name, d in datas if name == "tool_result")
    assert "content" in result


# ---------- K2/K3：生产角色工具循环 ----------


def _collector():
    events: list[dict] = []

    async def emit(event):
        events.append(event)

    return events, emit


def test_submit_curriculum_tool_accepts_valid_and_state_saved():
    from app import tools as tools_svc
    from app.llm import FIXTURE_CURRICULUM

    ctx = ToolContext(read_roots=[], write_roots=[], label="x", state={})
    result = asyncio.run(tools_svc.execute("submit_curriculum", {"data": FIXTURE_CURRICULUM}, ctx))
    assert result["is_error"] is False
    assert ctx.state["curriculum"]["nodes"]


def test_submit_curriculum_tool_reports_gate_errors():
    from app import tools as tools_svc

    bad = {"nodes": [{"id": "a", "title": "A"}], "edges": [{"from": "a", "to": "ghost"}]}
    ctx = ToolContext(read_roots=[], write_roots=[], label="x", state={})
    result = asyncio.run(tools_svc.execute("submit_curriculum", {"data": bad}, ctx))
    assert result["is_error"] is True
    assert "门禁未过" in result["content"]
    assert "curriculum" not in ctx.state


def test_write_deliver_file_stages_and_records(tmp_path):
    from app import tools as tools_svc

    stage = tmp_path / "stage"
    ctx = ToolContext(read_roots=[], write_roots=[], label="x", state={"stage_dir": str(stage)})
    ok = asyncio.run(
        tools_svc.execute(
            "write_deliver_file",
            {"path": "lessons/0001-a.md", "content": "正文"},
            ctx,
        )
    )
    assert ok["is_error"] is False
    assert (stage / "deliver" / "lessons" / "0001-a.md").read_text(encoding="utf-8") == "正文"
    assert ctx.state["files"][0]["path"] == "lessons/0001-a.md"
    escape = asyncio.run(tools_svc.execute("write_deliver_file", {"path": "../x.md", "content": "x"}, ctx))
    assert escape["is_error"] is True


def test_curriculum_tool_loop_self_fixes_then_returns(monkeypatch, tmp_path):
    from app import agent, build
    from app.llm import FIXTURE_CURRICULUM

    rounds = {"n": 0}

    def fake_source(provider, fixture_scenario=None):
        async def source(messages, tools):
            rounds["n"] += 1
            if rounds["n"] == 1:
                bad = {"nodes": [{"id": "a", "title": "A"}], "edges": [{"from": "a", "to": "ghost"}]}
                yield {"type": "tool_calls", "tool_calls": [{"id": "c1", "name": "submit_curriculum", "arguments": json.dumps({"data": bad})}]}
            elif rounds["n"] == 2:
                yield {"type": "tool_calls", "tool_calls": [{"id": "c2", "name": "submit_curriculum", "arguments": json.dumps({"data": FIXTURE_CURRICULUM})}]}
            else:
                yield {"type": "text", "content": "大纲设计说明"}

        return source

    monkeypatch.setattr(agent, "real_turn_source", fake_source)
    events, emit = _collector()
    data = asyncio.run(
        build._curriculum_tool_loop(
            "slug", tmp_path, "派工值", {"model": "m", "capabilities": {"tool_call": True}}, emit
        )
    )
    assert data and data["nodes"]
    assert rounds["n"] == 3
    # 第一次提交被门禁打回、第二次通过（循环内自修）
    gate_events = [e for e in events if e.get("stage") == "门禁"]
    assert any(e.get("status") == "fail" for e in gate_events)
    assert any(e.get("status") == "done" for e in gate_events)


def test_produce_role_tool_loop_returns_files_envelope(monkeypatch, tmp_path):
    from app import agent, produce

    def fake_source(provider, fixture_scenario=None):
        async def source(messages, tools):
            if not getattr(source, "_sent", False):
                source._sent = True
                yield {
                    "type": "tool_calls",
                    "tool_calls": [
                        {
                            "id": "c1",
                            "name": "write_deliver_file",
                            "arguments": json.dumps(
                                {"path": "lessons/0001-demo.intro.md", "content": "---\ntitle: t\n---\n\n正文"}
                            ),
                        }
                    ],
                }
            else:
                yield {"type": "text", "content": "交付完成"}

        return source

    monkeypatch.setattr(agent, "real_turn_source", fake_source)
    stage = tmp_path / "stage"
    base = tmp_path / "base"
    base.mkdir()
    events, emit = _collector()
    env = asyncio.run(
        produce._role_tool_loop(
            {"model": "m", "capabilities": {"tool_call": True}},
            "produce_content",
            "派工值",
            emit,
            base=base,
            node_id="demo.intro",
            index=1,
            stage_dir=stage,
        )
    )
    assert env is not None
    assert env["files"][0]["path"] == "lessons/0001-demo.intro.md"



# ---------- 墙钟上限与进度快照（2026-10-04：防"永久卡住" + 让"在干活"看得见） ----------


def test_agent_wallclock_stops_a_hanging_turn():
    """单轮一直不返回时，必须被墙钟砍掉而不是无限等（实测曾有会话静默 9507s）。"""
    import time

    from app import agent

    async def hanging_source(messages, tools):
        while True:
            await asyncio.sleep(0.2)
            yield {"type": "reasoning", "content": "还在想"}

    ctx = ToolContext(read_roots=[], write_roots=[], label="x")
    events, emit = _collector()
    started = time.monotonic()
    outcome = _run(
        agent.run_agent(
            hanging_source,
            [{"role": "user", "content": "问"}],
            ctx,
            emit,
            [],
            max_seconds=0.4,
        )
    )
    elapsed = time.monotonic() - started

    assert outcome.degraded is True
    assert outcome.stopped_reason == "wallclock"
    assert elapsed < 3, f"应该被 0.4s 的墙钟砍掉，实际等了 {elapsed:.1f}s"
    notices = [e for e in events if e["type"] == "notice"]
    assert any("上限" in str(e.get("message")) for e in notices), notices


def test_agent_reports_progress_snapshots():
    """进度快照：先发一帧（按钮按下马上有反馈），过程中按间隔续发。"""
    from app import agent

    async def source(messages, tools):
        yield {"type": "reasoning", "content": "思考" * 5}
        await asyncio.sleep(0.7)  # 心跳最小间隔 0.5s，得跨过一个周期才会有中途帧
        yield {"type": "tool_calls", "tool_calls": []}
        yield {"type": "text", "content": "答案"}

    shots: list[dict] = []

    async def on_progress(snapshot: dict) -> None:
        shots.append(snapshot)

    ctx = ToolContext(read_roots=[], write_roots=[], label="x")
    events, emit = _collector()
    outcome = _run(
        agent.run_agent(
            source,
            [{"role": "user", "content": "问"}],
            ctx,
            emit,
            [],
            max_seconds=5,
            on_progress=on_progress,
            progress_interval=0.5,
        )
    )

    assert shots, "至少要发一帧进度"
    assert "elapsed_s" in shots[0] and "round" in shots[0]
    # 过程中那一帧应当已经带上"第几轮 + 思考了多少字"
    assert any(s["round"] >= 1 and s["reasoning_chars"] > 0 for s in shots), shots
    assert outcome.text == "答案"


def test_progress_counts_tool_calls_batch():
    """进度快照要数得清整批 tool_calls（turn_source 吐的是复数事件）。

    真机实测：建课大纲 20 次工具调用，进度卡一路报 0（note 只认单数 tool_call）。
    """
    from app import agent

    rounds = {"n": 0}

    async def source(messages, tools):
        rounds["n"] += 1
        if rounds["n"] == 1:
            yield {
                "type": "tool_calls",
                "tool_calls": [
                    {"id": "c1", "name": "list_workspace", "arguments": "{}"},
                    {"id": "c2", "name": "list_workspace", "arguments": "{}"},
                ],
            }
        else:
            await asyncio.sleep(0.8)  # 跨过一个心跳周期才拿得到带计数的中途帧
            yield {"type": "text", "content": "答案"}

    shots: list[dict] = []

    async def on_progress(snapshot: dict) -> None:
        shots.append(snapshot)

    ctx = ToolContext(read_roots=[], write_roots=[], label="x")
    events, emit = _collector()
    outcome = _run(
        agent.run_agent(
            source,
            [{"role": "user", "content": "问"}],
            ctx,
            emit,
            [],
            max_seconds=5,
            on_progress=on_progress,
            progress_interval=0.5,
        )
    )

    assert outcome.tool_calls == 2, outcome
    assert any(s["tool_calls"] == 2 and s["last_tool"] == "list_workspace" for s in shots), shots


def test_progress_reporter_stops_after_exit():
    """外壳退出后不允许再有后台心跳（否则会在编排结束后继续往队列里塞事件）。"""
    from app import agent

    shots: list[dict] = []

    async def on_progress(snapshot: dict) -> None:
        shots.append(snapshot)

    async def main() -> int:
        reporter = agent.ProgressReporter(on_progress, interval=0.5)
        async with reporter:
            await asyncio.sleep(0.7)  # 跨过一个心跳周期
        count = len(shots)
        await asyncio.sleep(0.6)  # 退出后再等一会儿，不该有新帧
        return count

    count = _run(main())
    assert count >= 2  # 进场一帧 + 至少一次定时帧
    assert len(shots) == count, "退出后仍在发心跳"
