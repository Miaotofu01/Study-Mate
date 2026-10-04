# K 系列尽调存档：DSH 与 DeepTutor 的工具化调用机制

> 性质：2026-10-04 两个只读调查代理的结论存档，供 K0 实施时内化；**只存结论与证据路径，不重复源码**。
> 事实源：`D:\deepseek-harness`（@deepseek-ai/dsh-root，即 Study-Mate 插件运行时本体）与 `D:\Local-projects\Study-Mate\DeepTutor`（Python 克隆）。调查时点 2026-10-04。
> 配套拍板见 `Web_CHANGE.md` 2026-10-04「工具化调用改造（K 系列）拍板」条目。

## 一、线协议（两家一致，照抄即用）

- 工具声明 = 标准 OpenAI function calling：`{name, description, parameters(JSON Schema)}`（DSH `packages/llm/llm/src/types.ts` ToolSchema；DeepTutor `deeptutor/core/tool_protocol.py` BaseTool→to_openai_schema）。
- **不发明自定义 wire 格式**：DSH 的私有线协议扩展（`docs/deepseek-llm-api-wire-extensions.md`）刻意避开工具与消息体，只做请求头/旁路状态。
- `tool_calls[].function.arguments` 端到端保持**原始 JSON 字符串**；工具结果回 `role:"tool"` + `tool_call_id` + 文本（空输出填 `(no output)`）；失败也以错误文本回填，**不抛异常炸循环**（DeepTutor tool_dispatch.py）。
- 流式聚合：按 wire `index` 建 block，`id`/`name` **赋值不追加**（有网关重复发 id 涨到 47k 字符被 400 的前例，DeepTutor tool_call_stream.py 注释 #937），`arguments` 拼接（DSH assembler.ts / llm-deepseek translate.ts）。
- 兼容降级（DeepTutor）：`tool_choice` 不支持→auto；整个 tools 被拒→去 tools 参数转文本协议；图片不支持→剥离重试。K0 至少要处理"tools 参数被拒"的回落。

## 二、Agent loop 形态

- 终止判据（两家一致）：**某轮 LLM 不再发起 tool_calls，其文本即最终答案**。
- 预算分层（DeepTutor，作 Web 起步值）：探索 8 轮（可配）+ 收尾 3 轮 + 强制无工具收尾 1 次；"只思考不行动"最多救 2 次；单轮 max_tokens 分探索/应答两档。
- DSH 无步数上限：改用 maxTokens + 每工具 timeoutMs（协作式）+ **重复调用提醒**（连续 3/5/8 次完全相同调用发提醒不阻断，`packages/guard/repeat-tool-reminder`）。Web 取"步数预算 + 重复检测提醒"折中。
- 一条 messages 跑到底；每轮把 assistant(tool_calls) + 全部 role:tool 结果按序追加后继续；中断的 tool_call 用 stub 结果补对（`complete_tool_results`），保证协议成对。
- LLM 传输失败：仅在尚未产出可见输出时重试；已可见则强制收尾/抛错（DeepTutor agent_loop.py:425-447）。
- 并行工具：DSH 按 barrier/parallel 分组 + 有界池（默认 10），结果**按模型顺序提交**。K0 先串行执行，并行留配置。

## 三、Skills（DSH 方式，Web 取折中）

- DSH：**目录常驻**（一条可替换消息，name + 截断 ≤500 字的 description；对 entries 取 sha256，变化整条替换）+ `skill(name)` 工具**每次重读盘**取全文 + `always: true` 才整文注入 + 用户 `/name` 直呼（`packages/skill/tool-skill/src/index.ts`）。
- Web 折中（K 系列不变量）：保留现有"按链路全文注入 SKILL.md"（拍板②），另加 `read_skill` 工具按需补充（K1 起）；不做 catalog 改造。

## 四、文件/命令边界（DSH 四层围栏的可移植子集）

