# StudyMate Web 开发与计划

> 版本：v1.1（2026-10-02，实施轮 A/B/H/I+G 落地后更新）
> 定位：**已有实现的开发文档 + 待实现的计划文档**。描述系统当前架构、关键机制与不变约束、领域模型、与上游仓库的关系，以及后续计划。
> 文档分工：功能规格与实施状态 → [StudyMate-Web_PRD.md](StudyMate-Web_PRD.md)；测试流程与用例映射 → [StudyMate-Web_E2E测试流程.md](StudyMate-Web_E2E测试流程.md)；旧计划与变更史（只追加）→ [Web_CHANGE.md](Web_CHANGE.md)；启动/配置/附件/E2E 运行/版本语义 → [README.md](README.md)。
> 维护约定：功能落地或变更时同步 PRD；计划项完成/新增/放弃时更新本文第 5 节；里程碑与重要决策追加进 Web_CHANGE。

---

## 1. 架构现状（0.7.0-beta）

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
| `config.py` | settings v3 读写（含 v2→v3 迁移）：`providers[]`（preset/custom + models[] + api_format）+ `active` + `system_prompt`；旧单 provider 自动迁移；`get_active_provider()`（`LLM_*` 环境变量运行时覆盖） |
| `llm.py` | 统一适配层：内部 openai 风格 content parts，按 api_format 三段分派（构造/流式解析/非流式解析）；`chat_once`；承担工具轮次（`stream_turn` 聚合流式 tool_call）、瞬时失败重试与 900s 读超时；透出思维链与用量（→ `reasoning` 增量 / 用量事件）；E2E fixture 门（`STUDYMATE_E2E_FIXTURE=1`） |
| `multimodal.py` + `doc_extract.py` | 附件：多模态前缀/占位与模态错误剔除重试一次；"字节进文本出"（pdf/docx/xlsx/pptx/epub/文本类多编码，预算 20000/60000 字符） |
| `curriculum_store.py` | 课程仓储（`<WS>/.learning/subjects/<slug>/*.yaml` 读写校验）+ **掌握度状态机 TRANSITIONS（唯一实现）** + 词表常量；`workspace_dir()` 读 `workspace_ctx`（**会话级工作区的唯一收口点**，下游自动跟随） |
| `workspace.py` + `workspace_ctx.py` | 工作区发现（复用上游 `learn_workspace()`，失败回落 `~/StudyMate` + 缓存 + 配置写回）；请求级绑定 ContextVar（`resolve()` / 可重入 `bind()` / `validate_dir()`） |
| `prompts.py` + `roles.py` | 提示词分层（链路 → 技能映射 + `.dsh/skills/<名>/SKILL.md` 全文读取，缺失由调用方 503 + 运行环境适配）；角色派工基建（`inject_role`、envelope 解析/落盘/搬位、路径模式归属映射） |
| `memory.py` + `misconceptions.py` | 跨科目共享记忆 `MEMORY.md`（分节增量插入）；概念本双落点（misconceptions.yaml 为 canonical 源） |
| `records.py` + `tickets.py` | 评估/小结 front matter 解析渲染 + jsonschema 校验（读仓库 `schemas/`）；质检工单存储、分组与状态流转 |
| `storage.py` + `audit.py` | 文件型会话存储（消息 attachments 元数据；**会话级 `workspace` + 会话级 `active` 模型三元组**；助手消息 `reasoning`/`tools`/`model`；会话级 `usage`；`drop_messages`/`truncate_messages` 为消息级操作原语；删会话连带删上传目录）；编排审计 `data/audit/<key>.jsonl`（contextvar 绑定编排键；派工值/原始回复/工具调用与结果追加落盘，失败不清除，敏感键脱敏） |
| `agent.py` + `tools.py` | agent loop runner（轮次/预算：探索 8 + 收尾 3 + 强制 1 / 降级 / 重复提醒 + 工具执行与事件回吐 text·reasoning·tool_call·tool_result·usage；`AgentOutcome` 汇总供落库；fixture 含 tools/process）；工具注册表 + 沙箱边界（读写根 allow-list、写前 canonicalize、稳定拒答），`CHAT_TOOLS` / `CHAT_ACTION_TOOLS`（仅科目关联会话）/ `BUILD_TOOLS` / `PRODUCE_TOOLS`；动作工具把 stage/retry/done/progress 转中文 `notice`（节流 ~10s）回吐 |
| `errors.py` | 统一错误对象 `ErrorInfo`（`code` / `status` / `upstream_code` / `phase` / `summary` / `detail` / `retryable` / `stopped_reason` / `request_id` / `source` / `operation`）；`request_id` = 本轮 `turn_id`；上游流缺结束标记判 `UpstreamEOFError`；**停止按 `(session_id, turn_id)` 作用域**（`register_turn` / `clear_turn` / `request_stop` / `consume_stop` / `active_turn`，`user_stop` 仅停止入口登记） |
| `produce.py` + `build.py` | 产课链（派工 → 渲染 → 检查 → 按归属打回 → 工单；走工具循环，**工具调用对所有模型默认开启**，上游拒绝 tools 回落纯文本）；建课链（大纲 + 采图并行 → `check_curriculum.py` 门禁 → 落盘；大纲走工具循环 + 报错回喂自修）；`curriculum_values` 内联 schema 全文；**门禁非零退出但解析为空时判失败**；备用（回落 / 直连）角色带 `execution_mode`（tools/fallback/single_call）与 `fallback_reason`/`max_seconds`/`elapsed_s`/`message`，按真实 start/done/error 呈现（envelope 返回≠自检通过）；**既有产物复用**需 无新文件 + `regenerate=false` + ctx `check_passed` + required 目标存在可读非空（出题 `*.quiz.json` / 其余 `*.md`），**强制重做与工单 retry 禁复用**；`regenerate` 严格 bool、`true` 需显式 `node_id`；非 UTF-8 不复用；quiz / ticket 交付同 gate；真实 timeout → 角色终态、任务非 running 隐藏当前阶段、本地停止 roles 同终止；**实操 / 实验 lab 交付 required**（`lab/<NNNN>-stage/README.md` + `lab/solutions/<NNNN>-stage/README.md` + `lab/README.md`，缺一不 promote）；**打回次数分开 `repair_rounds` / `rechecks`**（总控只复检不占派工轮） |
| `draft.py` + `image_scout.py` | 建课草稿区（`data/drafts/<slug>/`，科目同构）+ promote 落点确认（同名 strip+casefold 返回既有草稿）；采图（纯后端爬虫：配额/过滤/命名/索引照搬插件，不进角色体系） |
| `routers/` | 路由层：chat（SSE + 课程上下文 + 附件 + 会话级工作区绑定 + `replace_from` 编辑重发 + 删除整轮 + 科目关联会话动作工具）、home（服务工作区 `index.html` 及相对引用）、courses、uploads、settings（v3 + test）、workspace、lessons（files/assets/quiz/附件区清单支持 `?workspace=`）、misconceptions、practice（grade）、records、memory（suggest/confirm）、export（子进程 gen_home.py）、generate（子进程 check_curriculum.py 当门）、production（`_provider` 按会话绑定取模型，promote 自动关联触发会话） |

