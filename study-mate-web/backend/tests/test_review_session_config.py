"""只读审查后的回归：会话 ID 越界收口、settings 原子写与坏文件证据、
附件发送前校验、图片不被误当文档解析、list_sessions 坏结构隔离、默认提示词元字段。

每个用例都对一个已确证的缺陷；修复前应当失败。
"""
from __future__ import annotations

import json
import os
import threading

import pytest
from fastapi import HTTPException


def _send(client, session_id, message="hi", **extra):
    payload: dict = {"message": message, "session_id": session_id}
    payload.update(extra)
    return client.post("/api/chat/stream", json=payload)


def _messages(client, session_id):
    return client.get(f"/api/sessions/{session_id}").json()["messages"]


# settings.json 的用例级隔离由 conftest 的 autouse `_isolate_settings_file` 统一负责。


# --------------------------------------------------------------------------- #
# 会话 ID 越界：storage 层统一收口，非法 ID 不触盘
# --------------------------------------------------------------------------- #

def test_storage_session_id_traversal_never_touches_disk(client):
    from app import storage
    from app.config import DATA_DIR, SETTINGS_PATH

    canary = DATA_DIR / "canary.json"
    canary.write_text('{"keep": true}', encoding="utf-8")
    settings_before = SETTINGS_PATH.read_bytes()

    for sid in ("../settings", "..\\settings", "../canary", "..\\canary", "a/../../settings"):
        assert storage.get_session(sid) is None, sid
        with pytest.raises(KeyError):
            storage.require_session(sid)
        assert storage.delete_session(sid) is False, sid

    assert SETTINGS_PATH.read_bytes() == settings_before, "非法 ID 读到了 settings"
    assert canary.read_text(encoding="utf-8") == '{"keep": true}', "非法 ID 删掉了盘上文件"


def test_delete_session_removes_uploads_dir(client):
    from app import storage
    from app.config import UPLOADS_DIR

    session_id = storage.create_session("待删会话")["id"]
    uploads = UPLOADS_DIR / session_id
    uploads.mkdir(parents=True, exist_ok=True)
    (uploads / "abcd1234_note.txt").write_text("x", encoding="utf-8")

    assert storage.delete_session(session_id) is True
    assert storage.get_session(session_id) is None
    assert not uploads.exists()


def test_storage_rejects_symlink_escape(client):
    from app import storage
    from app.config import DATA_DIR, SESSIONS_DIR, SETTINGS_PATH

    settings_before = SETTINGS_PATH.read_bytes()
    link = SESSIONS_DIR / "evil.json"
    link.unlink(missing_ok=True)
    try:
        link.symlink_to(SETTINGS_PATH)
    except (OSError, NotImplementedError):
        pytest.skip("当前环境不允许创建符号链接")

    try:
        assert storage.get_session("evil") is None, "经 symlink 读到了目标文件"
        assert storage.delete_session("evil") is False
        assert SETTINGS_PATH.read_bytes() == settings_before
        assert DATA_DIR.is_dir()
    finally:
        link.unlink(missing_ok=True)


def test_http_session_id_traversal_returns_4xx(client):
    from app.config import DATA_DIR, SETTINGS_PATH

    before = SETTINGS_PATH.read_bytes()
    for sid in ("..%5Csettings", "%2e%2e%5Csettings"):
        assert client.get(f"/api/sessions/{sid}").status_code in (404, 422)
        assert client.delete(f"/api/sessions/{sid}").status_code in (404, 422)
    assert SETTINGS_PATH.read_bytes() == before
    assert DATA_DIR.is_dir()


def test_chat_stream_invalid_session_id_422_no_new_session(client):
    before = len(client.get("/api/sessions").json())
    resp = _send(client, "..\\settings", "x")
    assert resp.status_code == 422
    assert len(client.get("/api/sessions").json()) == before, "非法会话 ID 反而建了新会话"


# --------------------------------------------------------------------------- #
# common.require_node 的 slug 白名单
# --------------------------------------------------------------------------- #

def test_require_node_rejects_bad_slug_without_disk(monkeypatch):
    from app import common, curriculum_store

    calls = {"n": 0}

    def spy(slug):
        calls["n"] += 1
        return {"nodes": []}

    monkeypatch.setattr(curriculum_store, "get_curriculum", spy)
    with pytest.raises(HTTPException) as exc:
        common.require_node("../../etc", "x")
    assert exc.value.status_code == 404
    assert calls["n"] == 0, "非法 slug 仍触达 curriculum 读取"


# --------------------------------------------------------------------------- #
# 图片附件不得走文档解析
# --------------------------------------------------------------------------- #

