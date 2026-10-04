# StudyMate Web 开发与计划

> 版本：v1.1（2026-10-02，实施轮 A/B/H/I+G 落地后更新）
> 定位：**已有实现的开发文档 + 待实现的计划文档**。描述系统当前架构、关键机制与不变约束、领域模型、与上游仓库的关系，以及后续计划。
> 文档分工：功能规格与实施状态 → [StudyMate-Web_PRD.md](StudyMate-Web_PRD.md)；
> 测试流程与用例映射 → [StudyMate-Web_E2E测试流程.md](StudyMate-Web_E2E测试流程.md)；
> 旧计划与变更史（只追加）→ [Web_CHANGE.md](Web_CHANGE.md)；
> 启动、配置、附件、E2E 运行、版本语义 → [README.md](README.md)。
> 维护约定：功能落地或变更时同步 PRD；计划项完成/新增/放弃时更新本文第 5 节；里程碑与重要决策追加进 Web_CHANGE。

---

## 1. 架构现状（0.5.0-beta）

```
浏览器 ──► Next.js 16 前端（同源）
              │  /api/* 由 Next.js rewrites 代理
              ▼
           FastAPI 后端 ──► LLM（三种 API 格式适配层；按链路注入 .dsh/skills 全文）
              │               ├─ openai_chat   {base}/chat/completions
              │               ├─ openai_responses {base}/responses
              │               └─ anthropic     {base}/v1/messages
           study-mate-web/data/  运行时数据（settings、sessions、uploads、exports）
           学习工作区 <WS>/.learning/subjects/  与插件同构（发现复用 learn_workspace()，默认 ~/StudyMate）
```

### 1.1 后端模块（backend/app/）

