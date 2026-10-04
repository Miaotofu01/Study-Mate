# StudyMate Web

StudyMate 的独立 Web 前端与运行时。当前进度：**阶段 1–3、全功能复现队列 A~J、K 系列工具化改造（K0–K3）、第二轮 UI 杂项轮全部完成**（课程图谱、learn-with-doing 闭环、模型提供商与附件体系、工作区同构与发现（含**会话级工作区绑定**）、提示词分层、记录与记忆写侧；生产侧：节点产出、建课链、采图、方向探索与质检工单，已经真实 LLM 冒烟验证；工具化：agent 循环、只读/写工具、工具卡与审计落盘；UI：新对话关联行、推理档位下拉、课程页右栏分段切换与科目总览、侧边栏折叠成图标轨），当前版本见文末「版本」一节。

- 后端：FastAPI + 多协议 LLM 适配层 + SSE 流式 + 课程工作区（YAML）
- 前端：Next.js 16 + React 19 + Tailwind + cytoscape 图谱
- 测试：Playwright E2E（后端确定性 fixture 模式，无需真实 API Key）+ vitest 组件测试（分支逻辑下沉，无需后端）+ 按需的探索 agent 测试（见「探索测试」一节）

## 目录结构

```
study-mate-web/
├── start-web.bat              # 一键启动（双击即可；源码比构建新时会自动重新构建）
├── stop-web.bat               # 一键停止（双击即可；连服务窗口与残留孤儿进程一起收掉）
├── tools/studymate-web.ps1    # 启动器助手：构建新鲜度判定 + 按端口停止服务（纯 ASCII）
├── data/                      # 运行时数据（settings、sessions、drafts、audit、uploads、exports）
├── backend/
│   ├── app/
│   │   ├── main.py            # 入口（lifespan：建工作区目录、上传清扫）
│   │   ├── config.py          # settings v3 读写（providers[] + active + system_prompt）
│   │   ├── models.py          # Pydantic 模型
│   │   ├── storage.py         # 文件型会话存储（消息可带附件元数据）
│   │   ├── llm.py             # 统一 LLM 适配层（三格式 + 工具声明/流式 tool_call 聚合 + stream_turn）
│   │   ├── agent.py           # 工具化 agent loop runner（预算/降级/重复提醒/事件回吐）
│   │   ├── tools.py           # 工具注册表 + 沙箱边界（读写根 allow-list、写前 canonicalize）
│   │   ├── audit.py           # 编排审计 data/audit/*.jsonl（派工值/回复/工具调用，失败不清除）
│   │   ├── multimodal.py      # 视觉能力判定、图片注入/占位、错误码剔除重试
│   │   ├── doc_extract.py     # 附件文档解析（pdf/docx/xlsx/pptx/epub/文本类）
│   │   ├── curriculum_store.py# 课程仓储层（<WS>/.learning/subjects/<slug>/*.yaml）
│   │   ├── workspace.py       # 工作区发现（复用上游 learn_workspace()）+ 配置写回
│   │   ├── workspace_ctx.py   # 请求级工作区绑定（会话级工作区的唯一收口点，见 curriculum_store.workspace_dir()）
│   │   ├── prompts.py         # 提示词分层：persona + 按链路注入 .dsh/skills/<名>/SKILL.md
│   │   ├── roles.py           # 角色派工基建（SKILL 全文注入 + envelope 落盘/搬位 + 归属映射）
│   │   ├── produce.py         # 产课链编排（派工 → 渲染 → 检查 → 打回 → 工单）
│   │   ├── build.py           # 建课链编排（大纲 + 采图并行 → 门禁 → 落盘）
│   │   ├── draft.py           # 建课草稿区 + 落点确认（promote）
│   │   ├── image_scout.py     # 采图（纯后端爬虫）
│   │   ├── tickets.py         # 质检工单存储与分组
│   │   ├── memory.py          # 跨科目共享记忆 MEMORY.md（读侧 + 确认后增量写）
│   │   ├── misconceptions.py  # 概念本双落点存储
│   │   ├── records.py         # 评估/小结/学习记录落盘（front matter + jsonschema 校验）
│   │   └── routers/           # chat（SSE+课程联动+附件+开场切片+工具事件）、courses、uploads、settings、
│   │                          # workspace、lessons、misconceptions、practice、records、memory、export、generate、production
│   ├── tests/                 # pytest 后端单测（隔离环境 + fixture 后端，见「后端单测」）
│   ├── requirements-dev.txt   # 测试依赖（pytest / httpx）
│   └── seed/                  # 示例科目（供 E2E fixture 与建课演示；启动不再自动种入）
└── frontend/
    ├── app/            # /chat、/courses、/misconceptions、/lesson、/generate、/settings/*（含 settings/theme、settings/workspace）
    ├── components/     # 聊天（ChatView/Composer/RightSidebar/ModelSelector）、RightRail（可折叠可拖拽的右侧边栏
    │                   # 外壳，聊天页与课程图谱页共用）、图谱、概念本、课件、InspectionDialog（质检工单）、
    │                   # MemoryDialog 与 WorkspaceOnboarding（入口已移除、悬空保留）、
    │                   # 设置（settings/ProvidersView、settings/ModelEditDialog、settings/ThemeView、
    │                   # settings/WorkspaceView、SystemPromptView、AboutView）
    ├── lib/            # api 客户端、SSE 解析、workspace 全局上下文（会话级工作区 + 科目选中态 + 按会话的草稿缓存）、useResizable
    ├── public/         # 站点资产（icon-192.png 品牌图标，供标签页与侧边栏使用）
    ├── tests/e2e/      # Playwright 关键旅程
    ├── tests/component/# vitest 组件测试（分支逻辑下沉，见「组件测试」）
    ├── tests/explorer/ # 探索 agent harness（目标库见《探索测试指南》）
    ├── vitest.config.ts
    └── playwright.config.ts
```

