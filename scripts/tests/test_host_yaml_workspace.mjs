/* 特征化测试：Host 半数据层 · lib/yaml.ts 的子集解析 与 lib/workspace.ts 的配置读取
   ────────────────────────────────────────────────────────────────────────
   钉住「哪些构造读得出来、哪些当场报错」，以及工作区配置两种真实形态都能认。
   断言只碰这两个模块的公开导出，不看内部函数；数据在临时目录里现造现弃。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { parseYaml, pyStrip, resolvePlainScalar } from '../../lib/yaml.ts';
import { configFile, dshHome, resolveRoot, resolveWorkspace } from '../../lib/workspace.ts';

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-host-yaml-'));
  TEMPS.push(dir);
  return dir;
}

/* ── parseYaml：读得出来的构造 ─────────────────────────────────────────── */

test('学习文件用的那几种构造都读得出来：嵌套映射、列表、列表里的映射', () => {
  const text = [
    'nodes:',
    '  - id: 变量',
    '    title: 变量',
    '    concepts: [绑定, 作用域]',
    '  - id: 函数',
    '    prerequisites:',
    '      - 变量',
    'nodes2:',
    '  变量:',
    '    status: 学习中',
    '',
  ].join('\n');
  assert.deepEqual(parseYaml(text), {
    nodes: [
      { id: '变量', title: '变量', concepts: ['绑定', '作用域'] },
      { id: '函数', prerequisites: ['变量'] },
    ],
    nodes2: { 变量: { status: '学习中' } },
  });
});

test('标量按 PyYAML 的隐式类型判定：yes/no 是布尔、带引号的数字是字符串', () => {
  const parsed = parseYaml([
    '无: ~',
    '空: ""',
    '是: yes',
    '否: no',
    '分数: 0.85',
    '十六: 0x1f',
    '八进: 012',
    '带引号: "0.85"',
    '日期: 2026-05-06',
    '时间戳: "2026-05-06T07:08:09+08:00"',
    '网址: https://example.com/a',
    '',
  ].join('\n'));

  assert.deepEqual(parsed, {
    无: null,
    空: '',
    是: true,
    否: false,
    分数: 0.85,
    十六: 31,
    八进: 10,
    带引号: '0.85',
    // 时间戳本解析器按字符串返回（刻意不同 PyYAML 的 date 对象），值与原文字面一致
    日期: '2026-05-06',
    时间戳: '2026-05-06T07:08:09+08:00',
    网址: 'https://example.com/a',
  });
});

test('注释：整行与行尾都去掉，引号里的 # 不算注释', () => {
  assert.deepEqual(parseYaml([
    '# 整行注释',
    'a: 1 # 行尾注释',
    'b: "值是 # 不是注释"',
    '',
  ].join('\n')), { a: 1, b: '值是 # 不是注释' });
});

test('块标量：| 保换行、> 折行，块后面还能接同级键', () => {
  const opts = { blockScalars: true };
  // 块标量后面跟着同级键：解析器要把「块结束后的那一行」交回去。
  // 交错了（0-based 下标当 1-based 行号用）就会把块的末行当结构重复解析。
  assert.deepEqual(parseYaml([
    'a: |-',
    '  第一行',
    '  第二行',
    'b: 尾',
    '',
  ].join('\n'), opts), { a: '第一行\n第二行', b: '尾' });

  // `|` 保换行（`|-` 之外的 chomp 默认值）：这里的换行不许被折成空格
  assert.deepEqual(parseYaml([
    'a: |',
    '  第一行',
    '  第二行',
    'b: 尾',
    '',
  ].join('\n'), opts), { a: '第一行\n第二行\n', b: '尾' });

  // `>-` 折行：非空行之间的单个换行折成空格
  assert.deepEqual(parseYaml([
    'a: >-',
    '  折叠一',
    '  折叠二',
    'b: 尾',
    '',
  ].join('\n'), opts), { a: '折叠一 折叠二', b: '尾' });

  // 列表项里的块标量，后面还有同级列表项
  assert.deepEqual(parseYaml([
    '- |-',
    '  第一项',
    '- 第二项',
    '',
  ].join('\n'), opts), ['第一项', '第二项']);
});

