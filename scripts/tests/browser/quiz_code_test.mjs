// 题目里的代码块：在真实浏览器里验渲染与上色
//   node scripts/tests/browser/quiz_code_test.mjs
//
// 钉住两件在假 DOM 里测不到的事：
//   1. 围栏渲染出的 <pre><code> 真的按等宽 + 保留缩进排（缩进靠 Range 量左边界）
//   2. quiz.js 建完块会**自己**触发一次上色——learn-theme.js 的自动扫描挂在 head、
//      DOMContentLoaded 先注册，扫描跑在 quiz.js 建块之前，不显式再扫就没有 syn-* 类
//
// 起浏览器、收控制台/页面错误/失败请求、出截图与 summary.json 都走 ./harness.mjs
// （浏览器二进制在那里探测，不写死 google-chrome）。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openSession, finishSuite } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = 'file://' + join(HERE, 'quiz-code-fixture.html');

let failures = 0;
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!ok) failures++;
}

const session = await openSession({ suite: 'quiz-code', width: 1200, height: 900 });
let v = null;
try {
  const record = await session.scene('quiz-code', async (ctx) => {
    await ctx.navigate(FIXTURE, { settle: 1800 });
    return ctx.evaluate(`(() => {
  const textNodes = (root) => {
    const nodes = [];
    (function rec(el) { for (const c of el.childNodes) { if (c.nodeType === 3) nodes.push(c); else rec(c); } })(root);
    return nodes;
  };
  // 上色会把一行拆进多个 span，按字符建映射再量——否则 indexOf 永远找不到整行。
  // 注意：这段是要传给 Runtime.evaluate 的模板字符串，里面不能有反斜杠转义（模板会先吃掉），
  // 所以换行用 String.fromCharCode(10)，缩进用纯空格正则。
  const NL = String.fromCharCode(10);
  const lineLefts = (root) => {
    const map = [];
    for (const node of textNodes(root)) {
      for (let i = 0; i < node.textContent.length; i++) map.push([node, i]);
    }
    const text = map.map((pair) => pair[0].textContent[pair[1]]).join('');
    const lefts = [];
    let start = 0;
    for (const line of text.split(NL)) {
      const stripped = line.replace(/^ +/, '');
      if (stripped) {
        const at = line.length - stripped.length;
        const pair = map[start + at];
        const r = document.createRange();
        r.setStart(pair[0], pair[1]); r.setEnd(pair[0], pair[1] + 1);
        lefts.push({ text: stripped.slice(0, 22), left: Math.round(r.getBoundingClientRect().left) });
      }
      start += line.length + 1;
    }
    return lefts;
  };

  const q1 = document.getElementById('q1');
  const q2 = document.getElementById('q2');
  const pre = q1.querySelector('.quiz__code');
  const code = pre && pre.querySelector('code');
  const cs = code && getComputedStyle(code);
  return {
    hasPre: !!pre,
    lang: pre && pre.getAttribute('data-lang'),
    codeText: code && code.textContent,
    mono: cs && /mono/i.test(cs.fontFamily),
    weight: cs && cs.fontWeight,
    syn: code ? code.querySelectorAll('[class^="syn-"]').length : 0,
    kw: code ? [...code.querySelectorAll('.syn-keyword')].map((e) => e.textContent) : [],
    lines: code ? lineLefts(code) : [],
    proseBefore: q1.textContent.includes('这段为什么死循环'),
    proseAfter: q1.textContent.includes('① 变量谁没变'),
    q2Code: q2.querySelectorAll('.quiz__code').length,
    q2Text: q2.textContent,
  };
})()`);
  });
  v = record.metrics || {};
} catch (error) {
  // 探测脚本自身报错也算失败：r 是 null 时下面的断言全部落空，原因记进 summary.json
  console.log('FAIL  浏览器套件跑完（浏览器起来、页面能打开、探测脚本不抛错）  — ' + String(error));
  failures++;
  await session.scene('quiz-code-error', async (ctx) => { ctx.note('harness', String(error)); });
}

check('围栏渲染出 .quiz__code', v.hasPre);
check('data-lang=cpp 传到 pre 上', v.lang === 'cpp', String(v.lang));
check('代码原文与缩进一字不动', v.codeText === 'int i = 1;\nwhile (i <= 100) {\n    ++cnt;\n    if (cnt > 9) break;\n}',
      JSON.stringify(v.codeText));
check('代码用等宽字体', v.mono === true);
check('代码不是粗体（不继承题面的 600）', v.weight === '400', String(v.weight));
check('自动上色：出现 syn-* 类', v.syn > 0, `${v.syn} 个`);
check('关键字着色（while/if 等）', v.kw.includes('while') && v.kw.includes('if'), JSON.stringify(v.kw));
{
  const l = v.lines || [];
  const base = l.length ? l[0].left : null;
  const same = l.filter((x) => x.left === base).length;
  const indented = l.filter((x) => x.left > base);
  check('缩进保留：5 行里 3 行顶格、2 行缩进且同一列',
        l.length === 5 && same === 3 && indented.length === 2 && indented[0].left === indented[1].left,
        l.map((x) => `${x.left}:${x.text}`).join(' | '));
}
check('代码块前后的散文都在（没被吞掉）', v.proseBefore && v.proseAfter);
check('没有围栏的题面不产生代码块', v.q2Code === 0, `实际 ${v.q2Code}`);
check('纯散文题面的换行仍保留', v.q2Text.includes('n 是 5。') && v.q2Text.includes('循环体跑几次'));

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
await finishSuite(session, { suite: 'quiz-code', failed: failures });
