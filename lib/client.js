// StudyMate 阅读端 —— DSH 客户端插件（Client 半）。
//
// 注册契约（已在本机安装的 0.2.0-rc.2 上核对）：
//   · 入口由 package.json 的 exports["./client"] 指到这里，宿主用 /plugins 路由把它发给浏览器；
//   · 本文件只做两件事：window.__ModuleLoader__.load() 登记工厂，工厂返回 { inject, apply }；
//   · 工厂体在**物化时**才执行（不是脚本执行时），所以样式注入这类副作用放在工厂里是安全的；
//   · 模块表只有 9 个键：react / react/jsx-runtime / react-dom / react-dom/client /
//     @deepseek-ai/cordis / dsh-client-store / dsh-client-ui-slots /
//     dsh-client-ui-primitives / dsh-client-ui-dockkit。这里只用 react —— 按插件规范，
//     不 require 任何 Harness 客户端包（它们会随版本变，且插件是手写 JS、没有类型检查）。
//
// 占的座位：
//   · main（keyed/root，整块中央面板）—— 阅读端本体；
//   · sidebar.panellist —— 左栏那一行入口，点它 ctx.layout.selectPanel('studymate')。
//
// 数据来自 Host 半的 GET /api/studymate/library（见 lib/library.mjs 与 bin/dsh-plugin.mjs）。
// 前端不写任何学习内容；作答只存在内存里（目标态规格 §4.3：作答要经 Host 半落盘，
// 那是下一步的事，这里不假装已经做了）。
// 问答面板（#79）是唯一一条「前端发起、Host 半调模型」的路：POST /api/studymate/ask
// （实现在 lib/ask/**）。回答**不进会话记录**、不落任何文件；它只让 Host 半追加一条误解记录。
window.__ModuleLoader__.load({
  id: '@yunmiao/studymate',
  factory(require) {
    const React = require('react');

    /**
     * hyperscript：`h('div.card', props, ...kids)`。
     *
     * 不能直接用 React.createElement —— 它会把 `'div.card'` 整个当成标签名，
     * 造出一个叫 <div.card> 的未知元素：**没有 class，CSS 一条都不生效，但 DOM 里看着还在**，
     * 排查起来极其费劲（踩过：整页 classless，选择器全落空而页面「看起来有内容」）。
     * 这里把 `tag.class1.class2` 拆开：前面的当标签，后面的并进 className。
     * 组件（函数）原样透传。
     */
    function h(sel, props, ...kids) {
      // 只管字符串选择器：函数组件与 React.Fragment（那是个 symbol）原样交给 createElement，
      // 别拿 String() 去套——套了就会造出一个叫 "Symbol(react.fragment)" 的假标签。
      if (typeof sel !== 'string') return React.createElement(sel, props, ...kids);
      const parts = String(sel).split('.');
      const tag = parts[0] || 'div';
      const classes = parts.slice(1);
      if (!classes.length) return React.createElement(tag, props, ...kids);
      const merged = Object.assign({}, props);
      merged.className = [classes.join(' '), props && props.className].filter(Boolean).join(' ');
      return React.createElement(tag, merged, ...kids);
    }
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    const LIBRARY_ENDPOINT = '/api/studymate/library';
    const ASSET_ENDPOINT = '/api/studymate/asset';
    const REFERENCE_ENDPOINT = '/api/studymate/reference';
    // 问答面板那条路由（#79）：面板独立调模型，不经过总控。实现在 lib/ask/**。
    const ASK_ENDPOINT = '/api/studymate/ask';

    /* ═══════════════════════════════════════════════════════════════════════
       样式：整份作为字符串注入一个 <style>。
       色值一律走 --dsw-alias-* 主题 token（宿主主题插件定义在 body 上，亮暗自动切），
       只在少数几个「没有它就会透明到看不清」的地方留了兜底值——token 改名时外观退化，
       但不会把版面打散。
       ═══════════════════════════════════════════════════════════════════════ */

    const CSS = `
.smb-root {
  --smb-line: var(--dsw-alias-border-l1, #e6e8ee);
  --smb-line-strong: var(--dsw-alias-border-l2, #d5d9e2);
  --smb-text: var(--dsw-alias-label-primary, #1b1f27);
  --smb-text-2: var(--dsw-alias-label-secondary, #4d5666);
  --smb-text-3: var(--dsw-alias-label-tertiary, #6b7484);
  --smb-text-4: var(--dsw-alias-label-caption, #7e8798);
  --smb-bg: var(--dsw-alias-bg-base, #f6f7f9);
  --smb-panel: var(--dsw-alias-bg-layer-1, #fff);
  --smb-raise: var(--dsw-alias-bg-layer-2, #f4f5f8);
  --smb-hover: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04));
  --smb-brand: var(--dsw-alias-brand-primary, #2f6fdc);
  --smb-done: var(--dsw-alias-state-success-primary, #1a7f43);
  --smb-learning: var(--dsw-alias-state-warn-primary, #9a6700);
  --smb-todo: var(--dsw-alias-state-idle-primary, #79808f);
  --smb-error: var(--dsw-alias-state-error-primary, #c3352b);
  --smb-info: var(--dsw-alias-state-business-primary, #4a58d6);
  --smb-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --smb-motion: 140ms;

  /* 三级钻取：顶栏 + 唯一的滚动区。每一级是一屏（规格 §4.1），
     所以这里不并排、不分区，滚动交给里面的 .smb-scroll。 */
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--smb-bg);
  color: var(--smb-text);
  font-size: 13px;
  line-height: 1.65;
  text-align: left;
}
.smb-root *, .smb-root *::before, .smb-root *::after { box-sizing: border-box; }
.smb-root ::-webkit-scrollbar { width: 10px; height: 10px; }
.smb-root ::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l1, rgba(0,0,0,.2));
  border-radius: 99px; border: 2px solid transparent; background-clip: content-box;
}
.smb-root :focus-visible { outline: 2px solid var(--smb-brand); outline-offset: 2px; border-radius: 6px; }

/* ── 左栏 ───────────────────────────────────────────────────────────────── */
.smb-left {
  display: flex; flex-direction: column; min-width: 0; min-height: 0;
  border-right: 1px solid var(--smb-line);
  background: var(--smb-panel);
}
.smb-left__head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--smb-line); }
.smb-brand { display: flex; align-items: center; gap: 8px; font-weight: 600; letter-spacing: -.01em; }
.smb-brand__mark {
  display: grid; place-items: center; width: 22px; height: 22px; border-radius: 7px;
  background: var(--smb-brand); color: var(--dsw-alias-label-primary-inverted, #fff);
  font-size: 12px; font-weight: 700;
}
.smb-spacer { flex: 1; }
.smb-searchbtn {
  display: flex; align-items: center; gap: 6px; padding: 4px 9px;
  border: 1px solid var(--smb-line-strong); border-radius: 99px;
  background: transparent; color: var(--smb-text-3); font: inherit; font-size: 12px; cursor: pointer;
}
.smb-searchbtn:hover { background: var(--smb-hover); color: var(--smb-text); }
.smb-kbd {
  font-family: var(--smb-mono); font-size: 10px; padding: 0 4px; border-radius: 4px;
  border: 1px solid var(--smb-line-strong); border-bottom-width: 2px; color: var(--smb-text-4);
}

.smb-left__body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 8px 24px; }
.smb-left__title {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 6px; font-size: 11px; letter-spacing: .06em;
  color: var(--smb-text-4); text-transform: uppercase;
}
.smb-left__title b { font-weight: 600; }
/* 标题默认大写（.smb-left__title 的 letter-spacing 配小字号）；文件名不能跟着变大写 */
.smb-left__title--plain { text-transform: none; }

.smb-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 6px 8px; }
.smb-tab {
  padding: 3px 9px; border: 1px solid transparent; border-radius: 99px;
  background: transparent; color: var(--smb-text-2); font: inherit; font-size: 12px; cursor: pointer;
}
.smb-tab:hover { background: var(--smb-hover); color: var(--smb-text); }
.smb-tab[aria-selected="true"] { background: var(--smb-raise); border-color: var(--smb-line-strong); color: var(--smb-text); font-weight: 550; }

.smb-level { margin: 6px 0 2px; }
.smb-level__label { padding: 2px 6px; font-size: 11px; color: var(--smb-text-4); }
.smb-node {
  display: flex; align-items: center; gap: 7px; width: 100%;
  padding: 5px 8px; margin-bottom: 1px;
  border: 1px solid transparent; border-radius: 7px;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.smb-node:hover { background: var(--smb-hover); }
.smb-node[aria-current="true"] { background: var(--smb-raise); border-color: var(--smb-line-strong); }
.smb-node__no { font-family: var(--smb-mono); font-size: 11px; color: var(--smb-text-4); flex: none; }
.smb-node__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smb-node__none { font-size: 11px; color: var(--smb-text-4); flex: none; }
.smb-node[aria-current="true"] .smb-node__title { font-weight: 600; }

.smb-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--smb-todo); }
.smb-dot--学习中 { background: var(--smb-learning); }
.smb-dot--已学完 { background: var(--smb-done); }

.smb-fold { border-top: 1px solid var(--smb-line); margin-top: 10px; padding-top: 6px; }
.smb-fold__head {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 5px 6px; border: 0; border-radius: 6px;
  background: transparent; color: var(--smb-text-2); font: inherit; font-size: 12px; cursor: pointer;
}
.smb-fold__head:hover { background: var(--smb-hover); }
.smb-fold__count { margin-left: auto; color: var(--smb-text-4); font-size: 11px; }
.smb-fold__body { padding: 2px 8px 8px; }
.smb-term { padding: 5px 0; border-bottom: 1px solid var(--smb-line); }
.smb-term:last-child { border-bottom: 0; }
.smb-term b { font-weight: 600; }
.smb-term p { margin: 2px 0 0; color: var(--smb-text-2); font-size: 12px; }
.smb-term i { display: block; margin-top: 2px; color: var(--smb-text-4); font-size: 11px; font-style: normal; }
.smb-rec { display: flex; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--smb-line); font-size: 12px; }
.smb-rec:last-child { border-bottom: 0; }
.smb-rec time { flex: none; width: 62px; font-family: var(--smb-mono); font-size: 11px; color: var(--smb-text-4); }
.smb-mis { padding: 6px 0; border-bottom: 1px solid var(--smb-line); font-size: 12px; }
.smb-mis:last-child { border-bottom: 0; }
.smb-mis b { display: flex; align-items: center; gap: 6px; font-weight: 550; }
.smb-mis p { margin: 2px 0 0; color: var(--smb-text-2); }
.smb-mis em { color: var(--smb-text-4); font-style: normal; }
.smb-left__foot {
  padding: 8px 12px; border-top: 1px solid var(--smb-line);
  color: var(--smb-text-4); font-size: 11px;
}

/* ── 中栏 ───────────────────────────────────────────────────────────────── */
.smb-center { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.smb-center__head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 9px 16px; border-bottom: 1px solid var(--smb-line); background: var(--smb-panel);
}
.smb-crumb { display: flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--smb-text-3); font: inherit; font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 6px; }
.smb-crumb:hover { background: var(--smb-hover); color: var(--smb-text); }
.smb-center__name { font-weight: 600; }
.smb-center__no { font-family: var(--smb-mono); font-size: 11px; color: var(--smb-text-4); }
.smb-secs { display: flex; gap: 2px; flex-wrap: wrap; width: 100%; margin-top: 2px; }
.smb-sec {
  padding: 2px 8px; border: 0; border-radius: 6px; background: transparent;
  color: var(--smb-text-3); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.smb-sec:hover { background: var(--smb-hover); color: var(--smb-text); }
.smb-sec[aria-current="true"] { background: var(--smb-raise); color: var(--smb-text); font-weight: 550; }
.smb-center__body { flex: 1; min-height: 0; overflow-y: auto; scroll-behavior: smooth; }

.smb-doc { max-width: 760px; margin: 0 auto; padding: 20px 24px 120px; }
.smb-doc h1 { margin: 0 0 8px; font-size: 25px; letter-spacing: -.02em; line-height: 1.25; }
.smb-goal {
  margin: 0 0 22px; padding: 10px 14px; border-radius: 8px;
  border-left: 3px solid var(--smb-brand); background: var(--smb-raise);
  color: var(--smb-text-2); font-size: 13px;
}
.smb-sec-block { scroll-margin-top: 60px; }
.smb-doc h2 { margin: 30px 0 10px; font-size: 17px; letter-spacing: -.01em; line-height: 1.35; }
.smb-doc h3 { margin: 22px 0 8px; font-size: 15px; }
.smb-doc p { margin: 12px 0; }
.smb-doc ul, .smb-doc ol { margin: 12px 0; padding-left: 1.4em; }
.smb-doc li { margin: 3px 0; }
.smb-doc a { color: var(--dsw-alias-link, var(--smb-brand)); text-underline-offset: 3px; }
.smb-doc strong { font-weight: 650; }
.smb-doc code {
  font-family: var(--smb-mono); font-size: .88em; padding: .12em .38em; border-radius: 5px;
  background: var(--dsw-alias-markdown-inline-code, rgba(0,0,0,.06));
}
.smb-math { font-family: "Latin Modern Math", "Cambria Math", var(--smb-mono); font-style: italic; }
.smb-math-block {
  margin: 14px 0; padding: 12px; border-radius: 8px; text-align: center;
  background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,.02));
  font-family: "Latin Modern Math", "Cambria Math", var(--smb-mono); overflow-x: auto;
}
.smb-code { margin: 14px 0; border: 1px solid var(--smb-line); border-radius: 10px; overflow: hidden; background: var(--smb-raise); }
.smb-code__bar {
  display: flex; gap: 8px; padding: 5px 12px; border-bottom: 1px solid var(--smb-line);
  font-family: var(--smb-mono); font-size: 11px; color: var(--smb-text-4);
}
.smb-code pre { margin: 0; padding: 10px 14px; overflow-x: auto; font-family: var(--smb-mono); font-size: 12px; line-height: 1.6; }
.smb-code--term { background: var(--smb-bg); }
.smb-table-wrap { margin: 14px 0; overflow-x: auto; border: 1px solid var(--smb-line); border-radius: 10px; }
.smb-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.smb-table th, .smb-table td { padding: 7px 11px; text-align: left; border-bottom: 1px solid var(--smb-line); vertical-align: top; }
.smb-table th { background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,.02)); color: var(--smb-text-2); font-weight: 550; white-space: nowrap; }
.smb-table tr:last-child td { border-bottom: 0; }
.smb-figure { margin: 18px 0; }
.smb-figure__frame { padding: 14px; border: 1px solid var(--smb-line); border-radius: 10px; background: var(--smb-panel); color: var(--smb-text-2); }
.smb-figure svg { display: block; width: 100%; height: auto; }
.smb-figure figcaption { margin-top: 6px; text-align: center; font-size: 11.5px; color: var(--smb-text-4); }
.smb-note {
  display: flex; gap: 10px; margin: 14px 0; padding: 10px 14px; border-radius: 10px;
  border: 1px solid var(--smb-line); background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,.02)); font-size: 12.5px;
}
.smb-note--warn { border-color: color-mix(in srgb, var(--smb-learning) 40%, transparent); background: color-mix(in srgb, var(--smb-learning) 10%, transparent); }
.smb-note--brand { border-color: color-mix(in srgb, var(--smb-brand) 35%, transparent); }
.smb-note b { display: block; }
.smb-practice { margin: 18px 0; border: 1px solid var(--smb-line-strong); border-left: 3px solid var(--smb-info); border-radius: 10px; background: var(--smb-panel); overflow: hidden; }
.smb-practice__head { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--smb-line); font-size: 12.5px; font-weight: 600; }
.smb-practice__head span { color: var(--smb-text-4); font-weight: 400; }
.smb-practice__body { padding: 12px 14px; font-size: 12.5px; }
.smb-practice__body > *:first-child { margin-top: 0; }

/* 正文里的锚点标记：题目本体在右栏，这里只留一个能点的记号 */
.smb-anchor {
  display: inline-flex; align-items: center; gap: 6px;
  margin: 14px 0; padding: 5px 11px;
  border: 1px dashed var(--smb-line-strong); border-radius: 99px;
  background: transparent; color: var(--smb-text-2); font: inherit; font-size: 12px; cursor: pointer;
}
.smb-anchor:hover { border-style: solid; background: var(--smb-hover); color: var(--smb-text); }
.smb-anchor[aria-current="true"] { border-style: solid; border-color: var(--smb-brand); color: var(--smb-text); }
.smb-anchor__n {
  display: grid; place-items: center; width: 16px; height: 16px; border-radius: 50%;
  background: var(--smb-brand); color: var(--dsw-alias-label-primary-inverted, #fff);
  font-size: 10px; font-weight: 700;
}
.smb-anchor--bad { border-color: color-mix(in srgb, var(--smb-learning) 55%, transparent); color: var(--smb-learning); }

.smb-navfoot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 36px; padding-top: 14px; border-top: 1px solid var(--smb-line); }

/* ── 路线图 ─────────────────────────────────────────────────────────────── */
.smb-map { position: relative; padding: 18px 22px 60px; }
.smb-map__legend { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; font-size: 12px; color: var(--smb-text-3); }
.smb-map__legend span { display: flex; align-items: center; gap: 5px; }
.smb-map__edges { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
.smb-map__cols { position: relative; display: flex; flex-direction: column; gap: 26px; }
.smb-map__level { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 12px; }
.smb-map__levelname { padding-top: 12px; font-size: 11px; color: var(--smb-text-4); }
.smb-map__cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.smb-card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 12px 14px; border: 1px solid var(--smb-line); border-radius: 12px;
  background: var(--smb-panel); color: inherit; font: inherit; text-align: left; cursor: pointer;
  transition: border-color var(--smb-motion), transform var(--smb-motion), box-shadow var(--smb-motion);
}
.smb-card:hover { border-color: var(--smb-line-strong); box-shadow: 0 6px 18px -10px rgba(0,0,0,.35); }
.smb-card--实验 { border-left: 3px solid var(--smb-info); }
.smb-card--实操 { border-left: 3px solid color-mix(in srgb, var(--smb-brand) 60%, transparent); }
.smb-card__top { display: flex; align-items: center; gap: 7px; }
.smb-card__top .smb-spacer { flex: 1; }
.smb-card__title { font-size: 13.5px; font-weight: 600; }
.smb-card__goal { color: var(--smb-text-2); font-size: 12px; }
.smb-card__foot { display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 6px; font-size: 11px; color: var(--smb-text-4); }

.smb-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px;
  border: 1px solid var(--smb-line-strong); border-radius: 99px;
  background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,.02));
  color: var(--smb-text-2); font-size: 11px; white-space: nowrap;
}
.smb-chip--已学完 { color: var(--smb-done); border-color: color-mix(in srgb, var(--smb-done) 40%, transparent); }
.smb-chip--学习中 { color: var(--smb-learning); border-color: color-mix(in srgb, var(--smb-learning) 40%, transparent); }
.smb-chip--未开始 { color: var(--smb-text-4); }
.smb-chip--kind { border-style: dashed; }
.smb-chip--warn { color: var(--smb-learning); border-color: color-mix(in srgb, var(--smb-learning) 45%, transparent); }
.smb-chip--info { color: var(--smb-info); border-color: color-mix(in srgb, var(--smb-info) 45%, transparent); }

/* ── 右栏检查器 ─────────────────────────────────────────────────────────── */
.smb-right { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid var(--smb-line); background: var(--smb-panel); }
.smb-right__tabs { display: flex; gap: 2px; padding: 8px 10px 0; border-bottom: 1px solid var(--smb-line); }
.smb-rtab {
  padding: 5px 11px; border: 0; border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0;
  background: transparent; color: var(--smb-text-3); font: inherit; font-size: 12.5px; cursor: pointer;
}
.smb-rtab:hover { background: var(--smb-hover); color: var(--smb-text); }
.smb-rtab[aria-selected="true"] { color: var(--smb-text); border-bottom-color: var(--smb-brand); font-weight: 600; }
.smb-right__body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; }

.smb-qhead { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 11px; color: var(--smb-text-4); }
.smb-anchoritem { border: 1px solid var(--smb-line); border-radius: 10px; margin-bottom: 8px; overflow: hidden; }
.smb-anchoritem[data-active="true"] { border-color: var(--smb-brand); }
.smb-anchoritem__head {
  display: flex; align-items: center; gap: 7px; width: 100%;
  padding: 8px 11px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.smb-anchoritem__head:hover { background: var(--smb-hover); }
.smb-anchoritem__n {
  display: grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; flex: none;
  background: var(--smb-raise); border: 1px solid var(--smb-line-strong);
  font-size: 10px; color: var(--smb-text-2);
}
.smb-anchoritem[data-active="true"] .smb-anchoritem__n { background: var(--smb-brand); border-color: var(--smb-brand); color: var(--dsw-alias-label-primary-inverted, #fff); }
.smb-anchoritem__text { flex: 1; min-width: 0; font-size: 12.5px; }
.smb-anchoritem__body { padding: 0 11px 11px; }

.smb-q { padding: 10px 0; border-top: 1px solid var(--smb-line); }
.smb-q:first-child { border-top: 0; }
.smb-q__ask { display: flex; gap: 8px; margin-bottom: 8px; }
.smb-q__no { flex: none; font-family: var(--smb-mono); font-size: 11px; color: var(--smb-text-4); padding-top: 2px; }
.smb-q__text p { margin: 0 0 2px; white-space: pre-line; }
.smb-q__opts { display: grid; gap: 5px; }
.smb-opt {
  display: flex; gap: 8px; width: 100%; padding: 7px 10px;
  border: 1px solid var(--smb-line); border-radius: 8px; background: var(--smb-raise);
  color: inherit; font: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
  transition: border-color var(--smb-motion), background var(--smb-motion);
}
.smb-opt:hover { border-color: var(--smb-line-strong); }
.smb-opt__l { flex: none; font-family: var(--smb-mono); font-size: 11px; color: var(--smb-text-4); padding-top: 2px; }
.smb-opt[data-state="right"] { border-color: var(--smb-done); background: color-mix(in srgb, var(--smb-done) 12%, transparent); }
.smb-opt[data-state="wrong"] { border-color: var(--smb-error); background: color-mix(in srgb, var(--smb-error) 12%, transparent); }
.smb-opt[data-state="answer"] { border-color: color-mix(in srgb, var(--smb-done) 55%, transparent); }
.smb-why { margin-top: 8px; padding: 8px 11px; border-radius: 8px; font-size: 12px; background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,.02)); border: 1px solid var(--smb-line); }
.smb-why[data-right="false"] { border-color: color-mix(in srgb, var(--smb-error) 45%, transparent); }
.smb-why b { display: block; }
.smb-why p { margin: 3px 0 0; white-space: pre-line; color: var(--smb-text-2); }
.smb-why .smb-meta { margin-top: 4px; color: var(--smb-text-4); font-size: 11px; }
.smb-review { margin-left: 6px; color: var(--smb-learning); font-size: 11px; }
.smb-ta {
  width: 100%; padding: 8px 10px; border: 1px solid var(--smb-line-strong); border-radius: 8px;
  background: var(--smb-raise); color: var(--smb-text); font: inherit; font-size: 12.5px; resize: vertical;
}
.smb-btn {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px;
  border: 1px solid var(--smb-line-strong); border-radius: 7px; background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,.02));
  color: var(--smb-text); font: inherit; font-size: 12px; cursor: pointer;
}
.smb-btn:hover { background: var(--smb-hover); }
.smb-btn[disabled] { opacity: .5; cursor: not-allowed; }
.smb-btn--primary { background: var(--smb-brand); border-color: transparent; color: var(--dsw-alias-label-primary-inverted, #fff); font-weight: 550; }
.smb-btnrow { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.smb-ref { margin-top: 8px; padding: 9px 11px; border-radius: 8px; background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,.02)); font-size: 12px; }
.smb-ref h4 { margin: 0 0 4px; font-size: 11px; color: var(--smb-text-4); letter-spacing: .04em; }
.smb-ref p { margin: 0 0 4px; white-space: pre-line; color: var(--smb-text-2); }
.smb-meta { color: var(--smb-text-4); font-size: 11px; }
.smb-empty { padding: 26px 12px; text-align: center; color: var(--smb-text-4); font-size: 12.5px; }
.smb-notes h4 { margin: 12px 0 4px; font-size: 11px; color: var(--smb-text-4); letter-spacing: .04em; }
.smb-notes h4:first-child { margin-top: 0; }
.smb-notes ul { margin: 0; padding-left: 1.2em; color: var(--smb-text-2); }
.smb-notes p { margin: 0 0 6px; color: var(--smb-text-2); }
.smb-quote { margin: 0 0 8px; padding: 7px 10px; border-left: 2px solid var(--smb-brand); background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,.02)); color: var(--smb-text-2); font-size: 12px; max-height: 90px; overflow-y: auto; }
.smb-input {
  width: 100%; padding: 7px 10px; border: 1px solid var(--smb-line-strong); border-radius: 8px;
  background: var(--smb-raise); color: var(--smb-text); font: inherit; font-size: 12.5px;
}

/* ── 搜索面板 ───────────────────────────────────────────────────────────── */
.smb-palette { position: fixed; inset: 0; z-index: 60; display: flex; justify-content: center; padding-top: 12vh; background: color-mix(in srgb, var(--smb-bg) 55%, transparent); backdrop-filter: blur(3px); }
.smb-palette__box {
  width: min(680px, 92vw); max-height: 70vh; display: flex; flex-direction: column;
  border: 1px solid var(--smb-line-strong); border-radius: 14px; overflow: hidden;
  background: var(--smb-panel); box-shadow: 0 24px 60px -20px rgba(0,0,0,.5);
}
.smb-palette__input { display: flex; align-items: center; gap: 9px; padding: 12px 14px; border-bottom: 1px solid var(--smb-line); }
.smb-palette__input input { flex: 1; border: 0; background: transparent; color: var(--smb-text); font: inherit; font-size: 14px; outline: none; }
.smb-palette__list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; }
.smb-hit { display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 7px 10px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.smb-hit:hover { background: var(--smb-hover); }
.smb-hit__kind { flex: none; width: 66px; color: var(--smb-text-4); font-size: 11px; }
.smb-hit__text { flex: 1; min-width: 0; font-size: 12.5px; }
.smb-hit__where { flex: none; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--smb-text-4); font-size: 11px; }

@media (max-width: 900px) {
  .smb-wrap { padding: 16px 14px 90px; }
  .smb-tiles { grid-template-columns: minmax(0, 1fr); }
  .smb-topbar { flex-wrap: wrap; }
  .smb-crumb { max-width: 14ch; }
  .smb-continue__bar { flex-wrap: wrap; }
  .smb-continue__bar .smb-progressbar { width: 100%; }
}

/* ═══ 壳：主页与科目主页单栏，课件阅读页三栏 ═══════════════════════════════
   目标态规格 §4.1。前两级是「一条竖列 + 唯一的滚动区」；第三级才并排，且左右
   两栏**默认收起**——收起时各留一条 38px 窄轨，点一下滑出来，读正文时不多占
   一个像素。收起用「不渲染」而不是「宽度 0」：省得隐藏内容还在 DOM 里被读屏念。 */

.smb-scroll { flex: 1; min-height: 0; overflow-y: auto; }
.smb-wrap { max-width: 960px; margin: 0 auto; padding: 22px 26px 90px; }
.smb-wrap--doc { max-width: 820px; }

.smb-lesson { display: flex; flex: 1; min-height: 0; min-width: 0; position: relative; }

.smb-railbar {
  flex: none; width: 38px; display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 10px 0; border-right: 1px solid var(--smb-line); background: var(--smb-panel);
}
.smb-railbar--right { border-right: 0; border-left: 1px solid var(--smb-line); }
.smb-rail {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  width: 26px; padding: 8px 0; border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--smb-text-3); font: inherit; font-size: 11.5px; cursor: pointer;
}
.smb-rail:hover { background: var(--smb-hover); color: var(--smb-text); }
.smb-rail[aria-expanded="true"] { background: var(--smb-raise); border-color: var(--smb-line-strong); color: var(--smb-text); }
.smb-rail__ico { font-size: 13px; line-height: 1; }
.smb-rail__label { writing-mode: vertical-rl; letter-spacing: .18em; }
.smb-rail__count {
  display: grid; place-items: center; min-width: 16px; height: 16px; padding: 0 3px;
  border-radius: 99px; background: var(--dsw-alias-fill-l2, rgba(0,0,0,.08));
  font-size: 10px; color: var(--smb-text-3);
}

/* 栏宽拖拽把手：一条 7px 的透明热区，里面一根 1px 的线（规格 §4.4） */
.smb-panehandle { position: absolute; top: 0; bottom: 0; width: 7px; z-index: 9; cursor: col-resize; }
.smb-panehandle > i {
  position: absolute; top: 0; bottom: 0; left: 3px; width: 1px;
  background: var(--smb-line); transition: background var(--smb-motion);
}
.smb-panehandle:hover > i, .smb-panehandle:focus-visible > i, .smb-panehandle[data-dragging="1"] > i {
  left: 2px; width: 3px; background: var(--smb-brand); border-radius: 2px;
}
.smb-panehandle:focus-visible { outline: none; }

@keyframes smb-slide-left { from { transform: translateX(-14px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes smb-slide-right { from { transform: translateX(14px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes smb-fade { from { opacity: 0; } to { opacity: 1; } }

/* 宽度由组件按画布算好写进内联样式；这里只管弹性与入场动效 */
.smb-lesson > .smb-left { flex: none; min-width: 0; animation: smb-slide-left var(--smb-motion) ease-out; }
.smb-lesson > .smb-right { flex: none; min-width: 0; animation: smb-slide-right var(--smb-motion) ease-out; }
.smb-lesson > .smb-center { flex: 1; min-width: 0; animation: smb-fade var(--smb-motion) ease-out; }

/* ── 中间栏：正文 ───────────────────────────────────────────────────────── */

.smb-center__body { scroll-behavior: smooth; }
.smb-secsbar {
  position: sticky; top: 0; z-index: 4;
  padding: 8px 16px; border-bottom: 1px solid var(--smb-line); background: var(--smb-panel);
}

.smb-topbar {
  display: flex; align-items: center; gap: 10px; flex: none;
  padding: 9px 16px; border-bottom: 1px solid var(--smb-line);
  background: var(--smb-panel);
}
.smb-brand { display: flex; align-items: center; gap: 8px; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; padding: 2px 4px; border-radius: 8px; }
.smb-brand:hover { background: var(--smb-hover); }
.smb-brand__name { font-weight: 600; letter-spacing: -.01em; }
.smb-crumbs { display: flex; align-items: center; gap: 4px; min-width: 0; }
.smb-crumbs__sep { color: var(--smb-text-4); }
.smb-crumb {
  border: 0; background: transparent; color: var(--smb-text-3); font: inherit; font-size: 12.5px;
  padding: 3px 7px; border-radius: 7px; cursor: pointer; max-width: 22ch;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.smb-crumb:hover { background: var(--smb-hover); color: var(--smb-text); }
.smb-crumb[aria-current="page"] { color: var(--smb-text); font-weight: 600; }
.smb-crumb--current { color: var(--smb-text-2); cursor: default; }

/* ── 通用块与卡片 ───────────────────────────────────────────────────────── */

.smb-block { margin: 0 0 30px; }
.smb-block__title { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 15px; letter-spacing: -.01em; }
.smb-block__hint { margin: -4px 0 10px; color: var(--smb-text-4); font-size: 12px; line-height: 1.7; }

.smb-hero { margin: 4px 0 26px; }
.smb-hero__eyebrow { margin: 0 0 4px; font-size: 11.5px; letter-spacing: .05em; color: var(--smb-text-4); }
.smb-hero__title { margin: 0; font-size: 26px; letter-spacing: -.02em; line-height: 1.2; }
.smb-hero__sub { margin: 6px 0 0; max-width: 62ch; color: var(--smb-text-3); font-size: 13px; }

.smb-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.smb-tile {
  display: flex; flex-direction: column; gap: 8px;
  padding: 14px 16px; border: 1px solid var(--smb-line); border-radius: 12px;
  background: var(--smb-panel); color: inherit; font: inherit; text-align: left;
}
button.smb-tile { cursor: pointer; transition: border-color var(--smb-motion); }
button.smb-tile:hover { border-color: var(--smb-line-strong); }
.smb-tile__label { font-size: 11.5px; letter-spacing: .04em; color: var(--smb-text-4); }
.smb-tile__foot { margin-top: auto; padding-top: 6px; font-size: 11.5px; color: var(--smb-text-4); }

.smb-progressbar { height: 5px; border-radius: 99px; background: var(--dsw-alias-fill-l2, rgba(0,0,0,.08)); overflow: hidden; }
.smb-progressbar > i { display: block; height: 100%; border-radius: inherit; background: var(--smb-brand); transition: width var(--smb-motion); }
.smb-prose { font-size: 12.5px; }
.smb-vh {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}
.smb-btn--ghost { background: transparent; border-color: transparent; color: var(--smb-text-3); }
.smb-btn--ghost:hover { background: var(--smb-hover); color: var(--smb-text); }

/* ── 第一级：主页工作台 ─────────────────────────────────────────────────── */

.smb-continue {
  display: flex; flex-direction: column; gap: 6px;
  padding: 14px 16px; border: 1px solid var(--smb-line); border-radius: 12px;
  background: var(--smb-panel); color: inherit; font: inherit; text-align: left; cursor: pointer;
  transition: border-color var(--smb-motion), box-shadow var(--smb-motion);
}
.smb-continue:hover { border-color: var(--smb-line-strong); box-shadow: 0 6px 18px -12px rgba(0,0,0,.4); }
.smb-continue__top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.smb-continue__subject { font-size: 11.5px; color: var(--smb-text-4); letter-spacing: .04em; }
.smb-continue__title { display: flex; align-items: baseline; gap: 8px; font-size: 15px; font-weight: 600; }
.smb-continue__goal { color: var(--smb-text-2); font-size: 12.5px; }
.smb-continue__note { color: var(--smb-text-4); font-size: 11.5px; padding-left: 8px; border-left: 2px solid var(--smb-line-strong); }
.smb-continue__go { margin-top: auto; padding-top: 6px; font-size: 11.5px; color: var(--smb-brand); }
/* 主卡：只有一张，占满一行，比科目行更厚一点 */
.smb-continue--hero { width: 100%; gap: 8px; padding: 16px 18px; }
.smb-continue--hero .smb-continue__title { font-size: 18px; }
.smb-continue__bar { display: flex; align-items: center; gap: 10px; margin-top: 6px; padding-top: 10px; border-top: 1px solid var(--smb-line); }
.smb-continue__bar .smb-progressbar { width: 180px; flex: none; }

.smb-streak { gap: 10px; }
.smb-streak__num { display: flex; align-items: baseline; gap: 6px; }
.smb-streak__num b { font-size: 30px; line-height: 1; letter-spacing: -.03em; }
.smb-streak__num span { color: var(--smb-text-3); font-size: 12.5px; }
.smb-streak__week { display: flex; gap: 5px; }
.smb-streak__week i {
  flex: 1; display: grid; place-items: center;
  height: 30px; border-radius: 7px; font-style: normal; font-size: 10.5px;
  border: 1px solid var(--smb-line); color: var(--smb-text-4);
  background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,.02));
}
.smb-streak__week i[data-hit="1"] { background: color-mix(in srgb, var(--smb-done) 30%, transparent); border-color: color-mix(in srgb, var(--smb-done) 45%, transparent); color: var(--smb-text); }

.smb-courses { display: flex; flex-direction: column; gap: 8px; }
.smb-courses--folded { margin-top: 8px; }
.smb-course {
  display: flex; align-items: center; gap: 14px; width: 100%;
  padding: 12px 16px; border: 1px solid var(--smb-line); border-radius: 12px;
  background: var(--smb-panel); color: inherit; font: inherit; text-align: left; cursor: pointer;
  transition: border-color var(--smb-motion);
}
.smb-course:hover { border-color: var(--smb-line-strong); }
.smb-course__main { flex: 1; min-width: 0; }
.smb-course__name { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.smb-course__goal { color: var(--smb-text-4); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smb-course__side { display: flex; align-items: center; gap: 14px; flex: none; }
.smb-course__bar { display: flex; align-items: center; gap: 8px; width: 190px; }
.smb-course__bar .smb-progressbar { flex: 1; }
.smb-course__stats { display: flex; gap: 10px; font-size: 11.5px; color: var(--smb-text-3); }
.smb-course__stats span { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
.smb-course__go { color: var(--smb-text-4); }
.smb-donefold { margin-top: 12px; border-top: 1px solid var(--smb-line); padding-top: 4px; }
.smb-donefold .smb-fold__head { color: var(--smb-text-3); }

@media (max-width: 900px) {
  .smb-course { flex-wrap: wrap; }
  .smb-course__side { width: 100%; justify-content: space-between; }
  .smb-course__bar { width: auto; flex: 1; }
}

/* ── 第二级：科目主页 ───────────────────────────────────────────────────── */

.smb-subhead { margin: 4px 0 22px; }
.smb-subhead__title { display: inline-block; margin: 8px 8px 6px 0; font-size: 24px; letter-spacing: -.02em; }
.smb-subhead__goal { margin: 4px 0 14px; max-width: 68ch; color: var(--smb-text-2); font-size: 13px; line-height: 1.75; }
.smb-subhead__stats { display: flex; flex-direction: column; gap: 8px; max-width: 520px; }
.smb-subhead__counts { display: flex; flex-wrap: wrap; gap: 8px; }

.smb-heat { margin-bottom: 30px; }
.smb-heat__body { display: flex; flex-direction: column; gap: 8px; overflow-x: auto; }
.smb-heat__grid { display: flex; gap: 3px; }
.smb-heat__col { display: flex; flex-direction: column; gap: 3px; }
.smb-heat__col i {
  width: 11px; height: 11px; border-radius: 3px;
  background: var(--dsw-alias-fill-l2, rgba(0,0,0,.06));
  outline: 1px solid color-mix(in srgb, var(--smb-line) 60%, transparent); outline-offset: -1px;
}
.smb-heat__col i[data-future="1"] { opacity: .25; }
.smb-heat__col i[data-level="1"] { background: color-mix(in srgb, var(--smb-done) 28%, transparent); }
.smb-heat__col i[data-level="2"] { background: color-mix(in srgb, var(--smb-done) 48%, transparent); }
.smb-heat__col i[data-level="3"] { background: color-mix(in srgb, var(--smb-done) 70%, transparent); }
.smb-heat__col i[data-level="4"] { background: var(--smb-done); }
.smb-heat__legend { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--smb-text-4); }
.smb-heat__legend i { width: 11px; height: 11px; border-radius: 3px; background: var(--dsw-alias-fill-l2, rgba(0,0,0,.06)); }
.smb-heat__legend i[data-level="1"] { background: color-mix(in srgb, var(--smb-done) 28%, transparent); }
.smb-heat__legend i[data-level="2"] { background: color-mix(in srgb, var(--smb-done) 48%, transparent); }
.smb-heat__legend i[data-level="3"] { background: color-mix(in srgb, var(--smb-done) 70%, transparent); }
.smb-heat__legend i[data-level="4"] { background: var(--smb-done); }

.smb-reflist { margin: 10px 0 0; padding: 0; list-style: none; }
.smb-refitem {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 2px; border-bottom: 1px solid var(--smb-line); font-size: 12.5px;
}
.smb-refitem:last-child { border-bottom: 0; }
.smb-refitem__open { border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; padding: 2px 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smb-refitem__open:not([disabled]):hover { color: var(--smb-brand); text-decoration: underline; text-underline-offset: 3px; }
.smb-refitem__open[disabled] { cursor: default; color: var(--smb-text-2); }

.smb-addform { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; padding: 14px; border: 1px solid var(--smb-line-strong); border-radius: 12px; background: var(--smb-raise); }
.smb-reader { margin-top: 12px; border: 1px solid var(--smb-line); border-radius: 12px; overflow: hidden; }
.smb-reader__head { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-bottom: 1px solid var(--smb-line); background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,.02)); font-size: 12.5px; }
.smb-reader__body { margin: 0; padding: 14px; max-height: 46vh; overflow: auto; font-family: var(--smb-mono); font-size: 12px; line-height: 1.7; white-space: pre-wrap; }

/* ── 第三级：课件阅读页 ─────────────────────────────────────────────────── */

.smb-doc__head { margin: 10px 0 16px; }
.smb-doc__head h1 { margin: 2px 0 8px; font-size: 25px; letter-spacing: -.02em; line-height: 1.25; }
.smb-doc__chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }

.smb-quiz__pair { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.smb-quiz__pair code { font-family: var(--smb-mono); font-size: 11.5px; background: var(--dsw-alias-markdown-inline-code, rgba(0,0,0,.06)); padding: 2px 6px; border-radius: 4px; }
.smb-quiz__keys { margin: 6px 0 0; padding-left: 1.2em; font-size: 11.5px; }
.smb-quiz__keys code { font-family: var(--smb-mono); background: var(--dsw-alias-markdown-inline-code, rgba(0,0,0,.06)); padding: 1px 5px; border-radius: 4px; }
.smb-labfiles { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.smb-labfiles code { font-family: var(--smb-mono); font-size: 11.5px; background: var(--dsw-alias-markdown-inline-code, rgba(0,0,0,.06)); padding: 2px 7px; border-radius: 4px; }

/* ── 正文里的题目标记（题面与判分都在右栏，规格 §7.2）───────────────────── */

.smb-qmark {
  display: flex; align-items: center; gap: 10px; width: 100%;
  margin: 18px 0; padding: 10px 14px;
  border: 1px solid var(--smb-line-strong); border-left: 3px solid var(--smb-brand);
  border-radius: 10px; background: var(--smb-panel); color: inherit; font: inherit;
  text-align: left; cursor: pointer; transition: border-color var(--smb-motion), background var(--smb-motion);
}
.smb-qmark:hover { border-color: var(--smb-brand); background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,.02)); }
.smb-qmark[data-state="missing"], .smb-qmark[data-state="ambiguous"], .smb-qmark[data-state="stale"] {
  border-left-color: var(--smb-learning);
}
.smb-qmark__badge {
  flex: none; padding: 1px 8px; border-radius: 99px; font-size: 11px;
  border: 1px solid color-mix(in srgb, var(--smb-brand) 40%, transparent); color: var(--smb-brand);
}
.smb-qmark__text {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-weight: 550; font-size: 12.5px;
}
.smb-qmark__n { flex: none; font-size: 11.5px; color: var(--smb-text-4); }
.smb-qmark__n--warn { color: var(--smb-learning); }
.smb-qmark__go { flex: none; color: var(--smb-brand); }

/* ── 右栏「题目」tab ────────────────────────────────────────────────────── */

.smb-qsum { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.smb-qsum .smb-progressbar { flex: 1; }
.smb-qjump { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.smb-qjump__btn {
  width: 24px; height: 24px; border-radius: 7px; border: 1px solid var(--smb-line-strong);
  background: var(--smb-panel); color: var(--smb-text-3); font: inherit; font-size: 11.5px; cursor: pointer;
}
.smb-qjump__btn:hover { border-color: var(--smb-brand); color: var(--smb-brand); }
.smb-agroup {
  margin-bottom: 10px; border: 1px solid var(--smb-line); border-radius: 12px;
  background: var(--smb-panel); overflow: hidden; scroll-margin-top: 8px;
}
.smb-agroup__head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,.02)); }
.smb-agroup__title {
  display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;
  border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.smb-agroup__no {
  flex: none; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%;
  border: 1px solid var(--smb-line-strong); color: var(--smb-text-3); font-size: 11px;
}
.smb-agroup__text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; font-size: 12.5px; }
.smb-agroup__fold { flex: none; width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: var(--smb-text-4); font: inherit; cursor: pointer; }
.smb-agroup__fold:hover { background: var(--smb-hover); color: var(--smb-text); }
.smb-agroup__body { padding: 10px 12px 4px; }
.smb-right__n {
  margin-left: 5px; padding: 0 5px; border-radius: 99px; font-size: 10.5px;
  background: var(--dsw-alias-fill-l2, rgba(0,0,0,.08)); color: var(--smb-text-3);
}

/* ── 右栏「问答」tab ────────────────────────────────────────────────────── */

.smb-askchip {
  position: sticky; bottom: 16px; z-index: 6;
  display: block; width: fit-content; margin: 0 auto 16px;
  padding: 7px 16px; border: 1px solid var(--smb-line-strong); border-radius: 99px;
  background: var(--smb-panel); color: var(--smb-text); font: inherit; font-size: 12.5px;
  box-shadow: 0 12px 30px -14px rgba(0,0,0,.5); cursor: pointer;
}
.smb-askchip:hover { background: var(--smb-raise); }

.smb-askbody { font-size: 12.5px; }
.smb-ask__head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.smb-askbody p { margin: 0 0 8px; font-size: 12.5px; color: var(--smb-text-2); line-height: 1.7; }

.smb-dot--未开始 { background: var(--smb-todo); }

`;

    /** 样式注入：物化时执行一次。宿主会用 data-plugin 认领并在这份 bundle 卸载时清掉。 */
    function injectStyles(css) {
      if (typeof document === 'undefined') return;
      const id = '@yunmiao/studymate/reading-client.css';
      if (document.querySelector('style[data-plugin-css="' + id + '"]')) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = '@yunmiao/studymate';
      tag.dataset.pluginCss = id;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /* ═══════════════════════════════════════════════════════════════════════
       课件内容文件解析
       目标态规格 §5.1 把渲染从 Python 搬到了阅读端：`::: quiz` / `::: svg` 这些块
       从此由前端解释。解析与 Python 渲染器退役前的口径一致（docs/规范/课件内容格式.md §4）。
       ═══════════════════════════════════════════════════════════════════════ */

    /**
     * 把内容文件里的图片相对路径换成 Host 的取图地址。
     * 路径相对 **lessons/ 目录**写（格式规范 §4），`../assets/...` 于是落在 <科目>/assets/。
     */
    function assetUrl(subjectSlug, lessonPath, src) {
      if (!src || /^(?:[a-z]+:|\/\/)/i.test(src)) return src;   // 外链不动它（格式规范里也不允许，但别炸）
      // 课件文件在 <科目>/lessons/<文件>.md，而内容里的相对路径是相对 lessons/ 写的
      const base = '/' + String(lessonPath || '').replace(/[^/]+$/, '') + 'lessons/';
      let rel;
      try {
        // pathname 带百分号编码，先解回来，否则下面再编一次就成了双重编码
        rel = decodeURIComponent(new URL(src, 'http://x' + base).pathname).replace(/^\//, '');
      } catch {
        return src;
      }
      // 取图路由已经按 subject 定位了，这里把 <科目>/ 前缀去掉，只留科目内的相对路径
      if (subjectSlug && rel.startsWith(subjectSlug + '/')) rel = rel.slice(subjectSlug.length + 1);
      return ASSET_ENDPOINT + '?subject=' + encodeURIComponent(subjectSlug) + '&path=' + encodeURIComponent(rel);
    }

    function splitFrontmatter(markdown) {
      const m = /^---\n([\s\S]*?)\n---\n?/.exec(markdown || '');
      if (!m) return { meta: {}, body: markdown || '' };
      const meta = {};
      for (const line of m[1].split('\n')) {
        const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
      }
      return { meta, body: markdown.slice(m[0].length) };
    }

    const isBlank = (line) => /^\s*$/.test(line);
    let figureSeq = 0;

    function parseBlocks(lines) {
      const blocks = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (isBlank(line)) { i++; continue; }

        const open = /^:::\s*([a-z]+)\s*(.*)$/.exec(line);
        if (open) {
          const body = [];
          i++;
          while (i < lines.length && !/^:::\s*$/.test(lines[i])) body.push(lines[i++]);
          i++;
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

        const head = /^(#{1,6})\s+(.*)$/.exec(line);
        if (head) { blocks.push({ type: 'heading', level: head[1].length, text: head[2].trim() }); i++; continue; }

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
          const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
          blocks.push({
            type: 'table',
            head: cells(rows[0]),
            rows: rows.slice(1).filter((r) => !/^\|[\s:|-]+\|$/.test(r)).map(cells),
          });
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
        while (i < lines.length && !isBlank(lines[i])
          && !/^:::|^```|^#{1,6}\s|^\||^>|^\$\$\s*$|^[-*]\s|^\d+\.\s/.test(lines[i])) para.push(lines[i++]);
        const text = para.join(' ').trim();
        const blockMath = /^\$\$([\s\S]+)\$\$$/.exec(text);
        if (blockMath) blocks.push({ type: 'math', tex: blockMath[1].trim() });
        else blocks.push({ type: 'para', text });
      }
      return blocks;
    }

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
          const parts = body.split('|');
          items.push({ text: parts[0].trim(), href: '', note: parts.slice(1).join('|').trim() });
        }
      }
      return items;
    }

    function makeDirective(name, header, body) {
      if (name === 'quiz') {
        const anchor = /锚点：(.*)$/.exec(header);
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
        const caption = ((/^caption:\s*(.*)$/m.exec(text) || [])[1] || '').replace(/^图\s*\d+\s*·\s*/, '');
        const block = { type: 'figure', kind: name, alt, caption, figureNo: caption ? ++figureSeq : 0 };
        if (name === 'svg') block.svg = (/<svg[\s\S]*<\/svg>/.exec(text) || [])[0] || '';
        else block.src = header.trim();
        return block;
      }
      if (name === 'practice') {
        const parts = header.split('|');
        return { type: 'practice', kind: (parts[0] || '动手做').trim(), title: parts.slice(1).join('|').trim(), blocks: parseBlocks(body) };
      }
      if (name === 'resources' || name === 'related') return { type: name, items: parseItems(body) };
      if (name === 'tip' || name === 'warn' || name === 'note') {
        return { type: 'callout', tone: name, title: header.trim(), blocks: parseBlocks(body) };
      }
      return { type: 'unknown', name, header, text: body.join('\n').trim() };
    }

    function parseLesson(markdown) {
      figureSeq = 0;
      const { meta, body } = splitFrontmatter(markdown);
      const blocks = parseBlocks(body.split('\n'));
      const sections = [];
      let current = { index: 0, title: meta.title || '正文', id: 'sec-0', blocks: [] };
      for (const block of blocks) {
        if (block.type === 'heading' && block.level === 2) {
          if (current.blocks.length || sections.length === 0) sections.push(current);
          current = { index: sections.length, title: block.text, id: 'sec-' + sections.length, blocks: [] };
          continue;
        }
        current.blocks.push(block);
      }
      sections.push(current);
      let n = 0;
      for (const block of blocks) if (block.type === 'quiz') block.quizIndex = n++;
      return { meta, blocks, sections: sections.filter((s, i) => s.blocks.length > 0 || i === 0) };
    }

    /* ── 行内标记 → React 节点 ────────────────────────────────────────────── */

    const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\$[^$\n]+\$|\[[^\]]+\]\([^)\s]+\))/g;

    function inlineNodes(text, keyPrefix) {
      const out = [];
      const parts = String(text == null ? '' : text).split(INLINE).filter((p) => p !== '' && p != null);
      parts.forEach((part, index) => {
        const key = keyPrefix + '-' + index;
        if (/^\*\*[^*]+\*\*$/.test(part)) out.push(h('strong', { key }, part.slice(2, -2)));
        else if (/^`[^`]+`$/.test(part)) out.push(h('code', { key }, part.slice(1, -1)));
        else if (/^\$[^$\n]+\$$/.test(part)) out.push(h('span', { key, className: 'smb-math' }, part.slice(1, -1)));
        else {
          const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
          if (link) out.push(h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]));
          else out.push(part);
        }
      });
      return out;
    }

    /* ── 块 → React 元素 ──────────────────────────────────────────────────── */

    function Block({ block, ctx }) {
      switch (block.type) {
        case 'heading':
          return h(block.level >= 3 ? 'h3' : 'h2', null, inlineNodes(block.text, 'hd'));
        case 'para':
          return h('p', null, inlineNodes(block.text, 'p'));
        case 'quote':
          return h('blockquote', { className: 'smb-quote' }, inlineNodes(block.text, 'q'));
        case 'math':
          return h('div', { className: 'smb-math-block' }, block.tex);
        case 'list': {
          const items = block.items.map((item, i) => h('li', { key: i }, inlineNodes(item, 'li' + i)));
          return h(block.ordered ? 'ol' : 'ul', null, items);
        }
        case 'code':
          return h('div', { className: 'smb-code' + (block.term ? ' smb-code--term' : '') },
            h('div', { className: 'smb-code__bar' }, h('b', null, block.term ? '运行结果' : (block.lang || 'text'))),
            h('pre', null, h('code', null, block.code)));
        case 'table':
          return h('div', { className: 'smb-table-wrap' },
            h('table', { className: 'smb-table' },
              h('thead', null, h('tr', null, block.head.map((cell, i) => h('th', { key: i }, inlineNodes(cell, 'th' + i))))),
              h('tbody', null, block.rows.map((row, r) => h('tr', { key: r },
                row.map((cell, c) => h('td', { key: c }, inlineNodes(cell, 'td' + r + c))))))));
        case 'figure': {
          const caption = block.caption
            ? h('figcaption', null, block.figureNo ? h('b', null, '图 ' + block.figureNo + ' · ') : null, inlineNodes(block.caption, 'cap'))
            : null;
          if (block.kind === 'figure') {
            const src = assetUrl((ctx.subject && ctx.subject.slug) || '', (ctx.node && ctx.node.lesson) || '', block.src);
            return h('figure', { className: 'smb-figure' },
              h('div', { className: 'smb-figure__frame' },
                h('img', { src, alt: block.alt, loading: 'lazy' })),
              caption);
          }
          // SVG 原样透传：内容文件里唯一允许写标签的地方，来源是仓库内容而非用户输入
          return h('figure', { className: 'smb-figure' },
            h('div', { className: 'smb-figure__frame', role: 'img', 'aria-label': block.alt || block.caption || '配图' }),
            caption);
        }
        case 'callout':
          return h('div', { className: 'smb-note' + (block.tone === 'warn' ? ' smb-note--warn' : block.tone === 'tip' ? ' smb-note--brand' : '') },
            h('div', null,
              block.title ? h('b', null, block.title) : null,
              h('div', null, h(Blocks, { blocks: block.blocks, ctx }))));
        case 'practice':
          return h('section', { className: 'smb-practice' },
            h('div', { className: 'smb-practice__head' }, block.title || block.kind, h('span', null, block.kind)),
            h('div', { className: 'smb-practice__body' }, h(Blocks, { blocks: block.blocks, ctx })));
        case 'resources':
          return h('section', { className: 'smb-note smb-note--brand' },
            h('div', null,
              h('b', null, '参考资源'),
              h('ul', { style: { margin: '4px 0 0', paddingLeft: '1.2em' } }, block.items.map((item, i) => h('li', { key: i },
                item.href ? h('a', { href: item.href, target: '_blank', rel: 'noreferrer' }, item.text) : h('span', null, item.text),
                item.note ? h('span', { className: 'smb-meta' }, ' · ' + item.note) : null)))));
        case 'related':
          return h('div', { className: 'smb-note' },
            h('div', null, h('ul', { style: { margin: 0, paddingLeft: '1.2em' } }, block.items.map((item, i) => h('li', { key: i },
              item.href ? h('a', { href: item.href, target: '_blank', rel: 'noreferrer' }, item.text) : h('span', null, item.text))))));
        case 'quiz':
          return ctx.renderAnchor ? ctx.renderAnchor(block) : null;
        default:
          return h('div', { className: 'smb-note smb-note--warn' },
            h('div', null, h('b', null, '这个块阅读端还不认识：' + block.name), h('div', null, block.text)));
      }
    }

    /**
     * SVG 块要用 innerHTML 原样透传（里面的标签就是内容本身）。
     * 单独抽出来是因为 React 不允许在 createElement 里塞裸 HTML 字符串。
     */
    function SvgFrame({ svg, label }) {
      const ref = useRef(null);
      useEffect(() => {
        if (ref.current) ref.current.innerHTML = svg || '';
      }, [svg]);
      return h('div', { className: 'smb-figure__frame', role: 'img', 'aria-label': label, ref });
    }

    function Blocks({ blocks, ctx }) {
      return h(React.Fragment, null, blocks.map((block, i) => {
        if (block.type === 'figure' && block.kind === 'svg') {
          return h('figure', { className: 'smb-figure', key: i },
            h(SvgFrame, { svg: block.svg, label: block.alt || block.caption || '配图' }),
            block.caption ? h('figcaption', null, block.figureNo ? h('b', null, '图 ' + block.figureNo + ' · ') : null, inlineNodes(block.caption, 'cap')) : null);
        }
        return h(Block, { block, ctx, key: i });
      }));
    }

    /* ═══════════════════════════════════════════════════════════════════════
       锚点四态与判分
       目标态规格 §4.4：锚点定位分 resolved / stale / ambiguous / missing 四态，
       多匹配**绝不静默取第一个**；非 resolved 时判分入口关闭。
       ═══════════════════════════════════════════════════════════════════════ */

    const STATE_TEXT = {
      resolved: '锚点已对上',
      stale: '锚点与题库键只差空白',
      ambiguous: '一个锚点对上了多个题库键',
      missing: '题库里没有这道题',
    };
    const STATE_NOTE = {
      resolved: '',
      stale: '正文里的锚点文字与题库键不完全一致，要人来确认；确认前不判分。',
      ambiguous: '同一段正文下有多个题库键都能对上，选一个才算数。',
      missing: '正文里声明了这个锚点，题库里却没有对应的题，只能标记「这道题缺了」。',
    };
    const letter = (i) => String.fromCharCode(65 + i);
    /* 题型词表：与 schemas/question.schema.json 的 kind.enum 逐字一致（纯函数域的权威是
       lib/core/rules.ts 的 QUESTION_KINDS，这里只是阅读端按题型选渲染分支）。
       旧题库不写 kind，按字段推断——与 lib/core/rules.ts 的 inferQuestionKind 同一口径。 */
    const QUESTION_KINDS = ['客观题', '预测验证', '开放题', '交付物'];
    function questionKind(item) {
      if (typeof item.kind === 'string' && QUESTION_KINDS.indexOf(item.kind) >= 0) return item.kind;
      if (typeof item.ans === 'number' || Array.isArray(item.opts)) return '客观题';
      if (typeof item.answer === 'string' || typeof item.criteria === 'string') return '开放题';
      if (typeof item.预测 === 'string') return '预测验证';
      if (typeof item.交付物 === 'string') return '交付物';
      return '';
    }
    const isOpen = (item) => questionKind(item) !== '客观题';

    /* ═══════════════════════════════════════════════════════════════════════
       阅读端本体
       ═══════════════════════════════════════════════════════════════════════ */

    const TIERS = ['未开始', '学习中', '已学完'];

    function useLibrary() {
      const [state, setState] = useState({ status: 'loading', data: null, error: '' });
      // silent = 后台重读：保留当前画面，拿到新数据再换。
      // 写完一份参考资料要重读一次；如果这一下把整页打回「正在读…」，刚写成的回执与
      // 滚动位置都会被清掉（踩过），所以刷新必须是无闪烁的。
      const load = useCallback((silent) => {
        setState((prev) => (silent && prev.data ? prev : { status: 'loading', data: null, error: '' }));
        fetch(LIBRARY_ENDPOINT, { headers: { accept: 'application/json' } })
          .then(async (response) => {
            // Host 半出错时回 500 + {error}：把那句话原样带给学生，别只丢一个状态码
            const body = await response.json().catch(() => null);
            if (!response.ok) throw new Error((body && body.error) || ('HTTP ' + response.status));
            if (!body) throw new Error('返回的不是 JSON');
            return body;
          })
          .then((data) => setState({ status: 'ready', data, error: '' }))
          .catch((error) => setState({ status: 'error', data: null, error: String((error && error.message) || error) }));
      }, []);
      useEffect(() => { load(false); }, [load]);
      return [state, load];
    }

    /** 供界面用的重读句柄：一律走静默刷新。 */
    function useRefresh(load) {
      return useCallback(() => load(true), [load]);
    }

    /* ── 暂缓：打卡与成就图（规格 §4.1 第三条决定）────────────────────────────
       两者都只由学习记录派生，而真工作区里四门科目的 `learning-records/` **全部为空**：
       现在渲染出来就是「0 天」与一片空白。所以本轮**只是不渲染，代码一行不删**——
       等「哪天有学习活动」找到数据源（最自然的是给作答数据加时间戳，或让阅读端记一条
       「打开课件」），把 `<StreakCard>` 与 `<Heatmap>` 挂回主页/科目主页即可。

       从下面这行起，到 `<Heatmap>` 为止的一整块（含日期工具函数）都属于这群暂缓原料，
       当前没有调用点。 */

    /* ── 日期：打卡与成就图的原料（只由学习记录派生，不引掌握度）──────────────
       一律用本地日期拼 'YYYY-MM-DD'，不走 toISOString——那个按 UTC 算，
       东八区下午之后会整体差一天。 */

    const pad2 = (n) => String(n).padStart(2, '0');
    const isoDay = (date) => date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());

    function shiftDay(iso, delta) {
      const [y, m, d] = String(iso).split('-').map(Number);
      const date = new Date(y, m - 1, d);
      date.setDate(date.getDate() + delta);
      return isoDay(date);
    }

    /** 一个科目里所有学习记录的日期（去重、升序）。 */
    function recordDates(subject) {
      return [...new Set((subject.records || []).map((r) => r.date).filter(Boolean))].sort();
    }

    /**
     * 连续学习天数：以**浏览器当天**为锚往回数。
     * 今天还没学不算断——昨天为止那段仍然算数（否则每天早上一睁眼打卡就归零）。
     */
    function streakOf(dates, today) {
      const set = new Set(dates);
      if (!set.size) return { days: 0, last: '' };
      const last = [...set].sort().pop();
      let cursor = today;
      if (!set.has(cursor)) {
        cursor = shiftDay(today, -1);
        if (!set.has(cursor)) return { days: 0, last };
      }
      let days = 0;
      while (set.has(cursor)) { days++; cursor = shiftDay(cursor, -1); }
      return { days, last };
    }

    /* ── 第一级 · 主页（工作台）────────────────────────────────────────────── */

    function StreakCard({ subjects, today }) {
      const all = subjects.flatMap(recordDates);
      const { days, last } = streakOf(all, today);
      const recent = new Set([today, shiftDay(today, -1), shiftDay(today, -2), shiftDay(today, -3), shiftDay(today, -4), shiftDay(today, -5), shiftDay(today, -6)]);
      const marked = [...recent].map((day) => ({ day, hit: all.includes(day) })).sort((a, b) => a.day.localeCompare(b.day));
      return h('section.smb-tile.smb-streak', null,
        h('div.smb-tile__label', null, '打卡'),
        h('div.smb-streak__num', null,
          h('b', null, String(days)),
          h('span', null, '天连续')),
        h('div.smb-streak__week', { 'aria-label': '最近七天' }, marked.map(({ day, hit }) => h('i', {
          key: day, 'data-hit': hit ? '1' : '0', title: day + (hit ? ' 有学习记录' : ' 没有记录'),
        }, day.slice(8)))),
        h('div.smb-tile__foot', null, last ? ('最近一次：' + last) : '还没有学习记录'));
    }

    /**
     * 主卡放哪一门：最近改过进度的那门（`progress.yaml` 的 `updated_at`）。
     * `subjects` 由 library.mjs 按目录序 push，**本身没有排序**，所以这里得自己排；
     * 只看「最后一次改动」，不看掌握度、不看节点多少。
     */
    function lastTouched(subjects) {
      let best = null;
      for (const subject of subjects) {
        if (!best || String(subject.updated_at || '') > String(best.updated_at || '')) best = subject;
      }
      return best;
    }

    /** 主卡「接着上次」：**只有一张**，落到最近那门的 continue_node。 */
    function ContinueCard({ subjects, onLesson }) {
      const subject = lastTouched(subjects);
      if (!subject) return null;
      const node = subject.nodes.find((n) => n.id === subject.continue_node) || subject.nodes[0];
      if (!node) {
        return h('section.smb-block', null,
          h('h2.smb-block__title', null, '接着上次'),
          h('div.smb-empty', null, subject.name + ' 还没有节点。'));
      }
      const note = (node.notes || '').split(/(?<=[。！？；])/)[0] || '';
      const done = subject.stats['已学完'] || 0;
      const total = subject.nodes.length;

      return h('section.smb-block', null,
        h('h2.smb-block__title', null, '接着上次'),
        h('button.smb-continue.smb-continue--hero', { 'data-proto': 'continue', onClick: () => onLesson(subject, node.id) },
          h('div.smb-continue__top', null,
            h('span.smb-continue__subject', null, subject.name),
            h('span.smb-spacer'),
            h('span.smb-chip.smb-chip--' + node.tier, null, h('i.smb-dot.smb-dot--' + node.tier), node.tier)),
          h('div.smb-continue__title', null,
            h('span.smb-node__no', null, node.number || '—'),
            node.title),
          node.objective ? h('div.smb-continue__goal', null, inlineNodes(node.objective, 'cg' + node.id)) : null,
          note ? h('div.smb-continue__note', null, note) : null,
          h('div.smb-continue__bar', null,
            h('div.smb-progressbar', {
              role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done,
              'aria-label': subject.name + ' 已学完 ' + done + ' / ' + total,
            }, h('i', { style: { width: (total ? (done / total) * 100 : 0) + '%' } })),
            h('span.smb-meta', null, '已学完 ' + done + ' / ' + total),
            h('span.smb-spacer'),
            h('span.smb-continue__go', null, node.lesson_md ? '继续读 →' : '还没有课件'))));
    }

    /** 科目列表的一行：名字 + 一句话目标 + 进度细条 + 三档计数。 */
    function SubjectRow({ subject, onSubject }) {
      const done = subject.stats['已学完'] || 0;
      const total = subject.nodes.length;
      return h('button.smb-course', { 'data-proto': 'nav-subject', onClick: () => onSubject(subject) },
        h('div.smb-course__main', null,
          h('div.smb-course__name', null,
            subject.name,
            subject.status ? h('span.smb-chip', null, subject.status) : null,
            subject.levels ? h('span.smb-chip', null, subject.levels + ' 层') : null),
          subject.goal ? h('div.smb-course__goal', null, subject.goal) : null),
        h('div.smb-course__side', null,
          h('div.smb-course__bar', null,
            h('div.smb-progressbar', {
              role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done,
              'aria-label': subject.name + ' 已学完 ' + done + ' / ' + total,
            }, h('i', { style: { width: (total ? (done / total) * 100 : 0) + '%' } })),
            h('span.smb-meta', null, done + ' / ' + total)),
          h('div.smb-course__stats', null, TIERS.map((tier) => h('span', { key: tier },
            h('i.smb-dot.smb-dot--' + tier), tier + ' ' + (subject.stats[tier] || 0)))),
          h('span.smb-course__go', { 'aria-hidden': 'true' }, '›')));
    }

    /**
     * 科目列表：**只有一份**。「未完成的科目」与「课程目录」曾是另外两块 `subjects.map`，
     * 键还都是 `slug`——4 门科目于是在主页出现 12 条条目（用户原话：「都是同一个东西」）。
     * 现在一行一门，已学完的折在列表末尾。
     */
    function SubjectList({ subjects, onSubject }) {
      const [openDone, setOpenDone] = useState(false);
      const finished = subjects.filter((s) => s.nodes.length && (s.stats['已学完'] || 0) >= s.nodes.length);
      const rest = subjects.filter((s) => finished.indexOf(s) < 0);

      return h('section.smb-block', null,
        h('h2.smb-block__title', null, '科目', h('span.smb-meta', null, subjects.length + ' 门')),
        subjects.length === 0
          ? h('div.smb-empty', null, '还没有科目。')
          : h('div.smb-courses', null, rest.map((subject) => h(SubjectRow, { key: subject.slug, subject, onSubject }))),
        finished.length ? h('div.smb-donefold', null,
          h('button.smb-fold__head', { onClick: () => setOpenDone((open) => !open) },
            '已学完的 ' + finished.length + ' 门',
            h('span.smb-fold__count', null, openDone ? '收起' : '展开')),
          openDone ? h('div.smb-courses.smb-courses--folded', null,
            finished.map((subject) => h(SubjectRow, { key: subject.slug, subject, onSubject }))) : null) : null);
    }

    function HomePage({ subjects, onSubject, onLesson }) {
      return h('div.smb-wrap', null,
        h('header.smb-hero', null,
          h('h1.smb-hero__title', null, '学习工作台'),
          h('p.smb-hero__sub', null, '没有待复习队列，也没有今天该刷多少题的排期——接着上次那个节点往下读就行。')),
        h(ContinueCard, { subjects, onLesson }),
        h(SubjectList, { subjects, onSubject }));
    }

    /* ── 成就图：学习记录的时间热力图（本科目）— **暂缓渲染，见上** ───────────
       规格 §4.1 与 §4.4：只由学习记录派生，不新增字段、不引掌握度；
       图表要给 aria-label 与视觉隐藏的 <table> 兜底。 */

    /** 热力格子：一层一层拆开写，深嵌套的三元 + map 括号太容易数错。 */
    function HeatGrid({ columns, label }) {
      return h('div.smb-heat__grid', { role: 'img', 'aria-label': label },
        columns.map((col, w) => h('div.smb-heat__col', { key: 'w' + w },
          col.map((cell) => h('i', {
            key: cell.iso,
            'data-level': cell.level,
            'data-future': cell.future ? '1' : '0',
            title: cell.iso + (cell.count ? '：' + cell.count + ' 条记录' : '：没有记录'),
          })))));
    }

    /** 无障碍兜底：图表按 §4.4 要配一张视觉隐藏的 <table>，读屏软件才读得到数据。 */
    function HeatTable({ cells, label }) {
      const rows = cells.filter((cell) => cell.count > 0);
      return h('table.smb-vh', null,
        h('caption', null, label),
        h('thead', null, h('tr', null, h('th', null, '日期'), h('th', null, '记录条数'))),
        h('tbody', null, rows.map((cell) => h('tr', { key: cell.iso },
          h('td', null, cell.iso),
          h('td', null, String(cell.count))))));
    }

    function Heatmap({ subject, today, weeks = 22 }) {
      const counts = new Map();
      for (const date of recordDates(subject)) counts.set(date, (counts.get(date) || 0) + 1);
      const max = Math.max(1, ...[...counts.values()]);

      // 从本周往回排 weeks 列、每列 7 天，行是星期几（与常见的贡献图一致）
      const [y, m, d] = today.split('-').map(Number);
      const end = new Date(y, m - 1, d);
      end.setDate(end.getDate() + (6 - end.getDay()));          // 补到本周六
      const start = new Date(end);
      start.setDate(start.getDate() - (weeks * 7 - 1));

      const columns = [];
      const cells = [];
      for (let w = 0; w < weeks; w++) {
        const col = [];
        for (let dow = 0; dow < 7; dow++) {
          const date = new Date(start);
          date.setDate(date.getDate() + w * 7 + dow);
          const iso = isoDay(date);
          const count = counts.get(iso) || 0;
          col.push({ iso, count, future: iso > today, level: count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4)) });
        }
        columns.push(col);
        cells.push(...col);
      }

      const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
      const label = '成就图：' + subject.name + ' 共 ' + total + ' 条学习记录，覆盖 ' + counts.size + ' 天';

      if (total === 0) {
        return h('section.smb-tile.smb-heat', null,
          h('div.smb-tile__label', null, '成就图'),
          h('div.smb-empty', null, '这个科目还没有学习记录。每学完一个节点，这里就会亮一格。'));
      }

      const legend = h('div.smb-heat__legend', null,
        h('span', null, '少'),
        [0, 1, 2, 3, 4].map((level) => h('i', { key: 'l' + level, 'data-level': level })),
        h('span', null, '多'));

      return h('section.smb-tile.smb-heat', null,
        h('div.smb-tile__label', null, '成就图'),
        h('div.smb-heat__body', null,
          h(HeatGrid, { columns, label }),
          legend,
          h(HeatTable, { cells, label })));
    }

    /* ── 参考资料：列已有的 + 学生自己加（ADR-0010 的写入路径）────────────── */

    const TEXT_EXT = ['.md', '.markdown', '.txt'];

    /**
     * 参考资料清单（**只读**）：科目主页与课件页左栏共用一份。
     * 写入入口只在科目主页（规格 §4.1：科目主页 = 目录 + 学生自加资料入口），
     * 所以这里不带表单——左栏是读课件时随手翻的地方，不该在那里写文件。
     */
    function ReferenceList({ subject, empty }) {
      const list = subject.reference || [];
      const [reading, setReading] = useState(null);
      useEffect(() => { setReading(null); }, [subject.slug]);

      const load = async (entry) => {
        setReading({ entry, text: '正在读…' });
        try {
          const response = await fetch(REFERENCE_ENDPOINT + '?subject=' + encodeURIComponent(subject.slug) + '&path=' + encodeURIComponent(entry.path));
          const payload = await response.json().catch(() => null);
          setReading({ entry, text: response.ok && payload ? (payload.text || '') : ((payload && (payload.message || payload.error)) || ('HTTP ' + response.status)) });
        } catch (error) {
          setReading({ entry, text: '读不出来：' + String((error && error.message) || error) });
        }
      };

      return h('div', null,
        list.length === 0
          ? h('div.smb-empty', null, empty || '这个科目还没有参考资料。')
          : h('ul.smb-reflist', null, list.map((entry) => h('li.smb-refitem', { key: entry.path },
            h('button.smb-refitem__open', {
              disabled: TEXT_EXT.indexOf(entry.ext) === -1,
              title: TEXT_EXT.indexOf(entry.ext) === -1 ? '这个类型阅读端不内联显示' : '点开看内容',
              onClick: () => load(entry),
            }, entry.title),
            h('span.smb-chip' + (entry.source === 'learner' ? '.smb-chip--info' : ''), null,
              entry.source === 'learner' ? '我加的' : '资料收集'),
            h('span.smb-meta', null, entry.ext + (entry.bytes ? ' · ' + Math.max(1, Math.round(entry.bytes / 1024)) + ' KB' : '')),
            entry.added_at ? h('span.smb-meta', null, entry.added_at.slice(0, 10)) : null))),
        reading ? h('div.smb-reader', null,
          h('div.smb-reader__head', null,
            h('b', null, reading.entry.title),
            h('span.smb-spacer'),
            h('button.smb-btn.smb-btn--ghost', { onClick: () => setReading(null) }, '关闭')),
          h('pre.smb-reader__body', null, reading.text)) : null);
    }

    function ReferenceSection({ subject, onRefresh }) {
      const [open, setOpen] = useState(false);
      const [title, setTitle] = useState('');
      const [body, setBody] = useState('');
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);

      // 换科目时把这一块本地状态清掉（不再靠 key 重挂：重挂会把写入成功的回执一起清掉）
      useEffect(() => { setNote(null); setOpen(false); }, [subject.slug]);

      const submit = async () => {
        setBusy(true);
        setNote(null);
        try {
          const response = await fetch(REFERENCE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              subject: subject.slug,
              title: title.trim(),
              markdown: body,
              // 幂等键与版本号：同一次提交重复点不会写两份；别人改过 reference/ 就拒绝并重读
              operationId: 'op-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10),
              expectedVersion: subject.reference_version || '',
            }),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            setNote({ bad: true, text: (payload && (payload.message || payload.error)) || ('HTTP ' + response.status) });
            if (response.status === 409) onRefresh();
          } else {
            setNote({ bad: false, text: '已写进 reference/：' + ((payload && payload.entry && payload.entry.path) || '') });
            setTitle('');
            setBody('');
            setOpen(false);
            onRefresh();
          }
        } catch (error) {
          setNote({ bad: true, text: '写不进去：' + String((error && error.message) || error) });
        } finally {
          setBusy(false);
        }
      };

      return h('section.smb-block', null,
        h('h2.smb-block__title', null, '参考资料',
          h('span.smb-spacer'),
          h('button.smb-btn', { onClick: () => { setOpen((v) => !v); setNote(null); } }, open ? '取消' : '＋ 加一份')),
        h('p.smb-block__hint', null, '你自己加的资料会写进科目的 reference/，与资料收集角色收的放在一起，但带来源标记，日后分得清。'),

        open ? h('div.smb-addform', null,
          h('input.smb-input', {
            placeholder: '标题（会用作文件名）', value: title, maxLength: 80,
            onChange: (event) => setTitle(event.target.value),
          }),
          h('textarea.smb-ta', {
            rows: 6, placeholder: '正文（Markdown）', value: body,
            onChange: (event) => setBody(event.target.value),
          }),
          h('div.smb-btnrow', null,
            h('button.smb-btn.smb-btn--primary', {
              disabled: busy || !title.trim() || !body.trim(),
              onClick: submit,
            }, busy ? '正在写…' : '保存到 reference/'),
            h('span.smb-meta', null, '写入会做版本冲突检查；别人刚改过就会拒绝并让你重读'))) : null,

        note ? h('div.smb-note' + (note.bad ? '.smb-note--warn' : ''), null, h('div', null, note.text)) : null,

        h(ReferenceList, { subject }));
    }

    /* ── 第二级 · 科目主页 ─────────────────────────────────────────────────── */

    /**
     * 第二级 · 科目主页（**单栏**）。规格 §4.1 只留两块：目录 + 学生自加资料入口。
     * 四个附件折叠块搬去了课件页左栏——代价是这里看不到本科目的术语表与参考资源，
     * 那是「科目主页只管目录与加资料」换来的（规格里记了这笔账）。
     */
    function SubjectPage({ subject, onLesson, onRefresh }) {
      const done = subject.stats['已学完'] || 0;

      return h('div.smb-wrap', null,
        h('header.smb-subhead', null,
          h('h1.smb-subhead__title', null, subject.name),
          subject.status ? h('span.smb-chip', null, subject.status) : null,
          h('p.smb-subhead__goal', null, inlineNodes(subject.goal || '', 'sg')),
          h('div.smb-subhead__stats', null,
            h('div.smb-progressbar', {
              role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': subject.nodes.length, 'aria-valuenow': done,
              'aria-label': '已学完 ' + done + ' / ' + subject.nodes.length,
            }, h('i', { style: { width: (subject.nodes.length ? (done / subject.nodes.length) * 100 : 0) + '%' } })),
            h('div.smb-subhead__counts', null, TIERS.map((tier) => h('span.smb-chip.smb-chip--' + tier, { key: tier },
              h('i.smb-dot.smb-dot--' + tier), tier + ' ' + (subject.stats[tier] || 0))))) ),

        subject.project ? h('section.smb-note.smb-note--brand', null,
          h('div', null, h('b', null, '在做的项目'), h('div', null, subject.project))) : null,

        h('section.smb-block', null,
          h('h2.smb-block__title', null, '目录'),
          h('p.smb-block__hint', null, '按前置依赖分层，箭头是前置关系；点卡片进课件。'),
          h(Roadmap, { subject, onNode: (id) => onLesson(subject, id) })),

        h(ReferenceSection, { subject, onRefresh }));
    }

    /** 资源清单是 RESOURCES.md 原文，按块解析一次再渲染（与课件同一套块渲染）。 */
    function parseResourceBlocks(markdown) {
      return parseLesson(String(markdown || '')).blocks;
    }

    /* ── 第三级 · 课件阅读页 ───────────────────────────────────────────────── */

    /** 题目位置卡片：页内作答（规格 §4.1），四态里只有 resolved 才判分。 */
    /**
     * 一个锚点下真正要作答的东西（右栏「题目」tab 里那张卡的主体）。
     * 非 resolved 时只说明原因、**不给判分入口**：多匹配绝不静默取第一个（规格 §4.4）。
     */
    function QuizCard({ anchor, index, node, subject, attempts, record }) {
      const state = anchor.resolution || 'missing';
      const questions = state === 'resolved' ? (node.pool[anchor.keys[0]] || []) : [];
      const [chosen, setChosen] = useState({});
      const [self, setSelf] = useState({});

      if (state !== 'resolved') {
        return h('div.smb-note.smb-note--warn', null,
          h('div', null,
            h('b', null, STATE_TEXT[state]),
            h('div', null, STATE_NOTE[state]),
            state === 'stale' ? h('div.smb-quiz__pair', null,
              h('code', null, '正文：' + anchor.text),
              h('span', null, '→'),
              h('code', null, '题库：' + (anchor.keys[0] || '（没找到）'))) : null,
            state === 'ambiguous' ? h('ul.smb-quiz__keys', null, anchor.keys.map((key, i) => h('li', { key: i },
              h('code', null, key), ' · ' + ((node.pool[key] || []).length) + ' 题'))) : null,
            state === 'missing' ? h('div.smb-meta', { style: { marginTop: 6 } },
              '要么补一道题，要么在内容文件里写 empty_reason: 说明这里为什么不出题。') : null));
      }

      return h('div', null, questions.map((item, qi) => h(Question, {
        key: qi, item, index: qi, node, subject,
        stateKey: node.id + '|' + anchor.keys[0] + '|' + qi,
        chosen: chosen[qi], self: self[qi], attempts, record,
        onChoose: (choice) => setChosen((prev) => Object.assign({}, prev, { [qi]: choice })),
        onSelf: (label) => setSelf((prev) => Object.assign({}, prev, { [qi]: label })),
      })));
    }

    /**
     * 正文里的题目标记：正文流里**只留这一颗**，题面与判分都在右栏（规格 §7.2）。
     * 点它 → 右栏滑出并定位到那道题（§4.4）。
     */
    function QuizMarker({ anchor, index, count, onOpen }) {
      const state = anchor.resolution || 'missing';
      return h('button.smb-qmark', {
        'data-proto': 'quiz-marker', 'data-state': state,
        title: '在右栏打开这一组题',
        onClick: () => onOpen(index),
      },
        h('span.smb-qmark__badge', null, '练习'),
        h('span.smb-qmark__text', null, anchor.text || '（没有锚点文字）'),
        h('span.smb-spacer'),
        state === 'resolved'
          ? h('span.smb-qmark__n', null, count + ' 题')
          : h('span.smb-qmark__n.smb-qmark__n--warn', null, STATE_TEXT[state]),
        h('span.smb-qmark__go', { 'aria-hidden': 'true' }, '→'));
    }

    /** 右栏「题目」tab 里的一张锚点卡：可折叠，头上有编号与题数。 */
    function AnchorGroup({ group, node, subject, attempts, record }) {
      const [open, setOpen] = useState(true);
      const state = group.anchor.resolution || 'missing';
      return h('section.smb-agroup', { id: 'smb-anchor-' + group.index, 'data-anchor': group.index },
        h('div.smb-agroup__head', null,
          h('button.smb-agroup__title', { onClick: () => setOpen((v) => !v), 'aria-expanded': open ? 'true' : 'false' },
            h('span.smb-agroup__no', null, String(group.index + 1)),
            h('span.smb-agroup__text', null, group.anchor.text || '（没有锚点文字）')),
          state === 'resolved'
            ? h('span.smb-meta', null, group.questions.length + ' 题')
            : h('span.smb-chip.smb-chip--warn', null, STATE_TEXT[state]),
          h('button.smb-agroup__fold', {
            onClick: () => setOpen((v) => !v), 'aria-label': open ? '收起这一组' : '展开这一组',
          }, open ? '⌃' : '⌄')),
        open ? h('div.smb-agroup__body', null,
          h(QuizCard, { anchor: group.anchor, index: group.index, node, subject, attempts, record })) : null);
    }

    /** 「题目」tab 的主体：节内进度 + 编号跳转 + 每组一张卡。 */
    function QuestionList({ node, subject, groups, total, answered, attempts, record }) {
      if (!groups.length) return h('div.smb-empty', null, '这一课的正文里没有题目标记。');

      const jump = (index) => {
        const el = document.getElementById('smb-anchor-' + index);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };

      return h('div', null,
        h('div.smb-qsum', null,
          h('div.smb-progressbar', {
            role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': answered,
            'aria-label': '这一课已作答 ' + answered + ' / ' + total,
          }, h('i', { style: { width: (total ? (answered / total) * 100 : 0) + '%' } })),
          h('span.smb-meta', null, '作答 ' + answered + ' / ' + total)),
        groups.length > 1 ? h('div.smb-qjump', { 'aria-label': '跳到某一组' }, groups.map((group) => h('button.smb-qjump__btn', {
          key: group.index, title: group.anchor.text, onClick: () => jump(group.index),
        }, String(group.index + 1)))) : null,
        h('p.smb-block__hint', null, '正文里只留编号标记；题面与判分都在这里。'),
        groups.map((group) => h(AnchorGroup, { key: group.index, group, node, subject, attempts, record })));
    }

    /**
     * 右栏检查器（规格 §4.1）：`题目` / `问答` 两个 tab。
     * `focus` 每次点标记都换一个新对象，所以同一个标记连点两次也会重新滚过去。
     */
    function Inspector({ tab, onTab, node, subject, groups, total, answered, attempts, record, focus, selection, askTick }) {
      const bodyRef = useRef(null);

      useEffect(() => {
        const root = bodyRef.current;
        if (!root || !focus) return;
        const el = root.querySelector('[data-anchor="' + focus.index + '"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, [focus, tab]);

      return h(React.Fragment, null,
        h('div.smb-right__tabs', { role: 'tablist' },
          h('button.smb-tab', {
            role: 'tab', 'aria-selected': tab === '题目' ? 'true' : 'false', 'data-proto': 'tab-quiz',
            onClick: () => onTab('题目'),
          }, '题目', total ? h('span.smb-right__n', null, String(total)) : null),
          h('button.smb-tab', {
            role: 'tab', 'aria-selected': tab === '问答' ? 'true' : 'false', 'data-proto': 'tab-ask',
            onClick: () => onTab('问答'),
          }, '问答')),
        h('div.smb-right__body', { ref: bodyRef, role: 'tabpanel', 'aria-label': tab },
          tab === '题目'
            ? h(QuestionList, { node, subject, groups, total, answered, attempts, record })
            : h(AskPanel, { subject, node, selection, focusTick: askTick })));
    }

    /* ── 栏宽：左右各记一份，住在浏览器本地偏好里（规格 §4.4）─────────────────
       与主题、动效档同级：换科目、换层级都不变，**收起不丢宽度**。
       两条规则抄自宿主（`dsh-client-ui-layout` 的 `stores.d.ts` 写明）：
         · 拖拽写入按**当前画布**的区间 clamp——所以存下来的值不会超过当时画布允许的范围；
         · **响应式让步绝不覆写已存的宽度**——画布变窄只是收起，变宽后自动恢复。
       localStorage 在无痕模式里会抛，读写都包一层，读不到就用默认宽。 */

    const PANE_KEY = 'studymate.panes.v1';
    const PANE_LIMITS = { left: { min: 200, max: 460, fallback: 264 }, right: { min: 280, max: 640, fallback: 372 } };
    const RAILS_WIDTH = 76;   // 两条窄轨加起来
    const MIN_CENTER = 420;   // 中间栏的保底宽度

    function readPaneWidths() {
      const out = { left: PANE_LIMITS.left.fallback, right: PANE_LIMITS.right.fallback };
      try {
        const raw = JSON.parse(window.localStorage.getItem(PANE_KEY) || 'null');
        for (const side of ['left', 'right']) {
          const value = raw ? Number(raw[side]) : NaN;
          if (Number.isFinite(value)) out[side] = Math.min(PANE_LIMITS[side].max, Math.max(PANE_LIMITS[side].min, value));
        }
      } catch (error) { /* 读不到（无痕 / 坏值）就用默认宽，不影响本次会话 */ }
      return out;
    }

    function writePaneWidths(widths) {
      try { window.localStorage.setItem(PANE_KEY, JSON.stringify(widths)); } catch (error) { /* 存不下就算了 */ }
    }

    /** 存下来的栏宽。写入延后一点合并，拖动时每帧写 localStorage 会卡。 */
    function usePaneWidths() {
      const [widths, setWidths] = useState(readPaneWidths);
      useEffect(() => {
        const timer = setTimeout(() => writePaneWidths(widths), 200);
        return () => clearTimeout(timer);
      }, [widths]);
      const resize = useCallback((side, value) => {
        setWidths((prev) => (prev[side] === value ? prev : Object.assign({}, prev, { [side]: value })));
      }, []);
      return [widths, resize];
    }

    /**
     * 按当前画布算两条栏的**实际**宽度，装不下就返回 0（收起）。
     * 只读存下来的宽度，**绝不回写**：让步是临时的，画布变宽要能自动恢复。
     * 让的时候**左栏先让**——右栏是点题目标记刚拉出来的，先给它留位。
     */
    function fitPanes(frame, want, stored) {
      const avail = Math.max(0, frame - RAILS_WIDTH - MIN_CENTER);
      let right = want.right ? Math.min(stored.right, avail) : 0;
      if (right < PANE_LIMITS.right.min) right = 0;
      let left = want.left ? Math.min(stored.left, Math.max(0, avail - right)) : 0;
      if (left < PANE_LIMITS.left.min) left = 0;
      return { left, right };
    }

    /** 拖拽/按键写入前按当前画布 clamp（规格 §4.4 第一条）。 */
    function clampPane(side, wanted, frame, other) {
      const limits = PANE_LIMITS[side];
      const room = Math.max(limits.min, frame - RAILS_WIDTH - MIN_CENTER - other);
      return Math.round(Math.min(limits.max, room, Math.max(limits.min, wanted)));
    }

    /**
     * 栏宽拖拽把手：贴在这条栏的内侧边缘上，收起时也留着——拖一下即展开。
     * 指针事件挂在 window 上而不是靠 setPointerCapture：收起状态下拖第一下会把把手
     * 从窄轨搬进展开的栏里，元素一换，捕获就断了。
     */
    function PaneHandle({ side, base, value, collapsed, style, onResize, onReset, onExpand }) {
      const [dragging, setDragging] = useState(false);
      const origin = useRef({ x: 0, w: 0 });
      const limits = PANE_LIMITS[side];

      useEffect(() => {
        if (!dragging) return undefined;
        const move = (event) => {
          const delta = event.clientX - origin.current.x;
          onResize(origin.current.w + (side === 'left' ? delta : -delta));
        };
        const up = () => setDragging(false);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        document.body.style.userSelect = 'none';
        return () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          document.body.style.userSelect = '';
        };
      }, [dragging, side, onResize]);

      const start = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        // 收起时从**存下来的宽度**起拖，不是从 0：这样「拖一下即展开」不会先跳成最窄
        origin.current = { x: event.clientX, w: collapsed ? base : value };
        setDragging(true);
        if (collapsed) onExpand();
      };

      const key = (event) => {
        const step = event.shiftKey ? 32 : 12;
        const toward = side === 'left' ? 1 : -1;   // 这个方向算「变宽」
        const from = collapsed ? base : value;
        const widen = (delta) => { if (collapsed) onExpand(); onResize(from + delta); };
        if (event.key === 'ArrowLeft') { widen(step * -toward); event.preventDefault(); }
        else if (event.key === 'ArrowRight') { widen(step * toward); event.preventDefault(); }
        else if (event.key === 'Enter' || event.key === ' ') { onExpand(); event.preventDefault(); }
        else if (event.key === 'Home') { onReset(); event.preventDefault(); }
      };

      return h('div.smb-panehandle', {
        role: 'separator', 'aria-orientation': 'vertical', tabIndex: 0,
        'data-side': side, 'data-dragging': dragging ? '1' : '0',
        'aria-label': (side === 'left' ? '左栏' : '右栏') + '宽度',
        'aria-valuenow': Math.round(collapsed ? base : value),
        'aria-valuemin': limits.min, 'aria-valuemax': limits.max,
        title: '拖动改宽 · 双击回默认 · 收起时拖一下即展开',
        style,
        onPointerDown: start,
        onDoubleClick: onReset,
        onKeyDown: key,
      }, h('i', null));
    }

    /** 左栏的节点树：按依赖层分组（与科目主页那张路线图同一套分层，只是这里不带连线）。 */
    function NodeTree({ subject, node, onLesson }) {
      const byLevel = [];
      for (const item of subject.nodes) {
        if (!byLevel[item.level]) byLevel[item.level] = [];
        byLevel[item.level].push(item);
      }
      return h('div', null, byLevel.map((nodes, level) => {
        if (!nodes) return null;
        return h('div.smb-level', { key: level },
          h('div.smb-level__label', null, '第 ' + (level + 1) + ' 层'),
          nodes.map((item) => h('button.smb-node', {
            key: item.id, 'data-proto': 'tree-node',
            'aria-current': item.id === node.id ? 'true' : null,
            onClick: () => onLesson(subject, item.id),
          },
            h('i.smb-dot.smb-dot--' + item.tier),
            h('span.smb-node__no', null, item.number || '—'),
            h('span.smb-node__title', null, item.title),
            item.lesson_md ? null : h('span.smb-node__none', null, '无课件'))));
      }));
    }

    /** 参考资源折叠块：`reference/` 的清单 + RESOURCES.md 那份资料清单。 */
    function ReferenceFoldBody({ subject }) {
      const hasList = String(subject.resources_md || '').trim().length > 0;
      return h('div', null,
        h(ReferenceList, { subject, empty: '这个科目的 reference/ 还是空的。' }),
        hasList ? h('div', null,
          h('div.smb-left__title.smb-left__title--plain', { style: { marginTop: 8 } }, h('b', null, '资料清单（RESOURCES.md）')),
          h('div.smb-prose', null, h(Blocks, { blocks: parseResourceBlocks(subject.resources_md || ''), ctx: {} }))) : null);
    }

    /** 左栏本体：节点树 + 四个附件折叠块（规格 §4.1）。只在课件阅读页出现。 */
    function LessonNav({ subject, node, onLesson }) {
      const terms = (subject.glossary || []).reduce((n, group) => n + group.terms.length, 0);
      const resources = (subject.reference || []).length
        + String(subject.resources_md || '').split('\n').filter((line) => line.trim().startsWith('- ')).length;
      const done = subject.stats['已学完'] || 0;
      const total = subject.nodes.length;
      const [fold, setFold] = useState({ glossary: false, resources: false, records: false, mis: false });
      const toggle = (key) => setFold((prev) => Object.assign({}, prev, { [key]: !prev[key] }));

      return h(React.Fragment, null,
        h('div.smb-left__head', null,
          h('b', null, subject.name),
          h('span.smb-spacer'),
          h('span.smb-meta', null, total + ' 节点')),
        h('div.smb-left__body', null,
          h('div.smb-left__title', null, h('b', null, '节点')),
          h(NodeTree, { subject, node, onLesson }),
          h('div.smb-left__title', { style: { marginTop: 12 } }, h('b', null, '附在科目上的东西')),
          h(Fold, { title: '术语表', count: terms, open: fold.glossary, onToggle: () => toggle('glossary') },
            h(GlossaryBody, { groups: subject.glossary || [] })),
          h(Fold, { title: '参考资源', count: resources, open: fold.resources, onToggle: () => toggle('resources') },
            h(ReferenceFoldBody, { subject })),
          h(Fold, { title: '学习记录', count: (subject.records || []).length, open: fold.records, onToggle: () => toggle('records') },
            h(RecordsBody, { records: subject.records || [] })),
          h(Fold, { title: '误解记录', count: (subject.misconceptions || []).length, open: fold.mis, onToggle: () => toggle('mis') },
            h(MisconceptionBody, { items: subject.misconceptions || [] }))),
        h('div.smb-left__foot', null,
          (subject.status || '进行中') + ' · ' + done + '/' + total + ' 已学完'));
    }

    /**
     * 第三级 · 课件阅读页（**三栏**）。规格 §4.1：
     * 左导航 / 中正文 / 右检查器，左右栏**默认收起**——读正文时不该被抢宽度，
     * 收起时各留一条窄轨，点一下就滑出来；正文里的题目标记直接展开右栏并定位。
     */
    function LessonPage({ subject, node, lesson, attempts, record, onLesson, onSelection, selection, widths, onResizePane }) {
      const [activeSection, setActiveSection] = useState(0);
      const [wantLeft, setWantLeft] = useState(false);
      const [wantRight, setWantRight] = useState(false);
      const [tab, setTab] = useState('题目');
      const [focus, setFocus] = useState(null);
      const [askTick, setAskTick] = useState(0);
      const bodyRef = useRef(null);
      const frameRef = useRef(null);
      // 先拿视口宽当第一猜，ResizeObserver 量到真画布后立刻纠正——不然首帧两条栏会闪一下
      const [frame, setFrame] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth));

      useEffect(() => {
        const root = frameRef.current;
        if (!root) return undefined;
        const measure = () => setFrame(root.getBoundingClientRect().width);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(root);
        return () => observer.disconnect();
      }, []);

      useEffect(() => {
        const root = bodyRef.current;
        if (!root || !lesson) return undefined;
        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) if (entry.isIntersecting) setActiveSection(Number(entry.target.dataset.section) || 0);
        }, { root: null, rootMargin: '-70px 0px -70% 0px', threshold: 0 });
        for (const el of root.querySelectorAll('[data-section]')) observer.observe(el);
        return () => observer.disconnect();
      }, [lesson, node]);

      useEffect(() => {
        const onUp = () => {
          const sel = window.getSelection();
          const text = sel ? String(sel).trim() : '';
          onSelection(text.length >= 4 && bodyRef.current && sel.anchorNode && bodyRef.current.contains(sel.anchorNode) ? text : '');
        };
        document.addEventListener('mouseup', onUp);
        return () => document.removeEventListener('mouseup', onUp);
      }, [onSelection]);

      // 存下来的宽度 → 实际宽度（装不下就收起）；want* 是学生的意图，不因画布变化被改掉
      const fit = fitPanes(frame, { left: wantLeft, right: wantRight }, widths);
      const leftWidth = fit.left;
      const rightWidth = fit.right;
      const leftOpen = leftWidth > 0;
      const rightOpen = rightWidth > 0;
      const resize = useCallback((side, wanted) => {
        onResizePane(side, clampPane(side, wanted, frame, side === 'left' ? rightWidth : leftWidth));
      }, [frame, leftWidth, rightWidth, onResizePane]);
      const reset = useCallback((side) => onResizePane(side, PANE_LIMITS[side].fallback), [onResizePane]);

      const groups = useMemo(() => (node.anchors || []).map((anchor, index) => ({
        index, anchor,
        questions: (anchor.resolution || 'missing') === 'resolved' ? (node.pool[anchor.keys[0]] || []) : [],
      })), [node]);
      const total = groups.reduce((n, group) => n + group.questions.length, 0);
      let answered = 0;
      attempts.forEach((value, key) => { if (key.indexOf(node.id + '|') === 0) answered++; });

      // 同一个 tab 再点一次就收起——收起是默认态，来回切不用找按钮
      const openTab = (name) => {
        if (wantRight && tab === name) { setWantRight(false); return; }
        setTab(name);
        setWantRight(true);
      };
      const openQuestion = (index) => { setTab('题目'); setWantRight(true); setFocus({ index }); };

      const index = subject.nodes.findIndex((n) => n.id === node.id);
      const prev = subject.nodes[index - 1];
      const next = subject.nodes[index + 1];
      const ctx = { subject, node, assetBase: '', renderAnchor: null };
      const markerCtx = Object.assign({}, ctx, {
        renderAnchor: (block) => {
          const group = groups[block.quizIndex] || { questions: [] };
          return h(QuizMarker, {
            anchor: group.anchor || { text: block.anchor, resolution: 'missing', keys: [], level: block.level },
            index: block.quizIndex, count: group.questions.length, onOpen: openQuestion,
          });
        },
      });
      const askOpen = rightOpen && tab === '问答';

      return h('div.smb-lesson', { ref: frameRef, 'data-left': leftOpen ? '1' : '0', 'data-right': rightOpen ? '1' : '0' },
        h('div.smb-railbar', null,
          h('button.smb-rail', {
            'data-proto': 'toggle-left', 'aria-expanded': leftOpen ? 'true' : 'false',
            title: leftOpen ? '收起节点树' : '展开节点树', onClick: () => setWantLeft((v) => !v),
          }, h('span.smb-rail__ico', { 'aria-hidden': 'true' }, '☰'), h('span.smb-rail__label', null, '节点'))),

        leftOpen ? h('aside.smb-left', { style: { width: leftWidth + 'px' } },
          h(LessonNav, { subject, node, onLesson })) : null,

        // 把手贴在每条栏的内侧边缘；收起时留在窄轨边上，拖一下即展开（规格 §4.4）
        h(PaneHandle, {
          side: 'left', base: widths.left, value: leftWidth, collapsed: !leftOpen,
          style: { left: (38 + leftWidth - 3) + 'px' },
          onResize: (next) => resize('left', next), onReset: () => reset('left'), onExpand: () => setWantLeft(true),
        }),

        h('div.smb-center', null,
          h('div.smb-center__head', null,
            h('span.smb-center__no', null, '第 ' + (node.number || '?') + ' 课'),
            h('span.smb-center__name', null, node.title),
            h('span.smb-chip.smb-chip--kind', null, node.kind),
            h('span.smb-chip.smb-chip--' + node.tier, { title: '旧词表：' + node.raw_status },
              h('i.smb-dot.smb-dot--' + node.tier), node.tier),
            node.lab ? h('span.smb-chip', null, 'lab') : null,
            h('span.smb-spacer'),
            h('span.smb-meta', null, '作答 ' + answered + '/' + total)),
          h('div.smb-center__body', { ref: bodyRef },
            h('div.smb-secsbar', null,
              h('nav.smb-secs', { 'aria-label': '本节目录' }, lesson.sections.map((section) => h('button.smb-sec', {
                key: section.id, 'aria-current': section.index === activeSection ? 'true' : 'false',
                onClick: () => {
                  const el = document.getElementById(section.id);
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                },
              }, section.title)))),

            h('article.smb-doc', null,
              h('header.smb-doc__head', null,
                h('p.smb-hero__eyebrow', null, subject.name + ' · 第 ' + (node.number || '?') + ' 课'),
                h('h1', null, node.title),
                node.objective ? h('p.smb-goal', null, h('b', null, '本节目标：'), inlineNodes(node.objective, 'goal')) : null),
              lesson.sections.map((section) => h('section.smb-sec-block', { key: section.id, id: section.id, 'data-section': section.index },
                h('h2', null, section.title),
                h(Blocks, { blocks: section.blocks, ctx: markerCtx }))),
              node.lab ? h('section.smb-note.smb-note--brand', null,
                h('div', null,
                  h('b', null, '这一课的 lab · ' + node.lab.dir),
                  h('div', null, (node.lab.readme || '').split('\n').filter((l) => l.trim() && !l.startsWith('#'))[0] || ''),
                  h('div.smb-labfiles', null, node.lab.files.map((file, i) => h('code', { key: i }, file))),
                  h('div.smb-meta', null, '实操题的判分由 Host 半代跑你本地的测试命令，输出原样记进作答数据（还没实现）。'))) : null,
              h('nav.smb-navfoot', null,
                prev ? h('button.smb-btn', { onClick: () => onLesson(subject, prev.id) }, '← ' + prev.title) : h('span'),
                next ? h('button.smb-btn', { onClick: () => onLesson(subject, next.id) }, next.title + ' →') : h('span.smb-meta', null, '这是最后一个节点'))),

            selection && !askOpen ? h('button.smb-askchip', {
              'data-proto': 'qa-chip',
              onClick: () => { setAskTick((tick) => tick + 1); openTab('问答'); },
            }, '就这段问一句') : null)),

        rightOpen ? h('aside.smb-right', { style: { width: rightWidth + 'px' } }, h(Inspector, {
          tab, onTab: (name) => { setTab(name); }, node, subject, groups, total, answered,
          attempts, record, focus, selection, askTick,
        })) : null,

        h(PaneHandle, {
          side: 'right', base: widths.right, value: rightWidth, collapsed: !rightOpen,
          style: { right: (38 + rightWidth - 3) + 'px' },
          onResize: (next) => resize('right', next), onReset: () => reset('right'), onExpand: () => setWantRight(true),
        }),

        h('div.smb-railbar.smb-railbar--right', null,
          h('button.smb-rail', {
            'data-proto': 'toggle-quiz', 'aria-expanded': rightOpen && tab === '题目' ? 'true' : 'false',
            title: '题目', onClick: () => openTab('题目'),
          }, h('span.smb-rail__ico', { 'aria-hidden': 'true' }, '≡'), h('span.smb-rail__label', null, '题目'),
            total ? h('span.smb-rail__count', null, String(total)) : null),
          h('button.smb-rail', {
            'data-proto': 'toggle-ask', 'aria-expanded': askOpen ? 'true' : 'false',
            title: '问答', onClick: () => openTab('问答'),
          }, h('span.smb-rail__ico', { 'aria-hidden': 'true' }, '？'), h('span.smb-rail__label', null, '问答'))));
    }

    /**
     * 节点还没有课件内容文件：别把学生弹回主页，就地说明并给一条回去的路。
     * 这一屏**不进三栏壳**——没有正文可读，左右栏也就没有内容可放。
     */
    function MissingLesson({ subject, node, onSubject }) {
      return h('div.smb-wrap', null,
        h('button.smb-crumb', { onClick: () => onSubject(subject) }, '← ' + subject.name),
        h('header.smb-doc__head', null,
          h('p.smb-hero__eyebrow', null, subject.name + ' · 第 ' + (node.number || '?') + ' 课'),
          h('h1', null, node.title),
          h('div.smb-doc__chips', null,
            h('span.smb-chip.smb-chip--kind', null, node.kind),
            h('span.smb-chip.smb-chip--' + node.tier, null, h('i.smb-dot.smb-dot--' + node.tier), node.tier))),
        h('div.smb-empty', null, '这个节点还没有课件内容文件。'),
        node.objective ? h('p.smb-goal', null, h('b', null, '本节目标：'), inlineNodes(node.objective, 'mg')) : null,
        node.notes ? h('div.smb-note', null, h('div', null, h('b', null, '进度笔记'), h('div', null, node.notes))) : null);
    }

    /* ── 常驻：搜索 + 问答面板 ─────────────────────────────────────────────── */

    const KIND_ORDER = ['正文', '题目', '术语', '大纲', '学习记录', '误解'];
    /* 面板空态里那句话与上面这张表同源：类目改了、这里跟着改，不再两处各写一遍。
       `大纲` 在界面上叫「节点元信息」（规格 §4.5 第 5 条的说法），只有它换了叫法。 */
    const KIND_LABEL = { 大纲: '节点元信息' };
    const KIND_LIST_TEXT = KIND_ORDER.map((kind) => KIND_LABEL[kind] || kind).join('、');
    const stripMd = (text) => String(text).replace(/\*\*/g, '').replace(/`/g, '').replace(/\$/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    /** 折行、缩进、多余空白都压成一个空格：同一段话的两种排法该算同一条命中。 */
    const oneLine = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();

    /* ═══════════════════════════════════════════════════════════════════════
       跨科目搜索的索引（规格 §4.5）
       覆盖五类：课件正文、题库、术语表、学习记录与误解记录、大纲节点元信息。

       两条不变量，改这里之前先看：
         · **不落盘**：索引是派生物，每次打开面板就地重建（丢失随时重来，绝不成为第二份真相）。
         · **纯**：`buildIndex` 与它下面这组 `*Fragments` 一个 React、一个网络调用都不碰——
           这样它才可单测（`scripts/tests/test_client_search_index.mjs`）。
       ═══════════════════════════════════════════════════════════════════════ */

    /**
     * 正文里一个块 → 可搜的片段（`{ text, label }`），label 是「这条命中在哪」。
     *
     * 为什么逐类补而不是「把整个块 JSON.stringify 一遍」：搜索要能说清命中的是哪一块，
     * 而且代码块/表格里的标点会污染关键词。这里逐类取真正印在页面上的字。
     * 覆盖 #78 点名的六类（列表 / 表格 / 围栏 / 引用 / 提示块 / 配图题注）+ 三级小标题、
     * 公式、练习块、resources / related。
     */
    function blockFragments(block, where) {
      const label = where || '';
      switch (block.type) {
        case 'heading': return [{ text: block.text, label }];
        case 'para': return [{ text: block.text, label }];
        case 'quote': return [{ text: block.text, label }];
        // 块级公式：索引 LaTeX 原文（`\frac` 这类关键词搜得到），$$ 定界符不算内容
        case 'math': return [{ text: block.tex, label }];
        case 'list': return block.items.map((item) => ({ text: item, label }));
        // 围栏：连语言名一起进检索串，`bash` / `java` 这类词因此搜得到（值本身仍是代码）
        case 'code': return [{ text: block.code, label, search: (block.lang || '') + ' ' + (block.term ? '运行结果' : '') }];
        case 'table': {
          const head = (block.head || []).join(' ');
          const rows = (block.rows || []).map((row) => row.join(' '));
          return (head ? [head] : []).concat(rows).map((text) => ({ text, label }));
        }
        /* 配图：题注是 #78 点名要的；没有题注时退到 alt——配图总得有个能搜到的说法。
           `图 N` 只进检索串，不冒充题注。 */
        case 'figure': {
          const caption = oneLine(block.caption);
          return [{
            text: caption || oneLine(block.alt),
            label,
            search: [block.figureNo ? '图 ' + block.figureNo : '', oneLine(block.alt)].filter(Boolean).join(' '),
          }];
        }
        // 提示块：标题（tip/warn/note 那行）+ 块里嵌套的正文，各自成条
        case 'callout': return [{ text: block.title, label }]
          .concat(nestedFragments(block.blocks, label));
        // 练习块：题目名 + 块里嵌套的正文（练习说明往往就是最该搜到的那句话）
        case 'practice': return [{ text: block.title || block.kind, label: block.kind || label }]
          .concat(nestedFragments(block.blocks, label));
        // 参考资源 / 相关：`- 标题 | 说明`，说明进 label，链接不进（搜 URL 没意义）
        case 'resources':
        case 'related':
          return (block.items || []).map((item) => ({ text: item.text, label: item.note ? label + ' · ' + item.note : label }));
        /* 锚点标记（`::: quiz`）本身不是正文，题干走题库那一类，这里不重复索引。
           来源见 `lib/core/anchors.ts`：正文锚点与题库键的对账是纯函数域的事。 */
        case 'quiz': return [];
        // 阅读端还不认识的指令：块里剩下的原文照索引，别让内容静默搜不到
        default: return block.text ? [{ text: block.text, label }] : [];
      }
    }

    /** 容器块（提示块 / 练习块）里嵌套的正文：递归下去，标签沿用外层的。 */
    function nestedFragments(blocks, label) {
      const out = [];
      for (const inner of blocks || []) {
        for (const fragment of blockFragments(inner, label)) out.push(fragment);
      }
      return out;
    }

    /** 一份课件的全部正文片段：小节标题（h2）逐条，加上每个小节里的块。 */
    function lessonFragments(markdown) {
      const out = [];
      const lesson = parseLesson(markdown);
      for (const section of lesson.sections) {
        out.push({ text: section.title, label: '' });
        for (const block of section.blocks) {
          for (const fragment of blockFragments(block, section.title)) out.push(fragment);
        }
      }
      return out;
    }

    /**
     * 一个科目的索引条目。**去重键含科目与节点**——同名内容在另一门课里是另一条。
     *
     * 为什么非要这样：键里不含 subject/node 时（今天的写法），两门课里同样一句话只留先到的那条，
     * 点它就 `goLesson(错科目, 错节点)`——搜索把人送去错的科目。同名小节标题（「小结」）同理。
     */
    function buildIndex(subjects) {
      const hits = [];
      const seen = new Set();
      const push = (hit) => {
        if (!hit.text) return;
        const key = [hit.subject ? hit.subject.slug : '', hit.node ? hit.node.id : '', hit.kind, hit.text].join('\u0000');
        if (seen.has(key)) return;
        seen.add(key);
        // 检索串 = 文本 + 位置 + 这一条特有的补充词（语言名 / 图号 / alt）
        hit.search = [hit.text, hit.label || '', hit.search || ''].join(' ').toLowerCase();
        hits.push(hit);
      };
      for (const subject of subjects) {
        for (const node of subject.nodes || []) {
          const it = (kind, text, extra) => push(Object.assign({ kind, text: oneLine(stripMd(text)), subject, node }, extra));
          it('大纲', node.title);
          it('大纲', node.objective, { label: '目标' });
          it('大纲', node.problem, { label: '问题' });
          for (const pitfall of node.pitfalls || []) it('大纲', pitfall, { label: '坑' });
          for (const list of Object.values(node.pool || {})) {
            for (const item of list) {
              it('题目', item.q);
              for (const opt of (item.opts || [])) it('题目', opt, { label: '选项' });
            }
          }
          if (node.lesson_md) {
            for (const fragment of lessonFragments(node.lesson_md)) {
              push({
                kind: '正文', text: oneLine(stripMd(fragment.text)),
                label: fragment.label, search: fragment.search, subject, node,
              });
            }
          }
        }
        for (const group of subject.glossary || []) {
          // 分组标题（「待掌握」/「已掌握」）也算术语表的一部分：它是学生找词时的入口之一
          if (group.title) push({ kind: '术语', text: oneLine(stripMd(group.title)), label: '术语分组', subject, node: null });
          for (const term of group.terms) {
            /* 规范叫法与别名都要能搜到：`text` 放规范叫法，别名并进 `label`。
               别改回「两个 push、text 都是 term.term」——那样的去重键完全相同，
               第二次 push 必然被吃掉，别名一个字都搜不到（曾是这样）。 */
            const aliases = oneLine(term.avoid);
            push({
              kind: '术语',
              text: oneLine(term.term),
              label: (aliases ? '别名：' + aliases + '。' : '') + oneLine(stripMd(term.def)),
              subject, node: null,
            });
          }
        }
        for (const record of subject.records || []) {
          /* 学习记录的**正文**也要进索引（#78 点名）。`markdown` 是整份记录原文，
             标题/日期只回答「哪一天记的」，正文才回答「当时学了什么」。
             开头那行一级标题单独成条，别让它把「一条记录算成两条命中」。 */
          const source = String(record.markdown || '');
          const heading = /^[ \t]*#[ \t]+(.*)$/m.exec(source);
          const bodyMd = heading ? source.slice(0, heading.index) + source.slice(heading.index + heading[0].length) : source;
          push({ kind: '学习记录', text: oneLine(stripMd(bodyMd)), label: record.date, subject, node: null });
          push({ kind: '学习记录', text: oneLine(stripMd(heading ? heading[1] : '')) || record.title, label: record.date, subject, node: null });
        }
        for (const item of subject.misconceptions || []) {
          /* 误解记录的字段定型见 schemas/misconceptions.schema.json（topic / source / evidence /
             status / at）。索引 `topic` + `evidence`（证据：提问原文或作答引用）+
             旧字段里的「当时怎么解的」（`legacy.answer_summary` / `legacy.misunderstanding`）。 */
          push({ kind: '误解', text: oneLine(stripMd(item.topic)), label: oneLine(item.evidence), subject, node: null });
          const legacy = item.legacy || {};
          const answer = oneLine(legacy.answer_summary || legacy.misunderstanding);
          if (answer) push({ kind: '误解', text: oneLine(stripMd(answer)), label: oneLine(stripMd(item.topic)), subject, node: null });
        }
      }
      return hits;
    }

    function SearchPalette({ subjects, onClose, onPick }) {
      const [query, setQuery] = useState('');
      const index = useMemo(() => buildIndex(subjects), [subjects]);
      const inputRef = useRef(null);
      useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

      const results = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        return index.filter((hit) => hit.search.includes(q))
          .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
          .slice(0, 60);
      }, [index, query]);

      return h('div.smb-palette', { onClick: onClose },
        h('div.smb-palette__box', { onClick: (event) => event.stopPropagation() },
          h('div.smb-palette__input', null,
            h('span.smb-meta', null, '搜索'),
            h('input', {
              ref: inputRef, value: query, placeholder: KIND_LIST_TEXT + '…',
              onChange: (event) => setQuery(event.target.value),
            }),
            h('span.smb-kbd', null, 'Esc')),
          h('div.smb-palette__list', null,
            query.trim() === '' ? h('div.smb-empty', null, '输入关键词，跨科目搜五类内容（' + KIND_LIST_TEXT + '）。')
              : results.length === 0 ? h('div.smb-empty', null, '没搜到「' + query + '」。')
                : h(React.Fragment, null,
                  h('div.smb-meta', { style: { padding: '2px 10px' } }, results.length + ' 条命中'),
                  results.map((hit, i) => h('button.smb-hit', { key: i, onClick: () => onPick(hit) },
                    h('span.smb-hit__kind', null, KIND_LABEL[hit.kind] || hit.kind),
                    h('span.smb-hit__text', null, hit.text.length > 96 ? hit.text.slice(0, 96) + '…' : hit.text),
                    hit.label ? h('span.smb-hit__where', null, hit.label) : null))))));
    }

    /**
     * 「问答」tab 的主体（规格 §4.1：右栏两个 tab 之一，§7.4：面板独立调模型）。
     * 原来是浮层，现在归右栏——选中正文起问时右栏滑出，就地回答。
     * `focusTick` 每次从正文发起提问都加一，用来把光标送进输入框。
     *
     * 这条路的上下文边界是**规格钉死的**：只带当前课件、选中的这段与共享记忆（服务端
     * `lib/core/ask.ts` 组装，面板一个字的会话都不带）。回答无痕——它不进会话记录，也不落
     * 任何文件；落盘的只有那条误解记录（`misconceptions.yaml`）。
     */
    function AskPanel({ subject, node, selection, focusTick }) {
      const [question, setQuestion] = useState('');
      const [result, setResult] = useState(null);
      const [busy, setBusy] = useState(false);
      const inputRef = useRef(null);

      useEffect(() => { if (focusTick && inputRef.current) inputRef.current.focus(); }, [focusTick]);

      const ask = async () => {
        const text = question.trim();
        if (!text || busy) return;
        setBusy(true);
        setResult(null);
        try {
          const response = await fetch(ASK_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              subject: subject.slug,
              node: node.id,
              selection: selection || '',
              question: text,
              // 幂等键：双击与超时重试不会在误解记录里留下两条（Host 半的台账按它回放）
              operationId: 'ask-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10),
              // 面板只带得出「第一次读到的版本号」——这份快照之后可能被总控改过。
              // 服务端只在校不上时报一声（写盘照做），所以过期的版本号不会把记录挡掉。
              expectedVersion: subject.misconception_version || '',
            }),
          });
          const payload = await response.json().catch(() => null);
          setResult(payload || { available: true, ok: false, error: { message: 'HTTP ' + response.status } });
        } catch (error) {
          setResult({ available: true, ok: false, error: { message: '连不上面板那条路由：' + String((error && error.message) || error) } });
        } finally {
          setBusy(false);
        }
      };

      const chip = result === null ? null
        : result.available === false ? h('span.smb-chip.smb-chip--warn', null, '没有可用模型')
          : result.ok ? h('span.smb-chip', null, '模型 ' + ((result.model && result.model.model) || '未知'))
            : h('span.smb-chip.smb-chip--warn', null, '这次没答上来');

      return h('div.smb-askbody', null,
        h('div.smb-ask__head', null,
          h('b', null, '问答面板'),
          chip),
        selection ? h('blockquote.smb-quote', null, selection) : h('p.smb-block__hint', null, '在正文里划一段（四个字以上），这里就会带上它。'),
        h('p.smb-block__hint', null, '面板只带当前课件、选中的这段与共享记忆，就地回答，不经过总控。回答不进会话记录。'),
        h('textarea.smb-ta', {
          rows: 3, placeholder: '哪里不懂？', value: question, 'data-proto': 'qa-input', ref: inputRef,
          onChange: (event) => setQuestion(event.target.value),
        }),
        h('div.smb-btnrow', null,
          h('button.smb-btn.smb-btn--primary', { disabled: busy || !question.trim(), 'data-proto': 'qa-ask', onClick: ask }, busy ? '正在问…' : '问一句')),

        // 没有可用模型时如实说明，不假装会答（`available:false` 与工具那条路同一个形状）
        result && result.available === false ? h('div.smb-note.smb-note--warn', null, h('div', null,
          h('b', null, '这条链路上没有可用的模型'),
          h('div', null, result.reason || (result.error && result.error.message) || '宿主的模型服务或 provider 不在。'),
          h('div.smb-meta', null, '面板不假装会答：这一问没有回答，也就没有写误解记录。配好模型再问一次。'))) : null,

        result && result.ok ? h('div', null,
          h('p', null, result.answer),
          // 只有**真的写进去了**才说「已记」：写盘失败时下面那条警告会说明，别两句话打架
          result.misconception && result.write && result.write.ok ? h('div.smb-note', null, h('div', null,
            h('b', null, '已记一条误解记录'),
            h('div', null, 'topic「' + result.misconception.topic + '」· source ' + result.misconception.source
              + ' · status ' + result.misconception.status + ' · at ' + result.misconception.at
              + '——总控下次开场读得到。'),
            h('div.smb-meta', null, '回答本身不进会话记录、不落文件；落盘的只有这一条记录（misconceptions.yaml）。'))) : null,
          result.write && result.write.ok === false ? h('div.smb-note.smb-note--warn', null, h('div', null,
            h('b', null, '回答拿到了，但误解记录没写进去'),
            h('div', null, result.write.message || result.write.error || '写盘失败'),
            h('div.smb-meta', null, '这条记录下次开场读不到；回答本身没受影响。'))) : null) : null,

        result && result.available !== false && !result.ok ? h('div.smb-note.smb-note--warn', null, h('div', null,
          h('b', null, '这次没答上来'),
          h('div', null, (result.error && result.error.message) || '模型没有返回正文。'),
          h('div.smb-meta', null, '没有回答就没有「回答摘要」，所以这次没有写误解记录。'))) : null);
    }

    /* ── 外壳：顶栏 + 三级 ─────────────────────────────────────────────────── */

    function TopBar({ view, subject, node, onHome, onSubject, onSearch }) {
      return h('header.smb-topbar', null,
        h('button.smb-brand', { onClick: onHome, title: '回主页' },
          h('span.smb-brand__mark', null, '学'),
          h('span.smb-brand__name', null, 'StudyMate')),
        h('nav.smb-crumbs', { 'aria-label': '位置' },
          h('button.smb-crumb', { 'aria-current': view === 'home' ? 'page' : null, onClick: onHome }, '主页'),
          subject ? h('span.smb-crumbs__sep', null, '/') : null,
          subject ? h('button.smb-crumb', {
            'aria-current': view === 'subject' ? 'page' : null,
            onClick: () => onSubject(subject),
          }, subject.name) : null,
          subject && node ? h('span.smb-crumbs__sep', null, '/') : null,
          subject && node ? h('span.smb-crumb.smb-crumb--current', null, node.title) : null),
        h('span.smb-spacer'),
        h('button.smb-searchbtn', { onClick: onSearch, title: '搜索（⌘K）' }, '搜索', h('span.smb-kbd', null, '⌘K')));
    }

    function StudyMateApp() {
      const [library, load] = useLibrary();
      const reload = useRefresh(load);
      // 栏宽住在最外层：换科目、换层级都不变（规格 §4.4「宽度全局各记一份」）
      const [paneWidths, resizePane] = usePaneWidths();
      const [view, setView] = useState('home');
      const [slug, setSlug] = useState('');
      const [nodeId, setNodeId] = useState('');
      const [selection, setSelection] = useState('');
      const [paletteOpen, setPaletteOpen] = useState(false);
      const [attempts, setAttempts] = useState(() => new Map());

      const subjects = (library.data && library.data.subjects) || [];
      const subject = subjects.find((s) => s.slug === slug) || null;
      const node = subject ? (subject.nodes.find((n) => n.id === nodeId) || null) : null;
      const lesson = useMemo(() => (node && node.lesson_md ? parseLesson(node.lesson_md) : null), [node]);
      const reading = view === 'lesson' && subject && node && lesson;

      useEffect(() => {
        if (!slug && subjects[0]) setSlug(subjects[0].slug);
      }, [subjects, slug]);

      useEffect(() => {
        const onKey = (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            setPaletteOpen((open) => !open);
          } else if (event.key === 'Escape') setPaletteOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);

      const record = useCallback((key, patch) => {
        setAttempts((prev) => {
          const next = new Map(prev);
          next.set(key, Object.assign({ at: '刚刚' }, prev.get(key), patch));
          return next;
        });
      }, []);

      // 进课件页时把盘上的作答数据读进内存：payload 的 node.attempts.questions 是
      // attempts/<NNNN>-<节点id>.json 的「题」那一层，键就是这里的 stateKey
      // （<节点id>|<锚点>|<题号>）。**只读**——状态只服务当场回顾（「上次你选了 B」），
      // 不做汇总视图、不排期、不算复习队列（目标态规格 §5.3）。
      useEffect(() => {
        if (!node || !node.attempts) return;
        const questions = node.attempts.questions || {};
        const restored = new Map();
        for (const [id, one] of Object.entries(questions)) {
          const last = (one && one['上次结果']) || {};
          const anchorAndIndex = id.split('#');
          const qi = anchorAndIndex.pop();
          const anchor = anchorAndIndex.join('#');
          restored.set(node.id + '|' + anchor + '|' + qi, {
            at: last['时'] || '',
            chosen: typeof last['选'] === 'number' ? last['选'] : null,
            correct: last['对'] === true,
            self: last['自评'],
            reason: last['错因'],
          });
        }
        setAttempts((prev) => {
          const next = new Map(restored);
          // 本次会话里已经答过的（record 写进去的）优先：别被一次后台重读覆盖掉
          prev.forEach((value, key) => next.set(key, value));
          return next;
        });
      }, [node && node.id, node && node.attempts && node.attempts.version]);

      // 上屏后回到顶部：三级是「每一级一屏」，从课件退回科目主页还停在正文中间会很怪。
      // 课件页三栏各有各的滚动区，这个 ref 只管单栏那两级（挂在 .smb-scroll 上）。
      const scroller = useRef(null);
      useEffect(() => {
        if (scroller.current) scroller.current.scrollTop = 0;
        setSelection('');
      }, [view, slug, nodeId]);

      const goHome = () => setView('home');
      const goSubject = (next) => { setSlug(next.slug); setNodeId(''); setView('subject'); };
      const goLesson = (nextSubject, id) => { setSlug(nextSubject.slug); setNodeId(id); setView('lesson'); };

      if (library.status === 'loading') {
        return h('div.smb-root', null, h('div.smb-empty', null, '正在读学习工作区…'));
      }
      if (library.status === 'error') {
        return h('div.smb-root', null,
          h('div.smb-empty', null,
            h('div', { style: { fontWeight: 600, marginBottom: 6, color: 'var(--smb-text)' } }, '读不到学习工作区'),
            h('div', null, library.error),
            h('button.smb-btn', { style: { marginTop: 12 }, onClick: () => load(false) }, '重试')));
      }
      if (!subjects.length) {
        return h('div.smb-root', null,
          h('div.smb-empty', null,
            '这个学习工作区里还没有科目。',
            h('div.smb-meta', { style: { marginTop: 6 } }, library.data.workspace)));
      }

      return h('div.smb-root', null,
        h(TopBar, { view, subject, node, onHome: goHome, onSubject: goSubject, onSearch: () => setPaletteOpen(true) }),
        // 壳分层级（规格 §4.1）：主页与科目主页**单栏**（这条 .smb-scroll 就是唯一滚动区），
        // 课件阅读页**三栏**，左右栏由 LessonPage 自己管、默认收起——所以它不套 .smb-scroll。
        reading
          ? h(LessonPage, {
            subject, node, lesson, attempts, record,
            onLesson: goLesson, onSelection: setSelection, selection,
            widths: paneWidths, onResizePane: resizePane,
          })
          : h('div.smb-scroll', { ref: scroller },
            view === 'lesson' && subject && node
              ? h(MissingLesson, { subject, node, onSubject: goSubject })
              : view === 'subject' && subject
                ? h(SubjectPage, { subject, onLesson: goLesson, onRefresh: reload })
                : h(HomePage, { subjects, onSubject: goSubject, onLesson: goLesson })),
        paletteOpen ? h(SearchPalette, {
          subjects,
          onClose: () => setPaletteOpen(false),
          onPick: (hit) => {
            setPaletteOpen(false);
            if (hit.node && hit.subject) goLesson(hit.subject, hit.node.id);
            else if (hit.subject) goSubject(hit.subject);
          },
        }) : null);
    }

    function Fold({ title, count, open, onToggle, children }) {
      return h('div', { className: 'smb-fold' },
        h('button', { className: 'smb-fold__head', onClick: onToggle },
          title, h('span', { className: 'smb-fold__count' }, String(count))),
        open ? h('div', { className: 'smb-fold__body' }, children) : null);
    }

    /* 四个附件折叠块（术语表 / 参考资源 / 学习记录 / 误解记录）**都要有空态**：
       空目录不是错误，但展开一片空白等于什么都没说——#78 的验收就卡在这条上，
       而术语表曾是四个块里唯一漏掉空态的（其余三块的空文案见 ReferenceFoldBody /
       RecordsBody / MisconceptionBody）。 */
    function GlossaryBody({ groups }) {
      const filled = (groups || []).filter((group) => (group.terms || []).length > 0);
      if (filled.length === 0) return h('div', { className: 'smb-meta' }, '这个科目的 GLOSSARY.md 里还没有词条。');
      return filled.map((group, gi) => h('div', { key: gi },
        h('div', { className: 'smb-left__title' }, h('b', null, group.title)),
        group.terms.map((term, ti) => h('div', { className: 'smb-term', key: ti },
          h('b', null, term.term),
          h('p', null, term.def),
          term.avoid ? h('i', null, '别叫：' + term.avoid) : null))));
    }

    /* 误解记录：字段定型见 schemas/misconceptions.schema.json（topic / source / evidence / status / at）。
       旧文件里的 question / answer_summary / misunderstanding 仍读得进——归一在
       lib/core/misconceptions.ts 做，这里只兜一层「新字段没有就退回旧字段」，别让老档案空着。
       `items` 兜一层空数组：payload 里少这一项时该走空态，而不是报「读不到」吓人。 */
    function MisconceptionBody({ items }) {
      if (!(items || []).length) return h('div', { className: 'smb-meta' }, '还没有误解记录。');
      return items.map((item, i) => h('div', { className: 'smb-mis', key: i },
        h('b', null, item.topic,
          h('span', { className: 'smb-chip' }, item.status || '未处理'),
          item.source ? h('span', { className: 'smb-chip' }, item.source) : null,
          item.legacy && item.legacy.importance === 'high' ? h('span', { className: 'smb-chip' }, '要紧') : null),
        h('p', null, item.evidence || (item.legacy && item.legacy.question) || ''),
        h('em', null, '当时怎么解的：'
          + ((item.legacy && (item.legacy.answer_summary || item.legacy.misunderstanding)) || '（没留下）')),
        item.at ? h('time', null, item.at) : null));
    }

    function RecordsBody({ records }) {
      if (!(records || []).length) return h('div', { className: 'smb-meta' }, '还没有学习记录。');
      return records.map((record, i) => h('div', { className: 'smb-rec', key: i },
        h('time', null, record.date || '—'), h('div', null, record.title)));
    }

    /** 一层依赖里的节点们。单独抽出来是因为塞进 LeftPane 会让三元与括号叠到看不清。 */

    /* ── 路线图：分层卡片 + 前置依赖连线 ─────────────────────────────────── */

    function Roadmap({ subject, onNode }) {
      const wrapRef = useRef(null);
      const [paths, setPaths] = useState([]);

      useEffect(() => {
        const root = wrapRef.current;
        if (!root || !subject) return undefined;
        const draw = () => {
          const box = root.getBoundingClientRect();
          const cards = new Map();
          for (const el of root.querySelectorAll('[data-node]')) {
            const rect = el.getBoundingClientRect();
            cards.set(el.dataset.node, {
              left: rect.left - box.left, right: rect.right - box.left,
              top: rect.top - box.top, bottom: rect.bottom - box.top,
              cx: rect.left - box.left + rect.width / 2,
            });
          }
          const next = [];
          for (const edge of subject.edges) {
            const from = cards.get(edge.from);
            const to = cards.get(edge.to);
            if (!from || !to) continue;
            const y1 = from.bottom;
            const y2 = to.top;
            const mid = (y1 + y2) / 2;
            next.push({
              key: edge.from + '->' + edge.to,
              d: 'M ' + from.cx + ' ' + y1 + ' C ' + from.cx + ' ' + mid + ', ' + to.cx + ' ' + mid + ', ' + to.cx + ' ' + y2,
            });
          }
          setPaths(next);
        };
        draw();
        const observer = new ResizeObserver(draw);
        observer.observe(root);
        return () => observer.disconnect();
      }, [subject]);

      if (!subject) return null;
      const byLevel = [];
      for (const node of subject.nodes) {
        if (!byLevel[node.level]) byLevel[node.level] = [];
        byLevel[node.level].push(node);
      }

      return h('div', { className: 'smb-map', ref: wrapRef },
        h('div', { className: 'smb-map__legend' },
          h('span', null, h('i', { className: 'smb-dot smb-dot--未开始' }), '未开始'),
          h('span', null, h('i', { className: 'smb-dot smb-dot--学习中' }), '学习中'),
          h('span', null, h('i', { className: 'smb-dot smb-dot--已学完' }), '已学完'),
          h('span', { className: 'smb-meta' }, '箭头是前置关系，从上往下读；点卡片进课件。')),
        h('svg', { className: 'smb-map__edges' }, paths.map((p) => h('path', {
          key: p.key, d: p.d, fill: 'none', stroke: 'currentColor',
          strokeOpacity: 0.28, strokeWidth: 1.4, markerEnd: 'url(#smb-arrow)',
        }))),
        h('div', { className: 'smb-map__cols' },
          byLevel.map((nodes, level) => (nodes
            ? h(RoadmapLevel, { key: level, level, nodes, subject, onNode })
            : null))),
        h('svg', { width: 0, height: 0, style: { position: 'absolute' } },
          h('defs', null, h('marker', {
            id: 'smb-arrow', viewBox: '0 0 8 8', refX: 4, refY: 7,
            markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
          }, h('path', { d: 'M0,0 L8,0 L4,8 z', fill: 'currentColor', fillOpacity: 0.35 })))));
    }

    /** 一层依赖：层名 + 这一层的卡片。 */
    function RoadmapLevel({ level, nodes, subject, onNode }) {
      return h('div', { className: 'smb-map__level' },
        h('div', { className: 'smb-map__levelname' }, '第 ' + (level + 1) + ' 层'),
        h('div', { className: 'smb-map__cards' },
          nodes.map((node) => h(RoadmapCard, { key: node.id, node, subject, onNode }))));
    }

    function RoadmapCard({ node, subject, onNode }) {
      const prerequisiteTitles = node.prerequisites
        .map((id) => (subject.nodes.find((n) => n.id === id) || {}).title)
        .filter(Boolean);
      const kindClass = node.kind === '实验' ? '实验' : node.kind === '实操' ? '实操' : '概念';
      return h('button', {
        className: 'smb-card smb-card--' + kindClass,
        'data-node': node.id,
        'data-proto': 'open-node',
        onClick: () => onNode(node.id),
      },
        h('div', { className: 'smb-card__top' },
          h('span', { className: 'smb-node__no' }, node.number || '—'),
          h('span', { className: 'smb-dot smb-dot--' + node.tier }),
          h('span', { className: 'smb-chip smb-chip--kind' }, node.kind),
          h('span', { className: 'smb-spacer' }),
          h('span', { className: 'smb-chip smb-chip--' + node.tier }, node.tier)),
        h('div', { className: 'smb-card__title' }, node.title),
        h('div', { className: 'smb-card__goal' }, inlineNodes(node.objective, 'co' + node.id)),
        h('div', { className: 'smb-card__foot' },
          h('span', null, prerequisiteTitles.length ? '前置：' + prerequisiteTitles.join(' · ') : '无前置'),
          h('span', { className: 'smb-spacer' }),
          h('span', null, node.lesson_md ? '有课件' : '无课件')));
    }


    /** 主观题的三个分支：开放题（参考答案 + 判分要点）、预测验证（先写预测再跑）、交付物（造出来 + 证据）。 */
    function SubjectiveBody({ item, kind, open, setOpen, self, onSelf }) {
      const fields = kind === '预测验证'
        ? [['预测', '先写下预测（别先跑）'], ['比对', '跑完之后：实测是什么、与预测差在哪']]
        : kind === '交付物'
          ? [['交付物', '要造出什么'], ['证据', '可运行证据：测试 / 断言 / 期望输出']]
          : [['answer', '参考答案'], ['criteria', '判分要点']];
      const labels = { 预测: '预测', 比对: '跑完的比对', 交付物: '交付物', 证据: '可运行证据', answer: '参考答案', criteria: '判分要点' };
      const hint = kind === '预测验证'
        ? '先写下预测，再跑起来对照（Host 半代跑）'
        : kind === '交付物'
          ? '造出来并留下可运行证据（Host 半代跑）'
          : '开放题不自动判分';
      const reveal = kind === '开放题' ? '展开参考答案与判分要点' : '展开参考内容';
      return h('div', null,
        h('textarea', {
          className: 'smb-ta', rows: 4,
          placeholder: kind === '开放题' ? '先自己写一遍，再展开参考答案对照。' : '先自己写一遍，再展开对照。',
        }),
        h('div', { className: 'smb-btnrow' },
          h('button', { className: 'smb-btn', disabled: open, onClick: () => setOpen(true) }, reveal),
          h('span', { className: 'smb-meta' }, hint)),
        open ? h('div', null,
          fields.map(([field, label]) => h('div', { className: 'smb-ref', key: field }, h('h4', null, label),
            String(item[field] || '').split('\n').map((line, i) => h('p', { key: i }, line)))),
          h('div', { className: 'smb-btnrow' },
            h('span', { className: 'smb-meta' }, '自评：'),
            ['答对了', '答了一半', '没答上'].map((label, i) => h('button', {
              className: 'smb-btn', key: label,
              onClick: () => { onSelf(label); },
            }, label)),
            self ? h('span', { className: 'smb-chip smb-chip--学习中' }, '已记：' + self) : null)) : null);
    }

    function Question({ item, index, node, subject, stateKey, chosen, self, attempts, record, onChoose, onSelf }) {
      const [open, setOpen] = useState(false);
      const previous = attempts.get(stateKey);
      const kind = questionKind(item);
      const objective = kind === '客观题';
      // 「上次你选了 B」：作答数据从 attempts/ 读进来（payload 里的 node.attempts），
      // 状态只服务当场回顾——不做汇总视图、不排期（目标态规格 §5.3）。
      const previousText = previous
        ? (typeof previous.chosen === 'number'
          ? '上次选了 ' + letter(previous.chosen) + '，' + (previous.correct ? '对了' : '错了')
          : (previous.self ? '上次自评：' + previous.self : '上次答过'))
        : null;

      return h('div', { className: 'smb-q' },
        h('div', { className: 'smb-q__ask' },
          h('span', { className: 'smb-q__no' }, 'Q' + (index + 1)),
          kind ? h('span', { className: 'smb-chip' }, kind) : null,
          h('div', { className: 'smb-q__text' },
            item.q.split('\n').map((line, i) => h('p', { key: i }, line)),
            previousText ? h('span', { className: 'smb-review' }, previousText) : null)),
        objective
          ? h('div', { className: 'smb-q__opts' }, (item.opts || []).map((opt, i) => {
            let state = null;
            if (chosen === i) state = i === item.ans ? 'right' : 'wrong';
            else if (chosen != null && i === item.ans) state = 'answer';
            return h('button', {
              className: 'smb-opt', key: i, 'data-state': state, 'data-proto': 'option',
              onClick: () => {
                onChoose(i);
                record(stateKey, { chosen: i, correct: i === item.ans });
              },
            }, h('span', { className: 'smb-opt__l' }, letter(i)), h('span', null, opt));
          }))
          : h(SubjectiveBody, {
            item, kind, open, setOpen, self,
            onSelf: (label) => {
              const right = label === '答对了';
              onSelf(label);
              record(stateKey, { chosen: null, correct: right, self: label });
            },
          }),

        objective && chosen != null ? h('div', { className: 'smb-why', 'data-right': String(chosen === item.ans) },
          h('b', null, chosen === item.ans ? '对了' : '不对，答案是 ' + letter(item.ans)),
          h('p', null, item.why || ''),
          h('div', { className: 'smb-meta' }, '已记进本次会话；落盘由 Host 半写进 attempts/（本题库文件不动）')) : null);
    }


    /* ── 左栏入口图标 ─────────────────────────────────────────────────────── */

    function StudyMateIcon({ size }) {
      const s = size || 18;
      return h('svg', { width: s, height: s, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M9 3.2 15.2 6 9 8.8 2.8 6 9 3.2Z', stroke: 'currentColor', strokeWidth: 1.3,
          strokeLinejoin: 'round', fill: 'none',
        }),
        h('path', { d: 'M4.6 7.6v3.6c0 .9 2 1.7 4.4 1.7s4.4-.8 4.4-1.7V7.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', fill: 'none' }));
    }

    /* ═══════════════════════════════════════════════════════════════════════
       注册
       ═══════════════════════════════════════════════════════════════════════ */

    injectStyles(CSS);

    const PANEL_ID = 'studymate';

    /**
     * 只给 Node 侧套件看的内部件钩子（`scripts/tests/fixtures/client_harness.mjs`）。
     *
     * 为什么要有它：这个文件零构建、原样发货，**不能**加 `export`——宿主按
     * `exports["./client"]` 把它当浏览器插件加载，加了 `export` 就变成 ESM，
     * `window.__ModuleLoader__.load(...)` 那一步的机制直接断掉、工厂永远不执行。
     * 于是「索引构建」这种纯逻辑就只能靠这份钩子出闭包：套件先往 `globalThis` 的
     * `__studymate_client_internals` 放一个**回调**，本文件再加载，工厂执行到这儿时
     * 把内部件交给它。用回调而不是直接赋一个值：钩子活着的时间越短越好，且套件能在
     * 拿走之后立刻把它删干净。
     *
     * 浏览器里没人设这个全局 → 下面这一步是空操作，发货形态与行为一字不变。
     * 往这里加东西的唯一理由：有个套件要断言它、而它又在闭包里。
     */
    const TEST_HOOK = '__studymate_client_internals';
    if (typeof globalThis !== 'undefined' && globalThis[TEST_HOOK]) {
      globalThis[TEST_HOOK]({
        buildIndex, lessonFragments, blockFragments, stripMd, oneLine, parseLesson,
        KIND_ORDER, KIND_LABEL, SearchPalette,
        GlossaryBody, ReferenceFoldBody, RecordsBody, MisconceptionBody, Fold,
        // #79：问答面板本身与它用的那个路由常量（套件断言「面板真的发了 POST、带的就是那几样」）
        AskPanel, ASK_ENDPOINT,
      });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 中央面板：阅读端本体（main 是 keyed/root，key 就是侧栏那一行的 id）
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, StudyMateApp));
        // 侧栏那一行入口：点它由 sidebar 调 ctx.layout.selectPanel('studymate')
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: '学习',
        }, StudyMateIcon));
      },
    };
  },
});
