/* 共享记忆改名：`.learning/MEMORY.md` → `.learning/MEMORY.yaml`（#189）
   ────────────────────────────────────────────────────────────────────────
   改名破的是 [ADR-0004](../../docs/adr/0004-学习数据格式冻结与例外.md) 那句「布局、文件名
   与目录结构不动」的字面承诺，边界与被否备选记在 [ADR-0014](../../docs/adr/0014-共享记忆改名MEMORY.yaml.md)。
   这张票交付的不是新功能，而是「改名不炸任何一处」被证明。这份套件钉住其中**静态**的两条：

     1. **模板骨架**：`templates/MEMORY.yaml` 是带注释的**空**骨架，节与改名前一致；
        旧模板名不许还在盘上。
     2. **已跟踪文件里没有一处手写的旧名**：`MEMORY.md` 不再出现在本仓的活文件里。
        旧名从此就是一份普通文件——「认新名、不认旧名」的行为判据在各消费点自己的套件里：
        `test_watch_notice`（认域）、`test_host_ask_session`（答疑注入）、
        `test_tools_context`（摘要工具）、`test_host_library_payload`（图片库载荷）。
     3. **2.0.4 审计后的迁移期例外**（2026-11-15）：读侧补了旧格式兜底、并加了
        `studymate migrate` 一次性迁移。所以旧名重新出现在**有限的几处**：兜底/迁移的源码、
        迁移命令的帮助、升级文档、以及反证输入。豁免名单逐条写理由；判据没有放松——
        除了名单上的文件，活文件里出现旧名照样红。
     4. **迁移本身**：旧格式（`##` 分节 + bullet）→ 新 YAML 的纯函数转换、读侧兜底、一次性
        迁移的四条承诺（不覆盖/幂等/不丢内容/可回滚）都在本套件里用现造工作区钉住。

   判据扫的是**已跟踪文件**（`git ls-files`），不是「工作区里所有文件」。这一条是踩过坑的：
   开发机上总躺着未跟踪或被 ignore 的东西——本地 scratch（`.superpowers/`）、维护者真实的
   学习工作区（`workspace/`）、一次性分析产物（`分析/`）——它们不是本仓的内容。对它们敏感
   意味着这条门禁在本地永远红，而 CI 是干净检出、看不见这些残留：同一个判据两边给出不同
   结论，等于把「本地 `npm test` 跑通」这条唯一的门禁废掉（CONTRIBUTING 硬规矩 3），
   还正好撞上「测试不读写学生的 `workspace/`」那条规矩。
   也不用一份手写的目录黑名单：那会随仓库长大而腐烂，还容易把真 offender 一起放过；
   `git ls-files` 是仓库自己算出来的，本地与 CI 看到的是同一个集合。

   为什么豁免名单只有那几张：判据扫的是**手写的**文本，所以豁免只给「性质上不受这条约束」
   的文件——生成产物（CHANGELOG 由发布流程生成，CONTRIBUTING 明写不要手改）、决策记录
   （ADR 必须同时写出旧名与新名，才记得下这次改名）、以及自述为历史/当轮快照的文档。
   豁免不是「跑不过就加一行」：每一条都写得出理由，加之前先问它是不是活文件。

   这条判据的价值就是它的**否定式**：规则可达性套件（`test_skill_rules.mjs`）只断「必须出现」，
   钉不住「不许再出现」，于是改名这类横扫最容易留下半处旧名——某份夹具、某条注释、某个
   模板说明表里的旧路径——而且处处都还是绿的。判据自己不空转由下面两条**合成数据自证**钉住：
   喂一个带旧名的**已跟踪**样本进去必须报出来，未跟踪与被 ignore 的必须不报
   （同一条纪律的先例：`scripts/release/checks.mjs` 的自检、`test_architecture_boundaries.mjs`
   的合成图反证）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseYaml } from '../../lib/yaml.ts';
import {
  LEGACY_MEMORY_FILE, MEMORY_FILE, PROFILE_SECTIONS,
  migrateLegacyMemory, readMemory, readMemoryFile,
} from '../../lib/core/memory.ts';
import { legacyUnreadableNotice, readSharedMemory } from '../../lib/memory-file.ts';
import { migrateMemoryWorkspace } from '../../lib/memory-migrate.ts';
import { removeFile } from './fixtures/fs-rm.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const OLD_NAME = 'MEMORY.md';
const NEW_NAME = 'MEMORY.yaml';

/* ── 一、模板骨架：新名在、旧名不在，节与今天一致 ─────────────────────────── */

