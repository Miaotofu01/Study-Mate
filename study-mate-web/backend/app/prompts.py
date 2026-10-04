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


def inject_role(route: str) -> tuple[str, list[str]]:
    """生产角色派工：角色规范全文 + 派工适配声明（envelope 交付）。"""
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
    return ROLE_DISPATCH_ADAPTION + "\n\n" + "\n\n".join(parts), missing
