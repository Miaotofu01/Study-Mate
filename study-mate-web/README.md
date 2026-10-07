# StudyMate Web

- **是什么**：StudyMate 的独立 Web 前端与运行时——后端 FastAPI（多协议 LLM 适配层 + SSE 流式 + YAML 课程工作区），前端 Next.js 16 + React 19 + Tailwind + cytoscape；测试为 Playwright E2E（确定性 fixture，无需真实 API Key）+ vitest 组件测试 + 按需探索 agent。
- **已完成**：阶段 1–3、全功能复现队列 A~J、K 系列工具化改造（K0–K3）与第二 / 三 / 八轮 UI 收尾全部落地——课程图谱、learn-with-doing 闭环、模型提供商与附件体系、工作区同构与发现（含会话级工作区绑定）、提示词分层、记录与记忆写侧，以及生产侧（节点产出 / 建课链 / 采图 / 方向探索 / 质检工单）与工具化 agent 循环；生产侧已真实 LLM 冒烟验证。
- **版本指针**：当前版本见文末「版本」一节。

## 目录结构

```
study-mate-web/
├── start-web.bat / stop-web.bat   # 一键启动 / 停止（GBK + CRLF）
├── tools/studymate-web.ps1        # 启动器助手：构建新鲜度判定 + 按端口停服（纯 ASCII）
├── data/                          # 运行时数据（settings、sessions、drafts、audit、uploads、exports）
├── backend/
│   ├── app/
│   │   ├── main.py                # 入口（lifespan：建工作区目录、上传清扫）
│   │   ├── config.py              # settings v3 读写（providers[] + active + system_prompt）
│   │   ├── models.py              # Pydantic 模型
│   │   ├── storage.py             # 文件型会话存储（消息可带附件元数据）
│   │   ├── llm.py                 # 统一 LLM 适配层（三格式 + 工具声明/流式 tool_call + stream_turn）
│   │   ├── agent.py               # 工具化 agent loop runner（预算/降级/重复提醒/事件回吐）
│   │   ├── tools.py               # 工具注册表 + 沙箱边界（读写根 allow-list）
│   │   ├── audit.py               # 编排审计 data/audit/*.jsonl
│   │   ├── concurrency.py         # 进程内并发写拒绝注册表（reject-only 键锁 + 票键租约）
│   │   ├── multimodal.py          # 视觉能力判定、图片注入/占位、错误码剔除重试
│   │   ├── doc_extract.py         # 附件文档解析（pdf/docx/xlsx/pptx/epub/文本类）
│   │   ├── curriculum_store.py    # 课程仓储层（<WS>/.learning/subjects/<slug>/*.yaml）
│   │   ├── workspace.py           # 工作区发现（复用上游 learn_workspace()）+ 配置写回
│   │   ├── workspace_ctx.py       # 请求级工作区绑定（会话级工作区的唯一收口点）
│   │   ├── prompts.py             # 提示词分层：persona + 按链路注入 .dsh/skills/<名>/SKILL.md
│   │   ├── roles.py               # 角色派工基建（SKILL 全文注入 + envelope 落盘/搬位）
│   │   ├── produce.py             # 产课链编排（派工 → 渲染 → 检查 → 打回 → 工单）
│   │   ├── build.py               # 建课链编排（大纲 + 采图并行 → 门禁 → 落盘）
│   │   ├── draft.py               # 建课草稿区 + 落点确认（promote）
│   │   ├── image_scout.py         # 采图（纯后端爬虫）
│   │   ├── tickets.py             # 质检工单存储与分组
│   │   ├── memory.py              # 跨科目共享记忆 MEMORY.md（读侧 + 确认后增量写）
│   │   ├── misconceptions.py      # 概念本双落点存储
│   │   ├── records.py             # 评估/小结/学习记录落盘（front matter + jsonschema 校验）
│   │   └── routers/               # chat、courses、uploads、settings、workspace、workspace_files、lessons、
│   │                              # misconceptions、practice、records、memory、export、generate、production
│   ├── tests/                     # pytest 后端单测（隔离环境 + fixture 后端）
│   ├── requirements-dev.txt       # 测试依赖（pytest / httpx；参考）
│   ├── requirements.lock.txt      # runtime 依赖锁（uv universal + hash）
│   ├── requirements-dev.lock.txt  # dev superset 依赖锁（pip --require-hashes 可单装）
│   └── seed/                      # 示例科目（供 E2E fixture 与建课演示；启动不再自动种入）
└── frontend/
    ├── app/            # /chat、/courses、/misconceptions、/lesson、/generate、/settings/*
    ├── components/     # 聊天、RightRail（可折叠可拖拽的右栏外壳）、图谱、概念本、课件、
    │                   # InspectionDialog、MemoryDialog 与 WorkspaceOnboarding（悬空保留）、设置
    ├── lib/            # api 客户端、SSE 解析、chatStream（按 session 持有流）、workspace 全局上下文（会话级工作区 + 科目选中态）、useResizable
    ├── public/         # 站点资产（icon-192.png 品牌图标）
    ├── tests/e2e/      # Playwright 关键旅程
    ├── tests/component/# vitest 组件测试
    ├── tests/explorer/ # 探索 agent harness
    ├── vitest.config.ts
    └── playwright.config.ts
```

