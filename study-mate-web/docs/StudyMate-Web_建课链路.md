# StudyMate Web 建课链路（档案）

> 性质：**链路档案**——把「从想学到课程进工作区」的完整链路按代码现状梳理一遍，供排查卡点、评估改动影响面用。
> 维护约定：链路结构变化（新增阶段/事件/产物、入口增删）时更新本文；`文件:行号` 会随改动右移，**以函数名 + 文件为准**，行号只作近似定位。
> 生成时间：2026-10-04（第八轮后）。同日的 `Web_CHANGE.md` 有各轮改动留痕。

## 0. 总览

```
【分支 A：建课会话（interview）】
/chat 空态「不知道学什么，帮我选方向」(discovery-starter)
  → POST /api/chat/stream (mode=interview)      chat.py::chat_stream
      注入 learning-system + learning-discovery 全文（prompts.inject_interview）
      真实 provider 走 K1 工具循环（只读工具；**动作工具仅科目关联会话开放**，interview 无科目故不给）
  → 助手回复带 <!--INTERVIEW_RESULT-->{JSON}<!--/INTERVIEW_RESULT-->
      chat.py::_handle_interview_result  取**最后一段完整**标记解析 → draft.create_draft（同名去重）→ data/drafts/<slug>/
      会话落 kind=build_confirm 卡（带 slug）+ SSE confirm
  → 用户点「确认建课」卡 → POST /api/drafts/<slug>/build
      production.py::build_draft → build.py::run_build
        ├ 大纲支：_curriculum_chain
        │    ├ 真实模型：K2 工具循环 _curriculum_tool_loop（BUILD_TOOLS；submit_curriculum 门禁回喂）
        │    ├ 回落：_dispatch_curriculum（单次派工 + envelope 重派 ≤2）
        │    └ 门禁：run_curriculum_gate（进程内 schema + 上游 check_curriculum.py）→ 不过则 retry ≤2 → 工单
        │        派工值 curriculum_values **内联 schemas/curriculum.schema.json 全文**（沙箱读不到仓库根，靠内联才可达）
        ├ 采图支：image_scout.scout_images（纯后端爬虫，不调 LLM，不阻塞；无参考资料时标「跳过」）
        └ 落盘：save_draft_curriculum + progress（首节点置「学习中」）→ done{slug}
  → 用户点「落点确认」卡 → POST /api/drafts/<slug>/promote（带触发会话 session_id）
      draft.py::promote 整目录搬到 <ws>/.learning/subjects/<slug>/ + gen_home.py 刷主页
      **并把触发会话自动关联到新科目**（草稿 slug 即科目 slug）
  → 之后逐节点产课：**在聊天里让 agent 调 produce_lesson 工具**（节点详情页「产出此课」按钮已删）
      tools.py::_tool_produce_lesson → produce.py::run_produce；建课完成卡另有「开始第一课」按钮发同一条消息
  → 节点评估：聊天里让 agent 调 assess_node 工具（节点页「申请评估」已删）

【分支 B：M4 向导（旁路）】
/generate 表单 → POST /api/courses/generate → generate.py::generate_course
  一次 generate 派工 → 校验 + check_curriculum.py 门禁 → 直接落工作区科目
  （无盘问、无草稿区、无采图、无工单；门禁 FAIL = 422 带 problems）
```

两条路的大纲派工值构造是两份代码：`generate.py::_generate_user_prompt` vs `build.py::curriculum_values`（后者多带 `RESOURCES.md`）。

## 1. 入口一览

