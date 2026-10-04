/* ─────────────────────────────────────────────────────────────────────────
   原型的脚手架：底部变体切换条 + 两件演示用开关。

   按 prototype 技能的要求：左箭头 / 变体标签 / 右箭头，←→ 键也能切，变体写进
   ?variant= 便于分享与刷新保持，样式刻意做得不像页面的一部分。

   额外的两件（锚点四态、动效档）是**原型专用**：它们演的是目标态规格里已经定死
   但界面上还没见过的东西（§4.4 锚点四态、§4.4 动效四档）。合入真代码时整份删掉。
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  const SM = (window.SM = window.SM || {});
  const { h, icon } = SM;

  // 原型开关：真阅读端里没有这些东西，所以集中在一个对象上，删的时候一处就够
  const proto = (SM.proto = {
    anchorMode: 'auto',   // auto | stale | ambiguous | missing —— 只在「原型」这个语境里有意义
    motion: 'auto',
    bare: false,          // ?bare=1 时连原型顶栏都不渲染，用来出干净的截图
  });

  const ANCHOR_MODES = [
    ['auto', '正常（按数据）'],
    ['stale', 'stale 锚点对不上'],
    ['ambiguous', 'ambiguous 一个锚点两个键'],
    ['missing', 'missing 题库里没有'],
  ];

  function mountSwitcher({ variants, current, onChange }) {
    if (proto.bare) return { destroy() {} };

    const label = h('div.sm-proto-bar__label');
    const dots = h('div.sm-proto-bar__dots', null, variants.map(() => h('i')));

    const paint = (variant) => {
      SM.clear(label).appendChild(SM.frag(
        h('b', { text: variant.key }),
        ' ',
        h('span', { text: '(' + variant.name + ')' })));
      [...dots.children].forEach((dot, i) => { dot.dataset.on = variants[i] === variant ? '1' : '0'; });
    };

    const step = (delta) => {
      const at = variants.indexOf(SM.app.variant);
      onChange(variants[(at + delta + variants.length) % variants.length]);
    };

    const anchorField = h('label.sm-proto-bar__field', { title: '把当前课件的锚点强行置成某种状态，看界面怎么报' },
      '锚点',
      h('select', {
        on: {
          change(e) {
            proto.anchorMode = e.target.value;
            window.dispatchEvent(new CustomEvent('sm:anchor-mode'));
          },
        },
      }, ANCHOR_MODES.map(([value, text]) => h('option', { value, text, selected: value === proto.anchorMode }))));

    const motionField = h('label.sm-proto-bar__field', { title: '动效分档：auto 跟系统，其余三档手动' },
      '动效',
      h('select', {
        on: {
          change(e) {
            proto.motion = e.target.value;
            if (e.target.value === 'auto') delete document.documentElement.dataset.motion;
            else document.documentElement.dataset.motion = e.target.value;
          },
        },
      }, ['auto', 'full', 'reduced', 'off'].map((value) => h('option', { value, text: value, selected: value === proto.motion }))));

    const themeBtn = h('button.sm-proto-bar__btn', {
      type: 'button', title: '切换深浅主题', 'aria-label': '切换深浅主题',
      on: { click: () => { SM.theme.toggle(); paintTheme(); } },
    });
    const paintTheme = () => SM.clear(themeBtn).appendChild(SM.icon(SM.theme.get() === 'dark' ? 'sun' : 'moon', 15));

    const help = h('div.sm-proto-help', { hidden: true });
    const helpBtn = h('button.sm-proto-bar__btn', {
      type: 'button', title: '这个原型在比什么', 'aria-label': '这个原型在比什么', 'aria-pressed': 'false',
      on: {
        click() {
          help.hidden = !help.hidden;
          helpBtn.setAttribute('aria-pressed', String(!help.hidden));
        },
      },
    }, SM.icon('ask', 15));

    help.append(
      h('h3', { text: '三个变体在比什么' }),
      h('p', { text: '同一个阅读端（今天学什么 / 科目路线图 / 课件 / 搜索 / 问答面板）、同一份真数据（examples/ 里的计算机网络与线性代数），只换版式与主要动作。' }),
      h('dl', null,
        h('dt', { text: 'A 单栏' }, null),
        h('dd', { text: '以「读」为主：一条正文栏 + 右侧极简目录，题目就长在正文里。' }),
        h('dt', { text: 'B 工作台' }, null),
        h('dd', { text: '以「同时看全」为主：左树 + 中正文 + 右检查器，题目被抽出正文流，靠滚动同步。' }),
        h('dt', { text: 'C 专注' }, null),
        h('dd', { text: '以「一次只做一件事」为主：首页看板 → 全屏课件，按节推进，题目一次只出一道。' })),
      h('h4', { text: '底部这条不是设计' }),
      h('p', { text: '它是原型脚手架：← → 或键盘左右键切变体，变体写在 ?variant= 里；「锚点」下拉演的是锚点四态，「动效」演的是动效四档。合入真代码时整份删掉。' }),
      h('h4', { text: '数据是真的，作答是假的' }),
      h('p', { text: '正文、题库、进度、误解记录都来自 examples/ 的示例工作区，一个字没改；作答与问答回答是内存里的桩，刷新即丢，不会回写任何文件。' }));

    const bar = h('div.sm-proto-bar', { role: 'group', 'aria-label': '原型变体切换' },
      h('button.sm-proto-bar__arrow', { type: 'button', title: '上一个变体（←）', 'aria-label': '上一个变体', on: { click: () => step(-1) } }, icon('left', 16)),
      label,
      h('button.sm-proto-bar__arrow', { type: 'button', title: '下一个变体（→）', 'aria-label': '下一个变体', on: { click: () => step(1) } }, icon('right', 16)),
      dots,
      h('span.sm-proto-bar__sep'),
      anchorField,
      motionField,
      themeBtn,
      helpBtn);

    document.body.append(bar, help);
    paint(SM.app.variant);
    paintTheme();

    // ← → 只在没在输入的时候接管；在文本框里按左右键要能正常移光标
    const onKey = (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      event.preventDefault();
      step(event.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);

    return {
      paint,
      destroy() { window.removeEventListener('keydown', onKey); bar.remove(); help.remove(); },
    };
  }

  SM.switcher = { mount: mountSwitcher, ANCHOR_MODES };
})();
