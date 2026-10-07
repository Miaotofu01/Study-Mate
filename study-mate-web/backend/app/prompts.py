"""提示词分层：各链路按需注入 .dsh/skills/<名>/SKILL.md 全文。

skill 目录定位在 engine root（仓库根 .dsh/skills）；链路 → 技能映射按
《开发与计划》§5.1 B 行（chat 链路收口 2026-10-03 拍板⑧：关联科目的会话
退回 local-qa，建课会话注入 learning-system + learning-discovery）。
注入是机械读盘（缓存），缺失时由调用方 503，不做裁剪、不实现第二份规则。
"""
from __future__ import annotations

import logging
from pathlib import Path

from .config import REPO_ROOT

logger = logging.getLogger(__name__)

SKILLS_DIR = REPO_ROOT / ".dsh" / "skills"

WEB_RUNTIME_ADAPTION = (
    "【运行环境适配】以下技能规范来自 StudyMate 宿主版本，本会话运行在 StudyMate Web 运行时："
    "文件读写、渲染器/检查器/主页生成等脚本、科目与进度落盘由后端完成；"
    "规范中涉及终端沙箱、权限提权、子代理派工与 ask_user 提问工具的条目不适用——"
    "需要学习者决策时直接在回复里提问，行为口径与产物契约照规范执行。"
)

# 建课会话（盘问 + 方向探索入口）在技能全文之上的补充口径：只有 Web 运行时独有的
# 收口标记格式（盘问/探索行为口径全在 learning-system / learning-discovery 全文里，
# 不在这里复述规则——不实现第二份规则）。
INTERVIEW_ADAPTION = (
    "【建课会话适配】盘问与方向探索都按上方规范执行。"
    "盘问结束标准达成后，在回复末尾原样输出一行收口标记"
    " `<!--INTERVIEW_RESULT-->{JSON}<!--/INTERVIEW_RESULT-->`，"
    "JSON 对象含 name（科目名）、purpose（学习目的）、level（程度目标）、background（前置基础）、"
    "project（配套项目，可空）、carrier（实验载体，可空）六个键；"
    "输出标记前先用一句话向学习者复述将要建课的结论，标记之后不要再输出任何其他内容。"
)

# 建课收口阶段（用户明确确认建课后的那一轮）的补充口径：本轮不跑工具、只做纯最终输出。
INTERVIEW_FINALIZE_PROMPT = (
    "【建课收口阶段】学习者已确认建课，本轮不再调用任何工具，只输出最终收口结论。"
    "只整理对话里**已经确认**的信息（科目名、目的、程度目标、前置基础、配套项目、实验载体）；"
    "任何关键值缺失或仍含糊时，不要凭空创建或替学习者假设："
    "在回复里明确追问缺失的那一项，并在信息补齐前不要输出收口标记。"
    "信息齐全时，在回复末尾原样输出收口标记"
    " `<!--INTERVIEW_RESULT-->{JSON}<!--/INTERVIEW_RESULT-->`（六个键），"
    "标记之前先用一句话复述结论，标记之后不要再输出任何其他内容。"
)

# 生产角色派工（无工具单次调用）的运行环境适配：与 chat 的适配声明分开，各说各的边界。
ROLE_DISPATCH_ADAPTION = (
    "【运行环境适配】本调用是 StudyMate Web 运行时的一次角色派工：你是被派出的角色子代理，"
    "全新上下文、没有文件工具、没有用户通道、不再派下级。"
    "规范中「先加载某技能」的条目：该技能规范已随本提示一并提供，直接照它执行。"
    "输入值已由总控内联在最后的用户消息里——规范中「读文件」「按路径读」的条目一律按内联内容理解；"
    "内联值里没有的信息写进报告交回总控，不要凭记忆补、不要虚构来源。"
    "你的回复由总控逐字落盘，改为 JSON envelope 交付：输出一个 JSON 对象，"
    "`files` 数组每项 {\"path\": \"<规范交付格式里的最终相对路径>\", \"content\": \"<文件全文>\"}"
    "（内容逐字，除 JSON 转义外不做任何改动）；角色规范要求交回结构化数据（如课程大纲 JSON）的放 `data` 键；"
    "规范要求正文报告的判断性内容（摘要、锚点题型清单、Gaps、建议）放 `report` 对象。"
    "除该 JSON 外不要输出任何其他文字。"
)

