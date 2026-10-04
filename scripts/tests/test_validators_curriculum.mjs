/* 大纲校验（lib/core/validate.ts 的 validateCurriculum）与「带位置的 YAML 读取」
   （lib/core/yamlpos.ts）的逐条断言。
   ────────────────────────────────────────────────────────────────────────
   两条主线：

   1. **行号要真**。`check_curriculum.py` 那种「文本搜索找行号」在这里是明确的反面教材，
      所以夹具里专门放一行**注释**，里面逐字写着跟真位置一样的 `prerequisites: [c]`——
      文本搜索会指向注释那一行，解析位置不会。
   2. **每类问题逐条报**，带上 file / line / blocking，而不是一句「失败」。

   另外拿 `lib/yaml.{ts,mjs}` 真解析一遍，把值树里**每一条路径**拿来问位置索引
   「你在第几行」：对不上就红。这条是这一层与解析器不失配的兜底。 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { indexYaml } from '../../lib/core/yamlpos.ts';
import { validateCurriculum } from '../../lib/core/validate.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CURRICULUM_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'curriculum.schema.json'), 'utf8'));

/** #65 正在把 lib/yaml.mjs 改名成 lib/yaml.ts，两边都在的时候取存在的那个。 */
async function loadYamlParser() {
  for (const name of ['yaml.ts', 'yaml.mjs']) {
    const file = path.join(ROOT, 'lib', name);
    if (fs.existsSync(file)) return import(pathToFileURL(file).href);
  }
  throw new Error('lib/yaml.ts 与 lib/yaml.mjs 都不在：交叉校验这一步没有解析器可用');
}

const { parseYaml } = await loadYamlParser();

function parseFixture(text) {
  return parseYaml(text, { file: '内存夹具' });
}

function valuePaths(value, prefix = [], out = []) {
  out.push(prefix);
  if (Array.isArray(value)) value.forEach((item, index) => valuePaths(item, [...prefix, index], out));
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) valuePaths(child, [...prefix, key], out);
  }
  return out;
}

function messages(report) {
  return report.problems.map((problem) => problem.message);
}

function find(report, needle) {
  return report.problems.find((problem) => problem.message.includes(needle));
}

/* ── 一、位置索引：真行号 ─────────────────────────────────────────────── */

test('映射键、列表项、流式集合元素都拿到自己的行', () => {
  const text = [
    'nodes:',                          // 1
    '  - id: a',                       // 2
    '    title: A',                    // 3
    '    prerequisites: [b, c]',       // 4
    '  - id: b',                       // 5
    '    prerequisites:',              // 6
    '      - a',                       // 7
    '',                                // 8
    'edges: []',                       // 9
    '',
  ].join('\n');
  const index = indexYaml(text);
  assert.deepEqual(index.at(['nodes']), { line: 1, column: 1, exact: true });
  assert.deepEqual(index.at(['nodes', 0]), { line: 2, column: 3, exact: true });
  assert.deepEqual(index.at(['nodes', 0, 'title']), { line: 3, column: 5, exact: true });
  assert.deepEqual(index.at(['nodes', 0, 'prerequisites', 0]), { line: 4, column: 21, exact: true });
  assert.deepEqual(index.at(['nodes', 0, 'prerequisites', 1]), { line: 4, column: 24, exact: true });
  assert.deepEqual(index.at(['nodes', 1, 'prerequisites', 0]), { line: 7, column: 7, exact: true });
  assert.deepEqual(index.at(['edges']), { line: 9, column: 1, exact: true });
  assert.ok(index.size >= 9, `索引条目太少：${index.size}`);
});

test('查不到的路径回退到最近的祖先，并说明自己不是精确位置', () => {
  const index = indexYaml('nodes:\n  - id: a\n');
  assert.deepEqual(index.at(['nodes', 0, 'objective']), { line: 2, column: 3, exact: false });
  assert.deepEqual(index.at(['压根没有这个键']), { line: 1, column: 1, exact: false });
  assert.deepEqual(indexYaml('').at(['a', 'b']), { line: 1, column: 1, exact: false });
});

test('注释行与空行不参与结构：夹具里的诱饵注释不会被当成位置', () => {
  const text = [
    '# 诱饵：prerequisites: [c]、id: b 都写在这里',   // 1
    '',                                               // 2
    'nodes:',                                         // 3
    '  - id: a                                       # 尾部注释也不影响', // 4
    '    prerequisites: [c]',                         // 5
    '',
  ].join('\n');
  const index = indexYaml(text);
  assert.equal(index.at(['nodes']).line, 3);
  assert.equal(index.at(['nodes', 0]).line, 4);
  assert.equal(index.at(['nodes', 0, 'prerequisites']).line, 5);
  assert.equal(index.at(['nodes', 0, 'prerequisites', 0]).line, 5);
});

