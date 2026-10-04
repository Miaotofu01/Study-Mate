/* 纯函数域的**覆盖率下限**门禁。
   ────────────────────────────────────────────────────────────────────────
   验收标准要的是「纯函数层有明确覆盖率下限」，不是一句口号。所以下限写在这里的 `FLOORS`
   表里，由 `npm test` 里这一条套件真的去跑 `node --test --experimental-test-coverage`
   并带上阈值参数——阈值不达标时 Node 自己以退出码 1 收场，门禁跟着红。

   为什么另起一条套件而不是把阈值塞进 `checks.mjs`：`checks.mjs` 的 `tests` 组只会原样拼
   `node --test <文件…>`，加不了 `--test-coverage-*` 这些选项。把它做成一条会 spawn 子进程的
   套件，覆盖下限就与别的套件走同一条登记路径，不会变成没人跑的第二套机制。

   阈值取得比实测低一档，是留给正常重构的余量（不是为了好看）：实测值见运行输出里的表格。 */
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const VALIDATOR_SUITES = [
  'scripts/tests/test_core_schema_subset.mjs',
  'scripts/tests/test_validators_curriculum.mjs',
  'scripts/tests/test_validators_progress_subject.mjs',
  'scripts/tests/test_validators_handoff.mjs',
];

const FLOORS = [
  {
    label: '纯函数规则层（lib/core/rules.ts）',
    include: 'lib/core/rules.ts',
    suites: ['scripts/tests/test_rules_pure.mjs'],
    lines: 98,
    branches: 90,
    functions: 95,
  },
  {
    label: '整个纯函数域（lib/core/**）',
    include: 'lib/core/**',
    suites: [...VALIDATOR_SUITES, 'scripts/tests/test_rules_pure.mjs'],
    lines: 92,
    branches: 82,
    functions: 92,
  },
];

for (const floor of FLOORS) {
  test(`覆盖率下限：${floor.label}`, () => {
    const args = [
      '--test',
      '--experimental-test-coverage',
      `--test-coverage-include=${floor.include}`,
      `--test-coverage-lines=${floor.lines}`,
      `--test-coverage-branches=${floor.branches}`,
      `--test-coverage-functions=${floor.functions}`,
      ...floor.suites,
    ];
    // 子进程也是 `node --test`，而父进程正在测试运行里：Node 靠 NODE_TEST_CONTEXT 认出
    // 「测试里再跑测试」，会直接跳过全部文件（"run() is being called recursively"）——
    // 于是覆盖率报告根本不产出，阈值也就永远「达标」。把那个变量摘掉，子进程才是独立一轮。
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, env });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    // 把表格打出来：下限是给人看的数字，不该藏在断言背后
    process.stdout.write(output);

    assert.equal(
      result.error, undefined,
      `跑不起来覆盖率检查：${result.error ? result.error.message : ''}`,
    );
    assert.notEqual(
      result.status, 9,
      'Node 不认 --test-coverage-* 选项：覆盖率下限没被真正执行，别把它当成通过',
    );
    assert.match(output, /coverage report/, '没有产出覆盖率报告：阈值参数没生效');
    assert.equal(
      result.status, 0,
      `${floor.label} 没达到下限（行 ≥ ${floor.lines}%、分支 ≥ ${floor.branches}%、函数 ≥ ${floor.functions}%）`,
    );
  });
}

test('覆盖率下限表本身是自洽的（区间合法、套件存在）', () => {
  for (const floor of FLOORS) {
    assert.ok(floor.lines > 0 && floor.lines <= 100);
    assert.ok(floor.branches > 0 && floor.branches <= 100);
    assert.ok(floor.functions > 0 && floor.functions <= 100);
    assert.ok(floor.suites.length > 0, `${floor.label} 没带套件`);
    // 纯函数层的下限必须真的落在 lib/core 里，别把测试文件自己也统计进来充数
    assert.match(floor.include, /^lib\/core\//);
  }
});
