# 回归测试

默认检查与 GitHub Actions 共用一个入口：

```sh
npm test
```

需要 Node.js、Python 3.9+ 和 PyYAML。**各命令的前置以本文件为准**，别处只给指针：Node 的支持范围看 `package.json` 的 `engines`，Actions 实际用的是 Node 24 / Python 3.13，只在 Ubuntu 上跑一次，不展开系统和运行时矩阵。默认检查只跑 npm 安装、插件打包、课件和工作区功能、DOM 与发布逻辑，不安装真实 DSH、pnpm 或浏览器，不调用模型。

测试使用临时目录，不读写学生的 `workspace/`。Python 会按 `python3`、`python`、Windows 的 `py -3` 顺序查找可用解释器。

## 按需运行

| 命令 | 范围 |
| --- | --- |
| `npm test` | 全部默认功能回归，与 CI 一致 |
| `npm run test:installer` | npm 安装入口、预设与 Bundle |
| `npm run test:openai` | OpenAI 插件 ZIP、完整性、独立运行与导出保护 |
| `npm run test:antigravity` | Antigravity 插件 ZIP、原生 agents、导出保护与重复构建 |
| `npm run test:release` | 版本、changelog、重试和发布保护 |
| `npm run test:static` | Python 语法、技能调用面与提示词规则归属、提示词与模板文案契约、OpenAI 与 Antigravity skill 转换及 UI 元数据（`npm test` 已含这一层，这里可单独跑） |
| `npm run test:browser` | 四套真实浏览器渲染测试（含阅读端），浏览器二进制自动探测 |
| `npm run test:dsh` | 真实 DSH 启动与 Web 预设，需要指定 DSH 包目录；native 安装下还验八个原生工具的注册、body 可调用（走真 dispatch）与越权抛，以及 #70 的引擎路径：`root` 指向已安装的包、`~/.dsh/studymate/engine/` 不再出现 |
| `npm run test:dsh-cli` | 真实 DSH CLI 安装、更新、卸载，还需要 `pnpm` |

Python 语法、提示词与模板契约、两个宿主的技能转换这一层（`--static`）**已并入 `npm test`**，CI 每次都会跑；保留为本地按需命令的只剩真实宿主（`test:dsh` / `test:dsh-cli`）与真实 Chrome（`test:browser`）——它们要外部环境，不适合当默认门禁。`scripts/release/checks.mjs` 显式列出各层套件——**显式的代价是新增套件会静默地永远不跑**，所以那里有一条覆盖断言：`scripts/tests/` 下的每个文件必须属于某个组（core / `--static` / `--browser`）、package.json 的按需入口（`test:dsh` 等），或在 `MANUAL_ONLY` 里明确登记为手动脚本。漏登记时跑门禁会直接报出文件名并以退出码 2 停下。

旧入口继续可用：

```sh
bash scripts/tests/run_tests.sh            # 等同 npm test
bash scripts/tests/run_tests.sh --static   # 仅静态检查
bash scripts/tests/run_tests.sh --browser  # 默认功能回归 + 浏览器测试
```

## 默认功能套件

