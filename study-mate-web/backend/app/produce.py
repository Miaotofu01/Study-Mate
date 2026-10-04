"""生产链编排（§5.1 C/D 行 2026-10-03 拍板）：后端承担总控的机械职责。

产课链（单节点）：讲解派工（learning-coach）→ 出题派工（practice-evaluator
时机一；实验课走实验材料派工，不派讲解）→ render_lesson.py 渲染 →
check_lesson.py 质检 → 按路径模式归属打回（上限 MAX_RETRIES 轮，重派附报错
原文证据）→ 耗尽建质检工单（handoff）。派工 envelope 契约失败（模型偶发
畸形 JSON）同样原值重派 MAX_RETRIES 次，耗尽转 error 停止。

打回归属只认路径模式（roles.OWNERSHIP），不实现第二份归属规则。
事件一律经 emit 回吐（stage/retry/handoff/done/error），SSE 路由转发进会话。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import audit
from . import curriculum_store as cs
from . import draft as draft_svc
from . import roles, tickets as tickets_svc
from .config import REPO_ROOT, SCRIPTS_DIR

MAX_RETRIES = 2
# 派工路由 → 归属展示名（与 stage 标签一致；重试事件给 UI 显示用）
DISPATCH_OWNERS = {
    "produce_content": "讲解",
    "produce_quiz": "出题",
    "produce_experiment": "出题",
}
Event = dict[str, Any]
Emit = Callable[[Event], Awaitable[None]]


def lesson_rel(index: int, node_id: str, ext: str) -> str:
    """与上游 lessonfile.lesson_name 同规：序号 4 位零填充。"""
    return f"lessons/{int(index):04d}-{node_id}.{ext}"


def is_draft(base: Path) -> bool:
    return base.parent.name == draft_svc.DRAFTS_DIR.name


def _relativize(path: str, base: Path) -> str:
    try:
        resolved = Path(path).resolve()
        return str(resolved.relative_to(base.resolve())).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


def parse_problems(text: str, base: Path) -> list[dict[str, str]]:
    """渲染/检查输出 → 问题清单：`<文件>:<行> <问题>` 与 `FAIL <文件>: <问题；…>`。

    check_lesson 的 FAIL 前缀是渲染产物 .html（归属映射表达不了"消息指向哪份产物"），
    归属再按消息正文里引用的产物路径判一次——这是 learning-system「课件三份产物的
    归属」表对检查器报错的机械延伸，不是第二份规则。
    """
    problems: list[dict[str, str]] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("WARN") or line.startswith("OK"):
            continue
        fail = re.match(r"^FAIL\s+(.+?):\s+(.+)$", line)
        if fail:
            rel = _relativize(fail.group(1), base)
            for message in fail.group(2).split("；"):
                problems.append({"path": rel, "line": "", "message": message.strip()})
            continue
        rendered = re.match(r"^(.+?):(\d+)\s+(.+)$", line)
        if rendered:
            rel = _relativize(rendered.group(1), base)
            problems.append(
                {"path": rel, "line": rendered.group(2), "message": rendered.group(3).strip()}
            )
    for problem in problems:
        problem["owner"] = _owner_of_problem(problem)
    return problems


def _owner_of_problem(problem: dict[str, str]) -> str:
    """检查器报错的归属：题库/quiz 类问题归出题（learning-system 打回表：
    "题库与锚点对不上的打回「出题评估」"，与报错挂在哪份文件上无关）；
    其余按产物路径映射，.html 前缀的报错再从消息正文里找被引用的产物路径。"""
    message = str(problem.get("message") or "")
    if re.search(r"题库|quiz", message, re.IGNORECASE):
        return "出题"
    path = str(problem.get("path") or "")
    owner = roles.owner_of(path)
    if owner == "总控" and path.endswith(".html"):
        for match in re.finditer(r"(?:lab/[\w./\\-]+|[\w./\\-]+\.(?:md|quiz\.json|yaml))", message):
            candidate = roles.owner_of(match.group(0).replace("\\", "/"))
            if candidate != "总控":
                return candidate
    return owner


def problem_owner_for_node(problem: dict[str, str], kind: str) -> str:
    """节点相关的归属修正：实验课不派讲解，其实验说明页（lessons/*.md）归出题。"""
    owner = str(problem.get("owner") or "总控")
    if kind == "实验" and owner == "讲解":
        return "出题"
    return owner


async def _run_script(args: list[str]) -> tuple[int, str]:
    """上游脚本子进程；to_thread 不冻结事件循环（渲染+检查一轮最长数分钟）。"""
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}

    def _invoke() -> tuple[int, str]:
        try:
            proc = subprocess.run(
                [sys.executable, "-B", *args],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                env=env,
            )
            return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
        except (OSError, subprocess.TimeoutExpired) as exc:
            return 1, f"{type(exc).__name__}: {exc}"

    return await asyncio.to_thread(_invoke)


def ensure_subject_assets(base: Path) -> None:
    """总控补齐科目组件与共享层组件（record-keeping「新建」+ 渲染引用解析）。"""
    templates = REPO_ROOT / "templates" / "assets"
    base_assets = base / "assets"
    base_assets.mkdir(parents=True, exist_ok=True)
    for name in ("style.css", "quiz.js", "lesson-toc.js"):
        source = templates / name
        target = base_assets / name
        if source.is_file() and not target.exists():
            shutil.copyfile(source, target)
    shared = base.parent.parent / "assets"
    shared.mkdir(parents=True, exist_ok=True)
    for name in ("learn-theme.css", "learn-theme.js"):
        source = templates / name
        target = shared / name
        if source.is_file() and not target.exists():
            shutil.copyfile(source, target)
    sayo_source = templates / "sayo"
    sayo_target = shared / "sayo"
    if sayo_source.is_dir() and not sayo_target.exists():
        shutil.copytree(sayo_source, sayo_target)


# ---------- 基目录感知的读写（草稿或工作区科目） ----------


def _curriculum_of(base: Path, slug: str) -> list[dict[str, Any]]:
    curriculum = (
        draft_svc.draft_curriculum(slug) if is_draft(base) else cs.get_curriculum(slug)
    )
    return [n for n in ((curriculum or {}).get("nodes") or []) if isinstance(n, dict)]


def _progress_of(base: Path, slug: str) -> dict[str, Any]:
    return draft_svc.draft_progress(slug) if is_draft(base) else cs.get_progress(slug)


def _glossary_text(base: Path) -> str:
    path = base / "GLOSSARY.md"
    return path.read_text(encoding="utf-8") if path.is_file() else "（术语表未建）"


def _mission_text(base: Path) -> str:
    path = base / "MISSION.md"
    if path.is_file():
        return path.read_text(encoding="utf-8")
    subject = base / "subject.yaml"
    return subject.read_text(encoding="utf-8") if subject.is_file() else "（科目使命未建）"


def _resources_text(base: Path) -> str:
    path = base / "RESOURCES.md"
    return path.read_text(encoding="utf-8") if path.is_file() else "（资源清单未建）"


def _reference_blocks(base: Path, limit_per_file: int = 8000) -> str:
    """reference/ 落盘原文内联（每文件截断）；没有就空串。"""
    reference = base / "reference"
    if not reference.is_dir():
        return ""
    blocks: list[str] = []
    for path in sorted(reference.glob("*.md")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if len(text) > limit_per_file:
            text = text[:limit_per_file] + "…（超长截断）"
        blocks.append(f'<reference file="{path.name}">\n{text}\n</reference>')
    return "\n\n".join(blocks)


def _pool_text(base: Path) -> str:
    pool = base / "assets" / "img" / "pool.md"
    if not pool.is_file():
        return "（图片库为空：没有已采集的图）"
    return pool.read_text(encoding="utf-8")


def _carrier(base: Path) -> str:
    subject = base / "subject.yaml"
    if subject.is_file():
        match = re.search(r"^carrier:\s*(.+)$", subject.read_text(encoding="utf-8"), re.MULTILINE)
        if match:
            return match.group(1).strip()
    return "练习页"


# ---------- 派工值组装（拍板②：路径 → 内容内联） ----------


def _node_block(node: dict[str, Any]) -> list[str]:
    return [
        f"【节点 id】{node['id']}",
        f"【节点标题（front matter 的 title 必须逐字用它）】{node.get('title', '')}",
        f"【课型 kind】{node.get('kind', '概念')}",
        f"【学习目标 objective】{node.get('objective', '')}",
        f"【场景钩子 problem】{node.get('problem', '')}",
        f"【侧重 practice】{node.get('practice', '')}",
        f"【易错点 pitfalls】{'；'.join(node.get('pitfalls') or []) or '无'}",
    ]


def _prerequisite_summary(base: Path, slug: str, node: dict[str, Any]) -> str:
    titles = {n.get("id"): n for n in _curriculum_of(base, slug)}
    lines = []
    for pre in node.get("prerequisites") or []:
        target = titles.get(pre) or {}
        lines.append(f"- {target.get('title', pre)}（{pre}）：{target.get('objective', '')}")
    return "\n".join(lines) or "（无前置节点）"


def content_values(base: Path, slug: str, node: dict[str, Any], index: int) -> str:
    """讲解派工值：节点字段逐字 + 前置摘要 + 使命/术语/资源清单 + reference/ 原文 + 图片索引。"""
    return "\n".join(
        [
            "【本课任务】把下面的节点讲成一节课，产出「课件内容文件」。",
            *_node_block(node),
            f"【课件内容文件相对路径（files[0].path 用它）】{lesson_rel(index, str(node['id']), 'md')}",
            "",
            "【前置节点摘要（总控生成）】",
            _prerequisite_summary(base, slug, node),
            "",
            "【科目使命】",
            _mission_text(base),
            "",
            "【术语表（用词以此为准）】",
            _glossary_text(base),
            "",
            "【资源清单】",
            _resources_text(base),
            "",
            "【reference/ 落盘原文（讲解以此为准，没给就不虚构）】",
            _reference_blocks(base) or "（reference/ 暂无落盘资料）",
            "",
            "【图片库索引】",
            _pool_text(base),
            "（课件配图优先从索引挑；没有合适的图就不放图，不要虚构索引行。）",
        ]
    )


def quiz_values(base: Path, slug: str, node: dict[str, Any], index: int, content: str) -> str:
    """出题派工值（时机一）：节点 kind + 课件内容文件全文（锚点从中读，键逐字对应）。"""
    return "\n".join(
        [
            "【本课任务】为下面这节课出题（时机一 · 出题）。",
            *_node_block(node),
            f"【实验载体】{_carrier(base)}",
            f"【题目文件相对路径（files[0].path 用它）】{lesson_rel(index, str(node['id']), 'quiz.json')}",
            "",
            "【课件内容文件全文（锚点从中读，题库键逐字对应；内容一个字不改）】",
            content,
        ]
    )


def experiment_values(base: Path, slug: str, node: dict[str, Any], index: int) -> str:
    """实验材料派工值（时机一 · 实验任务）：说明页 + 实操任务一次出齐。"""
    progress = _progress_of(base, slug)
    return "\n".join(
        [
            "【本课任务】为实验节点一次出齐材料（时机一 · 实验任务）：实验说明页与实操任务。",
            *_node_block(node),
            f"【实验说明页相对路径（files[0].path 用它）】{lesson_rel(index, str(node['id']), 'md')}",
            "【实操任务相对路径】lab/<NNNN>-<主题>/…（按规范交付格式整棵树）",
            f"【被验收节点】{'、'.join(node.get('prerequisites') or []) or '无'}",
            f"【项目目标】{(progress.get('project') or {}).get('current') or '以科目使命为准'}",
            "",
            "【科目使命】",
            _mission_text(base),
            "",
            "【术语表（用词以此为准）】",
            _glossary_text(base),
        ]
    )


# ---------- fixture 工厂（E2E）：从派工值提取节点信息，产可过渲染+检查的 envelope ----------


def _fixture_field(values: str, label: str, default: str = "") -> str:
    match = re.search(rf"【{label}[^】]*】([^\n]*)", values)
    return match.group(1).strip() if match else default


def _fixture_path(values: str, default: str) -> str:
    match = re.search(r"【[^】*]*files\[0\]\.path 用它[^】]*】([^\n]*)", values)
    return match.group(1).strip() if match else default


def fixture_content_envelope(values: str) -> dict[str, Any]:
    title = _fixture_field(values, "节点标题", "未命名节点")
    goal = _fixture_field(values, "学习目标", "") or "完成本课学习目标"
    kind = _fixture_field(values, "课型", "概念")
    path = _fixture_path(values, "lessons/0001-x.md")
    match = re.match(r"lessons/(\d+)-", path)
    seq = match.group(1) if match else "0001"
    lab_link = (
        (f"\n实操任务见 [lab/{seq}-stage/README.md](../lab/{seq}-stage/README.md)。\n" if kind == "实操" else "")
    )
    content = (
        f"---\ntitle: {title}\ngoal: {goal}\n---\n\n"
        "## 这节课讲什么\n\n"
        f"{goal}。先从一个具体现象入手，把要解决的问题立起来。\n\n"
        f"::: quiz L1 锚点：{title}的核心判断\n\n:::\n\n"
        "::: practice 练习 | 动手试一试\n\n"
        "按本课要点完成一个小练习，把结果记录下来。\n\n:::\n\n"
        "## 小结\n\n"
        f"- 本课围绕「{title}」建立了基本框架\n- 下一课在此基础上继续\n"
        f"{lab_link}"
    )
    return {
        "files": [{"path": path, "content": content}],
        "report": {"summary": ["fixture 课件内容"]},
    }


def fixture_quiz_envelope(values: str) -> dict[str, Any]:
    path = _fixture_path(values, "lessons/0001-x.quiz.json")
    anchor = re.search(r"::: quiz [^\n]*锚点：([^\n]*)", values)
    key = anchor.group(1).strip() if anchor else "本课核心判断"
    kind = _fixture_field(values, "课型", "概念")
    quiz = {
        key: [
            {
                "q": "同样的内容为什么效果差别很大？",
                "opts": ["是否逐步对照要点验证", "是否凭印象作答", "是否跳过练习"],
                "ans": 0,
                "why": "本课强调动手验证，逐条对照才算掌握。",
            }
        ]
    }
    files: list[dict[str, str]] = [{"path": path, "content": json.dumps(quiz, ensure_ascii=False)}]
    if kind == "实操":
        # 实操课连带 lab 任务与 solutions/（参考答案与任务分开放，check_lesson 会查）
        match = re.match(r"lessons/(\d+)-", path)
        seq = match.group(1) if match else "0001"
        files.append(
            {
                "path": f"lab/{seq}-stage/README.md",
                "content": "# 实操任务\n\n## 任务\n\n按课件里的练习完成一个小任务。\n\n## 自查清单\n\n- 结果可复现\n",
            }
        )
        files.append(
            {
                "path": f"lab/solutions/{seq}-stage/README.md",
                "content": "# 参考解\n\n按任务清单逐步实现即可；运行结果与自查项一致。\n",
            }
        )
    return {"files": files, "report": {"summary": ["fixture 题库"]}}


def fixture_experiment_envelope(values: str) -> dict[str, Any]:
    title = _fixture_field(values, "节点标题", "阶段实验")
    goal = _fixture_field(values, "学习目标", "") or "完成阶段验收"
    page_path = _fixture_path(values, "lessons/0001-x.md")
    # lab 目录序号跟课件序号一致（lessons/0003-… → lab/0003-…）
    match = re.match(r"lessons/(\d+)-", page_path)
    seq = match.group(1) if match else "0001"
    content = (
        f"---\ntitle: {title}\ngoal: {goal}\n---\n\n"
        "## 这次要做出什么\n\n"
        f"{goal}。按自查清单逐条对照。\n\n"
        "## 怎么算过\n\n- 每条自查项都能在产物里指出来\n\n"
        f"实操任务见 [lab/{seq}-stage/README.md](../lab/{seq}-stage/README.md)。\n"
    )
    task = "# 阶段实验任务\n\n## 任务\n\n完成阶段产物并逐条自查。\n\n## 自查清单\n\n- 产物能运行\n"
    return {
        "files": [
            {"path": page_path, "content": content},
            {"path": f"lab/{seq}-stage/README.md", "content": task},
        ],
        "report": {"summary": ["fixture 实验材料"]},
    }


def fixture_curriculum_envelope(_: str) -> dict[str, Any]:
    from .llm import FIXTURE_CURRICULUM

    return {"files": [], "data": FIXTURE_CURRICULUM, "report": {"summary": ["fixture 大纲"]}}


# ---------- 派工（fixture 模式走工厂；真调用走 roles.dispatch_role） ----------


async def _role_tool_loop(
    provider: dict[str, Any],
    route: str,
    values: str,
    emit: Emit,
    *,
    base: Path,
    node_id: str,
    index: int,
    stage_dir: Path,
) -> dict[str, Any] | None:
    """K3：角色用写工具交付产物，并用 run_check 在循环内自查自修。

    返回 envelope 等价体（files 来自写工具）；没有任何交付（循环耗尽/降级）返回
    None，由调用方回落既有单次派工链（保留兜底）。
    """
    from . import agent as agent_svc
    from . import prompts
    from . import tools as tools_svc

    system_text, missing = prompts.inject_role(route)
    if missing:
        await emit({"event": "error", "message": f"角色技能规范缺失：{'、'.join(missing)}"})
        return None
    owner = DISPATCH_OWNERS.get(route, "总控")
    ctx = tools_svc.ToolContext(
        read_roots=[base],
        write_roots=[],
        label="科目目录",
        state={
            "stage_dir": str(stage_dir),
            "base": str(base),
            "node_id": node_id,
            "index": index,
            "files": [],
        },
    )
    messages = [
        {"role": "system", "content": system_text},
        {"role": "user", "content": values},
    ]
    audit.record("dispatch", route=route, loop="tools", values=values)

    async def on_progress(snapshot: dict[str, Any]) -> None:
        """进度快照 → SSE progress：编排面板显示「第 N 轮 · 已等待 Ns」。"""
        await emit({"event": "progress", "stage": owner, **snapshot})

    async def on_event(event: dict[str, Any]) -> None:
        if event["type"] == "tool_call" and event.get("name") == "run_check":
            await emit({"event": "stage", "stage": "检查", "status": "start"})
        elif event["type"] == "tool_result" and event.get("name") == "run_check":
            await emit(
                {"event": "stage", "stage": "检查", "status": "done" if not event.get("is_error") else "fail"}
            )

    outcome = await agent_svc.run_agent(
        agent_svc.real_turn_source(provider),
        messages,
        ctx,
        on_event,
        tools_svc.schemas(tools_svc.PRODUCE_TOOLS),
        audit_meta={"kind": "produce", "route": route, "node_id": node_id},
        max_seconds=agent_svc.ORCH_MAX_SECONDS,
        on_progress=on_progress,
    )
    files = ctx.state.get("files") or []
    if not files:
        audit.record("produce_loop_no_files", route=route, degraded=outcome.degraded)
        return None
    return {"files": files, "report": {"summary": [f"{owner} 工具循环交付"]}}


async def dispatch(
    provider: dict[str, Any],
    route: str,
    values: str,
    factory: Callable[[str], dict[str, Any]],
    emit: Emit,
    *,
    base: Path | None = None,
    node_id: str | None = None,
    index: int = 0,
    stage_dir: Path | None = None,
) -> dict[str, Any] | None:
    """返回 envelope；失败已 emit error 并返回 None。"""
    from .llm import is_fixture_mode, supports_tools

    if is_fixture_mode():
        return factory(values)
    # 工具调用默认对所有配置的模型开启（2026-10-04）：真实模型优先走角色工具循环，
    # 循环无交付（耗尽/降级）时回落下面的单次派工链兜底。
    if supports_tools(provider) and base is not None and node_id and stage_dir is not None:
        loop_env = await _role_tool_loop(
            provider, route, values, emit, base=base, node_id=node_id, index=index, stage_dir=stage_dir
        )
        if loop_env is not None:
            return loop_env
    owner = DISPATCH_OWNERS.get(route, "总控")
    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            return await roles.dispatch_role(provider, route, values, fixture_kind=route)
        except ValueError as exc:
            # 契约失败（模型偶发畸形 JSON）同样按"规格是权威"原值重派：
            # 偶发畸形重滚一次多半就好（实测复派即合规），耗尽再转人工。
            last_error = exc
            if attempt >= MAX_RETRIES:
                break
            await emit(
                {
                    "event": "retry",
                    "round": attempt + 1,
                    "owners": [owner],
                    "reason": f"{owner}交付不合规，原值重派",
                    "problems": [
                        {
                            "path": f"（{route} 派工）",
                            "line": "",
                            "message": str(exc),
                            "owner": owner,
                        }
                    ],
                }
            )
    await emit(
        {
            "event": "error",
            "message": f"{owner}连续 {MAX_RETRIES + 1} 次交付不合规，已停止：{last_error}",
        }
    )
    return None


async def _write_and_promote(
    stage_dir: Path, base: Path, envelope: dict[str, Any]
) -> list[str] | None:
    files = roles.envelope_files(envelope)
    if not files:
        return None
    roles.write_deliver(stage_dir, files)
    return roles.promote_deliver(stage_dir, base, files)


def _delivered_digest(envelope: dict[str, Any]) -> str:
    """交付摘要（报错诊断用）：实际交付的路径 + report 头部。

    没有它，「交付里没有课件内容文件」这句报错无法区分是模型漏了 files、
    还是路径写错——两种修法完全不同。
    """
    files = envelope.get("files")
    if not isinstance(files, list):
        where = f"files 不是数组（{type(files).__name__}）"
    else:
        where = "、".join(
            str(item.get("path") or "?") for item in files if isinstance(item, dict)
        ) or "files 为空"
    report = str(envelope.get("report") or "").strip()
    digest = f"实际交付：{where[:200]}"
    return f"{digest}；report：{report[:150]}" if report else digest


# ---------- 渲染 + 检查 ----------


async def render_and_check(
    base: Path, node_id: str, index: int, emit: Emit
) -> tuple[bool, list[dict[str, str]]]:
    await emit({"event": "stage", "stage": "渲染", "status": "start"})
    code, output = await _run_script([str(SCRIPTS_DIR / "render_lesson.py"), str(base), node_id])
    if code != 0:
        problems = parse_problems(output, base)
        await emit({"event": "stage", "stage": "渲染", "status": "fail", "problems": problems})
        return False, problems
    await emit({"event": "stage", "stage": "渲染", "status": "done"})

    page = base / lesson_rel(index, node_id, "html")
    await emit({"event": "stage", "stage": "检查", "status": "start"})
    code, output = await _run_script(
        [
            str(SCRIPTS_DIR / "check_lesson.py"),
            str(page),
            "--subject",
            str(base),
            "--node",
            node_id,
        ]
    )
    if code != 0:
        problems = parse_problems(output, base)
        await emit({"event": "stage", "stage": "检查", "status": "fail", "problems": problems})
        return False, problems
    await emit({"event": "stage", "stage": "检查", "status": "done"})
    return True, []


def _evidence_block(problems: list[dict[str, str]]) -> str:
    lines = [
        f"- {p.get('path')}:{p.get('line')} {p.get('message')}" for p in problems
    ]
    return "\n".join(lines)


# ---------- 产课链（单节点） ----------


async def run_produce(
    base: Path,
    slug: str,
    node_id: str,
    provider: dict[str, Any],
    emit: Emit,
) -> None:
    """产课链。事件：stage / retry / handoff / done / error。"""
    audit.bind(f"produce-{slug}-{node_id}")
    nodes = _curriculum_of(base, slug)
    node = next((n for n in nodes if n.get("id") == node_id), None)
    if node is None:
        await emit({"event": "error", "message": f"节点不存在：{node_id}"})
        return
    index = nodes.index(node) + 1
    lessons_dir = base / "lessons"
    existing = {path.name for path in lessons_dir.glob("*.md")} if lessons_dir.is_dir() else set()
    has_own = any(name.endswith(f"-{node_id}.md") for name in existing)
    if not has_own and index != len(existing) + 1:
        # 上游检查器要求课件编号连续（checker：不能跳号）；产课按大纲顺序推进
        await emit(
            {
                "event": "error",
                "message": f"按大纲顺序产课：本节点排位 {index}，但已有 {len(existing)} 份课件——先产出前面的节点。",
            }
        )
        return
    kind = str(node.get("kind") or "概念")
    stage_root = base / ".stage"

    try:
        ensure_subject_assets(base)
        if not (SCRIPTS_DIR / "render_lesson.py").is_file() or not (
            SCRIPTS_DIR / "check_lesson.py"
        ).is_file():
            await emit({"event": "error", "message": "上游脚本缺失：render_lesson.py / check_lesson.py"})
            return

        if kind == "实验":
            await emit({"event": "stage", "stage": "出题", "status": "start"})
            values = experiment_values(base, slug, node, index)
            env = await dispatch(
                provider, "produce_experiment", values, fixture_experiment_envelope, emit,
                base=base, node_id=node_id, index=index, stage_dir=stage_root,
            )
            if env is None:
                return
            moved = await _write_and_promote(stage_root / "practice-evaluator", base, env)
            page_rel = lesson_rel(index, node_id, "md")
            if moved is None or page_rel not in moved:
                await emit(
                    {
                        "event": "error",
                        "message": f"实验材料交付里没有说明页（相对路径不符）——{_delivered_digest(env)}",
                    }
                )
                return
            await emit({"event": "stage", "stage": "出题", "status": "done", "artifacts": moved})
            values_for_retry = lambda: experiment_values(base, slug, node, index)  # noqa: E731
        else:
            content_rel = lesson_rel(index, node_id, "md")
            await emit({"event": "stage", "stage": "讲解", "status": "start"})
            values = content_values(base, slug, node, index)
            env = await dispatch(
                provider, "produce_content", values, fixture_content_envelope, emit,
                base=base, node_id=node_id, index=index, stage_dir=stage_root,
            )
            if env is None:
                return
            moved = await _write_and_promote(stage_root / "learning-coach", base, env)
            if moved is None or content_rel not in moved:
                await emit(
                    {
                        "event": "error",
                        "message": f"讲解交付里没有课件内容文件（相对路径不符）——{_delivered_digest(env)}",
                    }
                )
                return
            await emit({"event": "stage", "stage": "讲解", "status": "done", "artifacts": moved})

            await emit({"event": "stage", "stage": "出题", "status": "start"})
            content = (base / content_rel).read_text(encoding="utf-8")
            env = await dispatch(
                provider,
                "produce_quiz",
                quiz_values(base, slug, node, index, content),
                fixture_quiz_envelope,
                emit,
                base=base,
                node_id=node_id,
                index=index,
                stage_dir=stage_root,
            )
            if env is None:
                return
            moved = await _write_and_promote(stage_root / "practice-evaluator", base, env)
            if moved is None:
                await emit({"event": "error", "message": f"出题交付为空——{_delivered_digest(env)}"})
                return
            await emit({"event": "stage", "stage": "出题", "status": "done", "artifacts": moved})

        def with_kind(problems: list[dict[str, str]]) -> list[dict[str, str]]:
            return [{**p, "owner": problem_owner_for_node(p, kind)} for p in problems]

        ok, problems = await render_and_check(base, node_id, index, emit)
        problems = with_kind(problems)
        round_no = 0
        while not ok and round_no < MAX_RETRIES:
            round_no += 1
            owners = sorted({str(p.get("owner") or "总控") for p in problems})
            ensure_subject_assets(base)
            await emit({"event": "retry", "round": round_no, "owners": owners, "problems": problems})

            if owners == ["总控"]:
                # 纯总控归属（组件缺失类）：补组件后重查一次，仍不过直接转人工，不空烧轮次
                ok, problems = await render_and_check(base, node_id, index, emit)
                problems = with_kind(problems)
                break

            if kind != "实验" and "讲解" in owners:
                evidence = content_values(base, slug, node, index)
                current = base / lesson_rel(index, node_id, "md")
                if current.exists():
                    evidence += "\n\n【上一稿全文】\n" + current.read_text(encoding="utf-8")
                evidence += "\n\n【上一稿渲染/检查报错（逐行原文，改到没有为止）】\n" + _evidence_block(
                    [p for p in problems if p.get("owner") == "讲解"]
                )
                env = await dispatch(
                    provider, "produce_content", evidence, fixture_content_envelope, emit,
                    base=base, node_id=node_id, index=index, stage_dir=stage_root,
                )
                if env is None:
                    return
                await _write_and_promote(stage_root / "learning-coach", base, env)

            # 内容重写会动锚点，出题必须跟着重派；只有出题归属的问题时单独重派
            quiz_needed = "出题" in owners or (kind != "实验" and "讲解" in owners)
            if quiz_needed:
                content_now = (
                    (base / lesson_rel(index, node_id, "md")).read_text(encoding="utf-8")
                    if (base / lesson_rel(index, node_id, "md")).exists()
                    else None
                )
                if kind == "实验":
                    base_values = experiment_values(base, slug, node, index)
                else:
                    base_values = quiz_values(
                        base, slug, node, index, content_now or _experiment_brief_fallback(node)
                    )
                evidence = base_values + "\n\n【上一稿渲染/检查报错（逐行原文，改到没有为止）】\n" + _evidence_block(
                    [p for p in problems if p.get("owner") in ("出题", "总控")]
                )
                route = "produce_experiment" if kind == "实验" else "produce_quiz"
                factory = fixture_experiment_envelope if kind == "实验" else fixture_quiz_envelope
                env = await dispatch(
                    provider, route, evidence, factory, emit,
                    base=base, node_id=node_id, index=index, stage_dir=stage_root,
                )
                if env is None:
                    return
                await _write_and_promote(stage_root / "practice-evaluator", base, env)

            ok, problems = await render_and_check(base, node_id, index, emit)
            problems = with_kind(problems)

        if not ok:
            artifacts = [
                lesson_rel(index, node_id, ext)
                for ext in (("md", "html") if kind == "实验" else ("md", "quiz.json", "html"))
            ]
            ticket = tickets_svc.create_ticket(
                kind="produce",
                slug=slug,
                node_id=node_id,
                base_label="draft" if is_draft(base) else "workspace",
                problems=problems,
                artifacts=artifacts,
            )
            await emit({"event": "handoff", "ticket": ticket})
            await emit(
                {
                    "event": "error",
                    "message": f"质检打回 {MAX_RETRIES} 轮仍未通过，已转人工（工单 {ticket['id']}）。",
                }
            )
            return

        artifacts = [lesson_rel(index, node_id, "md"), lesson_rel(index, node_id, "html")]
        if kind != "实验":
            artifacts.insert(1, lesson_rel(index, node_id, "quiz.json"))
        await emit({"event": "done", "node_id": node_id, "artifacts": artifacts})
    finally:
        roles.clear_stage(stage_root)


def _experiment_brief_fallback(node: dict[str, Any]) -> str:
    return f"（课件内容文件缺失；节点：{node.get('title', '')} / {node.get('objective', '')}）"


# ---------- 工单动作（转人工后的重试 / 复检，§5.1 C 行拍板④） ----------


async def run_ticket_recheck(ticket_id: str, emit: Emit) -> None:
    """重新检查：用户可能已在外部改完文件，只重跑渲染+检查（建课工单则重跑门禁）。"""
    ticket = tickets_svc.get_ticket(ticket_id)
    if ticket is None:
        await emit({"event": "error", "message": f"工单不存在：{ticket_id}"})
        return
    base = tickets_svc.ticket_dir_base(ticket)
    from .build import run_curriculum_gate as build_gate

    if ticket.get("kind") == "build":
        curriculum = draft_svc.draft_curriculum(str(ticket["slug"]))
        if curriculum is None:
            await emit({"event": "error", "message": "草稿大纲缺失，无法复检"})
            return
        problems = await build_gate(curriculum)
    else:
        node_id = str(ticket.get("node_id") or "")
        nodes = _curriculum_of(base, str(ticket["slug"]))
        node = next((n for n in nodes if n.get("id") == node_id), None)
        if node is None:
            await emit({"event": "error", "message": f"节点不存在：{node_id}"})
            return
        ensure_subject_assets(base)
        ok, problems = await render_and_check(base, node_id, nodes.index(node) + 1, emit)
        if ok:
            problems = []
    if problems:
        tickets_svc.update_ticket(ticket_id, status="待处理", problems=problems)
        await emit({"event": "error", "message": f"复检未通过，仍有 {len(problems)} 处问题（已回填工单）。"})
        return
    tickets_svc.update_ticket(ticket_id, status="已解决", problems=[])
    await emit({"event": "done", "stage": "recheck", "message": "复检通过，工单已关闭。"})


async def run_ticket_retry(
    ticket_id: str,
    provider: dict[str, Any],
    emit: Emit,
    hint: str | None = None,
) -> None:
    """重试：按工单归属重派对应角色（附报错原文与可选补充说明），再过质检。"""
    from .llm import is_fixture_mode

    ticket = tickets_svc.get_ticket(ticket_id)
    if ticket is None:
        await emit({"event": "error", "message": f"工单不存在：{ticket_id}"})
        return
    if ticket.get("retries", 0) >= MAX_RETRIES:
        await emit({"event": "error", "message": "重试次数已用完：请改用快改/外部编辑后「重新检查」，或放弃本次。"})
        return
    tickets_svc.update_ticket(ticket_id, status="重试中", retries=int(ticket.get("retries", 0)) + 1)
    slug = str(ticket["slug"])
    base = tickets_svc.ticket_dir_base(ticket)
    stage_root = base / ".stage"
    hint_block = f"\n\n【学习者补充说明】{hint}" if hint else ""
    try:
        if ticket.get("kind") == "build":
            from .build import curriculum_values, interview_of, run_curriculum_gate as build_gate

            values = curriculum_values(base, interview_of(base))
            values += "\n\n【上一稿门禁报错（逐条原文，改到没有为止）】\n" + _evidence_block(
                ticket.get("problems") or []
            ) + hint_block
            if is_fixture_mode():
                envelope = fixture_curriculum_envelope(values)
            else:
                try:
                    envelope = await roles.dispatch_role(provider, "generate", values, fixture_kind="generate")
                except ValueError as exc:
                    await emit({"event": "error", "message": str(exc)})
                    return
            data = envelope.get("data") if isinstance(envelope, dict) else None
            if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
                await emit({"event": "error", "message": "大纲派工没有交回课程 JSON（data 键）"})
                return
            problems = await build_gate(data)
            if problems:
                tickets_svc.update_ticket(ticket_id, status="待处理", problems=problems)
                await emit({"event": "error", "message": f"重试后门禁仍未通过（{len(problems)} 处），已回填工单。"})
                return
            draft_svc.save_draft_curriculum(slug, data)
        else:
            node_id = str(ticket.get("node_id") or "")
            nodes = _curriculum_of(base, slug)
            node = next((n for n in nodes if n.get("id") == node_id), None)
            if node is None:
                await emit({"event": "error", "message": f"节点不存在：{node_id}"})
                return
            index = nodes.index(node) + 1
            kind = str(node.get("kind") or "概念")
            owners = {str(p.get("owner") or "总控") for p in ticket.get("problems") or []}
            ensure_subject_assets(base)

            if kind != "实验" and "讲解" in owners:
                evidence = content_values(base, slug, node, index) + hint_block
                current = base / lesson_rel(index, node_id, "md")
                if current.exists():
                    evidence += "\n\n【上一稿全文】\n" + current.read_text(encoding="utf-8")
                evidence += "\n\n【上一稿渲染/检查报错（逐行原文，改到没有为止）】\n" + _evidence_block(
                    [p for p in ticket.get("problems") or [] if p.get("owner") == "讲解"]
                )
                env = await dispatch(
                    provider, "produce_content", evidence, fixture_content_envelope, emit,
                    base=base, node_id=node_id, index=index, stage_dir=stage_root,
                )
                if env is None:
                    return
                await _write_and_promote(stage_root / "learning-coach", base, env)

            content_now = (
                (base / lesson_rel(index, node_id, "md")).read_text(encoding="utf-8")
                if (base / lesson_rel(index, node_id, "md")).exists()
                else None
            )
            if kind == "实验":
                route, factory = "produce_experiment", fixture_experiment_envelope
                base_values = experiment_values(base, slug, node, index)
            else:
                route, factory = "produce_quiz", fixture_quiz_envelope
                base_values = quiz_values(
                    base, slug, node, index, content_now or _experiment_brief_fallback(node)
                )
            evidence = base_values + hint_block + "\n\n【上一稿渲染/检查报错（逐行原文，改到没有为止）】\n" + _evidence_block(
                [p for p in ticket.get("problems") or [] if p.get("owner") in ("出题", "总控")]
            )
            env = await dispatch(
                provider, route, evidence, factory, emit,
                base=base, node_id=node_id, index=index, stage_dir=stage_root,
            )
            if env is None:
                return
            await _write_and_promote(stage_root / "practice-evaluator", base, env)

            ok, problems = await render_and_check(base, node_id, index, emit)
            if not ok:
                tickets_svc.update_ticket(ticket_id, status="待处理", problems=problems)
                await emit({"event": "error", "message": f"重试后质检仍未通过（{len(problems)} 处），已回填工单。"})
                return

        tickets_svc.update_ticket(ticket_id, status="已解决", problems=[])
        await emit({"event": "done", "stage": "retry", "message": "重试通过，工单已关闭。"})
    finally:
        roles.clear_stage(stage_root)
