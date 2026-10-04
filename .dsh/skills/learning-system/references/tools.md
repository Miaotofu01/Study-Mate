# 原生工具契约（DSH 专属）

**这份文件是给总控与角色按需读的参考，不是常驻指令**：参数表、返回形状、域边界、错误形状与旧命令对照都在这里；技能正文只留「这件事为什么要做、做到什么算好」。**别把它背进上下文**——要用哪个工具时再读它那一节。

**唯一出处是代码**：八个工具在 [`lib/tools/index.ts`](../../../../lib/tools/index.ts) 的注册点注册，名字表 `STUDY_TOOL_NAMES` 与注册顺序同在那一份里。本文件与代码不一致时以代码为准，并回来改这一份。

## 一、先读这一节：宿主差异

| 宿主 | 怎么执行 |
|---|---|
| **DSH** | 有原生工具：直接调下面这八个 `studymate_*`，拿结构化返回 |
| **Antigravity / Codex / ChatGPT Work** | **没有原生工具，也没有引擎脚本**——下面这些名字在那些宿主里一个都不存在。正文里点名它们的地方，导出时已换成**本宿主的做法**：按 `<root>/schemas/*.schema.json` 与技能里的格式要求逐项自查，并把自查结论如实报出；导出走 `npx -y @yunmiao/studymate@latest export`。映射表在两个适配器的 `NATIVE_TOOL_FALLBACK`，导出稿由各自的「宿主约定」写明这一点 |

无头侧**不要把工具名当成能调用的东西**，也不要假装调用过；缺的能力按宿主约定如实说明。

> 名字的形态是刻意的：用下划线不用点号（`studymate_workspace_context`），因为工具名会原样进模型 API 的 `tools[].name`，而 OpenAI 兼容接口只接受 `^[a-zA-Z0-9_-]+$`。目标态规格 §3.1 写的 `studymate.workspace.context` 是待落地提案名，按这条改成了下划线——这是一处记在案的偏差。

## 二、参数表

必填项加粗。路径参数三种写法都认：**绝对路径**、**相对工作区的路径**、**科目 slug**（`numpy` 这种短名）。

| 工具 | 参数 | 什么时候用 |
|---|---|---|
| `studymate_workspace_context` | `subject?`（slug；省略＝全部科目） | **开场只调这一次**：拿工作区路径、今天、科目现状、最近学习记录、共享记忆与可用能力 |
| `studymate_validate_curriculum` | **`paths`**（数组：数据文件或科目目录） | 大纲／进度／科目档案写完、角色报回规模之后核对；给目录就校验它的三份数据文件 |
| `studymate_validate_lesson` | **`paths`**（数组：内容文件、`lessons/` 目录或科目目录）、`subject?`（用来取这一课的标题） | 内容文件与题库写完、搬入之后过内容层：格式、锚点四态对账、图片存在性 |
| `studymate_validate_pool` | **`paths`**（数组：科目目录或它的 `assets/img/pool.md`） | 采图角色交回、或讲解自产图追加索引之后 |
| `studymate_validate_handoff` | **`stage`**（暂存目录）、**`role`**（期望的角色名）、`node?`（节点级任务给节点 id） | **任何 `deliver/` 合并之前**：交接边界过不过 |
| `studymate_renumber_lessons` | **`subject`**（科目目录或 slug）、`dryRun?` | 大纲插/删节点之后重排课件位次；不确定就先 `dryRun` 只算不改 |
| `studymate_apply_empty_reasons` | **`subject`**、**`node`**（节点 id）、**`reasons`**（数组：每项一个 `anchor` 与它的 `reason`，锚点与正文逐字匹配）、`dryRun?` | 出题角色交回无题理由时：把 `empty_reason:` 打进内容文件（**别手工开文件改**） |
| `studymate_export` | `subject?`（slug；省略＝全部科目） | 学生要一份能离线看的；**#82 落地前是占位**，见 §9 |

> 任务域（`studymate_task_status` / `_wait` / `_cancel` / `_destroy` / `_resume`）不在本表：那是插件自己跑的后台工作（导出、格式转换、索引重建）的句柄，契约见 `lib/tasks/tools.ts`。它只有一条常驻纪律——**状态查询从不阻塞，等待有上限，超时会告诉你下一步**。

## 三、返回形状与空值口径

共同约定：**返回的是事实，不是结论**。校验器给「逐条问题 + 一句放行/阻断」，不给退出码；空的地方给明确的空值，不给 `null` 之外的猜测。

### `studymate_workspace_context`

