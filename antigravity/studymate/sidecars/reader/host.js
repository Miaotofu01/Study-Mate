/* StudyMate Antigravity Sidecar 宿主桥接层。
 *
 * 这一层只做「把 DSH 宿主给的东西用 Sidecar 环境重演一遍」：
 *   · 冻结模块表（阅读端只认 require('react') 这类键，不自己打包 React）；
 *   · 分块加载（无界笔记住在 /client.notes.js，第一次真需要时才拉）；
 *   · 单一 fetch 拦截器（透传当前工作区 + Sidecar token，并给 boot.js 一个观察口）；
 *   · 变更推送的轮询替身（Sidecar 代理不转发长连接 SSE）。
 * 注意：本文件是 classic script，不是模块；所有入口都挂在 window 上。
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var sidecarToken = params.get('token') || '';

  /* ── 1. 冻结模块表 ─────────────────────────────────────────────────────── */

  var factories = Object.create(null);
  var modules = Object.create(null);
  var ALIASES = { 'react/jsx-dev-runtime': 'react/jsx-runtime' };

  window.__smDefine = function (name, factory) {
    if (typeof factory !== 'function') throw new Error('模块表里登记的必须是函数：' + name);
    factories[name] = factory;
  };

  function requireSync(name) {
    var key = ALIASES[name] || name;
    if (key in modules) return modules[key];
    if (!(key in factories)) {
      throw new Error('模块表里没有这个键：' + key + '（Sidecar 只备了阅读端真正要的那几个）');
    }
    var box = { exports: {} };
    factories[key](box, box.exports, window.__smRequire, { env: { NODE_ENV: 'production' } });
    modules[key] = box.exports;
    return modules[key];
  }

  /* ── 2. 分块加载：require.async('./client.notes.js') ───────────────────── */

  var chunkFactories = Object.create(null); // chunk 文件名 → load() 登记的那条 entry
  var chunkWaiters = Object.create(null);   // chunk 文件名 → { resolve, reject }[]
  var chunkLoading = Object.create(null);   // chunk 文件名 → 去重 Promise

  function normalizeChunk(specifier) {
    var text = String(specifier || '');
    text = text.replace(/^\.\//, '');
    var slash = text.lastIndexOf('/');
    return slash === -1 ? text : text.slice(slash + 1);
  }

  function settleChunk(name, entry) {
    var waiters = chunkWaiters[name] || [];
    delete chunkWaiters[name];
    delete chunkLoading[name];
    chunkFactories[name] = entry;
    var value;
    try {
      value = typeof entry.factory === 'function' ? entry.factory(window.__smRequire) : entry;
    } catch (error) {
      for (var i = 0; i < waiters.length; i++) waiters[i].reject(error);
      return;
    }
    for (var j = 0; j < waiters.length; j++) waiters[j].resolve(value);
  }

  requireSync.async = function (specifier) {
    var name = normalizeChunk(specifier);
    if (chunkFactories[name]) {
      try {
        return Promise.resolve(
          typeof chunkFactories[name].factory === 'function'
            ? chunkFactories[name].factory(window.__smRequire)
            : chunkFactories[name],
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (chunkLoading[name]) return chunkLoading[name];
    // 只有笔记分块是已知的：别的名字直接拒绝，绝不静默回退成同步注入。
    if (name !== 'client.notes.js') {
      return Promise.reject(new Error('Sidecar 宿主没有这个分块：' + name));
    }
    chunkLoading[name] = new Promise(function (resolve, reject) {
      if (!chunkWaiters[name]) chunkWaiters[name] = [];
      chunkWaiters[name].push({ resolve: resolve, reject: reject });
      var script = document.createElement('script');
      script.src = '/client.notes.js';
      script.async = true;
      script.onerror = function () {
        delete chunkLoading[name];
        delete chunkWaiters[name];
        reject(new Error('分块脚本没加载起来：/client.notes.js（构建产物缺失？）'));
      };
      script.onload = function () {
        // load() 在脚本执行时同步登记；没登记 = 那份产物形状不对。
        if (!chunkFactories[name] && chunkWaiters[name]) {
          var waiters = chunkWaiters[name];
          delete chunkWaiters[name];
          delete chunkLoading[name];
          for (var i = 0; i < waiters.length; i++) {
            waiters[i].reject(new Error('分块脚本执行完了，但没有登记 client.notes.js'));
          }
        }
      };
      document.head.appendChild(script);
    });
    return chunkLoading[name];
  };
  window.__smRequire = requireSync;

  /* ── 3. 阅读端登记口 ───────────────────────────────────────────────────── */

  window.__STUDYMATE_CLIENT__ = null;
  window.__ModuleLoader__ = {
    load: function (entry) {
      if (!entry || typeof entry !== 'object') throw new Error('__ModuleLoader__.load 需要一条登记');
      if (typeof entry.chunk === 'string' && entry.chunk !== '') {
        settleChunk(entry.chunk, entry);
        return;
      }
      window.__STUDYMATE_CLIENT__ = entry;
    },
  };

  /* 公式资源：JS/CSS/字体统一走 /api/studymate/math/* 这一条真相。 */
  window.__STUDYMATE_MATH__ = {
    css: '/api/studymate/math/katex.min.css',
    js: '/api/studymate/math/katex.min.js',
  };

  /* ── 4. 当前工作区 URI 与请求改写 ─────────────────────────────────────── */

  window.__STUDYMATE_WS_URIS__ = [];

  function withWorkspace(url) {
    if (!window.__STUDYMATE_WS_URIS__ || window.__STUDYMATE_WS_URIS__.length === 0) return url;
    if (typeof url !== 'string' || url.indexOf('/api/studymate/') !== 0) return url;
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    return url + sep + 'ws=' + encodeURIComponent(JSON.stringify(window.__STUDYMATE_WS_URIS__));
  }

  /* ── 5. 单一 fetch 拦截器 ──────────────────────────────────────────────── */

  var rawFetch = window.fetch.bind(window);
  window.__smRawFetch = rawFetch;
  var fetchObservers = [];

  /** boot.js 的观察口：fn(url, response) 在每次 /api/studymate/* 应答后调用（响应体归观察者 clone）。 */
  window.__smRegisterFetchObserver = function (fn) {
    if (typeof fn !== 'function') return;
    fetchObservers.push(fn);
  };

  function notifyObservers(url, response) {
    for (var i = 0; i < fetchObservers.length; i++) {
      try {
        fetchObservers[i](url, response);
      } catch (error) {
        console.error('[studymate] fetch observer 抛错：', error);
      }
    }
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    if (typeof url !== 'string' || url.indexOf('/api/studymate/') !== 0) {
      return rawFetch(input, init);
    }
    var nextUrl = withWorkspace(url);
    var opts = Object.assign({}, init || {});
    var headers = new Headers(opts.headers || undefined);
    // token 只走 header，不写进 URL（URL 会进日志、进 Referer）。
    if (sidecarToken) headers.set('X-Sidecar-Token', sidecarToken);
    opts.headers = headers;
    return rawFetch(nextUrl, opts).then(function (response) {
      notifyObservers(url, response);
      return response;
    });
  };

  /* ── 6. 取图地址改写（幂等：只包一次 setter） ─────────────────────────── */

  function localAssetUrl(value) {
    if (typeof value !== 'string') return value;
    var mark = value.indexOf('/api/studymate/asset?');
    if (mark === -1) return value;
    // 绝对地址（http://…/api/…) 与站点根路径都归一到 pathname 再拼 ws。
    var tail = value.slice(mark);
    var hash = '';
    var hashIndex = tail.indexOf('#');
    if (hashIndex !== -1) {
      hash = tail.slice(hashIndex);
      tail = tail.slice(0, hashIndex);
    }
    var rewritten = withWorkspace(tail);
    return value.slice(0, mark) + rewritten + hash;
  }

  try {
    if (!HTMLImageElement.prototype.__smSrcPatched) {
      var descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (descriptor && typeof descriptor.set === 'function') {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          configurable: true,
          enumerable: descriptor.enumerable,
          get: function () { return descriptor.get.call(this); },
          set: function (next) { descriptor.set.call(this, localAssetUrl(next)); },
        });
        Object.defineProperty(HTMLImageElement.prototype, '__smSrcPatched', {
          configurable: true,
          value: true,
        });
      }
    }
  } catch (error) {
    // 改不掉就按原地址走：图可能缺，页面其余部分照常——比整个页面起不来好。
    console.warn('[studymate] 取图地址改写没装上：', error);
  }

  /* ── 7. 变更推送的轮询替身 ────────────────────────────────────────────── */

  var liveSources = [];

  function PollingEventSource(url) {
    this.url = String(url);
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this._listeners = { open: [], message: [], error: [] };
    this._closed = false;
    this._lastVer = null;
    this._seq = 0;
    this._openTimer = null;
    this._pollTimer = null;

    var self = this;
    liveSources.push(self);

    this._openTimer = setTimeout(function () {
      self._openTimer = null;
      if (self._closed) return;
      self.readyState = 1; // OPEN
      emit(self, 'open', { type: 'open' });
      poll(self);
      self._pollTimer = setInterval(function () { poll(self); }, 2500);
    }, 50);
  }

  function emit(source, type, event) {
    var handler = source['on' + type];
    if (typeof handler === 'function') {
      try { handler.call(source, event); } catch (error) { console.error('[studymate] EventSource 回调抛错：', error); }
    }
    var list = source._listeners[type] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i].call(source, event); } catch (error) { console.error('[studymate] EventSource 监听器抛错：', error); }
    }
  }

  function publishChanged(source) {
    if (source._closed) return;
    source._seq += 1;
    emit(source, 'message', {
      type: 'message',
      data: JSON.stringify({
        kind: 'changed',
        domains: ['all'],
        at: new Date().toISOString(),
        seq: source._seq,
      }),
    });
  }

  function poll(source) {
    if (source._closed) return;
    rawFetch(withWorkspace('/api/studymate/poll-version')).then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (data) {
      if (source._closed || !data || !data.version) return;
      if (source._lastVer !== null && data.version !== source._lastVer) {
        publishChanged(source);
      }
      source._lastVer = data.version;
    }).catch(function (error) {
      // 轮询失败不是错误流：下一次 tick 会重试；只记一条方便排障。
      if (!source._closed) console.warn('[studymate] 版本轮询失败：', error);
    });
  }

  PollingEventSource.prototype.close = function () {
    this._closed = true;
    this.readyState = 2; // CLOSED
    if (this._openTimer) {
      clearTimeout(this._openTimer);
      this._openTimer = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    var index = liveSources.indexOf(this);
    if (index !== -1) liveSources.splice(index, 1);
  };
  PollingEventSource.prototype.addEventListener = function (type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  };
  PollingEventSource.prototype.removeEventListener = function (type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter(function (item) { return item !== fn; });
  };
  PollingEventSource.CONNECTING = 0;
  PollingEventSource.OPEN = 1;
  PollingEventSource.CLOSED = 2;
  window.EventSource = PollingEventSource;

  /** 工作区切换后立刻让每条存活的推送通道报一次「变了」，前端无需刷新。 */
  window.__smNotifyWorkspaceChanged = function () {
    for (var i = 0; i < liveSources.length; i++) publishChanged(liveSources[i]);
  };
})();