## 启动

### 方式一：一键启动（推荐）

双击 `start-web.bat`。首次运行自动创建虚拟环境并安装依赖；此后每次启动会先比对
「前端源码时间 vs 上次构建时间」，**源码更新过就自动重新构建**（约 1~2 分钟），
避免出现"重启了却看不到改动"——生产模式下 `.next` 是构建期快照，`next start` 不会
重新编译，所以只重启进程是看不到源码改动的。随后拉起后端（8101）+ 前端（3800），
就绪后打开浏览器并自动关闭启动器窗口。

- 服务跑在各自的「StudyMate 后端」「StudyMate 前端」窗口里，**关掉哪个窗口就停哪个服务**；
  启动器自己的窗口关掉不影响服务。
- **一键全停：双击 `stop-web.bat`**（等同 `start-web.bat stop`）。它按端口找到监听进程，
  连同服务窗口与残留孤儿进程一起结束——进程被强杀（任务管理器结束任务等）留下的孤儿
  也能清掉，这类孤儿会让端口一直被占、浏览器连到旧实例。
- 启动前预检 8101 / 3800：已被占用时不重复启动，而是报出占用 PID 与停止方式，
  避免新旧实例重叠。
- 可选参数：`start-web.bat dev` 强制开发模式（热编译、跳过构建）；`restart` 先停再启；
  `stop` 停止；`help` 帮助。
- 端口可用环境变量覆盖：`SM_WEB_BACKEND_PORT` / `SM_WEB_FRONTEND_PORT`。

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

前端通过 Next.js rewrites 把 `/api/*` 同源代理到后端（环境变量
`BACKEND_PORT` / `BACKEND_ORIGIN` 可覆盖后端地址）。注意：Next 16 生产构建会在
`next build` 时把代理目标固化进 `.next/routes-manifest.json`，`next start` 运行期
设置这两个变量不生效（`next dev` 是运行期读取）；改后端端口时生产模式需重新 build，
默认 8101 不受影响。

手动跑生产模式还有一条：**改完前端源码要重新 `npm run build` 再 `next start`**，
否则伺服的一直是上次构建的快照（"重启了却看不到改动"就是这个原因）；`next dev`
则每次访问现编译，不受影响。

