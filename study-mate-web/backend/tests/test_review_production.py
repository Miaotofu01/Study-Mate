"""只读审查后授权修复的回归测试（生产编排域）。

覆盖：草稿 slug 越界、recheck 误关单、非零不可解析的兜底问题、重试状态回置、
落点后 build 工单复活幽灵草稿、SSE 持久化失败不死锁、tickets 原子写/坏文件留证、
records.write_assessment 并发序号、同名给料不覆盖、workspace 绑定。
"""
from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

import pytest

from app import curriculum_store as cs
from app import draft as draft_svc
from app import produce as produce_svc
from app import records as records_svc
from app import storage
from app import tickets as tickets_svc
from app import workspace_ctx
from app.config import DATA_DIR
from app.llm import FIXTURE_CURRICULUM
from app.routers import production


# ---------- 1. 草稿 slug 越界：404 且不触盘 ----------


def test_delete_draft_rejects_traversal_via_http(client):
    victim = DATA_DIR / "victimdir"
    victim.mkdir(parents=True, exist_ok=True)
    (victim / "keep.txt").write_text("do not delete", encoding="utf-8")

    r = client.delete("/api/drafts/..%5Cvictimdir")
    assert r.status_code == 404, r.text
    assert victim.is_dir(), "越界路径不得被删除"
    assert (victim / "keep.txt").is_file()


def test_draft_dir_rejects_bad_slug_and_symlink_escape(tmp_path):
    for bad in ("..", "../x", "a/b", "A", "x\\y", ""):
        with pytest.raises(ValueError):
            draft_svc.draft_dir(bad)

    # 符号链接指向草稿根之外：即使 slug 合法也必须拒绝
    outside = tmp_path / "outside"
    outside.mkdir()
    # 草稿根必须先存在：否则 symlink_to 会因父目录缺失抛 OSError，被误当「无权限」跳过
    # （全套先前用例恰好建过目录才 55% 概率通过——夹具自身要先建目录）
    draft_svc.DRAFTS_DIR.mkdir(parents=True, exist_ok=True)
    link = draft_svc.DRAFTS_DIR / "evil-link"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("当前环境不支持创建目录符号链接")
    try:
        with pytest.raises(ValueError):
            draft_svc.draft_dir("evil-link")
    finally:
        link.unlink(missing_ok=True)


def test_draft_routes_404_on_bad_slug(client):
    assert client.get("/api/drafts/..").status_code == 404
    assert client.post("/api/drafts/..%5Cx/build", json={}).status_code == 404
    assert client.post("/api/drafts/..%5Cx/promote", json={}).status_code == 404


# ---------- 2. recheck 不再误关单（ok=False 即使 problems=[]） ----------


def _produce_intro(client, new_subject):
    slug, base = new_subject
    assert client.put(f"/api/courses/{slug}/curriculum", json=FIXTURE_CURRICULUM).status_code == 200
    assert client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={}).status_code == 200
    return slug, base


def test_recheck_does_not_false_close_when_check_fails_unparsed(client, monkeypatch, new_subject):
    slug, _base = _produce_intro(client, new_subject)
    ticket = tickets_svc.create_ticket(
        kind="produce", slug=slug, node_id="demo.intro", base_label="workspace",
        problems=[{"owner": "出题", "path": "lessons/0001-demo.intro.quiz.json", "line": "", "message": "旧问题"}],
        artifacts=["lessons/0001-demo.intro.md"],
    )

    async def fake_fail(base, node_id, index, emit):
        return False, []  # 检查失败但解析不出问题

    monkeypatch.setattr(produce_svc, "render_and_check", fake_fail)
    r = client.post(f"/api/tickets/{ticket['id']}/recheck", json={})
    assert "done" not in [line[7:] for line in r.text.splitlines() if line.startswith("event: ")]
    assert tickets_svc.get_ticket(ticket["id"])["status"] == "待处理"


# ---------- 3. 非零退出不可解析 → 兜底问题（不产生 problems=[] 的工单） ----------