| 模块 | 职责 |
|---|---|
| `main.py` | 入口：lifespan（建工作区目录——**不自动种入示例**、pending 上传清扫）、路由注册、版本常量 |
| `config.py` | settings v3 读写（含 v2→v3 迁移）：`providers[]`（preset/custom + models[] + api_format）+ `active` + `system_prompt`；旧单 provider 自动迁移；`get_active_provider()`（`LLM_*` 环境变量运行时覆盖）；`STUDYMATE_WORKSPACE` / `STUDYMATE_DATA_DIR` |
| `llm.py` | 统一适配层：内部 openai 风格 content parts，按 api_format 三段分派（构造/流式解析/非流式解析）；`chat_once(fixture_kind=…)`；K 系列起承担工具轮次（`stream_turn` 聚合流式 tool_call）、瞬时失败重试与 900s 读超时；E2E fixture 门（`STUDYMATE_E2E_FIXTURE=1`） |
| `multimodal.py` | 视觉能力前缀表 + 覆盖判定；Stage-1 注入/占位；Stage-2 错误标记匹配剔除重试一次 |
| `doc_extract.py` | 附件"字节进文本出"：pdf(pymupdf→pypdf)/docx/xlsx/pptx/epub/文本类多编码；预算 20000/60000 字符 |
| `curriculum_store.py` | 课程仓储（`<WS>/.learning/subjects/<slug>/*.yaml` 读写校验）+ **掌握度状态机 TRANSITIONS（唯一实现）** + 新词表常量（IMPORTANCES/LAB_STATUSES/VERDICTS）；`workspace_dir()` 读 `workspace_ctx`（**会话级工作区的唯一收口点**，下游自动跟随） |
| `workspace.py` | 工作区发现：复用上游 `learn_workspace()`（子进程调用，失败回落 `~/StudyMate`）+ 进程内缓存 + 配置文件写回（行级替换保注释） |
| `workspace_ctx.py` | 请求级工作区绑定（ContextVar）：`resolve()`（无绑定回落发现结果）/ 可重入 `bind(path)` / `validate_dir()`；会话级工作区靠它生效 |
| `prompts.py` | 提示词分层：链路 → 技能映射（`SKILL_ROUTES`，各链路均已接线）+ `.dsh/skills/<名>/SKILL.md` 全文读取（缓存，缺失由调用方 503）+ Web 运行环境适配说明；`inject_role` 供角色派工循环用 |
| `memory.py` | 跨科目共享记忆 `MEMORY.md`：读侧 + 逐条确认后的分节增量插入（去重、不整篇重写） |
| `misconceptions.py` | 概念本双落点（misconceptions.yaml 为 canonical 源，旧条目补 id 幂等回写） |
| `records.py` | 评估/小结 front matter 解析渲染 + jsonschema 校验（读仓库 `schemas/`） |
| `storage.py` | 文件型会话存储（消息可带 attachments 元数据；**会话级 `workspace` 字段**；删会话连带删其上传目录） |
| `agent.py` | K0 agent loop runner：轮次/预算（探索 8 + 收尾 3 + 强制 1）/降级/重复提醒 + 工具执行与事件回吐（text / tool_call / tool_result） |
| `tools.py` | 工具注册表 + 沙箱边界（读写根 allow-list、写前当场 canonicalize、稳定拒答标记）；CHAT/BUILD/PRODUCE 三套工具集 |
| `audit.py` | 编排审计 `data/audit/<key>.jsonl`（contextvar 绑定编排键；派工值/原始回复/工具调用与结果追加落盘，失败不清除，敏感键脱敏） |
| `roles.py` | 角色派工基建：SKILL.md 全文注入（`prompts.inject_role`）+ envelope 解析/逐字落盘/搬位 + 路径模式归属映射 |
| `produce.py` | 产课链编排（讲解/出题派工 → 渲染 → 检查 → 按归属打回 → 工单；K3 起走工具循环，**工具调用对所有模型默认开启**、不按能力声明，上游拒绝 tools 时回落纯文本） |
| `build.py` | 建课链编排（大纲 + 采图并行 → `check_curriculum.py` 门禁 → 落盘；K2 起大纲走工具循环 + 门禁报错回喂自修） |
| `draft.py` | 建课草稿区（`data/drafts/<slug>/`，科目同构布局）+ promote 落点确认 |
| `image_scout.py` | 采图（纯后端爬虫：配额 / 过滤 / 命名 / 索引照搬插件，不进角色体系） |
| `tickets.py` | 质检工单存储、分组与状态流转 |
| `routers/` | chat（SSE：session/delta/notice/done/error + 课程上下文 + **开场状态切片** + 附件；会话级工作区绑定）、courses、uploads、settings（v3 + test）、**workspace（查看/改选 + 候选路径 + `?path=` 只读预览）**、lessons（列表/files/共享 assets/quiz/**附件区清单**，后四者支持 `?workspace=`）、misconceptions、practice（grade）、records（assess/summary/records，带会话的工作区绑定）、**memory（suggest/confirm）**、export（子进程 gen_home.py）、generate（子进程 check_curriculum.py 当门） |

### 1.2 前端结构（frontend/）

- 路由：`/chat`、`/courses`、`/misconceptions`、`/lesson`、`/generate`、`/settings`（重定向）→ `/settings/providers`、`/settings/system-prompt`、`/settings/theme`、`/settings/workspace`、`/settings/about`。
- 关键组件：`ChatView`（两态：欢迎区+起点 chips ↔ 消息流+落底，650ms 弹性过渡；用户气泡靠右、品牌色；顶栏含内联重命名；**新对话态输入区上方的「科目 + 工作区」关联行**）、`Composer`（📎 统一附件入口 + 拖拽/粘贴 + 输入框内模型选择器 + **推理档位独立下拉**）、`RightSidebar`/`RightRail`（可折叠/可拖拽的右侧边栏外壳，聊天页与课程图谱页共用；聊天页内含**附件区清单**（按会话工作区读）与会话信息）、`lib/useResizable`、`lib/workspace`（工作区/科目上下文 + 会话级 `activeWorkspace` + 课程页 `currentSubjectSlug`）、`MemoryDialog`（**当前无入口，悬空保留**）、`ModelSelector`（仅提供商/模型切换）、`settings/ProvidersView`（主从布局 + 启用开关 + 只读模型行四操作 + **实时生效、无保存按钮**）、`settings/ModelEditDialog`（基础区 + 高级折叠区）、`settings/SystemPromptView`、`settings/WorkspaceView`（工作区查看/改选）、`settings/AboutView`、`LessonView` + `GradingPanel`（课件 iframe + 开放题判分；窄屏可读性）、`MisconceptionsView`、`CourseGraphView`（**主区 = 科目头部（含科目状态/进度总览）+ 节点详情卡；右栏顶部「图谱 / 大纲」分段切换**；导出按钮在头部）、`NodeDetail`（含**本节点误解**区）、`Sidebar`（导航 + 会话/科目 + 底栏设置与明暗切换，可拖拽调宽 + 折叠成图标轨）、`WorkspaceOnboarding`（**已无引用，悬空保留**）。
- 样式体系：Tailwind + CSS 变量（亮/暗两套，`data-theme` 由 layout 内联脚本首帧前写入，localStorage 优先否则跟随系统）；品牌色走 `--brand-rgb` 变量（支持透明度修饰）；TS 严格模式，除 page/layout 外具名导出。
- 测试：Playwright（`tests/e2e/`，旅程级用例，映射表见 E2E 测试流程文档）。

### 1.3 对外契约要点

- **SSE 事件**：`session` / `delta` / `notice`（非致命提示，不进历史）/ `done` / `error`；工具化 chat 另发 `tool_call` / `tool_result`（前端渲染可展开工具卡，兼审计 UI；不落会话历史，持久审计在 `data/audit/*.jsonl`）。
- **settings v3**：`providers[].api_format ∈ {openai_chat, openai_responses, anthropic}`；`models[].vision ∈ {auto, on, off}` + 输入模态（`modalities`）+ `max_output_tokens` / `context_window` / 有序 `reasoning_variants`（+ 默认档）+ 能力声明；`active = {provider_id, model, reasoning_variant?}`；API Key 回填输入框（不再掩码回传）。
- **会话级工作区（2026-10-04）**：会话 JSON 与 `/api/sessions` meta 多一个 `workspace`（绝对路径，null = 跟随默认）；`POST /api/sessions`、`POST /api/chat/stream`（仅新建会话时生效）与 `PATCH /api/sessions/{id}`（`{title?, workspace?}`，`null` 显式清空）可写入；科目类 GET（`/api/courses`、`/api/courses/{slug}`、`.../attachments-area`、`.../files/{path}`）可带 `?workspace=<绝对路径>`；`GET /api/workspace?path=` 只读预览任意目录。绑定要求目录已存在（否则 422）。
- **附件**：`POST /api/uploads`（≤20MB）先传后引；消息带 `attachment_ids`；存储 `<study-mate-web>/data/uploads/<session>/<id>_<filename>`，pending 超 24h 清扫。
- **版本**：三处一致（package.json / main.py / 侧边栏读 package.json）；语义化、仅标识 StudyMate Web、变更需维护者同意。

## 2. 关键机制与不变约束

1. **状态机唯一实现**在 `curriculum_store.py` 的 `TRANSITIONS`；完成口径 = 能独立应用 + 已通过项目验证；与根目录 `schemas/*.schema.json` 口径一致，词表常量单处定义。
2. **门禁调上游脚本不重写**：大纲 → `scripts/check_curriculum.py`；导出 → `scripts/gen_home.py`（均子进程调用，脚本缺失 503，FAIL 透出问题清单）。
3. **模态两段式**：输入端不拦截；发送端按能力注入或占位（"[图片：<文件名> —— 当前模型不支持图片输入，已剔除]"）；带图请求被上游以模态错误拒绝时剔除重试一次（已知视觉模型不降级）；视频/音频一律占位。
4. **双落点**：`progress.misconceptions[]` 与科目 `misconceptions.yaml` 逐字一致（含 id/date/node），最近在前。
5. **E2E fixture 隔离**：`STUDYMATE_E2E_FIXTURE` / `STUDYMATE_DATA_DIR` 仅测试生效，未设置时行为与生产完全一致。
6. **Next 16 两个已知坑**：生产构建把 rewrites 代理目标固化进 `.next/routes-manifest.json`（改 BACKEND_PORT 需重新 build，dev 运行期读取）；`next.config.js` 必须 `compress: false`（否则代理 gzip 把 SSE 缓冲到结束一次性吐出，流式失效）。
7. **运行时产物不入库**：见 `study-mate-web/.gitignore`。
8. **工作区同构与发现复用**：学习数据在 `<WS>/.learning/subjects/<slug>/`，工作区发现一律走 `app/workspace.py`（复用上游 `learn_workspace()`，Web 不实现第二份规则）；默认工作区 `~/StudyMate` **不自动种入示例**（它可能正是插件在用的目录）。
9. **提示词分层**：默认 persona（可改）+ 各链路按需读取并**全文**注入 `.dsh/skills/<名>/SKILL.md`（不裁剪、不在 Web 侧复述规则）；技能规范缺失时该次调用明确 503。
10. **评估通过是权威置位**：实验课通过时该节点与 `prerequisites` 里被验收节点同置"已通过项目验证"（掌握度**保留或上调**，不降级）并写学习记录；会话摘要同日**按段追加**不覆盖；共享记忆只在用户逐条确认后**增量插入**分节（入口：手动 / 小结后建议 / 评估通过后建议）。
11. **后端单测门禁**：`backend/tests/`（pytest + TestClient，隔离环境）覆盖工作区、提示词注入、开场切片、联升、摘要追加、记忆写侧；改后端功能需 `python -m pytest tests` 通过（见 AGENTS.md 规则 1）。
12. **会话科目绑死（2026-10-04）**：科目关联的唯一入口是**新对话态输入区上方的关联行**，首条消息发出后入口随新对话态一并消失 —— 即"换科目 = 新会话"（新会话不继承）；interview 会话发起时不带科目关联；节点聚焦未指定时由后端按进度推断（学习中 → 第一个未开始），推断只作用于注入、不落盘；前端不提供节点下拉。课程图谱页主区 = 科目头部 + 节点详情，**大纲与图谱都在右栏做「图谱（默认）/ 大纲」分段切换**。
13. **工具化调用不变量（2026-10-04 K 系列）**：SKILL.md 全文注入保留（另加 `read_skill` 按需补充）；**上游脚本零重写**；**门禁仍由后端在写盘后强制执行**（不信任模型自查）；质检工单只做循环耗尽后的人工兜底；采图保持纯后端爬虫、不进角色体系；文件读写以会话工作区/科目目录为界；**工具调用默认对所有配置的模型开启**，上游拒绝 tools 时自动回落纯文本一次，循环无交付时回落既有单次派工链兜底；工具化编排的事件序列**追加落盘**为审计证据，失败不清除。
14. **会话级工作区（2026-10-04 拍板"甲"）**：会话各自绑定工作区（`null` = 跟随当前默认工作区），**不做全局切换**。唯一收口点是 `curriculum_store.workspace_dir()` 读 `workspace_ctx.resolve()`——加工作区能力时改这一处即可，不要逐个下游加参数。会话端点用 `with workspace_ctx.bind(ws)` 包住处理体；**SSE 生成器在迭代期要各自重挂绑定**（StreamingResponse 在别的任务里迭代）。带 `workspace` 的绑定点要求目录已存在（否则 422）；`workspace_ctx.bind` 必须可重入（token 还原），跨请求不泄漏由 pytest 守住。

## 3. 领域模型参考

- **curriculum.yaml**：`nodes[]`（id 小写点横线分段 / title / kind 概念·实操·实验 / objective / problem / prerequisites / concepts / resources / practice / pitfalls / realworld / status / mastery）、`edges[]`（from/to/reason）。顺序即教学位次。
- **progress.yaml**：`updated_at`、`nodes`（status/mastery/notes/lab_status）、`misconceptions[]`（topic/question/misunderstanding/answer_summary/follow_up/importance + id/date/node）、`project.current`。
- **assessment / session-summary / subject**：front matter 记录契约见根目录对应 schema；评估 verdict 三档，通过走状态机（实验课→已通过项目验证，其余→能独立应用）。
- 科目级 `misconceptions.yaml`：与 progress 侧双落点，最近在前。
- 原始口径：根目录 `schemas/*.schema.json`（唯一来源）、`scripts/statuses.py`。

## 4. 与上游仓库的关系

- **数据合同**：以根目录 `schemas/` 为唯一来源；workspace 布局与 `.learning` 同构，`STUDYMATE_WORKSPACE` 可直指已有静态工作区。
- **脚本复用**：`backend/` 通过 `REPO_ROOT/scripts/` 子进程调用上游门禁（见 §2.2）；上游脚本缺失时明确 503，不静默降级。
- **文档**：上游 docs/ 按用途归位（使用/规范/设计/agents）；上游领域约束见根 `AGENTS.md` → `docs/规范/工程约束.md`。仓库级贡献规则见根 `CONTRIBUTING.md`。
- **git 布局**：origin = 维护者 fork（PR 目标），upstream = Miaotofu01/Study-Mate（本地 main 仅 ff-only 拉取）；根目录文件保持上游原样，web 专属配置都在本目录。
- ** Sayo UI 边界**：上游静态产物（主页/课件）的组件基座，不集成进 Web 前端；唯一交集是 `/lesson` iframe 内上游课件自带的资产（经 `/api/courses/assets/*` 兜底供给）。

## 5. 待实现计划（backlog）

按优先级（随时增删，完成后移入 Web_CHANGE 留痕）：

| # | 计划项 | 说明 | 来源 |
|---|---|---|---|
| 1 | ~~E2E 旅程级用例补齐~~ | **已完成（2026-10-02）**：25 条用例全绿、两轮幂等，见 Web_CHANGE | E2E 测试流程 |
| 2 | docs/ 新增 web 版文档 | 推进至可 PR 状态后再建；现阶段只写计划（2026-10-02 维护者） | 维护者要求 |
| 3 | 真实模型端到端验证（收尾） | 2026-10-03 已用 my-api 真实验证三条生产链（见 Web_CHANGE）；**2026-10-04 补工具循环冒烟**：`backend/tests/test_smoke_real_llm.py`（`SMOKE_REAL_LLM=1` 门控，默认跳过）对活跃渠道真跑一次"tools 声明 → tool_call 聚合 → 工具执行 → 结果回喂 → 最终答复"（space-bunny-alpha / Deepseek-v4-flash 均通过）。剩余：anthropic / openai_responses 两格式真实流式验证 | 各阶段遗留 |
| 4 | 视频/音频附件实发 | 现一律占位；按三协议能力评估后放开 | PRD §3.2 裁剪 |
| 5 | 文档内嵌图片提取 + OCR | 对照 DeepTutor document_images 的标记机制 | PRD §4.5 裁剪 |
| 6 | ~~lab 任务内容~~ | **已完成（随产课链 C，2026-10-03）**：实验节点经 produce_experiment 派工产出 lab/ 任务树 + solutions/，lab_status 四态接口已接线；沙箱执行 2026-10-03 移回计划（#15） | 阶段 3 方案延后 |
| 7 | ~~跨科目共享记忆（MEMORY.md）读写~~ | **已完成（2026-10-02）**：写侧 = 建议 → 逐条确认 → 分节增量插入；读侧 = 开场状态切片带 MEMORY 分节，见 Web_CHANGE | grill 决策 |
| 8 | 会话存储 SQLite 迁移 | 文件型会话量大后的演进 | 阶段 1 已知限制 |
| 9 | 主动检索（resource-scout 等价） | 2026-10-03 维护者拍板移回计划（原 2026-10-02 列入"明确不做"）：产物沿用 reference/ + RESOURCES.md 落盘结构化（落点已存在，见 draft.py / production.py）；检索通道待拍板——模型原生联网搜索（依赖 #14 接线与网关支持）或后端搜索 API（引入外部依赖）；形态倾向对齐 image-scout（纯后端、不进角色体系） | 妥协清单二档；2026-10-03 拍板 |
| 10 | 真实 Key 下的思考档位验证 | openai_chat 格式已随 2026-10-03 冒烟真实验证（五模型 reasoning medium 全程生效）；anthropic / openai_responses 两格式思考参数仍未对真实端点验证，并入 #3 收尾 | 反馈清单轮遗留 |
| 11 | E2E 渲染矩阵（P3） | `colorScheme` 矩阵 + 关键雷区定向 `toHaveCSS`；暗色 `<select>` option 现靠 CSS 规则修，无断言兜底 | E2E 流程 §2.3 |
| 12 | ~~E2E 组件测试层（P4）~~ | **已完成（2026-10-04）**：选型 vitest + Testing Library（jsdom；弃 Playwright CT——experimental 且要在 Next 仓库养平行 Vite 配置）；`npm run test:component` 13 条用例下沉三分支；组件层不进根门禁（与 E2E/pytest 同口径） | E2E 流程 §2.3 |
| 13 | 干掉 `vision` 字符串垫片 | `get_active_provider()` 目前由 modalities 派生 `vision` 三态字符串喂给 `chat.py`（该文件不在改单内）；应改为直传 `modalities` 并删垫片 | v3 迁移遗留 |
| 14 | ~~能力声明接线~~ | **工具调用已定档为默认开启（2026-10-04），不再是可选项**，`capabilities.tool_call` 字段保留但不再参与门控（界面亦不再提供开关）；`json_schema_output` / `native_web_search` 仍仅落盘展示 | v3 迁移遗留 |
| 16 | K4 总控全 agent 化 | K2/K3 工具循环完成后按效果决定；参考尽调存档 §七（子代理=一个返回结构化结果的工具、前台 one-shot、后台/可续二期） | K 系列 |
| 15 | lab 代码沙箱执行 | 2026-10-03 维护者拍板移回计划（原明确不做）。v1 = 本机子进程沙箱：隔离工作目录 + 超时 + 进程树终止 + 输出捕获，运行结果对接 lab_status 流转（待提交 → 待评估），输出可作 LLM 判 lab 依据；强隔离（容器/WASM）后议。待拍板：触发时机（学生提交时跑 / 顺带自动验 LLM 参考答案） | 2026-10-03 维护者拍板 |
| 17 | 小结 / 沉淀记忆入口接回 | 2026-10-04 拍板：右栏「会话关联」整段移除后，「生成小结」与聊天侧「沉淀记忆」两个入口**悬空**（后端端点、`MemoryDialog.tsx`、`WorkspaceOnboarding.tsx` 都保留未删）。接回时把入口挂到输入区工具条或消息操作条即可；`memory-flow.spec.ts` / `session-summary.spec.ts` 里 `test.skip(true, …)` 那行一并摘掉 | 2026-10-04 拍板 |
| 18 | 会话级工作区：允许指向尚不存在的目录 | 当前带 `workspace` 的绑定点要求目录已存在（否则 422）。若要支持"先指向一个空目录再冷启动"，放宽 `create_session` / `PATCH` / `optional_workspace` 的存在性校验即可（一行之差） | 2026-10-04 实施遗留 |

> 2026-10-04 第二轮 UI 杂项轮：会话级工作区（拍板"甲"，`workspace_ctx` 单收口点）/ 新对话「科目 + 工作区」关联行 / 右栏「会话关联」移除（小结与沉淀记忆入口悬空，见 #17）/ 对话框推理档位独立下拉（模型弹层 chip 删除）/ 课程页再对调（大纲与图谱都进右栏做分段切换 + 科目状态进头部 + 缩放灵敏度调优 + 重置视口）；同轮修掉一枚"图谱可能整体不渲染"的 ref 竞态 bug（详见 Web_CHANGE 同日条目）。
>
> 2026-10-02 提供商/模型域 v2 轮：提供商页 zcode 形态重建与模型级思考档位（F2/F8）、测试连接回落已存 Key（F1）、对话壳层与右侧边栏（F6/F9）、按会话草稿缓存（F10）、logo 图标（F3）、暗色下拉（F4）、概念本科目必填（F5）、侧边栏拖拽调宽（F7）；同轮修掉 `playwright.config.ts` 与 `tests/e2e/constants.ts` 两处 E2E 路径口径 bug。
> 2026-10-02 提供商/模型域 v3 轮（对照 ZCode 真实实现）：模型 schema 升到 v3（输入模态复选框组 / 最大输出 Token / 上下文窗口 / 推理档位有序 chip 编辑器 / 能力声明），API Key 改为**回填输入框**不再掩码吞掉；右侧边栏抽成 `RightRail` 共享外壳并支持拖拽 + 折叠动画，课程图谱页节点详情改由它承载。版本号按维护者要求加 `-beta` 后缀（0.4.0-beta）。

> 2026-10-03 生产侧实施轮（C/D/E/F/J 落地）+ 真实 LLM 冒烟：基线式子代理（无工具单次调用、SKILL.md 全文注入、派工值内联、JSON envelope 交付、路径模式归属打回、质检工单转人工）全链落地；用维护者的 my-api 把判分 / 评估 / 课件产出三条链各跑真实冒烟——判分与评估一次通过（judge 口径准确、评估联升与记录落盘正确），产出链全机制走通（派工交付含 lab/ 整棵树 → 渲染/检查打回 → 重派 → 工单）。冒烟踩出三枚基建问题并修复：Windows 注册表系统代理经手本机网关（本机 base_url 挂精确 host 直连 mounts）、读超时 300s→900s（mimo-medium 单派工全程 694s）、派工 envelope 偶发畸形加原值重派兜底（pytest 38 条全绿）。模型选型（my-api 五模型，均带思考档）：产出链用 space-bunny-alpha（两节点 3 分钟，快 13 倍，合规性弱靠工单兜底），质量敏感面（对话/评估）用 mimo-v2.6-flash（单节点 40 分钟，内容最好），agnes 无速度优势弃选、u2-flash 耗时与产出倒挂排除。版本号 0.4.0-beta → **0.5.0-beta**。

### 5.1 全功能复现实施队列（2026-10-02 维护者拍板；A~J 已于 2026-10-03 全部实施）

目标：Web 复现乃至拓展 dsh 插件全功能，"只消费已有产物"旧边界作废。

**实施进度（截至 2026-10-03，队列 A~J 全部落地）**：**A / B / H（四项）/ I** 于 2026-10-02 落地并通过验证（留痕见 Web_CHANGE 同日条目）；G 的"开场状态切片"与"附件区入口"随 H 完成。**C 产课链 / D 开课链 / E 采图 / F 方向探索 / J chat 链路收口** 于 2026-10-03 由维护者拍板重启并全量实施（生产侧基线式子代理：无工具单次调用、SKILL.md 全文注入、值内联、envelope 交付、路径模式打回、质检工单转人工——详见各行修订注与下方 J 行），同轮经两轮只读代理审查（4 P0 + 17 P1 全修）与**真实 LLM 三链冒烟**（判分/评估通过、产出链机制全通，详见本文件顶部 2026-10-03 记录）；后端 pytest 38 条、E2E 48 条两轮幂等。

顺序按依赖排：工作区是根（一切读写的前提），提示词是各链路的公共输入，产课链与验证集可并行。

| 阶段 | 计划项 | 拍板内容（要点） | 依赖 |
|---|---|---|---|
| A | **工作区与发现（根）** ✅ 已完成（2026-10-02；选目录形态 2026-10-03 定） | Web 工作区改 `<WS>/.learning/subjects` 同构布局；发现复用 `scripts/gen_home.py::learn_workspace()`（**不重写**，硬规矩 3）：显式参数 > `STUDYMATE_WORKSPACE` > `LEARN_WORKSPACE` > `STUDYMATE_CONFIG`/`$DSH_HOME/studymate-config.yaml`；默认沿用插件默认 `~/StudyMate`（不新造 `~/.studymate`）。**选目录入口**（维护者裁定）：`/chat` 新会话欢迎区的「选择学习工作区」引导块（仅工作区无科目时出现，候选 + 手输），设置页工作区子页作为查看/进阶入口保留；`seed/` 不再自动种入。**（2026-10-04 第二轮改形态：引导块移除，改为新对话关联行的「工作区」下拉 + 会话级绑定，见下方同轮轮注与 §5 backlog #18）** | 无 |
| B | **提示词分层** ✅ 已完成（2026-10-02） | 默认 = persona 前缀（取 `preset/learning/agent.cordis.yml` 的主教练口径，设置页仍可改）+ 各链路按需读 `.dsh/skills/<名>/SKILL.md` 全文注入：备课产课→`lesson-design`+`layered-practice`，答疑→`local-qa`，档案→`record-keeping`，评估→`practice-evaluator`+`evidence-check`，盘问→`learning-system`，探索→`learning-discovery`。新增 `backend/app/prompts.py`；`DEFAULT_SYSTEM_PROMPT` 改为 persona 常量 | A（skills 目录定位走 workspace/engine root） |
| C | **产课链**（拍板修订 2026-10-03：引入基线式子代理，弃"约束写进 prompt"） | **子代理 = 后端无工具单次 LLM 调用**：system = 角色 SKILL.md 全文 + 运行环境适配声明，user = 派工值；agent harness 仍不做，后端承担总控机械职责。链路：讲解（`learning-coach` 全文注入，派工值内联节点字段/术语表/科目使命/资源清单与 reference/ 落盘原文）→ 出题（`practice-evaluator` 时机一，课件内容文件内联，多文件 lab 走 JSON envelope `{files:[{path,content}]}` 逐字落 `.stage/.../deliver/` 再搬正式位）→ `render_lesson.py` 渲染 → `check_lesson.py` 质检。**打回归属 = 路径模式映射**（`lessons/*.md`→讲解；`*.quiz.json`+`lab/**`→出题；组件缺失→后端按 `templates/assets/` 自补），重试上限 2 轮、重派附报错原文证据；派工 envelope 契约失败（模型偶发畸形 JSON）同样原值重派 2 次、耗尽 error 停止（2026-10-03 真实冒烟实测偶发，复派即合规）；耗尽转人工 = 质检工单（chat `handoff` 失败卡 + 两段式模态：总览按归属分组 / 逐项快改与仅重试此项；不做 Web 内编辑器，大改走绝对路径+外部编辑+重新检查）。上游脚本零重写，缺失 503 | B |
| D | **开课链**（拍板修订 2026-10-03：盘问注入 learning-system 全文 + 机器可读收口） | ① 落点 = 后端草稿区 `data/drafts/<slug>/`（对标 `.studymate-stage/<slug>`，同构科目布局）+ 一次落点确认（promote 到工作区后跑 `gen_home.py` 刷主页）；② 盘问 = chat 内建课会话（session `mode=interview`），注入 `learning-system` + `learning-discovery` 全文（方向探索是其可选入口，F 同此实现），盘问结束由模型在回复末尾输出 `<!--INTERVIEW_RESULT-->{JSON}<!--/INTERVIEW_RESULT-->` 标记，后端解析建草稿并在会话里落「确认建课」卡；③ 落盘结构化资料：用户给料（粘贴/上传）→ `doc_extract` 转 Markdown → `reference/` + `RESOURCES.md`，**不做主动检索**；④ 建课编排（SSE，进度按阶段播报进会话）：资料落盘 → 大纲（`curriculum-designer` 派工，JSON 图输出）与采图（E）**并行** → `check_curriculum.py` 门禁 → 写 progress/组件 → done 落「落点确认」卡。大纲门禁打回同 C 的归属/重试/工单规则 | A、B |
| E | **采图（image-scout 等价）**（拍板修订 2026-10-03：纯后端爬虫，不进 LLM 角色体系） | 后端模块沿 `RESOURCES.md` 抓现成位图，配额照搬（每站 8 页/6 张、≤1 请求/秒、尊重 robots、不抓 PDF 与动态加载），过滤照搬（去图标/头像/装饰/广告、宽 <400px、>500KB），命名（术语表用词、`<主题>-<子主题>-<要点>-<来源缩写>-<NN>`）与索引（`assets/img/pool.md` 七列 + `## Gaps`）照搬，图片落 `assets/img/pool/`；抓不到只记 Gaps 不阻塞建课；`check_pool.py` 自检 | A、B、D |
| F | **方向探索（learning-discovery 等价）**（实现形态 2026-10-03 定） | 不做独立链路：chat 欢迎区「不知道学什么」起点 → 建课会话（`mode=interview`），`learning-discovery` 全文随 `learning-system` 注入，探索协议（五问左右给 2–3 个可组合方向、选中复用答案进盘问、探索期不写盘）按技能原文执行；三级确认分开（确认方向 ≠ 确认建课卡 ≠ 落点确认）。E2E 映射表对应行由"不适用"改"已覆盖"并补用例 | D |
| J | **chat 链路收口**（2026-10-03 拍板⑧，随 C/D 落地生效） | 会话关联科目后（`mode=chat`）chat 注入退回 `local-qa` + persona（开场报告/「下一步」仪式由 persona 承担），总控职责归还后端编排；`learning-system` 只在建课会话注入。开场切片、评估、摘要、记忆写侧链路不受影响 | C、D |
| G | **阅读端壳层** ✅ 已完成（2026-10-02） | `/lesson` 维持 iframe 承载上游渲染产物；Web 只做壳。上游静态 HTML 保留为离线入口（与"导出静态工作区"衔接）。增量改进只四类：开场状态切片、附件区入口、主题/导航一致性、移动端可读性；**不碰渲染产物** | 无 |
| H | **验证集（本轮先做）** ✅ 已完成（2026-10-02） | 四项全选，每项至少一条旅程级 E2E 用例：① 开场状态切片（MEMORY 分节 + 最近 5 误解/3 学习记录/3 评估记录）；② 开场报告 + 每轮「下一步」仪式（提示词行为）；③ 评估联升（实验课通过→该节点与 `prerequisites` 被验收节点同置"已通过项目验证"）+ 学习记录（仅可观察证据时写）；④ 摘要同日多段追加（替 `write_text` 覆盖）+ 附件区入口（reference/术语表/学习记录/会话摘要可读） | A、B |
| I | **记忆写侧** ✅ 已完成（2026-10-02；触发接线 2026-10-03 补齐） | 会话结束/评估通过时后端组 `memory_updates` 建议 → UI 待确认条目 → 用户逐条确认后写 `.learning/MEMORY.md`（增量修改不整篇重写）；读侧同步进开场切片（H①）。**触发入口**：小结结果区用 `summary.memory_updates` 预填、评估通过后从会话提炼，加上原有的手动入口，共三个 | H① |

**K 系列工具化改造（2026-10-04 拍板 + 实施，队列外增补）**：维护者推翻拍板①（子代理=无工具单次调用），重建工具化 agent loop 对齐插件基线。K0 基建（三格式 tools 映射 + 流式聚合 / agent loop 预算与降级 / 沙箱边界 / 审计落盘 / SSE 工具事件与工具卡 / fixture canned tool_calls）→ K1 chat 只读工具（`list_workspace` / `read_course_file` / `read_skill`）→ K2 建课链大纲工具循环（`submit_curriculum` + 门禁回喂自修）→ K3 产课链工具循环（`write_deliver_file` + `run_check` 循环内自修）**已于同日全量落地**；**工具调用随后定为默认对所有配置的模型开启**（不再依赖能力声明，上游拒绝 tools 时自动回落纯文本），并补上门控真实冒烟（后端 pytest 64 条 / E2E 53 条全绿）。K4 总控全 agent 化为远期可选（backlog #16）。设计输入见 `K系列尽调-DSH与DeepTutor工具机制存档.md`；决策与实施留痕见 Web_CHANGE 2026-10-04 条目。

### 5.2 明确不做（2026-10-02 维护者）

- **账号体系 / 云同步**：不碰（设计方案 §2 YAGNI）。

> 2026-10-03 维护者拍板：原列于此的「主动检索」移回待实现计划（#9，与表内旧 #9 检索能力行合并）、「lab 代码沙箱执行」移回待实现计划（#15）。
