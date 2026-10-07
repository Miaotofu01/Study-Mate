# 回归测试

默认检查与 GitHub Actions 共用一个入口：

```sh
npm test
```

需要 Node.js（支持范围看 `package.json` 的 `engines`）。**不需要 Python**：引擎随包发 TypeScript，`node` 直接跑 `.ts`（Node 原生类型擦除）。`npm ci` 装 devDependencies（`typescript` 与 `@types/node`）——类型门禁要它们。**各命令的前置以本文件为准**，别处只给指针：Actions 实际用 Node 24，只在 Ubuntu 上跑一次，不展开系统和运行时矩阵。默认检查只跑安装器、插件打包、引擎（数据层/内容层）、静态契约与发布逻辑，不安装真实 DSH、pnpm 或浏览器，不调用模型。

测试使用临时目录，不读写学生的 `workspace/`。

## 按需运行

| 命令 | 范围 |
| --- | --- |
| `npm test` | 全部默认功能回归，与 CI 一致 |
| `npm run test:installer` | npm 安装入口、预设与 Bundle |
| `npm run test:openai` | OpenAI 插件 ZIP、完整性、独立运行与导出保护 |
| `npm run test:antigravity` | Antigravity 插件 ZIP、原生 agents、导出保护与重复构建 |
| `npm run test:release` | 版本、changelog、重试和发布保护 |
| `npm run test:static` | 技能调用面与提示词规则归属、词表与发布元数据、文档悬空引用、OpenAI 与 Antigravity skill 转换及 UI 元数据（`npm test` 已含这一层，这里可单独跑） |
| `npm run test:browser` | 十套真实浏览器渲染测试（阅读端本体、阅读位置、作答落盘、监听推送、跑一次、导出产物、公式排版、四路由 × 三档视口、课件页正文与页头、问答会话与引用），浏览器二进制自动探测 |
| `npm run test:dsh` | 真实 DSH 启动与 Web 预设，需要指定 DSH 包目录；native 安装下还验八个原生工具的注册、body 可调用（走真 dispatch）与越权抛，以及 #70 的引擎路径：`root` 指向已安装的包、`~/.dsh/studymate/engine/` 不再出现 |
| `npm run test:dsh-contract` | **宿主契约守门**：拿真宿主自己的 schema 校验器（`dsh-tools` 的 `assertSupportedJsonSchema`）扫注册点上全部工具的 `parameters` 与 `output.schema`，并核对参考调用 `createWebhookSession` 的字段清单没漂；附一条反证（已知不合规的 schema 必须报错）。同一个 `STUDYMATE_DSH_PACKAGE`，没设就跳过。指针与纪律在 [工程约束](../规范/工程约束.md) §三「宿主契约」 |
| `npm run test:dsh-cli` | 真实 DSH CLI 安装、更新、卸载，还需要 `pnpm` |

