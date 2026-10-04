#!/usr/bin/env python3
"""测试 gen_home.py 的附件 Markdown 静态编译与渲染逻辑。

验证：
1. markdown_to_html / render_inline_markdown 的解析能力：
   - 标题（h1-h6）、段落、列表（有序/无序/延续行）、代码块、表格、引用块、分割线
   - 行内粗体、斜体、删除线、行内代码、图片、外部与相对链接
2. compile_attachment 编译产物：
   - 产出带有 Sayo UI 结构（.lesson-body、.lesson-bar、.lesson）与暗黑主题开关的 HTML
   - 正确计算相对于 .learning/assets/ 的 assets_rel 路径
   - 自动生成返回科目链接（index.html 或 ../index.html）
3. 主页附件区渲染：
   - 附件列表 href 指向 .html，meta 保留 .md 文件标识
   - 跑 gen_home 能顺利通过 LinkAttrParser 链接自检
"""
import os
import shutil
import sys
import tempfile
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import gen_home


def check(name, ok, detail=''):
    if ok:
        print(f'PASS  {name}')
    else:
        print(f'FAIL  {name}: {detail}', file=sys.stderr)
        sys.exit(1)


def test_markdown_inline():
    # 行内转义与样式
    raw = '这是 `code & <tag>` 与 **粗体** 与 *斜体* 与 [链接](https://example.com) 以及 [相对链接](other.html)'
    html_out = gen_home.render_inline_markdown(raw)
    check('行内代码转义保护', '<code>code &amp; &lt;tag&gt;</code>' in html_out)
    check('粗体渲染', '<strong>粗体</strong>' in html_out)
    check('斜体渲染', '<em>斜体</em>' in html_out)
    check('外链包含 target blank', '<a href="https://example.com" target="_blank" rel="noopener">链接</a>' in html_out)
    check('相对链接无 target blank', '<a href="other.html">相对链接</a>' in html_out)

    class Attributes(HTMLParser):
        def __init__(self):
            super().__init__()
            self.tags = []

        def handle_starttag(self, tag, attrs):
            self.tags.append((tag, dict(attrs)))

    def parse_inline(raw):
        parser = Attributes()
        parser.feed(gen_home.render_inline_markdown(raw))
        return parser.tags

    url = 'https://example.com/?a=1&b=2&q=**literal**&x=~~value~~'
    tags = parse_inline(f'[查询]({url})')
    check('链接查询串只转义一次且不解析行内样式', tags == [
        ('a', {'href': url, 'target': '_blank', 'rel': 'noopener'})], repr(tags))
    alt = 'a & b **原文** `code`'
    tags = parse_inline(f'![{alt}](image.png?a=1&b=2)')
    check('图片 URL 与 alt 原样保留', tags == [
        ('img', {'src': 'image.png?a=1&b=2', 'alt': alt})], repr(tags))

    injected = '`" onmouseover="alert(1)//`'
    tags = parse_inline(f'[链接](https://example.com/{injected})')
    check('URL 中的代码不能突破属性边界', tags == [
        ('a', {'href': f'https://example.com/{injected}',
               'target': '_blank', 'rel': 'noopener'})], repr(tags))
    tags = parse_inline(f'![{injected}](image.png)')
    check('alt 中的代码不能突破属性边界', tags == [
        ('img', {'src': 'image.png', 'alt': injected})], repr(tags))
    check('链接文字中的代码与粗体仍渲染',
          '<strong>粗</strong> <code>code</code></a>' in
          gen_home.render_inline_markdown('[**粗** `code`](page.html)'))
    check('原文不能冒充内部占位符',
          gen_home.render_inline_markdown('\x00CODE_0\x00 `safe`') ==
          '\x00CODE_0\x00 <code>safe</code>')


