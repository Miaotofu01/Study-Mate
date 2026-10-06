"""备用派工（fallback）角色状态回归。

覆盖真实事件契约（不特判伪成功）：
- role_start 的 execution_mode（tools/fallback/single_call）、fallback_reason、max_seconds
  原样落入角色快照；缺省不发明默认值（兼容旧持久化）。
- 角色 elapsed 按**自身开始时刻**计；运行中心跳只涨该角色，role_end 后冻结（done 不涨）。
- 真实 stage「备用派工」按 start/done/error 归约；未收到 stage 不伪造。
- 首次失败角色与备用派工角色共存，失败来源保留、不因备用派工 done 而伪成功。
- timeout / interrupted 状态准确；心跳与 TaskUpdateStream 原位刷新、不新增 notice。
"""
from __future__ import annotations

import asyncio

from app import production_task as pt


def _collector() -> tuple[list[dict], object]:
    events: list[dict] = []

    async def emit(event):
        events.append(event)

    return events, emit


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


def _fallback_start(role_id: str = "fb:1") -> dict:
    return {
        "event": "role_start",
        "role_id": role_id,
        "role": "讲解",
        "route": "produce_content",
        "execution_mode": "fallback",
        "fallback_reason": "角色工具循环未交付",
        "max_seconds": 1800,
    }


# ---------- 字段归约 ----------


def test_fallback_role_start_fields_are_stored():
    reducer = _reducer()
    reducer.consume(_fallback_start())
    role = reducer.snapshot()["roles"][0]
    assert role["execution_mode"] == "fallback"
    assert role["fallback_reason"] == "角色工具循环未交付"
    assert role["max_seconds"] == 1800.0


def test_single_call_and_tools_modes_are_kept_distinct():
    reducer = _reducer()
    reducer.consume({"event": "role_start", "role_id": "tools:1", "role": "讲解", "execution_mode": "tools"})
    reducer.consume({"event": "role_start", "role_id": "single:1", "role": "出题", "execution_mode": "single_call", "max_seconds": 1800})
    tools, single = reducer.snapshot()["roles"]
    assert tools["execution_mode"] == "tools"
    assert "fallback_reason" not in tools
    assert single["execution_mode"] == "single_call"
    assert single["max_seconds"] == 1800.0


def test_legacy_role_without_mode_invents_nothing():
    reducer = _reducer()
    reducer.consume({"event": "role_start", "role_id": "legacy:1", "role": "渲染"})
    role = reducer.snapshot()["roles"][0]
    assert "execution_mode" not in role
    assert "fallback_reason" not in role
    assert "max_seconds" not in role


def test_non_positive_max_seconds_is_preserved():
    reducer = _reducer()
    reducer.consume(
        {"event": "role_start", "role_id": "single:1", "role": "讲解", "execution_mode": "single_call", "max_seconds": 0}
    )
    assert reducer.snapshot()["roles"][0]["max_seconds"] == 0.0


# ---------- 计时 ----------


