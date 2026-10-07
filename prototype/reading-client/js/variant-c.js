/* ─────────────────────────────────────────────────────────────────────────
   变体 C · 卡片流与专注模式

   主张：**一次只做一件事**。首页是一块卡片仪表盘，把「接下来能做什么」摊开来；
   点任意一个节点就离开仪表盘，进到没有顶栏、没有侧栏的专注模式——一次只放一节正文，
   底边一条 rail 像播放器一样带你走节；题目不铺在正文流里，而是作为**步骤浮层**
   一题一屏地过。

   主要动作：在卡片上挑一件事 → 进专注模式做完 → 回卡片。
   （A 是一条正文栏从头滚到尾，B 是同时摊开的仪器面板——C 刻意两样都不像。）

   与 A/B 共用的是**解析与块级渲染**（content.js）与**题目结论**（quiz.js）：
   一块正文长什么样、一道题判对没判对，三个变体必须一致，否则比的就不是版式。
   块的**编排**才是这个文件的事。
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  const SM = (window.SM = window.SM || {});
  const { h, frag, clear, inline, icon } = SM;

  const TIERS = ['未开始', '学习中', '已学完'];
  const TIER_KEY = { 未开始: 'todo', 学习中: 'learning', 已学完: 'done' };
  const KIND_ORDER = ['正文', '题目', '术语', '大纲', '学习记录', '误解'];

  /* ── 共用小块 ─────────────────────────────────────────────────────────── */

  /** 进度的三档色是数据语义，三个变体共用；旧口径状态只在 title 里留一次。 */
  const tierChip = (tier, raw) => h('span.sm-chip.sm-chip--' + tier, {
    title: raw ? `进度按三档记；旧口径写作「${raw}」` : null,
  }, h('i.sm-dot.' + tier), tier);

  /**
   * 三档进度的堆叠条：`.sm-progressbar` 只能画一段（已学完 / 全部），
   * 这里要的是**分布**——未开始 / 学习中 / 已学完 各占多少，所以自己拼一个。
   */
  function stackBar(subject, options) {
    const settings = options || {};
    const total = subject.nodes.length || 1;
    const segs = TIERS.map((tier) => ({ tier, n: subject.stats[tier] || 0 })).filter((seg) => seg.n > 0);
    const bar = h('span.vc-stack' + (settings.tall ? '.vc-stack--tall' : ''), {
      role: 'img',
      'aria-label': `${subject.name}：` + TIERS.map((tier) => `${tier} ${subject.stats[tier] || 0} 个节点`).join('、'),
    }, segs.map((seg) => h('i.vc-stack__seg.vc-stack__seg--' + TIER_KEY[seg.tier], {
      style: { width: (seg.n / total) * 100 + '%' },
      title: `${seg.tier} ${seg.n} / ${total}`,
    })));
    return settings.bare ? bar : h('span.vc-stackline', null, bar,
      h('span.vc-stackline__label', { text: `共 ${total} 个节点 · ${subject.levels} 层` }));
  }

  const legend = (subject) => h('span.vc-legend', null, TIERS.map((tier) => h('span.vc-legend__item', null,
    h('i.vc-stack__seg.vc-stack__seg--' + TIER_KEY[tier]), `${tier} ${subject.stats[tier] || 0}`)));

  const firstSentence = (text) => (SM.splitSentences(text || '')[0] || '').replace(/[；;，,]$/, '');

  const depTitle = (subject, id) => {
    const dep = subject.nodes.find((n) => n.id === id);
    return dep ? dep.title : '';
  };

  /** 记录文件 ↔ 节点：记录文件名就是课件的文件名，能对上就让人点回那一课。 */
  function nodeOfRecord(subject, record) {
    if (!record.file) return null;
    return subject.nodes.find((n) => n.lesson && n.lesson.endsWith(record.file)) || null;
  }

  /* ── 首页：卡片仪表盘 ─────────────────────────────────────────────────── */

  function heroCard(entry, other, opts) {
    const { subject, node } = entry;
    const total = subject.nodes.length;
    const done = subject.stats['已学完'] || 0;
    const note = firstSentence(node.notes);
    return h('article.vc-card.vc-hero', null,
      h('div.vc-hero__top', null,
        h('span.vc-eyebrow', { text: '继续学' }),
        h('span.vc-hero__subject', { text: subject.name }),
        tierChip(node.tier, node.raw_status)),
      h('h2.vc-hero__title', null,
        h('span.vc-hero__no', { text: node.number || '—' }),
        node.title),
      h('p.vc-hero__goal', null, inline(node.objective)),
      note ? h('p.vc-hero__note', { text: '上次：' + SM.truncate(note, 92) }) : null,
      h('div.vc-hero__meter', null,
        stackBar(subject, { bare: true }),
        h('span.vc-meter__label', { text: `已学完 ${done} / ${total} · 共 ${subject.levels} 层` })),
      h('div.vc-hero__foot', null,
        h('button.sm-btn.sm-btn--primary.vc-big', {
          type: 'button', dataset: { proto: 'open-node' },
          on: { click: () => opts.openNode(subject, node) },
        }, '进课件 · 专注模式 ', icon('right', 15)),
        h('button.sm-btn', {
          type: 'button',
          on: { click: () => opts.goto({ view: 'subject', subject: subject.slug }) },
        }, '看大纲'),
        other ? h('button.vc-hero__other', {
          type: 'button',
          on: { click: () => opts.openNode(other.subject, other.node) },
        }, `${other.subject.name} · ${other.node.title}`, icon('right', 13)) : null));
  }

  function statTile(subject, opts) {
    const current = subject.slug === opts.current;
    const cont = subject.nodes.find((n) => n.id === subject.continue_node) || subject.nodes[0];
    return h('button.vc-tile', {
      type: 'button',
      'aria-label': `打开科目 ${subject.name} 的大纲`,
      // 这个钩子只贴给「当前科目」这块：它切的是当前科目的视图，别的科目不是。
      dataset: current ? { proto: 'nav-subject' } : {},
      on: { click: () => opts.goto({ view: 'subject', subject: subject.slug }) },
    },
      h('span.vc-tile__top', null,
        h('span.vc-tile__name', { text: subject.name }),
        current ? h('span.sm-chip.sm-chip--proto', { text: '当前科目' }) : h('span.vc-tile__status', { text: subject.status })),
      legend(subject),
      stackBar(subject),
      h('span.vc-tile__foot', null, icon('right', 13),
        cont ? `继续：${(cont.number || '') + ' ' + cont.title}`.trim() : '还没有节点'));
  }

  function misCard(rows, opts) {
    return h('article.vc-card.vc-card--mis', null,
      h('header.vc-card__head', null,
        h('span.vc-card__icon', null, icon('warn', 15)),
        h('h3.vc-card__title', { text: '误解待处理' }),
        h('span.sm-chip', { text: rows.length + ' 条' })),
      rows.length === 0 ? h('div.sm-empty', { text: '还没有误解记录。' })
        : h('ul.vc-mis', null, rows.slice(0, 3).map(({ subject, item }) => h('li', null,
          h('button.vc-mis__row', {
            type: 'button',
            on: { click: () => opts.goto({ view: 'subject', subject: subject.slug }) },
          },
            h('span.vc-mis__top', null,
              h('span.vc-mis__topic', { text: item.topic }),
              item.importance === 'high' ? h('span.vc-flag', { text: '要紧' }) : null,
              h('span.vc-mis__sub', { text: subject.name })),
            h('span.vc-mis__q', { text: SM.truncate(item.question, 74) }),
            h('span.vc-mis__fix', { text: '当时怎么解的：' + SM.truncate(item.answer_summary, 84) }))))));
  }

  function projectCard(subjects, opts) {
    const withProject = subjects.filter((s) => s.project);
    return h('article.vc-card.vc-card--proj', null,
      h('header.vc-card__head', null,
        h('span.vc-card__icon', null, icon('spark', 15)),
        h('h3.vc-card__title', { text: '项目里程碑' })),
      withProject.length === 0 ? h('div.sm-empty', { text: '还没有登记在做的项目。' })
        : h('div.vc-proj', null, withProject.map((s) => h('button.vc-proj__row', {
          type: 'button',
          on: { click: () => opts.goto({ view: 'subject', subject: s.slug }) },
        },
          h('span.vc-proj__sub', { text: s.name }),
          h('span.vc-proj__text', { text: SM.truncate(s.project, 120) })))));
  }

  function recordCard(rows, opts) {
    return h('article.vc-card.vc-card--rec', null,
      h('header.vc-card__head', null,
        h('span.vc-card__icon', null, icon('doc', 15)),
        h('h3.vc-card__title', { text: '最近学习记录' })),
      rows.length === 0 ? h('div.sm-empty', { text: '还没有学习记录。' })
        : h('ul.vc-rec', null, rows.slice(0, 4).map(({ subject, record, node }) => h('li', null,
          h('button.vc-rec__row', {
            type: 'button',
            on: {
              click: () => (node ? opts.openNode(subject, node) : opts.goto({ view: 'subject', subject: subject.slug })),
            },
          },
            h('span.vc-rec__date', { text: record.date || '—' }),
            h('span.vc-rec__title', { text: record.title }),
            h('span.vc-rec__sub', { text: node ? subject.name + ' · 回到这一课' : subject.name }))))));
  }

  function viewHome(ctx, opts) {
    const today = SM.data.workspace.today;
    const continues = SM.data.continues();
    const rows = SM.data.subjects
      .flatMap((s) => (s.misconceptions || []).map((item) => ({ subject: s, item })))
      .sort((a, b) => (b.item.importance === 'high') - (a.item.importance === 'high'));
    const records = SM.data.subjects
      .flatMap((s) => s.records.map((r) => ({ subject: s, record: r, node: nodeOfRecord(s, r) })))
      .sort((a, b) => (b.record.date || '').localeCompare(a.record.date || ''));

    return h('div.vc-page.vc-home', null,
      h('header.vc-top', null,
        h('div.vc-top__bar', null,
          h('span.vc-brand__mark', { text: '学' }),
          h('span.vc-top__name', { text: 'StudyMate' }),
          h('span.vc-top__spacer'),
          h('button.vc-searchbtn', {
            type: 'button', on: { click: opts.openSearch },
          }, icon('search', 15), '搜索', h('span.sm-kbd', { text: '⌘K' }))),
        h('div.vc-top__mid', null,
          h('h1.vc-top__title', { text: '今天学什么' }),
          h('p.vc-top__sub', { text: (today ? today + ' · ' : '') + '没有待复习队列。在下面挑一件事，进专注模式做完再回来。' }))),
      h('div.vc-grid', null,
        heroCard(continues[0], continues[1], opts),
        SM.data.subjects.map((subject) => statTile(subject, opts)),
        misCard(rows, opts),
        projectCard(SM.data.subjects, opts),
        recordCard(records, opts)));
  }

  /* ── 科目：一层一排的「台面」卡片 ─────────────────────────────────────── */

  function nodeCard(ctx, subject, node, opts) {
    const deps = node.prerequisites.map((id) => depTitle(subject, id)).filter(Boolean);
    const note = firstSentence(node.notes);
    const action = node.tier === '已学完' ? '复练' : (node.tier === '学习中' ? '接着做' : '开始');
    return h('article.vc-node.vc-node--' + SM.kindClass(node.kind), null,
      h('button.vc-node__hit', {
        type: 'button',
        dataset: { proto: 'open-node' },
        'aria-label': `进入专注模式：${node.title}`,
        on: { click: () => opts.openNode(subject, node) },
      },
        h('span.vc-node__top', null,
          h('span.vc-node__no', { text: node.number || '—' }),
          h('span.vc-node__title', { text: node.title }),
          node.lab ? h('span.sm-chip', null, icon('lab', 12), 'lab') : null),
        h('span.vc-node__chips', null,
          h('span.sm-chip.sm-chip--kind', { text: node.kind }),
          tierChip(node.tier, node.raw_status)),
        h('span.vc-node__goal', null, inline(node.objective)),
        // 前置依赖不画成图：一句话贴在卡片上，比一张要读的图快
        h('span.vc-node__dep', { text: deps.length ? '前置：' + deps.join(' · ') : '无前置依赖，可以从这里开始' }),
        note ? h('span.vc-node__note', { text: '上次：' + SM.truncate(note, 68) }) : null,
        h('span.vc-node__foot', null,
          h('span.vc-node__action', { text: action }),
          icon('right', 14))),
      node.concepts.length || node.pitfalls.length ? h('details.vc-node__more', null,
        h('summary', { text: `概念 ${node.concepts.length} · 卡点 ${node.pitfalls.length}` }),
        h('ul', null, node.concepts.map((c) => h('li', { text: c }))),
        node.pitfalls.map((p) => h('p', { text: '· ' + p }))) : null);
  }

  function viewSubject(ctx, opts) {
    const subject = ctx.subject();
    const stages = [];
    for (let i = 0; i < subject.levels; i++) stages.push({ level: i, nodes: subject.nodes.filter((n) => n.level === i) });
    const cont = subject.nodes.find((n) => n.id === subject.continue_node) || subject.nodes[0];
    const mis = (subject.misconceptions || []).length;

    return h('div.vc-page.vc-subject', null,
      h('header.vc-banner', null,
        h('div.vc-banner__main', null,
          h('button.vc-banner__back', {
            type: 'button', on: { click: () => opts.goto({ view: 'home' }) },
          }, icon('left', 15), '今天学什么'),
          h('div.vc-banner__titleline', null,
            h('h1.vc-banner__name', { text: subject.name }),
            h('span.sm-chip', { text: subject.status }),
            h('span.vc-banner__meta', { text: `自 ${subject.created_at} · ${subject.nodes.length} 个节点 · ${subject.levels} 层` })),
          h('p.vc-banner__goal', null, inline(subject.goal)),
          subject.project ? h('p.vc-banner__project', null,
            h('b', { text: '在做的项目：' }), SM.truncate(subject.project, 150)) : null),
        h('div.vc-banner__side', null,
          legend(subject),
          stackBar(subject, { tall: true }),
          h('button.sm-btn.sm-btn--primary.vc-big', {
            type: 'button', dataset: { proto: 'open-node' },
            on: { click: () => opts.openNode(subject, cont) },
          }, '进入专注模式 ', icon('right', 15)),
          h('span.vc-banner__foot', { text: `${mis} 条误解待处理 · 继续：${cont ? cont.title : '—'}` }))),
      h('section.vc-stages', null,
        h('div.vc-stages__head', null,
          h('h2.vc-stages__title', { text: '路线图' }),
          h('p.vc-stages__hint', { text: '一行一层：左边是依赖深度，卡片上的「前置」写清它建立在谁上面。点卡片进专注模式。' })),
        stages.filter((stage) => stage.nodes.length).map((stage) => h('div.vc-stage', null,
          h('div.vc-stage__gutter', null,
            h('span.vc-stage__no', { text: '第 ' + (stage.level + 1) + ' 层' }),
            h('span.vc-stage__count', { text: stage.nodes.length + ' 个节点' })),
          h('div.vc-stage__row', null, stage.nodes.map((node) => nodeCard(ctx, subject, node, opts)))))));
  }

  /* ── 专注模式 ─────────────────────────────────────────────────────────── */

  const anchorOf = (node, block) =>
    node.anchors[block.quizIndex] || { text: block.anchor, resolution: 'missing', keys: [], level: block.level };

  /**
   * 落点：**第一处还没做完的练习**所在的那一节。
   * 为什么不是第一节：C 的专注模式主张「接着把这件事做完」，不是从头重读一遍；
   * 真想从头读，rail 上按 ← 走回去就行。没有练习的节点自然落回第一节。
   */
  function landingIndex(sections, subject, node) {
    for (let i = 0; i < sections.length; i++) {
      const blocks = sections[i].blocks.filter((b) => b.type === 'quiz');
      if (!blocks.length) continue;
      const unfinished = blocks.some((block) => {
        const anchor = node.anchors[block.quizIndex];
        if (!anchor) return true;
        const key = (anchor.keys || [])[0];
        const list = (node.pool && node.pool[key]) || [];
        if (!list.length) return true; // 锚点没对上题：也算没做完
        return list.some((item, i2) => !SM.attempts.get(subject.slug, node.id, key, i2));
      });
      if (unfinished) return i;
    }
    return 0;
  }

  /** 只读预览一题的题干：ambiguous 里用来分辨「这几个键到底哪个是这道题」。 */
  const stemOf = (item) => SM.truncate(String(item.q || '').split('\n')[0], 60);

  const isTyping = (el) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

  function viewFocus(ctx, opts) {
    const subject = ctx.subject();
    const node = ctx.node();
    const stage = h('div.vc-focus__stage');
    const rail = h('div.vc-rail');
    const chrome = h('div.vc-focus__chrome');
    const focus = h('div.vc-focus' + (SM.proto && SM.proto.bare ? '.vc-focus--bare' : ''), null, chrome, stage, rail);

    let sections = [];
    let lesson = null;
    let index = 0;
    let stepEl = null;
    let summary = SM.attempts.summary(subject.slug, node);

    const go = (delta) => {
      if (stepEl || index + delta < 0 || index + delta >= sections.length) return;
      index += delta;
      C.at[node.id] = index;
      paintSection();
    };

    /* ── 顶上的两枚小 affordance（不是顶栏：没有横条，只有两枚钮）── */
    function paintChrome() {
      summary = SM.attempts.summary(subject.slug, node);
      SM.clear(chrome).appendChild(frag(
        h('button.vc-chipbtn', {
          type: 'button', dataset: { proto: 'nav-subject' }, title: '返回大纲（Esc）',
          on: { click: () => opts.goto({ view: 'subject' }) },
        }, icon('left', 14), subject.name),
        tierChip(node.tier, node.raw_status),
        h('span.vc-chipbtn.vc-chipbtn--static', { text: `作答数据 ${summary.answered} / ${summary.total}` }),
        h('span.vc-focus__spacer'),
        h('button.vc-chipbtn', { type: 'button', on: { click: opts.openSearch } },
          icon('search', 14), '搜索', h('span.sm-kbd', { text: '⌘K' }))));
    }

    /* ── 练习入口：正文流里那一块 ::: quiz 的位置 ─────────────────────── */
    function entryCard(block) {
      const anchor = anchorOf(node, block);
      const state = SM.quiz.stateOf(anchor);
      const key = (anchor.keys || [])[0];
      const list = state === 'resolved' ? SM.quiz.questions(node, anchor, key) : [];
      return h('section.vc-entry.vc-entry--' + state, { dataset: { anchor: String(block.quizIndex) } },
        h('div.vc-entry__main', null,
          h('span.vc-entry__badge', { text: '练习 · ' + (block.level || '理解') }),
          h('b.vc-entry__title', {
            text: state === 'resolved' ? `本节有练习 · ${list.length} 题` : SM.quiz.STATE_TEXT[state],
          }),
          h('span.vc-entry__anchor', { text: '锚点：' + anchor.text }),
          state !== 'resolved' ? h('span.vc-entry__note', { text: '判分入口关闭，点开看对账。' }) : null),
        state === 'resolved'
          ? h('button.sm-btn.sm-btn--primary', { type: 'button', on: { click: () => openStep([block], block) } }, '开始练习 ', icon('right', 14))
          : h('button.sm-btn', { type: 'button', on: { click: () => openStep([block], block) } }, '查看对账'));
    }

    /* ── 一节正文 ─────────────────────────────────────────────────────── */
    function paintSection() {
      const section = sections[index];
      if (!section) return;
      C.at[node.id] = index;
      const quizzes = section.blocks.filter((b) => b.type === 'quiz');
      // 节标题不进 .sm-prose：它是版式的一部分，不是正文内容
      // （顺带保证「选正文里的第一段」选到的是真的正文段落）
      const article = h('article.vc-section', null,
        h('header.vc-section__head', null,
          h('div.vc-section__kicker', null,
            h('span.vc-section__count', { text: `节 ${index + 1} / ${sections.length}` }),
            h('span.vc-section__sep', { text: '·' }),
            h('span', { text: `${subject.name} · ${(node.number || '') + ' ' + node.title}`.trim() })),
          h('h2.vc-section__title', { text: section.title })),
        h('div.vc-section__prose.sm-prose', null,
          // 题目不在正文流里长出来：这里只留一个入口，点开才是步骤浮层
          SM.renderBlocks(section.blocks, { node, subject, renderQuiz: (block) => entryCard(block) })));
      clear(stage).appendChild(article);
      stage.scrollTop = 0;
      paintChrome();
      paintRail(quizzes);
      // 一进来就落在有练习的那一节：把这节的步骤浮层打开，别让人再找一次入口
      if (quizzes.length && !C.dismissed[node.id]) openStep(quizzes, quizzes[0]);
    }

    function paintRail(quizzes) {
      const pct = sections.length > 1 ? (index / (sections.length - 1)) * 100 : 100;
      const count = quizzes.reduce((n, block) => {
        const anchor = anchorOf(node, block);
        return n + SM.quiz.questions(node, anchor, (anchor.keys || [])[0]).length;
      }, 0);
      SM.clear(rail).appendChild(frag(
        h('div.vc-rail__bar', { role: 'progressbar', 'aria-valuemin': 1, 'aria-valuemax': sections.length, 'aria-valuenow': index + 1 },
          h('i', { style: { width: pct + '%' } })),
        h('div.vc-rail__row', null,
          h('button.vc-rail__nav', {
            type: 'button', disabled: index === 0, title: '上一节（← 或 K）',
            on: { click: () => go(-1) },
          }, icon('left', 15), '上一节'),
          h('div.vc-rail__meta', null,
            h('span.vc-rail__count', { text: `节 ${index + 1} / ${sections.length}` }),
            h('span.vc-rail__title', { text: sections[index].title }),
            h('span.vc-rail__node', { text: `${(node.number || '') + ' ' + node.title}`.trim() })),
          quizzes.length
            ? h('button.vc-rail__practice', { type: 'button', on: { click: () => openStep(quizzes, quizzes[0]) } },
              icon('list', 14), `练习 ${count}`)
            : h('span.vc-rail__none', { text: '本节没有练习' }),
          h('button.vc-rail__nav', {
            type: 'button', disabled: index === sections.length - 1, title: '下一节（→ 或 J）',
            on: { click: () => go(1) },
          }, '下一节', icon('right', 15)))));
    }

    /* ── 步骤浮层：一题一屏 ───────────────────────────────────────────── */
    function openStep(blocks, startBlock) {
      if (stepEl) return;
      const items = [];
      for (const block of blocks) {
        const anchor = anchorOf(node, block);
        const state = SM.quiz.stateOf(anchor);
        const key = (anchor.keys || [])[0];
        const list = state === 'resolved' ? SM.quiz.questions(node, anchor, key) : [];
        if (state === 'resolved' && list.length) list.forEach((item, i) => items.push({ block, anchor, key, state, item, qIndex: i }));
        else if (state === 'resolved') items.push({ block, anchor, key, state: 'missing', item: null, qIndex: 0 });
        // stale / ambiguous / missing 各有各的画法，别在这里塌成同一种
        else items.push({ block, anchor, key, state, item: null, qIndex: 0 });
      }
      const start = items.find((it) => it.block === (startBlock || blocks[0]));
      let at = Math.max(0, items.indexOf(start));

      const kicker = h('span.vc-step__kicker');
      const counter = h('span.vc-step__count');
      const track = h('div.vc-step__track');
      const body = h('div.vc-step__body');
      const prevBtn = h('button.sm-btn', { type: 'button', on: { click: () => move(-1) } }, icon('left', 14), '上一题');
      const nextBtn = h('button.sm-btn.sm-btn--primary', { type: 'button', on: { click: () => move(1) } });
      let drop = null;
      const close = () => {
        if (!stepEl) return;
        document.removeEventListener('keydown', onKey);
        if (drop) drop();
        stepEl.remove();
        stepEl = null;
        focus.classList.remove('is-step');
        opts.layers.step--;
        C.dismissed[node.id] = true; // 关过一次就别再自动弹；正文里的入口还在
        paintChrome();
      };
      const card = h('section.vc-step__card', null,
        h('header.vc-step__head', null,
          kicker,
          counter,
          h('span.vc-step__spacer'),
          h('button.sm-btn.sm-btn--ghost', { type: 'button', on: { click: close } },
            '返回正文', h('span.sm-kbd', { text: 'Esc' }))),
        track,
        body,
        h('footer.vc-step__foot', null,
          prevBtn,
          h('span.vc-step__hint', { text: '← → 翻题 · 答完再看对错' }),
          nextBtn));
      stepEl = h('div.vc-step', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '本节练习' }, card);
      focus.appendChild(stepEl);
      focus.classList.add('is-step'); // rail 留在浮层之上当播放器，但这时不吃点击
      drop = opts.pushEscape(close);
      opts.layers.step++;

      function move(delta) {
        if (at + delta < 0) return;
        if (at + delta >= items.length) { close(); return; }
        at += delta;
        paintStep();
      }
      // 浮层开着时，← → 归「翻题」，不归「翻节」，也不归脚手架的切变体
      function onKey(event) {
        if (isTyping(event.target) || opts.layers.search || opts.layers.ask) return;
        if (event.key === 'ArrowRight' || event.key === 'j' || event.key === 'J') { event.preventDefault(); event.stopPropagation(); move(1); }
        else if (event.key === 'ArrowLeft' || event.key === 'k' || event.key === 'K') { event.preventDefault(); event.stopPropagation(); move(-1); }
      }
      document.addEventListener('keydown', onKey);

      function paintStep() {
        const it = items[at];
        SM.clear(kicker).appendChild(frag(
          h('span', { text: it.state === 'resolved' ? '本节练习 · ' + (it.block.level || '理解') : '锚点对账' }),
          h('span.sm-chip' + (it.state === 'resolved' ? '' : '.sm-chip--proto'), { text: '锚点：' + it.anchor.text })));
        counter.textContent = it.state === 'resolved' ? `第 ${at + 1} / ${items.length} 题` : '判分入口关闭';
        SM.clear(track).appendChild(frag(items.map((_, i) => h('i.vc-track__dot' + (i === at ? '.is-on' : '')))));
        SM.clear(body).appendChild(it.state === 'resolved' ? questionView(it) : stateView(it));
        prevBtn.disabled = at === 0;
        SM.clear(nextBtn).appendChild(frag(at === items.length - 1 ? '做完，回正文' : frag('下一题', icon('right', 14))));
      }

      function questionView(it) {
        const wrap = h('div.vc-q');
        const review = SM.quiz.review(subject.slug, node, it.key, it.qIndex);
        wrap.appendChild(h('div.vc-q__ask', null,
          h('span.vc-q__no', { text: 'Q' + (it.qIndex + 1) }),
          h('div.vc-q__text', null, String(it.item.q).split('\n').map((line) => h('p', null, line)))));
        if (review) wrap.appendChild(h('div.vc-q__prev', { text: review }));

        if (!SM.quiz.isOpen(it.item)) {
          const list = h('div.vc-q__opts', { role: 'group', 'aria-label': '选项' });
          const why = h('div.vc-q__why', { hidden: true });
          it.item.opts.forEach((opt, i) => {
            const btn = h('button.vc-opt', {
              type: 'button', dataset: { proto: 'option' },
              on: {
                click() {
                  const result = SM.quiz.judge(it.item, i);
                  SM.quiz.record(subject.slug, node, it.key, it.qIndex, { chosen: i, correct: result.correct });
                  [...list.children].forEach((el) => el.classList.remove('is-picked', 'is-right', 'is-wrong'));
                  btn.classList.add('is-picked', result.correct ? 'is-right' : 'is-wrong');
                  if (!result.correct && list.children[it.item.ans]) list.children[it.item.ans].classList.add('is-right');
                  SM.clear(why).appendChild(h('div.sm-note' + (result.correct ? '.sm-note--brand' : '.sm-note--error'), null,
                    h('span.sm-note__icon', null, icon(result.correct ? 'check' : 'warn', 16)),
                    h('div', null,
                      h('b', { text: result.correct ? '对了' : `不对，答案是 ${SM.quiz.letter(it.item.ans)}` }),
                      h('div', { text: result.why }),
                      h('div.vc-q__meta', { text: '已记进作答数据（原型只在内存里，刷新即丢）' }))));
                  why.hidden = false;
                  paintChrome();
                },
              },
            }, h('span.vc-opt__letter', { text: SM.quiz.letter(i) }), h('span.vc-opt__text', null, opt));
            list.appendChild(btn);
          });
          wrap.append(list, why);
        } else {
          const field = h('textarea.vc-q__answer', { rows: 4, placeholder: '先自己写一遍，再展开参考答案对照。' });
          const panel = h('div.vc-q__ref', { hidden: true });
          wrap.append(field, h('div.vc-q__actions', null,
            h('button.sm-btn', {
              type: 'button',
              on: {
                click(event) {
                  panel.hidden = false;
                  event.target.disabled = true;
                  SM.clear(panel).appendChild(frag(
                    h('div.vc-q__block', null, h('h4', { text: '参考答案' }),
                      String(it.item.answer || '').split('\n').map((l) => h('p', null, l))),
                    h('div.vc-q__block', null, h('h4', { text: '判分要点' }),
                      String(it.item.criteria || '').split('\n').map((l) => h('p', null, l))),
                    h('div.vc-q__self', null,
                      h('span', { text: '自评：' }),
                      ['答对了', '答了一半', '没答上'].map((label, i) => h('button.sm-btn', {
                        type: 'button',
                        on: {
                          click() {
                            SM.quiz.record(subject.slug, node, it.key, it.qIndex, { chosen: null, correct: i === 0, self: label });
                            SM.clear(panel.querySelector('.vc-q__self')).appendChild(
                              h('span.sm-chip.sm-chip--学习中', { text: '已记：' + label + '（自评不算独立通过证据）' }));
                            paintChrome();
                          },
                        },
                      }, label)))));
                },
              },
            }, '展开参考答案'),
            h('span.vc-q__meta', { text: '开放题不自动判分：展开后自己对照，自评只当线索' })));
          wrap.appendChild(panel);
        }
        return wrap;
      }

      /** 三种「对不上」的状态：都不判分，把该给人看的东西摊在明面上。 */
      function stateView(it) {
        const state = it.state;
        const box = h('div.vc-state.vc-state--' + state);
        box.appendChild(h('div.vc-state__head', null,
          h('span.vc-state__icon', null, icon('warn', 17)),
          h('b', { text: SM.quiz.STATE_TEXT[state] }),
          h('span.sm-chip', { text: '锚点：' + it.anchor.text })));
        box.appendChild(h('p.vc-state__note', { text: SM.quiz.STATE_NOTE[state] }));

        if (state === 'stale') {
          const left = it.anchor.text || '';
          const right = it.key || '（没找到）';
          const diff = diffTail(left, right);
          box.appendChild(h('div.vc-pair', null,
            h('div.vc-pair__side', null,
              h('span.vc-pair__label', { text: `正文文字 · ${left.length} 字` }),
              h('code', { text: left || '（空）' })),
            h('span.vc-pair__arrow', null, icon('right', 16)),
            h('div.vc-pair__side', null,
              h('span.vc-pair__label', { text: `题库键 · ${right.length} 字` }),
              h('code', { text: right }))));
          box.appendChild(h('p.vc-state__diff', {
            text: diff
              ? `两边只差这段：${diff}——空白也算差，所以要人来确认；多匹配绝不静默取第一个。`
              : '原型把锚点强制成 stale 时，这份数据里两边字面完全相同。真出现 stale 时，差的字符就摆在上面对照里。',
          }));
        }

        if (state === 'ambiguous') {
          const keys = it.anchor.keys || [];
          const preview = h('div.vc-keys__preview');
          const show = (key) => {
            const list = (node.pool && node.pool[key]) || [];
            SM.clear(preview).appendChild(list.length
              ? frag(list.map((item) => h('div.vc-keys__item', null,
                h('span.vc-keys__index', { text: '题' }), h('span', null, stemOf(item)))))
              : h('div.sm-empty', { text: '这个键底下没有题。' }));
          };
          box.appendChild(h('p.vc-state__hint', {
            text: keys.length > 1
              ? `同一段正文下有 ${keys.length} 个题库键都能对上，选一个才算数：`
              : '候选题库键（选一个才算数）：',
          }));
          box.appendChild(h('ul.vc-keys', null, keys.map((key, i) => h('li', null,
            h('label.vc-keys__row', null,
              h('input', {
                type: 'radio', name: 'vc-key-' + it.block.quizIndex, checked: i === 0,
                on: { change: () => show(key) },
              }),
              h('code', { text: key }),
              h('span.vc-keys__n', { text: ((node.pool && node.pool[key]) || []).length + ' 题' }))))));
          box.appendChild(preview);
          show(keys[0]); // 默认键的题干直接摆出来，省一次点击
          if (keys.length < 2) {
            box.appendChild(h('p.vc-state__diff', {
              text: '原型把锚点强制成 ambiguous 时，这份数据里只有一个键能对上。真出现 ambiguous 时，能对上的键会全部列在这里让你挑。',
            }));
          }
        }

        if (state === 'missing') {
          const flag = h('button.sm-btn', { type: 'button' }, '标记「这道题缺了」');
          flag.addEventListener('click', () => {
            flag.disabled = true;
            flag.after(h('span.sm-chip.sm-chip--proto', {
              style: { marginLeft: '10px' }, text: '已标记（原型只在内存里记一笔）',
            }));
          });
          box.appendChild(h('div.vc-state__act', null, flag));
        }

        const orphans = node.orphan_keys || [];
        if (orphans.length) {
          box.appendChild(h('div.vc-orphans', null,
            h('b', { text: `题库里还有 ${orphans.length} 个键没人认领：` }),
            h('ul', null, orphans.map((key) => h('li', null,
              h('code', { text: key }),
              h('span', { text: ` ${((node.pool && node.pool[key]) || []).length} 题` }))))));
        }
        box.appendChild(h('p.vc-state__lock', { text: '这个状态下不判分、不记作答数据：对不上的锚点由人确认，绝不静默取第一个键。' }));
        return box;
      }

      paintStep();
      const firstOption = stepEl.querySelector('[data-proto="option"]');
      if (firstOption) firstOption.focus({ preventScroll: true });
    }

    /** 「只差空白」得让人看见差在哪：切掉两边最长的共同前后缀，剩下的就是差。 */
    function diffTail(left, right) {
      let head = 0;
      while (head < left.length && head < right.length && left[head] === right[head]) head++;
      let tail = 0;
      while (tail < left.length - head && tail < right.length - head
        && left[left.length - 1 - tail] === right[right.length - 1 - tail]) tail++;
      const cut = left.slice(head, left.length - tail);
      return cut.replace(/\s/g, '␣');
    }

    /* ── 载入课件内容文件 ─────────────────────────────────────────────── */
    function paintNoLesson(error) {
      SM.clear(stage).appendChild(h('article.vc-section.vc-section--empty', null,
        h('header.vc-section__head', null,
          h('div.vc-section__kicker', null, h('span', { text: `${subject.name} · ${(node.number || '') + ' ' + node.title}`.trim() })),
          h('h2.vc-section__title', { text: node.title })),
        h('div.sm-empty', { text: error ? '这节课的课件内容文件读不出来。' : '这个节点还没有课件内容文件——先看大纲里的目标与卡点。' }),
        h('div.vc-empty__meta', null,
          h('div.vc-empty__block', null, h('h4', { text: '本节目标' }), h('p', null, inline(node.objective))),
          node.problem ? h('div.vc-empty__block', null, h('h4', { text: '要解决的问题' }), h('p', { text: node.problem })) : null,
          node.concepts.length ? h('div.vc-empty__block', null, h('h4', { text: '概念' }),
            h('ul', null, node.concepts.map((c) => h('li', { text: c })))) : null,
          node.pitfalls.length ? h('div.vc-empty__block', null, h('h4', { text: '常见卡点' }),
            h('ul', null, node.pitfalls.map((p) => h('li', { text: p })))) : null)));
      SM.clear(rail).appendChild(h('div.vc-rail__row', null,
        h('button.vc-rail__nav', { type: 'button', on: { click: () => opts.goto({ view: 'subject' }) } },
          icon('left', 15), '回大纲'),
        h('div.vc-rail__meta', null,
          h('span.vc-rail__count', { text: '没有课件' }),
          h('span.vc-rail__title', { text: node.title }),
          h('span.vc-rail__node', { text: node.tier + ' · ' + node.kind }))));
    }

    if (!node.lesson) {
      paintChrome();
      paintNoLesson(null);
    } else {
      paintChrome();
      stage.appendChild(h('div.vc-focus__loading', { text: '正在读课件内容文件…' }));
      SM.data.loadLesson(node).then((parsed) => {
        if (!parsed || parsed.error) { paintNoLesson(parsed); return; }
        lesson = parsed;
        opts.shared.lesson = parsed;
        opts.shared.subject = subject;
        // 第一个空壳（正文直接从 h2 开始时的 meta.title 段）不进 rail：
        // 「节 N / M」要数的是真有内容的那几节
        sections = parsed.sections.filter((s) => s.blocks.length);
        if (!sections.length) sections = parsed.sections;
        index = typeof C.at[node.id] === 'number' && C.at[node.id] < sections.length
          ? C.at[node.id]
          : landingIndex(sections, subject, node);
        paintSection();
      });
    }

    /* ── 键盘：← → / J K 翻节；Esc 交给最上面那层浮层（mount 里统一收） ──
       注意：原型脚手架的切换条也监听 ← →（切变体）。专注模式里翻节是主要动作，
       所以这里处理了就把事件截住，别让一次按键既翻节又换变体；回到看板后照旧能切。 */
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      if (opts.blocked()) return; // 有浮层开着时，方向键归浮层
      if (event.key === 'ArrowRight' || event.key === 'j' || event.key === 'J') { event.preventDefault(); event.stopPropagation(); go(1); }
      else if (event.key === 'ArrowLeft' || event.key === 'k' || event.key === 'K') { event.preventDefault(); event.stopPropagation(); go(-1); }
    };
    document.addEventListener('keydown', onKey);
    opts.cleanups.push(() => document.removeEventListener('keydown', onKey));

    // 专注模式里不给页面留滚动条：正文在 stage 里自己滚
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    opts.cleanups.push(() => { document.body.style.overflow = previousOverflow; });

    return focus;
  }

  /* ── 问答面板：从右边滑进来（A 是从底下升起，这里刻意不一样）──────────── */

  function askLayer(ctx, opts) {
    const chip = h('button.vc-askchip', { type: 'button', hidden: true, dataset: { proto: 'qa-chip' } }, icon('ask', 14), '就这段问一句');
    const scrim = h('div.vc-scrim');
    const panel = h('aside.vc-ask', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '问答面板' });
    const root = h('div.vc-layers__ask', null, scrim, panel, chip);
    let quote = '';
    let opened = false;
    let drop = null;

    const close = () => {
      if (!opened) return;
      opened = false;
      root.classList.remove('is-on');
      opts.layers.ask--;
      if (drop) { drop(); drop = null; }
    };

    const open = () => {
      if (opened) return;
      opened = true;
      chip.hidden = true;
      root.classList.add('is-on');
      opts.layers.ask++;
      drop = opts.pushEscape(close);
      SM.clear(panel).appendChild(frag(
        h('header.vc-ask__head', null,
          h('b', { text: '问答面板' }),
          h('span.sm-chip.sm-chip--proto', { text: '原型 · 假回答' }),
          h('span.vc-focus__spacer'),
          h('button.sm-btn.sm-btn--ghost', { type: 'button', 'aria-label': '关闭', on: { click: close } }, icon('close', 15))),
        h('blockquote.vc-ask__quote', { text: quote }),
        h('p.vc-ask__hint', { text: '面板只带当前课件、选中的这段与共享记忆，就地回答——不经过总控，也不背整个会话。' }),
        h('form.vc-ask__form', null,
          h('input', { type: 'text', placeholder: '哪里不懂？（回车即问）', 'aria-label': '你的问题', dataset: { proto: 'qa-input' } }),
          h('button.sm-btn.sm-btn--primary', { type: 'submit' }, '问')),
        h('div.vc-ask__body')));
      const input = panel.querySelector('input');
      input.focus({ preventScroll: true });
      panel.querySelector('form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const body = panel.querySelector('.vc-ask__body');
        SM.clear(body).appendChild(h('div.vc-ask__loading', { text: '正在就地回答…' }));
        const answer = await SM.qa.ask({ lesson: opts.shared.lesson, quote, question: input.value.trim() });
        SM.clear(body).appendChild(frag(
          answer.body.split('\n\n').filter(Boolean).map((p) => h('p', null, inline(p))),
          h('div.sm-note', null,
            h('span.sm-note__icon', null, icon('doc', 15)),
            h('div', null,
              h('b', { text: '已记一条误解记录' }),
              h('div', { text: `topic「${answer.misconception.topic}」· source ${answer.misconception.source} · status ${answer.misconception.status}——总控下次开场读得到。` })))));
      });
    };

    // 选中正文里的一段 → 冒出「就这段问一句」。只在专注模式的正文里认，别处选字不打扰。
    const onUp = () => {
      if (opened) return;
      const selection = window.getSelection();
      const text = selection ? String(selection).trim() : '';
      const anchor = selection && selection.anchorNode;
      const body = document.querySelector('.vc-focus__stage');
      if (!text || text.length < 4 || !anchor || !body || !body.contains(anchor)) { chip.hidden = true; return; }
      quote = text;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      chip.style.top = Math.max(72, rect.top - 42) + 'px';
      chip.style.left = Math.min(Math.max(16, rect.left + rect.width / 2 - 70), window.innerWidth - 200) + 'px';
      chip.hidden = false;
    };
    document.addEventListener('mouseup', onUp);
    opts.cleanups.push(() => {
      document.removeEventListener('mouseup', onUp);
      if (opened) { opts.layers.ask--; if (drop) drop(); }
    });
    chip.addEventListener('click', open);
    scrim.addEventListener('click', close);
    return { root, open, close };
  }

  /* ── 搜索浮层：任何界面都能叫出来 ─────────────────────────────────────── */

  function searchOverlay(ctx, opts) {
    const input = h('input', { type: 'search', placeholder: '搜正文、题目、术语、记录、误解…', 'aria-label': '搜索', dataset: { proto: 'search-input' } });
    const body = h('div.vc-search__body', null,
      h('div.sm-empty', { text: '输入关键词：跨科目搜课件正文、题库、术语表、学习记录与误解记录、大纲。' }));
    const panel = h('div.vc-search__panel', null,
      h('form.vc-search__field', { on: { submit: (e) => { e.preventDefault(); run(input.value.trim()); } } },
        icon('search', 15), input, h('span.sm-kbd', { text: 'Esc' })),
      body,
      h('footer.vc-search__foot', { text: '↑ ↓ 选结果 · 回车打开 · 搜到的节点直接进专注模式' }));
    const scrim = h('div.vc-search__scrim');
    const root = h('div.vc-search', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '搜索' }, scrim, panel);
    let opened = false;
    let drop = null;
    let token = 0;

    const close = () => {
      if (!opened) return;
      opened = false;
      root.classList.remove('is-on');
      opts.layers.search--;
      if (drop) { drop(); drop = null; }
    };
    const open = () => {
      if (opened) return;
      opened = true;
      root.classList.add('is-on');
      opts.layers.search++;
      drop = opts.pushEscape(close);
      input.focus({ preventScroll: true });
      input.select();
    };

    const pick = (hit) => {
      close();
      if (hit.node) opts.openNode(hit.subject, hit.node);
      else opts.goto({ view: 'subject', subject: hit.subject.slug });
    };

    const mark = (row) => {
      body.querySelectorAll('.vc-hits li').forEach((el) => el.classList.toggle('is-on', el === row));
    };

    function run(query) {
      if (!query) {
        open();
        SM.clear(body).appendChild(h('div.sm-empty', { text: '输入关键词再搜。' }));
        return;
      }
      open(); // 有人在搜，就把浮层叫出来（键盘、点击、脚本触发都走这里）
      const mine = ++token;
      SM.clear(body).appendChild(frag(
        h('p.vc-search__echo', null, '关键词：', h('b', { text: query })),
        h('div.sm-empty', { text: '正在搜…' })));
      SM.data.search(query).then((found) => {
        if (mine !== token) return; // 打字快过搜索时，只认最后一次
        const groups = new Map();
        for (const hit of found) {
          if (!groups.has(hit.kind)) groups.set(hit.kind, []);
          groups.get(hit.kind).push(hit);
        }
        SM.clear(body).appendChild(h('p.vc-search__echo', null, '关键词：', h('b', { text: query })));
        if (!found.length) { body.appendChild(h('div.sm-empty', { text: `没搜到「${query}」。` })); return; }
        [...groups.entries()]
          .sort((a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]))
          .forEach(([kind, list]) => {
            body.appendChild(h('h3.vc-search__group', { text: `${kind} · ${list.length}` }));
            body.appendChild(h('ul.vc-hits', null, list.slice(0, 6).map((hit) => {
              const row = h('li', null, h('button.vc-hit', {
                type: 'button',
                on: { click: () => pick(hit), mouseenter: () => mark(row) },
              },
                h('span.vc-hit__kind', { text: hit.subject.name }),
                h('span.vc-hit__text', { text: SM.truncate(hit.text, 110) }),
                hit.label ? h('span.vc-hit__where', { text: SM.truncate(hit.label, 56) }) : null));
              return row;
            })));
          });
        mark(body.querySelector('.vc-hits li'));
      });
    }

    const onKey = (event) => {
      if (!opened) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const rows = [...body.querySelectorAll('.vc-hits li')];
        if (!rows.length) return;
        event.preventDefault();
        const current = rows.findIndex((el) => el.classList.contains('is-on'));
        const next = Math.min(rows.length - 1, Math.max(0, current + (event.key === 'ArrowDown' ? 1 : -1)));
        rows[next].scrollIntoView({ block: 'nearest' });
        mark(rows[next]);
      } else if (event.key === 'Enter' && event.target === input) {
        const on = body.querySelector('.vc-hits li.is-on .vc-hit');
        if (on) { event.preventDefault(); on.click(); }
      }
    };
    input.addEventListener('input', () => run(input.value.trim()));
    document.addEventListener('keydown', onKey);
    opts.cleanups.push(() => {
      document.removeEventListener('keydown', onKey);
      if (opened) { opts.layers.search--; if (drop) drop(); }
    });
    scrim.addEventListener('click', close);
    return { root, open, close };
  }

  /* ── 挂载 ─────────────────────────────────────────────────────────────── */

  const C = {
    key: 'C',
    name: '卡片流与专注模式',
    blurb: '首页是卡片仪表盘；点节点进没有顶栏的专注模式，一节一屏，题目是步骤浮层。',
    at: {},         // 每个节点看到第几节：回一次大纲再进来，接着上次那节
    dismissed: {},  // 这个节点上你已经关过练习浮层，别再自动弹
  };

  C.mount = function mount(root, ctx) {
    const cleanups = [];
    const layers = { step: 0, ask: 0, search: 0 };
    const escapeStack = []; // 后进先出：Esc 先关最上面那层
    let search = null;
    const opts = {
      cleanups,
      layers,
      current: ctx.here.subject,
      shared: { lesson: null, subject: null },
      goto: (patch) => ctx.goto(patch),
      openNode: (subject, node) => ctx.goto({ view: 'lesson', subject: subject.slug, node: node.id }),
      openSearch: () => search.open(),
      blocked: () => layers.step + layers.ask + layers.search > 0,
      pushEscape(fn) {
        escapeStack.push(fn);
        return () => { const i = escapeStack.indexOf(fn); if (i >= 0) escapeStack.splice(i, 1); };
      },
    };

    const focus = ctx.here.view === 'lesson';
    const page = h('div.vc-page' + (focus ? '.vc-page--focus' : ''));
    if (focus) page.appendChild(viewFocus(ctx, opts));
    else if (ctx.here.view === 'subject') page.appendChild(viewSubject(ctx, opts));
    else page.appendChild(viewHome(ctx, opts));
    root.appendChild(page);

    const ask = askLayer(ctx, opts);
    search = searchOverlay(ctx, opts);
    root.appendChild(ask.root);
    root.appendChild(search.root);

    // 全局键：⌘K 叫搜索；Esc 先关最上面那层浮层，没有浮层就退出专注模式
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        if (event.target === search.root.querySelector('input')) return;
        if (layers.search) search.close(); else search.open();
        return;
      }
      if (event.key !== 'Escape') return;
      if (escapeStack.length) { escapeStack[escapeStack.length - 1](); return; }
      if (focus) opts.goto({ view: 'subject' });
    };
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));

    return { destroy() { cleanups.forEach((fn) => fn()); } };
  };

  SM.variants.push(C);
})();
