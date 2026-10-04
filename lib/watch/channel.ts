/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 变更推送通道（#74）—— 一条 SSE 流

   **推的是变更通知，不是整份数据**：`lib/watch/notice.ts` 里那个
   `{kind:'changed', domains, at, seq}`，页面收到后自己按需重取。

   两条路，先试带认证的那条（ticket 明文：先流式 Response，不行再 webServer）：

   路 A（默认）`connection.fetch.register({path:'/api/studymate/events', …})`
     返回一个 **body 没写完的 `Response`**。为什么这样能当 SSE 用：载体的
     `bridge()` 是「先 writeHead，再 `for await (chunk of response.body)` 逐个 write」
     （dsh-client-connection/lib/index.js:34-100），所以只要我们不 close 这个
     ReadableStream，字节就是一条条推出去的。附带好处：路由挂在 `/api` 下，
     **Host/Origin 围栏与浏览器会话认证由载体自动做**（§6.3），我们一行认证都不用写。

   路 B（退路）`ctx.webServer.register({kind:'exact', path:'/plugins/studymate/events'})`
     裸 node `IncomingMessage`/`ServerResponse`（§6.5 的官方 HMR 模板，逐条照抄）。
     这条路**不在** `/api` 围栏里，认证得自己判：能拿到 connection 就调
     `connection.requestRejection(req)`，拿不到就只在 loopback 上用，并且每次建连
     都会 `console.warn` 一句（不许静默地开一个谁都能读的端点）。

   没有心跳定时器：loopback 上没有中间代理会掐闲置连接，而写定时器要自己管生命周期
   （拔线、卸载、HMR 重载叠份）。断线由客户端的 EventSource 自己重连，
   重连成功后 `onopen` 会触发一次静默重取对账（见 lib/client.js）。
   ───────────────────────────────────────────────────────────────────────── */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { sseFrame, sseGreeting, subscribeNotices } from './notice.ts';

/** 路由挂在 `/api` 之下：载体自动做围栏 + 浏览器会话认证。 */
export const EVENTS_PATH = '/api/studymate/events';
/** 退路路径：`/plugins/*` 不属于 `/api` 围栏，认证自己判。 */
export const FALLBACK_EVENTS_PATH = '/plugins/studymate/events';

/** 一个已经连上的页面。两条路都在这里收口，广播逻辑只有一份。 */
export interface SseClient {
  send(text: string): void;
  close(): void;
}

export interface PushChannel {
  /** 已连上的页面数（测试与探针用）。 */
  size(): number;
  add(client: SseClient): void;
  remove(client: SseClient): void;
  closeAll(): void;
}

/** 建一条通道：订阅通知总线，来一条广播一条。返回的那份要负责 `closeAll()`。 */
export function createChannel(): PushChannel {
  const clients = new Set<SseClient>();
  const unsubscribe = subscribeNotices((notice) => {
    const frame = sseFrame(notice);
    for (const client of [...clients]) {
      try { client.send(frame); } catch { clients.delete(client); }
    }
  });
  return {
    size: () => clients.size,
    add(client) { clients.add(client); },
    remove(client) { clients.delete(client); },
    closeAll() {
      unsubscribe();
      for (const client of [...clients]) {
        clients.delete(client);
        try { client.close(); } catch { /* 关不掉就算了 */ }
      }
    },
  };
}

/* ── 路 A：流式 Response（`/api/studymate/events`）──────────────────────── */

/**
 * 一个永远不主动 `close()` 的 `Response`：body 是 ReadableStream，
 * 之后每来一条通知就 enqueue 一帧。
 */
export function streamResponse(channel: PushChannel, request: Request): Response {
  const encoder = new TextEncoder();
  let client: SseClient | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const entry: SseClient = {
        send(text) {
          if (!open) return;
          try { controller.enqueue(encoder.encode(text)); } catch { open = false; }
        },
        close() {
          if (!open) return;
          open = false;
          try { controller.close(); } catch { /* 已经关了 */ }
        },
      };
      client = entry;
      channel.add(entry);
      // 问候是一行注释（`:` 开头），EventSource 不派发它；它让「通道真的通了」可观测
      // （探针按 backend= 断言到底用的是哪条监听后端）。
      entry.send(sseGreeting());

      // 载体在 `res` 关闭时 abort 这个 signal（bridge 里 res.on('close')）：
      // 页面关掉/刷新时这里必须把客户端摘掉，否则连接集合只涨不减。
      const drop = (): void => { channel.remove(entry); };
      if (request.signal.aborted) drop();
      else request.signal.addEventListener('abort', drop, { once: true });
    },
    cancel() {
      if (client) channel.remove(client);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  });
}

/** connection 服务里我们用到的最小面。 */
export interface ConnectionLike {
  fetch?: { register(route: {
    path: string; methods: string[]; requestBody: 'buffered';
    fetch: (request: Request) => Promise<Response> | Response;
  }): () => Promise<void> | void };
  requestRejection?: (request: unknown) => number | undefined;
}

/** 注册路 A。返回 disposer；`register` 抛异常时**不**吞掉（调用方决定是否退到路 B）。 */
export function registerStreamRoute(connection: ConnectionLike, channel: PushChannel, path = EVENTS_PATH): () => Promise<void> | void {
  const registry = connection.fetch;
  if (!registry || typeof registry.register !== 'function') throw new Error('connection 上没有 fetch.register');
  return registry.register({
    path,
    // 只声明 GET：HEAD 会在载体里被当成「有 body 的请求」一直吊着（见文件头注释）
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request: Request) => {
      try {
        return streamResponse(channel, request);
      } catch (error) {
        return new Response(`studymate: 建不了事件流：${error instanceof Error ? error.message : String(error)}`, { status: 500 });
      }
    },
  });
}

/* ── 路 B：`ctx.webServer.register` 的裸 node 处理器 ─────────────────────── */

export function registerWebRoute(
  webServer: { register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void },
  channel: PushChannel,
  connection: ConnectionLike | undefined,
  path = FALLBACK_EVENTS_PATH,
): () => void {
  return webServer.register({
    kind: 'exact',
    path,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      // 这条路不在 /api 围栏里（§6.5 的原话）：认证自己判
      const rejection = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : undefined;
      if (rejection !== undefined) { res.writeHead(rejection); res.end(); return; }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      let open = true;
      const entry: SseClient = {
        send(text) { if (!open) return; try { res.write(text); } catch { open = false; } },
        close() { if (!open) return; open = false; try { res.end(); } catch { /* 已经断了 */ } },
      };
      channel.add(entry);
      entry.send(sseGreeting());
      res.on('close', () => { open = false; channel.remove(entry); });
    },
  });
}
