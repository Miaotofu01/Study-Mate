/* 导出 · **无头宿主的命令行**（`bin/studymate.mjs export` → `lib/export/cli.ts`）
   ────────────────────────────────────────────────────────────────────────
   Antigravity / Codex·ChatGPT Work 里没有阅读端，学生的阅读体验全靠导出（ADR-0003）。
   那两条路径上跑的是 Node，所以这张套件跑的是**真的子进程**（`node bin/studymate.mjs export …`），
   不是把函数调一遍——技能将来拼的就是这条命令行。

   钉住三件事：

     · **没有参数也能跑**（无头侧「课完默认导一份」就是这一条）：工作区按
       `--workspace` → `$LEARN_WORKSPACE` → `~/.dsh/studymate-config.yaml` → 当前目录 的顺序定位；
     · **可重复**：课完再跑一次就覆盖同名文件，新课内容进新产物（幂等，不残留旧内容）；
     · 失败要给人话：参数写错、指到不是工作区的目录、一个工作区都找不到，各有一句能照着做的报错。

   数据现造现弃（ADR-0009）。React 用夹具（真渲染在 `--browser` 那一套里验）。
   ───────────────────────────────────────────────────────────────────────── */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ROOT, tempDir } from './fixtures/tools.mjs';
import { addSecondSubject, fakeReactRoot, writeExportWorkspace } from './fixtures/export_workspace.mjs';

const CLI = path.join(ROOT, 'bin', 'studymate.mjs');

/** 一次真调用。`env` 里带上夹具 React 与隔离的 DSH_HOME。 */
function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd ?? ROOT,
    env: {
      ...process.env,
      DSH_HOME: options.dshHome,
      STUDYMATE_REACT_DIR: options.reactRoot,
      ...(options.learnWorkspace === undefined ? {} : { LEARN_WORKSPACE: options.learnWorkspace }),
      ...options.env,
    },
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

/** 现造：临时根 + 工作区 + 空的 DSH_HOME + 夹具 React。 */
function fixture(t) {
  const root = tempDir(t, 'studymate-export-cli-');
  const workspace = path.join(root, '学习资料');
  const dshHome = path.join(root, '空 dsh home');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  writeExportWorkspace(workspace);
  addSecondSubject(workspace);
  return { root, workspace, dshHome, reactRoot: fakeReactRoot(root) };
}

test('export --workspace：--json 给一行机器可读的结果，产物落成', (t) => {
  const f = fixture(t);
  const result = runCli(['export', '--workspace', f.workspace, '--json'], f);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.out, path.join(f.workspace, 'export'));
  assert.equal(payload.entry, path.join(f.workspace, 'export', 'index.html'));
  assert.ok(payload.files.includes('index.html'));
  assert.deepEqual(payload.subjects.map((subject) => subject.slug), ['demo', 'extra']);
  assert.ok(fs.existsSync(payload.entry));
  // --json 时 stdout 只有那一行 JSON（进度走 stderr）
  assert.equal(result.stdout.trim().split('\n').length, 1);
});

test('无头侧默认导出：**没有参数也能跑**（工作区从当前目录认出来）', (t) => {
  const f = fixture(t);
  // DSH_HOME 是空的（没有配置文件），cwd 就是工作区 → 走「当前目录」那一条
  const result = runCli(['export', '--json'], { ...f, cwd: f.workspace });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.out, path.join(f.workspace, 'export'));
  assert.ok(fs.existsSync(path.join(payload.out, 'index.html')), '课完跑一次就有一份能离线看的');
});

test('课完再导一份：覆盖同名文件，新课内容进新产物', (t) => {
  const f = fixture(t);
  const first = runCli(['export', '--workspace', f.workspace, '--json'], f);
  assert.equal(first.status, 0, first.stderr);
  const dataFile = path.join(f.workspace, 'export', 'data.js');
  assert.ok(!fs.readFileSync(dataFile, 'utf8').includes('后来补的这一句'));

  // 「课完」= 内容文件变了
  const lesson = path.join(f.workspace, '.learning', 'subjects', 'demo', 'lessons', '0002-fn.md');
  fs.appendFileSync(lesson, '\n后来补的这一句：课完了，再导一份。\n');
  const second = runCli(['export', '--workspace', f.workspace, '--json'], f);
  assert.equal(second.status, 0, second.stderr);
  const payload = JSON.parse(second.stdout);
  assert.ok(fs.readFileSync(dataFile, 'utf8').includes('后来补的这一句'), '新内容要进新产物');
  assert.deepEqual(JSON.parse(second.stdout).files, JSON.parse(first.stdout).files, '产物清单不变（幂等）');
  assert.ok(payload.files.includes('export.json'));
});

test('--subject 只导一门；--out 换落点', (t) => {
  const f = fixture(t);
  const out = path.join(f.root, '给学生的离线包');
  const result = runCli(['export', '--workspace', f.workspace, '--subject', 'extra', '--out', out, '--json'], f);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.out, out);
  assert.deepEqual(payload.subjects.map((subject) => subject.slug), ['extra']);
  assert.ok(fs.existsSync(path.join(out, 'index.html')));
  assert.ok(!fs.existsSync(path.join(f.workspace, 'export')), '默认落点没有被写');
});

test('报错都是人话：参数写错 / 不是工作区 / 一个都找不到', (t) => {
  const f = fixture(t);
  const badFlag = runCli(['export', '--workspace', f.workspace, '--dry-run'], f);
  assert.equal(badFlag.status, 1);
  assert.match(badFlag.stderr, /不支持的参数：.*--dry-run/);
  assert.match(badFlag.stderr, /用法：studymate export/);

  const notWorkspace = runCli(['export', '--workspace', f.root], f);
  assert.equal(notWorkspace.status, 1);
  assert.match(notWorkspace.stderr, /不像学习工作区/);

  const nowhere = runCli(['export', '--json'], { ...f, cwd: f.root });
  assert.equal(nowhere.status, 1);
  assert.match(nowhere.stderr, /没找到学习工作区/);
  assert.match(nowhere.stderr, /--workspace <目录>/);
});

test('工作区也能从 $LEARN_WORKSPACE 认出来（无头宿主的一种常见布置）', (t) => {
  const f = fixture(t);
  const result = runCli(['export', '--json'], { ...f, cwd: f.root, learnWorkspace: f.workspace });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).out, path.join(f.workspace, 'export'));
});

test('帮助里写了 export 与它的默认导出语义', () => {
  const help = runCli(['--help'], {});
  assert.equal(help.status, 0);
  assert.match(help.stdout, /studymate export \[--workspace <目录>\]/);
  assert.match(help.stdout, /课完默认导一份/);
});
