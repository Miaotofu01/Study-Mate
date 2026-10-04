// Adapt the exported Antigravity plugin without modifying source DSH skills,
// which remain the single authority for teaching content, evidence rules, and file ownership.
import {
  AGY_HOST_GUIDE,
  AGY_BOOTSTRAP,
  AGY_INTAKE,
  AGY_DIALOGUE,
  AGY_RECORD_CONTINUITY,
  AGY_ROLE_BOUNDARY,
  AGY_PROTOCOL_BOUNDARY,
} from './antigravity-interaction.mjs';
import { getOpenAiSkillDescription } from './openai-skill-ui.mjs';

// Antigravity 的 agent frontmatter 里写错工具名会让子代理卡住（官方子代理文档的已知问题），
// 所以这里只放官方文档点名的工具；`invoke_subagent` 是官方子代理文档点名的派工工具（嵌套上限 10 层），
// `write_to_file`、`search_web`、`read_url_content` 尚未在文档里逐个核对过，
// 改动宿主版本或新增工具时按宿主实际工具名复核这一张表。
export const AGENT_TOOLS = {
  'resource-scout': ['view_file', 'write_to_file', 'search_web', 'read_url_content', 'invoke_subagent'],
  'image-scout': ['view_file', 'write_to_file', 'search_web', 'read_url_content', 'run_command', 'invoke_subagent'],
  'curriculum-designer': ['view_file', 'write_to_file', 'run_command', 'invoke_subagent'],
  'learning-coach': ['view_file', 'write_to_file', 'run_command', 'invoke_subagent', 'read_url_content'],
  'practice-evaluator': ['view_file', 'write_to_file', 'run_command', 'invoke_subagent'],
};

export const AGENT_ROLES = [
  'resource-scout',
  'image-scout',
  'curriculum-designer',
  'learning-coach',
  'practice-evaluator',
];

// 「角色 × 工具 → 一句用途」：列哪些工具由 AGENT_TOOLS 决定，这里只写用途。
// 两边集合必须逐个相等——缺一条用途、或多写一条，模块加载就报错（见下方 assertToolNotes）。
const ROLE_TOOL_NOTES = {
  'resource-scout': [
    { tools: ['view_file'], note: '读取已有的 `subject_path`、`RESOURCES.md` 模板与术语表。' },
    { tools: ['search_web'], note: '检索权威教科书、高校公开课大纲（MIT OCW / Stanford / CMU / 清华）、官方文档（Python / C++ / PyTorch / Linux 等）。' },
    { tools: ['read_url_content'], note: '抓取官方文档与标准页面，提取目录与关键技术版本说明。' },
    { tools: ['write_to_file'], note: '将产出的清单写入暂存目录 `<subject_path>/.stage/resource-scout-<slug>/deliver/RESOURCES.md`。' },
    { tools: ['invoke_subagent'], note: '派一次性子 agent 把本地教材／讲义转成 markdown（规格第 0 步写明的例外，只派这一次转换活；派完别轮询，自己先并行做检索）。' },
  ],
  'image-scout': [
    { tools: ['view_file'], note: '读取科目资源清单 `RESOURCES.md`、术语表 `GLOSSARY.md` 与已有索引。' },
    { tools: ['search_web', 'read_url_content'], note: '在允许的官方站点内下钻查找图解（限制 2 跳之内）。' },
    { tools: ['run_command'], note: '下载图片到「图片库」，并校验图片头与尺寸（宿主允许的命令行工具即可）。' },
    { tools: ['write_to_file'], note: '图片与索引**写盘即交付**：图落「图片库」、索引落「图片库索引」，不写暂存目录、不写别处。' },
    { tools: ['invoke_subagent'], note: '角色默认不派子 agent；规格写明要派的才派，一次派完、不占自己的上下文。' },
  ],
  'curriculum-designer': [
    { tools: ['view_file'], note: '读取资源清单 `RESOURCES.md`、输入背景、科目使命 `MISSION.md` 与 schema 规范。' },
    { tools: ['write_to_file'], note: '编写课程大纲暂存文件 `<subject_path>/.stage/curriculum-designer-<slug>/deliver/curriculum.yaml`。' },
    { tools: ['run_command'], note: '执行大纲拓扑校验器 `python3 -B \'<root>/scripts/check_curriculum.py\'`。' },
    { tools: ['invoke_subagent'], note: '规格写明本角色不派子 agent——要别的角色（补收集、出题、采图）写进报告由总控派。' },
  ],
  'learning-coach': [
    { tools: ['view_file'], note: '读取课程大纲 `curriculum.yaml`、前置节点摘要、术语表 `GLOSSARY.md`、图片库索引 `pool.md` 与模版。' },
    { tools: ['write_to_file'], note: '编写课件 Markdown 内容文件 `<subject_path>/.stage/learning-coach-<node_id>/deliver/lessons/<NNNN>-<node_id>.md`。' },
    { tools: ['run_command'], note: '执行课件静态预检 `python3 -B \'<root>/scripts/render_lesson.py\' \'<subject_path>\' \'<node_id>\' --check`。' },
    { tools: ['invoke_subagent'], note: '角色默认不派子 agent；来源读不到写进报告由总控补收集，自己不派。' },
    { tools: ['read_url_content'], note: '来源没在本地落盘时打开原址读原文（`reference/` 与 `sources/` 里已落盘的直接 view_file 读，不用联网）。' },
  ],
  'practice-evaluator': [
    { tools: ['view_file'], note: '读取课程大纲 `curriculum.yaml`、课件内容 Markdown、`quiz.js` 规范与 `assessment.schema.json`。' },
    { tools: ['write_to_file'], note: '编写练习题库 `<subject_path>/.stage/practice-evaluator-<node_id>/deliver/lessons/<NNNN>-<node_id>.quiz.json`、Lab 任务文件及评估记录。' },
    { tools: ['run_command'], note: '在沙箱中执行单元测试断言、代码运行与验证脚本。' },
    { tools: ['invoke_subagent'], note: '角色默认不派子 agent；规格写明要派的才派，一次派完、不占自己的上下文。' },
  ],
};

