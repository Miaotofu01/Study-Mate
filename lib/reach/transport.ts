/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 核验域 —— 一次 HTTP 探测怎么发出去

   为什么不用 `fetch`：本包**零运行时依赖**（`scripts/tests/test_architecture_boundaries.mjs`
   的 `package: false` 一路禁到 import 裸包），而 `fetch` 不支持按请求指定代理——Node 自带的
   环境变量代理由 `NODE_USE_ENV_PROXY` 那条路走，只有 ≥24 有，而本包支持 ^22.19。
   所以这里直接用 `node:net` / `node:tls` 发一条 HTTP/1.1 GET：四个分支（直连／代理 ×
   http／https）共用同一套读写逻辑，判据全在盘上，测试里用一个真的 loopback 服务器就能验。

   **只要响应头**：读到 `\r\n\r\n` 就断连接、不看正文。核的是「这个链接还能不能打开」，
   不是「内容有没有变」——正文留给上游的抓取环节（那是另一件事）。

   **永远 resolve，不抛**：连不上、超时、证书过不了都是**结果的一种**，不是异常。
   调用方按事实字段判断，与实验域那条「跑命令永远 resolve」同一个姿势。
   ───────────────────────────────────────────────────────────────────────── */

import net from 'node:net';
import tls from 'node:tls';

/**
 * 走哪条路。`未探` = **这一轮一条都没真探过**：清单里没有 http(s) 链接、全部命中缓存、
 * `offline` 没发请求，或墙上预算在第一条之前就用完。那时「走的是哪条路」无从谈起，
 * 如实报 `未探`——它不是「直连」的同义词。
 */
export type RouteName = '直连' | '代理' | '未探';

export interface ProxyTarget {
  readonly host: string;
  readonly port: number;
}

export interface RequestResult {
  /** 2xx／3xx 算打得开；4xx／5xx 与连接层面失败都算打不开。 */
  readonly ok: boolean;
  /** HTTP 状态码；连状态行都没拿到时是 0。 */
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string;
  /** 拿不到状态行时一句人读的原因；成功时是空串。 */
  readonly note: string;
  /** true = 连接层面就失败了（不是服务器回了 4xx／5xx）。路由表靠它决定要不要换条路重试。 */
  readonly transport: boolean;
}

const USER_AGENT = 'StudyMate-reach/1.0';
const HEADER_CAP = 8192;
const DEFAULT_PROXY_PORT = 80;

/** 认 `<主机>:<端口>` 与带 scheme 的写法；认不出来就是 null（当没配代理）。 */
export function parseProxy(raw: string | undefined | null): ProxyTarget | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    const port = url.port === '' ? DEFAULT_PROXY_PORT : Number.parseInt(url.port, 10);
    if (url.hostname === '' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: url.hostname, port };
  } catch {
    return null;
  }
}

/**
 * 代理从标准环境变量来，参数可以临时覆盖一个。
 * **不硬编码端口、不试探本机常见端口**——那一场角色自己摸出 `127.0.0.1:2080` 才通上一部分站，
 * 那是它的临时手段，不该变成引擎的行为。
 */
export function proxyFromEnv(
  env: Record<string, string | undefined>,
  override?: string | undefined,
): ProxyTarget | null {
  return parseProxy(override)
    ?? parseProxy(env['HTTPS_PROXY']) ?? parseProxy(env['https_proxy'])
    ?? parseProxy(env['HTTP_PROXY']) ?? parseProxy(env['http_proxy'])
    ?? parseProxy(env['ALL_PROXY']) ?? parseProxy(env['all_proxy']);
}

/** 连接层面的失败翻成一句人读的话。 */
function classify(error: NodeJS.ErrnoException): string {
  const code = error.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS 解析不了';
  if (code === 'ECONNREFUSED') return '连不上（连接被拒）';
  if (code === 'ECONNRESET') return '连不上（连接被重置）';
  if (code === 'ETIMEDOUT') return '超时';
  if (code === 'EPROTO') return 'TLS 握手失败';
  if (code.startsWith('CERT') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return '证书过不了';
  }
  return `连不上（${code === '' ? error.message : code}）`;
}

/**
 * 探一个 URL。`route: '代理'` 时 `proxy` 不能是 null（那是调用方的编排错误，按连接失败报）。
 */
