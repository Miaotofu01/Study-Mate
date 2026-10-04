# 阅读端原型

> **一次性代码。** 回答一个问题：**阅读端该长什么样。** 问完就搬走——结论合进主干，
> 整个目录进一次性分支。不要在本目录上继续加功能。
>
> **结论已落（2026-10-04）：选了变体 B（三栏工作台），按它做成了真插件页——
> Client 半在 `lib/client.js`（注册进宿主 `main` 槽），Host 半在 `bin/dsh-plugin.mjs`
> （`GET /api/studymate/library` 读学习工作区）。本目录从此只作「当时比过哪三种」的记录。**

## 它回答什么

[目标态规格](../../docs/设计/目标态规格.md) §4 已经把信息架构定死了：

```text
今天学什么 / 科目（路线图 + 附件）/ 课件（正文 + 题目 + lab）/ 搜索 / 问答面板
```

没定的是**这些界面长什么样、主要动作是什么、注意力先给谁**。这个原型把同一份真数据摆成
三种结构不同的版式，翻着看，挑一套（或者「A 的头 + C 的题目」这样拼）。

| 变体 | 主张 | 主要动作 | 题目在哪 |
|---|---|---|---|
| **A 单栏阅读器** | 主业是「读」 | 往下滚 | 长在正文里该出现的位置 |
| **B 三栏工作台** | 同时看全，键盘驱动 | 点左树、盯右栏 | 抽出正文流，在右侧检查器里 |
| **C 卡片流与专注模式** | 一次只做一件事 | 首页挑一张卡，进专注模式推进 | 全屏覆盖，一次一道 |

三个变体不是配色差异：A 是文档流、B 是固定三栏、C 是全屏分节。翻的时候先看**结构**，
别看颜色。

## 怎么跑

```bash
npm run prototype        # 起静态服务器，打开它打印的地址
```

不要直接双击 `index.html`：浏览器不允许 `file://` 页面读同目录的 JSON（那个页面上会写明这条）。

切变体：底部那条胶囊用 ← →，或者键盘左右键，或者直接改 URL。一条链接能直接指向某个变体的某个界面，
发给别人看就是这么发：

```text
http://127.0.0.1:4173/?variant=B                      # B 的首页
http://127.0.0.1:4173/?variant=B&view=lesson&node=net.ip   # B 的课件页，直接停在 net.ip 这一课
http://127.0.0.1:4173/?variant=C&theme=light          # C 的浅色
http://127.0.0.1:4173/?variant=A&bare=1               # 连原型顶栏都不画，出干净截图用
```

| 参数 | 值 | 作用 |
|---|---|---|
| `variant` | `A` `B` `C` | 选变体 |
| `view` | `home` `subject` `lesson` `search` | 直接进某个界面（不写就沿用上次看的位置） |
| `subject` | 科目 slug | `computer-networks` / `linear-algebra` |
| `node` | 节点 id | 例如 `net.ip`（只对 `view=lesson` 有意义） |
| `theme` | `light` `dark` | 定死主题 |
| `bare` | `1` | 不渲染原型顶栏 |

动效档在顶栏「动效」下拉里切（`auto` / `full` / `reduced` / `off`），锚点四态在「锚点」下拉里切。

## 看的时候重点看这几处

- **今天学什么**：三个变体对「继续学」的权重差很多——A 是两张大卡、B 是左栏里的紧凑入口、
  C 是看板首屏。哪种更让人想开始？
- **科目路线图**：A 是分层竖排、B 是真图（前置依赖连成 SVG 线）、C 是横向层卡。
- **课件**：同一节课，A 一路滚到底、B 正文与题目分家、C 一节一屏。**这是三个变体差异最大的地方**，
  也是这次最值得定的一件事。
- **题目**：A 在流里就地判、B 在右栏跟着滚动位置高亮、C 全屏一次一道。
- **问答面板**：A 从底部升起、B 占右栏一个 tab、C 从右侧滑入。三种都不经过总控。
- **锚点四态**：顶栏「锚点」下拉能强行把当前课件置成 `stale` / `ambiguous` / `missing`，
  看三个变体各怎么报这件事（多匹配绝不静默取第一个，非 `resolved` 时判分入口关闭）。
- **动效四档**：顶栏「动效」下拉对应 `auto/full/reduced/off`。

## 数据是真的，作答是假的