/** 改名前 `templates/MEMORY.md` 的前三节与每节的条目（逐字取自那份文件）。
    期望值写死在这里，不从模板自己算——从模板算出来的期望值只能证明它等于它自己。
    **#190 换掉了第四节**：原来那个只装本机事实的「跨科目观察」撤掉了，换成「积累」
    （一条 = 中文键 + 一句话，所以空骨架是空映射而不是空列表）；节名与投影白名单由
    `test_core_memory.mjs` 从记忆模块那一侧钉住，这里只跟着改期望值。 */
const SKELETON = {
  我是谁: ['现有技能', '各领域当前水平'],
  教学偏好: ['有效的讲法', '容易烦躁的', '例子偏好'],
  学习习惯: ['可投入时间', '节奏', '常见卡点'],
  积累: [],
};

test('#189 模板：templates/MEMORY.yaml 在盘上，旧模板名不在', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'templates', NEW_NAME)), true,
    `templates/${NEW_NAME} 不在盘上——首次初始化工作区就没有骨架可套`);
  assert.equal(fs.existsSync(path.join(ROOT, 'templates', OLD_NAME)), false,
    `templates/${OLD_NAME} 还留在盘上：改名之后它不该再有第二份（读侧不兜旧名，留着只会误导）`);
});

test('#189/#190 模板：带注释的空骨架，画像三节的条目与改名前一致，`积累` 是空映射', () => {
  const text = fs.readFileSync(path.join(ROOT, 'templates', NEW_NAME), 'utf8');
  assert.match(text, /^#/m, '骨架要带注释：节是什么、往里写什么，注释是它唯一的说明书');
  assert.doesNotMatch(text, new RegExp(OLD_NAME.replace('.', '\\.')), '骨架里不许再写旧名');

  const parsed = parseYaml(text, { file: `templates/${NEW_NAME}` });
  assert.equal(typeof parsed, 'object', '骨架要解析得开（它是 YAML，不是随手写的文本）');
  assert.deepEqual(Object.keys(parsed), Object.keys(SKELETON), '四节的节名与顺序：前三节与改名前一致，第四节是 #190 的「积累」');

  for (const [section, entries] of Object.entries(SKELETON)) {
    const value = parsed[section];
    if (entries.length === 0) {
      // #190：「积累」是「一条 = 中文键 + 一句话」的映射，空骨架就是空映射（不是空列表）
      assert.deepEqual(value, {}, `「${section}」要是一个空映射（骨架是空的）`);
      continue;
    }
    assert.deepEqual(Object.keys(value), entries, `「${section}」下的条目标题与改名前一致`);
    for (const entry of entries) {
      assert.deepEqual(value[entry], [], `「${section} → ${entry}」要是空的：模板只给形状，不留占位内容`);
    }
  }
});

/* ── 二、已跟踪文件里没有一处手写的旧名 ───────────────────────────────────── */

/** 豁免文件：生成产物、自述历史、迁移兼容代码，以及几条**故意**把旧名当输入的反证。
    活文件一律不豁免，豁免的每一条都写得出「为什么它必须写出旧名」。 */
const EXEMPT_FILES = new Map([
  ['CHANGELOG.md', '发布流程生成的历史记录（CONTRIBUTING 明写不要手改）'],
  ['docs/设计/设计方案.md', '自述「历史文档、不要据此实现」；test_docs_references.mjs 的 HISTORICAL 名单里'],
  ['docs/设计/learning-discovery-validation.md', '自述「当时那次」验收记录的快照，口径按当时的仓库状态写'],
  // 2026-11-15（2.0.4 审计后的迁移期）：读侧兜底与一次性迁移必须写出旧名——只在这几处。
  ['lib/core/memory.ts', '旧格式 → 新格式的纯函数转换与兼容判读；旧名是它要认的输入'],
  ['lib/memory-file.ts', '读侧兜底：先找新名、没有再找旧名，提示语也写旧名'],
  ['lib/memory-migrate.ts', '一次性迁移：旧名是迁移对象，回滚说明里要写出原路径'],
  ['bin/studymate.mjs', 'migrate 子命令的帮助与用法：告诉学生迁的是哪个文件'],
  ['docs/使用/使用说明.md', '升级须知：要同时写出旧名与新名，学生才知道迁哪个文件'],
  ['docs/使用/安装.md', '「更新」一节给迁移命令的指针（升级时会读到）'],
  // 下面几条要把旧名**喂进去**才钉得住「旧格式兜底读得到、积累不进注入、载荷可读」——
  // 它们提旧名是故意的，而且只出现在反证输入那几行。这不是漏洞：除了这些，别的活文件一个字都不许有。
  ['scripts/tests/test_memory_rename.mjs', '这条判据本身要把旧名当搜索针'],
  ['scripts/tests/test_watch_notice.mjs', '反证输入：旧名要落回普通文件（`workspace` 域）'],
  ['scripts/tests/test_host_ask_session.mjs', '反证输入：只有旧名那份文件时走旧格式兜底、只注入画像三节'],
  ['scripts/tests/test_host_library_payload.mjs', '反证输入：只有旧名那份文件时载荷里的投影照旧'],
  ['scripts/tests/test_tools_context.mjs', '反证输入：只有旧名那份文件时摘要里给出「请迁移」提示'],
]);

/** 豁免目录：决策记录。得同时写出旧名与新名，才记得下「从哪个名字改成哪个名字」。 */
const EXEMPT_DIRS = new Map([
  ['docs/adr', '决策记录必须能同时写出旧名与新名'],
]);

function isExempt(relative) {
  if (EXEMPT_FILES.has(relative)) return true;
  for (const dir of EXEMPT_DIRS.keys()) {
    if (relative === dir || relative.startsWith(`${dir}/`)) return true;
  }
  return false;
}

/** 二进制按扩展名跳过：图是导出的产物（改它的源，不改它），源码与文档都是文本。 */
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.zip', '.pdf']);

/** `git` 在这个目录里起得来吗。起不来（没装 git）时判据明确跳过，不静默算通过。 */
function gitRun(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
}

function gitAvailable() {
  const probe = gitRun(ROOT, ['--version']);
  return !probe.error && probe.status === 0;
}

function isGitRepo(root) {
  const probe = gitRun(root, ['rev-parse', '--git-dir']);
  return !probe.error && probe.status === 0;
}

/** 仓库里**已跟踪**的文件（相对仓库根）。未跟踪与被 ignore 的一律不在里面——
    这就是「本机的 scratch 与学习工作区不影响这条门禁」的判据本体。 */
function trackedFiles(root) {
  const listed = gitRun(root, ['ls-files', '-z']);
  if (listed.error || listed.status !== 0) {
    throw new Error(`读不到已跟踪文件清单（\`git ls-files\`）：${listed.error?.message ?? String(listed.stderr).trim()}`);
  }
  // `-z` 不只是分隔符：默认设置下 git 会把非 ASCII 路径转义成 `"\346…"`，那不是盘上的路径
  return String(listed.stdout).split('\0').filter((entry) => entry !== '');
}

/** 这些文件里的旧名：`{ file, line, text }` 列表。同一段代码既扫真仓库、也扫合成样本。 */
function oldNameOffenders(files, root) {
  const offenders = [];
  for (const relative of files) {
    if (isExempt(relative)) continue;
    if (BINARY_EXT.has(path.extname(relative).toLowerCase())) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, relative), 'utf8');
    } catch {
      continue; // 已跟踪但读不到（删了没提交）：那不是一个手写的旧名
    }
    if (text.includes('\0')) continue;
    for (const [index, line] of text.split('\n').entries()) {
      if (line.includes(OLD_NAME)) offenders.push({ file: relative, line: index + 1, text: line.trim() });
    }
  }
  return offenders;
}

