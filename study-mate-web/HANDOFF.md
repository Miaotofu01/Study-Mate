# HANDOFF — StudyMate Web 交接（2026-10-04 · 第十一版，启动器重建后）

> 给下一个接手 `study-mate-web/` 子项目的 agent。**本文只做索引与状态，不重复其他文档的内容**——细节一律走路径。
> 脱敏说明：本子项目不含任何密钥/PII；测试用占位 key 均为假值。

## 一句话现状

**2026-10-04 在同一天内跑完两轮**：先是 **K 系列工具化改造 K0–K3**（agent loop / 工具注册表与沙箱 / 审计落盘 / 三格式 tools 映射 / 建课与产课工具循环 / 工具卡；随后**工具调用定为默认对所有模型开启**，并补真实 LLM 冒烟），接着是**第二轮 UI 杂项五项**：**会话级工作区（拍板"甲"）** —— 新增 `backend/app/workspace_ctx.py`（ContextVar），`curriculum_store.workspace_dir()` 成为唯一收口点，会话可各自绑定工作区（`?workspace=` / `session.workspace` / `PATCH /api/sessions/{id}`）；**新对话态输入区上方加「科目 + 工作区」关联行**（只在新对话态出现）；**右栏「会话关联」整段移除** → 「生成小结」与聊天侧「沉淀记忆」**入口悬空**（后端与组件保留）；**推理档位改为输入区旁的独立下拉**（模型弹层 chip 删除）；**课程页再对调** —— 大纲与图谱都进右栏做「图谱（默认）/ 大纲」分段切换、科目状态+进度总览进头部（可就地改）、缩放灵敏度 0.2→0.6、画布右下角加「重置视口」；同轮修掉一枚"图谱可能整体不渲染"的 ref 竞态真 bug。**后端 pytest 75 条（+1 门控冒烟 skip）/ E2E 53 条通过 + 3 条 skip（悬空占位，0 失败）**，`tsc --noEmit` 零错误。全部**未提交**待维护者过目；PR #43 仍为 draft。版本号 **0.5.0-beta**（未变）。K4（总控全 agent 化）远期观望。**同日晚追加「启动器重建」轮**：`start-web.bat` 重写（陈旧构建自动重建 / 端口预检 / 就绪自动关窗 / 直调 node）、新增 `stop-web.bat` 与 `tools/studymate-web.ps1`——修掉"重启后界面毫无改动"（生产产物没重建）与"关窗/强杀后服务残留占端口"两类问题。

## 上一版遗留项的处置

- **`ProvidersView.tsx` 半成品**（第八版"待裁定"1）：已补完；本轮同一文件又按维护者要求改为**实时生效、去掉「保存」「测试连接」按钮**（连接测试入口收敛到模型行「测试」），E2E `settings-providers` 全绿。
- **ChatView 内联重命名在途**（第八版"待裁定"2）：已落地并被 `sidebar-collapse.spec.ts` 覆盖，无冲突。
- **E2E 两轮幂等复验**（第八版"待裁定"3）：K 系列轮已完成；本轮因新增/改写用例只跑了单轮全量（0 失败）。
- **"重启前后端后界面毫无改动迹象"**（维护者本轮反馈）：已定因并修好——生产模式下 `.next` 是构建期快照、`next start` 不重新编译，而旧 `start-web.bat` 见 `BUILD_ID` 就走 prod，所以"重启"永远伺服旧产物。现启动器会自动比对源码 mtime 与构建时间并在陈旧时重建；另加 `stop-web.bat` 清残留、启动前端口预检。详见下方「启动器重建」一节。

## 接下来做什么

K0–K3 与第二轮 UI 杂项均已实施完毕，剩余候选（按建议优先级）：

