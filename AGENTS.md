# AGENTS.md

在本仓库里干活的 agent 的入口。**这里只放指针，不复述规则**——每条规则都有它唯一的出处，要改就改那份。

## 先读哪份

| 你要做什么 | 先读 |
| --- | --- |
| 改任何东西之前 | [CONTRIBUTING.md](CONTRIBUTING.md)：改哪块、先读哪份、门禁（`npm test`）、提交信息 |
| 判断某份文件归谁维护、路径是什么 | [文件归属](docs/规范/文件归属.md)：代称 ↔ 路径 ↔ 维护者，以及角色代称与派工值 |
| 改模板、渲染器、生成器、占位符 | [工程约束](docs/规范/工程约束.md) §三 占位符契约、§四 脚本一览 |
| 写或改课件内容文件 | [课件内容格式](docs/规范/课件内容格式.md) |
| 改角色提示词 `.dsh/skills/**` | 该技能自己的 `SKILL.md`；课件规则归 `lesson-design`，题目归 `layered-practice` |

## Agent skills

### Issue tracker

issue 与 spec 都活在 GitHub Issues（`Miaotofu01/Study-Mate`），全部操作走 `gh` CLI。见 [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)。

### Triage labels

五个规范 triage 角色各对应一个同名标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 [docs/agents/triage-labels.md](docs/agents/triage-labels.md)。

### Domain docs

**单上下文**布局：领域词表在仓库根 `GLOSSARY.md`，架构决策在 `docs/adr/`。两者都已建立——用到领域词就按词表里的叫法，动到已决策的区域先读对应 ADR。见 [docs/agents/domain.md](docs/agents/domain.md)。

## 文档在哪

`docs/` 按用途分类：

- **`docs/使用/`** —— 学生与维护者面向：安装、日常使用、宿主说明（Antigravity、Codex 与 ChatGPT）、发布流程
- **`docs/设计/`** —— 产品与协议视角：设计方案、VitePress 阅读端提案、可选方向探索的指南与验收
- **`docs/规范/`** —— 唯一约束来源：工程约束、课件内容格式、文件归属
- **`docs/adr/`** —— 决策类：架构决策记录。**已建立**（改到已决策的区域先读相关的）
- **`docs/agents/`** —— agent 约定层：issue tracker、triage 标签、领域文档布局
- `docs/images/` —— README 用的截图

待办不在仓库里了：**未完成的事走 GitHub Issues**，别再建 TODO 文件。

`CHANGELOG.md` 是发布流程生成的历史记录，**不要手改**。
