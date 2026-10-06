"""进程内并发守卫（reject-only）：同一会话 / 同一产课目标有在飞任务时，第二请求立即冲突。

本地个人使用：不做排队、不做跨进程、不做鉴权。注册表是进程内 `dict[key, token]` +
`threading.Lock`，只在 add/删除的瞬间持锁，**绝不跨 await 持 thread 锁**；冲突即抛、
不等待，因此不存在"谁等谁"的锁层级死锁。

**租约（Lease）与 owner-token**：`acquire` 返回一个唯一 token，释放必须按
`(key, token)` 校验——旧请求的延迟释放（如 Starlette 先 await 发完末帧、旧的
background 才跑）不会误删新 owner 的占用（防 ABA）。一个 Lease 实例自带 once
语义，同一请求的 iterator-finally 与 background 共享它，重复释放是 no-op。

键的口径：
- `session_key(id)`：一轮对话或编排占用的会话；第二个同会话请求（含编辑/删除/截断）
  直接拒绝。
- `produce_key(base, node)`：同一科目目录 + 节点的产课/编排目标；base 是 resolve 后的
  真实目录，因此**不同 workspace 的同 slug/同节点天然是不同键**，不会互相阻断。
"""
from __future__ import annotations

import os
import threading
from collections.abc import AsyncIterator, Iterable
from pathlib import Path
from typing import Any


class ConflictError(Exception):
    """同键已有在飞任务：调用方转 409（路由）或 tool error（工具内），不等待。"""


_lock = threading.Lock()
_active: dict[str, object] = {}


def session_key(session_id: str) -> str:
    return f"session:{session_id}"


def ticket_key(ticket_id: str) -> str:
    """一张工单一个键：重试/复检（整段 runner）与快改/认领/放弃（短作用域）共用它，
    保证归属变更或收口不会与同工单在飞任务交叠（否则 runner 可能写到被改后的目录）。"""
    return f"ticket:{ticket_id}"


def produce_key(base: Path | str, node_id: str | None) -> str:
    """科目目录 + 节点：不同 workspace 的同 slug/node 解析成不同 base ⇒ 不同键。"""
    try:
        base_text = os.path.normcase(str(Path(base).resolve()))
    except OSError:
        base_text = os.path.normcase(str(base))
    return f"produce:{base_text}:{node_id or ''}"


def is_active(key: str) -> bool:
    with _lock:
        return key in _active


def acquire(key: str, message: str) -> object:
    """占用键；已被占用则抛 `ConflictError(message)`，绝不等待。返回 owner token。"""
    with _lock:
        if key in _active:
            raise ConflictError(message)
        token = object()
        _active[key] = token
        return token


def release_if_owner(key: str, token: object) -> None:
    """仅当 key 当前 owner 仍是该 token 时释放（防 ABA 误删新占用）。"""
    with _lock:
        if _active.get(key) is token:
            del _active[key]


def release(key: str) -> None:
    """无条件释放（显式单键操作 / 测试用）；生产路径释放一律走 Lease。"""
    with _lock:
        _active.pop(key, None)


def reset() -> None:
    """清空注册表：仅供测试/进程内自检，运行时路径不应调用。"""
    with _lock:
        _active.clear()


class Lease:
    """一次请求持有的并发键集合：once 释放 + 按 owner-token 校验。

    iterator-finally / background / 预返回异常三条释放路径共享同一实例，
    因此重复释放是 no-op；且即使被绕过 once，token 校验也不会误删新 owner。
    """

    def __init__(self) -> None:
        self._entries: list[tuple[str, object]] = []
        self._released = False

    def add(self, key: str, token: object) -> None:
        self._entries.append((key, token))

    def keys(self) -> list[str]:
        return [key for key, _ in self._entries]

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        for key, token in self._entries:
            release_if_owner(key, token)


def acquire_many(pairs: Iterable[tuple[str, str]]) -> Lease:
    """按顺序占用多个键并返回 Lease；任一冲突则回滚已占用的键，不留局部占用。"""
    lease = Lease()
    try:
        for key, message in pairs:
            lease.add(key, acquire(key, message))
    except ConflictError:
        lease.release()
        raise
    return lease


class _GuardedStream:
    """SSE 生成器包装：释放点覆盖 exhaustion / 取消 / 异常 / 显式 aclose。

    做成**自定义异步迭代器**而非 `async for` 包装生成器，是为了让取消点确定：
    外层任务取消时 `CancelledError` 会在 `__anext__` 的 await 处抛出，被这里捕获并
    释放后再上抛——即使生成器本体一次都没来得及迭代，`aclose()` 也能释放。
    Starlette 1.0 本身不调用 `aclose`，因此调用方还应并行挂 `background` 兜底；
    两条路径共享同一 Lease，释放幂等且 token 校验防 ABA。
    """

    def __init__(self, gen: AsyncIterator[Any], lease: Lease) -> None:
        self._gen = gen
        self._lease = lease

    def __aiter__(self) -> "_GuardedStream":
        return self

    async def __anext__(self) -> Any:
        try:
            return await self._gen.__anext__()
        except BaseException:
            self._lease.release()
            raise

    async def aclose(self) -> None:
        close = getattr(self._gen, "aclose", None)
        try:
            if close is not None:
                await close()
        finally:
            self._lease.release()


def guarded_stream(gen: AsyncIterator[Any], lease: Lease) -> _GuardedStream:
    return _GuardedStream(gen, lease)
