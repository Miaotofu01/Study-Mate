#!/usr/bin/env python3
r"""技能调用面回归：12 份 SKILL.md 的两个调用面都要与「谁是角色」对得上。

为什么单独有这道：判定逻辑一直写在 `scripts/check_skill.py` 里，而它**不在任何门禁里跑**
——`grep check_skill` 只命中它自己的说明文字。工程约束写着「5 个角色两个面都关」，
实际只有一个面被别处间接钉住（宿主导出会去掉 `disable-model-invocation`），
`user-invocable: false` 零正向断言：谁把某个角色改回可调用，门禁不会红。

真发生过一次：`learning-coach` 的 `read_url_content` 工具说明漏了整整一轮才被发现
（同一类问题：规格里写着、没人守）。调用面比工具表更靠前——它决定这个角色会不会被
学生直接选中，或者被模型当普通技能加载。

判据两条，都交给 `check_skill.py` 判，这里只声明「谁是角色」：
1. 5 个角色两个面都关（`--expect-role`）；
2. 其余 7 份（总控 + 6 个协议）两个面都开（`--expect-model-invocable`）。

角色名单写死在这里是故意的：新增一份 skill 必须显式分类，不能被自动划进「协议」那一侧。

用法：python3 scripts/tests/test_skill_frontmatter.py
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILLS = ROOT / '.dsh' / 'skills'
CHECK = ROOT / 'scripts' / 'check_skill.py'

ROLES = ['curriculum-designer', 'image-scout', 'learning-coach',
         'practice-evaluator', 'resource-scout']

bad = 0
total = 0


def contract(label, condition, detail=''):
    global bad, total
    total += 1
    bad += not condition
    print(f"{'PASS' if condition else 'FAIL'}  {label}{'' if condition else '  ' + detail}")


found = sorted(p.parent.name for p in SKILLS.glob('*/SKILL.md'))
contract(f'技能目录 {len(found)} 份', len(found) == 12, f'实际 {found}')
contract('角色名单里的每一份都在磁盘上', all(name in found for name in ROLES),
         f'缺 {[name for name in ROLES if name not in found]}')

groups = [
    ('5 个角色两个面都关', [name for name in found if name in ROLES], '--expect-role'),
    ('总控与 6 个协议两个面都开', [name for name in found if name not in ROLES], '--expect-model-invocable'),
]
for label, names, flag in groups:
    result = subprocess.run(
        [sys.executable, str(CHECK), *[str(SKILLS / name) for name in names], flag],
        capture_output=True, text=True)
    detail = (result.stdout + result.stderr).strip().splitlines()
    contract(f'{label}（{len(names)} 份）', result.returncode == 0,
             '；'.join(line for line in detail if line.startswith('FAIL')))

print(f'\n合计 {total - bad}/{total} 条契约在位')
sys.exit(1 if bad else 0)
