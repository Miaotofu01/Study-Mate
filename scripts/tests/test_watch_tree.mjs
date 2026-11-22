// 监听域的目录集合（#74 `lib/watch/tree.ts`）：去抖、新建目录自动补挂、容错、拆卸。
//
// 用 Node `fs.watch` 后端（`nodeObserver`）——真宿主里优先走 `ctx.fs.watch`，
// 那条路在 test_dsh_runtime.mjs 的真 DSH 探针里验。这里是同一个目录集合逻辑的另一半。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const tree = await import(pathToFileURL(path.join(ROOT, 'lib/watch/tree.ts')).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(25);
  }
}

/** 现造一个最小工作区（跑完即弃，ADR-0009）。 */
function makeWorkspace(t) {
  const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-watch-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const lessons = path.join(workspace, '.learning', 'subjects', 'demo', 'lessons');
  fs.mkdirSync(lessons, { recursive: true });
  fs.writeFileSync(path.join(lessons, '0001-var.md'), '# 变量\n');
  return { workspace, subjects: path.join(workspace, '.learning', 'subjects'), lessons };
}

async function start(workspace, overrides = {}) {
  const batches = [];
  const problems = [];
  const watch = await tree.startTreeWatch({
    workspace,
    observe: tree.nodeObserver(),
    backend: 'node-fs',
    onChanged: (directories) => batches.push(directories),
    onProblem: (message) => problems.push(message),
    ...overrides,
  });
  return { watch, batches, problems };
}

test('改一个课件文件：去抖成一条通知，目录集合覆盖到 lessons/', async (t) => {
  const { workspace, lessons } = makeWorkspace(t);
  const { watch, batches, problems } = await start(workspace);
  t.after(() => watch.close());

  assert.ok(watch.directories().includes(lessons),
    `目录集合要扫到四层深：${JSON.stringify(watch.directories())}`);
  assert.deepEqual(problems, []);

  fs.writeFileSync(path.join(lessons, '0001-var.md'), '# 变量（改过）\n');
  await waitFor(() => batches.length >= 1, '课件改动触发回调');
  await sleep(400); // 再等一个去抖窗口，确认没有第二条
  assert.equal(batches.length, 1, '一次保存只该推一条通知（去抖合并）');
  assert.ok(batches[0].includes(lessons) || batches[0].some((dir) => dir.startsWith(lessons)),
    `回调要指出变的是哪个目录：${JSON.stringify(batches[0])}`);
});

test('外层新建一个科目：目录集合自己补上新目录，之后它里面的改动也看得见', async (t) => {
  const { workspace, subjects } = makeWorkspace(t);
  const { watch, batches } = await start(workspace);
  t.after(() => watch.close());

  const fresh = path.join(subjects, '新科目', 'lessons');
  fs.mkdirSync(fresh, { recursive: true });
  await waitFor(() => watch.directories().includes(fresh), '新科目的 lessons/ 被补进目录集合');
  await waitFor(() => batches.some((dirs) => dirs.includes(subjects)), '父目录报了「有了新科目」');

  const before = batches.length;
  fs.writeFileSync(path.join(fresh, '0001-first.md'), '# 第一课\n');
  await waitFor(() => batches.length > before, '新目录里的改动也收得到');
});

test('容错：某个目录观察不起来只记一句，其余目录照常工作', async (t) => {
  const { workspace, lessons } = makeWorkspace(t);
  const inner = tree.nodeObserver();
  const { watch, batches, problems } = await start(workspace, {
    observe: async (directory, changed) => {
      if (directory === lessons) throw new Error('这个目录监不了（探针）');
      return inner(directory, changed);
    },
  });
  t.after(() => watch.close());

  assert.ok(problems.some((message) => message.includes('这个目录监不了')), `要记下失败原因：${JSON.stringify(problems)}`);
  assert.ok(!watch.directories().includes(lessons), '起不来的目录不该出现在集合里');
  assert.ok(watch.directories().length > 0, '别的目录还在看着');

  fs.writeFileSync(path.join(workspace, '.learning', 'MEMORY.yaml'), '# 画像\n');
  await waitFor(() => batches.length >= 1, '坏了一个目录不影响别的目录');
});

test('读盘失败不炸：工作区不在时照常返回一份空监听 + 一句问题', async (t) => {
  const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-watch-gone-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.rmSync(workspace, { recursive: true, force: true }); // 建完就删：扫盘必须失败

  const { watch, problems } = await start(workspace);
  t.after(() => watch.close());
  assert.deepEqual(watch.directories(), []);
  assert.equal(problems.length >= 1, true, '要说清「扫不了这个目录」，而不是静默');
  assert.equal(tree.collectDirectories(workspace), null, '读不到就返回 null（调用方保留现有集合）');
});

test('目录数封顶：再大的工作区也不会挂出成百上千个观察者', async (t) => {
  const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-watch-wide-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (let index = 0; index < 20; index++) fs.mkdirSync(path.join(workspace, `d${index}`, 'inner'), { recursive: true });

  assert.equal(tree.collectDirectories(workspace, 4, 7).length, 7);
  const { watch } = await start(workspace, { maxDirectories: 5 });
  t.after(() => watch.close());
  assert.equal(watch.directories().length, 5);
});

test('close() 之后不再回调（卸载不留观察者）', async (t) => {
  const { workspace, lessons } = makeWorkspace(t);
  const { watch, batches } = await start(workspace);
  await watch.close();
  fs.writeFileSync(path.join(lessons, '0001-var.md'), '# 改在关闭之后\n');
  await sleep(500);
  assert.deepEqual(batches, []);
  assert.deepEqual(watch.directories(), []);
});