| # | 入口 | 前端 | 后端 | 产物落点 |
|---|---|---|---|---|
| 1 | 空态「不知道学什么，帮我选方向」 | `ChatView.tsx::discovery-starter` → `handleSend(..., {mode:"interview"})` | `chat.py::chat_stream` | `data/drafts/<slug>/` |
| 2 | 「确认建课」卡 | `ChatView.tsx::startBuild` | `production.py::build_draft` → `build.py::run_build` | 草稿区补大纲/进度/图池 |
| 3 | 「落点确认」卡 | `ChatView.tsx::promoteDraftToWorkspace` | `production.py::promote_draft` → `draft.py::promote` | `<ws>/.learning/subjects/<slug>/`；**并绑定触发会话** |
| 4 | M4 向导（旁路） | `GenerateWizard.tsx::submit` | `generate.py::generate_course` | 直接落工作区科目 |
| 5 | 聊天里产课 | 用户提（或建课完成卡「开始第一课」） | `tools.py::_tool_produce_lesson` → `production` 之外的 `produce.py::run_produce` | 科目 `lessons/`、`lab/` |
| 6 | 聊天里评估 | 用户提（附作答原文） | `tools.py::_tool_assess_node` → `records.py::_assess_node` | `assessments/`、学习记录、状态机 |

> 入口 5/6 是 2026-10-04 第八轮：节点详情页原「产出此课」「申请评估」「问 Study Mate」三个按钮删除，产课与评估改为**会话 agent 工具**（只在**科目关联会话**开放），并把产课/评估的过程转成中文 `notice` 回吐聊天。节点页保留工单角标 `node-ticket-entry`。

## 2. 建课会话与盘问收口

- **mode 的来历**：`chat.py::chat_stream` 开头——**新会话**取 `payload.mode`，**已有会话**取会话自己存的 mode（`storage.create_session(mode=…)`）。所以 `payload.mode` 对已有会话无效；**想重开建课会话必须走「新对话」**（`ChatView` 里 `sessionId === null`）。选了会话再点 `discovery-starter`，那一轮仍按该会话的 mode 跑，收口标记**不会**建草稿。
- **注入**：`prompts.inject_interview()` = `learning-system` + `learning-discovery` 的 SKILL.md 全文 + `INTERVIEW_ADAPTION`（唯一 Web 独有口径：收口标记格式）。技能文件缺失 → **503 且在任何副作用之前**（不建会话、不留消息）。
- **收口解析**：`chat.py::_handle_interview_result`（正则 `INTERVIEW_RESULT_RE`，**取最后一段完整匹配**——模型可能先吐半成品结论再修正）。三种失败都落 `kind=error` 消息：JSON 非法（**原文截断回显**）/ 缺 `name` / 草稿重名。成功 → `draft.create_draft`（**同名按 strip + casefold 去重**，已存在则返回既有 slug，不再建逐字重复的两份）→ 落 `kind=build_confirm` 卡 + SSE `confirm`。这一轮没吐标记、且回复里不再有问号（形态上收尾）时，每会话至多追加一条可行动提示。
- **标记不外露**：落库前 `chat.py::_strip_interview_markers` 剥掉（含半截标记），前端 `lib/format.ts::cleanAssistantText` 渲染/复制再剥一次。
- **草稿骨架**：`draft.py::create_draft` 预建 `lessons reference assets learning-records sessions assessments` + `assets/img/pool`；`subject.yaml` 写盘问六键（name/slug/goal/level/background/project/carrier）；`curriculum.yaml` 先空。

## 3. 建课编排 `build.py::run_build`

**并发结构**：`curriculum_task`（大纲）与 `scout_task`（采图）用 `asyncio.create_task` 并行，`data = await curriculum_task` 是**真正的等待点**；`data is None` 则不落盘、不发 done。`audit.bind("build-<slug>")` 在 create_task **之前**（contextvar 才被继承）。`finally` 删 `.stage`。

### 3.1 大纲链 `build.py::_curriculum_chain`

