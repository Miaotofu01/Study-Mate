# StudyMate Web E2E 测试流程

> 版本：v1.2（2026-10-02）
> 性质：测试流程文档——描述 E2E 用例如何映射上游插件的用户使用旅程（docs/使用/使用说明.md、docs/设计/设计方案.md），以及每条用例的步骤、断言与数据准备；不含测试代码。
> 运行方式：`cd frontend && npm run test:e2e`（Playwright 自动拉起后端 8290 [fixture 模式] + 前端 dev 3810）。
> 维护约定：新增/修改用户可见功能时，对照第 3 节的映射表补充或调整用例；本文与 `tests/e2e/` 同步演进。
>
> v1.1 修订：新增第 2 节「能力边界与补强计划」——人工试用清单（`反馈清单.md`，6 条）抓到的问题全部落在 E2E 射程之外，本文按三类盲区归因并给出 P1–P5 补强顺序；第 5 节维护约定同步追加"逆向前置状态"与"入口载荷断言"两条规则。
>
> v1.2 修订：反馈清单 10 条全部落地，用例数 25 → **34**，两轮幂等。新增 `chat-shell.spec.ts`、`chat-draft.spec.ts`、`settings-models.spec.ts`、`sidebar-resize.spec.ts`，`misconception-entry.spec.ts` 补 adverse 变体；同时修掉两处**测试侧路径 bug**（见 §1 末条），并变更两处选择器口径（顶栏标题改 `data-testid="chat-title"`、"新对话"改走侧边栏入口；概念本顶部筛选下拉的标签由「科目」改「学科」，避免与弹层新增的「科目」撞名）。
>
> v1.3 修订：提供商/模型域升到 **schema v3**（输入模态复选框组 / 最大输出 Token / 上下文窗口 / 推理档位 chip 编辑器；API Key 改为回填输入框），右侧边栏抽成共享外壳并支持**拖拽 + 折叠动画**，**课程图谱页的节点详情改由右侧边栏承载**。用例数 34 → **37**，两轮幂等。

---

## 1. 分层策略

沿用两层设计（对照 DeepTutor 的分层）：

- **后端 fixture 层**（主力）：`STUDYMATE_E2E_FIXTURE=1` 时 LLM 调用返回确定性内容（流式分段文本、判分/评估/小结/科目生成的 canned 输出，全部经过真实解析链路验证）。SSE 流转、会话持久化、状态机、附件移动、门禁脚本全部走真实链路——测的是"真后端 + 真前端"的聚合行为。chat 与判分等 `fixture_kind` 见 `backend/app/llm.py`。
- **UI route mock 层**（补充分支）：仅当需要测"上游失败/校验拒绝"这类 fixture 不便复现的分支时，用 `page.route` 拦截单个接口返回错误响应（如科目生成被门禁 422 的 problems 展示）。拦截必须局部、测试结束即恢复，不得覆盖整页数据。

数据隔离：globalSetup 每轮重建 `study-mate-web/data/e2e-ws`（种子科目 yaml + examples 的 lessons/assets）与 `study-mate-web/data/e2e-data`（settings/sessions/uploads/exports），真实开发数据零污染。fixture 工作区 settings 中 DeepSeek 带占位 key 保证输入可用。

**路径口径（三处必须一致，2026-10-02 修）**：E2E 的运行时根目录是 `<study-mate-web>/data/`，由 `backend/app/config.py`（`WEB_ROOT`/`DATA_DIR`）、`frontend/playwright.config.ts`（`E2E_WORKSPACE`/`E2E_DATA_DIR`）、`frontend/tests/e2e/global-setup.ts`（落盘）与 `frontend/tests/e2e/constants.ts`（用例回读）四处共同约定。此前 `playwright.config.ts` 与 `constants.ts` 各自少算/多算一级，指向了仓库根的 `data/`，导致后端读到陈旧 fixture（无 key、无 lessons）而大面积失败；且因 `reuseExistingServer` 会复用手工启动的正确服务，这个错误长期不可见。**改动运行时目录时，这四处要一起改。**

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
- **P4 组件测试层**：分支逻辑（空 key、空模型列表、无科目 prefill）下沉 frontend 组件测试（当前为零），旅程级只保留聚合与落盘断言。**未落地**。
- **P5 明确不覆盖清单**：logo、间距、对比度微调度等纯美学项归设计验收；写死边界，避免再次按旅程标准重复投入。**部分落地**：logo 与占位符间距本轮已修，但归口仍为人工走查，不加 E2E（`sidebar-resize.spec.ts` 只断言宽度数值与持久化，不断言视觉）。

