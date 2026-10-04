/* ─────────────────────────────────────────────────────────────────────────
   变体 A · 单栏阅读器

   主张：阅读端的主业是「读」。一条正文栏，右边一条极简目录，题目就长在正文里
   该出现的位置，别处不抢注意力。导航收在顶栏一行里，问答面板从底部升起、答完就走。

   主要动作：往下滚，读完，顺手做题。
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  const SM = (window.SM = window.SM || {});
  const { h, inline, icon } = SM;

  const TIERS = ['未开始', '学习中', '已学完'];

  /* ── 顶栏 ─────────────────────────────────────────────────────────────── */

  function topBar(ctx, opts) {
    const subject = ctx.subject();
    const subjects = SM.data.subjects;
    const onSearch = h('form.va-search', {
      on: {
        submit(event) {
          event.preventDefault();
          const value = event.target.querySelector('input').value.trim();
          if (value) opts.onSearch(value);
        },
      },
    }, icon('search', 15), h('input', { type: 'search', dataset: { proto: 'search-input' }, placeholder: '搜正文、题目、术语、记录…', 'aria-label': '搜索' }));

    return h('header.va-bar', null,
      h('div.va-bar__inner', null,
        h('a.va-brand', { href: '#', on: { click: (e) => { e.preventDefault(); opts.goto({ view: 'home' }); } } },
          h('span.va-brand__mark', { text: '学' }),
          h('span.va-brand__name', { text: 'StudyMate' })),
        h('nav.va-nav', null,
          h('button.va-nav__item', {
            type: 'button', 'aria-current': ctx.here.view === 'home' ? 'page' : null,
            on: { click: () => opts.goto({ view: 'home' }) },
          }, '今天学什么'),
          h('span.va-nav__sep'),
          subjects.map((s) => h('button.va-nav__item', {
            type: 'button', dataset: { proto: 'nav-subject' },
            'aria-current': (ctx.here.view === 'subject' || ctx.here.view === 'lesson') && s === subject ? 'page' : null,
            on: { click: () => opts.goto({ view: 'subject', subject: s.slug }) },
          }, s.name))),
        onSearch));
  }

  /* ── 首页：今天学什么 ─────────────────────────────────────────────────── */

  function continueCard(ctx, entry, opts) {
    const { subject, node } = entry;
    const stats = subject.stats;
    const done = stats['已学完'] || 0;
    const total = subject.nodes.length;
    const note = SM.splitSentences(node.notes)[0] || '';
    return h('article.va-continue', null,
      h('div.va-continue__top', null,
        h('span.va-continue__subject', { text: subject.name }),
        h('span.sm-chip' + (node.tier ? '.sm-chip--' + node.tier : ''), null, h('i.sm-dot.' + node.tier), node.tier)),
      h('h3.va-continue__title', null,
        h('span.va-continue__no', { text: node.number || '—' }),
        node.title),
      h('p.va-continue__goal', null, inline(node.objective)),
      note ? h('p.va-continue__note', { text: SM.truncate(note, 84) }) : null,
      h('div.va-continue__foot', null,
        h('div.va-continue__meter', null,
          h('div.sm-progressbar', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done, 'aria-label': `${subject.name} 已学完 ${done} / ${total} 个节点` },
            h('i', { style: { width: (total ? (done / total) * 100 : 0) + '%' } })),
          h('span', { text: `已学完 ${done} / ${total} · 共 ${subject.levels} 层` })),
        h('button.sm-btn.sm-btn--primary', {
          type: 'button',
          on: { click: () => opts.goto({ view: 'lesson', subject: subject.slug, node: node.id }) },
        }, '继续读 ', icon('right', 14))));
  }

  function viewHome(ctx, opts) {
    const today = SM.data.workspace.today;
    const records = SM.data.subjects
      .flatMap((s) => s.records.map((r) => ({ subject: s, record: r })))
      .sort((a, b) => (b.record.date || '').localeCompare(a.record.date || ''));

    return h('div.va-page', null,
      h('section.va-hero', null,
        h('p.va-hero__eyebrow', { text: today ? `${today} · 星期四` : '' }),
        h('h1.va-hero__title', { text: '今天学什么' }),
        h('p.va-hero__sub', { text: '没有待复习队列，也没有今天该刷多少题的汇总——接着上次的那个节点往下读就行。' })),
      h('div.va-continues', null, SM.data.continues().map((entry) => continueCard(ctx, entry, opts))),
      h('section.va-recent', null,
        h('h2.va-section__title', { text: '最近的学习记录' }),
        records.length === 0
          ? h('div.sm-empty', { text: '还没有学习记录。' })
          : h('ul.va-recent__list', null, records.map(({ subject, record }) =>
            h('li.va-recent__item', null,
              h('span.va-recent__date', { text: record.date || '—' }),
              h('div', null,
                h('div', { text: record.title }),
                h('div.va-recent__meta', { text: subject.name })))))));
  }

  /* ── 科目：路线图 + 附件 ──────────────────────────────────────────────── */

  function roadmapRow(ctx, subject, node, opts) {
    const deps = node.prerequisites
      .map((id) => (subject.nodes.find((n) => n.id === id) || {}).title)
      .filter(Boolean);
    const firstPitfall = node.pitfalls[0];
    const note = SM.splitSentences(node.notes)[0] || '';

    return h('li.va-node.va-node--' + SM.kindClass(node.kind), null,
      h('button.va-node__head', {
        type: 'button', dataset: { proto: 'open-node' },
        on: { click: () => opts.goto({ view: 'lesson', subject: subject.slug, node: node.id }) },
      },
        h('span.va-node__no', { text: node.number || '—' }),
        h('span.sm-dot.' + node.tier),
        h('span.va-node__title', { text: node.title }),
        h('span.sm-chip.sm-chip--kind', { text: node.kind }),
        h('span.sm-chip' + '.sm-chip--' + node.tier, { text: node.tier }),
        node.lab ? h('span.sm-chip', null, icon('lab', 12), 'lab') : null,
        h('span.va-node__spacer'),
        node.tier === '已学完' ? icon('check', 15) : icon('right', 15)),
      h('div.va-node__body', null,
        h('p.va-node__objective', null, inline(node.objective)),
        deps.length ? h('p.va-node__dep', { text: '依赖：' + deps.join(' · ') }) : h('p.va-node__dep', { text: '无前置依赖，可以从这里开始' }),
        note ? h('p.va-node__note', { text: '上次：' + SM.truncate(note, 88) }) : null,
        firstPitfall ? h('details.va-node__more', null,
          h('summary', { text: '常见卡点与概念（' + node.concepts.length + ' 个概念 · ' + node.pitfalls.length + ' 个坑）' }),
          h('ul', null, node.concepts.map((c) => h('li', { text: c }))),
          h('div.va-node__pitfalls', null, node.pitfalls.map((p) => h('p', { text: '· ' + p })))) : null));
  }

  function glossaryCard(subject) {
    return h('section.va-attach', null,
      h('h3', { text: '术语表' }),
      h('p.va-attach__hint', { text: '两节都算规范用词：课件正文与配图以这里为准。' }),
      subject.glossary.map((group) => h('div.va-glossary', null,
        h('h4', { text: group.title + ' · ' + group.terms.length }),
        h('dl.va-glossary__list', null, group.terms.map((term) => h('div.va-glossary__item', null,
          h('dt', { text: term.term }),
          h('dd', null, inline(term.def), term.avoid ? h('span.va-glossary__avoid', { text: '别叫：' + term.avoid }) : null)))))));
  }

  function viewSubject(ctx, opts) {
    const subject = ctx.subject();
    const levels = [];
    for (let i = 0; i < subject.levels; i++) levels.push(subject.nodes.filter((n) => n.level === i));
    const misconceptions = subject.misconceptions || [];

    return h('div.va-page', null,
      h('header.va-subject', null,
        h('p.va-hero__eyebrow', { text: subject.status + ' · 自 ' + subject.created_at }),
        h('h1.va-hero__title', { text: subject.name }),
        h('p.va-hero__sub', null, inline(subject.goal)),
        h('div.va-subject__stats', null, TIERS.map((tier) =>
          h('span.sm-chip.sm-chip--' + tier, null, h('i.sm-dot.' + tier), `${tier} ${subject.stats[tier] || 0}`)))),
      subject.project ? h('section.sm-note.sm-note--brand', null,
        h('span.sm-note__icon', null, icon('spark', 16)),
        h('div', null, h('b', { text: '在做的项目' }), h('div', { text: subject.project }))) : null,
      h('section.va-roadmap', null,
        h('h2.va-section__title', { text: '路线图' }),
        h('p.va-attach__hint', { text: '按前置依赖分层，从上往下读；点节点进课件。' }),
        h('ol.va-levels', null, levels.map((nodes, i) => h('li.va-level', null,
          h('div.va-level__gutter', null, h('span', { text: '第 ' + (i + 1) + ' 层' })),
          h('ul.va-level__nodes', null, nodes.map((node) => roadmapRow(ctx, subject, node, opts))))))),
      h('div.va-attach-grid', null,
        glossaryCard(subject),
        h('section.va-attach', null,
          h('h3', { text: '误解记录' }),
          misconceptions.length === 0 ? h('div.sm-empty', { text: '还没有误解记录。' })
            : h('ul.va-mis', null, misconceptions.map((item) => h('li', null,
              h('div.va-mis__topic', null, h('i.sm-dot.sm-dot--学习中'), item.topic,
                h('span.sm-chip', { text: item.importance === 'high' ? '要紧' : '一般' })),
              h('p', { text: item.question }),
              h('p.va-mis__fix', { text: '当时怎么解的：' + item.answer_summary }))))),
        h('section.va-attach', null,
          h('h3', { text: '学习记录' }),
          subject.records.length === 0 ? h('div.sm-empty', { text: '还没有学习记录。' })
            : h('ul.va-records', null, subject.records.map((r) => h('li', null,
              h('span.va-recent__date', { text: r.date || '—' }),
              h('div', null, h('div', { text: r.title })))))),
        h('section.va-attach', null,
          h('h3', { text: '参考资源' }),
          h('div.va-prose.sm-prose', null, SM.renderBlocks(SM.parseLesson(subject.resources_md).blocks, {})))));
  }

  /* ── 题目卡（在正文流里）──────────────────────────────────────────────── */

  function quizCard(ctx, node, block) {
    // 内容文件里的 ::: quiz 只声明「锚点文字是什么」；能不能对上题库是构建期算出来的，
    // 按 quizIndex 从 node.anchors 取回那份对账结果（四态就在里面）。
    const anchor = node.anchors[block.quizIndex] || { text: block.anchor, resolution: 'missing', keys: [], level: block.level };
    const state = SM.quiz.stateOf(anchor);
    const keys = anchor.keys || [];
    const questions = SM.quiz.questions(node, anchor, keys[0]);
    const card = h('section.va-quiz.va-quiz--' + state, { id: 'quiz-' + block.quizIndex });

    // 有理由地不出题（内容文件里的 empty_reason:）：这不是错误，别按「锚点找不到」报
    if (block.emptyReason) {
      return h('section.va-quiz.va-quiz--empty', { id: 'quiz-' + block.quizIndex },
        h('div.va-quiz__head', null,
          h('span.va-quiz__badge', { text: '练习 · ' + (block.level || '理解') }),
          h('span.va-quiz__anchor', { text: '锚点：' + anchor.text }),
          h('span.va-quiz__spacer'),
          h('span.sm-chip', { text: '本节不出题' })),
        h('div.sm-note', { style: { margin: '10px 14px' } },
          h('span.sm-note__icon', null, icon('doc', 16)),
          h('div', null, h('b', { text: '这一处有意留空' }), h('div', { text: block.emptyReason }))));
    }

    const head = h('div.va-quiz__head', null,
      h('span.va-quiz__badge', { text: '练习 · ' + (block.level || '理解') }),
      h('span.va-quiz__anchor', { text: '锚点：' + anchor.text }),
      h('span.va-quiz__spacer'),
      state === 'resolved'
        ? h('span.sm-chip', { text: questions.length + ' 题' })
        : h('span.sm-chip.sm-chip--proto', { text: SM.quiz.STATE_TEXT[state] }));
    card.appendChild(head);

    if (state !== 'resolved') {
      card.appendChild(h('div.sm-note.sm-note--warn', { style: { margin: '10px 14px' } },
        h('span.sm-note__icon', null, icon('warn', 16)),
        h('div', null,
          h('b', { text: SM.quiz.STATE_TEXT[state] }),
          h('div', { text: SM.quiz.STATE_NOTE[state] }),
          state === 'stale' ? h('div.va-quiz__pair', null,
            h('code', { text: '正文：' + anchor.text }),
            icon('right', 14),
            h('code', { text: '题库：' + (keys[0] || '（没找到）') })) : null,
          state === 'ambiguous' ? h('ul.va-quiz__keys', null, keys.map((key) =>
            h('li', null, h('label', null,
              h('input', { type: 'radio', name: 'anchor-' + block.quizIndex }),
              h('code', { text: key }),
              h('span', { text: (node.pool[key] || []).length + ' 题' })))))
            : null,
          state === 'missing' ? h('button.sm-btn', { type: 'button', style: { marginTop: '8px' } }, '标记「这道题缺了」') : null)));
    }

    if (state === 'resolved') {
      questions.forEach((item, index) => card.appendChild(questionView(ctx, node, anchor, keys[0], item, index)));
    }
    return card;
  }

  function questionView(ctx, node, anchor, anchorKey, item, index) {
    const open = SM.quiz.isOpen(item);
    const wrap = h('div.va-q');
    const review = SM.quiz.review(ctx.here.subject, node, anchorKey, index);

    wrap.appendChild(h('div.va-q__ask', null,
      h('span.va-q__no', { text: 'Q' + (index + 1) }),
      h('div.va-q__text', null, item.q.split('\n').map((line, i) => h('p', null, line, i === 0 && review ? h('span.va-q__review', { text: review }) : null)))));

    if (!open) {
      const list = h('div.va-q__opts', { role: 'group', 'aria-label': '选项' });
      const why = h('div.va-q__why', { hidden: true });
      item.opts.forEach((opt, i) => {
        const btn = h('button.va-opt', {
          type: 'button', dataset: { proto: 'option' },
          on: {
            click() {
              const result = SM.quiz.judge(item, i);
              SM.quiz.record(ctx.here.subject, node, anchorKey, index, { chosen: i, correct: result.correct });
              [...list.children].forEach((el) => el.classList.remove('is-picked', 'is-right', 'is-wrong'));
              btn.classList.add('is-picked', result.correct ? 'is-right' : 'is-wrong');
              if (!result.correct) list.children[item.ans].classList.add('is-right');
              SM.clear(why).appendChild(h('div.sm-note' + (result.correct ? '.sm-note--brand' : '.sm-note--error'), null,
                h('span.sm-note__icon', null, icon(result.correct ? 'check' : 'warn', 16)),
                h('div', null,
                  h('b', { text: result.correct ? '对了' : `不对，答案是 ${SM.quiz.letter(item.ans)}` }),
                  h('div', { text: result.why }),
                  h('div.va-q__meta', { text: '已记进作答数据（原型只在内存里，刷新即丢）' }))));
              why.hidden = false;
            },
          },
        }, h('span.va-opt__letter', { text: SM.quiz.letter(i) }), h('span', null, opt));
        list.appendChild(btn);
      });
      wrap.append(list, why);
    } else {
      const field = h('textarea.va-q__answer', { rows: 4, placeholder: '先自己写一遍，再展开参考答案对照。' });
      const panel = h('div.va-q__ref', { hidden: true });
      wrap.append(field, h('div.va-q__actions', null,
        h('button.sm-btn', {
          type: 'button',
          on: {
            click(event) {
              panel.hidden = false;
              event.target.disabled = true;
              SM.clear(panel).appendChild(SM.frag(
                h('div.va-q__refblock', null, h('h4', { text: '参考答案' }), h('div', null, item.answer.split('\n').map((l) => h('p', null, l)))),
                h('div.va-q__refblock', null, h('h4', { text: '判分要点' }), h('div', null, (item.criteria || '').split('\n').map((l) => h('p', null, l)))),
                h('div.va-q__self', null,
                  h('span', { text: '自评：' }),
                  ['答对了', '答了一半', '没答上'].map((label, i) => h('button.sm-btn', {
                    type: 'button',
                    on: {
                      click() {
                        SM.quiz.record(ctx.here.subject, node, anchorKey, index, { chosen: null, correct: i === 0, self: label });
                        SM.clear(panel.querySelector('.va-q__self')).appendChild(
                          h('span.sm-chip.sm-chip--学习中', { text: '已记：' + label + '（自评不算独立通过证据）' }));
                      },
                    },
                  }, label)))));
            },
          },
        }, '展开参考答案与判分要点'),
        h('span.va-q__meta', { text: '开放题不自动判分，展开后自己对照' })));
      wrap.appendChild(panel);
    }
    return wrap;
  }

  /* ── 课件 ─────────────────────────────────────────────────────────────── */

  function labCard(subject, node, opts) {
    if (!node.lab) return null;
    return h('section.va-lab', null,
      h('div.va-lab__head', null, icon('lab', 17), h('b', { text: '这一课的 lab' })),
      h('p', { text: SM.truncate(node.lab.readme.split('\n').filter((l) => l.trim() && !l.startsWith('#'))[0] || '', 120) }),
      h('ul.va-lab__files', null, node.lab.files.map((f) => h('li', null, h('code', { text: f })))),
      h('div.va-lab__foot', null,
        h('span.va-q__meta', { text: '实操题的判分由 Host 半代跑你本地的测试命令，输出原样记进作答数据。' }),
        h('button.sm-btn.sm-btn--primary', { type: 'button' }, '让引擎跑一遍测试')));
  }

  function viewLesson(ctx, opts) {
    const subject = ctx.subject();
    const node = ctx.node();
    const index = subject.nodes.findIndex((n) => n.id === node.id);
    const prev = subject.nodes[index - 1];
    const next = subject.nodes[index + 1];
    const host = h('article.va-lesson.sm-prose');
    const toc = h('nav.va-toc', { 'aria-label': '本节目录' });
    let lesson = null;

    SM.data.loadLesson(node).then((parsed) => {
      lesson = parsed;
      if (parsed.error) {
        host.appendChild(h('div.sm-empty', { text: '这节课还没有课件内容文件。' }));
        return;
      }
      const rendered = SM.frag();
      parsed.sections.forEach((section, i) => {
        if (!section.blocks.length && i === 0 && section.title === parsed.meta.title) return;
        const sectionNode = h('section.va-sec', { id: section.id, dataset: { section: String(i) } });
        sectionNode.appendChild(h('h2', { text: section.title }));
        sectionNode.appendChild(SM.renderBlocks(section.blocks, {
          node,
          subject,
          assetBase: SM.data.assetBase(node),
          renderQuiz: (block) => quizCard(ctx, node, block),
        }));
        rendered.appendChild(sectionNode);
        toc.appendChild(h('a.va-toc__link', {
          href: '#' + section.id,
          dataset: { section: String(i) },
          on: { click: (event) => { event.preventDefault(); sectionNode.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
        }, h('span', { text: section.title })));
      });
      host.appendChild(rendered);
      const lab = labCard(subject, node, opts);
      if (lab) host.appendChild(lab);
      host.appendChild(h('nav.va-navfoot', null,
        prev ? h('button.sm-btn', { type: 'button', on: { click: () => opts.goto({ view: 'lesson', node: prev.id }) } }, icon('left', 14), prev.title) : h('span'),
        next ? h('button.sm-btn', { type: 'button', on: { click: () => opts.goto({ view: 'lesson', node: next.id }) } }, next.title, icon('right', 14)) : h('span', { text: '这是最后一个节点' })));
      watchSections(host, toc, opts.cleanups);
    });

    const summary = SM.attempts.summary(ctx.here.subject, node);

    return h('div.va-page.va-page--lesson', null,
      h('header.va-lessonbar', null,
        h('button.va-lessonbar__back', { type: 'button', on: { click: () => opts.goto({ view: 'subject' }) } },
          icon('left', 15), subject.name),
        h('span.va-lessonbar__no', { text: node.number || '' }),
        h('span.va-lessonbar__title', { text: node.title }),
        h('span.sm-chip.sm-chip--kind', { text: node.kind }),
        h('span.sm-chip' + '.sm-chip--' + node.tier, null, h('i.sm-dot.' + node.tier), node.raw_status),
        h('span.va-lessonbar__spacer'),
        h('span.va-lessonbar__meta', { text: `作答 ${summary.answered} / ${summary.total}` })),
      h('div.va-lesson__grid', null,
        h('div.va-lesson__col', null,
          h('div.va-lesson__head', null,
            h('p.va-hero__eyebrow', { text: subject.name + ' · 第 ' + (node.number || '?') + ' 课' }),
            h('h1', { text: node.title }),
            h('p.va-lesson__goal', null, h('b', { text: '本节目标：' }), inline(node.objective))),
          host),
        toc),
      askLayer(ctx, opts, () => lesson));
  }

  function watchSections(host, toc, cleanups) {
    const links = [...toc.children];
    if (!links.length) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = entry.target.id;
        links.forEach((link) => link.classList.toggle('is-on', link.getAttribute('href') === '#' + id));
      }
    }, { rootMargin: '-72px 0px -70% 0px', threshold: 0 });
    [...host.querySelectorAll('.va-sec')].forEach((section) => observer.observe(section));
    cleanups.push(() => observer.disconnect());
  }

  /* ── 问答面板：选中正文 → 底部升起 ────────────────────────────────────── */

  function askLayer(ctx, opts, getLesson) {
    const chip = h('button.va-askchip', { type: 'button', hidden: true, dataset: { proto: 'qa-chip' } }, icon('ask', 14), '就这段问一句');
    const sheet = h('aside.va-sheet', { hidden: true, role: 'dialog', 'aria-label': '问答面板' });
    let quote = '';

    const close = () => { sheet.hidden = true; chip.hidden = true; };
    const open = () => {
      SM.clear(sheet).appendChild(SM.frag(
        h('div.va-sheet__head', null,
          h('b', { text: '问答面板' }),
          h('span.sm-chip.sm-chip--proto', { text: '原型 · 假回答' }),
          h('span.va-sheet__spacer'),
          h('button.sm-btn.sm-btn--ghost', { type: 'button', 'aria-label': '关闭', on: { click: close } }, icon('close', 15))),
        h('blockquote.va-sheet__quote', { text: quote }),
        h('p.va-sheet__hint', { text: '面板只带当前课件、选中的这段与共享记忆，就地回答，不经过总控，也不背整个会话。' }),
        h('form.va-sheet__form', null,
          h('input', { type: 'text', dataset: { proto: 'qa-input' }, placeholder: '哪里不懂？（可以直接回车）', 'aria-label': '你的问题' }),
          h('button.sm-btn.sm-btn--primary', { type: 'submit' }, '问')),
        h('div.va-sheet__body')));
      sheet.hidden = false;
      const body = sheet.querySelector('.va-sheet__body');
      sheet.querySelector('form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = event.target.querySelector('input');
        SM.clear(body).appendChild(h('div.va-sheet__loading', { text: '正在就地回答…' }));
        const answer = await SM.qa.ask({ lesson: getLesson(), quote, question: input.value.trim() });
        SM.clear(body).appendChild(SM.frag(
          answer.body.split('\n\n').map((p) => h('p', null, inline(p))),
          h('div.sm-note', null, h('span.sm-note__icon', null, icon('doc', 15)),
            h('div', null, h('b', { text: '已记一条误解记录' }),
              h('div', { text: `topic「${answer.misconception.topic}」· source ${answer.misconception.source} · status ${answer.misconception.status}——总控下次开场读得到。` })))));
      });
    };

    const onUp = () => {
      const selection = window.getSelection();
      const text = selection ? String(selection).trim() : '';
      const inside = selection && selection.anchorNode && sheet.contains(selection.anchorNode) === false
        && document.querySelector('.va-lesson__col')?.contains(selection.anchorNode);
      if (!text || text.length < 4 || !inside) { chip.hidden = true; return; }
      quote = text;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      chip.style.top = window.scrollY + rect.top - 40 + 'px';
      chip.style.left = Math.min(window.scrollX + rect.left + rect.width / 2 - 60, window.innerWidth - 190) + 'px';
      chip.hidden = false;
    };
    document.addEventListener('mouseup', onUp);
    opts.cleanups.push(() => document.removeEventListener('mouseup', onUp));
    chip.addEventListener('click', () => { chip.hidden = true; open(); });

    return h('div', null, chip, sheet);
  }

  /* ── 搜索 ─────────────────────────────────────────────────────────────── */

  const KIND_ORDER = ['正文', '题目', '术语', '大纲', '学习记录', '误解'];

  function viewSearch(ctx, opts, query) {
    const box = h('div.va-results', null, h('div.sm-empty', { text: '正在搜…' }));
    SM.data.search(query).then((hits) => {
      SM.clear(box);
      if (!hits.length) { box.appendChild(h('div.sm-empty', { text: `没搜到「${query}」。` })); return; }
      const groups = new Map();
      for (const hit of hits) {
        if (!groups.has(hit.kind)) groups.set(hit.kind, []);
        groups.get(hit.kind).push(hit);
      }
      [...groups.entries()]
        .sort((a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]))
        .forEach(([kind, list]) => {
          box.appendChild(h('h3.va-results__kind', { text: `${kind} · ${list.length}` }));
          box.appendChild(h('ul.va-results__list', null, list.slice(0, 8).map((hit) => h('li', null,
            h('button.va-hit', {
              type: 'button',
              on: { click: () => hit.node ? opts.goto({ view: 'lesson', subject: hit.subject.slug, node: hit.node.id }) : opts.goto({ view: 'subject', subject: hit.subject.slug }) },
            },
              h('span.va-hit__kind', { text: hit.subject.name }),
              h('span.va-hit__text', { text: SM.truncate(hit.text, 110) }),
              hit.label ? h('span.va-hit__label', { text: SM.truncate(hit.label, 60) }) : null)))));
        });
    });
    return h('div.va-page', null,
      h('header.va-subject', null,
        h('h1.va-hero__title', { text: '搜索' }),
        h('p.va-hero__sub', { text: `跨科目搜五类内容：课件正文、题库、术语表、学习记录与误解记录、大纲节点的目标与坑。` })),
      h('p.va-search__echo', null, '关键词：', h('b', { text: query })),
      box);
  }

  /* ── 挂载 ─────────────────────────────────────────────────────────────── */

  const A = {
    key: 'A',
    name: '单栏阅读器',
    blurb: '一条正文栏 + 右侧极简目录，题目长在正文里；以「读」为主。',
  };

  A.mount = function mount(root, ctx) {
    const cleanups = [];
    const page = h('div.va');
    const opts = {
      cleanups,
      goto: (patch) => ctx.goto(patch),
      onSearch: (query) => { A.query = query; ctx.goto({ view: 'search' }); },
    };
    page.appendChild(topBar(ctx, opts));
    const view = ctx.here.view;
    if (view === 'subject') page.appendChild(viewSubject(ctx, opts));
    else if (view === 'lesson') page.appendChild(viewLesson(ctx, opts));
    else if (view === 'search') page.appendChild(viewSearch(ctx, opts, A.query || ''));
    else page.appendChild(viewHome(ctx, opts));
    root.appendChild(page);

    return { destroy() { cleanups.forEach((fn) => fn()); } };
  };
  A.query = '';

  SM.variants.push(A);
})();
