// 在真实浏览器里跑代码块高亮的断言：node scripts/tests/browser/hl_test.mjs
//
// 起浏览器、收控制台/页面错误/失败请求、出截图与 summary.json 都走 ./harness.mjs
// （浏览器二进制在那里探测，不写死 google-chrome）。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openSession, finishSuite } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const FIXTURE = 'file://' + join(HERE, 'highlight-fixture.html');

const probe = `(() => {
  const syn = (sel) => Array.from(document.querySelectorAll(sel + ' .syn-keyword, ' + sel + ' .syn-string, ' + sel + ' .syn-type, ' + sel + ' .syn-func, ' + sel + ' .syn-comment, ' + sel + ' .syn-number, ' + sel + ' .syn-macro, ' + sel + ' .syn-operator'));
  const texts = (sel, cls) => Array.from(document.querySelectorAll(sel + ' .' + cls)).map(e => e.textContent);
  return {
    b1: texts('#b1', 'syn-keyword').concat(texts('#b1', 'syn-type')),
    b1num: document.querySelectorAll('#b1 .syn-number').length,
    b1comment: texts('#b1', 'syn-comment').length,
    b2func: texts('#b2', 'syn-func'),
    b2comment: texts('#b2', 'syn-comment'),
    b2op: texts('#b2', 'syn-operator'),
    b2var: texts('#b2', 'syn-type'),
    b3kw: texts('#b3', 'syn-keyword'),
    b3warn: texts('#b3', 'syn-macro'),
    b3file: texts('#b3', 'syn-func'),
    b4count: syn('#b4').length,
    b5kw: texts('#b5', 'syn-type').concat(texts('#b5', 'syn-keyword')),
    b5comment: texts('#b5', 'syn-comment').length,
    b6spans: document.querySelectorAll('#b6 [class^="syn-"]').length,
    b6text: document.querySelector('#b6 .line').textContent,
    b7: texts('#b7', 'syn-func').concat(texts('#b7', 'syn-operator')),
    b8count: syn('#b8').length,
    b9: texts('#b9', 'syn-func').concat(texts('#b9', 'syn-comment')),
    b10: texts('#b10', 'syn-type').concat(texts('#b10', 'syn-string')),
    b11func: texts('#b11', 'syn-func'),
    b11macro: texts('#b11', 'syn-macro'),
    b12func: texts('#b12', 'syn-func'),
    b13count: syn('#b13').length,
    b14count: syn('#b14').length,
    b15kw: texts('#b15', 'syn-keyword'),
    b16: texts('#b16', 'syn-type').concat(texts('#b16', 'syn-func'), texts('#b16', 'syn-string')),
    b17key: texts('#b17', 'syn-func'),
    b17kw: texts('#b17', 'syn-keyword'),
    b18kw: texts('#b18', 'syn-keyword'),
    b19kw: texts('#b19', 'syn-keyword'),
    b19type: texts('#b19', 'syn-type'),
    b19string: texts('#b19', 'syn-string'),
    b19comment: texts('#b19', 'syn-comment'),
    b19func: texts('#b19', 'syn-func'),
    b19num: document.querySelectorAll('#b19 .syn-number').length,
    b20string: texts('#b20', 'syn-string'),
    b20comment: document.querySelectorAll('#b20 .syn-comment').length,
    b11html: document.querySelector('#b11 code').innerHTML,
    textIntact: document.querySelector('#b2 code').textContent.indexOf('mkdir -p ~/cpp && cd ~/cpp') === 0,
    noNul: document.body.innerHTML.indexOf('\\u0000') === -1,
  };
})()`;

const session = await openSession({ suite: 'hl', width: 1000, height: 900 });
let r = null;
try {
  const record = await session.scene('hl', async (ctx) => {
    await ctx.navigate(FIXTURE, { settle: 1500 });
    return ctx.evaluate(probe);
  });
  r = record.metrics;
} catch (error) {
  // 页面没开起来时 r 是 null：断言表整个不建，直接算一条失败，原因也记进 summary.json
  console.log('FAIL  浏览器套件跑完（浏览器起来、页面能打开）  — ' + String(error));
  await session.scene('hl-error', async (ctx) => { ctx.note('harness', String(error)); });
}