1. **K2 工具循环** `_curriculum_tool_loop`（条件：非 fixture 且 `supports_tools(provider)`，后者**恒真**）：system = `inject_role("generate")`（curriculum-designer 全文）、user = `curriculum_values`（六键 + 输出契约 + **`schemas/curriculum.schema.json` 全文内联** + 硬约束速览 + RESOURCES 全文）；`ToolContext(read_roots=[草稿区], write_roots=[])`；工具集 `BUILD_TOOLS`；`submit_curriculum` 是**门禁回喂**（当场跑 `run_curriculum_gate`，不过就把报错原文回喂自修，过了才写 `state["curriculum"]`）；**带墙钟上限**（`ORCH_MAX_SECONDS`）与**进度心跳**（`on_progress` → SSE `progress`）。
   **为什么内联 schema（第八轮修）**：工具循环沙箱的读根只有草稿目录，模型自己读不到仓库根的 `schemas/curriculum.schema.json`，此前派工值只说"以该文件为准"⇒ 模型只能盲猜，门禁实测连打回 3 次（节点 id `nE1` 非法、edge 缺 `reason`、`realworld` 类型错）。内联全文 + 一句硬约束（id 只小写字母/数字与 `.`/`-`；节点必填 `id/title/objective/prerequisites/status/kind`；edge 必填 `from/to/reason`；`concepts`/`pitfalls` 是字符串数组、`realworld` 是字符串）后才可达。
2. **回落单次派工** `_dispatch_curriculum`：fixture 模式或工具循环无交付时走；envelope 契约失败原值重派 ≤ `MAX_RETRIES`(2)，每次重派前发 `retry`。
3. **门禁轮**：`run_curriculum_gate` = 进程内 `cs.validate_curriculum` + 上游 `check_curriculum.py`（`to_thread`，timeout 120s）。**返回码非 0 但问题解析为空时判失败**（第八轮修：把原始输出截断塞进 problems，不再当通过——否则绕开「不信任模型自查」的不变量）。通过 → `stage 门禁 done`；失败 → `stage 门禁 fail` + `retry`（**owners 取 problems 的真实归属**）→ 用尽则建 `kind=build` 工单 + `handoff` + `error`。打回/门禁卡带原因与问题条数（`🔁 第 N 轮打回（归属）（自检|派工）· 问题 M 条：前 3 条…`）。
   **注意**：门禁在真实 provider 下**会出现两次**（工具循环内 `submit_curriculum` 一次 + 这里的外层复核一次，即"不信任模型自查"的副产品）——见 §7 待拍板。

### 3.2 采图 `image_scout.py::scout_images`

- **纯后端爬虫，不进角色体系，不调 LLM**；fixture 模式直接 `done(downloaded=0, gaps=[…])`。
- **无参考资料即「跳过」（第八轮改文案）**：`RESOURCES.md` 抽不到 URL 时 stage 名变「采图 · 跳过（无参考资料）」、done 事件带 `skipped/reason`——从零建的草稿没有参考资料，采图必然是 0.1s 空转，旧文案 `✅ 采图（0 张）` 会让人误以为它做了事。**本体（是否恢复最小检索）待拍板**，见 §7。
- URL 来自 `RESOURCES.md` 的 http(s) 链接，页面下钻 ≤2 跳；配额 8 页/站、6 张/站、1 req/s；只收公网地址（拒私网/回环）、遵守 robots、拒 `.pdf`；过滤装饰词小图（<400px / >500KB）。
- 写 `assets/img/pool/*` + `pool.md`（索引 + `## Gaps`，只增不删），并跑 `scripts/check_pool.py` 自检（**已在第六轮挪到 `asyncio.to_thread`**——它与大纲并发，同步调用会把 SSE 一起冻住）。
- **任何失败只记 Gaps，不阻塞建课**（图片库为空是合格态）。

### 3.3 落盘

`stage 落盘 start` → `save_draft_curriculum` → progress：**第一个节点置 `{status:"学习中", mastery:0}`、`project.current = 盘问的 project`** → `stage 落盘 done` → `done{slug, stage:"build"}`。

**本阶段 SSE 事件**（`production.py::_stream_orchestration` 通用转发）：`session / stage / retry / progress / handoff / done / error / finished`（前端忽略 `finished`）。stage 取值：`大纲`（仅 progress 带）/ `门禁` / `采图` / `落盘`；status：`start / done / fail`。`progress` **不落库**。

## 4. 落点确认 promote