1. **悬空入口接回**（本轮新增，见《开发与计划》backlog #17）：「生成小结」与聊天侧「沉淀记忆」目前没有 UI 入口（后端端点、`MemoryDialog.tsx`、`WorkspaceOnboarding.tsx` 都保留）。接回时把入口挂到输入区工具条或消息操作条，并摘掉 `memory-flow.spec.ts` / `session-summary.spec.ts` 的 `test.skip` 行即可。
2. **会话级工作区的两个可选放宽**（backlog #18）：绑定要求目录已存在（否则 422）——若要支持"先指向空目录再冷启动"，去掉那处存在性校验即可。
3. **真实 LLM 冒烟收尾**（backlog #3）：anthropic / openai_responses 两格式的真实流式（含 tools）仍未验证——本机没有这两类渠道。
4. **K4 总控全 agent 化**（backlog #16，远期）：K2/K3 效果决定；参考 `K系列尽调-DSH与DeepTutor工具机制存档.md` §七。
5. **能力声明剩余两项**（backlog #14 余项）：`json_schema_output` / `native_web_search` 仍仅落盘展示，未接线。
6. **工具卡持久化**（可选增强）：工具卡只在流式期间呈现（会话历史只存最终文本），持久审计在 `data/audit/*.jsonl`；要"刷新后仍能看到工具卡"需把工具事件落成会话消息（未拍板，勿自行动手）。
7. **探索测试提醒（AGENTS.md 规则 9）**：本轮属"较重要的 UI 变更"，建议按《探索测试指南》跑一轮，建议目标：新对话关联行（选工作区 → 科目列表跟着换）、右栏折叠后附件区仍可用的路径、课程页右栏「大纲/图谱」分段切换与重置视口、暗色下新下拉与关联行的可读性。是否执行由维护者定。

**硬约束（不变）**：上游脚本只复用不重写；`/lesson` 维持 iframe 承载上游渲染产物；改功能必须同步五份文档（AGENTS.md 规则 8）；**门禁仍由后端在写盘后强制执行**（不信任模型自查）；任何 commit/push/tag 必须维护者明确同意，完成后停在待提交状态报告。

## 第二轮 UI 杂项轮已完成（未提交，2026-10-04）

- **后端（会话级工作区"甲"）**：新增 `app/workspace_ctx.py`（ContextVar + `resolve()` + 可重入 `bind()` + `validate_dir()`）；`curriculum_store.workspace_dir()` 改读它（**唯一收口点**，memory/records/tickets/misconceptions/export/lessons 全部自动跟随）；`storage` 会话加 `workspace` 字段 + `session_workspace()` 助手；`models.py` 的 `ChatRequest`/`NewSessionRequest` 加可选 `workspace`，`RenameSessionRequest` → `SessionPatchRequest`（title/workspace 均可选，`model_fields_set` 区分"没传"与"显式 null"）；`common.optional_workspace()` 统一校验；绑定点 = chat stream / 小结 / assess(带 session) / memory suggest+confirm（SSE 生成器在迭代期各自重挂绑定）；`?workspace=` 加在 `/api/courses`、`/api/courses/{slug}`、`attachments-area`、`files/{path}`（后两者在 `lessons.py`，共享 `courses.py` 的 `bound_workspace()`）；`GET /api/workspace?path=` 只读预览。带 `workspace` 的绑定要求目录已存在（否则 422）。
- **前端**：`ChatView` 新对话关联行（`new-session-association` / `new-session-workspace`，只在新对话态出现，发首条消息后隐藏）；`RightSidebar` 只剩附件区（按会话工作区读）+ 会话信息；`WorkspaceOnboarding` 使用点移除（文件保留无引用）；小结与沉淀记忆入口从 UI 移除（`MemoryDialog` 保留无引用）；`Composer` 加 `ReasoningVariantSelector`（`reasoning-variant-selector` / `reasoning-variant-menu`），`ModelSelector` 删掉档位 chip 并导出 `modelVariant`/`modelVariants`/`activeModelOf`；`Sidebar` 明暗钮移到设置右侧、导航选中唯一化、科目去绿点改 `aria-current` 选中；`CourseGraphView` 右栏「图谱/大纲」分段切换（两面板常驻、`hidden` 切换、切回时 `resize+fit`）、`WHEEL_SENSITIVITY=0.6`（**后续被外部改为 1，注释已按"最灵敏档"同步**）、右下角「重置视口」（`cy.animate({fit},{duration:200})`）、头部科目状态+进度总览（`subject-status`，就地改走 `PATCH /api/courses/{slug}`）；`lib/workspace.tsx` 增 `activeWorkspace`/`workspaceCandidates`/`currentSubjectSlug` 与按工作区拉科目；`lib/api.ts` 增 `?workspace=`/`?path=`/`setSessionWorkspace`/`streamChat.workspace`；`lib/types.ts` 会话加 `workspace`。
- **真 bug**：课程图谱可能整体不渲染 —— `setCourse` 与 `setLoading(false)` 分属两次提交，`getCourse` 先于 `refreshSubjects` 返回时那次提交里画布容器还没挂载（页面仍在 early-return 的 loader 分支），而初始化 effect 依赖 `useRef.current`，容器后挂载不触发重跑。修法：画布容器改 **state 承载**（`ref={setGraphContainer}` + effect 依赖 `[graphContainer, elements]`）。
- **测试**：后端新增 `tests/test_session_workspace.py` 11 条（**75 条 + 1 skip**）；E2E 新增 `new-session-association.spec.ts`、`courses.spec.ts` 补两条（科目总览 / 侧边栏选中态）、`workspace-onboarding.spec.ts` 改写、`theme-visual-inspection` 与 `helpers.openNodeDetail`/`associateSubject` 同步；`memory-flow`（2）+ `session-summary`（1）改 `test.skip(true, …)` 悬空挂起 → **53 条通过 + 3 条 skip，0 失败**；`tsc --noEmit` 零错误。
- **文档**：Web_CHANGE 追加本轮条目；PRD 更新 §1.3/§1.4/§2.1/§5.1–§5.4/§7/§9/§11/§12 与状态总览；开发与计划补 `workspace_ctx` 模块行、前端组件清单、对外契约（会话级工作区）、不变量 #14 与 backlog #17/#18；E2E 流程升 v1.9（§4.13/4.16/4.17/4.8/4.19/4.20/4.21 改写 + 新增 §4.23/§4.24 + 计数）；本文件第十版。