提示词与文档契约、两个宿主的技能转换这一层（`--static`）**已并入 `npm test`**，CI 每次都会跑；保留为本地按需命令的只剩真实宿主（`test:dsh` / `test:dsh-cli`）与真实 Chrome（`test:browser`）——它们要外部环境，不适合当默认门禁。`scripts/release/checks.mjs` 显式列出各层套件——**显式的代价是新增套件会静默地永远不跑**，所以那里有一条覆盖断言：`scripts/tests/` 下的每个文件必须属于某个组（core / `--static` / `--browser`）、package.json 的按需入口（`test:dsh` 等），或在 `MANUAL_ONLY` 里明确登记为手动脚本。漏登记时跑门禁会直接报出文件名并以退出码 2 停下。

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
| `test_openai_plugin.mjs` | ZIP 用**独立读取器**解开后不依赖源码或 DSH 即可跑交互断点（read → update → answer）、没有 0 字节文件也没有 Python 文件；构建可重复，失败时保留已有产物 |
| `test_preset_install.mjs` | 预设注册（`lib/preset.ts`，原 Python 安装助手的**行为移植**）：版本边界各自独立、补丁形态保留与幂等（注释、`!!js`、CRLF、流式列表）、暂存与 `--patch-output`、手动声明/越界 profile/坏清单/符号链接一律在写盘之前失败、`--bundle` 给 DSH 的 config 形状 |
| `test_interaction_state.mjs` | Codex 交互断点（`openai/studymate/scripts/interaction_state.mjs`）：工作区必须显式且初始化过、revision 栅栏、锁不等待、迟到/重复/已消费的 question id 不能推进、空回答不算、坏了的状态不许覆盖、提交成功但锁清不掉时如实报成功 |
| `test_docs_references.mjs` | 文档悬空引用：README 与 `docs/**` 里的相对链接、行内代码里的仓库路径都必须在盘上真实存在（历史设计文档显式列为例外） |
| `test_skill_frontmatter.mjs` | 12 份技能的调用面：5 个角色两个面都关、总控与 6 个协议两个面都开、布尔值形状 |
| `test_skill_visibility.mjs` | 技能与工具的**可见边界**（#87）：照宿主的项目根规则走一遍当前 cwd，断言 `<项目根>/.dsh/skills` 与 `<项目根>/.agents/skills` 上什么都没有（工作目录在本仓库里也成立）；入方向——预设只在一个地方声明技能目录、那份声明指向包内真实存在的 12 份技能、占位符丢了安装时就抛；外加一条**特征化**断言把「工具/面板仍注册在 profile 根、不在预设作用域」这个与 spec 的已知偏离钉住（偏离记录在[工程约束](../规范/工程约束.md) §二「技能与工具的可见边界」） |
| `test_statuses.mjs` | 三档词表与 schema 逐字对齐、旧六档只活在读侧映射里、题型/课型词表与 schema 一致，以及 `lib/library.ts` 那份字面量与 `lib/core/rules.ts` 不分叉 |
| `test_release_metadata.mjs` | `package.json` 的版本等于最新可达的 `v*` tag（本地浅克隆跳过，CI 里读不到 tag 就红） |
| `test_antigravity_plugin.mjs` | Antigravity 插件包含 5 个原生子代理与 12 个技能、无 0 字节文件、占用的输出目录不被清空、构建可重复 |
| `scripts/release/release.test.mjs` | 版本计算、更新记录、历史 tag、PR 去重、制品校验与重试保护 |
| `test_host_library_payload.mjs`、`test_host_reference_fence.mjs`、`test_host_path_boundary.mjs`、`test_host_yaml_workspace.mjs` | Host 半数据层（`lib/{workspace,library,assets,yaml,reference}.ts`）的特征化测试：payload 顶层与科目/节点形状、旧六档→三档、锚点四态、`operationId` 幂等重放、`expectedVersion` 冲突拒绝、路径越界、YAML 子集与工作区配置读取。数据在临时目录现造现弃，不碰真实工作区 |
| `test_host_perf_budget.mjs` | **性能预算**（目标态规格 §10.3）：写成「相对工作区规模的比例」而不是绝对秒数——现造 16 课与 64 课两份工作区，数 `readLibrary()` 真的碰了几次文件系统（`readFileSync` / `readdirSync` / `statSync`…），断言 4 倍规模的工作量落在 `[3, 6]`（线性 ≈ 4、平方 ≈ 16、常数 ≈ 1）。数字是确定性的，不取挂钟——时间抖动在共享 CI 上只会变成假红 |
| `test_host_route_envelope.mjs` | 阅读端 HTTP 路由的**错误信封**（`lib/route-envelope.ts`）：形状恒为 `{ ok:false, error:{ code, message } }`（`extra` 覆盖不掉这两个键）、`ROUTE_ERROR_CODES` 是唯一一份机读码词表（扫 `lib/**`、`bin/**` 的调用点，用了表外的码就红）、客户端只从 `error.code` / `error.message` 取值（`lib/client.js` 是手写 JS，不进 tsc）。契约的人读版在[工程约束](../规范/工程约束.md) §三 |
| `test_host_paths.mjs` | 路径包含判据**本身**（`lib/paths.ts`）：reference 的读写、assets 的取址、导出的落点、实验命令的 cwd／可写范围／参数路径四处共用这一份，所以边界值直接钉住——同前缀的兄弟目录（`/a/bc` 不在 `/a/b` 里）、父目录与 `..`、`root` 带尾分隔符、软链指到边界之外、断链；并断言四个调用点都走这一份、谁也没再长出私有副本 |
| `test_core_schema_subset.mjs` | JSON Schema 子集校验器（`lib/core/schema.ts`）：关键字枚举表与六份真 schema 对齐（新增关键字会红）、不支持的关键字不静默放行、逐个断言的 `type`/`required`/`additionalProperties`/`enum`/`const`/`pattern`/`minLength`/`minimum`/`minItems`/`format` |
| `test_validators_curriculum.mjs` | 大纲校验（`validateCurriculum`）与带位置的 YAML 读取：DAG 无环、位次不倒挂、实验课前置非空、字段齐全、重复 id、悬空引用；行号是解析位置（夹具里放了逐字相同的**诱饵注释**，文本搜索会指错行）；并与 `lib/yaml.ts` 的值树逐路径对齐 |
| `test_validators_progress_subject.mjs` | 进度与科目的 schema 与取值：旧六档读到就报映射、进度与大纲的引用完整性、空串 `name`/`goal`、`created_at` 是否真实存在、`slug` 与目录名不一致 |
| `test_validators_handoff.mjs` | 交接门禁（`validateHandoff`）：明确放行/阻断、manifest ↔ `deliver/` 覆盖、角色/节点绑定、路径边界、symlink、可选 SHA-256、重复 JSON key 与 JSON 语法错误的真实行列 |
| `test_rules_pure.mjs` | 纯函数规则层（`lib/core/rules.ts`）：四层判定逐条通过标准、题型与深度的匹配、旧六档 → 三档六条映射逐条断言、证据资格与分母口径；并断言 `lib/core/**` 不 import `node:*` |
| `test_core_coverage_floor.mjs` | 覆盖率下限：自己 spawn 一轮带 `--test-coverage-*` 阈值的 `node --test`，规则层与整个 `lib/core/**` 的覆盖率不达标就让门禁红。统计范围**自动发现**（`lib/core/**` 有哪几个模块、哪几条套件真的把它们拉进这一轮，全从盘上算），并断言每个模块都出现在覆盖率报告里——没被加载的模块不进分母，静默少算会红 |
| `test_architecture_boundaries.mjs` | 架构边界与依赖无环（#69）：扫真实源码解析 `import` / `export … from` / 动态 `import()` 得到 import 图，按文件顶部那张**域规则表**判（`lib/` 一级目录 = 域，未知域默认拒绝，`lib/core/**` 不许碰 `node:*` 与域外东西），域图与模块图都断言无环；另有合成图的反证用例钉住判据本身 |
| `test_tools_guard.mjs` | 原生工具域（`lib/tools/{domains,access,define,index,capability}.ts`）：八个工具的名字与**声明表**（谁读哪些域、写哪些字段，放宽一行就红）、`description` 只有一句话、注册走 `ctx.effect`；**反证**越权读与越权写必须抛 `DomainViolationError`（写越权时回调一次都不跑）；`requires:['model']` 在无模型时不跑 body 并返回 `{available:false, reason}` |
| `test_tools_context.mjs` | `studymate_workspace_context` 的结构化摘要（工作区路径、今天、时区、科目现状含当前节点与三档、最近学习记录、可用能力），以及**逐域投影**：`subjects` 切片里没有题库、没有课件正文（顺着节点也读不到别的域） |
| `test_tools_validate.mjs` | 四个校验工具：数据层（大纲／进度／科目，逐条带行号）、内容层（格式 + 锚点四态 + 图片存在性 + 题库坏 JSON）、图片库（原 Python 校验器的行为移植：表头、命名、三列非空、日期、体积）、交接门禁（明确放行／阻断） |
| `test_tools_rewrite.mjs` | 两个改写工具（位次重排与无题理由回填，原 Python 脚本的行为照搬）：位次重排（dry-run、换位、目标名被占、重复、认不出的命名）与 `empty_reason` 写入（位置、缩进、CRLF、拦下的六类）；`studymate_export` 的占位形状 |
| `test_client_math.mjs` | 公式那一段的**阅读端契约**（#91，Node 里跑真 `lib/client.js`，React 是桩）：题库字段（题面 / 选项 / 解析 / 参考答案 / 判分要点）里的 `$…$` 出来的是同一个 `MathSpan`；题库字段**只接数学式**（粗体 / 反引号 / 链接保持字面量）；引擎没到位时元素里是 TeX 原文（降级可读），失败时多一句「公式没排出来：…」。**#96 加的**：按需携带那条判据（`lib/math.ts` 的 `hasMathInPlainText`）与阅读端的 `MATH_ONLY` **逐字对账**——正则从 `lib/client.js` 源码里取出来，改一边忘另一边就红。真排版在 `browser/math_test.mjs` |
| `test_host_math_route.mjs` | 随包发的 KaTeX dist（#91）：CSS 里的 `url(fonts/…)` 与盘上的 `fonts/*.woff2` **双向**对账、版本与 `katex.min.js` 自报的一致、精确 MIME（不许兜 octet-stream）、取址判据（越界 / 软链逃逸 / 非投送类型都取不到）、路由形状（一条文件一条精确路由、全在 `/api/studymate/math/` 之内）|
| `test_export_static_page.mjs` | 导出（`lib/export/**`）的**产物形状与取消语义**：清单齐全、脚本顺序（数据 → 宿主 → 第三方 → 阅读端本体 → 挂载）、`studymate-client.js` 与仓库里 `lib/client.js` **逐字节相同**（哈希）、页面里没有 ES 模块（`file://` 下加载不了）、机器路径不进产物、守卫对这一份真产物干净、取消说清保留了什么（已落成的保留、入口排在最后写所以半成品一眼可见）、`out` 的判据（不许进 `.learning/`、不许就是工作区根）。**#96 的按需携带**也在这一套：判据本身（正文先剔代码、其余字段整串扫、分叉一律偏向带）、没有数学式的科目产物里一个 KaTeX 文件都不带、公式只在题库字段里时照带。夹具 React，真渲染在 `--browser` 组 |
| `test_export_leak_guard.mjs` | **泄漏守卫**（F11 / 规格 §8）：规则表逐条生效、真产物扫下来干净；**反证**——注入一个 Node 专用依赖之后构建期守卫必须失败（进程内 `exportGuardRun({inject})` 与命令行 `node scripts/release/export_guard.mjs --inject host.js` 各一条，都要非零退出）；第三方包装被改 / 壳里内容被换 / 阅读端本体被改，哈希核对逐个报出来；假阳性防线（`data.js` 载荷里的 require 调用是课件正文，不算泄漏） |
| `test_export_tool_task.mjs` | 导出的**工具面与任务模型**：DSH 侧**不主动导出**（注册完一个任务都没有、一个产物都没写）、`studymate_export` 起 `durable` 的「导出」任务并**有上限地等**（等到给文件清单，等不到给下一步）、产物登记成绝对路径、阅读端那块板子上看得到且没有 owner、取消（排队中 → 当场已取消没有半成品；已完成 → 「取消来晚了」且已完成产物一律保留）、越权句柄被拒、入参坏形状当场说清 |
| `test_export_cli.mjs` | 无头宿主的**命令行**（`bin/studymate.mjs export`，真子进程）：`--json` 一行结果、**没有参数也能跑**（工作区从当前目录/`$LEARN_WORKSPACE`/配置认出来 = 「课完默认导一份」）、课完再导一份是幂等的、`--subject` / `--out`、报错都是人话、帮助里有 export |
| `test_tasks_model.mjs` | 任务模型（`lib/tasks/**`）：六态状态机（排队／运行／取消中／完成／失败／已取消）与转移表、状态查询不阻塞、等待有上限且超时给**下一步提示**、三种结局各一份回执、取消回执写清保留哪些已完成产物、销毁**先回执后删文件**（用「回执到手时文件还在」直接断言顺序）、owner 句柄越权被拒、五个 `studymate_task_*` 工具与 `GET /api/studymate/tasks` 的返回形状；**跨进程**那一节 spawn 夹具 `fixtures/tasks_producer.mjs`（进程 A 起 durable 任务并落盘 → 进程 B 重新加载后查得到、resume 得动） |

