# HANDOFF — StudyMate Web 交接（2026-10-06 · 第二十版，瘦身）

> 给下一个接手 `study-mate-web/` 子项目的 agent。**本文只做索引与状态，细节一律走路径**；本子项目不含任何密钥 / PII，测试用占位 key 均为假值。
> **计数一律以命令输出为准**（`python -m pytest tests` / `npm run test:e2e` / `npm run test:component` / `npm run lint`）；**本轮定稿快照见「当前事实」（一次性记录，此后以命令输出为准）**。

## 当前事实

- 版本 **0.7.0-beta**；分支 `feat/study-mate-web`；2026-10-06 已按里程碑分四个提交（课件检查 fix / feat / test / docs）**commit 并 push 至 fork**，web-ci 随 PR #43 的 `pull_request` 触发在 GitHub 执行；实况一律 `git status`。
- 运行时数据根 `study-mate-web/data/`。**部署实况（2026-10-06）**：**上轮事故历史保留**——默认磁盘 `.next` 曾于 **00:39** 被并行 UI owner 的 `frontend npm run build` 覆盖（**未设隔离 `distDir`、无构建前备份**），当时服务 **PID 43428 `next start -p3800` 自 23:51:08 起仍在跑**（早于新 build），**未重启、未删除、未补救**。**本轮已做独立安全切换**：先确认 busy 空 → 停原 PID **42544 / 11948** → 原 `.next` 改名 **`.next-backup-before-errors-20261006`** → `next build` 重建默认 `.next` 成功 → 重启原 source / `backend.venv` / 真实 data，**服务健康**；预构建 **`.next-release-20261006-errors`** 保留、未用于启动。**这是独立安全切换、非恢复原 build**；启动方式仍 `start-web.bat` 默认 `.next`（README 启动节不改）。
- 上一轮「会话流生命周期与有序工具卡」与稍后的**第一轮（2026-10-05）前两批**均已定稿；第一轮快照（后端 **408 passed / 1 skipped**、组件 **98 passed · 14 文件**、E2E **88 = 85 passed + 3 skipped / 0 failed**、CI smoke **5 pass**、lint **0 errors / 51 warnings**、`tsc`/`build`/`compileall`/`import`/根 `npm test` 全 exit 0；依赖锁 `pip --require-hashes` + `pip check` 通过）**属上一轮历史，不作为本轮口径**。**本轮（2026-10-06 讲解失败事故修复）已定稿并验证**：备用单次派工角色展示（`execution_mode` / `fallback_reason` / `max_seconds` / `elapsed_s` / `message`，按真实 start / done / error 呈现，**envelope 返回≠自检通过**）、`produce_lesson` 默认节点选择（**严格按大纲顺序取第一个尚无课件的节点**，**不沿用会话节点聚焦**）、**既有产物复用 / `regenerate`**（无新文件 且 `regenerate=false` 且 ctx `check_passed` 且 required 目标存在可读非空 → 接受复用；默认 `false`、`true` 强制重做；**强制重做与工单 retry 禁复用**）；**复审小修（已落地）**：`regenerate=true` 须显式 `node_id` + **bool 严格校验**、quiz / ticket 交付也 gate required 文件（防错 path / 假解决）、**非 UTF-8 不复用**、**真实 timeout 落角色终态**、**任务非 running 隐藏当前阶段**、**本地停止 roles 同终止**。**第三批整体保留延期**。**最终全量（2026-10-06）**：后端 **452 passed / 1 skipped**、组件 **113 passed（15 文件）**、E2E **91 = 88 passed + 0 failed + 3 skipped**（含 light / dark）、CI smoke **5 passed**；`compileall` / `import` / `tsc` / `build` / 根 `npm test` 通过；lint **0 errors / 51 warnings**；**两项独立复审全部无阻塞**。**E2E 两初红已修**：① 旧 `production-task` 的 done「当前阶段」断言改为「无当前阶段」+ history 渲染检查；② 新 `produce-selection` 原用 md 占位触发真实 check 错误（真实复现「编号 0002 应为 0001…不能跳号」），改用真实 HTTP 先完整产首课（HTML / quiz）再产第二课。**交付（2026-10-06）：0.6.0-beta → 0.7.0-beta，四提交已 push，CI 待看 GitHub 实跑结果。**
- **本轮（2026-10-06 错误终态 / 检查器 / lab 修复，已定稿）**：**统一错误对象**（后端 `app/errors.py` 的 `ErrorInfo`；SSE `error` 平铺、HTTP `{detail, error}`、助手消息持久化 `error` + `stream_state="error"`、空正文带 error 不过滤；上游流缺 finish / `message_stop` / `response.completed` → `upstream_eof`）、**停止按 `(session_id, turn_id)` 作用域**（user_stop 仅 stop endpoint 登记）、前端 **`ErrorNotice` 红卡**（danger / neutral、展开详情、复制诊断，聊天与任务卡复用）；**共享检查器自身 bugfix**（`scripts/check_lesson.py` 用 `HTMLParser` 只取真实 `href/src`，代码示例不再误报，**不绕过真实缺资源检查、不改「脚本只复用不重写」**）；**实操 lab 交付**（`lab/<NNNN>-stage/README.md` + `lab/solutions/<NNNN>-stage/README.md` + `lab/README.md` required，缺一不 promote）；**无效打回与次数**（`repair_rounds` 与 `rechecks` 分开，总控只复检不占派工轮，如实显示）。**部署已完成**（见上条安全切换）。**验证**：后端 **474 passed / 1 skipped**、组件 **119 passed / 0 error（16 文件）**、E2E **98 = 95 passed + 3 skipped**（`chat-errors` 7/7）、`build` / `lint` / 根 `npm test` 通过。**真实重发两课均失败**：web `1c3bad7657b7`（index6）与 Git `cc886d4641a1`（index28）经**浏览器 UI 编辑重发**，均以上游 **503 `system_memory_overloaded`** 终态（turn `e9731d08f43942468359d779fa406901` / `f6083744eef7470eb1600078b13a24ad`），**不能声称真实两课成功**；旧 web HTML 只读过 checker（有 warnings）≠ 重产通过，Git lab 仍未完成。**独立完整复审代理多次 provider 失败，不能声称全量独立复审完成。** 证据 root `sm-verify-evidence-99347378`（`final-check.json` / `replay-*.json`），备份 `studymate-evidence-ptymjmpy`（56 文件，保留）；隔离 root 已安全删除，服务 health 200、两会话 `streaming=false`。**第三批整体保留延期。**
- **门禁命令**：改 `backend/` → `python -m pytest tests` + `compileall`；改 `frontend/` → `npm run build`（含 TS 严格）；对话 / 设置 / 附件类 → `npm run test:e2e`；另 `npm run test:component` 与 `npm run lint`。根 `npm test` **不覆盖 Web**。

