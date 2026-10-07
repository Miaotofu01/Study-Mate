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
import { extractZip, readZip } from './fixtures/zip.mjs';

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
    'templates/MEMORY.md', 'templates/subject.yaml',
    'docs/规范/文件归属.md', 'README.md', 'LICENSE']) {
    assert.ok(fs.existsSync(path.join(plugin, asset)), asset);
  }
  for (const unwanted of ['node_modules', '.git', 'workspace', '.dsh', 'preset',
    'scripts/tests', 'requirements.txt', 'templates/assets', 'templates/lesson.html']) {
    assert.equal(fs.existsSync(path.join(plugin, unwanted)), false, unwanted);
  }

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
  fs.rmSync(first.archive);
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
