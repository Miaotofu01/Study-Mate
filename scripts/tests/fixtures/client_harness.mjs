/* 阅读端（`lib/client.js`）的 Node 侧加载器 —— 给「跨科目搜索」这类纯逻辑套件用。
   ────────────────────────────────────────────────────────────────────────
   为什么要这么绕：`lib/client.js` 是**零构建、原样发货**的浏览器插件（`release.mjs` 明说不许
   做打包变换；`package.json` 的 `exports["./client"]` 直接指向它）。它不导出任何东西——
   只调一次 `window.__ModuleLoader__.load({ factory })`，把本体关在工厂闭包里。

   所以想在 Node 里断言工厂里的纯逻辑（索引构建就是纯的），只有两条路：
     1. 给文件加 `export`——那会让宿主按 ESM 加载它，机制直接断（工厂永远不执行）；
     2. **在这里伪造它要的全局**（`window` + 9 个冻结模块里的 `react`），把头文件那段
        「window.__ModuleLoader__.load(...)」跑掉，再取出工厂。
   这份文件走第 2 条。它同时是「client.js 没有偷偷 require 别的模块」的守卫：
   只要它多要一个模块，`require` 桩就会抛错（见下面 RUNTIME_MODULES）。

   **React 是桩**：`useState` 按调用次序从 `setHookState([…])` 取值（不设就取 initial，与
   React 首帧一致），因此套件能把组件驱到某一帧再断言它显示了什么（见 `renderWithState`）。
   `useEffect` 只记一笔不执行（没有 DOM），`useMemo` 真的求值（它是纯的，也正因如此才能在
   Node 里跑）。`viewText` 遇到函数组件就地调它，把元素树展开成文本。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CLIENT_FILE = path.join(ROOT, 'lib', 'client.js');

/** 宿主冻结模块表恰好 9 个键；`lib/client.js` 按插件规范只许用 `react`。 */
const RUNTIME_MODULES = ['react'];

/**
 * React 桩。**有状态**：`setHookState([…])` 按调用次序喂给 `useState`，
 * 用来把组件驱到某一帧（例如把搜索框的 query 设成某个词）。
 * 不设时每个 useState 都拿 initial，与 React 首帧一致。
 */
let hookState = null;
let stateIndex = 0;
let effectCount = 0;

export function setHookState(values) { hookState = values; }
export function resetHookState() { hookState = null; stateIndex = 0; effectCount = 0; }
export function effectRuns() { return effectCount; }

function stubReact() {
  const Fragment = Symbol('react.fragment');
  return {
    Fragment,
    // 与 React 同形：0 个孩子 → undefined，1 个 → 那个孩子本身，多个 → 数组。
    // 别图省事恒返回 children——`h('div', null, '一句话')` 是这里最常见的写法。
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.length <= 1 ? children[0] : children,
    }),
    // 元组形状不能省：`const [x] = useState(…)` 拿到的是**第一个**元素，
    // 桩若返回整个数组，`x` 就成了 `[值, 函数]`，所有 `x.length` 判断都会静默走错分支。
    useState: (initial) => {
      const index = stateIndex++;
      const has = hookState !== null && index < hookState.length;
      return [has ? hookState[index] : (typeof initial === 'function' ? initial() : initial), () => {}];
    },
    // 副作用不执行（没有 DOM），只记一笔跑了几个——`SearchPalette` 靠它把光标送进输入框
    useEffect: () => { effectCount++; },
    // 一律现算：桩不做记忆化，而 useMemo 的求值函数都是纯的
    useMemo: (compute) => compute(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial === undefined ? null : initial }),
  };
}

let cached = null;

