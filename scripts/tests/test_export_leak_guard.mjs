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
  assert.equal(manifest.third_party.length, 4);

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
