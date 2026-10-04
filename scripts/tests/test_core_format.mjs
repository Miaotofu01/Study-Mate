/* 解析层核心 · 格式规则（lib/core/format.ts）

   钉的是 `docs/规范/课件内容格式.md` 的**每一条判定**在 JS 侧的落点：块语法、行内语法、
   围栏、9 个 `:::` 指令、front matter 两个字段。断言面是「块树 / 错误 / 渲染片段」，
   不是内部函数——换实现照样该过。

   为什么还断言渲染片段：Python 侧的判定发生在渲染器里（`Renderer.inline`），
   没有中间表示。要与它逐字比对（六课复核就是这么做的），就只能比产出的 HTML 片段。
   解析层因此**顺带**是渲染器，这不是职责错位，而是「判定只有一份」的结果。

   数据全部**现造**（内联字符串），不读仓库里任何文件、不落盘。 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLORED_LANGS, DIRECTIVES, HTML_TAG_NAMES, PLAIN_LANGS, FormatProblems,
  escAttr, escText, escapeQuizAttr, makeCtx, parseBlocks, parseFrontMatter,
  renderBlocks, renderInline,
} from '../../lib/core/format.ts';
import { parseLesson, renderBody } from '../../lib/core/lesson.ts';

/* ── 夹具 ──────────────────────────────────────────────────────────────── */

function lesson(body, front = ['title: 测试课', 'goal: 一句话。']) {
  const lines = ['---', ...front, '---', '', ...body];
  return `${lines.join('\n')}\n`;
}

/** 解析一段正文（自带合法 front matter），返回 { blocks, errors, html }。
 *
 *  **不给题库**：这样 `parseLesson` 会为每条 `::: quiz` 报「没有题」（那条错归
 *  `test_core_lesson.mjs` 的对账套件管）。只想看格式规则时用 `format()`。 */
function parse(body) {
  const source = lesson(body);
  const result = parseLesson(source, 'a.md');
  // 行内语法与行内 HTML 的判定**在渲染里**（与 Python 的 `Renderer.inline` 同构），
  // 所以夹具要顺手渲染一遍——不然行内公式、`<b>` 这类错误根本不会出现。
  const rendered = renderBody(result, 'a.md');
  return {
    blocks: result.blocks,
    errors: [...result.errors, ...rendered.errors],
    html: rendered.html,
  };
}

/** 同上，但把「锚点没题」那类**对账**错误摘掉——只留格式规则的错误。
 *
 *  `parseLesson` 对每条 `::: quiz` 都会去题库里查（这里没给题库，所以必然报
 *  `anchor-missing`）；那条错归 `test_core_lesson.mjs` 的对账套件管，这里不重复断言。 */
function run(body) {
  const result = parse(body);
  return { ...result, errors: result.errors.filter((item) => !item.code.startsWith('anchor-')) };
}

function errorLines(result) {
  return result.errors.map((item) => `${item.line} ${item.message}`);
}

function inline(text) {
  const ctx = makeCtx('a.md');
  return { html: renderInline(text, 7, ctx), errors: ctx.problems.errors };
}

/* ── 词汇表：9 个指令（不是 8 个） ─────────────────────────────────────── */

test('DIRECTIVES 是 9 个名字——ticket 与实施路线写的「8 个」是计数错', () => {
  assert.deepEqual([...DIRECTIVES], [
    'practice', 'quiz', 'figure', 'svg', 'tip', 'warn', 'note', 'resources', 'related',
  ]);
  assert.equal(DIRECTIVES.length, 9);
});

test('语言标签两张表：会着色 13 个、不上色 14 个，互不重叠', () => {
  assert.deepEqual([...COLORED_LANGS], [
    'cpp', 'sh', 'bash', 'shell', 'term', 'html', 'js', 'javascript',
    'ts', 'typescript', 'json', 'python', 'py',
  ]);
  assert.deepEqual([...PLAIN_LANGS], [
    'text', 'plain', 'markdown', 'md', 'http', 'yaml', 'yml', 'toml',
    'sql', 'ini', 'diff', 'mermaid', 'powershell', 'java',
  ]);
  for (const lang of COLORED_LANGS) assert.ok(!PLAIN_LANGS.includes(lang));
});

