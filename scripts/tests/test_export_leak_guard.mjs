/* 导出 · **泄漏守卫**（`lib/export/guard.ts` + `scripts/release/export_guard.mjs`）
   ────────────────────────────────────────────────────────────────────────
   对齐调研结论 F11 / 目标态规格 §8：「导出产物引用任何只存在于 Node 的东西就让构建失败」。
   这张套件同时钉两头：

     · **正向**：一份真导出的产物扫下来是干净的（规则不是摆设，也不是永远红）；
     · **反向（反证）**：注入一个 Node 专用依赖之后，构建期守卫必须失败，并指出文件与行号。
       反证有两种：改**产物**（`exportGuardRun({inject})`，等价于导出器漏了）与改**第三方包装**
       /阅读端本体（哈希核对，篡改立刻暴露）。

   还有一条**假阳性防线**：`data.js` 的载荷是 JSON，里面出现 `require(` 是课件正文
   （讲 Node 的那一课、代码块里的示例），不该判失败——守卫只扫载荷之前那段导出器写的代码。

   另有一条**多科目导出树**的防线（P2）：导出目录里可以再套一份完整导出（科目单独导过一次，
   落在 `<科目>/` 子目录里），角色识别必须认**任意深度**的同名产物——`<科目>/studymate-client.js`
   还是 client、`<科目>/vendor/**` 还是 vendor、`<科目>/export.json` 还是 manifest、`<科目>/data.js`
   还是 data；子目录里的真页面（`index.html` / `host.js` / `boot.js`）仍按 page 全规则扫，泄漏照报。
   二进制产物（PDF / 图片 / 字体 / 压缩包）不进文本扫描：它们不是导出器写的文本产物，读成 utf8
   再扫原文只会假阳性。
   ───────────────────────────────────────────────────────────────────────── */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { checkExport, readExportDir, scanLeaks, LEAK_RULES } from '../../lib/export/guard.ts';
import { splitVendor } from '../../lib/export/page.ts';
import { exportGuardRun } from '../release/export_guard.mjs';
import { tempDir } from './fixtures/tools.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GUARD_SCRIPT = path.join(ROOT, 'scripts', 'release', 'export_guard.mjs');

test('规则表逐条生效：每条规则在自己的角色上都能命中', () => {
  const samples = {
    'node-specifier': "import fs from 'node:fs';",
    'cjs-require': "const fs = require('node:fs');",
    'node-process': 'if (process.env.NODE_ENV) {}',
    'node-buffer': 'const b = Buffer.from("x");',
    'node-module-exports': 'module.exports = { ok: true };',
    'node-dirname': 'const here = __dirname;',
    'esm-in-file-url': '<script type="module" src="boot.js"></script>',
  };
  for (const rule of LEAK_RULES) {
    const sample = samples[rule.id];
    assert.ok(sample, `规则 ${rule.id} 在套件里没有样本——加规则就要加样本`);
    const hits = scanLeaks([{ path: 'page.js', role: 'page', text: `/* 前面 */\n${sample}\n` }]);
    assert.ok(hits.some((hit) => hit.rule === rule.id), `${rule.id} 没命中：${JSON.stringify(hits)}`);
    assert.equal(hits[0].line, 2, '行号要指到那一行');
  }
  // CSS 类名 `.smb-node:hover` 不许误伤（踩过：node: 后面跟着类名的一部分）
  assert.deepEqual(scanLeaks([{ path: 'x.css', role: 'page', text: '.smb-node:hover { color: red; }\n' }]), []);
});

test('真产物扫下来是干净的，而且哈希核对通过', async () => {
  const result = await exportGuardRun({});
  assert.equal(result.ok, true, `不该有问题：${JSON.stringify(result.violations)} ${result.problems.join('；')}`);
  assert.ok(result.files.includes('index.html'));
  assert.ok(result.checked >= 8, `扫到的文本产物太少（${result.checked}）`);
});

/* ── 多科目导出树（P2）：科目子目录里是一份完整导出，产物角色要看任意深度 ───────── */

/** 把一份导出的全部产物原样拷进导出目录下的子目录——「科目单独导过一次」的形状。 */
function nestExport(out, products, target) {
  for (const rel of products) {
    const to = path.join(out, target, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(out, rel), to);
  }
}

