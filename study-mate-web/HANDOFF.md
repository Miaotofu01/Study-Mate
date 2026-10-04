# HANDOFF — StudyMate Web 交接（2026-10-04 · 第十七版，建课链正确性 + chat 动作工具轮后）

> 给下一个接手 `study-mate-web/` 子项目的 agent。**本文只做索引与状态，不重复其他文档的内容**——细节一律走路径。
> 脱敏说明：本子项目不含任何密钥/PII；测试用占位 key 均为假值。

## 一句话现状

**同日第八轮（建课链正确性 + chat 动作工具 + 「我的课程」）**：给"建完课接不下去"补最小通路——**产课与评估改由会话 agent 工具触发**（`produce_lesson` / `assess_node`，只在**科目关联会话**开放；节点详情页「产出此课」「申请评估」「问 Study Mate」三个悬空按钮删除，保留工单角标），**落点确认带 `session_id` 把触发会话自动绑定到新科目**，**聊天右栏新增科目图谱/大纲区**（共享 `SubjectGraphPanel`）；含产课/评估工具的聊天回合墙钟改用 `ORCH_MAX_SECONDS`（1800s，单节点产课实测可达 ~700s）。同轮修建课链正确性：**大纲派工值内联 `schemas/curriculum.schema.json` 全文**（沙箱读不到仓库根 ⇒ 此前只能盲猜、实测门禁连打回 3 次）、**门禁非零退出但解析为空判失败**、**采图无参考资料标「跳过」**、**草稿同名去重**、**工单 retry 走工具循环**、**收口标记取最后一段完整匹配 + 解析失败原文回显**。前端：**工具卡移出「中间过程」折叠区、常显**（面板只留思维链与提示、皆空不渲染）、流式贴底才跟随、**`/courses` 不带 `?subject=` 变「我的课程」**（内嵌工作区主页 iframe、无右栏，侧栏改名）、建课完成卡加「开始第一课」。**调查结论**：插件学习模式预设的工具面远大于 Web chat 现状（3 只读 + 2 动作），整体扩容挂 K4；**主动检索**（从零建课资源清单为空 ⇒ 采图结构性空转）提上议程、本轮不实现。门禁：pytest **152 + 1 skip**（含断开兜底 4 条 + 存储并发 3 条）、E2E **62 + 3 skip（0 失败）**、组件 **20 全绿**、tsc/build 通过、根 `npm test` 仅 1 条已知 CRLF 假红。细节见 Web_CHANGE 第八轮。

**同日第七轮（建课链路真机探索；维护者拍板"拍板先放着，先跑探索"）**：**用真机把整条建课链从零跑通，没有永久卡死** —— 真实后端 + 真实网关 `my-api` / `Deepseek-v4-flash` + high：盘问 7 轮收口（单轮 69.5/12.0/14.3/10.8/46.9/15.2/14.5 s）→ 草稿 `python` → **建课编排 685 s（11.4 min）**：采图（0.1 s）→ 大纲（**12 轮 / 20 次工具**，8 轮探索预算被 `list/read` 吃光，门禁**打回 3 次**后第 4 次通过）→ 落盘 → `promote` 落进工作区（侧边栏出现「Python 报表自动化」，`curriculum.yaml` 带完整 nodes/edges）。**澄清**：「卡在采图」是误读——`image_scout` 不调 LLM，从零建的草稿没有 `RESOURCES.md` 资料 ⇒ 秒完 0 张；真正耗时的是并发的大纲。**可见性按契约生效**（69 份 `progress` 快照，`round` 0→12、`elapsed_s` 与 `reasoning_chars` 一路涨），但**发现并修掉一个真 bug**：`ProgressReporter.note()` 只认单数 `tool_call`，而 `turn_source` 吐整批 `tool_calls` ⇒ 真机 20 次调用全报 0（后端 pytest +1，现 **119 + 1 skip**）。**新发现**：编排 SSE 刻意不转发工具/思维链明细，会话里只有「采图/门禁/落盘」卡片；**门禁打回 3 次在 UI 上就是 3 张不显示原因的 `⚠ 门禁`**（problems 只回喂模型）；盘问会话实测**确实带工具**（收口轮 8 轮 / 17 次调用），#23 的前提被证实；**墙钟上限未成瓶颈**（临时抬到 3600 求稳，实跑 685 s ⇒ 出厂 1800 s 够用，已恢复默认、未改常量）；HANDOFF 第四轮记的"`Deepseek-v4-flash` 档位名与网关不匹配会 400（#21）"**本次未复现**（`reasoning_effort=high` 两次真机调用都正常）。细节见 Web_CHANGE 第七轮。

**同日第六轮（① 过程可见性 + ③ 墙钟上限；维护者拍板"先 1+3 再跑探索"）**：**编排不再"一片死寂"**——`agent.ProgressReporter` 每 ≥0.5s 发一份进度快照（轮次 / 已等待秒数 / 思考字数 / 工具次数），后端映射成 `progress` 事件（**不落库**），建课卡片显示「大纲 · 第 N 轮 · 已等待 Ns · 已调用 M 次工具（最近 xxx）· 已思考 Kk 字」、产课面板显示同一行（刻意**不**逐条转发思维链：实测单轮 3396 个事件）；**单次时长有了硬上限**——`run_agent(max_seconds=…)` 到点用现有内容收尾并提示，聊天 `STUDYMATE_CHAT_MAX_SECONDS` 300s / 编排 `STUDYMATE_ORCH_MAX_SECONDS` 1800s（真实产课单次派工可达 694s，两档必须分开）。**真机验证**：把上限压到 8s 跑那条实测 126.6s 的大纲派工，8.0s 干净收尾、已产出的 1310 字思维链保留、提示按预期发出。**下一步**：按维护者计划跑探索测试（新建会话指定 deepseek、跑通建课）——现在既能看见"第 N 轮 / 已等待 Ns"，也不会再无限等。同轮已派代理梳理整条建课链路并落成新档案 → `StudyMate-Web_建课链路.md`（含「看到什么=走到哪」速查与卡点排查索引），同时修掉它捎带发现的两处实锤：建课打回卡 owners 硬编码「出题」（改为取真实归属）、采图自检子进程同步阻塞事件循环（挪 `to_thread`）。门禁：pytest **118 + 1 skip**、E2E **60 + 3 skip（0 失败）**、组件 **20 全绿**、tsc/build 通过。

