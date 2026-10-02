# 探索 agent（Explorer，草案 v0.1 —— 待人工审阅，尚未试跑）

用 LLM 驱动浏览器，把"模拟用户完成一个目标"从预写剧本换成真遍历：agent 一步步点击，
直到**正路完成 / 借道完成 / 受阻退出**三种出口之一，全程留轨迹，产出给人分级的墙壁报告。
它补的是脚本 E2E（`tests/e2e/`）的结构性盲区：逆向前置状态、请求载荷、多状态组合——
详见 `StudyMate-Web_E2E测试流程.md` 第 2 节。定位是**发现层，不是门禁**：只按需触发，
失败不阻塞任何流程，产物是报告而不是红绿。

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

## 当前 goal 清单（`goals/`，源自反馈清单与 E2E 映射表）

| goal | 探什么 |
| --- | --- |
| `g1-no-subject-misconception` | 不关联科目记概念本保存（反馈清单第 5 条 adverse） |
| `g2-test-connection-with-key` | 已填 key 点测试连接的真实行为（反馈清单第 1 条 adverse） |
| `g3-model-selector` | 模型选择器下拉交互（反馈清单第 2 条，脚本 E2E 零覆盖） |
| `g4-dark-select` | 暗夜模式读下拉选项（反馈清单第 4 条，渲染层） |
| `g5-canonical-misconception` | 正路基线：正常应 canonical，借道即线索 |

## 已知边界（草案期接受，改进时处理）

- 观测用可访问性快照（aria snapshot），**渲染类问题（对比度、间距）只能由截图被人眼发现**——g4 的结论以截图为准。
- 历史窗口：最近 8 条动作结果 + 当前完整快照；长会话可能丢早期上下文。
- LLM 偶发输出非 JSON：本步记"解析失败"后继续，连续解析失败会让目标以 budget_exhausted 收尾。
- `max_tokens` 固定 32768（推理 token 计入 completion，给小了 content 为空——已实测 2048 踩坑）。