## 提示词规则归属

`test_skill_rules.mjs` 逐条断言「旧版里的可执行规则还在」（512 条，原 Python 套件 `test_skill_rules` 的行为移植）。片段**住在哪**由 `rule-owners.json` 声明，不由它挂在哪个技能下决定：

| 键 | 是什么 | 怎么写 |
| --- | --- | --- |
| `reaches` | 谁加载谁（`learning-system` → 它开场加载的三份协议；角色 → 它自己加载的规范） | 只在真有加载关系时写；名字写错、指向不存在的技能会当场报错 |
| `moved` | 某条规则的正文其实住在哪个协议里：`{技能: {规则说明: owner}}` | 把一条规则从总控搬进它加载的协议时，提示词改一处 + 这里加一行，**断言不用动** |

断言问的是「这个技能够不够得着这条规则」：owner 默认是键所在的技能，声明过 `moved` 就按声明走，且 owner 必须在该技能的 `reaches` 名单里。表里的死条目（说明写错、owner 够不着）也会报错，不让声明悄悄空转。

## 技能正文与代码对账

`test_skill_contracts.mjs` 把技能正文里点名的东西与代码里的唯一出处对上，分三类：

- **调用面**：正文里反引号包起来的 `studymate_*` 必须都在 `lib/tools/index.ts` 的名字表里（注册表是唯一出处）——**两张表的并集**：学习面 `STUDY_TOOL_NAMES`（八条）与答疑面 `QA_TOOL_NAMES`（只挂答疑预设的那条只读工具）；而且**真跑一遍两个宿主的导出**——Codex/OpenAI 与 Antigravity 的导出件里不许再留原生工具名、必须有等价的引擎命令落点（映射表在两个 `bin/*-skill-compat.mjs` 里）。
- **词表**：`layered-practice` 的四层（含义与通过标准）与四种题型（服务哪一层、必备字段）必须与 `lib/core/rules.ts` 的 `LAYERS` / `LAYER_RULES` / `QUESTION_KINDS` / `QUESTION_KIND_SHAPES` / `QUESTION_RULES` 逐字一致；`evidence-check` 的可信度排序与排除清单必须与 `EVIDENCE_BY_TRUST` / `NON_INDEPENDENT_EVIDENCE` 逐条一致。
- **#81 的范围**：两个教学协议与五个角色的技能里不写引擎脚本命令，也不再出现旧六档与旧四层名。

