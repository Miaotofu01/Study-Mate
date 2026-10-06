# Web_CHANGE.md — StudyMate Web 计划与变更留痕

> 性质：**历史留痕档案**，只追加、不改写已有条目。记录已完成的旧计划、方案定稿与重要变更的"当时怎么想、做了什么"。
> 现行文档分工：开发与待实现计划见 [StudyMate-Web_开发与计划.md](StudyMate-Web_开发与计划.md)；
> 功能规格见 [StudyMate-Web_PRD.md](StudyMate-Web_PRD.md)；
> 测试流程见 [StudyMate-Web_E2E测试流程.md](StudyMate-Web_E2E测试流程.md)；运行与部署见 [README.md](README.md)。

---

## 归档与冻结线说明

- **冻结线位置**：**2026-10-04「第八轮」及其补充（`### 第八轮补充` / `### 第八轮补充二`）之后**（原文件第 845 行之后、`## 第九轮` 之前）。
- **归档文件**：[docs/archive/Web_CHANGE-2026-09~10-04.md](docs/archive/Web_CHANGE-2026-09~10-04.md)。
- **归档范围**：2026-09 末 ~ 2026-10-04 第八轮（含）的全部历史条目已**原文原样**迁入归档文件，标题文字、日期、正文均未改一字。
- **对照关系**：归档文件 = 冻结线及之前；本文件 = 冻结线之后的新条目（当前为「第九轮」「第九轮补充」「2026-10-05 · 全面审查轮」）。HANDOFF 与《开发与计划》里"见 Web_CHANGE 某轮 / 同日条目"的旧引用，按条目标题仍可在归档文件中检索到。

---

## 第九轮：交付（版本升级 + 一次性提交 + PR 转正式）

- **版本号 0.5.0-beta → 0.6.0-beta**：`frontend/package.json`、`frontend/package-lock.json`（两处）、
  `backend/app/main.py`（FastAPI `version`）、`README.md`「版本」节、`StudyMate-Web_开发与计划.md` §1 标题、
  `HANDOFF.md`（3 处）。侧边栏读 `package.json` 自动跟随（build 期打包，故首次需重新构建）。
  PRD 正文按约定不写版本号。
- **交付形态**：本轮按维护者指示把第三～九轮的累计改动**一次性提交**（不再按里程碑拆分），推送 fork
  分支 `feat/study-mate-web`；PR #43（→ 上游 `main`）由占位 draft 转为**正式待 review**。
- **交付前的验收记录（同一次运行）**：后端 pytest **152 通过 + 1 skip**；E2E **62 通过 + 3 skip（0 失败）**；
  组件测试 **20 通过**；`tsc --noEmit` 干净；`npm run build` 通过；根 `npm test` **75 通过 + 1 条既有
  Windows CRLF 假红**（`.dsh/skills/curriculum-designer` 技能导出断言，Linux CI 不受影响）。
- **真机核验（同一构建）**：`/api/home` 服务主页与其相对资源、越界被拒；「我的课程」内嵌主页且无右栏、
  带 `?subject=` 仍是原课程页；聊天右栏三个页签可切、标签 77px 不截断；已落盘会话里「确认建课」/「落点确认」
  两个按钮均为禁用；建课链真机 685s 跑通、产课/评估工具旅程由 E2E 覆盖。

### 第九轮补充：并入 upstream/main（v1.0.0）解掉 PR 冲突

- **为什么**：PR #43 被 GitHub 标为 `CONFLICTING`。经核，冲突面只有根 `README.md`——上游把那份内联目录树
  换成了指向《工程约束 §二 目录与规则归属》与《文件归属》的指针（"同一事实只留一处"），本分支此前在那份树里
  加过 `study-mate-web` 两行。解决：取上游的指针写法，另补一句说明子项目自包含、结构与归属看它自己的 README。
- **合并带入的上游改动**：v1.0.0 发布链与 release 元数据恢复、7 个角色 `SKILL.md`、`schemas/`、
  `scripts/`（`gen_home.py` / `check_curriculum.py` / `check_lesson.py` / `check_skill.py` 等）与 `.github/` 模板，
  共 35 个被复用的引擎文件。子项目对引擎只读复用，故合并后**重跑全套门禁**：后端 pytest 152+1skip、
  E2E 62+3skip（0 失败）、组件 20、tsc/build 通过，**根 `npm test` 77 条全绿**。
- **一个长期误报消失了**：根门禁里那条"Windows CRLF 假红"（curriculum-designer 导出断言）随上游那份
  `SKILL.md` 一并更新而消失；HANDOFF 的「已知坑」已改为"已消失 + 别把 only-fetch-branch 导致的
  release 元数据比对照当成真红"。
- **给上游维护者的建议**：`docs/规范/文件归属.md` 目前没有 `study-mate-web/` 这一行，而 README 的目录说明
  已经改成指向它——建议合并本 PR 时在该表补一行，让"唯一出处"真正覆盖子项目。

---

## 2026-10-05 · 全面审查轮（已完成）

> 性质：对 `study-mate-web/` 的一次全面审查（八域：LLM/agent、chat/storage/config/uploads、课程仓储/工作区、build/produce/draft/tickets、聊天前端、非聊天前端、安全、测试部署）。主代理几乎不亲审改代码，由分组子代理实施修复，分歧优化交维护者裁定。**本条目只追加**，已完成定稿；**各组"新测试 N pass"为实施中途值，最终门禁以本节「最终验证」为准**。完整版见 `docs/archive/审查报告-2026-10-05.md`。

### 修复分组（实施经过；中途计数仅留痕）

> 以下各组括号内"N pass"为**实施中途值**，仅留痕；最终门禁见本节「最终验证」。

- **会话 / config 组**（`storage` / `common` / `config` / `chat` / `uploads` / `settings` router）：新增 `test_review_session_config.py` **25 pass**（含 session/list 附件 symlink 与坏 providers 形状，用例更强），`compileall` 过。修：session 路径 + symlink 守卫、`require_node` slug、图片误解析、settings temp + `os.replace` + RMW 锁（损坏原文件隔离副本）、空 `system_prompt` 显式保存 + `GET /api/settings` 只读 `default_system_prompt`、坏结构 session 列表容错、附件 `kind` 按扩展名、partial 措辞、附件 `>10`/重复/非法/失效预检（写前）、上传 `MAX+1` 限量读。
- **聊天组**（`ChatView` / `Composer` / `ModelSelector` / `RightSidebar`）：编排结束 / 落点确认后 `getSession` 回灌校正消息 `index`、停止 abort 编排、`reasoning`/tool-only 错误轮保留、build 补 `catch`、失效绑定回落、附件错误重试、F1–F5 补 epoch / sync 失败禁用与 retry / 每轮 resync。新增 `ReviewChatActions.test.tsx` **6 条** + 旧 9 条 = **15**；E2E 加"编辑 / 删除后 reload 持久化"断言。
- **工程 / 测试部署组**：`next.config.js` 支持 `STUDYMATE_NEXT_DIST`（默认 `.next`），E2E 用 `.next-e2e`、探索用 `.next-explorer`（**目录级隔离，非完全副本**；`next-env.d.ts` / `tsconfig` 仍会被 Next 改写），与本地 dev 隔离；后端 webServer 命令改按平台取 venv python（`BACKEND_PYTHON`）；`start-web.bat` Node 提示 18 → **20.9**；`chat-basic` stream 负断言改 SSE 响应协议断言。`--list` 过、套件未跑。**撤销**"pytest 草稿顺序依赖"误报（最小复现证伪，未改旧后端测试）。
- **模型组**（`llm` / `multimodal` / `tools` / `roles`）：OpenAI 客户端生命周期（降级 `aclose`）、SDK tool 拒绝回落、httpx/`ProviderError` 重试、Anthropic 相邻 role 合并、`tools=false` 禁止 yield 工具、`delta` 列表归一、Windows drive-relative/ADS/UNC 路径 + 最终 containment。新增 `test_review_agent_llm`（中途值）等。
- **非聊天前端组**：完整 workspace 透传、概念本清空 node / follow_up 生效、异步切换请求序号、不吞下一条草稿、默认 prompt 走后端元字段、工单 workspace。新增 `review-workspace.test.tsx` **14 pass**，`tsc` 过。
- **数据后端组**：YAML 原子 `RLock` + `progress_transaction`、memory / 误解原子 + CRUD 锁、memory 不存在 session 404、全部科目端点贯串 workspace、坏 YAML 容错；新增 **workspace 前缀只读资源路由** `/api/workspace-files/{token}/courses/{slug}/files/{path}`、`.../courses/assets/{path}`、`.../home/index.html`（token = base64url(UTF-8 绝对路径) 无 padding，**委托既有 lessons/home handler**，不是通用读盘）。新增 `test_review_workspace_data` **14 pass** + 相关 **32**；前后端对齐，含多层 HTML/CSS/font/image 相对资源回归。
- **生产组**：draft guard + 路由 404、`recheck` 按 `ok` 判、非零无解析补错误原文、落点后 build retry 不复活草稿、交付 required 产物齐全才 promote、retry 早退回待处理、persist 失败不再阻断 SSE sentinel、显式 workspace/SSE 绑定 + ticket 归属过滤（旧记录兼容）、records 序号锁与 Unicode 坏文件跳过、tickets 原子 RMW 坏文件留证、同名资料去重、DNS `to_thread`、独立 stage node-uuid、build 重跑保已有 progress、export 暂存成功后替换保旧。新增 `test_review_production`（中途值）；独立最终 ACCEPT 3 项（层级 / legacy draft / 无归属旧单不误写）。

