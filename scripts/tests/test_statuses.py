#!/usr/bin/env python3
"""状态、课型与题型词表模块（scripts/statuses.py）的单元测试。

为什么单独有这一道：节点状态原先在仓库里有七份副本（两份 schema、Python 常量、
预览假数据、模板注释、宿主提示词、规格散文），Antigravity 那份已经漂成 4/6，而
**没有任何测试把两边钉在一起**。口径收进一个模块、并从 schema 读之后，这里钉三件事：

1. 词表确实来自 schema，且**数组顺序**（「完成」的切点、主页卡片排序）是载荷；
2. schema 里每个状态、每个科目状态、每个课型、每个题型都有配色/名字——以后往 schema 加值、
   忘了配色，这里就红；
3. 读不到 schema 时**降级但不静默**（词表空 + 一条可展示的告警；退路只走一层）。

三档词表（#71）另有一条反向断言：旧六档的四个词**不在**词表里——读侧映射归读侧
（`lib/core/rules.ts` 的 `LEGACY_TIER_MAP`），写侧只认三档。

用法：python3 scripts/tests/test_statuses.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
REPO = TESTS_DIR.parents[1]
sys.path.insert(0, str(REPO / 'scripts'))

import statuses  # noqa: E402

failures = 0
total = 0


def check(label, ok, detail=''):
    global failures, total
    total += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f'  — {detail}' if detail and not ok else ''))
    failures += not ok


def schema_enum(relative, *keys):
    node = json.loads((REPO / relative).read_text(encoding='utf-8'))
    for key in keys:
        node = node[key]
    return tuple(node['enum'])


def test_read_from_schema():
    progress = schema_enum('schemas/progress.schema.json', 'properties', 'nodes',
                           'additionalProperties', 'properties', 'status')
    curriculum = schema_enum('schemas/curriculum.schema.json', 'properties', 'nodes', 'items',
                             'properties', 'status')
    check('节点状态确实读自 schema', statuses.NODE_STATUSES == progress, f'{statuses.NODE_STATUSES}')
    check('两份 schema 的节点状态逐个相等（progress 与 curriculum）', progress == curriculum,
          f'{progress} vs {curriculum}')
    check('科目状态读自 schema',
          statuses.SUBJECT_STATUSES == schema_enum('schemas/subject.schema.json', 'properties', 'status'))
    check('课型读自 schema',
          statuses.KINDS == schema_enum('schemas/curriculum.schema.json', 'properties', 'nodes',
                                        'items', 'properties', 'kind'))
    check('题型读自 schema（question.schema.json 的 kind.enum）',
          statuses.QUESTION_KINDS == schema_enum('schemas/question.schema.json', 'properties', 'kind'),
          f'{statuses.QUESTION_KINDS}')
    check('读 schema 没有留下问题', statuses.problems() == [], f'{statuses.problems()}')


def test_order_is_load_bearing():
    check('「完成」从「已学完」起算（含它自己）',
          statuses.DONE_FROM in statuses.NODE_STATUSES
          and set(statuses.DONE_STATUSES) == set(statuses.NODE_STATUSES[statuses.NODE_STATUSES.index(statuses.DONE_FROM):]),
          f'{sorted(statuses.DONE_STATUSES)}')
    check('「已学完」算完成、「学习中」不算',
          '已学完' in statuses.DONE_STATUSES and '学习中' not in statuses.DONE_STATUSES)
    check('旧六档的四个词已不在词表里（读侧映射，写侧不认）',
          not ({'初步理解', '能独立应用', '需要复习', '已通过项目验证'} & set(statuses.NODE_STATUSES)),
          f'{statuses.NODE_STATUSES}')
    check('科目状态排序 = schema 的 enum 顺序',
          statuses.SUBJECT_STATUS_ORDER == {status: index for index, status in enumerate(statuses.SUBJECT_STATUSES)},
          f'{statuses.SUBJECT_STATUS_ORDER}')
    check('当前状态与未开始文案有定义',
          statuses.CURRENT_STATUS in statuses.NODE_STATUSES and statuses.NOT_STARTED_TEXT)


def test_maps_complete():
    check('schema 里每个节点状态都有配色', statuses.missing_class() == [], f'{statuses.missing_class()}')
    check('配色表没有多出来的键',
          set(statuses.NODE_STATUS_CLASS) == set(statuses.NODE_STATUSES),
          f'缺 {sorted(set(statuses.NODE_STATUSES) - set(statuses.NODE_STATUS_CLASS))}'
          f' / 多 {sorted(set(statuses.NODE_STATUS_CLASS) - set(statuses.NODE_STATUSES))}')
    check('schema 里每个科目状态都有徽标配色',
          statuses.missing_subject_tag() == [], f'{statuses.missing_subject_tag()}')
    check('科目徽标表没有多出来的键',
          set(statuses.SUBJECT_STATUS_TAG) == set(statuses.SUBJECT_STATUSES))
    check('兜底样式不是空串', bool(statuses.FALLBACK_CLASS))
    check('课型三个名字都在 schema 的词表里',
          {statuses.KIND_CONCEPT, statuses.KIND_HANDS_ON, statuses.KIND_LAB} <= set(statuses.KINDS),
          f'{statuses.KINDS}')


def test_degrade_without_schema():
    """读不到 schema：词表按空、给一句可展示的告警；只退一层（curriculum 兜 progress）。"""
    empty = tempfile.mkdtemp(prefix='studymate-statuses-')
    saved_dir = statuses.SCHEMA_DIR
    saved_problems = list(statuses._problems)
    try:
        statuses.SCHEMA_DIR = empty
        statuses._problems.clear()
        check('缺 schema：节点状态为空', statuses._node_statuses() == ())
        check('缺 schema：给出可展示的告警',
              any('progress.schema.json' in line for line in statuses._problems),
              f'{statuses._problems}')

        # 只放 curriculum.schema.json：应当走退路拿到词表，但仍记一条「progress 读不出」
        statuses._problems.clear()
        curriculum = json.loads((REPO / 'schemas/curriculum.schema.json').read_text(encoding='utf-8'))
        (Path(empty, 'curriculum.schema.json')).write_text(json.dumps(curriculum), encoding='utf-8')
        fallback = statuses._node_statuses()
        check('退路：progress 读不出时用 curriculum 的词表',
              fallback == schema_enum('schemas/curriculum.schema.json', 'properties', 'nodes',
                                      'items', 'properties', 'status'), f'{fallback}')
        check('退路：仍然说一声（不静默）',
              any('progress.schema.json' in line for line in statuses._problems), f'{statuses._problems}')
    finally:
        statuses.SCHEMA_DIR = saved_dir
        statuses._problems[:] = saved_problems


def main():
    for name, func in sorted(globals().items()):
        if name.startswith('test_') and callable(func):
            func()
    print(f'\n{total - failures}/{total} 通过')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