`production.py::promote_draft` → `draft.py::promote`：目标恒为**发现链给出的工作区**（`<ws>/.learning/subjects/<slug>`；`PromoteRequest.target` 是死字段，路由不传）；`shutil.move` 整目录搬移（大纲/进度/参考料/图池原样带走）；随后 `gen_home.py` 刷主页（失败静默）。同名科目 → 409。**promote 成功后 `data/drafts/<slug>/` 必须消失**。

**落点确认自动关联会话（第八轮）**：`PromoteRequest` 带触发建课的 `session_id`；落点成功后把该会话绑定到新科目（草稿 slug 即科目 slug，`update_session(subject_slug=slug, node_id=None)`）。此前 `_session_for` 在传入会话时直接 return、不写绑定，所以"建完课会话没关联"——现在建完课立刻能在聊天里产课/评估（动作工具只在关联会话开放）。

草稿区与工作区**同构**；一个已知副作用：草稿期 `ensure_subject_assets` 会把共享层写到 `data/assets/`（不随 promote 搬走），工作区期写 `<ws>/.learning/assets`（与课件路由的解析顺序一致）。

## 5. 产课链 `produce.py::run_produce`

1. 前置：`audit.bind("produce-<slug>-<node_id>")`；**顺序门**（已有 `.md` 数量与节点位次不符 → error，上游检查器要求课件编号连续）。
2. **实验课**：只出题——一次派工出「说明页 `lessons/NNNN-<id>.md` + 实操任务树 `lab/`」，说明页相对路径必须命中四位零填充命名，否则 error（带交付摘要诊断）。**实验课不派讲解**。lab 交付 required = `lab/<NNNN>-stage/README.md` + `lab/solutions/<NNNN>-stage/README.md` + `lab/README.md`，**缺一不 promote**。
3. **非实验课**：`stage 讲解` → 派工 `produce_content` → 写盘校验 → `stage 出题` → 派工 `produce_quiz`。**`kind=实操` 的 lab 整套归出题**（`lab/<NNNN>-stage/README.md` + `lab/solutions/<NNNN>-stage/README.md` + `lab/README.md`，保留原总表并增补本课），**缺一不 promote**；内容文件的 lab 入口链为 `../lab/<NNNN>-stage/README.md`。
4. `render_and_check`：`render_lesson.py` → `check_lesson.py`，各自 `stage 渲染/检查`。
5. **打回轮**（修复派工 ≤ `MAX_RETRIES`=2）：按 problems 的 owner 重派（`讲解` → 重派内容；出题受锚点影响跟着重派）；**纯总控归属只补共享资源后发 `stage 总控复检` 复检一次，不计入修复派工轮、也不谎报"2 轮"**；耗尽 `error` 带 `code=quality_check_failed` / `repair_rounds` / `rechecks` / `ticket_id`；每轮发 `retry{round, owners, problems}`。
6. 仍不过 → `kind=produce` 工单 + `handoff` + `error`。
7. **派工分流** `dispatch`：fixture → 工厂 envelope；真实模型 → **K3 工具循环** `_role_tool_loop`（`PRODUCE_TOOLS`：`write_deliver_file` 落 `.stage/<角色>/deliver/`、`run_check` 落盘后跑渲染+检查回喂；**同样带墙钟上限与进度心跳**）；`files` 为空则回落单次派工。**回落 / 直连的备用角色带 `execution_mode`（`tools` / `fallback` / `single_call`）与 `fallback_reason`/`max_seconds`/`elapsed_s`/`message`，按真实 start/done/error 呈现——envelope 返回只表示这次调用有回复，不等于自检通过**（保留原始失败、不刷屏、不虚构过程）。**既有产物复用**：本轮该角色**无新文件** 且 `regenerate=false` 且本次 ctx `check_passed` 且该角色 required 目标（出题 `*.quiz.json` / 其余 `*.md`）**存在可读非空** → 接受复用、不再派工；`regenerate` 布尔默认 `false`、`true` 强制重做、**且 `true` 须显式 `node_id`（bool 严格校验）**；**强制重做（检查打回重派轮）与工单 retry 禁复用**；quiz / ticket 交付同 gate required、**非 UTF-8 不复用**。真实 timeout 落角色终态、**任务非 running 隐藏当前阶段**、本地停止 roles 同终止。
8. **工单两动作**：`recheck`（只重跑渲染+检查）与 `retry`（重派）。**`retry` 的产课路径已改走 `dispatch()`（内部即 `_role_tool_loop`）**（第八轮 #25），与实时产课同能力；`kind=build` 的 `retry` 仍走单次派工。

