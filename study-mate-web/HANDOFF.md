# HANDOFF — StudyMate Web 交接（2026-10-02 · 第四版，实施代理接手 + PR 占位）

> 给下一个接手 `study-mate-web/` 子项目的 agent。**本文只做索引与状态，不重复其他文档的内容**——细节一律走路径。
> 脱敏说明：本子项目不含任何密钥/PII；测试用占位 key 均为假值。

## 一句话现状

功能面：**提供商/模型域已到 schema v3**（对齐开源项目 ZCode 的真实实现：输入模态复选框组 / 最大输出 Token / 上下文窗口 / 推理档位有序 chip 编辑器 / 能力声明；API Key 回填输入框不再掩码吞掉），对话壳层含顶栏瘦身 + 共享右侧边栏（拖拽 + 折叠动画），课程图谱页节点详情也在右侧边栏里；E2E **37 条两轮幂等**。版本号已按维护者要求加后缀：**0.4.0-beta**。
**方向面**：Web 目标是从"只消费已有产物"改为**复现乃至拓展 dsh 插件全功能**，实施队列排好在《开发与计划》§5.1（阶段 A→I），**全队列一行未动**，等实施代理开工。
git：`study-mate-web/` 已从"未跟踪"转为**提交在 `feat/study-mate-web` 分支**上（4 个提交：运行时 / E2E / 子项目文档 / 根 README），并已把 `upstream/main`（d4d731c）并入该分支——**无冲突**（上游那 4 个提交只动了根 `AGENTS.md`、新建 `GLOSSARY.md`、`docs/agents/domain.md`，与我们改的根 `README.md` 不相交）。本地 `main` 已 ff 到 `upstream/main`。
**PR 是占位，尚未创建**：内容已写好待维护者过目（见文末「PR 占位」），**不要当成已完成功能去合并**。

## PR 占位（待维护者过目）

- 目标：`Miaotofu01/Study-Mate:main` ← 来源 `Sodapopper-pixel:feat/study-mate-web`；按根 `CONTRIBUTING.md`，**PR 只能对着 `main`**。
- 性质：**开发中占位**，明确声明不要求被合并；正文里要说清"仍在开发测试，功能稳定性不如插件途径"。
- 门禁：根 `npm test`（CI 在 Ubuntu / Node 24 / Python 3.13 上跑的就是它）。
- 注意：合并 PR **不等于发布**，上游的版本号 / tag / CHANGELOG 由维护者手动触发，别去动；`study-mate-web` 自己那套版本号（当前 `0.4.0-beta`）是本子项目独立的，与上游发布流程无关。

## 接下来做什么（实施代理的主线）

按《开发与计划》§5.1 的阶段顺序推进，**不要跳序**：A 工作区（一切读写的根）→ B 提示词（各链路公共输入）→ 之后 C 产课链 / D 开课链 / E 采图 / G 阅读端壳层可并行 → H 验证集（本轮先做，维护者已选全四项）→ I 记忆写侧。

每个阶段开工前先读该阶段对应的三份东西：《开发与计划》§5.1 对应行、Web_CHANGE 同日两条 grill 留痕、上游 `.dsh/skills/<角色>/SKILL.md` 全文（B 阶段起它就是你的行为规格）。

**硬约束（踩线即返工）**：
- 上游脚本**只复用不重写**（AGENTS.md 硬规矩 3，已含工作区发现复用 `gen_home.py::learn_workspace()`）。
- `/lesson` 维持 iframe 承载上游渲染产物，壳层之外再做交互（Q5）。
- 验证门禁同 AGENTS.md 规则 1；改功能必须同步四份文档（规则 8）。
- 任何 commit/push/tag **必须维护者明确同意**；完成后停在待提交状态报告。

## 已完成但未提交（本次会话的落地）

- 运行时目录 `backend/data/` → `study-mate-web/data/`（`config.WEB_ROOT`/`DATA_DIR`、`curriculum_store.workspace_dir()`、playwright 与 global-setup、`.gitignore`、六处文档路径）。已 `compileall` + 隔离端口 curl 验证。
- **反馈清单轮（2026-10-02）**：10 条反馈全部落地；同轮修掉两处**测试侧路径 bug**——`playwright.config.ts` 的 `WEB_ROOT`（`../..` 算到了仓库根）与 `tests/e2e/constants.ts`（硬拼 `backend/data/`）把 E2E 指到仓库根 `data/`，后端因而读到陈旧 fixture 而大面积失败（`reuseExistingServer` 会复用手工起的正确服务，所以长期不可见）。四处路径口径现已统一，E2E 流程文档 §1 已写明。原 `E2E 25 条` 的结论是在"服务恰好正确"的前提下成立，**不要**用它判断 E2E 是否可信。
- 文档：AGENTS.md 规则 3 扩写 + 规则 4 路径；《开发与计划》新增 §5.1 实施队列与 §5.2 明确不做，backlog #2/#6/#7 改述，本轮再补 #10–#12；Web_CHANGE 追加多条（grill 第一轮、第二轮、反馈清单轮）；E2E 流程映射表加"待翻转行"提示并按本轮口径更新（v1.2，34 条）。
- 决策记忆已写入维护者 memory 库（不在本仓库）。

## 文档地图（先读这几份，按需深入）

