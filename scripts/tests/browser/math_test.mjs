// 在真实浏览器里验公式排版：node scripts/tests/browser/math_test.mjs
//
// 为什么要有这一条：渲染器与检查器只能保证"语法对、引用在"，**排不排得出来只有浏览器知道**——
// KaTeX 加载失败、字体路径写错、lesson-math.js 的顺序不对（先跑后加载），页面都会安静地
// 显示 TeX 原文。这条断言的就是"真的排出来了"。
//
// 起浏览器、收控制台/页面错误/失败请求、出截图与 summary.json 都走 ../browser/harness.mjs
// （浏览器二进制在那里探测，不写死 google-chrome）。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openSession, finishSuite } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = 'file://' + join(HERE, 'math-fixture.html');

let failures = 0;
let total = 0;

function check(label, ok, detail = '') {
  total += 1;
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}

const session = await openSession({ suite: 'math', width: 1000, height: 900 });
try {
  await session.scene('math', async (ctx) => {
    await ctx.navigate(FIXTURE, { settle: 1500 });   // 等 defer 脚本跑完、KaTeX 排版完成

    const out = await ctx.evaluate(`(() => {
      const out = {};
      out.katexNodes = document.querySelectorAll('.katex').length;
      out.inlineRendered = !!document.querySelector('.math-inline .katex');
      out.blockDisplay = !!document.querySelector('.math-block .katex-display');
      out.inlineHasDisplay = !!document.querySelector('.math-inline .katex-display');
      const first = document.querySelector('.math-inline .katex');
      out.fontFamily = first ? getComputedStyle(first).fontFamily : '';
      out.errorShown = !!document.querySelector('.katex-error');
      out.tailText = document.body.textContent.includes('后面这段正常文字还要在');
      // 题目里的公式：由 quiz.js 建块时插入，所以这里验的是「运行时插进来的也被排了」
      out.quizBuilt = !!document.querySelector('.quiz__q');
      out.quizMath = document.querySelectorAll('.quiz__q .math-inline').length;
      out.quizRendered = document.querySelectorAll('.quiz__q .katex').length;
      out.optRendered = document.querySelectorAll('.quiz__opt .katex').length;
      // 选项点开后解析里的公式
      const wrong = [...document.querySelectorAll('.quiz__opt')].pop();
      if (wrong) wrong.click();
      out.whyRendered = document.querySelectorAll('.feedback .katex').length;
      return out;
    })()`);

    check('行内公式真的排出来了（.math-inline 里有 .katex）', out.inlineRendered, JSON.stringify(out));
    check('块级公式走 display 模式（.math-block 里有 .katex-display）', out.blockDisplay, JSON.stringify(out));
    check('行内公式不是 display 模式', !out.inlineHasDisplay, JSON.stringify(out));
    check('KaTeX 样式生效（字体族是 KaTeX_*）', /KaTeX_/.test(out.fontFamily), out.fontFamily);
    check('两处以上公式都排了（不是只处理第一个）', out.katexNodes >= 3, `katex 节点 ${out.katexNodes}`);
    check('写错的公式按错误显示、不炸整页', out.errorShown && out.tailText, JSON.stringify(out));
    check('题目建块了（quiz.js 跑到）', out.quizBuilt, JSON.stringify(out));
    check('题面里的公式也排出来了（运行时插入的）', out.quizRendered >= 1, JSON.stringify(out));
    check('选项里的公式排出来了', out.optRendered >= 2, JSON.stringify(out));
    check('点选后解析里的公式排出来了', out.whyRendered >= 1, JSON.stringify(out));
    return { katexNodes: out.katexNodes, fontFamily: out.fontFamily };
  });
} catch (error) {
  check('浏览器套件跑完（浏览器起来、页面能打开）', false, String(error));
}

console.log(failures ? `\n${total - failures}/${total} 通过` : `\n${total}/${total} 通过`);
await finishSuite(session, { suite: 'math', failed: failures });