def test_render_and_check_falls_back_on_unparsed_failure(monkeypatch, tmp_path):
    from app import produce as ps

    async def fake_run_script(args):
        return 1, "Traceback (most recent call last):\nValueError: boom"

    monkeypatch.setattr(ps, "_run_script", fake_run_script)
    base = tmp_path / "subject"
    base.mkdir()

    async def noop(_event):
        return None

    ok, problems = asyncio.run(ps.render_and_check(base, "n1", 1, noop))
    assert ok is False
    assert problems and problems[0]["message"].startswith("渲染退出码 1")
    assert problems[0]["owner"] == "总控"


def test_produce_ticket_never_has_empty_problems(client, monkeypatch, new_subject):
    slug, _base = _produce_intro(client, new_subject)

    async def neither(args):
        return 1, "some unparsable output"

    monkeypatch.setattr(produce_svc, "_run_script", neither)
    # 先删掉已产出产物，让顺序门允许重产（本用例只关心打回工单内容）
    r = client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={})
    names = [line[7:] for line in r.text.splitlines() if line.startswith("event: ")]
    assert "handoff" in names
    ticket = next(t for t in tickets_svc.list_tickets(slug=slug) if t["kind"] == "produce")
    assert ticket["problems"], "非零不可解析必须带兜底问题，不能是空工单"


# ---------- 4. 重试失败/异常后状态回置「待处理」 ----------


def test_retry_park_status_on_dispatch_error(client, monkeypatch, new_subject):
    slug, _base = _produce_intro(client, new_subject)
    ticket = tickets_svc.create_ticket(
        kind="produce", slug=slug, node_id="demo.intro", base_label="workspace",
        problems=[{"owner": "出题", "path": "x", "line": "", "message": "p"}],
        artifacts=["x"],
        # 新版：缺 workspace 的非草稿旧单一律 ambiguous、unscoped 也 409；本用例验证的是
        # 派工异常后状态回置，故显式记归属，让 owned unscoped 路径照常。
        workspace=str(cs.workspace_dir()),
    )

    async def boom(*args, **kwargs):
        raise ValueError("envelope boom")

    monkeypatch.setattr(produce_svc, "dispatch", boom)
    r = client.post(f"/api/tickets/{ticket['id']}/retry", json={"hint": "h"})
    assert r.status_code == 200
    updated = tickets_svc.get_ticket(ticket["id"])
    assert updated["status"] == "待处理"
    assert updated["retries"] == 1


# ---------- 5. 落点后 build 工单重试不得复活幽灵草稿 ----------


def test_build_ticket_retry_after_promote_does_not_resurrect_draft(client, monkeypatch, new_subject):
    slug = "ghost-draft-regression"
    draft_svc.delete_draft(slug)
    draft_svc.create_draft("幽灵回归", slug=slug)
    # 模拟落点：草稿目录搬走
    target = cs.subjects_dir() / slug
    target.parent.mkdir(parents=True, exist_ok=True)
    import shutil

    shutil.move(str(draft_svc.draft_dir(slug)), str(target))

    ticket = tickets_svc.create_ticket(
        kind="build", slug=slug, node_id=None, base_label="draft",
        problems=[{"owner": "课设", "path": "curriculum.yaml", "line": "", "message": "bad"}],
        artifacts=["curriculum.yaml"],
    )
    r = client.post(f"/api/tickets/{ticket['id']}/retry", json={})
    events = [line[7:] for line in r.text.splitlines() if line.startswith("event: ")]
    assert "done" not in events
    assert not draft_svc.draft_dir(slug).exists(), "不得复活幽灵草稿"
    assert tickets_svc.get_ticket(ticket["id"])["status"] == "待处理"


# ---------- 6. SSE 持久化失败不得死锁（关键是必须收到 finished） ----------


def test_stream_orchestration_survives_persistence_failure():
    async def runner(emit):
        await emit({"event": "done", "message": "x"})  # 会话不存在：持久化必然失败

    async def main():
        resp = await production._stream_orchestration("does-not-exist", runner)
        chunks = []
        async for chunk in resp.body_iterator:
            chunks.append(chunk)
            if "finished" in chunk:
                return chunks
        return chunks

    chunks = asyncio.run(asyncio.wait_for(main(), timeout=5))
    assert any("finished" in chunk for chunk in chunks), "持久化失败也必须收尾，不能挂住 SSE"


