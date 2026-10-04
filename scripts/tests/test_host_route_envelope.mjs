/* 阅读端 HTTP 路由的**错误信封**（`lib/route-envelope.ts`）——形状、词表、两端一致。
   ────────────────────────────────────────────────────────────────────────
   这条套件守的是「Host 半与阅读端之间那份没人写下来的契约」。收编前它是两套：
   `ask` 回 `{available, ok, error:{code, message}}`，`attempts` / `lab` / `reference` /
   `library` 回 `{error:'<字符串码>', message}`（`library` 那条更离谱：`error` 里放的是一整句
   给人看的话）。客户端要按两种形状解析同一种东西，而**任何文档都没写过这个形状**。

   三件事分开验：
     1. **形状**：每条路由真跑一次失败路径，回执必须是 `{ ok:false, error:{ code, message } }`，
        `code` 是词表里的短码、`message` 是非空的整句话（学生照着它能自救）；
     2. **词表**：`ROUTE_ERROR_CODES` 是唯一一份码表，扫 `lib/**`、`bin/**` 的调用点，
        用了表外的码就红——码是客户端分支的依据，多一个没人知道的码等于静默不分支；
     3. **两端一致**：`lib/client.js` 的 `routeCode` / `routeMessage` 必须真从
        `error.code` / `error.message` 取值（它是手写 JS，不进 tsc，只能这样钉）。

   数据现造现弃（ADR-0009）。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { ROUTE_ERROR_CODES, errorBody, routeError } from '../../lib/route-envelope.ts';
import { handleAttempts } from '../../lib/attempts-route.ts';
import { runRouteRequest } from '../../lib/lab/route.ts';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CODES = new Set(ROUTE_ERROR_CODES);

/* 这一条套件只验**形状**，所以把 DSH_HOME 指到一个空目录：没有工作区，作答路由的前两道
   关（方法 → 工作区）就够走到「失败也是同一个信封」了，不必现造一份工作区。 */
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-envelope-'));
test.after(() => fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true }));

/* ── 1. 形状 ──────────────────────────────────────────────────────────── */

test('信封就是 `{ ok:false, error:{ code, message } }`，extra 覆盖不掉 ok / error', () => {
  const body = errorBody('body-invalid', '请求体不对', { attempts: null, version: 'v1' });
  assert.deepEqual(body, {
    attempts: null, version: 'v1', ok: false, error: { code: 'body-invalid', message: '请求体不对' },
  });
  // 反证：extra 里塞同名键也覆盖不掉——否则「信封形状」就由调用点说了算
  assert.equal(errorBody('internal', '炸了', { ok: true }).ok, false);
  assert.deepEqual(errorBody('internal', '炸了', { error: '旧形状' }).error, { code: 'internal', message: '炸了' });
});

test('routeError 把同一个信封包成 HTTP 响应，状态码原样带出去', async () => {
  const response = routeError(409, 'version-conflict', '别处刚改过');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'version-conflict', message: '别处刚改过' } });
});

test('作答路由：每一条失败路径都回同一个信封（含 405 / 500 / 400）', async () => {
  const request = (init) => new Request('http://127.0.0.1/api/studymate/attempts', init);
  const cases = [
    [405, request({ method: 'GET' })],
    [500, request({ method: 'POST', body: '{}' })],   // 没有工作区（DSH_HOME 指向空目录）
  ];
  for (const [status, init] of cases) {
    const response = await handleAttempts(init);
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.ok, false, `HTTP ${status} 的信封少了 ok:false`);
    assert.equal(typeof body.error, 'object');
    assert.ok(CODES.has(body.error.code), `HTTP ${status} 的码「${body.error.code}」不在词表里`);
    assert.ok(body.error.message.length > 0, `HTTP ${status} 的 message 是空的：学生看不到能自救的话`);
    // 旧形状的两个特征：error 是字符串、message 在顶层
    assert.equal(typeof body.error, 'object');
    assert.equal(body.message, undefined, 'message 只许在 error 里（顶层那份是旧形状）');
  }
});