def test_markdown_blocks():
    md = """# 一级标题
## 二级标题

> 引用第一段
>
> 引用第二段

- 列表项 1
  说明行 1
- 列表项 2

1. 有序 1
2. 有序 2

```python
def test():
    return 42
```

| 字段 | 含义 |
| --- | --- |
| val | 42 |

---
尾部段落。
"""
    res = gen_home.markdown_to_html(md)
    check('一级标题渲染', '<h1>一级标题</h1>' in res)
    check('二级标题渲染', '<h2>二级标题</h2>' in res)
    check('引用块两段渲染', '<blockquote><p>引用第一段</p><p>引用第二段</p></blockquote>' in res)
    check('无序列表与延续行', '<ul>' in res and '<li>列表项 1<br>说明行 1</li>' in res)
    check('有序列表', '<ol>' in res and '<li>有序 1</li>' in res)
    check('围栏代码块', '<pre><code class="language-python">def test():\n    return 42</code></pre>' in res)
    check('表格渲染', '<table class="syo-table">' in res and '<th>字段</th>' in res and '<td>42</td>' in res)
    check('水平分割线', '<hr>' in res)
    check('普通段落', '<p>尾部段落。</p>' in res)


def test_attachment_compilation():
    with tempfile.TemporaryDirectory() as tmpdir:
        ws = os.path.join(tmpdir, 'workspace')
        sdir = os.path.join(ws, '.learning', 'subjects', 'math')
        os.makedirs(os.path.join(sdir, 'assets'), exist_ok=True)
        os.makedirs(os.path.join(sdir, 'learning-records'), exist_ok=True)

        # 准备 style.css 与 md
        with open(os.path.join(sdir, 'assets', 'style.css'), 'w', encoding='utf-8') as f:
            f.write('/* dummy style */')
        with open(os.path.join(sdir, 'GLOSSARY.md'), 'w', encoding='utf-8') as f:
            f.write('# 术语表标题\n\n**矩阵**: 矩形阵列。')
        with open(os.path.join(sdir, 'learning-records', '0001-init.md'), 'w', encoding='utf-8') as f:
            f.write('学习记录正文，无首行一级标题。')

        # 编译根级附件
        href1 = gen_home.compile_attachment(sdir, 'GLOSSARY.md', '术语表', '高等数学', '术语表')
        check('GLOSSARY.md 编译出同名 html', href1 == 'GLOSSARY.html')
        html1_path = os.path.join(sdir, 'GLOSSARY.html')
        check('GLOSSARY.html 文件落盘', os.path.isfile(html1_path))
        with open(html1_path, encoding='utf-8') as f:
            c1 = f.read()
        check('标题与科目', '<title>术语表 · 高等数学</title>' in c1)
        check('返回科目链接', '<a href="index.html">← 返回科目</a>' in c1)
        check('主题开关就位', 'id="attachment-theme-checkbox"' in c1)
        check('根级相对资源路径 ../../assets', 'href="../../assets/sayo/sayo.css"' in c1)
        check('科目 style.css 链接', 'href="assets/style.css"' in c1)

        # 编译子目录附件
        href2 = gen_home.compile_attachment(sdir, 'learning-records/0001-init.md', '学习记录 0001', '高等数学', '学习记录')
        check('子目录 md 编译出同名 html', href2 == 'learning-records/0001-init.html')
        html2_path = os.path.join(sdir, 'learning-records', '0001-init.html')
        check('子目录 html 文件落盘', os.path.isfile(html2_path))
        with open(html2_path, encoding='utf-8') as f:
            c2 = f.read()
        check('自动补全 h1 标题', '<h1>学习记录 0001</h1>' in c2)
        check('子目录返回科目链接 ../index.html', '<a href="../index.html">← 返回科目</a>' in c2)
        check('子目录相对资源路径 ../../../assets', 'href="../../../assets/sayo/sayo.css"' in c2)
        check('子目录科目 style.css 链接 ../assets/style.css', 'href="../assets/style.css"' in c2)


def test_full_gen_home_integration():
    with tempfile.TemporaryDirectory() as tmpdir:
        ws = os.path.join(tmpdir, 'workspace')
        sdir = os.path.join(ws, '.learning', 'subjects', 'physics')
        os.makedirs(sdir, exist_ok=True)
        with open(os.path.join(sdir, 'subject.yaml'), 'w', encoding='utf-8') as f:
            f.write('name: 大学物理\nstatus: 进行中\n')
        with open(os.path.join(sdir, 'GLOSSARY.md'), 'w', encoding='utf-8') as f:
            f.write('# 物理术语\n\n**动量**: p = mv')
        with open(os.path.join(sdir, 'RESOURCES.md'), 'w', encoding='utf-8') as f:
            f.write('# 物理资源\n\n- [MIT OCW](https://ocw.mit.edu)')

        code = gen_home.main([ws])
        check('全流程跑 gen_home 退出码 0', code == 0)

        # 验证 index.html 中附件链接
        with open(os.path.join(sdir, 'index.html'), encoding='utf-8') as f:
            idx = f.read()
        check('主页链接指向 GLOSSARY.html', '<a class="learn-attachment" href="GLOSSARY.html">' in idx)
        check('主页链接指向 RESOURCES.html', '<a class="learn-attachment" href="RESOURCES.html">' in idx)
        check('主页 meta 保持 GLOSSARY.md', '<span class="learn-attachment__meta">GLOSSARY.md</span>' in idx)
        check('主页 meta 保持 RESOURCES.md', '<span class="learn-attachment__meta">RESOURCES.md</span>' in idx)


