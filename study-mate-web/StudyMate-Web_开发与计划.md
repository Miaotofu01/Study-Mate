# StudyMate Web 开发与计划

> 版本：v1.0（2026-10-02，由《需求与规划文档》重定位而来）
> 定位：**已有实现的开发文档 + 待实现的计划文档**。描述系统当前架构、关键机制与不变约束、领域模型、与上游仓库的关系，以及后续计划。
> 文档分工：功能规格与实施状态 → [StudyMate-Web_PRD.md](StudyMate-Web_PRD.md)；
> 测试流程与用例映射 → [StudyMate-Web_E2E测试流程.md](StudyMate-Web_E2E测试流程.md)；
> 旧计划与变更史（只追加）→ [Web_CHANGE.md](Web_CHANGE.md)；
> 启动、配置、附件、E2E 运行、版本语义 → [README.md](README.md)。
> 维护约定：功能落地或变更时同步 PRD；计划项完成/新增/放弃时更新本文第 5 节；里程碑与重要决策追加进 Web_CHANGE。

---

## 1. 架构现状（0.4.0-beta）

```
浏览器 ──► Next.js 16 前端（同源）
              │  /api/* 由 Next.js rewrites 代理
              ▼
           FastAPI 后端 ──► LLM（三种 API 格式适配层）
              │               ├─ openai_chat   {base}/chat/completions
              │               ├─ openai_responses {base}/responses
              │               └─ anthropic     {base}/v1/messages
           study-mate-web/data/  文件存储（settings v2、sessions、workspace、uploads、exports）
```

### 1.1 后端模块（backend/app/）

| 模块 | 职责 |
|---|---|
| `main.py` | 入口：lifespan（种子工作区、pending 上传清扫）、路由注册、版本常量 |
| `config.py` | settings v2 读写：`providers[]`（preset/custom + models[] + api_format）+ `active` + `system_prompt`；旧单 provider 自动迁移；`get_active_provider()`（`LLM_*` 环境变量运行时覆盖）；`STUDYMATE_WORKSPACE` / `STUDYMATE_DATA_DIR` |
| `llm.py` | 统一适配层：内部 openai 风格 content parts，按 api_format 三段分派（构造/流式解析/非流式解析）；`chat_once(fixture_kind=…)`；E2E fixture 门（`STUDYMATE_E2E_FIXTURE=1`） |
| `multimodal.py` | 视觉能力前缀表 + 覆盖判定；Stage-1 注入/占位；Stage-2 错误标记匹配剔除重试一次 |
| `doc_extract.py` | 附件"字节进文本出"：pdf(pymupdf→pypdf)/docx/xlsx/pptx/epub/文本类多编码；预算 20000/60000 字符 |
| `curriculum_store.py` | 课程仓储（workspace yaml 读写校验）+ **掌握度状态机 TRANSITIONS（唯一实现）** + 新词表常量（IMPORTANCES/LAB_STATUSES/VERDICTS） |
| `misconceptions.py` | 概念本双落点（misconceptions.yaml 为 canonical 源，旧条目补 id 幂等回写） |
| `records.py` | 评估/小结 front matter 解析渲染 + jsonschema 校验（读仓库 `schemas/`） |
| `storage.py` | 文件型会话存储（消息可带 attachments 元数据；删会话连带删其上传目录） |
| `routers/` | chat（SSE：session/delta/notice/done/error + 课程上下文 + 附件）、courses、uploads、settings（v2 + test）、lessons（列表/files/共享 assets/quiz）、misconceptions、practice（grade）、records（assess/summary/records）、export（子进程 gen_home.py）、generate（子进程 check_curriculum.py 当门） |

### 1.2 前端结构（frontend/）

- 路由：`/chat`、`/courses`、`/misconceptions`、`/lesson`、`/generate`、`/settings`（重定向）→ `/settings/providers`、`/settings/system-prompt`、`/settings/about`。
- 关键组件：`ChatView`（两态：欢迎区+起点 chips ↔ 消息流+落底，650ms 弹性过渡；用户气泡靠右、品牌色）、`Composer`（📎 统一附件入口 + 拖拽/粘贴 + 输入框内模型选择器）、`RightRail`（可折叠/可拖拽的右侧边栏外壳，聊天页与课程图谱页共用，折叠带宽度过渡且内容不卸载）+ `lib/useResizable`、`ModelSelector`（提供商/模型 + 推理档位切换，写回 active）、`settings/ProvidersView`（主从布局 + 启用开关 + 只读模型行四操作）、`settings/ModelEditDialog`（基础区 + 高级折叠区；模态复选框组 / 最大输出 Token / 推理档位 chip 编辑器）、`settings/SystemPromptView`、`settings/AboutView`、`LessonView` + `GradingPanel`（课件 iframe + 开放题判分）、`MisconceptionsView`、`CourseGraphView`（cytoscape + 导出按钮 + 节点详情进 `RightRail`）、`NodeDetail`（进度/lab 状态/申请评估/记入概念本/打开课件）、`Sidebar`（导航 + 会话/科目 + 底栏主题切换与设置，可拖拽调宽）。
- 样式体系：Tailwind + CSS 变量（亮/暗两套，`data-theme` 由 layout 内联脚本首帧前写入，localStorage 优先否则跟随系统）；品牌色走 `--brand-rgb` 变量（支持透明度修饰）；TS 严格模式，除 page/layout 外具名导出。
- 测试：Playwright（`tests/e2e/`，旅程级用例，映射表见 E2E 测试流程文档）。

