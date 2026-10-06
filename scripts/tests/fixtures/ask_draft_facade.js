/* 假输入门面（共用夹具）：宿主 `conversation.input.for(actx)` 那一件的**两套投影**。
   ────────────────────────────────────────────────────────────────────────
   为什么要有它：`lib/client.js` 的引用 chip（#106）要往会话草稿里放东西，而宿主的草稿有
   **两套坐标**（读 `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 得来，不是推断）：

     · **剪贴板投影**（`clipboardText`）：一颗 chip 展开成它的 `clipboardText`——面板造的
       那颗是十几字的「【引用】…（来源）」，所以它在这里占的是十几个字。`state.getSnapshot()
       .occurrences[].offset/length` 与 `draft` 都是这一套。
     · **detect 投影**（`detectText`）：同一颗 chip 只占**一个**占位符 `\uFFFC`。编辑器
       与 `insertReference` / `insertText` 收到的 `span` 要的是这一套——宿主自己的
       `insertReference(ref, span)` 就写着「span - pick-time span snapshot (**detect
       coordinates**)」，越界（`span.end > detectLength`）直接拒。

   #102 那次评审抓到的正是这条：实现拿剪贴板坐标去喂 detect span，于是「chip 后面有学生打的
   字」时连带删错十来个字；chip 落在草稿末尾时越界、两次都返回 false，草稿里留着旧 chip、
   发出去的还是上一段。原来的假门面**只有一套坐标**（`draft.length` 与 `offset/length` 同源），
   所以放过了这个 bug——这份夹具同时照两套投影写，越界与「替换掉的必须正好是那一个 chip」
   都由它把关。

   形态：**浏览器脚本**（IIFE + `globalThis.StudymateAskDraft`）。浏览器夹具用 `<script src>`
   原样加载它；Node 侧经 `ask_draft_facade.mjs` 那个薄壳取出来（照 client_harness.mjs 加载
   `lib/client.js` 的同一姿势）。这样两套投影只写一遍。
   ───────────────────────────────────────────────────────────────────────── */