## 启动器重建（未提交，2026-10-04）

- 触发：维护者反馈"重启前后端后打开 Web 界面毫无改动迹象"。定因——3800 上跑的是 `next start`（生产模式），读的是 `.next\BUILD_ID` 指向的构建快照；旧启动器只要该文件存在就选 prod 且**从不重新编译**，所以重启只换进程、不换代码。修法：`npm run build` 重建（并用 HTTP 取 chunk 验证标志串上线）。
- `start-web.bat` 重写（GBK + CRLF，经 `tools/studymate-web.ps1` 判定构建新鲜度）：默认启动 / `dev` 强制开发 / `restart` 先停再启 / `stop` / `help`；**源码比构建新则自动 `npm run build`**；**端口预检**（8101/3800 被占用即取消并报占用 PID）；**就绪后自动关闭启动器窗口**；前端改直调 `node node_modules\next\dist\bin\next start -p 3800`（不经 npx，进程树两层）；端口可用 `SM_WEB_BACKEND_PORT` / `SM_WEB_FRONTEND_PORT` 覆盖。
- 新增 `stop-web.bat`（双击即用，`start-web.bat stop` 等价）：按端口找监听进程 → 进程表快照向上爬到服务窗口（只认命令行含 `uvicorn|next|npm|npx|study-mate-web` 的 cmd/node，不碰用户终端）→ `taskkill /F /T` 连窗口带子孙一起收。
- 关窗语义实测（对照实验 A–F）：**点 X 关窗会整棵树一起死**（三种启动形式皆然，含 npx 三层）；只有**进程级强杀 wrapper**（任务管理器结束任务等）才会留下孤儿继续占端口——“关窗后服务还在”的真实成因是①关的是启动器自己的窗口（服务是 `start` 分离的）②或曾强杀留孤儿。孤儿会占住端口、让浏览器连到旧实例，与“看不到改动”叠加。
- 同时清掉一个“子进程已死”的空 uvicorn 窗口（重复启动残骸，端口预检已从源头避免）。
- 文档：README 启动段重写 + 补 `stop-web.bat`/`tools/` 条目 + 修掉从未存在过的 `start-studymate.bat` 错名；Web_CHANGE 追加本轮条目。

## K 系列轮已完成（未提交，2026-10-04）

