/* ─────────────────────────────────────────────────────────────────────────
   数据层：读一次 data/workspace.json，建跨科目索引；作答与问答在内存里。

   与目标态的对应关系（目标态规格 §4.3）：
     · 学习内容的方向是 **agent → 文件 → 页面**。原型没有 Host 半，所以退化成构建期
       抽好的快照（tools/build-data.py 从 examples/ 里抽），前端只读。
     · 作答数据的方向是 **页面 → Host 半 → 文件**，前端不写任何学习内容。原型把这一跳
       断在内存里：刷新即丢，且**绝不回写** data/ 下的任何文件。
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  const SM = (window.SM = window.SM || {});

  const SUBJECT_LABEL = { 概念: '概念课', 实操: '实操课', 实验: '实验课' };

  /* ── 作答数据（内存桩）───────────────────────────────────────────────────
     真形状是 attempts/<NNNN>-<节点id>.json，每题带 id 与状态（目标态规格 §5.3）。
     这里只留「当场回顾」要用的那点东西：上次选了什么、对没对。
     写回真工作区要走 operationId + expectedVersion，冲突时拒绝并重读——原型不碰这条路。
     ───────────────────────────────────────────────────────────────────────── */
  const seeded = {
    // 演示「上次你选了 B」：这两条是**假造的**种子，不是 examples/ 里的真实作答历史
    'computer-networks|net.ip|/26 网段的可用范围|0': { chosen: 3, correct: false, at: '2026-09-24' },
    'linear-algebra|matrix.transform|零空间维数|0': { chosen: 0, correct: true, at: '2026-09-24' },
  };

  const attempts = new Map(Object.entries(seeded));

  SM.attempts = {
    key: (slug, nodeId, anchor, index) => `${slug}|${nodeId}|${anchor}|${index}`,
    get(slug, nodeId, anchor, index) { return attempts.get(this.key(slug, nodeId, anchor, index)) || null; },
    record(slug, nodeId, anchor, index, patch) {
      const key = this.key(slug, nodeId, anchor, index);
      const next = Object.assign({ at: '刚刚' }, attempts.get(key), patch);
      attempts.set(key, next);
      return next;
    },
    /** 一个节点里已答的题数 / 答对题数，供变体显示进度。 */
    summary(slug, node) {
      let answered = 0, correct = 0, total = 0;
      for (const anchor of node.anchors) {
        const list = node.pool[anchor.keys[0]] || [];
        list.forEach((q, i) => {
          total++;
          const hit = this.get(slug, node.id, anchor.keys[0], i);
          if (hit) { answered++; if (hit.correct) correct++; }
        });
      }
      return { answered, correct, total };
    },
  };

  /* ── 问答面板的假回答 ────────────────────────────────────────────────────
     真实现是面板独立调模型（目标态规格 §7.4），上下文只带当前课件 + 选中文本 + 共享记忆。
     原型不接模型，回一段**明显是假的**占位：把选中段落所在的 section 摘出来，套一个模板。
     界面上必须带「原型 · 假回答」徽标，别让人把占位文案当成真的讲解。
     ───────────────────────────────────────────────────────────────────────── */
  SM.qa = {
    ask({ lesson, quote, question }) {
      const section = (lesson.sections || []).find((s) => s.blocks.some(
        (b) => (b.type === 'para' && b.text.includes(quote.slice(0, 12))) || (b.type === 'heading' && quote.includes(b.text))));
      const where = section ? `你选中的这段在「${section.title}」里` : '你选中的这段在这节课里';
      const firstSentence = (section?.blocks || []).find((b) => b.type === 'para');
      return new Promise((resolve) => {
        setTimeout(() => resolve({
          mock: true,
          where,
          body: [
            `${where}。真阅读端这一步会把「当前课件 + 选中的那段 + 共享记忆」三样交给模型就地回答，不经过总控，也不背整个会话。`,
            question ? `你问的是：「${question}」。` : '',
            firstSentence ? `这一节的上下文是：${firstSentence.text.replace(/\*\*/g, '').slice(0, 90)}…` : '',
            '原型只演示面板长什么样、回答往哪落——这里的文字是占位，不是真讲解。',
          ].filter(Boolean).join('\n\n'),
          misconception: { topic: quote.slice(0, 18), source: '问答面板', status: '未处理' },
        }), 420 * (1 / Math.max(Number(getComputedStyle(document.documentElement).getPropertyValue('--sm-motion')) || 1, 0.01)));
      });
    },
  };

  /* ── 加载与索引 ────────────────────────────────────────────────────────── */

  // 搜索结果给的是从正文里切出来的片段，带 ** 与 $ 会很吵；只用于展示，不改数据。
  const stripMd = (text) => String(text)
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\$/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');


  const lessonCache = new Map();

  async function fetchText(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.text();
  }

  async function loadLesson(node) {
    if (!node.lesson) return null;
    if (lessonCache.has(node.lesson)) return lessonCache.get(node.lesson);
    const promise = fetchText('data/lessons/' + node.lesson)
      .then((markdown) => SM.parseLesson(markdown))
      .catch((error) => ({ error: String(error), meta: {}, blocks: [], sections: [] }));
    lessonCache.set(node.lesson, promise);
    return promise;
  }

  /** 跨科目搜索：覆盖目标态规格 §4.5 那五类，索引只在内存里，丢了随时重建。 */
  async function search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits = [];
    const seen = new Set();
    const add = (hit) => {
      // 同一段文字可能同时来自题型与术语两处，去重比多给几条更让人看得下去
      const fingerprint = hit.kind + '|' + hit.text;
      if (!hit.text || seen.has(fingerprint)) return;
      seen.add(fingerprint);
      hits.push(hit);
    };

    for (const subject of SM.data.subjects) {
      for (const node of subject.nodes) {
        const hit = (kind, text, extra) => {
          if (text && text.toLowerCase().includes(q)) add(Object.assign({ kind, text: stripMd(text), subject, node }, extra));
        };
        // 5. 大纲节点元信息
        hit('大纲', node.title, { weight: 3 });
        hit('大纲', node.objective, { label: '目标' });
        hit('大纲', node.problem, { label: '问题' });
        node.pitfalls.forEach((pitfall) => hit('大纲', pitfall, { label: '坑' }));

        // 2. 题库（题干 + 选项）
        for (const [anchor, list] of Object.entries(node.pool)) {
          list.forEach((item, i) => {
            hit('题目', item.q, { anchor, index: i });
            (item.opts || []).forEach((opt) => hit('题目', opt, { anchor, index: i, label: '选项' }));
          });
        }
      }

      // 3. 术语表（规范叫法与别名）—— 术语是科目级的，别放进节点循环里，否则一份会变成 N 份
      for (const group of subject.glossary) {
        for (const term of group.terms) {
          if (term.term.toLowerCase().includes(q)) add({ kind: '术语', text: term.term, label: stripMd(term.def), subject, node: null });
          else if (term.avoid && term.avoid.toLowerCase().includes(q)) add({ kind: '术语', text: term.term, label: '别名：' + term.avoid, subject, node: null });
        }
      }

      // 4. 学习记录与误解记录
      for (const record of subject.records) {
        const line = record.markdown.split('\n').find((l) => l.toLowerCase().includes(q) && !l.startsWith('#'));
        if (line) add({ kind: '学习记录', text: stripMd(line.trim()), subject, node: null, label: record.title });
      }
      for (const item of subject.misconceptions) {
        const text = `${item.topic} ${item.question} ${item.misunderstanding} ${item.answer_summary}`;
        if (text.toLowerCase().includes(q)) add({ kind: '误解', text: stripMd(item.topic), label: item.question, subject, node: null });
      }

      // 1. 课件正文（章节标题 + 全文）—— 要读课件内容文件，所以放在最后、按需加载
      for (const node of subject.nodes) {
        if (!node.lesson) continue;
        const lesson = await loadLesson(node);
        if (!lesson || lesson.error) continue;
        for (const section of lesson.sections) {
          if (section.title.toLowerCase().includes(q)) add({ kind: '正文', text: section.title, label: node.title, subject, node });
          for (const block of section.blocks) {
            if (block.type !== 'para') continue;
            const at = block.text.toLowerCase().indexOf(q);
            if (at < 0) continue;
            const snippet = block.text.slice(Math.max(0, at - 26), at + 62);
            add({ kind: '正文', text: '…' + stripMd(snippet) + '…', label: section.title, subject, node, section: section.index });
            break;
          }
        }
      }
    }
    return hits.slice(0, 40);
  }

  const listeners = new Set();

  const data = {
    workspace: null,
    subjects: [],
    ready: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    bySlug(slug) { return this.subjects.find((s) => s.slug === slug) || this.subjects[0]; },
    node(slug, nodeId) {
      const subject = this.bySlug(slug);
      return subject ? subject.nodes.find((n) => n.id === nodeId) || null : null;
    },
    /** 「继续学」：各科目当前节点，跨科目排一列（首页的主内容）。 */
    continues() {
      return this.subjects.map((subject) => ({
        subject,
        node: subject.nodes.find((n) => n.id === subject.continue_node) || subject.nodes[0],
      }));
    },
    loadLesson,
    /** 课件内容文件里 `::: figure ../assets/…` 的路径基址；按格式规范，相对的是 lessons/ 目录。 */
    assetBase(node) {
      if (!node.lesson) return '';
      return 'data/lessons/' + node.lesson.replace(/[^/]+$/, 'lessons/');
    },
    search,
    SUBJECT_LABEL,
  };

  SM.data = data;

  data.ready = fetchText('data/workspace.json')
    .then((text) => {
      const parsed = JSON.parse(text);
      data.workspace = parsed;
      data.subjects = parsed.subjects;
      for (const listener of listeners) listener(parsed);
      return parsed;
    })
    .catch((error) => {
      // fetch 在 file:// 下必然失败。把这条死路换成一句能照着做的话，别让人对着 CORS 报错猜。
      const box = document.createElement('div');
      box.className = 'sm-empty';
      box.style.cssText = 'max-width:560px;margin:12vh auto;text-align:left;line-height:1.8';
      box.innerHTML =
        '<h2 style="margin:0 0 12px">要用本地服务器打开</h2>' +
        '<p>浏览器不允许 <code>file://</code> 页面读取同目录的 JSON，所以直接双击 <code>index.html</code> 打不开。' +
        '在仓库根跑一条命令就行：</p>' +
        '<pre style="padding:12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);overflow-x:auto">npm run prototype</pre>' +
        '<p style="color:var(--dsw-alias-label-caption)">然后打开它打印出来的地址。</p>' +
        '<p style="color:var(--dsw-alias-label-caption);font-size:12px">原始报错：' + String(error) + '</p>';
      document.getElementById('app').appendChild(box);
      throw error;
    });
})();
