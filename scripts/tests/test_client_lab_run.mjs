/* 验收 #77 · 交付物题的界面：只显示**事实**与学生自评，一句判决词都没有
   ────────────────────────────────────────────────────────────────────────
   ticket #77 的验收里那句「界面只显示事实与学生自评」的机器证据。三件事：

     1. **有 `跑` 的结果时，界面渲染出命令与退出码**（还有两条流、截断说明、结局）。
     2. **没有结果时不显示判决词**——没有 `跑` 的交付物题只该有一个「跑一次」的按钮；
        整棵渲染树里不许出现「通过 / 不通过 / 正确 / 错误 / 对了 / 错了」这类字样。
        （客观题那边的「对了 / 不对」是**页内即时判**那一轨的固有措辞，走题型的另一分支；
        这条套件只钉交付物题这一支。）
     3. **入口只有一个、且是学生按的**：渲染里恰好一颗 `data-proto="lab-run-button"` 的按钮，
        文案是「跑一次」；点了才发请求（onClick 调 onLabRun，而不是渲染时自己跑）。

   渲染函数在 `lib/client.js` 的工厂闭包里，靠 `client_harness.mjs` 的 React 桩调起来
   （桩不实现渲染，`viewText` 遇到函数组件就地展开）。数据**现造现弃**。

   为什么还要断言 `labFactsOf`（那个纯映射）：`viewText` 只能抠出**文本**——「退出码是数字
   原样、不是布尔判定」这件事在文本里看不出来（`退出码：1` 与 `退出码：true` 都是文本）。
   两个一起断言才叫「只显示事实」。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { clientInternals, findByProp, renderWithState } from './fixtures/client_harness.mjs';

const { LabRun, labFactsOf, LAB_ENDPOINT, Question } = clientInternals();

/**
 * 判决词：**界面自己的话**里一个都不许有（规格 §7.3：三轨里没有一轨叫 agent）。
 *
 * 判据只落在界面的标签与说明上，不落在两条流的原文里——`stderr` 是**证据**，它里面出现
 * 「错误」「FAILED」正是我们要如实显示的东西（`Failures` 由测试框架写，不是界面下的结论）。
 * 所以下面的 `uiText()` 先把「原始输出」与「界面固定文案」摘掉，再查这些词；
 * 反过来另有一条测试钉住「原始输出原样出现、没有被界面套上一个结论」。
 */
const VERDICT_WORDS = ['通过', '不通过', '正确', '错误', '对了', '错了', '算你过', '判定', '给你判'];

/** 界面自己的话：摘掉两条流的原文（那是证据）与那句把自评归给学生的声明（那是主语）。 */
function uiText(text) {
  return text
    .split(runFacts.stdout).join('')
    .split(runFacts.stderr).join('')
    .split('通过与否不在这一层').join('')
    .split('标准错误').join('')
    .split('标准输出').join('');
}

/** 把元素树抠成文本，空白压平便于比对文案。 */
const render = (component, props, state) => renderWithState(component, props, state).replace(/\s+/g, ' ').trim();

/** 一份**现造**的代跑事实：退出码非零 + 两条流都有原文 + stderr 被截断。 */
const runFacts = {
  命令: 'python3 -m unittest test_ipcalc',
  argv: ['python3', '-m', 'unittest', 'test_ipcalc'],
  程序: '/usr/bin/python3',
  cwd: '/tmp/ws/.learning/subjects/demo/lab/0001-ipcalc',
  可写: [],
  退出码: 1,
  信号: '',
  结局: '跑完',
  毫秒: 43,
  stdout: '第一段输出\n',
  stderr: 'AssertionError: 256 != 254\nFAILED (failures=2)\n',
  字节: { stdout: 16, stderr: 929 },
  截断: { stdout: false, stderr: true },
  起不来: '',
};

const deliverable = {
  kind: '交付物', q: '写出 ipcalc.py，并让随附的测试全绿。',
  交付物: '一个能跑的 ipcalc.py', 证据: 'python3 -m unittest test_ipcalc',
};

