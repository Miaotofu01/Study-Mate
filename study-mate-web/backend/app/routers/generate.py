"""M4 科目生成：LLM 草稿大纲 → scripts/check_curriculum.py 当门。"""
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
from ..common import require_provider
from ..config import REPO_ROOT, SCRIPTS_DIR
from ..llm import chat_once, extract_json
from ..models import GenerateCourseRequest

router = APIRouter(prefix="/api", tags=["generate"])

SUBPROCESS_ENV = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}

GENERATE_SYSTEM_PROMPT = (
    "你是课程设计角色。根据学习者情况设计一门科目的课程大纲，"
    '输出一个 JSON 对象：{"nodes": [...], "edges": [...]}。'
    "只输出 JSON，不要输出任何其他文字。"
)


def _generate_user_prompt(payload: GenerateCourseRequest) -> str:
    project = (payload.project or "").strip() or "未定（设计时预留可挂项目的实操素材）"
    carrier = (payload.carrier or "").strip() or "未定（实验任务写成与载体无关的可执行任务书）"
    return "\n".join(
        [
            "【学习者情况】",
            f"- 科目名称：{payload.name.strip()}",
            f"- 学习目的：{payload.purpose.strip()}",
            f"- 当前程度：{payload.level.strip()}",
            f"- 前置基础：{payload.background.strip()}",
            f"- 配套项目：{project}",
            f"- 实验载体：{carrier}",
            "",
            "【输出格式】JSON 对象，只有 nodes 与 edges 两个键。",
            "nodes 每项只许这些字段：id、title、kind、objective、problem、prerequisites、"
            "concepts、resources、practice、pitfalls、realworld、status、mastery。",
            "edges 每项：from、to、reason（都是字符串；没有跨节点依赖可不加边，prerequisites 已表达依赖）。",
            "",
            "【硬约束】",
            "1. 节点 id 匹配 ^[a-z0-9]+([.-][a-z0-9]+)*$（如 net.layers、py.functions），全课唯一。",
            "2. kind 三选一：概念（只讲不落 lab）／实操（带自己的小 lab）／实验（里程碑验收课）。",
            "3. 实验课 3~5 个，按配套项目的真实路标插在大纲里：prerequisites 必须非空，"
            "列出它验收的普通节点，且排在被验收节点之后。",
            "4. nodes 数组顺序即教学位次：prerequisites 与 edges 只能指向排在前面的节点，整张图必须无环。",
            "5. 每个节点 objective ≤34 字、一句话、可观察可验证；title ≤16 字，参考权威教材命名。",
            "6. practice 必须包含「以讲为主／以练为主／讲练并重」之一并可补一句为什么："
            "概念→以讲为主，实验→以练为主，实操→讲练并重。",
            '7. status 一律「未开始」，mastery 一律 0。',
            "8. resources 每项 {title, type, url?}，type ∈ official-doc/book/article/video；"
            "稳定基础知识可少放或不放。",
            "9. 第一个节点是绪论：用具体现象或真实案例开场，不要学科定义加发展史。",
            "10. 节点粒度按 40 分钟能完成一个学习单元切；总节点数按学习者程度定，通常 6~15 个。",
            "11. problem 是场景钩子（这一课用哪个真实问题开场）；concepts/pitfalls/realworld 按需写，不为整齐凑数。",
            "12. 文笔参考经典教材，不要口语化；把全部标题连起来读一遍，同一个句式说明在套模板。",
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
    provider = require_provider()
    gate = SCRIPTS_DIR / "check_curriculum.py"
    if not gate.is_file():
        raise HTTPException(503, "上游脚本缺失：scripts/check_curriculum.py")

    try:
        raw = await chat_once(
            provider,
            [
                {"role": "system", "content": GENERATE_SYSTEM_PROMPT},
                {"role": "user", "content": _generate_user_prompt(payload)},
            ],
            json_mode=True,
            fixture_kind="generate",
        )
    except Exception as exc:  # noqa: BLE001 - 上游错误统一转 502
        raise HTTPException(502, f"大纲生成请求失败：{type(exc).__name__}: {exc}") from None

    data = extract_json(raw)
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("nodes"), list)
        or not isinstance(data.get("edges"), list)
    ):
        raise HTTPException(502, f"大纲输出无法解析为 JSON：{raw[:200]}")

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
