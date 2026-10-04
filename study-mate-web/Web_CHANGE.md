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
- 一键启动 `start-web.bat`（GBK+CRLF）；质量流程：并行子代理开发 → 集成联调 → 独立代码审查（1 P0 路径遍历 + 3 P1 全修复）→ bat 双击测试。

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

---

## 2026-10-02 · 实施轮：工作区 / 提示词 / 验证集 / 记忆写侧（队列 A/B/H/I + G 收尾）

- **阶段 A 工作区与发现**：新增 `app/workspace.py`——发现复用上游 `gen_home.py::learn_workspace()`（子进程调用以隔离其 import 副作用；无配置或脚本缺失时回落 `~/StudyMate` 并记警告；发现结果进程内缓存，`STUDYMATE_WORKSPACE` 覆盖每次动态读）。`curriculum_store.workspace_dir()` 委托它，`subjects_dir()` 加 `.learning` 层；`ensure_workspace()` 只建目录、**取消自动种入示例**（默认工作区可能正是插件在用的 `~/StudyMate`，往里塞示例是不允许的副作用）；共享 assets 探测改 `<WS>/.learning/assets`。设置页新增「工作区」子页（`GET/PUT /api/workspace`）：展示路径/来源/科目数/配置文件位置，可改选目录——行级替换 `studymate-config.yaml` 的 `workspace` 键（保留注释与其它键），保存即生效（清发现缓存）。
- **阶段 B 提示词分层**：新增 `app/prompts.py`（链路 → 技能映射 + `.dsh/skills/<名>/SKILL.md` 全文读取缓存 + "运行环境适配"说明）；`config.py` 的 `DEFAULT_SYSTEM_PROMPT` 改为 `PERSONA_PROMPT`（主教练口径，旧默认文案自动迁移）；chat 注入 `learning-system` + `local-qa`，assess 注入 `practice-evaluator` + `evidence-check` + `record-keeping`，summary 与记忆建议注入 `record-keeping`，grade 注入 `practice-evaluator` + `evidence-check`；技能规范缺失时该次调用明确 503，不静默降级。
- **阶段 H 验证集四项**：① 开场状态切片（会话首条消息且已关联科目时注入 MEMORY 分节 + 最近 5 误解 + 最近 3 学习记录 + 最近 3 评估记录）；② 对话「下一步」节奏由注入的 `learning-system` 承担，fixture 流尾段加行为锚点并由 E2E 断言（真实 LLM 质量仍留冒烟）；③ 评估通过改为**权威置位**（不再受单步 TRANSITIONS 限制），**实验课通过时该节点与 `prerequisites` 被验收节点同置"已通过项目验证"**，并写 `learning-records/<seq>-<node_id>.md`，响应新增 `promoted` 与 `learning_record`；④ 会话摘要同日**按段追加**（保留首个 front matter，追加"本场摘要（HH:MM）"）+ 附件区（`GET /api/courses/<slug>/attachments-area` + 聊天页右栏清单，原文经 `/files/` 读写）。
- **阶段 I 记忆写侧**：新增 `app/memory.py` 与 `routers/memory.py`（`suggest` 从会话提炼建议条目 → `confirm` 逐条确认后按分节**增量插入** `<WS>/.learning/MEMORY.md`，重复条目去重、不整篇重写）；前端新增 `MemoryDialog` 与右栏「沉淀记忆」入口；MEMORY 分节进 H① 切片。
- **G 收尾**：`/lesson` 壳层窄屏可读性（`min-w-0`、按钮图标化、判分面板 `min()` 宽度），主题一致性核查无硬编码；不碰渲染产物。
- **实施中抓到的两枚真 bug（均在测试基建/前端交互侧）**：① E2E 改造 env 注入时丢了 `STUDYMATE_DATA_DIR`，8290 后端回落到开发 `data/`（providers 读到本机数据导致超时、export 产物落错目录、会话写进开发数据）——已补回两个 config，并清理被污染的开发会话（13 个）与导出目录；② `WorkspaceView.load()` 每次完成都 `setInput`，并发/StrictMode 下会覆盖用户刚填的路径（保存的其实是旧路径）——改为仅首次加载回填。
- **验证**：后端 `compileall` + TestClient 分域冒烟（发现链三态、切片、摘要两次追加、记忆建议/确认/去重、实验联升双置位 + 学习记录）；`npx tsc --noEmit`、`npm run build`；E2E **43 条两轮幂等**（37 → 43：新增 `settings-workspace` / `memory-flow` / `attachments-area` 三个 spec，扩展 `assessment`（联升）/ `session-summary`（同日追加）/ `chat-basic`（「下一步」锚点））。
- **遗留与待维护者裁定**：C 产课链 / D 开课链 / E 采图 / F 方向探索未动（《开发与计划》§5.1 队列）；版本号未动（需维护者同意，建议升 `0.5.0-beta`）；布局改 `.learning` 后旧 `study-mate-web/data/workspace/` 存量数据成为不再被读取的孤儿（未做迁移）；`data/settings.json` 里留有 E2E 写入的自定义提供商条目（`my-custom` / `my-api` / `我的中转`）未自动删除——其中 `my-api`、`我的中转` 确认来自 E2E 文案，`my-custom` 来源不明，一并保留待确认；`assess` 的权威置位是行为变更，既有依赖"学习中节点评估通过不置位"的用法需知悉。

---

## 2026-10-03 · 审查轮（三个独立只读代理：后端 / 前端与 E2E / 计划落实核对）