# ---------- 7. tickets 原子写 + 坏文件留证不静默覆盖 ----------


def test_tickets_corrupt_file_is_quarantined():
    tickets_svc.TICKETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tickets_svc.TICKETS_PATH.write_text("{not valid json", encoding="utf-8")
    try:
        assert tickets_svc.list_tickets() == []
        quarantined = list(tickets_svc.TICKETS_PATH.parent.glob("tickets.json.corrupt-*"))
        assert quarantined, "坏文件必须改名留证"
        assert "not valid json" in quarantined[0].read_text(encoding="utf-8")
    finally:
        for path in tickets_svc.TICKETS_PATH.parent.glob("tickets.json.corrupt-*"):
            path.unlink(missing_ok=True)
        tickets_svc.TICKETS_PATH.unlink(missing_ok=True)


# ---------- 8. records.write_assessment 并发序号不冲突 ----------


def test_write_assessment_concurrent_sequences(monkeypatch, tmp_path):
    workspace = tmp_path / "ws"
    (workspace / ".learning" / "subjects" / "conc").mkdir(parents=True)

    real_next_seq = records_svc.next_seq

    def slow_next_seq(directory):
        import time

        time.sleep(0.005)  # 放大竞态窗口：无锁时多个线程会拿到同一序号
        return real_next_seq(directory)

    monkeypatch.setattr(records_svc, "next_seq", slow_next_seq)

    meta = {"date": "2026-01-01", "verdict": "通过", "mastery": 0.5, "questions": [], "next": "x"}
    results: list[str] = []
    lock = threading.Lock()

    def worker():
        with workspace_ctx.bind(workspace):
            rel = records_svc.write_assessment("conc", "n1", meta, "标题", "概念")
        with lock:
            results.append(rel)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(set(results)) == 8, f"并发评估序号冲突：{sorted(results)}"
    assert len(list((workspace / ".learning" / "subjects" / "conc" / "assessments").glob("*.md"))) == 8


# ---------- 9. 同名给料不静默覆盖 ----------


def test_write_material_same_title_does_not_overwrite():
    slug = "material-dedup"
    draft_svc.delete_draft(slug)
    draft_svc.create_draft("资料去重", slug=slug)
    try:
        first = draft_svc.write_material(slug, "同名资料", "# 第一份\n")
        second = draft_svc.write_material(slug, "同名资料", "# 第二份\n")
        base = draft_svc.draft_dir(slug)
        assert first != second
        assert (base / first).read_text(encoding="utf-8").strip() == "# 第一份"
        assert (base / second).read_text(encoding="utf-8").strip() == "# 第二份"
        resources = (base / "RESOURCES.md").read_text(encoding="utf-8")
        entries = [line for line in resources.splitlines() if line.startswith("- [同名资料]")]
        assert len(entries) == 2
        assert any("同名资料-2.md" in line for line in entries)
    finally:
        draft_svc.delete_draft(slug)


# ---------- 10. workspace 绑定 ----------


def _make_workspace(parent: Path, name: str, slug: str) -> Path:
    workspace = parent / name
    subject_dir = workspace / ".learning" / "subjects" / slug
    subject_dir.mkdir(parents=True)
    (subject_dir / "subject.yaml").write_text(
        f"name: {slug}\nslug: {slug}\ngoal: g\ncreated_at: '2026-01-01'\nstatus: 进行中\n",
        encoding="utf-8",
    )
    (subject_dir / "lessons").mkdir()
    (subject_dir / "lessons" / "0001-n1.md").write_text("body", encoding="utf-8")
    return workspace


def test_home_serves_bound_workspace(client, tmp_path):
    workspace = _make_workspace(tmp_path, "ws-home-bound", "home-bound")
    (workspace / "index.html").write_text("<html>bound home</html>", encoding="utf-8")

    r = client.get("/api/home/index.html", params={"workspace": str(workspace)})
    assert r.status_code == 200, r.text
    assert "bound home" in r.text


