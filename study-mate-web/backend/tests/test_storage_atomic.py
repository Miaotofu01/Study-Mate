"""会话存储的并发安全：整文件读改写必须"写侧串行 + 原子替换"。

背景（2026-10-04 独立子代理排查）：`_write` 原来是 `open("w")` 先截断再逐段写，
读侧（`get_session` / `list_sessions`）撞上就解析到半个 JSON；并发写者还会各读一份
旧内容、后写覆盖先写。真机实测出现 `Extra data` 解析错与大量 500，最坏留下永久损坏的
会话文件。下面两条用例就是那两个形态。
"""
from __future__ import annotations

import threading

from app import storage
from app.config import SESSIONS_DIR


def test_concurrent_appends_do_not_lose_messages(client):
    """8 个写者各追加 12 条：一条都不能丢（原实现会互相覆盖）。"""
    session_id = storage.create_session("并发追加")["id"]
    writers, per_writer = 8, 12

    def worker(index: int) -> None:
        for i in range(per_writer):
            storage.add_message(session_id, "user", f"w{index}-{i}")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(writers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    session = storage.require_session(session_id)
    contents = [m["content"] for m in session["messages"]]
    assert len(contents) == writers * per_writer, contents
    assert len(set(contents)) == writers * per_writer, "出现重复/丢失"


def test_concurrent_readers_never_see_a_torn_file(client):
    """一边写一边读：读侧不允许抛解析错（原实现会 JSONDecodeError → 接口 500）。"""
    session_id = storage.create_session("并发读")["id"]
    stop = threading.Event()
    errors: list[str] = []
    written = 0

    def reader() -> None:
        while not stop.is_set():
            try:
                storage.get_session(session_id)
                storage.list_sessions()
            except Exception as exc:  # noqa: BLE001 - 这里就是要证明它不会发生
                errors.append(f"{type(exc).__name__}: {exc}")
                return

    def writer() -> None:
        nonlocal written
        for i in range(150):
            try:
                storage.add_message(session_id, "assistant", "x" * 300)
            except Exception as exc:  # noqa: BLE001 - 写者自己挂掉也要被断言抓到
                errors.append(f"writer {type(exc).__name__}: {exc}")
                return
            written += 1

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
    assert written == 150, written
    assert len(storage.require_session(session_id)["messages"]) == 150


def test_atomic_write_leaves_no_temp_files(client):
    """原子替换用的临时文件不能留在会话目录里（否则会污染列表/备份）。"""
    session_id = storage.create_session("临时文件")["id"]
    storage.add_message(session_id, "user", "hi")
    storage.update_session(session_id, title="改个名")

    leftovers = [p.name for p in SESSIONS_DIR.glob(".*.tmp")]
    assert leftovers == [], leftovers
    # 列表里只有真实会话，且能正常解析
    metas = storage.list_sessions()
    assert any(meta["id"] == session_id for meta in metas)