- **学习内容全部来自 [`examples/`](../../examples/)** 的两个示例科目（计算机网络、线性代数）：
  大纲、进度、误解记录、术语表、学习记录、课件内容文件、题库，**一个字没改**。
  由 `tools/build-data.py` 抽成 `data/workspace.json` + `data/lessons/*.md`：

  ```bash
  npm run prototype:data
  ```

  与目标态的差别只有一处、且是刻意的：那边由 Host 半监听工作区、按变更通知推给页面，
  这里退化成构建期抽一次静态快照，前端 `fetch` 一次完事。

- **作答数据是内存里的桩**：刷新即丢。演示「上次你选了 B」用的两条种子是**假造的**
  （见 `js/data.js` 顶部的 `seeded`），不是 `examples/` 里的真实作答历史。
  真实现是 `attempts/<NNNN>-<节点id>.json`，写回要走 `operationId` + `expectedVersion`，
  冲突时拒绝并重读——原型不碰这条路，也不回写任何文件。
- **问答面板的回答是占位**：真实现是面板独立调模型（目标态 §7.4，上下文只带当前课件 +
  选中文本 + 共享记忆）。原型不接模型，回一段明显是假的文字，界面上带「原型 · 假回答」徽标。

## 结构

```text
prototype/reading-client/
├── index.html            壳：样式/脚本引用、加载中与 noscript 兜底
├── css/
│   ├── tokens.css        token 层：名字照宿主的 --dsw-alias-* 起，值本地兜底；亮暗两套
│   ├── content.css       内容排版：正文/代码/表格/图/题目/原子——三个变体共用
│   ├── switcher.css      原型顶栏（不是设计的一部分）
│   └── variant-a|b|c.css 各变体的版式
├── js/
│   ├── util.js           DOM 构造、行内 Markdown、图标、会话位置记忆、主题
│   ├── content.js        课件内容文件解析器 + 块级渲染（版式无关，共用）
│   ├── quiz.js           判分、作答记账、锚点四态判定（共用）
│   ├── data.js           读 workspace.json、跨科目搜索索引、问答桩
│   ├── switcher.js       底部变体切换条 + 原型专用开关
│   ├── app.js            入口：读 ?variant=、挂变体、恢复阅读位置
│   └── variant-a|b|c.js  三个变体各自成篇
├── tools/
│   ├── build-data.py     从 examples/ 抽数据
│   └── shot.mjs          无头 Chrome 自检：走通三个界面 + 收错误 + 出截图
└── data/                 构建产物（workspace.json + lessons/）
```

**解析共用、渲染共用、编排不共用**：`::: quiz` 这类块怎么解析、一道题长什么样，三个变体
必须一致，否则比的就成了排版差异；题目在不在正文流里、正文分不分屏，是各变体自己的事。

`js/content.js` 按[课件内容格式](../../docs/规范/课件内容格式.md) §4 实现全部指令：
`practice` / `quiz`（含 `empty_reason:`）/ `figure` / `svg` / `tip` / `warn` / `note` /
`resources` / `related`，图与示意图共用一条编号序列、只有写了 `caption:` 的才占号。
对六份真课件跑一遍解析，零个认不出的块。

> 一处**没被真数据走过**的路径：`::: figure`（示例工作区的图片库是空的，六份课件里没有一张图），
> 渲染与路径解析都写了，但没验过。其余块都被真内容覆盖。

## 自检

```bash
node prototype/reading-client/tools/shot.mjs                          # 三个变体 × 七个场景
node prototype/reading-client/tools/shot.mjs --only B                 # 只跑一个变体
node prototype/reading-client/tools/shot.mjs --width 900 --scenes home,lesson   # 窄屏
```

七个场景：`home` · `subject` · `lesson` · `lesson-answered`（点一道题）· `search` ·
`qa`（选中正文 → 问一句 → 出回答）· `anchor-stale`（把锚点置成 stale）。

无头 Chrome 走一遍，收**控制台错误、页面错误、失败请求**，整页截图写到 `.shots/`（**不入库**），
`summary.json` 里是每个场景的结论。定位靠变体自己贴的 `data-proto` 钩子
（`nav-subject` / `open-node` / `option` / `qa-chip` / `qa-input`），不靠类名——类名是版式的一部分。

## 收尾（问完之后）

1. 把选中的那套（或拼出来的那套）**重写**进真正的阅读端，别直接搬：这里的代码是原型约束下
   写的，没有测试、没有错误处理、没有按需取数。
2. 整个 `prototype/` 目录进一次性分支，主干只留结论；原型的价值是「当时比过哪几种」，
   留在主干上只会腐坏。
3. 顺带删掉 `package.json` 里的 `prototype` 与 `prototype:data` 两条脚本。