- **后端新增**：`agent.py`（loop：探索 8 + 收尾 3 + 强制 1 轮预算、传输失败重试/降级、重复调用 3/5/8 次提醒、工具失败转 `role:tool` 错误文本）、`tools.py`（`TOOL_SPECS` 注册表 + 沙箱：读写根 allow-list / 写前 canonicalize / 稳定拒答标记 `[sandbox: file access denied under <mode> mode]`；工具集 `CHAT_TOOLS`/`BUILD_TOOLS`/`PRODUCE_TOOLS`）、`audit.py`（contextvar 绑定编排键，`data/audit/<key>.jsonl` 追加写，失败不清除，敏感键脱敏）。
- **`llm.py`**：`ToolCallAccumulator`（id/name 赋值不追加、arguments 拼接、`arguments_full` 权威覆盖）；三格式 payload 支持 tools + tool_calls/role:tool 映射（anthropic 连续 tool_result 合并为一条 user 消息）；`stream_turn`（文本增量 + tool_calls，tools 被 400 拒时回落一次）；`supports_tools()`。
- **K1 chat**：`routers/chat.py` 加工具分支（队列驱动 SSE，事件 `tool_call`/`tool_result`）；读根 = 已绑定科目目录或工作区 subjects 目录。启用条件 = `fixture_scenario=="tools"` 或**真实 provider**（工具调用默认全模型开启）。
- **默认开启（同日追加）**：`llm.supports_tools()` 恒 True（不再读 `capabilities.tool_call`）；建课/产课链去掉能力门控，真实模型一律工具循环；`stream_turn` 回落兜底宽化为"带 tools 首轮未吐内容即报错就回落纯文本一次"；前端移除「工具调用」开关（改只读提示），`settings-models.spec` 改用「JSON Schema 输出」。
- **真实冒烟（同日追加）**：新增 `backend/tests/test_smoke_real_llm.py`（`SMOKE_REAL_LLM=1` 门控，默认 skip）；本机实测 space-bunny-alpha（9.2s）与 Deepseek-v4-flash（10.3s）各 2 次工具调用、未降级、据结果作答。
- **K2 建课**：`build.py` 加 `_curriculum_tool_loop`（`submit_curriculum` 立即跑门禁回喂自修）；顺便修掉"envelope 畸形零兜底硬停"（`_dispatch_curriculum` 现原值重派 `MAX_RETRIES` 次）。
- **K3 产课**：`produce.py` 加 `_role_tool_loop`（`write_deliver_file` 写 `.stage/<角色>/deliver/`、`run_check` 落盘后跑渲染+检查回喂）；`dispatch(..., base/node_id/index/stage_dir=…)` 在有工具能力时优先走循环，否则回落既有 envelope 链。
- **审计接线**：`roles.dispatch_role` 记录派工值 + 原始回复；`run_build`/`run_produce` 绑审计键——修掉 10-03 核实的"堵点无文件证据"缺口。
- **`config.py`**：`get_active_provider()` 透出 `capabilities`；`models.py` 的 `ProviderCapabilities` 已存在。
- **前端**：`lib/types.ts` `ToolActivity` + `ChatMessage.tools`；`lib/api.ts` `onToolCall`/`onToolResult`；`ChatView` 工具卡（`tool-card`/`tool-name`/`tool-result`，`<details>` 可展开）；`ModelEditDialog` 能力标签"对话系统消息"→"工具调用（Agent 循环）"、说明改为"决定是否走工具化 agent 循环"。
- **测试**：`backend/tests/test_tooling.py` 22 条（三格式 wire / 聚合 / loop 预算与降级 / 沙箱 / 审计保留 / K2 硬停兜底 / fixture 工具事件）；`frontend/tests/e2e/tool-cards.spec.ts` 1 条；`settings-models.spec.ts` 标签同步。
- **文档**：Web_CHANGE 追加 K 系列实施条目；PRD 增 §2.2/§14 并更新总览；开发与计划补模块表 / 不变量 13 / backlog #14 收敛 + #16 / §5.1 K 系列段；E2E 流程升 v1.8（§4.22 + 映射表行 + 计数 53）；README 树与能力说明、E2E 计数、进度行。
- **验证口径**：pytest 64 全绿（+1 门控冒烟默认 skip）；tsc 零错误；`npm run build` 通过；E2E 53 条两轮全绿；真实工具循环冒烟在 my-api 上通过。根 `npm test` 有 **1 条已知 Windows CRLF 假红**（`test_antigravity_skills.mjs` 的 curriculum-designer 导出断言，`.dsh/skills` 以 CRLF 检出所致，Linux CI 不受影响；本轮未动 `.dsh`/`scripts`）。

## 文档地图（先读这几份，按需深入）

