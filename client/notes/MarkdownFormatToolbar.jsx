import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Bold,
  Code,
  Code2,
  Italic,
  Link2,
  List,
  ListOrdered,
  MoreHorizontal,
  Quote,
  Redo2,
  Strikethrough,
  Table,
  Undo2,
} from 'lucide-react';

import { activeFormatState, normalizeHttpHref } from './markdown-formatting.js';
import './markdown-toolbar.css';
import { useNotesLocale } from './locale.js';

const HEADING_OPTIONS = [
  { value: '0', label: 'body' },
  { value: '1', label: 'H1' },
  { value: '2', label: 'H2' },
  { value: '3', label: 'H3' },
  { value: '4', label: 'H4' },
  { value: '5', label: 'H5' },
  { value: '6', label: 'H6' },
];

function Icon({ children }) {
  return <span className="md-format-toolbar__icon" aria-hidden="true">{children}</span>;
}

/**
 * 图标按钮：用 mousedown 的 preventDefault 保住编辑器里的选区，
 * 键盘 Tab 到按钮后仍按 Enter/Space 触发 onClick。
 */
function FormatButton({ label, command, disabled, active, onPress, children, role }) {
  return (
    <button
      type="button"
      role={role}
      className="md-format-toolbar__button"
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      title={label}
      disabled={disabled}
      data-command={command}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPress}
    >
      <Icon>{children}</Icon>
    </button>
  );
}

function MenuButton({ label, command, disabled, onPress, children }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="md-format-toolbar__menu-item"
      disabled={disabled}
      data-command={command}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPress}
    >
      <Icon>{children}</Icon>
      <span>{label}</span>
    </button>
  );
}

