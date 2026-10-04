/* ─────────────────────────────────────────────────────────────────────────
   课件内容文件解析器 —— 把 lessons/<NNNN>-<节点id>.md 读成块数组。

   这是「渲染从 Python 搬到阅读端」那条决策的落点：Python 侧从此只写内容文件，
   块词汇（::: quiz / ::: svg / ::: practice / ::: term / ::: resources）由这里解释。

   解析与渲染分给两处，是刻意的：
     · 解析（本文件）与版式无关，三个变体共用一份，保证比对的是版式不是解析差异；
     · 块级渲染也放在这里（一段正文、一张表、一道题长什么样，是内容的事）；
     · **块的编排不在这里**——题目在不在流里、正文分不分屏，由变体自己决定。
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  const SM = (window.SM = window.SM || {});
  const { h, inline, icon } = SM;

  /* ── 解析 ─────────────────────────────────────────────────────────────── */

  function splitFrontmatter(markdown) {
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(markdown);
    if (!m) return { meta: {}, body: markdown };
    const meta = {};
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
    return { meta, body: markdown.slice(m[0].length) };
  }

  function isBlank(line) { return /^\s*$/.test(line); }

  function parseBlocks(lines) {
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (isBlank(line)) { i++; continue; }

      // ::: 容器块 —— 开一行、闭一行，两个变体都靠它定位题目锚点
      const open = /^:::\s*([a-z]+)\s*(.*)$/.exec(line);
      if (open) {
        const body = [];
        i++;
        while (i < lines.length && !/^:::\s*$/.test(lines[i])) body.push(lines[i++]);
        i++; // 吃掉闭合的 :::
        blocks.push(makeDirective(open[1], open[2].trim(), body));
        continue;
      }

      const fence = /^```(\w*)\s*$/.exec(line);
      if (fence) {
        const code = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
        i++;
        blocks.push({ type: 'code', lang: fence[1] || 'text', code: code.join('\n'), term: fence[1] === 'term' });
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() }); i++; continue; }

      if (/^\$\$\s*$/.test(line)) {
        const tex = [];
        i++;
        while (i < lines.length && !/^\$\$\s*$/.test(lines[i])) tex.push(lines[i++]);
        i++;
        blocks.push({ type: 'math', tex: tex.join('\n').trim() });
        continue;
      }

      if (/^\|/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
        blocks.push(makeTable(rows));
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
        blocks.push({ type: 'quote', text: quote.join(' ').trim() });
        continue;
      }

      if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
        const ordered = /^\d+\.\s+/.test(line);
        const items = [];
        while (i < lines.length && (/^[-*]\s+/.test(lines[i]) || /^\d+\.\s+/.test(lines[i]))) {
          items.push(lines[i++].replace(/^([-*]|\d+\.)\s+/, '').trim());
        }
        blocks.push({ type: 'list', ordered, items });
        continue;
      }

      const para = [line];
      i++;
      while (i < lines.length && !isBlank(lines[i]) && !/^:::|^```|^#{1,6}\s|^\||^>|^\$\$\s*$|^[-*]\s|^\d+\.\s/.test(lines[i])) {
        para.push(lines[i++]);
      }
      const text = para.join(' ').trim();
      const blockMath = /^\$\$([\s\S]+)\$\$$/.exec(text);
      if (blockMath) blocks.push({ type: 'math', tex: blockMath[1].trim() });
      else blocks.push({ type: 'para', text });
    }
    return blocks;
  }

  function makeTable(rows) {
    const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = cells(rows[0]);
    const body = rows.slice(1).filter((r) => !/^\|[\s:|-]+\|$/.test(r)).map(cells);
    return { type: 'table', head, rows: body };
  }

  // 图与示意图共用一条编号序列，只给「有 caption 的」编号（格式规范 §4：没可见标签就不占号）
  let figureSeq = 0;

  /** 列表条目：`- [标题](链接) | 说明` 或 `- 标题 | 说明`（没有链接的，例如一本书）。 */
  function parseItems(lines) {
    const items = [];
    for (const raw of lines) {
      const text = raw.trim();
      if (!text.startsWith('- ')) continue;
      const body = text.slice(2).trim();
      const linked = /^\[([^\]]+)\]\(([^)\s]+)\)\s*(?:\|\s*(.*))?$/.exec(body);
      if (linked) items.push({ text: linked[1], href: linked[2], note: (linked[3] || '').trim() });
      else {
        const [title, ...rest] = body.split('|');
        items.push({ text: title.trim(), href: '', note: rest.join('|').trim() });
      }
    }
    return items;
  }

  function makeDirective(name, header, body) {
    if (name === 'quiz') {
      const anchor = /锚点：(.*)$/.exec(header);
      // empty_reason: 是**有理由地不出题**，与「锚点在题库里找不到」是两件事，别混成一个错误
      const reason = (/^empty_reason:\s*(.*)$/m.exec(body.join('\n')) || [])[1] || '';
      return {
        type: 'quiz',
        level: header.replace(/锚点：.*$/, '').trim(),
        anchor: anchor ? anchor[1].trim() : '',
        emptyReason: reason.trim(),
      };
    }
    if (name === 'svg' || name === 'figure') {
      const text = body.join('\n');
      const alt = (/^alt:\s*(.*)$/m.exec(text) || [])[1] || '';
      const caption = (/^caption:\s*(.*)$/m.exec(text) || [])[1].replace(/^图\s*\d+\s*·\s*/, '') || '';
      const block = { type: 'figure', kind: name, alt, caption, figureNo: caption ? ++figureSeq : 0 };
      if (name === 'svg') block.svg = (/<svg[\s\S]*<\/svg>/.exec(text) || [])[0] || '';
      else block.src = header.trim();
      return block;
    }
    if (name === 'practice') {
      const [kind, ...rest] = header.split('|');
      return { type: 'practice', kind: (kind || '动手做').trim(), title: rest.join('|').trim(), blocks: parseBlocks(body) };
    }
    if (name === 'resources' || name === 'related') return { type: name, items: parseItems(body) };
    if (name === 'tip' || name === 'warn' || name === 'note') {
      return { type: 'callout', tone: name, title: header.trim(), blocks: parseBlocks(body) };
    }
    // 未知块：不吞掉，原样降级成一段能看见的提示。规范里「认不出就报错」由校验器负责，
    // 阅读端只负责别把学生的正文吞掉。
    return { type: 'unknown', name, header, text: body.join('\n').trim() };
  }

  function slugify(text, index) { return 'sec-' + index; }

  /** 按 h2 切段：TOC、分屏、进度条都以 section 为单位。 */
  function toSections(blocks, meta) {
    const sections = [];
    let current = { index: 0, title: meta.title || '正文', blocks: [] };
    for (const block of blocks) {
      if (block.type === 'heading' && block.level === 2) {
        if (current.blocks.length || sections.length === 0) sections.push(current);
        current = { index: sections.length, title: block.text, blocks: [] };
        current.id = slugify(block.text, current.index);
        continue;
      }
      current.blocks.push(block);
    }
    if (!current.id) { current.id = slugify(current.title, current.index); }
    sections.push(current);
    // 去掉「第一个空壳」（正文直接从 h2 开始时会出现）
    return sections.filter((s, i) => s.blocks.length > 0 || i === 0);
  }

  function parseLesson(markdown) {
    figureSeq = 0;
    const { meta, body } = splitFrontmatter(markdown);
    const blocks = parseBlocks(body.split('\n'));
    const sections = toSections(blocks, meta);
    let quizIndex = 0;
    for (const block of blocks) {
      if (block.type === 'quiz') block.quizIndex = quizIndex++;
    }
    return { meta, blocks, sections };
  }

  /* ── 块级渲染（内容排版，非版式）───────────────────────────────────────── */

  function renderCode(block) {
    const bar = h('div.sm-code__bar', null,
      h('b', { text: block.term ? '运行结果' : (block.lang || 'text') }),
      block.term ? h('span', { text: '· 你在终端里会看到的输出' }) : null);
    return h('div.sm-code' + (block.term ? '.sm-code--term' : ''), null, bar, h('pre', null, h('code', { text: block.code })));
  }

  function renderTable(block) {
    return h('div.sm-table-wrap', null,
      h('table.sm-table', null,
        h('thead', null, h('tr', null, block.head.map((cell) => h('th', null, inline(cell))))),
        h('tbody', null, block.rows.map((row) => h('tr', null, row.map((cell) => h('td', null, inline(cell))))))));
  }

  function renderFigure(block, ctx) {
    const caption = block.caption
      ? h('figcaption', null, block.figureNo ? h('b', { text: `图 ${block.figureNo} · ` }) : null, inline(block.caption))
      : null;
    if (block.kind === 'figure') {
      // 路径按课件目录（lessons/）解析：示例工作区里没有图，这条路径没被真数据走过。
      const base = (ctx && ctx.assetBase) || '';
      return h('figure.sm-figure', null,
        h('div.sm-figure__frame', null, h('img', { src: base + block.src, alt: block.alt, loading: 'lazy' })),
        caption);
    }
    // 原型直接吃仓库里的示例 SVG（可信来源）。真阅读端要对模型产出的 SVG 做白名单清洗。
    const frame = h('div.sm-figure__frame', { role: 'img', 'aria-label': block.alt || block.caption || '配图' });
    frame.innerHTML = block.svg;
    return h('figure.sm-figure', null, frame, caption);
  }

  function renderCallout(block, ctx) {
    const tone = block.tone === 'tip' ? 'brand' : block.tone === 'warn' ? 'warn' : '';
    return h('div.sm-note' + (tone ? '.sm-note--' + tone : ''), null,
      icon(block.tone === 'warn' ? 'warn' : block.tone === 'tip' ? 'spark' : 'doc', 16),
      h('div', null, block.title ? h('b', { text: block.title }) : null, renderBlocks(block.blocks, ctx)));
  }

  function renderLinkList(block, cssClass) {
    return h(block.type === 'related' ? 'div' : 'section', { class: cssClass },
      h('ul', { style: { margin: '0', paddingLeft: '1.2em' } }, block.items.map((item) => h('li', null,
        item.href ? h('a', { href: item.href, target: '_blank', rel: 'noreferrer', text: item.text }) : h('span', { text: item.text }),
        item.note ? h('span', { style: { color: 'var(--dsw-alias-label-caption)' }, text: ' · ' + item.note }) : null))));
  }

  function renderPractice(block, ctx) {
    return h('section.sm-practice', null,
      h('div.sm-practice__head', null, icon('lab', 15), block.title || block.kind, h('span', { text: block.kind })),
      h('div.sm-practice__body', null, renderBlocks(block.blocks, ctx)));
  }

  function renderResources(block, ctx) {
    return h('section.sm-note.sm-note--brand', null,
      h('span.sm-note__icon', null, icon('doc', 16)),
      h('div', null,
        h('div', { style: { fontWeight: '600', marginBottom: '4px' }, text: '参考资源' }),
        renderLinkList(block, '')));
  }

  /**
   * 渲染单个块。整个块返回 null 就表示「这个变体把它搬到别处去了」
   * （变体 B 的题目不在正文流里，就是这么做的）。
   */
  function renderBlock(block, ctx) {
    switch (block.type) {
      case 'heading': return h(block.level >= 3 ? 'h3' : 'h2', { text: block.text });
      case 'para': return h('p', null, inline(block.text));
      case 'quote': return h('blockquote', null, inline(block.text));
      case 'code': return renderCode(block);
      case 'table': return renderTable(block);
      case 'math': return h('div.sm-math-block', { text: block.tex });
      case 'figure': return renderFigure(block, ctx);
      case 'callout': return renderCallout(block, ctx);
      case 'resources': return renderResources(block, ctx);
      case 'related': return renderLinkList(block, 'sm-related');
      case 'practice': return renderPractice(block, ctx);
      case 'list': {
        const items = block.items.map((item) => h('li', null, inline(item)));
        return h(block.ordered ? 'ol' : 'ul', null, items);
      }
      case 'quiz': return ctx && ctx.renderQuiz ? ctx.renderQuiz(block, ctx) : null;
      default:
        return h('div.sm-note.sm-note--warn', null,
          h('span.sm-note__icon', null, icon('warn', 16)),
          h('div', null, h('b', { text: '原型没实现这个块：' + block.name }),
            h('div', { style: { color: 'var(--dsw-alias-label-secondary)' }, text: block.text })));
    }
  }

  function renderBlocks(blocks, ctx) {
    const out = document.createDocumentFragment();
    for (const block of blocks) {
      const node = renderBlock(block, ctx);
      if (node) out.appendChild(node);
    }
    return out;
  }

  Object.assign(SM, {
    content: { parseLesson, renderBlock, renderBlocks, renderTable, renderCode, renderFigure, renderLinkList },
    parseLesson,
    renderBlock,
    renderBlocks,
  });
})();
