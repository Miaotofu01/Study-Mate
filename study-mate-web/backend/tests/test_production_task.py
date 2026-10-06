"""产课父工具任务（ProductionTask）的回归测试。

覆盖：
- reducer：progress 心跳不 append 事件；角色正文/工具活动可回放；重复 tool id 按角色隔离；
  正文限长标截断；重试产生新 stage id；finalize 把 running 角色转 interrupted。
- lesson_link：只有 HTML 真实存在且可读、节点仍在课表里才给入口。
- tools._tool_produce_lesson：emit task_update（id = 父 call id）、成功带 lesson、失败/handoff
  无 lesson、workspace 为解析后的绝对路径、取消终态 interrupted、全产完不建新任务。
- tools._tool_assess_node：成功/失败都带 assessment 载荷。
- build：循环内自检与后端收尾检查用两个可区分的阶段名（大纲自检 / 交付检查）。
- produce._role_tool_loop：run_check 自检标「交付自检」（与 render_and_check 的「检查」区分）。
"""
from __future__ import annotations

import asyncio
import json

import pytest

from app import production_task as pt
from app.tools import ToolContext

FIXTURE = None  # 延迟导入，避免 import 期触盘


def _collector() -> tuple[list[dict], object]:
    events: list[dict] = []

    async def emit(event):
        events.append(event)

    return events, emit


def _task_updates(events: list[dict]) -> list[dict]:
    return [e for e in events if e.get("type") == "task_update"]


# ---------- reducer ----------


def _reducer(**overrides):
    kwargs = {
        "task_id": "call-parent",
        "title": "第一课",
        "subject_slug": "s",
        "node_id": "a.first",
        "workspace": "/ws",
    }
    kwargs.update(overrides)
    return pt.ProductionTaskReducer(**kwargs)


def test_progress_heartbeat_never_appends_events():
    reducer = _reducer()
    for _ in range(100):
        reducer.consume({"event": "progress", "role_id": "r1", "round": 0, "elapsed_s": 5})
    snapshot = reducer.snapshot()
    assert snapshot["events"] == []
    assert snapshot["roles"] == []
    assert snapshot["status"] == "running"


def test_role_text_and_tools_are_replayable():
    reducer = _reducer()
    reducer.consume({"event": "role_start", "role_id": "r1", "role": "讲解", "route": "produce_content"})
    reducer.consume({"event": "role_event", "role_id": "r1", "role": "讲解", "type": "reasoning", "content": "先想"})
    reducer.consume({"event": "role_event", "role_id": "r1", "role": "讲解", "type": "text", "content": "正文"})
    reducer.consume(
        {
            "event": "role_event",
            "role_id": "r1",
            "role": "讲解",
            "type": "tool_call",
            "name": "write_deliver_file",
            "id": "call-1",
            "arguments": '{"path": "lessons/0001-a.first.md"}',
        }
    )
    reducer.consume(
        {
            "event": "role_event",
            "role_id": "r1",
            "role": "讲解",
            "type": "tool_result",
            "id": "call-1",
            "content": "已写入交付",
            "is_error": False,
        }
    )
    reducer.consume({"event": "role_end", "role_id": "r1", "role": "讲解", "status": "done"})

    role = reducer.snapshot()["roles"][0]
    assert role["name"] == "讲解"
    assert role["status"] == "done"
    assert [p["type"] for p in role["parts"]] == ["reasoning", "text", "tool"]
    assert role["parts"][2]["tool_id"] == "r1:call-1"
    assert role["tools"][0]["status"] == "done"
    assert role["tools"][0]["result"] == "已写入交付"
    assert role["elapsed_s"] is not None


def test_duplicate_tool_ids_are_namespaced_per_role():
    reducer = _reducer()
    for rid, name in (("r1", "讲解"), ("r2", "出题")):
        reducer.consume({"event": "role_start", "role_id": rid, "role": name})
        reducer.consume(
            {
                "event": "role_event",
                "role_id": rid,
                "role": name,
                "type": "tool_call",
                "name": "write_deliver_file",
                "id": "call-1",
                "arguments": "{}",
            }
        )
        reducer.consume(
            {
                "event": "role_event",
                "role_id": rid,
                "role": name,
                "type": "tool_result",
                "id": "call-1",
                "content": name,
                "is_error": False,
            }
        )
    first, second = reducer.snapshot()["roles"]
    assert first["tools"][0]["id"] == "r1:call-1"
    assert second["tools"][0]["id"] == "r2:call-1"
    # 结果不串台：各自只更新自己的同名 call id
    assert first["tools"][0]["result"] == "讲解"
    assert second["tools"][0]["result"] == "出题"


