# StudyMate Web 探索测试指南（Agent Exploratory Harness）

> 版本：v1.0（2026-10-02）
> 性质：测试工作流文档——介绍并指导"探索 agent"harness：LLM 驱动真实浏览器，以模拟用户身份完成既定目标，逐步点击直到正路完成、借道完成或碰壁报告。
> 定位：**发现层，不是门禁**。触发独立于 E2E、只按需进行、失败不阻塞任何流程。
> 代码与产物：`frontend/tests/explorer/`（目标清单在 `goals/`，随仓库跟踪；运行轨迹与报告落 `runs/`，已 gitignore）。

## 1. 它补什么：E2E 的结构性盲区

E2E 的覆盖标准是"旅程中每个用户动作至少一条用例"——它覆盖**动作**，不覆盖**状态、渲染与请求载荷**（详见《E2E测试流程》第 2 节三类盲区）。探索 agent 用真遍历替代预写剧本，专捡这三类：

- **逆向前置状态**：不关联科目的对话、已填 key 的测试连接、空模型列表——组合爆炸写不成用例，agent 自己会走进这些状态；
- **交互执念与路径依赖**：真实用户在任何状态下戳任何控件，不是沿旅程走；
- **请求与输入链路**：前端把用户输入吞掉的整类问题（fixture 的 canned 响应 shape 永远正确，掩盖请求内容）。

它不替代 E2E：E2E 守回归（门禁），探索 agent 找问题（按需）；组件测试（尚待建设）承接分支逻辑。

## 2. 运行规则（2026-10-02 维护者拍板）

1. **允许有限自主恢复**：mechanics 层自由恢复（关弹窗、重试未命中的点击、等待加载），不算偏离；语义借道（换路径达成目标）允许，但必须标注 detour 并列出偏离点。受阻绕行不妨碍受阻点发现——**第一次撞墙即刻记录**，绕开也不丢。
2. **墙壁报告由 AI 初分**，分四类：真实功能缺陷 / 设计死路（PRD 边界的合理约束）/ agent 失误 / 环境问题。拿不准的**上交维护者拍板**，AI 只做去噪与初分，修不修永远由维护者决定。
3. **完全独立于门禁，只按需触发**。不要求像 E2E 那样改完必跑。

### 提醒规则（对 agent 的义务）

**完成较重要的 UI/后端变更后， agent 必须提醒维护者是否跑一遍探索测试**，并在提醒里给出建议目标清单（从第 5 节目标库挑）。是否执行由维护者决定——提醒是义务，执行不是。

建议时机：反馈清单相关功能修复后、新交互上线后、E2E 全绿但心里没底的变更后、发版前 sweep。

## 3. 快速开始

```bash
cd study-mate-web/frontend
EXPLORER_GOAL=tests/explorer/goals/g5-canonical-misconception.md npm run explore
```

- 自动拉起 fixture 后端（8290）+ 前端 dev（3810），复用 E2E 的 globalSetup **每轮重建种子工作区**，探索跑在确定性世界上；拉起前有"世界预检"（侧边栏须见种子科目），不符即响亮失败，不静默探索错误世界。
- **构建目录与后端命令口径（2026-10-05 审查轮）**：探索 dev server 用独立 `distDir`（`STUDYMATE_NEXT_DIST=.next-explorer`），与开发者本地 `npm run dev`（默认 `.next`）及 E2E（`.next-e2e`）隔离；后端命令按平台取 venv python（`tests/e2e/constants.ts` 的 `BACKEND_PYTHON`：Windows `.venv/Scripts/python.exe` / POSIX `.venv/bin/python`）。注意 `distDir` 仅**目录级隔离**，`next-env.d.ts` / `tsconfig` 仍会被 Next 改写。
- LLM 配置在 `frontend/tests/explorer/.env`（**已被 gitignore**，从 `.env.example` 复制）：`EXPLORER_LLM_BASE_URL` / `EXPLORER_LLM_API_KEY` / `EXPLORER_LLM_MODEL`。默认 `step-5-preview`，求快可换 `step-3.7-flash`。`max_tokens` 固定 32768（推理 token 计入 completion，给小了 content 为空）。
- 一次一个目标；成本量级：单目标约 1–5 分钟、5–20 步。
- 试跑顺序建议：**先跑正路基线**（g5 记误解 / g6 建课 / g7 产课），基线不过先修 harness，再跑 adverse（g1 / g2 / g8 / g10）与需要 `seed` 前置的目标（g9）。

## 4. 产物与墙壁分级

每次运行落在 `frontend/tests/explorer/runs/<goalId>/<时间戳>/`（已 gitignore）：

| 文件 | 内容 |
| --- | --- |
| `report.md` | 运行报告：三态结果、摘要、借道记录、**墙壁清单（待分级）** |
| `steps.jsonl` | 每步观测、LLM 原文、解析出的动作、执行结果、引擎信号 |
| `step-NNN.png` | 每步截图（分级时看墙面现场） |
| `walls.jsonl` | 首次撞墙即时记录——agent 绕开也不丢 |