> **新入口（第八轮）**：产课不再从课程页节点发起，而是聊天里 agent 调 `produce_lesson`（`tools.py::_tool_produce_lesson`）。它按大纲顺序取节点（不传 `node_id` = **按大纲顺序第一个尚无课件的节点**，**不沿用会话注入的节点聚焦**），真跑整条 `run_produce`，把 stage/retry/done/progress 转成中文 `notice` 回吐（**progress 节流 ~10s**）。因为工具执行在 agent 每轮 `asyncio.wait_for` 之外，含产课/评估工具的聊天回合墙钟改用 `ORCH_MAX_SECONDS`（1800s）而不是 `CHAT_MAX_SECONDS`（300s）——单节点产课实测可达 ~700s，沿用 300s 会让工具返回后的下一轮顶到 deadline 被判降级收尾。

## 6. 产物速查：看到什么 = 走到哪

| 阶段 | 磁盘 | 会话消息 |
|---|---|---|
| 盘问中 | `data/sessions/<id>.json`（`mode:"interview"`） | 普通 user/assistant |
| 收口成功 | `data/drafts/<slug>/`（`subject.yaml` 六键；`curriculum.yaml` 还是空的） | `kind=build_confirm`（带 slug） |
| build 运行中 | `data/audit/build-<slug>.jsonl`；`assets/img/pool/*` + `pool.md` | `progress` 不落库；`stage` 只存 done/fail |
| build 成功 | `curriculum.yaml` 有 `nodes/edges`；`progress.yaml` 首节点「学习中」 | `kind=done`（落点确认卡） |
| build 转人工 | `data/tickets.json` 出现 `kind=build` | `kind=handoff` + `kind=error` |
| promote 成功 | `<ws>/.learning/subjects/<slug>/` 出现、`data/drafts/<slug>/` 消失、`<ws>/index.html` 刷新 | —— |
| 产课中 | `data/audit/produce-<slug>-<node_id>.jsonl`；`lessons/*.md` → `.quiz.json` → `.html`（实验课另有 `lab/`） | `stage` 卡 |
| 产课转人工 | `kind=produce` 工单 | `handoff` 卡（可开质检面板） |
| 聊天里产课/评估（第八轮） | 同产课中；评估另落 `assessments/` + 学习记录、推进状态机 | **只发 transient `notice`，不落 stage 卡**（刷新后看不到过程）；工具卡常显在消息体 |

**会话消息种类**：普通 user/assistant（助手可带 `reasoning`/`tools`/`model`/`usage`）；卡片 `kind`：`build_confirm`(slug) / `stage`(done·fail 才落) / `handoff`(ticket_id) / `done`(slug) / `error`。
**审计事件名**（`data/audit/<key>.jsonl`）：`dispatch`、`dispatch_reply`、`agent_start`、`agent_done`、`agent_exhausted`、`agent_transport_error`、`agent_wallclock`、`agent_wallclock_turn`、`tool_call`、`build_loop_degraded`、`produce_loop_no_files`。**思维链与正文不落审计**。

## 7. 卡点排查索引

