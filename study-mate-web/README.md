# StudyMate Web

StudyMate 的独立 Web 前端与运行时。当前进度：**阶段 1–3 已完成**（课程图谱、learn-with-doing 闭环、模型提供商与附件体系），当前版本见文末「版本」一节。

- 后端：FastAPI + 多协议 LLM 适配层 + SSE 流式 + 课程工作区（YAML）
- 前端：Next.js 16 + React 19 + Tailwind + cytoscape 图谱
- 测试：Playwright E2E（后端确定性 fixture 模式，无需真实 API Key）

## 目录结构

```
study-mate-web/
├── start-web.bat              # 一键启动（双击即可）
├── data/                      # 运行时数据（settings、sessions、workspace、uploads、exports）
├── backend/
│   ├── app/
│   │   ├── main.py            # 入口（lifespan：种子工作区、上传清扫）
│   │   ├── config.py          # settings v2 读写（providers[] + active + system_prompt）
│   │   ├── models.py          # Pydantic 模型
│   │   ├── storage.py         # 文件型会话存储（消息可带附件元数据）
│   │   ├── llm.py             # 统一 LLM 适配层（openai_chat / openai_responses / anthropic）
│   │   ├── multimodal.py      # 视觉能力判定、图片注入/占位、错误码剔除重试
│   │   ├── doc_extract.py     # 附件文档解析（pdf/docx/xlsx/pptx/epub/文本类）
│   │   ├── curriculum_store.py# 课程仓储层（subject/curriculum/progress.yaml）
│   │   ├── misconceptions.py  # 概念本双落点存储
│   │   ├── records.py         # 评估/小结 front matter 解析与落盘（jsonschema 校验）
│   │   └── routers/           # chat（SSE+课程联动+附件）、courses、uploads、settings、
│   │                          # lessons、misconceptions、practice、records、export、generate
│   └── seed/                  # 首次运行的示例科目（computer-networks / linear-algebra）
└── frontend/
    ├── app/            # /chat、/courses、/misconceptions、/lesson、/generate、/settings/*
    ├── components/     # 聊天（ChatView/Composer/RightSidebar/ModelSelector）、RightRail（可折叠可拖拽的
    │                   # 右侧边栏外壳，聊天页与课程图谱页共用）、图谱、概念本、课件、
    │                   # 设置（settings/ProvidersView、settings/ModelEditDialog、SystemPromptView、AboutView）
    ├── lib/            # api 客户端、SSE 解析、workspace 全局上下文（含按会话的草稿缓存）、useResizable
    ├── public/         # 站点资产（icon-192.png 品牌图标，供标签页与侧边栏使用）
    ├── tests/e2e/      # Playwright 关键旅程
    └── playwright.config.ts
```

## 启动

### 方式一：一键启动（推荐）

双击 `start-studymate.bat`：首次运行自动创建虚拟环境并安装依赖，之后每次启动后端
（8101）+ 前端（3800，有生产构建时用 `next start`，否则 `next dev`），就绪后自动打开浏览器。
停止服务：关闭"StudyMate 后端"与"StudyMate 前端"两个窗口。

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

## 配置模型

设置页为二级界面：左侧导航（**模型提供商** / 系统提示词 / 关于），右侧内容区。

### 模型提供商

- **多提供商列表 + 激活制**：预设四种（DeepSeek / SiliconFlow / DashScope / OpenAI）不可删除但全部字段可改、可"恢复默认"；可添加多个自定义提供商，可删。提供商带**启用开关**，停用后不能作为当前使用、其模型也不再出现在聊天侧的模型选择里。
- 每个提供商配置：名称、Base URL、API Key（**回填已保存的密钥**，以密码点显示、可切换明文；不会把密钥从界面上"吞掉"）、**API 格式**（三选一：OpenAI 兼容 Chat Completions / OpenAI Responses / Anthropic Messages）、模型列表。
- 模型列表为**只读摘要行**：模型名 + 徽标（上下文窗口 / 模态 / `思考 · <档位>`）+ 四个操作（**测试** / **编辑** / **删除** / 启用开关）；"＋ 添加模型"打开编辑弹窗。
- **模型编辑弹窗**（字段口径对齐 ZCode）：基础区 = 模型 ID、显示名、**输入模态复选框组（文本 / 图片 / 视频 / PDF）**、**最大输出 Token**、上下文窗口；**高级折叠区** = 推理档位的**有序 chip 编辑器**（可增删改与排序）+ 默认档位 + 能力声明开关（工具调用 / JSON Schema 输出 / 原生联网搜索，仅落盘与展示）。**全部人工填写，不提供自动探测（无"智能配置"）**。
- 编辑器动作：**保存**、**测试连接**（按表单当前值发一次最小请求，显示耗时或上游错误）；清空输入框时会回落使用该提供商已保存的 Key，不会误报"缺少 API Key"。
- 聊天侧"提供商 / 模型"快捷选择器位于**输入框内底部**，切换即全局生效，无需进设置；当前模型启用了推理时，下拉里可切换档位（见下）。
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