## DSH 实际安装与启动

兼容性改动时，在独立目录安装要检查的 DSH，然后指定其包目录：

```sh
npm install --prefix /tmp/studymate-dsh @deepseek-ai/dsh@0.1.7-alpha.2
export STUDYMATE_DSH_PACKAGE=/tmp/studymate-dsh/node_modules/@deepseek-ai/dsh
npm run test:dsh
npm run test:dsh-cli
```

Windows PowerShell 可用 `$env:STUDYMATE_DSH_PACKAGE = '<独立安装目录>/node_modules/@deepseek-ai/dsh'` 设置包目录。CLI 测试另需 `pnpm`。未设置 `STUDYMATE_DSH_PACKAGE` 时跳过，不读取本机默认 DSH 配置。

测试创建临时 HOME、DSH_HOME 和工作区，启动仅监听本机随机端口的 Web，不调用模型。CLI 测试通过临时本地 registry 安装、更新和卸载实际打包的 StudyMate，检查普通模式、学习模式、安装方式切换与学习数据保留。

`test:dsh` 的探针在**插件真的被加载**时（native 安装）还验一遍原生工具：八个 `studymate_*` 在 `ctx.tools` 上按名字查得到、模型侧投影只有一句话说明，走真 dispatch 调 `studymate_workspace_context` / 两个校验器 / 导出占位，并反证越权读、越权写会抛 `[DOMAIN_VIOLATION]`。**它验的不是「模型在真实会话里调了工具」**——那要花额度，默认门禁不跑（结果里的 `modelRequestsIssued` 恒为 0）。standalone 安装写的是声明式预设、插件包不进 profile，那种安装下没有原生工具，探针按 `nativeTools: null` 照实断言。