- **点了「确认建课」之后完全没动静**：先看会话有没有 `kind=error`；再看 `data/audit/build-<slug>.jsonl`——只有 `dispatch`+`agent_start` ⇒ 模型在长思考或上游沉默（**实测单轮 126.6s / 34644 字思维链**，属正常范围，看进度卡即可）；有 `tool_call` ⇒ 工具循环在跑；`build_loop_degraded` ⇒ 正回落单次派工；超 `ORCH_MAX_SECONDS` 会留 `agent_wallclock`。
- **「✅ 采图」之后长时间没动静**：**正常**——采图是纯后端秒级完成，等待点是大纲那支（`await curriculum_task`）。看进度卡（「大纲 · 第 N 轮 · 已等待 Ns」）。
- **门禁 fail**：手工复现 `python scripts/check_curriculum.py <curriculum.yaml>`（cwd = 仓库根）；转人工后看 `data/tickets.json` 或用质检面板快改 → recheck。
- **盘问结束却没有「确认建课」卡**：会话里找 `kind=error`（JSON 非法 / 缺 name / 草稿重名）；`data/drafts/` 有没有该 slug；都没有就是模型这轮没吐标记（让它「重新给出结论」）。真实 provider 下还有一类风险见待拍板 #2。
- **落点确认 409 / 课程页看不到新科目**：`<ws>/.learning/subjects/<slug>` 已存在 → 改名或删旧；promote 成功则草稿目录必须消失。
- **产课卡住/打回循环**：看 `data/audit/produce-<slug>-<node_id>.jsonl`（`run_check` 回喂的报错原文）；`lessons/` 已有几个 `.md`（顺序门比的是数量）；手工复现 `render_lesson.py` + `check_lesson.py`。**草稿区没有产课入口**（`produce_node` 只对工作区科目开）。

**第八轮新补四条：**

- **大纲门禁反复打回同一类错（节点 id 非法 / edge 缺 reason / realworld 类型错）**：先确认 `build.py::curriculum_values` 是否真把 `schemas/curriculum.schema.json` 全文内联（`_curriculum_schema_text()`，文件缺失时回落一句提示而不炸）。**已修**：沙箱读根只有草稿目录、模型读不到仓库根 schema，此前只能盲猜；内联全文 + 硬约束速览后才可达。若仍打回，逐条对比 problems 与内联里的约束描述。
- **采图秒完 0 张、stage 显示「采图 · 跳过（无参考资料）」**：**正常**——从零建的草稿没有 `RESOURCES.md`，采图没有 URL 可抓 ⇒ 结构性空转。文案已改（done 事件带 `skipped/reason`）避免误导；**是否恢复主动检索（让资源清单非空）本体待拍板**，见 §8 与《开发与计划》主动检索议程。
- **建完课会话没关联到新科目**：检查 `POST /api/drafts/<slug>/promote` 请求体有没有带 `session_id`（前端 `promoteDraftToWorkspace` 会带）。**已做**：落点成功后后端把触发会话绑到新科目；会话不存在时静默跳过、promote 本身照常成功。没关联时聊天里不会出现产课/评估工具。
- **聊天里产课**：agent 调 `produce_lesson`，**按大纲顺序**（跳跃节点会被顺序门 error），不传 `node_id` 即取**按大纲顺序第一个尚无课件的节点**（**不沿用会话节点聚焦**）；含产课/评估工具的回合墙钟走 `ORCH_MAX_SECONDS`（1800s，单节点实测可达 ~700s）。过程只发 transient `notice`（progress 节流 ~10s）、**不落 stage 卡**，刷新后看不到过程；工具执行成果反映在磁盘产物与工具卡结果里。回落 / 直连的备用角色在任务卡上如实标 `execution_mode`（`fallback` / `single_call`）并展示 `fallback_reason` / `max_seconds` / `elapsed_s` / `message`，按真实 start / done / error；**envelope 返回≠自检通过**，不刷屏、不虚构过程。

**本轮（2026-10-06 错误终态 / 检查器 / lab）新补四条：**