### 安全独立复验（未整改项须并列）

- 复验通过：import 恢复；`review_session_config` + `review_agent_llm` **51 passed**；symlink / 附件 canonicalize / `draft` 非法 slug 拒绝 / 新 `workspace_files` 坏 token 与 traversal 阻断均过，原 handler 委托无新增越界。
- **高优先未整改**：本地信任模型下 `workspace` 可指向任意已存在绝对目录；`GET /api/home/settings.json?workspace=<临时 data 目录>` 与新 token `.../home/settings.json` 都能读到模拟 settings key（临时证据，无真实文件）→ **LAN 访问整 API 可能读到当前进程可读的任意本机文件，不只学习数据**；新 token 能力与旧 API 等价、不新扩大，**base64 不能当鉴权**。**未加鉴权前不可宣称可公开部署。**

### 最终验证与结论（02:12 白名单快照）

- **门禁**：根 `npm test` **0 失败**；组件 **44 pass（7 文件）**；`tsc` **0**；真仓库默认 `.next` `npm run build` **0（14 路由）**；后端 pytest **242 pass + 1 skip**（唯一 skip = `tests/test_smoke_real_llm.py:69 test_tool_loop_against_real_provider`，`SMOKE_REAL_LLM!=1` 门控）；`compileall` / `import app.main` **0 / 0**；E2E **68 = 65 pass + 3 skip（0 失败）**（skip 为 `memory-flow` 2 + `session-summary` 1 悬空占位）；定向 5 条 E2E 通过。**lint 仍基线既有 exit 1**（Next 16 移除 `next lint`、无 ESLint），**故不称"所有检查全绿"**。
- **过程已闭环**：中途快照的 1 临时探针 fail（源已删、最终套件不含）与 3 E2E fail（临时卡断言撞合法文本 1 + 旧 `chat-draft` 回归 2）均已修复并重跑通过，过程数不再列。
- **独立复审（已完成）**：安全组完整复验无新 bug；LLM + config ACCEPT；聊天 F1/F3/F4/F5 闭环、F2 持久化断言对；workspace 复审发现的 `produce` 建 ticket workspace 少一级 `WS/.learning` 已补修；生产组独立最终 ACCEPT 3 项。**但 legacy 工单完整恢复流程未实现**（歧义旧单 `abandon` 亦 409、暂缺关单 / claim / 清理 UX；详情 ambiguity 标记不一致），**不得宣称所有旧单操作完整恢复**（见报告 R10，待决策、不再扩实施）。
- **待用户决策（R1–R10，含推荐，详见报告 §4）**：R1 鉴权 / 来源 / 监听边界（未整改前不可宣称可公开部署）；R2/R8 并发策略；R3 lint；R4 CI；R5 端口文档；R6 视觉可选；R7 `display_content`；R9 quick-edit 白名单；R10 legacy 恢复流程。
- **文档同步**：PRD §6 / §9、开发与计划 §1.2 / §1.3 增新契约与口径；E2E 流程升 **v2.5**（`distDir` 隔离 / 跨平台命令 / Node 提示 / 映射新增 review-workspace·review-chat-actions）；README 增「部署边界」并纠正陈旧计数；探索测试指南补 explorer `distDir` / `BACKEND_PYTHON`；本报告见 `docs/archive/审查报告-2026-10-05.md`。

---

## 追加区（今后新条目）

> 今后新条目一律追加在本节之下；不改写上方冻结线说明与历史条目，也不回改归档文件。

---

## 2026-10-05 · 决策轮（R1–R10 裁定；APP 侧源码冻结，E2E 全绿）

> 性质：维护者对全面审查轮遗留 R1–R10 的裁定与口头口径留痕（**只追加**，不改写上方「全面审查轮」的 R 待决策历史）。
> R1 维持本地个人使用、不扩安全；R3/R4/R10 仅解释不实施；R5/R9 未选不动；R2+R8 / R6 / R7 已完成并经独立 review ACCEPT，**APP 侧源码冻结**；**E2E 已复跑全绿：70 = 67 pass + 3 skip（0 失败）**。门禁数不沿用上一轮 242 / 44 / 65+3 等旧计数。

- **R1（鉴权 / 来源 / 监听边界）——裁定：只本地个人用，本轮不做过多防御。** 明确本运行时按「单机本地个人使用」定位；**本轮不新增** token / 来源白名单 / 监听绑定改造。README「部署边界」相应改为「本机个人用」口径；对外 / 多用户诉求留作后续再议（**不等于**已具备公网部署能力，安全边界事实见归档报告）。
- **R2 + R8（并发策略）——裁定：先拒绝（已实现；独立 review F1–F5 ACCEPT）。** 单进程 **reject-only 注册表**：同键（`session` + 解析后的 base / node 工作区，区分工作区）冲突立即 409，**不排队、不合并**；chat / production **在落任何消息前即 409（无孤儿 session）**；编辑 / 删除短占锁；产课工具冲突回**明确 tool error**；快改 / 复检与产课**同键互斥**；正常 / 取消 / 异常路径均释放锁。F1–F4 修复：**Lease 用 owner-token 一次释放**（消 double-release ABA 误释）、**产课冲突先拒再建 session**、草稿 `promote` / `delete` / `material` **同 key 守卫**、`delete_turn` **锁后读**。测试 **concurrency 21 pass**。
- **R6（视觉可选）——裁定：补 `shadow-xs`（已实施，事实已核）。** 仅在 `frontend/tailwind.config.ts` 集中补 `xs: "0 1px 2px 0 rgba(0, 0, 0, 0.05)"`；真实 Tailwind 编译探针产出 `.shadow-xs`，`tsc` 0；**不重做视觉 / 美化**（组件内既有 `shadow-xs` 类从此生效）。
- **R7（展示文本分离）——裁定：可做 `display_content` 分离（已实现，F ACCEPT）。** `storage.add_message` 新增可选 `display_content`：**`None` 不写字段、空串保留为合法原文**；会话标题按「`display_content` 原文 → 附件文件名 → 默认」取名、**不回退展开后的 `content`**；chat 用户消息 `content = effective_text`（送模型，含附件解析）、`display_content = payload.message`，LLM 侧仍读 `content`；`ChatView` 用户气泡 / 复制 / 编辑 / 记入概念本统一取 `.display_content ?? content`，**旧消息无该字段按 `content` 兜底、不做数据迁移**；**附件-only 空文本编辑可重发**（原待修已修）。测试：后端 `test_review_display_content.py` **12 pass**；组件 `DisplayContent.test.tsx` **3 pass**（组件层共 **48 pass / 8 文件**）；E2E `display-content.spec.ts` **2 条已通过**。功能契约见 PRD §5.5。
- **R3（lint）/ R4（CI）——只澄清口径，不实施。** 事实：`package.json` 仍是 `next lint` 且**无 ESLint**（Next 16 已移除 `next lint`，故该步为基线既有失败）——维护者**仅问含义，本轮未安装 ESLint、未改脚本**。**R4**：根 `npm test` / 根 CI **不覆盖 Web 子项目**，Web 门禁当前靠手动跑；本地个人使用场景下可暂缓。人话口径：**lint = 静态规则检查**（不运行程序，按规则扫源码风格 / 明显错误）；**CI = 推送后在服务器自动跑检查 / 测试**（把本地门禁搬到远端自动执行）；**dependency lock = 锁定依赖版本文件**（记录每个依赖确切版本，使他机 / 他人装出同一套依赖、结果可复现）。三层不同：lint 是「检查什么」、CI 是「何时 / 在哪自动跑」、lock 是「依赖是否可复现」。**不实施、不开 issue。**
- **R10（legacy 工单恢复）——只澄清缺口，不实施（本轮不动工单）。** 受影响的是**归属不明的旧单**：缺**统一列表可见性**与**归属未确认提示**（前端未消费 `workspace_ambiguous`，且与 `base_dir` 类型不符）、**确认归属并持久化**的入口、**仅状态放弃 / 关闭清理**入口、带 `workspace` 与不带 `workspace` 时**详情标记统一**。**新工单，以及归属可判定的旧单**，现有**重试 / 复检 / 快改**均已可用——**不要泛称所有旧单都坏**。**不扩实施、不开 issue。**
- **本轮验收（APP 侧，源码冻结；E2E 已复跑）**：后端 pytest **275 pass + 1 skip**（唯一 skip = realLLM 门控）；组件 **48 pass（8 文件）**；`tsc` / `compileall` / `import app.main` / `build`（真仓库默认 `.next`，14 路由）/ 根 `npm test` 全 **0**；**E2E 70 = 67 pass + 3 skip（0 失败）**（skip 为 `memory-flow` 2 + `session-summary` 1 悬空占位；此前 2 处纯 test 定位问题已修并复跑通过）；定向 **concurrency 21** / **display 12** 通过，`display-content` **2 条**通过。**lint 未动，仍为基线既有问题**（R3，见上）。
- **未变约束**：任何 commit / push / tag 仍须维护者明确同意；本条不提交。

