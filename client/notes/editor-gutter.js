// 编辑器行号栏：行号宽度只按「这一屏最大真实行号」的 2–4 位，点行号选整行、按住正反向拖选连续多行。
//
// 原生 lineNumbers() 在两处满足不了无界笔记：
//   1. 宽度由 initialSpacer 撑开，取整篇文档总行数的位数（10 / 100 / 1000 / 10000），
//      长文永远 4 位；短页也用不上窄宽度；
//   2. 行号栏排除在选字之外（DOM 上 aria-hidden），点行号既不能选行，也不能拖。
//
// 这里只用 CodeMirror 的公开配置点补齐：
//   - 行号栏仍是 lineNumbers()，数字永远是真实行号，绝不截断；
//   - 宽度同步挂在测量循环上（requestMeasure 的 read / write）：read 在可视范围内取可见块
//     的最大真实行号，算 2–4 位；write 只在位数变化时写 data-gutter-digits，再复测几何。
//     测量阶段不派发状态事务；文档、可见区或实际滚动变化才请求新测量，避免重入更新；
//   - 行号栏上的 mousedown 交给公开 gutter.domEventHandlers：按下即选中该整行（含行尾
//     换行），按住拖动按「anchor 行 → 当前行」连续选整行，正反向一致。
//     正文的原生选字 / 撤销不受影响：选区始终由 CodeMirror（drawSelection + history）维护。

import { EditorSelection } from '@codemirror/state';
import { EditorView, ViewPlugin, lineNumbers } from '@codemirror/view';

// ---------- 纯函数（Node 里可直接测，不碰 DOM） ----------

/** 把数字夹到 [min, max]；非数字回落到 min。 */
export function clamp(value, min, max) {
  const number = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : min));
}

/** 行号需要几位：真实行号几位，夹在 [2, 4]。只定最小宽度，不截断行号。 */
export function gutterDigitsForLine(lineNumber) {
  return clamp(String(Math.floor(clamp(lineNumber, 1, Number.MAX_SAFE_INTEGER))).length, 2, 4);
}

/** 行号 → 行号（1 起）；越界交给 doc.line 夹到文档范围内，这里只取整。 */
export function lineNumberAt(doc, lineNo) {
  return doc.line(Math.floor(clamp(lineNo, 1, doc.lines))).number;
}

/** 一个可见块覆盖到的最后位置（字节偏移，不是行号）。 */
export const blockEnd = (block) => Math.max(block.from, block.to ?? block.from);

/**
 * 真正与屏幕相交的块。viewportLineBlocks 会多预渲染好几屏，直接拿来算位数会在顶部
 * 就把 100+ 行算进去；top / bottom 是 scrollDOM 的可视范围，只留与之相交的块。
 */
export function visibleBlocks(blocks, top, bottom) {
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || !(bottom > top)) return blocks || [];
  return (blocks || []).filter((block) => (block.bottom ?? 0) > top && (block.top ?? 0) < bottom);
}

/** 可见块里最大的真实行号（1 起）。 */
export function maxVisibleLineNumber(doc, blocks) {
  let max = 1;
  for (const block of blocks || []) {
    const number = doc.lineAt(clamp(blockEnd(block), 0, doc.length)).number;
    if (number > max) max = number;
  }
  return max;
}

/** 可见块要求的行号位数（2–4）。 */
export function gutterDigitsForBlocks(doc, blocks) {
  return gutterDigitsForLine(maxVisibleLineNumber(doc, blocks));
}

/** 第 lineNo 行（1 起）的整行范围：含行尾换行，末行没有换行。 */
export function wholeLineRange(doc, lineNo) {
  const line = doc.line(lineNumberAt(doc, lineNo));
  return { from: line.from, to: line.to < doc.length ? line.to + 1 : line.to };
}

/** 一个块覆盖到的首行与末行行号。 */
export function lineNumbersAtBlock(doc, block) {
  const start = doc.lineAt(clamp(Math.min(block.from, block.to ?? block.from), 0, doc.length)).number;
  if (block.widget && !block.height) return { start, end: start };
  const end = doc.lineAt(clamp(blockEnd(block), 0, doc.length)).number;
  return { start, end: Math.max(start, end) };
}

