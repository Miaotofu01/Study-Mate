/* 公式排版（#91）· **阅读端这一半**：题库字段接上同一个排版器、降级态可读、只接数学式
   ────────────────────────────────────────────────────────────────────────
   这一张套件在 Node 里跑**真的 lib/client.js**（`fixtures/client_harness.mjs`），React 是桩：
   没有 DOM、`useEffect` 不执行。所以这里断言的是「页面里会长成什么元素树」，不是排版结果——
   排版结果与按需加载在 `scripts/tests/browser/math_test.mjs`（真 Chrome）里验。

   三条判据（都对着一句规格）：
     · **题库字段走同一个排版器**：题干 / 选项 / 解析 / 参考答案 / 判分要点里的 `$…$` 出来的是
       `MathSpan`（同一个组件，正文那条路也是它）——不是把 TeX 原文塞进 <p>；
     · **只接数学式**：题库字段里的 `**粗体**`、`` `代码` ``、`[链接](…)` 保持字面量。
       把它们也解析了是**行为变化**，不在这一票里；
     · **降级可读**：引擎没到位时元素里是 TeX 原文（不是空白），失败时多一句人话。
       「没收尾的 `$`」不在这里报——那是内容层的确定性错误（`lib/core/format.ts` 带行号拦下）。
   ──────────────────────────────────────────────────────────────────────── */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clientInternals, findByProp, renderWithState, resetHookState, setHookState, viewText,
} from './fixtures/client_harness.mjs';

const internals = clientInternals();
const { MathSpan, mathNodes, mathSource, MATH_ENDPOINT, Question, SubjectiveBody } = internals;

/** 元素树里所有 `type === MathSpan` 的节点（连同它们的 props）。 */
function mathSpans(node, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const item of node) mathSpans(item, found);
    return found;
  }
  if (node.type === MathSpan) found.push(node);
  if ('children' in node) mathSpans(node.children, found);
  if (node.props && node.props.children !== undefined) mathSpans(node.props.children, found);
  return found;
}

/** 一次 `MathSpan` 渲染（桩里 useEffect 不跑，所以能单独驱动 state）。 */
function renderMath(props, state = []) {
  setHookState(state);
  try {
    return MathSpan(props);
  } finally {
    resetHookState();
  }
}

test('降级态：引擎没到位时元素里是 TeX 原文，不是空白', () => {
  const inline = renderMath({ tex: 'a^2 + b^2 = c^2' });
  assert.equal(inline.type, 'span');
  assert.equal(inline.props.className, 'smb-math');
  assert.equal(viewText(inline).trim(), 'a^2 + b^2 = c^2');

  const block = renderMath({ tex: 'E = mc^2', block: true });
  assert.equal(block.type, 'div');
  assert.equal(block.props.className, 'smb-math-block', '块级的类名是契约（CSS 与套件都按它找）');
  assert.equal(viewText(block).trim(), 'E = mc^2');
});

test('排版成功：KaTeX 的输出原样进容器，TeX 原文让位', () => {
  const html = '<span class="katex"><span class="katex-mathml">…</span></span>';
  const node = renderMath({ tex: 'E = mc^2', block: true }, [{ html, error: null }]);
  assert.equal(node.type, 'div');
  assert.equal(node.props.className, 'smb-math-block');
  assert.deepEqual(node.props.dangerouslySetInnerHTML, { __html: html });
  assert.equal(node.children, undefined, '排版结果在容器里，TeX 原文不该同时留着');
});

test('排版失败：TeX 原文还在，后面跟一句能照着排查的错', () => {
  const node = renderMath({ tex: '\\frac{1}', block: false }, [{ html: null, error: "KaTeX parse error: Expected '}', got 'EOF'" }]);
  assert.equal(node.props.className, 'smb-math');
  const text = viewText(node);
  assert.ok(text.startsWith('\\frac{1}'), `TeX 原文要留着（读到的一半也比空白强）：${text}`);
  assert.match(text, /公式没排出来：KaTeX parse error/);
  const bad = findByProp(node, 'className', 'smb-math__bad');
  assert.equal(bad.length, 1, '那句错要有自己的类名（样式与套件都按它找）');
  assert.equal(bad[0].props.role, 'status', '它是给学生看的状态，不是纯装饰');
});