## 接下来做什么（真实阻塞，按序）

1. **CI / lock 远端验证（其一）**：独立 web-ci 已配置、本地 smoke 5 pass；依赖锁（uv 0.11.14 universal + hash）已生成、`pip --require-hashes` + `pip check` 通过（Windows / Python 3.13.11）；2026-10-06 已 push，**待核对 PR #43 上 web-ci 的 GitHub 实跑结果（Linux 首跑）**。
2. **真实重产（两课，待上游网关恢复）**：web `1c3bad7657b7`（index6）与 Git `cc886d4641a1`（index28）经浏览器 UI 编辑重发均以上游 **503 `system_memory_overloaded`** 失败；**待上游恢复后重跑**，不擅自 restart / 改阈值。当前只读过 checker 的旧 HTML 与未完成的 Git lab **不算通过**。
3. **第三批（整体延期，待拍板）**：#9 主动检索路线 / #16+#29 完整 K4 与 `generate` 统一 / #3 其余两协议真实流式 / #4 音视频 OCR / #15 代码沙箱 / #8 SQLite / #13 vision 垫片 / #18 未存在工作区 / #17 小结与沉淀记忆入口接回。详见《StudyMate-Web_开发与计划.md》§5。
4. **口径提醒**：本运行时定位「每个使用者各自本机单人使用」（非"仅维护者自用"）；本轮**不新增鉴权 / 多租户**，未加鉴权前**不可宣称可公网部署**。

## 文档地图（先读这几份，按需深入）

| 文档 | 用途 |
|---|---|
| `AGENTS.md`（本目录） | 子项目硬规矩 + 规则 8 五份文档同步 + 规则 9 探索测试提醒 + 端口 |
| `README.md` | 启动、配置模型、附件、E2E 运行、版本语义、部署边界 |
| `StudyMate-Web_开发与计划.md` | 架构现状 + 不变约束 + 领域模型 + **§5 backlog（延期 / 等待外部验证 / 完成索引）** + §5.3 chat 工具面差距表 |
| `StudyMate-Web_PRD.md` | 功能规格（描述现状，状态标注「已实施」） |
| `StudyMate-Web_E2E测试流程.md` | 用例 ↔ 旅程映射（条数以 `npm run test:e2e` 为准；本轮 **98 = 95 passed + 3 skipped**） |
| `Web_CHANGE.md` | 变更史与全部 grill 决策留痕（**只追加**；2026-10-04 及之前见 `docs/archive/`） |
| `docs/StudyMate-Web_建课链路.md` | 建课全链路档案（入口 → 收口 → 编排 → 落点 → 产课；产物速查 / 卡点索引） |
| `docs/StudyMate-Web_前端美化设计.md`、`docs/StudyMate-Web_探索测试指南.md` | 设计 / 探索测试指南（按需） |

