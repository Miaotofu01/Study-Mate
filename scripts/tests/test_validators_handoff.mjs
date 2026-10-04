/* 交接门禁（lib/core/validate.ts 的 validateHandoff）的逐条断言。
   ────────────────────────────────────────────────────────────────────────
   验收标准点名的一条是「门禁给出**阻断结论**，不是『看起来没问题』」。所以每个非法夹具都断言
   三件事：`verdict` 是 `block`、`blocking` 是 `true`、以及**具体那一条**问题（文件 + 行号 +
   阻断标志）确实在列表里。

   这一层不碰文件系统：盘上快照由测试走一遍 `fs` 得到（`snapshot` 就是将来工具里那个
   walker 的样子，十几行），再喂进去。夹具在 `fs.mkdtemp` 造的临时目录里，跑完即弃。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { validateHandoff } from '../../lib/core/validate.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HANDOFF_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'agent-handoff.schema.json'), 'utf8'));

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
});

/* ── 盘上快照：将来工具里那个 walker 的样子 ───────────────────────────── */

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function snapshot(stage) {
  const entries = [];
  const walk = (directory, prefix = '') => {
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      const full = path.join(directory, dirent.name);
      if (dirent.isSymbolicLink()) entries.push({ path: relative, kind: 'symlink', target: fs.readlinkSync(full) });
      else if (dirent.isDirectory()) {
        entries.push({ path: relative, kind: 'dir' });
        walk(full, relative);
      } else if (dirent.isFile()) entries.push({ path: relative, kind: 'file', sha256: sha256(full) });
      else entries.push({ path: relative, kind: 'other' });
    }
  };
  if (fs.existsSync(stage)) walk(stage);
  return entries;
}

/* ── 夹具 ─────────────────────────────────────────────────────────────── */

