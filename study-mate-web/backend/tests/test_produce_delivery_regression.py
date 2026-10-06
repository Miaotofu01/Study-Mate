"""产课交付回归：真实事故「讲解角色只核验未写文件 → 判未交付 → 回落单次派工静默」。

事故现场（session 1c3bad7657b7 / subject-def616 / node intro）：
- `produce_lesson arguments={}`，但 ctx 聚焦节点是 intro（progress 学习中）；
- 讲解角色 read 既有 0001-intro.md + run_check 通过后**不写** write_deliver_file；
- `_role_tool_loop` 只认 ctx.state["files"]（零文件）⇒ produce_loop_no_files ⇒ 回落单次派工。

本文件同时锁死四条契约：
1. 省略 node_id 严格取「第一个未产出」，不被 ctx 聚焦节点劫持；显式 node_id 保留；
2. 已存在且**本轮**检查通过的完整合法目标交付可被接受（保守：只认本节点/本角色目标文件）；
3. 未检查 / 检查失败 / 目标缺失 / 其它节点文件 都不能假成功；regenerate 强制重做；
4. 回落单次派工的 role_start 带 execution_mode/fallback_reason/max_seconds，并用
   「备用派工」stage 成对 running/done/fail，绝不由 fallback 成功伪造「交付自检 done」。

全部用临时目录 + mock，不实机、不触真实 data/工作区。
"""
from __future__ import annotations

import asyncio
import json

import pytest

from app.tools import ToolContext


# ---------- 公共夹具 ----------


def _seed(cs, slug: str, ids: list[str]) -> None:
    cs.save_curriculum(
        slug,
        {
            "nodes": [
                {"id": nid, "title": f"课 {nid}", "kind": "概念", "objective": "目标"}
                for nid in ids
            ],
            "edges": [],
        },
    )


def _events():
    bucket: list[dict] = []

    async def emit(event: dict) -> None:
        bucket.append(event)

    return bucket, emit


def _drive(monkeypatch, actions):
    """把 agent.run_agent 换成按 actions 顺序执行工具的角色驱动（无真实模型）。"""
    from app import agent as agent_svc
    from app import tools as tools_svc

    async def fake_run_agent(turn_source, messages, ctx, emit, tool_schemas, **kwargs):
        index = 0
        for name, args in actions:
            index += 1
            result = await tools_svc.execute(name, args, ctx)
            await emit({"type": "tool_call", "name": name, "id": f"c{index}", "arguments": "{}"})
            await emit(
                {
                    "type": "tool_result",
                    "name": name,
                    "id": f"c{index}",
                    "is_error": bool(result.get("is_error")),
                    "content": str(result.get("content") or ""),
                }
            )
        return agent_svc.AgentOutcome(text="交付汇报", rounds=1, tool_calls=index)

    monkeypatch.setattr(agent_svc, "run_agent", fake_run_agent)


def _content(title: str = "课") -> str:
    return f"---\ntitle: {title}\ngoal: 说出要点\n---\n\n## 一节\n\n正文。\n"


def _run_loop(tmp_path, monkeypatch, *, route="produce_content", node="intro", index=1,
              required=("lessons/0001-intro.md",), regenerate=False, actions=None):
    from app import produce

    base = tmp_path / "subject"
    (base / "lessons").mkdir(parents=True, exist_ok=True)
    (base / "lessons" / f"{index:04d}-{node}.md").write_text(_content(), encoding="utf-8")
    stage_dir = base / ".stage" / "case"
    events, emit = _events()
    _drive(monkeypatch, actions if actions is not None else [("run_check", {})])
    envelope = asyncio.run(
        produce._role_tool_loop(
            {"model": "mock"},
            route,
            "派工值",
            emit,
            base=base,
            node_id=node,
            index=index,
            stage_dir=stage_dir,
            required=required,
            regenerate=regenerate,
        )
    )
    return base, envelope, events


def _patch_check(monkeypatch, ok=True):
    from app import produce

    async def fake_render_and_check(base, node_id, index, emit):
        return (True, []) if ok else (False, [{"path": "lessons/x.html", "message": "坏", "owner": "总控"}])

    monkeypatch.setattr(produce, "render_and_check", fake_render_and_check)


# ---------- 契约 2：已存在 + 本轮检查通过 ⇒ 接受 ----------