## 工作区

Web 与插件共用同一套工作区与发现规则，布局同构：`<工作区>/.learning/subjects/<slug>/`
（科目 yaml、课件、评估记录、学习记录、会话摘要都在这一个科目目录下）。Web **不再自动种入示例科目**——
默认工作区可能正是插件在用的目录，示例只保留在 `backend/seed/` 供 E2E 与建课演示使用。

- **发现优先级**（复用上游 `scripts/gen_home.py::learn_workspace()`，Web 不实现第二份规则）：
  显式 `STUDYMATE_WORKSPACE` > `LEARN_WORKSPACE` > `STUDYMATE_CONFIG`（默认
  `$DSH_HOME/studymate-config.yaml`）里的 `workspace` 字段 > 插件默认 `~/StudyMate`。
- **设置页「工作区」子页**：查看当前路径、来源、科目数与配置文件位置；可改选目录——
  写进 `studymate-config.yaml` 的 `workspace` 键（保留注释与其它键），保存后立即生效、无需重启。
- **新对话内的关联行**：`/chat` 新对话态的输入框上方有「关联科目 + 工作区」两个并排下拉（发出第一条消息后即隐藏）。
  工作区默认选「默认工作区」（= 当前发现路径），候选为发现路径 / 插件默认 / 环境变量覆盖；选中后该会话**绑定**到该工作区
  （科目列表跟着切换，会话内的一切科目读写都在它自己的工作区里）。绑定要求目录已存在。
- 工作区目录按需创建；科目为空时课程页显示空态，走 `/generate` 建课。

## 配置模型

设置页为二级界面：左侧导航（**模型提供商** / 系统提示词 / **工作区** / 关于），右侧内容区。

### 模型提供商

- **多提供商列表 + 激活制**：预设四种（DeepSeek / SiliconFlow / DashScope / OpenAI）不可删除但全部字段可改、可"恢复默认"；可添加多个自定义提供商，可删。提供商带**启用开关**，停用后不能作为当前使用、其模型也不再出现在聊天侧的模型选择里。
- 每个提供商配置：名称、Base URL、API Key（**回填已保存的密钥**，以密码点显示、可切换明文；不会把密钥从界面上"吞掉"）、**API 格式**（三选一：OpenAI 兼容 Chat Completions / OpenAI Responses / Anthropic Messages）、模型列表。
- 模型列表为**只读摘要行**：模型名 + 徽标（上下文窗口 / 模态 / `思考 · <档位>`）+ 四个操作（**测试** / **编辑** / **删除** / 启用开关）；"＋ 添加模型"打开编辑弹窗。
- **模型编辑弹窗**（字段口径对齐 ZCode）：基础区 = 模型 ID、显示名、**输入模态复选框组（文本 / 图片 / 视频 / PDF；未配置过的模型默认勾选「文本」）**、**最大输出 Token**（默认 32000）、上下文窗口（默认 2560000）；**高级折叠区** = 推理档位的**有序 chip 编辑器**（可增删改与排序）+ 默认档位（**启用推理时预置 `disabled / enabled` 两档、默认档位取最高档**）+ 能力声明（**工具调用默认对所有模型开启**（2026-10-04），界面为只读提示、无开关；上游拒绝 tools 时自动回落纯文本；JSON Schema 输出 / 原生联网搜索两个开关仅落盘与展示）。**全部人工填写，不提供自动探测（无"智能配置"）**，也没有模型级「启用」开关。
- **编辑即生效**：提供商页**没有「保存」按钮**——所有改动防抖自动落盘，头部只给"保存中… / 已保存"提示；**连接测试入口是模型行上的「测试」**（按该行模型发起，显示耗时或上游错误）；清空输入框时会回落使用该提供商已保存的 Key，不会误报"缺少 API Key"。
- 聊天侧"提供商 / 模型"快捷选择器位于**输入框内底部**，切换即全局生效，无需进设置；**推理档位是它右侧的独立下拉**（当前模型没有档位时隐藏，见下）。
- 也可用环境变量 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 覆盖当前使用提供商的对应字段（优先级最高，不写盘）。
- 旧配置在首次加载时自动迁移（单提供商 → 多提供商；旧的 `视觉覆盖`/`思考档位` → 输入模态/推理档位），API Key 不丢失，迁移幂等不再重写。

