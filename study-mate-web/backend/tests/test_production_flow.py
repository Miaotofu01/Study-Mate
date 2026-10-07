"""生产链（C/D/E/工单）的 TestClient 全链路验证：fixture 模式，不外呼。"""
from __future__ import annotations

import json
import re
from pathlib import Path

from app import curriculum_store as cs
from app import draft as draft_svc
from app import tickets as tickets_svc

import pytest

@pytest.fixture()
def produce_subject(client, new_subject):
    """带 fixture 大纲（demo.intro/core/lab 三节点）的科目，供产课链用。"""
    from app.llm import FIXTURE_CURRICULUM

    slug, base = new_subject
    payload = FIXTURE_CURRICULUM
    r = client.put(f"/api/courses/{slug}/curriculum", json=payload)
    assert r.status_code == 200, r.text
    return slug, base


def sse_events(r) -> list[tuple[str, dict]]:
    """把 SSE 响应解析成 (event, data) 序列。"""
    out: list[tuple[str, dict]] = []
    current = None
    for line in r.text.splitlines():
        if line.startswith("event: "):
            current = line[7:]
        elif line.startswith("data: ") and current is not None:
            out.append((current, json.loads(line[6:])))
            current = None
    return out


def event_names(r) -> list[str]:
    return [name for name, _ in sse_events(r)]


# ---------- 产课链（C） ----------


def test_produce_chain_writes_artifacts(client, produce_subject):
    slug, base = produce_subject
    r = client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={})
    assert r.status_code == 200
    names = event_names(r)
    assert names[0] == "session"
    assert "stage" in names and "done" in names and names[-1] == "finished"
    for rel in (
        "lessons/0001-demo.intro.md",
        "lessons/0001-demo.intro.quiz.json",
        "lessons/0001-demo.intro.html",
    ):
        assert (base / rel).is_file(), rel
    # 科目组件与共享层组件被总控补齐
    assert (base / "assets" / "style.css").is_file()
    assert (base.parent.parent / "assets" / "learn-theme.css").is_file()
    # 事件持久化为会话消息
    assert not tickets_svc.list_tickets(slug=slug, open_only=True)


def test_produce_session_messages_persisted(client, produce_subject):
    slug, _ = produce_subject
    r = client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={})
    session_id = next(data["session_id"] for name, data in sse_events(r) if name == "session")
    session = client.get(f"/api/sessions/{session_id}").json()
    kinds = [m.get("kind") for m in session["messages"] if m.get("kind")]
    assert "stage" in kinds
    assert "done" in kinds


def test_produce_missing_node(client, produce_subject):
    slug, _ = produce_subject
    r = client.post(f"/api/courses/{slug}/nodes/nope.node/produce", json={})
    names = event_names(r)
    assert "error" in names


def test_produce_experiment_node_uses_experiment_dispatch(client, produce_subject):
    slug, base = produce_subject
    # 上游检查器要求课件编号连续：按大纲顺序先产 1、2 课
    client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={})
    client.post(f"/api/courses/{slug}/nodes/demo.core/produce", json={})
    r = client.post(f"/api/courses/{slug}/nodes/demo.lab/produce", json={})
    names = event_names(r)
    assert "done" in names
    # 实验课：说明页 + lab/ 任务树，没有讲解段
    assert (base / "lessons" / "0003-demo.lab.md").is_file()
    assert any(p.suffix == ".md" for p in (base / "lab").rglob("*"))


def test_produce_enforces_curriculum_order(client, produce_subject):
    slug, _ = produce_subject
    r = client.post(f"/api/courses/{slug}/nodes/demo.lab/produce", json={})
    names = event_names(r)
    assert "error" in names and "done" not in names


# ---------- 工单（④） ----------


def test_ticket_recheck_resolves(client, produce_subject):
    slug, base = produce_subject
    client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={})
    # 新版：缺 workspace 的非草稿旧单 unscoped 也 409；这些用例验的是 owned 单的
    # 正常重试/复检/快改，故显式记归属（=默认工作区）。
    ticket = tickets_svc.create_ticket(
        kind="produce",
        slug=slug,
        node_id="demo.intro",
        base_label="workspace",
        problems=[],
        artifacts=["lessons/0001-demo.intro.md"],
        workspace=str(cs.workspace_dir()),
    )
    r = client.post(f"/api/tickets/{ticket['id']}/recheck", json={})
    names = event_names(r)
    assert "done" in names
    assert tickets_svc.get_ticket(ticket["id"])["status"] == "已解决"


