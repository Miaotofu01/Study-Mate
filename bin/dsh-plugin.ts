// StudyMate 的 DSH 插件入口（Host 半）。
//
// 三件事：
//   1. 注册「学习模式」预设（原有行为，保持不变）；
//   2. 注册八个**原生工具**（#68）：总控拿到的是结构化返回，不是 exit code；
//   3. 给阅读端（Client 半 lib/client.js）供学习工作区数据：
//      GET  /api/studymate/library   —— 整份快照，走宿主的 /api 认证通道，与其他插件取业务数据同一条路；
//      GET  /api/studymate/asset     —— 课件配图（二进制）；
//      GET/POST /api/studymate/reference —— 学生自加的参考资料：读取与写入（ADR-0010）。
//
// 三处刻意的写法，别顺手改回去：
//   · `lib/` 下的模块用**动态 import**，且在注入回调里才加载。这个文件会被
//     scripts/tests/test_bundle.mjs 单独拷进一个临时目录跑（那里没有 lib/），
//     顶层静态 import 会让「安装器边界失败」那条用例在解析期就崩掉。
//   · 路由与工具都不写成顶层 `inject: ['connection'|'tools']`。那样在没装那个服务的组合
//     （headless / tui，或更老的宿主）里整个插件都不会 apply，连预设都注册不上；
//     用 ctx.inject 只在服务就绪时挂上，缺了就不挂。ctx.inject 不存在时也不该炸。
//   · 工具注册**只**走 `registerStudyMate(ctx)` 一个入口（见 lib/tools/index.ts）。
//     #69/#70/#73/#74 往那个函数的清单里各加一行，不在这个文件里写具体工具。
import { installPayload } from './studymate.mjs';

/* ── 宿主的插件上下文 ────────────────────────────────────────────────────
   本仓库不依赖宿主的类型包（Host 半是零依赖的插件），所以按**用到的成员**描述形状：
   全部可选——缺 connection 的组合（headless / tui）与更老的宿主都会传进来一个残缺的 ctx，
   下面每一步都在运行期自己判一次。 */

/** `ctx.get('profileContext')` 给的 profile 归属。 */
interface ProfileContext {
  name: string;
  home: string;
}

/** connection 的精确路由表：以 path 为键，同一个 path 注册第二次会抛「already registered」。 */
interface FetchRegistry {
  register(route: {
    path: string;
    methods: string[];
    requestBody: 'buffered';
    fetch: (request: Request) => Promise<Response> | Response;
  }): unknown;
}

/** 服务就绪时挂上来的那一层 ctx（`ctx.inject([…], …)` 的回调参数）。 */
interface InjectedContext {
  connection?: { fetch?: FetchRegistry };
  /** 与 tools / connection 一起注入进来的服务；本文件只把它转交给 lib/tools。 */
  tools?: unknown;
  /** 第二个参数是给宿主日志用的说明文字（cordis 的 effect(fn, label)）。 */
  effect?: (fn: () => unknown, description?: string) => unknown;
}

interface PluginContext {
  get?: (name: string) => ProfileContext | undefined;
  agentPresets?: { register: (config: unknown) => unknown };
  effect?: (fn: () => unknown, description?: string) => unknown;
  inject?: (names: string[], handler: (ctx: InjectedContext) => void) => unknown;
}

export const inject = ['agentPresets'];

const LIBRARY_PATH = '/api/studymate/library';
const ASSET_PATH = '/api/studymate/asset';
const REFERENCE_PATH = '/api/studymate/reference';

