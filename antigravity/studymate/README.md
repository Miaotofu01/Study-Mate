# StudyMate · Antigravity 插件

StudyMate 的 Google Antigravity 原生插件包：一套多智能体学习工作流，外加一个运行在
Antigravity 侧栏里的交互式学习面板。

包含：

- **5 个专属子代理**（`agents/`）：资料收集（resource-scout）、采图（image-scout）、
  课程设计（curriculum-designer）、课件讲解（learning-coach）、出题与评估（practice-evaluator）。
- **12 份技能协议**（`skills/`）：学习总控脚本与各角色之间的交接协议，全部按 Antigravity
  的宿主约定适配（子代理派工用 `invoke_subagent`、选题用 `ask_question`）。
- **意图触发规则**（`rules/AGENTS.md`）：把「我想学……」「继续学」这类话路由到学习总控。
- **原生交互面板**（`sidecars/reader/`）：`sidecar://studymate/reader/` 打开的侧栏阅读端——
  在面板里读课件、作答（判分写回 `attempts/`）、划选标注（`annotations/`）、跑实验、
  记无界笔记，并一键把当前段落发送给 Antigravity 当前对话。
  面板后端直接复用仓库的 `lib/` 数据层（`sidecars/reader/engine/lib/` 是构建期拷贝），
  所以它读写的就是同一份学习工作区，不存在第二套数据格式。
- **数据契约**（`schemas/`）与**课件模板**（`templates/`）：给插件自己生成/校验学习数据用。

离线补充：`npx -y @yunmiao/studymate@latest export` 可以把当前学习工作区导出成一份自包含的
静态页面（`file://` 直接打开），适合没有 Antigravity 的机器或想存档的场合。