- **方式**：派三个只读代理分别审后端改动、前端与 E2E 改动、并逐条核对 §5.1 拍板与代码/文档的一致性（不修改文件）。结论：本轮无 P0；各功能的契约、约束遵守与文档口径基本对齐；发现 1 项后端 P1、1 项前端 P1 及一批 P2，均已在同轮修复。
- **后端修复**：① `workspace.py` 的空路径校验是死代码（`Path("")` 实为 cwd），`PUT /api/workspace {"path": ""}` 会把后端 cwd 写进与插件共用的 `studymate-config.yaml`——改为先判空/拒换行再 resolve；② 路径含 YAML 敏感字符（` #`、引号）时改用单引号包裹（普通路径仍无引号，与 E2E 断言格式兼容）；③ `PUT /api/workspace` 建目录失败时**回滚配置**（还原改前内容，不留半切换）；④ chat 的技能缺失 503 提前到消息落库之前（原来会留下没有回复的 user 消息并破坏开场切片条件）；⑤ 开场切片的误解源改走 `misconceptions.canonical_items()`（原来绕过 canonical 源，yaml 与 progress 不一致时会漏）；⑥ MEMORY.md 注入加 6000 字上限（超长截断标注）；⑦ memory `confirm` 加后端校验（分节白名单 / 内容非空 / 无换行 / ≤200 字）；⑧ `memory.append_entries` 与 `records.write_summary`/`write_learning_record` 加进程内锁（防并发 read-modify-write 丢更新）；⑨ **实验课置位时掌握度改为「保留或上调」**（`max(现值, 建议值)`，对齐 record-keeping 硬规则原文，原先直接用建议值可降级）。
- **前端修复**：① 附件区科目切换竞态（真 P1——原注释声称"请求期间保持 null"但代码没做，切科目会短暂渲染"新 slug + 旧文件名"的脏链接，点了 404）→ effect 开头清空 + 保留 alive 守卫；② `WorkspaceView` 加载失败态补齐"重试"按钮（原来是死胡同）；③ 加请求序号使在飞的 GET 过期响应不覆盖刚保存的 info；④ 客户端补绝对路径校验；⑤ `MemoryDialog` 条目 key 改用索引（原按内容前 12 字，撞车会让两行同时被编辑）与"勾了但内容为空"的提示文案修正。
- **E2E 与文档**：`assessment.spec.ts` 的快照恢复补 `misconceptions.yaml`（assess 会经双落点新写它，原来残留）；评估会话下拉改 `getByRole("combobox")`（守仓内约定）；`chat-basic` 的时序断言改 `expect.poll` 并删冗余断言；`memory-flow` 的分节断言改为"条目落在分节区间内"；README（settings v3 / seed 说明 / 剩余阶段）、E2E 流程（安装行"首次种子工作区"→ fixture 工作区）、PRD §10（persona 语义一致非逐字）、开发与计划 §1.1（`generate`/`discovery` 标注未接线）、H④/H⑤ 注释笔误一并修正。
- **核对结论**：A / B / G / H③ / H④ / I（写侧链路）判定"已落实"；H① 已按拍板四项齐备（对照上游 record-keeping「恢复视图」仍弱化"前置节点摘要"与"实验课进度"两小项）；H② 属提示词行为（E2E 只能守住 fixture 呈现锚点，真实质量留冒烟）；C / D / E / F 确认为未落实且与 §5.1 标注一致；§5.2 明确不做项无越界。
- **本轮新增的待裁定项**：① I 的触发时机——拍板写"会话结束/评估通过时后端组建议"，实际目前只有聊天页「沉淀记忆」手动入口（`summary` 端点虽已向 LLM 要 `memory_updates` 字段但 UI 未消费、评估通过路径无建议），需定"补接线"还是"改文档口径"；② A 的"启动向导允许选目录"落在设置页输入框（无目录选择器、无 first-run 向导）是否可接受；③ 后端目前零自动化测试（Web_CHANGE 里的"TestClient 冒烟"是一次性脚本，不在仓库），H①/技能注入这类 system 层行为无回归护栏，是否本轮补 TestClient 测试；④ `playwright.config.ts` 的 `reuseExistingServer: !CI` 与 `explorer.config.ts` 的 `false` 口径不一，是否统一；⑤ `chat-shell.spec.ts` 仍用 `toBeHidden()` 断言折叠（与 §6 第 15 条约定相悖，当前能过）。

## 2026-10-03 · 生产侧重启：基线式子代理落地（队列 C/D/E/F 全量 + chat 链路收口 J）

维护者推翻前期"运行时过重"对生产侧的否定：项目本体的 skills 体系本为角色派工而设，不在生产侧实现就会与插件基线漂移。同日 grill 八项拍板（详见《开发与计划》§5.1 C/D/E/F/J 行修订注）：

- **拍板要点**：子代理 = 后端无工具单次 LLM 调用（system = 角色 SKILL.md 全文 + 派工适配声明，user = 派工值），agent harness 仍不做；派工值路径→内容内联；多文件产物走 JSON envelope 逐字落 `deliver/` 再搬正式位；打回归属只认路径模式（`roles.OWNERSHIP`），重试上限 2 轮、耗尽建质检工单转人工；两个 scout（resource/image）是纯后端代码不进 LLM 角色体系；`generate.py` 删 12 条硬编码约束改全文注入；编排进度走 chat SSE；C/D 落地后 chat 链路退回 local-qa（总控职责归还后端）。
- **修掉的漂移**：原 C 行"约束写进 prompt"是第二份规则（违反 prompts.py 自己的"不做裁剪、不实现第二份规则"），本轮全部改为 SKILL.md 全文注入。

### 后端

- 新模块：`roles.py`（派工基建 + envelope 解析 + 归属映射）、`produce.py`（产课链编排：讲解→出题→渲染→检查→打回→工单，渲染/检查走 `asyncio.to_thread` 子进程）、`build.py`（建课编排：大纲派工与采图并行→`check_curriculum.py` 门禁→落盘）、`draft.py`（草稿区 `data/drafts/<slug>/` 同构布局 + 落点确认 promote + gen_home 刷主页）、`tickets.py`（质检工单存储 data/tickets.json）、`image_scout.py`（采图爬虫：每站 8 页/6 张、≤1 请求/秒、robots、SSRF 校验拒绝私网地址、手动重定向逐跳校验、命名术语表用词 + `check_pool.py` 自检）。
- 新路由：`routers/production.py`——产课 SSE（`POST /courses/{slug}/nodes/{node}/produce`）、建课 SSE（`POST /drafts/{slug}/build`）、草稿 CRUD + 落盘结构化资料 + 落点确认、工单列表/详情/重试/复检/快改/放弃；编排事件同时持久化为会话消息（`kind: stage/handoff/done/error/build_confirm`），持久化挂在 emit（生产侧），断连不丢。
- chat 链路：会话模式化（`mode: chat|interview`）——关联科目只注入 `local-qa`（拍板⑧），建课会话注入 `learning-system + learning-discovery` 全文 + 收口标记口径；`<!--INTERVIEW_RESULT-->{JSON}<!--/INTERVIEW_RESULT-->` 解析后建草稿并落「确认建课」卡。persona 扩写承接「开场报告 + 每轮下一步」仪式。fixture 支持 `fixture_scenario` 按请求选固定流场景（仅 fixture 模式生效）。
- 产课按大纲顺序强制（上游检查器要求课件编号连续）；实验课不派讲解（说明页报错归属出题）；检查器报错归属按消息正文引用的产物路径补判（`learning-system` 打回表的机械延伸）。
- 上游脚本零重写：render_lesson / check_lesson / check_curriculum / check_pool / gen_home 全部子进程调用，缺失 503。

### 前端

- `ChatView`：kind 消息卡（阶段播报 / handoff 失败卡 / 建课确认卡 / 落点确认卡）+ 建课编排客户端 + 「不知道学什么」探索入口 + 编排可中止（切会话即停）+ 建课中禁输入。
- `NodeDetail`：「产出此课」按钮 + 内联进度 + 节点工单角标；节点切换重置产课状态、在途结果不写进切走的节点视图。
- 新组件 `InspectionDialog`（两段式质检工单）：总览（报错按归属分组 + 全部重试/重新检查/放弃 + 补充说明）→ 逐项处理（产物清单点开 textarea 快改/仅重试此项）；读取根与保存根按工单 base 一致（草稿工单读草稿目录）；不做 Web 内编辑器，大改走绝对路径 + 外部编辑 + 重新检查。

### 验证

- 后端 pytest 36 条全绿（新增 retry→handoff 链路、检查阶段归属映射、Windows 盘符 FAIL 正则回归锚、快改绝对路径拒绝等）。
- E2E 48 条两轮幂等：新增 `produce-chain.spec.ts`（向导建科 → 顺序约束 → 产课全绿 → 打开课件）、`course-build.spec.ts`（探索入口 → 确认建课 → 编排 → 落点确认 → 工作区科目）、`inspection-ticket.spec.ts`（工单角标 → 两段式 → 快改 → 放弃收口）。
- 审查轮：两个独立只读代理（后端 / 前端与 E2E）共报 4 枚 P0、17 枚 P1 与一批 P2，全部修复（FAIL 正则盘符截断、检查阶段归属失效、done 卡丢 slug、工单读写根不一致、编排子进程冻结事件循环、image_scout 配额/SSRF/命名截断等）；审查中"归属延伸是否算第二份规则"的边界按"机械延伸同一张表"口径与拍板④一并记入。
- E2E 映射表两行翻转（选方向 / 产课三件套 → 已覆盖），见《E2E 测试流程》第 3 节。

