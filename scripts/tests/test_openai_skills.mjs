import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { adaptOpenAiSkill } from '../../bin/openai-skill-compat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillRoot = path.join(root, '.dsh', 'skills');
const skills = fs.readdirSync(skillRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
const sources = new Map(skills.map(name => [name,
  fs.readFileSync(path.join(skillRoot, name, 'SKILL.md'), 'utf8')]));
const adapted = new Map(skills.map(name => [name, adaptOpenAiSkill(sources.get(name), name)]));

test('all bundled skills export only portable metadata and no DSH tool requirements', () => {
  assert.equal(skills.length, 12);
  for (const [name, content] of adapted) {
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(frontmatter, name);
    assert.deepEqual(frontmatter[1].split('\n').map(line => line.split(':')[0]),
      ['name', 'description'], name);
    assert.ok(frontmatter[1].startsWith(`name: ${name}\n`));
    assert.ok(JSON.parse(frontmatter[1].split('\n')[1].slice('description: '.length)));
    for (const stale of [
      /~\/\.dsh/, /\.dsh\/skills/, /install\.sh/, /\/tmp(?:\/|`)/,
      /`(?:skill|subagent|subagent_fork|present|ask_user_question|read)`/,
      /md5sum/, /xdg-open/, /`cp(?: -r)?`/, /`grep`/,
      /python3 <root>/, /disable-model-invocation/, /user-invocable/,
      /\x00/,
    ]) assert.doesNotMatch(content, stale, `${name}: ${stale}`);
    assert.match(content, /<root>\/skills\/<技能名>\/SKILL\.md/, name);
    assert.match(content, /没有委派工具时.*串行执行/, name);
    assert.match(content, /ChatGPT Work.*临时沙箱/, name);
    assert.match(content, /环境变量、工作目录与 shell 状态不保证跨工具调用保留/, name);
  }
});

test('bootstrap initializes a separate workspace without requiring legacy config', () => {
  const controller = adapted.get('learning-system');
  assert.match(controller, /用户本次明确指定的目录 → 非空环境变量 `STUDYMATE_WORKSPACE` → 非空 `LEARN_WORKSPACE` → 用户显式设置的 `STUDYMATE_CONFIG`/);
  assert.match(controller, /只有用户明确要求复用旧 DSH 工作区时才读取其指定的旧配置/);
  assert.match(controller, /没有 DSH 配置不影响启动/);
  assert.match(controller, /仅在缺失时从 `<root>\/templates\/MEMORY\.md` 复制为 `\.learning\/MEMORY\.md`/);
  assert.match(controller, /插件根目录只读/);
  assert.match(controller, /完整 `\.learning\/`（含隐藏目录）的可下载归档/);
  assert.doesNotMatch(adapted.get('record-keeping'), /开场从.*config\.yaml/);
});

test('无头侧的引擎命令都走探测到的解释器、路径带引号，gen_home 始终显式传工作区', () => {
  for (const [name, content] of adapted) {
    // 源技能正文已经不调引擎脚本（DSH 走原生工具）；脚本只活在导出时按
    // `NATIVE_TOOL_FALLBACK` 换进来的等价做法里，所以命令形状由这一层守：
    // 解释器要经探测（`<python>`）、路径与占位符一律带引号。
    // （每个工具都有落点这件事由 test_skill_contracts.mjs 逐条对账。）
    assert.doesNotMatch(content, /python3 -B/, `${name}: Codex 侧不许留裸 python3（要走探测到的解释器）`);
    for (const match of content.matchAll(/`(<python> -X utf8(?: -[A-Za-z]+)* '[^`]+)`/g)) {
      // `<python>` 是宿主约定的解释器占位，先摘掉再看剩下的占位符有没有裸着进命令。
      const command = match[1].replace('<python>', 'PY');
      assert.doesNotMatch(command, /(?<!')<[^>]+>/,
        `${name}: 降级落点里的占位符没加引号 —— ${match[1]}`);
    }
  }
  assert.match(adapted.get('learning-system'), /调用主页生成器始终传/,
    '主页生成器必须显式传工作区这条规矩要写在宿主约定里');
  // 合成正文反证：技能里真的出现裸的 gen_home 调用时，导出必须补上显式工作区
  // （源技能里已经一处都没有了，所以只能拿合成样本来证明这条改写还活着）。
  const sample = '---\nname: lesson-design\ndescription: 合成样本\n---\n\n刷新主页：python3 -B <root>/scripts/gen_home.py\n';
  assert.match(adaptOpenAiSkill(sample, 'lesson-design'),
    /<python> -X utf8 -B '<root>\/scripts\/gen_home\.py' '<LEARN_WORKSPACE>'/, 'gen_home 必须显式传工作区');
});

test('DSH 侧技能正文不再自己跑引擎脚本（脚本只留给无头降级表）', () => {
  // #80 的验收：总控与档案不再跑脚本、不看退出码。这三个技能是本张票的靶子；
  // 角色侧（#81）的脚本调用由那一张票清，这里不越界断言。
  for (const name of ['learning-system', 'record-keeping', 'local-qa']) {
    const body = sources.get(name);
    assert.doesNotMatch(body, /python3/, `${name}: DSH 侧正文不该再出现 python3`);
    assert.doesNotMatch(body, /<root>\/scripts\//, `${name}: DSH 侧正文不该再出现引擎脚本路径`);
    assert.doesNotMatch(body, /exit code|cp -a/, `${name}: DSH 侧正文不该再出现退出码与 cp -a`);
    assert.doesNotMatch(body, /md5|\.studymate-stage/, `${name}: 暂存模式与摘要比对已删`);
  }
});

test('teaching contracts and role ownership survive export', () => {
  for (const name of ['evidence-check', 'lesson-design', 'local-qa']) {
    const originalBody = sources.get(name).replaceAll('\r\n', '\n')
      .replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    assert.ok(adapted.get(name).endsWith(`${originalBody}\n`), `${name} teaching text changed`);
  }
  for (const [name, terms] of [
    ['learning-coach', ['你只写内容、留题目位置', '尤其别补 `empty_reason`', '**内容文件里只有内容格式。**']],
    ['practice-evaluator', ['全系统的题都由你出', '作答原文', '题目的唯一 owner']],
    ['learning-system', ['锚点是讲解的产物', '题面与答案一个字都不改', '同一科目同时只有一个写入者']],
    // 这条断言原先钉的是术语「已通过项目验证」——那是旧六档里的词，#71 把词表收成三档之后
    // 它必然与 schema 分叉。改成钉同一节的稳定标记（项目与实验课的置位规则），词表本身
    // 由下面那条「跟 schema 走」的守卫负责：它检查 skills 里出现的状态词**只在 schema 的词表内**。
    ['record-keeping', ['建课时的初始快照', '项目与实验课', '写一条当且仅当出现可观察的证据']],
    ['layered-practice', ['参考解必须自包含', '只有 `::: quiz` 的层级是元信息', '每条结论必须指向一条具体证据']],
  ]) {
    for (const term of terms) assert.ok(adapted.get(name).includes(term), `${name}: ${term}`);
  }
  // 状态词表跟 schema 走（别在这里手抄第二份）：三档词表落地后，「初步理解 / 能独立应用 /
  // 需要复习 / 已通过项目验证」这四个旧档位不该再出现在技能正文里——技能清洗归 #80/#81，
  // 但 schema 这边一旦把旧档位写回词表，这条会先红，不至于静默漂回去。
  const progressSchema = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'progress.schema.json'), 'utf8'));
  const statuses = progressSchema.properties.nodes.additionalProperties.properties.status.enum;
  assert.deepEqual(statuses, ['未开始', '学习中', '已学完'], '进度词表就是三档（规格 §5.2）');
  for (const stale of ['初步理解', '能独立应用', '需要复习', '已通过项目验证']) {
    assert.equal(statuses.includes(stale), false, `${stale} 是旧六档的词，不该在写侧词表里`);
  }
  assert.equal(Object.hasOwn(progressSchema.properties.nodes.additionalProperties.properties, 'mastery'), false,
    'mastery 已从 schema 移除（规格 §5.2）');
  // Export must never mutate the DSH source files or depend on their line endings.
  for (const [name, source] of sources) {
    assert.equal(fs.readFileSync(path.join(skillRoot, name, 'SKILL.md'), 'utf8'), source);
    assert.equal(adaptOpenAiSkill(source.replaceAll('\r\n', '\n'), name), adapted.get(name));
  }
});

test('invalid metadata and changed bootstrap fail instead of shipping stale instructions', () => {
  assert.throws(() => adaptOpenAiSkill('body', 'learning-system'), /frontmatter/);
  assert.throws(() => adaptOpenAiSkill(sources.get('local-qa'), '../local-qa'), /directory name/);
  assert.throws(() => adaptOpenAiSkill(sources.get('local-qa'), 'another-name'), /metadata/);
  assert.throws(() => adaptOpenAiSkill(sources.get('learning-system')
    .replace('0. **定位工作区与引擎**', '0. **新的启动结构**'), 'learning-system'), /adaptation needs updating/);
});
