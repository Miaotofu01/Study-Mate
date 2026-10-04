"""M4 科目生成：curriculum-designer 派工 → 上游 check_curriculum.py 当门。

2026-10-03 拍板⑥：原硬编码 GENERATE_SYSTEM_PROMPT 的 12 条约束是
curriculum-designer SKILL.md 的压缩转写（第二份规则，会随基线漂移），改为
SKILL.md 全文注入 + 派工值内联；输出 JSON 图契约不变（data 键交回）。
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from .. import curriculum_store as cs
from .. import roles
from ..config import REPO_ROOT, SCRIPTS_DIR
from ..llm import is_fixture_mode
from ..models import GenerateCourseRequest

router = APIRouter(prefix="/api", tags=["generate"])

SUBPROCESS_ENV = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}


def _generate_user_prompt(payload: GenerateCourseRequest) -> str:
    """派工值：学习者情况逐项内联，规格要求不复述（§5.1 C 行拍板②）。"""
    project = (payload.project or "").strip() or "未定（设计时预留可挂项目的实操素材）"
    carrier = (payload.carrier or "").strip() or "未定（实验任务写成与载体无关的可执行任务书）"
    return "\n".join(
        [
            "【本课任务】为下面的科目设计课程大纲（课程 DAG，JSON 交回 `data` 键）。",
            f"【科目名】{payload.name.strip()}",
            f"【学习目的】{payload.purpose.strip()}",
            f"【程度目标】{payload.level.strip()}",
            f"【前置基础】{payload.background.strip()}",
            f"【配套项目】{project}",
            f"【实验载体】{carrier}",
            "【输出契约】data 键 = {\"nodes\": [...], \"edges\": [...]},"
            "节点字段全量以 schemas/curriculum.schema.json 为准。",
        ]
    )


def _gate_problems(stdout: str, stderr: str) -> list[str]:
    problems: list[str] = []
    for chunk in (stdout, stderr):
        for raw in chunk.splitlines():
            line = raw.strip()
            if not line:
                continue
            if line.startswith("- "):
                problems.append(line[2:].strip())
            elif "[ERROR]" in line or line.startswith("schema"):
                problems.append(line)
    return list(dict.fromkeys(problems))[:20]


def _gate_failure(problems: list[str]) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={"detail": "大纲未通过上游门禁", "problems": problems},
    )


@router.post("/courses/generate")
async def generate_course(payload: GenerateCourseRequest):
    name = payload.name.strip()
    purpose = payload.purpose.strip()
    level = payload.level.strip()
    background = payload.background.strip()
    if not name or not purpose or not level or not background:
        raise HTTPException(422, "name、purpose、level、background 均不能为空")
    if payload.slug is not None:
        if not cs.is_valid_slug(payload.slug):
            raise HTTPException(422, "slug 格式非法：只允许小写字母、数字，用连字符分隔")
        slug = payload.slug
    else:
        slug = cs.generate_slug(name)
    if cs.subject_dir(slug).exists():
        raise HTTPException(409, f"slug 已存在：{slug}")
    if not is_fixture_mode():
        from ..common import require_provider

        provider = require_provider()
    else:
        provider = {"model": "fixture", "api_format": "openai_chat"}
    gate = SCRIPTS_DIR / "check_curriculum.py"
    if not gate.is_file():
        raise HTTPException(503, "上游脚本缺失：scripts/check_curriculum.py")

    try:
        envelope = await roles.dispatch_role(
            provider, "generate", _generate_user_prompt(payload), fixture_kind="generate"
        )
    except HTTPException:
        raise  # 技能缺失 503 等原样透传，不吞成 502
    except ValueError as exc:
        raise HTTPException(502, str(exc)) from None
    except Exception as exc:  # noqa: BLE001 - 上游错误统一转 502
        raise HTTPException(502, f"大纲生成请求失败：{type(exc).__name__}: {exc}") from None

    data = envelope.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("nodes"), list) or not isinstance(data.get("edges"), list):
        raise HTTPException(502, "大纲派工没有交回课程 JSON（data 键）")

    problems = cs.validate_curriculum(data)
    if problems:
        return _gate_failure(problems[:20])

    tmp_name = ""
    try:
        with tempfile.NamedTemporaryFile(
            "w", suffix=".yaml", encoding="utf-8", delete=False
        ) as tmp:
            yaml.safe_dump(data, tmp, allow_unicode=True, sort_keys=False)
            tmp_name = tmp.name
        try:
            proc = subprocess.run(
                [sys.executable, str(gate), tmp_name],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                env=SUBPROCESS_ENV,
                cwd=str(REPO_ROOT),
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(502, "上游门禁超时（120 秒）") from None
        except OSError as exc:
            raise HTTPException(502, f"上游门禁启动失败：{exc}") from None
    finally:
        if tmp_name:
            Path(tmp_name).unlink(missing_ok=True)

    if proc.returncode != 0:
        return _gate_failure(_gate_problems(proc.stdout or "", proc.stderr or ""))

    summary = cs.create_subject(name, slug, purpose)
    if summary is None:
        raise HTTPException(409, f"slug 已存在：{slug}")
    cs.save_curriculum(slug, data)
    return {"summary": cs.subject_summary(slug), "curriculum": data}
