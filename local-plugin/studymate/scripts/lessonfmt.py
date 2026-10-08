#!/usr/bin/env python3
"""内容文件语法的唯一口径（第一块：代码围栏）。

`docs/规范/课件内容格式.md` 定义**语法**，这里定义**判定**——哪些行是围栏、信息串怎么取、
哪些语言标签认。这套判定原先散在三个脚本里各写一遍：

- 渲染器（`render_lesson.py`）：`parse_fence` 取语言并查白名单，`parse_blocks` 与
  `empty_reason` 扫描各自翻转一次围栏态；
- 回填器（`apply_empty_reasons.py`）：`find_close` 与 `quiz_blocks` 又判一次
  「围栏里的 `:::` 是代码原文」，注释里写着「与 render_lesson.py 同口径」；
- 主页生成器（`gen_home.py`）：附件 Markdown 编译时再判一次（``` 开块、找闭合行）。

围栏是**翻转**语义：开一行、关一行用同样的标记，信息串（语言标签）只有开的那行有。
判定分叉的代价不是报错而是**静默**：`:::` 被当成指令插进代码块、或代码块整段不上色，
两种都出过事。

还没收进来的（下一步）：`:::` 指令、列表、表格这些块级语法。

用法：

    import lessonfmt
    info = lessonfmt.marker(line)        # None = 不是围栏行；'' = 无语言标签
    if info is not None:
        in_fence = not in_fence
    lessonfmt.is_known_lang(info)        # 认不认这个标签（空串算认）
"""
import re

FENCE = '```'

# 语言标签：COLORED_LANGS 是前端配色表 templates/assets/learn-theme.js 的键（会着色），
# PLAIN_LANGS 是「接受但明确不上色」（标签照原样进页面，前端查不到键自然不上色）。
# 作者面是开放的：不认识就带行号报错，不静默。
# 两张表由 scripts/tests/test_templates.py 钉住：COLORED_LANGS 必须与 `var LANGS` 的键逐个相等。
COLORED_LANGS = ('cpp', 'sh', 'bash', 'shell', 'term', 'html', 'js', 'javascript',
                 'ts', 'typescript', 'json', 'python', 'py')
PLAIN_LANGS = ('text', 'plain', 'markdown', 'md', 'http', 'yaml', 'yml', 'toml',
               'sql', 'ini', 'diff', 'mermaid', 'powershell', 'java')


def marker(line):
    """这一行是不是围栏标记？是就回信息串（``` 后面那段，可能为空串），不是回 None。"""
    stripped = str(line).strip()
    if not stripped.startswith(FENCE):
        return None
    return stripped[len(FENCE):].strip()


def is_fence_line(line):
    """这一行会不会翻转围栏态（开与关都算）。"""
    return marker(line) is not None


def is_known_lang(lang):
    """语言标签认不认；空串算认（不写标签就让前端按内容猜）。"""
    return not lang or lang in COLORED_LANGS + PLAIN_LANGS


# 「简单围栏行」：``` 后面只跟一个标签（可有缩进与首尾空格），行尾没有别的东西。
# 比 marker() 严：```python extra 在渲染器眼里是围栏（随后按未知语言报错），但不算
# 简单围栏行——校验器用它数「题面/答案里的围栏是否成对」，只有这种形状才数。
FENCE_TAG_RE = re.compile(r'[A-Za-z0-9+#.-]*')


def is_simple_fence_line(line):
    """起止各占一整行的围栏行（行首可有缩进 + ``` + 可选简单标签）。"""
    info = marker(line)
    return info is not None and bool(FENCE_TAG_RE.fullmatch(info))
