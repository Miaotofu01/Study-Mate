/* StudyMate · 实验域（`lib/lab/**`）—— 判分三轨的第三轨（issue #77）
   ────────────────────────────────────────────────────────────────────────
   这条套件要证明的六件事（每一条对应 ticket 的一条验收）：

     1. **真实的测试命令被跑起来，真实输出（含失败与报错原文）原样进作答数据**：
        夹具里现造一个会 `console.log` + `console.error` + `process.exit(3)` 的脚本，
        跑完断言 `attempts/*.json` 里那条 `跑.stdout` / `跑.stderr` / `跑.退出码`
        逐字等于脚本真的吐出来的东西（不是我们编的、也不是加工过的）。
     2. **跑得久时有进度可查、可取消；取消说清哪些产物会保留**：跑一条长命令，
        中途从任务域查进度、调 `studymate_task_cancel`，断言回执里有 kept/discarded 与那句
        「保留什么」，而且**半路被杀的那次也照样落盘**（有退出码或信号 + 半个输出）。
     3. **通过与否不由模型判断**：断言工具的输出契约里**没有**任何 `通过` / `passed` /
        `成功` / `失败` 字段；`退出码` 是数字；`对` 永远是 false；渲染出来的文本里
        只有事实 + 那句「自评由你自己选」。这一条是**反向**断言：加一个判定字段就红。
     4. **越界路径与未声明的写一律拒绝**：反证四组——cwd 指到 lab 外面、可写路径指到
        lab 外面、命令参数里的绝对路径指到工作区外面、软链指到外面。四组都必须**拒**
        （`状态: 拒了` + 一句能照着改的话），而且**一次都不许 spawn**（用哨兵断言）。
     5. **命令只能从题目里来**：没有题库 / 题型不是交付物 / 交付物题没写 `证据` / 未知题号，
        四种都必须拒。模型与学生都没有「自己写一条命令」的入口。
     6. **题目类型能表达「交付物」**：一道 `kind: 交付物` 且带 `交付物`/`证据` 的题
        能被读出来并跑起来（必备字段的来源是 `lib/core/rules.ts` 的
        `QUESTION_KIND_SHAPES['交付物']`，这里再对一次账，防止两边漂开）。

   夹具（临时 HOME/工作区、假 ctx）在 `scripts/tests/fixtures/tools.mjs`；数据现造、跑完即弃
   （ADR-0009：仓库里不存样例数据）。跑命令这类测试**不依赖网络、不依赖仓库外的路径**，
   只用 Node 解释器（`process.execPath`；路径有空白时退回 PATH 上的 `node`，
   没有则统一用正斜杠）与工作区里的临时脚本。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assertOutput, execute, fakeContext, useHome, writeSubject } from './fixtures/tools.mjs';
import { COPY_ALL } from './fixtures/copy.mjs';
import { removeFile, removeTree } from './fixtures/fs-rm.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const lab = await import('../../lib/lab/index.ts');
const tasks = await import('../../lib/tasks/index.ts');
const tools = await import('../../lib/tools/index.ts');
const rules = await import('../../lib/core/rules.ts');
void ROOT;

// 命令文法按空白切词，引号与反斜杠都在拒绝字符里（lib/lab/contract.ts）。所以
// `process.execPath` 不能原样进「证据」：Windows 安装路径既有空格又有反斜杠，整条命令
// 会先被文法层拒掉。路径里有空白就退回 PATH 上的 `node`（不保证与 execPath 是同一
// 安装，但 npm test 的 PATH 上通常有）；没有空白则统一换成正斜杠绝对路径，
// Linux/macOS 原样不动。
const NODE = /\s/.test(process.execPath) ? 'node' : process.execPath.replaceAll('\\', '/');

/* ── 夹具：一个科目 + 一次实验 + 一道交付物题 ──────────────────────────── */

/**
 * 造一份「有实验目录、有交付物题」的工作区。
 *
 * 交付物题的 `证据` 字段就是那条命令——本票的**唯一**命令来源。默认写一条会失败的命令
 * （退出码 3 + stderr 有原文），因为验收要的正是「含失败与报错原文」。
 */
function writeLabSubject(t, options = {}) {
  const { workspace } = useHome(t);
  const { dir } = writeSubject(workspace, options.slug ?? 'demo', {
    nodes: options.nodes ?? [{ id: 'var', title: '变量' }, { id: 'fn', title: '函数', prerequisites: ['var'] }],
  });
  const labRun = path.join(dir, 'lab', '0001-var');
  fs.mkdirSync(labRun, { recursive: true });

  // `script: null` = 这一课不摆跑手夹具那份 `check.mjs`（#197 的骨架自带 `check.sh`）
  if (options.script !== null) {
    const script = options.script ?? [
      "console.log('first line from the test command');",
      "console.error('boom: assertion failed at line 42');",
      'process.exit(3);',
    ].join('\n');
    fs.writeFileSync(path.join(labRun, 'check.mjs'), `${script}\n`);
  }

  const evidence = options.evidence ?? `${quote(NODE)} check.mjs`;
  const item = options.item ?? {
    kind: '交付物', q: '写一个能跑的脚本', 交付物: 'check.mjs', 证据: evidence,
  };
  fs.writeFileSync(path.join(dir, 'lessons', '0001-var.quiz.json'),
    `${JSON.stringify(options.pool ?? { 什么是变量: [item] }, null, 2)}\n`);
  return { workspace, dir, labRun, quiz: path.join(dir, 'lessons', '0001-var.quiz.json'), question: options.question ?? '什么是变量#0' };
}

/** 命令里带空格/引号的路径要原样进 `证据` 字符串；这里只做「路径本身没有空白」时的裸写。 */
function quote(target) {
  return /\s/.test(target) ? `"${target}"` : target;
}

/** 注册实验域 + 任务域，返回能 `execute` 的上下文（与生产同一个注册点姿势）。 */
function labContext() {
  const ctx = fakeContext();
  tools.registerStudyMate(ctx.ctx);
  return ctx;
}

function attemptFile(dir, name = '0001-var.json') {
  return path.join(dir, 'attempts', name);
}

function readAttempt(dir) {
  return JSON.parse(fs.readFileSync(attemptFile(dir), 'utf8'));
}

/** 直接改那道题的 `证据` 字段——命令的**唯一**来源，所以反证也从这个字段下手。 */
function writeEvidence(quiz, evidence) {
  fs.writeFileSync(quiz, `${JSON.stringify({
    什么是变量: [{ kind: '交付物', q: '写一个能跑的脚本', 交付物: 'check.mjs', 证据: evidence }],
  }, null, 2)}\n`);
}

/* ── 一、真命令、真输出、原样进作答数据 ───────────────────────────────── */