test('真标签名单一律小写，且每个名字都能被形状正则捕获', () => {
  for (const name of HTML_TAG_NAMES) {
    assert.equal(name, name.toLowerCase());
    assert.match(name, /^[a-zA-Z][a-zA-Z0-9]*$/);   // 连字符名（<syo-editor>）本来就不在名单里
  }
  // 范围是**完整**标准 HTML 元素表 + SVG 元素名（不是「常用子集」）
  for (const name of ['iframe', 'video', 'form', 'main', 'button', 'canvas', 'center', 'font',
    'marquee', 'clippath', 'lineargradient', 'fegaussianblur', 'foreignobject']) {
    assert.ok(HTML_TAG_NAMES.has(name), `名单少了 ${name}`);
  }
});

/* ── front matter ──────────────────────────────────────────────────────── */

test('front matter 只认 title 与 goal；多一个字段带行号报错', () => {
  const source = lesson(['## 一节', ''], ['title: 测试课', 'goal: 一句话。', 'kind: 概念']);
  const result = parseLesson(source, 'a.md');
  assert.deepEqual(errorLines(result), ['4 front matter 不认识的字段 kind（只有 title 与 goal）']);
  assert.equal(result.errors[0].code, 'front-matter-unknown-field');
  assert.deepEqual(result.frontMatter, { title: '测试课', goal: '一句话。', titleLine: 2, goalLine: 3 });
});

test('front matter 的边界：首行不是 ---、没有收尾、空值、缺字段', () => {
  const missingOpen = parseLesson('## 一节\n', 'a.md');
  assert.match(missingOpen.errors[0].message, /内容文件要以 front matter 开头/);
  assert.equal(missingOpen.errors[0].line, 1);

  const noEnd = parseLesson('---\ntitle: x\ngoal: y\n', 'a.md');
  assert.equal(noEnd.errors[0].message, 'front matter 没有结束的 --- 行');
  assert.equal(noEnd.errors[0].line, 1);

  const emptyValue = parseLesson(lesson(['## 一节'], ['title: ', 'goal: y']), 'a.md');
  assert.equal(emptyValue.errors[0].message, 'front matter 的 title 不能为空');
  assert.equal(emptyValue.errors[0].line, 2);

  // 缺字段报在**结束行**（Python `render_lesson.py:254` 的同一口径）
  const missingField = parseLesson(lesson(['## 一节'], ['title: x']), 'a.md');
  assert.equal(missingField.errors[0].message, 'front matter 缺 goal');
  assert.equal(missingField.errors[0].line, 3);

  const badLine = parseLesson(lesson(['## 一节'], ['title: x', '这不是字段']), 'a.md');
  assert.match(badLine.errors[0].message, /front matter 的字段写成 key: value/);
  assert.equal(badLine.errors[0].line, 3);
});

test('front matter 的 title 也是散文：真标签照拦；超 16 字只提示不算错', () => {
  const tagged = parseLesson(lesson(['## 一节'], ['title: <b>粗</b>标题', 'goal: y']), 'a.md');
  assert.ok(tagged.errors.some((item) => item.code === 'html-inline'));
  assert.equal(tagged.errors.find((item) => item.code === 'html-inline').line, 2);

  const long = parseLesson(lesson(['## 一节'], [`title: ${'字'.repeat(17)}`, 'goal: y']), 'a.md');
  assert.deepEqual(long.errors, []);
  assert.equal(long.notes.length, 1);
  assert.match(long.notes[0].message, /标题 17 字 > 16/);
});

/* ── 块语法 ────────────────────────────────────────────────────────────── */