test('科目子目录导出：任意深度的同名产物按角色识别，整棵导出树扫下来干净', async (t) => {
  const result = await exportGuardRun({ dir: tempDir(t, 'studymate-export-nested-') });
  // 真实样本（本机多科目导出目录）：根是一份完整导出，每个科目子目录里还各有一份；
  // 子目录可以不止一层（归档里的旧导出），角色一样只能按「文件名 + 路径段」判。
  const nested = ['computer-networks', '归档/operating-systems'];
  for (const target of nested) nestExport(result.out, result.files, target);

  const { files, manifest } = readExportDir(result.out);
  const report = checkExport(files, manifest, { machinePaths: [result.out] });
  assert.deepEqual(report.violations, [],
    `科目子目录里的产物被当成页面扫了：${JSON.stringify(report.violations, null, 2)}`);
  assert.deepEqual(report.manifestProblems, [], `根导出的清单核对不该受影响：${report.manifestProblems.join('；')}`);

  // 正面对照：不是「整棵树都没扫」，而是每个产物落到了它该在的角色上。
  const roleAt = (rel) => files.find((file) => file.path === rel)?.role;
  for (const target of nested) {
    assert.equal(roleAt(`${target}/studymate-client.js`), 'client', `${target} 里的阅读端本体要按 client 判`);
    assert.equal(roleAt(`${target}/data.js`), 'data', `${target} 里的数据要按 data 判`);
    assert.equal(roleAt(`${target}/export.json`), 'manifest', `${target} 里的清单要按 manifest 判`);
    assert.equal(roleAt(`${target}/vendor/react.production.js`), 'vendor', `${target} 里的第三方构建要按 vendor 判`);
    assert.equal(roleAt(`${target}/assets/demo/assets/img/pool/dot.png`), 'asset', `${target} 里的配图要按 asset 判`);
    // 子目录里的这些是真页面：角色不变，真泄漏必须照报（下一条测试反证）
    assert.equal(roleAt(`${target}/index.html`), 'page', `${target} 里的入口仍是页面`);
    assert.equal(roleAt(`${target}/host.js`), 'page', `${target} 里的宿主脚本仍是页面`);
    assert.equal(roleAt(`${target}/boot.js`), 'page', `${target} 里的引导脚本仍是页面`);
  }
  // 根目录的角色没被「任意深度」带偏
  assert.equal(roleAt('index.html'), 'page');
  assert.equal(roleAt('host.js'), 'page');
  assert.equal(roleAt('boot.js'), 'page');
  assert.equal(roleAt('studymate-client.js'), 'client');
  assert.equal(roleAt('data.js'), 'data');
  assert.equal(roleAt('export.json'), 'manifest');
  assert.equal(roleAt('vendor/react.production.js'), 'vendor');
});

