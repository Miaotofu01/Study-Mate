"""建课草稿区：data/drafts/<slug>/，布局与科目目录同构（record-keeping「科目文件夹」）。

对标插件的 `.studymate-stage/<slug>`：生产链的一切写盘先落草稿区，学习者
一次「落点确认」后整体搬进学习工作区（promote），再跑 gen_home.py 刷主页。
发现规则与正式工作区一致，见 app/workspace.py。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path
from typing import Any

import yaml

from .config import DATA_DIR, SCRIPTS_DIR
from .curriculum_store import generate_slug, is_valid_slug

DRAFTS_DIR = DATA_DIR / "drafts"

# record-keeping「新建」：预建目录与共享组件
_PREBUILT_DIRS = ("lessons", "reference", "assets", "learning-records", "sessions", "assessments")
_SHARED_ASSETS = ("style.css", "quiz.js", "lesson-toc.js")


def draft_dir(slug: str) -> Path:
    return DRAFTS_DIR / slug


def _read_yaml(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    return data if isinstance(data, dict) else None


def _write_yaml(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        yaml.safe_dump(data, fh, allow_unicode=True, sort_keys=False)


def get_draft(slug: str) -> dict[str, Any] | None:
    subject = _read_yaml(draft_dir(slug) / "subject.yaml")
    if subject is None:
        return None
    subject.setdefault("slug", slug)
    return subject


def list_drafts() -> list[dict[str, Any]]:
    if not DRAFTS_DIR.is_dir():
        return []
    drafts: list[dict[str, Any]] = []
    for child in sorted(DRAFTS_DIR.iterdir()):
        if not child.is_dir():
            continue
        subject = _read_yaml(child / "subject.yaml")
        if isinstance(subject, dict):
            drafts.append({"slug": child.name, "name": subject.get("name", ""), "goal": subject.get("goal", "")})
    return drafts


def find_draft_by_name(name: str) -> str | None:
    """按科目名找草稿（忽略首尾空白与大小写），返回其 slug；没有返回 None。

    同名课程会生成字节级相同的 slug，重复盘问会建出「同名两草稿」（实测
    subject-5563f3 / subject-579bd2 同名同目标）。建草稿前先认名去重。
    """
    if not DRAFTS_DIR.is_dir():
        return None
    wanted = (name or "").strip().casefold()
    if not wanted:
        return None
    for child in sorted(DRAFTS_DIR.iterdir()):
        if not child.is_dir():
            continue
        subject = _read_yaml(child / "subject.yaml")
        if isinstance(subject, dict) and str(subject.get("name") or "").strip().casefold() == wanted:
            return child.name
    return None


def create_draft(
    name: str,
    slug: str | None = None,
    goal: str = "",
    interview: dict[str, Any] | None = None,
) -> str:
    """建草稿科目：目录骨架 + subject.yaml（含盘问结果六键）+ 空大纲/进度 +
    使命/术语表/资源清单骨架。返回 slug。

    同名（忽略首尾空白与大小写）草稿已存在 → 直接返回既有 slug，不建重复草稿；
    指定 slug 被别的科目占用（真冲突）仍抛 FileExistsError。
    """
    resolved = slug or generate_slug(name)
    if not is_valid_slug(resolved):
        raise ValueError(f"slug 格式非法：{resolved}")
    existing = find_draft_by_name(name)
    if existing is not None:
        return existing
    base = draft_dir(resolved)
    if base.exists():
        raise FileExistsError(f"草稿已存在：{resolved}")
    for sub in _PREBUILT_DIRS:
        (base / sub).mkdir(parents=True, exist_ok=True)
    (base / "assets" / "img" / "pool").mkdir(parents=True, exist_ok=True)
    interview = interview or {}
    _write_yaml(
        base / "subject.yaml",
        {
            "name": name,
            "slug": resolved,
            "goal": goal,
            "level": interview.get("level", ""),
            "background": interview.get("background", ""),
            "project": interview.get("project", ""),
            "carrier": interview.get("carrier", ""),
            "created_at": date.today().isoformat(),
            "status": "进行中",
        },
    )
    _write_yaml(base / "curriculum.yaml", {"nodes": [], "edges": []})
    _write_yaml(
        base / "progress.yaml",
        {"updated_at": "", "nodes": {}, "misconceptions": [], "project": {"current": ""}},
    )
    (base / "MISSION.md").write_text(
        "\n".join(
            [
                "# 科目使命",
                "",
                "## Why",
                "",
                interview.get("purpose") or goal or "（待补：为什么学）",
                "",
                "## Success looks like",
                "",
                interview.get("level") or "（待补：学到什么程度）",
                "",
                "## Constraints",
                "",
                f"- 前置基础：{interview.get('background') or '未盘问'}",
                f"- 配套项目：{interview.get('project') or '未定'}",
                f"- 实验载体：{interview.get('carrier') or '未定'}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (base / "GLOSSARY.md").write_text("# 术语表\n\n## 待掌握\n\n## 已掌握\n", encoding="utf-8")
    (base / "RESOURCES.md").write_text("# 资源清单\n\n## 延伸阅读\n\n## 官方核对来源\n", encoding="utf-8")
    return resolved


def draft_curriculum(slug: str) -> dict[str, Any] | None:
    return _read_yaml(draft_dir(slug) / "curriculum.yaml")


def save_draft_curriculum(slug: str, data: dict[str, Any]) -> None:
    _write_yaml(draft_dir(slug) / "curriculum.yaml", data)


def draft_progress(slug: str) -> dict[str, Any]:
    data = _read_yaml(draft_dir(slug) / "progress.yaml")
    if data is None:
        return {"updated_at": "", "nodes": {}, "misconceptions": [], "project": {"current": ""}}
    data.setdefault("nodes", {})
    data.setdefault("misconceptions", [])
    data.setdefault("project", {"current": ""})
    return data


def save_draft_progress(slug: str, data: dict[str, Any]) -> None:
    payload = dict(data)
    payload["updated_at"] = date.today().isoformat()
    _write_yaml(draft_dir(slug) / "progress.yaml", payload)


def write_material(slug: str, title: str, markdown: str) -> str:
    """用户给料 → reference/<文件>.md + RESOURCES.md 追加条目（不做主动检索）。"""
    base = draft_dir(slug)
    reference = base / "reference"
    reference.mkdir(parents=True, exist_ok=True)
    safe = "".join(ch if ch.isalnum() or ch in "-_ " else "_" for ch in title).strip() or "material"
    filename = f"{safe}.md"
    (reference / filename).write_text(markdown, encoding="utf-8")
    resources = base / "RESOURCES.md"
    entry = f"- [{title}](reference/{filename})：学习者提供的本地资料。"
    text = resources.read_text(encoding="utf-8") if resources.is_file() else "# 资源清单\n"
    resources.write_text(text.rstrip() + "\n" + entry + "\n", encoding="utf-8")
    return f"reference/{filename}"


def promote(slug: str, target_workspace: Path | None = None) -> Path:
    """落点确认：草稿整体搬进学习工作区（默认用发现链给出的工作区），返回最终科目目录。"""
    source = draft_dir(slug)
    if not source.is_dir():
        raise FileNotFoundError(f"草稿不存在：{slug}")
    from .curriculum_store import subjects_dir

    workspace = target_workspace or subjects_dir().parent.parent
    target = workspace / ".learning" / "subjects" / slug
    if target.exists():
        raise FileExistsError(f"工作区已有同名科目：{slug}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))
    refresh_home(workspace)
    return target


def refresh_home(workspace: Path) -> None:
    """gen_home.py 刷新主页；上游脚本零重写，失败不阻断（主页可以稍后手动导出）。"""
    gate = SCRIPTS_DIR / "gen_home.py"
    if not gate.is_file():
        return
    import os

    try:
        subprocess.run(
            [sys.executable, str(gate), str(workspace)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
        )
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return


def delete_draft(slug: str) -> bool:
    base = draft_dir(slug)
    if not base.is_dir():
        return False
    shutil.rmtree(base)
    return True