一条警示：`settings-providers.spec.ts` 中"无 key 时报缺少 API Key"用例断言的是合理分支，但**"已填 key"这一互补状态从未被观测**——若后端把填了 key 的请求也判成缺少，套件依然全绿。这正是 P1 存在的意义：每个"用户输入 → 请求"入口都要有载荷断言，而不是只断言错误分支。

---

## 3. 旅程阶段 → Web 功能 → 用例映射

上游插件旅程（docs/）与 Web 运行时的对应关系，以及覆盖状态：

| 旅程阶段（插件侧） | Web 等价功能 | 用例文件 | 状态 |
|---|---|---|---|
| 安装与宿主适配 | 一键启动 + 首次种子工作区 | （由 webServer 承担）每条用例隐式冒烟 | 已覆盖 |
| 选方向（learning-discovery） | —— 不做（Web 无此功能，PRD 边界） | —— | 不适用 |
| 建科目（盘问五项 + 大纲门禁） | `/generate` 五项向导 → `check_curriculum.py` 当门 | `generate.spec.ts` | 已覆盖（2026-10-02） |
| 开场恢复状态 | Chat 关联科目/节点 → 课程上下文注入 | `chat-course-context.spec.ts` | 已覆盖（2026-10-02） |
| 产课（三件套） | —— Web 不产课，只消费已有产物 | （courses.spec 覆盖读取侧） | 不适用（写侧属插件） |
| 读课件 + 页内做题 | `/lesson` iframe + `quiz.js` 页内判分 | `lesson-quiz.spec.ts` | 已覆盖（2026-10-02） |
| 开放题自评 → Web 增强为判分 lite | 判分面板（criteria + 强制证据） | `grading-panel.spec.ts` | 已覆盖（2026-10-02） |
| 提问答疑记误解 | Chat 消息 hover"记入概念本"预填跳转（含无科目 adverse） | `misconception-entry.spec.ts` | 已覆盖（2026-10-02） |
| 评估点（证据>口头） | 节点详情"申请评估" → 落盘 + 状态机更新 | `assessment.spec.ts` | 已覆盖（2026-10-02） |
| 状态流转（保守推进） | 节点详情状态按钮 + 图谱着色 | `progress-transition.spec.ts` | 已覆盖（2026-10-02） |
| 会话收尾摘要 | Chat"生成小结" → sessions 落盘 | `session-summary.spec.ts` | 已覆盖（2026-10-02） |
| 误解双落点 | `/misconceptions` CRUD + 筛选 | `misconceptions.spec.ts` 扩展 | 已覆盖（2026-10-02） |
| 多科目管理 | 侧边栏/图谱页科目切换 | `subject-switch.spec.ts` | 已覆盖（2026-10-02） |
| （Web 特有）节点详情 | 课程图谱页右侧边栏（默认展开、可折叠 / 拖宽） | `courses.spec.ts` | 已覆盖（2026-10-02） |
| 静态产物互通 | "导出静态工作区"（gen_home 真跑） | `export.spec.ts` | 已覆盖（2026-10-02） |
| 长期记忆 MEMORY.md 写侧 | —— 不做（PRD 边界，只读展示） | —— | 不适用 |
| 换机器迁移 | —— 属运维操作 | —— | 不适用 |
| （Web 特有）模型提供商 | settings 二级界面 + 模型行四操作 + 模型编辑弹窗 | `settings-providers.spec.ts`、`settings-models.spec.ts` | 已覆盖（2026-10-02） |
| （Web 特有）暗夜模式 | 主题切换持久化 | `theme.spec.ts` | 已覆盖 |
| （Web 特有）对话壳层 | 顶栏瘦身 + 右侧边栏（关联 / 小结 / 会话信息）+ 折叠动画 + 拖拽调宽 | `chat-shell.spec.ts` | 已覆盖（2026-10-02） |
| （Web 特有）输入框草稿 | 按会话缓存（切会话保留、刷新归空、发送后清空） | `chat-draft.spec.ts` | 已覆盖（2026-10-02） |
| （Web 特有）侧边栏宽度 | 拖拽调宽 + 上下限 + 刷新保留 | `sidebar-resize.spec.ts` | 已覆盖（2026-10-02） |
| （Web 特有）基础对话 | 流式回复 / 停止 / 附件 / 用户气泡靠右 | `chat-basic.spec.ts`、`chat-attachment.spec.ts` | 已覆盖 |

覆盖原则：**旅程中每个"用户做什么"在 Web 有等价功能的，必须有至少一条旅程级用例**（从入口点到最终可见结果连续走完，不拆成孤立的字段级测试）。

