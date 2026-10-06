# 探索 agent（Explorer）— 使用说明

LLM 驱动浏览器，把"模拟用户完成一个目标"从预写剧本换成真遍历：agent 一步步点击，
直到**正路完成 / 借道完成 / 受阻退出**三种出口之一，全程留轨迹，产出给人分级的墙壁报告。
它补的是脚本 E2E（`tests/e2e/`）的结构性盲区：逆向前置状态、请求载荷、多状态组合。
定位是**发现层，不是门禁**：只按需触发，失败不阻塞任何流程，产物是报告而不是红绿。

**权威工作流文档在仓库层：[StudyMate-Web_探索测试指南.md](../../../StudyMate-Web_探索测试指南.md)**（运行规则、目标编写规范、已知边界、试点实证）；本文件只放速查。

## 运行

```bash
cd frontend
EXPLORER_GOAL=tests/explorer/goals/g1-no-subject-misconception.md npm run explore
```

- 自动拉起 fixture 后端（8290）+ 前端 dev（3810），复用 `tests/e2e/global-setup.ts` 重建种子工作区，跑在确定性世界上。
- `EXPLORER_LLM_*` 从 `tests/explorer/.env` 读取（复制 `.env.example` 填入；`.env` 已 gitignore）。
- 默认模型 `step-5-preview`；想更快更省改 `.env` 里 `EXPLORER_LLM_MODEL=step-3.7-flash`。
- 一次一个 goal（`workers: 1`）；换 goal 改 `EXPLORER_GOAL` 再跑。

## 产物（`frontend/tests/explorer/runs/<goalId>/<时间戳>/`，已 gitignore）

| 文件 | 内容 |
| --- | --- |
| `report.md` | 运行报告：结果三态、摘要、借道记录、墙壁清单（待分级） |
| `steps.jsonl` | 每步的观测、LLM 原文、解析出的动作、执行结果、引擎信号 |
| `step-NNN.png` | 每步截图（分级时看墙面现场） |
| `walls.jsonl` | 首次撞墙即时记录——agent 绕开也不丢 |

## 关键机制（与维护者约定）

- **三态出口**：`canonical`（正路完成）/ `detour`（借道完成，偏离点必记）/ `blocked`（受阻）——规则见 `policy.md`。
- **mechanics 自由恢复，语义借道必报**：关弹窗、重试点击、等加载不算偏离；换路径达成目标必须标注 detour。
- **首次撞墙即记**：`wall` 动作即时落盘，无论后续是否绕开。
- **墙壁报告分级**（由 AI 初分：功能缺陷 / 设计死路 / agent 失误 / 环境问题，拿不准上交人工）。
- **引擎信号**：console error、`/api/` 4xx/5xx、请求失败、以及"动作后页面无变化"提示会注入观测，帮 agent 和自己识别墙。

## 当前 goal 清单（`goals/`）

完整表与来源见[探索测试指南 §5](../../../StudyMate-Web_探索测试指南.md)（权威）。速查：

| goal | 探什么 |
| --- | --- |
| `g1-no-subject-misconception` | 不关联科目记概念本保存（反馈清单第 5 条 adverse） |
| `g2-test-connection-with-key` | 已填 key 点测试连接的真实行为（反馈清单第 1 条 adverse） |
| `g3-model-selector` | 模型选择器下拉交互（反馈清单第 2 条，脚本 E2E 零覆盖） |
| `g4-dark-select` | 暗夜模式读下拉选项（反馈清单第 4 条，渲染层） |
| `g5-canonical-misconception` | 正路基线：正常应 canonical，借道即线索 |
| `g6-course-build-interview` | 建课全链：方向探索 → 确认建课 → 编排 → 落点确认 |
| `g7-produce-canonical` | 按大纲顺序产出一节课并打开课件 |
| `g8-produce-out-of-order` | 越序产课受阻后自行找到顺序出路 |
| `g9-inspection-ticket` | 质检工单总览 → 快改 → 放弃工单（需 `seed: tickets` 前置） |
| `g10-workspace-switch-and-empty` | 相对路径校验 + 切空目录 + 新会话引导块切回 |
| `g11-memory-precipitate` | 会话后沉淀记忆（建议 → 逐条确认 → 写入） |
| `g12-attachment-image-only` | 只发图片附件、不写文字（用 `setfiles` 动作） |
| `g13-model-editor-advanced` | 模型编辑弹窗：模态复选框 + 高级档位 chip + 能力声明 |
| `g14-system-prompt-restore` | 系统提示词改后恢复默认（§6 零 E2E 覆盖） |
| `g15-records-area-composition` | 小结后右栏附件区出现「会话摘要」组 |
| `g16-assessment-promotion` | 评估通过 → 节点置位 + 沉淀记忆入口 |
| `g17-dark-new-surfaces` | 暗夜下新弹窗可读性（截图取证，人眼复核） |

