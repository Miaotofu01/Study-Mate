#!/usr/bin/env python3
"""一条命令重建 `examples/`：根主页 + 科目主页 + 每一课（有内容文件的那些）。

为什么有它：`examples/` 是仓库里唯一「生成后入库」的产物，也是头号热点（最近 120 次提交
里 308 次触碰）。原先重建靠 CONTRIBUTING 里的一段散文——`gen_home.py` 跑一次，再对每一课
各跑一次 `render_lesson.py`——**漏跑一课时的表现只是「页面还是旧的」，没有任何东西会报错**。
把那段循环收进脚本，重建就成了一个命令，漏没漏一眼能看出来。

用法：

    python3 scripts/build_examples.py [工作区，默认 examples]

退出码：全部成功 0；有课件渲染失败 1。
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import curriculum   # noqa: E402
import gen_home     # noqa: E402
import lessonfile   # noqa: E402
import render_lesson  # noqa: E402


def main(argv):
    if any(arg in ('-h', '--help') for arg in argv):
        print(__doc__)
        return 0
    args = [arg for arg in argv if not arg.startswith('-')]
    if len(args) > 1:
        raise SystemExit('用法：python3 scripts/build_examples.py [工作区，默认 examples]')
    ws = os.path.abspath(os.path.expanduser(args[0])) if args else os.path.join(ROOT, 'examples')
    if not os.path.isdir(ws):
        raise SystemExit(f'工作区不存在：{ws}')

    code = gen_home.main([ws])                      # 根主页 + 科目主页（链接自检也在里面）
    if code:
        return code

    subjects_dir = os.path.join(ws, '.learning', 'subjects')
    rendered, skipped, failed = 0, [], []
    for slug in sorted(os.listdir(subjects_dir)) if os.path.isdir(subjects_dir) else []:
        subject_dir = os.path.join(subjects_dir, slug)
        if not os.path.isdir(subject_dir):
            continue
        asset_problems = lessonfile.install_subject(subject_dir)
        if asset_problems:
            print('\n'.join(asset_problems), file=sys.stderr)
            return 1
        outline, _ = curriculum.load(subject_dir, strict=False)
        if outline is None:
            print(f'{slug}: 没有可读的 curriculum.yaml，跳过它的课件', file=sys.stderr)
            continue
        for node in outline.nodes:
            content = os.path.join(subject_dir, 'lessons',
                                   lessonfile.lesson_name(node['index'], node['id'], 'md'))
            if not os.path.isfile(content):
                skipped.append(f'{slug}/{node["id"]}')
                continue
            if render_lesson.main([subject_dir, node['id']]) == 0:
                rendered += 1
            else:
                failed.append(f'{slug}/{node["id"]}')

    note = f'（{len(skipped)} 个节点还没有内容文件，跳过）' if skipped else ''
    if failed:
        print(f'课件渲染失败 {len(failed)} 课：{"、".join(failed)}', file=sys.stderr)
        return 1
    print(f'examples 已重建：课件 {rendered} 课{note}。改完看 git status，只该有预期的改动。')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
