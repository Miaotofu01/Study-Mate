# StudyMate Web E2E 测试流程

> 版本：v2.4（2026-10-04，产课/评估工具化 + 「我的课程」首页 + 聊天右栏图谱轮）
> 性质：测试流程文档——描述 E2E 用例如何映射上游插件的用户使用旅程（docs/使用/使用说明.md、docs/设计/设计方案.md），以及每条用例的步骤、断言与数据准备；不含测试代码。
> 运行方式：`cd frontend && npm run test:e2e`（Playwright 自动拉起后端 8290 [fixture 模式] + 前端 dev 3810）。
> 维护约定：新增/修改用户可见功能时，对照第 3 节的映射表补充或调整用例；本文与 `tests/e2e/` 同步演进。
>
> v2.4 修订（2026-10-04，第八轮）：**产课与评估改由会话 agent 工具发起**，节点详情页「产出此课」「申请评估」按钮删除——删除 `produce-chain.spec.ts`、`assessment.spec.ts`（各 1 / 2 条），新增 `produce-tool.spec.ts`（1 条，`FIXTURE_TOOL_SCRIPTS["produce"]`）、`assess-tool.spec.ts`（1 条，`["assess"]`）；**`/courses` 不带 `?subject=` 变「我的课程」**（内嵌 `home-embed`、无右栏），新增 `courses-home-embed.spec.ts`（2 条）；**聊天右栏新增科目图谱区**，新增 `chat-subject-graph.spec.ts`（1 条）。断言改动：`tool-cards`（工具卡常显、无 process-panel）、`message-actions`（工具卡移出折叠区）、`subject-switch` / `theme-visual-inspection`（`/courses?subject=` 显式带科目）、`course-build`（promote 后会话自动关联 + 右栏图谱区 + 「开始第一课」按钮）。E2E **62 条通过 + 3 条 skip（0 失败）**；后端 pytest **145 条 + 1 skip**。
>
> v2.3 修订（2026-10-04）：建课/产课新发 `progress` 进度快照（第 N 轮 / 已等待 Ns / 工具次数），配合墙钟上限（聊天 300s / 编排 1800s）。**进度卡不进 E2E**——fixture 模式下编排是瞬时完成的，快照一闪而过，断言不可靠；改由组件测试覆盖（`tests/component/ChatView.test.tsx` 的「建课进度卡」用例喂一份假快照）与后端 pytest 3 条（墙钟砍断 / 快照上报 / 退出后停心跳）。E2E 侧只确认新事件不破坏既有编排流（60 条仍全绿）；后端 pytest **117 条 + 1 skip**、组件测试 **20 条**。
>
> v2.2 修订（2026-10-04）：`course-build.spec` 加一条断言——建课会话可见正文里**不含收口标记**（`<!--INTERVIEW_RESULT-->`），对应本轮「标记不再露出」的改动；后端 pytest 新增 2 条同向用例（含半截标记与首尾空行）。E2E **60 条通过 + 3 条 skip**、后端 pytest **114 条 + 1 skip**。
>
> v2.1 修订（会话级模型 + 档位语义兼容轮，2026-10-04）：新增 `session-model.spec.ts` 2 条——**会话内切换模型只写该会话的绑定**（PATCH `/api/sessions/{id}`，全局默认不动；刷新后重开会话仍是该模型；后端确实用绑定模型跑该轮，落库的 `model` 标识可证）、**新对话态切换仍写全局默认**（PUT `/api/settings`）。`message-actions.spec` 的助手名称栏/上下文窗口断言保持（现按"生效三元组"取值）。E2E **60 条通过 + 3 条 skip**（新增 2 条）、后端 pytest **112 条 + 1 skip**（新增 `test_session_model.py` 10 条、`test_reasoning_variants.py` 21 条）。
>
> v2.0 修订（消息操作与中间过程折叠轮，2026-10-04）：新增 `message-actions.spec.ts` 5 条——助手名称栏（`assistant-name`，显示「提供商 / 模型」）、右栏「上下文窗口」栏（`context-window` / `context-window-model` / `context-window-usage`）、**思维链与工具调用收进 `process-panel` 折叠区**（默认收起、`process-reasoning` / `process-notices` / 内嵌工具卡）、用户消息「复制 / 编辑」（编辑=从该条截断并重新生成，含附件可增删）、助手「删除本轮」（内联二次确认 `turn-delete-confirm`）。`tool-cards.spec` 同步为"先展开 `process-summary` 再断言工具卡"（工具不再裸挂在消息下）；`settings-models.spec` 档位文案与设置页徽标断言改「去掉『思考 · 』前缀、只留档位名」（`model-variant-badge`）。E2E **58 条通过 + 3 条 skip**（新增 5 条）、后端 pytest **81 条 + 1 skip**（新增 `test_message_actions.py` 6 条）。
>
> v1.9 修订（第二轮 UI 杂项轮，2026-10-04）：**新对话态新增「科目 + 工作区」关联行**（只在新对话态出现，见 §4.23 + `new-session-association.spec.ts`）；右栏「会话关联」整段移除、**小结与沉淀记忆入口悬空**（`memory-flow` 2 条 / `session-summary` 1 条改 `test.skip(true, …)` 挂起，见 §4.8 / §4.19）；`helpers.associateSubject` 改为直连关联行（不再展开右栏）、`openNodeDetail` 改为先切「大纲」段再点节点行（`theme-visual-inspection` 同步）；`workspace-onboarding` 改写为"关联行反映当前工作区"；`courses.spec` 补「科目总览状态可就地改」与「侧边栏科目选中态」两条、原第二条改为分段切换 + 画布不销毁（用标记验证）。E2E **53 条通过 + 3 条 skip**、后端 pytest **75 条 + 1 skip**（新增 `test_session_workspace.py` 11 条）。
>
> v1.8 修订（K 系列工具化轮，2026-10-04）：新增 `tool-cards.spec.ts`——fixture 模式下 chat 走 canned 工具脚本（`FIXTURE_TOOL_SCRIPTS["tools"]`：list_workspace → read_course_file → 最终答复），请求体的 `fixture_scenario` 由路由拦截改写，断言两张工具卡（`tool-card` / `tool-name` / `tool-result`）与工具轮后的最终答复。E2E 53 条、后端 pytest 64 条全绿（新增 `test_tooling.py` 22 条覆盖三格式 wire 映射 / 流式聚合 / agent loop 预算与降级 / 沙箱 / 审计 / K2 硬停兜底）。**工具调用后定为默认对所有模型开启**：模型编辑弹窗的「工具调用」开关已移除（改只读提示），`settings-models.spec.ts` 改用仍在的「JSON Schema 输出」验证能力开关可切换；探索目标 g13 同步。
>
> v1.7 修订（会话绑定与布局对调轮，2026-10-04）：随"科目绑死"拍板——`helpers.associateSubjectNode` 改 `associateSubject`（右栏节点下拉已移除，7 个 spec 调用点更新）；`chat-course-context` 重写（绑定锁 + 新会话不继承 + 数据层 node 为 null）；`subject-switch` 去课程页第二列路径；`courses.spec` 第二条重写（图谱收进右栏 + 大纲主区选节点）；`misconceptions.spec` 追加"定位节点 + 带参预填"；`chat-shell` 断言改"节点下拉 count 0"。后端 pytest 补 `test_binding_focus.py` 4 条（42 条全绿）。
>
> v1.1 修订：新增第 2 节「能力边界与补强计划」——人工试用清单（`反馈清单.md`，6 条）抓到的问题全部落在 E2E 射程之外，本文按三类盲区归因并给出 P1–P5 补强顺序；第 5 节维护约定同步追加"逆向前置状态"与"入口载荷断言"两条规则。
>
> v1.2 修订：反馈清单 10 条全部落地，用例数 25 → **34**，两轮幂等。新增 `chat-shell.spec.ts`、`chat-draft.spec.ts`、`settings-models.spec.ts`、`sidebar-resize.spec.ts`，`misconception-entry.spec.ts` 补 adverse 变体；同时修掉两处**测试侧路径 bug**（见 §1 末条），并变更两处选择器口径（顶栏标题改 `data-testid="chat-title"`、"新对话"改走侧边栏入口；概念本顶部筛选下拉的标签由「科目」改「学科」，避免与弹层新增的「科目」撞名）。
>
> v1.3 修订：提供商/模型域升到 **schema v3**（输入模态复选框组 / 最大输出 Token / 上下文窗口 / 推理档位 chip 编辑器；API Key 改为回填输入框），右侧边栏抽成共享外壳并支持**拖拽 + 折叠动画**，**课程图谱页的节点详情改由右侧边栏承载**。用例数 34 → **37**，两轮幂等。
>
> v1.4 修订（实施轮 A/B/H/I + G）：用例数 37 → **43**，两轮幂等。新增 `settings-workspace.spec.ts`、`memory-flow.spec.ts`、`attachments-area.spec.ts`；扩展 `assessment.spec.ts`（实验课联升 + 学习记录）、`session-summary.spec.ts`（同日多段追加）、`chat-basic.spec.ts`（「下一步」锚点）。工作区布局随实现改为 `<WS>/.learning/subjects`（`global-setup.ts` / `constants.ts` 同步）；E2E 后端改由 `STUDYMATE_CONFIG` + `STUDYMATE_DATA_DIR` **双注入**——前者让 `PUT /api/workspace` 可观测（`STUDYMATE_WORKSPACE` 优先级最高会架空它）、后者隔离 settings/sessions/exports；fixture 配置在 config 模块加载时写好（webServer 早于 globalSetup 启动，迟到会让后端回落到真实 `~/StudyMate` 并缓存整轮）。
> v1.5 修订（裁定后实施轮，2026-10-03）：用例数 43 → **44**。新增 `workspace-onboarding.spec.ts`（新会话选工作区：仅工作区无科目时出现，切换即时生效且用例 finally 恢复）；`session-summary.spec.ts` 补「小结后的沉淀记忆入口」（用 fixture 新增的 `memory_updates` 预填确认弹窗并写入）；`assessment.spec.ts` 联升用例补「评估通过后的沉淀记忆入口」（走 suggest）。两份 Playwright 配置的 `reuseExistingServer` 统一为 `false`（不再静默复用陈旧端口）；`chat-shell.spec.ts` 的折叠断言改为宽度判据。

