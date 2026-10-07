"""M2 练习判分 lite：criteria 为唯一标准的 LLM 独立判分调用。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import curriculum_store as cs
from .. import prompts
from ..common import require_node, require_provider
from ..llm import chat_once, extract_json
from ..models import GradeRequest
from .courses import bound_workspace

router = APIRouter(prefix="/api", tags=["practice"])

GRADE_SYSTEM_PROMPT = (
    "你是严格的学习作答判分器。判分要点（criteria）是唯一评分标准，参考答案只作背景。"
    "规则："
    "1) evidence 里每条必须逐字引用作答原文中的对应片段（可截取，但必须能在原文里找到），"
    "并说明它对上了哪条判分要点；"
    "2) 在作答里引用不出证据的判分要点，全部放进 missing；"
    "3) 任何判分要点引用不出证据，整体就不能判「通过」；"
    "4) 学生口头声称「懂了/会了」不算证据，只有作答内容本身算；"
    "5) verdict 只能取「通过」（每条要点都有证据）、「部分通过」（部分要点有证据）、"
    "「不通过」（核心要点缺证据）；"
    "6) comment 一句话：差一步怎么过，或通过的理由。"
    '只输出一个 JSON 对象：{"verdict": "通过|部分通过|不通过", "evidence": ["..."], '
    '"missing": ["..."], "comment": "..."}，不要输出其他文字。'
)


@router.post("/courses/{slug}/nodes/{node_id}/grade")
async def grade_answer(
    slug: str, node_id: str, payload: GradeRequest, workspace: str | None = None
) -> dict:
    with bound_workspace(workspace):
        require_node(slug, node_id)
    provider = require_provider()
    question = payload.question.strip()
    criteria = payload.criteria.strip()
    answer = payload.answer.strip()
    if not question or not criteria or not answer:
        raise HTTPException(422, "question、criteria、answer 均不能为空")
    skill_text, missing_skills = prompts.inject("grade")
    if missing_skills:
        raise HTTPException(503, f"技能规范缺失，无法保证判分口径：{'、'.join(missing_skills)}")
    user_lines = [
        f"【题目】{question}",
        f"【判分要点】{criteria}",
        f"【学生作答】{answer}",
    ]
    if payload.reference_answer and payload.reference_answer.strip():
        user_lines.append(f"【参考答案】（仅背景参考，判分只看判分要点）{payload.reference_answer.strip()}")
    try:
        raw = await chat_once(
            provider,
            [
                {"role": "system", "content": GRADE_SYSTEM_PROMPT},
                *([{"role": "system", "content": skill_text}] if skill_text else []),
                {"role": "user", "content": "\n".join(user_lines)},
            ],
            json_mode=True,
            fixture_kind="grade",
        )
    except Exception as exc:  # noqa: BLE001 - 上游错误统一转 502，不落盘
        raise HTTPException(502, f"判分请求失败：{type(exc).__name__}: {exc}") from None
    data = extract_json(raw)
    if not isinstance(data, dict) or data.get("verdict") not in cs.VERDICTS:
        raise HTTPException(502, f"判分输出无法解析：{raw[:200]}")
    return {
        "verdict": data["verdict"],
        "evidence": [str(item) for item in data.get("evidence") or []],
        "missing": [str(item) for item in data.get("missing") or []],
        "comment": str(data.get("comment") or ""),
    }
