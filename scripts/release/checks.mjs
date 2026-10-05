// Keep CI's functional suites explicit so optional audits do not grow the gate.
// 「显式」的代价是新增套件会静默地永远不跑——所以下面有一条覆盖断言兜着。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

// 支持文件与「按需手动跑」的脚本：新增套件要么接进某个组或 package.json 的按需入口，
// 要么明确登记到这里——不登记就会在下面报出来，不再有第三种「谁也不跑」的状态。
// browser/harness.mjs 是浏览器套件共用的骨架（探测二进制 + CDP + summary.json），自己不是套件。
const SUPPORT_FILES = new Set(['README.md', 'run_tests.sh', 'browser/harness.mjs']);
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
      if (/\.[cm]?js$/.test(entry.name)) found.push(relative);
    }
  };
  walk(path.join(root, 'scripts', 'tests'));
  return found;
}

function declaredSuites() {
  const declared = new Set();
  for (const group of Object.values(groups)) {
    for (const name of group.node || []) declared.add(name);
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
    + `（当前组 ${mode}：${(groups[mode].node || []).length} 个 Node + `
    + `${(groups[mode].tests || []).length} 个 --test）`);
  return true;
}

const groups = {
  core: {
    tests: [
      'scripts/release/release.test.mjs',
      // #83 拆除：预设注册的 TS 替代（形状逐字段一致）与 Codex 交互断点的 Node 移植。
      // 两条都是「原 Python 套件的验收面」，不是新功能——见脚本自己的文件头。
      'scripts/tests/test_preset_install.mjs',
      'scripts/tests/test_interaction_state.mjs',
      // Host 半数据层的特征化测试（lib/{workspace,library,assets,yaml,reference,attempts}.ts）
      'scripts/tests/test_host_library_payload.mjs',
      'scripts/tests/test_host_reference_fence.mjs',
      'scripts/tests/test_host_path_boundary.mjs',
      // 路径包含判据本身（lib/paths.ts）：reference / assets / export / lab 四处共用的那一份，
      // 边界值（同前缀兄弟目录、root 带尾分隔符、软链指出去、断链）逐条钉住。特征化测试测的
      // 是「取址/落盘的结果」，判据换一种写法照样可能绿——所以判据自己也要有一条。
      'scripts/tests/test_host_paths.mjs',
      // 阅读端五条 /api/studymate/* 路由的**错误信封**：形状（`{ok:false, error:{code,message}}`）、
      // 机读码词表（源码里用了表外的码就红）、以及两端一致（lib/client.js 是手写 JS，不进 tsc）。
      'scripts/tests/test_host_route_envelope.mjs',
      // 性能预算（目标态规格 §10.3）：**相对规模的比例**，不写绝对秒数。数 readLibrary()
      // 真的碰了几次文件系统，断言 4 倍规模 ≈ 4 倍工作量（线性 ≈ 4、平方 ≈ 16）。
      'scripts/tests/test_host_perf_budget.mjs',
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
      // 排版那一层（#89）：token 与「字号行高成套」的静态判据（配对齐全、行高无单位数、
      // 12px 以上必须引阶梯、正文那批选择器只许引 --smb-fs-body、窄档覆盖写在基础规则之后、
      // 面包屑宽度按全角字算）。
      'scripts/tests/test_client_tokens.mjs',
      'scripts/tests/test_client_typography.mjs',
      'scripts/tests/test_client_pure.mjs',
      // #88 三栏几何：ADR-0011 的让位顺序（右栏先拿 / 左栏先让 / 中栏保底 420）与
      // 「并排装不下就把那一栏盖在正文上」的降级。同样是纯函数——「任何画布宽度下都
      // 有一栏打得开」是代数，浏览器里一条条试既慢又试不全。
      'scripts/tests/test_client_panes.mjs',
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
      // 工具 schema 的**宿主子集**：多一个关键字、或把 `type` 写成数组，整批工具在真宿主里
      // 注册不上（真发生过一次，而 test:dsh 的探针只按名字查八个学习工具、抓不住）。
      // 这条直接逐个走 schema，不看名字。
      'scripts/tests/test_tools_schema_subset.mjs',
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
      // #92：选中正文冻成一条**留得住的引用**（文本 + 来源锚点）。捕获那一下的判据在 Node 里
      // 用假 DOM 逐个喂（含各种「读到空选区」的触发方式，都不得清掉已存在的引用），面板那一半
      // 断言它渲染这条引用、提交时随问题送出、答成了才清。真鼠标拖拽那一条在 --browser 组。
      'scripts/tests/test_client_ask_quote.mjs',
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
      // #91 的 Host 半：随包发的 KaTeX dist（CSS ↔ 字体的双向对账、版本对账、精确 MIME）
      // 与它的投送路由（一条文件一条精确路由、路径落在 /api 之内、取址判据）。
      // 阅读端那一半（题库字段只接数学式、降级可读）在 test_client_math.mjs；
      // 真浏览器里「按需加载 → 排版成功」在 --browser 组的 browser/math_test.mjs。
      'scripts/tests/test_host_math_route.mjs',
      'scripts/tests/test_client_math.mjs',
      // #87 的验收面：技能与工具的**可见边界**。出方向（别的预设扫不到 StudyMate 的
      // 技能）、入方向（学习预设显式声明的技能目录在包内）各一条，外加一条把
      // 「工具/面板仍在 profile 根注册」这个与 spec 的已知偏离钉成事实的特征化断言。
      'scripts/tests/test_skill_visibility.mjs',
    ],
  },
  '--static': {
    tests: ['scripts/tests/test_openai_skills.mjs', 'scripts/tests/test_openai_skill_ui.mjs', 'scripts/tests/test_antigravity_skills.mjs',
      // #81：技能调用面 ↔ lib/tools 注册表对账（点名的工具必须存在；无头宿主导出件里
      // 不许留原生工具名，也不许留宿主跑不动的调用）。
      'scripts/tests/test_skill_contracts.mjs',
      // #83：原四份 Python 套件的**行为移植**（技能规则、技能调用面、词表、发布元数据）——它们守的东西一件都没退役（提示词规则仍在
      // 那些技能里、调用面仍分角色、三档词表仍在 schema 里、发布元数据仍要与 tag 对齐）。
      'scripts/tests/test_skill_rules.mjs',
      'scripts/tests/test_skill_frontmatter.mjs',
      'scripts/tests/test_statuses.mjs',
      'scripts/tests/test_release_metadata.mjs',
      // #83：文档悬空引用（README 与 docs/** 的相对链接、行内代码里的仓库路径）。
      // 拆除之后最容易留下的就是"文档还指着已删文件"，人眼扫不可靠。
      'scripts/tests/test_docs_references.mjs'],
  },
  '--browser': {
    // 三个旧静态模板夹具（hl / quiz_code / math）随 `templates/assets/` 一起退役：
    // 它们测的是「生成出来的页面 + 模板资源」，而页面已经不再预生成。它们守的渲染面
    // 由这三条接住——reading_test 测阅读端本体（真 lib/client.js），export_file_test
    // 测**导出的产物本身**在 file:// 下真渲染（样式、公式、图片、代码块、题目）。
    // 后面两条各测阅读端的一块，夹具同一套（harness.mjs + mini-react）：
    //   · #76 阅读位置三级恢复 + 锚点四态复核；
    //   · #72 作答落盘（把阅读端打进一个说 HTTP 的迷你宿主，真的落盘到工作区文件）。
    node: [
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
      // #91 换掉了里面那条**假绿**的公式断言（原来只匹配 TeX 原文），并加了「题面里的公式也排
      // 出来了」「KaTeX 字体真的加载了」两条。
      'browser/export_file_test.mjs',
      // #91：公式排版。夹具是一个说 HTTP 的迷你宿主，它按 lib/math-route.ts 注册出来的路由投送
      // **包里那份 KaTeX dist**，页面跑真 lib/client.js。五个场景：正文行内/块级公式排出来、
      // 公式只写在题面里也照样加载（判据把题库字段算进去）、没有数学式的页面零请求、
      // 资源缺失降级成可读 TeX、排版失败给一句明确的错。导出产物那一半在上面那条里（file://）。
      'browser/math_test.mjs',
      // #86：阅读端**四路由 × 三档视口**。上面那条 reading_test 恒定 1440×960，于是
      // lib/client.js 里两条 `@media (max-width: 900px)` 从来没被执行过；这一条把四个面
      // （今天学什么 / 科目主页 / 课件页 / 搜索）在宽窄两档各取一次景，亮暗两套的实测对比度
      // 与动效四档也在里面。窄档不是截图，是换 CSS 视口再跑一遍。
      // #88 加了紧档（700×900）与一场几何扫描：那一档课件页的右栏并排装不下，必须是
      // 「盖在正文上 + 说明 + 收起」的抽屉——「点题目没反应」正是那张票要消掉的缺陷。
      // #93 也落在这里：右栏题库的内部呈现——题型徽标是贴字的标签（不再被弹性行拉成竖条）、
      // 右栏 tab 用右栏那套下划线（不是左栏的胶囊）、点正文标记那一组是「当前」、上次作答的
      // 结果还在、长 token 折行而不是出横向滚动条。夹具另造一份：三种题型各一组、
      // 题干与选项里各一段没有断点的长 token、题库带着一次落盘的作答。
      'browser/reading_routes_test.mjs',
      // #89：课件页正文与页头的呈现——配图两条路（位图受列宽约束、矢量随列宽、暗色不刺眼）、
      // 代码块语言标签与块内横向滚动、长标识符/URL/宽表格不撑出横向滚动条、一屏一种正文字号、
      // 顶部只剩一条（课件标题 + 小节跳转）、面包屑按全角字省略、题目标记带组号。
      // 宽窄两档各一遍，每个场景一张截图。
      'browser/lesson_body_test.mjs',
      // #92：问答面板里那条引用的**真浏览器**用例。Node 里没有真选区，而这张票的病根恰恰
      // 出在「document 级 mouseup 读实时选区、判定失败就清空」——点输入框会让浏览器把选区
      // 折叠成空。所以这里用 CDP 的 Input.dispatchMouseEvent 做真鼠标拖拽（harness 没有
      // 选区/拖拽助手，套件自己补 dragSelect/clickAt），验「选中 → 打开问答 → 点输入框/打字/
      // 切 tab 之后引用仍在」，以及提交时请求体里带的原文与来源锚点。
      'browser/ask_quote_test.mjs',
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
    env: { ...process.env },
  });
  if (result.error) console.error(result.error.message);
  failed ||= result.status !== 0;
}
if (!checkSuiteCoverage()) process.exit(2);

const group = groups[mode];
for (const file of group.node || []) run(process.execPath, [`scripts/tests/${file}`]);
if (group.tests?.length) run(process.execPath, ['--test', ...group.tests]);
process.exitCode = failed ? 1 : 0;