/** 加载一次、缓存：每个套件进程里 client.js 只需要跑一遍工厂。 */
export function loadClient() {
  if (cached) return cached;

  const source = fs.readFileSync(CLIENT_FILE, 'utf8');
  const loaded = [];
  // 只接住「注册」这一下：工厂体在客户端是物化时才跑的，这里也照同样的时机调。
  const sandbox = {
    __ModuleLoader__: {
      load: (entry) => loaded.push(entry),
    },
  };

  /* `new Function(…)` 走的是脚本（非模块）语法：`import` / `export` / `import.meta` 一旦出现
     就会在这里抛 SyntaxError。顺手把它翻译成一句人话——client.js 加了 `export`，
     宿主那边是「工厂永远不执行」，比语法错更难查。 */
  const isModuleSyntax = /^\s*(import|export)\s|\bimport\.meta\b/m.test(source);
  if (isModuleSyntax) {
    throw new Error('lib/client.js 出现了 ESM 语法（import / export / import.meta）：'
      + '宿主按 exports["./client"] 把它当浏览器插件加载，加了 export 就不再执行工厂');
  }
  new Function('window', 'document', 'navigator', source)(sandbox, undefined, undefined);
  if (loaded.length !== 1) throw new Error(`lib/client.js 应该恰好注册一次，实际 ${loaded.length} 次`);
  const entry = loaded[0];
  if (typeof entry.factory !== 'function') throw new Error('注册项里没有 factory');

  const requested = [];
  const requireStub = (name) => {
    requested.push(name);
    if (name === 'react') return stubReact();
    throw new Error(`阅读端多要了一个模块：${name}（宿主只冻结 ${RUNTIME_MODULES.join(' / ')}）`);
  };

  const plugin = entry.factory(requireStub);
  cached = { id: entry.id, plugin, requested, source };
  return cached;
}

/**
 * 工厂闭包里的内部件。
 *
 * 怎么取：先往 `globalThis` 放一个回调，再加载 client.js——工厂执行到注册那一段时
 * 会把内部件交给它（见 client.js 的 `__studymate_client_internals` 钩子）。
 * 浏览器里没人设这个全局，所以那一步在真宿主里是空操作。
 * 回调用完立刻删掉，别给后续加载留痕。
 */
export function clientInternals() {
  const key = '__studymate_client_internals';
  const previous = globalThis[key];
  let internals = null;
  globalThis[key] = (value) => { internals = value; };
  try {
    loadClient();
  } finally {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }
  if (!internals) {
    throw new Error('client.js 没有挂出内部件钩子（__studymate_client_internals）——'
      + '搜索套件要断言的纯函数与折叠块渲染函数都在工厂闭包里');
  }
  return internals;
}

/** 把组件驱到某一帧再渲染成文本：`state` 按 useState 的调用次序喂进去。 */
export function renderWithState(component, props, state = []) {
  stateIndex = 0;
  effectCount = 0;
  setHookState(state);
  try {
    return viewText(component(props));
  } finally {
    resetHookState();
  }
}

/**
 * 把一棵元素树里的文本全抠出来，用于断言空态文案。
 *
 * 遇到函数组件就**就地调它**（`type(props)`）——桩不实现渲染，所以只能这样「展开」。
 * 这些组件都只依赖 useState/useEffect 这类返回默认值的桩，调一次是安全的；
 * 顺序上必须先判函数再判 children：函数组件的元素 `children` 恒为 undefined，
 * 先判 children 会一路返回空串（空态断言会因此假通过/假失败）。
 */
export function viewText(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(viewText).join(' ');
  if (typeof node !== 'object') return '';
  if (typeof node.type === 'function') return viewText(node.type(node.props || {}));
  if ('children' in node) return viewText(node.children);
  return '';
}

/**
 * 元素树里按 props 找节点（套件要拿某个按钮的 onClick 时用）。
 *
 * 遍历口径必须与 `viewText` 一致：桩造的节点把子元素放在 `props.children`（不是 `node.children`），
 * 只走 `node.children` 会漏掉深层节点——找出来「一颗按钮都没有」，看起来像面板没渲染，
 * 其实是走错了树。
 */
export function findByProp(node, key, value, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const item of node) findByProp(item, key, value, found);
    return found;
  }
  if (node.props && node.props[key] === value) found.push(node);
  if ('children' in node) findByProp(node.children, key, value, found);
  if (node.props && node.props.children !== undefined) findByProp(node.props.children, key, value, found);
  return found;
}

export const CLIENT_PATH = CLIENT_FILE;
export { ROOT as REPO_ROOT };