# 工具循环版角色派工适配（tools_enabled=True）：角色在 run_agent 工具循环里跑，有真实文件工具。
# 交付改为「write_deliver_file 逐份落盘 + run_check 自检」，不再要求 JSON envelope（否则会低效回退）。
ROLE_TOOL_LOOP_ADAPTION = (
    "【运行环境适配】本调用是 StudyMate Web 运行时的一次角色派工，运行在**工具循环**里："
    "你有文件工具，规范中「读文件」「按路径读」照常按工具执行——"
    "用 read_course_file / list_workspace 读取工作区资料，"
    "用 write_deliver_file 逐份把产物写入规范要求的最终相对路径，"
    "再用 run_check 把交付落到科目目录并自检；自检报错就按报错修正后重写，直到通过。"
    "产物必须经 write_deliver_file 落盘并经 run_check 自检，"
    "不要输出 JSON envelope、不要在正文里内联文件全文；"
    "规范要求交回的结构化数据（如课程大纲 JSON）用 write_deliver_file 落成对应文件。"
    "**交付判定（重要）**：若规范要求的产物已存在于工作区、且你本轮用 run_check 复核通过，"
    "可以不重写，直接结束并在汇报里说明（总控会接受这份已核验的交付）；"
    "收到【本轮为强制重做】时，必须用 write_deliver_file 重新交付完整产物，不得沿用旧文件。"
    "规范里说明「此时属预期」的自检报错（如内容角色的题库/锚点类报错，题还没出）按规范处理，"
    "不要为了过自检删改交付、也不要补 empty_reason。"
    "完成后只输出一段简短交付汇报（写了哪些文件、自检结果），不要再输出大段正文。"
    "输入值已由总控内联在最后的用户消息里；内联值里没有的信息写进汇报交回总控，不要凭记忆补、不要虚构来源。"
)

# 建课（generate）工具循环版：注册工具不同（submit_curriculum 等），不能套产课的写交付文案。
ROLE_BUILD_TOOL_LOOP_ADAPTION = (
    "【运行环境适配】本调用是 StudyMate Web 运行时的一次角色派工，运行在**工具循环**里："
    "你有文件工具，规范中「读文件」「按路径读」照常按工具执行——"
    "用 read_course_file / list_workspace 读取工作区资料，"
    "用 submit_curriculum 提交课程大纲（nodes/edges）；后端会立即跑门禁并把报错原文返回，"
    "按报错逐条修正后重新提交，直到通过。"
    "大纲必须经 submit_curriculum 提交，不要输出 JSON envelope、不要把大纲内联在正文里。"
    "通过后只输出一段简短交付汇报（大纲设计要点、门禁结果），不要再输出大段正文。"
    "输入值已由总控内联在最后的用户消息里；内联值里没有的信息写进汇报交回总控，不要凭记忆补、不要虚构来源。"
)

# route → 工具循环适配：按各链路实际注册的工具写明可用工具与交付方式。
ROLE_TOOL_LOOP_ADAPTIONS: dict[str, str] = {
    "generate": ROLE_BUILD_TOOL_LOOP_ADAPTION,
}

SKILL_ROUTES: dict[str, list[str]] = {
    "chat": ["local-qa"],
    "interview": ["learning-system", "learning-discovery"],
    "assess": ["practice-evaluator", "evidence-check", "record-keeping"],
    "summary": ["record-keeping"],
    "grade": ["practice-evaluator", "evidence-check"],
    "generate": ["curriculum-designer"],
    "produce_content": ["learning-coach", "lesson-design", "layered-practice"],
    "produce_quiz": ["practice-evaluator", "layered-practice", "evidence-check"],
    "produce_experiment": ["practice-evaluator", "layered-practice", "evidence-check"],
}

_cache: dict[str, str | None] = {}


def skill_text(name: str) -> str | None:
    """读技能全文（成功才缓存；缺文件不落负缓存，修复后无需重启）。"""
    if name not in _cache:
        path = SKILLS_DIR / name / "SKILL.md"
        try:
            _cache[name] = path.read_text(encoding="utf-8")
        except OSError:
            logger.warning("技能规范缺失：%s", path)
            return None
    return _cache[name]


def inject(route: str) -> tuple[str, list[str]]:
    """按链路拼装规范全文。返回 (文本, 缺失清单)；文本为空串表示无可注入。"""
    parts: list[str] = []
    missing: list[str] = []
    for name in SKILL_ROUTES.get(route, []):
        text = skill_text(name)
        if text is None:
            missing.append(name)
            continue
        parts.append(f'<skill name="{name}">\n{text}\n</skill>')
    if not parts:
        return "", missing
    return WEB_RUNTIME_ADAPTION + "\n\n" + "\n\n".join(parts), missing


def inject_interview() -> tuple[str, list[str]]:
    """建课会话注入：技能全文 + 建课适配（含收口标记口径）。"""
    text, missing = inject("interview")
    if missing:
        return "", missing
    return text + "\n\n" + INTERVIEW_ADAPTION, []


def inject_role(route: str, tools_enabled: bool = False) -> tuple[str, list[str]]:
    """生产角色派工：角色规范全文 + 派工适配声明。

    tools_enabled=False（默认，无工具单次 dispatch_role）：交付走 JSON envelope 适配；
    tools_enabled=True（run_agent 工具循环里的角色）：交付走 write_deliver_file + run_check，
    不要求 JSON envelope。技能全文两种形态都不裁剪。
    """
    parts: list[str] = []
    missing: list[str] = []
    for name in SKILL_ROUTES.get(route, []):
        text = skill_text(name)
        if text is None:
            missing.append(name)
            continue
        parts.append(f'<skill name="{name}">\n{text}\n</skill>')
    if missing:
        return "", missing
    if tools_enabled:
        adaption = ROLE_TOOL_LOOP_ADAPTIONS.get(route, ROLE_TOOL_LOOP_ADAPTION)
    else:
        adaption = ROLE_DISPATCH_ADAPTION
    return adaption + "\n\n" + "\n\n".join(parts), missing
