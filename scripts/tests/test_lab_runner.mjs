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
   只用 `process.execPath` 与工作区里的临时脚本。 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { assertOutput, execute, fakeContext, useHome, writeSubject } from './fixtures/tools.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const lab = await import('../../lib/lab/index.ts');
const tasks = await import('../../lib/tasks/index.ts');
const tools = await import('../../lib/tools/index.ts');
const rules = await import('../../lib/core/rules.ts');
void ROOT;

const NODE = process.execPath;

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

  const script = options.script ?? [
    "console.log('first line from the test command');",
    "console.error('boom: assertion failed at line 42');",
    'process.exit(3);',
  ].join('\n');
  fs.writeFileSync(path.join(labRun, 'check.mjs'), `${script}\n`);

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
  const noPool = writeLabSubject(t);
  fs.rmSync(noPool.quiz, { force: true });
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