def test_compose_effective_text_ignores_image_attachment(tmp_path):
    from app.routers.chat import _compose_effective_text

    png = tmp_path / "pic.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    attachment = {
        "id": "abc123",
        "filename": "pic.png",
        "kind": "image",
        "size": png.stat().st_size,
        "_path": str(png),
    }
    text = _compose_effective_text("看这张图", [attachment])
    assert text == "看这张图"
    assert "解析失败" not in text


def test_upload_kind_matches_stored_attachment_kind(client):
    session_id = client.post("/api/sessions", json={}).json()["id"]
    # 无图片扩展名但声明 image/* —— 上传与落库必须给出同一个 kind
    uploaded = client.post(
        "/api/uploads",
        files={"file": ("pic", b"\x89PNG\r\n", "image/png")},
    ).json()
    assert _send(client, session_id, "看图", attachment_ids=[uploaded["id"]]).status_code == 200
    stored = _messages(client, session_id)[0]["attachments"][0]
    assert stored["kind"] == uploaded["kind"]


# --------------------------------------------------------------------------- #
# 附件发送前完整校验：数量上限、失效 ID、零半搬迁
# --------------------------------------------------------------------------- #

def test_attachment_over_limit_422_no_side_effects(client):
    from app.config import PENDING_UPLOADS_DIR, UPLOADS_DIR

    session_id = client.post("/api/sessions", json={}).json()["id"]
    uploaded = client.post(
        "/api/uploads", files={"file": ("n.txt", b"hello", "text/plain")}
    ).json()
    ids = [uploaded["id"]] + [f"{i:016x}" for i in range(10)]  # 共 11 个
    assert _send(client, session_id, "x", attachment_ids=ids).status_code == 422
    assert _messages(client, session_id) == []
    assert list(PENDING_UPLOADS_DIR.glob(f"{uploaded['id']}_*")), "失败后 pending 被半搬迁"
    assert not list((UPLOADS_DIR / session_id).glob(f"{uploaded['id']}_*"))


def test_missing_attachment_422_no_side_effects(client):
    from app.config import PENDING_UPLOADS_DIR, UPLOADS_DIR

    session_id = client.post("/api/sessions", json={}).json()["id"]
    uploaded = client.post(
        "/api/uploads", files={"file": ("n.txt", b"hello", "text/plain")}
    ).json()
    resp = _send(client, session_id, "x", attachment_ids=[uploaded["id"], "deadbeefdeadbeef"])
    assert resp.status_code == 422, "失效附件被静默丢弃"
    assert _messages(client, session_id) == []
    assert list(PENDING_UPLOADS_DIR.glob(f"{uploaded['id']}_*"))
    assert not list((UPLOADS_DIR / session_id).glob(f"{uploaded['id']}_*"))


def test_upload_read_is_bounded(client, monkeypatch):
    from starlette.datastructures import UploadFile

    from app.routers import uploads

    seen: list[int] = []
    original = UploadFile.read

    async def spy(self, size=-1):
        seen.append(size)
        return await original(self, size)

    monkeypatch.setattr(UploadFile, "read", spy)
    resp = client.post("/api/uploads", files={"file": ("a.txt", b"hello", "text/plain")})
    assert resp.status_code == 200
    assert seen and seen[0] == uploads.MAX_UPLOAD_BYTES + 1, "仍是先读全量再判上限"


def test_upload_over_limit_413(client, monkeypatch):
    from app.routers import uploads

    monkeypatch.setattr(uploads, "MAX_UPLOAD_BYTES", 64)
    resp = client.post(
        "/api/uploads", files={"file": ("big.bin", b"x" * 512, "application/octet-stream")}
    )
    assert resp.status_code == 413


# --------------------------------------------------------------------------- #
# settings：坏文件证据、失败不误报、原子写、损坏不静默丢
# --------------------------------------------------------------------------- #

def test_settings_corrupt_file_preserved_and_recovers(client):
    from app import config
    from app.config import DATA_DIR, SETTINGS_PATH

    config.save_settings(config.default_settings())
    SETTINGS_PATH.write_text("{ broken json", encoding="utf-8")

    settings = config.load_settings()  # 不得抛
    assert settings.get("providers"), "损坏后没有回落默认，应用不可用"
    backups = list(DATA_DIR.glob("settings.json.corrupt*"))
    assert backups, "坏文件证据被静默覆盖/丢弃"
    assert backups[0].read_text(encoding="utf-8") == "{ broken json"
    json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))  # 已恢复为合法 JSON