---

## 2026-10-05 · 最小工程化与 legacy 工单恢复（已定稿）

> 性质：维护者对本轮最小工程化的**裁定与全部回报留痕**（**只追加**，不改写上方历史）。本轮实现由 agent 分工落地——配置（CI）/ 后端工单（tickets）/ 前端 UI；**本条目为定稿：所有门禁数为验证员终值；远端 CI 未执行故不写 GitHub 通过**。任何 commit / push / tag 仍须维护者明确同意；本条不提交。

- **「个人使用」口径纠正**：「本机个人使用」指**每个项目使用者各自在本机单人使用**（所有用户皆此定位），**不是"仅维护者自用"**；该定位**不等于放弃工程质量保障**——本地单人使用同样要可复现依赖、可自动执行的检查与 lint，否则只有本机能跑、他人不可复现。本轮**不新增多租户 / 账号身份体系**（与《开发与计划》§5.2「明确不做」一致；R1 安全边界结论不变）。
- **最小 ESLint + 独立 Web CI（工程 owner 已实施；验证员已复验）**：ESLint **9.39.4** + `eslint-config-next` **16.3.8**；`lint` **exit 0 / 0 errors / 41 warnings**（3 条 React Compiler 现有大规模诊断**降为 warning**，hooks 正确性规则**保留 error**）。根 `.github/workflows/` 新增**独立 web-ci**（**Node 24 / Python 3.13**），覆盖 **pytest / compileall / lint / component / build + 5 条 E2E smoke**（**CI 只跑这 5 条 smoke，非 full E2E 回归**）；**原根 CI 不动**。**远端未 push / 工作流未在 GitHub 执行，故不得写"CI / GitHub 通过"**。详细门禁结果见下条「验证员复验」；配置 / CI 由配置 owner 负责；本轮未触碰根 `README.md` / `CHANGELOG.md`。
- **legacy 工单最小恢复（后端 + 前端均已交付；独立复验 ACCEPT）**：**语义**——① 缺 `workspace` 的**旧非 draft 单一律判 unknown**（**含与默认工作区同名者**；**不再用 `legacy_default` 猜测归属**），**`legacy_draft` 全局例外**；② list 带 `include_unscoped=true` **可额外列出全部 unknown（绕过 slug 过滤）**便于定位、删除与清理，**owned-other 不泄露**；③ detail 统一 `ownership` / `workspace_ambiguous` / `base_dir`（unknown 为 `null`）；④ claim 带 `{workspace}` **校验真实目录 / 科目 / node 后持久化归属、不限候选**，**已 owned 同目标幂等、closed 不复活**；⑤ abandon unknown **status-only + reason、不触产物**；⑥ **`concurrency.ticket_key` 租约覆盖执行 / 确认 / 放弃**避免 race；⑦ **新单与归属可判定旧单行为不变**。**后端**：`tickets` / `production` / `models` / `concurrency.ticket_key`，定向 `test_legacy_ticket_recovery`。**前端（已交付冻结）**：科目头部质检工单列表**覆盖无 node 单**；`CourseGraphView` 默认「我的课程」/ 零科目下也有 **global「待归属」条并显示原 slug**（该入口 `include_unscoped=true`）；unknown 弹窗给**候选 + 可手输、须显式确认**（**确认前禁产物读 / 改**；无确认输入**不自动选**；abandon 仅状态）；确认后**持久化归属、reload 并保持 modal**；统一标记 `type` 可空，节点 / 聊天既有入口复用；新组件 `LegacyTicketRecovery`（组件测试 **7**，组件层共 **55**）；E2E 新增 `legacy-ticket-recovery`（**2 条**：认领 B 仅 B 可改、A 不变；孤儿放弃产物不变），旧 inspection seed 补 `workspace`。**独立 review 补修**：`unscoped unknown` 写入绕过（旧 helper `boundNone` 早 return）——现 **unknown 无 query 也 409**、**owned / draft 无 query 兼容**，并新增真回归。legacy 主流 UI / claim 并发 / 放弃 **ACCEPT**；后端最终 **285 + 1 skip**（含 P1 修复）。
- **验证员复验（定稿）**：`lint` exit 0 / **0 errors / 41 warnings**（**警告保留待后续，不称零警告**）；组件 **55 pass（9 文件）**；`tsc` 0；`compileall` / `import` 0；真仓库默认 `.next` `build` 0（**14 路由**，`next-env.d.ts` / `tsconfig` **未被污染**）；**全 E2E 72 = 69 pass + 3 skip（0 失败）**；CI **smoke 5 pass**（**非全量回归**）；**定向 tickets 3 pass**；根 `npm test` 0。**后端 pytest 285 + 1 skip**（唯一 skip = realLLM 门控；含 P1 修复与 unscoped unknown 写绕过真回归）——**独立 legacy P1 复验 ACCEPT，无残留**。legacy 主流 UI / claim 并发 / 放弃均 ACCEPT。
- **已同步**：上述事实已回填 PRD §13.2 状态、开发与计划 §5 #34/#35、E2E 顶部与 §5 当前总数（72）、README 质量段；**旧 Web_CHANGE 历史条目与 archive / HANDOFF 未动，版本未升**。

---

## 2026-10-05 · 会话流生命周期与有序工具卡（已定稿）

> 性质：本轮修复的口径与结果留痕（**只追加**，**已定稿**）。实现、独立 review 与最终门禁均已完成，下列为最终结果（**唯一隔离副本**）。任何 commit / push / tag 须维护者明确同意；本条不提交。