### 三种 API 格式

聊天（流式）与判分 / 评估 / 小结 / 科目生成（非流式）全部经统一适配层：OpenAI 兼容
请求 `{base}/chat/completions`；Responses 请求 `{base}/responses`（系统提示词走
instructions）；Anthropic 请求 `{base}/v1/messages`（`x-api-key` 头、system 独立参数、
`max_tokens` 默认 4096）。JSON 输出模式在 Anthropic 下以提示词约束替代。

### 推理档位与最大输出（模型级能力）

模型可声明一组**有序推理档位**（默认 `off / low / medium / high`，可在模型编辑弹窗里自由增删改与排序，
例如换成 `off / high / max`）以及**最大输出 Token**。档位由统一适配层翻译为各协议参数：Chat Completions 走
`reasoning_effort`，Responses 走 `reasoning.effort`，Anthropic 走 `thinking: {type: enabled,
budget_tokens}`（并把 `max_tokens` 抬到预算之上）。**模型未启用推理、档位列表为空、或档位为 `off` 时
不发送任何思考参数**，其余调用与未启用时完全一致；Responses / Anthropic 在开启推理时不发送
`temperature`。最大输出 Token 非空时作为该模型的输出上限（Anthropic 的 `max_tokens` 等），为空沿用默认值。

### 视觉能力与自动剔除

- 图片附件按模型视觉能力注入：支持则按 API 格式转为对应图片块；不支持则替换为"[图片：<文件名> —— 当前模型不支持图片输入，已剔除]"文本占位，并以内联提示告知。
- 视觉能力判定：模型配置了**输入模态**就以其中的"图片"项为准（显式配置压过内置表）；**未配置模态**时按内置模型前缀表判断。模态里的"视频 / PDF"目前只落盘与展示。
- 若带图请求被上游以模态相关错误拒绝，系统自动剔除图片重试一次并提示；已知视觉模型不降级，真实错误原样暴露。
- 视频 / 音频附件当前一律按占位处理，不实际发送。

## 右侧边栏

聊天页与课程图谱页共用一个可折叠的右侧边栏：**可拖拽调宽**（宽度按页面分别持久化到 localStorage）、
**折叠带宽度过渡动画**（尊重系统"减少动态效果"偏好），收起时内容保持挂载（`inert` + `aria-hidden`），
不会因为折叠丢掉区段状态。

- 聊天页：右侧边栏装**附件区**（术语表 / 本地资料 / 学习记录 / 会话摘要，点击新标签页打开；按该会话绑定的工作区读取）
  与会话信息（消息数 / 创建时间 / 关联科目），折叠按钮在顶栏最右。**科目关联与"生成小结"不在右栏**——关联在输入区上方的关联行里
  （只在新对话态出现）；「生成小结」与聊天侧「沉淀记忆」入口**暂时悬空**（后端保留，待重新接线）。
- 课程图谱页：右栏顶部是**「图谱（默认）/ 大纲」分段切换**（切换不重建画布，画布右下角有「重置视口」）；主区是节点详情。

## 附件

聊天输入框左侧单一 📎 入口（文件与图片统一），支持点选、拖拽、粘贴；仅附件、无文字也可发送。

- 受理：`image/*`（SVG 归文档类）+ 文本类（md / txt / csv / json / xml / 常见源码）+ pdf / docx / xlsx / pptx / epub；单附件 ≤20MB，单条消息 ≤10 个。
- 文档在后端解析为文本（"附件：<文件名>"标题块拼在消息原文后进入上下文）：pdf 用 pymupdf（缺则回退 pypdf），docx / xlsx / pptx / epub 各有专用解析，文本类多编码回退解码；单附件提取上限 2 万字符、单消息合计 6 万，超限截断；解析失败以占位提示，不阻断发送。
- 上传存储于 `data/uploads/`；删除会话时连带清理其上传文件。

