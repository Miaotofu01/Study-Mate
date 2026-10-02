# Web_CHANGE.md — StudyMate Web 计划与变更留痕

> 性质：**历史留痕档案**，只追加、不改写已有条目。记录已完成的旧计划、方案定稿与重要变更的"当时怎么想、做了什么"。
> 现行文档分工：开发与待实现计划见 [StudyMate-Web_开发与计划.md](StudyMate-Web_开发与计划.md)；
> 功能规格见 [StudyMate-Web_PRD.md](StudyMate-Web_PRD.md)；
> 测试流程见 [StudyMate-Web_E2E测试流程.md](StudyMate-Web_E2E测试流程.md)；运行与部署见 [README.md](README.md)。

---

## 2026-09 末 ~ 10-01 · 阶段 0–2（已交付）

### 背景与目标（阶段 0 定边界）

- 起因：部署调研 DeepTutor（HKUDS，约 20 万行的独立 AI 导师 Web 应用）后，希望为 Study-Mate（Miaotofu01，寄生在 DSH / Antigravity / Codex 等 Agent 上的学习技能包 + Python 静态课程工作区生成器，无自己的 Web 入口）构建**独立可运行的 Web 应用**。
- 两个参考项目的角色：DeepTutor = 功能与前端代码的**借鉴对象**；Study-Mate = **领域核心与特色来源**（课程图谱数据合同、learn with doing、错误概念本、静态工作区兼容）。
- 目标：干净、可独立部署、可持续扩展的工程，而非 DeepTutor 的裁剪副本。

### 核心设计决策（当时拍板，仍有效）

1. **不整体复制 DeepTutor**（Partners / Book / MCP / Visualize / 多用户等用不上，只抽运行时骨架 + 保留课程领域核心）。
2. **新建干净 Next.js 工程**按需移植，不在 DeepTutor 的 web/ 目录上裁剪。
3. **流式协议用精简版 SSE**（fetch + ReadableStream），不用 DeepTutor 的 WebSocket turn/lease/recovery 状态机；阶段 1 仅参考其 Markdown 渲染链路与 UI 组织。
4. **分四阶段递进**，每阶段独立可验证。
5. （10-01 追加）**阶段 3 采用"薄客户端 + 脚本复用 + 人当总控"**，不在 FastAPI 里重造 agent 社会（详见下文 10-01 条目）。

### 阶段 1 交付（最小运行时）

FastAPI 后端（LLM 配置 + SSE 流式聊天 + 文件型会话存储 + Provider 设置，api_key 掩码回传）+ Next.js 前端（布局 + 侧边栏 + Chat 流式界面 + Markdown 渲染 react-markdown 全家桶 + 设置页）。端口约定：后端 8101 / 前端 dev 3800 / 生产 3801，`/api/*` 由 Next rewrites 同源代理。SSE 事件契约：session / delta / done / error。验证：curl 全套通过，无 Key 优雅发 error 事件。

### 阶段 2 交付（课程图谱与进度，2026-10-01）

- 后端：`curriculum_store.py`（workspace 布局 `data/workspace/subjects/<slug>/{subject,curriculum,progress}.yaml`，`STUDYMATE_WORKSPACE` 可覆盖，空目录从 seed 种入示例）、课程 CRUD + curriculum 写回校验（422 带 problems）+ 进度状态机（非法流转 409、mastery clamp）、Chat 课程上下文注入（科目/节点联动，多轮沿用）。
- 掌握度状态机与 `scripts/statuses.py` 口径一致；"完成" = 能独立应用 + 已通过项目验证。
- 前端：cytoscape 图谱按状态着色 + 节点详情/进度编辑/"问 StudyMate"、侧边栏会话/科目列表、Chat 科目节点双下拉。
- 一键启动 `start-studymate.bat`（GBK+CRLF）；质量流程：并行子代理开发 → 集成联调 → 独立代码审查（1 P0 路径遍历 + 3 P1 全修复）→ bat 双击测试。

---

## 2026-10-01 · 阶段 3 方案定稿（v0.3，"薄客户端 + 脚本复用 + 人当总控"）

### 本体机制调研结论（方案依据）

