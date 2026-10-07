#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 构建期泄漏守卫（对齐调研结论 F11 / 目标态规格 §8）

   跑法：`node scripts/release/export_guard.mjs`（或 `npm run guard:export`）。

   它做的是**真事**，不是静态检查：现造一份临时工作区 → 用真导出器导一份 → 逐产物扫
   「只有 Node 才有的东西」（`lib/export/guard.ts` 的规则表）。扫出任何一条就以退出码 1
   结束——**构建必须失败**，因为漏进产物的东西在学生机器上表现为一张打不开的页面。

   谁在跑它：
     · `npm test`（`scripts/tests/test_export_leak_guard.mjs` 调这里的 `exportGuardRun`）；
     · 发布构建（`scripts/release/release.mjs` 的 publish 在打包前跑一次，泄漏就不发布）；
     · 人手动跑（排障、或者验收里那条「故意注入一个 Node 专用依赖」的反证）。

   React 用的是**夹具**（`scripts/tests/fixtures/export_workspace.mjs` 的 `fakeReactRoot`），
   所以构建机上不需要装 React——守卫查的是产物里有没有 Node 专用依赖，与 React 真不真无关；
   真渲染由 `--browser` 那一套用真 React 验（`scripts/tests/browser/export_file_test.mjs`）。

   `inject` 参数是**反证用的注入点**：在导出之后、扫描之前改产物（模拟「导出器把 Node 专用
   依赖漏进了页面」）。它只给测试与验收用——反证必须能证明这道守卫真的会红，而不是永远绿。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runExport } from '../../lib/export/run.ts';
import { checkExport, readExportDir } from '../../lib/export/guard.ts';
import { resolveReact } from '../../lib/export/react.ts';
import { addSecondSubject, fakeReactRoot, writeExportWorkspace } from '../tests/fixtures/export_workspace.mjs';

/**
 * 导一份临时工作区并扫它。
 *
 * @param options.dir 临时根目录（省略就现开一个 mkdtemp）
 * @param options.inject 导出之后、扫描之前的注入点（**只给反证用**）
 */
export async function exportGuardRun(options = {}) {
  const keep = options.dir !== undefined;
  const root = options.dir ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-export-guard-'));
  const workspace = path.join(root, '学习资料');
  fs.mkdirSync(workspace, { recursive: true });
  writeExportWorkspace(workspace);
  addSecondSubject(workspace);
  const react = resolveReact({
    env: { ...process.env, STUDYMATE_REACT_DIR: fakeReactRoot(root) },
    probeGlobal: false,
  });
  try {
    const outcome = await runExport({ workspace, react });
    if (typeof options.inject === 'function') options.inject(outcome.out);
    const { files, manifest } = readExportDir(outcome.out);
    const report = checkExport(files, manifest, { machinePaths: [workspace, outcome.out] });
    return {
      ok: report.violations.length === 0 && report.manifestProblems.length === 0,
      out: outcome.out,
      files: outcome.files,
      checked: report.checked,
      violations: report.violations,
      problems: report.manifestProblems,
      react: outcome.react,
    };
  } finally {
    if (!keep) fs.rmSync(root, { recursive: true, force: true });
  }
}

function report(result) {
  console.log(`导出泄漏守卫：临时工作区导了 ${result.files.length} 个产物，扫了 ${result.checked} 个文本产物`
    + `（React 夹具 ${result.react.version}）。`);
  if (result.ok) {
    console.log('✔ 没有泄漏：产物里没有 Node 专用依赖；第三方构建与阅读端本体的哈希都对得上。');
    return 0;
  }
  const total = result.violations.length + result.problems.length;
  console.error(`✖ 有 ${total} 条问题——构建必须失败（离线页面在 file:// 下没有这些 Node 东西）：`);
  for (const violation of result.violations) {
    console.error(`  ${violation.path}:${violation.line} [${violation.rule}] ${violation.what}`);
    console.error(`      ${violation.excerpt}`);
  }
  for (const problem of result.problems) console.error(`  [清单] ${problem}`);
  return 1;
}

/**
 * `--inject <产物路径>`：**反证用的注入**——导出之后往那个产物里塞一行 Node 专用代码，
 * 守卫必须因此失败。它存在的唯一理由就是让「这道守卫真的会红」这件事可以一条命令复现
 * （验收项「故意注入一个 Node 专用依赖，构建必须失败」）。正常构建不要用它。
 */
function injectNodeDependency(out, relPath) {
  const file = path.join(out, relPath);
  if (!fs.existsSync(file)) throw new Error(`注入点不存在：${relPath}（产物里没有这个文件）`);
  fs.appendFileSync(file, "\nvar 注入的漏子 = require('node:fs');\n");
}

const self = fileURLToPath(import.meta.url);
const invokedDirectly = process.argv[1] && fs.existsSync(process.argv[1])
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(self);

if (invokedDirectly) {
  const args = process.argv.slice(2);
  try {
    let injectAt = null;
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--inject' && args[i + 1] && !args[i + 1].startsWith('--')) { injectAt = args[i + 1]; i += 1; continue; }
      throw new Error(`不支持的参数：${args.join(' ')}（用法：node scripts/release/export_guard.mjs [--inject <产物路径>]）`);
    }
    if (injectAt) console.log(`（反证模式：导出之后往 ${injectAt} 里注入一行 require('node:fs')）`);
    const result = await exportGuardRun({
      inject: injectAt === null ? undefined : (out) => injectNodeDependency(out, injectAt),
    });
    process.exitCode = report(result);
  } catch (error) {
    console.error(`导出泄漏守卫跑不起来：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
