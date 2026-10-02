# Triage 标签

技能们说的是五个**规范 triage 角色**。这份表把角色映射到本仓库 issue tracker 里实际用的标签字符串。

| 规范角色 | 本仓库标签 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 维护者需要评估这条 issue |
| `needs-info` | `needs-info` | 等报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 已充分规格化，可以交给 AFK agent |
| `ready-for-human` | `ready-for-human` | 需要人来实现 |
| `wontfix` | `wontfix` | 不会处理 |

技能提到某个角色时（例如「打上 AFK-ready 那个 triage 标签」），就用本表右列对应的字符串。

本仓库目前标签字符串与角色同名，没有改名。以后想用别的写法（例如用 `bug:triage` 表示 `needs-triage`），改右列即可，`/triage` 会按这份表取标签，不会另造一套。

<!-- CI 触发验证用的临时改动，随探针分支一起删除 -->
