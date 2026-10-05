/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 导出域 —— 离线页面的组装（**纯字符串**，不读盘、不碰 fs）

   路线（ADR-0005 / 目标态规格 §8）：导出**不是第二个渲染器**，而是「阅读端本体 + 它的数据 +
   一个最小宿主」三件东西装进一个目录：

     index.html            壳：画布、脚本顺序、无脚本时的一句话
     host.js               最小宿主：冻结模块表 + fetch 应答 + 取图地址改写
     boot.js               挂载：把 lib/client.js 当 DSH 客户端插件那样 apply 起来
     studymate-client.js   **lib/client.js 逐字拷贝**（一个字节都不改，见下）
     vendor/*.js           React 的 production CJS 构建，包一层 module/exports/require/process
     data.js               整份 library 快照 + 参考资料正文（JSON）
     assets/<科目>/…        课件配图，原样拷贝
     export.json           产物清单（谁生的、几个文件、第三方构建的哈希）

   **为什么不是「导出时算好静态标记」**：静态标记只能由某个渲染器产出，而仓库里唯一的渲染器
   就是 `lib/client.js` 里那套 React 组件——它在工厂闭包里，只把 `{inject, apply}` 交出去
   （`client.js` 文件头的注册契约）。要在 Node 侧把它渲成标记，就得给那个文件加导出、再搭一套
   `react-dom/server`；那既是「第二个渲染路径」，也会碰 `release.mjs:175-176` 明文禁止的
   **对 `lib/client.js` 做打包/改造**。所以走「原样搬运 + 浏览器里自渲染」这条：同一份渲染代码、
   零改造、离线可用。代价写在报告里：产物是「自包含的页面」而不是「纯静态标记」，页面里有脚本。

   **为什么 vendor 要包一层**：那几份是 CommonJS 文件（写 module.exports、向模块表要 scheduler、
   读 NODE_ENV），直接当 classic script 执行会污染全局并互相踩名字（react 与
   react-dom 有同名内部变量）。包一层 `function (module, exports, require, process)` 就是宿主
   的懒 CJS 模型本身：登记进模块表，第一次 `require` 才执行。**包的是壳，不是内容**——
   中间那段是上游文件的逐字节拷贝，哈希进 `export.json`，泄漏守卫按哈希核对（见 guard.ts）。
   ───────────────────────────────────────────────────────────────────────── */

import { escAttr, escText } from '../core/format.ts';

/** 导出目录的名字（工作区里的默认落点）：`<工作区>/export/`。 */
export const OUT_DIR_NAME = 'export';

export const ENTRY_FILE = 'index.html';
export const HOST_FILE = 'host.js';
export const BOOT_FILE = 'boot.js';
export const DATA_FILE = 'data.js';
export const CLIENT_FILE = 'studymate-client.js';
export const MANIFEST_FILE = 'export.json';
export const VENDOR_DIR = 'vendor';
export const ASSETS_DIR = 'assets';

/** 与 `bin/dsh-plugin.ts` 里那三条路由同名——离线页面就地作答这几条（见 hostScript）。 */
export const LIBRARY_ENDPOINT = '/api/studymate/library';
export const REFERENCE_ENDPOINT = '/api/studymate/reference';
export const ASSET_ENDPOINT = '/api/studymate/asset';
/** 作答数据的写入口（#72）：离线页面明确回 403，不假装落盘。 */
export const ATTEMPTS_ENDPOINT = '/api/studymate/attempts';

/** 冻结模块表里的键名：与宿主给阅读端的名字逐字相同（client.js 只 require 'react'）。 */
export const VENDOR_MODULES = {
  scheduler: 'scheduler',
  react: 'react',
  reactDomCore: 'react-dom',
  reactDom: 'react-dom/client',
} as const;

export type VendorKey = keyof typeof VENDOR_MODULES;