test('实验代跑路由：坏请求回同一个信封', async () => {
  const response = await runRouteRequest({ subject: 'demo' });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['error', 'ok']);
  assert.equal(body.ok, false);
  assert.ok(CODES.has(body.error.code));
  assert.ok(body.error.message.length > 0);
});

/* ── 2. 词表：调用点用了表外的码就红 ───────────────────────────────────── */

/** 扫一份源码里所有「造信封」的调用点，取出**字面量**码。
 *  拼出来的码（`errorView(error.field + '-invalid')`）不在扫描范围里——它们落在
 *  `<字段>-invalid` 这一族，硬要静态求值是自找误报。 */
function literalCodesIn(source) {
  const found = [];
  const patterns = [
    /routeError\(\s*\d+\s*,\s*'([a-z][a-z0-9-]*)'/g,
    /errorBody\(\s*'([a-z][a-z0-9-]*)'/g,
    /badRequest\(\s*'([a-z][a-z0-9-]*)'/g,
    /refusal\(\s*\d+\s*,\s*'([a-z][a-z0-9-]*)'/g,
    /errorView\(\s*'([a-z][a-z0-9-]*)'/g,
    /error:\s*\{\s*code:\s*'([a-z][a-z0-9-]*)'/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

function sourceFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(?:ts|mjs|js)$/.test(entry.name)) found.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  };
  for (const dir of root) walk(path.join(ROOT, dir));
  return found;
}

test('词表是唯一一份：源码里用到的码一个都不许在表外', () => {
  const files = sourceFiles(['lib', 'bin']);
  const used = new Map();
  for (const file of files) {
    for (const code of literalCodesIn(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      if (!used.has(code)) used.set(code, []);
      used.get(code).push(file);
    }
  }
  assert.ok(used.size >= 10, `只扫到 ${used.size} 个码，扫描器可能已经失效`);
  const unknown = [...used].filter(([code]) => !CODES.has(code)).map(([code, where]) => `${code}（${where[0]}）`);
  assert.deepEqual(unknown, [], `这些码不在 ROUTE_ERROR_CODES 里——加进词表，或者改用已有的码：\n${unknown.join('\n')}`);
  // 反证：判据不空转——表外的码必须被抓出来
  assert.deepEqual(literalCodesIn("routeError(400, '凭空发明的码', '…')"), ['凭空发明的码'].filter((code) => CODES.has(code)));
});

test('词表自身：排序、去重、形态都对（它是给人读的契约）', () => {
  assert.deepEqual([...ROUTE_ERROR_CODES], [...new Set(ROUTE_ERROR_CODES)], '词表里有重复');
  assert.deepEqual([...ROUTE_ERROR_CODES].sort(), [...ROUTE_ERROR_CODES], '词表要按字典序，方便对照');
  for (const code of ROUTE_ERROR_CODES) assert.match(code, /^[a-z][a-z0-9-]*$/, `码「${code}」不像机读码`);
});

/* ── 3. 两端一致：客户端读的就是这两个字段 ────────────────────────────── */

test('客户端只从 error.code / error.message 取值（它是手写 JS，不进 tsc）', () => {
  const client = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');
  assert.match(client, /const routeCode = \(body\) =>/, '客户端少了 routeCode');
  assert.match(client, /error\.code/, 'routeCode 要从 error.code 取码');
  assert.match(client, /error\.message/, 'routeMessage 要从 error.message 取那句话');
  // 旧形状的读法不许回来：`body.error === '…'`（把码当字符串比）与顶层 `body.message`
  // 旧形状的特征读法：拿**码**去比 `body.error`（现在是对象，比不中）
  const asString = new RegExp(`body\\.error === '(?:${ROUTE_ERROR_CODES.join('|')})'`);
  assert.doesNotMatch(client, asString, '又按字符串比 error 了：那是旧信封');
  assert.doesNotMatch(client, /payload\.message \|\| payload\.error/, '又读顶层 message 了：那是旧信封');
});