| 文档 | 用途 |
|---|---|
| `AGENTS.md`（本目录） | 子项目硬规矩 + 规则 8 文档同步约束 |
| `README.md` | 启动（bat/手动）、配置模型、附件、E2E 运行、版本语义 |
| `StudyMate-Web_开发与计划.md` | **架构现状 + 不变约束 + 领域模型 + §5.1 实施队列 / §5.2 明确不做（你的任务书）** |
| `StudyMate-Web_PRD.md` | 功能规格（描述现状，非计划书；未实施的功能不在里面） |
| `StudyMate-Web_E2E测试流程.md` | 用例 ↔ 上游旅程映射（含"待翻转行"）+ §3.13 实现偏差备注 |
| `Web_CHANGE.md` | 变更史与全部 grill 决策留痕（只追加） |
| `反馈清单.md` | 维护者手写的 10 条 UI / 交互反馈，**已于 2026-10-02 全部落地并逐条回填**（含实现差异备注：模态只覆盖视觉、右侧边栏未做拖拽、草稿刷新归空、未做"智能配置"） |

上游侧事实依据（实施 A/B/C 必读）：`.dsh/skills/learning-system/{lesson-design,layered-practice,record-keeping,practice-evaluator,evidence-check,local-qa,learning-discovery}/SKILL.md`、`scripts/gen_home.py::learn_workspace()`、`scripts/render_lesson.py`、`scripts/check_lesson.py`。

## 已知坑（踩过的别再踩）

- **ZCode 是开源项目**：`github.com/zai-org/ZCode`。设置页形态要对齐它时**去读源码**，别靠截图猜——上一轮靠截图猜，模态做成了单选下拉（源码里是 4 个 `role="checkbox"` 的 `text/image/video/pdf`），还漏了「最大输出 Token」（源码里在**基础区**，推理档位与映射才在「高级」折叠区）。本机 `~/.zcode/v2/config.json` 可直接读出模型的真实字段形态（`reasoning{enabled,variants[],defaultVariant}` / `limit{context,output}` / `modalities{input[],output[]}`），读时注意脱敏密钥。
- **可折叠面板别用 `toBeHidden()` 断言收起**：右侧边栏是"宽度过渡到 0 + 内容保持挂载"，元素仍在，`toBeHidden()` 会误判为可见。用宽度判据 + `aria-hidden`/`inert` 断言。（这个断言曾抓出真 bug：初版只加了 `inert`、宽度没参与计算，折叠在视觉上根本没发生。）
- **`<select>` 嵌在 `<label>` 里时，可访问名会带上选项文本**，`getByLabel(..., { exact: true })` 匹配不到，`getByLabel` 的子串匹配还可能命中 textarea 的正文——定位下拉一律用 `getByRole("combobox")`。
- **多代理并行时不要同时跑构建或 E2E**：`.next` 会互相覆盖，E2E 的固定端口 8290/3810 与 `data/e2e-*` 会互相踩。让代理只跑 `tsc --noEmit` / `compileall`，构建与全量 E2E 由主代理串行跑。
- Next 16：生产构建把 rewrites 代理目标固化进 `.next/routes-manifest.json`（改 `BACKEND_PORT` 必须重新 build）；`next.config.js` 的 `compress: false` 不能删（否则 gzip 缓冲 SSE，流式失效）。
- Windows 下 curl 发中文 JSON 会 GBK 乱码：一律 UTF-8 临时文件 + `--data-binary @file`。
- E2E 有顺序依赖（`workers: 1` + 文件名字母序；settings-providers 会把 active 切到无 key 的自定义项）。globalSetup 每轮重建 `data/e2e-ws` 与 `data/e2e-data` 保证幂等。
- `STUDYMATE_E2E_FIXTURE` / `STUDYMATE_DATA_DIR` 未设置时必须与生产零差异。
- 端口：后端 8101 / 前端 dev 3800 / 生产 3801 / E2E 8290 + 3810。venv 在 `backend/.venv`（Windows 为 `.venv/Scripts/python.exe`）。
- 嵌套残留 `study-mate-web/study-mate-web/`：某次以 `study-mate-web` 为根跑 E2E 的产物，已被本目录 `.gitignore` 的 `backend/data/` 兜底忽略；无害，**别提交**，维护者未指示清理前别删。

## 环境事实

- Python 依赖在 `backend/.venv`，`compileall` 可用；`npm run build` / `npm run test:e2e` 在 `frontend/`。
- 本机无真实 LLM Key：所有 LLM 端点只能验 422/502 路径，真实质量留 `SMOKE_REAL_LLM`（backlog #3）。
- `docs/` 上游文档已按用途归位（使用/规范/设计/agents）；引用上游文档用新路径。

## 建议使用的 skills

- `playwright-cli`：扩展/调试 E2E 用例、录制 trace（H 阶段会大量用）。
- `grill-with-docs`：实施中遇到"该不该做/做到哪一层"的取舍，先按它盘一遍再动手；决策落 `Web_CHANGE.md`（只追加）。
- `github:issue` / `github:pr`：维护者指令下跟进 issue 或从 fork 向上游开 PR。
- `handoff`：再次交接时生成新版本（**覆写本文**，保留此"文档地图/已知坑/环境事实"三节结构）。