**同日第五轮（建课卡点定位）**：维护者指出前一轮排查没抓到根因，让我直接看最新会话记录。已定位并给出证据（见「已知坑」与 Web_CHANGE 第五轮）：**卡点是"大纲派工的第一次 LLM 调用"，不是采图、也不是 build 的逻辑 bug**——`image_scout` 是纯后端（不调 LLM），几秒跑完发出 `✅ 采图` 卡；真正等待的是并发的 `curriculum_task`。建课审计只有 `dispatch` + `agent_start` 两行（**没有错误、没有 tool_call**），因为**思维链与正文都不落审计**，模型长时间思考期间日志与 UI 全静默 ⇒ **"在工作"与"卡死"不可区分**。实测单轮：`Deepseek-v4-flash` + 档位 high = **126.6 秒 / 34644 字思维链**才发起第一次工具调用（u2-flash medium 69 秒；同一模型不开思考 3.8 秒），工具循环上限 12 轮 ⇒ 整条建课 10 分钟量级。同时修掉维护者点名的体验问题：**收口标记 `<!--INTERVIEW_RESULT-->` 不再出现在消息里**（后端落库前剥 + 前端渲染/复制再剥，含半截标记与首尾空行，历史消息也干净）。待拍板清单里新增第 7 项（编排过程可见性，backlog #28）。

**同日第四轮（会话级模型 + 档位语义兼容 + 排查轮）**：维护者追加五项并要求"派代理排查 K 系列与开课流程的对齐、以及上手时的卡住 bug，分歧由他拍板"。已实施：**档位取值两类语义兼容**（`disabled/enabled` 这类是**思考开关**不是档位——归一化为"关不发参数、开用默认档 medium；自由档位名照发；Anthropic 认不出不发"；并修掉"显式选关却被抹空、回落默认档"的旧 bug）、**会话级模型与档位**（会话 JSON + meta 增 `active` 三元组，`PATCH /api/sessions/{id}` 可绑可解；该会话的 chat/评估/小结/记忆都跑绑定模型，失效回落 + 提示；前端会话内切换只写会话、新对话态仍写全局；`hasKey`/上下文窗口分母/名称栏回退值一并按"生效三元组"算）、**头像 46px**、**9 条陈旧组件测试重写**（现 14 条全绿）；并按两个只读代理的排查做了**防御性修复**（`max_retries=0`、非瞬时错误不空转重试、SSE 断开时 cancel runner、附件解析与 `generate` 子进程下线程池、`replace_from` 负数改 422、附件清理跳过仍被引用的 id、前端流未收尾时补错误）。**待维护者拍板的六项已列在"接下来做什么"**（墙钟预算、建课会话是否带工具、stage 双发、工单重试、门禁解析放行、generate 未工具化）。门禁：后端 pytest **112 + 1 skip**、E2E **60 + 3 skip（0 失败）**、组件测试 **14 全绿**、tsc/build 通过、根 `npm test` 仅 1 条已知 CRLF 假红。

**2026-10-04 当日第三轮已跑完**：维护者提 5+1 条 UI/交互要求（先只做确认，代理逐条核对现状后给出改法与待拍板项，维护者逐条拍板）。本轮落地：**助手名称栏**（显示「提供商 / 模型」，落进助手消息的 `model` 字段）；**消息操作条**——用户消息「复制 / 编辑」（编辑 = 带 `replace_from` **截断重发**，等效"从这句重新生成"，原附件默认保留且可增删）、助手消息「删除本轮」（`DELETE /api/sessions/{id}/messages/{index}`，用户提问与回复**成对删**，内联二次确认）；**「中间过程」折叠区**（`<details>` 默认收起，收纳**思维链 + 工具调用卡 + 本轮提示**，且 `reasoning` / `tools` **随助手消息落库**——刷新后仍可回放，这是 backlog #19 的落地）；右栏新增**「上下文窗口」栏**（最近一轮 prompt tokens / 模型上下文长度 + 进度条，用量来自末块 `usage` 并落会话 `usage` 字段）；头像 28px → **56px**（用户圆形、助手圆角方形）、空态大图标换品牌图标并放大；模型与推理档位下拉**移到右端紧邻发送按钮**、**去掉「思考 · 」前缀**（输入区 + 设置页徽标，E2E 同步）；会话态输入栏上方的**分隔细线移除**；设置页模型默认值改**「兜底默认」语义**（最大输出 Token / 上下文长度不再预填，留空即 null，兜底值由 `lib/contextWindow.ts` 单点定义）。

同轮按拍板先做了**真机探针**：确认网关逐段发 `delta.reasoning_content`、末块自带 `usage`（故不主动发 `stream_options`），并顺带发现 `Deepseek-v4-flash` 的档位名与网关不匹配（400，属用户数据，记 backlog #21）。