test('只有 ## 与 ###：一级标题与四级标题都带行号报错', () => {
  const h1 = run(['# 一级标题']);
  assert.match(h1.errors[0].message, /这一行被当成一级标题（# 一级标题…）/);
  assert.match(h1.errors[0].message, /#include \/ #define 这类/);
  assert.equal(h1.errors[0].line, 6);

  const h4 = run(['#### 四级标题']);
  assert.equal(h4.errors[0].message, '标题只支持 ## 与 ###（四级及以下没有组件）');
  assert.equal(h4.errors[0].line, 6);

  const empty = run(['## ']);
  assert.equal(empty.errors[0].message, '## 后面要写标题文字');
});

test('段落续行按 CJK 判是否补空格；缩进的块级内容报错', () => {
  const cjk = run(['第一行', '第二行']);
  assert.equal(cjk.blocks[0].text, '第一行第二行');

  const ascii = run(['first', 'second']);
  assert.equal(ascii.blocks[0].text, 'first second');

  const indented = run(['正文一段。', ' 缩进了一格']);
  assert.equal(indented.errors[0].message, '块级内容顶格写（只有列表嵌套才缩进 2 空格）');
  assert.equal(indented.errors[0].line, 7);
});

test('列表：只有 - 与 1.；* 与 + 报错，嵌套只准 2 格', () => {
  const ul = run(['- 项一', '- 项二']);
  assert.equal(ul.blocks.length, 1);
  assert.equal(ul.blocks[0].kind, 'ul');
  assert.deepEqual(ul.blocks[0].items.map((item) => item.text), ['项一', '项二']);

  const ol = run(['1. 第一步', '2. 第二步']);
  assert.equal(ol.blocks[0].kind, 'ol');

  const star = run(['* 项一']);
  assert.equal(star.errors[0].message, '认不出的块语法：无序列表写 `- 项`，引用块本格式不支持');

  const deep = run(['- 项一', '    - 缩进 4 格']);
  assert.equal(deep.errors[0].message, '列表嵌套只缩进 2 空格（这一行缩进了 4 格）');
  assert.equal(deep.errors[0].line, 7);

  const nested = run(['- 项一', '  - 子项']);
  assert.equal(nested.errors.length, 0);
  assert.deepEqual(nested.blocks[0].items[0].children.kind, 'ul');
  assert.equal(nested.blocks[0].items[0].children.items[0].text, '子项');
  assert.match(nested.html, /<li>项一\n      <ul>\n        <li>子项<\/li>/);
});

test('认不出的块语法：引用块、分隔线、HTML、HTML 注释', () => {
  assert.match(run(['> 引用']).errors[0].message, /认不出的块语法/);
  assert.equal(run(['---']).errors[0].message, '内容格式没有分隔线：要分节就写 ## 标题');
  assert.equal(run(['***']).errors[0].message, '内容格式没有分隔线：要分节就写 ## 标题');
  assert.equal(run(['___']).errors[0].message, '内容格式没有分隔线：要分节就写 ## 标题');
  assert.equal(run(['<div>x</div>']).errors[0].message,
    '内容文件不写 HTML（读到 <div>）：用内容格式的块与行内语法，HTML 由渲染器产出');
  assert.match(run(['<!-- 题目位置：L1 ×2 -->']).errors[0].message, /内容文件不写 HTML 注释/);
});

/* ── 围栏 ──────────────────────────────────────────────────────────────── */

test('围栏：语言白名单、原文逐字保留、收尾按 strip() 判', () => {
  const ok = run(['```python', 'print(1)', '```']);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.blocks[0].lang, 'python');
  assert.equal(ok.blocks[0].text, 'print(1)');
  assert.equal(ok.html, '  <pre data-lang="python"><code>print(1)</code></pre>');

  const noLang = run(['```', '原文', '```']);
  assert.equal(noLang.html, '  <pre><code>原文</code></pre>');   // 不写语言就不产出 data-lang

  for (const bad of ['rust', '`text', 'python extra', 'c++']) {
    const result = run(['```' + bad, 'x', '```']);
    assert.ok(result.errors.some((item) => item.message.includes(`不认识的语言标签 \`${bad}\``)),
      `${bad} 应该报未知标签`);
    assert.equal(result.errors.find((item) => item.code === 'fence-unknown-lang').line, 6);
  }

  const unterminated = run(['```text', '没有收尾']);
  assert.equal(unterminated.errors[0].message, '代码围栏没有闭合（块尾补一行 ```）');
  assert.equal(unterminated.errors[0].line, 6);

  // 收尾按 strip() 判：块内缩进的 ``` 会**提前**收尾（照抄 Python 的坑）
  const early = run(['```text', 'a', '  ```', 'b 还在围栏外']);
  assert.deepEqual(early.errors, []);
  assert.equal(early.blocks[0].text, 'a');
  assert.equal(early.blocks[1].kind, 'p');
});

test('围栏里的 # 与 ::: 都是原文，不当标题/指令', () => {
  const result = run(['```text', '#include <cstdio>', '::: quiz 理解 锚点：假的', '```']);
  assert.deepEqual(result.errors, []);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].kind, 'code');
  assert.equal(result.blocks[0].text, '#include <cstdio>\n::: quiz 理解 锚点：假的');
});

/* ── 管道表 ────────────────────────────────────────────────────────────── */

