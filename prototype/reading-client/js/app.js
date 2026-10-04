/* ─────────────────────────────────────────────────────────────────────────
   入口：读 ?variant=、等数据、挂变体、把「你看到哪」记进 sessionStorage。

   变体契约（三个变体各自实现，app 只管挂与卸）：
     { key, name, blurb, mount(root, ctx) -> { destroy() } | undefined }
   ctx 里给的是**状态**，不是版式：
     ctx.here       当前 {view, subject, node}，变体只读
     ctx.goto(patch) 改状态并重挂（变体自己的局部状态不要走这里）
     ctx.subject()  当前科目对象    ctx.node()  当前节点对象
     ctx.data       SM.data
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  const SM = (window.SM = window.SM || {});
  const { h } = SM;

  const variants = SM.variants;
  const params = new URLSearchParams(location.search);
  SM.proto.bare = params.get('bare') === '1';
  SM.theme.restore(); // data 还没到就先定主题，免得先闪一下深色再跳浅色

  const app = (SM.app = {
    here: { view: 'home', subject: '', node: '', scroll: 0 },
    variant: null,
    mounted: null,
    root: null,

    subject() { return SM.data.bySlug(this.here.subject); },
    node() { return SM.data.node(this.here.subject, this.here.node); },

    goto(patch) {
      Object.assign(this.here, patch);
      SM.session.write(this.here);
      this.render();
    },

    render() {
      const root = this.root;
      if (this.mounted && this.mounted.destroy) this.mounted.destroy();
      SM.clear(root);
      window.scrollTo(0, 0);
      const ctx = {
        data: SM.data,
        here: this.here,
        goto: (patch) => this.goto(patch),
        subject: () => this.subject(),
        node: () => this.node(),
      };
      this.mounted = this.variant.mount(root, ctx) || null;
      // 阅读位置恢复（目标态 §4.4）：section → offset → progress 三级降级在变体里，
      // 原型只演示最后那级——同一会话里切变体，滚动位置不丢。
      const target = this.here.scroll || 0;
      if (target > 0) requestAnimationFrame(() => window.scrollTo(0, target));
      document.title = `${this.variant.name} · 阅读端原型`;
    },

    switchTo(variant, { push = true } = {}) {
      this.here.scroll = window.scrollY;
      SM.session.write(this.here);
      this.variant = variant;
      if (push) {
        const url = new URL(location.href);
        url.searchParams.set('variant', variant.key);
        history.replaceState(null, '', url);
      }
      this.render();
      if (this.switcher) this.switcher.paint(variant);
      window.dispatchEvent(new CustomEvent('sm:variant', { detail: variant }));
    },
  });

  // 原型顶栏把锚点强行置成某个状态时重挂一次：四态的表现差异是版式的一部分，
  // 不值得为它再搭一套增量更新。重挂前先把滚动位置收好，免得看的人被弹回页首。
  window.addEventListener('sm:anchor-mode', () => {
    app.here.scroll = window.scrollY;
    app.render();
  });

  function pickVariant() {
    const wanted = (params.get('variant') || 'A').toUpperCase();
    return variants.find((v) => v.key === wanted) || variants[0];
  }

  function boot() {
    app.root = document.getElementById('app');
    const remembered = SM.session.read();
    // URL 上写了就以 URL 为准（?view= / ?subject= / ?node=）：这样一条链接能直接指向
    // 「B 变体的课件页」，截图脚本也才有确定的入口，不会捡到上一个场景留下的位置。
    const first = SM.data.subjects.some((s) => s.slug === (params.get('subject') || remembered.subject))
      ? (params.get('subject') || remembered.subject)
      : (SM.data.workspace.subjects[0] || {}).slug;
    Object.assign(app.here, {
      view: params.get('view') || remembered.view || 'home',
      subject: first,
      node: params.get('node') || remembered.node || '',
      scroll: 0, // 新会话不恢复滚动：换变体时才用得上
    });
    if (!app.here.node) {
      const subject = SM.data.bySlug(app.here.subject);
      app.here.node = subject.continue_node || (subject.nodes[0] || {}).id || '';
    }

    app.variant = pickVariant();
    app.render();

    app.switcher = SM.switcher.mount({
      variants,
      current: app.variant,
      onChange: (variant) => app.switchTo(variant),
    });
  }

  SM.data.ready.then(boot).catch(() => { /* data.js 已经把错误画在页面上了 */ });
})();
