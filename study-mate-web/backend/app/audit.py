"""编排审计落盘：同一份事件序列既推前端又追加写 `data/audit/<key>.jsonl`。

K0 拍板的"事件流即审计"（DeepTutor 形态）：派工值、模型原始回复、每次工具
调用与结果都追加落盘，**失败不清除**——修掉 10-03 核实过的"堵点无文件证据"
缺口（派工值与原始回复过去不落盘、`.stage` 无论成败都被 clear_stage 删）。

审计写失败绝不阻断编排：`record()` 吞掉异常只记日志。审计键由编排方用
`bind(key)` 绑定（会话 id / 科目 slug），contextvar 随 asyncio 任务创建继承，
派工与工具执行无需层层传参即可拿到同一份日志。
"""
from __future__ import annotations

import contextvars
import json
import logging
import time
from pathlib import Path
from typing import Any

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
                fh.write(json.dumps(_redact(payload), ensure_ascii=False) + "\n")
        except OSError as exc:  # noqa: BLE001 - 审计写失败绝不阻断编排
            logger.warning("审计落盘失败（%s）：%s", self.path, exc)


_current: contextvars.ContextVar[AuditLog | None] = contextvars.ContextVar(
    "studymate_audit", default=None
)


def bind(key: str) -> AuditLog:
    """绑定当前上下文的审计日志（编排入口调用；子任务创建时继承）。"""
    log = AuditLog(key)
    _current.set(log)
    return log


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


def _redact(event: dict[str, Any]) -> dict[str, Any]:
    redacted: dict[str, Any] = {}
    for key, value in event.items():
        if str(key).lower() in SENSITIVE_KEYS:
            redacted[key] = "***"
        else:
            redacted[key] = _truncate(value)
    return redacted
