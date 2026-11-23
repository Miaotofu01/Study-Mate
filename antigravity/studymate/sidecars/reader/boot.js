/* StudyMate Antigravity Sidecar 挂载与交互桥接。
 *
 * 阅读端本体（/studymate-client.js）是 DSH 客户端插件，它只认三件宿主标准件：
 *   · `SessionProvider` —— 把某条会话罩在子树外面（occurrence 的会话就是「谁罩着我」）；
 *   · `renderSlot` / `renderFactorySlot` —— 让宿主自己把会话正文画进去。
 * 这里用 Sidecar 的 `window.sidecar.agent` / `window.sidecar.ui` 重演这三种能力：
 * 面板里写的字会直接送进 Antigravity 当前对话（或新开一条答疑对话）。
 */
(function () {
  'use strict';

  var MAX_DRAFT_CHARS = 131072; // 128 KiB：侧栏草稿不需要更大，超出就是有人在灌数据

  var hostEl = document.getElementById('studymate-reader');

  function fail(error) {
    if (!hostEl) return;
    var box = document.createElement('div');
    box.className = 'smb-export-error';
    box.setAttribute('role', 'alert');
    box.textContent = 'StudyMate 学习面板加载失败：' + String((error && error.message) || error);
    var hint = document.createElement('p');
    hint.style.margin = '8px 0 0';
    hint.textContent = '请先确认 Antigravity 里已装好并启用这份插件（Sidecar 需要随产物生成的 React 运行时与 Node >= 24），'
      + '然后重新打开侧栏里的 StudyMate Reader 面板；还是不行就把这句话连同插件目录一起报给维护者。';
    box.appendChild(hint);
    hostEl.textContent = '';
    hostEl.appendChild(box);
  }

  /* 解析当前 Antigravity 工作区 URI（带超时保护，不卡死启动） */
  function resolveInitialWorkspaces() {
    if (!window.sidecar || typeof window.sidecar.getWorkspaceUris !== 'function') {
      return Promise.resolve([]);
    }
    return Promise.race([
      window.sidecar.getWorkspaceUris().catch(function () { return []; }),
      new Promise(function (resolve) { setTimeout(function () { resolve([]); }, 400); }),
    ]);
  }

  resolveInitialWorkspaces().then(function (uris) {
    if (Array.isArray(uris)) window.__STUDYMATE_WS_URIS__ = uris;

    var React = window.__smRequire('react');
    var client = window.__smRequire('react-dom/client');

    var entry = window.__STUDYMATE_CLIENT__;
    if (!entry || typeof entry.factory !== 'function') {
      throw new Error('阅读端本体没有登记（studymate-client.js 没跑起来）');
    }

    /* ── 答疑会话桥接 ──────────────────────────────────────────────────── */

    var registeredQuoteSource = null;
    var sessionMap = Object.create(null); // id -> { id, title, updatedAt, subject, node, nodeId, lesson }
    var sessionListeners = new Set();
    var sessionSeq = 0;
    var draftStores = Object.create(null); // id -> { state, listeners, rev }

    function sessionSnapshot() {
      return { ids: Object.keys(sessionMap), byId: sessionMap };
    }

    function notifySessions() {
      sessionListeners.forEach(function (fn) {
        try { fn(); } catch (error) { console.error('[studymate] 会话列表监听器抛错：', error); }
      });
    }

    function rememberSession(data) {
      if (!data || !data.ok || !data.sessionId) return;
      var existing = sessionMap[data.sessionId];
      sessionMap[data.sessionId] = {
        id: data.sessionId,
        title: data.title || existing?.title || ('答疑 · ' + (data.subject || '课程')),
        updatedAt: Date.now(),
        subject: data.subject || '',
        node: data.node || '',
        nodeId: data.nodeId || '',
        lesson: data.lesson || '',
      };
      notifySessions();
    }

    function getDraftStore(sessionId) {
      if (!draftStores[sessionId]) {
        draftStores[sessionId] = {
          rev: 1,
          state: {
            draft: '',
            draftRev: 1,
            occurrences: [],
            selection: { start: 0, end: 0 },
            caret: 0,
            detectText: '',
          },
          listeners: new Set(),
        };
      }
      return draftStores[sessionId];
    }

    function notifyDraft(store) {
      store.listeners.forEach(function (fn) {
        try { fn(); } catch (error) { console.error('[studymate] 草稿监听器抛错：', error); }
      });
    }

    function updateDraftOccurrence(sessionId, nextOcc) {
      var store = getDraftStore(sessionId);
      var clip = nextOcc ? String(nextOcc.clipboardText || '') : '';
      if (clip.length > MAX_DRAFT_CHARS) {
        clip = clip.slice(0, MAX_DRAFT_CHARS);
        console.warn('[studymate] 引用片段超过 ' + MAX_DRAFT_CHARS + ' 字符，已截断');
      }
      store.rev += 1;
      store.state = {
        draft: clip,
        draftRev: store.rev,
        occurrences: nextOcc ? [Object.assign({}, nextOcc, { offset: 0, length: clip.length })] : [],
        selection: { start: nextOcc ? 1 : 0, end: nextOcc ? 1 : 0 },
        caret: nextOcc ? 1 : 0,
        detectText: nextOcc ? '￼' : '',
      };
      notifyDraft(store);
    }

    /* 建好的答疑会话必须出现在面板的会话下拉里：监听 qa/session 的应答。 */
    window.__smRegisterFetchObserver(function (url, response) {
      if (typeof url !== 'string' || url.indexOf('/api/studymate/qa/session') === -1) return;
      response.clone().json().then(rememberSession).catch(function () {});
    });

    var SessionCtx = React.createContext(null);

    function SessionProvider(props) {
      return React.createElement(SessionCtx.Provider, { value: props.session }, props.children);
    }

    /* ── 面板里的问答（发送到 Antigravity 对话） ───────────────────────── */

    function AntigravityAskBox() {
      var retained = React.useContext(SessionCtx);
      var sessionId = retained && retained.binding && retained.binding.ctx ? retained.binding.ctx.sessionId : '';
      var meta = sessionMap[sessionId] || {};
      var store = getDraftStore(sessionId || 'default');

      var snapState = React.useState(function () { return store.state; });
      var snap = snapState[0];
      var setSnap = snapState[1];

      React.useEffect(function () {
        setSnap(store.state);
        var listener = function () { setSnap(store.state); };
        store.listeners.add(listener);
        return function () { store.listeners.delete(listener); };
      }, [store]);

      var questionState = React.useState('');
      var question = questionState[0];
      var setQuestion = questionState[1];

      var busyState = React.useState(false);
      var sending = busyState[0];
      var setSending = busyState[1];

      var statusState = React.useState('');
      var statusMsg = statusState[0];
      var setStatusMsg = statusState[1];

      var historyState = React.useState([]);
      var sentHistory = historyState[0];
      var setSentHistory = historyState[1];

      var occ = snap && snap.occurrences && snap.occurrences[0] ? snap.occurrences[0] : null;
      var quoteState = React.useState('');
      var serializedQuote = quoteState[0];
      var setSerializedQuote = quoteState[1];

      React.useEffect(function () {
        if (!occ) {
          setSerializedQuote('');
          return;
        }
        var fallback = String(occ.clipboardText || '');
        if (registeredQuoteSource && registeredQuoteSource.codec
          && typeof registeredQuoteSource.codec.serialize === 'function') {
          var cancelled = false;
          Promise.resolve(registeredQuoteSource.codec.serialize(occ.ref)).then(function (value) {
            if (!cancelled) setSerializedQuote(typeof value === 'string' && value ? value : fallback);
          }).catch(function () {
            if (!cancelled) setSerializedQuote(fallback);
          });
          return function () { cancelled = true; };
        }
        setSerializedQuote(fallback);
      }, [occ]);

      function buildPrompt(userText) {
        var parts = ['[StudyMate 局部答疑]'];
        if (meta.subject || meta.node) {
          parts.push('当前课程：' + [meta.subject, meta.node].filter(Boolean).join(' / ')
            + (meta.nodeId ? '（节点 ' + meta.nodeId + '）' : ''));
        }
        if (serializedQuote) parts.push('选中片段：\n' + serializedQuote);
        parts.push('学生问题：' + String(userText || '').trim());
        parts.push('（请按 StudyMate local-qa 局部答疑规范简短精准解答，直接回应核心困惑，不必重新排课。）');
        return parts.join('\n\n');
      }

      function ready() {
        if (!window.sidecar || !window.sidecar.agent) {
          setStatusMsg('未检测到 Antigravity 通信接口，请直接在左侧聊天框提问。');
          return false;
        }
        return true;
      }

      function sendToCurrentChat(newConversation) {
        var text = question.trim();
        if (!text && !serializedQuote) return;
        if (!ready()) return;
        var finalQuestion = text || '请结合上下文通俗解释一下上面选中的这段内容。';
        var prompt = buildPrompt(finalQuestion);
        setSending(true);
        setStatusMsg(newConversation ? '正在新开 Antigravity 答疑对话…' : '正在发送给当前 Antigravity 对话…');

        var call = newConversation
          ? window.sidecar.agent.startConversation(prompt, meta.title || 'StudyMate 答疑')
          : window.sidecar.agent.sendMessage(prompt);

        Promise.resolve(call).then(function () {
          sessionSeq += 1;
          setSentHistory(function (prev) {
            return [{
              time: new Date().toLocaleTimeString(),
              text: finalQuestion,
              hasQuote: !!serializedQuote,
              mode: newConversation ? '新对话' : '当前对话',
            }].concat(prev).slice(0, 5);
          });
          setQuestion('');
          if (occ) updateDraftOccurrence(sessionId || 'default', null);
          setStatusMsg(newConversation
            ? '已创建独立答疑对话，请在左侧会话列表查看回复。'
            : '已发送到当前 Antigravity 对话，请在左侧聊天区查看回复。');
        }).catch(function (error) {
          setStatusMsg('发送失败：' + String((error && error.message) || error));
        }).finally(function () {
          setSending(false);
        });
      }

      function attachToInputBox() {
        var text = question.trim();
        if (!window.sidecar || !window.sidecar.ui || typeof window.sidecar.ui.addArtifactComment !== 'function') {
          setStatusMsg('当前环境不支持填充聊天输入框，请点击「发送到当前对话」。');
          return;
        }
        try {
          window.sidecar.ui.addArtifactComment({
            uri: 'studymate://' + (meta.nodeId || 'lesson'),
            pageTitle: meta.title || 'StudyMate 课件',
            selection: serializedQuote || undefined,
            comment: text || '关于这段内容我有疑问：',
          });
          setStatusMsg('已引用到 Antigravity 聊天输入框，可直接补充后按回车发送。');
        } catch (error) {
          setStatusMsg('填充输入框失败：' + String((error && error.message) || error));
        }
      }

      var h = React.createElement;
      return h('div', { className: 'smb-ag-ask' },
        h('div', { className: 'smb-ag-ask__title' }, '直连 Antigravity 助教'),
        h('div', { className: 'smb-ag-ask__quick' },
          ['用通俗例子讲一下', '这步公式怎么推出来的？', '这里容易踩什么坑？'].map(function (preset) {
            return h('button', {
              key: preset,
              type: 'button',
              className: 'smb-ag-ask__chip',
              onClick: function () { setQuestion(preset); },
            }, preset);
          })
        ),
        h('textarea', {
          className: 'smb-ag-ask__textarea',
          placeholder: occ
            ? '针对上方引用片段输入你的问题（回车可直接发送）…'
            : '输入关于本课的疑问（也可在左侧正文划选段落后点「就这段问一句」）…',
          value: question,
          maxLength: MAX_DRAFT_CHARS,
          onChange: function (event) { setQuestion(event.target.value); },
          onKeyDown: function (event) {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (!sending) sendToCurrentChat(false);
            }
          },
        }),
        h('div', { className: 'smb-ag-ask__actions' },
          h('button', {
            type: 'button',
            className: 'smb-ag-ask__btn smb-ag-ask__btn--primary',
            disabled: sending || (!question.trim() && !serializedQuote),
            onClick: function () { sendToCurrentChat(false); },
          }, sending ? '发送中…' : '发送到当前对话'),
          h('button', {
            type: 'button',
            className: 'smb-ag-ask__btn',
            disabled: sending || (!question.trim() && !serializedQuote),
            onClick: function () { sendToCurrentChat(true); },
          }, '新开答疑对话'),
          serializedQuote ? h('button', {
            type: 'button',
            className: 'smb-ag-ask__btn',
            onClick: attachToInputBox,
          }, '塞进输入框') : null
        ),
        statusMsg ? h('div', { className: 'smb-ag-ask__status' }, statusMsg) : null,
        sentHistory.length > 0 ? h('div', { className: 'smb-ag-ask__history' },
          sentHistory.map(function (item, index) {
            return h('div', { key: index, className: 'smb-ag-ask__item' },
              h('div', { style: { opacity: 0.7, fontSize: '11px' } },
                item.time + ' · ' + item.mode + (item.hasQuote ? '（含引用）' : '')),
              h('div', null, item.text)
            );
          })
        ) : null
      );
    }

    /* ── 座位 ──────────────────────────────────────────────────────────── */

    var seats = Object.create(null);

    function knownSeat(name) {
      return typeof seats[name] === 'function' ? seats[name] : null;
    }

    function renderFactorySlot(slotName, props) {
      if (slotName === 'conversation.content' || slotName === 'studymate.ask.session') {
        return React.createElement(AntigravityAskBox, null);
      }
      var seat = knownSeat(slotName);
      return seat ? React.createElement(seat, props || {}) : null;
    }

    function renderSlot(slotName, props) {
      if (slotName === 'main') {
        var mainSeat = knownSeat('main');
        return mainSeat
          ? React.createElement(mainSeat, Object.assign({}, props, { SessionProvider: SessionProvider, renderSlot: renderSlot, renderFactorySlot: renderFactorySlot }))
          : null;
      }
      if (slotName === 'conversation.content') return renderFactorySlot(slotName, props);
      var seat = knownSeat(slotName);
      return seat
        ? React.createElement(seat, Object.assign({}, props, { SessionProvider: SessionProvider, renderSlot: renderSlot, renderFactorySlot: renderFactorySlot }))
        : null;
    }

    /* ── 宿主服务（slots / sessions / inputTriggers / conversation） ────── */

    var sessionsService = {
      list: {
        getSnapshot: sessionSnapshot,
        subscribe: function (listener) {
          sessionListeners.add(listener);
          return function () { sessionListeners.delete(listener); };
        },
      },
      retain: function (id, options) {
        var bound = { sessionId: id, source: (options && options.source) || 'studyMateSidecar' };
        return {
          sessionId: id,
          binding: { ctx: bound },
          ready: Promise.resolve(),
          release: function () {},
        };
      },
      scope: function (id) {
        return { sessionId: id };
      },
      refresh: function () {},
    };

    var inputTriggersService = {
      registerSource: function (source) {
        registeredQuoteSource = source;
        return function () {
          if (registeredQuoteSource === source) registeredQuoteSource = null;
        };
      },
    };

    var conversationService = {
      input: {
        for: function (actionContext) {
          var sid = (actionContext && actionContext.sessionId) || 'default';
          var store = getDraftStore(sid);
          return {
            state: {
              getSnapshot: function () { return store.state; },
              subscribe: function (listener) {
                store.listeners.add(listener);
                return function () { store.listeners.delete(listener); };
              },
            },
            insertReference: function (insert) {
              if (!insert) return false;
              updateDraftOccurrence(sid, insert);
              return true;
            },
            insertText: function (text) {
              if (text === '') {
                updateDraftOccurrence(sid, null);
                return true;
              }
              return false;
            },
            setDraft: function (text) {
              if (!text) updateDraftOccurrence(sid, null);
              return true;
            },
            notify: function () {},
            focus: function () {},
          };
        },
      },
    };

    /* ── 插件上下文（effect 真的执行，清理函数收进同一条链） ───────────── */

    var cleanups = [];

    function createContext() {
      return {
        get: function (name) {
          if (name === 'slots') return slotsService;
          if (name === 'sessions') return sessionsService;
          if (name === 'inputTriggers') return inputTriggersService;
          if (name === 'conversation') return conversationService;
          return null;
        },
        effect: function (fn, label) {
          if (typeof fn !== 'function') return;
          var dispose;
          try {
            dispose = fn();
          } catch (error) {
            console.error('[studymate] effect 执行失败' + (label ? '（' + label + '）' : '') + '：', error);
            return;
          }
          if (typeof dispose === 'function') {
            cleanups.push(dispose);
            return dispose;
          }
          return undefined;
        },
        slots: slotsService,
      };
    }

    var slotsService = {
      inject: function (name, fn) {
        if (typeof fn === 'function') fn();
        return function () {};
      },
      register: function (seat, component) {
        seats[seat.name] = component;
        return function () {
          if (seats[seat.name] === component) delete seats[seat.name];
        };
      },
    };

    window.__smUnmountReader = function () {
      while (cleanups.length > 0) {
        var cleanup = cleanups.pop();
        try { cleanup(); } catch (error) { console.error('[studymate] 清理失败：', error); }
      }
    };

    var plugin = entry.factory(window.__smRequire);
    plugin.apply(createContext());

    if (!knownSeat('main')) throw new Error('阅读端没有往 main 座位登记');

    client.createRoot(hostEl).render(React.createElement(knownSeat('main'), {
      SessionProvider: SessionProvider,
      renderSlot: renderSlot,
      renderFactorySlot: renderFactorySlot,
    }));

    /* 工作区切换：更新 URI 后立刻让推送通道报一次变化，页面不必刷新。 */
    if (window.sidecar && typeof window.sidecar.onWorkspaceChange === 'function') {
      window.sidecar.onWorkspaceChange(function (nextUris) {
        window.__STUDYMATE_WS_URIS__ = Array.isArray(nextUris) ? nextUris : [];
        if (typeof window.__smNotifyWorkspaceChanged === 'function') {
          window.__smNotifyWorkspaceChanged();
        }
      });
    }
  }).catch(fail);
})();