def test_existing_artifact_with_passing_check_is_accepted(tmp_path, monkeypatch):
    _patch_check(monkeypatch, ok=True)
    base, envelope, events = _run_loop(tmp_path, monkeypatch)

    assert envelope is not None, "既有交付 + 本轮 run_check 通过 应被接受，不应回落"
    assert [f["path"] for f in envelope["files"]] == ["lessons/0001-intro.md"]
    assert envelope["files"][0]["content"].startswith("---")
    role_ends = [e for e in events if e.get("event") == "role_end"]
    assert role_ends and role_ends[-1]["status"] == "done"
    assert "检查通过" in str(role_ends[-1].get("message") or "")
    # 没有回落信号（不得再出现「未交付」）
    assert not [e for e in events if e.get("event") == "produce_loop_no_files"]


# ---------- 契约 3：不能假成功 ----------


def test_existing_artifact_without_this_round_check_is_rejected(tmp_path, monkeypatch):
    _patch_check(monkeypatch, ok=True)
    # 只读，不 run_check
    _base, envelope, events = _run_loop(tmp_path, monkeypatch, actions=[("list_workspace", {})])
    assert envelope is None
    role_ends = [e for e in events if e.get("event") == "role_end"]
    assert role_ends and role_ends[-1]["status"] == "error"


def test_existing_artifact_with_failing_check_is_rejected(tmp_path, monkeypatch):
    _patch_check(monkeypatch, ok=False)
    _base, envelope, _events_list = _run_loop(tmp_path, monkeypatch, actions=[("run_check", {})])
    assert envelope is None


def test_other_node_or_role_target_cannot_be_accepted(tmp_path, monkeypatch):
    # 目标 intro 的 .md 不存在，只有隔壁节点的文件；即便 run_check 报通过也不能接受
    from app import produce

    base = tmp_path / "subject"
    (base / "lessons").mkdir(parents=True, exist_ok=True)
    (base / "lessons" / "0002-html-elements.md").write_text(_content(), encoding="utf-8")
    _patch_check(monkeypatch, ok=True)
    events, emit = _events()
    _drive(monkeypatch, [("run_check", {})])
    envelope = asyncio.run(
        produce._role_tool_loop(
            {"model": "mock"}, "produce_content", "值", emit,
            base=base, node_id="intro", index=1, stage_dir=base / ".stage" / "case",
            required=("lessons/0001-intro.md",),
        )
    )
    assert envelope is None


def test_regenerate_forces_write_not_old_artifact(tmp_path, monkeypatch):
    _patch_check(monkeypatch, ok=True)
    # regenerate=True 且本轮没写：旧产物不能冒充
    _base, envelope, _ev = _run_loop(
        tmp_path, monkeypatch, regenerate=True, actions=[("run_check", {})]
    )
    assert envelope is None

    # regenerate=True 且真的写了新交付：应通过
    _base2, envelope2, _ev2 = _run_loop(
        tmp_path, monkeypatch, regenerate=True,
        actions=[
            ("write_deliver_file", {"path": "lessons/0001-intro.md", "content": _content("重做")}),
            ("run_check", {}),
        ],
    )
    assert envelope2 is not None
    assert envelope2["files"][0]["content"].startswith("---")


# ---------- 契约 1：node_id 选择 ----------


def test_omitted_node_id_picks_first_unproduced_not_ctx_focus(client, monkeypatch, new_subject, cs):
    from app import produce
    from app import tools as tools_svc

    slug, base = new_subject
    _seed(cs, slug, ["intro", "html-elements"])
    (base / "lessons").mkdir(exist_ok=True)
    (base / "lessons" / "0001-intro.md").write_text(_content(), encoding="utf-8")

    captured: dict = {}

    async def fake_run_produce(base_arg, slug_arg, node_id_arg, provider_arg, emit_arg, **kwargs):
        captured["node"] = node_id_arg
        await emit_arg({"event": "done", "node_id": node_id_arg, "artifacts": []})

    monkeypatch.setattr(produce, "run_produce", fake_run_produce)
    events, emit = _events()
    ctx = ToolContext(
        read_roots=[base], write_roots=[], label="科目",
        state={"slug": slug, "node_id": "intro", "emit": emit, "tool_call_id": "c1"},
    )
    asyncio.run(tools_svc.execute("produce_lesson", {}, ctx))
    assert captured.get("node") == "html-elements", "省略 node_id 必须取第一个未产出，不能取 ctx 聚焦节点"


