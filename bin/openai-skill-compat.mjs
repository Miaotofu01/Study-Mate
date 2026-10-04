// Adapt the exported plugin without changing the DSH skills, which remain the
// authority for teaching content and file ownership.
import { INTAKE, DIALOGUE, RECORD_CONTINUITY, ROLE_BOUNDARY, PROTOCOL_BOUNDARY } from './openai-interaction.mjs';
import { getOpenAiSkillDescription } from './openai-skill-ui.mjs';

const HOST_GUIDE = `## OpenAI 宿主约定（导出时生成）

- **引擎定位**：本文件位于 \`<root>/skills/<技能名>/SKILL.md\`；从实际文件路径定位包含 \`skills/\`、\`scripts/\`、\`templates/\`、\`schemas/\`、\`docs/\` 的插件根目录，记为 \`<root>\`。引擎与插件缓存只读，学习数据写入另一个可写工作区。所有相对的脚本、模板、schema、文档路径均相对 \`<root>\`；参考文档中的旧宿主安装说明不参与本插件启动。
- **加载协议**：正文说“加载某技能”时，用宿主文件读取工具读 \`<root>/skills/<技能名>/SKILL.md\`；不需要专门的技能调用工具。缺少文件读取能力时说明具体缺项，不声称已加载。所有角色的教学职责与文件归属保持不变。
- **原生工具（DSH 专属）在本宿主不存在**：DSH 侧的 \`studymate_\` 系列工具（契约见 \`<root>/skills/learning-system/references/tools.md\`）在这里**一个都调不到**——正文里点名它们的地方，导出时已经换成下面的等价做法（用文件读写与 \`<root>/scripts/\` 下的脚本完成同一件事）。缺的能力如实说明，**不要假装调用过工具**。
- **工作区**：总控传入的 \`<LEARN_WORKSPACE>\` 与 \`subject_path\` 必须是实际绝对路径；新会话按总控的“会话开场”恢复。不要把插件目录、缓存或未知的当前目录当作学习数据目录。角色不另选工作区。
- **工具能力**：只使用宿主实际提供的提问、浏览、文件读写、图片查看、命令执行、委派与预览工具。提问工具不可用时总控用普通对话提问；角色把待问事项交给总控。检索不可用时记录未核验来源与 Gaps，不编造核验结果；图片不可取得时允许空图片库。文件或执行工具不可用时可以继续讨论，但具体生成、持久化与校验必须如实标为未完成。
- **角色执行**：总控阶段的调度动作由总控执行（角色自己能派什么由各自规格决定，规格没写就不派）。有委派工具时按总控规范分工；没有委派工具时由总控按角色规格串行执行，每段读取对应规格，以“准备讲解/核对练习”等工作内容报告进度，完成产物与检查后才切回总控。不得假称启动了子 agent；串行执行仍保留正文→出题→原样搬运→渲染的顺序、题目唯一 owner 与档案归属，不能用总控身份随手改角色产物。
- **暂存位置**：产物交接与 DSH 侧同一套约定——角色按最终相对路径写 \`<subject_path>/.stage/<角色>-<节点id或slug>/deliver/\`，总控过交接门禁后原样搬入、搬完清掉这一轮。不需要留存的中间文件写本会话的 \`<STUDYMATE_SCRATCH>\`；不同会话、不同角色不共享固定草稿目录，也不要假定任何操作系统的临时目录路径。
- **Python 与命令**：先探测 Python 3.9+、PyYAML（\`yaml\`）与 JSON Schema 校验器（\`jsonschema\`）可用；\`<python>\` 表示已验证的解释器调用，可为 \`python3\`、\`python\`、\`py -3\` 或绝对路径；后续调用加 \`-X utf8\`。PowerShell 调用带引号的可执行文件路径要加 \`&\`；路径参数使用宿主 shell 的字面值引用与转义（PowerShell 单引号内的单引号写两次）。优先使用工具的参数数组，不能把路径或学生文本拼成未引用的命令。按当前操作系统选择可用的 lab 测试命令。依赖缺失由总控在获准的可写环境内处理，角色不建环境，插件缓存内不装依赖。
- **逐次显式传参**：调用主页生成器始终传 \`'<LEARN_WORKSPACE>'\`；各命令都传脚本与数据的绝对路径。环境变量、工作目录与 shell 状态不保证跨工具调用保留，确需设置时在每次调用内设置。跨会话只信实际存在的文件，不能以聊天记忆替代磁盘恢复。
- **原样搬运**：用宿主文件复制工具，或 Python 标准库 \`shutil.copy2\`（文件）、\`shutil.copytree(..., dirs_exist_ok=True)\`（目录合并）完成；保留 \`deliver/\` 中相对路径，不经模型重写题面、答案与长产物。Windows 可用 PowerShell 的 \`Copy-Item -LiteralPath\`；不要依赖别的平台的复制、摘要或打开页面命令。
- **展示与持续保存**：页面写盘并校验后用宿主可用的文件预览/浏览器展示，同时给可点击的绝对文件链接；沙箱文件使用宿主支持的下载/附件链接。无预览能力时仍交付文件链接与位置。ChatGPT Work 或其他临时沙箱中，先核实文件是否能跨会话保留；不确定就明确说明，并在结束时交付包含 \`index.html\` 与完整 \`.learning/\`（含隐藏目录）的可下载归档，下一次从用户提供的归档恢复，不承诺本机目录或沙箱会永久保留。
`;