(function (root) {
  'use strict';

  /** detect 投影里一颗 chip 的占位符（宿主：`pushLeaf('chip', kid, '\uFFFC', …)`）。 */
  var CHIP_PLACEHOLDER = '\uFFFC';

  /* 草稿的**文档模型**：一串节点，`{ kind: 'text', text }` 或 `{ kind: 'chip', … }`。
     两套投影都从它算出来——不是各维护一份，否则「两套」会各自漂。 */
  function project(nodes) {
    var detectText = '';
    var clipboardText = '';
    var occurrences = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node.kind === 'chip') {
        occurrences.push({
          occurrenceId: node.occurrenceId,
          source: node.source,
          ref: node.ref,
          label: node.label,
          offset: clipboardText.length,          // 剪贴板投影
          length: node.clipboardText.length,     // 剪贴板投影
          clipboardText: node.clipboardText,
        });
        detectText += CHIP_PLACEHOLDER;          // detect 投影：恒占一个字
        clipboardText += node.clipboardText;
      } else {
        detectText += node.text;
        clipboardText += node.text;
      }
    }
    return { detectText: detectText, clipboardText: clipboardText, occurrences: occurrences };
  }

  /* ── detect 区间 ↔ 节点：每个节点在 detect 投影里逐字展开成「单位」 ────────
     一颗 chip 是一个单位（1 个字），文本的每个字符也是一个单位。所以
     `[start, end)` 覆盖的正好是单位下标 `start .. end-1`——与宿主 `selectSpan` 的
     越界判据（`span.end > detectLength`）逐字对应。 */
  function toUnits(nodes) {
    var units = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node.kind === 'chip') { units.push({ chip: true, node: node }); continue; }
      for (var j = 0; j < node.text.length; j += 1) units.push({ chip: false, char: node.text.charAt(j) });
    }
    return units;
  }

  function fromUnits(units) {
    var nodes = [];
    for (var i = 0; i < units.length; i += 1) {
      var unit = units[i];
      if (unit.chip) { nodes.push(unit.node); continue; }
      var last = nodes[nodes.length - 1];
      if (last && last.kind === 'text') last.text += unit.char;
      else nodes.push({ kind: 'text', text: unit.char });
    }
    return nodes;
  }

  function textUnits(text) {
    var units = [];
    for (var i = 0; i < text.length; i += 1) units.push({ chip: false, char: text.charAt(i) });
    return units;
  }

  /**
   * 一份假草稿。`initial` 是草稿的**剪贴板**文字（宿主 `setDraft` 那一路也是这么收的）。
   *
   * 对外形状照宿主：`state.getSnapshot()` / `state.subscribe()` / `insertReference(ref, span)`
   * / `insertText(text, span)` / `setDraft(text)` / `notify(level, text)`；另有几件只有夹具
   * 用得到的：`draft`（剪贴板全文）、`chips`（occurrences 的别名）、`rev`、`notices`、
   * `select(start, end)`（在 detect 空间里摆一个选区/光标）、`reset()`（新会话 = 新草稿）。
   */
  function makeAskDraft(options) {
    var settings = options || {};
    var listeners = [];
    var nodes = settings.initial ? [{ kind: 'text', text: String(settings.initial) }] : [];
    var api = {
      session: null,
      rev: 1,
      notices: [],
      /** 宿主快照里的 `selection` / `caret` 都是 **detect** 坐标；默认没有。 */
      selection: null,
      caret: null,
    };

    function snapshot() {
      var view = project(nodes);
      return {
        draft: view.clipboardText,
        draftRev: api.rev,
        phase: 'plain',
        detectText: view.detectText,
        clipboardText: view.clipboardText,
        occurrences: view.occurrences.map(function (one) { return Object.assign({}, one); }),
        selection: api.selection ? { start: api.selection.start, end: api.selection.end } : null,
        caret: typeof api.caret === 'number' ? api.caret : null,
      };
    }

    function bump() {
      api.rev += 1;
      listeners.slice().forEach(function (fn) { fn(); });
    }

    /** 宿主 `insertReference` 的坐标判据：越界就拒（`selectSpan` 给 null）。 */
    function inBounds(span, detectLength) {
      if (!span || typeof span.start !== 'number' || typeof span.end !== 'number') return false;
      if (span.start < 0 || span.start > span.end) return false;
      if (span.end > detectLength) return false;
      return true;
    }

    /** 把 detect 区间 `[span.start, span.end)` 换成 `put`（一串单位），其余照旧。 */
    function spliceUnits(put, span) {
      var units = toUnits(nodes);
      var head = units.slice(0, span.start);
      var tail = units.slice(span.end);
      nodes = fromUnits(head.concat(put, tail));
    }

    api.state = {
      getSnapshot: snapshot,
      subscribe: function (fn) {
        listeners.push(fn);
        return function () { var at = listeners.indexOf(fn); if (at >= 0) listeners.splice(at, 1); };
      },
    };

    api.notify = function (level, text) { api.notices.push({ level: level, text: String(text) }); };

    api.insertReference = function (ref, span) {
      if (!ref || typeof ref !== 'object') return false;
      if (span.draftRev !== api.rev) return false;                 // CAS：坐标过期就静默让位
      var view = project(nodes);
      if (!inBounds(span, view.detectText.length)) return false;   // 越界：宿主也是拒，不是抛
      // 宿主：「一颗 chip，后面跟一个分隔空格，除非紧跟着的已经是一个空格」
      var tail = view.detectText.slice(span.end, span.end + 1);
      var put = [{
        chip: true,
        node: {
          kind: 'chip',
          occurrenceId: 'chip-' + (view.occurrences.length + 1) + '-' + api.rev,
          source: ref.source, ref: ref.ref, label: ref.label,
          clipboardText: String(ref.clipboardText == null ? '' : ref.clipboardText),
        },
      }];
      if (tail !== ' ') put = put.concat(textUnits(' '));
      spliceUnits(put, span);
      bump();
      return true;
    };

    api.insertText = function (text, span) {
      if (span.draftRev !== api.rev) return false;
      var view = project(nodes);
      if (!inBounds(span, view.detectText.length)) return false;
      spliceUnits(textUnits(String(text == null ? '' : text)), span);
      bump();
      return true;
    };

    /** 退路（更老的宿主）：收的是**剪贴板**全文，chip 跟着重设掉。 */
    api.setDraft = function (text) {
      nodes = String(text || '') ? [{ kind: 'text', text: String(text) }] : [];
      bump();
    };

    /** 在 detect 空间里摆一个选区（`start === end` 就是光标）；不传就是清掉。 */
    api.select = function (start, end) {
      if (start === undefined || start === null) { api.selection = null; api.caret = null; return; }
      var stop = end === undefined || end === null ? start : end;
      api.selection = { start: start, end: stop };
      api.caret = start === stop ? start : null;
    };

    /** 新会话 = 新草稿（宿主里草稿按会话分）。 */
    api.reset = function () {
      api.rev += 1;
      nodes = [];
      api.session = null;
      api.selection = null;
      api.caret = null;
      api.notices.length = 0;
      listeners.slice().forEach(function (fn) { fn(); });
    };

    Object.defineProperty(api, 'draft', { get: function () { return project(nodes).clipboardText; } });
    Object.defineProperty(api, 'chips', { get: function () { return project(nodes).occurrences; } });
    Object.defineProperty(api, 'detect', { get: function () { return project(nodes).detectText; } });

    return api;
  }

  root.StudymateAskDraft = { makeAskDraft: makeAskDraft, CHIP_PLACEHOLDER: CHIP_PLACEHOLDER };
}(typeof globalThis !== 'undefined' ? globalThis : this));