同一套探针也钉 #70 的引擎路径：**native 安装下 `root` 指向已安装的包自身**（技能、预设、schema、数据骨架都在包里），`~/.dsh/studymate/engine/` 不再出现源码树副本；standalone 安装照旧把那份**只读材料**落在那里、`root` 也照旧指向它。另有一条从 standalone 交接（`--mode native`）到原生启动的用例，验 `root` 从 `engine/` 换成包目录。

另设 `STUDYMATE_DSH_EXPECTED_VERSION` 可以核对实际宿主版本；设 `STUDYMATE_DSH_DOWNGRADE_PACKAGE` 为旧 DSH 包目录，可以检查旧版安装升级后的显式迁移，以及降级和重新安装恢复。两个 DSH 目录只读。这些兼容场景按需在目标系统和版本上运行，不再由 CI 安装多个宿主版本重复执行。

## 浏览器套件与手动工具

浏览器断言套件（`npm run test:browser`）都走同一个骨架 [browser/harness.mjs](browser/harness.mjs)：
探测本机浏览器 → 起 CDP → 收**控制台错误 / 页面错误（未捕获异常）/ 失败请求** → 每个场景出截图与 `summary.json`。
另收 `Network.requestWillBeSent` 进 `ctx.requests`（场景维度、不算问题）：断「零请求 / 发的是哪些」
的套件用它（`file://` 下 `performance.getEntriesByType('resource')` 返回空数组）。