---

## 2026-10-03 · 裁定后实施轮（补接线 / 新会话选工作区 / 补测试 / 统一口径）

维护者对上一轮五个待裁定项的批复与落地：

- **I 触发时机 → 补齐接线**。`MemoryDialog` 加可选 `initialEntries`（预填条目时直接展示、不调 suggest）；`ChatView` 小结结果区在 `summary.memory_updates` 非空时给出「沉淀记忆（N 条建议）」入口（用小结已产出的建议预填，分节默认「跨科目观察」）；`NodeDetail` 的评估结果面板在 `verdict=通过` 时给出「沉淀记忆」入口（从该次评估会话提炼）。加上原有手动入口，写侧共三个触发点，确认与写入仍走同一套 `suggest`/`confirm`。
- **A 的选目录形态 → 不接受原方案，改为"新会话选目录"**。新增 `WorkspaceOnboarding` 组件渲染在 `/chat` 新会话欢迎区下方，**仅当前工作区无科目时出现**：展示当前路径、列出候选（当前 / 插件默认 / env 覆盖，去重；后端 `GET /api/workspace` 新增 `candidates` 字段）供一键切换，支持手输绝对路径（客户端校验 + 422 兜底），成功后刷新科目列表。设置页工作区子页保留为查看/进阶入口。
- **补测试 → 后端 pytest 落地**。新增 `backend/tests/`（`conftest.py` 隔离临时工作区/数据目录/配置 + fixture 后端；`test_workspace.py` / `test_prompts_opening.py` / `test_records_flow.py` / `test_memory.py`，**18 条全绿**），覆盖工作区发现三态与写回回滚、技能注入与缺失 503、开场切片（含 canonical 误解源）、评估联升与掌握度保留/上调、学习记录落盘、摘要同日多段、记忆建议/写入/去重/入参校验。测试依赖独立到 `requirements-dev.txt`（pytest + httpx），AGENTS.md 规则 1 与开发与计划 §2 加入该门禁。
- **统一口径**。`playwright.config.ts` 的 `reuseExistingServer` 由 `!CI` 改为 `false`（与 `explorer.config.ts` 一致——静默复用陈旧端口的后端会让整轮跑在错误世界，本轮踩过）；`chat-shell.spec.ts` 的折叠断言由 `toBeHidden()` 改为宽度判据 + 属性判据，与 E2E 流程 §6 第 15 条一致。
- **验证**：`python -m pytest tests` 18 条、`compileall`、`tsc --noEmit`、`npm run build` 全过；E2E 全量两轮幂等（新增新会话选工作区用例，并扩展小结/评估的记忆入口断言）。

---

## 2026-10-02 ~ 03 · 探索 agent 测试工作流定档（harness v1.0）

### 决策（维护者拍板）

1. **建立"探索 agent"harness**（`frontend/tests/explorer/`）：LLM 驱动真实浏览器，给一个目标从首页一步步点击，直到完成或碰壁退出报告。定位**发现层、非门禁**，完全独立于 CI、只按需触发——它补 E2E 的三类结构盲区（逆向前置状态/请求载荷/多状态组合），详见《E2E测试流程》§2。
2. **允许有限自主恢复**：mechanics 层自由恢复（关弹窗/重试点击/等待），语义借道（换路径达成目标）必须标注 detour 并列偏离点；**第一次撞墙即刻记录**（walls.jsonl），绕开也不丢。
3. **墙壁报告由 AI 初分**四类（真实功能缺陷/设计死路/agent 失误/环境问题），拿不准上交维护者；AI 只去噪初分，修不修由维护者定。

### 实施要点

- 形态=最小四件：goal 清单（`goals/g1–g5.md`，源自反馈清单 adverse + g5 正路基线）/ 单 agent 循环（aria 快照观测 + 约束 JSON 动作）/ 轨迹记录器（steps.jsonl + 每步截图 + walls.jsonl + report.md）/ 系统提示词（`policy.md` 三态出口 + 借道规则）。
- 复用 E2E 的 fixture webServer（8290/3810）与 globalSetup 种子重置；`reuseExistingServer: false`（端口占用即响亮失败，不静默复用它人的服务器）；**世界预检**（侧边栏须见种子科目，/chat 追加 DeepSeek 标签断言）——它把"探索错误世界"变成 20 秒内失败。
- LLM：`step-5-preview`（默认）/ `step-3.7-flash`，OpenAI 兼容端点；两坑已写进代码注释——base 必须拼到 `/step_plan/v1`（直连 `/v1` 402），`max_tokens` 须 32k（推理 token 计入 completion）。
- 安全：key 存 gitignore 的 `.env`，`runs/` 已 gitignore。

### 首轮试跑结论（2026-10-02 晚，5 目标）

- g5 正路 canonical（9 步）；g1 无科目记误解 detour 且墙实证"设计死路"（表单按科目归档的可见提示+禁用保存，即反馈 #5 修复后行为）；g2 已填 key 测连接 canonical（fixture 固定成功，真实外呼由 settings-providers 新用例守护）；g3 模型切换 canonical；g4 暗夜读下拉 canonical 但**结论无效**（aria 快照含闭合 select 全部 option，agent 从未真正打开下拉——渲染结论必须人眼看截图或走 P3 脚本断言）。
- 试跑换来三条 harness 改进：policy"完成即停"、g3 `max_steps` 收紧到 8（短目标强循环倾向，同一目标跑出过 21 步耗尽/16 步踩线/5 步干净）、原生 combobox"页面无变化"误报豁免 + 循环守卫。

### 问题修复（与试跑同轮发现）

- **e2e/explorer path bug**：`playwright.config.ts` 曾用 `path.resolve(__dirname, "../..")` 从 `frontend/` 算到**仓库根**，fixture 后端长期读写 `<root>/data/e2e-*` 陈旧世界，旧绿全是假象；已修为 `".."`，泄漏的根 `data/` 已清除。口径已写入《E2E测试流程》§1「路径口径」。

---

## 2026-10-03 · 探索测试目标库扩展（覆盖生产侧与新功能）

- **背景**：新功能（建课/产课/质检工单、工作区、记忆写侧、附件、模型 schema v3、附件区、评估联升）上线后，探索目标库仍停在 g1–g5（反馈遗留）。本轮按"新功能逐个覆盖"补 g6–g17 共 **12 个目标**，并扩展 harness 以支持它们需要的前置世界与交互方式。
- **新增目标**：g6 建课全链（方向探索 → 确认建课 → 编排 → 落点确认）/ g7 按序产课并打开课件 / g8 越序产课受阻后自行找顺序出路 / g9 质检工单两段式（总览 → 快改 → 放弃）/ g10 工作区相对路径校验 + 切空目录 + 新会话引导切回 / g11 沉淀记忆手动入口 / g12 仅图片附件无文字发送 / g13 模型编辑弹窗模态 + 高级档位 chip / g14 系统提示词改后恢复默认（§6 原零 E2E 覆盖）/ g15 小结后附件区出现会话摘要组 / g16 评估通过置位 + 沉淀记忆入口 / g17 暗夜新弹窗可读性截图取证。
- **harness 扩展**（`frontend/tests/explorer/`）：
  - **`seed:` 前置世界**——goal front matter 声明 `seed: <name>`，运行前把 `seeds/<name>.json` 落到后端数据目录（工单在 fixture 下不会自然产生，g9 靠 `seeds/tickets.json`）。
  - **路径占位符**——`{{FILES_DIR}}` / `{{WORKSPACE_DIR}}` / `{{EMPTY_WS}}` / `{{DATA_DIR}}` 展开为**正斜杠**绝对路径（目标随仓库跟踪，不能写死本机路径；反斜杠会让 LLM 产出非法 JSON）。
  - **`setfiles` 动作**——附件入口是隐藏 `<input type=file>`，📎 会弹 OS 文件框、agent 操作不了，用 `setInputFiles` 模拟选好文件（g12）。
  - **sr-only 点击回落**——课程图谱的节点按钮是 sr-only，真实指针点不到；点击失败时回落 `dispatchEvent("click")` 并在结果里标注，避免把"点不到"误判成产品墙（g7/g8/g16 需要）。
  - 新增 fixtures：`seeds/tickets.json`、`files/sample.png`。
