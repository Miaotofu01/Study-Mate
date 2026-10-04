# StudyMate Web 开发与计划

> 版本：v1.1（2026-10-02，实施轮 A/B/H/I+G 落地后更新）
> 定位：**已有实现的开发文档 + 待实现的计划文档**。描述系统当前架构、关键机制与不变约束、领域模型、与上游仓库的关系，以及后续计划。
> 文档分工：功能规格与实施状态 → [StudyMate-Web_PRD.md](StudyMate-Web_PRD.md)；
> 测试流程与用例映射 → [StudyMate-Web_E2E测试流程.md](StudyMate-Web_E2E测试流程.md)；
> 旧计划与变更史（只追加）→ [Web_CHANGE.md](Web_CHANGE.md)；
> 启动、配置、附件、E2E 运行、版本语义 → [README.md](README.md)。
> 维护约定：功能落地或变更时同步 PRD；计划项完成/新增/放弃时更新本文第 5 节；里程碑与重要决策追加进 Web_CHANGE。

---

## 1. 架构现状（0.6.0-beta）

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
| `llm.py` | 统一适配层：内部 openai 风格 content parts，按 api_format 三段分派（构造/流式解析/非流式解析）；`chat_once(fixture_kind=…)`；K 系列起承担工具轮次（`stream_turn` 聚合流式 tool_call）、瞬时失败重试与 900s 读超时；**第三轮起另透出思维链与用量**（`reasoning_content` / `reasoning` / `thinking_delta` → `reasoning` 增量；末块 `usage` → 用量事件，不主动发 `stream_options`）；E2E fixture 门（`STUDYMATE_E2E_FIXTURE=1`） |
| `multimodal.py` | 视觉能力前缀表 + 覆盖判定；Stage-1 注入/占位；Stage-2 错误标记匹配剔除重试一次 |
| `doc_extract.py` | 附件"字节进文本出"：pdf(pymupdf→pypdf)/docx/xlsx/pptx/epub/文本类多编码；预算 20000/60000 字符 |
| `curriculum_store.py` | 课程仓储（`<WS>/.learning/subjects/<slug>/*.yaml` 读写校验）+ **掌握度状态机 TRANSITIONS（唯一实现）** + 新词表常量（IMPORTANCES/LAB_STATUSES/VERDICTS）；`workspace_dir()` 读 `workspace_ctx`（**会话级工作区的唯一收口点**，下游自动跟随） |
| `workspace.py` | 工作区发现：复用上游 `learn_workspace()`（子进程调用，失败回落 `~/StudyMate`）+ 进程内缓存 + 配置文件写回（行级替换保注释） |
| `workspace_ctx.py` | 请求级工作区绑定（ContextVar）：`resolve()`（无绑定回落发现结果）/ 可重入 `bind(path)` / `validate_dir()`；会话级工作区靠它生效 |
| `prompts.py` | 提示词分层：链路 → 技能映射（`SKILL_ROUTES`，各链路均已接线）+ `.dsh/skills/<名>/SKILL.md` 全文读取（缓存，缺失由调用方 503）+ Web 运行环境适配说明；`inject_role` 供角色派工循环用 |
| `memory.py` | 跨科目共享记忆 `MEMORY.md`：读侧 + 逐条确认后的分节增量插入（去重、不整篇重写） |
| `misconceptions.py` | 概念本双落点（misconceptions.yaml 为 canonical 源，旧条目补 id 幂等回写） |
| `records.py` | 评估/小结 front matter 解析渲染 + jsonschema 校验（读仓库 `schemas/`） |
| `storage.py` | 文件型会话存储（消息可带 attachments 元数据；**会话级 `workspace` 字段 + 会话级 `active` 模型三元组**；助手消息可带 `reasoning` / `tools` / `model`；会话级 `usage`；`drop_messages` / `truncate_messages` 是消息级操作的存储原语；删会话连带删其上传目录） |
| `agent.py` | K0 agent loop runner：轮次/预算（探索 8 + 收尾 3 + 强制 1）/降级/重复提醒 + 工具执行与事件回吐（text / **reasoning** / tool_call / tool_result / **usage**）；`AgentOutcome` 汇总 `text` / `reasoning` / `tools` / `usage` 供落库；fixture 脚本含 `tools` / `process` 两个场景 |
| `tools.py` | 工具注册表 + 沙箱边界（读写根 allow-list、写前当场 canonicalize、稳定拒答标记）；`CHAT_TOOLS`（只读）/ `CHAT_ACTION_TOOLS`（`produce_lesson` / `assess_node`，**仅科目关联会话**）/ `BUILD_TOOLS` / `PRODUCE_TOOLS` 四套工具集；动作工具把产课/评估链的 stage/retry/done/progress 转成中文 `notice`（progress 节流 ~10s）回吐 |
| `audit.py` | 编排审计 `data/audit/<key>.jsonl`（contextvar 绑定编排键；派工值/原始回复/工具调用与结果追加落盘，失败不清除，敏感键脱敏） |
| `roles.py` | 角色派工基建：SKILL.md 全文注入（`prompts.inject_role`）+ envelope 解析/逐字落盘/搬位 + 路径模式归属映射 |
| `produce.py` | 产课链编排（讲解/出题派工 → 渲染 → 检查 → 按归属打回 → 工单；K3 起走工具循环，**工具调用对所有模型默认开启**、不按能力声明，上游拒绝 tools 时回落纯文本）；**工单 `retry` 的产课路径改走 `dispatch()`（第八轮 #25）** |
| `build.py` | 建课链编排（大纲 + 采图并行 → `check_curriculum.py` 门禁 → 落盘；K2 起大纲走工具循环 + 门禁报错回喂自修）；**`curriculum_values` 内联 `schemas/curriculum.schema.json` 全文 + 硬约束速览**（沙箱读不到仓库根）；**门禁非零退出但解析为空时判失败**，原始输出截断进 problems |
| `draft.py` | 建课草稿区（`data/drafts/<slug>/`，科目同构布局）+ promote 落点确认；`create_draft` **同名（strip + casefold）返回既有草稿**，不建逐字重复两份 |
| `image_scout.py` | 采图（纯后端爬虫：配额 / 过滤 / 命名 / 索引照搬插件，不进角色体系）；**`RESOURCES.md` 无可抓 URL 时 stage 名标「采图 · 跳过（无参考资料）」，done 带 `skipped/reason`** |
| `tickets.py` | 质检工单存储、分组与状态流转 |
| `routers/` | chat（SSE：session/delta/**reasoning**/notice/tool_call/tool_result/**usage**/confirm/done/error + 课程上下文 + **开场状态切片** + 附件 + 会话级工作区绑定 + **`replace_from` 编辑重发** + **`DELETE /api/sessions/{id}/messages/{index}` 删除整轮** + **科目关联会话额外开放 `produce_lesson`/`assess_node` 动作工具，含动作工具时墙钟用 `ORCH_MAX_SECONDS`**）、**home（`GET /api/home` 与 `/api/home/{file_path:path}`：服务工作区 `index.html` 及其相对引用，`..` 词法拒绝 + resolve 包含校验 + 媒体类型表）**、courses、uploads、settings（v3 + test）、**workspace（查看/改选 + 候选路径 + `?path=` 只读预览）**、lessons（列表/files/共享 assets/quiz/**附件区清单**，后四者支持 `?workspace=`）、misconceptions、practice（grade）、records（assess/summary/records，带会话的工作区绑定）、**memory（suggest/confirm）**、export（子进程 gen_home.py）、generate（子进程 check_curriculum.py 当门）、production（`_provider` 按会话绑定取模型；**promote 带 `session_id` 自动关联触发会话**） |

### 1.2 前端结构（frontend/）

- 路由：`/chat`、`/courses`、`/misconceptions`、`/lesson`、`/generate`、`/settings`（重定向）→ `/settings/providers`、`/settings/system-prompt`、`/settings/theme`、`/settings/workspace`、`/settings/about`。`/courses` **不带 `?subject=` 是「我的课程」**（内嵌工作区主页、无右栏），带 `?subject=` 才是科目课程页。
- 关键组件：`ChatView`（两态：欢迎区+起点 chips ↔ 消息流+落底，650ms 弹性过渡；用户气泡靠右、品牌色；头像 56px；**助手名称栏**；**消息操作条**——用户复制/编辑、助手复制/记入概念本/删除本轮（内联二次确认）；**「中间过程」折叠区只留思维链 + 本轮提示**（工具卡移出折叠区、**常显在消息体**；两者皆空则不渲染面板）；顶栏含内联重命名；**新对话态输入区上方的「科目 + 工作区」关联行**；流式**贴底才跟随**（32px 阈值）；建课完成卡带「开始第一课」次要按钮）、`Composer`（📎 统一附件入口 + 拖拽/粘贴 + 输入框内模型选择器 + **推理档位独立下拉**，两者靠右紧邻发送按钮；会话态无上方分隔细线）、`RightSidebar`/`RightRail`（可折叠/可拖拽的右侧边栏外壳，聊天页与课程图谱页共用；聊天页内含**上下文窗口栏** + **科目「图谱 / 大纲」区（`SubjectGraphPanel`，默认大纲，点节点跳 `/courses?subject=&node=`）** + **附件区清单**（按会话工作区读）与会话信息）、`SubjectGraphPanel`（共享组件：课程页右栏与聊天右栏共用，`onClearSelection` / `refreshKey`）、`HomeEmbed`（**内嵌工作区主页 iframe**：`/api/home/index.html?theme=<主题>`，`MutationObserver` 跟随 web 主题，不写学生偏好）、`lib/contextWindow`（上下文长度兜底默认值 / token 缩写 / 占用百分比）、`lib/useResizable`、`lib/workspace`（工作区/科目上下文 + 会话级 `activeWorkspace` + 课程页 `currentSubjectSlug`）、`MemoryDialog`（**当前无入口，悬空保留**）、`ModelSelector`（仅提供商/模型切换）、`settings/ProvidersView`（主从布局 + 启用开关 + 只读模型行四操作 + **实时生效、无保存按钮**）、`settings/ModelEditDialog`（基础区 + 高级折叠区；最大输出 Token / 上下文长度**留空即兜底默认，不预填**）、`settings/SystemPromptView`、`settings/WorkspaceView`（工作区查看/改选）、`settings/AboutView`、`LessonView` + `GradingPanel`（课件 iframe + 开放题判分；窄屏可读性）、`MisconceptionsView`、`CourseGraphView`（**不带 `?subject=` = 「我的课程」：只内嵌 `HomeEmbed`、不渲染右栏/节点详情；带 `?subject=` = 科目头部（含科目状态/进度总览）+ 节点详情卡，右栏顶部「图谱 / 大纲」分段切换**；导出按钮在头部）、`NodeDetail`（含**本节点误解**区；**原「产出此课」「申请评估」「问 Study Mate」三按钮已删，保留工单角标 `node-ticket-entry`**——产课/评估改由聊天 agent 工具）、`Sidebar`（导航 + 会话/科目 + 底栏设置与明暗切换，可拖拽调宽 + 折叠成图标轨；原「课程图谱」导航改名**「我的课程」**）、`WorkspaceOnboarding`（**已无引用，悬空保留**）。
- 样式体系：Tailwind + CSS 变量（亮/暗两套，`data-theme` 由 layout 内联脚本首帧前写入，localStorage 优先否则跟随系统）；品牌色走 `--brand-rgb` 变量（支持透明度修饰）；TS 严格模式，除 page/layout 外具名导出。
- 测试：Playwright（`tests/e2e/`，旅程级用例，映射表见 E2E 测试流程文档）。

### 1.3 对外契约要点

- **SSE 事件**：`session` / `delta` / **`reasoning`** / `notice`（非致命提示；2026-10-04 第三轮起前端把它收进「中间过程」折叠区，不再单挂横幅）/ `done` / `error`；工具化 chat 另发 `tool_call` / `tool_result` 与 **`usage`**。思维链、工具调用与用量都**随助手消息落库**（`reasoning` / `tools` / 会话级 `usage`），刷新后可回放；完整审计仍在 `data/audit/*.jsonl`。
- **消息级操作（2026-10-04 第三轮）**：`POST /api/chat/stream` 新增可选 `replace_from`（编辑重发：先截断该下标的用户消息及其后全部消息，再追加新消息；被截断消息的附件随之清理，仍要重发的原附件按 id 复用会话目录里的文件）；`DELETE /api/sessions/{id}/messages/{index}` 删整轮（index 指向该轮用户消息或助手回复，成对删，返回 `{ok, deleted[], messages[]}`）。助手消息可带 `model`（「提供商 / 模型」标识）、`reasoning`、`tools`；会话可带 `usage`。**下标口径**：前端消息数组与服务端会话消息数组按序 1:1（编排卡也会落库），编辑/删除传本地下标即服务端下标。
- **settings v3**：`providers[].api_format ∈ {openai_chat, openai_responses, anthropic}`；`models[].vision ∈ {auto, on, off}` + 输入模态（`modalities`）+ `max_output_tokens` / `context_window` / 有序 `reasoning_variants`（+ 默认档）+ 能力声明；`active = {provider_id, model, reasoning_variant?}`；API Key 回填输入框（不再掩码回传）。
- **会话级模型与档位（2026-10-04）**：会话 JSON 与 `/api/sessions` meta 多一个 `active`（`{provider_id, model, reasoning_variant}`，null = 跟随当前默认模型）；`PATCH /api/sessions/{id}` 传 `active` 绑定、显式 `null` 解绑（绑定前校验提供商与模型都存在，否则 422）；该会话的 `chat/stream`、评估、小结、记忆建议都经 `config.get_session_provider()` 解析绑定模型，解析不出来就回落 `get_active_provider()` 并在 chat 流里给一条 notice。**`production.py::_provider` 也按会话绑定取模型**（建课/产课/工单重试都跟随会话模型，不再恒用全局默认）。
- **会话 agent 动作工具（2026-10-04 第八轮）**：仅**科目关联会话**在只读三工具（`list_workspace`/`read_course_file`/`read_skill`）之外额外开放 `produce_lesson`（按大纲顺序产一节课，`node_id` 可省=第一个未产出节点）与 `assess_node`（`node_id` + `evidence`，复用评估服务）。含动作工具的聊天回合墙钟用 `ORCH_MAX_SECONDS`（1800s）而非 `CHAT_MAX_SECONDS`（300s）——工具执行在每轮 `asyncio.wait_for` 之外，单节点产课实测可达 ~700s，否则下一轮会顶到 deadline 被判降级收尾。
- **工作区主页服务（2026-10-04 第八轮）**：`GET /api/home` 服务 `<ws>/index.html`；`GET /api/home/{file_path:path}` 服务其相对引用（`.learning/assets/**`、`.learning/subjects/**`），沿用 lessons 的 `..` 词法拒绝 + resolve 包含校验 + 媒体类型表。
- **落点确认自动关联（2026-10-04 第八轮）**：`PromoteRequest.session_id` 指向触发建课的会话；落点成功后把该会话绑定到新科目（草稿 slug 即科目 slug）。此前传入会话时 `_session_for` 直接 return、不写绑定。
- **收口标记解析（2026-10-04 第八轮）**：`_handle_interview_result` 取**最后一段完整** `<!--INTERVIEW_RESULT-->…<!--/INTERVIEW_RESULT-->`；JSON 解析失败把原文（截断）回显成 `kind=error` 卡；这一轮没吐标记时只在"回复里不再有问号"（形态上已收尾）且每会话至多一次的情况下追加一条可行动提示。
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
15. **消息级操作与中间过程落库（2026-10-04 第三轮）**：编辑 = **截断后重发**（`replace_from`），不是原位改字——语义是"从这句重新生成"；删除 = **删整轮**（用户 + 助手成对），走内联二次确认。思维链 / 工具调用 / 用量一律**随助手消息落库**（不再只在流式期间呈现），前端「中间过程」折叠区与右栏「上下文窗口」栏以落库值为准回显；**模型标识按"提供商 / 模型"落进助手消息**，历史会话不再用当前模型冒充。上下文长度只是展示用（不发给 API），模型未声明时前端取 `lib/contextWindow.ts` 的兜底默认值——设置页**不再把默认值预填进输入框**（留空即 null），保证"没声明"与"显式声明"可区分。
16. **档位取值两类语义（2026-10-04）**：档位表里的 `disabled/enabled`、`off/on`、`关闭/开启` 是**思考开关**不是档位——`llm._reasoning_request()` 统一归一化（开 → 默认档 medium，关 → 不发思考参数），自由档位名照发（自定义网关词表），Anthropic 认不出就不发思考参数而不是 400。`config._model_reasoning_variant()` **不再把显式选的「关」抹成空串**（抹空会回落默认档，等于用户选了关却开了思考）。
18. **编排可见性与单轮时长上限（2026-10-04）**：编排每几秒发一条 `progress` 快照（含轮次/已等待秒数/思考字数/工具次数），建课卡片与产课面板据此显示「在干活」；`run_agent(max_seconds=…)` 到点降级收尾（聊天 300s、编排 1800s，env 可覆盖）。**为什么不逐条转发思维链**：实测单轮 3396 个事件，转发会打爆 SSE。**为什么两条预算并存**：轮数预算封不住「一轮本身跑半小时」，而 per-read 超时（900s）在网关慢速吐字时永不触发。
17. **单轮时长与事件循环（2026-10-04 防御性修复）**：`REQUEST_TIMEOUT` 是 **per-read** 超时不是总时长上限（网关只要在窗口内吐过字节就永不触发）⇒ `build_client(max_retries=0)` 去掉 SDK 自身的 2 次整请求重试（重试统一在 `chat_once`/agent 层），agent 层对**非瞬时错误直接降级不再空转重试**；**墙钟总预算已实施**：`agent.run_agent(max_seconds=…)` 到点用现有内容收尾（`stopped_reason="wallclock"` + 提示），聊天 300s / 编排 1800s，可用 `STUDYMATE_CHAT_MAX_SECONDS` / `STUDYMATE_ORCH_MAX_SECONDS` 覆盖；同一处还挂了 `ProgressReporter`（每 ≥0.5s 发一份进度快照，`progress` 事件不落库），见不变约束 #18。同步把两处同步重活挪出事件循环：`generate.py` 的门禁子进程改 `asyncio.to_thread`、chat 的附件文本提取同样下线程池（此前会阻塞同进程所有 SSE 流）；SSE 迭代任务在 `finally` 里 **cancel runner**（此前 `await task` 在客户端断开时不取消孤儿任务，会继续烧 token 并可能往已截断的会话写幽灵消息）；`replace_from` 负数改 422（此前被夹到 0 = 清空整个会话）；附件清理跳过「仍被其它消息引用」的 id。
19. **会话工具面与建课闭环（2026-10-04 第八轮）**：chat 工具面 = **只读三工具**（所有会话）+ **动作工具 `produce_lesson`/`assess_node`（仅科目关联会话）**；未关联会话的工具面照旧只读，**不得凭空产课/评估**。建课完成（promote）后后端**自动把触发会话绑定到新科目**，这是"建完课接得下去"的关键一步。派工值可达性是硬要求：模型读不到的文件（如仓库根 `schemas/`）必须**内联进派工值**，否则只能盲猜、门禁连环打回。**不信任模型自查同样不信任"解析不出问题"**：门禁非零退出且 problems 解析为空 = 失败，把原始输出塞进 problems。前端**工具卡常显在消息体**（不折进「中间过程」面板），面板只留思维链与本轮提示、两者皆空则不渲染。

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
| 9 | 主动检索（resource-scout 等价） | 2026-10-03 维护者拍板移回计划（原 2026-10-02 列入"明确不做"）：产物沿用 reference/ + RESOURCES.md 落盘结构化（落点已存在，见 draft.py / production.py）；检索通道待拍板——模型原生联网搜索（依赖 #14 接线与网关支持）或后端搜索 API（引入外部依赖）；形态倾向对齐 image-scout（纯后端、不进角色体系）。**2026-10-04 第八轮把它的影响面写清并提上议程：从零建课资源清单为空 ⇒ 采图结构性空转；三条可选路线与"本轮不实现"见 §5.3** | 妥协清单二档；2026-10-03 拍板 |
| 10 | 真实 Key 下的思考档位验证 | openai_chat 格式已随 2026-10-03 冒烟真实验证（五模型 reasoning medium 全程生效）；anthropic / openai_responses 两格式思考参数仍未对真实端点验证，并入 #3 收尾 | 反馈清单轮遗留 |
| 11 | E2E 渲染矩阵（P3） | `colorScheme` 矩阵 + 关键雷区定向 `toHaveCSS`；暗色 `<select>` option 现靠 CSS 规则修，无断言兜底 | E2E 流程 §2.3 |
| 12 | ~~E2E 组件测试层（P4）~~ | **已完成（2026-10-04）**：选型 vitest + Testing Library（jsdom；弃 Playwright CT——experimental 且要在 Next 仓库养平行 Vite 配置）；`npm run test:component` 13 条用例下沉三分支；组件层不进根门禁（与 E2E/pytest 同口径） | E2E 流程 §2.3 |
| 13 | 干掉 `vision` 字符串垫片 | `get_active_provider()` 目前由 modalities 派生 `vision` 三态字符串喂给 `chat.py`（该文件不在改单内）；应改为直传 `modalities` 并删垫片 | v3 迁移遗留 |
| 14 | ~~能力声明接线~~ | **工具调用已定档为默认开启（2026-10-04），不再是可选项**，`capabilities.tool_call` 字段保留但不再参与门控（界面亦不再提供开关）；`json_schema_output` / `native_web_search` 仍仅落盘展示 | v3 迁移遗留 |
| 16 | K4 总控全 agent 化 | K2/K3 工具循环完成后按效果决定；参考尽调存档 §七（子代理=一个返回结构化结果的工具、前台 one-shot、后台/可续二期） | K 系列 |
| 15 | lab 代码沙箱执行 | 2026-10-03 维护者拍板移回计划（原明确不做）。v1 = 本机子进程沙箱：隔离工作目录 + 超时 + 进程树终止 + 输出捕获，运行结果对接 lab_status 流转（待提交 → 待评估），输出可作 LLM 判 lab 依据；强隔离（容器/WASM）后议。待拍板：触发时机（学生提交时跑 / 顺带自动验 LLM 参考答案） | 2026-10-03 维护者拍板 |
| 17 | 小结 / 沉淀记忆入口接回 | 2026-10-04 拍板：右栏「会话关联」整段移除后，「生成小结」与聊天侧「沉淀记忆」两个入口**悬空**（后端端点、`MemoryDialog.tsx`、`WorkspaceOnboarding.tsx` 都保留未删）。接回时把入口挂到输入区工具条或消息操作条即可（消息操作条已就位，是现成落点）；`memory-flow.spec.ts` / `session-summary.spec.ts` 里 `test.skip(true, …)` 那行一并摘掉 | 2026-10-04 拍板 |
| 18 | 会话级工作区：允许指向尚不存在的目录 | 当前带 `workspace` 的绑定点要求目录已存在（否则 422）。若要支持"先指向一个空目录再冷启动"，放宽 `create_session` / `PATCH` / `optional_workspace` 的存在性校验即可（一行之差） | 2026-10-04 实施遗留 |
| 19 | ~~工具卡/思维链持久化~~ | **已完成（2026-10-04 第三轮）**：思维链（`reasoning`）与工具调用（`tools`）随助手消息落库，收进「中间过程」折叠区，刷新后仍可回放；顺带透出末块 `usage`（会话落 `usage` 供右栏「上下文窗口」栏回显）。见 Web_CHANGE 同日第三轮条目 | 上一版 HANDOFF 建议项 6 |
| 20 | 组件测试层与现行 UI 对齐 | `tests/component/` 13 条里有 **9 条为陈旧用例**（`ChatView.test.tsx` 3 条断言已移除的"工作区引导块"、`ProvidersView.test.tsx` 6 条断言已移除的「保存」「测试连接」按钮），自 2026-10-04 前两轮 UI 改动后一直红；该层**不进根门禁**，本轮未动。要恢复绿灯需按现行 UI 重写（工作区引导块已由"新对话关联行"取代；ProvidersView 已改实时生效、无保存/测试连接按钮），或按新行为补等价用例 | 2026-10-04 第三轮核对 |
| 22 | ~~单轮墙钟预算~~ | **已完成（2026-10-04 第六轮）**：`run_agent(max_seconds=…)`，聊天 300s / 编排 1800s，超时降级收尾 + 明确提示；真机实测（把上限压到 8s、对 `Deepseek-v4-flash` + high）8.0s 干净收尾、已产出的 1310 字思维链保留。原文： 现状只有 per-read 900s 超时 + 轮数预算（12 轮），**没有单轮总时长上限**；实测有会话挂了 2 小时 38 分（`data/audit/chat-e3be804258b3.jsonl` 的 `agent_start` 之后 9507s 无任何事件）、有建课编排 13 分钟无进展。难点：**真实产课单次派工实测 694s 是合法的**，一条 chat 与一次产课派工不能用同一个上限。待拍板：chat 与编排分别给多少秒、超时是降级收尾并提示还是直接报错（建议 chat 300s / 编排 1800s，超时降级 + 明确提示） | 2026-10-04 排查轮 |
| 23 | 建课会话是否该带工具（候选①/②待拍板） | `use_tools` 对 `mode=interview` 没有排除 ⇒ 真实 provider 下建课会话也走工具循环。**第八轮已落地候选③**：收口标记解析改为取最后一个完整匹配、JSON 解析失败原文回显、缺标记且已收尾时给一次可行动提示（见 §1.3）。候选①（interview 恒走纯文本）②（保留工具但收紧提示词）仍待拍板。fixture E2E 只覆盖纯文本路径，因此一直全绿 | 2026-10-04 排查轮 |
| 24 | 「门禁」「检查」stage 双发（待拍板） | 真实 provider 下工具循环内 emit 一次（`submit_curriculum` / `run_check`），外层复核再 emit 一次 ⇒ 前端渲染两条「✅ 门禁完成」。候选：循环内改名（门禁自检）／前端按 stage 去重／接受重复（当可观测性） | 2026-10-04 排查轮 |
| 25 | ~~工单重试链未走工具循环~~ | **已完成（2026-10-04 第八轮）**：`run_ticket_retry` 的产课路径改走 `dispatch()`（内部 `_role_tool_loop`），与实时产课同能力；`kind=build` 的 retry 仍走单次派工。原文：`run_ticket_retry` 用 `_safe_dispatch` → `roles.dispatch_role`，与实时产课（K3 工具循环 + `run_check` 自修）能力不一致 | 2026-10-04 排查轮 |
| 26 | ~~门禁 problems 解析可能放行~~ | **已完成（2026-10-04 第八轮）**：`run_curriculum_gate` 在 `returncode != 0` 且 `_gate_problems` 解析为空时**判失败**，把原始输出（截断）塞进 problems，不再当通过。原文：`_gate_problems` 只认特定前缀，`returncode != 0` 但解析为空时 `if not problems: return data` 会把未过大纲当通过（K 系列「不信任模型自查」的不变量在解析层被绕开） | 2026-10-04 排查轮 |
| 27 | M4 generate 链未工具化 | `generate.py` 仍是单次派工，与 build 的大纲派工（同角色 curriculum-designer）不一致；是否有意保持旁路待拍板 | 2026-10-04 排查轮 |
| 28 | ~~建课/产课编排的过程可见性~~ | **已完成（2026-10-04 第六轮）**：`ProgressReporter` + `progress` SSE + 建课进度卡 / 产课进度行（方案 ①），与 #22 一起落地；E2E 覆盖不了（fixture 是瞬时的），改由组件测试铺（`ChatView.test.tsx` 的进度卡用例）+ pytest 3 条。原文： 编排期间唯一的 UI 事件是「门禁/检查 start·done」（只在模型调用 `submit_curriculum` / `run_check` 时才发），而实测单轮 LLM 调用就要 **126.6s**（`Deepseek-v4-flash` + 档位 high，34644 字思维链 / 11227 输出 token，才发起第一次工具调用）；工具循环上限 12 轮 ⇒ **整条建课 10 分钟量级、其间零反馈**，与「卡死」在体验上无法区分（`data/audit/build-subject-68e696.jsonl` 只有 `dispatch` + `agent_start` 两行，因为**思维链与正文都不落审计**）。候选：① 把 agent 的 reasoning/工具轮次透成 SSE，编排卡显示「第 N 轮 · 正在思考…（已等待 Ns）」② 仅加心跳（周期性 stage 事件）③ 只加墙钟超时（#22）不做可见性。建议 ①+③：#22 是"别永远卡住"，本条是"看得见在工作" | 2026-10-04 排查轮 |
| 21 | `Deepseek-v4-flash` 档位取值与网关不匹配 | 本机 settings 里该模型的推理档位是 `disabled/enabled`，但网关（new-api）只接受 `none/minimal/low/medium/high/xhigh/max` → 选中该模型会 400（探针实测）。属**用户数据问题**（改档位名即修），不在代码门禁内；列此备忘 | 2026-10-04 探针发现 |
| 29 | **chat 角色工具面扩容**（挂 K4） | 插件「学习模式」预设给总控的工具面远大于 Web chat 现状（见 §5.3 差距表）。本轮先补最小通路（产课/评估工具 + 自动关联 + 右栏图谱），**整体扩容挂 K4 分期**——这是"建完课接不下去"的根因，不只是少一个按钮 | 2026-10-04 第八轮调查 |
| 30 | 聊天里产课的过程不落 stage 卡 | 产课过程只发 transient `notice`（progress 节流 ~10s），刷新后看不到过程；可把关键 stage（讲解/出题/检查）也落成会话卡。**产课工具的真实 LLM 冒烟尚未跑**（本轮真实链路只验证了建课） | 2026-10-04 第八轮 |

> 2026-10-04 第三轮（消息操作与中间过程折叠）：助手名称栏（「提供商 / 模型」落库）、消息操作条（用户复制 / 编辑＝截断重发、助手删除整轮 + 内联二次确认）、思维链 / 工具调用 / 本轮提示收进默认收起的「中间过程」折叠区并**落库持久化**、右栏「上下文窗口」栏（末块 `usage` 落会话）、头像放大到 56px、模型与档位下拉靠右且去掉「思考 · 」前缀、输入栏上方细线移除、空态大图标改品牌图标、设置页模型默认值改**兜底默认**语义（不再预填，见不变约束 #15）；同轮用真机探针确认网关思维链字段名（`delta.reasoning_content`）与 usage 默认到达，并发现 `Deepseek-v4-flash` 档位名与网关不匹配（backlog #20/#21）。
>
> 2026-10-04 第二轮 UI 杂项轮：会话级工作区（拍板"甲"，`workspace_ctx` 单收口点）/ 新对话「科目 + 工作区」关联行 / 右栏「会话关联」移除（小结与沉淀记忆入口悬空，见 #17）/ 对话框推理档位独立下拉（模型弹层 chip 删除）/ 课程页再对调（大纲与图谱都进右栏做分段切换 + 科目状态进头部 + 缩放灵敏度调优 + 重置视口）；同轮修掉一枚"图谱可能整体不渲染"的 ref 竞态 bug（详见 Web_CHANGE 同日条目）。
>
> 2026-10-02 提供商/模型域 v2 轮：提供商页 zcode 形态重建与模型级思考档位（F2/F8）、测试连接回落已存 Key（F1）、对话壳层与右侧边栏（F6/F9）、按会话草稿缓存（F10）、logo 图标（F3）、暗色下拉（F4）、概念本科目必填（F5）、侧边栏拖拽调宽（F7）；同轮修掉 `playwright.config.ts` 与 `tests/e2e/constants.ts` 两处 E2E 路径口径 bug。
> 2026-10-02 提供商/模型域 v3 轮（对照 ZCode 真实实现）：模型 schema 升到 v3（输入模态复选框组 / 最大输出 Token / 上下文窗口 / 推理档位有序 chip 编辑器 / 能力声明），API Key 改为**回填输入框**不再掩码吞掉；右侧边栏抽成 `RightRail` 共享外壳并支持拖拽 + 折叠动画，课程图谱页节点详情改由它承载。版本号按维护者要求加 `-beta` 后缀（0.4.0-beta）。

> 2026-10-03 生产侧实施轮（C/D/E/F/J 落地）+ 真实 LLM 冒烟：基线式子代理（无工具单次调用、SKILL.md 全文注入、派工值内联、JSON envelope 交付、路径模式归属打回、质检工单转人工）全链落地；用维护者的 my-api 把判分 / 评估 / 课件产出三条链各跑真实冒烟——判分与评估一次通过（judge 口径准确、评估联升与记录落盘正确），产出链全机制走通（派工交付含 lab/ 整棵树 → 渲染/检查打回 → 重派 → 工单）。冒烟踩出三枚基建问题并修复：Windows 注册表系统代理经手本机网关（本机 base_url 挂精确 host 直连 mounts）、读超时 300s→900s（mimo-medium 单派工全程 694s）、派工 envelope 偶发畸形加原值重派兜底（pytest 38 条全绿）。模型选型（my-api 五模型，均带思考档）：产出链用 space-bunny-alpha（两节点 3 分钟，快 13 倍，合规性弱靠工单兜底），质量敏感面（对话/评估）用 mimo-v2.6-flash（单节点 40 分钟，内容最好），agnes 无速度优势弃选、u2-flash 耗时与产出倒挂排除。版本号 0.4.0-beta → **0.6.0-beta**。

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

### 5.3 主动检索议程与 chat 角色工具面差距（2026-10-04 第八轮调查，维护者点名）

**主动检索议程（现状 / 影响 / 可选路线，本轮不实现）**

- **现状**：Web 早前拍板"资料收集只做落盘结构化、不做主动检索"（见 #9）。插件侧却是 `resource-scout` **默认全网检索**、`tool-web` 提供 fetch+search，`image-scout` 再沿它给出的链接清单抓图。
- **影响**：从零建课时资源清单为空（`RESOURCES.md` 无可抓 URL）⇒ **采图结构性空转**（第八轮已把文案改成「采图 · 跳过（无参考资料）」止损，但本体问题在资料清单为空）。
- **可选路线**：① 恢复最小检索（对齐 image-scout：纯后端、不进角色体系）；② 保留只读并**去掉采图阶段**；③ 用 web 工具**让 agent 自己检索**（依赖网关支持，挂 K4）。**本轮不实现**，等维护者拍板。

**chat 角色工具面差距表（插件「学习模式」预设逐项 vs Web chat 现状）**

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

> 插件总控自己写盘、自己跑渲染器与检查、自己派角色、能联网检索、能 present 产物（`learning-system` 明说"其余一切你自己做"）。Web chat 目前只有 3 个只读工具 + 本轮新增的 2 个动作工具——工具面整体对齐挂 **K4（backlog #16/#29）**。
