"""共享记忆写侧：建议、确认写入、去重与入参校验（阶段 I）。"""
from __future__ import annotations


def test_suggest_returns_fixture_entries(client):
    from app import storage

    session_id = client.post("/api/sessions", json={"title": "记忆会话"}).json()["id"]
    storage.add_message(session_id, "user", "学习者说偏好先看例子")

    response = client.post("/api/memory/suggest", json={"session_id": session_id})
    assert response.status_code == 200
    entries = response.json()["entries"]
    assert len(entries) == 2
    assert all(entry["section"] and entry["content"] for entry in entries)


def test_confirm_writes_once_and_dedups(client, cs):
    from app import memory as memory_svc

    entries = [{"section": "教学偏好", "content": "偏好先看一个具体例子再动手"}]
    assert client.post("/api/memory/confirm", json={"entries": entries}).json()["written"] == 1
    assert client.post("/api/memory/confirm", json={"entries": entries}).json()["written"] == 0
    text = memory_svc.memory_path().read_text(encoding="utf-8")
    assert text.count("偏好先看一个具体例子再动手") == 1


def test_confirm_rejects_invalid_entries(client):
    bad_entries = [
        {"section": "不存在的分节", "content": "x"},
        {"section": "教学偏好", "content": "a\n## 注入"},
        {"section": "教学偏好", "content": "x" * 201},
        {"section": "教学偏好", "content": "   "},
    ]
    for entry in bad_entries:
        response = client.post("/api/memory/confirm", json={"entries": [entry]})
        assert response.status_code == 422, entry


def test_confirm_requires_entries(client):
    assert client.post("/api/memory/confirm", json={"entries": []}).status_code == 422
