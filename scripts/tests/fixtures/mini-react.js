/* 迷你 React：**只够跑 StudyMate 阅读端**的小渲染器，给浏览器 QA 的夹具页用。
   ────────────────────────────────────────────────────────────────────────────────
   为什么要有它：`lib/client.js` 是零构建的手写插件，它只从宿主的冻结模块表里拿
   `react`。QA 夹具里没有宿主，也没有 React（仓库不装 react，宿主那份是打包进 bundle 的），
   而我们要跑的是**真的 lib/client.js**——不是把标记抄一份到夹具里（那样两份立刻漂移）。

   所以写一个够用的替身，覆盖插件实际用到的那一面（`grep` 过：只用
   createElement / Fragment + useState/useEffect/useMemo/useRef/useCallback）：
     · createElement 只造普通对象，不求值函数组件；
     · 渲染两遍走：vdom → DOM；hook 状态按「组件在树里的位置」存；
     · setState 触发**整树重建**（不 diff、不调度）——夹具只求「渲染得出来、属性断言得到」；
     · ref 对象在挂载时赋 .current，effect 在 DOM 挂好之后按顺序跑（deps 变了才重跑）。

   够用就行的边界（写清楚，免得后来人以为它能当 React 使）：
     · 没有 key diff：每次重建 DOM 全部换新。**后果**：把 DOM 节点闭在 effect 里、之后
       还去量它的代码（路线图的 ResizeObserver → draw()）在重建后量到的是旧节点。
       真 React 里节点不换，所以那段代码本身是对的——夹具因此不断言路线图**连线几何**，
       只断言元素与属性（aria-label / 视觉隐藏的 table / 卡片）。
       **一处例外**：真 React 不碰「自己没渲染过子节点」的元素的内部，所以客户端用
       `ref` + `innerHTML` 贴进去的内容（`SvgFrame` 的内联 SVG 就是这么贴的）在真 React 里
       重渲染后还在。重建式渲染会把这份内容连同旧节点一起丢掉，于是夹具里那个图框
       **下一次重渲染就变空壳**——那是夹具与真货的差别，会让「客户端产出的内联 SVG」这类面
       看着像坏的（#97 报的就是这条）。`draw()` 因此把**无 React 子节点**的元素的 `innerHTML`
       按路径带到重建后的同位置元素上。`MathSpan` 那条路（`dangerouslySetInnerHTML`）不算：
       它的内容由 props 每次渲染，搬旧值过去只会把新值盖掉。
     · 状态槽按「位置 + 组件函数」认实例，换视图时同位置换组件不会串槽
       （只按位置会串：踩过，路线图量到了上一个视图的旧 DOM）。
     · 没有 useLayoutEffect / context / portal / Suspense / 错误边界；
     · 事件只挂 on* 直连（onClick / onChange / onKeyDown / onDoubleClick / onPointerDown）。
*/
(function (global) {
  const Fragment = Symbol('Fragment');
  const SVG = new Set(['svg', 'path', 'defs', 'marker', 'g', 'circle', 'rect', 'line', 'polyline', 'text', 'tspan', 'use']);
  // React 的 SVG 属性名大多保持原样（viewBox/refX/markerWidth 都是），只有这几个要转连字符
  const SVG_ATTR = {
    strokeWidth: 'stroke-width', strokeOpacity: 'stroke-opacity', strokeLinejoin: 'stroke-linejoin',
    strokeLinecap: 'stroke-linecap', fillOpacity: 'fill-opacity', markerEnd: 'marker-end',
    markerStart: 'marker-start', clipPath: 'clip-path', strokeDasharray: 'stroke-dasharray',
  };
  const ALIAS = { className: 'class', htmlFor: 'for', tabIndex: 'tabindex', readOnly: 'readonly', maxLength: 'maxlength' };

  const hooksByPath = new Map();   // 组件实例键 → hook 槽数组
  const TYPE_IDS = new WeakMap();
  let typeSeq = 0;
  let slots = null;                // 当前组件的槽数组
  let cursor = 0;                  // 当前组件的 hook 游标
  let pendingEffects = [];
  let root = null;
  let vnode = null;
  let queued = false;

  /**
   * 组件实例键 = 树里的位置 + 组件函数本身。
   *
   * **只按位置是不行的**：阅读端换视图时（主页 → 科目页 → 课件页）同一个位置会换一个
   * 完全不同的组件，两份 hook 槽会被搅在一起——踩过：路线图的 useState/useRef 拿到了
   * 别的组件的槽，于是 draw() 量的是上一个视图里已经卸载的旧 DOM（全是 0），
   * 连线就画成 M 0 0 C 0 0。函数身份一起进键就不会串。
   */
  function typeKey(type) {
    if (!TYPE_IDS.has(type)) TYPE_IDS.set(type, 'c' + (++typeSeq));
    return TYPE_IDS.get(type);
  }

  function text(value) {
    if (value === null || value === undefined || value === false || value === true) return null;
    if (typeof value === 'object') return value;
    return { text: String(value) };
  }

  function createElement(type, props, ...children) {
    const flat = [];
    const push = (kid) => {
      if (Array.isArray(kid)) { kid.forEach(push); return; }
      const node = text(kid);
      if (node) flat.push(node);
    };
    children.forEach(push);
    return { type, props: props || {}, children: flat };
  }

  function normalize(out) {
    if (Array.isArray(out)) return { type: Fragment, props: {}, children: out.map(text).filter(Boolean) };
    const node = text(out);
    return node || { text: '' };
  }

  /** 子节点的位置键：有 key 用 key，没有用下标——同一次会话里位置稳定就够了。 */
  function childPath(path, kid, index) {
    const key = kid && kid.props && kid.props.key;
    return path + '/' + (key !== undefined && key !== null ? 'k' + key : 'i' + index);
  }

  function schedule() {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => { queued = false; draw(); });
  }

  /* ── hooks ─────────────────────────────────────────────────────────────── */

  function slot() {
    if (!slots) throw new Error('hook 在组件外被调用');
    if (!slots[cursor]) slots[cursor] = {};
    return slots[cursor++];
  }

  function useState(init) {
    const cell = slot();
    if (!('value' in cell)) cell.value = typeof init === 'function' ? init() : init;
    if (!cell.set) {
      cell.set = (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next;
        if (Object.is(value, cell.value)) return;
        cell.value = value;
        schedule();
      };
    }
    return [cell.value, cell.set];
  }

  function useEffect(fn, deps) {
    const cell = slot();
    const prev = cell.deps;
    const same = prev && deps && prev.length === deps.length && prev.every((one, i) => Object.is(one, deps[i]));
    if (same) return;
    cell.deps = deps ? deps.slice() : null;
    cell.run = fn;
    pendingEffects.push(cell);
  }

  function useMemo(fn, deps) {
    const cell = slot();
    const prev = cell.deps;
    const same = prev && deps && prev.length === deps.length && prev.every((one, i) => Object.is(one, deps[i]));
    if (!same) { cell.value = fn(); cell.deps = deps ? deps.slice() : null; }
    return cell.value;
  }

  function useCallback(fn, deps) {
    return useMemo(() => fn, deps);
  }

  function useRef(init) {
    const cell = slot();
    if (!('value' in cell)) cell.value = { current: init };
    return cell.value;
  }

  function commitEffects() {
    const list = pendingEffects;
    pendingEffects = [];
    for (const cell of list) {
      if (cell.cleanup) { try { cell.cleanup(); } catch (error) { report(error); } cell.cleanup = null; }
    }
    for (const cell of list) {
      const fn = cell.run;
      cell.run = null;
      if (!fn) continue;
      try {
        const out = fn();
        if (typeof out === 'function') cell.cleanup = out;
      } catch (error) { report(error); }
    }
  }

  function report(error) {
    // 抛给页面：harness 收集的 Runtime.exceptionThrown 会把它算成场景问题
    console.error('[mini-react] effect 抛错：' + (error && error.message));
  }

  /* ── 渲染 ──────────────────────────────────────────────────────────────── */

  function applyProps(el, props) {
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (key === 'key' || key === 'children' || value === null || value === undefined) continue;
      if (key === 'ref') {
        // **回调 ref 也要认**（React 两种都支持）：阅读端把正文滚动区挂成回调 ref
        // （`useReadingPosition` 的 attach，lib/client.js 的 .smb-center__body），它顺手记下
        // `bodyRef.current` —— 问答引用的捕获（#92）就靠这个节点判「选区在不在正文里」。
        // 只认对象 ref 的话 `bodyRef.current` 恒为 null，引用永远捕不到，看上去像客户端坏了。
        // 夹具每次重渲染整树重建，所以每次都会拿新节点调一次——真 React 只在挂载/卸载时调，
        // 而这里没有卸载那一半（draw() 直接换掉整棵树），`attach(null)` 那条清理路径不会跑到。
        if (typeof value === 'function') value(el);
        else if (value && typeof value === 'object') value.current = el;
        continue;
      }
      if (key === 'style' && typeof value === 'object') {
        for (const name of Object.keys(value)) el.style[name] = value[name];
        continue;
      }
      if (key === 'value') { el.value = value; continue; }
      if (key === 'checked') { el.checked = !!value; continue; }
      // 原样透传一段 HTML（React 的那个 prop）：阅读端用它把 KaTeX 的输出放进公式容器里
      // （#91）。不认这个 prop 的话，公式容器在夹具里会是一片空白——而真实 React 里有内容，
      // 这种「夹具与真货不一样」的差别正是套件最该避免的假绿。
      if (key === 'dangerouslySetInnerHTML') { el.innerHTML = (value && value.__html) || ''; continue; }
      if (key.length > 2 && key.startsWith('on') && key[2] === key[2].toUpperCase() && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
        continue;
      }
      const name = SVG_ATTR[key] || ALIAS[key] || key;
      if (value === false) { el.removeAttribute(name); continue; }
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }

  function renderVNode(node, path, parent) {
    if (!node) return;
    if (node.text !== undefined) { parent.appendChild(document.createTextNode(node.text)); return; }
    const { type, props, children } = node;
    if (type === Fragment) {
      children.forEach((kid, index) => renderVNode(kid, childPath(path, kid, index), parent));
      return;
    }
    if (typeof type === 'function') {
      const key = path + '@' + typeKey(type);
      if (!hooksByPath.has(key)) hooksByPath.set(key, []);
      const savedSlots = slots;
      const savedCursor = cursor;
      slots = hooksByPath.get(key);
      cursor = 0;
      let out;
      try { out = type(props); } finally { slots = savedSlots; cursor = savedCursor; }
      renderVNode(normalize(out), key + '#', parent);
      return;
    }
    const el = SVG.has(type)
      ? document.createElementNS('http://www.w3.org/2000/svg', type)
      : document.createElement(type);
    // 「无 React 子节点」= 真 React 不会去动这个元素的内部（见文件头那处例外）。
    // 路径与这份标记留给 draw() 的重建搬运用；有 dangerouslySetInnerHTML 的不算——
    // 那份内容由 props 每次渲染，搬旧值过去只会把新值盖掉。
    el.__miniPath = path;
    el.__miniLeaf = children.length === 0 && !(props && props.dangerouslySetInnerHTML);
    applyProps(el, props);
    children.forEach((kid, index) => renderVNode(kid, childPath(path, kid, index), el));
    parent.appendChild(el);
  }

  function draw() {
    if (!root || !vnode) return;
    pendingEffects = [];
    // 先收下「客户端用 innerHTML 贴进无子节点元素」的那份内容：重建会把旧节点整棵丢掉，
    // 而 effect 只在 deps 变化时重跑，收不到它就等于夹具凭空把内联 SVG 抹掉（见文件头）。
    const carried = new Map();
    root.querySelectorAll('*').forEach((el) => {
      if (el.__miniLeaf && el.innerHTML) carried.set(el.__miniPath, { tag: el.tagName, html: el.innerHTML });
    });
    const next = document.createDocumentFragment();
    renderVNode(vnode, 'root', next);
    root.textContent = '';
    root.appendChild(next);
    if (carried.size) {
      root.querySelectorAll('*').forEach((el) => {
        // 只补空的：有内容的（dangerouslySetInnerHTML 渲出来的）本来就是对的那份
        if (!el.__miniLeaf || el.innerHTML) return;
        const one = carried.get(el.__miniPath);
        if (one && one.tag === el.tagName) el.innerHTML = one.html;
      });
    }
    commitEffects();
  }

  function mount(node, container) {
    vnode = node;
    root = container;
    draw();
  }

  global.MiniReact = {
    createElement, Fragment, useState, useEffect, useMemo, useCallback, useRef, mount,
    /** 清掉所有 hook 槽与 effect（套件里换株重挂时用）。 */
    reset() { hooksByPath.clear(); pendingEffects = []; root = null; vnode = null; },
  };
}(window));