test('管道表：分隔行、格子数、`\\|` 转义', () => {
  const ok = run(['| a | b |', '| --- | --- |', '| 1 | 2 |']);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.blocks[0].header, ['a', 'b']);
  assert.deepEqual(ok.blocks[0].rows, [['1', '2']]);
  assert.match(ok.html, /<thead>/);

  const oneRow = run(['| 只有表头 |']);
  assert.equal(oneRow.errors[0].message,
    '表格第二行必须是分隔行（| --- | --- |），第一行是表头');
  assert.equal(oneRow.errors[0].line, 6);

  const shortSep = run(['| a | b |', '| --- |']);
  assert.equal(shortSep.errors[0].message,
    '表格分隔行有 1 格，表头是 2 格——两行的格子数必须一样（如 `| --- | --- |`）');
  assert.equal(shortSep.errors[0].line, 7);

  const emptyCell = run(['| a | b |', '| --- | |']);
  assert.equal(emptyCell.errors[0].message,
    '表格分隔行的每一格都要写成 ---（现在是 空的一格）——这一行只标明哪几列，不写内容');

  const shortRow = run(['| a | b |', '| --- | --- |', '| 少一格 |']);
  assert.equal(shortRow.errors[0].message,
    '表格这一行有 1 格，表头是 2 格（单元格里的竖线写成 \\|）');
  assert.equal(shortRow.errors[0].line, 8);

  const escaped = run(['| a | b |', '| --- | --- |', '| x \\| y | 2 |']);
  assert.deepEqual(escaped.blocks[0].rows, [['x | y', '2']]);

  // `|:---|` 也认
  assert.deepEqual(run(['| a |', '|:---:|', '| 1 |']).errors, []);
});

/* ── 行内语法 ──────────────────────────────────────────────────────────── */

test('行内：code、粗体、斜体、链接、上下标、转义', () => {
  assert.equal(inline('`code`').html, '<code>code</code>');
  assert.equal(inline('**粗**').html, '<b>粗</b>');
  assert.equal(inline('*斜*').html, '<em>斜</em>');
  assert.equal(inline('10 * 20').html, '10 * 20');
  assert.equal(inline('[文字](a.html)').html, '<a href="a.html">文字</a>');
  assert.equal(inline('2^31^').html, '2<sup>31</sup>');
  assert.equal(inline('a~n~').html, 'a<sub>n</sub>');
  assert.equal(inline('10 ~ 20').html, '10 ~ 20');
  assert.equal(inline('a ^ b').html, 'a ^ b');
  assert.equal(inline('`int **p`').html, '<code>int **p</code>');
  // code span 里 `*`/`**` 是字面量，但 ^x^/~x~ 照样解析
  assert.equal(inline('`10^10^`').html, '<code>10<sup>10</sup></code>');
  assert.equal(inline('a<b>c').html, 'a&lt;b&gt;c');   // 运算符，不是标签
  assert.equal(inline('`vector<int>`').html, '<code>vector&lt;int&gt;</code>');
});

test('落单的反引号不是 code 区，遮不住后面的标签', () => {
  const result = inline('见 ` 这里 <b>粗</b> 结束');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /不写 HTML（正文）：读到 '<b>'/);
});

test('真标签两条判据缺一不可；一段只报第一处 + 总数', () => {
  assert.deepEqual(inline('n<m 且 m>0').errors, []);
  assert.deepEqual(inline('<T>').errors, []);
  assert.deepEqual(inline('`~a & ~b`').errors, []);

  const result = inline('<b>粗</b> 与 <script>x</script>');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /读到 '<b>'（这一段还有 2 处）/);

  const single = inline('只有 <b>一处</b>');
  assert.match(single.errors[0].message, /读到 '<b>'（这一段还有 1 处）/);
});

test('HTML 注释在行内也拦，并指出第几个字符处', () => {
  const result = inline('前面 <!-- 题目位置 --> 后面');
  assert.match(result.errors[0].message, /第 4 个字符处读到 <!--/);
});

/* ── 数学式（文档 L178-179 与实现的冲突点） ───────────────────────────── */

test('行内公式：判据是「开 $ 后非空白、收 $ 前非空白、中间非空不跨行」', () => {
  assert.equal(inline('$Ax = b$').html, '<span class="math-inline">Ax = b</span>');
  assert.deepEqual(inline('$ x$').errors, []);         // 开 $ 后是空白 → 不是公式也不算错
  assert.equal(inline('$5').errors.length, 1);         // 开 $ 后紧跟 5 → 报「没有收尾」
  assert.equal(inline('\\$5').html, '$5');             // `\$` 是字面美元号
});

