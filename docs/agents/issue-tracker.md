# Issue tracker：GitHub

本仓库的 issue 与 spec 都活在 **GitHub Issues** 里（`Miaotofu01/Study-Mate`）。所有操作走 `gh` CLI，不手写网页表单。

`gh` 在仓库克隆里会自动从 `git remote -v` 推断仓库，不用反复带 `--repo`。

## 常用操作

- **建 issue**：`gh issue create --title "..." --body "..."`；正文多行用 heredoc。
- **读 issue**：`gh issue view <号> --comments`，需要挑评论时用 `jq` 过滤，同时取回标签。
- **列 issue**：
  ```bash
  gh issue list --state open --json number,title,body,labels,comments \
    --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'
  ```
  配合 `--label` 与 `--state` 收窄。
- **评论**：`gh issue comment <号> --body "..."`
- **加／去标签**：`gh issue edit <号> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <号> --comment "..."`

## PR 算不算待分诊的请求

**不算（PRs as a request surface: no）。**（若哪天要把外部 PR 当功能请求看待，把这里改成 `yes`；`/triage` 会读这一行。）

改成 `yes` 后，PR 与 issue 走同一套标签与状态，命令换成 `gh pr` 对应项：

- **读 PR**：`gh pr view <号> --comments`；看 diff 用 `gh pr diff <号>`。
- **列待分诊的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只留 `authorAssociation` 为 `CONTRIBUTOR`／`FIRST_TIME_CONTRIBUTOR`／`NONE` 的（丢掉 `OWNER`／`MEMBER`／`COLLABORATOR`）。
- **评论／打标签／关闭**：`gh pr comment`、`gh pr edit --add-label`／`--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR **共用一套编号**，所以裸写的 `#42` 可能是两者之一：先 `gh pr view 42`，失败再退回 `gh issue view 42`。

## 技能说「发布到 issue tracker」时

建一个 GitHub issue。

## 技能说「取出对应 ticket」时

跑 `gh issue view <号> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**地图**是一个 issue，**子 ticket** 是挂在它下面的 issue。

- **地图**：单个 issue，打 `wayfinder:map` 标签，正文承载「Notes / Decisions-so-far / Fog」三节。`gh issue create --label wayfinder:map`。
- **子 ticket**：作为 GitHub sub-issue 挂到地图上（调 `gh api` 的 sub-issues 端点）。仓库没开 sub-issues 时，把子项加进地图正文的任务列表，并在子 issue 正文顶部写 `Part of #<地图号>`。标签用 `wayfinder:<类型>`（`research`／`prototype`／`grilling`／`task`）；认领后指派给驱动的开发者。
- **阻塞关系**：用 GitHub **原生 issue dependencies**，这是界面上看得见的规范表示。加边：
  ```bash
  gh api --method POST repos/<owner>/<repo>/issues/<子号>/dependencies/blocked_by -F issue_id=<阻塞者数据库 id>
  ```
  `<阻塞者数据库 id>` 是阻塞者的**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`），**不是** `#号` 也不是 `node_id`。GitHub 用 `issue_dependencies_summary.blocked_by` 汇报未关闭的阻塞者数量，那就是实时闸门。仓库没有 dependencies 时，退回在子 issue 正文顶部写 `Blocked by: #<n>, #<n>`。阻塞者全部关闭，ticket 才算解锁。
- **找前沿**：列出地图下所有未关闭子项（`gh issue list --state open`，限定在地图的 sub-issues／任务列表），丢掉有未关闭阻塞者的（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里还有未关闭的 issue）和已有指派人的；按地图顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me` —— 这是本次会话的第一次写操作。
- **解决**：`gh issue comment <n> --body "<答案>"`，然后 `gh issue close <n>`，再把一个上下文指针（要点 + 链接）追加到地图的 Decisions-so-far。

## 本仓库额外的规矩

贡献流程、门禁、PR 与提交信息的规矩写在 [CONTRIBUTING.md](../../CONTRIBUTING.md)，以那份为准，这里只给指针。