- **文档**：《探索测试指南》§5 目标库表与编写规范、§6 已知边界（新标签页链接、seed 前置、fixture 不可达三类）、§7 补"g6–g17 未试跑"；explorer README 同步速查表与编写小抄。
- **状态**：全部**未试跑**（执行由维护者按需决定）；`npx tsc --noEmit` 通过、goal front matter 解析校验 17/17 通过。建议首次按 g5→g6→g7 正基线、再 g1/g2/g8/g10 adverse、最后 g9（需 seed）的顺序跑。

---

## 2026-10-03 · 真实 LLM 冒烟（三条生产链）+ 模型选型 + 两枚基建修正

对 my-api（本地 new-api 中转）五模型实测选型后，用真实 LLM 把生产侧三条链各跑一遍：
判分 / 评估 / 课件产出。判分与评估一次通过；产出链暴露出两枚基建问题并已修。

### 模型选型（my-api，5 个，全部带 `reasoning_effort=medium`，严格串行不并发）

| 模型 | ping | 派工 envelope | 教学提问 | 产出链实测 | 结论 |
| --- | --- | --- | --- | --- | --- |
| mimo-v2.6-flash | 10.1s | 8.5s ✓ | 21.5s/834字（最好） | 40 分钟/节点（讲解派工纯思考约 10 分钟、694s） | 质量最好但极慢 |
| agnes-3.0-flash | 5.6s | 15.9s ✓ | 30.3s/599字 | 讲解派工 10 分钟、出题派工网关停滞 19 分钟无产出 | 无速度优势，弃 |
| space-bunny-alpha | 7.4s | 4.7s ✓ | 8.7s/321字（薄） | **3 分钟跑完两节点**（lab/ 整棵树交付正确） | 速度答案，合规性弱 |
| muse-spark-1.3-contributor | 9.4s | 11.8s ✓ | 40.8s/535字 | 未测（无突出项） | 备用 |
| u2-flash | 11.2s | 14.4s ✓ | 105.6s/324字 | — | 排除（耗时产出倒挂） |

**速度/质量取舍结论**：产出链（后台编排，有时延不敏感的时刻）用 space-bunny 快 13 倍，代价是合规性弱——两轮检查后仍转工单（mimo 也一样转，只是问题更少）；对话/评估等质量敏感面仍用 mimo。选型与串行约定已入记忆。

### 三链冒烟结果

- **判分**（mimo）：好作答 → 通过（4 条 evidence 逐条对应判分要点）；空泛作答（"我懂了"型）→ 不通过，comment 明确说"口头确认不算证据"，4 条 missing 齐全。判分口径执行准确。
- **评估**（mimo）：107.3s，部分通过、mastery=0.4、`assessments/001-l1.md` 落盘、进度不置位（部分通过不触发权威置位，符合 record-keeping 规则）。
- **课件产出**：全链路机制在真实 LLM 下全部走通——派工交付（讲解+出题，含 `lab/<NNNN>-主题/` 与 `solutions/` 整棵树）→ 渲染失败 → 按归属打回重派 → 检查失败 → 再打回 → 耗尽建工单转人工，工单里归属分布与问题原文正确。

### 修的两枚基建问题（真实冒烟踩出）

1. **本机网关被系统代理经手**（`llm.py`）。httpx 在 Windows 上经 urllib 读**注册表**里的系统代理（`urllib.request.getproxies()` 返回 `http://127.0.0.1:7897`，即 mihomo），连发往 `localhost:4000` 的 LLM 请求也绕代理一跳；mihomo 一抖，长流就断（产出链首次 23 分钟三次 ReadTimeout 的根因之一）。修法：`_loopback_mounts()` 识别本机 base_url 时给客户端挂 `mounts={"all://localhost": None, "all://127.0.0.1": None, "all://[::1]": None}`（None mount = 命中回落默认直连，httpx 自己的 no_proxy 机制；实测 remote 仍走代理、SSL 环境配置不受影响）。SDK 与 4 处裸 httpx 客户端统一走 `_raw_client()`/`build_client()`。
2. **读超时对带思考的长产出不够**（`llm.py`）。`REQUEST_TIMEOUT` 300s → 900s：实测 mimo-medium 单次课件派工纯思考约 10 分钟、全程 694s（网关持续流式吐 `delta.reasoning`，非硬超时，是生成本身就慢）；网关负载下还会出现 >300s 静默，300s 读超时直接误杀。另实测 `mounts={"all://": None}` 不生效（会被 http:// 模式抢先），必须按 host 精确挂。
3. **派工 envelope 契约失败无兜底**（`produce.py`）。真实冒烟中 space-bunny 偶发返回畸形 JSON，此前直接 error 硬停整条链；复派同一请求即合规（偶发）。已按同一"规格是权威"哲学加原值重派（`MAX_RETRIES`=2 次，retry 事件带 `reason`/`problems`），耗尽才 error 停止；前端 retry 提示补显 reason。pytest 补 2 条（38 条全绿）。
4. **报错无诊断信息**（`produce.py`）。"交付里没有课件内容文件"分不清模型漏 files 还是路径写错；三处报错补 `_delivered_digest()`（实际交付路径 + report 头部）。

### 冒烟方法学备忘

- TestClient 的 ASGI 传输**不增量吐 SSE**（整条响应跑完才一次性交付），进程内冒烟看不到阶段进度——看进度要起真 uvicorn；判断在途状态看磁盘产物与 `Get-NetTCPConnection`。
- 冒烟脚本必须自己钉死模型（live settings 会被 UI 随时改掉，本轮被改过两次）。
- E2E fixture 探针只测 `data` 形状会漏 `files[]` 契约——产出链的真实风险在 files。
- **版本号**：0.4.0-beta → **0.5.0-beta**（生产侧 C/D/E/F/J + 冒烟轮为一次功能增量；`frontend/package.json` + `backend/app/main.py` + README「版本」节 + 开发与计划 §1 标题，侧边栏读 package.json 自动跟随；PRD 正文按约定不写版本号）。

---

## 2026-10-04 · 组件测试层落地（P4，选型 vitest + Testing Library）

### 决策