def test_ticket_dir_resolves_in_bound_workspace(client, tmp_path):
    workspace = _make_workspace(tmp_path, "ws-ticket-bound", "ticket-bound")
    ticket = tickets_svc.create_ticket(
        kind="produce", slug="ticket-bound", node_id="n1", base_label="workspace",
        problems=[{"owner": "讲解", "path": "lessons/0001-n1.md", "line": "1", "message": "m"}],
        artifacts=["lessons/0001-n1.md"], workspace=str(workspace),
    )
    detail = client.get(f"/api/tickets/{ticket['id']}", params={"workspace": str(workspace)}).json()
    assert detail["base_dir"] == str(
        (workspace / ".learning" / "subjects" / "ticket-bound").resolve()
    )
    r = client.put(
        f"/api/tickets/{ticket['id']}/artifact",
        params={"workspace": str(workspace)},
        json={"path": "lessons/0001-n1.md", "content": "edited"},
    )
    assert r.status_code == 200, r.text
    assert (workspace / ".learning" / "subjects" / "ticket-bound" / "lessons" / "0001-n1.md").read_text(
        encoding="utf-8"
    ) == "edited"


def test_generate_writes_into_bound_workspace(client, tmp_path):
    workspace = tmp_path / "ws-generate"
    workspace.mkdir()
    r = client.post(
        "/api/courses/generate",
        params={"workspace": str(workspace)},
        json={"name": "绑定生成", "purpose": "p", "level": "l", "background": "b"},
    )
    assert r.status_code == 200, r.text
    slug = r.json()["summary"]["slug"]
    assert (workspace / ".learning" / "subjects" / slug / "curriculum.yaml").is_file()


def test_list_records_skips_non_utf8_files(tmp_path):
    """非 UTF-8 记录文件不得让记录列表/开场切片 500（跳过即可）。"""
    base = tmp_path / "ws"
    lr = base / ".learning" / "subjects" / "enc" / "learning-records"
    lr.mkdir(parents=True)
    (lr / "001-bad.md").write_bytes(b"---\nnode: n1\n---\n\xff\xfe invalid \xff\n")
    (lr / "002-good.md").write_text(
        "---\ndate: '2026-01-01'\nnode: n1\n---\n\nok\n", encoding="utf-8"
    )
    with workspace_ctx.bind(base):
        records = records_svc.list_records("enc")
    files = [item["file"] for item in records["learning_records"]]
    assert "learning-records/002-good.md" in files
    assert "learning-records/001-bad.md" not in files


# ---------- 11. 工单按 workspace 归属隔离 ----------


def test_ticket_records_workspace_and_membership(tmp_path):
    workspace_a = _make_workspace(tmp_path, "ws-a-ticket", "same-slug")
    workspace_b = tmp_path / "ws-b-ticket"
    (workspace_b / ".learning" / "subjects").mkdir(parents=True)
    (workspace_a / ".learning" / "subjects" / "same-slug").mkdir(exist_ok=True)

    ticket = tickets_svc.create_ticket(
        kind="produce", slug="same-slug", node_id="n1", base_label="workspace",
        problems=[], artifacts=[], workspace=str(workspace_a),
    )
    try:
        assert tickets_svc.ticket_workspace(ticket) == str(workspace_a)
        assert tickets_svc.matches_workspace(ticket, str(workspace_a)) is True
        assert tickets_svc.matches_workspace(ticket, str(workspace_b)) is False
        # 归属路径直接决定 base：即便当前全局绑定是另一处，也落回工单自己的工作区
        assert tickets_svc.ticket_dir_base(ticket) == workspace_a / ".learning" / "subjects" / "same-slug"
    finally:
        tickets_svc.update_ticket(ticket["id"], status="已放弃")


