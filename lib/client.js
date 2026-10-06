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
// 数据来自 Host 半的 GET /api/studymate/library（见 lib/library.ts 与 bin/dsh-plugin.ts）。
// 阅读端**只写两处**（目标态规格 §4.3、ADR-0010）：学生自加的参考资料（POST /reference）与
// 作答数据（POST /attempts，落 attempts/<NNNN>-<节点id>.json）。作答绝不写回 .quiz.json。
// 写回的两件武器：幂等（operationId 重放回原回执）与版本号（expectedVersion 对不上就 409
// 拒绝并重读）；页面这侧的陈旧响应围栏见下面「作答落盘」那一节。
// 问答面板（#79；#105 起是宿主的一条真会话）也调 Host 半：POST /api/studymate/qa/session —— 只是
// 请它按「答疑模式」预设**建**一条会话（请求体只有 subject/node，用来拼标题）。请建完就撒手：
// 问答本身、上下文与落盘全归宿主那条会话，面板不拼 messages、不发模型请求、不写学习工作区
// （#107 退役了那条「面板自己调模型」的旧路由 POST /api/studymate/ask 与它那份上下文组装）。
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

    /* ── Host 半的错误信封（唯一一份，见 lib/route-envelope.ts）───────────────
       失败恒为 `{ ok:false, error:{ code, message }, ...extra }`：
         · `routeCode` 取机读的短码（`version-conflict` / `body-invalid` / `network`…），
           页面按它分支；
         · `routeMessage` 取给人看的那句话，**原样**显示——学生照着它能自救。
       两个字段分开之后，「按码比较」与「取那句话」不再抢同一个 `error`。 */
    const routeError = (body) => (body && typeof body.error === 'object' && body.error !== null ? body.error : null);
    const routeCode = (body) => { const error = routeError(body); return error ? String(error.code || '') : ''; };
    const routeMessage = (body) => {
      const error = routeError(body);
      if (error && error.message) return String(error.message);
      // 兜底：不是我们的信封（老宿主 / 中间层塞进来的）时，别把一句话吞掉
      return (body && (body.message || (typeof body.error === 'string' ? body.error : ''))) || '';
    };

    const LIBRARY_ENDPOINT = '/api/studymate/library';
    const ASSET_ENDPOINT = '/api/studymate/asset';
    const REFERENCE_ENDPOINT = '/api/studymate/reference';
    // 作答数据的写入口；读走 payload（node.attempts），不另开一条读路径（见 lib/attempts-route.ts）
    const ATTEMPTS_ENDPOINT = '/api/studymate/attempts';
    // 建答疑会话那条路由（#105）：会话按「答疑模式」预设由插件**宿主半**建——浏览器的
    // `sessions.create` 只序列化 {workspaceId, cwd, sessionId}，会把 `agentPreset` 静默丢掉。
    // 实现在 lib/ask/session.ts；客户端只 retain 它并渲染它。
    const QA_SESSION_ENDPOINT = '/api/studymate/qa/session';
    /** 答疑会话的标题前缀：「答疑 · 科目 · 节点」。识别「上一段会话」只认它（spec #102）。 */
    const ASK_SESSION_PREFIX = '答疑';
    const ASK_SESSION_SEP = ' · ';
    /** retain 用的来源标签。**绝不能是 'mainView'**：宿主的 ui-session / ui-layout / ui-workspace
     *  都拿 `retainedBy.mainView` 判「谁是当前会话」，借了它就能顶掉学生正在看的会话。 */
    const ASK_RETAIN_SOURCE = 'studymateAsk';
    // 引用 chip（#106）：学生划中的那段正文作为**我们自己的引用来源**进会话草稿。唯一性键是
    // `(trigger, name)`——`@` 下宿主的官方来源叫 reference，'/' 下另有 skill 与 command，
    // 我们的名字都不能撞。`showGroupTitle:false`：`@` 那组菜单已经有一行标题，别再叠一行。
    const QUOTE_TRIGGER = '@';
    const QUOTE_SOURCE_NAME = 'studymate';
    /** `ref` 是我们自己编的字符串（宿主**没有**反序列化入口）：带上这个 kind 才认得出是自己编的。 */
    const QUOTE_REF_KIND = 'studymate.quote';
    /** chip 面上那行短文字的上限（按**码位**数）；草稿里的占位与 chip 都用它。 */
    const QUOTE_LABEL_MAX = 48;
    // 实验代跑（#77）：判分三轨的第三轨。学生按「跑一次」→ Host 半在 lab/ 目录里跑题目里
    // **声明过**的那条命令，真实输出落进作答数据（`跑` 那个字段）。实现在 lib/lab/**。
    const LAB_ENDPOINT = '/api/studymate/lab-run';
    // 任务进度（#73）：跑得久时代跑变成一个可查、可取消的任务，这条只读路由是它的板子。
    const TASKS_ENDPOINT = '/api/studymate/tasks';
    // 变更推送（#74）：Host 半监听学习工作区，内容一变就推一条「变了」的通知。挂在 /api 下，
    // 认证由宿主的 /api 围栏做（见 lib/watch/channel.ts）。EventSource 自己会重连。
    const EVENTS_ENDPOINT = '/api/studymate/events';
    // 公式排版的离线资源（#91）：随包发的 KaTeX dist，由 Host 半**一条文件一条精确路由**投送
    // （清单在 lib/math.ts，注册在 lib/math-route.ts）。**只在页面确实出现数学式时才取**——
    // 见下面「公式排版」那一节；没有数学式的页面一个请求都不发。
    const MATH_ENDPOINT = '/api/studymate/math';

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
  /* 三/四级文字：宿主自己的 label-tertiary / label-caption 是给「大字号或非正文」设计的，
     当 11–12px 正文用，亮色下只有 3.7:1 / 2.1:1——达不到 AA 的 4.5:1。规范不让自调色
     （只引 --dsw-alias-*），所以按 AA 把这两档往主文字色混：色相还是宿主那一族，明度够读。
     比例不是拍脑袋：scripts/tests/test_client_tokens.mjs 逐档算对比度，改坏了就红。
     代价记一笔：四档的深浅差因此收窄（3/4 档更靠近 2 档），层次改由字号与字重承担。 */
  --smb-text-3: color-mix(in srgb, var(--dsw-alias-label-tertiary, #6b7484) 72%, var(--dsw-alias-label-primary, #1b1f27));
  --smb-text-4: color-mix(in srgb, var(--dsw-alias-label-caption, #7e8798) 52%, var(--dsw-alias-label-primary, #1b1f27));
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
  /* 语义色的「文字档」：上面那六个是拿来画点、描边、填色的饱和色，直接当文字用，
     亮色下绿 2.3:1 / 琥珀 2.2:1 / 蓝 4.2:1，都不到 AA 的 4.5:1。点与描边继续用饱和档
     （非文字，AA 只要求 3:1），**文字一律改用下面这几档**往主文字色混过的版本。
     --smb-text-brand 不需要：品牌色本身就是主文字色（亮 18.9:1 / 暗 15.0:1）。 */
  --smb-text-done: color-mix(in srgb, var(--dsw-alias-state-success-primary, #1a7f43) 54%, var(--dsw-alias-label-primary, #1b1f27));
  --smb-text-learning: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #9a6700) 52%, var(--dsw-alias-label-primary, #1b1f27));
  --smb-text-info: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a58d6) 80%, var(--dsw-alias-label-primary, #1b1f27));
  --smb-text-link: color-mix(in srgb, var(--dsw-alias-link, #2f6fdc) 80%, var(--dsw-alias-label-primary, #1b1f27));
  --smb-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  /* 中性填充（chip 底、表头、引用块、热力空格、进度条槽……）：原来引的
     --dsw-alias-fill-tertiary 与 --dsw-alias-fill-l2 **宿主根本没定义**（整棵宿主树里
     0 个定义点、只有引用），一直是兜底 rgba(0,0,0,.0x) 在顶着——亮色下凑合，暗色下几乎看不见。
     换成宿主真实存在的 markdown-tag（亮 #f1f3f5 / 暗 #2c2c2e），亮暗都成立。
     这条由 scripts/tests/test_client_tokens.mjs 的「引到的 alias 必须存在」兜着。 */
  --smb-fill: var(--dsw-alias-markdown-tag, rgba(0,0,0,.04));
  /* 字号与行高**成对**出现：一档 = 一个 --smb-fs-* 加一个同名的 --smb-lh-*。
     为什么成对（#89）：行高原来散着六种写法，字号也两级并存（12.5px 与 13px）——同一屏里
     两段正文一大一小，字的疏密就成了偶然值。配对之后「换字号必然换行高」是默认动作，
     想漏也漏不掉（scripts/tests/test_client_typography.mjs 断配对齐全）。
     正文**只有一档**（--smb-fs-body）：成句的文字都用它，不许再冒出第二种正文字号。
     页与课件的一级标题 h1 那一档同时供主页大标题用——原来 24/25/26 三个值各写各的，
     差一像素看不出来，却让「一级标题」这个说法在三处各是一个数。
     元信息档（角标、chip、图注、控件文字）**不进这套阶梯**：它们不成句，尺寸跟着控件走，
     所以 CSS 里 ≤12px 的字面值仍然允许——但**不允许再往上**：超过 12px 就得引阶梯里的
     某一档，否则同一屏里又会冒出第二种正文字号（这条由上面那个套件守着）。
     间距与圆角**没有**进 token：它们没有「两套并存」这个问题，摊到全文件只是换个写法。 */
  --smb-fs-body: 13px;   --smb-lh-body: 1.65;   /* 正文：正文列与右栏题面/选项/解析 */
  --smb-fs-lead: 15px;   --smb-lh-lead: 1.45;   /* 块、卡片、行标题与控件里的大字 */
  --smb-fs-h2: 17px;     --smb-lh-h2: 1.35;     /* 小节标题 */
  --smb-fs-hero: 18px;   --smb-lh-hero: 1.35;   /* 主卡标题（比 lead 大一档，不跟 h1 抢） */
  --smb-fs-h1: 25px;     --smb-lh-h1: 1.25;     /* 页与课件的一级标题 */
  --smb-fs-code: 12px;   --smb-lh-code: 1.6;    /* 等宽：代码块、文件预览 */
  --smb-motion: 140ms;
  /* 收起态窄轨的宽。**只在这里写一遍**：脚本侧量渲染出来的窄轨（LessonPage 的 measure），
     把手落点也从量出来的值算——ADR-0011 记过「38px 在样式表与脚本里各写一遍，改一处
     忘一处会让把手错位」，这里就是那唯一的一处。 */
  --smb-rail: 38px;

  /* 三级钻取：顶栏 + 唯一的滚动区。每一级是一屏（规格 §4.1），
     所以这里不并排、不分区，滚动交给里面的 .smb-scroll。 */
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--smb-bg);
  color: var(--smb-text);
  font-size: var(--smb-fs-body);
  line-height: var(--smb-lh-body);
  text-align: left;
}
.smb-root *, .smb-root *::before, .smb-root *::after { box-sizing: border-box; }

/* 动效四档（规格 §4.4「动效分 auto/full/reduced/off 四档」，对齐 F7）。
   档位挂在 .smb-root 的 data-motion 上，只改 --smb-motion 一个值——所有过渡与
   动画都吃它，所以没有第二条路径要同步。数值与 lib/client.js 的 motionFor() 一一对应
   （scripts/tests/test_client_pure.mjs 断言两者一致，此处不许单独手改）。
     auto    ：跟随系统。系统没说「减少动效」就是全动效。
     full    ：全动效（140ms）。
     reduced ：缩短（70ms）——状态变化还看得出方向，只是不晃。
     off     ：关掉（0ms）。
   为什么 auto 落到 reduced 而不是 off：off 会让「点题目标记滑出右栏」这类定位变化
   突然出现，反而更难跟；「减少动效」要的是少晃，不是没有反馈。 */
.smb-root[data-motion="full"] { --smb-motion: 140ms; }
.smb-root[data-motion="reduced"] { --smb-motion: 70ms; }
.smb-root[data-motion="off"] { --smb-motion: 0ms; }
@media (prefers-reduced-motion: reduce) {
  .smb-root[data-motion="auto"] { --smb-motion: 70ms; }
}
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
/* 动效档选择器：顶栏右端，紧挨搜索。用原生 select（自带键盘与读屏），
   背景给 panel 而不是 transparent——原生下拉列表会继承它，暗色下才不是白底。 */
.smb-motionpick { display: flex; align-items: center; }
.smb-select {
  padding: 3px 6px; border: 1px solid var(--smb-line-strong); border-radius: 7px;
  background: var(--smb-panel); color: var(--smb-text-2); font: inherit; font-size: 12px; cursor: pointer;
}
.smb-select:hover { background: var(--smb-hover); color: var(--smb-text); }
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
/* 顶部这一条里装的四样：第几课 / 课件标题 / 标签 / 小节跳转，右端是作答进度。
   原来标题与小节目录是**两条**，两条都只占左边一小截、右半条空着（#89）——
   合成一条之后左边是「这是哪一课」、紧跟着「去哪个小节」，窄画布下这条自己换行
   （而不是把某一半空着）。小节跳转不跟正文滚，所以它一直在。 */
.smb-crumb { display: flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--smb-text-3); font: inherit; font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 6px; }
.smb-crumb:hover { background: var(--smb-hover); color: var(--smb-text); }
.smb-center__name { font-weight: 600; }
.smb-center__no { font-family: var(--smb-mono); font-size: 11px; color: var(--smb-text-4); }
.smb-secs { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; min-width: 0; }
.smb-sec {
  padding: 2px 8px; border: 0; border-radius: 6px; background: transparent;
  color: var(--smb-text-3); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.smb-sec:hover { background: var(--smb-hover); color: var(--smb-text); }
.smb-sec[aria-current="true"] { background: var(--smb-raise); color: var(--smb-text); font-weight: 550; }
.smb-center__body { flex: 1; min-height: 0; overflow-y: auto; scroll-behavior: smooth; }

/* 正文的测宽。**不是填满窗口**——一行太长眼睛会找不回行首；但也不该是宽画布正中
   一条卡在上限里的细条（父 spec #84 的现状与差距二：真宿主里正文只占可用宽约 28%）。
   所以三段：760px 是下限（窄画布下等于铺满中栏，不比以前更窄），66% 是宽画布上的占宽，
   900px 是上限（13px 正文下一行约 69 个汉字，再宽就该换行了）——#89 把正文钉成
   13px/1.65（token 块里的 --smb-fs-body / --smb-lh-body），这条上限就是按那一档算的。

   正文列：一切「读」的东西都在这棵树里。
   overflow-wrap: anywhere 是给**长标识符、长 URL、连成一串的路径**留的活口：
   没有它，一个不含空格的 token 会把整列撑宽、筛出横向滚动条（#89 的验收条目）。
   注意它不动 <pre>：代码块自己有块内横向滚动，见 .smb-code pre。 */
.smb-doc { max-width: min(100%, clamp(760px, 66%, 900px)); margin: 0 auto; padding: 20px 24px 120px; overflow-wrap: anywhere; }
.smb-doc h1 { margin: 0 0 8px; font-size: var(--smb-fs-h1); letter-spacing: -.02em; line-height: var(--smb-lh-h1); }
.smb-goal {
  margin: 0 0 22px; padding: 10px 14px; border-radius: 8px;
  border-left: 3px solid var(--smb-brand); background: var(--smb-raise);
  color: var(--smb-text-2); font-size: var(--smb-fs-body);
}
/* 点小节跳转时留出的上边距。原来给到 60px 是为了「别被 sticky 的小节目录条盖住」，
   那条已经并进顶部那一条（不在滚动区里了，盖不住正文），所以这里只留一点点呼吸。
   ⚠ 改这个值会挪动阅读位置恢复量到的小节坐标；捕获与恢复两侧量的是同一套几何，
   所以不会失准，但 scripts/tests/browser/reading_position_test.mjs 的读数会跟着动。 */
.smb-sec-block { scroll-margin-top: 16px; }
.smb-doc h2 { margin: 30px 0 10px; font-size: var(--smb-fs-h2); letter-spacing: -.01em; line-height: var(--smb-lh-h2); }
.smb-doc h3 { margin: 22px 0 8px; font-size: var(--smb-fs-lead); line-height: var(--smb-lh-lead); }
.smb-doc p { margin: 12px 0; }
.smb-doc ul, .smb-doc ol { margin: 12px 0; padding-left: 1.4em; }
.smb-doc li { margin: 3px 0; }
.smb-doc a { color: var(--smb-text-link); text-underline-offset: 3px; }
.smb-doc strong { font-weight: 650; }
.smb-doc code {
  font-family: var(--smb-mono); font-size: .88em; padding: .12em .38em; border-radius: 5px;
  background: var(--dsw-alias-markdown-inline-code, rgba(0,0,0,.06));
}
/* 公式：元素里**先放 TeX 原文**，KaTeX 到位之后才换成排版结果（降级可读，不会白屏）。
   所以「带 .smb-math / .smb-math-block 的那一层」是**容器**，KaTeX 的输出在它里面（.katex）。
   容器自己那两行字体样式只在降级态生效：KaTeX 的 .katex 自带 font 简写，会盖掉外面的斜体。 */
.smb-math { font-family: "Latin Modern Math", "Cambria Math", var(--smb-mono); font-style: italic; }
.smb-math-block {
  margin: 14px 0; padding: 12px; border-radius: 8px; text-align: center;
  background: var(--smb-fill);
  font-family: "Latin Modern Math", "Cambria Math", var(--smb-mono); overflow-x: auto;
}
/* 排版失败时那一句人话（TeX 原文还留在上面，学生至少读得到内容）。挂在同一个容器里，
   所以行内与块级都不会被撑破：行内那句跟在公式后面，块级那句独立成行。 */
.smb-math__bad {
  display: block; margin: 6px 0 0; font-family: var(--smb-mono); font-style: normal;
  font-size: 11.5px; line-height: 1.5; text-align: left; color: var(--smb-text-4);
}
.smb-math > .smb-math__bad { display: inline; margin: 0 0 0 .5em; }
/* 代码块：块头一行语言标签，块内横向滚动（#89 条目 11）。
   语言标签原来只是块头里一行与背景同色的灰字，扫过去像说明文字；给它一个贴字的底，
   才看得出「这一段是什么语言」。 */
.smb-code { margin: 14px 0; border: 1px solid var(--smb-line); border-radius: 10px; overflow: hidden; background: var(--smb-raise); }
.smb-code__bar {
  display: flex; align-items: center; gap: 8px; padding: 5px 12px; border-bottom: 1px solid var(--smb-line);
  font-family: var(--smb-mono); font-size: 11px; color: var(--smb-text-4);
}
.smb-code__bar b {
  padding: 1px 7px; border-radius: 99px; background: var(--smb-fill);
  color: var(--smb-text-2); font-weight: 550; letter-spacing: .02em;
}
.smb-code pre { margin: 0; padding: 10px 14px; overflow-x: auto; font-family: var(--smb-mono); font-size: var(--smb-fs-code); line-height: var(--smb-lh-code); }
.smb-code--term { background: var(--smb-bg); }
/* 宽表格：横向滚动留在这一层（.smb-table-wrap），不往外撑（#89 条目 15）。
   表头是 white-space: nowrap，所以「表比列宽」是常态；overflow-x: auto 让它在自己
   这一层里滚，正文列与整页都不动。单元格内部的长 token 由 .smb-doc 的 overflow-wrap 接住。 */
.smb-table-wrap { margin: 14px 0; overflow-x: auto; border: 1px solid var(--smb-line); border-radius: 10px; }
.smb-table { width: 100%; border-collapse: collapse; font-size: var(--smb-fs-body); }
.smb-table th, .smb-table td { padding: 7px 11px; text-align: left; border-bottom: 1px solid var(--smb-line); vertical-align: top; }
.smb-table th { background: var(--smb-fill); color: var(--smb-text-2); font-weight: 550; white-space: nowrap; }
.smb-table tr:last-child td { border-bottom: 0; }
.smb-figure { margin: 18px 0; }
.smb-figure__frame { padding: 14px; border: 1px solid var(--smb-line); border-radius: 10px; background: var(--smb-panel); color: var(--smb-text-2); }
/* 配图两条路（#89 条目 5、6）：矢量图随列宽流动；位图受列宽约束——
   max-width: 100% 是「大图缩到列宽」，height: auto 保住比例，所以既不溢出也不裁掉。
   原来只有矢量图那条规则，位图一点约束都没有：实测窄档下横着溢出 99px（#86 的读数）。 */
.smb-figure svg { display: block; width: 100%; height: auto; }
.smb-figure__frame img { display: block; max-width: 100%; height: auto; }
/* 暗色主题下的白底配图：一张纯白底的示意图在深色正文里就是一块强光。
   压到 85% 亮度（#fff → #d9d9d9）够把光收住，又不至于把线描图的细线压糊；
   只压亮度不动对比与色相，图上的颜色关系还是原来的。
   判据是宿主的 body[data-ds-dark-theme]（宿主切亮暗就是挂这个属性，不是 prefers-color-scheme，
   所以这里不能写成媒体查询——系统偏好与宿主主题是两件事）。
   矢量图一起压：内容里的 SVG 同样是白底画出来的。 */
body[data-ds-dark-theme] .smb-figure__frame img,
body[data-ds-dark-theme] .smb-figure__frame > svg { filter: brightness(.85); }
.smb-figure figcaption { margin-top: 6px; text-align: center; font-size: 11.5px; color: var(--smb-text-4); }
.smb-note {
  display: flex; gap: 10px; margin: 14px 0; padding: 10px 14px; border-radius: 10px;
  border: 1px solid var(--smb-line); background: var(--smb-fill); font-size: var(--smb-fs-body);
}
.smb-note--warn { border-color: color-mix(in srgb, var(--smb-learning) 40%, transparent); background: color-mix(in srgb, var(--smb-learning) 10%, transparent); }
.smb-note--brand { border-color: color-mix(in srgb, var(--smb-brand) 35%, transparent); }
.smb-note b { display: block; }
.smb-practice { margin: 18px 0; border: 1px solid var(--smb-line-strong); border-left: 3px solid var(--smb-info); border-radius: 10px; background: var(--smb-panel); overflow: hidden; }
.smb-practice__head { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--smb-line); font-size: var(--smb-fs-body); font-weight: 600; }
.smb-practice__head span { color: var(--smb-text-4); font-weight: 400; }
.smb-practice__body { padding: 12px 14px; font-size: var(--smb-fs-body); }
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
.smb-anchor--bad { border-color: color-mix(in srgb, var(--smb-learning) 55%, transparent); color: var(--smb-text-learning); }

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
.smb-card__title { font-size: var(--smb-fs-lead); font-weight: 600; line-height: var(--smb-lh-lead); }
.smb-card__goal { color: var(--smb-text-2); font-size: 12px; }
.smb-card__foot { display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 6px; font-size: 11px; color: var(--smb-text-4); }

.smb-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px;
  border: 1px solid var(--smb-line-strong); border-radius: 99px;
  background: var(--smb-fill);
  color: var(--smb-text-2); font-size: 11px; white-space: nowrap;
}
.smb-chip--已学完 { color: var(--smb-text-done); border-color: color-mix(in srgb, var(--smb-done) 40%, transparent); }
.smb-chip--学习中 { color: var(--smb-text-learning); border-color: color-mix(in srgb, var(--smb-learning) 40%, transparent); }
.smb-chip--未开始 { color: var(--smb-text-4); }
.smb-chip--kind { border-style: dashed; }
.smb-chip--warn { color: var(--smb-text-learning); border-color: color-mix(in srgb, var(--smb-learning) 45%, transparent); }
.smb-chip--info { color: var(--smb-text-info); border-color: color-mix(in srgb, var(--smb-info) 45%, transparent); }

/* ── 右栏检查器 ─────────────────────────────────────────────────────────── */
.smb-right { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid var(--smb-line); background: var(--smb-panel); }
/* 检查器的根（#93）：右栏有两种形态——并排的一栏（.smb-right）与盖在正文上的抽屉
   （.smb-drawer__body 是一条**弹性行**）。检查器交出一个根节点，两种形态才不会把它拆开：
   抽屉那条弹性行会把两个兄弟节点并排放，于是 tab 条被摊成左边一竖列、内容挤到右半幅
   （选中态再对，学生也看不到设计的样子——紧档截图里量到 tab 条 184×795、内容从右半幅开始）。
   根自己是一条纵向弹性列：tab 条在上、内容在下，两种形态下长得一样。 */
.smb-inspector { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.smb-right__tabs { display: flex; gap: 2px; padding: 8px 10px 0; border-bottom: 1px solid var(--smb-line); }
/* 右栏 tab 只有这一套画法：未选中是灰字、选中是品牌色下划线（这是设计上「检查器」与
   「左侧导航」的区别所在）。原来这里还有一套胶囊画法（.smb-tabs / .smb-tab，
   padding + border-radius: 99px + 选中换底色）——它是左栏那套，右栏 tab 曾经借来用，
   于是下面这条下划线规则零引用（#86 的「现状与差距」点名过）。#93 条目 19 把标记改成
   这一套之后，胶囊那两条规则在全仓零引用，一并删掉：写了样式没接线正是这张票在治的病。 */
.smb-rtab {
  padding: 5px 11px; border: 0; border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0;
  background: transparent; color: var(--smb-text-3); font: inherit; font-size: var(--smb-fs-body); cursor: pointer;
}
.smb-rtab:hover { background: var(--smb-hover); color: var(--smb-text); }
.smb-rtab[aria-selected="true"] { color: var(--smb-text); border-bottom-color: var(--smb-brand); font-weight: 600; }
/* 右栏正文区（#93 条目 22）：**只出纵向滚动条**。
   overflow-y 一旦不是 visible，横向按规范会自己算成 auto——于是题干或选项里一个不含空格的
   长 token 就能筛出一根横向滚动条（原来就是这个坏法）。所以横向显式写 hidden，
   并且让长 token 在栏内折行：overflow-wrap 用 anywhere 而不是 break-word——
   anywhere 参与 min-content 计算，弹性行与网格轨道才肯跟着收缩（break-word 不参与，
   文字照样把行顶宽、再被组卡片的 overflow: hidden 裁掉，那比滚动条更糟：字直接没了）。
   两条要一起：只 hidden 会把文字裁掉，只折行则挡不住别的宽内容（长代码键、外部贴进来的宽表）。 */
.smb-right__body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overflow-wrap: anywhere; padding: 12px; }

.smb-qhead { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 11px; color: var(--smb-text-4); }
.smb-anchoritem { border: 1px solid var(--smb-line); border-radius: 10px; margin-bottom: 8px; overflow: hidden; }
/* 这一族（.smb-anchoritem*）是右栏那张锚点卡改名之前的类名，整块都没有引用；
   .smb-anchoritem__text 还被 scripts/tests/test_client_typography.mjs 的正文取样表
   点名，所以整块留着（删它要连着改那份表）。原来挂在它上面的两条「当前」态规则
   已经挪到实际渲染的 .smb-agroup 上，见下面「右栏『题目』tab」那一段（#93 条目 18）。 */
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
.smb-anchoritem__text { flex: 1; min-width: 0; font-size: var(--smb-fs-body); }
.smb-anchoritem__body { padding: 0 11px 11px; }

.smb-q { padding: 10px 0; border-top: 1px solid var(--smb-line); }
.smb-q:first-child { border-top: 0; }
/* 题干那一行是弹性行。默认的 align-items: stretch 会把题型徽标拉成与整段题干一样高的
   一根竖条（#86 实测约 150px；#93 的右栏夹具上量到 45–88px，题面越长越夸张）——
   徽标是**贴字**的标签，所以这一行按 flex-start 对齐（"Q1" 那个角标自己有 padding-top，
   与题干首行照样对得齐）。#93 条目 17。 */
.smb-q__ask { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
.smb-q__no { flex: none; font-family: var(--smb-mono); font-size: 11px; color: var(--smb-text-4); padding-top: 2px; }
.smb-q__text p { margin: 0 0 2px; white-space: pre-line; }
.smb-q__opts { display: grid; gap: 5px; }
.smb-opt {
  display: flex; gap: 8px; width: 100%; padding: 7px 10px;
  border: 1px solid var(--smb-line); border-radius: 8px; background: var(--smb-raise);
  color: inherit; font: inherit; font-size: var(--smb-fs-body); text-align: left; cursor: pointer;
  transition: border-color var(--smb-motion), background var(--smb-motion);
}
.smb-opt:hover { border-color: var(--smb-line-strong); }
.smb-opt__l { flex: none; font-family: var(--smb-mono); font-size: 11px; color: var(--smb-text-4); padding-top: 2px; }
.smb-opt[data-state="right"] { border-color: var(--smb-done); background: color-mix(in srgb, var(--smb-done) 12%, transparent); }
.smb-opt[data-state="wrong"] { border-color: var(--smb-error); background: color-mix(in srgb, var(--smb-error) 12%, transparent); }
.smb-opt[data-state="answer"] { border-color: color-mix(in srgb, var(--smb-done) 55%, transparent); }
.smb-why { margin-top: 8px; padding: 8px 11px; border-radius: 8px; font-size: var(--smb-fs-body); background: var(--smb-fill); border: 1px solid var(--smb-line); }
.smb-why[data-right="false"] { border-color: color-mix(in srgb, var(--smb-error) 45%, transparent); }
.smb-why b { display: block; }
.smb-why p { margin: 3px 0 0; white-space: pre-line; color: var(--smb-text-2); }
.smb-why .smb-meta { margin-top: 4px; color: var(--smb-text-4); font-size: 11px; }
.smb-review { margin-left: 6px; color: var(--smb-text-learning); font-size: 11px; }
/* 一道题自己的落盘提示（写不进去 / 别处刚改过）：贴在题面下面，不抢整页的注意力。
   底色引 --smb-fill 而不是 --dsw-alias-fill-tertiary：后者宿主根本没定义（见 token 块注释） */
.smb-q__note { margin: 6px 0 0; padding: 6px 9px; border-radius: 8px; font-size: 11.5px; color: var(--smb-text-2); background: color-mix(in srgb, var(--smb-learning) 10%, transparent); border: 1px solid color-mix(in srgb, var(--smb-learning) 40%, transparent); }
.smb-q__note[data-tone="info"] { color: var(--smb-text-4); background: var(--smb-fill); border-color: var(--smb-line); }
.smb-ta {
  width: 100%; padding: 8px 10px; border: 1px solid var(--smb-line-strong); border-radius: 8px;
  background: var(--smb-raise); color: var(--smb-text); font: inherit; font-size: var(--smb-fs-body); resize: vertical;
}
.smb-btn {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px;
  border: 1px solid var(--smb-line-strong); border-radius: 7px; background: var(--smb-fill);
  color: var(--smb-text); font: inherit; font-size: 12px; cursor: pointer;
}
.smb-btn:hover { background: var(--smb-hover); }
.smb-btn[disabled] { opacity: .5; cursor: not-allowed; }
.smb-btn--primary { background: var(--smb-brand); border-color: transparent; color: var(--dsw-alias-label-primary-inverted, #fff); font-weight: 550; }
.smb-btnrow { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.smb-ref { margin-top: 8px; padding: 9px 11px; border-radius: 8px; background: var(--smb-fill); font-size: 12px; }
.smb-ref h4 { margin: 0 0 4px; font-size: 11px; color: var(--smb-text-4); letter-spacing: .04em; }
.smb-ref p { margin: 0 0 4px; white-space: pre-line; color: var(--smb-text-2); }
/* 代跑事实块（#77）：命令、结局、退出码、两条流。**只陈述事实**，没有一点判决措辞——
   判定不在这一层（规格 §7.3），所以这里也就没有「通过/不通过」的样式位。 */
.smb-lab { margin-top: 8px; padding: 9px 11px; border-radius: 8px; background: var(--smb-fill); border: 1px solid var(--smb-line); font-size: 12px; }
.smb-lab__cmd { display: block; margin: 0 0 4px; font-family: var(--smb-mono); font-size: 11.5px; color: var(--smb-text); word-break: break-all; }
.smb-lab__fact { margin: 0 0 6px; color: var(--smb-text-2); font-size: 11.5px; }
.smb-lab__stream { margin: 0 0 6px; }
.smb-lab__stream h5 { margin: 0 0 3px; font-size: 11px; color: var(--smb-text-4); letter-spacing: .04em; font-weight: 550; }
.smb-lab__stream pre {
  margin: 0; padding: 6px 8px; max-height: 220px; overflow: auto; border-radius: 6px;
  background: var(--dsw-alias-markdown-inline-code, rgba(0,0,0,.06)); color: var(--smb-text-2);
  font-family: var(--smb-mono); font-size: 11.5px; white-space: pre-wrap; word-break: break-word;
}
.smb-lab__hint { margin: 6px 0 0; color: var(--smb-text-4); font-size: 11px; }
.smb-meta { color: var(--smb-text-4); font-size: 11px; }
.smb-empty { padding: 26px 12px; text-align: center; color: var(--smb-text-4); font-size: var(--smb-fs-body); }
.smb-notes h4 { margin: 12px 0 4px; font-size: 11px; color: var(--smb-text-4); letter-spacing: .04em; }
.smb-notes h4:first-child { margin-top: 0; }
.smb-notes ul { margin: 0; padding-left: 1.2em; color: var(--smb-text-2); }
.smb-notes p { margin: 0 0 6px; color: var(--smb-text-2); }
/* 引用块：**正文里的 blockquote** 用它（正文那一支的 blockquote 走 .smb-quote）。
   面板那颗引用 chip 有自己的 .smb-askquote（#106，挂在宿主输入框上方），不复用这里。 */
.smb-quote { margin: 0 0 8px; padding: 7px 10px; border-left: 2px solid var(--smb-brand); background: var(--smb-fill); color: var(--smb-text-2); font-size: var(--smb-fs-body); max-height: 90px; overflow-y: auto; }
.smb-quote > div:first-child { white-space: pre-wrap; }
.smb-input {
  width: 100%; padding: 7px 10px; border: 1px solid var(--smb-line-strong); border-radius: 8px;
  background: var(--smb-raise); color: var(--smb-text); font: inherit; font-size: var(--smb-fs-body);
}

/* ── 搜索面板 ───────────────────────────────────────────────────────────── */
.smb-palette { position: fixed; inset: 0; z-index: 60; display: flex; justify-content: center; padding-top: 12vh; background: color-mix(in srgb, var(--smb-bg) 55%, transparent); backdrop-filter: blur(3px); }
.smb-palette__box {
  width: min(680px, 92vw); max-height: 70vh; display: flex; flex-direction: column;
  border: 1px solid var(--smb-line-strong); border-radius: 14px; overflow: hidden;
  background: var(--smb-panel); box-shadow: 0 24px 60px -20px rgba(0,0,0,.5);
}
.smb-palette__input { display: flex; align-items: center; gap: 9px; padding: 12px 14px; border-bottom: 1px solid var(--smb-line); }
.smb-palette__input input { flex: 1; border: 0; background: transparent; color: var(--smb-text); font: inherit; font-size: var(--smb-fs-lead); line-height: var(--smb-lh-lead); outline: none; }
.smb-palette__list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; }
/* 搜索的一条结果：**类别 + 正文 + 出处**三段。出处那段（.smb-hit__where）是
   「这条属于哪门科目、哪个节点、哪一块」，所以它排在第二行、科目与节点在前——
   被省略号吃掉时先丢的应该是「目标 / 选项 / 别名」这类补充，而不是「它在哪」。
   正文长什么样都得兜住：overflow-wrap: anywhere 让无断点的长 URL / 长标识符在
   自己那一格里折断，而不是把结果行顶出横向滚动条（.smb-palette__list 的
   overflow-y: auto 会把横向算成 auto，行一溢出面板里就真出滚动条）。
   注意：这一段在模板字符串里，注释里别出现反引号与美元花括号。 */
.smb-hit { display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 7px 10px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.smb-hit:hover { background: var(--smb-hover); }
.smb-hit__kind { flex: none; width: 66px; color: var(--smb-text-4); font-size: 11px; }
.smb-hit__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.smb-hit__text { font-size: var(--smb-fs-body); overflow-wrap: anywhere; }
.smb-hit__where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--smb-text-4); font-size: 11px; }

/* 窄档（<900px）的响应式规则**放在文件的最后**（见文件末尾那一块）。
   原来这一块写在各条基础规则**之前**，同特异度下后写的基础规则赢，于是
   .smb-wrap 的内边距、.smb-crumb 的宽度上限、.smb-continue__bar 的换行
   全是**死声明**——实测两档一模一样（#86 的读数、#89 条目 13 顺手理顺序）。
   一条规则写在它要覆盖的东西之前，就是不生效；位置本身就是语义，别再挪回来。 */

/* ═══ 壳：主页与科目主页单栏，课件阅读页三栏 ═══════════════════════════════
   目标态规格 §4.1。前两级是「一条竖列 + 唯一的滚动区」；第三级才并排，且左右
   两栏**默认收起**——收起时各留一条窄轨（宽就是 token 块里的 --smb-rail），点一下滑出来，
   读正文时不多占一个像素。收起用「不渲染」而不是「宽度 0」：省得隐藏内容还在 DOM 里被读屏念。 */

.smb-scroll { flex: 1; min-height: 0; overflow-y: auto; }
.smb-wrap { max-width: 960px; margin: 0 auto; padding: 22px 26px 90px; }
.smb-wrap--doc { max-width: 820px; }

.smb-lesson { display: flex; flex: 1; min-height: 0; min-width: 0; position: relative; }

.smb-railbar {
  flex: none; width: var(--smb-rail); display: flex; flex-direction: column; align-items: center; gap: 8px;
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
.smb-rail__ico { font-size: var(--smb-fs-body); line-height: 1; }
.smb-rail__label { writing-mode: vertical-rl; letter-spacing: .18em; }
.smb-rail__count {
  display: grid; place-items: center; min-width: 16px; height: 16px; padding: 0 3px;
  border-radius: 99px; background: var(--smb-fill);
  font-size: 10px; color: var(--smb-text-3);
}

/* 栏宽拖拽把手：一条 7px 的透明热区，里面一根 1px 的线（规格 §4.4）。
   落点由组件算好写进内联样式（窄轨 + 这一栏的宽），正好压在栏的内侧边缘上；
   「热区比那根线宽出来的半格」在这里回退，别让脚本再算一遍 38 + width − 3。 */
.smb-panehandle { position: absolute; top: 0; bottom: 0; width: 7px; z-index: 9; cursor: col-resize; }
.smb-panehandle[data-side="left"] { transform: translateX(-3px); }
.smb-panehandle[data-side="right"] { transform: translateX(3px); }
.smb-panehandle > i {
  position: absolute; top: 0; bottom: 0; left: 3px; width: 1px;
  background: var(--smb-line); transition: background var(--smb-motion);
}
.smb-panehandle:hover > i, .smb-panehandle:focus-visible > i, .smb-panehandle[data-dragging="1"] > i {
  left: 2px; width: 3px; background: var(--smb-brand); border-radius: 2px;
}
.smb-panehandle:focus-visible { outline: none; }

/* ── 画布装不下并排时的降级：栏盖在正文上（#88） ─────────────────────────
   为什么不是归零：选项只在右栏渲染，静默归零 = 学生按了「题目」没反应、题也做不了
   （父 spec #84 的现状与差距三、用户故事 20）。抽屉本身就是那条出路——点得到、做得成题；
   顶上那条说明回答「它为什么盖在正文上」。窄轨留出来，收起与切换还在老地方。 */
.smb-drawer {
  position: absolute; top: 0; bottom: 0; z-index: 8; display: flex; flex-direction: column;
  min-width: 0; background: var(--smb-panel);
  box-shadow: 0 0 0 1px var(--smb-line), 0 10px 30px rgba(0, 0, 0, .18);
  animation: smb-fade var(--smb-motion) ease-out;
}
.smb-drawer--left { left: var(--smb-rail); }
.smb-drawer--right { right: var(--smb-rail); }
.smb-drawer__note {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex: none;
  border-bottom: 1px solid var(--smb-line); background: var(--smb-raise);
  font-size: 12px; color: var(--smb-text-2);
}
.smb-drawer__note b { flex: none; color: var(--smb-text); font-weight: 600; }
.smb-drawer__note .smb-btn { margin-left: auto; flex: none; }
.smb-drawer__body { display: flex; flex: 1; min-width: 0; min-height: 0; }
.smb-drawer__body > * { flex: 1; min-width: 0; min-height: 0; }

@keyframes smb-slide-left { from { transform: translateX(-14px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes smb-slide-right { from { transform: translateX(14px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes smb-fade { from { opacity: 0; } to { opacity: 1; } }

/* 宽度由组件按画布算好写进内联样式；这里只管弹性与入场动效 */
.smb-lesson > .smb-left { flex: none; min-width: 0; animation: smb-slide-left var(--smb-motion) ease-out; }
.smb-lesson > .smb-right { flex: none; min-width: 0; animation: smb-slide-right var(--smb-motion) ease-out; }
.smb-lesson > .smb-center { flex: 1; min-width: 0; animation: smb-fade var(--smb-motion) ease-out; }

/* ── 中间栏：正文 ───────────────────────────────────────────────────────── */

/* 滚动区的 scroll-behavior 归这一个类管（.smb-center__body 那条基础规则在上面的
   「中栏」一节里）。小节目录条原来在这里 sticky 着，现在并进顶部那一条，见 .smb-center__head。 */

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
/* 面包屑的宽度上限按**全角字**算（#89 条目 13）：1em 就是一个中文字宽，
   18em 就是「最多留 18 个字」。原来写的是 22ch——ch 是数字 0 的宽度，
   在中文标题上只有约一半（22ch ≈ 11 个字），于是长标题被砍到看不出是哪一课。
   窄档在文件末尾的媒体块里收窄到 12em。 */
.smb-crumb {
  border: 0; background: transparent; color: var(--smb-text-3); font: inherit; font-size: var(--smb-fs-body);
  padding: 3px 7px; border-radius: 7px; cursor: pointer; max-width: 18em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.smb-crumb:hover { background: var(--smb-hover); color: var(--smb-text); }
.smb-crumb[aria-current="page"] { color: var(--smb-text); font-weight: 600; }
.smb-crumb--current { color: var(--smb-text-2); cursor: default; }

/* ── 通用块与卡片 ───────────────────────────────────────────────────────── */

.smb-block { margin: 0 0 30px; }
.smb-block__title { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: var(--smb-fs-lead); letter-spacing: -.01em; line-height: var(--smb-lh-lead); }
.smb-block__hint { margin: -4px 0 10px; color: var(--smb-text-4); font-size: var(--smb-fs-body); line-height: var(--smb-lh-body); }

.smb-hero { margin: 4px 0 26px; }
.smb-hero__eyebrow { margin: 0 0 4px; font-size: 11.5px; letter-spacing: .05em; color: var(--smb-text-4); }
.smb-hero__title { margin: 0; font-size: var(--smb-fs-h1); letter-spacing: -.02em; line-height: var(--smb-lh-h1); }
.smb-hero__sub { margin: 6px 0 0; max-width: 62ch; color: var(--smb-text-3); font-size: var(--smb-fs-body); }

.smb-progressbar { height: 5px; border-radius: 99px; background: var(--smb-fill); overflow: hidden; }
.smb-progressbar > i { display: block; height: 100%; border-radius: inherit; background: var(--smb-brand); transition: width var(--smb-motion); }
.smb-prose { font-size: var(--smb-fs-body); }
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
.smb-continue__title { display: flex; align-items: baseline; gap: 8px; font-size: var(--smb-fs-lead); line-height: var(--smb-lh-lead); font-weight: 600; }
.smb-continue__goal { color: var(--smb-text-2); font-size: var(--smb-fs-body); }
.smb-continue__note { color: var(--smb-text-4); font-size: 11.5px; padding-left: 8px; border-left: 2px solid var(--smb-line-strong); }
.smb-continue__go { margin-top: auto; padding-top: 6px; font-size: 11.5px; color: var(--smb-brand); }
/* 主卡：只有一张，占满一行，比科目行更厚一点 */
.smb-continue--hero { width: 100%; gap: 8px; padding: 16px 18px; }
.smb-continue--hero .smb-continue__title { font-size: var(--smb-fs-hero); line-height: var(--smb-lh-hero); }
.smb-continue__bar { display: flex; align-items: center; gap: 10px; margin-top: 6px; padding-top: 10px; border-top: 1px solid var(--smb-line); }
.smb-continue__bar .smb-progressbar { width: 180px; flex: none; }

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
.smb-course__name { display: flex; align-items: center; gap: 8px; font-size: var(--smb-fs-lead); line-height: var(--smb-lh-lead); font-weight: 600; }
.smb-course__goal { color: var(--smb-text-4); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smb-course__side { display: flex; align-items: center; gap: 14px; flex: none; }
.smb-course__bar { display: flex; align-items: center; gap: 8px; width: 190px; }
.smb-course__bar .smb-progressbar { flex: 1; }
.smb-course__stats { display: flex; gap: 10px; font-size: 11.5px; color: var(--smb-text-3); }
.smb-course__stats span { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
.smb-course__go { color: var(--smb-text-4); }
.smb-donefold { margin-top: 12px; border-top: 1px solid var(--smb-line); padding-top: 4px; }
.smb-donefold .smb-fold__head { color: var(--smb-text-3); }

/* ── 第二级：科目主页 ───────────────────────────────────────────────────── */

.smb-subhead { margin: 4px 0 22px; }
.smb-subhead__title { display: inline-block; margin: 8px 8px 6px 0; font-size: var(--smb-fs-h1); letter-spacing: -.02em; line-height: var(--smb-lh-h1); }
.smb-subhead__goal { margin: 4px 0 14px; max-width: 68ch; color: var(--smb-text-2); font-size: var(--smb-fs-body); line-height: var(--smb-lh-body); }
.smb-subhead__stats { display: flex; flex-direction: column; gap: 8px; max-width: 520px; }
.smb-subhead__counts { display: flex; flex-wrap: wrap; gap: 8px; }

.smb-reflist { margin: 10px 0 0; padding: 0; list-style: none; }
.smb-refitem {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 2px; border-bottom: 1px solid var(--smb-line); font-size: var(--smb-fs-body);
}
.smb-refitem:last-child { border-bottom: 0; }
.smb-refitem__open { border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; padding: 2px 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smb-refitem__open:not([disabled]):hover { color: var(--smb-brand); text-decoration: underline; text-underline-offset: 3px; }
.smb-refitem__open[disabled] { cursor: default; color: var(--smb-text-2); }

.smb-addform { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; padding: 14px; border: 1px solid var(--smb-line-strong); border-radius: 12px; background: var(--smb-raise); }
.smb-reader { margin-top: 12px; border: 1px solid var(--smb-line); border-radius: 12px; overflow: hidden; }
.smb-reader__head { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-bottom: 1px solid var(--smb-line); background: var(--smb-fill); font-size: var(--smb-fs-body); }
.smb-reader__body { margin: 0; padding: 14px; max-height: 46vh; overflow: auto; font-family: var(--smb-mono); font-size: var(--smb-fs-code); line-height: var(--smb-lh-code); white-space: pre-wrap; }

/* ── 第三级：课件阅读页 ─────────────────────────────────────────────────── */

.smb-doc__head { margin: 10px 0 16px; }
.smb-doc__head h1 { margin: 2px 0 8px; font-size: var(--smb-fs-h1); letter-spacing: -.02em; line-height: var(--smb-lh-h1); }
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
.smb-qmark:hover { border-color: var(--smb-brand); background: var(--smb-fill); }
.smb-qmark[data-state="missing"], .smb-qmark[data-state="ambiguous"], .smb-qmark[data-state="stale"] {
  border-left-color: var(--smb-learning);
}
.smb-qmark__badge {
  flex: none; padding: 1px 8px; border-radius: 99px; font-size: 11px;
  border: 1px solid color-mix(in srgb, var(--smb-brand) 40%, transparent); color: var(--smb-brand);
}
/* 组号（#89 条目 16）：正文里的标记与右栏那一组卡片的编号**是同一个数**——
   一眼看得出「这一颗标记属于右栏的第几组」。画法与 .smb-agroup__no 一致（同尺寸的圆圈），
   两处放一起才看得出是一回事。
   类名刻意不叫 smb-qmark__n：那个名字已经是「题数 / 四态」那一段的（套件也在读它）。 */
.smb-qmark__no {
  flex: none; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%;
  background: var(--smb-raise); border: 1px solid var(--smb-line-strong);
  font-size: 11px; color: var(--smb-text-2);
}
.smb-qmark:hover .smb-qmark__no { border-color: var(--smb-brand); color: var(--smb-brand); }
.smb-qmark__text {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-weight: 550; font-size: var(--smb-fs-body);
}
.smb-qmark__n { flex: none; font-size: 11.5px; color: var(--smb-text-4); }
.smb-qmark__n--warn { color: var(--smb-text-learning); }
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
.smb-agroup__head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--smb-fill); }
.smb-agroup__title {
  display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;
  border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.smb-agroup__no {
  flex: none; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%;
  border: 1px solid var(--smb-line-strong); color: var(--smb-text-3); font-size: 11px;
}
.smb-agroup__text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; font-size: var(--smb-fs-body); }
.smb-agroup__fold { flex: none; width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: var(--smb-text-4); font: inherit; cursor: pointer; }
.smb-agroup__fold:hover { background: var(--smb-hover); color: var(--smb-text); }
.smb-agroup__body { padding: 10px 12px 4px; }
/* 「点正文里的题目标记 → 右栏这一组是当前」（#93 条目 18）。这两条画法本来就写了，
   但挂在 .smb-anchoritem[data-active] 上——那是这张卡改名之前的类名，零引用，
   所以「当前」态从来没有出现过。现在挂在真正渲染的 .smb-agroup 上，属性用 aria-current
   （与本文件里节点、小节、面包屑的「当前」同一套）：语义与样式同一个源，屏幕阅读器也读得到。 */
.smb-agroup[aria-current="true"] { border-color: var(--smb-brand); }
.smb-agroup[aria-current="true"] .smb-agroup__no {
  background: var(--smb-brand); border-color: var(--smb-brand);
  color: var(--dsw-alias-label-primary-inverted, #fff);
}
.smb-right__n {
  margin-left: 5px; padding: 0 5px; border-radius: 99px; font-size: 10.5px;
  background: var(--smb-fill); color: var(--smb-text-3);
}

/* ── 右栏「问答」tab ────────────────────────────────────────────────────── */

.smb-askchip {
  position: sticky; bottom: 16px; z-index: 6;
  display: block; width: fit-content; margin: 0 auto 16px;
  padding: 7px 16px; border: 1px solid var(--smb-line-strong); border-radius: 99px;
  background: var(--smb-panel); color: var(--smb-text); font: inherit; font-size: var(--smb-fs-body);
  box-shadow: 0 12px 30px -14px rgba(0,0,0,.5); cursor: pointer;
}
.smb-askchip:hover { background: var(--smb-raise); }

.smb-askbody { font-size: var(--smb-fs-body); }
.smb-ask__head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
/* 顶部那两个入口与「上一段会话」那张单子（#105）。单子贴在头部下面、正文之上。 */
.smb-askmenu { margin: 0 0 10px; border: 1px solid var(--smb-line); border-radius: 8px; background: var(--smb-raise); overflow: hidden; }
.smb-askmenu__item {
  display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 7px 10px;
  border: 0; border-bottom: 1px solid var(--smb-line); background: none;
  color: var(--smb-text); font: inherit; font-size: var(--smb-fs-body); text-align: left; cursor: pointer;
}
.smb-askmenu__item:last-child { border-bottom: 0; }
.smb-askmenu__item:hover { background: var(--smb-fill); }
/* 宿主会话正文那一格：conversation.content 自带 --dsh-* 那一套排版与滚动，这里只给它一块
   可伸缩的地方——**别再设正文字号**（两套体系会打架，见 #89 与阅读端呈现 §二）。 */
.smb-asksession { flex: 1 1 auto; min-height: 240px; display: flex; flex-direction: column; }

/* 输入框上方的引用 chip（#106）：学生划中的那段正文。一行是「原文 + 来源小节」，点开看全文，
   右边一颗「删掉」；删掉之后什么都不划也照常提问。它必须**看得见**：这段文字进消息的唯一
   凭据就是它（宿主没有提交钩子，草稿里没有它，消息就不带它）。 */
.smb-askquote { margin: 0 0 10px; padding: 7px 8px 7px 10px; border: 1px solid var(--smb-line-strong); border-left: 2px solid var(--smb-brand); border-radius: 8px; background: var(--smb-fill); color: var(--smb-text-2); font-size: var(--smb-fs-body); }
.smb-askquote__row { display: flex; align-items: center; gap: 8px; }
.smb-askquote__head {
  display: flex; align-items: baseline; gap: 8px; flex: 1 1 auto; min-width: 0;
  padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.smb-askquote__mark { flex: none; padding: 0 6px; border-radius: 99px; background: var(--smb-raise); color: var(--smb-text-4); font-size: 11px; }
.smb-askquote__text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smb-askquote__drop {
  flex: none; padding: 1px 8px; border: 1px solid var(--smb-line-strong); border-radius: 6px;
  background: var(--smb-panel); color: var(--smb-text-3); font: inherit; font-size: 11px; cursor: pointer;
}
.smb-askquote__drop:hover { background: var(--smb-raise); color: var(--smb-text); }
.smb-askquote__where { margin-top: 3px; }
.smb-askquote__full { margin-top: 6px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; color: var(--smb-text); }

.smb-dot--未开始 { background: var(--smb-todo); }

/* ═══ 窄档（< 900px）：全文件的最后一块 ═══════════════════════════════════
   放在这里是**有意的**：媒体查询不提升特异度，同特异度下后写的赢。这一块原来拆成两块、
   其中一块写在各条基础规则前面，于是 .smb-wrap 内边距、.smb-crumb 宽度上限、
   .smb-continue__bar 换行全是**死声明**（实测宽窄两档一模一样，#86 把它记进了 metrics、
   #89 条目 13 顺手理顺序）。#90 也把这一块挪到过这里。
   规矩：窄档的覆盖一律写进这一块，别再往上挪。 */
@media (max-width: 900px) {
  /* 壳 */
  .smb-wrap { padding: 16px 14px 90px; }
  .smb-topbar { flex-wrap: wrap; }
  /* 面包屑再收一档：窄画布下留给它的位置本来就少（宽档 18em 见 .smb-crumb） */
  .smb-crumb { max-width: 12em; }
  /* 科目行：「接着上次」与科目行都在这一档折行 */
  .smb-continue__bar { flex-wrap: wrap; }
  .smb-continue__bar .smb-progressbar { width: 100%; }
  .smb-course { flex-wrap: wrap; }
  .smb-course__side { width: 100%; justify-content: space-between; }
  .smb-course__bar { width: auto; flex: 1; }
}

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
       从此由阅读端解释。解析与 Python 渲染器退役前的口径一致（docs/规范/课件内容格式.md §4）。
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

    /* ═══════════════════════════════════════════════════════════════════════
       公式排版（KaTeX）：离线、按需、失败可读

       分工是 `docs/规范/课件内容格式.md` §3 已经写下的那条：**模型只写 TeX，排版在阅读端**。
       三件事都在这一节里，改之前先读一遍：

       1. **按需加载**：资源只在**真的渲染出一个数学元素**时才去取。`MathSpan` 是唯一入口
          ——正文的 `$…$` / `$$…$$` 与题库字段都走它，所以「公式只出现在题面里」也照样加载；
          反过来，没有数学式的页面（非数学课、老课件）一个请求都不发。
       2. **降级可读**：元素里先放 TeX 原文；引擎到位之前、或根本没到位，学生读到的还是公式
          源码，不是空白。
       3. **失败给一句人话**：没排出来时把原因写进同一个元素（`公式没排出来：…`）。
          「没收尾的 `$`」**不在这里报**——那是内容层的确定性错误，`lib/core/format.ts` 已经
          带行号拦下了，阅读端重报只会让学生在两处看到同一件事。
       ═══════════════════════════════════════════════════════════════════════ */

    /**
     * 样式表与引擎在哪个基址下：默认是 Host 半的投送路由（`lib/math-route.ts` 一条文件
     * 一条精确路由）。两个字段都可以缺，也都可以给空串：
     *   · `css`：样式表 URL；空串 = 宿主已经备好了样式表，别再插 `<link>`；
     *   · `js`：引擎脚本 URL；空串 = 引擎必须已经挂在 `window.katex` 上。
     *
     * 导出页没有 Host 半，产物里的 `host.js` 用 `window.__STUDYMATE_MATH__` 声明位置（与取图
     * 那条地址改写同一个口径：同一份阅读端代码，两种宿主）。产物里那份 KaTeX 走 vendor 包装壳
     * 登记进离线页面的模块表，由 `boot.js` 挂成 `window.katex`——所以导出页不给 `js`。
     */
    function mathSource() {
      const provided = window.__STUDYMATE_MATH__;
      const table = provided && typeof provided === 'object' ? provided : {};
      const pick = (value, fallback) => (typeof value === 'string' ? value : fallback);
      return {
        css: pick(table.css, MATH_ENDPOINT + '/katex.min.css'),
        js: pick(table.js, MATH_ENDPOINT + '/katex.min.js'),
      };
    }

    /** 引擎就位没有：KaTeX 的 UMD 在 classic script 里自己写上 `window.katex`。 */
    function mathEngineHere() {
      const engine = window.katex;
      return engine && typeof engine.renderToString === 'function' && typeof engine.render === 'function'
        ? engine
        : null;
    }

    let mathEngine = null;    // 加载成功之后就缓在这里（一次加载，全页共用）
    let mathPending = null;   // 正在加载的那个 promise：一页里几十个公式也只加载一次

    /** 样式表只插一次；宿主说它已经备好（`css` 为空串）就不插。 */
    function ensureMathStylesheet(href) {
      if (!href || document.querySelector('link[data-smb-math]')) return;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.setAttribute('data-smb-math', '');
      link.href = href;
      document.head.appendChild(link);
    }

    function loadMathScript(url) {
      return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.async = true;
        el.src = url;
        el.addEventListener('load', () => { el.remove(); resolve(); }, { once: true });
        el.addEventListener('error', () => {
          el.remove();
          reject(new Error('公式引擎没加载成功（' + url + '）'));
        }, { once: true });
        document.head.appendChild(el);
      });
    }

    /**
     * 取排版引擎：一次加载，之后复用；取不到就带着原因拒绝（调用处把原因显示出来）。
     * 失败**不重试**——一页里几十个公式各重试一次，控制台会脏成一片。
     */
    function ensureMath() {
      if (mathEngine) return Promise.resolve(mathEngine);
      if (mathPending) return mathPending;
      const source = mathSource();
      ensureMathStylesheet(source.css);
      const here = mathEngineHere();
      mathPending = (here
        ? Promise.resolve(here)
        : (source.js
          ? loadMathScript(source.js).then(() => {
            const loaded = mathEngineHere();
            if (!loaded) throw new Error('公式引擎加载了但没挂上（' + source.js + '）');
            return loaded;
          })
          : Promise.reject(new Error('这台宿主没有备好的公式引擎（没给资源位置，window.katex 也不在）'))))
        .then((engine) => { mathEngine = engine; return engine; });
      return mathPending;
    }

    /**
     * 一个数学元素：**先显示 TeX 原文**，引擎到位后换成排版结果。
     *
     * 用 `renderToString` + `dangerouslySetInnerHTML`，而不是 `katex.render(tex, el)`：这一层
     * 由 React 管，命令式地改它的子节点会在下一次重画时打架（React 去删它以为还在的节点，
     * 报 `removeChild`）。走 state 就是「排版结果也是一份状态」，重画多少次都对。
     */
    function MathSpan({ tex, block }) {
      const [state, setState] = useState({ html: null, error: null });
      const source = String(tex == null ? '' : tex);
      const cls = block ? 'smb-math-block' : 'smb-math';
      useEffect(() => {
        let alive = true;
        // 换了一个公式（同一个座位上的组件被复用）就回到「先显示原文」那一态
        setState((prev) => (prev.html === null && prev.error === null ? prev : { html: null, error: null }));
        ensureMath().then((engine) => {
          if (!alive) return;
          try {
            // `strict: false`：KaTeX 默认会给「数学模式里的 CJK / 有歧义的写法」发 console 告警，
            // 而告警在浏览器套件里会被算成页面问题。内容层已经按确定性错误拦过一轮了，
            // 这里不再把告警升级成噪音。
            const html = engine.renderToString(source, { displayMode: !!block, throwOnError: true, strict: false });
            setState({ html, error: null });
          } catch (error) {
            setState({ html: null, error: String((error && error.message) || error) });
          }
        }, (error) => {
          if (alive) setState({ html: null, error: String((error && error.message) || error) });
        });
        return () => { alive = false; };
      }, [source, block]);
      if (state.html !== null) {
        return h(block ? 'div' : 'span', { className: cls, dangerouslySetInnerHTML: { __html: state.html } });
      }
      return h(block ? 'div' : 'span', { className: cls },
        source,
        state.error ? h('span', { className: 'smb-math__bad', role: 'status' }, '公式没排出来：' + state.error) : null);
    }

    /* 题库字段（题面 / 选项 / 参考答案 / 判分要点 / 解析）**只接数学式**这一件事：
       它们是纯文本字段，粗体/反引号/链接那套行内标记不在本票范围里——带进去就是行为变化。
       判据与正文同一份：`$…$` 行内、`$$…$$` 块级。 */
    const MATH_ONLY = /(\$\$[\s\S]+?\$\$|\$[^$\n]+\$)/g;

    function mathNodes(text, keyPrefix) {
      const parts = String(text == null ? '' : text).split(MATH_ONLY).filter((part) => part !== '' && part != null);
      return parts.map((part, index) => {
        const key = keyPrefix + '-' + index;
        if (/^\$\$[\s\S]+\$\$$/.test(part)) return h(MathSpan, { key, tex: part.slice(2, -2), block: true });
        if (/^\$[^$\n]+\$$/.test(part)) return h(MathSpan, { key, tex: part.slice(1, -1) });
        return part;
      });
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
        else if (/^\$[^$\n]+\$$/.test(part)) out.push(h(MathSpan, { key, tex: part.slice(1, -1) }));
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
          // 块级公式：类名与样式不动（`.smb-math-block` 是容器），内容交给同一个 MathSpan
          return h(MathSpan, { tex: block.tex, block: true });
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
       阅读位置三级恢复 · 纯函数内核
       目标态规格 §4.4：捕获 `{sectionOffset, scrollTop, progress}`，恢复按
       section → offset → progress 三级降级（对齐 F4）。

       ⚠️ 这一段里**只有纯数学**：不碰 DOM、不碰存储，所以能脱离浏览器单测
       （`scripts/tests/test_client_reading_position.mjs`）。改这里时别顺手加 DOM 调用——
       那会把唯一能确定性验证的一半拖进「只能靠人眼看」的境地。
       两个标记之间就是内核，测试按这两个标记切出来。
       ═══════════════════════════════════════════════════════════════════════ */

    /* -- STUDY_POSITION_KERNEL_START -- */

    /* 三级降级的三个名字：section 最准（正文改过也跟得住），offset 是绝对像素，
       progress 是比例——越往后越不耐改动，所以按这个次序退。 */
    const POSITION_TIERS = ['section', 'offset', 'progress'];

    /** 判断 canvas 的类属。 */
    function isPositiveNumber(value) {
      return typeof value === 'number' && isFinite(value) && value > 0;
    }

    /**
     * 滚动区的容差参数。判断「是不是同一段」用比例而不是像素——缩放与字体大小都会
     * 改像素值，比例不会。
     */
    function positiveOr(value, fallback) {
      return isPositiveNumber(value) ? value : fallback;
    }

    /**
     * 按量好的小节几何挑一个「最靠上那个还露着的小节」，返回它在**候选数组里**的下标。
     * 可见范围（`viewportTop` / `viewport`）由调用方给，所以这个函数不依赖任何 DOM 概念，
     * 也不要在这里读 DOM——「当前读到哪一节」的判定就是这一处。
     *
     * 极短的小节（不足一屏的一半）自己撑不起一屏，跳过它，否则它们会在滚动时互相抢
     * `aria-current`；这与只有一个短小节时仍取它的兜底并不冲突（兜底在最后一行）。
     *
     * @param {{index: number, id: string, top: number, bottom: number}[]} sections
     *   元素坐标一律在**滚动区坐标系**里（`top` 是相对滚动区上边缘的距离）
     * @param {number} viewportTop 判断「读到哪」的那条线：正文实际可见范围的上边缘
     * @param {number} viewport 正文实际可见范围的高度
     */
    function topmostSectionIndex(sections, viewportTop, viewport) {
      const list = sections || [];
      if (!list.length) return -1;
      const probe = (typeof viewportTop === 'number' && isFinite(viewportTop)) ? viewportTop : 0;
      const height = positiveOr(viewport, 1);
      let found = -1;
      for (let i = 0; i < list.length; i++) {
        const section = list[i];
        // 极短的小节（不足可见高度的一半）自己撑不起一屏，跳过它才不会在滚动时抖
        if (section.bottom - section.top < height / 2) continue;
        if (section.top <= probe + 1) found = i;
      }
      if (found >= 0) return found;
      // 一个小节都还没到顶（比如刚进页面）：取第一个露头的
      for (let i = 0; i < list.length; i++) if (list[i].bottom > probe) return i;
      return 0;
    }

    /**
     * 把存下来的位置换算成**这次上屏该滚到哪儿**，并说清是哪一级兜住的。
     *
     * 三级逐级退：
     *   1. `section`：按 `id` 找同一个小节——小节被挪动过也跟得住，正文改动的首选；
     *   2. `offset`：存下来的绝对 `scrollTop`——小节找不到时的一根锚；
     *   3. `progress`：存下来的比例 × 新的可滚高度——正文加长或缩短时的最后一根锚。
     *
     * @param {{sectionId?: string, offset?: number, scrollTop?: number, progress?: number}} saved
     * @param {{index: number, id: string, top: number, bottom: number}[]} sections
     *   这次上屏量到的小节几何（`top`/`bottom` 都在滚动区坐标系里）
     * @param {number} maxScroll 这次上屏可滚的最大距离
     * @returns {{tier: string, top: number, section: number}}
     */
    function resolveReadingTargets(saved, sections, maxScroll) {
      const list = sections || [];
      const limit = positiveOr(maxScroll, 0) > 0 ? Math.max(0, maxScroll) : 0;
      const source = saved || {};
      const wantId = source.sectionId == null ? '' : String(source.sectionId);
      const offset = (typeof source.offset === 'number' && isFinite(source.offset)) ? Math.max(0, source.offset) : 0;

      const steps = [];
      if (wantId) {
        const at = list.findIndex((section) => section && String(section.id) === wantId);
        if (at >= 0) {
          const section = list[at];
          // 小节自己也会长：存下来的段内偏移最多到这一节的末尾，不能溢到下一节去
          const within = Math.min(offset, Math.max(0, section.bottom - section.top));
          steps.push({ tier: 'section', section: at, top: section.top + within });
        }
      }
      if (isPositiveNumber(source.scrollTop)) steps.push({ tier: 'offset', section: -1, top: source.scrollTop });
      if (typeof source.progress === 'number' && isFinite(source.progress) && source.progress > 0) {
        steps.push({
          tier: 'progress', section: -1,
          top: Math.min(1, source.progress) * limit,
        });
      }

      for (const step of steps) {
        if (!isFinite(step.top)) continue;             // 这一级没有量到可用几何，退下一级
        return { tier: step.tier, top: Math.max(0, Math.min(limit, step.top)), section: step.section };
      }
      return { tier: '', top: 0, section: -1 };
    }

    /**
     * 从一次量到的几何里算出要存下来的三元组。`offset` 是**段内**偏移（滚到这一节顶端
     * 时是 0），所以小节被挪动过也还原得回去；`progress` 是整篇的比例，改长了还落得回
     * 相近的位置。`sectionId` 按 id 存而不是按下标存——插入一节不会让所有位置串位。
     *
     * @param {{index: number, id: string, top: number, bottom: number}[]} sections
     * @param {number} scrollTop
     * @param {number} maxScroll
     */
    function readingPositionOf(sections, scrollTop, maxScroll) {
      const list = sections || [];
      const top = (typeof scrollTop === 'number' && isFinite(scrollTop)) ? Math.max(0, scrollTop) : 0;
      const limit = positiveOr(maxScroll, 0) > 0 ? Math.max(0, maxScroll) : 0;
      const at = topmostSectionIndex(list, top, 0);
      const section = at >= 0 ? list[at] : null;
      const within = section ? Math.min(Math.max(0, top - section.top), Math.max(0, section.bottom - section.top)) : 0;
      return {
        sectionId: section ? String(section.id) : '',
        offset: within,
        scrollTop: top,
        progress: limit > 0 ? Math.min(1, Math.max(0, top / limit)) : 0,
      };
    }

    /**
     * 恢复没落到位时要不要再试一次。两种「到位」：滚到了目标附近，或者**布局还在长**
     * ——刚上屏时所有小节都矮，像素目标会被 clamp 到当下能滚到底的地方，这时先接受，
     * 等正文长起来再重算；这两种情况之外（存的位置超出这一篇的可滚范围）就没必要再试。
     */
    function readingPositionSettled(target, scrollTop, height) {
      const aim = (typeof target === 'number' && isFinite(target)) ? target : 0;
      const at = (typeof scrollTop === 'number' && isFinite(scrollTop)) ? scrollTop : 0;
      if (Math.abs(at - aim) <= 24) return true;
      return at < aim - 24 && height + 24 < aim;
    }

    /* -- STUDY_POSITION_KERNEL_END -- */

    /* ── 阅读位置：捕获与恢复（规格 §4.4 / #76）─────────────────────────────
       位置**只住在浏览器本地偏好里**——与栏宽同一类东西，不写进学习工作区（那是学习内容的
       落点）。键名跟着 `studymate.panes.v1` 的命名走，一篇文章一条。

       恢复是**三级降级**（section → offset → progress）：正文改过、锚点漂了的时候逐级退，
       而不是直接回到顶部。三级各自怎么算、怎么退，都在上面的纯函数内核里；这一段只负责
       量 DOM、读写偏好、以及「什么时候可以下结论」。

       为什么不挂 beforeunload：帧内换视图（跳去提问、开搜索）时组件**不卸载**，靠
       `beforeunload` 根本抓不到那一下。所以改成滚动时就捕获（rAF 合并 + 停手后落盘），
       切视图/卸载时再补一次 flush——两条路都不依赖页面关闭。

       面板里的定时器：rAF 被屏蔽时退回 `setTimeout`（宿主对客户端 timer 有意见，
       但 `setTimeout` 在本文件里本来就在用，见栏宽的合并写入）。 */

    const POSITION_KEY = 'studymate.reading.v1';

    /** 宿主给的那套 rAF 不一定在（headless / 特殊预设），退回宏任务，别让恢复整条断掉。 */
    const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
    const cancelRaf = (id) => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
      else clearTimeout(id);
    };

    /**
     * 一个节点存一条。读不出来（没存过 / 无痕里抛 / 坏值）就当作没有——**不抛**，
     * 读不了位置不该把整页阅读端带崩。
     */
    function readReadingPosition(nodeKey) {
      if (!nodeKey) return null;
      try {
        const raw = JSON.parse(window.localStorage.getItem(POSITION_KEY) || 'null');
        if (!raw || typeof raw !== 'object') return null;
        const one = raw[nodeKey];
        return (one && typeof one === 'object') ? one : null;
      } catch (error) { return null; }
    }

    /** 写回整张表：一条一条 `setItem` 会让键越堆越多，也不好在 DevTools 里读。 */
    function writeReadingPosition(nodeKey, value) {
      if (!nodeKey) return;
      try {
        const raw = JSON.parse(window.localStorage.getItem(POSITION_KEY) || 'null');
        const table = (raw && typeof raw === 'object') ? raw : {};
        table[nodeKey] = { sectionId: value.sectionId, offset: value.offset, scrollTop: value.scrollTop, progress: value.progress };
        window.localStorage.setItem(POSITION_KEY, JSON.stringify(table));
      } catch (error) { /* 存不下就算了：下次进这一课就从头读 */ }
    }

    /**
     * 量这一次上屏的小节几何与可滚范围。
     * `fresh` 为真时重新取一次正文容器（恢复时用）；否则沿用上一次那份引用，省一次查询。
     */
    function measureReadingScroller(scroller, fresh, within) {
      if (!scroller) return null;
      let doc = within;
      if (!doc || fresh || !doc.isConnected) {
        doc = scroller.querySelector('.smb-doc') || scroller.firstElementChild;
      }
      const frame = scroller.getBoundingClientRect();
      const viewport = Math.max(0, frame.height);
      const sections = [];
      for (const el of scroller.querySelectorAll('[data-section]')) {
        // 元素坐标 → 滚动区坐标：两边量到的都是视口坐标，减掉滚动区上边缘就换算过去了
        const rect = el.getBoundingClientRect();
        sections.push({
          index: Number(el.dataset.section) || 0,
          id: el.id || '',
          top: rect.top - frame.top + scroller.scrollTop,
          bottom: rect.bottom - frame.top + scroller.scrollTop,
        });
      }
      sections.sort((a, b) => a.index - b.index);
      return { sections, maxScroll: Math.max(0, scroller.scrollHeight - scroller.clientHeight), top: frame.top, viewport, doc };
    }

    /**
     * 阅读位置：捕获 + 三级降级恢复。[#76]
     *
     * @returns {{bodyRef: object, section: number, setSection: Function}}
     *   `bodyRef` 挂在 `.smb-center__body` 上（那是三栏里唯一属于正文的滚动区）；
     *   `section` 是当前读到哪一节，目录条拿它点 `aria-current`。
     */
    function useReadingPosition(nodeKey, lesson) {
      const scrollerRef = useRef(null);
      const bodyRef = useRef(null);
      const [section, setSection] = useState(0);

      // 捕获侧与恢复侧要的东西全在 ref 里：滚动监听只装一次，回调里读 ref，
      // 免得每次渲染都重装监听（重装会漏事件，也会把上一次的落盘时机弄丢）
      const lastRef = useRef(null);
      const pendingRef = useRef(0);
      const canFlushRef = useRef(true);
      const restoreRef = useRef({
        done: true,
        attempts: 0,
        frame: 0,
        startedAt: 0,
        programmatic: false,
      });

      const flush = useCallback(() => {
        if (pendingRef.current) { cancelRaf(pendingRef.current); pendingRef.current = 0; }
        const scroller = scrollerRef.current;
        const last = lastRef.current;
        // 卸载后再落盘会把位置写脏（滚动区已经不是原来那一个），用 canFlush 拦住
        if (!scroller || !last || !canFlushRef.current) return;
        if (!last.sections.length && !last.scrollTop) return;
        const at = readingPositionOf(last.sections, scroller.scrollTop, last.maxScroll);
        const before = last.saved;
        if (before && before.sectionId === at.sectionId && before.offset === at.offset
          && before.scrollTop === at.scrollTop && before.progress === at.progress) return;   // 没动过就别写盘
        last.saved = at;
        writeReadingPosition(nodeKey, at);
      }, [nodeKey]);

      /**
       * 一次滚动事件：**就地量**（量晚了拿到的 `scrollTop` 已经是滚完之后的值，存下来会
       * 偏出一次滚动），再合并到一帧之后写盘——一次滚动会来几十个事件，每个都写一遍
       * 本地偏好会卡。
       */
      const capture = useCallback(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const before = lastRef.current;
        const now = measureReadingScroller(scroller, false, before && before.doc);
        if (!now) return;
        lastRef.current = now;
        if (pendingRef.current) cancelRaf(pendingRef.current);
        pendingRef.current = raf(() => { pendingRef.current = 0; flush(); });
      }, [flush]);

      // 恢复：滚到目标；没落到位就等一帧再来一次——正文里的图与公式会把高度撑起来，
      // 只做一次的话首帧量到的几何是矮的，位置会落在半路。
      const applyRestore = useCallback(() => {
        const scroller = scrollerRef.current;
        const run = restoreRef.current;
        if (!scroller || run.done) return;
        // 兜底：别跟一篇一直在长的正文较劲，超时就停下（停在已经滚到的地方，不回顶部）
        if (Date.now() - run.startedAt > 1500) { run.done = true; return; }
        const now = measureReadingScroller(scroller, true, null);
        if (!now) { run.done = true; return; }
        lastRef.current = now;                       // 捕获侧也拿它当基线，省一次查询
        const at = resolveReadingTargets(readReadingPosition(nodeKey) || {}, now.sections, now.maxScroll);
        if (!at.tier) { run.done = true; return; }
        if (readingPositionSettled(at.top, scroller.scrollTop, now.maxScroll)) { run.done = true; return; }
        // 定位用 instant：`.smb-center__body` 的 `scroll-behavior: smooth` 会让每次重试
        // 都从当前位置再滑一段，几次下来位置就飘了
        run.programmatic = true;
        scroller.scrollTop = at.top;
        run.attempts += 1;
        // 滚动区的可见上边缘 = 正文的可见上边缘。顶部那条（课件标题 + 小节跳转）**不在
        // 滚动区里**（#89 把它从 sticky 的小节条并进了 `.smb-center__head`），所以量到的
        // 小节坐标就是正文自己的坐标，没有再叠一层浮层高度。
        setSection(topmostSectionIndex(now.sections, scroller.scrollTop, now.viewport));
        if (run.attempts < 40) run.frame = raf(applyRestore);
        else run.done = true;
      }, [nodeKey]);

      const attach = useCallback((node) => {
        scrollerRef.current = node;
        if (node) { bodyRef.current = node; return; }
        // 卸载：停掉重试，把当下这一处位置补写一次，再回收这一篇的进度
        const run = restoreRef.current;
        if (run.frame) cancelRaf(run.frame);
        run.frame = 0;
        run.done = true;
        flush();
        canFlushRef.current = false;
        bodyRef.current = null;
        pendingRef.current = 0;
      }, [flush]);

      /**
       * 滚动区尺寸变了（右栏滑出/收起、拖栏宽、窗口缩放）就地重新锚一次。
       * 这不是「恢复」的重复：换宽度会让正文重排，`scrollTop` 停在同一像素上会挪出好几段，
       * 学生点一下题目标记回来就找不到刚才那段了。整篇只有一处位置来源，所以从
       * `resolveReadingTargets` 拿目标，不另写一套。
       */
      const reflow = useCallback(() => {
        const scroller = scrollerRef.current;
        const last = lastRef.current;
        if (!scroller || !last) return;
        const now = measureReadingScroller(scroller, true, null);
        if (!now) return;
        if (now.maxScroll === last.maxScroll) { lastRef.current = now; return; }   // 高度没变 = 没重排
        const at = resolveReadingTargets(last.saved || {}, now.sections, now.maxScroll);
        lastRef.current = now;
        if (!at.tier) return;
        restoreRef.current.programmatic = true;
        scroller.scrollTop = at.top;
        setSection(topmostSectionIndex(now.sections, scroller.scrollTop, now.viewport));
      }, []);

      useEffect(() => {
        if (!nodeKey || !lesson) return undefined;
        canFlushRef.current = true;
        return () => {
          const run = restoreRef.current;
          if (run.frame) cancelRaf(run.frame);
          run.frame = 0;
          run.done = true;
          flush();
        };
      }, [nodeKey, lesson, flush]);

      // 监听装在正文那个滚动区上而不是 window：右栏展开会改中间栏宽度，但滚动只在正文区发生。
      // 同时挂一份到 window 的捕获阶段：宿主若在哪一层吞掉滚动事件，这里还拿得到。
      useEffect(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return undefined;
        const onScroll = () => {
          const run = restoreRef.current;
          if (run.programmatic) { run.programmatic = false; return; }   // 恢复自己滚的那一下不算学生的动作
          capture();
        };
        scroller.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('scroll', onScroll, { passive: true, capture: true });
        // 换宽度 → 正文重排 → 同一像素会落到别的小节上，所以尺寸一变就重新锚一次
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reflow) : null;
        if (observer) observer.observe(scroller);
        return () => {
          scroller.removeEventListener('scroll', onScroll);
          window.removeEventListener('scroll', onScroll, { capture: true });
          if (observer) observer.disconnect();
        };
      }, [nodeKey, lesson, capture, reflow]);

      // 上屏后从本地偏好里恢复。滚动时捕获的那一份只是「上屏那一刻的量」，
      // 所以进这一篇的第一帧要多量一次——正文里的小节几何是渲染之后才有的。
      useEffect(() => {
        const scroller = scrollerRef.current;
        if (!scroller || !lesson) return undefined;
        const run = restoreRef.current;
        run.done = false;
        run.attempts = 0;
        run.startedAt = Date.now();
        run.frame = raf(applyRestore);
        return () => {
          if (run.frame) cancelRaf(run.frame);
          run.frame = 0;
          run.done = true;
        };
      }, [nodeKey, lesson, applyRestore]);

      /**
       * 当前阅读位置的只读读数，挂成 DOM 属性。
       * 位置是「滚动/切视图那一瞬间才成立」的东西，肉眼与截图都看不出对错，所以给浏览器
       * 套件留一个能读的出口（`scripts/tests/browser/reading_position_test.mjs`）。
       * 它**不参与排版**（挂在 `hidden` 上），也不是给学生看的控件。
       */
      const mdAttrs = useCallback(() => {
        const scroller = scrollerRef.current;
        const last = lastRef.current;
        if (!scroller || !last) return ' data-section-offset="0" data-top="0"';
        const at = readingPositionOf(last.sections, scroller.scrollTop, last.maxScroll);
        return ' data-section-offset="' + Math.round(at.offset) + '" data-top="' + Math.round(scroller.scrollTop) + '"';
      }, []);

      return { bodyRef, section, attach, mdAttrs };
    }

    /* ═══════════════════════════════════════════════════════════════════════
       阅读端本体
       ═══════════════════════════════════════════════════════════════════════ */

    const TIERS = ['未开始', '学习中', '已学完'];

    /* ── 「未变即同引用」（#74）──────────────────────────────────────────────
       推送只说明「变了」，不知道变的是哪一片（通知会去抖合并，域只是提示）。
       所以收到通知仍旧整份重取 GET /api/studymate/library——但**不要**把新对象
       整个塞进 state：`data.subjects` 这类顶层键换个引用，就会把所有
       `useMemo(…, [subjects])` 的视图击穿重渲，改一个课件文件等于整页重算。

       规则：**逐层比较，没变的直接沿用上一轮的对象**——
         · 顶层键：内容一样就沿用 `prev[key]`（包括整个 `subjects` 数组）；
         · `subjects` 再按 slug 比一层：只改了一个科目，别的科目对象也不换引用。
       比较走 JSON 文本：payload 本来就是 JSON，比手写深比较短、也没有漏字段的风险；
       代价是每次重取序列化两遍，而发生频率是「有推送/手动重取」的量级，不是每帧。 */

    function sameJsonValue(a, b) {
      if (a === b) return true;
      if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
      try { return JSON.stringify(a) === JSON.stringify(b); } catch (error) { return false; }
    }

    /** 顶层键逐个比较：没变的沿用上一轮那个对象。 */
    function carryUnchangedKeys(prev, next) {
      if (!prev || typeof prev !== 'object' || !next || typeof next !== 'object') return next;
      const merged = {};
      for (const key of Object.keys(next)) {
        merged[key] = Object.prototype.hasOwnProperty.call(prev, key) && sameJsonValue(prev[key], next[key])
          ? prev[key]
          : next[key];
      }
      return merged;
    }

    /** 科目数组按 slug 配对：内容没变的科目对象沿用上一轮的那个。 */
    function carryUnchangedSubjects(prevSubjects, nextSubjects) {
      if (!Array.isArray(prevSubjects) || !Array.isArray(nextSubjects)) return nextSubjects;
      const before = new Map(prevSubjects.map((subject) => [subject && subject.slug, subject]));
      return nextSubjects.map((subject) => {
        const previous = before.get(subject && subject.slug);
        return previous && sameJsonValue(previous, subject) ? previous : subject;
      });
    }

    /** 重取回来的整份 payload → 与上一轮合并（同引用的那一份）。 */
    function mergeLibraryData(prev, next) {
      const merged = carryUnchangedKeys(prev, next);
      // `merged.subjects === next.subjects` 才说明这一片真的变了（没变的话上面已经沿用了旧的）
      if (next && merged.subjects === next.subjects) {
        merged.subjects = carryUnchangedSubjects(prev && prev.subjects, next.subjects);
      }
      return merged;
    }

    function useLibrary() {
      // readSeq = 这次读数**开始**时的本地动作序号（栅栏的刻度，见 mergeNodeAttempts）
      const [state, setState] = useState({ status: 'loading', data: null, error: '', readSeq: 0 });
      // 合并轮询：读在飞时不排队，只记一个「回来之后再补读一次」。作答连点五下也只会多跑一趟，
      // 而不是五份快照一起回来、后到的那个说了算（那正是陈旧响应覆盖新作答的经典死法）。
      const inFlight = useRef(false);
      const trailing = useRef(false);
      // silent = 后台重读：保留当前画面，拿到新数据再换。
      // 写完一份参考资料要重读一次；如果这一下把整页打回「正在读…」，刚写成的回执与
      // 滚动位置都会被清掉（踩过），所以刷新必须是无闪烁的。
      const load = useCallback((silent) => {
        if (inFlight.current) { trailing.current = true; return; }
        inFlight.current = true;
        const readSeq = attemptSeqNow();
        setState((prev) => (silent && prev.data ? prev : { status: 'loading', data: null, error: '', readSeq: prev.readSeq }));
        const settle = () => {
          inFlight.current = false;
          if (!trailing.current) return;
          trailing.current = false;
          load(true);   // 合并掉的那些请求，补一次
        };
        fetch(LIBRARY_ENDPOINT, { headers: { accept: 'application/json' } })
          .then(async (response) => {
            // Host 半出错时回 500 + `{ ok:false, error:{ code, message } }`（唯一信封，见
            // lib/route-envelope.ts）：把那句话原样带给学生，别只丢一个状态码
            const body = await response.json().catch(() => null);
            if (!response.ok) throw new Error(routeMessage(body) || ('HTTP ' + response.status));
            if (!body) throw new Error('返回的不是 JSON');
            return body;
          })
          .then((data) => {
            setState((prev) => ({
              status: 'ready',
              // 只在「上一轮已经有数据」时合并：首次加载 / 出错重试没有可沿用的引用。
              // 没变的那几片沿用 prev 里的同一个对象（#74「未变即同引用」）。
              data: prev.data ? mergeLibraryData(prev.data, data) : data,
              error: '',
              readSeq,
            }));
            settle();
          })
          .catch((error) => {
            // 静默重读失败（网络抖一下）：画面留着——把学生读到一半的课件打回错误页，
            // 比这一趟没刷成更糟。首次加载失败才进错误页。
            const message = String((error && error.message) || error);
            setState((prev) => (silent && prev.data
              ? Object.assign({}, prev, { error: message })
              : { status: 'error', data: null, error: message, readSeq: prev.readSeq }));
            settle();
          });
      }, []);
      useEffect(() => { load(false); }, [load]);

      // 变更推送：Host 半一变就推一条通知，这里静默重取（重取仍按上面的规则沿用旧引用）。
      // 不用定时器轮询——浏览器的 timer 全局是被宿主屏蔽的，而这里也不需要：
      // 断了由 EventSource 自己重连，重连成功（onopen）时补一次对账。
      useEffect(() => {
        if (typeof EventSource !== 'function') return undefined;
        let opened = false;
        const source = new EventSource(EVENTS_ENDPOINT);
        source.onopen = () => {
          // 重连期间发生的改动不会有补发，所以「重新连上」本身要触发一次重取；
          // 首次连上也会走这里：挂载时的 fetch 与建连之间那段窗口可能漏掉一次变更。
          if (opened) load(true);
          opened = true;
        };
        source.onmessage = (event) => {
          let notice = null;
          try { notice = JSON.parse(event.data); } catch (error) { return; }
          if (notice && notice.kind === 'changed') load(true);
        };
        source.onerror = () => {
          // 老宿主没有这条路由：没连上过就关掉，别让 EventSource 每几秒重试一次
          if (!opened) source.close();
        };
        return () => source.close();
      }, [load]);

      return [state, load];
    }

    /** 供界面用的重读句柄：一律走静默刷新。 */
    function useRefresh(load) {
      return useCallback(() => load(true), [load]);
    }

    /* ── 第一级 · 主页（工作台）────────────────────────────────────────────── */

    /**
     * 主卡放哪一门：最近改过进度的那门（`progress.yaml` 的 `updated_at`）。
     * `subjects` 由 `lib/library.ts` 按目录序 push，**本身没有排序**，所以这里得自己排；
     * 只看「最后一次改动」，不看掌握度、不看节点多少。
     */
    function lastTouched(subjects) {
      let best = null;
      for (const subject of subjects) {
        if (!best || String(subject.updated_at || '') > String(best.updated_at || '')) best = subject;
      }
      return best;
    }

    /**
     * 主卡「接着上次」：**只有一张**，落到最近那门的 continue_node。
     *
     * 第一屏要给的是「去哪继续」这两件事：**哪一课**（科目 + 位次 + 标题 + 目标）与
     * **怎么进去**（整张卡就是一个按钮）。所以它排在科目列表之前、紧跟着标题——
     * 学生不用先在一列科目里找「上次读到哪」。
     *
     * 标题按状态说实话：这门课一个节点都没动过时（新建的科目 / 还没有 progress.yaml）
     * 说「接着上次」是在编故事，改说「从这里开始」，动作也跟着从「继续读」变成「开始读」。
     */
    function ContinueCard({ subjects, onLesson }) {
      const subject = lastTouched(subjects);
      if (!subject) return null;
      const node = subject.nodes.find((n) => n.id === subject.continue_node) || subject.nodes[0];
      if (!node) {
        return h('section.smb-block', null,
          h('h2.smb-block__title', null, '从这里开始'),
          h('div.smb-empty', null, subject.name + ' 还没有节点。'));
      }
      const note = (node.notes || '').split(/(?<=[。！？；])/)[0] || '';
      const done = subject.stats['已学完'] || 0;
      const total = subject.nodes.length;
      // 动过没有：学过完的、或正学着的那一档有计数，就算「上次读到过」
      const started = done + (subject.stats['学习中'] || 0) > 0;

      return h('section.smb-block', null,
        h('h2.smb-block__title', null, started ? '接着上次' : '从这里开始'),
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
            h('span.smb-continue__go', null,
              node.lesson_md ? (started ? '继续读 →' : '开始读 →') : '还没有课件'))));
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
          setReading({ entry, text: response.ok && payload ? (payload.text || '') : (routeMessage(payload) || ('HTTP ' + response.status)) });
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
            setNote({ bad: true, text: routeMessage(payload) || ('HTTP ' + response.status) });
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
    function QuizCard({ anchor, index, node, subject, attempts, record, labRuns, onLabRun }) {
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

      return h('div', null, questions.map((item, qi) => {
        const stateKey = node.id + '|' + anchor.keys[0] + '|' + qi;
        return h(Question, {
          key: qi, item, index: qi, node, subject, stateKey,
          chosen: chosen[qi], self: self[qi], attempts, record,
          // 代跑那一块（#77）：这一次的运行状态按 stateKey 取；入口交给上层（它才知道科目 slug
          // 与写队列）。只有交付物题会用到它们（Question 里按题型分派）。
          lab: labRuns ? labRuns.get(stateKey) : undefined, onLabRun,
          onChoose: (choice) => setChosen((prev) => Object.assign({}, prev, { [qi]: choice })),
          onSelf: (label) => setSelf((prev) => Object.assign({}, prev, { [qi]: label })),
        });
      }));
    }

    /**
     * 正文里的题目标记：正文流里**只留这一颗**，题面与判分都在右栏（规格 §7.2）。
     * 点它 → 右栏滑出并定位到那道题（§4.4）。
     *
     * 组号（#89 条目 16）：标记头上那个圆圈是**组的编号**，与右栏 `.smb-agroup__no` 里的
     * 是同一个数（都从 1 数起），所以「这一颗对应右栏第几组」不用点开就知道；
     * 组号后的文字是这一组的锚点原文。点开之后右栏哪一组是「当前」，是 #93 的活。
     */
    function QuizMarker({ anchor, index, count, onOpen }) {
      const state = anchor.resolution || 'missing';
      const group = String((Number(index) || 0) + 1);
      return h('button.smb-qmark', {
        'data-proto': 'quiz-marker', 'data-state': state, 'data-group': group,
        title: '在右栏打开第 ' + group + ' 组题',
        onClick: () => onOpen(index),
      },
        h('span.smb-qmark__no', null, group),
        h('span.smb-qmark__badge', null, '练习'),
        h('span.smb-qmark__text', null, anchor.text || '（没有锚点文字）'),
        h('span.smb-spacer'),
        state === 'resolved'
          ? h('span.smb-qmark__n', null, count + ' 题')
          : h('span.smb-qmark__n.smb-qmark__n--warn', null, STATE_TEXT[state]),
        h('span.smb-qmark__go', { 'aria-hidden': 'true' }, '→'));
    }

    /** 右栏「题目」tab 里的一张锚点卡：可折叠，头上有编号与题数。 */
    function AnchorGroup({ group, node, subject, attempts, record, labRuns, onLabRun, current }) {
      const [open, setOpen] = useState(true);
      const state = group.anchor.resolution || 'missing';
      return h('section.smb-agroup', {
        id: 'smb-anchor-' + group.index, 'data-anchor': group.index,
        // 「当前」= 学生刚在正文里点开的那一组（#93 条目 18）。标记源只有 Inspector 一处，
        // 这里只负责把它画出来：属性与样式同源（.smb-agroup[aria-current="true"]）。
        'aria-current': current ? 'true' : null,
      },
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
          h(QuizCard, {
            anchor: group.anchor, index: group.index, node, subject, attempts, record, labRuns, onLabRun,
          })) : null);
    }

    /** 「题目」tab 的主体：节内进度 + 编号跳转 + 每组一张卡。 */
    function QuestionList({ node, subject, groups, total, answered, attempts, record, labRuns, onLabRun, current }) {
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
        groups.map((group) => h(AnchorGroup, {
          key: group.index, group, node, subject, attempts, record, labRuns, onLabRun,
          current: group.index === current,
        })));
    }

    /**
     * 右栏检查器（规格 §4.1）：`题目` / `问答` 两个 tab。
     * `focus` 每次点标记都换一个新对象，所以同一个标记连点两次也会重新滚过去；
     * 它同时带着**哪一课**（`node`）——换课之后那一组不该还自称「当前」（#93 条目 18）。
     */
    function Inspector({ tab, onTab, node, subject, groups, total, answered, attempts, record, labRuns, onLabRun, focus, quote, onQuoteClear, host }) {
      const bodyRef = useRef(null);
      // 只有「这一课里点过的那一组」才算当前：focus 是 LessonPage 的状态，换课不重挂，
      // 不按 node 收一下的话，下一课会凭空冒出一个「当前」标记（点都没点过）。
      const current = focus && focus.node === node.id ? focus.index : null;

      useEffect(() => {
        const root = bodyRef.current;
        if (!root || !focus || focus.node !== node.id) return;
        const el = root.querySelector('[data-anchor="' + focus.index + '"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, [focus, tab, node.id]);

      return h('div.smb-inspector', null,
        h('div.smb-right__tabs', { role: 'tablist' },
          h('button.smb-rtab', {
            role: 'tab', 'aria-selected': tab === '题目' ? 'true' : 'false', 'data-proto': 'tab-quiz',
            onClick: () => onTab('题目'),
          }, '题目', total ? h('span.smb-right__n', null, String(total)) : null),
          h('button.smb-rtab', {
            role: 'tab', 'aria-selected': tab === '问答' ? 'true' : 'false', 'data-proto': 'tab-ask',
            onClick: () => onTab('问答'),
          }, '问答')),
        h('div.smb-right__body', { ref: bodyRef, role: 'tabpanel', 'aria-label': tab },
          tab === '题目'
            ? h(QuestionList, { node, subject, groups, total, answered, attempts, record, labRuns, onLabRun, current })
            // `key` 按这一课认：切节点时把面板重挂一遍——它手里的会话与那条 retain 都跟着换，
            // 否则下一课会带着上一课的答疑会话（引用本身住在 StudyMateApp，不受重挂影响）
            : h(AskPanel, { key: subject.slug + '/' + node.id, subject, node, quote, onQuoteClear, host })));
    }

    /* ── 栏宽：左右各记一份，住在浏览器本地偏好里（规格 §4.4）─────────────────
       与主题、动效档同级：换科目、换层级都不变，**收起不丢宽度**。
       两条规则抄自宿主（`dsh-client-ui-layout` 的 `stores.d.ts` 写明）：
         · 拖拽写入按**当前画布**的区间 clamp——所以存下来的值不会超过当时画布允许的范围；
         · **响应式让步绝不覆写已存的宽度**——画布变窄只是收起，变宽后自动恢复。
       localStorage 在无痕模式里会抛，读写都包一层，读不到就用默认宽。 */

    const PANE_KEY = 'studymate.panes.v1';
    const PANE_LIMITS = { left: { min: 200, max: 460, fallback: 264 }, right: { min: 280, max: 640, fallback: 372 } };
    const MIN_CENTER = 420;   // 中间栏的保底宽度
    /* 抽屉铺开时给正文留的那条缝。窄画布上「读正文」与「看题」没法两全，但整屏盖住
       等于把正文弄丢了——留一条缝，学生至少知道正文还在那儿、收起就回来。 */
    const DRAWER_SLIT = 48;

    /* 窄轨的宽（两条加起来）**不是这儿的常量**：唯一出处是样式表里的 `--smb-rail`，
       脚本侧量渲染出来的窄轨（LessonPage 的 measure 里那段），再当参数传进下面的几何。
       ADR-0011 记的「38px 在样式表与脚本里各写一遍、把手偏移又各自重算 38 + width − 3」
       就是这条收掉的东西——量出来的值不会与视觉漂。 */

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
     * 按当前画布算三栏（ADR-0011：右栏先拿、左栏先让、中栏永远保底 MIN_CENTER）。
     * `rails` 是两条窄轨的实际总宽（量出来的），`asked` 是学生最近要的那一栏。
     * 只读存下来的宽度，**绝不回写**：让步是临时的，画布变宽要能自动恢复。
     *
     * 并排装不下时**不静默归零**：点「题目」没反应、而选项只在右栏渲染，学生就做不了题
     * （父 spec #84 的现状与差距三）。这一栏改成**盖在正文上的抽屉**（`drawer`），宽度
     * 照旧按记忆值与当前画布 clamp、不写回记忆值。抽屉只给**最近要的那一栏**（`asked`）：
     * 画布都判定「并排装不下」了，两栏都盖上来只会把正文盖没。
     */
    function planPanes(frame, want, stored, rails, asked) {
      const avail = Math.max(0, frame - rails - MIN_CENTER);
      let right = want.right ? Math.min(stored.right, avail) : 0;
      if (right < PANE_LIMITS.right.min) right = 0;
      let left = want.left ? Math.min(stored.left, Math.max(0, avail - right)) : 0;
      if (left < PANE_LIMITS.left.min) left = 0;

      const short = ['right', 'left'].filter((side) => want[side] && !(side === 'right' ? right : left));
      // 抽屉只给**最近要的那一栏**：学生点的是「题目」，就不该顺手把早先要过的左栏
      // 盖到正文上来。要过、后来并排不下的那一栏仍旧收起（窄轨上的 aria-expanded 是真话，
      // 再点一次它就换成抽屉）。
      const owner = short.indexOf(asked) >= 0 ? asked : null;
      if (!owner) return { left, right, drawer: null };
      // 已经并排好的那一栏不动：开一栏不该把另一栏关掉。
      const other = owner === 'left' ? right : left;
      return {
        left, right,
        drawer: { side: owner, width: drawerWidth(owner, stored[owner], frame, rails, other) },
      };
    }

    /** 抽屉的宽：按记忆值与当前画布 clamp（留一条缝给正文），**绝不越过画布**，
        越过就会给三栏壳拉出一条横向滚动条。 */
    function drawerWidth(side, stored, frame, rails, other) {
      const usable = Math.max(0, frame - rails - other - DRAWER_SLIT);
      return Math.round(Math.min(usable, Math.max(PANE_LIMITS[side].min, stored)));
    }

    /** 拖拽/按键写入前按当前画布 clamp（规格 §4.4 第一条）。 */
    function clampPane(side, wanted, frame, rails, other) {
      const limits = PANE_LIMITS[side];
      const room = Math.max(limits.min, frame - rails - MIN_CENTER - other);
      return Math.round(Math.min(limits.max, room, Math.max(limits.min, wanted)));
    }

    /** 抽屉的拖拽 clamp：抽屉不占并排预算，只受「给正文留一条缝」与画布本身限制。 */
    function clampDrawer(side, wanted, frame, rails, other) {
      const limits = PANE_LIMITS[side];
      const room = Math.max(limits.min, frame - rails - other - DRAWER_SLIT);
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
     * 画布装不下并排时的降级形态：这一栏**盖在正文上**，顶上一条看得见的说明 + 一条出路。
     * 「说明」回答为什么它不并排，「出路」是这一栏照样能用——学生点得到、做得成题。
     * 只有画布不足时才走到这里（planPanes 算出来装不下），所以不必再解释别的。
     *
     * 内容用 `body` 传而不是 `children`：夹具用的 mini-react 不是真 React，它调函数组件时
     * 不把 children 放进 props（`Fold` 那几个折叠块在套件里就是这么渲染成空壳的）。而
     * 「抽屉里的题目点得到、选得动」正是 #88 要取证的东西——用 children 的话套件里取不到。
     */
    function PaneDrawer({ side, width, label, body, onClose }) {
      return h('aside.smb-drawer.smb-drawer--' + side, {
        style: { width: width + 'px' }, 'data-proto': 'pane-drawer', 'data-side': side,
      },
        h('div.smb-drawer__note', null,
          h('b', null, '窗口太窄'),
          h('span', null, '装不下并排的' + label + '栏，先盖在正文上；拉宽窗口就并排。'),
          h('button.smb-btn', { 'data-proto': 'pane-drawer-close', onClick: onClose }, '收起')),
        h('div.smb-drawer__body', null, body));
    }

    /**
     * 第三级 · 课件阅读页（**三栏**）。规格 §4.1：
     * 左导航 / 中正文 / 右检查器，左右栏**默认收起**——读正文时不该被抢宽度，
     * 收起时各留一条窄轨，点一下就滑出来；正文里的题目标记直接展开右栏并定位。
     */
    function LessonPage({ subject, node, lesson, attempts, record, labRuns, onLabRun, onLesson, onQuote, quote, onQuoteClear, widths, onResizePane, host }) {
      const [wantLeft, setWantLeft] = useState(false);
      const [wantRight, setWantRight] = useState(false);
      // 学生最近要的那一栏：画布只够让一栏降级成抽屉时，这个位归它（见 planPanes）
      const [asked, setAsked] = useState(null);
      const [tab, setTab] = useState('题目');
      const [focus, setFocus] = useState(null);
      const frameRef = useRef(null);
      // 正文滚动区的位置与「读到哪一节」都归它管（切视图回来要回到原位，见 #76）
      const reading = useReadingPosition(subject.slug + '/' + node.id, lesson);
      const bodyRef = reading.bodyRef;
      const activeSection = reading.section;
      // 先拿视口宽当第一猜，ResizeObserver 量到真画布后立刻纠正——不然首帧两条栏会闪一下
      const [frame, setFrame] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth));
      // 两条窄轨的实际总宽。0 是「还没量到」：两条栏默认收起，这一帧算出来的栏宽与它无关，
      // 量到之后（effect 就在挂载后跑）才可能有人点开栏。
      const [rails, setRails] = useState(0);

      useEffect(() => {
        const root = frameRef.current;
        if (!root) return undefined;
        const measure = () => {
          setFrame(root.getBoundingClientRect().width);
          // 窄轨宽从**渲染出来的窄轨**上量：宽的唯一出处是 CSS 的 --smb-rail（别在这儿再写一遍）
          let total = 0;
          const bars = root.querySelectorAll('.smb-railbar');
          bars.forEach((bar) => { total += bar.getBoundingClientRect().width; });
          if (bars.length) setRails(Math.round(total));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(root);
        return () => observer.disconnect();
      }, []);

      useEffect(() => {
        // document 级的 mouseup 会在**每一次**点击后冒上来：点输入框、点面板别处、切 tab 都会
        // 让浏览器把文档选区折叠成空。所以这里读到的「空」只说明**这一次**没划中，不能当成
        // 「学生不要这段引用了」——`captureQuote` 读不出合格的一段时返回上一份（同引用），
        // 状态因此一动不动。别把这里改回 `onQuote(readQuote(...) || null)`：那正是 #92 的病根。
        const onUp = () => {
          const live = window.getSelection();
          const lessonFile = node.lesson || '';
          onQuote((prev) => captureQuote(prev, live, bodyRef.current, lessonFile));
        };
        document.addEventListener('mouseup', onUp);
        return () => document.removeEventListener('mouseup', onUp);
      }, [onQuote, bodyRef, node.lesson]);

      // 存下来的宽度 → 实际宽度（并排装不下就降级成抽屉，见 planPanes）；
      // want* 是学生的意图，不因画布变化被改掉
      const plan = planPanes(frame, { left: wantLeft, right: wantRight }, widths, rails, asked);
      const leftWidth = plan.left;
      const rightWidth = plan.right;
      const leftDrawer = plan.drawer && plan.drawer.side === 'left' ? plan.drawer.width : 0;
      const rightDrawer = plan.drawer && plan.drawer.side === 'right' ? plan.drawer.width : 0;
      // 'column' 并排 / 'drawer' 盖在正文上 / 'off' 收起。窄轨与把手两种开着的样子都要认
      const leftMode = leftWidth > 0 ? 'column' : (leftDrawer ? 'drawer' : 'off');
      const rightMode = rightWidth > 0 ? 'column' : (rightDrawer ? 'drawer' : 'off');
      const leftOpen = leftMode !== 'off';
      const rightOpen = rightMode !== 'off';
      // 开着的栏是哪种形态，就把把手贴到哪种形态的内侧边缘上：抽屉也要能拖（拖的是它的宽）
      const handleAt = (mode, column, drawer) => rails + (mode === 'drawer' ? drawer : column);
      const resize = useCallback((side, wanted) => {
        const other = side === 'left' ? rightWidth : leftWidth;
        const drawer = (side === 'left' ? leftMode : rightMode) === 'drawer';
        onResizePane(side, drawer
          ? clampDrawer(side, wanted, frame, rails, other)
          : clampPane(side, wanted, frame, rails, other));
      }, [frame, rails, leftWidth, rightWidth, leftMode, rightMode, onResizePane]);
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
        setAsked('right');
        if (wantRight && tab === name) { setWantRight(false); return; }
        setTab(name);
        setWantRight(true);
      };
      const openQuestion = (index) => { setAsked('right'); setTab('题目'); setWantRight(true); setFocus({ index, node: node.id }); };

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
      // 引用跟着它来的那一课走。状态**不因换视图/换课被清**（清除只有两处，见最外层那份
      // state 的注释），但只有回到那一课的课件页才拿到面板上：别的课的引用混进这一课的提问，
      // 送出去的锚点与 `node` 就对不上了——那比没有引用更坏。
      const lessonFile = node.lesson || '';
      const liveQuote = quote && quote.anchor && quote.anchor.lesson === lessonFile ? quote : null;

      // 两条栏的内容先取出来：同一份要挨着两种形态用（并排的一栏 / 盖在正文上的抽屉）
      const nav = h(LessonNav, { subject, node, onLesson });
      const inspector = h(Inspector, {
        tab, onTab: (name) => { setAsked('right'); setTab(name); }, node, subject, groups, total, answered,
        attempts, record, labRuns, onLabRun, focus, quote: liveQuote, onQuoteClear, host,
      });

      return h('div.smb-lesson', {
        ref: frameRef,
        'data-left': leftOpen ? '1' : '0', 'data-right': rightOpen ? '1' : '0',
        // 形态也报出来：套件按它分辨「并排」与「盖在正文上」，人看截图时也少猜一层
        'data-left-mode': leftMode, 'data-right-mode': rightMode,
      },
        h('div.smb-railbar', null,
          h('button.smb-rail', {
            'data-proto': 'toggle-left', 'aria-expanded': leftOpen ? 'true' : 'false',
            title: leftOpen ? '收起节点树' : '展开节点树',
            onClick: () => { setAsked('left'); setWantLeft((v) => !v); },
          }, h('span.smb-rail__ico', { 'aria-hidden': 'true' }, '☰'), h('span.smb-rail__label', null, '节点'))),

        leftMode === 'column' ? h('aside.smb-left', { style: { width: leftWidth + 'px' } }, nav) : null,
        leftMode === 'drawer' ? h(PaneDrawer, {
          side: 'left', width: leftDrawer, label: '节点', body: nav, onClose: () => setWantLeft(false),
        }) : null,

        // 把手贴在每条栏的内侧边缘；收起时留在窄轨边上，拖一下即展开（规格 §4.4）
        h(PaneHandle, {
          side: 'left', base: widths.left, value: leftMode === 'drawer' ? leftDrawer : leftWidth,
          collapsed: !leftOpen,
          style: { left: handleAt(leftMode, leftWidth, leftDrawer) + 'px' },
          onResize: (next) => resize('left', next), onReset: () => reset('left'),
          onExpand: () => { setAsked('left'); setWantLeft(true); },
        }),

        h('div.smb-center', null,
          // 顶部**一条**（#89 条目 12）：第几课 + 课件标题 + 标签 + 小节跳转，右端是作答进度。
          // 原来标题与小节是两条，各自只占左边一小截；合成一条之后两样都在这条上，
          // 窄画布下这条自己换行（`.smb-center__head` 的 flex-wrap）。
          h('div.smb-center__head', null,
            h('span.smb-center__no', null, '第 ' + (node.number || '?') + ' 课'),
            h('span.smb-center__name', null, node.title),
            h('span.smb-chip.smb-chip--kind', null, node.kind),
            h('span.smb-chip.smb-chip--' + node.tier, { title: '旧词表：' + node.raw_status },
              h('i.smb-dot.smb-dot--' + node.tier), node.tier),
            node.lab ? h('span.smb-chip', null, 'lab') : null,
            // 小节跳转：原来在滚动区里 sticky 着（`.smb-secsbar`），现在挂在顶部这一条上——
            // 这一条不跟正文滚，所以跳转一直在，还不占正文的滚动高度。
            h('nav.smb-secs', { 'aria-label': '本节目录' }, lesson.sections.map((section) => h('button.smb-sec', {
              key: section.id, 'aria-current': section.index === activeSection ? 'true' : 'false',
              onClick: () => {
                const el = document.getElementById(section.id);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              },
            }, section.title))),
            h('span.smb-spacer'),
            h('span.smb-meta', null, '作答 ' + answered + '/' + total)),
          h('div.smb-center__body', { ref: reading.attach },
            h('article.smb-doc', null,
              h('header.smb-doc__head', null,
                h('p.smb-hero__eyebrow', null, subject.name + ' · 第 ' + (node.number || '?') + ' 课'),
                h('h1', null, node.title),
                node.objective ? h('p.smb-goal', null, h('b', null, '本节目标：'), inlineNodes(node.objective, 'goal')) : null),
              // 当前阅读位置的只读读数。挂在 `<template>` 里：它的内容不进渲染树、不参与
              // 排版、不会被任何选择器当正文——位置恢复只在滚动与切视图的那一瞬间成立，
              // 从外面看不见也测不到，所以留一个能读的出口给浏览器套件
              // （`scripts/tests/browser/reading_position_test.mjs`）。这不是给学生看的控件。
              h('template', {
                'data-proto': 'reading-position',
                // `<template>` 的子节点由浏览器搬进 content，React 认的是 innerHTML 属性，
                // 所以这里写成一串属性文本。值全是自己算出来的整数，没有外部输入。
                dangerouslySetInnerHTML: { __html: '<i data-section="' + activeSection + '"' + reading.mdAttrs() + '></i>' },
              }),
              lesson.sections.map((section) => h('section.smb-sec-block', { key: section.id, id: section.id, 'data-section': section.index },
                h('h2', null, section.title),
                h(Blocks, { blocks: section.blocks, ctx: markerCtx }))),
              node.lab ? h('section.smb-note.smb-note--brand', null,
                h('div', null,
                  h('b', null, '这一课的 lab · ' + node.lab.dir),
                  h('div', null, (node.lab.readme || '').split('\n').filter((l) => l.trim() && !l.startsWith('#'))[0] || ''),
                  h('div.smb-labfiles', null, node.lab.files.map((file, i) => h('code', { key: i }, file))),
                  h('div.smb-meta', null, '实操题的判分由 Host 半代跑你本地的测试命令，输出原样记进作答数据——' + '交付物题的「题目」tab 里有「跑一次」。'))) : null,
              h('nav.smb-navfoot', null,
                prev ? h('button.smb-btn', { onClick: () => onLesson(subject, prev.id) }, '← ' + prev.title) : h('span'),
                next ? h('button.smb-btn', { onClick: () => onLesson(subject, next.id) }, next.title + ' →') : h('span.smb-meta', null, '这是最后一个节点'))),

            liveQuote && !askOpen ? h('button.smb-askchip', {
              'data-proto': 'qa-chip',
              onClick: () => openTab('问答'),
            }, '就这段问一句') : null)),

        rightMode === 'column' ? h('aside.smb-right', { style: { width: rightWidth + 'px' } }, inspector) : null,
        // 并排给不了就盖在正文上：说明条 + 收起在 PaneDrawer 里，题目照样点得到（#88）
        rightMode === 'drawer' ? h(PaneDrawer, {
          side: 'right', width: rightDrawer, label: tab, body: inspector, onClose: () => setWantRight(false),
        }) : null,

        h(PaneHandle, {
          side: 'right', base: widths.right, value: rightMode === 'drawer' ? rightDrawer : rightWidth,
          collapsed: !rightOpen,
          style: { right: handleAt(rightMode, rightWidth, rightDrawer) + 'px' },
          onResize: (next) => resize('right', next), onReset: () => reset('right'),
          onExpand: () => { setAsked('right'); setWantRight(true); },
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

    /**
     * 一条命中「在哪」：**科目 → 节点 →** 这一条自己的补充（目标 / 选项 / 别名 / 日期…）。
     *
     * 为什么科目与节点排在最前：跨科目搜索里同一句话可能来自任何一门课，学生扫一眼就得看出
     * 「这条属于哪门科目、哪个节点」。这一行容不下时是被省略号截掉的，截掉的应该是补充，
     * 不是出处。节点为空的命中（术语 / 学习记录 / 误解只挂在科目上）就退到科目。
     *
     * 补充与类别同名时丢掉：没有 front matter 标题、又一个小节标题都没有的一课，隐含小节名
     * 恰好也叫「正文」（`parseLesson` 的兜底），不丢的话那一条会印成「正文 正文 正文」。
     */
    function hitWhere(hit) {
      const kind = KIND_LABEL[hit.kind] || hit.kind;
      return [
        hit.subject ? hit.subject.name : '',
        hit.node ? hit.node.title : '',
        hit.label === kind || hit.label === hit.kind ? '' : hit.label,
      ].map((one) => oneLine(one)).filter(Boolean).join(' · ');
    }
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
                    h('span.smb-hit__body', null,
                      h('span.smb-hit__text', null, hit.text.length > 96 ? hit.text.slice(0, 96) + '…' : hit.text),
                      h('span.smb-hit__where', null, hitWhere(hit)))))))));
    }

    /* ── 引用：选中正文的那一段，在捕获那一下冻成一条数据（#92）─────────────────

       为什么是**数据**而不是一个字符串：引用要能回答「这段是从哪来的」——它带着来源锚点
       （哪一课、哪一小节）。锚点必须在捕获那一下取，那之后 DOM 已经换了、实时选区也没了。

       为什么捕获函数返回的是「下一份」而不是「读到的那一份」：document 级的 mouseup 在每一次
       点击后都会冒上来，而点输入框、点面板别处、切 tab 都会让浏览器把文档选区折叠成空。
       「读到空」只说明**这一次**没划中，不说明学生不要这段引用了。所以读不出合格的一段时
       返回**上一份（同一个对象）**，React 靠同引用跳过重渲染，界面一动不动。
       清除只有两处：学生点引用上的「删掉」，或提交成功（面板那边）。 */

    /** 划中多短才算数（按**码位**数）：一两个字的选区多半是双击单词或误触，带进面板只是噪音。 */
    const QUOTE_MIN = 4;

    /** 起点落在哪一小节：沿父链往上找最近的 `section.smb-sec-block`（正文的每节都带 `data-section`）。 */
    function sectionOf(start, body) {
      let el = start && start.nodeType === 1 ? start : (start ? start.parentElement : null);
      while (el && el !== body) {
        if (el.getAttribute && el.getAttribute('data-section') !== null) {
          const head = el.querySelector ? el.querySelector('h2') : null;
          return { section: el.id || '', sectionTitle: head && head.textContent ? head.textContent.trim() : '' };
        }
        el = el.parentElement;
      }
      return { section: '', sectionTitle: '' };
    }

    /**
     * 读**这一次**的实时选区；读不出合格的一段返回 `null`。
     *
     * 四条判据缺一不可：有 range、文本够长、起点真的落在正文节点里。任何一条不成立都返回
     * `null`——调用方（`captureQuote`）据此**保留**已有的引用。别在这里返回空字符串或空引用：
     * 那会让「没划中」与「划了一段空的」变成同一件事，病根就是这么来的。
     */
    function readQuote(sel, body) {
      if (!sel || typeof sel.getRangeAt !== 'function' || sel.rangeCount === 0) return null;
      const text = String(sel).trim();
      if ([...text].length < QUOTE_MIN) return null;
      let range = null;
      try { range = sel.getRangeAt(0); } catch (error) { return null; }
      const start = range ? range.startContainer : null;
      if (!body || !start || typeof body.contains !== 'function' || !body.contains(start)) return null;
      const where = sectionOf(start, body);
      return { text, section: where.section, sectionTitle: where.sectionTitle };
    }

    /**
     * 捕获那一下：读到合格的一段就冻成 `{ text, anchor }` 换上去，读不出就**原样返回 prev**。
     * `lesson` 是这一课在工作区里的相对路径（`node.lesson`），也是「哪一课」那一半锚点。
     */
    function captureQuote(prev, sel, body, lesson) {
      const read = readQuote(sel, body);
      if (!read) return prev;
      return {
        text: read.text,
        anchor: { lesson: lesson || '', section: read.section, sectionTitle: read.sectionTitle },
      };
    }

    /** 引用来自哪：小节标题（没有就用小节 id）· 这一课的路径。缺哪一半就少写哪一半。 */
    function quoteSource(quote) {
      const anchor = (quote && quote.anchor) || {};
      const section = anchor.sectionTitle || anchor.section || '';
      return [section ? '小节「' + section + '」' : '', anchor.lesson || ''].filter(Boolean).join(' · ');
    }

    /* ── 引用 chip：`ref` 的编解码（#106）─────────────────────────────────────

       宿主那一侧的 `ref` **只是一个字符串**，没有单独的反序列化入口：`codec.serialize(ref)` 是
       「提交那一刻进消息的那段文字」的**唯一**出处。所以「原文 + 来源锚点（哪一课、哪一小节）」
       的编码/解码必须是一对纯函数，进出都从这里走（套件直接断言它们，见 TEST_HOOK）。

       形状选一行 JSON：中文原样、单行可读；`JSON.parse` 保证逐字往返，原文里有引号、换行、
       分隔符也不会歧义——自造分隔符做不到这一点。`ref` 会跟着草稿落盘（`clipboardText` 才是
       落盘投影），所以除了这几样别往里塞东西。 */

    /** 「文本 + 来源锚点」→ `ref`。空引用（没划中、太短）给空串，调用方据此什么都不做。 */
    function encodeQuoteRef(quote) {
      if (!quote || typeof quote.text !== 'string' || quote.text === '') return '';
      const anchor = quote.anchor || {};
      return JSON.stringify({
        v: 1,
        kind: QUOTE_REF_KIND,
        text: quote.text,
        lesson: String(anchor.lesson || ''),
        section: String(anchor.section || ''),
        sectionTitle: String(anchor.sectionTitle || ''),
      });
    }

    /** `ref` → `{ text, anchor }`；不是我们编的、或坏掉的给 `null`。codec 据此退回原文——
     *  宁可原样送出去，也不能让一次解码失败把整次发送拦下（宿主找不到 serializer 就是这么干的）。*/
    function decodeQuoteRef(ref) {
      if (typeof ref !== 'string' || ref === '') return null;
      let raw = null;
      try { raw = JSON.parse(ref); } catch (error) { return null; }
      if (!raw || raw.kind !== QUOTE_REF_KIND || typeof raw.text !== 'string' || raw.text === '') return null;
      return {
        text: raw.text,
        anchor: {
          lesson: String(raw.lesson || ''),
          section: String(raw.section || ''),
          sectionTitle: String(raw.sectionTitle || ''),
        },
      };
    }

    /** 一行化的短形态：换行/缩进压成空格，超长的截断（chip 的面、草稿占位都用它）。 */
    function shortQuote(text, max) {
      const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
      const cap = max || QUOTE_LABEL_MAX;
      const units = [...flat];
      return units.length > cap ? units.slice(0, cap).join('') + '…' : flat;
    }

    /** `codec.serialize` 的落点：提交那一刻进消息的那段文字——**原文 + 来源锚点**。 */
    function quoteForModel(ref) {
      const quote = decodeQuoteRef(ref);
      if (!quote) return String(ref == null ? '' : ref);
      const where = quoteSource(quote);
      return (where ? '【引用】' + where + '\n' : '【引用】') + quote.text;
    }

    /** `codec.clipboardText` 的落点：可读的短形态（草稿里的占位与剪贴板都走它）。 */
    function quoteForClipboard(ref) {
      const quote = decodeQuoteRef(ref);
      if (!quote) return String(ref == null ? '' : ref);
      const where = quoteSource(quote);
      return '【引用】' + shortQuote(quote.text) + (where ? '（' + where + '）' : '');
    }

    /** 插进草稿的那一颗 chip 的形状（宿主 `ReferenceInsert`）。空引用给 `null`。 */
    function referenceInsertFor(quote) {
      const ref = encodeQuoteRef(quote);
      if (!ref) return null;
      return {
        source: QUOTE_SOURCE_NAME,
        ref,
        label: shortQuote(quote.text),
        clipboardText: quoteForClipboard(ref),
      };
    }

    /** 每个会话当前那一颗引用（`Map<sessionId, quote>`）：**同一会话只挂一条**，新选区换掉旧的
     *  （不攒成两段）。会话 id 作键：多会话并行时各是各的。 */
    const quoteSlots = new Map();

    /**
     * 我们自己的引用来源（#106）。
     *
     * 它在**插件激活时**注册、随插件卸载注销——这一点是承重的：提交那一刻宿主按 `name` 找
     * owner 的 codec，找不到就抛 `no serializer for reference source`，**整次发送失败、草稿
     * 还给你**。所以别把它做成「面板打开时才注册」。
     *
     * `candidates` 读的是「这个会话此刻那条引用」（`@` 菜单的候选，也是 `onPick` 的数据源）；
     * `onPick` 走宿主的 pick 通道（坐标与 CAS 由 pipeline 负责）；**提交那段文字只由
     * `codec.serialize` 决定**——面板不往消息里拼一个字。
     */
    function quoteReferenceSource() {
      return {
        trigger: QUOTE_TRIGGER,
        name: QUOTE_SOURCE_NAME,
        showGroupTitle: false,
        candidates(session, req) {
          const quote = quoteSlots.get(session && session.sessionId);
          const insert = quote ? referenceInsertFor(quote) : null;
          if (!insert) return Promise.resolve([]);
          return Promise.resolve([{
            name: 'quote',
            label: shortQuote(quote.text),
            description: quoteSource(quote),
            value: insert.ref,
            section: '当前的引用',
          }]);
        },
        onPick(pick) {
          const quote = decodeQuoteRef(pick && pick.candidate && pick.candidate.value);
          const insert = quote ? referenceInsertFor(quote) : null;
          return insert ? { insert } : undefined;
        },
        codec: {
          clipboardText: (ref) => quoteForClipboard(ref),
          serialize: (ref) => Promise.resolve(quoteForModel(ref)),
        },
      };
    }

    /* ── 答疑会话：标题即识别、会话在哪（#105）────────────────────────────────
       会话由插件**宿主半**按「答疑模式」预设建（`POST /api/studymate/qa/session`）：客户端建
       不出来（`sessions.create` 会静默丢掉 `agentPreset`），所以客户端不建、也不另存一份 id
       清单——「上一段会话」与刷新后回到哪一条，全靠标题前缀认（spec #102 定死的机制）。
       下面这几个纯函数同时挂给 Node 套件（见 TEST_HOOK），拼法与宿主半 `lib/ask/session.ts`
       那一份必须逐字一致：那边拼、这边认。 */

    /** 展示名：科目用它的名字（没有就退回 slug），节点用它的标题（没有就退回 id）。 */
    function askSubjectLabel(subject) {
      if (!subject) return '';
      return String(subject.name || subject.slug || '').trim();
    }

    function askNodeLabel(node) {
      if (!node) return '';
      return String(node.title || node.id || '').trim();
    }

    /** 「答疑 · 科目 · 节点」：缺哪一节就少写哪一节，**不留空的分隔符**。 */
    function titleForAskSession(subject, node) {
      return [ASK_SESSION_PREFIX, subject, node]
        .map((part) => String(part == null ? '' : part).trim())
        .filter(Boolean).join(ASK_SESSION_SEP);
    }

    /** 这条标题是不是我们建的答疑会话：只认「答疑」+ 可选的一节或多节，不是「以答疑开头就算」。 */
    function isAskSessionTitle(title) {
      if (typeof title !== 'string') return false;
      const text = title.trim();
      if (text === ASK_SESSION_PREFIX) return true;
      const head = ASK_SESSION_PREFIX + ASK_SESSION_SEP;
      return text.startsWith(head) && text.length > head.length;
    }

    /** 会话列表的快照（`ObservableSnapshot`）；拿不到就是 null（更老的宿主里没有这个服务）。 */
    function sessionListState(sessions) {
      try {
        const list = sessions && sessions.list;
        return list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null;
      } catch (error) {
        return null;
      }
    }

    /** 「我们那几条」答疑会话：按标题前缀认，最近更新的在前。
     *  用 `title` 而不是 `displayTitle`——后者会按「持久标题 → 项目名 → 会话 id」退化，
     *  工作目录恰好以「答疑」开头的项目会误命中。`title` 是可缺的（宿主还没投影出持久标题），
     *  认不出就是「没有上一段会话」，不是错。 */
    function askSessionRows(sessions) {
      const state = sessionListState(sessions);
      if (!state || !Array.isArray(state.ids)) return [];
      const byId = state.byId || {};
      return state.ids.map((id) => byId[id]).filter(Boolean)
        .filter((row) => isAskSessionTitle(row.title))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    /** 当前科目/节点那一条（标题逐字相等）：同一课聊过两段就取最近的那一段。 */
    function latestAskSessionId(sessions, title) {
      const wanted = String(title || '').trim();
      const row = askSessionRows(sessions).find((item) => item.title === wanted);
      return row ? row.id : null;
    }

    /** 那条会话在单子上怎么写：有持久标题用它，没有退回宿主给的 displayTitle。 */
    function askSessionLabel(row) {
      return String((row && (row.title || row.displayTitle)) || '未命名会话');
    }

    /**
     * 宿主给客户端的那几件东西只能在 `apply(ctx)` 里拿（不是 props、更不是 import）：
     *   · `sessions`（#105）：面板 retain 那条答疑会话与列「上一段会话」都靠它；
     *   · `inputTriggers`（#106）：注册我们自己的引用来源（提交时那一刻它必须还在册）；
     *   · `conversation`（#106）：那条会话的输入门面，选中的那段就是从这里进草稿的。
     * 集中放这一处，别散进各个组件。
     */
    const askHost = { sessions: null, inputTriggers: null, conversation: null };

    /* ── 引用进草稿：插入 / 换掉 / 撤掉（#106）─────────────────────────────────
       宿主**没有提交钩子**，所以选中的那段必须在学生点发送之前就已经躺在草稿里——这就是这颗
       chip 是承重件、而不是装饰的原因。三件事都走那条会话的输入门面（`conversation.input.
       for(actx)`），`actx` 用我们 retain 的那条会话的 `reference.binding.ctx`。 */

    /** 那条会话的输入门面；拿不到（宿主没给服务 / 还没 retain / 老宿主）就是 null——调用方别当异常。 */
    function inputFacadeFor(held) {
      const conversation = askHost.conversation;
      const sessions = askHost.sessions;
      if (!conversation || !conversation.input || typeof conversation.input.for !== 'function') return null;
      let actx = null;
      try {
        if (held && held.reference && held.reference.binding) actx = held.reference.binding.ctx || null;
        if (!actx && held && held.id && sessions && typeof sessions.scope === 'function') actx = sessions.scope(held.id) || null;
      } catch (error) { actx = null; }
      if (!actx) return null;
      try { return conversation.input.for(actx); } catch (error) { return null; }
    }

    /** 草稿里我们那一颗 chip（宿主的 occurrence 视图按 `source` 认；坐标是草稿的剪贴板投影坐标）。 */
    function ourOccurrence(state) {
      const list = (state && state.occurrences) || [];
      for (const occurrence of list) {
        if (occurrence && occurrence.source === QUOTE_SOURCE_NAME) return occurrence;
      }
      return null;
    }

    /**
     * 把这一条引用放进那条会话的草稿：草稿里已经有一颗我们的 chip 就**换掉它那一颗**
     * （同一会话只挂一条），没有就落在草稿末尾。
     *
     * @returns `'same'`（已经是这一条）/ `'in'`（放进去了）/ `'failed'`（两次都没成）/
     *   `'unavailable'`（拿不到输入门面）。
     *
     * 为什么重试一次：`insertReference` 在坐标过期（`span.draftRev` 与编辑器当前 revision 不
     * 相等）或阶段不对时**静默返回 false**，不抛。重读状态再试一次多半就成；还不成就让调用方
     * 把话说明白（别静默丢）。
     */
    function putQuoteInDraft(held, quote) {
      const facade = inputFacadeFor(held);
      const state = facade && facade.state;
      if (!facade || !state || typeof state.getSnapshot !== 'function' || typeof facade.insertReference !== 'function') return 'unavailable';
      const insert = referenceInsertFor(quote);
      if (!insert) return 'failed';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const now = state.getSnapshot();
        const chip = ourOccurrence(now);
        if (chip && chip.ref === insert.ref) return 'same';
        const draft = String((now && now.draft) || '');
        const span = chip
          ? { start: chip.offset, end: chip.offset + chip.length, draftRev: now.draftRev }
          : { start: draft.length, end: draft.length, draftRev: now.draftRev };
        let applied = false;
        try { applied = facade.insertReference(insert, span) === true; } catch (error) { applied = false; }
        if (applied) return 'in';
      }
      return 'failed';
    }

    /**
     * 把草稿里我们那一颗 chip 撤掉（学生点 chip 上的「删掉」）。
     *
     * 先走带 revision CAS 的「把这一段换成空文本」——门面上那个方法就是宿主 `slash/input-insert-text`
     * 的落点（只动这一段，别的 chip 与打好的字都不碰）；门面上没有它（更老的宿主）就退回重设
     * 草稿（把这一段的占位从草稿里剪掉再写回去）。`@returns` `'gone'` / `'failed'` / `'unavailable'`。
     */
    function dropQuoteFromDraft(held) {
      const facade = inputFacadeFor(held);
      const state = facade && facade.state;
      if (!facade || !state || typeof state.getSnapshot !== 'function') return 'unavailable';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const now = state.getSnapshot();
        const chip = ourOccurrence(now);
        if (!chip) return 'gone';
        const span = { start: chip.offset, end: chip.offset + chip.length, draftRev: now.draftRev };
        let applied = false;
        try {
          if (typeof facade.insertText === 'function') applied = facade.insertText('', span) === true;
          else if (typeof facade.setDraft === 'function') {
            const draft = String((now && now.draft) || '');
            facade.setDraft(draft.slice(0, span.start) + draft.slice(span.end));
            applied = true;
          }
        } catch (error) { applied = false; }
        if (applied) return 'gone';
      }
      return 'failed';
    }


    /**
     * 「问答」tab 的主体（#105）：右栏里嵌的是**宿主自己的会话正文**——面板不再自己拼
     * messages、不再自己发请求（原来那条「面板独立调模型」的 `/ask` 路由由 #107 退役）。
     *
     * 面板只做四件事：
     *   · 找一条现成的答疑会话（标题前缀认、最近的一条）；一条都没有就请宿主半建一条
     *     ——不然宿主的 composer 没有会话可发；
     *   · `sessions.retain(id, { source: 'studymateAsk' })`，换会话/卸载时 `release()`；
     *   · 用框架给的 `SessionProvider` 把宿主正文（`conversation.content`）指向我们 retain
     *     的那一条：occurrence 的会话就是「调用点被哪个 SessionProvider 罩着」；
     *   · 顶上给「新对话」与「上一段会话」。
     *
     * 多轮、流式、滚动、草稿、Enter 发送、Shift+Enter 换行全归宿主那条正文；会话落在磁盘上，
     * 所以切 tab、关面板、刷新页面回来都还在。
     *
     * `host` 是框架交给这颗座位的标准件（`SessionProvider` / `renderSlot` / `renderFactorySlot`，
     * 由 `StudyMateApp` 一路传下来）。`SessionProvider` 只在**声明了非 root 子座位**的 entry 上
     * 才有，所以 `apply` 里 `main` 那条注册声明了 `studymate.ask.session`（见那里的注释）。
     * 这一票只用到 `SessionProvider` 与 `renderFactorySlot` 两件；`renderSlot` 是同一个 kit 的
     * 第三件，先跟着传（子座位由谁渲染是 #106 那条链的事）。
     *
     * `quote` 是学生**已经冻好的**那条引用（#92）：面板把它做成输入框上方那颗 chip（#106）——
     * 可点开看原文与它来自哪一小节、可自己删掉；同一会话只挂一条，再划一段就换掉旧的。
     * 真正的权威不在这一格 React state 里，而在**那条会话的草稿**里：宿主没有提交钩子，所以
     * 选中的那段必须在我们渲染这颗 chip 的同时就进草稿（走 `conversation.input.for(actx)
     * .insertReference`），提交时由我们注册的引用来源的 `codec.serialize` 决定进消息的文字。
     */
    function AskPanel({ subject, node, quote, host, onQuoteClear }) {
      const [sessionId, setSessionId] = useState(null);
      // 保住的那条会话：`{ id, reference }`。两格**一起**换——别留下「id 已经换了、引用还是
      // 上一条」的那一帧：那时引用已经被 release，塞给 SessionProvider 会让宿主的
      // bindingSource 抛「Session reference is not active in this Controller」。
      const [held, setHeld] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [menuOpen, setMenuOpen] = useState(false);
      // chip 点开看原文那一格。默认收起：chip 是输入框上方的附件，不该吃掉正文的高度。
      const [quoteOpen, setQuoteOpen] = useState(false);
      const creating = useRef(false);
      const title = titleForAskSession(askSubjectLabel(subject), askNodeLabel(node));
      const sessions = askHost.sessions;
      const kit = host || null;
      // 这一帧真正保住的那条会话（`held` 与 `sessionId` 对得上才算数；下面两个 effect 都读它，
      // 所以住在合成之前）。
      const live = held && held.id === sessionId ? held : null;

      /* 会话从哪来：现成的（标题认当前科目/节点）优先；一条都没有就请宿主半建一条。 */
      useEffect(() => {
        if (sessionId || !sessions) return undefined;
        const found = latestAskSessionId(sessions, title);
        if (found) { setSessionId(found); return undefined; }
        void createAskSession();
        return undefined;
        // createAskSession 每次渲染现造，它读的 subject/node 已经在那两个依赖里（见下面的 key）
      }, [sessionId, title, sessions]);

      /* 选中哪条就 retain 哪条；换会话 / 卸载时 release——不 release 那条会话永远不退休。 */
      useEffect(() => {
        if (!sessionId || !sessions || typeof sessions.retain !== 'function') return undefined;
        let reference = null;
        try {
          reference = sessions.retain(sessionId, { source: ASK_RETAIN_SOURCE });
        } catch (failure) {
          setError({ unavailable: false, reason: '这条会话引不住：' + String((failure && failure.message) || failure) });
          return undefined;
        }
        setHeld({ id: sessionId, reference });
        return () => {
          // 卸载 / 换会话才走这里。释放失败（已经释放过、或宿主换了代际）不值得把界面弄崩
          try { if (reference && typeof reference.release === 'function') reference.release(); } catch (ignored) { /* 随它 */ }
        };
      }, [sessionId, sessions]);

      /* 选中的那段进草稿（#106）：**面板一看见这条引用就把它放进那条会话的草稿**，不等学生
         再点一次什么。宿主没有提交钩子——草稿里没有这段，消息就不会带上它。

         `putQuoteInDraft` 认得「已经是我们这一条」：切 tab / 面板重挂回来时它返回 `'same'`，
         不会把同一段插成两颗。CAS 两次都没成（会话正在提交之类）时给一句可读的提示——别静默丢。 */
      useEffect(() => {
        if (!live || !quote) return undefined;
        const id = live.id;
        quoteSlots.set(id, quote);
        const outcome = putQuoteInDraft(live, quote);
        if (outcome === 'failed') {
          const facade = inputFacadeFor(live);
          try {
            if (facade && typeof facade.notify === 'function') {
              facade.notify('error', '这段引用没能进草稿（会话输入正在别的时候）。等它空下来再划一次。');
            }
          } catch (ignored) { /* 提示发不出去也不该把面板弄崩 */ }
        }
        return () => {
          // 面板卸载 / 换了引用：这个会话的槽位跟着让位（草稿里的 chip 不因此消失——它是宿主的）
          if (quoteSlots.get(id) === quote) quoteSlots.delete(id);
        };
      }, [live, quote]);

      /* 「只跟下一条消息走」的落点：消息**真的提交出去**时宿主会清草稿，我们那颗 chip 跟着
         没了——先看见过它、后来没了，就说明这条引用已经随消息进了会话，面板上这一颗让位给
         下一段（规范 §六）。提交被拦下、草稿被还原时 chip 会回来，引用也就留着：那一次什么都
         没送出去。学生自己点「删掉」也在本地先清了，这里再看见一次是空操作。 */
      useEffect(() => {
        if (!live || !quote) return undefined;
        const facade = inputFacadeFor(live);
        const state = facade && facade.state;
        if (!facade || !state || typeof state.subscribe !== 'function' || typeof state.getSnapshot !== 'function') return undefined;
        let present = !!ourOccurrence(state.getSnapshot());
        const look = () => {
          const there = !!ourOccurrence(state.getSnapshot());
          if (there) { present = true; return; }
          if (!present) return;
          present = false;
          if (typeof onQuoteClear === 'function') onQuoteClear();
        };
        let off = null;
        try { off = state.subscribe(look); } catch (error) { off = null; }
        return () => { if (typeof off === 'function') { try { off(); } catch (ignored) { /* 退订失败不值得弄崩界面 */ } } };
      }, [live, quote, onQuoteClear]);

      /** 学生点了 chip 上的「删掉」：把草稿里那颗也撤掉（不然下一问还带着它），再清本地那一格。
       *  清两次是无害的（`setQuote(null)` 幂等）：撤草稿那一下会让上面那条订阅也看见「没了」。 */
      function dropQuote() {
        const outcome = dropQuoteFromDraft(live);
        if (live) quoteSlots.delete(live.id);
        if (outcome === 'failed') {
          const facade = inputFacadeFor(live);
          try {
            if (facade && typeof facade.notify === 'function') {
              facade.notify('error', '这段引用没能从草稿里撤掉。发送前顺手把它删掉，或者再划一次。');
            }
          } catch (ignored) { /* 同上 */ }
        }
        if (typeof onQuoteClear === 'function') onQuoteClear();
      }

      /** 请宿主半建一条新的答疑会话；认下来之后 retain 它。 */
      async function createAskSession() {
        if (!sessions || creating.current) return;
        creating.current = true;
        setBusy(true);
        setError(null);
        try {
          const response = await fetch(QA_SESSION_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ subject: askSubjectLabel(subject), node: askNodeLabel(node) }),
          });
          const reply = await response.json().catch(() => null);
          const view = reply || { available: true, ok: false, error: { code: 'http-error', message: 'HTTP ' + response.status } };
          if (view.available === false || view.ok === false || !view.sessionId) {
            // 「没有可用模型」与「这条会话没建起来」是两件事，文案分开说（都如实、都不假装）
            setError({
              unavailable: view.available === false,
              reason: view.reason || routeMessage(view) || '宿主半没给出会话 id',
            });
            return;
          }
          setSessionId(view.sessionId);
          // 标题是刚落下去的：让宿主把列表重新投影一次，下次（刷新 / 切 tab 回来）才认得出这条前缀
          try { if (typeof sessions.refresh === 'function') void sessions.refresh(); } catch (ignored) { /* 刷新不了不影响这次会话 */ }
        } catch (failure) {
          setError({ unavailable: false, reason: '连不上建会话那条路由：' + String((failure && failure.message) || failure) });
        } finally {
          creating.current = false;
          setBusy(false);
        }
      }

      const rows = sessions ? askSessionRows(sessions) : [];
      const embeddable = !!(kit && kit.SessionProvider && kit.renderFactorySlot);
      const where = quote ? quoteSource(quote) : '';

      return h('div.smb-askbody', null,
        h('div.smb-ask__head', null,
          h('b', null, '答疑会话'),
          h('span.smb-spacer'),
          h('button.smb-btn', {
            type: 'button', 'data-proto': 'qa-new', disabled: busy,
            onClick: () => { void createAskSession(); },
          }, busy ? '正在开…' : '新对话'),
          h('button.smb-btn', {
            type: 'button', 'data-proto': 'qa-history', 'aria-expanded': menuOpen ? 'true' : 'false',
            onClick: () => setMenuOpen((open) => !open),
          }, '上一段会话')),

        // 「上一段会话」：只列答疑会话（标题前缀认），最近的在前；当前那条标一下
        menuOpen ? h('div.smb-askmenu', { 'data-proto': 'qa-history-list' },
          rows.length
            ? rows.map((row) => h('button.smb-askmenu__item', {
              key: row.id, type: 'button', 'data-proto': 'qa-history-item', 'data-session': row.id,
              onClick: () => { setSessionId(row.id); setMenuOpen(false); },
            }, h('span', null, askSessionLabel(row)),
              row.id === sessionId ? h('span.smb-meta', null, '当前') : null))
            : h('p.smb-block__hint', null, '还没有上一段答疑会话。')) : null,

        // 输入框上方的引用 chip（#106）：划中那段正文的落点。一行是「原文 + 来源小节」，
        // 点开看完整原文与它来自哪一小节，右边一颗「删掉」——删掉之后照常直接提问。
        quote ? h('div.smb-askquote', { 'data-proto': 'qa-quote', 'data-open': quoteOpen ? '1' : '0' },
          h('div.smb-askquote__row', null,
            h('button.smb-askquote__head', {
              type: 'button', 'data-proto': 'qa-quote-toggle', 'aria-expanded': quoteOpen ? 'true' : 'false',
              title: quoteOpen ? '收起原文' : '点开看原文与来源',
              onClick: () => setQuoteOpen((open) => !open),
            },
              h('span.smb-askquote__mark', { 'aria-hidden': 'true' }, '引用'),
              h('span.smb-askquote__text', null, shortQuote(quote.text))),
            h('button.smb-askquote__drop', {
              type: 'button', 'data-proto': 'qa-quote-clear', title: '不要这段引用了', onClick: dropQuote,
            }, '删掉')),
          h('div.smb-meta.smb-askquote__where', null, where ? '来源：' + where : '来源：当前课件'),
          quoteOpen ? h('div.smb-askquote__full', { 'data-proto': 'qa-quote-full' }, quote.text) : null) : null,

        h('p.smb-block__hint', null,
          '这条会话住在宿主里：多的轮次、流出来的回答、草稿都在它那边，侧边栏里也看得到、续得上。'),

        // 没有可用模型 / 会话没开起来：如实说明，不假装会答
        error ? h('div.smb-note.smb-note--warn', null, h('div', null,
          h('b', null, error.unavailable ? '这条链路上没有可用的模型' : '这条答疑会话没开起来'),
          h('div', null, error.reason),
          h('div.smb-meta', null, error.unavailable
            ? '面板不假装会答：模型没配好之前这条会话开不出来。配好模型再开一次。'
            : '这一格没有可发消息的地方；上面那句就是原因。'))) : null,

        // 宿主自己的会话正文：`variant:'embedded'` 不带主 Header 与宽度手柄、内容宽 920px，
        // composer 一起渲染——Enter 发送、Shift+Enter 换行就是它。**必须用 SessionProvider
        // 包住这个调用点**：occurrence 的会话 = 调用点所在的 React 子树被哪个 Provider 罩着。
        live && embeddable
          ? h('div.smb-asksession', null,
            h(kit.SessionProvider, { session: live.reference },
              kit.renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false })))
          : h('p.smb-block__hint', null,
            !kit
              ? '这个宿主没有把会话正文交给阅读端（没有 SessionProvider）：面板嵌不了宿主会话。'
              : !sessions
                ? '这个宿主没有把会话服务交给阅读端（ctx.sessions 不在）：面板引不住一条会话。'
                : error ? null
                  : busy ? '正在开一条答疑会话…' : '正在找这条会话…'));
    }

    /* ── 外壳：顶栏 + 三级 ─────────────────────────────────────────────────── */

    function TopBar({ view, subject, node, onHome, onSubject, onSearch, motion, onMotion }) {
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
        h(MotionPicker, { level: motion, onPick: onMotion }),
        h('button.smb-searchbtn', { onClick: onSearch, title: '搜索（⌘K）' }, '搜索', h('span.smb-kbd', null, '⌘K')));
    }

    /**
     * 阅读端本体（`main` 座位）。
     *
     * 那三个 props 是框架按**注册时的 children 声明**发下来的标准件（见文件末尾 `apply` 里
     * `main` 那条注册）：`SessionProvider` / `renderSlot` 要「children 里有非 root 座位」才有，
     * `renderFactorySlot` 无条件有。右栏「问答」那一格要用它们把宿主自己的会话正文嵌进来
     * （#105），所以这里原样接住、做成一份 `host` kit 交给那条链（别在中间层东拼西凑）。
     */
    function StudyMateApp({ SessionProvider, renderSlot, renderFactorySlot }) {
      const host = { SessionProvider, renderSlot, renderFactorySlot };
      const [library, load] = useLibrary();
      const reload = useRefresh(load);
      // 栏宽住在最外层：换科目、换层级都不变（规格 §4.4「宽度全局各记一份」）
      const [paneWidths, resizePane] = usePaneWidths();
      // 动效档同属浏览器本地偏好，也住最外层（规格 §4.4）
      const [motion, pickMotion] = useMotion();
      const [view, setView] = useState('home');
      const [slug, setSlug] = useState('');
      const [nodeId, setNodeId] = useState('');
      // 学生在正文里划出来的那一段（#92）。住在这里而不是 LessonPage 里：切 tab、点别处都会让
      // 面板重新挂载，引用必须比面板活得久。形状是**捕获那一下冻好的** `{ text, anchor }`，
      // 不是一个跟着实时选区跑的字符串。清除只有两处：学生点引用上的「删掉」，或提交成功——
      // 别在任何别的地方顺手 `setQuote(null)`（换视图、换课、切 tab、点输入框都不算）。
      const [quote, setQuote] = useState(null);
      // 学生点 chip 上的「删掉」走的门：清的是这一格（#106）。做成稳定的回调——面板里订阅草稿
      // 那两个 effect 把它列进依赖，每次渲染换一个新函数会让订阅反复重来。
      const clearQuote = useCallback(() => setQuote(null), []);
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

      /* 写队列：一份（科目 + 节点）一条，串行发。它是 useRef 里的单体——重挂/重渲染都不重排队，
         不然「点了两下」会被拆成两条互不知情的队列，第二笔必然带着过期版本号被拒。 */
      const writer = useRef(null);
      if (writer.current === null) {
        writer.current = createAttemptWriter({
          send: sendAttempt,
          // 写成了：回执里那份就是盘上的真相，直接覆盖这一题（`seq` 还是它自己的，所以回执
          // 盖得住自己那一条、盖不住比它更新的本地作答）
          onApplied: (job, body, note) => {
            const incoming = attemptsFromReceipt(job.node, body.attempts);
            setAttempts((prev) => mergeNodeAttempts(settleAttempt(prev, job, note), job.node, incoming, job.seq));
            reload();   // 顺带重读一次 payload（合并轮询：在飞时只记一笔，回来补读）
          },
          onRefused: (job, body, retrying) => {
            if (retrying) return;   // 还会自动重来一次：提示跟着成功那一路回去（见 deliver 的 keptNote）
            setAttempts((prev) => settleAttempt(prev, job, refusalNote(body, false)));
            reload();   // 冲突就是「盘上变了」的信号：重读一次，页面上其余部分也跟上
          },
        });
      }

      /**
       * 学生按了一下选项（或点了自评）：**先上屏、再排队落盘**。
       *
       * 乐观更新是有意的——作答的往返不该挡住界面；但 `pending` 与 `seq` 必须同时写上：
       * 前者让这次作答在落盘之前拒绝任何读数覆盖它，后者让它在落盘之后仍比旧读数新。
       */
      const record = useCallback((key, patch) => {
        const seq = (attemptClock.seq += 1);
        setAttempts((prev) => {
          const before = prev.get(key);
          const next = new Map(prev);
          next.set(key, Object.assign(
            { at: '刚刚', chosen: null, correct: false, self: undefined, reason: undefined },
            before,
            patch,
            // 新的一次作答：上一次的提示（冲突/失败）到此为止，pending 累加（可能连点两下）
            { seq, pending: (before && before.pending ? before.pending : 0) + 1, note: undefined },
          ));
          return next;
        });
        writer.current.push(attemptJob({
          subject: slug,
          node: String(key).split('|')[0],   // stateKey = <节点id>|<锚点>|<题号>
          stateKey: key,
          patch,
          seq,
          // 兜底用 payload 里那个版本号；正常情况下队列自己记着上一次回执给的版本（更准）
          expectedVersion: node && node.attempts ? node.attempts.version : '',
        }));
      }, [slug, node && node.id, node && node.attempts && node.attempts.version]);

      /* ── 实验代跑（#77）：学生按「跑一次」→ Host 半 → 事实回到这一题上 ──────────
         一条路走完：POST /api/studymate/lab-run（命令从题目里来，边界在 Host 半判）→ 回执里
         要么是事实（已经落进作答数据），要么是任务句柄（跑得久）→ 重读 payload 把落盘那一份
         并进本地（走的是与作答同一条栅栏，见 mergeNodeAttempts）。

         为什么不在 Host 半自动跑、也不在打开课件时跑：那是**学生本机上的执行**，只能由学生
         按下去。这条纪律与「命令只能从题目里来」是同一件事的两面。 */
      const [labRuns, setLabRuns] = useState(() => new Map());

      /** 把某一道题的代跑状态改一格（不动别的题、也不动作答复本）。 */
      const patchLab = useCallback((key, patch) => {
        setLabRuns((prev) => {
          const next = new Map(prev);
          next.set(key, Object.assign({ state: 'running', taskId: '', progress: '', result: null }, prev.get(key), patch));
          return next;
        });
      }, []);

      /** 一次代跑的回执 → 这一题的状态。回执形状与原生工具逐字相同（同一份实现）。 */
      const applyLabOutcome = useCallback((key, body) => {
        if (!body || typeof body !== 'object') {
          patchLab(key, { state: 'failed', note: '连不上面板那条路由。', result: null });
          return;
        }
        if (body['状态'] === '跑完了') {
          patchLab(key, { state: 'done', result: body['跑'], taskId: body['任务'] ? body['任务'].id : '', progress: '', note: body['说明'] });
          reload();   // 落盘那份并进本地（栅栏在 mergeNodeAttempts 里）
          return;
        }
        if (body['状态'] === '还在跑') {
          patchLab(key, {
            state: 'running',
            taskId: body['任务'] ? body['任务'].id : '',
            progress: (body['任务'] && body['任务'].progress && body['任务'].progress.line) || '',
            result: null,
            note: body['说明'] || '',
          });
          return;
        }
        // 拒：Host 半说清了为什么与下一步，原样摊开给学生看（不加工成判决）
        patchLab(key, { state: 'refused', result: body['拒'] || null, note: '', taskId: '' });
      }, [patchLab, reload]);

      const runLab = useCallback((questionId) => {
        const key = attemptStateKey(node ? node.id : '', questionId);
        patchLab(key, { state: 'running', taskId: '', progress: '', result: null, note: '' });
        fetch(LAB_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subject: slug, node: node ? node.id : '', question: questionId }),
        }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))
          .then((result) => applyLabOutcome(key, result.body))
          .catch((error) => patchLab(key, {
            state: 'failed', result: null,
            note: '连不上代跑那条路由：' + String((error && error.message) || error),
          }));
      }, [slug, node && node.id, patchLab, applyLabOutcome]);

      /* 跑得久时问一次任务板子（GET /api/studymate/tasks）：把进度行摊在按钮下面。
         只在这一页还有「跑着」的任务时才问，跑完就停——不做轮询常驻、不加重页面负担。 */
      useEffect(() => {
        const live = [...labRuns.values()].filter((one) => one.state === 'running' && one.taskId);
        if (!live.length) return undefined;
        let stopped = false;
        const tick = () => {
          fetch(TASKS_ENDPOINT, { headers: { accept: 'application/json' } })
            .then((response) => (response.ok ? response.json() : null))
            .then((board) => {
              if (stopped || !board || !Array.isArray(board.tasks)) return;
              setLabRuns((prev) => {
                const next = new Map(prev);
                let touched = false;
                next.forEach((one, key) => {
                  if (one.state !== 'running' || !one.taskId) return;
                  const found = board.tasks.find((task) => task.id === one.taskId);
                  if (!found) return;
                  const line = (found.progress && found.progress.line) || '';
                  if (line === one.progress) return;
                  next.set(key, Object.assign({}, one, { progress: line }));
                  touched = true;
                });
                return touched ? next : prev;
              });
              // 只在**板子上真见过**这个任务、而它现在已经不在「排队/运行/取消中」里时重读一次
              // payload——那说明它刚结束，事实已经落盘了。板子上一条都没有（还没跑到、或者
              // 宿主那条路由没挂）时什么都不做：读不到不是「它结束了」，凭这个反复重读会把
              // 页面拖成轮询机（曾是这样）。
              const settled = live.some((one) => {
                const found = board.tasks.find((task) => task.id === one.taskId);
                return !!found && !['排队', '运行', '取消中'].includes(found.status);
              });
              if (settled) reload();
            })
            .catch(() => { /* 板子读不到不影响这一页；下一次 tick 再试 */ });
        };
        const timer = setInterval(tick, 1500);
        tick();
        return () => { stopped = true; clearInterval(timer); };
      }, [labRuns, reload]);

      // 进课件页（以及每次重读 payload）时把盘上的作答**并进**本地：payload 的
      // node.attempts.questions 是 attempts/<NNNN>-<节点id>.json 的「题」那一层，键就是这里的
      // stateKey（<节点id>|<锚点>|<题号>）。合并走栅栏（mergeNodeAttempts）——读数在飞的时候
      // 学生可能刚又答了一题，那一笔不许被这份旧读数盖掉。状态只服务当场回顾（「上次你选了 B」），
      // 不做汇总视图、不排期、不算复习队列（目标态规格 §5.3）。
      useEffect(() => {
        if (!node || !node.attempts) return;
        // 队列里没有在飞的写入、且这个版本号不是我们早就走过的那份时才采纳（见 acceptVersion）
        writer.current.acceptVersion(slug + '/' + node.id, node.attempts.version);
        setAttempts((prev) => mergeNodeAttempts(prev, node.id, attemptsFromPayload(node), library.readSeq));
      }, [node && node.id, node && node.attempts && node.attempts.version]);

      // 上屏后回到顶部——**只有单栏那两级**（主页 / 科目主页）：三级是「每一级一屏」，
      // 从课件退回科目主页还停在正文中间会很怪。课件页**不走这里**：它有独立的滚动区，
      // 归 `useReadingPosition` 管，切视图回来要回到原位（#76）。
      // 只在层级真的换了才归零：数据静默重读（`view`/`slug`/`nodeId` 没变）不该把位置打回顶部。
      const scroller = useRef(null);
      const whereRef = useRef(null);
      useEffect(() => {
        const where = view + '\u0000' + slug + '\u0000' + nodeId;
        if (whereRef.current === where) return;
        whereRef.current = where;
        if (scroller.current) scroller.current.scrollTop = 0;
        // 这里**以前清的是引用**（`setQuote(null)`）。换视图/换课不该清：清除只有「学生点删掉」
        // 与「提交成功」两处（#92）。引用自带来源锚点，别的课的面板拿不到它（LessonPage 按
        // `anchor.lesson` 守一道），所以留着不会串课——学生回那一课，引用还在。
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

      return h('div.smb-root', { 'data-motion': motion },
        h(TopBar, { view, subject, node, onHome: goHome, onSubject: goSubject, onSearch: () => setPaletteOpen(true), motion, onMotion: pickMotion }),
        // 壳分层级（规格 §4.1）：主页与科目主页**单栏**（这条 .smb-scroll 就是唯一滚动区），
        // 课件阅读页**三栏**，左右栏由 LessonPage 自己管、默认收起——所以它不套 .smb-scroll。
        reading
          ? h(LessonPage, {
            subject, node, lesson, attempts, record,
            labRuns, onLabRun: runLab,
            onLesson: goLesson, onQuote: setQuote, quote,
            onQuoteClear: clearQuote,
            widths: paneWidths, onResizePane: resizePane, host,
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
      /* 一个节点都没有的科目：画出来会是一片空白（图例 + 空的连线层 + 空的表），
         学生看不出是「还没建课」还是「页面坏了」。所以在这儿就把话说清楚——空态是
         这一块**自己的**输出，不是留白。今天 `lib/library.ts` 会把零节点的科目整个
         跳过（建课建到一半的目录不进 payload），这条因此是兜底：hand-fed 的 payload
         （导出副本、别的调用方）同样不该画出空地图。 */
      if (!subject.nodes.length) {
        return h('div.smb-empty', null, subject.name + ' 还没有节点——先把这个科目的大纲写出来。');
      }
      const byLevel = [];
      for (const node of subject.nodes) {
        if (!byLevel[node.level]) byLevel[node.level] = [];
        byLevel[node.level].push(node);
      }
      // 图表的文字替代（规格 §4.4）：容器一句 aria-label 说清「这是什么」，
      // 细节交给下面视觉隐藏的 RoadmapTable——读屏用户拿得到前置关系，不只是听到「图」。
      const label = '路线图：' + subject.name + '，' + byLevel.length + ' 层、' + subject.nodes.length
        + ' 个节点；箭头是前置关系，从上往下读。';

      return h('div', { className: 'smb-map', ref: wrapRef, role: 'group', 'aria-label': label },
        h('div', { className: 'smb-map__legend' },
          h('span', null, h('i', { className: 'smb-dot smb-dot--未开始' }), '未开始'),
          h('span', null, h('i', { className: 'smb-dot smb-dot--学习中' }), '学习中'),
          h('span', null, h('i', { className: 'smb-dot smb-dot--已学完' }), '已学完'),
          h('span', { className: 'smb-meta' }, '箭头是前置关系，从上往下读；点卡片进课件。')),
        // 连线是纯装饰（信息在 RoadmapTable 里）：不 aria-hidden 的话，
        // 读屏会把一堆无标签的 <path> 当图形念出来。
        h('svg', { className: 'smb-map__edges', 'aria-hidden': 'true' }, paths.map((p) => h('path', {
          key: p.key, d: p.d, fill: 'none', stroke: 'currentColor',
          strokeOpacity: 0.28, strokeWidth: 1.4, markerEnd: 'url(#smb-arrow)',
        }))),
        h('div', { className: 'smb-map__cols' },
          byLevel.map((nodes, level) => (nodes
            ? h(RoadmapLevel, { key: level, level, nodes, subject, onNode })
            : null))),
        h('svg', { width: 0, height: 0, 'aria-hidden': 'true', style: { position: 'absolute' } },
          h('defs', null, h('marker', {
            id: 'smb-arrow', viewBox: '0 0 8 8', refX: 4, refY: 7,
            markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
          }, h('path', { d: 'M0,0 L8,0 L4,8 z', fill: 'currentColor', fillOpacity: 0.35 })))),
        h(RoadmapTable, { subject, label }));
    }

    /** 路线图的无障碍兜底：视觉隐藏的 <table>（`.smb-vh` 是屏幕阅读器专用，视觉上看不见）。 */
    function RoadmapTable({ subject, label }) {
      return h('table', { className: 'smb-vh' },
        h('caption', null, label),
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, '节点'),
          h('th', { scope: 'col' }, '层'),
          h('th', { scope: 'col' }, '前置'),
          h('th', { scope: 'col' }, '状态'))),
        h('tbody', null, subject.nodes.map((node) => h('tr', { key: node.id },
          h('th', { scope: 'row' }, node.title),
          h('td', null, String((node.level || 0) + 1)),
          h('td', null, node.prerequisites.length
            ? node.prerequisites
              .map((id) => ((subject.nodes.find((one) => one.id === id) || {}).title || id))
              .join('、')
            : '无'),
          h('td', null, node.tier)))));
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
    function SubjectiveBody({ item, kind, open, setOpen, self, onSelf, lab }) {
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
            String(item[field] || '').split('\n').map((line, i) => h('p', { key: i }, mathNodes(line, field + i))))),
          lab || null,
          h('div', { className: 'smb-btnrow' },
            h('span', { className: 'smb-meta' }, '自评：'),
            ['答对了', '答了一半', '没答上'].map((label, i) => h('button', {
              className: 'smb-btn', key: label,
              onClick: () => { onSelf(label); },
            }, label)),
            self ? h('span', { className: 'smb-chip smb-chip--学习中' }, '已记：' + self) : null)) : null);
    }

    /**
     * 一次代跑的结果→ 界面上那几行**事实**（#77）。
     *
     * 为什么单独抽成函数：套件要能对着它断言「只显示事实」——同一份输入进来，出来的字符串里
     * 不许有「通过 / 不通过 / 正确 / 错误」这类判决词（规格 §7.3：三轨里没有一轨叫 agent）。
     * 退出码是**数字原样**，不是「成功/失败」；结局只说这次怎么结束的。
     */
    function labFactsOf(run) {
      if (!run || typeof run !== 'object') return null;
      const exit = run['退出码'];
      const out = {
        command: String(run['命令'] || ''),
        outcome: String(run['结局'] || ''),
        exit: (typeof exit === 'number') ? String(exit) : '无（被信号杀掉）',
        signal: String(run['信号'] || ''),
        ms: (typeof run['毫秒'] === 'number') ? run['毫秒'] : null,
        stdout: String(run['stdout'] || ''),
        stderr: String(run['stderr'] || ''),
        outBytes: (run['字节'] && typeof run['字节'].stdout === 'number') ? run['字节'].stdout : null,
        errBytes: (run['字节'] && typeof run['字节'].stderr === 'number') ? run['字节'].stderr : null,
        outCut: !!(run['截断'] && run['截断'].stdout),
        errCut: !!(run['截断'] && run['截断'].stderr),
        failed: String(run['起不来'] || ''),
      };
      return out.command ? out : null;
    }

    /** 一条流（stdout / stderr）：字节数 + **截断了就说截断了**（与 Host 半同一口径）。 */
    function LabStream({ name, text, bytes, cut }) {
      const empty = text === '';
      const size = bytes === null ? '' : '（' + bytes + ' 字节' + (cut ? '，超上限已截断：头尾都留、中间省略' : '') + '）';
      return h('div.smb-lab__stream', null,
        h('h5', null, name + size),
        h('pre', { 'data-empty': empty ? 'true' : null }, empty ? '（空）' : text));
    }

    /**
     * 交付物题（#77）：**学生按下去才跑**（不自动跑），跑完把事实摊开。
     *
     * 三件刻意的事：
     *   · 入口只有一个按钮，且按钮上写的就是「跑一次」——不点不跑。自动跑会让「打开课件」
     *     变成一次学生本机上的执行，那是不能悄悄发生的事。
     *   · 显示的全是事实：命令、结局、退出码、两条流（截断了就说截断了）。**没有判决词**。
     *   · 跑得久的时候把进度行与「可以取消」摊在明面上：任务板子在 Host 半（GET /api/studymate/tasks），
     *     这里只把它的那一行读回来显示；取消要有身份，走总控的工具那条路（这条路由不提供取消）。
     */
    function LabRun({ item, questionId, lab, previousLab, onLabRun }) {
      const running = lab && lab.state === 'running';
      const waiting = lab && lab.state === 'waiting';
      const note = lab && lab.note ? lab.note : null;
      // 事实有两个来源，**盘上那一份优先**：
      //   · `previousLab` = `上次结果.跑`（从 attempts/ 读回来的，刷新页面之后它还在）；
      //   · `lab.result`  = 会话里刚跑完那一次（回执里带回来的，落盘之前先上屏）。
      // 两者指向同一次运行时内容逐字相同；分开的原因是刷新之后前者还在、后者没了——
      // 「上次跑出什么」与「上次选了 B」同级，都该活过刷新（目标态规格 §5.3）。
      const fromDisk = labFactsOf(previousLab);
      const facts = fromDisk || (lab && lab.state === 'done' ? labFactsOf(lab.result) : null);
      const refusal = lab && lab.state === 'refused' ? lab.result : null;
      return h('div', { className: 'smb-lab', 'data-proto': 'lab-run' },
        h('div', { className: 'smb-btnrow' },
          h('button', {
            className: 'smb-btn', 'data-proto': 'lab-run-button',
            disabled: !!(running || waiting),
            onClick: () => { if (!running && !waiting) onLabRun(questionId); },
          }, facts ? '再跑一次' : '跑一次'),
          h('span', { className: 'smb-meta' }, '在 lab 目录里跑题目里声明的那条命令')),
        facts ? h('div', null,
          h('code', { className: 'smb-lab__cmd' }, facts.command),
          h('p', { className: 'smb-lab__fact' },
            '结局：' + facts.outcome
            + '｜退出码：' + facts.exit
            + (facts.signal ? '｜信号：' + facts.signal : '')
            + '｜用时 ' + (facts.ms === null ? '—' : facts.ms) + ' 毫秒'),
          facts.failed ? h('p', { className: 'smb-lab__fact' }, '没起来：' + facts.failed) : null,
          h(LabStream, { name: '标准输出', text: facts.stdout, bytes: facts.outBytes, cut: facts.outCut }),
          h(LabStream, { name: '标准错误', text: facts.stderr, bytes: facts.errBytes, cut: facts.errCut }),
          h('p', { className: 'smb-lab__hint' }, '以上是这次运行的原始记录（含非零退出码与报错原文）。'
            + '通过与否不在这一层——你自己看输出，自评由你在下面选。'),
          h('p', { className: 'smb-lab__hint' }, '已记进作答数据（本题库文件不动）')) : null,
        refusal ? h('div', { className: 'smb-note', role: 'status' },
          h('b', null, '这次没跑'),
          h('div', null, refusal['为什么'] || ''),
          h('div', { className: 'smb-meta' }, refusal['下一步'] || '')) : null,
        running || waiting ? h('p', { className: 'smb-lab__fact', role: 'status' },
          (waiting ? '正在起任务…' : '正在跑…')
          + (lab.taskId ? '（' + lab.taskId + '）' : '')
          + (lab.progress ? '｜' + lab.progress : '')
          + '｜跑得久可以先干别的；要停它就跟总控说取消这个任务（' + (lab.taskId || '任务') + '）。') : null,
        note ? h('p', { className: 'smb-lab__hint' }, note) : null);
    }

    function Question({ item, index, node, subject, stateKey, chosen, self, attempts, record, onChoose, onSelf, lab, onLabRun }) {
      const [open, setOpen] = useState(false);
      const previous = attempts.get(stateKey);
      // 上一次代跑的事实（`上次结果.跑`）：读盘来的与刚跑完的那一次都落在这一格上，
      // 所以交付物题刷新一次之后那一段还在（见 LabRun 的注释）。
      const previousLab = previous ? previous.lab : undefined;
      const kind = questionKind(item);
      const objective = kind === '客观题';
      // 「上次你选了 B」：作答数据从 attempts/ 读进来（payload 的 node.attempts，写回走 POST
      // /api/studymate/attempts），状态只服务当场回顾——不做汇总视图、不排期（目标态规格 §5.3）。
      const previousText = previous
        ? (typeof previous.chosen === 'number'
          ? '上次选了 ' + letter(previous.chosen) + '，' + (previous.correct ? '对了' : '错了')
          : (previous.self ? '上次自评：' + previous.self : '上次答过'))
        : null;
      // 这一题自己的落盘状态：正在写 / 写成了 / 没写进去（冲突与失败那两句话挂在这里，学生看得见）
      const note = previous && previous.note ? previous.note : null;
      const diskText = note && note.bad
        ? '这次没写进作答数据（本题库文件不动）'
        : (previous && previous.pending ? '正在写进作答数据…' : '已记进作答数据（本题库文件不动）');

      return h('div', { className: 'smb-q' },
        h('div', { className: 'smb-q__ask' },
          h('span', { className: 'smb-q__no' }, 'Q' + (index + 1)),
          // 题型徽标（#93 条目 17）：`smb-q__kind` 是它自己的钩子（贴字的对齐、以及套件与
          // 对比度取样点都指它）。原来这里没有类名，套件里那条「右栏·题型徽标」的取样点
          // 命中的其实是顶部那条里的节点类型 chip。
          kind ? h('span', { className: 'smb-chip smb-q__kind' }, kind) : null,
          h('div', { className: 'smb-q__text' },
            item.q.split('\n').map((line, i) => h('p', { key: i }, mathNodes(line, 'q' + i))),
            previousText ? h('span', { className: 'smb-review' }, previousText) : null,
            note ? h('div', { className: 'smb-q__note', 'data-tone': note.bad ? 'warn' : 'info', role: 'status' }, note.text) : null)),
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
            }, h('span', { className: 'smb-opt__l' }, letter(i)), h('span', null, mathNodes(opt, 'opt' + i)));
          }))
          : h(SubjectiveBody, {
            item, kind, open, setOpen, self,
            // 交付物题多一块：#77 的代跑入口与事实块（只有这一种题型有命令可跑）
            lab: kind === '交付物'
              ? h(LabRun, { item, questionId: attemptQuestionId(stateKey), lab, previousLab, onLabRun })
              : null,
            onSelf: (label) => {
              const right = label === '答对了';
              onSelf(label);
              record(stateKey, { chosen: null, correct: right, self: label });
            },
          }),

        objective && chosen != null ? h('div', { className: 'smb-why', 'data-right': String(chosen === item.ans) },
          h('b', null, chosen === item.ans ? '对了' : '不对，答案是 ' + letter(item.ans)),
          h('p', null, mathNodes(item.why, 'why')),
          h('div', { className: 'smb-meta' }, diskText)) : null);
    }

    /* ═══════════════════════════════════════════════════════════════════════
       作答落盘：写队列 + 合并轮询 + 陈旧响应围栏

       一条作答的完整路径（目标态规格 §4.3、§7.3；ADR-0007）：
         点选项 → 本地乐观更新（pending+1）→ 写队列 → POST /api/studymate/attempts
         → Host 半写 attempts/<NNNN>-<节点id>.json → 回执带回落盘那份 → 覆盖本地那一条。
       刷新页面时走的是另一条：GET /library 的 node.attempts.questions → 合并进本地。

       三件东西合起来才叫「围栏」，缺一条都不成立：

       1. **写队列**（createAttemptWriter）：一条队列管一个「科目+节点」，FIFO，同一时刻只有
          一次写在飞。必须串行——每次写入的 `expectedVersion` 得是**上一次回执里的版本号**，
          并发发出去的第二笔必然带过期版本，被 Host 409 拒绝；那不但白跑一趟，还会把「别人
          改过」与「自己撞自己」搅在一起，学生看到一条假的冲突。
       2. **合并轮询**（useLibrary 的单飞 + mergeNodeAttempts）：重读请求在飞时不排队，
          只记一个「回来之后再补读一次」；读数回来是**并进**本地，不是整体替换。
       3. **栅栏**（mergeNodeAttempts 的两行判据）：本地那条比这次读数新（seq 更大）、或者
          还有没落的写入（pending），一律不许被覆盖。于是「先发出的读、后到达的响应」永远
          盖不掉学生刚做的作答——它连门都进不来，而不是靠「后到的赢」这种运气。

       版本冲突（409 version-conflict）**不是丢数据**：Host 拒绝写入并带回当前内容与版本号，
       这里拿回执里那份就地重读（不必再跑一趟），按新版本原样重来一次，同时把冲突如实告诉
       学生（`note` 挂在那一题上，学生看得见）。
       ═══════════════════════════════════════════════════════════════════════ */

    /** 版本冲突自动重来的次数上限：第二次还撞就交给学生，别在后台无声地循环。 */
    const WRITE_RETRY_MAX = 1;

    /**
     * 本地动作时钟：每按一次选项 +1。
     *
     * 它是**栅栏的刻度**，所以必须活得比组件久一点（读数在飞、组件重挂都可能跨过它），
     * 放在闭包里而不是 useState 里。这次会话挂载时从 0 开始：刷新页面后本地作答全空，
     * 任何一次读数都该盖得住（seq 0）。
     */
    const attemptClock = { seq: 0 };
    const attemptSeqNow = () => attemptClock.seq;

    /** 题 id（`<锚点文本>#<题号>`，attempts/ 文件里的键）→ 界面的 stateKey。 */
    function attemptStateKey(nodeId, id) {
      const parts = String(id).split('#');
      const qi = parts.pop();
      return nodeId + '|' + parts.join('#') + '|' + qi;
    }

    /**
     * stateKey（`<节点id>|<锚点文本>|<题号>`）→ 题 id。**与 attemptStateKey 互为逆运算**：
     * 两边写法一旦不一致，写进去的作答就读不回来（一个题号也不能差）。
     */
    function attemptQuestionId(stateKey) {
      const parts = String(stateKey).split('|');
      const qi = parts.pop();
      parts.shift();   // 第一个字段是节点 id，不属于题 id
      return parts.join('|') + '#' + qi;
    }

    /**
     * 盘上的一条「上次结果」→ 本地那条作答。
     * `seq: 0` = 不是这次会话答的（任何读数都能覆盖它）；`pending: 0` = 没有在飞的写入。
     */
    function attemptFromDisk(last) {
      return {
        at: (last && last['时']) || '',
        chosen: last && typeof last['选'] === 'number' ? last['选'] : null,
        correct: !!(last && last['对'] === true),
        self: last && last['自评'],
        reason: last && last['错因'],
        // #77：交付物题的一次**代跑事实**（命令 / 退出码 / stdout / stderr）。它跟着作答数据
        // 一起回来，所以刷新页面之后那一段还在（「上次跑出什么」与「上次选了 B」同级）。
        lab: (last && typeof last['跑'] === 'object' && last['跑'] !== null) ? last['跑'] : undefined,
        seq: 0,
        pending: 0,
      };
    }

    /** 「题 id → 一条作答」的那张表 → stateKey → 本地作答。payload 与写回执共用这一份转换。 */
    function attemptsToLocal(nodeId, questions) {
      const out = new Map();
      for (const [id, one] of Object.entries(questions || {})) {
        out.set(attemptStateKey(nodeId, id), attemptFromDisk(one && one['上次结果']));
      }
      return out;
    }

    /** payload 里的一个节点（`node.attempts.questions`）→ stateKey → 本地作答。 */
    function attemptsFromPayload(node) {
      return attemptsToLocal(node.id, node.attempts && node.attempts.questions);
    }

    /** 写回执里的 `attempts`（`{ 题: {...} }`）→ stateKey → 本地作答。 */
    function attemptsFromReceipt(nodeId, attempts) {
      return attemptsToLocal(nodeId, attempts && attempts['题']);
    }

    /**
     * 栅栏：把一份**盘上读来的**作答（incoming）并进本地（local），只动这个节点的键。
     *
     * 两行判据，就是「旧响应不许覆盖新作答」的全部：
     *   · 本地那条的 `seq > allowSeq` —— 它比这次读数**新**（读数开始之后才答的）；
     *   · 本地那条的 `pending > 0` —— 它还有没落的写入，盘上那份含不含它还两说。
     * 命中任一条就原样留着；否则以盘上那份为准（文件是真相）。盘上确实没有、本地也不是新的
     * （别人把作答文件重写了）就按盘上的算——那是真的没了，不是被旧响应盖掉的。
     *
     * `allowSeq` = 这次读数**开始**时的动作序号。写回执传它自己的 seq：回执本身就是对那次写入
     * 的回答，所以允许覆盖它自己那一条。
     */
    function mergeNodeAttempts(local, nodeId, incoming, allowSeq) {
      const prefix = nodeId + '|';
      const next = new Map(local);
      const mine = new Map();
      next.forEach((entry, key) => {
        if (key.indexOf(prefix) === 0) { mine.set(key, entry); next.delete(key); }
      });
      incoming.forEach((entry, key) => {
        const before = mine.get(key);
        if (before && (before.seq > allowSeq || before.pending > 0)) { next.set(key, before); return; }
        const merged = Object.assign({}, entry, { seq: before ? before.seq : 0 });
        // 冲突/失败那句提示要穿得过一次合并活下来：学生得一直看到它，直到他再动一次这道题
        if (before && before.note) merged.note = before.note;
        next.set(key, merged);
      });
      mine.forEach((entry, key) => {
        if (next.has(key)) return;
        if (entry.seq > allowSeq || entry.pending > 0) next.set(key, entry);
      });
      return next;
    }

    /**
     * 一次写入有结果了（写成了 / 被拒了 / 网络断了都算）：把这一条的在飞计数减一，
     * 并决定留不留那句提示。**三条出路都要走到这里**——否则 pending 永远减不掉，
     * 那一条从此再也接受不了任何读数（栅栏会把它永久钉住）。
     */
    function settleAttempt(prev, job, note) {
      const entry = prev.get(job.stateKey);
      if (!entry) return prev;
      const settled = Object.assign({}, entry, { pending: Math.max(0, (entry.pending || 0) - 1) });
      if (note) settled.note = note; else delete settled.note;
      const next = new Map(prev);
      next.set(job.stateKey, settled);
      return next;
    }

    /** 界面里的一次作答 → 一次写队列任务（纯函数：套件直接断言它，不靠读代码猜形状）。 */
    function attemptJob({ subject, node, stateKey, patch, seq, expectedVersion }) {
      return {
        lineKey: subject + '/' + node,
        subject,
        node,
        stateKey,
        questionId: attemptQuestionId(stateKey),
        // 界面的词（chosen / correct / self / reason）→ 作答数据的字段（选 / 对 / 自评 / 错因）
        patch: { 选: patch.chosen, 对: patch.correct, 自评: patch.self, 错因: patch.reason },
        seq,
        expectedVersion: expectedVersion || '',
        // 幂等键：一次点击一个。重试沿用同一个——Host 那侧的重放逻辑据此不写第二遍。
        operationId: 'op-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10),
      };
    }

    /** 写不进去时给学生看的话：**原样**带 Host 的判词，别只丢一个状态码。 */
    function refusalNote(body, retrying) {
      const said = routeMessage(body) || '写不进去';
      if (body && routeCode(body) === 'version-conflict') {
        return retrying
          ? { bad: false, text: '别处刚改过这份作答数据，已按最新版本重记了一次。' }
          : { bad: true, text: '别处刚改过这份作答数据，这次没写进去（已重读最新内容）。再点一次即可。' };
      }
      if (body && routeCode(body) === 'operation-id-conflict') {
        return { bad: true, text: '这次提交的编号与上次不同：没写进去，重新点一次即可。' };
      }
      return { bad: true, text: '没写进作答数据：' + said };
    }

    /**
     * 真正发出去的那一次 POST。返回 `{ status, body }`（**不抛**：网络断了也要变成一句给学生的话，
     * 而不是一个没人接的 promise）。
     */
    function sendAttempt(payload) {
      return fetch(ATTEMPTS_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(async (response) => ({
        status: response.status,
        body: await response.json().catch(() => null),
      })).catch((error) => ({ status: 0, body: { ok: false, error: { code: 'network', message: String((error && error.message) || error) } } }));
    }

    /**
     * 写队列。见本节开头第 1 条；三个回调把结果交回界面：
     *   `onApplied(job, body, note)`     写成了：回执里那份就是盘上的真相
     *   `onRefused(job, body, retrying)` 被拒（含网络断了）：Host 的判词原样交给学生
     */
    function createAttemptWriter(hooks) {
      const lines = new Map();

      function lineOf(key) {
        let found = lines.get(key);
        if (!found) {
          // seen = 这条队列见过的全部版本号（payload 与每次回执）。它不是缓存，是**栅栏的判据**：
          // 版本号是内容哈希，没有大小之分，所以「哪份更新」只能靠「我走没走过它」来判。
          found = { key, jobs: [], flying: false, version: '', seen: new Set() };
          lines.set(key, found);
        }
        return found;
      }

      function pump(line) {
        if (line.flying) return;
        const job = line.jobs.shift();
        if (!job) return;
        line.flying = true;
        deliver(line, job, line.version || job.expectedVersion, 0, null);
      }

      /**
       * 发一笔并处理四种结局。`keptNote` 是这次尝试一路上攒下的提示（比如「刚才撞了一次版本」）：
       * 它要跟着成功一起交回界面——不然学生只会看到提示闪一下就没了，等于没说。
       *
       * 四种结局都有人接：写成了、被 409 拒（可重来一次）、被其它错误拒、网络断了
       * （sendAttempt 已经把异常收成 `{status: 0, message}`，所以这里只有一条出路）。
       */
      function deliver(line, job, expectedVersion, attempt, keptNote) {
        hooks.send({
          subject: job.subject,
          node: job.node,
          questions: { [job.questionId]: job.patch },
          operationId: job.operationId,
          expectedVersion,
        }).then((result) => {
          const body = result.body || {};
          // 拒绝也会带回当前版本号（那就是「拒绝并重读」的重读结果），照样采纳
          if (typeof body.version === 'string' && body.version) {
            line.version = body.version;
            line.seen.add(body.version);
          }
          if (result.status === 200 && body.ok) {
            line.flying = false;
            hooks.onApplied(job, body, keptNote);
            pump(line);
            return;
          }
          if (result.status === 409 && routeCode(body) === 'version-conflict' && attempt < WRITE_RETRY_MAX) {
            // 别的写入者刚改过：Host 拒了这次写入（**盘上没变**），并把当前内容与版本号一起带回来。
            // 这就是「拒绝并重读」——拿回执里那份重读，按新版本重来一次；同时如实告诉学生。
            const note = refusalNote(body, true);
            hooks.onRefused(job, body, true);
            deliver(line, job, body.version, attempt + 1, note);
            return;
          }
          line.flying = false;
          hooks.onRefused(job, body, false);
          pump(line);
        });
      }

      return {
        /**
         * 采纳 payload 重读到的版本号。三条不采纳的理由：
         *   · 还有在飞的写入 —— 那一笔的栅栏由回执负责，别插队；
         *   · 空版本号 —— 读不到就是读不到，别把栅栏拆了；
         *   · **这个版本号我们早就走过**（`seen` 里有、又不是当前那个）—— 它是一份过期读数。
         *     最后这条挡的是「答完 → 去别的节点转一圈 → 回来」：payload 还是页面加载时那份旧的，
         *     捡回来就会让下一次作答白撞一次 409。
         */
        acceptVersion(key, version) {
          const line = lineOf(key);
          if (line.flying || line.jobs.length) return;
          if (typeof version !== 'string' || !version) return;
          if (version !== line.version && line.seen.has(version)) return;
          line.version = version;
          line.seen.add(version);
        },
        push(job) {
          const line = lineOf(job.lineKey);
          // 这一笔要带的版本号也记进 seen：它是我们「走过」的版本，回执会带我们往前走
          if (job.expectedVersion) line.seen.add(job.expectedVersion);
          line.jobs.push(job);
          pump(line);
        },
        /** 这个「科目/节点」还有几笔没落（界面不必知道，留给套件与排障用）。 */
        pending(key) {
          const line = lines.get(key);
          return line ? line.jobs.length + (line.flying ? 1 : 0) : 0;
        },
      };
    }

    /* ═══════════════════════════════════════════════════════════════════════
       #75：动效四档 + 首次引导定位几何（+ 给测试的纯函数外露）

       两件事都要求「可单测」，所以写成不碰 DOM 的纯函数，集中放在这里，别散落：
         · 动效四档 auto / full / reduced / off（规格 §4.4，对齐 F7）；
           CSS 里 .smb-root[data-motion=…] 只改 --smb-motion 一个值，
           数值与下面的 MOTION_MS 一一对应，test_client_pure.mjs 会对着断言。
         · 首次引导的定位几何（规格 §4.4，对齐 F6）——纯数学、零依赖。
           UI 本票不做，只要几何函数与单测（ticket #75 的 What to build 就这些）。
       ═══════════════════════════════════════════════════════════════════════ */

    const MOTION_KEY = 'studymate.motion.v1';
    const MOTION_LEVELS = ['auto', 'full', 'reduced', 'off'];
    /** 与 CSS 里 .smb-root[data-motion=…] 的 --smb-motion 取值一一对应（改一处就得改两处）。 */
    const MOTION_MS = { full: 140, reduced: 70, off: 0 };

    /**
     * 动效档 → 实际毫秒数。`auto` 跟随系统：系统说「减少动效」就退到 reduced。
     * 为什么 auto 不是退到 off：off 会让「点题目标记滑出右栏」这类定位变化突然出现，
     * 反而更难跟；「减少动效」要的是少晃，不是没有反馈。
     */
    function motionFor(level, prefersReduced) {
      const picked = MOTION_LEVELS.includes(level) ? level : 'auto';
      const effective = picked === 'auto' ? (prefersReduced ? 'reduced' : 'full') : picked;
      return { level: picked, effective, ms: MOTION_MS[effective] };
    }

    function readMotion() {
      try {
        const raw = window.localStorage.getItem(MOTION_KEY);
        return MOTION_LEVELS.includes(raw) ? raw : 'auto';
      } catch (error) { return 'auto'; }   // 无痕模式读不到就用 auto，不影响本次会话
    }

    /** 动效档住在浏览器本地偏好里，与栏宽同级（规格 §4.4「与主题、动效档同属浏览器本地偏好」）。 */
    function useMotion() {
      const [level, setLevel] = useState(readMotion);
      const pick = useCallback((next) => {
        const value = MOTION_LEVELS.includes(next) ? next : 'auto';
        setLevel(value);
        try { window.localStorage.setItem(MOTION_KEY, value); } catch (error) { /* 存不下就算了 */ }
      }, []);
      return [level, pick];
    }

    const MOTION_LABELS = { auto: '动效：跟随系统', full: '动效：全', reduced: '动效：减弱', off: '动效：关' };

    /** 顶栏右端的动效档选择器。用原生 select：键盘、读屏、窄屏都自带。 */
    function MotionPicker({ level, onPick }) {
      return h('label', { className: 'smb-motionpick', title: '动效档位（只影响本机，记在浏览器本地偏好里）' },
        h('span', { className: 'smb-vh' }, '动效档位'),
        h('select', {
          className: 'smb-select', value: level,
          onChange: (event) => onPick(event.target.value),
        }, MOTION_LEVELS.map((one) => h('option', { key: one, value: one }, MOTION_LABELS[one]))));
    }

    /**
     * 首次引导的定位几何（目标态规格 §4.4，对齐 F6）：纯数学、零依赖、可单测。
     *
     * 规则按优先级：
     *   1. **优先方位**：气泡放在 preferred 那一侧（默认 bottom），只要放得下；
     *   2. **按剩余空间换边**：优先方位放不下 → 试对侧 → 再试剩下两侧；
     *   3. **窄容器停靠底部**：四侧都放不下、但容器里塞得下气泡 → 贴容器底边；
     *   4. **目标占满时退到内角**：连塞都塞不下（容器比气泡还窄/矮，或目标铺满）→
     *      退到离目标中心最远的那个内角。
     * 任何一条分支的位置都夹在 bounds 的 margin 里——**在窄侧边栏里不越界**。
     *
     * @param {object} input
     * @param {{left:number,top:number,width:number,height:number}} input.target 要高亮的目标
     * @param {{left:number,top:number,width:number,height:number}} input.bounds 可用范围（视口 / 侧栏）
     * @param {{width:number,height:number}} input.size                          气泡尺寸
     * @param {'top'|'bottom'|'left'|'right'} [input.preferred='bottom']         优先方位
     * @param {number} [input.gap=8]      气泡与目标的间距
     * @param {number} [input.margin=8]   气泡与容器边缘的最小留白
     * @returns {{side:string,left:number,top:number,width:number,height:number}} side ∈ 四方位 + docked/corner
     */
    function coachPlacement({ target, bounds, size, preferred = 'bottom', gap = 8, margin = 8 } = {}) {
      const sides = ['top', 'bottom', 'left', 'right'];
      const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
      const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

      const inner = {
        left: bounds.left + margin,
        top: bounds.top + margin,
        right: bounds.left + bounds.width - margin,
        bottom: bounds.top + bounds.height - margin,
      };
      const room = { width: Math.max(0, inner.right - inner.left), height: Math.max(0, inner.bottom - inner.top) };
      // 「放得下」按**期望**尺寸算：气泡比容器还大时，四侧与停靠都不成立，落到第 4 条退内角
      const wanted = { width: size.width, height: size.height };
      const roomy = wanted.width <= room.width && wanted.height <= room.height;

      const box = {
        left: target.left, top: target.top,
        right: target.left + target.width, bottom: target.top + target.height,
        cx: target.left + target.width / 2, cy: target.top + target.height / 2,
      };

      // 放得下 = 气泡完整落进容器（不是「目标旁边还剩多少」——容器本身也得够）
      const fits = (side) => {
        if (!roomy) return false;
        if (side === 'top' || side === 'bottom') return room.height >= wanted.height + gap;
        return room.width >= wanted.width + gap;
      };
      const order = [preferred, opposite[preferred], ...sides].filter((side, i, all) =>
        sides.includes(side) && all.indexOf(side) === i);

      for (const side of order) {
        if (!fits(side)) continue;
        if (side === 'bottom' || side === 'top') {
          const left = clamp(box.cx - wanted.width / 2, inner.left, inner.right - wanted.width);
          const top = side === 'bottom' ? box.bottom + gap : box.top - gap - wanted.height;
          if (top < inner.top || top + wanted.height > inner.bottom) continue;
          return { side, left, top, width: wanted.width, height: wanted.height };
        }
        const top = clamp(box.cy - wanted.height / 2, inner.top, inner.bottom - wanted.height);
        const left = side === 'right' ? box.right + gap : box.left - gap - wanted.width;
        if (left < inner.left || left + wanted.width > inner.right) continue;
        return { side, left, top, width: wanted.width, height: wanted.height };
      }

      // 3. 停靠底部：四侧都放不下，但容器里塞得下 → 贴底边，横向仍尽量对准目标
      if (roomy) {
        return {
          side: 'docked', width: wanted.width, height: wanted.height,
          left: clamp(box.cx - wanted.width / 2, inner.left, inner.right - wanted.width),
          top: inner.bottom - wanted.height,
        };
      }

      // 4. 退到内角：容器比气泡还小 → 挑离目标中心最远的内角（右下 / 左下 / 右上 / 左上）。
      // 容器不够放时至少贴住左/上内边——气泡从左上开始读，切尾巴好过切开头。
      const width = Math.min(wanted.width, room.width);
      const height = Math.min(wanted.height, room.height);
      const far = { x: box.cx < inner.left + room.width / 2 ? 'right' : 'left', y: box.cy < inner.top + room.height / 2 ? 'bottom' : 'top' };
      return {
        side: 'corner', width, height,
        left: far.x === 'right' ? Math.max(inner.left, inner.right - width) : inner.left,
        top: far.y === 'bottom' ? Math.max(inner.top, inner.bottom - height) : inner.top,
      };
    }

    /* 纯函数外露：**只给测试用**。这个文件零构建、没有 export，工厂里的纯函数外面拿不到，
       而规格要求「首次引导的定位几何可单测」「动效四档可切」。所以显式留一个开关：
       window.__STUDYMATE_TEST__ 为真时把这两个纯函数挂到 window.__STUDYMATE_PURE__ 上。
       真 DSH 里没人设这个开关，等于不挂（scripts/tests/test_client_pure.mjs 会设）。 */
    if (typeof window !== 'undefined' && window.__STUDYMATE_TEST__) {
      window.__STUDYMATE_PURE__ = {
        coachPlacement, motionFor, MOTION_LEVELS, MOTION_MS,
        // #88 三栏几何：分配与「装不下就降级」是代数，不是像素——套件在 Node 里按
        // ADR-0011 手算的例子与几条不变量钉它（scripts/tests/test_client_panes.mjs）
        planPanes, drawerWidth, clampPane, clampDrawer, PANE_LIMITS, MIN_CENTER, DRAWER_SLIT,
      };
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
        KIND_ORDER, KIND_LABEL, SearchPalette, hitWhere,
        GlossaryBody, ReferenceFoldBody, RecordsBody, MisconceptionBody, Fold,
        // 作答落盘的栅栏与写队列（#72）：套件直接断言这几件纯逻辑
        attemptClock, attemptStateKey, attemptQuestionId, attemptFromDisk,
        attemptsToLocal, attemptsFromPayload, attemptsFromReceipt,
        mergeNodeAttempts, settleAttempt, attemptJob, refusalNote, createAttemptWriter,
        Question, QuestionList, QuizCard, SubjectiveBody,
        // #77：代跑事实块与「事实 → 界面」的那一份纯映射（套件据此断言界面只显示事实）
        LabRun, labFactsOf, LAB_ENDPOINT,
        // #79 / #105 / #107：问答面板本身与它请宿主半建会话的那条路由。面板不再自己调模型
        // ——旧路由与它那份上下文组装已随 #107 整体退役，客户端里连那个常量都不留。
        // 标题的拼法与识别、会话列表的认法都是纯的，套件直接断言它们。
        AskPanel, QA_SESSION_ENDPOINT,
        ASK_SESSION_PREFIX, ASK_SESSION_SEP, ASK_RETAIN_SOURCE,
        titleForAskSession, isAskSessionTitle, askSubjectLabel, askNodeLabel,
        askSessionRows, latestAskSessionId, askSessionLabel, askHost,
        // #92：选区的捕获判据。「读到空不得清引用」这条不变式就住在 `captureQuote` 里（读不出
        // 合格的一段时返回上一份），套件拿假 DOM 把各种读空的方式逐个喂进去。`readQuote` /
        // `QUOTE_MIN` 仍是它的内部件（没有套件直接断言那两个数字与读法本身）；
        // Node 里没有真选区，真鼠标拖拽那一条在 browser/ask_quote_test.mjs。
        captureQuote, quoteSource,
        // #106：引用 chip。`ref` 是字符串、没有反序列化入口，所以「原文 + 来源锚点」的编解码
        // 是一对纯函数；`serialize`/`clipboardText` 是它们的两个投影（提交那段文字的**唯一**出处）。
        // 注册形状（名字不与宿主的 reference / skill / command 撞）与「插进草稿 / 换掉 / 撤掉」
        // 那条调用序列也在这儿——套件用假门面（occurrences + draftRev CAS）逐条钉住。
        QUOTE_TRIGGER, QUOTE_SOURCE_NAME, QUOTE_REF_KIND, QUOTE_LABEL_MAX,
        encodeQuoteRef, decodeQuoteRef, quoteForModel, quoteForClipboard, shortQuote,
        referenceInsertFor, quoteReferenceSource, quoteSlots,
        inputFacadeFor, ourOccurrence, putQuoteInDraft, dropQuoteFromDraft,
        // #74：数据获取与状态更新那一块——「未变即同引用」的合并函数，与订阅推送的那个 hook。
        // 断言同引用只能拿这两个（套件在 Node 里跑真的这一份，见 test_watch_client.mjs）。
        mergeLibraryData, useLibrary,
        // #91：公式那一块。MathSpan 在 Node 里渲不出排版结果（没有引擎、也不该有），
        // 套件要断言的是**降级态**与「题库字段真的走了同一个排版器」，所以给出组件与判据：
        MathSpan, mathNodes, mathSource, ensureMath, MATH_ENDPOINT,
      });
    }

    /**
     * 从 `apply(ctx)` 上取一件宿主服务：`ctx.get(name)` 是规范姿势，`ctx[name]` 是兜底
     * （老宿主 / 桩）。取不到给 `null`——调用方按「这个宿主没有这一件」处理，不抛。
     */
    function hostService(ctx, name) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          const got = ctx.get(name);
          if (got) return got;
        }
      } catch (error) { /* 服务不在或取值就抛：走兜底 */ }
      try { return (ctx && ctx[name]) || null; } catch (error) { return null; }
    }

    return {
      // 服务名（不是包名——包名那份在 package.json 的 dsh.client.inject 里）。
      // `sessions` 是面板 retain 那条答疑会话用的（#105）；`inputTriggers` 与 `conversation`
      // 是 #106 的引用 chip 要用的（来源注册 + 引用的插入走会话的输入门面）。
      inject: ['slots', 'sessions', 'inputTriggers', 'conversation'],
      apply(ctx) {
        // 宿主给的那三件只能在 apply 里拿（不是 props）：集中放进 askHost，组件一律从那儿读。
        askHost.sessions = hostService(ctx, 'sessions');
        askHost.inputTriggers = hostService(ctx, 'inputTriggers');
        askHost.conversation = hostService(ctx, 'conversation');

        // 引用来源在**插件激活时**注册，用 `ctx.effect` 挂在插件 fiber 上（插件卸载 = 注销）。
        // 这一点是承重的：提交那一刻宿主按 name 找 owner 的 codec，找不到就抛
        // 「no serializer for reference source」并**拒绝整次发送、把草稿还给学生**。所以它
        // 绝不能跟面板的开关走（面板关掉、草稿里还留着 chip 的情况是常态）。
        // 注册不上（更老的宿主没有 inputTriggers）不算致命：面板照常能用，只是引用进不了草稿。
        const inputTriggers = askHost.inputTriggers;
        if (inputTriggers && typeof inputTriggers.registerSource === 'function' && typeof ctx.effect === 'function') {
          try {
            ctx.effect(() => inputTriggers.registerSource(quoteReferenceSource()), 'studymate: @ 引用来源');
          } catch (error) {
            // 名字撞了、或这个宿主不吃这一套：别把整个阅读端拖死，留一句日志
            if (typeof console !== 'undefined' && console.error) {
              console.error('[studymate] 引用来源没注册上：' + String((error && error.message) || error));
            }
          }
        }

        // 中央面板：阅读端本体（main 是 keyed/root，key 就是侧栏那一行的 id）。
        // `children` 里那一条**非 root** 子座位不是给别人填的：框架的判据是「这颗 entry 的
        // children 表里有任何 scope !== 'root' 的座位」才把 `SessionProvider` 交给组件，
        // 而右栏那条会话正文（#105）必须有它——occurrence 的会话就是「被哪个 Provider 罩着」。
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID,
          children: { 'studymate.ask.session': { kind: 'single', scope: 'session' } },
        }, StudyMateApp));
        // 侧栏那一行入口：点它由 sidebar 调 ctx.layout.selectPanel('studymate')
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: '学习',
        }, StudyMateIcon));
      },
    };
  },
});
