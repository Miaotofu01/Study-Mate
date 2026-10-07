"""R7：展示文本与模型上下文文本分离（display_content 契约）。

背景：带文档附件时，用户消息的 content 会拼上附件提取文本（送模型用）；历史气泡 /
编辑框此前直接显示 content，把提取全文暴露出来。契约：

- 新用户消息：content = effective（原文 + 附件提取），display_content = 用户原文；
- 前端渲染 / 编辑 / 复制 / 再发送一律 display_content ?? content（空串保留为空，附件-only
  不回落成提取块）；旧消息 / 助手消息无字段，回落 content；
- 会话标题不回退到 effective content（纯附件消息用附件文件名），旧消息无字段才用 content；
- 无 display_content 字段的旧数据原样兼容，不做字符串剥离、不迁移老数据。
"""
from __future__ import annotations

from pathlib import Path

EXTRACT_MARK = "UNIQUE_EXTRACT_MARK_9f3a17"


def _doc_attachment(tmp_path: Path, filename: str = "notes.txt") -> dict:
    path = tmp_path / filename
    path.write_text(f"附件正文第一行\n{EXTRACT_MARK}\n", encoding="utf-8")
    return {
        "id": "att-1",
        "filename": filename,
        "kind": "doc",
        "size": path.stat().st_size,
        "_path": path,
    }


def _user_messages(session: dict) -> list[dict]:
    return [m for m in session["messages"] if m["role"] == "user"]


# ---------- storage 契约（不依赖 chat 路由） ----------


def test_add_message_persists_display_content(client, tmp_path):
    from app import storage

    session = storage.create_session(title="契约")
    expanded = f"我的问题\n\n附件：notes.txt\n附件正文第一行\n{EXTRACT_MARK}\n"
    storage.add_message(
        session["id"],
        "user",
        expanded,
        display_content="我的问题",
        attachments=[{"id": "att-1", "filename": "notes.txt", "kind": "doc", "size": 1}],
    )
    stored = _user_messages(storage.require_session(session["id"]))[0]
    assert stored["content"] == expanded
    assert stored["display_content"] == "我的问题"


def test_empty_display_content_is_persisted_not_dropped(client):
    """附件-only（原文空串）：字段必须落库为空串，前端才会显示空气泡而不是提取块。"""
    from app import storage

    session = storage.create_session(title="附件-only")
    storage.add_message(
        session["id"],
        "user",
        f"附件：notes.txt\n{EXTRACT_MARK}",
        display_content="",
        attachments=[{"id": "a", "filename": "notes.txt", "kind": "doc", "size": 1}],
    )
    stored = _user_messages(storage.require_session(session["id"]))[0]
    assert "display_content" in stored
    assert stored["display_content"] == ""


def test_display_content_none_not_serialized(client):
    """助手消息 / 不走契约的调用：不得凭空出现 display_content=None 字段。"""
    import json

    from app import storage
    from app.config import SESSIONS_DIR

    session = storage.create_session(title="无字段")
    storage.add_message(session["id"], "assistant", "回答")
    stored = storage.require_session(session["id"])["messages"][0]
    assert "display_content" not in stored
    raw = (SESSIONS_DIR / f"{session['id']}.json").read_text(encoding="utf-8")
    assert "display_content" not in raw
    assert json.loads(raw)["messages"][0].get("display_content") is None


def test_title_prefers_display_content_over_extract(client):
    from app import storage

    session = storage.create_session(title="新会话")
    storage.add_message(
        session["id"],
        "user",
        f"讲一下这个概念\n\n附件：a.pdf\n{EXTRACT_MARK}",
        display_content="讲一下这个概念",
    )
    assert storage.require_session(session["id"])["title"] == "讲一下这个概念"


def test_title_attachment_only_uses_filename_not_content(client):
    """display_content 字段存在但为空：标题用附件文件名，绝不回退到提取正文。"""
    from app import storage

    session = storage.create_session(title="新会话")
    storage.add_message(
        session["id"],
        "user",
        f"附件：note.txt\n{EXTRACT_MARK}",
        display_content="",
        attachments=[{"id": "a", "filename": "note.txt", "kind": "doc", "size": 1}],
    )
    title = storage.require_session(session["id"])["title"]
    assert title == "note.txt"
    assert EXTRACT_MARK not in title


def test_title_attachment_only_no_filename_keeps_default(client):
    """字段为空又无文件名：保留默认标题，不得把提取正文塞进标题。"""
    from app import storage

    session = storage.create_session(title="新的对话")
    storage.add_message(session["id"], "user", f"提取块 {EXTRACT_MARK}", display_content="")
    title = storage.require_session(session["id"])["title"]
    assert title == "新的对话"
    assert EXTRACT_MARK not in title


def test_legacy_message_without_field_falls_back_to_content(client):
    """旧消息（无 display_content 字段）标题仍取 content —— 不迁移老数据、不猜原文。"""
    from app import storage

    session = storage.create_session(title="新会话")
    storage.add_message(session["id"], "user", "旧正文")
    stored = storage.require_session(session["id"])
    assert stored["title"] == "旧正文"
    assert "display_content" not in _user_messages(stored)[0]


