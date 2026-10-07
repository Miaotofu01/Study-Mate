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
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

import yaml

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
# 强制重做口径：工具循环与单次回落共用同一份文案（措辞不绑具体工具/交付形态）。
FORCED_REDO_NOTE = (
    "\n\n【本轮为强制重做】必须重新生成并交付完整产物，"
    "不得以已存在的旧文件代替；旧文件不算本轮交付。"
)
Event = dict[str, Any]
Emit = Callable[[Event], Awaitable[None]]


def lesson_rel(index: int, node_id: str, ext: str) -> str:
    """与上游 lessonfile.lesson_name 同规：序号 4 位零填充。"""
    return f"lessons/{int(index):04d}-{node_id}.{ext}"


def _seq(index: int) -> str:
    """课件编号（4 位零填充），与 lesson_rel / lab 目录同源。"""
    return f"{int(index):04d}"


def lab_rel(index: int, name: str = "README.md") -> str:
    """实操/实验的 lab 任务相对路径：`lab/<NNNN>-stage/<name>`。

    序号与课件同源（lessons/0002-… → lab/0002-stage/…）；`check_lesson` 的
    `check_lab_artifacts` 按 `<科目>/lab/<本课编号>-*/` 判任务文件、`lab/solutions/`
    判参考解，这里沿用既有 fixture 路径，不另造命名。
    """
    return f"lab/{_seq(index)}-stage/{name}"


def lab_solution_rel(index: int, name: str = "README.md") -> str:
    """实操/实验的参考解相对路径：`lab/solutions/<NNNN>-stage/<name>`（与任务分开放）。"""
    return f"lab/solutions/{_seq(index)}-stage/{name}"


def lab_entry_link(index: int) -> str:
    """课件内容文件里指向 lab 入口的相对链接（从 lessons/ 出发）。"""
    return f"../lab/{_seq(index)}-stage/README.md"


def required_artifacts(
    route: str, index: int, node_id: str, kind: str = "概念"
) -> tuple[str, ...]:
    """本条派工路由必须交付的目标产物（本节点、本角色自己的文件）。

    只用于「接受既有交付」的保守判定：路径由 index+node_id 唯一确定，天然排除
    其它节点/其它角色的文件；出题路由只认它自己的题库（内容文件由讲解路由负责）。

    `kind` 决定 lab 是否随本路由交付：`实操` 的整套 lab（任务/材料 + 参考解）归
    出题（practice-evaluator 是 lab 唯一 owner，见文件归属表），`实验` 的实操任务
    同样归实验材料派工。缺一份 `check_lesson` 就按 kind 阻断，故必须一并 gate。
    """
    if route == "produce_quiz":
        required = [lesson_rel(index, node_id, "quiz.json")]
        if kind == "实操":
            required.append(lab_rel(index))
            required.append(lab_solution_rel(index))
            required.append("lab/README.md")
        return tuple(required)
    if route == "produce_experiment" and kind == "实验":
        return (lesson_rel(index, node_id, "md"), lab_rel(index), lab_solution_rel(index), "lab/README.md")
    return (lesson_rel(index, node_id, "md"),)


def _read_existing_delivery(base: Path, required: tuple[str, ...]) -> list[dict[str, str]] | None:
    """保守读取 base 下 required 每一份产物（存在、可读、非空），任一不满足返回 None。

    只在「本轮 run_check 通过 + 本轮没有新交付」时用作既有交付，绝不凭文件存在放行：
    调用方还必须确认 check_passed 与 regenerate=False。
    """
    if not required:
        return None
    from .tools import SandboxError, safe_write_target

    files: list[dict[str, str]] = []
    for relative in required:
        try:
            target = safe_write_target(base, relative)
            if not target.is_file():
                return None
            content = target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError, SandboxError):
            # 读不到 / 不是 UTF-8 ⇒ 不可复用（宁可回落重做，也不把坏文件当交付）。
            return None
        if not content.strip():
            return None
        files.append({"path": relative, "content": content})
    return files