const BOOTSTRAP = `0. **定位工作区与引擎**：按“OpenAI 宿主约定”从本技能文件定位 \`<root>\`。学习工作区按以下顺序选定并记为 \`<LEARN_WORKSPACE>\`：用户本次明确指定的目录 → 非空环境变量 \`STUDYMATE_WORKSPACE\` → 非空 \`LEARN_WORKSPACE\` → 用户显式设置的 \`STUDYMATE_CONFIG\` 配置中的 \`workspace\` → 当前任务/项目中已有的学习工作区（含 \`.learning/\`，或用户提供的已恢复学习档案）。配置的 \`root\` 不覆盖本插件根目录；配置不存在或无效时报告具体问题，不悄悄改用别处的数据。只有用户明确要求复用旧 DSH 工作区时才读取其指定的旧配置；没有 DSH 配置不影响启动。
   - **首次初始化**：已有明确的工作区路径时直接在该目录初始化；尚未选定时，在当前宿主已授权的可写项目/数据目录中建 \`StudyMate/\` 并设为工作区（已有同名目录先检查并复用，避免覆盖）。路径不得位于插件根目录或插件缓存。若宿主没有给出可写位置，只询问保存位置，其他学习目标盘问可以继续。在选定的工作区创建 \`.learning/subjects/\`，仅在缺失时从 \`<root>/templates/MEMORY.md\` 复制为 \`.learning/MEMORY.md\`；保留已有科目与记忆。向学生说明实际保存位置。
   - **执行准备**：探测上述 Python 与依赖，分配本会话的 \`<STUDYMATE_SCRATCH>\`；调用生成器与校验器必须使用实际绝对路径。检查当前宿主的持久化能力；临时沙箱遵守“展示与持续保存”。不要求安装其他聊天宿主或运行旧安装脚本。`;

function replaceRequired(text, pattern, replacement, name) {
  if (!pattern.test(text)) throw new Error(`OpenAI skill adaptation needs updating: ${name}`);
  return text.replace(pattern, replacement);
}

