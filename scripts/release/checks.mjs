// Script-style Python suites must run directly; unittest discovery misses them.
// Keep CI's functional suites explicit so optional audits do not grow the gate.
// 「显式」的代价是新增套件会静默地永远不跑——所以下面有一条覆盖断言兜着。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findPython } from '../../bin/studymate.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

// 支持文件与「按需手动跑」的脚本：新增套件要么接进某个组或 package.json 的按需入口，
// 要么明确登记到这里——不登记就会在下面报出来，不再有第三种「谁也不跑」的状态。
const SUPPORT_FILES = new Set(['README.md', 'run_tests.sh', 'fixtures.py']);
const MANUAL_ONLY = new Set([
  'browser/measure.mjs', 'browser/hovers.mjs', 'browser/shot.mjs',  // 手动看的浏览器脚本
  'probe_bundle.mjs',                                               // 排障用
]);

function suiteFiles() {
  const found = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== '__pycache__' && entry.name !== 'fixtures') walk(path.join(dir, entry.name), relative);
        continue;
      }
      if (/\.[cm]?js$|\.py$/.test(entry.name)) found.push(relative);
    }
  };
  walk(path.join(root, 'scripts', 'tests'));
  return found;
}

function declaredSuites() {
  const declared = new Set();
  for (const group of Object.values(groups)) {
    for (const name of [...(group.python || []), ...(group.node || [])]) declared.add(name);
    for (const name of group.tests || []) declared.add(name.replace(/^scripts\/tests\//, ''));
  }
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const command of Object.values(packageInfo.scripts || {})) {
    for (const match of command.matchAll(/scripts\/tests\/([\w./-]+)/g)) declared.add(match[1]);
  }
  return declared;
}

function checkSuiteCoverage() {
  const declared = declaredSuites();
  const unlisted = suiteFiles().filter(name =>
    !declared.has(name) && !SUPPORT_FILES.has(name) && !MANUAL_ONLY.has(name));
  if (unlisted.length) {
    console.error('\n这些套件既不在默认门禁、也不在 package.json 的按需入口，更没有登记为手动：');
    for (const name of unlisted) console.error(`  scripts/tests/${name}`);
    console.error('接进 checks.mjs 的一个组、加一条 npm 脚本，或写进 checks.mjs 的 MANUAL_ONLY。');
    return false;
  }
  console.log(`套件覆盖：${suiteFiles().length} 个文件全部有归属`
    + `（当前组 ${mode}：${(groups[mode].python || []).length} 个 Python + `
    + `${(groups[mode].node || []).length} 个 Node + ${(groups[mode].tests || []).length} 个 --test）`);
  return true;
}

const groups = {
  core: {
    python: [
      'test_attachment_render.py', 'test_curriculum.py', 'test_dsh_presets.py',
      'test_interaction_state.py', 'test_handoff.py', 'test_lesson_figure.py', 'test_lesson_links.py',
      'test_lesson_scripts.py', 'test_lessonfile.py', 'test_lessonfmt.py',
      'test_naming_nav.py', 'test_pool.py',
      'test_quiz_attr.py', 'test_quiz_code.py', 'test_render_lesson.py',
      'test_statuses.py', 'test_templates.py', 'test_workspace_config.py',
    ],
    node: ['quiz_dom_test.js', 'toc_dom_test.js'],
    tests: [
      'scripts/release/release.test.mjs',
      // Host 半数据层的特征化测试（lib/{workspace,library,assets,yaml,reference}.mjs）
      'scripts/tests/test_host_library_payload.mjs',
      'scripts/tests/test_host_reference_fence.mjs',
      'scripts/tests/test_host_path_boundary.mjs',
      'scripts/tests/test_host_yaml_workspace.mjs',
    ],
  },
  '--static': {
    python: ['test_python_syntax.py', 'test_release_metadata.py', 'test_skill_frontmatter.py', 'test_skill_rules.py', 'test_templates.py'],
    tests: ['scripts/tests/test_openai_skills.mjs', 'scripts/tests/test_openai_skill_ui.mjs', 'scripts/tests/test_antigravity_skills.mjs'],
  },
  '--browser': {
    node: ['browser/hl_test.mjs', 'browser/quiz_code_test.mjs', 'browser/math_test.mjs'],
  },
};
const mode = process.argv[2] || 'core';
if (process.argv.length > 3 || !Object.hasOwn(groups, mode)) {
  console.error('Usage: node scripts/release/checks.mjs [--static|--browser]');
  process.exit(2);
}

process.chdir(fileURLToPath(new URL('../../', import.meta.url)));
let failed = false;
function run(command, args) {
  console.log(`\n${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  if (result.error) console.error(result.error.message);
  failed ||= result.status !== 0;
}
if (!checkSuiteCoverage()) process.exit(2);

const group = groups[mode];
if (group.python?.length) {
  let python;
  try { python = findPython(); } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  for (const file of group.python) run(python.command, [...python.prefix, `scripts/tests/${file}`]);
}
for (const file of group.node || []) run(process.execPath, [`scripts/tests/${file}`]);
if (group.tests?.length) run(process.execPath, ['--test', ...group.tests]);
process.exitCode = failed ? 1 : 0;