test('`花了 $5 和 $10` 报错——按实现，不按文档原来的「按字面量处理」', () => {
  const result = parse(['花了 $5 和 $10。']);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /行内公式 `\$…\$` 没有收尾/);
  assert.equal(result.errors[0].line, 6);
});

test('段中 $$…$$ 也包成 math-block（实现比文档宽）；没有收尾报错', () => {
  const result = run(['前面 $$x$$ 后面']);
  assert.deepEqual(result.errors, []);
  assert.match(result.html, /<span class="math-block">x<\/span>/);

  const broken = parse(['$$x']);
  assert.match(broken.errors[0].message, /块级公式 `\$\$…\$\$` 没有收尾/);

  // 整段只有 $$…$$ → div（不是 span）
  const wholeLine = run(['$$y$$']);
  assert.match(wholeLine.html, /<div class="math-block">y<\/div>/);
});

test('代码围栏与行内代码里的 $ 不受影响', () => {
  assert.deepEqual(run(['```sh', 'echo $HOME', '```']).errors, []);
  assert.equal(inline('`$HOME`').html, '<code>$HOME</code>');
});

/* ── `:::` 指令的通用边界 ──────────────────────────────────────────────── */

test('未知指令带行号报错，未知指令块内的内容不再二次报错', () => {
  const result = run(['::: fancy 标题', '块里的东西 <b>粗</b>', ':::']);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].message,
    '未知指令 ::: fancy（可用：practice、quiz、figure、svg、tip、warn、note、resources、related）');
  assert.equal(result.errors[0].line, 6);
  assert.deepEqual(result.blocks, []);
});

test('指令通用边界：多出来的 :::、四个冒号、没有闭合、不能嵌套', () => {
  assert.equal(run([':::']).errors[0].message, '多出来的 :::（没有对应的指令开始）');

  // `:::: tip` 形状正则不认 → 开与收各报一次
  const four = run([':::: tip', '::::']);
  assert.equal(four.errors.length, 2);
  assert.ok(four.errors.every((item) => item.message === '指令写法是 ::: <名字> [参数]（这一行认不出）'));

  const unclosed = run(['  ::: tip 忘了闭合'.trim()]);
  assert.equal(unclosed.errors[0].message, '指令 ::: tip 没有闭合（块尾补一行 :::）');
  assert.equal(unclosed.errors[0].line, 6);

  const nested = run(['::: tip 外', '::: note 内', ':::', ':::']);
  assert.ok(nested.errors.some((item) => item.code === 'directive-nested'));
  assert.equal(nested.errors.find((item) => item.code === 'directive-nested').line, 7);
});

test('指令名区分大小写；带连字符的名字白名单不认', () => {
  assert.match(run(['::: TIP 标题', ':::']).errors[0].message, /未知指令 ::: TIP/);
  assert.match(run(['::: syo-editor', ':::']).errors[0].message, /未知指令 ::: syo-editor/);
});

test('缩进的 ::: 先报「块级内容顶格写」', () => {
  const result = run(['  ::: quiz 理解 锚点：x', '  :::']);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every((item) => item.code === 'indented-block'));
});

test('`empty_reason:` 只能出现在 ::: quiz 的块里；围栏里的同名串不算', () => {
  const stray = run(['::: tip 提示', 'empty_reason: 不该在这里', ':::']);
  assert.equal(stray.errors.length, 1);
  assert.equal(stray.errors[0].code, 'stray-empty-reason');
  assert.equal(stray.errors[0].line, 7);

  const inFence = run(['::: tip 提示', '```text', 'empty_reason: 代码原文', '```', ':::']);
  assert.deepEqual(inFence.errors, []);
});

/* ── 九个指令各自的判定 ───────────────────────────────────────────────── */

test('::: practice —— 参数是「层级 | 标题」，正好一个竖线', () => {
  const ok = run(['::: practice 练习 | 第 1 步 · 跑三遍', '', '正文。', '', ':::']);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.blocks[0].level, '练习');
  assert.equal(ok.blocks[0].title, '第 1 步 · 跑三遍');
  assert.match(ok.html, /lesson-practice__level">练习</);

  assert.equal(run(['::: practice 练习', ':::']).errors[0].message,
    '写法是 ::: practice <层级> | <标题>（中间一个竖线）');
  assert.equal(run(['::: practice 练习 | ', ':::']).errors[0].message,
    'practice 的层级与标题都要写（如 ::: practice 练习 | 第 1 步 · 跑三遍）');
  assert.equal(run(['::: practice 练习 | 标题 | 多一个', ':::']).errors[0].message,
    '写法是 ::: practice <层级> | <标题>（中间一个竖线）');
});