> **关于"已覆盖"的射程**：本表状态列仅指旅程**动作级**覆盖——逆向前置状态（如无科目对话、已填 key）、渲染正确性、请求载荷均不在射程内，见第 2 节；那三类按 P1–P5 计划补强后，再回来更新本表状态。

> **待翻转行（2026-10-02 决策，未实施）**：上表"选方向（learning-discovery）""产课（三件套）""长期记忆 MEMORY.md 写侧"三行现在标"不适用"，Web 目标已改为复现乃至拓展插件全功能（见《开发与计划》§5.1 实施队列 F / C / I）——对应功能落地后，把这三行改为"已覆盖"并各补旅程级用例；Q5 阅读端形态（iframe + 壳层）不变，`lesson-quiz` / `grading-panel` 现有用例继续有效。

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

### 4.13 chat-shell.spec.ts —— 对话壳层（顶栏瘦身 + 右侧边栏）
1. 顶栏只剩会话标题与折叠按钮：旧顶栏元素（"＋ 新对话"、模型选择器、科目/节点下拉）在主列中数量为 0。
2. 右侧边栏装载关联区（科目 / 节点 / 生成小结）与会话信息区（消息数 / 创建时间 / 关联科目）。
3. 折叠：点击后用**宽度判据**断言收起（内容根宽度归零），并断言 `aria-hidden="true"` 与 `inert` 存在、内容未卸载；再点 → 复原。不要用 `toBeHidden()`——它判的是"可见性"，对宽度过渡的面板不可靠（v1.3 踩过）。
4. 右侧边栏拖拽调宽：拖手柄 → 宽度增大并写入各自的 localStorage 键；刷新后保留；拖过下限被钳制。
5. 关联科目并产生消息后，会话信息区的科目与消息数随会话更新。

### 4.14 chat-draft.spec.ts —— 输入框草稿按会话缓存
1. 在新会话输入草稿 → 切到历史会话 → 输入框为空；切回新会话 → 草稿仍在。
2. 历史会话输入另一段草稿 → 两个槽互不串。
3. 发送后只清当前会话的草稿，新会话槽的草稿不受影响。
（刷新归空为预期行为，不做持久化，因此不写"刷新后保留"的断言。）

### 4.15 sidebar-resize.spec.ts —— 侧边栏拖拽调宽
1. 默认宽度为初始值 → 向右拖 → 宽度增大且写入 localStorage。
2. reload 后宽度保留。
3. 大幅向右 / 向左拖 → 宽度被钳制在上下限内，reload 后保留。
（`/chat` 页上有两个 `aside`，故用拖拽手柄的祖先元素锁定左侧栏，不用裸 `page.locator("aside")`。）

### 4.16 settings-models.spec.ts —— 模型行四操作与推理档位
1. 自建自定义提供商（用例尾部删净）→ "＋ 添加模型"打开模型编辑弹窗。
2. 基础区填模型 ID / 显示名 / **最大输出 Token** / 上下文窗口，**模态用复选框**勾"图片"（并断言不存在模态 combobox）→ 保存模型。
3. 保存提供商 → 只读摘要行出现上下文窗口徽标 `1M`、模态徽标、`思考 · <档位>`；显示名回退规则生效。
4. 模型行四个操作可见：测试 / 编辑 / 删除 / 启用开关；编辑可重新打开弹窗并回填当前值。
5. API Key：输入框**回填已存密钥**（`type=password`、值非空、无旧占位符）→ 点"显示密钥"变 `type=text` → 点"隐藏密钥"变回；清空输入框后测试仍能回落已存 Key。
6. **高级折叠区**：展开后编辑**推理档位 chip 列表**（增 / 删 / 改名 / 排序）与默认档位，切三个能力声明开关。
7. 对话侧：模型选择器下拉里可为当前模型切换档位，切换写回当前使用三元组。
（下拉一律用 `getByRole("combobox")` 定位；`<select>` 嵌在 `<label>` 内时其可访问名会带上选项文本，`getByLabel` + `exact` 匹配不到。**模态与能力开关是 `role="checkbox"` 的按钮**，用 `getByRole("checkbox", { name: "图片" })` 之类定位。）

### 4.17 courses.spec.ts 扩展 —— 节点详情右侧边栏
1. `/courses?subject=computer-networks` 打开 → 详情栏**默认展开**，图区仍显示"点击节点查看详情"空态提示。
2. 点节点 → 详情在右侧边栏里渲染（既有的 `div.w-80.border-l` 锚点与 `NodeDetail` 内部 testid 全部保留）。
3. 折叠（图区按钮）→ 宽度归零、内容 `aria-hidden` 但不卸载；展开 → 回到默认宽度、空态提示仍在。
（新增用例用 `data-testid="course-node-detail"` 与 title 定位，不用结构选择器。）

