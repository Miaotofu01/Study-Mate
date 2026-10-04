# AGENTS.md — study-mate-web

面向在 `study-mate-web/` 子项目里干活的 AI 代理与新人。仓库级约定见根目录 [AGENTS.md](../AGENTS.md)
（只放指针）与 [CONTRIBUTING.md](../CONTRIBUTING.md)；本文件只补 **web 子项目特有**的规则，
同样尽量只给指针。

## 这个子项目是什么

**StudyMate Web**：Study-Mate 的独立 Web 运行时（FastAPI 后端 + Next.js 16 前端）。
自包含工程，不依赖仓库根的 npm 脚本；课程数据与上游 `.learning` 静态工作区同构。

权威文档（都在本目录下）：

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 启动、配置模型、附件、E2E 测试、版本语义 |
| [StudyMate-Web_开发与计划.md](StudyMate-Web_开发与计划.md) | 架构现状、不变约束、领域模型、backlog + **§5.1 全功能复现实施队列（任务书）** |
| [StudyMate-Web_PRD.md](StudyMate-Web_PRD.md) | 功能描述（随代码同步，含实施状态总览） |
| [docs/StudyMate-Web_前端美化设计.md](StudyMate-Web_前端美化设计.md) | 视觉审美、排版动效与组件布局设计规范（对标 DeepTutor） |
| [StudyMate-Web_E2E测试流程.md](StudyMate-Web_E2E测试流程.md) | E2E 用例与旅程映射（与 `frontend/tests/e2e/` 同步维护） |
| [docs/StudyMate-Web_建课链路.md](StudyMate-Web_建课链路.md) | **建课全链路档案**：入口→盘问收口→建课编排→落点确认→产课，含产物速查、卡点排查索引与待拍板清单 |
| [docs/StudyMate-Web_探索测试指南.md](StudyMate-Web_探索测试指南.md) | 探索 agent 工作流（按需触发，独立于 E2E 门禁） |
| [Web_CHANGE.md](Web_CHANGE.md) | 旧计划与变更史留痕（**只追加、不改写**） |

## 硬规矩

1. **验证门禁**：改 `backend/` 后跑 `python -m pytest tests`（测试依赖见 `backend/requirements-dev.txt`）
   + `python -m compileall app`，并按需起服务 curl 关键端点；改 `frontend/` 后
   `npm run build`（含 TS 严格检查）。改对话/设置/附件等功能后跑 `npm run test:e2e`。
2. **数据合同**：课程/进度口径与根目录 `schemas/*.schema.json` 一致；掌握度状态机的唯一实现是
   `backend/app/curriculum_store.py` 的 `TRANSITIONS`；新词表（importance/lab_status/verdict 等）
   只在该文件定义一次。改词表要两边同步并跑通两边验证。
3. **上游脚本只复用不重写**：大纲校验走 `scripts/check_curriculum.py`、静态导出走
   `scripts/gen_home.py`（子进程调用）；**学习工作区的发现也复用 `gen_home.py` 的
   `learn_workspace()`**（优先级：显式参数 > `STUDYMATE_WORKSPACE` > `LEARN_WORKSPACE` >
   `STUDYMATE_CONFIG`/`$DSH_HOME/studymate-config.yaml`），Web 不实现第二份发现规则；
   工作区布局与插件同构（`<WS>/.learning/subjects`）。上游脚本缺失时明确 503，不静默降级。
4. **运行时产物不入库**：见本目录 [.gitignore](.gitignore)（`data/`、`.venv`、`node_modules`、
   `.next`、test-results 等）。
5. **代码风格**：Python 必须 `from __future__ import annotations`、非必要不写注释；
   TypeScript 严格模式，除 `app/*/page.tsx` 外一律具名导出。
6. **版本号**：三处一致（`frontend/package.json`、`backend/app/main.py`、侧边栏读 package.json）；
   语义化版本、仅标识 StudyMate Web、与 `@yunmiao/studymate` 独立；**变更需维护者知会同意**。
7. **E2E fixture**：`STUDYMATE_E2E_FIXTURE=1` 仅供测试（canned 响应），未设该环境变量时行为必须
   与生产完全一致；`STUDYMATE_DATA_DIR` 同理仅测试用。
8. **文档同步**（五份文档各司其职，改动必须落到对应文档）：
   - 功能落地或变更 → `StudyMate-Web_PRD.md` 对应章节 + 实施状态总览；
   - 计划项完成/新增/放弃 → `StudyMate-Web_开发与计划.md` 第 5 节 backlog；
   - 里程碑完成、方案定稿或变更、重要决策 → `Web_CHANGE.md` **追加**条目（不改写已有内容）；
   - E2E 用例增删改 → `StudyMate-Web_E2E测试流程.md` 的映射表与用例明细同步；
   - 探索测试 harness（`frontend/tests/explorer/`）目标/规则/决策增改 → `StudyMate-Web_探索测试指南.md`；
   - 启动/部署/版本等用户可见信息变化 → `README.md`。
9. **探索测试提醒**：完成较重要的 UI/后端变更后，**必须提醒维护者**是否按
   [探索测试指南](StudyMate-Web_探索测试指南.md) 跑一遍探索测试，并给出建议目标清单。是否执行由维护者定——不像 E2E 那样改完必跑，但提醒本身是义务。

## 端口

后端 8101 · 前端 dev 3800 / 生产 3801 · E2E 用 8290 + 3810。Next 16 生产构建会把代理目标
固化进构建产物（详见根 README 与本目录 README 的说明）。
