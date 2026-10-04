/* StudyMate 任务模型 · **状态机 / 句柄 / 落盘 / 工具面 / 阅读端路由**（`lib/tasks/**`）
   ────────────────────────────────────────────────────────────────────────
   issue #73 的验收逐条落在这一份里：

     1. 起一个任务：能查状态、能等、能取消，**三种结局（完成/失败/已取消）各有一份回执**
     2. 等待超时后返回**可行的下一步提示**，不吊死、不静默
     3. 关掉 DSH 再开：落盘的 durable 任务**接得上**（用真·跨进程证明：spawn 一个子进程起任务
        并落盘 → 父进程重新加载后查得到、resume 得动）
     4. 用别人的句柄访问任务会被拒绝
     5. 新套件登记进门禁（`scripts/release/checks.mjs` 的 core 组）

   另外钉住三件容易写歪的事：状态查询**同步**返回（不阻塞）、取消/销毁的**回执**内容、
   阅读端那条路由的路径与返回形状（板子上**没有 owner**，免得从板子抄个 owner 去伪造句柄）。

   数据现造现弃（ADR-0009）：临时目录 + 临时 DSH_HOME，跑完就删；仓库里不存样例数据。
   跨进程那一节另有一个夹具 `fixtures/tasks_producer.mjs`（spawn 出去的「进程 A」）。 */

import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { ROOT, tempDir, useHome } from './fixtures/tools.mjs';

const tasks = await import(pathToFileURL(path.join(ROOT, 'lib/tasks/index.ts')).href);
const tools = await import(pathToFileURL(path.join(ROOT, 'lib/tools/index.ts')).href);
const PRODUCER = path.join(ROOT, 'scripts/tests/fixtures/tasks_producer.mjs');
const TASKS_MODULE = path.join(ROOT, 'lib/tasks/index.ts');

/** 「等待有上限」那条用例的预算：受控时钟下，它既是 tick 的步长，也是 waitedMs 的期望值。 */
const WAIT_BUDGET_MS = 40;

/* ── 夹具 ─────────────────────────────────────────────────────────────── */

/** 一个只属于本用例的台账目录（现造现弃）。 */
function ledger(t) {
  return tempDir(t, 'studymate-tasks-');
}

/** 起一个服务，登记「导出」这一种任务：跑法由用例给。 */
function serviceWith(dir, run, options = {}) {
  const service = tasks.createTaskService({ dir, ...options });
  service.registerKind(tasks.defineTaskKind({ kind: '导出', prefix: 'export', run }));
  return service;
}

/** 等一个「闸门」：用例自己决定什么时候放行，比 sleep 可靠。 */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

/**
 * 工具面的假 ctx：把注册进来的定义、effect 标签、connection 路由都收起来。
 * `inject` 的语义与真宿主一致——只在服务齐了的组合里回调一次。
 */
function taskContext() {
  const definitions = new Map();
  const effects = [];
  const routes = [];
  const ctx = {
    tools: {
      register: (definition) => {
        definitions.set(definition.name, definition);
        return () => definitions.delete(definition.name);
      },
    },
    effect: (fn, label) => {
      effects.push(label ?? '');
      return fn();
    },
    get: () => undefined,
    inject: (names, handler) => {
      if (!names.includes('connection')) return;
      handler({
        connection: {
          fetch: {
            register: (route) => {
              routes.push(route);
              return async () => {};
            },
          },
        },
        effect: (fn, label) => {
          effects.push(label ?? '');
          return fn();
        },
      });
    },
  };
  return { ctx, definitions, effects, routes };
}

function dispatch(context, name, args = {}, run = {}) {
  const definition = context.definitions.get(name);
  if (!definition) throw new Error(`没有注册工具「${name}」：${[...context.definitions.keys()].join('、')}`);
  return definition.execute(args, { signal: new AbortController().signal, ...run });
}

async function assertOutput(definition, value) {
  const { outputProblems } = await import('./fixtures/tools.mjs');
  const problems = await outputProblems(definition.output.schema, value);
  assert.deepEqual(problems, [], `${definition.name} 的返回值不符合 output.schema`);
}

const readRecord = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));

/* ── 一、六态状态机 ───────────────────────────────────────────────────── */

