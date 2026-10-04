# VitePress 课程工作区（提案）

> 状态：**提案已被取代**。目标态选了另一条路——阅读端做成宿主内的客户端插件（React），而不是独立的 VitePress 站点；静态页面降为导出能力。见 [目标态规格](目标态规格.md) 与 [ADR-0003](../adr/0003-阅读端只嵌DSH.md)。
> 保留本文件是为了记住当时评估过的替代方案与它的代价；**不要据此实现**。
> 对接 [Issue #22](https://github.com/Miaotofu01/Study-Mate/issues/22)。
> 定位：给维护者一个可分阶段落地的前端演进方案。本文件只定义迁移边界与内容协议，不替换现有 HTML 引擎。
> 产品视角仍以 [设计方案](设计方案.md) 为准，工程硬约束仍以 [工程约束](../规范/工程约束.md) 为准。课件语法仍以 [课件内容格式](../规范/课件内容格式.md) 为准。

## 1. 为什么现在不直接换掉渲染器

Issue #22 的判断是对的：Agent 更适合维护 Markdown、YAML、JSON，而不是手写完整 HTML。StudyMate 其实已经走在这条路上——讲解角色写 `lessons/*.md`，出题角色写 `*.quiz.json`，HTML 由 `scripts/render_lesson.py` 产出（见 [课件内容格式](../规范/课件内容格式.md) 开头的铁律：「模型一个字 HTML 都不写」）。

当前缺口不在「Agent 还在写 HTML」，而在「学生看到的页面仍是一次性渲染的静态 HTML」：

- 可读性、暗色、目录、移动端要改，就得改模板再重跑生成器；
- 路线图、练习、进度是手写交互，散在 `templates/` 与科目副本里；
- 工作区页面不能热更新，Agent 改完内容要再跑 `gen_home.py` / `render_lesson.py` 才能看见。

因此建议新增一个 **可选的 VitePress + Vue 阅读端**，而不是在本阶段删除 Python 渲染器。离线 HTML 仍是默认交付：学生用浏览器打开 `<workspace>/index.html` 不需要 Node，DSH 沙箱也不依赖前端构建。

## 2. 参考实现，不建议整仓合入

Issue 作者的个人原型在 [yulaoshizuikeai/Study-Mate-vue](https://github.com/yulaoshizuikeai/Study-Mate-vue)。它证明了 VitePress 能承载课程总览和交互组件，但不适合作为上游补丁直接合并：

- 面向高中场景重写了产品定位，和本仓库的数学 / 计算机自学助手不是同一条产品线；
- 移除了既有 Python HTML 生成路径，会打断 DSH、Codex / ChatGPT Work、Antigravity 和离线工作区；
- 含个人 `workspace/`、另一套 `skills/` 与安装脚本，和本仓库的「引擎只读、学习数据在工作区」三分区冲突。

可借鉴的只有三件事：`site/` 作为独立前端目录、用同步脚本把工作区大纲映射成站点页面、用 Vue 组件承接测验和进度。内容协议仍用本仓库的 `curriculum.yaml`、课件 Markdown 和题库。

## 3. 目标与非目标

**做：**

- 新增独立前端目录（建议 `site/`），不改 `.dsh/skills/` 的职责划分；
- 只读消费学习工作区里已经存在的结构化数据；
- 用 Vue 组件承接路线图、练习、进度、课元信息和「继续学习」；
- 暗色模式、目录、搜索、移动端由 VitePress 主题提供，不再各页复制一套；
- 保留现有 HTML 产物，作为无 Node 环境的离线入口。

**不做（本提案阶段）：**

- 不删除 `templates/`、`scripts/render_lesson.py`、`scripts/gen_home.py`；
- 不要求 Agent 写 `.vue` 或 HTML；
- 不把 `examples/` 里已生成的 `index.html` 改成手工维护；
- 不把 VitePress 构建塞进 `npm test`，直到只读阅读端真的落地；
- 不改变 `schemas/*.json` 的字段含义。

## 4. 内容协议：Agent 继续写这些，前端只读

学习工作区布局不变，见 [使用说明 §六](../使用/使用说明.md#六学习数据存在哪)。阅读端只消费下列文件：

| 数据 | 路径 | 阅读端用途 |
|---|---|---|
| 科目大纲 | `<subject>/curriculum.yaml` | 路线图、前后课、课型 |
| 课件正文 | `<subject>/lessons/<序号>-<节点id>.md` | 课件页。front matter 仍只有 `title` 与 `goal` |
| 题库 | `<subject>/lessons/<序号>-<节点id>.quiz.json` | `Quiz` 组件。锚点仍与正文 `::: quiz` 逐字对应 |
| 进度 | `<subject>/progress.yaml` | 节点状态、项目里程碑、「继续学习」 |
| 科目信息 | `<subject>/subject.yaml`、`MISSION.md` | 科目主页抬头 |
| 共享记忆 | `.learning/` 下既有记忆文件 | 只展示，不在前端改写 |

两条硬边界：

1. **源文件仍是 Markdown / YAML / JSON。** VitePress 不成为第二套课件语法。`:::` 指令、KaTeX、图片池路径继续按 [课件内容格式](../规范/课件内容格式.md) 解释。
2. **前端不回写学习数据。** 进度、误解、会话摘要仍由总控按 `record-keeping` 写盘。Vue 组件只读，避免和沙箱写权限、暂存区搬运打架。

## 5. 建议组件

组件放在 `site/.vitepress/theme/components/`，不进科目目录，避免每个科目再拷一份：

| 组件 | 替代什么 | 输入 |
|---|---|---|
| `Roadmap.vue` | 科目页 `.learn-roadmap` 手写交互 | `curriculum.yaml` + `progress.yaml` |
| `Quiz.vue` | `templates/assets/quiz.js` 的展示层 | `.quiz.json` 里该锚点的题目数组 |
| `Progress.vue` | 状态概览条 | `progress.yaml` |
| `LessonMeta.vue` | 课型、状态、前置 | 大纲节点 |
| `ContinueLearning.vue` | 总览页当前节点入口 | 各科目进度里的当前节点 |

`Quiz.vue` 第一期只展示题面、选项和解析，不负责判分回写。判分与证据核验仍走 `practice-evaluator` 和 `evidence-check`。

## 6. 分阶段落地

### 阶段 0：本提案

只增加文档和指针。`npm test` 行为不变。合并不发布，版本号仍由维护者处理。

### 阶段 1：只读阅读端

- 新增 `site/`，VitePress 从示例工作区或 `STUDYMATE_WORKSPACE` 指向的目录读数据；
- 提供总览、科目主页、课件页三条路由；
- 用一个同步或加载脚本把 `curriculum.yaml` 映射成侧边栏，不把工作区 Markdown 复制进 git；
- `examples/` 仍由 `python3 scripts/build_examples.py` 生成 HTML。阅读端是平行入口，不是替换品。

阶段 1 的验收：clone 后 `npm --prefix site run docs:dev` 能点开 `examples/` 里的线性代数与计算机网络；不改任何 `.dsh/skills/`。

### 阶段 2：组件对齐现有交互

路线图着色、题目位置、公式渲染与现有 HTML 页面对齐。KaTeX 继续离线，不引入 CDN。暗色仍是默认主题，和 [工程约束 §五](../规范/工程约束.md#五前端技术选型) 一致。

### 阶段 3：再决定 HTML 是否降为导出

只有阶段 1–2 覆盖了主页、课件、练习、离线打开之后，才讨论让 Agent 停止触发 HTML 渲染、把 HTML 收成 `export`。在那之前，DSH 安装路径和「浏览器直接打开 index.html」保持不变。

## 7. 风险

- **双渲染器漂移。** 阶段 1 必须复用同一份 Markdown / 题库，禁止在 `site/subjects/` 里手写第二份课件。
- **工作区不可入库。** `workspace/` 继续 gitignore。站点构建只读外部工作区或 `examples/`。
- **门禁膨胀。** VitePress 依赖不进现有 `npm test`，单独用 `npm --prefix site run docs:build`。等阅读端稳定后再考虑是否接入 CI。
- **公式与图片路径。** 课件相对路径按 `lessons/` 解析，阅读端要保持同一规则，否则图片池会断。

## 8. 建议的下一步

若维护者认可边界，下一张 PR 只做阶段 1 的空壳：`site/`、一份只读加载说明、一条不纳入 `npm test` 的构建脚本。不要在同一张 PR 里改技能、模板和示例 HTML。
