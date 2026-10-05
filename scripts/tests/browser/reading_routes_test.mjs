/* 阅读端**四路由 × 三档视口**的渲染套件（#86、紧档 #88）。
   ────────────────────────────────────────────────────────────────────────────────
   为什么单开一条：同目录的 reading_test.mjs 恒定 1440×960，于是 `lib/client.js` 里两条
   `@media (max-width: 900px)` 的响应式规则**从来没被执行过**（父 spec #84 的「现状与差距」
   四把它记成覆盖缺口）。这一条按**路由**取景：今天学什么 / 科目主页 / 课件页 / 搜索
   各一个场景，三档视口各跑一遍；亮暗两套的实测对比度与动效四档也在这里。
   第三档（紧档 700×900）是 #88 加的：课件页的右栏在那一档并排装不下，必须是
   「盖在正文上 + 说明 + 收起」的抽屉——「点题目没反应」正是那张票要消掉的缺陷。

   夹具怎么搭与 reading_test.mjs 同一套（真 `lib/client.js` + `fixtures/mini-react.js` +
   `fixtures/host-theme-tokens.json` 的宿主 token + 现抠的内联 CSS + stub 掉 `fetch`/`EventSource`），
   差别只有三处：
     · 课件页那份夹具**带公式、配图、代码块与题目**（四个面的取景要有真东西可看）；
     · 配图写成 `data:` URL——夹具页走 `file://`，取图路由 `/api/studymate/asset` 到不了
       任何服务端，`<img>` 会以「失败请求」把整个场景判红。这里量的是「位图进了正文」这条
       呈现面，取图路由本身不在本套件的验收面上；
     · 夹具页把 `ResizeObserver` 换成一个只在 observe 时报一次真实尺寸的垫片——mini-react
       每次重渲染整树重建 DOM，被 effect 闭住的旧节点一脱离文档就报 0 宽，于是画布宽被写成
       0、两条栏永远打不开。这是夹具边界不是客户端缺陷，垫片那一处的注释把账记全了。

   口径（别顺手改回去）：
     · 断言只到「这一面渲染出来了、控制台干净」这一层。**不钉具体像素、不钉具体 CSS 值**：
       spec 的呈现条目是意图级的，钉死了就把意图冻成偶然值。唯一一组贴着「值」的断言是
       窄档那两条响应式规则**有没有真的生效**，而且断的是计算样式与几何的**关系**
       （窄档下变了、宽档下没变），断的是「规则被删了/断了」而不是「padding 是 14px」。
     · 搜索是**覆盖层不是路由**：点 `.smb-searchbtn` 打开，再往它的输入框里打字取景。
     · 同一档里每个场景都重新导航一次（夹具从头加载），场景之间不带着上一步的状态。
     · 记进 metrics 但不判红的读数有两处，都是**别的票**的验收面，这里只留证据：
       正文里的公式元素数量、正文列的横向溢出量。
     · #90（课件页之外的三个面）把这三件事也纳进来守：主页第一屏那张卡**点得进去**（点到真
       课件页、落在那张卡说的那个节点上）；空目录 / 半份数据给的是「还没有」这句话，**不是**
       空白、也不是「读不到学习工作区」那张错误卡；搜索每条结果都标出科目与节点，且无断点的
       长 URL 折在自己那一格里（结果行与列表都不出横向滚动条）。窄档那三条「死声明」修好后，
       对账那一场把它们从「只记不判」升成断言。
     · #93（右栏题库的内部呈现）在每一档后面加了两场，用的是**另造的一份夹具**（三种题型各
       一组、题干与选项里各一段没有断点的长 token、题库带着一次落盘的作答）：
       `-quiz` 断言条目 17（题型徽标贴字、不是被弹性行拉长的竖条）、19（tab 选中态是右栏专用
       的下划线而不是左栏那套胶囊，且 tab 条在内容上方、与内容同宽）、21（上次作答的结果在
       右栏里，切 tab 与就地作答之后都还在）、22（只出纵向滚动条）与 18（点正文标记 → 那一组
       是「当前」，换到下一课不跟过去）；`-quiz-marked` 把镜头停在「点过标记之后」，三档各一张
       可判的截图。
       条目 22 有一处**假绿要记一笔**：`.smb-agroup` 自己带 `overflow: hidden`，题干被长 token
       顶宽时不是出横向滚动条、而是被裁掉——只看 `scrollWidth` 会把「字被裁」判成「没有横向
       滚动条」，所以这一条连着量「内容右边缘有没有越过裁切线」（metrics 里的 `overhang`）。

   浏览器二进制由 harness 探测；找不到时明确跳过（退出码 3），不是静默绿。
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readLibrary } from '../../../lib/library.ts';
import { extractCss } from '../fixtures/client-css.mjs';
import { openSession, finishSuite } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

let failures = 0;
function check(label, ok, detail = '') {
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}

/* ── 三档视口 ──────────────────────────────────────────────────────────────
   窄档取 800×900。它必须**真的**低于 900 那条断点，否则两条响应式规则还是跑不到；
   同时它刚好越过后台栏「装得下」的门槛（画布 − 两条窄轨 76 − 中栏保底 420 ≥ 右栏最小 280，
   即 ≥ 776px），于是课件页在窄档下仍是一个**完整的三栏面**。

   紧档取 700×900（#88）：它**低于**那个 776 的门槛，是「并排装不下」的那一档——
   课件的右栏在这一档不是并排的栏，而是盖在正文上的抽屉（必须有可见的解释与一条出路）。
   这一档专门取那个态：这不是截图上的细节，是「点题目有没有反应」这件事本身。 */
const VIEWPORTS = [
  { key: 'wide', width: 1440, height: 960 },
  { key: 'narrow', width: 800, height: 900 },
  { key: 'tight', width: 700, height: 900 },
];

/** 三档各自的课件页几何：右栏该是并排还是抽屉、中栏该保底多少。宽档/窄档并排，紧档只能抽屉。 */
const PANE_MODES = { wide: 'column', narrow: 'column', tight: 'drawer' };
/** 中栏保底（`lib/client.js` 的 MIN_CENTER，出处是 ADR-0011）。 */
const MIN_CENTER = 420;
/** 没拖动过时浏览器本地偏好里记着的栏宽（`PANE_LIMITS` 的两个 fallback）。 */
const STORED_PANES = '{"left":264,"right":372}';

/* ── 临时工作区：跑完即弃 ──────────────────────────────────────────────── */

const TEMPS = [];

/* 夹具配图：一张 480×200 的矢量图，内联成 data: URL。
   宽度 480 是**故意**比窄档下的正文列还宽的（800 的画布下中栏只剩保底 420，减左右内边距
   约 372）：配图受不受列宽约束是另一张票的验收面，这里把它照实渲染出来，并把正文列有没有
   横向溢出记进 metrics，不据此判红。 */
const FIGURE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200" viewBox="0 0 480 200">',
  '<rect width="480" height="200" rx="12" fill="#eef2ff"/>',
  '<rect x="36" y="70" width="150" height="60" rx="10" fill="#4c6ef5"/>',
  '<text x="111" y="106" font-family="sans-serif" font-size="18" fill="#ffffff" text-anchor="middle">名字</text>',
  '<line x1="200" y1="100" x2="276" y2="100" stroke="#4c6ef5" stroke-width="4"/>',
  '<polygon points="276,92 294,100 276,108" fill="#4c6ef5"/>',
  '<rect x="300" y="70" width="144" height="60" rx="10" fill="#12b886"/>',
  '<text x="372" y="106" font-family="sans-serif" font-size="18" fill="#ffffff" text-anchor="middle">值</text>',
  '</svg>',
].join('');
const FIGURE_SRC = 'data:image/svg+xml;base64,' + Buffer.from(FIGURE_SVG, 'utf8').toString('base64');

/* 一条**没有断点**的长 URL：斜杠之后全是连续字符，浏览器在哪儿都折不了行。
   搜索面板要能把它折在自己那一格里（`overflow-wrap: anywhere`），而不是把结果行顶出
   横向滚动条——`.smb-palette__list` 的 `overflow-y: auto` 会把横向也算成 auto（#90）。
   放 40 个字符一段重复三遍：短了不触发溢出，这条断言就白写了。 */
const LONG_URL = 'https://example.com/docs/reference/'
  + 'pathSegmentWithoutAnyBreakPointInside'.repeat(3);

/* 右栏题库那两条验收（#93 条目 17 / 22）要用的「刚好越界」的料：一段**没有断点**的长标识符
   放进题干，一段放进选项。它们是「把右栏顶出横向滚动条」的那一类内容——右栏最窄时只有 280px
   （PANE_LIMITS.right.min），这一段在**任何一档**下都比它宽，所以「撑不撑破」在宽窄两档都验得到。 */
const STEM_TOKEN = 'studymate_right_pane_overflow_token_' + 'x'.repeat(40);
const OPTION_TOKEN = 'https://example.com/quiz/option/without/any/break/point/' + 'y'.repeat(40);