---

## 1. 分层策略

沿用两层设计（对照 DeepTutor 的分层）：

- **后端 fixture 层**（主力）：`STUDYMATE_E2E_FIXTURE=1` 时 LLM 调用返回确定性内容（流式分段文本、判分/评估/小结/科目生成的 canned 输出，全部经过真实解析链路验证）。SSE 流转、会话持久化、状态机、附件移动、门禁脚本全部走真实链路——测的是"真后端 + 真前端"的聚合行为。chat 与判分等 `fixture_kind` 见 `backend/app/llm.py`。
- **UI route mock 层**（补充分支）：仅当需要测"上游失败/校验拒绝"这类 fixture 不便复现的分支时，用 `page.route` 拦截单个接口返回错误响应（如科目生成被门禁 422 的 problems 展示）。拦截必须局部、测试结束即恢复，不得覆盖整页数据。

数据隔离：globalSetup 每轮重建 `study-mate-web/data/e2e-ws`（种子科目 yaml + examples 的 lessons/assets）与 `study-mate-web/data/e2e-data`（settings/sessions/uploads/exports），真实开发数据零污染。fixture 工作区 settings 中 DeepSeek 带占位 key 保证输入可用。

**路径口径（三处必须一致，2026-10-02 修）**：E2E 的运行时根目录是 `<study-mate-web>/data/`，由 `backend/app/config.py`（`WEB_ROOT`/`DATA_DIR`）、`frontend/playwright.config.ts`（`E2E_WORKSPACE`/`E2E_DATA_DIR`）、`frontend/tests/e2e/global-setup.ts`（落盘）与 `frontend/tests/e2e/constants.ts`（用例回读）四处共同约定。此前 `playwright.config.ts` 与 `constants.ts` 各自少算/多算一级，指向了仓库根的 `data/`，导致后端读到陈旧 fixture（无 key、无 lessons）而大面积失败；且因 `reuseExistingServer` 会复用手工启动的正确服务，这个错误长期不可见。**改动运行时目录时，这四处要一起改。**

第三层「探索 agent」（`frontend/tests/explorer/`，LLM 驱动浏览器模拟用户）是**发现层**：按需触发、不设门禁，用法另见 [探索测试指南](StudyMate-Web_探索测试指南.md)；第 2 节 P1–P5 补强计划与其共享结论——探索发现的问题，毕业去向是脚本用例、组件测试或设计验收。

---

## 2. E2E 的能力边界与补强计划（2026-10-02 人工测试复盘）

v1.0 的旅程用例两轮全绿且幂等，但维护者人工试用（`反馈清单.md`，6 条）发现的 bug **全部**落在 E2E 射程之外。这一节钉住的是 E2E **看不看什么**：旅程级用例继续有效（它们守住"真后端 + 真前端"的聚合与落盘），但写新用例、验收"已覆盖"之前，先对照本节，避免下一轮按同一标准再产出同样的盲区。

### 2.1 三类盲区（结构性，不是用例数量问题）

| 盲区 | 为什么现有 E2E 看不见 | 本轮实例 |
| --- | --- | --- |
| 请求内容层 | fixture 的 canned 响应 shape 永远正确，**与请求携带了什么无关**；UI route mock 同理。前端"把用户输入吞了"（填了 key 却没进请求、跳转参数丢失）整类不可见 | 填入 API Key 后点"测试连接"仍报"缺少 API Key" |
| 状态分支层 | 覆盖原则按"最好前置条件"写每条旅程（关联好科目、选好节点、key 恰好留空）；逆向前置状态（不关联科目的对话、已填 key 的测试连接、空模型列表）组合爆炸，不在旅程级射程内 | 对话不关联科目时"记入概念本"保存无效；"有 key"状态从未被观测 |
| 渲染层 | 断言全是结构与状态（属性、文案、DOM），**不含视觉正确性**；`theme.spec.ts` 只验 `data-theme` 属性，暗色下样式全坏也全绿；Playwright 默认 colorScheme 为 light，暗夜样式根本不参与渲染 | 暗夜模式下拉白字白底；API Key 占位符"·"间距过宽；logo 缺失 |

结构根因：**覆盖标准是"旅程中每个用户动作至少一条用例"——它覆盖动作，不覆盖状态、渲染与请求内容。** 真实用户不沿旅程走：他们在任何状态下戳任何组件，常开暗夜模式，用真实字体与 DPI。

### 2.2 六条反馈归因与归口

| 反馈 | 盲区 | 归口 |
| --- | --- | --- |
| API Key 填入仍报"缺少 API Key" | 请求内容 + 状态分支 | 载荷断言（P1）+ adverse 变体（P2） |
| 模型模态选择逻辑 | 纯覆盖缺口：ModelSelector 下拉交互零用例（映射表"已覆盖"仅含顶栏文案断言） | 补交互用例（P2） |
| 标签页 / 侧边栏 logo | 视觉资产 | 设计验收，不硬造 E2E（P5） |
| 暗夜下拉白字白底 | 渲染 | colorScheme 矩阵 + 定向 toHaveCSS（P3） |
| 无科目记概念本保存无效 | 状态分支 | adverse 变体（P2）+ 组件测试下沉（P4） |
| 占位符"·"间距过宽 | 视觉细节 | 设计验收 / 人工走查（P5） |

### 2.3 补强计划（按优先级；落地时同步回填第 3 节映射表）