export default function MarkdownFormatToolbar({ onCommand, disabled = false, selection }) {
  const nt = useNotesLocale();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState({ href: '', text: '' });
  const [linkError, setLinkError] = useState('');
  const rootRef = useRef(null);
  const linkSnapshotRef = useRef(null);
  const overflowRef = useRef(null);
  const overflowButtonRef = useRef(null);
  const linkRef = useRef(null);
  const linkButtonRef = useRef(null);
  const hrefInputRef = useRef(null);
  const dialogTitleId = useId();
  const overflowMenuId = useId();
  const linkDialogId = useId();

  const snapshot = useMemo(() => {
    const text = typeof selection?.text === 'string' ? selection.text : '';
    const rawFrom = Number.isInteger(selection?.from) ? selection.from : 0;
    const rawTo = Number.isInteger(selection?.to) ? selection.to : rawFrom;
    const from = Math.max(0, Math.min(rawFrom, text.length));
    const to = Math.max(from, Math.min(rawTo, text.length));
    return { text, from, to };
  }, [selection?.text, selection?.from, selection?.to]);

  const active = useMemo(
    () => activeFormatState(snapshot.text, snapshot.from, snapshot.to),
    [snapshot],
  );

  useEffect(() => {
    if (!disabled) return;
    setOverflowOpen(false);
    setLinkOpen(false);
    linkSnapshotRef.current = null;
  }, [disabled]);

  useEffect(() => {
    if (!overflowOpen) return undefined;
    const onPointerDown = (event) => {
      if (!overflowRef.current?.contains(event.target)) setOverflowOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [overflowOpen]);

  useEffect(() => {
    if (!linkOpen) return undefined;
    const onPointerDown = (event) => {
      if (!linkRef.current?.contains(event.target)) {
        setLinkOpen(false);
        setLinkError('');
        linkSnapshotRef.current = null;
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [linkOpen]);

  useEffect(() => {
    if (!linkOpen) return;
    const input = hrefInputRef.current;
    if (!input) return;
    input.focus();
    if (input.value) input.select();
  }, [linkOpen]);

  const emit = (command, value, source) => {
    if (disabled) return;
    onCommand?.(command, value, source);
  };

  const closeOverflow = (restoreFocus = false) => {
    setOverflowOpen(false);
    if (restoreFocus) overflowButtonRef.current?.focus();
  };

  const closeLink = (restoreFocus = false) => {
    setLinkOpen(false);
    setLinkError('');
    linkSnapshotRef.current = null;
    if (restoreFocus) linkButtonRef.current?.focus();
  };

  const openLinkDialog = () => {
    if (disabled) return;
    setOverflowOpen(false);
    setLinkError('');
    // Freeze the raw document + offset snapshot used to open the dialog. The
    // parent re-checks this against the current source before applying, so an
    // external body swap or focus jump can never link unrelated text.
    linkSnapshotRef.current = {
      text: snapshot.text,
      from: snapshot.from,
      to: snapshot.to,
    };
    setLinkDraft({
      href: active.link ? active.linkHref : '',
      text: active.link || snapshot.from === snapshot.to
        ? ''
        : snapshot.text.slice(snapshot.from, snapshot.to),
    });
    setLinkOpen(true);
  };

  const submitLink = (event) => {
    event.preventDefault();
    if (disabled) return;
    const href = normalizeHttpHref(linkDraft.href);
    if (!href) {
      setLinkError('invalid_url');
      return;
    }
    const text = linkDraft.text;
    if (text.includes(']') || /[\r\n]/.test(text) || /(^|[^\\])(\\\\)*\\$/.test(text)) {
      setLinkError('invalid_link_text');
      return;
    }
    const unchangedHref = active.link && normalizeHttpHref(active.linkHref) === href;
    const unchangedText = text === '' || text === active.linkText;
    if (unchangedHref && unchangedText) {
      closeLink(true);
      return;
    }
    const value = { href };
    if (text !== '') value.text = text;
    const source = linkSnapshotRef.current;
    closeLink(false);
    emit('link', value, source ?? undefined);
  };

  const onToolbarKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    if (linkOpen) {
      event.stopPropagation();
      closeLink(true);
      return;
    }
    if (overflowOpen) {
      event.stopPropagation();
      closeOverflow(true);
    }
  };

  const onMenuKeyDown = (event) => {
    if (event.key === 'Escape') {
      closeOverflow(true);
      return;
    }
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll('[role="menuitem"]:not(:disabled)'),
    );
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    let next = 0;
    if (event.key === 'ArrowUp') next = current <= 0 ? items.length - 1 : current - 1;
    else if (event.key === 'ArrowDown') next = current < 0 || current === items.length - 1 ? 0 : current + 1;
    else if (event.key === 'End') next = items.length - 1;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div
      ref={rootRef}
      className="md-format-toolbar"
      role="toolbar"
      aria-label={nt('format')}
      aria-disabled={disabled || undefined}
      onKeyDown={onToolbarKeyDown}
    >
      <label className="md-format-toolbar__heading">
        <span className="md-format-toolbar__sr-only">{nt('heading')}</span>
        <select
          className="md-format-toolbar__select"
          aria-label={nt('heading')}
          value={String(active.heading)}
          disabled={disabled}
          onChange={(event) => emit('heading', Number(event.target.value))}
        >
          {HEADING_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.value === '0' ? nt(option.label) : option.label}</option>
          ))}
        </select>
      </label>

      <span className="md-format-toolbar__divider" aria-hidden="true" />

      <span className="md-format-toolbar__group" role="group" aria-label={nt('inline')}>
        <FormatButton
          label={nt('bold')}
          command="bold"
          disabled={disabled}
          active={active.bold}
          onPress={() => emit('bold')}
        >
          <Bold size={16} strokeWidth={1.8} aria-hidden="true" />
        </FormatButton>
        <FormatButton
          label={nt('italic')}
          command="italic"
          disabled={disabled}
          active={active.italic}
          onPress={() => emit('italic')}
        >
          <Italic size={16} strokeWidth={1.8} aria-hidden="true" />
        </FormatButton>
        <FormatButton
          label={nt('strike')}
          command="strike"
          disabled={disabled}
          active={active.strike}
          onPress={() => emit('strike')}
        >
          <Strikethrough size={16} strokeWidth={1.8} aria-hidden="true" />
        </FormatButton>
        <FormatButton
          label={nt('inline_code')}
          command="inline-code"
          disabled={disabled}
          active={active.inlineCode}
          onPress={() => emit('inline-code')}
        >
          <Code size={16} strokeWidth={1.8} aria-hidden="true" />
        </FormatButton>
        <button
          ref={linkButtonRef}
          type="button"
          className="md-format-toolbar__button"
          aria-label={nt('link')}
          aria-haspopup="dialog"
          aria-expanded={linkOpen}
          aria-controls={linkOpen ? linkDialogId : undefined}
          title={nt('link')}
          disabled={disabled}
          data-command="link"
          onMouseDown={(event) => event.preventDefault()}
          onClick={openLinkDialog}
        >
          <Icon><Link2 size={16} strokeWidth={1.8} aria-hidden="true" /></Icon>
        </button>
      </span>

      <span className="md-format-toolbar__divider" aria-hidden="true" />

      <span className="md-format-toolbar__group" role="group" aria-label={nt('paragraph')}>
        <FormatButton
          label={nt('bullet_list')}
          command="bullet-list"
          disabled={disabled}
          active={active.bulletList}
          onPress={() => emit('bullet-list')}
        >
          <List size={16} strokeWidth={1.8} aria-hidden="true" />
        </FormatButton>
        <FormatButton
          label={nt('ordered_list')}
          command="ordered-list"
          disabled={disabled}
          active={active.orderedList}
          onPress={() => emit('ordered-list')}
        >
          <ListOrdered size={16} strokeWidth={1.8} aria-hidden="true" />
        </FormatButton>
        <FormatButton
          label={nt('quote')}
          command="quote"
          disabled={disabled}
          active={active.quote}
          onPress={() => emit('quote')}
        >
          <Quote size={16} strokeWidth={1.8} aria-hidden="true" />
        </FormatButton>
      </span>

      <div ref={overflowRef} className="md-format-toolbar__overflow">
        <button
          ref={overflowButtonRef}
          type="button"
          className="md-format-toolbar__button"
          aria-label={nt('more')}
          aria-haspopup="menu"
          aria-expanded={overflowOpen}
          aria-controls={overflowOpen ? overflowMenuId : undefined}
          title={nt('more')}
          disabled={disabled}
          data-command="more"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOverflowOpen((open) => !open)}
        >
          <Icon><MoreHorizontal size={16} strokeWidth={1.8} aria-hidden="true" /></Icon>
        </button>
        {overflowOpen && (
          <div
            id={overflowMenuId}
            className="md-format-toolbar__menu"
            role="menu"
            aria-label={nt('more')}
            onKeyDown={onMenuKeyDown}
          >
            <MenuButton
              label={nt('code_block')}
              command="code-block"
              disabled={disabled}
              onPress={() => { closeOverflow(true); emit('code-block'); }}
            >
              <Code2 size={15} strokeWidth={1.8} aria-hidden="true" />
            </MenuButton>
            <MenuButton
              label={nt('table')}
              command="table"
              disabled={disabled}
              onPress={() => { closeOverflow(true); emit('table'); }}
            >
              <Table size={15} strokeWidth={1.8} aria-hidden="true" />
            </MenuButton>
            <span className="md-format-toolbar__menu-separator" role="separator" aria-hidden="true" />
            <MenuButton
              label={nt('undo')}
              command="undo"
              disabled={disabled}
              onPress={() => { closeOverflow(true); emit('undo'); }}
            >
              <Undo2 size={15} strokeWidth={1.8} aria-hidden="true" />
            </MenuButton>
            <MenuButton
              label={nt('redo')}
              command="redo"
              disabled={disabled}
              onPress={() => { closeOverflow(true); emit('redo'); }}
            >
              <Redo2 size={15} strokeWidth={1.8} aria-hidden="true" />
            </MenuButton>
          </div>
        )}
      </div>

      {linkOpen && (
        <form
          ref={linkRef}
          id={linkDialogId}
          className="md-format-toolbar__dialog"
          role="dialog"
          aria-modal="false"
          aria-labelledby={dialogTitleId}
          onSubmit={submitLink}
        >
          <h2 id={dialogTitleId} className="md-format-toolbar__sr-only">{nt('insert_link')}</h2>
          <label className="md-format-toolbar__field">
            <span>{nt('link_address')}</span>
            <input
              ref={hrefInputRef}
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://"
              value={linkDraft.href}
              onChange={(event) => {
                setLinkError('');
                setLinkDraft((draft) => ({ ...draft, href: event.target.value }));
              }}
            />
          </label>
          <label className="md-format-toolbar__field">
            <span>{nt('link_text')}</span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={active.link ? active.linkText : nt('keep_text')}
              value={linkDraft.text}
              onChange={(event) => {
                setLinkError('');
                setLinkDraft((draft) => ({ ...draft, text: event.target.value }));
              }}
            />
          </label>
          {linkError && <p className="md-format-toolbar__error" role="alert">{nt(linkError)}</p>}
          <div className="md-format-toolbar__actions">
            <button
              type="button"
              className="md-format-toolbar__action"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => closeLink(true)}
            >
              {nt('cancel')}
            </button>
            <button type="submit" className="md-format-toolbar__action is-primary" disabled={disabled}>
              {nt('apply_link')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
