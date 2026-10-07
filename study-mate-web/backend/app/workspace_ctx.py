"""会话级工作区上下文：ContextVar 绑定当前请求的工作区路径。

默认（无绑定）仍走 app/workspace.py 的全局发现；请求想指向某个具体工作区时，
用 bind() 把路径挂进 ContextVar，curriculum_store.workspace_dir() 借此收口——
下游（memory/records/tickets/misconceptions/routers）全部自动跟随，无需改动。

bind() 是可重入安全的 contextmanager：进入时 token 暂存旧绑定，退出时原样还原，
所以嵌套绑定（外层请求绑定 > 内层局部查看）互不污染。
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from . import workspace

_var: ContextVar[Path | None] = ContextVar("studymate_workspace_ctx", default=None)


def resolve() -> Path:
    """当前生效工作区：有绑定用绑定，否则回到全局发现。"""
    bound = _var.get()
    if bound is not None:
        return bound
    return workspace.discover()[0]


def active() -> Path | None:
    """调试用：查看当前 ContextVar 上挂的显式绑定（未绑定为 None）。"""
    return _var.get()


def validate_dir(raw: str) -> Path:
    """校验 query 传来的工作区路径必须是存在的目录；否则 ValueError（路由转 422）。"""
    path = Path(raw).expanduser()
    if not path.is_dir():
        raise ValueError(f"工作区目录不存在：{raw}")
    return path


@contextmanager
def bind(path: str | Path | None) -> Iterator[Path | None]:
    """把 path 挂到 ContextVar（None 表示显式清除绑定），退出时按 token 还原。

    yield 出的是绑定后的路径（None 未改动全局发现），方便调用方继续用同一个值。
    """
    target = Path(path).expanduser() if path is not None else None
    token = _var.set(target)
    try:
        yield target
    finally:
        _var.reset(token)