**门禁**：后端 pytest **81 条通过 + 1 skip**（新增 `test_message_actions.py` 6 条）；E2E **58 条通过 + 3 条 skip（悬空占位，0 失败）**（新增 `message-actions.spec.ts` 5 条）；`tsc --noEmit` 零错误、`npm run build` 通过；根 `npm test` 仍是 17 通过 + 1 条已知 Windows CRLF 假红。

**组件测试层有 9 条陈旧红**（`tests/component/` 13 条中：`ChatView.test.tsx` 3 条断言已移除的"工作区引导块"、`ProvidersView.test.tsx` 6 条断言已移除的「保存」「测试连接」按钮）——自前两轮 UI 改动起即红、**不进根门禁**，本轮未动，已记 backlog #20。

第三～九轮的累计改动（前端三轮 UI + 生产侧 + K 系列工具化 + 编排可见性/墙钟 + 建课链正确性 + agent 工具化产课/评估 + 断开兜底 + 存储并发安全 + 右栏选项卡）已按维护者指示**一次性提交**并推送到 fork 分支 `feat/study-mate-web`；PR #43 已由占位 draft 转为**正式待上游 review**（目标 `main`）。版本号 0.5.0-beta → **0.6.0-beta**。K4（总控全 agent 化）远期观望。

## 上一版遗留项的处置

- **工具卡持久化（上一版建议项 6，标注"未拍板，勿自行动手"）**：第三轮已拍板并落地 —— 思维链与工具调用随助手消息落库，收进「中间过程」折叠区（backlog #19 已划掉）；**第八轮又把工具卡移出折叠区改为常显**（面板只留思维链与提示）。
- **上一版（第七轮）新积压的两项**：**门禁打回卡不带原因** → 第八轮已带原因与问题条数；**编排流不暴露工具/思维链明细** → 仍未动（属细节层，挂 K4/编排可见性后续）。
- **第八轮新发现的两个小尾巴**（见「接下来做什么」）：**产课工具的真实 LLM 冒烟尚未跑**（本轮真实链路只验证了建课，产课工具是 fixture E2E 覆盖）；**聊天里产课的过程只发 transient `notice` 不落 stage 卡**（刷新后看不到过程）。
- **悬空入口（#17）/ 工作区绑定放宽（#18）/ 真实 LLM 冒烟补 anthropic·responses（#3）**：均未动，仍在 backlog。
- **启动器重建轮**（上一版同日追加）：无变化，仍是 `start-web.bat` / `stop-web.bat` / `tools/studymate-web.ps1`。

## 接下来做什么

**第一优先：待维护者拍板的排查结论（第 1、4、5 项已落地；第 2、3、6 项等拍板；第八轮新增主动检索与 chat 工具面扩容）**

1. **~~单轮墙钟预算~~ 与 ~~编排过程可见性~~：已完成（第六轮 #22 + #28）** —— `progress` 快照 + 建课进度卡 / 产课进度行 + `max_seconds`（聊天 300s / 编排 1800s，env 可覆盖）。**维护者的探索测试已于第七轮跑完**：新建 interview 会话指定 deepseek、建课 685s 一次跑通；进度卡按轮次走动、「已等待 Ns」持续增长、**未触到 1800s**（出厂默认够用）；期间修掉进度卡 `tool_calls` 恒为 0 的计数 bug。第七轮新积压的"门禁打回卡不带原因"**已于第八轮补上**（带原因与问题条数）；"编排流不暴露工具/思维链明细"仍未动。
2. **建课会话是否该带工具（#23）**——真实 provider 下 `mode=interview` 也走工具循环，而收口标记解析对"多轮拼接/被拆段"零容忍，可能不建草稿、不出确认卡（fixture E2E 只覆盖纯文本路径所以全绿）。**第八轮已落地候选③**：解析取**最后一个完整匹配**、JSON 解析失败原文回显、缺标记且已收尾时给一次可行动提示。候选①（interview 恒走纯文本）②（保留工具但收紧提示词）仍待拍板。
3. **「门禁」「检查」stage 双发（#24）**：循环内 + 外层复核各 emit 一次 ⇒ 前端两条"✅ 完成"。候选：循环内改名（门禁自检）／前端按 stage 去重／接受重复。**未动**。
4. **~~工单重试链未走工具循环~~：已完成（第八轮 #25）** —— `run_ticket_retry` 的产课路径改走 `dispatch()`（内部 `_role_tool_loop`），与实时产课同能力；`kind=build` 的 retry 仍走单次派工。
5. **~~门禁 problems 解析可能放行~~：已完成（第八轮 #26）** —— `run_curriculum_gate` 在 `returncode != 0` 且 `_gate_problems` 解析为空时**判失败**，把原始输出截断塞进 problems。
6. **M4 `generate` 链未工具化（#27）**：与 build 的大纲派工同角色不同路径，是否有意保持旁路待定。**未动**。
7. **主动检索本体（#9 / 《开发与计划》§5.3）**：从零建课资源清单为空 ⇒ 采图结构性空转。三条可选路线（恢复最小检索 / 保留只读并去掉采图阶段 / 用 web 工具让 agent 自己检索），**本轮不实现**，等拍板。
8. **chat 角色工具面扩容（#29，挂 K4）**：插件总控工具面（写盘 / 跑脚本 / 派子代理 / 联网 / present）远大于 Web chat 现状（3 只读 + 2 动作工具）。本轮先补最小通路，整体对齐挂 K4（#16）。
9. **产课工具的真实 LLM 冒烟 + 过程落卡（#30）**：`produce_lesson` 尚未在真实网关跑过（本轮真实链路只验证建课）；聊天里产课只发 transient `notice`、不落 stage 卡，刷新后看不到过程。

