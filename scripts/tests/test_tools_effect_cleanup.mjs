/* effect 作用域的生命周期回归（`scripts/tests/fixtures/tools.mjs`）。

   ── 为什么要有这一套 ────────────────────────────────────────────────────
   夹具的 `tempDir` 会替测试删临时 HOME/工作区；`fakeContext.effect` 把真宿主用的
   cleanup 记在**这条测试**名下，删目录前统一拆。不钉住的话，`lib/watch` 的
   `registerWatch` 留下的 `fs.watch` 会在删除目录之后继续收 rename 事件——Windows 上
   事件循环永不为空，`node --test` 的子进程不退出，父 runner 永远等它（npm test 停滞）。

   这里钉五件事：
   1. 作用域按测试封口：前一条测试拆完的作用域，不会被后一条测试的登记误用；
   2. 同一作用域内 LIFO 拆卸，重复执行幂等；
   3. cleanup 抛错不吞：聚合 `AggregateError` 抛出，其余 cleanup 照跑、目录照删；
   4. late effect：作用域拆完后才来登记，必须在调用 `fn` **之前**拒（否则资源先造后漏）；
   5. 真实注册 watch、再删 HOME：子进程不带 `--test-force-exit` 也能自然退出。

   第 5 条用子进程：本进程自己挂住的话，测试根本没机会报红。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOOLS_FIXTURE = pathToFileURL(path.join(ROOT, 'scripts/tests/fixtures/tools.mjs')).href;
const { tempDir, fakeContext } = await import(TOOLS_FIXTURE);

/** 拿一个不跑 node:test 的假 TestContext：after 钩子自己收着，测试里手动按 LIFO 跑。 */
function stubTest() {
  const hooks = [];
  return {
    t: { after: (hook) => { hooks.push(hook); } },
    hooks,
    /** 按 node:test 的收尾顺序（后注册的先跑）执行全部 after 钩子。 */
    async run() {
      for (const hook of [...hooks].reverse()) await hook();
    },
  };
}

test('作用域按测试封口：后一条测试的登记不会落进前一条已经拆掉的作用域', (t) => {
  tempDir(t, 'effect-scope-a-');
  const { ctx } = fakeContext();
  ctx.effect(() => () => { /* 前一条测试的资源，收尾时被拆掉 */ }, 'a');
});

test('没有临时目录的登记不归夹具管，也不会被上一条测试的拆卸波及', () => {
  const { ctx } = fakeContext();
  let ran = 0;
  ctx.effect(() => () => { ran += 1; }, 'b');
  assert.equal(ran, 0, '上一条测试拆完的作用域不该收下这条登记，更不该执行它的 cleanup');
});

test('同一作用域 LIFO 拆卸；重复执行幂等；临时目录照样删掉', async () => {
  const stub = stubTest();
  const dir = tempDir(stub.t, 'effect-lifo-');
  const { ctx } = fakeContext();
  const order = [];
  ctx.effect(() => () => { order.push('first'); }, 'first');
  ctx.effect(() => () => { order.push('second'); }, 'second');

  await stub.run();
  assert.deepEqual(order, ['second', 'first'], 'cleanup 要按登记的逆序跑');

  await stub.run();
  assert.deepEqual(order, ['second', 'first'], '第二次拆卸不许再跑一遍（幂等）');
  assert.equal(fs.existsSync(dir), false, '拆完之后临时目录要删掉');
});

test('一次测试多个临时目录：任一 after 都把这套测试的 effect 全部拆掉', async () => {
  const stub = stubTest();
  const first = tempDir(stub.t, 'effect-multi-a-');
  const order = [];
  fakeContext().ctx.effect(() => () => { order.push('a'); }, 'a');
  const second = tempDir(stub.t, 'effect-multi-b-');
  fakeContext().ctx.effect(() => () => { order.push('b'); }, 'b');

  await stub.run();
  assert.deepEqual(order, ['b', 'a'], '后开的 scope 先拆，且不落下任何一条');
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
});

