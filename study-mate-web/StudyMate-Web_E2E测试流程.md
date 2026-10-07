# StudyMate Web E2E 测试流程

> 版本：v3.0（2026-10-06，本轮错误终态 / 检查器 / lab 修复定稿）
> 性质：测试流程文档——描述 E2E 用例如何映射上游插件的用户使用旅程（docs/使用/使用说明.md、docs/设计/设计方案.md），以及每条用例的步骤、断言与数据准备；不含测试代码。
> 运行方式：`cd frontend && npm run test:e2e`（Playwright 自动拉起后端 8290 [fixture 模式] + 前端 dev 3810）。
> 维护约定：新增/修改用户可见功能时，对照第 3 节的映射表补充或调整用例；本文与 `tests/e2e/` 同步演进。
>
> **上一轮口径（v2.8，2026-10-05 第一轮定稿）**：E2E **88 = 85 pass + 3 skip（0 失败）**（skip = `memory-flow` 2 + `session-summary` 1，属第三批保留的悬空入口），其中渲染矩阵 **8 = 4 × 2（light / dark）**；后端 pytest **408 pass + 1 skip**（唯一 skip = `test_smoke_real_llm.py::test_tool_loop_against_real_provider`，`SMOKE_REAL_LLM!=1` 门控）；组件测试 **98 pass（14 文件）**；CI smoke **5 pass**（非全量）；lint 为真实 ESLint **0 errors / 51 warnings、exit 0**（**51 warnings 保留待后续，不称零警告**）；`tsc` / `build` / `compileall` / `import` / 根 `npm test` 全部 **exit 0**。E2E / 探索构建目录已分离（`STUDYMATE_NEXT_DIST`：E2E `.next-e2e`、探索 `.next-explorer`，与 `npm run dev` 默认 `.next` 互不冲突）——**是目录级隔离，不是完全文件副本隔离**；后端 webServer 命令由 `tests/e2e/constants.ts` 的 `BACKEND_PYTHON` 按平台给出。
> 版本沿革：v1.1–v2.6 逐轮改动（用例数 25 → 68 的演进、分层与运行时路径口径、会话级模型与档位、工具化调用、消息操作与中间过程折叠、工作区与会话绑定等）全部留痕于 `Web_CHANGE.md`，本文只保留当前口径与仍生效的约定。
> **当前口径（v2.9，2026-10-06 本轮定稿）**：E2E **91 = 88 passed + 0 failed + 3 skipped**（skip = `memory-flow` 2 + `session-summary` 1，属第三批保留的悬空入口），其中渲染矩阵 **8 = 4 × 2（light / dark）**；后端 pytest **452 passed + 1 skipped**（唯一 skip = 真实 LLM 未启用）；组件测试 **113 passed（15 文件）**；CI smoke **5 passed**（非全量）；lint **0 errors / 51 warnings**；`tsc` / `build` / `compileall` / `import` / 根 `npm test` **全部通过**；**两项独立复审全部无阻塞**。
> **2026-10-05 决策轮（v2.6）增量**：并发拒绝（R2/R8，独立 review F1–F5 ACCEPT）与用户消息 `display_content`（R7）落地，**APP 侧源码冻结**；E2E 新增 `display-content.spec.ts`（**2 条**，全 fixture：附件提取文本不进历史气泡 / 编辑框；附件-only 空文本刷新 + 编辑重发），已计入上方口径（**70 = 67 pass + 3 skip，0 失败**）。
> **2026-10-05 本轮（最小工程化 / legacy 工单恢复）**：配置（CI）/ 后端工单（tickets）/ 前端均已交付。**验证员定稿**：全 E2E **72 = 69 pass + 3 skip（0 失败）**、后端 pytest **285 + 1 skip**（含 P1 修复）；组件新 `LegacyTicketRecovery`（7）；E2E 新增 `legacy-ticket-recovery`（2 条）；旧 inspection seed 补 `workspace`。根 `.github/workflows/` 新增**独立 web-ci**（Node24 / Py3.13：pytest / compileall / lint / component / build + **5 条 E2E smoke**）——**CI 只跑这 5 条 smoke，不是 full E2E 回归**，**原根 CI 不动**，**远端未 push / 执行前不写通过结果**。
> **2026-10-05 修复轮（v2.7 增量，已定稿）**：会话流生命周期与有序工具卡修复已收口。最终门禁（**唯一隔离副本 · 端口 13810 / 18290**）：E2E 全量 **77 = 74 pass + 3 skip**（skip = `memory-flow` 2 + `session-summary` 1 悬空占位）、组件 **85 pass（13 文件）**、后端 **309 pass + 1 skip**（唯一 skip = 真实模型未启用）、lint **0 error / 51 warnings**、`tsc` / `build` / `compileall` / `import` / 根 `npm test` 通过；负对照：旧「切走即停止」实现 **2 fail**、还原后 **2 pass**。**最终源码快照与 live 逐字节一致**（仅副本 4 个端口文件刻意差异）；**生产服务仍未重启、未写在用 `.next`（未重构建）**——源码已改但运行中旧生产实例未部署。上方 v2.7 口径为其之前的快照。
> **2026-10-05 第一轮（决策轮之后）已完成定稿**：新增 `production-task.spec.ts`（**3 条**：任务卡 `task_update` 原位更新 / 结果透传 / 系统状态兜底），渲染矩阵 **`rendering` 4 条 × 2 主题（light / dark）= 8**（含在 E2E 总数内）；`produce-tool.spec.ts` 旧断言已更新为实际接线（`submit_curriculum` / `write_deliver_file` / `run_check`）；含"模型输出『我认为通过』界面仍显示 **failed**"（系统 assessment 真实状态兜底）。**最终 skip / 总数见上方当前口径**；CI / lock **远端未 push / 未在 GitHub 执行**（待授权），**不写远端通过**。本轮 backlog 分组（延期 / 等待外部验证 / 完成索引）见[开发与计划](StudyMate-Web_开发与计划.md) §5。
> **2026-10-06 本轮（讲解失败事故修复，已定稿）**：新增 `produce-selection.spec.ts`（**3 条** = **1 条真实 fixture** + **2 条 UI-only 回放：done / error**）——覆盖**默认节点选择**（不传 `node_id` = 按大纲顺序第一个尚无课件的节点，**不沿用会话节点聚焦**）与**备用单次派工回落落库回放**（`execution_mode=fallback` + `fallback_reason` / `max_seconds` / `elapsed_s` / `message`，按真实 start / done / error，**envelope 返回≠自检通过**）；**既有产物复用 / `regenerate` 严格条件在后端已落地**（无新文件 + `regenerate=false` + ctx `check_passed` + required 目标存在可读非空 → 接受复用；`regenerate=true` 须显式 `node_id` + **bool 严格校验**；**非 UTF-8 不复用**；强制重做与工单 retry 禁复用），**但 E2E mock 仅测 fallback 落库回放，不测该复用机制**；**无需新增产品按钮**。**两初红已修**：① 旧 `production-task` 的 done「当前阶段」断言改为「无当前阶段」+ history 渲染检查；② 新 `produce-selection` 原用 md 占位触发真实 check 错误（**真实复现「编号 0002 应为 0001…不能跳号」**），改用**真实 HTTP 先完整产首课（HTML / quiz）再产第二课**。**全量最终绿（91 = 88 pass + 0 failed + 3 skip）。** 上方 v2.8 口径属上一轮历史。
> **2026-10-06 本轮（错误终态 / 检查器 / lab 修复，已定稿并部署）**：新增 `chat-errors.spec.ts`（**7 条**：`partial503` / `empty503` / HTTP 503 / 正常正文含「503」不报错 / 手动停止 neutral / `unexpected_eof` / `transport_error`），覆盖 `ErrorInfo` 平铺、`stream_state=error` 落库与刷新重放、`ErrorNotice` 色调与详情展开、**停止按轮不误判 user_stop**；`production-task` / `produce-selection` 保持。**当前口径（v3.0）**：E2E **98 = 95 passed + 0 failed + 3 skipped**；后端 **474 passed + 1 skipped**；组件 **119 passed（16 文件）**；`build` / `lint` / 根 `npm test` 通过；`chat-errors` **7/7**。**两真实重产（浏览器 UI 编辑重发）均上游 503 失败，不声称成功**；**独立完整复审未完成**（代理 provider 反复失败）。上方 v2.9 口径属上一轮历史。