- 聊天页：右侧边栏装会话关联（科目 / 节点 / 生成小结）与会话信息（消息数 / 创建时间 / 关联科目），折叠按钮在顶栏最右。
- 课程图谱页：**节点详情就在右侧边栏里**（默认展开），折叠按钮在图区；画布随宽度变化自适应。

## 附件

聊天输入框左侧单一 📎 入口（文件与图片统一），支持点选、拖拽、粘贴；仅附件、无文字也可发送。

- 受理：`image/*`（SVG 归文档类）+ 文本类（md / txt / csv / json / xml / 常见源码）+ pdf / docx / xlsx / pptx / epub；单附件 ≤20MB，单条消息 ≤10 个。
- 文档在后端解析为文本（"附件：<文件名>"标题块拼在消息原文后进入上下文）：pdf 用 pymupdf（缺则回退 pypdf），docx / xlsx / pptx / epub 各有专用解析，文本类多编码回退解码；单附件提取上限 2 万字符、单消息合计 6 万，超限截断；解析失败以占位提示，不阻断发送。
- 上传存储于 `data/uploads/`；删除会话时连带清理其上传文件。

## E2E 测试

Playwright + 后端确定性 fixture 模式（`STUDYMATE_E2E_FIXTURE=1`），**无需真实 API Key**：

```bash
cd frontend
npx playwright install chromium   # 首次
npm run test:e2e                  # 自动拉起后端(8290, fixture) + 前端 dev(3810) 并跑关键旅程
```

覆盖（共 37 条，两轮幂等）：聊天发送与流式回复、附件上传与消息渲染、输入框草稿按会话缓存、对话壳层（顶栏 + 右侧边栏的折叠与拖拽）、概念本增删与筛选、课程图谱与课件（节点详情右侧边栏）、评估与状态流转、静态导出、提供商配置与模型行四操作、模型编辑弹窗（模态复选框 / 最大输出 Token / 高级档位编辑器）、侧边栏拖拽调宽、暗色模式持久化。fixture 模式只影响测试进程，未设该变量时后端行为不变。

## 课程工作区（阶段 2/3 已交付）

课程数据是 Study-Mate 静态工作区格式：`data/workspace/subjects/<slug>/`
下的 `subject.yaml` + `curriculum.yaml` + `progress.yaml`（环境变量
`STUDYMATE_WORKSPACE` 可指向已有 `.learning/subjects` 工作区；目录为空时自动
从 `backend/seed/` 种入两个示例科目）。

- **课程 API 与状态机**：课程 CRUD、大纲写回校验、节点进度状态机
  （未开始 → 学习中 → 初步理解 → 能独立应用 → 已通过项目验证，任意非初始可转
  "需要复习"；非法流转 409），progress.yaml 覆盖 curriculum 初始快照（与上游口径一致）。
- **图谱页 `/courses`**：科目列表 + cytoscape 图谱 + 节点详情（状态流转、掌握度、笔记、
  实验节点 lab 状态、"打开课件"、"申请评估"、"记入概念本"）。
- **课件与判分**：`/lesson` 页 iframe 零改动挂载已有课件（页内选择题由上游 quiz.js 判分）；
  开放题"判分 lite"强制引用作答原文证据；工作区级共享资源（KaTeX/主题）由
  `/api/courses/assets/*` 兜底，课件页内零断链。
- **概念本**：`/misconceptions` 双落点 CRUD（`progress.misconceptions[]` + `misconceptions.yaml`），
  节点详情与 Chat 消息均可一键记入。
- **评估与小结**：节点"申请评估"生成 front matter 记录（jsonschema 按仓库 `schemas/` 校验），
  通过后走状态机更新；Chat"生成小结"落盘 `sessions/<日期>.md`。
- **静态导出**：整科目拷贝 + 子进程调用上游 `scripts/gen_home.py` 生成静态主页，
  通过上游门禁校验。
- **科目生成**：五项向导 → LLM 草稿 → 子进程 `check_curriculum.py` 当门（PASS 才收）。

## 版本

- 当前版本：**0.4.0-beta**。
- StudyMate Web 遵循语义化版本控制；该版本号**仅标识 StudyMate Web 本身**（前后端一体），
  与上游项目 `@yunmiao/studymate` 的版本相互独立。
- 版本号唯一记录处：本节与代码内版本常量（`frontend/package.json`、后端 `app/main.py`、
  侧边栏底栏自动读取 package.json）。**版本变更需维护者知会同意后方可写入。**

## 后续方向

- 真实模型端到端验证（本地无 Key：三格式真实调用、流式、判分/评估生成质量）
- 文档内嵌图片提取与 OCR、lab 代码沙箱执行、跨科目共享记忆写侧