### 1.2 前端结构（frontend/）

- 路由：`/chat`、`/courses`、`/misconceptions`、`/lesson`、`/generate`、`/settings`（重定向）→ `/settings/providers`、`/settings/system-prompt`、`/settings/theme`、`/settings/workspace`、`/settings/about`。`/courses` **不带 `?subject=` 是「我的课程」**（内嵌工作区主页、无右栏），带 `?subject=` 才是科目课程页。
- 关键组件：`ChatView`（欢迎区/消息流两态 + 消息操作条：用户复制/编辑、助手复制/记入概念本/删除本轮（内联二次确认）+ 「中间过程」折叠区只留思维链与本轮提示，工具卡常显消息体，皆空不渲染 + 顶栏内联重命名 + 新对话态「科目 + 工作区」关联行 + 建课完成卡）、`Composer`（统一附件入口 + 拖拽/粘贴 + 模型选择器 + 推理档位独立下拉）、`RightSidebar`/`RightRail`（可折叠/拖拽右栏外壳，聊天页与课程图谱页共用；含上下文窗口栏 + 科目「图谱/大纲」区 + 附件区清单 + 会话信息）、`SubjectGraphPanel`（课程页与聊天右栏共用）、`HomeEmbed`（内嵌工作区主页 iframe，跟随 web 主题）、`lib/contextWindow`、`lib/useResizable`、`lib/workspace`（工作区/科目上下文 + 会话级 `activeWorkspace`）、`MemoryDialog`（**悬空保留**）、`ModelSelector`、`settings/ProvidersView`（主从 + 实时生效、无保存按钮）、`settings/ModelEditDialog`（默认值留空即兜底，不预填）、`settings/SystemPromptView`、`settings/WorkspaceView`、`settings/AboutView`、`LessonView` + `GradingPanel`、`MisconceptionsView`、`CourseGraphView`（不带 `?subject=` = 我的课程；带 = 科目头部 + 节点详情 + 右栏分段切换）、`NodeDetail`（含误解区，保留工单角标；产课/评估改由聊天 agent 工具）、`Sidebar`（可拖拽调宽/折叠）、`WorkspaceOnboarding`（**悬空保留**）。
- 样式：Tailwind + CSS 变量（亮/暗两套，`data-theme` 由 layout 内联脚本首帧前写入）；品牌色走 `--brand-rgb`；TS 严格模式。测试：Playwright（`tests/e2e/`，旅程级用例，映射见 E2E 文档）。