- #12（E2E 组件测试层）选型 **vitest + Testing Library（jsdom）**，弃 `@playwright/experimental-ct-react`。理由：三分支（空 key / 空模型列表 / 无科目 prefill）是状态驱动的 DOM 输出，不需要真渲染；CT 的独有能力（真 CSS 计算、截图回归）与旅程级 E2E 职责重叠，且在 Next.js 仓库要维护一份平行 Vite 配置、React 适配至今 experimental；"下沉"的动机本就是开发期秒级反馈，vitest watch 模式正好。
- 组件层**不进根 `npm test` 门禁**：现行口径 e2e 与 pytest 均为本地跑，根门禁只覆盖上游插件测试与 release 检查；把前端单测塞进根门禁意味着 CI 要装前端依赖，改动面超收益。

### 实施

- 新增 `frontend/vitest.config.ts` + `frontend/tests/component/`（setup / fixtures / 三个用例文件），脚本 `npm run test:component`；playwright 两套配置（tests/e2e、tests/explorer）扫描范围与之互斥，目录与文件名（`*.test.tsx` vs `*.spec.ts`）都分开。
- 13 条用例：ModelSelector（未配置跳转设置页 / 空模型「无模型」占位 / 空 key「未设 API Key」标记）；ProvidersView（Key 回填非掩码 / 清空保存回落已存 key / 填入新 key 翻转 has_key / 测试连接携带真实 key / 空 key 渠道以空 api_key 发出 / Base URL 空本地守卫不发请求）；ChatView（subjectsLoaded 三态：未拉到不出工作区引导块 / 确实无科目出引导块并读工作区 / 有科目不出）。
- E2E 从未观测的「有 key」状态与逆向前置状态（无科目对话）由此获得第一层回归锁；E2E 用例**无需删改**——这些分支旅程级本就不可达，"旅程级只留聚合与落盘"的裁剪目标自然达成。

### 顺手修

- `lib/workspace.tsx` openSession 的 SessionMeta 构造补 `mode` 字段：types 当日新增该必填字段后漏改此消费者，全仓 tsc 挂红（后端 GET 会话本就回传 mode，`storage.py` 回落 "chat"）。
- README E2E 覆盖数 44 → 48（上一轮改了 E2E 流程文档但漏了 README）。


---

## 2026-10-04 · 会话绑定与课程页布局对调轮（维护者拍板：四项 UI）

### 拍板

1. **会话科目绑死**：科目关联一经落定（首条消息）即锁定，换科目 = 开新会话（新会话不再继承上一会话的科目）；**建课会话（interview）不关联已有科目**（归属由盘问收口→草稿→落点确认自带，强行传入由后端拒绝并提示）。**节点可随时在科目内切换**；未指定节点时后端**自动推断聚焦节点**（学习中 → 第一个未开始，对照插件"接着上次学"），推断只作用于注入、不落盘。**右栏节点下拉移除**。
2. **课程页第二列科目列表删除**（与全局侧边栏科目区重复）。
3. **课程页布局对调**：主区 = 科目头部 + 大纲列表 + 选中节点详情卡，**图谱画布收进右侧栏**（RightRail，可折叠/拖宽）——列表为主、图作辅助，对齐插件科目主页的大纲主体形态。
4. **概念本连贯化**：`NodeDetail` 增「本节点误解」区（带参跳概念本）；概念本条目节点徽标 → 图谱页定位（`?node=` 预选）；概念本筛选支持 `?subject`/`?node` 预填。数据层零改动（条目本就带 node 字段）。

### 实施

- 后端 `routers/chat.py`：绑定语义（锁定后忽略换绑/解绑；interview 拒绝 + notice；旧规则"显式科目强制 chat"由绑定语义接管，修复其把 interview 静默掰成 chat 的陷阱）、`_infer_focus_node()`；`storage.list_sessions` meta 补 `mode`。pytest 新增 `tests/test_binding_focus.py` 4 条（锁定/节点可换/interview 拒绝/推断三态）。
- 前端：`RightSidebar`（科目下拉锁定态 + 提示、节点下拉移除）、`ChatView`（新会话清空科目/节点关联、建课发送省略 subject/node 键）、`streamChat` 支持 subject/node 键整体省略（undefined 不随请求发送）、`CourseGraphView` 重写（主区大纲列表 + 详情卡 + 头部导出，图进 RightRail，`?node=` 一次性预选）、`NodeDetail` 增 `NodeMisconceptions` 区、`MisconceptionsView`（`?node=` 预填、节点徽标改 Link 定位图谱）。
- E2E 同步：`helpers.associateSubjectNode` → `associateSubject`（节点参数删除，7 个 spec 调用点更新）；`chat-course-context` 重写（绑定锁 + 新会话不继承 + 数据层 node 为 null）；`subject-switch` 去第二列路径；`courses.spec` 第二条重写（图谱右栏折叠宽度判据 + 大纲主区选节点）；`misconceptions.spec` 追加"定位节点 + 带参预填"用例；`chat-shell` 断言改"节点下拉 count 0"。

### 验证

- 后端 `compileall` + pytest **42 条全绿**；`tsc --noEmit` 除 ProvidersView（见下）零错误。
- E2E：除 settings 域 6 条（ProvidersView 既有破损所致，见下）外 **43 条全绿**（含本轮重写的 chat-course-context / subject-switch / courses / misconceptions 定位用例）。全量连跑时 memory-flow / session-summary / sidebar-resize / subject-switch 出现过轮间不一致的间歇失败，隔离复跑全部通过——判定为同机并发会话抢占 8290/3810 的干扰，非本轮改动；「两轮幂等」口径待 ProvidersView 裁定后复验。

### 发现（非本轮产物，未动，待维护者裁定）

- **`ProvidersView.tsx` 半成品改造**：工作树里存在一份未完成的"实时生效/防抖落盘"重构——已删除 `dirty/saving/testResult` 等状态并加 ref/防抖基建，但约 400 行旧引用未改完，`tsc` 报 18 错、`npm run build` 会失败。同日早前的组件测试轮（vitest 不做类型检查）在其上仍可通过，掩盖了类型破损。本轮裁定范围不含它，按原样保留：**要么补完防抖重构，要么回滚该文件**，二选一后 `tsc`/`build` 门禁才可恢复。

---

## 2026-10-04 · 工具化调用改造（K 系列）拍板

维护者推翻 2026-10-03"生产侧八项拍板"的**拍板①（子代理 = 无工具单次调用）**，重建工具化 agent loop，对齐插件基线（dsh）的工具齐全 harness 形态。理由：当今模型工具调用训练充分；单次大派工（整份大纲/整棵课件赌一次输出）在真实开课与测试中表现不佳。同日派两个只读调查代理完成 DSH（`D:\deepseek-harness`，即插件运行时本体）与 DeepTutor（仓库内克隆）的尽调，结论吸收进设计：

### 尽调要点（事实侧）

- **线协议就是标准 OpenAI function calling**：`{name, description, parameters(JSON Schema)}` + `tool_calls{arguments 原始 JSON 字符串}` + `role:tool` 按 `tool_call_id` 回传，流式增量按 index 聚合（id/name "赋值不追加"、arguments 拼接）；两家都不发明自定义 wire 格式（DSH 的私有线扩展刻意避开工具与消息体）。
- **Skills 是"检索式注入"不是全文拼接**（DSH）：目录消息常驻（name + 截断到 ≤500 字的 description，摘要变化整条替换），正文只在 `skill(name)` 工具调用时重读盘取全文，`always: true` 才整文注入。
- **文件边界**（DSH）：相对路径以 session cwd 为基准 + 可写根 allow-list + **写前当场重新 canonicalize**（消 TOCTOU），拒绝返回稳定的模型可读标记；加宽只有"模型请求 → 人审批 → 仅此一次"一条通道，fail-closed。
- **循环形态**：通用判据是"某轮不再发起 tool_calls 即终止"；预算分层（DeepTutor：探索 8 轮 + 收尾 3 轮 + 强制无工具收尾 1 次；DSH：无步数上限，改用 maxTokens + 每工具超时 + 重复调用提醒式防打转）；工具失败一律转成 `role:tool` 错误文本让模型自愈，不炸循环。
- **审计 = 事件流落盘**（DeepTutor）：同一份事件序列既推前端又持久化（seq 单调、断线重放与事后审计共用一条路径），敏感参数在工具声明处脱敏。
- **子代理 = 一个返回结构化结果的工具**（prompt 进、最后一条 assistant 消息出，非 completed 即 isError 但保留部分输出）；后台/可续子代理是二期复杂度。

