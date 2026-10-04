// 阅读端「未变即同引用」（#74）—— 直接跑 lib/client.js 里那份**生产代码**。
//
// 这个文件是手写 JS、零构建、没有导出面，所以在 VM 里按宿主的方式物化它
// （`window.__ModuleLoader__.load({id, factory})` → `factory(require)`），
// 再从 QA 缝（`window.__STUDYMATE_QA__`）取到 useLibrary 与合并函数。
//
// 验的是两件事：
//   1. 重取回来的整份 payload 合进 state 时，**没变的顶层键沿用上一轮的引用**
//      （memo 化的视图因此不会被击穿重渲）；
//   2. 推送线真的接上了：onmessage(kind:'changed') → 静默重取一次；别的 kind 不重取；
//      从没连上过就关掉（不给老宿主留一串每几秒重试的请求）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一份最小 payload（现造，ADR-0009）。 */
function payload({ lesson = '# 变量\n', memory = '# 画像\n', extra = false } = {}) {
  const subjects = [
    {
      slug: 'demo', name: '演示', updated_at: '2026-05-06T10:00:00+08:00',
      nodes: [{ id: 'var', title: '变量', lesson_md: lesson, pool: {} }],
    },
    {
      slug: 'other', name: '另一门', updated_at: '2026-05-05T10:00:00+08:00',
      nodes: [{ id: 'fn', title: '函数', lesson_md: '# 函数\n', pool: {} }],
    },
  ];
  if (extra) subjects.push({ slug: 'brand-new', name: '新科目', nodes: [{ id: 'new', title: '新', lesson_md: '# 新\n' }] });
  return { workspace: '/tmp/学习资料', generated_at: '2026-05-06T10:00:00.000Z', today: '2026-05-06', memory_md: memory, subjects };
}

/** 迷你 hook 运行时：只够跑 useLibrary（useState / useCallback / useEffect / useMemo / useRef）。 */
function hooksRuntime() {
  const cells = [];
  let cursor = 0;
  let effects = [];
  const React = {
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; }];
    },
    useCallback(fn) { const index = cursor++; if (!(index in cells)) cells[index] = fn; return cells[index]; },
    useEffect(fn) { const index = cursor++; effects.push({ index, fn }); },
    useMemo(fn) { const index = cursor++; if (!(index in cells)) cells[index] = fn(); return cells[index]; },
    useRef(initial) { const index = cursor++; if (!(index in cells)) cells[index] = { current: initial }; return cells[index]; },
    createElement() { return null; },
    Fragment: Symbol('Fragment'),
  };
  return {
    React,
    /** 渲染一次：返回返回值，加一份「提交后要跑的 effect」清单。 */
    render(component) {
      cursor = 0;
      effects = [];
      const returned = component();
      const list = effects.slice();
      return { returned, runEffects: () => list.map(({ fn }) => fn()) };
    },
    /** 当前 state（useLibrary 的 useState 是第 0 个 hook 单元）。 */
    state: () => cells[0],
  };
}

/** 按宿主的方式物化 lib/client.js，返回 QA 缝与配套的 hook 运行时。 */
function materialize(context) {
  const source = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');
  let registration = null;
  const qa = {};
  const sandbox = {
    console,
    ...context,
    window: {
      __ModuleLoader__: { load(options) { registration = options; } },
      __STUDYMATE_QA__: qa,
    },
  };
  vm.runInNewContext(source, vm.createContext(sandbox), { filename: 'lib/client.js' });
  assert.ok(registration, 'lib/client.js 要通过 window.__ModuleLoader__.load 登记');
  assert.equal(registration.id, '@yunmiao/studymate');
  const runtime = hooksRuntime();
  registration.factory((name) => {
    assert.equal(name, 'react', `只该 require 冻结模块表里的 react，实际要了 ${name}`);
    return runtime.React;
  });
  return { qa, runtime };
}

/** 假的 EventSource：把宿主会回调的那三个口子留给测试自己按。 */
function fakeEventSources(bucket) {
  return function FakeEventSource(url) {
    const source = {
      url, closed: false, onopen: null, onmessage: null, onerror: null,
      close() { this.closed = true; },
    };
    bucket.push(source);
    return source;
  };
}