### 1.3 对外契约要点

- **SSE 事件**：`session` / `delta` / **`reasoning`** / `notice`（收进「中间过程」折叠区）/ `done` / `error`；工具化 chat 另发 `tool_call` / `tool_result` / **`usage`**。思维链、工具调用与用量都**随助手消息落库**，刷新后可回放；完整审计仍在 `data/audit/*.jsonl`。
- **错误契约（2026-10-06 本轮，已实施）**：`error` 事件把 `ErrorInfo` **平铺**进 data（另带 `message`）；HTTP 错误体 `{detail: summary, error: ErrorInfo}`；助手消息持久化 `error` + `stream_state="error"`（**空正文但有 error 不过滤**，刷新 / 切会话可重放）。前端 `ErrorNotice`（`role=alert`、`data-error-tone` danger 红 / neutral 用户停止、展开详情、复制诊断）在聊天与任务卡复用。`code` 开放 string（`upstream_http` / `upstream_eof` / `upstream_transport` / `timeout` / `empty` / `user_stopped` / `budget_exhausted` / `quality_check_failed` 等）。
- **消息片段与流生命周期（2026-10-05 修复，已实施）**：助手消息按 SSE 顺序落 `parts`（`text`/`reasoning`/`notice` 带 `text`、`tool` 引用 `tool_id`；工具结果原位更新 `tools[]`；**前端仅合并相邻同类 `text`/`reasoning`，`notice` 前后端一致各自独立、不合并**；只有 notice 不建空助手消息；片段表头 reasoning「正在思考…」/「中间过程 · 思考」、notice「中间过程 · 提示」，**「N 次工具调用」仅旧 legacy 整块保留**；中断工具结果文案「本轮在工具返回前结束，结果未收到」；旧消息无 `parts` 回落旧布局、不迁移）；每轮固定 `turn_id` 原位 upsert，`stream_state ∈ {streaming, completed, interrupted, error}`；`GET /api/sessions/{id}` 回 `streaming`，停止 / 重载轮询**最多约 10s**、超时给**可重试同步错误**（不承诺硬刷新续跑）。前端 `lib/chatStream.ts` 按 `session_id` 持有流——**切会话 / 离开 `/chat` 不 abort，仅显式停止且只当前**；刷新 / 关页**不保证**继续，重载只见已落盘片段。**门禁与用例条数以命令输出为准**（快照见[E2E 测试流程](StudyMate-Web_E2E测试流程.md)）。
- **消息级操作**：`POST /api/chat/stream` 可选 `replace_from`（编辑重发：先截断该下标用户消息及其后全部消息再追加；被截断消息的附件清理，仍要重发的按 id 复用会话目录文件）；`DELETE /api/sessions/{id}/messages/{index}` 删整轮（成对删，返回 `{ok, deleted[], messages[]}`）。助手消息可带 `model`（「提供商 / 模型」）、`reasoning`、`tools`；会话可带 `usage`。**下标口径**：前端与服务端消息数组按序 1:1（编排卡也落库）。
- **settings v3**：`providers[].api_format ∈ {openai_chat, openai_responses, anthropic}`；`models[].vision ∈ {auto,on,off}` + 输入模态 + `max_output_tokens`/`context_window`/有序 `reasoning_variants`（+默认档）+ 能力声明；`active = {provider_id, model, reasoning_variant?}`；API Key **掩码回传**（明文不出后端；输入框回显掩码，PUT / `/test` 认掩码与空串为「保持原值」——2026-10-06 按 PR 审查意见收敛）。`GET /api/settings` 另返回**只读** `default_system_prompt`（后端唯一默认文案来源，不进 settings、不可写），前端「恢复默认」以它为准。
- **数据读写并发与工作区口径**：科目 YAML 写盘用原子替换 + `RLock`（`progress_transaction`），memory/概念本为原子写 + CRUD 锁；**全部科目类端点贯串会话工作区**；坏 YAML 容错；`memory` 指向不存在会话返回 404。
- **并发写拒绝（R2/R8）**：单进程进程内 **reject-only 注册表**——同键（`session` + 解析后的 base / node 工作区，区分工作区）冲突**立即 409，不排队、不合并**；chat / production 在落任何消息前即 409（**无孤儿 session**）；编辑 / 删除短占锁；产课工具冲突回明确 tool error；快改 / 复检与产课同键互斥；正常 / 取消 / 异常路径均释放锁（Lease owner-token 一次释放）。**独立 review F1–F5 ACCEPT。**
- **会话级模型与档位**：会话 JSON 与 `/api/sessions` meta 多一个 `active`（`{provider_id, model, reasoning_variant}`，null = 跟随默认）；`PATCH /api/sessions/{id}` 传 `active` 绑定、显式 `null` 解绑（绑定前校验存在，否则 422）；该会话的 chat/评估/小结/记忆建议都经 `config.get_session_provider()` 解析，解析不出回落 `get_active_provider()` 并在 chat 流给一条 notice。建课/产课/工单重试同样跟随会话模型。
- **会话 agent 动作工具**：仅**科目关联会话**在只读三工具（`list_workspace`/`read_course_file`/`read_skill`）外额外开放 `produce_lesson`（按大纲顺序产一节课，`node_id` 可省=**按大纲顺序第一个尚无课件的节点**，与 curriculum schema 顺序一致，**不沿用会话注入的节点聚焦**）与 `assess_node`（`node_id`+`evidence`，复用评估服务）。含动作工具的回合墙钟用 `ORCH_MAX_SECONDS`（1800s）而非 `CHAT_MAX_SECONDS`（300s）——工具执行在每轮 `asyncio.wait_for` 之外，单节点产课实测可达 ~700s。
- **2026-10-05 第一轮产课 / 任务卡 / 收口 / 记录契约（历史定稿）**：`task_update` 原位更新、`tool_result` 透传与同 tab 打开课件、records 一次格式修复 + 语义 mapping 校验（bool / number 拒）、interview 明确确认收口（≤2 轮 / 120s）、`STUDYMATE_LLM_MAX_SECONDS`（默认 300s）、角色提示按链路接线、依赖锁（uv universal + hash）——**详细契约见 PRD §13.3 与 §14**（本文不重复）；其验证快照见 `Web_CHANGE.md`「最终验证收尾」，**属上一轮历史**。
- **2026-10-06 本轮讲解失败事故修复（已定稿并验证）**：备用（回落 / 直连）单次派工角色标 `execution_mode`（`tools` / `fallback` / `single_call`）并展示 `fallback_reason` / `max_seconds` / `elapsed_s` / `message`，按真实 start / done / error 呈现（**envelope 返回≠自检通过**）；`produce_lesson` 不传 `node_id` 时**严格按大纲顺序取第一个尚无课件的节点**（**不沿用会话注入的节点聚焦**）；墙钟预算不变（1800s）。**既有产物复用**：本轮该角色无新文件 且 `regenerate=false` 且本次 ctx `check_passed` 且该角色 required 目标文件（出题 = `*.quiz.json`，其余 = `*.md`）存在、可读、非空 → 接受复用、不再派工；`regenerate` 布尔、默认 `false`，`true` 强制重做；**强制重做与工单 retry 禁复用**；**复审小修（已落地）**：`regenerate=true` 须显式 `node_id` 且 **bool 严格校验**、quiz / ticket 交付也 **gate required 文件**（防错 path / 假解决）、**非 UTF-8 不复用**、**真实 timeout 落到角色终态**、**任务非 running 隐藏当前阶段**、**本地停止 roles 同终止**。**已通过最终全量（计数见 E2E 流程与 HANDOFF）。**
- **工作区主页与资源前缀路由**：`GET /api/home` 服务 `<ws>/index.html`，`/api/home/{file_path:path}` 服务其相对引用；`GET /api/workspace-files/{token}/...` 等只读路由，`token = base64url(UTF-8 绝对路径) 去 padding`，供非默认工作区 iframe 内相对资源保留前缀，**委托既有 `lessons`/`home` handler**（非通用读盘接口）；前端 `lib/api.ts` 生成同款前缀（`toWorkspaceToken`）。
- **建课会话落点与收口标记**：`PromoteRequest.session_id` 指向触发建课的会话，落点成功后把该会话绑定到新科目（草稿 slug 即科目 slug）。`_handle_interview_result` 取**最后一段完整** `<!--INTERVIEW_RESULT-->…<!--/INTERVIEW_RESULT-->`；JSON 解析失败把原文（截断）回显成 `kind=error` 卡；没吐标记时只在"回复里不再有问号"且每会话至多一次的情况下追加一条可行动提示。
- **会话级工作区**：会话 JSON 与 `/api/sessions` meta 多一个 `workspace`（绝对路径，null = 跟随默认）；`POST /api/sessions`、`POST /api/chat/stream`（仅新建会话生效）与 `PATCH /api/sessions/{id}`（`{title?, workspace?}`）可写入；科目类 GET 可带 `?workspace=<绝对路径>`；`GET /api/workspace?path=` 只读预览任意目录。绑定要求目录已存在（否则 422）。
- **附件与版本**：`POST /api/uploads`（≤20MB）先传后引，消息带 `attachment_ids`，存储 `<study-mate-web>/data/uploads/<session>/<id>_<filename>`，pending 超 24h 清扫。版本三处一致（package.json / main.py / 侧边栏），语义化、仅标识 StudyMate Web、变更需维护者同意。