/** vendor 文件名：用上游文件名，一眼看出搬的是哪一份构建。 */
export const VENDOR_FILES: Record<VendorKey, string> = {
  scheduler: `${VENDOR_DIR}/scheduler.production.js`,
  react: `${VENDOR_DIR}/react.production.js`,
  reactDomCore: `${VENDOR_DIR}/react-dom.production.js`,
  reactDom: `${VENDOR_DIR}/react-dom-client.production.js`,
};

/* ── 公式（#91）：引擎与它的样式表/字体在产物里的落点 ────────────────────────
   两处的判据不同，别照着一个改另一个（两条都是实测出来的）：
     · **引擎**（`katex.min.js`）走 vendor 包装壳：它自己写着 CommonJS 的 `module.exports`，
       直接放导出根目录会被泄漏守卫的 `node-module-exports` 判红；包一层就是宿主那个懒 CJS
       模型本身，守卫按 `third_party` 的哈希核对壳里那一段。
     · **样式表与字体**落 `assets/`：守卫按路径前缀把 `assets/**` 判成 asset（二进制不扫、
       也不按 utf8 读），字体落别处会因为「utf8 读坏 → 字节数与清单对不上」判红。
       字体与 CSS 的相对位置**是契约**：CSS 里的 `url(fonts/…)` 相对样式表自己的 URL 解析，
       所以两者都在这一个目录下（`file://` 下这条已被实测验证）。 */
export const MATH_VENDOR_FILE = `${VENDOR_DIR}/katex.production.js`;
/** 公式资源在产物里的目录（CSS 与 `fonts/` 是兄弟，见上）。 */
export const MATH_ASSET_DIR = `${ASSETS_DIR}/katex`;

/* ── vendor 包装：登记 + 懒执行 ─────────────────────────────────────────── */

/**
 * 包装壳的**唯一定义**（泄漏守卫按同一份解析回来，别在两处各写一遍）。
 * 中间是上游文件的逐字节内容，前后各一行壳。
 */
export function vendorFile(moduleName: string, body: string): string {
  return `window.__smDefine(${JSON.stringify(moduleName)}, function (module, exports, require, process) {\n`
    + `${body}\n});\n`;
}

/** 从产物文本里切回「壳里的那份上游内容」；不是这个形状就返回 null（守卫据此判篡改）。 */
export function splitVendor(text: string): { moduleName: string; body: string } | null {
  const match = /^window\.__smDefine\(("(?:[^"\\]|\\.)*"), function \(module, exports, require, process\) \{\n([\s\S]*)\n\}\);\n$/.exec(text);
  if (!match) return null;
  try {
    return { moduleName: JSON.parse(match[1]), body: match[2] };
  } catch {
    return null;
  }
}

/* ── 三个脚本产物 ───────────────────────────────────────────────────────── */

export interface ExportData {
  /** 整份 library 快照（形状 = `readLibrary()` 的返回值，与 DSH 的 `/api/studymate/library` 同一份）。 */
  library: unknown;
  /** 参考资料正文：`{ [科目 slug]: { [reference 内相对路径]: 文本 } }`。 */
  reference: Record<string, Record<string, string>>;
  /** 产物的元信息（不含任何机器路径）。 */
  meta: { generatedAt: string; subjects: string[]; react: string; client: string };
}

/**
 * `data.js`：整份快照就是一段 JSON 赋值。
 *
 * 为什么把 `<` 转义掉：内容里出现 `</script>`（比如课件里讲 HTML 的代码块）会把脚本标签提前
 * 闭合，页面从此崩在一半——JSON 里 `\u003c` 与 `<` 等价，转义不影响数据。
 */
export function dataScript(data: ExportData): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, (ch) => (ch === '\u2028' ? '\\u2028' : '\\u2029'));
  return `/* StudyMate 导出的离线数据：整份工作区快照（与 DSH 的 GET /api/studymate/library 同一形状）。
   只读——离线页面不写任何学习数据。 */
window.__STUDYMATE_EXPORT__ = ${json};
`;
}