test('块标量的折行与 chomping 逐字对齐 PyYAML（#224）', () => {
  const opts = { blockScalars: true };
  // 期望值全部是 PyYAML 6.0.1 跑出来的原文，不是手推的——下面是 issue #224 里那张对拍表，
  // 逐行照抄（五例）。
  assert.deepEqual(parseYaml('a: >\n  x\n   y\n', opts), { a: 'x\n y\n' });
  assert.deepEqual(parseYaml('a: >-\n  x\n   y\n', opts), { a: 'x\n y' });
  assert.deepEqual(parseYaml('a: >2-\n   x\n   y\n', opts), { a: ' x\n y' });
  assert.deepEqual(parseYaml('a: |+\n  x\n  y\n\n', opts), { a: 'x\ny\n\n' });
  assert.deepEqual(parseYaml('a: >+\n  x\n  y\n\n', opts), { a: 'x y\n\n' });
  // 比块缩进更深的续行（more-indented）不参与折行：它自己的换行要留着，
  // 多出来的前导空格属于正文。以前这里被折成一个空格（"x  y"），静默少一层缩进。
  assert.deepEqual(parseYaml('a: >\n  x\n   y\n  z\n   w\n', opts), { a: 'x\n y\nz\n w\n' });
  // 普通行之间的空行：n 个空行给 n 个换行（不是折成空格，也不是 n+1）
  assert.deepEqual(parseYaml('a: >-\n  一\n\n  二\n', opts), { a: '一\n二' });
  assert.deepEqual(parseYaml('a: >-\n  一\n\n\n  二\n', opts), { a: '一\n\n二' });
  // `+`(keep) 的尾随空行必须留到最后统一处理：以前在循环里就被 pop 掉了，
  // 于是 `|+` 尾部的空行整段丢失（issue 里最直观的一处不一致）。
  assert.deepEqual(parseYaml('a: |+\n  x\n  y\n\n', opts), { a: 'x\ny\n\n' });
  assert.deepEqual(parseYaml('a: >+\n  x\n  y\n\n', opts), { a: 'x y\n\n' });
  assert.deepEqual(parseYaml('a: |+\n\n\n', opts), { a: '\n\n' });
  // clip 只补最后内容行**自己**的行尾换行：文末没有换行就一个也不补
  assert.deepEqual(parseYaml('a: |\n  x', opts), { a: 'x' });
  assert.deepEqual(parseYaml('a: |\n', opts), { a: '' });
  // 块结束在下一个同级键之前：尾随空行按 chomping 收，别算进后面那个键
  assert.deepEqual(parseYaml('a: >\n  x\n\nb: 2\n', opts), { a: 'x\n', b: 2 });
  assert.deepEqual(parseYaml('a: >+\n  x\n\nb: 2\n', opts), { a: 'x\n\n', b: 2 });
  // CRLF 与 LF 同口径（行尾的 \r 属于换行符，不进正文）
  assert.deepEqual(parseYaml('a: >\r\n  x\r\n   y\r\n\r\n  z\r\n', opts), { a: 'x\n y\n\nz\n' });
  // 列表项、嵌套键下的折行：缩进参考的是父节点那一层
  assert.deepEqual(parseYaml('- >\n  x\n   y\n- 尾\n', opts), ['x\n y\n', '尾']);
  assert.deepEqual(parseYaml('outer:\n  inner: >\n    x\n     y\n', opts), { outer: { inner: 'x\n y\n' } });
  assert.deepEqual(parseYaml('a: >2\n    x\n   y\n', opts), { a: '  x\n y\n' });
});

test('多行 plain 标量：显式开启后按 YAML 折行规则读，默认仍报错', () => {
  const opts = { plainScalarContinuation: true };
  assert.deepEqual(parseYaml('a: first line\n  second line\n', opts), { a: 'first line second line' });
  // 中间隔一个空行：折成一个换行（与 PyYAML 的 plain scalar 折行一致）
  assert.deepEqual(parseYaml('a: first\n\n  second\n', opts), { a: 'first\nsecond' });
  // 值块本身可以是标量：键下一行开始、缩进更深
  assert.deepEqual(parseYaml('a:\n  hello\n  world\nb: 2\n', opts), { a: 'hello world', b: 2 });
  // 列表项 / 列表项里的映射值
  assert.deepEqual(parseYaml('- first\n  second\n- third\n', opts), ['first second', 'third']);
  assert.deepEqual(parseYaml([
    '- id: x',
    '  description: long text here',
    '    wrapped continuation',
    '',
  ].join('\n'), opts), [{ id: 'x', description: 'long text here wrapped continuation' }]);
  // 续行里出现映射冒号是非法 YAML（与 PyYAML 同口径）
  assert.throws(() => parseYaml('a: first\n  b: second\n', opts), /续行里出现/);
  // 默认关闭：学习文件仍按老规矩报错
  assert.throws(() => parseYaml('a: first\n  second\n'), /同级键必须对齐|多行 plain 标量/);
});