test('::: quiz —— 全角 `：` 与半角 `:` 都认，层级与锚点都不能空', () => {
  const full = run(['::: quiz 理解 锚点：悬垂 else 的归属', ':::']);
  assert.deepEqual(full.errors, []);
  assert.equal(full.blocks[0].anchor, '悬垂 else 的归属');

  const half = run(['::: quiz 理解 锚点:悬垂 else 的归属', ':::']);
  assert.deepEqual(half.errors, []);
  assert.equal(half.blocks[0].anchor, '悬垂 else 的归属');   // 半角原来会被静默丢掉

  // 层级含空格：整段当层级（Python 的 `^(.*?)锚点`）
  const spaced = run(['::: quiz 理解 加深 锚点：x', ':::']);
  assert.deepEqual(spaced.errors, []);
  assert.equal(spaced.blocks[0].level, '理解 加深');

  assert.equal(parse(['::: quiz 理解 没有锚点字样', ':::']).errors[0].message,
    '写法是 ::: quiz <层级> 锚点：<锚点文本>（锚点要和题库的键逐字一致）');
  assert.equal(parse(['::: quiz 锚点：有的锚点', ':::']).errors[0].message,
    'quiz 要写层级（理解/改造/排错/应用，见 layered-practice）');
  assert.equal(parse(['::: quiz 理解 锚点：', ':::']).errors[0].message,
    '写法是 ::: quiz <层级> 锚点：<锚点文本>（锚点要和题库的键逐字一致）');

  const body = parse(['::: quiz 理解 锚点：x', '别的东西', ':::']);
  assert.equal(body.errors[0].code, 'quiz-body');
  assert.equal(body.errors[0].line, 7);

  const reason = run(['::: quiz 应用 锚点：x', 'empty_reason: lab 里验', ':::']);
  assert.deepEqual(reason.errors, []);
  assert.equal(reason.blocks[0].empty_reason, 'lab 里验');
});

test('::: figure —— 路径必须有、alt: 必填、块里只写两行', () => {
  const ok = run(['::: figure ../assets/img/pool/a.png', 'alt: 说明', 'caption: 图注', ':::']);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.blocks[0].src, '../assets/img/pool/a.png');
  assert.equal(ok.blocks[0].alt_line, 7);
  assert.equal(ok.blocks[0].caption_line, 8);
  assert.match(ok.html, /<figcaption>图 1 · 图注<\/figcaption>/);   // 编号由渲染器按页内顺序给

  assert.equal(run(['::: figure', ':::']).errors[0].message,
    '写法是 ::: figure <相对路径>（图从科目图片库 assets/img/pool/ 挑）');
  assert.equal(run(['::: figure a.png', ':::']).errors[0].message,
    '::: figure 缺 alt:（裂图时读屏软件与学生都只剩空白）');
  assert.equal(run(['::: figure a.png', 'alt: x', '别的行', ':::']).errors[0].message,
    '::: figure 的块里只写 alt: 与 caption: 两行');
});

test('::: figure —— 外链与绝对路径在解析层拦下（存在性由调用方钩子）', () => {
  const remote = parse(['::: figure https://x.example/a.png', 'alt: x', ':::']);
  assert.equal(remote.errors[0].code, 'figure-src');
  assert.match(remote.errors[0].message, /只接受本地相对路径/);

  const absolute = parse(['::: figure /tmp/a.png', 'alt: x', ':::']);
  assert.match(absolute.errors[0].message, /只接受本地相对路径/);

  const hook = parseLesson(lesson(['::: figure a.png', 'alt: x', ':::']), 'a.md', {
    checkFigureSrc: () => '图片文件不存在：a.png（解析到 /tmp/a.png）——从科目图片库 assets/img/pool/ 挑一张，或先采图',
  });
  assert.equal(hook.errors[0].code, 'figure-src');
  assert.equal(hook.errors[0].line, 6);
});