/**
 * `host.js`：最小宿主。
 *
 * 与 DSH 的差别只有五处，**每一处都只在这一个文件里**（`lib/client.js` 一个字都不用改）：
 *   ① 冻结模块表：宿主给阅读端 9 个键，这里只备它真正 require 的 react（其余键一次都没要过，
 *      要了就会在 `__smRequire` 上抛出来——这是刻意的，别悄悄补一堆空对象）；
 *   ② 插件注册口 `window.__ModuleLoader__`：阅读端按插件规范往它登记工厂；
 *   ③ `fetch`：阅读端读的接口（library / reference）就地作答——离线页面没有 Host 半；
 *      **写请求一律回 403 并说清去哪写**（作答与资料都要回 DSH 里写），不假装成功；
 *   ④ 变更推送（#74）：离线页面是快照，没有 Host 半可推——用一个**静默的 EventSource 替身**，
 *      不让真 EventSource 去连 `/api/studymate/events`（`file://` 下必然失败，控制台会脏）；
 *   ⑤ 取图地址：阅读端按宿主路由写 `/api/studymate/asset?…`，离线页面里图与页面同处一个目录
 *      树（`assets/<科目>/<相对路径>`）。改写在 **`src` 的 setter** 上——晚一步（比如渲染完再
 *      扫 DOM）浏览器已经按旧地址发过请求了，控制台会多一条失败请求。
 */
