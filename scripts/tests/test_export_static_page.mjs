/* 导出（`lib/export/**`）· **产物形状与取消语义**
   ────────────────────────────────────────────────────────────────────────
   这张套件钉住的是「导出的页面凭什么能离线打开」这件事的**可断言部分**：

     · 产物清单齐全、脚本顺序正确（数据 → 宿主 → 第三方 → 阅读端本体 → 挂载）；
     · `studymate-client.js` 是 `lib/client.js` 的**逐字节拷贝**（哈希与仓库里那一份相同）
       ——「复用阅读端的渲染、不写第二个渲染器」这句承诺的机器证据；
     · 页面里没有 ES 模块（`file://` 下按 CORS 加载不了，白屏）；
     · 机器路径（工作区、落点）不进产物：导出是能拷走、能分享的东西；
     · 泄漏守卫对**这一份真产物**是干净的；
     · 取消时「保留了什么」说得清（已落成的文件保留、入口排在最后写，所以半成品一眼可见）；
     · `out` 的判据：不许落进 `.learning/`、不许就是工作区根。

   真渲染（`file://` 下样式 / 公式 / 图片 / 题目）在 `scripts/tests/browser/export_file_test.mjs`，
   用真 React 跑。这里用夹具 React——断言的是导出器，不是 React。
   ───────────────────────────────────────────────────────────────────────── */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { runExport, resolveOutDir, writeUnder, ExportCancelledError } from '../../lib/export/run.ts';
import { planExport, clientSourceFile } from '../../lib/export/plan.ts';
import { resolveReact, ReactMissingError, reactCandidates } from '../../lib/export/react.ts';
import { readExportDir, checkExport } from '../../lib/export/guard.ts';
import { assetProductPath } from '../../lib/export/page.ts';
import { tempDir } from './fixtures/tools.mjs';
import { writeExportWorkspace, addSecondSubject, fakeReactRoot } from './fixtures/export_workspace.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** 一份现造的临时工作区 + 夹具 React（ADR-0009：仓库里不存样例数据）。 */
function fixture(t) {
  const root = tempDir(t, 'studymate-export-');
  const workspace = path.join(root, '学习资料');
  fs.mkdirSync(workspace, { recursive: true });
  writeExportWorkspace(workspace);
  addSecondSubject(workspace);
  const react = resolveReact({
    env: { ...process.env, STUDYMATE_REACT_DIR: fakeReactRoot(root) },
    probeGlobal: false,
  });
  return { root, workspace, react };
}

test('产物清单齐全：入口、宿主、数据、阅读端本体、四个第三方构建、配图、清单', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react });
  const names = outcome.files;
  for (const expected of ['index.html', 'host.js', 'boot.js', 'data.js', 'studymate-client.js',
    'vendor/react.production.js', 'vendor/react-dom.production.js', 'vendor/react-dom-client.production.js',
    'vendor/scheduler.production.js', 'assets/demo/assets/img/pool/dot.png', 'export.json']) {
    assert.ok(names.includes(expected), `产物里少了 ${expected}（实际：${names.join('、')}）`);
  }
  assert.equal(outcome.subjects.length, 2, '两门科目都导了');
  assert.equal(outcome.react.version, '0.0.0-fixture');
  // 入口**排在最后**：中途失败/取消的目录里没有入口，一眼能认出是半成品
  assert.equal(names[names.length - 1], 'export.json');
  assert.ok(names.indexOf('index.html') > names.indexOf('studymate-client.js'), '入口在阅读端本体之后写');
});

test('阅读端本体是逐字节拷贝：哈希与仓库里那一份 lib/client.js 相同', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react });
  const copied = fs.readFileSync(path.join(outcome.out, 'studymate-client.js'));
  const original = fs.readFileSync(clientSourceFile());
  assert.equal(sha256(copied), sha256(original), '搬的必须是仓库里那一份（不许打包、不许改写）');
  const { manifest } = readExportDir(outcome.out);
  assert.equal(manifest.client.sha256, sha256(original));
  assert.equal(manifest.client.file, 'lib/client.js');
});

