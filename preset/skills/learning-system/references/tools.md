# 原生工具契约（DSH 专属）

**这份文件是给总控与角色按需读的参考，不是常驻指令**：参数表、返回形状、域边界、错误形状与旧命令对照都在这里；技能正文只留「这件事为什么要做、做到什么算好」。**别把它背进上下文**——要用哪个工具时再读它那一节。

**唯一出处是代码**：九个学习数据工具在 [`lib/tools/index.ts`](../../../../lib/tools/index.ts) 的注册点注册，名字表 `STUDY_TOOL_NAMES` 与注册顺序同在那一份里（另有任务域五个与实验域一个，见各自的目录）。本文件与代码不一致时以代码为准，并回来改这一份。

## 一、先读这一节：宿主差异

| 宿主 | 怎么执行 |
|---|---|
| **DSH** | 有原生工具：直接调下面这九个 `studymate_*`（以及任务域五个、实验域一个），拿结构化返回 |
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
| `studymate_verify_sources` | **`manifest`**（「资源清单」的路径：`RESOURCES.md` 本身、含它的科目目录，或暂存目录里的 `deliver/RESOURCES.md`）、`offline?`（只用缓存、不发请求）、`refresh?`（忽略缓存重核） | 角色交回清单、或搬进科目之后：把清单里的链接并发探一遍，报出打得开／打不开，结论按 URL 记在插件缓存里（再核只补增量）。`offline` 时一个请求都不发；`refresh` 时忽略缓存重核 |
| `studymate_lab_run` | **`subject`**（slug）、**`node`**（节点 id）、**`question`**（题 id：`<锚点文本>#<题号>`）、`cwd?`（相对这一课的 lab 实验目录，默认 `.`）、`writable?`（数组：声明这次会写的相对路径）、`predicted?`（学生先写下的预测）、`selfAssessment?`（`答对了` / `答了一半` / `没答上`，**只有学生能选**） | 判分三轨的第三轨（规格 §7.3）：`交付物` 题要**可运行证据**时，Host 半在学生本机上代跑那道题里**声明过的**命令。读 §3 的那一节，先看清「命令从哪来」与边界 |

> 任务域（`studymate_task_status` / `_wait` / `_cancel` / `_destroy` / `_resume`）不在本表：那是插件自己跑的后台工作（导出、格式转换、索引重建）的句柄，契约见 `lib/tasks/tools.ts`。它只有一条常驻纪律——**状态查询从不阻塞，等待有上限，超时会告诉你下一步**。

### 答疑模式专用的只读工具（`studymate_lesson_read`）

**它不在上面那张表里，也不在学习会话的工具面上**：它由「答疑模式」预设那条插件行
（[`lib/tools/qa-preset.ts`](../../../../lib/tools/qa-preset.ts)）注册进**预设自己的作用域**，
只有阅读端右栏那条答疑会话看得见（`local-qa` 那条链上唯一的工具）。名字表在
[`lib/tools/index.ts`](../../../../lib/tools/index.ts) 的 `QA_TOOL_NAMES`，与学习面那九条并列、
不混——**别把它算进总控能调的那批工具**。

| 工具 | 参数 | 什么时候用 |
|---|---|---|
| `studymate_lesson_read` | **`node`**（大纲里的节点 id，例如 `net.ip`） | 答疑会话要学生问的那一段所在课的正文、或这一节点的题时：给节点 id，一次拿回这一课与它的题（答疑的上下文只有三样，课件就是靠这一下取的） |

返回形状：`found: true` 时给 `node` / `subject`（科目 slug）/ `file`（`lessons/` 下的文件名，空串＝这一课还没有正文文件）/ `markdown`（那一课正文）/ `questions`（数组，每项 `{ anchor, questions }`；题目的字段形状归 [`schemas/question.schema.json`](../../../../schemas/question.schema.json)）/ `alsoIn`（别的科目里也有同一个节点 id 时列在这里）。