export async function apply(ctx: PluginContext): Promise<void> {
  const profile = ctx.get?.('profileContext');
  if (!profile || !ctx.agentPresets?.register) {
    console.warn('StudyMate：当前 DSH 不支持原生插件接口（需要 0.1.7-alpha.1+）；已跳过原生加载。旧版请使用 npx -y @yunmiao/studymate@latest install。');
  } else {
    try {
      // installPayload 在 bin/studymate.mjs（本次不迁）：TS 从 JS 里推断出「四个必填参数」，
      // 而 native 启动本来就只传这三个（其余由它自己探测/默认）。断言只影响类型，运行期一字未改。
      const { registration } = installPayload({
        native: true, profile: profile.name, dshHome: profile.home,
      } as Parameters<typeof installPayload>[0]);
      // `!`：ctx.effect 缺失时的 TypeError 由下面的 catch 兜住（与迁移前同一条路径）
      await ctx.effect!(() => ctx.agentPresets!.register(registration.config));
    } catch (error) {
      // Startup may report a problem, but must not migrate profile ownership.
      console.warn(`StudyMate：已跳过原生加载。${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── 原生工具（#68）─────────────────────────────────────────────────────
  // 与路由同一种姿势：tools 服务就绪才注册，缺了就不注册（不让整个插件不 apply）。
  // 具体注册什么在 lib/tools/index.ts 的 registerStudyMate 里——这个文件不认识任何工具。
  // 模块在这里 await 加载（不是丢一个浮动 Promise）：apply 返回时工具已经注册好，
  // 「插件加载完就能按名字查到工具」才是可断言的；这个文件也可能被单独拷出去跑（那时 ctx
  // 没有 inject），所以加载放在 inject 判断之后。
  if (typeof ctx.inject !== 'function') return;
  try {
    const { registerStudyMate } = await import('../lib/tools/index.ts');
    ctx.inject(['tools'], (toolsCtx) => {
      try {
        registerStudyMate(toolsCtx as unknown as Parameters<typeof registerStudyMate>[0]);
      } catch (error) {
        // 工具注册不上不该拖垮插件：预设与阅读端数据通路照常
        console.warn(`StudyMate：原生工具注册失败，总控只能退回旧路径。${error instanceof Error ? error.message : String(error)}`);
      }
    });
  } catch (error) {
    console.warn(`StudyMate：原生工具模块加载不了，总控只能退回旧路径。${error instanceof Error ? error.message : String(error)}`);
  }

  // ── 阅读端的数据通路 ───────────────────────────────────────────────────
  // 每次请求现读工作区：学习文件是纯文本、体量小（目标态 §12「按需扫描足够」），
  // 不落盘索引、不加缓存，也就没有「文件变了页面还是旧的」这类要同步的状态。
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['connection'], (connectionCtx) => {
    // 反射取出来的 connection 服务：形状由宿主决定，本文件只用下面判过的那两个成员
    const connection: any = Reflect.get(connectionCtx, 'connection');
    if (!connection?.fetch?.register || typeof connectionCtx.effect !== 'function') return;
    connectionCtx.effect(() => connection.fetch.register({
      path: LIBRARY_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const [{ resolveWorkspace }, { readLibrary }] = await Promise.all([
            import('../lib/workspace.ts'),
            import('../lib/library.ts'),
          ]);
          const workspace = resolveWorkspace();
          if (!workspace) {
            return Response.json({ error: '没找到学习工作区：~/.dsh/studymate-config.yaml 里没有 workspace。先跑一次 npx @yunmiao/studymate install。' }, { status: 500 });
          }
          return Response.json(readLibrary({ workspace }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: message }, { status: 500 });
        }
      },
    }), 'studymate: 阅读端数据路由');

    // 课件配图：内容文件里的路径相对 lessons/ 写，浏览器读不到工作区，由这里按科目取。
    connectionCtx.effect(() => connection.fetch.register({
      path: ASSET_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        const subject = url.searchParams.get('subject') || '';
        const rel = url.searchParams.get('path') || '';
        try {
          const [{ resolveWorkspace }, { assetFile, contentTypeOf }] = await Promise.all([
            import('../lib/workspace.ts'),
            import('../lib/assets.ts'),
          ]);
          const workspace = resolveWorkspace();
          const file = workspace ? assetFile({ workspace, subject, rel }) : null;
          if (!file) return new Response('not found', { status: 404 });
          const { readFile } = await import('node:fs/promises');
          return new Response(await readFile(file), {
            headers: { 'content-type': contentTypeOf(file), 'cache-control': 'no-store' },
          });
        } catch (error) {
          return new Response(String(error instanceof Error ? error.message : error), { status: 500 });
        }
      },
    }), 'studymate: 课件配图路由');

    // 参考资料：GET 读一份文本（二进制给 404），POST 落一份**学生自己加的**（ADR-0010 的
    // 第二条、也是最后一条前端写学习内容的路径）。
    // 两个动作用**一次注册**：connection 的精确路由以 path 为键，同一个 path 注册第二次会
    // 抛「already registered」，所以只能把方法一起声明、在处理器里看 request.method。
    connectionCtx.effect(() => connection.fetch.register({
      path: REFERENCE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const { resolveWorkspace } = await import('../lib/workspace.ts');
          const workspace = resolveWorkspace();
          if (!workspace) {
            return Response.json({ error: '没找到学习工作区：~/.dsh/studymate-config.yaml 里没有 workspace。先跑一次 npx @yunmiao/studymate install。' }, { status: 500 });
          }
          const { readReference, writeReference } = await import('../lib/reference.ts');

          if (request.method === 'GET') {
            const url = new URL(request.url);
            const found = readReference({
              workspace,
              subject: url.searchParams.get('subject') || '',
              relPath: url.searchParams.get('path') || '',
            });
            if (!found) {
              return Response.json({ error: 'not-found', message: '读不到这份资料：不存在、越界，或者它不是文本（二进制只能在界面上按文件看）' }, { status: 404 });
            }
            return Response.json(found);
          }

          // POST：写盘的所有判断都在 lib/reference.mjs 里（版本号、幂等、路径越界、来源标记），
          // 这里只负责把请求体解出来 + 把结果映射成 HTTP 状态
          const body = await request.json().catch(() => null);
          if (!body || typeof body !== 'object') {
            return Response.json({ error: 'body-invalid', message: '请求体要是 JSON 对象：{ subject, title, markdown, operationId, expectedVersion }' }, { status: 400 });
          }
          const result = writeReference({
            workspace,
            subject: body.subject,
            title: body.title,
            markdown: body.markdown,
            expectedVersion: body.expectedVersion,
            operationId: body.operationId,
          });
          return Response.json(result, { status: result.ok ? 200 : result.status });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: message }, { status: 500 });
        }
      },
    }), 'studymate: 参考资料路由');

    // 文件监听与变更推送（#74）：监听在学习工作区那一侧（lib/watch，由 lib/tools 的
    // registerStudyMate 起），这里只挂推送路由——它要的 connection 只有这个注入点拿得到。
    // 动态 import 与上面同一姿势（这个文件会被 test_bundle 拷到没有 lib/ 的临时目录里跑）。
    void import('../lib/watch/index.ts').then((watch) => watch.registerWatchChannel(connectionCtx), (error) => console.warn(`StudyMate：变更推送通道没挂上。${error instanceof Error ? error.message : String(error)}`));
  });
}