def test_ticket_detail_and_list_filter_by_workspace(client, tmp_path):
    workspace = _make_workspace(tmp_path, "ws-ticket-filter", "filtered")
    ticket = tickets_svc.create_ticket(
        kind="produce", slug="filtered", node_id="n1", base_label="workspace",
        problems=[], artifacts=[], workspace=str(workspace),
    )
    other = tmp_path / "ws-other-filter"
    (other / ".learning" / "subjects").mkdir(parents=True)

    detail = client.get(f"/api/tickets/{ticket['id']}", params={"workspace": str(workspace)}).json()
    assert detail["workspace"] == str(workspace)
    # 请求别的工作区：不得切过去操作，直接 404
    assert client.get(f"/api/tickets/{ticket['id']}", params={"workspace": str(other)}).status_code == 404
    listed_ids = {t["id"] for t in client.get("/api/tickets", params={"workspace": str(workspace)}).json()}
    assert ticket["id"] in listed_ids
    assert ticket["id"] not in {
        t["id"] for t in client.get("/api/tickets", params={"workspace": str(other)}).json()
    }


def test_legacy_ticket_without_workspace_always_ambiguous(client, tmp_path):
    """旧工作区工单（无归属）：统一 ambiguous，不再按默认区同 slug 自动认领。

    与旧版区别：授权显式确认流程后，缺 workspace 的非草稿旧单即使默认工作区存在
    同名科目也不能证明归属；一律待确认（只读 + base_dir=None），须显式认领或放弃。
    """
    slug = "legacy-safe-slug"
    non_default = _make_workspace(tmp_path, "ws-legacy-nondefault", slug)
    legacy = tickets_svc.create_ticket(
        kind="produce", slug=slug, node_id="n1", base_label="workspace",
        problems=[], artifacts=[],
    )
    assert tickets_svc.ticket_workspace(legacy) is None

    # 默认工作区即便有同名科目，也不构成归属证明
    default = cs.workspace_dir()
    (default / ".learning" / "subjects" / slug).mkdir(parents=True, exist_ok=True)
    for workspace in (non_default, default):
        assert tickets_svc.ticket_ownership(legacy, str(workspace)) == "ambiguous"
        assert tickets_svc.matches_workspace(legacy, str(workspace)) is False
        detail = client.get(
            f"/api/tickets/{legacy['id']}", params={"workspace": str(workspace)}
        ).json()
        assert detail["workspace_ambiguous"] is True
        assert detail["base_dir"] is None


def test_legacy_draft_ticket_visible_in_any_workspace_scope(client, tmp_path):
    """旧草稿单（无归属、base_label=draft）：草稿区全局，任何 workspace scope 可见可操作。"""
    slug = "legacy-draft-scope"
    draft_svc.delete_draft(slug)
    draft_svc.create_draft("旧草稿", slug=slug)
    ticket = tickets_svc.create_ticket(
        kind="build", slug=slug, node_id=None, base_label="draft",
        problems=[{"owner": "课设", "path": "curriculum.yaml", "line": "", "message": "m"}],
        artifacts=["curriculum.yaml"],
    )
    try:
        assert tickets_svc.ticket_workspace(ticket) is None
        assert tickets_svc.ticket_ownership(ticket, str(tmp_path / "any")) == "legacy_draft"
        other = _make_workspace(tmp_path, "ws-scope-other", "scope-other")
        ids = {t["id"] for t in client.get("/api/tickets", params={"workspace": str(other)}).json()}
        assert ticket["id"] in ids
        detail = client.get(
            f"/api/tickets/{ticket['id']}", params={"workspace": str(other)}
        ).json()
        assert Path(detail["base_dir"]).resolve() == draft_svc.draft_dir(slug).resolve()
    finally:
        tickets_svc.update_ticket(ticket["id"], status="已放弃")
        draft_svc.delete_draft(slug)