| 文件 | 用途 |
| --- | --- |
| `browser/attempts_test.mjs` | 作答落盘（#72）：把阅读端打进一个说 HTTP 的迷你宿主，真落盘到工作区文件 |
| `browser/watch_push_test.mjs` | 真浏览器里「改文件 → 监听 → SSE → 页面自己更新（不刷新）」的端到端（#74） |
| `browser/reading_test.mjs` | **阅读端本体**：把真的 `lib/client.js` 挂进夹具页，走「主页 → 科目页（路线图 aria-label + 视觉隐藏表格）→ 课件页（三栏、进度条、窄轨）」、动效四档与 `prefers-reduced-motion`、亮暗两套的**实测对比度**（含 color-mix 是否真解出来；探针是共用的 `fixtures/contrast-probe.mjs`） |
| `browser/reading_routes_test.mjs` | **四路由 × 三档视口**（#86；紧档 #88）：今天学什么 / 科目主页 / 课件页 / 搜索四个面在宽档、窄档（800×900）与**紧档（700×900）**（真换 CSS 视口，`max-width: 900px` 的响应式规则真的执行，三条曾经的「死声明」被断言钉住）各取一次景，四个面 × 亮暗两套的实测对比度、动效四档与 `prefers-reduced-motion` 也在里面；另有一场按 1440/1100/900/776/700 扫三栏几何（点「题目」「节点」有没有反应、中栏保底、正文列占中栏多少）、一场取宽画布上**默认形态**的正文列。每档的 metrics 记着断点命中、栏形态（并排 / 盖在正文上）、窄轨实测宽与正文列溢出量。**紧档取的就是「并排装不下」那个态**：右栏在那一档是盖在正文上的抽屉，顶上写着为什么、一条「收起」回得去，题目与选项都在里头（#88 验收第 4 条）。**#90 加的**：主页第一屏那张卡点得进去、空目录 / 半份数据 / 零节点三份退化输入各自的「还没有」、搜索每条结果标出科目与节点且无断点长 URL 不撑破结果行（**#98 起按行级格子量**，并配一条反证——见上面「横向溢出判据」一节）。**#93 加的**：右栏题库的内部呈现——另造一份夹具（三种题型各一组、题干与选项里各一段没有断点的长 token、题库带着一次落盘的作答），三档各跑两场：题型徽标是贴字的标签（不是被弹性行拉成竖条的）、右栏 tab 的选中态是右栏专用的下划线（tab 条在内容上方、与内容同宽；紧档的抽屉形态下也一样）、上次作答的结果在右栏里看得见（切 tab / 就地作答之后都还在）、点正文里的题目标记那一组就是「当前」（换到下一课不跟过去）、右栏只出纵向滚动条（长 token 折行而不是被组卡片裁掉）。`-quiz-marked` 那一场把镜头停在「点过标记之后」，三档截图可判 |
| `browser/reading_position_test.mjs` | 阅读位置三级恢复（section → offset → progress）与锚点四态复核：真 Chrome 里挂**真 `lib/client.js`**（最小模块装载器 + 真 React），用 CDP 点真按钮、滚真滚动区；夹具在 `fixtures/reading_position_fixture.mjs`。纯数学那一半在 `test_client_reading_position.mjs`（默认门禁里跑，不需要浏览器） |
| `browser/lab_run_test.mjs` | 交付物题的**「跑一次」**（#77）：真浏览器里挂**真 `lib/client.js`**，打到真 HTTP 迷你宿主（`lib/lab/route.ts` 注册出来的真路由 → 真 spawn 一条命令）——验「不按不跑 → 按了才跑、真实输出回到界面、落进 `attempts/<NNNN>-<节点>.json`、刷新之后还在、界面上一个判决词都没有」；夹具与 `attempts_test.mjs` 同一套 |
| `browser/export_file_test.mjs` | **导出的产物本身**在 `file://` 下打开（#82 验收第 1 条）：先用真导出器导一份到临时目录，再用真 Chrome 打开 `file://<导出目录>/index.html`——样式（离线兜底 token）、行内/块级公式（#91 起断的是**真的排出来了**：`.katex` 在容器里、TeX 从 annotation 读回、`document.fonts.check` 的 KaTeX_Main 真的加载）、题面里的公式同样排版、配图（`naturalWidth > 0`）、代码块、题目与判分、参考资料只读都要可用，且控制台/页面/失败请求干净。**#96 的两侧**：有数学式的产物带着引擎、首页就取它，进课件页后样式表与 woff2 字体都从产物里取；另导一份没有数学式的科目，`export-no-math` 一场按 **CDP 请求日志**断「整场没有一条去取 KaTeX 的请求」（`file://` 下 `performance.getEntriesByType('resource')` 是空的，不能用）。不搭夹具页：测的就是学生拿到的那份东西。真 React + 真浏览器缺任一就**明确跳过**（退出码 3） |
| `browser/math_test.mjs` | 公式排版（#91）：夹具是一个说 HTTP 的迷你宿主，按 `lib/math-route.ts` 注册出来的真路由投送**包里那份 KaTeX dist**，页面跑真 `lib/client.js`。五个场景——正文行内/块级公式排出来（`.katex` + `document.fonts.check` 的 KaTeX_Main）、公式只写在题面里也照样加载（打开题库那一刻才取资源，判据含题库字段）、没有数学式的页面**零请求**（判服务端请求日志）、资源缺失降级成可读 TeX + 一句人话、坏 LaTeX 给同一句错且不影响别的公式 |
| `browser/lesson_body_test.mjs` | **课件页正文与页头**（#89）：夹具里的每一份内容都是「刚好越界」的那一份——1100 宽的位图、铺满列宽的矢量图、一行比列宽长的代码、无空格的长标识符与长 URL、表头 nowrap 的宽表格、27 字的中文标题、三条题目锚点。宽窄两档各跑一遍：位图不超列宽、矢量图随列宽、暗色下配图被压暗、代码块语言标签与块内横向滚动、页面与正文列都没有横向滚动条、一屏里成句的文字只有一种字号（13px，行高 1.65 跟着走）、顶部只剩一条（课件标题 + 小节跳转 + 进度）、面包屑按全角字省略（宽档 17 字 / 窄档 11 字）、题目标记的组号与右栏那一组对得上。**#97 加的**：内联矢量图（`::: svg`）——夹具内容里写进一块真 SVG，`lesson-body-*-svg` 那两场断言它**真渲染成了一个 `<svg>`**（里面的图形与弧线 `d` 逐字来自内容文件，不是空壳；`alt:` 落成 `role=img` + `aria-label`；与位图共用「图 N」编号序列）、随列宽流动且不超列宽、比例来自 viewBox、暗色下被压暗。为此 `fixtures/mini-react.js` 的整树重建会把**无 React 子节点**元素的 `innerHTML` 按路径带到同位置元素上（等价于真 React「不碰自己没渲染过的子节点」）——这条夹具边界因此收窄，「客户端产出的内联 SVG 零浏览器覆盖」的缺口随之关掉 |
| `browser/ask_quote_test.mjs` | 右栏「问答」= 宿主的一条**真会话**（#105）+ 引用 chip（#106）：夹具把假 ctx 按注册形状给全 `{slots, sessions, inputTriggers, conversation, get, effect}`、喂 `SessionProvider` / `renderFactorySlot` 桩、并给一份**假的宿主输入门面**（`draft` + `occurrences` + `draftRev` 的 CAS，照宿主行为写照），夹具里补上「函数组件的 children 进 props」这一步（与真 React 同语义）。#105 那几场：打开问答 → 请宿主半建一条（`POST /api/studymate/qa/session`，请求体只有 `subject`/`node`）→ `retain` 它（来源标签 `studymateAsk`）→ 嵌的是 `conversation.content`（`embedded`）且被 `SessionProvider` 指着那条；「新对话」建新的并换过去、上一条被 release、「上一段会话」只列答疑会话；真刷新之后认出最近那条（不再建）。#106 那几场：真鼠标划一段 → 面板输入框上方出现 chip（原文 + 来源小节、点得开看全文、有「删掉」），草稿里躺着**恰好一颗** chip，且按 `occurrence.source` 找 owner 的 `codec.serialize(ref)` 送出去的就是那段原文 + 来源锚点；再划一段（另一小节）→ 旧的被换掉、始终只有一颗；删除 → 草稿里那颗同时撤掉、照样能提问；两字的误触不产生 chip；点输入框、切「题目」tab 再切回来都不丢（重挂不许插成两颗）。夹具与 `reading_routes_test.mjs` 同一套（真 `lib/client.js` + `fixtures/mini-react.js` + 宿主 token + 现抠的内联 CSS） |
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