### 1.3 对外契约要点

- **SSE 事件**：`session` / `delta` / `notice`（非致命提示，不进历史）/ `done` / `error`。
- **settings v2**：`providers[].api_format ∈ {openai_chat, openai_responses, anthropic}`；`models[].vision ∈ {auto, on, off}`；`active = {provider_id, model}`；API Key 掩码回传（`********` 表示不修改）。
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
| 3 | 真实模型端到端验证 | 本机无 Key 遗留：三格式真实流式、判分/评估/摘要/生成质量；Key 可用后加 `SMOKE_REAL_LLM=1` 门控冒烟 project | 各阶段遗留 |
| 4 | 视频/音频附件实发 | 现一律占位；按三协议能力评估后放开 | PRD §3.2 裁剪 |
| 5 | 文档内嵌图片提取 + OCR | 对照 DeepTutor document_images 的标记机制 | PRD §4.5 裁剪 |
| 6 | lab 任务内容（不做代码沙箱执行） | 只留 lab_status 接口（待生成/待提交/待评估/已通过）；沙箱执行明确不做（2026-10-02 维护者） | 阶段 3 方案延后 |
| 7 | 跨科目共享记忆（MEMORY.md）读写 | 现读写皆无；grill 第一轮已定复现方向（2026-10-02） | grill 决策 |
| 8 | 会话存储 SQLite 迁移 | 文件型会话量大后的演进 | 阶段 1 已知限制 |
| 9 | 检索能力（resource-scout 等价物） | 现靠用户粘贴/上传落盘 | 妥协清单二档 |
| 10 | 真实 Key 下的思考档位验证 | 三协议思考参数映射只在无 Key 环境下验了 422/502 路径；Key 可用后并入 #3 冒烟 | 反馈清单轮遗留 |
| 11 | E2E 渲染矩阵（P3） | `colorScheme` 矩阵 + 关键雷区定向 `toHaveCSS`；暗色 `<select>` option 现靠 CSS 规则修，无断言兜底 | E2E 流程 §2.3 |
| 12 | E2E 组件测试层（P4） | 分支逻辑（空 key / 空模型列表 / 无科目 prefill）下沉组件测试，旅程级只留聚合与落盘 | E2E 流程 §2.3 |
| 13 | 干掉 `vision` 字符串垫片 | `get_active_provider()` 目前由 modalities 派生 `vision` 三态字符串喂给 `chat.py`（该文件不在改单内）；应改为直传 `modalities` 并删垫片 | v3 迁移遗留 |
| 14 | 能力声明接线 | `capabilities`（工具调用 / JSON Schema 输出 / 原生联网搜索）现仅落盘与展示，未参与请求；如需真用要逐个接 | v3 迁移遗留 |

> 2026-10-02 提供商/模型域 v2 轮：提供商页 zcode 形态重建与模型级思考档位（F2/F8）、测试连接回落已存 Key（F1）、对话壳层与右侧边栏（F6/F9）、按会话草稿缓存（F10）、logo 图标（F3）、暗色下拉（F4）、概念本科目必填（F5）、侧边栏拖拽调宽（F7）；同轮修掉 `playwright.config.ts` 与 `tests/e2e/constants.ts` 两处 E2E 路径口径 bug。
>
> 2026-10-02 提供商/模型域 v3 轮（对照 ZCode 真实实现）：模型 schema 升到 v3（输入模态复选框组 / 最大输出 Token / 上下文窗口 / 推理档位有序 chip 编辑器 / 能力声明），API Key 改为**回填输入框**不再掩码吞掉；右侧边栏抽成 `RightRail` 共享外壳并支持拖拽 + 折叠动画，课程图谱页节点详情改由它承载。版本号按维护者要求加 `-beta` 后缀（0.4.0-beta）。

### 5.1 全功能复现实施队列（2026-10-02 维护者拍板，未实施）

目标：Web 复现乃至拓展 dsh 插件全功能，"只消费已有产物"旧边界作废。以下计划项**尚未动一行代码**，留痕见 Web_CHANGE 同日条目；实施完成后移入 Web_CHANGE。

顺序按依赖排：工作区是根（一切读写的前提），提示词是各链路的公共输入，产课链与验证集可并行。

