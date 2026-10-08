/* 大纲校验（lib/core/validate.ts 的 validateCurriculum）与「带位置的 YAML 读取」
   （lib/core/yamlpos.ts）的逐条断言。
   ────────────────────────────────────────────────────────────────────────
   两条主线：

   1. **行号要真**。迁移前那版「文本搜索找行号」的做法在这里是明确的反面教材，
      所以夹具里专门放一行**注释**，里面逐字写着跟真位置一样的 `prerequisites: [c]`——
      文本搜索会指向注释那一行，解析位置不会。
   2. **每类问题逐条报**，带上 file / line / blocking，而不是一句「失败」。

   另外拿 `lib/yaml.ts` 真解析一遍，把值树里**每一条路径**拿来问位置索引
   「你在第几行」：对不上就红。这条是这一层与解析器不失配的兜底。 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { indexYaml } from '../../lib/core/yamlpos.ts';
import { parseYaml } from '../../lib/yaml.ts';
import { validateCurriculum, validateResources } from '../../lib/core/validate.ts';
import { resourceEntries } from '../../lib/core/resources.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CURRICULUM_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'curriculum.schema.json'), 'utf8'));

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

/* ── 六、「资源清单」的覆盖率（validateResources，#130）──────────────────
   「够了」的判据：每个节点至少一处来源（不少）、条数不超过节点数 × 2（不膨胀）。
   判据全在**提示**上——「服务 <节点 id>」是新加的写法，现存清单一条都没有，判阻断等于
   升级即整片变红。这一组测的是纯函数那一层，不碰盘。 */

const RESOURCES_TEXT = [
  '# 资源清单',                                     // 1
  '',                                              // 2
  '## Knowledge',                                  // 3
  '',                                              // 4
  '- [A](https://a.example/1) · 服务 var',          // 5
  '- [B](https://b.example/2) · 服务 fn、var',      // 6（一条服务两个节点）
  '- [C](https://c.example/3)',                     // 7（没写服务标记）
  '',                                              // 8
  '## 易变内容的官方核对来源',                       // 9
  '',                                              // 10
  '- [D](https://d.example/4) · 服务 fn',           // 11
  '',                                              // 12
  '## Wisdom (Communities)',                       // 13
  '',                                              // 14
  '- [社区](https://forum.example) · 服务 var',      // 15（社区不是来源）
  '',                                              // 16
  '## Gaps',                                       // 17
  '',                                              // 18
  '- 缺一块',                                       // 19（缺口不是来源）
  '',                                              // 20
].join('\n');

test('清单条目：服务标记按行摘出，社区与 Gaps 的条目不算来源', () => {
  const entries = resourceEntries(RESOURCES_TEXT);
  assert.deepEqual(entries.map((entry) => entry.line), [5, 6, 7, 11, 15, 19]);
  assert.deepEqual(entries.map((entry) => entry.heading),
    ['Knowledge', 'Knowledge', 'Knowledge', '易变内容的官方核对来源', 'Wisdom (Communities)', 'Gaps']);
  assert.deepEqual(entries.map((entry) => entry.nodes),
    [['var'], ['fn', 'var'], [], ['fn'], ['var'], []]);
  // 没写标记、认不出形状的 token 都**如实留着**，不在这里悄悄丢掉（那是校验器的判断）。
  const bogus = resourceEntries(['## Knowledge', '- [X](https://x.example) · 服务 大写.不是id'].join('\n'));
  assert.deepEqual(bogus[0].nodes, ['大写.不是id']);
});

test('覆盖率：每个节点至少一处来源，指不出的逐条报出（全是提示）', () => {
  const report = validateResources({
    file: 'RESOURCES.md', markdown: RESOURCES_TEXT, nodeIds: ['var', 'fn', 'extra'],
  });
  assert.equal(report.blocking, false);
  assert.equal(report.blockingCount, 0);
  assert.ok(find(report, '还有 1 个节点指不出一处来源（共 3 个节点）：extra'), JSON.stringify(messages(report)));
  const one = find(report, '节点 extra 指不出一处来源');
  assert.ok(one, JSON.stringify(messages(report)));
  assert.equal(one.line, 1);
  assert.equal(one.blocking, false);
  // 第 7 行那条没写服务标记：如实报出条数，且它不参与覆盖率。
  assert.ok(find(report, '1 条来源条目没写「服务 <节点 id>」'), JSON.stringify(messages(report)));
  // 没超限、没造词。
  assert.equal(find(report, '清单在膨胀'), undefined);
  assert.equal(find(report, '不存在的节点 id'), undefined);
});

test('覆盖率：一条服务多个节点时计数正确；来源够就不报「指不出」', () => {
  const report = validateResources({
    file: 'RESOURCES.md', markdown: RESOURCES_TEXT, nodeIds: ['var', 'fn'],
  });
  assert.equal(find(report, '指不出一处来源'), undefined, JSON.stringify(messages(report)));
  // 社区与 Gaps 里的条目不参与条数：来源条目只有第 5、6、7、11 行四条。
  assert.equal(find(report, '清单在膨胀'), undefined);
});

test('条数超限如实报出：来源条目 > 节点数 × 2', () => {
  const report = validateResources({
    file: 'RESOURCES.md', markdown: RESOURCES_TEXT, nodeIds: ['var'],
  });
  const over = find(report, '清单条目 4 条 > 节点数 1 × 2 = 2');
  assert.ok(over, JSON.stringify(messages(report)));
  assert.equal(over.blocking, false);
  assert.match(over.message, /清单在膨胀/);
});

test('「服务」里写了不存在的节点 id：如实报出并指到那一行', () => {
  const report = validateResources({
    file: 'RESOURCES.md',
    markdown: ['## Knowledge', '- [A](https://a.example/1) · 服务 自己造的词', '- [B](https://b.example/2) · 服务 var'].join('\n'),
    nodeIds: ['var'],
  });
  const problem = find(report, '不存在的节点 id: 自己造的词');
  assert.ok(problem, JSON.stringify(messages(report)));
  assert.equal(problem.line, 2);
  assert.equal(problem.blocking, false);
});

test('清单一条标记都没有：每个节点都报「指不出一处来源」，且说清有几条没写标记', () => {
  const report = validateResources({
    file: 'RESOURCES.md',
    markdown: ['## Knowledge', '- [A](https://a.example/1)', '- [B](https://b.example/2)'].join('\n'),
    nodeIds: ['var', 'fn'],
  });
  assert.ok(find(report, '还有 2 个节点指不出一处来源（共 2 个节点）：var、fn'), JSON.stringify(messages(report)));
  assert.ok(find(report, '节点 var 指不出一处来源'));
  assert.ok(find(report, '节点 fn 指不出一处来源'));
  assert.ok(find(report, '2 条来源条目没写「服务 <节点 id>」'));
  assert.equal(report.blocking, false);
});
