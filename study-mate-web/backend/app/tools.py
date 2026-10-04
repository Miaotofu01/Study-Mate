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

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

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


def _resolve_within(root: Path, relative: str, *, mode: str) -> Path:
    """把相对路径解析进 root 并当场 canonicalize 校验包含关系（消 TOCTOU）。"""
    if not relative:
        raise _denied(mode, "路径为空")
    candidate_rel = Path(relative)
    if candidate_rel.is_absolute() or ".." in candidate_rel.parts:
        raise _denied(mode, f"路径越界：{relative}")
    root = root.resolve()
    target = (root / candidate_rel).resolve()
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
    candidate = Path(str(relative))
    if not relative or candidate.is_absolute() or ".." in candidate.parts:
        raise SandboxError(f"[sandbox: file access denied under write mode] 非法交付路径：{relative}")
    return str(candidate).replace("\\", "/")


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
        target = Path(stage) / "deliver" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
    files = ctx.state.setdefault("files", [])
    files.append({"path": relative, "content": content})
    return {"content": f"已写入交付：{relative}（{len(content)} 字符）", "is_error": False}


async def _tool_submit_curriculum(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """提交课程大纲；后端立即跑门禁并把报错原文返回，模型据此自修。"""
    data = args.get("data") if isinstance(args.get("data"), dict) else args
    if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
        return {"content": "提交内容缺少 nodes 数组（大纲 DAG）", "is_error": True}
    from . import build as build_svc

    problems = await build_svc.run_curriculum_gate(data)
    if problems:
        lines = "\n".join(f"- {p['message']}" for p in problems[:20])
        return {
            "content": f"门禁未过（{len(problems)} 处），请逐条修正后重新提交：\n{lines}",
            "is_error": True,
        }
    ctx.state["curriculum"] = data
    return {"content": "已提交，通过门禁。请在最终回复里简述大纲设计，然后结束。", "is_error": False}


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
    if ok:
        return {"content": "渲染与检查均通过。", "is_error": False}
    lines = "\n".join(f"- {p.get('path')}:{p.get('line')} {p.get('message')}" for p in problems[:20])
    return {"content": f"检查未过（{len(problems)} 处），请按报错修正后重新写入：\n{lines}", "is_error": True}


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
            "提交课程大纲（课程 DAG：nodes/edges）。后端会立即跑门禁校验，"
            "未过则把报错原文返回给你，按报错逐条修正后重新提交，直到通过。"
        ),
        parameters=_params(
            {
                "data": {
                    "type": _OBJECT,
                    "description": '{"nodes": [...], "edges": [...]}，节点字段以 curriculum.schema.json 为准',
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
}

CHAT_TOOLS = ("list_workspace", "read_course_file", "read_skill")
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