读不到时给 `{ found: false, node, reason }`——节点不存在、id 带路径分隔符或 `..`、还没有正文文件，都走这一条，**不抛异常**（会话里不该因为一次取课件失败就断）。域边界：只读 `lessons` 与 `pool` 两个域，`writes` 为空——跑一遍一个字节都不落盘。

## 三、返回形状与空值口径

共同约定：**返回的是事实，不是结论**。校验器给「逐条问题 + 一句放行/阻断」，不给退出码；空的地方给明确的空值，不给 `null` 之外的猜测。

### `studymate_lab_run`

**命令不在参数里**：它来自题库里那道题。取值顺序是写死的——定位到 `kind: 交付物` 的那道题 → 读它的 `证据` 字段 → **空白切词**（不开 shell）。模型与学生**都没有**「现编一条命令」的入口。命令读不下来（带引号 / 管道 / 重定向 / 变量 / 通配）当场拒，并让你把那些东西写成 lab 目录里的脚本文件。

四种结局，每种都是一句能照着改的话：

| `状态` | 意思 |
|---|---|
| `跑完了` | 命令跑过了（**起不来也算这一种**，`跑.结局` 会写 `起不来`）。`跑` 里是事实：`命令` / `argv` / `程序` / `cwd` / `可写` / `退出码` / `信号` / `结局`（`跑完` / `超时` / `取消` / `起不来`）/ `毫秒` / `stdout` / `stderr` / `字节` / `截断` / `起不来`；`作答数据` 说清落没落进 `attempts/` |
| `还在跑` | 命令最长跑 120 秒。这一次没等到，`任务` 里是句柄：用 `studymate_task_status` / `_wait` 查、`studymate_task_cancel` 取消（回执会说清哪些已完成的产物保留） |
| `拒了` | 没跑任何命令。`拒.为什么` 说原因、`拒.下一步` 说怎么改、`拒.边界` 给允许的范围（例如那条 cwd 该落在哪个目录里） |

**没有「通过」这个字段，也不许加**：`退出码` 是数字原样，非零**如实记、不是失败判决**；`结局` 只说这次是怎么结束的。通过与否由学生看输出后**自己选自评**（`selfAssessment` 那一栏只有学生能填，模型不许替他填）——三轨里没有一轨叫 agent（规格 §7.3）。

边界（越界一律拒，不警告）：

- `cwd` 与 `writable` 都在**这一课的 lab 实验目录**里（`lab/<NNNN>-<短名>/`）；参数里的绝对路径不许出工作区；已有的软链按真身判。
- 命令的环境变量是**白名单重建**的：`HOME` / `TMPDIR` 指向本次运行专用的临时目录，跑完删掉；学生的 `SSH_AUTH_SOCK` / `AWS_*` 这类不会递给孩子。
- 两条流各留 64 KiB，超了头尾都留、中间截掉，`截断` 字段如实写 `true`。**这不是 OS 级沙箱**：能挡的是命令的固定部分指着外面，挡不住程序运行期自己算出来的路径。

学生那边有同一件事的**页面入口**（阅读端课件页「题目」tab 的「跑一次」按钮，走的 `POST /api/studymate/lab-run`）——它与你调这个工具走的是同一份实现（`lib/lab/tools.ts` 里的计划与执行两段），所以边界、拒绝理由、事实字段逐字相同。**不要**替学生按那个按钮。

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

### `studymate_verify_sources`

```text
{ manifest, total, ok, failed, cached, probed, pending,
  route: '直连' | '代理' | '未探',
  hosts: [ { host, entries, ok, failed } ],
  failures: [ { line, url, status, note } ],
  summary, next, cache }
```

