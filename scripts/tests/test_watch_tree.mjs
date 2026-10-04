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

  fs.writeFileSync(path.join(workspace, '.learning', 'MEMORY.md'), '# 画像\n');
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
