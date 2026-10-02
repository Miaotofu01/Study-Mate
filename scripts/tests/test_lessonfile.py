#!/usr/bin/env python3
"""课件文件与页面路径模块（scripts/lessonfile.py）的单元测试。

同一套约定原先在五个脚本里各写半截：渲染器自己拼文件名、校验器两条正则
（严格一条、宽松一条）、重排脚本自带后缀表与解析器、主页生成器又抄一条宽松正则
并从文件名反推节点 id；课件页引用共享层的相对路径在渲染器里写死三层。这里把
「文件名怎么拼、怎么认、页面该用哪个前缀」钉死。

用法：python3 scripts/tests/test_lessonfile.py
"""
import sys
import subprocess
import tempfile
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
REPO = TESTS_DIR.parents[1]
sys.path.insert(0, str(REPO / 'scripts'))

import lessonfile  # noqa: E402

failures = 0
total = 0


def check(label, ok, detail=''):
    global failures, total
    total += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f'  — {detail}' if detail and not ok else ''))
    failures += not ok


def test_lesson_name():
    check('拼名字：序号补零到 4 位', lessonfile.lesson_name(3, 'numpy.arrays', 'md') == '0003-numpy.arrays.md')
    check('拼名字：双扩展名', lessonfile.lesson_name(18, 'cpp.array', 'quiz.json') == '0018-cpp.array.quiz.json')
    check('拼名字：超过 4 位不截断', lessonfile.lesson_name(12345, 'x', 'html') == '12345-x.html')
    check('拼名字：数字字符串也认', lessonfile.lesson_name('7', 'x', 'md') == '0007-x.md')


def test_split_name():
    check('拆名字：md', lessonfile.split_name('0001-http-basics.md') == ('0001', 'http-basics', 'md'))
    check('拆名字：双扩展名不被 .json 抢走',
          lessonfile.split_name('0008-cpp.array.quiz.json') == ('0008', 'cpp.array', 'quiz.json'))
    check('拆名字：html', lessonfile.split_name('0003-numpy.arrays.html') == ('0003', 'numpy.arrays', 'html'))
    check('拆名字：没有序号前缀回 None', lessonfile.split_name('notes.md') is None)
    check('拆名字：后缀不认识回 None', lessonfile.split_name('0001-a.json') is None)
    check('拆名字：只有一个后缀没有头回 None', lessonfile.split_name('.md') is None)
    check('拆名字：往返一致',
          lessonfile.split_name(lessonfile.lesson_name(42, 'a.b-c', 'quiz.json'))
          == ('0042', 'a.b-c', 'quiz.json'))


def test_unknown_reason():
    check('认不出：没有 4 位前缀', lessonfile.unknown_reason('notes.md') == '没有「4 位序号-」前缀')
    check('认不出：补零位数不对', lessonfile.unknown_reason('12-a.md') == '序号 12 不是 4 位补零')
    check('认不出：后缀不对',
          lessonfile.unknown_reason('0001-a.json') == '认不出的命名（后缀要正好是 md / quiz.json / html）')


def test_page_names():
    check('严格正则：合法课件页', bool(lessonfile.LESSON_NAME_RE.match('0001-http-basics.html')))
    check('严格正则：点分节点 id', bool(lessonfile.LESSON_NAME_RE.match('0003-numpy.arrays.html')))
    check('严格正则：大写 id 不认', not lessonfile.LESSON_NAME_RE.match('0001-HTTP.html'))
    check('严格正则：序号不足 4 位不认', not lessonfile.LESSON_NAME_RE.match('001-http.html'))
    check('宽松正则：id 认不出也认这份文件（要能点名它命名不合规）',
          bool(lessonfile.NUMBERED_NAME_RE.match('0001-任意名字.html')))
    check('宽松正则：仍要求 4 位序号', not lessonfile.NUMBERED_NAME_RE.match('001-x.html'))
    check('取编号：宽松', lessonfile.page_number('0007-whatever.html') == 7)
    check('取编号：认不出回 None', lessonfile.page_number('readme.html') is None)


def test_paths():
    check('主页前缀', lessonfile.asset_prefix('home') == '.learning/assets/')
    check('科目页前缀', lessonfile.asset_prefix('subject') == '../../assets/')
    check('课件页前缀（原先写死在渲染器里那三层）', lessonfile.asset_prefix('lesson') == '../../../assets/')
    check('数学引用三条',
          lessonfile.MATH_REFS == ('katex/katex.min.css', 'katex/katex.min.js', 'lesson-math.js'))
    check('共享层引用四条',
          lessonfile.SHARED_REFS == ('sayo.css', 'learn-theme.css', 'learn-theme.js', 'sayo.js'))
    check('科目组件引用两条', lessonfile.SUBJECT_REFS == ('../assets/style.css', '../assets/quiz.js'))
    check('科目组件引用带深度：课件页相对自己那一层', all(r.startswith('../assets/') for r in lessonfile.SUBJECT_REFS))


def test_scheme():
    check('外链：https', bool(lessonfile.SCHEME_RE.match('https://example.com/a')))
    check('外链：协议相对', bool(lessonfile.SCHEME_RE.match('//cdn.example.com/a.js')))
    check('外链：mailto 也算', bool(lessonfile.SCHEME_RE.match('mailto:a@b.c')))
    check('非外链：相对路径', not lessonfile.SCHEME_RE.match('../assets/style.css'))
    check('非外链：带点的文件名不算 scheme', not lessonfile.SCHEME_RE.match('a.b/c'))


def test_build_examples_assets():
    import fixtures

    with tempfile.TemporaryDirectory(prefix='studymate-example-assets-') as workspace:
        subject = Path(fixtures.write_subject(workspace, name='测试科目'))
        (subject / 'assets' / 'quiz.js').unlink()
        custom = subject / 'assets' / 'custom.js'
        custom.write_bytes(b'custom component')
        result = subprocess.run([sys.executable, str(REPO / 'scripts' / 'build_examples.py'), workspace],
                                capture_output=True, text=True, encoding='utf-8')
        check('重建示例成功（科目尚无课件）', result.returncode == 0, result.stdout + result.stderr)
        for name in lessonfile.SUBJECT_FILES:
            target = subject / 'assets' / name
            check(f'重建示例更新或补齐科目组件 {name}',
                  target.is_file() and target.read_bytes() == (Path(lessonfile.TEMPLATE_ASSETS) / name).read_bytes())
        check('重建示例保留科目自加组件', custom.read_bytes() == b'custom component')


def main():
    for name, func in sorted(globals().items()):
        if name.startswith('test_') and callable(func):
            func()
    print(f'\n{total - failures}/{total} 通过')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