def test_long_text_is_truncated_with_marker_and_keeps_order():
    reducer = _reducer()
    reducer.consume({"event": "role_start", "role_id": "r1", "role": "讲解"})
    reducer.consume({"event": "role_event", "role_id": "r1", "type": "text", "content": "前"})
    reducer.consume({"event": "role_event", "role_id": "r1", "type": "text", "content": "x" * 9000})
    reducer.consume({"event": "role_event", "role_id": "r1", "type": "text", "content": "后"})
    parts = reducer.snapshot()["roles"][0]["parts"]
    assert parts and parts[0]["type"] == "text"
    assert parts[0]["text"].startswith("前")
    assert "已截断" in parts[0]["text"]
    assert parts[0]["truncated"] is True
    assert not parts[0]["text"].endswith("后")


def test_truncated_text_closes_open_fence_and_puts_notice_outside():
    reducer = _reducer()
    reducer.consume({"event": "role_start", "role_id": "r1", "role": "讲解"})
    body = "先看代码：\n```python\n" + ("print(1)\n" * 800)
    reducer.consume({"event": "role_event", "role_id": "r1", "type": "text", "content": body})
    part = reducer.snapshot()["roles"][0]["parts"][0]
    assert part["truncated"] is True
    # 开围栏被补上闭合：整段围栏成对，提示单独一行且在围栏之外
    assert part["text"].count("```") % 2 == 0
    assert part["text"].endswith("已截断显示）")


def test_truncation_strips_interview_payload_before_display():
    reducer = _reducer()
    reducer.consume({"event": "role_start", "role_id": "r1", "role": "讲解"})
    content = (
        "开头\n"
        '<!--INTERVIEW_RESULT-->{"name": "SECRET"}<!--/INTERVIEW_RESULT-->\n'
        + "y" * 5000
    )
    reducer.consume({"event": "role_event", "role_id": "r1", "type": "text", "content": content})
    text = reducer.snapshot()["roles"][0]["parts"][0]["text"]
    assert "SECRET" not in text
    assert "INTERVIEW_RESULT" not in text


def test_unpaired_interview_marker_is_cut_before_json():
    reducer = _reducer()
    reducer.consume({"event": "role_start", "role_id": "r1", "role": "讲解"})
    content = "开头\n<!--INTERVIEW_RESULT-->{\"name\": \"SECRET\"\n" + "y" * 5000
    reducer.consume({"event": "role_event", "role_id": "r1", "type": "text", "content": content})
    text = reducer.snapshot()["roles"][0]["parts"][0]["text"]
    assert "SECRET" not in text


def test_tool_events_after_truncated_text_are_preserved():
    reducer = _reducer()
    reducer.consume({"event": "role_start", "role_id": "r1", "role": "讲解"})
    reducer.consume({"event": "role_event", "role_id": "r1", "type": "text", "content": "x" * 9000})
    reducer.consume({"event": "role_event", "role_id": "r1", "type": "text", "content": "late-same-part"})
    reducer.consume(
        {"event": "role_event", "role_id": "r1", "type": "tool_call", "name": "write_deliver_file", "id": "c1", "arguments": "{}"}
    )
    reducer.consume(
        {"event": "role_event", "role_id": "r1", "type": "tool_result", "id": "c1", "content": "ok", "is_error": False}
    )
    role = reducer.snapshot()["roles"][0]
    assert [p["type"] for p in role["parts"]] == ["text", "tool"]
    assert "late-same-part" not in role["parts"][0]["text"]
    assert role["tools"][0]["status"] == "done"


def test_retry_creates_new_stage_id_and_stage_round():
    reducer = _reducer()
    reducer.consume({"event": "stage", "stage": "检查", "status": "fail", "problems": [{"message": "题库对不上"}]})
    reducer.consume({"event": "retry", "round": 1, "owners": ["出题"], "problems": [{"message": "题库对不上"}]})
    reducer.consume({"event": "stage", "stage": "检查", "status": "fail", "problems": [{"message": "仍未过"}]})
    snapshot = reducer.snapshot()
    stage_ids = [e["id"] for e in snapshot["events"] if e["name"] == "检查"]
    assert stage_ids == ["检查#0", "检查#1"]
    assert snapshot["round"] == 1
    assert any(e["name"] == "打回" for e in snapshot["events"])