---

## 1. 分层策略

沿用两层设计（对照 DeepTutor 的分层）：

- **后端 fixture 层**（主力）：`STUDYMATE_E2E_FIXTURE=1` 时 LLM 调用返回确定性内容（流式分段文本、判分/评估/小结/科目生成的 canned 输出，全部经过真实解析链路验证）。SSE 流转、会话持久化、状态机、附件移动、门禁脚本全部走真实链路——测的是"真后端 + 真前端"的聚合行为。chat 与判分等 `fixture_kind` 见 `backend/app/llm.py`。
- **UI route mock 层**（补充分支）：仅当需要测"上游失败/校验拒绝"这类 fixture 不便复现的分支时，用 `page.route` 拦截单个接口返回错误响应（如科目生成被门禁 422 的 problems 展示）。拦截必须局部、测试结束即恢复，不得覆盖整页数据。

数据隔离：globalSetup 每轮重建 `study-mate-web/data/e2e-ws`（种子科目 yaml + examples 的 lessons/assets）与 `study-mate-web/data/e2e-data`（settings/sessions/uploads/exports），真实开发数据零污染。fixture 工作区 settings 中 DeepSeek 带占位 key 保证输入可用。

**路径口径（三处必须一致，2026-10-02 修）**：E2E 的运行时根目录是 `<study-mate-web>/data/`，由 `backend/app/config.py`（`WEB_ROOT`/`DATA_DIR`）、`frontend/playwright.config.ts`（`E2E_WORKSPACE`/`E2E_DATA_DIR`）、`frontend/tests/e2e/global-setup.ts`（落盘）与 `frontend/tests/e2e/constants.ts`（用例回读）四处共同约定。此前 `playwright.config.ts` 与 `constants.ts` 各自少算/多算一级，指向了仓库根的 `data/`，导致后端读到陈旧 fixture（无 key、无 lessons）而大面积失败；且因 `reuseExistingServer` 会复用手工启动的正确服务，这个错误长期不可见。**改动运行时目录时，这四处要一起改。**