def test_explicit_node_id_is_preserved(client, monkeypatch, new_subject, cs):
    from app import produce
    from app import tools as tools_svc

    slug, base = new_subject
    _seed(cs, slug, ["intro", "html-elements"])
    (base / "lessons").mkdir(exist_ok=True)
    (base / "lessons" / "0001-intro.md").write_text(_content(), encoding="utf-8")

    captured: dict = {}

    async def fake_run_produce(base_arg, slug_arg, node_id_arg, provider_arg, emit_arg, **kwargs):
        captured["node"] = node_id_arg
        await emit_arg({"event": "done", "node_id": node_id_arg, "artifacts": []})

    monkeypatch.setattr(produce, "run_produce", fake_run_produce)
    _events_list, emit = _events()
    ctx = ToolContext(
        read_roots=[base], write_roots=[], label="科目",
        state={"slug": slug, "node_id": "html-elements", "emit": emit, "tool_call_id": "c1"},
    )
    asyncio.run(tools_svc.execute("produce_lesson", {"node_id": "intro"}, ctx))
    assert captured.get("node") == "intro"


def test_all_nodes_produced_reports_no_pending(client, monkeypatch, new_subject, cs):
    from app import tools as tools_svc

    slug, base = new_subject
    _seed(cs, slug, ["intro", "html-elements"])
    (base / "lessons").mkdir(exist_ok=True)
    (base / "lessons" / "0001-intro.md").write_text(_content(), encoding="utf-8")
    (base / "lessons" / "0002-html-elements.md").write_text(_content(), encoding="utf-8")

    _events_list, emit = _events()
    ctx = ToolContext(
        read_roots=[base], write_roots=[], label="科目",
        state={"slug": slug, "node_id": "intro", "emit": emit, "tool_call_id": "c1"},
    )
    result = asyncio.run(tools_svc.execute("produce_lesson", {}, ctx))
    assert result["is_error"] is False
    assert "已产出" in result["content"] and "没有待产节点" in result["content"]


# ---------- 契约 4：回落单次派工事件契约 ----------


def _fallback_setup(tmp_path, monkeypatch, dispatch_role):
    from app import llm, produce, roles

    base = tmp_path / "subject"
    (base / "lessons").mkdir(parents=True, exist_ok=True)
    (base / "lessons" / "0001-intro.md").write_text(_content(), encoding="utf-8")
    monkeypatch.setattr(llm, "is_fixture_mode", lambda: False)
    monkeypatch.setattr(llm, "supports_tools", lambda provider: True)

    async def no_loop(*args, **kwargs):
        return None

    monkeypatch.setattr(produce, "_role_tool_loop", no_loop)
    monkeypatch.setattr(roles, "dispatch_role", dispatch_role)
    return base


def test_fallback_success_emits_metadata_and_paired_stage_never_fake_check(tmp_path, monkeypatch):
    from app import agent as agent_svc
    from app import produce

    async def ok_dispatch(provider, route, values, fixture_kind=None):
        return {"files": [{"path": "lessons/0001-intro.md", "content": _content()}], "report": {}}

    base = _fallback_setup(tmp_path, monkeypatch, ok_dispatch)
    events, emit = _events()
    envelope = asyncio.run(
        produce.dispatch(
            {"model": "mock"}, "produce_content", "值", lambda v: {}, emit,
            base=base, node_id="intro", index=1, stage_dir=base / ".stage" / "case",
        )
    )
    assert envelope is not None and envelope["files"]

    starts = [e for e in events if e.get("event") == "role_start"]
    assert starts, "回落必须发 role_start"
    assert starts[-1]["execution_mode"] == "fallback"
    assert starts[-1]["fallback_reason"]
    assert starts[-1]["max_seconds"] == agent_svc.ORCH_MAX_SECONDS

    stages = [e for e in events if e.get("event") == "stage"]
    assert any(s["stage"] == "备用派工" and s["status"] == "start" for s in stages)
    assert any(s["stage"] == "备用派工" and s["status"] == "done" for s in stages)
    # 单次 envelope 交付 ≠ 检查通过：不得伪造「交付自检 done」
    assert not any(s["stage"] == "交付自检" and s["status"] == "done" for s in stages)


def test_fallback_contract_failure_marks_stage_error_and_error_event(tmp_path, monkeypatch):
    from app import produce

    async def bad_dispatch(provider, route, values, fixture_kind=None):
        raise ValueError("回复不是规定的 JSON envelope")

    base = _fallback_setup(tmp_path, monkeypatch, bad_dispatch)
    events, emit = _events()
    envelope = asyncio.run(
        produce.dispatch(
            {"model": "mock"}, "produce_content", "值", lambda v: {}, emit,
            base=base, node_id="intro", index=1, stage_dir=base / ".stage" / "case",
        )
    )
    assert envelope is None
    stages = [e for e in events if e.get("event") == "stage"]
    assert any(s["stage"] == "备用派工" and s["status"] == "fail" for s in stages)
    errors = [e for e in events if e.get("event") == "error"]
    assert errors and "连续" in errors[-1]["message"]