- 相对路径以"会话工作区"为基准；**可写根 allow-list**（Web：草稿目录 + 科目目录；读：工作区 `.learning` + 仓库 `.dsh/skills`）。
- **写前当场重新 canonicalize**（resolve 到最深存在祖先再校验包含关系，返回该新 target 供写入）——消 check-here-write-there 的 TOCTOU（`packages/fs/fs-sandbox/src/index.ts` checkedTarget）。
- 拒绝返回**稳定的模型可读标记**（`[sandbox: file access denied under <mode> mode]` 风格），进 isError 结果。
- 加宽只有一条通道：模型请求（权限+理由成对）→ 人审批 → 仅此一次授予，fail-closed（`packages/sandbox/sandbox/src/escalation.ts`）。Web 的映射：越出 allow-list 的写入 → 质检工单/人工确认，不开放自由路径。
- 命令执行不经模型自由命令：`run_gate` 工具脚本路径固定白名单（check_curriculum / render_lesson / check_lesson / gen_home），超时 + 输出截断回吐。
- 上传文档不直接塞 prompt：小预览 manifest + `read_source` 全文工具（DeepTutor source_inventory 模式）——Web 附件体系已有对应物（附件注入 + 上限），保持。

## 五、结果截断 / 预算

- 每工具自带上限（read：2 万字符级 + 翻页；bash：64KB 输出 + 超时），溢出**完整副本落盘**并在结果里给 locator + 取回指引（DSH spill 策略）；通用 post-execute 兜底把超限文本换"头尾预览 + 提示"，提示自身字节预扣，绝不把成功变失败。
- Web 映射：`read_course_file` 单次上限 + 截断标注；门禁输出按行解析后截 20 条（已有 `_gate_problems` 先例）。

## 六、审计 / 可观测

- **事件流即审计**（DeepTutor）：同一份事件序列既推前端又持久化（SQLite turn_events，(turn_id, seq) 幂等、单调 seq 支持断线重放）；每轮结束打一行 jsonl（round/model/finish/tool_call_count）。
- 敏感参数在**工具声明处**标记（`sensitive: bool`），展示层统一剔除；服务端注入参数用 `_` 前缀约定不进展示。
- Web 映射（K0）：tool_call/tool_result/派工值/原始回复**追加写** `data/audit/<编排或会话id>.jsonl`（失败不清除，修 10-03 核实过的"堵点无文件证据"缺口）；SSE 加 `tool_call`/`tool_result` 事件，前端渲染可折叠工具卡（兼审计 UI）。

## 七、子代理（K4 参考）

- 形态 = **一个返回结构化结果的工具**：prompt 进 → 子代理最后一条非空 assistant 消息出；非 completed 即 isError 但保留部分输出（DSH `packages/subagent/tool-subagent`）。
- 后台/可续子代理（job id、notice 回传、冷恢复）是二期复杂度，先不做。
- Web 已有 `roles.dispatch_role`（无工具单次调用），K4 只需包一层工具外壳。

## 八、两份报告的"最小可抄清单"（原样保留）

DSH 侧：工具三件套（注册表白名单投影 / arguments 原始字符串 / role:tool 回传）；工具必须声明规范输出（output.schema + render）；turn→step 两层 while，**不要设最大步数**（用 maxTokens + 工具超时 + 重复提醒）；重试做成事件（对模型不可见）；skills 目录+按需；路径 allow-list + 当场 canonicalize；结果溢出 spill 全文 + locator；子代理先做前台 one-shot。

DeepTutor 侧：BaseTool 单源生成 schema；role:tool 失败回填不抛异常；三层预算；ToolCallAccumulator（id/name 赋值、args 拼接、provider 扩展字段保留）；每工具独立 call_id + call_state 终态（前端键控渲染的关键抽象）；skills 两级（manifest 一行 + read 全文 + always 逃生阀）；模型只见相对路径 + 服务端注入 root；事件流即审计。