- **现象**：会话「从这个科目开始学习」编辑重发「请继续」，助手工具调用 / 正文出现后切到另一会话再切回，本轮被中途 abort、流式增量丢失（**真机会话仅只读确认**该中断记录：首轮 `produce_lesson` 停在 `status:"running"`，末条 notice「本轮输出过程中连接中断，这里只保存了已经产出的部分」；**未编辑 / 未重发真实会话、未跑真实 LLM**）。
- **修复方向**：流独立于 `ChatView` 挂载、按 `session_id` 存活；切会话 / 离开 `/chat` **不 abort**，**仅显式「停止」才 abort，且只中止当前会话**。
- **前端契约**：`frontend/lib/chatStream.ts` 按 `session_id` 持有流；助手消息有序 `parts`——`{type:"text"|"reasoning"|"notice", text}` 与 `{type:"tool", tool_id}`，工具结果按 `tool_id` **原位更新** `tools[]`、不新增片段；**合并规则：前端只有相邻同类 `text`/`reasoning` 合并，`notice` 前后端一致各自独立、不合并**；**只有 notice 不创建空助手消息**；片段表头 `reasoning`「正在思考…」/「中间过程 · 思考」、`notice`「中间过程 · 提示」，**「N 次工具调用」仅旧 legacy 整块保留、新片段不显示**；内部标记跨 part 整体隐藏；旧消息无 `parts` 回落旧布局（`content`/`reasoning`/`tools`），**无法反推顺序、不做迁移**。
- **过程折叠语义调整（既有用例改动，计数不变）**：`fixture_scenario=process` 下思维链**按片段各自一个 `process-panel`**、按流位置夹在工具卡之间，**展开其一不影响其它**；工具卡**按流位置常显**在消息体；`assistant-parts` 的 `data-part-type` 序断言为 `reasoning/tool/reasoning/tool/reasoning/text`。已同步 PRD §5.5 与 E2E §3 映射 / §4.6 明细；`message-actions.spec.ts` 仍 1 条。
- **后端契约**：每轮固定 `turn_id` **原位 upsert**（不重复追加、下标稳定）；`stream_state ∈ {streaming, completed, interrupted, error}`；工具边界立即落盘、正文 / 思维链按约 0.6s 节流、静默期约 3s SSE 注释心跳；`GET /api/sessions/{id}` 回 `streaming`，停止 / **重载轮询最多约 10s**、超时给**可重试同步错误**（不静默，**不承诺硬刷新续跑**）；**中断工具的结果文案为「本轮在工具返回前结束，结果未收到」**。
- **边界（明说）**：刷新 / 关闭浏览器**不保证**本轮继续；后台续流仅覆盖**当前页面应用生命周期内**的切换（切会话 / 切路由 / 回 `/chat`），**不等于服务端脱离页面继续跑**；重载只见**已落盘片段**。
- **结果（最终门禁 · 唯一隔离副本 · 端口 13810 / 18290）**：后端 **309 pass + 1 skip**（唯一 skip = 真实模型未启用；`test_chat_parts` **20 条**）、组件 **85 pass（13 文件）**（新增 `ChatStreamLifecycle.test.tsx` 13 条 / `MessageParts.test.tsx` 9 条）、E2E **77 = 74 pass + 3 skip**（skip = `memory-flow` 2 + `session-summary` 1，悬空占位）、lint **0 error / 51 warnings**、`tsc` / `build` / `compileall` / `import` / 根 `npm test` 均通过；负对照：旧「切走即停止」实现 **2 fail**、还原后 **2 pass**。
- **验证边界（明说）**：所有 build / E2E 均在**唯一隔离副本**（端口 **13810 / 18290**）；最终含 peer 运行指示的源码快照与 live **逐字节一致**（仅副本的 **4 个端口文件**刻意差异）。**生产服务仍未重启**、**未写在用 `.next`（未重构建）**——源码变更已完成，但运行中的旧生产实例**未部署**。并行会话新加的 sidebar 转圈 / `Loader2` 等**不属本轮功能变更**，不计入本条。
- **文档落点**：PRD §5.5（过程折叠语义）+ §5.6（实施状态总览新增行，标「已实施」）、开发与计划 §1.3 + §5 backlog #37、E2E 流程 §2.3 P4 / §3 映射 / §4 索引 / §5 计数口径、README 功能规格。
- **未动 / 未做**：根 `README.md`、`CHANGELOG.md`、版本号未动；`HANDOFF.md`、`archive/`（含原审查报告）未恢复未改写；**真实目标会话仅只读确认中断记录**（未编辑 / 未重发真实会话、未跑真实 LLM），未 commit / push。

---

## 2026-10-05 · 第四轮 UI（侧栏折叠 / 右栏双栏 / 开场填充 / 建课工具切入 / 运行指示；已落地）

> 性质：维护者 4 条 UI 调整的核对-拍板-实施留痕（**只追加**）。逐条先核对现状（含 fixture 前后端 + 浏览器实机复现）再经维护者拍板实施；**与「会话流生命周期」轮并行实施、文件面有交叠但改动正交**（该轮定稿条目已注明 peer 的 sidebar 转圈 / `Loader2` 不属其功能面）。任何 commit / push 须维护者明确同意；本条不提交。

- **① 侧栏会话/科目区块可折叠 + 会话历史上限（取 5）**：`Sidebar.tsx` 两个区块标题改为 chevron 折叠钮（界面态不持久化）；会话默认只显最近 **5** 条，更多收进「展开历史会话（还有 n 条）」/「收起历史会话」，**活动会话即使排在 5 条之外也强制保留**（选中态不藏）。科目区不再被会话条目挤出视口。
- **② 聊天右栏「图谱与大纲」同屏双栏**：`SubjectGraphPanel` 新增 `layout="stacked"`（大纲在上、图谱在下，中间横向手柄拖拽调占比）；占比经新增 `useSplitRatio`（`useResizable.ts`，15–85% 钳制 + localStorage 持久化，键 `studymate-chat-rail-graph-split`）管理；容器从固定 `h-80` 改为**占满右栏选项卡以下剩余空间**（维护者裁定固定高度有问题）。课程页右栏保持分段切换不变（`layout="segmented"` 默认值）；cytoscape 画布尺寸变化沿用既有 ResizeObserver + delayed fit，拖拽跟手已验证。
- **③ 开场选项改填充 + 智能体可切入建课**：开场选项（含探索入口）点击**只把文本填进输入框**（`Composer` 新增 `fillHandle` 命令句柄，走会话草稿缓存并聚焦），不再直接发送；后端新增 chat 基础工具 **`start_course_interview`**（`tools.py`，入 `CHAT_TOOLS`）——普通会话里智能体可把会话切进建课模式（落库 `mode=interview`；已绑科目拒绝、重复调用幂等）；**盘问收口判定改用「本轮结束时的会话模式」**（`chat.py` `_current_session_mode`），同一轮切模式 + 当场收口（一句话给足信息）也能建草稿。`interview` 新会话直接入口（payload `mode`）保留不动。E2E 建课旅程改为：首轮经 API 带 `interview_switch` 场景（测试专用参数）驱动，其后走 UI。
- **④ 切页后恢复活动会话**：实机复现确认「切到其他界面再回来主区回新对话空态、侧栏却高亮旧会话」为真 bug（会话条目本身正常建立，两种时序均验证）；修复为 ChatView 挂载时 `activeSessionId` 非空且无 `loadedSession` 即自动 `openSession` 恢复（**会话已被删静默失败，不兜底**——维护者拍板）。与并行轮的 chatRuns 存活机制叠加：页面应用生命周期内切走再回来，回复与流式状态一并恢复。
- **补充拍板 · 运行指示转圈**：正在产出回复 / 跑建课编排的会话，**侧栏条目左侧转圈**（`runningSessionId`：聊天流部分从 `chatStream.ts` 注册表按 `streaming` 推导（新增 `getStreamingChatRunSessionId`），建课编排由 ChatView 经 `setBuildingSessionId` 上报；切走不清理，该轮结束才归位）；**助手输出中的消息尾部闪烁光标改为转圈**（`assistant-streaming`；空内容占位仍是「转圈 + 正在思考」）。
- **测试**：后端 `test_chat_tools.py` 增 4 条（同轮切换+收口全链、未绑定会话开放该工具、绑科目拒绝且无副作用、幂等）；组件新增 `ChatRestoreAndFill.test.tsx`（填充不发送 / 手动发送 / 挂载恢复三态）、`SidebarHistoryCap.test.tsx`（上限+展开+区块折叠+转圈）；E2E 新增 `ui-round4.spec.ts` 3 条（切页恢复、侧栏上限、右栏双栏+拖拽），`course-build` / `review-chat-actions` / `chat-basic` 入口改造与计数见 E2E 流程文档。
- **验证（本副本，标准端口 3810/8290）**：后端 pytest **309 pass + 1 skip**；组件 **85 pass**；`tsc` 0；E2E **77 = 74 pass + 3 skip（0 失败）**；根 `npm test` 通过（结果见门禁）。版本号未动（与并行轮口径一致）。

