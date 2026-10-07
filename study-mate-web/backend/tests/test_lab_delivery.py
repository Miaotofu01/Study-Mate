from __future__ import annotations

import asyncio

import pytest

from app import produce


def node(kind="实操"):
    return {"id": "practice", "title": "实操", "kind": kind, "objective": "验证产物"}


def test_real_values_share_lab_paths_and_preserve_overview(tmp_path):
    (tmp_path / "lab").mkdir()
    (tmp_path / "lab" / "README.md").write_text("旧任务必须保留", encoding="utf-8")
    content = produce.content_values(tmp_path, "subject", node(), 2)
    quiz = produce.quiz_values(tmp_path, "subject", node(), 2, "正文")
    assert "../lab/0002-stage/README.md" in content
    for path in ("lab/0002-stage/README.md", "lab/solutions/0002-stage/README.md", "lab/README.md"):
        assert path in quiz
    assert "旧任务必须保留" in quiz
    assert "自查" in quiz and "留白" in quiz


@pytest.mark.parametrize("kind,route", [("实操", "produce_quiz"), ("实验", "produce_experiment")])
def test_lab_required_for_production_and_reuse(kind, route):
    required = produce.required_artifacts(route, 2, "practice", kind)
    assert "lab/0002-stage/README.md" in required
    assert "lab/solutions/0002-stage/README.md" in required
    assert "lab/README.md" in required


@pytest.mark.parametrize("kind,route,factory", [
    ("实操", "produce_quiz", produce.fixture_quiz_envelope),
    ("实验", "produce_experiment", produce.fixture_experiment_envelope),
])
def test_fixture_obeys_same_required_contract(tmp_path, kind, route, factory):
    values = (produce.quiz_values(tmp_path, "s", node(kind), 2, "正文") if kind == "实操"
              else produce.experiment_values(tmp_path, "s", node(kind), 2))
    paths = {f["path"] for f in factory(values)["files"]}
    assert set(produce.required_artifacts(route, 2, "practice", kind)) <= paths


def test_missing_lab_rejects_delivery_without_promoting(tmp_path):
    envelope = {"files": [{"path": "lessons/0002-practice.quiz.json", "content": "{}"}]}
    moved = asyncio.run(produce._write_and_promote(
        tmp_path / "stage", tmp_path / "subject", envelope,
        required=produce.required_artifacts("produce_quiz", 2, "practice", "实操"),
    ))
    assert moved is None
    assert not (tmp_path / "subject" / "lessons").exists()


@pytest.mark.parametrize("message,owner", [
    ("实操课缺少实操引用：页面里必须有 href 指向 lab/ 的链接", "讲解"),
    ("实操课缺少 lab/ 目录", "出题"),
    ("lab/solutions/ 缺失（参考答案要与任务分开放）", "出题"),
])
def test_lab_problems_have_actionable_owner(message, owner):
    assert produce._owner_of_problem({"path": "lessons/0002-practice.html", "message": message}) == owner


def test_real_dispatch_passes_kind_to_reuse_gate(tmp_path, monkeypatch):
    from app import llm
    monkeypatch.setattr(llm, "is_fixture_mode", lambda: False)
    captured = {}

    async def fake_loop(*args, **kwargs):
        captured.update(kwargs)
        return {"files": [{"path": "any", "content": "done"}]}

    async def emit(event):
        pass

    monkeypatch.setattr(produce, "_role_tool_loop", fake_loop)
    asyncio.run(produce.dispatch(
        {"model": "mock"}, "produce_quiz", "values", lambda _: {}, emit,
        base=tmp_path, node_id="practice", index=2, stage_dir=tmp_path / "stage", kind="实操",
    ))
    assert "lab/README.md" in captured["required"]


def test_control_only_recheck_does_not_claim_repair_rounds(tmp_path, monkeypatch):
    base = tmp_path / "subject"
    base.mkdir()
    (base / "curriculum.yaml").write_text(
        "nodes:\n  - id: practice\n    title: 概念\n    kind: 概念\n", encoding="utf-8",
    )
    events = []
    checks = []

    async def emit(event):
        events.append(event)

    async def check(*args):
        checks.append(True)
        return False, [{"path": "assets/style.css", "message": "公共资源异常", "owner": "总控"}]

    monkeypatch.setattr(produce, "ensure_subject_assets", lambda base: None)
    monkeypatch.setattr(produce, "render_and_check", check)
    monkeypatch.setattr(produce.tickets_svc, "create_ticket", lambda **kw: {"id": "ticket", **kw})
    asyncio.run(produce.run_produce(base, "subject", "practice", {"model": "mock"}, emit))
    assert len(checks) == 2
    assert not [e for e in events if e.get("event") == "retry"]
    error = next(e for e in events if e.get("code") == "quality_check_failed")
    assert error["repair_rounds"] == 0 and error["rechecks"] == 1
    assert "修复派工 0 轮" in error["message"]