def test_legacy_same_slug_two_workspaces_cannot_write_either(client, tmp_path):
    """A/B 同 slug 的旧工单：模糊归属必须 409 阻断，绝不按请求写到任一边。"""
    slug = "dual-slug"
    ws_a = _make_workspace(tmp_path, "ws-dual-a", slug)
    ws_b = _make_workspace(tmp_path, "ws-dual-b", slug)
    legacy = tickets_svc.create_ticket(
        kind="produce", slug=slug, node_id="n1", base_label="workspace",
        problems=[{"owner": "讲解", "path": "lessons/0001-n1.md", "line": "", "message": "m"}],
        artifacts=["lessons/0001-n1.md"],
    )
    try:
        for workspace in (ws_a, ws_b):
            assert tickets_svc.ticket_ownership(legacy, str(workspace)) == "ambiguous"
            # 模糊归属仍可只读查看（带标记、不给 base_dir），但绝不提供写入目录
            detail = client.get(
                f"/api/tickets/{legacy['id']}", params={"workspace": str(workspace)}
            ).json()
            assert detail["workspace_ambiguous"] is True
            assert detail["base_dir"] is None
            r = client.put(
                f"/api/tickets/{legacy['id']}/artifact",
                params={"workspace": str(workspace)},
                json={"path": "lessons/0001-n1.md", "content": "HACK"},
            )
            assert r.status_code == 409, (workspace, r.status_code)
            target = workspace / ".learning" / "subjects" / slug / "lessons" / "0001-n1.md"
            assert target.read_text(encoding="utf-8") == "body", "不得被误写"
            # 默认 scoped 列表只列「本区确有同 slug 科目/节点」的可认领单；本 fixture 缺
            # curriculum.yaml（无该节点）→ 不可认领故不列。include_unscoped=true 则作为
            # 未知旧单一并列出（标明 ambiguous），避免目标缺失的旧单不可达。
            ids = {t["id"] for t in client.get("/api/tickets", params={"workspace": str(workspace)}).json()}
            assert legacy["id"] not in ids, "不可认领的旧单默认不列"
            unassigned = client.get(
                "/api/tickets",
                params={"workspace": str(workspace), "include_unscoped": "true"},
            ).json()
            item = next(t for t in unassigned if t["id"] == legacy["id"])
            assert item["workspace_ambiguous"] is True
        # 明确 404 的情况仍然 404（有归属但属于别处）
        owned = tickets_svc.create_ticket(
            kind="produce", slug=slug, node_id="n1", base_label="workspace",
            problems=[], artifacts=[], workspace=str(ws_a),
        )
        assert client.put(
            f"/api/tickets/{owned['id']}/artifact",
            params={"workspace": str(ws_b)},
            json={"path": "lessons/0001-n1.md", "content": "x"},
        ).status_code == 404
        tickets_svc.update_ticket(owned["id"], status="已放弃")
    finally:
        tickets_svc.update_ticket(legacy["id"], status="已放弃")


def test_recheck_uses_ticket_owned_workspace_without_query(client, monkeypatch, tmp_path):
    """不带 ?workspace= 时，recheck 也必须落到工单记录的工作区（不能回全局）。"""
    workspace = _make_workspace(tmp_path, "ws-owned-recheck", "owned-recheck")
    subject = workspace / ".learning" / "subjects" / "owned-recheck"
    (subject / "curriculum.yaml").write_text(
        "nodes:\n- id: n1\n  title: t\n  kind: 概念\n  objective: o\nedges: []\n",
        encoding="utf-8",
    )
    ticket = tickets_svc.create_ticket(
        kind="produce", slug="owned-recheck", node_id="n1", base_label="workspace",
        problems=[{"owner": "讲解", "path": "lessons/0001-n1.md", "line": "", "message": "m"}],
        artifacts=["lessons/0001-n1.md"], workspace=str(workspace),
    )

    async def fake_ok(base, node_id, index, emit):
        assert base == subject, f"recheck 落在错误目录：{base}"
        return True, []

    monkeypatch.setattr(produce_svc, "render_and_check", fake_ok)
    r = client.post(f"/api/tickets/{ticket['id']}/recheck", json={})
    assert "done" in [line[7:] for line in r.text.splitlines() if line.startswith("event: ")]
    assert tickets_svc.get_ticket(ticket["id"])["status"] == "已解决"