## 启动

### 方式一：一键启动（推荐）

双击 `start-web.bat`：首次运行自动创建虚拟环境并安装依赖；此后每次启动比对「前端源码时间 vs
上次构建时间」，**源码更新过就自动重新构建**（约 1~2 分钟；生产模式下 `.next` 是构建期快照，
`next start` 不重新编译）。随后拉起后端（8101）+ 前端（3800），就绪后打开浏览器并自动关闭启动器窗口。

- 服务跑在各自的「StudyMate 后端」「StudyMate 前端」窗口里，**关掉窗口就停对应服务**；启动器窗口关掉不影响服务。
- **一键全停：双击 `stop-web.bat`**（等同 `start-web.bat stop`）：按端口找到监听进程，连同服务窗口与残留孤儿进程一起结束。
- 启动前预检 8101 / 3800：已占用则报出占用 PID 与停止方式，不重复启动，避免新旧实例重叠。
- 可选参数：`dev` 强制开发模式（热编译、跳过构建）、`restart` 先停再启、`stop` 停止、`help` 帮助。
- 端口可用 `SM_WEB_BACKEND_PORT` / `SM_WEB_FRONTEND_PORT` 覆盖。

启动器由 `start-web.bat`、`stop-web.bat`（GBK + CRLF）与 `tools/studymate-web.ps1`
（构建新鲜度判定与停止逻辑，纯 ASCII）组成。

### 方式二：手动

后端（端口 8101）：

```bash
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # Windows；Linux/macOS 用 .venv/bin/pip
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8101
```

前端（dev 3800 / 生产 3801）：

```bash
cd frontend
npm install --legacy-peer-deps
npm run dev          # http://127.0.0.1:3800
# 或生产模式
npm run build && npx next start -p 3801
```

前端通过 Next.js rewrites 把 `/api/*` 同源代理到后端（`BACKEND_PORT` / `BACKEND_ORIGIN`
可覆盖后端地址）。注意：Next 16 生产构建在 `next build` 时把代理目标固化进
`.next/routes-manifest.json`，`next start` 运行期设这两个变量不生效（`next dev` 运行期读取）；
改后端端口时生产模式需重新 build，默认 8101 不受影响。同理，**改完前端源码须重新
`npm run build` 再 `next start`**，否则伺服的是上次构建快照（`next dev` 每次访问现编译，不受影响）。

## 功能规格（PRD 为唯一出处）

本 README 只保留运行时与仓库本身的说明；功能行为的唯一出处是
[StudyMate-Web_PRD.md](StudyMate-Web_PRD.md)，逐条以 PRD 对应章节为准。