def test_finalize_turns_running_roles_interrupted_and_never_fakes_done():
    reducer = _reducer()
    reducer.consume({"event": "role_start", "role_id": "r1", "role": "讲解"})
    reducer.consume({"event": "role_event", "role_id": "r1", "type": "text", "content": "还在写"})
    reducer.finalize(pt.STATUS_INTERRUPTED)
    snapshot = reducer.snapshot()
    assert snapshot["status"] == "interrupted"
    assert snapshot["roles"][0]["status"] == "interrupted"


# ---------- 终态不再声称「当前阶段」 ----------


def test_done_clears_current_stage_but_keeps_event_statuses_real():
    """真 done 输入：终态清「当前阶段」指针；历史阶段状态照实，不伪 done。"""
    reducer = _reducer()
    reducer.consume({"event": "stage", "stage": "讲解", "status": "start"})
    reducer.consume({"event": "stage", "stage": "讲解", "status": "done"})
    reducer.consume({"event": "stage", "stage": "检查", "status": "start"})
    reducer.consume({"event": "done", "artifacts": ["lessons/0001-a.first.html"]})
    snapshot = reducer.snapshot()
    assert snapshot["status"] == "done"
    assert "stage" not in snapshot
    statuses = {e["name"]: e["status"] for e in snapshot["events"]}
    assert statuses["讲解"] == "done"
    # 未收到 done/error 的「检查」保持真实 running，绝不补成 done
    assert statuses["检查"] == "running"


def test_error_clears_current_stage_without_faking_event_done():
    reducer = _reducer()
    reducer.consume({"event": "stage", "stage": "检查", "status": "start"})
    reducer.consume({"event": "error", "message": "检查未通过"})
    snapshot = reducer.snapshot()
    assert snapshot["status"] == "error"
    assert "stage" not in snapshot
    assert next(e for e in snapshot["events"] if e["name"] == "检查")["status"] == "running"


def test_finalize_clears_current_stage_but_not_event_status():
    reducer = _reducer()
    reducer.consume({"event": "stage", "stage": "检查", "status": "start"})
    reducer.finalize(pt.STATUS_DONE)
    snapshot = reducer.snapshot()
    assert snapshot["status"] == "done"
    assert "stage" not in snapshot
    assert next(e for e in snapshot["events"] if e["name"] == "检查")["status"] == "running"


# ---------- lesson_link ----------


def test_lesson_link_requires_real_readable_html(tmp_path):
    artifact = "lessons/0001-a.first.html"
    # 仅凭产物清单（文件不存在）不给入口
    assert pt.lesson_link(
        base=tmp_path,
        subject_slug="s",
        node_id="a.first",
        title="第一课",
        workspace="/ws",
        artifacts=[artifact],
        node_ids={"a.first"},
    ) is None
    # 空文件也不算可读入口
    target = tmp_path / artifact
    target.parent.mkdir(parents=True)
    target.write_text("", encoding="utf-8")
    assert pt.lesson_link(
        base=tmp_path,
        subject_slug="s",
        node_id="a.first",
        title="第一课",
        workspace="/ws",
        artifacts=[artifact],
        node_ids={"a.first"},
    ) is None
    # 节点不在课表里同样不给
    target.write_text("<html></html>", encoding="utf-8")
    assert pt.lesson_link(
        base=tmp_path,
        subject_slug="s",
        node_id="a.first",
        title="第一课",
        workspace="/ws",
        artifacts=[artifact],
        node_ids={"other"},
    ) is None
    # 真文件 + 节点在课表 → 给出入口
    link = pt.lesson_link(
        base=tmp_path,
        subject_slug="s",
        node_id="a.first",
        title="第一课",
        workspace="/ws",
        artifacts=[artifact],
        node_ids={"a.first"},
    )
    assert link == {
        "subject_slug": "s",
        "node_id": "a.first",
        "title": "第一课",
        "workspace": "/ws",
        "file": artifact,
    }


# ---------- tools._tool_produce_lesson ----------