test('状态就这六个中文值（目标态规格 §3.2），终态只进不出', () => {
  assert.deepEqual([...tasks.TASK_STATUSES], ['排队', '运行', '取消中', '完成', '失败', '已取消']);
  assert.deepEqual([...tasks.TERMINAL_STATUSES], ['完成', '失败', '已取消']);
  assert.deepEqual([...tasks.LIVE_STATUSES], ['排队', '运行', '取消中']);

  // 合法的那几条
  for (const [from, to] of [
    ['排队', '运行'], ['排队', '已取消'], ['排队', '失败'],
    ['运行', '取消中'], ['运行', '完成'], ['运行', '失败'],
    ['取消中', '已取消'], ['取消中', '完成'],
  ]) {
    assert.equal(tasks.canTransition(from, to), true, `${from} → ${to} 应当合法`);
  }
  // 终态不出来，未结束的也不能直接跳到别的未结束态
  for (const [from, to] of [
    ['完成', '运行'], ['完成', '排队'], ['已取消', '运行'], ['失败', '运行'],
    ['运行', '排队'], ['排队', '取消中'], ['取消中', '运行'],
  ]) {
    assert.equal(tasks.canTransition(from, to), false, `${from} → ${to} 不该合法`);
  }
  // 唯一的例外：被重启打断的落盘任务 resume 时要回得来（服务侧还要查 interrupted）
  assert.equal(tasks.canTransition('失败', '排队'), true);
});

/* ── 二、起任务 / 查状态 / 排队 / 等 / 取消 / 销毁 ─────────────────────── */

test('起一个 durable 任务：状态查询同步返回，记录同时落在盘上', async (t) => {
  const dir = ledger(t);
  const hold = gate();
  const service = serviceWith(dir, async (job) => {
    job.progress('1/2 写第一份', { done: 1, total: 2 });
    await hold.promise;
    return { detail: '跑完了', result: { files: [] } };
  });

  const handle = service.start('session-A', { kind: '导出', label: '导出 demo', durable: true });
  assert.deepEqual(handle, { id: 'export-1', owner: 'session-A' }, '句柄就是 { id, owner } 两个字段');

  // 查状态**从不阻塞**：返回值是投影，不是 Promise
  const view = service.status('session-A', handle);
  assert.equal(view instanceof Promise, false);
  assert.equal(view.status, '运行');
  assert.deepEqual(view.progress, { line: '1/2 写第一份', done: 1, total: 2, percent: 50 });
  assert.equal(view.canCancel, true);
  assert.equal(view.receipt, undefined, '没结束就没有终态回执');
  assert.equal(view.durable, true);

  // 盘上那份也已经是「运行」；进度是**节流**写的（高频更新不逐条落盘），
  // 要立刻在盘上看到就显式刷一次——这也是跨进程夹具里那一句 flush 的理由
  service.flush();
  const onDisk = readRecord(dir, 'export-1');
  assert.equal(onDisk.status, '运行');
  assert.equal(onDisk.owner, 'session-A');
  assert.equal(onDisk.progress.line, '1/2 写第一份');

  hold.open();
  const waited = await service.wait('session-A', handle, { timeoutMs: 2000 });
  assert.equal(waited.settled, true);
  assert.equal(waited.timedOut, false);
  assert.equal(waited.next, '', '结束了就没有下一步提示');
  assert.equal(waited.task.receipt.status, '完成');
});

test('并发位占满时后来者真的是「排队」；取消排队中的任务当场落「已取消」', async (t) => {
  const dir = ledger(t);
  const hold = gate();
  const service = serviceWith(dir, async () => { await hold.promise; }, { maxConcurrent: 1 });

  const first = service.start('session-A', { kind: '导出', label: '第一个' });
  const second = service.start('session-A', { kind: '导出', label: '第二个' });
  assert.equal(service.status('session-A', first).status, '运行');
  assert.equal(service.status('session-A', second).status, '排队', '并发位只有一个，第二个就该在排队');

  const receipt = service.cancel('session-A', second, '不需要了');
  assert.equal(receipt.status, '已取消');
  assert.equal(receipt.requested, true);
  assert.deepEqual(receipt.kept, []);
  assert.match(receipt.note, /还在排队，已经当场取消/);
  assert.equal(service.status('session-A', second).receipt.status, '已取消');

  hold.open();
  await service.wait('session-A', first, { timeoutMs: 2000 });
});

