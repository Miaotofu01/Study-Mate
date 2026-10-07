# 更新日志

<!-- studymate-release:v1.2.0 -->
## [1.2.0](https://github.com/Miaotofu01/Study-Mate/releases/tag/v1.2.0) - 2026-10-07

### 已合并的 Pull Request

- fix(发布):避免GitHub Release正文超限 ([#119](https://github.com/Miaotofu01/Study-Mate/pull/119))

### 所有提交

- fix(发布):避免GitHub Release正文超限 ([daf424d](https://github.com/Miaotofu01/Study-Mate/commit/daf424deb7e3409b33efeaf35f7a514d460a0ca8))

  > v1.1.0 已成功发布到 npm，但 GitHub Release 的正文达到 217671 字符，超过 125000 字符上限，导致发布流程在创建 Release 时失败。
  > 
  > 为 POST 和 PATCH 共用最终正文长度处理：普通正文保持原样，超长记录逐级精简，始终保留同版本完整 CHANGELOG 链接与安装说明。补充长度边界、巨量记录和重试幂等回归，并说明旧版本的恢复路径。
  > 
  > 验证：Linux / Node 24 下 npm test 全部通过，零失败。
  > 
  > Fixes \#118

- fix(发布):仅保留发布脚本修复 ([fadf1e1](https://github.com/Miaotofu01/Study-Mate/commit/fadf1e114adfe49feb7b88d027ea215591d52237))

  > 按维护者要求，将发布回归测试文件和发布说明恢复到修复前的原样。分支相对原版本只保留 release.mjs 的 GitHub Release 正文长度处理。
  > 
  > 验证：原发布回归测试 19/19 通过；发布脚本与此前完整门禁通过的版本一致。
  > 
  > Refs \#118

- Merge pull request \#119 from Miaotofu01/fix/release-body-limit ([c7c3929](https://github.com/Miaotofu01/Study-Mate/commit/c7c3929509ad71c47c5e12ee2d8397f426f7b472))

  > fix(发布):避免GitHub Release正文超限


[完整比较](https://github.com/Miaotofu01/Study-Mate/compare/v1.1.0...v1.2.0)
<!-- /studymate-release:v1.2.0 -->

<!-- studymate-release:v1.1.0 -->
## [1.1.0](https://github.com/Miaotofu01/Study-Mate/releases/tag/v1.1.0) - 2026-10-07

### 已合并的 Pull Request

- feat(Web运行时): StudyMate Web 独立运行时（0.7.0-beta · 可评审） ([#43](https://github.com/Miaotofu01/Study-Mate/pull/43))
- fix(阅读端): \#84 收口——导出按需公式资源、内联 SVG 覆盖、测试质量、用词（\#96 \#97 \#98 \#99） ([#112](https://github.com/Miaotofu01/Study-Mate/pull/112))

### 所有提交

- fix(发布):官方dsh插件直接安装的相关问题修复 ([4f0b2bc](https://github.com/Miaotofu01/Study-Mate/commit/4f0b2bc56272bd3a7e5eb911b6220a8eedfb597a))
- docs(设计): 引擎与阅读端重构的评估、目标态规格与实施路线 ([830347e](https://github.com/Miaotofu01/Study-Mate/commit/830347e15f9aa88d580a1a46c559639eda859f64))

  > 新增三份设计文档与 9 条 ADR（0002-0010），词表补 7 词改 3 词；
  > 现行规范加指针指向目标态，VitePress 提案标注已被取代。

- feat(阅读端): DSH 客户端插件页与学习库读写路由 ([52a5e93](https://github.com/Miaotofu01/Study-Mate/commit/52a5e9354a73d08a64dd1f4547dc46e280657b79))

  > Client 半（lib/client.js）注册进宿主 main 槽位与侧边栏入口；
  > Host 半新增学习库只读路由与 reference 读写（ADR-0010）；
  > package.json 加 exports\[./client\]、dsh.client 与 files 白名单。

- chore(原型): 阅读端三个版式变体与截图（一次性） ([5acccaa](https://github.com/Miaotofu01/Study-Mate/commit/5acccaa3e4d206619cf0be1dc5fef814094537a2))

  > 回答「阅读端该长什么样」：三个结构不同的版式（单栏阅读器 / 三栏工作台 /
  > 卡片流专注模式）摆同一份真数据，结论选了变体 B。含 31 张截图作当时比过哪三种的凭据。
  > 本目录冻结，结论已落进 docs/设计/目标态规格.md §4。

- test(数据层): 钉住 Host 半数据层今天的行为——阅读端 payload 与参考资料的写入栅栏 ([977ed2d](https://github.com/Miaotofu01/Study-Mate/commit/977ed2d756a13b9733075c0987f53ab2944ba08b))

  > 把 lib/{workspace,library,assets,yaml,reference}.mjs 今天的行为钉成测试，给后面的
  > 语言迁移留安全网：这五个模块此前没有任何测试进 npm test，回归只能靠肉眼，而
  > lib/library.mjs 的 payload 与 lib/reference.mjs 的写入栅栏正是作答落盘的底座。
  > 
  > 测试对象是行为（输入 → 输出/抛错），不绑文件扩展名、私有函数名或实现结构——
  > 后续把 .mjs 改写成 TypeScript 源时，这个套件应当原样通过。数据在 fs.mkdtemp 现造
  > 现弃，仓库里不存样例数据，不依赖网络、真实学习工作区或宿主。
  > 
  > 覆盖：readLibrary 的顶层与科目/节点形状、旧六档→新三档逐条映射、锚点四态
  > （多匹配不静默取第一个）、operationId 幂等重放（重放先于版本校验）、
  > expectedVersion 冲突拒绝并重读、路径越界（..、绝对路径、同前缀兄弟科目）、
  > YAML 子集解析与工作区配置的两种真实形态。
  > 
  > 符号链接今天只做到「指向目录的链接不进清单」，指向文件的链接仍会被跟随并读出
  > 树外内容；这条口子按现状钉住并写明是未修的问题，不在本次改动里修。

- fix(数据层): 符号链接不能再绕过路径越界——边界按真实路径算 ([420b998](https://github.com/Miaotofu01/Study-Mate/commit/420b998cff06fdbb31fc71058fabe232d374e9b6))

  > 验收标准与目标态规格 §4.3 都写着「路径越界一律拒绝」，但此前只有 \`..\` 与绝对路径
  > 两条文本判据挡着：reference/ 或科目目录里一个指向树外的符号链接会被 statSync 跟随，
  > 读取能读出树外内容、清单会把它列出来，reference/ 自己是指向别处的链接时写入还会
  > 落到科目外面。上一个提交只能把这条口子按现状钉住，这次把它补上。
  > 
  > 改法是解掉符号链接再比边界：目标（或其最近存在的祖先）realpath 之后必须仍在
  > 科目目录 realpath 之内。边界取\*\*科目目录\*\*而不是 reference/——科目目录自己挂成
  > 符号链接是用户自己的布置，真实工作区里合法；越界指的是目标逃出了科目目录。
  > 判据在 lib/reference.mjs 与 lib/assets.mjs 各写一份：两个模块互不依赖，
  > reference.mjs 里的 cmpCodePoints 已经是同样的处理，不从对方 import。
  > 
  > 断链、不存在的目标、成环的链接一律按「读不到」处理（realpath 抛错不上抛），
  > 不把请求打成 500。清单与版本号共用同一次遍历，被拒的链接不会让版本号抖动，
  > 也就不会出现「明明没人动过却报冲突」。
  > 
  > test\_host\_path\_boundary.mjs 里那两条「钉住今天的行为」的断言翻成「拒绝」，
  > 并补上写入被拒、成环与断链不抛错、以及科目目录自己是符号链接不算越界三面。

- merge(数据层): 特征化测试：Host 半数据层（\#64） ([362534c](https://github.com/Miaotofu01/Study-Mate/commit/362534c23b38199f37c822813f9f18659e528e2c))

  > ticket/64-host-data-characterization（977ed2d、420b998）基于集成分支 tip 5acccaa，
  > --no-ff 干净合并，零冲突。
  > 
  > 这张 ticket 做了两件事：
  > 
  > 1. 把 lib/{workspace,library,assets,yaml,reference}.mjs 今天的行为钉成四个特征化套件
  >    （lib 这五个模块此前没有任何测试进 npm test）：阅读端 payload 顶层与科目/节点形状、
  >    锚点四态、operationId 幂等重放、expectedVersion 冲突拒绝、路径越界、旧六档→三档映射、
  >    YAML 子集与工作区配置读取。数据在 mkdtemp 临时目录现造、after() 即弃，不碰真实学习工作区，
  >    不依赖网络与宿主。四个套件已接进 scripts/release/checks.mjs 默认组并登记进
  >    scripts/tests/README.md。
  > 2. 修掉符号链接绕过路径越界判据的口子：边界改按真实路径算（realPathOf/insideReal），
  >    取址、清单遍历与写入三处统一按「目标解掉链接后仍须落在科目目录内」判定，
  >    边界算不出来时一律判越界。科目目录自己挂成符号链接仍是合法布置。
  > 
  > 为什么合：语言迁移之前先把底座行为钉住，否则回归只能靠肉眼。
  > 
  > 验收（全部在主检出跑）：
  > - npm test 全绿，退出码 0。
  > - 门禁输出「套件覆盖：45 个文件全部有归属（当前组 core：18 个 Python + 2 个 Node + 5 个 --test）」；
  >   新增四套 55 条断言（14+15+14+12）+ 基线 release.test.mjs 19 条 = node --test 74/74 pass、0 fail。
  > - 反证覆盖断言没有空转：临时塞一个未登记的 scripts/tests/\*.mjs，
  >   node scripts/release/checks.mjs 退出码 2 并点名该文件（探针已删，未提交）。
  > - STUDYMATE\_DSH\_PACKAGE=…/@deepseek-ai/dsh npm run test:dsh 5/5 通过，未被本次改动带坏。

- refactor(数据层): Host 半五个模块与插件入口就地迁成 TS 源 ([be48f4e](https://github.com/Miaotofu01/Study-Mate/commit/be48f4ea5e326b3e57f26896fafac8bf782f7cec))

  > 把 lib/{workspace,library,assets,yaml,reference}.mjs 与 bin/dsh-plugin.mjs 就地
  > 改名成 .ts（不建 src/、不做打包、不产出 dist），运行方式交给 Node 原生类型擦除。
  > 
  > 改动只有三类，运行期一字未改：
  >   · 类型注解（参数、返回值、局部变量）与 import type；形状说不清的地方留在
  >     「读文件得到的数据」那一层（readYaml/readYamlList 的映射值），因为原实现本来
  >     就是把逐字段校验放在各调用点的运行期检查里，改成 unknown 会连带改掉表达式；
  >   · 少数 \`!\` / \`as\`（codePointAt 的 number|undefined、catch 里的 unknown、
  >     Map.get 与 Array.find 的 undefined），都是擦除式断言；
  >   · 模块内 import 说明符从 './yaml.mjs' 改成 './yaml.ts' —— Node 的 ESM 解析不做
  >     扩展名补全，写真实文件名才解析得到。
  > 
  > 刻意保留、别顺手改回去的三处：
  >   · bin/dsh-plugin.ts 里 lib/ 仍是\*\*处理函数内的动态 import\*\*（test\_bundle 会把入口
  >     单独拷进没有 lib/ 的临时目录跑，顶层静态 import 会在解析期就崩）；
  >   · 路由仍不写顶层 inject: \['connection'\]（headless/tui 组合要能注册预设）；
  >   · lib/yaml.ts 仍是零依赖的最小 YAML 子集，没换成 yaml 库。
  > 
  > lib/client.js（阅读端）一行未动：手写 JS、零构建原样发货。
  > 
  > 随改的路径引用：test\_bundle 的入口 URL 与「单独拷进临时目录」的拷贝路径（stub 的
  > './studymate.mjs' 说明符保持不变），4 个 test\_host\_\* 特征化套件只改 import 说明符、
  > 断言与注释一字未动（assert 条数 69/54/74/36 与迁移前逐个相等）。

- chore(工具链): tsconfig 与 test:types 进 npm test，CI 加 npm ci ([00173d4](https://github.com/Miaotofu01/Study-Mate/commit/00173d431dc0d1ad7c20fa0c14a2a4525588ab2f))

  > 类型检查进默认门禁，并且排在 npm test 链条\*\*最前面\*\*：类型错了就不该再往下跑。
  > 
  >   · tsconfig.json：strict / noEmit / nodenext / allowImportingTsExtensions /
  >     erasableSyntaxOnly / isolatedModules；allowJs + checkJs 让 bin/studymate.mjs
  >     能被解析（本次不迁它，改它要动 6 个测试的命名导出）；exclude 掉 lib/client.js。
  >   · scripts/release/typecheck.mjs：缺 typescript 时给一句能照做的报错（先跑 npm
  >     install）并以 1 退出——门禁不许因为「依赖没装上」而静默少跑一环。
  >   · typescript 与 @types/node 进 devDependencies，提交 package-lock.json；
  >     @types/node 钉在 24.x，与 engines 里 CI 实际跑的 Node 对齐，免得用上运行时没有的 API。
  >   · ci.yml 加一步 npm ci（Release 的 checks job 复用这个文件，两处一起覆盖）。
  > 
  > verbatimModuleSyntax 在这里\*\*必须是 false\*\*：本包没有 "type": "module"，而
  > scripts/tests/{quiz\_dom\_test,toc\_dom\_test}.js 是 CommonJS（require/\_\_dirname），
  > 加上 type: module 会把那两个套件打掉；于是 tsc 按 nodenext 把 .ts 当 CJS 看，开着
  > verbatimModuleSyntax 就会以 TS1287/TS1295 拒绝文件里的 ESM 语法。代价是「类型专用
  > import 必须手写 import type」不再由编译器强制——但 Node 擦除后会原样保留写漏的那条
  > import，运行期立刻炸，而 npm test 会加载全部这些模块。

- chore(打包): exports 与 files 白名单跟着 .ts 入口改 ([5161f3c](https://github.com/Miaotofu01/Study-Mate/commit/5161f3c705307142000f625f9613f2606121b449))

  > 宿主按 exports\["."\] 加载 Host 半，所以入口换扩展名必须同步：
  > 
  >   · package.json exports\["."\] → ./bin/dsh-plugin.ts；files 加 "bin/\*.ts"
  >     （"lib/\*\*" 本来就覆盖 .ts，"bin/\*.mjs" 留给其余 8 个安装/构建脚本）。
  >     exports\["./client"\] 不动。
  >   · release.mjs 的白名单正则 bin\\/\[^/\]+\\.mjs → bin\\/\[^/\]+\\.(?:mjs|ts)；
  >     必查清单里的 bin/dsh-plugin.mjs → bin/dsh-plugin.ts。
  >   · release.test.mjs 里钉这两张表的用例同步（tarballFiles 样本与必查项循环）。
  > 
  > npx 安装路径不受影响：bin/studymate.mjs、cordis.patch.yml、预设与 skills 的
  > 拷贝清单都没动，copyPayload 依旧不拷 bin/ 与 lib/。

- merge(工具链): TS 工具链与 Host 半迁移（\#65） ([5eae8a8](https://github.com/Miaotofu01/Study-Mate/commit/5eae8a8d2dcf868ad154820f88f53f97a0dd7a39))

  > 把 Host 半的五个模块（assets/library/reference/workspace/yaml）与插件入口
  > bin/dsh-plugin.mjs 就地改成 TS 源（.ts），并补上承载它们的工具链：
  > 
  > - be48f4e refactor(数据层): Host 半五个模块与插件入口就地迁成 TS 源
  > - 00173d4 chore(工具链): tsconfig 与 test:types 进 npm test，CI 加 npm ci
  > - 5161f3c chore(打包): exports 与 files 白名单跟着 .ts 入口改
  > 
  > 集成分支 tip 362534c 是 ticket 分支的祖先，试合零冲突、无文件被改写
  > （合并结果与 ticket tip 逐字节一致）。合并后本地实测四条验收：
  > 
  > 1. npm ci 通过：lockfile 与 package.json 一致，干净装出 4 个包
  >    （@types/node、typescript 7.0.2、其平台包 @typescript/typescript-linux-x64、
  >    undici-types），0 vulnerabilities；带 node\_modules 再跑一次同样通过，
  >    确认「删掉并重装」这条路径真的能走。
  > 2. npm ci 之后 npm test 全绿，退出码 0，全部套件 fail 0。
  > 3. STUDYMATE\_DSH\_PACKAGE=…dsh npm run test:dsh 5/5 通过（.ts 入口在真 DSH
  >    0.2.0-rc.2 里能加载）。
  > 4. npm pack --dry-run 里 bin/dsh-plugin.ts 与 lib/{assets,library,reference,
  >    workspace,yaml}.ts + lib/client.js 都在包内。
  > 
  > 类型门禁真跑 tsc 7.0.2（scripts/release/typecheck.mjs），且缺 typescript 时
  > 以退出码 1 报错而不是静默跳过——这正是 CI 里必须先 npm ci 的原因。

- feat(解析层): 内容格式解析器与锚点题库对账落进 lib/core ([3d0543d](https://github.com/Miaotofu01/Study-Mate/commit/3d0543d7674c9d760a4f90ea4b0ff13d2b8e8c87))

  > 新增纯函数域 \`lib/core/\*\*\`（decisions.md §2：不 import 任何 \`node:\*\`，不 import
  > core 域之外的东西），把课件内容格式的\*\*判定\*\*从 Python 侧搬一份到 JS 侧，
  > 并替掉 \`lib/library.mjs\` 那份手写的锚点解析与对账：
  > 
  > - \`lib/core/format.ts\`：front matter 两个字段、\`\#\#\`/\`\#\#\#\`、列表、管道表、围栏、
  >   行内语法（含 \`$…$\`/\`$$…$$\`/\`\\$\`）、\*\*9 个\*\* \`:::\` 指令、HTML 真标签两条判据、
  >   Python 字符串语义（\`strip\`/空白集/码位排序）。顺带产出 HTML 片段——Python 侧
  >   没有中间表示，判定就发生在 \`Renderer.inline\` 里，要比对就只能比产物。
  > - \`lib/core/anchors.ts\`：四态对账（resolved/stale/ambiguous/missing）+ orphans。
  >   \*\*exact 撞键判 ambiguous\*\*（旧实现是 Map 后写覆盖先写，结论看 JSON 键序）；
  >   orphans 作为一等结论返回（旧实现塞进 payload 没人用）；键的行号按 JSON 的真实
  >   位置算（旧实现用文本搜索，会把题面文字当成键的位置）。
  > - \`lib/core/lesson.ts\`：顶层编排（重复锚点、题库两个方向、title 与大纲逐字一致、
  >   \`::: figure\` 的存在性走调用方钩子）；错误\*\*收集\*\*不抛异常。
  > 
  > 指令数是 \*\*9 个不是 8 个\*\*（ticket 与实施路线写的「8 个」是计数错，按
  > \`render\_lesson.py:74\` 的实现）。\`花了 $5 和 $10\` 按实现报错，文档同批改掉。
  > 
  > 测试：\`scripts/tests/test\_core\_{format,anchors,lesson}.mjs\`（80 个用例，登记进
  > \`checks.mjs\` 的 core 组），数据全部现造，不读仓库里任何文件。

- docs(课件内容格式): 数学式判据按实现改掉与 \`$5\` 冲突的那一处 ([0efc4c6](https://github.com/Miaotofu01/Study-Mate/commit/0efc4c6c39a040c1d469b9f36611a7ca5f59c37d))

  > 文档原写「\`花了 $5 和 $10\` 里两个 \`$\` 的收尾判据不成立，按字面量处理」，
  > 而实现（\`render\_lesson.py:917-920\`）在开 \`$\` 后面紧跟非空白字符时就按公式处理、
  > 找不到收尾就报错——实测 exit=1。文档与实现必须只有一个真相：按实现，
  > 并把「开 \`$\` 后面紧跟非空白就已成立」这条判据写清楚（\`$ 5\` 带空格才不报）。
  > 
  > 本条由 \#66 的逐字复核实测确认；TS 侧实现（\`lib/core/format.ts\`）与这里的
  > 措辞、行号逐字一致。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/66-content-format-parser ([a8dfe49](https://github.com/Miaotofu01/Study-Mate/commit/a8dfe494239e783085218a0fd3d440c21cfef7d9))
- feat(纯函数域): JSON Schema 子集校验器与带位置的读取层 ([3777f5c](https://github.com/Miaotofu01/Study-Mate/commit/3777f5c34ec9123be1a05ce635214913261678da))

  > 目标态要求「逐条问题（文件 + 行号 + 是否阻断）」替掉读 exit code，而今天三样东西都缺：
  > Python 侧的 jsonschema 要随 Python 退场、\`lib/yaml.mjs\` 的 parseYaml 不给位置、
  > \`JSON.parse\` 也不给。所以先在 \`lib/core/\` 立三层地基：
  > 
  > - \`schema.ts\`：Draft-07 的最小子集。关键字是\*\*枚举\*\*出来的，六份 schema 实际只用到 17 个；
  >   枚举表之外的关键字不是静默放行，而是报一条问题（调用方按阻断处理）——\`oneOf\` 被无视的
  >   后果是「校验通过」而数据其实是错的。\`format\` 按断言处理（draft-07 只当注解，今天从未拦下
  >   过任何东西），比正则严一层：\`2026-02-30\` 形状合法但不是真实日期。
  > - \`yamlpos.ts\`：只扫结构、不构造值，按与 \`lib/yaml.mjs\` 同一套块结构规则记「路径 → 行:列」。
  >   不改 \`lib/yaml.mjs\`（\#65 在改名），也不 import 它（\`decisions.md\` §2 禁跨出 lib/core）。
  >   把握不了的结构（跨行流式集合等）\*\*降级\*\*到最近的祖先，不猜。
  > - \`jsonpos.ts\`：交接 manifest 的位置层，顺带补回 Python 有、\`JSON.parse\` 会丢的重复键检查。
  > 
  > 三层都是纯函数：只用 JS 内建，不 import 任何 \`node:\*\`。

- feat(纯函数域): 四类校验统一回报逐条问题，交接门禁给出明确阻断结论 ([0606c84](https://github.com/Miaotofu01/Study-Mate/commit/0606c84abadc277b4f46aeb29794a1baa3d216bc))

  > 替掉「读 exit code」：每类校验返回 \`{file, line, column?, message, blocking}\` 的逐条问题，
  > \`file\` 由调用方注入（这一层不碰文件系统），行号来自真实解析位置。
  > 
  > - 大纲：DAG 无环（Kahn）、位次不倒挂、实验课前置非空、字段齐全、重复 id、悬空引用；
  >   孤儿只是提示。行号指到出问题的那一行——夹具里放了逐字相同的诱饵注释，文本搜索会指错。
  > - 进度：schema + 旧六档词表读到就报映射（写回时会变，得让人知道为什么）、
  >   与大纲的引用完整性（多余的节点 id 阻断，缺席的只提示）。
  > - 科目：schema + schema 表达不了的取值（空串 name/goal、created\_at 是否真实存在、
  >   slug 与目录名不一致）。
  > - 交接门禁：manifest ↔ \`deliver/\` 覆盖、角色/节点绑定、路径边界、symlink、可选 SHA-256、
  >   重复 JSON key，逐条对齐 \`check\_handoff.py\` 与 Agent 交接协议；结论是 \`pass\`/\`block\`
  >   两种明确取值，不是「看起来没问题」。
  > 
  > 盘上快照（\`StageEntry\[\]\`）由调用方走盘得到——\`decisions.md\` §2 规定 lib/core 是纯函数域。

- feat(规则层): 四层判定、题型匹配与进度三档推进搬成纯函数 ([cfe37e3](https://github.com/Miaotofu01/Study-Mate/commit/cfe37e394825b06489fedb89401ebf605199ce98))

  > 这些规则今天散在技能提示词的自然语言里（\`layered-practice\` 的「四层」「四种题型」、
  > \`record-keeping\` 的置位规则），模型每次重读一遍、还可能读漏一条。搬成纯函数之后同一条规则
  > 只有一份，而且能逐条断言。
  > 
  > - 四层（读懂／改对／查错／造出）按规格 §7.1 的通过标准判定，取\*\*满足了的最高一层\*\*，
  >   并给出再上一层缺哪几条。\*\*没有课型上限参数\*\*：§7.1 明确取消了「课型限层级」，
  >   谁把 kind 加回来，测试会红。
  > - 题型（客观题／预测验证／开放题／交付物）与深度的匹配、判分三轨、逐题检查。
  > - 进度三档 + 旧六档映射（§5.2 的映射表明文），读到不认识的词一律退回「未开始」。
  > - 推进只认证据：事件里没有「谁说的」这个位置，所以「模型输出不能直接改进度状态」
  >   （§7.5）不是靠自觉，而是签名里表达不出来；自评／同日重试／关键词标签／仅浏览过一律不动。
  > - 验收分母口径：范围为空时绝不显示「通过」。
  > 
  > 不读钟、不读随机数、不 import 任何 \`node:\*\`——同样输入永远同样输出。

- test(纯函数域): 逐条断言四类校验与规则层，并给纯函数层定下覆盖率下限 ([5b93c73](https://github.com/Miaotofu01/Study-Mate/commit/5b93c73e6424fd6e85b02a530344a0671cc3c7a8))

  > 验收标准要的是「对构造坏的输入报出逐条问题，含文件与行号」「旧词表映射逐条有断言」
  > 「纯函数层有明确覆盖率下限」，所以测试不写「跑通就行」的用例：
  > 
  > - 行号用\*\*写死\*\*的期望值断言，夹具里还放了一行逐字相同的诱饵注释——文本搜索会指向第 1 行，
  >   解析位置指向第 13 行。另有一条拿 \`lib/yaml.{ts,mjs}\` 真解析、把值树里\*\*每一条路径\*\*都
  >   问一遍位置索引，对不上就红（这条保证这一层与解析器不失配，\#65 改名后也照跑）。
  > - 六个数据用例覆盖 DAG 环、位次倒挂、实验课前置空、重复 id、悬空引用、缺字段；
  >   交接门禁每个非法夹具都断言 verdict=block 与那\*\*一条\*\*具体问题。
  > - 旧六档 → 三档是六个子测试，逐条断言。
  > - \`test\_core\_coverage\_floor.mjs\` 自己 spawn 一轮带 \`--test-coverage-\*\` 阈值的 \`node --test\`：
  >   规则层 行 ≥98%/分支 ≥90%/函数 ≥95%，整个 lib/core 行 ≥92%/分支 ≥82%/函数 ≥92%。
  >   子进程要摘掉 \`NODE\_TEST\_CONTEXT\`，否则 Node 会认为「测试里再跑测试」而跳过全部文件——
  >   那样覆盖率报告根本不产出，阈值就永远「达标」。
  > 
  > 新增套件按规矩登记进 \`scripts/release/checks.mjs\` 的 core 组，并补进 \`scripts/tests/README.md\`。

- merge(纯函数域): 合入 TS 工具链与 Host 半迁移（\#65） ([deb9d4a](https://github.com/Miaotofu01/Study-Mate/commit/deb9d4a97449c7d5223bcc54c5bbfd8bc2422a82))

  > 冲突只有一处：\`scripts/tests/README.md\` 的「默认功能套件」表——\#65 改的是数据层那一行的
  > 扩展名（\`.mjs\` → \`.ts\`），本分支加的是六行新套件。两边都留。
  > 
  > 合入后 \`tsconfig.json\` 开始检查 \`lib/\*\*/\*.ts\`，本分支的 \`lib/core/\*\*\` 一并进严格模式；
  > \`npm test\` 也多了一环 \`test:types\`。

- refactor(数据层): 收编 lib/library.ts 的锚点解析与对账——格式只剩一个真相 ([37e57d6](https://github.com/Miaotofu01/Study-Mate/commit/37e57d6aea90a640db98c13394ed363da39cf483))

  > \`lib/library.ts\` 原来自带一份手写的锚点实现（行锚定正则 + 四态对账），与
  > \`scripts/render\_lesson.py\` 并存、没有测试，还带着三个洞。现在整段删掉，改调
  > \`lib/core/anchors.ts\`：
  > 
  > - 删 \`ANCHOR\_RE\` + \`lessonAnchors()\`（旧 308-317 行）：行锚定正则\*\*不认围栏\*\*，
  >   围栏里写一句 \`::: quiz 理解 锚点：x\` 会凭空多出一个锚点。改走
  >   \`parseAnchors()\`（内部是 \`parseBlocks\`，会翻转围栏态）。
  > - 删 \`normalizeAnchor()\` + \`resolveAnchors()\`（旧 319-365 行）：那里的 exact 是
  >   \`Map\`，\`exact.set(pyStrip(key), key)\` \*\*后写覆盖先写\*\*——题库同时有 \`" x"\` 与
  >   \`"x"\` 时，\`锚点：x\` 指向哪个取决于 JSON 的键序。新版把精确候选当\*\*列表\*\*，
  >   撞键一律判 \`ambiguous\`，绝不静默取一个。
  > - 删本地的 \`cmpCodePoints()\`（与 \`lib/core/format.ts\` 重复）。
  > - payload 多一个 \`orphans\`（键 + 题库里的真实行号 + 题数），\`orphan\_keys\` 保持
  >   不变（旧字段是码位序键名数组）。收编前那份结论\*\*没有任何消费方\*\*，现在有形状
  >   也有行号；阅读端要不要显示是别人的事。
  > 
  > \`parseAnchors\` 走的是 \`bodyStartOf\`（不报错的 front matter 切分）：阅读端要读
  > 工作区里的\*\*任意\*\* \`.md\`，缺 front matter 时不该把整篇锚点一起丢掉——同一个输入上
  > Python 的 \`parse\_blocks(path, lines, body\_start, len(lines), …)\` 照样能扫出锚点。
  > 
  > \`test\_host\_library\_payload.mjs\` 的断言跟着改：锚点多 \`line\` 与 \`candidates\`
  > （读端原有的 \`keys\`/\`resolution\`/\`text\` 一个没动，\`lib/client.js\` 不用改）。
  > 
  > 真数据交叉检查：拿 examples/ 的六课跑收编后的 \`lib/library.ts\`，18 个锚点的
  > 文本/层级/行号与 Python 侧\*\*逐条一致\*\*，全部 resolved、零 orphans。

- refactor(解析层): 行内链接复用 LINK\_RE，并记下正文分隔线的语义边界 ([a205a54](https://github.com/Miaotofu01/Study-Mate/commit/a205a5462b64ab6971af68588c2c84058e6f5101))

  > \`LINK\_RE\` 之前在 \`renderInline\` 里被抄成了同形状的匿名正则，两处漂移过一次就没人
  > 发现得了；现在只用那一份常量。
  > 
  > 另外给 \`parseBlocks\` 的 \`---\`/\`\*\*\*\`/\`\_\_\_\` 分支补一条注释：它判的是\*\*正文里\*\*的分隔线，
  > front matter 的首尾 \`---\` 由 \`parseFrontMatter\` 消费，走不到这里（Python 的
  > \`stripped in ('---','\*\*\*','\_\_\_')\` 也是这个语义）。

- merge(解析层): 内容格式解析器与锚点题库对账（\#66） ([fd1929f](https://github.com/Miaotofu01/Study-Mate/commit/fd1929f01ca8bd3e6b4682f529c2b776fcd8d887))

  > 新增 lib/core/{format,anchors,lesson}.ts，把课件内容格式的解析与锚点题库对账
  > 落成纯函数，格式只剩一个真相；lib/library.ts 收编原锚点实现（−87/+18）；
  > docs/规范/课件内容格式.md 按实现改掉与 \`$5\` 冲突的数学式判据；
  > test\_host\_library\_payload.mjs 的 payload 新增 \`orphans\` 字段，断言跟形状走。
  > 
  > 验收：主检出 \`npm test\` 全绿（exit 0）。门禁自报「套件覆盖：48 个文件全部有归属
  > （当前组 core：18 个 Python + 2 个 Node + 8 个 --test）」，core 组 --test 由 5 增至 8
  > （+test\_core\_format / test\_core\_anchors / test\_core\_lesson），与实际数组逐条一致。

- merge(纯函数域): 校验器与纯函数规则层（\#67） ([910d30b](https://github.com/Miaotofu01/Study-Mate/commit/910d30bdf884aecce805109a8910ea837555c620))

  > 新增 lib/core/{schema,yamlpos,jsonpos,validate,rules}.ts：JSON Schema 子集校验器与带位置的
  > 读取层、四类校验（大纲/进度与科目/交接门禁）逐条回报问题、以及四层判定与题型匹配的纯函数
  > 规则层；配 6 条套件（含一条自跑 \`node --test --test-coverage-\*\` 的覆盖率下限门禁）。
  > 
  > 冲突：scripts/release/checks.mjs 的 core 组 \`tests\` 数组——两张 ticket 都在同一处追加自己的
  > 套件，属「两边都加一行」，两边都留（\#66 的 3 条 + \#67 的 6 条，两组注释一并保留）。
  > scripts/tests/README.md 为单侧改动，自动合并无冲突。
  > 
  > 验收：主检出 \`npm test\` 全绿（exit 0）。门禁自报「套件覆盖：54 个文件全部有归属
  > （当前组 core：18 个 Python + 2 个 Node + 14 个 --test）」，实测该 \`node --test\` 命令行恰好
  > 14 个文件参数，与门禁数字一致；覆盖率下限两条子断言（lib/core/rules.ts、lib/core/\*\*）均通过。

- refactor(数据层): 抽出写入栅栏的判据，reference 行为一字未变 ([93108b2](https://github.com/Miaotofu01/Study-Mate/commit/93108b235d004ebfda9c6ac04131d994c9b109f4))

  > 幂等与版本号这两件武器原先只有 reference/ 一份实现。作答数据（ADR-0007）要用同一套，
  > 所以把\*\*判据\*\*搬进纯函数域 lib/core/fence.ts：operationId 的归一与上限、内容指纹、
  > 版本比较，以及一个带上限的幂等台账类（三态：fresh / replay / conflict）。
  > 
  > 为什么台账做成类而不是模块级 Map：reference/ 的指纹是「科目+标题+正文」，attempts/ 的
  > 是「节点+一次作答」，两者共用一张 Map 会让上限互相挤掉——幂等反而在最需要它的时候失效。
  > 每个域各持一份实例，判定逻辑仍只有一份。
  > 
  > 为什么 reference.ts 只动了这几处：它的 15 条特征化断言（\#64）是安全网，行为必须逐字不变。
  > 抽的时候刻意保留了：先 trim 再判长度、回放先于版本校验、冲突时带回当前清单、失败回执
  > 不带 reference/version。指纹里的 \`${subject}\` 也照抄模板字面量的写法，不改成 String()。

- feat(数据模型): 进度收成三档、误解单一落点、题库扩到四种题型 ([b429f3d](https://github.com/Miaotofu01/Study-Mate/commit/b429f3d60e63607ee3b99ab6d04c343c547df7c7))

  > 三件事一起落，因为它们共用同一份词表：
  > 
  > 1. \*\*进度三档\*\*（规格 §5.2）：\`progress.schema.json\` 与 \`curriculum.schema.json\` 的
  >    status 收敛为未开始/学习中/已学完，\`mastery\` 移除；\`lib/library.ts\` 顶部那份硬编码
  >    映射改成调 \#67 的 \`lib/core/rules.ts\`——映射从此只有一份实现（\`validate.ts\` 也用它，
  >    原先两份并存，改一次词表要动两处）。旧文件仍读得进：\`validateProgress\` 把 schema 的
  >    status enum \*\*就地展开\*\*成「三档 + 旧六档」再校验，所以旧值不报「不在允许值」，
  >    而真正的野词照样被拦下；旧值另给一条不阻断的「写回时映射为」提示。
  > 
  > 2. \*\*误解记录单一落点\*\*（规格 §5.4）：只保留 \`misconceptions.yaml\`，字段定型为
  >    topic/source/evidence/status/at（新增 \`schemas/misconceptions.schema.json\`）。
  >    progress.yaml 里那份旧副本不再读——旧文件仍在盘上、仍读得进，只是不进 payload，
  >    校验器给一条不阻断的迁移提示。旧字段的搬运（date→at、question→evidence……）在
  >    \`lib/core/misconceptions.ts\`：学习档案是学生的积累，换字段名不该让任何一条读不出来。
  > 
  > 3. \*\*题库四种题型\*\*（规格 §7.2）：客观题/预测验证/开放题/交付物，词表与必备字段在
  >    \`lib/core/rules.ts\`（\`QUESTION\_KINDS\`/\`QUESTION\_KIND\_SHAPES\`），同步落进
  >    \`schemas/question.schema.json\`（Python 侧 statuses.py 读它，词表只有一处）。
  >    未知题型\*\*带题库文件与行号\*\*报错（\`lib/core/questions.ts\` 扫 JSON 原文取真实位置）。
  >    旧题库不写 \`kind\`：按字段推断，只查「两组旧字段同时出现」——照旧读得进。
  > 
  > 另外：\`scripts/check\_lesson.py\` 的题目结构检查跟着认这四种题型（原先只认两种，
  > 新题型会被它误判成「题型不明」）；Antigravity 宿主约定里的状态清单由 schema 生成，
  > 去掉了已取消的掌握度那句。

- feat(数据层): 作答数据独立存放 attempts/&lt;NNNN&gt;-&lt;节点id&gt;.json ([4043ba2](https://github.com/Miaotofu01/Study-Mate/commit/4043ba2c5c8aa3dee157945e309f46894d4f1f48))

  > ADR-0007 要求作答历史、错因与上次结果写进独立文件，\*\*绝不写回题库\*\*——题库是模型写的
  > 课件内容文件，锚点与正文逐字对应，两边共写同一个文件随时会撞车。
  > 
  > - 路径与课件一一对应：编号从课件文件名上取（节点 id 里没有编号，凭空造一个就会错位）。
  > - 写入沿用 reference/ 那两件武器（判据在 lib/core/fence.ts）：operationId 幂等重放 +
  >   expectedVersion 版本栅栏；冲突时\*\*拒绝并重读\*\*，把当前那份一起带回去，不引入文件锁。
  > - 版本号\*\*不写进文件\*\*：写进去就成了「文件里那份」与「读它算出来的那份」两个值，而它们
  >   永远不可能相等（哈希自己包含自己）。它只哈希内容、不掺 mtime——mtime 会因备份、
  >   同步、touch 而抖，抖一次就是一次假冲突。
  > - 状态只服务当场回顾（规格 §5.3）：payload 里带 \`node.attempts\`（present/version/questions），
  >   阅读端据此就地显示「上次你选了 B」；不做汇总视图、不排期、不算复习队列。
  > - 作答数据是派生记录：文件写坏、JSON 坏了都当「没作答过」，不让整份 payload 崩掉。
  > 
  > payload 的节点形状因此多出 \`attempts\` 与 \`question\_kinds\` 两个键（页面契约同步更新）。

- test(数据层): 接上作答栅栏与 v0.2 工作区的验收套件 ([0a5aba0](https://github.com/Miaotofu01/Study-Mate/commit/0a5aba0042dd2dcabcd3818395265fa839123e28))

  > 新增四条套件，全部接进 scripts/release/checks.mjs 的 core 组：
  > 
  > - test\_core\_fence\_questions.mjs：写入栅栏的判据（台账三态、operationId 归一、版本比较）、
  >   题库题型与字段、误解字段定型。判据在纯函数域，落盘那侧另有特征化套件。
  > - test\_host\_attempts\_fence.mjs：作答数据的幂等重放（两次写入后\*\*文件字节不变\*\*、回执相等）、
  >   版本冲突拒绝并重读、题库逐字纯净、退役目录不多文件。
  > - test\_host\_v02\_workspace.mjs：\*\*拿一份 v0.2 真实工作区跑一遍\*\*——旧六档 + mastery +
  >   assessments/ + sessions/ + 误解双落点，验「读得进 → 映射正确 → 写回 → 旧文件一个字节
  >   都没动 → 退役目录仍可读」。夹具内联现造，不依赖 examples/（\#83 会删它）。
  > - test\_core\_lesson.mjs / test\_host\_library\_payload.mjs 补上四种题型与未知题型的行号断言。
  > 
  > 改动的既有断言（预期会红那批，做的是最小调整）：
  > - test\_statuses.py：六档切分点改成三档，并加一条「旧六档不在词表里」的反向断言。
  > - test\_core\_schema\_subset.mjs：schema 从六份变九份；progress 的样例去掉 mastery。
  > - test\_validators\_progress\_subject.mjs：mastery 的 maximum 用例改成「旧字段迁移提示」，
  >   另加「旧六档读得进、野词照样被拦」与「mastery/misconceptions 各给一条提示」。
  > - test\_openai\_skills.mjs：硬编码术语白名单里的「已通过项目验证」是旧六档的词，改钉同一节
  >   的稳定标记，并加一条「进度词表就是三档、mastery 不在 schema 里」的守卫。
  > - test\_rules\_pure.mjs：题型字段表的逐条断言（覆盖率下限要求规则层的新代码有覆盖）。

- feat(阅读端): 读题型词表、就地回顾作答、误解按新字段显示 ([a0c5d18](https://github.com/Miaotofu01/Study-Mate/commit/a0c5d18208f08b92c3d64e609575679cc8ef2904))

  > 三处改动都只碰「读」：
  > 
  > - \*\*题型\*\*：词表与 schemas/question.schema.json 的 kind.enum 逐字一致（权威副本在
  >   lib/core/rules.ts）；旧题库不写 kind 时按字段推断，与 inferQuestionKind 同一口径。
  >   主观题分成三个分支：开放题（参考答案+判分要点）、预测验证（预测+比对）、
  >   交付物（交付物+证据）。
  > - \*\*作答数据\*\*：进课件页时把 payload 的 node.attempts.questions 读进内存，键就是本来的
  >   stateKey（&lt;节点id&gt;|&lt;锚点&gt;|&lt;题号&gt;），于是「上次你选了 B」从盘上读得到。\*\*只读\*\*——
  >   状态只服务当场回顾，不做汇总视图、不排期（规格 §5.3）。落盘那句文案也跟着改：
  >   不再说「刷新即丢」，因为现在读得回来。
  > - \*\*误解记录\*\*：按 topic/source/evidence/status/at 显示，旧字段（question/answer\_summary/
  >   importance）作兜底——归一在 lib/core/misconceptions.ts 做，界面这层只保证老档案不空着。
  > 
  > 不引入打包（client.js 仍是零构建手写 JS，release.mjs 明说不许打包变换）。

- docs(数据模型): 同步三档进度、作答数据与退役目录的规范与词表 ([4aa56aa](https://github.com/Miaotofu01/Study-Mate/commit/4aa56aae6f4db05d9b2c38aff193dcd6ae9c3b22))

  > - 课件内容格式 §4：题库一节的「四种题型」表（词表、服务哪一层、判分轨、必备字段）、
  >   kind 可省时的推断口径、未知题型带行号报错、作答数据不写回题库。
  > - 文件归属：progress.yaml 的功能改成三档；误解库标成唯一落点；新增 attempts/ 一行；
  >   assessments/ 与 sessions/ 标成已退役（旧产物只读）。
  > - 使用说明：工作区树加 attempts/、退役目录说明、结束步骤改成写学习记录（不再写会话摘要）。
  > - GLOSSARY：新增「题型」「误解记录」两条领域词（进度与作答数据本来就有）。
  > - assessment / session-summary 两份 schema \*\*保留可读\*\*：旧技能正文还引它们（技能清洗归
  >   \#80/\#81），盘上旧文件也要仍能被解释器读懂。description 里写明「不要照它写新文件」——
  >   退役的是目录与流程，不是读旧文件的能力。

- feat(解析层): 题库逐题查题型与字段，未知题型带题库文件与行号 ([d041475](https://github.com/Miaotofu01/Study-Mate/commit/d0414754ed6fd6e2aa71880a1bed081280f40ec5))

  > \`lib/core/questions.ts\` 是这一层的落点：题型词表与字段要求在纯函数域 rules.ts，
  > 这里只回答「在哪一题、哪一行、出了什么事」。行号来自 jsonpos.ts 扫 JSON 原文——
  > 不是文本搜索（题面里恰好等于字段名的文字会把搜索带偏，那是 Python 侧踩过的坑）。
  > 
  > \`parseLesson\` 在形状检查之前先跑一遍：形状坏（值不是数组）的键不在这里报，
  > 由 pool-shape 说，免得同一件事被报两遍。三种结论各一条错误码：pool-unknown-kind /
  > pool-ambiguous / pool-missing-field，都带 file 与 line。
  > 
  > 旧题库照旧读得进：没写 kind 的题只查「两组旧字段同时出现」这一条。

- fix(检查器): 四种题型的纯文本字段都进围栏与标记检查 ([c0a7354](https://github.com/Miaotofu01/Study-Mate/commit/c0a7354e56278788ac82ae5ab5f7cfaf7a8151aa))

  > check\_lesson.py 的围栏成对与 Markdown 标记两条检查原先逐字段写死 ('q','answer','criteria','why')。
  > 题库扩到四种题型之后，预测/比对/交付物/证据 四个字段同样是纯文本（多行代码要写 \`\`\` 围栏），
  > 漏掉它们会让新题型的题面里写了不成对的围栏也放行——页面把后半段整段渲染成代码块。
  > 
  > 抽成 QUIZ\_TEXT\_FIELDS 一份清单，加字段时只有一处要改。

- merge(数据模型): 三档进度、作答数据、误解单落点、题型扩展（\#71） ([186a098](https://github.com/Miaotofu01/Study-Mate/commit/186a098a6ad85a46f10b1a817bb385da532d28ea))

  > 进度收成三档、误解收敛到单一落点，作答数据独立存放（lib/attempts.ts +
  > attempts/&lt;NNNN&gt;-&lt;节点id&gt;.json），题库扩到四种题型并逐题查题型与字段；配套
  > schemas/ 五份改动（新增 attempts/question/misconceptions）与 docs/规范、GLOSSARY 同步。
  > lib/core 新增 fence.ts 与 misconceptions.ts、questions.ts，validate/rules 跟进；
  > lib/reference.ts 抽出写入栅栏判据（reference 行为一字未变）。
  > 读端 lib/client.js 跟新词表走：题型分支、attempts hydration、误解新字段（只改读）。
  > 
  > 冲突：无。集成分支 tip 910d30b 已是本分支的祖先（分支已 merge 过它），
  > 零冲突自动合并；\`checks.mjs\` 的 core 组 tests 数组为纯追加（+3 条，无删除他行），
  > 不与并行中的 \#68 争用。
  > 
  > 验收：主检出 \`npm test\` 全绿（exit 0）。门禁自报「套件覆盖：57 个文件全部有归属
  > （当前组 core：18 个 Python + 2 个 Node + 17 个 --test）」，与 \#71 的预期逐字一致；
  > 本张新增的 3 条套件（test\_host\_attempts\_fence / test\_host\_v02\_workspace /
  > test\_core\_fence\_questions）均在 checks.mjs 登记，非只提交不跑。
  > \`node --check lib/client.js\` 通过（该文件后续 \#75/\#76/\#78/\#79 会大改，故在 tip 上确认可解析）。
  > \`STUDYMATE\_DSH\_PACKAGE=&lt;dsh&gt; npm run test:dsh\` 5/5 通过。
  > \`git status examples/\` 为空——复核对 examples/.learning/ 的一次性手工验收已清理干净，无产物残留。

- feat(工具域): 八个原生工具与「越权即抛」的域 guard（\#68） ([48fed99](https://github.com/Miaotofu01/Study-Mate/commit/48fed999c61c7b3860eef511eb87a155d1905670))

  > Host 半从此有原生工具：总控拿到的是结构化返回，不是 exit code。八个名字用下划线形态
  > （\`decisions.md\` §3）——工具名会原样进模型 API 的 \`tools\[\].name\`，点号会在真实会话里炸、
  > 不在门禁里炸；规格 §3.1 的 \`studymate.workspace.context\` 是待落地提案名，按 §3 改名。
  > 
  > 三条约束一起落，各自的执行点都在代码里而不是文档里：
  > 
  > - \*\*越权即抛\*\*：工具定义带 \`reads\` / \`writes\`（域 → 字段路径模式），数据访问只有
  >   \`access.read(domain, target?)\` / \`access.write(domain, path, fn)\` 一个入口，未声明的读写
  >   当场抛 \`DomainViolationError\`。\`write\` 收的是回调——真正的落盘动作只能在 guard 之内发生，
  >   没有「先检查再绕过去自己写」的缝。宿主没有这个机制（\`dsh-plugin-api.md\` Q3.1：授权包是
  >   凭据流程、scope 自认不是权限边界、sandbox 只管子进程），所以边界自己造。
  > - \*\*模型能力是协商结果\*\*：注册层支持 \`requires:\['model'\]\`，无模型时\*\*不跑 body\*\*、直接返回
  >   \`{available:false, reason}\`（输出契约用 \`oneOf\` 把这个形状写进去）；\`workspace.context\`
  >   的返回里带 \`capabilities.model\`。没有模型\*\*不会\*\*让插件不 apply——阅读端照常读、照常导出。
  > - \*\*参数契约不进 system prompt\*\*：\`description\` 注册时就拦换行与超长，详细契约留给技能按需
  >   加载的参考文档（建议落点与内容清单见交付报告，\#80 接）。
  > 
  > \`lib/tools/\*\*\` 是新域，注册只有 \`registerStudyMate(ctx)\` 一个入口（\`bin/dsh-plugin.ts\` 里
  > 只调这一个函数）：\#69/\#70/\#73/\#74 各在自己的目录里导出 \`registerXxx(ctx)\`，往那个函数的
  > 清单里加一行，不用碰插件入口。工具注册一律走 \`ctx.effect\`，且与路由同一种姿势——用
  > \`ctx.inject(\['tools'\], …)\` 而不是顶层 \`inject\`，缺 tools 的组合里插件其余部分照常 apply。
  > 
  > 校验与改写\*\*不重写逻辑\*\*：四个校验器是 \#67 那四个 \`validate\*\` 的适配层（加文件系统 walker
  > 与域 guard，按文件名分派 curriculum/progress/subject），\`validate\_lesson\` 用 \#66 的
  > \`parseLesson\`（内容格式 + 锚点四态 + 图片存在性，DOM 检查随静态渲染退役），\`validate\_pool\`
  > 是 \`check\_pool.py\` 的行为移植（lib/core 里没有对应实现），两个改写工具照搬
  > \`renumber\_lessons.py\` / \`apply\_empty\_reasons.py\` 的行为、去掉随静态渲染一起退役的 \`--render\`。
  > \`studymate\_export\` 是\*\*占位\*\*：返回「还没实现 + \#82 落地」，不假装成功、不产出文件。

- test(工具域): 域边界反证、四个校验器与两个改写工具的逐条断言 ([9b72e41](https://github.com/Miaotofu01/Study-Mate/commit/9b72e412bd4311cb60c8f2948279b9df5fd8340e))

  > 验收里两条是\*\*反证\*\*性质的，所以它们各有一条「必须抛」的用例，而不是文档约定：
  > 
  > - 声明里没有 \`progress\` 的工具去读 \`progress\` → \`DomainViolationError\`（消息带
  >   \`\[DOMAIN\_VIOLATION\]\` 前缀与「声明了什么」，模型照着改得动）；
  > - 只允许写 \`nodes/\*/status\` 的工具去写 \`mastery\` → 抛，且断言\*\*回调一次都没跑\*\*
  >   （guard 在写盘路径上，不是「先检查后放行」）；
  > - 另有正向对照，证明 guard 不是「一律抛」。
  > 
  > 声明表（八个工具各读哪些域、写哪些字段）在 \`test\_tools\_guard.mjs\` 里逐字写死：放宽一行就红。
  > \`description\` 也在这里钉住「一句话、无换行、≤120 码点」——常驻上下文里只有这一句。
  > 
  > 无模型是协商结果：\`requires:\['model'\]\` 的工具在「没有 llm 服务」与「有 llm 但没有 provider」
  > 两种上下文里都不跑 body、返回 \`{available:false, reason}\`，有 provider 时照常跑（不误报）。
  > 
  > 四个校验器与两个改写工具的用例都断言「结论 + 那一条具体问题 + 真行号」，并且\*\*造坏时一个字
  > 都不许动盘\*\*（dry-run、阻断、重复、目标名被占各一条）。改写工具的写盘都过 guard：
  > \`renumber\_lessons\` 的写域是 \`lessons/\*\`，\`apply\_empty\_reasons\` 是 \`lessons/\*\#empty\_reason\`。
  > 
  > 夹具放 \`scripts/tests/fixtures/tools.mjs\`：那是夹具不是套件，\`checks.mjs\` 的套件覆盖断言
  > 显式跳过 \`fixtures/\` 目录，放别处会被当成「没登记的套件」。四个套件登记进 core 组。

- test(运行时): 在真 DSH 里断言工具注册、body 可调用与越权抛 ([dba34f5](https://github.com/Miaotofu01/Study-Mate/commit/dba34f5d63712ae5cea2a82667e77ffdf33e4f42))

  > \`test\_dsh\_runtime.mjs\` 已经能启动真 DSH Web（临时 HOME、随机端口、\*\*不调模型\*\*），
  > 在它的探针里加一段：插件\*\*真的被加载\*\*时（native 安装；standalone 写的是声明式预设、
  > 插件包不进 profile，这时按 null 照实断言，不静默跳过）：
  > 
  > 1. 八个 \`studymate\_\*\` 在 \`ctx.tools\` 上按名字查得到，且模型侧投影里只有
  >    \`name\` / \`description\` / \`parameters\` 三个键、说明只有一行；
  > 2. 走\*\*真 dispatch\*\*（\`ctx.tools.execute\`，参数校验与输出契约校验都由宿主盖章）调
  >    \`workspace\_context\`（拿到工作区路径、今天、时区、科目现状、可用能力）、
  >    \`validate\_curriculum\` / \`validate\_lesson\`（含嵌套 \`oneOf\` 的输出契约）、
  >    \`export\`（\`const:false\` 的占位形状）；
  > 3. 反证：注册两个\*\*故意越权\*\*的探针工具，走真 dispatch 拿到 \`isError\` 与
  >    \`\[DOMAIN\_VIOLATION\]\`；再验 \`requires:\['model'\]\` 在无 llm 服务的上下文里返回
  >    \`{available:false, reason}\` 且 body 没跑。
  > 
  > 诚实边界：这一段验的是「插件在真 DSH 里加载 + 工具注册 + body 可调用」，
  > \*\*不是\*\*「模型在真实会话里调了它」——后者要花额度，默认门禁不跑（\`modelRequestsIssued: 0\`）。
  > 探针工作区造在隔离 HOME 里并临时改 \`DSH\_HOME\`，不碰 fixture 摆好的那些文件；
  > StudyMate 自己的警告收进结果的 \`studyMateWarnings\`，注册失败时不必靠猜。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/68-native-tools ([6ec7d14](https://github.com/Miaotofu01/Study-Mate/commit/6ec7d1436a391a2feabab190dd25ba3186d99d70))
- test(工具域): 夹具与 \#71 的三档数据模型对齐 ([5d61dc7](https://github.com/Miaotofu01/Study-Mate/commit/5d61dc7316f06cbcb660850dea9ce6ee5120f8e1))

  > 合入集成分支（\#71 落了：进度收成三档、\`mastery\` 取消、误解只剩 \`misconceptions.yaml\`
  > 一个落点）之后，夹具里还写着六档 + \`mastery\` + \`misconceptions\`，虽然现行 schema 因为没写
  > \`additionalProperties: false\` 放行了它们，但那是「碰巧过」，不是「按口径写」：
  > 
  > - \`progressYaml\` 只写 \`status\`（三档）；
  > - 旧六档那条用例\*\*保留\*\*旧取值，并在注释里说清为什么——读侧要按 §5.2 映射，这是被测行为；
  > - 进度校验的夹具去掉 \`mastery\` 与 \`misconceptions\`。
  > 
  > 四个套件在合并后仍全绿；\`npm test\` 与 \`npm run test:dsh\` 都绿。

- docs(测试): 登记工具域四个套件与真 DSH 探针的边界 ([f466ffe](https://github.com/Miaotofu01/Study-Mate/commit/f466ffe7e9e13231060117d64f641791a3635ad8))

  > 新增套件按规矩接进了 checks.mjs 的 core 组，本文件是「各命令的前置」的唯一出处，
  > 所以套件表与 test:dsh 那一节也要跟上：写清探针验的是「注册 + body 可调用 + 越权抛」，
  > 不是「模型在真实会话里调了它」（后者要花额度，默认门禁不跑）。

- merge(工具域): 八个原生工具与越权即抛的域强制（\#68） ([a8ecd72](https://github.com/Miaotofu01/Study-Mate/commit/a8ecd724d7a1d7b0278be33c0a036f4795f2e31c))

  > ticket/68-native-tools 带来 lib/tools/\*\* 的原生工具域：
  > - 八个 studymate\_\* 工具（workspace\_context、四个校验器、两个改写工具、
  >   studymate\_export 占位）经 ctx.effect 注册，声明表写死每个工具读哪些域、写哪些字段；
  > - 越权读／越权写一律抛 DomainViolationError（写越权时回调一次都不跑），
  >   requires:\['model'\] 的工具在无模型时不跑 body，返回 {available:false, reason}；
  > - test:dsh 的探针在插件真的被加载（native 安装）时验注册、body 可调用与越权抛，
  >   standalone 安装按 nativeTools: null 照实断言；
  > - 四个工具域套件登记进 scripts/release/checks.mjs 的 core 组，README 同步。
  > 
  > 与集成分支零冲突（分支已先合过 186a098）。
  > 
  > 验收：npm test 全绿；STUDYMATE\_DSH\_PACKAGE=&lt;dsh 包目录&gt; npm run test:dsh 全绿
  > （含原生工具探针）；examples/ 未被改动。

- test(数据层): 修掉参考资料来源栅栏里一条按临时目录名碰运气的假红 ([dbd2060](https://github.com/Miaotofu01/Study-Mate/commit/dbd2060d1f4a73ae8160a8d158ae63bee0855a49))

  > test\_host\_reference\_fence.mjs 的「同一个 operationId 重放只回原回执」里，
  > 判断重放有没有多落一个去重副本时写的是 \`referenceDir.includes('-2')\`——
  > 它把整条绝对路径都当成了判据，而 referenceDir 是 fs.mkdtempSync('studymate-host-reference-')
  > 造出来的临时目录，随机后缀以 '2' 开头（例如 .../studymate-host-reference-2peSP7l/ws/...）
  > 时这条路径自己就带 '-2'。实测这个后缀 20000 次里命中 380 次（1.90%），
  > 也就是这条断言约 2% 概率无条件变红，且红的是临时目录名，跟被测行为毫无关系。
  > 
  > 改成它真正想断言的东西：逐项取 reference/ 里的 basename，断言没有任何一项带 '-2'
  > 隔出来的去重副本（撞名换 -2/-3 见 lib/reference.ts）。判据依旧落在落盘文件名上，
  > 不是把 '-2' 换一个字符串了事：把一条 讲义-2.md 放进 reference/ 时新判据照样会红。
  > 
  > 验证：这条套件连跑 500 次，绿 500 次、红 0 次。

- feat(阅读端): 跨科目搜索把五类内容的块逐类补进索引 ([e2274e6](https://github.com/Miaotofu01/Study-Mate/commit/e2274e676aa6df3478e68a131c9e72df34ffa9ce))

  > \#78 的验收面里，正文只索引了 h2 小节标题与超过 20 字的段落，列表 / 表格 / 围栏 /
  > 引用 / 提示块 / 配图题注一个都搜不到；术语组标题、学习记录正文、误解记录正文也缺席。
  > 这次按块类型逐类补，并顺手堵掉同一处的两个死代码：
  > 
  > 1. 正文索引改成 \`blockFragments\` 逐块取「真正印在页面上的字」：六类点名的块之外，
  >    三级小标题、块级公式、练习块（含嵌套）、resources / related 一并对齐；短段落不再被
  >    20 字阈值丢掉；围栏的语言名与配图的图号 / alt 只进检索串，不冒充正文。
  > 2. 术语别名 \`term.avoid\` 原来是两次 push、\`kind+text\` 完全相同，第二次必然被去重吃掉
  >    ——别名一个字都搜不到。改成一次 push：规范叫法当 text，别名并进 label，两个都搜得到，
  >    界面上仍是同一条命中（附带把术语分组标题也放进索引）。
  > 3. 搜索去重键加了科目 slug 与节点 id。原来键里只有 \`kind|text\` 且跨科目全局共享，
  >    两门课里同样一句话只留先到的那条，点它会 \`goLesson\` 跳到\*\*错的科目\*\*。
  >    现在同名内容各科目各留一条，命中自带正确的 subject / node。
  > 
  > 索引仍然是派生物：不落盘、不缓存进任何存储，\`buildIndex\` 与它下面那组 \`\*Fragments\`
  > 保持纯函数（不碰 React、网络与时钟），因此可单测。
  > 
  > 测试：\`lib/client.js\` 零构建、原样发货，不能加 \`export\`，所以新增
  > \`scripts/tests/fixtures/client\_harness.mjs\`——在 Node 里伪造 \`window.\_\_ModuleLoader\_\_\`
  > 与 react 桩把头文件跑掉，再用 \`globalThis.\_\_studymate\_client\_internals\` 这枚钩子把工厂
  > 闭包里的纯逻辑取出来（浏览器里没人设这个全局，那一步是空操作）。
  > 套件 \`test\_client\_search\_index.mjs\`（35 条）已接进 \`checks.mjs\` 的 core 组；
  > 把三处修复退回去，其中 19 条会红。

- fix(阅读端): 术语表折叠块补空态，四个附件块都不再展开一片空白 ([114b232](https://github.com/Miaotofu01/Study-Mate/commit/114b2326f49b253f4e5a263cb5e46234a0b15707))

  > \#78 的验收要求「附件折叠块对空目录也给得出『没有』而不是报错」。四个块里
  > 参考资源 / 学习记录 / 误解记录都有空文案，\*\*只有术语表没有\*\*：\`groups.map\` 直接迭代，
  > 科目没有 GLOSSARY.md、或者文件里一个 \`\#\# \` 组都没有时，展开后是一片空白——不报错，
  > 但也什么都没说。
  > 
  > 改动：
  > 1. \`GlossaryBody\` 补空态（「这个科目的 GLOSSARY.md 里还没有词条。」），
  >    并且把「有组没词条」也算空——那种情况原来会渲染一个光杆组标题。
  > 2. \`RecordsBody\` / \`MisconceptionBody\` 的 \`items\` / \`records\` 兜一层空数组：
  >    payload 里少这一项时该走空态，而不是让「读不到」的报错跳到学生脸上。
  >    \`ReferenceFoldBody\` 与 \`ReferenceList\` 本来就有兜底，未动。
  > 
  > 测试：新增 \`test\_client\_fold\_empty\_state.mjs\`（7 条）钉住四个块的空态文案与
  > 「有内容时照常渲染」两个方向，接进 \`checks.mjs\` 的 core 组。

- merge(阅读端): 合入集成分支的 \#68 工具域与集成分支 tip ([e9bd233](https://github.com/Miaotofu01/Study-Mate/commit/e9bd2333c517472fb067cf34b3f4d96e24031a0f))

  > 冲突只有 \`scripts/release/checks.mjs\` 的 core 组清单：一边新增工具域四个套件，
  > 一边新增阅读端搜索与附件两个套件——\*\*两边都留\*\*，顺序按域分组排。
  > \`lib/client.js\` 集成分支未动，无冲突。

- test(架构边界): 扫真实 import 图断言域边界与依赖无环（\#69） ([2c099d4](https://github.com/Miaotofu01/Study-Mate/commit/2c099d4e4b7908f5c01b6165cb8c8d672008ae64))

  > 「谁能 import 谁」从口头约定变成一条会失败的测试。域规则表在文件顶部集中声明、
  > 默认拒绝：不在表里的一级目录就是新域，直接红——新增模块不会因为「忘了登记」而逃过。
  > 
  > 模块、边、环全部从源码算出来，没有手写模块清单（手写清单正是上一版覆盖率下限
  > 名不副实的成因）。扫描器认 \`import\` / \`export … from\` / 动态 \`import()\`，抹掉注释与
  > 正则、按区间剔除字符串内容里的示例；三个真实踩过的坑都写进了用例：模板里套模板
  > （bin/openai-skill-compat.mjs）、正则里带引号（lib/core/format.ts）、洞紧跟洞的模板。
  > 
  > 顺带钉住两条同类口子：\`require(...)\` 不在扫描范围内（lib/client.js 那个是浏览器加载器
  > 形参），所以反过来只许出现在 client 域；动态 import 的说明符定不死就报错，不许放过。
  > 
  > 判据抽成纯函数，另有七条拿合成图的反证用例——只断言「真实图无违规」的话，扫描器哪天
  > 退化成恒真也照样绿。README 的套件表跟着登记两行。

- test(覆盖率): 纯函数域覆盖率下限改为自动发现全部模块（\#69） ([9c3195a](https://github.com/Miaotofu01/Study-Mate/commit/9c3195a06a48fbeb7c1e193fe2582a6e404f1e2b))

  > 合并 \#67 时发现的口径缺口：标签写着「整个纯函数域（lib/core/\*\*）」的那条下限，
  > \`--test-coverage-include\` 只管报什么，没被任何套件加载的模块压根不进分母——它实际只
  > 统计了自己 suites 列表里那 5 个模块。\#66 并入的 {format,anchors,lesson}.ts 与 \#71
  > 并入的 {fence,questions,misconceptions}.ts 六份（两千多行）全在统计之外，标签名不副实。
  > 
  > 改成自动发现：lib/core/\*\* 下有哪几个模块、哪条套件真的把它们拉进同一轮，全从盘上算
  > （只认 scripts/tests/ 顶层的 .mjs，排除自己，免得一层套一层）。并加一条完整性断言：
  > 发现到的每个模块都必须出现在覆盖率报告的文件表里，少了谁就红并点名该补哪条套件——
  > 这样「没被加载就不进分母」不再能静默发生。确实统计不到的模块只能进 UNMEASURABLE
  > 并写清原因（现在是空的）。
  > 
  > 阈值按实测重定：分母从 5 个模块变成 11 个之后，实测 行 98.02% / 分支 91.39% /
  > 函数 97.31%，下限取 95 / 87 / 94（低一档留重构余量，不是放到 0）。

- merge(阅读端): 路线图与附件、跨科目搜索补齐（\#78） ([bd57575](https://github.com/Miaotofu01/Study-Mate/commit/bd57575a6af95ee3d01feb8c4eb26c22a7135d97))

  > 把 ticket/78-client 合进集成分支。三笔提交：
  > 
  > - e2274e6 跨科目搜索把五类内容的块逐类补进索引
  > - 114b232 术语表折叠块补空态，四个附件块不再展开一片空白
  > - e9bd233 合入集成分支的 \#68 工具域（上游 tip dbd2060）
  > 
  > 落点：lib/client.js（+208/-23，只动「常驻：搜索」一块 + 三个 fold body + 一枚测试钩子）；
  > 新增 scripts/tests/{test\_client\_search\_index,test\_client\_fold\_empty\_state}.mjs 与
  > fixtures/client\_harness.mjs；scripts/release/checks.mjs core 组登记两条套件。
  > 
  > 验收：合并前试合无冲突（自动三方合并干净）；主检出 npm test 全绿（exit 0），
  > 门禁自报「套件覆盖：63 个文件全部有归属（当前组 core：18 个 Python + 2 个 Node + 23 个 --test）」。

- feat(阅读端): 课件页阅读位置三级恢复（\#76） ([fd795c8](https://github.com/Miaotofu01/Study-Mate/commit/fd795c8617f79db5fa7b9c8179dd2999788e06e6))

  > 课件页原先切视图就把 scrollTop 归零，学生从课件跳去提问再回来、或从搜索跳进
  > 正文，都得自己重新找。现在补上捕获 \`{sectionId, offset, scrollTop, progress}\`
  > 与\*\*三级降级恢复\*\*：正文改过、锚点漂了的时候逐级退，而不是直接回到顶部。
  > 
  > - 一级 section：按小节的 \*\*id\*\* 找同一个位置，再按段内偏移落回去——正文里插一节
  >   不会让所有位置串位；
  > - 二级 offset：小节找不到（被删/改名）时退到存下来的绝对 scrollTop，正文改动不大
  >   时仍落在同一段附近；
  > - 三级 progress：连绝对像素都不可信（正文加长或缩短）时退到整篇比例。
  > 
  > 判定与换算全在 \`lib/client.js\` 里一段\*\*纯数学内核\*\*（两个标记之间，\`STUDY\_POSITION\_
  > KERNEL\_START/END\`）：不碰 DOM、不碰存储、不读时钟，所以能脱离浏览器单测
  > （\`scripts/tests/test\_client\_reading\_position.mjs\`，默认门禁里跑）。DOM 那一侧只负责
  > 量几何、读写偏好、以及「什么时候可以下结论」——正文里的图与公式会把高度撑起来，
  > 所以恢复要跨帧重试（上限 1.5s），而不是只做一次。
  > 
  > 位置\*\*只住在浏览器本地偏好\*\*（\`studymate.reading.v1\`，一篇文章一条，命名跟栏宽那个
  > \`studymate.panes.v1\` 同族），\*\*不写进学习工作区\*\*——那是学习内容的落点。捕获走
  > rAF 合并 + 停手落盘，切视图与卸载各补一次 flush；不挂 beforeunload，因为帧内换视图
  > 时组件并不卸载，那一下根本抓不到。
  > 
  > 顺手的两处收口：
  > - 换宽度（右栏滑出/收起、拖栏宽、窗口缩放）时按当前小节重新锚一次，否则正文重排
  >   会让同一像素落到别的段上——「点题目标记回来找不到刚才那段」正是这条 ticket 的起点；
  > - 单栏那两级（主页/科目主页）\*\*保持归零\*\*，只在层级真的换了才归零（数据静默重读
  >   不该把位置打回顶部）；原来那个 IntersectionObserver 判「读到哪一节」换成同一套
  >   几何判定，一处口径。
  > 
  > 锚点四态定位（resolved/stale/ambiguous/missing）\*\*一行没动\*\*，只在套件里重新验了一遍。

- test(阅读端): 阅读位置三级降级的两套验收（\#76） ([98d4d69](https://github.com/Miaotofu01/Study-Mate/commit/98d4d69cd358221ee36ba54b02a98ff8d6b85390))

  > 一套纯数学、一套真浏览器，都登记进 \`scripts/release/checks.mjs\`（前者 core 组、
  > 后者 \`--browser\` 组），否则套件覆盖断言会以退出码 2 拦下门禁。
  > 
  > \`test\_client\_reading\_position.mjs\`：按源码里的两个标记把位置内核\*\*原文\*\*切出来，
  > 在只给 ECMAScript 内建对象的 \`vm\` 沙箱里求值——顺手也就证明了这段真的不碰 DOM、
  > 不碰存储、不读时钟（沙箱里没有 window / document / localStorage / Date）。覆盖
  > 三级各自的选级条件、逐级退的顺序、段内偏移不溢出到下一节、目标一律夹进可滚范围、
  > 坏几何不静默取第一个、按 id 认小节（插一节不串位）、以及「什么时候可以下结论」。
  > 
  > \`browser/reading\_position\_test.mjs\`：真 Chrome（探测二进制，找不到明确跳过并说明）
  > 里跑\*\*真 \`lib/client.js\`\*\*——把原文喂给一个最小的模块装载器（照宿主冻结模块表，
  > react / react-dom / scheduler 三个键），用真 React 挂出 \`StudyMateApp\` 本体，再用
  > CDP 点真按钮、滚真滚动区。29 条断言覆盖五条验收标准：跳去提问再回来回到原位、从
  > 搜索跳进正文位置可复现、正文改长后按 offset 降级仍落在同一段附近、小节没了退到
  > 比例、位置只写本地偏好且形状就是四元组；另加锚点四态复核（三态判分入口关闭 + 各自
  > 的解释）与「单栏两级归零、课件页不复位」的层级区分。
  > 
  > 夹具在 \`scripts/tests/fixtures/\`（那个目录是套件覆盖断言明确排除的），它只负责造
  > library 应答与最小宿主，断言全在套件里。

- merge(门禁): 架构边界与依赖无环断言（\#69） ([b6c2877](https://github.com/Miaotofu01/Study-Mate/commit/b6c2877835f0910879d84a8828ed4804b5a640a1))

  > 把 ticket/69-next 合进集成分支（上游 tip bd57575，已含 \#78）。两笔提交：
  > 
  > - 2c099d4 架构边界套件：扫真实源码解析 import / export … from / 动态 import() 得 import 图，
  >   按域规则表判（lib/ 一级目录 = 域，未知域默认拒绝，lib/core/\*\* 不许碰 node:\* 与域外东西），
  >   域图与模块图都断言无环；另有合成图的反证用例钉住判据本身
  > - 9c3195a 覆盖率下限改为自动发现：lib/core/\*\* 有哪几个模块、哪几条套件把它们拉进这一轮
  >   全从盘上算，并断言每个模块都出现在覆盖率报告里（没被加载的模块不进分母）
  > 
  > 落点：新增 scripts/tests/test\_architecture\_boundaries.mjs；改 test\_core\_coverage\_floor.mjs；
  > scripts/release/checks.mjs core 组 +1；scripts/tests/README.md。
  > 
  > 冲突：checks.mjs 与 README.md 均文本自动合并，无冲突标记——\#78 的两条套件登记留在数组末尾，
  > \#69 的一条插在 test\_core\_coverage\_floor 之后，两边都留。
  > 
  > 验收：主检出 npm test 全绿（exit 0），门禁自报
  > 「套件覆盖：64 个文件全部有归属（当前组 core：18 个 Python + 2 个 Node + 24 个 --test）」。

- feat(任务域): 插件自己的后台任务模型（六态/owner 句柄/落盘/阅读端路由）（\#73） ([6dc7fbd](https://github.com/Miaotofu01/Study-Mate/commit/6dc7fbde70a703de5a4fb8148d9873ee7da5bc78))

  > 目标态规格 §3.2 的任务模型：只覆盖\*\*插件自己执行\*\*的后台工作（导出、资料格式转换、
  > 索引重建），不含「派角色生成内容」——那仍走宿主的子 agent 机制。
  > 
  > 为什么\*\*不用\*\*宿主的 ctx.jobs（这是 ticket 里已定的取舍，照做并记在代码注释里）：
  >   1. \`dsh-jobs-local\` 明说不持久化（lifecycle state、output ring、cursor 全在内存），
  >      而 ticket 要求「导出这类关键任务落盘，重开 DSH 能接上」；
  >   2. \`ctx.jobs.start()\` 在没有 attached controller 服务该 owner 时\*\*拒绝\*\*启动，
  >      等于要求组合里挂着 \`dsh-tool-jobs\`——StudyMate 是零依赖插件，还要在 headless/tui
  >      组合里活着，不能被别的包的有无决定能不能起任务；
  >   3. 状态词表不同（宿主是 running/stopping/completed/killed/failed，本 ticket 要六态中文）。
  > 代价是宿主那套「完成通知 + 唤醒 agent」要自己接，那张票不在本次范围里。
  > 
  > 落点与形状：
  >   · \`lib/tasks/{state,record,store,service,tools,route,index}.ts\`；
  >   · 六态 \`排队/运行/取消中/完成/失败/已取消\`，转移表是唯一合法性来源（终态只进不出，
  >     \`失败 → 排队\` 是唯一例外，专给被重启打断的落盘任务 resume）；
  >   · 句柄 = \`{ id, owner }\`：别人（另一个会话标签）拿着它来，连记录都不查先拒
  >     （\`\[TASK\_FORBIDDEN\]\`）；无主任务（\`本机\`）与宿主 ctx.jobs 同一口径，谁都能看；
  >   · 状态查询同步返回（从不阻塞）；\`wait\` 有上下界（默认 30s、上限 300s），超时返回
  >     \`next\`（继续等 / 不阻塞地看 / 取消，三条路都写清），不吊死也不静默；
  >   · \`cancel\` 同步给回执（\`kept\` = 已完成的产物，一律保留；\`discarded\` = 半成品）；
  >   · \`destroy\` 先算回执并返回、文件删除排在 setImmediate 里（\`flushDeletions()\` 收尾），
  >     所以「回执到手」不取决于删文件成功与否；活着的任务不许销毁；
  >   · durable 的落在 \`&lt;DSH\_HOME&gt;/studymate/tasks/&lt;id&gt;.json\`（原子写：临时文件 + rename），
  >     重开读到「还写着运行中」的记录就如实记成失败 + interrupted，留 resume/destroy 两条路。
  > 
  > 对外（\#68 留的注册点只加一行）：
  >   · 五个原生工具 \`studymate\_task\_{status,wait,cancel,destroy,resume}\`；\*\*起任务不是工具\*\*
  >     —— 那是产出方的事（\#82 的导出拿到句柄再交给模型），给模型一个凭空起任务的口子只会
  >     造出没有产出方的空任务；
  >   · 阅读端 \`GET /api/studymate/tasks\`（进度条），只读、且投影里\*\*没有 owner\*\*
  >     （免得从板子上抄个 owner 去伪造句柄）；
  >   · 任务域\*\*不 import 工具域\*\*：\`registerStudyTool\` 由注册点注入，域图上只有
  >     tools → tasks 一条边（否则 tools ↔ tasks 成环，\#69 的架构边界测试会红）。
  > 
  > owner 标签取自宿主执行上下文里的调用方（\`exec.agent.id\`）：\`lib/tools/define.ts\` 只是把
  > 这个身份原样透给 body（没有会话身份时是 undefined，不编默认值）。

- test(任务域): 任务模型套件接进 core 门禁，注册点组合断言跟着改（\#73） ([8157b92](https://github.com/Miaotofu01/Study-Mate/commit/8157b92ddaa48999291c37b6bcd164fabf8947eb))

  > 新套件 \`scripts/tests/test\_tasks\_model.mjs\` 逐条钉 ticket 的验收：
  >   · 三种结局（完成/失败/已取消）各一份明确回执，含 \`kept\`/\`discarded\`/\`result\`；
  >   · 等待超时返回可行的下一步提示（断言提示里三条路都在），且任务不受影响；
  >   · 取消回执说清哪些已完成的产物会保留，回执之后产物还在盘上；
  >   · 销毁\*\*先回执、后删文件\*\*——直接断言「回执到手的那一刻记录文件还在」，
  >     \`flushDeletions()\` 之后才没了（顺序是被观测到的，不是靠注释承诺）；
  >   · 越权句柄被拒（句柄、裸 id、list 三条路都验）；
  >   · 阅读端路由的路径与返回形状，以及板子上没有 owner。
  > 
  > 跨进程那一节是\*\*真进程边界\*\*：夹具 \`fixtures/tasks\_producer.mjs\` 作为「进程 A」被 spawn，
  > 起一个 durable 任务、把进度与产物落盘后硬退出（模拟关掉 DSH）；父进程（进程 B）用同一个
  > 台账目录重新加载，验「查得到 + 状态如实记成失败/interrupted + resume 得动 + destroy 收尾」。
  > 另有一例验「跑完的 durable 任务重开还在、回执能从盘上重新派生」。
  > 
  > \`test\_tools\_guard.mjs\` 的「八个工具」断言改成按两份名字表拼起来算（八个学习数据工具 +
  > 五个任务工具）：注册点是 \#68 留的，多一个子系统就该在断言里看得见，而不是把断言放宽。
  > \`scripts/tests/README.md\` 补一行套件说明。

- merge(阅读端): 集成分支的工具域与跨科目搜索（\#68/\#78）合进来 ([1c00a2a](https://github.com/Miaotofu01/Study-Mate/commit/1c00a2a3848cc0f537cee41da452b4462533f1a3))

  > 只有 \`scripts/release/checks.mjs\` 的 core 组 tests 数组冲突：两边都是纯追加
  > （\#76 加一条阅读位置内核套件，\#68/\#78 加工具域四条与阅读端两条），\*\*两边都留\*\*，
  > 没有删除他行。\`lib/client.js\` 自动合并成功——\#76 的新增集中在位置内核与
  > LessonPage 的接线，与 \#78 的搜索索引、附件折叠块不在同一区域，零冲突。
  > 
  > 合并后复核：
  > - \`npm test\` 全绿（exit 0），门禁自报「套件覆盖：65 个文件全部有归属」；
  > - \`node scripts/release/checks.mjs --browser\` 退出码 0，阅读位置套件 29/29 通过
  >   （真 Chrome 里跑真 client.js），说明 \#78 对 client.js 的改动没有动到位置恢复；
  > - \`node --check lib/client.js\` 通过。
  > 
  > 顺带记一笔：\#78 给 \`lib/client.js\` 加了 \`\_\_studymate\_client\_internals\` 测试钩子
  > （把工厂闭包里的内部件交给 Node 侧套件）。本张的纯数学内核走的是\*\*源码标记切段 +
  > vm 沙箱求值\*\*那条路，不依赖那个钩子；两条路各自成立，没有互相覆盖。

- merge(任务域): 合入集成分支（架构边界 \#69 与阅读端 \#78），checks.mjs 两边都留 ([6790a34](https://github.com/Miaotofu01/Study-Mate/commit/6790a34f060dec0ac1e329dcb52226bf3e9a7ec2))
- docs(测试): 浏览器套件表登记阅读位置那一套（\#76） ([c2b4914](https://github.com/Miaotofu01/Study-Mate/commit/c2b4914484a8d868fc6e25234680866d28539fbb))

  > \`scripts/tests/README.md\` 的「浏览器套件与手动工具」表是那一层唯一的目录，
  > 新套件不登记就没人找得到。同一条也写清纯数学那一半住在默认门禁里的哪个文件，
  > 免得后来的人以为位置恢复只能靠真浏览器验。

- test(架构): 域规则表登记 tools → tasks（注册点是组合根，方向只有这一条）（\#73） ([6d27cee](https://github.com/Miaotofu01/Study-Mate/commit/6d27cee7f8c130a8d3837a0ccc0af99f524590f4))

  > \#69 的表把 tools 的允许依赖写成 \[core, lib\]，而 \#68 的注册点 \`registerStudyMate\` 按设计
  > 要逐个调用各子系统自己目录里的 registerXxx——它必须 import 每个子系统。\#73 的任务模型一落地，
  > 真实 import 图里就多出 \`lib/tools/index.ts → lib/tasks/index.ts\` 这一条，边界测试如实报红。
  > 
  > 处理方式是改\*\*声明表\*\*（它本来就是这张网唯一的判据），不是放宽扫描器：
  >   · \`tools.allow\` 加 \`tasks\`，并在注释里写清方向只有 tools → 子系统这一条；
  >   · 子系统一律不许 import tools（任务域把 \`registerStudyTool\` 当参数接过去，正是为此）；
  >   · 往后每落地一个注册进注册点的子系统（\#74 的 watch、\#82 的导出）照这个姿势各加一个域名，
  >     不许改成通配。

- fix(任务域): 等待的 timer 不许 unref——进程不能把「等」悄悄吞掉（\#73） ([68815bd](https://github.com/Miaotofu01/Study-Mate/commit/68815bdb8ae9920224ce51e9906c811fb0d52ef3))

  > 取证时踩到的真问题：\`wait()\` 的超时 timer 一开始跟进度节流一样 unref 了，结果是「没有别的
  > 活干」的进程（无头脚本、单次 CLI 调用）会在等待中途直接退出，那个 Promise 永远不 resolve
  > ——正好是 ticket 点名不许出现的「吊死且静默」。
  > 
  > 改成\*\*不\*\* unref：等待是调用方明确要的，进程就该被它留到 resolve 或超时为止；上界由
  > timeoutMs 兜住（默认 30s、上限 300s），所以最多留这么久。进度节流那个 timer 保持 unref
  > （它是后台家务，进程该走就走；状态转移与终态本来就是同步落盘的，丢的只是最后一次进度行）。
  > 
  > 顺带把越权消息里重复的那半句去掉（原来读作「它属于另一个调用方；它属于「session-A」」）。

- merge(门禁): 集成分支的架构边界断言（\#69）合进来 ([acc9860](https://github.com/Miaotofu01/Study-Mate/commit/acc98600ff4b8121e762ca477607894ce113eda8))

  > \`scripts/release/checks.mjs\` 的 core 组 tests 数组又撞了一次：两边仍是纯追加
  > （\#76 一条阅读位置内核套件、\#69 一条架构边界断言），\*\*两边都留\*\*，无删除他行。
  > \`scripts/tests/README.md\` 自动合并（我在浏览器套件表加了一行，\#69 没碰那张表）。
  > 
  > 合并后复核：\`npm test\` 全绿（exit 0，门禁自报「套件覆盖：66 个文件全部有归属」）；
  > \`node scripts/release/checks.mjs --browser\` 退出码 0，阅读位置套件 29/29 通过。

- build(模块): 仓库声明为 ESM，两个 CommonJS 套件改名 .cjs（\#70） ([96cdf04](https://github.com/Miaotofu01/Study-Mate/commit/96cdf04aa8a19abea6b68d55d32d9df8745ac3f0))

  > 本包发出去的全是 ESM（\`lib/\*.ts\`、\`bin/\*.mjs\`、\`bin/\*.ts\`），却没写模块类型，
  > 于是 Node 每加载一个 \`.ts\` 都要「先按 CommonJS 解析失败、再重解析成 ES module」：
  > 一次 \`npm test\` 打 26 条 MODULE\_TYPELESS\_PACKAGE\_JSON，还白付一遍重解析开销。
  > 
  > - \`package.json\` 加 \`"type": "module"\`。
  > - 仓库里仅有的两个 CommonJS 套件（\`scripts/tests/{quiz\_dom\_test,toc\_dom\_test}.js\`，
  >   用 \`require\`/\`\_\_dirname\`）改名 \`.cjs\`；引用点跟着改：\`checks.mjs\` 的 core node 组、
  >   \`scripts/tests/README.md\`、\`test\_quiz\_code.py\` 的说明。扫描器正则本来就认 \`.cjs\`。
  > - \`tsconfig.json\` 打开 \`verbatimModuleSyntax\`：它和 \`"type": "module"\` 是一对——
  >   没有后者，tsc 按 nodenext 把 \`.ts\` 当 CJS 看，开着这条就会以 TS1287/TS1295 拒绝 ESM 语法。
  >   现在类型专用 import 由编译器强制写成 \`import type\`（现有源码已全部合规，\`tsc --noEmit\` 干净）。
  > 
  > 浏览器侧不受影响：\`lib/client.js\` 由宿主按 \`&lt;script&gt;\` 加载，不看这个字段；
  > \`node --check lib/client.js\` 仍通过。

- refactor(安装): DSH 原生加载的引擎就是已安装的包，不再拷源码树（\#70） ([56cfd0f](https://github.com/Miaotofu01/Study-Mate/commit/56cfd0f506f152fb6a9f1e2d8e70edcb02909dc2))

  > 原生插件加载（\`installPayload({native:true})\`）今天会先把整份源码树拷进
  > \`&lt;dshHome&gt;/studymate/engine/\`：standalone 安装靠它当引擎，可插件路径下那份拷贝
  > 既没人用、又要和安装好的包各自过期。改完分档说清：
  > 
  > - 原生插件加载：\`config.root\` 与预设的 \`customSkillDirs\` 都指向\*\*已安装的包自身\*\*
  >   （package.json 的 \`files\` 本来就带 \`scripts/\`、\`templates/\`、\`schemas/\`、\`docs/\`、
  >   \`.dsh/skills\`），\`&lt;dshHome&gt;/studymate/\` 连空目录都不建；顺带省掉一次整包拷贝
  >   ——那段拷贝在 native 下除了写进 staging 再被 finally 删掉，什么也没做。
  > - standalone 安装：一字未改，引擎副本照旧落在 \`~/.dsh/studymate/engine/\`，
  >   \`&lt;root&gt;\` 照旧指向它。无头宿主（Antigravity / Codex）的安装路径完全没动。
  > - \`--mode native\` 的交接安装：只改注册与归属，不落任何载荷，\`&lt;root&gt;\` 保持原样，
  >   由选定的原生包在下次启动时自己写。
  > 
  > \*\*迁移窗口是刻意的\*\*：技能还在按 \`python3 -B &lt;root&gt;/scripts/&lt;名&gt;.py\` 调脚本，而包里就有
  > \`scripts/\`，所以 \`&lt;root&gt;\` 换成包目录之后旧路径照样解析得到——这不是漏改，等工具替掉
  > 脚本调用（\#82）之后再收。
  > 
  > 技能改写只改写 staging 里的副本：装好的包是随包发布的只读材料，\`link:\` 安装下更是
  > 学生自己的检出，一次启动就往包目录里写会污染工作树（这条有断言钉住）。
  > 
  > 真 DSH 探针（test\_bundle 的假 ctx + test\_dsh\_runtime 的真宿主）都加了断言：
  > native 下 \`root\` 是包目录、\`~/.dsh/studymate/\` 不出现；standalone 下照旧是 engine 副本；
  > 另有一条 standalone → 交接 → 原生启动的完整迁移用例。

- merge(安装): 合入集成分支（架构边界 \#69 与阅读端 \#78） ([a56d672](https://github.com/Miaotofu01/Study-Mate/commit/a56d672e47d68687c91738687fd73fba6c548cd4))
- test(浏览器QA): 抽出共用 CDP 骨架，浏览器二进制改成探测 ([0da38e5](https://github.com/Miaotofu01/Study-Mate/commit/0da38e56f3764d9b3cf39f6cf8f0c863f2a0b997))

  > 为什么：主干里既没有 summary.json，也没有控制台错误 / 页面错误 / 失败请求的收集——
  > 那套做法只活在即将删除的一次性原型 prototype/reading-client/tools/shot.mjs 里。
  > 先把做法抄成正式的 QA 骨架（scripts/tests/browser/harness.mjs），再删原型；
  > 顺序反了就丢了唯一实现。抄过来的三段是：
  > 
  >   · 四个 CDP 域的收集方式：Runtime.consoleAPICalled（error/warning）、
  >     Runtime.exceptionThrown（未捕获异常）、Log.entryAdded（浏览器自己记的错）、
  >     Network.loadingFailed（失败请求）；
  >   · summary.json 的形状：每个场景一条，带 metrics + problems + warnings；
  >   · 一次性 profile 目录、跑完删、kill 之后才删 profile 的收尾顺序。
  > 
  > 同时把六个脚本里硬编码的 spawn('google-chrome') 换成探测：
  > 环境变量（STUDYMATE\_CHROME / CHROME\_BIN / CHROMIUM\_BIN / PUPPETEER\_EXECUTABLE\_PATH）
  > → PATH 上的常见名字（google-chrome / chromium / chrome …）→ macOS 的 .app 路径。
  > 找不到时打一段说明并以退出码 3 退出——跳过不算通过，静默绿比红更坏。
  > 
  > 三套旧套件的断言表一个字没改，只是换了壳；它们现在也会出截图与 summary.json。
  > 产物落在 .shots/&lt;套件&gt;/（新加进 .gitignore，本地产物不进库）。

- feat(阅读端): token 对比度达 AA、动效四档、路线图无障碍兜底、首次引导几何 ([9c88fc8](https://github.com/Miaotofu01/Study-Mate/commit/9c88fc8843b3c6dbe1bc3efa6cc20a1936029e03))

  > 四件事都写在 lib/client.js 的同一个新块里，注释写清「为什么」：
  > 
  > 1. token 纪律（规格 §4.2 / §10.3，对齐 F8）。今天有 6 处文本色达不到 AA：
  >    三/四级文字亮色下只有 3.7:1 / 2.1:1，语义色当文字用更低（绿 2.3:1、琥珀 2.2:1、蓝 4.2:1）。
  >    规范只许引 --dsw-alias-\*，所以不自己调色，而是把这些档位\*\*往主文字色混\*\*
  >    （color-mix 只引宿主 token，宿主自己也在用这个手法），比例不是拍脑袋：
  >    scripts/tests/test\_client\_tokens.mjs 逐档算对比度，改坏了就红。
  >    代价记一笔：四档的深浅差因此收窄，层次改由字号与字重承担。
  > 
  > 2. 顺手修掉一处一直没人发现的坏引用：--dsw-alias-fill-tertiary 与 --dsw-alias-fill-l2
  >    宿主\*\*根本没有定义\*\*（整棵宿主树 0 个定义点），19 处一直在吃兜底值 rgba(0,0,0,.0x)——
  >    亮色下凑合，暗色下几乎看不见。换成宿主真实存在的 markdown-tag，合并成一个 --smb-fill，
  >    现在 token 块里引到的每个 alias 都真的存在（这条也进了测试）。
  > 
  > 3. 动效四档 auto/full/reduced/off（规格 §4.4，对齐 F7）：档位挂在 .smb-root 的 data-motion 上，
  >    只改 --smb-motion 一个值；auto 跟随 prefers-reduced-motion（落到 reduced 而不是 off——
  >    off 会让「点题目标记滑出右栏」突然出现，反而更难跟）。顶栏右端给了原生 select 切档，
  >    与栏宽同级住在浏览器本地偏好里（studymate.motion.v1）。
  > 
  > 4. 路线图无障碍（规格 §4.4）：容器补 role=group + aria-label，两条装饰 svg 补 aria-hidden
  >    （原先读屏会把一堆无标签 &lt;path&gt; 当图形念），再配一张视觉隐藏的 &lt;table&gt; 说清
  >    「节点 / 层 / 前置 / 状态」——做法与热力图那套 HeatTable 一致。
  >    热力图本身按规格仍暂缓渲染，没有调用点，没去动它。
  > 
  > 5. 首次引导的定位几何（规格 §4.4，对齐 F6）：coachPlacement 是纯函数——优先方位 →
  >    按剩余空间换边 → 窄容器停靠底部 → 目标占满时退到内角，任何分支都夹在 margin 里。
  >    UI 本票不做（ticket 只要几何与单测）。
  > 
  > 零构建、无 export 的工厂里，纯函数外面拿不到，所以加了一个显式外露钩子：
  > window.\_\_STUDYMATE\_TEST\_\_ 为真时才把 coachPlacement / motionFor 挂到
  > window.\_\_STUDYMATE\_PURE\_\_（真 DSH 里没人设这个开关，等于不挂）。

- test(阅读端契约): token 对比度进默认门禁，几何与动效档纯函数单测 ([5a6c2ee](https://github.com/Miaotofu01/Study-Mate/commit/5a6c2ee4992a71e92a76ec3c09e3f3196074f568))

  > 两套新套件接进 checks.mjs 的 core 组（不登记的话套件覆盖断言会直接拦下门禁）：
  > 
  > · test\_client\_tokens.mjs —— 解析 lib/client.js 的 token 块 → 算相对亮度 →
  >   断言每个文本 token 在\*\*每个表面\*\*（bg / panel / raise / fill，各自再叠一层 hover 底色）
  >   上都达 WCAG AA 的 4.5:1，亮暗两套都测。另外三条兜底：
  >     1. CSS 里引到的每个 --dsw-alias-\* 宿主都得真的有定义（fill-tertiary 那种坏引用就这么抓到的）；
  >     2. 凡是当 color 用的 token 都必须在契约表里，不许有漏网的；
  >     3. 这些文本档都用在 &lt;18.66px 的正常字号上，所以门槛是 4.5 而不是 3.0。
  >   两边数据都不手抄：我们的 token 从源码里解析，宿主的取值用
  >   fixtures/host-theme-tokens.json（主题 token 快照，\_source 记着包名版本出处；
  >   设了 STUDYMATE\_DSH\_PACKAGE 时会就地重新解析宿主主题核对，对不上就红）。
  > 
  > · test\_client\_pure.mjs —— 动效四档与首次引导几何。用 node:vm 把整份插件源码跑一遍、
  >   喂一个假 window 与 react 桩，拿回工厂里外露的纯函数（刻意不用正则扒源码）。
  >   覆盖：auto 跟随系统偏好、CSS 里的四档时长与 motionFor 一一对应、
  >   媒体查询只改写 auto 档；几何的四种分支 + 300 组随机输入的「不越界」不变量 +
  >   不改入参 / 可重入。
  > 
  > fixtures/client-css.mjs 是上面两套（以及浏览器 QA）共用的解析器：CSS 与 token 块解析、
  > hex/rgb/color-mix/var 的解算、WCAG 相对亮度与对比度。放在 fixtures/ 是因为
  > checks.mjs 的套件覆盖断言只 walk scripts/tests 下的文件、遇到 fixtures 目录就跳过。

- test(阅读端QA): 加一条把真 lib/client.js 挂进夹具页的浏览器用例 ([80ba6af](https://github.com/Miaotofu01/Study-Mate/commit/80ba6af3a17da49be3acdd2216e2380c9b69b6df))

  > 为什么要有：另外三套浏览器套件测的都是旧静态模板（file:// + .syn-\*/.quiz/.katex），
  > 对阅读端零覆盖（ticket \#75 的验收面之一）。这条把\*\*真的 lib/client.js\*\* 挂进夹具页跑：
  > 
  >   · 夹具页的 CSS 与 JS 都从源码现取（CSS 用正则从 client.js 里取出内联串），不手抄标记；
  >   · 数据在临时工作区里现造、readLibrary() 读成 payload、stub 掉 fetch 喂给前端，跑完即弃；
  >   · 宿主的 --dsw-alias-\* 用 fixtures/host-theme-tokens.json 铺进页面，亮暗两套都能测。
  > 
  > 六个场景（每个都出截图 + summary.json 一条记录）：
  >   home         阅读端挂起来、两门科目、顶栏四档动效选择器
  >   subject      路线图的 aria-label、role=group、两条装饰 svg 的 aria-hidden、
  >                视觉隐藏的 &lt;table&gt;（caption / 四个表头 / 前置关系）、真 role=progressbar
  >   lesson       面包屑、中栏 + 两条窄轨、正文、窄轨 aria-expanded
  >   motion       切四档 → --smb-motion 跟着变；模拟 prefers-reduced-motion → auto 落 70ms、
  >                显式 full 档不被系统偏好改写；档位写进 localStorage
  >   contrast     亮暗两套，量\*\*渲染出来的\*\*前景色（沿 DOM 合成背景）是否达 AA——
  >                这一条同时验「CSS 里的 color-mix 在这个引擎里真的解出来了」
  >                （解不出来时文字会安静地退回继承色，控制台一声不响），
  >                并且与 node 侧的推算互为对照。
  > 
  > 夹具用的最小渲染器 fixtures/mini-react.js：宿主那份 React 打包在 bundle 里拿不到，
  > 而我们要跑真的插件，所以写一个只够跑阅读端的替身（createElement/Fragment +
  > 五个 hook，状态槽按「位置 + 组件函数」认实例）。它每次状态变化整树重建，因此
  > \*\*不\*\*断言路线图的连线几何（那段代码把 DOM 节点闭在 effect 里，真 React 里节点不换，
  > 是夹具的边界，不是阅读端的缺陷）——这条写在夹具注释与套件注释里。
  > 
  > 浏览器二进制走 harness 的探测；读不到浏览器就跳过（退出码 3）。

- chore(原型): 删掉一次性原型目录 prototype/ ([d2c7741](https://github.com/Miaotofu01/Study-Mate/commit/d2c77415a08bf15198945503c877b0b37d447e1c))

  > 版式结论已经落进目标态规格与 lib/client.js，目录本身只作「当时比过哪三种」的记录，
  > 按 ticket \#75 删除（59 个入库文件，含 21 张已入库的 .shots 截图）。
  > 
  > 引用一并清掉，仓库里没有指向它的悬空链接：
  >   · package.json 的 prototype / prototype:data 两条脚本（原型 README 自己点名的）；
  >   · lib/library.ts 顶部那句「这份实现是 prototype/.../build-data.py 的 JS 版」——
  >     改成不指向已删路径的说法，保留「语义逐条对齐它、刻意有三处不同」这段历史信息；
  >   · docs/agents/issue-tracker.md:46 的 \`prototype\` 是 wayfinder 的同名 triage 标签，
  >     \*\*不是引用\*\*，没动。
  > 
  > 删除前先把它的 CDP 自检做法抄成了 scripts/tests/browser/harness.mjs（见前一个提交）。

- merge(任务域): 插件后台任务模型（\#73） ([682bb64](https://github.com/Miaotofu01/Study-Mate/commit/682bb64591ce90f41d54700dc6a434e3017cc29e))

  > 插件自己的后台任务模型（lib/tasks/\*\*）：六态状态机与转移表、owner 句柄与越权即抛、
  > durable 落盘后\*\*跨进程\*\*接得上、五个 studymate\_task\_\* 工具与阅读端
  > GET /api/studymate/tasks。注册点组合根多一条 tools → tasks 边（域表并集）。

- merge(阅读端): 合入集成分支（\#78 路线图与搜索、\#69 架构边界）——两边都留 ([901fc77](https://github.com/Miaotofu01/Study-Mate/commit/901fc77e0c7f3ec0b344744b48854707b778a5c4))

  > 冲突只有两处，都是「两边各加了一段」：
  >   · scripts/release/checks.mjs 的 core 套件清单：我的两条阅读端契约套件与 \#69/\#78 的
  >     十条套件（架构边界、工具域、搜索索引、折叠块空态）都留着；
  >   · scripts/tests/README.md 的按需命令表：test:browser 那行取我的（四套 + 探测），
  >     test:dsh 那行取集成分支的（native 安装下多验一层）。

- merge(安装): DSH 侧引擎就是已安装的包（\#70） ([d0f30c5](https://github.com/Miaotofu01/Study-Mate/commit/d0f30c5f3af25f77e299505f239f73735c281a19))

  > \#70 把「DSH 原生安装」的引擎来源从「拷一份源码树到 ~/.dsh/studymate/engine/」改成
  > \*\*就是已安装的包自身\*\*——native 安装下 root 指向包目录，engine/ 不再出现副本；
  > standalone 安装照旧把引擎副本落在那里、root 也照旧指向它。
  > 
  > - 96cdf04 build(模块): 仓库声明 ESM（package.json type: module），两个 CommonJS
  >   套件 quiz\_dom\_test.js / toc\_dom\_test.js 改名 .cjs；tsconfig 随之调整。
  > - 56cfd0f refactor(安装): bin/studymate.mjs 不再拷源码树；test\_dsh\_runtime.mjs 增
  >   两条断言（native 下 root 指向已安装的包、engine/ 不出现；standalone→native 交接
  >   后 root 从 engine/ 换成包目录）。
  > - a56d672 merge: 合入集成分支（\#69 架构边界、\#78 阅读端）。
  > 
  > 验收：\`npm test\` 全绿（套件覆盖 65 个文件全部有归属，core 组 18 Python + 2 Node
  > + 25 --test；--static 组 5 Python + 3 --test）。

- feat(作答落盘): 作答数据的 Host 半写入端点（\#72） ([9680f6c](https://github.com/Miaotofu01/Study-Mate/commit/9680f6cc0023a3b0a9bbec1a73dffbd6ae573b98))

  > 阅读端今天只读作答数据，写回没接。这条补上 Host 半：\`POST /api/studymate/attempts\`
  > 把一次作答写进 \`attempts/&lt;NNNN&gt;-&lt;节点id&gt;.json\`（数据层是 \#71 落的 lib/attempts.ts，
  > 幂等 + 版本号两件武器都已在它里面），\*\*题库文件一个字节都不碰\*\*（ADR-0007）。
  > 
  > - 路由单独成文件 \`lib/attempts-route.ts\`：\`bin/dsh-plugin.ts\` 这一波有四张 ticket 同时改，
  >   那里只留一行注册；路径、方法、请求体形状、状态码映射全在模块里。
  > - 只开 POST，不另开 GET：读走 payload 的 \`node.attempts\`（\#71 已经挂上去了），
  >   再开一条读路径就是第二份真相。
  > - 409（版本冲突）与幂等重放都只是把 writeAttempts 的回执原样递出去——栅栏在数据层，
  >   这里不做第二套判断；回执里带着当前内容与版本号，前端据此就地重读，不必再跑一趟。
  > - 为什么不用 \`lib/routes/\`：域 = \`lib/\` 的一级目录，新域要在 \#69 的架构边界表里登记；
  >   这个是 Host 数据层的路由，放 \`lib/\` 域里最省事，也不欠别人一笔。
  > 
  > 套件 \`test\_host\_attempts\_route.mjs\` 走\*\*注册出来的那条路由\*\*（不是直接调 handler）：
  > 注册形状、跨请求读回（= 刷新页面）、重放不产生第二条记录、冲突拒绝不写盘且带回当前内容、
  > 主观题自评落盘、题库与课件逐字节不变、坏请求与无工作区的判词。

- feat(阅读端): 作答落盘的写队列与陈旧响应围栏（\#72） ([1bcdeb4](https://github.com/Miaotofu01/Study-Mate/commit/1bcdeb4f83529dc25d881da7be7c43e665d2f4e3))

  > 作答以前只活在页面内存里，刷新即丢。这条把阅读端接上 Host 半：点选项 → 乐观上屏 →
  > 写队列 → POST /attempts → 回执覆盖本地那一条；刷新后由 payload 的 node.attempts 还原。
  > 「上次选了 X」与作答计数从此来自落盘数据，不再是页面内存。
  > 
  > 三件东西合起来才叫围栏（目标态规格 §4.3 对齐 F3）：
  > 
  > 1. 写队列：一条队列管一个「科目+节点」，FIFO，同一时刻只有一次写在飞。每次写入的
  >    expectedVersion 是\*\*上一次回执里的版本号\*\*——并发发出去的第二笔必然带过期版本，
  >    被 409 拒；那不但白跑一趟，还会把「别人改过」与「自己撞自己」搅成一条假冲突。
  > 2. 合并轮询：重读请求在飞时不排队，只记「回来再补读一次」；读数回来是\*\*并进\*\*本地，
  >    不是整体替换（useLibrary 单飞 + mergeNodeAttempts）。
  > 3. 栅栏：本地那条比这次读数新（seq 更大）、或者还有没落的写入（pending），一律不许
  >    被覆盖。于是「先发出的读、后到达的响应」永远盖不掉学生刚做的作答。
  >    版本号另有一条「走过的不回头」判据：过期 payload 不许把队列手里的栅栏拨回去。
  > 
  > 冲突不静默：409 里带回当前内容与版本号（Host 的「拒绝并重读」），前端拿它就地重读、
  > 按新版本原样重来一次，并把冲突挂在那一题上让学生看见（成功了也说一句「已按最新版本
  > 重记了一次」）；第二次还撞就如实说「这次没写进去」，不静默丢数据、不引入文件锁。
  > 
  > 顺手把「已记进本次会话」那句界面文案换成三种如实说法（正在写 / 已记进作答数据 /
  > 这次没写进），文件头契约注释同步改写；lab 那句「（还没实现）」是 \#77 的，没动。
  > 
  > 套件 test\_client\_attempt\_fence.mjs 用 \#78 的 client\_harness 直接驱动工厂闭包里的
  > 写队列与栅栏：串行与版本接力、旧回执不许盖新作答、冲突重读与只重来一次、网络断了
  > 也是给学生的一句话、自评走同一条路、界面文案不再说「只在内存里」。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/72-next ([e84b428](https://github.com/Miaotofu01/Study-Mate/commit/e84b4286e269032d49673bd7ff2cb5da4c69266f))
- merge(阅读端): token 纪律、无障碍、首次引导与浏览器 QA（\#75） ([55830e1](https://github.com/Miaotofu01/Study-Mate/commit/55830e176e3352d5956470d11816f300d26a500f))

  > - 0da38e5 test(浏览器QA): 抽出共用 CDP 骨架 scripts/tests/browser/harness.mjs（探测浏览器
  >   二进制，不再钉死 google-chrome），四个既有浏览器脚本改为走它。
  > - 9c88fc8 feat(阅读端): token 对比度达 WCAG AA（亮暗两套）、动效四档与
  >   prefers-reduced-motion、路线图无障碍兜底（aria-label + 视觉隐藏表格）、首次引导几何。
  > - 5a6c2ee test(阅读端契约): 对比度进默认门禁（test\_client\_tokens.mjs / test\_client\_pure.mjs，
  >   node:vm 里跑真 lib/client.js）。
  > - 80ba6af test(阅读端QA): 新增浏览器用例 browser/reading\_test.mjs（把真 lib/client.js
  >   挂进夹具页，走主页→科目页→课件页）。
  > - d2c7741 chore(原型): 删掉一次性原型目录 prototype/（59 个文件）。
  > - 901fc77 merge: 合入集成分支（\#78 路线图与搜索、\#69 架构边界）。
  > 
  > 冲突解决：scripts/tests/README.md 两条命令行两边都改过——\`test:browser\` 取本分支的
  > 「四套真实浏览器渲染测试（含阅读端），浏览器二进制自动探测」，\`test:dsh\` 保留 \#70 加的
  > 引擎路径那半句，两边都留。package.json / checks.mjs / .gitignore 自动合并（\#70 的
  > \`type: module\` 与 .cjs 改名保留，\#75 删掉两条 prototype 脚本、加 .shots/、登记新套件）。
  > 
  > 验收：\`npm test\` 全绿，套件覆盖行 \`69 个文件全部有归属（当前组 core：18 个 Python +
  > 2 个 Node + 27 个 --test）\`；\`--static\` 组 5 Python + 3 --test。

- refactor(题目规范): 四层与题型换到目标态，课型不再限层级（\#81） ([0b8519e](https://github.com/Miaotofu01/Study-Mate/commit/0b8519ef4bc2f1d4faef19e5f2547ba1acd4c72a))

  > \`layered-practice\` 的旧词表（L1 理解/L2 改造/L3 排错/L4 应用 + 选择题/开放题/实操题/
  > 评估题）与目标态规格 §7.1/§7.2 分叉，\`evidence-check\` 又缺证据资格与分母口径——
  > 模型照着写就会产出 schema 不认的层级、或在范围为空时显示「通过」。
  > 
  > - 四层改成 读懂/改对/查错/造出，通过标准逐字取 \`lib/core/rules.ts\` 的 \`LAYER\_RULES\`
  > - 四种题型改成 客观题/预测验证/开放题/交付物，字段逐字取 \`QUESTION\_KIND\_SHAPES\`
  > - 删掉「课型限层级」与「止于 L3」：深度由节点 \`objective\` 决定，课型只决定产不产 lab
  > - 阶段评估已删（ADR-0006）：不再有跨节点综合测验，题只服务本节点
  > - \`evidence-check\` 收窄到只服务实验课验收，并叠加证据资格政策：延迟重测才算独立证据、
  >   逐条列出不能算独立证据的四样（自评/同日重试/关键词标签/仅浏览过）、分母口径是
  >   全部必需核心点且范围为空时绝不显示「通过」、结论写进 learning-records/ 而不是
  >   assessments/、模型输出不能直接改进度状态
  > - 瘦身：题面排版（数学式/换行/围栏/行长）、lab 目录布局、\`:::\` 语法与 empty\_reason
  >   的写法都指向唯一出处（quiz.js 契约、课件内容格式、文件归属），技能不再抄第二份

- refactor(角色): 五个角色去掉环境准备自述，调用面收到原生工具（\#81） ([1c34c0b](https://github.com/Miaotofu01/Study-Mate/commit/1c34c0b0bc6e4b72685e643c72aae1dc87581b54))

  > 规格 §9.1 要求清洗掉一切「环境准备」的自述，§9.3 要求参数/路径/命令/格式从技能里
  > 消失。角色照旧文写就会去探测本机工具、装依赖、跑引擎脚本，而 DSH 侧这些都不该由
  > 角色做——原生工具（\#68）才是调用面。
  > 
  > - resource-scout：删「转换工具由总控准备/你不建也不改环境/要工具就报总控，别自己装」
  >   （:19、:33 两句），转换仍只派一次活；转不动改成报告卡在哪
  > - image-scout：删本机探测（curl/wget 只在探测到本机有时才用）与「不装图像库」，
  >   自检从 \`python3 check\_pool.py\` 改成 \`studymate\_validate\_pool\`
  > - curriculum-designer：\`kind\` 不再限题目层级（指向 layered-practice 第四节），
  >   校验从 \`python3 check\_curriculum.py\` 改成 \`studymate\_validate\_curriculum\`，
  >   去掉 mastery 与旧档位词（已学完/学习中），暂存路径模板指向交接协议
  > - learning-coach：自检改成 \`studymate\_validate\_lesson\`；删「matplotlib 默认字体」
  >   这类环境细节；「渲染器负责的部分」清零——页面由阅读端产出，只留「内容文件里
  >   只有内容格式」这条判据
  > - practice-evaluator：时机二从「阶段评估」收窄成「只在 kind: 实验 的课」的实验课
  >   验收；删 \`assessments/\` 撰写与「建议掌握度」；结论写进学习记录
  > - 文件归属：出题评估的职责行改成「出题、判分、实验课验收（结论写进学习记录）」

- fix(宿主适配): 无头宿主把原生工具名翻回引擎命令（\#81） ([b969cb0](https://github.com/Miaotofu01/Study-Mate/commit/b969cb01cc97aceb18709a9c6bb41f6ade1fcc13))

  > 技能正文的调用面改成 \`studymate\_\*\`（DSH 的原生工具）之后，Codex/OpenAI 与
  > Antigravity 的导出件里就留下了宿主没有的工具名——照做会在那一步失败，而门禁全绿。
  > 两个适配层各加一张「原生工具 → 等价命令」映射表，导出时逐名替换；命令故意写成
  > 脚本路径不带引号的 \`python3 -B &lt;root&gt;/scripts/x.py\`，让下面那段通用 python 规整
  > 认得出来（顺序不能反，反了就静默跳过、留下跑不动的调用）。
  > 
  > - openai-skill-compat / antigravity-skill-compat：NATIVE\_TOOL\_FALLBACK + 替换
  > - antigravity 的角色提示同步到新词表：四层改读懂/改对/查错/造出、删阶段评估记录、
  >   image-scout 的索引落点改回「写盘即交付」（原先写在暂存 deliver/，与源技能不一致）

- test(技能): 调用面与注册表对账，断言跟着新词表改（\#81） ([b965585](https://github.com/Miaotofu01/Study-Mate/commit/b9655853d5494c30f6b966f85f80d67d33264646))

  > 断言钉的是旧词表与旧规则，改词表就得改断言——但保持每条断言的意图：
  > 
  > - 四层四条（L1 理解…）换成四条新层名 + 三条通过标准逐条钉住
  > - 阶段评估的题量/时长上限（最多 2 题、≤5 分钟、每题 3 小问）随阶段评估一起删；
  >   「只问理解与权衡、不问机械回忆」这两条判据保留、改成对所有题型生效
  > - 题面排版七条（行长/换行/围栏/对齐/选项不换行）并成一条「指向 quiz.js 契约」——
  >   意图是「排版规则有唯一出处」，不是「技能里抄一份」
  > - 渲染器七条并成两条：页面归阅读端产出、认不出的写法带行号拦下
  > - resource-scout 的两条环境自述断言（你不建也不改环境/转换工具由总控准备）删掉——
  >   它们守的正是 \#81 要清洗的那句话；换成正向的「转不动就报卡在哪」
  > - 调用面守卫从「引擎脚本 ≥5 处」改成「脚本 + 原生工具名合计 ≥5 处」：DSH 走工具、
  >   无头宿主走脚本，两种写法都不该被清空（单看脚本，清洗完就会空转）
  > - 新增 test\_skill\_tool\_refs.mjs（登记进 --static 组）：技能点名的每个 \`studymate\_\*\`
  >   必须在 STUDY\_TOOL\_NAMES 里；两个宿主的导出件里不许留原生工具名、必须有等价脚本；
  >   \#81 管的七份技能不写引擎命令、也不再出现旧六档与旧四层名

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/81-skills-teaching ([c0df96d](https://github.com/Miaotofu01/Study-Mate/commit/c0df96d1a9a3480be9c47ae9fe34d917b060446f))
- merge(阅读端): 课件页阅读位置三级恢复（\#76） ([ed9de91](https://github.com/Miaotofu01/Study-Mate/commit/ed9de9129c502d5b818eb481e732a5d85424622b))

  > - fd795c8 feat(阅读端): 课件页阅读位置三级恢复——section → offset → progress 逐级降级
  >   （对齐 F4 / 规格 §4.4），正文改过、锚点漂了也跟得住，而不是直接回到顶部；内核是
  >   lib/client.js 里的纯函数（切源码标记求值），钩子负责捕获与恢复。
  > - 98d4d69 test(阅读端): 两套验收——test\_client\_reading\_position.mjs（默认门禁，无须浏览器）
  >   与 browser/reading\_position\_test.mjs（真 Chrome 里挂真 lib/client.js，CDP 点真按钮、
  >   滚真滚动区；夹具 fixtures/reading\_position\_fixture.mjs）。
  > - 1c00a2a / acc9860 merge：把集成分支的工具域与跨科目搜索（\#68/\#78）与架构边界（\#69）合进来。
  > - c2b4914 docs(测试): 浏览器套件表登记阅读位置那一套。
  > 
  > 冲突解决（两边都留，均为「两张 ticket 往同一张登记表/表格各加一行」）：
  > 
  > - scripts/release/checks.mjs：core 组同时登记 \#75 的 test\_client\_tokens.mjs /
  >   test\_client\_pure.mjs 与 \#76 的 test\_client\_reading\_position.mjs；\`--browser\` 组的 node
  >   列表同时保留 \#75 的 browser/reading\_test.mjs 与 \#76 的 browser/reading\_position\_test.mjs。
  > - scripts/tests/README.md：浏览器套件表同时保留 \#75 那版（三个旧静态模板套件 + reading\_test
  >   描述 + 手动工具标「（手动）」）与 \#76 新加的 reading\_position\_test.mjs 行；顺带把「四套断言套件」
  >   改成「五套」（两边各加一套之后的机械结果）。
  > - lib/client.js \*\*自动合并\*\*（\#75 改 token/动效/引导几何，与 \#76 的阅读位置内核不重叠）；
  >   合并后核对两边特征都在（prefers-reduced-motion / color-mix 计数正常，
  >   阅读位置纯函数内核 readingPositionOf / readingPositionSettled 与说明都在）。
  > 
  > 验收：\`npm test\` 全绿，套件覆盖行 \`71 个文件全部有归属（当前组 core：18 个 Python +
  > 2 个 Node + 28 个 --test）\`；\`--static\` 组 5 Python + 3 --test。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/72-next ([aaf286d](https://github.com/Miaotofu01/Study-Mate/commit/aaf286d7ee26749fd0667420b8e143a78c8a1b22))

  > \# Conflicts:
  > \#	lib/client.js

- test(技能): 词表也逐字对账，套件改名成技能契约（\#81） ([978b194](https://github.com/Miaotofu01/Study-Mate/commit/978b194df8146e25d2de5223b4317f1c126fccdb))

  > 上一版只把\*\*调用面\*\*与代码对上；这张 ticket 的另一半验收是「四层与四种题型齐全，
  > 且与代码里的词表逐字对齐」——那件事只有断言能守住，所以并入同一条套件。
  > 
  > - 套件改名 test\_skill\_refs → test\_skill\_contracts（正文 ↔ 代码对账，范围比工具名大）
  > - 新增：layered-practice 的四层（含义 + 通过标准）与四种题型（服务哪一层 + 必备字段）
  >   必须与 lib/core/rules.ts 的 LAYERS/LAYER\_RULES/QUESTION\_KINDS/QUESTION\_KIND\_SHAPES/
  >   QUESTION\_RULES 逐字一致，并顺带断言 question.schema.json 的 kind.enum 没分叉
  > - 新增：evidence-check 的可信度排序与排除清单必须与 EVIDENCE\_BY\_TRUST /
  >   NON\_INDEPENDENT\_EVIDENCE 逐条一致
  > - README 的那一节跟着写成「技能正文与代码对账」三类

- test(任务域): 等待上限那条按取整抖动改成确定判据 ([67ef81e](https://github.com/Miaotofu01/Study-Mate/commit/67ef81e4bd03610667f183afaf76957d93e5c7f8))

  > 原来断言 \`timedOut.waitedMs &gt;= 40\` 是\*\*假红源\*\*：\`waitedMs\` 是 \`Date.now()\` 的差值，而唤醒
  > 来自 \`setTimeout\`——两个时钟各自按毫秒取整，天然有 ±1ms 抖动，实测 39ms 就会被判失败。
  > 这不是「机器慢」，是判据本身不确定：同一棵树上连跑 60 次，失败 14 次（约 23%），
  > 把 \`npm test\` 拖成一半概率假红，还会掩盖真问题。
  > 
  > 修法是\*\*把判据做成确定的\*\*，不是把阈值调松（40 改 38 只是把假红概率变小，抖动还在）：
  > 
  > - 用 \`t.mock.timers.enable({ apis: \['setTimeout', 'Date'\] })\` 把 timer 与时钟一起换成受控的，
  >   \`waitedMs\` 于是由 \`tick\` 的步长构造出来——预算走多少、它就恰好是多少。
  > - 断言随之收紧成\*\*恰好等满预算\*\*：\`assert.equal(timedOut.waitedMs, WAIT\_BUDGET\_MS)\`，
  >   一条同时钉住两头——不早醒（早醒＝根本没等，\`settled/timedOut\` 那两条也还在），
  >   也不多等（多等＝吊死）。预算提成具名常量 \`WAIT\_BUDGET\_MS\`。
  > - 后半段（\`hold.open()\` 之后那次等待）\`t.mock.timers.reset()\` 回到真时钟：那里的
  >   「不会吊死」要在真实时间上验，2000ms 的超时兜底照旧——真吊死会直接失败，不会静默挂住。
  > 
  > 意图全在：等满预算 / 超时后有可行的下一步提示（继续等、不阻塞地看、取消三条路）/
  > 超时 ≠ 取消（任务照旧「运行」）/ 上界是硬约束（\`MAX\_WAIT\_MS + 1\` 直接拒）。
  > 
  > 验收：该套件连跑 60 次 \*\*0 失败\*\*（修前同法 60 次失败 14 次）；\`npm test\` 连跑 3 次全绿，
  > 套件覆盖行同前（71 个文件全部有归属，core：18 Python + 2 Node + 28 --test）。
  > 
  > 台账：\#73 的任务域用例；本提交只动测试，不动 lib/tasks/\*\*。

- feat(问答域): 面板那条路由独立调模型，上下文只带三样（\#79） ([bf96faf](https://github.com/Miaotofu01/Study-Mate/commit/bf96faff7f7b9e95f69fe67a52e8aeaac98c8dc7))

  > 目标态规格 §7.4：阅读端选中正文 → 面板就地打开 → \*\*面板独立调模型回答\*\*，不经过总控；
  > 上下文只带当前课件、选中文本、共享记忆，不背整个会话；回答无痕，但写一条误解记录。
  > 
  > - \`POST /api/studymate/ask\`（\`lib/ask/route.ts\`，注册点在 bin/dsh-plugin.ts 加一行）：
  >   读工作区 → 组装请求体 → 调一次 \`ctx.llm.stream()\` → 追加误解记录。
  > - \`lib/core/ask.ts\`：请求体组装与回答拆分。三样上下文只出现在 \`messages\[0\]\` 里，
  >   逐段带小标题；\`system\` 是角色与格式（每个请求都一样，不含学生数据）；\*\*不盖 sessionId\*\*
  >   ——那是会话请求的路由戳，面板是一次性调用，不盖它就没有「回答进会话记录」这条缝。
  > - \`lib/misconceptions.ts\`：误解记录落 \`misconceptions.yaml\`（单一落点）。\*\*只追加不重写\*\*，
  >   旧字段与文件头注释原样留着；幂等与版本号沿用 \`lib/core/fence.ts\` 那一套判据。
  >   写进去的 \`evidence\` = 提问原文 + 回答摘要 + 位置。
  > - 能力探测的判据上移到 \`lib/core/model.ts\`：工具域（\`requires:\['model'\]\`）与问答域共用
  >   同一份 \`{available, reason}\`。域规则表里子系统不许 import 工具域，两份探测会漂成两个
  >   reason 文案——\`lib/tools/capability.ts\` 只留转发面，别的文件一个 import 都没改。
  > 
  > 为什么没有可用模型时\*\*不写\*\*误解记录：没有回答就没有「回答摘要」，写一条空壳进学生的档案
  > 比不写更糟。报告里记了这处判断。

- feat(阅读端): 问答面板接上真调用，假回答与「尚未接模型」一起删掉（\#79） ([aef7a68](https://github.com/Miaotofu01/Study-Mate/commit/aef7a684ba84e9b737f61fe968711d85ee2f6fca))

  > 面板原来是 \`setTimeout(240ms)\` + 一段硬编码的假回答，徽标写着「尚未接模型」，界面上还
  > 承诺「会记一条误解记录…总控下次开场读得到」——那条记录当时并没有写。
  > 
  > - \`AskPanel\` 改成 \`POST /api/studymate/ask\`：带 subject / node / selection / question /
  >   operationId / expectedVersion，\*\*不带任何会话\*\*。回答、用的模型、那条误解记录都按回执渲染；
  >   写盘失败与「没答上来」分开报（回答不跟着丢）。
  > - 没有可用模型时如实说明（\`available:false\` + reason），并明说「这一问没有回答，也就没有
  >   写误解记录」——不假装会答。
  > - 面板的提示语补一句「回答不进会话记录」。
  > - 套件三条：请求体形状（纯函数域）、Host 半链路（注入假 llm，\*\*不花额度\*\*）、面板那条 POST
  >   （fetch 是假货）。夹具补 \`findByProp\`：桩造的元素树子节点在 \`props.children\`，只走
  >   \`node.children\` 会漏掉深层节点，看起来像「面板没渲染」。
  > - 架构边界表登记 \`ask\` 域（只依赖 core 与 lib：能力探测的本体在纯函数域，不走反向边）。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/79-qa-panel ([7ad27d5](https://github.com/Miaotofu01/Study-Mate/commit/7ad27d538a519ac84944a23571503fcd7d94ae7c))
- docs(问答域): 把超时常量的注释写回它自己的意思（\#79） ([4a57f40](https://github.com/Miaotofu01/Study-Mate/commit/4a57f4005d514c65242333113e4a312eac1621a7))

  > 那条注释是「一条 user 消息拼出来的文本上限」，但常量名与用途都是超时——上一条提交里
  > 抄错了行。运行期一字未改。

- test(阅读端QA): 真浏览器里把作答落盘走一遍（\#72） ([ac7d692](https://github.com/Miaotofu01/Study-Mate/commit/ac7d692d8ac5337c1a1c0ab8998b4149737df6dd))

  > \#75 的浏览器骨架（harness.mjs + mini-react 夹具）落地之后，这条验收终于能在真浏览器里
  > 跑完：真的 lib/client.js（无打包那份）→ 真的 HTTP → 真的 Host 半路由 → 真的工作区文件。
  > 
  > 三个场景对着 \#72 的验收标准：
  >   · attempts-write    点选项 → 只发一笔 POST、回执覆盖到界面、「已记进作答数据」、
  >                       磁盘上那一条的形状、题库文件没被碰过；
  >   · attempts-reload   \*\*真的重新导航一次\*\*（= 刷新页面）→「上次选了 A，对了」与
  >                       「作答 1 / 2」都来自 attempts/，且刷新本身不发写请求；
  >   · attempts-conflict 另一个写入者（模型那侧直接用数据层）改过之后再作答 → 第一笔 409
  >                       拒绝 → 客户端按回执里的版本号重来一次 → 界面如实说、谁的记录都没丢。
  > 
  > 夹具边界（写在套件头里）：mini-react 每次重画整树重建，LessonPage 的 ResizeObserver
  > effect 闭住的是重建前那个节点 → 回调读到 0 宽 → 两条栏永远收起、右栏的题点不到。
  > 套件把那一个观察者换成不回调的空实现（effect 里那次 measure() 仍量到真布局 1440），
  > 被测的作答路径一条不少。\#75 的 reading\_test.mjs 里有同一处边界的记载（路线图 draw() 量到旧节点）。
  > 
  > 登记进 checks.mjs 的 --browser 组（不登记会被套件覆盖断言以退出码 2 拦下）。

- fix(阅读端): 面板不再带 expectedVersion——快照里的版本号只会把这一笔挡掉（\#79） ([cf9643b](https://github.com/Miaotofu01/Study-Mate/commit/cf9643b15ad551e37be4da03cb78bbfa5970e990))

  > \`subject.misconception\_version\` 在 payload 里根本不存在（\`lib/library.ts\` 只给
  > \`misconceptions\` / \`misconception\_library\` / \`misconception\_issues\`），所以那行是死代码；
  > 就算补进 payload，它也是页面打开时读到的旧值，而 \`misconceptions.yaml\` 是总控/讲解角色随时会
  > 追加的文件——带上旧版本号只会在别人刚写过之后把面板这一笔挡成 409。
  > 
  > 这份文件的口径本来就是「只追加」，追加不覆盖任何人的改动，所以面板\*\*不校验版本\*\*；
  > 服务端仍保留这个可选参数（测试里用得上，也留给以后确实要改旧内容的调用方）。
  > 套件同步改成断言「请求体里没有 expectedVersion」。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/72-next ([9174dc0](https://github.com/Miaotofu01/Study-Mate/commit/9174dc0c46995ff710afb5b75c6d4b3e304eb5f2))

  > \# Conflicts:
  > \#	scripts/release/checks.mjs

- merge(技能): 教学协议与五角色清洗（\#81） ([ff370ff](https://github.com/Miaotofu01/Study-Mate/commit/ff370ff3aa392b59ebb56d2d85ba74016e2e652c))

  > 把 ticket/81-skills-teaching（978b194）合进集成分支。合并入 6 个提交：
  > 四层与题型换目标态（0b8519e）、五角色去环境自述（1c34c0b）、无头宿主适配层
  > 把原生工具名翻回脚本命令（b969cb0）、调用面与注册表对账（b965585）、
  > 词表逐字对账并把套件改名成技能契约（978b194）、以及一次回合同步（c0df96d）。
  > 
  > 这张 ticket 干了什么：
  > - layered-practice：四层换成读懂/改对/查错/造出，四种题型跟着换；取消评估题；
  >   课型不再限层级（深度由节点 objective 决定，课型只决定产不产 lab 材料）。
  > - evidence-check：收窄成只服务实验课验收，叠加证据资格政策（延迟重测才算独立
  >   证据；自评／同日重试／关键词标签／仅浏览过不算独立证据），分母口径写明，
  >   范围为空时绝不显示「通过」；结论写进 learning-records/，assessments/ 不再产生新文件。
  > - 五角色（资料收集／采图／课设／讲解／出题评估）名字不变，去掉一切「环境准备」
  >   自述，调用面统一收到 DSH 原生工具名。
  > - 无头宿主适配层（bin/openai-skill-compat.mjs、bin/antigravity-skill-compat.mjs）
  >   加 NATIVE\_TOOL\_FALLBACK：导出时把 studymate\_\* 逐名翻译成宿主跑得动的
  >   python3 -B 命令，导出件里不留悬空引用。
  > - 新增 scripts/tests/test\_skill\_contracts.mjs（由 test\_skill\_tool\_refs.mjs 改名并扩范围），
  >   登记进 checks.mjs 的 --static 组，README 加一节「技能正文与代码对账」。
  > 
  > 冲突：三个预期冲突（checks.mjs 的 --static 组、scripts/tests/README.md、
  > docs/规范/文件归属.md）都是「两边各加一行」，git 自动合并成功，逐处比对确认两边
  > 内容都在。test\_skill\_rules.py 按预期不冲突：集成分支自 merge-base 起没动过它，
  > 合并后断言 528 → 525 条（与 \#81 自报一致），且无 \#80 痕迹。
  > 顺手修一处笔误：三处注释仍指向改名前的 scripts/tests/test\_skill\_tool\_refs.mjs，
  > 改成 test\_skill\_contracts.mjs（只动注释）。
  > 
  > 验收怎么验的（全在合并后的树上跑）：
  > - npm test：全绿。门禁自报两条套件覆盖行均为「72 个文件全部有归属」
  >   （core：18 Python + 2 Node + 28 --test；--static：5 Python + 0 Node + 4 --test）。
  > - node scripts/tests/test\_skill\_contracts.mjs：8/8 通过。
  > - python3 scripts/check\_skill.py .dsh/skills/\*/：12 份全 OK。
  > - STUDYMATE\_DSH\_PACKAGE=&lt;dsh&gt; npm run test:dsh：6/6 通过。
  > - grep -rn "课型限层级\\|评估题" .dsh/skills/layered-practice/SKILL.md：0 命中。

- feat(监听域): 学习工作区一变就推变更通知，阅读端未变即同引用（\#74） ([0542add](https://github.com/Miaotofu01/Study-Mate/commit/0542add14907fddf9c60e6466223ed0dd1ed0383))

  > Host 半此前是「每次请求现读、不缓存也不推送」，所以盘上改了什么、外层新建了
  > 科目，打开的页面都看不见——只能手动刷新。这条把它接成推送：
  > 
  > · 监听（lib/watch/tree.ts）：优先 \`ctx.fs.watch\`（宿主能力，dsh-fs-local 走
  >   chokidar）；拿不到或试挂失败就退 Node \`fs.watch\`。两种原语都只报「某个目录的直接
  >   子项变了」，而工作区是四层深，所以自己维护一个目录集合：每次变更后重扫、
  >   给新目录补观察者（新建科目就是靠这一步被看见的）。读盘失败、单个目录挂不上、
  >   观察者报 error 都只记一句，不影响别的目录，也不许把异常扔回 fs 回调。
  >   Node 那条用 persistent:false——监听不是进程的存活理由，别让宿主退不出去。
  > 
  > · 推送（lib/watch/channel.ts）：先试 \`connection.fetch.register\` 返回一个 body
  >   没写完的 \`Response\`（载体的 bridge 是「先 writeHead 再逐块 write body」，
  >   所以它天然就是一条 SSE），顺带白拿 /api 的围栏与会话认证；不行再退
  >   \`ctx.webServer.register\` 的 exact 路由，那条不在围栏里，认证自己用
  >   \`connection.requestRejection\` 判。推的是 \`{kind:'changed',domains,at,seq}\`，
  >   不是整份数据。
  > 
  > · 阅读端（lib/client.js，只动数据获取与状态更新这一块）：收到通知静默重取，
  >   但\*\*逐层沿用没变的引用\*\*——顶层键一样就沿用上一轮的对象，subjects 再按 slug
  >   比一层。此前 \`setState({data})\` 整份替换会把所有 useMemo 视图击穿，
  >   改一个课件文件整页重算。
  > 
  > 注册各一行：\`lib/tools/index.ts\` 的 \`registerStudyMate\` 清单加 \`registerWatch(ctx)\`，
  > \`bin/dsh-plugin.ts\` 的 connection 清单加推送路由。真 DSH 探针（临时 HOME、随机端口、
  > 不调模型）里两条推送路各验一次，并实测「改课件 → 收到通知」「新建科目 → 收到通知」。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/72-next ([b6a8bfc](https://github.com/Miaotofu01/Study-Mate/commit/b6a8bfcfab57f108cfb7ae8626613f7e7eaf0d14))
- refactor(总控): 机械步骤归原生工具，删掉暂存模式与渲染/主页/摘要三步（\#80） ([c9d88fb](https://github.com/Miaotofu01/Study-Mate/commit/c9d88fb8c61a39c8617ab6463b9315c7e7a64178))

  > 总控与档案的靶子（issue \#80 / 目标态规格 §6.2、§9、ADR-0008）：
  > 
  > - \*\*开场只调一次 \`studymate\_workspace\_context\`\*\*：不再自己读配置、进度、记忆、大纲；
  >   工具的参数表、返回形状、域声明、错误形状与旧命令对照搬进新参考文档
  >   \`.dsh/skills/learning-system/references/tools.md\`（按需取，不进常驻上下文）。
  > - \*\*删掉暂存模式\*\*：不建临时工作区、不问落点、不写 \`prefs.md\`、不 \`cp -a\` 搬运；
  >   学习数据直接写配置里的工作区（\`.studymate-stage\` 在技能里归零）。
  > - \*\*删掉三个机械步骤\*\*：\`render\_lesson.py\` 渲染、\`gen\_home.py\` 刷新主页、派工前算 \`md5\`
  >   （页面由阅读端实时渲染，判分与作答也在那边；产物有没有被改动由交接门禁按盘上字节复算）。
  > - \*\*\`record-keeping\` 改写\*\*：三档进度、误解记录单一落点（字段按 \`misconceptions.schema.json\`
  >   归一）、\`sessions/\` 与 \`assessments/\` 退役、作答数据只读视角、\`reference/\` 阅读端可写
  >   （ADR-0010）、课件两份产物（不再有「课件页面」）。
  > - \*\*\`local-qa\` 改写\*\*：问答面板就地独立调模型（不经过总控），答完只留一条误解记录；
  >   面板不可用时总控按同一套规则就地答。
  > - \*\*技能瘦身\*\*：参数、路径、命令、格式从正文消失（进工具契约或 schema）；三份常驻正文
  >   18300 → 13963 字符，工具契约 7925 字符改为按需取。技能正文里 \`.py\`/\`python3\`/
  >   \`exit code\`/\`cp -a\`/\`md5\`/\`.studymate-stage\` 全部 0 命中，\`.stage\` 只剩产物交接语义。
  > 
  > 无头宿主（Antigravity / Codex）没有原生工具：两个适配器注入「原生工具（DSH 专属）在本宿主
  > 不存在」的降级表（工具 → 脚本命令），并把总控开场、会话结束、节点收尾、工作区来源这几段
  > 换成各自的宿主口径；暂存模式的文案与 \`md5\` 改写一并删除。
  > 
  > 跟着改的断言（保持意图、不放宽）：\`test\_skill\_rules.py\` 的规则表与脚本调用守卫（非空转判据
  > 改成合成反证）、两个宿主套件的锚点与降级表形状、\`test\_installer.mjs\` 的暂存根断言改成
  > 「不该再有工作区暂存根」。docs/规范 三份（文件归属、工程约束、Agent交接协议）跟上删除与工具化。

- merge(监听域): 合入集成分支，接上 \#69 的域规则表与 \#73/\#75 的阅读端改动（\#74） ([1d19898](https://github.com/Miaotofu01/Study-Mate/commit/1d198987634c8e039c84c09d9e89b1d0847f106e))

  > 冲突三处，两边都留：
  > · lib/tools/index.ts —— \#73 的 registerTaskTools 与 \#74 的 registerWatch 各占一行；
  > · scripts/release/checks.mjs —— 两边的套件各自登记进 core 组；
  > · scripts/tests/test\_tools\_guard.mjs —— \#73 与 \#74 都往注册点加了子系统级 effect，
  >   这条断言改成「数工具的那几个 + 列清楚非工具的两条」。
  > 
  > 顺带（合入后必须做的两件收尾）：
  > · \#69 的域规则表里 \`tools\` 加一个 \`watch\`（表里原本就写着「\#74 落地时这里加一个域名」），
  >   否则 tools → watch 这条边会被判越界；
  > · 阅读端的内部件钩子（\#78 建的那条 \`\_\_studymate\_client\_internals\`）里加上
  >   \`mergeLibraryData\` / \`useLibrary\`——同引用与推送的断言要跑真的那一份，
  >   不另开第二个 QA 缝。
  > 
  > 另加一套\*\*真浏览器\*\*端到端（--browser 组）：改盘上的文件 → 监听 → SSE → 页面自己更新，
  > 不刷新。它补的是「浏览器的 EventSource ↔ 我们那条流式 Response」这一段——Node 套件与
  > 真 DSH 探针各自只盖到一半。

- merge(作答): 阅读端作答落盘到 Host 半（\#72） ([a2c895e](https://github.com/Miaotofu01/Study-Mate/commit/a2c895ee19a547069b618aa59b592764b9381101))

  > 把 ticket/72-next 并入集成分支。这张 ticket 让阅读端的作答真的落到工作区文件：
  > 
  > - lib/attempts-route.ts（新）：POST /api/studymate/attempts 的路由注册、请求体校验、
  >   状态码映射（坏请求 400 且不写盘、没配工作区 500 带自救提示）、版本栅栏与冲突拒绝；
  >   题库与课件正文逐字节不变（作答绝不写回题库）。
  > - bin/dsh-plugin.ts（+1 行）：在 ctx.inject(\['connection'\], cb) 块里挂一行路由注册，
  >   路径/方法/请求体/状态码映射都留在 lib/attempts-route.ts。
  > - lib/client.js：作答落盘的写队列 + 合并轮询 + 陈旧响应围栏（旧读数/在飞写入不许覆盖
  >   新作答）、版本冲突的重读与重来一次、自评走同一条路，界面文案不再说「只在内存里作答」。
  > - checks.mjs：core 组登记 test\_host\_attempts\_route.mjs、test\_client\_attempt\_fence.mjs，
  >   --browser 组登记 browser/attempts\_test.mjs。
  > 
  > 验收：主检出 npm test 全绿（exit 0）；门禁自报「套件覆盖：75 个文件全部有归属
  > （当前组 core：18 个 Python + 2 个 Node + 30 个 --test）」；node --check lib/client.js 通过；
  > 两张新 Node 套件单跑 exit 0。--browser 那条（真 Chrome 里把作答落盘走一遍）留到两张
  > ticket 都合完后统一跑 npm run test:browser。
  > 
  > 试合无冲突（自动合并）。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/80-skills-core ([266a420](https://github.com/Miaotofu01/Study-Mate/commit/266a4206f62e5edd6532a4aa958202c3bd88bed1))

  > \# Conflicts:
  > \#	docs/规范/文件归属.md
  > \#	scripts/tests/test\_skill\_rules.py

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/79-qa-panel ([1ea8a87](https://github.com/Miaotofu01/Study-Mate/commit/1ea8a87d084fd6fc7a5a5ccd8f450a4c3021c2bd))

  > 把集成分支（含 \#81、\#72）并回本分支，为合入做准备。三处冲突，全部「两边都留」：
  > 
  > - bin/dsh-plugin.ts：两张各加一行路由注册，都在 ctx.inject(\['connection'\], cb) 块里。
  >   保留两行（作答数据 \#72 在前，问答面板 \#79 在后）。
  > - lib/client.js：三处。
  >   · 头部注释：取 \#72 那版（lib/library.ts / bin/dsh-plugin.ts 是当前文件名，且
  >     「作答只存在内存里」已被 \#72 证伪），再补回 \#79 的问答面板那一段；
  >   · 端点常量：ATTEMPTS\_ENDPOINT 与 ASK\_ENDPOINT 两个都留；
  >   · TEST\_HOOK 内部件导出：两张各加一组，\#72 的作答栅栏/写队列与 \#79 的 AskPanel 都留。
  > - scripts/release/checks.mjs：core 组两张各加了两条套件，两组都留。
  > 
  > 验证：解出来的 lib/client.js 相对集成分支的差异恰等于 \#79 自己的改动（74+/29-），
  > 相对 ticket/79 的差异恰等于 \#72 的改动（391+/38-）——两边一点没丢。
  > 本 worktree 里 npm test 全绿（exit 0），node --check lib/client.js 通过。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/80-skills-core ([0eaf08c](https://github.com/Miaotofu01/Study-Mate/commit/0eaf08c632a0cd7f8efa24d654a97bc244674e2f))
- merge(问答): 面板独立调模型并写一条误解记录（\#79） ([af63205](https://github.com/Miaotofu01/Study-Mate/commit/af63205d24702fc7806661ba4cff429e11d222df))

  > 把 ticket/79-qa-panel 并入集成分支（先在本分支 worktree 里把集成分支并回去解了冲突，
  > 故本次试合无冲突）。
  > 
  > 这张 ticket 让问答面板真的会答：
  > 
  > - lib/core/model.ts（新）：调模型的底座。
  > - lib/core/ask.ts（新）：问答的纯函数域——请求体只有三样（当前课件 / 选中文本 / 共享记忆），
  >   不背会话。
  > - lib/ask/\*\*（新）：POST /api/studymate/ask 的路由，独立调模型，不经过总控。
  > - lib/misconceptions.ts（新）：答完追加一条误解记录（字段定型见
  >   schemas/misconceptions.schema.json）。
  > - lib/tools/capability.ts：改成转发面。
  > - bin/dsh-plugin.ts（恰好一行）：在 ctx.inject(\['connection'\], cb) 块里挂一行路由注册。
  > - lib/client.js：问答面板接上真调用，删掉假回答与「尚未接模型」提示。
  > - scripts/tests/test\_architecture\_boundaries.mjs：域表登记 ask 域（bin 也放行）。
  > - scripts/tests/fixtures/client\_harness.mjs：夹具补上问答面板要的东西。
  > - checks.mjs：core 组登记 test\_core\_ask\_context.mjs、test\_client\_ask\_panel.mjs、
  >   test\_host\_ask\_route.mjs。
  > 
  > 冲突（在 worktree 的解冲突提交里）：bin/dsh-plugin.ts、lib/client.js（头部注释 /
  > 端点常量 / TEST\_HOOK 内部件导出三处）、checks.mjs —— 全部「两边都留」。
  > 
  > 验收：主检出 npm test 全绿（exit 0）；node --check lib/client.js 通过；门禁自报
  > 「套件覆盖：78 个文件全部有归属（当前组 core：18 个 Python + 2 个 Node + 33 个 --test）」。
  > 
  > \*\*诚实边界\*\*：问答路由这一半是用\*\*注入的假 llm\*\* 证明链路通的，门禁里不跑真模型调用
  > （要花额度），实施者也没有跑过真模型调用。这里不写成「已接真模型验证」。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/80-skills-core ([05dae2b](https://github.com/Miaotofu01/Study-Mate/commit/05dae2be043f4aa4ebfbd83ed3e7aa57759d56bb))
- refactor(技能): 合入问答面板与作答落盘后对齐 local-qa 与宿主约定（\#80） ([c417921](https://github.com/Miaotofu01/Study-Mate/commit/c41792181a6717b0158eb7737661d955433d9988))

  > - \`local-qa\` 补一句「答复格式与字数上限的唯一出处是面板自己的系统提示」：\#79 把 200 字与
  >   「先给答案再给一句为什么」落进了 \`lib/core/ask.ts\` 的系统提示（带测试），技能不再重抄第二份；
  >   规则表加一条守卫钉住这句指针。
  > - 两个宿主约定里「总控亲自答疑」的旧口径改成「阅读端问答面板就地答，面板不可用时总控按
  >   同一套规则答」；Antigravity 与 Codex 侧的「写会话摘要」改成「更新学习进度、误解记录与
  >   学习记录 + 交互断点」（会话摘要已退役）。

- merge(监听): 工作区变更推送与未变即同引用（\#74） ([a6d32c6](https://github.com/Miaotofu01/Study-Mate/commit/a6d32c6ffca09668f622d6f86b3431ae1449eda0))

  > 把 ticket/74-next 合进集成分支（分支 tip 1d19898，本提交两个父提交为 af63205 与 1d19898）。
  > 
  > 这张 ticket 干了什么：Host 半接上「工作区一变就推一条变更通知」——监听优先走宿主的
  > ctx.fs.watch，退 Node fs.watch，并自己维护目录集合（新建科目靠重扫补观察者才被看见）；
  > 推送先试 connection.fetch.register 返回一条流式 Response（SSE，顺带白拿 /api 围栏），
  > 退 ctx.webServer.register 的 exact 路由（认证自己用 requestRejection 判）；推的形状是
  > {kind:'changed',domains,at,seq}，不是整份数据。阅读端收到通知静默重取，但逐层沿用没变的
  > 引用（顶层键逐个比，subjects 再按 slug 比一层），不再整份替换状态、击穿 memo 视图。
  > 注册各一行：lib/tools/index.ts 的 registerStudyMate 加 registerWatch(ctx)，
  > bin/dsh-plugin.ts 的 connection 清单加推送路由。
  > 
  > 冲突四处，全是「两边都加了一行」，两边都留：
  > · bin/dsh-plugin.ts —— \#72 attempts / \#79 ask / \#74 watch 三条动态 import 各占一段；
  > · lib/client.js —— ① 三个端点常量（ATTEMPTS/ASK/EVENTS）；
  >   ② useLibrary 的读回调：\#72 的 readSeq 栅栏 + inFlight/trailing 合并轮询 + 静默失败保留画面，
  >      与 \#74 的 mergeLibraryData 合并，合成「合并后再落 readSeq、成功失败都 settle()」；
  >   ③ 内部件钩子导出：作答栅栏/写队列 + AskPanel/ASK\_ENDPOINT + mergeLibraryData/useLibrary；
  > · scripts/release/checks.mjs —— core 组两边各自登记的套件，--browser 组同样；
  > · scripts/tests/test\_architecture\_boundaries.mjs —— 域表：HEAD 的 ask（\#79）与 ticket 的
  >   watch（\#74，注释由「预留」改成已落地）各留一条；tools 那条 allow 里的 watch 由自动合并带入。
  > 
  > 验收怎么验的（主检出，合并后未提交时跑的）：
  > · npm test —— 全绿（exit 0）。门禁自报：套件覆盖：83 个文件全部有归属
  >   （当前组 core：18 个 Python + 2 个 Node + 37 个 --test）。
  > · node --check lib/client.js —— OK。
  > · STUDYMATE\_DSH\_PACKAGE=… npm run test:dsh —— 6/6 通过；其中「native entry keeps Web usable」
  >   里 \#74 的监听探针在真 DSH 里实测：backend=fs-service（走 ctx.fs.watch）、
  >   改课件与新建科目各收到一条通知、bridge 与 webServer 退路都通、退路无会话回 401。
  > · node --test scripts/tests/test\_watch\_client.mjs —— 3/3 通过（含「未变即同引用」与推送重取）。
  > · npm run test:browser —— \*\*未全绿（exit 1）\*\*：新增的 browser/watch\_push\_test.mjs 本身通过，
  >   但 lib/client.js 新加的「挂载即开 EventSource」把既有两套打红（reading 6 个场景 file:// CORS、
  >   attempts 3 个场景 404；断言 0 失败，问题出在夹具把控制台/失败请求算作场景问题）。
  >   在 ticket 分支自己的 worktree 上单跑 reading\_test.mjs 同样红 → 是这条分支自带的，
  >   不是解冲突解出来的。夹具侧待后续补（reading 夹具 stub 掉 window.EventSource、
  >   attempts 的 mini 宿主补一条 /api/studymate/events）。

- feat(导出): 静态页面降为导出能力，工作区导成能离线打开的自包含页面（\#82） ([31dde9b](https://github.com/Miaotofu01/Study-Mate/commit/31dde9b2d12282e5d6ac485ec181a8975f53b069))

  > 目标态规格 §8 / ADR-0005：静态页面不再是主体验，阅读端才是；导出是\*\*能力\*\*。
  > 
  > 路线（报告里写了理由）：\*\*不写第二个渲染器\*\*。导出把「阅读端本体 + 它的数据 + 一个最小宿主」
  > 装进一个目录——\`studymate-client.js\` 是 \`lib/client.js\` 的逐字节拷贝（哈希进产物清单），
  > vendor 下是 React 的 production CJS 构建（只包一层 module/exports/require/process，不动内容），
  > 页面在浏览器里用同一份渲染代码自渲染。为什么不「导出时算好静态标记」：那要么给 \`lib/client.js\`
  > 加导出、要么再搭一套 react-dom/server，既是第二条渲染路径，也碰 \`release.mjs\` 明文禁止的
  > 「对 client.js 做打包/改造」。
  > 
  > - \`lib/export/\*\*\` 新域：react（从哪找 React）、page（壳/宿主/挂载，纯字符串）、plan（算产物
  >   清单，不写盘）、run（落盘 + 进度 + 取消，取消说清保留了什么、入口最后写所以半成品一眼可见）、
  >   guard（泄漏守卫）、task（任务类型「导出」）、cli（无头入口）、index（目录出口）。
  > - \`studymate\_export\` 落地（替掉 \#68 的占位）：起一个 \`durable\` 的「导出」任务、\*\*有上限地等\*\*
  >   （30s，等到给文件清单，等不到给下一步），DSH 侧\*\*不主动导出\*\*——注册不触发任何导出。
  > - 无头侧 \`studymate export\`（bin/studymate.mjs 子命令）：\*\*没有参数也能跑\*\*，工作区按
  >   --workspace → $LEARN\_WORKSPACE → 配置 → 当前目录 定位，落点默认 \`&lt;工作区&gt;/export/\`。
  > - 泄漏守卫（F11）：产物里出现只有 Node 才有的东西就让构建失败；构建期入口
  >   \`scripts/release/export\_guard.mjs\`（\`npm run guard:export\`），发布构建在打包前跑一次。
  >   反证：\`--inject host.js\` 或往导出器里注入一个 Node 专用依赖，退出码 1。
  > 
  > 域图：tools → export（注册点那一行）、export → tasks（登记任务类型）；export 不 import tools
  > （会成环，架构边界表里同步记了一笔）。

- test(导出): 五套验收——产物形状、泄漏守卫反证、任务模型、无头 CLI、file:// 真渲染（\#82） ([b04a132](https://github.com/Miaotofu01/Study-Mate/commit/b04a13248afede8358a4aa802e659393183bb905))

  > - \`test\_export\_static\_page.mjs\`：清单齐全与脚本顺序、\`studymate-client.js\` 与仓库里那一份
  >   \*\*逐字节相同\*\*、页面里没有 ES 模块（file:// 下加载不了）、机器路径不进产物、
  >   取消说清保留了什么（已落成的保留、入口排在最后写）、落点判据。
  > - \`test\_export\_leak\_guard.mjs\`：规则逐条生效 + \*\*反证\*\*（注入 Node 专用依赖后构建期守卫必须
  >   失败：进程内与命令行各一条）、第三方包装/阅读端本体被改按哈希报出来、假阳性防线
  >   （\`data.js\` 载荷里的 require 调用是课件正文）。
  > - \`test\_export\_tool\_task.mjs\`：DSH 侧\*\*不主动导出\*\*（注册完没有任务、没有产物）、起 durable
  >   任务并返回文件清单、取消（排队中当场取消没有半成品；已完成则「取消来晚了」且产物保留）、
  >   越权句柄被拒。
  > - \`test\_export\_cli.mjs\`：真子进程跑 \`bin/studymate.mjs export\`——\`--json\`、\*\*没有参数也能跑\*\*、
  >   课完再导一份是幂等的、报错都是人话。
  > - \`browser/export\_file\_test.mjs\`（\`--browser\` 组）：导出的产物本身在 \`file://\` 下用真 Chrome +
  >   真 React 打开：样式、行内/块级公式、配图（naturalWidth &gt; 0）、代码块、题目与判分、
  >   参考资料只读；控制台/页面/失败请求干净。
  > - 三套新套件接进 \`checks.mjs\` 的 core 组，浏览器那套进 \`--browser\` 组；README 补齐说明。

- docs(导出): 无头侧「课完默认导一份」写进两份使用说明（\#82） ([7e1aded](https://github.com/Miaotofu01/Study-Mate/commit/7e1adede0eb5af37250da0d008db1c5650dca24a))

  > Antigravity / Codex·ChatGPT Work 没有阅读端，学生的阅读体验就是导出（ADR-0003）。
  > 两份说明里各加一节：命令没有参数也能跑、工作区怎么定位、产物落在哪、需要一份 React。
  > 同时记一笔现状：文档里那套「静态 HTML 课件 + 每科目组件副本」是随目标态重构退役的旧路径，
  > \#83 拆除时一并重写。

- test(浏览器QA): 夹具给阅读端那条推送通道一个正当落点 ([dda2b35](https://github.com/Miaotofu01/Study-Mate/commit/dda2b3505565e5d5fca6e389ccdd3d3c90eb3fa3))

  > \#74 让 lib/client.js 挂载即订阅 \`/api/studymate/events\`（变更推送）。这一条本身是对的，
  > 但两套\*\*既有\*\*浏览器套件的夹具没跟上，于是它们在「控制台/失败请求」那一项上被判红
  > （断言 0 失败，倒在 harness 的 \`failed || problems\` 上，整组 --browser 退出码 1）：
  > 
  > · reading\_test.mjs —— 夹具页走 file://，\`file:///api/studymate/events\` 必被 CORS 拦，6 个场景；
  > · attempts\_test.mjs —— 迷你宿主没这条路由，回 404，3 个场景。
  > 
  > 修法在夹具侧，\*\*没有动 lib/\*\*，也没有放宽 harness 的判据（「控制台错误/失败请求算问题」
  > 一个字没改）——红就是红，改的该是让客户端那条请求有正当落点，不是让判据闭嘴。
  > 
  > 两套为什么用两种修法，各自贴合自己要验的东西：
  > 
  > · reading\_test：夹具页是 file://，那条请求\*\*没有\*\*任何正当落点（生产里这条通道只在 /api
  >   同源下开），而这一套验的是阅读端静态面与主题对比度，推送不在验收面上。所以把
  >   \`window.EventSource\` 收成 undefined——lib/client.js 认这个早退
  >   （\`typeof EventSource !== 'function'\` 就不订阅，见那条 useEffect）。推送本身在
  >   watch\_push\_test.mjs（真 EventSource ↔ 流式 Response）与真 DSH 探针里验，两边各盖一半。
  > 
  > · attempts\_test：夹具是「真 HTTP 迷你宿主」，客户端发的每条请求都该有正当落点
  >   （同一个文件里给 /favicon.ico 补 204 就是这个理由），所以不 stub，改为在迷你宿主上
  >   接住这条路由，回一条\*\*最朴素的\*\* text/event-stream：握手之后一个 data 都不发。
  >   没有 data 就不会触发重取，不干扰「只发了一笔 POST」与作答计数那几条断言。
  >   没挂 lib/watch 的真通道是有意的：openChannel 会顺带 ensureWatching 把文件监听拉起来，
  >   而这一套自己就往盘上写作答，会反过来触发通知与重取——那是它不需要的后台活动。
  > 
  > 验收：\`npm run test:browser\` exit 0，7 套全跑、无一跳过（hl / quiz-code / math / reading /
  > reading-position / attempts / watch-push），六处「控制台错误、页面错误、失败请求：全干净」；
  > \`npm test\` 仍 exit 0（套件覆盖：83 个文件全部有归属）。

- merge(导出): 合入集成分支（\#72/\#74/\#76/\#78/\#79 等），并让离线页面适配阅读端的新通路 ([f56bf23](https://github.com/Miaotofu01/Study-Mate/commit/f56bf23d3fcb8a1fb54caeb7d5a235905133504c))

  > 两边都留：
  > - 域规则表：\`tools\` 的 allow 同时留 \#74 的 watch 与 \#82 的 export；保留 \#79 的 ask 域；
  >   \`bin\` 同时留 watch / export / ask；\`export\` 仍是 \`\['core','lib','tasks'\]\`（import tools 会成环）。
  > - \`checks.mjs\` 的 core 组同时留 \#72/\#79/\#74 的套件与 \#82 的四套；\`--browser\` 组同时留
  >   attempts / watch\_push / export\_file。
  > - \`test\_tools\_guard.mjs\` 的子系统级 effect 清单合成三条（导出任务类型 / 任务服务 / 文件监听）。
  > 
  > 合完之后真跑浏览器验收抓到一个\*\*真问题\*\*：\#74 让阅读端在挂载时开一条
  > \`EventSource('/api/studymate/events')\`，离线页面里它会去连 \`file:///api/studymate/events\`——
  > CORS + 失败请求各一条，控制台脏。修法（都在导出域的宿主替身里，client.js 一个字不动）：
  > - 用\*\*静默的 EventSource 替身\*\*（不连、不重连、不报错）：离线页面是导出那一刻的快照，没有可推的东西；
  > - 作答（\#72 的 \`POST /api/studymate/attempts\`）与资料 POST 一样，明确回 403 并说清回 DSH 里写，
  >   这一屏照常判分但不落盘。
  > 浏览器套件补了 \`export-readonly\` 场景断言这两条，四个场景控制台/页面/失败请求全干净。

- refactor(导出): 收尾三处小东西（\#82） ([a660b06](https://github.com/Miaotofu01/Study-Mate/commit/a660b0612e06678490d80bea4c09b44fee79d90e))

  > - 未命中路由的 404 说明跟上实际：只应答 library 与 reference 的\*\*读\*\*请求，写请求一律 403；
  > - \`bootScript()\` 去掉没人用的 \`title\` 形参（参数不用就别留着当装饰）；
  > - 去掉未使用的 \`EVENTS\_ENDPOINT\` 常量（推送那条路走的是 EventSource 替身，不需要这个值）。

- feat(实验域): 判分三轨的第三轨——交付物题由 Host 半代跑，真实输出进作答数据（\#77） ([89eb68d](https://github.com/Miaotofu01/Study-Mate/commit/89eb68d8fc1fd0df96b8c77e2eea74441e4566ad))

  > 目标态规格 §7.3 的三轨里，客观题（页内即时判）与主观题（参考答案 + 自评）已经在了，
  > 缺的是\*\*交付物 / 实操题\*\*：由 Host 半在学生本机上代跑那条测试命令，把真实输出贴回作答
  > 数据。这张票补的就是它，落成 \`lib/lab/\*\*\` 一个域 + 一个原生工具 \`studymate\_lab\_run\`。
  > 
  > 四件事的落点，改之前先读文件头：
  > 
  > 1. \*\*命令从题目里来\*\*（\`contract.ts\` + \`tools.ts\` 的取值顺序）。题库里那道题必须显式写
  >    \`kind: 交付物\`，命令只能从它的 \`证据\` 字段取，再走\*\*空白切词\*\*（不开 shell，引号 /
  >    管道 / 重定向 / 变量 / 通配一律拒）。模型与学生的参数表里\*\*没有\*\*「自己写一条命令」的
  >    位置——这是本票最重要的一条边界，不然「学生本机代跑」就成了「模型在你机器上执行命令」。
  > 2. \*\*边界先判完再跑\*\*（\`sandbox.ts\`）。cwd 与可写范围都在该节点的 \`lab/&lt;NNNN&gt;-&lt;短名&gt;/\`
  >    里，参数里的绝对路径不出工作区，软链的真身也要在范围内；判不过就拒，并把「允许的范围」
  >    一起给出去。判据只有一条：\*\*归一化之后的路径包含关系\*\*（不是逐字符查 \`..\`）。
  > 3. \*\*长命令走任务模型\*\*（\#73）。这一次调用内联等到 \`inlineWaitMs()\`，没等到就把句柄交回去，
  >    \`studymate\_task\_\*\` 接手查/等/取消；取消回执里有 kept/discarded 与「保留什么」。半路被杀的
  >    那一次也照样落盘（有信号或退出码 + 被杀之前吐出来的那一段）。
  > 4. \*\*落进作答数据\*\*（\#71 的 \`attempts/&lt;NNNN&gt;-&lt;节点id&gt;.json\`）。退出码、时长、stdout/stderr
  >    \*\*原样\*\*写进那条记录的 \`跑\` 字段（含失败与报错原文，单条流上限 64 KiB，头尾都留）。
  >    \`对\` 永远是 false：\*\*通过与否不由这一层判\*\*——输出契约、渲染文本、落盘字段里都没有
  >    「通过 / 成功 / 失败」这类位置，学生看输出之后自己选自评档。
  > 
  > 顺带的三处（都是为了上面四条能落地）：
  > 
  > - \`lib/tools/domains.ts\` 新增 \`lab\` 与 \`attempts\` 两个数据域，\`vault.ts\` 补它们的读法
  >   （\`lab\` 要 \`options.node\` 才定位得到「这一课的实验目录」；\`attempts\` 与 payload 里
  >   \`node.attempts\` 走同一套 \`lib/attempts.ts\`，不是第二份真相）。\`DomainLoader\` 因此多了
  >   一个可选的 \`options\`，旧调用一个字都不用改。
  > - \`pool\` 域多一种给法：给科目 slug + \`options.node\` 就自动拼出 \`&lt;NNNN&gt;-&lt;节点id&gt;.quiz.json\`
  >   （编号只能从课件文件名上取，让每个调用方各拼一次迟早有一处拼错）。
  > - \`schemas/attempts.schema.json\` 补 \`跑\` 与 \`预测\` 两个字段的说明；\*\*就地展开\*\*、不用
  >   \`$ref\`/\`definitions\`——本仓库的纯函数子集校验器不实现它们（见 \`lib/core/schema.ts\`）。
  > 
  > 测试：\`scripts/tests/test\_lab\_runner.mjs\`（新，接进 core 组）23 条，覆盖真命令真输出落盘、
  > 长命令的进度与取消回执、四组越界反证（cwd / 可写范围 / 参数路径 / 软链）、命令来源的四种
  > 拒绝、以及「输出契约里没有判定字段」这条反向断言。\`test\_tools\_guard.mjs\` 的声明表与
  > \`test\_architecture\_boundaries.mjs\` 的域规则表跟着登记 \`lab\`（默认拒绝，不登记就红）。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/77-lab-runner ([842f9e7](https://github.com/Miaotofu01/Study-Mate/commit/842f9e7bb4d09195821ce382d556d02c119a6348))

  > \# Conflicts:
  > \#	lib/tools/index.ts
  > \#	scripts/tests/test\_architecture\_boundaries.mjs
  > \#	scripts/tests/test\_tools\_guard.mjs

- merge(技能): 总控与记录清洗（\#80） ([eb6d711](https://github.com/Miaotofu01/Study-Mate/commit/eb6d71111e2fe222368c0f1f14b84fcb30b7aab3))

  > 把 \`ticket/80-skills-core\`（c9d88fb + 三次回合集成分支 + c417921）合入集成分支。
  > 分支落后集成分支 4 个提交（\#74 的工作区变更推送与浏览器 QA 夹具），本次合并在
  > dda2b35 之上落地；两边改动的文件集\*\*互不相交\*\*，git 自动合并即并集，无冲突、无手工改动。
  > 
  > 这张 ticket 干了什么（issue \#80 / 目标态规格 §6.2、§9、ADR-0008）：
  > 
  > - \*\*总控的开场只调一次 \`studymate\_workspace\_context\`\*\*：不再自己读配置、进度、记忆、大纲；
  >   参数表、返回形状、域声明与旧命令对照搬进按需取的 \`learning-system/references/tools.md\`（新增，155 行）。
  > - \*\*删掉暂存模式\*\*：不建临时工作区、不问落点、不写 \`prefs.md\`、不 \`cp -a\` 搬运；学习数据直接写配置里的工作区。
  > - \*\*删掉三个机械步骤\*\*：\`render\_lesson.py\` 渲染、\`gen\_home.py\` 刷新主页、派工前算 \`md5\`。
  > - \*\*\`record-keeping\` 改写\*\*：三档进度、误解记录单一落点、\`sessions/\` 与 \`assessments/\` 退役、作答数据只读视角。
  > - \*\*\`local-qa\` 改写\*\*：问答面板就地独立调模型，答完只留一条误解记录；答复格式的唯一出处是面板系统提示（\#79 的 \`lib/core/ask.ts\`）。
  > - \*\*技能瘦身\*\*：三份常驻正文 18300 → 13963 字符；参数、路径、命令、格式从正文消失。
  > - \*\*无头宿主降级表\*\*：两个适配器的 \`NATIVE\_TOOL\_FALLBACK\` 由 3 个工具扩到 7 个。
  > - docs/规范 三份（文件归属、工程约束、Agent交接协议）跟上删除与工具化。
  > 
  > 验收怎么验的（都在主检出、合并后的工作树上跑的）：
  > 
  > - \`npm test\` 全绿：7 个测试汇总块全部 \`fail 0\`，无 \`not ok\`／\`✖\`。
  >   两条「套件覆盖」行：\`83 个文件全部有归属（当前组 core：18 个 Python + 2 个 Node + 37 个 --test）\`、
  >   \`83 个文件全部有归属（当前组 --static：5 个 Python + 0 个 Node + 4 个 --test）\`。
  > - \`python3 scripts/check\_skill.py .dsh/skills/\*/\` → 12 份 OK。
  > - grep 证据：\`learning-system\`/\`record-keeping\`/\`local-qa\` 三份 \`SKILL.md\` 正文里
  >   \`.py\`／\`python3\`／\`exit code\`／\`cp -a\`／\`md5\`／\`.studymate-stage\` 全部 0 命中；
  >   仅 \`learning-system/references/tools.md\` §8 的旧命令对照表命中（已知例外）。
  > - \`STUDYMATE\_DSH\_PACKAGE=… npm run test:dsh\` → 6/6 通过。
  > - \`npm run test:browser\` → 全部通过（含 \#74 新加的 watch-push 与 attempts 冲突用例）。
  > 
  > 诚实边界：issue 验收里「完整跑一次真实流程」用的是\*\*现造工作区 + 真 dispatch 八个工具\*\*的可复核证据，
  > \*\*没有跑真模型\*\*——不构成一次真实学生会话的验收。

- fix(实验域): 读盘抛出来的异常转成一句能照着改的拒绝（\#77） ([d28f5f0](https://github.com/Miaotofu01/Study-Mate/commit/d28f5f0c4ccaacc312ddabfac03c75ca5db0cbee))

  > \`run.access.read\` 会抛：科目不存在、没工作区、域没声明都走这条路。原先那句 \`Error\`
  > 直接穿到调用方那里，读起来像插件坏了；其实只是「你这个参数指向的东西不在」。改成拒绝
  > 回执（\`状态: 拒了\` + 为什么 + 下一步），域 guard 的 \`DomainViolationError\` 走同一条路
  > （它带 \`\[DOMAIN\_VIOLATION\]\` 前缀，一眼能认出来，反证仍按前缀断言）。
  > 
  > 套件补一条：科目不存在 / 没有工作区两种情况都必须是「拒了」，不是异常。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/77-lab-runner ([89ae53d](https://github.com/Miaotofu01/Study-Mate/commit/89ae53d19da6b118a777aaebddd89652f6ab5900))
- merge(导出): 静态页面降为导出能力（\#82） ([aa698d4](https://github.com/Miaotofu01/Study-Mate/commit/aa698d4af8dca84a9f490c35c2a396167fa0acf0))

  > 把 ticket/82-export 合进集成分支。这张 ticket 干了什么：
  > 
  > - 静态页面降为\*\*导出能力\*\*（ADR-0005）：工作区导成一份自包含、能离线打开
  >   （\`file://\`）的页面——\`lib/export/\*\*\`（cli / guard / page / plan / react / run /
  >   task），\`studymate\_export\` 从一个「返回 implemented:false」的占位变成起
  >   durable 任务的真工具，任务类型在插件加载时预登记（重开 DSH 后 resume 认得出）。
  > - 无头宿主路径：\`bin/studymate.mjs export\` \*\*没有参数也能跑\*\*（课完默认导一份），
  >   工作区按 \`--workspace\` → \`$LEARN\_WORKSPACE\` → 配置 → 当前目录定位。
  > - 发布门禁：\`npm run guard:export\`（\`scripts/release/export\_guard.mjs\`）扫产物里
  >   漏进的 Node 专用东西，\`release.mjs\` 在打包与 npm 发布前先跑它。
  > - 五套验收 + 两份使用说明的补充。
  > 
  > 冲突：\*\*无\*\*。git 自动合并干净（\#77 尚未进集成分支，\`lib/tools/index.ts\` 那条
  > \`registerLabTools\` 冲突没有出现；其余「两边各加一段」的机械冲突都落在不同锚点）。
  > 逐个人工核对了 checks.mjs 的 core/--browser 两组登记、package.json 的
  > \`guard:export\`、release.mjs、lib/tools/index.ts 的注册点、域表的 export 域、
  > test\_tools\_{guard,rewrite}、test\_dsh\_runtime、README、两份使用说明——两边都留。
  > 顺手修一处笔误：Codex与ChatGPT.md 里 ADR-0003 的相对链接少了 \`../\`。
  > 
  > 验收（本机，主检出）：
  > - \`npm test\` 全绿。套件覆盖：core 组 88 个文件全部有归属（18 Python + 2 Node +
  >   41 --test）；--static 组 88 个（5 Python + 0 Node + 4 --test）。
  > - \`npm run guard:export -- --inject host.js\` \*\*按设计失败\*\*（退出码 1，报 3 条：
  >   两处 node:fs 的 require + 清单字节数对不上）——泄漏守卫的反证。
  > - \`npm run test:browser\` 全绿（7 套，含 \`browser/export\_file\_test.mjs\`：真 React
  >   19.2.7 + 真 Chrome 在 \`file://\` 下打开真产物，样式/公式/图片/题目/判分可用，
  >   控制台与失败请求干净）。
  > - \`STUDYMATE\_DSH\_PACKAGE=… npm run test:dsh\` 全绿（6/6，真 DSH 0.2.0-rc.2）；
  >   探针里的导出那段走的是真 dispatch：起 durable 任务、等回文件清单、守卫无问题。
  > - \`node --check lib/client.js\` 通过。
  > - 无头 CLI 抽查：临时工作区 + 临时 \`DSH\_HOME\`，\`export --workspace … --out … --quiet\`
  >   退出 0，11 个产物，入口 \`index.html\`。
  > 
  > 诚实边界：实施者留的验收第 5 条（在\*\*真的 Codex / Antigravity 宿主里\*\*跑一遍）没做到，
  > 以上用的是等价无头 CLI 路径的可复核证据——\*\*不是\*\*已在那两个宿主里验过。

- feat(阅读端): 交付物题的「跑一次」与事实块，界面只显示事实与学生自评（\#77） ([bb3840d](https://github.com/Miaotofu01/Study-Mate/commit/bb3840dc7883d143510a3881e73feea305e5e1b5))

  > 上一笔把 Host 半那一轨接通了（命令从题目里来 → lab 目录里真跑 → 真实输出进作答数据），
  > 但学生\*\*看不到\*\*：阅读端一个事实都不显示。ticket \#77 的验收里写着「界面只显示事实与学生
  > 自评」，所以这笔把界面补齐——第三轨到这里才算接上。
  > 
  > \#\# 阅读端（\`lib/client.js\`，零构建单文件，只动交付物题与作答显示那一块）
  > 
  > - \*\*交付物题多一颗「跑一次」按钮\*\*（\`data-proto="lab-run-button"\`，在右栏「题目」tab 展开
  >   区里，与「交付物 / 可运行证据」同处）。\*\*不点不跑\*\*：打开课件一个请求都不发——自动跑
  >   等于把「打开课件」变成一次学生本机上的执行，那是不能悄悄发生的事。
  > - \*\*事实块\*\*：命令原文、结局（跑完 / 超时 / 取消 / 起不来）、退出码原样、信号、用时、
  >   两条流（字节数 + 「超限已截断：头尾都留、中间省略」）。命令没起来时说「没起来：&lt;原因&gt;」。
  > - \*\*判决词一个都没有\*\*：退出码是数字、结局只描述怎么结束的，块尾那句明说「通过与否不在
  >   这一层——你自己看输出，自评由你在下面选」。自评三个档沿用主观题那一套（\`record\` →
  >   \`POST /api/studymate/attempts\`），落盘走的仍是 \#72 那条写队列与栅栏。
  > - \*\*刷新之后那一幕还在\*\*：\`attemptFromDisk\` 多带一格 \`lab\`（\`上次结果.跑\`），所以「上次跑
  >   出什么」与「上次选了 B」同级，活过刷新；刚跑完那一次优先用回执里的事实（盘上那份优先，
  >   两者指向同一次运行时只渲染一遍）。
  > - 跑得久时按钮禁用、显示任务 id 与进度行，并说清「要停它就跟总控说取消这个任务」；
  >   板子（\`GET /api/studymate/tasks\`）只在真有跑着的任务时问，\*\*只在板子上真见过那个任务、
  >   而它已经不在「排队/运行/取消中」时\*\*才重读 payload（读不到不是「它结束了」）。
  > - 顺手把「实操题……（还没实现）」那句过期文案改成指向「跑一次」。
  > 
  > \#\# Host 半：学生那条入口（\`lib/lab/route.ts\`，\`POST /api/studymate/lab-run\`）
  > 
  > 学生按的那一下要有落点。这条路由\*\*只解请求体与造 access\*\*：命令从哪来、文法怎么读、边界
  > 怎么判、事实怎么写盘，全部走与原生工具\*\*同一份实现\*\*（把 \`planLabRun\` / \`startLabRun\` /
  > \`settledRunOutcome\` 从工具里抽出来共用）。等待上限比工具短得多（8 秒 vs 25 秒）：HTTP
  > 请求挂着的时候页面什么都做不了，跑得久就把句柄交回去、页面改问任务路由。
  > \`bin/dsh-plugin.ts\` 只加一行注册（与 \#72 那条同一个姿势）。
  > 
  > \#\# 域图：guard 与 vault 搬进 \`lib\` 域
  > 
  > \`lab/route.ts\` 要用同一套读法与「越权即抛」的 guard，而架构边界表里\*\*实验域不许 import
  > 工具域\*\*（tools → lab 是注册点那条边，反过去就是成环）——这条反证在一开始就红了。所以把
  > \`lib/tools/{access,domains,vault}.ts\` 搬成 \`lib/lib/{access,domains,vault}.ts\`（它们本来就是
  > 「Host 数据层」的东西：一个回答「能不能碰这份数据」，一个回答「数据是什么」），
  > \`lib/tools/\` 下留三份\*\*只做转发\*\*的 shim，域内所有既有 import 与 \`lib/tools/index.ts\` 的
  > 对外导出一字不变。域图上只剩 tools → lib 与 lab → lib 两条向下的边。
  > 
  > \#\# 测试
  > 
  > - \`scripts/tests/test\_client\_lab\_run.mjs\`（新，core 组）15 条：事实块的每一样都渲染得出来、
  >   三种状态下都\*\*没有判决词\*\*（判据落在界面文案上，两条流的原文是证据、不参与）、入口只有
  >   一颗按钮且不点不跑、跑着时禁用、\`labFactsOf\` 的退出码是数字原样、端点常量与 Host 半一致。
  > - \`scripts/tests/browser/lab\_run\_test.mjs\`（新，\`--browser\` 组）三个场景：打开课件不发请求 /
  >   按一下 → 真命令跑起来（脚本留下的物证文件）+ 真输出回到界面 + 落进 attempts / 刷新之后
  >   仍在且仍无判决词。真浏览器 + 真 HTTP + 真 \`lib/lab/route.ts\`。这一条抓到了一个真 bug：
  >   任务类型只在工具那条路登记过，路由那条路会 \`\[TASK\_BAD\_KIND\]\`——登记点已收到 \`startLabRun\`
  >   一处（起活是唯一的瓶颈口）。
  > - \`test\_client\_attempt\_fence.mjs\` 的本地作答形状多一格 \`lab\`（这条作答不是代跑，值是 undefined）。
  > 
  > \#\# 技能参考
  > 
  > \`tools.md\` 补上 \`studymate\_lab\_run\`：参数表一行、§3 的返回形状与四种结局（含「没有『通过』
  > 这个字段，也不许加」与边界清单）、域声明表一行、§8 无头宿主的落点（没有等价脚本，如实说明
  > 这一轨在那边跑不了）。\`test\_skill\_contracts.mjs\` 的调用面对账仍绿。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/77-lab-runner ([30925dc](https://github.com/Miaotofu01/Study-Mate/commit/30925dc609c44e046af8b02dfac47f4b922e425b))

  > \# Conflicts:
  > \#	scripts/release/checks.mjs
  > \#	scripts/tests/test\_architecture\_boundaries.mjs
  > \#	scripts/tests/test\_tools\_guard.mjs

- test(导出): 任务类型那条断言改成「导出在里面」，不再要求只有它（合 \#82 后） ([fc31108](https://github.com/Miaotofu01/Study-Mate/commit/fc31108158ab571796f73c9087230bcc48851b48))

  > \`test\_export\_tool\_task.mjs\` 原来断言 \`kinds()\` 精确等于 \`\['导出'\]\`。注册点是组合根，
  > \#77 的实验代跑也在那里登记自己的跑法，于是合完集成分支就红。这条用例要钉的是
  > \*\*「注册 ≠ 起任务」\*\*（一个任务都没有、一个产物都没写），不是「世上只有一种任务类型」，
  > 所以判据改成包含。每加一个子系统都让邻居红一次，是那张表不该有的副作用。

- merge(实验): 交付物题由 Host 半代跑（\#77） ([73411eb](https://github.com/Miaotofu01/Study-Mate/commit/73411ebb674540ab92095213023988e2b9bd8286))

  > ticket/77-lab-runner（fc31108）合进 refactor/reading-end-and-ts-engine。集成分支 tip
  > aa698d4 已经是该分支的祖先（它在 89ae53d / 30925dc 两次把集成分支合了回去并就地解完），
  > 所以这次合并本身是平凡合并、\*\*零冲突\*\*；相对该分支只多一处笔误清理
  > （test\_tools\_guard.mjs 里冲突遗留的一行重复注释「三条」）。
  > 
  > 这张 ticket 干了什么（89eb68d / d28f5f0 / bb3840d / fc31108）：
  > 
  > - \`lib/lab/\*\*\`：判分三轨的第三轨。命令的\*\*唯一来源\*\*是题库里那道 \`kind: 交付物\` 的
  >   \`证据\` 字段，空白切词、\`shell: false\`；cwd / 可写范围 / 参数里的路径一律按
  >   \*\*规范化之后的路径包含\*\*判定，越界即拒（软链按真身判）；真实退出码与两条流原文
  >   （各 64 KiB、头尾都留）原样写进 \`attempts/\` 的 \`跑\` 字段，\`对\` 永远 false——
  >   通过与否不由这一层判。
  > - 长命令走 \#73 任务模型：内联等待超时就把句柄交回去，可查状态、可取消，
  >   取消回执说清哪些产物保留。
  > - 阅读端（\`lib/client.js\`）交付物题的「跑一次」按钮与事实块：不点不跑，界面只显示事实
  >   （命令 / 结局 / 退出码 / 两条流 / 截断），一个判决词都没有，自评归学生；刷新后事实仍在
  >   （\`attemptFromDisk\` 多带一格 \`lab\`）。
  > - Host 半入口 \`POST /api/studymate/lab-run\`（\`lib/lab/route.ts\`），与原生工具共用同一份
  >   计划与执行实现；\`bin/dsh-plugin.ts\` 只加一行注册。
  > - 域图：\`lib/tools/{access,domains,vault}.ts\` 搬成 \`lib/lib/\*\`，\`lib/tools/\` 下留三份
  >   只做转发的 shim，去掉 lab → tools 的反向边（域表登记 \`lab\` 与 \`lib\`）。
  > - \`fc31108\`：导出任务类型那条断言改成「导出在里面」，不再要求只有它（合 \#82 之后）。
  > 
  > 验收（主检出，在合并后、提交前跑的）：
  > 
  > - \`npm test\` 全绿（exit 0）。两条套件覆盖行：
  >   \`套件覆盖：91 个文件全部有归属（当前组 core：18 个 Python + 2 个 Node + 43 个 --test）\`
  >   \`套件覆盖：91 个文件全部有归属（当前组 --static：5 个 Python + 0 个 Node + 4 个 --test）\`
  > - \`node --check lib/client.js\` 通过。
  > - \`npm run test:browser\` 全绿，9 套（含新增 \`browser/lab\_run\_test.mjs\`，\`lab-run：通过\`）。
  > - \`STUDYMATE\_DSH\_PACKAGE=… npm run test:dsh\` 全绿（6/6）。
  > - \`node --test scripts/tests/test\_client\_lab\_run.mjs\` 全绿（15/15，界面只显示事实）。

- refactor(预设): 预设注册改用 TS，安装器不再探测 Python ([dceeb31](https://github.com/Miaotofu01/Study-Mate/commit/dceeb31533e4debdf39b03be27a371cd696502f1))

  > \`scripts/install\_preset.py\` 是 Python 引擎里唯一一处\*\*跨语言硬契约\*\*：安装器把它的
  > stdout 当 \`{patchPath, patchChanged, mode}\` 读，形状错了安装就断。拆除之前必须先有
  > 同形状的替代品，所以这一步不删任何东西，只把这块能力搬进 Host 数据层：
  > 
  > - \`lib/preset.ts\` —— 行为移植，返回值与 Python 版 stdout 逐字段一致（\`--bundle\` 时多带
  >   \`config\`）。三件事一件不少：按 dsh 版本改写 workflow 行、在 profile 的
  >   \`cordis.patch.yml\` 里维护带标记的托管块（\*\*只在文本上拼接\*\*，用户的注释、\`!!js\`
  >   表达式、单引号写法、CRLF、流式列表都原样留着）、失败时一个字节都不落盘。
  >   Python 版里 \`--preset-target\` 解析了却从不使用（真正落盘的是预存目录那一份，随后被
  >   原子替换到位），所以这里不保留这个死参数。
  > - \`lib/yaml.ts\` —— 加三个\*\*显式开启\*\*的构造：\`!!js\` 标签（两种语义对应 PyYAML 侧的两个
  >   Loader）、\`|\`/\`&gt;\` 块标量、一对文档标记。默认仍旧见到就报错：学习文件里没有这些构造，
  >   「宁可炸也不静默解析错」是这套解析器的安全属性，只有两份 cordis 配置用到它们。
  > - \`bin/studymate.mjs\` —— \`findPython\` 与「用 Python 读 YAML 配置」一起删掉，配置读取与
  >   阅读端共用 \`lib/workspace.ts\` 的 \`readConfigObject\`；技能副本不再做 python 命令规整
  >   （技能里已经没有脚本可改写）。
  > - \`bin/zip.mjs\` —— 零依赖的确定性 ZIP 写入，替掉两个插件构建器对 Python \`zipfile\` 的调用。
  > 
  > \`scripts/tests/test\_preset\_install.mjs\` 是原 \`test\_dsh\_presets\` 套件的行为移植：版本边界、
  > 补丁形态保留与幂等、暂存输出、手动声明/越界 profile/坏清单/符号链接一律在写盘之前失败、
  > \`--bundle\` 交给 DSH 的 config 形状。真 DSH 探针（\`npm run test:dsh\`）也在这套替代品上跑绿。

- refactor(无头宿主): 两个插件只发技能与数据，ZIP 改由 Node 打 ([535e063](https://github.com/Miaotofu01/Study-Mate/commit/535e063e0e3ca9843d7a683d84e272a27e5a622c))

  > 无头宿主（Codex / ChatGPT Work 与 Antigravity）以前把 \`scripts/\*.py\` 原样打进插件，靠
  > Python 跑校验与渲染。Python 退场之后它们没有引擎可发了，于是这一侧收成「技能 + schema +
  > 工作区数据骨架 + 文档」：\*\*没有可执行脚本\*\*，校验按 schema 与格式要求逐项自查，导出走
  > \`npx -y @yunmiao/studymate@latest export\`（无头侧学生的阅读体验全靠它）。
  > 
  > - 两个构建器：不再拷 \`scripts/\*.py\` 与 \`templates/assets/\`，不再要 \`python\` 参数，ZIP 由
  >   \`bin/zip.mjs\` 打（固定时间戳与条目顺序，重建逐字节相同）。
  > - 两个技能适配器：\`NATIVE\_TOOL\_FALLBACK\` 从「Python 引擎命令」换成「本宿主做得到的那件事」，
  >   宿主约定里写清没有引擎脚本、以及那条导出命令；python 规整整段删掉。
  > - \`openai/studymate/scripts/interaction\_state.mjs\`：Codex 的交互断点从 Python 搬成零依赖
  >   Node 脚本，命令、字段、错误口径逐条对齐——revision 栅栏是这东西唯一一件「脚本才做得到」
  >   的事，不能跟着 Python 一起退。\`requirements.txt\` 随之删掉。
  > - 测试：插件套件改用\*\*独立于写入端\*\*的 ZIP 读取器（\`fixtures/zip.mjs\`）解包，并在解出来的
  >   插件里真跑一遍交互断点；\`test\_skill\_contracts\` 与两个宿主的技能套件改成断言「导出件里
  >   一处脚本调用都没有」。

- chore(拆除): 删 Python 引擎、示例工作区、页面模板与前端资源 ([30a5ee8](https://github.com/Miaotofu01/Study-Mate/commit/30a5ee817e3652f5f83ec7953c1e61a40f709b89))

  > 替代品都已在位，这一步把旧的删掉：17 个引擎脚本、23 个 Python 套件（含 \`fixtures.py\`）、
  > CI 里的 Python 步骤、\`examples/\`（133 个入库文件）、三个页面模板、\`templates/assets/\`
  > （Sayo / KaTeX / 主题层 / 三个课件层组件）、两个只测旧静态模板的 DOM 套件，以及
  > \`package.json\` / 发布白名单里对应的条目。
  > 
  > - \*\*两个插件构建器不再拷 \`scripts/\*.py\`\*\*，发布必查清单里换成 \`lib/preset.ts\` 与
  >   \`openai/studymate/scripts/\*.mjs\`；\`scripts/release/checks.mjs\` 的 Python 组与 \`findPython\`
  >   调用整段退役。
  > - \*\*评论里的出处改写\*\*：\`lib/\*\*\` 里大量「与 \`render\_lesson.py\` 逐字对齐」的注释是迁移期最
  >   值钱的记录，脚本删了之后改成「与迁移前的 Python 渲染器对齐」——保住含义，不再指向不存在的文件。
  > - \`templates/\` 只剩\*\*工作区数据骨架\*\*（MEMORY / MISSION / GLOSSARY / RESOURCES / subject.yaml）：
  >   新建科目与首次初始化时写进工作区，目标态没让它们退役。
  > - 删掉的三套浏览器套件（hl / quiz\_code / math）守的是「生成出来的页面 + 模板资源」，页面已经
  >   不再预生成；它们守的渲染面由 \`reading\_test.mjs\`（阅读端本体）与 \`export\_file\_test.mjs\`
  >   （导出产物在 file:// 下真渲染：样式、公式、图片、代码块、题目）接住。
  > - 门禁三层仍然都在跑，测试数据全部\*\*现造现弃\*\*（ADR-0009）：仓库里不再有示例工作区。

- test(守卫): 把仍活着的 Python 套件移植成 Node 套件 ([0047c4f](https://github.com/Miaotofu01/Study-Mate/commit/0047c4f3491a09a52fe998880e62f79e79a0d77c))

  > 删 Python 之前逐个判断过 23 个套件：守的东西\*\*还活着\*\*的那些不能跟着删，移植成 \`node --test\`：
  > 
  > - \`test\_skill\_rules.mjs\`（原 \`test\_skill\_rules.py\`）——512 条提示词规则逐条断言仍在它够得着的
  >   技能里，加上 \`rule-owners.json\` 的形状守卫、探索协议参考文件、适配器锚点漂移这几条结构性断言。
  >   这是这批里最大的一条：删掉它，改提示词时把规则改没了没有任何东西会红。
  > - \`test\_skill\_frontmatter.mjs\`——12 份技能的两个调用面（5 个角色都关、总控与 6 个协议都开）。
  >   判定原先交给那个随 Python 退役的校验脚本，现在判据就在套件自己身上。
  > - \`test\_statuses.mjs\`——三档词表与 \`progress.schema.json\` 逐字对齐、旧六档只活在读侧映射里、
  >   题型与课型词表与 schema 一致，以及 \`lib/library.ts\` 那份字面量不许与 \`lib/core/rules.ts\` 分叉。
  > - \`test\_release\_metadata.mjs\`——\`package.json\` 的版本等于最新可达的 \`v\*\` tag（原套件记着
  >   2026-09-30 那次「stale 分支把版本冲回去、躺了两天」的事故）。
  > - \`test\_interaction\_state.mjs\`——Codex 交互断点的 revision 栅栏、锁不等待、迟到/重复/已消费的
  >   question id 不能推进、坏了的状态不许覆盖。
  > - \`test\_docs\_references.mjs\`——\*\*文档悬空引用\*\*：README 与 \`docs/\*\*\` 里的相对链接、行内代码里的
  >   仓库路径都必须在盘上真实存在。拆除之后最容易留下的就是「文档还指着已删文件」，人眼扫不可靠；
  >   三份历史设计文档（设计方案 / 重构评估 / VitePress 提案）显式列为例外，它们按设计就描述重构前的系统。
  > 
  > 新套件全部登记进 \`checks.mjs\` 的 \`--static\` 组：漏登记会被套件覆盖断言以退出码 2 拦下
  > （\`node --test\` 对不存在的文件是静默跳过的，所以这一步必须显式做对）。

- docs(拆除): README 与使用说明重写，工程约束退役三节 ([d365cce](https://github.com/Miaotofu01/Study-Mate/commit/d365cceab981d63e3e4a2acace253075222cd537))

  > 拆除之后文档是最后一批会「留在原地指着已删文件」的东西，所以这一遍不只改措辞：
  > 
  > - \*\*README / docs/使用/\*\*：删掉 Python 依赖、\`examples/\` 演示入口、\`gen\_home.py\` 刷新主页、
  >   三个静态页面套件的说法；改成现在的事实——阅读在 DSH 阅读端（页面实时渲染），要离线副本走
  >   \`npx -y @yunmiao/studymate export\`，无头宿主没有引擎脚本、校验按 schema 自查。
  > - \*\*工程约束 §三/§四/§五\*\*：模板占位符契约、脚本一览、前端技术选型三节退役。工具的名称与参数
  >   \*\*只有两个出处\*\*（代码是 \`lib/tools/index.ts\`，人读的是 \`references/tools.md\`），这里只给指针——
  >   再抄一份参数表就多一处会漂的副本。新增 §四 把门禁三层的「层 → 套件」对照写在规范里。
  > - \*\*课件内容格式\*\*：删掉「HTML 由渲染器产出」的那一套（页头/页脚/脚本引用/模板占位符表），
  >   保留内容语法本身；\`HTML\_TAG\_NAMES\` 的出处从 Python 渲染器改成 \`lib/core/format.ts\`，
  >   内容层校验从「跑脚本看退出码」改成 \`studymate\_validate\_lesson\` 的逐条问题。
  > - \*\*文件归属 / Agent 交接协议 / 原生工具契约\*\*：交接门禁与领域校验在无头侧的说法换成「逐项自查」，
  >   工具契约的宿主差异表与旧的「旧命令对照表」整节重写成「无头宿主侧怎么办」。
  > - \*\*三份历史设计文档\*\*（设计方案 / 重构评估 / VitePress 提案）加历史横幅而不是重写：它们描述的
  >   是重构前的系统，改掉就等于篡改记录；横幅把读者引到现行文档，悬空引用检查也把它们显式列为例外。
  > - \`templates/README.md\` 重写为「工作区数据骨架」的说明（那五个文件是新建科目时写进工作区的）。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/83-demolition ([9b29b35](https://github.com/Miaotofu01/Study-Mate/commit/9b29b35760efdb8f6eefc29b3b7c7600865f65b7))

  > \# Conflicts:
  > \#	.dsh/skills/learning-system/references/tools.md

- chore(措辞): 剩余出处注释与验收记录里的脚本名去掉扩展名 ([19cd1be](https://github.com/Miaotofu01/Study-Mate/commit/19cd1be6e6f4a05746e7e609ade7b26e31095949))

  > 仓库里不再有 Python 文件，注释与验收记录里那些「与 xxx.py 对齐」的出处也不该再指向不存在的
  > 文件——改成「迁移前的 Python 渲染器/校验器」这类说法，含义不变。历史验收记录加了横幅说明
  > 命令口径按当时状态，要复跑规则断言用 node --test。发现的产图脚本与交付物示例是\*\*学生产物\*\*
  > 口径，不是引擎脚本，保留。

- chore(忽略): .gitignore 去掉 Python 产物规则 ([487c6ab](https://github.com/Miaotofu01/Study-Mate/commit/487c6ab2a2abb69a8c94d8f3e2c7572dd1945756))

  > 仓库里不再有 Python 文件，\_\_pycache\_\_ / \*.pyc 这两条也一并删掉（代码里跳过 \_\_pycache\_\_ 的
  > 那几处是\*\*学生工作区\*\*的过滤规则，学生自己的 Python 笔记与代码仍会出现那个目录，留着）。

- merge(拆除): 删掉 Python 引擎与静态渲染的旧家当（\#83） ([47d4993](https://github.com/Miaotofu01/Study-Mate/commit/47d499377ef6cdf8fdc912cd46faec1d695f3991))

  > ticket/83-demolition 的 8 个提交（dceeb31..487c6ab）：预设注册改用 TS、安装器不再探测 Python；
  > 两个插件只发技能与数据、ZIP 改由 Node 打；删 Python 引擎、示例工作区、页面模板与前端资源；
  > 把仍活着的 Python 套件移植成 Node 套件；README 与使用说明重写、工程约束退役三节。
  > 
  > 验收（合并者独立跑 —— 实施者没有交报告就停了，以下结果都不是它的自述）：
  > - npm test exit 0；两条套件覆盖行：core「0 个 Node + 45 个 --test」、--static「0 个 Node + 9 个 --test」，
  >   都是 70 个文件全部有归属
  > - git ls-files '\*.py' 为空；仓库里没有任何 .py 文件
  > - 门禁三层各有套件承担：数据层 test\_validators\_\*.mjs / test\_host\_\*.mjs，内容层 test\_core\_\*.mjs /
  >   test\_tools\_\*.mjs，渲染冒烟 test:browser；test:browser 全绿（6 套）、test:dsh 全绿（6/6）
  > - 从零（新 HOME + 新 DSH\_HOME，无配置）跑 node bin/studymate.mjs export：exit 0，11 个文件，
  >   React 19.2.7 取自 npm root -g
  > - git ls-files 'examples/' 'templates/assets/' '\*.html' 为空；templates/ 只剩数据骨架（.md/.yaml）
  > - 文档悬空引用检查 scripts/tests/test\_docs\_references.mjs 3/3 通过（反证：植入一条悬空引用即红）
  > - git diff 73411eb..ticket/83-demolition -- CHANGELOG.md 为空（发布流程生成，未手改）

- docs(贡献): 修掉 CONTRIBUTING 里两处已失效的前提 ([d1c32eb](https://github.com/Miaotofu01/Study-Mate/commit/d1c32eb1f45f088293b793243066f1cce2c017e3))

  > CI 已经删掉 \`setup-python@v7\` 与 \`pip install PyYAML\`（\`ci.yml\` 与 \`release.yml\` 里
  > 都没有了），但 CONTRIBUTING 第 3 条还写着「CI 在 Ubuntu / Node 24 / Python 3.13 上跑
  > 的就是它」，第 42 行还在提「Node 与 Python 的版本要求」。CONTRIBUTING 是贡献规矩与
  > 门禁的唯一出处，留着假前提会让照着做的人去装一个已经不存在的解释器。
  > 
  > 改哪块那张表里的 \`bin/\*.mjs\` 同样没覆盖新入口 \`bin/dsh-plugin.ts\`（DSH 插件入口就在
  > 那里），一并补上；顺带把 \`lib/\*\*\` 那行的域清单补全（缺数据域 \`host/\`、问答域、实验域）。

- refactor(引擎): lib/lib 改名 lib/host，并把它登记成域 ([96c4071](https://github.com/Miaotofu01/Study-Mate/commit/96c4071cd95e2494f0bf8174ae1475cb3d17d855))

  > \`lib/lib/\` 与父目录同名，名字没说出它装什么——里面装的是「一个工具能碰哪些学习数据」：
  > 数据域词表（domains）、越权 guard（access）、域数据读法（vault）。改名 \`lib/host/\`，
  > 域 \`host\`：指的是 Host 数据层的守卫，不是宿主适配层。
  > 
  > 它是二级目录，所以域规则表要新登记一条。以测试扫出来的\*\*真实 import 图\*\*为准：
  > \`lib/host/\*\*\` 只 import \`lib/\*.ts\`（library / workspace / yaml / attempts）与
  > \`lib/core/\*\*\`，所以 \`host → \[core, lib\]\`；反过来 \`lib/tools/\*\*\` 与 \`lib/lab/route.ts\`
  > 都 import 它，于是 \`tools\` 与 \`lab\` 的 allow 各加 \`host\`，而 \`tools → lib\` 这条边随
  > 转发壳的路径改写消失了（低水位线断言同步改成 \`tools → host\`）。域图仍然无环：
  > \`tools → host → lib → core\` 与 \`lab → host\` 都是向下的边。
  > 
  > 把判据放在这里而不是摊在 \`lib/\` 里的原因不变：工具域与实验域都要用它，而两者都不许
  > import 对方——\`lib/lib\` 当初就是为了断开 tools → lab 那条反向边才存在的。
  > 
  > 文档同步：工程约束 §二 的目录树补上漏掉的 \`lab/\` 与 \`host/\` 两个一级目录（两者都在
  > DOMAIN\_RULES 里登记为域），并写清「域」的唯一判据在哪；tools.md 与三个转发壳的注释里的
  > 路径一并改到新名。

- fix(注释): 修掉源码注释里指着已删/已改名文件的悬空引用，并让检查扫到它们 ([cb1cd5d](https://github.com/Miaotofu01/Study-Mate/commit/cb1cd5df57f14d7569aedca3a02272b37e36f490))

  > \#83 拆掉 Python 引擎、\`templates/assets/\` 与三个页面模板，同时把 \`lib/\*.mjs\` 改名成了
  > \`.ts\`，但 \`test\_docs\_references.mjs\` 只扫 \`README\` / \`CONTRIBUTING\` / \`AGENTS\` / \`docs/\*\*\`
  > ——同一类缺陷在 \`lib/\` 里整片漏网。这次先扩检查、再按它报出来的清单逐条修：
  > 
  >  · 扫描范围加 \`lib/\*\*\`、\`bin/\*\*\` 的\*\*注释\*\*：只有落在注释区间里的反引号路径才算引用，
  >    代码与字符串里的同形文字不算（正则、模板、UI 文案里都有）。为此把「哪里是注释、哪里是
  >    字符串」那份状态机从 \`test\_architecture\_boundaries.mjs\` 搬进
  >    \`fixtures/source\_mask.mjs\`，两个套件共用一份——两份扫描器迟早会在真实写法上分叉。
  >  · 顺带让 \`resolves()\` 剥掉 \`:NNN\` / \`:NNN-MMM\` 行号后缀：行号引用指的是那个文件。
  > 
  > 扩完跑出 14 条，逐条改成现在的真相（不是放宽断言）：
  >  · \`lib/yaml.mjs\` → \`lib/yaml.ts\`（\`core/{format,schema,yamlpos}.ts\`，共 10 处）；
  >  · \`lib/library.mjs\` / \`lib/reference.mjs\` / \`lib/assets.mjs\` → \`.ts\`
  >    （\`reference.ts\`、\`library.ts\`、\`bin/dsh-plugin.ts\`、\`lib/client.js\`）；
  >  · \`templates/assets/learn-theme.js\` 的 \`var LANGS\` 对账对象随静态渲染退役了，
  >    \`COLORED\_LANGS\` 今天只回答「认不认这个标签」，注释照实说；
  >  · \`pagetpl.esc\` 与 \`library.mjs:NNN\` 那两处历史对照改成不带路径的说法（旧实现已删）；
  >  · \`HTML\_TAG\_NAMES\` 的「三份一致」今天是两份（代码 ↔ 格式文档），断言它的套件名也写错了；
  >  · \`lib/core/yamlpos.ts\` 的「\#65 正在改名，改它是撞车」早已过期，改成真实的两条约束。
  > 
  > 检查范围之外（\`scripts/\*\*\` 不在扫描根里，见那边的说明）也顺手清了同一类残留：四个
  > 特征化测试的文件头、\`test\_core\_anchors.mjs\` 的「今天那份实现带着三个洞」、以及两个校验器
  > 套件里 \`lib/yaml.mjs\` 的\*\*死回退分支\*\*（那个文件已经不存在，分支永远走不到）。

- refactor(引擎): 路径包含判据收成一份（lib/paths.ts），并核实 vault 那条注释 ([6073734](https://github.com/Miaotofu01/Study-Mate/commit/6073734b02c25e0be1e155e0c4526d8845f54763))

  > 同一件事原来有四份私有实现、三种写法：
  > 
  >  · \`lib/reference.ts\` 与 \`lib/assets.ts\` 各一份\*\*逐字节相同\*\*的 \`inside\`
  >    （\`full === root || full.startsWith(root + sep)\`）+ \`realPathOf\` + \`insideReal\`；
  >  · \`lib/export/run.ts\` 一份 \`path.relative\` 版的 \`inside\`；
  >  · \`lib/lab/sandbox.ts\` 一份先判 \`root\` 带不带分隔符的 \`isWithin\`。
  > 
  > 三种写法在正常输入上同解，但 \`root\` 自己带尾分隔符时分叉：补分隔符那份把 \`root\` 判在
  > 自己外面（配置里写 \`workspace: /home/x/ws/\` 就踩到），\`path.relative\` 那份不会。安全边界
  > 最不该有的就是「换一处调用就换一个答案」。
  > 
  > 收成 \`lib/paths.ts\` 的 \`isWithin\` / \`realPathOf\` / \`isWithinReal\`，判据取 \`path.relative\`
  > 那一版（自己会规范化，也处理尾分隔符）。落点选 \`lib/\`（域 \`lib\`）而不是 \`lib/host/\`：
  > 后者会让 reference / assets（域 \`lib\`）反向 import 域 \`host\`，而 \`host\` 要读 \`lib\` 的
  > 数据层——域图当场成环；\`lib/core/\*\*\` 是纯函数域，连 \`node:path\` 都不许 import。
  > 
  > \`isWithin\` 原来是 \`lib/lab/index.ts\` 的对外导出，所以 \`sandbox.ts\` 转出去一行，导出面不动。
  > 另加 \`scripts/tests/test\_host\_paths.mjs\` 直接钉判据本身（14 条特征化断言测的是「取址/落盘的
  > 结果」，判据换种写法照样可能绿），接进 checks.mjs 的 core 组。
  > 
  > \`lib/host/vault.ts\` 那条「判据与 lab/sandbox 是同一条（求解完判包含）」\*\*是假的\*\*，已核实：
  > 那个文件里既没有 realpath 也没有包含判据。它定位实验目录靠的是「slug 先验名（非空、不带
  > 分隔符与 \`..\`）+ 盘上真有这个目录」和「目录名取自 \`readdirSync\` 的真实列名」——两条都只吃
  > 盘上已有的名字，\`..\` 没有入口，所以补守卫是多余的，注释改成实话并指向真正的判据在哪。

- fix(导出): 壳的属性位置改用属性转义器，不再拿文本口径的转义凑 ([3f33bff](https://github.com/Miaotofu01/Study-Mate/commit/3f33bffdf9db22ceb044c39300afd49accc94d0d))

  > \`lib/export/page.ts\` 里有一个私有 \`escapeHtml\`（转 \`&amp; &lt; &gt; "\`，\*\*少转 \`'\`\*\*），形状与
  > \`lib/core/format.ts\` 的 \`escAttr\` 几乎一样——而它被用在 \`&lt;script src="…"&gt;\`（:336）与
  > \`title="…"\`（:355）两个\*\*属性位置\*\*上。\`format.ts:97\` 明说「属性值：再多转 \`"\` 与 \`'\`」，
  > 两份判据迟早会漂，而漂的后果是属性被截断。
  > 
  > 改成 \`format.ts\` 那一对：属性位置用 \`escAttr\`，\`&lt;title&gt;\` 是文本位置（RCDATA）所以用
  > \`escText\`。私有的 \`escapeHtml\` 删掉——它既不等于 \`escText\` 也不等于 \`escAttr\`，留着就是
  > 第三份会漂的转义口径。标题与说明里是\*\*学生数据\*\*（\`pageTitle\` 直接用 \`subjects\[\].name\`），
  > 不是理论洁癖。
  > 
  > 补一条断言钉住方向（\`test\_export\_static\_page.mjs\`）：属性里单引号必须写成 \`&amp;\#x27;\`、
  > 文本位置引号原样留，并反证属性值里没有裸引号。

- test(实验): 给手抄的 LabToolSpec 补一条结构对齐断言 ([6f4cb34](https://github.com/Miaotofu01/Study-Mate/commit/6f4cb347907b9b0539143a07faffc135c21df385))

  > \`lib/lab/tools.ts\` 的 \`LabToolSpec\` 是 \`lib/tools/define.ts\` 的 \`StudyToolSpec\` 的\*\*手抄
  > 副本\*\*——实验域不许 import 工具域（域图会成环），所以只能抄。但两边都没有东西钉着：
  > 
  >  · \`registerLabTools\` 里那句 \`as unknown as Parameters&lt;…&gt;\[1\]\` 把类型不符一起咽下去了，
  >    tsc 拦不住；
  >  · \`grep 'StudyToolSpec|LabToolSpec' scripts/tests/\*.mjs\` 零命中。
  > 
  > 补一条：把两份接口的顶层键与可选性从源码里读出来对账（缩进恰好两格才算顶层键，嵌套的
  > \`output\` 成员不会被误读），再把 \`labRunTool()\` 运行期真造出来的对象拿来数键——接口对实现
  > 撒了谎也红。配一条反证验判据不空转（多键、少必填键、两边同时少一个键三种漂法），
  > 两条红法都亲手验过。
  > 
  > 没有改成共用类型：\`StudyToolSpec\` 依赖 \`Domain\` / \`DomainAccess\` / \`Vault\`（域 host），
  > 要共用就得把它搬进 \`host\` 或 \`core\`——\`core\` 是纯函数域不许 import host，搬进 \`host\` 则是
  > 把「怎么造工具」塞进「数据域守卫」，形状上是错的。所以按域图不成环的前提保留手抄 + 对账。

- refactor(工具): 删掉 lib/tools 下三个纯转发壳，调用点直连 lib/host ([35ac4f6](https://github.com/Miaotofu01/Study-Mate/commit/35ac4f6173730fa40f325181159423bb961a1bdc))

  > \`lib/tools/{access,vault,domains}.ts\` 全文只有一行 \`export \* from '../host/xxx.ts'\`，
  > 是 \#77 把 guard 与 vault 搬去 \`lib/\` 域时留下的兼容层（当时为了不改 \`lib/tools/\*\*\` 里的
  > \`from './access.ts'\`）。转发层多一层就多一处会漂的名字：真正实现搬过一次，转发壳的注释
  > 里就留下了两处「实现搬到了 \`lib/lib/...\`」的过期路径（A3 已修），而壳自己还继续指着
  > 旧名。既然现在就一个 worktree 在动、调用点全部可见，就没有留着的理由。
  > 
  > 改动只有两类，行为零变化：
  >  · \`lib/tools/\*\*\` 里 \`from './access.ts' | './vault.ts' | './domains.ts'\` 改成
  >    \`from '../host/…'\`（tools → host 这条边本来就有，域图不变）；
  >  · \`lib/tools/index.ts\` 的 \`export … from\` 换路径，\*\*名字一个没动\*\*——对外导出面逐字不变
  >    （\`test\_tools\_guard.mjs\` / \`test\_lab\_runner.mjs\` / \`test\_tools\_context.mjs\` 都还在跑）。
  > 
  > 两个测试原来直接 import 那两个壳文件（绕过 \`lib/tools/index.ts\` 的内部路径），一并改到
  > \`lib/host/…\`；\`tools.md\` 里「域词表在 \`lib/tools/domains.ts\`」也跟着改。

- refactor(路由): 四条阅读端路由统一注册约定——收外层 ctx、自己注入 connection ([237338c](https://github.com/Miaotofu01/Study-Mate/commit/237338c7c6ecc077ba8f5b21b40ae992592e4d40))

  > 同一件事原来有两种写法：
  > 
  >  · \`registerAskRoute(ctx)\` 与 \`registerTaskRoute(ctx, service)\` 收\*\*外层\*\* ctx，自己
  >    \`inject(\['connection'\], …)\`；
  >  · \`registerAttemptRoutes(connectionCtx)\` 与 \`registerLabRoute(connectionCtx)\` 收\*\*注入后\*\*
  >    的那层 ctx，由 \`bin/dsh-plugin.ts\` 注入好再递进来（而且返回 boolean，另外两条返回 void）。
  > 
  > 同一个插件里「挂一条路由」不该有两套写法：谁负责拿 connection、缺服务时谁负责不挂，
  > 应该由路由自己的模块回答（那正是 \`attempts-route.ts\` 文件头自称「路径、方法、请求体形状、
  > 状态码映射全在这份文件里」的那件事——注入点却留在 bin 里）。统一到前者，四条一致。
  > 
  > 连锁反应只有三处，都是机械的：
  >  · \`bin/dsh-plugin.ts\`：这三条从 \`ctx.inject(\['connection'\], …)\` 回调里搬出来（那个回调是
  >    「已经拿到 connection」的地方），改传外层 ctx；watch 的推送通道不在四条之列，留在原处。
  >  · 两个测试的假 ctx 补上外层 \`inject\` 那一层（与 \`test\_host\_ask\_route.mjs\` 同一形状）；
  >    \`test\_host\_attempts\_route.mjs\` 里那五条「返回 false」的断言改成「一条都不挂、也不抛」。
  >  · \`lib/ask/index.ts\` 的文件头注释跟着改（它写的是旧的传参姿势）。
  > 
  > 信封不动，下一步单独一个提交。

- refactor(路由): 错误信封统一成一份，并把它写进工程约束 ([21f9a83](https://github.com/Miaotofu01/Study-Mate/commit/21f9a83582815800b1a8842138a8e14080932119))

  > 失败那一侧原来有两套形状（成功那一侧本来就该各说各的，不动）：
  > 
  >  · \`ask\` 回 \`{ available, ok, error: { code, message } }\`；
  >  · \`attempts\` / \`lab\` / \`reference\` / \`library\` 回 \`{ error: '&lt;字符串码&gt;', message }\`
  >    ——\`library\` 那条更离谱：\`error\` 里放的是一整句给人看的话；
  >  · 数据层的回执（\`writeAttempts\` / \`writeReference\` / \`writeMisconception\`）也是后者，
  >    而路由是把它\*\*原样\*\*递出去的（栅栏在数据层，路由不做第二套判断），所以两处必须一起改。
  > 
  > 同一个客户端要按两种形状解析同一种东西，而\*\*任何文档都没写过这个形状\*\*。统一到
  > \`{ ok: false, error: { code, message }, ...extra }\`：
  > 
  >  · 唯一构造点是 \`lib/route-envelope.ts\`（\`errorBody\` / \`routeError\`），数据层的回执类型
  >    直接引用它的 \`RouteErrorEnvelope\`——不再有「各拼一遍」的机会；
  >  · \`code\` 与 \`message\` 分开之后，「按码分支」与「取那句话给人看」不再抢同一个 \`error\`；
  >  · \`extra\` 排在 \`ok\` / \`error\` 前面，所以它覆盖不掉信封本身（有断言钉着）；
  >  · 机读码进一份\*\*词表\*\* \`ROUTE\_ERROR\_CODES\`，\`test\_host\_route\_envelope.mjs\` 扫 \`lib/\*\*\`、
  >    \`bin/\*\*\` 的调用点，用了表外的码就红；
  >  · 客户端那侧收成两个函数（\`lib/client.js\` 的 \`routeCode\` / \`routeMessage\`）——它是手写 JS、
  >    不进 tsc，所以「只从 \`error.code\` / \`error.message\` 取值」也由那条套件钉着；
  >  · 契约写进 \`docs/规范/工程约束.md\` §三 新增的一节（注册约定 + 信封 + 码表指到代码）。
  > 
  > 行为变化是\*\*有意的、成对的\*\*：客户端与服务端同包发货，一起改就没有兼容窗口。浏览器那一侧
  > （真 Chrome + 真 lib/client.js 的 attempts / lab-run / export 套件）全绿，409 重试与
  > 「拒绝并重读」两条路都真跑过。

- fix(技能): 补完 §9.3 技能瘦身——\`.py\` 清掉、命名规则只留指针 ([8880a05](https://github.com/Miaotofu01/Study-Mate/commit/8880a058e9ed52c17fea54aa79fbc0bc6cbb0597))

  > \#80 的验收第 4 条是\*\*无条件\*\*的「技能里搜不到 \`.py\`」，但只做了一半，而且被测试\*\*反向
  > 冻住\*\*了：\`learning-coach/SKILL.md\` 的配图那段写着 \`assets/img/gen/&lt;同名&gt;.py\`，而
  > \`test\_skill\_rules.mjs\` 反过来断言它必须在（\`\['配图：脚本落 assets/img/gen/&lt;同名&gt;.py',
  > '…'\]\`）。当时的口径是「那是\*\*学生产物\*\*不是引擎脚本调用，所以不算违规」——但验收写的是
  > 「技能里搜不到 \`.py\`」，没有例外；而扩展名本来就不该由技能写死（路径的唯一出处是
  > \`docs/规范/文件归属.md\` 的「产图脚本」那一行）。
  > 
  >  · 配图那段改成「脚本落『产图脚本』（路径与命名见文件归属，用什么语言/工具就什么扩展名）」，
  >    索引行也照此改；那条\*\*方向本来就是错的\*\*反向断言翻正，并补一条覆盖\*\*全部 12 份技能正文\*\*
  >    的 \`.py\` 全扫（导出件那三套各自还有一条更窄的 \`scripts/\*.py\` 判据，两条不重复）。
  >  · \`learning-coach\` / \`practice-evaluator\` 里逐字重抄的 \`&lt;序号&gt;-&lt;节点id&gt;.md\` 命名与位次规则
  >    改成指针（「命名与位次见 \`&lt;root&gt;/docs/规范/课件内容格式.md\`」）。那条规则的正文本就住在
  >    \`lesson-design\` 里（\`learning-coach\` 加载它），所以按 \`rule-owners.json\` 的 \`moved\` 机制
  >    声明 owner——提示词改一处、归属表加一行，断言不用动。
  >  · 顺带把「序号 = 节点在 \`nodes:\` 里排第几、4 位补零」这一句补进《课件内容格式》（原来只在
  >    \`curriculum.yaml\` 与技能里说），让那条指针真的指得到东西。
  > 
  > \`test\_skill\_contracts\` / \`test\_skill\_rules\` / \`test\_openai\_skills\` / \`test\_antigravity\_skills\` /
  > \`test\_skill\_frontmatter\` 全绿，\`npm test\` 全绿。

- test(门禁): 补上目标态规格 §10.3 的性能预算门禁（比例，不是秒数） ([da695c3](https://github.com/Miaotofu01/Study-Mate/commit/da695c3dfc032e323be846e2fd952f6f5a3e82a6))

  > §10.3 写着「性能预算 | 写成"相对工作区规模的比例"，不写绝对秒数」，而全仓零实现——这一行
  > 是唯一能拦住「工作区一大就慢成什么样」的门禁。
  > 
  > \*\*不用挂钟\*\*：本会话刚修过一条时间抖动造成的假红，秒数在共享 CI 上取决于邻居、磁盘缓存与
  > 调度，同一个提交跑两次能差一倍。所以数的是\*\*工作量\*\*：\`readLibrary()\` 真的碰了几次文件系统
  > （换掉 \`node:fs\` 导出对象上的那几个成员来数——\`lib/\*\*\` 一律默认导入，所以不需要为测试给
  > 引擎注入计数器）。这个数字是确定性的。
  > 
  > 判据是\*\*比例\*\*：现造 N 与 4N 两份额课件的工作区，断言 \`work(4N) / work(N) ∈ \[3, 6\]\`。
  > 
  > 实测（本机，跑完即弃的临时工作区）：
  >  · 16 课 157 次 fs 调用 → 64 课 589 次，比例 \*\*3.75\*\*；
  >  · 8 课 → 32 课，比例同样在线性带里（换一个规模再量一次，防止某个 N 撞上）；
  >  · 线性模型是 \`work = 13 + 9 × 课数\`（用 16/64 两点解出来，代回 4 课得 49，与实测逐字相等）。
  > 
  > 阈值为什么是 \[3, 6\]：下界 3 是留给\*\*固定开销\*\*的——工作区、共享记忆、科目档案这些与课数
  > 无关的读会把比例压低（N=4→16 只有 3.20），不留给它就会假红；上界 6 离平方实现的 16 还差
  > 一倍多，所以「多花一点点」不假红，而真退化一定红。\*\*这两个数是按「线性与平方之间要有一条
  > 能站住的线」定的，不是照着某次实测凑的\*\*——反证用例把线性（13+9n）、平方（13+n²）、
  > 常数（1000）三个模型代进同一条带子，验过判据不空转。
  > 
  > 也真验过一次退化：临时把「每个节点重扫一遍 lessons/」塞进 \`buildSubject\` 的节点循环
  > （平方），两条比例断言立刻红；删掉就绿。

- refactor(阅读端): 删掉暂缓渲染的打卡卡与成就图（死代码，不在 bundle 里留着） ([38284aa](https://github.com/Miaotofu01/Study-Mate/commit/38284aa5763d053d0c7216a10b5fee300caf2ef4))

  > 规格 §4.1 只决定「\*\*暂缓\*\*」：打卡与成就图都只由学习记录派生，而真工作区里四门科目的
  > \`learning-records/\` 全部为空，渲染出来就是「0 天」与一片空白。所以当时的写法是
  > 「只是不渲染，代码一行不删」——但\*\*不渲染即达标\*\*，规格没要求把 ~170 行死代码留在
  > 零构建原样发货的 \`lib/client.js\` 里（它整份进浏览器，每一个字节都是学生的下载量）。
  > 
  > 删掉的是：
  >  · 日期原料与打卡计算：\`pad2\` / \`isoDay\` / \`shiftDay\` / \`recordDates\` / \`streakOf\`；
  >  · \`StreakCard\`；
  >  · \`HeatGrid\` / \`HeatTable\` / \`Heatmap\` 与那两段「暂缓」说明注释；
  >  · 只被它们用的样式：\`.smb-streak\*\`（13 行）与 \`.smb-heat\*\`（20 行）。
  > 
  > \*\*没删错东西\*\*：这几样在 \`lib/\*\*\`、\`bin/\*\*\`、\`scripts/\*\*\` 里一个调用点都没有（\`grep\` 逐名
  > 核过）。中间夹着的 \`lastTouched\` / \`ContinueCard\` / \`SubjectRow\` / \`SubjectList\` /
  > \`HomePage\` 是活的（\`ContinueCard\` 就在用 \`lastTouched\`），一行没动——死代码在那一块里是
  > \*\*插花\*\*的，不是连续一段，所以按函数边界删而不是按行号区间删。
  > 
  > 顺带把 \`RoadmapTable\` 那句「做法与热力图那套 HeatTable 一致」改掉（被指的东西没了），
  > 改成说它自己的做法。git 历史留着，要恢复照着这个提交反着来即可。
  > 
  > \`npm run test:browser\`（真 Chrome + 真 client.js，含导出产物在 file:// 下渲染）与
  > \`npm test\` 都全绿。

- docs(路由): 补一句「asset / events 两条路由有意不走错误信封」 ([edfed57](https://github.com/Miaotofu01/Study-Mate/commit/edfed5714e7eed0b935c3294eb1b71140f064871))

  > 上一条统一信封时只说了「失败恒为 \`{ok:false, error:{code,message}}\`」，没交代那两个
  > \*\*有意不跟\*\*的路由，读的人很容易顺手把它们也「统一」回去：
  > 
  >  · \`asset\` 是图片地址（\`&lt;img src&gt;\` 直接吃响应体，回 JSON 没有意义，失败就是 404/500 的纯文本）；
  >  · \`events\` 是 SSE 流（响应体是一串事件，不是一份 JSON）。
  > 
  > 两句话写进 §三 那一节，免得下次评审再把它们当成漏网的第三种信封。

- merge(评审修复): 两轴代码评审提出的问题（CONTRIBUTING / 目录树 / 悬空注释 / 路径判据 / 路由信封 / 技能瘦身 / 性能预算 / 死代码） ([2dc0a19](https://github.com/Miaotofu01/Study-Mate/commit/2dc0a192ea4555bfc2f7488f7abeaad54b6e5b6e))

  > 这是一次性收尾修复（\`code-review\` 之后），\*\*没有对应的 GitHub issue\*\*，所以不评论、不关单。
  > 
  > 合并 ticket/review-fixes 的 13 个提交，基线 47d4993（集成分支 tip，未动过 → 零冲突）。
  > 
  > 修掉的东西：
  > - docs(贡献)：CONTRIBUTING 里两处已失效的前提；
  > - refactor(引擎)：lib/lib → lib/host，并把它登记成一个域；
  > - fix(注释)：源码注释里指着已删/已改名文件的悬空引用，并让检查扫到它们；
  > - refactor(引擎)：路径包含判据收成一份（lib/paths.ts）；
  > - fix(导出)：壳的属性位置改用属性转义器，不再拿文本口径的转义凑；
  > - test(实验)：给手抄的 LabToolSpec 补结构对齐断言；
  > - refactor(工具)：删掉 lib/tools 下三个纯转发壳，调用点直连 lib/host；
  > - refactor(路由)：四条阅读端路由统一注册约定（收外层 ctx、自己注入 connection）；
  > - refactor(路由)：错误信封统一成一份（lib/route-envelope.ts），写进工程约束；
  > - fix(技能)：补完 §9.3 技能瘦身——\`.py\` 清掉、命名规则只留指针；
  > - test(门禁)：补上目标态规格 §10.3 的性能预算门禁（比例，不是秒数）；
  > - refactor(阅读端)：删掉暂缓渲染的打卡卡与成就图（死代码）；
  > - docs(路由)：补一句「asset / events 两条路由有意不走错误信封」。
  > 
  > 验收（主检出，合并后 + 顺手修掉实施者报告第 3 条之后）：
  > - \`npm test\` 全绿；
  > - \`npm run test:browser\` 全绿（真 Chrome）；
  > - \`STUDYMATE\_DSH\_PACKAGE=… npm run test:dsh\` 全绿；
  > - 反证抽查 test\_host\_perf\_budget / test\_host\_paths / test\_host\_route\_envelope / test\_docs\_references 全绿；
  > - \`git ls-files '\*.py'\` 为空、\`git ls-files examples/ templates/assets/ '\*.html'\` 为空。

- refactor(引擎): cmpCodePoints 收掉第二份，理由本来就不成立 ([393bcc8](https://github.com/Miaotofu01/Study-Mate/commit/393bcc8029596d0873570517e9504aa87833edbd))

  > \`lib/reference.ts\` 里那份本地 \`cmpCodePoints\` 与 \`lib/core/format.ts:69\` 的导出版
  > 逐字相同（只差 \`!\` 与 \`as number\` 的写法）。它挂的注释说「本模块不能反向 import
  > \`lib/library.ts\`（那边 import 本模块）」——反向 import \`library.ts\` 确实会成环，
  > 但\*\*这个符号不住在 \`library.ts\` 里\*\*：它住在纯函数域 \`lib/core/format.ts\`。
  > 
  > 而域 \`lib\` 本来就允许 import \`core\`（\`test\_architecture\_boundaries.mjs\` 的
  > \`GRAPH\`：\`lib: { allow: \['core', 'lib'\] }\`），\`lib/library.ts:34\` 早就是从
  > \`./core/format.ts\` 拿的这一份，本模块第 31 行也一直在 import \`./core/fence.ts\`。
  > 所以那条理由不成立，第二份没有存在的必要。
  > 
  > 这与本轮已经修掉的 B1（路径包含判据抄了四份）是同一类问题：\*\*判据只能有一份\*\*。
  > 清单在两处排出来的顺序必须逐字相同，留着两份就等着哪天只改一边。
  > 
  > 行为逐字相同（纯函数，比过实现；另跑 14×14 组输入——含增补平面字符、组合附加符号、
  > 空串——两组输出全同），所以这次收编不改任何输出。

- fix(工具): 修掉两处宿主不认的 schema，并补一道直接门禁 ([9d05702](https://github.com/Miaotofu01/Study-Mate/commit/9d0570237eda32ab736645a4708084b0c5512970))

  > 真 DSH 里报「原生工具注册失败，总控只能退回旧路径」——\`registerStudyMate\` 整批抛，
  > 14 个工具一个都挂不上，而 \#80 之后的技能已经只认原生工具，等于总控没有手可用。
  > 
  > 两处违规（都是本次重构引入的）：
  > 
  > - \`lib/lab/tools.ts\` 的 \`退出码\` 写成 \`type: \['integer','null'\]\`。宿主只接受\*\*单个\*\*
  >   类型字符串，可空要写成 \`oneOf\` 两支——类型数组在注册期直接抛。
  > - \`lib/tasks/tools.ts\` 的 \`timeoutMs\` 用了 \`minimum\` / \`maximum\`。宿主认的子集是
  >   type / oneOf / properties / required / additionalProperties / items / enum / const
  >   + 注解，多一个关键字就整批注册不上。上界本来就由 \`service.wait\` 按 \`MAX\_WAIT\_MS\` 拒，
  >   描述里照旧写清，约束不靠 schema 表达。
  > 
  > 为什么单测没拦住：我们自己的 \`defineStudyTool\` 是零依赖实现、不做校验，而宿主只在
  > \`tools.register()\` 里校验\*\*输出\*\* schema（参数 schema 它不查）；\`test\_dsh\_runtime.mjs\`
  > 的探针又只按名字查八个学习工具，炸的是实验域与任务域，抓不住这一类。
  > 
  > 所以补一条\*\*不看名字、逐个走 schema\*\* 的套件 \`test\_tools\_schema\_subset.mjs\`：
  > parameters 与 output 都按宿主子集逐点查，并自带反证（类型数组 / minimum / pattern /
  > format / $ref / anyOf / 嵌套违规逐条必须报得出来）。已实测：还原这两处就红，改回来就绿。

- docs(决策): 落定阅读端三栏让位顺序 ADR 与词表「预设」（\#85） ([22753f6](https://github.com/Miaotofu01/Study-Mate/commit/22753f66f26f528fad82441028834678b04edf96))

  > 三栏宽度不是样式表算出来的，而是阅读端按当前画布逐档分配；上一轮把它写成了 ADR
  > 却没提交，实施票与 PR 就没法引用这份决策。词表同理：spec 全篇用「预设」指
  > 「宿主装载一套角色、技能与工具的单位」，不落进词表下一个人只能猜它指什么。
  > 
  > 只提交这两份文档，不碰产品代码。

- refactor(技能): 技能目录搬出宿主默认扫描面，补上出方向检查（\#87） ([261e7d9](https://github.com/Miaotofu01/Study-Mate/commit/261e7d9bddd59065d1b05ea8dd7237fc7e9b20a4))

  > 宿主内置的 standard 预设自带一行没有 config 的 skill-filesystem，默认
  > includeDefaultRoots: true，会按「从工作目录向上第一个含 .git 的祖先」找项目根，
  > 再扫 &lt;项目根&gt;/.dsh/skills。技能一直住在那里，于是任何工作目录落在本仓库/本包里的会话
  > （别的预设、别的任务）都会吃到这 12 个角色技能；边界退化成「会话恰好不在本仓库里」
  > 这种巧合，而全仓只有入方向断言（学习会话别背别人的技能），出方向一条都没有。
  > 
  > 把技能源从 .dsh/skills 搬到 preset/skills——学习预设自己的目录，宿主默认不扫：
  > - 预设用 customSkillDirs 显式指过去，安装器把占位符换成 &lt;payload&gt;/preset/skills
  >   （standalone 落在 engine 副本的同一相对位置）；占位符缺失照旧在安装时抛。
  > - 打包与发布跟着走：package.json 的 files、release.mjs 的 allowlist 与 validatePack
  >   的必查项、两个无头宿主的技能构建源与路径改写、docs-payload 的分发改写，以及两个
  >   构建器「产物不许落进构建输入」的那张目录表。
  > - 仓库里的引用跟着走：技能正文里的角色规格路径、预设 persona 与注释、文档表格与
  >   链接、既有套件里的断言。CHANGELOG.md 是发布流程生成的历史记录，按仓库规矩不手改。
  > - 两处与 \#84 冲突的描述改成新边界（工程约束 §一、使用说明 §七）；预设注释里过期的
  >   技能数（11 → 12）改对。
  > 
  > 新套件 test\_skill\_visibility.mjs 补上缺的那一向：照宿主规则走一遍当前 cwd，断言
  > &lt;项目根&gt;/.dsh/skills 与 &lt;项目根&gt;/.agents/skills 上什么都没有（cwd 在仓库里也成立）；
  > 入方向断言预设只声明一个技能目录、那份声明指向包内真实存在的 12 份技能、占位符丢了
  > 装不上。
  > 
  > 工具与面板那半：spec 假定它们「已经是预设内的」，查下来不成立——八个原生工具在插件
  > 加载时注册在 profile 根作用域（ctx.tools.restrict() 要求 agent 作用域，插件拿不到），
  > 客户端面板由 package.json 的 dsh.client 在包级声明，宿主也没有「按预设注册工具」的
  > 接口。收不了，所以同一套件里加一条特征化断言把现状钉住，结论与去向写进
  > docs/规范/工程约束.md 的偏离记录，不假装已经守住。

- docs(测试): 把技能可见边界套件登记进测试说明 ([2ff479b](https://github.com/Miaotofu01/Study-Mate/commit/2ff479bafd7f8b1d3438a5410e24af031c4d1470))

  > 新套件进了 core 组（覆盖断言认它），但测试说明那张「默认功能套件」表还没有它——
  > 表是给人查「哪条套件守什么」的入口，缺一行就等于下一个人还得去读源码。

- merge(技能): 技能目录搬出宿主默认扫描面，补上出方向检查（\#87） ([c904c51](https://github.com/Miaotofu01/Study-Mate/commit/c904c5147afb3fd1e42638fec466b04272720cb9))

  > 把 .dsh/skills/\*\* 整体搬到 preset/skills/\*\*，避开宿主「项目根/.dsh/skills」与
  > 「项目根/.agents/skills」的默认项目根扫描面——技能摆在那里，任何工作目录落在本仓库
  > 或本包里的会话都会吃到它们，边界退化成「会话恰好不在本仓库里」这种巧合。
  > 学习预设改用 customSkillDirs 单向指过去，includeDefaultRoots: false 保持不变。
  > 
  > 引用面同步（28 个文件）：安装器拷贝清单与 staging 路径、package.json 的 files、
  > release.mjs 的 allowlist 与 validatePack、两个无头宿主构建器与转换器、既有套件
  > 断言、文档。新增 scripts/tests/test\_skill\_visibility.mjs——出方向照宿主项目根规则
  > 走一遍当前 cwd，断言两条扫描路径上什么都没有（工作目录在本仓库里也成立）；入方向
  > 断言学习预设只在一个地方声明技能目录、那份声明指向包内真实存在的 12 份技能、
  > 占位符丢了安装时就抛；外加一条特征化断言，把「工具/面板仍注册在 profile 根、不在
  > 预设作用域」这个与 spec 的已知偏离钉成事实。新套件登记进 checks.mjs 与
  > scripts/tests/README.md。
  > 
  > 验收：主检出 npm test 全绿（test:types / test:installer / test:openai /
  > test:antigravity / checks.mjs / test:static 六段全过，0 fail），其中新增的
  > test\_skill\_visibility.mjs 5 条断言全过；npm pack 实测，154 个打包文件里
  > preset/skills/\*\* 14 项（含 12 份 SKILL.md）、.dsh/\*\* 0 项；实施者另用本机宿主
  > 跑过 test:dsh 6/6。

- test(阅读端): 补一条四路由 × 两档视口的渲染套件（\#86） ([8fcbbf5](https://github.com/Miaotofu01/Study-Mate/commit/8fcbbf5e5409fdc7d4df1e2d7bc954b26511e07f))

  > 阅读端现有的浏览器套件恒定 1440×960，于是 lib/client.js 里两条 \`@media (max-width:
  > 900px)\` 的响应式规则\*\*从来没被执行过\*\*（父 spec \#84 的「现状与差距」四把它记成覆盖
  > 缺口）。后面每一条呈现票都要靠一条路由级的取证缝，这条就是它。
  > 
  > · 四个面——今天学什么 / 科目主页 / 课件页 / 搜索——各一个场景，宽档 1440×960 与窄档
  >   800×900 各跑一遍，每个场景一张截图；metrics 里记着断点命中、三栏实宽、正文列溢出量。
  >   搜索是\*\*覆盖层不是路由\*\*，靠点 .smb-searchbtn 再往它的输入框打字取景。
  > · 窄档不是把宽档截个图：\`Emulation.setDeviceMetricsOverride\` 真换 CSS 视口重跑，
  >   并断两条 \`@media\` 规则落到计算样式与几何上的\*\*关系\*\*（宽档相反、窄档生效）。
  >   反证做过：把两条媒体块的断点改掉，5 条断言当场变红，其余照旧。
  > · 四个面 × 亮暗两套的对比度实测、动效四档与 prefers-reduced-motion 仍在覆盖内。
  > · 断言只到路由级：不钉具体像素、不钉具体 CSS 值。公式元素数量与正文列横向溢出量
  >   只记读数不判红——那分别是 \#91 与配图那张票的验收面，本套件不为它们背书。
  > · 夹具的三处讲究都写在注释里：配图用 data: URL（夹具页走 file://，取图路由到不了任何
  >   服务端，&lt;img&gt; 会以失败请求把场景判红）；搜索输入框靠派发 change（mini-react 把
  >   onChange 直连成 change 监听）；ResizeObserver 换成「observe 时报一次真实尺寸」——
  >   mini-react 每次重渲染整树重建 DOM，把节点闭进 effect 的代码（LessonPage 量画布宽）
  >   会量到被换掉的旧节点、把画布宽写成 0，两条栏于是永远打不开；真 React 里节点不换，
  >   所以那是夹具边界、不是客户端缺陷（同一条边界 reading\_test.mjs 在路线图连线上记过）。

- chore(门禁): 把四路由渲染套件登记进浏览器组与测试说明（\#86） ([2886b85](https://github.com/Miaotofu01/Study-Mate/commit/2886b851d9ae7888a3f2b2e2c642a4094b8f37ce))

  > 不登记的话覆盖断言会以退出码 2 拦下整个门禁（scripts/release/checks.mjs 的
  > checkSuiteCoverage 只认「接进某个组 / 有 npm 脚本 / 明确手动」三种归属）。
  > 测试说明那张表也补上这一条，顺手把表头里那个与表格行数对不上的「五套」去掉——
  > 数着数着就会再漂一次，不如不写数。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/86-reading-routes-suite ([e90c7f8](https://github.com/Miaotofu01/Study-Mate/commit/e90c7f86588b37fcdce9eb946181d28fe46d2042))
- docs(测试): 套件头把夹具的第三处差别补全（\#86） ([37575ef](https://github.com/Miaotofu01/Study-Mate/commit/37575efa458516695d995f4536155b17cadd874e))

  > 头里写「差别只有两处」，漏了 ResizeObserver 那个垫片。那一处恰恰是后来人最容易
  > 踩的：它决定了课件页两条栏在夹具里打不打得开，不看注释就会以为是客户端坏了。

- merge(阅读端): 四路由渲染套件——宽窄两档视口、亮暗对比度、截图与 summary（\#86） ([4bb1671](https://github.com/Miaotofu01/Study-Mate/commit/4bb1671af2d8b7aacfc4f59a9e04925278ab6cb4))

  > 同目录的 reading\_test.mjs 恒定 1440×960，lib/client.js 里两条 \`@media (max-width:
  > 900px)\` 于是\*\*从来没被执行过\*\*（父 spec \#84 的「现状与差距」四把它记成覆盖缺口）。
  > 这一条按路由取景补上那道缝，后面每一条呈现票都要靠它取证。
  > 
  > - 四个面——今天学什么 / 科目主页 / 课件页 / 搜索——宽档 1440×960 与窄档 800×900
  >   各跑一遍，14 个场景各一张截图；窄档不是把宽档截个图，而是
  >   \`Emulation.setDeviceMetricsOverride\` 真换 CSS 视口重跑，并断两条 \`@media\` 规则落到
  >   计算样式与几何上的\*\*关系\*\*（宽档相反、窄档生效）。
  > - 四个面 × 亮暗两套的实测对比度、动效四档与 \`prefers-reduced-motion\` 仍在覆盖内。
  > - 断言只到路由级：不钉具体像素、不钉具体 CSS 值（钉死了就把意图冻成偶然值）。公式元素
  >   数量与正文列横向溢出量只记读数不判红——那分别是 \#91 与配图那张票的验收面。
  > - 新套件登记进 checks.mjs 的 \`--browser\` 组（不登记的话覆盖断言以退出码 2 拦下整个门禁），
  >   scripts/tests/README.md 的套件表补上它；顺手补上表里一直缺的 \`lab\_run\_test.mjs\` 一行，
  >   并把表头那个与行数对不上的「五套」改成不写数。
  > 
  > 合并无冲突：待合并分支的 e90c7f8 已经把集成分支合进自己，merge-base 正是集成分支的
  > c904c51，于是两边都留住了——\#87 的 \`test\_skill\_visibility.mjs\` 还在 core 组，
  > \#86 的 \`reading\_routes\_test.mjs\` 加进 \`--browser\` 组；测试说明两边各加的那一行也都在。
  > 
  > 验收：主检出 npm test 全绿（test:types / test:installer / test:openai /
  > test:antigravity / checks.mjs / test:static 六段全过，0 fail）；
  > npm run test:browser 整组 7 套全绿（reading 6 张截图、reading-position 29 项、
  > attempts 3、watch-push 1、lab-run 3、export-file 4、reading-routes 14 场景 14 张截图），
  > 控制台错误 / 页面错误 / 失败请求全干净。

- feat(问答面板): 选中正文冻成一条留得住的引用（\#92） ([2d1b7fb](https://github.com/Miaotofu01/Study-Mate/commit/2d1b7fb3ee51a57f5cef5f0e1bbed898551c2b01))

  > 选中的那一小段原来是\*\*一个跟着实时选区跑的字符串\*\*：document 级的 mouseup 每次
  > 都读 \`window.getSelection()\`，判定失败（少于四个字、或锚点不在正文里）就写空串。
  > 点输入框、点面板别处、切 tab 都会让浏览器把文档选区折叠成空——于是那一次 mouseup
  > 判定失败，学生刚划出来的引用就没了，此后提交送出的是空选区。
  > 
  > 改法是把「捕获」与「清除」分开：
  > 
  > - 捕获那一下把选区\*\*冻成一条引用数据\*\* \`{ text, anchor }\`——文本 + 来源锚点
  >   （哪一课、哪一小节的 id 与标题）。锚点只能在这时候取，之后 DOM 已换、实时选区也没了。
  > - \`captureQuote(prev, 实时选区, 正文节点, 这一课) \`读不出合格的一段时返回\*\*上一份
  >   （同一个对象）\*\*，React 靠同引用跳过重渲染。清除只留在两处：学生点引用上的「删掉」，
  >   或提交成功（那一刻引用已经随问题落进误解记录）。换视图/换课也不再清：引用自带来源，
  >   别的课的课件页按锚点守一道，拿不到它就不会串课。
  > - 面板把这条引用渲染成「原文 + 来源 + 删掉」，提交时 \`selection\` 送原文、
  >   \`selectionAnchor\` 送锚点；宿主半把锚点写进「选中文本」那一段（模型知道引的是哪一小节），
  >   并把引用原文与它的来源一起写进误解记录的 evidence（日后对账靠它）。引用超长按码位
  >   截断并标注——原样塞进去会把整条记录顶成 400，学生答成了却「误解记录没写进去」。
  > 
  > 两条新套件：\`test\_client\_ask\_quote.mjs\` 用假 DOM 把各种「读到空」的方式逐个喂进
  > \`captureQuote\`（都不得清掉已有的引用），并断言面板渲染/删除/提交的形状；真浏览器那一条
  > \`browser/ask\_quote\_test.mjs\` 用 CDP 的 Input.dispatchMouseEvent 做真鼠标拖拽，验
  > 「选中 → 打开问答 → 点输入框/打字/切 tab 之后引用仍在」。夹具 mini-react 原来只认对象
  > ref，阅读端的正文滚动区挂的是回调 ref，\`bodyRef.current\` 恒为 null（引用永远捕不到）——
  > 补上回调 ref，这是夹具边界不是产品缺陷。

- fix(阅读端): 其余三个面各自收口——继续卡点得进去、空态说得出「没有」、搜索标出科目与节点（\#90） ([43d7493](https://github.com/Miaotofu01/Study-Mate/commit/43d749393b916db42003a26e3908e16766276e39))

  > 三条都是「学生第一眼看不出下一步」这一类：
  > 
  > · 窄档那三条响应式声明是\*\*死声明\*\*：两块 @media (max-width: 900px) 写在被它们覆盖的
  >   基础规则\*\*之前\*\*，同特异度下后写的赢——.smb-wrap 的内边距、.smb-crumb 的宽度上限、
  >   「接着上次」里进度条的宽度在窄档量出来与宽档一模一样。合并成一块放到所有被覆盖的
  >   基础规则末尾；进度条的窄档取值按那句 width:100% 的原意定成「占满自己那一行」
  >   （flex: none 留着，width 落在 flex-basis 上），两段文字换到第二行——比三者挤一行好读。
  >   顺手删掉 .smb-tiles / .smb-tile\*：JS 里零引用，整簇是死 CSS。
  > 
  > · 主页第一屏那张卡按状态说实话：一个节点都没动过时说「接着上次」是编故事
  >   （新建科目、还没有 progress.yaml 都会走到这里），改说「从这里开始」、动作从
  >   「继续读 →」变「开始读 →」。零节点的科目也给出「还没有节点」而不是一张空卡。
  > 
  > · 搜索每条结果补一行出处：科目 → 节点 → 这一条自己的补充（目标 / 选项 / 别名 / 日期）。
  >   科目与节点排在最前，是因为这一行容不下时是被省略号截掉的——截掉的该是补充，不是
  >   「这条属于哪门课」。正文那一段加 overflow-wrap: anywhere：无断点的长 URL 折在自己
  >   那一格里，而不是把结果行顶出横向滚动条（.smb-palette\_\_list 的 overflow-y:auto 会把
  >   横向算成 auto，一溢出面板里就真出滚动条）。补充与类别同名时丢掉——没有小节名的一课
  >   隐含小节名就叫「正文」，不丢会印成「正文 正文 正文」。
  > 
  > · 路线图补一条兜底空态：零节点科目今天被 lib/library.ts 过滤掉了（建课建到一半的正常
  >   中间态），但渲染器不该画出一张只有图例的空地图。
  > 
  > 窄档三条声明修好后由套件断言钉住（见随后的套件提交）。

- fix(数据): 工作区在但一个可用科目都没有时给空清单，不再抛错（\#90） ([1228be9](https://github.com/Miaotofu01/Study-Mate/commit/1228be9e0920d4444653a42d7625e79bad6cd0a1))

  > \`readLibrary()\` 原来在这种情况下抛「学习工作区里没有可用科目」，而阅读端把任何 500 都
  > 渲染成「读不到学习工作区」那张错误卡 + 重试按钮——把「还没建课」说成了「读不出来」。
  > 科目主页那一面的空态验收（\#90）要求的正是「给得出『没有』这类明确交代，而不是一片空白
  > 或报错」，所以判据要落在数据层：这是\*\*正常中间态\*\*（建课先建目录，\`subjects/\` 下只有
  > 建到一半的目录），不是读盘失败。真正该报读不出来的只剩一条：\`.learning/subjects/\`
  > 这个目录根本不在（那条 throw 不动）。
  > 
  > 空清单顺带把另外两处也扶正：阅读端壳里本来就有一条 \`subjects.length === 0\` 的空态分支
  > （「这个学习工作区里还没有科目。」+ 工作区路径），导出那条路则给出它自己的
  > 「工作区里没有要导的科目：… 有的是 （一门都没有）」——原来那句提示是死代码。
  > 
  > 连带补一句原生工具的话：vault 不再抛错之后，\`workspace\_context\` 读到的是空数组，
  > 原本靠 catch 带出来的那句提示就没了。按它自己注释里的口径（「有目录但没有可用科目
  > （建课建到一半）也算『还没有科目』，照实说而不是崩」）在读完处补一句带下一步的提示——
  > 只留一行「（还没有科目）」学生分不清是没建还是没读出来。
  > 
  > \`lib/library.ts\` 的头部注释与特征化套件里那条断言（原来钉的是「抛错，而不是给一份空
  > payload」）一起改到新口径。

- test(阅读端): 四路由套件补空目录 / 半份数据 / 搜索出处与长文本三条验收面（\#90） ([68678ef](https://github.com/Miaotofu01/Study-Mate/commit/68678ef23b723b1853fbe09a30a2dddaf3d031f4))

  > 在 \#86 那条四路由套件上加断言，而不是另开套件：三个面本来就是它取景的那三个，夹具、
  > 两档视口与截图都现成；另开一条只会把同一批夹具抄第二遍。
  > 
  > · 主页：点第一屏那张卡\*\*真的进得去\*\*，落在卡上说的那个节点上（断的是关系：进去那一页
  >   的标题就在卡面那段字里、且真的是课件正文而不是缺课件那一页），点完把夹具重新导航
  >   一次——这一场的截图要的还是主页这一面。
  > · 搜索：每条结果都标出科目（带节点的还标出节点）；再拿一条\*\*无断点\*\*的长 URL 取一次景，
  >   断结果行与列表都不出横向滚动条。那条命中在第二门科目里，顺带证明出处那一段跨科目也对。
  > · 新增三场退化输入：空目录（\`subjects/\` 下只有一个空目录）要求给「还没有科目」而不是
  >   错误卡、且说清读的是哪个工作区；半份数据（有大纲、没课件没附件）要求主页明说
  >   「还没有课件」、路线图每张卡写明「无课件」、参考资料那一块给「还没有」；零节点科目
  >   用一份手造 payload 直接喂给渲染器（Host 半会跳过这种科目），要求它也说得出「还没有
  >   节点」，而不是画一张只有图例的空地图。
  > · 两档对账那一场：窄档三条声明修活之后，从「只记不判 + 打一行 ⚠」升成断言
  >   （内边距与面包屑上限往小走、进度条占满自己那一行、宽档仍是钉死的窄条），
  >   再加一条「没有量到与宽档一模一样的响应式声明了」。
  > · \`test\_client\_search\_index.mjs\` 补三条出处行的纯逻辑用例（科目在前 / 节点为空退到科目 /
  >   补充与类别同名时丢掉），\`lib/client.js\` 的 internals 钩子因此多交一件 \`hitWhere\`。

- feat(阅读端): 三栏几何按画布分配，并排装不下就盖在正文上（\#88） ([2ae7f83](https://github.com/Miaotofu01/Study-Mate/commit/2ae7f83f42dc99713962ac0a31560df91e466a02))

  > 课件页的三栏宽度沿用 ADR-0011 的让位顺序（右栏先拿、左栏先让、中栏保底
  > 420），但把两个后果收掉：
  > 
  > 一、静默归零换成降级。原先画布不足时右栏被算成 0，而选项只在右栏渲染——
  > 学生点「题目」没有任何反馈，题也就做不了（\#84 现状与差距三、用户故事 20）。
  > 现在点的那一栏改成\*\*盖在正文上的抽屉\*\*：顶上写着「窗口太窄……拉宽窗口就
  > 并排」，附一条「收起」，题目与选项都在里头。抽屉只给最近点的那一栏（开一栏
  > 不该顺手把早先要过的另一栏盖上来），宽度按记忆值与画布 clamp、给正文留一条
  > 缝、不写回记忆值；画布变宽自动回到并排。任何宽度下最近要的那一栏都打得开，
  > 「两栏都打不开」的区间因此不存在。
  > 
  > 二、窄轨宽收成一处。原先 38px 在样式表与脚本里各写一遍（脚本侧以 76 表示），
  > 把手偏移又各自重算「窄轨 + 宽 − 3」。现在唯一出处是 token 块的 --smb-rail，
  > 窄轨的 width 引它，脚本侧量渲染出来的窄轨再算分配与把手落点；热区比线宽出来
  > 的半格回退挪进 CSS（data-side 的 translateX）。
  > 
  > 顺带把正文的测宽从固定 760px 改成 min(100%, clamp(760px, 66%, 900px))：
  > 窄画布下仍旧铺满中栏（不比以前更窄），宽画布上约占三分之二——测宽服务于
  > 可读行宽（13px 正文下一行约 69 个汉字封顶），既不填满窗口，也不再是宽画布
  > 正中一条卡在上限里的细条（\#84 现状与差距二：真宿主里只占可用宽约 28%）。
  > 
  > 分配与降级写成纯函数（planPanes / drawerWidth / clampPane / clampDrawer），
  > 挂到既有的 window.\_\_STUDYMATE\_PURE\_\_ 钩子上，由新的 node 套件按 ADR 手算的
  > 例子 + 扫 240–2200px 的不变量断言钉住——「任何宽度都有栏打得开」是代数，
  > 浏览器里一条条试既慢又试不全。

- test(浏览器): 阅读端四路由套件加紧档 700×900 与三栏几何扫描（\#88） ([6c6071d](https://github.com/Miaotofu01/Study-Mate/commit/6c6071df17436056f9e6798a243c9145ee9a8bce))

  > 窄档取 800×900 是有意的：它刚好越过后台栏「装得下」的门槛 776，所以课件页那
  > 一档仍是完整的三栏面。紧档 700×900 取的是门槛另一侧那个态——右栏并排装不下，
  > 必须是「盖在正文上 + 说明 + 收起」的抽屉，题目与选项都在里头。加档的同时把
  > 「是不是窄档」判据改成「有没有落进 900 那条断点」（三档里两档都命中）。
  > 
  > 另加两场：
  >  · reading-routes-panes：按 1440/1100/900/776/700 扫一遍，每档都真的点「题目」
  >    与「节点」，断言两栏在任何宽度下都有反应（并排或抽屉）、中栏不被挤破保底、
  >    正文列不越过中栏；再对门槛两侧（776 并排 / 700 抽屉）与宽画布的占宽下判据。
  >  · reading-routes-wide-doc：宽画布上\*\*默认形态\*\*（两栏都收起）那一张截图，
  >    断言正文列占得住中栏（≥ 六成）又没填满窗口（两侧留白各 &gt; 100px）。
  > 
  > 对账那一场扩到三档：右栏形态与画布一致、把手落在栏的内侧边缘上（窄轨宽只有
  > CSS 一处定义，脚本量出来再用）、两条窄轨加起来 = --smb-rail × 2、正文列占得住
  > 中栏。紧档的实测对比度多量一处：抽屉顶上那条说明条（它是「可见的解释」本身）。
  > 
  > 配套：README 的套件表与 checks.mjs 的浏览器组注释跟着写成三档。

- docs(adr): 0011 的两条后果按实现修正，并补上降级形态（\#88） ([8f39488](https://github.com/Miaotofu01/Study-Mate/commit/8f3948856415c26c947fff599e2e97fffdbe0125))

  > ADR-0011 记的三条后果这次动了：
  >  · 「归零是静默的」不再成立——降级成抽屉，说明与出路都在；
  >  · 「窄画布下正文可以比右栏还窄」按实算数是写错的：中栏保底 420 永远大于右栏
  >    上限 372，真正会缩到与右栏同宽的是\*\*正文的可读宽\*\*（中栏减左右内边距 48），
  >    并排的极限在画布 868px 那一档；
  >  · 「窄轨宽两处各写一遍」收掉了：唯一出处是 token 块的 --smb-rail。
  > 
  > 新写进去的：降级形态本身（最近要的那一栏、留一条缝、不写回记忆值）、
  > 「任何宽度下都有栏打得开」这条不变量（240–2200px 的扫描断言），以及正文
  > 测宽的三段取值与理由。

- feat(阅读端): 课件页正文与页头收口——字号行高成套、配图两条路、长内容不撑版（\#89） ([2b2862a](https://github.com/Miaotofu01/Study-Mate/commit/2b2862a3f981d5b205a76a32cdbcdd1c2374919e))

  > 呈现条目是意图级的（父 spec \#84 明说栏宽比例、字号、行高、配图上限由实施者按意图定），
  > 取值与理由记在这里：
  > 
  > · 立了一层\*\*配对\*\*的字号/行高 token（--smb-fs-\* 与同名的 --smb-lh-\*），正文只有一档
  >   13px/1.65。为什么立：这一层的坏法都「看起来没事」——原来正文 12.5px 与 13px 两级并存、
  >   行高散着六种写法，差半像素的两种正文字号在截图里人眼看不出来。配对之后「换字号必然换行高」
  >   是默认动作，再由 scripts/tests/test\_client\_typography.mjs 断住（配对齐全 + 行高必须无单位数
  >   + 12px 以上必须引阶梯 + 正文那批选择器只许引 --smb-fs-body + 窄档覆盖必须写在基础规则之后）。
  >   为什么只立字号/行高：间距与圆角没有「两套并存」这个问题，摊到全文件只是换个写法；
  >   元信息档（角标、chip、图注、控件文字，≤12px）也不进阶梯——它们不成句，尺寸跟着控件走。
  >   取值：13/1.65 是原来就有的那一档（正文字号不动）；15/1.45、17/1.35、18/1.35、25/1.25、12/1.6
  >   是把原来 24/25/26 三个各写各的一级标题收成一档、并给块标题与等宽各配一条行高后的结果；
  >   行高按字号定（15px 给 1.45、17px 给 1.35），字越大行距收得越紧。
  > · 位图配图加 max-width:100% + height:auto：大图缩到列宽，既不溢出也不裁掉（原来一点约束都没有，
  >   \#86 实测窄档横向溢出 99px）。暗色下压到 85% 亮度：纯白底的示意图在深色正文里就是一块强光，
  >   压完 \#fff → \#d9d9d9，线描图的细线还看得清、颜色关系不变。判据用宿主的
  >   body\[data-ds-dark-theme\]——宿主切亮暗挂的是这个属性，不是 prefers-color-scheme（系统偏好与
  >   宿主主题是两件事，写成媒体查询会在「系统深色 + 宿主浅色」时误压）。
  > · 正文列 overflow-wrap:anywhere：长标识符、长 URL、连成一串的路径在词内断行，正文列与整页
  >   都不再出横向滚动条；&lt;pre&gt; 不受影响（代码块有自己的块内横向滚动）。
  > · 代码块的语言标签给一个贴字的底：原来是与背景同色的灰字，扫过去像说明文字，看不出是标签。
  > · .smb-sec-block 的 scroll-margin-top 从 60px 收到 16px：60 是为了「别被 sticky 的小节目录条
  >   盖住」，那条已经并进顶部那一条（不在滚动区里，盖不住正文）。捕获与恢复量的是同一套几何，
  >   所以阅读位置不失准（reading\_position\_test.mjs 29 项照过）。
  > 
  > 两处「顺手理顺序」（同一块代码、同一类坏法，不另开票）：窄档媒体块从两处并成文件末尾一处
  > （原来写在基础规则之前，\`.smb-wrap\` 内边距、\`.smb-crumb\` 宽度上限、\`.smb-continue\_\_bar\` 换行
  > 三条是死声明——\#86 的读数、\#89 的验收条目点名要顺手理）；\`.smb-crumb\` 的宽度上限从 22ch
  > 改成 18em（ch 是数字宽，中文标题下只剩一半）。

- test(阅读端): 课件页正文与页头加一条宽窄两档的呈现套件（\#89） ([43a3746](https://github.com/Miaotofu01/Study-Mate/commit/43a3746cc8fa4dd8034f1b8a126b502d6f6f8b5a))

  > 为什么单开一条：同目录的 reading\_routes\_test.mjs（\#86）是\*\*取景\*\*用的夹具——一张 480 宽的位图、
  > 两小节、一条题目、没有长标识符、没有宽表格、没有长代码行、没有长中文标题。\#89 的验收里有七条
  > 在那种夹具下量不出来，所以这一条的夹具是「刚好越界」的那一份：1100 宽的位图、铺满列宽的矢量图、
  > 一行比列宽长的代码、无空格的长标识符与长 URL、表头 nowrap 的宽表格、27 字的中文标题、三条题目
  > 锚点；宽窄两档各跑一遍，7 张截图 + summary.json（截图落在 .shots/lesson-body/，已 gitignore）。
  > 
  > 断的是关系不是值（spec 的呈现条目是意图级）：位图「不超列宽、且确实被缩过」、矢量图「铺满图框
  > 且比例不变」、暗色「确实比亮色暗」、代码行「在块内滚」、长内容「页面与正文列的横向溢出都是 0」、
  > 正文「所有成句元素的字号只有一种、行高跟着走」、页头「只有一条、首末块贴住两端」、
  > 面包屑「按全角字省：宽档留 12 字以上 / 窄档 8 字以上」、题目标记「组号与右栏那一组对得上」。
  > 
  > 两处诚实记账：
  > · 矢量图那条路（::: svg → SvgFrame 用 innerHTML 贴 SVG）在 mini-react 下活不过一次重渲染
  >   （整树重建 + effect 不重跑），所以套件里按客户端产出的\*\*同形状元素\*\*量 CSS 契约。
  >   \*\*客户端产出的内联 SVG 目前没有任何浏览器套件覆盖\*\*（导出套件的夹具里也没有 ::: svg 块）
  >   ——这条覆盖缺口写进了 \#89 的报告，不装作验过。
  > · 「解析」块要点过选项才渲染（夹具里点选项会打真接口），所以正文取样点里没有它，
  >   换成一直渲染的右栏组标题。
  > 
  > 实测读数（宽档 1440×960 / 窄档 800×900）：位图 682/342 ≤ 列宽 712/372；矢量图 684/342 = 图框
  > 内容宽；长代码行 1007 在 370 宽的块里滚；宽表格 782 在自己那层里滚（页面与正文列溢出都是 0）；
  > 正文取样点 9 个全是 13px/1.65；面包屑 27 字里露 17/11 字（按 ch 算的那一版只有约 10 字，宽档就红）。

- merge(阅读端): 其余三个面：今天学什么、科目主页、搜索的呈现与空态（\#90） ([5a20e6d](https://github.com/Miaotofu01/Study-Mate/commit/5a20e6d036b0d3b00def0146aaea425aa6181fbf))

  > 今天学什么：第一屏那张「接着上次」的卡点得进去、落在卡上说的那个节点上；这门课
  > 一个节点都没动过时标题改说「从这里开始」，动作从「继续读 →」变成「开始读 →」。
  > 
  > 科目主页：三份退化输入各自给得出「还没有」——空目录（\`subjects/\` 在但一个可用科目
  > 都没有）说「还没有科目」；半份科目（有大纲、没课件与附件）每张路线图卡写明「无课件」、
  > 参考资料那块说「还没有参考资料」；零节点科目不再画一张只有图例的空地图，改说
  > 「还没有节点」。都不是空白、也不是「读不到学习工作区」那张错误卡。
  > 
  > 搜索：每条命中标出「科目 · 节点 · 补充」，出处排在第二行、科目与节点在前（被省略号
  > 截掉时先丢补充）；命中正文用 \`overflow-wrap: anywhere\` 兜住无断点的长 URL，不再从
  > 自己那一格里溢出来。\`hitWhere\` 挂进 TEST\_HOOK 供套件直接断言。
  > 
  > 壳的响应式：\`lib/client.js\` 里散在两处的 \`@media (max-width: 900px)\` 合并成一块、挪到
  > 它覆盖的基础规则之后——原来那三条与基础规则同特异度的声明（\`.smb-wrap\` 内边距 /
  > \`.smb-crumb\` 宽度上限 / \`.smb-continue\_\_bar\` 进度条占满一行）写在前面，全是死声明；
  > JS 里零引用的 \`.smb-tiles\` 死 CSS 一并删掉。
  > 
  > Host 半契约变更（\*\*有意\*\*，供 code review 复核）：\`lib/library.ts\` 在「工作区在、
  > 但一个可用科目都没有」时从\*\*抛错\*\*改成给\*\*空清单\*\*（spec 条目 24：空目录要说「没有」，
  > 不是错误卡）；\`lib/tools/context.ts\` 相应补一句「还没有可用科目……先建一个」的提示；
  > \`scripts/tests/test\_host\_library\_payload.mjs\` 里原本钉「抛错，而不是给一份空 payload」
  > 的特征化断言按新口径改写（改为断言空 payload + 只有「没有 workspace / 找不到工作区」
  > 两条才抛错）。真正该报「读不到工作区」的判据没动。
  > 
  > 套件：四路由渲染套件新增三条验收面（空目录 / 半份数据 / 零节点），搜索那一场补
  > 「每条结果标出科目与节点」与「无断点长 URL 不撑破」两条断言，并把窄档三条死声明的
  > 对账从「只记不判」升成断言；搜索索引套件补 3 条 \`hitWhere\` 用例；测试说明同步登记。
  > 
  > 验收：\`npm test\` 全绿（core 686 pass / 1 skip / 0 fail；static 60/60；installer 23/24，
  > 1 条是平台跳过；openai 6/6；antigravity 6/6）；\`npm run test:browser\` 全绿（7 条套件全过，
  > reading-routes 17 张截图 + summary.json，控制台/页面/失败请求干净）。
  > 
  > 关键读数（本次实跑）：
  > - 窄档三条死声明修活：\`wrapPaddingLeft\` 26px→14px、\`crumbMaxWidth\` 137.5px→87.5px、
  >   「接着上次」进度条 180px（行宽 870）→734px（占满行宽 734）；死声明清零。
  > - 搜索出处：\`参考\` → \`第二科目 · 列表 · 参考\`（跨科目出处正确）。
  > - 长 URL：同一夹具同一探针，修改前那一格正文溢出 15px（格 538px / 内容 553px），
  >   修改后 0px（格 570px）；结果行、列表、面板、文档的横向溢出前后都是 0。

- feat(公式): 随包发 KaTeX dist，正文与题库字段在阅读端离线排版（\#91） ([961bcd9](https://github.com/Miaotofu01/Study-Mate/commit/961bcd98a8fe9c37f4b54233790200b1759f6e27))

  > 内容侧的分工早写在 \`docs/规范/课件内容格式.md\` §3：\*\*模型只写 TeX，排版在阅读端\*\*。这一票
  > 把它落成三件事——离线资源、按需加载、失败可读——阅读端与导出产物两条路都接上。
  > 
  > 落点选在 \`lib/katex/\*\*\`（随包发的第三方 dist），理由是它\*\*最不碰闸门\*\*（勘察 §6.3 那张表）：
  > \`package.json\` 的 \`files\` 已有 \`lib/\*\*\`、\`release.mjs\` 的发放白名单已有 \`lib\\/.+\`，
  > 所以两张表一个字都不用动，唯一要改的是架构域表里加一行 \`katex\`（那张表本来就是为「新增一级
  > 目录要登记」而存在的）。实测过放进 \`lib/\` 不会让另外两份扫描器误报（注释路径、路由错误码、
  > 以及 272KB min.js 过一遍那个手写状态机）。另两条候选各有硬伤：\`templates/assets/\*\*\` 被两个
  > 宿主插件套件明令禁止（\#83 拆掉的旧布局），新开 \`vendor/\*\*\` 要同时改两张表。
  > 
  > - \*\*随包发\*\*：\`lib/katex/\` = \`katex.min.js\` + \`katex.min.css\`（裁到只剩 woff2 回退）+ 20 个
  >   \`fonts/\*.woff2\` + MIT 的 \`LICENSE\`（两处）+ \`README.md\`（来源与更新步骤）。约 610KB。
  >   从机器解析那条路（像 React 那样）被否掉：一台只装了 StudyMate 的机器上一条候选都不命中，
  >   公式全退化成原文，与「自带」冲突；而且 React 缺了页面起不来、KaTeX 缺了只是降级。
  > - \*\*Host 半\*\*：\`lib/math.ts\` 是 dist 的唯一一份清单（精确 MIME + 复用 \`lib/paths.ts\` 的越界
  >   判据），\`lib/math-route.ts\` 按它注册\*\*一条文件一条精确路由\*\*（23 条，都在 \`/api/studymate/math/\`
  >   之内——不另开前缀路由，那会盖过 \`/api\` 连同它的 Host/Origin 围栏与认证一起绕过去）。
  > - \*\*阅读端\*\*（\`lib/client.js\`，零构建单文件，不改契约）：\`MathSpan\` 是唯一的排版入口，正文
  >   行内/块级与题库字段（题面/选项/参考答案/判分要点/解析）都走它。资源\*\*只在真的渲染出一个
  >   数学元素时\*\*才取（所以「公式只在题面里」照样加载，没有数学式的页面零请求），元素里先放
  >   TeX 原文（引擎没到位/加载失败时降级可读，不白屏），失败时多一句「公式没排出来：…」。
  >   题库字段只接数学式——粗体/反引号/链接保持字面量（那是行为变化，不在本票里）。
  > - \*\*导出产物\*\*：引擎走 \`vendorFile()\` 包壳 + \`third\_party\` 哈希（直接放根目录会被守卫的
  >   \`node-module-exports\` 判红，实测），CSS 与字体落 \`assets/katex/\`（字体放别处会因 utf8 读坏
  >   而与清单字节数对不上，实测），\`scriptFiles()\` 把引擎排在阅读端本体之前，\`host.js\` 用
  >   \`window.\_\_STUDYMATE\_MATH\_\_\` 声明产物内位置、\`boot.js\` 把引擎从模块表挂成 \`window.katex\`。
  > - \*\*套件\*\*：新两条 Node 套件（dist/路由对账；题库字段只接数学式、降级可读）、一条浏览器套件
  >   （真 HTTP 迷你宿主投送真 dist：排出来、只写在题面里也加载、无数学式零请求、资源缺失降级、
  >   坏 LaTeX 报错），并把导出套件里那条\*\*假绿\*\*断言（只匹配 TeX 原文）换成「真的排出来了」，
  >   外加题面公式、字体加载两条。README 与两份规范里的悬空指针（\`lesson-math.js\`、\`react.ts\`）
  >   一并改掉。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/91-math-typesetting ([6442f6d](https://github.com/Miaotofu01/Study-Mate/commit/6442f6d384eec142591d1dac500faa81c9511493))
- merge(阅读端): 集成分支 tip（已合 \#90）合进 \#88 三栏几何 ([86bb39f](https://github.com/Miaotofu01/Study-Mate/commit/86bb39f533f274a71feb80e444c70b065d65490e))

  > \#88 基于旧 tip 4bb1671，集成分支已到 5a20e6d。先按规矩把集成分支合进票分支，
  > 两处冲突：
  > - scripts/tests/README.md：同一个套件行两边都改过（\#88 的紧档 700×900 + 几何扫描，
  >   \#90 的空态/搜索/卡点得进去），两边说法都留，只把已被 \#90 并成一条的
  >   「两条 max-width: 900px 规则」措辞收成事实。
  > - scripts/tests/browser/reading\_routes\_test.mjs：对账场注释。场景集合两边都留
  >   （\#88 的紧档与几何扫描 + \#90 的空态/半份数据/搜索长 URL），\#88 那段
  >   「死声明只记不判」已被 \#90 的「死声明修活并升成断言」取代，取 \#90 那段，
  >   并保留 \#88 的三栏几何三档对账说明。

- test(公式): 请求日志进 metrics，两份许可证分开主张（\#91） ([08d5428](https://github.com/Miaotofu01/Study-Mate/commit/08d5428b18ead986a62226bb19ba1c7635933120))

  > - 浏览器套件把每个场景打到的 /api/studymate/math/\* 请求记进 metrics：「页面不含数学式时
  >   不加载排版资源」这条验收要的是\*\*可核对的读数\*\*，落在 summary.json 里（no-math 那场是空数组）。
  > - KaTeX 的字体是 SIL OFL 1.1（带保留字体名），与代码/CSS 的 MIT 是\*\*两份不同的许可\*\*：
  >   导出产物里两份都带上（assets/katex/LICENSE 与 assets/katex/fonts/LICENSE），并把这件事
  >   在两条套件里钉住——合成一份就是漏发许可。README 那句写错的一并改掉。

- merge(阅读端): 三栏几何重写成纯函数，窄画布降级抽屉，窄轨宽收成 token（\#88） ([eb56e06](https://github.com/Miaotofu01/Study-Mate/commit/eb56e068fbf08ba77ad4e12c19ad3c8858f4e717))

  > 这张票干了什么：
  > - 三栏几何抽成纯函数 planPanes / drawerWidth / clampPane / clampDrawer（ADR-0011：
  >   右栏先拿、左栏先让、中栏永远保底 MIN\_CENTER=420），挂到 window.\_\_STUDYMATE\_PURE\_\_；
  > - 并排装不下时\*\*不再静默归零\*\*：那一栏改成盖在正文上的抽屉（PaneDrawer：顶上一条
  >   「窗口太窄」说明 + 一条「收起」），题目与选项照旧点得到做得了；
  >   .smb-lesson 上用 data-left-mode / data-right-mode 报出三种形态；
  > - 窄轨宽收成唯一一处 --smb-rail，脚本量渲染出来的窄轨再传进几何，把手落点不再
  >   在脚本里另算 38 + width − 3；
  > - .smb-doc 测宽改成 min(100%, clamp(760px, 66%, 900px))（760 下限 / 66% 占宽 / 900 上限）；
  > - ADR-0011 的两条后果按实现修正，并补上降级形态；
  > - 新增 scripts/tests/test\_client\_panes.mjs（17 条纯函数判据）并登记进 checks.mjs；
  >   reading\_routes\_test.mjs 加紧档 700×900 与 1440/1100/900/776/700 一场几何扫描。
  > 
  > 验收怎么验的：
  > - 主检出 npm test 全绿（typecheck / 安装器 / openai / antigravity / checks.mjs 全量
  >   node 套件 / static）；
  > - npm run test:browser 全绿（25 张截图 + summary.json）：四路由套件在紧档 700×900 取到
  >   reading-routes-panes 的抽屉形态（说明 + 收起 + 题干与可点选项都在），五档几何扫描的
  >   栏形态、中栏保底、把手落点（窄轨量出来的）与 1440 宽档正文列占比都对上，
  >   「让步不回写记忆值」与 \#90 的空态/搜索场景同为 PASS。

- merge(阅读端): 集成分支 tip（已合 \#88）合进 \#89 正文与页头收口 ([83a4986](https://github.com/Miaotofu01/Study-Mate/commit/83a4986ac9e29767208a515712f38fe116a31adb))

  > \#89 基于旧 tip 4bb1671，集成分支已到 eb56e06（\#88 三栏几何 + \#90 四路由）。
  > 把集成分支合进票分支，冲突都在 lib/client.js，三处：
  > - .smb-doc 那一行：两边都改过——\#88 的测宽 min(100%, clamp(760px, 66%, 900px))
  >   与 \#89 的 overflow-wrap: anywhere / h1 引字号 token。取两者的并集，
  >   并把「900px 是按 13px 正文一行约 69 个汉字算的」写进注释（\#89 的正文档就是 13px）。
  > - .smb-hit 三条：\#90 把正文挪进 .smb-hit\_\_body（出处改两行）与 \#89 的
  >   font-size: var(--smb-fs-body) 合并：保留 \#90 的 .smb-hit\_\_body 结构，
  >   .smb-hit\_\_text 用阶梯 token 且留 overflow-wrap: anywhere（两条守卫都要绿）。
  > - 窄档 @media 块：\#90 已把它挪到被覆盖的基础规则之后，\#89 又把它并成一块放到
  >   全文件最后。取 \#89 的位置（块内 .smb-crumb 用 12em——\#89 的面包屑按全角字算，
  >   \#90 的 14ch 会让 typography 套件的「不许用 ch」判红），并删掉 .smb-tiles
  >   那条已死的窄档覆盖（\#90 把 .smb-tiles 的基础规则与 markup 一起删了）。

- merge(阅读端): 正文与页头收口——字号行高成套、配图两条路、长内容不撑版（\#89） ([f4efd57](https://github.com/Miaotofu01/Study-Mate/commit/f4efd579447eaabcd3682594643b2dc01ace1205))

  > 这张票干了什么：
  > - 字号与行高立成\*\*配对 token\*\*（--smb-fs-\* / --smb-lh-\*，行高一律无单位数）：正文只有
  >   一档 13px/1.65，成句的文字全引 --smb-fs-body，≤12px 的字面值只留给元信息档；
  > - 正文与页头收口：顶部两条（标题条 + sticky 小节条）合成一条（.smb-center\_\_head，
  >   课件标题 + 小节跳转 + 作答进度），.smb-secsbar 及其 CSS 一并删掉；
  > - 配图两条路：位图 max-width: 100% + height: auto 受列宽约束，矢量图随列宽流动，
  >   暗色（body\[data-ds-dark-theme\]）下一起压到 85% 亮度；
  > - 长内容不撑版：.smb-doc 上 overflow-wrap: anywhere、宽表格横向滚动留在自己那一层、
  >   &lt;pre&gt; 块内横向滚动；代码块语言 chip；题目标记带组号（与右栏 .smb-agroup\_\_no 同数）；
  > - 面包屑按全角字省略（宽档 18em / 窄档 12em，替掉 22ch/14ch 的「按数字宽算」）；
  > - 窄档 @media 块并成一块、挪到被覆盖的基础规则之后（原来三条声明是死声明）。
  > 
  > 验收怎么验的：
  > - 主检出 npm test 全绿（265 + 710 + 60 组 node 判据）；npm run test:browser 全绿：
  >   reading / 阅读位置 / attempts / watch-push / lab-run / export-file / reading-routes
  >   与新增的 lesson-body 全部「通过」，控制台错误、页面错误、失败请求全干净；
  > - lesson-body 套件宽窄两档实测：正文取样点 10 处字号都是 13px、实测行高比都是 1.65
  >   （21.45px），顶部只数到一条（bars=1），面包屑宽档露 17 字 / 窄档露 11 字；
  > - 跨票复核（\#88 的 900px 测宽上限 vs \#89 的 13px/1.65）：reading-routes 的
  >   「正文列 ≥ 中栏六成、两侧各留 &gt; 100px」在 1440 默认形态下读数 900/1364 = 66%、
  >   两侧各 232px，与 lesson-body 的 13px/1.65 同时成立——900px ÷ 13px ≈ 69 个汉字一行，
  >   正是 \#88 写在上限注释里的依据，两票的字号没有打架。

- merge(公式): 公式排版：离线资源、正文行内与块级、题面与选项、导出产物（\#91） ([5681043](https://github.com/Miaotofu01/Study-Mate/commit/5681043a3d34fc59ee8843bece8eb8db0e5b8768))

  > \#91 把 KaTeX dist 随包发（lib/katex/\*\*，25 个文件 / 612K），阅读端在浏览器里离线排版，
  > Host 半逐条投送，导出产物把同一批字节搬进去。
  > 
  > 做了什么
  > - 随包 dist 与唯一清单：lib/katex/\*\*（katex.min.js / katex.min.css / 20 个 woff2 字体 /
  >   两份许可证 / README，MIT 与 SIL OFL 1.1 分开主张）；清单与取址判据只在 lib/math.ts
  >   一份（含越界与解掉符号链接之后的真实路径判据）。
  > - Host 半：lib/math-route.ts 按「一条文件一条精确路由」注册 22 条 GET 路由（2 个文件 +
  >   20 个字体），精确 MIME（不复用只认图片的 contentTypeOf）、cache-control: no-store、
  >   注册走 connectionCtx.effect；bin/dsh-plugin.ts 只挂一条，不认识它的形状。
  > - 阅读端（lib/client.js）：正文行内/块级与题库字段里的公式都排版；容器里先放 TeX 原文，
  >   引擎到位才换成 KaTeX 输出（降级可读）；排版失败时多一句「公式没排出来：…」。
  > - 导出（lib/export/page.ts、lib/export/plan.ts）：引擎走 vendor 包装壳（避开泄漏守卫的
  >   node-module-exports，并按 third\_party 的哈希核对），CSS 与字体落 assets/katex/，
  >   两份许可证随副本分发。
  > - 文档：工程约束（katex 域登记、math 路由）、课件内容格式（公式一节）。
  > 
  > 验收怎么验的
  > - npm test：全绿（typecheck / installer / openai / antigravity / checks.mjs core / --static；
  >   test:static 60 pass / 0 fail）。
  > - npm run test:browser：全绿（真 Chrome）。\#91 的三条套件读数：
  >   · browser/math\_test.mjs：行内/块级公式排出来（.katex 在容器里、document.fonts.check 的
  >     KaTeX\_Main 真的加载），请求日志显示按需只取 css + js + 用到的字体；没有数学式的页面
  >     零请求；题面与选项里的公式在打开题库那一刻才取资源；资源缺失降级成可读 TeX + 一句人话；
  >     坏 LaTeX 给同一句错且不影响别的公式。
  >   · browser/export\_file\_test.mjs（file:// 下的真产物）：把假绿断言（原来只匹配 TeX 原文）
  >     换成「真的排出来了」——.katex 在容器里、TeX 从 annotation 读回、字体真的加载，
  >     题面里的公式同样排版。
  >   · browser/reading\_routes\_test.mjs：走 file:// 的夹具声明「资源已由宿主备好」，不再制造
  >     注定失败的请求；真排版在 math\_test 与 export\_file\_test 里验。
  > - 额外三条：npm pack --dry-run --json 181 个条目 / tarball 2.265 MiB（≈2.26MiB），
  >   lib/katex/\*\* 25 个文件（564,298 字节）确实进包；npm run guard:export 干净（36 个产物 /
  >   11 个文本产物，无 Node 专用依赖、第三方哈希对得上）；git ls-files lib/katex = 25。
  > 
  > 已知缺口（另开 \#96 跟踪）：导出产物目前\*\*总是\*\*带 KaTeX——一门完全没有数学式的科目导出后，
  > 页面照样会取那 272KB 的 vendor script（只登记进模块表、不执行），与课件内容格式的检查项 11
  > 「非数学课与老课件的产物零变化」不符。
  > 
  > 合并冲突（两边各加一段，按「两边都留」解决）：lib/client.js 的公式降级样式与代码块注释、
  > scripts/release/checks.mjs 的套件登记（留 \#91 的 math\_test 与集成分支较新的 \#86 三档说明）、
  > scripts/tests/README.md 的套件表（留 \#91 的 export\_file\_test / math\_test 与 \#89 的
  > lesson\_body\_test 三行）。

- merge(问答面板): 集成分支 f4efd57 合入——阅读端引用与右栏抽屉、字号行高 token 两边都留（\#92） ([4720617](https://github.com/Miaotofu01/Study-Mate/commit/472061774e6604abd6e53914d69a6ae68a725c99))

  > 冲突三处，都是「两边各加一块」：
  >   · lib/client.js 的 .smb-quote：集成分支把字号换成了 --smb-fs-body token（\#89），
  >     我这边在它后面加了引用块的原文/来源/删掉三条子规则——保留 token，子规则接在后面；
  >   · lib/client.js 的右栏：集成分支把右栏拆成 inspector（并排 column / 盖在正文上 drawer，
  >     \#88），我这边把引用那条数据传进 Inspector——把 quote/liveQuote/onQuoteClear 挪进
  >     inspector 那个 const，column 与 drawer 两条路都吃同一份；
  >   · checks.mjs 与 scripts/tests/README.md 的浏览器套件表：\#89 的 lesson\_body\_test.mjs
  >     与我的 ask\_quote\_test.mjs 两行都留。

- merge(问答面板): 选中正文变成一条留得住的引用（\#92） ([05513f3](https://github.com/Miaotofu01/Study-Mate/commit/05513f3a9c923225a140dc507bbe144a4e71b5ed))

  > 票分支 ticket/92-ask-selection（2 个提交）合进 refactor/reading-end-and-ts-engine。
  > 它原来基于 f4efd57，集成分支已是 5681043（\#91 已合），所以顺带把 f4efd57..5681043
  > 那一段并进来。\*\*没有真冲突\*\*：git 自动合并四处，逐处核对「两边都留」都成立——
  > 
  >   · lib/client.js：\#91 的公式渲染与降级样式、代码块语言标签，与 \#92 的问答面板、
  >     \`.smb-quote\` 原文/来源/删掉三条子规则，各在各的区域；
  >   · scripts/tests/fixtures/mini-react.js：\#91 的 \`dangerouslySetInnerHTML\`（191 行）与
  >     \#92 的回调 ref 支持（178 行）两处保真扩充都在；
  >   · scripts/release/checks.mjs：\#91 与 \#92 的登记行都在（core 组 test\_client\_ask\_quote.mjs、
  >     --browser 组 browser/ask\_quote\_test.mjs）；
  >   · scripts/tests/README.md：\#92 的 ask\_quote\_test.mjs 那一行在。
  > 
  > 这张票干了什么
  >   · 选中的正文原本是\*\*跟着实时选区跑的字符串\*\*：document 级 mouseup 每次都读
  >     \`window.getSelection()\`，判定失败（少于四个字、锚点不在正文里）就写空串。点输入框、
  >     点面板别处、切 tab 都会让浏览器把文档选区折叠成空，于是那一次 mouseup 判定失败，
  >     学生刚划出来的引用就没了。现在捕获那一下把选区\*\*冻成 \`{ text, anchor }\`\*\*——
  >     文本 + 来源锚点（哪一课、哪一小节的 id 与标题），锚点只能在这时候取。
  >   · \`captureQuote(prev, 实时选区, 正文节点, 这一课)\` 读不出合格的一段时返回\*\*上一份
  >     （同一个对象）\*\*，React 靠同引用跳过重渲染。
  >   · 清除只留两处：学生点引用上的「删掉」，或提交成功（那一刻引用已随问题落进误解记录）。
  >     换视图/换课不再清——引用自带来源，别的课按 \`anchor.lesson\` 守一道，拿不到就不会串课。
  >   · 提交时 \`selection\` 送原文、\`selectionAnchor\` 送锚点；宿主半把锚点写进模型上下文
  >     （引的是哪一小节），并把引用原文与来源一起写进误解记录的 evidence，超长按码位截断标注。
  >   · 夹具 mini-react 原来只认对象 ref，而正文滚动区挂的是\*\*回调 ref\*\*，\`bodyRef.current\`
  >     恒为 null（引用永远捕不到）——补上回调 ref 支持；这是夹具边界，不是产品缺陷。
  > 
  > 顺带（同一张票划给收尾的一处文档不一致）：scripts/tests/README.md 那句「五套真实浏览器
  > 渲染测试」已过时，改成十套并补上列举——按 \`--browser\` 组的登记表与 README 自己的浏览器套件
  > 表逐条数出来的实际套数。
  > 
  > 验收怎么验的
  >   · \`npm test\` 全绿（exit 0）。
  >   · \`npm run test:browser\` 全绿（exit 0，真 Chrome 10 套），含新套件
  >     \`browser/ask\_quote\_test.mjs\` 用 CDP \`Input.dispatchMouseEvent\` 做真鼠标拖拽：
  >     选中 → 浮出「就这段问一句」→ 打开问答 → 点输入框 / 打字 / 切 tab 再切回，引用都在；
  >     关键读数 \`quoteKeptAfterClick=true\`、\`quoteKeptAfterTyping=true\`、
  >     \`quoteKeptAfterTabSwitch=true\`、\`liveSelectionAtClick=""\`（点输入框那一下实时选区就是空的，
  >     正是原来的病根）。四场：留住 / 显式删掉 / 无引用 / 无可用模型（如实说明且不清引用）。

- feat(阅读端): 右栏题库的呈现收口——题型徽标贴字、当前组、右栏 tab、只纵向滚（\#93） ([f27f25e](https://github.com/Miaotofu01/Study-Mate/commit/f27f25ea6eb2c5b71e143a7606e638f06d933b4e))

  > 父 spec \#84 的「呈现·右栏题库」那五条（条目 17/18/19/21/22）一次收口。四条是「写了样式
  > 但没接线」，一条是「长 token 把内容顶出滚动条」——都是看起来没事、只在窄栏或长内容下
  > 才露出来的坏法，所以每条都配了真浏览器里的关系式断言（宽窄三档各跑一遍）。
  > 
  > · 条目 17 题型徽标：\`.smb-q\_\_ask\` 是弹性行，默认 \`align-items: stretch\` 把徽标拉成与
  >   整段题干一样高的一根竖条（\#86 实测约 150px；新夹具上量到 45–88px，题面越长越夸张）。
  >   改成 \`flex-start\` 对齐（"Q1" 角标自己有 padding-top，与题干首行照样齐）。徽标同时拿到
  >   自己的钩子 \`.smb-q\_\_kind\`：套件里那条「右栏·题型徽标」的对比度取样点原来指
  >   \`.smb-chip--kind\`，命中的其实是顶部那条里的节点类型 chip——现在真的落在徽标上。
  >   读数：三档 × 三种题型一律 49×22px（原来 45–88px）。
  > · 条目 18 当前组：点正文标记 → 右栏那一组是「当前」。样式本来就写了，但挂在
  >   \`.smb-anchoritem\[data-active\]\` 上——那是这张卡改名之前的类名，零引用，所以「当前」态
  >   从来没出现过。挪到实际渲染的 \`.smb-agroup\` 上，属性用 \`aria-current\`（与本文件里节点、
  >   小节、面包屑的「当前」同一套）：语义与样式同源。顺手把 focus 钉在课上（带上 node，量与
  >   判断都按 node 收）：LessonPage 换课不重挂，不收一下的话下一课会凭空冒出一个「当前」标记。
  > · 条目 19 tab 选中态：右栏专用那条下划线规则（\`.smb-rtab\`）零引用，实际用的是左栏那套
  >   胶囊（\`.smb-tab\`：99px 圆角 + 选中换底色）。标记改成 \`smb-rtab\`；胶囊那两条规则改完
  >   全仓零引用，一并删掉——写了样式没接线正是这张票在治的病。另外检查器现在交出一个根节点
  >   （\`.smb-inspector\`，纵向弹性列）：抽屉那条弹性行（\`.smb-drawer\_\_body\`）会把两个兄弟节点
  >   并排放，紧档量到 tab 条被摊成 184×795 的一竖列、内容从右半幅开始（选中态再对，学生也
  >   看不到设计的样子）。三档实测：tab 条在内容上方、与内容同宽同起边。
  > · 条目 21 上次作答：能力没动，套件守住它——夹具里现写一份 \`attempts/&lt;NNNN&gt;-&lt;节点&gt;.json\`
  >   （节点 id 必须是 ASCII，\`attempts.ts\` 的 \`NODE\_ID\_RE\` 只认它），右栏那题上就该有
  >   「上次选了 A，对了」；切到问答再切回来还在，就地作答之后换成「上次选了 B，错了」。
  > · 条目 22 只纵向滚：\`overflow-y\` 一旦不是 visible，横向按规范会自己算成 auto，于是题干或
  >   选项里一个不含空格的长 token 就筛出一根横向滚动条。横向显式 hidden，并让长 token 折行
  >   （\`overflow-wrap: anywhere\` 而不是 \`break-word\`——anywhere 参与 min-content 计算，
  >   弹性行与网格轨道才肯跟着收缩）。两条要一起：只 hidden 会把字裁掉。
  >   ⚠ 这条的判据不能只看 \`scrollWidth\`：\`.smb-agroup\` 自己带 \`overflow: hidden\`，题干被顶宽时
  >   不是出滚动条而是\*\*被裁掉\*\*——第一版断言就是这么假绿的（滚动条 0、字已经没了）。所以
  >   现在连着量「内容右边缘有没有越过裁切线」，修之前宽档越过 279px、紧档 462px。
  > 
  > 套件：+2 场 × 三档（宽 1440 / 窄 800 / 紧 700，并排与抽屉两种形态都跑）+ 对账那一场加
  > 五条跨档断言；夹具另造一份（三种题型各一组、题干与选项各一段无断点长 token、一次落盘的
  > 作答、第二课用来验「当前不跟过去」）。\`-quiz-marked\` 把镜头停在点过标记之后，三档截图可判。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/93-inspector-presentation ([f9b5320](https://github.com/Miaotofu01/Study-Mate/commit/f9b5320e3469a9b9efb9a6cd027647df0a8a1a26))

  > \# Conflicts:
  > \#	lib/client.js

- docs(验收): 阅读端呈现对照表与真宿主 DPR 实测读数（\#94） ([c367fd4](https://github.com/Miaotofu01/Study-Mate/commit/c367fd4c50e97c9d39e9fad7e8bb4bdb39bc3ad1))

  > 票 \#94 要交的是「这份 spec 有没有被实现」的证据，不是产品改动。这一笔落两样：
  > 
  > · \`docs/设计/阅读端呈现验收-2026-10-05.md\`——spec \#84 的 41 条 user story 逐条对照
  >   （每条给出落在哪、证据是哪条断言/哪张截图，未达成的如实标出并写去向），以及真宿主
  >   带 DPR 的实测结论。
  > · \`docs/images/验收-2026-10-05/\`——四个面的当轮截图（宽档 + 课件页窄档/紧档）与真宿主
  >   的两张。浏览器套件自己的产物在 \`.shots/\`（gitignore），这里是把要长期引用那几张拷进库，
  >   免得评审只能看到一份一次性附件。
  > 
  > DPR 那条结掉了 spec 的「待实测」：在隔离 HOME 里起的真 DSH（0.2.0-rc.2，插件指到本
  > worktree）里量，正文列 CSS 宽 712 / 物理宽 712（DPR 1）与 1424（DPR 2）——同一视口下
  > CSS 几何逐项相同，DPR 只做乘法；「约 500 物理像素」对上的是两条栏都拉开时的中栏 448。
  > 所以上一轮那个矛盾不是 DPR 造成的，是画布可用宽与「上限」被当成同一个量比了。

- merge(阅读端): 右栏题库的呈现收口（\#93） ([4fdfe5f](https://github.com/Miaotofu01/Study-Mate/commit/4fdfe5f9ed6640a07882b04d858985f767c56bcd))

  > 把 ticket/93-inspector-presentation（2 个提交）合进集成分支。分支已先合过 05513f3，
  > 本次零冲突（集成分支是它的祖先），lib/client.js 里 \#93 的 current 与 \#92 的
  > quote/onQuoteClear 两套改动并存。
  > 
  > 这张票把右栏题库的五处呈现收口（\#86「现状与差距」里点名的那几条）：
  > - 题型徽标：题面那行是弹性行，默认 stretch 把它拉成与整段题干等高的一根竖条
  >   （\#86 实测约 150px）。改成 align-items:flex-start，徽标回到贴字的标签（49x22px），
  >   并给它自己的钩子 .smb-q\_\_kind（原来套件的取样点命中的是顶部那条节点 chip）。
  > - 「当前」组：两条画法本来就写了，却挂在改名前的 .smb-anchoritem\[data-active\] 上，
  >   零引用——所以「当前」从来没出现过。挪到实际渲染的 .smb-agroup\[aria-current="true"\]，
  >   并由 Inspector 接线（focus 带上课，换课不跟过去）。
  > - 右栏 tab：从借来的左栏胶囊（.smb-tabs/.smb-tab）改回右栏专用的下划线
  >   （.smb-rtab\[aria-selected\]），胶囊那两条零引用规则一并删除。
  > - 抽屉里的检查器：Inspector 原来交出两个兄弟节点，抽屉 body 是弹性行，于是 tab 条
  >   被摊成左边一竖列。改成交一个 .smb-inspector 根（纵向弹性列），两种形态同一份 DOM。
  > - 只纵向滚：.smb-right\_\_body 加 overflow-x:hidden + overflow-wrap:anywhere。
  >   两条要一起——只 hidden 会把文字裁掉，只折行挡不住别的宽内容。
  > 
  > 验收（两道门禁都在合进来的树上跑，读数如下）：
  > - npm test：60/60 通过（含 test:types / installer / openai / antigravity / checks.mjs / static）。
  > - npm run test:browser：10 套套件全绿（reading、阅读位置 29/29、attempts、watch-push、
  >   lab-run、export-file、math、reading-routes、lesson-body、ask-quote）。
  >   reading-routes 三档读数：徽标三档都是 49x22；右栏无横向溢出（371&lt;=371 / 303&lt;=303 /
  >   372&lt;=372）；长 token 的越界量（overhang）宽档 -12/-60/-73、窄档 -12/-12/-12、
  >   紧档 -12/-61/-74；wide/narrow 是并排的一栏、tight 是抽屉，两种形态下同一套断言都过。
  > 
  > 一条假绿记在这里：.smb-agroup 自带 overflow:hidden，长 token 是被裁掉而不是顶出
  > 滚动条，只量 scrollWidth 会把「字被裁」判成「没有横向滚动条」。改成量内容右边缘
  > 与裁切线的差（metrics 里的 overhang）：修前宽档裁掉 279px、紧档 462px，修后为上面的负数。

- Merge branch 'refactor/reading-end-and-ts-engine' into ticket/94-acceptance ([c8f6f59](https://github.com/Miaotofu01/Study-Mate/commit/c8f6f59341e4976aab1eb91869958810f4de1c54))
- docs(验收): 合入含 \#93 的集成分支后，用那一棵树的读数与截图定稿对照表（\#94） ([d8a1104](https://github.com/Miaotofu01/Study-Mate/commit/d8a1104ddd8baefdd69d778195a07a1402442628))

  > \#93 在本票第一轮门禁之后才合进集成分支（tip 05513f3 → 4fdfe5f），所以右栏那五条
  > （US 17/18/19/21/22）先按「当轮未覆盖」记。这一笔做的是收口该做的事：
  > 
  > · \`git merge refactor/reading-end-and-ts-engine\` 把含 \#93 的 tip 合进来；
  > · 在\*\*那一棵树\*\*上重跑 \`npm test\`（退出码 0）与 \`npm run test:browser\`
  >   （483 条 PASS / 0 条 FAIL，九套逐条通过），把这两条的门禁读数与尾巴写进 §七；
  > · 用 \`summary.json\` 里的实测读数填 US 17/18/19/21/22：题型徽标 49×22px（字号 11px，
  >   不比自己那行字高）、「当前」恰好一组（\`current = \[no:"2"\]\`）、右栏 tab 是 \`smb-rtab\`
  >   的下划线（选中不换底色）、上次作答 \`inPage\` 在栏内、右栏 \`clientWidth = scrollWidth = 371\`
  >   且 \`innerOverflowX = 0\`；
  > · 截图集整体换成这一轮的（新增 \`reading-routes-wide-quiz-marked\`，\#93 的「当前」组
  >   就靠它看），§一 的说明也跟着改（31 张里入库 7 张，其余写清怎么复现）；
  > · 真宿主 DPR 那六组在合入前后各量一遍，\*\*逐项相同\*\*——\#93 动的是右栏呈现，不动正文列宽，
  >   这一点写进 §二 免得读的人以为读数是从旧树抄来的。
  > 
  > 对照表最终口径：41 条里 40 条已达成、1 条未达成（US 36，去向是宿主侧缺口）。

- docs(验收): 补真宿主门禁 test:dsh 的当轮读数，并收口两处表述（\#94） ([e607b91](https://github.com/Miaotofu01/Study-Mate/commit/e607b910ced0ce3b223089bb3ea90560f38efbb3))

  > 施工说明把 test:dsh 列成可选门禁（跑不了或超时就如实写）。这一轮跑得动：本机宿主
  > 0.2.0-rc.2，六个场景全绿、退出码 0，\`modelRequestsIssued: 0\` 那条边界不变。
  > 把它补进 §七 的门禁表，免得读的人以为真宿主那半只有本票自己的探针在撑。
  > 
  > 顺带两处表述收口：§一 的截图表按「浏览器套件 → 真宿主」重排，并把「入库 7 张」说清
  > 是四路由那 7 张（真宿主另 3 张），剩 24 张只留复现方式。

- merge(验收): 阅读端呈现验收：四路由截图、真宿主 DPR 实测、41 条对照（\#94） ([e68c212](https://github.com/Miaotofu01/Study-Mate/commit/e68c21288a401de666ac31f93366b35a84f24f56))

  > 只新增文档与图片，不改产品代码。
  > 
  > 交了这些：
  > - 对照表 docs/设计/阅读端呈现验收-2026-10-05.md（283 行）：四路由截图索引、
  >   真宿主 DPR 实测读数、41 条 story 逐条对照、未达成清单、诚实边界、复现方式。
  > - 截图集 docs/images/验收-2026-10-05/（10 张 PNG 入库）：四路由宽带/窄带各态 7 张
  >   + 真宿主 1440x900 DPR1/DPR2 三条读数 3 张。
  > 
  > 结论：41 条对照已达成 40 / 未达成 1（US 36 → 宿主侧缺口）。
  > 真宿主 DPR 三条读数：DPR 只做乘法、不参与布局；「约 500 物理像素」对上的是
  > 两条栏都拉开时的中栏 448；760px 上限在 1440 视口下没生效。
  > test:dsh 6/6。
  > 
  > 验收：分支已合过集成分支 tip 4fdfe5f，本次在合后的树上跑 npm test（60/60 通过，
  > 含 test\_docs\_references 的悬空引用检查）与 npm run test:browser（ask-quote 全通过）
  > 双双全绿后才提交。

- docs(阅读端呈现): 把 spec \#84 里稳定下来的呈现条目收进 docs/规范/（\#95） ([2c5e574](https://github.com/Miaotofu01/Study-Mate/commit/2c5e5744e1cf4b99e03be9be97aa13f2bb35376f))

  > spec \#84 只活在 issue 里，而仓库的「唯一出处」规矩要求把稳定下来的条目落成规范文件——
  > 否则下一个人只能靠搜 issue 找到它。这一轮 \#88–\#93 已实现、\#94 已逐条验收（41 条里 40 条达成），
  > 够稳定了，所以收口成文。
  > 
  > 落点选「新增 docs/规范/阅读端呈现.md」，而不是扩写 工程约束 §二：
  > §二 是「目录与规则归属」（路径、维护者、可见边界、工具指针），呈现条目是另一类约束——
  > 长在 lib/client.js 的呈现面上、由浏览器套件与截图验收，塞进去会把那节变成杂项柜；
  > docs/规范/ 现在是按主题一份文件（工程约束／课件内容格式／文件归属／Agent 交接协议），
  > 多这一份与既有布局一致。归属与维护者按 §二 的规矩登记：目录树里列出本文件，
  > 规则归属表里写明它是呈现条目的唯一出处、维护者是仓库维护者、随它一起改的是呈现面那批套件；
  > README、CONTRIBUTING、AGENTS 各加一条指针。
  > 
  > 只收稳定的、这一轮真做到的：
  > - 四个面的呈现意图（课件页正文、右栏与三栏让位、主页/科目主页/搜索、四个面共同的对比度与动效）；
  > - 问答引用的保持行为（\#92）：捕获那一下冻成数据、读到空选区不得清已存在的引用、清除只有两处。
  > 与既有规范不重复的只给指针：公式排版的分工与降级已经在 课件内容格式 §3（本轮不搬，
  > 搬一份就是第二份会漂的副本）、三栏让位顺序与阈值归 ADR-0011、形状归 目标态规格 §4、
  > 技能与工具的可见边界归 工程约束 §二、术语归 GLOSSARY。
  > 
  > 按 spec 的 Implementation Decisions：呈现条目写成意图级判据，不写数字阈值；
  > 确有必要写的数值（引用最短四字、WCAG AA 的 4.5:1）标了出处与「当前取值」。
  > 用户故事 36 如实交代为未达成（工具/面板/slot 的注册面在预设之外，属宿主侧缺口，
  > 由 test\_skill\_visibility.mjs 钉住），没有写成已达成。

- docs(验收): 验收文档的规范指针改指新的《阅读端呈现》（\#95） ([55bbfa1](https://github.com/Miaotofu01/Study-Mate/commit/55bbfa18a81e277bd0c4f3e89920b9a8c41cd5b4))

  > \#94 那份验收文档的定位句原本写「呈现条目稳定下来的唯一出处是 工程约束 §二 与 目标态规格」，
  > 那是收口前对落点的预判。落点定成 docs/规范/阅读端呈现.md 之后，那句话就成了第二个、且是错的
  > 出处——留着它比没有更坏，所以只改这一句指针（证据与读数一个字没动）：
  > 呈现条目指向新规范，形状仍以 目标态规格 为准，技能与工具的可见边界仍在 工程约束 §二。

- merge(文档): 把 spec \#84 的稳定呈现条目收进 docs/规范/（\#95） ([44622db](https://github.com/Miaotofu01/Study-Mate/commit/44622dbd2d44f8973c22b3ada4564216439bdce1))

  > 纯文档改动，零代码：没有碰 lib/\*\*、bin/\*\*、scripts/\*\*、schemas/\*\* 与任何测试。
  > 
  > 交了这些：
  > - 新增 docs/规范/阅读端呈现.md（152 行，八节）：阅读端四个面「看起来对不对」的
  >   意图判据——正文列与配图、右栏题目/问答与三栏让位、主页与搜索、四面的对比度
  >   与动效档位、公式排版的分工与降级、问答引用的保持行为。
  >   口径照 spec 的 Implementation Decisions：意图级不带数字阈值（确有必要写下的
  >   数字都标「当前取值」）、只写做到了的（未达成的在 §七 写明去向）、
  >   一处定义别处只给指针（形状归目标态规格 §4、三栏让位归 ADR-0011、
  >   公式与配图的内容侧写法归课件内容格式、技能与工具的可见边界归工程约束 §二）。
  > - 只给指针、不复述的条目：\#95 收口时判定「不搬」的公式排版（已住在课件内容格式
  >   §3「数学式」）、技能与工具的可见边界（工程约束 §二 §三）、面板的上下文边界
  >   （目标态规格 §7.4）、形状与让位阈值（目标态规格 §4 / ADR-0011）。
  > - §八 登记「这些条目由谁守」：逐条指到守着它的套件（reading\_routes\_test、
  >   lesson\_body\_test、math\_test、ask\_quote\_test、test\_client\_panes、
  >   test\_client\_typography、test\_client\_tokens、test\_skill\_visibility 等）。
  > - 归属登记改了这几处，都只是一行指针：AGENTS.md（「先读哪份」表新增一行
  >   「改阅读端呈现」）、CONTRIBUTING.md（文件归属表新增 lib/client.js 那一行）、
  >   README.md（文档链接串里加《阅读端呈现》）、
  >   工程约束 §二 的「规则归属」新增一条并写清维护者与随它一起改的面、
  >   docs/设计/阅读端呈现验收-2026-10-05.md 的定位句改指新规范
  >   （原话「稳定下来的唯一出处是 工程约束 §二 与 目标态规格」是收口前对落点的
  >   预判，落点定下之后它成了第二个、且是错的出处；证据与读数一个字没动）。
  > 
  > 未达成（如实记）：spec 的用户故事 36 是这一轮唯一未达成的一条——「工具、面板与
  > slot 不守同一条边界」，前提（宿主提供「按预设注册工具/面板」的接口）不成立，
  > 属宿主侧缺口，不改实现，改为把现状钉住（§七 与 工程约束 §二）。
  > 
  > 未修项（本票范围外，留给后续）：AGENTS.md 第 11 行仍指向
  > 「工程约束 §三 占位符契约、§四 脚本一览」，而 §三 现为「原生工具」、§四 现为
  > 「门禁三层与测试入口」。悬空的是节号而不是文件路径，所以
  > test\_docs\_references 抓不到——本票只改文档指针、不顺手改这条，如实记在 issue 里。
  > 
  > 验收：合并树与集成分支 tip e68c212 同源（merge-base 即 e68c212，无分叉、无冲突）。
  > 在合后的树上跑 npm test 全绿（exit 0；各套件 24/6/6/35/269/745/60 全 pass、fail 0），
  > 其中 test\_docs\_references 单跑 5/5——新文件的相对链接（lib/client.js、
  > GLOSSARY.md、目标态规格、ADR-0011、课件内容格式、工程约束、验收文档）与行内
  > 代码里的仓库路径都真实存在。

- docs(规范): 文档指针与事实对齐——入口行、§二出处、路由第三态、KaTeX 双许可、数学式注入形状 ([454ac30](https://github.com/Miaotofu01/Study-Mate/commit/454ac300c5cd45667f6ba1c79eafe63931ffc3c8))

  > 两轴 code-review（9d05702 → 44622db）里「文档说的和代码/事实不符」那几条，一次改完。
  > 
  > - A1 AGENTS.md 那行还指着 \#83 已删的两节（占位符契约 / 脚本一览）：改成今天真有的活
  >   （原生工具、阅读端 HTTP 路由、预设里那个技能目录占位符）与真有的节（§三 / §二）。
  > - A2 技能可见边界的出处是工程约束 §二（§一是「三个区域，互不混用」）：套件头与
  >   scripts/tests/README.md 两处一起改，与《阅读端呈现》《验收文档》里的写法一致。
  > - A3 §三 的路由清单加了 math，同节却还写「两条路由有意不走这个信封」（只列 asset/events）
  >   ——lib/math-route.ts 回的也是原始字节 + 纯文本 404，是第三条；「注册约定只有一种」的名单
  >   补上 registerMathRoute（按代码核对），与条数绑死的「这五条请求-应答路由」改成不依赖条数。
  > - A4 katex/ 那行只写 MIT：代码与 CSS 是 MIT、fonts/ 是 SIL OFL 1.1，两份许可证都随副本发
  >   （lib/katex/README.md 与 lib/export/plan.ts 都记着）。
  > - A5 课件内容格式 §3 两条 bullet 还写「渲染器…注入那三个引用」：阅读端注入的是一个 &lt;link&gt;
  >   （样式表）+ 一个 &lt;script&gt;（引擎），字体由样式表里的 url(fonts/…) 带出来；「检查项 11 按这条
  >   条件判定」是已退役 Python 校验器的话，换成今天真跑的判据（browser/math\_test.mjs 的 no-math
  >   零请求），并如实写明导出那一侧还差这一步（\#96）。验收文档 §四 第 2 条引用那句话跟着对齐。
  > - C1 US 37 的状态口径自相矛盾（验收表填「已达成」，而它第五条断的正是「工具/面板在标准预设里
  >   也看得见」）：改成「部分达成」——技能那半由前四条断言证明，工具/面板那半不成立（与 US 36
  >   同一条宿主侧缺口）；§三 补上逐行数下来的汇总（39 / 1 / 1），§四 第 1 条把 US 37 的工具那半
  >   一并挂上；《阅读端呈现》§七 里「US 36 是这一轮唯一未达成」也跟着改对。
  > - C4 两条张力如实登记（不改行为）：US 32 让误解记录的 \`位置：\` 多带一节小节（与 spec 的
  >   Out of Scope 有张力），以及「引用不能把提问原文挤掉」这条守卫只保得住一半（question 没有
  >   clamp）——写进验收文档 §五 第 15 / 16 条与《阅读端呈现》§六。
  > - C5 验收文档 §七 写「九个套件」而 checks.mjs 的 --browser 组实际登记 10 套：改成十套，
  >   并说明 \`PASS 483 条\` 来自走共享骨架的九套，自带 CDP 的 reading-position 那 29 条不在里面。

- fix(引擎): 术语与条数散文对齐实现、空工作区导出一句人话、公式断言取真源 ([0961746](https://github.com/Miaotofu01/Study-Mate/commit/09617462ee017158c68ff4a47fcd4e6be341800d))

  > 同一次评审里「会不会误导下一个人」那几条，逐条最小改动（只改注释用词、文案与断言取值，
  > 不动行为）。
  > 
  > - A6 lib/core/ask.ts 的注释收尾符与 buildAskContext 声明黏在一行，拆开。
  > - B1 路由条数散文陈旧：bin/dsh-plugin.ts 的横幅写「另外三条」却压着四条自注入路由，
  >   lib/attempts-route.ts、lib/ask/index.ts（两处）、lib/export/page.ts 两处同病——一律去掉
  >   数字，写成不依赖条数的说法。lib/math-route.ts 那句「逐条注册是 23 条」实测是 22 条
  >   （mathAssets() = 20 个字体 + 引擎 + 样式表），也一并去掉数字。
  > - B2 scripts/tests/test\_client\_math.mjs 那条「必须与 lib/math.ts 逐字一致」是假绿：它拿第三个
  >   字面量在比，改真源照样绿。现在前缀、样式表名、引擎名三个期望值都从 lib/math.ts 取
  >   （反证：临时改 MATH\_CSS 后该断言变红，已还原）。
  > - B3 preset/learning/agent.cordis.yml 的 persona prefix 里是裸相对路径，安装器只换
  >   \_\_STUDYMATE\_SKILLS\_\_、不重写它，而会话可在任意目录启动：改成占位符（安装器换成
  >   &lt;引擎根&gt;/preset/skills 的绝对路径，原生加载那条也走 installPayload），并写清谁负责解析。
  > - C2 spec 的实现决定要求术语按 GLOSSARY.md、不再用「前端」指代阅读端：lib/client.js 三处、
  >   lib/library.ts 一处、lib/attempts-route.ts 四处、bin/dsh-plugin.ts 一处，只改注释用词。
  > - C3 \#90 把「工作区在、零可用科目」从抛错改成空清单之后，lib/export/plan.ts 那条分支第一次
  >   可达，会印出「要的是 ，有的是 （一门都没有）」两个空位：两条来路各说各的话；并在
  >   test\_export\_static\_page.mjs 补一条套件钉住它（它是 Node 套件，不需要新登记）。
  > - C4 两条张力在代码侧的落点也写实：lib/ask/route.ts 注明 \`位置：\` 多带一节是 US 32 驱动的
  >   有意扩展；EVIDENCE\_QUOTE\_LIMIT 的注释改成不夸大（它保不住「提问原文一定不被挤掉」）。

- merge(评审修复): code-review 两轴提出的问题逐条修完 ([bf7eeea](https://github.com/Miaotofu01/Study-Mate/commit/bf7eeea37d964bc3379e3c5c021327de26fb0e1f))

  > 把 fix/code-review-2026-10-05 的两条提交（454ac30 文档指针与事实对齐、
  > 0961746 术语/条数散文/空工作区导出/公式断言取真源）合进集成分支。
  > 两轴评审（标准轴 + 规格轴）提出的 A/B/C 三组问题一并修完：
  > 
  > - A 组（文档指针与事实对齐）：AGENTS.md 的入口行改成真有的活与真有的节；
  >   test\_skill\_visibility.mjs 与 scripts/tests/README.md 的 §一→§二；
  >   工程约束 §三 阅读端路由两条→三条并补 registerMathRoute；
  >   工程约束 的 KaTeX 双许可（代码/CSS MIT + fonts SIL OFL 1.1）；
  >   课件内容格式 §3 注入形状（1 个 &lt;link&gt; + 1 个 &lt;script&gt;，字体随 CSS）
  >   且判据改指当轮真跑的套件；lib/core/ask.ts 的 \*/export 黏行拆开。
  > - B 组（散文与实现对齐，不写死条数）：路由条数的散文改成不依赖条数；
  >   test\_client\_math.mjs 的三个期望值改为从 lib/math.ts 真源取值（反证后还原）；
  >   preset/learning/agent.cordis.yml 的裸相对路径改用 \_\_STUDYMATE\_SKILLS\_\_ 占位符。
  > - C 组（术语、条数、空工作区与张力登记）：验收文档 §三 汇总改成
  >   39 已达成 / 1 部分达成（US 37）/ 1 未达成（US 36）并与逐行一致；
  >   阅读端呈现 §七 同步；术语「前端」→「阅读端」（仅注释与文案）；
  >   lib/export/plan.ts 空工作区导出一句人话 + 一条回归断言；
  >   两条张力如实登记（误解记录 位置： 的有意扩展、截断守卫只保一半）；
  >   验收文档 §七 套件数 9→10（说明 PASS 483 不含 reading-position 的 29 项）。
  > 
  > 验收怎么验的：集成分支 tip 44622db 上 --no-commit --no-ff 试合，零冲突，
  > 合并树与 fix 分支树逐字节相同（无手工改动）。门禁两条：
  > npm test 全绿（fail 0），npm run test:browser 全绿（全部通过，浏览器组
  > 10 个 Node 套件全部有归属）。

- docs(词表): 落「答疑会话」与「问答面板」的新口径（\#102 / \#103） ([29bf9e5](https://github.com/Miaotofu01/Study-Mate/commit/29bf9e5f909326c1bff4e76862e51823e668f5d3))

  > 上一轮对齐时已写好、留在工作树里的两条词表：\#102 的「另需交付」点名它们，
  > \#103 只核对不改。先落进集成分支，后续子票都在它之上开工。

- docs(ADR): 记下「答疑会话」这条决定与它的三条后果（\#103） ([d81473f](https://github.com/Miaotofu01/Study-Mate/commit/d81473fe5b6a2a59005d1f0b3230982b00f0fdb5))

  > \#102 把阅读端的问答面板从「一次一问一答」改成宿主的一条真会话。这条决定难回退、
  > 外人会问为什么、且真的有权衡（真会话 vs 插件自建多轮），按 ADR 的判据记在案：
  > 
  > - 为什么选宿主的真会话：多轮历史、流式、滚动、草稿、附件全走宿主，插件不再自己拼
  >   messages、自己发请求；自建多轮要把这五样重抄一遍，且终会往宿主那边漂。
  > - 难在哪、回退的代价：它压在四条没在真宿主里跑过的宿主能力上；退路是面板自己渲染
  >   消息流（流式、滚动、chip 全自己写）。
  > - 三条已接受的后果：真会话会落盘、会作为普通会话出现在侧边栏、「答疑模式」预设
  >   藏不住（宿主预设注册表没有 hidden/visible 字段）。
  > - 上下文边界改由三处拼出来；面板不再写误解记录。

- docs(规范): 问答面板改成一段答疑会话，引用只跟下一条消息走（\#103） ([5857312](https://github.com/Miaotofu01/Study-Mate/commit/5857312af46f4ad5207d9eaf889706701c2e5647))

  > 目标态规格 §7.4 的旧口径（面板独立调模型、上下文只带三样且不背整个会话、回答无痕
  > 但写一条误解记录）作废，改写成 \#102 Implementation Decisions 的新说法：面板里嵌的是
  > 一段答疑会话，上下文仍只三样但由只读工具、引用 chip、开张时注入的共享记忆三处拼出，
  > 面板不再写误解记录。同一份规格里直接复述这两条的地方（§4.4 的交互表、§11 的差异
  > 一览、§13 的提案）一并改到不打架，并给 §11 补上 ADR-0012 这一行。
  > 
  > 阅读端呈现 §六 的引用清除口径改成「只跟下一条消息走、再选一段就换掉」：提交那一刻
  > 引用就随消息进会话，不必等答成才清；删掉「答成了才清」那套写法，以及连着误解记录的
  > 那一段（面板不再写它）。

- merge(ADR): 记下「答疑会话」这条决定与三处规范的新口径（\#103） ([40f95e0](https://github.com/Miaotofu01/Study-Mate/commit/40f95e07c5f685464ac83a47b114292ec209f615))
- docs(技能): local-qa 改成真会话形态，退役「写误解记录」与「第三次」两族（\#104） ([c631304](https://github.com/Miaotofu01/Study-Mate/commit/c631304853189fd05d0ea8fc62bed246356cea1f))

  > 答疑面板不再是「独立调模型的表单」，它就是宿主的一段答疑会话（多轮、流式、草稿都在
  > 宿主那侧），所以规范里那三处必须换说法：
  > 
  > - 「上下文只带三样」仍成立，但改成由\*\*三处拼出来\*\*：课件由那个只读的取课件工具按需取、
  >   选中的那段随引用 chip 进消息、共享记忆在会话开张时注入一条；
  > - 答复格式与字数上限从「面板自己的系统提示」改归这条答疑预设的人设与本规范；
  > - 整个「答完写一条误解记录」小节（含字段表与「不写 null」）与「同一知识点问到第三次
  >   交给总控」一并退役——面板不再写 misconceptions.yaml，学生真卡住了自己回会话说。
  > 
  > 两处无头宿主的镜像文案（Antigravity 宿主指南两处、Codex 技能元数据三条）与
  > \`learning-system\` / \`record-keeping\` 里同样说「面板会写一条误解记录」的三处散文一起收口：
  > 留着它们，总控会去恢复视图里找一份永远不会出现的记录。
  > 
  > \`test\_skill\_rules\` 的 local-qa 规则表按实际写法收口：退役的 10 条真删，改掉的三条换成
  > SKILL.md 里逐字找得到的新说法，保留的六条一字不动——不许静默少算。

- feat(预设): 注册第二条「答疑模式」预设（\#104） ([84a5fa6](https://github.com/Miaotofu01/Study-Mate/commit/84a5fa681d2cc6729a76b64cdaef52d63ddbd2f3))

  > 预设的 plugins 行就是它的工具面与身份，所以「只答疑」只能由一条\*\*独立预设\*\*给：
  > 
  > - \`preset/qa/\`：persona（阅读端的就地答疑，按 local-qa 的指示答）、\`skill-filesystem\`
  >   （\`includeDefaultRoots: false\` + \`customSkillDirs: \['\_\_STUDYMATE\_SKILLS\_\_/local-qa'\]\`——
  >   根直接指到那一个技能目录，宿主只扫一层，正好给出一个技能；指到 \`preset/skills\` 会给出
  >   全部 12 个，模型就会当起总控、派起角色）、\`tool-skill\`、我们那条工具面行。没有 bash /
  >   文件读写 / 搜索 / jobs / 子 agent / workflow / web / plan / todo。order 取 20，与
  >   「学习模式」的 10 并列而不相同。
  > - \`lib/preset.ts\`：\`installPreset\` 参数化（\`presetId\` 默认仍是 \`learning\`，新增
  >   \`extraPresets\`）。两条预设必须\*\*同一次\*\*产出——托管块的 BEGIN/END 只有一套，分两次调用
  >   后一次会把前一次那块整块剥掉；块里因此是两行 insert。学习那一侧的托管块与 \`config\`
  >   逐字段不变，答疑那条另给 \`qaConfig\`（additive）。冲突检查同时认两条预设的 id。
  > - \`bin/studymate.mjs\`：\`preset/qa\` 进 \`copyPayload\`；暂存与占位符替换对两份预设各做一遍
  >   （含「缺 \`\_\_STUDYMATE\_SKILLS\_\_\` 就抛」的守卫）；占位符替换值仍是引擎侧 \`preset/skills\`，
  >   答疑那条在它后面接 \`/local-qa\`。
  > - \`bin/dsh-plugin.ts\`：native 路径下两条预设各用\*\*自己的\*\* \`ctx.effect\` 与 disposer 注册。
  > - \`package.json\`：导出 \`./qa-preset\`（那条插件行的落点）、\`files\` 加 \`preset/qa/\*\*\`；
  >   Release 的 tarball 白名单与必发清单同步补上（两张表分开维护，漏一张发布时会被自己拦下）。
  > 
  > \*\*已知限制\*\*：只有 0.1.7-alpha.1+ 的声明式那条路（或原生加载）才注册答疑模式——更老的宿主
  > 走 legacy 的独立预设目录，那一份只装学习模式。旧宿主没有新版阅读端，先接受。
  > 
  > \`test\_preset\_install\` 是特征化套件：已有用例一条都没放宽（不带 \`qa\` 时行为逐字不变），
  > 新事实另加三条用例钉住（一个托管块两行 insert、两条 id 都被冲突检查认、bundle 给两份 config）。
  > \`test\_bundle\` 的注册计数按两条预设改成 2；\`test\_skill\_visibility\` 按「两条预设两份声明」
  > 收口，仍要求每条预设里只有一个技能目录声明点、且它真在包里。

- feat(工具): 只读取课件工具 + 答疑会话的工具面收窄（\#104） ([6cddc2c](https://github.com/Miaotofu01/Study-Mate/commit/6cddc2c4bc66280c07968351acb753256911b97e))

  > 答疑会话手上只能有一样能力：按需取当前课件。所以新写一个\*\*只读\*\*工具，并把 profile 根
  > 注册的那批原生工具从这条会话的工具面上抹掉——「只答疑」要是配置层的保证。
  > 
  > - \`lib/tools/lesson-read.ts\`：\`studymate\_lesson\_read\`。给节点 id，跨科目找到那一课，回报
  >   正文与这一节点的题（题库是「锚点 → 题目数组」）；\`writes\` 留空，跑一遍一个字节都不落盘；
  >   不存在的节点、带路径分隔符或 \`..\` 的 id、以及正文还没落盘都回一条结构化「没有」，不抛。
  >   数据只走 \`run.access\` 的 \`lessons\` / \`pool\` 域整体视图——工具只拿得到节点 id，要跨科目找，
  >   而自己拼路径等于在工具里再抄一份工作区布局。
  > - \`lib/tools/qa-preset.ts\`（那条插件行，\`@yunmiao/studymate/qa-preset\`）：把只读工具注册进
  >   \*\*本作用域\*\*（作用域自己那层不受 restriction 影响），再 \`ctx.tools.restrict({ deny: \[...\] })\`。
  >   必须是 \`deny\` 不能是 \`allow\`（host.md Q5 + \`dsh-tools\` 的过滤实现）：restriction 过滤的是
  >   继承来的层，预设行注册的 \`skill\` 与只读工具对 agent 而言都是祖先层，\`allow\` 会把它们一起剪掉。
  >   deny 的名字从三份名字表来（八个学习工具 + 五个任务 + 一个实验）——少 deny 一个就是留一条
  >   能写作答台账、能代跑命令的后门。名字不在注册名册时（旧宿主/某个子系统注册失败）退到八个
  >   学习工具再试一次，仍不行就如实警告，不静默、也不改成 allow。
  > - 它\*\*不进\*\* \`lib/tools/index.ts\` 的 \`registerStudyMate\`：那八个原生工具的面一字不动。
  > 
  > \`test\_host\_qa\_preset\`（登记进 core 组）钉我们能钉的那一半：预设形状、技能目录指向包内真实
  > 存在的 local-qa、restrict 的实参、只读工具的外部行为（给得出正文与题 / 给得出「没有」/
  > 文件清单逐字不变）、占位符守卫。真宿主认不认这条配置只在真 DSH 里证得了，那一条不进默认门禁。
  > \`test\_tools\_schema\_subset\` 另补一条：这个工具不在注册点里，别漏检它的 schema 子集。

- Merge branch 'feat/102-答疑会话' into ticket/104-qa-mode ([fb7486b](https://github.com/Miaotofu01/Study-Mate/commit/fb7486be771d0ff6aec2c4b12e606ae004303a20))
- refactor(工具): 只读工具与收窄那两处按宿主的服务访问语义写实（\#104） ([c27a0f3](https://github.com/Miaotofu01/Study-Mate/commit/c27a0f3c71c7ae8e0f90d7c0c62fa4c57fdb7963))

  > 复核 \`cordis\` 的服务访问层之后收两处尾：
  > 
  > - \`lesson-read\` 的两张域视图接口只留用到的字段（\`number\` / \`file\` 在 \`pool\` 那行用不上），
  >   免得读的人以为它们在参与了判断；
  > - \`qa-preset\` 里那条 \`restrict\` 改回 \`ctx.tools.restrict(...)\` 的写法，并在注释里写清为什么
  >   不能把函数摘出来存成变量：宿主的服务访问是一层 Proxy，\`restrict\` 用 \`this.ctx\` 决定
  >   restriction 落在哪一层的 scope 上，而那个 \`.ctx\` 就是「谁访问了这个服务」。预设行插件因此
  >   才在\*\*预设作用域\*\*上调得到它（\`scopeOf(ctx) !== undefined\`），只读工具经同一个机制落进
  >   预设自己那层（\`dsh-scope\` 的 \`ScopedLayers.effect\` 按 \`scopeOf(ctx)\` 选层）——所以它不受
  >   同一条 restriction 影响，而学习模式的 agent 也看不到它。

- merge(答疑模式): 第二条预设、只读取课件工具与工具面收窄（\#104） ([8ef40d7](https://github.com/Miaotofu01/Study-Mate/commit/8ef40d7db0e9bcab9dda153dd0cfedbcc98e5519))
- feat(问答): 宿主半新增「建答疑会话」那条路由（\#105） ([c66a341](https://github.com/Miaotofu01/Study-Mate/commit/c66a3411ee30894a77796c1b7d9ff4b7c2c07a44))

  > 面板要的是一段真会话，而客户端建不出来——\`ISessions.create\` 只序列化
  > workspaceId / cwd / sessionId，\`agentPreset\` 被静默丢掉（宿主请求类型与线上 schema
  > 都收，只有客户端包装层丢）。所以会话由插件宿主半按「答疑模式」预设（id 是 \`qa\`）建，
  > 客户端只 retain 它并渲染它。
  > 
  > - \`lib/ask/session.ts\`：\`POST /api/studymate/qa/session\`。照宿主的 \`createWebhookSession\`
  >   走 resolve → acquireScope → \`agents.create({meta:{cwd, agentPreset}, setup: mount})\`；
  >   标题写成「答疑 · 科目 · 节点」交给 \`ctx.sessionTitle.rename\`；开张注入一条共享记忆
  >   （空就不注入）；没有可用模型就\*\*不建会话\*\*、如实返回 \`{available:false, reason}\`。
  >   租来的预设 revision 用完就还，但\*\*不 dispose AgentHandle\*\*——那是把刚建好的会话拆掉；
  >   \`sessionTitle\` 没挂时如实降级（\`renamed:false\`），不抛、也不假装改过标题。
  > - 标题的拼法与识别是纯函数：宿主半拼、客户端认，两份前缀由套件钉在一起防漂移。
  > - \`readMemoryFromWorkspace\` 搬到 \`lib/ask/memory.ts\`：两条路由共用，互相 import 会成环
  >   （\`test\_architecture\_boundaries.mjs\` 的模块级环检测会红）。
  > - 错误一律走 \`lib/route-envelope.ts\` 的唯一信封；码表补 \`preset-unavailable\` 与
  >   \`session-create-failed\`。
  > - 新增套件 \`test\_host\_ask\_session.mjs\`（假 ctx）：预设 id 与 cwd、setup 里真的 mount、
  >   标题、共享记忆只注入一次、没有模型就不建会话、信封与状态码、注册入口两条路由。
  >   旧 \`/ask\` 套件跟着改成按路径取它那条路由（那条链路归 \#107 退役）。

- feat(阅读端): 右栏「问答」嵌宿主的一条真会话（\#105） ([b9c2fa5](https://github.com/Miaotofu01/Study-Mate/commit/b9c2fa5d91d4396d9e654c333f50a40d1d81c427))

  > 面板不再自己拼 messages、不再自己发请求——会话由插件宿主半按「答疑模式」预设建，
  > 客户端 retain 它，把宿主的会话正文（\`conversation.content\`，\`variant:'embedded'\`）
  > 嵌进右栏。多轮、流式、滚动、草稿、Enter 发送、Shift+Enter 换行全归宿主那条正文。
  > 旧表单、\`/api/studymate/ask\` 那条链路与它的上下文组装留给 \#107 退役。
  > 
  > - \`main\` 那条 register 声明一个\*\*非 root 子座位\*\*：框架只在 children 里有
  >   \`scope !== 'root'\` 时才把 \`SessionProvider\` 交给组件，不声明就永远嵌不进去。
  > - \`apply\` 里从 ctx 取 \`sessions\`（服务不是 props，也不是 import）；\`StudyMateApp\`
  >   接住框架给的那份标准件，一路传给右栏「问答」那一格。
  > - retain 用 \`{ source: 'studymateAsk' }\`——\*\*绝不用 \`mainView\`\*\*（宿主的 ui-session /
  >   ui-layout / ui-workspace 都拿 \`retainedBy.mainView\` 判「谁是当前会话」，借了它会顶掉
  >   学生正在看的会话）；换会话 / 卸载时 release（不 release 那条会话永远不退休）。
  > - 识别靠标题前缀（用 \`title\` 而不是会退化成项目名的 \`displayTitle\`）：打开面板时认当前
  >   科目 / 节点那一条，一条都没有就请宿主半建一条（否则宿主的 composer 没有会话可发）；
  >   「新对话」建新的换过去；「上一段会话」只列答疑会话；刷新回到最近那条（它落在磁盘上）。
  > - 没有可用模型 / 会话没开起来时如实说明、不假装会答；旧文案（不经过总控、回答不进
  >   会话记录、误解记录、问一句）一并删掉。选中的那一段先只读地摆着，可删掉、只跟下一条
  >   消息走的引用 chip 归 \#106。
  > - CSS：\`.smb-quote\` 基础规则留着（正文 blockquote 复用），只退役面板自己的 BEM 子元素
  >   与 \`.smb-askbody p\`（正文交给宿主的 --dsh-\* 那一套，面板外壳不再管正文字号）。
  > - 套件：\`test\_client\_ask\_panel.mjs\` 按新形态重写（请求体只有 subject/node、retain 的
  >   来源标签、\`SessionProvider\` 包着 \`conversation.content\`、单子只列答疑会话、两份前缀
  >   判据对账）；\`test\_client\_ask\_quote.mjs\` 只留捕获那一半；浏览器夹具扩成带假宿主服务
  >   （slots/sessions/inputTriggers/conversation/get/effect），四场验「建会话 → retain →
  >   嵌正文」「切 tab 回来还在」「新对话与上一段会话」「真刷新回到最近那条」。

- docs(规范): 右栏「问答」按真会话收口（\#105） ([5b0ce75](https://github.com/Miaotofu01/Study-Mate/commit/5b0ce75a66818ec9d037120480a4ea791df6dbbe))

  > \`阅读端呈现\` §二 补上「问答 tab 里嵌的是宿主自己的会话正文」这条判据（新对话 /
  > 上一段会话 / 刷新回到最近那段 / 没有可用模型时如实说明），§八 把守着它的套件换成
  > \`test\_host\_ask\_session.mjs\` + \`test\_client\_ask\_panel.mjs\` + 浏览器那条，并把「问答引用的
  > 捕获」单独留一行（\`test\_client\_ask\_quote.mjs\`）——面板那半不再由它守。
  > 
  > \`工程约束\` §三 的路由清单补上 \`qa/session\`；\`scripts/tests/README.md\` 的浏览器那条
  > 说明改成新形态（假宿主服务、四场用例）。

- merge(阅读端): 右栏「问答」换成宿主的一条真会话（\#105） ([cefa7d9](https://github.com/Miaotofu01/Study-Mate/commit/cefa7d9aa6bfb7a59c75f49b14603810502ba9a8))
- feat(阅读端): 选中的那段正文做成引用 chip 跟着下一条消息走（\#106） ([6676d84](https://github.com/Miaotofu01/Study-Mate/commit/6676d84d818d05a5e93c8c4e044615cad9925ab7))

  > 宿主没有提交钩子，选中的那段必须在学生点发送之前就躺进那条会话的草稿，否则消息不会带上它
  > ——所以这颗 chip 是承重件，不是装饰。做法是注册一个自己的引用来源（trigger \`@\`、名字
  > \`studymate\`，避开宿主的 reference / skill / command），由它的 codec 决定提交那一刻进消息的
  > 文字（原文 + 来源锚点），再用 \`conversation.input.for(actx).insertReference\` 把引用插进草稿、
  > 再划一段换掉旧的、删掉时撤回。
  > 
  > 为什么注册挂在插件 fiber 上而不是随面板开关：提交那一刻宿主按 name 找 owner 的 codec，找不到
  > 就抛「no serializer for reference source」，整次发送失败并把草稿还给学生。所以它写在
  > \`apply(ctx)\` 的 \`ctx.effect\` 里，随插件卸载注销。
  > 
  > \`ref\` 只是一个字符串（宿主\*\*没有\*\*反序列化入口），所以「原文 + 来源锚点」的编解码是一对纯
  > 函数（一行 JSON：逐字往返、中文原样可读），\`serialize\` / \`clipboardText\` 是它的两个投影。
  > 草稿里已有的那一颗按宿主的 occurrence 视图认（source + offset/length），插入与换掉走同一条
  > revision CAS：\`span.draftRev\` 过期时门面静默返回 false，我们重读状态重试一次，还不成就给一句
  > 可读提示，不静默丢。
  > 
  > 面板上那颗 chip 排在宿主输入框上方：一行原文 + 来源小节，点得开看全文，右边一颗「删掉」。
  > 消息真送出去时（宿主清草稿、chip 消失）它自动让位给下一段；提交被拦下、草稿还原时留着——
  > 那一次什么都没送出去。
  > 
  > 测试：新套件 test\_client\_ask\_chip.mjs（编解码往返、serialize 的输出、注册与注销的配对、
  > 插入/换掉/撤掉/提交即让位，假输入门面照宿主的 occurrences + draftRev CAS 写照），登记进
  > checks.mjs 的 core 组；browser/ask\_quote\_test.mjs 扩成真鼠标那一条（划一段 → chip 进草稿 →
  > 再划一段换掉 → 删掉还能提问 → 太短的误触不产生 → 点输入框/切 tab 不丢）；\#105 那份面板套件里
  > 「清除入口归 \#106」的断言按新事实改掉。

- docs(规范): 引用 chip 的机制与守着它的套件写进阅读端呈现（\#106） ([9aae5c9](https://github.com/Miaotofu01/Study-Mate/commit/9aae5c9bbc610e4d03bd970cc18a8ca9e530a3bf))

  > §六 补两条：那颗 chip 在输入框上方长什么样（点得开看原文、删得掉），以及它是\*\*承重件\*\*——
  > 学生在正文里划中的那段同时进那条会话的草稿，提交时由我们注册的引用来源的 codec 决定进消息的
  > 文字（原文 + 来源锚点），所以那个来源在插件激活时注册、随插件卸载注销；它不在册时发送会被
  > 拦下、草稿还给学生。§八 的套件表补上守这条的 \`test\_client\_ask\_chip.mjs\`，并把真浏览器那一条
  > 的描述更新到 chip 的新形态。\`scripts/tests/README.md\` 的浏览器套件表同步。

- merge(阅读端): 引用 chip 跟着下一条消息走（\#106） ([0ff8f14](https://github.com/Miaotofu01/Study-Mate/commit/0ff8f14b30087ba6dfb6c54df71ebd62f896adf7))
- refactor(问答): 面板自己调模型那条链路整体退役（\#107） ([ac284e7](https://github.com/Miaotofu01/Study-Mate/commit/ac284e7d281a0d947459c0dd6d0bdf67ee15cd26))

  > \#105 把阅读端的问答面板换成宿主的一条真会话之后，旧链路就成了死引用：面板不再拼
  > 请求体、不再自己发请求，\`POST /api/studymate/ask\` 与它那份「只带当前课件 + 选中文本 +
  > 共享记忆」的上下文组装一个活消费方都没有。这一票把它们连同守着它们的两条套件一起删掉，
  > 让答疑只剩一条链路、一套上下文边界。
  > 
  > - 路由：\`lib/ask/route.ts\` 整份删除，\`lib/ask/index.ts\` 这个出口只剩
  >   \`registerAskSessionRoute\`（\`bin/dsh-plugin.ts\` 那一行改调它）。随它一起走掉的机读码
  >   （\`ask-failed\` / \`question-required\` / \`lesson-not-found\` / \`model-empty\` /
  >   \`model-error\`）也从词表里删掉——留着等于让客户端对着一个没有路由会回的错误分支写代码。
  > - 纯函数：\`lib/core/ask.ts\` 整份删除（\`buildAskContext\` / \`assembleAnswer\` /
  >   \`topicFromQuestion\` / \`quoteEvidence\` / \`selectionAnchorLabel\` / \`stripFrontMatter\`
  >   逐个判过活引用：新链路一个都不用）。
  > - 写侧：面板那条写入方退役，\`lib/misconceptions.ts\` 的 \`ASK\_SOURCE\` 随之删除，没给
  >   \`source\` 时兜底成「讲解反馈」（与读侧归一同一句话）。\`MISCONCEPTION\_SOURCES\` 与
  >   schema enum 里的 \`问答面板\` \*\*保留\*\*：旧学科里已落盘的记录还要读得进、校验得过
  >   （读侧兼容，与旧六档只活在读侧映射里同一条先例）。
  > - 套件：删 \`test\_host\_ask\_route.mjs\` / \`test\_core\_ask\_context.mjs\`，新增
  >   \`test\_ask\_retirement.mjs\` 把三条硬事实写成断言（旧路由没注册、请求它是明确的 404；
  >   客户端里没有发往旧路由的 POST 与那份上下文组装；走一遍新会话链路整个工作区逐字节
  >   不变，而其余写入方照旧写得进去），并登记进 \`checks.mjs\` 的 core 组。
  > 
  > 为什么整份删而不是留个壳：留着「已经没有生产者的路由」会让下一个人以为还有第二条链路，
  > 而这份 spec 要的正是「答疑只有一条链路」。

- docs(规范): 旧问答链路退役之后把口径与例外收干净（\#107） ([255b8e0](https://github.com/Miaotofu01/Study-Mate/commit/255b8e012dd4d871d92bb8abb431ff8f0d03b107))

  > - 工程约束 §三：路由清单删掉 \`ask\`，注册约定的例子改成 \`registerAskSessionRoute\`，
  >   成功那一侧不再举面板的 \`{available, ok, answer…}\`（那条形状已随旧路由退役）。
  > - 目标态规格 §5.4：\`source\` 写成「讲解反馈 / 实验课验收」，并说明 \`问答面板\` 是
  >   \*\*读侧兼容\*\*的既有值——值还在（旧数据要校验得过），只是面板不再写它；schema 的
  >   description 同步成同一句话。
  > - 阅读端呈现 §八：补一行守着退役面的套件。
  > - 文档悬空引用检查：把一次性验收证据 \`阅读端呈现验收-2026-10-05.md\` 加进显式例外。
  >   它按当时的实现写死了 \`lib/ask/route.ts\` / \`lib/core/ask.ts\`，而 \#107 删了这两个模块；
  >   按历史文档处理，但\*\*只加这一份\*\*，不放宽成 \`阅读端呈现验收-\*\` 通配。
  > 
  > 为什么改文档而不是改文档里的路径：那份验收文档是一次性证据（自己开头就写明"不是规范"），
  > 改它的历史记录等于篡改证据；例外写在检查里，才不会把真正该修的悬空引用一起放过去。

- merge(问答): 面板自己调模型那条链路整体退役（\#107） ([04f9045](https://github.com/Miaotofu01/Study-Mate/commit/04f90457262384274e6a383d8e66b5bd69d2cb7d))
- fix(阅读端): 引用 chip 的 span 折到 detect 投影——别拿剪贴板坐标去插/删 ([5d219c2](https://github.com/Miaotofu01/Study-Mate/commit/5d219c2b4feb05dfc23c37bc16413c767a3782ed))

  > 评审发现 A（Spec 轴 · 高）：\`putQuoteInDraft\` / \`dropQuoteFromDraft\` 用
  > \`chip.offset/chip.length\` 构造 \`insertReference(ref, span)\` / \`insertText('', span)\` 的
  > span，那是\*\*剪贴板\*\*投影坐标；而这两个方法的 span 要的是 \*\*detect\*\* 投影坐标（宿主
  > \`dsh-client-ui-conversation/lib/client.js\` 的文档逐字写着，越界由 \`selectSpan\` 判 null
  > 直接拒）。一颗 chip 在剪贴板里占十几字（「【引用】…（来源）」），在 detect 里恒占 1 个占位符。
  > 
  > 后果两个：chip 后面有学生打的字时，换掉/删掉会连带删错十来个字符；chip 落在草稿末尾时
  > \`span.end\` 越界、两次都返回 false——草稿里留着旧 chip，发出去的还是上一段（正好与 \#106
  > 「送出去的就是那颗 chip 那一段」相反）。
  > 
  > 改法：
  >   · 新增三个纯函数把剪贴板偏移折成 detect 偏移（\`detectLengthOf\` /
  >     \`detectOffsetOfClipboardOffset\` / \`chipDetectSpan\`，chip 恒占 1 个字），挂到内部件钩子
  >     供套件断言；
  >   · 换掉/撤掉用 \`chipDetectSpan\` 给的那一个字的区间；新建落在 detect 空间的
  >     \`selection.end\` → \`caret\` → 草稿末尾（\`insertPointOf\`），不再拿 \`draft.length\`（剪贴板长度）
  >     当落点；
  >   · \`dropQuoteFromDraft\` 里 \`setDraft\` 那条退路继续用\*\*剪贴板\*\*坐标——它切的就是剪贴板字符串。
  > 
  > 夹具同时补上这条：两处各写一遍的假输入门面抽成 \`scripts/tests/fixtures/ask\_draft\_facade.js\`
  > （浏览器脚本，Node 经 \`ask\_draft\_facade.mjs\` 薄壳加载），\*\*同时照两套投影\*\*：
  > \`occurrences\[\].offset/length\` 是剪贴板的、\`detectText\` 里 chip 是一个占位符、
  > \`insertReference\`/\`insertText\` 收到的 span 按 detect 长度校验（越界就拒，照宿主行为）。
  > 原来的假门面只有一套坐标，所以放过了这个 bug。修之前先复现过：把 \`chipDetectSpan\` 退回
  > 剪贴板坐标，Node 套件 6 条红（\`'failed' !== 'in'\` 等）、浏览器夹具 3 条红
  > （\`\[换掉\] 那一颗换成了新的一段 — ref 没变\`）。

- refactor(问答): 面板那个写入方退役之后删掉 lib/misconceptions.ts ([7defa02](https://github.com/Miaotofu01/Study-Mate/commit/7defa026015cb1715093df02c9b5874999c103d8))

  > 评审发现 B（Spec 轴 · 中）：\`lib/misconceptions.ts\` 已经是死模块——全仓没有任何生产模块
  > import 它（\`lib/library.ts\` 走 \`lib/core/misconceptions.ts\` + vault 域），它唯一的生产调用方
  > \`lib/ask/route.ts\` 已随 \#107 删除，只剩一条套件还在用它。它文件头自己写着「退役的只是面板
  > 那个写入方」，那就把它整份收掉。
  > 
  > 顺带解决「默认 source 被悄悄改成 \`讲解反馈\`」那条：那个改动随文件一起消失。
  > 
  > \`test\_ask\_retirement.mjs\` 里那两条改成「机制还在」的等价断言：
  >   · 新增一条守卫：\`lib/misconceptions.ts\` 不在盘上，\`lib\`/\`bin\` 的源码里也没有人 import 它
  >     （只认写到这一份的；\`lib/core/misconceptions.ts\` 仍在用，不算）；
  >   · 新的读侧断言：现造现弃的工作区里，三个来源（含旧的 \`问答面板\` 与更老的
  >     \`question\`/\`date\` 写法）经 \`lib/core/misconceptions.ts\` 归一 + \`lib/library.ts\` 读侧
  >     照样读得出、逐条过 \`schemas/misconceptions.schema.json\`；\`问答面板\` 仍在
  >     \`MISCONCEPTION\_SOURCES\` 与 schema 的 enum 里（\#107 明确的读侧兼容）；
  >   · 删掉「\`writeMisconception\` 写得进去」那类断言——那个 API 没了。
  > 
  > \`lib/core/misconceptions.ts\` 与 schema 的 enum 一字未动。

- fix(提示词): 答疑 persona 补上「超出这一段就明说值得单独讲」那条 ([a635c5b](https://github.com/Miaotofu01/Study-Mate/commit/a635c5b29e2636b6714514b432d9b714276082a7))

  > 评审发现 E（Spec 轴 · 低）：\#104 验收第 3 条点名那句要写在 \*\*persona\*\* 上，实际只写在
  > \`preset/skills/local-qa/SKILL.md\` 里。persona 是那条预设的身份，模型先看到的就是它——
  > 越界那一步（问题变成"整块知识都没懂"时明说「这值得单独讲」、让学生回会话找总控）漏在
  > persona 外面，就等于把这条边界只交给技能加载之后才知道。
  > 
  > 改法：在 \`preset/qa/agent.cordis.yml\` 的 \`prefix\`（\`&gt;-\` 单行折行块，缩进不动）里补一句，
  > 与 SKILL.md 那句同义；\`test\_host\_qa\_preset.mjs\` 顺手加一条断言钉住它（不只断「就地答疑」）。

- refactor(阅读端): 去掉没人读的 renderSlot 解构，把「宿主」的名字收干净 ([52ae8e9](https://github.com/Miaotofu01/Study-Mate/commit/52ae8e96425e53d2a2117f0a1ab9d16fe647a552))

  > 评审发现 F（两轴都点的 Speculative Generality + 命名）：
  > 
  > · \`StudyMateApp({ SessionProvider, renderSlot, renderFactorySlot })\` 里 \`renderSlot\` 从来没被
  >   读过。选「去掉」而不是「留个注释说明为什么留」：kit 里仍会给它，真要用（渲染那个非 root
  >   子座位）时再加回来；留着没人读的解构项只会让人以为它在被用。
  > · 同一件事在代码里有三个名字：\`askHost\`（apply 里取的宿主服务）、\`host\`（框架发给座位的
  >   kit）、\`kit\`（\`const kit = host || null\` 这个纯别名）。别名去掉，两个东西各给一个自解释的
  >   名字：\`hostServices\`（\`ctx.get()\` 取的服务，模块级那一格）与 \`hostKit\`（渲染期 props，
  >   一路传到 \`AskPanel\`）。
  > 
  >   没有把它们并成\*\*一个对象\*\*：来源与生命周期都不同（\`ctx.get()\` vs React props；插件 fiber
  >   期 vs 渲染期），并起来只能靠在 render 里写模块级状态，那是拿一个更坏的气味换一个命名问题。
  >   这一点写在 \`AskPanel\` 与 \`hostServices\` 的注释里。
  > 
  > 改名同时把 \`test\_client\_ask\_panel.mjs\` / \`test\_client\_ask\_chip.mjs\` 的 props 与 import 对齐
  > （那个 \`askHost\` import 本来就没被用过，一并去掉）。

- docs(规范): 给答疑面的只读工具补上人读契约的落点 ([59452ea](https://github.com/Miaotofu01/Study-Mate/commit/59452ea25c9f8156c4f483863b6a0aadc7d6e506))

  > 评审发现 C（Standards 轴 · 硬）：\`docs/规范/工程约束.md\` §三 写着「有哪几个工具、名字表 →
  > \`lib/tools/index.ts\` 的注册点与 \`STUDY\_TOOL\_NAMES\`」、「参数表 →
  > \`preset/skills/learning-system/references/tools.md\`」，而 \`studymate\_lesson\_read\` 两处都没登记；
  > \`test\_skill\_contracts.mjs\` 又要求「技能里反引号点名的 \`studymate\_\*\` 必须都在 \`STUDY\_TOOL\_NAMES\`
  > 里」——\`local-qa\` 那条链上哪天点名它就会红，而且红得莫名其妙。
  > 
  > 改法（一处定义，别处只给指针）：
  >   · \`lib/tools/index.ts\` 给\*\*答疑面\*\*一个正式出口 \`QA\_TOOL\_NAMES\`，与 \`STUDY\_TOOL\_NAMES\` 并列；
  >     只读工具\*\*不\*\*塞进学习面那八条（\`registerStudyMate\` 的注册面一字不动）；
  >   · \`docs/规范/工程约束.md\` §三 改成两张表各有出处，并写明答疑面那条不在学习会话的工具面上；
  >   · \`preset/skills/learning-system/references/tools.md\` 给它留出参数表与返回形状（\`node\` 必填；
  >     \`found:true\` 给 node/subject/file/markdown/questions/alsoIn，读不到给 \`{found:false,reason}\`；
  >     只读 lessons + pool、writes 为空），并注明它只挂答疑模式；
  >   · \`test\_skill\_contracts.mjs\` 的判据改认\*\*两张名字表的并集\*\*，并加一条「两张表不重叠」的断言；
  >   · 两个无头宿主的 \`NATIVE\_TOOL\_FALLBACK\` 各补一条它的等价落点（映射表自己的注释就写着
  >     「新增原生工具时这里加一行」）——这样并集放宽之后，「导出件里不留原生工具名」那条仍然成立；
  >   · \`scripts/tests/README.md\` 的调用面说明同步成并集。

- docs(规范): 布局与可见边界跟上第二条预设（答疑模式） ([ff8a654](https://github.com/Miaotofu01/Study-Mate/commit/ff8a6540789f86d04d796ee01982943650e67a64))

  > 评审发现 D（Standards 轴 · 硬）：几处仍写着只有一条预设/一个入口，实际 \#104 起有两条。
  > 
  >   · \`docs/规范/工程约束.md\` :24 —— 「预设目录 \`preset/learning/\` 是源」改成两份源
  >     （\`preset/learning/\` + \`preset/qa/\`），并写明安装器在\*\*同一次\*\*调用里把两条都注册上；
  >   · 同文件 :44 目录树 —— 补 \`preset/qa/\`；
  >   · \`docs/设计/目标态规格.md\` :25 目录树 —— 同上；
  >   · \`docs/使用/安装.md\` :80 —— 「注册学习预设」改成两条，并给出两个插件入口
  >     （\`@yunmiao/studymate\` 与 \`@yunmiao/studymate/qa-preset\`）。
  > 
  > 另外 :105 那句「预设行只能开关插件、收不窄插件自己的注册面」与 \`lib/tools/qa-preset.ts\` 的
  > \`restrict({ deny })\` 矛盾——改成两句话同时成立的新事实：\*\*注册面仍在 profile 根\*\*（插件拿到的是
  > profile 根 ctx，没有「按预设注册工具/面板」的接口），\*\*但预设行住在 agent 作用域里，可以在自己
  > 的作用域里把继承来的那批 deny 掉\*\*（\#104 的答疑模式就是这么做的）。这条边界的判据是「这条会话
  > 看得见哪些工具」，不是「工具注册在哪一层」。
  > 
  > \`test\_skill\_visibility.mjs\` 那条特征化断言没有被说反：它钉的是\*\*注册面\*\*（profile 根 ctx 上八个
  > 学习工具按名字查得到、预设载荷里没有工具名），而 \#104 的收窄落在 agent 作用域——两件事不冲突。
  > 顺手把这条口径写进那个套件的文件头与用例注释，免得下一个人照着旧句子去删它。

- merge(评审修复): code-review 两轴提出的问题逐条修完（\#102） ([0a28998](https://github.com/Miaotofu01/Study-Mate/commit/0a28998283361eba85a0ce4780ac9854e5b28156))
- docs(规范): 技能可见范围的表述跟上第二条预设（\#104/\#107 收尾） ([ca7d0a1](https://github.com/Miaotofu01/Study-Mate/commit/ca7d0a166a16b6bf325d728c4c40ecb33d9c0470))

  > 「技能源住在学习预设自己的目录里」是单预设时代的话；\#104 之后答疑预设
  > 只声明 preset/skills/local-qa 那一个子目录，可见范围由\*\*预设自己声明\*\*。
  > 口径的唯一出处是工程约束 §二，这里只是把它复述对。
  > 
  > Co-authored-by: code-review 两轴（Standards 轴点名此句）

- fix(答疑): 只读工具的 found 补上 type，别让整条预设注册不上（\#104） ([b73764e](https://github.com/Miaotofu01/Study-Mate/commit/b73764e7fb41e4cebde10cde85fb6807490b8053))

  > \`studymate\_lesson\_read\` 的输出契约把两支写成 \`found: { const: true }\` / \`{ const: false }\`。
  > 「有 const/enum/properties… 却没有 type 或 oneOf」是宿主 \`assertSupportedJsonSchema\`
  > 的硬违规，\`ctx.tools.register\` 当场抛，\`studymate-qa-tools\` 那条预设行整行挂不上：
  > 
  >     建答疑会话失败：studymate-qa-tools (@yunmiao/studymate/qa-preset):
  >     unsupported JSON schema: schema.oneOf\[0\].properties.found.const requires type or oneOf; …
  > 
  > 后果是阅读端右栏连输入框都没有（\`lib/client.js\` 的 \`session-create-failed\` 那一格）。
  > 改成 \`{ type: 'boolean', const: … }\`——与 \`lib/tools/define.ts\` 里已有的那一处同形。
  > 
  > 门禁里那条子集走查没红，是因为它只查「关键字认不认」，没查「本体关键字挂没挂在
  > type/oneOf 上」。现在按宿主逐条补齐（缺 type/oneOf、type 与 oneOf 并列、oneOf 不足两支、
  > 本体关键字挂错 type、const/enum 与 type 对不上、required 点了不存在的键、
  > additionalProperties 不是布尔），并把「只有 const 没有 type」这类写进反空转清单：
  > 撤掉这一处修复，它就报出与宿主逐字相同的两条路径。

- fix(答疑): 程序化建的会话自己带上 provider/model，否则一按发送就报 has no provider/model（\#105） ([e41aa0a](https://github.com/Miaotofu01/Study-Mate/commit/e41aa0af6d28acbbb3e5fb1224848d3888224d51))

  > 真把答疑会话建起来之后，学生按下发送拿到的是：
  > 
  >     本轮运行失败 agent "studymate-qa-&lt;uuid&gt;" has no provider/model: set
  >     AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall
  > 
  > 会话建得起来，却答不出一句。正常会话的 provider/model 是客户端选出来的
  > （\`dsh-api-session-controller\` 建会话时给 \`agentOptions()\`），而这条会话\*\*不经过客户端\*\*
  > （客户端包装层会丢掉 agentPreset，所以才由宿主半建）——\`agents.create\` 不会替我们去找
  > 默认模型，得自己带。取法照 \`dsh-webhook\` 的 \`createWebhookSession\` 与那个 controller
  > 的同一份：\`ctx.agentDefaultModel.currentSelection()\`（\`dsh-base\` 里常驻的服务），
  > 连同 \`reasoningEffort\` 一起带上，学生选的那一档才站得住。
  > 
  > 取不到（服务没挂 / 没选默认模型 / 取的时候抛错）就\*\*一条会话都不建\*\*，如实回
  > \`available:false\` 并说清缺的是默认模型：建一条一按发送就报错的死会话，比当场说
  > 「没模型」更坑。路由把 \`agentDefaultModel\` 转交给 \`openAskSession\`。
  > 
  > 套件：\`test\_host\_ask\_session.mjs\` 新增四条（缺服务 / 空串与形状不对 / 带 effort / 取的时候
  > 抛错，都不建会话），主断言里把 \`agentOptions\` 逐字段钉住；\`test\_ask\_retirement.mjs\` 的假宿主
  > 补上这个服务（它那条「走一遍新会话链路」是 lib/core 覆盖率下限的 13 条套件之一，缺服务
  > 会让它整条回 503，顺带把覆盖率下限也带红）。

- feat(Web运行时): StudyMate Web 独立运行时（0.7.0-beta · 可评审） (\#43) ([92d1122](https://github.com/Miaotofu01/Study-Mate/commit/92d112289e911a558e277e6d87eb9a3afa3dcf54))

  > \* feat(Web运行时): 新增 StudyMate Web 独立运行时（FastAPI + Next.js 16）
  > 
  > 把课程图谱、掌握度状态机与流式对话搬进浏览器，并可直接挂载已有的 .learning
  > 静态工作区（STUDYMATE\_WORKSPACE），在网页里零改动学习已有课件。自包含工程，与
  > 插件安装方式互不依赖。
  > 
  > 要点：
  > - 后端 FastAPI：三 API 格式（Chat Completions / Responses / Anthropic Messages）
  >   统一适配层；模态两段式（输入端不拦截、按能力注入或占位、错误码剔除重试）；
  >   附件上传与文档解析（pdf/docx/xlsx/pptx/epub/文本类）；课程仓储与掌握度状态机。
  > - 提供商与模型：对齐 ZCode 的字段口径（输入模态、上下文窗口、最大输出 Token、
  >   推理档位与能力声明），旧配置读取时等价迁移，API Key 回填输入框可查看。
  > - 前端 Next.js 16：聊天两态与流式回复、共享的可折叠/可拖拽右侧边栏、课程图谱与
  >   课件 iframe 承载、概念本、设置二级界面（提供商 / 系统提示词 / 关于）。
  > 
  > 验证：npx tsc --noEmit、next build、python -m compileall 通过；后端接口用隔离数据
  > 目录实测通过；E2E 37 条两轮连跑全绿。
  > 
  > \* test(Web运行时): 加入旅程级 Playwright E2E（37 条）与探索 agent 草案
  > 
  > 为什么：旅程级用例守住的是"真后端 + 真前端"的聚合与落盘，字段级测试替代不了；
  > 失败分支用 UI route mock 局部拦截，不铺满整页数据。
  > 
  > 要点：
  > - 后端 fixture 模式（STUDYMATE\_E2E\_FIXTURE=1）返回确定性内容，无需真实 API Key；
  >   globalSetup 每轮重建 e2e 工作区与 settings，保证幂等。
  > - 顺带修掉两处测试侧路径口径 bug：playwright.config 的 WEB\_ROOT 多算一级、
  >   tests/e2e/constants 硬拼了搬家前的 backend/data/，两处都把 E2E 指到仓库根的
  >   data/，后端于是读到陈旧 fixture；因 reuseExistingServer 会复用手工起的服务，
  >   这个错误长期不可见。四处路径口径现已统一并在文档里钉住。
  > - tests/explorer 是发现层的探索 agent 草案（非门禁，独立 config，不参与主套件）。
  > 
  > \* docs(Web运行时): 补 PRD、开发与计划、E2E 流程、变更史与子项目约定
  > 
  > 四份文档各司其职：PRD 描述功能现状、开发与计划记架构与 backlog、E2E 流程维护
  > 用例与旅程映射、Web\_CHANGE 只追加留痕；另含子项目 AGENTS（硬规矩）、HANDOFF
  > （交接状态与已知坑）、反馈清单（人工反馈的落地与差异备注）。
  > 
  > \* docs(仓库): 根 README 记入 study-mate-web 子项目
  > 
  > 补一条目录条目与一节简介，并注明"尚在开发测试中，相关功能可能不如插件途径稳定"，
  > 让从根 README 进来的人知道有这个独立运行时、以及去哪里看部署与使用说明。
  > 
  > \* docs(Web运行时): HANDOFF 记入 PR \#43 占位编号与状态
  > 
  > \* feat(Web运行时): 落地 K 系列工具化、生产链与会话级工作区，并重建启动器
  > 
  > 工具化（K0–K3）：工具注册表与沙箱边界（读写根 allow-list、写前 canonicalize）、
  > 编排审计落盘、agent loop（轮次预算 / 降级 / 重复提醒 / 事件回吐）、三格式流式
  > tool\_call 聚合；chat 只读工具 + 建课与产课工具循环；工具调用默认对所有模型开启
  > （上游拒绝 tools 时自动回落纯文本）。
  > 
  > 生产侧：节点产出链（派工 → 渲染 → 检查 → 按归属打回 → 质检工单）、建课链
  > （大纲与采图并行 → check\_curriculum 门禁 → 落盘）、草稿区与落点确认、采图、
  > 跨科目共享记忆 MEMORY.md 的读侧与逐条确认写侧。
  > 
  > 会话级工作区（拍板"甲"）：新增 workspace\_ctx（ContextVar + 可重入 bind），
  > curriculum\_store.workspace\_dir() 成为唯一收口点，memory/records/tickets/
  > misconceptions/export/lessons 全部自动跟随；会话可各自绑定工作区，科目类 GET
  > 支持 ?workspace=。
  > 
  > UI：新对话态输入区上方的「科目 + 工作区」关联行、推理档位独立下拉、课程页
  > 右栏「图谱 / 大纲」分段切换与科目总览、侧边栏折叠成图标轨、明暗钮归位、
  > 设置页实时保存；模型编辑支持输入模态与有序推理档位。
  > 
  > 启动器：start-web.bat 改为比对源码与构建时间、陈旧时自动重新构建，加端口预检
  > 与就绪后自动关窗；新增 stop-web.bat 与 tools/studymate-web.ps1（按端口向上找到
  > 服务窗口一并收掉，含强杀留下的孤儿进程）。
  > 
  > 修掉两枚真 bug：课程图谱因容器用 ref 作依赖而可能整体不渲染（改 state 承载）；
  > 记忆确认未带 session\_id，导致建议与写入落到不同工作区。
  > 
  > \* test(Web运行时): 补齐后端单测与旅程级 E2E，新增组件测试层与探索目标库
  > 
  > - 后端 pytest：75 通过 + 1 条 SMOKE\_REAL\_LLM 门控 skip。覆盖工具化（三格式 wire
  >   映射 / 流式聚合 / agent loop 预算与降级 / 沙箱 / 审计）、生产链（派工交付、
  >   渲染检查打回、质检工单）、提示词开场切片、工作区绑定与会话级工作区。
  > - E2E（Playwright，fixture 后端，无需真实 Key）：53 通过 + 3 条按拍板挂起的 skip
  >   （聊天侧「生成小结 / 沉淀记忆」入口已悬空）。新增工具卡、建课链、产课链、
  >   质检工单、附件区、新会话关联行、侧边栏折叠、主题视觉巡检等用例；helpers 与
  >   global-setup 随「大纲进右栏」「关联行」等界面调整同步。
  > - 组件测试（vitest + Testing Library，P4 层）：ChatView / ModelSelector /
  >   ProvidersView 的分支逻辑下沉，不并入根门禁。
  > - 探索 harness：目标库扩到 g1–g17（含 g11 / g15 的挂起标注），补 seeds 与
  >   files 前置 fixture。
  > 
  > \* docs(Web运行时): 同步 PRD、开发与计划、E2E 流程、README、HANDOFF 与变更史
  > 
  > - PRD：功能现状口径（推理档位下拉、新对话关联行、会话级工作区）。
  > - 开发与计划：模块表补 agent / tools / audit / roles / workspace\_ctx / build /
  >   produce / tickets 等，settings 口径修正为 v3，补 backlog \#17（悬空入口接回）
  >   与 \#18（工作区绑定放宽），启动方式与版本口径同步。
  > - E2E 流程升 v1.9：用例 ↔ 旅程映射表与条数（53 + 3）同步，补主题视觉巡检行。
  > - README：启动段重写（陈旧构建自动重建 / 一键停止 / 端口预检 / 环境变量覆盖），
  >   目录树补全，启动文件名纠错（start-studymate.bat 从未存在）。
  > - HANDOFF 升第十一版；Web\_CHANGE 追加「第二轮 UI 杂项」与「启动器重建」两条留痕。
  > - 新增《探索测试指南》《前端美化设计》与 K 系列尽调存档三份文档，子项目 AGENTS.md
  >   记入门禁改为 pytest、文档同步扩到五份并新增探索测试提醒（规则 9）。
  > 
  > \* feat(Web运行时): 建课链修复 + agent 工具化产课/评估 + 我的课程 + 消息兜底（升 0.6.0-beta）
  > 
  > 按维护者指示，把第三～九轮的累计改动一次性提交。
  > 
  > 前端 UI 三轮
  > - 助手名称栏、消息操作（编辑=截断重发、删整轮）、思维链/工具/中间过程折叠区
  > - 「上下文窗口」栏、头像与下拉靠右、去掉「思考 · 」前缀、会话级模型与档位
  > - 档位取值两类语义兼容：disabled/enabled 是思考开关而非档位（关不发参数、开用默认档）
  > 
  > 生产侧与 K 系列
  > - 子代理派工：无工具单次调用、SKILL.md 全文注入、JSON envelope、路径归属打回与质检工单
  > - K0–K3：工具注册表与沙箱、大纲门禁自修循环、审计 jsonl
  > 
  > 编排可见性 + 墙钟上限
  > - progress 快照（不落库）与建课进度卡/产课进度行，单轮成本与"是否在干活"可见
  > - run\_agent(max\_seconds)：聊天 300s / 编排 1800s，到点用现有内容收尾
  > 
  > 建课链正确性
  > - 大纲派工值内联 curriculum schema 全文（原先只指向沙箱读不到的文件，实测致门禁连打回 3 次）
  > - 门禁非零退出但解析为空改判失败；采图无参考资料标「跳过」；草稿同名去重；工单 retry 走工具循环
  > 
  > agent 工具化产课/评估
  > - 新增 produce\_lesson / assess\_node，仅在科目关联会话开放；工具可回吐编排进度
  > - 节点详情页「产出此课」「申请评估」「问 Study Mate」三个悬空按钮删除（保留工单角标）
  > - promote 带 session\_id：落点确认后把触发会话自动绑到新科目
  > - 聊天右栏新增图谱/大纲区（与课程页共享 SubjectGraphPanel），点节点跳科目详情
  > - 建课完成卡新增「开始第一课」，由会话 agent 调工具产课
  > 
  > 「我的课程」与右栏
  > - /courses 不带 ?subject= 内嵌工作区主页、不显示右侧栏；侧栏导航「课程图谱」改名「我的课程」
  > - 内嵌页暗夜跟随 web 主题；右栏改选项卡（图谱与大纲 / 上下文窗口 / 会话与附件）
  > 
  > 消息不再丢
  > - 切会话/关页会取消 SSE 迭代任务，原先落库写在整条流跑完之后 ⇒ 那一轮回复从未入库
  > - 两条 chat 路径都改为「边发边攒 + 断开兜底落库」，并标注「本轮输出过程中连接中断」
  > 
  > 会话存储并发安全
  > - \_write 由「先截断再逐段写」改为临时文件 + os.replace 原子替换，并对 Windows 分享冲突退避重试
  > - 读改写共用一把可重入锁：并发追加不再互相覆盖（原实现实测并发 GET 500 与永久损坏的会话文件）
  > - list\_sessions 跳过坏文件而不是 500
  > 
  > 文档
  > - PRD / 开发与计划（新增主动检索议程与 chat 工具面差距 → K4）/ E2E 测试流程 / 建课链路档案 /
  >   README / Web\_CHANGE / HANDOFF，并把子项目文档收进 study-mate-web/docs/
  > 
  > 验收（同一次运行）
  > - 后端 pytest 152 通过 + 1 skip；E2E 62 通过 + 3 skip（0 失败）；组件测试 20 通过
  > - tsc --noEmit 干净；npm run build 通过；根 npm test 除 1 条既有 Windows CRLF 假红外全绿
  > 
  > \* chore(Web运行时): next-env.d.ts 归位到生产构建形态（dev 构建会把它改指向 .next/dev）
  > 
  > \* fix(课件检查): check\_lesson 只认真实元素的 href/src，转义教学示例不再误报断链
  > 
  > 渲染后的代码示例（\`\`\`围栏/行内代码里的 &lt;img src=…&gt;）会转义成
  > &amp;lt;img src=…&amp;gt;，引号仍在，裸正则 REF\_ATTR\_RE 会把示例里的假路径
  > 命中成「文件不存在」（真实发生过：html-elements 课的 photo.png 误报）。
  > 改用 HTMLParser 收集真实元素上的 href/src：转义文本是数据、注释是
  > 注释、&lt;script&gt;/&lt;style&gt; 内容是 CDATA，都不算引用；顺带支持未加引号
  > 属性与实体。检查项 2/3/9/10/11 的口径不变，CSS url() 与 srcset 仍不在内。
  > 
  > \* feat(Web运行时): 统一错误对象与会话流生命周期、生产任务化、workspace 只读资源路由、lab 交付与依赖锁（升 0.7.0-beta）
  > 
  > 后端：
  > - app/errors.py 统一 ErrorInfo（code/phase/retryable/stopped\_reason/request\_id…）：
  >   SSE error 平铺、HTTP {detail, error}、助手消息持久化 error + stream\_state=error，
  >   空 正文带 error 不过滤（刷新/切会话可重放）；上游流缺 finish/message\_stop/
  >   response.completed 判 upstream\_eof，不再静默半截
  > - 停止按 (session\_id, turn\_id) 作用域；user\_stop 仅由 stop endpoint 登记
  > - production\_task.py 生产任务化 + concurrency.py 并发原语 + 超时检查点；
  >   修复派工轮（repair\_rounds）与总控复检次数（rechecks）分开、如实呈现
  > - produce.py 实操/实验课 lab 交付：lab/&lt;NNNN&gt;-stage + lab/solutions + lab/README
  >   全部 required，缺一不 promote（防假解决）；produce\_lesson 默认按大纲顺序取
  >   第一个尚无课件的节点；既有产物复用 / regenerate 契约（bool 严格校验、
  >   非 UTF-8 不复用、强制重做与工单 retry 禁复用）
  > - routers/workspace\_files.py：token 化只读资源路由（委托既有 lessons/home
  >   handler，非通用读盘；traversal/symlink 守卫）
  > - 依赖锁 requirements.lock.txt / requirements-dev.lock.txt（uv universal+hash，
  >   pip --require-hashes 通过）+ lock 脚本
  > 
  > 前端：
  > - lib/chatStream.ts 会话流生命周期（分片协议/中断恢复/epoch 同步）；
  >   ErrorNotice 红卡（danger/neutral、展开详情、复制诊断，聊天与任务卡复用）；
  >   ProductionTaskCard 任务卡（非 running 隐藏当前阶段，展示 fallback/耗时）
  > - next.config.js 支持 STUDYMATE\_NEXT\_DIST（E2E/探索构建目录级隔离）
  > 
  > 工程：
  > - 新增 .github/workflows/web-ci.yml：Web 子项目独立 CI（后端测试 + 前端
  >   lint/组件/构建/E2E 冒烟），与根 npm test 互不影响
  > - check\_lesson 联动口径；.gitignore 补 e2e-run\*.log；版本 0.7.0-beta
  > 
  > \* test(Web运行时): 错误恢复/生产任务/评审链前后端测试补齐（后端 474+1skip / 组件 119 / E2E 98）
  > 
  > - 后端 18 个新测试文件：统一错误对象与会话错误恢复（chat\_errors /
  >   chat\_parts / chat\_task\_contract）、生产任务化与超时检查点
  >   （production\_task / production\_fallback\_state / task\_timeout\_checkpoint /
  >   review\_concurrency）、lab 交付与产课回归（lab\_delivery /
  >   produce\_delivery\_regression / assessment\_recovery /
  >   interview\_closing）、遗留工单恢复（legacy\_ticket\_recovery）、
  >   LLM 截止（llm\_deadline）、误解字段映射（misconception\_mapping）、
  >   评审链（review\_agent\_llm / review\_production / review\_display\_content /
  >   review\_session\_config / review\_workspace\_data）+ conftest 与既有测试更新
  > - 前端组件测试 12 个新文件（会话流生命周期 / 中断角色 / 恢复填充 /
  >   ErrorNotice / MessageParts / ProductionTaskCard / 遗留工单恢复 /
  >   评审操作与草稿采纳 / 侧栏历史上限 / workspace 透传 / 展示内容）
  > - E2E 10 个新 spec（chat-errors / chat-stream-lifecycle / display-content /
  >   legacy-ticket-recovery / produce-selection / production-task / rendering
  >   含 light-dark 渲染矩阵 / review-chat-actions / review-workspace /
  >   ui-round4）+ explorer 调整
  > - 本次实测：后端 pytest 474 passed / 1 skipped；组件 vitest 16 文件 119 全过
  > 
  > \* docs(Web运行时): Web\_CHANGE 归档重组 + 六份文档同步 + 版本指针 0.7.0-beta
  > 
  > - Web\_CHANGE.md 冻结线重组：2026-09 末 ~ 10-04 第八轮（含）历史条目原文
  >   迁入 docs/archive/Web\_CHANGE-2026-09~10-04.md（一字未改，archive 目录
  >   gitignore 忽略）；本文件只留冻结线之后条目 + 本轮交付留痕
  > - PRD / 开发与计划 / E2E 测试流程 / HANDOFF / README 同步至本轮定稿口径
  >   （生产任务化、统一错误对象、lab 交付、依赖锁、web-ci、E2E 98 计数口径）
  > - docs/StudyMate-Web\_建课链路.md / 前端美化设计 / 探索测试指南 更新
  > - 根 docs/使用/StudyMate-Web.md 与 docs/设计/StudyMate-Web边界与契约.md：
  >   版本指针 0.6.0-beta → 0.7.0-beta、现状口径纠偏
  > - HANDOFF 第二十版：交付状态（四提交 + push + CI 待看实跑）
  > 
  > \* fix(Web运行时): GET /api/settings 改回密钥掩码 + CORS 收显式白名单（PR \#43 审查意见 1）
  > 
  > 明文回填输入框的设计叠加 allow\_origins=\["\*"\] + allow\_credentials=True 后，
  > Starlette 会把 Access-Control-Allow-Origin 反射成请求方 Origin——用户浏览器里
  > 任意网页都可 fetch('http://127.0.0.1:8101/api/settings') 读到密钥明文，后端绑
  > 127.0.0.1 挡不住（浏览器侧跨域），属 drive-by 泄漏面。
  > 
  > - get\_settings 只回掩码 \*\*\*\*\*\*\*\* + has\_key；PUT 与 /test 本就认掩码/空串为
  >   「保持原值」，语义不变
  > - CORS 收为本机 3800/3801/3810 × localhost/127.0.0.1 显式白名单，
  >   allow\_credentials=False（前端所有 /api 走 Next 同源代理，浏览器不直连 8101）
  > - ProvidersView 组件测试三处断言改掩码口径，fixtures.makeProvider 默认值改为
  >   GET 真实形状；后端补 GET 掩码 + 掩码回传不丢 key 断言
  > - PRD §1.3/§1.4 与《开发与计划》settings v3 同步（明文回填设计就此废弃）
  > 
  > \* fix(Web运行时): 快改与草稿读取路径判定接 unsafe\_relative\_reason（PR \#43 审查意见 2 / Linux CI 红）
  > 
  > PUT /tickets/{id}/artifact 与 GET /drafts/{slug}/files 原先只靠 resolve() +
  > 包含关系判越界：Linux 上反斜杠/冒号不是分隔与盘符语义，C:\\Windows\\evil.md
  > 被当成 base 下的普通文件名放过，落到 404 而非 400——即 web-ci Backend tests
  > 红的 test\_quick\_edit\_rejects\_absolute\_path。
  > 
  > 改调 tools.unsafe\_relative\_reason（Windows 语义跨平台一致：盘符/UNC/反斜杠
  > 上跳/ADS），resolve() 包含关系仍作兜底；快改 for\_write=True（额外拒反斜杠
  > 与冒号），草稿读取为读侧口径。补三条后端测试。
  > 
  > Web\_CHANGE 追加审查响应条目；HANDOFF 同步交付状态。

- test(契约): 宿主契约守门——拿真宿主的校验器扫 schema，钉住参考调用的字段（\#108） (\#109) ([4911910](https://github.com/Miaotofu01/Study-Mate/commit/49119107e4c9becee25e038e811c824256e424fd))

  > \* test(契约): 拿真宿主自己的校验器扫工具 schema，并钉住参考调用的字段（\#102 收尾）
  > 
  > 门禁里那条 schema 检查（test\_tools\_schema\_subset.mjs）把宿主的规则手抄成了一张
  > 关键字清单，抄漏了放置规则——2026-10-07 因此放过了 \`found: { const: true }\`
  > （有 const 没 type），宿主的 assertSupportedJsonSchema 当场拒收，答疑预设那条行整行
  > 挂不上，会话建都建不起来，而那道手抄的检查绿着通过。
  > 
  > 新增 test\_dsh\_contract.mjs（按需跑，\`npm run test:dsh-contract\`，同一个
  > STUDYMATE\_DSH\_PACKAGE；没设就跳过，不进 CI）：直接 import 宿主自己的校验器，扫注册点上
  > 全部 15 个工具的 parameters 与 output.schema；附一条反证（已知不合规的 schema 必须报错，
  > 否则这份套件自己是空转）；再读 dsh-webhook 的 createWebhookSession，核对
  > sessionId / meta / agentOptions / setup 四个字段没漂。
  > 
  > 同一个提交把「载荷的键」钉进默认门禁：test\_host\_ask\_session.mjs 断言 agents.create 的
  > 键恰好是那四个。少一个字段的代价实测过（漏 agentOptions 时会话建得出来、一按发送才报
  > 没有模型），多一个字段宿主不认识。
  > 
  > 先红后绿验过：把 lesson-read.ts 的 found 改回 { const: true }，新套件报
  > 「schema.oneOf\[0\].properties.found.const requires type or oneOf」——与 GUI 报错逐字相同；
  > 改回即绿。
  > 
  > \* docs(工程约束): 宿主契约的导航指针——形状照哪几份源码、怎么验（\#102 收尾）
  > 
  > 两次事故（工具 schema 不合规、建会话漏字段）能逃过实现期，一半原因是宿主的契约只住在
  > 宿主的源码里：这次为搞清 preset 注册、restrict、SessionProvider、引用来源，翻了很久，
  > 笔记还落在系统临时目录里，换台机器就没了。
  > 
  > 工程约束 §三 新增「宿主契约：形状照哪几份源码，怎么验」：STUDYMATE\_DSH\_PACKAGE 怎么定位
  > 宿主包，以及六个形状（工具 schema / 程序化建会话 / 预设注册与挂载 / 引用进草稿 /
  > 注册引用来源 / 嵌会话正文）各自该读哪一份源码——只给指针，不抄内容。两条纪律写在那里：
  > 照参考实现抄调用块时逐字段对；形状的判据优先问宿主本人（npm run test:dsh-contract），
  > 别在仓库里手抄第二份规则。
  > 
  > AGENTS.md 的入口表加一行指针，指向这一节。
  > 
  > ---------
  > 
  > Co-authored-by: Miaotofu01 &lt;196646782+Miaotofu01@users.noreply.github.com&gt;

- revert(Web运行时): 独立 Web 运行时移出主线，另存分支 web/0.7.0-beta ([fbd1fd1](https://github.com/Miaotofu01/Study-Mate/commit/fbd1fd1cc6bc8744236f159fa9e957e35187c04d))

  > Web 运行时（FastAPI + Next.js 的子项目）曾是架在老 Python 引擎上的第二条前台，
  > 它自带建课链、产课链、总控会话与状态机，与目标态的单引擎口径正面冲突
  > （ADR-0003 明文否掉「独立 Web 应用」，ADR-0005 否掉双渲染）。本次把它从主线移出：
  > 
  > - 移出 study-mate-web/\*\*、.github/workflows/web-ci.yml、docs/使用/StudyMate-Web.md、
  >   docs/设计/StudyMate-Web边界与契约.md，以及 README 里的两处入口。
  > - Web 的完整历史留在分支 web/0.7.0-beta（= 92d1122）。后续定位于「自带引擎的第二形态」：
  >   等贡献者按新引擎的接口适配后合回 main，回流条件与手法见 docs/adr/0013。
  > - \*\*保留\*\*同一个提交里那个与 Web 无关的真 bug 修复：scripts/check\_lesson.py 的
  >   RefScanner 改用按真实 HTML 元素取引用（教学示例里的 photo.png 不再被误报成断链），
  >   以及 scripts/tests/test\_lesson\_links.py 的 7 条配套用例。Web 分支仍持有这两份文件。

- Merge remote-tracking branch 'origin/refactor/reading-end-and-ts-engine' ([3da8b0a](https://github.com/Miaotofu01/Study-Mate/commit/3da8b0a16cd7b0ef37924b16faa0c9e4ea92e2ae))
- docs(ADR): 0013 Web 运行时移出主线；0003 的禁令收窄到 DSH ([c5749c2](https://github.com/Miaotofu01/Study-Mate/commit/c5749c2c4e8e6dfa48fdc0bae955aad51acec190))

  > - 新增 0013：Web 运行时移出 main，定位为「自带引擎的第二形态」；写明回流条件
  >   （数据格式与角色规格单一来源、引擎逻辑各写一份）与回流手法（直接 merge 那条分支
  >   是空操作，要 rebase 或显式 revert 掉撤销提交）。
  > - 改写 0003 正文：标题与决定不动，把禁令限在 DSH 里的阅读端（不做第二个 DSH 前端），
  >   并把 Consequences 里那句「界面只能跑在 DSH 里」限定为「插件里的阅读端」。

- docs(词表): 收口引擎与阅读端，新增 Web 运行时；README 留一行分支指针 ([73c6e8e](https://github.com/Miaotofu01/Study-Mate/commit/73c6e8eb1d52a12efa7f60edb4c45f1213c122eb))

  > - 引擎：默认指随插件发布的那一套。
  > - 阅读端：指插件端那个界面；Web 运行时自带界面，不叫阅读端。
  > - 新增 Web 运行时：自带引擎与界面、跑在浏览器里、与插件端读写同一份工作区。
  > - README 的「配置与维护」末尾留一行指针指向分支 web/0.7.0-beta 与 ADR-0013
  >   （放这一段的末尾，避开引擎切换那一轮会改的 README 行）。

- merge(引擎): 合入 \#102 的 TypeScript 引擎，Python 引擎整体退役 ([1af9195](https://github.com/Miaotofu01/Study-Mate/commit/1af9195d0187600bc00264fef35f0cac71603566))

  > 引擎改用随包发的 TypeScript 实现，不再依赖 Python（ADR-0002）；课件源文件进
  > \`lessons/\*.md\`，页面由阅读端实时渲染、静态页面降为 \`studymate export\` 的产物
  > （ADR-0005）；示例与生成产物不再入库（ADR-0009）；技能从 \`.dsh/skills/\*\*\` 搬到
  > \`preset/skills/\*\*\`。答疑面板改成一段真会话（ADR-0012）。
  > 
  > 冲突两处，都是 \`scripts/check\_lesson.py\` 与 \`scripts/tests/test\_lesson\_links.py\`
  > 的「一边删、一边改」：本侧保留着那次引用误报修复（RefScanner 按真实 HTML 元素取
  > 引用，教学示例里的 \`photo.png\` 不再被误报成断链），那一侧把这两个 Python 文件整体
  > 删掉（引擎换实现）。
  > 
  > 按「接受删除」解，理由是新引擎已经把这条检查重实现，且旧 bug 那一类不可能再出现：
  > 引用只从解析出来的 \`::: figure\` 块取（\`lib/core/lesson.ts\` 的 \`checkFigureSrc\` 钩子，
  > 实现在 \`lib/tools/validate.ts\`），不再有「扫渲染后 HTML」这一步，把正文里出现的
  > \`photo.png\` 当引用误报的失败形态不成立。那次修复与它的 7 条用例仍留在分支
  > \`web/0.7.0-beta\` 上。

- test(夹具): mini-react 重建时带上无子节点元素的 innerHTML（\#97） ([617c5a7](https://github.com/Miaotofu01/Study-Mate/commit/617c5a750ea95855b80e5d90a7efed7070b318e9))

  > mini-react 每次重渲染都整树重建 DOM，而 effect 只在 deps 变化时重跑。真 React 不碰
  > 「自己没渲染过子节点」的元素的内部，所以客户端用 ref + innerHTML 贴进去的内容
  > （SvgFrame 的内联 SVG 就是这么贴的）在真 React 里活得下来——在夹具里却会被下一次
  > 重渲染抹掉。后果是「客户端产出的内联 SVG」这类面零浏览器覆盖：套件里现造一个同形状
  > 的元素只能证明 CSS 规则写得对，证明不了客户端真的把内容里的图形贴了上去（\#89 的
  > 报告如实记过这条，但它看着像「已经验过了」）。
  > 
  > draw() 现在把无 React 子节点元素的 innerHTML 按路径带到重建后的同位置元素上；
  > 带 dangerouslySetInnerHTML 的不带——那份内容由 props 每次渲染，搬旧值过去只会把
  > 新值盖掉（公式那条路就是它）。
  > 
  > 这条改动收窄的是夹具与真货的差别，不是给阅读端打补丁：客户端那段代码本身是对的。

- test(阅读端): 内联 SVG 配图补一场真渲染的浏览器用例（\#97） ([a47cd75](https://github.com/Miaotofu01/Study-Mate/commit/a47cd7559a58d032f127c927895c5d05c1211c35))

  > 夹具内容里写进一块真 ::: svg（alt: / caption: / 3:1 的 viewBox 与 900×300 的属性宽高），
  > lesson-body-\*-svg 两场断言全部打在\*\*客户端产出的那个 &lt;svg&gt;\*\* 上：它真渲染出来了
  > （命名空间是 SVG、里面有内容文件里的图形、弧线 d 逐字相同——不是空壳）、alt: 落成
  > role=img + aria-label、与位图共用一条「图 N」编号序列、随列宽流动且不超列宽、
  > 比例来自 viewBox 没被拉伸、暗色下被压暗。主场景与暗色场景里原先「现造一个同形状元素
  > 去量 CSS 契约」的那一段，换成了量真货。
  > 
  > 断言全是关系式（随列宽、不超列宽、暗色下有滤镜），不钉具体像素——呈现条目是意图级的。
  > 宽窄两档各跑一遍，两场各留一张截图（末尾停在暗色，看的就是「不刺眼」）。
  > 
  > README 的套件表与验收文档 §四/§六 那条「内联 SVG 零覆盖」的去向一并更新；
  > 没加新套件文件，所以 checks.mjs 的登记表不用动（它按文件算归属）。

- docs(用词): 用词与条数收口——路由条数、术语「前端」、课件格式里的「渲染器」 ([22d337b](https://github.com/Miaotofu01/Study-Mate/commit/22d337b2603ba67f1aee8c8bc5aabe1782c6f07f))

  > \#99 的三处一次收干净。只动文案与注释（一处校验提示语），标识符与逻辑不变。
  > 
  > - 条数：lib/route-envelope.ts 那句「五条 /api/studymate/\* 路由」在这之前已改成不依赖条数的
  >   说法（ac284e7 起），核对代码实际注册的 9 条路径（library / asset / reference / attempts /
  >   qa/session / lab-run / tasks / events / math）与《工程约束》§三逐条一致，无需再改；顺手清掉
  >   scripts/release/checks.mjs 里同一条事实残留的「五条」。
  > - 术语：GLOSSARY.md 规定「阅读端」不叫「前端」。改 lib/core/format.ts（含 fence 那条提示语）、
  >   lib/lab/route.ts、六个套件、目标态规格 §4.3/§5.3、ADR-0010、《重构评估》§2.1 标题。退役的
  >   页面资源与前端技术选型、词表自己的 \_Avoid\_ 行、CHANGELOG 与历史文档按原样留着（理由逐条见 \#99）。
  > - 「渲染器」：《课件内容格式》里报问题的几处（title 长度、title 逐字一致、围栏标签、行首 \#）改叫
  >   「校验器」，渲染进页面的几处（转义、图注编号与来源）改叫「阅读端」，与 §3 修复轮的叫法一致。

- merge(用词): \#99 用词与条数收口 ([1b3d590](https://github.com/Miaotofu01/Study-Mate/commit/1b3d5908084cd16c62cb18d0223df4bcb450610b))
- feat(导出): 公式资源按需携带——没有数学式的科目产物不带 KaTeX（\#96） ([3c6b967](https://github.com/Miaotofu01/Study-Mate/commit/3c6b967e3295738fdb4b367db89f7fadaf0e48b2))

  > 判据与阅读端同口径（正文 + 题库纯文本字段都算），分叉时只许多带：正文先剔掉代码
  > （围栏与行内代码里的 \`$\` 不是公式）、行内式允许跨行（阅读端把段落各行拼成一行再切，
  > 按「不许换行」判会漏掉写断在换行处的公式）；其余字段整串找。没有数学式就不搬 KaTeX
  > 的 JS / CSS / 字体，也不排 index.html 里那条静态 classic script——宿主声明成两个空串，
  > 阅读端据此判定「这台宿主没备资源」（不插样式表、不发请求），不去默认路由撞 404。
  > 
  > 无数学式的一份导出因此少 561,249 字节 / 25 个文件（引擎壳 272,794 + 样式表、
  > 21 个 woff2 字体与两份许可 288,455）；有数学式的产物行为不变。
  > 
  > 测试两端都补上：test\_export\_static\_page.mjs 加判据本身与「非数学课零 KaTeX /
  > 公式只在题库里照带 / 代码围栏里的 \`$\` 不算」四侧断言；browser/export\_file\_test.mjs
  > 另导一份没有数学式的科目，按 CDP 请求日志断整场零请求（harness 收
  > Network.requestWillBeSent 到 ctx.requests——\`file://\` 下 performance entries 是空的）。

- merge(集成): 合入 feat/84 的最新 tip（\#99 用词收口） ([985e6f4](https://github.com/Miaotofu01/Study-Mate/commit/985e6f4c738e64ef4e5c3bc82935df61491cb9ba))
- merge(集成): 把 feat/84-阅读端呈现收口 合进 \#97 ([f30bad3](https://github.com/Miaotofu01/Study-Mate/commit/f30bad3cc18c23565cbf152cd3a43efed003a70e))
- merge(阅读端): \#97 内联 SVG 配图的浏览器覆盖 ([1e2877b](https://github.com/Miaotofu01/Study-Mate/commit/1e2877b36c7127c4bd8005cf945a17bcf2ba407c))
- test(阅读端): 溢出判据改行级量法并加反证，对比度探针抽成共用夹具（\#98） ([c237fe3](https://github.com/Miaotofu01/Study-Mate/commit/c237fe320b999b72a65687a2b49a82c635f25d5a))

  > \#93 那条教训（\`.smb-agroup\` 自带 overflow:hidden ⇒ 只量滚动容器会把「字被裁」判成
  > 「没有溢出」）在搜索那两条断言上还留着同类假绿：原判据量 \`.smb-hit\` 结果行自己的
  > \`scrollWidth − clientWidth\`，而格子内部的溢出只要还留在行的内边距里，行读数就恒为 0——
  > 去掉长 URL 的 \`overflow-wrap\` 后，宽窄两档行读数仍是 0，只有行级 \`.smb-hit\_\_text\`
  > 量得到（实测 6/6/42px）。改成行级量法，并配一条反证：把这一格的折行拿掉，行级量法
  > 必须看得见溢出。
  > 
  > 顺查其余「有没有滚动条」当判据的地方（清单与逐条结论写进 scripts/tests/README.md
  > 的「横向溢出判据」一节）：右栏题库那一面结论相反——题干格是弹性项、默认 min-width:auto，
  > 自己会\*\*长到 min-content 宽\*\*（去掉 overflow-wrap 后实测 471px），pane/stem/每一行/选项
  > 四个 scrollWidth 读数全为 0，承重的是「内容右边缘 vs 裁切线」（overhang）；那些读数
  > 照旧留着当症状，判据本身不动。
  > 
  > 对比度探针在 reading\_test.mjs 与 reading\_routes\_test.mjs 各有一份副本（同一套合成算法，
  > 改一处要想着另一处）：抽成 fixtures/contrast-probe.mjs，两条套件都 import 它，取样点
  > 仍由各套件自己定。

- refactor(阅读端): .smb-crumb 两处规则收成一处，行为不变（\#98） ([7a81e9f](https://github.com/Miaotofu01/Study-Mate/commit/7a81e9f4832f35cc408906f4ace32bc78b4ebec0))

  > \`.smb-crumb\` 在文件里有两处基础规则：中栏那一处是面包屑住中栏时留下的旧代码，
  > 顶栏那一处才生效。同特异度下后写的赢，所以中栏那份实际只剩 display/align-items/gap
  > 三个属性在起作用——直接删掉它会改变计算样式。收成顶栏这一处，把那三个属性并过来，
  > 其余属性沿用生效那份的取值（font-size 用 --smb-fs-body、padding 3px 7px 等）。
  > 
  > 行为不变的实测：宽档 \`max-width\` 234px、窄档 156px（与收口前一致），两档下
  > \`.smb-crumb\` / \`.smb-crumb--current\` 的计算样式与几何逐条相同。

- docs(验收): 同步 \#98 的横向溢出判据清单与三条登记处 ([c98cc3e](https://github.com/Miaotofu01/Study-Mate/commit/c98cc3e836927903de0aaa9a4f0c6129baf1388d))

  > \`scripts/tests/README.md\` 新增「横向溢出判据」一节：把两条浏览器套件里以
  > 「有没有滚动条」当判据的地方逐条列出，说明量的是不是失败形态本身，并记下分界
  > （文字格会不会自己长宽决定 \`scrollWidth − clientWidth\` 管不管用）；夹具表补上
  > \`fixtures/contrast-probe.mjs\`。
  > 
  > \`阅读端呈现验收-2026-10-05.md\` §四 第 6/7/8 条与 §六 第 2/3/4 条是这三条问题的
  > 原始登记处，标成已由 \#98 收口（含实测读数），§五 第 2/7 条同步。

- Merge branch 'feat/84-阅读端呈现收口' into ticket/98-test-quality ([d9ea0c1](https://github.com/Miaotofu01/Study-Mate/commit/d9ea0c15635052d3c2786571c35cd579f94d3299))
- docs(验收): §四 第 2 条「导出总是带 KaTeX」记为已达成（\#96） ([498ad06](https://github.com/Miaotofu01/Study-Mate/commit/498ad0620ada9d3d6d0c0aa7e25fa997363bd26e))

  > 那条的「去向」原来写的是「已开票 \#96」并指着《课件内容格式》§3 里「导出这一侧还差
  > 这一步」——\#96 把两侧都收口了，指针得跟着改，不然下一轮看这份验收的人会追一条早做完
  > 的缺口。§五 的诚实边界同一条也标上闭环；当轮读数与截图不动（那是一次的证据）。

- merge(测试): \#98 测试质量收口 ([3d8488c](https://github.com/Miaotofu01/Study-Mate/commit/3d8488c7f277a1a44ccc2982bc70140e43b678bc))
- merge(集成): 合入 feat/84 的最新 tip（\#97 内联 SVG、\#98 测试质量收口） ([ff48fd5](https://github.com/Miaotofu01/Study-Mate/commit/ff48fd56ab995e33ef707603a5da5d637461db7a))
- merge(导出): \#96 公式资源按需携带 ([c559293](https://github.com/Miaotofu01/Study-Mate/commit/c559293de3b193e0d92de64ec89fd1f6df47413b))
- refactor(导出): \#96 的理由收成一处，hostScript / scriptFiles 的 math 参数改必填 ([c24247a](https://github.com/Miaotofu01/Study-Mate/commit/c24247af1cd3b6de251d572b72a774fcaaa4d033))

  > 两轴 code-review（\#84）点出的两件事，都在 page.ts：
  > 
  > · 同一条「为什么不带公式资源」在这里抄了三遍（hostScript 的文档注释、函数体里、②′
  >   那段）。按「一处定义，别处只给指针」收口：理由讲全在 hostScript 的文档注释（它是
  >   「为什么给空串」的落点），其余各处只说自己在那一刻的行为——②′ 继续讲「空串 = 阅读端
  >   按宿主没备资源降级」、scriptFiles 继续讲「不排它、排了就会真去取 272KB」，再各加一句
  >   指针。boot.js 那条本来就说行为（取不到就不挂），留原样。
  > · 两个 \`math = true\` 默认值都没有调用方依赖（唯一调用点 plan.ts 一直显式传参），而
  >   \*\*默认方向正是 \#96 要修的那个失败方向\*\*：谁漏传，就悄悄又把 272KB 带上。改成必填，
  >   漏传在 \`npm run test:types\`（默认门禁的第一关）就断。

- refactor(公式): 判据改名说清吃哪类文本，快照分派不再靠裸字符串 ([45b19aa](https://github.com/Miaotofu01/Study-Mate/commit/45b19aa14386e42d46a8ab450e2057153ae79ec8))

  > 两轴 code-review（\#84）点出的三处：
  > 
  > · \`lib/math.ts\` 的文件头自称「随包发的 KaTeX dist 的唯一一份清单与取址判据」，而 \#96
  >   新增的两个谓词是\*\*文本判据\*\*、与 dist 路径无关。选择「认下职责」而不是搬家：它答的是
  >   同一件事（有没有要排版的数学式），搬家要牵动 import、守卫与套件，收益只是换个文件。
  >   文件头因此改成「公式域」，写清这里同时是文本判据的家、阅读端那份实现靠套件对账。
  > · \`hasMathExpression\` 看不出吃的是哪类文本（要读注释才知道）：改成 \`hasMathInPlainText\`，
  >   与 \`hasMathInProse\` 成对——一个是纯文本字段（题库题面／选项／解析、objective / goal），
  >   一个是正文（先剔代码）。两条正则随之正名。
  > · \`snapshotHasMath\` 靠 \`key === 'lesson\_md'\` 这个裸魔法串分派：换成一张有名字的名单
  >   \`MARKDOWN\_FIELDS\`（并注明字段是 \`lib/library.ts\` 内联正文时铸的），改字段名时至少能
  >   找到一处「这里认得它」。
  > 
  > 顺带去掉第三个无效默认值：\`snapshotHasMath(value, key = '')\` 的缺省方向同样是「漏传就
  > 多带」。字段名下沉进递归那一半（必填），公开入口只收快照——顶层本来就不是任何字段，
  > 硬加一个必填参数只会逼调用方编一个空串魔法值。plan.ts 里重述 \#96 理由的那段也收成指针。

- test(公式): 引擎的纯文本判据与阅读端的 MATH\_ONLY 逐字对账（\#96 评审） ([2d55e2a](https://github.com/Miaotofu01/Study-Mate/commit/2d55e2a54e181aeffdea254f7175c0852543b372))

  > 票里明写「判据与阅读端同口径」，而这条判据两端各有一份实现（阅读端在 \`lib/client.js\` 的
  > \`MATH\_ONLY\`，导出侧在 \`lib/math.ts\`），此前没有任何东西盯着它们一致——漂了就是真的 bug
  > （导出少带引擎，页面降级成 TeX 原文）。仓库对同类「两端各有一份、必须一致」有先例：
  > \`MATH\_ENDPOINT\` 逐字一致、KaTeX 版本对账。
  > 
  > 钉法选 (a)：\*\*读 \`lib/client.js\` 源码\*\*取出那条正则，与引擎那份断言逐字相同（只差阅读端
  > 自己那层捕获括号与 /g——那是它 split 时留下分隔段的需要，不是判据的一部分）；再附一张
  > 用例表让两边各跑一遍，断言结论相同，兼防「正则可比但行为分叉」。不比 (b) 纯用例表结实：
  > 表外的输入照样漂。反证做过——把阅读端那条改成允许跨行，这条断言当场红。
  > 
  > 同时钉住那条\*\*有意\*\*的分叉方向：正文判据放宽换行（宁可多带），纯文本那条不放宽；两个
  > 方向都写进断言，避免有人「顺手统一」成漏带。

- test(夹具): 手贴 innerHTML 的搬运收窄到显式名单，别的门塞进来的不搬家 ([5807f26](https://github.com/Miaotofu01/Study-Mate/commit/5807f2654f543ae4b83ff7d6f79afc15786bbfa4))

  > \#97 为了量到真渲染的内联 SVG，让 mini-react 的整树重建把「无 React 子节点」元素的
  > innerHTML 按路径带回同位置元素——这条保真对\*\*全部浏览器套件\*\*全局生效，而它按「空叶子 +
  > 路径」猜，跨视图路径撞车时没有断言挡着：别的脚本、别的套件往一个 React 空叶子里塞的东西
  > 会被一起搬走，悄悄改掉「这个元素应该是空的」这类预期。
  > 
  > 收窄成一份\*\*显式名单\*\*：把 \`Element.prototype.innerHTML\` 的 setter 包一层，赋值时把元素
  > 实例记进 \`handPainted\`（\`dangerouslySetInnerHTML\` 由 props 每次渲染，不记）；重建前只从
  > 名单里的元素收内容，脱离树的在下一趟剔出去。搬运仍然只补空的 React 叶子、且标签相同。
  > 
  > 补一场 \`mini-react-carry\` 把边界钉住：走过 innerHTML 的那份还在（\#97 的保真没退化）、
  > 没走 innerHTML 的（appendChild 塞的）不搬、从没被动过的空叶子重建后依旧是空的。第二条是
  > 这条收窄的\*\*红→绿\*\*：收窄前 appendChild 那份真的被搬了过去（实测 FAIL）。

- docs(规范): 课件格式 §7 的「渲染器」换成不带歧义的说法 ([1c1ba80](https://github.com/Miaotofu01/Study-Mate/commit/1c1ba8020f2ad798cfd9945f8201a78504dc24db))

  > \#99 的验收要求这篇里「渲染器」的叫法与 §3（那里叫阅读端）一致，§7 这处漏了。
  > 判过整句的意思：这里的「扩展词汇」要动的是\*\*解析与渲染这套格式的那几处\*\*——
  > 解析器在纯函数域（\`lib/core/format.ts\`）、渲染在阅读端（\`lib/client.js\`），
  > 只写「阅读端」会把解析那一半漏掉、句子也读不通，所以改成这个集合的不带歧义说法：
  > 「解析与渲染这套格式的那几处 + 测试 + 本文档」。

- test(检查): 面包屑的注释跟上 \#98 把两处规则收成一处的收口 ([0c99ffe](https://github.com/Miaotofu01/Study-Mate/commit/0c99ffed0988e8e2b99b9b4bf3cf27dea13c2eb2))

  > 这条注释还写着「\`.smb-crumb\` 在文件里出现两处（中栏那一处是早先留下的、顶部那一处才是
  > 现在生效的）」——\#98 已经把中栏那份遗留规则删了，现在两条 max-width 是「基础一条 + 窄档
  > 覆盖一条」。只改注释，断言（\`widthRules.length &gt;= 2\`）不动：它仍旧必要。

- docs(验收): §四 第 4 条的 \#97 标注跟上夹具收窄后的机制（\#84 评审） ([1cd6094](https://github.com/Miaotofu01/Study-Mate/commit/1cd6094be4d941d2b6aa4f44dddf5092dd2cd410))

  > 那行还写着「mini-react 的重建把\*\*无 React 子节点\*\*元素的 innerHTML 按路径带到同位置
  > 元素上」——那是 \#97 当时的做法（按「空叶子 + 路径相同」猜），评审把夹具收窄成\*\*实例级
  > 显式名单\*\*之后，这句话与夹具实际做法不一致了。
  > 
  > 改成实际机制：只带「它看见被赋过 innerHTML」的元素（props 驱动的 dangerouslySetInnerHTML
  > 不在名单里），并点明不收窄会把别人从别的门塞进空叶子的内容一起搬走、那半边边界由
  > \`mini-react-carry\` 一场钉住。当轮读数（「未覆盖」、那张缺口描述）照旧保留，不动。

- merge(评审): 两轴 code-review 的七条修复 ([aa5b249](https://github.com/Miaotofu01/Study-Mate/commit/aa5b2499c1141a8c57d884d9b2b08f5274e74476))
- merge(阅读端): \#84 收口——导出按需公式资源、内联 SVG 覆盖、测试质量、用词（\#112） ([88baa77](https://github.com/Miaotofu01/Study-Mate/commit/88baa775aea59d3c60ae781341bcb277882e8328))

  > spec \#84「阅读端呈现收口」交活时留下的四条缺口，一次收口：
  > 
  > - \*\*\#96\*\* 导出按需携带公式资源：没有数学式的科目导出后不再引 KaTeX（实测少 561,249 B / 25 个文件；有数学式的产物逐字节不变）
  > - \*\*\#97\*\* 内联 SVG（\`::: svg\`）补一条真渲染的浏览器用例；为此收窄测试夹具的搬运边界（只搬运它看见被赋过 \`innerHTML\` 的元素）
  > - \*\*\#98\*\* 测试质量：溢出判据改行级量法并加反证、\`.smb-crumb\` 两处规则收成一处、对比度探针抽成共用夹具
  > - \*\*\#99\*\* 用词与条数收口
  > 
  > 四条各在自己的分支上做完再合进集成分支；合完对整条分支跑了一遍两轴 code-review（规范 / 规格），提出的问题一并修在 \`fix/84-评审修复\` 里（含引擎与阅读端「有没有数学式」判据的逐字对账 + 反证）。
  > 
  > 验证：\`npm test\` 1166 tests / 1164 pass / 0 fail；\`npm run test:browser\` 533 PASS / 0 FAIL。
  > 
  > 导出夹具仍缺一条 \`::: svg\` 覆盖，另见 \#113。

- docs(呈现): 记下代码块与终端块的重做方向（三版对比 + 两条硬约束） ([859d5b7](https://github.com/Miaotofu01/Study-Mate/commit/859d5b76fb01502f73d271f30033cad42c79d9f5))

  > 课件页里那个「运行结果」块看起来不像正经代码块。这一轮把它重做的方向定了，
  > 代码一行未动，本文是给「转 spec 与 tickets」用的输入。
  > 
  > 记下来的东西：
  > 
  > - 现状事实逐条带出处：它不是专门组件而是代码块的一个变体（\`term\` 围栏，
  >   \`lib/client.js:1060\`/\`:1373\`）；服务端结构里根本没有 \`term\`；\`term\` 在规范里
  >   没有语义定义；阅读端没有语法着色；这块\*\*一条都没引\*\*宿主自己那套代码块
  >   token（\`--dsw-alias-markdown-code-block\` 等亮暗各 7 条）；不支持 caption。
  > - 两条硬约束：颜色只能引 \`--dsw-alias-\*\`（\`test\_client\_tokens.mjs\` 兜着）；
  >   暗色下没有比页面更深的 surface，所以「真·黑终端」在 token 规矩内做不出来。
  > - 三版方向与结论：对齐宿主代码块的 A 立得住；B 的终端感没有底可托；C 像引用块。
  > - 已决方向七条与验收候选，另附三条遗留（代码块缺 caption 槽、\`term\` 缺语义、
  >   导出夹具缺 ::: svg 覆盖那条已开 \#113）。
  > 
  > 三版对比图归档在 docs/images/代码块-2026-10-07/；一次性原型未入库。


[完整比较](https://github.com/Miaotofu01/Study-Mate/compare/v1.0.0...v1.1.0)
<!-- /studymate-release:v1.1.0 -->

<!-- studymate-release:v1.0.0 -->
## [1.0.0](https://github.com/Miaotofu01/Study-Mate/releases/tag/v1.0.0) - 2026-10-02

### 已合并的 Pull Request

- feat: 适配了DeepSeek Harness Desktop(Windows)的安装 ([#33](https://github.com/Miaotofu01/Study-Mate/pull/33))
- docs(前端): 补充 VitePress 课程工作区迁移提案 ([#34](https://github.com/Miaotofu01/Study-Mate/pull/34))
- refactor(文档): docs/ 按用途归位，接入 agent 约定层 ([#37](https://github.com/Miaotofu01/Study-Mate/pull/37))
- feat(orchestration): add machine-verifiable subagent handoffs ([#39](https://github.com/Miaotofu01/Study-Mate/pull/39))
- docs(文档): 领域词表 ([#41](https://github.com/Miaotofu01/Study-Mate/pull/41))
- docs(文档): 删掉已废弃的桌面端方案 ADR ([#42](https://github.com/Miaotofu01/Study-Mate/pull/42))
- test(提示词): 交接守卫改成扫源码，删掉一条不会红的断言 ([#45](https://github.com/Miaotofu01/Study-Mate/pull/45))
- refactor(贡献契约): 契约降为原则与指针，同一事实只留一处 ([#47](https://github.com/Miaotofu01/Study-Mate/pull/47))
- refactor(提示词): 删掉对 continuable 子 agent 无效的 job\_output 等待规则，压瘦常驻上下文 ([#50](https://github.com/Miaotofu01/Study-Mate/pull/50))
- refactor(提示词): 暂存与落点单源化，总控只留公式与触发点 ([#52](https://github.com/Miaotofu01/Study-Mate/pull/52))
- test(提示词): 规则归属外置成声明表 + 技能调用面接进静态门禁 ([#54](https://github.com/Miaotofu01/Study-Mate/pull/54))
- refactor(提示词): 派工值归角色规格，「输入」节成为唯一出处 ([#56](https://github.com/Miaotofu01/Study-Mate/pull/56))
- refactor(工程约束): §四 补上参数形态，让「脚本用法的唯一出处」名副其实 ([#58](https://github.com/Miaotofu01/Study-Mate/pull/58))
- fix(发布): 恢复被 stale 分支合并冲掉的 release 元数据 ([#60](https://github.com/Miaotofu01/Study-Mate/pull/60))
- test(发布): 补一道「package.json 版本 == 最新 tag」的门禁 ([#62](https://github.com/Miaotofu01/Study-Mate/pull/62))

### 所有提交

- feat: 适配了DeepSeek Harness Desktop的安装 ([53f33d3](https://github.com/Miaotofu01/Study-Mate/commit/53f33d33bb830e91c3ae7c46600bc700b0248254))
- Merge pull request \#33 from ClauBloom/main ([8f9ef3a](https://github.com/Miaotofu01/Study-Mate/commit/8f9ef3ad659d301da3e5fc8fa26e3020c156e103))

  > feat: 适配了DeepSeek Harness Desktop(Windows)的安装

- docs(前端): 补充 VitePress 课程工作区迁移提案 ([7a2571e](https://github.com/Miaotofu01/Study-Mate/commit/7a2571ee9a3a3ca5a87a65ff75195891e2bb5ca0))
- Merge pull request \#34 from mia03ther/docs/vitepress-workspace ([8bfa731](https://github.com/Miaotofu01/Study-Mate/commit/8bfa73163a0e1f74086abc5b8188728e64b8a864))

  > docs(前端): 补充 VitePress 课程工作区迁移提案

- refactor(文档): docs/ 按用途归位，接入 agent 约定层 ([4a47b14](https://github.com/Miaotofu01/Study-Mate/commit/4a47b147545690964f556d9041d5b006a89a1bb8))

  > docs/ 原来是 11 份文档平铺在一层，看不出哪份是唯一约束来源、哪份只是使用说明；
  > agent 也没有统一入口——issue 记在哪、triage 标签叫什么、领域词表与 ADR 该放哪，
  > 每次都得重新推断。参照 Matt Pocock 工程技能的目录约定重排。
  > 
  > - docs/ 分四类：使用/（安装、使用说明、宿主说明、发布）、设计/（设计方案与方向
  >   探索）、规范/（工程约束、课件内容格式、文件归属）、agents/（agent 约定层）
  > - 新增 AGENTS.md：只放指针，每条规则的唯一出处仍在原处，不复述
  > - 新增 docs/agents/{issue-tracker,triage-labels,domain}.md：issue tracker 定为
  >   GitHub Issues（gh CLI），triage 用五个同名规范标签，领域文档声明为单上下文
  > - GLOSSARY.md 与 docs/adr/ 按「懒创建」处理：只声明布局，不落空文件
  > - README 目录树与 docs/ 说明同步；package.json 载荷 glob 改 docs/\*\*/\*.md
  > 
  > 顺带修掉一个真 bug：OpenAI 插件、Antigravity 插件、DSH 安装载荷三处都只复制
  > docs/ 一层的 .md，子目录会静默丢失，技能提示词里的 &lt;root&gt;/docs/&lt;子目录&gt;/&lt;名&gt;.md
  > 指针随之断掉。抽出 bin/docs-payload.mjs 统一递归枚举，三处共用；images/ 与
  > superpowers/ 明确排除在发布物之外。
  > 
  > 门禁：npm test 全绿（安装器、插件导出、静态契约、发布逻辑）；另拆包核对过插件
  > ZIP 里 docs 结构与仓库逐路径一致。docs/ 内 89 条相对链接逐条验证可解析，断链
  > 数与改动前基线相同（9 条均为占位符示例，非本次引入）。

- chore(文档): 删掉 00TODO.md 与 docs/superpowers/，待办改由 issue 维护 ([8048218](https://github.com/Miaotofu01/Study-Mate/commit/804821888fe7fb797acfb5093a9d73559c63e20a))

  > 00TODO.md 是给人工维护用的清单，5 条里 3 条已完成，只在顺手改文档时被打过勾，
  > 没形成维护节奏。剩下两条（出题 agent 提示词优化、SKILL 索引表）挪到 issue。
  > 这份清单本身也已被 GitHub Issues 接管，留着就是第二个真相源。
  > 
  > docs/superpowers/plans/2026-09-27-课件高亮与依据链.md 是本地工作草稿，从未入库，
  > 按维护者决定删除；该目录的守卫保留在 bin/docs-payload.mjs，防止它再长回发布物里。
  > 
  > AGENTS.md 同步：去掉 00TODO 那条指针，写明未完成的事走 GitHub Issues。
  > 
  > 门禁：npm test 全绿。仓库内已无 00TODO / docs/superpowers 的引用；AGENTS.md 的
  > 7 条链接逐条验证可解析。

- chore(仓库): 忽略 .idea/ 与 .vscode/ ([f766ace](https://github.com/Miaotofu01/Study-Mate/commit/f766ace6cf0a9a8d51c7be0b69a16a0f70fd59ef))

  > 从陈旧分支 chore/drop-todo-list（1597f07）抢救过来的唯一独立改动——那条分支
  > 其余内容已被本分支的 5e57290 覆盖，但 main 上确实还没忽略这两个 IDE 目录。
  > 单独成一次提交，便于审阅时忽略。

- fix(文档): 补上评审抓到的三处遗漏与两处坏味道 ([1b6c8ff](https://github.com/Miaotofu01/Study-Mate/commit/1b6c8ff3fc084edc7eb0f5f5c614af325a4fbcca))

  > code-review 的 Standards 轴与 Spec 轴并行评审（固定点 main），逐条处置：
  > 
  > \*\*成文标准违规\*\*
  > 
  > 1. \`docs/规范/工程约束.md\` 的目录约定树没更新——而这份正是「目录约定」的唯一出处。
  >    本分支只同步了 README，于是同一棵树在仓库里有两套互相矛盾的说法。
  > 2. \`docs/设计/设计方案.md\` 两处同样的过期树（正文与附录各一），改成指向工程约束。
  > 
  > \*\*规格偏离\*\*
  > 
  > 3. \`docs/agents/\` 不该随包分发：它是仓库自己的维护者配置（含本仓库的 gh 流程），
  >    而唯一入口 \`AGENTS.md\` 不在 npm files 里，发出去只是三份无入口的孤儿文档。
  >    载荷因此从 14 份收到 11 份，并写了原因，防止以后被当成漏拷补回去。
  > 4. \`AGENTS.md\` 自称「只放指针，不复述规则」，却复述了 \`npm test\` 门禁——
  >    把门禁并进 CONTRIBUTING 那一行的括号里。
  > 5. \`AGENTS.md\` 的文档地图漏了「决策」类（\`docs/adr/\`），与拍板的四类不符。
  > 
  > \*\*坏味道（判断项）\*\*
  > 
  > 6. 两个插件构建器里的 docs 复制块逐字重复。上一版只抽出了「枚举」这一层缝，
  >    复制＋改写仍各写一份；补出 \`writeDocsPayload\`，两处都调它。
  > 7. \`docs-payload.mjs\` 里指向已删目录 \`superpowers/\` 的守卫是死配置，去掉。
  > 
  > 门禁：npm test 全绿。

- refactor(文档): VitePress 提案归入 docs/设计/，修好合并处的两处路径 ([38bfa1e](https://github.com/Miaotofu01/Study-Mate/commit/38bfa1ef6ec07c480811654cd2fa8e2ffca949b7))

  > rebase 到 origin/main（8bfa731）后，main 带来的新内容要跟着这轮的目录归位：
  > 
  > - main 新增的 \`docs/VitePress工作区.md\` 是阅读端提案，归入 \`docs/设计/\`；
  >   它指向其它分类的兄弟链接各上一层（工程约束 / 课件内容格式 / 使用说明）
  > - main 在 \`工程约束.md\` 里加的那条 VitePress 链接随之改成 \`../设计/…\`
  >   ——这是链接检查器抓到的唯一一条真断链
  > - 两处目录描述补上这份新文档；工程约束那棵树顺带补上漏掉的
  >   \`antigravity/studymate/\`：main 刚把它的白名单变成发布阻断项，
  >   而这棵树号称是目录约定的唯一出处
  > 
  > 冲突处置：README 取 main 的新措辞 + 本轮的路径；release.mjs 取 main 的
  > antigravity 白名单 + 本轮的 docs 递归 glob；release.test.mjs 取 main 抽出的
  > tarballPack() 写法，并修正它新增的 tarballFiles 常量里两处旧 docs 路径
  > （naive 地「取 theirs」会把路径留旧）。
  > 
  > 门禁：npm test 全绿。仓库内 107 条相对链接逐条验证，断链数与基线相同。

- Merge pull request \#37 from Miaotofu01/refactor/matt-目录约定 ([3343019](https://github.com/Miaotofu01/Study-Mate/commit/3343019bff2d0a51c6b74600879260806571deb9))

  > refactor(文档): docs/ 按用途归位，接入 agent 约定层

- docs(桌面端): 词表与三份架构决策记录 ([b08b92b](https://github.com/Miaotofu01/Study-Mate/commit/b08b92b590682dea3195409ccf7fefbade0304f6))

  > 桌面端的设计会话（spec 见 \#38）定下了一批术语与三个不可逆的决策，落成可引用的唯一出处：
  > 
  > - GLOSSARY.md：15 个领域词；顺带消除同词冲突——「桌面端」指本应用，DeepSeek Harness 自己的桌面应用一律写「DSH 桌面端」（README 原来两者同词）。
  > - docs/adr/0001：外壳自研 + ACP 通道，附实测结论（ACP 不 mount preset、审批请求只带关联 id、ask\_user\_question 与 present 在 ACP 会话里缺失）。
  > - docs/adr/0002：自带运行时 + 独立 DSH\_HOME + 学习专用；装配机制按实测从「设默认 preset」改为「顶层 patch 行」。
  > - docs/adr/0003：阅读端走 Vue 组件、HTML 渲染器保留为宿主交付。
  > 
  > 三份 ADR 状态均为 proposed：代码未开工，决策仍可改。同时修掉 AGENTS.md 与领域文档里「这两份还不存在」的过期说法。

- Merge pull request \#41 from Miaotofu01/docs/glossary-adr ([b8ce74f](https://github.com/Miaotofu01/Study-Mate/commit/b8ce74ffb9a0f067ca1ca6d327885cbca4762df4))

  > docs(桌面端): 词表与三份架构决策记录

- docs(文档): 删掉已废弃的桌面端方案 ADR ([bd7787f](https://github.com/Miaotofu01/Study-Mate/commit/bd7787ffc63af6e85389e1e8bbb8208633bc3c02))

  > 桌面端方案（spec 见 \#38）已废弃，撤掉 \#41 随词表一起合进来的三份决策记录，
  > 并把因此变陈旧的指针改回原状：
  > 
  > - 删 docs/adr/0001-0003（外壳与 ACP 通道／自带运行时与独立配置目录／阅读端与渲染路径）——方案不做，决策失去意义。
  > - GLOSSARY.md：删「桌面端」词条——它定义的就是这个已废弃的应用；为区分 DeepSeek Harness 自己的桌面应用而定的「一律写 DSH 桌面端」写法规则一并作废。
  > - AGENTS.md 与 docs/agents/domain.md：docs/adr/ 从「已建立」改回「按需创建」（目录已空，不存在是正常的），词表仍为已建立。
  > 
  > 内容仍可从 b08b92b 与 PR \#41 的历史里取回。
  > DSH 桌面端（第三方宿主）相关文档与安装器的 desktop 档位不受影响。

- Merge pull request \#42 from Miaotofu01/docs/remove-desktop-adr ([d4d731c](https://github.com/Miaotofu01/Study-Mate/commit/d4d731ce910504d0071f98f05f2eddf57679df11))

  > docs(文档): 删掉已废弃的桌面端方案 ADR

- feat(交接): 子 agent 暂存交接加机器校验门禁 ([e6e475d](https://github.com/Miaotofu01/Study-Mate/commit/e6e475d64ebf03615223ab2b2c4094c2fbce5231))

  > - 角色经 \`.stage/&lt;角色&gt;-&lt;任务&gt;/deliver/\` 交接时，必须在同一 stage 根写 \`handoff.json\`；总控在任何 \`cp\`／合并之前先跑 \`check\_handoff.py\`，非零就\*\*不搬、不删 stage\*\*，把原始错误打回同一角色
  > - 此前这一步只有自然语言自述：总控是闭眼 \`cp -r\`，且同一条命令里 \`rm -rf .stage/\`——搬错既污染科目目录，也把唯一证据一起销毁
  > - 校验清单：角色/节点绑定、\`deliver/\` 全覆盖（多写的「顺手文件」阻断合盘）、路径边界（绝对路径／\`..\`／反斜杠／空段）、symlink 拒绝、重复 JSON key、\`succeeded\` 的 \`checks\` 必须真跑过、\`blocked\` 必须写明原因、可选 SHA-256 按盘上真实字节复算
  > - 只管交接边界，不替代 \`check\_curriculum.py\`／\`check\_lesson.py\`／\`check\_pool.py\`／\`render\_lesson.py --check\` 的领域校验；也不为凑清单改造直写正式位置的既有 owner
  > - 新增 \`schemas/agent-handoff.schema.json\`、\`scripts/check\_handoff.py\`、\`scripts/tests/test\_handoff.py\`（20 个用例，随 \`npm test\` 跑）、\`docs/规范/Agent交接协议.md\`（唯一口径）；4 份 SKILL.md 同步（3 个角色写清单、总控合盘前先验）
  > 
  > Co-authored-by: GodBlessRen &lt;46345883+GodBlessRen@users.noreply.github.com&gt;

- test(提示词): 交接守卫改成扫源码，删掉一条不会红的断言 (\#45) ([174550d](https://github.com/Miaotofu01/Study-Mate/commit/174550d927c301d5cd1985f2fa6019624e866038))

  > \#39 新加的两条防回归断言里，Antigravity 那条永远变不了红：两份适配器的正则都只认不带引号的
  > 脚本路径，所以「源码带引号」和「源码不带引号」导出的那一行逐字节相同（实测），产物层面根本没有
  > 可观测差异——那条 assert.equal 实际只保证了文案存在。
  > 
  > 改成在源码层守根因：技能里任何 \`python3 ... '&lt;root&gt;/scripts/x.py'\`（脚本路径被引号包住）都会被
  > 两个宿主适配器静默跳过，现在 test\_skill\_rules.py 直接扫 .dsh/skills/\*\* 拦下，不必等构建，
  > 而且对两个宿主同时成立。
  > 
  > 另加一条反向断言（不带引号的调用必须仍有若干处），防止守卫本身变成空转——这次就是栽在
  > 「断言永远成立」上。
  > 
  > 两个方向都做了负向对照：注入带引号写法 → 红并报出 learning-system:168；清掉调用把计数压到
  > 阈值以下 → 红。
  > 
  > Co-authored-by: Miaotofu01 &lt;196646782+Miaotofu01@users.noreply.github.com&gt;

- fix:异常题目数据导致后续题组无法显示 ([e8be342](https://github.com/Miaotofu01/Study-Mate/commit/e8be34293d3f064f5ee40cd3043a31939c5255df))
- refactor(贡献契约): 契约降为原则与指针，同一事实只留一处 (\#47) ([41b7aaa](https://github.com/Miaotofu01/Study-Mate/commit/41b7aaae9865ab22e3553eedb51eb9e6376984f5))

  > \* refactor(贡献契约): 契约降为原则与指针，同一事实只留一处
  > 
  > CONTRIBUTING.md 此前把流程规则、工程细节与已经枯萎的剧情事实混在一
  > 起：它说 \`test\` 是遗留分支、PR \#10 至今没合回来，而该分支已删除、那
  > 两个提交早已进 main；同一事实又被抄在十几处，改一处就会留下别处的
  > 错。现在：
  > 
  > - CONTRIBUTING.md 是唯一出处，只留机器查不了、新人会问的原则，细节
  >   外链到各自的唯一出处；AGENTS.md 降为只给指针
  > - 删掉「PR 目标分支只能是 main」：它的理由已消失，main 本就是默认分
  >   支，而它真实的失败形态是「基分支不是 main 的 PR 静默地没有 CI」。
  >   ci.yml 改成在所有 PR 上跑，选错基分支不再无声无息
  > - 门禁仍是唯一一条 npm test，不加强制门、不加断言、不加依赖；命令
  >   与前置归 scripts/tests/README.md，脚本用法归工程约束 §四
  > - 修掉 check\_curriculum.py 的假绿：未装 jsonschema 时它会先打印跳过
  >   校验、紧接着打印「schema 校验通过」。现在只报结构检查通过，并在末
  >   尾汇总哪些文件的 schema 没校验
  > - 删掉模板资源清单「分散在三处」的过时说明（实际只有 lessonfile.py
  >   一份）、README 与工程约束互相矛盾的双份目录树与「docs 分四类」
  > - Node/Python 版本口径锚到 package.json 与 CI，示例里「Python 3.8」
  >   改成与安装器一致的 3.9+
  > - 新增 PR 模板与三份 issue 模板；ADR 0001 记录这次拍板（为何删
  >   main-only、为何不开强制门、为何不加一致性断言）
  > 
  > 验收：npm test 全绿；契约内链逐条可达；提到的 npm script 都真实存在。
  > 
  > \* docs(贡献契约): ADR 与词表都已建立，AGENTS.md 的两处指针跟上
  > 
  > ---------
  > 
  > Co-authored-by: Miaotofu01 &lt;196646782+Miaotofu01@users.noreply.github.com&gt;

- refactor(提示词): 删掉对 continuable 子 agent 无效的 job\_output 等待规则，压瘦常驻上下文 (\#50) ([48f1675](https://github.com/Miaotofu01/Study-Mate/commit/48f16757970eff3336666a6b7bc7a59598355c9b))

  > \`job\_output(wait: true)\` 只对有 \`jobId\` 的后台作业有效；本仓 \`subagent\` 走 continuable 模式返回
  > \`subagentId\`，照这条规则做必然查无此 job。等待语义本来就归框架（系统提示与工具描述已写明
  > "do not busy-poll or sleep"），技能里只该留框架管不到的那半：同一科目同时只有一个写入者。
  > 
  > 顺带把这条规则的维护成本收掉：
  > - 常驻提示词压瘦：learning-system 28,377→26,175 B、record-keeping 10,955→10,120 B，
  >   并删掉跨文件的重复口径（handoff 复述、暂存机制两处、/tmp 细节两处）
  > - 适配器锚点从整句改成结构锚点，并删掉两处已经静默空转的死锚点
  >   （\`单会话推进 1-2 个节点\`、\`present 呈上更好\`），修掉一对错位
  >   （对 learning-system 用了只存在于 record-keeping 的句子，反之亦然）
  > - 补上"锚点必须还有家"的守卫：适配器声明作用域，锚点在声明范围内必须命中
  > - 报警器脆性：18 条整句锚点改成句中承重词（源码零改动），删掉 2 条动机解释
  > - 9 处 \`python3\` 补齐 \`-B\`（此前只对 learning-system 有这条规矩）
  > 
  > \`npm test\` 全绿（539/539 条规则在位）。
  > 
  > Co-authored-by: Miaotofu01 &lt;196646782+Miaotofu01@users.noreply.github.com&gt;

- refactor(提示词): 暂存与落点单源化，总控只留公式与触发点 (\#52) ([ebf045d](https://github.com/Miaotofu01/Study-Mate/commit/ebf045dbd5486ce44e58e018a3fbeb42c850575f))

  > 同一件事原先有四处正文：总控开场 0.5 段与「暂存模式的收尾」、record-keeping
  > 「读写规则」第 7 条、工程约束的两处；image-scout 还反向允许把临时文件写进
  > 系统临时目录。改一条落盘规则要记得改四处，而这段又是全文件最热（12 个提交
  > 碰过）；31 条断言把两份副本都钉住，提权话术与沙箱模式名却 0 条覆盖。
  > 
  > owner 收敛到 record-keeping 的「工作区根与落点交付」（它本来就是写盘规则协议、
  > 开场即加载）：总控第 0 步只留落点公式与一句指针，会话结束留一行触发点，
  > 工程约束只留 DSH 侧的机制解释与指针，image-scout 的临时文件改回科目内 .stage/。
  > 
  > 顺带修掉导出产物里两个老问题：OpenAI / Antigravity 的宿主约定叫总控用
  > &lt;STUDYMATE\_SCRATCH&gt;，而「不许用 /tmp」被泛化替换成「不许用 &lt;STUDYMATE\_SCRATCH&gt;」，
  > 语义正好反了；OpenAI 侧还漏 &lt;SESSION\_DIR&gt;、沙箱模式名与 prefs.md 路径。两个适配器
  > 现在按宿主口径改写这几行，Codex 的 12 份导出不再出现 DSH 专有暂存措辞。
  > 
  > 总控正文 26,175 → 22,845 B（−12.7%，占全部提示词 24.3% → 21.2%），协议侧
  > 10,120 → 13,608 B；同一事实四处 → 一处。测试只挪键（12 条断言从 learning-system
  > 移到 record-keeping），断言形式未改——把 528 条改成「规则有家」的归属契约留给下一步。
  > 
  > Refs \#51
  > 
  > Co-authored-by: Miaotofu01 &lt;196646782+Miaotofu01@users.noreply.github.com&gt;

- test(提示词): 规则归属外置成声明表 + 技能调用面接进静态门禁 (\#54) ([75325b2](https://github.com/Miaotofu01/Study-Mate/commit/75325b25e064f5abe7eec21c3bc6f32b4adc1394))

  > \* refactor(提示词): 暂存与落点单源化，总控只留公式与触发点
  > 
  > 同一件事原先有四处正文：总控开场 0.5 段与「暂存模式的收尾」、record-keeping
  > 「读写规则」第 7 条、工程约束的两处；image-scout 还反向允许把临时文件写进
  > 系统临时目录。改一条落盘规则要记得改四处，而这段又是全文件最热（12 个提交
  > 碰过）；31 条断言把两份副本都钉住，提权话术与沙箱模式名却 0 条覆盖。
  > 
  > owner 收敛到 record-keeping 的「工作区根与落点交付」（它本来就是写盘规则协议、
  > 开场即加载）：总控第 0 步只留落点公式与一句指针，会话结束留一行触发点，
  > 工程约束只留 DSH 侧的机制解释与指针，image-scout 的临时文件改回科目内 .stage/。
  > 
  > 顺带修掉导出产物里两个老问题：OpenAI / Antigravity 的宿主约定叫总控用
  > &lt;STUDYMATE\_SCRATCH&gt;，而「不许用 /tmp」被泛化替换成「不许用 &lt;STUDYMATE\_SCRATCH&gt;」，
  > 语义正好反了；OpenAI 侧还漏 &lt;SESSION\_DIR&gt;、沙箱模式名与 prefs.md 路径。两个适配器
  > 现在按宿主口径改写这几行，Codex 的 12 份导出不再出现 DSH 专有暂存措辞。
  > 
  > 总控正文 26,175 → 22,845 B（−12.7%，占全部提示词 24.3% → 21.2%），协议侧
  > 10,120 → 13,608 B；同一事实四处 → 一处。测试只挪键（12 条断言从 learning-system
  > 移到 record-keeping），断言形式未改——把 528 条改成「规则有家」的归属契约留给下一步。
  > 
  > Refs \#51
  > 
  > \* test(提示词): 规则归属外置成声明表，check\_skill 接进静态门禁
  > 
  > 528 条断言原先只问「这句话在这份文件里」，于是有两件事做不到：把一条规则从总控
  > 搬进它加载的协议时，必须手工挪断言键（\#52 挪了 13 条）；而工程约束声称
  > \`scripts/check\_skill.py\` 校验技能调用面，它其实不在任何门禁里跑——\`grep check\_skill\`
  > 只命中它自己的说明文字，\`user-invocable: false\` 零正向断言，谁把角色改回可调用都不会红。
  > 
  > 改动：
  > 
  > - 新增 \`scripts/tests/rule-owners.json\`：\`reaches\` 声明谁加载谁（总控 → record-keeping /
  >   local-qa / learning-discovery；讲解 → lesson-design；出题评估 → layered-practice /
  >   evidence-check），\`moved\` 声明某条规则的正文住在哪个协议里。断言从此问「这个技能够不够
  >   得着这条规则」：owner 默认是键所在的技能，声明过就按声明走，且 owner 必须在该技能的可达
  >   名单里。\*\*以后搬规则 = 提示词改一处 + 表里加一行，断言不用动\*\*（已在真数据上验证）。
  > - 表自身的守卫：技能名写错、\`moved\` 条目对不上规则说明、owner 够不着，都当场报错；
  >   另加一组合成自检，证明 \`owner\_of\` / \`reachable\` 是活的，\`moved\` 空表也不是死代码。
  > - \`check\_skill.py\` 补上第二个面：角色除 \`disable-model-invocation: true\` 外还要
  >   \`user-invocable: false\`；协议与总控两个面都开。
  > - 新增 \`scripts/tests/test\_skill\_frontmatter.py\` 并登记进 \`checks.mjs\` 的 \`--static\`：
  >   5 个角色 / 7 份协议的分类写死在测试里，新增技能必须显式分类，不能被自动划进协议那侧。
  > - 查重\*\*不做\*\*：实测 ≥24 字的片段里没有一条是整句复述（48 条命中的全是共享标识符——
  >   命令、路径、schema 文件名、frontmatter 键、故意统一的小节标题、以及 Q6 故意留的落点公式），
  >   naive 查重只会逼出一张把全部命中都豁免掉的名单，等于空转。真正会复发的失效模式是
  >   「搬规则时在原处留副本」，那由 \`moved\` 的 owner 归属守住。
  > 
  > Refs \#53
  > 
  > ---------
  > 
  > Co-authored-by: Miaotofu01 &lt;196646782+Miaotofu01@users.noreply.github.com&gt;

- refactor(提示词): 派工值归角色规格，「输入」节成为唯一出处 (\#56) ([bce408d](https://github.com/Miaotofu01/Study-Mate/commit/bce408db2a36bf781a62f99426e27b5e2e67ee78))

  > \* refactor(提示词): 暂存与落点单源化，总控只留公式与触发点
  > 
  > 同一件事原先有四处正文：总控开场 0.5 段与「暂存模式的收尾」、record-keeping
  > 「读写规则」第 7 条、工程约束的两处；image-scout 还反向允许把临时文件写进
  > 系统临时目录。改一条落盘规则要记得改四处，而这段又是全文件最热（12 个提交
  > 碰过）；31 条断言把两份副本都钉住，提权话术与沙箱模式名却 0 条覆盖。
  > 
  > owner 收敛到 record-keeping 的「工作区根与落点交付」（它本来就是写盘规则协议、
  > 开场即加载）：总控第 0 步只留落点公式与一句指针，会话结束留一行触发点，
  > 工程约束只留 DSH 侧的机制解释与指针，image-scout 的临时文件改回科目内 .stage/。
  > 
  > 顺带修掉导出产物里两个老问题：OpenAI / Antigravity 的宿主约定叫总控用
  > &lt;STUDYMATE\_SCRATCH&gt;，而「不许用 /tmp」被泛化替换成「不许用 &lt;STUDYMATE\_SCRATCH&gt;」，
  > 语义正好反了；OpenAI 侧还漏 &lt;SESSION\_DIR&gt;、沙箱模式名与 prefs.md 路径。两个适配器
  > 现在按宿主口径改写这几行，Codex 的 12 份导出不再出现 DSH 专有暂存措辞。
  > 
  > 总控正文 26,175 → 22,845 B（−12.7%，占全部提示词 24.3% → 21.2%），协议侧
  > 10,120 → 13,608 B；同一事实四处 → 一处。测试只挪键（12 条断言从 learning-system
  > 移到 record-keeping），断言形式未改——把 528 条改成「规则有家」的归属契约留给下一步。
  > 
  > Refs \#51
  > 
  > \* test(提示词): 规则归属外置成声明表，check\_skill 接进静态门禁
  > 
  > 528 条断言原先只问「这句话在这份文件里」，于是有两件事做不到：把一条规则从总控
  > 搬进它加载的协议时，必须手工挪断言键（\#52 挪了 13 条）；而工程约束声称
  > \`scripts/check\_skill.py\` 校验技能调用面，它其实不在任何门禁里跑——\`grep check\_skill\`
  > 只命中它自己的说明文字，\`user-invocable: false\` 零正向断言，谁把角色改回可调用都不会红。
  > 
  > 改动：
  > 
  > - 新增 \`scripts/tests/rule-owners.json\`：\`reaches\` 声明谁加载谁（总控 → record-keeping /
  >   local-qa / learning-discovery；讲解 → lesson-design；出题评估 → layered-practice /
  >   evidence-check），\`moved\` 声明某条规则的正文住在哪个协议里。断言从此问「这个技能够不够
  >   得着这条规则」：owner 默认是键所在的技能，声明过就按声明走，且 owner 必须在该技能的可达
  >   名单里。\*\*以后搬规则 = 提示词改一处 + 表里加一行，断言不用动\*\*（已在真数据上验证）。
  > - 表自身的守卫：技能名写错、\`moved\` 条目对不上规则说明、owner 够不着，都当场报错；
  >   另加一组合成自检，证明 \`owner\_of\` / \`reachable\` 是活的，\`moved\` 空表也不是死代码。
  > - \`check\_skill.py\` 补上第二个面：角色除 \`disable-model-invocation: true\` 外还要
  >   \`user-invocable: false\`；协议与总控两个面都开。
  > - 新增 \`scripts/tests/test\_skill\_frontmatter.py\` 并登记进 \`checks.mjs\` 的 \`--static\`：
  >   5 个角色 / 7 份协议的分类写死在测试里，新增技能必须显式分类，不能被自动划进协议那侧。
  > - 查重\*\*不做\*\*：实测 ≥24 字的片段里没有一条是整句复述（48 条命中的全是共享标识符——
  >   命令、路径、schema 文件名、frontmatter 键、故意统一的小节标题、以及 Q6 故意留的落点公式），
  >   naive 查重只会逼出一张把全部命中都豁免掉的名单，等于空转。真正会复发的失效模式是
  >   「搬规则时在原处留副本」，那由 \`moved\` 的 owner 归属守住。
  > 
  > Refs \#53
  > 
  > \* refactor(提示词): 派工值归角色规格，「输入」节成为唯一出处
  > 
  > 派工接口（「总控必须给角色什么」）原先有三份出处：文件归属表那一列、总控正文的
  > 五处内联值、角色规格的「输入」节——三份已经不一致：总控漏了 \`&lt;root&gt;\`（表与
  > resource-scout 规格都有）；表里没有「实验课另给被验收节点 id + 项目目标」，
  > 总控却有；总控要求「必须给节点 kind」，而 practice-evaluator 规格明说 kind 自己
  > 从课程大纲读、别让总控贴节点全文；learning-coach 规格里那 6 项表里也没有。
  > 
  > 值归消费者：角色的「输入」节最清楚自己要什么，它成为唯一出处。总控的派发规范
  > 改成一条通用规则（派工前读一次该角色的「输入」节），五处内联值删掉——时机标签
  > （时机一 · 出题 / 实验任务 / 时机二 · 评估）与总控侧纪律（不规定内容怎么写、
  > 作答原文逐字转发）保留。文件归属表那一列整列删除，它只回答「谁维护哪份文件」。
  > 
  > 顺带修掉两处分节口径漂移（同一事实两处说法不同，都无门禁）：
  > - 「各领域当前水平」不是「共享记忆」的小节，是「我是谁」下面的一个条目
  >   （templates/MEMORY.md 一直如此），总控说错了层级；
  > - 建课顺序漏了使命的第四节 \`\#\# Out of scope\`（模板里有，唯一出处是
  >   learning-discovery:104）。
  > 
  > 新增两条契约：使命分节从三节改判四节；总控点名的落点必须在模板里有家
  > （反向验证过：改掉总控那串字立刻红）。两个宿主适配器按第 4 步那行的锚点从
  > \`\[^\\n\]+\` 放宽成 \`\[^\\n\]\*\`——那行现在没有尾随文字。
  > 
  > Refs \#55
  > 
  > ---------
  > 
  > Co-authored-by: Miaotofu01 &lt;196646782+Miaotofu01@users.noreply.github.com&gt;

- refactor(工程约束): §四 补上参数形态，让「脚本用法的唯一出处」名副其实 (\#58) ([5da784a](https://github.com/Miaotofu01/Study-Mate/commit/5da784a17ffe54c59596b8668423ccf7eb1e514b))

  > \* refactor(提示词): 暂存与落点单源化，总控只留公式与触发点
  > 
  > 同一件事原先有四处正文：总控开场 0.5 段与「暂存模式的收尾」、record-keeping
  > 「读写规则」第 7 条、工程约束的两处；image-scout 还反向允许把临时文件写进
  > 系统临时目录。改一条落盘规则要记得改四处，而这段又是全文件最热（12 个提交
  > 碰过）；31 条断言把两份副本都钉住，提权话术与沙箱模式名却 0 条覆盖。
  > 
  > owner 收敛到 record-keeping 的「工作区根与落点交付」（它本来就是写盘规则协议、
  > 开场即加载）：总控第 0 步只留落点公式与一句指针，会话结束留一行触发点，
  > 工程约束只留 DSH 侧的机制解释与指针，image-scout 的临时文件改回科目内 .stage/。
  > 
  > 顺带修掉导出产物里两个老问题：OpenAI / Antigravity 的宿主约定叫总控用
  > &lt;STUDYMATE\_SCRATCH&gt;，而「不许用 /tmp」被泛化替换成「不许用 &lt;STUDYMATE\_SCRATCH&gt;」，
  > 语义正好反了；OpenAI 侧还漏 &lt;SESSION\_DIR&gt;、沙箱模式名与 prefs.md 路径。两个适配器
  > 现在按宿主口径改写这几行，Codex 的 12 份导出不再出现 DSH 专有暂存措辞。
  > 
  > 总控正文 26,175 → 22,845 B（−12.7%，占全部提示词 24.3% → 21.2%），协议侧
  > 10,120 → 13,608 B；同一事实四处 → 一处。测试只挪键（12 条断言从 learning-system
  > 移到 record-keeping），断言形式未改——把 528 条改成「规则有家」的归属契约留给下一步。
  > 
  > Refs \#51
  > 
  > \* test(提示词): 规则归属外置成声明表，check\_skill 接进静态门禁
  > 
  > 528 条断言原先只问「这句话在这份文件里」，于是有两件事做不到：把一条规则从总控
  > 搬进它加载的协议时，必须手工挪断言键（\#52 挪了 13 条）；而工程约束声称
  > \`scripts/check\_skill.py\` 校验技能调用面，它其实不在任何门禁里跑——\`grep check\_skill\`
  > 只命中它自己的说明文字，\`user-invocable: false\` 零正向断言，谁把角色改回可调用都不会红。
  > 
  > 改动：
  > 
  > - 新增 \`scripts/tests/rule-owners.json\`：\`reaches\` 声明谁加载谁（总控 → record-keeping /
  >   local-qa / learning-discovery；讲解 → lesson-design；出题评估 → layered-practice /
  >   evidence-check），\`moved\` 声明某条规则的正文住在哪个协议里。断言从此问「这个技能够不够
  >   得着这条规则」：owner 默认是键所在的技能，声明过就按声明走，且 owner 必须在该技能的可达
  >   名单里。\*\*以后搬规则 = 提示词改一处 + 表里加一行，断言不用动\*\*（已在真数据上验证）。
  > - 表自身的守卫：技能名写错、\`moved\` 条目对不上规则说明、owner 够不着，都当场报错；
  >   另加一组合成自检，证明 \`owner\_of\` / \`reachable\` 是活的，\`moved\` 空表也不是死代码。
  > - \`check\_skill.py\` 补上第二个面：角色除 \`disable-model-invocation: true\` 外还要
  >   \`user-invocable: false\`；协议与总控两个面都开。
  > - 新增 \`scripts/tests/test\_skill\_frontmatter.py\` 并登记进 \`checks.mjs\` 的 \`--static\`：
  >   5 个角色 / 7 份协议的分类写死在测试里，新增技能必须显式分类，不能被自动划进协议那侧。
  > - 查重\*\*不做\*\*：实测 ≥24 字的片段里没有一条是整句复述（48 条命中的全是共享标识符——
  >   命令、路径、schema 文件名、frontmatter 键、故意统一的小节标题、以及 Q6 故意留的落点公式），
  >   naive 查重只会逼出一张把全部命中都豁免掉的名单，等于空转。真正会复发的失效模式是
  >   「搬规则时在原处留副本」，那由 \`moved\` 的 owner 归属守住。
  > 
  > Refs \#53
  > 
  > \* refactor(提示词): 派工值归角色规格，「输入」节成为唯一出处
  > 
  > 派工接口（「总控必须给角色什么」）原先有三份出处：文件归属表那一列、总控正文的
  > 五处内联值、角色规格的「输入」节——三份已经不一致：总控漏了 \`&lt;root&gt;\`（表与
  > resource-scout 规格都有）；表里没有「实验课另给被验收节点 id + 项目目标」，
  > 总控却有；总控要求「必须给节点 kind」，而 practice-evaluator 规格明说 kind 自己
  > 从课程大纲读、别让总控贴节点全文；learning-coach 规格里那 6 项表里也没有。
  > 
  > 值归消费者：角色的「输入」节最清楚自己要什么，它成为唯一出处。总控的派发规范
  > 改成一条通用规则（派工前读一次该角色的「输入」节），五处内联值删掉——时机标签
  > （时机一 · 出题 / 实验任务 / 时机二 · 评估）与总控侧纪律（不规定内容怎么写、
  > 作答原文逐字转发）保留。文件归属表那一列整列删除，它只回答「谁维护哪份文件」。
  > 
  > 顺带修掉两处分节口径漂移（同一事实两处说法不同，都无门禁）：
  > - 「各领域当前水平」不是「共享记忆」的小节，是「我是谁」下面的一个条目
  >   （templates/MEMORY.md 一直如此），总控说错了层级；
  > - 建课顺序漏了使命的第四节 \`\#\# Out of scope\`（模板里有，唯一出处是
  >   learning-discovery:104）。
  > 
  > 新增两条契约：使命分节从三节改判四节；总控点名的落点必须在模板里有家
  > （反向验证过：改掉总控那串字立刻红）。两个宿主适配器按第 4 步那行的锚点从
  > \`\[^\\n\]+\` 放宽成 \`\[^\\n\]\*\`——那行现在没有尾随文字。
  > 
  > Refs \#55
  > 
  > \* refactor(工程约束): §四 补上参数形态，让「脚本用法的唯一出处」名副其实
  > 
  > §四 开头写着「脚本用法的唯一出处就是本节……不重抄参数与行为」，但那节只有一张
  > 「脚本 → 干什么」的表，参数根本不存在于本节：真正的调用口径活在提示词里
  > （learning-system 7 处、record-keeping 3 处、3 份角色规格各 1 处），并被 7 条断言
  > 钉住。维护者想查一个脚本怎么调，得去翻提示词。
  > 
  > 改动：
  > 
  > - §四 补「参数形态」一列（宿主中立的形状：\`&lt;subject\_path&gt; &lt;节点id&gt;\`、\`--check\`、
  >   \`--subject/--node\`、\`\[--dry-run\] \[--render\]\`、TSV 三参…），补调用纪律
  >   （\`-B\` 与它防的那个坑），并把挤在一行的四个 \`check\_\*\` 拆成各自一行。
  > - 写明「技能正文里的命令是副本，不是出处」：它们是各宿主与本机改写过的形态
  >   （安装器把 \`python3\` 换成探测到的解释器并补引号，Codex / Antigravity 各自改写，
  >   而 docs 不做解释器改写），所以\*\*改形状只改本表\*\*。
  > - 新增契约（\`test\_templates.py\`，规格 ↔ 文档那一层）：提示词里调用到的引擎脚本必须在
  >   §四 有行；用到的每个 flag 必须在那一行的形状里出现；§四 每个脚本都要有参数形态，
  >   且写了 \`-B\` 的理由。
  > 
  > 提示词与角色规格一个字没改——它们的命令是被三个宿主改写的副本，契约负责两边不漂。
  > 反向验证过：往提示词里加一个 §四 没有的 flag（\`--strict\`）→ 红并指名脚本与 flag；
  > 把 §四 里 \`check\_lesson.py\` 的形状清空 → 红两条。
  > 
  > Refs \#57
  > 
  > ---------
  > 
  > Co-authored-by: Miaotofu01 &lt;196646782+Miaotofu01@users.noreply.github.com&gt;

- fix(发布): 恢复被 stale 分支合并冲掉的 release 元数据 (\#60) ([a1ff482](https://github.com/Miaotofu01/Study-Mate/commit/a1ff482824bd237a6919350efb07130b927ed1c6))

  > Release（major）在 \`release.mjs prepare\` 就退：\`package.json (0.2.0) and latest
  > release (v0.3.0) disagree.\`（run 37058516400）。
  > 
  > 根因是 53f33d3（fork PR「适配了 DeepSeek Harness Desktop 的安装」）从 stale
  > 分支合入时，把两个文件退回了 v0.3.0 之前的状态：package.json 从 0.3.0 改回
  > 0.2.0、CHANGELOG.md 删掉整个 v0.3.0 段（348 行）。tag 与 GitHub Release 都在，
  > 坏的是 main 上的元数据——release 脚本的检查没坏，它正是拦这个的。
  > 
  > 只恢复这两处：package.json 版本回到 0.3.0（与最新可达 tag 一致），CHANGELOG
  > 取自 v0.3.0 tag（纯新增 348 行，0 删除）。package.json 里 tag 之后的正当改动
  > （docs/\*.md → docs/\*\*/\*.md）原样保留。
  > 
  > npm test exit 0。
  > 
  > Refs \#59
  > 
  > Co-authored-by: Miaotofu01 &lt;196646782+Miaotofu01@users.noreply.github.com&gt;

- test(发布): 补一道「package.json 版本 == 最新 tag」的门禁 (\#62) ([c660192](https://github.com/Miaotofu01/Study-Mate/commit/c66019221ac1403d324c4819f6359c9958bf1614))

  > \* fix(发布): 恢复被 stale 分支合并冲掉的 release 元数据
  > 
  > Release（major）在 \`release.mjs prepare\` 就退：\`package.json (0.2.0) and latest
  > release (v0.3.0) disagree.\`（run 37058516400）。
  > 
  > 根因是 53f33d3（fork PR「适配了 DeepSeek Harness Desktop 的安装」）从 stale
  > 分支合入时，把两个文件退回了 v0.3.0 之前的状态：package.json 从 0.3.0 改回
  > 0.2.0、CHANGELOG.md 删掉整个 v0.3.0 段（348 行）。tag 与 GitHub Release 都在，
  > 坏的是 main 上的元数据——release 脚本的检查没坏，它正是拦这个的。
  > 
  > 只恢复这两处：package.json 版本回到 0.3.0（与最新可达 tag 一致），CHANGELOG
  > 取自 v0.3.0 tag（纯新增 348 行，0 删除）。package.json 里 tag 之后的正当改动
  > （docs/\*.md → docs/\*\*/\*.md）原样保留。
  > 
  > npm test exit 0。
  > 
  > Refs \#59
  > 
  > \* test(发布): 补一道「package.json 版本 == 最新 tag」的门禁
  > 
  > 53f33d3 从 stale 分支合入时把 package.json 退回 0.2.0、删掉 CHANGELOG 的
  > v0.3.0 段，这次回退在 main 上躺了两天，直到手动跑 Release 才被 release.mjs
  > 拦下。原因是没有任何门禁比对「package.json 版本」与「最新 tag」：release.mjs
  > 的检查只在发布那一刻跑，而 ci.yml 是浅克隆、根本读不到 tag。
  > 
  > 新增 scripts/tests/test\_release\_metadata.py：判据与 release.mjs 同源（VERSION /
  > RELEASE\_TAG 两个正则），取从 HEAD 可达的最新 v\* tag，package.json 的 version
  > 必须等于它；失败信息里直接给出修法。拿不到 tag 时本地跳过、CI 里红——CI 配了
  > fetch-depth: 0，那里读不到说明 checkout 配置坏了，守卫失效本身要报出来。
  > 
  > ci.yml 的 checkout 加 fetch-depth: 0（这是守卫的前置，理由写在旁边），新测试
  > 登记进 checks.mjs 的 --static。反向验证过：把版本退回 0.2.0 立刻红。
  > 
  > Refs \#61
  > 
  > ---------
  > 
  > Co-authored-by: Miaotofu01 &lt;196646782+Miaotofu01@users.noreply.github.com&gt;


[完整比较](https://github.com/Miaotofu01/Study-Mate/compare/v0.3.0...v1.0.0)
<!-- /studymate-release:v1.0.0 -->

<!-- studymate-release:v0.3.0 -->
## [0.3.0](https://github.com/Miaotofu01/Study-Mate/releases/tag/v0.3.0) - 2026-09-30

### 已合并的 Pull Request

- Integrate/learning discovery ([#20](https://github.com/Miaotofu01/Study-Mate/pull/20))
- feat: 修改落盘位置，统一将workspace-write下的授权放在课程生成最后，优化对bash工具的时间限制 ([#23](https://github.com/Miaotofu01/Study-Mate/pull/23))
- refactor(提示词): 配图不指定画法，渲染器职责独立成章 ([#24](https://github.com/Miaotofu01/Study-Mate/pull/24))
- feat(插件): 支持 Google Antigravity 原生多智能体插件包 ([#26](https://github.com/Miaotofu01/Study-Mate/pull/26))
-  feat(resources): 支持本地参考资料与教材路径导入 (fixes \#21) ([#27](https://github.com/Miaotofu01/Study-Mate/pull/27))
- fix(插件): 兼容 Windows CRLF 换行符下的 Antigravity 插件构建 ([#28](https://github.com/Miaotofu01/Study-Mate/pull/28))
- feat(讲解): 落笔前先读本节点的来源原文 ([#29](https://github.com/Miaotofu01/Study-Mate/pull/29))
- Refactor/architecture review ([#30](https://github.com/Miaotofu01/Study-Mate/pull/30))
- fix(发布): 打包白名单补上 antigravity，Release 不再自己拦自己 ([#31](https://github.com/Miaotofu01/Study-Mate/pull/31))

### 所有提交

- Add optional learning direction exploration and usage guide ([a2cb264](https://github.com/Miaotofu01/Study-Mate/commit/a2cb264efbedb1f0c80a8878ced74d74859e8949))
- Refine discovery handoff and add reproducible dialogue evaluation ([f3865f8](https://github.com/Miaotofu01/Study-Mate/commit/f3865f8f20743c98c38de67bcabc4d2c5838be30))
- Merge pull request \#10 from lyk05212007/learning-direction-exploration ([b26578f](https://github.com/Miaotofu01/Study-Mate/commit/b26578f800acea809e5512cfdc0e8abdf1ab58a9))

  > Add optional learning direction exploration

- fix(readme)：移除其他安装方式，增加安装说明 ([d8274f9](https://github.com/Miaotofu01/Study-Mate/commit/d8274f957503ffeded121ed89db8e371cd94287a))
- docs: 新增CONTRIBUTING.md ([7bd1a3b](https://github.com/Miaotofu01/Study-Mate/commit/7bd1a3bc0ed9ae978c8e35b9ae267e5ede9199e3))
- feat(学习流程): 接入可选的学习方向探索（集成分支） ([c6ab750](https://github.com/Miaotofu01/Study-Mate/commit/c6ab750d8c6d2db6beb9d94bbcd037a28a4a7477))

  > 把 origin/test 上 PR \#10 的方向探索功能整合到 main，并补上 main 这 43 个提交
  > 之后必须做的适配。
  > 
  > 为什么不能直接合：test 分支停在旧命名与旧文件结构上，直接合会让 main 倒退——文档
  > 术语回到「落盘／共享记忆」，装回已删除的 install.sh，并让 47 条词表断言失败。
  > 
  > 做法：以 main 侧为基准，把 test 的新增语义用 main 当前术语重述。
  > 
  > - 新增 \`learning-discovery\` 协议：入口挂在总控「会话开场」，探索只维护会话状态；
  >   术语与 main 对齐（写盘／共享记忆），不引入 \`MEMORY.md\` 直称
  > - 技能数 11 → 12、协议 5 → 6，各文档计数与目录树统一
  > - 丢弃 test 文档/测试对 \`install.sh\` / \`install.ps1\` 的引用（main 已改 npx 安装）
  > - OpenAI 插件侧同步：\`bin/openai-skill-ui.mjs\` 补新技能元数据，三处写死的技能数
  >   断言 11 → 12
  > - \`docs/learning-discovery-guide.md\` 改为从本仓库源码试用（原先指向个人 fork 与
  >   开发分支的克隆命令，合并后就是死指引）
  > - 修正 \`docs/learning-discovery-validation.md\` 里「项目没有 npm test」的失真记述
  > 
  > 验证：npm test / test:static / test:browser 三套全绿；词表 486/486、模板 8/8、
  > OpenAI 技能 9/9。

- Merge pull request \#20 from Miaotofu01/integrate/learning-discovery ([884314c](https://github.com/Miaotofu01/Study-Mate/commit/884314cf2148598e0a364417a77b486aee1aac4b))

  > Integrate/learning discovery
  > 合并test分支

- feat: 修改落盘位置，统一将workspace-write下的授权放在课程生成最后，优化对bash工具的时间限制 ([5d537cf](https://github.com/Miaotofu01/Study-Mate/commit/5d537cf72a9244f9e49976f5f8ddc4c353b1c8de))

  > 源自 \#19（原作者 @ClauBloom，署名保留）。原 PR 的 base 停在 v0.1.5，与 main
  > 分叉导致 GitHub 判定 dirty；本提交是把它移植到当前 main 的结果，语义不变、
  > 措辞按 main 现状重述。
  > 
  > 为什么需要这个改动：会话能写哪由 DSH 沙箱模式定，\`workspace-write\` 的可写集是
  > 「会话启动目录 + 系统临时目录」，配置里的 \`workspace\` 只是数据、沙箱不认。开场
  > 直接写它只会换来一串提权请求；bash 与文件工具的 \`/tmp\` 又不是同一个命名空间
  > （bwrap 的 \`--tmpfs /tmp\` vs 宿主 \`/tmp\`），拿它当中转站会丢文件。所以改成：
  > 课程先在 \`&lt;SESSION\_DIR&gt;/.studymate-stage/&lt;slug&gt;\` 建完，收尾时问一次落点再整体搬。
  > 
  > 移植时的调整：
  > - 术语按 main 现状：\`MEMORY.md\`/\`curriculum.yaml\` 在角色规格里用「共享记忆」
  >   「课程大纲」等代称；「落盘」统一为「写盘」
  > - 丢弃 \`install.sh\` / \`install.ps1\` / \`test\_install.py\` 的改动（main 已删除，
  >   安装改走 npx）；丢弃 \`.idea/\`（IDE 配置，另已加进 .gitignore）
  > - 保留 \`&lt;SESSION\_DIR&gt;\` 占位符定义（原 PR 引用了它在 main 上不存在的 0.5 步）
  > - \`bin/openai-skill-compat.mjs\` 同步：record-keeping 的工作区改写锚点、\`&lt;WS&gt;\` →
  >   \`&lt;LEARN\_WORKSPACE&gt;\`、DSH 专属配置路径改成中性说法、\`-B\` 标志纳入 python 命令
  >   改写、\`practice-evaluator\` 的 cp 改写指向 \`.stage/\` 路径
  > - \`-B\` 新增后 \`test\_openai\_skills.mjs\` 的命令正则与 gen\_home 数量断言同步
  > - 规则断言按 main 措辞对齐；\`test\_installer.mjs\` 增加「安装完必须说明会话开在哪」
  >   与「装出的技能副本是暂存口径」两条
  > 
  > 验证：npm test / test:static / test:browser 三套全绿；词表 514/514。

- Merge pull request \#23 from Miaotofu01/feat/write-boundary-staging ([fdb5072](https://github.com/Miaotofu01/Study-Mate/commit/fdb50725450473752a499c83d4cb191cdcbe1695))

  > feat: 修改落盘位置，统一将workspace-write下的授权放在课程生成最后，优化对bash工具的时间限制

- refactor(提示词): 配图不指定画法，渲染器职责独立成章 ([6c7a30d](https://github.com/Miaotofu01/Study-Mate/commit/6c7a30d7dc561786b5dd55d8fcc87b7f3ea41ac6))

  > 两处过度提示：
  > 
  > 一、配图路线表替讲解角色指定了画法——「库自带样例数据（skimage.data.\*、
  > cv2.samples、matplotlib.cbook.get\_sample\_data）」「自己画：matplotlib 脚本」
  > 「手写内联 ::: svg」，lesson-design 还把示意图和 ::: svg 绑死。用哪个库、写
  > 脚本还是内联 SVG，是实现细节，讲解按内容挑更合适。现在只留「来源」（自产／
  > 图片库／交总控派 image-scout），画法由它定。实测同一知识点，它自己选了内联
  > SVG——那条指定确实是多余的。
  > 
  > 二、渲染器的职责散在六处，「你别写 XX」的否定句跟着散在六处。集中成一节
  > 「渲染器负责的部分」（页面结构／上下节课指针／图注编号／来源许可／公式排版／
  > 成品样式），其余章节只写讲解要做什么。渲染器的真契约不变：::: 指令、alt:、
  > 图注一句话、公式 TeX 都在。
  > 
  > 顺带：讲解规格里复述派工的三段（渲染分工、改课件、被打回怎么办）删掉——派工
  > prompt 自然带上下文，规格里不该复述。image-scout 的「自己产图走另一条路」
  > 与使用说明的配图段同步去掉工具指定。
  > 
  > 验证：词表 514/514；npm test、test:static、test:browser 全绿。

- fix:删除课件强制中英对照讲解 ([a40b359](https://github.com/Miaotofu01/Study-Mate/commit/a40b3596887b19ba8dcf669f6240ea67168bbd7c))
- Merge pull request \#24 from Miaotofu01/refactor/prompt-配图 ([22e2159](https://github.com/Miaotofu01/Study-Mate/commit/22e2159f2098751b05a152f2844c65fc79d3507d))

  > refactor(提示词): 配图不指定画法，渲染器职责独立成章

- feat(插件): 支持 Google Antigravity 原生多智能体插件包 ([b0c4dc4](https://github.com/Miaotofu01/Study-Mate/commit/b0c4dc481a9e6093be7674089f2293e285ba5b7c))

  > - 新增 Antigravity 插件构建入口 \`studymate build-antigravity \[--install\]\` 与分发打包
  > - 基于 Antigravity 原生能力适配 5 个专用子智能体 (agents/\*.md) 与 12 个完整技能规范
  > - 规范 \`ask\_question\` 交互模态与 \`invoke\_subagent\` 异步多智能体协同
  > - 完善 \`docs/Antigravity.md\` 与自动化回归测试
  > 
  > Signed-off-by: 東洋化學 &lt;yuukireina2023@gmail.com&gt;
  > 
  > 原作者 YuukiReina2023；合入前由维护者补了 4 处收尾修正：
  > - 删掉被打进插件却始终为空的 references/antigravity-interaction.md 与两处引用，测试改为禁止 0 字节文件
  > - 给 &lt;STUDYMATE\_SCRATCH&gt; 补上定义，并去掉只对 DSH 沙箱成立的 bwrap 说明（原来同一份文件里「不许用」与「所有临时文件写」互相矛盾）
  > - 输出目录保护与 OpenAI 版对齐：已被非构建文件占用的目录不再被静默清空
  > - test:antigravity 挂进 npm test，并新增 test\_antigravity\_skills.mjs 覆盖技能转换
  > 
  > 谨以此纪念原作者 @YuukiReina2023（東洋化學）——这份实现会一直署着他的名字。

- Merge pull request \#26 from Miaotofu01/feat/antigravity-support ([328cf8e](https://github.com/Miaotofu01/Study-Mate/commit/328cf8ef0a99fe8892c902c4ef900b7bbbec7ad8))

  > feat(插件): 支持 Google Antigravity 原生多智能体插件包

- feat(resources): support custom local materials and textbook paths (fixes \#21) ([6f2d80d](https://github.com/Miaotofu01/Study-Mate/commit/6f2d80d47e83e27a851fa6d095c820b54221d585))
- fix(渲染器): 围栏语言带白名单，写错标签带行号报错 ([92d8154](https://github.com/Miaotofu01/Study-Mate/commit/92d8154424991e8bd04363038ffda45840ccf8b5))
- fix(模板): 代码高亮补 python 配色器，别名 py/bash 一并认 ([cf2c4e1](https://github.com/Miaotofu01/Study-Mate/commit/cf2c4e1300b6c1c6eddca8d24b9435c6a12ed136))
- test(模板): 钉住渲染器围栏白名单与前端配色表相等 ([5efdd5d](https://github.com/Miaotofu01/Study-Mate/commit/5efdd5d52f3a9e4683871eac26fb59c80912e0f9))
- docs(格式): 代码围栏列出支持的语言标签与报错口径 ([d7acd55](https://github.com/Miaotofu01/Study-Mate/commit/d7acd55971da245bd800948fb6bf43f49fdf381f))
- chore(示例): 重跑 examples 同步共享层（python 高亮生效） ([a666071](https://github.com/Miaotofu01/Study-Mate/commit/a666071fcbea6a27fbbad025f739481836736f5b))
- test(校验): 相等断言进 CI，并盯住 examples 共享层副本 ([35883f8](https://github.com/Miaotofu01/Study-Mate/commit/35883f8be336aa57e0419a0ae1e4603f5d752ddf))
- fix(渲染器): 围栏白名单收下常见语言标签，detect 猜测走同一张表 ([7696008](https://github.com/Miaotofu01/Study-Mate/commit/7696008de29f0b048235820246d7b3f9b4907df2))
- fix(插件): 兼容 Windows CRLF 换行符下的 Antigravity 插件构建 ([9b7d09f](https://github.com/Miaotofu01/Study-Mate/commit/9b7d09f6cfe956f38553aa88a4d9a65335a27b81))

  > Windows 环境下检出源文件带有 CRLF（\\r\\n）换行符时，\`adaptAntigravitySkill\` 与 \`adaptAntigravityAgent\` 中的部分严格匹配 \\n 的正则（如会话结束正则）会触发 \`Antigravity skill adaptation error: Antigravity session end\` 阻断构建。
  > 
  > - 在 \`adaptAntigravitySkill\` 与 \`adaptAntigravityAgent\` 入口处统一将 CRLF 归一化为 LF
  > - 会话结束正则增加对可选 \\r 的兼容
  > - 增加 CRLF 换行输入下技能与子智能体转换无残留回车的单元测试

- feat(讲解): 落笔前先读本节点的来源原文 ([b750059](https://github.com/Miaotofu01/Study-Mate/commit/b750059da7b1210254723018ebec2166b22c7240))
- feat(调度): 放开角色派工，边界改由各角色规格约束 ([1123d0d](https://github.com/Miaotofu01/Study-Mate/commit/1123d0d81da2d7959089f5e99abd2c919da9806c))
- Merge pull request \#27 from yMvvL/feat/custom-local-materials ([554e9fc](https://github.com/Miaotofu01/Study-Mate/commit/554e9fccee075072d7cc1ad7713ab53310a48129))

  > feat(resources): 支持本地参考资料与教材路径导入 (fixes \#21)

- Merge branch 'fix/lesson-code-highlight' ([2e677f1](https://github.com/Miaotofu01/Study-Mate/commit/2e677f125c1609f5036f2b0ad530bd3c84c82cd7))

  > 课件代码块高亮：渲染器围栏语言白名单、前端补 python 配色器、防漂移断言进 CI

- Merge branch 'feat/role-dispatch' ([ce1c458](https://github.com/Miaotofu01/Study-Mate/commit/ce1c45840d3c166388d60996674c63daf670311e))

  > 放开角色派工：显式 maxDepth 2，边界改由各角色规格约束

- Merge pull request \#29 from Miaotofu01/feat/coach-source-reading ([2ec594e](https://github.com/Miaotofu01/Study-Mate/commit/2ec594e96d479beb1366b452987b161435e73e4b))

  > feat(讲解): 落笔前先读本节点的来源原文

- feat(资料): 本地教材与在线来源都在收集阶段转成 Markdown ([88c5f79](https://github.com/Miaotofu01/Study-Mate/commit/88c5f792a8f8d7681c0dab14d0ac3d2f2e5ca1cb))
- feat(讲解): Antigravity 导出给讲解配抓取工具 ([42b9a56](https://github.com/Miaotofu01/Study-Mate/commit/42b9a56bf0349a9c4dab3a044117e5b70098f469))
- feat(讲解): 本地落盘的来源原文直接读 ([0447a37](https://github.com/Miaotofu01/Study-Mate/commit/0447a37744d4d0f6701bc4b006a88dd568dfabfe))
- feat(讲解): 讲法与语气以来源为准，教科书语体降为兜底 ([26629f8](https://github.com/Miaotofu01/Study-Mate/commit/26629f8c8572415588eff6d29dc6db4fa256d7e9))
- fix(插件): Antigravity 的工具说明改由工具表生成，修掉讲解角色不知道能抓来源 ([238035e](https://github.com/Miaotofu01/Study-Mate/commit/238035e4920fdc0eb0283d4cd84747a021e76e63))

  > 权限表 AGENT\_TOOLS（写进 agent frontmatter）与正文那段「工具使用指南」是两份手抄：
  > 24 个「角色 × 工具」组合里差 6 个——五个角色都漏 invoke\_subagent，learning-coach
  > 还漏 read\_url\_content（42b9a56 只改了表，正文留到今天）。模型按正文办事，所以那笔
  > 「给讲解配抓取工具」在 Antigravity 侧等于没生效；两个测试又都 import 同一张表去断言
  > frontmatter，属于自证，抓不到这类漂移。
  > 
  > - 新增 ROLE\_TOOL\_NOTES（角色 × 工具 → 一句用途，原文逐字保留）与 toolGuide() 生成
  >   那段指南；assertToolNotes() 在模块加载期断言两边集合逐个相等、模板留着占位符
  > - 测试补「正文指南 == 工具表」（含 image-scout 那种两工具合写一条的形态），原有两条
  >   独立断言（每个角色必须能派工、learning-coach 必须能读来源）保留
  > - 顺带：五段角色描述删掉副本，改读技能元数据那一份；插件源清单不再写 version（构建器
  >   从 package.json 注入，产物侧的断言本来就在）；缺角色规格改为报错退出（原先会静默建出
  >   没有该 agent 的插件）；宿主约定里点名的角色名单加一条一致性测试
  > 
  > 验证：npm test 退出码 0、npm run test:static 退出码 0（536/536 条规则在位）；变异两条——
  > 指南漏一个工具 → 测试红、删掉一条用途 → 模块加载抛错；真挪走 learning-coach/SKILL.md
  > 再构建 → 如期报错且文件逐字节还原；新旧 agents 产物逐字节对照只多出新增的 6 行。

- refactor(课件): 大纲与课件路径收成两个模块，五个脚本改问它们 ([a5c95f0](https://github.com/Miaotofu01/Study-Mate/commit/a5c95f03e1e048e9a2427946effaaee673634c10))

  > 「课件编号 = 节点在 curriculum.yaml 的 nodes: 里排第几」这条规则原先由五个脚本各写
  > 一遍（渲染、校验、重排编号、回填无题理由、主页生成），彼此只在注释里声明「同口径」。
  > 坏输入的判决还各不相同：节点写坏时渲染与校验硬失败，重排与回填\*\*静默跳过\*\*——位次
  > 跟着压缩，回填会算出 0002 而渲染器认为它是 0003；主页生成则把重复 id 渲染两遍。
  > 
  > - 新增 scripts/curriculum.py：大纲的唯一口径（位次/标题/课型/前后邻居/依赖层级，
  >   以及什么算坏大纲）。strict（有问题就不可用，问题一次报全）与宽松（坏节点跳过、
  >   重复 id 只认第一次、逐条收集）由调用方选；怎么报（告警/失败/退出码）仍归各脚本
  > - 新增 scripts/lessonfile.py：课件文件名（\`&lt;4 位序号&gt;-&lt;节点id&gt;.&lt;md|quiz.json|html&gt;\`）、
  >   三种页面的共享层前缀、引用清单与外链判据；顺带清掉逐字相同的三份 SCHEME\_RE
  > - 五个脚本切过去，CLI 与输出格式不变；\`gen\_home\` 的「坏文件不掀翻整次生成」保留，
  >   只是坏大纲现在会明确告警一次（按 slug 去重），不再静默当没有
  > - 新增两个套件（39 + 34 条）覆盖此前没有任何用例的坏输入：节点写坏、id 重复、YAML 坏、
  >   nodes 空、前置成环；已接进 checks.mjs 默认门禁并在测试说明里登记
  > 
  > 验证：examples 重新生成（3 个主页 + 6 课）后与仓库产物\*\*逐字节一致\*\*——这条覆盖了任何
  > 套件都没测的主页位次与依赖层级路径；\`npm test\` 与 \`npm run test:static\` 退出码 0
  > （536/536 条规则在位）；变异验证「位次偏一位」→ 5 个套件变红，还原逐字节；坏节点实测：
  > 回填不再给出压缩位次、重排停下不动文件、渲染照旧硬失败、主页明确告警。

- refactor(状态): 状态与课型词表收敛到 schema，宿主指南不再手抄 ([5829120](https://github.com/Miaotofu01/Study-Mate/commit/582912095e4f4f735d24ab257bcb3dc3e3ee9625))

  > 六个节点状态原先在仓库里有七份副本（两份 schema、\`gen\_home\` 三组常量、
  > \`preview\_templates\` 两组、模板注释、宿主提示词、规格散文）。后果是改一次要动七处；
  > \`antigravity-interaction.mjs\` 那份手抄的只剩 4/6（少了「初步理解」与「已通过项目验证」），
  > 模型照它写就会产出 schema 不认的状态；而没有任何测试把两边钉在一起。
  > 
  > - 新增 scripts/statuses.py：词表从 schema 读（节点状态读 progress、退路 curriculum；
  >   科目状态读 subject；课型读 curriculum）。\*\*数组顺序成为载荷\*\*——「完成」= 在
  >   「能独立应用」处切一刀取后半段，主页卡片排序按科目状态的 enum 顺序；配色映射
  >   （状态 → 卡片 class）全仓库只剩这一份
  > - \`gen\_home\` 与 \`preview\_templates\` 改问它；读不到 schema 时降级渲染但\*\*明确告警一次\*\*
  >   （状态文本写原值、样式退成 todo、完成数按 0），不再静默
  > - Antigravity 宿主指南那串取值改为导出时从 schema 生成（4/6 → 6/6），课型同理
  > - 顺带补掉上一笔的漏网：\`gen\_home.py\` 里第三份 SCHEME\_RE 也归到 lessonfile
  > - 新增 test\_statuses.py（20 条）进默认门禁；test\_antigravity\_skills.mjs 补一条
  >   「宿主状态清单必须列全 schema 的状态」
  > 
  > 验证：examples 重生成后逐字节一致（配色/计数/排序全走这条词表）；npm test 与
  > test:static 退出码 0（536/536 条规则在位）；三条变异各自变红并逐字节还原——schema 加一个
  > 状态（配色缺失 + 两份 schema 不等）、配色表删一项、宿主清单只列前 4 个。

- refactor(资源): 共享层清单收成一份，依赖方向正过来，examples 一条命令重建 ([a57a3b4](https://github.com/Miaotofu01/Study-Mate/commit/a57a3b471c119a00029aa96bdfb9d1bbe88cfe87))

  > 共享层清单原先有三处（\`templates/assets/README.md\` 的表格、\`preview\_templates.py\` 的
  > \`shared\_files\`、\`gen\_home.py\` 的 \`ensure\_shared\_assets\`），\`docs/工程约束.md\` 自己写着
  > 「清单分散在三处，必须同时改」；逐字节守只盖住四个平铺文件——而 \`examples\` 的
  > \`katex/fonts/LICENSE\` 一直未跟踪，正是它让整树比对做不了。另外课件渲染器为了复用
  > \`esc\` / \`replace\_block\` / \`replace\_field\` 反向 \`import gen\_home\`（1300 行的主页生成器被当库用）。
  > 
  > - \`scripts/lessonfile.py\` 收下清单（SHARED\_DIRS / SHARED\_FILES / SUBJECT\_FILES / ASSET\_DOC）
  >   与拷贝助手 \`install\_shared\` / \`install\_subject\`；\`gen\_home\` 与 \`preview\_templates\` 都读它
  > - 新增 \`scripts/pagetpl.py\`（esc / replace\_block / replace\_field / PLACEHOLDER 逐字搬出），
  >   \`render\_lesson\` 与 \`gen\_home\` 都依赖它——渲染器不再 import 主页生成器
  > - 跟踪 \`examples/.learning/assets/katex/fonts/LICENSE\`；\`test\_templates.py\` 的字节守从
  >   4 个文件扩到\*\*整份清单\*\*（sayo/ 与 katex/ 整树 + 平铺四件 + 每个科目的课件层三件），
  >   并新增一条「templates/assets 顶层每个文件都登记过」
  > - 新增 \`scripts/build\_examples.py\` 与 \`npm run build:examples\`（\`studymate build-examples\`）：
  >   一条命令重建主页与每一课，替代 CONTRIBUTING 里那段「跑两次、每课再来一次」的散文
  > - 文档对齐：工程约束的脚本一览与那条「三处清单」约束、CONTRIBUTING 的重建段、
  >   \`templates/assets/README.md\` 只留「清单在 lessonfile」的指针
  > 
  > 验证：\`python3 scripts/build\_examples.py\` 与 \`npm run build:examples\` 退出码 0，且 examples
  > 逐字节一致；npm test 与 test:static 退出码 0（536/536 条规则在位）；三条变异各自变红并逐字节
  > 还原——删一份 examples 副本、往 templates/assets 塞未登记文件、清单里漏一个文件。

- test(门禁): 套件覆盖断言——新增套件不能再静默地永远不跑 ([f2274f1](https://github.com/Miaotofu01/Study-Mate/commit/f2274f1bb613f893c741cdbb86ee9c89796c8420))

  > \`checks.mjs\` 显式列出各层套件（core / --static / --browser），package.json 另有按需入口
  > （test:dsh / test:dsh-cli 等 616 行套件），测试说明再抄一份——清单散在多处，而且\*\*新增一个
  > 套件文件时什么都不会发生\*\*：它静静地谁也不跑。
  > 
  > - checks.mjs 加覆盖断言：\`scripts/tests/\` 下每个 .py/.mjs/.js 必须属于某个组、出现在
  >   package.json 的按需入口里，或在 MANUAL\_ONLY 里明确登记（浏览器手动脚本、排障脚本）；
  >   漏登记就列出文件名并以退出码 2 停下。三种模式都先跑这条断言
  > - 支持文件（README.md / run\_tests.sh / fixtures.py / fixtures/）单独放行
  > - 测试说明补上这条规矩，并写明 checks.mjs 是「默认跑哪些」的唯一出处
  > 
  > 验证：塞一个未登记的 test\_probe\_unlisted.py → 门禁退出码 2 并点名该文件；删除后恢复 0；
  > npm test 与 test:static 退出码 0（当前 core 16 个 Python + 2 个 Node + 1 个 --test）。

- test(CI): 静态契约层并入 npm test，门禁与文档同步 ([bdc6d60](https://github.com/Miaotofu01/Study-Mate/commit/bdc6d60e78451299501d0fd7e8d1ea72c313c17f))

  > \`--static\`（Python 语法、提示词 536 条规则、模板契约、两个宿主的技能转换）此前只在本地
  > 按需跑；它挡的正是最容易被改坏的那批东西（提示词措辞、模板与规格的静默漂移），而 CI
  > 只看 \`npm test\`，等于这一层没人守。
  > 
  > - \`npm test\` 末尾接上 \`npm run test:static\`（CI 复用同一条命令，不必改 workflow）
  > - 文档同步：测试说明（「本地按需」只剩真实宿主与真实 Chrome 两层）、CONTRIBUTING 的
  >   本地验法、工程约束的脚本一览、发布流程那句「手动运行」、Antigravity 文档里过时的
  >   「514 条」条数；CI 步骤名补上 static contract
  > - 更正一处旧说法：\`ci.yml\` 的 \`on.push: \[main\]\` 一直都在——\*\*直接推 main 也会跑 CI\*\*，
  >   之前说「只在 PR 上跑」是错的
  > 
  > 验证：\`npm test\` 退出码 0，日志里两层覆盖断言都在（core + --static）、536/536 条规则在位、
  > 零 FAIL；\`npm run test:static\` 单独跑仍然可用。

- refactor(语法): 围栏判定收成一份（内容文件语法的第一块） ([8bdc7d5](https://github.com/Miaotofu01/Study-Mate/commit/8bdc7d5c63f276f159fbbbf8b7590fb4ce5ecffa))

  > 围栏判定原先在\*\*四个\*\*脚本里各写一遍：渲染器（取语言 + 白名单 + 两处翻转）、回填器
  > （find\_close / quiz\_blocks，注释里写着「与 render\_lesson.py 同口径」）、主页生成器的
  > 附件编译器（开块 + 找闭合行）、校验器（题面/答案里的围栏配对，守着它自己的
  > QUIZ\_FENCE\_RE）。判定分叉的代价不是报错而是\*\*静默\*\*：\`:::\` 被当指令插进代码块、
  > 或代码块整段不上色——\`python\` 那次 36 个代码块的事故就是白名单两边不一致。
  > 
  > - 新增 scripts/lessonfmt.py：marker()（围栏信息串）、is\_fence\_line()（翻转判定）、
  >   is\_known\_lang()、is\_simple\_fence\_line()（起止各占一整行的形状，校验器口径），以及语言
  >   标签白名单 COLORED\_LANGS / PLAIN\_LANGS（从渲染器搬来）
  > - 四个消费者全部改问它；test\_templates.py 那条「白名单 == 前端配色表」的抓取目标从渲染器
  >   改到语法模块（守仍然有牙：改名会红）
  > - 新增 scripts/tests/test\_lessonfmt.py（64 条，进默认门禁）：marker 取法与翻转语义、白名单、
  >   \`:::\` 与围栏的关系，以及\*\*跨消费者一致性\*\*——渲染器对白名单里每个标签都不该报错、未登记
  >   的必须带行号报错、带语言围栏里的 \`:::\` 不被当指令、回填器的收尾下标要跳过围栏里的 \`:::\`
  > - 校验器那处与旧正则\*\*逐个等价\*\*（含「\`\`\` python」这种带空格的怪例，已逐例比对过），
  >   只是换成同一份判定
  > 
  > 验证：npm test（含静态层）退出码 0、examples 重建后逐字节一致、536/536 条规则在位；
  > 四条变异各自变红并逐字节还原——把带语言的围栏判成不是围栏、白名单常量改名、回填器漂回
  > 私有规则、简单围栏行放宽到允许空格。

- Merge pull request \#30 from Miaotofu01/refactor/architecture-review ([dd3a566](https://github.com/Miaotofu01/Study-Mate/commit/dd3a566782b0aee641eca50afa0e0cba96ed5fa9))

  > Refactor/architecture review

- Merge pull request \#28 from wuxiaodu/fix/antigravity-crlf ([8f9eb3b](https://github.com/Miaotofu01/Study-Mate/commit/8f9eb3b426ba7c5ab302e7c7659fbd3cc172fdc2))

  > fix(插件): 兼容 Windows CRLF 换行符下的 Antigravity 插件构建

- fix(发布): 打包白名单补上 antigravity，Release 不再自己拦自己 ([47127f1](https://github.com/Miaotofu01/Study-Mate/commit/47127f1db61da52e2e5e06d5c9142cfda468c79f))

  > \`package.json\` 的 files 里加了 \`antigravity/studymate/\*\*\`（Antigravity 支持那次），但
  > \`scripts/release/release.mjs\` 的 \`validatePack\` 白名单没跟上——于是每次发布都在
  > 「Prepare changelog, version commit and tag」这步失败：
  > 
  >     Unexpected or private file in npm tarball: antigravity/studymate/plugin.json
  > 
  > 上一次成功的 Release 是 9-24（run \#7），Antigravity 是 9-27 进的，所以这中间每次发布都会中
  > （今天的 run \#8 就是）。发布套件用的样例包是写死的、不含真实路径，因此没拦住。
  > 
  > - 白名单加 \`antigravity/studymate/.+\`；必需清单加 \`antigravity/studymate/plugin.json\`
  >   （打包时悄悄丢掉插件清单同样要被拦下）
  > - 新增结构性断言：\`package.json\` 的 files 里\*\*每个模式\*\*取样后都必须能通过白名单——
  >   两张表从此钉在一起（这次就是它们各改一半）
  > 
  > 验证：真实 \`npm pack\`（153 个文件）+ validatePack 修前失败、修后通过；变异（白名单去掉
  > antigravity）→ 新断言变红且真实包复现失败；本地预演发布第 8 步 buildReleasePlugin 正常
  > （ZIP 1,007,341 B，头 0x04034b50）；npm test 退出码 0（536/536 条规则在位）。

- Merge pull request \#31 from Miaotofu01/fix/release-antigravity-allowlist ([d89425c](https://github.com/Miaotofu01/Study-Mate/commit/d89425cb366610acf4168ed8d7e7846b66c92c77))

  > fix(发布): 打包白名单补上 antigravity，Release 不再自己拦自己


[完整比较](https://github.com/Miaotofu01/Study-Mate/compare/v0.2.0...v0.3.0)
<!-- /studymate-release:v0.3.0 -->

<!-- studymate-release:v0.2.0 -->
## [0.2.0](https://github.com/Miaotofu01/Study-Mate/releases/tag/v0.2.0) - 2026-09-24

### 所有提交

- feat(gpt插件)：新增的codex/gpt插件支持 ([7e2552e](https://github.com/Miaotofu01/Study-Mate/commit/7e2552e8823d4c6423ba3c799cf26607fe3932b0))
- feat(gpt插件)：新增的codex/gpt插件支持 ([838604f](https://github.com/Miaotofu01/Study-Mate/commit/838604f0916e85006efb645bb7ba1276f397d0a2))

  > 修复 Windows Node 22.19 中文路径下测试示例复制，保留插件导出和课件渲染回归。


[完整比较](https://github.com/Miaotofu01/Study-Mate/compare/v0.1.5...v0.2.0)
<!-- /studymate-release:v0.2.0 -->

<!-- studymate-release:v0.1.5 -->
## [0.1.5](https://github.com/Miaotofu01/Study-Mate/releases/tag/v0.1.5) - 2026-09-24

### 已合并的 Pull Request

- fix(attachments): render GLOSSARY and RESOURCES markdown to static HTML ([#12](https://github.com/Miaotofu01/Study-Mate/pull/12))
- fix(lesson-design): restore practice stage naming rule ([#15](https://github.com/Miaotofu01/Study-Mate/pull/15))

### 所有提交

- fix(安装): install.ps1 加 UTF-8 BOM，PowerShell 5.1 不再按 GBK 解码 ([26c2c08](https://github.com/Miaotofu01/Study-Mate/commit/26c2c083ebd594dceffd801c0c0bf6dd18f8f7ce))
- fix(attachments): render GLOSSARY and RESOURCES markdown to static HTML ([c9f919c](https://github.com/Miaotofu01/Study-Mate/commit/c9f919c515a74e9331fae7eb225378a47b5d10f6))
- Merge pull request \#12 from yMvvL/fix/attachment-markdown-rendering ([2cdba17](https://github.com/Miaotofu01/Study-Mate/commit/2cdba178914ee12515c110cb58eb87fa077c004d))

  > fix(attachments): render GLOSSARY and RESOURCES markdown to static HTML

- refactor(大纲)!: 删掉节点「过关标准」字段，判分锚下移到 objective 与题目判分要点 ([78393eb](https://github.com/Miaotofu01/Study-Mate/commit/78393eb6e7d1d2aadd683afe2e9cbfa7f3c72fbc))
- refactor(提示词): SKILL 正文改用「代称」指代文件（见 docs/文件归属.md） ([326e6f4](https://github.com/Miaotofu01/Study-Mate/commit/326e6f49a1cba76c2aef4c8228aa03c1a4b8ecb0))
- fix(lesson-design): restore practice stage naming rule ([ff50185](https://github.com/Miaotofu01/Study-Mate/commit/ff50185be2528b54fbaed8e12161682ae84efbc4))
- Merge pull request \#15 from GodBlessRen/fix/lesson-design-stage-name-rule ([ffc2b02](https://github.com/Miaotofu01/Study-Mate/commit/ffc2b022e16af10b89c7e94ad4666f98b6e2fb4d))

  > fix(lesson-design): restore practice stage naming rule

- refactor(提示词): 精简搜图的提示词 ([cf9a72a](https://github.com/Miaotofu01/Study-Mate/commit/cf9a72a74deaebd9c00367104f5f861da5423be1))
- refactor(提示词): 精简搜图的提示词 ([6575500](https://github.com/Miaotofu01/Study-Mate/commit/6575500dc4ecd5d9df89ed2ddbd832d8ce77f7b8))
- refactor(提示词): 精简 11 份规格并统一措辞 ([62865ee](https://github.com/Miaotofu01/Study-Mate/commit/62865eef1f23ac19d8f466aa3c8ab15644ed622f))

  > - 删掉 frontmatter 已经强制的机械约束重复（学生不会直接调用你、只能由总控加载、三条边界副本）
  > - 派工给的值收进 docs/文件归属.md 的角色表，删掉 learning-system 的值映射表
  > - 目录树、owner 声明、输入节标题三处去重；五份角色统一「\#\# 输入（总控在 prompt 里给）」
  > - 措辞统一：落盘→写盘、课件三件→课件三份产物、对位→对照、口径→标准

- test(提示词): 补回「中文阶段名」钉串（规则随 PR \#15 恢复） ([08163e7](https://github.com/Miaotofu01/Study-Mate/commit/08163e78ad0b1f6ce0e5b835e921b4dbd92d8e41))
- docs(设计): 修样例节点字段（补必填 kind、resources 改成对象数组、删已移除的 evidence） ([0e343ce](https://github.com/Miaotofu01/Study-Mate/commit/0e343ce2da64bcb59f58e94cb4f8aebc6916b3c1))

  > - kind 是 schema 必填项，样例里缺了
  > - resources 的元素是 {title,type} 对象，原来写成字符串数组
  > - evidence 字段已随「过关标准」一并移除，且 schema 是 additionalProperties: false，
  >   这份样例原本过不了 check\_curriculum.py（现在只剩样例本身的悬空前置引用）

- docs(设计): 目录树与角色计数对齐现状，工作区树改用真名 ([d58ec68](https://github.com/Miaotofu01/Study-Mate/commit/d58ec685082ba051f1a0b32c26c6af1160b81b1d))

  > - 技能份数 9 → 11，「三个角色」→ 五个角色（资料收集 / 采图 / 课程设计 / 讲解 / 练习评估），共 5 处
  > - 区域二把预设目录写了两遍，其中一遍漏了点；合并成 ~/.dsh/.agent-presets/learning/
  > - 区域三的汉化文件名（科目信息.md / 大纲.yaml …）换成真实文件名，并修掉指向
  >   工程约束的失效指针（那份清单现在在《文件归属》）
  > - docs/ 的注释补齐（课件内容格式、文件归属）；版本行 v1.3 → v1.4

- docs: 脚本清单收敛到《工程约束》§四 一处 ([7accbfe](https://github.com/Miaotofu01/Study-Mate/commit/7accbfe45f2b9da9f1c49131b50be213758e947e))

  > - 工程约束把「脚本一览」从占位符契约里拆出来，独立成 §四（前端选型、实测坑顺延为五、六）
  > - 使用说明 §五 删掉与它重复的 6 条命令，只留「什么时候跑 + 阻断项 + 退出码」+ 指针
  > - 使用说明 §三 的脚本指针改成直接指 §四，少一跳

- docs(导航): 把《文件归属》接进 README 与使用说明 ([3765841](https://github.com/Miaotofu01/Study-Mate/commit/376584108c050287d6aa777b991e7195da094eaa))

  > 它此前只被《工程约束》引用一次，属于半孤儿文档：
  > - README 的文档清单、使用说明的「相关文档」都加上它（含一句话定位）
  > - 使用说明 §六 的目录树旁声明「权威清单在文件归属」，避免两份树各说一套
  > - 顺带把 README 里工程约束的说明补上「脚本一览」

- docs(使用说明): 措辞对齐（落盘→写盘、落成→写成、修旧标题指针） ([9a8707f](https://github.com/Miaotofu01/Study-Mate/commit/9a8707f15e926b401fe93f2eeb29256944d65690))

  > - 落盘 → 写盘 5 处，落成 → 写成 4 处（与 SKILL 那批统一）
  > - 「课件三件」→「课件三份产物」，两处指针改指 record-keeping 现在的标题
  >   「课件三份产物的归属（lessons/）」（旧标题已不存在）
  > - 口径 → 标准 2 处

- docs: 措辞对齐（设计方案、课件内容格式） ([61f6414](https://github.com/Miaotofu01/Study-Mate/commit/61f64143b0c874af1aa0d3e9eaee145e71a4d681))

  > - 设计方案：落盘 → 写盘 4 处
  > - 课件内容格式：落成 → 写成 3 处、核心口径 → 核心约定
  > - 至此 docs/ 全目录 落盘 / 落成 / 课件三件 / 口径 清零

- docs(测试): 修自述失真的条数与套件数，补上漏掉的附件渲染套件 ([64f6919](https://github.com/Miaotofu01/Study-Mate/commit/64f6919b326037765fad9293dee760d3d11f7b5c))

  > 实测（run\_tests.sh 全绿）对照后修正：
  > - run\_tests.sh：快测 11 → 12 套、含浏览器 13 → 14 套；安装脚本 30 → 39 项、
  >   提示词规则 417 → 410 条、附件 Markdown 渲染 29 → 32 项
  > - tests/README：安装脚本 30 → 39 项、位次重排 21 → 22 例、规则条数 417 → 410 条；
  >   表格里补上 test\_attachment\_render.py（此前整份套件没进表）
  > - 「evidence 字段映射仍留在使用说明」这句不成立：字段本身已删，判分锚是节点
  >   objective + 每题 criteria，改指使用说明 §四

- refactor(提示词): 总控盘问优先推荐jupyter ([9b0f551](https://github.com/Miaotofu01/Study-Mate/commit/9b0f551fc0402842b58a9f204b1afb92d288ad6f))
- feat(示例): 线性代数示例科目（大纲、三节课、lab、档案） ([40edb98](https://github.com/Miaotofu01/Study-Mate/commit/40edb981715cd575e3e437be0100d4cacb4f1183))

  > - 5 个节点：向量与线性组合 / 矩阵与线性变换 / 高斯消元与解的结构（实操）/ 基、维数与坐标 / 特征值与特征向量（实验）
  > - 前三课各一份内容文件 + 题库（每课 3 个锚点，共 11 道题）+ 渲染产物；正文 186/217/237 行
  > - lab 0003：只用标准库实现 rref / pivot\_columns / rank / solve，留白态 20 条红、参考解 22 条全绿
  > - 三张自产示意图（脚本 assets/img/gen/linear-algebra-diagrams.py 可复现）+ 完整图片库索引
  > - 档案：评估记录（节点 1 通过，含缺口与追问）、学习记录（节点 2 带学生原话）、会话摘要、两处误解双落点
  > - 科目组件三件（style.css / quiz.js / lesson-toc.js）与 templates/assets/ 逐字节一致

- feat(示例): 计算机网络示例科目（大纲、三节课、lab、档案） ([23aab5f](https://github.com/Miaotofu01/Study-Mate/commit/23aab5f22cc92fb1d98872759ad2169872399337))

  > - 5 个节点：分层模型与封装 / 链路层与以太网帧 / IP 地址、子网与路由（实操）/ TCP 与可靠传输 / 实验：TCP 回显客户端与抓包
  > - 前三课各一份内容文件 + 题库（每课 3 个锚点，共 12 道题）+ 渲染产物；贯穿线索是「一次网页请求」
  > - lab 0003：只用标准库（ipaddress）实现 parse\_cidr / same\_subnet / split\_subnet，留白态 30 条红、参考解 17 条全绿
  > - 档案：评估记录（含学生先漏了帧尾 4 字节、追问后补上）、学习记录、会话摘要、三处误解双落点
  > - 科目组件三件与 templates/assets/ 逐字节一致；图片库为空索引（三节课全用内联 SVG）

- chore(示例): 生成示例工作区的页面与共享层（clone 即可点开） ([3d2a31f](https://github.com/Miaotofu01/Study-Mate/commit/3d2a31f72d5255096c065600c08af077ecdd02f4))

  > - 6 个课件页 + 2 个科目主页 + 根主页 + 术语表/资源清单/学习记录/会话摘要的附件页
  > - examples/.learning/assets/：整份共享层（sayo + 主题层 + 图标），离线打开不依赖网络
  > - gen\_home.py 链接自检通过；正文里只剩两处「下节课还没产出」的悬空指针（节点 4 规格是暂无课件）

- feat(检查): check\_lesson 增加「本地引用可达」（检查项 10） ([629ad38](https://github.com/Miaotofu01/Study-Mate/commit/629ad381724fae5d6cf6c53db00599858f818c52))

  > 页面可以同时「通过全部检查」和「点开是白板 / 404」：检查项 2/3 只核对引用写没写齐、
  > 第 9 项只管 &lt;img&gt;，而 gen\_home 的断链自检不管课件页。示例工作区里真踩到两次——
  > 科目 assets/ 缺 quiz.js 与 style.css（页面没样式、题点不动、侧栏出不来），
  > 以及正文里那条 lab 链接指向不存在的 README。
  > 
  > - check\_lesson.py：新增检查项 10，页面里所有 href/src 的本地目标必须真实存在；
  >   跳过外链/锚点/协议相对 //、HTML 注释里的示例路径、上下节课指针（落空是设计内的），
  >   ?查询串 与 \#片段 先剥掉、%xx 先解码（与第 9 项同口径）
  > - fixtures.py：临时科目改成真实布局（&lt;root&gt;/.learning/subjects/&lt;slug&gt;/），
  >   并铺共享层、科目组件与科目主页的占位文件——路径写歪了这套测试自己就红
  > - test\_lesson\_links.py：10 例（拦 4：正文死链、quiz.js / lesson-toc.js / 共享层缺失；
  >   放行 6：齐全、存在、外链锚点、注释内、带查询串、下节课未产出）
  > - learning-system：检查 FAIL 的归属补一条——缺科目组件或共享层文件是总控自己补齐，不打回角色
  > - README / 使用说明：阻断项清单补上这一条

- test(模板): 新增「模板与规格一致」套件，钉住规格与模板的静默漂移 ([29aeabb](https://github.com/Miaotofu01/Study-Mate/commit/29aeabb295a9af4ea6630006283c437611a54a91))

  > 规格是散文（写在 SKILL 与 docs/ 里），模板是另一份文件，两者之间没有测试连着。真出过事：
  > templates/GLOSSARY.md 一直写 \`\#\# Terms\`，而 docs/文件归属.md、learning-system、image-scout
  > 三处都按 \`\#\# 待掌握\` / \`\#\# 已掌握\` 读词——照模板建出来的术语表，采图查不到主题词、
  > 主页也没有那两节可读。这类漂移不会报任何错，只能靠交叉阅读发现。
  > 
  > - test\_templates.py：两边一起钉——规格侧仍要求这些分节名，模板侧必须真有；
  >   subject.yaml 的键与 subject.schema.json 完全一致，status 取值在 enum 里（8 项）
  > - run\_tests.sh / tests/README：登记为第 14 套快测（含浏览器 16 套）
  > 
  > 顺带：templates/GLOSSARY.md 本身已在示例重建那批里改成两节式，这条测试防它漂回去。

- feat(渲染器): 图注编号交给渲染器（作者只写描述，页内顺序自动编号） ([c05a104](https://github.com/Miaotofu01/Study-Mate/commit/c05a10458d0ea82cf8375c4941afa6518751dffe))

  > 编号是可推导的信息（这一页第几张图），要求作者手写必然漂移——示例里就出过同页两张图都写
  > 「图 1」，两门课的编号口径还不一致（一门整门连续、一门每课重开）。现在渲染器按页内出现顺序
  > 给号，::: figure 与 ::: svg 共用一条序列，输出形如「图 1 · 收拢过程」。
  > 
  > - render\_lesson.py：新增页内计数器与 numbered\_caption()；已写「图 N ·」的旧课件会剥掉旧号重编
  >   （所以重渲染幂等，老写法不改也不会重号）；没写 caption 的图不编号、也不占号（不出现跳号）
  > - docs/课件内容格式.md：figure/svg 的例子改成只写描述，补上编号规则与「正文里见图 N 要对一遍」的提醒
  > - learning-coach：caption 口径改成「只写一句话，编号由渲染器加，别自己写图 N」（钉串同步更新）
  > - test\_render\_lesson.py：新增 ⑬′ 一组（页内顺序 / 两类图共用序列 / 旧号剥掉重编 / 重渲染幂等 /
  >   空白 caption 不生成图注 / 只数有说明的图）
  > - 示例 6 份课件的 11 处手写编号去掉后重渲染：产物\*\*逐字节相同\*\*，6 页全过检查

- feat(公式): 课件支持数学排版（$…$ 行内 / $$…$$ 块级，离线 KaTeX） ([845d8d9](https://github.com/Miaotofu01/Study-Mate/commit/845d8d96e4cc8046cc74f2a0086e1984ce918005))

  > 线代示例暴露的真问题：系统里从来没有数学排版这条路（格式文档原来写「要排数学式写 ::: svg，
  > 或用纯文本」），于是矩阵写成 \`\`\`text 围栏、公式写成纯文本 + Unicode 下标——语法合规，看着就是没排版。
  > 
  > - render\_lesson.py：行内 \`$…$\`、块级 \`$$…$$\`（整段只有它时出 &lt;div class="math-block"&gt;，
  >   段落中间出 &lt;span class="math-block"&gt;）；判据是「开 $ 后、收 $ 前都不能是空白，中间不跨行」，
  >   散文里的价格写法不误判；没收尾按行号报错（页面只会显示 TeX 原文，看不出错，所以必须拦下）；
  >   \`\\$\` 是字面美元号；代码围栏与行内代码里的 \`$\` 不受影响
  > - 按需注入：只有页面里真有公式时才在壳里加 KaTeX 三件（katex.min.css / katex.min.js /
  >   lesson-math.js）——非数学课与老课件产物零 diff（模板新增 &lt;!-- @LEARN:MATH --&gt; 占位符）
  > - templates/assets/katex/：KaTeX 0.18.7（MIT）整体 vendor，只留 woff2 字体（20 个，CSS 里去掉
  >   woff/ttf 回退），共 600 KB；templates/assets/lesson-math.js 负责排版，KaTeX 没加载成功时
  >   元素里留着的 TeX 原文照样可读（降级不白屏）
  > - check\_lesson.py：新增检查项 11（条件判定）——页面里有 .math-inline / .math-block 就必须带这三个引用
  > - 共享层清单同步：gen\_home.ensure\_shared\_assets、preview\_templates、templates/assets/README.md
  > - 测试：渲染器 ⑬″ 一组（行内/块级/代码里不解析/\\$ 转义/没收尾报错/无公式不注入）、引用套件两条
  >   条件断言、新增真 Chrome 套件 browser/math\_test.mjs（断言 .katex 真出现、块级走 display、
  >   KaTeX 字体生效、写错的公式不炸整页）；套件 16 → 17
  > - 文档：课件内容格式第 3 节新增「数学式」、已知边界那条改写；learning-coach 加公式口径；
  >   使用说明与工程约束各补一句

- refactor(提示词): 优化课设规范 ([11669ef](https://github.com/Miaotofu01/Study-Mate/commit/11669ef177ce26f68f9a72a289757465be012060))
- docs(示例): 线性代数的公式改成 LaTeX 排版（矩阵、消元链、下标） ([31291ba](https://github.com/Miaotofu01/Study-Mate/commit/31291ba083a8b022c799b33b9f035e1ecae60590))

  > 引擎刚支持 $…$ / $$…$$，这三节课原来把数学写成「\`\`\`text 围栏 + 行内代码 + Unicode 下标」——
  > 语法合规但读起来是代码。现在：
  > 
  > - 0001 向量与线性组合：19 条行内 + 3 个块级（方程组与向量等式双列 aligned、矩阵 bmatrix、
  >   线性无关的通式）
  > - 0002 矩阵与线性变换：38 条行内 + 6 个块级（线性变换两条定义、T(x,y)=x·T(1,0)+y·T(0,1)、
  >   列落点示意图、斜切矩阵、秩-零化度定理、练习里的 C/D 矩阵）；表格里的 ASCII 矩阵也进单元格公式
  > - 0003 高斯消元：27 条行内 + 7 个块级。增广矩阵用 \\left\[\\begin{array}{ccc|c}…\\right\]（bmatrix
  >   画不出增广竖线），三段消元链改成 aligned + \\xrightarrow{\\text{第 2 行} - \\text{第 1 行}} 竖直链
  >   （横排会撑破版面）
  > - 判断标准：\*\*圆括号 (1, 2) 是数学向量 → 转公式；方括号 \[\[2, 1\], \[1, -1\]\] 是 Python 字面量、
  >   函数名与路径 → 留代码\*\*；print 输出、报错原文、练习答案清单保持代码块
  > - examples/.learning/assets/：入库共享层的 KaTeX（katex/ 与 lesson-math.js），示例页因此
  >   clone 下来就能离线看排版
  > 
  > 验收：三页 check\_lesson 全 OK（只剩既有的「下节课未产出」WARN）；三份产物在真实 headless Chrome
  > 里 0 个未渲染、0 个 katex-error、块级全 display、字体 KaTeX\_\*；全量 17 套测试通过。

- fix(检查): 「科目主页还没生成」不再拦课件（生成产物不是作者的错） ([d396086](https://github.com/Miaotofu01/Study-Mate/commit/d3960869bf82a06d363a3636b2186f0af88af03e))

  > 重跑示例时子 agent 撞到的真问题：课件壳里那条固定回链 \`../index.html\` 指向的是
  > \`&lt;科目&gt;/index.html\`，它是 \`gen\_home.py\` 的产物——检查项 10 把它判成课件的引用缺陷，
  > 于是每门新科目在跑生成器之前，三节课全都带一条拦不下来的 FAIL。
  > 
  > 作者的活产不出这个文件，缺了是流水线顺序问题。改成：目标不存在且文件名是 \`index.html\` 时
  > 出一条提示（「科目主页还没生成：跑一次 gen\_home.py 就有了」），不阻断；其余本地引用照旧拦。
  > 
  > - check\_lesson.py：check\_local\_refs 返回 (problems, notes)，index.html 走 notes；
  >   文档串第 10 项写明这条例外
  > - test\_lesson\_links.py：加第 13 条（删掉科目的 index.html → 放行 + 提示）；
  >   套件计数同步到 13

- docs(示例): 线性代数科目按新规格重跑（公式全 LaTeX、图全 SVG） ([9de7728](https://github.com/Miaotofu01/Study-Mate/commit/9de772826fba82007d3fc863c8ef79451c6b9ee9))

  > 推倒重来的一版：让子 agent 只按现在的规格（docs/课件内容格式.md + lesson-design +
  > layered-practice）重写，不用上一版的手工修补。这一版顺带是对「数学排版 + 图注自动编号 +
  > 术语表两节 + 检查项 10/11」这轮规格改动的验收。
  > 
  > - 公式 157 条全走 LaTeX（行内 50/71/30、块级 6/7/11）：矩阵 bmatrix、增广矩阵
  >   \\left\[\\begin{array}{ccc|c}…\\right\]、消元链 aligned + \\xrightarrow
  > - 图全用 ::: svg（张成、列视角落点、斜切前后网格、秩 1 压扁、三种解的情形）；
  >   上一版自产的 3 张 PNG 与生成脚本删掉——本机没有 matplotlib，SVG 也更符合规范
  > - 档案自洽：同一个失误在四处指得出来（抄错右端项 = 课件 warn 卡 = 题库排错题锚点 = session
  >   weakness；秩-零化度记成行数 = 学习记录 = progress 误解 = 排错题）；节点 3 的 0.3 与
  >   「rref 跑通、solve 未实现」在 progress / session / lab 三处对得上
  > - lab：留白态 21 条红 exit 1、参考解 23 条全绿 exit 0（没有跳过开关）
  > - 正文非空行 196/184/196；组件三件与 templates/assets/ 逐字节一致；pool.md 空索引 + Gaps

- docs(示例): 计算机网络科目按新规格重跑 ([86bc388](https://github.com/Miaotofu01/Study-Mate/commit/86bc3886a3f548931da6591fe8e9de10a3205de9))

  > 同一轮重跑的另外半门：网络零基础的学生画像、五个节点（分层/链路/IP/实验）、前 3 课成课。
  > 
  > - 公式 76 条走 LaTeX（行内 35/15/21、块级 2/1/2）；IP 地址、掩码、命令与抓包输出留代码
  >   （读者要逐字对），只有算式（如块大小 $2^6 = 64$）用公式
  > - 6 张内联 SVG（分层图、帧结构、子网划分、逐跳转发的路径图），每课 2 张；最小字号 ≥2% viewBox 宽
  > - 每课 1 个 ::: practice + 3 个 quiz 锚点、题库 5 题/课，键与锚点逐字一致
  > - lab：留白态 85 条 error exit 1、参考解 22 条全绿 exit 0；用法只用标准库（unittest + ipaddress）
  > - 档案自洽：/26 块大小算成 26、跨网段 MAC 这些真实错法同时出现在误解库、progress 与会话摘要里
  > - 正文非空行 174/165/191；组件三件与 templates/assets/ 逐字节一致；pool.md 空索引 + Gaps

- feat(公式): 题库里的公式也排版（题面/选项/答案/解析走同一套 KaTeX） ([0ac4bb7](https://github.com/Miaotofu01/Study-Mate/commit/0ac4bb7220b5ab3f8870f86744742464503f044f))

  > 上一轮只做了课件正文的数学；题库是纯文本字段、由 quiz.js 在运行时插入 DOM，\`$…$\` 原样显示
  > ——线代作业因此一道矩阵题都写不了（示例里只能平铺成「x + 2y = 1、2x + 4y = 2」）。
  > 
  > - quiz.js：新增 mathInto()，把字段按 \`$…$\` 切成文本节点 + &lt;span class="math-inline"&gt;（仍是纯
  >   文本路径，不走 innerHTML）；选项、点选后才出现的解析同样处理；建块完成与动态插入后各调一次
  >   LessonMath.render()
  > - lesson-math.js：暴露 window.LessonMath.render(root)，给排过的节点打标记——重复调用不会把
  >   上一次的产物当成 TeX 再排一遍
  > - render\_lesson.py：quiz\_has\_math() 扫题库的字符串字段；公式\*\*只出现在题面里\*\*时壳里也要注入
  >   KaTeX，否则题面排不出来
  > - check\_lesson.py：第 11 项的「页面有数学式」放宽到 data-quiz 属性里的 \`$…$\`（顺带修了自己一个
  >   正则 bug：属性引号必须配对捕获，否则 JSON 里的双引号会把内容截断）
  > - 测试：DOM 套件加场景九（40 项）· 浏览器套件加题面公式四态并把 fixture 改成\*\*生产脚本顺序\*\*
  >   （验的正是 quiz.js 自己排版那条路，10 项）· 渲染器加「公式只在题库里也注入」（29 例）·
  >   引用套件加「题库公式也算数学式」（14 例）
  > - 文档：课件内容格式（数学式节说明题面也支持 + quiz 节）、assets README 的 quiz.js 行、
  >   layered-practice 的题面写法 + 钉串（412 条）

- feat(数学): 方程组必须带大括号——写进规格，并加一条形态提示 ([62a8e80](https://github.com/Miaotofu01/Study-Mate/commit/62a8e80f8ebc2ae150c7ca93eecbbae7c3283d8d))

  > 示例线代课件里的方程组排成了三行等式、\*\*没有大括号\*\*：KaTeX 不会自己加，读者第一眼会把它们
  > 当成三个独立结论。根因不是"模型不会"——它在 chat 里默认会带 \`cases\`；是这里的三个信号把它
  > 压下去了：① 规格从没提过大括号（0 处）；② 派工 brief 示范的形状（bmatrix / array|c / aligned）
  > 全都不带括号，示例的权重比规则大；③ 验收看不见（当时的检查器管结构、引用、题目，不管这个）。
  > 产出正好是"我示范过的那套词汇"：5 处 aligned + 4 处 array、大括号 0 处。
  > 
  > - docs/课件内容格式.md：数学式一节新增「方程组要带大括号」——\`\\left\\{\\begin{aligned}…\\end{aligned}\\right.\`
  >   （等号对齐，中文教材排法）；分段函数/分类讨论用 \`\\begin{cases}…\\end{cases}\`；并说明为什么不能省
  > - learning-coach / layered-practice：公式口径各补一句（正文与题面都适用）
  > - check\_lesson.py：新增\*\*形态提示\*\*（只 WARN，不阻断）——\`aligned\` 里 ≥2 行带 \`&amp;=\` 却没被
  >   \`\\left\\{ … \\right.\` 包住就提示。判据保守：推导链（\`\\xrightarrow\`）与单条恒等式都不命中；
  >   这是"形态类"判据，不依赖逐条枚举约定
  > - 测试：引用套件加两条（缺括号 → 提示；带括号 → 不提示）→ 16 例；钉串 +3 → 414 条
  > 
  > 顺带说明：这条只覆盖"多行等式缺包裹"这一种形态。其余形态类问题（ASCII 伪矩阵、Unicode 下标、
  > 空格对齐数表）与"把约定固化成宏"是下一步，另开一笔。

- docs(示例): 线代的方程组补上大括号、题库数学改 LaTeX ([c827270](https://github.com/Miaotofu01/Study-Mate/commit/c82727057d784b85548b7db6aa4d577cb328086c))

  > 两件事一起做（都在示例里，产物由渲染器重生成）：
  > 
  > \*\*方程组补大括号\*\*：0001 两处、0003 五处（\`\\left\\{\\begin{aligned}…\\end{aligned}\\right.\`）。
  > 消元链那种推导不加括号——它不是方程组。补完 0003 的 11 个块级公式里有 5 个以 \`{\` 起头。
  > 
  > \*\*题库数学改 LaTeX\*\*（219 处公式，含 9 处矩阵）：题面/选项/参考答案/判分要点/解析里的
  > \`\[\[1, 2\], \[2, 4\]\]\` 变成 \`\\begin{bmatrix}…\\end{bmatrix}\`，\`(… | …)\` 数表变成
  > \`\\left\[\\begin{array}{ccc|c}…\\right\]\`（分数写 \`\\frac{1}{2}\`），\`e1\`/\`x·e1 + y·e2\` 变成
  > \`$e\_1$\` / \`$x e\_1 + y e\_2$\`。得分、量词、"N 倍"、中文说法写的算术、序数标签都保持散文——
  > 它们不是算式。
  > 
  > \*\*组件副本同步\*\*：quiz.js（两门各一份）与共享层 lesson-math.js 是 templates/assets/ 的副本，
  > 引擎改过就得覆盖（record-keeping 第 4 条），否则科目里的副本还是旧版、题面公式排不出来。
  > 
  > 验证：三页渲染 + 检查全 OK（只剩既有的「下节课未产出」WARN）；真实 Chrome 里
  > 题面公式 13/14/10 条、选项 16/12/0 条、解析 5/8/3 条全部排出来，块级公式分别有 2/0/5 个以
  > 大括号起头，katex-error 0。

- docs(数学): 方程组只写判据、不指定形状（\`cases\` 与 \`\\left\\{…\\right.\` 都行） ([e8c3a1c](https://github.com/Miaotofu01/Study-Mate/commit/e8c3a1c95175a7a6c7581117db39d3a1403a658c))

  > 做了一次对照实验（两臂只给"规格路径 + 值 + 验收"，一个字不提形状）：
  > 
  > | 大括号规则 | 我的形状清单 | 产出 |
  > |---|---|---|
  > | 无 | 有（派工时列的 bmatrix / array|c / aligned） | 0 处括号 |
  > | 无 | 无 | \*\*\`cases\` 10 处，一次没漏\*\* |
  > | 有 | 无 | \`\\left{\\begin{aligned}\` 5 处 |
  > 
  > 结论：\*\*先验自带大括号\*\*，元凶是我在派工 prompt 里列的形状清单（不完整的清单把正确的先验
  > 替换成了有缺口的模仿目标）；而规格里那条"必须用 \`\\left\\{…aligned…\\right.\`、\`cases\` 留给分段函数"
  > 是同一个毛病的另一种形态——过度指定形状。
  > 
  > - 课件内容格式：改成「方程组要带大括号（不写就没有）；\`cases\` 与 \`\\left\\{…aligned…\\right.\` 都行，
  >   前者省事、后者对齐等号」，并把两种写法并列举例
  > - learning-coach / layered-practice：同样只留判据（钉串不受影响，仍 414 条）

- fix(CI): 修掉 Python 3.12+ 的非法转义警告——它在 3.13 上把一条断言撑破了 ([37942fc](https://github.com/Miaotofu01/Study-Mate/commit/37942fc7233cdbdbb58b3a44d8dbbde68aa6662c))

  > CI 只在 Node 24 / Python 3.13 那三档红，Node 22.19.0 / Python 3.9 全绿。根因不是 Node：
  > 
  > - Python 3.12 起，字符串里的\*\*非法转义序列\*\*（\`'\\l'\` 这种）从静默变成 \`SyntaxWarning\`；
  > - 我在 check\_lesson.py 的模块文档串与一条提示语里写了 \`\\left\\{\`，3.13 下警告打到 stderr，
  >   而警告会\*\*回显那行源码\*\*（那行本来就含「大括号」三个字）；
  > - \`test\_lesson\_links.py\` 里那条断言写的是 \`'大括号' not in out\`（out = stdout + stderr），
  >   于是被警告文本撑破 → 该套件 exit 1 → checks.mjs 失败。
  > - 本地一直是绿的，因为本机 python 是 3.11（还没有这个警告）。
  > 
  > 改法（两处都修，缺一不可）：
  > - check\_lesson.py / test\_lesson\_links.py：含反斜杠的文档串与提示字符串改成\*\*原始字符串\*\*
  > - 那条断言改成只看 \`WARN\` / \`FAIL\` 行——解释器警告回显源码不该撑破断言
  > 
  > 验证：
  > - \`python -W error::SyntaxWarning -m compileall scripts/ templates/\`（3.13）干净
  > - \`uv run --python 3.13 node scripts/release/checks.mjs\`（完整模拟 CI 那一档）退出码 0
  > - 本地 14 套快测仍全绿

- test(CI): 加一道「全部 .py 能编译过」的静态体检——把这类问题根治在编译期 ([0bc2447](https://github.com/Miaotofu01/Study-Mate/commit/0bc24474b6756ac0ea458fc16064dbfaa2c6d3d9))

  > 上一提交修掉了那两处非法转义，但没有防住复发。这道补的是\*\*机制\*\*，不是某一行：
  > 
  > - 新 \`scripts/tests/test\_python\_syntax.py\`：把 \`scripts/\` 与 \`examples/\` 下\*\*全部 34 个 .py\*\*
  >   解析一遍，有语法级问题（含 3.12+ 的非法转义 SyntaxWarning）就带 \`文件:行号\` 报错。
  >   不依赖"测试正好跑到那个文件"——那正是这次漏掉的原因：\`check\_lesson.py\` 的转义是被别的测试
  >   间接跑出来的，报错信息还伪装成了断言失败。
  > - 自动进 CI：\`checks.mjs\` 按 \`test\_\*.py\` 通配跑全部套件，\*\*不用改 workflow\*\*。
  > - 版本盲区写在明面上：本机 Python &lt;3.12 不会为非法转义发警告，脚本自己打一行提示，
  >   并给出 \`uv run --python 3.13 …\` 的提前自查命令——免得"本地绿"被当成"没问题"。
  > - 本地套件 14 → 15 套（run\_tests.sh 与 tests/README 同步）。
  > 
  > 反向验证：往 check\_lesson.py 里注入一行 \`BROKEN = "\\left\\{"\` →
  >   3.13（CI 档）exit 1，报 \`scripts/check\_lesson.py:1088 invalid escape sequence '\\l'\`；
  >   3.11 通过并打印版本盲区提示。恢复后两边都绿。
  > 
  > （上一提交里"断言只看 WARN/FAIL 行"的改动保留：它不是遮问题——转义已在源头修掉，
  > 它只是让无关输出（解释器警告回显源码）不再撑破断言。）


[完整比较](https://github.com/Miaotofu01/Study-Mate/compare/v0.1.4...v0.1.5)
<!-- /studymate-release:v0.1.5 -->

<!-- studymate-release:v0.1.4 -->
## [0.1.4](https://github.com/Miaotofu01/Study-Mate/releases/tag/v0.1.4) - 2026-09-23

### 已合并的 Pull Request

- Fix/dsh old host graceful degrade ([#7](https://github.com/Miaotofu01/Study-Mate/pull/7))

### 所有提交

- Update README to remove studymate commands ([14c44f1](https://github.com/Miaotofu01/Study-Mate/commit/14c44f144738ba83850d6bfa98338dc431a12881))

  > Removed installation and upgrade instructions for studymate.

- fix: let old DSH hosts skip native plugin loading ([fbf7399](https://github.com/Miaotofu01/Study-Mate/commit/fbf7399148d13fb7e9c62f4efcbde1af8dd24b11))
- test: cover graceful fallback on old DSH hosts ([c42e81c](https://github.com/Miaotofu01/Study-Mate/commit/c42e81c2d349c087c34539d6712467d349358406))
- Merge pull request \#7 from GodBlessRen/fix/dsh-old-host-graceful-degrade ([f839b93](https://github.com/Miaotofu01/Study-Mate/commit/f839b9359943b7eaa7115040d48110bfb8d19a24))

  > Fix/dsh old host graceful degrade

- docs(README):新增配图 ([263dd5f](https://github.com/Miaotofu01/Study-Mate/commit/263dd5f3585cd7dd4697a2c75f64faea84ec0e24))
- docs(README):新增配图 ([1f0953a](https://github.com/Miaotofu01/Study-Mate/commit/1f0953a366a665d99755ca44da8677efd504c73e))
- docs(README):新增配图 ([c9667b8](https://github.com/Miaotofu01/Study-Mate/commit/c9667b8dfe4c4343d497b659e9755798d99a9181))
- fix(lesson-design):优化课件提示词 ([7813fb1](https://github.com/Miaotofu01/Study-Mate/commit/7813fb136eee3221ab31d84c030592699a904e05))
- fix(layered-practice):优化课件提示词 ([9da9090](https://github.com/Miaotofu01/Study-Mate/commit/9da909011349f6f9c1ed538d7465995812745887))
- 添加项目交流群 ([dc53a7c](https://github.com/Miaotofu01/Study-Mate/commit/dc53a7c74b7b21ad262d20b6dcbe3c7049288008))
- fix: protect DSH downgrades and make installer migration explicit ([883829f](https://github.com/Miaotofu01/Study-Mate/commit/883829ffcb5a5d77cc08e43a769c8c823fcb06dc))
- 修复：调整 CI 临时目录变量的使用位置 ([ca9bec0](https://github.com/Miaotofu01/Study-Mate/commit/ca9bec070cc452136149a15ae9d474f6f8dbd111))

  > 将 DSH 测试路径从作业级环境变量移到对应测试步骤，避免 runner.temp 在工作流校验阶段不可用，恢复兼容性检查的执行。

- fix：Readme 安装引导 ([261f15f](https://github.com/Miaotofu01/Study-Mate/commit/261f15f9bc8640b6e153e04f9dbb5b0a5faa8aae))

  > Updated installation instructions and added emphasis on npm installation.

- fix(ci)：等待 DSH 预设检查的异步结果 ([8dcc4fa](https://github.com/Miaotofu01/Study-Mate/commit/8dcc4fa82d12930d3638f6010b39312d407c8416))

  > 为两处 inactiveRows 检查补充 await，兼容 DSH 0.1.6 的异步返回值及旧版同步返回值，修复发布流程中的测试失败。
  > 
  > 验证：DSH 0.1.6-alpha.2 的运行时和 CLI 测试 5 项通过；DSH 0.1.5-rc.2 的运行时测试 2 项通过。

- fix(发布)：纠正修复代码后的重试说明 ([d868364](https://github.com/Miaotofu01/Study-Mate/commit/d8683643e328693ab27b6933966506fba766d7b1))

  > 检查失败后若已有修复提交且尚未创建版本 tag，应从最新 main 新建发布；重跑旧任务不会包含新提交。已有版本 commit/tag 的任务仍重跑原任务，保留原版本的恢复机制。


[完整比较](https://github.com/Miaotofu01/Study-Mate/compare/v0.1.3...v0.1.4)
<!-- /studymate-release:v0.1.4 -->

<!-- studymate-release:v0.1.3 -->
## [0.1.3](https://github.com/Miaotofu01/Study-Mate/releases/tag/v0.1.3) - 2026-09-23

### 所有提交

- ci: 等待 npm 完成异步包处理再核验发布 ([0862d57](https://github.com/Miaotofu01/Study-Mate/commit/0862d57178b312026dea69af8146c5923e61b758))
- feat: 支持 DSH 原生插件安装与更新 ([476f566](https://github.com/Miaotofu01/Study-Mate/commit/476f566df5f140c124991edb818aae68d5217535))
- Update README with upgrade instructions and version info ([cf1e2dd](https://github.com/Miaotofu01/Study-Mate/commit/cf1e2ddc7a975d9d87e21ac069bb423f3fad65d3))

  > Added upgrade instructions and updated version information.


[完整比较](https://github.com/Miaotofu01/Study-Mate/compare/v0.1.2...v0.1.3)
<!-- /studymate-release:v0.1.3 -->

<!-- studymate-release:v0.1.2 -->
## [0.1.2](https://github.com/Miaotofu01/Study-Mate/releases/tag/v0.1.2) - 2026-09-23

### 已合并的 Pull Request

- 修复若干问题 ([#3](https://github.com/Miaotofu01/Study-Mate/pull/3))

### 所有提交

- 修复安装路径含单引号、方括号等字符时安装失败或配置损坏的问题。 修复重复安装时无法正确沿用带特殊字符工作区的问题。 修复主页漏扫文件、特殊字符链接失效和空大纲显示旧进度的问题。 修复学习目标悬停提示显示成节点标题的问题。 修复非法大纲导致校验崩溃、重复节点造成编号异常及依赖方向提示错误的问题。 修复题目属性误报、多个题目块漏检和异常题库导致渲染崩溃的问题。 修复图片目录被误放行、编码路径误报和绝对路径漏拦的问题。 修复异常题目中断后续练习、无效题目参与计分的问题。 修复题号和反馈前缀破坏代码围栏，以及 Windows 换行解析失败的问题。 修复代码高亮误判字符串、破坏原文及未知语言触发异常的问题。 修复平板侧栏无法展开，以及切换手机布局后上下课导航消失的问题。 修复无题理由回填破坏换行格式、写入失败可能损坏原文件的问题。 修复课件重编号临时文件冲突、失败回滚不完整及恢复提示错误的问题。 修复技能调用开关判断错误、异常元数据中断批量检查的问题。 修复图片池索引放行错误列数、无效日期及非法文件名的问题。 修复 Windows 无法自动打开预览页面的问题。 修正示例答案路径和错误类型声明，并同步示例前端资源。 ([d3ff025](https://github.com/Miaotofu01/Study-Mate/commit/d3ff025e6d12b49d1d5eb7d01d67ef5ca8c5db21))
- fix:修复 MAC 在运行 install.sh 时将紧邻的中文括号误读为变量名 ([fb6ffd0](https://github.com/Miaotofu01/Study-Mate/commit/fb6ffd0ed628bc1c3e00a6df1c6ea99cf984a26c))
- 增加 npm 安装方式 ([61fc675](https://github.com/Miaotofu01/Study-Mate/commit/61fc6759164fea73ee1123fdfd638e844f954c34))
- Merge pull request \#3 from guoweiyi/main ([c69a768](https://github.com/Miaotofu01/Study-Mate/commit/c69a768597e08a2b83fb6ed672849f9ca75e5e2a))

  > 修复若干问题

- docs: 新增待办清单,方便人工维护 ([c8cb604](https://github.com/Miaotofu01/Study-Mate/commit/c8cb604a9acba16b6762d1c390bda840a61f2faf))
- README:新增前言 ([8af8275](https://github.com/Miaotofu01/Study-Mate/commit/8af8275a6977216923e356abceda03148372cc4c))
- README:修改readme ([b7e662f](https://github.com/Miaotofu01/Study-Mate/commit/b7e662f446a5949028698bb54a287cb3f56d959c))
- fix(提示词): 按 issue \#5 的实测反馈改课件与采图规则 ([a4ecc2c](https://github.com/Miaotofu01/Study-Mate/commit/a4ecc2c82a674979ee18009c567a6ce3c1904ee4))

  > - curriculum-designer：第一个节点改成用具体材料/案例开场，不再先上全景图
  > - lesson-design：术语与配图两条改成可执行的要求
  > - learning-coach：用图前必须先打开图片核对图注；补 SVG 不许写死宽度、字号下限
  > - image-scout：交稿前跑 check\_pool.py 并改到没有为止；主题词以 GLOSSARY.md 为准
  > - learning-system：开课先写 GLOSSARY.md 的「待掌握」，采图与课件共用同一套词
  > 
  > Refs \#5

- 修改:测试文件 ([84f3af7](https://github.com/Miaotofu01/Study-Mate/commit/84f3af7cea35ed83165d449728b196c2468063d6))
- fix(提示词): 第一课禁用学科定义/发展史/本课结构 ([632b441](https://github.com/Miaotofu01/Study-Mate/commit/632b441b28d78102965e93fff4f18919ec4d4d2b))
- feat(校验): check\_curriculum 报依赖位次倒挂 ([93d7923](https://github.com/Miaotofu01/Study-Mate/commit/93d7923182e95e111df3e8d994f8bb0c18fd9ff6))

  > 示例科目 typescript-web-api 现有一处倒挂（exp.pg-and-tests 依赖 test.api），本次未修。

- docs(README): 加 Star 趋势图 ([c79f2cd](https://github.com/Miaotofu01/Study-Mate/commit/c79f2cdd84739f44fc01e49ad68e01c237f61c28))
- fix: 兼容 DSH 新版预设与工作流插件 ([cb9e448](https://github.com/Miaotofu01/Study-Mate/commit/cb9e448d12a4de43cef4cfeef5412ef14ee33a25))

  > 分别适配 0.1.6 工作流更名和 0.1.7 声明式预设，保留旧版安装方式及用户配置。Refs \#4

- ci: 自动生成发布日志并发布 npm 包 ([88be504](https://github.com/Miaotofu01/Study-Mate/commit/88be504a3eb992daf1f1cffbc8851380256aed00))

  > 手动选择版本增量，经三平台检查后整理合并 PR 和全部提交，更新 CHANGELOG、版本标签和 GitHub Release，通过 npm OIDC 发布。

- test: 兼容 Windows 临时目录的短路径表示 ([0da4ca7](https://github.com/Miaotofu01/Study-Mate/commit/0da4ca7a8c5af38daef0d37571e0d7a1fb720b98))
- fix: 绕过 Node 22 在 Windows 复制中文目录时的崩溃 ([c4b2613](https://github.com/Miaotofu01/Study-Mate/commit/c4b2613116a5dc46c9796426749792f15501a42f))

[完整比较](https://github.com/Miaotofu01/Study-Mate/compare/v0.1...v0.1.2)
<!-- /studymate-release:v0.1.2 -->

## v0.1 — 首个可交付版本（2026-09-21）

- **学习模式预设 + 11 个技能**：1 个总控、5 个角色（找资料／采图／课程设计／讲解／出题评估）、5 份规范；配套大纲、进度、评估、会话摘要、科目五份数据结构。
- **三件套页面**：课程总览页、科目主页（大纲路线图）、课件页，共用一套主题（默认暗色，右上角可切）。课件由「内容文件 + 题库」渲染产出，四道校验（大纲／课件／图片库／技能）把关。
- **一条命令安装**：macOS/Linux 跑 `./install.sh`，Windows 跑 `.\install.ps1`——装预设、建学习工作区、写好配置。
- **13 套回归测试**：钉住渲染、题目、命名与上下节课指针、图片库、提示词规则与两个前端组件。