def _seed(cs, slug, node_id="a.first"):
    cs.save_curriculum(
        slug,
        {
            "nodes": [
                {"id": node_id, "title": "第一课", "kind": "概念", "objective": "目标"},
                {"id": "a.second", "title": "第二课", "kind": "概念", "objective": "目标"},
            ],
            "edges": [],
        },
    )
    return node_id


def _producing_events(node_id: str, *, html: bool, handoff: bool = False, fail: bool = False):
    yield {"event": "stage", "stage": "讲解", "status": "start"}
    yield {"event": "role_start", "role_id": "content:1", "role": "讲解", "route": "produce_content"}
    yield {"event": "role_event", "role_id": "content:1", "role": "讲解", "type": "text", "content": "讲解正文"}
    yield {"event": "role_event", "role_id": "content:1", "role": "讲解", "type": "tool_call", "name": "write_deliver_file", "id": "call-1", "arguments": "{}"}
    yield {"event": "role_event", "role_id": "content:1", "role": "讲解", "type": "tool_result", "id": "call-1", "content": "已写入交付", "is_error": False}
    yield {"event": "role_end", "role_id": "content:1", "role": "讲解", "status": "done"}
    yield {"event": "stage", "stage": "讲解", "status": "done"}
    if fail:
        yield {"event": "error", "message": "按大纲顺序产课：先产出前面的节点。"}
        return
    if handoff:
        yield {"event": "handoff", "ticket": {"id": "t-1"}}
        yield {"event": "error", "message": "质检打回 2 轮仍未通过，已转人工（工单 t-1）。"}
        return
    artifacts = [f"lessons/0001-{node_id}.md", f"lessons/0001-{node_id}.quiz.json"]
    if html:
        artifacts.append(f"lessons/0001-{node_id}.html")
    yield {"event": "done", "node_id": node_id, "artifacts": artifacts}


def _run_produce(monkeypatch, cs, slug, base, node_id, *, html, handoff=False, fail=False, cancel=False):
    from app import produce

    async def fake_run_produce(base_arg, slug_arg, node_id_arg, provider, emit, **kwargs):
        assert base_arg == base and slug_arg == slug and node_id_arg == node_id
        if cancel:
            await emit({"event": "role_start", "role_id": "content:1", "role": "讲解", "route": "produce_content"})
            raise asyncio.CancelledError()
        for event in _producing_events(node_id, html=html, handoff=handoff, fail=fail):
            await emit(event)
        if html:
            target = base / "lessons" / f"0001-{node_id}.html"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("<html><body>课件</body></html>", encoding="utf-8")

    monkeypatch.setattr(produce, "run_produce", fake_run_produce)


def _ctx(slug, base, emit, *, node_id=None, tool_call_id="call-parent"):
    return ToolContext(
        read_roots=[base],
        write_roots=[],
        label="科目",
        state={
            "slug": slug,
            "node_id": node_id,
            "session_id": None,
            "emit": emit,
            "tool_call_id": tool_call_id,
        },
    )


def test_produce_lesson_emits_task_update_with_lesson_only_when_html_exists(
    client, monkeypatch, new_subject, cs
):
    from app import tools as tools_svc

    slug, base = new_subject
    node_id = _seed(cs, slug)
    _run_produce(monkeypatch, cs, slug, base, node_id, html=True)
    events, emit = _collector()
    result = asyncio.run(
        tools_svc.execute("produce_lesson", {"node_id": node_id}, _ctx(slug, base, emit, node_id=node_id))
    )

    assert result["is_error"] is False
    updates = _task_updates(events)
    assert updates, "必须回吐 task_update"
    assert all(u["id"] == "call-parent" for u in updates)
    final = updates[-1]["task"]
    assert final["id"] == "call-parent"
    assert final["status"] == "done"
    assert final["kind"] == "produce_lesson"
    assert final["node_id"] == node_id
    # workspace 是解析后的绝对路径
    assert final["workspace"] == str(cs.workspace_dir().resolve())
    assert final["roles"] and final["roles"][0]["name"] == "讲解"
    # 真正的角色正文/工具活动进入了快照
    role = final["roles"][0]
    assert any(p["type"] == "text" and "讲解正文" in p["text"] for p in role["parts"])
    assert any(p["type"] == "tool" for p in role["parts"])
    assert role["tools"][0]["id"] == "content:1:call-1"
    assert any(e["name"] == "讲解" and e["status"] == "done" for e in final["events"])
    # 成功才带 lesson 入口
    assert result["lesson"]["file"] == f"lessons/0001-{node_id}.html"
    assert final["lesson"] == result["lesson"]
    # 不再用 notice 刷进度
    assert not [e for e in events if e.get("type") == "notice"]