test('三种结局各有一份明确回执：完成 / 失败 / 已取消', async (t) => {
  const dir = ledger(t);
  const files = {
    完成: path.join(dir, 'done.html'),
    失败: path.join(dir, 'failed-half.html'),
    取消: path.join(dir, 'cancel-done.html'),
    取消半成品: path.join(dir, 'cancel-half.html'),
  };
  // 跑法按**入参**分岔（不是按起任务之后才写的表：start() 里就会同步把任务拉起来）
  const service = serviceWith(dir, async (job, input) => {
    const mode = input?.mode ?? '完成';
    if (mode === '完成') {
      job.progress('写文件', { done: 1, total: 1 });
      fs.writeFileSync(files.完成, '<html>ok</html>\n');
      job.artifact(files.完成, '已完成');
      return { detail: '写完了 1 份', result: { files: [files.完成] } };
    }
    if (mode === '失败') {
      fs.writeFileSync(files.失败, '<html>半份');
      job.artifact(files.失败, '进行中');
      throw new Error('磁盘满了');
    }
    // 已取消：写出半份 + 一份已完成的，然后一直等取消信号
    fs.writeFileSync(files.取消半成品, '<html>写到这里');
    job.artifact(files.取消半成品, '进行中');
    fs.writeFileSync(files.取消, '已经写完的那一份');
    job.artifact(files.取消, '已完成');
    await new Promise((resolve) => {
      job.signal.addEventListener('abort', resolve, { once: true });
      if (job.signal.aborted) resolve();
    });
    throw new Error('收到取消信号，停下了');
  });

  // 完成
  const okHandle = service.start('session-A', { kind: '导出', label: '导出 demo', input: { mode: '完成' } });
  const ok = await service.wait('session-A', okHandle, { timeoutMs: 2000 });
  assert.equal(ok.task.receipt.status, '完成');
  assert.deepEqual(ok.task.receipt.kept, [files.完成]);
  assert.deepEqual(ok.task.receipt.result, { files: [files.完成] });
  assert.match(ok.task.receipt.summary, /做完了：写完了 1 份；保留 1 件已完成的产物/);

  // 失败
  const failHandle = service.start('session-A', { kind: '导出', label: '导出失败的那份', input: { mode: '失败' } });
  const failed = await service.wait('session-A', failHandle, { timeoutMs: 2000 });
  assert.equal(failed.task.status, '失败');
  assert.equal(failed.task.receipt.status, '失败');
  assert.match(failed.task.receipt.summary, /失败了：磁盘满了/);
  assert.match(failed.task.receipt.summary, /半成品不算数/);
  assert.deepEqual(failed.task.receipt.discarded, [files.失败]);

  // 已取消
  const cancelHandle = service.start('session-A', { kind: '导出', label: '导出到一半取消', input: { mode: '取消' } });
  await new Promise((resolve) => setImmediate(resolve)); // 让它真的开跑（写产物）
  const receipt = service.cancel('session-A', cancelHandle, '学生说不要了');
  assert.equal(receipt.requested, true);
  assert.equal(receipt.status, '取消中');
  assert.deepEqual(receipt.kept, [files.取消], '回执要写清哪些已完成的产物会保留');
  assert.deepEqual(receipt.discarded, [files.取消半成品]);
  assert.match(receipt.note, /已完成的产物一律保留（不回滚、不删）：/);
  const stopped = await service.wait('session-A', cancelHandle, { timeoutMs: 2000 });
  assert.equal(stopped.task.status, '已取消');
  assert.equal(stopped.task.receipt.status, '已取消');
  assert.match(stopped.task.receipt.summary, /已取消（学生说不要了）/);
  assert.deepEqual(stopped.task.receipt.kept, [files.取消]);
  assert.ok(fs.existsSync(files.取消), '已完成的产物取消之后还在盘上');
});