test('真跑一条会失败的命令：退出码 3 与 stdout/stderr 原文逐字进作答数据', async (t) => {
  const { dir, labRun } = writeLabSubject(t);
  const ctx = labContext();

  const out = await execute(ctx, 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });

  assert.equal(out.状态, '跑完了', JSON.stringify(out.拒 ?? {}, null, 2));
  assert.equal(out.命令来源, '题目「什么是变量#0」的「证据」字段');
  // 退出码**如实记**：3 就是 3，不是「失败」，更不是布尔
  assert.equal(out.跑.退出码, 3);
  assert.equal(out.跑.结局, '跑完');
  assert.equal(out.跑.cwd, labRun) /* 落脚点就是那一课的实验目录 */;
  assert.equal(out.跑.stdout, 'first line from the test command\n');
  assert.equal(out.跑.stderr, 'boom: assertion failed at line 42\n');
  assert.deepEqual(out.跑.截断, { stdout: false, stderr: false });
  assert.deepEqual(out.跑.字节, { stdout: 'first line from the test command\n'.length, stderr: 'boom: assertion failed at line 42\n'.length });
  assert.equal(out.跑.起不来, '');

  // 落盘的那一份：作答数据里的 `跑` 与工具返回的**逐字相同**（原始输出不经二次加工）
  const data = readAttempt(dir);
  assert.equal(data.节点, 'var');
  const entry = data.题['什么是变量#0'];
  assert.ok(entry, '题 id 的键必须是 <锚点文本>#<题号>');
  const last = entry.上次结果;
  assert.equal(last.对, false, '代跑不产生「对」——通过与否不由这一层判');
  assert.equal(last.选, null);
  assert.deepEqual(last.跑, out.跑);
  assert.equal(last.跑.stdout, 'first line from the test command\n');
  assert.equal(last.跑.stderr, 'boom: assertion failed at line 42\n');
  assert.equal(last.跑.退出码, 3);
  // 幂等键进文件：跨进程对账要用（内存台账重启即失）
  assert.match(data.幂等键, /^lab-lab-\d+-\d+$/);
});

test('命令真的在这个目录里跑了（脚本写了文件，文件就在实验目录里）', async (t) => {
  const { dir, labRun } = writeLabSubject(t, {
    script: [
      "import fs from 'node:fs';",
      "fs.writeFileSync('result.txt', 'written by the test command');",
      "console.log('done');",
    ].join('\n'),
  });
  const ctx = labContext();
  const out = await execute(ctx, 'studymate_lab_run', {
    subject: 'demo', node: 'var', question: '什么是变量#0', writable: ['result.txt'],
  });
  assert.equal(out.状态, '跑完了');
  assert.equal(out.跑.退出码, 0);
  assert.deepEqual(out.跑.可写, [{ 声明: 'result.txt', 路径: path.join(labRun, 'result.txt') }]);
  // 「真的跑了」的证据不是退出码，而是**它留下的东西**
  assert.equal(fs.readFileSync(path.join(labRun, 'result.txt'), 'utf8'), 'written by the test command');
  assert.equal(readAttempt(dir).题['什么是变量#0'].上次结果.跑.退出码, 0);
});

