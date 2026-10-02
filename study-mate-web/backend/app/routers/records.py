"""M3 评估与小结：LLM 生成 → schema 校验 → 落盘 → 状态机。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from .. import curriculum_store as cs
from .. import misconceptions as mc
from .. import records as records_svc
from .. import storage
from ..common import require_node, require_provider, require_subject, today
from ..llm import chat_once
from ..models import AssessRequest, SummaryRequest

router = APIRouter(prefix="/api", tags=["records"])

ASSESS_SYSTEM_PROMPT = (
    "你是 StudyMate 的阶段评估角色：根据会话记录评估学习者对一个节点的掌握。"
    "评估题只问理解与权衡（对比、因果、预测、取舍、迁移），不问机械回忆；"
    "每条结论必须指向作答原文里的具体证据，学生口头说「懂了」不算证据；"
    "引用不出证据的判分要点按缺口写进 note，整体结论不能是「通过」。"
    "只输出 YAML front matter（首行 --- 末行 ---），不要输出正文。"
)

SUMMARY_SYSTEM_PROMPT = (
    "你是 StudyMate 的学习记录角色：把一段学习会话压缩成结构化小结。"
    "learned 写确实发生了的学习行为与产出，weaknesses 写还没关掉的缺口，"
    "next_step 写下次从哪继续、先做什么。只输出 YAML front matter"
    "（首行 --- 末行 ---），不要输出正文。"
)


def _invalid(what: str, problems: list[str]) -> JSONResponse:
    return JSONResponse(
        status_code=502,
        content={"detail": f"{what}未通过校验，未落盘", "problems": problems},
    )


def _parse_or_502(raw: str, what: str) -> dict[str, Any] | JSONResponse:
    meta, _ = records_svc.parse_front_matter(raw)
    if meta is None:
        return _invalid(what, [f"输出里没有可解析的 front matter，原始片段：{raw[:200]}"])
    return meta


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
async def assess_node(slug: str, node_id: str, payload: AssessRequest):
    subject = require_subject(slug)
    node, index = require_node(slug, node_id)
    provider = require_provider()
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
            "verdict（通过|部分通过|不通过）、note（对的是哪条判分要点、缺哪一条、差一步怎么过；"
            "部分通过/不通过时必写且引用作答原文）",
            "mastery: 0~1 的数字",
            "verdict: 通过|部分通过|不通过（整个节点的结论）",
            "next: 下一步建议一句话",
            "misconceptions: 本次暴露的误解 topic 字符串数组（简短概括、按暴露顺序排列；没有就 []）",
        ]
    )

    try:
        raw = await chat_once(
            provider,
            [
                {"role": "system", "content": ASSESS_SYSTEM_PROMPT},
                {"role": "user", "content": "\n".join(user_lines)},
            ],
            fixture_kind="assess",
        )
    except Exception as exc:  # noqa: BLE001 - 上游错误统一转 502，不落盘
        raise HTTPException(502, f"评估请求失败：{type(exc).__name__}: {exc}") from None

    meta = _parse_or_502(raw, "评估输出")
    if isinstance(meta, JSONResponse):
        return meta
    problems = records_svc.schema_problems("assessment", meta)
    if problems:
        return _invalid("评估输出", problems)

    topics = [str(item).strip() for item in meta.get("misconceptions") or [] if str(item).strip()]
    mc.add_from_assessment(
        slug, node_id, topics, meta.get("questions") or [], str(meta.get("next") or "")
    )

    record_file = records_svc.write_assessment(
        slug, node_id, meta, str(node.get("title") or ""), str(node.get("kind") or "")
    )

    progress_updated = False
    effective = None
    if meta.get("verdict") == "通过":
        progress = cs.get_progress(slug)
        entries = progress.setdefault("nodes", {})
        node_entry = dict(entries.get(node_id) or {})
        current = node_entry.get("status") or node.get("status") or "未开始"
        target = "已通过项目验证" if node.get("kind") == "实验" else "能独立应用"
        if target in cs.TRANSITIONS.get(current, []) and target != current:
            node_entry["status"] = target
            mastery = meta.get("mastery")
            if isinstance(mastery, (int, float)) and not isinstance(mastery, bool):
                node_entry["mastery"] = round(max(0.0, min(1.0, float(mastery))), 2)
            entries[node_id] = node_entry
            cs.save_progress(slug, progress)
            progress_updated = True
            effective = cs.effective_node(node, node_entry, index, cs.TRANSITIONS)

    return {
        "ok": True,
        "record_file": record_file,
        "assessment": meta,
        "progress_updated": progress_updated,
        "node": effective,
    }


@router.post("/courses/{slug}/sessions/{session_id}/summary")
async def summarize_session(slug: str, session_id: str, payload: SummaryRequest | None = None):
    subject = require_subject(slug)
    session = storage.get_session(session_id)
    if session is None:
        raise HTTPException(404, f"会话不存在：{session_id}")
    messages = session.get("messages") or []
    if not messages:
        raise HTTPException(422, "会话没有消息，无法生成小结")
    provider = require_provider()

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
                {"role": "user", "content": "\n".join(user_lines)},
            ],
            fixture_kind="summary",
        )
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
def list_records(slug: str) -> dict[str, list[dict[str, Any]]]:
    require_subject(slug)
    return records_svc.list_records(slug)
