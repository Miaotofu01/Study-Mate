import React, { useEffect, useRef, useState } from 'react';
import { Annotation, Compartment, EditorSelection, EditorState, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { ensureSyntaxTree, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import katex from 'katex';
import 'katex/dist/katex.min.css';

import {
  MAX_MARKDOWN_LENGTH,
  OVERSIZE_MESSAGE,
  applyRawSourceChanges,
  applySourceChanges,
  canonicalOffsetMap,
  codeExclusionRanges,
  collectDecorationRanges,
  collectMathSpans,
  dominantEol,
  editorChangesForRaw,
  fenceLanguage,
  normalizeLineEndings,
  parseGfmTable,
  parseImageSyntax,
  parseInlineMarkdown,
  rawOffsetMap,
  selectionTouchesSpan,
} from './markdown-inline.js';
import './inline-editor.css';

/**
 * 源码优先的行内即时编辑器。
 *
 * 文档只有一个：调用方传进来的原始 Markdown 字符串。CodeMirror 里放的是同一份字符
 * （只把行尾折成 \n 存放），装饰层按「当前选区碰到谁」决定把谁的分隔符显形成灰字；
 * 藏起来的也只是 CSS `display:none`，字符还在文档里，所以删一个 `*` 就是真的删字符。
 *
 * 任何显示态变化（移动光标、选中、失焦、换主题、父子回声）都不派发文档事务，
 * 也就不可能顺手把 Markdown 规范化。
 *
 * 集成契约：
 *   props: value/onChange/onApi/onSelectionChange/theme/label/readOnly
 *   onApi(api): api.read() → { text, from, to }；api.edit({ changes, selection }) → boolean；
 *               api.focus() / api.undo() / api.redo()。卸载时 onApi(null)。
 *   `text`、`from`/`to`、`changes` 的 from/to、`selection` 全是 **canonical 原始字符串坐标**，
 *   父组件可以直接拿 `text.slice/indexOf` 去算；CRLF 在编辑器内部折成 \n，边界处会投影回来。
 */

export const MAX_MARKDOWN_MESSAGE = OVERSIZE_MESSAGE;

/** 让这颗事务被识别为「父组件同步」，不触发 onChange 回声。 */
const externalSync = Annotation.define();

const codeLanguages = (name) => {
  if (/^(js|jsx|javascript|ts|tsx|typescript)$/i.test(name)) {
    return javascript({ typescript: /^(ts|tsx|typescript)$/i.test(name), jsx: /^(jsx|tsx)$/i.test(name) }).language;
  }
  if (/^(py|python)$/i.test(name)) return python().language;
  if (/^(html|xml)$/i.test(name)) return html().language;
  if (/^css$/i.test(name)) return css().language;
  if (/^json$/i.test(name)) return json().language;
  return null;
};

function appendInlineMarkdown(parent, nodes) {
  for (const node of nodes || []) {
    if (node.type === 'text') {
      parent.appendChild(document.createTextNode(node.text || ''));
    } else if (node.type === 'strong' || node.type === 'emphasis') {
      const element = document.createElement(node.type === 'strong' ? 'strong' : 'em');
      appendInlineMarkdown(element, node.children);
      parent.appendChild(element);
    } else if (node.type === 'inline-code') {
      const code = document.createElement('code');
      appendInlineMarkdown(code, node.children);
      parent.appendChild(code);
    } else {
      parent.appendChild(document.createTextNode(String(node.text || '')));
    }
  }
}

class TableWidget extends WidgetType {
  constructor(table, from) {
    super();
    this.table = table;
    this.from = from;
  }

  eq(other) {
    return other instanceof TableWidget && other.from === this.from && JSON.stringify(other.table) === JSON.stringify(this.table);
  }

  ignoreEvent() {
    return true;
  }

  toDOM(view) {
    const wrapper = document.createElement('div');
    wrapper.className = 'md-table-widget';
    wrapper.contentEditable = 'false';
    const table = document.createElement('table');
    table.className = 'md-table';
    const bindCell = (cell, range) => {
      cell.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        view.dispatch({ selection: { anchor: range ? range.from : this.from + 1 }, scrollIntoView: true });
        view.focus();
      });
    };
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    this.table.headers.forEach((value, index) => {
      const cell = document.createElement('th');
      appendInlineMarkdown(cell, parseInlineMarkdown(value));
      if (this.table.aligns[index]) cell.style.textAlign = this.table.aligns[index];
      bindCell(cell, this.table.cellRanges?.headers?.[index]);
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    if (this.table.rows.length) {
      const body = document.createElement('tbody');
      for (let rowIndex = 0; rowIndex < this.table.rows.length; rowIndex += 1) {
        const row = this.table.rows[rowIndex];
        const tr = document.createElement('tr');
        for (let index = 0; index < this.table.headers.length; index += 1) {
          const cell = document.createElement('td');
          const value = row[index] ?? '';
          appendInlineMarkdown(cell, parseInlineMarkdown(value));
          if (this.table.aligns[index]) cell.style.textAlign = this.table.aligns[index];
          bindCell(cell, this.table.cellRanges?.rows?.[rowIndex]?.[index]);
          tr.appendChild(cell);
        }
        body.appendChild(tr);
      }
      table.appendChild(body);
    }
    wrapper.appendChild(table);
    wrapper.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.from + 1 }, scrollIntoView: true });
      view.focus();
    });
    return wrapper;
  }
}