const checks = r ? [
  ['cpp：关键字/类型着色（int 出现≥5 次）', r.b1.filter((t) => ['int', 'double', 'for', 'return'].includes(t)).length >= 5],
  ['cpp：数字着色', r.b1num >= 4],
  ['cpp：注释着色', r.b1comment >= 1],
  ['sh：命令行着色', r.b2func.includes('mkdir') && r.b2func.includes('g++') && r.b2func.includes('./hello')],
  ['sh：行内注释着色', r.b2comment.some((t) => t.startsWith('#'))],
  ['sh：选项着色', r.b2op.includes('-o')],
  ['sh：变量着色', r.b2var.includes('$PATH')],
  ['term：error 着色', r.b3kw.includes('error')],
  ['term：warning 着色', r.b3warn.includes('warning')],
  ['term：文件名:行:列 着色', r.b3file.includes('hello.cpp:5:40')],
  ['普通输出不动（0 个 span）', r.b4count === 0],
  ['编辑器块自动着色', r.b5kw.includes('int') && r.b5comment === 1],
  ['手写高亮块跳过（仍是 1 个 span）', r.b6spans === 1],
  ['手写块文字未被破坏', r.b6text.includes('expected')],
  ['data-lang 生效', r.b7.includes('npm') || r.b7.length > 0],
  ['data-lang=text 不上色', r.b8count === 0],
  ['纯文本没被改动（连字符没被吃）', r.textIntact],
  ['没有占位符残留', r.noNul],
  ['sh：未在命令表里的行也认得出（hello / ./hello）', r.b9.includes('hello') && r.b9.some((t) => t.startsWith('#'))],
  ['cpp：片段（无 include）也认得出', r.b10.includes('cout') && r.b10.some((t) => t.includes('Hello'))],
  ['sh：&& 后面的命令也着色', r.b11func.includes('mkdir') && r.b11func.includes('cd') && r.b11func.includes('cat')],
  ['sh：混合命令 && 着色', r.b12func.includes('g++') && r.b12func.includes('./hello')],
  ['程序输出不动', r.b13count === 0],
  ['题面文字不动', r.b14count === 0],
  ['js 认得出', r.b15kw.includes('const')],
  ['html：标签名/属性/属性值着色', r.b16.includes('nav') && r.b16.includes('class') && r.b16.includes('"syo-nav"')],
  ['json：键着色', r.b17key.includes('"name"')],
  ['json：字面量着色', r.b17kw.includes('true')],
  ['ts：interface 着色', r.b18kw.includes('interface')],
  ['python：关键字着色', r.b19kw.includes('import') && r.b19kw.includes('def') && r.b19kw.includes('return')],
  ['python：内置名着色', r.b19type.includes('print')],
  ['python：字符串与 docstring 着色', r.b19string.some((s) => s.includes('int16')) && r.b19string.some((s) => s.includes('整体提亮'))],
  ['python：注释着色', r.b19comment.some((s) => s.startsWith('#'))],
  ['python：函数名着色', r.b19func.includes('brighten') && r.b19func.includes('clip')],
  ['python：数字着色', r.b19num >= 3],
  ['python：前缀三引号整块算字符串（块内 # 不是注释）', r.b20comment === 0 && r.b20string.some((s) => s.includes('digits'))],
  ['python：多行 f-string 的字符串体也上色', r.b20string.some((s) => s.includes('bye {name}'))],
] : [];

let bad = r ? 0 : 1;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\n${checks.length - bad}/${checks.length} 通过`);
if (bad) console.log('detail:', JSON.stringify(r));

await finishSuite(session, { suite: 'hl', failed: bad });