test('::: svg —— 原样透传、必须有 <svg> 与收尾、字段行必须在原文之前', () => {
  const ok = run(['::: svg', 'alt: 收拢', 'caption: 过程', '',
    '<svg viewBox="0 0 4 2" role="img"><path d="M0 0h4"/></svg>', ':::']);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.blocks[0].raw, '<svg viewBox="0 0 4 2" role="img"><path d="M0 0h4"/></svg>');
  assert.match(ok.html, /role="img" aria-label="收拢"/);

  assert.deepEqual(run(['::: svg', '<svg viewBox="0 0 4 2"/>', ':::']).errors, []);   // 自闭合也算收尾

  assert.equal(run(['::: svg', ':::']).errors[0].message,
    '::: svg 块里没有 <svg>…</svg> 原文（内联图直接贴进来）');
  assert.equal(run(['::: svg', '<svg viewBox="0 0 4 2">', ':::']).errors[0].message,
    '::: svg 块里的 <svg> 没有 </svg> 收尾（原样透传前先补全，'
    + '否则页面结构会从这里断掉；自闭合的 <svg/> 也算收尾）');
  assert.equal(run(['::: svg 多写了参数', '<svg/>', ':::']).errors[0].message,
    '::: svg 不带参数：说明写在块里的 alt: / caption: 两行');
  assert.equal(run(['::: svg', '不是标签的一行', ':::']).errors[0].message,
    '::: svg 的块里先写 alt:/caption:，接着是 <svg>…</svg> 原文（这一行都不是）');

  // 收尾按**行**拼后判：`</sv` + `g>` 拆成两行不算收尾
  const split = run(['::: svg', '<svg viewBox="0 0 4 2">', '</sv', 'g>', ':::']);
  assert.ok(split.errors.some((item) => item.code === 'svg-no-close'));
});

test('::: svg —— alt: 写两遍后者覆盖、写在原文之后整行进 raw（照抄 Python 的静默点）', () => {
  const twice = run(['::: svg', 'alt: 第一个', 'alt: 第二个', '<svg/>', ':::']);
  assert.deepEqual(twice.errors, []);
  assert.equal(twice.blocks[0].alt, '第二个');

  const after = run(['::: svg', '<svg/>', 'alt: 写在后面', ':::']);
  assert.deepEqual(after.errors, []);
  assert.equal(after.blocks[0].alt, '');
  assert.equal(after.blocks[0].raw, '<svg/>\nalt: 写在后面');
});

test('::: tip / warn / note —— 标题可省，块里是普通块', () => {
  for (const [name, cls] of [['tip', 'lesson-tip'], ['warn', 'lesson-warn'], ['note', 'lesson-note']]) {
    const result = run([`::: ${name} 标题`, '正文。', ':::']);
    assert.deepEqual(result.errors, []);
    assert.match(result.html, new RegExp(`<div class="${cls}">`));
    assert.match(result.html, /<b>标题<\/b>/);
  }
  assert.deepEqual(run(['::: tip', '没有标题。', ':::']).errors, []);
});

test('::: resources / related —— 两种条目写法、空块报错', () => {
  const resources = run(['::: resources',
    '- [OI Wiki · 分支](https://oi-wiki.org/lang/branch/) | 官方文档 · 写法',
    '- Competitive Programming 4（Halim 等，第 4 版） | 书 · 当参考书查',
    ':::']);
  assert.deepEqual(resources.errors, []);
  assert.equal(resources.blocks[0].items.length, 2);
  assert.equal(resources.blocks[0].items[1].href, '');
  assert.equal(resources.blocks[0].items[1].title, 'Competitive Programming 4（Halim 等，第 4 版）');
  assert.match(resources.html, /lesson-resources__meta/);

  const related = run(['::: related', '- [上节课：浮点与精度](0004-cpp.float.html)', ':::']);
  assert.deepEqual(related.errors, []);
  assert.match(related.html, /<div class="lesson-related">/);

  const meta = run(['::: related', '- [标题](a.html) | 说明', ':::']);
  assert.ok(meta.errors.some((item) => item.message
    === '::: related 的条目只写 `- [标题](链接)`（说明是 resources 才有的）'));
  assert.ok(meta.errors.some((item) => item.code === 'links-empty'));

  const empty = run(['::: resources', ':::']);
  assert.equal(empty.errors[0].message, '::: resources 块里没有条目（写 `- [标题](链接)`）');

  const plain = run(['::: related', '- 纯文字条目 | 说明', ':::']);
  assert.ok(plain.errors.some((item) => item.message === '::: related 的条目写成 `- [标题](链接)`'));
});

/* ── 转义 ──────────────────────────────────────────────────────────────── */