**其余候选（按建议优先级，序号接在上面之后）：**

7. **悬空入口接回**（backlog #17）：「生成小结」与聊天侧「沉淀记忆」仍无 UI 入口（后端端点、`MemoryDialog.tsx`、`WorkspaceOnboarding.tsx` 保留）。**消息操作条本轮已就位，是最现成的落点**；接回后摘掉 `memory-flow.spec.ts` / `session-summary.spec.ts` 的 `test.skip`。
9. **会话级工作区放宽**（backlog #18）：绑定要求目录已存在（否则 422）；要支持"先指向空目录再冷启动"就删那处存在性校验。
10. **真实 LLM 冒烟收尾**（backlog #3）：anthropic / openai_responses 的真实流式（含 tools、含本轮新增的**思维链与用量**分支）仍未验证——本机没有这两类渠道；这两格式的 reasoning / usage 解析属未验证路径。
11. **`Deepseek-v4-flash` 档位名与网关不匹配**（backlog #21，维护者已自行把档位改成 high，生效）：用户数据问题（改成 `low/medium/high` 即修），未替维护者改。
12. **K4 总控全 agent 化**（backlog #16，远期）：参考 `K系列尽调-DSH与DeepTutor工具机制存档.md` §七。
13. **能力声明剩余两项**（backlog #14 余项）：`json_schema_output` / `native_web_search` 仍仅落盘展示。
14. **探索测试提醒（AGENTS.md 规则 9）**：本轮改动不小（会话级模型、档位语义、防御性修复），建议按《探索测试指南》跑一轮，建议目标：**同一模型在两个会话里分别切换、互不影响**（含刷新后重开）；**档位表填 `disabled/enabled` 的模型不再 400**（这是本轮修的线上问题）；编辑重发（改中间某条 → 其后内容截断 → 附件增删命中服务端）；删除整轮的附件清理；思维链折叠区刷新后仍可展开；46px 头像在窄屏与暗色下的观感；**长回答不再无限转圈**（墙钟预算拍板后补验）。是否执行由维护者定。

**硬约束（不变）**：上游脚本只复用不重写；`/lesson` 维持 iframe 承载上游渲染产物；改功能必须同步五份文档（AGENTS.md 规则 8）；**门禁仍由后端在写盘后强制执行**（不信任模型自查）；任何 commit/push/tag 必须维护者明确同意，完成后停在待提交状态报告。

## 第四轮已完成（未提交，2026-10-04）

- **后端**：`llm.py`（`ReasoningRequest` + `_reasoning_request` + `_openai_reasoning_effort`；`build_client(max_retries=0)`）；`config.py`（`_compose_provider` 抽出 + 新增 `get_session_provider`；`_model_reasoning_variant` 不再抹空显式「关」）；`common.py`（`require_provider(session_id)` 优先会话绑定）；`storage.py`（会话 `active` 三元组）；`models.py`（`SessionActiveRequest` + `SessionPatchRequest.active`）；`chat.py`（绑定模型解析 + 失效提示、`replace_from` 负数 422、附件清理跳过仍被引用的 id、SSE `finally` cancel runner、附件解析下线程池）；`agent.py`（非瞬时错误不重试 + 文案）；`generate.py`（门禁子进程 `to_thread`）。
- **前端**：`ModelSelector`/`ReasoningVariantSelector` 接受 `sessionActive`（会话内切换只 PATCH 会话）；`Composer` 透传；`ChatView`（`sessionActive` 状态 + 生效三元组驱动 `hasKey`/名称栏/上下文窗口；头像 46px）；`api.ts`（`setSessionActive`；流未收尾时合成错误）；`types.ts`/`workspace.tsx`（`active` 字段）。
- **测试**：新增 `test_reasoning_variants.py` 21 条、`test_session_model.py` 10 条、`session-model.spec.ts` 2 条；重写 `tests/component/ChatView.test.tsx` 与 `ProvidersView.test.tsx`（9 条陈旧红 → 14 条全绿）。
- **门禁**：pytest 112+1 skip、E2E 60+3 skip（0 失败）、组件 14 全绿、tsc/build 通过、根 `npm test` 仅 1 条已知 CRLF 假红。
- **待拍板六项**见「接下来做什么」1–6；排查证据与代码坐标见 `Web_CHANGE.md` 同日第四轮条目。

## 第三轮已完成（未提交，2026-10-04）