## 2. 关键机制与不变约束

1. **领域口径唯一**：状态机唯一实现在 `curriculum_store.py` 的 `TRANSITIONS`（完成口径 = 能独立应用 + 已通过项目验证，与根 `schemas/*.schema.json` 一致，词表常量单处定义）；双落点（`progress.misconceptions[]` 与科目 `misconceptions.yaml` 逐字一致，最近在前）；评估通过是权威置位（实验课通过时该节点与 `prerequisites` 被验收节点同置"已通过项目验证"，掌握度保留或上调、不降级，并写学习记录；会话摘要同日按段追加不覆盖；共享记忆只在用户逐条确认后增量插入分节）。
2. **模态两段式**：输入端不拦截；发送端按能力注入或占位（"[图片：<文件名> —— 当前模型不支持图片输入，已剔除]"）；被上游模态错误拒绝时剔除重试一次（已知视觉模型不降级）；视频/音频一律占位。
3. **工作区同构与发现复用**：学习数据在 `<WS>/.learning/subjects/<slug>/`，工作区发现一律走 `app/workspace.py`（复用上游 `learn_workspace()`，Web 不实现第二份规则）；默认 `~/StudyMate` **不自动种入示例**。
4. **会话级工作区**：会话各自绑定工作区（`null` = 跟随默认），**不做全局切换**；唯一收口点是 `curriculum_store.workspace_dir()` 读 `workspace_ctx.resolve()`，加能力只改这一处；会话端点用 `with workspace_ctx.bind(ws)` 包住，**SSE 生成器迭代期各自重挂绑定**；带 `workspace` 的绑定点要求目录已存在（否则 422）；`bind` 必须可重入，跨请求不泄漏由 pytest 守住。
5. **消息级操作与中间过程落库**：编辑 = **截断后重发**（`replace_from`），删除 = **删整轮**（成对，内联二次确认）；思维链/工具调用/用量一律**随助手消息落库**，前端折叠区与上下文窗口栏以落库值回显；**模型标识按"提供商 / 模型"落库**；上下文长度仅展示用，未声明时取 `lib/contextWindow.ts` 兜底默认值，设置页**不预填默认值**（留空即 null）。
6. **档位取值两类语义**：档位表里的 `disabled/enabled`、`off/on`、`关闭/开启` 是**思考开关**不是档位——`llm._reasoning_request()` 统一归一化（开 → 默认档 medium，关 → 不发思考参数），自由档位名照发，Anthropic 认不出就不发思考参数而不是 400；`config._model_reasoning_variant()` **不把显式选的「关」抹成空串**。
7. **工具化调用、提示词分层与建课闭环**：默认 persona（可改）+ 各链路按需**全文**注入 `.dsh/skills/<名>/SKILL.md`（不裁剪、不在 Web 侧复述规则，技能缺失该次调用 503，另加 `read_skill` 按需补充）；**工具调用默认对所有配置的模型开启**，上游拒绝 tools 时回落纯文本一次，循环无交付时回落单次派工链兜底（备用角色如实标 `fallback` 并展示原因 / 时限 / 已等待，**envelope 返回≠自检通过**）；质检工单只做循环耗尽后的人工兜底；采图保持纯后端爬虫、不进角色体系；文件读写以会话工作区/科目目录为界；chat 工具面 = **只读三工具**（所有会话）+ **动作工具 `produce_lesson`/`assess_node`（仅科目关联会话）**，未关联会话**不得凭空产课/评估**；建课完成（promote）后后端**自动把触发会话绑定到新科目**；派工值可达性是硬要求（模型读不到的文件必须**内联进派工值**）；事件序列**追加落盘**为审计证据，失败不清除。
8. **上游脚本零重写、门禁在写盘后强制**：大纲门禁 → `scripts/check_curriculum.py`，导出 → `scripts/gen_home.py`（均子进程，脚本缺失 503，FAIL 透出问题清单）；**不信任模型自查，也不信任"解析不出问题"**（门禁非零退出且 problems 解析为空 = 失败）。
9. **会话科目绑死**：科目关联唯一入口是**新对话态输入区上方的关联行**，首条消息发出后入口随新对话态消失——"换科目 = 新会话"（不继承）；interview 会话不带科目关联；节点聚焦未指定时由后端按进度推断（学习中 → 第一个未开始），推断只作用于注入、不落盘；前端不提供节点下拉。课程图谱页主区 = 科目头部 + 节点详情，大纲与图谱都在右栏做「图谱（默认）/ 大纲」分段切换。
10. **单轮时长、事件循环与编排可见性**：`REQUEST_TIMEOUT` 是 **per-read** 超时不是总时长上限 ⇒ `build_client(max_retries=0)`（重试统一在 `chat_once`/agent 层），agent 对**非瞬时错误直接降级不再空转重试**；**墙钟总预算** `run_agent(max_seconds=…)` 到点用现有内容收尾（`stopped_reason="wallclock"`），聊天 300s / 编排 1800s，可用 `STUDYMATE_CHAT_MAX_SECONDS`/`STUDYMATE_ORCH_MAX_SECONDS` 覆盖；挂 `ProgressReporter`（每 ≥0.5s 发进度快照，`progress` 不落库）供编排卡显示「在干活」；同步重活（门禁子进程、附件文本提取）挪出事件循环；SSE 迭代任务在 `finally` cancel runner；`replace_from` 负数改 422。
11. **测试隔离、运行产物与后端门禁**：`STUDYMATE_E2E_FIXTURE`/`STUDYMATE_DATA_DIR` 仅测试生效，未设置时与生产完全一致；运行时产物不入库（见 `.gitignore`）；`backend/tests/` 改后端功能需 `python -m pytest tests` 通过；**Next 16 两坑**：生产构建把 rewrites 目标固化进 `.next/routes-manifest.json`（改 BACKEND_PORT 需重新 build），`next.config.js` 必须 `compress: false`（否则代理 gzip 缓冲 SSE）。