test('真实 DSH 设置页形态：长 description 折行不会让补丁解析失败', () => {
  const patch = [
    '- id: llm-deepseek-account',
    '  config:',
    '    models:',
    '      - id: deepseek-v4-pro',
    '        name: DeepSeek-V4-Pro',
    '        description: Stronger agentic coding, knowledge, and difficult reasoning; suited',
    '          to complex or quality-critical tasks at higher cost.',
    '',
  ].join('\n');
  const options = {
    tags: 'scalar', blockScalars: true, documentMarkers: true, plainScalarContinuation: true,
  };
  assert.equal(parseYaml(patch, options)[0].config.models[0].description,
    'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.');
});

test('跨行引号标量：显式开启后按 YAML 折行规则读，默认仍报错', () => {
  const opts = { quotedScalarContinuation: true };
  assert.deepEqual(parseYaml('a:\n  k: "hello\n    world."\n', opts), { a: { k: 'hello world.' } });
  // 行尾空白与行首缩进都去掉；每个空行折成一个换行；闭合引号后的行尾注释照常去掉，下一个键照常读
  assert.deepEqual(parseYaml('a: "first  \n\n\n  second" # 注释\nb: 1\n', opts), { a: 'first\n\nsecond', b: 1 });
  // 双引号里行尾的 \ 转义掉换行：不补空格
  assert.deepEqual(parseYaml('a: "con\\\n  cat"\n', opts), { a: 'concat' });
  // 续行里的 # 是正文，不是注释
  assert.deepEqual(parseYaml('a: "x\n  # y"\n', opts), { a: 'x # y' });
  // 单引号：'' 仍是一个引号
  assert.deepEqual(parseYaml("- 'it''s\n  ok'\n- next\n", opts), ["it's ok", 'next']);
  // 读到文档末尾还没闭合：照旧报错，行号指向引号开头那一行
  assert.throws(() => parseYaml('a: 1\nb: "never\n  closed\n', opts), (error) => {
    assert.match(error.message, /引号没有闭合/);
    assert.equal(error.line, 2);
    return true;
  });
  // 闭合引号后面的多余内容，报在闭合那一行
  assert.throws(() => parseYaml('a: "x\n  y" z\n', opts), (error) => error.line === 2 && /多余内容/.test(error.message));
  // 默认关闭：学习文件仍按老规矩报错
  assert.throws(() => parseYaml('a: "x\n  y"\n'), /引号没有闭合/);
});

test('真实 DSH 宿主写盘形态：80 列折行的双引号长字符串不会让补丁解析失败', () => {
  // 宿主用 `String(document)` 写盘（yaml 库默认 lineWidth 80），列表项映射里的长字符串被折成两行
  const patch = [
    '- id: some-plugin',
    '  config:',
    '    items:',
    '      - id: promo',
    '        hover:',
    '          textZh: "Nov 4–15: Receive a daily free allowance. Subscribers enjoy higher',
    '            quotas."',
    '        enabled: true',
    '',
  ].join('\n');
  const options = {
    tags: 'scalar', blockScalars: true, documentMarkers: true, plainScalarContinuation: true,
    quotedScalarContinuation: true,
  };
  assert.deepEqual(parseYaml(patch, options)[0].config.items[0], {
    id: 'promo',
    hover: { textZh: 'Nov 4–15: Receive a daily free allowance. Subscribers enjoy higher quotas.' },
    enabled: true,
  });
});