def test_edit_resend_does_not_double_concat(client, tmp_path):
    """存储侧契约：编辑重发传的是展示原文，content 由原文 + 附件重新合成，不叠加旧 expanded。"""
    from app import storage
    from app.routers.chat import _compose_effective_text

    session = storage.create_session(title="编辑")
    attachment = _doc_attachment(tmp_path)
    first_expanded = _compose_effective_text("原问题", [attachment])
    storage.add_message(
        session["id"],
        "user",
        first_expanded,
        display_content="原问题",
        attachments=[{k: attachment[k] for k in ("id", "filename", "kind", "size")}],
    )

    # 编辑重发：截断后按展示原文重新合成
    storage.truncate_messages(session["id"], 0)
    second_expanded = _compose_effective_text("改后的问题", [attachment])
    storage.add_message(
        session["id"],
        "user",
        second_expanded,
        display_content="改后的问题",
        attachments=[{k: attachment[k] for k in ("id", "filename", "kind", "size")}],
    )
    stored = _user_messages(storage.require_session(session["id"]))[0]
    assert stored["display_content"] == "改后的问题"
    assert stored["content"].count(EXTRACT_MARK) == 1
    assert stored["content"].startswith("改后的问题")
    assert "原问题" not in stored["content"]


# ---------- chat 路由契约（依赖 chat.py 的 display_content 接线） ----------


def _send(client, session_id: str | None, message: str, **extra) -> str:
    payload: dict = {"message": message, "session_id": session_id}
    payload.update(extra)
    response = client.post("/api/chat/stream", json=payload)
    assert response.status_code == 200
    return response.text


def _upload(client, session_id: str, name: str, body: bytes) -> dict:
    return client.post(
        "/api/uploads",
        data={"session_id": session_id},
        files={"file": (name, body, "text/plain")},
    ).json()


def test_chat_user_message_separates_display_and_model_text(client):
    session_id = client.post("/api/sessions", json={}).json()["id"]
    uploaded = _upload(client, session_id, "note.txt", f"提取正文\n{EXTRACT_MARK}\n".encode())
    _send(client, session_id, "我的问题", attachment_ids=[uploaded["id"]])

    session = client.get(f"/api/sessions/{session_id}").json()
    user = _user_messages(session)[0]
    # 模型上下文：完整提取文本在里面
    assert EXTRACT_MARK in user["content"]
    # UI / 编辑：只有用户原文
    assert user["display_content"] == "我的问题"
    # 标题不暴露提取文本
    assert EXTRACT_MARK not in session["title"]


def test_chat_attachment_only_keeps_empty_display(client):
    """只发附件不输文字：display_content 为空串，提取文本只在 content 里。"""
    session_id = client.post("/api/sessions", json={}).json()["id"]
    uploaded = _upload(client, session_id, "only.txt", f"正文\n{EXTRACT_MARK}\n".encode())
    _send(client, session_id, "", attachment_ids=[uploaded["id"]])

    session = client.get(f"/api/sessions/{session_id}").json()
    user = _user_messages(session)[0]
    assert user["display_content"] == ""
    assert EXTRACT_MARK in user["content"]
    assert EXTRACT_MARK not in session["title"]


def test_chat_attachment_only_edit_resend_keeps_single_extract(client):
    """附件-only 原样重发（空正文 + 原附件）：display 仍为空串，提取文本只注入一次。"""
    session_id = client.post("/api/sessions", json={}).json()["id"]
    uploaded = _upload(client, session_id, "only.txt", f"正文\n{EXTRACT_MARK}\n".encode())
    _send(client, session_id, "", attachment_ids=[uploaded["id"]])
    _send(client, session_id, "", attachment_ids=[uploaded["id"]], replace_from=0)

    session = client.get(f"/api/sessions/{session_id}").json()
    user = _user_messages(session)[0]
    assert user["display_content"] == ""
    assert user["content"].count(EXTRACT_MARK) == 1
    assert user["content"].startswith("附件：only.txt")


def test_chat_edit_resend_rebuilds_without_double_extract(client):
    session_id = client.post("/api/sessions", json={}).json()["id"]
    uploaded = _upload(client, session_id, "note.txt", f"提取正文\n{EXTRACT_MARK}\n".encode())
    _send(client, session_id, "第一版问题", attachment_ids=[uploaded["id"]])
    _send(
        client,
        session_id,
        "第二版问题",
        attachment_ids=[uploaded["id"]],
        replace_from=0,
    )

    session = client.get(f"/api/sessions/{session_id}").json()
    user = _user_messages(session)[0]
    assert user["display_content"] == "第二版问题"
    assert user["content"].startswith("第二版问题")
    assert user["content"].count(EXTRACT_MARK) == 1
    assert "第一版问题" not in user["content"]
