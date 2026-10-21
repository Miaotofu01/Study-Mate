/* 阅读端字号四档：顶栏那个下拉框 + 它写进浏览器本地偏好的那一步。
   ────────────────────────────────────────────────────────────────────────────────
   为什么要一条会失败的测试：这一层坏起来全是**静默**的——
     · 下拉框选了「特大」，界面还是 15px（data-fs 没接到根节点，或 token 覆盖块没命中）；
     · 换台机器就回到默认档（localStorage 的键名/取值写岔了，谁也不报错）；
     · 存进去一个界面不认识的档位（旧版本留下的值），下次打开直接落到 undefined 档。
   所以判据钉在「组件交出了什么」和「CSS 有没有那一档」两处，而不是靠人眼看字号。

   口径：
     · 四档取值只有一份真相（FONT_LEVELS）；CSS 的 data-fs 块必须逐档对得上
       ——那一条在 test_client_pure.mjs 里，这里管组件与持久化。
     · 坏值一律退回 medium：宁可回到默认档，也不要一个不存在的档。
     · 字号档的 select **不带** .smb-select 类：浏览器套件拿那个类名单选动效档。
*/
import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';

import { clientInternals, findByProp, CLIENT_PATH } from './fixtures/client_harness.mjs';

const I = clientInternals();
const { FontPicker, FONT_LEVELS, FONT_LABELS, FONT_BODY_PX, readFont, FONT_KEY } = I;

/** 把 FontPicker 渲染一次，返回它的元素树。 */
function render(level, onPick = () => {}) {
  return FontPicker({ level, onPick });
}

test('四档与标签、正文字号对得上', () => {
  assert.deepEqual([...FONT_LEVELS], ['small', 'medium', 'large', 'xlarge']);
  for (const level of FONT_LEVELS) {
    assert.equal(typeof FONT_LABELS[level], 'string', `${level} 档没有标签`);
    assert.equal(typeof FONT_BODY_PX[level], 'number', `${level} 档没有正文字号`);
  }
});

test('下拉框把四个档位都摆出来，当前档回填', () => {
  const tree = render('large');
  const [select] = findByProp(tree, 'className', 'smb-fsselect');
  assert.ok(select, '找不到字号档的 select');
  assert.equal(select.props.value, 'large', '没有把当前档位回填到 select 上');

  const options = findByProp(tree, 'key', 'xlarge');
  assert.equal(options.length, 1, '四个选项里少了「特大」');
  assert.equal(options[0].props.value, 'xlarge');

  const values = findByProp(tree, 'className', 'smb-fsselect')
    .flatMap((node) => (Array.isArray(node.children) ? node.children : [node.children]))
    .map((option) => option.props.value);
  assert.deepEqual(values, [...FONT_LEVELS], '四个选项与 FONT_LEVELS 不一致');
});

test('选了某一档就把档位名交给上层（不做二次映射）', () => {
  const seen = [];
  const tree = render('medium', (next) => seen.push(next));
  const [select] = findByProp(tree, 'className', 'smb-fsselect');
  assert.ok(select, '找不到字号档的 select');
  select.props.onChange({ target: { value: 'xlarge' } });
  assert.deepEqual(seen, ['xlarge'], 'change 事件没有把档位名原样交出去');
});

test('字号档的 select 不占用 .smb-select（浏览器套件拿它单选动效档）', () => {
  const tree = render('medium');
  assert.equal(findByProp(tree, 'className', 'smb-select').length, 0,
    '字号档的 select 带了 .smb-select：reading_test.mjs 的动效档单选会选中它');
  assert.equal(findByProp(tree, 'className', 'smb-fsselect').length, 1);
});

/**
 * readFont 读的是**工厂闭包里那个 window**（宿主注入的沙箱），不是 globalThis。
 * 所以要给它换 storage，只能自己把源码再跑一遍、喂一个带 localStorage 的 window。
 * React 桩只留工厂顶层求值要用到的几个 API（与 client_harness.mjs 同口径）。
 */
const reactStub = () => ({
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.length <= 1 ? children[0] : children }),
  Fragment: Symbol('react.fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
});

function internalsWith(storage) {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  const loaded = [];
  const sandbox = { __ModuleLoader__: { load: (entry) => loaded.push(entry) }, localStorage: storage };
  new Function('window', 'document', 'navigator', source)(sandbox, undefined, undefined);
  let internals = null;
  globalThis.__studymate_client_internals = (value) => { internals = value; };
  try {
    loaded[0].factory((name) => {
      if (name !== 'react') throw new Error('阅读端多要了一个模块：' + name);
      return reactStub();
    });
  } finally {
    delete globalThis.__studymate_client_internals;
  }
  assert.ok(internals, '没有拿到工厂闭包里的内部件');
  return internals;
}

test('读本地偏好：没存过 / 存了坏值都退回 medium', () => {
  const store = new Map();
  const withStore = internalsWith({ getItem: (key) => (store.has(key) ? store.get(key) : null) });
  assert.equal(withStore.readFont(), 'medium', '没存过的时候不是默认档');
  store.set(withStore.FONT_KEY, 'xlarge');
  assert.equal(withStore.readFont(), 'xlarge', '存过的档位没读回来');
  store.set(withStore.FONT_KEY, '半档');
  assert.equal(withStore.readFont(), 'medium', '坏值没有退回默认档');
});

test('读不到 localStorage（无痕模式）也不崩，退回默认档', () => {
  const broken = internalsWith(undefined);
  assert.equal(broken.readFont(), 'medium', '没有 localStorage 时应该安静地退回默认档');
});
