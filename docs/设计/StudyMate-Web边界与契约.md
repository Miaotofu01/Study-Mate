# StudyMate Web：与上游的边界与契约

> **性质**：设计类。描述子项目 [`study-mate-web/`](../../study-mate-web/) 与上游（插件、生成器、规格）之间的**接口面与不变量**；不复述功能。
> 功能现状见子项目 [PRD](../../study-mate-web/StudyMate-Web_PRD.md)，架构与队列见[开发与计划](../../study-mate-web/StudyMate-Web_开发与计划.md)，用例映射见 [E2E 测试流程](../../study-mate-web/StudyMate-Web_E2E测试流程.md)。
> 状态随 `0.7.0-beta` 的实现现状书写；**边界一变就改这一份**。

## 一、一句话边界

Web 运行时是上游引擎的**第二个前台**：读同一套 `.learning` 工作区、调用同一批上游脚本、注入同一批角色规格，但**不改上游的任何一个字节**，也不参与插件的构建与发布。

## 二、复用什么（只读）

| 上游资产 | Web 怎么用 | 约束 |
| --- | --- | --- |
| `.dsh/skills/<角色>/SKILL.md` | 提示词分层：按链路把角色规格**全文**注入对话与子代理 | 只读、不解析节；上游重构正文不影响 |
| `scripts/gen_home.py` | 导出静态工作区主页；工作区发现复用其中的 `learn_workspace()`（子进程调用） | 只复用不重写；缺失时给明确错误，不静默降级成"另一套发现" |
| `scripts/render_lesson.py`、`scripts/check_lesson.py` | 产课链的渲染与质检 | 零重写，按退出码判定 |
| `scripts/check_curriculum.py`、`scripts/check_pool.py` | 建课大纲门禁、图片库自检 | 零重写 |
| `scripts/statuses.py` | 掌握度状态流转口径的来源 | Web 侧**不重写**，只对齐常量 |
| `schemas/*.schema.json` | 评估 / 小结 / 学习记录 / progress 的落盘校验 | 与插件同一份 schema |
| `templates/assets/` | 科目组件（`style.css` / `quiz.js` / `lesson-toc.js`）的来源 | 复用共享层，科目自加组件不动 |
| [课件内容格式](../规范/课件内容格式.md) | 课件内容文件的语法归属 | 只给指针，不复制口径 |

## 三、不做什么

- 不改 `.dsh/skills/**`、`scripts/**`、`templates/**`、`schemas/**`——**上游脚本只复用不重写**是硬规矩。
- 不参与插件的构建与发布链：`npm run build:plugin` 等只处理上游源；Web 的版本号（`0.7.0-beta`）与上游 tag、CHANGELOG 无关。
- 不替代插件的宿主路径（DSH / Antigravity / Codex），只是**另一种前台**。
- 不引入第二份规格：Web 侧不重写课件语法、角色规则或状态口径，只执行上游那一份。

## 四、数据面：同构，而不是另起一套

- 工作区布局与插件逐字同构：`<工作区>/.learning/subjects/<slug>/{subject,curriculum,progress,misconceptions}.yaml`，以及 `lessons/ assets/ reference/ sources/ lab/ assessments/ learning-records/ sessions/`；共享记忆是 `<工作区>/.learning/MEMORY.md`。
- 发现链沿用上游：显式参数 > `STUDYMATE_WORKSPACE` > `LEARN_WORKSPACE` > `STUDYMATE_CONFIG`（默认 `$DSH_HOME/studymate-config.yaml`）里的 `workspace` > 插件默认 `~/StudyMate`。
- **不自动种入示例**：`seed/` 只服务测试与建课演示；工作区里已有的内容原样读，不迁移、不改写。
- Web 自有数据只落在 `study-mate-web/data/**`（settings、sessions、drafts、audit、uploads、exports），不写进工作区。
- 因此同一个工作区可以**插件与 Web 交替使用**：两边读写的是同一批文件、同一套 schema。

## 五、评审关心的不变量

1. **门禁不松**：`check_curriculum.py` / `check_lesson.py` 在写盘后由后端强制跑，不信任模型自查；报错按路径归属打回，超轮次转人工工单。
2. **单收口点**：会话级工作区只经 `backend/app/workspace_ctx.py`；课程仓储只经 `curriculum_store.workspace_dir()`——下游全部自动跟随，不逐个加参数。
3. **提示词单一来源**：角色规格来自 `.dsh/skills/**`，Web 侧只做分层注入。
4. **状态机唯一实现**：`curriculum_store.TRANSITIONS`，与 `scripts/statuses.py` 口径一致。
5. **工具调用有边界**：读写工具带沙箱 allow-list（写前 canonicalize），不做任意路径读写；调用与结果落 `data/audit/*.jsonl`。

## 六、自带的质量门（与上游门禁各自独立）

| 层 | 命令（在 `study-mate-web/` 下） | 说明 |
| --- | --- | --- |
| 后端单测 | `backend/.venv/Scripts/python.exe -m pytest tests` | 自带隔离运行时；含 1 条 `SMOKE_REAL_LLM` 门控冒烟 |
| 旅程级 E2E | `cd frontend && npm run test:e2e` | Playwright + 后端 fixture，**不需要真实 API Key** |
| 组件测试 | `cd frontend && npm run test:component` | vitest，分支逻辑下沉，不进上游门禁 |
| 探索测试 | `cd frontend && npm run explore` | 按需触发，见[探索测试指南](../../study-mate-web/docs/StudyMate-Web_探索测试指南.md) |

上游那条门禁（`npm test`）**不覆盖子项目**，两边各自跑、互不阻塞。

## 七、已知边界与不在范围内

- **仅本机单机**：无账号、无鉴权、无多用户隔离；后端只绑 `127.0.0.1`，前端由 Next 绑定 `0.0.0.0`（本机信任模型，勿暴露公网）。
- **lab 沙箱是子进程级**（隔离目录 + 超时 + 进程树终止），不是容器级强隔离。
- 真实模型冒烟只覆盖本机已配置的渠道；`anthropic` 与 `openai_responses` 两种格式的真实流式尚未验证。
- 仍需人工一处：评估点判定；**误解落盘**已按 P1 修复（未通过题按题映射、全通过不落条目），不再算人工项。
- 前端生产构建是**快照**：改源码后要重新 `npm run build` 才生效（`start-web.bat` 已自动处理；手动起生产模式需自己 rebuild）。

## 八、指针

| 想了解 | 去哪 |
| --- | --- |
| 怎么装、怎么起、怎么停、数据在哪 | [使用 §StudyMate Web](../使用/StudyMate-Web.md) |
| 功能现状（做什么、怎么用） | [子项目 PRD](../../study-mate-web/StudyMate-Web_PRD.md) |
| 架构、对外契约、队列与 backlog | [开发与计划](../../study-mate-web/StudyMate-Web_开发与计划.md) |
| 用例 ↔ 上游旅程的映射 | [E2E 测试流程](../../study-mate-web/StudyMate-Web_E2E测试流程.md) |
| 决策与变更留痕 | [Web_CHANGE](../../study-mate-web/Web_CHANGE.md) |
| 交接索引 | [HANDOFF](../../study-mate-web/HANDOFF.md) |