const props = (lab) => ({
  item: deliverable, index: 0, node: { id: 'ipcalc' }, subject: { slug: 'demo' },
  stateKey: 'ipcalc|ipcalc 的交付物|0', attempts: new Map(),
  lab, onLabRun: () => {},
});

/* ── 一、有结果：命令与退出码要渲染出来 ──────────────────────────────── */

test('#77 交付物题：有代跑结果时，界面渲染出命令与退出码', () => {
  const text = render(LabRun, { item: deliverable, questionId: 'ipcalc 的交付物#0', onLabRun: () => {}, lab: { state: 'done', result: runFacts } });
  assert.ok(text.includes('python3 -m unittest test_ipcalc'), `渲染里没有那条命令：${text}`);
  assert.ok(text.includes('退出码：1'), `渲染里没有退出码：${text}`);
  assert.ok(text.includes('结局：跑完'), '渲染里没有结局（一个事实，不是评价）');
  assert.ok(text.includes('43 毫秒'), '渲染里没有用时');
});

test('#77 交付物题：刷新之后（只有 `上次结果.跑`）照样显示那一段事实，并说清「已记进作答数据」', () => {
  // 刷新时 `lab`（这次会话的运行状态）是空的，事实全在 previousLab 上——这就是读盘那条路
  const text = render(LabRun, {
    item: deliverable, questionId: 'ipcalc 的交付物#0', onLabRun: () => {}, lab: undefined, previousLab: runFacts,
  });
  assert.ok(text.includes('python3 -m unittest test_ipcalc'), `刷新后仍要显示命令：${text}`);
  assert.ok(text.includes('退出码：1'), '刷新后仍要显示退出码');
  assert.ok(text.includes('AssertionError: 256 != 254'), '刷新后仍要显示报错原文');
  assert.ok(text.includes('已记进作答数据（本题库文件不动）'), '要说清这一段是落过盘的');
  // 盘上那一份与刚跑完那一次指向同一次运行：两者都在时以盘上为准，且不重复渲染
  const both = render(LabRun, {
    item: deliverable, questionId: 'ipcalc 的交付物#0', onLabRun: () => {},
    lab: { state: 'done', result: runFacts }, previousLab: runFacts,
  });
  assert.equal(both.split('python3 -m unittest test_ipcalc').length - 1, 1, '同一次运行只渲染一遍');
});

test('#77 交付物题：两条流的原文原样显示，截断了就说截断了', () => {
  const text = render(LabRun, { item: deliverable, questionId: 'ipcalc 的交付物#0', onLabRun: () => {}, lab: { state: 'done', result: runFacts } });
  assert.ok(text.includes('AssertionError: 256 != 254'), '报错原文要原样出现');
  assert.ok(text.includes('第一段输出'), 'stdout 也要出现');
  assert.ok(text.includes('标准输出（16 字节）'), `stdout 的字节数要说清：${text}`);
  assert.ok(text.includes('标准错误（929 字节，超上限已截断：头尾都留、中间省略）'), `截断要如实说：${text}`);
});

test('#77 交付物题：空的那条流说「（空）」，不是什么都不显示', () => {
  const text = render(LabRun, {
    item: deliverable, questionId: 'x#0', onLabRun: () => {},
    lab: { state: 'done', result: Object.assign({}, runFacts, { stdout: '', stderr: '' }) },
  });
  assert.ok(text.includes('（空）'), `空流也要有一句话：${text}`);
});

test('#77 交付物题：命令没起来时如实说「没起来」，不当成失败判决', () => {
  const text = render(LabRun, {
    item: deliverable, questionId: 'x#0', onLabRun: () => {},
    lab: { state: 'done', result: Object.assign({}, runFacts, { 结局: '起不来', 起不来: 'spawn ENOENT', 退出码: null }) },
  });
  assert.ok(text.includes('没起来：spawn ENOENT'));
  assert.ok(text.includes('退出码：无（被信号杀掉）') || text.includes('退出码：无'), '没有退出码就说没有');
});

/* ── 二、没有判决词 ─────────────────────────────────────────────────── */