def test_produce_lesson_without_html_has_no_lesson_but_done_task(client, monkeypatch, new_subject, cs):
    from app import tools as tools_svc

    slug, base = new_subject
    node_id = _seed(cs, slug)
    _run_produce(monkeypatch, cs, slug, base, node_id, html=False)
    events, emit = _collector()
    result = asyncio.run(
        tools_svc.execute("produce_lesson", {"node_id": node_id}, _ctx(slug, base, emit, node_id=node_id))
    )
    assert result["is_error"] is False
    assert result["lesson"] is None
    assert _task_updates(events)[-1]["task"]["status"] == "done"


def test_produce_lesson_handoff_has_no_lesson_and_task_error(client, monkeypatch, new_subject, cs):
    from app import tools as tools_svc

    slug, base = new_subject
    node_id = _seed(cs, slug)
    _run_produce(monkeypatch, cs, slug, base, node_id, html=True, handoff=True)
    events, emit = _collector()
    result = asyncio.run(
        tools_svc.execute("produce_lesson", {"node_id": node_id}, _ctx(slug, base, emit, node_id=node_id))
    )
    assert result["is_error"] is True
    assert "lesson" not in result
    final = _task_updates(events)[-1]["task"]
    assert final["status"] == "error"
    assert "lesson" not in final
    assert any(e["name"] == "转人工" for e in final["events"])


def test_produce_lesson_error_is_not_faked_done(client, monkeypatch, new_subject, cs):
    from app import tools as tools_svc

    slug, base = new_subject
    node_id = _seed(cs, slug)
    _run_produce(monkeypatch, cs, slug, base, node_id, html=False, fail=True)
    events, emit = _collector()
    result = asyncio.run(
        tools_svc.execute("produce_lesson", {"node_id": node_id}, _ctx(slug, base, emit, node_id=node_id))
    )
    assert result["is_error"] is True
    assert "按大纲顺序产课" in result["content"]
    assert _task_updates(events)[-1]["task"]["status"] == "error"


def test_produce_lesson_cancel_finalizes_interrupted(client, monkeypatch, new_subject, cs):
    from app import tools as tools_svc

    slug, base = new_subject
    node_id = _seed(cs, slug)
    _run_produce(monkeypatch, cs, slug, base, node_id, html=False, cancel=True)
    events, emit = _collector()
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(
            tools_svc.execute(
                "produce_lesson", {"node_id": node_id}, _ctx(slug, base, emit, node_id=node_id)
            )
        )
    final = _task_updates(events)[-1]["task"]
    assert final["status"] == "interrupted"
    assert final["roles"][0]["status"] == "interrupted"


def test_produce_lesson_all_produced_creates_no_task(client, monkeypatch, new_subject, cs):
    from app import tools as tools_svc

    slug, base = new_subject
    node_id = _seed(cs, slug)
    lessons = base / "lessons"
    lessons.mkdir(parents=True, exist_ok=True)
    (lessons / f"0001-{node_id}.md").write_text("已有课件", encoding="utf-8")
    (lessons / "0002-a.second.md").write_text("已有课件", encoding="utf-8")
    events, emit = _collector()
    result = asyncio.run(tools_svc.execute("produce_lesson", {}, _ctx(slug, base, emit)))
    assert result["is_error"] is False
    assert "所有节点都已产出" in result["content"]
    assert _task_updates(events) == []


# ---------- tools._tool_assess_node ----------


def test_assess_node_success_carries_saved_assessment(client, new_subject, cs):
    from app import storage
    from app import tools as tools_svc

    slug, base = new_subject
    node_id = _seed(cs, slug)
    session_id = storage.create_session("评估")["id"]
    storage.update_session(session_id, subject_slug=slug)
    ctx = ToolContext(
        read_roots=[base],
        write_roots=[],
        label="科目",
        state={"slug": slug, "session_id": session_id, "tool_call_id": "call-a"},
    )
    result = asyncio.run(
        tools_svc.execute("assess_node", {"node_id": node_id, "evidence": "我把分层讲了一遍"}, ctx)
    )
    assert result["is_error"] is False
    assessment = result["assessment"]
    assert assessment["status"] == "saved"
    assert assessment["node_id"] == node_id
    assert assessment["subject_slug"] == slug
    assert assessment["verdict"] == "通过"
    assert assessment["progress_updated"] is True
    assert assessment["record_file"]