test('转义口径：文本节点不转单引号，属性值转双引号与单引号', () => {
  assert.equal(escText("print(v, '->', x)"), "print(v, '-&gt;', x)");
  assert.equal(escText('a&b<c>d'), 'a&amp;b&lt;c&gt;d');
  assert.equal(escAttr(`it's "q"`), 'it&#x27;s &quot;q&quot;');
  assert.equal(escapeQuizAttr(`{'a': 1 < 2}`), '{&#39;a&#39;: 1 &lt; 2}');
});

/* ── 与 Python / 文档的三源一致 ────────────────────────────────────────── */

test('真标签名单：代码 = Python 的 HTML_TAG_NAMES = 格式文档 §2 的名单', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');

  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const py = readFileSync(`${repo}scripts/render_lesson.py`, 'utf8');
  const block = /HTML_TAG_NAMES = frozenset\('''([\s\S]*?)'''\.split\(\)\)/.exec(py);
  assert.ok(block, '没在 render_lesson.py 里找到 HTML_TAG_NAMES');
  const pyNames = new Set(block[1].split(/\s+/).filter(Boolean));

  const doc = readFileSync(`${repo}docs/规范/课件内容格式.md`, 'utf8');
  const anchor = doc.indexOf('加上 SVG 元素名');
  assert.ok(anchor > 0, '没在格式文档里找到名单的引言');
  const open = doc.indexOf('`', anchor);
  const close = doc.indexOf('`', open + 1);
  assert.ok(open > 0 && close > open, '没在格式文档里找到名单的反引号块');
  const docNames = new Set(doc.slice(open + 1, close).split(/\s+/).filter(Boolean));

  const missing = [...pyNames].filter((name) => !HTML_TAG_NAMES.has(name)).sort();
  const extra = [...HTML_TAG_NAMES].filter((name) => !pyNames.has(name)).sort();
  assert.deepEqual(missing, [], `TS 少了：${missing.join(' ')}`);
  assert.deepEqual(extra, [], `TS 多了：${extra.join(' ')}`);
  assert.deepEqual([...docNames].filter((name) => !HTML_TAG_NAMES.has(name)).sort(), [],
    '文档里的名字 TS 没有');
  assert.deepEqual([...HTML_TAG_NAMES].filter((name) => !docNames.has(name)).sort(), [],
    'TS 的名字文档里没有');
});

test('解析层的 import 里没有 node:*（零宿主依赖）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const coreDir = fileURLToPath(new URL('../../lib/core/', import.meta.url));
  for (const name of readdirSync(coreDir)) {
    const source = readFileSync(`${coreDir}${name}`, 'utf8');
    assert.ok(!/from\s+['"]node:/.test(source), `${name} 里出现了 node: import`);
    assert.ok(!/require\(/.test(source), `${name} 里出现了 require`);
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith('./'), `${name} import 了 core 域之外的东西：${match[1]}`);
    }
  }
});

test('FormatProblems 同一条只报一次', () => {
  const problems = new FormatProblems();
  problems.add('a.md', 3, '重复的话', 'unknown-block');
  problems.add('a.md', 3, '重复的话', 'unknown-block');
  assert.equal(problems.errors.length, 1);
  problems.note('a.md', 3, '提示不算错');
  assert.equal(problems.errors.length, 1);
  assert.equal(problems.notes.length, 1);
  assert.deepEqual(problems.report(), ['a.md:3 重复的话']);
});

test('parseFrontMatter 单独可用（回 bodyStart 与字段行号）', () => {
  const lines = ['---', 'title: x', 'goal: y', '---', '', '## 一节'];
  const ctx = makeCtx('a.md');
  const { front, bodyStart } = parseFrontMatter(lines, ctx);
  assert.equal(bodyStart, 4);
  assert.deepEqual(front, { title: 'x', goal: 'y', titleLine: 2, goalLine: 3 });
  assert.deepEqual(ctx.problems.errors, []);
});

test('parseBlocks 单独可用（回块与下一个未消费的行下标）', () => {
  const lines = ['## 一节', '', '正文。', '', '```text', '代码', '```', '', '尾巴'];
  const ctx = makeCtx('a.md');
  const { blocks, next } = parseBlocks(lines, 0, lines.length, ctx);
  assert.deepEqual(blocks.map((block) => block.kind), ['h2', 'p', 'code', 'p']);
  assert.equal(next, lines.length);
  assert.deepEqual(ctx.problems.errors, []);
});
