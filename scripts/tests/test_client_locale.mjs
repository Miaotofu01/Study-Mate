import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { loadClient, renderWithState, findByProp } from './fixtures/client_harness.mjs';

function fixture({ delayed = false, broken = false } = {}) {
  let parts;
  globalThis.__studymate_client_internals = value => { parts = value; };
  const instance = loadClient({}).plugin;
  delete globalThis.__studymate_client_internals;
  let active = 'en';
  const dictionaries = new Map(), listeners = new Set(), entries = new Set(), effects = [];
  let writes = 0;
  const pending = [];
  const locale = {
    register(ns, dict) { dictionaries.set(ns, dict); return () => dictionaries.delete(ns); },
    bind: ns => (key, params = {}) => Object.entries(params).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      dictionaries.get(ns)?.[active]?.[key] ?? dictionaries.get(ns)?.en?.[key] ?? key),
    subscribe(fn) { if (broken) throw new Error('fixture subscription unavailable'); listeners.add(fn); return () => listeners.delete(fn); },
    setLocale() { writes++; },
  };
  const ctx = {
    get: name => name === 'locale' && !delayed ? locale : undefined,
    effect(fn) { const off = fn(); if (typeof off === 'function') effects.push(off); return off; },
    inject(names, fn) { if (names.includes('locale')) { if (delayed) pending.push(fn); else fn({ locale, effect: ctx.effect }); } },
    slots: {
      inject(name, fn) { return ctx.effect(fn); },
      register(entry, component) { const row = { entry, component }; entries.add(row); return () => entries.delete(row); },
    },
  };
  instance.apply(ctx);
  return { parts, entries, dictionaries, listeners, writes: () => writes,
    provideLocale() { for (const fn of pending.splice(0)) fn({ locale, effect: ctx.effect }); },
    switchTo(value) { active = value; for (const fn of [...listeners]) fn(); },
    dispose() { for (const off of effects.reverse()) off(); },
  };
}

const subject = { slug: 'sample', name: '中文科目', stats: { 未开始: 1, 学习中: 0, 已学完: 0 }, nodes: [] };
const node = { id: 'n1', title: '中文标题', number: '0001', notes: '原稿 不翻译', tier: '未开始', lesson_md: '' };
const home = f => renderWithState(f.parts.HomePage, { subjects: [subject], unreadable: [], onSubject() {}, onLesson() {} });

test('英文宿主：侧栏入口跟随语言且只有一个入口', () => {
  const f = fixture();
  try {
    const labels = () => [...f.entries].filter(x => x.entry.name === 'sidebar.panellist').map(x => x.entry.label);
    assert.deepEqual(labels(), ['Learning']);
    f.switchTo('zh');
    assert.deepEqual(labels(), ['学习']);
    f.switchTo('en');
    assert.deepEqual(labels(), ['Learning']);
  } finally { f.dispose(); }
});

test('主页/继续/列表翻译，不改三档标识或用户标题', () => {
  const f = fixture();
  try {
    assert.match(home(f), /Learning workspace/);
    const input = { ...subject, nodes: [node], continue_node: node.id };
    const before = JSON.stringify(input);
    const props = { subjects: [input], onSubject() {}, onLesson() {} };
    assert.match(renderWithState(f.parts.HomePage, props), /Start here/);
    assert.match(renderWithState(f.parts.HomePage, props), /Not started/);
    f.switchTo('zh');
    assert.match(renderWithState(f.parts.HomePage, props), /从这里开始/);
    assert.equal(JSON.stringify(input), before);
    assert.match(home(f), /中文科目/);
    assert.equal(f.writes(), 0);
  } finally { f.dispose(); }
});

test('缺课件提示翻译，原稿与科目名原样显示', () => {
  const f = fixture();
  try {
    const text = renderWithState(f.parts.MissingLessonNotice, { subject, node });
    assert.match(text, /This node has no lesson content file yet/);
    assert.match(text, /中文科目/);
    assert.match(text, /原稿 不翻译/);
  } finally { f.dispose(); }
});

test('笔记课程引用操作翻译，仍传精确引用而非显示文案', () => {
  const f = fixture();
  try {
    let selected;
    const props = { workspace: 'synthetic', subject, node, refValue: {}, onNavigate: ref => { selected = ref; } };
    assert.match(renderWithState(f.parts.CoursePreview, props), /Open in learning/);
    const tree = f.parts.CoursePreview(props);
    findByProp(tree, 'data-proto', 'course-ref-open')[0].props.onClick();
    assert.deepEqual(selected, { workspace: 'synthetic', subject: 'sample', node: 'n1', title: '中文标题' });
    assert.equal(f.parts.isAskSessionTitle('答疑 · 中文科目 · 中文标题'), true);
  } finally { f.dispose(); }
});

test('locale 字典/订阅随宿主 effect 清理，不写偏好', () => {
  const f = fixture();
  assert.ok(f.listeners.size > 0);
  f.dispose();
  assert.equal(f.listeners.size, 0);
  assert.equal(f.dictionaries.size, 0);
  assert.equal([...f.entries].filter(x => x.entry.name === 'sidebar.panellist').length, 0);
  assert.equal(f.writes(), 0);
});

test('延迟 locale 到达后翻译，未支持的宿主语言使用宿主英文回退', () => {
  const f = fixture({ delayed: true });
  try {
    assert.match(home(f), /学习工作台/);
    f.provideLocale();
    assert.match(home(f), /Learning workspace/);
    f.switchTo('fr');
    assert.match(home(f), /Learning workspace/);
    assert.equal(f.writes(), 0);
  } finally { f.dispose(); }
});

test('locale 订阅失败不阻止阅读，已注册字典不泄漏', () => {
  const previous = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(message);
  let f;
  try {
    f = fixture({ broken: true });
    assert.match(home(f), /学习工作台/);
    assert.equal(f.dictionaries.has('@yunmiao/studymate/reader'), false);
    assert.equal(warnings.length, 1);
  } finally { console.warn = previous; f?.dispose(); }
});

test('阅读端词典键与占位符成对，英文不含漏译中文，原始诊断不翻译', () => {
  const f = fixture();
  try {
    const { READER_ZH: zh, READER_EN: en } = f.parts;
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
    const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort();
    for (const key of Object.keys(zh)) {
      assert.doesNotMatch(en[key], /[\u3400-\u9fff]/u, key);
      assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key);
    }
    const source = fs.readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');
    for (const [, key] of source.matchAll(/\brt\('([^']+)'/g)) assert.ok(Object.hasOwn(en, key), key);
    const diagnostic = 'curriculum.yaml:99:8: 不支持锚点 &';
    const text = renderWithState(f.parts.Unreadable, { items: [{ dir: '中文目录', error: diagnostic }] });
    assert.match(text, /One subject could not be read/);
    assert.ok(text.includes(diagnostic));
  } finally { f.dispose(); }
});

test('缺少 locale 的旧宿主保留中文与原有 main 注入面', () => {
  let parts;
  globalThis.__studymate_client_internals = value => { parts = value; };
  const { plugin } = loadClient({});
  delete globalThis.__studymate_client_internals;
  const entries = [];
  plugin.apply({ get() {}, slots: { inject: (_, fn) => fn(), register: entry => { entries.push(entry); return () => {}; } } });
  assert.match(renderWithState(parts.HomePage, { subjects: [], onSubject() {}, onLesson() {} }), /学习工作台/);
  assert.equal(entries.find(x => x.name === 'main').locale, undefined);
});