### 横向溢出判据：量的是不是失败形态本身（#98）

「有没有横向滚动条」不是失败形态本身：`.smb-agroup` / `.smb-right__body` / `.smb-palette__box`
这类元素自带 `overflow: hidden`，内容被顶宽时是**被裁掉**、不是顶出滚动条——只量滚动容器的
`scrollWidth − clientWidth`，会把「字被裁」判成「没有溢出」（#93 的假绿）。所以每条判据都要问一句
「它量的那一格，真的会随内容变宽吗」。清单与结论：

| 判据 | 量在哪 | 是不是失败形态本身 |
| --- | --- | --- |
| 搜索·长 URL 折行（`reading_routes_test.mjs`） | **行级** `.smb-hit__text` 自己的 `scrollWidth − clientWidth` | **是**（#98 改的：原量 `.smb-hit` 结果行——溢出还留在行的内边距里时行读数恒为 0，去掉 `overflow-wrap` 后宽窄两档仍是 0；同场配一条反证：把这一格的折行拿掉，行级量法必须看得见溢出） |
| 搜索·列表（同上） | `.smb-palette__list` 的 `scrollWidth − clientWidth` | 量的是**症状**（面板里冒出横向滚动条）；溢出被更上层裁掉时它会假绿，所以与上一条一起断 |
| 右栏题库·滚动容器 / 题干 / 每一行 / 选项（同上） | `.smb-right__body`、`.smb-q__text`、`.smb-q__text p`、`.smb-opt` 各自的 `scrollWidth − clientWidth` | **不是**：这一面上这几个读数恒为 0——题干格是弹性项、默认 `min-width: auto`，自己**长到 min-content 宽**（去掉 `overflow-wrap` 后实测 471px），格子里反而没有溢出；它们只是「滚动条一根没有」的症状 |
| 右栏题库·长 token 的失败形态（同上） | `overhang`：题干/每一行/选项文字的**内容右边缘 vs `.smb-agroup` 裁切线** | **是**（承重的那一条；去掉 `overflow-wrap` 后实测越过 279 / 347 / 278px，上面那四个 `scrollWidth` 读数全绿） |
| 主页 / 科目主页 · 半份数据（同上） | `documentElement` 的 `scrollWidth − window.innerWidth` | **是**（根滚动容器：页面真出横向滚动条才算失败） |
| 课件页正文列（`lesson_body_test.mjs`） | `.smb-center__body` 的 `scrollWidth − clientWidth` | **是**（内容层 `.smb-doc` 不裁切，溢出会传上来；断的是正文列自己要不要横向滚） |
| 正文段落里的长标识符 / 长 URL（同上） | 那个 `<p>` 自己的 `scrollWidth − clientWidth` | **是**（段落不裁切，量的是它自己的内容溢出） |
| 页面级（同上） | `documentElement` | **是**（同主页那一行） |
| 代码块 `pre` / 宽表格 wrap（同上） | 块内 `scrollWidth > clientWidth` | 断的是**有**块内横向滚动（正面形态），不是「没有滚动条」 |
| 面包屑（同上） | `clientWidth / scrollWidth` | **只记不判**：它按设计 `overflow: hidden + ellipsis` 裁字，判的是露出来的字数与计算样式 |
| 右栏 `pageOverflowX`、正文列 `centerOverflowX`（`reading_routes_test.mjs`） | 同上 | **只记不判**（进 metrics 当证据） |
| 「正文列没越过中栏」（`reading-routes-panes`） | `docBox` 与 `centerBox` 的几何包含关系 | **是**（不是 `scrollWidth` 判据） |

