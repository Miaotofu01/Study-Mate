"""会话绑死科目与节点聚焦推断（2026-10-04 UI 拍板）。"""
from __future__ import annotations

import json


def _session_id(body: str) -> str:
    for line in body.splitlines():
        if line.startswith("data:"):
            data = json.loads(line[5:].strip())
            if "session_id" in data:
                return str(data["session_id"])
    raise AssertionError("SSE 里没有 session 事件")


def _seed_nodes(cs, slug: str) -> list[dict]:
    """给科目铺两个最小节点（schema 允许的最小字段集）。"""
    nodes = [
        {"id": "t1.first", "title": "节点一", "kind": "概念", "objective": "学会第一件事"},
        {"id": "t1.second", "title": "节点二", "kind": "概念", "objective": "学会第二件事"},
    ]
    cs.save_curriculum(slug, {"nodes": nodes, "edges": []})
    return nodes


def _post_chat(client, **payload):
    return client.post("/api/chat/stream", json=payload)


def test_subject_binding_locks_after_first_message(client, cs, new_subject):
    slug, _ = new_subject
    r1 = _post_chat(client, message="第一问", subject_slug=slug)
    assert r1.status_code == 200
    sid = _session_id(r1.text)
    assert client.get(f"/api/sessions/{sid}").json()["subject_slug"] == slug

    # 换科目被忽略（锁定），且带 notice 提示
    r2 = _post_chat(client, message="第二问", session_id=sid, subject_slug="linear-algebra")
    assert "会话已绑定科目" in r2.text
    assert client.get(f"/api/sessions/{sid}").json()["subject_slug"] == slug

    # 显式传 null 同样不解绑
    _post_chat(client, message="第三问", session_id=sid, subject_slug=None)
    assert client.get(f"/api/sessions/{sid}").json()["subject_slug"] == slug


def test_node_can_change_within_bound_subject(client, cs, new_subject):
    slug, _ = new_subject
    nodes = _seed_nodes(cs, slug)
    last_id = nodes[-1]["id"]

    r1 = _post_chat(client, message="第一问", subject_slug=slug)
    sid = _session_id(r1.text)
    r2 = _post_chat(client, message="第二问", session_id=sid, node_id=last_id)
    assert r2.status_code == 200
    assert client.get(f"/api/sessions/{sid}").json()["node_id"] == last_id


def test_interview_session_rejects_subject_binding(client):
    """建课会话不收科目关联：绑定被忽略且给出 notice，mode 保持 interview。"""
    r = _post_chat(client, message="我不知道学什么", mode="interview", subject_slug="anything")
    assert "建课会话不关联" in r.text
    sid = _session_id(r.text)
    session = client.get(f"/api/sessions/{sid}").json()
    assert session["subject_slug"] is None


def test_infer_focus_node_prefers_learning_then_first_new(client, cs, new_subject):
    from app.routers.chat import _infer_focus_node

    slug, _ = new_subject
    nodes = _seed_nodes(cs, slug)
    first_id = nodes[0]["id"]
    second_id = nodes[1]["id"]

    # 全未开始 → 第一个节点
    assert _infer_focus_node(slug) == first_id

    # 有学习中 → 取它
    progress = cs.get_progress(slug)
    progress["nodes"][second_id] = {"status": "学习中", "mastery": 0}
    cs.save_progress(slug, progress)
    assert _infer_focus_node(slug) == second_id

    # 全部完成 → 无聚焦
    progress = cs.get_progress(slug)
    for node in nodes:
        progress["nodes"][node["id"]] = {"status": "能独立应用", "mastery": 1}
    cs.save_progress(slug, progress)
    assert _infer_focus_node(slug) is None
