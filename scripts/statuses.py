#!/usr/bin/env python3
"""状态、课型与题型词表的唯一口径：从 `schemas/*.schema.json` 读，别在这里抄第二份。

这些取值本来就在 schema 里——那是数据的合同。原先 Python 侧还各留一份常量
（`gen_home.py` 里三组、`preview_templates.py` 里两组），宿主导出层再手写一段，
于是：改一次词表要动七处，而 Antigravity 那份已经漂成 4/6（少了「初步理解」与
「已通过项目验证」），也没有任何测试把两边钉在一起。

这里做三件事：

1. **从 schema 读**词表。节点状态读 `progress.schema.json`（读不到就退到
   `curriculum.schema.json`——两份本来就该相等，由测试守着），科目状态读
   `subject.schema.json`，课型读 `curriculum.schema.json`，题型读
   `question.schema.json`。**数组顺序是载荷**：
   「完成」= 在 `已学完` 处切一刀取后半段，根主页卡片顺序按科目状态的 enum 顺序。
2. **状态 → 卡片 class 的映射只有这里一份**（`NODE_STATUS_CLASS`、`SUBJECT_STATUS_TAG`）。
   测试断言「enum 里每个状态都有配色」——以后往 schema 加状态、忘了配色，就会红。
3. **读不到 schema 时明确说明**（`problems()` 给一句可直接展示的话）：词表按空处理，
   调用方降级渲染（状态文本照写原值、样式退成 `FALLBACK_CLASS`、「完成」按 0），
   但不静默。

用法：

    import statuses
    for line in statuses.problems():
        warn(line)
    css = statuses.NODE_STATUS_CLASS.get(status, statuses.FALLBACK_CLASS)
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA_DIR = os.path.join(ROOT, 'schemas')

# 「完成」从哪个状态起算（含它自己与它之上的状态，按 enum 顺序）。
# 三档词表里「已学完」就是完成；旧六档（能独立应用 / 需要复习 / 已通过项目验证）
# 读进来时先在读侧映射成这三档（见 lib/core/rules.ts 的映射表），到这里只剩一种。
DONE_FROM = '已学完'
# 当前节点取哪个状态
CURRENT_STATUS = '学习中'
NOT_STARTED_TEXT = '还没开始'
# 词表读不出来时，卡片用哪个样式兜底（状态文本仍写原值）
FALLBACK_CLASS = 'todo'

# ══════════════════════════════════════════════════════════════════
# 状态 → 卡片 class（**全仓库唯一一份映射**；键必须与 schema 的 enum 逐个相等）
# ══════════════════════════════════════════════════════════════════
NODE_STATUS_CLASS = {
    '未开始': 'todo',
    '学习中': 'learning',
    '已学完': 'done',
}
# 科目状态 → (徽标 class 后缀, 色点后缀)；徽标文本写 status 原值
SUBJECT_STATUS_TAG = {
    '进行中': ('active', 'blue'),
    '暂停': ('paused', 'yellow'),
    '已完成': ('done', 'green'),
}

# 课型：词表由 schema 的 enum 决定；这三个名字给代码里比较用，别硬编码字符串
KIND_CONCEPT = '概念'
KIND_HANDS_ON = '实操'
KIND_LAB = '实验'

_problems = []


def _try_enum(schema_name, path):
    """按 JSON 路径取一个字符串枚举 → `(值, 问题)`；两者只会有其一。"""
    full = os.path.join(SCHEMA_DIR, schema_name)
    where = ' / '.join(str(key) for key in path)
    try:
        with open(full, encoding='utf-8') as handle:
            node = json.load(handle)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return (), f'读不出 {schema_name} 的 {where}（{exc}）——词表按空处理'
    for key in path:
        if not isinstance(node, dict) or key not in node:
            return (), f'{schema_name} 里找不到 {where}——词表按空处理'
        node = node[key]
    values = node.get('enum') if isinstance(node, dict) else None
    if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
        return (), f'{schema_name} 的 {where} 不是字符串枚举——词表按空处理'
    return tuple(values), None


def _node_statuses():
    """节点状态：先看 progress（运行时数据的合同），退到 curriculum（大纲里的初始值）。"""
    values, problem = _try_enum('progress.schema.json', ['properties', 'nodes', 'additionalProperties',
                                                         'properties', 'status'])
    if values:
        return values
    fallback, fallback_problem = _try_enum('curriculum.schema.json', ['properties', 'nodes', 'items',
                                                                     'properties', 'status'])
    if fallback:
        # 退路够用，但少一份 schema 仍是真的：说一声，别当成没发生过。
        _problems.append(problem)
        return fallback
    _problems.append(problem or fallback_problem)
    return ()


NODE_STATUSES = _node_statuses()
SUBJECT_STATUSES, _subject_problem = _try_enum('subject.schema.json', ['properties', 'status'])
KINDS, _kind_problem = _try_enum('curriculum.schema.json', ['properties', 'nodes', 'items',
                                                           'properties', 'kind'])
# 题型：词表在 question.schema.json（`lib/core/rules.ts` 的 QUESTION_KINDS 是它的 JS 侧副本，
# 由 test_statuses.py 钉住两边逐字相等）。检查器按它判「未知题型」。
QUESTION_KINDS, _question_problem = _try_enum('question.schema.json', ['properties', 'kind'])
for _problem in (_subject_problem, _kind_problem, _question_problem):
    if _problem:
        _problems.append(_problem)

# 科目状态在根主页上的排序：正在学的排前面（enum 顺序即优先级，同状态按科目名）
SUBJECT_STATUS_ORDER = {status: index for index, status in enumerate(SUBJECT_STATUSES)}

# 「完成」= 状态达 DONE_FROM 及以上（按 enum 顺序取后半段）；词表空时保守算 0 个完成
DONE_STATUSES = frozenset(
    NODE_STATUSES[NODE_STATUSES.index(DONE_FROM):]) if DONE_FROM in NODE_STATUSES else frozenset()


def problems():
    """读 schema 时遇到的问题（可直接展示）；空列表 = 词表齐备。"""
    return list(_problems)


def missing_class():
    """schema 里有、但没配色（`NODE_STATUS_CLASS` 里没有）的状态——测试与告警都用它。"""
    return [status for status in NODE_STATUSES if status not in NODE_STATUS_CLASS]


def missing_subject_tag():
    """schema 里有、但没徽标配色的科目状态。"""
    return [status for status in SUBJECT_STATUSES if status not in SUBJECT_STATUS_TAG]
