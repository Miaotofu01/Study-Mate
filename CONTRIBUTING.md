# 参与 StudyMate

这是个个人维护的开源项目，欢迎提 issue 和 PR。下面只写这个仓库**特有的**规矩，通用开源礼仪与常见坑不重复。

**这份文件是贡献规矩的唯一出处**：别处提到「改哪块、跑什么、怎么提」，只给指针，不重抄。

## 五条硬规矩

1. **一个 PR 只做一件事。** 顺带重构请另开一个 PR。
2. **改行为之前先开 issue 对齐。** 「大」不用数字界定，用这个测试：不用跑代码就要能说清它改了什么。说不清，说明还没对齐。
3. **门禁只有一条**，就是下面[本地验证](#本地验证)里那条命令。CI 在 Ubuntu / Node 24 / Python 3.13 上跑的就是它，本地跑通即可，不用模拟其他平台。
4. **提交信息用 Conventional Commits，描述与 scope 都写中文。**
5. **提交 PR 前保持分支与 `main` 同步**：把 `main` merge 进你的分支即可；落后时 GitHub 会提示 out of date，点 Update branch 一样管用。

错字、断链、注释这三类改动不必先开 issue。

## 改哪块，先读哪份

每份内容只有一个约束来源，改它之前先读它；别的文档只给指针。

| 你要改 | 先读 |
|---|---|
| `.dsh/skills/**` 提示词与角色规格 | 该技能自己的 `SKILL.md`；课件规则归 `lesson-design`，题目归 `layered-practice` |
| `scripts/*.py` 生成器、渲染器、校验器 | [工程约束](docs/规范/工程约束.md) §三 占位符契约、§四 脚本一览 |
| `templates/**` 页面骨架与前端资源 | [工程约束](docs/规范/工程约束.md) §三、§五；[模板说明](templates/README.md) |
| `schemas/*.json` | 该 schema 本身；[文件归属](docs/规范/文件归属.md) |
| `bin/*.mjs` 安装器与插件构建 | [安装说明](docs/使用/安装.md)；[Codex 与 ChatGPT](docs/使用/Codex与ChatGPT.md) |
| `openai/studymate/**` 插件源 | [Codex 与 ChatGPT](docs/使用/Codex与ChatGPT.md) |
| 课件内容文件 | [课件内容格式](docs/规范/课件内容格式.md) |
| `docs/**`、`README.md` | 该文件已有的口径；新规则遵循「一处定义，别处只给指针」 |

提示词、模板、`schemas/` 和 `scripts/` 里的 Python 会**同时**流进 DSH 预设与 Codex 插件（插件由 `npm run build:plugin` 从这些源转换而来），改完别只验 DSH 一侧。

## 本地验证

```bash
npm test    # 与 CI 同一条
```

单跑某一层、要真实浏览器或真实 DSH 的入口、各命令的前置，都写在[测试说明](scripts/tests/README.md)。

Node 与 Python 的版本要求看 `package.json` 的 `engines` 与 CI 实际使用的版本，这里不重抄数字。
## 提交 PR

1. 先开 issue（硬规矩 2），PR 正文里引用它。
2. 分支保持与 `main` 同步（硬规矩 5）。
3. 在 PR 正文里贴上[本地验证](#本地验证)那条命令的结果——门禁没有做成强制门，这是唯一能看出「真的跑过」的东西。

第一次给这个仓库提交时，CI 要等维护者批准才会开始跑：那是 GitHub 对 fork 的默认行为，不是你的 PR 被忽略了。

## 提交信息

```text
<type>(<scope>): 改了什么
```

- `type` 用 `feat` `fix` `docs` `refactor` `test` `chore` `ci`
- `scope` 用中文模块名，如 `提示词` `渲染器` `检查` `示例` `数学` `CI`
- 破坏性改动加 `!`，并在正文写清迁移方式
- 正文说清**为什么**——发布时标题和正文会原样进 CHANGELOG

历史里的好例子：

```text
feat(公式): 课件支持数学排版（$…$ 行内 / $$…$$ 块级，离线 KaTeX）
fix(CI): 修掉 Python 3.12+ 的非法转义警告——它在 3.13 上把一条断言撑破了
refactor(大纲)!: 删掉节点「过关标准」字段，判分锚下移到 objective 与题目判分要点
```

`chore(release): vX.Y.Z` 由发布流程自己生成，不用手写。

## 什么不要提交

- `workspace/`：你自己的学习数据（已 gitignore）
- `dist/`：插件构建产物（已 gitignore）
- `~/.dsh/` 下的安装副本：那是产物，改源不改编产物
- `examples/` 里的 `index.html` 与课件页：它们是生成器写出来的，手改下次重跑就没了

## 示例是产物

`examples/` 是一份 clone 下来就能点开的完整示例工作区，页面全部由引擎生成。改过模板、渲染器、共享资源或科目数据之后，重跑一遍：

```bash
python3 scripts/build_examples.py    # 或 npm run build:examples：主页与每一课一条命令跑完
```

跑完看 `git status`，只该有你预期的改动。多出别的文件，就说明示例镜像和引擎当前输出已经不一致。

## 发布

维护者手动触发，见[发布流程](docs/使用/releasing.md)。版本号、tag 和 CHANGELOG 都不用贡献者动。

## License

MIT，见 [LICENSE](LICENSE)。
