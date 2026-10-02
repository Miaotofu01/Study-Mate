# 更新日志

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