- **P1 请求载荷断言**：用 `page.route` 在放行前读 `route.request().postDataJSON()`，断言关键入口的载荷必含用户刚输入的值——测试连接的 `api_key`、ModelSelector 切换的 `active`、"记入概念本"的 prefill 参数。成本最低，捕获整类"字段静默丢失"。**部分落地（2026-10-02）**：测试连接的 `provider_id` 回流与"留空回落已存 Key"已由 `settings-providers.spec.ts` 端到端断言；ModelSelector 切换与 prefill 的载荷断言仍待补。
- **P2 已知缺口闭合**：① ModelSelector 下拉交互用例（打开 → 切换模型 → 断言顶栏标签与持久化）；② chat 无科目 → 记入概念本 → 保存 的 adverse-precondition 变体。**已落地（2026-10-02）**：② 见 `misconception-entry.spec.ts` 第二条用例；① 见 `settings-models.spec.ts`（对话侧思考档位切换），"切换后断言持久化"部分仍待补。
- **P3 渲染矩阵**：playwright 配置加 `colorScheme` 矩阵跑 2~3 个关键页面；对 native `<select>` 暗色 option 颜色等已知雷区做定向 `toHaveCSS`。**不做**全页截图基线——那会把旅程级 E2E 变成视觉回归，与第 1 节分层冲突。**未落地**：本轮暗色下拉改用 CSS `option` 规则修（见 `globals.css`），未加渲染断言。
- **P4 组件测试层**：分支逻辑（空 key、空模型列表、无科目 prefill）下沉 frontend 组件测试，旅程级只保留聚合与落盘断言。**已落地（2026-10-04）**：vitest + Testing Library（jsdom），`npm run test:component`，13 条用例见 `tests/component/`；选型理由（弃 Playwright CT）与"不进根门禁"口径见 Web_CHANGE 同日条目。
- **P5 明确不覆盖清单**：logo、间距、对比度微调度等纯美学项归设计验收；写死边界，避免再次按旅程标准重复投入。**部分落地**：logo 与占位符间距本轮已修，但归口仍为人工走查，不加 E2E（`sidebar-resize.spec.ts` 只断言宽度数值与持久化，不断言视觉）。

一条警示：`settings-providers.spec.ts` 中"无 key 时报缺少 API Key"用例断言的是合理分支，但**"已填 key"这一互补状态从未被观测**——若后端把填了 key 的请求也判成缺少，套件依然全绿。这正是 P1 存在的意义：每个"用户输入 → 请求"入口都要有载荷断言，而不是只断言错误分支。

---

## 3. 旅程阶段 → Web 功能 → 用例映射

上游插件旅程（docs/）与 Web 运行时的对应关系，以及覆盖状态：

| 旅程阶段（插件侧） | Web 等价功能 | 用例文件 | 状态 |
|---|---|---|---|
| 安装与宿主适配 | 一键启动 + E2E fixture 工作区（global-setup 铺设） | （由 webServer 承担）每条用例隐式冒烟 | 已覆盖 |
| 选方向（learning-discovery） | chat 欢迎区「不知道学什么」→ 建课会话（learning-discovery 全文注入，探索期不写盘） | `course-build.spec.ts` | 已覆盖（2026-10-03） |
| 建科目（盘问五项 + 大纲门禁） | `/generate` 五项向导 → `check_curriculum.py` 当门；chat 内盘问（interview 会话收口标记 → 草稿 → 建课编排 → 落点确认） | `generate.spec.ts`、`course-build.spec.ts` | 已覆盖（2026-10-02 / 2026-10-03） |
| 开场恢复状态 | Chat **新对话关联行**指定科目（发出首条消息后入口消失）→ 课程上下文注入（节点聚焦由后端自动推断）+ **开场状态切片**（MEMORY 分节 / 最近误解 / 学习记录 / 评估记录） | `chat-course-context.spec.ts`、`new-session-association.spec.ts`、pytest `test_binding_focus.py` | 已覆盖（2026-10-02；切片注入在 system 层由 TestClient 覆盖；绑定/推断 2026-10-04；关联行 + 会话级工作区 2026-10-04 第二轮） |
| 产课（三件套） | 会话 agent 工具 `produce_lesson`（按大纲顺序；节点详情页原「产出此课」按钮已删）→ 讲解/出题角色派工 → render/check 收口（打回归属 + 质检工单） | `produce-tool.spec.ts`、`inspection-ticket.spec.ts` | 已覆盖（2026-10-03；2026-10-04 第八轮改由 agent 工具发起） |
| 读课件 + 页内做题 | `/lesson` iframe + `quiz.js` 页内判分 | `lesson-quiz.spec.ts` | 已覆盖（2026-10-02） |
| 开放题自评 → Web 增强为判分 lite | 判分面板（criteria + 强制证据） | `grading-panel.spec.ts` | 已覆盖（2026-10-02） |
| 提问答疑记误解 | Chat 消息 hover"记入概念本"预填跳转（含无科目 adverse） | `misconception-entry.spec.ts` | 已覆盖（2026-10-02） |
| 评估点（证据>口头） | 会话 agent 工具 `assess_node`（`node_id` + 作答原文）→ 落盘 + **权威置位**（实验课通过连 `prerequisites` 一起置"已通过项目验证"并写学习记录）；节点页原「申请评估」块已删 | `assess-tool.spec.ts` | 已覆盖（2026-10-02；2026-10-04 第八轮改由 agent 工具发起） |
| 状态流转（保守推进） | 节点详情状态按钮 + 图谱着色 | `progress-transition.spec.ts` | 已覆盖（2026-10-02） |
| 会话收尾摘要 | ~~Chat"生成小结" → sessions 落盘（同日按段追加）~~ **已悬空**（2026-10-04 拍板：入口随右栏会话关联移除；后端端点与用例保留、`test.skip` 挂起） | `session-summary.spec.ts`（skip） | 悬空待接回 |
| 误解双落点 | `/misconceptions` CRUD + 筛选 | `misconceptions.spec.ts` 扩展 | 已覆盖（2026-10-02） |
| 多科目管理 | 全局侧边栏科目切换（课程页第二列科目列表已删除） | `subject-switch.spec.ts` | 已覆盖（2026-10-02；2026-10-04 收敛为侧边栏单入口） |
| （Web 特有）节点详情与大纲 / 我的课程 | **`/courses` 不带 `?subject=` = 「我的课程」**（只内嵌工作区主页 `iframe`、无右栏）；带 `?subject=` = 科目头部（含科目状态/进度总览）+ 节点详情卡 + 右栏「图谱（默认）/ 大纲」分段切换（切换不销毁画布，右下角有重置视口）；概念本条目可定位节点（`?node=`）。聊天右栏亦有科目图谱区（默认大纲，点节点跳课程页） | `courses.spec.ts`、`courses-home-embed.spec.ts`、`chat-subject-graph.spec.ts`、`misconceptions.spec.ts` | 已覆盖（2026-10-02；2026-10-04 布局对调 + 定位链路；同日第二轮二次对调 + 科目总览 + 分段切换；**第八轮「我的课程」首页 + 聊天右栏图谱**） |
| 静态产物互通 | "导出静态工作区"（gen_home 真跑） | `export.spec.ts` | 已覆盖（2026-10-02） |
| 长期记忆 MEMORY.md 写侧 | **只剩一个入口**：评估通过后的「沉淀记忆」（右栏手动 / 小结结果区建议两个入口 2026-10-04 随会话关联区移除而悬空）→ 建议条目逐条确认 → 增量写 `.learning/MEMORY.md` | `assess-tool.spec.ts`、pytest `test_memory*.py`；`memory-flow.spec.ts`（skip） | 部分覆盖（2026-10-02；触发入口 2026-10-03；2026-10-04 两入口悬空） |
| 换机器迁移 | —— 属运维操作 | —— | 不适用 |
| （Web 特有）工作区设置与会话级绑定 | 设置页查看/改选工作区（PUT 写 `studymate-config.yaml`）+ **新对话关联行的「工作区」下拉**（与科目并排，空选 = 默认工作区）+ 会话绑定写进会话元数据（`workspace`） | `settings-workspace.spec.ts`、`new-session-association.spec.ts`、`workspace-onboarding.spec.ts` | 已覆盖（2026-10-02 / 2026-10-03；2026-10-04 第二轮改为关联行 + 会话级绑定，原欢迎区引导块用例改写） |
| （Web 特有）附件区 | 聊天页右栏列出术语表 / 本地资料 / 学习记录 / 会话摘要，原文新标签页可读 | `attachments-area.spec.ts` | 已覆盖（2026-10-02） |
| （Web 特有）模型提供商 | settings 二级界面 + 模型行四操作 + 模型编辑弹窗 | `settings-providers.spec.ts`、`settings-models.spec.ts` | 已覆盖（2026-10-02） |
| （Web 特有）暗夜模式 | 主题切换持久化 | `theme.spec.ts` | 已覆盖 |
| （Web 特有）主题视觉巡检 | 四组主题/调色板组合下逐屏截图（设置页深浅 × 科技蓝/经典墨绿、工作台空态、真实对话、课程图谱含节点详情），人眼复核；机判只到 `data-theme` / `data-palette` 与关键元素可见 | `theme-visual-inspection.spec.ts` | 已覆盖（2026-10-04；截图落 `test-results/screenshots/`，对应探索目标 `g17`） |
| （Web 特有）对话壳层 | 顶栏（标题 + 内联重命名 + 右栏开关）+ 右侧边栏（**附件区 + 会话信息**；关联已移到新对话关联行）+ 折叠动画 + 拖拽调宽；新对话态输入区上方的「科目 + 工作区」关联行 | `chat-shell.spec.ts`、`new-session-association.spec.ts` | 已覆盖（2026-10-02；2026-10-04 第二轮改内容与关联行） |
| （Web 特有）输入框草稿 | 按会话缓存（切会话保留、刷新归空、发送后清空） | `chat-draft.spec.ts` | 已覆盖（2026-10-02） |
| （Web 特有）侧边栏宽度与折叠 | 拖拽调宽 + 上下限 + 刷新保留；**折叠成 60px 图标轨**（状态持久化） | `sidebar-resize.spec.ts`、`sidebar-collapse.spec.ts` | 已覆盖（2026-10-02 / 2026-10-04） |
| （Web 特有）基础对话 | 流式回复 / 停止 / 附件 / 用户气泡靠右 | `chat-basic.spec.ts`、`chat-attachment.spec.ts` | 已覆盖 |
| （Web 特有）会话级模型与档位 | 会话内切换模型/档位只写该会话的绑定（`PATCH /api/sessions/{id}` 的 `active` 三元组），全局默认不动；新对话态切换仍写全局默认；该会话的聊天与小结/评估都跑在绑定模型上，绑定失效则回落默认并给提示 | `session-model.spec.ts`；绑定解析与回落由 pytest `test_session_model.py` 覆盖 | 已覆盖（2026-10-04） |
| （Web 特有）工具化调用 | 声明工具调用能力的模型走 agent 循环：会话流内渲染**常显工具卡**（调用 + 结果，兼审计 UI），工具轮之后给最终答复；chat 只读工具、**科目关联会话额外开放 `produce_lesson` / `assess_node`**、建课/产课工具循环 | `tool-cards.spec.ts`（工具卡常显）、`produce-tool.spec.ts` / `assess-tool.spec.ts`（动作工具）；工具循环由 pytest `test_tooling.py` / `test_chat_tools.py` 覆盖（真实门禁/评估服务仍真跑） | 已覆盖（2026-10-04） |
| （Web 特有）消息操作与中间过程折叠 | 助手消息名称栏（提供商 / 模型）；用户消息「复制 / 编辑」（编辑=从该条截断并重新生成，原附件可增删）；助手消息「删除本轮」（内联二次确认）；思维链 + 工具调用 + 本轮提示收进「中间过程」折叠区（默认收起，落库后刷新仍可回放）；右栏「上下文窗口」栏显示最近一轮 prompt tokens 占模型上下文长度的比例 | `message-actions.spec.ts`；截断/删除落库与用量落盘由 pytest `test_message_actions.py` 覆盖 | 已覆盖（2026-10-04） |