test('引号里的 # 与 : 不改变结构', () => {
  const text = [
    'title: "关于 a: b 的说明 # 不是注释"',
    "slug: 'it''s fine'",
    'url: https://example.com/a:b',
    'tags: [x, y]',
  ].join('\n');
  const index = indexYaml(text);
  assert.equal(index.at(['title']).line, 1);
  assert.equal(index.at(['slug']).line, 2);
  assert.equal(index.at(['url']).line, 3);
  assert.equal(index.at(['tags', 1]).line, 4);
});

test('数字/布尔键按解析后的键名索引（PyYAML 也这么读）', () => {
  const text = ['true: 是', '1: 一', 'no: 否'].join('\n');
  const value = parseFixture(text);
  // JS 对象的整数样式键会被排到前面（`'1'` 是数组下标），所以只比集合、不比顺序
  assert.deepEqual([...Object.keys(value)].sort(), ['1', 'false', 'true']);
  const index = indexYaml(text);
  for (const key of Object.keys(value)) assert.equal(index.at([key]).exact, true, key);
});

test('与 lib/yaml 的值树逐路径对齐：每一条路径都必须是精确位置', () => {
  const corpus = [
    [
      'nodes:',
      '  - id: a',
      '    title: A',
      '    prerequisites: []',
      '    concepts:',
      '      - 一',
      '      - 二',
      '  - id: b',
      '    title: B',
      '    prerequisites:',
      '      - a',
      '      - c',
      'nested:',
      '  deep:',
      '    deeper:',
      '      - name: 一层',
      '        value: 1',
      '      - name: 两层',
      '        value: 2',
      'flow: {a: 1, b: 2}',
      'nestedFlow: [[1, 2], [3, 4]]',
      'quoted: "带 : 与 # 的标量"',
      'blank:',
      'trailing: 收尾',
    ].join('\n'),
    // 顶格列表：键在 0 列、列表项也在 0 列，解析器认这种写法
    ['pitfalls:', '- 一', '- 二', 'next: 值'].join('\n'),
    ['# 只有注释', '', 'a: 1'].join('\n'),
    'single: 一个标量',
  ];
  for (const text of corpus) {
    const index = indexYaml(text);
    const value = parseFixture(text);
    for (const valuePath of valuePaths(value)) {
      const hit = index.at(valuePath);
      assert.equal(
        hit.exact, true,
        `路径 ${JSON.stringify(valuePath)} 没有精确位置（回退到了第 ${hit.line} 行）\n夹具：\n${text}`,
      );
    }
  }
});

test('流式映射与引号键：键和嵌套集合的元素都拿到列号', () => {
  const text = [
    'map: {k1: v1, k2: [1, 2]}',
    'deep: { outer: { inner: 7 } }',
    '"引号键": 1',
    "1: 一",
  ].join('\n');
  const value = parseFixture(text);
  // 键名按解析后的值来（引号剥掉、整数样式键 String 化）
  assert.deepEqual([...Object.keys(value)].sort(), ['1', 'deep', 'map', '引号键']);
  const index = indexYaml(text);
  assert.deepEqual(index.at(['map', 'k1']), { line: 1, column: 7, exact: true });
  assert.deepEqual(index.at(['map', 'k2']), { line: 1, column: 15, exact: true });
  assert.deepEqual(index.at(['map', 'k2', 0]), { line: 1, column: 20, exact: true });
  assert.deepEqual(index.at(['map', 'k2', 1]), { line: 1, column: 23, exact: true });
  assert.deepEqual(index.at(['deep', 'outer', 'inner']), { line: 2, column: 18, exact: true });
  assert.deepEqual(index.at(['引号键']), { line: 3, column: 1, exact: true });
  assert.deepEqual(index.at(['1']), { line: 4, column: 1, exact: true });
  for (const valuePath of valuePaths(value)) assert.equal(index.at(valuePath).exact, true, JSON.stringify(valuePath));
});

test('自己把握不了的结构**降级**而不是猜：跨行流式集合只记集合自己', () => {
  const text = ['tags: [', '  a,', '  b,', ']'].join('\n');
  const index = indexYaml(text);
  const hit = index.at(['tags', 0]);
  assert.equal(hit.exact, false);
  assert.equal(hit.line, 1, '回退到 tags 所在的那一行，而不是随便指一行');
});

