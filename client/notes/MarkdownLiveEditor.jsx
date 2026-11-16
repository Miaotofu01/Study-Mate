import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LanguageDescription } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { blockEdit } from '@milkdown/crepe/feature/block-edit';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { cursor } from '@milkdown/crepe/feature/cursor';
import { imageBlock } from '@milkdown/crepe/feature/image-block';
import { latex } from '@milkdown/crepe/feature/latex';
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip';
import { listItem } from '@milkdown/crepe/feature/list-item';
import { placeholder } from '@milkdown/crepe/feature/placeholder';
import { table } from '@milkdown/crepe/feature/table';
import { toolbar } from '@milkdown/crepe/feature/toolbar';
import { MAX_MARKDOWN_LENGTH } from './MarkdownEditor.jsx';
import '@milkdown/crepe/theme/common/prosemirror.css';
import '@milkdown/crepe/theme/common/reset.css';
import '@milkdown/crepe/theme/common/block-edit.css';
import '@milkdown/crepe/theme/common/code-mirror.css';
import '@milkdown/crepe/theme/common/cursor.css';
import '@milkdown/crepe/theme/common/image-block.css';
import '@milkdown/crepe/theme/common/link-tooltip.css';
import '@milkdown/crepe/theme/common/list-item.css';
import '@milkdown/crepe/theme/common/placeholder.css';
import '@milkdown/crepe/theme/common/toolbar.css';
import '@milkdown/crepe/theme/common/table.css';
import '@milkdown/crepe/theme/common/latex.css';
import '@milkdown/crepe/theme/classic.css';
import './live-editor.css';

const OVERSIZE_MESSAGE = '正文最多 128 Ki 字符；这次修改未写入，原稿已保留。';
const LOAD_ERROR = '即时编辑器载入失败；请切换到源码继续，原稿没有被改写。';
const CHANGE_ERROR = '这次修改未能写入；已恢复上一次内容。';
const UPLOAD_DISABLED = '本页不接收图片上传。';
const LOSSY_PASTE = '检测到 HTML 或扩展语法；已切换到源码，请重新粘贴以保留原文。';
const BLOCKED_IMAGE = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80" viewBox="0 0 320 80">'
  + '<rect width="320" height="80" rx="6" fill="#f1f5f2" stroke="#cddbd2" stroke-dasharray="4 3"/>'
  + '<text x="160" y="46" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#7a8981">图片已阻止</text>'
  + '</svg>',
);

const KATEX_OPTIONS = Object.freeze({
  throwOnError: false,
  strict: false,
  maxExpand: 500,
  maxSize: 15,
});

// Keep the code-block picker useful without importing @codemirror/language-data,
// whose dynamic language table would pull every CodeMirror language into the
// single-file client bundle.
const CODE_LANGUAGES = Object.freeze([
  LanguageDescription.of({
    name: 'JavaScript', alias: ['js', 'jsx', 'javascript'], extensions: ['js', 'jsx'],
    support: javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: 'TypeScript', alias: ['ts', 'tsx', 'typescript'], extensions: ['ts', 'tsx'],
    support: javascript({ jsx: true, typescript: true }),
  }),
  LanguageDescription.of({ name: 'Python', alias: ['py', 'python'], extensions: ['py'], support: python() }),
  LanguageDescription.of({ name: 'HTML', alias: ['html', 'xml'], extensions: ['html', 'xml'], support: html() }),
  LanguageDescription.of({ name: 'CSS', alias: ['css'], extensions: ['css'], support: css() }),
  LanguageDescription.of({ name: 'JSON', alias: ['json'], extensions: ['json'], support: json() }),
]);

const HTML_TAGS = [
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'blockquote',
  'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist',
  'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'i',
  'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'menu',
  'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p', 'param',
  'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'section', 'select',
  'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'svg', 'table', 'tbody',
  'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var',
  'video', 'wbr',
];
const HTML_TAG_RE = new RegExp('</?(?:' + HTML_TAGS.join('|') + ')(?=[\\s/>])[^>]*>', 'i');
const CUSTOM_TAG_RE = /<\/?[a-z][\w-]*-[\w-]*\b[^>]*>/i;
const JSX_TAG_RE = /<\/?[A-Z][\w.:-]*\b[^>]*>/;

