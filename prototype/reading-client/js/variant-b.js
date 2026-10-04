/* ─────────────────────────────────────────────────────────────────────────
   变体 B · 三栏工作台

   主张：把阅读端当仪表盘用——**同时看全**。左栏是科目与节点树，中栏是路线图
   或课件正文，右栏是检查器，装题目、问答与笔记。

   与 A 最要紧的结构差别：题目**不在正文流里**。正文只留一个编号标记，题面、
   选项与判分全在右栏——滚动到哪一段，右栏就高亮那一处。正文因此永远保持
   「读」的密度，题目永远保持「做」的密度，两者不再互相打断。
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  const SM = (window.SM = window.SM || {});
  const { h, inline, icon } = SM;
  const NS = 'http://www.w3.org/2000/svg';

  const TABS = ['题目', '问答', '笔记'];
  const TIERS = ['未开始', '学习中', '已学完'];
  const KIND_ORDER = ['正文', '题目', '术语', '大纲', '学习记录', '误解'];

  // 锚点四态在窄栏里的短说法。完整说法（SM.quiz.STATE_TEXT / STATE_NOTE）用在
  // 卡片正文里，短说法只用在徽标和正文标记上——栏窄，先让人认出是哪一类。
  const STATE_SHORT = { resolved: '已对上', stale: '差空白', ambiguous: '多匹配', missing: '题库缺' };

  /* 变体自己的局部状态。挂在模块上是为了「切界面不丢」：从科目点进课件再退回来，
     检查器还停在你刚才那一栏，左树光标也还在原处。它不进 ctx——ctx 装的是状态，
     版式的私有选择归变体。 */
  const state = {
    cursor: '',          // 左树键盘光标对应的节点 id
    tab: '题目',          // 检查器当前页签
    quote: '',           // 正文里选中的那段，问答面板一直带着它
    marked: new Set(),   // 按过「标记这道题缺了」的锚点：`<节点id>#<锚点序号>`
    pending: null,       // 跨一次重挂的「进去就把第 N 个锚点亮出来」（goto 会重建整棵 DOM）
  };

  /* ── 通用小件 ─────────────────────────────────────────────────────────── */

  function todayLabel() {
    const day = (SM.data.workspace && SM.data.workspace.today) || '';
    const date = new Date(day + 'T00:00:00');
    return isNaN(date) ? day : `${day} · 星期${'日一二三四五六'[date.getDay()]}`;
  }

  /** 状态点 + 档位徽标。旧六档词表（raw_status）只在这里以悬停提示出现一次。 */
  function tierChip(node, withText) {
    return h('span.sm-chip' + (node.tier ? '.sm-chip--' + node.tier : ''),
      { title: `旧词表里的状态：${node.raw_status || '—'}` },
      h('i.sm-dot.' + node.tier), withText === false ? null : node.tier);
  }

  function noteBox(kind, title, body, extra) {
    return h('div.sm-note' + (kind ? '.sm-note--' + kind : ''), null,
      h('span.sm-note__icon', null, icon(kind === 'brand' ? 'check' : 'warn', 16)),
      h('div', null, title ? h('b', { text: title }) : null, body, extra));
  }

  function progressBar(value, total, label) {
    return h('div.sm-progressbar', {
      role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': value, 'aria-label': label,
    }, h('i', { style: { width: (total ? (value / total) * 100 : 0) + '%' } }));
  }

  /* ── 左栏：今天 / 科目 / 节点树 / 附件 ─────────────────────────────────── */

  function brand(api) {
    return h('div.vb-brand', null,
      h('a.vb-brand__mark', {
        href: '#', title: '回「今天学什么」',
        on: { click: (event) => { event.preventDefault(); api.goto({ view: 'home' }); } },
      }, '学'),
      h('div.vb-brand__text', null,
        h('b', { text: 'StudyMate' }),
        h('span', { text: '阅读端 · 工作台' })),
      h('button.vb-searchbtn', {
        type: 'button', dataset: { proto: 'palette' }, title: '搜索（Ctrl / ⌘ + K）',
        on: { click: () => api.openPalette() },
      }, icon('search', 14), h('span', { text: '搜索' }), h('span.sm-kbd', { text: '⌘K' })));
  }

  function todayBlock(api) {
    const entries = SM.data.continues();
    return h('section.vb-today', null,
      h('div.vb-sect__head', null,
        h('span.vb-sect__title', { text: '今天' }),
        h('span.vb-sect__sub', { text: todayLabel() })),
      h('div.vb-today__list', null, entries.map(({ subject, node }) => h('button.vb-today__row', {
        type: 'button',
        on: { click: () => api.goto({ view: 'lesson', subject: subject.slug, node: node.id }) },
      },
        h('i.sm-dot.' + node.tier),
        h('span.vb-today__body', null,
          h('span.vb-today__subject', { text: subject.name }),
          h('span.vb-today__node', null,
            h('span.vb-today__no', { text: node.number || '—' }), node.title)),
        icon('right', 13)))));
  }

  function subjectStrip(api) {
    const here = api.subject();
    return h('nav.vb-subjects', { 'aria-label': '科目' }, SM.data.subjects.map((subject) => {
      const done = subject.stats['已学完'] || 0;
      return h('button.vb-subject', {
        type: 'button',
        // 钩子贴的是「当前科目的那个按钮」：切换科目 = 切到这个科目的路线图
        dataset: subject === here ? { proto: 'nav-subject' } : null,
        'aria-current': subject === here ? 'true' : null,
        on: { click: () => api.goto({ view: 'subject', subject: subject.slug }) },
      },
        h('span.vb-subject__name', { text: subject.name }),
        h('span.vb-subject__meta', { text: `${done}/${subject.nodes.length} 已学完` }));
    }));
  }

  /** 节点树：按依赖层级分组。键盘 ↑↓ 在这上面走，光标也是中栏路线图的选中态。 */
  function nodeTree(api) {
    const subject = api.subject();
    const rows = new Map();
    const groups = [];
    for (let level = 0; level < subject.levels; level++) {
      const nodes = subject.nodes.filter((n) => n.level === level);
      if (!nodes.length) continue;
      const list = h('div.vb-tree__rows');
      nodes.forEach((node) => {
        const row = h('button.vb-row', {
          type: 'button',
          dataset: Object.assign({ node: node.id }, rows.size === 0 ? { proto: 'open-node' } : null),
          'aria-current': api.view === 'lesson' && api.node && api.node.id === node.id ? 'page' : null,
          on: { click: () => api.open(node) },
        },
          h('span.sm-dot.' + node.tier, { title: `旧词表里的状态：${node.raw_status || '—'}` }),
          h('span.vb-row__no', { text: node.number || '——' }),
          h('span.vb-row__title', { text: node.title }),
          node.lesson ? null : h('span.vb-row__none', { text: '无课件' }),
          h('span.vb-row__kind', { text: node.kind }));
        rows.set(node.id, row);
        list.appendChild(row);
      });
      groups.push(h('div.vb-tree__group', null,
        h('div.vb-tree__lvl', null,
          h('span', { text: `第 ${level + 1} 层` }),
          h('span.vb-tree__count', { text: `${nodes.length} 个节点` })),
        list));
    }

    const paintCursor = () => {
      for (const [id, row] of rows) row.classList.toggle('is-cursor', id === state.cursor);
      const current = rows.get(state.cursor);
      if (current) current.scrollIntoView({ block: 'nearest' });
    };

    return {
      paintCursor,
      el: h('section.vb-tree', null,
        h('div.vb-sect__head', null,
          h('span.vb-sect__title', { text: '节点' }),
          h('span.vb-sect__sub', { text: '↑↓ 选 · 回车打开' })),
        h('div.vb-tree__body', null, groups)),
    };
  }

  function fold(title, count, body) {
    return h('details.vb-fold', null,
      h('summary', null,
        h('span', { text: title }),
        h('span.vb-fold__count', { text: String(count) })),
      h('div.vb-fold__body', null, body));
  }

  function glossaryFold(subject) {
    const total = subject.glossary.reduce((sum, group) => sum + group.terms.length, 0);
    return fold('术语表', total, subject.glossary.map((group) => h('div.vb-gloss', null,
      h('h4', { text: `${group.title} · ${group.terms.length}` }),
      h('dl', null, group.terms.map((term) => h('div.vb-gloss__item', null,
        h('dt', { text: term.term }),
        h('dd', null,
          inline(SM.truncate(term.def, 76)),
          term.avoid ? h('span.vb-gloss__avoid', { text: '别叫：' + term.avoid }) : null)))))));
  }

  function resourcesFold(subject) {
    const blocks = subject.resources_md ? SM.parseLesson(subject.resources_md).blocks : [];
    return fold('参考资源', blocks.length, blocks.length
      ? h('div.vb-fold__prose', null, SM.renderBlocks(blocks, {}))
      : h('div.sm-empty', { text: '这个科目还没记参考资源。' }));
  }

  function recordsFold(subject) {
    return fold('学习记录', subject.records.length, subject.records.length
      ? h('ul.vb-records', null, subject.records.map((record) => h('li', null,
        h('span.vb-records__date', { text: record.date || '—' }),
        h('span', { text: record.title }))))
      : h('div.sm-empty', { text: '还没有学习记录。' }));
  }

  function misconceptionsFold(subject) {
    const list = subject.misconceptions || [];
    return fold('误解记录', list.length, list.length
      ? h('ul.vb-mis', null, list.map((item) => h('li', null,
        h('div.vb-mis__topic', null,
          h('i.sm-dot.sm-dot--学习中'),
          h('span', { text: item.topic }),
          h('span.sm-chip', { text: item.importance === 'high' ? '要紧' : '一般' })),
        h('p', { text: SM.truncate(item.question, 96) }))))
      : h('div.sm-empty', { text: '还没有误解记录。' }));
  }

  function leftPane(api) {
    const subject = api.subject();
    const tree = nodeTree(api);
    return {
      paintCursor: tree.paintCursor,
      el: h('aside.vb-pane.vb-left', { 'aria-label': '科目与节点' },
        h('div.vb-pane__head.vb-left__head', null, brand(api)),
        h('div.vb-pane__body.vb-left__body', null,
          todayBlock(api),
          subjectStrip(api),
          tree.el,
          h('section.vb-folds', null,
            h('div.vb-sect__head', null, h('span.vb-sect__title', { text: '附在科目上的东西' })),
            glossaryFold(subject),
            resourcesFold(subject),
            recordsFold(subject),
            misconceptionsFold(subject))),
        h('div.vb-left__foot', null,
          h('span', { text: `${subject.status} · 自 ${subject.created_at}` }),
          h('span', { text: `${subject.stats['已学完'] || 0}/${subject.nodes.length} 已学完` }))),
    };
  }

  /* ── 中栏 · 首页 ──────────────────────────────────────────────────────── */

  function continueCard(api, entry) {
    const { subject, node } = entry;
    const done = subject.stats['已学完'] || 0;
    const total = subject.nodes.length;
    const note = SM.splitSentences(node.notes)[0] || '';
    return h('article.vb-continue', null,
      h('div.vb-continue__top', null,
        h('span.vb-continue__subject', { text: subject.name }),
        tierChip(node)),
      h('h3.vb-continue__title', null,
        h('span.vb-continue__no', { text: node.number || '—' }), node.title),
      h('p.vb-continue__goal', null, inline(node.objective)),
      note ? h('p.vb-continue__note', { text: SM.truncate(note, 76) }) : null,
      h('div.vb-continue__foot', null,
        h('div.vb-continue__meter', null,
          progressBar(done, total, `${subject.name} 已学完 ${done} / ${total} 个节点`),
          h('span', { text: `已学完 ${done} / ${total} · 共 ${subject.levels} 层` })),
        h('button.sm-btn.sm-btn--primary', {
          type: 'button',
          on: { click: () => api.goto({ view: 'lesson', subject: subject.slug, node: node.id }) },
        }, '继续读 ', icon('right', 14))));
  }

  function viewHome(api) {
    const records = SM.data.subjects
      .flatMap((subject) => subject.records.map((record) => ({ subject, record })))
      .sort((a, b) => (b.record.date || '').localeCompare(a.record.date || ''));

    return h('div.vb-stage', null,
      h('div.vb-col.vb-col--page', null,
        h('header.vb-hero', null,
          h('p.vb-hero__eyebrow', { text: todayLabel() }),
          h('h1.vb-hero__title', { text: '今天学什么' }),
          h('p.vb-hero__sub', { text: '没有待复习队列，也没有今天该刷多少题的汇总——接着上次那个节点往下读就行。左边是科目与节点树，中间是路线图与课件，右边是题目、问答与笔记。' })),
        h('section.vb-block', null,
          h('h2.vb-block__title', { text: '继续学' }),
          h('div.vb-continues', null, SM.data.continues().map((entry) => continueCard(api, entry)))),
        h('section.vb-block', null,
          h('h2.vb-block__title', { text: '科目概览' }),
          h('div.vb-overview', null, SM.data.subjects.map((subject) => {
            const done = subject.stats['已学完'] || 0;
            const next = subject.nodes.find((n) => n.id === subject.continue_node) || subject.nodes[0];
            return h('article.vb-overview__row', null,
              h('div.vb-overview__main', null,
                h('div.vb-overview__name', null,
                  h('b', { text: subject.name }),
                  h('span.sm-chip', { text: `${subject.levels} 层 · ${subject.nodes.length} 个节点` })),
                h('p.vb-overview__goal', { text: SM.truncate(subject.goal, 128) }),
                h('div.vb-overview__stats', null, TIERS.map((tier) =>
                  h('span.sm-chip' + '.sm-chip--' + tier, null, h('i.sm-dot.' + tier), `${tier} ${subject.stats[tier] || 0}`)))),
              h('div.vb-overview__side', null,
                progressBar(done, subject.nodes.length, `${subject.name} 已学完 ${done} / ${subject.nodes.length}`),
                h('span.vb-overview__next', { text: '继续：' + (next ? next.title : '—') }),
                h('button.sm-btn', {
                  type: 'button',
                  on: { click: () => api.goto({ view: 'subject', subject: subject.slug }) },
                }, '看路线图', icon('right', 13))));
          }))),
        h('section.vb-block', null,
          h('h2.vb-block__title', { text: '最近的学习记录' }),
          records.length === 0 ? h('div.sm-empty', { text: '还没有学习记录。' })
            : h('ul.vb-recent', null, records.map(({ subject, record }) => h('li', null,
              h('span.vb-records__date', { text: record.date || '—' }),
              h('div', null,
                h('div', { text: record.title }),
                h('div.vb-recent__meta', { text: subject.name }))))))));
  }

  /* ── 中栏 · 路线图（分层图 + SVG 前置边）──────────────────────────────── */

  function roadmapCard(api, subject, node) {
    const deps = node.prerequisites
      .map((id) => (subject.nodes.find((n) => n.id === id) || {}).title)
      .filter(Boolean);
    const summary = SM.attempts.summary(subject.slug, node);
    const card = h('article.vb-card.vb-card--' + node.tier, { dataset: { node: node.id } },
      h('button.vb-card__open', {
        type: 'button', title: node.objective,
        on: { click: () => api.open(node) },
      },
        h('span.vb-card__top', null,
          h('span.vb-card__no', { text: node.number || '——' }),
          h('span.vb-card__title', { text: node.title })),
        h('span.vb-card__meta', null,
          h('span.sm-chip.sm-chip--kind', { text: node.kind }),
          h('span.sm-chip' + '.sm-chip--' + node.tier, { title: `旧词表里的状态：${node.raw_status || '—'}` },
            h('i.sm-dot.' + node.tier), node.tier),
          node.lab ? h('span.sm-chip', null, icon('lab', 12), 'lab') : null),
        h('span.vb-card__goal', { text: SM.truncate(node.objective, 54) }),
        h('span.vb-card__foot', null,
          deps.length ? h('span', { text: `前置 ${deps.length}` }) : h('span', { text: '无前置' }),
          h('span', { text: node.lesson ? `作答 ${summary.answered}/${summary.total}` : '无课件' }))));
    return card;
  }

  function roadmap(api, subject) {
    const canvas = h('div.vb-graph');
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'vb-edges');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML =
      '<defs>' +
      '<marker id="vb-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto">' +
      '<path d="M0.5,1 L9,5 L0.5,9 z"/></marker>' +
      '<marker id="vb-arrow-on" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto">' +
      '<path d="M0.5,1 L9,5 L0.5,9 z"/></marker>' +
      '</defs>';
    canvas.appendChild(svg);

    const cards = new Map();
    for (let level = 0; level < subject.levels; level++) {
      const nodes = subject.nodes.filter((n) => n.level === level);
      if (!nodes.length) continue;
      const lane = h('div.vb-lane', { dataset: { level: String(level) } },
        h('div.vb-lane__label', null,
          h('span.vb-lane__no', { text: `第 ${level + 1} 层` }),
          h('span.vb-lane__count', { text: `${nodes.length} 个节点` })),
        h('div.vb-lane__cards', null, nodes.map((node) => {
          const card = roadmapCard(api, subject, node);
          cards.set(node.id, card);
          return card;
        })));
      canvas.appendChild(lane);
    }

    // 边要等卡片落位才知道画到哪：位置全部现测，不缓存——窗口一变或字体一换就得重画。
    const paths = [];
    const draw = () => {
      const base = canvas.getBoundingClientRect();
      if (!base.width) return;
      for (const item of paths) item.el.remove();
      paths.length = 0;
      for (const edge of subject.edges) {
        const from = cards.get(edge.from);
        const to = cards.get(edge.to);
        if (!from || !to) continue;
        const a = from.getBoundingClientRect();
        const b = to.getBoundingClientRect();
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('class', 'vb-edge');
        path.setAttribute('marker-end', 'url(#vb-arrow)');
        const title = document.createElementNS(NS, 'title');
        title.textContent = `${edge.from} → ${edge.to}：${edge.reason || '前置关系'}`;
        path.appendChild(title);

        if (Math.abs(a.top - b.top) < 4) {
          // 同层：没有上下落差可依，从下面绕一圈回来
          const x1 = a.left - base.left + a.width / 2;
          const x2 = b.left - base.left + b.width / 2;
          const y1 = a.bottom - base.top;
          const y2 = b.bottom - base.top;
          const k = 26;
          path.setAttribute('d', `M${x1},${y1} C${x1},${y1 + k} ${x2},${y2 + k} ${x2},${y2}`);
        } else {
          const x1 = a.left - base.left + a.width / 2;
          const y1 = a.bottom - base.top;
          const x2 = b.left - base.left + b.width / 2;
          const y2 = b.top - base.top;
          const k = Math.max(26, Math.abs(y2 - y1) * 0.42);
          path.setAttribute('d', `M${x1},${y1} C${x1},${y1 + k} ${x2},${y2 - k} ${x2},${y2}`);
        }
        svg.appendChild(path);
        paths.push({ el: path, from: edge.from, to: edge.to });
      }
    };
    return { el: canvas, cards, draw, paths };
  }

  function viewSubject(api, cleanups) {
    const subject = api.subject();
    const graph = roadmap(api, subject);
    const stage = h('div.vb-stage.vb-stage--graph', null,
      h('div.vb-graphwrap', null,
        h('div.vb-legend', null,
          h('span', { text: '按前置依赖分层，从上往下读；箭头是前置关系，悬停任一节点看它的来路' }),
          h('span.vb-legend__spacer'),
          h('span.vb-legend__item', null, h('i.sm-dot.未开始'), '未开始'),
          h('span.vb-legend__item', null, h('i.sm-dot.学习中'), '学习中'),
          h('span.vb-legend__item', null, h('i.sm-dot.已学完'), '已学完')),
        graph.el));

    // 画边要等布局落定：这里用 rAF 起一帧，之后跟着窗口尺寸走。
    // 重画会把旧的边全删掉，所以画完要把当前选中态重新贴回去。
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { graph.draw(); highlight(state.cursor); });
    };
    schedule();
    window.addEventListener('resize', schedule);
    cleanups.push(() => { cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); });

    const highlight = (id) => {
      for (const [nodeId, card] of graph.cards) {
        card.classList.toggle('is-hot', nodeId === id);
        card.classList.toggle('is-dim', !!id && nodeId !== id && !graph.paths.some(
          (p) => (p.from === id && p.to === nodeId) || (p.to === id && p.from === nodeId)));
      }
      for (const item of graph.paths) {
        const on = !!id && (item.from === id || item.to === id);
        item.el.classList.toggle('is-on', on);
        item.el.setAttribute('marker-end', on ? 'url(#vb-arrow-on)' : 'url(#vb-arrow)');
      }
    };

    const clear = () => highlight(state.cursor);
    graph.el.addEventListener('mouseleave', clear);
    for (const [id, card] of graph.cards) {
      card.addEventListener('mouseenter', () => highlight(id));
    }

    return { el: stage, highlight };
  }

  /* ── 中栏 · 课件正文（题目被抽走，只留编号标记）───────────────────────── */

  function marker(api, node, block) {
    const index = block.quizIndex;
    const anchor = node.anchors[index] || { text: block.anchor, resolution: 'missing', keys: [] };
    const resolvedState = SM.quiz.stateOf(anchor);
    const count = resolvedState === 'resolved' ? SM.quiz.questions(node, anchor, (anchor.keys || [])[0]).length : 0;
    return h('div.vb-markrow', null,
      h('button.vb-mark', {
        type: 'button',
        dataset: { mark: String(index), state: resolvedState },
        title: '这道题在右栏「题目」里作答',
        on: { click: () => api.focusAnchor(index) },
      },
        h('span.vb-mark__no', { text: String(index + 1) }),
        h('span.vb-mark__text', { text: anchor.text || block.anchor || '锚点缺失' }),
        resolvedState === 'resolved'
          ? h('span.vb-mark__n', { text: `${count} 题` })
          : h('span.vb-mark__n.vb-mark__n--warn', { text: STATE_SHORT[resolvedState] }),
        h('span.vb-mark__go', null, '右栏作答', icon('right', 12))));
  }

  function labCard(node) {
    if (!node.lab) return null;
    return h('section.vb-lab', null,
      h('div.vb-lab__head', null, icon('lab', 16), h('b', { text: '这一课的 lab' })),
      h('p', { text: SM.truncate(node.lab.readme.split('\n').filter((l) => l.trim() && !l.startsWith('#'))[0] || '', 130) }),
      h('ul.vb-lab__files', null, node.lab.files.map((file) => h('li', null, h('code', { text: file })))),
      h('div.vb-lab__foot', null,
        h('span.vb-q__meta', { text: '实操题的判分由宿主半代跑你本地的测试命令，输出原样记进作答数据。' }),
        h('button.sm-btn.sm-btn--primary', { type: 'button' }, '让引擎跑一遍测试')));
  }

  function viewLesson(api, cleanups, lessonBox, sectionBar) {
    const subject = api.subject();
    const node = api.node;
    const index = subject.nodes.findIndex((n) => n.id === node.id);
    const prev = subject.nodes[index - 1];
    const next = subject.nodes[index + 1];
    const prose = h('article.vb-prose.sm-prose');
    const stage = h('div.vb-stage', null, h('div.vb-col.vb-col--read', null,
      h('div.vb-lessonhead', null,
        h('p.vb-hero__eyebrow', { text: `${subject.name} · 第 ${node.number || '?'} 课` }),
        h('h1', { text: node.title }),
        h('div.sm-note.sm-note--brand', null,
          h('span.sm-note__icon', null, icon('spark', 16)),
          h('div', null, h('b', { text: '本节目标' }), h('div', null, inline(node.objective))))),
      prose,
      labCard(node),
      h('nav.vb-navfoot', null,
        prev ? h('button.sm-btn', { type: 'button', on: { click: () => api.open(prev) } }, icon('left', 13), prev.title) : h('span'),
        next ? h('button.sm-btn', { type: 'button', on: { click: () => api.open(next) } }, next.title, icon('right', 13)) : h('span', { text: '这是最后一个节点' }))));

    /* 正文里的标记 ↔ 阅读位置：滚到哪一处，右栏就高亮哪一个锚点卡。 */
    const marks = [];
    const sections = [];
    const tocLinks = new Map();
    let near = -1;
    let frame = 0;

    const paintNear = () => {
      if (!marks.length) return;
      const line = stage.getBoundingClientRect().top + 96;
      let best = marks[0].index;
      let bestGap = Infinity;
      for (const mark of marks) {
        const gap = Math.abs(mark.el.getBoundingClientRect().top - line);
        if (gap < bestGap) { bestGap = gap; best = mark.index; }
      }
      if (best !== near) {
        near = best;
        for (const mark of marks) mark.el.classList.toggle('is-near', mark.index === near);
        api.setNear(near);
      }
      let activeSection = 0;
      sections.forEach((section, i) => { if (section.getBoundingClientRect().top <= line) activeSection = i; });
      for (const [i, link] of tocLinks) link.classList.toggle('is-on', i === activeSection);
    };

    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paintNear);
    };
    stage.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    cleanups.push(() => {
      cancelAnimationFrame(frame);
      stage.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    });

    const toc = sectionBar;

    SM.data.loadLesson(node).then((parsed) => {
      lessonBox.parsed = parsed;
      if (!parsed || parsed.error) {
        prose.appendChild(h('div.sm-empty', {
          text: node.lesson ? '这节课的课件内容文件读不出来。' : '这个节点还没有课件内容文件。',
        }));
        return;
      }
      const frag = SM.frag();
      parsed.sections.forEach((section, i) => {
        if (!section.blocks.length && i === 0 && section.title === parsed.meta.title) return;
        const sectionEl = h('section.vb-sec', { id: section.id, dataset: { section: String(i) } });
        sectionEl.appendChild(h('h2', { text: section.title }));
        sectionEl.appendChild(SM.renderBlocks(section.blocks, {
          node,
          subject,
          // 题目块交给右栏：这里换成一个小标记，正文不出现题面
          renderQuiz: (block) => marker(api, node, block),
        }));
        sections.push(sectionEl);
        frag.appendChild(sectionEl);
        const link = h('button.vb-sections__link', {
          type: 'button',
          on: { click: () => sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
        }, section.title);
        tocLinks.set(tocLinks.size, link);
        toc.appendChild(link);
      });
      prose.appendChild(frag);
      for (const el of prose.querySelectorAll('.vb-mark')) marks.push({ el, index: Number(el.dataset.mark) });
      requestAnimationFrame(paintNear);
    }).catch((error) => {
      prose.appendChild(h('div.sm-empty', { text: '课件读不出来：' + error }));
    });

    return {
      el: stage,
      focusMarker(i) {
        const hit = marks.find((m) => m.index === i);
        if (!hit) return;
        hit.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        hit.el.classList.add('is-flash');
        setTimeout(() => hit.el.classList.remove('is-flash'), 900);
      },
    };
  }

  /* ── 右栏 · 检查器 ────────────────────────────────────────────────────── */

  function questionItem(subject, node, anchorKey, item, index, opts) {
    const readOnly = !!opts.readOnly;
    const wrap = h('div.vb-q' + (readOnly ? '.vb-q--ro' : ''));
    const review = SM.quiz.review(subject.slug, node, anchorKey, index);
    wrap.appendChild(h('div.vb-q__ask', null,
      h('span.vb-q__no', { text: 'Q' + (index + 1) }),
      h('div.vb-q__text', null, String(item.q).split('\n').map((line, i) =>
        h('p', null, line, i === 0 && review ? h('span.vb-q__review', { text: review }) : null)))));

    if (SM.quiz.isOpen(item)) {
      if (readOnly) {
        wrap.appendChild(h('p.vb-q__meta', { text: '开放题 · 锚点确认前不展开参考答案' }));
        return wrap;
      }
      const field = h('textarea.vb-q__answer', { rows: 3, placeholder: '先自己写一遍，再展开参考答案对照。' });
      const panel = h('div.vb-q__ref', { hidden: true });
      wrap.append(field, h('div.vb-q__actions', null,
        h('button.sm-btn', {
          type: 'button',
          on: {
            click(event) {
              panel.hidden = false;
              event.target.disabled = true;
              SM.clear(panel).appendChild(SM.frag(
                h('div.vb-q__refblock', null, h('h4', { text: '参考答案' }),
                  h('div', null, String(item.answer).split('\n').map((line) => h('p', null, line)))),
                h('div.vb-q__refblock', null, h('h4', { text: '判分要点' }),
                  h('div', null, String(item.criteria || '').split('\n').map((line) => h('p', null, line)))),
                h('div.vb-q__self', null,
                  h('span', { text: '自评：' }),
                  ['答对了', '答了一半', '没答上'].map((label, i) => h('button.sm-btn', {
                    type: 'button',
                    on: {
                      click() {
                        SM.quiz.record(subject.slug, node, anchorKey, index, { chosen: null, correct: i === 0, self: label });
                        SM.clear(panel.querySelector('.vb-q__self')).appendChild(
                          h('span.sm-chip.sm-chip--学习中', { text: '已记：' + label + '（自评不算独立通过证据）' }));
                        if (opts.onAnswered) opts.onAnswered();
                      },
                    },
                  }, label)))));
            },
          },
        }, '展开参考答案与判分要点'),
        h('span.vb-q__meta', { text: '开放题不自动判分' })));
      wrap.appendChild(panel);
      return wrap;
    }

    const list = h('div.vb-q__opts', { role: 'group', 'aria-label': '选项' });
    const why = h('div.vb-q__why', { hidden: true });
    item.opts.forEach((option, i) => {
      const btn = h('button.vb-opt', {
        type: 'button',
        // 只读预览不带作答钩子：锚点没确认时这些按钮不接受作答
        dataset: readOnly ? null : { proto: 'option' },
        disabled: readOnly,
        on: readOnly ? null : {
          click() {
            const result = SM.quiz.judge(item, i);
            SM.quiz.record(subject.slug, node, anchorKey, index, { chosen: i, correct: result.correct });
            for (const el of list.children) el.classList.remove('is-picked', 'is-right', 'is-wrong');
            btn.classList.add('is-picked', result.correct ? 'is-right' : 'is-wrong');
            if (!result.correct && list.children[item.ans]) list.children[item.ans].classList.add('is-right');
            SM.clear(why).appendChild(noteBox(result.correct ? 'brand' : 'error',
              result.correct ? '对了' : `不对，答案是 ${SM.quiz.letter(item.ans)}`,
              h('div', { text: result.why }),
              h('div.vb-q__meta', { text: '已记进作答数据（原型只在内存里，刷新即丢）' })));
            why.hidden = false;
            if (opts.onAnswered) opts.onAnswered();
          },
        },
      }, h('span.vb-opt__letter', { text: SM.quiz.letter(i) }), h('span', null, option));
      list.appendChild(btn);
    });
    wrap.append(list, why);
    return wrap;
  }

  /**
   * 一个锚点一张卡。四态在这里必须都好看：resolved 直接给题；其余三态
   * 把「为什么对不上」摊开给人看，并**关掉判分**——多匹配绝不静默取第一个。
   */
  function anchorCard(api, subject, node, anchor, index, onAnswered) {
    const resolvedState = SM.quiz.stateOf(anchor);
    const keys = anchor.keys || [];
    const key0 = keys[0];
    const questions = resolvedState === 'resolved' ? SM.quiz.questions(node, anchor, key0) : [];
    const card = h('article.vb-anchor', { dataset: { state: resolvedState, anchor: String(index) } });
    const body = h('div.vb-anchor__body');

    const label = h('button.vb-anchor__label', {
      type: 'button', 'aria-expanded': 'true',
      on: {
        click() {
          const opened = body.hidden;
          body.hidden = !opened;
          label.setAttribute('aria-expanded', String(opened));
        },
      },
    },
      h('span.vb-anchor__no', { text: String(index + 1) }),
      h('span.vb-anchor__text', { text: anchor.text || '（正文里没写锚点文字）' }),
      h('span.vb-anchor__spacer'),
      h('span.sm-chip' + (resolvedState === 'resolved' ? '' : '.sm-chip--proto'),
        { title: SM.quiz.STATE_TEXT[resolvedState] },
        resolvedState === 'resolved' ? `${questions.length} 题` : STATE_SHORT[resolvedState]));

    card.appendChild(h('div.vb-anchor__head', null,
      label,
      h('button.vb-anchor__jump', {
        type: 'button', title: '回到正文里的这个位置', 'aria-label': '回到正文里的这个位置',
        on: { click: () => api.focusMarker(index) },
      }, icon('left', 14))));

    if (resolvedState === 'resolved') {
      if (!questions.length) body.appendChild(h('div.sm-empty', { text: '这个题库键下没有题。' }));
      questions.forEach((item, i) => body.appendChild(questionItem(subject, node, key0, item, i, { onAnswered })));
    } else {
      body.appendChild(h('div.sm-note.sm-note--warn', null,
        h('span.sm-note__icon', null, icon('warn', 16)),
        h('div', null,
          h('b', { text: SM.quiz.STATE_TEXT[resolvedState] }),
          h('div', { text: SM.quiz.STATE_NOTE[resolvedState] }))));

      if (resolvedState === 'stale') {
        body.appendChild(h('div.vb-pair', null,
          h('div.vb-pair__col', null,
            h('span.vb-pair__label', { text: '正文文字' }),
            h('code', { text: anchor.text || '（空）' })),
          h('span.vb-pair__arrow', null, icon('right', 14)),
          h('div.vb-pair__col', null,
            h('span.vb-pair__label', { text: '题库键' }),
            h('code', { text: key0 || '（没找到）' }))));
      }

      if (resolvedState === 'ambiguous') {
        const preview = h('div.vb-keys__preview');
        const paint = (key) => {
          SM.clear(preview);
          const list = SM.quiz.questions(node, anchor, key);
          preview.appendChild(h('p.vb-q__meta', { text: '只读预览 · 选定哪个键要人来确认，确认前不判分' }));
          list.forEach((item, i) => preview.appendChild(
            questionItem(subject, node, key, item, i, { readOnly: true })));
        };
        body.appendChild(h('div.vb-keys', null, keys.map((key, i) => h('label.vb-key', null,
          h('input', {
            type: 'radio', name: `vb-anchor-${node.id}-${index}`,
            on: { change: () => paint(key) },
          }),
          h('span.vb-key__body', null,
            h('code', { text: key }),
            h('span.vb-key__n', { text: `${(node.pool[key] || []).length} 题` }))))));
        body.appendChild(preview);
        if (keys.length) paint(key0);
      }

      if (resolvedState === 'missing') {
        const markKey = `${node.id}#${index}`;
        const slot = h('div.vb-markmissing');
        const paint = () => {
          SM.clear(slot);
          if (state.marked.has(markKey)) {
            slot.appendChild(h('span.sm-chip.sm-chip--proto', { text: '已标记：这道题缺了' }));
            slot.appendChild(h('span.vb-q__meta', { text: '会写进题库缺口清单（原型只在内存里）' }));
          } else {
            slot.appendChild(h('button.sm-btn', {
              type: 'button',
              on: {
                click() {
                  state.marked.add(markKey);
                  paint();
                },
              },
            }, '标记这道题缺了'));
            slot.appendChild(h('span.vb-q__meta', { text: '判分入口关闭，只能把它记成缺口' }));
          }
        };
        paint();
        body.appendChild(slot);
      }
    }

    card.appendChild(body);
    return card;
  }

  function anchorsPanel(api, subject, node) {
    const wrap = h('div.vb-anchors');
    if (!node) {
      wrap.appendChild(h('div.sm-empty', { text: '先在左边选一个节点。' }));
      return { el: wrap, setNear() {} };
    }

    const summary = SM.attempts.summary(subject.slug, node);
    const meter = h('div.vb-sum', null,
      progressBar(summary.answered, summary.total, `作答 ${summary.answered} / ${summary.total}`),
      h('span.vb-sum__text', null,
        `作答 ${summary.answered} / ${summary.total}`,
        summary.answered ? h('span', { text: ` · 对 ${summary.correct}` }) : null));
    const refreshSummary = () => {
      const next = SM.attempts.summary(subject.slug, node);
      const bar = meter.querySelector('.sm-progressbar');
      const fill = bar.firstChild;
      fill.style.width = (next.total ? (next.answered / next.total) * 100 : 0) + '%';
      bar.setAttribute('aria-valuenow', next.answered);
      SM.clear(meter.querySelector('.vb-sum__text')).appendChild(SM.frag(
        `作答 ${next.answered} / ${next.total}`,
        next.answered ? h('span', { text: ` · 对 ${next.correct}` }) : null));
    };
    wrap.appendChild(meter);

    if (!node.anchors.length) {
      wrap.appendChild(h('div.sm-empty', { text: '这个节点的题库还没有跟正文对上锚点。' }));
      return { el: wrap, setNear() {} };
    }

    const dots = new Map();
    const nav = h('div.vb-anchor-nav', null, node.anchors.map((anchor, i) => {
      const dot = h('button.vb-anchor-nav__dot', {
        type: 'button', 'aria-label': `第 ${i + 1} 处练习：${anchor.text || '锚点缺失'}`,
        dataset: { state: SM.quiz.stateOf(anchor) },
        on: { click: () => api.focusAnchor(i, { jumpProse: true }) },
      }, String(i + 1));
      dots.set(i, dot);
      return dot;
    }));
    wrap.appendChild(nav);

    if (node.orphan_keys && node.orphan_keys.length) {
      wrap.appendChild(h('div.sm-note.sm-note--warn', null,
        h('span.sm-note__icon', null, icon('warn', 16)),
        h('div', null,
          h('b', { text: `题库里有 ${node.orphan_keys.length} 个键在正文里找不到锚点` }),
          h('ul.vb-orphans', null, node.orphan_keys.map((key) => h('li', null, h('code', { text: key })))))));
    }

    const cards = new Map();
    node.anchors.forEach((anchor, i) => {
      const card = anchorCard(api, subject, node, anchor, i, refreshSummary);
      cards.set(i, card);
      wrap.appendChild(card);
    });

    return {
      el: wrap,
      cards,
      dots,
      setNear(i) {
        for (const [index, card] of cards) card.classList.toggle('is-near', index === i);
        for (const [index, dot] of dots) dot.classList.toggle('is-near', index === i);
      },
    };
  }

  function anchorListPanel(api, subject, node) {
    // 没打开课件时，「题目」页签保持同一套词汇：把锚点与四态列出来，点一下进课件。
    if (!node) return h('div.sm-empty', { text: '先在左边选一个节点。' });
    if (!node.anchors.length) {
      return h('div', null,
        h('p.vb-hint', { text: '这个节点还没有课件，题库也就没有锚点可对。' }),
        h('button.sm-btn', { type: 'button', on: { click: () => api.open(node) } }, '打开这个节点'));
    }
    const summary = SM.attempts.summary(subject.slug, node);
    return h('div.vb-anchors', null,
      h('div.vb-sum', null,
        progressBar(summary.answered, summary.total, `作答 ${summary.answered} / ${summary.total}`),
        h('span.vb-sum__text', { text: `作答 ${summary.answered} / ${summary.total} · 对 ${summary.correct}` })),
      h('p.vb-hint', { text: '题面与判分在打开课件后出现在这里——正文里只留编号标记。' }),
      h('ul.vb-anchorlist', null, node.anchors.map((anchor, i) => h('li', null,
        h('button.vb-anchorlist__row', {
          type: 'button',
          on: {
            click() {
              state.pending = i;   // 重挂之后由新的检查器接着点亮
              api.goto({ view: 'lesson', subject: subject.slug, node: node.id });
            },
          },
        },
          h('span.vb-anchor__no', { text: String(i + 1) }),
          h('span.vb-anchor__text', { text: anchor.text || '（锚点缺失）' }),
          h('span.vb-anchor__spacer'),
          h('span.sm-chip' + (SM.quiz.stateOf(anchor) === 'resolved' ? '' : '.sm-chip--proto'),
            { title: SM.quiz.STATE_TEXT[SM.quiz.stateOf(anchor)] },
            SM.quiz.stateOf(anchor) === 'resolved'
              ? `${SM.quiz.questions(node, anchor, (anchor.keys || [])[0]).length} 题`
              : STATE_SHORT[SM.quiz.stateOf(anchor)]))))));
  }

  function notesPanel(subject, node) {
    if (!node) return h('div.sm-empty', { text: '先在左边选一个节点。' });
    const deps = node.prerequisites
      .map((id) => (subject.nodes.find((n) => n.id === id) || {}).title)
      .filter(Boolean);
    const block = (title, body) => h('section.vb-note', null, h('h4', { text: title }), body);
    return h('div.vb-notes', null,
      block('目标', h('p', null, inline(node.objective))),
      block('要解决的问题', h('p', null, inline(node.problem || '—'))),
      block(`概念 · ${node.concepts.length}`, h('div.vb-taglist', null,
        node.concepts.map((concept) => h('span.sm-chip', { text: concept })))),
      block(`常见卡点 · ${node.pitfalls.length}`, node.pitfalls.length
        ? h('ul.vb-pitfalls', null, node.pitfalls.map((item) => h('li', { text: item })))
        : h('p.vb-hint', { text: '还没记卡点。' })),
      block('真实场景', h('p', null, inline(node.realworld || '—'))),
      block('前置', deps.length
        ? h('ul.vb-pitfalls', null, deps.map((title) => h('li', { text: title })))
        : h('p.vb-hint', { text: '无前置依赖，可以从这里开始。' })),
      block('进度笔记', h('div.vb-notes__log', null,
        SM.splitSentences(node.notes || '还没有进度笔记。').map((line) => h('p', { text: line })))),
      node.lab ? block('这一课的 lab', h('div', null,
        h('p.vb-hint', { text: node.lab.dir }),
        h('ul.vb-pitfalls', null, node.lab.files.map((file) => h('li', null, h('code', { text: file })))))) : null);
  }

  function qaPanel(api, lessonBox) {
    const quote = h('blockquote.vb-quote');
    const paintQuote = () => {
      SM.clear(quote);
      quote.appendChild(state.quote
        ? h('span', { text: state.quote })
        : h('span.vb-quote__empty', { text: '还没选中正文。在中间的正文里划一段，这里就带上它。' }));
    };
    paintQuote();

    const input = h('input', {
      type: 'text', placeholder: '哪里不懂？（可以直接回车）', 'aria-label': '你的问题',
      dataset: { proto: 'qa-input' },
    });
    const send = h('button.sm-btn.sm-btn--primary', { type: 'submit' }, '问');
    const body = h('div.vb-qa__body');
    // 「就这段问一句」：选中正文之后右栏自己会切过来，这一步只是把光标送进问题框。
    const chip = h('button.vb-qa__chip', {
      type: 'button', dataset: { proto: 'qa-chip' }, hidden: !state.quote,
      on: { click: () => input.focus() },
    }, icon('ask', 13), '就这段问一句');

    const form = h('form.vb-qa__form', {
      on: {
        submit(event) {
          event.preventDefault();
          const lesson = lessonBox.parsed;
          if (!lesson || lesson.error) {
            SM.clear(body).appendChild(h('div.sm-empty', { text: '先打开一个节点的课件，问答面板才有上下文。' }));
            return;
          }
          const question = input.value.trim();
          SM.clear(body).appendChild(h('div.vb-qa__loading', { text: '正在就地回答…' }));
          SM.qa.ask({ lesson, quote: state.quote, question }).then((answer) => {
            SM.clear(body).appendChild(SM.frag(
              answer.body.split('\n\n').map((line) => h('p', null, inline(line))),
              h('div.sm-note', null,
                h('span.sm-note__icon', null, icon('doc', 15)),
                h('div', null,
                  h('b', { text: '已记一条误解记录' }),
                  h('div', { text: `topic「${answer.misconception.topic}」· source ${answer.misconception.source} · status ${answer.misconception.status}——总控下次开场读得到。` })))));
          }).catch((error) => {
            SM.clear(body).appendChild(h('div.sm-empty', { text: '没问成：' + error }));
          });
        },
      },
    }, input, send);

    return h('div.vb-qa', null,
      h('div.vb-qa__head', null,
        h('b', { text: '问答面板' }),
        h('span.sm-chip.sm-chip--proto', { text: '原型 · 假回答' }),
        h('span.vb-qa__spacer'),
        chip),
      quote,
      h('p.vb-hint', { text: '面板只带当前课件、选中的这段与共享记忆，就地回答，不经过总控，也不背整个会话。' }),
      form,
      body);
  }

  function inspectorPane(api, cleanups, lessonBox) {
    const subject = api.subject();
    // 打开课件时检查器盯的是课件；在路线图/首页时盯的是左树光标——两处都只有一个「当前节点」。
    const node = api.view === 'lesson' ? api.node : SM.data.node(subject.slug, state.cursor);
    const buttons = new Map();
    const panels = new Map();
    const tabbar = h('div.vb-tabs', { role: 'tablist', 'aria-label': '检查器' });

    const anchors = api.view === 'lesson' && node
      ? anchorsPanel(api, subject, node)
      : { el: anchorListPanel(api, subject, node), setNear() {} };

    const notesWrap = h('div.vb-notes__wrap');
    const paintNotes = () => {
      const target = api.view === 'lesson' ? api.node : SM.data.node(subject.slug, state.cursor);
      SM.clear(notesWrap).appendChild(notesPanel(subject, target));
    };
    paintNotes();

    panels.set('题目', anchors.el);
    panels.set('问答', qaPanel(api, lessonBox));
    panels.set('笔记', notesWrap);

    const counts = { 题目: node && node.anchors ? node.anchors.length : 0, 问答: 0, 笔记: 0 };

    for (const name of TABS) {
      const btn = h('button.vb-tab', {
        type: 'button', role: 'tab', id: 'vb-tab-' + name, 'aria-selected': 'false',
        dataset: { tab: name },
        on: { click: () => select(name) },
      }, name, counts[name] ? h('span.vb-tab__n', { text: String(counts[name]) }) : null);
      buttons.set(name, btn);
      tabbar.appendChild(btn);
    }

    function select(name) {
      state.tab = TABS.includes(name) ? name : '题目';
      for (const [key, btn] of buttons) {
        btn.setAttribute('aria-selected', String(key === state.tab));
        panels.get(key).hidden = key !== state.tab;
        panels.get(key).setAttribute('aria-labelledby', 'vb-tab-' + key);
      }
    }
    select(state.tab);

    const body = h('div.vb-pane__body.vb-inspector', null, ...[...panels.values()]);

    const focusAnchorImpl = (index, opts) => {
      select('题目');
      const card = anchors.cards && anchors.cards.get(index);
      if (!card) return;
      const cardBody = card.querySelector('.vb-anchor__body');
      const label = card.querySelector('.vb-anchor__label');
      if (cardBody.hidden) {
        cardBody.hidden = false;
        label.setAttribute('aria-expanded', 'true');
      }
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('is-flash');
      setTimeout(() => card.classList.remove('is-flash'), 1200);
      if (opts && opts.jumpProse) api.focusMarker(index);
    };

    const pane = {
      el: h('aside.vb-pane.vb-right', { 'aria-label': '检查器' },
        h('div.vb-pane__head', null, tabbar),
        body),
      select,
      setNear: anchors.setNear,
      focusAnchor: focusAnchorImpl,
      setQuote(text) {
        state.quote = text;
        paintQuoteInto(panels.get('问答'), text);
        select('问答');
      },
      refreshNotes: paintNotes,
    };

    // 从「科目」界面的锚点清单点进来时，整棵 DOM 已经重建过一轮：落定后自己把那张卡点亮。
    if (api.view === 'lesson' && state.pending != null) {
      const index = state.pending;
      state.pending = null;
      requestAnimationFrame(() => focusAnchorImpl(index));
    }
    return pane;
  }

  /** 只更新问答页里那句引用，不重建整个面板（重建会把打字打到一半的输入框清掉）。 */
  function paintQuoteInto(panel, text) {
    const quote = panel.querySelector('.vb-quote');
    if (quote) {
      SM.clear(quote).appendChild(text
        ? h('span', { text })
        : h('span.vb-quote__empty', { text: '还没选中正文。在中间的正文里划一段，这里就带上它。' }));
    }
    const chip = panel.querySelector('.vb-qa__chip');
    if (chip) chip.hidden = !text;
  }

  /* ── 搜索：命令面板 ───────────────────────────────────────────────────── */

  function palette(api) {
    const input = h('input.vb-palette__input', {
      type: 'search', placeholder: '搜正文、题目、术语、大纲、记录、误解…', 'aria-label': '搜索',
      dataset: { proto: 'search-input' },
    });
    const list = h('div.vb-palette__list');
    // 外面套一层 form 不是为了提交：面板本来就是一个输入框，回车即「搜/打开」。
    // 有 form 的好处是浏览器与自动化都能用同一条路径触发它。
    const bar = h('form.vb-palette__bar', {
      on: {
        submit(event) {
          event.preventDefault();
          open();
          run(input.value);
        },
      },
    }, icon('search', 16), input, h('span.sm-kbd', { text: 'Esc' }));
    const el = h('div.vb-palette', { hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': '搜索' },
      h('div.vb-palette__backdrop', { on: { click: () => close() } }),
      h('div.vb-palette__sheet', null,
        bar,
        list,
        h('div.vb-palette__foot', null,
          h('span', { text: '↑↓ 选 · 回车打开 · Esc 关' }),
          h('span', { text: '跨科目搜五类：课件正文 · 题库 · 术语表 · 学习记录与误解 · 大纲' }))));

    let rows = [];
    let active = 0;
    let token = 0;

    const paintActive = () => {
      rows.forEach((row, i) => row.el.classList.toggle('is-active', i === active));
      if (rows[active]) rows[active].el.scrollIntoView({ block: 'nearest' });
    };

    const openHit = (hit) => {
      close();
      if (hit.node) api.goto({ view: 'lesson', subject: hit.subject.slug, node: hit.node.id });
      else api.goto({ view: 'subject', subject: hit.subject.slug });
    };

    const render = (hits, query) => {
      SM.clear(list);
      rows = [];
      if (!query) {
        list.appendChild(h('div.sm-empty', { text: '输入关键词。搜的是真数据：课件正文、题库、术语表、学习记录与误解记录、大纲。' }));
        return;
      }
      if (!hits.length) {
        list.appendChild(h('div.sm-empty', { text: `没搜到「${query}」。` }));
        return;
      }
      const groups = new Map();
      for (const hit of hits) {
        if (!groups.has(hit.kind)) groups.set(hit.kind, []);
        groups.get(hit.kind).push(hit);
      }
      [...groups.entries()]
        .sort((a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]))
        .forEach(([kind, group]) => {
          list.appendChild(h('div.vb-palette__kind', null, kind, h('span', { text: `${group.length} 条` })));
          group.slice(0, 6).forEach((hit) => {
            const el = h('button.vb-hit', {
              type: 'button',
              on: {
                click: () => openHit(hit),
                mouseenter: () => {
                  const at = rows.findIndex((row) => row.hit === hit);
                  if (at >= 0) { active = at; paintActive(); }
                },
              },
            },
              h('span.vb-hit__subject', { text: hit.subject.name }),
              h('span.vb-hit__text', { text: SM.truncate(hit.text, 96) }),
              hit.label ? h('span.vb-hit__label', { text: SM.truncate(hit.label, 40) }) : null);
            rows.push({ el, hit });
            list.appendChild(el);
          });
        });
      active = 0;
      paintActive();
    };

    const run = (query) => {
      const mine = ++token;
      if (!query.trim()) { render([], ''); return; }
      SM.clear(list).appendChild(h('div.sm-empty', { text: '正在搜…' }));
      SM.data.search(query).then((hits) => {
        if (mine !== token) return;   // 手快过搜索：丢掉过期结果
        render(hits, query);
      }).catch((error) => {
        if (mine !== token) return;
        SM.clear(list).appendChild(h('div.sm-empty', { text: '搜索失败了：' + error }));
      });
    };

    let timer = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => run(input.value), 140);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); active = Math.min(active + 1, rows.length - 1); paintActive(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(active - 1, 0); paintActive(); }
      else if (event.key === 'Enter') { event.preventDefault(); if (rows[active]) openHit(rows[active].hit); }
    });
    // 点面板空白处别把焦点丢了：面板是靠输入框吃键盘的
    el.addEventListener('mousedown', (event) => {
      if (event.target === el || event.target.classList.contains('vb-palette__backdrop')
        || event.target.classList.contains('vb-palette__sheet')) {
        event.preventDefault();
        input.focus();
      }
    });

    function open() {
      el.hidden = false;
      input.focus();
      input.select();
      if (!rows.length) run(input.value);
    }
    function close() { el.hidden = true; }
    function toggle() { if (el.hidden) open(); else close(); }

    render([], '');
    return { el, open, close, toggle, isOpen: () => !el.hidden };
  }

  /* ── 挂载 ─────────────────────────────────────────────────────────────── */

  const B = {
    key: 'B',
    name: '三栏工作台',
    blurb: '左树 + 中正文 + 右检查器，题目被抽出正文流；以「同时看全」为主。',
  };

  B.mount = function mount(root, ctx) {
    const cleanups = [];
    const lessonBox = { parsed: null };
    const subject = ctx.subject();
    let view = ['home', 'subject', 'lesson'].includes(ctx.here.view) ? ctx.here.view : 'subject';
    const node = ctx.node();
    if (view === 'lesson' && !node) view = 'subject';

    // 左树光标：落到不属于这个科目的节点上（切科目、换会话）就退回「继续学」那个。
    const ids = subject.nodes.map((n) => n.id);
    if (!ids.includes(state.cursor)) {
      state.cursor = ids.includes(ctx.here.node) ? ctx.here.node : (subject.continue_node || ids[0] || '');
    }

    // 三栏之间只通过这些回调说话：中栏算「读到哪」，右栏算「哪张卡在亮」。
    let paintCursor = () => {};
    let highlightNode = () => {};
    let refreshNotes = () => {};
    let focusAnchor = () => {};
    let focusMarker = () => {};
    let setNear = () => {};
    let setQuote = () => {};
    let paletteBox = null;
    let shell = null;
    // 本节目录条：课件是异步读进来的，所以容器先摆好，读完自己往里填（空的时候 CSS 收起）
    const sectionBar = h('div.vb-sections', { 'aria-label': '本节目录' });

    const api = {
      view, node,
      subject: () => subject,
      goto: (patch) => ctx.goto(patch),
      open: (target) => ctx.goto({ view: 'lesson', subject: ctx.here.subject, node: target.id }),
      setCursor(id) {
        state.cursor = id;
        paintCursor();
        highlightNode(id);
        refreshNotes();
      },
      focusAnchor: (index, opts) => focusAnchor(index, opts),
      focusMarker: (index) => focusMarker(index),
      setNear: (index) => setNear(index),
      setQuote: (text) => setQuote(text),
      openPalette: () => paletteBox && paletteBox.open(),
    };

    const left = leftPane(api);
    paintCursor = left.paintCursor;

    let center;
    if (view === 'home') center = { el: viewHome(api), highlight: () => {}, focusMarker: () => {} };
    else if (view === 'lesson') center = viewLesson(api, cleanups, lessonBox, sectionBar);
    else center = viewSubject(api, cleanups);
    highlightNode = center.highlight || (() => {});
    focusMarker = center.focusMarker || (() => {});

    const right = inspectorPane(api, cleanups, lessonBox);
    refreshNotes = right.refreshNotes;
    focusAnchor = right.focusAnchor;
    setNear = right.setNear;
    setQuote = right.setQuote;

    shell = h('div.vb.vb--' + view, null,
      left.el,
      h('main.vb-pane.vb-center', null,
        centerHead(api, ctx, view, sectionBar),
        center.el),
      right.el,
      h('div.vb-drawerbg', { on: { click: () => shell.classList.remove('vb--drawer') } }));
    root.appendChild(shell);

    paintCursor();
    highlightNode(state.cursor);

    paletteBox = palette(api);
    shell.appendChild(paletteBox.el);

    /* 正文里划一段 → 问答面板带上它。划选是明确的动作，所以直接把页签切过去：
       工作台的主张就是「选中即问」，别让人再找一次入口。 */
    const onMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || !selection.anchorNode) return;
      const text = String(selection).trim();
      const prose = shell.querySelector('.vb-prose');
      if (!prose || text.length < 4 || !prose.contains(selection.anchorNode)) return;
      setQuote(text);
    };
    document.addEventListener('mouseup', onMouseUp);
    cleanups.push(() => document.removeEventListener('mouseup', onMouseUp));

    /* 键盘：↑↓ 走节点，回车打开，⌘K 开搜索，Esc 关浮层 / 回路线图。 */
    const onKeyDown = (event) => {
      const el = document.activeElement;
      const key = event.key || '';
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'k') {
        event.preventDefault();
        paletteBox.toggle();
        return;
      }
      if (key === 'Escape') {
        if (paletteBox.isOpen()) { paletteBox.close(); return; }
        if (typing) { el.blur(); return; }
        if (ctx.here.view !== 'subject') { event.preventDefault(); ctx.goto({ view: 'subject', subject: ctx.here.subject }); }
        return;
      }
      if (paletteBox.isOpen() || typing) return;   // 面板开着时 ↑↓ 归面板
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        const at = ids.indexOf(state.cursor);
        const next = Math.max(0, Math.min(ids.length - 1, (at < 0 ? 0 : at) + (key === 'ArrowDown' ? 1 : -1)));
        api.setCursor(ids[next]);
        return;
      }
      if (key === 'Enter' && state.cursor) {
        const target = SM.data.node(subject.slug, state.cursor);
        if (target) { event.preventDefault(); api.open(target); }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    cleanups.push(() => window.removeEventListener('keydown', onKeyDown));

    return { destroy() { cleanups.forEach((fn) => fn()); } };
  };

  /* ── 中栏顶栏（三种界面共用一条，位置固定不随正文滚）──────────────────── */

  function centerHead(api, ctx, view, sectionBar) {
    const subject = api.subject();
    const node = api.node;
    const top = h('div.vb-head__top');

    if (view === 'lesson' && node) {
      const summary = SM.attempts.summary(subject.slug, node);
      SM.append(top, [
        h('button.vb-btn.vb-btn--back', {
          type: 'button', on: { click: () => api.goto({ view: 'subject', subject: ctx.here.subject }) },
        }, icon('left', 14), subject.name),
        h('span.vb-head__no', { text: node.number || '' }),
        h('h1.vb-head__title', { text: node.title }),
        h('span.sm-chip.sm-chip--kind', { text: node.kind }),
        tierChip(node),
        node.lab ? h('span.sm-chip', null, icon('lab', 12), 'lab') : null,
        h('span.vb-head__spacer'),
        h('span.vb-head__meter', { text: `作答 ${summary.answered} / ${summary.total}` })]);
    } else if (view === 'subject') {
      SM.append(top, [
        h('span.vb-head__no', { text: subject.status }),
        h('h1.vb-head__title', { text: subject.name }),
        h('span.vb-head__spacer'),
        h('button.sm-btn', {
          type: 'button',
          on: {
            click: () => api.goto({
              view: 'lesson', subject: subject.slug,
              node: subject.continue_node || (subject.nodes[0] || {}).id || '',
            }),
          },
        }, '跳到当前节点 ', icon('right', 13))]);
    } else {
      SM.append(top, [
        h('h1.vb-head__title', { text: '今天学什么' }),
        h('span.vb-head__spacer'),
        h('button.sm-btn', {
          type: 'button',
          on: { click: () => api.goto({ view: 'subject', subject: subject.slug }) },
        }, subject.name + ' 路线图 ', icon('right', 13))]);
    }

    const drawer = h('button.vb-btn.vb-btn--drawer', {
      type: 'button', 'aria-pressed': 'false', title: '显示 / 隐藏检查器（窄窗口用）',
      on: {
        click() {
          const shell = drawer.closest('.vb');
          const open = shell.classList.toggle('vb--drawer');
          drawer.setAttribute('aria-pressed', String(open));
        },
      },
    }, icon('list', 14), '检查器');
    top.appendChild(drawer);

    const head = h('header.vb-head', null, top);
    if (view === 'lesson') head.appendChild(sectionBar);
    return head;
  }

  SM.variants.push(B);
})();