test('回调时目录已经被删掉：观察者当场摘掉，不留空转的句柄', async (t) => {
  // Windows 后端（ReadDirectoryChangesW）在路径消失之后会一直回调：实测每秒上万次、
  // 单核打满、进程退不出去（inotify 只发一次 IN_DELETE_SELF）。用假后端把「回调来了但
  // 目录已经没了」这件事摆在两个平台上都一样的位置，钉住「必须摘观察者」这条。
  const { workspace, subjects } = makeWorkspace(t);
  const closed = [];
  let fire = null;
  const fakeObserve = async (directory, changed) => {
    if (directory === subjects) fire = changed;
    return async () => { closed.push(directory); };
  };
  const watch = await tree.startTreeWatch({
    workspace,
    observe: fakeObserve,
    backend: 'probe',
    onChanged: () => {},
    onProblem: () => {},
  });
  t.after(() => watch.close());

  assert.ok(watch.directories().includes(subjects), '起手应当挂着 subjects/');
  fs.rmSync(subjects, { recursive: true, force: true });
  assert.ok(fire, '假后端要抓到 subjects/ 的回调');
  fire(); // 模拟「已删路径又来了一条回调」

  await waitFor(() => closed.includes(subjects), '被删目录的观察者要关掉');
  assert.ok(!watch.directories().includes(subjects), '被删目录不该留在目录集合里');
});

test('删目录之后观察者自己摘掉：Windows 上不会空转（真后端实测）',
  { skip: process.platform !== 'win32' && '只有 Windows 后端会对已删路径持续回调' }, async (t) => {
  const { workspace, subjects } = makeWorkspace(t);
  const { watch, batches } = await start(workspace);
  t.after(() => watch.close());
  assert.ok(watch.directories().includes(subjects));

  fs.rmSync(subjects, { recursive: true, force: true });
  // 目录没了 → 回调里发现路径消失 → 摘掉观察者。给足时间等真后端把事件送过来。
  await waitFor(() => !watch.directories().includes(subjects), '被删目录要自己从集合里消失', 4000);
  // 之后再等两拍：不应该有大批回调（Windows 不摘就会是每秒上万次）。
  const settled = batches.length;
  await sleep(300);
  assert.ok(batches.length - settled <= 2,
    `删掉目录后不该继续冒事件：${batches.length - settled} 条`);
});

test('读回声/属性噪音：磁盘内容未变时触发回调，去抖后不推通知', async (t) => {
  const { workspace, lessons } = makeWorkspace(t);
  const triggers = new Map();
  const debounceMs = 40;
  const { watch, batches } = await start(workspace, {
    debounceMs,
    backend: 'probe',
    observe: async (directory, changed) => {
      triggers.set(directory, changed);
      return async () => {};
    },
  });
  t.after(() => watch.close());

  const trigger = triggers.get(lessons);
  assert.equal(typeof trigger, 'function', '假后端要抓到 lessons/ 的回调');
  trigger();
  await sleep(debounceMs + 100);
  assert.equal(batches.length, 0, '磁盘内容未变时不应发布通知');
});

test('同刻度 mtime 不变但文件字节长度变化：指纹仍能识别并推送一条通知', async (t) => {
  const { workspace, lessons } = makeWorkspace(t);
  const target = path.join(lessons, '0001-var.md');
  const fixedSec = 1_700_000_000;
  fs.writeFileSync(target, '1234');
  fs.utimesSync(target, fixedSec, fixedSec);
  const before = fs.statSync(target);
  assert.equal(before.size, 4);

  const triggers = new Map();
  const debounceMs = 40;
  const { watch, batches } = await start(workspace, {
    debounceMs,
    backend: 'probe',
    observe: async (directory, changed) => {
      triggers.set(directory, changed);
      return async () => {};
    },
  });
  t.after(() => watch.close());

  fs.writeFileSync(target, '12345678901234567890');
  fs.utimesSync(target, fixedSec, fixedSec);
  const after = fs.statSync(target);
  assert.equal(after.mtimeMs, before.mtimeMs, '测试前置：mtime 保持同一整秒不变');
  assert.equal(after.size, 20, '测试前置：字节长度由 4B 改为 20B');

  const trigger = triggers.get(lessons);
  assert.equal(typeof trigger, 'function', '假后端要抓到 lessons/ 的回调');
  trigger();
  await waitFor(() => batches.length >= 1, '同刻度 mtime 不变但字节长度变化应发布通知');
  await sleep(debounceMs + 60);
  assert.equal(batches.length, 1);
});

test('建观察者窗口内的真实写入不漏报：启动前取基线，返回后触发回调能收到通知', async (t) => {
  const { workspace, lessons } = makeWorkspace(t);
  const triggers = new Map();
  let wroteInWindow = false;
  const debounceMs = 40;
  const { watch, batches } = await start(workspace, {
    debounceMs,
    backend: 'probe',
    observe: async (directory, changed) => {
      triggers.set(directory, changed);
      if (directory === lessons && !wroteInWindow) {
        wroteInWindow = true;
        fs.writeFileSync(path.join(lessons, '0002-window.md'), '# 窗口内写入\n');
      }
      return async () => {};
    },
  });
  t.after(() => watch.close());

  assert.equal(wroteInWindow, true, '假 observe 回调体内应已写入新文件');
  const trigger = triggers.get(lessons);
  assert.equal(typeof trigger, 'function', '假后端要抓到 lessons/ 的回调');
  trigger();
  await waitFor(() => batches.length >= 1, '建观察者窗口内的写入不应被当成基线漏报');
  await sleep(debounceMs + 60);
  assert.equal(batches.length, 1);
});