| 文档 | 用途 |
|---|---|
| `AGENTS.md`（本目录） | 子项目硬规矩 + 规则 8 五份文档同步约束 + 规则 9 探索测试提醒 + 端口 |
| `README.md` | 启动（bat/手动）、配置模型、附件、E2E 运行、版本语义（0.5.0-beta）、运行结构树 |
| `StudyMate-Web_开发与计划.md` | **架构现状 + 不变约束（含 #13 工具化、#14 会话级工作区）+ 领域模型 + §5 队列/backlog（#16 K4、#17 悬空入口接回、#18 工作区绑定放宽）** |
| `StudyMate-Web_PRD.md` | 功能规格（描述现状；**§2.1 档位下拉 + §5.1 新对话关联行 + §9 会话级工作区为 2026-10-04 第二轮口径**） |
| `StudyMate-Web_E2E测试流程.md` | v1.9：用例 ↔ 上游旅程映射（§4.23 关联行 / §4.24 侧栏折叠）+ §2 三类盲区与 P1–P5 补强计划 |
| `Web_CHANGE.md` | 变更史与全部 grill 决策留痕（只追加；**2026-10-04 五条：UI 轮 / K 系列拍板 / K 系列实施 / 第二轮 UI 杂项 / 启动器重建**） |
| `K系列尽调-DSH与DeepTutor工具机制存档.md` | K0 设计输入（wire/loop/边界/审计/子代理结论 + 证据路径） |
| `StudyMate-Web_前端美化设计.md`、`StudyMate-Web_探索测试指南.md` | 设计/指南文档（探索目标库 g1–g17 以指南 §5 为准；随 2026-10-04 那批一并入库） |
| `反馈清单.md` | 维护者手写 10 条反馈，已全部落地并逐条回填 |

上游侧事实依据：`.dsh/skills/learning-system/{lesson-design,layered-practice,record-keeping,practice-evaluator,evidence-check,local-qa,learning-discovery}/SKILL.md`、`scripts/{gen_home,render_lesson,check_lesson,check_curriculum}.py`、`SKILL_ROUTES`（`backend/app/prompts.py`）。DSH 运行时本体在 `D:\deepseek-harness`，可随时回去查源码。

## 已知坑（踩过的别再踩）