/* ── 二、大纲校验：逐条问题 ───────────────────────────────────────────── */

// 夹具行号是**写死**的：第 1 行的注释里逐字带着 `prerequisites: [c]`，而真位置在第 13 行。
// 任何靠文本搜索找行号的实现在这里都会指向 1。
const INVERTED = [
  '# 诱饵注释：prerequisites: [c] 这一串在真文件里出现在第 13 行',  // 1
  'nodes:',                                                        // 2
  '  - id: a',                                                     // 3
  '    title: A',                                                  // 4
  '    kind: 概念',                                                 // 5
  '    objective: o',                                              // 6
  '    prerequisites: []',                                         // 7
  '    status: 未开始',                                             // 8
  '  - id: b',                                                     // 9
  '    title: B',                                                  // 10
  '    kind: 概念',                                                 // 11
  '    objective: o',                                              // 12
  '    prerequisites: [c]',                                        // 13
  '    status: 未开始',                                             // 14
  '  - id: c',                                                     // 15
  '    title: C',                                                  // 16
  '    kind: 概念',                                                 // 17
  '    objective: o',                                              // 18
  '    prerequisites: []',                                         // 19
  '    status: 未开始',                                             // 20
  'edges: []',                                                     // 21
  '',
].join('\n');

test('位次倒挂：报出依赖方与被依赖方的位次，行号指到真的那一行', () => {
  assert.equal(INVERTED.split('\n')[0].includes('prerequisites: [c]'), true, '诱饵注释必须在第 1 行');
  const report = validateCurriculum({
    file: 'demo/curriculum.yaml',
    text: INVERTED,
    value: parseFixture(INVERTED),
    schema: CURRICULUM_SCHEMA,
  });
  assert.equal(report.blocking, true);
  const problem = find(report, '依赖只能指向前面的节点');
  assert.ok(problem, `没有报出位次倒挂：${JSON.stringify(messages(report))}`);
  assert.equal(problem.file, 'demo/curriculum.yaml');
  assert.equal(problem.line, 13, '行号必须是 prerequisites 那一行（第 1 行的诱饵注释不算）');
  assert.equal(problem.blocking, true);
  assert.match(problem.message, /b（第 2 位）依赖 c（第 3 位）/);
  // 这份大纲只有这一条阻断
  assert.equal(report.blockingCount, 1, JSON.stringify(messages(report)));
});

test('重复 id、悬空引用（prerequisites 与 edges）各自逐条报出来', () => {
  const text = [
    'nodes:',                          // 1
    '  - id: a',                       // 2
    '    title: A',                    // 3
    '    kind: 概念',                   // 4
    '    objective: o',                // 5
    '    prerequisites: [nope]',       // 6
    '    status: 未开始',               // 7
    '  - id: a',                       // 8
    '    title: A2',                   // 9
    '    kind: 概念',                   // 10
    '    objective: o',                // 11
    '    prerequisites: []',           // 12
    '    status: 未开始',               // 13
    'edges:',                          // 14
    '  - from: a',                     // 15
    '    to: 不存在',                   // 16
    '    reason: r',                   // 17
    '',
  ].join('\n');
  const report = validateCurriculum({ file: 'curriculum.yaml', text, value: parseFixture(text), schema: CURRICULUM_SCHEMA });
  assert.equal(find(report, '重复 id: a').line, 8);
  assert.equal(find(report, '引用了不存在的节点 nope').line, 6);
  assert.equal(find(report, 'to 指向不存在的节点 不存在').line, 16);
  for (const problem of report.problems) {
    assert.equal(problem.file, 'curriculum.yaml');
    assert.equal(problem.blocking, true);
  }
});

test('环：DAG 是硬要求，拓扑排序排不掉的节点逐个点名', () => {
  const text = [
    'nodes:',
    '  - id: a',
    '    title: A',
    '    kind: 概念',
    '    objective: o',
    '    prerequisites: [b]',
    '    status: 未开始',
    '  - id: b',
    '    title: B',
    '    kind: 概念',
    '    objective: o',
    '    prerequisites: [a]',
    '    status: 未开始',
    'edges: []',
    '',
  ].join('\n');
  const report = validateCurriculum({ file: 'curriculum.yaml', text, value: parseFixture(text), schema: CURRICULUM_SCHEMA });
  const cycle = find(report, '存在环');
  assert.ok(cycle, JSON.stringify(messages(report)));
  assert.match(cycle.message, /2 个节点排不出拓扑序（a, b）/);
  assert.equal(cycle.blocking, true);
  assert.equal(cycle.line, 1, '环是整张图的性质，指向 nodes 那一行');
  // a（第 1 位）依赖 b（第 2 位）也是倒挂
  assert.ok(find(report, 'a（第 1 位）依赖 b（第 2 位）'));
});

