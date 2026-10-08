# AGENTS.md

在本仓库里干活的 agent 的入口。**这里只放指针，不复述规则**——每条规则都有它唯一的出处，要改就改那份。

## 先读哪份

| 你要做什么 | 先读 |
| --- | --- |
| 改任何东西之前 | [CONTRIBUTING.md](CONTRIBUTING.md)：贡献规矩的唯一出处（改哪块先读哪份、门禁、PR 流程、提交信息） |
| 判断某份文件归谁维护、路径是什么 | [文件归属](docs/规范/文件归属.md)：代称 ↔ 路径 ↔ 维护者，以及角色代称与派工值 |
| 改原生工具、阅读端 HTTP 路由，或预设里那个技能目录占位符 | [工程约束](docs/规范/工程约束.md) §三 原生工具（「阅读端 HTTP 路由」那节也在里面）；占位符由安装器替换，见 §二 技能与工具的可见边界 |
| 改递给宿主的**形状**：工具 schema、预设插件行、程序化建会话、阅读端的客户端服务调用 | [工程约束](docs/规范/工程约束.md) §三「宿主契约：形状照哪几份源码，怎么验」——那节指到宿主源码里的唯一判据，并给出 `npm run test:dsh-contract`（拿真宿主校验器验一遍） |
| 写或改课件内容文件 | [课件内容格式](docs/规范/课件内容格式.md) |
| 改阅读端呈现（`lib/client.js` 的页面、样式、问答面板） | [阅读端呈现](docs/规范/阅读端呈现.md)：四个面「看起来对不对」的判据；形状见 [目标态规格](docs/设计/目标态规格.md) §4，三栏让位见 [ADR-0011](docs/adr/0011-阅读端三栏让位顺序.md) |
| 改角色提示词 `preset/skills/**` | 该技能自己的 `SKILL.md`；课件规则归 `lesson-design`，题目归 `layered-practice` |
| 判断该跑哪些检查、怎么单跑 | [测试说明](scripts/tests/README.md) |

## Agent skills

### Issue tracker

issue 与 spec 都活在 GitHub Issues（`Miaotofu01/Study-Mate`），全部操作走 `gh` CLI。见 [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)。

### Triage labels

五个规范 triage 角色各对应一个同名标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 [docs/agents/triage-labels.md](docs/agents/triage-labels.md)。

### Domain docs

**单上下文**布局：领域词表在仓库根 `GLOSSARY.md`，架构决策在 `docs/adr/`。两者都已建立——用到领域词就按词表里的叫法，动到已决策的区域先读对应 ADR。见 [docs/agents/domain.md](docs/agents/domain.md)。

### 编排纪律

派活、等下属、跑门禁时怎么省轮次与上下文：`一票` / `子集` / `检查点` 三个词的用法与例外。见 [docs/agents/编排纪律.md](docs/agents/编排纪律.md)。

## 文档在哪

`docs/` 每个目录放什么、路径与维护者是谁，唯一出处是[工程约束](docs/规范/工程约束.md) §二 与[文件归属](docs/规范/文件归属.md)。这里只记怎么找：

- 约束类看 **`docs/规范/`**——它是唯一约束来源
- 决策类看 **`docs/adr/`**——已建立，动到已决策的区域先读对应 ADR
- 面向学生与维护者的用法看 **`docs/使用/`**

**未完成的事走 GitHub Issues**。

`CHANGELOG.md` 是发布流程生成的历史记录，**不要手改**。
