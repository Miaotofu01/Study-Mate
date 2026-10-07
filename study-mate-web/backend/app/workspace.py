"""工作区发现：唯一入口，发现规则复用上游 scripts/gen_home.py::learn_workspace()。

优先级（与上游一致）：显式 `STUDYMATE_WORKSPACE` > `LEARN_WORKSPACE` >
`STUDYMATE_CONFIG`/`$DSH_HOME/studymate-config.yaml` 的 workspace 字段 >
插件默认 `~/StudyMate`。中间两级交给上游函数（子进程调用，隔离其 import
副作用），Web 不实现第二份发现规则；上游缺失或报错时兜底插件默认值。
"""
from __future__ import annotations

import logging
import os
import re
import subprocess
import sys
from pathlib import Path

from .config import REPO_ROOT

logger = logging.getLogger(__name__)

DEFAULT_WORKSPACE = Path.home() / "StudyMate"
_UPSTREAM_SCRIPT = REPO_ROOT / "scripts" / "gen_home.py"
_source: str | None = None
_fallback: Path | None = None


def config_file_path() -> Path:
    override = os.getenv("STUDYMATE_CONFIG")
    if override:
        return Path(override).expanduser()
    return Path(os.getenv("DSH_HOME") or Path.home() / ".dsh").expanduser() / "studymate-config.yaml"


def _discover_via_upstream() -> Path | None:
    if not _UPSTREAM_SCRIPT.is_file():
        logger.warning("上游 scripts/gen_home.py 不存在，工作区发现走默认 %s", DEFAULT_WORKSPACE)
        return None
    code = (
        f"import sys; sys.path.insert(0, {str(_UPSTREAM_SCRIPT.parent)!r}); "
        "import gen_home; print(gen_home.learn_workspace())"
    )
    try:
        proc = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.warning("调用上游 learn_workspace() 失败：%s", exc)
        return None
    if proc.returncode != 0:
        logger.warning("上游 learn_workspace() 未给出工作区（stderr: %s）", proc.stderr.strip())
        return None
    line = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
    return Path(line).expanduser() if line else None


def discover() -> tuple[Path, str]:
    """返回 (工作区路径, 来源说明)。env 覆盖每次动态读取，其余结果进程内缓存。"""
    global _source, _fallback
    override = os.getenv("STUDYMATE_WORKSPACE")
    if override:
        return Path(override).expanduser(), "环境变量 STUDYMATE_WORKSPACE"
    if _fallback is None:
        found = _discover_via_upstream()
        if found is not None:
            _fallback, _source = found, "上游发现（LEARN_WORKSPACE / studymate-config.yaml）"
        else:
            _fallback, _source = DEFAULT_WORKSPACE, "默认（~/StudyMate，上游未配置）"
    return _fallback, _source or ""


def reset_discovery() -> None:
    global _fallback
    _fallback = None


def candidates() -> list[str]:
    """可切换的工作区候选（当前生效路径、插件默认、env 覆盖值；去重保序）。"""
    out: list[str] = []
    raw = [str(discover()[0]), str(DEFAULT_WORKSPACE), os.getenv("STUDYMATE_WORKSPACE") or ""]
    for item in raw:
        value = str(Path(item).expanduser()) if item.strip() else ""
        if value and value not in out:
            out.append(value)
    return out


def _yaml_scalar(value: str) -> str:
    """YAML 标量安全输出：只有含 YAML 敏感字符时才加引号（普通路径保持无引号原样）。"""
    needs_quote = (
        value != value.strip()
        or any(ch in value for ch in "#\"'")
        or ": " in value
    )
    return "'" + value.replace("'", "''") + "'" if needs_quote else value


def set_configured_workspace(raw: str) -> Path:
    """把 workspace 写进 studymate-config.yaml（行级替换，保留注释与顺序）。"""
    cleaned = (raw or "").strip()
    if not cleaned:
        raise ValueError("工作区路径不能为空")
    if any(ch in cleaned for ch in "\r\n"):
        raise ValueError("工作区路径不能包含换行")
    target = str(Path(cleaned).expanduser().resolve())
    scalar = _yaml_scalar(target)
    cfg_path = config_file_path()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    lines = cfg_path.read_text(encoding="utf-8").splitlines(keepends=True) if cfg_path.exists() else []
    replaced = False
    out: list[str] = []
    for line in lines:
        if re.match(r"^workspace\s*:", line):
            out.append(f"workspace: {scalar}\n")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        if out and not out[-1].endswith("\n"):
            out[-1] += "\n"
        out.append(f"workspace: {scalar}\n")
    cfg_path.write_text("".join(out), encoding="utf-8")
    reset_discovery()
    return cfg_path
