"""令牌前缀的只读工作区资源路由：修复 iframe 内相对资源丢 `?workspace=` 的问题。

课件页 / 工作区主页在非默认工作区里打开时，HTML 会用 `?workspace=<绝对路径>` 载入，
但页面内的相对引用（CSS / JS / 图片 / 字体）解析成新的 URL 时不会带上 query，服务端
只能回落到全局默认工作区（多层 Referer 也不可靠：策略可禁、嵌套 iframe 不稳）。

这里给出**前缀式**的最小方案：把工作区路径 base64url 编成 token 放进路径前缀，
HTML 里的相对引用自然保留前缀（`../../../assets/...` → .../courses/assets/...），
从而落到同一个工作区。HTML 产物保持原样，不需要改写资源引用。

只读；所有处理委托给既有的 lessons/home 处理器（显式绑定工作区），
containment 校验沿用它们，不复制业务逻辑。
"""
from __future__ import annotations

import base64
import binascii
from pathlib import Path

from fastapi import APIRouter, HTTPException

from . import home, lessons

router = APIRouter(prefix="/api", tags=["workspace-files"])


def encode_workspace_token(path: str | Path) -> str:
    """工作区路径 → base64url token（无 padding）。前端生成同款前缀时用这个口径。"""
    raw = str(path).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _workspace_from_token(token: str) -> Path:
    """token → 已存在的工作区目录；令牌坏或目录不存在都按 404（不泄露更多信息）。"""
    padding = "=" * (-len(token) % 4)
    try:
        raw = base64.urlsafe_b64decode(token + padding).decode("utf-8")
    except (binascii.Error, ValueError, UnicodeDecodeError):
        raise HTTPException(404, "工作区令牌无效") from None
    path = Path(raw).expanduser()
    if not path.is_dir():
        raise HTTPException(404, "工作区不存在")
    return path


# 与 lessons 的注册顺序一致：files 在前、assets 在后（`courses/assets/files/...` 的解析口径不变）。
@router.get("/workspace-files/{token}/courses/{slug}/files/{file_path:path}")
def workspace_course_file(token: str, slug: str, file_path: str):
    """委托 lessons.get_file：显式绑定 token 工作区，containment 校验复用其实现。"""
    return lessons.get_file(slug, file_path, str(_workspace_from_token(token)))


@router.get("/workspace-files/{token}/courses/assets/{file_path:path}")
def workspace_shared_asset(token: str, file_path: str):
    """委托 lessons.get_shared_asset：先 token 工作区 assets，缺则回退仓库 templates/assets。"""
    return lessons.get_shared_asset(file_path, str(_workspace_from_token(token)))


@router.get("/workspace-files/{token}/home")
def workspace_home(token: str):
    """委托 home.get_home：显式把工作区交给它（它内部会绑定并还原）。"""
    return home.get_home(str(_workspace_from_token(token)))


@router.get("/workspace-files/{token}/home/{file_path:path}")
def workspace_home_file(token: str, file_path: str):
    """委托 home.get_home_file：主页相对引用（`.learning/assets/**`）按 token 工作区解析。"""
    return home.get_home_file(file_path, str(_workspace_from_token(token)))