/**
 * 从 anchorLine 拖到 headLine 的整行选择：一个范围，from 在较小那行的行首、to 在较大那行
 * 的行尾换行之后；anchor 停在鼠标所在一侧，所以正反向拖动都连续、复制粘贴与撤销也稳。
 * 两行相同即点选整行。
 */
export function lineRangeSelection(doc, anchorLine, headLine) {
  const anchor = lineNumberAt(doc, anchorLine);
  const head = lineNumberAt(doc, headLine);
  const from = wholeLineRange(doc, Math.min(anchor, head)).from;
  const to = wholeLineRange(doc, Math.max(anchor, head)).to;
  return EditorSelection.create([anchor <= head ? EditorSelection.range(from, to) : EditorSelection.range(to, from)]);
}

/** 拖到编辑区上下沿时的续滚速度（px / 帧），鼠标在上沿上方为负（向上滚）。 */
export function dragScrollSpeed(distance) {
  return Math.min(Math.abs(distance) / 2, 50) * Math.sign(distance);
}

// ---------- 位数测量 ----------

/** cm-editor 上的位数属性：只影响展示，不创建文档状态或撤销记录。 */
export const GUTTER_DIGITS_ATTR = 'data-gutter-digits';

/**
 * read 只读几何；write 只在位数变化时写 DOM 属性，再请求几何复测。
 * 测量回调仍处于 CodeMirror 更新过程中，不能在这里 dispatch 状态事务。
 * CSS 使用该属性约束宽度；相同位数不再写入或请求复测，因此不会循环。
 */
export const GUTTER_MEASURE = {
  read(view) {
    const scroller = view.scrollDOM;
    const blocks = visibleBlocks(view.viewportLineBlocks || [], scroller.scrollTop, scroller.scrollTop + scroller.clientHeight);
    return gutterDigitsForBlocks(view.state.doc, blocks);
  },
  write(digits, view) {
    if (view.destroyed) return;
    const text = String(digits);
    if (view.dom.getAttribute(GUTTER_DIGITS_ATTR) !== text) {
      view.dom.setAttribute(GUTTER_DIGITS_ATTR, text);
      view.requestMeasure();
    }
  },
};

/** 首帧请求一次，之后只在文档或 viewport 变化时重新请求。 */
export const GUTTER_WIDTH_SYNC = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.onScroll = () => view.requestMeasure(GUTTER_MEASURE);
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    view.requestMeasure(GUTTER_MEASURE);
  }
  update(update) { if (update.docChanged || update.viewportChanged) update.view.requestMeasure(GUTTER_MEASURE); }
  destroy() { this.view.scrollDOM.removeEventListener('scroll', this.onScroll); }
});

// ---------- 行号栏拖选 ----------

/**
 * 行号栏上的整行选择样式：anchorLine 是按下鼠标那一行，之后每个事件坐标都换算成
 * 「这一行 → anchor 行」的整行范围，因此正反向拖动都连续。
 */
export function gutterSelectionStyle(view, gesture) {
  const lineAt = (event) => lineNumbersAtBlock(view.state.doc, view.lineBlockAtHeight(event.clientY - view.documentTop)).start;
  return {
    update() {},
    get(event) { return lineRangeSelection(view.state.doc, gesture.anchorLine, lineAt(event)); },
  };
}