| 套件 | 覆盖行为 |
| --- | --- |
| `test_installer.mjs`、`test_bundle.mjs` | npm 安装、更新与安装模式切换，Bundle 激活和清理，临时工作区数据保留 |
| `test_openai_plugin.mjs` | ZIP 解压后不依赖源码或 DSH 即可初始化工作区、恢复交互和渲染课件；构建可重复，失败时保留已有产物 |
| `test_antigravity_plugin.mjs` | Antigravity 插件包含 5 个原生子代理与 12 个技能、无 0 字节文件、占用的输出目录不被清空、构建可重复 |
| `test_dsh_presets.py` | 预设写入、profile 适配、迁移和重复安装 |
| `test_workspace_config.py`、`test_interaction_state.py` | 工作区来源优先级、旧配置兼容、交互状态与恢复 |
| `test_handoff.py` | 子 agent staged 交接：schema、角色/节点绑定、路径边界、symlink、产物覆盖与 SHA-256 |
| `test_quiz_attr.py`、`test_quiz_code.py` | 题库属性转义、JSON 与代码围栏处理 |
| `test_lesson_figure.py`、`test_lesson_links.py`、`test_naming_nav.py` | 图片和本地引用可达、课件命名与导航 |
| `test_pool.py`、`test_lesson_scripts.py` | 图片库校验、课件重排、空题理由写入与失败保护 |
| `test_curriculum.py`、`test_lessonfile.py` | 课程大纲模块（位次、课型、前后邻居、依赖层级、坏大纲的判决）与课件文件名／页面路径约定 |
| `test_lessonfmt.py` | 内容文件语法（围栏判定、语言标签白名单、`:::` 不被误判成指令） |
| `test_statuses.py` | 状态与课型词表：读自 schema、配色齐全、顺序即载荷（完成判据与主页排序）、缺 schema 时降级告警 |
| `test_render_lesson.py`、`test_attachment_render.py` | 课件和附件渲染、题库锚点、转义、数学式、输出与检查器对接 |
| `quiz_dom_test.cjs`、`toc_dom_test.cjs` | 题目判分、展开、代码和公式展示，侧栏目录与移动端行为 |
| `scripts/release/release.test.mjs` | 版本计算、更新记录、历史 tag、PR 去重、制品校验与重试保护 |
| `test_host_library_payload.mjs`、`test_host_reference_fence.mjs`、`test_host_path_boundary.mjs`、`test_host_yaml_workspace.mjs` | Host 半数据层（`lib/{workspace,library,assets,yaml,reference}.ts`）的特征化测试：payload 顶层与科目/节点形状、旧六档→三档、锚点四态、`operationId` 幂等重放、`expectedVersion` 冲突拒绝、路径越界、YAML 子集与工作区配置读取。数据在临时目录现造现弃，不碰真实工作区 |
| `test_core_schema_subset.mjs` | JSON Schema 子集校验器（`lib/core/schema.ts`）：关键字枚举表与六份真 schema 对齐（新增关键字会红）、不支持的关键字不静默放行、逐个断言的 `type`/`required`/`additionalProperties`/`enum`/`const`/`pattern`/`minLength`/`minimum`/`minItems`/`format` |
| `test_validators_curriculum.mjs` | 大纲校验（`validateCurriculum`）与带位置的 YAML 读取：DAG 无环、位次不倒挂、实验课前置非空、字段齐全、重复 id、悬空引用；行号是解析位置（夹具里放了逐字相同的**诱饵注释**，文本搜索会指错行）；并与 `lib/yaml.{ts,mjs}` 的值树逐路径对齐 |
| `test_validators_progress_subject.mjs` | 进度与科目的 schema 与取值：旧六档读到就报映射、进度与大纲的引用完整性、空串 `name`/`goal`、`created_at` 是否真实存在、`slug` 与目录名不一致 |
| `test_validators_handoff.mjs` | 交接门禁（`validateHandoff`）：明确放行/阻断、manifest ↔ `deliver/` 覆盖、角色/节点绑定、路径边界、symlink、可选 SHA-256、重复 JSON key 与 JSON 语法错误的真实行列 |
| `test_rules_pure.mjs` | 纯函数规则层（`lib/core/rules.ts`）：四层判定逐条通过标准、题型与深度的匹配、旧六档 → 三档六条映射逐条断言、证据资格与分母口径；并断言 `lib/core/**` 不 import `node:*` |
| `test_core_coverage_floor.mjs` | 覆盖率下限：自己 spawn 一轮带 `--test-coverage-*` 阈值的 `node --test`，规则层与整个 `lib/core/**` 的覆盖率不达标就让门禁红。统计范围**自动发现**（`lib/core/**` 有哪几个模块、哪几条套件真的把它们拉进这一轮，全从盘上算），并断言每个模块都出现在覆盖率报告里——没被加载的模块不进分母，静默少算会红 |
| `test_architecture_boundaries.mjs` | 架构边界与依赖无环（#69）：扫真实源码解析 `import` / `export … from` / 动态 `import()` 得到 import 图，按文件顶部那张**域规则表**判（`lib/` 一级目录 = 域，未知域默认拒绝，`lib/core/**` 不许碰 `node:*` 与域外东西），域图与模块图都断言无环；另有合成图的反证用例钉住判据本身 |
| `test_tools_guard.mjs` | 原生工具域（`lib/tools/{domains,access,define,index,capability}.ts`）：八个工具的名字与**声明表**（谁读哪些域、写哪些字段，放宽一行就红）、`description` 只有一句话、注册走 `ctx.effect`；**反证**越权读与越权写必须抛 `DomainViolationError`（写越权时回调一次都不跑）；`requires:['model']` 在无模型时不跑 body 并返回 `{available:false, reason}` |
| `test_tools_context.mjs` | `studymate_workspace_context` 的结构化摘要（工作区路径、今天、时区、科目现状含当前节点与三档、最近学习记录、可用能力），以及**逐域投影**：`subjects` 切片里没有题库、没有课件正文（顺着节点也读不到别的域） |
| `test_tools_validate.mjs` | 四个校验工具：数据层（大纲／进度／科目，逐条带行号）、内容层（格式 + 锚点四态 + 图片存在性 + 题库坏 JSON）、图片库（`check_pool.py` 的行为移植：表头、命名、三列非空、日期、体积）、交接门禁（明确放行／阻断） |
| `test_tools_rewrite.mjs` | 两个改写工具（`renumber_lessons` 与 `apply_empty_reasons` 的行为照搬）：位次重排（dry-run、换位、目标名被占、重复、认不出的命名）与 `empty_reason` 写入（位置、缩进、CRLF、拦下的六类）；`studymate_export` 的占位形状 |
| `test_export_static_page.mjs` | 导出（`lib/export/**`）的**产物形状与取消语义**：清单齐全、脚本顺序（数据 → 宿主 → 第三方 → 阅读端本体 → 挂载）、`studymate-client.js` 与仓库里 `lib/client.js` **逐字节相同**（哈希）、页面里没有 ES 模块（`file://` 下加载不了）、机器路径不进产物、守卫对这一份真产物干净、取消说清保留了什么（已落成的保留、入口排在最后写所以半成品一眼可见）、`out` 的判据（不许进 `.learning/`、不许就是工作区根）。夹具 React，真渲染在 `--browser` 组 |
| `test_export_leak_guard.mjs` | **泄漏守卫**（F11 / 规格 §8）：规则表逐条生效、真产物扫下来干净；**反证**——注入一个 Node 专用依赖之后构建期守卫必须失败（进程内 `exportGuardRun({inject})` 与命令行 `node scripts/release/export_guard.mjs --inject host.js` 各一条，都要非零退出）；第三方包装被改 / 壳里内容被换 / 阅读端本体被改，哈希核对逐个报出来；假阳性防线（`data.js` 载荷里的 require 调用是课件正文，不算泄漏） |
| `test_export_tool_task.mjs` | 导出的**工具面与任务模型**：DSH 侧**不主动导出**（注册完一个任务都没有、一个产物都没写）、`studymate_export` 起 `durable` 的「导出」任务并**有上限地等**（等到给文件清单，等不到给下一步）、产物登记成绝对路径、阅读端那块板子上看得到且没有 owner、取消（排队中 → 当场已取消没有半成品；已完成 → 「取消来晚了」且已完成产物一律保留）、越权句柄被拒、入参坏形状当场说清 |
| `test_export_cli.mjs` | 无头宿主的**命令行**（`bin/studymate.mjs export`，真子进程）：`--json` 一行结果、**没有参数也能跑**（工作区从当前目录/`$LEARN_WORKSPACE`/配置认出来 = 「课完默认导一份」）、课完再导一份是幂等的、`--subject` / `--out`、报错都是人话、帮助里有 export |
| `test_tasks_model.mjs` | 任务模型（`lib/tasks/**`）：六态状态机（排队／运行／取消中／完成／失败／已取消）与转移表、状态查询不阻塞、等待有上限且超时给**下一步提示**、三种结局各一份回执、取消回执写清保留哪些已完成产物、销毁**先回执后删文件**（用「回执到手时文件还在」直接断言顺序）、owner 句柄越权被拒、五个 `studymate_task_*` 工具与 `GET /api/studymate/tasks` 的返回形状；**跨进程**那一节 spawn 夹具 `fixtures/tasks_producer.mjs`（进程 A 起 durable 任务并落盘 → 进程 B 重新加载后查得到、resume 得动） |

