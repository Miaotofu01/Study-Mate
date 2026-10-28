/* 纯函数域的**覆盖率下限**门禁。
   ────────────────────────────────────────────────────────────────────────
   验收标准要的是「纯函数层有明确覆盖率下限」，不是一句口号。所以下限写在这里的 `FLOORS`
   表里，由 `npm test` 里这一条套件真的去跑 `node --test --experimental-test-coverage`
   并带上阈值参数——阈值不达标时 Node 自己以退出码 1 收场，门禁跟着红。

   为什么另起一条套件而不是把阈值塞进 `checks.mjs`：`checks.mjs` 的 `tests` 组只会原样拼
   `node --test <文件…>`，加不了 `--test-coverage-*` 这些选项。把它做成一条会 spawn 子进程的
   套件，覆盖下限就与别的套件走同一条登记路径，不会变成没人跑的第二套机制。

   **统计范围自动发现**（这一版改的就是它）：`lib/core/**` 下有哪几个模块、哪个套件真的把它
   拉进了同一轮，全部从盘上算出来，不再手写。手写列表就是上一版出问题的地方——标签写着「整个
   纯函数域」，实际只统计了列表里那 5 个模块，`lib/core/{format,anchors,lesson,fence,questions,
   misconceptions}.ts` 六份（两千多行）根本不在分母里，标签名不副实。

   两条口子也一并堵上：
     · `--test-coverage-include` 只管**报什么**，没被加载的模块根本不进分母。所以下面除了跑阈值，
       还断言「发现到的每个模块都出现在覆盖率报告的表里」——有模块没人加载就红，不许静默少算。
     · 确实统计不到的模块只能进 `UNMEASURABLE`，而且要写清原因（现在是空的）。

   阈值取得比实测低一档，是留给正常重构的余量（不是为了好看）：实测值见运行输出里的表格。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SELF = 'scripts/tests/test_core_coverage_floor.mjs';

/* ── 自动发现：模块与套件都不许手写 ────────────────────────────────────────── */

/** `lib/core/**` 下的全部源文件（相对仓库根）。 */
function discoverCoreModules(dir = path.join(ROOT, 'lib', 'core')) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { found.push(...discoverCoreModules(full)); continue; }
    if (entry.name.endsWith('.ts')) found.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return found;
}

/**
 * 真的把 `lib/core/**` 拉进来的套件（相对说明符解析后落在 `lib/core/` 里）。只认
 * `scripts/tests/` 顶层——`browser/` 那些要真浏览器，跑不进这一轮；`fixtures/` 是夹具不是套件。
 * 正则是浅的（不抹注释），误判顶多多跑一条套件，漏判则由「每个模块都要出现在报告里」兜住。
 */
function discoverCoreSuites(dir = path.join(ROOT, 'scripts', 'tests')) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    const relative = `scripts/tests/${entry.name}`;
    if (relative === SELF) continue;  // 自己不能进子进程，否则一层套一层
    const source = fs.readFileSync(path.join(dir, entry.name), 'utf8');
    const specifiers = [...source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
    const touchesCore = specifiers.some(specifier => specifier.startsWith('.')
      && path.posix.normalize(path.posix.join('scripts/tests', specifier)).startsWith('lib/core/'));
    if (touchesCore) found.push(relative);
  }
  return found;
}

const CORE_MODULES = discoverCoreModules();
const CORE_SUITES = discoverCoreSuites();

/* 确实统计不到的模块放这里，**每条都要写原因**（现在没有：`lib/core/**` 全部进统计）。 */
const UNMEASURABLE = [];

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
    label: `整个纯函数域（lib/core/**，自动发现 ${CORE_MODULES.length} 个模块 / ${CORE_SUITES.length} 条套件）`,
    include: 'lib/core/**',
    suites: CORE_SUITES,
    lines: 95,
    branches: 87,
    functions: 94,
  },
];

/** `include` 只用了两种形状：单个文件、`<目录>/**`。别的一律不支持——不支持才好核对。 */
function matchesInclude(file, include) {
  return include.endsWith('/**') ? file.startsWith(include.slice(0, -2)) : file === include;
}