# ---------- review 补修：required 一致 gate / regenerate 校验 / 解码 / fallback 标记 / timeout ----------


def test_all_roles_require_target_artifact_for_quiz(tmp_path):
    """quiz 的 _write_and_promote 必须 gate 目标产物，且不 promote 杂散文件。"""
    from app import produce

    base = tmp_path / "subject"
    (base / "lessons").mkdir(parents=True, exist_ok=True)
    stage = base / ".stage" / "s"
    env = {"files": [{"path": "lessons/9999-other.md", "content": "x"}], "report": {}}
    moved = asyncio.run(
        produce._write_and_promote(
            stage, base, env, required=produce.required_artifacts("produce_quiz", 1, "intro")
        )
    )
    assert moved is None
    assert not (base / "lessons" / "9999-other.md").exists()


def test_required_artifacts_per_route():
    from app import produce

    assert produce.required_artifacts("produce_content", 3, "x") == ("lessons/0003-x.md",)
    assert produce.required_artifacts("produce_experiment", 3, "x") == ("lessons/0003-x.md",)
    assert produce.required_artifacts("produce_quiz", 3, "x") == ("lessons/0003-x.quiz.json",)


def test_read_existing_delivery_rejects_non_utf8(tmp_path):
    from app import produce

    base = tmp_path / "subject"
    (base / "lessons").mkdir(parents=True, exist_ok=True)
    (base / "lessons" / "0001-intro.md").write_bytes(b"\xff\xfe\x00\x01bad")
    assert produce._read_existing_delivery(base, ("lessons/0001-intro.md",)) is None


@pytest.mark.parametrize("bad", ["false", 1, 0, [], {}])
def test_regenerate_non_bool_rejected(client, monkeypatch, new_subject, cs, bad):
    from app import produce
    from app import tools as tools_svc

    slug, base = new_subject
    _seed(cs, slug, ["intro"])
    called = {"n": 0}

    async def fake_run_produce(*args, **kwargs):
        called["n"] += 1

    monkeypatch.setattr(produce, "run_produce", fake_run_produce)
    _ev, emit = _events()
    ctx = ToolContext(
        read_roots=[base], write_roots=[], label="科目", state={"slug": slug, "emit": emit}
    )
    result = asyncio.run(
        tools_svc.execute("produce_lesson", {"node_id": "intro", "regenerate": bad}, ctx)
    )
    assert result["is_error"] is True and "布尔" in result["content"]
    assert called["n"] == 0


def test_regenerate_true_requires_explicit_node(client, monkeypatch, new_subject, cs):
    from app import produce
    from app import tools as tools_svc

    slug, base = new_subject
    _seed(cs, slug, ["intro"])
    called = {"n": 0}

    async def fake_run_produce(*args, **kwargs):
        called["n"] += 1

    monkeypatch.setattr(produce, "run_produce", fake_run_produce)
    _ev, emit = _events()
    ctx = ToolContext(
        read_roots=[base], write_roots=[], label="科目", state={"slug": slug, "emit": emit}
    )
    result = asyncio.run(tools_svc.execute("produce_lesson", {"regenerate": True}, ctx))
    assert result["is_error"] is True and "node_id" in result["content"]
    assert called["n"] == 0


def test_regenerate_marker_passed_to_single_call_fallback(tmp_path, monkeypatch):
    from app import produce

    captured: dict = {}

    async def capture_dispatch(provider, route, values, fixture_kind=None):
        captured["values"] = values
        return {"files": [{"path": "lessons/0001-intro.md", "content": "x"}], "report": {}}

    base = _fallback_setup(tmp_path, monkeypatch, capture_dispatch)
    _ev, emit = _events()
    asyncio.run(
        produce.dispatch(
            {"model": "mock"}, "produce_content", "原值", lambda v: {}, emit,
            base=base, node_id="intro", index=1, stage_dir=base / ".stage" / "case",
            regenerate=True,
        )
    )
    assert produce.FORCED_REDO_NOTE.strip() in captured["values"]