test('顶层键逐个比较：没变的沿用上一轮的对象，变了的才换引用', () => {
  const { qa } = materialize({});
  const merge = qa.mergeLibraryData;
  assert.equal(typeof merge, 'function');

  const before = payload();
  // ① 完全没变（重取回来的是另一份**内容相同**的对象）
  const same = merge(before, JSON.parse(JSON.stringify(before)));
  for (const key of Object.keys(before)) {
    assert.equal(same[key], before[key], `顶层键 ${key} 没变就该沿用上一轮的引用`);
  }

  // ② 改了一个课件：subjects 换了新数组，但里面的**另一个科目**仍是同一个对象
  const after = payload({ lesson: '# 变量（改过）\n' });
  const merged = merge(before, after);
  assert.notEqual(merged.subjects, before.subjects, 'subjects 真的变了，要换引用');
  assert.equal(merged.subjects[0], after.subjects[0], '变了的科目用新对象');
  assert.equal(merged.subjects[1], before.subjects[1], '没变的科目沿用上一轮的对象（科目页的 memo 不击穿）');
  assert.equal(merged.memory_md, before.memory_md, '共享记忆没变，沿用旧引用');
  assert.equal(merged.workspace, before.workspace);
  assert.equal(merged.today, before.today);

  // ③ 只改了共享记忆：整个 subjects 数组沿用旧引用（主页/科目页一行都不重算）
  const memoryOnly = payload({ memory: '# 画像（改过）\n' });
  const mergedMemory = merge(before, memoryOnly);
  assert.equal(mergedMemory.subjects, before.subjects, '科目没变：整个数组同引用');
  assert.equal(mergedMemory.memory_md, memoryOnly.memory_md);

  // ④ 新建一个科目：老科目保持同引用，新科目进数组
  const grown = merge(before, payload({ extra: true }));
  assert.equal(grown.subjects.length, 3);
  assert.equal(grown.subjects[0], before.subjects[0]);
  assert.equal(grown.subjects[1], before.subjects[1]);
  assert.equal(grown.subjects[2].slug, 'brand-new');

  // ⑤ 首次加载 / 出错重试：没有上一轮可沿用，原样用新数据
  assert.equal(merge(null, after), after);
  assert.equal(merge(undefined, after), after);
});

test('推送接上了：changed 触发静默重取，重取后引用按上面的规则沿用', async () => {
  const sources = [];
  let response = payload();
  let fetchCount = 0;
  const { qa, runtime } = materialize({
    fetch: async () => { fetchCount += 1; return { ok: true, status: 200, json: async () => response }; },
    EventSource: fakeEventSources(sources),
  });

  const rendered = runtime.render(qa.useLibrary);
  assert.equal(rendered.returned[0].status, 'loading');
  const cleanups = rendered.runEffects();
  assert.equal(sources.length, 1, '订阅推送的 effect 起了 EventSource');
  assert.equal(sources[0].url, '/api/studymate/events');

  await sleep(20);
  assert.equal(fetchCount, 1, '挂载那一次 fetch');
  const first = runtime.state();
  assert.equal(first.status, 'ready');
  const firstData = first.data;
  assert.equal(firstData.subjects.length, 2);

  // 首次连上：不补重取（挂载的 fetch 已经拿到当下数据）
  sources[0].onopen();
  await sleep(20);
  assert.equal(fetchCount, 1, '首次 onopen 不重复请求');

  // 内容变了 → changed 通知 → 静默重取
  response = payload({ lesson: '# 变量（改过）\n' });
  sources[0].onmessage({ data: JSON.stringify({ kind: 'changed', domains: ['lesson'], at: '2026-05-06T10:00:01.000Z', seq: 1 }) });
  await sleep(20);
  assert.equal(fetchCount, 2, '收到 changed 要重取一次');
  const second = runtime.state();
  assert.equal(second.status, 'ready');
  assert.notEqual(second.data, firstData, '整份 data 是新对象');
  assert.equal(second.data.subjects[0].nodes[0].lesson_md, '# 变量（改过）\n', '改动真的进来了');
  assert.equal(second.data.subjects[1], firstData.subjects[1], '没变的科目沿用上一轮的对象 —— memo 化的科目页不重算');
  assert.equal(second.data.memory_md, firstData.memory_md, '共享记忆沿用旧引用');

  // 别的 kind / 坏数据：不重取
  sources[0].onmessage({ data: JSON.stringify({ kind: 'ready' }) });
  sources[0].onmessage({ data: '这不是 JSON' });
  await sleep(20);
  assert.equal(fetchCount, 2);

  // 断线重连（第二次 onopen）：补一次对账重取——重连期间的改动不会有补发
  sources[0].onopen();
  await sleep(20);
  assert.equal(fetchCount, 3, '重连成功要对一次账');

  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
  assert.equal(sources[0].closed, true, '卸载时要关掉 EventSource');
});

test('从没连上过就 onerror：关掉 EventSource，不给老宿主留一串重试', () => {
  const sources = [];
  const { qa, runtime } = materialize({
    fetch: async () => ({ ok: true, status: 200, json: async () => payload() }),
    EventSource: fakeEventSources(sources),
  });
  const cleanups = runtime.render(qa.useLibrary).runEffects();
  assert.equal(sources.length, 1);
  sources[0].onerror();
  assert.equal(sources[0].closed, true);
  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
});