test('跨行流式集合：显式开启后按 YAML 的 flow 折行规则读，默认仍报错', () => {
  const opts = {
    tags: 'scalar', blockScalars: true, documentMarkers: true, plainScalarContinuation: true,
    quotedScalarContinuation: true, flowCollectionContinuation: true,
  };
  // issue #317 的真实形态：模型清单写成 `- {` 换行、几行之后才闭合（标准 YAML，宿主自己读得动）。
  assert.deepEqual(parseYaml([
    '- id: bundle',
    '  config:',
    '    models:',
    '      - {',
    '          id: "openai/gpt-6-luna",',
    '          name: "GPT-6 Luna",',
    '          contextWindow: 1050000',
    '        }',
    '    enabled: true',
    '',
  ].join('\n'), opts), [{
    id: 'bundle',
    config: {
      models: [{ id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 1050000 }],
      enabled: true,
    },
  }]);
  // 嵌套的流式集合、末尾逗号、流式集合里的行尾注释、跨行的引号标量：都按 PyYAML 的 flow 口径读
  assert.deepEqual(parseYaml([
    '- {a: 1, b: {c: [1, 2,',
    '    3]},',
    '   d: x,} # 行尾注释',
    '- {e: "x',
    '    y"}',
    '',
  ].join('\n'), opts), [{ a: 1, b: { c: [1, 2, 3] }, d: 'x' }, { e: 'x y' }]);
  // 空行夹在两个 token 之间只是分隔空白；夹在 plain 标量里折成一个换行（与 PyYAML 同口径）
  assert.deepEqual(parseYaml('- {a: 1,\n\n   b: 2}\n', opts), [{ a: 1, b: 2 }]);
  assert.deepEqual(parseYaml('- [a\n\n   b]\n', opts), [['a\nb']]);
  // 双引号里行尾的 \ 转义掉换行：不补空格
  assert.deepEqual(parseYaml('- {a: "con\\\n    cat"}\n', opts), [{ a: 'concat' }]);
  // 双引号里行尾的转义空格是内容：折行只裁未转义的空白（与 readQuoted 同口径）
  assert.deepEqual(parseYaml('{\n  a: "foo\\ \n  bar"\n}\n', opts), { a: 'foo  bar' });
  assert.deepEqual(parseYaml('{\n  a: "foo\\   \n  bar"\n}\n', opts), { a: 'foo  bar' });
  assert.deepEqual(parseYaml('{\n  a: "foo\\ \n\n  bar"\n}\n', opts), { a: 'foo \nbar' });
  // 孩子就是以流式集合起头（键的下一行才给 `[`），闭合之后的同级键照常读
  assert.deepEqual(parseYaml('- key:\n    [\n      1,\n      2,\n    ]\n- 尾\n', opts), [{ key: [1, 2] }, '尾']);
  // 闭合括号后面的多余内容，报在闭合那一行
  assert.throws(() => parseYaml('- {a: 1} extra\n', opts), (error) => error.line === 1 && /多余内容/.test(error.message));
  // 默认关闭：学习文件仍按老规矩报错（行号指向 `{` 起头那一行）
  assert.throws(() => parseYaml('- {\n    a: 1\n  }\n'), (error) => error.line === 1 && /缺少闭合/.test(error.message));
  // 文档根是流式集合时本来就能跨行（与选项无关）；折行之后注释里的 `]` 也不会把闭合判错
  assert.deepEqual(parseYaml('[\n  # 注释里有个 ]\n  {a: 1},\n  [2,\n   3],\n]\n'), [{ a: 1 }, [2, 3]]);
  assert.throws(() => parseYaml('[]\nfoo: 1\n'), (error) => error.line === 2 && /多余内容/.test(error.message));
});

test('标签加块标量：`!!js >-` 先折行再过标签，profile 补丁里的 embedding 三项读得出来', () => {
  const options = {
    tags: 'scalar', blockScalars: true, documentMarkers: true, plainScalarContinuation: true,
  };
  // 本机真实形态：graph-memory 的 embedding.apiKeyEnv / dimensions 就是 `!!js >-`。
  // 值里带 `? … : …`，走 plain 续行会撞「续行里出现 ": "」，所以必须先按块读再折行。
  const parsed = parseYaml([
    '- id: graph-memory',
    '  config:',
    '    embedding:',
    '      apiKeyEnv: !!js >-',
    '        process.env.GRAPH_MEMORY_EMBEDDING_API_KEY ?',
    "        'GRAPH_MEMORY_EMBEDDING_API_KEY' : undefined",
    '      baseURL: !!js process.env.GRAPH_MEMORY_EMBEDDING_BASE_URL',
    '',
  ].join('\n'), options);
  assert.deepEqual(parsed[0].config.embedding, {
    apiKeyEnv: "process.env.GRAPH_MEMORY_EMBEDDING_API_KEY ? 'GRAPH_MEMORY_EMBEDDING_API_KEY' : undefined",
    baseURL: 'process.env.GRAPH_MEMORY_EMBEDDING_BASE_URL',
  });

  // `!!js |` 保换行；列表项里的带标签块标量；键下一行才给块头，三种位置都要走同一条路
  assert.deepEqual(parseYaml('- !!js |\n  a\n  b\n- 尾\n', options), ['a\nb\n', '尾']);
  assert.deepEqual(parseYaml('key:\n  !!js >-\n    x\n    y\n', options), { key: 'x y' });
});