class TaskWidget extends WidgetType {
  constructor(checked, from) {
    super();
    this.checked = checked;
    this.from = from;
  }

  eq(other) {
    return other instanceof TaskWidget && other.checked === this.checked && other.from === this.from;
  }

  ignoreEvent() {
    return true;
  }

  toDOM(view) {
    const wrapper = document.createElement('span');
    wrapper.className = 'md-task-widget';
    wrapper.contentEditable = 'false';
    wrapper.setAttribute('role', 'checkbox');
    wrapper.setAttribute('aria-checked', this.checked ? 'true' : 'false');
    wrapper.setAttribute('aria-label', this.checked ? '已完成任务' : '未完成任务');
    wrapper.tabIndex = -1;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.disabled = true;
    box.tabIndex = -1;
    box.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(box);
    wrapper.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.from + 1 }, scrollIntoView: true });
      view.focus();
    });
    return wrapper;
  }
}

/* 围栏语言角标：休息态把「```python」整行收起后语言就不见了，
   这里用只读 chip 顶替开围栏行；点它把光标放回围栏，源码就地显形。 */
class CodeLangWidget extends WidgetType {
  constructor(lang, from) {
    super();
    this.lang = lang;
    this.from = from;
  }

  eq(other) {
    return other instanceof CodeLangWidget && other.lang === this.lang && other.from === this.from;
  }

  ignoreEvent() {
    return true;
  }

  toDOM(view) {
    const chip = document.createElement('span');
    chip.className = 'md-code-lang';
    chip.textContent = this.lang;
    chip.contentEditable = 'false';
    // 可访问性：行为上是按钮，给真实 button 语义与键盘路径。
    // tabIndex=-1 是刻意的：编辑器 keymap 带 indentWithTab（MarkdownInlineEditor.jsx:707），
    // 编辑态 Tab 必须留给缩进；键盘用户走两条等效路径——方向键落到围栏行边界时
    // 围栏自动显形（selectionTouchesSpan 含端点契约），读屏浏览态可直接激活本按钮。
    // tabIndex=-1 保证 chip 不会插进编辑器的 Tab 序、不抢编辑器焦点流。
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', `代码语言 ${this.lang}`);
    chip.tabIndex = -1;
    const reveal = (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    };
    chip.addEventListener('mousedown', reveal);
    // 读屏/程序化激活产生的 click 没有 detail（detail===0）；真实鼠标点击已由
    // mousedown 处理，按 detail 区分避免同一次点击派发两次选区。
    chip.addEventListener('click', (event) => { if (event.detail === 0) reveal(event); });
    chip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') reveal(event);
    });
    return chip;
  }
}

class MathWidget extends WidgetType {
  constructor(content, display, from, contentFrom = from) {
    super();
    this.content = content;
    this.display = display;
    this.from = from;
    this.contentFrom = contentFrom;
  }

  eq(other) {
    return other instanceof MathWidget
      && other.content === this.content
      && other.display === this.display
      && other.from === this.from
      && other.contentFrom === this.contentFrom;
  }