// 源技能里的 `studymate_*` 是本插件在 DSH 里的原生工具（#68），这个宿主没有它们：
// 导出时逐名翻译成等价的引擎命令，调用面不留悬空引用。命令故意写成
// `python3 -B <root>/scripts/x.py`（脚本路径不带引号），下面那段通用的 python 规整
// 才认得出来、会把它变成 `<python> -X utf8 -B '<root>/scripts/x.py' …`。
// 新增原生工具时这里加一行——scripts/tests/test_skill_contracts.mjs 会检查覆盖率。
/* 无头宿主（Codex / ChatGPT Work）没有原生工具：技能正文里的 `studymate_*` 在这里换成
   本宿主跑得动的等价做法。**有 1:1 脚本的落点必须写成「脚本路径不带引号」的
   `python3 -B <root>/scripts/x.py`**——下面的通用规整只认这种写法（带引号就静默跳过，
   导出件里会留下跑不动的命令），补解释器、`-X utf8` 与路径引号都归它。
   两个没有 1:1 脚本的工具如实写成本宿主的做法，不假装有一条命令。
   契约与人类可读的对照表在 `.dsh/skills/learning-system/references/tools.md` §8。 */
export const NATIVE_TOOL_FALLBACK = {
  studymate_workspace_context: '读工作区配置、.learning/MEMORY.md、当前科目的 progress.yaml 与最近的学习记录',
  studymate_validate_curriculum: "python3 -B <root>/scripts/check_curriculum.py '<curriculum.yaml>'",
  studymate_validate_lesson: "python3 -B <root>/scripts/render_lesson.py '<subject_path>' '<节点id>' --check",
  studymate_validate_pool: "python3 -B <root>/scripts/check_pool.py '<subject_path>'",
  studymate_validate_handoff: "python3 -B <root>/scripts/check_handoff.py '<stage_dir>' --role '<角色>'",
  studymate_renumber_lessons: "python3 -B <root>/scripts/renumber_lessons.py '<subject_path>'",
  studymate_apply_empty_reasons: "python3 -B <root>/scripts/apply_empty_reasons.py '<subject_path>' '<节点id>' '<tsv>'",
};

