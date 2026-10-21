/* 验收 #222 · 一门科目读不了，只坏那一门
   ────────────────────────────────────────────────────────────────────────
   真机事故（2026-10-21）：一门科目的 `curriculum.yaml` 写了个裸 `&`（YAML 锚点），
   阅读端整页变成「读不到学习工作区」——一门坏把其余科目一起带走，卡片还把
   「一门坏」说成「工作区没了」，唯一的动作「重试」永远失败。
   数据侧按科目隔离在 `test_host_library_payload.mjs`；这里钉界面：读不了的那门要点得出
   名字与「哪份文件第几行」，好科目照常列出来。
   ───────────────────────────────────────────────────────────────────────── */
import test from 'node:test';
import assert from 'node:assert/strict';

import { clientInternals, renderWithState } from './fixtures/client_harness.mjs';

const { Unreadable, EmptyLibrary, HomePage } = clientInternals();

/** 元素树抠成文本，空白压平便于比对文案（错误里本来就带换行）。 */
const render = (component, props) => renderWithState(component, props).replace(/\s+/g, ' ').trim();

const BROKEN = {
  dir: 'c-language',
  error: 'curriculum.yaml:99:8: 不支持锚点 &\n       &取地址、*引用、空指针、指针运算',
};
const GOOD = { slug: 'demo', name: '演示科目', nodes: [], stats: {} };

test('#222 读不了的科目：点名哪一门、哪份文件第几行、原文是什么，并给重试', () => {
  const text = render(Unreadable, { items: [BROKEN], onRetry: () => {} });
  assert.match(text, /有一门科目读不了/);
  assert.ok(text.includes('c-language'), `没点名是哪一门：${text}`);
  assert.ok(text.includes('curriculum.yaml:99:8'), `没说清哪份文件第几行：${text}`);
  assert.ok(text.includes('不支持锚点'));
  assert.ok(text.includes('&取地址'), `错误里那行原文要原样带出来：${text}`);
  assert.ok(text.includes('重试'));
});

test('#222 多门读不了时报数量；没给重试回调就不塞按钮', () => {
  const text = render(Unreadable, { items: [BROKEN, { dir: 'shape', error: 'nodes 不是列表' }] });
  assert.match(text, /有 2 门科目读不了/);
  assert.equal(text.includes('重试'), false);
});

test('#222 主页：坏的那门挂在提示里，好的科目照常列出来', () => {
  const text = render(HomePage, {
    subjects: [GOOD], unreadable: [BROKEN],
    onSubject: () => {}, onLesson: () => {}, onRetry: () => {},
  });
  assert.ok(text.includes('学习工作台'));
  assert.match(text, /有一门科目读不了/);
  assert.ok(text.includes('演示科目'), `好科目被坏的那门带走了：${text}`);
});

test('#222 主页：没有坏科目时不出提示（正常路径一字没改）', () => {
  const text = render(HomePage, {
    subjects: [GOOD], unreadable: [],
    onSubject: () => {}, onLesson: () => {}, onRetry: () => {},
  });
  assert.equal(text.includes('读不了'), false);
  assert.ok(text.includes('演示科目'));
});

test('#222 一门可用的都没有时：说有哪几门读不了，不说「还没有科目」', () => {
  const text = render(EmptyLibrary, { unreadable: [BROKEN], workspace: '/home/me/StudyMate', onRetry: () => {} });
  assert.match(text, /有一门科目读不了/);
  assert.equal(text.includes('还没有科目'), false, `把「读不了」说成了「还没有科目」：${text}`);
  assert.ok(text.includes('/home/me/StudyMate'), '空态仍要说清读的是哪个工作区');
});

test('#222 真的还没有科目时，照旧说「还没有科目」（空态没被吃掉）', () => {
  const text = render(EmptyLibrary, { unreadable: [], workspace: '/home/me/StudyMate' });
  assert.ok(text.includes('还没有科目'));
  assert.equal(text.includes('读不了'), false);
});
