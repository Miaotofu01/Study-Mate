/**
 * StudyMate Antigravity Sidecar Backend.
 *
 * Bridges StudyMate's real Host library (`readLibrary`, `writeAttempts`, `writeAnnotations`,
 * `readReference`, `writeReference`, `assetFile`, `mathAssets`, `notes/store.ts`,
 * `tasks`, `status`, `lab/route`) with Antigravity's native Sidecar Web UI
 * (`sidecar://studymate/reader/`).
 *
 * `bin/antigravity-plugin.mjs` copies the engine next to this file:
 *   engine/bin/typescript-runtime.mjs       —— `.ts` 加载钩子（必须先于任何 engine import 生效）
 *   engine/lib/**                           —— 仓库 lib/ 闭包（数据层唯一真相）
 *   client/client.js, client/client.notes.js —— dist/ 的客户端构建产物
 *   vendor/*.production.js                  —— 构建期生成的 React 运行时（运行时仍可兜底）
 */
import './engine/bin/typescript-runtime.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ── 引擎：静态字符串字面量的动态 import，模块加载期一次到位 ─────────────
   `createReaderApp()` 因此保持同步签名（构造 SidecarApp 需要宿主环境变量，只能在调用时做，
   所以这里只加载引擎、不构造 app）。 */
const library = await import('./engine/lib/library.ts');
const attempts = await import('./engine/lib/attempts.ts');
const annotations = await import('./engine/lib/annotations.ts');
const reference = await import('./engine/lib/reference.ts');
const assets = await import('./engine/lib/assets.ts');
const math = await import('./engine/lib/math.ts');
const workspace = await import('./engine/lib/workspace.ts');
const envelope = await import('./engine/lib/route-envelope.ts');
const labRoute = await import('./engine/lib/lab/route.ts');
const tasksIndex = await import('./engine/lib/tasks/index.ts');
const tasksRoute = await import('./engine/lib/tasks/route.ts');
const status = await import('./engine/lib/status.ts');
const notesStore = await import('./engine/lib/notes/store.ts');
const reactModule = await import('./engine/lib/export/react.ts');
const pageModule = await import('./engine/lib/export/page.ts');

/* ── 工作区解析 ─────────────────────────────────────────────────────────── */

function hasLearningSubjects(dir) {
  if (!dir) return false;
  try {
    return fs.statSync(path.join(dir, '.learning', 'subjects')).isDirectory();
  } catch {
    return false;
  }
}

