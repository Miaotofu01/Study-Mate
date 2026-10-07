"""工具注册表与文件/命令边界（K0 基建；K1 chat 只读工具、K2/K3 生产工具的公共层）。

设计取自 DSH 四层围栏的可移植子集（见 `K系列尽调-DSH与DeepTutor工具机制存档.md` §四）：

- 相对路径以"会话工作区 / 科目目录"为基准，**可写根 allow-list**（K1 只读；K2/K3
  仅草稿或科目目录）。
- **写前当场重新 canonicalize**：resolve 到最深存在祖先再校验包含关系，消
  check-here-write-there 的 TOCTOU。
- 拒绝返回**稳定的模型可读标记**（`[sandbox: file access denied under <mode> mode]`），
  进 `is_error` 结果，让模型自愈而不炸循环。
- 单个工具自带上限（read 2 万字符 + 翻页），溢出截断并标注。

工具执行**不抛异常**：任何失败都转成 `{"content": 错误文本, "is_error": True}`。
"""
from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Awaitable, Callable

from . import concurrency
from .config import REPO_ROOT

SKILLS_ROOT = REPO_ROOT / ".dsh" / "skills"
READ_CHAR_LIMIT = 20000
LIST_LIMIT = 200
READ_DEFAULT_LINES = 400


class SandboxError(Exception):
    """路径越出 allow-list；消息本身就是给模型的稳定拒答标记。"""


@dataclass
class ToolContext:
    """一次编排/会话的工具执行上下文（根目录 + 展示标签 + 状态暂存 + 审计旁路）。"""

    read_roots: list[Path] = field(default_factory=list)
    write_roots: list[Path] = field(default_factory=list)
    label: str = "workspace"
    audit: Any = None
    # 工具间的状态暂存（如 submit_curriculum 交回的大纲、write_deliver_file 记下的交付）
    state: dict[str, Any] = field(default_factory=dict)

    def normalized_roots(self, *, mode: str) -> list[Path]:
        roots = self.write_roots if mode == "write" else self.read_roots
        return [root.resolve() for root in roots if root is not None]


def _denied(mode: str, reason: str) -> SandboxError:
    return SandboxError(f"[sandbox: file access denied under {mode} mode] {reason}")


def unsafe_relative_reason(relative: str, *, for_write: bool = False) -> str | None:
    """相对路径的越界判定（返回原因或 None）。

    按 **Windows 语义**判定，Linux 上对同一输入给出同样结论——写路径的盘符相对
    （`C:evil.md`）、UNC（`\\\\server\\share`）、反斜杠分隔、盘符/根锚点、`..`
    以及 NTFS 备用数据流（`file.txt:stream`）都必须拒绝，否则 `root / path`
    会被 pathlib 重置成盘符相对路径，写到 allow-list 之外。

    `for_write=True`（交付落盘）额外拒绝反斜杠与冒号；读路径只在 `resolve()`
    之后用包含关系兜底（见 `_resolve_within`）。
    """
    raw = str(relative)
    if not raw:
        return "路径为空"
    if raw.startswith(("/", "\\")):
        return f"路径越界：{raw}"
    win = PureWindowsPath(raw)
    if win.drive or win.anchor or win.is_absolute():
        return f"路径越界：{raw}"
    if ".." in win.parts or ".." in PurePosixPath(raw).parts:
        return f"路径越界：{raw}"
    if for_write and ("\\" in raw or ":" in raw):
        return f"路径越界：{raw}"
    return None


def _resolve_within(root: Path, relative: str, *, mode: str) -> Path:
    """把相对路径解析进 root 并当场 canonicalize 校验包含关系（消 TOCTOU）。"""
    reason = unsafe_relative_reason(relative)
    if reason:
        raise _denied(mode, reason)
    root = root.resolve()
    target = (root / Path(relative)).resolve()
    if target != root and root not in target.parents:
        raise _denied(mode, f"路径越出允许根：{relative}")
    return target