  ignoreEvent() {
    return true;
  }

  toDOM(view) {
    const dom = document.createElement(this.display ? 'div' : 'span');
    dom.className = this.display ? 'md-math-block md-math-rendered' : 'md-math-inline md-math-rendered';
    dom.contentEditable = 'false';
    try {
      katex.render(this.content, dom, {
        displayMode: this.display,
        throwOnError: false,
        trust: false,
        maxExpand: 500,
        maxSize: 15,
        strict: 'ignore',
      });
    } catch {
      dom.textContent = this.display ? `$$${this.content}$$` : `$${this.content}$`;
    }
    dom.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // 点到公式内容开头：单行 `$x$` 是 x，多行 `$$\n...\n$$` 是开围栏之后的第一行，
      // 不再落在开头的 `$`/`$$` 标记里面。
      view.dispatch({ selection: { anchor: this.contentFrom }, scrollIntoView: true });
      view.focus();
    });
    return dom;
  }
}

class ImageWidget extends WidgetType {
  constructor(alt, url, from) {
    super();
    this.alt = alt;
    this.url = url;
    this.from = from;
  }

  eq(other) {
    return other instanceof ImageWidget && other.alt === this.alt && other.url === this.url && other.from === this.from;
  }

  ignoreEvent() {
    return true;
  }

  toDOM(view) {
    const placeholder = document.createElement('span');
    placeholder.className = 'md-image-placeholder';
    placeholder.contentEditable = 'false';
    placeholder.textContent = this.alt || '图片';
    placeholder.title = this.url || '';
    if (this.url) placeholder.dataset.url = this.url;
    placeholder.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.from + 1 }, scrollIntoView: true });
      view.focus();
    });
    return placeholder;
  }
}

function lineClassesFor(state, spans, ranges) {
  const classes = new Map();
  const add = (from, name) => {
    const set = classes.get(from);
    if (set) set.add(name);
    else classes.set(from, new Set([name]));
  };
  for (const span of spans) {
    if (!span.block) continue;
    const first = state.doc.lineAt(Math.min(span.from, state.doc.length));
    const last = state.doc.lineAt(Math.min(span.to, state.doc.length));
    if (span.kind === 'fenced-code') {
      const active = selectionTouchesSpan(span, ranges);
      for (let number = first.number; number <= last.number; number += 1) {
        const fence = number === first.number || number === last.number;
        add(state.doc.line(number).from, fence ? (active ? 'md-code-fence' : 'md-code-fence-off') : 'md-code-body');
      }
      continue;
    }
    if (span.kind === 'table') {
      if (!selectionTouchesSpan(span, ranges)) continue;
      for (let number = first.number; number <= last.number; number += 1) add(state.doc.line(number).from, 'md-line-table');
      continue;
    }
    if (span.kind === 'heading') add(first.from, 'md-line-heading');
    if (span.kind === 'list') add(first.from, 'md-line-list');
    if (span.kind === 'quote') {
      for (let number = first.number; number <= last.number; number += 1) add(state.doc.line(number).from, 'md-line-quote');
    }
  }
  return classes;
}