/** `file://` URI / `%3A` 编码盘符 / 裸绝对路径 → 本地绝对路径；非法值 warn 后忽略。 */
function normalizeCandidate(uri) {
  if (typeof uri !== 'string' || uri.trim() === '') return null;
  let text = uri.trim();
  if (text.startsWith('file://')) {
    try {
      text = fileURLToPath(text);
    } catch {
      try {
        const decoded = decodeURIComponent(text.replace(/^file:\/\//, ''));
        text = /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
      } catch {
        console.warn(`[studymate-sidecar] 无法解析的工作区 URI：${uri}`);
        return null;
      }
    }
  }
  if (!path.isAbsolute(text)) {
    console.warn(`[studymate-sidecar] 忽略非绝对路径的工作区候选：${uri}`);
    return null;
  }
  return path.normalize(text);
}

/** 宿主给的 `ws` 参数：JSON 数组（推荐）或单个 URI/路径。 */
export function parseWsParam(wsRaw) {
  if (!wsRaw || typeof wsRaw !== 'string') return [];
  const out = [];
  const push = (value) => {
    const normalized = normalizeCandidate(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  };
  const text = wsRaw.trim();
  if (text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      console.warn(`[studymate-sidecar] ws 参数不是合法 JSON 数组：${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    if (!Array.isArray(parsed)) {
      console.warn('[studymate-sidecar] ws 参数是 JSON 但不是数组，已忽略');
      return [];
    }
    for (const item of parsed) push(item);
    return out;
  }
  push(text);
  return out;
}

/** ws 参数 → 环境变量 → 配置工作区 → `~/StudyMate`；返回实际目录与是否存在。 */
export function findWorkspace(wsRaw, resolved = '') {
  for (const dir of parseWsParam(wsRaw)) {
    if (hasLearningSubjects(dir)) return { workspace: dir, exists: true };
  }
  for (const candidate of [process.env.STUDYMATE_WORKSPACE, process.env.LEARN_WORKSPACE]) {
    const normalized = normalizeCandidate(candidate);
    if (normalized && hasLearningSubjects(normalized)) return { workspace: normalized, exists: true };
  }
  const configured = normalizeCandidate(resolved);
  if (configured && hasLearningSubjects(configured)) return { workspace: configured, exists: true };
  const homeWs = path.join(os.homedir(), 'StudyMate');
  if (hasLearningSubjects(homeWs)) return { workspace: homeWs, exists: true };
  for (const dir of parseWsParam(wsRaw)) return { workspace: dir, exists: false };
  for (const candidate of [process.env.STUDYMATE_WORKSPACE, process.env.LEARN_WORKSPACE]) {
    const normalized = normalizeCandidate(candidate);
    if (normalized) return { workspace: normalized, exists: false };
  }
  if (configured) return { workspace: configured, exists: false };
  return { workspace: homeWs, exists: false };
}

/** 笔记数据域：`STUDYMATE_NOTES_HOME`（须是绝对路径）优先，否则 `<ws>/.learning`。 */
export function resolveNotesHome(ws, isValid) {
  const env = process.env.STUDYMATE_NOTES_HOME;
  if (isValid(env)) return env;
  return path.join(ws, '.learning');
}

/* ── 变更令牌：递归 + 确定性 SHA-1（数量、路径、大小、mtime 全在摘要里） ── */

const VERSION_SCAN_LIMIT = 20000;

export function learningVersionToken(ws) {
  const root = path.join(ws, '.learning');
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch {
    return 'empty';
  }
  if (!rootStat.isDirectory()) return 'empty';
  const entries = [];
  let truncated = false;
  const stack = [{ dir: root, rel: '' }];
  while (stack.length > 0) {
    const { dir, rel } = stack.pop();
    let listing;
    try {
      listing = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of listing) {
      if (entry.name === '.stage' || entry.name === 'node_modules') continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        entries.push([childRel, true, 0, 0]);
        stack.push({ dir: full, rel: childRel });
      } else if (entry.isFile()) {
        let size = 0;
        let mtime = 0;
        try {
          const stat = fs.statSync(full);
          size = stat.size;
          mtime = Math.round(stat.mtimeMs);
        } catch {
          // 扫描途中被删掉的文件不参与摘要（否则每次并发写都会让令牌抖动）
          continue;
        }
        entries.push([childRel, false, size, mtime]);
      }
      if (entries.length >= VERSION_SCAN_LIMIT) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const digest = crypto.createHash('sha1');
  for (const [rel, isDir, size, mtime] of entries) {
    digest.update(`${rel}\0${isDir ? 'd' : 'f'}\0${size}\0${mtime}\n`);
  }
  if (truncated) console.warn(`[studymate-sidecar] .learning 条目超过 ${VERSION_SCAN_LIMIT}，版本令牌已截断`);
  return `${entries.length}:${digest.digest('hex')}${truncated ? ':truncated' : ''}`;
}

/* ── 静态文件（内存缓存 + 运行时 React 兜底） ───────────────────────────── */

const pageCache = new Map();

function readCached(file) {
  if (pageCache.has(file)) return pageCache.get(file);
  const buf = fs.readFileSync(file);
  pageCache.set(file, buf);
  return buf;
}

function scriptResponse(buf) {
  return new Response(buf, { status: 200, contentType: 'application/javascript; charset=utf-8' });
}

const VENDOR_SCRIPTS = [
  ['scheduler.production.js', 'scheduler'],
  ['react.production.js', 'react'],
  ['react-dom.production.js', 'react-dom'],
  ['react-dom-client.production.js', 'react-dom/client'],
  ['react-jsx-runtime.production.js', 'react/jsx-runtime'],
];

function reactMissingResponse(error) {
  return new Response(JSON.stringify({
    ok: false,
    error: { code: 'react-missing', message: String((error && error.message) || error) },
  }), { status: 404, contentType: 'application/json; charset=utf-8' });
}

function vendorSourceFile(sources, moduleName) {
  if (moduleName === 'react/jsx-runtime') {
    return sources.react ? path.join(path.dirname(sources.react), 'react-jsx-runtime.production.js') : '';
  }
  if (moduleName === 'react') return sources.react;
  if (moduleName === 'react-dom') return sources.reactDomCore;
  if (moduleName === 'react-dom/client') return sources.reactDom;
  if (moduleName === 'scheduler') return sources.scheduler;
  return '';
}

function vendorBody(file, moduleName) {
  const local = path.join(__dirname, 'vendor', file);
  if (fs.existsSync(local)) return readCached(local);
  let sources;
  try {
    sources = reactModule.resolveReact({ probeGlobal: false });
  } catch {
    sources = reactModule.resolveReact();
  }
  const source = vendorSourceFile(sources, moduleName);
  if (!source || !fs.existsSync(source)) {
    throw Object.assign(
      new Error(`没找到 ${moduleName} 的 production 构建（React vendor 未随产物生成）`),
      { code: 'react-missing' },
    );
  }
  return Buffer.from(pageModule.vendorFile(moduleName, fs.readFileSync(source, 'utf8')), 'utf8');
}

/* ── API 辅助 ───────────────────────────────────────────────────────────── */

function jsonResponse(body, statusCode = 200) {
  return new Response(JSON.stringify(body), { status: statusCode, contentType: 'application/json; charset=utf-8' });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function failure(error) {
  return jsonResponse(envelope.errorBody('internal', describe(error)), 500);
}

/* ── 应用 ───────────────────────────────────────────────────────────────── */

/**
 * 完成全部路由注册并返回 `SidecarApp`。宿主环境变量（`ANTIGRAVITY_*`）只在 `run()` 里才需要，
 * 所以这个函数可以脱离真实 sidecar 进程被测试直接调用（`STUDYMATE_SIDECAR_NO_AUTORUN=1`）。
 */
export function createReaderApp() {
  let configuredWorkspace = '';
  try {
    configuredWorkspace = workspace.resolveWorkspace();
  } catch {
    configuredWorkspace = '';
  }
  const resolve = (wsRaw) => findWorkspace(wsRaw, configuredWorkspace);
  const app = new SidecarApp();

  /* ── 静态页面 ── */
  for (const [route, file] of [['/', 'index.html'], ['/host.js', 'host.js'], ['/boot.js', 'boot.js']]) {
    app.page(route, () => readCached(path.join(__dirname, file)));
  }

  app.page('/studymate-client.js', () => {
    const built = path.join(__dirname, 'client', 'client.js');
    if (fs.existsSync(built)) return scriptResponse(readCached(built));
    const fallback = path.join(__dirname, 'engine', 'lib', 'client.js');
    if (fs.existsSync(fallback)) return scriptResponse(readCached(fallback));
    return new Response('not found', { status: 404, contentType: 'text/plain' });
  });

  app.page('/client.notes.js', () => {
    const built = path.join(__dirname, 'client', 'client.notes.js');
    if (fs.existsSync(built)) return scriptResponse(readCached(built));
    return new Response('not found', { status: 404, contentType: 'text/plain' });
  });

  for (const [file, moduleName] of VENDOR_SCRIPTS) {
    app.page(`/vendor/${file}`, () => {
      try {
        return new Response(vendorBody(file, moduleName), {
          status: 200,
          contentType: 'application/javascript; charset=utf-8',
        });
      } catch (error) {
        if (error instanceof reactModule.ReactMissingError
          || (error && (error.code === 'EXPORT_REACT_MISSING' || error.code === 'react-missing'))) {
          return reactMissingResponse(error);
        }
        throw error;
      }
    });
  }

  /* ── 数据 API（失败恒为 route-envelope 的 { ok:false, error:{code,message} } 信封） ── */

  app.api('/api/studymate/library', (data) => {
    try {
      const { workspace: ws, exists } = resolve(data?.ws);
      if (!exists) {
        return {
          version: 1,
          workspace: ws,
          memory_md: '',
          subjects: [],
          notice: `未在 ${ws} 发现学习科目，请先在 Antigravity 对话中说「我想学 [科目名]」建课。`,
        };
      }
      return library.readLibrary({ workspace: ws, isolateBrokenSubjects: true });
    } catch (error) {
      return failure(error);
    }
  }, 'GET');

  app.api('/api/studymate/attempts', (data) => {
    try {
      if (!isPlainObject(data)) {
        return jsonResponse(envelope.errorBody('body-invalid', '请求体要是 JSON 对象：{ subject, node, questions, operationId, expectedVersion }'), 400);
      }
      const { workspace: ws } = resolve(data.ws);
      const result = attempts.writeAttempts({
        workspace: ws,
        subject: data.subject,
        node: data.node,
        questions: data.questions,
        expectedVersion: data.expectedVersion,
        operationId: data.operationId,
      });
      return jsonResponse(result, result.ok ? 200 : (result.status || 400));
    } catch (error) {
      return failure(error);
    }
  }, 'POST');

  app.api('/api/studymate/annotations', (data) => {
    try {
      if (!isPlainObject(data)) {
        return jsonResponse(envelope.errorBody('body-invalid', '请求体要是 JSON 对象：{ subject, node, annotations, operationId, expectedVersion }'), 400);
      }
      const { workspace: ws } = resolve(data.ws);
      const result = annotations.writeAnnotations({
        workspace: ws,
        subject: data.subject,
        node: data.node,
        annotations: data.annotations,
        expectedVersion: data.expectedVersion,
        operationId: data.operationId,
      });
      return jsonResponse(result, result.ok ? 200 : (result.status || 400));
    } catch (error) {
      return failure(error);
    }
  }, 'POST');

  app.api('/api/studymate/reference', (data) => {
    try {
      const { workspace: ws } = resolve(data?.ws);
      const result = reference.readReference({ workspace: ws, subject: data?.subject, relPath: data?.path });
      if (!result) {
        return jsonResponse(envelope.errorBody('not-found', '读不到这份资料：不存在、越界，或者它不是文本（二进制只能在界面上按文件看）'), 404);
      }
      return result;
    } catch (error) {
      return failure(error);
    }
  }, 'GET');

  app.api('/api/studymate/reference', (data) => {
    try {
      if (!isPlainObject(data)) {
        return jsonResponse(envelope.errorBody('body-invalid', '请求体要是 JSON 对象：{ subject, title, markdown, operationId, expectedVersion }'), 400);
      }
      if (typeof data.title !== 'string' || typeof data.markdown !== 'string') {
        return jsonResponse(envelope.errorBody('body-invalid', 'title 与 markdown 都必须是字符串'), 400);
      }
      const { workspace: ws } = resolve(data.ws);
      const result = reference.writeReference({
        workspace: ws,
        subject: data.subject,
        title: data.title,
        markdown: data.markdown,
        expectedVersion: data.expectedVersion,
        operationId: data.operationId,
      });
      return jsonResponse(result, result.ok ? 200 : (result.status || 400));
    } catch (error) {
      return failure(error);
    }
  }, 'POST');

  app.api('/api/studymate/asset', (data) => {
    try {
      const { workspace: ws } = resolve(data?.ws);
      const file = assets.assetFile({ workspace: ws, subject: data?.subject, rel: data?.path });
      if (!file) return jsonResponse(envelope.errorBody('path-invalid', '读不到这张图：不存在，或者越界'), 404);
      let buf;
      try {
        buf = fs.readFileSync(file);
      } catch (error) {
        if (error && error.code === 'ENOENT') return jsonResponse(envelope.errorBody('path-invalid', '读不到这张图：不存在，或者越界'), 404);
        throw error;
      }
      return new Response(buf, {
        status: 200,
        contentType: assets.contentTypeOf(file),
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      return failure(error);
    }
  }, 'GET');

  app.api('/api/studymate/lab-run', async (data) => {
    try {
      if (!isPlainObject(data)) return jsonResponse(envelope.errorBody('body-invalid', '请求体要是 JSON 对象'), 400);
      // 路由只认题目里的那几个字段；ws 是我们自己加的工作区线索，转发前必须摘掉。
      const { ws: _ws, ...body } = data;
      const { workspace: ws } = resolve(_ws);
      const restore = workspace.setWorkspaceOverride(() => ws);
      try {
        const response = await labRoute.runRouteRequest(body);
        const text = await response.text();
        return new Response(text, {
          status: response.status,
          contentType: response.headers.get('content-type') || 'application/json; charset=utf-8',
        });
      } finally {
        restore();
      }
    } catch (error) {
      return failure(error);
    }
  }, 'POST');

  app.api('/api/studymate/tasks', () => {
    try {
      return tasksRoute.taskBoard(tasksIndex.taskService());
    } catch (error) {
      return failure(error);
    }
  }, 'GET');

  app.api('/api/studymate/status', (data) => {
    try {
      const { workspace: ws } = resolve(data?.ws);
      const restore = workspace.setWorkspaceOverride(() => ws);
      try {
        return status.buildStatus({ watch: { watching: true, backend: 'sidecar-poll' } });
      } catch {
        return status.failedStatus('internal');
      } finally {
        restore();
      }
    } catch (error) {
      return failure(error);
    }
  }, 'GET');

  app.api('/api/studymate/notes', (data) => {
    try {
      const { workspace: ws } = resolve(data?.ws);
      const home = resolveNotesHome(ws, notesStore.isValidNotesHome);
      const result = notesStore.readNotesStore({ home });
      if (!result.ok) {
        return jsonResponse(envelope.errorBody(result.code, result.message, result.extra ?? {}), result.status || 500);
      }
      return {
        ok: true,
        schemaVersion: result.value.schemaVersion,
        requiresUpgrade: result.value.requiresUpgrade,
        storeId: result.value.storeId,
        resources: result.value.resources,
        resourceVersions: result.value.resourceVersions,
        layout: result.value.layout,
        layoutVersion: result.value.layoutVersion,
      };
    } catch (error) {
      return failure(error);
    }
  }, 'GET');

  app.api('/api/studymate/notes', (data) => {
    try {
      if (!isPlainObject(data)) {
        return jsonResponse(envelope.errorBody('body-invalid', '请求体要是 JSON 对象。'), 400);
      }
      const { workspace: ws } = resolve(data.ws);
      const home = resolveNotesHome(ws, notesStore.isValidNotesHome);
      if (data.operation === 'resource') {
        const result = notesStore.writeNotesResource({
          home,
          resource: data.resource,
          expectedVersion: data.expectedVersion ?? null,
        });
        if (!result.ok) return jsonResponse(envelope.errorBody(result.code, result.message, result.extra ?? {}), result.status || 400);
        return { ok: true, resource: result.value.resource, version: result.value.version };
      }
      if (data.operation === 'layout') {
        const result = notesStore.writeNotesLayout({
          home,
          layout: data.layout,
          expectedVersion: data.expectedVersion ?? null,
        });
        if (!result.ok) return jsonResponse(envelope.errorBody(result.code, result.message, result.extra ?? {}), result.status || 400);
        return { ok: true, layout: result.value.layout, version: result.value.version };
      }
      if (data.operation === 'upgrade') {
        const result = notesStore.upgradeNotesStore({ home });
        if (!result.ok) return jsonResponse(envelope.errorBody(result.code, result.message, result.extra ?? {}), result.status || 400);
        return {
          ok: true,
          schemaVersion: result.value.schemaVersion,
          requiresUpgrade: result.value.requiresUpgrade,
          backup: result.value.backup,
          backupId: result.value.backupId,
        };
      }
      return jsonResponse(envelope.errorBody('body-invalid', 'operation 只支持 resource / layout / upgrade。'), 400);
    } catch (error) {
      return failure(error);
    }
  }, 'POST');

  app.api('/api/studymate/qa/session', (data) => {
    const subject = typeof data?.subject === 'string' ? data.subject : '';
    const node = typeof data?.node === 'string' ? data.node : '';
    const nodeId = typeof data?.nodeId === 'string' ? data.nodeId : '';
    const lesson = typeof data?.lesson === 'string' ? data.lesson : '';
    return {
      ok: true,
      available: true,
      sessionId: `ag-qa-${encodeURIComponent(subject || 'lesson')}-${encodeURIComponent(nodeId || node || 'node')}`,
      title: `答疑 · ${subject || '课程'} · ${node || nodeId || '本课'}`,
      subject,
      node,
      nodeId,
      lesson,
    };
  }, 'POST');

  app.api('/api/studymate/poll-version', (data) => {
    try {
      const { workspace: ws, exists } = resolve(data?.ws);
      return { version: learningVersionToken(ws), workspace: ws, exists };
    } catch (error) {
      return failure(error);
    }
  }, 'GET');

  /* ── KaTeX 离线资源：逐文件精确注册（缺失即 404，不挂 katex vendor 脚本） ── */
  for (const asset of math.mathAssets()) {
    app.api(math.mathAssetPath(asset.rel), () => {
      try {
        const file = math.mathAssetFile(asset.rel);
        if (!file) return jsonResponse(envelope.errorBody('path-invalid', '公式资源不存在'), 404);
        let buf;
        try {
          buf = fs.readFileSync(file);
        } catch (error) {
          if (error && error.code === 'ENOENT') return jsonResponse(envelope.errorBody('path-invalid', '公式资源不存在'), 404);
          throw error;
        }
        return new Response(buf, {
          status: 200,
          contentType: asset.contentType,
          headers: { 'Cache-Control': 'no-store' },
        });
      } catch (error) {
        return failure(error);
      }
    }, 'GET');
  }

  return app;
}

/* 只有作为主脚本直接运行、且宿主没要求禁跑时才起服务。 */
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly && process.env.STUDYMATE_SIDECAR_NO_AUTORUN !== '1') {
  try {
    createReaderApp().run().catch((error) => {
      console.error('[studymate-sidecar] 启动失败：', error);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error('[studymate-sidecar] 启动失败：', error);
    process.exitCode = 1;
  }
}