- **并发会话同树作业是常态**：跑 E2E/构建前先确认 8290/3810 无占用（`Get-NetTCPConnection`）且没有他人在途改动。`reuseExistingServer: false` 下撞端口会响亮失败，但 `data/e2e-*` 会互踩；全量 E2E 出现轮间不一致时先隔离复跑再归因，别急着改代码。多代理并行时只让代理跑 `tsc --noEmit` / `compileall`，构建与全量 E2E 由主代理串行跑。
- **`getByRole` 的 `name` 默认是子串匹配**：同页两个可访问名互为子串即 strict violation（"1. 分层模型与封装" vs "…（图谱节点）"踩过，改"图谱节点 N"解决）。同理能力复选框标签改"工具调用（Agent 循环）"后，`settings-models.spec.ts` 必须同步。
- **工具/loop 相关**：`stream_turn` 在 fixture 模式只吐纯文本，工具脚本在 `agent.FIXTURE_TOOL_SCRIPTS`（scenario `tools`）；E2E 经 `page.route` 改写请求体加 `fixture_scenario`，不在生产 UI 开入口。工具卡只在流式期间呈现（不落历史），断言用 `tool-card`/`tool-name`/`tool-result`。`<details>` 收起时结果不可见，断言前先点 `summary`。
- **审计 contextvar**：`audit.bind(key)` 必须在 `asyncio.create_task` **之前**调用（子任务创建时继承上下文）；生产链在 `run_build`/`run_produce` 内绑定。审计写失败只告警不阻断。
- NodeDetail 在课程页**主区**（`getByTestId("course-node-detail")`）；**大纲与图谱都在右栏做「图谱（默认）/ 大纲」分段切换**（`rail-view-graph` / `rail-view-outline`），sr-only 图谱按钮 `graph-node-<id>` 与大纲行 `outline-node-<id>` 并存但后者默认 `hidden` —— **测试里要点大纲行必须先用 `helpers.openNodeDetail`（它先切「大纲」段）**，直接 `getByRole("button", { name: "1. 分层模型与封装" })` 会因隐藏而超时（本轮踩过，6 个 spec 同时挂）。
- **`<canvas>` 数量不是 1**：cytoscape 会给一个容器铺 **3 层 canvas**。断言"画布存在/未重建"不要写 `toHaveCount(1)`——用"先打标记、切视图后标记仍在 + 层数不变"（本轮踩过）。
- **画布容器的 effect 依赖要用 state 而不是 `useRef.current`**：页面还在 early-return 分支时容器没挂载，`getCourse` 可能先于 `subjectsReady`/`loading` 翻转而那次提交里 `elements` 已非空，ref 型依赖不会重跑 ⇒ 图谱永远不建（表现：容器在、0 canvas、**控制台无报错**，极难归因）。可折叠面板/条件渲染的容器一律用 `ref={setState}` 模式。
- **新对话关联行只在新对话态存在**：`sessionId === null` 才渲染，发出首条消息即隐藏。任何"会话中改科目/改工作区"的断言都要改写（科目关联入口消失 = 绑死语义的 UI 侧面）；`helpers.associateSubject` 已改为直连关联行、不再展开右栏。
- **右栏内容缩水后，role 型断言会静默失配**：`生成小结`、右栏 `关联科目` 下拉都已移除，`memory-entry` 也没了；右栏在新对话态**默认折叠**（`inert` + `aria-hidden`），role 定位在折叠时找不到元素 —— 断言前先 `expandRightRail(page)`。
- **会话级工作区是请求级 ContextVar**：`bind()` 必须在 SSE 生成器迭代期重挂（StreamingResponse 在别的任务里迭代）；同步端点跑在 anyio 线程池（context 会被拷贝）。要扩展工作区相关能力时**只改 `curriculum_store.workspace_dir()` 这一处**，别逐个下游加参数。
- **ZCode 是开源项目**（`github.com/zai-org/ZCode`）：设置页对齐它要**读源码**；本机 `~/.zcode/v2/config.json` 可读真实字段形态（注意脱敏）。
- **可折叠面板别用 `toBeHidden()` 断言收起**：用宽度判据 + `aria-hidden`/`inert`。
- **`<select>` 嵌在 `<label>` 里时定位一律 `getByRole("combobox")`**。
- **改了前端源码却"看不到改动"先查构建产物**：生产模式下 `.next` 是 `next build` 的快照，`next start` 不会编译——判断方法是对比 `.next\BUILD_ID` 的 mtime 与源码 mtime，或直接 `grep -rl "<新增的 data-testid>" frontend/.next/static`（命中 0 = 伺服的是旧代码）。现在 `start-web.bat` 会自动重建，手动起生产模式则要自己 `npm run build`。
- **`start` 出去的服务不随启动器窗口退出**（按设计）：关服务要关「StudyMate 后端 / 前端」各自的窗口，或双击 `stop-web.bat`；点服务窗口的 X 能干净停掉该服务，但从任务管理器强杀 wrapper 会留下占端口的孤儿。
- **PowerShell 参数里的逗号会被它自己吃掉**：`-Ports 8101,3800` 传到脚本里是单个数 `81013800`（直接调用亦然，与 cmd 无关）⇒ 多值参数一律拆成独立整型/字符串参数，别用逗号列表。
- **爬进程父子链别逐级查 WMI**：`Get-CimInstance` 偶发返回空会中断爬链（表现是"只杀了子进程、窗口留下"）⇒ 先取一次全表在内存里走链。另外 `$pid` 是 PowerShell 只读自动变量，循环变量别用这名（会静默不执行）。
- **本机 VS 的 `LIB` 路径失效会让 `Add-Type` 直接报错**：写 PowerShell 探针要 P/Invoke（如发 `WM_CLOSE`）时，先 `$env:LIB=''; $env:INCLUDE=''; $env:LIBPATH=''`，或改用 Python `ctypes`。
- Next 16：生产构建把 rewrites 代理目标固化进 `.next/routes-manifest.json`（改 `BACKEND_PORT` 必须重新 build）；`next.config.js` 的 `compress: false` 不能删（否则 gzip 缓冲 SSE）。
- Windows：curl 发中文 JSON 会 GBK 乱码，用 UTF-8 临时文件 + `--data-binary @file`；YAML 落盘是 CRLF（断言正则写 `\r?\n`）；联升补写的 `status` 未必是节点条目第一个键。
- E2E 顺序依赖（`workers: 1` + 文件名字母序；settings-providers 会把 active 切到无 key 项）；globalSetup 每轮重建 `data/e2e-ws` 与 `data/e2e-data`；E2E 后端 env 两个都要给（`STUDYMATE_CONFIG` + `STUDYMATE_DATA_DIR`）。
- **"加载完成回填输入框"别无条件做**：回填只做一次，否则并发/StrictMode 下覆盖用户刚填的值。
- **Windows 注册表系统代理会经手本机网关**：`llm.py` 已按 host 精确挂直连 mounts；换机器复现"长流必挂"先查这条。
- **长派工时间口径**：`REQUEST_TIMEOUT` 900s（`STUDYMATE_LLM_TIMEOUT` 可调）；mimo-medium 单次课件派工 694s、space-bunny 约 60s。
- **TestClient 不增量吐 SSE**：整条响应结束才一次性交付；判断在途状态看磁盘产物 + `Get-NetTCPConnection -OwningProcess <pid>`。
- **根 `npm test` 的 CRLF 假红**：`test_antigravity_skills.mjs` 的 curriculum-designer 导出断言在 Windows 上必红（`.dsh/skills` CRLF 检出），Linux CI 不受影响；不要试图"修"它。
- 端口：后端 8101 / 前端 dev 3800 / 生产 3801 / E2E 8290 + 3810。venv 在 `backend/.venv`（Windows 为 `.venv/Scripts/python.exe`）。
- **启动/停止**：双击 `start-web.bat`（自动判定构建新鲜度、端口预检、就绪后自动关窗）；`stop-web.bat` 一键全停（含残留孤儿）；端口可用 `SM_WEB_BACKEND_PORT` / `SM_WEB_FRONTEND_PORT` 覆盖；助手是 `tools/studymate-web.ps1`（`-Action state|stop`，纯 ASCII，改它别写中文——PS 5.1 按 ANSI 读无 BOM 的 `.ps1`）。`.bat` 一律 GBK + CRLF（转换流程见 `windows-bat-encoding` 技能）。
- 嵌套残留 `study-mate-web/study-mate-web/`：本机已不存在；若在其他机器出现，别提交也别删（除非维护者指示）。