运行结果五态：`canonical`（正路完成）/ `detour`（借道完成，偏离点必记）/ `blocked`（受阻）/ `budget_exhausted`（步数耗尽）/ `agent_loop`（循环护栏停机）。**canonical 不是稳定结论**：短目标存在 agent 循环倾向（同一目标跑出过 21 步耗尽与 5 步干净两种结果），重要结论跑两轮。

引擎信号（console error、`/api/` 4xx/5xx、请求失败、"动作后页面无变化"）会注入每步观测，是墙的主要候选证据。

## 5. 目标库与编写规范

目标按旅程语义编号（`g<序号>-<短名>.md`），front matter + 自然语言用户任务：

```
id: g1-no-subject-misconception
title: 不关联科目时把助手回复记入概念本
start_url: /chat
max_steps: 30
max_walls: 3
---
<给 agent 看的用户任务：你是谁、要完成什么、什么算完成、遇到什么用 wall 报告>
```

当前目标库（`goals/`）：

| 目标 | 探什么 | 来源 |
| --- | --- | --- |
| **反馈遗留 / 基础** | | |
| g5-canonical-misconception | 正路基线：关联科目后记误解并保存 | E2E 映射表（作对照） |
| g1-no-subject-misconception | 不关联科目记误解保存 | 反馈清单 #5 adverse |
| g2-test-connection-with-key | 已填 key 点测试连接的真实行为 | 反馈清单 #1 adverse |
| g3-model-selector | 模型选择器下拉交互 | 反馈清单 #2（脚本 E2E 零覆盖） |
| g4-dark-select | 暗夜模式读下拉选项 | 反馈清单 #4（渲染层） |
| **生产侧（建课 / 产课 / 工单）** | | |
| g6-course-build-interview | 方向探索 → 盘问 → 确认建课 → 编排 → 落点确认全链 | 生产侧（队列 C/D/J） |
| g7-produce-canonical | 按大纲顺序产出一节课并打开课件 | 生产侧（队列 C） |
| g8-produce-out-of-order | 越序产课受阻后自行找到顺序出路（受阻必记 + 借道） | 生产侧 adverse（E2E 只断言报错文案） |
| g9-inspection-ticket | 质检工单总览 → 快改 → 放弃（**需 `seed` 前置**） | 生产侧（工单 UI 非 seed 不可达） |
| **工作区 / 记忆 / 附件** | | |
| g10-workspace-switch-and-empty | 相对路径被拒 + 切空目录 + 新会话引导块切回 | 工作区 §9 adverse 状态 |
| g11-memory-precipitate | 会话后沉淀记忆：建议 → 逐条确认/改分节 → 写入 | 记忆写侧 §12 |
| g12-attachment-image-only | 只发图片附件、不写文字（用 `setfiles`） | 附件 §4 edge（E2E 只测 txt+正文） |
| **设置 / 记录 / 渲染** | | |
| g13-model-editor-advanced | 模型编辑弹窗：模态复选框 + 高级档位 chip + 能力声明 | 模型 schema v3（复杂新模态） |
| g14-system-prompt-restore | 系统提示词改后恢复默认 | §6（脚本 E2E 零覆盖） |
| g15-records-area-composition | 小结后右栏附件区出现「会话摘要」组 | 附件区 §11 状态组合 |
| g16-assessment-promotion | 评估通过 → 节点置位 + 沉淀记忆入口 | 评估联升 §11 |
| g17-dark-new-surfaces | 暗夜下新弹窗可读性（截图取证，人眼复核） | 渲染层（反馈 #4 后继） |

> g6–g17 为 2026-10-03 新增、**尚未试跑**；执行由维护者按需决定。建议先跑正基线（g6 / g7 / g5）确认 harness 正常，再跑 adverse 与需要 `seed` 的目标。

编写规范（试跑实证的教训）：

- **max_steps 收紧**：3 步能完成的目标给 8，旅程级给 20–30；短目标给大预算只会放大循环浪费。
- **明确"完成即停"**：目标里写"确认 X 后立即结束任务，不要继续操作其它"——agent 对"切换即完成"类目标有强循环倾向。
- **控件位置按当前 UI 描述**：模型选择器在**撰写栏底部**（不在顶栏），可访问名是当前"提供商 / 模型"文案（title 悬停提示不作可访问名）。
- **别把预期结论写死进目标**：目标让 agent 观察并如实报告，不诱导它寻找指定问题。
- **渲染/视觉目标必须要求视觉确认**：aria 快照包含闭合状态下 `<select>` 的全部 option，agent 会"从快照读到选项"而从未真正打开下拉——措辞不要求视觉确认就会得到假通过（g4 实证）。
- **路径用占位符**：目标文件随仓库跟踪，不写死本机绝对路径。可用 `{{FILES_DIR}}`（`tests/explorer/files/`，附件样例）、`{{WORKSPACE_DIR}}`（e2e 种子工作区）、`{{EMPTY_WS}}`（e2e 数据目录下的空目录）、`{{DATA_DIR}}`；引擎展开为**正斜杠**绝对路径（Windows 反斜杠会让 LLM 产出非法 JSON 转义）。
- **`seed:` 前置世界**：少数界面（质检工单）在纯 fixture 日程里不会自然出现，用 front matter 的 `seed: <name>` 把 `seeds/<name>.json` 落到后端数据目录（如 `seed: tickets` → `data/e2e-data/tickets.json`）。**（2026-10-05 本轮）工单 seed loader 在装载时给「非 draft、缺 `workspace`」的种子单补上 E2E 工作区**，使其显示为**正常工单**（否则按 legacy 规则会判为 unknown「待归属」）；**不改静态 json 里的绝对路径**，只在落盘到 e2e 数据目录时补。g9 目标里旧的「放弃本次」按钮文案同步改为「放弃工单」。
- **附件目标用 `setfiles` 动作**：📎 点开会弹系统文件框、agent 操作不了；用 `{"type":"setfiles","value":"<绝对路径>"}` 模拟选好文件（多个用 `;` 分隔）。