def test_reference_markdown_attachment():
    with tempfile.TemporaryDirectory() as tmpdir:
        ws = os.path.join(tmpdir, 'workspace')
        sdir = os.path.join(ws, '.learning', 'subjects', 'calculus')
        os.makedirs(os.path.join(sdir, 'reference'), exist_ok=True)

        with open(os.path.join(sdir, 'subject.yaml'), 'w', encoding='utf-8') as f:
            f.write('name: 微积分\nstatus: 进行中\n')
        with open(os.path.join(sdir, 'reference', 'formula_sheet.md'), 'w', encoding='utf-8') as f:
            f.write('# 常用微积分公式速查\n\n- (sin x)\' = cos x')
        with open(os.path.join(sdir, 'reference', 'textbook_notes.md'), 'w', encoding='utf-8') as f:
            f.write('# 同济高数精要\n\n**极限与连续**：ε-δ 语言。')

        code = gen_home.main([ws])
        check('包含 reference/*.md 的科目全流程通过', code == 0)

        with open(os.path.join(sdir, 'index.html'), encoding='utf-8') as f:
            idx = f.read()

        check('参考文档包含 formula_sheet.html', 'href="reference/formula_sheet.html"' in idx)
        check('参考文档包含 textbook_notes.html', 'href="reference/textbook_notes.html"' in idx)
        check('编译出 reference/formula_sheet.html 文件', os.path.isfile(os.path.join(sdir, 'reference', 'formula_sheet.html')))
        check('编译出 reference/textbook_notes.html 文件', os.path.isfile(os.path.join(sdir, 'reference', 'textbook_notes.html')))


def test_sources_markdown_not_on_home():
    with tempfile.TemporaryDirectory() as tmpdir:
        ws = os.path.join(tmpdir, 'workspace')
        sdir = os.path.join(ws, '.learning', 'subjects', 'algorithms')
        os.makedirs(os.path.join(sdir, 'reference'), exist_ok=True)
        os.makedirs(os.path.join(sdir, 'sources'), exist_ok=True)

        with open(os.path.join(sdir, 'subject.yaml'), 'w', encoding='utf-8') as f:
            f.write('name: 算法\nstatus: 进行中\n')
        # reference/ 非空，reference_items 才会真正跑起来（目录不存在时它会提前 return）
        with open(os.path.join(sdir, 'reference', 'formula_sheet.md'), 'w', encoding='utf-8') as f:
            f.write('# 常用公式速查\n\n- 二分查找 O(log n)')
        with open(os.path.join(sdir, 'sources', 'notes.md'), 'w', encoding='utf-8') as f:
            f.write('# 官方文档摘录\n\n- 复杂度对照表')

        code = gen_home.main([ws])
        check('含 sources/*.md 的科目全流程通过', code == 0)

        with open(os.path.join(sdir, 'index.html'), encoding='utf-8') as f:
            idx = f.read()
        check('主页出现 reference/formula_sheet.html', 'href="reference/formula_sheet.html"' in idx)
        check('主页不出现 sources/notes.md', 'sources/notes.md' not in idx)
        check('主页不出现 sources/notes.html', 'sources/notes.html' not in idx)
        check('不生成 sources/notes.html', not os.path.isfile(os.path.join(sdir, 'sources', 'notes.html')))


def main():
    test_markdown_inline()
    test_markdown_blocks()
    test_attachment_compilation()
    test_full_gen_home_integration()
    test_reference_markdown_attachment()
    test_sources_markdown_not_on_home()
    print('\n附件渲染与编译全部测试通过！')


if __name__ == '__main__':
    main()