第三层「探索 agent」（`frontend/tests/explorer/`，LLM 驱动浏览器模拟用户）是**发现层**：按需触发、不设门禁，用法另见 [探索测试指南](docs/StudyMate-Web_探索测试指南.md)；第 2 节 P1–P5 补强计划与其共享结论——探索发现的问题，毕业去向是脚本用例、组件测试或设计验收。

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
- **P3 渲染矩阵**：playwright 配置加 `colorScheme` 矩阵跑 2~3 个关键页面；对 native `<select>` 暗色 option 颜色等已知雷区做定向 `toHaveCSS`。**不做**全页截图基线——那会把旅程级 E2E 变成视觉回归，与第 1 节分层冲突。**已落地（2026-10-05）**：`rendering.spec.ts` **4 条 × 2 主题（light / dark）= 8**，关键雷区定向断言（8 条含在 E2E 总数内）。
- **P4 组件测试层**：分支逻辑（空 key、空模型列表、无科目 prefill）下沉 frontend 组件测试，旅程级只保留聚合与落盘断言。**已落地（2026-10-04）**：vitest + Testing Library（jsdom），`npm run test:component`，用例见 `tests/component/`（落地时 13 条，此后随轮次持续扩充，2026-10-05 决策轮 **48 pass（8 文件）**；该层不进根门禁）；选型理由（弃 Playwright CT）与"不进根门禁"口径见 Web_CHANGE 同日条目。**2026-10-05 修复轮新增 `ChatStreamLifecycle.test.tsx`（13 条）** 与 `MessageParts.test.tsx`（9 条，内部标记跨 part 隐藏）；**本轮定稿组件层 98 pass（14 文件）**。
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
| （Web 特有）消息操作与中间过程折叠 | 助手消息名称栏（提供商 / 模型）；用户消息「复制 / 编辑」（编辑=从该条截断并重新生成，原附件可增删）；助手消息「删除本轮」（内联二次确认）；**思维链按片段各自折叠**（默认收起，落库后刷新仍可回放），**工具卡按流位置常显**在消息体、不折进折叠区；右栏「上下文窗口」栏显示最近一轮 prompt tokens 占模型上下文长度的比例 | `message-actions.spec.ts`；截断/删除落库与用量落盘由 pytest `test_message_actions.py` 覆盖 | 已覆盖（2026-10-04；2026-10-05 过程折叠语义改为「思维链片段各自折叠、工具卡按流位置常显」，**计数不变**，本轮已绿） |
| （Web 特有）消息持久化回归（2026-10-05） | 编辑 / 删除后 **reload 仍持久**（唯一 session 与精确临时卡断言） | `review-chat-actions.spec.ts`（2 条） | 已覆盖（2026-10-05） |
| （Web 特有）跨工作区资源与进度（2026-10-05） | 真实 UI：**双工作区同 slug 进度写入 + iframe 嵌套资源**；新草稿采用不误清 | `review-workspace.spec.ts`（1 条） | 已覆盖（2026-10-05） |
| （Web 特有）用户消息展示原文（R7，2026-10-05） | 附件提取文本**不进历史用户气泡 / 编辑框**：`content` 含提取块（送模型用）、`display_content` / 会话标题为原文；刷新重开后气泡只原文、编辑框预填原文；编辑重发后 `content` =「新原文 + 单份附件块」、提取文本不重复；**附件-only 空文本编辑可重发**（刷新后仍可编辑重发） | `display-content.spec.ts`（2 条） | **已覆盖**（2026-10-05；接口契约 + 持久化回归，全 fixture；2 条通过） |
| （Web 特有）旧工单归属恢复（R10，2026-10-05 本轮） | 科目头部质检工单列表**覆盖无 node 单**；`/courses` 默认「我的课程」/ 零科目下也有 **global「待归属」条**并显示原 slug（入口 `include_unscoped=true`）；unknown 弹窗**候选 + 手输、须显式确认**（确认前禁产物读改、无输入不自动选、abandon 仅状态），确认后持久化归属、reload 保持 modal | `legacy-ticket-recovery.spec.ts`（2 条：认领 B 仅 B 可改、A 不变；孤儿放弃产物不变） | **已覆盖**（2026-10-05；2 条通过） |
| （Web 特有）会话流生命周期与有序工具卡（2026-10-05 修复） | 编辑重发后流式中切会话 A→B→A / 离开 `/chat` 再回：本轮**不中断**、完整末段落地（修复前切走即 abort ⇒ 红）；工具卡与正文按 **SSE 到达顺序**交错、tool result 按 `tool_id` 原位 | `chat-stream-lifecycle.spec.ts`（2 条） | **已覆盖**（2026-10-05；全量 E2E 88 = 85 pass + 3 skip） |
| （Web 特有）产课任务卡与系统状态（2026-10-05 本轮） | SSE `task_update`（`id=父 tool`、`task=完整 snapshot`）**原位更新同 `tools[].task`、不追加消息**；任务卡**常显 `stage` / `elapsed`**；`tool_result` 透传 `task` / `lesson` / `assessment`；assessment 系统状态 **`saved` vs `failed`（`background:false`）**；模型输出『我认为通过』仍显示 **failed**；成功后 **Next `Link` 同 tab SPA** 打开绑定 workspace 课件 | `production-task.spec.ts`（3 条） | **已覆盖**（2026-10-05；3 条通过） |
| （Web 特有）产课默认节点与备用派工（2026-10-06 本轮） | `produce_lesson` 不传 `node_id` = **按大纲顺序第一个尚无课件的节点**（不沿用会话节点聚焦）；工具循环未交付回落单次派工时，备用角色标 `execution_mode=fallback` 并展示 `fallback_reason` / `max_seconds` / `elapsed_s` / `message`，按真实 start / done / error；**既有产物复用**需 无新文件 + `regenerate=false` + ctx `check_passed` + required 目标存在可读非空（出题 `*.quiz.json` / 其余 `*.md`），`regenerate=true` 须显式 `node_id` + bool 严格校验、非 UTF-8 不复用、**强制重做与工单 retry 禁复用**（**envelope 返回≠自检通过**；不刷屏、不虚构过程）；**复用机制不以 mock 覆盖** | `produce-selection.spec.ts`（**3 条**：1 真实 fixture + 2 UI-only done / error 回放） | **已覆盖**（2026-10-06；全量绿，含在 E2E 91 总内） |
| （Web 特有）浅 / 暗渲染矩阵（2026-10-05 本轮） | `rendering` 用例在 **light / dark** 两主题下各跑一遍：关键雷区**定向断言**（非全页截图基线） | `rendering.spec.ts`（4 条 × 2 主题 = **8**） | **已覆盖**（2026-10-05；8 条含在 E2E 总数内） |
| （Web 特有）聊天错误面与红色错误详情（2026-10-06 本轮） | 统一 `ErrorInfo`（`code` / `status` / `upstream_code` / `phase` / `summary` / `detail` / `retryable` / `stopped_reason` / `request_id` / `source` / `operation`）；SSE `error` 平铺、HTTP `{detail, error}`、助手消息 `error` + `stream_state=error`（**空正文不过滤**）、刷新可重放；`ErrorNotice` danger 红 / neutral 用户停止 + 展开详情 + 复制诊断；上游缺结束标记判 `upstream_eof` | `chat-errors.spec.ts`（**7 条**：`partial503` / `empty503` / HTTP 503 / 正文含 503 不报错 / 停止 / `unexpected_eof` / `transport_error`） | **已覆盖**（2026-10-06；7/7，含在 E2E 98 总内） |
| （Web 特有）实操 / 实验 lab 交付 required（2026-10-06 本轮） | `produce_quiz`（实操）/ `produce_experiment`（实验）必须交付 `lab/<NNNN>-stage/README.md` + `lab/solutions/<NNNN>-stage/README.md` + `lab/README.md`，内容入口 `../lab/<NNNN>-stage/README.md`；**缺一不 promote**；打回次数分 `repair_rounds` / `rechecks`（**总控只复检不占派工轮**） | 后端 `test_lab_delivery.py`（定向）；真实重产本轮因上游 503 未通过 | **后端已覆盖**；真实重产**待上游恢复** |