test('index.html 的脚本顺序是依赖顺序，且没有 ES 模块（file:// 下加载不了）', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react });
  const html = fs.readFileSync(path.join(outcome.out, 'index.html'), 'utf8');
  assert.ok(!/type\s*=\s*["']module["']/.test(html), 'file:// 下 ES 模块按 CORS 加载不了，页面会白屏');
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, [
    'data.js', 'host.js',
    'vendor/scheduler.production.js', 'vendor/react.production.js',
    'vendor/react-dom.production.js', 'vendor/react-dom-client.production.js',
    'studymate-client.js', 'boot.js',
  ]);
  assert.match(html, /<noscript>/, '无脚本时要说明白为什么看不到内容');
});

test('data.js 装的是整份快照：科目、正文、题库、参考资料都在，且抹掉了机器路径', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react });
  const text = fs.readFileSync(path.join(outcome.out, 'data.js'), 'utf8');
  const payload = JSON.parse(text.slice(text.indexOf('window.__STUDYMATE_EXPORT__ = ') + 'window.__STUDYMATE_EXPORT__ = '.length).replace(/;\s*$/, ''));
  assert.equal(payload.library.subjects.length, 2);
  const demo = payload.library.subjects.find((subject) => subject.slug === 'demo');
  assert.ok(demo.nodes[0].lesson_md.includes('$$'), '正文（含公式）原样进快照');
  assert.ok(demo.nodes[0].pool && Object.keys(demo.nodes[0].pool).length > 0, '题库进快照');
  assert.equal(payload.library.workspace, '（离线导出副本）', '机器路径抹成标记');
  assert.equal(payload.reference.demo['notes.md'].includes('参考资料'), true, '参考资料正文内联');
  assert.ok(!text.includes(workspace), '整份数据里不许出现这台机器的工作区路径');
});

test('泄漏守卫对真产物干净：没有 Node 专用依赖，哈希都对得上', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react });
  const { files, manifest } = readExportDir(outcome.out);
  const report = checkExport(files, manifest, { machinePaths: [workspace, outcome.out] });
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.manifestProblems, []);
  assert.ok(report.checked >= 8, `扫到的文本产物太少（${report.checked}）`);
  // 产物清单里不许有绝对路径（产物要能拷走）
  const manifestText = fs.readFileSync(path.join(outcome.out, 'export.json'), 'utf8');
  assert.ok(!manifestText.includes(workspace));
  assert.ok(!manifestText.includes(outcome.out));
});

test('取消说清保留了什么：已落成的保留、入口没写、重跑能覆盖', async (t) => {
  const { workspace, react } = fixture(t);
  const controller = new AbortController();
  let seen = 0;
  const outcome = await runExport({
    workspace,
    react,
    signal: controller.signal,
    progress: (_line, steps) => {
      // 只数「逐产物」的那些进度行（开头那句「读工作区与阅读端本体」没有步数）
      if (!steps) return;
      seen += 1;
      // 落成 3 个产物之后请求取消：下一个文件之前它就停下
      if (seen === 3) controller.abort('验收用的取消');
    },
  }).then(() => null, (error) => error);
  assert.ok(outcome instanceof ExportCancelledError, `应当是取消错误，实际是 ${outcome}`);
  assert.equal(outcome.kept.length, 3, '取消回执里的 kept 就是已落成的那几个');
  assert.match(outcome.message, /已落成的 3 个产物保留在/);
  assert.match(outcome.message, /导出从不回滚也不删文件/);
  const out = path.join(workspace, 'export');
  for (const kept of outcome.kept) {
    assert.ok(fs.existsSync(path.join(out, kept)), `${kept} 应当还在盘上（保留就是保留）`);
  }
  assert.ok(!fs.existsSync(path.join(out, 'index.html')), '入口排在最后写：半成品目录里没有入口');
  // 重跑一次得到完整导出（同名覆盖）
  const again = await runExport({ workspace, react });
  assert.ok(fs.existsSync(path.join(again.out, 'index.html')));
});