- **工作区与发现**：布局同构 `<工作区>/.learning/subjects/<slug>/`，发现复用上游 `learn_workspace()`（Web 不实现第二份规则），设置页可查看 / 改选，新对话可绑定会话级工作区。→ PRD §9、§5.1
- **模型配置**：多提供商（激活制 + 启用开关）、三种 API 格式（OpenAI 兼容 / Responses / Anthropic）、模型级推理档位与最大输出、视觉能力判定与错误码剔除、系统提示词；`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 可覆盖当前使用提供商。→ PRD §1–§3、§6
- **聊天页与右侧边栏**：`/chat` 两态、新对话「科目 + 工作区」关联行、聊天页与课程图谱页共用的可折叠可拖拽右栏。→ PRD §5.1–§5.4
- **消息操作与「中间过程」**：复制 / 编辑＝截断重发 / 删除整轮，助手名称栏，思维链与工具调用落库回放。→ PRD §5.5
- **会话流生命周期与有序工具卡（已实施）**：切换会话 / 离开 `/chat` 不打断在飞回复，仅显式停止且只中止当前会话；助手消息按 SSE 顺序记录 `parts`（工具结果原位更新；前端仅合并相邻同类 text/reasoning，notice 独立），**思维链按片段各自折叠、工具卡按流位置常显**，旧消息无 `parts` 回落旧布局；重载最多轮询约 10s、超时给可重试同步错误，不承诺硬刷新续跑。→ PRD §5.6
- **长任务可见性与时长上限**：建课 / 产课编排进度快照与单次墙钟上限（聊天一轮 300s、建课产课派工 1800s，可用 `STUDYMATE_CHAT_MAX_SECONDS` / `STUDYMATE_ORCH_MAX_SECONDS` 覆盖）。→ PRD §13.1
- **附件**：输入框左侧单一 📎 入口（点选 / 拖拽 / 粘贴），受理图片与常见文档，后端解析为文本注入上下文，存储于 `data/uploads/`。→ PRD §4

## 课程工作区

课程数据是 Study-Mate 静态工作区格式，与插件 `.learning` 布局同构：`<工作区>/.learning/subjects/<slug>/`
下的 `subject.yaml` + `curriculum.yaml` + `progress.yaml`（发现规则见上「工作区与发现」）。各子系统规格见 PRD 对应章节：

- **提示词分层**：persona + 按链路注入 `.dsh/skills/<名>/SKILL.md` 全文，缺失即 503。→ PRD §10
- **课程 API 与状态机**：课程 CRUD、大纲写回校验、节点进度状态机（非法流转 409）；评估通过为权威置位并写学习记录。→ PRD §11
- **开场状态切片**：首条消息且已关联科目时注入共享记忆 + 最近误解 / 学习记录 / 评估记录，并按「每轮以『下一步』收尾」节奏。→ PRD §11
- **课程页 `/courses`**：不带 `?subject=` 是「我的课程」（内嵌工作区主页 iframe），带参数是科目图谱页；产课 / 评估改由聊天 agent 工具发起。→ PRD §5.4、§13
- **课件与判分**：`/lesson` iframe 挂载课件，页内选择题由上游 quiz.js 判分，开放题「判分 lite」强制引用作答原文证据。→ PRD §2、§13
- **附件区**：聊天页右栏列出术语表 / 本地资料 / 学习记录 / 会话摘要，按会话绑定的工作区读取。→ PRD §11
- **概念本**：`/misconceptions` 双落点 CRUD（`progress.misconceptions[]` + `misconceptions.yaml`），节点详情与 Chat 消息均可一键记入。→ PRD §5.5
- **评估与小结**：评估由 agent 工具生成 front matter 记录（jsonschema 校验）并置位；小结落 `sessions/<日期>.md`、同日按段追加（入口当前悬空）。→ PRD §11
- **共享记忆（MEMORY.md）**：后端建议 → 用户逐条确认 → 增量插入对应分节（去重）；当前仅保留评估通过后的入口。→ PRD §12
- **静态导出 / 科目生成**：导出为整科目拷贝 + 子进程 `gen_home.py` 主页；生成走五项向导 → LLM 草稿 → `check_curriculum.py` 门禁。→ PRD §13

## 后端单测

`backend/tests/` 用 pytest + FastAPI TestClient，自带隔离运行时环境（临时工作区/数据目录/配置路径 +
`STUDYMATE_E2E_FIXTURE=1`，不外呼 LLM、不碰开发数据）：

```bash
cd backend
.venv/Scripts/pip install -r requirements-dev.txt   # 首次：pytest + httpx
.venv/Scripts/python.exe -m pytest tests             # Windows；Linux/macOS 用 .venv/bin/python
```

**依赖锁定**：`requirements.lock.txt`（runtime，hash `a7f39ff6…`）与 `requirements-dev.lock.txt`
（dev superset，hash `478de396…`）由 **uv 0.11.14 universal + hash** 生成；已在本机
**`pip --require-hashes` 安装 + `pip check` 通过（Windows / Python 3.13.11）**。本地开发用 `backend/.venv`
未改动；**Linux 端尚未实装、CI 未在远端执行**。

覆盖系统层行为：工作区发现与写回、技能规范注入、开场状态切片、评估联升与学习记录、共享记忆、工具化 agent 循环、
消息级操作、推理档位兼容、会话级模型绑定、建课链正确性等。用例条数以 `pytest tests` 输出为准；唯一 skip 是
`tests/test_smoke_real_llm.py::test_tool_loop_against_real_provider`（`SMOKE_REAL_LLM!=1` 门控）。

**真实 LLM 冒烟（默认跳过）**：`tests/test_smoke_real_llm.py` 真连一次配置渠道的工具循环——
设 `SMOKE_REAL_LLM=1` 才跑（`SMOKE_MODEL` 钉死模型、`SMOKE_SETTINGS` 换设置路径）；口径为串行不并发：

```bash
SMOKE_REAL_LLM=1 SMOKE_MODEL=space-bunny-alpha .venv/Scripts/python.exe -m pytest tests/test_smoke_real_llm.py -s -q
```

## E2E 测试

Playwright + 后端确定性 fixture 模式（`STUDYMATE_E2E_FIXTURE=1`），**无需真实 API Key**：

```bash
cd frontend
npx playwright install chromium   # 首次
npm run test:e2e                  # 自动拉起后端(8290, fixture) + 前端 dev(3810) 并跑关键旅程
```

运行口径：E2E / 探索各用独立 `distDir`（`STUDYMATE_NEXT_DIST`：E2E=`.next-e2e`、探索=`.next-explorer`，默认 `.next`），
避免与本地 dev 争用构建目录；**这是目录级隔离，不是完全文件副本隔离**——`next-env.d.ts` / `tsconfig` 仍会被 Next 改写。
后端命令按平台取 venv python（见 [E2E 测试流程](StudyMate-Web_E2E测试流程.md) §5.1）。

覆盖聊天发送与流式回复、附件上传与渲染、对话壳层、新对话关联行与会话级工作区绑定、消息操作与「中间过程」、
会话级模型与档位、工具卡与 agent 工具产课 / 评估、概念本、课程页、评估流转、静态导出、提供商与模型编辑、
工作区设置、附件区、暗色模式等关键旅程（含会话流生命周期 `chat-stream-lifecycle.spec.ts`、任务卡
`production-task.spec.ts`、展示原文 `display-content.spec.ts`、旧工单恢复 `legacy-ticket-recovery.spec.ts` 等）。
**本轮定稿：E2E 88 = 85 passed + 3 skipped（0 failed）**，其中渲染矩阵 **8（light 4 / dark 4）**；3 条 skip 是
「生成小结」与聊天侧「沉淀记忆」用例（这两个入口 2026-10-04 起悬空，接回后摘掉 `test.skip` 即恢复）。
fixture 模式只影响测试进程，未设该变量时后端行为不变。

## 组件测试

vitest + Testing Library（jsdom），把旅程级 E2E 射程外的状态分支（空 key / 空模型列表 / 无科目 prefill）
下沉到组件层，**无需后端与 fixture**：

```bash
cd frontend
npm run test:component            # 全部组件用例（tests/component/）
```

组件层与 E2E、后端 pytest 同为本地跑口径，不进根 `npm test` 门禁（条数以 `npm run test:component`
输出为准）。用例明细见 [StudyMate-Web_E2E测试流程.md](StudyMate-Web_E2E测试流程.md) §2.3 P4。

## 探索测试（按需）

另有「探索 agent」harness：LLM 驱动真实浏览器模拟用户完成既定目标（如"不关联科目时把回复记入概念本"），逐步点击直到完成或碰壁，产出墙壁报告供分级。它是**发现层，不是门禁**——不像 E2E 那样改完必跑，但完成较重要的 UI/后端变更后应提醒维护者是否跑一遍：

```bash
cd frontend
EXPLORER_GOAL=tests/explorer/goals/g5-canonical-misconception.md npm run explore
```

用法、目标编写规范与已知边界见 [StudyMate-Web_探索测试指南.md](docs/StudyMate-Web_探索测试指南.md)。

## 部署边界（本机优先，勿默认公网）

本运行时按**本机 / 本地信任**设计：后端与前端默认监听本机（前端由 Next 以 `0.0.0.0` 绑定），
**没有账号与鉴权**，CORS 为通配；工作区可通过设置页或 `?workspace=` 指向**任意已存在的绝对目录**，
课件 / 主页的资源路由也按该信任模型只读服务。

因此**不要把它直接暴露到公网，也不要在不可信网络上开放端口**：能访问该 API 的人可能读到
**当前进程可读的任意本机文件**（不只是学习数据）。

**维护者已裁定（2026-10-05）**：本运行时按「本机个人使用」定位——即**每个使用者各自在本机单人使用**
（**不是"仅维护者自用"**），且该定位**不等于放弃工程质量保障**；本轮**不新增鉴权 / 来源白名单 /
监听绑定改造，也不新增多租户 / 账号身份体系**——故上述边界即当前预期范围，不宣称已具备公网 /
多用户部署能力。若要对外或多用户使用，须另行拍板并先补齐这些能力（决策留痕见
[Web_CHANGE.md](Web_CHANGE.md)，安全边界事实见 `docs/archive/审查报告-2026-10-05.md`）。
工程质量保障方面，已落地**最小 ESLint**（flat config）与**独立 Web CI**（Node24 / Py3.13，覆盖
pytest / lint / 组件 / build + **少量 E2E smoke**——**CI 只跑 smoke，不是 full E2E 回归**）与
**uv universal + hash 依赖锁**（`pip --require-hashes` 安装 + `pip check` 已通过）。**本轮已完成定稿**：
最终门禁全过（后端 pytest 408 passed / 1 skipped、组件 98 passed · 14 文件、E2E 88 = 85 passed + 3 skipped、
CI smoke 5 passed、lint 0 errors / 51 warnings、`tsc` / `build` / `compileall` / `import` / 根 `npm test` 全部 exit 0）。
**唯一剩余：CI / lock 远端未 push、未在 GitHub 执行**（待维护者授权 commit + push）——故**不写远端通过**；
完整快照见[E2E 测试流程](StudyMate-Web_E2E测试流程.md) 顶部与 `Web_CHANGE.md`「最终验证收尾」，
规划见[开发与计划](StudyMate-Web_开发与计划.md) §5。

## 版本

- 当前版本：**0.7.0-beta**。
- StudyMate Web 遵循语义化版本控制；该版本号**仅标识 StudyMate Web 本身**（前后端一体），
  与上游项目 `@yunmiao/studymate` 的版本相互独立。
- 版本号唯一记录处：本节与代码内版本常量（`frontend/package.json`、后端 `app/main.py`、
  侧边栏底栏自动读取 package.json）。**版本变更需维护者知会同意后方可写入。**

## 后续方向

- 质量补强：真实 LLM 下参评模型最终都会落质检工单（上游检查器比模型严格），出题规范执行是共同短板；
  判题/评估质量可随模型迭代再冒烟对比（口径见《E2E 测试流程》§5 冒烟记录）。
- 真实 LLM 冒烟固化：把进程内冒烟脚本整理成 `SMOKE_REAL_LLM=1` 门控的 Playwright project（默认跳过）。