def test_retry_rejects_mismatched_workspace(client, tmp_path):
    workspace = _make_workspace(tmp_path, "ws-owned-retry", "owned-retry")
    ticket = tickets_svc.create_ticket(
        kind="produce", slug="owned-retry", node_id="n1", base_label="workspace",
        problems=[], artifacts=[], workspace=str(workspace),
    )
    other = tmp_path / "ws-wrong-retry"
    (other / ".learning" / "subjects").mkdir(parents=True)
    r = client.post(
        f"/api/tickets/{ticket['id']}/retry", params={"workspace": str(other)}, json={}
    )
    assert r.status_code == 404


def test_real_produce_failure_ticket_records_workspace_and_roundtrips(client, monkeypatch, new_subject):
    """真实 run_produce 失败落单 → GET/list/retry 带 workspace 全链路可用。

    这条专抓「工单 workspace 记成 <WS>/.learning 而非 <WS>」的层级错误：
    手工建单测试测不出，只有真实产课失败落单才带时间戳路径。
    """
    slug, base = new_subject
    assert client.put(f"/api/courses/{slug}/curriculum", json=FIXTURE_CURRICULUM).status_code == 200
    workspace = cs.workspace_dir()
    subject_dir = base.resolve()

    async def fail(base_arg, node_id, index, emit):
        return False, [{"path": "lessons/x.md", "line": "1", "message": "boom", "owner": "讲解"}]

    monkeypatch.setattr(produce_svc, "render_and_check", fail)
    r = client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={})
    events = [line[7:] for line in r.text.splitlines() if line.startswith("event: ")]
    assert "handoff" in events, events

    ticket = next(t for t in tickets_svc.list_tickets(slug=slug) if t["kind"] == "produce")
    assert Path(ticket["workspace"]).resolve() == workspace.resolve(), ticket["workspace"]
    assert tickets_svc.matches_workspace(ticket, str(workspace)) is True
    assert tickets_svc.ticket_dir_base(ticket).resolve() == subject_dir

    # 列表 / 详情按工作区可见，base_dir 不复读 .learning
    ids = {t["id"] for t in client.get("/api/tickets", params={"workspace": str(workspace)}).json()}
    assert ticket["id"] in ids
    detail = client.get(f"/api/tickets/{ticket['id']}", params={"workspace": str(workspace)}).json()
    assert Path(detail["workspace"]).resolve() == workspace.resolve()
    assert Path(detail["base_dir"]).resolve() == subject_dir

    # 重试能真正读到该科目（节点存在、渲染通过）→ 关单
    async def ok(base_arg, node_id, index, emit):
        assert base_arg.resolve() == subject_dir, base_arg
        return True, []

    monkeypatch.setattr(produce_svc, "render_and_check", ok)
    r2 = client.post(
        f"/api/tickets/{ticket['id']}/retry", params={"workspace": str(workspace)}, json={}
    )
    events2 = [line[7:] for line in r2.text.splitlines() if line.startswith("event: ")]
    assert "done" in events2, events2
    assert tickets_svc.get_ticket(ticket["id"])["status"] == "已解决"


# ---------- 12. export 失败保旧导出 ----------


def test_export_failure_keeps_previous_export(client, monkeypatch, new_subject):
    from app.routers import export as export_mod

    slug, _base = new_subject
    assert client.put(f"/api/courses/{slug}/curriculum", json=FIXTURE_CURRICULUM).status_code == 200
    first = client.post(f"/api/courses/{slug}/export")
    assert first.status_code == 200, first.text
    export_root = DATA_DIR / "exports" / slug
    old_index = (export_root / "index.html").read_text(encoding="utf-8")

    class _FakeProc:
        returncode = 1
        stdout = ""
        stderr = "gen_home boom"

    monkeypatch.setattr(export_mod.subprocess, "run", lambda *a, **k: _FakeProc())
    second = client.post(f"/api/courses/{slug}/export")
    assert second.status_code == 500, second.text
    # 旧导出必须原样保留，暂存目录清干净
    assert (export_root / "index.html").read_text(encoding="utf-8") == old_index
    assert not list((DATA_DIR / "exports").glob(f".{slug}.tmp-*"))