/** 一份能读出「两层依赖 + 有课件」的最小科目树。demo 那一门的第一课是四个面的取景主角。 */
function subjectFiles(dirName, { slug, name, touched }) {
  return {
    [`.learning/subjects/${dirName}/subject.yaml`]: [
      `slug: ${slug}`, `name: ${name}`, 'goal: 在真浏览器里把阅读端四个面各走一遍', 'status: 学习中',
      'created_at: "2026-01-02T03:04:05+08:00"', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/curriculum.yaml`]: [
      'nodes:',
      '  - id: 变量', '    title: 变量', '    kind: 概念', '    objective: 说清变量是什么',
      '    status: 已学完',
      '  - id: 函数', '    title: 函数', '    kind: 概念', '    objective: 说清函数是什么',
      '    prerequisites: [变量]', '    status: 学习中',
      '  - id: 闭包', '    title: 闭包', '    kind: 概念', '    objective: 说清闭包是什么',
      '    prerequisites: [函数]', '    status: 未开始',
      'edges:',
      '  - from: 变量', '    to: 函数', '    reason: 先有绑定再谈调用',
      '  - from: 函数', '    to: 闭包', '    reason: 先会调用再谈捕获', '',
    ].join('\n'),
    // 「接着上次」只认最后一次改过的那一门，所以两门的 updated_at 必须分开写
    [`.learning/subjects/${dirName}/progress.yaml`]: [
      `updated_at: "${touched}"`,
      'nodes:', '  变量:', '    status: 已学完', '  函数:', '    status: 学习中', '',
    ].join('\n'),
    // 取景主角：行内公式 + 块级公式 + 代码块 + 位图配图 + 一条题目锚点，一次把四样都渲染出来
    [`.learning/subjects/${dirName}/lessons/1-变量.md`]: [
      '# 变量', '',
      '变量是名字指向值，别名见 [绑定](./glossary.md)；行内公式 $x = 3$ 也是这个意思。', '',
      '```js', 'const a = 1;', 'let b = a + 1;', '```', '',
      `::: figure ${FIGURE_SRC}`,
      'alt: 名字与值的对应示意',
      'caption: 图 1 · 绑定示意',
      ':::', '',
      '块级公式独立成行：', '',
      '$$', '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}', '$$', '',
      '## 小结', '',
      '别名见 [绑定](./glossary.md)；长标识符也放一个：`studymate_pane_widths_v1_override`。', '',
      '::: quiz 理解 锚点：变量的比喻', ':::', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/lessons/1-变量.quiz.json`]: JSON.stringify({
      变量的比喻: [{
        q: '变量最接近下面哪个说法？',
        opts: ['名字指向值', '容器装着值', '一段可复用的调用'],
        ans: 0,
        why: '绑定是名字与值的对应，不是把值装进盒子里。',
      }],
    }),
    [`.learning/subjects/${dirName}/lessons/2-函数.md`]: [
      '# 函数', '', '函数是一段可复用的调用，它把一组输入映到输出。', '',
      '## 小结', '', '函数的名字也是绑定。', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/lessons/3-闭包.md`]: '# 闭包\n\n闭包是函数记住了它的作用域。\n',
    [`.learning/subjects/${dirName}/MISSION.md`]: '# 使命\n\n## Why\n\n因为要在浏览器里验。\n',
    [`.learning/subjects/${dirName}/GLOSSARY.md`]: '## 基础\n\n**绑定**: 名字指向值\n_Avoid_: 赋值\n',
    [`.learning/subjects/${dirName}/RESOURCES.md`]: '# 资源\n\n- 《入门》\n',
    [`.learning/subjects/${dirName}/misconceptions.yaml`]: '[]\n',
    // 参考资料：科目主页那一块要有 entry 才有东西可量
    [`.learning/subjects/${dirName}/reference/入门.md`]: '# 入门\n\n先会绑定再谈调用。\n',
  };
}

/** 第二门课：内容与 demo **刻意不一样**。
    两门用同一份内容时，跨科目搜索的截图里会出现成对的重复条目（去重键带科目，那确实是两条
    命中），可看截图的人会以为搜索坏了——那不是本套件要证的东西。 */
function plainSubjectFiles(dirName, { slug, name, touched }) {
  return {
    [`.learning/subjects/${dirName}/subject.yaml`]: [
      `slug: ${slug}`, `name: ${name}`, 'goal: 给跨科目搜索与科目列表凑第二门', 'status: 学习中',
      'created_at: "2026-02-03T04:05:06+08:00"', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/curriculum.yaml`]: [
      'nodes:',
      '  - id: 列表', '    title: 列表', '    kind: 概念', '    objective: 说清列表是什么',
      '    status: 已学完',
      '  - id: 映射', '    title: 映射', '    kind: 概念', '    objective: 说清映射是什么',
      '    prerequisites: [列表]', '    status: 学习中',
      '  - id: 过滤', '    title: 过滤', '    kind: 概念', '    objective: 说清过滤是什么',
      '    prerequisites: [映射]', '    status: 未开始',
      'edges:',
      '  - from: 列表', '    to: 映射', '    reason: 先有序列再谈逐项变换', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/progress.yaml`]: [
      `updated_at: "${touched}"`, 'nodes:', '  列表:', '    status: 已学完', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/lessons/1-列表.md`]: [
      '# 列表', '', '列表是一串有序的值。', '',
      '## 参考', '',
      // 搜索用的那条无断点长 URL：它得属于**另一门**科目，那条命中的出处才有东西可断
      LONG_URL + ' 这一段没有断点，看它撑不撑破结果行。', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/lessons/2-映射.md`]: '# 映射\n\n映射把每一项换成另一项。\n',
    [`.learning/subjects/${dirName}/lessons/3-过滤.md`]: '# 过滤\n\n过滤把不合条件的项去掉。\n',
    [`.learning/subjects/${dirName}/MISSION.md`]: '# 使命\n\n## Why\n\n给跨科目搜索凑一门。\n',
    [`.learning/subjects/${dirName}/GLOSSARY.md`]: '## 基础\n\n**序列**: 有先后的一串值\n',
    [`.learning/subjects/${dirName}/RESOURCES.md`]: '# 资源\n\n- 《进阶》\n',
    [`.learning/subjects/${dirName}/misconceptions.yaml`]: '[]\n',
  };
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-routes-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(path.join(workspace, '.learning'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.learning', 'MEMORY.md'), '# 共享记忆\n');
  const files = Object.assign(
    subjectFiles('demo', { slug: 'demo', name: '演示科目', touched: '2026-05-06T07:08:09+08:00' }),
    plainSubjectFiles('second', { slug: 'second', name: '第二科目', touched: '2026-04-01T00:00:00+08:00' }),
  );
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { root, workspace };
}

/* ── 两份额外的数据：空目录 / 半份数据（#90 的空态验收面） ───────────────────
   它们不是「四个面」的取景，而是同一批面的**退化输入**：一份是工作区里只有建课建到
   一半的空科目目录（一个可用科目都没有），一份是大纲有了、课件与附件都没有的半份科目。
   两份都要求页面说得出「还没有」，而不是空白或「读不到学习工作区」那张错误卡。 */

/** 空目录：`subjects/` 在，里面只有一个空科目目录（一个文件都没有）。 */
function makeEmptyWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-routes-blank-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(path.join(workspace, '.learning', 'subjects', '半成品'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.learning', 'MEMORY.md'), '# 共享记忆\n');
  return { root, workspace, payload: readLibrary({ workspace }) };
}

/** 半份数据：有 subject.yaml 与大纲（两个节点、一条前置边），别的都没有；
    旁边那个空目录用来证明「跳过一个科目」不是「读不出来」。 */
function makeHalfWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-routes-half-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  const files = {
    '.learning/MEMORY.md': '# 共享记忆\n',
    '.learning/subjects/half/subject.yaml': [
      'slug: half', 'name: 半份科目', 'goal: 只有大纲，课件与附件还没写', 'status: 学习中', '',
    ].join('\n'),
    '.learning/subjects/half/curriculum.yaml': [
      'nodes:',
      '  - id: 一', '    title: 一号', '    kind: 概念', '    objective: 说清一号是什么',
      '  - id: 二', '    title: 二号', '    kind: 概念', '    objective: 说清二号是什么',
      '    prerequisites: [一]',
      'edges:',
      '  - from: 一', '    to: 二', '    reason: 先一号后二号', '',
    ].join('\n'),
  };
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.mkdirSync(path.join(workspace, '.learning', 'subjects', '半成品'), { recursive: true });
  return { root, workspace, payload: readLibrary({ workspace }) };
}

/* ── 右栏题库那一面的夹具（#93） ────────────────────────────────────────────
   四个面那一份夹具是为「取景」造的：三条锚点、三种题型都没有，题干与选项里也没有长 token，
   题库里更没有一次已作答。这一份专为右栏造，三样都摆齐：

     · **三种题型各一组**（客观题 / 开放题 / 交付物）——题型徽标这个词表要挨个渲染一次，
       截图才看得出「贴字」是不是对每一种都成立；
     · **题干与选项里各一段没有断点的长 token**——「右栏只出纵向滚动条」这件事要有东西顶它；
     · **题库带着一次落盘的作答**（`attempts/<NNNN>-<节点>.json`）——「上次作答看得见」这条
       能力是从盘上读上来的，不是当场点出来的；所以按 `lib/attempts.ts` 的文件名规矩
       （`<NNNN>` 取课件文件名那四位）现写一份，让它真的走进 payload。

   课件文件名必须是 `0001-<节点id>.md`（四位数字前缀）：作答数据与课件同名不同后缀，
   `attempts.ts` 的 `lessonNumberOf` 就是按这四位找的——写成 `1-绑定.md` 那份种子会被静默忽略。
   节点 id 还必须是 **ASCII** 的（`attempts.ts` 的 `NODE_ID_RE`：`^[a-z0-9]+([.-][a-z0-9]+)*$`）——
   中文 id 的节点读得到课件、却读不到作答数据（`readAttempts` 直接返回 null），
   种子文件就白写了。所以这里 id 用 `binding.scope`，标题与锚点照样是中文。 */
const QUIZ_NODE = 'binding.scope';
const QUIZ_TITLE = '绑定';
const QUIZ_ANCHORS = ['变量的比喻', '作用域的嵌套', '造一个绑定的小例子'];
/** 第二课（两处用它）：① 「当前」标记不许跟着换课跑过去；② 课件页底部那条「下一课」点得到。 */
const NEXT_NODE = 'scope.order';
const NEXT_ANCHORS = ['先声明后使用', '顺序与提升'];

function quizSubjectFiles(dirName, { slug, name, touched }) {
  const lesson = [
    `# ${QUIZ_TITLE}`, '',
    '绑定是名字指向值；这一课的题都在右栏。', '',
    ...QUIZ_ANCHORS.map((anchor, i) => `::: quiz ${['理解', '应用', '交付'][i]} 锚点：${anchor}\n:::\n`),
    '## 小结', '',
    '小结里也放一个长标识符：' + STEM_TOKEN + '。', '',
  ].join('\n');
  const nextLesson = [
    '# 顺序', '',
    '顺序说的是绑定在什么时候生效。', '',
    ...NEXT_ANCHORS.map((anchor) => `::: quiz 理解 锚点：${anchor}\n:::\n`),
    '',
  ].join('\n');

  return {
    [`.learning/subjects/${dirName}/subject.yaml`]: [
      `slug: ${slug}`, `name: ${name}`, 'goal: 把右栏题库的内部呈现挨个看一遍', 'status: 学习中',
      'created_at: "2026-01-02T03:04:05+08:00"', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/curriculum.yaml`]: [
      'nodes:',
      `  - id: ${QUIZ_NODE}`, `    title: ${QUIZ_TITLE}`, '    kind: 概念',
      '    objective: 说清绑定发生在作用域里而不是值里', '    status: 学习中',
      `  - id: ${NEXT_NODE}`, '    title: 顺序', '    kind: 概念',
      '    objective: 说清绑定在什么时候生效', `    prerequisites: [${QUIZ_NODE}]`, '    status: 未开始', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/progress.yaml`]: [
      `updated_at: "${touched}"`, 'nodes:', `  ${QUIZ_NODE}:`, '    status: 学习中', '',
    ].join('\n'),
    [`.learning/subjects/${dirName}/lessons/0001-${QUIZ_NODE}.md`]: lesson,
    [`.learning/subjects/${dirName}/lessons/0001-${QUIZ_NODE}.quiz.json`]: JSON.stringify({
      [QUIZ_ANCHORS[0]]: [{
        kind: '客观题',
        q: '变量最接近下面哪个说法？题干里也有一段长标识符：' + STEM_TOKEN,
        opts: ['名字指向值', '容器装着值（' + OPTION_TOKEN + '）', '一段可复用的调用'],
        ans: 0,
        why: '绑定是名字与值的对应，不是把值装进盒子里。',
      }],
      [QUIZ_ANCHORS[1]]: [{
        kind: '开放题',
        q: '内层作用域看得到外层的绑定吗？',
        answer: '看得到，作用域链向上查。',
        criteria: '提到作用域链与「向上」就够了。',
      }],
      [QUIZ_ANCHORS[2]]: [{
        kind: '交付物',
        q: '写一个会捕获外层绑定的函数。',
        交付物: '一个能跑的 .mjs 文件',
        证据: 'node --test 的输出',
      }],
    }),
    // 第二课：两处用它——「当前」标记不许跟着换课跑过去，以及课件页底部那条「下一课」点得到
    [`.learning/subjects/${dirName}/lessons/0002-${NEXT_NODE}.md`]: nextLesson,
    [`.learning/subjects/${dirName}/lessons/0002-${NEXT_NODE}.quiz.json`]: JSON.stringify({
      [NEXT_ANCHORS[0]]: [{ kind: '客观题', q: '先声明后使用是什么意思？', opts: ['读之前先绑好', '随便写'], ans: 0, why: '顺序决定读到什么。' }],
      [NEXT_ANCHORS[1]]: [{ kind: '开放题', q: '提升是怎么回事？', answer: '声明被提到作用域顶部。', criteria: '提到声明与初始化的分别。' }],
    }),
    // 一次落盘的作答：读进 payload 之后，右栏那一题上就该有「上次选了 A，对了」
    [`.learning/subjects/${dirName}/attempts/0001-${QUIZ_NODE}.json`]: JSON.stringify({
      节点: QUIZ_NODE,
      课件: `0001-${QUIZ_NODE}.md`,
      最后写入: touched,
      题: {
        [`${QUIZ_ANCHORS[0]}#0`]: {
          id: `${QUIZ_ANCHORS[0]}#0`,
          作答历史: [{ 时: touched, 选: 0, 对: true }],
          上次结果: { 时: touched, 选: 0, 对: true },
        },
      },
    }, null, 2),
    [`.learning/subjects/${dirName}/MISSION.md`]: '# 使命\n\n## Why\n\n因为要看右栏。\n',
    [`.learning/subjects/${dirName}/GLOSSARY.md`]: '## 基础\n\n**绑定**: 名字指向值\n',
    [`.learning/subjects/${dirName}/RESOURCES.md`]: '# 资源\n\n- 《入门》\n',
    [`.learning/subjects/${dirName}/misconceptions.yaml`]: '[]\n',
  };
}

/** 右栏那一面自己的临时工作区（跑完即弃，与四个面那份互不干扰）。 */
function makeQuizWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-quiz-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(path.join(workspace, '.learning'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.learning', 'MEMORY.md'), '# 共享记忆\n');
  const files = quizSubjectFiles('demo', { slug: 'demo', name: '演示科目', touched: '2026-05-06T07:08:09+08:00' });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { root, workspace, payload: readLibrary({ workspace }) };
}

/* ── 夹具页 ────────────────────────────────────────────────────────────── */

/** 宿主 token 的两块（亮/暗）原样铺开，让 --dsw-alias-* 在夹具里和真宿主一样能解。 */
function hostTokenCss() {
  const snapshot = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'host-theme-tokens.json'), 'utf8'));
  const block = (table) => Object.entries(table).map(([name, value]) => `${name}:${value}`).join(';');
  return [
    `body{${block(snapshot.light)}}`,
    `body[data-ds-dark-theme]{${block(snapshot.dark)}}`,
    'body{background-color:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
  ].join('\n');
}

function buildFixture(dir, payload, name = 'reading-routes-fixture.html') {
  const css = extractCss(fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8'));
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>StudyMate 阅读端四路由 QA 夹具</title>
<style>
  html, body { margin: 0; height: 100%; }
  #root { height: 100%; }
  ${hostTokenCss()}
</style>
<style id="plugin-css">${css}</style>
<script>
  // 阅读端的宿主契约：window.__ModuleLoader__.load({id, factory})，factory 只 require('react')
  window.__StudymateSpec = null;
  window.__ModuleLoader__ = { load: function (spec) { window.__StudymateSpec = spec; } };
  window.__Payload = ${json};
  window.fetch = function (url) {
    if (String(url).indexOf('/api/studymate/library') === 0) {
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve(window.__Payload); },
      });
    }
    return Promise.resolve({
      ok: false, status: 404,
      json: function () { return Promise.resolve({ error: '夹具没有这条接口：' + url }); },
    });
  };
  // 变更推送（#74）：阅读端挂载即订阅 /api/studymate/events。夹具页走 file://，那条请求只会
  // 被拦掉、变成一条「失败请求」——而推送不在这一面的验收面上。lib/client.js 认这个早退
  // （typeof EventSource !== 'function' 就不订阅），所以收掉它，别让注定失败的请求污染判据。
  // 这条通道本身由 browser/watch_push_test.mjs 与真 DSH 探针覆盖。
  window.EventSource = undefined;
  /* mini-react 每次重渲染都**整树重建 DOM**（不 diff），所以「把节点闭进 effect 里、之后还去量它」
     的代码在夹具里量到的是已经被换掉的旧节点：LessonPage 的 ResizeObserver 量画布宽
     （lib/client.js 的 measure），旧节点一脱离文档就报 0，画布宽被写成 0，两条栏于是永远打不开。
     真 React 里节点不换，那段代码本身是对的（同一条夹具边界 reading_test.mjs 在路线图连线上
     也记过一次）。这里把 ResizeObserver 换成「observe 时同步报一次真实尺寸、之后不再报」：
     一次场景里窗口尺寸不会变，这与真 React 下「只有真的变了才回调」等价，
     而不会把夹具的重建当成一次缩放。 */
  window.ResizeObserver = function (callback) {
    this.observe = function (target) {
      callback([{ target: target, contentRect: target.getBoundingClientRect() }], this);
    };
    this.unobserve = function () {};
    this.disconnect = function () {};
  };
</script>
</head>
<body>
<div id="root"></div>
<script src="${pathToFileURL(path.join(HERE, '..', 'fixtures', 'mini-react.js')).href}"></script>
<script src="${pathToFileURL(path.join(ROOT, 'lib', 'client.js')).href}"></script>
<script>
  (function () {
    var spec = window.__StudymateSpec;
    if (!spec) throw new Error('lib/client.js 没有向 window.__ModuleLoader__ 登记');
    var mod = spec.factory(function (name) { return name === 'react' ? window.MiniReact : undefined; });
    var Main = null;
    mod.apply({
      slots: {
        inject: function (seat, callback) { callback(); },
        register: function (options, component) {
          if (options && options.name === 'main') Main = component;
        },
      },
    });
    if (!Main) throw new Error('没有从 main 座位拿到组件');
    window.MiniReact.mount(window.MiniReact.createElement(Main, null), document.getElementById('root'));
  }());