覆盖原则：**旅程中每个"用户做什么"在 Web 有等价功能的，必须有至少一条旅程级用例**（从入口点到最终可见结果连续走完，不拆成孤立的字段级测试）。

> **关于"已覆盖"的射程**：本表状态列仅指旅程**动作级**覆盖——逆向前置状态（如无科目对话、已填 key）、渲染正确性、请求载荷均不在射程内，见第 2 节；那三类按 P1–P5 计划补强后，再回来更新本表状态。（状态分支层已于 2026-10-04 经组件测试落地，见 §2.3 P4；载荷断言 P1 仍部分开放，渲染矩阵 P3 未落地。）

> **待翻转行（2026-10-02 决策）已于 2026-10-03 全部翻转**："选方向""产课（三件套）"随生产侧落地改为"已覆盖"（`course-build.spec.ts` / `produce-chain.spec.ts` / `inspection-ticket.spec.ts`）；"长期记忆 MEMORY.md 写侧"于 2026-10-02 翻转。Q5 阅读端形态（iframe + 壳层）不变，`lesson-quiz` / `grading-panel` 现有用例继续有效。fixture 说明：编排链路用 `STUDYMATE_E2E_SCENARIO`（chat 请求 `fixture_scenario` 字段）选固定流场景，仅 fixture 模式生效。

---

## 4. 用例流程明细

约定：所有断言优先用可访问性角色与用户可见文案；需要稳定的定位时给元素补 `data-testid`（不改行为与样式）。fixture 下的 canned 内容见 `backend/app/llm.py` 与 `frontend/tests/e2e/constants.ts`。

### 4.1 generate.spec.ts —— 建科目旅程（对应"盘问五项 + 门禁"）
1. 侧边栏科目区"新科目" → 点"用 AI 向导生成科目"进入 `/generate`。
2. 填五项（名称"测试生成科目"/目的/程度/前置/项目/载体留空）→ 提交。
3. 断言：跳转 `/courses?subject=<slug>`；左侧科目列表出现新科目；图谱渲染出 fixture 大纲的节点（节点数 > 0）；侧边栏科目区同步出现。
4. 失败分支（UI route mock）：拦截 `/api/courses/generate` 返回 422 `{detail, problems:[...]}` → 提交后琥珀警示框出现且逐条展示 problems；页面不跳转。
5. 门外失败分支（同 mock 换 500）：显示通用错误而非 problems。

### 4.2 chat-course-context.spec.ts —— 开场恢复（对应"读档开场"）
1. 进入 `/chat`，**右侧边栏**的关联科目下拉选 computer-networks、节点选 net.layers。
2. 发送"继续学这一节"→ fixture 流式回复完成。
3. 断言：消息出现且可再次发送；顶栏标题进入会话态；切换会话后下拉恢复。
4. 断言（数据层）：测试内用 `request` fixture 拉该会话 JSON，校验 `subject_slug/node_id` 已写回、消息条数正确（后端聚合真实发生）。

### 4.3 lesson-quiz.spec.ts —— 读课件页内判分（对应"读课件做题"）
1. `/courses` 选 computer-networks → sr-only 节点按钮选 net.layers → 详情出现 → 点"打开课件"。
2. `/lesson` 页 iframe 出现且加载课件 HTML（标题可见）。
3. iframe 内找到第一组选择题：点错误选项 → 选项标红 + "✗ 再想想"出现；点正确选项 → 标绿 + why 解释出现；组内全部答完 → "本题组：答对 N / M"出现（quiz.js 真实行为，纯前端确定性）。
4. iframe 内点"下一节"指针 → URL/标题变为下一课（课件内导航不断链）。