test('课程与题库一个字节都不动（ADR-0007：作答绝不写回 .quiz.json）', async (t) => {
  const { dir } = writeLabSubject(t);
  const quiz = path.join(dir, 'lessons', '0001-var.quiz.json');
  const lesson = path.join(dir, 'lessons', '0001-var.md');
  const beforeQuiz = fs.readFileSync(quiz, 'utf8');
  const beforeLesson = fs.readFileSync(lesson, 'utf8');
  await execute(labContext(), 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  assert.equal(fs.readFileSync(quiz, 'utf8'), beforeQuiz);
  assert.equal(fs.readFileSync(lesson, 'utf8'), beforeLesson);
  assert.ok(fs.existsSync(attemptFile(dir)), '作答数据写进 attempts/，不是写回题库');
});

test('输出超上限时头尾都留、中间截掉，并且如实说「截了」', async (t) => {
  const { dir } = writeLabSubject(t, {
    script: [
      `process.stdout.write('HEAD-MARKER\\n');`,
      "process.stdout.write('x'.repeat(200 * 1024));",
      `process.stdout.write('\\nTAIL-MARKER\\n');`,
    ].join('\n'),
  });
  const out = await execute(labContext(), 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  assert.equal(out.状态, '跑完了');
  assert.equal(out.跑.截断.stdout, true);
  assert.ok(out.跑.字节.stdout > 200 * 1024, '字节数是原始字节数，不是截断后的');
  assert.ok(out.跑.stdout.startsWith('HEAD-MARKER'), '开头留着——开头那句往往就是关键报错');
  assert.ok(out.跑.stdout.includes('TAIL-MARKER'), '结尾也留着');
  assert.ok(out.跑.stdout.includes('输出太长，中间省略'), '截断本身要如实写在里面');
  // 灌不进作答数据：落盘那一份也是同一个上限
  const data = readAttempt(dir);
  assert.ok(Buffer.byteLength(JSON.stringify(data)) < 300 * 1024);
});

/* ── 二、进度可查、可取消，取消说清保留什么 ───────────────────────────── */

test('长命令：进度可查；取消回执说清保留什么；半路被杀也照样落盘', async (t) => {
  const marker = 'started.marker';
  const { dir, labRun, quiz } = writeLabSubject(t, {
    script: [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'I am running');`,
      `process.stdout.write('started\\n');`,
      'setTimeout(() => {}, 60_000);   // 等取消信号；这个回调永远不会跑到',
    ].join('\n'),
    // 记一个题号在同一份题库上：下面写进度用的还是这道题
  });
  void quiz;
  const ctx = labContext();
  const service = tasks.taskService();
  // 每次跑一个新的服务实例会让「上一次跑的任务」串味；这条套件里所有用例共用单例，
  // 所以按 id 精确定位自己那一个（工具返回的 id）。
  lab.resetRunLedger();
  // 这一次要验的是「超时之后把句柄交回来」，所以把内联等待压到 1.2 秒——
  // 真等默认那 25 秒只会让门禁慢得没人愿意跑（这个缝只给测试开，见 inlineWaitMs 的注释）。
  process.env.STUDYMATE_LAB_INLINE_WAIT_MS = '1200';
  t.after(() => { delete process.env.STUDYMATE_LAB_INLINE_WAIT_MS; });

  const running = execute(ctx, 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });

  // 等命令真的起来（脚本自己留的标记文件），再看进度——这才是「跑得久时有进度可查」
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(path.join(labRun, marker)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(path.join(labRun, marker)), '命令要在实验目录里真的跑起来');

  // 这一次工具调用会内联等 25 秒；命令要跑 60 秒，所以它一定带着句柄回来
  const out = await running;
  assert.equal(out.状态, '还在跑', JSON.stringify(out).slice(0, 400));
  const id = out.任务.id;
  const live = service.status(tasks.UNOWNED, id);
  assert.ok(['排队', '运行', '取消中'].includes(live.status), `实际：${live.status}`);
  assert.ok(live.progress && live.progress.line.length > 0, '进度要可查（阅读端画进度条看的就是它）');
  assert.match(live.progress.line, /已跑|已结束/);
  assert.ok(service.board().some((one) => one.id === id), '阅读端那条路由看的就是这块板子');

  const receipt = service.cancel(tasks.UNOWNED, id, '测试：取消一次代跑');
  assert.equal(receipt.requested, true, '这次真的发出了取消请求');
  assert.ok(Array.isArray(receipt.kept), '回执要说清保留什么');
  assert.ok(Array.isArray(receipt.discarded));
  assert.match(receipt.note, /保留/, `取消回执里要有一句「哪些产物会保留」：${receipt.note}`);

  const waited = await service.wait(tasks.UNOWNED, id, { timeoutMs: 20_000 });
  assert.equal(waited.settled, true, '取消之后要真的收尾，不能吊着');
  assert.equal(waited.task.status, '完成', '命令确实跑过了：终态是完成（取消信号送到了，事实仍然成立）');

  // 半路被杀也照样落盘：有信号或退出码，还有被杀之前已经吐出来的那一段
  const facts = readAttempt(dir).题['什么是变量#0'].上次结果.跑;
  assert.equal(facts.结局, '取消');
  assert.equal(facts.stdout, 'started\n', '被杀之前已经吐出来的那一段留着');
  assert.ok(facts.信号 !== '' || facts.退出码 !== null, '被杀要有信号或退出码，不能什么都没有');
  assert.ok(facts.毫秒 >= 0);
  // 落盘那一份和台账那一份是同一份事实
  assert.deepEqual(lab.runLedger().get(id).facts.stdout, 'started\n');
});

test('命令跑得比等待上限短时，这一次调用就把事实带回来（不必再等一轮）', async (t) => {
  writeLabSubject(t);
  const out = await execute(labContext(), 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  assert.equal(out.状态, '跑完了');
  assert.equal(out.任务.status, '完成');
  assert.equal(out.跑.毫秒 >= 0, true);
});

/* ── 三、通过与否不由模型判断 ─────────────────────────────────────────── */

test('输出契约里没有任何判定字段：没有 通过 / passed / 成功 / 失败 / 对错', () => {
  const spec = lab.labRunTool(tasks.taskService());
  const text = JSON.stringify(spec.output.schema);
  for (const forbidden of ['通过', 'passed', 'pass', '成功', '失败', 'verdict', 'correct', 'score', '得分']) {
    assert.ok(!text.includes(forbidden), `输出契约里不许出现「${forbidden}」：判分三轨里没有一轨叫 agent`);
  }
  // 事实字段要在：退出码是数字、结局只说怎么结束的
  assert.ok(text.includes('退出码'));
  assert.ok(text.includes('跑完'));
  // 输入里也没有「判定」的位置：模型不能替学生宣布「你会了」
  const params = JSON.stringify(spec.parameters);
  for (const forbidden of ['通过', 'passed', 'verdict']) {
    assert.ok(!params.includes(forbidden), `参数里不许有「${forbidden}」`);
  }
});

test('渲染出来的文本只有事实 + 「自评由你自己选」，没有一句模型结论', async (t) => {
  writeLabSubject(t);
  const spec = lab.labRunTool(tasks.taskService());
  const out = await execute(labContext(), 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  const rendered = spec.output.render({}, out).map((block) => block.text).join('\n');
  assert.ok(rendered.includes('退出码：3'), '退出码要原样出现');
  assert.ok(rendered.includes('boom: assertion failed at line 42'), '报错原文要原样出现');
  assert.ok(rendered.includes('通过与否不在这一层'), '要说清这一层不判通过');
  for (const forbidden of ['这道题通过了', '你没通过', '判定为', '算你过']) {
    assert.ok(!rendered.includes(forbidden), `渲染里不许有「${forbidden}」`);
  }
});

test('`对` 永远是 false、`自评` 只在学生自己给了档位时才写', async (t) => {
  const { dir } = writeLabSubject(t);
  await execute(labContext(), 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  const first = readAttempt(dir).题['什么是变量#0'].上次结果;
  assert.equal(first.对, false);
  assert.equal('自评' in first, false, '学生没自评就不许替学生填一个');

  // 学生自己在页面上选了档位之后再跑：自评跟着落盘，但 `对` 仍然不由这一层判
  const again = await execute(labContext(), 'studymate_lab_run', {
    subject: 'demo', node: 'var', question: '什么是变量#0', selfAssessment: '答了一半',
  });
  assert.equal(again.状态, '跑完了');
  const history = readAttempt(dir).题['什么是变量#0'].作答历史;
  const withSelf = history.filter((one) => one.自评 === '答了一半');
  assert.equal(withSelf.length, 1, '学生给的那一档要如实落盘');
  assert.ok(history.every((one) => one.对 === false));
});

/* ── 四、越界路径与未声明的写：一律拒绝（反证） ───────────────────────── */

/** 一个「谁 spawn 谁就留下痕迹」的哨兵：被拒的那几次一次都不许跑到 spawn。 */
function spawnSentinel(t) {
  // 命令合不合法无所谓：被拒的路径根本不该走到 spawn。这里用一个**一定起不来**的程序名，
  // 万一真走到了 spawn，`起不来` 会是非空的，断言就能看出来。
  return writeLabSubject(t, { evidence: 'studymate-not-a-real-program-xyz check.mjs' });
}

test('反证：cwd 指到实验目录外面 —— 拒，且一次都不 spawn', async (t) => {
  const { dir, labRun } = spawnSentinel(t);
  const ctx = labContext();
  for (const cwd of ['..', '../..', '../../../../etc', path.join(dir, 'lessons')]) {
    const out = await execute(ctx, 'studymate_lab_run', {
      subject: 'demo', node: 'var', question: '什么是变量#0', cwd,
    });
    assert.equal(out.状态, '拒了', `cwd=${cwd} 应当被拒`);
    assert.ok(out.拒.为什么.length > 10, '拒要有一句能照着改的话');
    assert.equal(out.跑, null, '拒了就没有任何跑的事实');
    assert.ok((out.拒.边界 ?? '').includes(path.basename(labRun)), '要说清允许的范围是哪个目录');
  }
  assert.equal(fs.existsSync(path.join(labRun, 'attempts')), false, '拒了就不许写作答数据');
});

test('反证：可写路径指到实验目录外面 —— 拒（含绝对路径与 `..`）', async (t) => {
  const { workspace } = spawnSentinel(t);
  const ctx = labContext();
  for (const writable of [['../outside.txt'], ['../../../../tmp/evil.txt'], [path.join(workspace, 'evil.txt')]]) {
    const out = await execute(ctx, 'studymate_lab_run', {
      subject: 'demo', node: 'var', question: '什么是变量#0', writable,
    });
    assert.equal(out.状态, '拒了', `writable=${JSON.stringify(writable)} 应当被拒`);
    assert.equal(out.跑, null);
  }
});

test('反证：命令参数里的路径跑出工作区 —— 拒；工作区之内的相对路径照常放行', async (t) => {
  // 工作区是 `<临时目录>/学习资料`，实验目录在它下面六层（.learning/subjects/<slug>/lab/<NNNN-短名>）。
  // 从实验目录数上去：五层回到工作区（工作区之内，应当放行），七层就出了工作区（应当拒）。
  // 所以判据是**归一化之后的包含关系**，不是「看见 .. 就拒」——逐字符查 `..` 既会漏掉
  // `a/../..` 这种写法，也会误伤正常命令。
  const { quiz, labRun } = spawnSentinel(t);
  fs.writeFileSync(path.join(labRun, 'input.txt'), 'lab 里的东西\n');
  const ctx = labContext();

  // 反证一：绝对路径指到工作区外面
  writeEvidence(quiz, `${quote(NODE)} /etc/hostname`);
  let out = await execute(ctx, 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  assert.equal(out.状态, '拒了', '绝对路径出了工作区必须拒');
  assert.match(out.拒.为什么, /工作区/);
  assert.match(out.拒.边界, /^允许的范围：/, '拒的时候要说清边界在哪');

  // 反证二：相对路径里 `..` 太多，归一化之后出了工作区
  writeEvidence(quiz, `${quote(NODE)} ${'../'.repeat(7)}etc/hostname`);
  out = await execute(ctx, 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  assert.equal(out.状态, '拒了', '`..` 走不到工作区外面去');
  assert.match(out.拒.为什么, /工作区/);

  // 正向对照：工作区之内的相对路径照常跑（guard 不是「一律拒」）
  writeEvidence(quiz, `${quote(NODE)} -e "process.stdout.write(require('node:fs').readFileSync('input.txt','utf8'))"`);
  out = await execute(ctx, 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  // 这条命令带引号（shell 语法），所以它**应该**被文法层拒——这本身也是正向证据
  assert.equal(out.状态, '拒了');
  assert.match(out.拒.为什么, /shell|空白切词/);
});

test('`~` 不展开：拒绝解释它（不解释就不会指错地方）', async (t) => {
  const { quiz } = spawnSentinel(t);
  writeEvidence(quiz, `${quote(NODE)} ~/.ssh/id_rsa`);
  const out = await execute(labContext(), 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  // `~` 要靠 shell 或调用方替它展开——两者我们都不做，所以它落在**文法**层就被拒了。
  // 这一条是刻意的：`~` 对学生来说就是「家目录」，留着它只会让人以为命令跑到了家里。
  assert.equal(out.状态, '拒了');
  assert.match(out.拒.为什么, /shell|空白切词/);
});

/* ── 五、命令只能从题目里来 ───────────────────────────────────────────── */

test('反证：没有题库 / 题型不对 / 证据为空 / 题号不存在 —— 四种都拒', async (t) => {
  const ctx = labContext();
  // 没有题库文件（夹具默认会给一份，这里删掉那份——「没有题库」是这一组的第一个反证）
  // 用 removeFile 而不是 fs.rmSync：工作区在 `学习资料/` 这种非 ASCII 目录下，Node 24 的
  // rmSync 会**静默不删**（返回成功，文件还在），这一组反证就变成了「题库还在，命令照跑」。
  const noPool = writeLabSubject(t);
  removeFile(noPool.quiz);
  let out = await execute(ctx, 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  assert.equal(out.状态, '拒了');
  assert.match(out.拒.为什么, /题库/);
  assert.equal(fs.existsSync(path.join(noPool.dir, 'attempts')), false);

  // 题型不是交付物（客观题）
  fs.writeFileSync(noPool.quiz, `${JSON.stringify({
    什么是变量: [{ kind: '客观题', q: '选一个', opts: ['a', 'b'], ans: 0, why: '因为' }],
  }, null, 2)}\n`);
  out = await execute(ctx, 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  assert.equal(out.状态, '拒了');
  assert.match(out.拒.为什么, /不是「交付物」/);

  // 交付物题但「证据」是空的
  fs.writeFileSync(noPool.quiz, `${JSON.stringify({
    什么是变量: [{ kind: '交付物', q: '写一个能跑的脚本', 交付物: 'check.mjs', 证据: '  ' }],
  }, null, 2)}\n`);
  out = await execute(ctx, 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  assert.equal(out.状态, '拒了');
  assert.match(out.拒.为什么, /「证据」是空的/);

  // 题号不存在
  fs.writeFileSync(noPool.quiz, `${JSON.stringify({
    什么是变量: [{ kind: '交付物', q: '写一个能跑的脚本', 交付物: 'check.mjs', 证据: `${quote(NODE)} check.mjs` }],
  }, null, 2)}\n`);
  out = await execute(ctx, 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#7' });
  assert.equal(out.状态, '拒了');
  assert.match(out.拒.为什么, /第 8 道题|没有第/);
  // 题 id 写法不对
  out = await execute(ctx, 'studymate_lab_run', { subject: 'demo', node: 'var', question: '没有井号' });
  assert.equal(out.状态, '拒了');
  assert.match(out.拒.为什么, /锚点与题号/);
});

test('科目不存在 / 没有工作区：拒（一句能照着改的话，不是穿出来的异常）', async (t) => {
  writeLabSubject(t);
  const ctx = labContext();
  const out = await execute(ctx, 'studymate_lab_run', {
    subject: '根本没有这个科目', node: 'var', question: '什么是变量#0',
  });
  assert.equal(out.状态, '拒了');
  assert.match(out.拒.为什么, /读不到科目/);
  assert.match(out.拒.为什么, /不是一个目录/);

  // 没有工作区的组合：同一句拒绝的另一个来源
  const bare = useHome(t, { withWorkspace: false });
  void bare;
  const out2 = await execute(labContext(), 'studymate_lab_run', {
    subject: 'demo', node: 'var', question: '什么是变量#0',
  });
  assert.equal(out2.状态, '拒了');
  assert.match(out2.拒.为什么, /读不到科目/);
});

test('没有实验目录的节点：拒（概念课本来就产不出交付物）', async (t) => {
  const { workspace } = useHome(t);
  const { dir } = writeSubject(workspace, 'demo', {
    nodes: [{ id: 'var', title: '变量' }, { id: 'fn', title: '函数' }],
  });
  fs.mkdirSync(path.join(dir, 'lab', '0001-var'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lessons', '0002-fn.quiz.json'), `${JSON.stringify({
    什么是函数: [{ kind: '交付物', q: 'x', 交付物: 'y', 证据: `${quote(NODE)} -e 0` }],
  }, null, 2)}\n`);
  const out = await execute(labContext(), 'studymate_lab_run', { subject: 'demo', node: 'fn', question: '什么是函数#0' });
  assert.equal(out.状态, '拒了');
  assert.match(out.拒.为什么, /lab 实验目录/);
});

test('程序名不在 PATH 上：如实记「起不来」，不当成拒绝、也不当成失败', async (t) => {
  const { dir } = writeLabSubject(t, { evidence: 'studymate-not-a-real-program-xyz check.mjs' });
  const out = await execute(labContext(), 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  assert.equal(out.状态, '跑完了', '命令确实跑了一次——只是没起来');
  assert.equal(out.跑.结局, '起不来');
  assert.match(out.跑.起不来, /ENOENT|not found/i);
  assert.equal(out.跑.程序, '', '没解析到程序就是空串，不编一个');
  // 事实照样落盘（否则「起不来」这件事就没有痕迹）
  assert.equal(readAttempt(dir).题['什么是变量#0'].上次结果.跑.结局, '起不来');
});

/* ── 六、交付物题型与字段 ─────────────────────────────────────────────── */

test('交付物题的必备字段就是 lib/core/rules.ts 里那份（两边不许漂）', () => {
  assert.deepEqual([...rules.QUESTION_KIND_SHAPES['交付物'].required], ['交付物', '证据']);
  assert.equal(rules.QUESTION_RULES['交付物'].grading, 'Host 半代跑');
  assert.deepEqual([...rules.QUESTION_RULES['交付物'].layers], ['造出']);
  // 判分三轨的词表：没有任何一轨叫 agent
  const tracks = new Set(Object.values(rules.QUESTION_RULES).map((rule) => rule.grading));
  assert.deepEqual([...tracks].sort(), ['Host 半代跑', '学生自评', '阅读端即时判'].sort());
});

test('readDeliverable 是纯函数：命令只从「证据」来，题面里的话不算数', () => {
  const pool = {
    锚点: [
      { kind: '交付物', q: '跑 node fake.mjs', 交付物: 'fake.mjs', 证据: 'node real.mjs' },
    ],
  };
  const read = lab.readDeliverable(pool, '锚点#0');
  assert.ok(!('code' in read));
  assert.equal(read.command, 'node real.mjs', '命令取「证据」，不取题面里的那句话');
  assert.equal(read.id, '锚点#0');
});

test('splitQuestionId：题 id 的写法与阅读端、作答数据一致', () => {
  assert.deepEqual(lab.splitQuestionId('什么是变量#0'), { anchor: '什么是变量', index: 0 });
  // 锚点里本来就有 `#` 的：按**最后一个** `#` 切
  assert.deepEqual(lab.splitQuestionId('a#b#2'), { anchor: 'a#b', index: 2 });
  // 锚点空、题号不是十进制非负整数，一律读不出来 —— 读不出来就拒（命令没有第二个来源）
  for (const bad of ['没有井号', '#0', '锚点#', '锚点#x', '锚点#-1', '锚点#1.5', '', 42, null]) {
    assert.equal(lab.splitQuestionId(bad), null, `${JSON.stringify(bad)} 不该读得出题号`);
  }
});

/* ── 七、注册与输出契约 ───────────────────────────────────────────────── */

test('注册点上真的挂上了 studymate_lab_run，输出契约过纯函数校验器', async (t) => {
  writeLabSubject(t);
  const ctx = labContext();
  const definition = ctx.definitions.get('studymate_lab_run');
  assert.ok(definition, '注册点上有这一个工具');
  const out = await execute(ctx, 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  await assertOutput(assert, definition, out);
  // 拒绝那一支也要过契约
  const refused = await execute(ctx, 'studymate_lab_run', { subject: 'demo', node: 'var', question: '写的不是题号' });
  assert.equal(refused.状态, '拒了');
  await assertOutput(assert, definition, refused);
});

test('任务域登记了「实验代跑」这一种类型（长命令走的就是它）', async (t) => {
  writeLabSubject(t);
  labContext();
  const kinds = tasks.taskService().kinds();
  assert.ok(kinds.includes(lab.LAB_TASK_KIND), `已登记：${kinds.join('、')}`);
  assert.equal(lab.LAB_TASK_PREFIX, 'lab');
});

test('registerLabTools 导出形状：注册点只加一行就能挂上', () => {
  assert.equal(typeof lab.registerLabTools, 'function');
  const ctx = fakeContext();
  lab.registerLabTools(ctx.ctx, { registerStudyTool: tools.registerStudyTool });
  assert.deepEqual([...ctx.definitions.keys()], [...lab.LAB_TOOL_NAMES]);
});

test('台账落在 DSH_HOME 下、每次跑都写一份（跨进程对账要用）', async (t) => {
  const { dir } = writeLabSubject(t);
  lab.resetRunLedger();
  const out = await execute(labContext(), 'studymate_lab_run', { subject: 'demo', node: 'var', question: '什么是变量#0' });
  const ledger = lab.runLedger();
  const entry = ledger.get(out.任务.id);
  assert.ok(entry, '台账里要有这一条');
  assert.equal(entry.subject, 'demo');
  assert.equal(entry.node, 'var');
  assert.equal(entry.written, true);
  assert.equal(entry.commandFrom, '题目「什么是变量#0」的「证据」字段');
  const onDisk = JSON.parse(fs.readFileSync(path.join(ledger.dir, `${out.任务.id}.json`), 'utf8'));
  assert.deepEqual(onDisk.facts.stdout, 'first line from the test command\n');
  assert.deepEqual(ledger.problems(), []);
  void dir;
});


/* ── 结构对齐：LabToolSpec 是手抄的，抄的那份不许漂 ────────────────────────
   `lib/lab/tools.ts` 的 `LabToolSpec` 是 `lib/tools/define.ts` 的 `StudyToolSpec` 的
   **手抄副本**——实验域不许 import 工具域（域图会成环），所以只能抄。而抄件的两边都
   没有东西钉着：`registerLabTools` 里那句 `as unknown as` 把类型不符也一起咽下去了，
   `grep 'StudyToolSpec|LabToolSpec' scripts/tests/*.mjs` 当时零命中。

   于是这里补一条：把两份接口的**顶层键与可选性**从源码里读出来对账，并把运行期真的造出来
   的那个对象也拿来数键。改一边不改另一边就红——三种红法都验过（见下面的反证用例）。 */

/** 从一份源码里读一个接口的顶层成员：`键 → 是否可选`。只认缩进恰好两格的成员，
 *  所以嵌套对象（`output: { schema…; render… }`）里的键不会被误当成顶层键。 */
function interfaceMembers(source, name) {
  const head = new RegExp(`export interface ${name} \\{`);
  const start = source.search(head);
  assert.notEqual(start, -1, `源码里找不到 export interface ${name}`);
  const body = source.slice(start).split('\n').slice(1);
  const members = new Map();
  for (const line of body) {
    if (line.startsWith('}')) break;                     // 接口结束
    const match = /^ {2}([A-Za-z_$][\w$]*)(\??):/.exec(line);
    if (match) members.set(match[1], match[2] === '?');
  }
  assert.ok(members.size >= 5, `${name} 只读出 ${members.size} 个成员，解析器或排版变了`);
  return members;
}

function specMembers() {
  return {
    study: interfaceMembers(fs.readFileSync(path.join(ROOT, 'lib', 'tools', 'define.ts'), 'utf8'), 'StudyToolSpec'),
    lab: interfaceMembers(fs.readFileSync(path.join(ROOT, 'lib', 'lab', 'tools.ts'), 'utf8'), 'LabToolSpec'),
  };
}

/** 对账：返回违规清单（空数组 = 对齐）。抽出来是为了能用**合成的一对**验判据不空转。 */
function specMismatches(study, lab) {
  const problems = [];
  for (const key of lab.keys()) {
    if (!study.has(key)) problems.push(`LabToolSpec 多了 StudyToolSpec 没有的键「${key}」：注册时会以类型不符被咽下去`);
  }
  for (const [key, optional] of study) {
    if (!optional && !lab.has(key)) problems.push(`StudyToolSpec 的必填键「${key}」不在 LabToolSpec 里：实验工具会缺这一格`);
  }
  return problems;
}

test('LabToolSpec 与 StudyToolSpec 结构对齐：手抄的那份键集合与可选性都对得上', () => {
  const { study, lab: declared } = specMembers();
  assert.deepEqual(specMismatches(study, declared), []);

  /* 运行期真的造出来的那个对象：键要与接口声明的必填键逐个相等。
     `output` 那格是对象、`execute` 是函数，都算「有值」；`requires` 两边都没写，不该冒出来。 */
  const built = lab.labRunTool(tasks.taskService());
  const required = [...declared].filter(([, optional]) => !optional).map(([key]) => key).sort();
  assert.deepEqual(Object.keys(built).sort(), required,
    'labRunTool 造出来的对象与 LabToolSpec 声明的键对不上（接口对实现撒了谎）');
});

test('反证：结构对齐判据不空转——一边漂了必须报出来', () => {
  const { study, lab: declared } = specMembers();
  // ① LabToolSpec 多一个 StudyToolSpec 没有的键
  const extra = new Map(declared);
  extra.set('凭空多出来的键', false);
  assert.match(specMismatches(study, extra).join('\n'), /多了 StudyToolSpec 没有的键/);
  // ② StudyToolSpec 多一个必填键而 LabToolSpec 没跟上
  const stricter = new Map(study);
  stricter.set('新加的必填键', false);
  assert.match(specMismatches(stricter, declared).join('\n'), /必填键「新加的必填键」不在 LabToolSpec 里/);
  // ③ 两边都少了一个键（抄件与正本同时漂，运行期的对象却不会跟着少）
  const shrunk = new Map(declared);
  shrunk.delete('execute');
  const loose = new Map(study);
  loose.delete('execute');
  assert.deepEqual(specMismatches(loose, shrunk), [], '键集合一致时判据应当放行');
  assert.notDeepEqual(Object.keys(lab.labRunTool(tasks.taskService())).sort(),
    [...shrunk].filter(([, optional]) => !optional).map(([key]) => key).sort(),
    '两边同时删掉一个键时，运行期对象与声明应当对不上——这一条就是防「一起漂」的');
});

/* ── 八、实验骨架（#197）：照抄即用，跑手仍只从「证据」字段取命令 ──────────
   骨架（`templates/lab/`）是给**出题角色**照抄的：判分入口的框架、任务／答案／探针的布局、
   lab 说明、干净态与作答态两个运行入口、只按顺序调那两个入口的自检。它**只回事实**——
   没有判决词，也没有第二套退出码语义（跑手那条「非零不是失败判决」不能被骨架写打架）。

   这一组钉六件事（骨架内容本身的清单由随包/装机那几处套件分头守住，见 fixtures/templates.mjs）：
     · 骨架照抄进科目之后，跑手认得这套布局（命令来源仍是「证据」字段）；
     · 盘上有 `check.sh` 不等于有命令——「证据」空着照样拒；
     · 入口固定叫 `check.sh`（跑手套件自己的夹具用 `check.mjs`，那是夹具，不是骨架）；
     · 干净态／作答态各有一个运行入口，两个都只摆盘 + 调 `check.sh` + 原样转述事实；
     · 骨架自检能在干净目录里把两态各跑一遍，退出码原样转述（且它自己不摆盘）；
     · 骨架文件里没有判决词、没有字面退出码；lab 骨架在模板说明表里登记过。 */

const SKELETON = path.join(ROOT, 'templates', 'lab');
const SKELETON_EXAMPLE = path.join(SKELETON, '0000-示例');

/** 骨架下全部文件的相对路径（相对 `templates/lab/`），给内容断言用。 */
function skeletonFiles() {
  const found = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else found.push(relative);
    }
  };
  walk(SKELETON);
  return found.sort();
}

/** 照抄骨架：任务目录、答案目录、lab 说明三处按「文件归属」各就各位。 */
function adoptSkeleton(dir, node = 'var') {
  const labDir = path.join(dir, 'lab');
  const runDir = path.join(labDir, `0001-${node}`);
  fs.mkdirSync(runDir, { recursive: true });
  for (const entry of fs.readdirSync(SKELETON_EXAMPLE)) {
    fs.cpSync(path.join(SKELETON_EXAMPLE, entry), path.join(runDir, entry), COPY_ALL);
  }
  fs.mkdirSync(path.join(labDir, 'solutions'), { recursive: true });
  fs.cpSync(path.join(SKELETON, 'solutions', '0000-示例'), path.join(labDir, 'solutions', `0001-${node}`),
    COPY_ALL);
  fs.copyFileSync(path.join(SKELETON, 'README.md'), path.join(labDir, 'README.md'));
  return runDir;
}

const SKELETON_ITEM = {
  kind: '交付物', q: '照骨架做出来的实验', 交付物: 'check.sh', 证据: 'sh check.sh',
};

test('骨架照抄进科目后跑手认得它：命令仍只从「证据」字段来', async (t) => {
  const { dir, labRun } = writeLabSubject(t, { script: null, item: SKELETON_ITEM });
  adoptSkeleton(dir);

  const out = await execute(labContext(), 'studymate_lab_run', {
    subject: 'demo', node: 'var', question: '什么是变量#0',
  });

  assert.equal(out.状态, '跑完了', JSON.stringify(out.拒 ?? {}, null, 2));
  assert.equal(out.命令来源, '题目「什么是变量#0」的「证据」字段', '骨架在盘上也不改命令的来源');
  assert.equal(out.跑.命令, 'sh check.sh');
  assert.equal(out.跑.cwd, labRun, '落脚点就是照抄出来的那个任务目录');
  // 跑的是骨架那一份：参数事实 + 断言自己的事实 + 它自己那次的退出码
  assert.match(out.跑.stdout, /任务目录：/);
  assert.match(out.跑.stdout, /作答目录：/);
  assert.match(out.跑.stdout, /探针 .*此刻实测 \d+ 行/);
  assert.match(out.跑.stdout, /check\.sh 退出码：\d+/);
  // 干净态：任务还留白，那一格读不到——非零是**事实**，不是判决（读成布尔才是写错了）
  assert.equal(typeof out.跑.退出码, 'number');
  assert.notEqual(out.跑.退出码, 0);
});

test('反证：盘上有骨架也不算命令来源——「证据」空着照样拒', async (t) => {
  const { dir, quiz } = writeLabSubject(t, { script: null, item: SKELETON_ITEM });
  adoptSkeleton(dir);
  writeEvidence(quiz, '   ');

  const out = await execute(labContext(), 'studymate_lab_run', {
    subject: 'demo', node: 'var', question: '什么是变量#0',
  });

  assert.equal(out.状态, '拒了');
  assert.match(out.拒.为什么, /「证据」是空的/);
  assert.equal(fs.existsSync(path.join(dir, 'attempts')), false, '拒了就不该留下作答痕迹');
});

test('骨架自检：在干净目录里把干净态与作答态各跑一遍，退出码原样转述', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-lab-skeleton-'));
  t.after(() => removeTree(directory));
  const copied = path.join(directory, 'lab');
  fs.cpSync(SKELETON, copied, COPY_ALL);

  const result = spawnSync('sh', ['自检.sh'], { cwd: copied, encoding: 'utf8', windowsHide: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, null, `自检被信号打断了：${result.signal}`);

  // 空跑也要有交代：两个状态各一行事实 + 各自的退出码（顺序固定：先干净态、后作答态）
  const codes = [...result.stdout.matchAll(/^(干净态|作答态)退出码：(\d+)$/gm)];
  assert.deepEqual(codes.map(match => match[1]), ['干净态', '作答态'],
    `自检的事实行没印全：\n${result.stdout}\n${result.stderr}`);
  assert.notEqual(Number(codes[0][2]), 0, '留白任务读不到那一格：非零正是留白有效的证据');
  assert.equal(Number(codes[1][2]), 0, '把参考解拷进任务目录后，同一份断言读到的是填好的那一格');
  // 自检自己的退出码 = 它最后一次跑的那一次，原样（没有第二套码表）
  assert.equal(result.status, Number(codes[1][2]));
  // 重跑在临时目录里做，用完就删：骨架旁边不留痕迹
  const temporary = [...result.stdout.matchAll(/^临时目录已删：(.+)$/gm)].map(match => match[1].trim());
  assert.equal(temporary.length, 2, '两态各在一个干净目录里跑，各留一行交代');
  for (const removed of temporary) assert.equal(fs.existsSync(removed), false, `${removed} 该被删掉`);
  assert.deepEqual(fs.readdirSync(copied).sort().filter(name => name.startsWith('tmp')),
    [], '临时目录不该落在骨架里面');
});

test('骨架只回事实：没有判决词，也没有字面退出码', () => {
  const files = skeletonFiles();
  assert.ok(files.length >= 11, `骨架文件太少（${files.length} 份）：判分入口、两个运行入口、断言、任务、作答、探针、答案、说明、自检都要有`);
  // 入口固定叫 check.sh（跑手套件的夹具用 check.mjs，那是夹具，别照抄它）
  assert.ok(files.includes('0000-示例/check.sh'), '判分入口要固定叫 check.sh');
  assert.equal(files.some(name => /check\.(?:mjs|js|py)$/.test(name)), false, '骨架里不该有第二个判分入口');
  assert.ok(files.includes('自检.sh'), '骨架要自带那条「在干净目录里整套重跑」的自检');
  assert.ok(files.includes('干净态.sh') && files.includes('作答态.sh'), '两态各要有一个运行入口');
  assert.ok(files.includes('solutions/0000-示例/作答/任务1.txt'), '答案要与任务分开放');
  assert.ok(files.includes('README.md'), 'lab 说明的骨架要带上');

  for (const name of files) {
    const text = fs.readFileSync(path.join(SKELETON, name), 'utf8');
    assert.doesNotMatch(text, /通过|失败|成功|不通过|passed|failed|PASS|FAIL/,
      `${name} 里出现了判决词：骨架只回事实`);
    assert.doesNotMatch(text, /exit\s+[0-9]/, `${name} 里有字面退出码：自定义码表就是从这种地方长出来的`);
  }
});

test('骨架在模板说明表里登记过（随包发出的那一份，不是某个科目的 lab）', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'templates', 'README.md'), 'utf8');
  const row = readme.split('\n').find(line => /^\|\s*`lab\/`/.test(line));
  assert.ok(row, 'templates/README.md 的表里要有 `lab/` 这一行');
  assert.match(row, /出题角色/, '这一行要写清谁来用它（出题角色造 lab 时照抄）');
  assert.match(row, /\.learning\/subjects\/<slug>\/lab\//, '这一行要写清它落到工作区的哪');
});

test('两个运行入口都在、都只调 check.sh：干净态与作答态各一个，自检只按顺序调它们', () => {
  const files = skeletonFiles();
  for (const entry of ['干净态.sh', '作答态.sh']) assert.ok(files.includes(entry), `骨架里要有 ${entry}`);

  for (const name of ['干净态.sh', '作答态.sh']) {
    const text = fs.readFileSync(path.join(SKELETON, name), 'utf8');
    // 判分入口只有一个：入口自己跑的就是 check.sh，不直接碰断言
    assert.match(text, /\bsh check\.sh\b/, `${name} 要把 check.sh 跑起来（判分入口仍只有它一个）`);
    assert.doesNotMatch(text, /断言\.sh/, `${name} 不该自己调断言：那是 check.sh 的事`);
    // 只回事实：这一次的退出码原样印出来、原样交回去（不判定、没有第二套码表）
    assert.match(text, /退出码：%d/, `${name} 要把这一次的退出码印成事实`);
    assert.match(text, /exit "\$CODE"/, `${name} 要把那个退出码原样交回去`);
    assert.doesNotMatch(text, /exit\s+[0-9]/, `${name} 不许立字面退出码`);
  }

  // 两态各自的摆盘：干净态不碰参考解；作答态自己把参考解的作答拷进去，跑完随临时副本清掉
  const clean = fs.readFileSync(path.join(SKELETON, '干净态.sh'), 'utf8');
  assert.doesNotMatch(clean, /cp -R "\$ROOT\/solutions/, '干净态不该拷参考解（任务留白就是留白）');
  const answered = fs.readFileSync(path.join(SKELETON, '作答态.sh'), 'utf8');
  assert.match(answered, /cp -R "\$ROOT\/solutions\/\$TASK\/作答\/\."/, '作答态要自己把参考解的作答摆进临时副本');
  assert.match(answered, /rm -rf "\$TMP"/, '作答态跑完要把痕迹（临时副本）清掉');

  // 自检不再自己写一遍摆盘：它只按顺序调这两个入口（一处定义）
  const selfCheck = fs.readFileSync(path.join(SKELETON, '自检.sh'), 'utf8');
  assert.match(selfCheck, /干净态\.sh/);
  assert.match(selfCheck, /作答态\.sh/);
  // 判据看**代码**：注释里解释「它自己不摆盘、不跑 check.sh」不算犯规（先去掉整行注释）
  const selfCheckCode = selfCheck.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(selfCheckCode, /mktemp|cp -R|check\.sh/, '自检里不该再有一份摆盘或判分逻辑');

  // lab 说明骨架里那两种跑法跟着入口走（角色照抄时看得见跑哪个）
  const sheet = fs.readFileSync(path.join(SKELETON, 'README.md'), 'utf8');
  for (const entry of ['干净态.sh', '作答态.sh', '自检.sh']) {
    assert.ok(sheet.includes(entry), `lab 说明骨架要写清 ${entry} 怎么用`);
  }
});

/* ── 九、运行入口的失败路径：没跑起来要说清，别报成功 ─────────────────────
   两个入口的头几件事是「找到任务目录」「建临时目录」「把整棵 lab 拷进去」。没走成的时候
   它们跑不了 `check.sh`——那时的输出只该说两件事：**卡在哪一步**、**非零退出**。
   以前不是这样：找不到任务目录那一支印完那句「任务目录不在」就 `exit`，而裸 `exit`
   取的是上一条命令（那句 `printf`）的状态，于是「这一趟没跑起来」被报成了 0。
   这一组钉的就是那条路径：非零 + 一行说清原因，而且**正常路径一个字节都不变**。 */

test('反证：没有任务目录的 lab —— 两个入口都非零退出，且印出卡在哪一步', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-lab-notask-'));
  t.after(() => removeTree(directory));
  const copied = path.join(directory, 'lab');
  fs.cpSync(SKELETON, copied, COPY_ALL);
  // 「没有任务目录」= 骨架里那个示例任务目录搬走（`solutions/` 留着——它本来就不算任务目录）
  // `0000-示例` 本身就是非 ASCII：Node 24 的 rmSync 在这里要么崩、要么静默不删，两种都让
  // 这条反证失去意义（目录还在 → 脚本当然找得到 → 断言「任务目录不在」必然红）。
  removeTree(path.join(copied, '0000-示例'));

  for (const entry of ['干净态.sh', '作答态.sh']) {
    const result = spawnSync('sh', [entry], { cwd: copied, encoding: 'utf8', windowsHide: true });
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, null, `${entry} 被信号打断了：${result.signal}`);
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, `${entry} 没跑起来却报了 0：\n${output}`);
    assert.match(output, /任务目录不在/, `${entry} 要说清卡在哪一步（找任务目录）`);
    assert.match(output, /没跑起来/, `${entry} 要印一行「这次没跑起来」的事实：\n${output}`);
    assert.doesNotMatch(output, /退出码：0/, `${entry} 没跑起来就不该有一条「跑完了」的假事实`);
    // 没跑起来就没摆盘：临时目录一个都不该留在骨架旁边
    assert.deepEqual(fs.readdirSync(copied).sort().filter(name => name.startsWith('tmp')), []);
  }
});