覆盖原则：**旅程中每个"用户做什么"在 Web 有等价功能的，必须有至少一条旅程级用例**（从入口点到最终可见结果连续走完，不拆成孤立的字段级测试）。

> **关于"已覆盖"的射程**：本表状态列仅指旅程**动作级**覆盖——逆向前置状态（如无科目对话、已填 key）、渲染正确性、请求载荷均不在射程内，见第 2 节；那三类按 P1–P5 计划补强后，再回来更新本表状态。（状态分支层已于 2026-10-04 经组件测试落地，见 §2.3 P4；载荷断言 P1 仍部分开放，渲染矩阵 P3 未落地。）

> **待翻转行（2026-10-02 决策）已于 2026-10-03 全部翻转**："选方向""产课（三件套）"随生产侧落地改为"已覆盖"（`course-build.spec.ts` / `produce-chain.spec.ts` / `inspection-ticket.spec.ts`）；"长期记忆 MEMORY.md 写侧"于 2026-10-02 翻转。Q5 阅读端形态（iframe + 壳层）不变，`lesson-quiz` / `grading-panel` 现有用例继续有效。fixture 说明：编排链路用 `STUDYMATE_E2E_SCENARIO`（chat 请求 `fixture_scenario` 字段）选固定流场景，仅 fixture 模式生效。