上游事实依据：`.dsh/skills/learning-system/{lesson-design,layered-practice,record-keeping,practice-evaluator,evidence-check,local-qa,learning-discovery}/SKILL.md`、`scripts/{gen_home,render_lesson,check_lesson,check_curriculum}.py`、`SKILL_ROUTES`（`backend/app/prompts.py`）。DSH 运行时本体在 `D:\deepseek-harness`；DeepTutor 只读克隆在 `D:\Local-projects\Study-Mate\DeepTutor`（前端在 `web/`，不是 `deeptutor_web/`）。

## 已知坑（前 10，踩过的别再踩）

1. **判断"是卡了还是在跑"**：先看进度卡（`progress` 快照：轮次 / 已等待秒数 / 思考字数 / 工具次数）与 `data/audit/*.jsonl`；思维链与正文都不落审计。`run_agent(max_seconds=…)` 有硬上限（聊天 300s / 编排 1800s，`STUDYMATE_CHAT_MAX_SECONDS` / `STUDYMATE_ORCH_MAX_SECONDS` 可覆盖）。
2. **会话存储是"整文件读改写"**：必须临时文件 + `os.replace` 原子替换 + 串行锁；遇"会话 / 消息凭空消失或列表 500"先看 `data/sessions/*.json` 能否解析。
3. **切会话 / 关页会丢本轮回复（断开兜底）**：两条落库路径都有"边发边攒 + 断开兜底"；排查——会话 JSON 以用户消息结尾且审计末轮只有 `agent_start` / `tool_call`，就是它。
4. **改了前端却"看不到改动"先查构建产物**：生产 `.next` 是 `next build` 快照，`next start` 不编译；新增 `data-testid` 未出现在 `.next/static` 即为旧代码（`start-web.bat` 会按 mtime 自动重建）。**构建前必须隔离 / 备份**：本轮先改名 `.next-backup-before-errors-20261006` 再重建，**勿直接覆盖在用 `.next`**。
5. **端口 8290 / 3810 会被并发互踩**：跑 E2E / 构建前确认无占用与无他人在途改动；多代理并行只让代理跑 `tsc --noEmit` / `compileall`，构建与全量 E2E 由主代理串行。
6. **同步重活绝不能跑在事件循环里**：`subprocess.run`（门禁）、附件 PDF 解析等用 `asyncio.to_thread`，否则同进程所有 SSE 流、附件上传一起卡住。
7. **`REQUEST_TIMEOUT` 是 per-read 超时**：网关窗口内吐过 ≥1 字节（思维链增量 / SSE 心跳）即永不触发；已做 `max_retries=0` + 非瞬时错误不重试。
8. **会话级模型是"生效三元组"**：`sessionActive ?? settings.active` 是唯一口径；`hasKey`、右栏上下文窗口分母、助手名称栏回退值都必须按它算。
9. **E2E 专用断言坑**：`toBeHidden()` 要求单一匹配、`panel.locator("summary")` 命中内嵌 `<details>`、会话标题与消息正文撞词、`<canvas>` 是 3 层、`getByRole` 的 name 默认子串匹配、工具卡常显致 `process-panel` 可能整块不渲染——一律见《StudyMate-Web_E2E测试流程.md》。
10. **建课 / 产课"卡住"排查**：卡点通常是"没有可见性 + 没有墙钟上限"而非 build bug，**不要先怀疑采图**（纯后端、秒完）；schema 必须内联进派工值、落点确认要带 `session_id`，实锤与卡点索引见 `docs/StudyMate-Web_建课链路.md`。

## 环境事实（不写死计数）

- Python 依赖在 `backend/.venv`；Windows 用 `.venv/Scripts/python.exe`；测试依赖见 `backend/requirements-dev.txt`。
- **本机有真实 LLM 渠道**：`my-api` = 本机 new-api 中转 `http://localhost:4000/v1`，六模型，均带思考档位（默认 medium）。门控冒烟：`SMOKE_REAL_LLM=1 SMOKE_MODEL=<名> .venv/Scripts/python.exe -m pytest tests/test_smoke_real_llm.py -s -q`（backend/ 下，串行不并发）。
- 版本号三处一致（`frontend/package.json` + `backend/app/main.py` + 侧边栏读 package.json），变更需维护者同意；运行时数据根在 `study-mate-web/data/`（settings、sessions、drafts、audit、uploads、exports）。
- 端口：后端 8101 / 前端 dev 3800 / 生产 3801 / E2E 8290 + 3810；启动 `start-web.bat` / 停止 `stop-web.bat`（`.bat` 一律 GBK + CRLF）。

## 建议使用的 skills

- `grill-with-docs`：新取舍"该不该 / 做到哪一层"先盘一遍；决策落 `Web_CHANGE.md`（只追加）。
- `playwright-cli`：扩展 / 调试 E2E、录 trace、查并发端口占用。
- `github:issue` / `github:pr`：维护者指令下跟进 issue 或 PR #43。
- `handoff`：再次交接时生成新版本（**覆写本文**，保留"文档地图 / 已知坑 / 环境事实"三节结构）。