### K 系列排序（设计侧，实施未开始）

- **K0 基建**：`llm.py` 三格式 tools 映射（含流式 tool_call 增量聚合）+ agent loop runner（轮次/Token/时间预算，失控降级）+ SSE `tool_call`/`tool_result` 事件与前端工具卡（兼审计 UI）+ **审计落盘**（派工值/原始回复/工具调用追加写 `data/audit/`，失败不清除——顺带修掉 10-03 核实过的"堵点无文件证据"缺口）+ `capabilities.tool_calling` 接线（backlog #14；未声明能力的模型回落现有纯注入路径）。
- **K1 chat 链路只读工具化**（`read_course_file` / `list_workspace` / `read_skill`，边界限工作区 `.learning` + 仓库 `.dsh/skills`）。
- **K2 建课链**：大纲角色改工具循环（读参考 → 写大纲 → `run_gate` 自查 → 按报错自修），消解"单次赌全局"与 envelope 畸形硬停。
- **K3 产课链**：角色 envelope 交付改为写工具调用；打回改为循环内带报错证据自修；`render_and_check` 收口与工单兜底保留。
- **K4 总控全 agent 化**：远期可选，K2/K3 完成后按效果决定。
- **不变量**：SKILL.md 全文注入保留（另加 `read_skill` 按需补充）；上游脚本零重写；**门禁仍由后端在写盘后强制执行**（不信任模型自查）；质检工单只做循环耗尽后的人工兜底；采图保持纯后端爬虫不进角色体系。
- K 系列实施时按上述尽调清单内化细节；本轮为决策留痕，代码未动。

---

## 2026-10-04 · K 系列实施（K0–K3 落地）

按同日「工具化调用改造（K 系列）拍板」实施 K0–K3（K4 仍远期观望），代码与测试全量落地，停在待提交状态等维护者过目。

### K0 基建

- `llm.py`：三格式（openai_chat / openai_responses / anthropic）tools 映射 + 流式 tool_call 增量聚合（`ToolCallAccumulator`：id/name 赋值不追加、arguments 拼接、`arguments_full` 权威覆盖）；新增 `stream_turn` 逐轮吐"文本增量 / tool_calls"，tools 参数被上游 400 拒绝时回落一次不带 tools 的调用；`supports_tools()` 读 `capabilities.tool_call`。
- `agent.py`：agent loop runner。预算分层（探索 8 轮 + 收尾 3 轮 + 强制无工具收尾 1 轮；"只思考不行动"救 2 次）；连续相同调用在 3/5/8 次发提醒；工具失败转 `role:tool` 错误文本不炸循环；传输失败未可见则重试、已可见则降级收尾；耗尽标记 `degraded`。
- `tools.py`：工具注册表 + 沙箱边界。相对路径以工作区/科目目录为基准、写前当场 canonicalize 校验包含关系（消 TOCTOU）、拒绝返回稳定标记 `[sandbox: file access denied under <mode> mode]`；read 上限 2 万字符 + 翻页；工具执行不抛异常。
- `audit.py`：`data/audit/<key>.jsonl` 追加式审计（contextvar 绑定编排键，随 asyncio 任务继承）。派工值 / 模型原始回复 / 每次工具调用与结果都落盘，**失败不清除**——修掉 10-03 核实过的"堵点无文件证据"缺口（`.stage` 无论成败被 `clear_stage` 删、派工值与原始回复过去不落盘）。敏感键在落盘前统一脱敏。
- SSE：chat 加 `tool_call` / `tool_result` 事件（队列驱动，断连不丢关键消息）；前端新增可展开工具卡（`tool-card` / `tool-name` / `tool-result`），兼作审计 UI（仅流式期间呈现，不落会话历史；持久审计在 jsonl）。
- `capabilities.tool_call` 接线（backlog #14）：`config.get_active_provider()` 透出 `capabilities`；设置页能力声明里的该项由"仅展示"改为生效（标签改「工具调用（Agent 循环）」）；**未声明能力的模型回落现有纯注入路径**。
- fixture：`FIXTURE_TOOL_SCRIPTS` 提供 canned tool_calls 序列（scenario `tools`），E2E 经路由拦截改写请求体触发。
- **K2 硬停 bug 修复**：`build._dispatch_curriculum` 过去 envelope 畸形一次即硬停；现与产课链同规——原值重派 `MAX_RETRIES` 次，耗尽才转 error。

### K1 chat 只读工具化

- 工具：`list_workspace` / `read_course_file` / `read_skill`（读根 = 已绑定科目的目录，未绑定则工作区 subjects 目录；`read_skill` 读仓库 `.dsh/skills`）。
- 启用条件：`fixture_scenario == "tools"` 或模型声明 `capabilities.tool_call`；否则走原 `stream_chat` 纯注入路径。建课会话（interview）同样适用。

### K2 建课链

- 大纲角色改工具循环：`list_workspace` / `read_course_file` / `submit_curriculum`。`submit_curriculum` 立即跑门禁（schema + 上游 `check_curriculum.py`）并把报错原文回喂，模型循环内自修；**后端在循环之后仍强制再跑一次门禁**（不变量：不信任模型自查）。未交回（循环耗尽）回落既有单次派工链，打回/工单保留。

### K3 产课链

- 角色交付改 `write_deliver_file`（写 `.stage/<角色>/deliver/`，同步记入交付清单）+ `run_check`（落盘后跑 `render_lesson.py` + `check_lesson.py`，报错原文回喂循环内自修）。循环结束交回的 files 合成 envelope 等价体，走既有 `_write_and_promote` → `render_and_check` → 打回 → 工单兜底；`render_and_check` 收口与工单兜底保留。

### 验证

- 后端 `compileall` 通过；pytest **64 条**全绿（新增 `tests/test_tooling.py` 22 条）。
- 前端 `tsc --noEmit` 零错误、`npm run build` 通过；`settings-models` 用例随能力标签更名同步。
- E2E **53 条全绿**（新增 `tool-cards.spec.ts`）。

---

## 2026-10-04 · 工具调用改为默认开启 + 真实冒烟

维护者定档：**工具调用不再是可选支持项，默认所有配置的模型都支持**；并要求补上冒烟。同日实施。

### 默认开启