## 3. 领域模型参考

- **curriculum.yaml**：`nodes[]`（id 小写点横线分段 / title / kind 概念·实操·实验 / objective / problem / prerequisites / concepts / resources / practice / pitfalls / realworld / status / mastery）、`edges[]`（from/to/reason）。顺序即教学位次。
- **progress.yaml**：`updated_at`、`nodes`（status/mastery/notes/lab_status）、`misconceptions[]`（topic/question/misunderstanding/answer_summary/follow_up/importance + id/date/node）、`project.current`；科目级 `misconceptions.yaml` 与其双落点，最近在前。
- **assessment / session-summary / subject**：front matter 记录契约见根目录对应 schema；评估 verdict 三档，通过走状态机（实验课→已通过项目验证，其余→能独立应用）。
- 原始口径：根目录 `schemas/*.schema.json`（唯一来源）、`scripts/statuses.py`。

## 4. 与上游仓库的关系

- **数据合同**：以根目录 `schemas/` 为唯一来源；workspace 布局与 `.learning` 同构，`STUDYMATE_WORKSPACE` 可直指已有静态工作区。
- **脚本复用**：`backend/` 通过 `REPO_ROOT/scripts/` 子进程调用上游门禁（见 §2.2）；上游脚本缺失时明确 503，不静默降级。
- **文档**：上游 docs/ 按用途归位（使用/规范/设计/agents）；上游领域约束见根 `AGENTS.md` → `docs/规范/工程约束.md`。仓库级贡献规则见根 `CONTRIBUTING.md`。
- **git 布局**：origin = 维护者 fork（PR 目标），upstream = Miaotofu01/Study-Mate（本地 main 仅 ff-only 拉取）；根目录文件保持上游原样，web 专属配置都在本目录。
- **Sayo UI 边界**：上游静态产物（主页/课件）的组件基座，不集成进 Web 前端；唯一交集是 `/lesson` iframe 内上游课件自带的资产（经 `/api/courses/assets/*` 兜底供给）。