---

## 2026-10-05 · 评估误解落盘字段错位修复（P1 bugfix）

> 性质：真机探测实锤的 P1 修复留痕（**只追加**，不改写上方历史）。任何 commit / push 须维护者明确同意；本条不提交。

- **现象**：评估通过后，评估链把发现的误解落盘到科目 `misconceptions.yaml` 与 `progress.yaml` 的 `misconceptions[]`，但字段全部错位——`topic` 是评估 LLM 自由发挥的顶层 `misconceptions` 字符串（真机出现「跨课程混淆：把 Python 报表自动化的『月报流程』误当作 Git 课程内容」这类与证据无关的编造），`question` 是评估题面，`misunderstanding` 被该题判分注记整段占用，`answer_summary` 也不是答案要点。语义完全不是"学生的误解记录"。
- **根因（以代码为准）**：`app/misconceptions.py` 的 `add_from_assessment` 硬映射——`topic` 逐字取 `assessment.misconceptions`（模型自由文本），并按 `topics` 顺序配 `questions`（**不看该题 verdict**，通过的题也会被配上），`misunderstanding := question.note`、`answer_summary := question.answer`；评估提示词又只让模型产出一个与题目脱钩的顶层 topic 列表，两处叠加导致编造 + 错位。
- **修复**：`add_from_assessment` 改为**只**对 `verdict` 为部分通过/不通过的题落一条，字段语义归位——`topic` 取该题自带的简短误解点（缺省回退题面）、`question` 取题面、`misunderstanding` 取学生作答原文（缺则写「会话中未作答」）、`answer_summary` 取判分注记里缺的要点；全通过不落条目。评估派工文案（`records.py`）改为每题带 `topic`（仅未通过题必写、须对上本题 note 的缺口），**不再**要求顶层 `misconceptions` 自由列表；评估通过是权威置位（节点/前置置位、学习记录、掌握度保留或上调）等既有语义一律不变。已有 `assessments/*.md` 记录不迁移、不改写，只影响新评估。
- **测试**：新增 `backend/tests/test_misconception_mapping.py` **6 条**——未通过题字段映射、全通过不落、topic 回退题面、缺失作答写「会话中未作答」、重复 topic 跳过、端点回归（忽略顶层编造的 `misconceptions`，只认未通过题自带的 topic）。后端 pytest **315 pass + 1 skip**（基线 309+1，新增 6；唯一 skip = realLLM 门控）。
- **文件**：`backend/app/misconceptions.py`、`backend/app/routers/records.py`、`backend/app/llm.py`（assess fixture 按新结构补 `topic`）、`backend/tests/test_misconception_mapping.py`（新增）。
- **未动**：PRD 无描述「误解自动落盘语义」的段落，故未同步；版本号未动，未 commit / push。

---

## 2026-10-05 · 文档清理与本轮实施（进行中，未定稿）

> 性质：维护者授权的**文档清理**与本轮**前两批实施**的留痕（**只追加**，不改写上方任何历史条目）。**本轮未跑最终门禁、未部署、未提交**；**所有计数与接口口径待维护者定稿后回填**，本条不写完成态与最终数。任何 commit / push / tag 仍须维护者明确同意。

### 文档清理（旧项整理，不动代码语义）

- **backlog 归位**（《开发与计划》§5）：完成 / 已裁定项**移入「完成索引」并保留编号**（#2 docs 已存在、#31 并发先拒绝、#32 `shadow-xs`、#33 `display_content`、#34 legacy 工单恢复、#37 会话流生命周期）；#36 鉴权 / 来源 / 监听边界**裁定只本地个人用、不做**；#21 `Deepseek-v4-flash` 档位与网关不匹配属用户数据问题（**现用 high 档位、适配层已归一**），改为**历史备忘**、不再列待修。
- **编号整理**：旧 **#24**（门禁 / 检查 stage 双发）归并到 **#23**；旧 **#27**（`generate` 未工具化）归并到 **#16**；失效的 **#14** 引用清理。
- **#30 描述纠正**：原描述"刷新后看不到产课过程"不是真实缺口；**真实缺口是提示刷屏 + 角色过程不可见**，并入本轮实施。
- **HANDOFF 瘦身**：改为「当前事实 / 真实阻塞 / 文档地图 / 已知坑前 10 / 环境事实」，**计数不再写死**（以命令输出为准）；移除旧 #24 / #27 / #14 悬空引用。
- **PRD / README / E2E 流程**：去掉历史门禁计数、改为「以命令输出为准」；PRD 修正陈旧的「客户端超时 60 秒」为**读超时**（默认 900s，非总时长上限），并标注本轮实施中项。`docs/使用` 与 `docs/设计` 边界文档**仅纠过时口径**：版本指针 `0.5.0-beta → 0.6.0-beta`、Node `18+ → 20.9+`、节点页「申请评估 / 产出课件」改为由聊天 agent 工具发起、前端由 Next 绑定 `0.0.0.0`（后端 `127.0.0.1`）等。

### 本轮实施（前两批；进行中）

- **评估链**：取**真实 `node_id`**、解析失败给**诊断**并**只做一次格式修复**（不在解析失败上空转）。
- **系统结果卡**：失败时**不保存、不承诺后台完成**。
- **产课链**：落**一父任务卡** + **真实角色事件** + **心跳原位状态**，成功后**结构化打开课件**。
- **交付检查**：**区分循环内自检与外层交付检查**（修 #23 检查 stage 双发）。
- **收口**：**只限制无关工具**（而非把全部 interview 会话改走纯文本）。
- **时长**：`chat_once` 默认 **300s 总时限**（长角色可 **1800s**）。
- **依赖锁**：改用 **uv 0.11.14 universal + hash**（`backend/scripts/lock_backend_deps.py` 生成 `requirements.lock.txt` / `requirements-dev.lock.txt`）；独立 Web CI（本地已装、**远端未 push / 未执行**）。
- **渲染**：浅 / 暗**渲染专项矩阵**。

### 第三批（整体保留延期，不实施）

#17 小结 / 沉淀记忆入口接回、#9 主动检索、#16 + #29 完整 K4 与 `generate` 统一、#4 音视频 OCR、#15 代码执行 / 沙箱、#8 SQLite、#13 vision 垫片清理、#18 未存在工作区、#3 其余两协议真实验证。详见《开发与计划》§5「延期」。

### 边界（明说）

- **未跑最终门禁、未写最终计数**：本轮将增测试，最终数以 `pytest` / `npm run test:e2e` / `npm run test:component` / `npm run lint` 输出为准。
- **未部署**：现服务未重启、真实 `data/` 未触碰；**未 commit / push**；版本号未动。
- **误解沉淀 P1**（另一 session：`misconceptions` / `questions` 映射 + `test6`）已完成并留痕于上一条，本轮**不重做**。
- **E2E 本轮映射待 owner 定稿**后回填 E2E 流程文档。

---

## 2026-10-05 · 本轮接口定稿（task_update / interview 收口 / records 修复 / 依赖锁）

> 性质：维护者给出的本轮**具体接口定稿**留痕（**只追加**，不改写上方）。**实现接口已定；最终门禁 / 计数待统一结果后定稿**；**未部署、未提交、版本未动**。任何 commit / push / tag 仍须维护者明确同意。