test('题库字段只接数学式：粗体 / 反引号 / 链接保持字面量', () => {
  const source = '解 **这个** `x` 见 [文档](https://example.com)，公式 $x^2 = 4$ 在这里';
  const nodes = mathNodes(source, 'k');
  const spans = mathSpans(nodes);
  assert.equal(spans.length, 1, '只有数学式那一段该变成元素');
  assert.equal(spans[0].props.tex, 'x^2 = 4');
  assert.equal(spans[0].props.block, undefined);
  // 剩下的都是**字面量**：粗体、反引号、链接一个都没被解析
  const text = nodes.filter((node) => typeof node === 'string').join('');
  assert.ok(text.includes('**这个**'), '粗体不该被解析（那是行为变化）');
  assert.ok(text.includes('`x`'), '反引号不该被解析');
  assert.ok(text.includes('[文档](https://example.com)'), '链接不该被解析');
  assert.equal(nodes.some((node) => node && node.type === 'strong'), false);
});

test('题库字段也认块级 $$…$$（同一个排版器，不是第二套判据）', () => {
  const nodes = mathNodes('推导如下 $$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$ 完', 'k');
  const spans = mathSpans(nodes);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].props.block, true);
  assert.equal(spans[0].props.tex, '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}');
});

test('题干、选项、解析里的公式都走 MathSpan', () => {
  const item = {
    kind: '客观题',
    q: '方程 $x^2 = 4$ 有几个实根？',
    opts: ['$x = 2$ 一个', '$x = \\pm 2$ 两个', '一个都没有'],
    ans: 1,
    why: '因为 $x^2 = 4$ 有两个根。',
  };
  const node = Question({
    item, index: 0, node: { id: 'n' }, subject: 'demo', stateKey: 'demo|n|0',
    chosen: 1, self: null, attempts: new Map(), record: () => {}, onChoose: () => {}, onSelf: () => {},
    lab: null, onLabRun: () => {},
  });
  const spans = mathSpans(node);
  const tex = spans.map((span) => span.props.tex).sort();
  assert.deepEqual(tex, ['x = 2', 'x = \\pm 2', 'x^2 = 4', 'x^2 = 4'],
    `题干/选项/解析里的四处数学式都要排版，实际 ${JSON.stringify(tex)}`);
  // 题干那一段必须在题目文本里，解析那一段在判分块里（两块各一处，不重复）
  const ask = findByProp(node, 'className', 'smb-q__text');
  assert.equal(ask.length, 1);
  assert.equal(mathSpans(ask[0]).length, 1, '题干一处');
  const why = findByProp(node, 'className', 'smb-why');
  assert.equal(why.length, 1);
  assert.equal(mathSpans(why[0]).length, 1, '解析一处');
});

test('参考答案与判分要点（主观题）里的公式同样排版', () => {
  const node = SubjectiveBody({
    item: { answer: '先写成 $Ax = b$，再消元。', criteria: '能写出 $Ax = b$ 就算对' },
    kind: '开放题', open: true, setOpen: () => {}, self: null, onSelf: () => {}, lab: null,
  });
  const spans = mathSpans(node);
  assert.deepEqual(spans.map((span) => span.props.tex), ['Ax = b', 'Ax = b']);
  const refs = findByProp(node, 'className', 'smb-ref');
  assert.equal(refs.length, 2, '参考答案与判分要点两块都要在');
});

test('资源位置：默认走 Host 半的投送路由（导出页那条覆盖在浏览器套件里验）', () => {
  const source = mathSource();
  assert.equal(source.css, `${MATH_ENDPOINT}/katex.min.css`);
  assert.equal(source.js, `${MATH_ENDPOINT}/katex.min.js`);
  assert.equal(MATH_ENDPOINT, '/api/studymate/math', '这个常量必须与 lib/math.ts 的 MATH_ENDPOINT 逐字一致');
});

test('按需加载的判据在组件里：没有数学式就没有 MathSpan（也就没有请求）', () => {
  // 正文里没有 `$…$`：inlineNodes 一个 MathSpan 都不产（这里是它的同一条判据在多行文本上的样子）
  for (const text of ['这一段一个公式都没有。', '价格写成 \\$5 不算公式。', '代码 `$HOME` 不算公式。']) {
    assert.equal(mathSpans(mathNodes(text, 'k')).length, 0, text);
  }
  // 有公式：一个（无论它出现在正文还是题面——两条路都走同一个组件）
  assert.equal(mathSpans(mathNodes('这里 $x$ 有一个', 'k')).length, 1);
});

test('渲染整份文本时不会把渲染函数当纯文本用（viewText 走一遍不炸）', () => {
  const node = renderMath({ tex: 'x^2' });
  assert.equal(typeof viewText(node), 'string');
  assert.equal(viewText(null), '');
});