export function requestOnce(
  url: URL,
  options: {
    readonly route: RouteName;
    readonly proxy: ProxyTarget | null;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<RequestResult> {
  const { route, proxy, timeoutMs, signal } = options;
  return new Promise<RequestResult>((resolve) => {
    let settled = false;
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const sockets: net.Socket[] = [];

    const finish = (result: RequestResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (onAbort !== null && signal !== undefined) signal.removeEventListener('abort', onAbort);
      for (const socket of sockets) socket.destroy();
      resolve(result);
    };
    const fail = (note: string): void => finish({
      ok: false, status: 0, statusText: '', contentType: '', note, transport: true,
    });
    const open = (status: number, statusText: string, contentType: string): void => finish({
      ok: status >= 200 && status < 400, status, statusText, contentType, note: '', transport: false,
    });

    if (signal?.aborted === true) {
      fail('已取消');
      return;
    }
    if (route === '代理' && proxy === null) {
      fail('要走走代理，但没有可用的代理地址');
      return;
    }

    const secure = url.protocol === 'https:';
    const port = url.port === '' ? (secure ? 443 : 80) : Number.parseInt(url.port, 10);
    const viaProxy = route === '代理' && proxy !== null;
    // 走代理发 http 要给**绝对 URI**（转发代理的规矩）；其余三种情况都是原始请求行。
    const requestText = viaProxy && !secure
      ? `GET ${url.href} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: ${USER_AGENT}\r\nAccept: */*\r\nConnection: close\r\n\r\n`
      : `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: ${USER_AGENT}\r\nAccept: */*\r\nConnection: close\r\n\r\n`;

    const track = (socket: net.Socket): net.Socket => {
      sockets.push(socket);
      return socket;
    };

    const onHeaders = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1');
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffer.length > HEADER_CAP) fail('响应头超过上限');
        return;
      }
      const lines = buffer.slice(0, end).split('\r\n');
      const statusLine = lines[0] ?? '';
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(statusLine);
      if (match === null) {
        fail(`状态行读不出来：${statusLine.slice(0, 60)}`);
        return;
      }
      let contentType = '';
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0 && line.slice(0, colon).toLowerCase() === 'content-type') {
          contentType = line.slice(colon + 1).trim();
        }
      }
      open(Number.parseInt(match[1] ?? '0', 10), (match[2] ?? '').trim(), contentType);
    };

    /** 给一个已经连上的 socket 挂读写。**只挂一次**——重复挂会让同一个失败报两遍。 */
    const listen = (socket: net.Socket): void => {
      socket.setNoDelay(true);
      socket.on('data', onHeaders);
      socket.on('error', (error: Error) => fail(classify(error as NodeJS.ErrnoException)));
      socket.on('close', () => {
        if (!settled) fail('连接提前关闭');
      });
    };

    if (viaProxy && secure && proxy !== null) {
      // https 走代理：先 CONNECT 打通隧道，再在隧道上做 TLS 握手（这就是手写这一段的原因）。
      const proxySocket = track(net.connect({ host: proxy.host, port: proxy.port }));
      const authority = `${url.hostname}:${port}`;
      let tunnel = '';
      let tunnelling = true;
      proxySocket.on('error', (error: Error) => fail(classify(error as NodeJS.ErrnoException)));
      proxySocket.on('close', () => {
        if (!settled && tunnelling) fail('代理提前关闭了连接');
      });
      proxySocket.on('connect', () => {
        proxySocket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nUser-Agent: ${USER_AGENT}\r\n\r\n`);
      });
      proxySocket.on('data', (chunk: Buffer) => {
        if (!tunnelling) return;
        tunnel += chunk.toString('latin1');
        const end = tunnel.indexOf('\r\n\r\n');
        if (end < 0) {
          if (tunnel.length > HEADER_CAP) fail('代理的响应头超过上限');
          return;
        }
        tunnelling = false;
        proxySocket.removeAllListeners('data');
        const statusLine = tunnel.slice(0, end).split('\r\n')[0] ?? '';
        if (!/^HTTP\/\d(?:\.\d)?\s+200\b/.test(statusLine)) {
          fail(`代理不开隧道（${statusLine.slice(0, 60)}）`);
          return;
        }
        const secureSocket = track(tls.connect({ socket: proxySocket, servername: url.hostname }));
        listen(secureSocket);
        secureSocket.on('secureConnect', () => secureSocket.write(requestText));
      });
      return;
    }

    if (secure) {
      const socket = track(tls.connect({ host: url.hostname, port, servername: url.hostname }));
      listen(socket);
      socket.on('secureConnect', () => socket.write(requestText));
    } else {
      const host = viaProxy && proxy !== null ? proxy.host : url.hostname;
      const target = viaProxy && proxy !== null ? proxy.port : port;
      const socket = track(net.connect({ host, port: target }));
      listen(socket);
      socket.on('connect', () => socket.write(requestText));
    }

    timer = setTimeout(() => fail(`超时（${timeoutMs} ms）`), timeoutMs);
    if (signal !== undefined) {
      onAbort = () => fail('已取消');
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