- **SSE `task_update`**：`{id=<父 tool id>, task=<完整 snapshot>}`；前端按 `id` **原位更新同一条 `tools[].task`、不追加消息**（不重复落库）。**role 内工具 namespaced**；任务卡**常显 `stage` / `elapsed`**。
- **结果透传与打开课件**：`tool_result` 透传 `task` / `lesson` / `assessment`；assessment 系统状态 **`saved` vs `failed`** 且 **`background:false`**（不承诺后台完成）；产课成功后经 Next `Link` **同 tab SPA** 打开绑定 workspace 课件。
- **records 解析修复**：**最多一次**格式修复、**机械分隔符修复优先**；修复须与原文语义快照**递归等价**（字段 / 题数 / 判分 / 原答 / note 全不变）；**无可信锚保守失败不落盘**；**不保证任意坏 YAML 都能修**。
- **interview 收口**：仅**明确确认建课**当轮进入收口 `schemas[]`；**≤2 LLM 轮 / 默认 120s**（`STUDYMATE_INTERVIEW_FINALIZE_MAX_SECONDS`，不超过 chat 300s）；**否定 / 疑问不触发**；**普通 interview 仍工具**；完整标记后**停止后置工具**；收口**只限制无关工具**。
- **LLM 总时限**：`chat_once` 由 **`STUDYMATE_LLM_MAX_SECONDS`（默认 300s，覆盖重试退避）** 约束；角色 `max_seconds = ORCH 1800s`。
- **依赖锁**：改用 **uv 0.11.14 universal + hash**，由 `backend/scripts/lock_backend_deps.py` 生成 `requirements.lock.txt`（runtime）/ `requirements-dev.lock.txt`（dev superset，可 `pip --require-hashes` 单装）；**真实 venv 未改、Linux 未实装、CI 未 push**。
- **测试（预计，不写死）**：前端 96 + 新增 2 处修补；E2E 88 总 = 80 main + 8 主题；根 `npm test` 已过。**最终统一结果前不据此宣示完成。**
- **已同步**：PRD 实施状态总览 / §13.1 / §13.3（新增）/ §14、开发与计划 §1.3 / §5「本轮实施」、README 依赖锁与树、E2E 流程顶部待定标记。

---

## 2026-10-05 · 独立 review 四项验收与本轮实际变动（实现冻结，统一测试中）

> 性质：**只追加**。独立 review 四项验收通过，实现**冻结**、进入**统一测试**；**未部署、未提交、版本未动**。任何 commit / push / tag 仍须维护者明确同意。

- **独立 review 验收（四项全过）**：① 收口 **full match**（疑问 / 否定不误触发）；② **typed 关键字段**；③ **route 工具适配实际接线**；④ **角色截断闭合围栏**。
- **tools-enabled 角色提示接线**：建课（`generate`）→ `submit_curriculum`；产课 → `write_deliver_file` / `run_check`；**工具循环无交付时的单次 fallback 仍走 envelope**。
- **建课收口 draft 门**：收口 `schemas[]` 收到 **name-only / 占位符 / 非字符串**等**缺信息**时**不建 draft**（保守失败）。
- **records 语义 mapping 校验**：落盘前做**完整语义 mapping 校验**，**类型不符（含 bool / number 冒充）同样拒绝**（不因"能解析"就放行）；解析修复仍**最多一次**、机械分隔符优先、与原文递归等价、无可信锚保守失败不落盘。
- **评估真相兜底（口径）**：采用**受控提示 + 系统 assessment 真实状态卡**双保险；**模型输出仍不可完全保证、不宣称绝对可靠**，界面以系统状态为准；E2E 故意让模型输出"我认为通过"仍显示 **failed**。
- **任务正文截断**：任务角色正文**超限额截断并带明确提示**，不返回完整无限日志。
- **测试（已确认事实）**：E2E 已 **88 = 80 main + 8 主题**；CI smoke **5 pass**；根 `npm test` exit 0。**skip 数等 final 暂不写**；**最终统一结果后定稿**。
- **已同步**：PRD 实施状态总览 / §13.3 / §14、开发与计划 §1.3 / §5「本轮实施」、README 质量段、E2E 流程顶部标记。
- **第三批延期 / 完成索引已最终整理**：见《开发与计划》§5 的「延期」「等待外部验证」「完成索引」；本轮不写最终计数。

---

## 2026-10-05 · 最终验证收尾（本轮定稿）

> 性质：**本轮最终验证快照与文档定稿留痕**（**只追加**）。本文件上方本会话早前的「文档清理与本轮实施（进行中）」与「本轮接口定稿」两条为**过程记录**，其「进行中 / 待统一 / 不写最终计数」字样**由本条取代**，历史条目**不回改**。任何 commit / push / tag 仍须维护者明确同意；**本轮未部署、版本未动**。

- **最终统一快照（唯一隔离副本）**：后端 pytest **408 passed + 1 skipped**（唯一 skip = 真实 LLM 未启用）；组件 **98 passed（14 文件）**；E2E **88 = 85 passed + 3 skipped（0 failed）**（skip = `memory-flow` 2 + `session-summary` 1，属第三批保留的悬空入口），其中渲染矩阵 **8 = 4 × 2（light / dark）**；CI smoke **5 passed**；lint **0 errors / 51 warnings**；`tsc` / `build` / `compileall` / `import` / 根 `npm test` **全部 exit 0**。
- **依赖锁（最终）**：uv 0.11.14 universal + hash；`pip --require-hashes` 安装 + `pip check` 通过（Windows / Python 3.13.11）；runtime hash `a7f39ff6…`、dev hash `478de396…`。**Linux 未实装、CI 未远端执行**。
- **源码一致性**：**534 个源文件比对，仅 4 个刻意端口文件不同、其余逐字节一致**；测试证据临时副本已保全并清理。
- **E2E 映射（最终）**：新增 `production-task.spec.ts`（**3 条**：`task_update` 原位更新 / 结果透传 / 系统状态兜底）、`rendering.spec.ts`（**4 × 2 = 8**，含在总数内）；`produce-tool.spec.ts` 旧断言更新为实际接线（`submit_curriculum` / `write_deliver_file` / `run_check`）。
- **前两批 = 已完成；第三批 = 全部保留延期**（#3 / #4 / #8 / #9 / #13 / #15 / #16 / #17 / #18 / #29，见《开发与计划》§5）。
- **唯一剩余外部验证**：CI / lock **远端未 push / 未在 GitHub 执行** —— 仅等维护者授权 **commit + push**；**不写远端通过**，**不伪装实现未完**。
- **文档落点**：PRD §13.3 / §14 / 总览、开发与计划 §1.3 / §5（完成索引 + 延期 + 等待外部验证）、README 质量段 / 依赖锁 / E2E 段、E2E 流程 v2.8 当前口径与映射、HANDOFF 当前事实与阻塞、`docs/使用` 与 `docs/设计` 过时口径纠正；授权 8 文档本地链接核查（修 3 处指向 `docs/StudyMate-Web_探索测试指南.md` 的失效指针）。

---

## 2026-10-05 · 本轮讲解失败事故修复（契约已定，待最终回归核验）

> 性质：**只追加**，不改写上方任何历史条目。本轮针对**真实事故（最新会话讲解失败）**修复，**契约已定、待最终回归数核验后定稿**。上方「最终验证收尾（本轮定稿）」等条目的计数（后端 408 / 组件 98 / E2E 88 等）**属上一轮历史，不作为本轮口径**。**未部署、未提交、版本未动、不发布**；任何 commit / push / tag 仍须维护者明确同意。

- **备用单次派工角色展示**：回落 / 直连单次派工的角色在任务卡上标 `execution_mode ∈ {tools, fallback, single_call}`，并展示 `fallback_reason` / `max_seconds` / `elapsed_s` / `message`；**`role_start` / `role_end` 反映真实 start / done / error**——**单次派工返回 envelope 只表示这次调用有回复，不等于自检通过**；**保留原始失败与真实终态，不刷屏、不虚构模型过程**。墙钟预算不变（`ORCH_MAX_SECONDS` 1800s）。
- **`produce_lesson` 默认节点选择**：不传 `node_id` 时**按大纲顺序取第一个尚无课件的节点**（与 curriculum schema 顺序一致），**不沿用会话注入的节点聚焦**；显式 `node_id` 以它为准。
- **待核心 owner 落地后定稿（本轮不声称已实现）**：**复用既有正确角色产物**的严格条件、`regenerate` 复检条件。
- **测试边界**：E2E owner 将新增 `produce-selection.spec.ts`，并给 **mock 备用回落路径**用例；最终总数与 skip **待回归以命令输出为准**，本条不写死计数。
- **文档落点**：PRD（总览 + §13 / §13.1 / §13.3 / §14）、开发与计划（§1.1 / §1.3 / §2 / §5）、HANDOFF 当前事实、`docs/StudyMate-Web_建课链路.md` 相关三处、E2E 流程口径与映射。
- **边界**：第三批整体保留延期；**不升级版本、不部署、不发布**；本轮为文档 owner 的文档更新，**不改代码 / 数据**。