def test_ticket_quick_edit_and_listing(client, produce_subject):
    slug, base = produce_subject
    client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={})
    ticket = tickets_svc.create_ticket(
        kind="produce",
        slug=slug,
        node_id="demo.intro",
        base_label="workspace",
        problems=[{"owner": "讲解", "path": "lessons/0001-demo.intro.md", "line": "6", "message": "示例问题"}],
        artifacts=["lessons/0001-demo.intro.md"],
        workspace=str(cs.workspace_dir()),
    )
    detail = client.get(f"/api/tickets/{ticket['id']}").json()
    assert detail["groups"]["讲解"]
    assert "base_dir" in detail
    target = base / "lessons" / "0001-demo.intro.md"
    original = target.read_text(encoding="utf-8")
    r = client.put(
        f"/api/tickets/{ticket['id']}/artifact",
        json={"path": "lessons/0001-demo.intro.md", "content": original + "\n<!-- edited -->\n"},
    )
    assert r.status_code == 200
    assert "<!-- edited -->" in target.read_text(encoding="utf-8")
    # 路径越出拒绝
    r = client.put(
        f"/api/tickets/{ticket['id']}/artifact",
        json={"path": "../escape.md", "content": "x"},
    )
    assert r.status_code == 400
    assert client.post(f"/api/tickets/{ticket['id']}/abandon").json()["ok"]
    assert tickets_svc.get_ticket(ticket["id"])["status"] == "已放弃"


# ---------- 建课链（D）与盘问收口（F） ----------


def test_interview_marker_creates_draft_and_confirm_card(client, monkeypatch):
    monkeypatch.setenv("STUDYMATE_E2E_SCENARIO", "interview")
    # fixture 一次回复即含全部 4 段（含第 4 段的收口标记），单轮即触发建课
    r = client.post("/api/chat/stream", json={"message": "帮我选方向", "mode": "interview"})
    assert "confirm" in event_names(r)
    drafts = client.get("/api/drafts").json()
    draft = next(d for d in drafts if d["name"] == "Python 实用小工具")
    slug = draft["slug"]
    assert (draft_svc.draft_dir(slug) / "MISSION.md").is_file()
    assert (draft_svc.draft_dir(slug) / "GLOSSARY.md").is_file()
    assert (draft_svc.draft_dir(slug) / "assets" / "img" / "pool").is_dir()


def test_interview_marker_invalid_json_is_surfaced(client):
    r = client.post(
        "/api/chat/stream",
        json={"message": "<!--INTERVIEW_RESULT-->{bad json}<!--/INTERVIEW_RESULT-->", "mode": "interview"},
    )
    assert "confirm" not in event_names(r)


def test_build_chain_gates_and_promotes(client, monkeypatch):
    monkeypatch.setenv("STUDYMATE_E2E_SCENARIO", "interview")
    client.delete("/api/drafts/python")  # 同名草稿可能被其他用例建过（DATA_DIR 会话级共享）
    result = client.post("/api/chat/stream", json={"message": "帮我选方向", "mode": "interview"})
    confirm = next(data for name, data in sse_events(result) if name == "confirm")
    slug = confirm["slug"]

    detail = client.get(f"/api/drafts/{slug}").json()
    assert detail["draft"]["name"] == "Python 实用小工具"

    r = client.post(f"/api/drafts/{slug}/build", json={})
    names = event_names(r)
    assert "done" in names
    # 大纲落草稿
    curriculum = draft_svc.draft_curriculum(slug)
    assert curriculum and curriculum.get("nodes")
    # 采图 stage 出现过且不阻塞（fixture 不联网）
    r2 = client.post(f"/api/drafts/{slug}/materials", json={"title": "补充资料", "text": "正文"})
    assert r2.status_code == 200
    assert (draft_svc.draft_dir(slug) / "reference" / "补充资料.md").is_file()
    # 落点确认 → 工作区科目
    r3 = client.post(f"/api/drafts/{slug}/promote", json={})
    assert r3.status_code == 200
    from app import curriculum_store as cs

    assert cs.get_subject(slug) is not None
    assert not draft_svc.draft_dir(slug).exists()


def test_fixture_interview_scenario_produces_marker(monkeypatch):
    monkeypatch.setenv("STUDYMATE_E2E_SCENARIO", "interview")
    """STUDYMATE_E2E_SCENARIO=interview 时固定流第 4 段带收口标记（E2E 依赖）。"""
    from app.llm import _fixture_segments

    assert any("INTERVIEW_RESULT" in segment for segment in _fixture_segments())


def test_generate_endpoint_uses_envelope(client):
    r = client.post(
        "/api/courses/generate",
        json={"name": "envelope科目", "purpose": "p", "level": "l", "background": "b"},
    )
    assert r.status_code == 200
    data = r.json()
    assert len(data["curriculum"]["nodes"]) == 3