## 提示词规则归属

`test_skill_rules.py` 逐条断言「旧版里的可执行规则还在」。片段**住在哪**由 `rule-owners.json` 声明，不由它挂在哪个技能下决定：

| 键 | 是什么 | 怎么写 |
| --- | --- | --- |
| `reaches` | 谁加载谁（`learning-system` → 它开场加载的三份协议；角色 → 它自己加载的规范） | 只在真有加载关系时写；名字写错、指向不存在的技能会当场报错 |
| `moved` | 某条规则的正文其实住在哪个协议里：`{技能: {规则说明: owner}}` | 把一条规则从总控搬进它加载的协议时，提示词改一处 + 这里加一行，**断言不用动** |

断言问的是「这个技能够不够得着这条规则」：owner 默认是键所在的技能，声明过 `moved` 就按声明走，且 owner 必须在该技能的 `reaches` 名单里。表里的死条目（说明写错、owner 够不着）也会报错，不让声明悄悄空转。

## DSH 实际安装与启动

兼容性改动时，在独立目录安装要检查的 DSH，然后指定其包目录：

```sh
npm install --prefix /tmp/studymate-dsh @deepseek-ai/dsh@0.1.7-alpha.2
export STUDYMATE_DSH_PACKAGE=/tmp/studymate-dsh/node_modules/@deepseek-ai/dsh
npm run test:dsh
npm run test:dsh-cli
```