test('等待有上限：超时返回下一步提示，任务本身照旧在跑', async (t) => {
  /* 判据要确定，不能靠「机器刚好跑得快」。
     `waitedMs` 是 `Date.now()` 的差值，而唤醒来自 `setTimeout`——两个时钟各自按毫秒取整，
     天然有 ±1ms 抖动。原来断言 `waitedMs >= 40` 因此偶发实测 39ms（假红，约一半概率），
     把 40 调成 38 只是把假红概率变小、并没有消除抖动。
     这里把 `setTimeout` 与 `Date` 一起换成受控的：预算走多少由 `tick` 的步长构造出来，
     `waitedMs` 与预算**恰好相等**——既不早醒（早醒＝根本没等），也不多等（多等＝吊死）。 */
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-01-01T00:00:00Z') });

  const dir = ledger(t);
  const hold = gate();
  const service = serviceWith(dir, async (job) => {
    job.progress('3/7 科目 demo', { done: 3, total: 7 });
    await hold.promise;
  });
  const handle = service.start('session-A', { kind: '导出', label: '导出全部科目' });

  const waiting = service.wait('session-A', handle, { timeoutMs: WAIT_BUDGET_MS });
  t.mock.timers.tick(WAIT_BUDGET_MS);
  const timedOut = await waiting;
  assert.equal(timedOut.settled, false);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.waitedMs, WAIT_BUDGET_MS,
    `受控时钟下应当恰好等满预算 ${WAIT_BUDGET_MS}ms，实际 ${timedOut.waitedMs}`);
  assert.equal(timedOut.task.status, '运行', '超时不等于取消：任务照旧在跑');
  // 下一步提示要能照着做：接着说清了三条路（继续等 / 不阻塞地看 / 取消）
  assert.match(timedOut.next, /还在跑（进度：3\/7 科目 demo）/);
  assert.match(timedOut.next, /studymate_task_wait/);
  assert.match(timedOut.next, /studymate_task_status/);
  assert.match(timedOut.next, /studymate_task_cancel/);

  // 上界是硬约束：超了直接拒，不许「等一个不确定的时长」
  await assert.rejects(() => service.wait('session-A', handle, { timeoutMs: tasks.MAX_WAIT_MS + 1 }),
    /\[TASK_BAD_INPUT\] timeoutMs/);

  // 后半段回到真时钟：这里的「不会吊死」要在真实时间上验，超时由 2000ms 兜底（真吊死会直接失败）
  t.mock.timers.reset();
  hold.open();
  const settled = await service.wait('session-A', handle, { timeoutMs: 2000 });
  assert.equal(settled.settled, true);
});

test('销毁：回执先到手，文件后删；活着的任务不许销毁', async (t) => {
  const dir = ledger(t);
  const artifact = path.join(dir, 'out.txt');
  const hold = gate();
  const service = serviceWith(dir, async (job) => {
    await hold.promise;
    fs.writeFileSync(artifact, 'done\n');
    job.artifact(artifact, '已完成');
    return { result: {} };
  });
  const handle = service.start('session-A', { kind: '导出', label: '导出一份', durable: true });

  assert.throws(() => service.destroy('session-A', handle), /\[TASK_NOT_SETTLED\]/,
    '还在跑的任务没有「删掉就没事了」这回事');

  hold.open();
  await service.wait('session-A', handle, { timeoutMs: 2000 });

  const recordFile = path.join(dir, 'export-1.json');
  const receipt = service.destroy('session-A', handle);
  assert.equal(receipt.order, '先回执，后删文件');
  assert.deepEqual(receipt.recordFiles, [recordFile]);
  assert.deepEqual(receipt.artifactsKept, [artifact], '默认不删产物');
  assert.deepEqual(receipt.artifactsDeleted, []);
  assert.ok(fs.existsSync(recordFile), '回执到手的那一刻，文件还没删（这就是「先回执」）');
  assert.equal(service.list('session-A').length, 0, '可见集里当场摘掉');

  await service.flushDeletions();
  assert.equal(fs.existsSync(recordFile), false, '回执之后才轮到删文件');
  assert.ok(fs.existsSync(artifact), '产物保留（要删得明确说 deleteArtifacts）');
  assert.deepEqual(service.problems(), []);
});