- Study-Mate 本质：**多 agent 社会分工 + 确定性渲染管线**——LLM 只产内容与状态，一切可推导的（序号、指针、壳、配色、位次、两两对账）都由 Python 脚本从 curriculum.yaml 推导；"认不出就报错，绝不静默降级"。
- 技能体系 12 个：总控 learning-system（唯一与用户交互者）+ 5 角色（coach/evaluator/designer/scout×2，均禁自调用、只收全新上下文 subagent）+ 6 协议（record-keeping/layered-practice/lesson-design/evidence-check/local-qa/learning-discovery）。
- 派工硬约束：prompt 只给规格绝对路径 + 按文件归属表给值 + 三条边界；交接只传路径与锚点（`::: quiz` 是课件与题库唯一接头）；禁 fork；同科目单写入者；验收不过打回同一产出者。
- 课程生成三段：建课（盘问五项 → MISSION/subject → 三角色并行 → check_curriculum PASS 才收）→ 单节点三件套（coach 写 .md 只留锚点 → evaluator 按锚点出 .quiz.json → render_lesson → check_lesson → gen_home）→ 学习期（页内 quiz.js 判分不写盘；提问亲答 ≤200 字双落点记误解；仅三类评估点派评估，证据核验"运行结果>产物>复述>口头"；实验课通过连前置一起置"已通过项目验证"）。
- 设计哲学两条：agent 只产内容与状态，脚本负责一切可推导；状态唯一真值是 progress.yaml。

### 覆盖度评估（阶段 1+2 vs 插件，方案动机）

| 插件侧能力 | 当时 Web 现状 | 覆盖度 |
|---|---|---|
| curriculum-designer + check_curriculum | PUT curriculum 校验（拦坏数据，不能生成） | 约一半 |
| gen_home 路线图 | /courses cytoscape + 完成度 | 展示层相当 |
| 课件三件套 | NodeDetail 仅元数据 | 仅元数据 |
| practice-evaluator + evidence-check | 无 | 零 |
| resource-scout / image-scout | 无 | 零 |
| 评估/学习记录/会话摘要/MEMORY | 会话是原始日志 | 零 |
| misconceptions 双落点 | 仅 notes 字段 | 约一成 |
| 总控携带课程状态 | Chat 上下文注入 | 形似 |
| local-qa | 自由对话 | 零 |

### 三条不可妥协线（退了就变味）

1. **数据合同**：curriculum/progress 口径与 `schemas/*.schema.json`、`statuses.py` 一致。
2. **门禁**：大纲/锚点/课件校验一律**调上游脚本**（check_curriculum / render_lesson / check_lesson / gen_home），Web 侧不写第二份规则。
3. **证据标准**：口头说懂不算数；判分必须引用证据，对节点 objective 与每题 criteria 核验。

### 妥协清单（三档）

| 档 | 插件做法 | Web 等价物 |
|---|---|---|
| 一·放心换形式 | 5 角色物理隔离 | 同一模型不同 system prompt 串行调用 + 脚本校验卡点 |
| 一·放心换形式 | .stage/deliver + cp 搬运 | 后端临时目录 + 原子落盘 |
| 一·放心换形式 | 总控盘问 ask_user | 前端向导表单（Web 主场优势） |
| 一·放心换形式 | 同科目单写入者 | 后端任务串行化 + 文件锁 |
| 二·补机制 | 出题与批改独立（evidence-check 防线） | 判分换一次调用、强制引用证据原文 |
| 二·补机制 | scout 联网检索 | 先"用户粘贴/上传落盘 sources/、reference/"，检索后补 |
| 二·补机制 | 先写盘正文只给清单 | API 调用全文在手，天然不存在 |
| 三·延后留口 | lab 代码沙箱 | 先"本地跑完贴回结果"，留任务状态接口 |
| 三·延后留口 | 跨科目 MEMORY.md | 只读展示不写；misconceptions 先单科目 |

### 任务分解 v2（M1–M4，已全部实施，见 10-02 条目）