- **后端**：`llm.py`（`_delta_field` / `_usage_payload`；三格式透出 `reasoning` 增量与 `usage`，**不主动发 `stream_options`**）；`agent.py`（`AgentOutcome` 增 `reasoning`/`usage`/`tools`；转发 reasoning、累计用量、按 id 维护工具卡；重试判据加 `reasoning_parts`；fixture 加 `process` 场景与 `FIXTURE_USAGE`）；`storage.py`（`drop_messages` / `truncate_messages`）；`chat.py`（SSE 事件表补 `reasoning`/`usage`；助手消息落 `reasoning`/`tools`/`model`，会话落 `usage`；附件**复用会话目录**（`_find_in_session`）+ `_cleanup_attachments`；`replace_from` 截断重发；`DELETE /api/sessions/{id}/messages/{index}` 删整轮）；`models.py`（`ChatRequest.replace_from`）。
- **前端**：`lib/contextWindow.ts`（新，兜底默认值 + token 缩写 + 占用百分比）；`ChatView`（头像 56px / 名称栏 / 操作条 / `ProcessPanel` / `UserMessageEditor` / `IconAction` / `chat-messages` 锚点 / 提示收进折叠区）；`Composer`（下拉靠右、去前缀、去细线）；`RightSidebar`（上下文窗口栏）；`settings/ProvidersView`（徽标去前缀 + `model-variant-badge`）；`settings/ModelEditDialog`（兜底默认语义）；`lib/api.ts` / `lib/types.ts` / `lib/workspace.tsx` 同步。
- **真 bug（本轮唯一，且被测试抓到）**：`chat.py` 的 `event_names` 漏登记 `usage` → `event_names.get(...)` 落到 `"notice"` 默认值，用量事件被当提示事件发出；新写的 pytest `assert "event: usage" in body` 直接红，补映射即修。
- **测试与门禁**：见「一句话现状」。
- **踩坑（本轮新增，已同步 E2E 文档 §4.25 与已知坑）**：`toBeHidden()` 要求单一匹配（对多个 `tool-card` 会 strict violation）；`panel.locator("summary")` 会命中内嵌工具卡的 summary；会话标题会与消息正文撞词（断言要限定 `chat-messages`）。
- **文档**：PRD（§2.3 / §5.5 新增 + 状态总览 + §1.3 / §2.1 / §5.1 / §5.3 / §5.4）、开发与计划（模块表 / 组件清单 / 对外契约 / 不变约束 #15 / backlog #19–#21）、E2E 流程升 v2.0、README、Web_CHANGE 追加本轮条目。

## 文档地图（先读这几份，按需深入）

| 文档 | 用途 |
|---|---|
| `AGENTS.md`（本目录） | 子项目硬规矩 + 规则 8 五份文档同步约束 + 规则 9 探索测试提醒 + 端口 |
| `README.md` | 启动（bat/手动）、配置模型、附件、消息操作与「中间过程」、E2E 运行、版本语义（0.6.0-beta）、运行结构树 |
| `StudyMate-Web_开发与计划.md` | **架构现状 + 不变约束（含 #13 工具化、#14 会话级工作区、#15 消息级操作与中间过程落库、#16 档位两类语义、#17 单轮时长与事件循环、#18 编排可见性、#19 会话工具面与建课闭环）+ 领域模型 + §5 队列/backlog（#16 K4、#17 悬空入口、#18 工作区放宽、#19 工具卡落库已完成、#20 组件测试已对齐、#21 档位名不匹配、#23/#24/#27 待拍板、#25/#26 第八轮已完成、**#29 chat 工具面扩容 / #30 产课工具冒烟与过程落卡**；**§5.3 主动检索议程 + chat 工具面差距表**）** |
| `StudyMate-Web_PRD.md` | 功能规格（描述现状；**§2.3 思维链与用量透传 + §5.5 消息操作与中间过程折叠为 2026-10-04 第三轮口径；第八轮**：工具卡常显、聊天右栏图谱、`/courses` 我的课程首页、产课/评估工具化、建课自动关联、节点页三入口删除） |
| `StudyMate-Web_E2E测试流程.md` | v2.4：用例 ↔ 上游旅程映射（§4.27–§4.30 新增 + §4.6 删除 + §4.22/§4.25 改写）+ §2 三类盲区与 P1–P5 补强计划；**62 条通过 + 3 skip** |
| `Web_CHANGE.md` | 变更史与全部 grill 决策留痕（只追加；**2026-10-04 共八条**，最新为**第八轮建课链正确性 + chat 动作工具 + 「我的课程」**） |
| `StudyMate-Web_建课链路.md` | **建课全链路档案**：总览流程图 + 入口表 + 盘问收口/建课编排/promote/产课逐段（含函数名与事件名）+ **产物速查「看到什么=走到哪」** + **卡点排查索引（第八轮补四条：schema 可达性 / 采图空转 / 自动关联 / 产课工具）** + 待拍板/已知不一致 |
| `K系列尽调-DSH与DeepTutor工具机制存档.md` | K0 设计输入（wire/loop/边界/审计/子代理结论 + 证据路径） |
| `StudyMate-Web_前端美化设计.md`、`StudyMate-Web_探索测试指南.md` | 未跟踪的设计/指南文档（按需） |
| `反馈清单.md` | 维护者手写 10 条反馈，已全部落地并逐条回填 |

上游侧事实依据：`.dsh/skills/learning-system/{lesson-design,layered-practice,record-keeping,practice-evaluator,evidence-check,local-qa,learning-discovery}/SKILL.md`、`scripts/{gen_home,render_lesson,check_lesson,check_curriculum}.py`、`SKILL_ROUTES`（`backend/app/prompts.py`）。DSH 运行时本体在 `D:\deepseek-harness`，可随时回去查源码。DeepTutor 只读克隆在 `D:\Local-projects\Study-Mate\DeepTutor`（前端在 `web/`，不是 `deeptutor_web/`）。

## 已知坑（踩过的别再踩）