test('#77 交付物题：有结果 / 没结果 / 被拒，三种渲染里都没有判决词', () => {
  const cases = {
    有结果: render(LabRun, { item: deliverable, questionId: 'x#0', onLabRun: () => {}, lab: { state: 'done', result: runFacts } }),
    没结果: render(LabRun, { item: deliverable, questionId: 'x#0', onLabRun: () => {} }),
    在跑: render(LabRun, { item: deliverable, questionId: 'x#0', onLabRun: () => {}, lab: { state: 'running', taskId: 'lab-1', progress: '已跑 3 秒' } }),
    被拒: render(LabRun, { item: deliverable, questionId: 'x#0', onLabRun: () => {}, lab: { state: 'refused', result: { 为什么: 'cwd 跑到实验目录外面去了', 下一步: '把 cwd 写成相对路径' } } }),
  };
  for (const [name, text] of Object.entries(cases)) {
    const ui = uiText(text);
    for (const word of VERDICT_WORDS) {
      assert.ok(!ui.includes(word), `${name} 的界面文案里出现了判决词「${word}」：${ui}`);
    }
    if (name === '有结果') assert.ok(text.includes('通过与否不在这一层'), '那句把自评归给学生的声明本身要在');
    assert.ok(text.trim().length > 0, `${name} 的渲染是空的`);
  }
});

test('#77 交付物题：原始输出原样出现——界面不替它加一句结论', () => {
  const text = render(LabRun, { item: deliverable, questionId: 'x#0', onLabRun: () => {}, lab: { state: 'done', result: runFacts } });
  // 两条流逐字在渲染里（这就是「真实输出原样贴回」在界面这一侧的落点）
  assert.ok(text.includes(runFacts.stdout.split('\n')[0]), 'stdout 第一行要逐字在');
  assert.ok(text.includes('AssertionError: 256 != 254'), 'stderr 里的报错原文要逐字在');
  assert.ok(text.includes('FAILED (failures=2)'), '连测试框架自己写的那句 FAILED 也照原样留着');
  // 界面在输出**之前**给的那一句里没有结论
  const beforeOut = text.slice(0, text.indexOf('标准输出'));
  for (const word of VERDICT_WORDS) {
    assert.ok(!beforeOut.includes(word), `输出之前就出现了判决词「${word}」：${beforeOut}`);
  }
});

test('#77 交付物题：渲染里明说「通过与否不在这一层」，把自评归给学生', () => {
  const text = render(LabRun, { item: deliverable, questionId: 'x#0', onLabRun: () => {}, lab: { state: 'done', result: runFacts } });
  assert.ok(text.includes('通过与否不在这一层'), '要说清这一层不判通过');
  assert.ok(text.includes('自评由你'), `要把自评明确归给学生：${text}`);
});

test('#77 交付物题：没有结果时只给入口，不预先摆一个「结果」框', () => {
  const text = render(LabRun, { item: deliverable, questionId: 'x#0', onLabRun: () => {} });
  assert.equal(text.includes('退出码'), false, `没跑过就不该出现退出码：${text}`);
  assert.equal(text.includes('标准输出'), false, '没跑过就不该出现输出块');
  assert.ok(text.includes('跑一次'));
  assert.ok(text.includes('在 lab 目录里跑题目里声明的那条命令'), '要说清跑的是什么、在哪跑');
});

/* ── 三、入口只有一个，且点了才跑 ───────────────────────────────────── */

test('#77 交付物题：入口是一颗「跑一次」按钮，不点不跑', () => {
  const tree = LabRun({ item: deliverable, questionId: 'x#0', onLabRun: () => {}, lab: null });
  const buttons = findByProp(tree, 'data-proto', 'lab-run-button');
  assert.equal(buttons.length, 1, '入口只该有一颗按钮');
  assert.equal(buttons[0].props.disabled, false);
  const text = renderWithState(LabRun, { item: deliverable, questionId: 'x#0', onLabRun: () => {}, lab: null });
  assert.ok(text.includes('跑一次'));
});

