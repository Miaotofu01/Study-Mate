"""落点会话自动关联、工作区主页只读服务、打回卡原因（fixture 模式）。"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app import draft as draft_svc
from app import storage
from app.routers import home as home_router
from app.routers import production


# ---------- 1. 落点自动关联触发会话 ----------


def test_promote_binds_triggering_session(client):
    slug = "promote-bind"
    draft_svc.delete_draft(slug)
    draft_svc.create_draft("落点关联", slug=slug)
    session = storage.create_session(title="建课会话")

    r = client.post(f"/api/drafts/{slug}/promote", json={"session_id": session["id"]})
    assert r.status_code == 200, r.text
    # 草稿 slug 落点后不变 → 会话被绑到同名新科目
    assert storage.get_session(session["id"])["subject_slug"] == slug
    assert storage.get_session(session["id"])["node_id"] is None


def test_promote_succeeds_without_valid_session(client):
    # 未知 session_id：静默跳过关联，落点照常成功（不 4xx）
    slug = "promote-stray"
    draft_svc.delete_draft(slug)
    draft_svc.create_draft("未知会话落点", slug=slug)
    r = client.post(f"/api/drafts/{slug}/promote", json={"session_id": "does-not-exist"})
    assert r.status_code == 200, r.text

    # 缺省 session_id：同样成功
    slug2 = "promote-absent"
    draft_svc.delete_draft(slug2)
    draft_svc.create_draft("缺省会话落点", slug=slug2)
    r2 = client.post(f"/api/drafts/{slug2}/promote", json={})
    assert r2.status_code == 200, r2.text


# ---------- 3. 工作区主页 ----------


def test_home_serves_index_and_workspace_files(client, cs):
    ws = cs.workspace_dir()
    (ws / ".learning" / "assets").mkdir(parents=True, exist_ok=True)
    (ws / "index.html").write_text("<html>工作区主页</html>", encoding="utf-8")
    (ws / ".learning" / "assets" / "theme.css").write_text("body{}", encoding="utf-8")

    r = client.get("/api/home")
    assert r.status_code == 200, r.text
    assert "工作区主页" in r.text
    assert r.headers["content-type"].startswith("text/html")

    r2 = client.get("/api/home/.learning/assets/theme.css")
    assert r2.status_code == 200, r2.text
    assert r2.text == "body{}"
    assert r2.headers["content-type"].startswith("text/css")


def test_home_rejects_traversal(client):
    # 词法拒绝（直接调处理函数，避开 HTTP 客户端对 `..` 的归一化）
    with pytest.raises(HTTPException) as excinfo:
        home_router.get_home_file("../secret.txt")
    assert excinfo.value.status_code == 400
    # 编码形态经客户端同样不放行
    r = client.get("/api/home/%2e%2e/secret.txt")
    assert r.status_code == 400, r.status_code


# ---------- 4. 打回卡原因 ----------


def test_retry_card_carries_problems(client):
    session = storage.create_session(title="编排")
    production._persist_event(
        session["id"],
        {
            "event": "retry",
            "round": 2,
            "owners": ["课设"],
            "problems": [
                {"path": "curriculum.yaml", "line": "", "message": "第 19 个节点 id 非法"},
                "第二个问题",
                "第三个问题",
                "第四个问题不该出现",
            ],
        },
    )
    text = storage.get_session(session["id"])["messages"][-1]["content"]
    assert "🔁 第 2 轮打回（课设）" in text
    assert "（自检）" in text
    assert "问题 4 条" in text
    assert "第 19 个节点 id 非法" in text
    assert "第二个问题" in text
    assert "第四个问题不该出现" not in text

    # 派工层重派带 reason → 标（派工）
    production._persist_event(
        session["id"],
        {
            "event": "retry",
            "round": 1,
            "owners": ["讲解"],
            "reason": "交付不合规",
            "problems": [{"path": "（produce_quiz 派工）", "message": "上游回复不是 JSON"}],
        },
    )
    text2 = storage.get_session(session["id"])["messages"][-1]["content"]
    assert "（派工）" in text2

    # 门禁 stage fail 带 problems → 计数进卡
    production._persist_event(
        session["id"],
        {
            "event": "stage",
            "stage": "门禁",
            "status": "fail",
            "problems": [{"message": "x"}, {"message": "y"}],
        },
    )
    text3 = storage.get_session(session["id"])["messages"][-1]["content"]
    assert "⚠ 门禁" in text3
    assert "问题 2 条" in text3
