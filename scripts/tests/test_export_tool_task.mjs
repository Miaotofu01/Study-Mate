/* 导出 · **工具面与任务模型**（`lib/tools/export.ts` + `lib/export/task.ts`）
   ────────────────────────────────────────────────────────────────────────
   issue #82 的验收里有两条在这张套件里落地：

     · **DSH 里不主动导出**：插件注册完（工具挂上、任务类型登记好）之后，一个导出任务都没有、
       一个产物都没写。只有 `studymate_export` 被调用才会起活——这条是「按需」的机器证据。
     · **导出走任务模型**：起的是 `durable: true` 的「导出」任务（重开 DSH 接得上）、
       工具**有上限地等**（等到就返回文件清单，等不到就返回句柄与下一步）、
       取消回执说清「哪些已完成的产物会保留」。

   数据现造现弃（ADR-0009）：临时 DSH_HOME + 临时工作区 + 夹具 React，跑完就删。
   ───────────────────────────────────────────────────────────────────────── */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT, assertOutput, execute, fakeContext, useHome } from './fixtures/tools.mjs';
import { fakeReactRoot, writeExportWorkspace } from './fixtures/export_workspace.mjs';

const tools = await import(pathToFileURL(path.join(ROOT, 'lib/tools/index.ts')).href);
const tasks = await import(pathToFileURL(path.join(ROOT, 'lib/tasks/index.ts')).href);

/** 一个只属于本用例的环境：隔离的 DSH_HOME（任务台账落在里面）+ 现造的工作区 + 夹具 React。 */
function setup(t) {
  const home = useHome(t);
  tasks.resetTaskService();
  t.after(() => tasks.resetTaskService());
  writeExportWorkspace(home.workspace);
  const previous = process.env.STUDYMATE_REACT_DIR;
  process.env.STUDYMATE_REACT_DIR = fakeReactRoot(home.home);
  t.after(() => {
    if (previous === undefined) delete process.env.STUDYMATE_REACT_DIR;
    else process.env.STUDYMATE_REACT_DIR = previous;
  });
  const ctx = fakeContext();
  tools.registerStudyMate(ctx.ctx);
  return { ...home, ctx };
}

/** 一个「闸门」：用例自己决定什么时候放行，比 sleep 可靠（照 test_tasks_model.mjs）。 */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

test('DSH 侧不主动导出：注册完插件，一个任务都没有、一个产物都没写', (t) => {
  const { workspace, ctx } = setup(t);
  assert.ok(ctx.definitions.has('studymate_export'), '导出工具要在注册点上');
  // 任务类型**加载时就登记**：重开 DSH 之后 resume 要靠它按名字找回跑法
  assert.deepEqual(tasks.taskService().kinds(), ['导出']);
  assert.deepEqual(tasks.taskService().list('本机'), [], '注册不等于起任务');
  assert.ok(!fs.existsSync(path.join(workspace, 'export')), '没人说「导出一份能离线看的」之前，不写任何产物');
});

test('studymate_export：起 durable 任务、有上限地等、返回文件清单与产物路径', async (t) => {
  const { workspace, ctx } = setup(t);
  const value = await execute(ctx, 'studymate_export', {});
  await assertOutput(assert, ctx.definitions.get('studymate_export'), value);

  assert.equal(value.settled, true, `等到了：${value.note}`);
  assert.equal(value.status, '完成');
  assert.equal(value.out, path.join(workspace, 'export'));
  assert.ok(value.files.includes('index.html'));
  assert.ok(value.files.includes('studymate-client.js'));
  assert.equal(value.count, value.files.length);
  assert.ok(value.bytes > 100_000, '产物里带着阅读端本体与第三方构建');
  assert.deepEqual(value.problems, [], '守卫对这份产物应当是干净的');
  assert.deepEqual(value.subjects.map((subject) => subject.slug), ['demo']);

  // 任务记录：类型、durable、产物登记（取消回执要靠它说清保留了什么）
  const view = tasks.taskService().status('本机', value.taskId);
  assert.equal(view.kind, '导出');
  assert.equal(view.durable, true, '导出是关键任务：落盘，重开 DSH 接得上');
  assert.equal(view.status, '完成');
  assert.equal(view.artifacts.length, value.count);
  assert.ok(view.artifacts.every((artifact) => artifact.state === '已完成'));
  assert.ok(view.artifacts.every((artifact) => path.isAbsolute(artifact.path)), '产物登记成绝对路径，学生照着就能找到');
  // 阅读端那块板子（GET /api/studymate/tasks 的返回体）上也看得到，且板子上没有 owner
  const board = tasks.taskBoard(tasks.taskService()).tasks.find((entry) => entry.id === value.taskId);
  assert.ok(board, '板子上要有它（阅读端画进度条用）');
  assert.equal(Object.hasOwn(board, 'owner'), false);
});