---

## 2026-10-06 · 本轮补正（日期更正与复用 / `regenerate` 契约定稿）

> 性质：**只追加**。上一条标题「2026-10-05 · 本轮讲解失败事故修复（契约已定，待最终回归核验）」的**日期应为 2026-10-06**；核心 owner 已落地复用 / `regenerate` 契约——本条**只增不改**，原条目不回改。

- **日期更正**：本轮为 **2026-10-06**（上一条标题误记 10-05；历史各轮 10-05 不变）。
- **`regenerate`**：布尔，默认 `false`；显式 `true` **强制重做、不复用**。
- **既有产物复用（接受条件，四者同时成立）**：① 本轮该角色**无新交付文件**；② `regenerate=false`；③ 本次上下文 **`check_passed=true`**；④ 该角色 required 目标文件**存在、可读、非空**（**出题 = `*.quiz.json`，其余 = `*.md`**）。满足即**接受既有产物、不再派工**，否则正常派工。
- **禁复用**：**检查打回后的强制重做轮** 与 **工单 retry** 一律禁复用。
- **`produce_lesson` 无 `node_id`**：**严格**按大纲顺序取第一个尚无课件的节点，**不沿用会话节点聚焦**。
- **待独立 review**：是否还需**校验凭证失效**等补强。**最终计数待验证员**——owner 现 **432+1 / 107 仅为中间值，不作为定稿口径**。
- **测试边界**：E2E owner 以 **mock 回放**覆盖复用 / 回落路径，**无需新增产品按钮**。
- **非历史文档已同步**：PRD（总览 + §13.1 / §13.3 / §14）、开发与计划（§1.1 / §1.3 / §5）、HANDOFF、E2E 流程；`docs/StudyMate-Web_建课链路.md` 相关处。**未部署、未提交、版本未动、不发布。**

---

## 2026-10-06 · 复审小修与构建覆盖事故（本轮补充；只追加）

> 性质：**只追加**，不改写上方任何条目。本条**补充**本轮「讲解失败事故修复」：复审新增小修（实施中）、E2E 用例，以及一次**默认 `.next` 被覆盖事故**。**本条取代上条「未部署 / 不部署」的绝对保证**（原条目不回改）。**未定最终计数**。

### 复审新增小修（实施中）

- **`regenerate`**：`true` 须**显式给出 `node_id`**，且 **bool 严格校验**（非布尔拒绝）。
- **required 文件 gate 扩展**：**quiz 与工单（ticket）交付同样 gate required 文件**，防相对 path 写错 / 假解决。
- **复用排除**：**非 UTF-8 内容不复用**。
- **角色终态**：**真实 timeout 落到角色任务终态**（不悬空 running）。
- **任务卡**：**角色非 running 不显示「当前阶段」**。
- **停止**：**本地停止时 roles 同终止**。
- 仍待独立 review（是否需校验凭证失效等补强）；**不写死计数**。

### E2E

- 新增 `produce-selection.spec.ts` **3 条**（**1 条真实 fixture** + **2 条 UI-only done / error 回放**）；复用 / 回落以 **mock 回放**覆盖，**无需新增产品按钮**。

### 构建覆盖事故（简记）

- 并行 **UI owner 于 00:39 在 `frontend/` 直接 `npm run build`**，**未设隔离 `distDir`、无构建前备份**，**覆盖了默认磁盘 `.next`**。
- 实际服务 **PID 43428 `next start -p3800` 自 23:51:08 起仍在跑**（**早于新 build**），**未重启、未删除、未补救**；只读核验：`GET /chat` + 6 个引用静态资源全 **200**、后端 `8101 /health` **200**。
- **口径更正**：**撤掉「未覆盖 `.next` / 完全未部署」的绝对保证**——本轮**未执行服务重启或完整部署**，但**默认磁盘构建已被覆盖**；**当前健康检查正常，但不保证全部改动已生效 / 可还原**。事故简记仅入 HANDOFF 与 Web_CHANGE，**不污染 PRD 正文**。
- **版本未动、不升级、不发布**；任何 commit / push / tag 仍须维护者明确同意。

---

## 2026-10-06 · 事实更正（只追加；简明）

> 性质：**只追加**，不改写上方条目。本条对本轮上两条做**事实更正**，不再逐次追加小动作。

- **健康端点**：后端为 **`8101/api/health`**（`/health` 返回 **404**）；上条事故简记中的 `8101 /health` 以此为准。
- **当前阶段显示**：隐藏规则作用于**任务**——**任务非 running 时任务卡隐藏「当前阶段」**（**不是**"非 running 角色隐藏"）。上两条的对应表述以此为准。
- **状态**：复用 / `regenerate` 严格条件与 **quiz / ticket required gate 均已落地**（core 已 freeze），去掉"待核心 / 复审小修实施中"字样；**仅余最终回归待核验**。
- **E2E mock 范围**：`produce-selection.spec.ts` 的 mock **仅测 fallback 落库回放**，**不测「复用」后端机制**。
- **版本未动、不升级、不发布。**

### 本轮留痕说明（简明）

- 本条之后，本轮新增记录**不再逐次追加**；如再有事实性更正，**并入本条或单条简明更正**。

---

## 2026-10-06 · 验证员中间结果（非终态；只追加）

> 性质：**只追加**。以下为验证员**本轮中间**结果，**非全绿 / 非终态**；**最终数以 E2E 全量通过后为准**。

- 后端 **452 passed / 1 skipped**；组件 **113 passed（15 文件）**；`compileall` / `import` / `tsc` / `build` / 根 `npm test` / CI smoke **5** 绿；lint **0 error / 51 warning**。
- **E2E 86 passed / 2 failed / 3 skipped（总 91）**——**未通过**，已交 **E2E owner** 修。
- **待查两处**：① 旧 `production-task` 期待 **done 时带「当前阶段」**，需对齐**新契约（任务非 running 隐藏当前阶段）**；② 新 `produce-selection` 真实 fixture 报 error，需查**种子 check 原因**。
- **版本未动、不升级、不发布**；部署实况见 HANDOFF（**未执行服务重启或完整部署；默认磁盘构建已被覆盖**）。

---

## 2026-10-06 · 最终收尾（本轮定稿）

> 性质：**只追加**，不改写上方任何条目（含本会话早前的过程留痕）。**本轮定稿：最终全量绿、两项独立复审无阻塞；未升级版本、未 commit / push、未跑真实 LLM、未部署（见部署实况）。第三批不做。** 上方「进行中 / 待回归 / 非终态」字样**由本条取代**，历史条目不回改。

- **最终全量**：后端 pytest **452 passed / 1 skipped**；组件 **113 passed（15 文件）**；E2E **91 = 88 passed + 0 failed + 3 skipped**（skip = `memory-flow` 2 + `session-summary` 1；含 light / dark 渲染矩阵 8）；CI smoke **5 passed**；`compileall` / `import` / `tsc` / `build` / 根 `npm test` 通过；lint **0 errors / 51 warnings**；**两项独立复审全部无阻塞**。
- **E2E 两初红已修**：① 旧 `production-task` 的 done「当前阶段」断言改为「无当前阶段」+ history 渲染检查；② 新 `produce-selection` 原用 md 占位触发真实 check 错误（**真实复现「编号 0002 应为 0001…不能跳号」**），改用**真实 HTTP 先完整产首课（HTML / quiz）再产第二课**。
- **健康端点**：后端为 **`8101/api/health`**（`/health` 404）。
- **部署实况（沿用前条，如实保留）**：**未执行服务重启或完整部署**；默认磁盘 `.next` 于 00:39 被覆盖（无隔离 `distDir`、无构建前备份），**不能保证全部改动已生效 / 原 build 可恢复**；当前只读健康检查正常。
- **第三批不做**；**无版本 / commit / push / 真实 LLM**。
- **验证证据**：`C:/Users/21621/AppData/Local/Temp/sm-verify-evidence-g6bkpt6q`（probe 错误 trace + 最终日志）；**隔离 root 待定稿后安全删除**。
- **文档落点**：PRD、开发与计划、HANDOFF、E2E 流程、`docs/StudyMate-Web_建课链路.md` 六份定稿；根 `docs/` 未改。

