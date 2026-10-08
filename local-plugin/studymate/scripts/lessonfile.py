#!/usr/bin/env python3
"""课件文件与页面路径的唯一口径：文件名怎么拼、页面该用哪个资源前缀、要引用哪些文件。

为什么有这一个模块：同一套约定原先散在五个脚本里各写半截——渲染器自己拼
`{序号:04d}-{节点id}.md`（`render_lesson.py`）、校验器自带一条严格文件名正则
与一条宽松正则（`check_lesson.py`）、重排编号自带后缀表与解析器
（`renumber_lessons.py`）、主页生成器又抄了一条宽松正则并从文件名反推节点 id
（`gen_home.py`）；课件页引用共享层的相对路径在渲染器里写死三层
（`../../../assets/`），主页那一侧却是按页深推导的。

这里只回答两件事，别的不管：

1. **文件名**：`<4 位序号>-<节点id>.<md|quiz.json|html>`。
   后缀不带点（`'md'` / `'quiz.json'` / `'html'`）——与 `split_name` 的返回一致。
2. **页面路径**：三种页面（根主页 / 科目页 / 课件页）各自引用共享层与科目组件时
   该用的前缀与文件名清单。

用法：

    import lessonfile
    lessonfile.lesson_name(3, 'numpy.arrays', 'md')   # '0003-numpy.arrays.md'
    lessonfile.split_name('0008-cpp.array.quiz.json') # ('0008', 'cpp.array', 'quiz.json')
    lessonfile.asset_prefix('lesson')                 # '../../../assets/'
"""
import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NUM_WIDTH = 4
# 三件套的后缀：长的在前——`.quiz.json` 是双扩展名，节点 id 自己也可以带点（`cpp.array`）
EXTS = ('.quiz.json', '.md', '.html')
EXT_ORDER = {'md': 0, 'quiz.json': 1, 'html': 2}

NAME_RE = re.compile(r'^(?P<num>\d+)-(?P<rest>.+)$')
# 严格：课件页的文件名必须正好是 `<4 位序号>-<节点id>.html`，节点 id 分段合法
LESSON_NAME_RE = re.compile(r'^(\d{4})-(?:[a-z0-9]+[.-])*[a-z0-9]+\.html$')
# 宽松：只认「4 位序号-」前缀的 .html——用来发现同一目录里命名不合规的兄弟文件
NUMBERED_NAME_RE = re.compile(r'^(\d{4})-.*\.html$')

# 三种页面引用共享层的相对前缀（工作区布局见 templates/assets/README.md）
ASSET_PREFIX = {
    'home': '.learning/assets/',
    'subject': '../../assets/',
    'lesson': '../../../assets/',
}
# 课件页引用本科目组件的清单（检查项 3 的口径）
SHARED_REFS = ('sayo.css', 'learn-theme.css', 'learn-theme.js', 'sayo.js')
SUBJECT_REFS = ('../assets/style.css', '../assets/quiz.js')
# 数学式：只有含公式的课件页才注入这三个引用（离线 KaTeX）
MATH_REFS = ('katex/katex.min.css', 'katex/katex.min.js', 'lesson-math.js')
# 链接是不是外链（任何 `scheme:` 或协议相对 `//`）：渲染器、校验器、主页生成器同一份
SCHEME_RE = re.compile(r'^(?:[A-Za-z][A-Za-z0-9+.\-]*:|//)')

# ══════════════════════════════════════════════════════════════════
# 共享层与课件层组件的清单（**全仓库唯一一份**）
# 源在 templates/assets/；共享层全工作区一份，课件层每个科目一份
# ══════════════════════════════════════════════════════════════════
TEMPLATE_ASSETS = os.path.join(ROOT, 'templates', 'assets')
# 全工作区共享一份：两个整目录 + 四个平铺文件
SHARED_DIRS = ('sayo', 'katex')
SHARED_FILES = ('learn-theme.css', 'learn-theme.js', 'learn-mascot.png', 'lesson-math.js')
# 课件层：每个科目一份的三个组件
SUBJECT_FILES = ('style.css', 'learning-records.js', 'quiz.js', 'lesson-toc.js', 'review.js')
# templates/assets/ 顶层除清单之外只允许有说明文件
ASSET_DOC = 'README.md'


def _copy_listed(names, source_dir, target_dir, problems, what):
    for name in names:
        source = os.path.join(source_dir, name)
        target = os.path.join(target_dir, name)
        if os.path.isdir(source):
            shutil.copytree(source, target, dirs_exist_ok=True)
        elif os.path.isfile(source):
            os.makedirs(target_dir, exist_ok=True)
            shutil.copy2(source, target)
        else:
            problems.append(f'缺少{what} {source}，请检查模板目录是否完整')


def install_shared(ws, problems=None):
    '''把共享层拷进 `<ws>/.learning/assets/`（幂等覆盖）→ 问题清单（空 = 全拷好）。

    缺共享层页面会退化成无样式裸 HTML，所以调用方拿到问题就该停下。
    '''
    problems = [] if problems is None else problems
    target = os.path.join(str(ws), '.learning', 'assets')
    _copy_listed(SHARED_DIRS + SHARED_FILES, TEMPLATE_ASSETS, target, problems, '共享资源')
    return problems


def install_subject(subject_dir, problems=None):
    '''把课件层组件拷进 `<subject_dir>/assets/`（幂等覆盖）→ 问题清单。'''
    problems = [] if problems is None else problems
    _copy_listed(SUBJECT_FILES, TEMPLATE_ASSETS, os.path.join(str(subject_dir), 'assets'),
                 problems, '课件层资源')
    return problems
SCHEME_RE = re.compile(r'^(?:[A-Za-z][A-Za-z0-9+.\-]*:|//)')


def lesson_name(index, node_id, ext):
    """`(3, 'numpy.arrays', 'md')` → `'0003-numpy.arrays.md'`（序号补零到 4 位）。"""
    return f'{int(index):0{NUM_WIDTH}d}-{node_id}.{ext}'


def split_name(name):
    """`0008-cpp.array.quiz.json` → ('0008', 'cpp.array', 'quiz.json')；认不出回 None。"""
    for ext in EXTS:
        if name.endswith(ext) and len(name) > len(ext):
            head = name[: -len(ext)]
            break
    else:
        return None
    match = NAME_RE.match(head)
    if match is None:
        return None
    return match.group('num'), match.group('rest'), ext[1:]


def unknown_reason(name):
    """认不出的命名给一句原因（它只是没被接管，不是错误）。"""
    head = re.match(r'^(\d+)-', name)
    if head is None:
        return f'没有「{NUM_WIDTH} 位序号-」前缀'
    if len(head.group(1)) != NUM_WIDTH:
        return f'序号 {head.group(1)} 不是 {NUM_WIDTH} 位补零'
    return '认不出的命名（后缀要正好是 md / quiz.json / html）'


def asset_prefix(page):
    """页面类型 → 引用共享层的相对前缀（`home` / `subject` / `lesson`）。"""
    return ASSET_PREFIX[page]


def page_number(name):
    """宽松取「4 位序号-」里的序号（`.html` 课件页）；认不出回 None。"""
    match = NUMBERED_NAME_RE.match(name)
    return int(match.group(1)) if match else None