const coveredBy = (include) => CORE_MODULES.filter(file => matchesInclude(file, include));

/**
 * 覆盖率报告的表里到底列了哪些文件。表是按目录缩进的（`lib` → ` core` → `  anchors.ts`），
 * 所以按缩进还原路径；带数字的行才是文件。
 *
 * 每行的前缀随 reporter 变，**不是固定的**：stdout 是 TTY（本地直接跑）时 Node 用 spec
 * reporter，前缀是 `ℹ `；stdout 被重定向或接管道（CI、`npm test`、`node --test` 自己 spawn
 * 的子进程）时用 TAP reporter，前缀是 `# `。只认一种前缀就是把门禁绑在「调用环境有没有终端」
 * 上：漏掉 TAP 那一半时，表格行会被解析成一堆带 `#` 的假路径，于是「模块没进覆盖率」满屏
 * 误报，而覆盖率其实是好的。所以两种前缀都认（子进程另外还显式指定了 spec，见下面的 args）。
 *
 * 解析不出东西时返回 null，**空集合绝不冒充成功**——空 Set 是 truthy，上游 `assert.ok`
 * 拦不住，于是「报告格式变了」会伪装成「模块没进统计」。
 */
function reportedFiles(output) {
  const start = output.indexOf('start of coverage report');
  const end = output.indexOf('end of coverage report');
  if (start < 0 || end < 0) return null;
  const files = new Set();
  const stack = [];
  for (const line of output.slice(start, end).split('\n')) {
    // 前缀之后才是目录缩进——缩进层级就是路径深度，别把前缀的空格算进去
    const match = /^(?:ℹ |# )?( *)([^\s|][^|]*?)\s*\|\s*([\d.]*)\s*\|/.exec(line);
    if (!match) continue;
    const [, indent, rawName, percent] = match;
    const name = rawName.trim();
    if (!name || name === 'file' || name === 'all files') continue;
    const level = indent.length;
    stack[level] = name;
    stack.length = level + 1;
    if (percent === '') continue;  // 目录行没有数字，只有合计在下面
    files.add([...stack.slice(0, level + 1)].join('/'));
  }
  // 一条文件都没解析出来 = 报告格式对不上（不是「覆盖率为 0」），直接当失败
  if (files.size === 0) return null;
  // 前缀没剥干净会拼出带 `#`、空格的假路径：这种也算没解析出来，别让它混进「已统计」里
  if ([...files].some(file => !/^[\w./-]+$/.test(file))) return null;
  return files;
}

/* 解析器自己的测试放在真正跑子进程之前：它是门禁的耳朵，耳朵失灵时得先听得见。 */
test('覆盖率表格的解析不跟 reporter 走（spec 的「ℹ 」与 TAP 的「# 」都要认）', () => {
  // 同一张表、两种前缀：解析结果必须一样。只认一种，门禁结果就变成「stdout 有没有终端」的函数。
  // 前缀正好占两个字符（`ℹ ` / `# `），后面紧跟目录缩进——别在模板里再补空格，否则缩进多一级
  const table = prefix => [
    `${prefix}start of coverage report`,
    `${prefix}-----------------------------------------------------------`,
    `${prefix}file       | line % | branch % | funcs % | uncovered lines`,
    `${prefix}-----------------------------------------------------------`,
    `${prefix}lib        |        |          |         | `,
    `${prefix} core      |        |          |         | `,
    `${prefix}  rules.ts | 100.00 |    95.35 |  100.00 | `,
    `${prefix}ipc        |        |          |         | `,
    `${prefix} bridge.ts |  92.31 |    80.00 |   88.89 | 1-3`,
    `${prefix}-----------------------------------------------------------`,
    `${prefix}all files  |  99.10 |    93.75 |   99.00 | `,
    `${prefix}-----------------------------------------------------------`,
    `${prefix}end of coverage report`,
  ].join('\n');
  // 表格里两个顶层目录（lib、ipc）各带一个文件：缩进决定层级，顶层目录不该被并到别人底下
  const expected = ['ipc/bridge.ts', 'lib/core/rules.ts'];
  assert.deepEqual([...reportedFiles(table('ℹ '))].sort(), expected);
  assert.deepEqual([...reportedFiles(table('# '))].sort(), expected);
  // 认不出来的前缀会拼出带 `#`、空格或 `%` 的假路径：必须当成「没解析出来」返回 null。
  assert.equal(reportedFiles(table('% ')), null);
  // 表在、但一行文件都没有（被截断或格式变了）：空集合同样算「没解析出来」，别冒充「没有模块」
  assert.equal(
    reportedFiles('ℹ start of coverage report\nℹ lib        |        |          |         | \nℹ end of coverage report'),
    null,
  );
  // 连报告标记都没有，也算没解析出来
  assert.equal(reportedFiles('nothing here'), null);
});

for (const floor of FLOORS) {
  test(`覆盖率下限：${floor.label}`, () => {
    const args = [
      '--test',
      // 显式指定 reporter：不写这一条，Node 按「stdout 是不是 TTY」自己挑，本地终端里是
      // spec（前缀 `ℹ `）、CI 与 `npm test` 的管道里是 TAP（前缀 `# `）。下面要解析覆盖率
      // 表格，就不能让报告格式跟着调用环境漂移——把它钉死，解析才只有一种输入。
      '--test-reporter=spec',
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

    /* 报告里必须出现 `include` 圈到的**每一个**模块：`--test-coverage-include` 只决定报什么，
       没被任何套件加载的模块压根不进分母——那正是上一版「标签写着 lib/core/**、实际只统计 5 个」
       的成因。少了谁就红，并且指出该补哪条套件，而不是让它悄悄少算。 */
    const reported = reportedFiles(output);
    assert.ok(reported, '解析不出覆盖率报告的文件表：报告格式变了（reporter 前缀？），'
      + '别让这条断言变成摆设——它现在会把「解析失败」直接判红，而不是当成「模块没进统计」');
    const expected = coveredBy(floor.include).filter(file => !UNMEASURABLE.includes(file));
    const missing = expected.filter(file => !reported.has(file));
    assert.deepEqual(missing, [], `这些模块没进覆盖率统计（没有套件加载它们）：${missing.join('、')}`
      + `——补一条直接 import 它们的套件；确实统计不到就写进 UNMEASURABLE 并说明原因`);
  });
}

test('覆盖率下限表本身是自洽的（区间合法、套件存在、范围真的圈到了模块）', () => {
  for (const floor of FLOORS) {
    assert.ok(floor.lines > 0 && floor.lines <= 100);
    assert.ok(floor.branches > 0 && floor.branches <= 100);
    assert.ok(floor.functions > 0 && floor.functions <= 100);
    assert.ok(floor.suites.length > 0, `${floor.label} 没带套件`);
    // 纯函数层的下限必须真的落在 lib/core 里，别把测试文件自己也统计进来充数
    assert.match(floor.include, /^lib\/core\//);
    for (const suite of floor.suites) {
      assert.ok(fs.existsSync(path.join(ROOT, suite)), `${floor.label} 列的套件不存在：${suite}`);
    }
  }
});

test('自动发现没瞎：模块与套件都扫到了，且范围里的模块都有套件加载', () => {
  // 低水位线：只用来证明发现逻辑在看盘，不是精确清单（精确清单就是发现结果本身）
  assert.ok(CORE_MODULES.length >= 5, `只发现 ${CORE_MODULES.length} 个 lib/core 模块，太少了`);
  assert.ok(CORE_SUITES.length >= 5, `只发现 ${CORE_SUITES.length} 条碰 lib/core 的套件，太少了`);
  assert.ok(!CORE_SUITES.includes(SELF), '自己进了子进程列表：会一层套一层地跑下去');
  assert.ok(CORE_SUITES.every(suite => fs.existsSync(path.join(ROOT, suite))), '发现的套件有对不上盘的');
  // 每条下限都要真的圈到模块，空范围等于没有下限
  for (const floor of FLOORS) {
    assert.ok(coveredBy(floor.include).length > 0, `${floor.label} 圈到的模块数是 0，这条下限是空转的`);
  }
  assert.deepEqual(UNMEASURABLE, [], 'UNMEASURABLE 里现在不该有东西：有的话请在该项旁边写清为什么统计不到');
});