test('等待有上限：工具用的是任务域那个默认上限（不会把会话挂住）', () => {
  assert.equal(tools.STUDY_TOOL_NAMES.includes('studymate_export'), true);
  assert.equal(tasks.DEFAULT_WAIT_MS, 30_000);
});

test('取消排队中的导出：当场落「已取消」，没有半成品', async (t) => {
  const { workspace } = setup(t);
  const service = tasks.taskService();
  const hold = gate();
  service.registerKind(tasks.defineTaskKind({
    kind: '占位', prefix: 'hold', run: async () => { await hold.promise; },
  }));
  // 占满两个并发位（默认 maxConcurrent = 2），导出就只能排队
  service.start('本机', { kind: '占位', label: '占位一' });
  service.start('本机', { kind: '占位', label: '占位二' });
  const queued = service.start('本机', {
    kind: '导出', label: '导出整个学习工作区', durable: true, input: { workspace },
  });
  assert.equal(service.status('本机', queued).status, '排队');
  const receipt = service.cancel('本机', queued, '学生改主意了');
  assert.equal(receipt.requested, true);
  assert.equal(receipt.status, '已取消');
  assert.deepEqual(receipt.kept, [], '一个产物都没落成');
  assert.match(receipt.note, /还在排队，已经当场取消——没有半成品，也没有产物/);
  assert.ok(!fs.existsSync(path.join(workspace, 'export')), '排队时取消：连目录都不该有');
  hold.open();
  await service.wait('本机', service.list('本机').find((task) => task.kind === '占位').id, { timeoutMs: 1000 }).catch(() => {});
});

test('取消已经完成的导出：如实说「取消来晚了」，已完成的产物一律保留', async (t) => {
  const { workspace } = setup(t);
  const service = tasks.taskService();
  const handle = service.start('本机', {
    kind: '导出', label: '导出整个学习工作区', durable: true, input: { workspace },
  });
  const waited = await service.wait('本机', handle, { timeoutMs: 20_000 });
  assert.equal(waited.settled, true);
  const receipt = service.cancel('本机', handle, '手滑');
  assert.equal(receipt.requested, false);
  assert.match(receipt.note, /取消来晚了：任务已经「完成」/);
  assert.ok(receipt.kept.length > 0, '已完成的产物清单要在回执里');
  assert.ok(receipt.kept.every((file) => fs.existsSync(file)), '回执说保留，就真的还在盘上');
  assert.match(receipt.note, /已完成的产物一律保留（不回滚、不删）/);
});

test('越权：别人的句柄看不了这个任务（导出任务有 owner）', async (t) => {
  const { ctx } = setup(t);
  const service = tasks.taskService();
  // 带会话身份调一次（夹具的 execute 不带 agent，那会是「本机」的无主任务，谁都看得见）
  const definition = ctx.definitions.get('studymate_export');
  const value = await definition.execute({}, { signal: new AbortController().signal, agent: { id: '会话甲' } });
  assert.equal(value.status, '完成');
  assert.equal(service.status('会话甲', value.taskId).owner, '会话甲');
  assert.deepEqual(service.list('会话乙'), [], '别人的任务列表里没有它');
  assert.throws(() => service.status('会话乙', value.taskId), /不归你/);
});

test('导出的落点是工作区里的 export/：不是 .learning/，也不是工作区根', async (t) => {
  const { workspace } = setup(t);
  const service = tasks.taskService();
  const handle = service.start('本机', {
    kind: '导出', label: '导出', durable: true, input: { workspace },
  });
  const waited = await service.wait('本机', handle, { timeoutMs: 20_000 });
  assert.equal(waited.task.status, '完成', waited.task.detail ?? '');
  assert.ok(fs.existsSync(path.join(workspace, 'export', 'index.html')));
  assert.ok(!fs.existsSync(path.join(workspace, '.learning', 'export')));
  assert.ok(!fs.existsSync(path.join(workspace, 'index.html')), '工作区根不再生成页面（规格 §5.1）');
});

test('入参坏形状当场说清（resume 会拿同一份重跑，坏入参不能跑到一半才发现）', async () => {
  const { parseExportInput } = await import(pathToFileURL(path.join(ROOT, 'lib/export/task.ts')).href);
  assert.throws(() => parseExportInput(null), /要一个 \{ workspace/);
  assert.throws(() => parseExportInput({}), /缺 workspace/);
  assert.deepEqual(parseExportInput({ workspace: '/tmp/x', subjects: ['a', '', 3], out: '' }),
    { workspace: '/tmp/x', subjects: ['a'] });
});