function toolGuide(role) {
  const lines = (ROLE_TOOL_NOTES[role] || []).map(({ tools, note }) =>
    `- ${tools.map(tool => `\`${tool}\``).join(' & ')}: ${note}`);
  return `## 工具使用指南\n${lines.join('\n')}`;
}

// 加载期就校验：工具表与用途说明的集合必须逐个相等，模板必须留着占位符。
// 漏一条、多一条、或谁把占位符写丢了，import 这个模块的构建与测试会立刻红。
function assertToolNotes() {
  for (const role of AGENT_ROLES) {
    const granted = [...(AGENT_TOOLS[role] || [])].sort();
    const noted = (ROLE_TOOL_NOTES[role] || []).flatMap(entry => entry.tools).sort();
    if (granted.join(',') !== noted.join(',')) {
      throw new Error(`Antigravity 工具表与用途说明不一致（${role}）：表 [${granted}] vs 说明 [${noted}]`);
    }
    if (!ROLE_PROMPTS[role].includes('{{TOOL_GUIDE}}')) {
      throw new Error(`Antigravity 角色提示里没有 {{TOOL_GUIDE}} 占位（${role}）`);
    }
  }
}

const AGENT_DISPLAY_NAMES = {
  'resource-scout': 'StudyMate · 资料收集角色',
  'image-scout': 'StudyMate · 采图角色',
  'curriculum-designer': 'StudyMate · 课程设计角色',
  'learning-coach': 'StudyMate · 课件讲解角色',
  'practice-evaluator': 'StudyMate · 出题与评估角色',
};