---

## 4. 用例流程明细

约定：断言优先用可访问性角色与用户可见文案；需稳定定位时给元素补 `data-testid`（不改行为与样式）。**§3 映射表是唯一全量清单**——本节只详记带特殊断言的用例（编号 4.1–4.7，已按物理顺序重排），其余用例以一句话索引指向 spec 文件；三条不再占正节的用例见文末「状态备注」。fixture 下的 canned 内容见 `backend/app/llm.py` 与 `frontend/tests/e2e/constants.ts`。

### 4.1 misconception-entry.spec.ts —— 提问记误解入口
hover 助手消息「记入概念本」→ 跳转 `/misconceptions` 预填（question / answer_summary / 科目 / 节点）；无科目 adverse 变体断言保存禁用 + 可见提示 + 补选后落盘。**弹层「科目」用 `getByRole("combobox")` 定位**——`getByLabel` 会把 textarea 的正文也算进匹配，题干含「科目」二字时会撞出两个元素。

### 4.2 chat-shell.spec.ts —— 对话壳层（顶栏 + 右侧边栏 + 新对话关联行）
**可折叠面板的收起断言用宽度判据**：`boundingBox()` 宽度归零 + `aria-hidden="true"` + `inert` 存在，**不要用 `toBeHidden()`**——宽度过渡时元素仍挂载，`toBeHidden()` 会误判为"可见"（v1.3 踩过；这条同时抓出过一个真 bug）。顶栏旧元素（"＋ 新对话"、模型/科目/节点下拉）在主列 count 0；新对话态右栏默认折叠，断言前先展开；折叠态只对已有会话持久化。