test('对照：任务目录在的时候两个入口照旧（失败路径的判据不是「一律非零」）', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-lab-ok-'));
  t.after(() => removeTree(directory));
  const copied = path.join(directory, 'lab');
  fs.cpSync(SKELETON, copied, COPY_ALL);

  const answered = spawnSync('sh', ['作答态.sh'], { cwd: copied, encoding: 'utf8', windowsHide: true });
  assert.equal(answered.status, 0, `作答态应当归零：\n${answered.stdout}\n${answered.stderr}`);
  assert.match(answered.stdout, /^作答态退出码：0$/m, '这一次的退出码照旧原样印出来');
  assert.match(answered.stdout, /^临时目录已删：/m, '跑完照旧把临时副本清掉');

  const clean = spawnSync('sh', ['干净态.sh'], { cwd: copied, encoding: 'utf8', windowsHide: true });
  assert.notEqual(clean.status, 0, '干净态：留白任务读不到那一格，非零正是留白有效的证据');
  assert.match(clean.stdout, /^干净态退出码：\d+$/m, '干净态也照旧把退出码印成事实');
  assert.match(clean.stdout, /^临时目录已删：/m);
});

/* ── 十、三个运行入口在「文件归属」里查得到 ───────────────────────────────
   角色的规矩是「布局以归属表为准」：要跑哪个入口、它在哪，查那张表。这三个名字此前只活在
   骨架目录与 lab 说明里，归属表 §二 只有「实操任务／实操答案／lab 说明」三行——照着查就
   查不到。这一条把「查表就有」重新钉住：名字在盘上、在表里，而且那一行写清了落到哪。 */

test('三个运行入口都在「文件归属」里登记过（查表就有，不是只在骨架里）', () => {
  const entries = ['干净态.sh', '作答态.sh', '自检.sh'];
  for (const entry of entries) {
    assert.ok(fs.existsSync(path.join(SKELETON, entry)), `骨架里没有 ${entry}——名字对不上就别指望照抄得下来`);
  }

  const doc = fs.readFileSync(path.join(ROOT, 'docs', '规范', '文件归属.md'), 'utf8');
  // §二（工作区 · 课件与素材）那一节：到 §三 为止
  const section = doc.split('## 三、')[0];
  const missing = [];
  for (const entry of entries) {
    const row = section.split('\n').find(line => /^\|/.test(line) && line.includes(entry));
    if (!row) { missing.push(`· 归属表 §二 里查不到 ${entry}`); continue; }
    if (!row.includes('<subject_path>/lab/')) missing.push(`· ${entry} 那一行没写清它落在 <subject_path>/lab/`);
  }
  assert.deepEqual(missing, [], `三个运行入口查表查不到（角色照「布局以归属表为准」办时会卡住）：\n${missing.join('\n')}`);
});
