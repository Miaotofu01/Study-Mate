import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_MARKDOWN_LENGTH } from './markdown-inline.js';
import MarkdownPreview from './MarkdownPreview.jsx';
import MarkdownInlineEditor from './MarkdownInlineEditor.jsx';
import MarkdownFormatToolbar from './MarkdownFormatToolbar.jsx';
import { formatMarkdown } from './markdown-formatting.js';
import './note-editor.css';

const OVERSIZE_MESSAGE = '正文最多 128 Ki 字符；原稿已保留，请先缩短正文再编辑。';
const SAVE_ERROR = '这次修改未提交，编辑中的草稿仍在。请重试保存。';

// Each resource owns its editor lifetime. A newly selected file never receives
// the previous file's draft, undo history, selection or deferred composition.
export default function NoteEditor(props) {
  return <NoteDocument key={props.resource?.id || 'empty-note'} {...props} />;
}

function NoteDocument({ resource, onChange, readOnly = false, theme = 'light', label = 'Markdown 正文' }) {
  const markdown = String(resource?.markdown ?? '');
  const [draft, setDraft] = useState(markdown);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState({ text: markdown, from: 0, to: 0 });
  const apiRef = useRef(null);
  const rootRef = useRef(null);
  const lastPropRef = useRef(markdown);
  const lastSentRef = useRef(null);
  const oversize = draft.length > MAX_MARKDOWN_LENGTH;

  useEffect(() => {
    if (markdown === lastPropRef.current) return;
    lastPropRef.current = markdown;
    if (markdown === lastSentRef.current) {
      lastSentRef.current = null;
      return;
    }
    lastSentRef.current = null;
    setDraft(markdown);
    setError('');
    // The inline editor handles genuine external updates during IME; its own
    // echo must not recreate the view or move the user's cursor.
  }, [markdown]);

  const handleChange = useCallback((value) => {
    const next = String(value ?? '');
    if (next.length > MAX_MARKDOWN_LENGTH) {
      setError(OVERSIZE_MESSAGE);
      return false;
    }
    setDraft(next);
    lastSentRef.current = next;
    try {
      onChange?.(next);
      setError('');
      return true;
    } catch {
      lastSentRef.current = null;
      setError(SAVE_ERROR);
      return false;
    }
  }, [onChange]);

  const acceptApi = useCallback((api) => {
    apiRef.current = api;
    setReady(Boolean(api));
    if (api) setSelection(api.read());
  }, []);
  const acceptSelection = useCallback((value) => setSelection(value), []);
  const runCommand = useCallback((command, value, popupSnapshot) => {
    const api = apiRef.current;
    if (!api || readOnly || oversize) return;
    if (command === 'undo' || command === 'redo') {
      api[command]?.();
      api.focus?.();
      setSelection(api.read());
      setError('');
      return;
    }
    try {
      // Ordinary buttons use the current raw coordinates. A link dialog keeps
      // its original selection, but cannot apply it to a changed document.
      const current = api.read();
      if (popupSnapshot && popupSnapshot.text !== current.text) {
        setError('打开链接框后正文已更新。请重新选择文字并打开链接框；本次未改动原稿。');
        return;
      }
      const edit = formatMarkdown(popupSnapshot || current, command, value);
      if (!edit) {
        setError('');
        api.focus?.();
        return;
      }
      if (api.edit(edit) === false) {
        setError('格式修改未应用；原稿保留，请检查正文长度与可编辑状态。');
        return;
      }
      setError('');
      setSelection(api.read());
    } catch (cause) {
      setError(cause?.message || '格式修改未应用，原稿仍在。');
    }
  }, [readOnly, oversize]);

  const onKeyDown = (event) => {
    if (event.defaultPrevented || event.isComposing || event.nativeEvent?.isComposing || readOnly || oversize || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.target.closest?.('input, textarea, select')) return;
    const key = event.key.toLowerCase();
    if (key === 'b' || key === 'i') {
      event.preventDefault(); event.stopPropagation();
      runCommand(key === 'b' ? 'bold' : 'italic');
    } else if (key === 'k') {
      event.preventDefault(); event.stopPropagation();
      rootRef.current?.querySelector('[aria-label="链接"]')?.click();
    } else if (key === 'z' || key === 'y') {
      event.preventDefault(); event.stopPropagation();
      runCommand(key === 'y' || event.shiftKey ? 'redo' : 'undo');
    }
  };

  if (readOnly) return <section className="note-editor is-readonly" data-theme={theme} aria-label={label} data-testid="note-editor">
    <div className="note-editor__preview markdown-preview"><MarkdownPreview>{markdown}</MarkdownPreview></div>
  </section>;

  return <section ref={rootRef} className="note-editor" data-theme={theme} data-mode="inline" aria-label={label} data-testid="note-editor" onKeyDownCapture={onKeyDown}>
    <MarkdownFormatToolbar onCommand={runCommand} selection={selection} disabled={!ready || oversize} />
    {oversize && <p className="note-editor__error" role="alert">{OVERSIZE_MESSAGE}</p>}
    <MarkdownInlineEditor value={draft} onChange={handleChange} onApi={acceptApi} onSelectionChange={acceptSelection} theme={theme} label={label} />
    {error && !oversize && <p className="note-editor__error" role="alert">{error}</p>}
  </section>;
}

export { MAX_MARKDOWN_LENGTH };
