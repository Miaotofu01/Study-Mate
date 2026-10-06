"""旧工单最小恢复流程的定向回归：归属未确认 → 显式认领/直接放弃。

覆盖最小旅程：
- 归属未知旧单在带 workspace 的列表/详情里一致可见且只读（scoped 与 unscoped 统一）；
- 显式选择工作区 B 认领后归属持久化，重试只落 B、A 纹丝不动；
- 目标不合法（无科目/缺节点/无路径）拒绝且无副作用；
- 两次认领互斥、幂等；工单任务在飞时认领/放弃被拒（ticket-level lease）；
- 可直接放弃（仅状态、不触课程产物），其它工作区的工单不被 scope bypass；
- 旧草稿单 / 新 owned 单行为兼容。

全部走 temp 工作区与 fixture/monkeypatch，不跑真实模型、不碰开发数据。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app import concurrency
from app import draft as draft_svc
from app import tickets as tickets_svc


@pytest.fixture(autouse=True)
def _clean_concurrency_registry():
    concurrency.reset()
    yield
    concurrency.reset()


def _make_workspace(parent: Path, name: str, slug: str, node_id: str, marker: str) -> Path:
    """造一个合法工作区：subject.yaml + 含该 node 的 curriculum.yaml + 一份课件。"""
    workspace = parent / name
    subject = workspace / ".learning" / "subjects" / slug
    (subject / "lessons").mkdir(parents=True)
    (subject / "subject.yaml").write_text(
        f"name: {slug}\nslug: {slug}\ngoal: g\ncreated_at: '2026-01-01'\nstatus: 进行中\n",
        encoding="utf-8",
    )
    (subject / "curriculum.yaml").write_text(
        "nodes:\n"
        f"- id: {node_id}\n"
        "  title: t\n  kind: 概念\n  objective: o\n"
        "edges: []\n",
        encoding="utf-8",
    )
    (subject / "lessons" / f"0001-{node_id}.md").write_text(marker, encoding="utf-8")
    return workspace


def _subject_dir(workspace: Path, slug: str) -> Path:
    return workspace / ".learning" / "subjects" / slug


def _legacy_ticket(slug: str, node_id: str, path: str = "lessons/0001-n1.md"):
    return tickets_svc.create_ticket(
        kind="produce",
        slug=slug,
        node_id=node_id,
        base_label="workspace",
        problems=[{"owner": "讲解", "path": path, "line": "1", "message": "m"}],
        artifacts=[path],
    )


def _ids(response) -> set[str]:
    return {t["id"] for t in response.json()}


def test_ambiguous_visible_readonly_consistent_scoped_and_unscoped(client, tmp_path):
    slug, node = "dual-slug", "n1"
    ws_a = _make_workspace(tmp_path, "ws-a", slug, node, "body-A")
    ws_b = _make_workspace(tmp_path, "ws-b", slug, node, "body-B")
    legacy = _legacy_ticket(slug, node)
    try:
        # 带 workspace 的列表：A/B 两侧都可发现，且一致标为 ambiguous（不冒充 belongs）
        for ws in (ws_a, ws_b):
            listed = client.get("/api/tickets", params={"workspace": str(ws)}).json()
            item = next(t for t in listed if t["id"] == legacy["id"])
            assert item["ownership"] == "ambiguous"
            assert item["workspace_ambiguous"] is True
            assert item["workspace"] is None

        # 详情 scoped 与 unscoped 一致：只读、无 base_dir
        for params in ({"workspace": str(ws_a)}, {"workspace": str(ws_b)}, None):
            detail = client.get(f"/api/tickets/{legacy['id']}", params=params or {}).json()
            assert detail["ownership"] == "ambiguous"
            assert detail["workspace_ambiguous"] is True
            assert detail["base_dir"] is None

        # 只读：快改与重试都被 409 阻断，两个工作区文件都不动
        for ws in (ws_a, ws_b):
            r = client.put(
                f"/api/tickets/{legacy['id']}/artifact",
                params={"workspace": str(ws)},
                json={"path": f"lessons/0001-{node}.md", "content": "HACK"},
            )
            assert r.status_code == 409, (ws, r.status_code)
            r2 = client.post(
                f"/api/tickets/{legacy['id']}/retry",
                params={"workspace": str(ws)},
                json={},
            )
            assert r2.status_code == 409, (ws, r2.status_code)
        assert (_subject_dir(ws_a, slug) / "lessons" / f"0001-{node}.md").read_text(
            encoding="utf-8"
        ) == "body-A"
        assert (_subject_dir(ws_b, slug) / "lessons" / f"0001-{node}.md").read_text(
            encoding="utf-8"
        ) == "body-B"
    finally:
        tickets_svc.update_ticket(legacy["id"], status="已放弃")


def test_claim_persists_then_retry_only_target_workspace(client, tmp_path, monkeypatch):
    from app.routers import production

    slug, node = "claim-slug", "n1"
    ws_a = _make_workspace(tmp_path, "claim-a", slug, node, "body-A")
    ws_b = _make_workspace(tmp_path, "claim-b", slug, node, "body-B")
    legacy = _legacy_ticket(slug, node, path=f"lessons/0001-{node}.md")
    try:
        r = client.post(
            f"/api/tickets/{legacy['id']}/claim",
            json={"workspace": str(ws_b)},
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["ok"] is True
        assert Path(data["ticket"]["workspace"]).resolve() == ws_b.resolve()
        assert data["ticket"]["ownership"] == "owned"
        assert data["ticket"]["workspace_ambiguous"] is False
        assert Path(data["ticket"]["base_dir"]).resolve() == _subject_dir(ws_b, slug).resolve()
        # 归属真落盘
        assert Path(tickets_svc.get_ticket(legacy["id"])["workspace"]).resolve() == ws_b.resolve()

        # B 侧 owned；A 侧变 other → 列表不含、详情 404（不泄露）
        assert legacy["id"] in _ids(client.get("/api/tickets", params={"workspace": str(ws_b)}))
        assert legacy["id"] not in _ids(client.get("/api/tickets", params={"workspace": str(ws_a)}))
        assert client.get(
            f"/api/tickets/{legacy['id']}", params={"workspace": str(ws_a)}
        ).status_code == 404
        owned_b = client.get(
            f"/api/tickets/{legacy['id']}", params={"workspace": str(ws_b)}
        ).json()
        assert owned_b["ownership"] == "owned"

        # 重试只落 B：runner 写的目标由工单归属决定
        async def fake_retry(ticket_id, provider, emit, hint=None):
            ticket = tickets_svc.get_ticket(ticket_id)
            base = tickets_svc.ticket_dir_base(ticket)
            (base / "lessons" / f"0001-{node}.md").write_text("RETRIED", encoding="utf-8")
            tickets_svc.update_ticket(ticket_id, status="已解决")
            await emit({"event": "done", "stage": "retry", "message": "ok"})

        monkeypatch.setattr(production.produce_svc, "run_ticket_retry", fake_retry)
        r2 = client.post(f"/api/tickets/{legacy['id']}/retry", json={})
        assert r2.status_code == 200
        assert "done" in [line[7:] for line in r2.text.splitlines() if line.startswith("event: ")]
        assert (_subject_dir(ws_b, slug) / "lessons" / f"0001-{node}.md").read_text(
            encoding="utf-8"
        ) == "RETRIED"
        assert (_subject_dir(ws_a, slug) / "lessons" / f"0001-{node}.md").read_text(
            encoding="utf-8"
        ) == "body-A", "A 不得被误改"
    finally:
        tickets_svc.update_ticket(legacy["id"], status="已放弃")


def test_claim_rejects_invalid_target_without_side_effects(client, tmp_path):
    slug, node = "claim-invalid", "n1"
    ws_ok = _make_workspace(tmp_path, "claim-ok", slug, node, "body")
    legacy = _legacy_ticket(slug, node)
    try:
        # 目标目录不存在 → 422
        assert client.post(
            f"/api/tickets/{legacy['id']}/claim",
            json={"workspace": str(tmp_path / "no-such-ws")},
        ).status_code == 422
        # 空路径 → 422
        assert client.post(
            f"/api/tickets/{legacy['id']}/claim", json={"workspace": ""}
        ).status_code == 422
        # 存在但无同 slug 科目 → 422
        bare = tmp_path / "bare-ws"
        (bare / ".learning" / "subjects").mkdir(parents=True)
        assert client.post(
            f"/api/tickets/{legacy['id']}/claim", json={"workspace": str(bare)}
        ).status_code == 422
        # 有科目但缺该节点 → 422
        ws_nonode = _make_workspace(tmp_path, "claim-nonode", slug, "other-node", "body")
        assert client.post(
            f"/api/tickets/{legacy['id']}/claim", json={"workspace": str(ws_nonode)}
        ).status_code == 422

        # 全部失败不得留下任何副作用：归属仍未确认、无 base_dir、文件未动
        assert tickets_svc.get_ticket(legacy["id"])["workspace"] is None
        detail = client.get(f"/api/tickets/{legacy['id']}").json()
        assert detail["workspace_ambiguous"] is True and detail["base_dir"] is None
        assert (_subject_dir(ws_ok, slug) / "lessons" / f"0001-{node}.md").read_text(
            encoding="utf-8"
        ) == "body"
    finally:
        tickets_svc.update_ticket(legacy["id"], status="已放弃")


def test_claim_conflict_idempotent_and_rebind_rejected(client, tmp_path):
    slug, node = "claim-conflict", "n1"
    ws_a = _make_workspace(tmp_path, "conf-a", slug, node, "body")
    ws_b = _make_workspace(tmp_path, "conf-b", slug, node, "body")
    legacy = _legacy_ticket(slug, node)
    try:
        first = client.post(
            f"/api/tickets/{legacy['id']}/claim", json={"workspace": str(ws_a)}
        )
        assert first.status_code == 200
        # 相同归属幂等接受
        again = client.post(
            f"/api/tickets/{legacy['id']}/claim", json={"workspace": str(ws_a)}
        )
        assert again.status_code == 200
        assert Path(tickets_svc.get_ticket(legacy["id"])["workspace"]).resolve() == ws_a.resolve()
        # 跨区重绑拒绝
        assert client.post(
            f"/api/tickets/{legacy['id']}/claim", json={"workspace": str(ws_b)}
        ).status_code == 409
        assert Path(tickets_svc.get_ticket(legacy["id"])["workspace"]).resolve() == ws_a.resolve()
    finally:
        tickets_svc.update_ticket(legacy["id"], status="已放弃")


def test_claim_and_abandon_rejected_while_ticket_task_in_flight(client, tmp_path):
    slug, node = "claim-busy", "n1"
    ws = _make_workspace(tmp_path, "busy-ws", slug, node, "body")
    legacy = _legacy_ticket(slug, node)
    key = concurrency.ticket_key(legacy["id"])
    concurrency.acquire(key, "某任务在飞")
    try:
        assert client.post(
            f"/api/tickets/{legacy['id']}/claim", json={"workspace": str(ws)}
        ).status_code == 409
        assert client.post(f"/api/tickets/{legacy['id']}/abandon", json={}).status_code == 409
        assert client.post(f"/api/tickets/{legacy['id']}/retry", json={}).status_code == 409
        assert client.put(
            f"/api/tickets/{legacy['id']}/artifact",
            json={"path": f"lessons/0001-{node}.md", "content": "x"},
        ).status_code == 409
        # 拒绝期间不得有任何状态变更
        assert tickets_svc.get_ticket(legacy["id"])["workspace"] is None
        assert tickets_svc.get_ticket(legacy["id"])["status"] == "待处理"
    finally:
        concurrency.release(key)
    # 释放后认领恢复正常
    assert client.post(
        f"/api/tickets/{legacy['id']}/claim", json={"workspace": str(ws)}
    ).status_code == 200
    tickets_svc.update_ticket(legacy["id"], status="已放弃")


def test_abandon_unknown_legacy_status_only(client, tmp_path):
    slug, node = "abandon-slug", "n1"
    ws_a = _make_workspace(tmp_path, "aband-a", slug, node, "body-A")
    ws_b = _make_workspace(tmp_path, "aband-b", slug, node, "body-B")
    legacy = _legacy_ticket(slug, node, path=f"lessons/0001-{node}.md")
    try:
        r = client.post(
            f"/api/tickets/{legacy['id']}/abandon",
            params={"workspace": str(ws_a)},
            json={"reason": "外部已处理，无法确认归属"},
        )
        assert r.status_code == 200, r.text
        stored = tickets_svc.get_ticket(legacy["id"])
        assert stored["status"] == "已放弃"
        assert stored["workspace"] is None, "放弃不得改归属"
        assert stored["close_reason"] == "外部已处理，无法确认归属"
        # 不触课程产物
        for ws, marker in ((ws_a, "body-A"), (ws_b, "body-B")):
            assert (_subject_dir(ws, slug) / "lessons" / f"0001-{node}.md").read_text(
                encoding="utf-8"
            ) == marker

        # 另一张 owned 工单：用别的工作区 scoped 放弃 → 404，不被 scope bypass
        owned = tickets_svc.create_ticket(
            kind="produce", slug=slug, node_id=node, base_label="workspace",
            problems=[], artifacts=[], workspace=str(ws_a),
        )
        assert client.post(
            f"/api/tickets/{owned['id']}/abandon", params={"workspace": str(ws_b)}
        ).status_code == 404
        assert tickets_svc.get_ticket(owned["id"])["status"] == "待处理"
        tickets_svc.update_ticket(owned["id"], status="已放弃")
    finally:
        tickets_svc.update_ticket(legacy["id"], status="已放弃")


def test_include_unscoped_reachability_and_owned_other_hidden(client, tmp_path):
    """目标科目已删除的未知旧单仍可达：include_unscoped=true 额外列出（绕过 slug 筛选，
    原 slug 保留在字段里），可直接放弃；owned-other 在任何模式下都不泄露。"""
    slug, node = "gone-subject", "n1"
    ws_other = _make_workspace(tmp_path, "unsc-other", "other-slug", "n1", "body")
    ws_owner = _make_workspace(tmp_path, "unsc-owner", "owned-slug", "n1", "body")
    legacy = _legacy_ticket(slug, node)
    owned = tickets_svc.create_ticket(
        kind="produce", slug="owned-slug", node_id="n1", base_label="workspace",
        problems=[], artifacts=[], workspace=str(ws_owner),
    )
    try:
        # 默认 scoped：目标不存在 → 不可认领故不列；owned-other 不列
        ids = _ids(client.get("/api/tickets", params={"workspace": str(ws_other)}))
        assert legacy["id"] not in ids
        assert owned["id"] not in ids

        # include_unscoped=true：未知单即使 slug 不匹配、目标已删也列出；owned-other 仍不列
        resp = client.get(
            "/api/tickets",
            params={
                "workspace": str(ws_other),
                "slug": "some-current-subject",
                "include_unscoped": "true",
            },
        )
        items = {t["id"]: t for t in resp.json()}
        assert legacy["id"] in items
        assert items[legacy["id"]]["workspace_ambiguous"] is True
        assert items[legacy["id"]]["slug"] == slug
        assert owned["id"] not in items, "owned-other 绝不泄露"

        # 目标已删的未知单可直接放弃（仅状态）
        assert client.post(f"/api/tickets/{legacy['id']}/abandon", json={}).status_code == 200
        assert tickets_svc.get_ticket(legacy["id"])["status"] == "已放弃"
    finally:
        tickets_svc.update_ticket(legacy["id"], status="已放弃")
        tickets_svc.update_ticket(owned["id"], status="已放弃")


def test_claim_closed_not_revived_owned_idempotent(client, tmp_path):
    slug, node = "closed-slug", "n1"
    ws = _make_workspace(tmp_path, "closed-ws", slug, node, "body")
    legacy = _legacy_ticket(slug, node)
    try:
        for closed in ("已放弃", "已解决"):
            tickets_svc.update_ticket(legacy["id"], status=closed)
            assert client.post(
                f"/api/tickets/{legacy['id']}/claim", json={"workspace": str(ws)}
            ).status_code == 409, closed
            stored = tickets_svc.get_ticket(legacy["id"])
            assert stored["workspace"] is None, "已关闭单不得被认领复活"
            assert stored["status"] == closed, "关闭状态保持"
    finally:
        tickets_svc.update_ticket(legacy["id"], status="已放弃")

    # owned 且同目标：幂等接受（即便已关闭也不改状态/归属）
    slug2, node2 = "closed-owned", "n1"
    ws2 = _make_workspace(tmp_path, "closed-owned-ws", slug2, node2, "body")
    owned = tickets_svc.create_ticket(
        kind="produce", slug=slug2, node_id=node2, base_label="workspace",
        problems=[], artifacts=[], workspace=str(ws2),
    )
    try:
        tickets_svc.update_ticket(owned["id"], status="已解决")
        r = client.post(f"/api/tickets/{owned['id']}/claim", json={"workspace": str(ws2)})
        assert r.status_code == 200, r.text
        assert Path(r.json()["ticket"]["workspace"]).resolve() == ws2.resolve()
        assert tickets_svc.get_ticket(owned["id"])["status"] == "已解决"
    finally:
        tickets_svc.update_ticket(owned["id"], status="已放弃")


def test_unscoped_writes_on_unknown_ticket_rejected_no_side_effects(client, tmp_path):
    """不带 ?workspace= 也绝不能默认猜归属：unknown 单的 retry/recheck/quickedit 一律 409。

    特意让解析出的默认工作区也存在同 slug 同节点，证明旧实现的「回落默认」是猜测；
    新守卫按 ticket_ownership 统一收口。同时验证拒绝无副作用、不建 session、租约释放。
    """
    from app import curriculum_store as cs
    from app import storage

    slug, node = "unsc-write", "n1"
    ws_a = _make_workspace(tmp_path, "unscw-a", slug, node, "body-A")
    ws_b = _make_workspace(tmp_path, "unscw-b", slug, node, "body-B")
    default_subject = cs.workspace_dir() / ".learning" / "subjects" / slug
    (default_subject / "lessons").mkdir(parents=True)
    (default_subject / "subject.yaml").write_text(
        f"name: {slug}\nslug: {slug}\ngoal: g\ncreated_at: '2026-01-01'\nstatus: 进行中\n",
        encoding="utf-8",
    )
    (default_subject / "curriculum.yaml").write_text(
        f"nodes:\n- id: {node}\n  title: t\n  kind: 概念\n  objective: o\nedges: []\n",
        encoding="utf-8",
    )
    (default_subject / "lessons" / f"0001-{node}.md").write_text("body-default", encoding="utf-8")

    legacy = _legacy_ticket(slug, node, path=f"lessons/0001-{node}.md")
    try:
        sessions_before = len(storage.list_sessions())

        r = client.put(
            f"/api/tickets/{legacy['id']}/artifact",
            json={"path": f"lessons/0001-{node}.md", "content": "HACK"},
        )
        assert r.status_code == 409, r.text
        assert (default_subject / "lessons" / f"0001-{node}.md").read_text(
            encoding="utf-8"
        ) == "body-default", "默认区不得被猜测写入"

        assert client.post(f"/api/tickets/{legacy['id']}/retry", json={}).status_code == 409
        assert client.post(f"/api/tickets/{legacy['id']}/recheck", json={}).status_code == 409

        assert len(storage.list_sessions()) == sessions_before, "被拒请求不得创建 session"
        stored = tickets_svc.get_ticket(legacy["id"])
        assert stored["workspace"] is None and stored["status"] == "待处理"
        for ws, marker in ((ws_a, "body-A"), (ws_b, "body-B"), (None, "body-default")):
            base = default_subject if ws is None else _subject_dir(ws, slug)
            assert (base / "lessons" / f"0001-{node}.md").read_text(encoding="utf-8") == marker
        assert not concurrency.is_active(concurrency.ticket_key(legacy["id"])), "失败必须释放工单租约"
        assert not concurrency.is_active(
            concurrency.produce_key(default_subject, node)
        ), "未占用的产课键不得残留"
    finally:
        tickets_svc.update_ticket(legacy["id"], status="已放弃")

    # owned unscoped 回归：按记录归属照常写，落记录工作区（不依赖请求 scope）
    owned = tickets_svc.create_ticket(
        kind="produce", slug=slug, node_id=node, base_label="workspace",
        problems=[], artifacts=[f"lessons/0001-{node}.md"], workspace=str(ws_b),
    )
    try:
        ok = client.put(
            f"/api/tickets/{owned['id']}/artifact",
            json={"path": f"lessons/0001-{node}.md", "content": "edited-owned"},
        )
        assert ok.status_code == 200, ok.text
        assert (_subject_dir(ws_b, slug) / "lessons" / f"0001-{node}.md").read_text(
            encoding="utf-8"
        ) == "edited-owned"
        assert (_subject_dir(ws_a, slug) / "lessons" / f"0001-{node}.md").read_text(
            encoding="utf-8"
        ) == "body-A"
        detail = client.get(f"/api/tickets/{owned['id']}").json()
        assert Path(detail["base_dir"]).resolve() == _subject_dir(ws_b, slug).resolve()
    finally:
        tickets_svc.update_ticket(owned["id"], status="已放弃")


def test_legacy_draft_and_new_owned_compat(client, tmp_path):
    # 旧草稿单：任何 scope 可见且可读，base_dir 指草稿区；认领被拒（全局草稿）
    slug = "legacy-draft-compat"
    draft_svc.delete_draft(slug)
    draft_svc.create_draft("旧草稿", slug=slug)
    draft_ticket = tickets_svc.create_ticket(
        kind="build", slug=slug, node_id=None, base_label="draft",
        problems=[{"owner": "课设", "path": "curriculum.yaml", "line": "", "message": "m"}],
        artifacts=["curriculum.yaml"],
    )
    other = tmp_path / "compat-other"
    (other / ".learning" / "subjects").mkdir(parents=True)
    try:
        detail = client.get(
            f"/api/tickets/{draft_ticket['id']}", params={"workspace": str(other)}
        ).json()
        assert detail["ownership"] == "legacy_draft"
        assert detail["workspace_ambiguous"] is False
        assert Path(detail["base_dir"]).resolve() == draft_svc.draft_dir(slug).resolve()
        assert client.post(
            f"/api/tickets/{draft_ticket['id']}/claim", json={"workspace": str(other)}
        ).status_code == 409
    finally:
        tickets_svc.update_ticket(draft_ticket["id"], status="已放弃")
        draft_svc.delete_draft(slug)

    # 新 owned 单：正常归属，别的 scope 404
    slug2, node2 = "owned-compat", "n1"
    ws = _make_workspace(tmp_path, "owned-ws", slug2, node2, "body")
    owned = tickets_svc.create_ticket(
        kind="produce", slug=slug2, node_id=node2, base_label="workspace",
        problems=[], artifacts=[], workspace=str(ws),
    )
    try:
        detail = client.get(f"/api/tickets/{owned['id']}", params={"workspace": str(ws)}).json()
        assert detail["ownership"] == "owned"
        assert detail["workspace_ambiguous"] is False
        detail_unscoped = client.get(f"/api/tickets/{owned['id']}").json()
        assert Path(detail_unscoped["base_dir"]).resolve() == _subject_dir(ws, slug2).resolve()
        other2 = tmp_path / "owned-other"
        (other2 / ".learning" / "subjects").mkdir(parents=True)
        assert client.get(
            f"/api/tickets/{owned['id']}", params={"workspace": str(other2)}
        ).status_code == 404
    finally:
        tickets_svc.update_ticket(owned["id"], status="已放弃")