test('实验课 prerequisites 为空要拦住；字段缺失按 schema 逐条报', () => {
  const text = [
    'nodes:',                          // 1
    '  - id: lab.one',                 // 2
    '    title: 实验一',                // 3
    '    kind: 实验',                   // 4
    '    prerequisites: []',           // 5
    '    status: 未开始',               // 6
    'edges: []',                       // 7
    '',
  ].join('\n');
  const report = validateCurriculum({ file: 'curriculum.yaml', text, value: parseFixture(text), schema: CURRICULUM_SCHEMA });
  const lab = find(report, '实验课必须有 prerequisites');
  assert.ok(lab, JSON.stringify(messages(report)));
  assert.equal(lab.line, 5);
  assert.equal(lab.blocking, true);
  const missing = find(report, '缺少必填字段 objective');
  assert.ok(missing, JSON.stringify(messages(report)));
  assert.equal(missing.line, 2, '缺字段的行号回退到它所属的列表项那一行');
  assert.equal(missing.blocking, true);
  const orphan = find(report, '末端节点');
  assert.equal(orphan.blocking, false);
  assert.match(report.summary, /^curriculum\.yaml：阻断——/);
});

test('结构坏掉时先报结构，不把同一件事重复说一遍', () => {
  const report = validateCurriculum({
    file: 'curriculum.yaml',
    value: { nodes: '不是数组', edges: [] },
    schema: CURRICULUM_SCHEMA,
  });
  assert.ok(messages(report).some((message) => message.includes('nodes 必须是数组')));
  assert.equal(report.problems.some((problem) => problem.message.includes('存在环')), false);
  assert.equal(report.blocking, true);
});

test('一份干净的大纲：零阻断，只剩提示', () => {
  const text = [
    'nodes:',
    '  - id: a',
    '    title: A',
    '    kind: 概念',
    '    objective: o',
    '    prerequisites: []',
    '    status: 未开始',
    '  - id: lab.one',
    '    title: 实验一',
    '    kind: 实验',
    '    objective: o',
    '    prerequisites: [a]',
    '    status: 未开始',
    'edges: []',
    '',
  ].join('\n');
  const report = validateCurriculum({ file: 'curriculum.yaml', text, value: parseFixture(text), schema: CURRICULUM_SCHEMA });
  assert.equal(report.blocking, false);
  assert.equal(report.blockingCount, 0);
  assert.match(report.summary, /放行/);
  // lab.one 没人依赖，是一条提示；它不该阻断
  assert.deepEqual(report.problems.map((problem) => problem.blocking), [false]);
});

test('没给原文时行号诚实退化成 1，不编一个', () => {
  const bad = validateCurriculum({
    file: 'curriculum.yaml',
    value: { nodes: {}, edges: [] },
    schema: CURRICULUM_SCHEMA,
  });
  assert.ok(bad.problems.length > 0);
  for (const problem of bad.problems) {
    assert.equal(problem.line, 1);
    assert.equal(problem.file, 'curriculum.yaml');
  }
  const ok = validateCurriculum({
    file: 'curriculum.yaml',
    value: { nodes: [], edges: [] },
    schema: CURRICULUM_SCHEMA,
  });
  assert.deepEqual(ok.problems, []);
});

test('顶层不是 mapping 时报一条，不抛异常', () => {
  for (const value of [null, 3, 'x', [1, 2]]) {
    const report = validateCurriculum({ file: 'curriculum.yaml', value, schema: CURRICULUM_SCHEMA });
    assert.equal(report.blocking, true);
    assert.ok(report.problems.some((problem) => problem.message.includes('顶层不是 mapping')));
  }
});

test('schema 里用了没实现的关键字：问题照样逐条报，而且算阻断', () => {
  const report = validateCurriculum({
    file: 'curriculum.yaml',
    value: { nodes: [], edges: [] },
    schema: { type: 'object', required: ['nodes', 'edges'], oneOf: [{ required: ['nodes'] }] },
  });
  const problem = find(report, 'oneOf');
  assert.ok(problem, JSON.stringify(messages(report)));
  assert.equal(problem.blocking, true);
});