一句话的分界：**文字格会不会自己长宽**决定了 `scrollWidth − clientWidth` 管不管用。格子带
`min-width: 0`（`.smb-hit__body`）时它不长，文字在格子里溢出 → 行级读数看得见；格子是弹性/网格项
且没 `min-width: 0`（`.smb-q__text`、`.smb-opt` 的文字 span）时它长到 min-content → 只能靠
「右边缘 vs 裁切线」。

后三项是手动工具，不是断言套件；浏览器工具需要提供页面 URL：

```sh
node scripts/tests/browser/measure.mjs <file-url> [--hover ".sel"]
node scripts/tests/browser/shot.mjs <file-url> <out-prefix> <css-selector>
```

阅读端那条套件用的夹具在 [fixtures/](fixtures/)：`mini-react.js` 是只够跑阅读端的最小渲染器
（宿主那份 React 打包在 bundle 里，拿不到），`host-theme-tokens.json` 是宿主主题 token 的快照，
`client-css.mjs` 负责从 `lib/client.js` 里解析 CSS 与 token 块。夹具页的 CSS 与 JS **都从源码现取**，
不手抄一份标记。**对比度探针只有一份**：`fixtures/contrast-probe.mjs`（`reading_test.mjs` 与
`reading_routes_test.mjs` 都 import 它，取样点各套件自己定）——#98 之前两处各有一份副本，
改一处要想着另一处。

## 写新测试

方向探索的验收场景与待验证项见 [学习方向探索验收](../../docs/设计/learning-discovery-validation.md)。这里的规则断言与人工走读均不能代替实际模型对话验证；尤其八问上限、退出后停问、确认前无写入，需要在学习模式中观察对话与工具调用。技能调用面由 `test_skill_frontmatter.mjs` 校验（12 份技能，角色两个面都关、协议两个面都开）。

[learning_discovery_cases.json](fixtures/learning_discovery_cases.json) 提供 12 个合成多轮场景、按问题披露的用户回答与独立评审判据。它是可重复使用的测试数据，**不是通过记录或自动评分器**。真实模型验证按每场景 3 次执行；使用隔离学习目录，保存对话、工具调用和文件变化。不要把 `checks`／`review_only` 作为用户输入发给被测模型，也不要将这些联网、消耗模型额度的运行加入默认快测或发布检查。目标 DSH 版本不同可用界面逐轮执行，无须依赖其内部 API。

夹具在 [fixtures/](fixtures/) 下，都是 `.mjs`（`fixtures/` 目录被 `checks.mjs` 的遍历显式跳过，不会被当成漏登记的套件）：

| 夹具 | 造什么 |
| --- | --- |
| `fixtures/tools.mjs` | 一份能过门禁的最小科目（大纲、进度、内容文件、题库、图片库）与临时目录工具；`writeSubject` 是各套件共用的入口 |
| `fixtures/export_workspace.mjs` | 导出用的工作区（含第二门科目、假 React 根目录） |
| `fixtures/client_harness.mjs` | 在 Node 里伪造 `window.__ModuleLoader__` + react 桩，跑阅读端头文件并断言工厂闭包里的纯逻辑 |
| `fixtures/tasks_producer.mjs` | 任务域的**跨进程**夹具（进程 A 起 durable 任务并落盘） |
| `fixtures/zip.mjs` | 独立于写入端的 ZIP 读取器（插件测试用它解包） |
| `fixtures/contrast-probe.mjs` | 真浏览器里的对比度探针（前景色 + 沿 DOM 合成背景 → 实测比值）：`reading_test.mjs` 与 `reading_routes_test.mjs` 共用这一份，取样点由各套件自己给（#98 去掉两份副本） |
| `fixtures/learning_discovery_cases.json` | 12 个合成多轮场景（不是自动评分器；真实模型验证按需单独跑） |

**数据现造现弃**（[ADR-0009](../../docs/adr/0009-示例与生成产物不再入库.md)）：仓库里没有示例工作区，
每条套件在自己的临时目录里造需要的那一小份科目，跑完删掉。