test('destroy 明确要求时才删产物；越权句柄连记录都读不到', async (t) => {
  const dir = ledger(t);
  const artifact = path.join(dir, 'out.txt');
  const service = serviceWith(dir, async (job) => {
    fs.writeFileSync(artifact, 'done\n');
    job.artifact(artifact, '已完成');
    return {};
  });
  const handle = service.start('session-A', { kind: '导出', label: '导出一份' });
  await service.wait('session-A', handle, { timeoutMs: 2000 });

  // 越权：句柄发给 A，B 拿着它来 —— 三个动作都拒
  assert.throws(() => service.status('session-B', handle), (error) => {
    assert.equal(error.code, 'TASK_FORBIDDEN');
    assert.match(error.message, /^\[TASK_FORBIDDEN\]/);
    assert.match(error.message, /发给别人的/);
    return true;
  });
  assert.throws(() => service.cancel('session-B', handle), /TASK_FORBIDDEN/);
  assert.throws(() => service.destroy('session-B', handle), /TASK_FORBIDDEN/);
  // 拿 id 来也不行：任务属于另一个调用方
  assert.throws(() => service.status('session-B', 'export-1'), /TASK_FORBIDDEN/);
  // 列表里看不到别人（不属于自己的、也不是无主的）
  assert.deepEqual(service.list('session-B'), []);
  assert.equal(service.list('session-A').length, 1);

  const receipt = service.destroy('session-A', handle, { deleteArtifacts: true });
  assert.deepEqual(receipt.artifactsDeleted, [artifact]);
  assert.deepEqual(receipt.artifactsKept, []);
  await service.flushDeletions();
  assert.equal(fs.existsSync(artifact), false);
});

test('无主任务（没有会话身份的产出方起的）谁都能看；resume 只认被打断的', async (t) => {
  const dir = ledger(t);
  const hold = gate();
  const service = serviceWith(dir, async () => { await hold.promise; });
  const unowned = service.start(tasks.UNOWNED, { kind: '导出', label: '插件自己起的活' });
  assert.deepEqual(unowned, { id: 'export-1', owner: '本机' });
  assert.equal(service.status('session-B', unowned).id, 'export-1', '无主任务谁都能查');
  assert.equal(service.list('session-B').length, 1);

  hold.open();
  const finished = await service.wait('session-A', unowned, { timeoutMs: 2000 });
  assert.equal(finished.settled, true);
  assert.throws(() => service.resume('session-A', unowned), /\[TASK_NOT_INTERRUPTED\]/);

  // 找不到的 id 要说清现在有什么，别只给一句 not found
  assert.throws(() => service.status('session-A', 'export-99'), (error) => {
    assert.equal(error.code, 'TASK_NOT_FOUND');
    assert.match(error.message, /export-1/);
    return true;
  });
  // 没有登记的类型起不了活，消息里要写清「工具不是起活的地方」
  assert.throws(() => service.start('session-A', { kind: '索引重建', label: 'x' }),
    /没有登记的任务类型「索引重建」/);
});

/* ── 三、跨进程：关掉 DSH 再开，落盘的 durable 任务接得上 ──────────────── */