### 4.4 grading-panel.spec.ts —— 判分 lite（对应"开放题自评"的 Web 增强）
1. 同 4.3 进入 net.layers 课件 → 顶栏开"判分面板"。
2. 面板列出该节点 quiz 的题目：选择题只读展示（含"页内判分"徽标），开放题有作答区。
3. 开放题输入一段明显不达标准的作答 → 提交判分 → fixture 返回 canned verdict → 断言：verdict 徽标渲染、证据引用列表出现、缺口列表出现。
4. 再提交一次合格作答 → verdict 更新（面板不残留上一次结果）。

### 4.5 misconception-entry.spec.ts —— 提问记误解入口（对应"提问记误解"）
1. `/chat` 关联 net.layers → 发消息 → 等 fixture 回复完成。
2. hover assistant 消息 → "记入概念本"按钮出现 → 点击。
3. 断言：跳转 `/misconceptions`；新建表单预填（question=刚才的用户消息、answer_summary=回复内容、科目/节点已选）。弹层内「科目」下拉的定位用 `getByRole("combobox")`——`getByLabel` 会把 textarea 的正文也算进匹配，题干含"科目"二字时会撞出两个元素。
4. 直接保存 → 列表出现该条目 → 打开 progress.yaml 断言 `misconceptions` 数组同步（双落点后端真实写入）。
5. **adverse 变体（对应无科目对话）**：不关联科目发消息 → 记入概念本 → 断言弹层内科目为空、保存按钮禁用、页面出现"请先选择科目后再保存"的可见提示（不静默失败）；在弹层内补选科目 → 节点下拉联动加载 → 保存可用 → 保存成功且 misconceptions.yaml 落盘。

### 4.13 chat-shell.spec.ts —— 对话壳层（顶栏 + 右侧边栏 + 新对话关联行）
1. 顶栏只剩会话标题、内联重命名按钮与折叠按钮：旧顶栏元素（"＋ 新对话"、模型选择器、科目/节点下拉）在主列中数量为 0。
2. **新对话态**：输入区上方出现 `new-session-association` 关联行（`关联科目` + `new-session-workspace`）——见 §4.23。
3. 右侧边栏装载**附件区**与会话信息区（消息数 / 创建时间 / 关联科目）；`关联科目` 下拉与 `生成小结` 按钮在右栏**已不存在**（2026-10-04 移出/悬空）；新对话态右栏**默认折叠**，断言前先展开。
4. 折叠：点击后用**宽度判据**断言收起（内容根宽度归零），并断言 `aria-hidden="true"` 与 `inert` 存在、内容未卸载；再点 → 复原。不要用 `toBeHidden()`——它判的是"可见性"，对宽度过渡的面板不可靠（v1.3 踩过）。
5. 右侧边栏拖拽调宽：拖手柄 → 宽度增大并写入各自的 localStorage 键；刷新后保留（宽度全局持久化；**折叠态只对已有会话持久化**，新对话刷新后仍回默认折叠，断言前需再展开）；拖过下限被钳制。
6. 关联科目并产生消息后，会话信息区的科目与消息数随会话更新；**已有会话不再出现关联行**（count 0）。

### 4.14 chat-draft.spec.ts —— 输入框草稿按会话缓存
1. 在新会话输入草稿 → 切到历史会话 → 输入框为空；切回新会话 → 草稿仍在。
2. 历史会话输入另一段草稿 → 两个槽互不串。
3. 发送后只清当前会话的草稿，新会话槽的草稿不受影响。
（刷新归空为预期行为，不做持久化，因此不写"刷新后保留"的断言。）

### 4.15 sidebar-resize.spec.ts —— 侧边栏拖拽调宽
1. 默认宽度为初始值 → 向右拖 → 宽度增大且写入 localStorage。
2. reload 后宽度保留。
3. 大幅向右 / 向左拖 → 宽度被钳制在上下限内，reload 后保留；右栏宽度断言前先展开（新对话默认折叠）。
（`/chat` 页上有两个可拖拽面板：左栏是唯一的 `<aside>`，右栏用 `div[role=complementary]`，故用拖拽手柄的祖先元素锁定左侧栏。）

### 4.16 settings-models.spec.ts —— 模型行四操作与推理档位
1. 自建自定义提供商（用例尾部删净）→ "＋ 添加模型"打开模型编辑弹窗。
2. 基础区填模型 ID / 显示名 / **最大输出 Token** / 上下文窗口，**模态用复选框**勾"图片"（并断言不存在模态 combobox）→ 保存模型。
3. **实时生效**：提供商改动不需要点"保存"（该按钮已移除），只读摘要行立即出现上下文窗口徽标 `1M`、模态徽标、`思考 · <档位>`；显示名回退规则生效。
4. 模型行四个操作可见：测试 / 编辑 / 删除 / 启用开关；编辑可重新打开弹窗并回填当前值。
5. API Key：输入框**回填已存密钥**（`type=password`、值非空、无旧占位符）→ 点"显示密钥"变 `type=text` → 点"隐藏密钥"变回；清空输入框后模型行"测试"仍能回落已存 Key。
6. **高级折叠区**：展开后编辑**推理档位 chip 列表**（增 / 删 / 改名 / 排序）与默认档位；**启用推理时默认预置 `disabled / enabled` 两档、默认档位取最高档**；能力声明剩两个开关（JSON Schema 输出 / 原生联网搜索），「工具调用（Agent 循环，默认开启）」为只读提示。
7. 对话侧：**输入区工具条上的「切换推理档位」下拉**（`reasoning-variant-selector`）——模型弹层里已无档位 chip；打开下拉 → 当前项 `aria-pressed` → 选另一档 → 触发按钮文案更新 → `page.reload()` 后仍保持（验证落盘）。点击前先点空白处收起模型弹层（它的 fixed 遮罩会挡住下拉）。
（下拉一律用 `getByRole("combobox")` 定位；`<select>` 嵌在 `<label>` 内时其可访问名会带上选项文本，`getByLabel` + `exact` 匹配不到。**模态与能力开关是 `role="checkbox"` 的按钮**，用 `getByRole("checkbox", { name: "图片" })` 之类定位。）

### 4.17 courses.spec.ts 扩展 —— 课程页（右栏分段切换 + 科目总览）
1. `/courses?subject=computer-networks` 打开 → 主区显示"点击节点查看详情"空态；右栏默认显示**图谱**（`course-outline` 为 hidden、`graph-node-*` 已挂载）。
2. 画布存在（cytoscape 铺 3 层 canvas）；折叠右栏 → 宽度归零、`aria-hidden`、sr-only 节点按钮仍挂载；展开 → 点「大纲」段 → 大纲行可见、点行后节点详情在主区出现。
3. 点回「图谱」段 → **画布是同一份**（在 canvas 上打的标记仍在、层数不变），sr-only 节点按钮仍能选中节点（`graph-node-<id>` + `dispatchEvent("click")`——画布节点不能用坐标点击）。
4. **科目总览**：头部 `subject-status` 显示当前状态与"进度 n/n · 平均掌握度 x%"；改成"暂停"后用 API 核对 `subject.yaml` 的 status，随后还原。
5. **侧边栏科目选中态**：`/courses?subject=…` 下左侧边栏对应科目行带 `aria-current="page"`，点子边栏另一科目后选中态随之迁移。
（大纲行断言前先点 `rail-view-outline`；详情用 `data-testid="course-node-detail"`。）

### 4.6 assessment.spec.ts —— 已删除（评估改由 agent 工具，见 §4.28）

2026-10-04 第八轮：节点详情页「申请评估」块删除，评估改为会话 agent 工具 `assess_node`。原 `assessment.spec.ts` 删除，评估链路由新用例 `assess-tool.spec.ts`（§4.28）承接；实验课联升与学习记录落盘仍由后端 pytest（评估服务）覆盖。

### 4.7 progress-transition.spec.ts —— 状态流转（对应"保守推进"）
1. 选一个"未开始"节点 → 详情状态区只显示合法流转项"学习中"（不显示"已通过项目验证"等）。
2. 点"学习中" → 徽标更新、合法项刷新为"初步理解/需要复习"。
3. 掌握度滑杆拉到 100% + 笔记输入 → 保存 → "已保存"反馈；数据层核对 progress.yaml 的 status/mastery/notes。
4. （状态机 409 由 API 层测试保证，UI 只验证合法项渲染。）