> g6–g17 为 2026-10-03 新增，**尚未试跑**；执行由维护者按需决定，建议先正基线（g5/g6/g7）再 adverse。**（2026-10-05 本轮）** 同步 g9 按钮文案「放弃本次」→「放弃工单」与工单 seed loader 补 workspace；**本轮未跑真实探索**。

## 目标编写小抄（新增于 2026-10-03）

- front matter：`id` / `title` / `start_url` / `max_steps` / `max_walls`，外加可选的 **`seed: <name>`**（把 `seeds/<name>.json` 落到后端数据目录，用于 fixture 下不自然出现的界面，如质检工单）。**（2026-10-05）seed loader 在装载时给「非 draft、缺 `workspace`」的种子单补 E2E 工作区**（不改静态 json 绝对路径），使其显示为正常工单（否则按 legacy 规则会判 unknown「待归属」）。
- 目标正文里的路径占位符（引擎展开为**正斜杠**绝对路径）：`{{FILES_DIR}}`（`tests/explorer/files/`，附件样例）、`{{WORKSPACE_DIR}}`、`{{EMPTY_WS}}`、`{{DATA_DIR}}`。
- 附件类目标用动作 `{"type":"setfiles","value":"<绝对路径>"}`——📎 会弹系统文件框，agent 操作不了。

## 已知边界（试点实证，2026-10-02 五目标试跑后修订）

- **短目标有循环倾向，单次结果不稳定**：同一 g3 目标跑出过 21 步预算耗尽、16 步踩线完成两种结果——agent 对“切换即完成”类目标会反复操作，policy 的“完成即停”压不住。对策：短目标把 `max_steps` 收紧（g3=8）；探索.spec 有循环守卫（最近 10 步 ≤3 个不同目标即停机），但它抓不住 6 签名轮换式循环，别把 canonical 当成稳定结论，重要目标跑两轮。
- **原生 `<select>` 弹层是 OS 级渲染**：不进 aria 观测、不进页面截图，点击也不改变页面文本。combobox 目标的“页面无变化”提示已豁免；渲染类目标（暗夜对比度等）的结论**无效**，必须人眼看截图，或走 P3 的 colorScheme + toHaveCSS 脚本断言。
- **aria 快照含闭合状态下 `<select>` 的全部 option**：agent 会“从快照读到选项”而从未真正打开下拉——目标若要求“打开并阅读”，必须在措辞上要求视觉确认，否则会得到假通过。
- **新标签页链接**：附件区条目是 `target="_blank"`，点它当前页无变化，会被误报成"无变化"墙——链接类目标只做存在性确认，可达性由 `attachments-area.spec.ts` 守护。
- **需要前置世界的界面**：质检工单在 fixture 下不会自然产生（canned 产物必过检查器），靠 `seed:` 落种子。
- **fixture 不可达**：image-scout 采图、真实提供商连接测试细节、非视觉模型图片占位与错误码剔除重试（都在真实发送链路）——靠后端 pytest / 真实冒烟。
- **课程图谱的节点按钮是 sr-only**：真实指针点不到，harness 会回落 `dispatchEvent` 并在结果里标注（不是产品墙）。
- LLM 偶发输出非 JSON（5 轮出现 2 次）：自动恢复后继续，不影响结果，但会多花一步。
- 历史窗口：最近 8 条动作结果 + 当前完整快照；长会话可能丢早期上下文。
- `max_tokens` 固定 32768（推理 token 计入 completion，给小了 content 为空——已实测 2048 踩坑）。