## 5. 待实现计划（backlog）

> 分组：**延期（明确保留、本轮不做）** / **等待外部验证（仅剩外部条件）** / **完成索引（已落地或已裁定，只留指针）**。
> 本处保留 backlog、**不搬 GitHub Issues**；完成项不删，移入完成索引保留编号与指针；逐项细节与决策留痕见 [Web_CHANGE.md](Web_CHANGE.md)。
> 编号沿用历史不改号：旧 **#24** 归并到 **#23**（检查 stage 双发）、旧 **#27** 归并到 **#16**（`generate` 未工具化）；已失效的 **#14** 引用清理。
> **2026-10-05 第一轮前两批（历史定稿）**：其最终门禁快照见 [E2E 测试流程](StudyMate-Web_E2E测试流程.md) 顶部与 `Web_CHANGE.md`「最终验证收尾」（**属上一轮历史，不作为本轮口径**）；**唯一未完成项是 CI / 依赖锁的远端验证，等待维护者授权 commit + push**；**第三批全部保留延期**。第一轮契约细节见 PRD §13.3 / §14（本文不重复）。
> **2026-10-06 本轮（讲解失败事故修复）**：备用单次派工角色展示（`execution_mode` / `fallback_reason` / `max_seconds` / `elapsed_s` / `message`，按真实 start / done / error，envelope 返回≠自检通过）、`produce_lesson` 默认节点选择（**严格按大纲顺序取第一个尚无课件节点**，不沿用会话节点聚焦）、**既有产物复用 / `regenerate`**（无新文件 且 `regenerate=false` 且 ctx `check_passed` 且 required 目标存在可读非空 → 接受复用；`regenerate` 默认 `false`、`true` 强制重做；强制重做与工单 retry 禁复用）；**已通过最终全量**；**复审小修（已落地）**：`regenerate=true` 须显式 `node_id` + bool 严格校验、quiz / ticket 也 gate required、非 UTF-8 不复用、真实 timeout 落角色终态、**任务非 running 隐藏当前阶段**、本地停止 roles 同终止。
> **2026-10-06 本轮（错误终态 / 检查器 / lab 交付修复，已定稿并部署）**：统一错误对象 `ErrorInfo` 与红色错误详情（`ErrorNotice`）、停止按 `(session_id, turn_id)` 作用域、上游流缺结束标记判 `upstream_eof`；**共享检查器自身 bugfix**（`check_lesson.py` 用 `HTMLParser` 只取真实 `href/src`，不绕过真实检查、不改「脚本只复用不重写」）；**实操 / 实验 lab 交付 required**（缺一不 promote）；**打回次数分开 `repair_rounds` / `rechecks`**（总控只复检不占派工轮）。**验证**：后端 474 / 1 skip、组件 119（16 文件）、E2E 98 = 95 + 3 skip。**两真实重产经浏览器 UI 编辑重发均失败（上游 503），不声称成功**；独立完整复审未完成。**第三批整体保留延期**。