function buildDecorations(state) {
  const text = state.doc.toString();
  const tree = ensureSyntaxTree(state, state.doc.length, 80) || syntaxTree(state);
  const ranges = state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
  const { spans, marks } = collectDecorationRanges(tree, ranges, text);
  const mathSpans = collectMathSpans(text, codeExclusionRanges(tree));
  const replaced = [];
  const out = [];
  const overlapsReplaced = (from, to) => replaced.some((range) => from < range.to && to > range.from);

  // 表格：不在选区内就整块换成只读 DOM 表格；点它把光标放回源码里，源码就地显形。
  for (const span of spans) {
    if (span.kind !== 'table' || selectionTouchesSpan(span, ranges)) continue;
    const data = parseGfmTable(text, span.from, span.to);
    if (!data) continue;
    const first = state.doc.lineAt(span.from);
    const last = state.doc.lineAt(span.to);
    if (last.to <= first.from) continue;
    replaced.push({ from: first.from, to: last.to });
    out.push(Decoration.replace({ widget: new TableWidget(data, first.from), block: true }).range(first.from, last.to));
  }

  // 公式：单行 `$...$` / 整行 `$$...$$`，以及独占整行的多行 `$$\n...\n$$`。
  // 选区碰到就只保留该区域的源码，其余公式继续渲染。
  for (const span of mathSpans) {
    if (selectionTouchesSpan(span, ranges)) {
      out.push(Decoration.mark({ class: 'md-math-source' }).range(span.from, span.to));
      continue;
    }
    if (overlapsReplaced(span.from, span.to)) continue;
    if (span.block) {
      const first = state.doc.lineAt(span.from);
      const last = state.doc.lineAt(span.to);
      if (last.to <= first.from) continue;
      replaced.push({ from: first.from, to: last.to });
      out.push(Decoration.replace({
        widget: new MathWidget(span.content, true, first.from, span.contentFrom),
        block: true,
      }).range(first.from, last.to));
      continue;
    }
    const line = state.doc.lineAt(span.from);
    const sameLine = state.doc.lineAt(span.to).number === line.number;
    const wholeLine = span.display && sameLine && line.text.trim() === text.slice(span.from, span.to).trim();
    if (wholeLine) {
      replaced.push({ from: line.from, to: line.to });
      out.push(Decoration.replace({
        widget: new MathWidget(span.content, true, line.from, span.contentFrom),
        block: true,
      }).range(line.from, line.to));
    } else {
      replaced.push({ from: span.from, to: span.to });
      out.push(Decoration.replace({
        widget: new MathWidget(span.content, false, span.from, span.contentFrom),
      }).range(span.from, span.to));
    }
  }

  // GFM 任务：休息态显示只读勾选框，紧挨着的正文仍然是普通可编辑文字；
  // 选区进来后勾选框消失，真实 `[x]`/`[ ]` 以灰字显形，可逐字改写。
  for (const span of spans) {
    if (span.kind !== 'task' || selectionTouchesSpan(span, ranges) || overlapsReplaced(span.from, span.to)) continue;
    const marker = text.slice(span.from, span.to);
    replaced.push({ from: span.from, to: span.to });
    out.push(Decoration.replace({
      widget: new TaskWidget(/\[[xX]\]/.test(marker), span.from),
    }).range(span.from, span.to));
  }

  // 图片：只做本地占位（alt + URL 提示），永不设置 img.src。
  for (const span of spans) {
    if (span.kind !== 'image' || selectionTouchesSpan(span, ranges) || overlapsReplaced(span.from, span.to)) continue;
    const info = parseImageSyntax(text, span.from, span.to);
    replaced.push({ from: span.from, to: span.to });
    out.push(Decoration.replace({ widget: new ImageWidget(info.alt, info.url, span.from) }).range(span.from, span.to));
  }

  // 围栏：休息态把围栏行收起（空替换），代码正文仍等宽高亮；选区进来才显形灰色围栏。
  // 开围栏行带语言信息时收起成语言角标 chip，点它把围栏显形。
  for (const span of spans) {
    if (span.kind !== 'fenced-code' || selectionTouchesSpan(span, ranges)) continue;
    const first = state.doc.lineAt(span.from);
    const last = state.doc.lineAt(span.to);
    const lines = first.number === last.number ? [first] : [first, last];
    for (const line of lines) {
      if (line.to <= line.from || overlapsReplaced(line.from, line.to)) continue;
      const isOpenFence = line.number === first.number && first.number !== last.number;
      const lang = isOpenFence ? fenceLanguage(line.text) : '';
      replaced.push({ from: line.from, to: line.to });
      out.push(lang
        ? Decoration.replace({ widget: new CodeLangWidget(lang, line.from), block: true }).range(line.from, line.to)
        : Decoration.replace({}).range(line.from, line.to));
    }
  }

  for (const mark of marks) {
    if (mark.to <= mark.from || overlapsReplaced(mark.from, mark.to)) continue;
    out.push(Decoration.mark({ class: mark.classes }).range(mark.from, mark.to));
  }
  for (const [from, names] of lineClassesFor(state, spans, ranges)) {
    out.push(Decoration.line({ class: Array.from(names).join(' ') }).range(from));
  }
  return Decoration.set(out, true);
}