function makeStage(name, {
  manifest = manifestOf(), rawManifest, files = {}, dirs = [], symlinks = {},
  omitManifest = false, omitDeliver = false, rootSymlinks = {},
} = {}) {
  const stage = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `studymate-handoff-${name}-`));
  TEMPS.push(stage);
  if (!omitDeliver) fs.mkdirSync(path.join(stage, 'deliver'), { recursive: true });
  for (const dir of dirs) fs.mkdirSync(path.join(stage, 'deliver', dir), { recursive: true });
  for (const [relative, text] of Object.entries(files)) {
    const full = path.join(stage, 'deliver', relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  for (const [relative, target] of Object.entries(symlinks)) {
    const full = path.join(stage, 'deliver', relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.symlinkSync(target, full);
  }
  if (!omitManifest) {
    const text = rawManifest !== undefined ? rawManifest : `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(path.join(stage, 'handoff.json'), text);
  }
  for (const [relative, target] of Object.entries(rootSymlinks)) {
    fs.symlinkSync(target, path.join(stage, relative));
  }
  return stage;
}

function manifestOf(overrides = {}) {
  return {
    schema_version: 1,
    role: 'curriculum-designer',
    subject: 'linear-algebra',
    node_id: null,
    status: 'succeeded',
    outputs: [{ path: 'curriculum.yaml', kind: 'file' }],
    checks: [{ name: 'check_curriculum', status: 'passed' }],
    gaps: [],
    ...overrides,
  };
}

const VALID_FILES = { 'curriculum.yaml': 'nodes: []\nedges: []\n' };

function gate(stage, { role = 'curriculum-designer', node, schema = HANDOFF_SCHEMA, text } = {}) {
  const manifestFile = path.join(stage, 'handoff.json');
  const manifestText = text !== undefined ? text : (fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, 'utf8') : '');
  return validateHandoff({
    stagePath: stage,
    manifestText,
    entries: snapshot(stage),
    expectedRole: role,
    expectedNode: node,
    schema,
  });
}

const messages = (verdict) => verdict.problems.map((problem) => problem.message);
const find = (verdict, needle) => verdict.problems.find((problem) => problem.message.includes(needle));

function assertBlocked(verdict, needle) {
  assert.equal(verdict.verdict, 'block', `应当阻断，实际放行：${JSON.stringify(messages(verdict))}`);
  assert.equal(verdict.blocking, true);
  assert.match(verdict.summary, /^阻断：/);
  const problem = find(verdict, needle);
  assert.ok(problem, `没有报出「${needle}」：${JSON.stringify(messages(verdict))}`);
  assert.equal(problem.blocking, true);
  assert.notEqual(problem.file, undefined);
  assert.equal(typeof problem.line, 'number');
  return problem;
}

/* ── 一、合法交接：明确放行 ───────────────────────────────────────────── */

test('合法的科目级交接：verdict 是 pass，结论不是「看起来没问题」', () => {
  const stage = makeStage('ok', { files: VALID_FILES });
  const verdict = gate(stage);
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.blocking, false);
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.role, 'curriculum-designer');
  assert.equal(verdict.outputs, 1);
  assert.match(verdict.summary, /^放行：/);
  assert.match(verdict.summary, /这只说明边界合法，领域校验仍要各跑各的/);
});

test('合法的节点级交接：node_id 对上就放行', () => {
  const stage = makeStage('node-ok', {
    manifest: manifestOf({ role: 'practice-evaluator', node_id: 'system.elimination' }),
    files: VALID_FILES,
  });
  const verdict = gate(stage, { role: 'practice-evaluator', node: 'system.elimination' });
  assert.equal(verdict.verdict, 'pass');
  assert.deepEqual(verdict.problems, []);
});

test('kind=tree 覆盖整棵子树，sha256 对上就放行', () => {
  const stage = makeStage('tree', {
    manifest: manifestOf({ outputs: [{ path: 'lessons', kind: 'tree' }] }),
    files: { 'lessons/0001-a.md': 'x', 'lessons/0002-b.md': 'y' },
  });
  assert.equal(gate(stage).verdict, 'pass');

  const hashed = makeStage('hash', {
    manifest: manifestOf({ outputs: [{ path: 'curriculum.yaml', kind: 'file', sha256: sha256Text(VALID_FILES['curriculum.yaml']) }] }),
    files: VALID_FILES,
  });
  assert.equal(gate(hashed).verdict, 'pass');
});

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/* ── 二、stage 级：manifest 与 deliver/ ───────────────────────────────── */

test('缺 handoff.json / 缺 deliver/ 各自阻断', () => {
  const noManifest = makeStage('no-manifest', { omitManifest: true, files: VALID_FILES });
  assertBlocked(gate(noManifest), 'stage 根缺 handoff.json');

  const noDeliver = makeStage('no-deliver', { omitDeliver: true });
  assertBlocked(gate(noDeliver), 'stage 根缺 deliver/');
});

test('handoff.json / deliver/ 是符号链接一律阻断（协议第 52 行）', () => {
  const stage = makeStage('symlink-root', {
    omitManifest: true,
    files: VALID_FILES,
  });
  fs.writeFileSync(path.join(stage, 'real.json'), JSON.stringify(manifestOf()));
  fs.symlinkSync(path.join(stage, 'real.json'), path.join(stage, 'handoff.json'));
  const linkVerdict = gate(stage);
  assertBlocked(linkVerdict, 'handoff.json 不能是符号链接');

  const deliverStage = makeStage('symlink-deliver', { omitDeliver: true });
  fs.mkdirSync(path.join(deliverStage, 'real-deliver'));
  fs.symlinkSync(path.join(deliverStage, 'real-deliver'), path.join(deliverStage, 'deliver'));
  assertBlocked(gate(deliverStage), 'deliver/ 不能是符号链接');
});

test('deliver/ 里出现符号链接一律阻断', () => {
  const stage = makeStage('symlink-inside', {
    files: { 'real.md': 'x' },
    symlinks: { '链接.md': 'real.md' },
    manifest: manifestOf({ outputs: [{ path: 'real.md', kind: 'file' }, { path: '链接.md', kind: 'file' }] }),
  });
  assertBlocked(gate(stage), 'deliver 里不能有符号链接');
});

/* ── 三、覆盖：多出来的顺手文件阻断合盘 ───────────────────────────────── */

test('deliver/ 有未声明产物：阻断，并逐个点名（超过 8 个省略）', () => {
  const stage = makeStage('undeclared', {
    files: { ...VALID_FILES, '顺手.md': 'x', '草稿.md': 'y' },
  });
  const problem = assertBlocked(gate(stage), 'deliver/ 有未声明产物');
  assert.match(problem.message, /顺手\.md/);
  assert.match(problem.message, /草稿\.md/);
});

test('声明了盘上没有的产物：阻断', () => {
  const stage = makeStage('missing-output', {
    manifest: manifestOf({ outputs: [{ path: 'curriculum.yaml', kind: 'file' }, { path: '没有这个.md', kind: 'file' }] }),
    files: VALID_FILES,
  });
  assertBlocked(gate(stage), 'output 在盘上不存在: deliver/没有这个.md');
});

/* ── 四、路径边界 ─────────────────────────────────────────────────────── */

test('output.path 的边界：.. / 绝对路径 / 盘符 / 反斜杠 / 空段，逐条阻断', () => {
  const cases = [
    ['../外面.md', /不能含空段、\. 或 \.\./],
    ['a/../../外面.md', /不能含空段、\. 或 \.\./],
    ['/etc/passwd', /必须是 deliver\/ 下的相对路径/],
    ['C:/Windows/system32', /必须是 deliver\/ 下的相对路径/],
    ['a\\b.md', /必须用 \/，不能含反斜杠/],
    ['a//b.md', /不能含空段、\. 或 \.\./],
    ['./a.md', /不能含空段、\. 或 \.\./],
  ];
  for (const [declared, pattern] of cases) {
    const stage = makeStage(`path-${declared.replace(/[^a-z0-9]+/gi, '-')}`, {
      manifest: manifestOf({ outputs: [{ path: declared, kind: 'file' }] }),
      files: { 'a.md': 'x' },
    });
    const problem = assertBlocked(gate(stage), 'output.path');
    assert.match(problem.message, pattern, declared);
    assert.ok(problem.message.includes(declared), `报错里要带上原路径：${problem.message}`);
  }
});

test('outputs 重复声明同一路径：阻断', () => {
  const stage = makeStage('dup-output', {
    manifest: manifestOf({ outputs: [{ path: 'curriculum.yaml', kind: 'file' }, { path: 'curriculum.yaml', kind: 'file' }] }),
    files: VALID_FILES,
  });
  assertBlocked(gate(stage), 'outputs 重复声明路径: curriculum.yaml');
});

/* ── 五、类型与 sha256 ───────────────────────────────────────────────── */

test('kind 与盘上类型不符、tree 为空、tree 带 sha256，都阻断', () => {
  const asDir = makeStage('file-vs-dir', {
    manifest: manifestOf({ outputs: [{ path: 'lessons', kind: 'file' }] }),
    files: { 'lessons/a.md': 'x' },
  });
  assertBlocked(gate(asDir), 'kind=file 但盘上不是普通文件');

  const asFile = makeStage('tree-vs-file', {
    manifest: manifestOf({ outputs: [{ path: 'curriculum.yaml', kind: 'tree' }] }),
    files: VALID_FILES,
  });
  assertBlocked(gate(asFile), 'kind=tree 但盘上不是目录');

  const emptyTree = makeStage('tree-empty', {
    manifest: manifestOf({ outputs: [{ path: 'lessons', kind: 'tree' }] }),
    dirs: ['lessons'],
  });
  assertBlocked(gate(emptyTree), 'kind=tree 不能声明空目录');

  const hashedTree = makeStage('tree-hash', {
    manifest: manifestOf({ outputs: [{ path: 'lessons', kind: 'tree', sha256: 'a'.repeat(64) }] }),
    files: { 'lessons/a.md': 'x' },
  });
  assertBlocked(gate(hashedTree), 'sha256 仅支持 kind=file');
});

test('sha256 对不上：阻断并列出行上的值', () => {
  const stage = makeStage('hash-mismatch', {
    manifest: manifestOf({ outputs: [{ path: 'curriculum.yaml', kind: 'file', sha256: 'b'.repeat(64) }] }),
    files: VALID_FILES,
  });
  const problem = assertBlocked(gate(stage), 'sha256 不匹配: curriculum.yaml');
  assert.match(problem.message, new RegExp(sha256Text(VALID_FILES['curriculum.yaml'])));
});

/* ── 六、角色 / 节点 / 状态语义 ───────────────────────────────────────── */

test('角色错配与节点错配：阻断', () => {
  const stage = makeStage('role-mismatch', { files: VALID_FILES });
  const problem = assertBlocked(gate(stage, { role: 'practice-evaluator' }), '角色错配');
  assert.match(problem.message, /manifest=curriculum-designer，expected=practice-evaluator/);

  const courseLevel = makeStage('course-level', {
    manifest: manifestOf({ node_id: 'a.b' }),
    files: VALID_FILES,
  });
  // 不传 expectedNode = 科目级任务，此时 manifest 的 node_id 必须是 null
  assertBlocked(gate(courseLevel), '科目级任务 node_id 必须是 null');

  const nodeLevel = makeStage('node-level', {
    manifest: manifestOf({ role: 'practice-evaluator', node_id: 'a.b' }),
    files: VALID_FILES,
  });
  assertBlocked(gate(nodeLevel, { role: 'practice-evaluator', node: 'a.c' }), '节点错配');
});

test('succeeded：至少要一个 output，且不能有 failed / not_run 的 check', () => {
  const noOutputs = makeStage('no-outputs', { manifest: manifestOf({ outputs: [] }), files: VALID_FILES });
  assertBlocked(gate(noOutputs), 'succeeded 必须声明至少一个 output');

  const badCheck = makeStage('bad-check', {
    manifest: manifestOf({ checks: [{ name: 'check_curriculum', status: 'passed' }, { name: 'render_lesson', status: 'not_run' }] }),
    files: VALID_FILES,
  });
  const problem = assertBlocked(gate(badCheck), 'succeeded 不能包含 failed / not_run 的 check');
  assert.match(problem.message, /render_lesson/);
});

test('blocked：必须在 gaps 里写明阻塞原因', () => {
  const silent = makeStage('blocked-silent', { manifest: manifestOf({ status: 'blocked', gaps: [] }), files: VALID_FILES });
  assertBlocked(gate(silent), 'blocked 必须在 gaps 里写明阻塞原因');

  // blocked 允许留部分产物供排障，但凡放进 deliver/ 的文件仍必须由 outputs 声明（协议第 44 行）
  const leftovers = makeStage('blocked-leftovers', {
    manifest: manifestOf({ status: 'blocked', gaps: ['上游资料来源不足'], outputs: [] }),
    files: VALID_FILES,
  });
  assertBlocked(gate(leftovers), 'deliver/ 有未声明产物');

  const declared = makeStage('blocked-declared', {
    manifest: manifestOf({ status: 'blocked', gaps: ['上游资料来源不足'] }),
    files: VALID_FILES,
  });
  assert.equal(gate(declared).verdict, 'pass');
});

/* ── 七、manifest 本身：合法 JSON 与 schema ───────────────────────────── */

test('manifest 不是合法 JSON：带真实行列阻断', () => {
  const stage = makeStage('bad-json', {
    rawManifest: '{\n  "schema_version": 1,\n  "role": "curriculum-designer",\n}\n',
    files: VALID_FILES,
  });
  const verdict = gate(stage);
  const problem = assertBlocked(verdict, '不是合法 JSON');
  assert.equal(problem.line, 4, '行号指向出错的那一行，不是第 1 行');
  assert.equal(problem.file, path.join(stage, 'handoff.json'));
});

test('重复 JSON key：阻断（JSON.parse 会静默取最后一个，Python 侧本来会拒）', () => {
  const stage = makeStage('dup-key', {
    rawManifest: '{\n  "schema_version": 1,\n  "role": "resource-scout",\n  "role": "curriculum-designer",\n'
      + '  "subject": "linear-algebra", "node_id": null, "status": "succeeded",\n'
      + '  "outputs": [{"path": "curriculum.yaml", "kind": "file"}], "checks": [], "gaps": []\n}\n',
    files: VALID_FILES,
  });
  const problem = assertBlocked(gate(stage), '重复 JSON key: role');
  assert.equal(problem.line, 4);
});

test('schema 违规逐条带行号：额外字段 / const / enum / pattern / 长度', () => {
  const stage = makeStage('schema-bad', {
    rawManifest: JSON.stringify({
      schema_version: 2,
      role: 'teacher',
      subject: 'a/b',
      node_id: null,
      status: 'succeeded',
      outputs: [{ path: 'curriculum.yaml', kind: 'file' }],
      checks: [],
      gaps: [],
      extra: true,
    }, null, 2),
    files: VALID_FILES,
  });
  const verdict = gate(stage);
  assert.equal(verdict.verdict, 'block');
  assert.ok(find(verdict, '必须等于 1'), JSON.stringify(messages(verdict)));
  assert.ok(find(verdict, '不在允许值'));
  assert.ok(find(verdict, '不匹配要求的格式'));
  assert.ok(find(verdict, '不允许额外字段'));
  for (const problem of verdict.problems) {
    assert.ok(problem.line >= 1);
    assert.equal(problem.file, path.join(stage, 'handoff.json'));
  }
  // 行号不是清一色的 1：真解析位置才做得到
  assert.ok(new Set(verdict.problems.map((problem) => problem.line)).size > 1, JSON.stringify(messages(verdict)));
});

test('一处坏输入能同时报出多条：不是一句「失败」', () => {
  const stage = makeStage('many-problems', {
    manifest: manifestOf({
      role: 'resource-scout',
      outputs: [{ path: '../逃出.md', kind: 'file' }, { path: '没有这个.md', kind: 'file' }],
    }),
    files: { ...VALID_FILES, '顺手.md': 'x' },
  });
  const verdict = gate(stage);
  assert.equal(verdict.verdict, 'block');
  assert.ok(verdict.problems.length >= 4, JSON.stringify(messages(verdict)));
  assert.ok(find(verdict, '角色错配'));
  assert.ok(find(verdict, '不能含空段'));
  assert.ok(find(verdict, 'output 在盘上不存在'));
  assert.ok(find(verdict, 'deliver/ 有未声明产物'));
  assert.equal(verdict.summary, `阻断：${stage} 的交接边界不合法——${verdict.problems.length} 条阻断问题（共 ${verdict.problems.length} 条）。不复制、不删 stage、不把任务说成完成。`);
});

test('stagePath 末尾带斜杠不影响展示与判定', () => {
  const stage = makeStage('trailing-slash', { files: VALID_FILES });
  const verdict = validateHandoff({
    stagePath: `${stage}/`,
    manifestText: fs.readFileSync(path.join(stage, 'handoff.json'), 'utf8'),
    entries: snapshot(stage),
    expectedRole: 'curriculum-designer',
    schema: HANDOFF_SCHEMA,
  });
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.stagePath, stage);
});

test('schema 里用了没实现的关键字：阻断，不静默放行', () => {
  const stage = makeStage('schema-unsupported', { files: VALID_FILES });
  const verdict = validateHandoff({
    stagePath: stage,
    manifestText: fs.readFileSync(path.join(stage, 'handoff.json'), 'utf8'),
    entries: snapshot(stage),
    expectedRole: 'curriculum-designer',
    schema: { type: 'object', oneOf: [{ required: ['role'] }] },
  });
  assert.equal(verdict.verdict, 'block');
  assert.ok(find(verdict, 'oneOf'));
});

/* ── 八、带位置的 JSON 读取：报错也要带真实行列 ─────────────────────────── */

test('JSON 语法错误带真实行号与列号（门禁要能指给角色看）', () => {
  const cases = [
    ['{\n  "a": 1\n  "b": 2\n}', 3, /期待 , 或 }/],
    ['{\n  "a" 1\n}', 2, /缺少冒号/],
    ['{\n  "a": \n}', 3, /不认识的值起始字符/],
    // 跨到了行尾的换行符就是那个「未转义的控制字符」，所以报在第 2 行（字符串开始的那一行）
    ['{\n  "a": "没闭合\n}', 2, /控制字符/],
    ['{\n  "a": -}\n}', 2, /数字格式非法/],
    // 前导零：JSON 里 `01` 不是合法数字，报法与 JSON.parse 的「期待 , 或 }」一致
    ['{\n  "a": 01\n}', 2, /期待 , 或 }/],
    ['{\n  "a": 1,\n}\n', 3, /对象的键必须是双引号字符串/],
    ['{\n  "a": [1, 2\n}', 3, /数组里期待 , 或 \]/],
    ['', 1, /文件是空的/],
    ['{"a": 1} 尾巴', 1, /文档结束后还有多余内容/],
  ];
  for (const [text, line, pattern] of cases) {
    const stage = makeStage(`json-${line}-${pattern.source.length}`, { rawManifest: text, files: VALID_FILES });
    const problem = assertBlocked(gate(stage), '不是合法 JSON');
    assert.equal(problem.line, line, `${JSON.stringify(text)} 应当报在第 ${line} 行`);
    assert.match(problem.message, pattern);
    assert.ok(problem.column >= 1);
  }
});

test('JSON 里转义与 \\u 的处理与 JSON.parse 一致', () => {
  const raw = '{\n  "schema_version": 1,\n  "role": "curriculum-designer",\n  "subject": "线性\\u4ee3数",\n'
    + '  "node_id": null,\n  "status": "succeeded",\n  "outputs": [{"path": "curriculum.yaml", "kind": "file"}],\n'
    + '  "checks": [],\n  "gaps": []\n}\n';
  const stage = makeStage('json-escapes', { rawManifest: raw, files: VALID_FILES });
  assert.equal(JSON.parse(raw).subject, '线性代数');
  assert.equal(gate(stage).verdict, 'pass', JSON.stringify(messages(gate(stage))));
});

test('JSON 里的坏 \\u 与坏转义：阻断且指出位置', () => {
  const badUnicode = makeStage('json-bad-unicode', {
    rawManifest: '{\n  "schema_version": 1,\n  "role": "\\uZZZZ"\n}\n',
    files: VALID_FILES,
  });
  assertBlocked(gate(badUnicode), '\\u 后面需要 4 位十六进制');

  const badEscape = makeStage('json-bad-escape', {
    rawManifest: '{\n  "schema_version": 1,\n  "role": "\\q"\n}\n',
    files: VALID_FILES,
  });
  assertBlocked(gate(badEscape), '不认识的转义');
});