Windows PowerShell 可用 `$env:STUDYMATE_DSH_PACKAGE = '<独立安装目录>/node_modules/@deepseek-ai/dsh'` 设置包目录。需要 Python 3.9+、PyYAML；CLI 测试另需 `pnpm`。未设置 `STUDYMATE_DSH_PACKAGE` 时跳过，不读取本机默认 DSH 配置。

测试创建临时 HOME、DSH_HOME 和工作区，启动仅监听本机随机端口的 Web，不调用模型。CLI 测试通过临时本地 registry 安装、更新和卸载实际打包的 StudyMate，检查普通模式、学习模式、安装方式切换、缺少 Python 及学习数据保留。

`test:dsh` 的探针在**插件真的被加载**时（native 安装）还验一遍原生工具：八个 `studymate_*` 在 `ctx.tools` 上按名字查得到、模型侧投影只有一句话说明，走真 dispatch 调 `studymate_workspace_context` / 两个校验器 / 导出占位，并反证越权读、越权写会抛 `[DOMAIN_VIOLATION]`。**它验的不是「模型在真实会话里调了工具」**——那要花额度，默认门禁不跑（结果里的 `modelRequestsIssued` 恒为 0）。standalone 安装写的是声明式预设、插件包不进 profile，那种安装下没有原生工具，探针按 `nativeTools: null` 照实断言。

同一套探针也钉 #70 的引擎路径：**native 安装下 `root` 指向已安装的包自身**（包里有 `scripts/`，技能仍按 `<root>/scripts/*.py` 调得动，这是刻意的迁移窗口），`~/.dsh/studymate/engine/` 不再出现源码树副本；standalone 安装照旧把引擎副本落在那里、`root` 也照旧指向它。另有一条从 standalone 交接（`--mode native`）到原生启动的用例，验 `root` 从 `engine/` 换成包目录。

另设 `STUDYMATE_DSH_EXPECTED_VERSION` 可以核对实际宿主版本；设 `STUDYMATE_DSH_DOWNGRADE_PACKAGE` 为旧 DSH 包目录，可以检查旧版安装升级后的显式迁移，以及降级和重新安装恢复。两个 DSH 目录只读。这些兼容场景按需在目标系统和版本上运行，不再由 CI 安装多个宿主版本重复执行。

## 浏览器套件与手动工具

六套断言套件（`npm run test:browser`）都走同一个骨架 [browser/harness.mjs](browser/harness.mjs)：
探测本机浏览器 → 起 CDP → 收**控制台错误 / 页面错误（未捕获异常）/ 失败请求** → 每个场景出截图与 `summary.json`。

| 文件 | 用途 |
| --- | --- |
| `browser/hl_test.mjs` | 代码块高亮、语言识别与已有高亮保留（旧静态模板夹具） |
| `browser/quiz_code_test.mjs` | 题目代码块的缩进、等宽字体与高亮（旧静态模板夹具） |
| `browser/math_test.mjs` | KaTeX 排版、字体、错误公式与动态题目公式（旧静态模板夹具） |
| `browser/reading_test.mjs` | **阅读端本体**：把真的 `lib/client.js` 挂进夹具页，走「主页 → 科目页（路线图 aria-label + 视觉隐藏表格）→ 课件页（三栏、进度条、窄轨）」、动效四档与 `prefers-reduced-motion`、亮暗两套的**实测对比度**（含 color-mix 是否真解出来） |
| `browser/reading_position_test.mjs` | 阅读位置三级恢复（section → offset → progress）与锚点四态复核：真 Chrome 里挂**真 `lib/client.js`**（最小模块装载器 + 真 React），用 CDP 点真按钮、滚真滚动区；夹具在 `fixtures/reading_position_fixture.mjs`。纯数学那一半在 `test_client_reading_position.mjs`（默认门禁里跑，不需要浏览器） |
| `browser/export_file_test.mjs` | **导出的产物本身**在 `file://` 下打开（#82 验收第 1 条）：先用真导出器导一份到临时目录，再用真 Chrome 打开 `file://<导出目录>/index.html`——样式（离线兜底 token）、行内/块级公式、配图（`naturalWidth > 0`）、代码块、题目与判分、参考资料只读都要可用，且控制台/页面/失败请求干净。不搭夹具页：测的就是学生拿到的那份东西。真 React + 真浏览器缺任一就**明确跳过**（退出码 3） |
| `browser/measure.mjs` | 对比度、计算样式与 hover 测量（手动） |
| `browser/hovers.mjs` | 批量比较 hover 前后的样式（手动） |
| `browser/shot.mjs` | 浅色/深色截图与元素边界记录（手动） |