const inlineDecorations = StateField.define({
  create(state) {
    return buildDecorations(state);
  },
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection) return value;
    return buildDecorations(transaction.state);
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});

function changesOf(transaction) {
  const changes = [];
  transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    changes.push({ from, to, insert: inserted.toString() });
  });
  return changes;
}

export default function MarkdownInlineEditor({
  value = '',
  onChange,
  onApi,
  onSelectionChange,
  theme = 'light',
  label = 'Markdown 正文',
  readOnly = false,
}) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const canonicalRef = useRef(typeof value === 'string' ? value : '');
  const lastEmittedRef = useRef(typeof value === 'string' ? value : '');
  const composingRef = useRef(false);
  const compositionStartRef = useRef(canonicalRef.current);
  const compositionTouchedRef = useRef(false);
  const compositionGraceRef = useRef(false);
  const compositionEndDataRef = useRef('');
  const compositionTimerRef = useRef(0);
  const staleExternalRef = useRef(null);
  const pendingExternalRef = useRef(null);
  const pendingCanonicalRef = useRef(null);
  const undoStackRef = useRef([canonicalRef.current]);
  const redoStackRef = useRef([]);
  const historyTravelRef = useRef(false);
  const projectionRef = useRef(null);
  const readOnlyRef = useRef(readOnly);
  const onChangeRef = useRef(onChange);
  const onApiRef = useRef(onApi);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const readOnlySlot = useRef(new Compartment());
  const attributesSlot = useRef(new Compartment());
  const [error, setError] = useState(typeof value === 'string' && value.length > MAX_MARKDOWN_LENGTH ? OVERSIZE_MESSAGE : '');

  onChangeRef.current = onChange;
  onApiRef.current = onApi;
  onSelectionChangeRef.current = onSelectionChange;
  readOnlyRef.current = readOnly;

  // 原始坐标投影表按「当前 canonical 字符串」缓存；一次选区变化不重复建 128 KiB 的数组。
  function rawProjectionFor(canonical) {
    const cached = projectionRef.current;
    if (cached && cached.canonical === canonical) return cached;
    const projection = {
      canonical,
      editorToRaw: canonicalOffsetMap(canonical),
      rawToEditor: rawOffsetMap(canonical),
    };
    projectionRef.current = projection;
    return projection;
  }

  // 自己记 canonical 文档栈：CM 的 undo 只存折行后的文本，混合换行回不去。
  // 栈里每一项都是可直接交给父组件的原始字符串；撤销/重做就是整篇换回某个快照。
  function remember(canonical) {
    if (historyTravelRef.current) return;
    const stack = undoStackRef.current;
    if (stack[stack.length - 1] === canonical) return;
    stack.push(canonical);
    if (stack.length > 200) stack.splice(0, stack.length - 200);
    redoStackRef.current = [];
  }

  function travel(direction) {
    const view = viewRef.current;
    if (!view || readOnlyRef.current) return false;
    const undoStack = undoStackRef.current;
    const redoStack = redoStackRef.current;
    let target;
    if (direction === 'undo') {
      if (undoStack.length <= 1) return false;
      const current = undoStack.pop();
      redoStack.push(current);
      target = undoStack[undoStack.length - 1];
    } else {
      if (!redoStack.length) return false;
      target = redoStack.pop();
      undoStack.push(target);
    }
    historyTravelRef.current = true;
    pendingCanonicalRef.current = target;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: normalizeLineEndings(target) },
        selection: { anchor: 0 },
        scrollIntoView: true,
      });
    } finally {
      historyTravelRef.current = false;
    }
    view.focus();
    return true;
  }

  function readSnapshot() {
    const canonical = canonicalRef.current;
    const view = viewRef.current;
    if (!view) {
      return { text: canonical, from: 0, to: 0, empty: true };
    }
    const range = view.state.selection.main;
    const projection = rawProjectionFor(canonical);
    return {
      text: canonical,
      from: projection.editorToRaw[Math.min(range.from, projection.editorToRaw.length - 1)],
      to: projection.editorToRaw[Math.min(range.to, projection.editorToRaw.length - 1)],
      empty: range.empty,
    };
  }

  function applyExternal(next) {
    const view = viewRef.current;
    if (!view) return false;
    if (next.length > MAX_MARKDOWN_LENGTH) {
      setError(OVERSIZE_MESSAGE);
      return false;
    }
    const previousCanonical = canonicalRef.current;
    const previousEmitted = lastEmittedRef.current;
    const previousDoc = view.state.doc.toString();
    const priorSelection = readSnapshot();
    const doc = normalizeLineEndings(next);
    const projection = rawProjectionFor(next);
    const clamp = (position) => Math.max(0, Math.min(next.length, Math.trunc(position)));
    const anchor = projection.rawToEditor[clamp(priorSelection.from)];
    const head = projection.rawToEditor[clamp(priorSelection.to)];

    // 先让 canonical 与新投影就位：updateListener 里的 onSelectionChange 会同步读它。
    // changeFilter 对 externalSync 走单独通道，不再用旧编辑器文档去猜新 canonical。
    pendingCanonicalRef.current = null;
    canonicalRef.current = next;
    lastEmittedRef.current = next;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        selection: { anchor, head },
        annotations: [externalSync.of(true), Transaction.addToHistory.of(false)],
      });
    } catch {
      canonicalRef.current = previousCanonical;
      lastEmittedRef.current = previousEmitted;
      return false;
    }
    if (view.state.doc.toString() !== doc) {
      // 过滤/异常导致文档没换成目标内容：回滚 canonical，避免“值新、文档旧”。
      canonicalRef.current = previousCanonical;
      lastEmittedRef.current = previousEmitted;
      if (view.state.doc.toString() !== previousDoc) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: previousDoc },
          annotations: [externalSync.of(true)],
        });
      }
      return false;
    }
    undoStackRef.current = [next];
    redoStackRef.current = [];
    setError('');
    return true;
  }

  function applyEdit(payload) {
    const view = viewRef.current;
    if (!view || readOnlyRef.current) return false;
    const changes = Array.isArray(payload?.changes) ? payload.changes : [];
    if (!changes.length) return false;
    const source = canonicalRef.current;
    let next;
    let editorChanges;
    try {
      next = applyRawSourceChanges(source, changes);
      editorChanges = editorChangesForRaw(source, changes);
    } catch {
      return false;
    }
    if (next.length > MAX_MARKDOWN_LENGTH) {
      setError(OVERSIZE_MESSAGE);
      return false;
    }
    const options = { changes: editorChanges, scrollIntoView: true };
    if (payload.selection && Number.isFinite(payload.selection.anchor) && Number.isFinite(payload.selection.head)) {
      const clamp = (position) => Math.max(0, Math.min(next.length, Math.trunc(position)));
      // selection 是「编辑之后」的原始坐标，所以用 next 的投影表。
      const projection = rawProjectionFor(next);
      options.selection = EditorSelection.single(
        projection.rawToEditor[clamp(payload.selection.anchor)],
        projection.rawToEditor[clamp(payload.selection.head)],
      );
    }
    pendingCanonicalRef.current = next;
    try {
      view.dispatch(options);
    } catch {
      pendingCanonicalRef.current = null;
      return false;
    }
    // 极少数原始坐标落在 CRLF 中间：CM 折行后无法逐字对应，整篇同步一次，
    // 保证编辑器里看到的字节与 canonical 一致（这次不再触发 onChange）。
    const normalizedTarget = normalizeLineEndings(next);
    if (view.state.doc.toString() !== normalizedTarget) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: normalizedTarget },
        selection: options.selection,
        annotations: [externalSync.of(true)],
      });
    }
    view.focus();
    return true;
  }

  const apiRef = useRef(null);
  if (!apiRef.current) {
    apiRef.current = {
      read: () => readSnapshot(),
      edit: (payload) => applyEdit(payload),
      focus: () => { viewRef.current?.focus(); },
      undo: () => travel('undo'),
      redo: () => travel('redo'),
    };
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: normalizeLineEndings(canonicalRef.current),
        extensions: [
          drawSelection(),
          keymap.of([
            { key: 'Mod-z', run: () => travel('undo'), preventDefault: true },
            { key: 'Shift-Mod-z', run: () => travel('redo'), preventDefault: true },
            { key: 'Mod-y', run: () => travel('redo'), preventDefault: true },
            ...defaultKeymap,
            indentWithTab,
          ]),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages }),
          // 固定生成色在深色主题下过不了 AA；只用类名，颜色交给本模块 CSS 的 tok-* 变量。
          syntaxHighlighting(classHighlighter),
          inlineDecorations,
          readOnlySlot.current.of([
            EditorState.readOnly.of(readOnlyRef.current),
            EditorView.editable.of(!readOnlyRef.current),
          ]),
          attributesSlot.current.of(EditorView.contentAttributes.of({
            'aria-label': label,
            'aria-multiline': 'true',
            'aria-readonly': readOnlyRef.current ? 'true' : 'false',
            role: 'textbox',
            spellcheck: 'false',
          })),
          EditorState.changeFilter.of((transaction) => {
            if (!transaction.docChanged) return true;
            // 外部同值同步是父组件给的整篇替换，不是用户输入：它不参与
            // applySourceChanges 的“旧文档长度”推算；长度只按目标文档校验。
            if (transaction.annotation(externalSync)) {
              if (transaction.newDoc.length <= MAX_MARKDOWN_LENGTH) return true;
              queueMicrotask(() => setError(OVERSIZE_MESSAGE));
              return false;
            }
            if (readOnlyRef.current) return false;
            // api.edit 已经按原始坐标检查过长度，这里不再用编辑器折行后的长度误判。
            if (pendingCanonicalRef.current != null) return true;
            let next;
            try {
              next = applySourceChanges(canonicalRef.current, changesOf(transaction), dominantEol(canonicalRef.current));
            } catch {
              return false;
            }
            if (next.length <= MAX_MARKDOWN_LENGTH) return true;
            queueMicrotask(() => setError(OVERSIZE_MESSAGE));
            return false;
          }),
          EditorView.updateListener.of((update) => {
            const external = update.transactions.some((transaction) => transaction.annotation(externalSync));
            if (update.docChanged && !external) {
              // 组合事件（尤其 compositionend）可能早于 CM 的 doc-change 回调。
              // 只要本地文档真的变了，就把组合期间排队的外部旧值判为回声并丢掉。
              if (composingRef.current || compositionGraceRef.current) {
                compositionTouchedRef.current = true;
                if (pendingExternalRef.current != null) {
                  staleExternalRef.current = pendingExternalRef.current;
                  pendingExternalRef.current = null;
                }
                compositionGraceRef.current = false;
                if (compositionTimerRef.current) {
                  window.clearTimeout(compositionTimerRef.current);
                  compositionTimerRef.current = 0;
                }
              }
              let next;
              if (pendingCanonicalRef.current != null) {
                next = pendingCanonicalRef.current;
                pendingCanonicalRef.current = null;
              } else {
                try {
                  next = applySourceChanges(canonicalRef.current, changesOf(update), dominantEol(canonicalRef.current));
                } catch {
                  next = update.state.doc.toString();
                }
              }
              canonicalRef.current = next;
              if (!historyTravelRef.current) remember(next);
              if (next !== lastEmittedRef.current) {
                lastEmittedRef.current = next;
                try {
                  onChangeRef.current?.(next);
                } catch {
                  // 父组件的异常不能把编辑器留在半更新状态。
                }
                setError((current) => (current ? '' : current));
              }
            }
            if (update.docChanged || update.selectionSet) {
              onSelectionChangeRef.current?.(readSnapshot());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;

    const settleComposition = () => {
      compositionTimerRef.current = 0;
      compositionGraceRef.current = false;
      const pending = pendingExternalRef.current;
      pendingExternalRef.current = null;
      if (pending == null) return;
      if (compositionTouchedRef.current) return;
      if (canonicalRef.current !== compositionStartRef.current) return;
      // compositionend 已经带了提交文本：即使 CM 的 doc-change 回调晚到，也按用户输入优先，
      // 绝不把组合期间排队的旧回声再写回去。
      if (compositionEndDataRef.current) return;
      if (pending === canonicalRef.current) return;
      applyExternal(pending);
    };
    const onCompositionStart = () => {
      if (compositionTimerRef.current) {
        window.clearTimeout(compositionTimerRef.current);
        compositionTimerRef.current = 0;
      }
      composingRef.current = true;
      compositionGraceRef.current = false;
      compositionTouchedRef.current = false;
      compositionEndDataRef.current = '';
      compositionStartRef.current = canonicalRef.current;
    };
    const onCompositionEnd = (event) => {
      composingRef.current = false;
      const committedDuringComposition = compositionTouchedRef.current
        || canonicalRef.current !== compositionStartRef.current;
      compositionEndDataRef.current = typeof event?.data === 'string' ? event.data : '';
      if (compositionTimerRef.current) window.clearTimeout(compositionTimerRef.current);
      compositionTimerRef.current = 0;
      if (committedDuringComposition) {
        // 原稿事务可能先于 compositionend 到达；不能把 grace 留到之后。
        compositionGraceRef.current = false;
        const superseded = pendingExternalRef.current;
        if (superseded != null) {
          staleExternalRef.current = superseded;
          pendingExternalRef.current = null;
        }
        if (compositionEndDataRef.current || canonicalRef.current !== compositionStartRef.current) {
          // 旧回声可能已在 value effect 中丢弃，但受控父级仍持有它。
          // 提交事件把真实输入交还拥有者；不造编辑事务、不重入撤销栈。
          lastEmittedRef.current = canonicalRef.current;
          onChangeRef.current?.(canonicalRef.current);
        }
        return;
      }
      compositionGraceRef.current = true;
      // 有提交文本时给 CM 的 DOM 观察器足够时间落 doc-change；没有提交文本（取消组合）
      // 才允许外部更新很快接管。真正的判定仍在 updateListener 的本地变更分支。
      compositionTimerRef.current = window.setTimeout(
        settleComposition,
        compositionEndDataRef.current ? 1000 : 120,
      );
    };
    view.contentDOM.addEventListener('compositionstart', onCompositionStart);
    view.contentDOM.addEventListener('compositionend', onCompositionEnd);

    const api = apiRef.current;
    onApiRef.current?.(api);
    onSelectionChangeRef.current?.(readSnapshot());

    return () => {
      if (compositionTimerRef.current) window.clearTimeout(compositionTimerRef.current);
      compositionTimerRef.current = 0;
      view.contentDOM.removeEventListener('compositionstart', onCompositionStart);
      view.contentDOM.removeEventListener('compositionend', onCompositionEnd);
      viewRef.current = null;
      composingRef.current = false;
      compositionGraceRef.current = false;
      compositionTouchedRef.current = false;
      compositionEndDataRef.current = '';
      staleExternalRef.current = null;
      pendingExternalRef.current = null;
      pendingCanonicalRef.current = null;
      onApiRef.current?.(null);
      view.destroy();
    };
    // 编辑器只建一次；value/theme/label/readOnly 的后续变化走各自的 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = typeof value === 'string' ? value : '';
    if (next === canonicalRef.current) {
      staleExternalRef.current = null;
      return;
    }
    if (next.length > MAX_MARKDOWN_LENGTH) {
      setError(OVERSIZE_MESSAGE);
      return;
    }
    if (staleExternalRef.current === next) return;
    if (composingRef.current || compositionGraceRef.current) {
      // 组合期间以及 compositionend 到 doc-change 之间，外部值一律先排队。
      // 只要本地文档变了，updateListener 会把队列判成回声丢掉。
      if (compositionTouchedRef.current || canonicalRef.current !== compositionStartRef.current) {
        pendingExternalRef.current = null;
      } else {
        pendingExternalRef.current = next;
      }
      return;
    }
    applyExternal(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlySlot.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: attributesSlot.current.reconfigure(EditorView.contentAttributes.of({
        'aria-label': label,
        'aria-multiline': 'true',
        'aria-readonly': readOnlyRef.current ? 'true' : 'false',
        role: 'textbox',
        spellcheck: 'false',
      })),
    });
  }, [label, readOnly]);

  function handleRootFocus() {
    viewRef.current?.focus();
  }

  return (
    <div
      className="markdown-inline-editor"
      data-testid="markdown-inline-editor"
      data-theme={theme}
      onClick={handleRootFocus}
    >
      <div className="markdown-inline-editor__host" ref={hostRef} />
      {error && <p className="markdown-inline-editor__error" role="alert">{error}</p>}
    </div>
  );
}