test('标签加块标量按调用的标签口径取值：expression 模式给 {__jsExpr}', () => {
  const value = parseYaml('a: !!js |\n  one\n  two\n', { tags: 'expression', blockScalars: true });
  assert.deepEqual(value, { a: { __jsExpr: 'one\ntwo\n' } });
});

test('标签加块标量的两处边界：孩子的缩进指示按父节点算、只开 blockScalars 也认裸块头', () => {
  const options = {
    tags: 'scalar', blockScalars: true, documentMarkers: true, plainScalarContinuation: true,
  };
  // 缩进指示（`|2`）是相对**父节点**（键所在那一层）算的，不是相对块头那一行。
  // PyYAML 对 `key:\n  |2\n    x` 给的是 "  x"：多出来的两格属于正文。
  assert.equal(parseYaml('key:\n  |2\n    x\n', options).key, '  x\n');
  assert.equal(parseYaml('key:\n  |1\n   x\n', options).key, '  x\n');
  // 只开 blockScalars（不续行）时，孩子块的**裸**头照旧要认——那是 blockScalars 的承诺
  assert.equal(parseYaml('key:\n  |\n    x\n', { blockScalars: true }).key, 'x\n');
  // 标签没开时仍旧拒，不静默把标签丢掉
  assert.throws(() => parseYaml('key:\n  !!js >-\n    x\n', { blockScalars: true }), /不支持标签/);
});

test('空文档与裸流式集合', () => {
  assert.equal(parseYaml(''), null);
  assert.equal(parseYaml('# 只有注释\n'), null);
  assert.deepEqual(parseYaml('[]\n'), []);
  assert.deepEqual(parseYaml('{}\n'), {});
});

test('__proto__ 当键不会改原型，只当一个普通键', () => {
  const parsed = parseYaml('__proto__: 坏\nok: 1\n');
  assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  assert.equal(Object.getOwnPropertyDescriptor(parsed, '__proto__').value, '坏');
  assert.equal(parsed.ok, 1);
  assert.equal({}.坏, undefined, '不许污染 Object.prototype');
});

test('不支持的构造当场报错，错误里带文件名、行号与原文', () => {
  const cases = [
    ['a:\n\tb: 1\n', /制表符/],
    ['a: 1\n---\nb: 2\n', /多文档分隔符/],
    ['a: |\n  text\n', /不支持块标量/],
    ['a: &x 1\n', /不支持锚点/],
    ['a: *x\n', /不支持别名/],
    ['a: !x 1\n', /不支持标签/],
    ['%YAML 1.2\na: 1\n', /不支持 YAML 指令/],
    ['a: "没闭合\n', /引号没有闭合/],
    ['a: 1\n   b: 2\n', /同级键必须对齐/],
    ['first\nsecond\n', /多行 plain 标量/],
    ['a: 1\nb: 2\nc\n', /既不是 key: value/],
    ['a: 值: 值\n', /plain 标量里出现/],
    ['a: ? b\n', /不支持显式键/],
  ];
  for (const [text, pattern] of cases) {
    assert.throws(() => parseYaml(text, { file: 'demo.yaml' }), (error) => {
      assert.equal(error.name, 'YamlParseError');
      assert.equal(error.file, 'demo.yaml');
      assert.ok(Number.isInteger(error.line) && error.line >= 1, '要指出行号');
      assert.ok(Number.isInteger(error.column) && error.column >= 1, '要指出列号');
      assert.match(error.message, /^demo\.yaml:\d+:\d+: /);
      assert.match(error.message, pattern);
      return true;
    }, `${JSON.stringify(text)} 应当报错`);
  }
});

/* ── pyStrip 与 resolvePlainScalar ────────────────────────────────────── */