def is_draft(base: Path) -> bool:
    return base.parent.name == draft_svc.DRAFTS_DIR.name


def workspace_of_subject(base: Path) -> Path:
    """<WS>/.learning/subjects/<slug> → <WS>（工单归属用）。

    注意与 `ensure_subject_assets` 的共享层 `base.parent.parent`（= <WS>/.learning）
    区分：工件目录是三层父级，别混用。
    """
    return base.parent.parent.parent


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
    if "缺少实操引用" in message:
        return "讲解"
    if re.search(r"lab[/\\]|实操任务|参考答案", message, re.IGNORECASE):
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


def _read_base_yaml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
    except (OSError, yaml.YAMLError):
        return {}
    return data if isinstance(data, dict) else {}


def _curriculum_of(base: Path, slug: str) -> list[dict[str, Any]]:
    # 工作区科目一律按 base 直接读盘：不依赖 workspace_ctx 的全局发现，工单重试才能
    # 落在该工单真实归属的工作区（而不是当前请求绑定/默认工作区）。
    if is_draft(base):
        curriculum = draft_svc.draft_curriculum(slug)
    else:
        curriculum = _read_base_yaml(base / "curriculum.yaml")
    return [n for n in ((curriculum or {}).get("nodes") or []) if isinstance(n, dict)]


def _progress_of(base: Path, slug: str) -> dict[str, Any]:
    if is_draft(base):
        return draft_svc.draft_progress(slug)
    data = _read_base_yaml(base / "progress.yaml")
    data.setdefault("nodes", {})
    data.setdefault("misconceptions", [])
    data.setdefault("project", {"current": ""})
    return data


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


def _lab_delivery_values(base: Path, index: int) -> str:
    overview = base / "lab" / "README.md"
    previous = overview.read_text(encoding="utf-8") if overview.is_file() else "（尚未建立）"
    return "\n".join([
        "【实操材料交付（本轮必需，不得只交题库）】",
        f"载体：{_carrier(base)}；沿用该载体，不要求学生换工具。",
        f"任务入口：{lab_rel(index)}；参考解：{lab_solution_rel(index)}。",
        "必须交付 lab/README.md 整份，保留原有任务表并加入本课任务与卡壳顺序。",
        "任务入口包含教程、留白任务、自查步骤与可验证的验收条件；配套源文件、断言与依赖描述按载体实际需要交付。",
        "参考解与任务分开放；不要伪造测试执行结果或把完整答案放入学生留白任务。",
        "以下为原 lab/README.md（只增补本课，不删除已有任务）：",
        previous,
    ])