> **本轮同步说明（2026-10-05）**：以上为配合 legacy 工单归属恢复与 seed loader 的**最终行为同步**；**本轮未跑真实探索**（无新试跑结论/分级），是否执行由维护者按需决定。

## 6. 已知边界（试点实证，2026-10-02）

- **短目标循环与单次不稳定**：同一目标跑出过 21 步耗尽 / 16 步踩线 / 5 步干净三种结果。对策已落：policy"完成即停"、目标收紧 max_steps、循环守卫（最近 10 步 ≤3 个不同目标即停机——但抓不住 6 签名轮换式循环，别把单次 canonical 当稳定结论）。
- **原生 `<select>` 弹层是 OS 级渲染**：不进 aria 观测、不进页面截图，点击也不改变页面文本。combobox 目标的"页面无变化"误报已豁免；渲染类结论（对比度/间距）**必须人眼看截图**，或走《E2E 测试流程》第 2 节 P3 的 colorScheme + toHaveCSS 脚本断言。
- **请求载荷层断言是 P1 未落项**：harness 目前不校验"用户输入有没有进请求"，该能力按 P1 计划补 `page.route` 载荷断言。
- **新标签页链接点击后当前页无变化**：附件区的条目是 `target="_blank"`，点它只开新标签页、当前页 URL 与正文都不变，agent 会把它误报成"无变化"墙。**链接类目标只做存在性确认**（列表里有没有这条），链接可达性由 E2E（`attachments-area.spec.ts` 的 `request` GET）守护。
- **需要 `seed` 前置的界面**：质检工单在 fixture 下不会自然产生（canned 产物必定通过检查器，打回/转人工不触发），g9 靠 `seeds/tickets.json` 落种子；新增同类目标时照此声明 `seed:`。
- **fixture 不可达的三类新功能**（探索 harness 不覆盖，靠后端 pytest / 真实冒烟）：`image-scout` 采图（fixture 直接短路返回 gaps，不联网）、真实提供商连接测试的成功/失败细节（fixture `chat_once` 恒返回 canned）、非视觉模型的图片占位与错误码剔除重试（都在真实发送链路，fixture 不经过）。
- LLM 偶发输出非 JSON（5 轮出现 2 次）：自动恢复后继续，多花一步。
- 历史窗口：最近 8 条动作结果 + 当前完整快照，长会话可能丢早期上下文。

## 7. 试点实证记录（2026-10-02，校准证据）

| 目标 | 结果 | 分级 |
| --- | --- | --- |
| g5 正路基线 | canonical，9 步 | 通过，全链路跑通 |
| g1 无科目记误解 | detour，1 墙 | **设计死路（合理约束）**：表单提示"概念本按科目归档"+保存禁用，正是反馈 #5 修复后的行为；墙机制按设计工作 |
| g2 已填 key 测连接 | canonical，4 步 | 观测有效但 fixture 只给固定成功；反馈 #1 的保护由新 E2E 用例（settings-providers 37/38）守住 |
| g3 模型切换 | canonical，5 步 | 产品正常；过程暴露 agent 循环病理，已收紧目标与护栏 |
| g4 暗夜读下拉 | canonical，20 步 | **假通过，结论无效**：从未真正打开下拉；#4 以 `globals.css` 的 `select option` 主题变量修复为准，视觉结论须人眼 |

> g6–g17（2026-10-03 新增，覆盖生产侧与新功能）**尚无试跑记录**；首次执行后把结论与分级回填本表。

## 8. 维护约定

- harness 代码（`frontend/tests/explorer/`）的目标/规则/决策增删改 → 本文同步；
- 目标库与运行结果的重要变化 → `Web_CHANGE.md` **追加**条目；
- harness 与 E2E 共享 fixture 世界与 webServer 口径（`STUDYMATE_CONFIG` / `ensureWorkspaceConfig` / 端口 8290+3810 / `reuseExistingServer: false`），改口径时两边同步；
- E2E 文档第 2 节的 P1–P5 补强计划与本工作流共享结论：探索发现的问题，毕业去向是脚本用例（P1/P2）、组件测试（P4）或设计验收（P5）。