### 4.8 session-summary.spec.ts —— 会话小结（**已悬空**）
1. 2026-10-04 拍板：右栏「生成小结」入口随「会话关联」整段移除，本用例改 `test.skip(true, …)` **挂起**（后端端点、`api.generateSessionSummary`、fixture 的 `memory_updates` 都保留）。
2. 原流程（保留供接回后恢复）：关联科目 → 发一轮消息 → 按钮点亮 → 点击 → 落 `sessions/<日期>.md` → 同日第二次追加"本场摘要（HH:MM）"分段 → 小结结果区的记忆建议预填弹窗。
3. 恢复办法：把入口接回输入区工具条或消息操作条，删掉 `test.skip` 那行即可。

### 4.9 misconceptions.spec.ts 扩展 —— 筛选与编辑（对应"误解双落点"）
在现有新建/删除基础上追加：
1. 预置三条不同 importance 的条目（UI 新建）→ importance chips 逐个过滤 → 列表数量与内容正确；"全部"恢复。
2. 节点筛选下拉按节点过滤。
3. 编辑某条 → 改 importance 与 follow_up → 保存 → 卡片更新 → 数据层核对 progress.yaml 与 misconceptions.yaml 两处一致。

### 4.10 subject-switch.spec.ts —— 多科目切换（对应"多科目管理"）
1. `/courses` 默认显示第一个科目 → 侧边栏点另一科目 → 图谱与详情重建、选中态更新。
2. 侧边栏科目项点击 → URL `?subject=` 变化 → 图谱对应。
3. 顶栏科目下拉在 /chat 切换科目后，节点下拉随之刷新。

### 4.11 export.spec.ts —— 静态导出（对应"静态产物互通"）
1. `/courses` 选中科目 → 点"导出静态工作区"（真跑 gen_home）。
2. 断言：结果浮层出现 export_dir 绝对路径与页数 ≥ 1；数据层核对 `<data>/exports/<slug>/index.html` 与 `.learning/subjects/<slug>/index.html` 存在。
3. 失败分支（UI route mock 500）：浮层显示错误 detail。

### 4.12 settings-providers.spec.ts 扩展 —— 提供商管理收尾
在现有添加/保存/设为当前基础上追加：
1. 自定义提供商"删除"（confirm）→ 列表消失；active 指向被删项时自动落到首个剩余提供商。
2. 预设"恢复默认"→ 字段重置。
3. "测试连接"：填不可达地址 → 显示错误 detail（fixture 模式下该请求仍真实外呼，用保留地址如 10.255.255.1 断言失败路径，不依赖网络成功）。

### 4.18 settings-workspace.spec.ts —— 工作区设置（对应"工作区"节）
1. `/settings/workspace` 渲染当前路径（= e2e 工作区）、来源（= 配置文件发现）、科目数下界、输入框回填；fs 核对 e2e 配置文件的 `workspace` 键。
2. 改选到 `e2e-data/workspace-probe`（目录尚不存在）→ 成功条、路径回显、科目数 `0 门`、配置文件已更新；`finally` 无条件恢复原路径并断言全部还原（同轮后续用例仍跑在 e2e-ws 上）。

### 4.19 memory-flow.spec.ts —— 共享记忆写侧（**已悬空**）
1. 2026-10-04 拍板：聊天侧「沉淀记忆」入口随「会话关联」区移除，本文件两条用例改 `test.skip(true, …)` **挂起**（后端 `suggest`/`confirm`、`MemoryDialog.tsx` 都保留）。
2. 原流程（保留供接回后恢复）：无消息时入口禁用 → 发一轮消息后启用 → 模态列 fixture 2 条建议 → 取消勾选一条 → 写入 MEMORY.md 并逐条核对 → 幂等去重；adverse 变体（mock 空建议）断言空态与禁用。
3. 仍被覆盖的部分：**评估通过后的「沉淀记忆」入口**原先在评估结果面板（`assessment.spec.ts`）；第八轮评估改由 agent 工具、结果落在聊天里，该面板随之删除，这条入口暂**无 E2E 覆盖**（后端 `suggest`/`confirm` 仍在，`memory-flow.spec.ts` 挂起）。

### 4.20 attachments-area.spec.ts —— 附件区（对应"附件区入口"）
1. 未关联科目时右栏无附件区；关联 computer-networks 后**先展开右栏**（新对话默认折叠）→ 出现「术语表」组（e2e 科目目录带 `GLOSSARY.md`）。
2. 术语表链接 `target="_blank"` 且 href 指向 `/api/courses/<slug>/files/GLOSSARY.md`；`request` GET 该链接返回 200 且正文含科目名与分节标题（原文可读）。
3. `reference/` 为空 → 该组不渲染；切到只有 yaml 的 linear-algebra → 空态文案；切回恢复。

### 4.21 workspace-onboarding.spec.ts —— 新对话关联行的工作区（原"新会话选工作区"）
1. `/chat` 关联行可见；`new-session-workspace` 默认值为空（= 用当前默认工作区），首项文案「默认工作区」，候选里含 fixture 工作区绝对路径；科目下拉含 `计算机网络`。
2. `try` 内用 `request` PUT 把工作区切到 `e2e-data/empty-ws` → `page.reload()` → 关联行仍在、左侧边栏显示"暂无科目"（科目列表随工作区为空）。
3. `finally` 无条件 PUT 恢复原工作区（避免污染同轮其他用例）。
（原「欢迎区引导块」已随 2026-10-04 拍板移除，本文件随之改写；`WorkspaceOnboarding.tsx` 目前无引用。）

### 4.22 tool-cards.spec.ts —— 工具化 chat 的工具卡（对应"工具化调用"，2026-10-04 v2.4 改写）
1. `page.route` 拦截 `/api/chat/stream`，把请求体补上 `fixture_scenario: "tools"`（fixture 模式下 chat 由此走 canned 工具脚本，不在生产 UI 上开入口）。
2. 关联 computer-networks → 发送一条消息 → 等流式结束。
3. **工具卡常显在消息体**（v2.4 起移出「中间过程」折叠区，无需展开任何折叠区）：断言两张工具卡（`tool-card`：`list_workspace` + `read_course_file`）且首张可见；展开首卡的 `summary` → `tool-result` 可见。
4. 因 `tools` 场景既无思维链也无提示，**`process-panel` 整块不渲染**（`toHaveCount(0)`，不留空面板）。
5. 断言工具轮之后的最终答复文本出现（fixture 脚本末段）。

> 产课/评估动作工具（`produce_lesson` / `assess_node`）的旅程级用例见 §4.27 / §4.28；建课工具循环 `submit_curriculum`、产课链内 `write_deliver_file` / `run_check` 仍在 fixture 模式下走单次派工，行为由后端 `test_tooling.py` / `test_chat_tools.py` 以 monkeypatch 的假 turn source 覆盖（真实门禁/渲染器/评估服务仍真跑）。

### 4.23 new-session-association.spec.ts —— 新对话关联行与会话级工作区（对应"工作区"节，2026-10-04 新增）
1. `/chat` 新对话态：`new-session-association` 可见；`new-session-workspace` 默认值为空（首项「默认工作区」）、候选里含 fixture 工作区绝对路径；科目下拉含 `计算机网络`。
2. 用关联行把工作区显式选到 `E2E_WORKSPACE_DIR` → 科目下拉按该工作区重载（`计算机网络` 仍在；选 workspace 会重置此前的科目关联）。
3. 选科目 `computer-networks` → 发送一条消息 → 用 `request` 拉会话：`workspace` 等于所选工作区（大小写不敏感比较）、`subject_slug` 为 `computer-networks`（会话级绑定真的落盘）。
4. 成为正式会话后 `new-session-association` 数量归 0（关联行只在新对话态存在）。