## 后端单测

`backend/tests/` 用 pytest + FastAPI TestClient，自带隔离运行时环境（临时工作区/数据目录/配置路径 +
`STUDYMATE_E2E_FIXTURE=1`，不外呼 LLM、不碰开发数据）：

```bash
cd backend
.venv/Scripts/pip install -r requirements-dev.txt   # 首次：pytest + httpx
.venv/Scripts/python.exe -m pytest tests             # Windows；Linux/macOS 用 .venv/bin/python
```

覆盖本轮新增的系统层行为：工作区发现三态/校验/写回与回滚、技能规范注入与缺失 503、开场状态切片
（含 canonical 误解源）、评估联升与掌握度「保留或上调」、学习记录落盘、摘要同日多段追加、
共享记忆建议/写入/去重/入参校验、**工具化 agent 循环**（三格式 tools wire 映射 / 流式 tool_call 聚合 /
轮次预算与降级 / 工具沙箱边界 / 审计落盘 / 建课·产课工具循环）。

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

覆盖（53 条通过 + 3 条 skip，0 失败）：聊天发送与流式回复（含「下一步」收尾锚点）、附件上传与消息渲染、输入框草稿按会话缓存、对话壳层（顶栏内联重命名 + 右侧边栏折叠与拖拽）、**新对话「科目 + 工作区」关联行与会话级工作区绑定**（`new-session-association.spec.ts`）、**左侧边栏折叠成图标轨**（`sidebar-collapse.spec.ts`）、**工具化 agent 循环的工具卡呈现**（`tool-cards.spec.ts`）、概念本增删与筛选、课程图谱与课件（主区节点详情 + 右栏「图谱/大纲」分段切换；科目绑定锁定；**科目状态与进度总览**）、评估与状态流转（**含实验课联升与学习记录落盘**）、静态导出、提供商配置与模型行四操作、模型编辑弹窗（模态复选框 / 最大输出 Token / 高级档位编辑器）、**输入区推理档位下拉**、**工作区设置查看与切换**、**附件区清单与原文可读**、**评估通过后的沉淀记忆入口 → 逐条确认写入**、暗色模式持久化。3 条 skip 是「生成小结」与聊天侧「沉淀记忆」用例——这两个入口 2026-10-04 起悬空，后端与组件都保留（接回入口后摘掉 `test.skip` 即恢复）。fixture 模式只影响测试进程，未设该变量时后端行为不变。

## 组件测试

vitest + Testing Library（jsdom），把旅程级 E2E 射程外的状态分支（空 key / 空模型列表 / 无科目 prefill）下沉到组件层，**无需后端与 fixture**：

```bash
cd frontend
npm run test:component            # 全部组件用例（tests/component/）
```

组件层与 E2E、后端 pytest 同为本地跑口径，不进根 `npm test` 门禁。用例明细见 [StudyMate-Web_E2E测试流程.md](StudyMate-Web_E2E测试流程.md) §2.3 P4。

## 探索测试（按需）

另有「探索 agent」harness：LLM 驱动真实浏览器模拟用户完成既定目标（如"不关联科目时把回复记入概念本"），逐步点击直到完成或碰壁，产出墙壁报告供分级。它是**发现层，不是门禁**——不像 E2E 那样改完必跑，但完成较重要的 UI/后端变更后应提醒维护者是否跑一遍：

```bash
cd frontend
EXPLORER_GOAL=tests/explorer/goals/g5-canonical-misconception.md npm run explore
```

用法、目标编写规范与已知边界见 [StudyMate-Web_探索测试指南.md](StudyMate-Web_探索测试指南.md)。

## 课程工作区

课程数据是 Study-Mate 静态工作区格式，与插件 `.learning` 布局同构：`<工作区>/.learning/subjects/<slug>/`
下的 `subject.yaml` + `curriculum.yaml` + `progress.yaml`（发现规则见「工作区」一节）。