const ROLE_PROMPTS = {
  'resource-scout': `## 角色定位与核心职责
你是 StudyMate 的专业资料收集子代理（Resource Scout）。由学习总控（主教练）通过 \`invoke_subagent\` 派发。
你的核心职责是为新开或调整科目收集权威教材、官方文档和高公信力行业标准，整理资源清单与依据缺口（Gaps）。你直接向父智能体汇报，没有面向用户的交互通道，不直接向用户提问。

{{TOOL_GUIDE}}

## 资料收集准则与分级
1. **信源分级**：
   - 第一梯队（权威）：公认经典教科书（如 CLRS、SICP、CSAPP、Boyd 凸优化、Bishop PRML）、语言与框架官方文档、RFC/W3C/ISO 标准、顶尖高校课程主页。
   - 过滤梯队（严禁采纳）：低质博客聚合站（CSDN、知乎低赞、博客园、简书）、AI 批量生成的垃圾站、缺乏版本标注的技术短文。
2. **停止条件**：满足以下三条立刻收手，不堆砌冗余条目：
   - 节点顺序与深度都有权威教材或大纲作为依据。
   - 易变内容（库版本、API 签名、部署与配置）都有官方文档核对来源。
   - 找不到权威来源的领域如实列入 \`## Gaps\`。
3. **交付格式**：
   - 严格按 \`<root>/templates/RESOURCES.md\` 结构书写。
   - 每条资源必须包含：\`title\`、\`type\`、\`url\` 以及一行具体的用途说明。
   - 正文汇报：输出已收集条数、各类别数量、\`## Gaps\` 列表及写盘路径。`,

  'image-scout': `## 角色定位与核心职责
你是 StudyMate 的专业采图子代理（Image Scout）。由学习总控通过 \`invoke_subagent\` 派发。
你的核心职责是严格沿着「资源清单」中的权威文档与公开站点，抓取课件所需的清晰位图（架构图、数据流图、内存布局图等），编排规范的图片库索引。你直接向父智能体汇报，不直接与用户交互。

{{TOOL_GUIDE}}

## 采图与编排准则
1. **站点与预算限制**：
   - 仅在资源清单点名的站点及总控允许的站点内查找，最多两跳。
   - 每站预算：访问页面 ≤8 个，下载图片 ≤6 张，低频串行（≤1 req/sec），尊重 robots 协议。
2. **图片严格过滤**：
   - 宽度 <400px、单张 >500KB 的直接舍弃。
   - 严禁抓取 logo、图标、头像、UI 按钮、纯装饰图与广告水印图。
   - 仅抓取网页中的实际位图（jpg/png/webp/gif），不抓 PDF。
3. **可检索命名规范**（硬性机器校验）：
   - 格式：\`<主题>-<子主题>-<要点>-<来源缩写>-<NN>.<ext>\`。
   - 主题词必须严格与 \`GLOSSARY.md\` 术语表一致，只使用 \`[0-9A-Za-z\\u4e00-\\u9fa5-]\`，无空格，长度 ≤60。
4. **七列表头索引（\`pool.md\`）**：
   - \`| 文件 | 主题标签 | 一句话说明 | 来源 URL | 许可 | 尺寸 | 抓取日期 |\`
5. **交付前自检**：
   - 运行 \`python3 -B '<root>/scripts/check_pool.py' '<subject_path>'\`，确保退出码为 0，无任何报错后方可交付。`,

  'curriculum-designer': `## 角色定位与核心职责
你是 StudyMate 的专业课程架构子代理（Curriculum Designer）。由学习总控通过 \`invoke_subagent\` 派发。
你的核心职责是根据学习目标、前置基础与资源清单，构建具备严谨依赖关系的有向无环图（DAG），制定标准课程大纲（\`curriculum.yaml\`）并插桩项目实验课节点。你直接向父智能体汇报，不直接与用户交互。

{{TOOL_GUIDE}}

## 课程设计核心准则
1. **认知切分与单元粒度**：
   - 每个节点粒度按“40分钟能够完成的一个独立学习单元”划分。
   - 首个节点必须为“绪论”：采用具体真实场景或经典悬念开场（如费曼讲义从微观分子运动破题），严禁枯燥的定义堆砌与学科通史罗列。
2. **节点的三种类型（\`kind\`）**：
   - \`概念\`：核心理论与概念模型，以讲为主，不配 Lab。
   - \`实操\`：理论与动手结合，讲练并重，配套轻量实验任务与代码。
   - \`实验\`：项目里程碑验收课，以练为主，必须在 \`prerequisites\` 中验收至少一个前面学过的实操节点。
   - 课型只决定**产不产 lab 材料**：题的深度由节点 \`objective\` 决定，不由课型定上限。
3. **大纲字段规范（对齐 \`curriculum.schema.json\`）**：
   - \`title\`: ≤16 字，教材风格命名。
   - \`objective\`: ≤34 字，一句话、可观察的行为目标。
   - \`problem\`: 场景钩子，说明用哪个真实问题引入。
   - \`practice\`: 动手方向与侧重（明确写出 \`以讲为主\`、\`以练为主\` 或 \`讲练并重\`）。
   - \`resources\`: 对应教材章节或核对过的官方文档链接。
   - 特殊 YAML 语法：以 \`&\` 或 \`*\` 开头的列表项必须加引号（如 \`["& 取地址", "* 解引用"]\`）。
4. **三条贯穿线索**：
   - 目标线索：每个节点清楚定位其与学生最终目标的关系。
   - 项目线索：主线项目贯穿全程，从早期节点就开始提供实践素材。
   - 工具/对照线索：手写底层逻辑与标准现成库的对照实验。
5. **交付前自检**：
   - 运行 \`python3 -B '<root>/scripts/check_curriculum.py' '<curriculum.yaml>'\`。
   - 确保无环、无孤儿节点、实验课前置依赖全部存在且通过验证。`,

  'learning-coach': `## 角色定位与核心职责
你是 StudyMate 的专业课件主讲子代理（Learning Coach）。由学习总控通过 \`invoke_subagent\` 派发。
你的核心职责是将大纲节点撰写为教材级深度的 Markdown 课件内容文件（\`lessons/<NNNN>-<node_id>.md\`），留下精确的题目与练习锚点。你负责讲清知识、设计直观图解、留出题目位置，但不直接出题、不编写 Lab。你直接向父智能体汇报，不直接与用户交互。

{{TOOL_GUIDE}}

## 课件编写核心准则
1. **文笔与着眼点（\`lesson-design\`）**：
   - 遵循经典教材的文笔（严谨、清晰、具象），杜绝口语化水词与冗余套话。
   - 术语遵循“先来历后定义”：先交代真实痛点与历史背景，再给出形式化定义；术语与 \`GLOSSARY.md\` 逐字保持一致。
2. **结构化提示块与数学排版**：
   - 使用标准提示卡：\`::: tip\`（技巧）、\`::: warn\`（易错坑）、\`::: note\`（补充说明）。
   - 数学公式一律使用标准 LaTeX：行内 \`$formula$\`、块级 \`$$formula$$\`，方程组必须使用大括号包裹（\`\\begin{cases} ... \\end{cases}\`）。正文中的美元符号写 \`\\$\`。
3. **技术图解与 SVG**：
   - 结构图、流程图优先使用内联 \`::: svg\`，必须设置 \`viewBox\`，字号比例满足最小字体 ÷ viewBox宽 ≥ 2%，禁止写死容器像素宽度。
   - 引用图片库位图时使用 \`::: figure\`，必须包含 \`alt:\` 与单句 \`caption:\`，图片来源与许可由渲染器自动根据索引注入，不要手动写“图 1”。
4. **题目与练习锚点（核心职责分工）**：
   - 严禁在课件中手写题目与答案！题目唯一归 \`practice-evaluator\` 负责。
   - 在需要测验处写：\`::: quiz <层级> 锚点：<锚点文本>\`（层级写 读懂／改对／查错／造出）。
   - 在动手练习段落写：\`::: practice <阶段> | <标题>\`。每个块必须以独立的 \`:::\` 收尾。
5. **交付前自检**：
   - 运行 \`python3 -B '<root>/scripts/render_lesson.py' '<subject_path>' '<node_id>' --check\`。
   - 此时题库相关报错为预期（因尚未出题），其余语法、标签、结构必须 100% PASS。`,

  'practice-evaluator': `## 角色定位与核心职责
你是 StudyMate 的题目与实操评估子代理（Practice & Evaluation Specialist）。由学习总控通过 \`invoke_subagent\` 派发。
你是全系统所有题目、Lab 任务与测试断言的**唯一 Owner**。你负责根据课件锚点设计四层练习，为实操课与实验课构建整套 Lab 代码环境，并在**实验课验收**时依据可运行证据严谨判定（普通节点不做第三方验收）。你直接向父智能体汇报，不直接与用户交互。

{{TOOL_GUIDE}}

## 出题与评估核心准则
1. **四层练习架构（\`layered-practice\`）**：
   - 读懂：核心概念辨析，客观题或极简阐述，必须配有清晰的 \`why\` 与判分要点 \`criteria\`。
   - 改对：在已有正确代码/结构上完成参数调整、逻辑微调或填空，**先写下预测再跑起来验证**。
   - 查错：给出包含经典 Bug 或逻辑漏洞的代码片段，要求定位根因、给出修复与预防。
   - 造出：端到端项目任务或完整模块开发，交付物要能跑通并说清取舍。
2. **课件练习题库规范（\`quiz.json\`）**：
   - 顶层 Key 必须与课件 Markdown 中的 \`::: quiz\` 锚点文本**完全逐字一致**。
   - 题目数据结构符合 \`quiz.js\` 契约；若某个锚点经过权衡无需出题，必须交回 \`empty_reason: <理由>\`。
3. **实操与实验课 Lab 配套**：
   - \`kind: 实操\`：提供完整 \`lab/\` 目录结构（\`README.md\`、初始留白代码、自动化单元测试/断言入口、\`solutions/\` 参考答案）。
   - \`kind: 实验\`：编写实验说明页正文（\`lessons/<NNNN>-<node_id>.md\`）与综合验收任务，说明页包含“做出什么、怎么算过、自查清单、踩坑预警”。
4. **证据核验原则（\`evidence-check\`）**：
   - 判定必须以实际运行结果、单元测试通过输出或明确的代码逻辑证据为准，口头声称一律不作为独立通过证据。
   - 验收结论写进「学习记录」（由总控落盘）；\`assessments/\` 不再产生新文件——模型输出不能直接改进度状态。`,
};

function splitFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: '', body: content };
  return { frontmatter: match[1], body: match[2] };
}

function replaceRequired(text, pattern, replacement, name) {
  if (!pattern.test(text)) throw new Error(`Antigravity skill adaptation error: ${name}`);
  return text.replace(pattern, replacement);
}

// 源技能里的 `studymate_*` 是本插件在 DSH 里的原生工具（#68），Antigravity 没有它们：
// 导出时逐名翻译成等价的引擎命令，调用面不留悬空引用。命令故意写成
// `python3 -B <root>/scripts/x.py`（脚本路径不带引号），下面那段通用的 python 规整
// 才认得出来、会把它变成 `python3 -B '<root>/scripts/x.py' …`。
// 新增原生工具时这里加一行——scripts/tests/test_skill_contracts.mjs 会检查覆盖率。
export const NATIVE_TOOL_FALLBACK = {
  studymate_workspace_context: '读工作区配置、.learning/MEMORY.md、当前科目的 progress.yaml 与最近的学习记录',
  studymate_validate_pool: "python3 -B <root>/scripts/check_pool.py '<subject_path>'",
  studymate_validate_curriculum: "python3 -B <root>/scripts/check_curriculum.py '<curriculum.yaml>'",
  studymate_validate_lesson: "python3 -B <root>/scripts/render_lesson.py '<subject_path>' '<节点id>' --check",
  studymate_validate_handoff: "python3 -B <root>/scripts/check_handoff.py '<stage_dir>' --role '<角色>'",
  studymate_renumber_lessons: "python3 -B <root>/scripts/renumber_lessons.py '<subject_path>'",
  studymate_apply_empty_reasons: "python3 -B <root>/scripts/apply_empty_reasons.py '<subject_path>' '<节点id>' '<tsv>'",
};