### 4.24 sidebar-collapse.spec.ts —— 左侧边栏折叠成图标轨（2026-10-04 新增）
1. 默认展开（宽度 = 默认值）→ 点「折叠侧边栏」→ 宽度变 **60px**。
2. `reload` 后仍是 60px（折叠态持久化在 localStorage）。
3. 点「展开侧边栏」→ 回到默认宽度。

### 4.25 message-actions.spec.ts —— 助手名称栏 / 上下文窗口 / 中间过程折叠 / 消息操作（2026-10-04 新增）
1. **名称栏 + 上下文窗口**：发一条消息后，`assistant-name` 显示「DeepSeek / deepseek-chat」（fixture settings 的当前使用项）；右栏 `context-window-model` 同值，`context-window-usage` 含 `11.5k` 与 `%`（用量来自 SSE `usage` 事件，分母取模型上下文长度、未声明时用兜底默认值），`context-window-bar` 可见。
2. **中间过程折叠**：路由改写 `fixture_scenario=process`（`FIXTURE_TOOL_SCRIPTS["process"]`：思维链 + list_workspace + read_course_file + 结论）。断言 `process-panel` 存在且**默认收起**（无 `open` 属性、`process-reasoning` 隐藏）；**工具卡常显在消息体外**（不用展开折叠区就能看到两张 `tool-card`）；点 `process-summary` 后 `open` 属性出现、思维链正文可见（工具卡不受影响）。
3. **编辑用户消息**：两轮对话（4 条）→ 悬停首条用户消息点 `user-message-edit` → `message-edit-box` 就地出现 → 改文后 `message-edit-submit` → 新文本可见、消息数回到 2 条、被顶掉的整轮文本归 0（服务端 `replace_from` 真的截断）。
4. **编辑保留原附件**：带 `note.txt` 发送 → 编辑时 `message-edit-attachment` 含 `note.txt` → 点其「移除」后 chip 归 0 → 取消编辑回到读数态。
5. **删除整轮**：`turn-delete` → `turn-delete-confirm` 内联确认 → 点确认后消息数 0、正文归 0（用户提问与助手回复成对删）。

> 说明：`<details>` 的"收起"断言不用 `toBeHidden()` 直接打整组（多个匹配会触发 strict violation），改用 `toHaveAttribute("open", "")` 与单元素可见性断言；正文文本断言一律限定在 `chat-messages` 内（会话标题会与消息正文撞词）。

### 4.26 session-model.spec.ts —— 会话级模型与档位（对应"模型快捷切换"节，2026-10-04 新增）
1. **会话内切换只绑本会话**：发一条消息成为正式会话 → 切到 `SiliconFlow / deepseek-ai/DeepSeek-V3` → 计数断言 `PATCH /api/sessions/<id>` ≥1 且 `PUT /api/settings` = 0；`GET /api/settings` 的 active 保持原值；`GET /api/sessions/<id>` 的 `active` 三元组等于所选。
2. **后端确实用绑定模型跑这一轮**：直接 `POST /api/chat/stream`（fixture 模式不外呼，因此"绑到没 key 的提供商"也能验）→ 该会话最后一条助手消息的 `model` 是 `SiliconFlow / deepseek-ai/DeepSeek-V3`。
3. **持久化**：`reload` 后从左侧边栏重开该会话 → 模型选择器仍显示硅基流动；绑到没配 key 的提供商时输入框如实禁用（`hasKey` 也按生效三元组算）。
4. **新对话态仍写全局默认**：新对话态切到 `DashScope / qwen-plus` → `PUT /api/settings` ≥1 且无会话可 PATCH；用例收尾把全局默认改回 DeepSeek，避免影响后续 settings-* 用例。

### 4.27 produce-tool.spec.ts —— 会话 agent 工具产课（对应"产课（三件套）"，2026-10-04 第八轮新增）
1. `page.route` 改写 `fixture_scenario=produce`（`FIXTURE_TOOL_SCRIPTS["produce"]`：`produce_lesson(net.layers)` → 收尾文本）。
2. `/chat` 关联 `computer-networks` → 发「产出第一课」。
3. 断言：**工具卡常显在消息体**（`tool-card` 含 `produce_lesson`，非折在 panel 里）；收尾答复「已产出这一课」可见。
4. 数据层：会话列表里该会话 `subject_slug=computer-networks`；拉会话 JSON，助手消息 `tools[]` 里有 `produce_lesson` 且 `isError=false`（工具真跑通）。

### 4.28 assess-tool.spec.ts —— 会话 agent 工具评估（对应"评估点（证据>口头）"，2026-10-04 第八轮新增）
1. `page.route` 改写 `fixture_scenario=assess`（`FIXTURE_TOOL_SCRIPTS["assess"]`：`assess_node(net.layers, evidence)` → 收尾文本）。
2. `/chat` 关联 `computer-networks` → 发「帮我评估一下这一节」。
3. 断言：`tool-card` 含 `assess_node`、收尾文本「评估完成」可见。
4. 数据层：会话消息 `tools[]` 的 `assess_node` 非错误且结果含「判定」；`GET /api/courses/<slug>/records` 的 `assessments` 含 `net.layers`（评估记录真落盘）。

### 4.29 courses-home-embed.spec.ts —— 「我的课程」首页（对应"节点详情与大纲 / 我的课程"，2026-10-04 第八轮新增）
1. `/courses`（不带参数）→ `home-embed` iframe 可见、`title="我的课程"`；`course-graph-rail` / `course-outline` / `course-node-detail` 数量均为 0（不渲染经营视图）。
2. `/courses?subject=computer-networks` → `course-graph-rail` 可见、`graph-node-net.layers` 已挂载、`home-embed` 数量 0（带科目仍是原课程页）。
（空工作区优先显示「还没有科目…」提示，fixture 有种子科目故覆盖不到。）

### 4.30 chat-subject-graph.spec.ts —— 聊天右栏科目图谱区（2026-10-04 第八轮新增）
1. `/chat` 展开右栏 → 关联 `computer-networks` → 发一条消息。
2. 从会话列表重新打开该会话（验证关联从**落库的会话元数据**恢复，非新对话态的本地选择）→ 展开右栏。
3. 断言 `subject-graph-section` 可见、右栏默认**大纲**视图（`course-outline` 可见、`outline-node-net.layers` 可见）。
4. 点 `outline-node-net.layers` → URL 变 `/courses?subject=computer-networks&node=net.layers`（跳课程页定位）。

---

## 5. 运行与维护约定

- 顺序敏感：`workers: 1` + 文件名字母序（chat 用例先于 settings-providers，后者会把 active 切到无 key 的"我的中转"；`sidebar-resize` 排在 settings-* 之后）；globalSetup 每轮重建工作区与 settings，保证幂等。本轮 **62 条通过 + 3 条 skip**（`memory-flow` 2 + `session-summary` 1，悬空占位）**0 失败**（新增与改写的用例先单独跑绿，再跑单轮全量）。
- 新增用例命名沿用旅程语义（`<旅程>.spec.ts`），归入第 3 节映射表并保持表格与文件一致。
- 逆向前置状态：新入口用例除 happy path 外，须为关键入口补 adverse 前置变体（无科目对话、已填 key 的测试连接、空模型列表等）；组合爆炸的分支下沉组件测试（第 2 节 P4），不堆在旅程级。
- 入口载荷断言：凡"用户输入 → 请求"的入口（测试连接、模型切换、概念本 prefill），必须有一条 `page.route` 载荷断言，防止字段被前端静默丢弃（第 2 节 P1）。
- fixture 扩展规则：canned 内容必须通过真实解析链路（判分 JSON 过 extract_json、评估/小结过 front matter + schema、大纲过 check_curriculum）；需要新的失败分支时优先用 UI route mock，不为单一分支扩建 fixture。
- **真实 LLM 冒烟（2026-10-03 已做，方法留在档）**：维护者本机已配 my-api（本机 new-api 中转 `http://localhost:4000/v1`）。冒烟**不走 Playwright**，是进程内脚本：隔离 `STUDYMATE_DATA_DIR`/`STUDYMATE_WORKSPACE` + 拷贝 settings 并**自己钉死模型**（live settings 会被 UI 改掉）+ TestClient 打真实端点。三条生产链（判分/评估/课件产出）各跑一遍；口径：渠道**串行不并发**，参评模型均带思考档位。已验证：判分与评估一次通过；产出链全机制走通、两参评模型最终都转质检工单（检查器比模型严格，转人工是常态）。
  - 坑一：**TestClient 的 ASGI 传输不增量吐 SSE**——整条编排响应跑完才一次性交付，进程内冒烟看不到阶段进度；要看进度得起真 uvicorn，或在途状态看磁盘产物与 `Get-NetTCPConnection`。
  - 坑二：E2E fixture 探针只测 `data` 形状会漏 `files[]` 契约——产出链的真实风险在 files（畸形 envelope）。
  - 坑三：**Windows 注册表系统代理会经手本机网关**（httpx 经 urllib 读注册表），本机 base_url 已在 `llm.py` 挂精确 host 直连 mounts；换机器复现冒烟若遇长流中断先查这条。