- **提示词分层**：默认 persona（主教练口径，可在设置页改）+ 后端按链路注入
  `.dsh/skills/<名>/SKILL.md` 全文——对话注入 `learning-system` + `local-qa`，评估注入
  `practice-evaluator` + `evidence-check` + `record-keeping`，小结注入 `record-keeping`，
  判分注入 `practice-evaluator` + `evidence-check`；技能规范缺失时该次调用明确 503，不静默降级。
- **课程 API 与状态机**：课程 CRUD、大纲写回校验、节点进度状态机
  （未开始 → 学习中 → 初步理解 → 能独立应用 → 已通过项目验证，任意非初始可转
  "需要复习"；非法流转 409），progress.yaml 覆盖 curriculum 初始快照（与上游口径一致）。
  评估通过是权威置位：实验课通过时该节点与 `prerequisites` 里的被验收节点一起置
  "已通过项目验证"，并写一条学习记录（`learning-records/`）。
- **开场状态切片**：会话首条消息且已关联科目时，自动注入共享记忆（`MEMORY.md` 分节，超长截断）+
  最近 5 条误解 + 最近 3 条学习记录 + 最近 3 条评估记录；提示词层要求会话按总控规范的
  "每轮以「下一步」收尾"节奏（提示词行为，真实质量留真实-Key 冒烟，E2E 只守住呈现链路）。
- **图谱页 `/courses`**：科目列表 + cytoscape 图谱 + 节点详情（状态流转、掌握度、笔记、
  实验节点 lab 状态、"打开课件"、"申请评估"、"记入概念本"）。
- **课件与判分**：`/lesson` 页 iframe 零改动挂载已有课件（页内选择题由上游 quiz.js 判分）；
  开放题"判分 lite"强制引用作答原文证据；工作区级共享资源（KaTeX/主题）由
  `/api/courses/assets/*` 兜底，课件页内零断链。
- **附件区**：聊天页右侧边栏列出当前科目的术语表（`GLOSSARY.md`）、本地资料（`reference/`）、
  学习记录与会话摘要，点击新标签页打开原文件。
- **概念本**：`/misconceptions` 双落点 CRUD（`progress.misconceptions[]` + `misconceptions.yaml`），
  节点详情与 Chat 消息均可一键记入。
- **评估与小结**：节点"申请评估"生成 front matter 记录（jsonschema 按仓库 `schemas/` 校验），
  通过后置位并写学习记录；Chat"生成小结"落盘 `sessions/<日期>.md`，**同日多次小结按段追加**不覆盖。
- **共享记忆（MEMORY.md）**：三个入口落到同一套确认流程——Chat 右侧边栏「沉淀记忆」（随时手动）、
  小结结果区的「沉淀记忆（N 条建议）」（会话结束时用小结已产出的 `memory_updates` 预填）、
  评估通过后的「沉淀记忆」（从会话提炼）。后端给出建议条目后，用户逐条勾选/改分节/改内容再确认，
  **增量插进 `.learning/MEMORY.md` 对应分节**（不整篇重写，重复条目自动去重）。
- **静态导出**：整科目拷贝 + 子进程调用上游 `scripts/gen_home.py` 生成静态主页，
  通过上游门禁校验。
- **科目生成**：五项向导 → LLM 草稿 → 子进程 `check_curriculum.py` 当门（PASS 才收）。

## 版本

- 当前版本：**0.5.0-beta**。
- StudyMate Web 遵循语义化版本控制；该版本号**仅标识 StudyMate Web 本身**（前后端一体），
  与上游项目 `@yunmiao/studymate` 的版本相互独立。
- 版本号唯一记录处：本节与代码内版本常量（`frontend/package.json`、后端 `app/main.py`、
  侧边栏底栏自动读取 package.json）。**版本变更需维护者知会同意后方可写入。**

## 后续方向

- 质量补强：真实 LLM 下参评模型最终都会落质检工单（上游检查器比模型严格），出题规范执行是共同短板；
  判题/评估质量可随模型迭代再冒烟对比（口径见《E2E 测试流程》§5 冒烟记录）。
- 真实 LLM 冒烟固化：把进程内冒烟脚本整理成 `SMOKE_REAL_LLM=1` 门控的 Playwright project（默认跳过）。