function adaptController(body) {
  let result = replaceRequired(body, /^0\. \*\*定位工作区与引擎\*\*：[^\n]+/m,
    BOOTSTRAP, 'learning-system bootstrap');
  // 总控现在把机械步骤交给原生工具（DSH）；无头宿主没有工具，这两条开头的自述要换成
  // 「按宿主约定的降级表跑脚本」，否则导出稿会让学生读到一句本宿主做不到的话。
  result = replaceRequired(result, /^- \*\*会话可以在任意目录启动\*\*[^\n]+/m,
    '- **会话可以在任意目录启动**：学习数据全在配置好的学习工作区里，按「OpenAI 宿主约定」选定并记作 `<LEARN_WORKSPACE>`，不在会话目录里另建临时工作区。',
    'controller workspace bullet');
  result = replaceRequired(result, /^- \*\*机械步骤归工具\*\*[^\n]+/m,
    '- **机械步骤归宿主命令**：本宿主没有原生工具，按「OpenAI 宿主约定」的降级表用文件读写与 `<root>/scripts/` 下的脚本完成校验与改写；拿到的是逐条问题与结论，不看退出码、不比对摘要。',
    'controller mechanics bullet');
  result = replaceRequired(result, /^1\. \*\*加载 `record-keeping` 并读状态\*\*[^\n]+/m,
    '1. **加载交互与档案协议并恢复**：先读本技能 `references/codex-interaction.md` 与 `record-keeping`；用 `<root>/scripts/interaction_state.py` 读取断点（首次无文件正常），结合共享记忆、学习进度与最近的学习记录恢复。先处理本次消息中的回答、纠正或续学意图，不能一律重跑开场菜单。', 'controller recovery');
  result = replaceRequired(result, /^2\. \*\*没有科目\*\*[^\n]+/m,
    '2. **没有科目**：吸收本次消息已给出的目标、基础与偏好，仅走下方增量盘问；回答当轮保存，不等建完科目才记。不先问一遍三件事再重复盘问。', 'initial intake');
  result = replaceRequired(result, /^3\. \*\*已有科目\*\*[^\n]+/m,
    '3. **已有科目**：用户点名或只有一个有效活跃科目时直接恢复到当前阶段、节点和已存在的材料；多个科目且无法判断意图才给一次选择。用户明确要新科目时保留旧数据，进入增量盘问。', 'subject recovery');
  result = replaceRequired(result, /^5\. \*\*报告 \+ 给下一步[^\n]+/m,
    '5. **简短衔接并执行**：用一两句说明恢复位置或新课程轮廓；用户已要求开始/继续时直接执行对应步骤，只要大纲时交付大纲。只有尚未决定的下一步才给一次选择，不重复问“开始吗”。展示根主页 `<LEARN_WORKSPACE>/index.html` 的可点击绝对路径，有文件预览工具时打开。', 'opening handoff');
  result = replaceRequired(result, /## 新科目盘问[^\n]*\n[\s\S]*?(?=## 对话节奏)/,
    `${INTAKE}\n`, 'Codex intake');
  result = replaceRequired(result, /## 对话节奏[^\n]*\n[\s\S]*?(?=## 学习循环)/,
    `${DIALOGUE}\n`, 'Codex dialogue');
  result = replaceRequired(result, /## 会话结束\n[\s\S]*?(?=## 子 agent 派发规范)/,
    '## 会话结束\n\n学生明确暂停/结束或当前请求已完成时才执行下面的收尾。等待异步回复时即使宿主必须交还控制，也只按交互协议保留 pending 并让出执行，不运行学习结束流程、不输出完成总结。\n\n1. 按 `record-keeping` 更新学习进度、误解记录与学习记录（有可观察证据才写），把当前科目、节点、阶段与下一步存进交互断点；显式结束时交互状态设为 paused 并清除待问项。\n2. 简短说明本次完成内容与续学位置。已有明确授权的偏好正常记录；需要学生确认的新长期观察先保留在断点里，下次相关时再确认，不为此追加弹窗。\n\n', 'Codex session end');
  result = replaceRequired(result, /^1\. 学生同意学当前节点[^\n]+/m,
    '1. 学生明确选择当前节点或已说开始/继续 → 直接进入当前节点并将状态置为“学习中”；先检查已生成材料与断点，只补未完成步骤，不重复确认或重新生成。', 'node start');
  result = replaceRequired(result, /^4\. \*\*课件交给学生\*\*[^\n]+/m,
    '4. **课件交给学生**：把渲染出的课件页与 lab 的绝对路径给成可点击的链接（有预览工具就打开），并按“Codex 对话衔接”交付当前材料与一个学生行动', 'page delivery');
  result = replaceRequired(result, /^9\. 问学生继续下一个节点还是结束[^\n]*/m,
    '9. 保存交互断点。学生已明确继续时推进对应下一步；只报告“学完了”而未选择后续时，给一次“下一课 / 补练 / 暂停”选择，不再叠加开始确认。', 'node boundary');
  result = replaceRequired(result, /直接进下一节点[^\n]*/,
    '按第 9 步衔接下一节点', 'next node handoff');
  result = replaceRequired(result, /→ 开始第一课（仍按「对话节奏」问"开始吗"）[^\n]*/,
    '→ 按用户已表达的范围继续第一课或交付大纲', 'parallel chain end');
  result = replaceRequired(result, /   4\. 派 `curriculum-designer` 产大纲[^\n]*/,
    '   4. 接收第 3 步已经派发的 `curriculum-designer` 大纲并校验；不再次派同一份大纲任务。采图缺失按 Gaps 处理，不让可选图片阻塞已可交付的课程', 'single curriculum handoff');
  result = replaceRequired(result, /^1\. \*\*你亲自确认\*\*[^\n]*/m,
    '1. **核对变更意图**：学生明确要求从 A 改成 B 就执行该范围的变更；只有目标含糊或会扩大范围时才澄清一次，不重复确认已经清楚的指令', 'mission change intent');
  result = replaceRequired(result,
    /  1\. \*\*角色规格的绝对路径\*\*：[^\n]+/,
    '  1. **角色规格的绝对路径**：`<root>/skills/<角色>/SKILL.md`，明说“先用文件读取工具读它、照它执行”；只有下游没有文件工具时才退回内联全文',
    'role specification loading');
  result = replaceRequired(result,
    /- \*\*角色一律用全新上下文[^\n]+/,
    '- **按宿主能力委派**：有委派工具时优先使用全新上下文，并传完整角色路径、值与边界；若宿主只能继承上下文，明确当前角色与任务边界，不让它沿用总控身份。没有委派工具时按“OpenAI 宿主约定”串行切换角色；原本可并行的采图与课设改为串行，其余依赖顺序不变，不要假定宿主预设会自动限制委派深度；角色的派工边界由各自规格决定（**规格没写就不派**），派工时把这条边界说明白。',
    'delegation fallback');
  result = replaceRequired(result,
    /- \*\*角色不写 `<root>`\*\*：[^\n]+/,
    '- **插件根目录只读**：总控与角色均不在 `<root>` 或插件缓存写临时脚本、数据或环境。派发时明确“临时脚本与中间产物写 `<STUDYMATE_SCRATCH>`；学习产物按角色归属写 `subject_path` 或暂存目录”。发现异常文件先报告，不自动删除或收编插件目录中的文件。',
    'plugin cache writes');
  result = replaceRequired(result, /\*\*建池与拟大纲并行\*\*[^\n]*/,
    '**建池与拟大纲可并行**——「资源清单」落位后，有委派工具时同时派下面两个；没有时按角色规格串行完成：', 'parallel pool + outline');
  result = result.replace(/- \*\*验收不过就退回[^\n]+/,
    '- **验收不过由产出角色自己改**：有角色消息/继续执行工具时，向原角色发送失败原文证据；串行模式切回同一角色规范修正。不要用总控身份代改；无法继续原子 agent 时，重新执行该角色并给原产物路径与失败证据。');
  return result;
}