</script>
</body>
</html>
`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, html);
  return pathToFileURL(file).href;
}

/* ── 页面里的探针 ──────────────────────────────────────────────────────── */

/** 探针共用的一小段（整段塞进页面求值，所以写成字符串）。 */
const HELPERS = `
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const style = (sel, prop) => { const el = q(sel); return el ? getComputedStyle(el)[prop] : null; };
  const box = (sel) => { const el = q(sel); if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const text = (sel) => { const el = q(sel); return el ? el.textContent.trim() : null; };
`;

const HOME_PROBE = `(() => {
  ${HELPERS}
  const pbar = q('.smb-continue [role="progressbar"]');
  return {
    width: window.innerWidth,
    breakpoint900: window.matchMedia('(max-width: 900px)').matches,
    hero: text('.smb-hero__title'),
    courses: qa('.smb-course').length,
    courseNames: qa('.smb-course__name').map((el) => el.textContent.trim()),
    continueBlockTitle: text('.smb-block__title'),
    continueSubject: text('.smb-continue__subject'),
    continueTitle: text('.smb-continue__title'),
    continueGo: text('.smb-continue__go'),
    continueEmpty: text('.smb-block .smb-empty'),
    progress: pbar ? { now: pbar.getAttribute('aria-valuenow'), max: pbar.getAttribute('aria-valuemax') } : null,
    motionOptions: qa('.smb-select option').map((el) => el.value),
    layout: {
      wrapPaddingLeft: style('.smb-wrap', 'paddingLeft'),
      crumbMaxWidth: style('.smb-crumb', 'maxWidth'),
      topbarWrap: style('.smb-topbar', 'flexWrap'),
      continueBarWrap: style('.smb-continue__bar', 'flexWrap'),
      continueProgressWidth: style('.smb-continue__bar .smb-progressbar', 'width'),
      continueProgressBox: box('.smb-continue__bar .smb-progressbar'),
      continueBarBox: box('.smb-continue__bar'),
      courseWrap: style('.smb-course', 'flexWrap'),
      courseBox: box('.smb-course'),
      courseMain: box('.smb-course__main'),
      courseSide: box('.smb-course__side'),
    },
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    bodyText: document.body.innerText.slice(0, 300),
  };
})()`;

const SUBJECT_PROBE = `(() => {
  ${HELPERS}
  const map = q('.smb-map');
  const pbar = q('.smb-subhead [role="progressbar"]');
  return {
    width: window.innerWidth,
    breakpoint900: window.matchMedia('(max-width: 900px)').matches,
    title: text('.smb-subhead__title'),
    goal: text('.smb-subhead__goal'),
    counts: qa('.smb-subhead__counts .smb-chip').map((el) => el.textContent.trim()),
    progressLabel: pbar ? pbar.getAttribute('aria-label') : null,
    mapLabel: map ? map.getAttribute('aria-label') : null,
    mapRole: map ? map.getAttribute('role') : null,
    mapLevels: qa('.smb-map__level').length,
    nodeCards: qa('[data-proto="open-node"]').length,
    nodeNames: qa('[data-proto="open-node"]').map((el) => el.textContent.trim().slice(0, 12)),
    blocks: qa('.smb-block__title').map((el) => el.textContent.trim()),
    refItems: qa('.smb-refitem').length,
    refFirst: text('.smb-refitem__open'),
    wrapPaddingLeft: style('.smb-wrap', 'paddingLeft'),
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    bodyText: document.body.innerText.slice(0, 400),
  };
})()`;

const LESSON_PROBE = `(() => {
  ${HELPERS}
  const lesson = q('.smb-lesson');
  const art = q('article.smb-doc');
  const img = q('.smb-figure img');
  const centerBody = q('.smb-center__body');
  const opts = qa('.smb-opt');
  const drawer = q('.smb-drawer');
  const bar = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), w: Math.round(r.width) }; };
  // 三栏壳自己的宽（不是视口宽）：三条栏加起来、中栏保底这些账都记在它身上
  const frame = lesson ? Math.round(lesson.getBoundingClientRect().width) : 0;
  const railBars = qa('.smb-railbar').reduce((n, el) => n + el.getBoundingClientRect().width, 0);
  const railToken = getComputedStyle(q('.smb-root')).getPropertyValue('--smb-rail').trim();
  // 右手把的落点：贴在这一栏的内侧边缘上（窄轨 + 这一栏的宽），量出来对账
  const handle = q('.smb-panehandle[data-side="right"]');
  const pane = q('.smb-right') || drawer;
  return {
    width: window.innerWidth,
    breakpoint900: window.matchMedia('(max-width: 900px)').matches,
    crumb: text('.smb-crumb--current'),
    lessonName: text('.smb-center__name'),
    articleHeading: text('.smb-doc h1'),
    articleChars: art ? art.innerText.length : 0,
    sections: qa('.smb-sec-block').length,
    secs: qa('.smb-sec').map((el) => el.textContent.trim()),
    quizMarkers: qa('[data-proto="quiz-marker"]').length,
    quizMarkerText: text('[data-proto="quiz-marker"]'),
    codeLangs: qa('.smb-code__bar b').map((el) => el.textContent.trim()),
    mathInline: qa('.smb-math').length,
    mathBlock: qa('.smb-math-block').length,
    figure: img ? { scheme: String(img.getAttribute('src')).split(':')[0], loaded: !!(img.complete && img.naturalWidth > 0), natural: img.naturalWidth } : null,
    figcaption: text('.smb-figure figcaption'),
    panes: lesson ? { left: lesson.getAttribute('data-left'), right: lesson.getAttribute('data-right') } : null,
    modes: lesson ? { left: lesson.getAttribute('data-left-mode'), right: lesson.getAttribute('data-right-mode') } : null,
    rails: qa('.smb-rail').length,
    railBars: Math.round(railBars),
    railToken,
    frame,
    centerBox: box('.smb-center'),
    leftBox: box('.smb-left'),
    rightBox: box('.smb-right'),
    docBox: box('article.smb-doc'),
    nodeCards: qa('.smb-node').length,
    handle: handle ? { dx: Math.round(handle.getBoundingClientRect().left + handle.getBoundingClientRect().width / 2 - (lesson ? lesson.getBoundingClientRect().left : 0)), pane: pane ? Math.round(pane.getBoundingClientRect().width) : 0 } : null,
    drawer: drawer ? {
      side: drawer.getAttribute('data-side'), box: bar(drawer),
      note: text('.smb-drawer__note'), close: !!q('[data-proto="pane-drawer-close"]'),
    } : null,
    questions: qa('.smb-q').length,
    questionText: text('.smb-q__text'),
    optionTags: opts.map((el) => el.tagName + (el.disabled ? ':disabled' : '')),
    optionTexts: opts.map((el) => el.textContent.trim().slice(0, 20)),
    answered: text('.smb-center__head .smb-meta'),
    centerOverflowX: centerBody ? centerBody.scrollWidth - centerBody.clientWidth : null,
    bodyText: document.body.innerText.slice(0, 400),
  };
})()`;

/**
 * 右栏题库那一面的读数（#93 条目 17 / 18 / 19 / 21 / 22）。全部量**真渲染出来的元素**：
 *
 *   · 题型徽标取 `.smb-q__ask` 里那颗 chip——**不预设类名**（类名是实现，贴不贴字是行为）；
 *   · 「当前组」取 `aria-current`，同时量它的边与编号圈（光有属性、看不见不算「明显的标记」）；
 *   · 上次作答取 `.smb-review`，并量它**在不在右栏里**（在正文里出现不算数）；
 *   · 滚动条取滚动容器的 `scrollWidth/clientWidth` 与计算出来的 `overflow-x`；
 *   · 品牌色不写死：现造一个只设 `color` 的元素让浏览器把 `--smb-brand` 解出来，
 *     之后只比「相等 / 不相等」，不钉任何具体色值。
 */
const QUIZ_PROBE = `(() => {
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const px = (value) => Math.round(parseFloat(value) * 100) / 100;
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };

  const probe = document.createElement('span');
  probe.style.color = 'var(--smb-brand)';
  (q('.smb-root') || document.body).appendChild(probe);
  const brand = getComputedStyle(probe).color;
  probe.remove();

  const paneBody = q('.smb-right__body');
  const lesson = q('.smb-lesson');
  const overflowOf = (el) => (el ? el.scrollWidth - el.clientWidth : null);

  const tabs = qa('.smb-right__tabs button').map((el) => {
    const s = cs(el);
    return {
      text: el.textContent.trim(), classes: el.className, selected: el.getAttribute('aria-selected') === 'true',
      backgroundColor: s.backgroundColor, color: s.color,
      borderBottomWidth: px(s.borderBottomWidth), borderBottomColor: s.borderBottomColor,
      borderTopWidth: px(s.borderTopWidth), borderRadius: px(s.borderTopLeftRadius),
      fontWeight: s.fontWeight, box: box(el),
    };
  });

  const cards = qa('.smb-q').map((el) => {
    const ask = el.querySelector('.smb-q__ask');
    const badge = ask ? ask.querySelector('.smb-chip') : null;
    const stem = el.querySelector('.smb-q__text');
    const lines = Array.from(el.querySelectorAll('.smb-q__text p'));
    const optionTexts = Array.from(el.querySelectorAll('.smb-opt > span:last-child'));
    const opts = Array.from(el.querySelectorAll('.smb-opt'));
    /* 「折没折」的判据落在**右边缘**上，不是只看 scrollWidth：组卡片（.smb-agroup）自己带
       overflow: hidden，题干被顶宽时它不是出横向滚动条而是**被裁掉**——只看滚动条读数，
       会把「文字被裁」误判成「没有横向滚动条」。#93 条目 22 问的是学生看不看得见那段字，
       所以这里量的是「内容右边缘有没有越过裁切线」。 */
    const group = el.closest('.smb-agroup');
    const clipEdge = group ? group.getBoundingClientRect().right - 1 : null;
    const texts = [stem].concat(lines, optionTexts).filter(Boolean);
    return {
      badge: badge ? {
        text: badge.textContent.trim(), box: box(badge),
        fontSize: px(cs(badge).fontSize), whiteSpace: cs(badge).whiteSpace,
      } : null,
      ask: box(ask), stem: box(stem), clipEdge: clipEdge === null ? null : Math.round(clipEdge),
      overhang: clipEdge === null ? null
        : Math.round(texts.reduce((worst, one) => Math.max(worst, one.getBoundingClientRect().right - clipEdge), -Infinity)),
      stemOverflowX: overflowOf(stem),
      stemLinesOverflowX: lines.map(overflowOf),
      optionOverflowX: opts.map(overflowOf),
      review: Array.from(el.querySelectorAll('.smb-review')).map((one) => one.textContent.trim()),
    };
  });

  const groups = qa('.smb-agroup').map((el) => {
    const s = cs(el);
    const circle = el.querySelector('.smb-agroup__no');
    return {
      no: circle ? circle.textContent.trim() : null,
      title: el.querySelector('.smb-agroup__text') ? el.querySelector('.smb-agroup__text').textContent.trim() : null,
      current: el.getAttribute('aria-current'),
      box: box(el), borderTopColor: s.borderTopColor,
      circleBackground: circle ? cs(circle).backgroundColor : null,
      circleBorderColor: circle ? cs(circle).borderTopColor : null,
    };
  });

  return {
    width: window.innerWidth,
    mode: lesson ? lesson.getAttribute('data-right-mode') : null,
    open: lesson ? lesson.getAttribute('data-right') : null,
    brand, tabs, cards, groups,
    // 题型徽标的参照物：正文里的「练习」徽标是同一个画法，但它在一条 align-items:center 的行里，
    // 高度就是「贴字」的天然高度——拿它当尺子，就不用钉任何像素值
    markerBadge: box(q('.smb-qmark__badge')),
    markers: qa('[data-proto="quiz-marker"]').map((el) => ({
      group: el.getAttribute('data-group'), no: el.querySelector('.smb-qmark__no').textContent.trim(),
      text: el.querySelector('.smb-qmark__text').textContent.trim(),
    })),
    review: qa('.smb-review').map((el) => ({ text: el.textContent.trim(), inPane: !!(paneBody && paneBody.contains(el)) })),
    pane: paneBody ? {
      box: box(paneBody), tabsBox: box(q('.smb-right__tabs')),
      clientWidth: px(paneBody.clientWidth), scrollWidth: px(paneBody.scrollWidth),
      clientHeight: px(paneBody.clientHeight), scrollHeight: px(paneBody.scrollHeight),
      overflowX: cs(paneBody).overflowX, overflowY: cs(paneBody).overflowY,
      innerOverflowX: overflowOf(paneBody),
    } : null,
    pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
    bodyText: document.body.innerText.slice(0, 240),
  };
})()`;

/** 点正文里第 n 条题目标记（0 起）：右栏那一组该出现「当前」标记。 */
function clickMarker(index) {
  return `(() => {
    const marks = document.querySelectorAll('[data-proto="quiz-marker"]');
    if (!marks[${index}]) throw new Error('正文里没有第 ${index + 1} 条题目标记');
    marks[${index}].click();
    return marks[${index}].getAttribute('data-group');
  })()`;
}

/** 点右栏第 n 个 tab（0 起）：选中态该换人，面板内容跟着换。 */
function clickTab(index) {
  return `(() => {
    const tabs = document.querySelectorAll('.smb-right__tabs button');
    if (!tabs[${index}]) throw new Error('右栏没有第 ${index + 1} 个 tab');
    tabs[${index}].click();
    return tabs[${index}].textContent.trim();
  })()`;
}

const SEARCH_PROBE = `(() => {
  ${HELPERS}
  const palette = q('.smb-palette');
  const input = q('.smb-palette__input input');
  const hits = qa('.smb-hit');
  const boxEl = q('.smb-palette__box');
  return {
    width: window.innerWidth,
    breakpoint900: window.matchMedia('(max-width: 900px)').matches,
    open: !!palette,
    inputValue: input ? input.value : null,
    placeholder: input ? input.getAttribute('placeholder') : null,
    focused: input ? document.activeElement === input : false,
    meta: text('.smb-palette__list .smb-meta'),
    empty: text('.smb-palette .smb-empty'),
    hits: hits.length,
    kinds: hits.map((el) => el.querySelector('.smb-hit__kind').textContent.trim()),
    texts: hits.map((el) => el.querySelector('.smb-hit__text').textContent.trim().slice(0, 24)).slice(0, 6),
    where: hits.map((el) => { const w = el.querySelector('.smb-hit__where'); return w ? w.textContent.trim() : null; }),
    // 结果行与列表各有横向溢出多少：长 URL 撑破版面时这两个数会大于 0（#90）
    hitOverflowX: hits.map((el) => el.scrollWidth - el.clientWidth),
    listOverflowX: (() => { const list = q('.smb-palette__list'); return list ? list.scrollWidth - list.clientWidth : null; })(),
    boxRect: boxEl ? { w: Math.round(boxEl.getBoundingClientRect().width), left: Math.round(boxEl.getBoundingClientRect().left) } : null,
    bodyText: document.body.innerText.slice(0, 300),
  };
})()`;

/**
 * 真浏览器里的对比度：拿元素**实际用上的**前景色，再沿 DOM 往上把背景合成出来。
 * 与 reading_test.mjs 里那条同源（同一套合成算法）：套件之间不互相 import，
 * 所以这里留一份自己的——两处量的是同一件事，改一处要想着另一处。
 */
const CONTRAST_PROBE = `(function (targets) {
  const channels = (text) => {
    const raw = String(text);
    const nums = (raw.match(/-?[\\d.]+(?:e-?\\d+)?/g) || []).map(Number);
    if (nums.length < 3) return null;
    const scale = /^color\\(/i.test(raw.trim()) ? 255 : 1;
    return { r: nums[0] * scale, g: nums[1] * scale, b: nums[2] * scale, a: nums.length > 3 ? nums[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = (c) => {
    const ch = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  };
  const ratio = (a, b) => {
    const la = lum(a); const lb = lum(b);
    const hi = Math.max(la, lb); const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  };
  const solid = (el) => {
    const stack = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = channels(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) stack.push(bg);
      node = node.parentElement;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  };
  const out = [];
  for (const [sel, name] of targets) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ name, missing: true }); continue; }
    const fg = channels(getComputedStyle(el).color);
    if (!fg) { out.push({ name, missing: true, color: getComputedStyle(el).color }); continue; }
    const bg = solid(el);
    out.push({
      name, color: getComputedStyle(el).color,
      bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
      ratio: Math.round(ratio(over(fg, bg), bg) * 100) / 100,
    });
  }
  return out;
})`;

/** 四个面各取几个真会出现的取样点（一面里只有其中一些在）。 */
const CONTRAST_TARGETS = {
  home: [
    ['.smb-hero__sub', '主页·说明文字'],
    ['.smb-continue__goal', '主页·接着上次的目标'],
    ['.smb-course__goal', '主页·科目目标（四级文字）'],
    ['.smb-course__stats span', '主页·三档计数'],
    ['.smb-chip', '主页·状态 chip'],
    ['.smb-crumb', '主页·面包屑'],
    ['.smb-select', '顶栏·动效档选择器'],
  ],
  subject: [
    ['.smb-subhead__goal', '科目页·目标'],
    ['.smb-subhead__counts .smb-chip', '科目页·三档计数 chip'],
    ['.smb-block__hint', '科目页·提示（三级文字）'],
    ['.smb-map__levelname', '路线图·层名（四级文字）'],
    ['.smb-card__goal', '路线图·卡片目标'],
    ['.smb-refitem__open', '科目页·参考资料条目'],
    ['.smb-refitem .smb-meta', '科目页·资料元信息（四级文字）'],
  ],
  lesson: [
    ['.smb-crumb', '课件·面包屑'],
    ['.smb-center__head .smb-meta', '课件·作答进度'],
    ['.smb-sec', '课件·小节目录项'],
    ['.smb-doc a', '课件·正文链接'],
    ['.smb-doc figcaption', '课件·图注（四级文字）'],
    ['.smb-code__bar b', '课件·代码语言标签（四级文字）'],
    ['.smb-math-block', '课件·块级公式'],
    ['.smb-node', '左栏·节点（只宽档有）'],
    ['.smb-rail__label', '窄轨·标签'],
    ['.smb-q__text', '右栏·题干'],
    ['.smb-opt', '右栏·选项'],
    // #93 条目 17 那颗题型徽标。原来这里指 `.smb-chip--kind`，而那个类名是**顶部那条**里
    // 节点类型的 chip（第一个就命中它），量的一直不是右栏的徽标——现在徽标有了自己的类名，
    // 这条取样点才真的落在它身上
    ['.smb-q__kind', '右栏·题型徽标'],
  ],
  search: [
    ['.smb-palette__input input', '搜索·输入框'],
    ['.smb-palette__list .smb-meta', '搜索·命中数'],
    ['.smb-hit__text', '搜索·结果正文'],
    ['.smb-hit__kind', '搜索·结果类别（四级文字）'],
    ['.smb-hit__where', '搜索·结果位置（四级文字）'],
  ],
};

/* 窄档下左右两条栏装不下：`planPanes` 先给右栏、左栏让位，所以左栏那条取样点取不到——
   按档裁掉它，而不是把它算成「探针没命中」。
   紧档（700）反过来：那一档左栏并排得下（204px）、右栏才是抽屉，所以这里的取样点一个不裁
   ——右栏那几个（题干、选项、题型徽标）在抽屉里照样渲染得出来。 */
function contrastTargets(face, viewportKey) {
  const rows = CONTRAST_TARGETS[face];
  return viewportKey === 'narrow' ? rows.filter(([sel]) => sel !== '.smb-node') : rows;
}

/* 紧档还要多量一处（#88）：抽屉顶上那条说明是「可见的解释」本身，它也得过得去对比度 */
const DRAWER_CONTRAST = [[
  '.smb-drawer__note', '紧档·抽屉顶上的说明条',
], [
  '.smb-drawer__note b', '紧档·抽屉说明条的「窗口太窄」',
]];

/* ── 页面上的几步操作（都靠真点击，不碰内部状态） ───────────────────────── */

/** 首页 → 科目主页。用科目名找卡片，不靠索引顺序。 */
const OPEN_SUBJECT = `(() => {
  const cards = Array.from(document.querySelectorAll('[data-proto="nav-subject"]'));
  const card = cards.find((el) => el.textContent.includes('演示科目')) || cards[0];
  card.click();
})()`;

/** 科目主页 → 课件页（挑「变量」那一课，它带着公式/配图/代码块/题目）。 */
const OPEN_LESSON = `(() => {
  const cards = Array.from(document.querySelectorAll('[data-proto="open-node"]'));
  const card = cards.find((el) => el.textContent.includes('变量')) || cards[0];
  card.click();
})()`;

/** 打开搜索覆盖层（顶栏那个按钮；覆盖层自己没有 data-proto 钩子）。 */
const OPEN_PALETTE = `document.querySelector('.smb-searchbtn').click()`;

/** 往搜索框里打字。mini-react 把 onChange 直连成 change 监听，所以设值后派发 change。 */
function typeSearch(keyword) {
  return `(() => {
    const input = document.querySelector('.smb-palette__input input');
    if (!input) throw new Error('搜索覆盖层没打开');
    input.value = ${JSON.stringify(keyword)};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`;
}

/* ── 跑 ────────────────────────────────────────────────────────────────── */

// 先起会话：找不到浏览器就直接跳过（退出码 3），别先造一堆临时工作区再丢下不管
const session = await openSession({ suite: 'reading-routes', width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });

/** 换档：改的是 CSS 视口（媒体查询看的就是它），不是窗口像素。 */
async function useViewport(viewport) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
  });
  await session.sleep(150);
}

/** 首页那两条响应式规则的实测读数，按档存下来给最后那一场对账。 */
const layoutByViewport = {};
/** 课件页那一面的读数（栏形态、正文列占中栏多少），同样留给对账那一场。 */
const lessonByViewport = {};
/** 右栏题库那一面的读数（#93）：给最后那一场对账「并排与抽屉两种形态下都成立」。 */
const quizByViewport = {};

try {
  const { root, workspace } = makeWorkspace();
  const payload = readLibrary({ workspace });
  const fixture = buildFixture(root, payload);
  // 右栏那一面自己的夹具（三种题型 + 长 token + 一次已作答），同一档视口下另开一份
  const quizWorkspace = makeQuizWorkspace();
  const quizFixture = buildFixture(quizWorkspace.root, quizWorkspace.payload, 'quiz-fixture.html');
  console.log(`夹具：${fixture}`);
  console.log(`数据：${workspace}（跑完删）`);
  console.log(`右栏夹具：${quizFixture}`);
  console.log(`右栏数据：${quizWorkspace.workspace}（跑完删）`);

  for (const viewport of VIEWPORTS) {
    await useViewport(viewport);
    /* `compact` 是「落在 900 那条断点里没有」——紧档（700）也在里面，所以它不能写成
       「是不是窄档」：三档里有两档都命中那条 @media。#88 加档时这里最容易写错。 */
    const compact = viewport.width <= 900;
    const tag = '[' + viewport.key + ' ' + viewport.width + '×' + viewport.height + ']';

    /* ── 面一：今天学什么 ──────────────────────────────────────────────── */
    await session.scene('reading-routes-' + viewport.key + '-home', async (ctx) => {
      await ctx.navigate(fixture, { settle: 1200 });
      const seen = await ctx.evaluate(HOME_PROBE);
      layoutByViewport[viewport.key] = seen.layout;

      check(`${tag} 阅读端挂起来了（.smb-root 在）`, seen.hero === '学习工作台', JSON.stringify(seen.bodyText).slice(0, 160));
      check(`${tag} 第一屏给出「接着上次」的去处`,
        seen.continueSubject === '演示科目' && !!seen.continueTitle && seen.continueGo === '继续读 →',
        `${seen.continueSubject} / ${seen.continueTitle} / ${seen.continueGo}`);
      // 「可直接进入」不是看它长得像按钮，是**点下去真的落到那张卡说的那个节点上**（#90）。
      // 点完把夹具重新导航一次：这一场的截图要的还是主页这一面，不是点进去之后的课件页。
      await ctx.evaluate(`document.querySelector('[data-proto="continue"]').click()`);
      await ctx.sleep(500);
      const entered = await ctx.evaluate(LESSON_PROBE);
      // 卡上那个标题带位次前缀（「2 函数」），落到页面上是节点名本身——所以断的是
      // 「点进去那一页的标题就在卡上那段字里」+「真的是课件正文，不是缺课件那一页」
      check(`${tag} 第一屏那张卡点得进去，且落在它说的那个节点上`,
        !!entered.crumb && entered.crumb === entered.articleHeading
        && String(seen.continueTitle).includes(entered.crumb) && entered.articleChars > 80,
        `卡上写的是 ${seen.continueTitle}，点进去到了 ${entered.crumb} / ${entered.articleHeading}（正文 ${entered.articleChars} 字）`);
      await ctx.navigate(fixture, { settle: 1000 });
      check(`${tag} 科目列表一行一门`, seen.courses === 2 && seen.courseNames.some((one) => one.includes('第二科目')),
        JSON.stringify(seen.courseNames));
      check(`${tag} 顶栏四档动效都还在`,
        JSON.stringify(seen.motionOptions) === JSON.stringify(['auto', 'full', 'reduced', 'off']),
        JSON.stringify(seen.motionOptions));
      check(`${tag} 断点 (max-width: 900px) 的命中状态与档位一致`,
        seen.breakpoint900 === compact, String(seen.breakpoint900));
      // 两条响应式规则有没有真的落到计算样式与几何上——只看**关系**，不钉值
      const layout = seen.layout;
      check(`${tag} 壳那条规则（.smb-wrap / .smb-topbar / .smb-continue__bar）落到了计算样式上`,
        layout.topbarWrap === (compact ? 'wrap' : 'nowrap')
        && layout.continueBarWrap === (compact ? 'wrap' : 'nowrap'),
        JSON.stringify(layout));
      check(`${tag} 科目行那条规则（.smb-course）落到了几何上`,
        layout.courseWrap === (compact ? 'wrap' : 'nowrap')
        && !!layout.courseMain && !!layout.courseSide
        && (compact
          ? layout.courseSide.y >= layout.courseMain.y + layout.courseMain.h - 1
          : layout.courseSide.y < layout.courseMain.y + layout.courseMain.h),
        JSON.stringify(layout));
      return {
        viewport: viewport.key, size: [seen.width, viewport.height], breakpoint900: seen.breakpoint900,
        courses: seen.courses, continueNode: seen.continueTitle, progress: seen.progress,
        // 「点得进去」的读数：卡上写的那个节点 vs 点进去那一页的标题
        entered: { card: seen.continueTitle, crumb: entered.crumb, heading: entered.articleHeading },
        layout, documentOverflowX: seen.overflowX,
      };
    });

    /* ── 面二：科目主页 ────────────────────────────────────────────────── */
    await session.scene('reading-routes-' + viewport.key + '-subject', async (ctx) => {
      await ctx.navigate(fixture, { settle: 1200 });
      await ctx.evaluate(OPEN_SUBJECT);
      await ctx.sleep(400);
      const seen = await ctx.evaluate(SUBJECT_PROBE);
      check(`${tag} 进了科目主页（科目名在标题里）`, seen.title === '演示科目', JSON.stringify(seen.bodyText).slice(0, 160));
      check(`${tag} 路线图带 aria-label 与 role=group`,
        /^路线图：演示科目，3 层、3 个节点/.test(String(seen.mapLabel)) && seen.mapRole === 'group',
        `${seen.mapLabel} / ${seen.mapRole}`);
      check(`${tag} 三张节点卡片都在`, seen.nodeCards === 3, JSON.stringify(seen.nodeNames));
      check(`${tag} 参考资料那一块有内容可量`,
        seen.blocks.some((one) => one.startsWith('参考资料')) && seen.refItems >= 1 && !!seen.refFirst,
        `blocks=${JSON.stringify(seen.blocks)} refItems=${seen.refItems} first=${seen.refFirst}`);
      return {
        viewport: viewport.key, size: [seen.width, viewport.height], mapLabel: seen.mapLabel,
        mapLevels: seen.mapLevels, nodeCards: seen.nodeCards, blocks: seen.blocks,
        refItems: seen.refItems, refFirst: seen.refFirst, progressLabel: seen.progressLabel,
        documentOverflowX: seen.overflowX,
      };
    });

    /* ── 面三：课件页 ──────────────────────────────────────────────────── */
    await session.scene('reading-routes-' + viewport.key + '-lesson', async (ctx) => {
      await ctx.navigate(fixture, { settle: 1200 });
      await ctx.evaluate(OPEN_SUBJECT);
      await ctx.sleep(300);
      await ctx.evaluate(OPEN_LESSON);
      await ctx.sleep(400);
      // 右栏「题目」：spec 的测试决定点名了「右栏题目进了 DOM、选项可点」
      await ctx.evaluate(`document.querySelector('[data-proto="toggle-quiz"]').click()`);
      await ctx.sleep(400);
      const seen = await ctx.evaluate(LESSON_PROBE);
      const wantMode = PANE_MODES[viewport.key];

      check(`${tag} 进了课件页（面包屑停在节点名上）`, seen.crumb === '变量', String(seen.crumb));
      check(`${tag} 三栏壳在（左窄轨 1 条 + 右窄轨 2 条）`, !!seen.panes && seen.rails === 3,
        `panes=${JSON.stringify(seen.panes)} rails=${seen.rails}`);
      check(`${tag} 正文渲染出来了（有小节、有正文）`,
        seen.articleHeading === '变量' && seen.sections >= 2 && seen.articleChars > 80,
        `h1=${seen.articleHeading} sections=${seen.sections} chars=${seen.articleChars}`);
      check(`${tag} 代码块带语言标签`, seen.codeLangs.includes('js'), JSON.stringify(seen.codeLangs));
      check(`${tag} 位图配图进了正文且真的加载出来了`,
        !!seen.figure && seen.figure.scheme === 'data' && seen.figure.loaded,
        JSON.stringify(seen.figure));
      check(`${tag} 正文里的题目标记在`, seen.quizMarkers === 1 && !!seen.quizMarkerText, String(seen.quizMarkerText));
      check(`${tag} 右栏题目进了 DOM、选项是能点的按钮`,
        seen.questions >= 1 && seen.optionTags.length >= 3 && seen.optionTags.every((one) => one === 'BUTTON'),
        `questions=${seen.questions} options=${JSON.stringify(seen.optionTags)}`);

      /* 这一档右栏该是什么形态（#88）：并排装得下就并排，装不下就盖在正文上。
         紧档专取后者——「点了没反应」是这条票要消掉的缺陷，所以这里断的是
         「有形态、有解释、有出路」，不是某几个像素。 */
      check(`${tag} 右栏的形态与这一档画布一致（并排 / 盖在正文上）`,
        seen.modes && seen.modes.right === wantMode,
        `画布 ${seen.frame}px：形态=${seen.modes && seen.modes.right}，这一档应当是 ${wantMode}`);
      check(`${tag} 收起时窄轨还在，右栏的窄轨认得这一档`,
        seen.railBars > 0 && !!seen.railToken, `窄轨 ${seen.railBars}px（--smb-rail: ${seen.railToken}）`);

      if (wantMode === 'drawer') {
        // 画布不足时点「题目」必须给出**看得见的解释**与**一条出路**
        check(`${tag} 画布不足：右栏盖在正文上，而不是静默归零`,
          !!seen.drawer && seen.drawer.side === 'right' && seen.drawer.box.w > 0,
          JSON.stringify(seen.drawer));
        check(`${tag} 画布不足：抽屉顶上写着为什么（窗口太窄 + 拉宽就并排）`,
          !!seen.drawer && /窗口太窄/.test(seen.drawer.note) && /拉宽窗口就并排/.test(seen.drawer.note),
          JSON.stringify(seen.drawer && seen.drawer.note));
        check(`${tag} 画布不足：出路就是这一栏本身——题目与选项都在抽屉里、点得到`,
          seen.questions >= 1 && seen.optionTags.length >= 3 && seen.optionTags.every((one) => one === 'BUTTON'),
          `questions=${seen.questions} options=${JSON.stringify(seen.optionTags)}`);
        check(`${tag} 画布不足：抽屉给正文留了一条缝、也没越过画布`,
          !!seen.centerBox && !!seen.drawer && seen.drawer.box.w < seen.centerBox.w
          && seen.centerBox.x + seen.drawer.box.w <= seen.width,
          `抽屉 ${JSON.stringify(seen.drawer.box)} 中栏 ${JSON.stringify(seen.centerBox)} 视口 ${seen.width}`);
        check(`${tag} 画布不足：一条「收起」就回得去，收起后抽屉不在、窄轨还在`,
          !!seen.drawer && seen.drawer.close,
          JSON.stringify(seen.drawer));
        await ctx.evaluate(`document.querySelector('[data-proto="pane-drawer-close"]').click()`);
        await ctx.sleep(300);
        const closed = await ctx.evaluate(LESSON_PROBE);
        check(`${tag} 收起之后右栏不见了、正文回到整幅画布`,
          closed.modes.right === 'off' && !closed.drawer && !!closed.docBox
          && closed.docBox.x + closed.docBox.w <= closed.width,
          `modes=${JSON.stringify(closed.modes)} drawer=${!!closed.drawer}`);
        // 再点一次窄轨：出路是稳定的，不是一次性的
        await ctx.evaluate(`document.querySelector('[data-proto="toggle-quiz"]').click()`);
        await ctx.sleep(300);
      }

      // 正文列与中栏的读数：宽档要占得住、窄档不许被压成一条（对账见最后那一场）
      check(`${tag} 中栏没被栏挤破保底（画布够宽时）`,
        !!seen.centerBox && seen.centerBox.w >= Math.min(MIN_CENTER, seen.frame - seen.railBars) - 1,
        `中栏 ${seen.centerBox && seen.centerBox.w}px / 画布 ${seen.frame}px`);
      check(`${tag} 正文列没被压成一条（≥ 300px 的正文，永远铺满中栏）`,
        !!seen.docBox && !!seen.centerBox && seen.docBox.w <= seen.centerBox.w + 1 && seen.docBox.w >= 300,
        `正文列 ${seen.docBox && seen.docBox.w}px 中栏 ${seen.centerBox && seen.centerBox.w}px`);
      if (wantMode === 'column') {
        check(`${tag} 并排的右栏在它的下限之上，正文仍读得下去`,
          !!seen.rightBox && seen.rightBox.w >= 280 && !!seen.docBox && seen.docBox.w >= 300,
          `右栏 ${seen.rightBox && seen.rightBox.w}px 正文列 ${seen.docBox && seen.docBox.w}px`);
      }

      const lessonMetrics = {
        viewport: viewport.key, size: [seen.width, viewport.height], panes: seen.panes, modes: seen.modes,
        rails: seen.rails, railBarWidth: seen.railBars, railToken: seen.railToken, frame: seen.frame,
        centerWidth: seen.centerBox && seen.centerBox.w, rightWidth: seen.rightBox && seen.rightBox.w,
        docWidth: seen.docBox && seen.docBox.w,
        docShareOfCenter: seen.docBox && seen.centerBox ? Math.round(seen.docBox.w / seen.centerBox.w * 100) / 100 : null,
        drawer: seen.drawer && { side: seen.drawer.side, width: seen.drawer.box.w, note: seen.drawer.note },
        handle: seen.handle,
        sections: seen.sections, secs: seen.secs, questions: seen.questions,
        questionText: seen.questionText, options: seen.optionTexts, answered: seen.answered,
        // 公式在真浏览器里落到 DOM 上的读数：本票只记不判（排得好不好是 #91 的验收面）
        math: { inline: seen.mathInline, block: seen.mathBlock },
        figure: seen.figure, codeLangs: seen.codeLangs,
        // 正文列有没有横向溢出：本票只记不判（配图受不受列宽约束是呈现票的验收面）
        centerOverflowX: seen.centerOverflowX,
      };
      lessonByViewport[viewport.key] = lessonMetrics;
      return lessonMetrics;
    });

    /* ── 面三·右栏题库（#93 条目 17 / 18 / 19 / 21 / 22） ──────────────────
       右栏只在课件页里存在，所以这一场跟在「面三」后面、同一档视口，换一份**专门把右栏摆满**的
       夹具（三种题型各一组、题干与选项里各一段没有断点的长 token、题库带着一次已作答）。

       形态由 #88 的几何决定：宽档与窄档是并排的一栏，紧档是盖在正文上的抽屉。**两种形态下
       量的是同一份 DOM**（`Inspector` 在两种形态下是同一个元素），所以这里断的是同一批关系，
       只在读数里把形态记下来——「抽屉里也成立」不是另写一套断言，而是同一套断言跑在不同的
       形态上。这一档的形态如果不符（`data-right-mode` 不是该有的那个），下面那条会红。 */
    await session.scene('reading-routes-' + viewport.key + '-quiz', async (ctx) => {
      await ctx.navigate(quizFixture, { settle: 1200 });
      await ctx.evaluate(OPEN_SUBJECT);
      await ctx.sleep(300);
      await ctx.evaluate(OPEN_LESSON);
      await ctx.sleep(400);
      await ctx.evaluate(`document.querySelector('[data-proto="toggle-quiz"]').click()`);
      await ctx.sleep(400);
      const seen = await ctx.evaluate(QUIZ_PROBE);
      const wantMode = PANE_MODES[viewport.key];
      check(`${tag} 右栏开在这一档该有的形态上（并排 / 盖在正文上）`,
        seen.open === '1' && seen.mode === wantMode, `形态=${seen.mode}（该是 ${wantMode}）`);
      check(`${tag} 右栏渲染出了三组题（这道夹具就是为了把它摆满）`,
        seen.groups.length === 3 && seen.cards.length === 3,
        JSON.stringify({ groups: seen.groups.map((one) => one.no), cards: seen.cards.length }));
      check(`${tag} 三组题的编号与正文里三条标记对得上`,
        JSON.stringify(seen.groups.map((one) => one.no)) === JSON.stringify(seen.markers.map((one) => one.no))
        && seen.markers.length === 3, JSON.stringify({ groups: seen.groups, markers: seen.markers }));

      /* 条目 17：题型徽标是个**贴字**的标签，不是被弹性行拉成一根约 150px 高的竖条。
         两条关系：① 高不过自己那行字的两倍；② 高与正文里那颗「练习」徽标（同一个画法、
         在一条 align-items:center 的行里）差不多——后者是「贴字」的天然尺子，所以不用钉像素。 */
      const badges = seen.cards.map((one) => one.badge).filter(Boolean);
      check(`${tag} 三条题各自的题型徽标都在（客观题 / 开放题 / 交付物）`,
        JSON.stringify(badges.map((one) => one.text)) === JSON.stringify(['客观题', '开放题', '交付物']),
        JSON.stringify(badges));
      const stretchLimit = badges.map((one) => Math.round(one.fontSize * 2));
      check(`${tag} 题型徽标是贴字的标签：高 ${badges.map((one) => one.box.h).join('/')}px，都没超过自己那行字的两倍`,
        badges.length === 3 && badges.every((one) => one.box.h > 0 && one.box.h <= one.fontSize * 2),
        JSON.stringify({ badges: badges.map((one) => one.box), limit: stretchLimit }));
      check(`${tag} 题型徽标不是竖条：横着比竖着宽，高也与正文那颗「练习」徽标同档`,
        badges.every((one) => one.box.w > one.box.h) && !!seen.markerBadge
        && badges.every((one) => Math.abs(one.box.h - seen.markerBadge.h) <= 4),
        JSON.stringify({ badges: badges.map((one) => one.box), reference: seen.markerBadge }));

      /* 条目 19：右栏 tab 的选中态是**下划线**（右栏专用那条规则），不是左栏那套胶囊。
         两条关系：① 选中的那个底边是品牌色、未选中的不是；② 选中不换底色（胶囊的选中态
         恰恰靠换底色 + 描边）。品牌色是现解出来的，不写死。 */
      const selected = seen.tabs.filter((one) => one.selected);
      const unselected = seen.tabs.filter((one) => !one.selected);
      check(`${tag} 右栏两个 tab 恰好选中一个（题目 / 问答）`,
        seen.tabs.length === 2 && selected.length === 1 && seen.tabs[0].text.indexOf('题目') === 0,
        JSON.stringify(seen.tabs.map((one) => ({ text: one.text, selected: one.selected }))));
      check(`${tag} 右栏 tab 的选中态是下划线：底边是品牌色（未选中的不是）`,
        selected.length === 1 && unselected.length === 1
        && selected[0].borderBottomColor === seen.brand && selected[0].borderBottomWidth > 0
        && unselected[0].borderBottomColor !== seen.brand,
        JSON.stringify({ selected: selected[0], unselected: unselected[0], brand: seen.brand }));
      check(`${tag} 右栏 tab 的选中态不是左栏那套胶囊：选中不换底色（${selected.length === 1 ? selected[0].backgroundColor : '?'}）`,
        selected.length === 1 && unselected.length === 1
        && selected[0].backgroundColor === unselected[0].backgroundColor,
        JSON.stringify(seen.tabs.map((one) => ({ text: one.text, selected: one.selected, bg: one.backgroundColor, radius: one.borderRadius }))));
      /* tab 条与内容的关系（两种形态都要成立）：tab 条在内容**上方**、与内容**同宽同起边**。
         抽屉那一档最容易坏：抽屉的 body 是一条弹性行，检查器若交出两个兄弟节点，
         tab 条就被摊成左边一竖列（内容被挤到右半幅）——选中态再对，学生也看不到设计的样子。 */
      check(`${tag} tab 条在内容上方、与内容同宽同起边（并排与抽屉都该如此）`,
        !!seen.pane && !!seen.pane.tabsBox
        && seen.pane.tabsBox.y + seen.pane.tabsBox.h <= seen.pane.box.y + 2
        && Math.abs(seen.pane.tabsBox.x - seen.pane.box.x) <= 2
        && Math.abs(seen.pane.tabsBox.w - seen.pane.box.w) <= 2,
        JSON.stringify({ tabs: seen.pane.tabsBox, body: seen.pane.box }));

      /* 条目 21：上次作答的结果在右栏看得见——它来自 attempts/，不是当场点出来的。
         这一条是「已有能力，别丢」：改动右栏时它必须还在，并且得**在右栏里**（正文里不算）。 */
      check(`${tag} 上次作答的结果在右栏看得见（来自 attempts/ 的那一条）`,
        seen.review.length === 1 && seen.review[0].inPane && /上次选了 A，对了/.test(seen.review[0].text),
        JSON.stringify(seen.review));

      /* 条目 22：右栏只出纵向滚动条。长 token 不许把内容顶宽（题干与选项各自也不许），
         纵向该滚还得滚得动——「只有纵向」的正面那一半。

         两条一起断才算数：① 右栏那个滚动容器自己没有横向溢出；② 题干与选项的右边缘都在
         裁切线以内（`.smb-agroup` 带 overflow: hidden，只断 ① 的话「文字被裁掉」也会绿——
         这条夹具刚写出来时量到的就是那个假绿：题干被顶宽、被组卡片裁掉，滚动条一根没有）。 */
      const stems = seen.cards.map((one) => one.stemOverflowX);
      const lines = seen.cards.flatMap((one) => one.stemLinesOverflowX);
      const options = seen.cards.flatMap((one) => one.optionOverflowX);
      const overhangs = seen.cards.map((one) => one.overhang);
      check(`${tag} 长 token 不在题干里顶出横向溢出（题干 ${stems.join('/')}、每一行 ${lines.join('/')}）`,
        !!seen.pane && stems.every((one) => one <= 0) && lines.every((one) => one <= 0),
        JSON.stringify({ stems, lines }));
      check(`${tag} 长 token 不在选项里顶出横向溢出（每个选项 ${options.join('/')}）`,
        options.length >= 3 && options.every((one) => one <= 0), JSON.stringify(options));
      check(`${tag} 长题干与长选项都没被裁掉：右边缘都在组卡片的裁切线以内（越过 ${overhangs.join('/')}px）`,
        overhangs.length === 3 && overhangs.every((one) => one !== null && one <= 1),
        JSON.stringify(seen.cards.map((one) => ({ overhang: one.overhang, clipEdge: one.clipEdge, stem: one.stem }))));
      check(`${tag} 右栏自己不出横向滚动条（内容 ${seen.pane && seen.pane.scrollWidth} ≤ 可见 ${seen.pane && seen.pane.clientWidth}）`,
        !!seen.pane && seen.pane.innerOverflowX <= 0, JSON.stringify(seen.pane));
      check(`${tag} 纵向照旧滚得动（内容 ${seen.pane && seen.pane.scrollHeight} > 可见 ${seen.pane && seen.pane.clientHeight}，overflow-y=${seen.pane && seen.pane.overflowY}）`,
        !!seen.pane && seen.pane.scrollHeight > seen.pane.clientHeight && seen.pane.overflowY === 'auto',
        JSON.stringify(seen.pane));

      /* 条目 18：点正文里的题目标记 → 右栏**对应的那一组**出现明确的「当前」标记。
         先记一份点之前的读数：不许一上来就有哪一组自称当前。 */
      check(`${tag} 还没点标记时，右栏没有任何一组自称「当前」`,
        seen.groups.every((one) => one.current !== 'true'),
        JSON.stringify(seen.groups.map((one) => one.current)));

      const clickedGroup = await ctx.evaluate(clickMarker(1));
      await ctx.sleep(700);   // 滚动是 smooth 的，留出它走完的时间
      const marked = await ctx.evaluate(QUIZ_PROBE);
      const current = marked.groups.filter((one) => one.current === 'true');
      check(`${tag} 点第 ${clickedGroup} 组的标记之后，右栏恰好那一组是「当前」`,
        current.length === 1 && current[0].no === clickedGroup
        && marked.groups.filter((one) => one.no === clickedGroup).length === 1,
        JSON.stringify({ clicked: clickedGroup, groups: marked.groups.map((one) => ({ no: one.no, current: one.current })) }));
      check(`${tag} 「当前」看得见：那一组的边与编号圈都换成了品牌色，别组没有`,
        current.length === 1
        && current[0].borderTopColor === marked.brand && current[0].circleBackground === marked.brand
        && marked.groups.filter((one) => one.current !== 'true')
          .every((one) => one.borderTopColor !== marked.brand && one.circleBackground !== marked.brand),
        JSON.stringify({ brand: marked.brand, groups: marked.groups.map((one) => ({ no: one.no, border: one.borderTopColor, circle: one.circleBackground })) }));
      check(`${tag} 点标记之后那一组落在右栏的可见范围里（定位与标记是一件事）`,
        current.length === 1 && !!marked.pane && current[0].box.y >= marked.pane.box.y - 2
        && current[0].box.y + 8 <= marked.pane.box.y + marked.pane.box.h,
        JSON.stringify({ group: current.length === 1 ? current[0].box : null, pane: marked.pane && marked.pane.box }));

      /* 条目 21 的另一半：切到「问答」再切回来，上次作答那句还在（别在切 tab 的路上丢了）。 */
      await ctx.evaluate(clickTab(1));
      await ctx.sleep(300);
      const asked = await ctx.evaluate(QUIZ_PROBE);
      check(`${tag} 切到「问答」tab：选中态跟着换人，面板换成问答`,
        asked.tabs.filter((one) => one.selected).length === 1 && asked.tabs[1].selected === true
        && !!asked.bodyText, JSON.stringify(asked.tabs.map((one) => ({ text: one.text, selected: one.selected }))));
      await ctx.evaluate(clickTab(0));
      await ctx.sleep(300);
      const back = await ctx.evaluate(QUIZ_PROBE);
      check(`${tag} 切回「题目」tab：上次作答那句还在右栏里，当前组也还是那一组`,
        back.review.length === 1 && back.review[0].inPane && /上次选了 A，对了/.test(back.review[0].text)
        && back.groups.filter((one) => one.current === 'true').length === 1
        && back.groups.filter((one) => one.current === 'true')[0].no === clickedGroup,
        JSON.stringify({ review: back.review, groups: back.groups.map((one) => ({ no: one.no, current: one.current })) }));

      /* 就地答一题：那句「上次选了 …」要跟着换成刚落下的这一次。
         夹具页的 fetch 是 stub 的（作答接口回 404），所以这一条断的是**界面**的即时读数，
         落盘那一半由 attempts_test.mjs 在真 HTTP 迷你宿主上验——这里不假装它落了盘。 */
      await ctx.evaluate(`(() => {
        const opts = document.querySelectorAll('.smb-q .smb-opt');
        if (opts.length < 3) throw new Error('第一题没有三个选项');
        opts[1].click();
      })()`);
      await ctx.sleep(300);
      const answered = await ctx.evaluate(QUIZ_PROBE);
      check(`${tag} 就地作答之后，那句「上次选了 …」换成刚落下的这一次`,
        answered.review.length === 1 && answered.review[0].inPane && /上次选了 B，错了/.test(answered.review[0].text),
        JSON.stringify(answered.review));

      /* 条目 18 的另一半：**当前**只属于点过的那一课。LessonPage 的状态换课不重挂，
         所以「当前」标记很容易不请自来——下一课谁也没点过，右栏就不该有哪一组自称当前。 */
      await ctx.evaluate(`(() => {
        const buttons = document.querySelectorAll('.smb-navfoot button');
        if (!buttons.length) throw new Error('课件页底部没有前后课');
        buttons[buttons.length - 1].click();
      })()`);
      await ctx.sleep(600);
      const next = await ctx.evaluate(QUIZ_PROBE);
      check(`${tag} 换到下一课：「当前」标记不跟过去（那一课谁也没点过）`,
        next.groups.length >= 2 && next.groups.every((one) => one.current !== 'true'),
        JSON.stringify(next.groups.map((one) => ({ no: one.no, current: one.current }))));

      const quizMetrics = {
        viewport: viewport.key, size: [seen.width, viewport.height], mode: seen.mode,
        pane: seen.pane, markerBadge: seen.markerBadge,
        tabs: seen.tabs.map((one) => ({
          text: one.text, classes: one.classes, selected: one.selected,
          backgroundColor: one.backgroundColor, borderBottomColor: one.borderBottomColor,
          borderBottomWidth: one.borderBottomWidth, borderRadius: one.borderRadius, fontWeight: one.fontWeight,
        })),
        badges: badges.map((one) => ({ text: one.text, box: one.box, fontSize: one.fontSize, whiteSpace: one.whiteSpace })),
        overflow: { stems, lines, options, overhangs, clipEdge: seen.cards.map((one) => one.clipEdge) },
        groups: marked.groups.map((one) => ({ no: one.no, title: one.title, current: one.current, box: one.box })),
        clickedGroup,
        review: { onLoad: seen.review, afterTabs: back.review, afterAnswer: answered.review },
        nextLesson: next.groups.map((one) => ({ no: one.no, current: one.current })),
      };
      quizByViewport[viewport.key] = quizMetrics;
      return quizMetrics;
    });

    /* ── 面三·右栏题库的取景（#93）：镜头停在「点过标记之后」那一刻 ──────────
       上一场最后一步换到了下一课，拍不到「当前」那一下；这一场把状态停在「点过第 2 组的
       标记、右栏正是那一组」，宽窄三档各一张。人照着截图就能判条目 17（题型徽标）、
       19（tab 下划线）、21（上次作答）、22（只有纵向滚动条）：这四样都在同一屏里。 */
    await session.scene('reading-routes-' + viewport.key + '-quiz-marked', async (ctx) => {
      await ctx.navigate(quizFixture, { settle: 1200 });
      await ctx.evaluate(OPEN_SUBJECT);
      await ctx.sleep(300);
      await ctx.evaluate(OPEN_LESSON);
      await ctx.sleep(400);
      await ctx.evaluate(`document.querySelector('[data-proto="toggle-quiz"]').click()`);
      await ctx.sleep(400);
      await ctx.evaluate(clickMarker(1));
      await ctx.sleep(700);
      const seen = await ctx.evaluate(QUIZ_PROBE);
      const current = seen.groups.filter((one) => one.current === 'true');
      check(`${tag} 取景这一幕停在「当前」那一组上（截图看的就是这一下）`,
        current.length === 1 && current[0].no === '2' && seen.mode === PANE_MODES[viewport.key]
        && seen.review.some((one) => /上次选了 A，对了/.test(one.text)),
        JSON.stringify({ mode: seen.mode, current: current.map((one) => one.no), review: seen.review }));
      return {
        viewport: viewport.key, size: [seen.width, viewport.height], mode: seen.mode,
        current: current.map((one) => ({ no: one.no, box: one.box })),
        badges: seen.cards.map((one) => (one.badge ? { text: one.badge.text, box: one.badge.box } : null)),
        review: seen.review, paneWidth: seen.pane && seen.pane.clientWidth,
        overhangs: seen.cards.map((one) => one.overhang),
      };
    });

    /* ── 面四：搜索（覆盖层，不是路由） ─────────────────────────────────── */
    await session.scene('reading-routes-' + viewport.key + '-search', async (ctx) => {
      await ctx.navigate(fixture, { settle: 1200 });
      await ctx.evaluate(OPEN_PALETTE);
      await ctx.sleep(300);
      const opened = await ctx.evaluate(SEARCH_PROBE);
      check(`${tag} 点顶栏按钮能打开搜索覆盖层、输入框拿到焦点、空态给了话`,
        opened.open && opened.focused && /输入关键词/.test(String(opened.empty)),
        JSON.stringify({ open: opened.open, focused: opened.focused, empty: opened.empty }));

      await ctx.evaluate(typeSearch('变量'));
      await ctx.sleep(400);
      const seen = await ctx.evaluate(SEARCH_PROBE);
      check(`${tag} 打关键词后渲染出结果`, seen.hits >= 2 && seen.kinds.length === seen.hits,
        `hits=${seen.hits} kinds=${JSON.stringify(seen.kinds)} meta=${seen.meta}`);
      // 「大纲」这一类在界面上叫「节点元信息」（KIND_LABEL），断言按学生看得见的那个名字写
      check(`${tag} 结果跨类别（节点元信息、题目、正文都命中）`,
        ['节点元信息', '题目', '正文'].every((one) => seen.kinds.includes(one)), JSON.stringify(seen.kinds));
      check(`${tag} 命中数与列表条数对得上`,
        String(seen.meta).startsWith(seen.hits + ' 条命中'), `meta=${seen.meta} hits=${seen.hits}`);
      check(`${tag} 覆盖层不撑出视口`,
        !!seen.boxRect && seen.boxRect.w <= seen.width && seen.boxRect.left >= 0,
        JSON.stringify(seen.boxRect) + ' vs ' + seen.width);
      // 每条结果都看得出属于哪门科目（有节点的那几条还要看得出哪个节点）
      check(`${tag} 每条结果都标出了科目，带节点的还标出了节点`,
        seen.where.length === seen.hits
        && seen.where.every((one) => /^(演示科目|第二科目)/.test(String(one)))
        && seen.where.some((one) => String(one).includes('变量')),
        JSON.stringify(seen.where.slice(0, 4)));

      /* 无断点的长 URL：折在自己那一格，结果行与列表都不出横向滚动条。
         查询词取 `example.com`——那条命中在**第二门**科目里，所以顺带证明出处那一段
         跨科目也对（`第二科目 · 列表 · 参考`）。 */
      await ctx.evaluate(typeSearch('example.com'));
      await ctx.sleep(400);
      const long = await ctx.evaluate(SEARCH_PROBE);
      check(`${tag} 无断点的长 URL 撑不破结果行，也不给列表顶出横向滚动条`,
        long.hits >= 1 && long.listOverflowX <= 0 && long.hitOverflowX.every((one) => one <= 0)
        && long.where.every((one) => String(one).startsWith('第二科目 · 列表')),
        `hits=${long.hits} list=${long.listOverflowX} rows=${JSON.stringify(long.hitOverflowX)} where=${JSON.stringify(long.where)}`);
      // 取景回到「变量」那一组：这一场的截图要的是正常结果，不是这条极端样例
      await ctx.evaluate(typeSearch('变量'));
      await ctx.sleep(400);
      return {
        viewport: viewport.key, size: [seen.width, viewport.height],
        opened: { open: opened.open, focused: opened.focused, emptyState: opened.empty },
        query: seen.inputValue, hits: seen.hits, kinds: seen.kinds,
        texts: seen.texts, where: seen.where, boxWidth: seen.boxRect && seen.boxRect.w,
        longText: { hits: long.hits, where: long.where, listOverflowX: long.listOverflowX, rowOverflowX: long.hitOverflowX },
      };
    });

    /* ── 亮暗两套的对比度实测（四个面都量） ─────────────────────────────── */
    for (const theme of ['light', 'dark']) {
      await session.scene('reading-routes-' + viewport.key + '-contrast-' + theme, async (ctx) => {
        await ctx.navigate(fixture, { settle: 1200 });
        // 宿主用 body[data-ds-dark-theme] 切亮暗（不是 prefers-color-scheme）
        await ctx.evaluate(theme === 'dark'
          ? `document.body.setAttribute('data-ds-dark-theme', '')`
          : `document.body.removeAttribute('data-ds-dark-theme')`);
        await ctx.sleep(200);

        const rows = [];
        const measure = async (where, extra = []) => {
          const targets = contrastTargets(where, viewport.key).concat(extra);
          const part = await ctx.evaluate(CONTRAST_PROBE + '(' + JSON.stringify(targets) + ')');
          for (const one of part) rows.push(Object.assign({ face: where }, one));
        };
        await measure('home');
        await ctx.evaluate(OPEN_SUBJECT);
        await ctx.sleep(300);
        await measure('subject');
        await ctx.evaluate(OPEN_LESSON);
        await ctx.sleep(400);
        // 左栏与右栏都拉开：四个面里最挤的那一屏也要量到（窄档下左栏会被让掉，取样点已按档裁过）
        await ctx.evaluate(`document.querySelector('[data-proto="toggle-left"]').click()`);
        await ctx.sleep(200);
        await ctx.evaluate(`document.querySelector('[data-proto="toggle-quiz"]').click()`);
        await ctx.sleep(400);
        await measure('lesson', viewport.key === 'tight' ? DRAWER_CONTRAST : []);
        // 搜索覆盖层盖在课件页上：它是覆盖层，取样时不用离开当前这一面
        await ctx.evaluate(OPEN_PALETTE);
        await ctx.sleep(200);
        await ctx.evaluate(typeSearch('变量'));
        await ctx.sleep(400);
        await measure('search');

        const themeTag = `[${theme}·${viewport.key}]`;
        const missing = rows.filter((one) => one.missing);
        check(`${themeTag} 探针命中四个面的所有取样点`, missing.length === 0,
          missing.map((one) => `${one.face}·${one.name}`).join('；'));
        const low = rows.filter((one) => !one.missing && one.ratio < 4.5);
        check(`${themeTag} 四个面渲染出来的文字对比度都达 AA（≥ 4.5:1）`, low.length === 0,
          low.map((one) => `${one.face}·${one.name} ${one.ratio}:1（${one.color} on ${one.bg}）`).join('；'));
        console.log('      ' + rows.filter((one) => !one.missing)
          .map((one) => `${one.face}·${one.name}=${one.ratio}`).join('  '));
        return { theme, viewport: viewport.key, size: [viewport.width, viewport.height], rows };
      });
    }
  }

  /* ── 三栏几何：从宽到窄扫几档（#88） ─────────────────────────────────
     这一场回答的是**代数题**（「任何画布宽度下都有栏打得开」在 `test_client_panes.mjs`
     里已经证了），这里要的是真浏览器里那一层：控件在不在、点得动点不动、正文列还剩多少。
     每一档都重开一次夹具（换 CSS 视口 + 重新加载），因为夹具的 ResizeObserver 垫片只在
     observe 时报一次真实尺寸——场景中途改视口，客户端量到的还是旧画布。

     扫的几档围着那条门槛（窄轨 76 + 中栏保底 420 + 右栏最小 280 = 776）摆：
     776 之上并排、之下只能是抽屉。判断口径不钉像素，断的是「有没有出路」与「中栏有没有
     被挤破保底」这两件事。 */
  await session.scene('reading-routes-panes', async (ctx) => {
    const SWEEP = [1440, 1100, 900, 776, 700];
    const rows = [];
    for (const width of SWEEP) {
      await useViewport({ key: 'sweep', width, height: 900 });
      await ctx.navigate(fixture, { settle: 1200 });
      await ctx.evaluate(OPEN_SUBJECT);
      await ctx.sleep(250);
      await ctx.evaluate(OPEN_LESSON);
      await ctx.sleep(350);
      const closed = await ctx.evaluate(LESSON_PROBE);
      await ctx.evaluate(`document.querySelector('[data-proto="toggle-quiz"]').click()`);
      await ctx.sleep(300);
      const quiz = await ctx.evaluate(LESSON_PROBE);
      await ctx.evaluate(`document.querySelector('[data-proto="toggle-left"]').click()`);
      await ctx.sleep(300);
      const nodes = await ctx.evaluate(LESSON_PROBE);
      // 让步绝不回写：这一屏算出来的栏宽与「记住的栏宽」是两件事，后者只该是默认值
      const stored = await ctx.evaluate(`window.localStorage.getItem('studymate.panes.v1')`);
      rows.push({ width, closed, quiz, nodes, stored });

      const at = `[${width}px]`;
      // 一、点「题目」必须有反应：并排的栏，或者盖在正文上的抽屉（带说明与收起）
      const quizOk = quiz.modes.right === 'column'
        ? !!quiz.rightBox && quiz.rightBox.w >= 280
        : quiz.modes.right === 'drawer' && !!quiz.drawer && quiz.drawer.side === 'right'
          && /窗口太窄/.test(quiz.drawer.note) && quiz.drawer.close && quiz.drawer.box.w > 0;
      check(`${at} 点「题目」有反应（并排，或者盖在正文上并说明为什么）`, quizOk,
        `形态=${quiz.modes && quiz.modes.right} 抽屉=${JSON.stringify(quiz.drawer)} 右栏=${JSON.stringify(quiz.rightBox)}`);
      check(`${at} 题目真的做得成（题干在、选项是能点的按钮）`,
        quiz.questions >= 1 && quiz.optionTags.length >= 3 && quiz.optionTags.every((one) => one === 'BUTTON'),
        `questions=${quiz.questions} options=${JSON.stringify(quiz.optionTags)}`);
      // 二、点「节点」也必须有反应——「两栏都打不开」的宽度区间不存在
      const nodesOk = nodes.modes.left === 'column'
        ? !!nodes.leftBox && nodes.leftBox.w >= 200
        : nodes.modes.left === 'drawer' && !!nodes.drawer && nodes.drawer.side === 'left'
          && /窗口太窄/.test(nodes.drawer.note) && nodes.drawer.close;
      check(`${at} 点「节点」有反应（并排，或者盖在正文上并说明为什么）`, nodesOk && nodes.nodeCards >= 3,
        `形态=${nodes.modes && nodes.modes.left} 节点 ${nodes.nodeCards} 个 抽屉=${JSON.stringify(nodes.drawer)}`);
      // 三、中栏保底：画布够宽时正文列不许被两条栏挤到保底以下
      const floor = Math.min(MIN_CENTER, quiz.frame - quiz.railBars);
      check(`${at} 中栏在保底之上（画布够宽时就是 420）`,
        !!quiz.centerBox && quiz.centerBox.w >= floor - 1 && !!quiz.docBox && quiz.docBox.w >= 300,
        `中栏 ${quiz.centerBox && quiz.centerBox.w}px（保底 ${floor}）正文列 ${quiz.docBox && quiz.docBox.w}px`);
      check(`${at} 正文列没越过中栏（不出横向滚动条）`,
        !!quiz.docBox && !!quiz.centerBox && quiz.docBox.x >= quiz.centerBox.x - 1
        && quiz.docBox.x + quiz.docBox.w <= quiz.centerBox.x + quiz.centerBox.w + 1,
        `正文列 ${JSON.stringify(quiz.docBox)} 中栏 ${JSON.stringify(quiz.centerBox)}`);
      // 五、让步（收起 / 降级）绝不回写记忆值：这一屏怎么挤，记住的还是默认那两条
      check(`${at} 让步没有回写记忆值（画布变窄只影响这一屏，变宽要能自动恢复）`,
        stored === STORED_PANES, `localStorage 里是 ${stored}`);
    }

    const widest = rows[0];
    const tightest = rows[rows.length - 1];
    // 四、宽画布上正文列占得住、又没填满窗口（测宽服务于可读行宽，不是把窗口铺满）
    check('[1440px] 宽画布上正文列占得住中栏（≥ 六成），但没填满窗口',
      !!widest.closed.docBox && !!widest.closed.centerBox
      && widest.closed.docBox.w >= widest.closed.centerBox.w * 0.6
      && widest.closed.docBox.w <= widest.closed.centerBox.w - 100,
      `正文列 ${widest.closed.docBox && widest.closed.docBox.w} 中栏 ${widest.closed.centerBox && widest.closed.centerBox.w}`);
    // 五、形态随画布走：宽的一头并排，窄的一头抽屉（阈值两侧各取一档）
    check('[776px / 700px] 门槛两侧形态不同：够宽并排、不够宽盖在正文上',
      rows.find((one) => one.width === 776).quiz.modes.right === 'column'
      && rows.find((one) => one.width === 700).quiz.modes.right === 'drawer',
      JSON.stringify(rows.map((one) => one.width + ':' + one.quiz.modes.right)));
    check('[700px] 紧档下正文仍读得下去（正文列 ≥ 300px，抽屉给正文留了缝）',
      !!tightest.quiz.docBox && tightest.quiz.docBox.w >= 300
      && !!tightest.quiz.drawer && tightest.quiz.drawer.box.w < tightest.quiz.centerBox.w,
      `正文列 ${tightest.quiz.docBox && tightest.quiz.docBox.w} 抽屉 ${JSON.stringify(tightest.quiz.drawer)}`);

    await useViewport(VIEWPORTS[0]);
    await ctx.navigate(fixture, { settle: 800 });   // 这一场只为扫描，别留一张空白页
    return {
      widths: SWEEP,
      rows: rows.map((one) => ({
        width: one.width, frame: one.closed.frame, rails: one.closed.railBars,
        closed: { center: one.closed.centerBox && one.closed.centerBox.w, doc: one.closed.docBox && one.closed.docBox.w },
        quiz: { mode: one.quiz.modes.right, right: one.quiz.rightBox && one.quiz.rightBox.w, drawer: one.quiz.drawer && one.quiz.drawer.box.w, center: one.quiz.centerBox && one.quiz.centerBox.w, doc: one.quiz.docBox && one.quiz.docBox.w },
        nodes: { mode: one.nodes.modes.left, left: one.nodes.leftBox && one.nodes.leftBox.w, drawer: one.nodes.drawer && one.nodes.drawer.box.w, cards: one.nodes.nodeCards },
      })),
    };
  });

  /* ── 宽画布上的正文列：默认形态（两条栏都收起） ────────────────────────
     #88 的第一条验收是「宽画布上正文列占得住面板可用宽的合理比例」——这是**默认**形态
     （学生打开课件看到的就是它），而面三那张截图里右栏是开着的，替不了这一张。
     断的仍然是关系：占得住（≥ 六成），又没填满窗口（两侧留白各 > 100px）。 */
  await session.scene('reading-routes-wide-doc', async (ctx) => {
    await useViewport(VIEWPORTS[0]);
    await ctx.navigate(fixture, { settle: 1200 });
    await ctx.evaluate(OPEN_SUBJECT);
    await ctx.sleep(250);
    await ctx.evaluate(OPEN_LESSON);
    await ctx.sleep(350);
    const seen = await ctx.evaluate(LESSON_PROBE);
    const share = seen.docBox && seen.centerBox ? seen.docBox.w / seen.centerBox.w : 0;
    check('[1440px·默认] 宽画布上正文列占得住中栏（≥ 六成）', share >= 0.6,
      `正文列 ${seen.docBox && seen.docBox.w} 中栏 ${seen.centerBox && seen.centerBox.w} = ${Math.round(share * 100)}%`);
    check('[1440px·默认] 测宽服务于可读行宽，不是填满窗口（两侧留白各 > 100px）',
      !!seen.docBox && !!seen.centerBox && seen.centerBox.w - seen.docBox.w > 200,
      `正文列 ${seen.docBox && seen.docBox.w} 中栏 ${seen.centerBox && seen.centerBox.w}`);
    return {
      viewport: 'wide', size: [seen.width, VIEWPORTS[0].height],
      panes: seen.panes, modes: seen.modes, frame: seen.frame,
      centerWidth: seen.centerBox && seen.centerBox.w, docWidth: seen.docBox && seen.docBox.w,
      shareOfCenter: Math.round(share * 100) / 100,
      marginEachSide: seen.docBox && seen.centerBox ? Math.round((seen.centerBox.w - seen.docBox.w) / 2) : null,
    };
  });

  /* ── 三档对账：窄档的读数必须真的与宽档不同；三档的栏形态各就各位 ───────
     这一条是「窄档不是把宽档截个图」的机器判据：`@media` 规则的实测读数在宽档下与
     窄档下必须不同，且窄档那边是规则声明的那一侧。

     三档之间再对一次**三栏几何**（#88）：课件页右栏的形态要和画布档位一致（并排 / 抽屉），
     把手要落在栏的内侧边缘上（窄轨宽只有 CSS 一处定义，脚本量出来再用），正文列要占得住
     中栏——这三样都是「换个视口就变」的事，只有跨档比才看得出来。

     #90 把三条**死声明**修活之后，这里从「只记不判」升成断言：`lib/client.js` 原来把
     `@media (max-width: 900px)` 拆成两块写在被覆盖的基础规则**前面**（.smb-wrap /
     .smb-crumb / .smb-continue__bar 的定义之前），同特异度下后写的赢——于是「正文列
     内边距压小」「面包屑上限收窄」「接着上次的进度条占满一行」窄档下量到的与宽档一模一样。
     现在它们在窄档真的落到计算样式与几何上；再被谁挪回前面去，下面这两条会红。
     断的仍是**关系**（宽窄两档必须不同、窄档那边是规则说的那一侧），不是具体像素值。 */
  await session.scene('reading-routes-compare', async (ctx) => {
    const wide = layoutByViewport.wide;
    const narrow = layoutByViewport.narrow;

    /* 三栏几何的三档对账先跑：它不依赖下面那两块响应式读数 */
    const lessons = VIEWPORTS.map((one) => ({ viewport: one.key, seen: lessonByViewport[one.key] }));
    check('三档的课件页几何读数都取到了', lessons.every((one) => !!one.seen),
      JSON.stringify(lessons.map((one) => one.viewport + ':' + !!one.seen)));
    const wrongMode = lessons.filter((one) => !one.seen || one.seen.modes.right !== PANE_MODES[one.viewport]);
    check('三档的右栏形态与画布一致（该并排就并排、装不下就盖在正文上）', wrongMode.length === 0,
      wrongMode.map((one) => `${one.viewport}：${one.seen && one.seen.modes.right}（该是 ${PANE_MODES[one.viewport]}）`).join('；'));
    // 把手落点 = 窄轨 + 这一栏的宽（抽屉也算这一栏）。脚本里若自己写死一份窄轨宽，这里就对不上
    const misaligned = lessons.filter((one) => one.seen && (!one.seen.handle
      || Math.abs(one.seen.handle.dx - (one.seen.frame - one.seen.railBarWidth - one.seen.handle.pane)) > 1));
    check('三档下把手都贴在栏的内侧边缘上（窄轨宽是量出来的，不是脚本里写死的）', misaligned.length === 0,
      misaligned.map((one) => `${one.viewport}：${JSON.stringify(one.seen.handle)} 画布 ${one.seen.frame} 窄轨 ${one.seen.railBarWidth}`).join('；'));
    check('三档下正文列都占得住中栏（铺满也算，但绝不是正中一条细条）',
      lessons.every((one) => one.seen && one.seen.docShareOfCenter !== null && one.seen.docShareOfCenter >= 0.6),
      lessons.map((one) => `${one.viewport}:${one.seen && one.seen.docShareOfCenter}`).join(' '));
    // 窄轨宽的唯一出处是 CSS 的 --smb-rail：渲染出来的两条窄轨加起来正好是它的两倍
    check('两条窄轨加起来 = CSS 的 --smb-rail × 2（唯一那处定义真的在驱动几何）',
      lessons.every((one) => one.seen && parseFloat(one.seen.railToken) * 2 === one.seen.railBarWidth),
      lessons.map((one) => `${one.viewport}:${one.seen && one.seen.railBarWidth} vs ${one.seen && one.seen.railToken}`).join(' '));

    /* 右栏题库那五条（#93）在三档下的对账：这一条要证的是**形态无关**——宽档窄档是并排的一栏，
       紧档是盖在正文上的抽屉，而「题型徽标贴字、当前组看得见、上次作答在、只纵向滚」在两种
       形态下都得成立。三档都取到读数 + 三档的读数都过那批关系，才算成立。 */
    const quizReadings = VIEWPORTS.map((one) => ({ viewport: one.key, seen: quizByViewport[one.key] }));
    check('三档的右栏题库读数都取到了（并排与抽屉都取到了）',
      quizReadings.every((one) => !!one.seen), JSON.stringify(quizReadings.map((one) => one.viewport + ':' + !!one.seen)));
    check('三档的右栏形态确实两种都有（并排 + 抽屉：不是三档都跑在同一种形态上）',
      new Set(quizReadings.filter((one) => one.seen).map((one) => one.seen.mode)).size >= 2,
      JSON.stringify(quizReadings.map((one) => one.viewport + ':' + (one.seen && one.seen.mode))));
    check('三档下右栏都没有横向溢出（长题干与长选项都折在栏里）',
      quizReadings.every((one) => one.seen && one.seen.pane.innerOverflowX <= 0),
      quizReadings.map((one) => `${one.viewport}:${one.seen && one.seen.pane.innerOverflowX}`).join(' '));
    check('三档下长题干与长选项都没被裁掉（右边缘都在裁切线以内）',
      quizReadings.every((one) => one.seen.overflow.overhangs.length === 3
        && one.seen.overflow.overhangs.every((value) => value !== null && value <= 1)),
      JSON.stringify(quizReadings.map((one) => [one.viewport, one.seen && one.seen.overflow.overhangs])));
    check('三档下题型徽标都还是贴字的（高不过两倍字号，也都不是竖条）',
      quizReadings.every((one) => one.seen && one.seen.badges.length === 3
        && one.seen.badges.every((badge) => badge.box.h <= badge.fontSize * 2 && badge.box.w > badge.box.h)),
      JSON.stringify(quizReadings.map((one) => [one.viewport, one.seen && one.seen.badges.map((b) => [b.box.w, b.box.h])])));
    check('三档下点过的标记都落在同一个组号上，且那一组是唯一的「当前」',
      quizReadings.every((one) => one.seen && one.seen.clickedGroup === '2'
        && one.seen.groups.filter((group) => group.current === 'true').length === 1
        && one.seen.groups.filter((group) => group.current === 'true')[0].no === '2'),
      JSON.stringify(quizReadings.map((one) => [one.viewport, one.seen && one.seen.clickedGroup,
        one.seen && one.seen.groups.map((group) => group.no + ':' + group.current)])));
    // 三档的右栏宽度确实不同（抽屉那一档与并排的宽算法不同）——顺带证明三档不是同一张截图
    check('三档的右栏可见宽确实不同（紧档的抽屉不是宽档那一栏的截图）',
      new Set(quizReadings.filter((one) => one.seen).map((one) => one.seen.pane.clientWidth)).size >= 2,
      JSON.stringify(quizReadings.map((one) => one.viewport + ':' + (one.seen && one.seen.pane.clientWidth))));

    if (wide && narrow) {
      const declarations = [
        ['壳·.smb-wrap 的内边距', (one) => one.wrapPaddingLeft],
        ['壳·.smb-crumb 的宽度上限', (one) => one.crumbMaxWidth],
        ['壳·.smb-continue__bar 里进度条占满一行', (one) => one.continueProgressWidth],
        ['壳·.smb-topbar 允许换行', (one) => one.topbarWrap],
        ['壳·.smb-continue__bar 允许换行', (one) => one.continueBarWrap],
        ['科目行·.smb-course 允许换行', (one) => one.courseWrap],
      ];
      const differing = declarations.filter(([, read]) => read(wide) !== read(narrow));
      const inert = declarations.filter(([, read]) => read(wide) === read(narrow));

      check('壳那条规则真的执行了（顶栏与「接着上次」那一行在窄档允许换行）',
        wide.topbarWrap === 'nowrap' && narrow.topbarWrap === 'wrap'
        && wide.continueBarWrap === 'nowrap' && narrow.continueBarWrap === 'wrap',
        `wide=${wide.topbarWrap}/${wide.continueBarWrap} narrow=${narrow.topbarWrap}/${narrow.continueBarWrap}`);
      check('科目行那条规则真的执行了（换行，且右半截换到自己一行、占满一整行）',
        wide.courseWrap === 'nowrap' && narrow.courseWrap === 'wrap'
        && narrow.courseSide.y >= narrow.courseMain.y + narrow.courseMain.h - 1
        && wide.courseSide.y < wide.courseMain.y + wide.courseMain.h
        && narrow.courseSide.w >= narrow.courseMain.w && wide.courseSide.w < wide.courseMain.w,
        `wide=${JSON.stringify(wide)} narrow=${JSON.stringify(narrow)}`);
      check('两条规则的实测读数在宽窄两档确实不同（窄档不是宽档的截图）',
        differing.length >= 3, `不同的只有 ${differing.length} 条：${JSON.stringify(differing.map(([name]) => name))}`);
      // #90：原来那三条「死声明」必须真的落在窄档上——内边距与面包屑上限都往小走，
      // 进度条不再钉死宽档那 180px，而是占满自己那一行（宽档：钉死、比行窄）
      const px = (value) => parseFloat(String(value)) || 0;
      check('壳那三条声明都真的生效了（内边距 / 面包屑上限收窄，进度条改成占满一行）',
        px(narrow.wrapPaddingLeft) < px(wide.wrapPaddingLeft)
        && px(narrow.crumbMaxWidth) < px(wide.crumbMaxWidth)
        && !!narrow.continueProgressBox && !!narrow.continueBarBox
        && narrow.continueProgressBox.w >= narrow.continueBarBox.w - 1
        && narrow.continueProgressBox.w > px(wide.continueProgressWidth)
        && (wide.continueProgressBox ? wide.continueProgressBox.w < wide.continueBarBox.w : false),
        `wrap=${wide.wrapPaddingLeft}→${narrow.wrapPaddingLeft} crumb=${wide.crumbMaxWidth}→${narrow.crumbMaxWidth} `
        + `bar=${JSON.stringify(narrow.continueProgressBox)}/${JSON.stringify(narrow.continueBarBox)} `
        + `wideBar=${JSON.stringify(wide.continueProgressBox)}/${JSON.stringify(wide.continueBarBox)}`);
      check('没有「窄档下量到与宽档一模一样」的响应式声明了（死声明清零）',
        inert.length === 0, inert.map(([name]) => name).join('；'));

      await ctx.navigate(fixture, { settle: 800 });   // 这一场只为对账，别留一张空白页
      return {
        wide, narrow,
        panes: lessons.map((one) => ({
          viewport: one.viewport, mode: one.seen && one.seen.modes.right,
          center: one.seen && one.seen.centerWidth, doc: one.seen && one.seen.docWidth,
          docShareOfCenter: one.seen && one.seen.docShareOfCenter,
          railBarWidth: one.seen && one.seen.railBarWidth, railToken: one.seen && one.seen.railToken,
          handle: one.seen && one.seen.handle,
        })),
        differing: differing.map(([name]) => name),
        inertDeclarations: inert.map(([name]) => name),
        quiz: quizReadings.map((one) => ({
          viewport: one.viewport, mode: one.seen && one.seen.mode,
          paneWidth: one.seen && one.seen.pane.clientWidth, paneOverflowX: one.seen && one.seen.pane.innerOverflowX,
          badges: one.seen && one.seen.badges.map((badge) => ({ text: badge.text, w: badge.box.w, h: badge.box.h })),
          current: one.seen && one.seen.groups.map((group) => group.no + ':' + group.current),
          clickedGroup: one.seen && one.seen.clickedGroup,
        })),
      };
    }
    await ctx.navigate(fixture, { settle: 800 });
    return {
      wide, narrow,
      panes: lessons.map((one) => ({ viewport: one.viewport, mode: one.seen && one.seen.modes.right })),
      quiz: quizReadings.map((one) => ({ viewport: one.viewport, mode: one.seen && one.seen.mode })),
    };
  });

  /* ── 空目录 / 半份数据（#90 的空态验收面） ─────────────────────────────
     这一组不是「四个面」的取景，而是同一批面的**退化输入**：一个可用科目都没有的工作区、
     有大纲但课件与附件都没写的半份科目、以及一份连节点都没有的 payload。三者要求的都是
     「给得出『还没有』这句话」——空白与错误卡都算不达标。

     为什么第三种要手造 payload：`lib/library.ts` 会把零节点的科目整个跳过，所以这种科目
     到不了页面上（那是建课建到一半的正常中间态）。这里量的是**渲染器自己的兜底**：
     真喂给它一份零节点的科目，它也不该画出一张只有图例的空地图。 */

  await useViewport(VIEWPORTS[0]);   // 这三场与档位无关，固定用宽档取景

  await session.scene('reading-routes-blank-workspace', async (ctx) => {
    const blank = makeEmptyWorkspace();
    await ctx.navigate(buildFixture(blank.root, blank.payload, 'blank-fixture.html'), { settle: 1000 });
    const seen = await ctx.evaluate(`(() => {
      const empty = document.querySelector('.smb-empty');
      const text = empty ? empty.textContent.trim() : '';
      return {
        text,
        workspaceShown: text.includes(${JSON.stringify(blank.workspace)}),
        errorCard: /读不到学习工作区/.test(document.body.innerText),
        retry: Array.from(document.querySelectorAll('button')).some((el) => el.textContent.trim() === '重试'),
        root: !!document.querySelector('.smb-root'),
      };
    })()`);
    check('空目录的工作区给的是「还没有科目」，不是空白也不是错误卡',
      seen.root && /还没有科目/.test(seen.text) && !seen.errorCard && !seen.retry,
      JSON.stringify(seen));
    check('空态里说清了读的是哪个工作区（学生照着能去建课）', seen.workspaceShown, String(seen.text));
    return { viewport: 'wide', size: [VIEWPORTS[0].width, VIEWPORTS[0].height], ...seen };
  });

  await session.scene('reading-routes-half-data', async (ctx) => {
    const half = makeHalfWorkspace();
    await ctx.navigate(buildFixture(half.root, half.payload, 'half-fixture.html'), { settle: 1000 });
    const home = await ctx.evaluate(HOME_PROBE);
    check('半份数据的主页：第一屏仍指得出去哪，并明说这一课还没有课件',
      home.continueSubject === '半份科目' && home.continueGo === '还没有课件' && !!home.continueTitle,
      JSON.stringify({ subject: home.continueSubject, node: home.continueTitle, go: home.continueGo }));
    await ctx.evaluate(OPEN_SUBJECT);
    await ctx.sleep(400);
    const subject = await ctx.evaluate(SUBJECT_PROBE);
    const body = String(subject.bodyText);
    check('半份数据的科目主页：路线图卡片在，每张都写明「无课件」',
      subject.nodeCards === 2 && (body.match(/无课件/g) || []).length === 2, `cards=${subject.nodeCards}`);
    check('半份数据的科目主页：参考资料那一块给的是「还没有」，不是空白',
      /还没有参考资料/.test(body), JSON.stringify(body).slice(-140));
    check('半份数据的科目主页不空白、不报错',
      !/读不到学习工作区/.test(body) && body.trim().length > 40 && subject.overflowX <= 0,
      `overflowX=${subject.overflowX} ` + JSON.stringify(body).slice(0, 120));
    return {
      viewport: 'wide', size: [VIEWPORTS[0].width, VIEWPORTS[0].height],
      home: { subject: home.continueSubject, node: home.continueTitle, go: home.continueGo },
      nodeCards: subject.nodeCards, blocks: subject.blocks, bodyText: body.slice(0, 200),
    };
  });

  await session.scene('reading-routes-no-nodes', async (ctx) => {
    const half = makeHalfWorkspace();
    // 大纲清空的那一份：零节点科目今天到不了页面（Host 半会跳过），这里直接喂给渲染器
    const payload = JSON.parse(JSON.stringify(half.payload));
    payload.subjects[0] = Object.assign({}, payload.subjects[0], {
      nodes: [], edges: [], stats: {}, order: {}, continue_node: '', levels: 0,
    });
    await ctx.navigate(buildFixture(half.root, payload, 'no-nodes-fixture.html'), { settle: 1000 });
    const home = await ctx.evaluate(HOME_PROBE);
    check('零节点科目的主页：那张卡说得出「还没有节点」，而不是留一张空白卡',
      /还没有节点/.test(String(home.continueEmpty)), JSON.stringify(home.continueEmpty));
    await ctx.evaluate(OPEN_SUBJECT);
    await ctx.sleep(400);
    const subject = await ctx.evaluate(SUBJECT_PROBE);
    check('零节点科目的路线图给的是「还没有节点」这句话，不是一张只有图例的空地图',
      /还没有节点/.test(String(subject.bodyText)) && subject.mapLevels === 0,
      JSON.stringify(subject.bodyText).slice(0, 160));
    return {
      viewport: 'wide', size: [VIEWPORTS[0].width, VIEWPORTS[0].height],
      homeEmpty: home.continueEmpty, bodyText: String(subject.bodyText).slice(0, 200),
    };
  });

  /* ── 动效四档 + 跟随系统偏好 ─────────────────────────────────────────── */
  await session.scene('reading-routes-motion', async (ctx) => {
    await ctx.navigate(fixture, { settle: 1200 });
    const read = `(() => {
      const root = document.querySelector('.smb-root');
      const picker = document.querySelector('.smb-select');
      return {
        attr: root.getAttribute('data-motion'),
        token: getComputedStyle(root).getPropertyValue('--smb-motion').trim(),
        stored: window.localStorage.getItem('studymate.motion.v1'),
        options: Array.from(picker.options).map((one) => one.value),
      };
    })()`;
    const pickLevel = async (level) => {
      await ctx.evaluate(`(() => {
        const select = document.querySelector('.smb-select');
        select.value = '${level}';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await ctx.sleep(200);
      return ctx.evaluate(read);
    };
    const ms = (token) => parseFloat(String(token)) * (/ms\s*$/.test(String(token)) ? 1 : 1000);

    const seen = { auto: await ctx.evaluate(read) };
    check('[动效] 四档齐全',
      JSON.stringify(seen.auto.options) === JSON.stringify(['auto', 'full', 'reduced', 'off']),
      JSON.stringify(seen.auto.options));
    for (const level of ['full', 'reduced', 'off']) seen[level] = await pickLevel(level);
    check('[动效] 四档都写到了 data-motion 上',
      ['full', 'reduced', 'off'].every((one) => seen[one].attr === one), JSON.stringify(seen));
    check('[动效] 时长随档位单调变短、off 真的关掉、auto 默认取全动效',
      ms(seen.full.token) > ms(seen.reduced.token) && ms(seen.off.token) === 0
      && ms(seen.auto.token) === ms(seen.full.token),
      JSON.stringify([seen.auto.token, seen.full.token, seen.reduced.token, seen.off.token]));
    check('[动效] 显式档位记在浏览器本地偏好里', seen.full.stored === 'full', String(seen.full.stored));

    // 系统说「减少动效」：auto 档要落到 reduced 那一档的时长；显式档位不受影响
    await pickLevel('auto');
    await session.emulate({ reducedMotion: 'reduce' });
    const bySystem = await ctx.evaluate(read);
    check('[动效] prefers-reduced-motion: reduce 时 auto 档落到 reduced 的时长',
      ms(bySystem.token) === ms(seen.reduced.token) && ms(bySystem.token) < ms(seen.full.token),
      `auto+reduce=${bySystem.token} reduced=${seen.reduced.token}`);
    const forced = await pickLevel('full');
    check('[动效] 显式的 full 档不被系统偏好改写', ms(forced.token) === ms(seen.full.token),
      `full+reduce=${forced.token}`);
    await session.emulate({});        // 还原系统偏好，别漏给后面的场景
    await ctx.evaluate(`window.localStorage.removeItem('studymate.motion.v1')`);
    return {
      tokens: { auto: seen.auto.token, full: seen.full.token, reduced: seen.reduced.token, off: seen.off.token },
      bySystem: bySystem.token, forcedFull: forced.token, options: seen.auto.options,
    };
  });
} catch (error) {
  check('阅读端四路由套件跑完（浏览器起来、夹具能开）', false, String(error));
  await session.scene('reading-routes-error', async (ctx) => { ctx.note('harness', String(error)); });
}

console.log(failures ? `\n${failures} 条失败` : '\n全部通过');
await finishSuite(session, { suite: 'reading-routes', failed: failures });
for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