- **编排看得见了（第六轮）**：编排期间 SSE 会发 `progress` 快照（轮次 / 已等待秒数 / 思考字数 / 工具次数），建课卡与产课面板据此显示"在干活"；它**不落库**（高频），也不进 E2E（fixture 瞬时、断言不可靠，改由组件测试铺）。另外 `run_agent(max_seconds=…)` 有硬上限（聊天 300s / 编排 1800s，用 `STUDYMATE_CHAT_MAX_SECONDS` / `STUDYMATE_ORCH_MAX_SECONDS` 覆盖），到点用现有内容收尾。**要判断"是卡了还是在跑"：先看进度卡，其次看 `data/audit/*.jsonl`。**
- **建课/产课"卡住"先看这三处**（第五轮定位结论）：① 采图是纯后端、几秒就完，它跑完不代表大纲有进展——`run_build` 是"大纲 ∥ 采图"并发，`await curriculum_task` 才是等待点；② 审计里**思维链与正文都不落盘**，只有 `tool_call`/`agent_done`/`agent_transport_error`/`agent_exhausted` 四类事件，所以"长时间只有 `agent_start`"既可能是模型在长思考，也可能是上游沉默或进程被杀，**光看日志分不出来**；③ 实测单轮成本：`Deepseek-v4-flash` 档位 high = **126.6s / 34644 字思维链**才发第一次工具调用（medium 类模型约 69s；关思考 3.8s），工具循环 12 轮上限 ⇒ 建课 10 分钟量级。结论：卡点是**"没有可见性 + 没有墙钟上限"**，不是 build 逻辑 bug，也不要先怀疑采图。
- **会话存储是"整文件读改写"，必须原子替换 + 串行（第八轮独立子代理查出并已修）**：`storage._write` 原来 `open("w")` 先截断再逐段写，并发压测下读侧抛 `Extra data`、HTTP 侧 **2973/3156 并发 GET 500**，最坏留下永久损坏的会话文件（界面表现为"暂无会话"）；并发写者还会互相覆盖丢消息。现在 `_write` 走临时文件 + `os.replace`（Windows 上对 `PermissionError` 退避重试），读写共用一把可重入锁，`list_sessions` 跳过坏文件而不是 500。**再遇到"会话/消息凭空消失或列表 500"，先看 `data/sessions/*.json` 能否解析。**
- **切会话/关页会丢掉本轮回复（第八轮修复，别再给两条路径写"流结束后才落库"）**：工具路径在 runner 里落库、纯流路径在 `while` 之后落库，断开时前者被 `task.cancel()` 取消、后者收到的是 `CancelledError`（继承 `BaseException`，`except Exception` 抓不住）⇒ 那轮回复从未入库、**找不回来**。现在两条路径都有"边发边攒 + 断开兜底"（`_accumulate_partial` / `_persist_partial`），落库的兜底消息带「本轮输出过程中连接中断」提示。排查同类问题：会话 JSON 以**用户消息结尾**且审计最后一轮只有 `agent_start`/`tool_call`、没有 `agent_done` ⇒ 就是它。
- **`REQUEST_TIMEOUT` 是 per-read 超时，不是单次请求的总时长上限**（本轮排查的根因）：网关只要在任意 900s 窗口内吐过 ≥1 字节（思维链增量、SSE 心跳）就永不触发；再叠 SDK 自身重试与 agent 层重试会放大成小时级。已做 `max_retries=0` + 非瞬时错误不重试，**墙钟总预算仍待拍板**。排查这类问题看 `data/audit/*.jsonl`（逐条落盘、即时可见）：`agent_start` 之后长时间没有 `agent_done`/`agent_transport_error`/`agent_exhausted` 就是它。
- **同步重活绝不能跑在事件循环里**：`generate.py` 的门禁 `subprocess.run(timeout=120)` 与 chat 的附件 PDF 解析此前都是同步的 ⇒ 堵住事件循环会让**同进程所有 SSE 流、附件上传**一起卡数秒到 2 分钟（容易被描述成"整个应用卡住"）。两处已改 `asyncio.to_thread`；新增耗时操作照此办理。
- **`_model_reasoning_variant` 别把"显式选的关"抹成空串**：抹空会让下游回落模型默认档（默认可能是 high）——用户选了关却开了思考。开关语义统一由 `llm._reasoning_request()` 归一化。
- **会话级模型是"生效三元组"**：`sessionActive ?? settings.active` 是唯一口径，`hasKey`、右栏上下文窗口分母、助手名称栏回退值都必须按它算，否则会出现"绑了没 key 的提供商、输入框还可用"这类不一致。
- **并发会话同树作业是常态**：跑 E2E/构建前先确认 8290/3810 无占用（`Get-NetTCPConnection`）且没有他人在途改动。`reuseExistingServer: false` 下撞端口会响亮失败，但 `data/e2e-*` 会互踩；全量 E2E 出现轮间不一致时先隔离复跑再归因。多代理并行时只让代理跑 `tsc --noEmit` / `compileall`，构建与全量 E2E 由主代理串行跑。
- **`getByRole` 的 `name` 默认是子串匹配**：同页两个可访问名互为子串即 strict violation（"1. 分层模型与封装" vs "…（图谱节点）"踩过）。同理能力复选框标签改"工具调用（Agent 循环）"后 `settings-models.spec.ts` 必须同步。
- **`toBeHidden()` 要求单一匹配**（本轮踩过）：对"多个 `tool-card`"断言 `toBeHidden()` 会因 strict violation 失败（不是"可见"）。折叠态断言改用 `toHaveAttribute("open", "")` + 单元素可见性。
- **`panel.locator("summary")` 会命中内嵌 `<details>` 的 summary**（本轮踩过）：工具卡自身也是 `<details>`。外层折叠区一律用 `getByTestId("process-summary")`。
- **会话标题会与消息正文撞词**（本轮踩过）：首条用户消息会变成会话标题，"改后文本归 0"这类断言必须限定在 `chat-messages` 内（会话标题仍留在左侧边栏）。
- **`<details>` 默认收起 + 内容保持挂载**：`process-panel` 内的思维链/工具卡 DOM 一直在（`toHaveCount` 不受收起影响），只有可见性变。断言工具卡数量不要求先展开，断言**可见**才要求。
- **工具卡常显、`process-panel` 可能整块不渲染（第八轮）**：工具卡已移出折叠区、直接挂在助手消息体；`ProcessPanel` 只在有思维链或有提示时渲染 ⇒ 纯工具场景（如 `tools` fixture）`process-panel` count 为 0。断言工具卡不要先展开折叠区；`tool-cards.spec` 已按新口径改写。
- **`/courses` 不带 `?subject=` 现在是「我的课程」首页（第八轮）**：只内嵌工作区主页 iframe、没有右栏/图谱/节点详情。要测图谱或选节点**必须显式带 `?subject=<slug>`**（`subject-switch` / `theme-visual-inspection` 已改）。
- **工作区主页 iframe 的主题走 `?theme=`（第八轮）**：`HomeEmbed` 给 `/api/home/index.html?theme=<dark|light>`，生成页 `learn-theme.js` 认该参数且**不写学生偏好**；宿主用 `MutationObserver` 观察 `<html data-theme>` 跟随 web 主题。首帧统一 light（SSR 一致）挂载后再对齐。
- **模型读不到的文件必须内联进派工值（第八轮实锤）**：工具循环沙箱读根只有草稿目录，仓库根 `schemas/curriculum.schema.json` 模型自己读不到——派工值里只写"以该文件为准"等于让它盲猜（实测门禁连打回 3 次）。凡"下游模型要引用的规格"都内联全文。
- **落点确认要带 `session_id` 才会自动关联（第八轮）**：`promote` 成功后后端把触发会话绑到新科目（草稿 slug = 科目 slug）；不带就"建完课会话没关联"，聊天里也不会出现产课/评估工具。
- **工具/loop 相关**：`stream_turn` 在 fixture 模式只吐纯文本，工具脚本在 `agent.FIXTURE_TOOL_SCRIPTS`（场景 `tools` / `process`）；E2E 经 `page.route` 改写请求体加 `fixture_scenario`，不在生产 UI 开入口。
- **审计 contextvar**：`audit.bind(key)` 必须在 `asyncio.create_task` **之前**调用（子任务创建时继承上下文）；生产链在 `run_build`/`run_produce` 内绑定。审计写失败只告警不阻断。
- **消息下标口径**：前端消息数组与服务端会话消息数组按序 1:1（编排卡 stage/handoff/done 也会落库），编辑/删除传本地下标即服务端下标。若将来出现"前端本地消息不落库"的新类型，这套下标契约会破。
- **NodeDetail 在课程页主区**（`getByTestId("course-node-detail")`）；**大纲与图谱都在右栏做「图谱（默认）/ 大纲」分段切换**（`rail-view-graph` / `rail-view-outline`），sr-only 图谱按钮 `graph-node-<id>` 与大纲行 `outline-node-<id>` 并存但后者默认 `hidden` —— **测试里要点大纲行必须先用 `helpers.openNodeDetail`（它先切「大纲」段）**。
- **`<canvas>` 数量不是 1**：cytoscape 会给一个容器铺 **3 层 canvas**。断言"画布存在/未重建"不要写 `toHaveCount(1)`——用"先打标记、切视图后标记仍在 + 层数不变"。
- **画布容器的 effect 依赖要用 state 而不是 `useRef.current`**：页面还在 early-return 分支时容器没挂载，`getCourse` 可能先于 `subjectsReady`/`loading` 翻转而那次提交里 `elements` 已非空，ref 型依赖不会重跑 ⇒ 图谱永远不建（表现：容器在、0 canvas、**控制台无报错**）。可折叠面板/条件渲染的容器一律用 `ref={setState}` 模式。
- **新对话关联行只在新对话态存在**：`sessionId === null` 才渲染，发出首条消息即隐藏；`helpers.associateSubject` 已改为直连关联行、不再展开右栏。
- **右栏内容缩水后 role 型断言会静默失配**：`生成小结`、右栏 `关联科目` 下拉、`memory-entry` 都没了；右栏在新对话态**默认折叠**（`inert` + `aria-hidden`）——断言前先 `expandRightRail(page)`。
- **会话级工作区是请求级 ContextVar**：`bind()` 必须在 SSE 生成器迭代期重挂（StreamingResponse 在别的任务里迭代）；同步端点跑在 anyio 线程池（context 会被拷贝）。要扩展工作区相关能力时**只改 `curriculum_store.workspace_dir()` 这一处**。
- **编辑重发要连附件一起想**：`replace_from` 先截断再追加，附件解析**先查 pending 再查会话目录**（复用），清理时跳过 `keep_ids`；三者顺序错了会丢附件或留孤儿文件（`test_message_actions.py` 覆盖）。
- **网关用量不用主动要**：本机 new-api 默认在末块带 `usage`；主动发 `stream_options` 反而可能被上游 400 拒。思维链字段名是 `delta.reasoning_content`（探针实测）。
- **ZCode 是开源项目**（`github.com/zai-org/ZCode`）：设置页对齐它要**读源码**；本机 `~/.zcode/v2/config.json` 可读真实字段形态（注意脱敏）。
- **`<select>` 嵌在 `<label>` 里时定位一律 `getByRole("combobox")`**。
- **改了前端源码却"看不到改动"先查构建产物**：生产模式下 `.next` 是 `next build` 的快照，`next start` 不会编译——判断方法是对比 `.next\BUILD_ID` 的 mtime 与源码 mtime，或直接 `grep -rl "<新增的 data-testid>" frontend/.next/static`（命中 0 = 伺服的是旧代码）。现在 `start-web.bat` 会自动重建。
- **`start` 出去的服务不随启动器窗口退出**（按设计）：关服务要关「StudyMate 后端 / 前端」各自的窗口，或双击 `stop-web.bat`；从任务管理器强杀 wrapper 会留下占端口的孤儿。
- **PowerShell 参数里的逗号会被它自己吃掉**：`-Ports 8101,3800` 传到脚本里是单个数 `81013800` ⇒ 多值参数一律拆成独立整型/字符串参数。
- **爬进程父子链别逐级查 WMI**：先取一次全表在内存里走链。另外 `$pid` 是 PowerShell 只读自动变量，循环变量别用这名。
- **本机 VS 的 `LIB` 路径失效会让 `Add-Type` 直接报错**：写 PowerShell 探针要 P/Invoke 时先清 `LIB`/`INCLUDE`/`LIBPATH`，或改用 Python `ctypes`。
- Next 16：生产构建把 rewrites 代理目标固化进 `.next/routes-manifest.json`（改 `BACKEND_PORT` 必须重新 build）；`next.config.js` 的 `compress: false` 不能删（否则 gzip 缓冲 SSE）。
- Windows：curl 发中文 JSON 会 GBK 乱码，用 UTF-8 临时文件 + `--data-binary @file`；YAML 落盘是 CRLF（断言正则写 `\r?\n`）。
- E2E 顺序依赖（`workers: 1` + 文件名字母序；settings-providers 会把 active 切到无 key 项）；globalSetup 每轮重建 `data/e2e-ws` 与 `data/e2e-data`；E2E 后端 env 两个都要给（`STUDYMATE_CONFIG` + `STUDYMATE_DATA_DIR`）。
- **"加载完成回填输入框"别无条件做**：回填只做一次，否则并发/StrictMode 下覆盖用户刚填的值。
- **Windows 注册表系统代理会经手本机网关**：`llm.py` 已按 host 精确挂直连 mounts；换机器复现"长流必挂"先查这条。
- **长派工时间口径**：`REQUEST_TIMEOUT` 900s（`STUDYMATE_LLM_TIMEOUT` 可调）；mimo-medium 单次课件派工 694s。
- **TestClient 不增量吐 SSE**：整条响应结束才一次性交付；判断在途状态看磁盘产物 + `Get-NetTCPConnection -OwningProcess <pid>`。
- **根 `npm test` 的 CRLF 假红**：`test_antigravity_skills.mjs` 的 curriculum-designer 导出断言在 Windows 上必红（`.dsh/skills` CRLF 检出），Linux CI 不受影响；不要试图"修"它。
- 端口：后端 8101 / 前端 dev 3800 / 生产 3801 / E2E 8290 + 3810。venv 在 `backend/.venv`（Windows 为 `.venv/Scripts/python.exe`）。
- **启动/停止**：双击 `start-web.bat`（自动判定构建新鲜度、端口预检、就绪后自动关窗）；`stop-web.bat` 一键全停；端口可用 `SM_WEB_BACKEND_PORT` / `SM_WEB_FRONTEND_PORT` 覆盖；助手是 `tools/studymate-web.ps1`（纯 ASCII）。`.bat` 一律 GBK + CRLF（转换流程见 `windows-bat-encoding` 技能）。
- 嵌套残留 `study-mate-web/study-mate-web/`：本机已不存在。