test('科目子目录里同名但不是产物的文件：不许按 client / data / vendor 误判', async (t) => {
  const result = await exportGuardRun({ dir: tempDir(t, 'studymate-export-lookalike-') });
  const target = 'computer-networks';
  // 学生自己放进导出目录的材料：与产物同名，但同目录没有 export.json（不是一份导出）。
  const lookalikes = [
    `${target}/lessons/data.js`,
    `${target}/vendor/README.txt`,
  ];
  fs.mkdirSync(path.join(result.out, target, 'lessons'), { recursive: true });
  fs.mkdirSync(path.join(result.out, target, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(result.out, lookalikes[0]), 'var x = 1;\n');
  fs.writeFileSync(path.join(result.out, lookalikes[1]), '第三方说明\n');

  const { files, manifest } = readExportDir(result.out);
  const roleAt = (rel) => files.find((file) => file.path === rel)?.role;
  assert.equal(roleAt(lookalikes[0]), 'page', '同名但没有 export.json 的 data.js 仍是页面，不按 data 扫');
  assert.equal(roleAt(lookalikes[1]), 'page', 'vendor 下的说明文件不是第三方构建，不套包装壳核对');
  const report = checkExport(files, manifest, { machinePaths: [result.out] });
  assert.deepEqual(report.violations, [],
    `同名非产物被按产物判了：${JSON.stringify(report.violations, null, 2)}`);
});

test('反证：科目子目录里的真页面注入 Node 依赖，仍必须报 cjs-require', async (t) => {
  const result = await exportGuardRun({ dir: tempDir(t, 'studymate-export-nested-inject-') });
  const target = 'computer-networks';
  nestExport(result.out, result.files, target);
  const { files, manifest } = readExportDir(result.out);
  const injected = files.map((file) => (file.path === `${target}/index.html`
    ? { ...file, text: `${file.text}\n<script>var leak = require('node:fs');</script>\n` }
    : file));
  const report = checkExport(injected, manifest);
  const hit = report.violations.find((violation) => violation.path === `${target}/index.html`
    && violation.rule === 'cjs-require');
  assert.ok(hit, `子目录页面里的 require( 必须照报：${JSON.stringify(report.violations)}`);
  assert.ok(report.violations.some((violation) => violation.path === `${target}/index.html`
    && violation.rule === 'node-specifier'), 'node: 说明符也要报');
});

test('反证：注入一个 Node 专用依赖，构建期守卫必须失败', async () => {
  const result = await exportGuardRun({
    inject: (out) => fs.appendFileSync(path.join(out, 'host.js'), "\nvar leak = require('node:fs');\n"),
  });
  assert.equal(result.ok, false, '注入之后守卫必须红——否则这道守卫等于没有');
  const rules = result.violations.map((violation) => violation.rule);
  assert.ok(rules.includes('node-specifier'), `要认出 node: 说明符：${rules.join('、')}`);
  assert.ok(rules.includes('cjs-require'), `要认出 require(：${rules.join('、')}`);
  assert.equal(result.violations[0].path, 'host.js');
  assert.match(result.violations[0].excerpt, /require\('node:fs'\)/);
  // 清单的字节数也跟着对不上（改了产物就是改了产物）
  assert.ok(result.problems.some((problem) => problem.includes('字节数')), result.problems.join('；'));
});

test('反证：命令行守卫 `--inject` 以退出码 1 结束（构建必须失败）', () => {
  const clean = spawnSync(process.execPath, [GUARD_SCRIPT], { encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /没有泄漏/);
  const leaked = spawnSync(process.execPath, [GUARD_SCRIPT, '--inject', 'host.js'], { encoding: 'utf8' });
  assert.equal(leaked.status, 1, '注入之后构建步骤必须非零退出');
  assert.match(leaked.stderr, /host\.js:\d+ \[cjs-require\]/);
  assert.match(leaked.stderr, /构建必须失败/);
});

test('第三方包装被改 / 内容被换 / 阅读端本体被改：哈希核对逐个报出来', async (t) => {
  // 给了 dir 就保留临时目录（下面要从盘上把产物读回来逐个篡改）
  const result = await exportGuardRun({ dir: tempDir(t, 'studymate-export-tamper-') });
  const { files, manifest } = readExportDir(result.out);
  // 四份 React + 一份 KaTeX（#91）：第三方构建的每一条都要有哈希可核
  assert.equal(manifest.third_party.length, 5);

  const tamper = (rel, change) => files.map((file) => (file.path === rel ? { ...file, text: change(file.text) } : file));

  // ① 包装壳被改（切不出那两行了）
  const brokenWrapper = tamper('vendor/react.production.js', (text) => text.replace('window.__smDefine(', 'window.__smDefine_('));
  const wrapperReport = checkExport(brokenWrapper, manifest);
  assert.ok(wrapperReport.violations.some((violation) => violation.rule === 'vendor-wrapper'));
  assert.ok(wrapperReport.manifestProblems.some((problem) => problem.includes('切不出包装壳')));

  // ② 壳里那段被换掉（哈希对不上）
  const swapped = tamper('vendor/react.production.js', (text) => {
    const parts = splitVendor(text);
    return text.replace(parts.body, 'exports.createElement = function () { return require("node:fs"); };');
  });
  const swappedReport = checkExport(swapped, manifest);
  assert.ok(swappedReport.manifestProblems.some((problem) => problem.includes('内容哈希与清单对不上')), swappedReport.manifestProblems.join('；'));

  // ③ 阅读端本体被改（不再是仓库里那一份）
  const clientChanged = tamper('studymate-client.js', (text) => `${text}\n// 偷偷改了一行\n`);
  const clientReport = checkExport(clientChanged, manifest);
  assert.ok(clientReport.manifestProblems.some((problem) => problem.includes('studymate-client.js 与清单里的哈希对不上')));

  // ④ 清单里有、产物里没有
  const missing = files.filter((file) => file.path !== 'boot.js');
  assert.ok(checkExport(missing, manifest).manifestProblems.some((problem) => problem.includes('产物里没有')));
});

test('假阳性防线：data.js 载荷里的 require( 是课件正文，不算泄漏', () => {
  const text = '/* 注释 */\nwindow.__STUDYMATE_EXPORT__ = {"lesson_md":"```js\\nconst fs = require(\'node:fs\');\\n```"};';
  assert.deepEqual(scanLeaks([{ path: 'data.js', role: 'data', text }]), []);
  // 但**载荷之前**那段是导出器的代码，照扫
  const leaked = '/* 注释 */\nvar x = require("node:fs");\nwindow.__STUDYMATE_EXPORT__ = {};';
  const hits = scanLeaks([{ path: 'data.js', role: 'data', text: leaked }]);
  assert.equal(hits.length, 2, `载荷之前的代码要扫出来：${JSON.stringify(hits)}`);
  // 载荷标记丢了 = data.js 被改过
  assert.ok(scanLeaks([{ path: 'data.js', role: 'data', text: 'window.其他 = {};' }])
    .some((violation) => violation.rule === 'data-payload'));
});

test('机器路径不许进产物（导出是能拷走、能分享的东西）', () => {
  const hits = scanLeaks(
    [{ path: 'index.html', role: 'page', text: '<p>/home/某人/学习资料</p>\n' }],
    { machinePaths: ['/home/某人/学习资料'] },
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, 'machine-path');
  assert.equal(hits[0].line, 1);
});

test('asset 是二进制，不进规则扫描', () => {
  assert.deepEqual(scanLeaks([{ path: 'assets/demo/a.png', role: 'asset' }]), []);
});

test('二进制产物（PDF / 图片 / 字体 / 压缩包）不进文本扫描', (t) => {
  // 真实多科目导出目录里放着学生/外部工具给的 PDF（样张），它不是导出器的文本产物。
  // 这里塞进「机器路径 + require 调用」两样最容易被误报的东西：只要还被读成文本，就必红。
  const machinePath = '/home/某人/学习资料';
  const body = Buffer.from(`%PDF-1.7\n% ${machinePath}\nvar leak = require('node:fs');\n`);
  const dir = tempDir(t, 'studymate-export-binary-');
  const binaries = [
    'Agent工程-全32课-正文版.pdf',
    'computer-networks/计算机网络-全18课-正文版.pdf',
    '配图.png',
    '字体.woff2',
    '资料包.zip',
  ];
  for (const rel of binaries) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  // 兜底对照：同样内容写成 .txt 就是文本，照 page 扫必须报（证明「不扫」只针对二进制）
  fs.writeFileSync(path.join(dir, '说明.txt'), body);

  const { files } = readExportDir(dir);
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const rel of binaries) {
    assert.equal(byPath.get(rel).role, 'asset', `${rel} 要按 asset 判（二进制不读成文本）`);
    assert.equal(byPath.get(rel).text, undefined, `${rel} 不该被读成 utf8 文本`);
  }
  assert.equal(byPath.get('说明.txt').role, 'page', '文本文件仍按页面扫');
  assert.deepEqual(scanLeaks(files.filter((file) => binaries.includes(file.path)), { machinePaths: [machinePath] }), [],
    '二进制里的机器路径与 require( 是内容数据，不该按原文判泄漏');

  // 正面对照：这份内容如果真被当文本扫，三条判据都会命中——上面那条「干净」不是空转。
  const asPage = scanLeaks([{ path: binaries[0], role: 'page', text: fs.readFileSync(path.join(dir, binaries[0]), 'utf8') }],
    { machinePaths: [machinePath] });
  assert.deepEqual(asPage.map((violation) => violation.rule).sort(), ['cjs-require', 'machine-path', 'node-specifier']);
});