---

## 2026-10-06 · 本轮错误终态 / 检查器 / lab 交付修复（已定稿；真实重产待上游恢复）

> 性质：**只追加**，不改写上方任何条目（含上轮 `.next` 覆盖事故简记，**保留**）。**实现与本地 / 部署验证通过；两真实重产均失败（上游网关 503，属外部阻塞）**，故**不声称真实两课成功**；本轮为**独立安全切换**、**非恢复原 build**。

- **统一错误对象与红色错误详情**：后端新增 `app/errors.py`（`ErrorInfo = {code, status, upstream_code, phase, summary, detail, retryable, stopped_reason, request_id, source, operation}`；`code` 开放 string）。SSE `error` **平铺** ErrorInfo（另带 `message`）；HTTP 错误体 `{detail: summary, error: ErrorInfo}`；助手消息持久化 `error` + `stream_state="error"`（**空正文但有 error 不过滤**，刷新 / 切会话后可重放）。上游流缺 finish / `message_stop` / `response.completed` 标记判 **`UpstreamEOFError` → `upstream_eof`**（不再静默半截）。`request_id` = 本轮 `turn_id`。前端 `ErrorNotice.tsx`（`role=alert`、`data-error-tone` danger 红 / neutral 用户停止、摘要 + HTTP badge + 展开详情 + 复制诊断）在聊天与任务卡复用（`task-error → ErrorNotice`）。
- **停止按轮作用域**：`errors.register_turn / clear_turn / request_stop / consume_stop / active_turn` 按 `(session_id, turn_id)` 作用域；**user_stop 仅由 stop endpoint 显式登记**，异常映射层不默认（取消 = `disconnect`，非 user_stop）。
- **共享检查器自身 bugfix**：`scripts/check_lesson.py` 新增 `RefScanner(HTMLParser)`，只取**真实元素**的 `href/src`；`<pre>/<code>` 里转义的教学示例（`&lt;img src=…&gt;`）不再误报缺资源，**真实缺资源仍拦**。属脚本自身修复，**不是 Web 第二份引擎、不绕过检查、不改「上游脚本只复用不重写」**。
- **实操 lab 交付**：`produce.py` 真实 lab 路径 `lab/<NNNN>-stage/README.md` + `lab/solutions/<NNNN>-stage/README.md` + `lab/README.md`，内容入口 `../lab/<NNNN>-stage/README.md`；`required_artifacts` 对 `kind=实操`（`produce_quiz`）与 `kind=实验`（`produce_experiment`）一并 gate 整套 lab，**缺一份即不 promote**（防假解决）；真实 `quiz_values` 保留原 `lab/README.md` 并增补本课，fixture 同契约。
- **无效打回与次数**：`run_produce` 分开 `round_no`（修复派工轮）与 `rechecks`（总控复检次数）；**总控归属只复检一次、不占修复派工轮**（发 `stage 总控复检`），不再谎报 2 轮；耗尽 `error` 带 `code=quality_check_failed` / `repair_rounds` / `rechecks` / `ticket_id`，文案如实；前端任务卡显示实际值。
- **真实重发实证（两会话，浏览器 UI 编辑重发）**：① web 会话 `1c3bad7657b7` 原 index6（保留正确 HTML 示例、`node=html-elements`、`regenerate=true`，17:46–17:56 约 10min）：首次 role 未交付回落空响应，主 chat 自行第二次 produce，最终上游 **503 `system_memory_overloaded`（current91/threshold90）**，`msg.error` 结构化、`stream_state=error`，`turn e9731d08f43942468359d779fa406901`。② Git 会话 `cc886d4641a1` 原 index28（`node=git-bash`、`regenerate=true`、补 lab、不评估 intro，18:00–18:01）：产课 role 上游 503（current92/threshold90），主 chat 后续 503（91），`turn f6083744eef7470eb1600078b13a24ad`，error 终态。**结论：两课真实重产均未成功，属上游网关 503 外部阻塞，未擅自 restart / 改阈值；不声称真实两课成功。** 两红卡经浏览器打开组件展开核验（503 码 / upstream_code / turn / detail，截图 `real-web-503.png` 与 `real-git-503.png`）；旧 web HTML 用新 checker 只读检查 OK（有 warnings）**≠ 重产通过**；Git lab 仍未完成。
- **安全部署（已执行）**：先 busy 空 → 停原 PID 42544/11948 → 原 `.next` 改名 `.next-backup-before-errors-20261006` → build 默认 `.next` 成功 → 重启原 source / `backend.venv` / 真实 data，服务健康；启动仍 `start-web.bat` 默认 `.next`（**启动方式未变，README 启动节不改**）。预构建 `.next-release-20261006-errors` 保留、未用于启动。**独立安全切换 ≠ 恢复原 build**；上轮事故简记保留。
- **验证**：后端 **474 passed / 1 skipped**；组件 **119 passed / 0 error（16 文件）**；E2E **98 = 95 passed + 3 skipped**（`chat-errors` 7/7）；`build` / `lint` / 根 `npm test` 通过。**独立完整复审代理多次 provider 失败，不能声称全量独立复审完成。**
- **边界**：**无 commit / push / version（0.6.0-beta 不升）**；**第三批整体不做**。证据 root `sm-verify-evidence-99347378`（含 `final-check.json` / `replay-*.json`），备份 `studymate-evidence-ptymjmpy`（两会话 sessions/subjects 共 56 文件保留）；隔离 root `sm-verify-99347378` 已安全删除，服务 health 200、两会话 `streaming=false`。
- **文档落点**：PRD、开发与计划、HANDOFF、E2E 流程、`docs/StudyMate-Web_建课链路.md` 一次定稿；根 `docs/` / `AGENTS.md` / 根 `CHANGELOG.md` 未改。

---

## 2026-10-06 · 交付（版本升级 + 分里程碑四提交 + push）

- **版本号 0.6.0-beta → 0.7.0-beta**：`frontend/package.json`、`frontend/package-lock.json`（两处）、
  `backend/app/main.py`（FastAPI `version`）、`README.md`「版本」节、`StudyMate-Web_开发与计划.md` §1 标题、
  `docs/设计/StudyMate-Web边界与契约.md`（2 处）、`HANDOFF.md`。侧边栏读 `package.json` 自动跟随
  （build 期打包，故首次需重新构建）。PRD 正文按约定不写版本号。
- **提交形态**：维护者授权后按里程碑拆四个提交——① `fix(课件检查)`（根 `scripts/check_lesson.py`
  的 RefScanner 修复 + 配套测试，独立成提交便于日后单独给上游提 PR）；② `feat(Web运行时)`（统一错误
  对象 / 会话流生命周期 / 生产任务化 / workspace-files 路由 / lab 交付 / 依赖锁 / web-ci workflow）；
  ③ `test(Web运行时)`（后端 18 个新测试 + 前端组件 12 文件 + E2E 10 spec + explorer 调整）；
  ④ `docs(Web运行时)`（Web_CHANGE 归档重组 + 六份文档同步 + 版本指针）。`.gitignore` 补
  `frontend/e2e-run*.log`。全部落 `feat/study-mate-web` 并 push 至 fork；PR #43 描述同步更新。
- **提交前门禁（本次实测）**：后端 pytest **474 passed / 1 skipped**；组件 **119 passed（16 文件）**。
- **运行产物不入库**：`e2e-run*.log` 与 `docs/archive/*.md` 均为 gitignore 忽略项。
