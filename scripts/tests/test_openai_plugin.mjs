/* 插件构建 · Codex / ChatGPT Work 侧（`bin/openai-plugin.mjs`）
   ────────────────────────────────────────────────────────────────────────
   无头宿主的插件是一份**技能 + schema + 文档 + 数据骨架 + 一件 Node 脚本**的目录与 ZIP。
   这条套件钉住四件事：

     · **ZIP 真能被解开**：用独立于写入端的读取器（`fixtures/zip.mjs`）解包——写入端换了
       实现，这里照样读得出来才算数（Python 时代这一半由 `python -m zipfile -e` 担当）；
     · **产物是自足的**：解出来的插件里，交互断点脚本能跑（read → update → answer），
       不依赖源码检出、不依赖 Python；
     · **确定性**：重建一次，ZIP 逐字节相同；
     · **不越界**：输出目录不能落在构建源里，已占用的目录不被静默清空。

   夹具全部现造现弃（ADR-0009）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildOpenAiPlugin } from '../../bin/openai-plugin.mjs';
import { moveIntoPlace } from '../../bin/fs-swap.mjs';
import { extractZip, readZip } from './fixtures/zip.mjs';
import { missingTemplateFiles } from './fixtures/templates.mjs';
import { removeFile } from './fixtures/fs-rm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'bin/studymate.mjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-openai-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('导出的 ZIP 是一份能脱离源码检出跑起来的插件', (t) => {
  const directory = fixture(t);
  const output = path.join(directory, "输出 O'Brien #1");
  const result = buildOpenAiPlugin({ output });
  const extracted = path.join(directory, 'unpacked');
  extractZip(result.archive, extracted);
  const plugin = path.join(extracted, 'studymate');

  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'studymate');
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
  assert.equal(fs.readdirSync(path.join(plugin, 'skills')).length, 12);

  for (const asset of ['skills/learning-system/SKILL.md',
    'skills/learning-system/references/codex-interaction.md',
    'scripts/interaction_state.mjs', 'assets/logo.png',
    'schemas/curriculum.schema.json', 'schemas/agent-handoff.schema.json',
    'templates/MEMORY.yaml', 'templates/subject.yaml',
    'docs/规范/文件归属.md', 'README.md', 'LICENSE']) {
    assert.ok(fs.existsSync(path.join(plugin, asset)), asset);
  }
  for (const unwanted of ['node_modules', '.git', 'workspace', '.dsh', 'preset',
    'scripts/tests', 'requirements.txt', 'templates/assets', 'templates/lesson.html']) {
    assert.equal(fs.existsSync(path.join(plugin, unwanted)), false, unwanted);
  }
  // 工作区数据骨架（含 #197 的 lab 骨架）要**一份不落**地进产物：这份清单从源取，
  // 不是手抄的一串文件名——手抄的那串正是「加了新文件、这条路没跟上」会漏的地方。
  assert.deepEqual(missingTemplateFiles(plugin), [], '导出的插件少了工作区数据骨架里的文件');

  const controllerSkill = fs.readFileSync(path.join(plugin, 'skills/learning-system/SKILL.md'), 'utf8');
  assert.match(controllerSkill, /没有引擎脚本/, '导出稿要说清本宿主没有引擎脚本');
  assert.match(controllerSkill, /npx -y @yunmiao\/studymate@latest export/, '导出那条 CLI 要写在宿主约定里');
  assert.doesNotMatch(controllerSkill, /python3/);
  assert.doesNotMatch(controllerSkill, /scripts\/[\w-]+\.p(?:y)/);

  // 交互断点：解出来的插件里真跑一遍（不读源码检出、不碰 Python）
  const home = path.join(directory, 'empty-home');
  const workspace = path.join(directory, '学习数据');
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh') };
  delete env.STUDYMATE_CONFIG;
  delete env.LEARN_WORKSPACE;
  fs.mkdirSync(path.join(workspace, '.learning', 'subjects'), { recursive: true });
  const helper = path.join(plugin, 'scripts', 'interaction_state.mjs');
  const run = (...args) => {
    const result = spawnSync(process.execPath, [helper, '--workspace', workspace, ...args],
      { encoding: 'utf8', env, windowsHide: true });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const state = run('read');
  assert.equal(state.revision, 0);
  assert.equal(fs.existsSync(path.join(workspace, '.learning/interaction.json')), false, '首次读不写盘');
  const next = {
    active_subject: null, phase: 'clarify', node_id: null, intent: '学 Python', answers: {},
    pending: {
      id: 'python-project-1', kind: 'preference', topic: 'python.project', question: '做哪个项目？',
      options: [{ id: 'csv', label: '表格分析' }], resume_phase: 'plan',
    }, next_action: '等待项目选择',
  };
  const input = path.join(directory, 'checkpoint.json');
  fs.writeFileSync(input, JSON.stringify(next));
  run('update', '--input', input, '--expected-revision', '0');
  assert.equal(run('read').pending.id, 'python-project-1');
  fs.writeFileSync(input, JSON.stringify('分析 CSV 报表'));
  const answered = run('answer', '--question-id', 'python-project-1', '--input', input, '--expected-revision', '1');
  assert.equal(answered.phase, 'plan');
  assert.equal(answered.pending, null);
  assert.equal(answered.answers['python-project-1'].value, '分析 CSV 报表');
  assert.equal(fs.existsSync(env.DSH_HOME), false, '插件不该动 DSH 的家目录');
});

test('重建替换生成的文件，且 ZIP 逐字节相同', (t) => {
  const output = fixture(t);
  const first = buildOpenAiPlugin({ output });
  const bytes = fs.readFileSync(first.archive);
  fs.writeFileSync(path.join(first.plugin, 'obsolete.txt'), 'stale build');
  buildOpenAiPlugin({ output });
  assert.equal(fs.existsSync(path.join(first.plugin, 'obsolete.txt')), false);
  assert.deepEqual(fs.readFileSync(first.archive), bytes);
});

test('产物清单里没有 0 字节文件，也没有 Python 文件', (t) => {
  const output = fixture(t);
  const result = buildOpenAiPlugin({ output });
  const files = Object.keys(readZip(result.archive));
  assert.ok(files.length > 20, '归档不该是空的');
  const tiny = files.filter(name => readZip(result.archive)[name].length === 0);
  assert.deepEqual(tiny, [], `引用得到却空着的文件等于坏插件：${tiny.join('、')}`);
  const python = files.filter(name => /\.py$/.test(name));
  assert.deepEqual(python, [], `插件里不该再有 Python 文件：${python.join('、')}`);
  assert.ok(files.includes('studymate/scripts/interaction_state.mjs'), '交互断点脚本要在归档里');
});

test('输出目录越界即拒：不碰别人的东西，也不覆盖构建源', (t) => {
  const output = fixture(t);
  fs.mkdirSync(path.join(output, 'studymate'));
  const keep = path.join(output, 'studymate', 'notes.md');
  fs.writeFileSync(keep, 'keep my notes');
  assert.throws(() => buildOpenAiPlugin({ output }), /非构建文件/);
  assert.equal(fs.readFileSync(keep, 'utf8'), 'keep my notes');
  assert.throws(() => buildOpenAiPlugin({ output: path.join(root, 'templates', 'export') }), /源文件/);
});

test('归档构建失败时保留上一份插件与 ZIP', (t) => {
  const output = fixture(t);
  const first = buildOpenAiPlugin({ output });
  const bytes = fs.readFileSync(first.archive);
  const manifest = fs.readFileSync(path.join(first.plugin, '.codex-plugin/plugin.json'));
  // 让写盘目标变成一个目录：归档那一步必然失败。
  removeFile(first.archive);
  fs.mkdirSync(first.archive);
  assert.throws(() => buildOpenAiPlugin({ output }));
  assert.deepEqual(fs.readFileSync(path.join(first.plugin, '.codex-plugin/plugin.json')), manifest);
  assert.deepEqual(fs.readdirSync(first.archive), []);
  assert.ok(bytes.length > 0);
});

test('CLI 构建插件时不碰 DSH 配置', (t) => {
  const directory = fixture(t);
  const output = path.join(directory, 'export');
  const dsh = path.join(directory, 'no-dsh');
  const result = spawnSync(process.execPath, [cli, 'build-plugin', '--output', output], {
    env: { ...process.env, DSH_HOME: dsh }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(output, 'studymate-openai.zip')));
  assert.equal(fs.existsSync(dsh), false);
  const invalid = spawnSync(process.execPath, [cli, 'build-plugin', '--workspace', output], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /用法/);
});

test('成品落位：同卷空目标走原子 rename', (t) => {
  const directory = fixture(t);
  const fresh = path.join(directory, 'fresh');
  const target = path.join(directory, 'target');
  fs.mkdirSync(path.join(fresh, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(fresh, 'inner', 'a.txt'), 'x');

  assert.equal(moveIntoPlace(fresh, target), 'rename');
  assert.equal(fs.readFileSync(path.join(target, 'inner', 'a.txt'), 'utf8'), 'x');
  assert.equal(fs.existsSync(fresh), false, 'rename 之后源目录不该还在');
});

test('成品落位：rename 被系统拒掉时退回「清目标 + 复制 + 删源」', (t) => {
  const directory = fixture(t);
  const fresh = path.join(directory, 'fresh');
  const target = path.join(directory, 'target');
  fs.mkdirSync(path.join(fresh, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(fresh, 'inner', 'a.txt'), 'x');
  // 目标非空：Windows 上目录 rename 必 EPERM，Linux 上必 ENOTEMPTY——两边都进兜底。
  // 这正是安装器 / 构建器第二次落位时会撞上的形态。
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'stale.txt'), '旧');

  assert.equal(moveIntoPlace(fresh, target), 'copy');
  assert.equal(fs.existsSync(path.join(target, 'stale.txt')), false, '旧内容要被新成品顶掉');
  assert.equal(fs.readFileSync(path.join(target, 'inner', 'a.txt'), 'utf8'), 'x');
  assert.equal(fs.existsSync(fresh), false, '源目录不能留下残壳');
});

test('成品落位：路径写错（ENOENT）不许被兜底伪装成成功', (t) => {
  const directory = fixture(t);
  assert.throws(() => moveIntoPlace(path.join(directory, '没有这个目录'), path.join(directory, 'x')),
    /ENOENT/, 'ENOENT 是路径错，退化只会把真的 bug 藏起来');
});

test('成品落位：兜底复制对中文目标路径也真的落盘', (t) => {
  // 不带恒真 `filter` 的 `cpSync` 在非 ASCII 目标路径上会静默一个文件都不拷
  // （nodejs/node#59636，Node 24.13 实测）。这条钉住退路里那句话必须真能把文件搬到中文目录。
  const directory = fixture(t);
  const fresh = path.join(directory, 'fresh');
  const target = path.join(directory, '成品 张三');
  fs.mkdirSync(path.join(fresh, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(fresh, 'sub', 'a.txt'), 'x');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'stale.txt'), '旧');

  assert.equal(moveIntoPlace(fresh, target), 'copy');
  assert.equal(fs.readFileSync(path.join(target, 'sub', 'a.txt'), 'utf8'), 'x');
  assert.equal(fs.existsSync(fresh), false);
});

