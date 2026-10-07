"""任务快照终态纳入 timeout 后的 checkpoint 回归（2026-10-05 收尾整合）。

本轮小修：`chat._TERMINAL_TASK_STATUSES` 补上 timeout。chat.emit 用
`_task_is_terminal(...)` 决定 checkpoint 是否 force —— 只有它把 timeout 视为终态，
超时那一刻才会立即落库（刷新即见超时），而不是等 0.6s 节流或被回落成 running。

覆盖（不触盘、不起服务、纯函数级）：
- timeout 为终态；done/error/interrupted 仍为终态；running/未知/非 dict 不为真；
- timeout 的 task_update 仍走 `_accumulate_partial`：原位更新父工具卡、不 append parts，
  旧 ToolActivity.status 归 error（与 interrupted 同口径）；
- task 终态与旧 status 映射一致。
"""
from __future__ import annotations

from app.routers.chat import (
    _TERMINAL_TASK_STATUSES,
    _accumulate_partial,
    _task_is_terminal,
    _tool_status_from_task,
)


def _bucket() -> dict:
    return {"text": [], "reasoning": [], "tools": [], "notices": [], "parts": [], "usage": None}


def _task(status: str = "running", **extra: object) -> dict:
    return {
        "id": "task-1",
        "kind": "produce_lesson",
        "title": "分层模型",
        "subject_slug": "net",
        "node_id": "net.layers",
        "workspace": "/ws",
        "status": status,
        "roles": [],
        "events": [],
        **extra,
    }


def test_timeout_is_terminal_so_checkpoint_is_forced():
    # chat.emit 的 force=kind=="task_update" and _task_is_terminal(task)。timeout 必须为真，
    # 否则超时快照要等下一个节流点才落库，刷新可能仍看到 running。
    assert "timeout" in _TERMINAL_TASK_STATUSES
    assert _task_is_terminal({"status": "timeout"}) is True


def test_terminal_set_matches_all_terminal_statuses():
    for status in ("done", "error", "timeout", "interrupted"):
        assert _task_is_terminal({"status": status}) is True, status
    for status in ("running", "", "unknown", None):
        assert _task_is_terminal({"status": status}) is False, status
    # 非 dict（字符串/None）不误判为终态，避免 force=True 误落
    assert _task_is_terminal("timeout") is False
    assert _task_is_terminal(None) is False


def test_timeout_task_update_updates_in_place_without_parts():
    bucket = _bucket()
    _accumulate_partial(
        bucket, {"type": "tool_call", "id": "t1", "name": "produce_lesson", "arguments": "{}"}
    )
    _accumulate_partial(bucket, {"type": "task_update", "id": "t1", "task": _task("timeout")})
    assert [part["type"] for part in bucket["parts"]] == ["tool"]
    assert bucket["notices"] == []
    assert bucket["tools"][0]["task"]["status"] == "timeout"
    # 旧卡片状态：超时归 error（与 interrupted 同口径，供旧 ToolCards/面板兜底显示）
    assert bucket["tools"][0]["status"] == "error"
    assert _tool_status_from_task({"status": "timeout"}) == "error"


def test_running_still_not_terminal_and_keeps_bucket_running():
    bucket = _bucket()
    _accumulate_partial(
        bucket, {"type": "tool_call", "id": "t1", "name": "produce_lesson", "arguments": "{}"}
    )
    _accumulate_partial(bucket, {"type": "task_update", "id": "t1", "task": _task("running")})
    assert _task_is_terminal(bucket["tools"][0]["task"]) is False
    assert bucket["tools"][0]["status"] == "running"