```text
{ workspace: { path, configFile, subjectsDir, today, timeZone, ready },
  subjects: [ { slug, name, goal, status, updated_at, project, levels,
                tierCounts: { 未开始, 学习中, 已学完 },
                current: <节点> | null,
                nodes: [ { id, title, kind, number, tier, lesson } ],
                recentRecords: [ { file, title, date, markdown } ] } ],
  memory: { file, present, markdown },
  capabilities: { model: { available, reason?, providers? } },
  notes: [ "…" ] }
```

- `ready: false`：**不抛异常**——开场问"学什么"之前工作区可能还没建。这时 `subjects: []`、`memory.markdown: ""`，`notes` 里有一句该怎么办（没配工作区就提示跑一次 `npx @yunmiao/studymate install`）。
- `current: null` 是「这门课还没有节点」，不是「读失败」；`nodes: []` 同理。
- `recentRecords` 每个科目**最多 5 条**（开场要的是"最近学到哪"，不是整本档案）。
- 逐域投影：`subjects` 的切片里**没有**题库、没有课件正文——真去读别的域会当场越权抛错（§4）。

### 四个校验器

```text
{ reports: [ { file, kind?, dir?, indexFile?, rows?, node?, poolFile?, poolPresent?,
               summary, blocking, blockingCount, problems: [ { file, line, message, blocking, column? } ] } ],
  blocking, blockingCount, summary }
```

- `problems` 每条带 `file` 与 `line`（1 起），`blocking: true` 是阻断、`false` 是提示——**打回按它，不按你自己的判断**。
- `validate_lesson` 另给两份对账清单：`anchors: [{ text, resolution, line, keys }]`（`resolution` 四态：`resolved` / `stale` / `ambiguous` / `missing`，**多匹配绝不静默取第一个**）与 `orphans: [{ key, line, count }]`（题库里没有对应锚点的键）。
- 空值口径：没问题时 `problems: []`、`blockingCount: 0`、`summary: "放行——没有问题"`；文件不存在是**一条阻断问题**（`line: 1`），不是异常。
- `validate_handoff` 的形状不同：`{ stage, verdict: 'pass' | 'block', blocking, blockingCount, role: string | null, outputs: <产物条数>, summary, problems }`。`verdict: 'block'` 时**不搬、不删 stage**。

### 两个改写工具

```text
renumber_lessons → { subject, dryRun, ok, renames: [ { node, ext, from, to, applied } ],
                     changedNodes: [ … ], duplicates: [ { node, ext, files } ],
                     untouched: [ { file, reason } ], summary, problems }
apply_empty_reasons → { subject, node, file, dryRun, ok,
                        inserted: [ { anchor, reason, line } ], summary, problems }
```

- 都支持 `dryRun`：只算不改，回报"将要改的名 / 将插入的行与位置"。
- `duplicates` 与 `untouched` 是**如实报出的不确定**（同名两份、认不出的命名），不是静默跳过。
- `ok: false` 时看 `problems` 与 `summary`，别把它当"跑完了"。

## 四、域声明表与「越权即抛」

每个工具在定义里**写死**自己读哪些域、写哪个域的哪些字段（`lib/tools/domains.ts` 是域词表）。**声明之外的读写当场抛 `DomainViolationError`**——不是文档约定，是执行点：写越权时回调一次都不跑。

| 工具 | 读域 | 写字段 |
|---|---|---|
| `studymate_workspace_context` | workspace / memory / subjects / curriculum / progress / records | — |
| `studymate_validate_curriculum` | workspace / curriculum / progress / subjects | — |
| `studymate_validate_lesson` | workspace / curriculum / lessons / pool / assets | — |
| `studymate_validate_pool` | workspace / assets | — |
| `studymate_validate_handoff` | handoff（只读盘上快照） | — |
| `studymate_renumber_lessons` | workspace / curriculum / lessons | `lessons/*` |
| `studymate_apply_empty_reasons` | workspace / curriculum / lessons | `lessons/*#empty_reason` |
| `studymate_export` | —（一份学习数据都不读） | `export/**` |

域词表（`DOMAINS`）：`workspace`（路径、配置、今天、时区、找科目）、`memory`、`subjects`、`curriculum`、`progress`、`lessons`、`pool`、`assets`、`records`、`reference`（学生自加的资料，ADR-0010）、`misconceptions`、`handoff`、`export`（**只写**，读它会抛）。新增一个域要同时改域词表与 `vault.ts` 的读法。