- `failures` 只列**这一轮真探过且打不开**的那几条（`line` 是清单里 1 起的行号、`status` 是 HTTP 状态码或 0、`note` 是一句原因）；缓存里带回来的旧结论**不在这里**，要全量明细去读 `cache` 指的台账。
- `cached` 是这一轮直接用的缓存条数，`probed` 是真发出去的条数，`pending` 是没轮到的。`route` 是这一轮实际走的路：先直连，**连接层**失败（DNS／连接被拒／证书）且有代理才换代理，换通了就把表用到队尾；HTTP 4xx／5xx 不换路。
- `pending > 0` 时 `next` 会让你**用同一个 manifest 再调一次**——缓存让第二遍只探剩下的；都探完还有打不开的，`next` 会叫你去掉或换成等价来源。
- **返回值刻意短**：不列 118 条明细。宿主对工具结果有 8192 字符的截断，长清单的逐条明细会被悄悄切掉（读起来像"只核了前 60 条"），所以明细留在缓存里、报告只给计数与打不开的那几条。
- `offline: true` 时不发一个请求：只拿缓存里还新鲜的结论，其余原样进 `pending`。

## 四、域声明表与「越权即抛」

每个工具在定义里**写死**自己读哪些域、写哪个域的哪些字段（`lib/host/domains.ts` 是域词表）。**声明之外的读写当场抛 `DomainViolationError`**——不是文档约定，是执行点：写越权时回调一次都不跑。

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
| `studymate_verify_sources` | workspace / resources（只读 `RESOURCES.md` 这一份清单） | —（结论缓存落在 `<DSH_HOME>/studymate/reach/cache.json`，那不是学习数据的域） |
| `studymate_lab_run` | workspace / pool / lab / attempts | `attempts/**`（只写「跑」那一格，走 `lib/attempts.ts` 的栅栏） |

域词表（`DOMAINS`）：`workspace`（路径、配置、今天、时区、找科目）、`memory`、`subjects`、`curriculum`、`progress`、`lessons`、`pool`、`assets`、`records`、`reference`（学生自加的资料，ADR-0010）、`misconceptions`、`lab`（`subjects/<slug>/lab/<NNNN>-<短名>/`，读它要同时给 `node`）、`attempts`（`subjects/<slug>/attempts/<NNNN>-<节点id>.json`，读它也要给 `node`）、`handoff`、`export`（**只写**，读它会抛）、`resources`（`RESOURCES.md` 这一份，科目目录里或暂存目录的 `deliver/` 下；不认别的文件名）。新增一个域要同时改域词表与 vault 的读法——词表、guard 与读法的实现在 `lib/host/{domains,access,vault}.ts`（`lib/tools/` 下那三份只做转发，别再往转发处加逻辑）。

**对技能的意味**：一个工具读不到的东西，就是它**不该**碰的东西。需要越界时不是绕开 guard，而是把域加进工具定义——那是改代码，不是改提示词。

## 五、能力协商：`{available:false, reason}` 与 `requires:['model']`

- 工具可以声明 `requires: ['model']`。**没有可用模型时它不跑 body**，直接返回 `{ available: false, reason }`——这是**协商结果，不是失败**：别的工具照常可用，阅读端仍能读、能导出。
- 调用方拿到这个形状时：把 `reason` 如实告诉学生，换一条不依赖模型的路，别重试、别假装答过。
- **今天这九个工具都没有声明 `requires`**：这批里只有核验那个（`studymate_verify_sources`）会发网络请求，其余都是纯数据操作，核验那个也不需要模型，所以一个都不协商；机制在 `lib/tools/define.ts`，将来需要模型的工具按它协商。

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
| 在学生本机上代跑题目里声明的测试命令（`studymate_lab_run`） | **没有等价做法**：无头宿主没有「学生本机」这条通道，如实说明这一轨在那里跑不了（别假装跑过、也别把输出编出来）。学生自己在终端里跑那条命令，再把输出贴回来 |
| **导出**（学生的阅读体验全靠它） | `npx -y @yunmiao/studymate@latest export`——没有参数也能跑，产物落 `<LEARN_WORKSPACE>/export/`，入口 `index.html` |

> 这里以前是一张「旧命令 → 新工具」的对照表。旧命令已经不存在了（Python 引擎随 #83 退役），
> 表也一并退役：留着它只会让人以为还能照旧命令做事。

**自查的结论要如实报出**：说不清的一律不算通过，也不要说"已通过校验"却没有逐条结论。