export function hostScript(): string {
  return `/* StudyMate 导出的离线页面 —— 最小宿主（reading-end 本体在 studymate-client.js 里，逐字）。 */
(function () {
  'use strict';

  var DATA = window.__STUDYMATE_EXPORT__ || {};
  var LIBRARY_ENDPOINT = ${JSON.stringify(LIBRARY_ENDPOINT)};
  var REFERENCE_ENDPOINT = ${JSON.stringify(REFERENCE_ENDPOINT)};
  var ASSET_ENDPOINT = ${JSON.stringify(ASSET_ENDPOINT)};
  var ATTEMPTS_ENDPOINT = ${JSON.stringify(ATTEMPTS_ENDPOINT)};

  /* 离线页面是**只读**的：这条话说一次，两处写入口（作答、资料）都照它回。 */
  var READ_ONLY = {
    error: 'read-only',
    message: '这是导出的离线页面，只能读：作答与资料都要回 DSH 的阅读端里写'
      + '（那里才会落进 attempts/ 与 reference/）。这次作答只留在当前这一屏。',
  };

  /* ① 冻结模块表（宿主的懒 CJS 模型）：vendor/ 下的第三方构建按名字登记，第一次取用才跑。
     执行时把 CommonJS 那四样（module / exports / require / process）递进去——**不是可选的**：
     那些构建顶上就向模块表要 react、并读 NODE_ENV，不传进去它们拿到的是 undefined
     （踩过：页面起来一半，报「Cannot set properties of undefined」）。
     这段注释刻意不写那两种调用的字面写法：泄漏守卫按原文扫（注释也算），
     注释里写出来会把自己扫红——要写就把规则改成先剥注释。 */
  var factories = Object.create(null);
  var modules = Object.create(null);
  window.__smDefine = function (name, factory) {
    if (typeof factory !== 'function') throw new Error('模块表里登记的必须是函数：' + name);
    factories[name] = factory;
  };
  window.__smRequire = function (name) {
    if (name in modules) return modules[name];
    if (!(name in factories)) {
      throw new Error('模块表里没有这个键：' + name + '（离线页面只备了阅读端真正要的那几个）');
    }
    // 局部变量刻意不叫 module / exports：泄漏守卫按原文扫，页面自己的代码里出现 CommonJS 那套
    // 名字就该被拦下（第三方构建里当然有，但那一段在 vendor 的包装壳里，按哈希核对）。
    var box = { exports: {} };
    factories[name](box, box.exports, window.__smRequire, { env: { NODE_ENV: 'production' } });
    modules[name] = box.exports;
    return modules[name];
  };

  /* ② 阅读端往这里登记工厂（宿主那边是 window.__ModuleLoader__.load）。 */
  window.__STUDYMATE_CLIENT__ = null;
  window.__ModuleLoader__ = {
    load: function (entry) { window.__STUDYMATE_CLIENT__ = entry; },
  };

  /* ②′ 公式资源的位置（#91）：阅读端默认去 Host 半的投送路由取（DSH 里那条
     /api/studymate/math/…），导出页没有 Host 半——与取图那条改写同一个口径，用一个全局把
     产物里的位置告诉它。css 给相对路径（相对 index.html，也就是产物根），字体随样式表自己
     的 URL 解析（url(fonts/…)），所以只需要这一个字段；js 给空串 = 引擎必须已经挂在
     window.katex 上（产物里那份走 vendor 包装壳登记进模块表，由 boot.js 取出来挂上）。 */
  window.__STUDYMATE_MATH__ = { css: ${JSON.stringify(`${MATH_ASSET_DIR}/katex.min.css`)}, js: '' };

  /* ③ fetch 应答：形状照 bin/dsh-plugin.ts 的三条路由。 */
  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  function withoutQuery(url) {
    var text = String(url);
    var mark = text.indexOf('?');
    return mark < 0 ? text : text.slice(0, mark);
  }
  function queryOf(url) {
    var text = String(url);
    var mark = text.indexOf('?');
    return new URLSearchParams(mark < 0 ? '' : text.slice(mark + 1));
  }
  window.fetch = function (url, options) {
    var method = String((options && options.method) || 'GET').toUpperCase();
    var target = withoutQuery(url);
    if (target === LIBRARY_ENDPOINT) {
      if (!DATA.library) return Promise.resolve(json({ error: '导出数据没装进来（data.js 缺失或被改坏）' }, 500));
      return Promise.resolve(json(DATA.library));
    }
    if (target === REFERENCE_ENDPOINT) {
      if (method !== 'GET') return Promise.resolve(json(READ_ONLY, 403));
      var query = queryOf(url);
      var slug = query.get('subject') || '';
      var rel = query.get('path') || '';
      var forSubject = DATA.reference && DATA.reference[slug];
      var text = forSubject ? forSubject[rel] : undefined;
      if (typeof text !== 'string') {
        return Promise.resolve(json({ error: 'not-found', message: '导出时没有这一份资料（或者它不是文本）' }, 404));
      }
      return Promise.resolve(json({ text: text, entry: { path: rel } }));
    }
    if (target === ATTEMPTS_ENDPOINT) {
      // 作答是**写**：离线页面不落盘（也不假装落了）。这一屏照常判分，只是回不去。
      return Promise.resolve(json(READ_ONLY, 403));
    }
    return Promise.resolve(json({
      error: 'not-found',
      message: '离线页面只应答 library 与 reference 的读请求（写请求一律 403），收到的是：' + target,
    }, 404));
  };

  /* ④ 变更推送：离线页面是**导出那一刻的快照**，没有 Host 半可以推。
     真 EventSource 会去连 /api/studymate/events，在 file:// 下必然失败（控制台一条 CORS、
     一条失败请求，浏览器套件按问题计）。所以给一个「永远静默」的替身：不连、不重连、不报错。 */
  function SilentEventSource(url) {
    this.url = String(url);
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
  }
  SilentEventSource.prototype.close = function () { this.readyState = 2; };
  SilentEventSource.prototype.addEventListener = function () {};
  SilentEventSource.prototype.removeEventListener = function () {};
  SilentEventSource.CONNECTING = 0;
  SilentEventSource.OPEN = 1;
  SilentEventSource.CLOSED = 2;
  window.EventSource = SilentEventSource;

  /* ⑤ 取图地址改写：/api/studymate/asset?subject=X&path=Y → assets/X/Y。
     path 是阅读端 encodeURIComponent 过的整段相对路径，这里按段编回去（保留 '/' 分段）。 */
  function localAssetUrl(value) {
    if (typeof value !== 'string' || value.slice(0, ASSET_ENDPOINT.length + 1) !== ASSET_ENDPOINT + '?') return value;
    var query = new URLSearchParams(value.slice(ASSET_ENDPOINT.length + 1));
    var slug = query.get('subject') || '';
    var rel = query.get('path') || '';
    return 'assets/' + encodeURIComponent(slug) + '/'
      + rel.split('/').map(encodeURIComponent).join('/');
  }
  try {
    var descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (descriptor && typeof descriptor.set === 'function') {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: function () { return descriptor.get.call(this); },
        set: function (next) { descriptor.set.call(this, localAssetUrl(next)); },
      });
    }
  } catch (error) {
    /* 改不掉就按原地址走：图会缺，页面其余部分照常——比整个页面起不来好 */
  }
})();
`;
}