### 延期（明确保留、本轮不实施；第三批全部）

| # | 计划项 | 说明 |
|---|---|---|
| 3 | 真实模型端到端验证（收尾） | 已用 my-api 验证三条生产链与工具循环冒烟；剩余 anthropic / openai_responses 两格式真实流式（含思考参数）未验证 |
| 4 | 附件能力扩展 | 视频 / 音频实发；文档内嵌图片提取 + OCR |
| 8 | 会话存储 SQLite 迁移 | 文件型会话量大后的演进 |
| 9 | 主动检索（resource-scout 等价） | 三条路线待拍板，见 §5.3；**本轮不实现** |
| 13 | 干掉 `vision` 字符串垫片 | 改为直传 `modalities` 并删垫片 |
| 15 | lab 代码沙箱执行 | v1 = 本机子进程沙箱；强隔离后议 |
| 16 | K4 总控全 agent 化 | 含 `generate.py` 是否工具化（旧 #27 归入本条）；远期可选 |
| 17 | 小结 / 沉淀记忆入口接回 | 右栏入口悬空，后端端点与 `MemoryDialog.tsx` 保留；`memory-flow` / `session-summary` 的 `test.skip` 一并摘除（归第三批保留） |
| 18 | 会话级工作区：允许尚不存在的目录 | 放宽存在性校验即可 |
| 29 | chat 角色工具面扩容 | 挂 K4（#16）；"建完课接不下去"的根因；差距表见 §5.3 |

### 等待外部验证

| # | 计划项 | 说明 |
|---|---|---|
| 35 | lint / CI / 依赖锁（R3/R4） | **本地全部完成**：最小 ESLint（flat config，`lint` 0 errors / 51 warnings）；独立 **web-ci**（Node24 / Py3.13，CI smoke 5 pass，非 full E2E）；依赖锁 **uv 0.11.14 universal + hash**（`backend/scripts/lock_backend_deps.py`；`pip --require-hashes` 安装 + `pip check` 通过）。**唯一剩余：远端未 push / 未在 GitHub 执行**（待维护者授权 commit + push）⇒ **不得写"CI 通过"** |

### 完成索引（已落地 / 已裁定，只留指针）