// Host-neutral rewrites shared by adapted skills and generated agents: the same DSH text
// must not be normalized in one place and left raw in the other.
function applyCommonRewrites(text) {
  // 原生工具名先落到本宿主的等价命令，再走下面的 python 规整（顺序不能反：规整只认
  // 脚本路径不带引号的写法）。两个适配器各存一份，源技能不写引擎命令。
  let result = text;
  for (const [tool, fallback] of Object.entries(NATIVE_TOOL_FALLBACK)) {
    result = result.replaceAll(tool, fallback);
  }
  result = result
    .replaceAll('/tmp', '<STUDYMATE_SCRATCH>')
    .replaceAll('`ask_user_question`', '`ask_question`')
    .replaceAll('（`read` 那个文件）', '（用 `view_file` 查看那个文件）')
    .replaceAll('`cp -r`', '目录复制')
    .replaceAll('`cp`', '原样复制')
    .replaceAll('→ cp 落', '→ 原样复制落')
    .replaceAll('你 cp 搬入', '你原样复制搬入')
    .replaceAll('`grep`', '搜索工具')
    .replaceAll('(offset/limit/grep)', '（分段读取/文本搜索）')
    .replaceAll('（offset/limit/grep）', '（分段读取/文本搜索）')
    .replaceAll('`./run_tests.sh`', '当前系统可运行的测试入口');

  // Python command normalization: ensure python3 -B with quoted paths
  result = result.replace(
    /python3 ((?:-[A-Za-z]+\s+)*)(<root>\/scripts\/[\w-]+\.py)([^`\n]*)/g,
    (_, flags, script, args) => {
      const explicitArgs = script.endsWith('/gen_home.py') && !args.trim() ? " '<LEARN_WORKSPACE>'" : args;
      const cleanFlags = flags.includes('-B') ? flags : `-B ${flags}`;
      return `python3 ${cleanFlags}'${script}'${explicitArgs.replace(/<[^>]+>/g, value => `'${value}'`)}`;
    }
  );

  // Normalize duplicate quotes
  return result.replaceAll("''<", "'<").replaceAll(">''", ">'");
}

function adaptAntigravityController(body) {
  let result = replaceRequired(
    body,
    /^0\. \*\*定位工作区与引擎\*\*：[^\n]+/m,
    AGY_BOOTSTRAP,
    'learning-system bootstrap'
  );

  result = replaceRequired(
    result,
    /^1\. \*\*加载 `record-keeping` 并读状态\*\*[^\n]+/m,
    '1. **加载协议并恢复记忆**：按本技能开头的「Antigravity 宿主约定」加载调度与交互协议，并读 `record-keeping`；结合 `<LEARN_WORKSPACE>/.learning/MEMORY.md`、当前活跃科目进度表与最近的学习记录恢复学习断点。优先处理本次消息中的回答或续学意图。',
    'controller recovery'
  );

  // 总控现在把机械步骤交给原生工具（DSH）；无头宿主没有工具，这两条开头的自述要换成
  // 「按宿主约定的降级表跑脚本」，否则导出稿会让学生读到一句本宿主做不到的话。
  result = replaceRequired(
    result,
    /^- \*\*会话可以在任意目录启动\*\*[^\n]+/m,
    '- **会话可以在任意目录启动**：学习数据全在配置好的学习工作区里，按「Antigravity 宿主约定」选定并记作 `<LEARN_WORKSPACE>`，不在会话目录里另建临时工作区。',
    'controller workspace bullet'
  );

  result = replaceRequired(
    result,
    /^- \*\*机械步骤归工具\*\*[^\n]+/m,
    '- **机械步骤归宿主命令**：本宿主没有原生工具，按「Antigravity 宿主约定」的降级表用文件读写与 `<root>/scripts/` 下的脚本完成校验与改写；拿到的是逐条问题与结论，不看退出码、不比对摘要。',
    'controller mechanics bullet'
  );

  result = replaceRequired(
    result,
    /^2\. \*\*没有科目\*\*[^\n]+/m,
    '2. **没有科目**：吸收本次消息已给出的目标、基础与偏好，调用 `ask_question` 进行增量盘问；回答当轮保存，不把全部决策堆成冗长文字。',
    'initial intake'
  );

  result = replaceRequired(
    result,
    /^3\. \*\*已有科目\*\*[^\n]+/m,
    '3. **已有科目**：用户点名或只有一个活跃科目时直接恢复当前节点与材料；多个科目且无法判断意图时调用 `ask_question` 给一次单选卡片。用户要开新科目时保留旧数据，进入增量盘问。',
    'subject recovery'
  );

  result = replaceRequired(
    result,
    /^5\. \*\*报告 \+ 给下一步[^\n]+/m,
    '5. **简短衔接并执行**：简要说明恢复位置或新课程轮廓；用户已确认开始时直接推进对应步骤，用户只要大纲时交付大纲。展示根主页 `<LEARN_WORKSPACE>/index.html` 的可点击超链接，供浏览器直接打开。',
    'opening handoff'
  );

  result = replaceRequired(
    result,
    /## 新科目盘问[^\n]*\n[\s\S]*?(?=## 对话节奏)/,
    `${AGY_INTAKE}\n`,
    'learning-system intake'
  );

  result = replaceRequired(
    result,
    /## 对话节奏[^\n]*\n[\s\S]*?(?=## 学习循环)/,
    `${AGY_DIALOGUE}\n`,
    'learning-system dialogue'
  );

  result = replaceRequired(
    result,
    /## 会话结束\r?\n[\s\S]*?(?=## 子 agent 派发规范)/,
    '## 会话结束\n\n学生明确暂停/结束或当前学习单元已完成时执行收尾：\n1. 按 `record-keeping` 更新学习进度、误解记录与学习记录（有可观察证据才写），把当前科目、节点、阶段与下一步存进交互断点。\n2. 输出已保存位置与下次恢复点。不追加挽留弹窗。\n\n',
    'Antigravity session end'
  );

  result = replaceRequired(
    result,
    /^1\. 学生同意学当前节点[^\n]+/m,
    '1. 学生明确选择当前节点或已说开始/继续 → 直接进入当前节点并将状态置为“学习中”；先检查已生成材料，只补未完成步骤，不重复确认。',
    'node start'
  );

  result = replaceRequired(
    result,
    /^9\. 问学生继续下一个节点还是结束[^\n]*/m,
    '9. 更新交互断点。学生已明确继续时推进对应下一步；只报告“学完了”而未选择后续时，给一次“下一课 / 补练 / 暂停”选择。',
    'node boundary'
  );

  result = replaceRequired(
    result,
    /   4\. 派 `curriculum-designer` 产大纲[^\n]*/,
    '   4. 接收已派发的 `curriculum-designer` 大纲产物并执行校验；不重复派发同一大纲任务。采图缺失按 Gaps 处理，不阻塞可用大纲。',
    'curriculum handoff'
  );

  result = replaceRequired(
    result,
    /  1\. \*\*角色规格的绝对路径\*\*：[^\n]+/,
    '  1. **委派原生子代理**：通过 `invoke_subagent` 派发对应角色（TypeName 见 `<root>/agents/<角色名>.md`），Prompt 传清 `subject_path`、`<root>`、节点 ID 与暂存路径；派发后停止调用工具等待系统异步唤醒，禁止 sleep 轮询。',
    'role specification loading'
  );

  result = replaceRequired(
    result,
    /- \*\*角色一律用全新上下文[^\n]+/,
    '- **多智能体异步调度**：子代理在独立后台上下文中执行，互不干扰；资源清单产出后，采图与大纲设计通过 `invoke_subagent` 数组并发派发；课件制作时保持讲解到出题的串行依赖。',
    'delegation via invoke_subagent'
  );

  result = replaceRequired(
    result,
    /- \*\*角色不写 `<root>`\*\*：[^\n]+/,
    '- **插件根目录只读**：总控与子代理严禁向 `<root>` 或插件安装目录写临时脚本、数据或缓存。不需要留存的临时文件写 `<STUDYMATE_SCRATCH>`，交付物写各角色的 `deliver/` 暂存目录。',
    'plugin cache writes'
  );

  result = replaceRequired(
    result,
    /- \*\*验收不过就退回[^\n]+/,
    '- **验收不通过退回重试**：校验未通过时，将校验器原始报错信息作为 Prompt 重新派发原角色修复；总控不擅自代改专业角色的内部产物。',
    'role error retry'
  );


  result = replaceRequired(result, /直接进下一节点[^\n]*/,
    '按第 9 步衔接下一节点', 'next node handoff');
  result = replaceRequired(result, /→ 开始第一课（仍按「对话节奏」问"开始吗"）[^\n]*/,
    '→ 按用户已表达的范围继续第一课或交付大纲', 'parallel chain end');
  result = replaceRequired(result, /^4\. \*\*课件交给学生\*\*[^\n]+/m,
    '4. **课件交给学生**：在回复中输出课件的**绝对路径超链接**（`[打开课件](file://...)`），并可在 `<appDataDir>/brain/<conversation-id>/` 写入伴读 Artifact；按“Antigravity 对话衔接”交付当前材料与一个学生行动',
    'page delivery');
  result = replaceRequired(result, /^1\. \*\*你亲自确认\*\*[^\n]*/m,
    '1. **核对变更意图**：学生明确要求从 A 改成 B 就执行该范围变更；目标含糊或扩大范围时调用 `ask_question` 澄清一次',
    'mission change intent');
  result = replaceRequired(result, /\*\*建池与拟大纲并行\*\*[^\n]*/,
    '**建池与拟大纲并发派发**——「资源清单」落位后，通过 `invoke_subagent` 数组同时派发下面两个角色：', 'parallel pool + outline');

  result = result.replaceAll('~/.dsh/studymate-config.yaml', '宿主的全局工作区配置');
  result = result.replaceAll('<WS>', '<LEARN_WORKSPACE>');

  return `${AGY_HOST_GUIDE}\n${result}`;
}

// 数据都定义好之后再校验（放在 ROLE_PROMPTS 之后，避免 TDZ）。
assertToolNotes();

export function adaptAntigravitySkill(content, name) {
  content = content.replaceAll('\r\n', '\n');
  const { frontmatter, body } = splitFrontmatter(content);

  let adaptedBody = body.replaceAll('.dsh/skills/', 'skills/').replaceAll('.dsh/skills', 'skills');

  if (name === 'learning-system') {
    adaptedBody = adaptAntigravityController(adaptedBody);
  } else if (name === 'record-keeping') {
    // 工作区来源是 DSH 与无头宿主差异最大的一处：DSH 由 `studymate_workspace_context`
    // 回报配置里的工作区，这里换成 Antigravity 的选定顺序（用户指定 → 环境变量 → 默认
    // `~/StudyMate`）。**暂存模式已删**（ADR-0008），所以没有落点问答、没有偏好文件、
    // 也没有搬运——只在写不进去时问一次可写位置。
    adaptedBody = replaceRequired(
      adaptedBody,
      /^学习状态由你（主教练）亲自读写，不派角色。\*\*工作区根[^\n]*/m,
      '学习状态由你（主教练）亲自读写，不派角色。**工作区根**：按「Antigravity 宿主约定」选定 `<LEARN_WORKSPACE>`（用户本次指定目录 → 环境变量 → 默认 `~/StudyMate`）；学习数据全在它下面，不另建临时工作区，也不在会话目录里找学习文件。',
      'record-keeping workspace root'
    );
    adaptedBody = replaceRequired(
      adaptedBody,
      /^- \*\*只在 `<LEARN_WORKSPACE>` 下写学习文件\*\*[^\n]*/m,
      '- **只在 `<LEARN_WORKSPACE>` 下写学习文件**，不写插件目录或工作区之外的目录；写不进去就跟学生说清缺的是哪一项可写位置，由他指定一个可写目录——**不要靠反复提权推进**',
      'DSH sandbox fallback'
    );
    adaptedBody = adaptedBody.replaceAll('~/.dsh/studymate-config.yaml', '宿主的全局工作区配置')
      .replaceAll('<WS>', '<LEARN_WORKSPACE>');
    adaptedBody = adaptedBody.replace('`goal` 先跟学生确认', '`goal` 以学生明确指令为准，有歧义才澄清');
    adaptedBody = adaptedBody.replace('`current` 变了先跟学生确认', '`current` 按学生明确选择更新，有歧义才澄清');
    adaptedBody += `\n\n${AGY_RECORD_CONTINUITY}`;
  }

  // Common replacements across skills
  adaptedBody = applyCommonRewrites(adaptedBody);

  // Clean and normalize frontmatter so all 12 skills are fully recognized by Antigravity host
  let description = frontmatter.match(/^description:[ \t]*(.+)$/m)?.[1]?.trim() || '';
  if (description.startsWith('"')) description = JSON.parse(description);
  else if (description.startsWith("'") && description.endsWith("'")) {
    description = description.slice(1, -1).replaceAll("''", "'");
  }
  description = getOpenAiSkillDescription(name, description);
  const cleanFrontmatter = `name: ${name}\ndescription: ${JSON.stringify(description)}`;

  if (name === 'learning-system') {
    return `---\n${cleanFrontmatter}\n---\n\n${adaptedBody}\n`;
  }

  const boundary = AGENT_ROLES.includes(name) ? AGY_ROLE_BOUNDARY : AGY_PROTOCOL_BOUNDARY;
  return `---\n${cleanFrontmatter}\n---\n\n${boundary}\n\n${adaptedBody}\n`;
}

export function adaptAntigravityAgent(skillContent, name) {
  skillContent = skillContent.replaceAll('\r\n', '\n');
  const { body } = splitFrontmatter(skillContent);
  const tools = AGENT_TOOLS[name] || ['view_file', 'write_to_file', 'run_command'];
  const displayName = AGENT_DISPLAY_NAMES[name] || `StudyMate · ${name}`;
  // 角色描述的唯一出处是技能元数据（openai-skill-ui 的 skills 表）——与技能描述同一份，别再抄一遍。
  const description = getOpenAiSkillDescription(name, `StudyMate ${name} 角色`);
  const rolePrompt = (ROLE_PROMPTS[name] || '').replace('{{TOOL_GUIDE}}', toolGuide(name));

  const yamlTools = tools.map(t => `  - ${t}`).join('\n');
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    'tools:',
    yamlTools,
    'mainAgent: false',
    'subagent: true',
    'commandExecutionPolicy: auto',
    '---',
  ].join('\n');

  let cleanBody = body.replaceAll('.dsh/skills/', 'skills/').replaceAll('.dsh/skills', 'skills');
  cleanBody = applyCommonRewrites(cleanBody);

  const instructions = `# ${displayName} (Google Antigravity Subagent)

${rolePrompt}

## 宿主执行规范
- **插件根目录定位与只读原则**：根目录记为 \`<root>\`，包含 \`skills/\`、\`agents/\`、\`scripts/\`、\`templates/\`、\`schemas/\`。插件目录属于只读静态资产，严禁在 \`<root>\` 下写临时脚本、数据、测试文件或编译缓存。
- **规范与 Schema 查阅**：查阅规范协议使用 \`view_file\` 查阅 \`<root>/skills/<规范名>/SKILL.md\`；查验数据结构查阅 \`<root>/schemas/<名称>.schema.json\`。
- **脚本执行与命令规范**：运行 Python 脚本必须执行 \`python3 -B '<root>/scripts/<脚本名>.py' ...\`（带 \`-B\` 阻止生成 \`__pycache__\`）。所有路径参数必须使用绝对路径并正确加单引号。
- **隔离暂存与交付路径**：产物必须写入 \`<subject_path>/.stage/${name}-<节点id>/deliver/<相对路径>\`，内部层级与正式科目目录一一对应，严禁直接向正式科目目录写文件。
- **质量防线与交稿自检**：交付前必须在沙箱中完成对应机器自检（如 \`check_pool.py\`、\`check_curriculum.py\`、\`render_lesson.py --check\`、代码单元测试），确保退出码为 0、报错清零后方可交付。
- **交互边界与汇报清单**：作为专业子代理在后台独立运行，无面向用户的交互通道，不向用户提问，不调用 \`ask_question\`。任务完成后直接向父智能体汇报交付清单（相对路径 + 一句话内容）、关键决策判断与自检结论，由总控负责校验与合并搬移。

---

## 详细工作流与规范

${cleanBody}`;

  return `${frontmatter}\n\n${instructions}\n`;
}
