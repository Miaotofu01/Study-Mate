/* 特征化测试：Host 半数据层 · lib/yaml.mjs 的子集解析 与 lib/workspace.mjs 的配置读取
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
