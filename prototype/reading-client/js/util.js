/* ─────────────────────────────────────────────────────────────────────────
   共用小工具：DOM 构造、行内 Markdown、图标、跨变体记住「你看到哪」。

   这一层与版式无关，所以三个变体共用；一旦某个东西开始决定「东西摆在哪」，
   它就该属于变体自己的文件，不属于这里。
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  const SM = (window.SM = window.SM || {});
  // 变体注册表得在这里就存在：变体文件在 app.js 之前加载，各自往里 push。
  SM.variants = SM.variants || [];

  /* ── DOM ──────────────────────────────────────────────────────────────── */

  function append(parent, kids) {
    for (const kid of kids) {
      if (kid == null || kid === false || kid === true) continue;
      if (Array.isArray(kid)) append(parent, kid);
      else if (kid instanceof Node) parent.appendChild(kid);
      else parent.appendChild(document.createTextNode(String(kid)));
    }
  }

  /** h('div.card', {on:{click}}, ...children) —— tag 里带 .class 缩写。 */
  function h(sel, props, ...kids) {
    const [tag, ...classes] = String(sel).split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === 'class') el.className = el.className ? el.className + ' ' + value : value;
        else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
        else if (key === 'text') el.textContent = value;
        else if (key === 'html') el.innerHTML = value;
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else if (key === 'on') { for (const [ev, fn] of Object.entries(value)) el.addEventListener(ev, fn); }
        else if (key in el && typeof value !== 'object') {
          try { el[key] = value; } catch { el.setAttribute(key, value === true ? '' : value); }
        } else el.setAttribute(key, value === true ? '' : value);
      }
    }
    append(el, kids);
    return el;
  }

  const frag = (...kids) => { const f = document.createDocumentFragment(); append(f, kids); return f; };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

  /* ── 行内 Markdown ────────────────────────────────────────────────────── */
  // 课件正文里真正用到的只有这四种行内标记；不引 Markdown 库，避免原型拖一个依赖进来。
  const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\$[^$\n]+\$|\[[^\]]+\]\([^)\s]+\))/g;

  function inline(text) {
    const out = document.createDocumentFragment();
    const parts = String(text).split(INLINE).filter((p) => p !== '' && p != null);
    for (const part of parts) {
      if (/^\*\*[^*]+\*\*$/.test(part)) out.appendChild(h('strong', { text: part.slice(2, -2) }));
      else if (/^`[^`]+`$/.test(part)) out.appendChild(h('code', { text: part.slice(1, -1) }));
      else if (/^\$[^$\n]+\$$/.test(part)) out.appendChild(h('span.sm-math-inline', { text: part.slice(1, -1) }));
      else {
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
        if (link) out.appendChild(h('a', { href: link[2], target: '_blank', rel: 'noreferrer', text: link[1] }));
        else out.appendChild(document.createTextNode(part));
      }
    }
    return out;
  }

  /* ── 图标 ─────────────────────────────────────────────────────────────── */
  // 一律 currentColor + stroke，尺寸跟着字号走；不用图标字体，避免离线时缺字。
  const PATHS = {
    search: '<circle cx="7.5" cy="7.5" r="4.5"/><path d="M11 11l3.5 3.5"/>',
    left: '<path d="M9.5 4.5L5 9l4.5 4.5"/>',
    right: '<path d="M6.5 4.5L11 9l-4.5 4.5"/>',
    chevron: '<path d="M5.5 7.5L9 11l3.5-3.5"/>',
    check: '<path d="M4.5 9.5l3 3 6-7"/>',
    close: '<path d="M5 5l8 8M13 5l-8 8"/>',
    sun: '<circle cx="9" cy="9" r="3.2"/><path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M3.7 14.3l1.4-1.4M12.9 5.1l1.4-1.4"/>',
    moon: '<path d="M14.5 11A5.5 5.5 0 016.9 3.4a5.8 5.8 0 107.6 7.6z"/>',
    ask: '<path d="M3 4.2A1.2 1.2 0 014.2 3h9.6A1.2 1.2 0 0115 4.2v6.6a1.2 1.2 0 01-1.2 1.2H8l-3.4 3v-3H4.2A1.2 1.2 0 013 10.8z"/>',
    lab: '<path d="M7 2.5v4.2L3.6 13a1.3 1.3 0 001.1 2h8.6a1.3 1.3 0 001.1-2L11 6.7V2.5"/><path d="M6 2.5h6"/>',
    doc: '<path d="M4.5 2.5h6l3 3v10h-9z"/><path d="M10.5 2.5v3h3"/>',
    map: '<path d="M2.5 4.5l4-1.5 5 1.5 4-1.5v10l-4 1.5-5-1.5-4 1.5z"/><path d="M6.5 3v11.5M11.5 4.5V16"/>',
    list: '<path d="M6 4.5h9M6 9h9M6 13.5h9M3 4.5h.01M3 9h.01M3 13.5h.01"/>',
    spark: '<path d="M9 2.5l1.6 4.4 4.4 1.6-4.4 1.6L9 14.5l-1.6-4.4L3 8.5l4.4-1.6z"/>',
    warn: '<path d="M9 3.2l6.4 11H2.6z"/><path d="M9 7.5v3M9 12.6h.01"/>',
    refresh: '<path d="M14.5 9a5.5 5.5 0 11-1.8-4.1"/><path d="M14.6 2.8v3.4h-3.4"/>',
  };

  function icon(name, size = 16) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 18 18');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = PATHS[name] || '';
    return svg;
  }

  /* ── 文本 ─────────────────────────────────────────────────────────────── */

  const KIND = { 概念: 'concept', 实操: 'practice', 实验: 'lab' };
  const kindClass = (kind) => KIND[kind] || 'concept';

  /** 把进度笔记里那串日期抽出来，用于「上次学到」；抽不到就返回空串。 */
  function lastDate(text) {
    const m = /(\d{1,2})-(\d{1,2})\b/.exec(text || '');
    return m ? `${m[1]}-${m[2]}` : '';
  }

  function truncate(text, max) {
    const s = String(text || '').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function splitSentences(text) {
    return String(text || '').split(/(?<=[。！？；])/).map((s) => s.trim()).filter(Boolean);
  }

  /* ── 会话级位置记忆：切换变体时不把你丢回首页 ─────────────────────────── */
  const KEY = 'sm-proto-here';

  SM.session = {
    read() {
      try { return JSON.parse(sessionStorage.getItem(KEY)) || {}; } catch { return {}; }
    },
    write(patch) {
      const next = Object.assign(this.read(), patch);
      try { sessionStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 隐私模式下写不进去就算了 */ }
      return next;
    },
  };

  /* ── 主题与动效档 ─────────────────────────────────────────────────────── */
  SM.theme = {
    get() { return document.documentElement.dataset.theme || 'dark'; },
    set(value) {
      document.documentElement.dataset.theme = value;
      try { localStorage.setItem('sm-proto-theme', value); } catch {}
      window.dispatchEvent(new CustomEvent('sm:theme', { detail: value }));
    },
    toggle() { this.set(this.get() === 'dark' ? 'light' : 'dark'); },
    restore() {
      // ?theme=light|dark 直接定死主题，给截图与「亮暗两套都要过对比度」的自查用；
      // 没带参数时才读本地存的那份。
      const forced = new URLSearchParams(location.search).get('theme');
      if (forced === 'light' || forced === 'dark') { document.documentElement.dataset.theme = forced; return; }
      let saved = null;
      try { saved = localStorage.getItem('sm-proto-theme'); } catch {}
      if (saved) document.documentElement.dataset.theme = saved;
    },
  };

  Object.assign(SM, { h, frag, clear, append, inline, icon, kindClass, lastDate, truncate, splitSentences });
})();