test('两个独立 TestContext 并存：清 A 只拆 A，B 的目录与 cleanup 都还在；清 B 才拆 B', async () => {
  const a = stubTest();
  const b = stubTest();
  const dirA = tempDir(a.t, 'effect-two-a-');
  const ctxA = fakeContext().ctx;
  const dirB = tempDir(b.t, 'effect-two-b-');
  const ctxB = fakeContext().ctx;

  const ran = [];
  ctxA.effect(() => () => { ran.push('a'); }, 'a');
  ctxB.effect(() => () => { ran.push('b'); }, 'b');

  // 只走 A 的收尾：A 的 cleanup 与目录走掉，B 的一个字节都不许动。
  await a.run();
  assert.deepEqual(ran, ['a'], 'A 的 effect 只能随 A 的作用域拆');
  assert.equal(fs.existsSync(dirA), false, 'A 的临时目录该删了');
  assert.equal(fs.existsSync(dirB), true, 'B 的临时目录不能被 A 的 after 删掉');

  // 再走 B：只补 B，A 的 cleanup 不许重跑。
  await b.run();
  assert.deepEqual(ran, ['a', 'b'], 'B 的 effect 只随 B 拆，且 A 不重跑');
  assert.equal(fs.existsSync(dirB), false, 'B 拆完自己删目录');
});

test('cleanup 抛错要聚合传播：其余 cleanup 照跑、目录照删、该 test 红', async () => {
  const stub = stubTest();
  const dir = tempDir(stub.t, 'effect-boom-');
  const { ctx } = fakeContext();
  const ran = [];
  ctx.effect(() => () => { ran.push('ok'); }, 'ok');
  ctx.effect(() => () => { ran.push('boom-1'); throw new Error('boom-1'); }, 'boom-1');
  ctx.effect(() => () => { ran.push('boom-2'); throw new Error('boom-2'); }, 'boom-2');

  const caught = await stub.run().then(() => null, (error) => error);
  assert.ok(caught instanceof AggregateError, `拆卸失败要聚合抛出，实际：${caught}`);
  assert.equal(caught.errors.length, 2, '两个失败都要在 errors 里');
  assert.match(caught.message, /2 个 effect 拆卸失败/);
  assert.deepEqual(ran, ['boom-2', 'boom-1', 'ok'], 'LIFO，且一个失败不影响后面继续拆');
  assert.equal(fs.existsSync(dir), false, '拆卸抛错也要把临时目录删掉');
});

test('作用域拆完后才来登记：先拒、不调用 fn，不许先造资源再漏掉', async () => {
  const stub = stubTest();
  tempDir(stub.t, 'effect-late-');
  const { ctx } = fakeContext();
  await stub.run();

  let created = 0;
  assert.throws(
    () => ctx.effect(() => { created += 1; return () => { /* 这份 cleanup 永远不会被登记 */ }; }, 'late'),
    /已过拆卸时机/,
  );
  assert.equal(created, 0, '拒之前就调用 fn 的话，资源已经造出来而没人拆');
});

test('真实注册 watch 后删掉 HOME：子进程限时自然退出（不带 --test-force-exit）', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'effect-exit-'));
  const child = path.join(dir, 'child.mjs');
  const toolsModule = pathToFileURL(path.join(ROOT, 'lib/tools/index.ts')).href;
  fs.writeFileSync(child, [
    `import { useHome, fakeContext } from ${JSON.stringify(TOOLS_FIXTURE)};`,
    `import * as tools from ${JSON.stringify(toolsModule)};`,
    '',
    'const hooks = [];',
    'const t = { after: (hook) => { hooks.push(hook); } };',
    'useHome(t);',
    'tools.registerStudyMate(fakeContext().ctx);',
    '',
    '// 等 fs.watch 真的挂上（libuv 里出现事件句柄）再收尾——不然这条用例什么也没验证到。',
    'const deadline = Date.now() + 3000;',
    'let started = false;',
    'while (Date.now() < deadline) {',
    '  const handles = (process.report.getReport().libuv || [])',
    "    .filter((handle) => handle && (handle.type === 'fs_event' || handle.type === 'inotify'));",
    '  if (handles.length > 0) { started = true; break; }',
    '  await new Promise((resolve) => setTimeout(resolve, 50));',
    '}',
    "if (!started) { console.error('watch-not-started'); process.exit(2); }",
    '',
    'for (const hook of [...hooks].reverse()) await hook();',
    "console.log('watch-started teardown-done');",
    '',
  ].join('\n'));

  const result = spawnSync(process.execPath, [child], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(result.error?.code, undefined,
    `子进程没在 20s 内自己退出（${result.error ? result.error.message : '超时'}）：`
    + `stdout=${result.stdout} stderr=${result.stderr}`);
  assert.equal(result.status, 0, `退出码 ${result.status}：stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.stdout, /watch-started teardown-done/);
});