/** 拖动越过编辑区上下沿时续滚，并按滚动后的几何重新选区（Shift / Ctrl 扩展交给鼠标选择本身）。 */
export const gutterDragScroll = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.gesture = null;
    this.event = null;
    this.speed = 0;
    this.timer = -1;
    this.onMove = (event) => this.track(event);
    this.onUp = () => this.release();
    view.dom.ownerDocument.addEventListener('mousemove', this.onMove, true);
    view.dom.ownerDocument.addEventListener('mouseup', this.onUp, true);
  }

  begin(gesture) {
    this.gesture = gesture;
    this.event = null;
    this.speed = 0;
  }

  track(event) {
    if (!this.gesture) return;
    if (event.buttons === 0) return this.release();
    this.event = event;
    event.preventDefault();
    const selection = gutterSelectionStyle(this.view, this.gesture).get(event);
    if (!selection.eq(this.view.state.selection)) this.view.dispatch({ selection, userEvent: 'select.pointer' });
    const rect = this.view.scrollDOM.getBoundingClientRect();
    const margin = 24;
    if (event.clientY < rect.top + margin) this.speed = -dragScrollSpeed(rect.top + margin - event.clientY);
    else if (event.clientY > rect.bottom - margin) this.speed = dragScrollSpeed(event.clientY - rect.bottom + margin);
    else this.speed = 0;
    this.sync();
  }

  /** 续滚一帧，再在滚动后的几何上按同一手势重新选区。 */
  tick() {
    const { gesture, view } = this;
    if (!gesture || !this.event) return this.release();
    view.scrollDOM.scrollTop += this.speed;
    const head = lineNumbersAtBlock(view.state.doc, view.lineBlockAtHeight(this.event.clientY - view.documentTop)).start;
    const selection = lineRangeSelection(view.state.doc, gesture.anchorLine, head);
    if (!selection.eq(view.state.selection)) view.dispatch({ selection, userEvent: 'select.pointer' });
  }

  sync() {
    if (!this.speed) {
      if (this.timer !== -1) { clearInterval(this.timer); this.timer = -1; }
      return;
    }
    if (this.timer === -1) this.timer = setInterval(() => this.tick(), 50);
  }

  release() {
    this.gesture = null;
    this.event = null;
    this.speed = 0;
    this.sync();
  }

  destroy() {
    this.release();
    this.view.dom.ownerDocument.removeEventListener('mousemove', this.onMove, true);
    this.view.dom.ownerDocument.removeEventListener('mouseup', this.onUp, true);
  }
});

/** 事件是否落在行号栏上。 */
export const gutterAt = (view, event) => {
  const gutters = view.dom.querySelector('.cm-gutters');
  return !!gutters && gutters.contains(event.target);
};

// ---------- 行号栏外观 ----------

/**
 * 行号栏宽度：按 cm-editor 上的 data-gutter-digits（2/3/4）给 min-width，
 * 短页 2 位、过百 3 位、过千 4 位，不再按整篇总行数固定 4 位。
 */
const slotWidth = (digits) => ({ width: `calc(${digits}ch + 12px)`, minWidth: `calc(${digits}ch + 12px)`, maxWidth: `calc(${digits}ch + 12px)` });
export const gutterTheme = (dark) => EditorView.theme({
  '.cm-lineNumbers': { ...slotWidth(2), flex: '0 0 auto' },
  '&[data-gutter-digits="3"] .cm-lineNumbers': slotWidth(3),
  '&[data-gutter-digits="4"] .cm-lineNumbers': slotWidth(4),
  '.cm-lineNumbers .cm-gutterElement': { width: '100%', boxSizing: 'border-box', padding: '0 6px', minWidth: '0', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  '.cm-lineNumbers .cm-gutterElement:hover': { color: 'var(--text)' },
}, { dark });

// ---------- 全部扩展 ----------

/** 一次性装齐行号栏的所有扩展。 */
export const editorGutter = () => [
  lineNumbers({ domEventHandlers: { mousedown(view, block, event) {
    if (event.button !== 0 || event.defaultPrevented) return false;
    event.preventDefault();
    const anchorLine = lineNumbersAtBlock(view.state.doc, block).start;
    view.plugin(gutterDragScroll)?.begin({ anchorLine });
    view.dispatch({ selection: lineRangeSelection(view.state.doc, anchorLine, anchorLine), userEvent: 'select.pointer' });
    view.focus();
    return true;
  } } }),
  GUTTER_WIDTH_SYNC,
  gutterDragScroll,
];