function stripCode(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const visible = [];
  let fence = '';
  for (const line of lines) {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = match[1][0];
      else if (match[1][0] === fence) fence = '';
      continue;
    }
    if (fence) continue;
    visible.push(line.replace(/`[^`\n]*`/g, ''));
  }
  return visible.join('\n');
}

/** Content Crepe would normalize or drop; such notes open in source mode. */
export function isLossyMarkdown(markdown) {
  const text = stripCode(markdown);
  if (!text.trim()) return false;
  if (/^---\s*\r?\n[\s\S]*?\r?\n---(?:\s*\r?\n|$)/.test(text)) return true;
  if (/<!--/.test(text)) return true;
  if (JSX_TAG_RE.test(text)) return true;
  // Crepe serializes a hard break as <br>; that is a known, contents-preserving
  // construct, not the kind of opaque HTML that should force source mode.
  const htmlProbe = text.replace(/<br\s*\/?>/gi, '');
  if (HTML_TAG_RE.test(htmlProbe) || CUSTOM_TAG_RE.test(htmlProbe)) return true;
  if (/^:::+|^\{%.*?%\}\s*$/m.test(text)) return true;
  if (/\[\[[^\]]+\]\]/.test(text)) return true;
  if (/\[\^[^\]]+\]/.test(text)) return true;
  if (/\\\(|\\\[/.test(text)) return true;
  if (/^>\s*\[![A-Z]+\]/m.test(text)) return true;
  if (/==[^=\n]+==/.test(text)) return true;
  return false;
}

/** Only absolute http(s) links may leave the editor. */
export function safeExternalHref(value) {
  const text = String(value || '').trim();
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function rejectUpload() {
  return Promise.reject(new Error(UPLOAD_DISABLED));
}

const IMAGE_CONFIG = {
  onUpload: rejectUpload,
  inlineOnUpload: rejectUpload,
  blockOnUpload: rejectUpload,
  proxyDomURL: () => BLOCKED_IMAGE,
  onImageLoadError: () => {},
  inlineUploadButton: '上传已禁用',
  blockUploadButton: '上传已禁用',
};

export default function MarkdownLiveEditor({
  value = '',
  onChange,
  onRequestSource,
  readOnly = false,
  theme = 'light',
  label = 'Markdown 正文',
}) {
  const hostRef = useRef(null);
  const crepeRef = useRef(null);
  const rebuildRef = useRef(null);
  const readyRef = useRef(false);
  const suppressRef = useRef(false);
  const composingRef = useRef(false);
  const pendingExternalRef = useRef(null);
  const unmountedRef = useRef(false);
  const generationRef = useRef(0);
  const acceptedRef = useRef(String(value || ''));
  const baselineRef = useRef(String(value || ''));
  const inputDirtyRef = useRef(false);
  const flushRef = useRef(null);
  const lastValueRef = useRef(String(value || ''));
  const lastEmittedRef = useRef(String(value || ''));
  const readOnlyRef = useRef(readOnly);
  const onChangeRef = useRef(onChange);
  const onRequestSourceRef = useRef(onRequestSource);
  const [error, setError] = useState('');

  onChangeRef.current = onChange;
  onRequestSourceRef.current = onRequestSource;
  readOnlyRef.current = readOnly;

  const readCurrent = useCallback(() => {
    const builder = crepeRef.current;
    if (builder && readyRef.current) {
      try {
        const markdown = builder.getMarkdown();
        if (markdown === acceptedRef.current) return acceptedRef.current;
        // Crepe normalizes the document during the initial mount. Until the
        // user actually changes the document, keep returning the original
        // raw bytes; this is what the source view must show.
        if (markdown === baselineRef.current && !inputDirtyRef.current) {
          return acceptedRef.current;
        }
        return markdown;
      } catch {
        // Fall through to the last accepted value.
      }
    }
    return acceptedRef.current;
  }, []);

  const commitMarkdown = useCallback((markdown, silent = false) => {
    // An empty document is a legitimate edit: deleting all text must reach
    // onChange as ''. Only non-string callback payloads are ignored.
    if (typeof markdown !== 'string') return true;
    if (markdown === acceptedRef.current) return true;
    if (markdown === baselineRef.current && !inputDirtyRef.current) return true;
    if (markdown.length > MAX_MARKDOWN_LENGTH) {
      if (!silent) setError(OVERSIZE_MESSAGE);
      return false;
    }
    let accepted = true;
    try {
      accepted = onChangeRef.current?.(markdown) !== false;
    } catch {
      accepted = false;
    }
    if (!accepted) {
      if (!silent) setError(CHANGE_ERROR);
      return false;
    }
    acceptedRef.current = markdown;
    lastEmittedRef.current = markdown;
    inputDirtyRef.current = false;
    if (!silent) setError((current) => (current ? '' : current));
    return true;
  }, []);

  const flush = useCallback((silent = false) => {
    const builder = crepeRef.current;
    if (!builder || !readyRef.current) return true;
    let markdown;
    try {
      markdown = builder.getMarkdown();
    } catch {
      return false;
    }
    return commitMarkdown(markdown, silent);
  }, [commitMarkdown]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const scheduleRebuild = useCallback((next) => {
    if (composingRef.current) {
      pendingExternalRef.current = next;
      return;
    }
    setTimeout(() => {
      if (!unmountedRef.current) void rebuildRef.current?.(next);
    }, 0);
  }, []);

  const createEditor = useCallback(async (initial, token) => {
    const host = hostRef.current;
    if (!host) return;
    const builder = new CrepeBuilder({ root: host, defaultValue: initial });
    builder
      .addFeature(codeMirror, { languages: CODE_LANGUAGES, theme: [] })
      .addFeature(latex, { katexOptions: KATEX_OPTIONS })
      .addFeature(table)
      .addFeature(imageBlock, IMAGE_CONFIG)
      .addFeature(toolbar)
      .addFeature(listItem)
      .addFeature(linkTooltip)
      .addFeature(cursor)
      .addFeature(blockEdit)
      .addFeature(placeholder, { text: '输入 Markdown，或切换到源码粘贴…', mode: 'doc' });

    builder.on((listener) => {
      listener.updated((_ctx, doc, prevDoc) => {
        // A destroyed builder can still deliver its last debounced update.
        // Ignore anything that belongs to an older generation.
        if (token !== generationRef.current || !readyRef.current || suppressRef.current) return;
        if (!doc || !prevDoc || doc.eq(prevDoc)) return;
        let markdown;
        try {
          markdown = builder.getMarkdown();
        } catch {
          return;
        }
        if (!commitMarkdown(markdown)) {
          scheduleRebuild(acceptedRef.current);
        }
      });
    });

    try {
      await builder.create();
    } catch {
      if (token === generationRef.current && !unmountedRef.current) {
        setError(LOAD_ERROR);
        suppressRef.current = false;
      }
      return;
    }
    if (unmountedRef.current || token !== generationRef.current) {
      try {
        await builder.destroy();
      } catch {
        // The stale instance is already detached.
      }
      return;
    }
    crepeRef.current = builder;
    acceptedRef.current = initial;
    lastEmittedRef.current = initial;
    try {
      baselineRef.current = builder.getMarkdown();
    } catch {
      baselineRef.current = initial;
    }
    inputDirtyRef.current = false;
    readyRef.current = true;
    suppressRef.current = false;
    if (readOnlyRef.current) builder.setReadonly(true);
  }, [commitMarkdown, scheduleRebuild]);

  const rebuild = useCallback(async (next) => {
    const host = hostRef.current;
    if (!host) return;
    const token = ++generationRef.current;
    readyRef.current = false;
    suppressRef.current = true;
    const old = crepeRef.current;
    crepeRef.current = null;
    if (old) {
      try {
        await old.destroy();
      } catch {
        // Continue with a fresh instance even if cleanup reported a failure.
      }
    }
    if (unmountedRef.current || token !== generationRef.current) return;
    host.replaceChildren();
    await createEditor(next, token);
  }, [createEditor]);

  useEffect(() => {
    rebuildRef.current = rebuild;
  }, [rebuild]);

  useEffect(() => {
    unmountedRef.current = false;
    const host = hostRef.current;
    if (!host) return undefined;
    void rebuild(lastValueRef.current);

    const onCompositionStart = () => { composingRef.current = true; };
    const onCompositionEnd = (event) => {
      composingRef.current = false;
      if (event?.data) inputDirtyRef.current = true;
      const pending = pendingExternalRef.current;
      pendingExternalRef.current = null;
      // The IME has just committed text into the DOM. Flush that text first;
      // rebuilding from a pending external prop here would discard the user's
      // new characters (the prop is often just an older onChange echo).
      if (inputDirtyRef.current) {
        flushRef.current?.(false);
        return;
      }
      if (pending != null && pending !== acceptedRef.current) void rebuild(pending);
    };
    const onInput = () => { inputDirtyRef.current = true; };
    const followSafeLink = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest('a[href], button[data-href]');
      if (!anchor || !host.contains(anchor)) return false;
      event.preventDefault();
      event.stopPropagation();
      const href = safeExternalHref(anchor.getAttribute('href') || anchor.getAttribute('data-href'));
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
      return true;
    };
    const onClick = (event) => {
      followSafeLink(event);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') followSafeLink(event);
    };
    const onPaste = (event) => {
      if (event.clipboardData?.files?.length) {
        event.preventDefault();
        event.stopPropagation();
        setError(UPLOAD_DISABLED);
        return;
      }
      const html = event.clipboardData?.getData('text/html') || '';
      const text = event.clipboardData?.getData('text/plain');
      // A rich HTML payload can smuggle an <img src> or CSS url() even when
      // there is no plain-text alternative. Never let it reach the editor.
      if (/<img\b|src\s*=|url\s*\(|background-image/i.test(html)) {
        event.preventDefault();
        event.stopPropagation();
        setError(UPLOAD_DISABLED);
        return;
      }
      if (html && !text) {
        event.preventDefault();
        event.stopPropagation();
        setError(LOSSY_PASTE);
        onRequestSourceRef.current?.(readCurrent());
        return;
      }
      if (!text || !isLossyMarkdown(text)) {
        inputDirtyRef.current = true;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setError(LOSSY_PASTE);
      onRequestSourceRef.current?.(readCurrent());
    };
    const onDrop = (event) => {
      const hasFiles = Boolean(event.dataTransfer?.files?.length);
      const hasHtml = Array.from(event.dataTransfer?.types || []).includes('text/html');
      if (!hasFiles && !hasHtml) {
        inputDirtyRef.current = true;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setError(hasFiles ? UPLOAD_DISABLED : LOSSY_PASTE);
      if (hasHtml && !hasFiles) onRequestSourceRef.current?.(readCurrent());
    };
    host.addEventListener('compositionstart', onCompositionStart, true);
    host.addEventListener('compositionend', onCompositionEnd, true);
    host.addEventListener('input', onInput, true);
    host.addEventListener('click', onClick, true);
    host.addEventListener('auxclick', onClick, true);
    host.addEventListener('keydown', onKeyDown, true);
    host.addEventListener('paste', onPaste, true);
    host.addEventListener('drop', onDrop, true);

    return () => {
      // Milkdown's listener debounces for 200ms and destroy() cancels the
      // pending transaction. Flush once more before teardown so a quick tab
      // switch cannot lose the last keystrokes.
      if (readyRef.current) flushRef.current?.(true);
      unmountedRef.current = true;
      generationRef.current += 1;
      readyRef.current = false;
      if (crepeRef.current) {
        const old = crepeRef.current;
        crepeRef.current = null;
        try {
          void Promise.resolve(old.destroy()).catch(() => {});
        } catch {
          // Nothing else to clean up.
        }
      }
      host.removeEventListener('compositionstart', onCompositionStart, true);
      host.removeEventListener('compositionend', onCompositionEnd, true);
      host.removeEventListener('input', onInput, true);
      host.removeEventListener('click', onClick, true);
      host.removeEventListener('auxclick', onClick, true);
      host.removeEventListener('keydown', onKeyDown, true);
      host.removeEventListener('paste', onPaste, true);
      host.removeEventListener('drop', onDrop, true);
      host.replaceChildren();
    };
  }, [rebuild, readCurrent]);

  useEffect(() => {
    const next = String(value || '');
    if (next === lastValueRef.current) return;
    lastValueRef.current = next;
    if (next === lastEmittedRef.current || next === acceptedRef.current) return;
    if (next.length > MAX_MARKDOWN_LENGTH) {
      setError(OVERSIZE_MESSAGE);
      return;
    }
    pendingExternalRef.current = next;
    if (!composingRef.current) {
      const pending = pendingExternalRef.current;
      pendingExternalRef.current = null;
      void rebuild(pending);
    }
  }, [value, rebuild]);

  useEffect(() => {
    const builder = crepeRef.current;
    if (builder && readyRef.current) {
      try {
        builder.setReadonly(readOnly);
      } catch {
        // A rebuild will apply the latest readOnly value.
      }
    }
  }, [readOnly]);

  useEffect(() => {
    hostRef.current?.setAttribute('aria-label', label);
  }, [label]);

  return (
    <div className="studymate-notes markdown-live-editor" data-theme={theme} data-testid="markdown-live-editor">
      <div className="markdown-live-editor__bar">
        <span className="markdown-live-editor__mode">即时编辑</span>
        <button
          type="button"
          className="markdown-live-editor__source"
          onClick={() => {
            flushRef.current?.(false);
            onRequestSourceRef.current?.(readCurrent());
          }}
          title="切换到 Markdown 源码；源码保留原始字节"
        >源码模式</button>
      </div>
      <p className="markdown-live-editor__hint" role="note">
        富文本编辑会规范化 Markdown；未编辑时保留原文，需要逐字保真时请用源码模式。
      </p>
      <div className="markdown-live-editor__host" ref={hostRef} aria-label={label} />
      {error && <p className="validation-error" role="alert">{error}</p>}
    </div>
  );
}