| # | 计划项 | 结论 | 指针 |
|---|---|---|---|
| 2 | docs/ 新增 web 版文档 | 已存在 | 本目录 README / 开发与计划 / PRD / E2E 流程 / Web_CHANGE |
| 11 | E2E 渲染专项矩阵 | 已完成：rendering **4 × 2**（light / dark） | E2E 流程 §3 / §5 |
| 21 | `Deepseek-v4-flash` 档位与网关不匹配 | 属用户数据问题；现用 high 档位、适配层已归一；历史备忘 | 见历史条目 |
| 23 | 建课收口静默（#23a）+ 检查 stage 双发（#23b，旧 #24） | 已完成：收口 full match 疑问 / 否定、缺信息不建 draft、区分循环内自检与外层检查 | PRD §14；Web_CHANGE「最终验证收尾」 |
| 30 | 产课过程可见 | 已完成：`task_update` 父任务卡原位更新 + 真实角色事件 + 心跳原位 + 同 tab 打开课件 | PRD §13.3 |
| 31 | 并发写冲突：先拒绝（R2/R8） | 已实施，独立 review F1–F5 ACCEPT | Web_CHANGE「决策轮」R2+R8 |
| 32 | `shadow-xs` 视觉补齐（R6） | 已实施，不重做视觉 | Web_CHANGE「决策轮」R6 |
| 33 | 用户消息 `display_content` 分离（R7） | 已实施 | Web_CHANGE「决策轮」R7；PRD §5.5 |
| 34 | legacy 工单恢复（R10） | 后端 + 前端均已完成 | Web_CHANGE「最小工程化与 legacy 工单恢复」；PRD §13.2 |
| 36 | 鉴权 / 来源 / 监听边界（R1） | 裁定：只本地个人用，本轮不做；仍不新增多租户 / 身份体系 | Web_CHANGE「决策轮」R1；README「部署边界」 |
| 37 | 会话流生命周期与有序工具卡 | 已实施定稿 | Web_CHANGE「会话流生命周期与有序工具卡」；PRD §5.6 |
| — | 第一轮前两批（2026-10-05，历史） | 已完成：`task_update` 原位更新、结果透传与同 tab 打开、records 修复 + 语义 mapping（bool/number 拒）、interview 收口与 draft 门、`STUDYMATE_LLM_MAX_SECONDS`、角色提示接线 | PRD §13.3 / §14；Web_CHANGE「最终验证收尾」 |
| — | 本轮讲解失败事故修复（2026-10-06） | 已完成：备用派工展示与真实终态、`produce_lesson` 默认节点、既有产物复用 / `regenerate`（严格条件）、quiz / ticket required gate；最终全量绿 | PRD §13.1 / §13.3 / §14；Web_CHANGE「最终收尾（2026-10-06）」 |
| — | 本轮错误终态 / 检查器 / lab 修复（2026-10-06） | 已完成：`errors.py` 统一错误对象 + `ErrorNotice` 红卡、停止按轮作用域、`check_lesson.py` HTMLParser 真实 attrs、实操 / 实验 lab required、`repair_rounds` / `rechecks`；测试 474+1 / 119 / 98（95+3）；**真实重产两会话均 503 失败待上游恢复** | PRD §13.1 / §13.3 / §14；Web_CHANGE「本轮错误终态 / 检查器 / lab 交付修复」 |

### 5.1 全功能复现实施队列（A~J，2026-10-03 全部落地）

**目标**：Web 复现乃至拓展 dsh 插件全功能，"只消费已有产物"旧边界作废。**进度**：队列 A~J 已全部落地（A/B/H/I 于 2026-10-02，C/D/E/F/J 于 2026-10-03）；K 系列工具化改造已于 2026-10-04 落地，K4 总控全 agent 化为远期可选（backlog #16）。**依赖**：工作区是根，提示词是各链路公共输入，产课链与验证集可并行。逐项拍板原文与修订注见 [Web_CHANGE.md](Web_CHANGE.md)。

### 5.2 明确不做（2026-10-02 维护者）

- **账号体系 / 云同步**：不碰（设计方案 §2 YAGNI）。

> 2026-10-03 维护者拍板：原列于此的「主动检索」移回待实现计划（#9）、「lab 代码沙箱执行」移回待实现计划（#15）。

### 5.3 主动检索议程与 chat 角色工具面差距（2026-10-04 第八轮结论）

- **主动检索**：Web 现状为"只落盘结构化、不做主动检索"（#9），插件侧 `resource-scout` 默认全网检索；从零建课资源清单为空 ⇒ 采图结构性空转（已用「采图 · 跳过（无参考资料）」止损，本体问题在资料清单为空）。
- **可选路线**：① 恢复最小检索（对齐 image-scout：纯后端、不进角色体系）；② 保留只读并去掉采图阶段；③ 用 web 工具让 agent 自己检索（依赖网关支持，挂 K4）。**本轮不实现**，待维护者拍板。

| 能力 | 插件预设 `preset/learning/agent.cordis.yml` 给总控 | Web chat 现状 |
|---|---|---|
| 终端 | bash / pwsh | 无 |
| 文件 | fs 读写 | 只读 `read_course_file` / `list_workspace`（写盘由后端链承担） |
| 检索 | fs-search | 无 |
| 作业 | jobs | 无 |
| 技能 | skill 目录 + 按需加载 | `read_skill` 只读 |
| 规划 | goal、plan-mode、compaction | 无 |
| 派工 | **subagent(spawn, maxDepth=2)** + workflow-ptc + ralph | 无（角色派工由后端链承担） |
| 交互 | ask_user、todo | 无 |
| 联网 | **web（fetch + search）** | 无（即"主动检索"缺口） |
| 交付 | **present** | 无（产物落工作区，不 present） |

> chat 工具面整体对齐挂 **K4（backlog #16/#29）**。