### 4.3 settings-models.spec.ts —— 模型行四操作与推理档位
**下拉一律用 `getByRole("combobox")`**（嵌在 `<label>` 内时 `getByLabel` + `exact` 匹配不到、还会把选项文本算进可访问名）；**模态与能力开关是 `role="checkbox"` 的按钮**（对齐 ZCode 多选语义），用 `getByRole("checkbox", { name: "图片" })`；推理档位是 chip 列表，用 `input[data-reasoning-variant-input]` 之类的稳定锚点而非结构选择器。

### 4.4 courses.spec.ts —— 课程页（右栏分段切换 + 科目总览）
- **画布是 cytoscape 铺的 3 层 `<canvas>`（不是 1 层）**；分段切换后画布是同一份（打标记仍在、层数不变）。
- 画布节点不能坐标点击：用 `graph-node-<id>` + `dispatchEvent("click")` 选中；右栏折叠后宽度归零、`aria-hidden`，sr-only 节点按钮仍挂载。
- 科目总览 `subject-status` 可就地改 + 用 API 核对 `subject.yaml`；侧边栏科目行 `aria-current="page"` 选中态迁移。

### 4.5 tool-cards.spec.ts —— 工具化 chat 的工具卡
路由改写 `fixture_scenario="tools"` 走 canned 工具脚本（不在生产 UI 开入口）。**工具卡常显在消息体**（v2.4 起移出「中间过程」折叠区，无需展开任何折叠区）；两张 `tool-card`（`list_workspace` / `read_course_file`）。该场景既无思维链也无提示 → **`process-panel` 整块不渲染**（`toHaveCount(0)`，不留空面板）。

### 4.6 message-actions.spec.ts —— 助手名称栏 / 上下文窗口 / 中间过程折叠 / 消息操作
- **`<details>` 的"收起"断言不用 `toBeHidden()`**（多个匹配会触发 strict violation），改用 `toHaveAttribute("open", "")` 与单元素可见性断言。
- **正文文本断言一律限定在 `chat-messages` 内**（会话标题会与消息正文撞词）。
- **过程折叠语义（2026-10-05 改，计数不变）**：`fixture_scenario=process` 下三个思维链片段**各自一个 `process-panel`**（`toHaveCount(3)`），**展开第一个不影响第二个**（`panels.nth(1)` 的 `process-reasoning` 仍隐藏）；**两张 `tool-card` 按流位置常显**在消息体、不折进折叠区；`assistant-parts` 的 `[data-part-type]` 顺序断言为 `reasoning / tool / reasoning / tool / reasoning / text`。片段表头 `reasoning`「正在思考…」/「中间过程 · 思考」、`notice`「中间过程 · 提示」；**「N 次工具调用」仅旧 legacy 整块保留，新片段不显示**。用例仍 1 条，本轮已绿。
- 其余要点：`assistant-name` / `context-window-usage`（含 `11.5k` 与 `%`）；编辑用户消息=从该条截断并重新生成、原附件可增删；助手「删除本轮」内联二次确认。

### 4.7 session-model.spec.ts —— 会话级模型与档位
**用 `page.route` 计数请求**：会话内切换只写本会话 → 断言 `PATCH /api/sessions/<id>` ≥1 且 `PUT /api/settings` = 0；新对话态切换反之（`PUT` ≥1 且无会话可 PATCH）。fixture 不外呼，故"绑到没 key 的提供商"也能验；`reload` 后从侧边栏重开会话仍保持绑定。

### 其余用例索引（一句话，步骤以对应 spec 为准）

以下用例无特殊断言，覆盖状态见 §3 映射表：