## 环境事实

- Python 依赖在 `backend/.venv`；门禁 = `python -m pytest tests`（**152 条 + 1 skip**：1 条为 `SMOKE_REAL_LLM` 门控冒烟）+ `compileall` + `tsc --noEmit` + `npm run build` + E2E（frontend/，**62 条通过 + 3 条 skip（悬空占位）**；单轮全量 0 失败）。根 `npm test` 另跑根仓库测试（installer / openai / antigravity / release / static 五个子集，除 1 条既有 Windows CRLF 假红外全绿）。
- **组件测试层**（`npm run test:component`，vitest + Testing Library，**20 条**）**不进根门禁**，第四轮按现行 UI 重写、第五轮补 `cleanAssistantText`、第六轮补建课进度卡，**全绿**。
- **本机有真实 LLM 渠道**：`my-api` = 本机 new-api 中转 `http://localhost:4000/v1`，六模型（mimo-v2.6-flash 质量主力 / space-bunny-alpha 速度 / Deepseek-v4-flash 活跃默认 / agnes / muse-spark / u2-flash），均带思考档位（默认 medium）。冒烟口径：**串行不并发**、脚本自己钉死模型；**工具调用默认全模型开启**；门控冒烟命令：`SMOKE_REAL_LLM=1 SMOKE_MODEL=space-bunny-alpha .venv/Scripts/python.exe -m pytest tests/test_smoke_real_llm.py -s -q`（backend/ 下）。**注意 `Deepseek-v4-flash` 的档位名当前与网关不匹配（会 400，见 backlog #21）。**
- `docs/` 上游文档已按用途归位（使用/规范/设计/agents）；引用上游文档用新路径。
- 版本号 0.6.0-beta（`frontend/package.json` + `backend/app/main.py` + README「版本」节；侧边栏读 package.json 自动跟随；变更需维护者知会同意）。
- 运行时数据根在 `study-mate-web/data/`（settings、sessions、drafts、**audit**、uploads、exports）。

## 建议使用的 skills

- `grill-with-docs`：新取舍"该不该/做到哪一层"先盘一遍；决策落 `Web_CHANGE.md`（只追加）。
- `playwright-cli`：扩展/调试 E2E、录 trace、查并发端口占用。
- `github:issue` / `github:pr`：维护者指令下跟进 issue 或 PR #43。
- `handoff`：再次交接时生成新版本（**覆写本文**，保留"文档地图/已知坑/环境事实"三节结构）。