/** Build a host-independent exported copy of one bundled DSH skill. */
export function adaptOpenAiSkill(content, name) {
  if (typeof content !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new TypeError('Expected skill content and a lowercase skill directory name');
  }
  const source = content.replaceAll('\r\n', '\n');
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!frontmatter) throw new Error(`Missing skill frontmatter: ${name}`);
  const sourceName = frontmatter[1].match(/^name:\s*(\S+)\s*$/m)?.[1];
  let description = frontmatter[1].match(/^description:[ \t]*(.+)$/m)?.[1]?.trim();
  if (sourceName !== name || !description) throw new Error(`Invalid skill metadata: ${name}`);
  if (description.startsWith('"')) description = JSON.parse(description);
  else if (description.startsWith("'") && description.endsWith("'")) {
    description = description.slice(1, -1).replaceAll("''", "'");
  }
  description = getOpenAiSkillDescription(name, description);

  let body = source.slice(frontmatter[0].length).trim();
  if (name === 'learning-system') body = adaptController(body);
  if (name === 'record-keeping') {
    // 工作区来源是 DSH 与无头宿主差异最大的一处：DSH 由 `studymate_workspace_context`
    // 回报配置里的工作区，这里换成「OpenAI 宿主约定」的选定顺序（用户指定 → 环境变量 →
    // 显式配置 → 既有学习数据）。**暂存模式已删**（ADR-0008），所以没有落点问答、
    // 没有偏好文件、也没有搬运——只在写不进去时问一次可写位置。
    body = replaceRequired(body,
      /^学习状态由你（主教练）亲自读写，不派角色。\*\*工作区根[^\n]*/m,
      '学习状态由你（主教练）亲自读写，不派角色。**工作区根**：按「OpenAI 宿主约定」选定 `<LEARN_WORKSPACE>`（用户本次指定目录 → 环境变量 → 显式配置 → 既有学习数据）；学习数据全在它下面，不在插件目录或会话目录里找学习文件，也不另建临时工作区。',
      'record-keeping workspace root');
    body = replaceRequired(body,
      /^- \*\*只在 `<LEARN_WORKSPACE>` 下写学习文件\*\*[^\n]*/m,
      '- **只在 `<LEARN_WORKSPACE>` 下写学习文件**，不写插件缓存或工作区之外的会话目录；插件目录只读。写不进去就只询问学生一个可写位置，并说明缺的是哪一项能力——**不要靠反复提权推进**',
      'record-keeping write fallback');
    body = body.replaceAll('~/.dsh/studymate-config.yaml', '宿主的全局工作区配置')
      .replaceAll('<WS>', '<LEARN_WORKSPACE>');
    body = replaceRequired(body, /^\s*- `current` 变了先跟学生确认[^\n]*/m,
      '`current` 按学生明确选择更新，有歧义才澄清', 'record-keeping project current');
    body += `\n\n${RECORD_CONTINUITY}`;
  }
  if (name === 'learning-system') {
    body = replaceRequired(body, /`goal` 先跟学生确认[^\n]*/,
      '`goal` 以学生明确指令为准，有歧义才澄清', 'controller goal confirmation');
    body = replaceRequired(body, /必须学生确认；旧使命留痕[^\n]*/,
      '按学生明确变更指令执行，歧义才澄清；旧使命留痕', 'mission change confirmation');
    // 本插件不读 DSH 的 studymate-config.yaml，工作区根一律记作 `<LEARN_WORKSPACE>`。
    body = body.replaceAll('~/.dsh/studymate-config.yaml', '宿主的全局工作区配置');
    body = body.replaceAll('<WS>', '<LEARN_WORKSPACE>');
  }
  // 原生工具名先落到本宿主的等价命令，再走下面那段通用的 python 规整（顺序不能反：
  // 规整只认脚本路径不带引号的写法）。
  for (const [tool, fallback] of Object.entries(NATIVE_TOOL_FALLBACK)) {
    body = body.replaceAll(tool, fallback);
  }
  body = body.replaceAll('.dsh/skills/', 'skills/')
    .replaceAll('/tmp', '<STUDYMATE_SCRATCH>')
    .replaceAll('`ask_user_question`', '宿主提问工具')
    .replaceAll('（`read` 那个文件）', '（用宿主图片查看工具打开那个文件）')
    .replaceAll('`cp -r`', '目录复制')
    .replaceAll('`cp`', '原样复制')
    .replaceAll('→ cp 落', '→ 原样复制落')
    .replaceAll('你 cp 搬入', '你原样复制搬入')
    .replaceAll('`grep`', '宿主文本搜索工具')
    .replaceAll('(offset/limit/grep)', '（分段读取/文本搜索）')
    .replaceAll('（offset/limit/grep）', '（分段读取/文本搜索）')
    .replaceAll('`./run_tests.sh`', '当前系统可运行的测试入口');
  // `python3` 与脚本路径之间允许 `-B` 这类标志：源技能要求跑引擎脚本一律加 `-B`
  // （否则 Python 往只读的引擎目录写 `__pycache__`），标志要原样带到本机调用里。
  body = body.replace(/python3 ((?:-[A-Za-z]+\s+)*)(<root>\/scripts\/[\w-]+\.py)([^`\n]*)/g,
    (_, flags, script, args) => {
      const argumentsText = script.endsWith('/gen_home.py') && !args.trim()
        ? ' <LEARN_WORKSPACE>' : args;
      return `<python> -X utf8 ${flags}'${script}'${argumentsText.replace(/<[^>]+>/g, value => `'${value}'`)}`;
    });

  // 归一：上面按 `<[^>]+>` 逐个补引号，遇到源文件里已经带引号的占位符会补成 `''<X>''`。
  // 这类重复引号只是写法问题，统一收敛回一层（`python3 -X utf8 -B '<脚本>' '<占位符>'`）。
  body = body.replaceAll("''<", "'<").replaceAll(">''", ">'");

  // DSH-only frontmatter flags are moved to agents/openai.yaml by the builder;
  // role instructions enforce the same ownership when UI policy is unavailable.
  const roleOnly = /^disable-model-invocation:\s*true\s*$/m.test(frontmatter[1]);
  const boundary = name === 'learning-system' ? '' : `${roleOnly ? ROLE_BOUNDARY : PROTOCOL_BOUNDARY}\n`;
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${HOST_GUIDE}\n${boundary}${body}\n`;
}