- 长期目标：把上面的真实冒烟固化成 `SMOKE_REAL_LLM=1` 门控的 Playwright project（默认跳过、skip 注明原因），沿用 DeepTutor 的"环境门"模式。

### 5.1 实现偏差备注（以实际代码为准，2026-10-02 落地时修正）

1. §4.28 状态机路径：`TRANSITIONS["学习中"]` 只到 初步理解/需要复习，评估推进到"能独立应用"（原 `assessment.spec` 实测，改用例后行为不变）。
2. fixture assess 的整体 verdict 取"通过"（部分通过会让 progress_updated 恒为 false，状态机链路不可测）；逐题 verdict 不变，schema 各自独立。
3. globalSetup 往 e2e 副本的 0001-net.layers.html 注入一个双选择题题组（quiz.js 仅在组内选择题 >1 时渲染"本题组：答对 N/M"；examples 源未动）。
4. §4.3 "下一节"断言的是 iframe URL 变为 0002 + iframe 内 h1 变化（LessonView 顶栏标题跟随查询参数，不随 iframe 内导航变）。
5. §4.12 测试连接：fixture 模式下请求并不外呼——无 Key 走真实 422，可达性失败用 UI route mock 502。
6. §4.4 重提交断言"结果块原地替换"（fixture 判分内容固定，无法断言内容差异）。
7. §4.8 落盘日期由后端 `today()` 覆盖，UI 按动态日期正则断言。
8. §4.12 删除最后一个自定义提供商后视图自动重选首个剩余提供商（非空态）。
9. 向导入口文案为"不想手填？用 AI 向导生成科目 →"；向导生成的 slug 形如 `subject-<6位hex>`（正则断言）。
10. 会话标题的定位由结构选择器 `div.border-b.px-5.py-3 > span` 改为 `getByTestId("chat-title")`——顶栏结构在 2026-10-02 的壳层改造后不再稳定。
11. 顶栏"＋ 新对话"已移除，切新会话改走侧边栏的"新对话"入口（`getByTitle("新对话")`）。
12. 概念本**顶部筛选栏**的科目下拉标签由「科目」改为「学科」：弹层内新增了必填的「科目」字段，而 Playwright 的 `getByLabel` 是子串匹配，两者会撞名。
13. 原生 `<select>` 一律用 `getByRole("combobox")` 定位；模型编辑弹窗与概念本弹窗内的下拉补了显式 `aria-label`（嵌在 `<label>` 里时，可访问名会把选项文本算进去，`getByLabel` + `exact` 匹配不到）。
14. 模型行的"测试"与底部"测试连接"都按编辑器当前表单值发起；fixture 模式下无 Key 走真实 422，"清空输入框回落已存 Key"用带占位 key 的 DeepSeek 断言。
15. **可折叠面板不要用 `toBeHidden()` 断言收起**（2026-10-03 已把 `chat-shell.spec.ts` 的旧写法一并改为宽度判据）：v1.3 右侧边栏用宽度过渡折叠，元素仍在（只是宽度归零），`toBeHidden()` 会误判为"可见"。改用宽度判据（`boundingBox()` 宽度为 0）+ `aria-hidden` / `inert` 属性断言。这一条同时抓出过一个真 bug（最初只加了 `inert` 属性、宽度没参与计算，折叠在视觉上根本没发生）。
16. 右侧边栏根元素是 `div[role="complementary"]` 而不是 `<aside>`，与左侧主侧边栏区分；因此"页面上只有一个 `aside`"的既有写法仍然成立（`/courses` 上 `page.locator("aside")` 不会再双匹配）。
17. 模型编辑弹窗的模态与能力开关是 `role="checkbox"` 的按钮（对齐 ZCode 的多选语义），不是原生 checkbox；推理档位是 chip 列表编辑器，定位用 `data-reasoning-variant-input` 之类的稳定锚点而不是结构选择器。
18. **评估用例要自己恢复现场**：评估会写 `progress.yaml`（置位）并落 `assessments/`、`learning-records/`，还会经双落点新写 `misconceptions.yaml`（canonical 源优先于 progress）——实验课用例还会把 `prerequisites` 一起置位，字母序在后的 `progress-transition` 会读到被污染的初始状态（曾因此挂掉）。两条评估用例都在 `try/finally` 里备份/还原 `progress.yaml` 与 `misconceptions.yaml` 并删除本轮新增的落盘文件。
19. **Windows 落盘是 CRLF**：断言 YAML 文本时正则要写 `\r?\n`（`\n` 匹配不上）；宽松模式（`[\s\S]*?`）天然不受影响，但严格逐行的断言要留意。
20. **`status` 未必是节点条目的第一个键**：既有条目保留在前，联升只是补写 status——断言按"该节点的直属子键行"匹配（`(?:\s{4}[\w-]+:.*\r?\n)*?\s{4}status: …`），不要写死 `节点:\n  status`。
21. **前端"加载完成回填输入框"要与用户输入竞争**：`WorkspaceView` 的 `load()` 曾在每次完成后 `setInput(data.path)`，dev 下并发/StrictMode 会覆盖用户刚填的路径，导致"保存的是旧值"——E2E 表现为成功条不出现（后端收到的是原路径）。修法是回填只做一次；新增同类页面时按此约定。
22. **fixture 配置要在 config 加载时写好**：Playwright 的 webServer 早于 globalSetup 启动，后端"启动即发现工作区"并缓存整轮——配置若只靠 globalSetup 落盘，首轮后端会回落到真实 `~/StudyMate`。`ensureWorkspaceConfig()` 即为此。
23. **`reuseExistingServer` 的复用陷阱**：8290 上若残留旧 env 的进程，会静音复用并让整轮跑在错误的数据目录里（本轮"丢失 `STUDYMATE_DATA_DIR`"就是这样被掩盖过一阵）。**2026-10-03 起两份配置统一 `reuseExistingServer: false`**——端口被占用时直接启动失败，比静默探索错误世界好；排查失败时先确认这两个端口没有陈旧进程。
24. **真实 LLM 工具循环冒烟已固化为门控用例**（2026-10-04）：`backend/tests/test_smoke_real_llm.py`，`SMOKE_REAL_LLM=1` 才跑（默认 skip 并注明原因）。它真连开发 settings 里带 key 的活跃渠道，验"tools 声明 → tool_call 聚合 → 工具执行 → 结果回喂 → 最终答复"，`SMOKE_MODEL` 可钉死模型、`SMOKE_SETTINGS` 可换设置路径。注意它会 monkeypatch 关掉 `STUDYMATE_E2E_FIXTURE`（否则 `stream_turn` 直接吐 canned 文本），并直接按绝对路径读开发 settings（隔离 DATA_DIR 里没有提供商）。
