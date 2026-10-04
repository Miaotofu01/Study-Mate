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
// browser/harness.mjs 是浏览器套件共用的骨架（探测二进制 + CDP + summary.json），自己不是套件。
const SUPPORT_FILES = new Set(['README.md', 'run_tests.sh', 'fixtures.py', 'browser/harness.mjs']);
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
    node: ['quiz_dom_test.cjs', 'toc_dom_test.cjs'],
    tests: [
      'scripts/release/release.test.mjs',
      // Host 半数据层的特征化测试（lib/{workspace,library,assets,yaml,reference,attempts}.mjs）
      'scripts/tests/test_host_library_payload.mjs',
      'scripts/tests/test_host_reference_fence.mjs',
      'scripts/tests/test_host_path_boundary.mjs',
      'scripts/tests/test_host_yaml_workspace.mjs',
      // #71 的验收面：作答数据的幂等/版本栅栏，以及「拿一份 v0.2 真实工作区跑一遍」
      'scripts/tests/test_host_attempts_fence.mjs',
      'scripts/tests/test_host_v02_workspace.mjs',
      // #72 的 Host 半：POST /api/studymate/attempts 的路由注册、请求体与状态码映射、
      // 「POST 落盘 → 另起一次读仍带得回上次选了 X」（跨请求 = 刷新页面那条）、
      // 冲突拒绝不写盘、主观题自评落盘、题库逐字不变。
      'scripts/tests/test_host_attempts_route.mjs',
      // 纯函数域 lib/core/**：内容格式的解析与锚点题库对账（格式只有一个真相）
      'scripts/tests/test_core_format.mjs',
      'scripts/tests/test_core_anchors.mjs',
      'scripts/tests/test_core_lesson.mjs',
      // 纯函数域（lib/core/**）：JSON Schema 子集校验器 + 四类校验 + 规则层。
      // 最后一条是覆盖率下限门禁，它自己会 spawn 一轮带阈值的 `node --test`。
      'scripts/tests/test_core_schema_subset.mjs',
      'scripts/tests/test_validators_curriculum.mjs',
      'scripts/tests/test_validators_progress_subject.mjs',
      'scripts/tests/test_validators_handoff.mjs',
      'scripts/tests/test_rules_pure.mjs',
      // 纯函数域的判据：写入栅栏（幂等台账 + 版本比较）、题库题型与字段、误解字段定型、
      // 问答面板的请求体（#79：上下文只带当前课件 / 选中文本 / 共享记忆，不背会话）
      'scripts/tests/test_core_fence_questions.mjs',
      'scripts/tests/test_core_ask_context.mjs',
      'scripts/tests/test_core_coverage_floor.mjs',
      // 阅读端（lib/client.js）的契约：token 对比度达 WCAG AA（亮暗两套）、
      // 动效四档与 prefers-reduced-motion、首次引导定位几何（纯函数，node:vm 里跑）
      'scripts/tests/test_client_tokens.mjs',
      'scripts/tests/test_client_pure.mjs',
      // #76 阅读位置三级降级：lib/client.js 里那段纯数学内核（切源码标记求值，不需要浏览器）
      'scripts/tests/test_client_reading_position.mjs',
      // #77 交付物题的界面：代跑事实块只显示事实（命令 / 退出码 / 两条流 / 截断），
      // 界面文案里一个判决词都没有，入口只有一颗「跑一次」按钮且不点不跑。
      // 渲染函数在工厂闭包里，靠 fixtures/client_harness.mjs 的 React 桩调起来。
      'scripts/tests/test_client_lab_run.mjs',
      // #69：架构边界与依赖无环断言（扫真实 import 图，域规则表默认拒绝）
      'scripts/tests/test_architecture_boundaries.mjs',
      // 工具域 lib/tools/**（#68）：域声明与越权即抛、工作区摘要、四个校验器、两个改写工具。
      // 夹具在 scripts/tests/fixtures/tools.mjs —— `fixtures/` 目录被上面的遍历显式跳过。
      'scripts/tests/test_tools_guard.mjs',
      'scripts/tests/test_tools_context.mjs',
      'scripts/tests/test_tools_validate.mjs',
      'scripts/tests/test_tools_rewrite.mjs',
      // 任务域 lib/tasks/**（#73）：六态状态机、owner 句柄与越权、durable 落盘的**跨进程**接上、
      // 五个 studymate_task_* 工具、阅读端的 GET /api/studymate/tasks。
      // 跨进程那一半的「进程 A」是夹具 scripts/tests/fixtures/tasks_producer.mjs。
      'scripts/tests/test_tasks_model.mjs',
      // 实验域 lib/lab/**（#77）：判分三轨的第三轨。真跑一条会失败的命令、真实输出原样进
      // 作答数据（attempts/*.json 的 `跑` 字段）、长命令的进度与取消回执、以及四组越界反证
      // （cwd / 可写范围 / 参数里的路径 / 软链）。命令从哪来也是断言的一部分：只有题库里那道
      // 交付物题的「证据」字段能提供命令，模型与学生都没有第二个入口。
      'scripts/tests/test_lab_runner.mjs',
      // 阅读端（lib/client.js 是零构建的浏览器插件，没有 export）：跨科目搜索的索引覆盖与
      // 四个附件折叠块的空态。套件在 Node 里伪造 window.__ModuleLoader__ + react 桩把头文件
      // 跑掉，再断言工厂闭包里的纯逻辑与渲染函数（夹具见 scripts/tests/fixtures/client_harness.mjs）。
      'scripts/tests/test_client_search_index.mjs',
      'scripts/tests/test_client_fold_empty_state.mjs',
      // #72 的 Client 半：作答落盘的写队列 + 合并轮询 + 陈旧响应围栏（旧读数/在飞写入
      // 不许覆盖新作答）、版本冲突的重读与重来一次、自评走同一条路、界面文案不再说
      // 「只在内存里作答」。夹具同上（client_harness.mjs）。
      'scripts/tests/test_client_attempt_fence.mjs',
      // #79：问答面板接模型。面板那一半在 Node 里点它的按钮、看它发的 POST（fetch 是假货）；
      // Host 那一半用**注入的假 llm** 证明链路通（真模型调用要花额度，门禁里不跑）。
      'scripts/tests/test_client_ask_panel.mjs',
      'scripts/tests/test_host_ask_route.mjs',
      // 监听域 lib/watch/**（#74）：变更通知的形状与域映射（纯）、目录集合监听（真 fs）、
      // 两条推送路（真 HTTP，bridge 与宿主同形）、阅读端「未变即同引用」（VM 里跑 lib/client.js）。
      // 真 DSH 里的端到端在 scripts/tests/test_dsh_runtime.mjs 的监听探针里。
      'scripts/tests/test_watch_notice.mjs',
      'scripts/tests/test_watch_tree.mjs',
      'scripts/tests/test_watch_push.mjs',
      'scripts/tests/test_watch_client.mjs',
      // 导出域 lib/export/**（#82）：产物形状与取消语义、泄漏守卫（含反证：注入 Node 专用依赖
      // 必须让构建失败）、工具面与任务模型（DSH 侧不主动导出、取消回执说清保留什么）、
      // 无头侧的 CLI（没有参数也能跑 = 「课完默认导一份」）。
      // 浏览器那一半（file:// 下真渲染）在 --browser 组。
      'scripts/tests/test_export_static_page.mjs',
      'scripts/tests/test_export_leak_guard.mjs',
      'scripts/tests/test_export_tool_task.mjs',
      'scripts/tests/test_export_cli.mjs',
    ],
  },
  '--static': {
    python: ['test_python_syntax.py', 'test_release_metadata.py', 'test_skill_frontmatter.py', 'test_skill_rules.py', 'test_templates.py'],
    tests: ['scripts/tests/test_openai_skills.mjs', 'scripts/tests/test_openai_skill_ui.mjs', 'scripts/tests/test_antigravity_skills.mjs',
      // #81：技能调用面 ↔ lib/tools 注册表对账（点名的工具必须存在；无头宿主导出件里
      // 不许留原生工具名，也不许留宿主跑不动的调用）。
      'scripts/tests/test_skill_contracts.mjs'],
  },
  '--browser': {
    // 前三个测旧静态模板（file:// 夹具），reading_test.mjs 测阅读端本体（真 lib/client.js）。
    // 后面两条各测阅读端的一块，夹具同一套（harness.mjs + mini-react）：
    //   · #76 阅读位置三级恢复 + 锚点四态复核；
    //   · #72 作答落盘（把阅读端打进一个说 HTTP 的迷你宿主，真的落盘到工作区文件）。
    node: [
      'browser/hl_test.mjs', 'browser/quiz_code_test.mjs', 'browser/math_test.mjs',
      'browser/reading_test.mjs',
      'browser/reading_position_test.mjs',
      'browser/attempts_test.mjs',
      // #74：真浏览器里「改文件 → 监听 → SSE → 页面自己更新（不刷新）」的端到端。
      // 其余几套测的是阅读端的静态面；这一套要的是**真的 EventSource**接我们那条流式 Response。
      'browser/watch_push_test.mjs',
      // #77：交付物题的「跑一次」——点一下 → 真命令跑起来 → 真实输出回到界面并落进
      // attempts/。夹具与 attempts_test.mjs 同一套（真 lib/client.js + 真 HTTP 迷你宿主），
      // 走的是 lib/lab/route.ts 注册出来的真路由。
      'browser/lab_run_test.mjs',
      // #82：**导出的产物本身**在 file:// 下打开（真 Chrome + 真 React）：样式、公式、图片、
      // 题目全部可用，且控制台/页面/失败请求干净。不搭夹具页——测的就是学生拿到的那份东西。
      'browser/export_file_test.mjs',
    ],
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