### 4.6 assessment.spec.ts —— 评估点（对应"证据>口头"）
1. `/courses` 选 net.layers → 详情展开"申请评估"面板 → 选最近会话 → 提交。
2. fixture canned 评估通过真实链路：front matter 解析 → schema 校验 → `assessments/` 落盘 → 状态机更新。
3. 断言：结果区 verdict 徽标"通过"、掌握度与 next 建议、"进度已更新"提示出现；节点状态徽标从"学习中"变为"能独立应用"；图谱节点颜色更新（重建后样式正确）。
4. 断言（数据层）：`assessments/` 目录出现新记录文件；该会话上传目录之外无脏文件。

### 4.7 progress-transition.spec.ts —— 状态流转（对应"保守推进"）
1. 选一个"未开始"节点 → 详情状态区只显示合法流转项"学习中"（不显示"已通过项目验证"等）。
2. 点"学习中" → 徽标更新、合法项刷新为"初步理解/需要复习"。
3. 掌握度滑杆拉到 100% + 笔记输入 → 保存 → "已保存"反馈；数据层核对 progress.yaml 的 status/mastery/notes。
4. （状态机 409 由 API 层测试保证，UI 只验证合法项渲染。）

### 4.8 session-summary.spec.ts —— 会话小结（对应"会话收尾"）
1. `/chat` 关联科目 → 发一轮消息 → 顶栏"生成小结"按钮点亮 → 点击。
2. fixture canned 小结过 schema → 落盘 `sessions/<日期>.md`。
3. 断言：顶栏下成功条出现（record_file + next_step 摘要）；数据层核对文件存在且 front matter 含 subject/learned。
4. 空会话（无消息）时按钮保持禁用。

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

---

## 5. 运行与维护约定

- 顺序敏感：`workers: 1` + 文件名字母序（chat 用例先于 settings-providers，后者会把 active 切到无 key 的"我的中转"；`sidebar-resize` 排在 settings-* 之后）；globalSetup 每轮重建工作区与 settings，保证幂等。本轮用例数 **37**，两轮连跑全绿。
- 新增用例命名沿用旅程语义（`<旅程>.spec.ts`），归入第 3 节映射表并保持表格与文件一致。
- 逆向前置状态：新入口用例除 happy path 外，须为关键入口补 adverse 前置变体（无科目对话、已填 key 的测试连接、空模型列表等）；组合爆炸的分支下沉组件测试（第 2 节 P4），不堆在旅程级。
- 入口载荷断言：凡"用户输入 → 请求"的入口（测试连接、模型切换、概念本 prefill），必须有一条 `page.route` 载荷断言，防止字段被前端静默丢弃（第 2 节 P1）。
- fixture 扩展规则：canned 内容必须通过真实解析链路（判分 JSON 过 extract_json、评估/小结过 front matter + schema、大纲过 check_curriculum）；需要新的失败分支时优先用 UI route mock，不为单一分支扩建 fixture。
- 长期目标：真实 Key 可用后，加一个 `SMOKE_REAL_LLM=1` 门控的冒烟 project（仅 1 条真实流式对话），默认跳过——沿用 DeepTutor 的"环境门 + skip 注明原因"模式。

### 5.1 实现偏差备注（以实际代码为准，2026-10-02 落地时修正）

1. §4.6 状态机路径：`TRANSITIONS["学习中"]` 只到 初步理解/需要复习，用例实际经 需要复习→学习中→初步理解，再由评估推进到"能独立应用"。
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
15. **可折叠面板不要用 `toBeHidden()` 断言收起**：v1.3 右侧边栏用宽度过渡折叠，元素仍在（只是宽度归零），`toBeHidden()` 会误判为"可见"。改用宽度判据（`boundingBox()` 宽度为 0）+ `aria-hidden` / `inert` 属性断言。这一条同时抓出过一个真 bug（最初只加了 `inert` 属性、宽度没参与计算，折叠在视觉上根本没发生）。
16. 右侧边栏根元素是 `div[role="complementary"]` 而不是 `<aside>`，与左侧主侧边栏区分；因此"页面上只有一个 `aside`"的既有写法仍然成立（`/courses` 上 `page.locator("aside")` 不会再双匹配）。
17. 模型编辑弹窗的模态与能力开关是 `role="checkbox"` 的按钮（对齐 ZCode 的多选语义），不是原生 checkbox；推理档位是 chip 列表编辑器，定位用 `data-reasoning-variant-input` 之类的稳定锚点而不是结构选择器。
