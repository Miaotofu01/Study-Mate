"""会话级工作区（per-session workspace）：绑定、读回、隔离与校验。"""
from __future__ import annotations

import json
import os
from pathlib import Path


def _make_workspace(parent: Path, name: str, slug: str) -> Path:
    """造一个最小合法工作区：<name>/.learning/subjects/<slug>/subject.yaml。"""
    workspace = parent / name
    subject_dir = workspace / ".learning" / "subjects" / slug
    subject_dir.mkdir(parents=True)
    (subject_dir / "subject.yaml").write_text(
        "\n".join(
            [
                f"name: {slug}",
                f"slug: {slug}",
                "goal: 为了测试会话级工作区",
                "created_at: '2026-01-01'",
                "status: 进行中",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    return workspace


def test_create_session_with_workspace_roundtrip(client, tmp_path):
    workspace = _make_workspace(tmp_path, "ws-a", "alpha")
    created = client.post(
        "/api/sessions", json={"title": "绑定会话", "workspace": str(workspace)}
    ).json()
    assert created["workspace"] == str(workspace)
    meta = next(m for m in client.get("/api/sessions").json() if m["id"] == created["id"])
    assert meta["workspace"] == str(workspace)
    assert client.get(f"/api/sessions/{created['id']}").json()["workspace"] == str(workspace)

    # 不带 workspace 的新会话维持旧形状：字段存在但为 None
    plain = client.post("/api/sessions", json={"title": "普通会话"}).json()
    assert plain["workspace"] is None


def test_create_session_rejects_missing_workspace_dir(client, tmp_path):
    missing = str(tmp_path / "nowhere")
    response = client.post("/api/sessions", json={"workspace": missing})
    assert response.status_code == 422


def test_patch_title_and_workspace_independent(client, tmp_path):
    """PATCH：只传 title 的旧行为不变；workspace 可单独改/清（显式 null）。"""
    workspace = _make_workspace(tmp_path, "ws-b", "bravo")
    session_id = client.post("/api/sessions", json={"workspace": str(workspace)}).json()["id"]

    patched = client.patch(f"/api/sessions/{session_id}", json={"title": "改名"}).json()
    assert patched["title"] == "改名"
    assert patched["workspace"] == str(workspace)  # 只传 title：workspace 保持

    cleared = client.patch(f"/api/sessions/{session_id}", json={"workspace": None}).json()
    assert cleared["workspace"] is None

    both = client.patch(
        f"/api/sessions/{session_id}", json={"title": "再改", "workspace": str(workspace)}
    ).json()
    assert both["title"] == "再改" and both["workspace"] == str(workspace)

    assert client.patch(f"/api/sessions/{session_id}", json={}).status_code == 422
    missing = str(tmp_path / "现在没有")
    assert (
        client.patch(f"/api/sessions/{session_id}", json={"workspace": missing}).status_code == 422
    )


def test_two_workspaces_list_own_subjects(client, tmp_path):
    workspace_1 = _make_workspace(tmp_path, "ws-1", "one-alpha")
    workspace_2 = _make_workspace(tmp_path, "ws-2", "two-beta")
    slugs_1 = [s["slug"] for s in client.get("/api/courses", params={"workspace": str(workspace_1)}).json()]
    slugs_2 = [s["slug"] for s in client.get("/api/courses", params={"workspace": str(workspace_2)}).json()]
    assert "one-alpha" in slugs_1 and "two-beta" not in slugs_1
    assert "two-beta" in slugs_2 and "one-alpha" not in slugs_2

    # 单科详情同样跟随 ?workspace= 绑定
    assert (
        client.get("/api/courses/one-alpha", params={"workspace": str(workspace_1)}).status_code == 200
    )
    assert (
        client.get("/api/courses/one-alpha", params={"workspace": str(workspace_2)}).status_code == 404
    )


def test_attachments_area_resolves_in_bound_workspace(client, tmp_path):
    """cs.subject_dir 落在绑定工作区内：科目目录内容按工作区读出来。"""
    workspace_1 = _make_workspace(tmp_path, "ws-attach-1", "attach-alpha")
    _make_workspace(tmp_path, "ws-attach-2", "attach-beta")
    (workspace_1 / ".learning" / "subjects" / "attach-alpha" / "GLOSSARY.md").write_text(
        "# 术语", encoding="utf-8"
    )
    hit = client.get(
        "/api/courses/attach-alpha/attachments-area", params={"workspace": str(workspace_1)}
    )
    assert hit.status_code == 200
    assert hit.json()["glossary"] == "GLOSSARY.md"
    # 别的工作区没有该科目 → require_subject 落在绑定工作区里寻找 → 404
    missed = client.get(
        "/api/courses/attach-alpha/attachments-area",
        params={"workspace": str(tmp_path / "ws-attach-2")},
    )
    assert missed.status_code == 404


def test_chat_stream_binds_existing_session_workspace(client, tmp_path):
    """有 session_id 就绑该会话的 workspace：科目解析跟着会话走。"""
    workspace_1 = _make_workspace(tmp_path, "ws-chat-1", "chat-alpha")
    session_1 = client.post("/api/sessions", json={"workspace": str(workspace_1)}).json()["id"]
    response = client.post(
        "/api/chat/stream",
        json={"message": "第一问", "session_id": session_1, "subject_slug": "chat-alpha"},
    )
    assert response.status_code == 200
    assert client.get(f"/api/sessions/{session_1}").json()["subject_slug"] == "chat-alpha"

    # 另一个工作区的会话里没有该科目 → 拒绝关联（科目目录落在 ws2 找不到）
    workspace_2 = _make_workspace(tmp_path, "ws-chat-2", "chat-beta")
    session_2 = client.post("/api/sessions", json={"workspace": str(workspace_2)}).json()["id"]
    response = client.post(
        "/api/chat/stream",
        json={"message": "第二问", "session_id": session_2, "subject_slug": "chat-alpha"},
    )
    assert response.status_code == 200
    assert client.get(f"/api/sessions/{session_2}").json()["subject_slug"] is None


def test_chat_stream_new_session_with_workspace(client, tmp_path):
    """本次新建会话：先按请求里的 workspace 建会话，再绑定并返回。"""
    workspace = _make_workspace(tmp_path, "ws-chat-3", "chat-gamma")
    response = client.post(
        "/api/chat/stream",
        json={"message": "开个新会话", "workspace": str(workspace), "subject_slug": "chat-gamma"},
    )
    assert response.status_code == 200
    session_id = None
    for line in response.text.splitlines():
        if line.startswith("data: "):
            data = json.loads(line[6:])
            if "session_id" in data:
                session_id = data["session_id"]
                break
    assert session_id is not None
    session = client.get(f"/api/sessions/{session_id}").json()
    assert session["workspace"] == str(workspace)
    assert session["subject_slug"] == "chat-gamma"

    # 新会话传不存在的目录 → 422
    missing = str(tmp_path / "ws-missing")
    assert client.post("/api/chat/stream", json={"message": "x", "workspace": missing}).status_code == 422


def test_workspace_view_with_path_param(client, tmp_path):
    workspace = _make_workspace(tmp_path, "ws-view", "view-alpha")
    body = client.get("/api/workspace", params={"path": str(workspace)}).json()
    assert body["path"] == str(workspace)
    assert body["exists"] is True
    assert body["subject_count"] == 1
    assert body["subjects_dir"] == str(workspace / ".learning" / "subjects")
    # 响应形状与无参一致
    assert set(body) == set(client.get("/api/workspace").json())

    # 无参行为完全不变：仍是全局发现工作区
    assert client.get("/api/workspace").json()["path"] == str(Path(os.environ["STUDYMATE_WORKSPACE"]))


def test_workspace_query_invalid_path_422(client, tmp_path):
    missing = str(tmp_path / "no-such-dir")
    assert client.get("/api/workspace", params={"path": missing}).status_code == 422
    assert client.get("/api/courses", params={"workspace": missing}).status_code == 422
    assert (
        client.get("/api/courses/attach-alpha/attachments-area", params={"workspace": missing}).status_code
        == 422
    )
    assert (
        client.get("/api/courses/attach-alpha/files/GLOSSARY.md", params={"workspace": missing}).status_code
        == 422
    )
    # 指向文件而非目录同样 422
    blocker = tmp_path / "blocker"
    blocker.write_text("x", encoding="utf-8")
    assert client.get("/api/workspace", params={"path": str(blocker)}).status_code == 422
    assert client.get("/api/courses", params={"workspace": str(blocker)}).status_code == 422


def test_workspace_binding_does_not_leak_between_requests(client, tmp_path):
    """连续两个不同绑定的请求互不影响；不带参数回到全局发现。"""
    workspace_1 = _make_workspace(tmp_path, "ws-leak-1", "leak-alpha")
    workspace_2 = _make_workspace(tmp_path, "ws-leak-2", "leak-beta")
    slugs_1 = [s["slug"] for s in client.get("/api/courses", params={"workspace": str(workspace_1)}).json()]
    assert slugs_1 == ["leak-alpha"]
    slugs_2 = [s["slug"] for s in client.get("/api/courses", params={"workspace": str(workspace_2)}).json()]
    assert slugs_2 == ["leak-beta"]
    plain = [s["slug"] for s in client.get("/api/courses").json()]
    assert "leak-alpha" not in plain and "leak-beta" not in plain


def test_workspace_ctx_reentrant_bind_and_restore():
    """bind 可重入：token 还原外层绑定；bind(None) 显式清除后回全局发现。"""
    from app import workspace, workspace_ctx

    assert workspace_ctx.active() is None
    assert workspace_ctx.resolve() == workspace.discover()[0]
    with workspace_ctx.bind("/tmp/outer-ws") as outer:
        assert outer == Path("/tmp/outer-ws")
        assert workspace_ctx.active() == Path("/tmp/outer-ws")
        assert workspace_ctx.resolve() == Path("/tmp/outer-ws")
        with workspace_ctx.bind(None):
            assert workspace_ctx.active() is None
            assert workspace_ctx.resolve() == workspace.discover()[0]
        assert workspace_ctx.active() == Path("/tmp/outer-ws")
    assert workspace_ctx.active() is None
    assert workspace_ctx.resolve() == workspace.discover()[0]