| 阶段 | 计划项 | 拍板内容（要点） | 依赖 |
|---|---|---|---|
| A | **工作区与发现（根）** | Web 工作区改 `<WS>/.learning/subjects` 同构布局；发现复用 `scripts/gen_home.py::learn_workspace()`（**不重写**，硬规矩 3）：显式参数 > `STUDYMATE_WORKSPACE` > `LEARN_WORKSPACE` > `STUDYMATE_CONFIG`/`$DSH_HOME/studymate-config.yaml`；启动向导允许选目录；默认沿用插件默认 `~/StudyMate`（不新造 `~/.studymate`）。改点：`curriculum_store.workspace_dir()` 是唯一入口；`seed/` 种入逻辑要重议（不再往插件在用工作区塞示例） | 无 |
| B | **提示词分层** | 默认 = persona 前缀（取 `preset/learning/agent.cordis.yml` 的主教练口径，设置页仍可改）+ 各链路按需读 `.dsh/skills/<名>/SKILL.md` 全文注入：备课产课→`lesson-design`+`layered-practice`，答疑→`local-qa`，档案→`record-keeping`，评估→`practice-evaluator`+`evidence-check`，盘问→`learning-system`，探索→`learning-discovery`。新增 `backend/app/prompts.py`；`DEFAULT_SYSTEM_PROMPT` 改为 persona 常量 | A（skills 目录定位走 workspace/engine root） |
| C | **产课链** | LLM 直写 + 渲染器/质检收口：后端串行两次 LLM（讲解→出题，约束写进 prompt：锚点逐字纪律、题量 ≤10 分钟、题面排版、行文禁忌），随即 `render_lesson.py` 渲染 + `check_lesson.py` 质检，失败按归属打回重试或转人工。上游脚本零重写，缺失 503 | B |
| D | **开课链** | ① 落点 = 浏览器侧草稿区（对标 `.studymate-stage/<slug>`）+ 一次落点确认；② 盘问 = chat 内对话式，frontier（目的/程度/前置三档/3+ 候选项目/载体）问空为止，候选项目对话里挑，向导与 chat 共用同一份盘问状态机；③ 落盘结构化资料：用户给料（粘贴/上传/链接）→ 转 Markdown → `reference/` + 资源清单，**不做主动检索** | A、B |
| E | **采图（image-scout 等价）** | 全量复现：沿 `RESOURCES.md` 抓现成位图，配额照搬（每站 8 页/6 张、≤1 请求/秒、尊重 robots、不抓 PDF 与动态加载），过滤（去图标/头像/装饰/广告、宽 <400px、>500KB）与命名索引（`pool.md`）照搬，索引由后端维护；讲解 prompt 先读索引，挑不到自产 | A、B、C |
| F | **方向探索（learning-discovery 等价）** | chat 内可选入口（"我不知道学什么"），五问左右给 2–3 个可组合方向，选中后进开课准备（复用答案补缺项）；探索期只留会话状态，不建课、不写 MEMORY.md、不改掌握度；三级确认分开（确认方向 ≠ 确认建课 ≠ 同意开始）。E2E 映射表对应行由"不适用"改"已覆盖"并补用例 | D |
| G | **阅读端壳层** | `/lesson` 维持 iframe 承载上游渲染产物；Web 只做壳。上游静态 HTML 保留为离线入口（与"导出静态工作区"衔接）。增量改进只四类：开场状态切片、附件区入口、主题/导航一致性、移动端可读性；**不碰渲染产物** | 无 |
| H | **验证集（本轮先做）** | 四项全选，每项至少一条旅程级 E2E 用例：① 开场状态切片（MEMORY 分节 + 最近 5 误解/3 学习记录/3 评估记录）；② 开场报告 + 每轮「下一步」仪式（提示词行为）；③ 评估联升（实验课通过→该节点与 `prerequisites` 被验收节点同置"已通过项目验证"）+ 学习记录（仅可观察证据时写）；④ 摘要同日多段追加（替 `write_text` 覆盖）+ 附件区入口（reference/术语表/学习记录/会话摘要可读） | A、B |
| I | **记忆写侧** | 会话结束/评估通过时后端组 `memory_updates` 建议 → UI 待确认条目 → 用户逐条确认后写 `.learning/MEMORY.md`（增量修改不整篇重写）；读侧同步进开场切片（H①） | H① |

### 5.2 明确不做（2026-10-02 维护者）

- **lab 代码沙箱执行**：不做。`lab/` 留任务内容产出与 `lab_status` 四态接口（待生成/待提交/待评估/已通过），不建沙箱。
- **主动检索**：resource-scout 的"全网找权威资料"不做，只做落盘结构化（D）。
- **账号体系 / 云同步**：不碰（设计方案 §2 YAGNI）。
- **VitePress 提案的"前端不回写"边界**：已被 H／I 的实现推翻，该提案需与维护者另行对齐（见 Web_CHANGE 同日条目）。