- M1 3.3 错误概念本：纯 CRUD 双落点；前端概念本视图（列表/筛选/多入口）。验收：curl 全套 + UI；两落点与 progress.schema 一致。
- M2 3.1 课件展示：lessons/*.html 内嵌（iframe）；quiz.json 按 quiz.js 顶部契约渲染；无产物降级详情面板。
- M2 3.2 练习判分：选择题前端按 ans 判（零后端成本）；开放题判分 lite（独立 LLM 调用，criteria 为标准 + 强制引用作答原文证据，引用不出判不过）；lab 留状态接口。
- M3 3.4 评估与小结：按 assessment/session-summary schema 组 prompt 生成 front matter Markdown → 落盘 → schema 校验 → 状态机更新。
- M3 3.5 静态导出：写回 + 子进程调 gen_home.py，不写 TS 版主页生成器。
- M4 3.6 科目生成：五项向导 → 组 prompt 生成大纲草稿 → **check_curriculum.py 当门（PASS 才收）** → 建科目落盘。
- 明确不做/延后：lab 沙箱执行、跨科目记忆写侧、多 provider 管理（后被 0.3.1 轮推翻实施）、会话 SQLite、多用户/在线编辑器。

---

## 2026-10-02 · 阶段 3 实施完成（M1–M4 全落地）

- M1 概念本：`app/misconceptions.py` 双落点（misconceptions.yaml 为 canonical 源、旧条目补 id 幂等回写、最近在前）+ CRUD 路由 + `/misconceptions` 页（筛选/增删改/多入口预填）。
- M2 课件：`GET .../lessons`、`GET .../files/{path}`（防遍历、缺 index.html 回退跳转）、**`GET /api/courses/assets/{path}`**（工作区级共享资源先 `<workspace>/assets` 后回退仓库 `templates/assets/`——修复课件 `../../../assets/...` 断链）、`GET .../quiz/{node_id}` 展平；`/lesson` iframe + 判分抽屉；`grade` 端点强制证据引用；lab_status 四态接口。
- M3：`records.py`（front matter + jsonschema 读仓库 schemas 校验）+ assess/summary/records 路由（verdict=通过走状态机：实验→已通过项目验证，其余→能独立应用）；导出 = 整科目拷贝 + 子进程 gen_home.py；`/generate` 五项向导 + check_curriculum.py 当门（FAIL 422 带 problems）。
- 验证：compileall + build + 隔离端口代理层 curl 全套；LLM 端点无 Key 422 / 上游失败 502 且不落盘（真实 Key 成功路径仍遗留）。

---

## 2026-10-02 · 0.3.1 轮（模型提供商与聊天输入，对照 DeepTutor）

用户逐项确认的 9 条决策（详见 PRD 决策记录）：多提供商列表+激活制；预设格式允许改；提供方与语言模型合并一页；附件完整上传与发送、统一 📎 入口；模态两段式（输入不拦截/按能力注入占位/错误码剔除重试）；聊天页顶栏模型快捷切换；系统提示词独立配置项；版本 0.3.1（语义化、仅标识 StudyMate Web、变更需维护者同意）；新建 PRD。

交付：settings v2（providers[] + active + 自动迁移不丢 Key）、三种 API 格式统一适配层（openai_chat/openai_responses/anthropic，假上游实测请求构造）、模态两段式（视觉前缀表 + 占位 + Stage-2 错误标记剔除重试一次 + SSE notice 事件）、附件链路（统一 📎 / POST /api/uploads 先传后引 / doc_extract 解析管线 pdf·docx·xlsx·pptx·epub·文本类 / 预算 20000·60000 / 会话删除清理与孤儿清扫）、设置二级界面（providers 主从页/system-prompt/about）、聊天两态改版（问候 + chips + 650ms 落底过渡）、顶栏模型选择器。

实施中抓到的真 bug：Next 16 代理 gzip 缓冲 SSE 导致流式失效（`compress: false` 修复）；ProvidersView 添加重复插入；前后端契约错位两处（created_at 类型 / preset_key 可空）。

---

## 2026-10-02 · E2E 测试框架与流程

- 框架：Playwright + 后端确定性 fixture 模式（`STUDYMATE_E2E_FIXTURE=1`，canned 流/JSON 全部过真实解析链路；`STUDYMATE_DATA_DIR` 隔离数据目录；未设环境变量零影响）。首批 6 条关键旅程全绿。
- 流程文档 `StudyMate-Web_E2E测试流程.md`：把上游插件用户旅程（docs/）逐阶段映射到 Web 等价功能，规划扩充至约 18 条旅程级用例；分层策略 = 后端 fixture 主力 + 局部 UI route mock 补失败分支；长期预留 `SMOKE_REAL_LLM=1` 真实 Key 冒烟位。
- **同日扩充完成**：25 条用例全绿（新增/扩展 19 条，两轮幂等）；落地时的 9 处实现偏差已回写测试流程文档 §3.13；顺带产出 `待修.md`（3 个待确认 UI 问题：API Key 输入框占位/可见性切换、模态选择逻辑、品牌图标 favicon）。

---

## 2026-10-02 · 上游同步与文档重定位

- 远端布局确认：origin = 用户 fork（Sodapopper-pixel/Study-Mate，PR 目标），upstream = Miaotofu01/Study-Mate；本地 main ff-only 跟随上游。
- 拉取上游文档重构（3343019）：docs/ 按用途归位（使用/规范/设计/agents），根 AGENTS.md 归上游（纯指针风格 + agent 约定层）；web 的 AGENTS.md 与 .gitignore 移入 study-mate-web/（web 版 AGENTS.md 为 web 特有规则指针集）；根 README 仅加"StudyMate Web"小节提及与部署指针；对 web 零冲击（render/模板/examples 改动全是文档路径注释）。
- 本文档重定位：原《StudyMate-Web_需求与规划文档.md》拆分——开发与计划收进《StudyMate-Web_开发与计划.md》，旧计划与变更史由本文件承载。

---

## 2026-10-02 · 覆盖率核验 + grill 第一轮（Web 全功能复现方向）

- Web 现有实现 vs docs/ 用户旅程核验（以 dsh 插件为基准）：拆 39 个用户可见能力单元逐条对代码核验——已覆盖 8（20.5%）、部分 14（35.9%）、未覆盖 15（38.5%）、不适用 2（5.1%）；加权约 40%（消费/交互侧约 57%、内容生产/写侧约 10%）。八条关键偏差：开场状态切片无 MEMORY 与记录类切片、无开场报告与「下一步」仪式、盘问表单化、评估点无自动判定、实验课通过不联升 prerequisites、学习记录不写、摘要覆盖而非追加、附件区无入口；另与 VitePress 提案「前端不回写」硬边界存在定位冲突，待处理。
- 维护者拍板：Web 目标改为**复现乃至拓展 dsh 插件全功能**（「web 不写课程、只复用已有」不符合构思）；取舍一律走 grill-with-docs 逐项决策。backlog 同步：#2 改为「推进至可 PR 状态后再建 web 版文档，现阶段只写计划」；#6 lab 沙箱执行**明确不做**（lab 留任务内容与四态接口）；#7 改述为「MEMORY.md 读写」（原「现只读展示」与实际不符，现读写皆无）。
- grill 第一轮四决策：Q1 产课链 = LLM 直写 + render_lesson.py 渲染 + check_lesson.py 质检收口；Q2 建课落点 = 浏览器草稿区 + 一次落点确认；Q3 盘问 = chat 内对话式（frontier 问空为止）；Q4 短期验证集全选（开场状态切片 / 开场报告与下一步仪式 / 评估联升与学习记录 / 摘要追加与附件区）。

---

## 2026-10-02 · 工作区默认路径拍板 + 运行时目录上提一级

- 维护者拍板：**默认工作区走与插件一处口径**（不新造 `~/.studymate`，与"全打通：同构布局 + 复用发现"Q10 一致）。
- 运行时目录由 `backend/data/` 上提一级至 `study-mate-web/data/`（settings、sessions、workspace、uploads、exports）。改动只碰路径解析：`config.py` 新增 `WEB_ROOT`、`DATA_DIR = WEB_ROOT / "data"`；`curriculum_store.workspace_dir()` 改从 `config` 引入 `DATA_DIR`；`playwright.config.ts` 与 `tests/e2e/global-setup.ts` 的 E2E 目录同步；`.gitignore` 首行改 `data/` 并保留 `backend/data/` 兜底旧布局残留。已有开发数据（settings/sessions/workspace）随目录搬迁原样保留，未动内容。
- 验证：`compileall` 通过；隔离端口 curl `/api/health`、`/api/courses`（搬迁后科目仍在）、`/api/settings`、`/api/courses/{slug}/lessons` 正常。
- 文档同步：README 目录结构与两处路径、开发与计划架构图与附件契约、PRD §1.1 与 §4.2、E2E 流程数据隔离说明均已改为新路径。

---

## 2026-10-02 · grill 第二轮（Q5–Q11）与目标转向

- **目标转向**：Web 不再"只消费已有产物"，改为**复现乃至拓展 dsh 插件全功能**；取舍一律走 grill-with-docs 决策树，由维护者逐项拍板。覆盖率核验结论（加权约 40%，消费侧约 57%、生产侧约 10%）作为补齐清单的基线。
- **Q5 阅读端**：上游渲染产物原样 iframe 承载，Web 只做壳；静态 HTML 保留为离线入口（与"导出静态工作区"同源）。增量改进只四类：开场切片、附件区入口、主题/导航一致性、移动端可读性，不碰渲染产物。
- **Q6 资料收集**：只做落盘结构化（用户给料 → 转 Markdown → `reference/` + 资源清单），不做主动检索。
- **Q7 image-scout**：全量复现，配额/过滤/命名索引照搬插件（每站 8 页/6 张、≤1 请求/秒、尊重 robots），`pool.md` 索引由后端维护。
- **Q8 方向探索**：复现为 chat 内可选入口，探索期不写盘、三级确认分开；E2E 映射表"不适用"行在实现后改"已覆盖"并补用例。
- **Q9 记忆写侧**：`memory_updates` 建议 + 用户逐条确认后写 `.learning/MEMORY.md`；读侧同步进开场切片。
- **Q10 工作区全打通**：Web 改 `<WS>/.learning/subjects` 同构布局；发现复用 `gen_home.py::learn_workspace()`（AGENTS.md 硬规矩 3 已补这条）；启动向导允许选目录，默认沿用插件默认 `~/StudyMate`（不新造 `~/.studymate`）。
- **Q11 系统提示词分层**：默认 persona（取 `preset/learning/agent.cordis.yml` 主教练口径，设置页可改）+ 后端各链路按需读 `.dsh/skills/<名>/SKILL.md` 全文注入；新增 `backend/app/prompts.py`。现 `config.py` 两句话提示词等于丢掉 12 份行为规格。
- 实施队列（A 工作区 → B 提示词 → C 产课链 / D 开课链 / E 采图 / F 探索 / G 壳层 → H 验证集 → I 记忆）见本文档 §5.1；明确不做项见 §5.2。
- 待办风险：VitePress 提案"前端不回写"硬边界已被上述实现方向推翻，需与维护者另行对齐。

---

## 2026-10-02 · 交接给实施代理（第三版 HANDOFF）

- 全部 grill 决策已入档：《开发与计划》§5.1 实施队列（A 工作区 → B 提示词 → C 产课 / D 开课 / E 采图 / G 壳层 → H 验证集 → I 记忆）与 §5.2 明确不做；`AGENTS.md` 规则 3 扩写为"上游脚本只复用不重写"并纳入工作区发现复用，规则 4 路径随目录上提更新；E2E 流程映射表加"待翻转行"（选方向 / 产课写侧 / MEMORY 写侧三行在对应功能落地后改"已覆盖"并补用例）。
- `HANDOFF.md` 重写为实施代理版：主线是 §5.1 阶段顺序（A 必须先行、B 是公共输入、H 先做），硬约束三条（上游脚本只复用 / iframe 壳层 / 文档同步），踩坑清单与嵌套残留说明。
- 状态仍为**未提交**（`study-mate-web/` 整体未跟踪，根 `README.md` +5 行）；提交需维护者明确同意。

---

## 2026-10-02 · 反馈清单轮（10 条落地 + 修两处测试侧路径 bug）

- **人工反馈 10 条全部落地**（`反馈清单.md` 逐条回填）。分三块实施：提供商/模型/思考域（API Key 三问题 + zcode 形态重建 + 思考档位）、对话壳层（顶栏瘦身 + 右侧边栏 + 用户气泡 + 草稿缓存）、侧边栏与全局小修（logo 图标 + 暗色 `<select>` option + 概念本科目必填 + 侧边栏拖拽调宽）。
- **F1 测试连接误报"缺少 API Key"（真 bug）**：`runTest` 只发输入框的值，而已保存 Key 的提供商输入框恒空 → 后端 422。修法：`ProviderTestRequest` 加 `provider_id`，后端在 key 为空/掩码时回落已存 api_key；前端补"显示/隐藏密钥"切换并把占位符从字面量圆点改为文字提示。后端 curl 实测：有已存 Key → 502（回落成功），无 Key → 422，未知 id → 422；掩码不回写覆盖已存 Key。
- **F2/F8 提供商页按 ZCode 形态重建**：提供商头部（启用开关 + "…"菜单）、只读模型摘要行（上下文长度/视觉/思考徽标 + 测试/编辑/删除/启用四操作）、模型编辑弹窗（模型名/显示名/上下文长度/模态/思考档位/启用）。**明确不做"智能配置"**（不自动探测模型能力）。
- **新增数据契约**（向后兼容，缺字段取默认）：`ProviderModel` += `display_name` / `context_window` / `thinking` / `enabled`；`ProviderEntry` += `enabled`；`ActiveProvider` += `thinking`。思考档位按 API 格式映射（Chat 走 `reasoning_effort`、Responses 走 `reasoning.effort`、Anthropic 走 `thinking.budget_tokens` 并抬高 `max_tokens`）；**档位为"关"时 payload 与改造前逐字节一致**。
- **F9/F6/F10 对话壳层**：顶栏只留标题 + 右侧边栏折叠按钮；模型选择器移入输入框内；新增右侧边栏（会话关联 + 会话信息）；用户消息靠右并加品牌色气泡（助手不加气泡）；输入框草稿按会话在内存缓存，**浏览器刷新即空**（维护者明确：刷新归空是预期，不做持久化）。
- **F3/F4/F5/F7**：`docs/images/logo.png`（512×512 RGBA）缩放为 192×192 放入 `frontend/public/icon-192.png`，配 `metadata.icons` 并替换侧边栏品牌位（圆角裁切）；`globals.css` 加 `select option` 最小规则修暗色下拉；概念本弹层补必填「科目」下拉（未选时禁用保存 + 可见提示，不再静默 return）；侧边栏右缘加拖拽手柄，宽度 180–420px 并写 localStorage。
- **修两处测试侧路径 bug（潜伏已久，非本轮引入）**：`playwright.config.ts` 的 `WEB_ROOT` 多算一级（`../..` → 仓库根）、`tests/e2e/constants.ts` 硬拼 `backend/data/`，两处都把 E2E 指到仓库根 `data/`，导致后端读到陈旧 fixture（无 key、无 lessons）而大面积失败；因 `reuseExistingServer` 会复用手工启动的正确服务，该错误长期不可见。现已统一到 `<study-mate-web>/data/`，并在 E2E 流程文档写明"四处路径口径要一起改"。
- **验证**：`npm run build` 通过；后端 `compileall` + 隔离端口 curl 全套通过；E2E **34 条两轮连跑全绿**（上一轮 25 条）；`npx tsc --noEmit` 无错。
- **未做 / 待办**：版本号未动（需维护者同意）；E2E 补强计划 P3（渲染矩阵）/P4（组件测试层）未落地；真实 Key 下的思考档位端到端未验（本机无 Key）。

---

## 2026-10-02 · 提供商域 v3（对照 ZCode 真实源码）+ 右侧边栏统一 + 版本加 -beta

- **背景**：维护者复查上一轮的 ZCode 形态实现，指出两处没照源码做的硬伤——**模态应是复选框而不是单选下拉**、**缺「最大输出 Token」等字段**；同时要求 API Key 留在输入框而不是被掩码"吞掉"、右侧边栏支持拖拽且折叠带动画、课程图谱页的节点详情改由右侧边栏承载、版本号加 `-beta`。ZCode 为开源项目 `zai-org/ZCode`，本轮以它的**源码与本机配置**为依据逐项对齐，不再靠截图猜测。
- **依据（已核对）**：`packages/shared/src/model-config.ts` 给出权威字段集 `properties{contextWindow, inputFormat{text,image,video,pdf}, outputFormat, supportsToolCall/JsonSchemaOutput/NativeWebSearch/MidConversationSystem}` 与 `optionSpecs{reasoningLevel{values[]}, maxOutputTokens{max}}`；`settings/model-provider-section/ProviderModelModalityOptions.tsx` 里模态是 4 个 `role="checkbox"` 按钮（`INPUT_MODALITY_OPTIONS = text/image/video/pdf`）；`ModelEditorAdvanced.tsx` 把「高级」做成 ChevronRight 折叠区且收起时保留子内容挂载（`inert`）；`ProviderModelReasoningLevelEditor.tsx` 的档位是**可增删改排序的有序 chip 列表**；本机 `~/.zcode/v2/config.json` 的解析形态为 `{name, reasoning{enabled,variants[],defaultVariant}, limit{context,output}, modalities{input[],output[]}}`。
- **模型 schema v2 → v3**：`ProviderModel` 由 `{name, display_name, context_window, vision(auto|on|off), thinking(off|low|medium|high), enabled}` 改为 `{name, display_name, modalities{text,image,video,pdf}|None, context_window, max_output_tokens, reasoning{enabled,variants[],default_variant}|None, capabilities{tool_call,json_schema_output,native_web_search}|None, enabled}`；`ActiveProvider.thinking` → `reasoning_variant`。迁移等价且幂等：`vision:on→{text,image}`、`off→{image:false}`、`auto→None`（仍走内置前缀表，行为不变）；`thinking:low|medium|high→reasoning{enabled,variants:[off,low,medium,high],default_variant:<旧值>}`、`off→None`；旧客户端 PUT 带 `vision`/`thinking` 也按同一规则解析（`model_validator(mode="before")`）。
- **接线**：视觉判定改为「配了模态用模态、未配置回落前缀表」；`max_output_tokens` 非空时作为输出上限（Anthropic `max_tokens` 等）；推理档位取 `active.reasoning_variant` → 模型的 `default_variant`，未启用 / 列表空 / 档位为 `off` 时**不发任何思考参数**（payload 与改造前逐字节一致）；`capabilities` 只落盘与展示。
- **API Key 不再吞掉**：GET `/api/settings` 回传**真实密钥**并用它回填输入框（密码点显示、眼睛可切明文）；PUT 仍接受 `********`/空串表示"不修改"（向后兼容）；测试连接以输入框为准，清空时才回落已存 Key。
- **右侧边栏统一**：抽出 `components/RightRail.tsx` + `lib/useResizable.ts`（左栏也改用它，去掉两份手写拖拽）。折叠用**宽度过渡动画**、内容保持挂载（`inert` + `aria-hidden`）、尊重 `motion-reduce`；宽度按页面分别持久化（`studymate-chat-right-sidebar-width` / `studymate-course-detail-width`）。**课程图谱页的节点详情改由 `RightRail` 承载**（默认展开，折叠按钮在图区，画布加 `ResizeObserver` 自适应）。根元素用 `div[role=complementary]` 而非 `<aside>`，避免"页面上只有一个 aside"的既有假设失效。
- **修掉一个真 bug**：`RightRail` 初版只把宽度加在内容层、`open` 没参与宽度计算，折叠时仅加了 `inert`/`aria-hidden` —— 视觉上根本没收起。是 B 代理自己写的"宽度归零"用例把它抓出来的（`toBeHidden()` 对宽度过渡面板不可靠，改用宽度判据 + 属性断言）。
- **版本号**：按维护者要求加 `-beta` 后缀 → **0.4.0-beta**（`frontend/package.json`、`backend/app/main.py`、README「版本」节、开发与计划架构现状标题；侧边栏读 package.json 自动跟随）。
- **验证**：`npx tsc --noEmit` 无错；后端 `compileall` 通过；隔离数据目录跑 TestClient 全套（GET 回真实 key、v2→v3 迁移落盘且幂等、掩码不覆盖已存 key、三种 test 路径 502/422/502）通过；`npm run build` 通过；E2E **37 条两轮连跑全绿**（上一轮 34 条）。
- **遗留**：`get_active_provider()` 里为不动 `chat.py` 而保留了 `vision` 三态字符串垫片（backlog #13）；`capabilities` 未接线（#14）；模态里的视频/PDF 只落盘与展示；档位排序用 ▲▼ + Alt+方向键，未做 HTML5 拖拽。