def test_assess_node_failure_carries_failed_assessment(client, new_subject, cs):
    from app import tools as tools_svc

    slug, base = new_subject
    node_id = _seed(cs, slug)
    ctx = ToolContext(
        read_roots=[base],
        write_roots=[],
        label="科目",
        state={"slug": slug, "session_id": None},
    )
    result = asyncio.run(tools_svc.execute("assess_node", {"node_id": node_id}, ctx))
    assert result["is_error"] is True
    assessment = result["assessment"]
    assert assessment["status"] == "failed"
    assert assessment["node_id"] == node_id
    assert assessment["subject_slug"] == slug
    assert assessment["background"] is False
    assert "evidence" in assessment["error"]


# ---------- build / produce 阶段名区分 ----------


def test_build_inner_and_outer_checks_use_distinct_stage_names(monkeypatch):
    from app import agent, build
    from app import draft as draft_svc
    from app.llm import FIXTURE_CURRICULUM

    slug = draft_svc.create_draft("阶段名科目", slug="stage-names")
    try:
        base = draft_svc.draft_dir(slug)

        def fake_source(provider, scenario=None):
            async def source(messages, tools):
                yield {
                    "type": "tool_calls",
                    "tool_calls": [
                        {
                            "id": "c1",
                            "name": "submit_curriculum",
                            "arguments": json.dumps({"data": FIXTURE_CURRICULUM}),
                        }
                    ],
                }
                yield {"type": "text", "content": "大纲设计说明"}

            return source

        monkeypatch.setattr(agent, "real_turn_source", fake_source)
        inner_events, inner_emit = _collector()
        data = asyncio.run(
            build._curriculum_tool_loop(
                slug, base, "派工值", {"model": "m", "capabilities": {"tool_call": True}}, inner_emit
            )
        )
        assert data and data["nodes"]
        inner_names = [e.get("stage") for e in inner_events if e.get("event") == "stage"]
        assert "大纲自检" in inner_names
        assert "门禁" not in inner_names

        outer_events, outer_emit = _collector()
        result = asyncio.run(
            build._curriculum_chain(
                slug, "派工值", {"model": "m", "capabilities": {"tool_call": True}}, outer_emit
            )
        )
        assert result and result["nodes"]
        outer_names = [e.get("stage") for e in outer_events if e.get("event") == "stage"]
        assert "交付检查" in outer_names
        assert "大纲自检" not in outer_names
        assert "门禁" not in outer_names
    finally:
        draft_svc.delete_draft(slug)


def test_role_tool_loop_labels_run_check_as_self_check(monkeypatch, tmp_path):
    from app import agent, produce

    async def fake_render_and_check(base, node_id, index, emit):
        return True, []

    monkeypatch.setattr(produce, "render_and_check", fake_render_and_check)

    sent = {"n": 0}

    def fake_source(provider, scenario=None):
        async def source(messages, tools):
            if sent["n"] == 0:
                sent["n"] += 1
                yield {
                    "type": "tool_calls",
                    "tool_calls": [
                        {
                            "id": "w1",
                            "name": "write_deliver_file",
                            "arguments": json.dumps(
                                {"path": "lessons/0001-a.first.md", "content": "正文"}
                            ),
                        },
                        {"id": "c1", "name": "run_check", "arguments": "{}"},
                    ],
                }
            else:
                yield {"type": "text", "content": "交付完成"}

        return source

    monkeypatch.setattr(agent, "real_turn_source", fake_source)
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
            node_id="a.first",
            index=1,
            stage_dir=tmp_path / "stage",
        )
    )
    assert env is not None and env["files"]
    stage_names = [e.get("stage") for e in events if e.get("event") == "stage"]
    assert "交付自检" in stage_names
    assert "检查" not in stage_names
    role_events = [e for e in events if e.get("event") == "role_event"]
    assert any(e["type"] == "tool_call" and e["name"] == "run_check" for e in role_events)
    assert any(e.get("event") == "role_start" for e in events)
    assert any(e.get("event") == "role_end" and e.get("status") == "done" for e in events)