- `llm.supports_tools()` 改为对任何 provider 字典恒 True（不再读 `capabilities.tool_call`）；chat 分支条件改为 `fixture 工具场景 或 真实 provider`；建课链 / 产课链去掉能力声明门控，真实模型一律走工具循环。
- **回落兜底宽化**：`stream_turn` 里凡"带 tools 的首轮调用未吐任何内容即报错"，一律自动回落一次不带 tools 的纯文本调用（不再按错误文本筛选——各家网关的拒绝措辞不一），保证工具声明本身不会打挂整个请求。`_looks_like_tool_rejection` 随之删除。
- 前端：模型编辑弹窗的「工具调用」开关移除（高级区改为只读提示"默认开启"），落盘恒为 `tool_call: true`；`capabilities` 里其余两项（JSON Schema 输出 / 原生联网搜索）仍为展示声明。`settings-models` 用例改用「JSON Schema 输出」验证开关可切换；探索目标 g13 同步。
- `capabilities.tool_call` 字段保留在数据模型里（向后兼容旧 settings.json），但不再参与任何请求决策。

### 真实冒烟

- 新增 `backend/tests/test_smoke_real_llm.py`：`SMOKE_REAL_LLM=1` 门控（默认跳过，附 skip 原因），对开发 settings 里带 key 的活跃提供商**真连一次**工具循环（tools 声明 → 流式 tool_call 聚合 → 工具执行 → 结果回喂 → 最终答复），断言产出文本、至少一次工具调用、工具结果事件、未降级。方法沿用 2026-10-03 冒烟口径（串行、脚本自己钉死模型，`SMOKE_MODEL` 可覆盖、`SMOKE_SETTINGS` 可换路径）。
- 实测（本机 my-api 中转，串行）：**space-bunny-alpha** 2 轮 2 次工具调用、9.2s；**Deepseek-v4-flash**（活跃默认）3 轮 2 次工具调用、10.3s；两者都据工具结果给出了引用真实文件内容的答复。至此 K 系列工具链有真实渠道背书。

### 验证

- 后端 pytest **64 条 + 1 skip**（冒烟默认跳过）；`tsc --noEmit` 零错误、`npm run build` 通过；E2E **53 条两轮全绿**。

---

## 2026-10-04 · 第二轮 UI 杂项（会话级工作区甲 / 新对话关联行 / 档位下拉 / 课程页再对调）

维护者逐条拍板的五项 UI 改动 + 三处连带决定（明暗按钮位置、"科目状态放哪"选 A、小结与沉淀记忆入口悬空）。按工作量拆给三个子代理（后端工作区 / 课程页 / 对话框档位）并行，主代理做侧边栏与聊天壳并统一跑门禁。

### 会话级工作区（拍板"甲"：会话各自绑定，不做全局切换）

- 新增 `backend/app/workspace_ctx.py`：`ContextVar[Path|None]` + `resolve()`（无绑定回落 `workspace.discover()[0]`）+ 可重入 `bind(path)` + `validate_dir()`。
- **唯一收口点**：`curriculum_store.workspace_dir()` 改读 `workspace_ctx.resolve()`——`subjects_dir()/subject_dir()` 都建在它上面，memory / records / tickets / misconceptions / export / generate / lessons 全部自动跟随，**不需要逐个下游加参数**。
- `storage.py`：会话新增 `workspace` 字段（`.get()` 兜底旧文件）；`list_sessions()` meta 带出；新增 `session_workspace(id)` 助手。
- 会话相关端点绑定该会话的工作区：`chat/stream`（已有会话沿用存储值、新建会话先校验请求里的 workspace）、会话小结、带 session_id 的 assess、`/api/memory/suggest` 与 `/api/memory/confirm`（confirm 新增可选 `session_id`）。SSE 生成器在迭代期各自重挂绑定（StreamingResponse 在别的任务里迭代）。
- 科目类 GET 增可选 `?workspace=<绝对路径>`：`/api/courses`、`/api/courses/{slug}`、`/api/courses/{slug}/attachments-area`、`/api/courses/{slug}/files/{path}`（附件区与 files 实际定义在 `routers/lessons.py`，共享 `courses.py` 的 `bound_workspace()`）；`GET /api/workspace` 增可选 `?path=`（只读预览，不碰全局配置）。无参行为一律不变。
- `PATCH /api/sessions/{id}`：`RenameSessionRequest` → `SessionPatchRequest`，`title` 与 `workspace` 均可选（`workspace: null` 显式清空；靠 `model_fields_set` 区分"没传"与"显式 null"），只传 title 的旧行为不变。
- **约束**：带 `workspace` 的绑定点（建会话 / PATCH / 各 query）要求目录已存在，否则 422——"先指向一个还不存在的空目录再冷启动"当前不支持（放宽只需去掉存在性校验）。

### 前端：新对话关联行 + 课程页头部科目状态

- `ChatView` 新增「新对话关联行」（`data-testid="new-session-association"`）：输入框**上方、左对齐**，「科目 + 工作区」两个 select 并排；**只在新对话态（`sessionId === null`）渲染**，发出第一条消息成为正式会话即隐藏；工作区空选项 = 默认工作区，切换后按该工作区重载科目列表并重置科目关联。
- `RightSidebar`：**「会话关联」整段移除**（科目下拉 / 生成小结 / 沉淀记忆），右栏只剩**附件区**（改为按会话工作区读取）与**会话信息**。`WorkspaceOnboarding`（欢迎区选工作区引导块）的使用点一并移除——两个组件文件保留但暂时无引用。
- **小结与沉淀记忆入口悬空**：`生成小结`、`沉淀记忆`（含小结结果区的「N 条建议」入口与 `MemoryDialog` 接线）从 UI 移除；后端端点与 `MemoryDialog.tsx` 保留，`memory-flow.spec.ts`（2 条）与 `session-summary.spec.ts`（1 条）改 `test.skip(true, …)` 挂起并注明恢复办法。
- 课程页头部加**科目总览（方案 A）**：显示「进度 n/total · 平均掌握度 x%」+ **状态下拉**（进行中/暂停/已完成，`data-testid="subject-status"`），就地改走后端既有 `PATCH /api/courses/{slug}`（含枚举校验）；左侧边栏的科目行**去掉状态绿点**，改表达"当前在看的科目"（`aria-current="page"`，与课程页发布的 `currentSubjectSlug` 联动，只在 `/courses` 生效）。
- 左侧边栏：**明暗切换移到「设置」右侧**（同一行）；导航选中态唯一化——「新对话」只在真的没有活动会话时高亮，看历史会话时选中交给会话行，消除"同时发亮"。
- 会话级工作区在前端的承接：`lib/workspace.tsx` 增 `activeWorkspace` / `setActiveWorkspace` / `workspaceCandidates` / `currentSubjectSlug`，`refreshSubjects` 改为按当前工作区拉取；`lib/api.ts` 增 `?workspace=` 与 `?path=` 参数、`setSessionWorkspace`、`streamChat` 的 `workspace`；`SessionMeta`/`Session` 增 `workspace`。

### 对话框推理档位下拉

- `Composer` 新增自绘下拉（`data-testid="reasoning-variant-selector"` / 菜单 `reasoning-variant-menu`）：放在模型选择器右侧、同一个向上展开的包裹层；当前模型没有档位时整体隐藏；选择即写回 `active.reasoning_variant`。
- `ModelSelector`：**弹层底部的档位 chip 与 `setVariant` 删除**（消除"档位有两个入口"）；导出 `modelVariant` / `modelVariants` / 新增 `activeModelOf` 供 Composer 复用。

### 课程页：大纲与图谱都进右栏（再对调）