**对技能的意味**：一个工具读不到的东西，就是它**不该**碰的东西。需要越界时不是绕开 guard，而是把域加进工具定义——那是改代码，不是改提示词。

## 五、能力协商：`{available:false, reason}` 与 `requires:['model']`

- 工具可以声明 `requires: ['model']`。**没有可用模型时它不跑 body**，直接返回 `{ available: false, reason }`——这是**协商结果，不是失败**：别的工具照常可用，阅读端仍能读、能导出。
- 调用方拿到这个形状时：把 `reason` 如实告诉学生，换一条不依赖模型的路，别重试、别假装答过。
- **今天八个工具都没有声明 `requires`**（它们都是纯数据操作）；机制在 `lib/tools/define.ts`，将来需要模型的工具按它协商。

## 六、错误形状

工具的错误一律是**能照着改的消息**，不是空值：

| 场景 | 报什么 |
|---|---|
| 越过声明读写 | `[DOMAIN_VIOLATION] 工具「X」读域「Y」（target）是越权：…；它声明的读域是 …。要碰这份数据就把域加进工具定义，绕开 guard 拿不到数据。` |
| 参数不合法 | `工具「X」的参数不合法：<逐条问题>（共 N 条）` |
| 调用被取消 | `工具「X」已取消` |
| 组合里没有 tools 服务 | 注册期就报「当前宿主没有 ctx.tools…」——那是宿主组合问题，不是学习数据问题 |

**打回给谁按问题的归属**：内容问题 →「讲解」，题库与锚点 →「出题评估」，缺的是科目组件或共享层文件 → 总控自己按 `record-keeping` 补齐。**别把工具报的问题转述成自己的判断**，原文转给产出者。

## 七、什么时候用哪个

| 你想知道 | 用 | 不要用 |
|---|---|---|
| 学到哪、下一步学什么 | `studymate_workspace_context`（一次） | 挨个读配置文件、进度、记忆、大纲 |
| 大纲/进度/科目档案合不合法 | `studymate_validate_curriculum` | 自己读 YAML 数节点、数边 |
| 内容文件与题库对不对得上 | `studymate_validate_lesson` | 手工比锚点（"位 ↔ 题"交给它） |
| 图片库索引与图片对不对得上 | `studymate_validate_pool` | 数索引行 |
| 角色交回的东西能不能合盘 | `studymate_validate_handoff` | 读角色回复里的"我完成了" |
| 大纲改了、课件位次要重排 | `studymate_renumber_lessons` | 自己改文件名 |
| 无题锚点要写理由 | `studymate_apply_empty_reasons` | 手工开内容文件改 |
| 要一份能离线看的 | `studymate_export`（#82 前是占位） | 自己跑渲染脚本 |

## 八、无头宿主侧怎么办（没有脚本可跑）

Antigravity / Codex / ChatGPT Work 上没有原生工具，也**没有引擎脚本**（Python 引擎随 #83 退役，
无头插件里只有技能、schema、工作区数据骨架与文档）。所以那两侧的做法是：

| 你要做的事 | 在本宿主怎么做 |
|---|---|
| 读工作区现状 | 直接读工作区配置、`.learning/MEMORY.md`、当前科目的 `progress.yaml` 与最近的学习记录 |
| 数据层校验 | 按 `<root>/schemas/{curriculum,progress,subject}.schema.json` 逐项自查：字段齐全、`prerequisites` 指向存在的节点 id、无环、实验课前置非空 |
| 内容层校验 | 按内容格式逐项自查：`:::` 指令成对、`::: quiz` 锚点与题库键逐字一致、图片路径真实存在、公式标记成对 |
| 图片库校验 | 按图片库规范逐项自查：图片落在 `assets/img/pool/`、索引七列表头逐字一致、命名可检索、体积合规 |
| 交接门禁 | 按 `deliver/` 清单逐项自查：manifest 与交付文件一一对应、角色与节点对得上、路径不越界、没有符号链接 |
| 位次重排 | 按 `curriculum.yaml` 的节点顺序改 `lessons/` 的文件名序号（`NNNN-<节点id>.<后缀>`），先列清单再动手 |
| 无题理由 | 把 `empty_reason:` 写进内容文件对应的 `::: quiz` 块（锚点逐字匹配，别动正文其余部分） |
| **导出**（学生的阅读体验全靠它） | `npx -y @yunmiao/studymate@latest export`——没有参数也能跑，产物落 `<LEARN_WORKSPACE>/export/`，入口 `index.html` |

**自查的结论要如实报出**：说不清的一律不算通过，也不要说"已通过校验"却没有逐条结论。