- **检查器把代码示例误报缺资源（已修）**：`check_lesson.py` 原用正则扫 `href/src`，`<pre>/<code>` 里转义的教学示例（`&lt;img src=…&gt;`）会被当成真实引用 ⇒ 误报缺资源。现改用 `RefScanner(HTMLParser)` **只取真实元素**的 `href/src`，**真实缺资源仍拦**；属脚本自身修复，**不是 Web 第二份引擎、不绕过检查**。旧 HTML 只读检查 OK（有 warnings）**≠ 重产通过**。
- **实操 lab 缺交付（已修）**：`kind=实操` 的 lab 整套先前不在 required 里 ⇒ 交付缺 lab 仍可能 promote，随后 `check_lesson` 按 kind 阻断并误打回。现 `required_artifacts` 一并 gate `lab/<NNNN>-stage/README.md` + `lab/solutions/<NNNN>-stage/README.md` + `lab/README.md`，**缺一 `_write_and_promote` 返回 None、不 promote**。
- **打回次数与错误详情**：`repair_rounds` / `rechecks` 分开，**总控复检不占派工轮、不再谎报 2 轮**；失败 / 超时 / 中断统一 `ErrorInfo`，任务卡 `error` 用 `ErrorNotice` 红卡渲染（`danger` / `neutral`），聊天消息同样持久化 `error` + `stream_state`。
- **真实重产（本轮实测）**：两会话经**浏览器 UI 编辑重发**（web `1c3bad7657b7` index6、Git `cc886d4641a1` index28）均以上游 **503 `system_memory_overloaded`** 失败（turn `e9731d08f43942468359d779fa406901` / `f6083744eef7470eb1600078b13a24ad`），**未成功重产**，待上游恢复；红卡已浏览器展开核验（`real-web-503.png` / `real-git-503.png`）。

## 8. 待拍板与已知不一致（以代码为准）

| # | 事项 | 现状 |
|---|---|---|
| 1 | **建课会话是否该带工具** | `use_tools` 不排除 `mode=interview` ⇒ 真实模型下建课会话也走工具循环；收口标记解析对"多轮拼接/被拆段"零容忍（非贪婪匹配），可能不建草稿、不出确认卡。**第八轮已落地候选③的一半**：#14 改为**取最后一段完整匹配**、JSON 解析失败把原文（截断）回显成 error 卡；候选①（interview 恒走纯文本）/②（收紧提示词）仍待拍板。fixture E2E 只覆盖纯文本路径，所以一直全绿 |
| 2 | **门禁 stage 双发** | 工具循环内 + 外层复核各发一次 ⇒ 前端两条「✅ 门禁完成」。是"不信任模型自查"的副产品；可改名（门禁自检）／去重／接受（**未动**） |
| 3 | ~~工单 retry 未走工具循环~~ | **已在第八轮修正**：`run_ticket_retry` 的产课路径改走 `dispatch()`（内部 `_role_tool_loop`），与实时产课同能力；`kind=build` 的 retry 仍走单次派工 |
| 4 | ~~门禁解析可能放行~~ | **已在第八轮修正**：`run_curriculum_gate` 在 `returncode != 0` 且 problems 解析为空时**判失败**，把原始输出（截断）塞进 problems |
| 5 | **M4 generate 链未工具化** | 与 build 的大纲派工同角色、两个入口，一个走了 K2 一个没有；是否有意保持旁路待拍板 |
| 6 | 建课打回卡的 owners | **已在第六轮修正**：改为取 problems 的真实归属（此前硬编码「出题」） |
| 7 | `PromoteRequest.target` | 死字段（路由不传），落点恒为发现链工作区 |
| 8 | 草稿期 `data/assets/` | 共享层副产物，不随 promote 搬走；工作区期写 `<ws>/.learning/assets` |
| 9 | **主动检索本体**（第八轮议程） | 现状资料收集只做落盘结构化、不做主动检索 ⇒ 从零建课资源清单为空 ⇒ 采图结构性空转。可选：恢复最小检索 / 保留只读并去掉采图阶段 / 用 web 工具让 agent 自己检索。**本轮不实现** |
| 10 | 聊天产课不落 stage 卡 | 产课过程只发 transient `notice`（progress 节流 ~10s），刷新后看不到过程；产课工具的真实 LLM 冒烟本轮未跑（真实链路只验了建课） |