function runProducer(dir, scenario) {
  const result = spawnSync(process.execPath, [PRODUCER, TASKS_MODULE, dir, scenario], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.equal(result.status, 0, `进程 A 失败了：${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

test('跨进程：进程 A 停在半路，进程 B 重新加载后查得到、resume 得动', async (t) => {
  const dir = ledger(t);
  const started = runProducer(dir, 'mid-flight');
  assert.deepEqual(started.started, { id: 'export-1', owner: 'session-A' });

  // 进程 A 已经没了，盘上留下的是一份「运行」中的记录——这就是进程 B 要接手的东西
  assert.equal(readRecord(dir, 'export-1').status, '运行');

  // 进程 B：一份全新的服务，从同一个台账目录重新加载
  const artifact = path.join(dir, 'artifacts', 'second.txt');
  const service = serviceWith(dir, async (job) => {
    job.progress('重跑：写第二份', { done: 1, total: 1 });
    fs.writeFileSync(artifact, '第二份也写完了\n');
    job.artifact(artifact, '已完成');
    return { detail: '重开之后接着跑完', result: { files: [artifact] } };
  });

  const [loaded] = service.list('session-A');
  assert.equal(loaded.id, 'export-1');
  assert.equal(loaded.status, '失败', '进程没了就不能再说它「运行」');
  assert.equal(loaded.interrupted, true);
  assert.match(loaded.detail, /DSH 重启时它还在「运行」/);
  assert.equal(loaded.attempt, 1);
  assert.deepEqual(loaded.artifacts.map((entry) => entry.state), ['已完成', '进行中'],
    '第一份是已完成、第二份是半成品，都留在盘上');

  // 能查、还能等（虽然它已经是终态）——不会因为「进程换了」就查不着
  const seen = service.status('session-A', 'export-1');
  assert.equal(seen.receipt.status, '失败');
  assert.match(seen.receipt.summary, /被 DSH 重启打断/);

  // 接着做：resume 按原来的类型重跑一遍（attempt +1）
  const resumed = service.resume('session-A', 'export-1');
  assert.equal(resumed.attempt, 2);
  assert.equal(resumed.interrupted, undefined);
  const finished = await service.wait('session-A', resumed, { timeoutMs: 2000 });
  assert.equal(finished.task.status, '完成');
  assert.equal(finished.task.attempt, 2);
  assert.match(finished.task.receipt.summary, /重开之后接着跑完/);
  assert.ok(fs.existsSync(path.join(dir, 'artifacts', 'first.txt')), '上一轮已完成的产物还在');

  // 收尾：destroy 也能跨进程用（回执先给、文件后删）
  const receipt = service.destroy('session-A', 'export-1');
  assert.deepEqual(receipt.recordFiles, [path.join(dir, 'export-1.json')]);
  await service.flushDeletions();
  assert.equal(fs.existsSync(path.join(dir, 'export-1.json')), false);
});

test('跨进程：跑完的 durable 任务重开还在，回执从盘上重新派生得出来', async (t) => {
  const dir = ledger(t);
  runProducer(dir, 'done');

  // 等进程 A 的那一轮真的跑完（它是同一个进程里跑完才退的）
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'export-1.json'), 'utf8'));
  assert.equal(written.status, '完成');
  assert.equal(written.result.files.length, 2);

  const service = serviceWith(dir, async () => { throw new Error('不该重跑'); });
  const [loaded] = service.list('session-A');
  assert.equal(loaded.status, '完成');
  assert.equal(loaded.interrupted, undefined);
  assert.equal(loaded.receipt.status, '完成');
  assert.deepEqual(loaded.receipt.kept, [
    path.join(dir, 'artifacts', 'first.txt'),
    path.join(dir, 'artifacts', 'second.txt'),
  ]);
  assert.match(loaded.receipt.summary, /两份都写完/);

  // 不是 durable 的任务不落盘：重开之后不存在
  const ephemeral = serviceWith(ledger(t), async () => new Promise(() => {}));
  ephemeral.start('session-A', { kind: '导出', label: '不落盘的活' });
  assert.deepEqual(ephemeral.list('session-A').map((task) => task.durable), [false]);
  assert.equal(fs.existsSync(path.join(ephemeral.dir, 'export-1.json')), false);
});

/* ── 四、工具面：五个 studymate_task_* ─────────────────────────────────── */

test('五个工具都注册了：名字、一句话说明、空声明（任务状态不是学习数据域）', (t) => {
  useHome(t);
  tasks.resetTaskService();
  const context = taskContext();
  tasks.registerTaskTools(context.ctx, { registerStudyTool: tools.registerStudyTool });

  assert.deepEqual([...context.definitions.keys()], [...tasks.TASK_TOOL_NAMES]);
  assert.deepEqual([...tasks.TASK_TOOL_NAMES], [
    'studymate_task_status', 'studymate_task_wait', 'studymate_task_cancel',
    'studymate_task_destroy', 'studymate_task_resume',
  ]);
  for (const [name, definition] of context.definitions) {
    assert.match(name, /^[a-z0-9_]+$/, `${name} 会进模型 API 的 tools[].name`);
    assert.ok(!definition.description.includes('\n'), `${name} 的说明里有换行`);
    assert.ok([...definition.description].length <= 120, `${name} 的说明超长`);
    assert.deepEqual(definition.declaration.reads, [], '任务状态不是学习数据域，一个都不读');
    assert.deepEqual(definition.declaration.writes, {}, '工具面不改学习数据');
  }
  // 五个工具各挂一个可回收的 effect
  assert.equal(context.effects.filter((label) => label.startsWith('studymate: studymate_task_')).length, 5);
  // 起任务的入口**不是**工具：只有查/等/取消/销毁/接上
  assert.equal(context.definitions.has('studymate_task_start'), false,
    '起活是产出方的事（导出这类工具），工具面不提供凭空起任务的口子');
});

test('工具面：owner 取自调用方的会话标签，别人的任务查不到；wait 超时给下一步', async (t) => {
  useHome(t);
  tasks.resetTaskService();
  const context = taskContext();
  tasks.registerTaskTools(context.ctx, { registerStudyTool: tools.registerStudyTool });

  const hold = gate();
  const artifact = path.join(tasks.taskService().dir, 'x.txt');
  tasks.taskService().registerKind(tasks.defineTaskKind({
    kind: '导出', prefix: 'export',
    async run(job) {
      job.progress('1/2 写文件', { done: 1, total: 2 });
      await hold.promise;
      fs.writeFileSync(artifact, 'ok\n');
      job.artifact(artifact, '已完成');
      return { detail: '写完了', result: { files: [artifact] } };
    },
  }));
  const handle = tasks.taskService().start('session-A', { kind: '导出', label: '导出 demo', durable: true });

  // 别人的会话：越权被拒（这就是「别人拿到的句柄访问不了它」在工具面的样子）
  await assert.rejects(
    () => dispatch(context, 'studymate_task_status', { id: 'export-1' }, { agent: { id: 'session-B' } }),
    /TASK_FORBIDDEN/,
  );
  // 没有会话身份的调用方（探针 / 无头）也不算 A 的人
  await assert.rejects(
    () => dispatch(context, 'studymate_task_status', { id: 'export-1' }),
    /TASK_FORBIDDEN/,
  );

  // 本人：查得到，且输出过契约
  const mine = await dispatch(context, 'studymate_task_status', { id: 'export-1' }, { agent: { id: 'session-A' } });
  assert.equal(mine.tasks[0].id, 'export-1');
  assert.equal(mine.tasks[0].owner, 'session-A');
  assert.deepEqual(mine.tasks[0].progress, { line: '1/2 写文件', done: 1, total: 2, percent: 50 });
  await assertOutput(context.definitions.get('studymate_task_status'), mine);
  assert.deepEqual((await dispatch(context, 'studymate_task_status', {}, { agent: { id: 'session-A' } })).tasks.length, 1);

  // 空列表也要说清「任务从哪来」
  const empty = await dispatch(context, 'studymate_task_status', {}, { agent: { id: 'session-C' } });
  assert.deepEqual(empty.tasks, []);
  assert.match(empty.notes.join('\n'), /任务由产出方起/);
  await assertOutput(context.definitions.get('studymate_task_status'), empty);

  // 等待超时：输出里带着下一步（模型照着做就行）
  const timeout = await dispatch(context, 'studymate_task_wait', { id: 'export-1', timeoutMs: 30 },
    { agent: { id: 'session-A' } });
  assert.equal(timeout.settled, false);
  assert.equal(timeout.timedOut, true);
  assert.match(timeout.next, /studymate_task_wait/);
  await assertOutput(context.definitions.get('studymate_task_wait'), timeout);

  // 取消 + 等 + 销毁，三个回执都过输出契约
  const cancelled = await dispatch(context, 'studymate_task_cancel', { id: 'export-1', reason: '工具面用例' },
    { agent: { id: 'session-A' } });
  assert.equal(cancelled.requested, true);
  await assertOutput(context.definitions.get('studymate_task_cancel'), cancelled);
  hold.open();
  const finished = await dispatch(context, 'studymate_task_wait', { id: 'export-1', timeoutMs: 2000 },
    { agent: { id: 'session-A' } });
  assert.equal(finished.settled, true);
  assert.equal(finished.task.receipt.status, '完成', '取消信号之后它跑完了：如实报完成，产物保留');

  const destroyed = await dispatch(context, 'studymate_task_destroy', { id: 'export-1' }, { agent: { id: 'session-A' } });
  assert.deepEqual(destroyed.recordFiles, [path.join(tasks.taskService().dir, 'export-1.json')]);
  await assertOutput(context.definitions.get('studymate_task_destroy'), destroyed);
  await tasks.taskService().flushDeletions();

  // resume 只认被打断的：这一个不是
  await assert.rejects(
    () => dispatch(context, 'studymate_task_resume', { id: 'export-1' }, { agent: { id: 'session-A' } }),
    /TASK_NOT_FOUND/,
  );
});

test('工具面：resume 的输出过契约（用一份「盘上被打断」的记录）', async (t) => {
  const home = useHome(t);
  // 先把「上一个进程留下的、还写着运行中的」记录摆进台账，再让插件注册（等价于 DSH 重开时读盘）
  const dir = tasks.tasksDir(home.dshHome);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'export-7.json'), `${JSON.stringify({
    version: 1, id: 'export-7', kind: '导出', prefix: 'export', label: '上次没跑完的导出',
    owner: 'session-A', durable: true, status: '运行', attempt: 1,
    progress: { line: '3/7 科目', done: 3, total: 7 },
    artifacts: [{ path: '/tmp/已完成的一半.html', state: '已完成' }],
    input: null, createdAt: '2026-05-06T02:00:00.000Z', updatedAt: '2026-05-06T02:00:05.000Z',
    settledAt: null, detail: null, result: null, interrupted: false, cancelReason: null,
  }, null, 2)}\n`);

  tasks.resetTaskService();
  const context = taskContext();
  tasks.registerTaskTools(context.ctx, { registerStudyTool: tools.registerStudyTool });
  const service = tasks.taskService();

  const hold = gate();
  service.registerKind(tasks.defineTaskKind({
    kind: '导出', prefix: 'export', run: async () => { await hold.promise; return { detail: '这次跑完了' }; },
  }));

  const [loaded] = service.list('session-A');
  assert.equal(loaded.status, '失败', '重开时读到「运行中」= 上一轮的执行没了，如实记成失败');
  assert.equal(loaded.interrupted, true);
  assert.equal(loaded.attempt, 1);

  hold.open();
  const resumed = await dispatch(context, 'studymate_task_resume', { id: 'export-7' }, { agent: { id: 'session-A' } });
  assert.equal(resumed.task.attempt, 2);
  assert.equal(resumed.task.status === '排队' || resumed.task.status === '运行', true);
  assert.match(resumed.note, /attempt \+1/);
  await assertOutput(context.definitions.get('studymate_task_resume'), resumed);
  const finished = await service.wait('session-A', 'export-7', { timeoutMs: 2000 });
  assert.equal(finished.task.status, '完成');
  assert.equal(finished.task.attempt, 2);
});

/* ── 五、阅读端那条路由（画进度条用） ─────────────────────────────────── */

test('阅读端路由：GET /api/studymate/tasks，返回的板子上没有 owner', async (t) => {
  const home = useHome(t);
  tasks.resetTaskService();
  const context = taskContext();
  tasks.registerTaskTools(context.ctx, { registerStudyTool: tools.registerStudyTool });

  assert.equal(context.routes.length, 1, '路由挂在 connection 上');
  const route = context.routes[0];
  assert.equal(route.path, '/api/studymate/tasks');
  assert.equal(tasks.TASKS_PATH, route.path);
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.requestBody, 'buffered');
  assert.ok(context.effects.some((label) => label === 'studymate: 任务进度路由'));

  const hold = gate();
  const service = tasks.taskService();
  service.registerKind(tasks.defineTaskKind({
    kind: '导出', prefix: 'export',
    async run(job) {
      job.progress('5/7 科目', { done: 5, total: 7 });
      await hold.promise;
      return { detail: '七个科目都导完了', result: { subjects: 7 } };
    },
  }));
  const handle = service.start('session-A', { kind: '导出', label: '导出全部科目', durable: true });

  const response = await route.fetch(new Request(`http://127.0.0.1${route.path}`));
  assert.equal(response.status, 200);
  const board = await response.json();
  assert.match(board.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(board.tasks.length, 1);
  const [entry] = board.tasks;
  assert.equal(entry.id, 'export-1');
  assert.equal(entry.status, '运行');
  assert.deepEqual(entry.progress, { line: '5/7 科目', done: 5, total: 7, percent: 71 });
  assert.equal(entry.canCancel, true);
  // 板子上**没有** owner / 句柄：进度条不需要知道是谁起的，也就不存在「抄个 owner 伪造句柄」
  assert.deepEqual(Object.keys(entry).filter((key) => /owner|handle/i.test(key)), []);
  assert.deepEqual(Object.keys(entry).sort(), [
    'artifacts', 'attempt', 'canCancel', 'createdAt', 'durable', 'id', 'kind', 'label',
    'progress', 'status', 'updatedAt',
  ]);

  hold.open();
  await service.wait('session-A', handle, { timeoutMs: 2000 });
  const after = await (await route.fetch(new Request(`http://127.0.0.1${route.path}`))).json();
  assert.equal(after.tasks[0].status, '完成');
  assert.equal(after.tasks[0].receipt.status, '完成');
  assert.match(after.tasks[0].receipt.summary, /七个科目都导完了/);
  assert.equal(fs.existsSync(path.join(home.dshHome, 'studymate', 'tasks', 'export-1.json')), true,
    'durable 的落在这条路径上');
});