test('#77 交付物题：点一下才调 onLabRun（参数是题 id）；跑着的时候按钮禁用', () => {
  const clicked = [];
  const idle = LabRun({ item: deliverable, questionId: 'ipcalc 的交付物#0', onLabRun: (id) => clicked.push(id), lab: null });
  findByProp(idle, 'data-proto', 'lab-run-button')[0].props.onClick();
  assert.deepEqual(clicked, ['ipcalc 的交付物#0'], 'onLabRun 要拿到题 id（Host 半按它查那道题）');
  assert.deepEqual(clicked.length, 1, '渲染本身不许发请求——只有 onClick 会');

  const busy = LabRun({ item: deliverable, questionId: 'x#0', onLabRun: (id) => clicked.push(id), lab: { state: 'running', taskId: 'lab-1' } });
  const button = findByProp(busy, 'data-proto', 'lab-run-button')[0];
  assert.equal(button.props.disabled, true, '正在跑时按钮要禁用（不要连点出一堆任务）');
  button.props.onClick();
  assert.equal(clicked.length, 1, '禁用状态下再点也不该再发一次');
});

test('#77 交付物题：跑着的时候把进度行与任务 id 摊出来（可查），并说清怎么停', () => {
  const text = render(LabRun, {
    item: deliverable, questionId: 'x#0', onLabRun: () => {},
    lab: { state: 'running', taskId: 'lab-7', progress: '已跑 3 秒｜标准输出 68 字节' },
  });
  assert.ok(text.includes('lab-7'), '任务 id 要显示出来（学生要靠它问状态）');
  assert.ok(text.includes('已跑 3 秒'), '进度行要显示出来');
  assert.ok(text.includes('取消'), `要说清怎么停：${text}`);
});

/* ── 四、纯映射：数字就是数字 ───────────────────────────────────────── */

test('#77 labFactsOf：退出码原样、布尔不参与，缺形状时返回 null', () => {
  const facts = labFactsOf(runFacts);
  assert.equal(facts.command, 'python3 -m unittest test_ipcalc');
  assert.equal(facts.exit, '1', '退出码是数字原样，不是「成功/失败」');
  assert.equal(facts.outcome, '跑完');
  assert.equal(facts.outCut, false);
  assert.equal(facts.errCut, true);
  assert.equal(facts.errBytes, 929);

  // 被信号杀掉：没有退出码就说没有，不编一个 0
  assert.equal(labFactsOf(Object.assign({}, runFacts, { 退出码: null, 信号: 'SIGTERM', 结局: '取消' })).exit, '无（被信号杀掉）');
  // 不是对象 / 没有命令：返回 null（界面据此只显示入口）
  assert.equal(labFactsOf(null), null);
  assert.equal(labFactsOf({}), null);
  assert.equal(labFactsOf('跑完了'), null);
});

test('#77 端点常量与 Host 半逐字一致（前端拼错就是一个静默的 404）', () => {
  assert.equal(LAB_ENDPOINT, '/api/studymate/lab-run');
});

/* ── 五、整道题：交付物题那一支把代跑块挂上了 ───────────────────────── */

test('#77 Question：交付物题展开后能看到代跑入口；客观题那一支不受影响', () => {
  // `open` 是 Question 的第一个 useState（默认 false：参考内容与代跑块都折叠着）。
  // 这里把它驱到 true，看展开之后那一支里有什么。
  const deliverableText = render(Question, props({ state: 'done', result: runFacts }), [true]);
  assert.ok(deliverableText.includes('再跑一次'), `交付物题展开后要有代跑入口：${deliverableText}`);
  assert.ok(deliverableText.includes('python3 -m unittest test_ipcalc'), '事实块要在题目卡片里');
  assert.ok(deliverableText.includes('退出码：1'), '退出码要在题目卡片里');

  const objectiveText = render(Question, Object.assign(props(null), {
    item: { kind: '客观题', q: '选一个', opts: ['a', 'b'], ans: 0, why: '因为' },
  }), [true]);
  assert.equal(objectiveText.includes('跑一次'), false, '客观题不该出现代跑入口');
  assert.equal(objectiveText.includes('在 lab 目录里跑'), false);
});
