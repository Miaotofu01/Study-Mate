/* ─────────────────────────────────────────────────────────────────────────
   题目与锚点：判分逻辑、作答记账、锚点四态的判定。

   三个变体都从这里取**结论**，但各自决定怎么把它画出来：
   题目在不在正文流里、四态怎么提示，是版式问题，归变体。
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  const SM = (window.SM = window.SM || {});

  const STATE_TEXT = {
    resolved: '锚点已对上',
    stale: '锚点与题库键只差空白',
    ambiguous: '一个锚点对上了多个题库键',
    missing: '题库里没有这道题',
  };

  const STATE_NOTE = {
    resolved: '',
    stale: '正文里的锚点文字与题库键不完全一致。多匹配绝不静默取第一个——这里要人来确认，确认前不判分。',
    ambiguous: '同一段正文下有多个题库键都能对上。原型把候选全列出来，选一个才算数。',
    missing: '正文里声明了这个锚点，题库里却没有对应的题。判分入口关闭，只能标记「这道题缺了」。',
  };

  const quiz = {
    STATE_TEXT,
    STATE_NOTE,

    /** 当前锚点该按哪种状态呈现：数据说了算，除非原型顶栏把它强行置成别的。 */
    stateOf(anchor) {
      const forced = SM.proto && SM.proto.anchorMode;
      return forced && forced !== 'auto' ? forced : (anchor.resolution || 'missing');
    },

    /** 锚点对应的题目；ambiguous 时 keys 有多个，由界面选一个再传进来。 */
    questions(node, anchor, key) {
      const useKey = key || anchor.keys[0];
      return (node.pool && node.pool[useKey]) || [];
    },

    /** 客观题判分；开放题没有对错，只有自评（目标态 §7.3：没有一轨叫 agent）。 */
    judge(item, choice) {
      if (typeof item.ans !== 'number') return null;
      return { correct: choice === item.ans, why: item.why || '' };
    },

    isOpen(item) { return typeof item.ans !== 'number'; },

    record(slug, node, anchorKey, index, patch) {
      return SM.attempts.record(slug, node.id, anchorKey, index, patch);
    },

    previous(slug, node, anchorKey, index) {
      return SM.attempts.get(slug, node.id, anchorKey, index);
    },

    /** 选项字母：题干与「上次你选了 B」都用它，别在两处各写一遍。 */
    letter(index) { return String.fromCharCode(65 + index); },

    /** 客观题判分后的一句话回顾，供「上次你选了 B」那类就地提示复用。 */
    review(slug, node, anchorKey, index) {
      const hit = this.previous(slug, node, anchorKey, index);
      if (!hit) return '';
      const chose = typeof hit.chosen === 'number' ? this.letter(hit.chosen) : '（自评）';
      return `上次你选了 ${chose}，${hit.correct ? '对了' : '错了'} · ${hit.at}`;
    },
  };

  SM.quiz = quiz;
})();