- **旅程主线**：`generate.spec.ts`（五项向导 + 门禁 422 problems / 500 通用错误两条 mock）、`chat-course-context.spec.ts`（开场恢复，数据层校验 slug/node 与消息数）、`lesson-quiz.spec.ts`（iframe 页内判分 + 「下一节」导航）、`grading-panel.spec.ts`（criteria + 证据引用 + 缺口，重提交原地替换）、`progress-transition.spec.ts`（只渲染合法流转项 + `progress.yaml` 落盘）、`misconceptions.spec.ts`（importance / 节点筛选 + 编辑双落点）、`subject-switch.spec.ts`（侧边栏科目切换 + 图谱重建）、`export.spec.ts`（真跑 gen_home + 失败 mock）。
- **Web 壳层与设置**：`chat-draft.spec.ts`（草稿按会话缓存、刷新归空）、`sidebar-resize.spec.ts`（拖宽 + 上下限 + localStorage；`/chat` 左栏是唯一 `<aside>`，右栏 `div[role="complementary"]`）、`settings-providers.spec.ts`（删除后 active 落首项 / 恢复默认 / 测试连接不可达地址）、`settings-workspace.spec.ts`（改选工作区 + `finally` 恢复）、`attachments-area.spec.ts`（术语表链接 200 + 空态）、`workspace-onboarding.spec.ts`（关联行工作区切换 + `finally` 恢复）、`new-session-association.spec.ts`（关联行 + 会话元数据落盘）、`sidebar-collapse.spec.ts`（折叠 60px + localStorage 持久化）。
- **工具化与课程页**：`produce-tool.spec.ts`（`fixture_scenario=produce` → `produce_lesson` 工具卡 + `tools[]` 非错误；**本轮旧断言已更新为实际接线 `submit_curriculum` / `write_deliver_file` / `run_check`**）、`assess-tool.spec.ts`（`fixture_scenario=assess` → `assess_node` + records 落盘）、`production-task.spec.ts`（**本轮新增 3 条**：`task_update` 原位更新 / 结果透传 / 系统状态兜底）、`rendering.spec.ts`（**本轮新增 4 × 2 = 8**：浅 / 暗定向断言）、`courses-home-embed.spec.ts`（无参 `/courses` = 我的课程，经营视图 count 0）、`chat-subject-graph.spec.ts`（右栏图谱 → 点节点跳课程页）。
- **旧工单恢复**：`legacy-ticket-recovery.spec.ts`（global「待归属」条 → 认领弹窗显式确认归属 / 放弃仅状态；**认领 B 仅 B 可改、A 不变**；孤儿放弃产物不变）。
- **会话流生命周期与有序工具卡**：`chat-stream-lifecycle.spec.ts`（fixture 固定流 4 段；编辑重发「请继续」后**流式中切走再切回** / **离开 `/chat` 再回**，断言本轮流不被中断、完整末段可见——修复前切走即 abort ⇒ 红）。**2 条已绿（全量 E2E 88 = 85 pass + 3 skip）。**
- **第四轮 UI（2026-10-05）**：`ui-round4.spec.ts` 3 条（**切页恢复**：客户端导航去课程页再后退，活动会话自动重开、空态/关联行不回归；**侧栏上限**：造 6 条新会话后默认只显 5 条 + 「展开历史会话」/收起，展开计数含世界总量；**右栏双栏**：大纲与图谱同屏、无分段切换钮、拖中间手柄向下大纲变高）；`chat-basic`（开场选项改"填充 → 手动发送"）、`course-build` / `review-chat-actions`（建课旅程首轮改经 API 带 `interview_switch` 场景驱动——普通会话由 agent 经 `start_course_interview` 切入并同轮收口——其后走 UI，入口断言同步新文案）、`component 层`（`ChatRestoreAndFill` 6 条 / `SidebarHistoryCap` 3 条；`ReviewChatActions` 等既有用例改走"填充后点发送"链路）。**3 条已绿。**

> 建课工具循环 `submit_curriculum`、产课链内 `write_deliver_file` / `run_check` 在 fixture 下仍走单次派工，由后端 `test_tooling.py` / `test_chat_tools.py`（monkeypatch 假 turn source，真实门禁/渲染器/评估服务仍真跑）覆盖。

### 状态备注（不占正节，各一句话）