## 环境事实

- Python 依赖在 `backend/.venv`；门禁 = `python -m pytest tests`（**75 条 + 1 skip**：1 条为 `SMOKE_REAL_LLM` 门控冒烟；本轮新增 `test_session_workspace.py` 11 条）+ `compileall` + `tsc --noEmit` + `npm run build` + E2E（frontend/，**53 条通过 + 3 条 skip（悬空占位）**；K 系列轮起两轮连跑均全绿，本轮单轮全量）。
- **本机有真实 LLM 渠道**：`my-api` = 本机 new-api 中转 `http://localhost:4000/v1`，六模型（mimo-v2.6-flash 质量主力 / space-bunny-alpha 速度 / Deepseek-v4-flash 活跃默认 / agnes / muse-spark / u2-flash），均带思考档位（默认 medium）。冒烟口径：**串行不并发**、脚本自己钉死模型（live settings 会被 UI 改掉）；方法与坑见 Web_CHANGE 2026-10-03 冒烟条目。**工具调用默认全模型开启**，直接跑即可；门控冒烟命令：`SMOKE_REAL_LLM=1 SMOKE_MODEL=space-bunny-alpha .venv/Scripts/python.exe -m pytest tests/test_smoke_real_llm.py -s -q`（backend/ 下）。
- `docs/` 上游文档已按用途归位（使用/规范/设计/agents）；引用上游文档用新路径。
- 版本号 0.5.0-beta（`frontend/package.json` + `backend/app/main.py` + README「版本」节；侧边栏读 package.json 自动跟随；变更需维护者知会同意）。
- 运行时数据根在 `study-mate-web/data/`（settings、sessions、drafts、**audit**、uploads、exports）。

## 建议使用的 skills

- `grill-with-docs`：K4 或新取舍"该不该/做到哪一层"先盘一遍；决策落 `Web_CHANGE.md`（只追加）。
- `playwright-cli`：扩展/调试 E2E、录 trace、查并发端口占用。
- `github:issue` / `github:pr`：维护者指令下跟进 issue 或 PR #43。
- `handoff`：再次交接时生成新版本（**覆写本文**，保留"文档地图/已知坑/环境事实"三节结构）。