test('pyStrip 等于 Python 的 str.strip()：认那串冷门空白，不认 BOM', () => {
  assert.equal(pyStrip('\u3000\xa0\x1c \u4e2d \x1f\u2028\u2003'), '中');
  assert.equal(pyStrip('\t\n\r 中 \v\f'), '中');
  assert.equal(pyStrip('中'), '中');
  // \ufeff 不在 Python 的空白集合里：只去首尾，不动中间
  assert.equal(pyStrip('\ufeff中\ufeff'), '\ufeff中\ufeff');
  assert.equal(pyStrip('中 间'), '中 间');
});

test('resolvePlainScalar 的判定表（含六十进制这种冷门写法）', () => {
  const cases = [
    ['', null], ['~', null], ['null', null], ['NULL', null],
    ['yes', true], ['TRUE', true], ['on', true],
    ['no', false], ['off', false], ['False', false],
    ['0.85', 0.85], ['0x1f', 31], ['012', 10],
    ['1:30', 90], ['1:30.5', 90.5],
    // 时间戳按原字符串返回：本仓库不建日期对象
    ['2026-05-06', '2026-05-06'], ['abc', 'abc'], ['hello world', 'hello world'],
  ];
  for (const [raw, expected] of cases) {
    assert.deepEqual(resolvePlainScalar(raw), expected, `${JSON.stringify(raw)}`);
  }
});

/* ── workspace：配置读取 ──────────────────────────────────────────────── */

test('两种真实形态都认：手写的块映射，与安装器写的「注释 + JSON」', () => {
  const dir = tmpDir();
  const blockForm = path.join(dir, 'block.yaml');
  fs.writeFileSync(blockForm, '# 注释一行\nworkspace: "/tmp/手写 的工作区"\nroot: /tmp/引擎\n');
  assert.equal(resolveWorkspace(blockForm), '/tmp/手写 的工作区');
  assert.equal(resolveRoot(blockForm), '/tmp/引擎');

  // bin/studymate.mjs 的 installPayload 就是这么写的：注释 + 多行流式映射
  const installerForm = path.join(dir, 'installer.yaml');
  fs.writeFileSync(installerForm, `# StudyMate 学习工作区与引擎项目定位\n${
    JSON.stringify({ workspace: '/tmp/安装器 写的', root: '/tmp/引擎' }, null, 2)}\n`);
  assert.equal(resolveWorkspace(installerForm), '/tmp/安装器 写的');
  assert.equal(resolveRoot(installerForm), '/tmp/引擎');
});

test('读不出来一律给空串，由调用方给「先跑安装」这类可操作的提示', () => {
  const dir = tmpDir();
  assert.equal(resolveWorkspace(path.join(dir, '没有这个文件.yaml')), '');

  const cases = [
    '',
    '# 只有注释\n',
    'root: /tmp/引擎\n',
    'workspace:\n',
    'workspace: ""\n',
    'workspace: "   "\n',
    'workspace: [a, b]\n',
    'workspace: 3\n',
    'workspace: true\n',
  ];
  for (const [index, text] of cases.entries()) {
    const file = path.join(dir, `case-${index}.yaml`);
    fs.writeFileSync(file, text);
    assert.equal(resolveWorkspace(file), '', `${JSON.stringify(text)} 应当给空串`);
  }
  // 读不动的文件（当目录用）也给空串，不抛错
  assert.equal(resolveWorkspace(dir), '');
});

test('配置里的空白会被去掉：路径不会带上手滑的空格', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'pad.yaml');
  fs.writeFileSync(file, 'workspace: "  /tmp/工作区  "\n');
  assert.equal(resolveWorkspace(file), '/tmp/工作区');
});

test('默认配置位置：DSH_HOME 优先，其次是 ~/.dsh', () => {
  const saved = process.env.DSH_HOME;
  const dir = tmpDir();
  try {
    process.env.DSH_HOME = dir;
    assert.equal(dshHome(), dir);
    assert.equal(configFile(), path.join(dir, 'studymate-config.yaml'));
    // 不传参数时读的就是这个默认位置
    fs.writeFileSync(configFile(), 'workspace: /tmp/默认位置\n');
    assert.equal(resolveWorkspace(), '/tmp/默认位置');

    delete process.env.DSH_HOME;
    assert.equal(configFile(), path.join(os.homedir(), '.dsh', 'studymate-config.yaml'));
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
  }
});
