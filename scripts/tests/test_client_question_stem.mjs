// 题干的可读性判定（#174）· 不需要浏览器
//
//   node --test scripts/tests/test_client_question_stem.mjs
//
// `lib/client.js` 里 `Question` 组件原来直接 `item.q.split('\n')`：题库里 `q` 缺字段时那个
// `undefined.split` 直接把整个 slot 打掉（宿主记 `slot entry crashed in 'main'`，正文 + 左右栏
// 一起消失，之后点「学习」也重挂不回来，只能刷页）。这条钉住「渲染之前先问一句」的那个判定：
// 什么算读得到、什么算缺、什么算坏类型。
//
// 与 test_client_reading_position.mjs 同一套取法：切出源码标记之间的那段内核，在独立
// realm 里求值，不加载整个 client.js（那需要真 React）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', '..', 'lib', 'client.js');
const BEGIN = '/* -- STUDY_QUESTION_KERNEL_START -- */';
const END = '/* -- STUDY_QUESTION_KERNEL_END -- */';

/** 切出内核原文。标记缺了就地报错——静默截一段空源码去跑，等于什么都没测。 */
function kernelSource() {
  const source = fs.readFileSync(CLIENT, 'utf8');
  const from = source.indexOf(BEGIN);
  const to = source.indexOf(END);
  if (from < 0 || to < 0 || to <= from) throw new Error('lib/client.js 里的题干内核标记找不到了');
  return source.slice(from + BEGIN.length, to);
}

function loadKernel() {
  const context = vm.createContext(Object.create(null));
  const globals = { isFinite, Math, Number, String, Array, Object, JSON };
  for (const [name, value] of Object.entries(globals)) context[name] = value;
  return vm.runInContext(
    kernelSource() + '\n;({ questionStem });',
    context,
    { filename: 'lib/client.js#question-kernel' },
  );
}

const { questionStem } = loadKernel();

test('题干是文本：原样返回，且不算缺', () => {
  const stem = questionStem({ q: '调用时发生的第一件事是什么？' });
  assert.equal(stem.missing, false);
  assert.equal(stem.text, '调用时发生的第一件事是什么？');
});

test('多行题干：换行留着给渲染那边逐行排版', () => {
  const stem = questionStem({ q: '第一段\n第二段' });
  assert.equal(stem.missing, false);
  assert.equal(stem.text.split('\n').length, 2);
});

test('#174 缺字段：q 不存在时算缺，而不是让 undefined 掉进 split', () => {
  assert.equal(questionStem({ opts: ['甲', '乙'], ans: 0 }).missing, true);
  assert.equal(questionStem({}).missing, true);
  // 字段写成了别的名字（题库里「题干写成 stem」这一类）
  assert.equal(questionStem({ stem: '题干写错了字段名' }).missing, true);
});

test('坏类型也算缺：null / 数字 / 对象都不是能排版的东西', () => {
  assert.equal(questionStem({ q: null }).missing, true);
  assert.equal(questionStem({ q: 42 }).missing, true);
  assert.equal(questionStem({ q: { 0: 'a' } }).missing, true);
});

test('空白题干算缺：只有空行时渲染占位，而不是一片空白', () => {
  assert.equal(questionStem({ q: '' }).missing, true);
  assert.equal(questionStem({ q: '   \n \t ' }).missing, true);
  assert.equal(questionStem({ q: ' 有内容 ' }).missing, false);
});

test('连 item 都没有时也不抛', () => {
  assert.equal(questionStem(undefined).missing, true);
  assert.equal(questionStem(null).missing, true);
});