/** `boot.js`：把阅读端本体挂到画布上（与 `scripts/tests/fixtures/reading_position_fixture.mjs` 同一套座位表）。 */
export function bootScript(): string {
  return `/* StudyMate 导出的离线页面 —— 挂载。座位表照宿主：阅读端只往 main 与 sidebar.panellist 登记。 */
(function () {
  'use strict';
  var host = document.getElementById('studymate-export');
  function fail(error) {
    if (!host) return;
    var box = document.createElement('div');
    box.className = 'smb-export-error';
    box.setAttribute('role', 'alert');
    box.textContent = '导出的页面没能起来：' + String((error && error.message) || error)
      + '。这份产物是自包含的，重新导一次通常就好；还不行就把这句话连同导出的目录一起报给维护者。';
    host.textContent = '';
    host.appendChild(box);
  }
  try {
    var React = window.__smRequire('react');
    var client = window.__smRequire('react-dom/client');
    /* 公式引擎（#91）：产物里那份 KaTeX 在 vendor 的包装壳里（守卫按哈希核对它是不是上游构建的
       逐字节拷贝）。DSH 那边是一个 classic script，UMD 自己会写上 window.katex；这里是懒登记的
       模块，得取一次才执行——判据因此是同一条：**阅读端只看 window.katex**。
       取不到就不挂（这次导出没带公式资源 / 壳坏了）：阅读端那边降级成可读的 TeX 原文。 */
    try { window.katex = window.__smRequire('katex'); } catch (error) { /* 没有就算了，别挡住页面 */ }
    var entry = window.__STUDYMATE_CLIENT__;
    if (!entry || typeof entry.factory !== 'function') {
      throw new Error('阅读端本体没有登记（studymate-client.js 没跑起来）');
    }
    var plugin = entry.factory(window.__smRequire);
    var seats = {};
    plugin.apply({
      slots: {
        inject: function (name, fn) { if (name === 'main') fn(); },
        register: function (seat, component) { seats[seat.name] = component; return function () {}; },
      },
    });
    if (!seats.main) throw new Error('阅读端没有往 main 座位登记');
    client.createRoot(host).render(React.createElement(seats.main));
    /* 渲染是异步排队的：等一拍看有没有东西挂上去。一整片空白比一句人话难查得多。 */
    window.setTimeout(function () {
      if (host && host.childNodes.length === 0) fail(new Error('两秒过去了页面还是空的'));
    }, 2000);
  } catch (error) {
    fail(error);
  }
})();
`;
}

/* ── 壳 ─────────────────────────────────────────────────────────────────── */

/* 转义用 `lib/core/format.ts` 那对（`escText` / `escAttr`），**不在这里再写一份**：
   原来这里有一个私有的 `escapeHtml`，形状与 `escAttr` 几乎一样、只少转一个 `'`，却被用在
   `<script src="…">` 与 `title="…"` 两个属性位置上——属性值用双引号包裹时少转单引号还能
   侥幸，但它与 `format.ts:97` 明说的「属性值：再多转 `"` 与 `'`」是两份会漂的判据。
   标题与说明里的科目名是**学生数据**（`pageTitle` 直接用 `subjects[].name`），
   所以这里不是理论洁癖。 */