def test_chat_route_injects_local_qa_only():
    """拍板⑧：关联科目的 chat 链路只注入 local-qa，不再注入 learning-system。"""
    from app import prompts

    text, missing = prompts.inject("chat")
    assert not missing
    assert '<skill name="local-qa">' in text
    assert '<skill name="learning-system">' not in text
    interview_text, missing = prompts.inject_interview()
    assert not missing
    assert '<skill name="learning-system">' in interview_text
    assert '<skill name="learning-discovery">' in interview_text
    assert "INTERVIEW_RESULT" in interview_text


def test_role_ownership_mapping():
    """FAIL 正则吃 Windows 盘符冒号后，归属仍按产物路径映射（审查 P0-1 回归锚）。"""
    from app.produce import parse_problems

    base = Path(".").resolve()
    problems = parse_problems(
        f"FAIL {base / 'lessons' / '0001-a.quiz.json'}: 题库键对不上；缺判分要点\n"
        "lessons/0001-a.md:12 内容格式错\n",
        base,
    )
    owners = {p["owner"] for p in problems}
    assert owners == {"出题", "讲解"}, owners


def test_check_stage_failure_ownership():
    """check_lesson 的 FAIL 挂在 .html 上：题库类消息归出题（拍板④的机械延伸）。"""
    from app.produce import parse_problems

    base = Path(".").resolve()
    page = base / "lessons" / "0001-a.html"
    problems = parse_problems(
        f"FAIL {page}: 缺少 .quiz[data-quiz] 题目块（每份课件至少一道题）\n"
        f"FAIL {page}: lab/solutions/ 缺失（参考答案要与任务分开放）\n",
        base,
    )
    assert {p["owner"] for p in problems} == {"出题"}


def test_produce_retries_then_hands_off(monkeypatch, client, produce_subject):
    """检查恒失败 → 两轮打回（重派）→ 耗尽建工单（拍板④核心链路）。"""
    from app import produce as produce_svc

    slug, base = produce_subject
    real = produce_svc._run_script

    async def fake_run_script(args, *_a, **_k):
        code, output = await real(args)
        if any("check_lesson.py" in str(a) for a in args):
            return 1, (
                f"FAIL {base / 'lessons' / '0001-demo.intro.html'}: "
                "缺少 .quiz[data-quiz] 题目块（每份课件至少一道题）"
            )
        return code, output

    monkeypatch.setattr(produce_svc, "_run_script", fake_run_script)
    r = client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={})
    names = event_names(r)
    assert names.count("retry") == 2
    assert "handoff" in names
    ticket = next(data for name, data in sse_events(r) if name == "handoff")["ticket"]
    assert ticket["status"] == "待处理"
    assert ticket["problems"][0]["owner"] == "出题"


def test_ticket_retry_recovers_after_failure(client, produce_subject):
    """工单重试：重派附报错原文与 hint，通过后工单关闭。"""
    slug, base = produce_subject
    client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={})
    ticket = tickets_svc.create_ticket(
        kind="produce",
        slug=slug,
        node_id="demo.intro",
        base_label="workspace",
        problems=[
            {
                "owner": "出题",
                "path": "lessons/0001-demo.intro.quiz.json",
                "line": "",
                "message": "示例问题",
            }
        ],
        artifacts=["lessons/0001-demo.intro.quiz.json"],
        workspace=str(cs.workspace_dir()),
    )
    r = client.post(f"/api/tickets/{ticket['id']}/retry", json={"hint": "题目再贴近锚点一点"})
    names = event_names(r)
    assert "done" in names
    assert tickets_svc.get_ticket(ticket["id"])["status"] == "已解决"


def test_quick_edit_rejects_absolute_path(client, produce_subject):
    """快改只认科目目录内的相对路径（绝对路径拒绝）。"""
    slug, _ = produce_subject
    client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={})
    # 新版：缺 workspace 的非草稿旧单 unscoped 也 409；这些用例验的是 owned 单的
    # 正常重试/复检/快改，故显式记归属（=默认工作区）。
    ticket = tickets_svc.create_ticket(
        kind="produce",
        slug=slug,
        node_id="demo.intro",
        base_label="workspace",
        problems=[],
        artifacts=["lessons/0001-demo.intro.md"],
        workspace=str(cs.workspace_dir()),
    )
    r = client.put(
        f"/api/tickets/{ticket['id']}/artifact",
        json={"path": "C:\\Windows\\evil.md", "content": "x"},
    )
    assert r.status_code == 400


