/* 测试用的 Antigravity `sidecar_sdk` 替身。
 *
 * 真实 SDK 只活在 Antigravity 宿主进程里（`sidecar_sdk` 是个裸说明符，没有 npm 包），CI 的
 * ubuntu-latest 上根本解析不到。这里按真实 `sidecar_sdk/index.mjs` 的**对外行为**复刻一份：
 *   · `SidecarApp` 预置 `/preload.js`（宿主平台把 window.sidecar 等能力注入这一份）；
 *   · `pages` 是 `路 径 → handler`，`apis` 是 `路 径 → Map(方法 → handler)`（同一路径可同时挂 GET 与 POST）；
 *   · handler 返回 `Response`、`Buffer` 或 `string` 都行，包装规则与真实 SDK 一致；
 *   · `requestApi` 按真实 SDK 的规则合并 query 与 body，并复刻 UI token 校验。
 *
 * 只服务测试：`requestPage` / `requestApi` 是替身自己的调用口，真实 SDK 由宿主代跑。
 */

const TEXT_HTML = 'text/html; charset=utf-8';
const APPLICATION_JSON = 'application/json; charset=utf-8';
const APPLICATION_JAVASCRIPT = 'application/javascript; charset=utf-8';

export class Response {
  constructor(body, options = {}) {
    this.body = body;
    this.status = options.status ?? 200;
    this.contentType = options.contentType ?? 'text/html';
    this.headers = options.headers ?? {};
  }
}

export class SidecarApp {
  constructor() {
    this.pages = new Map();
    this.apis = new Map();
    // 与真实 sidecar_sdk 一致：平台注入 preload.js，页面里第一个 <script> 就靠它。
    this.pages.set('/preload.js', () => '/* mock preload.js */');
  }

  page(urlPath, handler) {
    this.pages.set(urlPath, handler);
    return this;
  }

  api(urlPath, handler, method = 'POST') {
    let methods = this.apis.get(urlPath);
    if (!methods) {
      methods = new Map();
      this.apis.set(urlPath, methods);
    }
    methods.set(method.toUpperCase(), handler);
    return this;
  }

  async requestPage(urlPath, query = {}) {
    const handler = this.pages.get(urlPath);
    if (!handler) {
      return { status: 404, contentType: 'text/plain', headers: {}, body: 'not found' };
    }
    const result = await handler(query);
    if (result instanceof Response) {
      return {
        status: result.status,
        contentType: result.contentType,
        headers: result.headers,
        body: result.body,
      };
    }
    // 真实 SDK 按扩展名挑默认 MIME；其余一律 text/html。
    const contentType = urlPath.endsWith('.js') ? APPLICATION_JAVASCRIPT : TEXT_HTML;
    return { status: 200, contentType, headers: {}, body: result };
  }

  async requestApi(method, urlPath, { query = {}, body = undefined, headers = {}, uiToken = '' } = {}) {
    const verb = method.toUpperCase();
    if (uiToken && verb !== 'GET') {
      const token = headers['x-sidecar-token'] || headers['X-Sidecar-Token'];
      if (token !== uiToken) {
        return {
          status: 401,
          contentType: APPLICATION_JSON,
          headers: {},
          json: { error: 'invalid sidecar token' },
        };
      }
    }
    const methods = this.apis.get(urlPath);
    const handler = methods ? methods.get(verb) : undefined;
    if (!handler) {
      return {
        status: 404,
        contentType: APPLICATION_JSON,
        headers: {},
        json: { error: 'not found' },
      };
    }
    // 真实 SDK 的入参合并口径：query 先、JSON 对象 body 覆盖；`token` 是宿主内部键，不交给 handler。
    // 原始非法 JSON 或数组会原样交给 handler（handler 自己的防御逻辑要能被测到）。
    const data = { ...query };
    delete data.token;
    if (body && typeof body === 'object' && !Array.isArray(body)) Object.assign(data, body);
    else if (body !== undefined) data.body = body;
    const result = await handler(data);
    if (result instanceof Response) {
      return {
        status: result.status,
        contentType: result.contentType,
        headers: result.headers,
        body: result.body,
        json: tryParseJson(result.body),
      };
    }
    return { status: 200, contentType: APPLICATION_JSON, headers: {}, json: result };
  }
}

function tryParseJson(body) {
  if (typeof body !== 'string') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
