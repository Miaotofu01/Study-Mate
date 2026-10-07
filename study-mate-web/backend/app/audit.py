"""编排审计落盘：同一份事件序列既推前端又追加写 `data/audit/<key>.jsonl`。

K0 拍板的"事件流即审计"（DeepTutor 形态）：派工值、模型原始回复、每次工具
调用与结果都追加落盘，**失败不清除**——修掉 10-03 核实过的"堵点无文件证据"
缺口（派工值与原始回复过去不落盘、`.stage` 无论成败都被 clear_stage 删）。

审计写失败绝不阻断编排：`record()` 吞掉异常只记日志。审计键由编排方用
`bind(key)` 绑定（会话 id / 科目 slug），contextvar 随 asyncio 任务创建继承，
派工与工具执行无需层层传参即可拿到同一份日志。
"""
from __future__ import annotations

import contextlib
import contextvars
import json
import logging
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from . import errors
from .config import DATA_DIR

logger = logging.getLogger(__name__)

AUDIT_DIR = DATA_DIR / "audit"
# 单条字段的内存保护上限：模型原始回复/派工值可能很长，落盘截断到该字符数
FIELD_LIMIT = 24000
# 敏感字段（工具声明处标记）在展示层统一剔除；审计侧同样不落盘
SENSITIVE_KEYS = ("api_key", "authorization", "x-api-key")


class AuditLog:
    """单个编排/会话的追加式 jsonl 日志。"""

    def __init__(self, key: str) -> None:
        safe = "".join(ch for ch in str(key) if ch.isalnum() or ch in "-_.") or "audit"
        self.path = AUDIT_DIR / f"{safe}.jsonl"

    def append(self, event: dict[str, Any]) -> None:
        try:
            AUDIT_DIR.mkdir(parents=True, exist_ok=True)
            payload = {**event, "ts": time.time()}
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(_sanitize(payload), ensure_ascii=False) + "\n")
        except OSError as exc:  # noqa: BLE001 - 审计写失败绝不阻断编排
            logger.warning("审计落盘失败（%s）：%s", self.path, exc)


_current: contextvars.ContextVar[AuditLog | None] = contextvars.ContextVar(
    "studymate_audit", default=None
)


def bind(key: str) -> AuditLog:
    """绑定当前上下文的审计日志（编排入口调用；子任务创建时继承）。

    注意：本函数**不恢复**上一个绑定（保持旧调用方语义）。需要嵌套后还原父绑定的
    场景（父 chat 内执行 produce 工具）用 `bound(key)` 或 `snapshot_token()/restore()`，
    否则 produce 的 bind 会把父 chat 的后续记录写进 produce 日志。
    """
    log = AuditLog(key)
    _current.set(log)
    return log


@contextlib.contextmanager
def bound(key: str) -> Iterator[AuditLog]:
    """绑定审计日志的上下文管理器：退出时恢复到进入前的绑定（含父绑定）。"""
    log = AuditLog(key)
    token = _current.set(log)
    try:
        yield log
    finally:
        _current.reset(token)


def snapshot_token() -> contextvars.Token[AuditLog | None]:
    """保存当前绑定并返回可恢复的 token（用于"我改了绑定、稍后还原"）。"""
    return _current.set(_current.get())


def restore(token: contextvars.Token[AuditLog | None]) -> None:
    """按 snapshot_token 返回的 token 还原绑定（幂等失败由 contextvars 抛错）。"""
    _current.reset(token)


def current() -> AuditLog | None:
    return _current.get()


def record(event: str, **fields: Any) -> None:
    """向当前绑定的审计日志追加一条事件；未绑定时静默跳过。"""
    log = _current.get()
    if log is None:
        return
    log.append({"event": event, **fields})


def _truncate(value: Any) -> Any:
    if isinstance(value, str) and len(value) > FIELD_LIMIT:
        return f"{value[:FIELD_LIMIT]}…（审计截断，共 {len(value)} 字符）"
    return value


def _sanitize(value: Any) -> Any:
    """递归脱敏：key 命中敏感键直接打码，**任何字符串值都做内容级脱敏**。

    只按 key 过滤会漏掉 str 里内嵌的 `Authorization: Bearer sk-...`；这里对字符串
    统一走 errors.redact_text（打码 + 限长），再递归 dict/list。
    """
    if isinstance(value, str):
        return errors.redact_text(value, FIELD_LIMIT)
    if isinstance(value, dict):
        return {
            key: "***" if str(key).lower() in SENSITIVE_KEYS else _sanitize(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_sanitize(item) for item in value]
    return value


def _redact(event: dict[str, Any]) -> dict[str, Any]:
    """向后兼容入口：等价于 _sanitize。"""
    return _sanitize(event)
