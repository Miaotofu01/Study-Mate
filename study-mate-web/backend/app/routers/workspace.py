"""工作区查看与改选：发现结果展示 + 把新路径写进 studymate-config.yaml。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import curriculum_store as cs
from .. import workspace, workspace_ctx
from ..common import optional_workspace

router = APIRouter(prefix="/api/workspace", tags=["workspace"])


class WorkspaceUpdate(BaseModel):
    path: str


def _workspace_info(path: Path, source: str) -> dict[str, Any]:
    """统一 GET 响应形状：显式指定 ?path= 时只换 path/source，其余字段照算。"""
    with workspace_ctx.bind(path):
        subjects = cs.subjects_dir()
        subject_count = len(cs.list_subjects())  # 主题数在本工作区范围内统计
    return {
        "path": str(path),
        "source": source,
        "exists": path.exists(),
        "subjects_dir": str(subjects),
        "config_path": str(workspace.config_file_path()),
        "subject_count": subject_count,
        "candidates": workspace.candidates(),
    }


@router.get("")
def get_workspace(path: str | None = None) -> dict[str, Any]:
    """无参：返回全局发现的工作区（行为不变）；带 ?path=：查看指定工作区，
    目录不存在 422（只读查看，不切换全局配置）。"""
    if path is None or not path.strip():
        discovered, source = workspace.discover()
        return _workspace_info(discovered, source)
    target = optional_workspace(path)
    return _workspace_info(target, "请求显式指定（只读查看，不改变发现结果）")


@router.put("")
def update_workspace(payload: WorkspaceUpdate) -> dict[str, Any]:
    cfg_path = workspace.config_file_path()
    original = cfg_path.read_text(encoding="utf-8") if cfg_path.exists() else None
    try:
        workspace.set_configured_workspace(payload.path)
        cs.ensure_workspace()
    except (OSError, ValueError) as exc:
        # 写配置或建目录失败：把配置文件还原到改前内容（原本不存在则删掉），不留半切换状态
        try:
            if original is None:
                cfg_path.unlink(missing_ok=True)
            else:
                cfg_path.write_text(original, encoding="utf-8")
            workspace.reset_discovery()
        except OSError:
            pass
        raise HTTPException(422, f"工作区切换失败：{exc}") from exc
    return get_workspace() | {"config_path": str(cfg_path)}