export interface IndexOptions {
  title: string;
  /** 产物清单一句话（学生打开页面时看得见的那一行说明用的 title/aria）。 */
  note: string;
  scripts: string[];
}

/**
 * `index.html`。
 *
 * 三条刻意的写法：
 *   · **全部是 classic script**（没有 `type="module"`）：`file://` 下 ES 模块受 CORS 限制加载
 *     不了，模块化的页面在离线打开时是白屏——这条由泄漏守卫钉住；
 *   · 画布高度显式给足（阅读端本体自带全部样式，但它假设自己占满一块画布）；
 *   · 无脚本时说明白为什么看不到内容，而不是留一片空白。
 */
export function indexHtml(options: IndexOptions): string {
  const scripts = options.scripts.map((src) => `<script src="${escAttr(src)}"></script>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escText(options.title)}</title>
<meta name="generator" content="StudyMate 导出（阅读端本体，离线）">
<style>
  /* 阅读端本体把自己的样式整份注入 <style>；这里只管画布与「起不来」时的兜底外观。 */
  html, body { margin: 0; height: 100%; }
  body { background: #f6f7f9; color: #1b1f27; font: 13px/1.65 system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif; }
  #studymate-export { height: 100vh; }
  #studymate-export > * { height: 100%; }
  .smb-export-error { max-width: 46em; margin: 12vh auto; padding: 16px 18px; border: 1px solid #e6e8ee;
    border-radius: 10px; background: #fff; line-height: 1.7; }
</style>
</head>
<body>
<div id="studymate-export" title="${escAttr(options.note)}"></div>
<noscript>
  <div class="smb-export-error">这个页面和 DSH 里的阅读端是同一份渲染代码，所以它需要脚本才能画出来。
  在浏览器里允许这个页面运行脚本即可（它不联网：数据、样式、图都在这个目录里）。</div>
</noscript>
${scripts}
</body>
</html>
`;
}

/** 产物文件名清单（index.html 里脚本标签的顺序 = 依赖顺序）。 */
export function scriptFiles(reactFiles: Record<VendorKey, string>): string[] {
  return [
    DATA_FILE,
    HOST_FILE,
    reactFiles.scheduler,
    reactFiles.react,
    reactFiles.reactDomCore,
    reactFiles.reactDom,
    // 公式引擎（#91）排在阅读端本体之前：它只是往模块表里登记（懒执行），而阅读端渲染到公式
    // 时就要用它——排在后面就来不及（阅读端那次渲染已经在跑了）。
    MATH_VENDOR_FILE,
    CLIENT_FILE,
    BOOT_FILE,
  ];
}

/**
 * 配图在导出目录里的落点：`assets/<科目>/<科目内相对路径>`（POSIX 分隔符）。
 *
 * `rel` 用的是**阅读端取图时给的那一段**（`assets/img/pool/x.png` 这种，相对科目目录写），
 * 于是页面里的映射就是一次字符串拼接：`/api/studymate/asset?subject=X&path=Y` → `assets/X/Y`。
 * 换一种镜像方式（比如去掉里层的 `assets/`）就得在页面里再写一次路径规整，那是两份真相。
 */
export function assetProductPath(slug: string, rel: string): string {
  return `${ASSETS_DIR}/${slug}/${rel.split('\\').join('/')}`;
}

/** 页面标题：一门科目就用它的名字，多门就用工作区的说法。 */
export function pageTitle(subjectNames: string[]): string {
  if (subjectNames.length === 0) return 'StudyMate 离线页面';
  if (subjectNames.length === 1) return `${subjectNames[0]} · StudyMate 离线页面`;
  return `StudyMate 离线页面（${subjectNames.length} 门科目）`;
}