def test_role_timeout_finalizes_task_timeout(client, monkeypatch, new_subject, cs):
    """真实 dispatch 抛 LLMDeadlineExceeded：贯穿 _tool_produce_lesson → 任务终态 timeout。"""
    from app import llm
    from app import produce
    from app import roles
    from app import tools as tools_svc

    slug, base = new_subject
    _seed(cs, slug, ["intro"])

    monkeypatch.setattr(llm, "is_fixture_mode", lambda: False)
    monkeypatch.setattr(llm, "supports_tools", lambda provider: True)

    async def no_loop(*args, **kwargs):
        return None

    monkeypatch.setattr(produce, "_role_tool_loop", no_loop)

    async def timeout_dispatch(provider, route, values, fixture_kind=None):
        raise llm.LLMDeadlineExceeded("单次调用超过 1800s 总时限")

    monkeypatch.setattr(roles, "dispatch_role", timeout_dispatch)

    async def fake_run_produce(base_arg, slug_arg, node_id_arg, provider_arg, emit_arg, **kwargs):
        await produce.dispatch(
            provider_arg, "produce_content", "值", lambda v: {}, emit_arg,
            base=base_arg, node_id=node_id_arg, index=1, stage_dir=base_arg / ".stage" / "t",
        )

    monkeypatch.setattr(produce, "run_produce", fake_run_produce)

    events, emit = _events()
    ctx = ToolContext(
        read_roots=[base], write_roots=[], label="科目",
        state={"slug": slug, "emit": emit, "tool_call_id": "c1"},
    )
    result = asyncio.run(tools_svc.execute("produce_lesson", {"node_id": "intro"}, ctx))

    assert result["is_error"] is True
    # 任务真正 finalize 为 timeout（不是 error）
    assert result["task"]["status"] == "timeout"
    assert "超时" in (result["task"].get("error") or "")


def test_dispatch_timeout_emits_machine_readable_error_code(tmp_path, monkeypatch):
    """timeout 的 error 事件带 code/type（供编排方判定，不做字符串匹配），且只发一次不重试。"""
    from app import llm
    from app import produce
    from app import roles

    async def timeout_dispatch(provider, route, values, fixture_kind=None):
        raise llm.LLMDeadlineExceeded("单次调用超过 1800s 总时限")

    base = _fallback_setup(tmp_path, monkeypatch, timeout_dispatch)
    events, emit = _events()
    envelope = asyncio.run(
        produce.dispatch(
            {"model": "mock"}, "produce_content", "值", lambda v: {}, emit,
            base=base, node_id="intro", index=1, stage_dir=base / ".stage" / "case",
        )
    )
    assert envelope is None
    errs = [e for e in events if e.get("event") == "error"]
    assert len(errs) == 1
    assert errs[0].get("code") == "role_timeout" and errs[0].get("type") == "timeout"
    role_ends = [e for e in events if e.get("event") == "role_end" and e.get("status") == "timeout"]
    assert role_ends, "超时 role_end 必须用 status=timeout（不是 error）"
    stages = [e for e in events if e.get("event") == "stage"]
    assert any(s["stage"] == "备用派工" and s["status"] == "fail" for s in stages)


def test_ticket_retry_missing_target_parks_not_false_resolved(client, monkeypatch, new_subject, cs):
    """工单重派若没有合法目标产物，不得 promote 杂散文件，也不得假「已解决」。"""
    from app import produce
    from app import tickets as tickets_svc

    slug, base = new_subject
    _seed(cs, slug, ["intro"])
    (base / "lessons").mkdir(exist_ok=True)
    (base / "lessons" / "0001-intro.md").write_text(_content(), encoding="utf-8")

    async def wrong_dispatch(provider, route, values, factory, emit, **kwargs):
        return {"files": [{"path": "lessons/9999-wrong.md", "content": "x"}], "report": {}}

    monkeypatch.setattr(produce, "dispatch", wrong_dispatch)

    ticket = tickets_svc.create_ticket(
        kind="produce",
        slug=slug,
        node_id="intro",
        base_label="workspace",
        problems=[
            {"owner": "出题", "path": "lessons/0001-intro.quiz.json", "line": "", "message": "示例"}
        ],
        artifacts=["lessons/0001-intro.quiz.json"],
        workspace=str(cs.workspace_dir()),
    )
    events, emit = _events()
    asyncio.run(produce.run_ticket_retry(ticket["id"], {"model": "mock"}, emit))

    assert tickets_svc.get_ticket(ticket["id"])["status"] == "待处理"
    assert not (base / "lessons" / "9999-wrong.md").exists()