def content_values(base: Path, slug: str, node: dict[str, Any], index: int) -> str:
    """讲解派工值：节点字段逐字 + 前置摘要 + 使命/术语/资源清单 + reference/ 原文 + 图片索引。"""
    return "\n".join(
        [
            "【本课任务】把下面的节点讲成一节课，产出「课件内容文件」。",
            *_node_block(node),
            f"【课件内容文件相对路径（files[0].path 用它）】{lesson_rel(index, str(node['id']), 'md')}",
            (
                f"【实操入口】正文必须含 [开始实操]({lab_entry_link(index)})。"
                "你只负责入口及讲解；实操任务与参考解由出题角色随后交付，不因暂缺材料删除入口。"
                if node.get("kind") == "实操" else ""
            ),
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
            _lab_delivery_values(base, index) if node.get("kind") == "实操" else "",
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
            f"【实操入口】说明页必须含 [开始实操]({lab_entry_link(index)})。",
            _lab_delivery_values(base, index),
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
        files.append({"path": "lab/README.md", "content": f"# 实操任务\n\n- [本课任务]({seq}-stage/README.md)\n\n卡壳时先检查环境，再按任务自查。\n"})
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
            {"path": f"lab/solutions/{seq}-stage/README.md", "content": "# 参考解\n\n逐项核对阶段目标与验收证据。\n"},
            {"path": "lab/README.md", "content": f"# 实验任务\n\n- [本课任务]({seq}-stage/README.md)\n\n卡壳时按任务自查清单排查。\n"},
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
    required: tuple[str, ...] = (),
    regenerate: bool = False,
) -> dict[str, Any] | None:
    """K3：角色用写工具交付产物，并用 run_check 在循环内自查自修。

    返回 envelope 等价体（files 来自写工具）；没有任何交付（循环耗尽/降级）返回
    None，由调用方回落既有单次派工链（保留兜底）。

    接受既有交付（2026-10-05 修真实事故）：角色发现规范要求的产物已存在、本轮用
    run_check 复核通过、且未重写（零新文件）时，保守接受这份已核验的**本节点**
    交付（`_read_existing_delivery` 逐份校验存在且非空），不再误判「未交付」而回落。
    regenerate=True（强制重做）时禁用该接受，必须 write_deliver_file 重写新交付。
    """
    from . import agent as agent_svc
    from . import prompts
    from . import tools as tools_svc

    system_text, missing = prompts.inject_role(route, tools_enabled=True)
    if missing:
        await emit({"event": "error", "message": f"角色技能规范缺失：{'、'.join(missing)}"})
        return None
    owner = DISPATCH_OWNERS.get(route, "总控")
    role_id = f"{route}:{uuid.uuid4().hex[:8]}"
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
    user_values = values
    if regenerate:
        user_values += FORCED_REDO_NOTE
    messages = [
        {"role": "system", "content": system_text},
        {"role": "user", "content": user_values},
    ]
    audit.record("dispatch", route=route, loop="tools", values=values)
    await emit({"event": "role_start", "role_id": role_id, "role": owner, "route": route})

    async def on_progress(snapshot: dict[str, Any]) -> None:
        """进度快照 → SSE progress：编排面板显示「第 N 轮 · 已等待 Ns」。"""
        await emit({"event": "progress", "stage": owner, "role_id": role_id, **snapshot})

    async def on_event(event: dict[str, Any]) -> None:
        """角色内事件按角色回放：文本/思维链/工具活动带上 role_id 进入父任务快照。

        工具循环里 run_check 是**角色自检**（拿报错自修），与总控收尾的真渲染/检查
        区分：这里标「交付自检」，最终 render_and_check 仍是「渲染」「检查」。
        """
        etype = str(event.get("type") or "")
        name = str(event.get("name") or "")
        if etype == "tool_call":
            await emit(
                {
                    "event": "role_event",
                    "role_id": role_id,
                    "role": owner,
                    "type": "tool_call",
                    "name": name,
                    "id": str(event.get("id") or ""),
                    "arguments": str(event.get("arguments") or ""),
                }
            )
            if name == "run_check":
                await emit({"event": "stage", "stage": "交付自检", "status": "start"})
        elif etype == "tool_result":
            is_error = bool(event.get("is_error"))
            await emit(
                {
                    "event": "role_event",
                    "role_id": role_id,
                    "role": owner,
                    "type": "tool_result",
                    "name": name,
                    "id": str(event.get("id") or ""),
                    "content": str(event.get("content") or ""),
                    "is_error": is_error,
                }
            )
            if name == "run_check":
                await emit(
                    {
                        "event": "stage",
                        "stage": "交付自检",
                        "status": "fail" if is_error else "done",
                    }
                )
        elif etype in ("text", "reasoning"):
            await emit(
                {
                    "event": "role_event",
                    "role_id": role_id,
                    "role": owner,
                    "type": etype,
                    "content": str(event.get("content") or ""),
                }
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
    if not files and required and not regenerate and ctx.state.get("check_passed"):
        # 保守接受：本轮 run_check 真通过 + 目标产物（本节点/本角色）已在盘且非空。
        existing = _read_existing_delivery(base, required)
        if existing is not None:
            audit.record(
                "produce_loop_existing_accepted",
                route=route,
                node_id=node_id,
                paths=[item["path"] for item in existing],
            )
            await emit(
                {
                    "event": "role_end",
                    "role_id": role_id,
                    "role": owner,
                    "status": "done",
                    "message": "已有产物经本轮检查通过，未重写",
                }
            )
            return {
                "files": existing,
                "report": {"summary": ["已有产物经本轮检查通过，未重写"]},
            }
    if not files:
        audit.record("produce_loop_no_files", route=route, degraded=outcome.degraded)
        # 回落到单次派工：无增量可回放，只明确角色终态，不假造过程。
        await emit(
            {
                "event": "role_end",
                "role_id": role_id,
                "role": owner,
                "status": "error",
                "message": "角色工具循环未交付，回落单次派工",
            }
        )
        return None
    await emit({"event": "role_end", "role_id": role_id, "role": owner, "status": "done"})
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
    regenerate: bool = False,
    kind: str = "概念",
) -> dict[str, Any] | None:
    """返回 envelope；失败已 emit error 并返回 None。"""
    from .llm import LLMDeadlineExceeded, is_fixture_mode, supports_tools

    owner = DISPATCH_OWNERS.get(route, "总控")
    if is_fixture_mode():
        role_id = f"{route}:{uuid.uuid4().hex[:8]}"
        await emit({"event": "role_start", "role_id": role_id, "role": owner, "route": route})
        envelope = factory(values)
        await emit({"event": "role_end", "role_id": role_id, "role": owner, "status": "done"})
        return envelope
    # 工具调用默认对所有配置的模型开启（2026-10-04）：真实模型优先走角色工具循环，
    # 循环无交付（耗尽/降级）时回落下面的单次派工链兜底。
    loop_fallback = False
    if supports_tools(provider) and base is not None and node_id and stage_dir is not None:
        loop_env = await _role_tool_loop(
            provider,
            route,
            values,
            emit,
            base=base,
            node_id=str(node_id),
            index=index,
            stage_dir=stage_dir,
            required=required_artifacts(route, index, str(node_id), kind),
            regenerate=regenerate,
        )
        if loop_env is not None:
            return loop_env
        loop_fallback = True
    if regenerate:
        # 强制重做口径同样带进单次回落派工值，避免回落路径以旧文件充当交付。
        values = values + FORCED_REDO_NOTE
    from .agent import ORCH_MAX_SECONDS

    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        role_id = f"{route}:{uuid.uuid4().hex[:8]}"
        start_event: dict[str, Any] = {
            "event": "role_start",
            "role_id": role_id,
            "role": owner,
            "route": route,
            "round": attempt,
            "execution_mode": "fallback" if loop_fallback else "single_call",
        }
        if loop_fallback:
            # 工具循环零交付后的备用单次派工：给 UI 可观测的模式/原因/墙钟。
            start_event["fallback_reason"] = "角色工具循环未交付"
            start_event["max_seconds"] = ORCH_MAX_SECONDS
        await emit(start_event)
        if loop_fallback:
            await emit({"event": "stage", "stage": "备用派工", "status": "start"})
        try:
            envelope = await roles.dispatch_role(provider, route, values, fixture_kind=route)
            await emit({"event": "role_end", "role_id": role_id, "role": owner, "status": "done"})
            if loop_fallback:
                await emit({"event": "stage", "stage": "备用派工", "status": "done"})
            return envelope
        except LLMDeadlineExceeded as exc:
            # 单次派工是确定性超时：重试不会成功，直接以准确的超时终态收尾。
            await emit(
                {
                    "event": "role_end",
                    "role_id": role_id,
                    "role": owner,
                    "status": "timeout",
                    "message": f"{owner}备用派工超时：{exc}",
                }
            )
            if loop_fallback:
                await emit(
                    {"event": "stage", "stage": "备用派工", "status": "fail", "message": "备用派工超时"}
                )
            # 机器可读的失败类型：编排方按 code/type 判定终态 timeout，不做字符串匹配。
            await emit(
                {
                    "event": "error",
                    "message": f"{owner}备用派工超时：{exc}",
                    "code": "role_timeout",
                    "type": "timeout",
                }
            )
            return None
        except ValueError as exc:
            # 契约失败（模型偶发畸形 JSON）同样按"规格是权威"原值重派：
            # 偶发畸形重滚一次多半就好（实测复派即合规），耗尽再转人工。
            last_error = exc
            await emit(
                {
                    "event": "role_end",
                    "role_id": role_id,
                    "role": owner,
                    "status": "error",
                    "message": str(exc),
                }
            )
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
    if loop_fallback:
        await emit(
            {
                "event": "stage",
                "stage": "备用派工",
                "status": "fail",
                "message": "备用派工多次交付不合规",
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
    stage_dir: Path,
    base: Path,
    envelope: dict[str, Any],
    required: tuple[str, ...] = (),
) -> list[str] | None:
    """把交付逐字落盘并搬正式位；缺必需产物则**不搬任何文件**（避免杂散文件污染科目目录）。

    过去先 promote 全部文件再让调用方校验期望产物：路径写错时杂散文件已落入科目
    目录，污染 lessons/*.md 计数，把按大纲顺序产课的顺序门永久卡死。这里在写盘前
    先校验 required 齐全，不齐直接返回 None（信封解析失败同样返回 None，由调用方
    用交付摘要报错）。
    """
    try:
        files = roles.envelope_files(envelope)
    except ValueError:
        return None
    if not files:
        return None
    paths = {item["path"] for item in files}
    if any(path not in paths for path in required):
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


def _unparsed_problem(stage: str, code: int, output: str) -> list[dict[str, str]]:
    """非零退出但解析不出问题时，把原始输出折成一条可操作问题（对齐 build 门禁兜底）。

    检查器/渲染器可能以 traceback 或非 `FAIL ...`/`文件:行` 格式失败；没有这条兜底
    会生成 problems=[] 的打回与工单，学习者拿不到任何证据，复检还会被误判通过。
    """
    raw = (output or "").strip() or "（无输出）"
    return [
        {
            "path": f"（{stage}）",
            "line": "",
            "message": f"{stage}退出码 {code}，但未能解析出问题；原始输出（截断）：{raw[:800]}",
            "owner": "总控",
        }
    ]


async def render_and_check(
    base: Path, node_id: str, index: int, emit: Emit
) -> tuple[bool, list[dict[str, str]]]:
    await emit({"event": "stage", "stage": "渲染", "status": "start"})
    code, output = await _run_script([str(SCRIPTS_DIR / "render_lesson.py"), str(base), node_id])
    if code != 0:
        problems = parse_problems(output, base) or _unparsed_problem("渲染", code, output)
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
        problems = parse_problems(output, base) or _unparsed_problem("检查", code, output)
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
    *,
    regenerate: bool = False,
) -> None:
    """产课链。事件：stage / retry / handoff / done / error。

    `regenerate=True`（工具层显式强制重做）时，讲解/出题角色不得以既有产物充当本轮交付。
    """
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
    # 每次产课独立暂存目录：同节点并发（重复点按/多标签页）不再共享 .stage/<角色>，
    # 收尾也不再 rmtree 整个 .stage 而误删另一路在飞的交付。
    stage_root = base / ".stage" / f"{node_id}-{uuid.uuid4().hex[:8]}"

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
                regenerate=regenerate, kind=kind,
            )
            if env is None:
                return
            page_rel = lesson_rel(index, node_id, "md")
            moved = await _write_and_promote(
                stage_root / "practice-evaluator", base, env,
                required=required_artifacts("produce_experiment", index, node_id, kind),
            )
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
                regenerate=regenerate, kind=kind,
            )
            if env is None:
                return
            moved = await _write_and_promote(
                stage_root / "learning-coach", base, env, required=(content_rel,)
            )
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
                regenerate=regenerate, kind=kind,
            )
            if env is None:
                return
            quiz_rel = lesson_rel(index, node_id, "quiz.json")
            moved = await _write_and_promote(
                stage_root / "practice-evaluator", base, env,
                required=required_artifacts("produce_quiz", index, node_id, kind),
            )
            if moved is None or quiz_rel not in moved:
                await emit(
                    {
                        "event": "error",
                        "message": f"出题交付里没有题库文件（相对路径不符）——{_delivered_digest(env)}",
                    }
                )
                return
            await emit({"event": "stage", "stage": "出题", "status": "done", "artifacts": moved})

        def with_kind(problems: list[dict[str, str]]) -> list[dict[str, str]]:
            return [{**p, "owner": problem_owner_for_node(p, kind)} for p in problems]

        ok, problems = await render_and_check(base, node_id, index, emit)
        problems = with_kind(problems)
        round_no = 0
        rechecks = 0
        while not ok and round_no < MAX_RETRIES:
            owners = sorted({str(p.get("owner") or "总控") for p in problems})
            ensure_subject_assets(base)
            if not any(owner in ("讲解", "出题") for owner in owners):
                rechecks += 1
                await emit({"event": "stage", "stage": "总控复检", "status": "start",
                            "message": "补齐公共资源后复检，未派工修改课件"})
                ok, problems = await render_and_check(base, node_id, index, emit)
                problems = with_kind(problems)
                await emit({"event": "stage", "stage": "总控复检", "status": "done" if ok else "fail"})
                break
            round_no += 1
            await emit({"event": "retry", "round": round_no, "owners": owners, "problems": problems})

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
                    regenerate=True, kind=kind,
                )
                if env is None:
                    return
                moved = await _write_and_promote(
                    stage_root / "learning-coach", base, env,
                    required=required_artifacts("produce_content", index, node_id),
                )
                if moved is None:
                    await emit(
                        {
                            "event": "error",
                            "message": f"讲解重派交付里没有课件内容文件——{_delivered_digest(env)}",
                        }
                    )
                    return

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
                    regenerate=True, kind=kind,
                )
                if env is None:
                    return
                moved = await _write_and_promote(
                    stage_root / "practice-evaluator", base, env,
                    required=required_artifacts(route, index, node_id, kind),
                )
                if moved is None:
                    await emit(
                        {
                            "event": "error",
                            "message": f"{DISPATCH_OWNERS.get(route, '出题')}重派交付里没有目标产物——{_delivered_digest(env)}",
                        }
                    )
                    return

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
                workspace=None if is_draft(base) else str(workspace_of_subject(base).resolve()),
            )
            await emit({"event": "handoff", "ticket": ticket})
            await emit(
                {
                    "event": "error",
                    "message": f"质检未通过（修复派工 {round_no} 轮，总控复检 {rechecks} 次），已转人工（工单 {ticket['id']}）。",
                    "code": "quality_check_failed", "problems": problems,
                    "repair_rounds": round_no, "rechecks": rechecks, "ticket_id": ticket["id"],
                }
            )
            return

        artifacts = [lesson_rel(index, node_id, "md"), lesson_rel(index, node_id, "html")]
        if kind != "实验":
            artifacts.insert(1, lesson_rel(index, node_id, "quiz.json"))
        await emit({"event": "done", "node_id": node_id, "artifacts": artifacts})
    finally:
        roles.clear_stage(stage_root)
        try:
            stage_root.parent.rmdir()  # 只在本路暂存用完后清理空的 .stage 父目录
        except OSError:
            pass


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
        ok = not problems
    else:
        node_id = str(ticket.get("node_id") or "")
        nodes = _curriculum_of(base, str(ticket["slug"]))
        node = next((n for n in nodes if n.get("id") == node_id), None)
        if node is None:
            await emit({"event": "error", "message": f"节点不存在：{node_id}"})
            return
        ensure_subject_assets(base)
        # 判定只看 ok：非零退出但解析不出问题时 render_and_check 已回填兜底问题；
        # 不能再用 `if problems:` 判定，否则 problems 为空会被误判「复检通过」关单。
        ok, problems = await render_and_check(base, node_id, nodes.index(node) + 1, emit)
    if not ok:
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
    # 每次重试独立暂存目录：并发/连续重试不共享 .stage/<角色>，收尾也不误删别的在飞交付。
    stage_root = base / ".stage" / ticket_id
    hint_block = f"\n\n【学习者补充说明】{hint}" if hint else ""

    async def _park(message: str | None = None) -> None:
        """放弃本次重试：状态回置「待处理」（不再是卡死的「重试中」）。"""
        tickets_svc.update_ticket(ticket_id, status="待处理")
        if message:
            await emit({"event": "error", "message": message})

    try:
        if ticket.get("kind") == "build":
            from .build import curriculum_values, interview_of, run_curriculum_gate as build_gate

            if draft_svc.get_draft(slug) is None:
                # 草稿已被落点/删除：绝不 save_draft_curriculum 复活幽灵草稿（否则
                # 报告「重试通过」而真实工作区科目纹丝不动）。留待处理供用户复检/放弃。
                await _park(f"草稿已不存在（可能已落点确认）：{slug}。请改用「重新检查」或放弃本次。")
                return
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
                    await _park(str(exc))
                    return
            data = envelope.get("data") if isinstance(envelope, dict) else None
            if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
                await _park("大纲派工没有交回课程 JSON（data 键）")
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
                await _park(f"节点不存在：{node_id}")
                return
            index = nodes.index(node) + 1
            kind = str(node.get("kind") or "概念")
            retry_problems = [
                {**p, "owner": problem_owner_for_node({**p, "owner": _owner_of_problem(p)}, kind)}
                for p in ticket.get("problems") or []
            ]
            ticket = {**ticket, "problems": retry_problems}
            owners = {str(p.get("owner") or "总控") for p in retry_problems}
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
                    regenerate=True, kind=kind,
                )
                if env is None:
                    await _park()  # dispatch 已 emit error，这里只把状态从「重试中」拉回
                    return
                moved = await _write_and_promote(
                    stage_root / "learning-coach", base, env,
                    required=required_artifacts("produce_content", index, node_id),
                )
                if moved is None:
                    # 重派没有合法目标交付：不 promote 杂散文件，工单停留「待处理」，绝不假解决。
                    await _park(f"讲解重派交付里没有课件内容文件——{_delivered_digest(env)}")
                    return

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
                regenerate=True, kind=kind,
            )
            if env is None:
                await _park()
                return
            moved = await _write_and_promote(
                stage_root / "practice-evaluator", base, env,
                required=required_artifacts(route, index, node_id, kind),
            )
            if moved is None:
                # 同上：缺目标产物的重派不算重试成功，工单停留「待处理」。
                await _park(
                    f"{DISPATCH_OWNERS.get(route, '出题')}重派交付里没有目标产物——{_delivered_digest(env)}"
                )
                return

            ok, problems = await render_and_check(base, node_id, index, emit)
            if not ok:
                tickets_svc.update_ticket(ticket_id, status="待处理", problems=problems)
                await emit({"event": "error", "message": f"重试后质检仍未通过（{len(problems)} 处），已回填工单。"})
                return

        tickets_svc.update_ticket(ticket_id, status="已解决", problems=[])
        await emit({"event": "done", "stage": "retry", "message": "重试通过，工单已关闭。"})
    except Exception:
        # 任何未预期异常都不能把工单永久留在「重试中」；放回待处理再向上抛给 SSE 层
        tickets_svc.update_ticket(ticket_id, status="待处理")
        raise
    finally:
        roles.clear_stage(stage_root)
        try:
            stage_root.parent.rmdir()
        except OSError:
            pass