def test_role_elapsed_uses_its_own_start_and_freezes_after_end(monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(pt.time, "monotonic", lambda: clock["t"])
    reducer = _reducer()
    clock["t"] = 1005.0
    reducer.consume(_fallback_start())
    clock["t"] = 1030.0
    reducer.touch()
    role = reducer.snapshot()["roles"][0]
    # 25s 来自角色自身开始（1005），不是任务总时长 30s
    assert role["elapsed_s"] == 25.0
    assert reducer.snapshot()["elapsed_s"] == 30.0

    reducer.consume({"event": "role_end", "role_id": "fb:1", "status": "done"})
    clock["t"] = 1099.0
    reducer.touch()
    # done 后心跳不再给该角色涨耗时
    assert reducer.snapshot()["roles"][0]["elapsed_s"] == 25.0


def test_running_fallback_elapsed_grows_with_heartbeat(monkeypatch):
    clock = {"t": 0.0}
    monkeypatch.setattr(pt.time, "monotonic", lambda: clock["t"])
    reducer = _reducer()
    reducer.consume(_fallback_start())
    for step in (10.0, 40.0, 90.0):
        clock["t"] = step
        reducer.touch()
        assert reducer.snapshot()["roles"][0]["elapsed_s"] == step


# ---------- 真实 stage 归约，不伪造 ----------


def test_fallback_stage_reduces_real_events_without_faking_check():
    reducer = _reducer()
    reducer.consume({"event": "stage", "stage": "备用派工", "status": "start"})
    reducer.consume(_fallback_start())
    reducer.consume({"event": "stage", "stage": "备用派工", "status": "done"})
    snapshot = reducer.snapshot()
    fallback_stages = [e for e in snapshot["events"] if e["name"] == "备用派工"]
    assert [e["status"] for e in fallback_stages] == ["done"]


def test_no_stage_is_fabricated_when_backend_emits_none():
    reducer = _reducer()
    reducer.consume(_fallback_start())
    reducer.consume({"event": "role_end", "role_id": "fb:1", "status": "done"})
    # 后端没发 stage，就一条都不造（不把未执行的自检伪报通过）
    assert reducer.snapshot()["events"] == []


def test_fallback_stage_error_is_recorded_as_error():
    reducer = _reducer()
    reducer.consume({"event": "stage", "stage": "备用派工", "status": "start"})
    reducer.consume({"event": "stage", "stage": "备用派工", "status": "fail", "message": "单次调用超时"})
    stage = next(e for e in reducer.snapshot()["events"] if e["name"] == "备用派工")
    assert stage["status"] == "error"
    assert stage["message"] == "单次调用超时"


# ---------- 失败来源 / 终态 ----------


def test_failed_primary_is_retained_and_not_faked_success():
    reducer = _reducer()
    reducer.consume({"event": "role_start", "role_id": "tools:1", "role": "讲解", "execution_mode": "tools"})
    reducer.consume(
        {
            "event": "role_end",
            "role_id": "tools:1",
            "status": "error",
            "message": "角色工具循环未交付，回落单次派工",
        }
    )
    reducer.consume(_fallback_start())
    reducer.consume(
        {
            "event": "role_end",
            "role_id": "fb:1",
            "status": "done",
            "message": "已有产物经本轮检查通过，未重写",
        }
    )
    reducer.consume({"event": "error", "message": "产课未完成"})
    snapshot = reducer.snapshot()
    roles = {role["id"]: role for role in snapshot["roles"]}
    assert roles["tools:1"]["status"] == "error"
    assert roles["tools:1"]["message"] == "角色工具循环未交付，回落单次派工"
    assert roles["fb:1"]["status"] == "done"
    assert snapshot["status"] == "error"


def test_timeout_status_is_preserved():
    reducer = _reducer()
    reducer.consume(_fallback_start())
    reducer.consume({"event": "role_end", "role_id": "fb:1", "status": "timeout"})
    assert reducer.snapshot()["roles"][0]["status"] == "timeout"


def test_finalize_interrupts_running_fallback_without_faking_done():
    reducer = _reducer()
    reducer.consume(_fallback_start())
    reducer.finalize(pt.STATUS_INTERRUPTED)
    snapshot = reducer.snapshot()
    assert snapshot["status"] == "interrupted"
    assert snapshot["roles"][0]["status"] == "interrupted"


# ---------- 心跳：原位、不刷屏 ----------


def test_100_heartbeats_keep_snapshot_shape_and_terminal_state(monkeypatch):
    clock = {"t": 0.0}
    monkeypatch.setattr(pt.time, "monotonic", lambda: clock["t"])
    reducer = _reducer()
    reducer.consume(_fallback_start())
    reducer.consume({"event": "role_end", "role_id": "fb:1", "status": "done"})
    before = reducer.snapshot()
    done_elapsed = before["roles"][0]["elapsed_s"]
    for _ in range(100):
        clock["t"] += 3
        reducer.touch()
    after = reducer.snapshot()
    assert len(after["events"]) == len(before["events"])
    assert len(after["roles"]) == len(before["roles"])
    assert after["roles"][0]["status"] == "done"
    assert after["roles"][0]["elapsed_s"] == done_elapsed


def test_task_update_stream_heartbeat_refreshes_in_place_without_notice():
    events, emit = _collector()
    reducer = _reducer()
    stream = pt.TaskUpdateStream(reducer, emit, heartbeat_interval=0.1)

    async def run() -> None:
        await stream.start()
        await asyncio.sleep(0.18)
        reducer.consume(_fallback_start())
        await stream.stop()

    asyncio.run(run())
    updates = [e for e in events if e.get("type") == "task_update"]
    assert updates, "必须回吐 task_update"
    assert all(u["id"] == "call-parent" for u in updates)
    assert all(u["task"]["id"] == "call-parent" for u in updates)
    assert not [e for e in events if e.get("type") == "notice"]