def test_quick_edit_rejects_windows_semantic_paths(client, produce_subject):
    """快改路径判定走 unsafe_relative_reason（Windows 语义，Linux 上结论一致）。

    这三类只靠 resolve() 包含关系在 Linux 全部放过（反斜杠/冒号不是分隔与盘符语义，
    会把输入当 base 下的普通文件名，落到 404 而非 400）——正是 Linux CI 抓到的那类漏。
    """
    slug, _ = produce_subject
    client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={})
    ticket = tickets_svc.create_ticket(
        kind="produce",
        slug=slug,
        node_id="demo.intro",
        base_label="workspace",
        problems=[],
        artifacts=["lessons/0001-demo.intro.md"],
        workspace=str(cs.workspace_dir()),
    )
    for bad in ("..\\..\\evil.md", "C:evil.md", "file.txt:ads"):
        r = client.put(
            f"/api/tickets/{ticket['id']}/artifact",
            json={"path": bad, "content": "x"},
        )
        assert r.status_code == 400, f"{bad!r} 应被拒绝"


def test_draft_file_read_rejects_windows_semantic_paths(client):
    """草稿文件读取（快改的读取根）与快改同一套路径判定：越界一律 400。"""
    slug = draft_svc.create_draft("路径守卫草稿")
    try:
        (draft_svc.draft_dir(slug) / "hello.txt").write_text("hi", encoding="utf-8")
        ok = client.get(f"/api/drafts/{slug}/files/hello.txt")
        assert ok.status_code == 200
        for bad in ("..\\..\\evil.txt", "C:\\Windows\\evil.txt"):
            r = client.get(f"/api/drafts/{slug}/files/{bad}")
            assert r.status_code == 400, f"{bad!r} 应被拒绝"
    finally:
        client.delete(f"/api/drafts/{slug}")


def _real_dispatch_mode(monkeypatch):
    """关掉 fixture 短路，让 dispatch 走 roles.dispatch_role 真路径（该函数再被 monkeypatch）。

    两层都要绕：路由层的 _provider()（fixture 模式才返回假 provider）与派工层的
    is_fixture_mode()；后者否则会直接吃 fixture envelope 工厂。
    """
    from app import llm, produce
    from app.routers import production

    async def no_tool_delivery(*args, **kwargs):
        return None

    monkeypatch.setattr(produce, "_role_tool_loop", no_tool_delivery)
    monkeypatch.delenv("STUDYMATE_E2E_FIXTURE", raising=False)
    monkeypatch.setattr(llm, "_fixture_at_import", False)
    monkeypatch.setattr(
        production, "_provider", lambda: {"model": "test", "api_format": "openai_chat"}
    )


def test_produce_envelope_failure_retries_then_recovers(monkeypatch, client, produce_subject):
    """派工 envelope 畸形（模型偶发）→ 原值重派一次 → 走通（不再硬停）。"""
    from app import produce as produce_svc
    from app import roles

    _real_dispatch_mode(monkeypatch)
    calls = {"n": 0}

    async def flaky(provider, route, values, fixture_kind=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError("上游回复不是规定的 JSON envelope；上游回复开头：{oops")
        if route == "produce_quiz":
            return produce_svc.fixture_quiz_envelope(values)
        return produce_svc.fixture_content_envelope(values)

    monkeypatch.setattr(roles, "dispatch_role", flaky)
    slug, _ = produce_subject
    r = client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={})
    names = event_names(r)
    assert names.count("retry") == 1
    retry = next(data for name, data in sse_events(r) if name == "retry")
    assert retry["round"] == 1
    assert retry["owners"] == ["讲解"]
    assert retry["reason"]
    assert "done" in names
    assert calls["n"] >= 2


def test_produce_envelope_failure_exhausts(monkeypatch, client, produce_subject):
    """envelope 持续畸形 → 重派耗尽 → error 停止（不无限烧）。"""
    from app import produce as produce_svc
    from app import roles

    _real_dispatch_mode(monkeypatch)
    calls = {"n": 0}

    async def always_bad(provider, route, values, fixture_kind=None):
        calls["n"] += 1
        raise ValueError("上游回复不是规定的 JSON envelope")

    monkeypatch.setattr(roles, "dispatch_role", always_bad)
    slug, _ = produce_subject
    r = client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={})
    names = event_names(r)
    assert names.count("retry") == produce_svc.MAX_RETRIES
    assert names[-2:] == ["error", "finished"]
    error = next(data for name, data in sse_events(r) if name == "error")
    assert "连续" in error["message"]
    assert calls["n"] == produce_svc.MAX_RETRIES + 1
