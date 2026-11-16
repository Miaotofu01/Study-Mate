import React, { useEffect, useRef, useState } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, drawSelection } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { editorGutter, gutterTheme } from './editor-gutter.js';

export const MAX_MARKDOWN_LENGTH = 128 * 1024;
const codeLanguages = (name) => {
  if (/^(js|jsx|javascript|ts|tsx|typescript)$/i.test(name)) return javascript({ typescript: /^(ts|tsx|typescript)$/i.test(name), jsx: /^(jsx|tsx)$/i.test(name) }).language;
  if (/^(py|python)$/i.test(name)) return python().language;
  if (/^(html|xml)$/i.test(name)) return html().language;
  if (/^css$/i.test(name)) return css().language;
  if (/^json$/i.test(name)) return json().language;
  return null;
};
const appearance = (theme) => {
  const dark = theme === 'dark';
  return [EditorView.theme({
    '&': { height: '100%', fontSize: '13px', color: 'var(--text)', backgroundColor: 'var(--editor, var(--surface))' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, "Cascadia Code", "Microsoft YaHei", monospace', lineHeight: '1.7', overscrollBehavior: 'contain' },
    '.cm-content': { padding: '14px 0', caretColor: 'var(--text)' },
    '.cm-gutters': { backgroundColor: 'var(--code-gutter)', borderRight: '1px solid var(--border)', color: 'var(--muted)' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--accent-soft)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--code-selection)' },
    '.cm-cursor': { borderLeftColor: 'var(--text)' }, '&.cm-focused': { outline: 'none' },
  }, { dark }), syntaxHighlighting(HighlightStyle.define([
    { tag: tags.keyword, color: dark ? '#d8a7ee' : '#8959a8' },
    { tag: [tags.string, tags.special(tags.string)], color: dark ? '#a2d7a0' : '#36764d' },
    { tag: [tags.number, tags.bool, tags.null], color: dark ? '#f3bc88' : '#a55f28' },
    { tag: tags.comment, color: dark ? '#9faea5' : '#76877d', fontStyle: 'italic' },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: dark ? '#8dc8ff' : '#2b6d9e' },
    { tag: tags.heading, color: dark ? '#9cddcb' : '#1c7164', fontWeight: '700' },
    { tag: tags.strong, fontWeight: '700' }, { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: [tags.link, tags.url], color: dark ? '#8dc8ff' : '#2b6d9e', textDecoration: 'underline' },
    { tag: [tags.tagName, tags.attributeName], color: dark ? '#efb299' : '#986536' },
  ])), gutterTheme(dark)];
};

export default function MarkdownEditor({ value, onChange, label = 'Markdown 正文', initialHeight = 340, fill = false, theme = 'light' }) {
  const root = useRef(null), editor = useRef(null), themeSlot = useRef(new Compartment());
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const [height, setHeight] = useState(initialHeight), [error, setError] = useState('');
  useEffect(() => {
    const view = new EditorView({ parent: root.current, state: EditorState.create({ doc: value || '', extensions: [
      editorGutter(), highlightActiveLine(), drawSelection(), history(), bracketMatching(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]), markdown({ codeLanguages }),
      themeSlot.current.of(appearance(theme)), EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false', role: 'textbox', 'aria-multiline': 'true' }),
      EditorState.changeFilter.of((transaction) => {
        if (!transaction.docChanged || transaction.newDoc.length <= MAX_MARKDOWN_LENGTH) return true;
        queueMicrotask(() => setError('正文最多 128 Ki 字符；这次输入未写入。')); return false;
      }),
      EditorView.updateListener.of((update) => { if (update.docChanged) { setError(''); onChangeRef.current(update.state.doc.toString()); } }),
    ] }) });
    editor.current = view; return () => { view.destroy(); editor.current = null; };
  }, [label]);
  useEffect(() => { editor.current?.dispatch({ effects: themeSlot.current.reconfigure(appearance(theme)) }); }, [theme]);
  useEffect(() => { const view = editor.current; if (view && (value || '') !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value || '' } }); }, [value]);
  const startResize = (event) => {
    if (event.button !== 0) return;
    event.preventDefault(); const element = event.currentTarget, startY = event.clientY, before = height;
    element.setPointerCapture(event.pointerId);
    const move = (next) => setHeight(Math.max(160, Math.min(1000, before + next.clientY - startY)));
    const stop = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop); };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop);
  };
  return <div className={'document-editor-host' + (fill ? ' is-fill' : '')}>
    <div className="editor-pane" ref={root} style={fill ? undefined : { height }} />
    {!fill && <div className="editor-resize-hit" role="separator" aria-label="调整编辑器高度" aria-orientation="horizontal" aria-valuemin={160} aria-valuemax={1000} aria-valuenow={height} tabIndex={0} onPointerDown={startResize}
      onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setHeight((prev) => Math.max(160, Math.min(1000, prev + (event.key === 'ArrowUp' ? -24 : 24)))); } }}><span /></div>}
    {error && <p className="validation-error" role="alert">{error}</p>}
  </div>;
}
