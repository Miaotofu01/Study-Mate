"""M3 静态工作区导出：拷贝科目目录 → 子进程调 scripts/gen_home.py。"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys

from fastapi import APIRouter, HTTPException

from .. import curriculum_store as cs
from ..common import require_subject
from ..config import DATA_DIR, REPO_ROOT, SCRIPTS_DIR

router = APIRouter(prefix="/api", tags=["export"])

SUBPROCESS_ENV = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}


@router.post("/courses/{slug}/export")
def export_course(slug: str) -> dict:
    require_subject(slug)
    script = SCRIPTS_DIR / "gen_home.py"
    if not script.is_file():
        raise HTTPException(503, "上游脚本缺失：scripts/gen_home.py")

    export_root = DATA_DIR / "exports" / slug
    if export_root.exists():
        shutil.rmtree(export_root)
    destination = export_root / ".learning" / "subjects" / slug
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copytree(cs.subject_dir(slug), destination, dirs_exist_ok=True)

    try:
        proc = subprocess.run(
            [sys.executable, str(script), str(export_root)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            env=SUBPROCESS_ENV,
            cwd=str(REPO_ROOT),
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(500, "导出超时（120 秒）") from None
    except OSError as exc:
        raise HTTPException(500, f"导出进程启动失败：{exc}") from None

    if proc.returncode != 0:
        tail = ((proc.stderr or "") + (proc.stdout or ""))[-600:]
        raise HTTPException(500, f"导出失败（退出码 {proc.returncode}）：{tail}")

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