- 右栏顶部加「图谱（默认）/ 大纲」分段切换（`rail-view-graph` / `rail-view-outline`），两个面板**都常驻挂载**、用 `hidden` 切换（画布不销毁重建），切回图谱时 `cy.resize()+cy.fit()`；主区只剩节点详情。
- `wheelSensitivity` **0.2 → 0.6**（提为 `WHEEL_SENSITIVITY` 常量；cytoscape 默认 1 偏猛，自定义时会打一条 console warn 属预期）。
- 画布**右下角加「重置视口」**：用 `cy.animate({ fit: { eles, padding } }, { duration: 200 })`——`cy.fit()` 的签名不接受 duration。

### 顺带修掉一枚真 bug（图谱可能整体不渲染）

`setCourse` 与 `setLoading(false)` 分属两次提交，而 `/courses` 在 `subjectsReady` 之前走 early-return 渲染 loader；当 `getCourse` **先于** `refreshSubjects` 返回时，`elements` 已非空的那次提交里画布容器还没挂载，而初始化 effect 依赖的是 `useRef.current`，容器后挂载不会触发重跑 ⇒ cytoscape 永远建不出来（表现：容器在、0 个 canvas、控制台无报错）。改法：画布容器改**state 承载**（`ref={setGraphContainer}`，effect 依赖 `[graphContainer, elements]`）。用一次性探针实测确认（此前 `run container=false ents=11`，修复后 3 层 canvas 正常生成）。

### 验证

- 后端 pytest **75 条 + 1 skip**（新增 `tests/test_session_workspace.py` 11 条：读回 / PATCH 三姿势 / 双工作区双会话互不串 / attachments-area 落点 / chat_stream 绑定 / 非法路径 422 / contextvar 不跨请求泄漏）；`tsc --noEmit` 零错误。
- E2E **53 条通过 + 3 条 skip（悬空占位，0 失败）**：新增 `new-session-association.spec.ts`（工作区绑定写进会话元数据）；`courses.spec.ts` 补两条（科目总览状态可就地改 / 侧边栏科目选中态）；`workspace-onboarding.spec.ts` 改写为"关联行反映当前工作区"；`theme-visual-inspection` 与 `helpers.openNodeDetail` 随"大纲进右栏"同步（先切「大纲」段再点节点行）。

---

## 2026-10-04 · 启动器重建（陈旧构建自动重建 / 一键停止 / 关窗语义）

起因：维护者反馈"重启前后端后打开 Web 界面毫无改动迹象"。

### 症状与根因（构建产物 ≠ 源码）

- 3800 上跑的是 `next start`（生产模式），它读的是 `frontend/.next/BUILD_ID` 指向的**构建期快照**；该快照是当天 08:44 的，而本轮源码改动在 11:31–11:35——产物里 grep 本轮标志串（`new-session-association` 等）命中 **0**。
- 原 `start-web.bat`：只要 `.next\BUILD_ID` 存在就 `MODE=prod` 走 `next start`，**从不重新编译**。所以"关掉窗口再双击启动"只是换个进程继续伺服同一份旧产物。
- 处置：`npm run build` 后用 HTTP 取 chunk 验证（`status=200`、标志串命中）确认新产物上线。

### 关窗与残留：对照实验（A–F）

用 `WM_CLOSE` 关控制台窗口（等同点 X）与 `taskkill /F` 杀 wrapper 各测三种启动形式（`cmd /c npx next start`、`cmd /c node …next start`、`cmd /k npx next start`）：

- **点 X 关窗**：三种形式都**整棵树一起死**（含 npx 中间那两层），端口释放。
- **进程级强杀 wrapper**（任务管理器"结束任务"、外部 kill）：三种形式**都会留下孤儿**继续占端口（node 变成无控制台的进程）。

推论：维护者看到的"关闭窗口后服务还在"不是点 X 造成的，而是①关掉的是**启动器自己的窗口**——服务是 `start` 分离到各自窗口的，本就不随它退出；或②过程中有过强杀留下的孤儿。孤儿的真实危害是**占住端口**：新实例绑不上、浏览器继续被旧实例服务，会和"看不到改动"叠加成同一个症状。实验中还顺手清掉一个"子进程已死"的空 uvicorn 窗口（重复启动的残骸，端口预检现已从源头避免重复启动）。

### `start-web.bat` 重写

- 模式与参数：默认启动 / `dev` 强制开发（跳过构建）/ `restart` 先停再启 / `stop` / `help`。
- **陈旧自动重建**：`tools/studymate-web.ps1 -Action state` 比对前端源码最新 mtime 与 `.next\BUILD_ID`（排除 `node_modules`/`.next`/`tests`），源码更新过就自动 `npm run build`；无构建则回落 dev。
- **端口预检**：8101 / 3800 已被占用即取消启动，报出占用 PID 与停止办法，避免新旧实例重叠。
- **成功即自动关窗**（原末尾 `pause` 改为就绪后自动退出）；超时与错误路径仍 `pause`，保留报错可读。
- **前端不再经 npx**：改为 `cmd /k "node node_modules\next\dist\bin\next start -p 3800"`，进程树由三层降到两层，便于识别与收尾。
- 端口可用 `SM_WEB_BACKEND_PORT` / `SM_WEB_FRONTEND_PORT` 覆盖（也让启动器可被自动化实测）。

### `stop-web.bat`（新增，双击即用）

按端口找监听进程 → 用**进程表快照**向上爬到服务窗口（只认命令行里含 `uvicorn|next|npm|npx|study-mate-web` 的 cmd/node，遇到用户自己的终端即停手）→ `taskkill /F /T` 连窗口带子孙一起收；若仍占用则直接重试杀监听进程本身。`start-web.bat stop` 等价。

### 踩坑

- **PowerShell 参数里的逗号列表会被它自己吃掉**：`-Ports 8101,3800` 变成单个数 `81013800`（实测直接调用亦然，不是 cmd 的锅）⇒ 端口改为两个独立整型参数 `-BackendPort` / `-FrontendPort`。
- 爬链原先逐级 `Get-CimInstance` 查询，WMI 偶发返回空会中断爬链、把服务窗口留下 ⇒ 改为一次取全表、在内存里走链（顺带更快）。
- `start` 出去的服务继承启动器的 stdout 句柄：把启动器输出重定向到文件时该文件会被服务占住，直到服务停止（只影响重定向场景，双击正常）。
- 环境噪声：本机 VS 的 `LIB` 路径失效会让 PowerShell `Add-Type` 直接失败（清空 `LIB/INCLUDE/LIBPATH` 即可），写探针脚本时踩到。

### 验证

- 助手三动作实测：`state`（FRESH / STALE 双向）、`stop`（空端口 `NOTRUNNING`；三层 npx 树 `STOPPING listener=… window=…` → `STOPPED`，服务窗口一并消失）。
- 正式端口端到端跑 `start-web.bat restart`：停掉旧前后端 → 检出 STALE（点名 `CourseGraphView.tsx`）→ 自动构建（新 BUILD_ID）→ 启动 → 等就绪 → 开浏览器 → **窗口自动关闭、退出码 0**；随后 `/chat` HTML 带当前 BUILD_ID、13:12 那次改动的 chunk 可正常取到。
- 编码验收：GBK + CRLF、无 BOM，中文经 GBK 回读正确。
- 附带修正：`CourseGraphView.tsx` 的 `WHEEL_SENSITIVITY` 注释与取值不一致（注释写 0.6、代码是 1），按"取最灵敏档"改注（该取值由上一条目的 0.6 于本轮被外部改动为 1）；README 启动段重写，并修掉 `start-studymate.bat` 这个从未存在过的错名。