/** 合成样本：三份文件里都写着旧名，只有一份进了索引。
    判据的输入是索引，所以那一份必须报出来、另外两份必须不报——两条自证共用它。 */
function syntheticRepo(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-rename-probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
  fs.writeFileSync(path.join(root, 'clean.md'), '这一份是干净的，一个字都不提那个名字\n');
  fs.mkdirSync(path.join(root, 'tracked'), { recursive: true });
  fs.mkdirSync(path.join(root, 'untracked'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tracked', '旧名.md'), `第一行\n这里写着 ${OLD_NAME}\n`);
  fs.writeFileSync(path.join(root, 'untracked', '也好旧.md'), `${OLD_NAME}\n`);
  fs.writeFileSync(path.join(root, 'ignored', 'scratch.md'), `${OLD_NAME}\n`);

  assert.equal(gitRun(root, ['init', '-q']).status, 0, '合成样本要一个真 git 仓库：判据的输入就是索引');
  // 只把该跟踪的加进索引：`untracked/` 留在索引外，`ignored/` 被 .gitignore 挡住
  assert.equal(gitRun(root, ['add', '--', 'tracked', 'clean.md', '.gitignore']).status, 0, '加不进索引就证不了这条');
  return root;
}

const SAMPLES = ['tracked/旧名.md', 'untracked/也好旧.md', 'ignored/scratch.md'];

test('#189 判据不空转：已跟踪文件里的旧名必须被列成 offender', (t) => {
  if (!gitAvailable()) { t.skip('这台机器上没有 git'); return; }
  const root = syntheticRepo(t);
  const files = trackedFiles(root);
  assert.ok(files.includes('tracked/旧名.md'), `已跟踪清单里没有那份样本：${JSON.stringify(files)}`);

  const offenders = oldNameOffenders(files, root);
  assert.deepEqual(offenders.map((one) => one.file), ['tracked/旧名.md'],
    '合成样本里那份已跟踪的旧名没被列出来——这条判据空转了');
  assert.equal(offenders[0].line, 2, '行号要指到写着旧名的那一行');
  assert.match(offenders[0].text, /这里写着/, '报出来的该是那一行的原文');
});

test('#189 判据只认已跟踪文件：未跟踪与被 ignore 的路径一条都不进 offender', (t) => {
  if (!gitAvailable()) { t.skip('这台机器上没有 git'); return; }
  const root = syntheticRepo(t);
  // 盘上确实有三份写着旧名：不这么钉一下，「一个都没报」也能被读成判据是对的
  for (const relative of SAMPLES) {
    assert.match(fs.readFileSync(path.join(root, relative), 'utf8'), /MEMORY\.md/, `${relative} 该是被造出来的`);
  }

  const files = trackedFiles(root);
  assert.deepEqual(files.filter((one) => one.startsWith('untracked/') || one.startsWith('ignored/')), [],
    '未跟踪与被 ignore 的路径不该进清单：本机 scratch 与维护者的 `workspace/` 会让门禁在本地永远红');
  assert.deepEqual(oldNameOffenders(files, root).map((one) => one.file), ['tracked/旧名.md'],
    '只有已跟踪的那一份算违规');
});

test('#189 已跟踪文件里没有一处手写的旧名（生成产物、决策记录、自述历史与反证输入除外）', (t) => {
  if (!isGitRepo(ROOT)) { t.skip('不是 git 仓库（npm 安装副本），跳过'); return; }
  const files = trackedFiles(ROOT);
  assert.ok(files.length > 100, `已跟踪文件清单只有 ${files.length} 份，不像这个仓库——判据会空转`);

  const offenders = oldNameOffenders(files, ROOT);
  assert.deepEqual(offenders.map((one) => `${one.file}:${one.line}: ${one.text}`), [],
    `这些地方还写着旧名 ${OLD_NAME}——改名波及的每一处都要跟着走：\n`
    + offenders.map((one) => `${one.file}:${one.line}: ${one.text}`).join('\n'));
});

/* ── 三、2.0.4 审计后的迁移期：旧格式读得到、迁得走、不丢东西 ──────────────── */

/** 一份覆盖各种形态的旧格式共享记忆：三种画像节、`跨科目观察`（#190 前那节）、一个规范外的
    旧节、一个标题带 ASCII 冒号的旧节、重复键、无键条目、tab 与空格混用的缩进、嵌套 bullet。 */
const LEGACY_MEMORY = [
  '# 学习者记忆',
  '',
  '> 旧格式：`##` 分节 + bullet。',
  '',
  '## 我是谁',
  '',
  '- 现有技能：终端基础',
  '- 各领域当前水平：',
  '\t- 命令行：没学过（2026-10-17 自评）',
  '  - 编程：能写 Python（2026-10-17 确认）',
  '',
  '## 教学偏好',
  '',
  '- 有效的讲法："**先动手**再补理论"',
  '- 容易烦躁的：被迫补全别人写好的骨架',
  '',
  '## 学习习惯',
  '',
  '- 可投入时间：每周 4-8 小时',
  '- 可投入时间：每周 8-16 小时',
  '',
  '## 跨科目观察',
  '',
  '- 2026-10-17：目标是本科就业',
  '- 2026-10-17：目标岗位是 Agent 开发',
  '',
  '## 载体口径',
  '',
  '- 实操课：lab 只给五份文档',
  '- 顺序永远是先写通再上规范',
  '',
  '## 旧: 带冒号',
  '',
  '- 一条：内容',
  '',
  '## 积累',
  '',
  '- fish 脾气：这台机器上 fish 不吃双横线。',
  '',
].join('\n');

/** 画像三节里**不该**出现在注入里的词：`积累` 与规范外旧节的内容，每个都在画像节里不出现。 */
const NOT_INJECTABLE = ['目标岗位是 Agent 开发', '目标是本科就业', 'fish 脾气', '不吃双横线',
  'lab 只给五份文档', '顺序永远是先写通再上规范'];

function tempWorkspace(t, files = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const learning = path.join(root, '.learning');
  fs.mkdirSync(learning, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(learning, name), content);
  }
  return root;
}

function warnSpy(t) {
  const calls = [];
  const original = console.warn;
  console.warn = (...args) => { calls.push(args.join(' ')); };
  t.after(() => { console.warn = original; });
  return calls;
}

test('2.0.4 迁移期：旧格式机械转成新 YAML——节名齐全、行序保留、能当事件解析', () => {
  const conversion = migrateLegacyMemory('shared', LEGACY_MEMORY);
  assert.equal(conversion.migratable, true);
  assert.deepEqual(conversion.sections, [...PROFILE_SECTIONS, '积累', '载体口径', '旧：带冒号'],
    '规范节在前、原样保留的旧节在后');
  assert.match(conversion.yaml, /^我是谁:$/m);
  assert.equal(typeof parseYaml(conversion.yaml), 'object', '迁移产物要是合法 YAML（不是随手拼的文本）');

  const view = readMemoryFile('shared', conversion.yaml);
  assert.deepEqual(view.missing, [], '四节都在');
  assert.deepEqual(view.unknown, ['载体口径', '旧：带冒号'], '规范外的旧节原样保留（不进注入）');
  // 行序：`我是谁` 下两条按文件顺序，嵌套 bullet 成为键下的内容行
  const who = view.sections.find((section) => section.heading === '我是谁');
  assert.deepEqual(who.entries.map((entry) => entry.key), ['现有技能', '各领域当前水平']);
  assert.match(who.entries[1].content, /命令行/);
  assert.match(who.entries[1].content, /编程/, '混合缩进（tab/空格）下的子 bullet 也要收进这一条');
});

test('2.0.4 迁移期：画像三节可注入，`积累`/规范外旧节一个字都不进注入', () => {
  const conversion = migrateLegacyMemory('shared', LEGACY_MEMORY);
  const injectable = readMemory({ shared: conversion.yaml }).injectable;
  for (const heading of PROFILE_SECTIONS.filter((name) => name !== '教学偏好')) {
    assert.ok(injectable.includes(heading), `注入里缺了画像节「${heading}」`);
  }
  assert.match(injectable, /现有技能/);
  assert.match(injectable, /有效的讲法/);
  assert.match(injectable, /可投入时间/);
  for (const fragment of NOT_INJECTABLE) {
    assert.equal(injectable.includes(fragment), false, `注入里出现了不该进上下文的「${fragment}」`);
  }
  // `积累` 的条目在，且跨科目观察并了进来：2026-10-17 两条 + fish 一条
  const report = readMemory({ shared: conversion.yaml });
  assert.equal(report.accumulations.length, 3);
  assert.deepEqual(report.accumulations.map((entry) => entry.key),
    ['2026-10-17', '2026-10-17（2）', 'fish 脾气']);
  assert.equal(readMemoryFile('shared', conversion.yaml).empty, false);
});

test('2.0.4 迁移期：转不了的地方不静默丢——并节/重名键/无键条目/规范外旧节都给 warning', () => {
  const conversion = migrateLegacyMemory('shared', LEGACY_MEMORY);
  const warnings = conversion.warnings.join('\n');
  assert.match(warnings, /「跨科目观察」已并入「积累」/);
  assert.match(warnings, /重名键/);
  assert.match(warnings, /没有键的条目/);
  assert.match(warnings, /「载体口径」不在四节规范内/);
  assert.match(warnings, /ASCII 冒号/);
  // 内容确实都在产物里（warning 不是「说了一句就把内容扔了」）
  for (const fragment of ['lab 只给五份文档', '顺序永远是先写通再上规范', '带冒号']) {
    assert.ok(conversion.yaml.includes(fragment), `迁移产物里丢了「${fragment}」`);
  }
});

test('2.0.4 迁移期：空文件迁成空骨架；没有分节的非空文件拒绝迁移（不静默丢正文）', () => {
  const blank = migrateLegacyMemory('shared', '');
  assert.equal(blank.migratable, true);
  assert.equal(readMemoryFile('shared', blank.yaml).empty, true);
  assert.match(blank.yaml, /我是谁: \{\}/);

  const prose = migrateLegacyMemory('shared', '只有一段散文，没有 `##` 分节，也没有任何键。\n');
  assert.equal(prose.migratable, false);
  assert.equal(prose.yaml, '');
  assert.match(prose.warnings.join('\n'), /没有可识别的 `## 分节`/);
});

test('2.0.4 迁移期：科目记忆的旧格式转换只留「积累」（兼容判读不制造第二个格式）', () => {
  const conversion = migrateLegacyMemory('subject', LEGACY_MEMORY);
  assert.deepEqual(conversion.sections,
    ['积累', '我是谁', '教学偏好', '学习习惯', '跨科目观察', '载体口径', '旧：带冒号'],
    '科目记忆没有画像三节；旧的跨科目观察在科目侧不属于共享语义，原样保留');
  assert.ok(readMemoryFile('subject', conversion.yaml).injectable === '', '科目记忆永不进注入');
});

/* ── 四、读侧兜底：只有旧名时读得到、提示只一次、新旧并存时新文件优先 ─────── */

test('2.0.4 迁移期：只有旧 md 时兜底读，投影与迁移后的新文件逐字一致', (t) => {
  const workspace = tempWorkspace(t, { [LEGACY_MEMORY_FILE]: LEGACY_MEMORY });
  const read = readSharedMemory(workspace, { warn: false });
  assert.equal(read.legacy, true);
  assert.equal(read.present, true);
  assert.match(read.file, /[\\/]\.learning[\\/]MEMORY\.md$/);
  assert.equal(read.text, migrateLegacyMemory('shared', LEGACY_MEMORY).yaml);
  for (const fragment of NOT_INJECTABLE) {
    assert.equal(read.view.injectable.includes(fragment), false,
      `兜底读到的画像里出现了「${fragment}」`);
  }
  assert.equal(read.view.accumulations.length, 3);
});

test('2.0.4 迁移期：旧文件没有 `##` 分节时读不出来，提示语不许再说「内容不丢」', (t) => {
  const prose = '只有一段散文，没有 `##` 分节。\n';
  const workspace = tempWorkspace(t, { [LEGACY_MEMORY_FILE]: prose });
  const read = readSharedMemory(workspace, { warn: false });
  assert.equal(read.legacy, true, '旧文件在，仍算旧格式兜底');
  assert.equal(read.present, true, '文件在盘上，present 照实为 true');
  assert.equal(read.unreadable, true, '没有分节 = 读不出来（不是「内容为空」）');
  assert.equal(read.text, null, '转换不出任何一节，text 是 null');
  assert.equal(read.view.injectable, '', '注入是空串——所以「内容不丢」是骗人的');
  const notice = legacyUnreadableNotice(read.file);
  assert.match(notice, /读不出来/);
  assert.match(notice, /migrate --dry-run/, '要给出下一步，别只说坏了');
  assert.equal(notice.includes('内容不丢'), false, '这句话在这种盘面上是错的');
});

test('2.0.4 迁移期：旧格式提示每个进程只打一次（不刷屏）', (t) => {
  const workspace = tempWorkspace(t, { [LEGACY_MEMORY_FILE]: LEGACY_MEMORY });
  const calls = warnSpy(t);
  readSharedMemory(workspace);
  readSharedMemory(workspace);
  readSharedMemory(workspace);
  assert.equal(calls.length, 1, `提示打了 ${calls.length} 次：${JSON.stringify(calls)}`);
  assert.match(calls[0], /旧格式/);
  assert.match(calls[0], /migrate/, '提示里要给出迁移命令，学生才知道下一步做什么');
});

test('2.0.4 迁移期：新旧并存时新文件优先，旧文件一个字节都不动', (t) => {
  const current = ['我是谁:', '  现有技能: [新文件]', ''].join('\n');
  const workspace = tempWorkspace(t, {
    [MEMORY_FILE]: current,
    [LEGACY_MEMORY_FILE]: LEGACY_MEMORY,
  });
  const read = readSharedMemory(workspace, { warn: false });
  assert.equal(read.legacy, false);
  assert.equal(read.text, current);
  assert.match(read.file, /[\\/]\.learning[\\/]MEMORY\.yaml$/);
  assert.equal(fs.readFileSync(path.join(workspace, '.learning', LEGACY_MEMORY_FILE), 'utf8'), LEGACY_MEMORY);
});

test('2.0.4 迁移期：两份都没有时是「没有记忆」而不是报错', (t) => {
  const workspace = tempWorkspace(t);
  const read = readSharedMemory(workspace, { warn: false });
  assert.equal(read.present, false);
  assert.equal(read.legacy, false);
  assert.equal(read.text, null);
  assert.equal(read.view.injectable, '');
});

/* ── 五、一次性迁移：四条承诺（不覆盖/幂等/不丢内容/可回滚） ───────────────── */

test('2.0.4 迁移期 migrate：旧 md 迁成新文件 + 改名备份，重跑幂等，可回滚', (t) => {
  const workspace = tempWorkspace(t, { [LEGACY_MEMORY_FILE]: LEGACY_MEMORY });
  const result = migrateMemoryWorkspace({ workspace });
  assert.equal(result.status, 'migrated');
  const newFile = path.join(workspace, '.learning', MEMORY_FILE);
  const oldFile = path.join(workspace, '.learning', LEGACY_MEMORY_FILE);
  assert.equal(fs.existsSync(newFile), true, '新文件要落盘');
  assert.equal(fs.existsSync(oldFile), false, '旧文件要改名备份，不留第二个「共享记忆」名字');
  assert.ok(result.backup && fs.existsSync(result.backup));
  assert.equal(fs.readFileSync(result.backup, 'utf8'), LEGACY_MEMORY, '备份是原文件的逐字节副本');
  assert.match(result.warnings.join('\n'), /跨科目观察/);
  assert.equal(result.accumulations, 3, '迁移不丢「积累」条目');

  // 迁移后的文件读法与兜底读法给出同一份投影
  const conversion = migrateLegacyMemory('shared', LEGACY_MEMORY);
  const after = readSharedMemory(workspace, { warn: false });
  assert.equal(after.legacy, false);
  assert.equal(after.view.injectable, readMemory({ shared: conversion.yaml }).injectable);

  // 幂等：再跑一次只报 already-new，一个字节都不重写
  const before = fs.readFileSync(newFile, 'utf8');
  const again = migrateMemoryWorkspace({ workspace });
  assert.equal(again.status, 'already-new');
  assert.equal(fs.readFileSync(newFile, 'utf8'), before);

  // 回滚：删新文件、备份改回旧名 → 读侧又回到旧格式兜底（内容仍在）
  removeFile(newFile);
  fs.renameSync(result.backup, oldFile);
  const rolledBack = readSharedMemory(workspace, { warn: false });
  assert.equal(rolledBack.legacy, true);
  assert.equal(rolledBack.view.accumulations.length, 3);
});

test('2.0.4 迁移期 migrate：新文件已存在时不覆盖、不备份、旧文件不动', (t) => {
  const current = ['我是谁:', '  现有技能: [新文件]', ''].join('\n');
  const workspace = tempWorkspace(t, { [MEMORY_FILE]: current, [LEGACY_MEMORY_FILE]: LEGACY_MEMORY });
  const result = migrateMemoryWorkspace({ workspace });
  assert.equal(result.status, 'already-new');
  assert.equal(fs.readFileSync(path.join(workspace, '.learning', MEMORY_FILE), 'utf8'), current);
  assert.equal(fs.readFileSync(path.join(workspace, '.learning', LEGACY_MEMORY_FILE), 'utf8'), LEGACY_MEMORY);
  assert.equal(fs.existsSync(`${path.join(workspace, '.learning', LEGACY_MEMORY_FILE)}.bak`), false);
  assert.match(result.warnings.join('\n'), /新旧两份记忆同时存在/);
});

test('2.0.4 迁移期 migrate：--dry-run 只看不写；空旧文件按空骨架迁移', (t) => {
  const workspace = tempWorkspace(t, { [LEGACY_MEMORY_FILE]: LEGACY_MEMORY });
  const dry = migrateMemoryWorkspace({ workspace, dryRun: true });
  assert.equal(dry.status, 'dry-run');
  assert.ok(dry.yaml.includes('我是谁:'));
  assert.equal(fs.existsSync(path.join(workspace, '.learning', MEMORY_FILE)), false, 'dry-run 不落盘');
  assert.equal(fs.existsSync(path.join(workspace, '.learning', LEGACY_MEMORY_FILE)), true, 'dry-run 不动旧文件');

  const empty = tempWorkspace(t, { [LEGACY_MEMORY_FILE]: '' });
  const migrated = migrateMemoryWorkspace({ workspace: empty });
  assert.equal(migrated.status, 'migrated');
  const text = fs.readFileSync(path.join(empty, '.learning', MEMORY_FILE), 'utf8');
  assert.equal(readMemoryFile('shared', text).empty, true);
});

test('2.0.4 迁移期 migrate：没有旧文件是 no-legacy；没有分节正文拒绝迁移；非工作区报错', (t) => {
  const bare = tempWorkspace(t);
  assert.equal(migrateMemoryWorkspace({ workspace: bare }).status, 'no-legacy');

  const prose = tempWorkspace(t, { [LEGACY_MEMORY_FILE]: '只有一段散文，没有分节。\n' });
  const refused = migrateMemoryWorkspace({ workspace: prose });
  assert.equal(refused.status, 'refused');
  assert.equal(fs.readFileSync(path.join(prose, '.learning', LEGACY_MEMORY_FILE), 'utf8'),
    '只有一段散文，没有分节。\n', '拒绝迁移时旧文件保持原样');
  assert.equal(fs.existsSync(path.join(prose, '.learning', MEMORY_FILE)), false);

  const notWorkspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-not-ws-'));
  t.after(() => fs.rmSync(notWorkspace, { recursive: true, force: true }));
  assert.throws(() => migrateMemoryWorkspace({ workspace: notWorkspace }), /找不到学习工作区/);
});

test('2.0.4 迁移期 CLI：`studymate migrate` 跑得通、第二次报无需迁移、--dry-run 不落盘', (t) => {
  const workspace = tempWorkspace(t, { [LEGACY_MEMORY_FILE]: LEGACY_MEMORY });
  const dshHome = path.join(workspace, 'dsh-home');
  const env = { ...process.env, DSH_HOME: dshHome };
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'studymate.mjs'), ...args], {
    encoding: 'utf8', windowsHide: true, env,
  });

  const first = run(['migrate', '--workspace', workspace]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /共享记忆已迁移/);
  assert.equal(fs.existsSync(path.join(workspace, '.learning', MEMORY_FILE)), true);

  const second = run(['migrate', '--workspace', workspace]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /无需迁移/);

  const fresh = tempWorkspace(t, { [LEGACY_MEMORY_FILE]: LEGACY_MEMORY });
  const dry = run(['migrate', '--workspace', fresh, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry-run/);
  assert.equal(fs.existsSync(path.join(fresh, '.learning', MEMORY_FILE)), false);

  const usage = run(['migrate', '--nope']);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /用法：studymate migrate/);

  // `--help` 是正常用法：印用法、退 0，别当成「不支持的参数」
  const help = run(['migrate', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /用法：studymate migrate/);
});