def resolve_read(ctx: ToolContext, relative: str) -> tuple[Path, Path]:
    """在最前面的命中读根里定位文件，返回 (绝对路径, 命中根)。"""
    errors: list[str] = []
    for root in ctx.normalized_roots(mode="read"):
        try:
            target = _resolve_within(root, relative, mode="read")
        except SandboxError as exc:
            errors.append(str(exc))
            continue
        if target.is_file():
            return target, root
    if errors:
        raise SandboxError(errors[0])
    raise _denied("read", f"文件不存在：{relative}")


def _relative(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve())).replace("\\", "/")
    except ValueError:
        return path.name


def _truncate(text: str, limit: int = READ_CHAR_LIMIT) -> str:
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n…（超长截断，共 {len(text)} 字符；可用 start_line/max_lines 翻页）"


# ---------- 工具处理器（K1 只读） ----------


async def _tool_list_workspace(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    roots = ctx.normalized_roots(mode="read")
    if not roots:
        return {"content": "（当前会话没有可读的工作区根）", "is_error": False}
    lines: list[str] = []
    for root in roots:
        lines.append(f"【{ctx.label}：{root.name or root}】")
        base = root
        sub = str(args.get("path") or "").strip()
        if sub:
            try:
                base = _resolve_within(root, sub, mode="read")
            except SandboxError as exc:
                return {"content": str(exc), "is_error": True}
        if not base.is_dir():
            lines.append(f"（不是目录：{sub or '.'}）")
            continue
        entries = sorted(base.iterdir(), key=lambda p: (p.is_file(), p.name))
        for entry in entries[:LIST_LIMIT]:
            marker = "/" if entry.is_dir() else ""
            lines.append(f"- {_relative(entry, root)}{marker}")
        if len(entries) > LIST_LIMIT:
            lines.append(f"…（共 {len(entries)} 项，已截断）")
    return {"content": "\n".join(lines), "is_error": False}


async def _tool_read_course_file(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    relative = str(args.get("path") or "").strip()
    try:
        target, root = resolve_read(ctx, relative)
    except SandboxError as exc:
        return {"content": str(exc), "is_error": True}
    try:
        text = target.read_text(encoding="utf-8")
    except OSError as exc:
        return {"content": f"读取失败：{exc}", "is_error": True}
    lines = text.splitlines()
    start = max(0, int(args.get("start_line") or 1) - 1)
    max_lines = int(args.get("max_lines") or READ_DEFAULT_LINES)
    window = "\n".join(lines[start : start + max_lines])
    header = f"【{_relative(target, root)}】（共 {len(lines)} 行，显示第 {start + 1} 行起）"
    body = _truncate(window)
    if start + max_lines < len(lines):
        body += f"\n…（后续还有 {len(lines) - start - max_lines} 行，用 start_line 继续）"
    return {"content": f"{header}\n{body}", "is_error": False}


async def _tool_read_skill(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    name = str(args.get("name") or "").strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        return {"content": f"[sandbox: file access denied under read mode] 非法技能名：{name}", "is_error": True}
    path = SKILLS_ROOT / name / "SKILL.md"
    if not path.is_file():
        return {"content": f"技能规范不存在：{name}", "is_error": True}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return {"content": f"读取失败：{exc}", "is_error": True}
    return {"content": f"【技能 {name}】\n{_truncate(text)}", "is_error": False}


# ---------- 工具处理器（K2/K3 生产：写交付 + 大纲提交 + 自检） ----------


def _safe_rel(relative: str) -> str:
    reason = unsafe_relative_reason(relative, for_write=True)
    if reason:
        raise SandboxError(f"[sandbox: file access denied under write mode] 非法交付路径：{relative}（{reason}）")
    return str(Path(str(relative))).replace("\\", "/")


def safe_write_target(base: Path, relative: str) -> Path:
    """写路径的最终目标：先按 Windows 语义拒绝越界，再 `resolve()` 校验包含关系。

    两层都有必要：`C:evil.md` 这类盘符相对路径会让 `base / path` 被 pathlib 重置，
    必须在校验阶段拦掉；`resolve()` 包含关系则兜住符号链接等落点漂移。
    """
    reason = unsafe_relative_reason(relative, for_write=True)
    if reason:
        raise SandboxError(f"[sandbox: file access denied under write mode] {reason}")
    resolved_base = base.resolve()
    target = (resolved_base / str(relative)).resolve()
    if target != resolved_base and resolved_base not in target.parents:
        raise SandboxError(
            f"[sandbox: file access denied under write mode] 路径越出允许根：{relative}"
        )
    return target


async def _tool_write_deliver_file(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """把一份产物写入交付暂存区（`.stage/<角色>/deliver/`），由总控逐字落盘。"""
    try:
        relative = _safe_rel(str(args.get("path") or "").strip())
    except SandboxError as exc:
        return {"content": str(exc), "is_error": True}
    content = args.get("content")
    if not isinstance(content, str) or not content:
        return {"content": "content 必须是非空字符串", "is_error": True}
    stage = ctx.state.get("stage_dir")
    if stage is not None:
        target = safe_write_target(Path(stage) / "deliver", relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
    files = ctx.state.setdefault("files", [])
    files.append({"path": relative, "content": content})
    return {"content": f"已写入交付：{relative}（{len(content)} 字符）", "is_error": False}


async def _tool_submit_curriculum(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """提交课程大纲；后端立即跑大纲自检并把报错原文返回，模型据此自修。"""
    data = args.get("data") if isinstance(args.get("data"), dict) else args
    if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
        return {"content": "提交内容缺少 nodes 数组（大纲 DAG）", "is_error": True}
    from . import build as build_svc

    problems = await build_svc.run_curriculum_gate(data)
    if problems:
        lines = "\n".join(f"- {p['message']}" for p in problems[:20])
        return {
            "content": f"大纲自检未过（{len(problems)} 处），请逐条修正后重新提交：\n{lines}",
            "is_error": True,
        }
    ctx.state["curriculum"] = data
    return {"content": "已提交，通过大纲自检。请在最终回复里简述大纲设计，然后结束。", "is_error": False}


async def _tool_run_check(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """把已写交付落到科目目录后跑渲染 + 检查，返回报错原文（K3 自修证据）。"""
    stage = ctx.state.get("stage_dir")
    base = ctx.state.get("base")
    node_id = ctx.state.get("node_id")
    index = int(ctx.state.get("index") or 0)
    if stage is None or base is None or not node_id:
        return {"content": "当前上下文不支持自检（缺 base/node）", "is_error": True}
    from . import produce as produce_svc

    files = ctx.state.get("files") or []
    if files:
        produce_svc.roles.write_deliver(Path(stage), files)
        produce_svc.roles.promote_deliver(Path(stage), Path(base), files)

    async def _noop(_event: dict[str, Any]) -> None:
        return None

    ok, problems = await produce_svc.render_and_check(Path(base), str(node_id), index, _noop)
    # 记录本轮自检结果：编排方据此保守接受「产物已存在 + 本轮检查通过」的交付，
    # 同时它也只在本次角色执行内有效（ctx.state 每次派工新建）。
    ctx.state["check_passed"] = bool(ok)
    if ok:
        return {"content": "渲染与检查均通过。", "is_error": False}
    lines = "\n".join(f"- {p.get('path')}:{p.get('line')} {p.get('message')}" for p in problems[:20])
    return {"content": f"检查未过（{len(problems)} 处），请按报错修正后重新写入：\n{lines}", "is_error": True}


# ---------- 工具处理器（会话内动作：产课 / 评估） ----------
# 会话绑定的科目由 chat 路由塞进 `ctx.state`（slug / node_id / session_id / emit）。
# emit 是 agent 循环的事件回吐通道，转成 {"type":"notice"} 让产课进度在对话里可见。


def _state_slug(ctx: ToolContext) -> str:
    """取会话科目 slug：优先 state，其次从读根目录名反推（subject_dir(slug) 的 name）。"""
    slug = str((ctx.state or {}).get("slug") or "").strip()
    if slug:
        return slug
    roots = ctx.read_roots or []
    return roots[0].name if roots else ""


def _first_unproduced_node(base: Path, nodes: list[dict[str, Any]]) -> str:
    """按大纲顺序找第一个还没有课件（lessons/NNNN-<id>.md）的节点 id。"""
    lessons = base / "lessons"
    existing = {path.name for path in lessons.glob("*.md")} if lessons.is_dir() else set()
    for node in nodes:
        node_id = str(node.get("id") or "")
        if node_id and not any(name.endswith(f"-{node_id}.md") for name in existing):
            return node_id
    return ""


async def _tool_produce_lesson(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """为会话科目产出一节课：生成一次父工具任务，真跑讲解→出题→渲染→检查。

    过程不再每 10s 折成 notice 刷屏：产课链事件（阶段/角色/重试/心跳）由
    `production_task.ProductionTaskReducer` 归约成完整快照，经
    `emit({type:"task_update", id:<父 call id>, task})` 原位回吐（chat 存到
    `tools[i].task`，前端原位展示）。成功且 HTML 真落盘可读时才返回 `lesson`
    入口；失败/handoff/取消绝不伪 done，也不给入口。
    """
    from . import common
    from . import curriculum_store as cs
    from . import produce as produce_svc
    from . import production_task as pt

    state = ctx.state or {}
    slug = _state_slug(ctx)
    if not slug:
        return {"content": "无法确定科目：本会话未关联科目，请先在对话里选定科目。", "is_error": True}
    base = cs.subject_dir(slug)
    nodes = produce_svc._curriculum_of(base, slug)
    if not nodes:
        return {"content": f"科目 {slug} 还没有课程大纲，无法产课。", "is_error": True}
    raw_regenerate = args.get("regenerate")
    if raw_regenerate is not None and not isinstance(raw_regenerate, bool):
        return {
            "content": "regenerate 必须是布尔值 true/false（收到非布尔值已拒绝）。",
            "is_error": True,
        }
    regenerate = bool(raw_regenerate) if raw_regenerate is not None else False
    explicit_node = str(args.get("node_id") or "").strip()
    if regenerate and not explicit_node:
        # 强制重做必须明确目标：不静默取「第一个未产出」（那会把重做变成顺带产新课）。
        return {
            "content": "regenerate=true 时必须显式传 node_id（指定要重做的节点）；"
            "省略 node_id 时不会自动选择节点。",
            "is_error": True,
        }
    node_id = explicit_node
    if not node_id:
        # 省略 node_id 严格按 schema：取大纲顺序里第一个还没有课件的节点。
        # 不使用 ctx 推断的聚焦节点（那是「接着上次学」的会话焦点，不是产课目标；
        # 否则会把已完成的聚焦节点反复重产）。
        node_id = _first_unproduced_node(base, nodes)
    if not node_id:
        # 已全产完：不建新任务、不给新入口，直接告诉模型没有待产节点。
        return {"content": "该科目所有节点都已产出课件，没有待产节点。", "is_error": False}
    node = next((n for n in nodes if n.get("id") == node_id), None)
    if node is None:
        return {"content": f"节点不存在：{node_id}", "is_error": True}
    try:
        provider = common.require_provider(state.get("session_id"))
    except Exception as exc:  # noqa: BLE001 - HTTPException 等统一转 is_error 文本
        return {"content": str(exc), "is_error": True}

    title = str(node.get("title") or node_id)
    emit = state.get("emit")
    # 父 call id 由 agent 主循环在执行工具前写入 ctx.state；缺失时给稳定兜底 id，
    # 保证 task_update 不丢桥（chat 按 id 认领 tools[i].task）。
    parent_id = str(state.get("tool_call_id") or "").strip()
    if not parent_id:
        parent_id = f"produce_lesson-{slug}-{node_id}-{uuid.uuid4().hex[:8]}"
    if produce_svc.is_draft(base):
        workspace = str(base.resolve())
    else:
        workspace = str(produce_svc.workspace_of_subject(base).resolve())

    reducer = pt.ProductionTaskReducer(
        task_id=parent_id,
        title=title,
        subject_slug=slug,
        node_id=node_id,
        workspace=workspace,
    )
    stream = pt.TaskUpdateStream(reducer, emit)
    result: dict[str, Any] = {
        "done": False,
        "artifacts": [],
        "error": None,
        "handoff": None,
        "timeout": False,
    }

    async def forward_emit(event: dict[str, Any]) -> None:
        kind = str(event.get("event") or "")
        if kind == "done":
            result["done"] = True
            result["artifacts"] = [str(a) for a in event.get("artifacts") or []]
        elif kind == "error":
            result["error"] = str(event.get("message") or "产课失败")
            # 按机器可读字段判超时终态，不做字符串匹配。
            if event.get("code") == "role_timeout" or event.get("type") == "timeout":
                result["timeout"] = True
        elif kind == "handoff":
            result["handoff"] = event.get("ticket")
        await stream.consume(event)

    # 与 HTTP 产课端点共用同一 base+node 键：会话内 produce_lesson 与并发产课请求
    # 互斥。本对话轮已持有会话键，此处再取产课键（两键不同、无同键嵌套 ⇒ 不自锁）；
    # 冲突转明确的 tool error 而不是异常穿透成 500。
    key = concurrency.produce_key(base, node_id)
    try:
        lease = concurrency.acquire_many(
            [(key, f"该科目（节点）正在产课中，请等待当前产课结束后再试（{slug} / {node_id}）。")]
        )
    except concurrency.ConflictError as exc:
        return {"content": str(exc), "is_error": True}

    failure: str | None = None
    try:
        await stream.start()
        try:
            try:
                await produce_svc.run_produce(
                    base, slug, node_id, provider, forward_emit, regenerate=regenerate
                )
            except asyncio.CancelledError:
                # 取消：任务终态 interrupted，running 角色一并转 interrupted；
                # 不吞 CancelledError，继续向上抛给 SSE/agent 层。
                reducer.finalize(pt.STATUS_INTERRUPTED)
                raise
            except Exception as exc:  # noqa: BLE001 - 产课链异常不炸对话
                failure = f"产课执行失败：{type(exc).__name__}: {exc}"
                reducer.finalize(pt.STATUS_ERROR, error=failure)
            else:
                if result["done"] and not result["error"] and not result["handoff"]:
                    reducer.finalize(pt.STATUS_DONE)
                elif result["timeout"]:
                    failure = result["error"] or "备用派工超时"
                    # production_task owner 消费该常量；未就位时用字面量保持并行可用。
                    reducer.finalize(getattr(pt, "STATUS_TIMEOUT", "timeout"), error=failure)
                else:
                    failure = result["error"] or (
                        "质检未过，已转人工。" if result["handoff"] else "产课未完成"
                    )
                    reducer.finalize(pt.STATUS_ERROR, error=failure)
        finally:
            await stream.stop()
    finally:
        lease.release()

    if failure is None:
        node_ids = {str(n.get("id")) for n in nodes if n.get("id")}
        lesson = pt.lesson_link(
            base=base,
            subject_slug=slug,
            node_id=node_id,
            title=title,
            workspace=workspace,
            artifacts=result["artifacts"],
            node_ids=node_ids,
        )
        if lesson:
            reducer.set_lesson(lesson)
            # 最终 flush 带上已确认的课件入口（此前 finally 的收尾快照没有 lesson）。
            await stream.emit_current()
        artifacts = "、".join(result["artifacts"]) or "（未收到产物清单）"
        return {
            "content": (
                f"已产出节点「{title}」（{node_id}）：{artifacts}。"
                "下一步：可调用 assess_node 评估学习者掌握情况，或继续产出后续节点。"
            ),
            "is_error": False,
            "lesson": lesson,
            "task": reducer.snapshot(),
        }
    return {"content": failure, "is_error": True, "task": reducer.snapshot()}


async def _tool_assess_node(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """按会话记录评估学习者在某节点上的掌握（复用评估端点的服务函数）。"""
    from . import common
    from . import storage
    from . import workspace_ctx
    from .models import AssessRequest
    from .routers.records import _assess_node

    state = ctx.state or {}
    slug = _state_slug(ctx)
    node_id = str(args.get("node_id") or "").strip()

    def failed(error: str) -> dict[str, Any]:
        """失败统一带 assessment 失败载荷（后台可靠性由 records 侧 owner 负责）。"""
        return {
            "content": error,
            "is_error": True,
            "assessment": {
                "status": "failed",
                "node_id": node_id,
                "subject_slug": slug,
                "error": error,
                "background": False,
            },
        }

    if not slug:
        return failed("无法确定科目：本会话未关联科目，请先在对话里选定科目。")
    evidence = str(args.get("evidence") or "").strip()
    if not node_id:
        return failed("缺少参数 node_id（要评估的节点 id）。")
    if not evidence:
        return failed("缺少参数 evidence（学习者的作答/理解原文）。")
    session_id = state.get("session_id")
    try:
        common.require_provider(session_id)
    except Exception as exc:  # noqa: BLE001
        return failed(str(exc))
    payload = AssessRequest(session_id=session_id, extra_context=evidence)
    try:
        with workspace_ctx.bind(storage.session_workspace(session_id) if session_id else None):
            result = await _assess_node(slug, node_id, payload)
    except Exception as exc:  # noqa: BLE001 - HTTPException 等统一转 is_error 文本
        return failed(f"评估失败：{type(exc).__name__}: {exc}")
    if not isinstance(result, dict) or not result.get("ok"):
        detail = "评估未通过校验，未落盘"
        if not isinstance(result, dict):
            import json

            try:
                body = json.loads(result.body.decode("utf-8"))
                detail = str(body.get("detail") or detail)
                problems = body.get("problems") or []
                if problems:
                    detail += "；" + "；".join(str(p) for p in problems[:5])
            except Exception:  # noqa: BLE001 - 解析失败保留兜底文案
                pass
        return failed(detail)
    meta = result.get("assessment") or {}
    mastery = meta.get("mastery")
    line = (
        f"判定：{meta.get('verdict') or '未给出'}；"
        f"掌握度：{mastery if mastery is not None else '未给出'}；"
        f"{'已置位' if result.get('progress_updated') else '未置位'}"
    )
    promoted = result.get("promoted") or []
    if promoted:
        line += "；置位节点：" + "、".join(
            str(item.get("title") or item.get("id")) for item in promoted
        )
    line += f"；评估记录：{result.get('record_file')}"
    assessment: dict[str, Any] = {
        "status": "saved",
        "node_id": node_id,
        "subject_slug": slug,
        "record_file": result.get("record_file"),
        "verdict": meta.get("verdict"),
        "progress_updated": bool(result.get("progress_updated")),
    }
    if mastery is not None:
        assessment["mastery"] = mastery
    return {"content": line, "is_error": False, "assessment": assessment}


async def _tool_start_course_interview(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """把当前普通会话切入建课（方向盘问）模式（2026-10-05 拍板③）。

    切换 = 落库 `mode: "interview"`：后续请求按请求开始时的派生规则注入建课技能规范；
    本轮收口也成立——chat.py 的收口判定用「本轮结束时的会话模式」，agent 切完当场收口
    （学习者一句话给足信息时一次成稿）也能被解析。
    """
    from . import storage

    session_id = str((ctx.state or {}).get("session_id") or "")
    if not session_id:
        return {"content": "无法确定当前会话，未能进入建课会话。", "is_error": True}
    session = storage.get_session(session_id)
    if session is None:
        return {"content": "会话不存在或已被删除，无法进入建课会话。", "is_error": True}
    if session.get("subject_slug"):
        return {
            "content": "本会话已关联科目，不能转建课会话（换科目或另建新课请开新会话）。",
            "is_error": True,
        }
    if str(session.get("mode") or "chat") == "interview":
        return {
            "content": "本会话已是建课会话：请继续方向盘问，信息足够后按规范输出收口标记。",
            "is_error": False,
        }
    storage.update_session(session_id, mode="interview")
    return {
        "content": (
            "已切换为建课会话（后续轮次会注入建课技能规范）。"
            "请立刻开始方向盘问：围绕学习方向、目标、程度与基础逐条提问，"
            "信息足够后按规范输出收口标记建草稿。"
        ),
        "is_error": False,
    }


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[[dict[str, Any], ToolContext], Awaitable[dict[str, Any]]]
    sensitive: bool = False

    def schema(self) -> dict[str, Any]:
        """暴露给模型的标准 OpenAI function 声明。"""
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }


_OBJECT = "object"


def _params(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": _OBJECT,
        "properties": properties,
        "required": required or [],
        "additionalProperties": False,
    }


TOOL_SPECS: dict[str, ToolSpec] = {
    "list_workspace": ToolSpec(
        name="list_workspace",
        description="列出当前学习工作区（或指定子目录）下的文件与目录，用于了解有哪些课件、记录与资料。",
        parameters=_params({"path": {"type": "string", "description": "相对子目录，省略则列出根"}}),
        handler=_tool_list_workspace,
    ),
    "read_course_file": ToolSpec(
        name="read_course_file",
        description="读取工作区里的一个文本文件（课件、术语表、学习记录、资料等），返回指定行窗口。",
        parameters=_params(
            {
                "path": {"type": "string", "description": "相对工作区的文件路径"},
                "start_line": {"type": "integer", "description": "起始行（从 1 开始）"},
                "max_lines": {"type": "integer", "description": "最多读取行数"},
            },
            ["path"],
        ),
        handler=_tool_read_course_file,
    ),
    "read_skill": ToolSpec(
        name="read_skill",
        description="按名称读取一条技能规范（SKILL.md）的全文，用于需要某条规范细节时按需补充。",
        parameters=_params(
            {"name": {"type": "string", "description": "技能目录名，如 lesson-design"}},
            ["name"],
        ),
        handler=_tool_read_skill,
    ),
    "submit_curriculum": ToolSpec(
        name="submit_curriculum",
        description=(
            "提交课程大纲（课程 DAG：nodes/edges）。后端会立即跑大纲自检校验，"
            "未过则把报错原文返回给你，按报错逐条修正后重新提交，直到通过。"
        ),
        parameters=_params(
            {
                "data": {
                    "type": _OBJECT,
                    "description": (
                        '{"nodes": [...], "edges": [...]}。'
                        "节点 id 只能用小写字母/数字，段间用 `.` 或 `-`（如 net.layers）；"
                        "每个节点必填 id/title/objective/prerequisites/status/kind"
                        "（kind 取 概念/实操/实验）；"
                        "concepts、pitfalls 是字符串数组；realworld 是字符串（不是数组）；"
                        "每条 edge 必填 from/to/reason（reason 写设这条边的理由）。"
                    ),
                }
            },
            ["data"],
        ),
        handler=_tool_submit_curriculum,
    ),
    "write_deliver_file": ToolSpec(
        name="write_deliver_file",
        description="写入一份产物（课件内容文件 / 题库 / 实验材料）。路径用规范里的最终相对路径，内容逐字写。",
        parameters=_params(
            {
                "path": {"type": "string", "description": "产物相对路径，如 lessons/0001-x.md"},
                "content": {"type": "string", "description": "文件全文"},
            },
            ["path", "content"],
        ),
        handler=_tool_write_deliver_file,
    ),
    "run_check": ToolSpec(
        name="run_check",
        description="把已写入的产物落到科目目录并跑渲染 + 检查，返回报错原文；请按报错修正后重新写入。",
        parameters=_params({}),
        handler=_tool_run_check,
    ),
    "produce_lesson": ToolSpec(
        name="produce_lesson",
        description=(
            "为本会话关联的科目产出一节课：真跑完整产课链（讲解 → 出题 → 渲染 → 检查，"
            "检查不过会自动按归属打回重派，最多 2 轮）。产课可能要几分钟，期间会持续回吐进度。"
            "按大纲顺序推进（跳跃节点会失败）；不传 node_id 时**严格**选大纲里第一个还没有课件的"
            "节点（不使用会话当前聚焦/学习中节点——要指定就显式传 node_id）。"
            "默认允许复用已存在且本轮检查通过的产物；要强制重做（覆盖既有课件）时传 regenerate=true。"
            "完成后在回复里告诉学习者产出了哪个节点、产物在哪、下一步做什么。"
        ),
        parameters=_params(
            {
                "node_id": {
                    "type": "string",
                    "description": "要产课的节点 id；省略则选大纲顺序里第一个还没课件的节点",
                },
                "regenerate": {
                    "type": "boolean",
                    "description": (
                        "强制重做：true 时必须重新生成产物，不得以已存在的旧课件冒充交付；"
                        "且必须同时显式传 node_id。非布尔值会被拒绝。"
                        "默认 false 允许复用已存在且本轮检查通过的产物"
                    ),
                },
            }
        ),
        handler=_tool_produce_lesson,
    ),
    "assess_node": ToolSpec(
        name="assess_node",
        description=(
            "按本会话的记录评估学习者在某节点上的掌握：给出判定、掌握度与是否置位，"
            "并落一份评估记录（通过时同时推进课程进度）。需要学习者已给出作答/理解原文。"
        ),
        parameters=_params(
            {
                "node_id": {"type": "string", "description": "要评估的节点 id"},
                "evidence": {
                    "type": "string",
                    "description": "学习者的作答/理解原文（评估据此判分，越具体越好）",
                },
            },
            ["node_id", "evidence"],
        ),
        handler=_tool_assess_node,
    ),
    "start_course_interview": ToolSpec(
        name="start_course_interview",
        description=(
            "把当前会话切入建课（方向盘问）模式。学习者不知道学什么、想开一门新课、"
            "或明确要求规划课程/选方向时调用；调用成功后立刻开始方向盘问"
            "（方向/目标/程度/基础），信息足够后按建课规范收口建草稿。"
            "已关联科目的会话调用会失败——换科目或另建新课请让学习者开新会话。"
        ),
        parameters=_params({}),
        handler=_tool_start_course_interview,
    ),
}

CHAT_TOOLS = ("list_workspace", "read_course_file", "read_skill", "start_course_interview")
# 会话绑定科目后额外开放的动作工具（产课 / 评估需要会话上下文与长墙钟）
# start_course_interview 属基础聊天工具（未绑定科目更要能切建课），不在此列
CHAT_ACTION_TOOLS = ("produce_lesson", "assess_node")
BUILD_TOOLS = ("list_workspace", "read_course_file", "submit_curriculum")
PRODUCE_TOOLS = ("list_workspace", "read_course_file", "write_deliver_file", "run_check")


def schemas(names: tuple[str, ...] | list[str]) -> list[dict[str, Any]]:
    return [TOOL_SPECS[name].schema() for name in names if name in TOOL_SPECS]


async def execute(name: str, arguments: Any, ctx: ToolContext) -> dict[str, Any]:
    """执行一个工具调用；未知工具/参数畸形/处理器异常一律转 is_error 文本。"""
    spec = TOOL_SPECS.get(name)
    if spec is None:
        return {"content": f"未知工具：{name}", "is_error": True}
    if isinstance(arguments, str):
        import json

        try:
            arguments = json.loads(arguments) if arguments.strip() else {}
        except json.JSONDecodeError as exc:
            return {"content": f"工具参数不是合法 JSON：{exc}", "is_error": True}
    if not isinstance(arguments, dict):
        return {"content": "工具参数必须是 JSON 对象", "is_error": True}
    try:
        result = await spec.handler(arguments, ctx)
    except Exception as exc:  # noqa: BLE001 - 工具失败不炸循环
        return {"content": f"工具执行失败：{type(exc).__name__}: {exc}", "is_error": True}
    if not isinstance(result, dict):
        return {"content": str(result), "is_error": False}
    return result
