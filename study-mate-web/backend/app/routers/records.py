"""M3 评估与小结：LLM 生成 → schema 校验 → 落盘 → 状态机。"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from .. import curriculum_store as cs
from .. import misconceptions as mc
from .. import prompts
from .. import records as records_svc
from .. import storage
from .. import workspace_ctx
from ..common import optional_workspace, require_node, require_provider, require_subject, today
from ..llm import chat_once
from ..models import AssessRequest, SummaryRequest
from .courses import bound_workspace

router = APIRouter(prefix="/api", tags=["records"])

ASSESS_SYSTEM_PROMPT = (
    "你是 StudyMate 的阶段评估角色：根据会话记录评估学习者对一个节点的掌握。"
    "评估题只问理解与权衡（对比、因果、预测、取舍、迁移），不问机械回忆；"
    "每条结论必须指向作答原文里的具体证据，学生口头说「懂了」不算证据；"
    "引用不出证据的判分要点按缺口写进 note，整体结论不能是「通过」。"
    "本调用运行在 StudyMate Web 运行时：你只负责返回 YAML front matter 结构本身，"
    "写盘、正文渲染与进度推进全部由后端承担——不要输出正文、不要写文件、不要输出解释。"
    "只输出 YAML front matter（首行 --- 末行 ---），不要用代码围栏包裹。"
)

# 评估格式修复专用提示：只允许动格式，判分结论与作答原文逐字保留。
ASSESS_REPAIR_SYSTEM_PROMPT = (
    "你是 StudyMate 评估输出的格式修复器。输入是一次阶段评估的原始输出，"
    "它可能缺少或多写了 front matter 分隔符，或 YAML 缩进/引用写错。"
    "你只允许修复格式，不得改写、增删或重新判分任何语义内容："
    "顶层 node、date、layer、mastery、verdict、next 的取值必须逐字保留；"
    "questions 的数量与顺序不得增删或调换，每题 q、kind、answer、verdict、topic、note "
    "的取值必须逐字保留。不得新增任何字段，也不得删除任何字段。"
    "只输出修复后的 YAML front matter（首行 --- 末行 ---），"
    "不要输出正文、代码围栏或任何解释。"
)

SUMMARY_SYSTEM_PROMPT = (
    "你是 StudyMate 的学习记录角色：把一段学习会话压缩成结构化小结。"
    "learned 写确实发生了的学习行为与产出，weaknesses 写还没关掉的缺口，"
    "next_step 写下次从哪继续、先做什么。只输出 YAML front matter"
    "（首行 --- 末行 ---），不要输出正文。"
)


def _fail(what: str, stage: str, problems: list[str], detail: str | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=502,
        content={
            "detail": detail or f"{what}未通过校验，未落盘",
            "problems": problems,
            "stage": stage,
        },
    )


def _invalid(what: str, problems: list[str], stage: str = "schema") -> JSONResponse:
    return _fail(what, stage, problems, f"{what}未通过校验，未落盘")


def _parse_failure(what: str, raw: str, result: records_svc.FrontMatterResult) -> JSONResponse:
    records_svc.log_parse_failure(what, raw, result)
    detail = f"{what}解析失败（{result.stage}）：{result.detail}，未落盘"
    return _fail(what, result.stage or "parse", [result.detail], detail)


def _parse_or_502(raw: str, what: str) -> dict[str, Any] | JSONResponse:
    result = records_svc.diagnose_front_matter(raw)
    if result.meta is None:
        return _parse_failure(what, raw, result)
    return result.meta


async def _parse_assessment_with_repair(
    provider: dict[str, Any], raw: str, what: str
) -> tuple[dict[str, Any], bool] | JSONResponse:
    """评估输出解析：先本地确定性格式修复，必要时一次受限 LLM 格式修复。

    修复只动格式：修复结果必须与原文可靠取回的语义快照结构等价——题目数量与
    顺序不变、不新增字段、已有取值逐字保留，否则拒绝。原文无法整体解析出语义
    快照时保守拒绝 LLM 修复（机械分隔符修复不受影响），不落盘。
    返回 (meta, format_repaired) 或失败 JSONResponse。
    """
    result = records_svc.diagnose_front_matter(raw)
    if result.meta is not None:
        return result.meta, False

    local = records_svc.repair_front_matter_local(raw)
    if local is not None:
        repaired = records_svc.diagnose_front_matter(local[0])
        if repaired.meta is not None:
            records_svc.log_format_repair(what, "local", local[1])
            return repaired.meta, True

    snapshot = records_svc.semantic_snapshot(records_svc.parse_semantic_mapping(raw))
    if not records_svc.snapshot_reliable(snapshot):
        records_svc.log_parse_failure(what, raw, result)
        detail = (
            f"{what}解析失败（{result.stage}）：{result.detail}；"
            "原始输出无法可靠取回语义快照，拒绝格式修复，未落盘"
        )
        return _fail(what, result.stage or "parse", [result.detail], detail)

    try:
        repaired_raw = await chat_once(
            provider,
            [
                {"role": "system", "content": ASSESS_REPAIR_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": "【原始评估输出】\n" + raw + "\n\n请只做格式修复，逐字保留所有字段取值。",
                },
            ],
            fixture_kind="assess",
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - 上游错误统一转 502，不落盘
        return _invalid(what, [f"格式修复调用失败：{type(exc).__name__}"], "format_repair")

    repaired = records_svc.diagnose_front_matter(repaired_raw)
    if repaired.meta is None:
        return _invalid(
            what,
            [f"格式修复后仍无法解析（{repaired.stage}）：{repaired.detail}"],
            repaired.stage or "format_repair",
        )
    mismatches = records_svc.verify_snapshot(snapshot, repaired.meta)
    if mismatches:
        return _invalid(what, ["格式修复改动了语义内容：" + "；".join(mismatches[:8])], "format_repair")
    records_svc.log_format_repair(what, "llm")
    return repaired.meta, True


def _session_for_subject(slug: str, session_id: str | None) -> dict[str, Any]:
    if session_id:
        session = storage.get_session(session_id)
        if session is None:
            raise HTTPException(404, f"会话不存在：{session_id}")
        return session
    latest = next(
        (meta for meta in storage.list_sessions() if meta.get("subject_slug") == slug),
        None,
    )
    if latest is None:
        raise HTTPException(422, "该科目还没有关联的会话，请先在 Chat 里学习并关联科目")
    session = storage.get_session(latest["id"])
    if session is None:
        raise HTTPException(422, "该科目还没有关联的会话，请先在 Chat 里学习并关联科目")
    return session


def _format_messages(messages: list[dict[str, Any]], limit: int = 30, width: int = 800) -> str:
    lines = []
    for message in messages[-limit:]:
        role = "学生" if message.get("role") == "user" else "助手"
        lines.append(f"{role}：{str(message.get('content') or '')[:width]}")
    return "\n".join(lines) or "（会话无消息）"


@router.post("/courses/{slug}/nodes/{node_id}/assess")
async def assess_node(
    slug: str, node_id: str, payload: AssessRequest, workspace: str | None = None
):
    """评估：请求带 session_id 时，沿该会话绑定的会话级工作区落盘与读课程；
    没有会话绑定时用显式 ?workspace=，都没有则维持全局默认。"""
    context = storage.session_workspace(payload.session_id) if payload.session_id else None
    if not context:
        context = optional_workspace(workspace)
    with workspace_ctx.bind(context):
        return await _assess_node(slug, node_id, payload)


async def _assess_node(slug: str, node_id: str, payload: AssessRequest):
    subject = require_subject(slug)
    node, index = require_node(slug, node_id)
    # 评估跑在该会话绑定的模型上（模型按会话持久化）
    provider = require_provider(payload.session_id)
    skill_text, missing_skills = prompts.inject("assess")
    if missing_skills:
        raise HTTPException(503, f"技能规范缺失，无法保证评估口径：{'、'.join(missing_skills)}")
    session = _session_for_subject(slug, payload.session_id)
    messages_text = _format_messages(session.get("messages") or [])
    topics_text = (
        "；".join(str(item.get("topic") or "") for item in mc.list_items(slug)) or "无"
    )
    entry = (cs.get_progress(slug).get("nodes") or {}).get(node_id) or {}

    user_lines = [
        f"【科目】{subject.get('name', '')}",
        f"【节点】{node.get('id')} · {node.get('title')}（kind: {node.get('kind')}）",
        f"【学习目标】{node.get('objective')}",
        f"【动手安排】{node.get('practice')}",
        f"【涉及概念】{'、'.join(node.get('concepts') or []) or '无'}",
        f"【易错点】{'；'.join(node.get('pitfalls') or []) or '无'}",
        f"【学生当前状态】{entry.get('status') or '未开始'}，掌握度 {entry.get('mastery', 0)}",
        f"【已有误解 topic】{topics_text}",
        "【会话记录】",
        messages_text,
    ]
    if payload.extra_context and payload.extra_context.strip():
        user_lines.append(f"【补充说明】{payload.extra_context.strip()}")
    user_lines.extend(
        [
            "",
            "请输出该节点的评估记录 front matter，字段要求：",
            f"node: {node_id}",
            f'date: "{today()}"（必须加引号）',
            "questions: 1~2 题，每题字段：q（题面）、kind（概念|实操|证据核验）、"
            "answer（从会话记录里摘录的学生作答原文，没有就写「会话中未作答」并判不通过）、"
            "verdict（通过|部分通过|不通过）、"
            "topic（仅 verdict 为部分通过/不通过时必写：一句简短的误解点/知识点标签，"
            "须能对上本题 note 指出的缺口；通过可不写）、"
            "note（对的是哪条判分要点、缺哪一条、差一步怎么过；"
            "部分通过/不通过时必写且引用作答原文）",
            "mastery: 0~1 的数字",
            "verdict: 通过|部分通过|不通过（整个节点的结论）",
            "next: 下一步建议一句话",
        ]
    )

    try:
        raw = await chat_once(
            provider,
            [
                {"role": "system", "content": ASSESS_SYSTEM_PROMPT},
                *([{"role": "system", "content": skill_text}] if skill_text else []),
                {"role": "user", "content": "\n".join(user_lines)},
            ],
            fixture_kind="assess",
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - 上游错误统一转 502，不落盘
        raise HTTPException(502, f"评估请求失败：{type(exc).__name__}: {exc}") from None

    parsed = await _parse_assessment_with_repair(provider, raw, "评估输出")
    if isinstance(parsed, JSONResponse):
        return parsed
    meta, format_repaired = parsed
    problems = records_svc.schema_problems("assessment", meta)
    if problems:
        return _invalid("评估输出", problems, "schema")

    mc.add_from_assessment(
        slug, node_id, meta.get("questions") or [], str(meta.get("next") or "")
    )

    record_file = records_svc.write_assessment(
        slug, node_id, meta, str(node.get("title") or ""), str(node.get("kind") or "")
    )

    progress_updated = False
    effective = None
    promoted: list[dict[str, Any]] = []
    learning_record: str | None = None
    if meta.get("verdict") == "通过":
        # 读-改-写整段持锁（progress_transaction）：并发评估/改进度不会互相覆盖。
        with cs.progress_transaction(slug) as progress:
            entries = progress.setdefault("nodes", {})
            node_entry = dict(entries.get(node_id) or {})
            target = "已通过项目验证" if node.get("kind") == "实验" else "能独立应用"
            # 评估通过是权威置位（record-keeping 硬规则）；实验课再连 prerequisites 一起置位
            node_entry["status"] = target
            mastery = meta.get("mastery")
            if isinstance(mastery, (int, float)) and not isinstance(mastery, bool):
                suggested = round(max(0.0, min(1.0, float(mastery))), 2)
                if node.get("kind") == "实验":
                    # 上游 record-keeping：实验课置位时掌握度「保留或上调」，不因单次评估降级
                    previous = node_entry.get("mastery")
                    if isinstance(previous, (int, float)) and not isinstance(previous, bool):
                        suggested = max(suggested, round(float(previous), 2))
                node_entry["mastery"] = suggested
            entries[node_id] = node_entry
            promoted.append({"id": node_id, "title": node.get("title", ""), "status": target})
            if node.get("kind") == "实验":
                curriculum = cs.get_curriculum(slug) or {}
                for prereq_id in node.get("prerequisites") or []:
                    prereq_entry = dict(entries.get(prereq_id) or {})
                    if prereq_entry.get("status") == "已通过项目验证":
                        continue
                    prereq_entry["status"] = "已通过项目验证"
                    entries[prereq_id] = prereq_entry
                    prereq_title = next(
                        (
                            str(n.get("title") or "")
                            for n in curriculum.get("nodes") or []
                            if isinstance(n, dict) and n.get("id") == prereq_id
                        ),
                        prereq_id,
                    )
                    promoted.append({"id": prereq_id, "title": prereq_title, "status": "已通过项目验证"})
        progress_updated = True
        effective = cs.effective_node(node, node_entry, index, cs.TRANSITIONS)
        learning_record = records_svc.write_learning_record(
            slug,
            node_id,
            str(node.get("title") or ""),
            "实验通过" if node.get("kind") == "实验" else "评估通过",
            record_file,
        )

    return {
        "ok": True,
        "record_file": record_file,
        "assessment": meta,
        "format_repaired": format_repaired,
        "progress_updated": progress_updated,
        "promoted": promoted,
        "learning_record": learning_record,
        "node": effective,
    }


@router.post("/courses/{slug}/sessions/{session_id}/summary")
async def summarize_session(
    slug: str,
    session_id: str,
    payload: SummaryRequest | None = None,
    workspace: str | None = None,
):
    """会话小结：沿该会话绑定的会话级工作区写 records/sessions；无会话绑定时用 ?workspace=。"""
    context = storage.session_workspace(session_id) or optional_workspace(workspace)
    with workspace_ctx.bind(context):
        return await _summarize_session(slug, session_id, payload)


async def _summarize_session(
    slug: str, session_id: str, payload: SummaryRequest | None = None
) -> Any:
    subject = require_subject(slug)
    session = storage.get_session(session_id)
    if session is None:
        raise HTTPException(404, f"会话不存在：{session_id}")
    messages = session.get("messages") or []
    if not messages:
        raise HTTPException(422, "会话没有消息，无法生成小结")
    provider = require_provider(session_id)
    skill_text, missing_skills = prompts.inject("summary")
    if missing_skills:
        raise HTTPException(503, f"技能规范缺失，无法保证小结口径：{'、'.join(missing_skills)}")

    user_lines = [
        f"【科目】{subject.get('name', '')}",
        f"【会话标题】{session.get('title', '')}",
        "【会话记录】",
        _format_messages(messages),
    ]
    if payload and payload.extra_context and payload.extra_context.strip():
        user_lines.append(f"【补充说明】{payload.extra_context.strip()}")
    user_lines.extend(
        [
            "",
            "请输出会话小结 front matter，字段要求：",
            f'date: "{today()}"（必须加引号）',
            f"subject: {subject.get('name', '')}",
            "session_goal: 这次会话的学习目标一句话",
            "learned: 字符串数组，本次确实发生的学习行为与产出",
            "next_step: 下次从哪继续一句话",
            "weaknesses: 字符串数组，还没关掉的缺口",
            "memory_updates: 字符串数组（可选），值得记进长期记忆的教学备注",
        ]
    )

    try:
        raw = await chat_once(
            provider,
            [
                {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                *([{"role": "system", "content": skill_text}] if skill_text else []),
                {"role": "user", "content": "\n".join(user_lines)},
            ],
            fixture_kind="summary",
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - 上游错误统一转 502，不落盘
        raise HTTPException(502, f"小结请求失败：{type(exc).__name__}: {exc}") from None

    meta = _parse_or_502(raw, "小结输出")
    if isinstance(meta, JSONResponse):
        return meta
    meta["date"] = today()
    problems = records_svc.schema_problems("session-summary", meta)
    if problems:
        return _invalid("小结输出", problems)

    record_file = records_svc.write_summary(slug, meta)
    return {"ok": True, "record_file": record_file, "summary": meta}


@router.get("/courses/{slug}/records")
def list_records(slug: str, workspace: str | None = None) -> dict[str, list[dict[str, Any]]]:
    with bound_workspace(workspace):
        require_subject(slug)
        return records_svc.list_records(slug)