test('落点判据：不许进 .learning/，不许就是工作区根，写盘不许跑出导出目录', (t) => {
  const { workspace } = fixture(t);
  assert.throws(() => resolveOutDir(workspace, path.join(workspace, '.learning', 'export')),
    /不能放进 \.learning\/ 里/);
  assert.throws(() => resolveOutDir(workspace, workspace), /不能就是工作区根/);
  const out = resolveOutDir(workspace);
  assert.equal(out, path.join(workspace, 'export'));
  assert.throws(() => writeUnder(out, '../跑出去了.txt', 'x'), /跑到导出目录外面/);
  assert.throws(() => writeUnder(out, '../../x', 'x'), /跑到导出目录外面/);
  // 正常路径会建目录并落盘
  const file = writeUnder(out, 'assets/demo/a/b.txt', 'ok');
  assert.equal(fs.readFileSync(file, 'utf8'), 'ok');
});

test('React 解析：显式根命中；一个候选都没有时给一句能照着做的话', (t) => {
  const { root } = fixture(t);
  const empty = path.join(root, '空的');
  fs.mkdirSync(empty, { recursive: true });
  // DSH_HOME 也指到一个没有 profile 的空目录：这台机器上 ~/.dsh 里真的装着 react，
  // 不隔离的话「找不到」这条路径永远测不到。
  const emptyHome = path.join(root, '空 home');
  fs.mkdirSync(emptyHome, { recursive: true });
  assert.throws(
    () => resolveReact({ env: { STUDYMATE_REACT_DIR: empty, DSH_HOME: emptyHome }, probeGlobal: false, roots: [] }),
    (error) => {
      assert.ok(error instanceof ReactMissingError);
      assert.match(error.message, /EXPORT_REACT_MISSING/);
      assert.match(error.message, /npm i -D react react-dom/, '要给出可操作的出路');
      assert.match(error.message, /STUDYMATE_REACT_DIR/);
      return true;
    },
  );
  const candidates = reactCandidates({ env: {}, probeGlobal: false });
  assert.ok(candidates.some((candidate) => candidate.source === '包自己的 node_modules'));
});

test('计划与落盘分开：planExport 不写盘，产物角色分得清', async (t) => {
  const { workspace, react } = fixture(t);
  const plan = planExport({ workspace, react });
  assert.ok(!fs.existsSync(path.join(workspace, 'export')), '算计划不该落盘');
  const roles = new Map(plan.products.map((product) => [product.path, product.role]));
  assert.equal(roles.get('studymate-client.js'), 'client');
  assert.equal(roles.get('data.js'), 'data');
  assert.equal(roles.get('export.json'), 'manifest');
  assert.equal(roles.get('assets/demo/assets/img/pool/dot.png'), 'asset');
  assert.equal(roles.get('vendor/react.production.js'), 'vendor');
  assert.equal(roles.get('index.html'), 'page');
  assert.equal(assetProductPath('demo', 'assets/img/pool/dot.png'), 'assets/demo/assets/img/pool/dot.png');
});

test('--subject 只导一门：另一门不进快照，配图也不搬', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react, subjects: ['demo'] });
  assert.deepEqual(outcome.subjects.map((subject) => subject.slug), ['demo']);
  assert.ok(outcome.files.includes('assets/demo/assets/img/pool/dot.png'));
  assert.ok(!outcome.files.some((file) => file.startsWith('assets/extra/')), '没导的科目不该有配图');
  assert.throws(() => planExport({ workspace, react, subjects: ['不存在的科目'] }), /没有要导的科目/);
});
