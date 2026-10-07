"""M3 静态工作区导出：拷贝科目目录 → 子进程调 scripts/gen_home.py。"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import uuid
from contextlib import contextmanager

from fastapi import APIRouter, HTTPException

from .. import curriculum_store as cs
from .. import workspace_ctx
from ..common import optional_workspace, require_subject
from ..config import DATA_DIR, REPO_ROOT, SCRIPTS_DIR

router = APIRouter(prefix="/api", tags=["export"])

SUBPROCESS_ENV = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}


@contextmanager
def _scope(workspace: str | None):
    """显式 `?workspace=` 才改绑定；未传保留调用者已绑定的工作区。"""
    if workspace is None or not str(workspace).strip():
        yield
        return
    with workspace_ctx.bind(optional_workspace(str(workspace))):
        yield


@router.post("/courses/{slug}/export")
def export_course(slug: str, workspace: str | None = None) -> dict:
    """导出到 data/exports/<slug>；可选 `?workspace=` 指定源工作区。

    先在新暂存目录里拷全并跑完 gen_home，成功后才替换旧导出——拷贝/生成失败时
    不会先删掉上一份可用导出（旧实现先 rmtree 再 copytree，失败即丢导出）。
    """
    with _scope(workspace):
        require_subject(slug)
        script = SCRIPTS_DIR / "gen_home.py"
        if not script.is_file():
            raise HTTPException(503, "上游脚本缺失：scripts/gen_home.py")

        export_root = DATA_DIR / "exports" / slug
        staging = DATA_DIR / "exports" / f".{slug}.tmp-{uuid.uuid4().hex[:8]}"
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        destination = staging / ".learning" / "subjects" / slug
        destination.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copytree(cs.subject_dir(slug), destination, dirs_exist_ok=True)
        except OSError as exc:
            shutil.rmtree(staging, ignore_errors=True)
            raise HTTPException(500, f"导出拷贝失败：{exc}") from exc

        try:
            proc = subprocess.run(
                [sys.executable, str(script), str(staging)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                env=SUBPROCESS_ENV,
                cwd=str(REPO_ROOT),
            )
        except subprocess.TimeoutExpired:
            shutil.rmtree(staging, ignore_errors=True)
            raise HTTPException(500, "导出超时（120 秒）") from None
        except OSError as exc:
            shutil.rmtree(staging, ignore_errors=True)
            raise HTTPException(500, f"导出进程启动失败：{exc}") from None

        if proc.returncode != 0:
            tail = ((proc.stderr or "") + (proc.stdout or ""))[-600:]
            shutil.rmtree(staging, ignore_errors=True)
            raise HTTPException(500, f"导出失败（退出码 {proc.returncode}）：{tail}")

        if export_root.exists():
            shutil.rmtree(export_root, ignore_errors=True)
        staging.rename(export_root)

        match = re.search(r"科目主页 (\d+) 个", proc.stdout or "")
        if match:
            pages = int(match.group(1))
        else:
            subjects_root = export_root / ".learning" / "subjects"
            pages = (
                sum(1 for child in subjects_root.iterdir() if (child / "index.html").is_file())
                if subjects_root.is_dir()
                else 0
            )
        return {
            "ok": True,
            "export_dir": str(export_root.resolve()),
            "index_file": str((export_root / "index.html").resolve()),
            "pages": pages,
        }