def test_save_settings_failure_keeps_original_and_raises(client, monkeypatch):
    from app import config
    from app.config import SETTINGS_PATH

    config.save_settings(config.default_settings())
    good = SETTINGS_PATH.read_text(encoding="utf-8")

    def broken_replace(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", broken_replace)
    with pytest.raises(OSError):
        config.save_settings({**config.default_settings(), "system_prompt": "new"})
    monkeypatch.undo()
    assert SETTINGS_PATH.read_text(encoding="utf-8") == good, "保存失败却改坏了原文件"


def test_settings_concurrent_save_load_never_torn(client):
    """读侧必须读到「已完整写入的合法版本」，不能靠 load 的默认恢复掩盖半写。"""
    from app import config
    from app.config import DATA_DIR, DEFAULT_SYSTEM_PROMPT, SETTINGS_PATH

    config.save_settings(config.default_settings())
    backups_before = set(DATA_DIR.glob("settings.json.corrupt*"))
    stop = threading.Event()
    errors: list[str] = []
    valid_prompts = {DEFAULT_SYSTEM_PROMPT} | {f"p{i}" for i in range(120)}

    def reader():
        while not stop.is_set():
            try:
                settings = config.load_settings()
                prompt = settings.get("system_prompt")
                if prompt not in valid_prompts:
                    errors.append(f"reader 读到半写/非法版本：{prompt!r}")
                    return
                if not isinstance(settings.get("providers"), list):
                    errors.append("reader 读到非法 providers 形状")
                    return
            except Exception as exc:  # noqa: BLE001 - 这正是不该发生的
                errors.append(f"reader {type(exc).__name__}: {exc}")
                return

    def writer():
        for i in range(120):
            try:
                config.save_settings({**config.default_settings(), "system_prompt": f"p{i}"})
            except Exception as exc:  # noqa: BLE001
                errors.append(f"writer {type(exc).__name__}: {exc}")
                return

    readers = [threading.Thread(target=reader) for _ in range(3)]
    for thread in readers:
        thread.start()
    write_thread = threading.Thread(target=writer)
    write_thread.start()
    write_thread.join()
    stop.set()
    for thread in readers:
        thread.join()

    assert errors == [], errors
    assert set(DATA_DIR.glob("settings.json.corrupt*")) == backups_before, "并发保存不应产生损坏备份"
    json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- #
# list_sessions 坏结构隔离
# --------------------------------------------------------------------------- #

def test_list_sessions_skips_malformed_structure(client):
    from app import storage
    from app.config import SESSIONS_DIR

    good = storage.create_session("好会话")["id"]
    (SESSIONS_DIR / "bad.json").write_text(
        json.dumps({"id": "bad", "title": "缺字段"}), encoding="utf-8"
    )
    metas = storage.list_sessions()  # 不得抛
    assert any(meta["id"] == good for meta in metas)


# --------------------------------------------------------------------------- #
# 系统提示词：显式空串可保存 + 默认值只读元字段
# --------------------------------------------------------------------------- #

def test_explicit_empty_system_prompt_is_saved(client):
    current = client.get("/api/settings").json()
    resp = client.put(
        "/api/settings",
        json={
            "providers": current["providers"],
            "active": current["active"],
            "system_prompt": "",
        },
    )
    assert resp.status_code == 200
    assert client.get("/api/settings").json()["system_prompt"] == ""


def test_settings_exposes_default_system_prompt_meta(client):
    from app.config import DEFAULT_SYSTEM_PROMPT, SETTINGS_PATH

    body = client.get("/api/settings").json()
    assert body["default_system_prompt"] == DEFAULT_SYSTEM_PROMPT
    # 只读元信息：根 settings.json 里不得出现该键（不落盘）
    on_disk = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    assert "default_system_prompt" not in on_disk


# --------------------------------------------------------------------------- #
# 复审残留：symlink 跟随（列表 / 附件）
# --------------------------------------------------------------------------- #

_EXTERNAL_SESSION = {
    "id": "evil",
    "title": "LEAKED-EXTERNAL",
    "messages": [],
    "created_at": 1.0,
    "updated_at": 2.0,
}


def test_list_sessions_does_not_follow_symlinked_summary(client, tmp_path):
    from app import storage
    from app.config import SESSIONS_DIR

    good = storage.create_session("好会话")["id"]
    external = tmp_path / "external.json"
    external.write_text(json.dumps(_EXTERNAL_SESSION), encoding="utf-8")
    link = SESSIONS_DIR / "evil.json"
    link.unlink(missing_ok=True)
    try:
        link.symlink_to(external)
    except (OSError, NotImplementedError):
        pytest.skip("当前环境不允许创建符号链接")

    try:
        metas = storage.list_sessions()
        assert any(meta["id"] == good for meta in metas)
        assert all(meta["title"] != "LEAKED-EXTERNAL" for meta in metas), "跟随 symlink 读到了外部会话"
    finally:
        link.unlink(missing_ok=True)


def test_pending_symlink_attachment_is_rejected(tmp_path, monkeypatch):
    from app import storage
    from app.config import PENDING_UPLOADS_DIR
    from app.routers.chat import _find_pending
    from app.routers.uploads import find_by_id

    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    file_id = "deadbeefdeadbeef"
    link = PENDING_UPLOADS_DIR / f"{file_id}_note.txt"
    PENDING_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("当前环境不允许创建符号链接")

    assert _find_pending(file_id) is None, "pending symlink 被当成附件"
    assert find_by_id(file_id) is None, "find_by_id 跟随了外部 symlink"


def test_session_symlink_attachment_is_rejected(client, tmp_path):
    from app import storage
    from app.config import UPLOADS_DIR
    from app.routers.chat import _find_in_session
    from app.routers.uploads import find_by_id

    session_id = client.post("/api/sessions", json={}).json()["id"]
    session_dir = UPLOADS_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    file_id = "cafebabecafebabe"
    link = session_dir / f"{file_id}_note.txt"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("当前环境不允许创建符号链接")

    assert _find_in_session(session_id, file_id) is None
    assert find_by_id(file_id) is None


# --------------------------------------------------------------------------- #
# 复审残留：合法 JSON 但字段形状错误不得 500
# --------------------------------------------------------------------------- #

def _write_settings(raw: dict) -> None:
    from app.config import SETTINGS_PATH

    SETTINGS_PATH.write_text(json.dumps(raw), encoding="utf-8")


def test_settings_bad_providers_scalar_or_entries_recovers(client):
    from app import config
    from app.config import DATA_DIR

    for written in (
        {**config.default_settings(), "providers": "oops"},
        {**config.default_settings(), "providers": [1, 2]},
        {**config.default_settings(), "providers": [{"id": "keep", "name": "保留", "models": "oops"}], "active": 5, "system_prompt": 7},
    ):
        _write_settings(written)
        settings = config.load_settings()  # 不得抛 TypeError/AttributeError
        assert isinstance(settings.get("providers"), list)
        assert isinstance(settings.get("active"), dict)
        assert isinstance(settings.get("system_prompt"), str)
        # 下游读取也不能 500
        config.get_active_provider()
        config.get_session_provider({"provider_id": "keep", "model": "m"})

    assert list(DATA_DIR.glob("settings.json.corrupt*")), "形状损坏未隔离原文"


def test_settings_shape_repair_keeps_valid_providers(client):
    from app import config

    _write_settings(
        {
            "providers": [
                {"id": "keep", "name": "保留", "models": "oops", "enabled": True},
                42,
            ],
            "active": ["bad"],
            "system_prompt": 7,
        }
    )
    settings = config.load_settings()
    ids = [provider.get("id") for provider in settings["providers"]]
    assert ids == ["keep"], "合法 provider 被一并丢弃"
    assert settings["providers"][0]["models"] == []
    assert isinstance(settings["active"], dict)
    assert settings["active"].get("provider_id") is None
    assert isinstance(settings["system_prompt"], str)
    config.get_active_provider()  # 不抛即可


# --------------------------------------------------------------------------- #
# partial 落库措辞：错误路径不得自称「连接中断」
# --------------------------------------------------------------------------- #

def test_partial_persist_error_reason_not_labelled_disconnect(client):
    from app import storage
    from app.routers.chat import _persist_partial

    session_id = storage.create_session("错误措辞")["id"]
    bucket = {"text": ["半截"], "reasoning": [], "tools": [], "notices": [], "usage": None}
    _persist_partial(session_id, bucket, None, reason="error")
    saved = storage.require_session(session_id)["messages"][-1]
    assert saved["content"] == "半截"
    assert not any("中断" in item for item in saved.get("notices") or [])


def test_partial_persist_disconnect_reason_still_labelled(client):
    from app import storage
    from app.routers.chat import _persist_partial

    session_id = storage.create_session("断开措辞")["id"]
    bucket = {"text": ["半截"], "reasoning": [], "tools": [], "notices": [], "usage": None}
    _persist_partial(session_id, bucket, None)  # 默认 reason=disconnect
    saved = storage.require_session(session_id)["messages"][-1]
    assert saved["error"]["code"] == "upstream_transport"
    assert "中断" in saved["error"]["summary"]