浏览器二进制**探测**，不钉死 `google-chrome`：先看 `STUDYMATE_CHROME` / `CHROME_BIN` / `CHROMIUM_BIN` /
`PUPPETEER_EXECUTABLE_PATH`，再看 PATH 上的 `google-chrome` / `chromium` / `chrome` 等，最后看 macOS 的 `.app` 路径。

**找不到浏览器时套件明确跳过**：打一段说明（试过哪些、怎么指）并以退出码 **3** 退出——跳过不算通过，
所以不会出现「没跑过却报绿」。`npm test`（默认门禁）不含 `--browser`，CI 不受影响。

产物落在仓库根的 `.shots/<套件>/`（已 gitignore）：每个场景一张 `<场景>.png` 加一份 `summary.json`，
里面是每个场景的 metrics、problems（控制台错误 / 页面错误 / 失败请求）与 warnings。
有 problems 的场景按失败算。

后三项是手动工具，不是断言套件；浏览器工具需要提供页面 URL：

```sh
node scripts/tests/browser/measure.mjs <file-url> [--hover ".sel"]
node scripts/tests/browser/shot.mjs <file-url> <out-prefix> <css-selector>
```

阅读端那条套件用的夹具在 [fixtures/](fixtures/)：`mini-react.js` 是只够跑阅读端的最小渲染器
（宿主那份 React 打包在 bundle 里，拿不到），`host-theme-tokens.json` 是宿主主题 token 的快照，
`client-css.mjs` 负责从 `lib/client.js` 里解析 CSS 与 token 块。夹具页的 CSS 与 JS **都从源码现取**，
不手抄一份标记。

## 写新测试

方向探索的验收场景与待验证项见 [学习方向探索验收](../../docs/设计/learning-discovery-validation.md)。这里的规则断言与人工走读均不能代替实际模型对话验证；尤其八问上限、退出后停问、确认前无写入，需要在学习模式中观察对话与工具调用。技能调用面另用 `python3 scripts/check_skill.py .dsh/skills/learning-discovery --expect-model-invocable` 校验。

[learning_discovery_cases.json](fixtures/learning_discovery_cases.json) 提供 12 个合成多轮场景、按问题披露的用户回答与独立评审判据。它是可重复使用的测试数据，**不是通过记录或自动评分器**。真实模型验证按每场景 3 次执行；使用隔离学习目录，保存对话、工具调用和文件变化。不要把 `checks`／`review_only` 作为用户输入发给被测模型，也不要将这些联网、消耗模型额度的运行加入默认快测或发布检查。目标 DSH 版本不同可用界面逐轮执行，无须依赖其内部 API。

`fixtures.py` 负责造一份能过检查的最小科目，测试只注入目标偏差，避免无关错误影响断言。它按真实布局（`<root>/.learning/subjects/<slug>/`）写盘，并铺好共享层与科目组件的占位文件。

```python
import fixtures
subject = fixtures.write_subject(tmp)
path = fixtures.write_lesson(subject, 2, 'first-program',
                             quiz='<div class="quiz" data-quiz=…></div>')
code, out = fixtures.run_gate(path, subject, 'first-program')
```

课件渲染链路使用内容文件、题库、渲染与检查器：

```python
subject = fixtures.write_subject(tmp, name='测试科目')
md = fixtures.write_content(subject, 2, 'first-program',
                            body='## 小节\n\n::: quiz 理解 锚点：本节校验\n:::\n')
fixtures.write_quiz(subject, 2, 'first-program', {
    '本节校验': [{'q': '…', 'answer': '…', 'criteria': '…'}]
})
code, out = fixtures.run_render(subject, 'first-program')
code, out = fixtures.run_gate(fixtures.lesson_html(subject, 2, 'first-program'),
                              subject, 'first-program')
```

默认 fixture 为概念课，不要求 lab；测试实验课时需要自行建立 `lab/` 产物。
