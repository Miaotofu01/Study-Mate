#!/usr/bin/env python3
"""页面骨架与占位符替换的唯一口径：`esc` 与 `replace_block` / `replace_field`。

为什么单独一个模块：课件渲染器原先为了复用这三个函数 `import gen_home`——一个 1300 行的
主页生成器被当成库用，依赖方向（渲染 → 主页）与实际的知识归属相反。两者现在都依赖这里。

占位符契约本身（哪个模板有哪些槽位、粒度、谁来填）见 `docs/规范/工程约束.md` §三与模板注释；
这里只管替换口径与转义——替换缺失一律报错退出，防止模板被改坏后静默残缺。

用法：

    import pagetpl
    pagetpl.esc(value)                      # 文本节点
    pagetpl.esc(value, attr=True)           # 属性值（多转义引号）
    pagetpl.replace_block(html, ph, block, name)
"""
import html

# 占位符形状：`<!-- @LEARN:NAME -->`（区块级独立成行、字段级可嵌在标签里）
PLACEHOLDER = '<!-- @LEARN:{} -->'


def esc(value, attr=False):
    """HTML 转义：文本节点转义 &<>，属性值再多转义引号。"""
    return html.escape(str(value), quote=attr)


def replace_block(template_html, placeholder, html_block, template_name):
    """区块占位符整行替换；缺失则报错（防止模板被改坏后静默残缺）。"""
    if placeholder not in template_html:
        raise SystemExit(f'{template_name} 缺少占位符 {placeholder}，请检查模板与 Global Constraints 约定')
    return template_html.replace(placeholder, html_block, 1)


def replace_field(template_html, placeholder, value, template_name):
    """字段占位符全替换（可能多处出现，如 TITLE 在 <title> 和 <h1>）；缺失同样报错。"""
    if placeholder not in template_html:
        raise SystemExit(f'{template_name} 缺少占位符 {placeholder}，请检查模板与 Global Constraints 约定')
    return template_html.replace(placeholder, value)