- `assessment.spec.ts` —— **已删除**（2026-10-04 第八轮：节点页「申请评估」块删除，评估改由会话 agent 工具 `assess_node`）。链路由 §4「其余用例索引」的 `assess-tool.spec.ts` 承接；实验课联升与学习记录落盘仍由后端 pytest 覆盖。
- `session-summary.spec.ts` —— **已悬空**（右栏「生成小结」入口随会话关联区移除，1 条 `test.skip(true, …)` 挂起；后端端点、`api.generateSessionSummary`、fixture `memory_updates` 保留）。接回：入口挂到输入区工具条或消息操作条，删 `test.skip` 即可。
- `memory-flow.spec.ts` —— **已悬空**（聊天侧「沉淀记忆」入口随会话关联区移除，2 条 `test.skip` 挂起；后端 `suggest`/`confirm`、`MemoryDialog.tsx` 保留）。评估通过后的「沉淀记忆」入口随第八轮评估面板删除，当前**无 E2E 覆盖**。

---

## 5. 运行与维护约定

- 顺序敏感：`workers: 1` + 文件名字母序（chat 用例先于 settings-providers，后者会把 active 切到无 key 的"我的中转"；`sidebar-resize` 排在 settings-* 之后）；globalSetup 每轮重建工作区与 settings，保证幂等。**本卷最终 88 = 85 passed + 3 skipped（0 失败）**（skip = `memory-flow` 2 + `session-summary` 1，属第三批保留的悬空入口）；新增 / 改写的用例先单独跑绿再跑单轮全量。
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

1. 状态机路径（`assess-tool.spec.ts`）：`TRANSITIONS["学习中"]` 只到 初步理解/需要复习，评估推进到"能独立应用"（原 `assessment.spec` 实测，改用例后行为不变）。
2. fixture assess 的整体 verdict 取"通过"（部分通过会让 progress_updated 恒为 false，状态机链路不可测）；逐题 verdict 不变，schema 各自独立。
3. globalSetup 往 e2e 副本的 0001-net.layers.html 注入一个双选择题题组（quiz.js 仅在组内选择题 >1 时渲染"本题组：答对 N/M"；examples 源未动）。
4. `lesson-quiz.spec.ts` "下一节"断言的是 iframe URL 变为 0002 + iframe 内 h1 变化（LessonView 顶栏标题跟随查询参数，不随 iframe 内导航变）。
5. `settings-providers.spec.ts` 测试连接：fixture 模式下请求并不外呼——无 Key 走真实 422，可达性失败用 UI route mock 502。
6. `grading-panel.spec.ts` 重提交断言"结果块原地替换"（fixture 判分内容固定，无法断言内容差异）。
7. `session-summary.spec.ts`（悬空）落盘日期由后端 `today()` 覆盖，UI 按动态日期正则断言。
8. `settings-providers.spec.ts` 删除最后一个自定义提供商后视图自动重选首个剩余提供商（非空态）。
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
25. **E2E / 探索各有独立 `distDir`**（2026-10-05 审查轮）：Next 配置读 `STUDYMATE_NEXT_DIST`（默认 `.next`）；E2E 用 `.next-e2e`、探索用 `.next-explorer`。目的是让开发者正在跑的 `npm run dev` 与 E2E / 探索的 dev server 不共享同一构建目录（否则两个 `next dev` 会在启动锁 / 产物上冲突）。**这是目录级隔离，不是完全文件副本隔离**：`next-env.d.ts` / `tsconfig` 仍会被 Next 改写，且不同 `distDir` 是互不相交的根，不代表磁盘上存在一份完整副本；本轮 E2E 据此在隔离副本上执行。
26. **后端 webServer 命令按平台取 python**（2026-10-05 审查轮）：用 `tests/e2e/constants.ts` 的 `BACKEND_PYTHON`（Windows `.venv/Scripts/python.exe`、POSIX `.venv/bin/python`，路径含空格时整体加引号），替换此前写死的 `.venv\Scripts\python.exe`；`playwright.config.ts` 与 `explorer.config.ts` 共用。启动器 `start-web.bat` 的 Node 版本提示同步改为 **20.9+**（原 18+）。
27. **`stream` 负断言改协议断言**（2026-10-05 审查轮）：`chat-basic.spec.ts` 不再用"某段文本不出现"这类负断言，改断言 SSE 响应协议本身（事件形态），避免受 fixture 文案变动影响。
